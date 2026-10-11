/**
 * S655 SECURITY — Books scopes a landlord to its OWN company, with the pass
 * auth.ts actually mints.
 *
 * Since S633 a landlord owner signs in with profileId = null and
 * landlordId = null; its companies ride in landlordIds. Books' landlordScope()
 * read `user.landlordId || user.profileId`, got null for every landlord owner,
 * and null is the admin "every landlord" value of each
 * `(landlord_id = $1 OR $1 IS NULL)` query: the rent roll, the owner
 * statements (names and emails), the P&L's GAM income and the ledger handed
 * one landlord every other landlord's books. The older Books suites signed
 * landlord passes with profileId set (the pre-S633 shape), which hid it.
 *
 * Every pass in this file is shaped exactly as auth.ts makes it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { booksRouter, BOOKS_CHOOSE_COMPANY } from './books'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_scope'
})

/** A landlord owner's pass exactly as auth.ts sessionClaimsFor() mints it since S633. */
const landlordPass = (userId: string, landlordIds: string[]) =>
  jwt.sign({ userId, role: 'landlord', email: `l-${userId.slice(0, 6)}@t.dev`,
             profileId: null, landlordId: null, landlordIds, businessId: null,
             staffRole: null, permissions: null }, process.env.JWT_SECRET!, { expiresIn: '1h' })

const get = (pass: string, path: string, clientId?: string) => {
  const r = request(buildApp()).get(path).set('Authorization', `Bearer ${pass}`)
  return clientId ? r.set('X-Client-Id', clientId) : r
}

interface Two {
  a: { userId: string; landlordId: string; unitId: string; email: string }
  b: { userId: string; landlordId: string; unitId: string; email: string }
}

/** Two landlords, one property and one occupied unit each; B has a settled rent payment this month. */
async function seedTwo(): Promise<Two> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const aEmail = `owner-a-${randomUUID()}@test.dev`
    const bEmail = `owner-b-${randomUUID()}@test.dev`
    const a = await seedLandlord(c, { email: aEmail })
    const b = await seedLandlord(c, { email: bEmail })
    await c.query(`UPDATE landlords SET business_name = 'Alpha Parks LLC' WHERE id = $1`, [a.landlordId])
    await c.query(`UPDATE landlords SET business_name = 'Bravo Parks LLC' WHERE id = $1`, [b.landlordId])
    const pa = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const pb = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
    const ua = await seedUnit(c, { propertyId: pa, landlordId: a.landlordId, rentAmount: 500 })
    const ub = await seedUnit(c, { propertyId: pb, landlordId: b.landlordId, rentAmount: 900 })
    await c.query(`UPDATE units SET status = 'active' WHERE id = ANY($1::uuid[])`, [[ua, ub]])
    const tb = await seedTenant(c)
    await c.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1, $2, $3, 'rent', 900, 'settled', 'RENT', CURRENT_DATE, NOW() - INTERVAL '1 minute')`,
      [ub, tb, b.landlordId])
    await c.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '4999', 'Bravo Secret Income', 'income')`,
      [b.landlordId])
    await c.query('COMMIT')
    return {
      a: { ...a, unitId: ua, email: aEmail },
      b: { ...b, unitId: ub, email: bEmail },
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

describe('Books with the pass auth.ts mints a landlord (S633: profileId and landlordId null)', () => {
  it('the rent roll holds only the caller company\'s units — another landlord\'s rows: none', async () => {
    const { a, b } = await seedTwo()
    const res = await get(landlordPass(a.userId, [a.landlordId]), '/api/books/rent-roll')
    expect(res.status).toBe(200)
    const unitIds = res.body.data.units.map((u: any) => u.unit_id)
    expect(unitIds).toEqual([a.unitId])
    expect(unitIds).not.toContain(b.unitId)
    expect(res.body.data.totalExpected).toBe(500)
    expect(res.body.data.totalCollected).toBe(0)
  })

  it('owner statements list only the caller company — never another landlord\'s name or email', async () => {
    const { a, b } = await seedTwo()
    const res = await get(landlordPass(a.userId, [a.landlordId]), '/api/books/reports/owner-statements')
    expect(res.status).toBe(200)
    expect(res.body.data.map((s: any) => s.landlord.id)).toEqual([a.landlordId])
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(b.email)
    expect(body).not.toContain('Bravo Parks')
  })

  it('the P&L builds the caller company\'s own GAM P&L, never platform-wide income', async () => {
    const { a } = await seedTwo()
    const res = await get(landlordPass(a.userId, [a.landlordId]), '/api/books/reports/pl')
    expect(res.status).toBe(200)
    expect(res.body.data.gamPL).not.toBeNull()
    // Landlord B's $900 is not A's income.
    expect(res.body.data.gamRentIncome).toBe(0)
    expect(res.body.data.income.map((x: any) => x.name)).not.toContain('Bravo Secret Income')
  })

  it('the ledger (chart of accounts) holds none of another landlord\'s accounts', async () => {
    const { a } = await seedTwo()
    const res = await get(landlordPass(a.userId, [a.landlordId]), '/api/books/accounts')
    expect(res.status).toBe(200)
    expect(res.body.data.map((x: any) => x.name)).not.toContain('Bravo Secret Income')
  })

  it('a pass naming no company at all is refused, never read as "every landlord"', async () => {
    const { b } = await seedTwo()
    const res = await get(landlordPass(randomUUID(), []), '/api/books/rent-roll')
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain(b.unitId)
  })
})

describe('Books for an account with more than one company', () => {
  async function seedTwoCompanies() {
    const two = await seedTwo()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      // A second company the same account founded, with its own park.
      const second = (await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name, billing_starts_at) VALUES ($1, 'Alpha Two LLC', DATE '2000-01-01') RETURNING id`,
        [two.a.userId])).rows[0].id
      const p2 = await seedProperty(c, { landlordId: second, ownerUserId: two.a.userId, managedByUserId: two.a.userId })
      const u2 = await seedUnit(c, { propertyId: p2, landlordId: second, rentAmount: 700 })
      await c.query(`UPDATE units SET status = 'active' WHERE id = $1`, [u2])
      await c.query('COMMIT')
      return { ...two, secondId: second, secondUnitId: u2 }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('naming no company is asked which (400), never a default and never every landlord', async () => {
    const f = await seedTwoCompanies()
    const res = await get(landlordPass(f.a.userId, [f.a.landlordId, f.secondId]), '/api/books/rent-roll')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(BOOKS_CHOOSE_COMPANY)
  })

  it('X-Client-Id opens the chosen company\'s books only', async () => {
    const f = await seedTwoCompanies()
    const pass = landlordPass(f.a.userId, [f.a.landlordId, f.secondId])
    const first = await get(pass, '/api/books/rent-roll', f.a.landlordId)
    expect(first.status).toBe(200)
    expect(first.body.data.units.map((u: any) => u.unit_id)).toEqual([f.a.unitId])
    const second = await get(pass, '/api/books/rent-roll', f.secondId)
    expect(second.status).toBe(200)
    expect(second.body.data.units.map((u: any) => u.unit_id)).toEqual([f.secondUnitId])
  })

  it('X-Client-Id naming another landlord\'s company is refused (403) with nothing of theirs', async () => {
    const f = await seedTwoCompanies()
    const res = await get(landlordPass(f.a.userId, [f.a.landlordId, f.secondId]), '/api/books/rent-roll', f.b.landlordId)
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(f.b.unitId)
  })

  it('a company made after sign-in opens too (the database, not only the pass, decides)', async () => {
    const f = await seedTwoCompanies()
    // The pass predates the second company.
    const res = await get(landlordPass(f.a.userId, [f.a.landlordId]), '/api/books/rent-roll', f.secondId)
    expect(res.status).toBe(200)
    expect(res.body.data.units.map((u: any) => u.unit_id)).toEqual([f.secondUnitId])
  })

  it('a remembered company that is not the account\'s never blocks the company list Books picks from', async () => {
    const f = await seedTwoCompanies()
    const res = await get(landlordPass(f.a.userId, [f.a.landlordId, f.secondId]), '/api/books/companies', f.b.landlordId)
    expect(res.status).toBe(200)
    expect(res.body.data.map((x: any) => x.landlord_id)).not.toContain(f.b.landlordId)
  })

  it('GET /companies lists the account\'s own companies by name — and nobody else\'s', async () => {
    const f = await seedTwoCompanies()
    const res = await get(landlordPass(f.a.userId, [f.a.landlordId]), '/api/books/companies')
    expect(res.status).toBe(200)
    const ids = res.body.data.map((x: any) => x.landlord_id)
    expect(new Set(ids)).toEqual(new Set([f.a.landlordId, f.secondId]))
    expect(ids).not.toContain(f.b.landlordId)
    expect(res.body.data.map((x: any) => x.business_name)).toEqual(expect.arrayContaining(['Alpha Parks LLC', 'Alpha Two LLC']))
  })
})

describe('Books bookkeeper access with the S633 pass', () => {
  async function bookkeeper(): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bk', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@t.dev`])).rows[0].id
  }

  it('a landlord can give a bookkeeper its own company\'s books (refused for every landlord before)', async () => {
    const { a } = await seedTwo()
    const bk = await bookkeeper()
    const res = await request(buildApp()).post('/api/books/bookkeeper/assign')
      .set('Authorization', `Bearer ${landlordPass(a.userId, [a.landlordId])}`)
      .send({ bookkeeperUserId: bk, landlordId: a.landlordId, accessLevel: 'read_only' })
    expect(res.status).toBe(200)
    const rows = await db.query(`SELECT 1 FROM bookkeeper_scopes WHERE user_id = $1 AND landlord_id = $2`, [bk, a.landlordId])
    expect(rows.rowCount).toBe(1)
  })

  it('a landlord can never give or take away another landlord\'s books', async () => {
    const { a, b } = await seedTwo()
    const bk = await bookkeeper()
    const pass = landlordPass(a.userId, [a.landlordId])
    const assign = await request(buildApp()).post('/api/books/bookkeeper/assign')
      .set('Authorization', `Bearer ${pass}`)
      .send({ bookkeeperUserId: bk, landlordId: b.landlordId })
    expect(assign.status).toBe(403)
    await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id) VALUES ($1, $2)`, [bk, b.landlordId])
    const revoke = await request(buildApp()).delete('/api/books/bookkeeper/revoke')
      .set('Authorization', `Bearer ${pass}`)
      .send({ bookkeeperUserId: bk, landlordId: b.landlordId })
    expect(revoke.status).toBe(403)
    const still = await db.query(`SELECT 1 FROM bookkeeper_scopes WHERE user_id = $1 AND landlord_id = $2`, [bk, b.landlordId])
    expect(still.rowCount).toBe(1)
  })
})
