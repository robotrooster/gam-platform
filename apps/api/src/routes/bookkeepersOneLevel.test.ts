/**
 * 10/12 (Nic) — BOOKKEEPERS DO FULL BOOKKEEPING, AT ONE LEVEL.
 *
 *   Ledger decision 2: "Full bookkeeping (bank lines, reconciling, journal
 *   entries, bills, payroll, vendors) … never tenant-account actions … One
 *   level, no per-bookkeeper switch."
 *
 *   - bookkeeper_scopes.access_level decides nothing: a row that says
 *     read_only writes like any other (lib/bookkeeperScope bookkeeperMayWrite);
 *     only a missing row (a company that does not keep them) stops writes;
 *   - every new or changed bookkeeper is written 'read_write', whatever an
 *     older screen or invitation sends (routes/scopes);
 *   - migration 20261014240000 writes every row and pending invitation out at
 *     the one level, and makes it the column's default;
 *   - a tenant's account stays refused (the bookkeeper allowlist);
 *   - what the owner and the invitee are told says so.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, withRollback } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { expensesRouter } from './expenses'
import { scopesRouter, invitationsRouter } from './scopes'
import { paymentsRouter } from './payments'
import { BOOKKEEPER_REFUSAL } from '../lib/bookkeeperAccess'
import { bookkeeperMayWrite, NO_BOOKKEEPER_SCOPE } from '../lib/bookkeeperScope'
import { bookkeeperAccessSummary, BOOKKEEPER_ONE_LEVEL } from '@gam/shared'

const SECRET = 'test_jwt_secret_bookkeepers_one_level'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/expenses', expensesRouter)
  a.use('/api/scopes', scopesRouter)
  a.use('/api/invitations', invitationsRouter)
  a.use('/api/payments', paymentsRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })

beforeEach(async () => {
  process.env.JWT_SECRET = SECRET
  await cleanupAllSchema()
})

interface World { landlordId: string; ownerUserId: string; owner: string; park: string; annex: string; unit: string }
async function world(): Promise<World> {
  const c = await db.connect()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const park = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const annex = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unit = await seedUnit(c, { propertyId: park, landlordId })
    return {
      landlordId, ownerUserId, park, annex, unit,
      owner: sign({ userId: ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} }),
    }
  } finally { c.release() }
}
async function bookkeeper(w: World, level: 'read_only' | 'read_write', propertyIds = [w.park]): Promise<{ id: string; tok: string }> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids) VALUES ($1, $2, $3, $4)`,
    [id, w.landlordId, level, propertyIds])
  return { id, tok: sign({ userId: id, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.landlordId, permissions: { access_level: level } }) }
}

describe('one level: the old access level decides nothing', () => {
  it('bookkeeperMayWrite: any scope row on the company writes; no row, no writes', () => {
    expect(bookkeeperMayWrite({ accessLevel: 'read_only' })).toBe(true)
    expect(bookkeeperMayWrite({ accessLevel: 'read_write' })).toBe(true)
    expect(bookkeeperMayWrite(NO_BOOKKEEPER_SCOPE)).toBe(false)
    expect(bookkeeperMayWrite(null)).toBe(false)
    expect(BOOKKEEPER_ONE_LEVEL).toBe('read_write')
  })

  it('a bookkeeper whose row says read_only corrects, pays and removes the owner\'s expense on their property — and never one elsewhere', async () => {
    const w = await world()
    const bk = await bookkeeper(w, 'read_only')
    const mk = async (propertyId: string) => (await request(app()).post('/api/expenses').set(as(w.owner))
      .send({ propertyId, isCommon: true, category: 'repairs', amount: 80, expenseDate: '2026-10-01', unpaid: true })).body.data.id as string
    const onPark = await mk(w.park)
    const onAnnex = await mk(w.annex)
    expect((await request(app()).patch(`/api/expenses/${onPark}`).set(as(bk.tok)).send({ description: 'pump seal' })).status).toBe(200)
    expect((await request(app()).post(`/api/expenses/${onPark}/payments`).set(as(bk.tok)).send({ method: 'check' })).status).toBe(201)
    const another = await mk(w.park)
    expect((await request(app()).post(`/api/expenses/${another}/void`).set(as(bk.tok)).send({})).status).toBe(200)
    expect((await db.query(`SELECT status FROM landlord_expenses WHERE id = $1`, [another])).rows[0].status).toBe('voided')
    // A property they do not keep reads as missing.
    expect((await request(app()).patch(`/api/expenses/${onAnnex}`).set(as(bk.tok)).send({ description: 'x' })).status).toBe(404)
    expect((await request(app()).post(`/api/expenses/${onAnnex}/void`).set(as(bk.tok)).send({})).status).toBe(404)
    expect((await db.query(`SELECT status FROM landlord_expenses WHERE id = $1`, [onAnnex])).rows[0].status).toBe('active')
  })

  it('never a tenant\'s account: recording a rent payment is refused, in words', async () => {
    const w = await world()
    const bk = await bookkeeper(w, 'read_write')
    const r = await request(app()).post(`/api/payments/${randomUUID()}/record-manual`).set(as(bk.tok)).send({ method: 'cash' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe(BOOKKEEPER_REFUSAL)
  })

  it('an access level sent by an older screen changes nothing: the row stays at the one level', async () => {
    const w = await world()
    const bk = await bookkeeper(w, 'read_write')
    const r = await request(app()).patch(`/api/scopes/bookkeeper/${bk.id}`).set(as(w.owner))
      .send({ landlordId: w.landlordId, accessLevel: 'read_only' })
    expect(r.status).toBe(200)
    expect((await db.query(`SELECT access_level FROM bookkeeper_scopes WHERE user_id = $1`, [bk.id])).rows[0].access_level).toBe('read_write')
  })

  it('a new invitation names no level, and accepting it writes the one level', async () => {
    const w = await world()
    const inv = await request(app()).post('/api/scopes/bookkeeper/invite').set(as(w.owner))
      .send({ landlordId: w.landlordId, email: `new-${randomUUID()}@test.dev`, firstName: 'New', lastName: 'Keeper', scope: { propertyIds: [w.park] } })
    expect(inv.status, JSON.stringify(inv.body)).toBe(201)
    const row = (await db.query<{ token: string; scope_payload: any }>(`SELECT token, scope_payload FROM invitations WHERE id = $1`, [inv.body.data.id])).rows[0]
    expect(row.scope_payload).not.toHaveProperty('accessLevel')
    const acc = await request(app()).post(`/api/invitations/${row.token}/accept`).send({ password: 'a-long-password-1', firstName: 'New', lastName: 'Keeper' })
    expect(acc.status).toBe(200)
    expect((await db.query(`SELECT access_level FROM bookkeeper_scopes WHERE user_id = $1`, [acc.body.data.userId])).rows[0].access_level).toBe('read_write')
  })
})

describe('migration 20261014240000 (the one level, written out)', () => {
  const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '20261014240000_bookkeepers_one_level.sql'), 'utf8')
  it('writes every row and pending invitation at the one level, makes it the default, and re-running is a no-op', async () => {
    const w = await world()
    await withRollback(async c => {
      // Put the pre-migration shape back inside the rollback: the old default, a read_only row.
      await c.query(`ALTER TABLE bookkeeper_scopes ALTER COLUMN access_level SET DEFAULT 'read_only'`)
      const ro = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'bookkeeper', 'Ro', 'Old', TRUE) RETURNING id`, [`ro-${randomUUID()}@test.dev`])).rows[0].id
      await c.query(`INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids) VALUES ($1, $2, $3)`, [ro, w.landlordId, [w.park]])
      expect((await c.query(`SELECT access_level FROM bookkeeper_scopes WHERE user_id = $1`, [ro])).rows[0].access_level).toBe('read_only')
      const invite = async (status: string, payload: object) => (await c.query<{ id: string }>(
        `INSERT INTO invitations (email, landlord_id, role, scope_payload, invited_by_user_id, token, expires_at, status)
         VALUES ($1, $2, 'bookkeeper', $3::jsonb, $4, $5, NOW() + interval '1 day', $6) RETURNING id`,
        [`i-${randomUUID()}@t.dev`, w.landlordId, JSON.stringify(payload), w.ownerUserId, randomUUID(), status])).rows[0].id
      const pending = await invite('pending', { accessLevel: 'read_only', propertyIds: [w.park] })
      const noLevel = await invite('pending', { propertyIds: [w.park] })
      const accepted = await invite('accepted', { accessLevel: 'read_only', propertyIds: [w.park] })

      await c.query(SQL)
      await c.query(SQL)

      expect((await c.query(`SELECT access_level FROM bookkeeper_scopes WHERE user_id = $1`, [ro])).rows[0].access_level).toBe('read_write')
      const payload = async (id: string) => (await c.query(`SELECT scope_payload FROM invitations WHERE id = $1`, [id])).rows[0].scope_payload
      expect(await payload(pending)).toEqual({ accessLevel: 'read_write', propertyIds: [w.park] })
      expect(await payload(noLevel)).toEqual({ propertyIds: [w.park] })
      expect(await payload(accepted)).toEqual({ accessLevel: 'read_only', propertyIds: [w.park] })   // history stays as it was
      const def = (await c.query<{ d: string }>(
        `SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'bookkeeper_scopes' AND column_name = 'access_level'`)).rows[0].d
      expect(def).toMatch(/'read_write'/)
    })
    // Nothing is dropped or removed; the column and both values stay (keep-everything).
    const statements = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(statements).not.toMatch(/\b(DROP|DELETE)\b/i)
  })
})

describe('what the owner and the invitee are told', () => {
  it('full bookkeeping on what is ticked, never a tenant\'s account; payroll and the bank only with their boxes', () => {
    const plain = bookkeeperAccessSummary({ propertyCount: 1, companyWide: false })
    expect(plain).toMatch(/They do the full bookkeeping on what they keep \(expenses and bills\), never a tenant's account: they never record a rent payment or give a credit, late fee or refund\./)
    expect(plain).not.toMatch(/ledger|payroll|bank|monthly|read-only/)
    const wide = bookkeeperAccessSummary({ propertyCount: 1, companyWide: true })
    expect(wide).toMatch(/\(expenses and bills, the bank lines going out, vendors, payroll and journal entries\)/)
    expect(bookkeeperAccessSummary({ propertyCount: 0, companyWide: true })).toMatch(/\(the bank lines going out, vendors, payroll and journal entries\)/)
    expect(bookkeeperAccessSummary({ propertyCount: 1, companyWide: false, companyLedger: true }, 'invitee'))
      .toMatch(/You do the full bookkeeping on what you keep \(expenses and bills, vendors, payroll and journal entries\), never a tenant's account: you never record/)
    expect(bookkeeperAccessSummary({ propertyCount: 0, companyWide: false })).toMatch(/^Tick the properties they keep/)
  })
})
