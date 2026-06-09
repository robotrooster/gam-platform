/**
 * books.ts slice 1 — S383. Opens the books.ts test arc.
 *
 * Covered routes (8):
 *   - GET    /api/books/accounts
 *   - POST   /api/books/accounts
 *   - PATCH  /api/books/accounts/:id
 *   - DELETE /api/books/accounts/:id
 *   - POST   /api/books/accounts/seed
 *   - GET    /api/books/employees
 *   - POST   /api/books/employees
 *   - PATCH  /api/books/employees/:id
 *
 * books.ts arc plan (per COVERAGE_AUDIT_S382.md):
 *   S383 slice 1: accounts + employees CRUD (this file, 8 routes)
 *   S384 slice 2: contractors + vendors CRUD (6 routes)
 *   S385 slice 3: payroll runs + bookkeeper invites (~9 routes)
 *   S386 slice 4: journal + transactions + bills (~9 routes)
 *   S387 slice 5: reports (pl / bs / cash-flow / owner / tax / rent-roll, ~6 routes)
 *
 * Production bug fixed in this slice:
 *   - **Cross-tenant privilege escalation in bookkeeper scoping.**
 *     The X-Client-Id middleware was blindly accepting the header
 *     without validating against bookkeeper_scopes, AND treating a
 *     missing header as activeClientId=null. Both paths flowed into
 *     landlordScope returning null, which made the SQL guard
 *     `WHERE landlord_id=$1 OR $1 IS NULL` evaluate to true for every
 *     row across every landlord. A bookkeeper invited by Landlord A
 *     could read/edit/delete any account or employee of any landlord
 *     in the system, just by omitting the header.
 *
 *     S383 fix: middleware now requires the X-Client-Id header (400 if
 *     missing) and validates against bookkeeper_scopes (403 if the
 *     bookkeeper isn't assigned to the claimed client). The fix also
 *     re-stamps access_level from the live scope row onto
 *     req.user.permissions, so a revoked / downgraded scope takes
 *     effect immediately instead of being stuck on the JWT.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_accounts'
})

interface PortfolioFixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  // Tokens
  adminToken:      string
  landlordAToken:  string
  landlordBToken:  string
  bkAToken:        string  // bookkeeper assigned to A with read_write
  bkAReadOnly:     string  // bookkeeper assigned to A with read_only
  bkAUserId:       string  // for inserting scope rows
  bkUnassigned:    string  // bookkeeper with NO scope rows
}

async function seedPortfolio(): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordAUserId, landlordId: landlordAId } = await seedLandlord(client)
    const { userId: landlordBUserId, landlordId: landlordBId } = await seedLandlord(client)
    // Admin user.
    const admin = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    // Bookkeeper user assigned to A (read_write).
    const bkA = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Book', 'A', TRUE) RETURNING id`,
      [`bka-${randomUUID()}@test.dev`])
    await client.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level) VALUES ($1, $2, 'read_write')`,
      [bkA.rows[0].id, landlordAId])
    // Bookkeeper user with NO scope rows.
    const bkU = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Book', 'U', TRUE) RETURNING id`,
      [`bku-${randomUUID()}@test.dev`])
    await client.query('COMMIT')

    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId, landlordAId, landlordBUserId, landlordBId,
      bkAUserId: bkA.rows[0].id,
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      landlordAToken: sign({ userId: landlordAUserId, role: 'landlord', email: 'la@t.dev', profileId: landlordAId, permissions: {} }),
      landlordBToken: sign({ userId: landlordBUserId, role: 'landlord', email: 'lb@t.dev', profileId: landlordBId, permissions: {} }),
      // Bookkeeper JWTs carry the JWT-time access_level — middleware
      // re-stamps it from the live scope on each request anyway.
      bkAToken:       sign({ userId: bkA.rows[0].id, role: 'bookkeeper', email: 'bka@t.dev',
                              profileId: bkA.rows[0].id, permissions: { access_level: 'read_write' } }),
      bkAReadOnly:    sign({ userId: bkA.rows[0].id, role: 'bookkeeper', email: 'bka@t.dev',
                              profileId: bkA.rows[0].id, permissions: { access_level: 'read_only' } }),
      bkUnassigned:   sign({ userId: bkU.rows[0].id, role: 'bookkeeper', email: 'bku@t.dev',
                              profileId: bkU.rows[0].id, permissions: { access_level: 'read_write' } }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// ───────────────────────────────────────────────────────────────────
// SECURITY: bookkeeper scope validation (S383 fix)
// ───────────────────────────────────────────────────────────────────

describe('bookkeeper scope validation — S383 fix', () => {
  it('bookkeeper WITHOUT X-Client-Id → 400 (was: bypass-all)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.bkAToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/x-client-id.*required/i)
  })

  it('bookkeeper WITH X-Client-Id pointing at unassigned landlord → 403 (was: cross-tenant access)', async () => {
    const f = await seedPortfolio()
    // bkA is assigned to landlord A only — try to act on landlord B.
    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordBId)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not assigned/i)
  })

  it('bookkeeper with no scopes at all → 403 on any client id', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.bkUnassigned}`)
      .set('X-Client-Id', f.landlordAId)
    expect(res.status).toBe(403)
  })

  it('bookkeeper WITH valid X-Client-Id → 200, scoped to that client', async () => {
    const f = await seedPortfolio()
    // Seed an account on landlord A and landlord B.
    await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'A Bank', 'asset')`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'B Bank', 'asset')`,
      [f.landlordBId])

    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordAId)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('A Bank')
  })

  it('bookkeeper JWT claims read_write but live scope is read_only → middleware re-stamps; writes blocked', async () => {
    const f = await seedPortfolio()
    // Downgrade bkA's scope to read_only on the live row.
    await db.query(
      `UPDATE bookkeeper_scopes SET access_level='read_only' WHERE user_id=$1 AND landlord_id=$2`,
      [f.bkAUserId, f.landlordAId])
    // bkAToken (NOT bkAReadOnly) still claims read_write in its JWT.
    const res = await request(buildApp())
      .post('/api/books/accounts')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordAId)
      .send({ code: '9999', name: 'Should not write', type: 'asset' })
    expect(res.status).toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────
// CHART OF ACCOUNTS
// ───────────────────────────────────────────────────────────────────

describe('GET /accounts', () => {
  it('landlord sees only their own active accounts', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type, active) VALUES
        ($1, '1010', 'A Active', 'asset', TRUE),
        ($1, '1020', 'A Inactive', 'asset', FALSE),
        ($2, '1010', 'B Active', 'asset', TRUE)`,
      [f.landlordAId, f.landlordBId])

    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('A Active')
  })

  it('admin sees all active accounts across landlords', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES
        ($1, '1010', 'A Bank', 'asset'),
        ($2, '1010', 'B Bank', 'asset')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /accounts', () => {
  it('missing code/name/type → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/accounts')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ name: 'Missing Code' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('duplicate code per landlord → 409', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'Existing', 'asset')`,
      [f.landlordAId])
    const res = await request(buildApp())
      .post('/api/books/accounts')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ code: '1010', name: 'Duplicate', type: 'asset' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already exists/i)
  })

  it('happy: creates account scoped to landlord; 201', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/accounts')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ code: '4010', name: 'Rental Income', type: 'income', subtype: 'operating' })
    expect(res.status).toBe(201)
    expect(res.body.data.code).toBe('4010')
    expect(res.body.data.name).toBe('Rental Income')
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })
})

describe('PATCH /accounts/:id', () => {
  it('cross-landlord modify is blocked: landlord A cannot patch landlord B account', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'B Bank', 'asset') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/accounts/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
    const verify = await db.query<{ name: string }>(
      `SELECT name FROM books_accounts WHERE id=$1`, [ins.rows[0].id])
    expect(verify.rows[0].name).toBe('B Bank')
  })

  it('happy: COALESCE-update preserves untouched fields', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type, subtype, description)
       VALUES ($1, '1010', 'Original', 'asset', 'bank', 'orig desc') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/accounts/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ name: 'Updated' })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Updated')
    expect(res.body.data.subtype).toBe('bank')  // preserved by COALESCE
    expect(res.body.data.description).toBe('orig desc')
  })
})

describe('DELETE /accounts/:id', () => {
  it('soft-deletes (active=FALSE); subsequent GET excludes it', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'Bank', 'asset') RETURNING id`,
      [f.landlordAId])
    const del = await request(buildApp())
      .delete(`/api/books/accounts/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(del.status).toBe(200)
    const row = await db.query<{ active: boolean }>(
      `SELECT active FROM books_accounts WHERE id=$1`, [ins.rows[0].id])
    expect(row.rows[0].active).toBe(false)

    const list = await request(buildApp())
      .get('/api/books/accounts')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(list.body.data).toEqual([])
  })
})

describe('POST /accounts/seed — bulk standard COA', () => {
  it('seeds 41 standard accounts; idempotent on re-call', async () => {
    const f = await seedPortfolio()
    const r1 = await request(buildApp())
      .post('/api/books/accounts/seed')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(r1.status).toBe(200)
    expect(r1.body.data.inserted).toBe(41)

    const count1 = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM books_accounts WHERE landlord_id=$1`, [f.landlordAId])
    expect(Number(count1.rows[0].n)).toBe(41)

    // Re-call → 0 inserted (already exists checks).
    const r2 = await request(buildApp())
      .post('/api/books/accounts/seed')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(r2.status).toBe(200)
    expect(r2.body.data.inserted).toBe(0)
    const count2 = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM books_accounts WHERE landlord_id=$1`, [f.landlordAId])
    expect(Number(count2.rows[0].n)).toBe(41)
  })
})

// ───────────────────────────────────────────────────────────────────
// EMPLOYEES
// ───────────────────────────────────────────────────────────────────

describe('GET /employees', () => {
  it('landlord sees only their own employees', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate) VALUES
        ($1, 'Ann', 'Smith', 'salary', 50000),
        ($2, 'Bob', 'Jones', 'salary', 60000)`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].first_name).toBe('Ann')
  })
})

describe('POST /employees', () => {
  // S416: strict zod validation. All fields required.
  const happyPayload = () => ({
    firstName:           'Ann',
    lastName:            'Smith',
    email:               'ann.smith@employer.test',
    phone:               '5555550100',
    address:             '100 Main St, Anywhere AZ 85000',
    ssnLast4:            '1234',
    payType:             'salary',
    payRate:             55000,
    payFrequency:        'biweekly',
    filingStatus:        'single',
    federalAllowances:   0,
    stateWithholdingPct: 2.5,
    title:               'Property Manager',
    department:          'Operations',
    startDate:           '2026-01-15',
  })

  it('happy: creates employee with all required fields', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(happyPayload())
    expect(res.status).toBe(201)
    expect(res.body.data.first_name).toBe('Ann')
    expect(Number(res.body.data.state_withholding_pct)).toBe(2.5)
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
    expect(res.body.data.pay_frequency).toBe('biweekly')
  })

  it('legacy azWithholdingPct accepted in place of stateWithholdingPct', async () => {
    const f = await seedPortfolio()
    const { stateWithholdingPct, ...rest } = happyPayload()
    void stateWithholdingPct
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...rest, azWithholdingPct: 2.5 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.state_withholding_pct)).toBe(2.5)
  })

  it('new stateWithholdingPct takes precedence over legacy azWithholdingPct', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), stateWithholdingPct: 3.1, azWithholdingPct: 2.5 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.state_withholding_pct)).toBe(3.1)
  })

  it('S416 fix: empty body → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('S416 fix: missing firstName → 400 (was 400 pre-fix but with different message)', async () => {
    const f = await seedPortfolio()
    const { firstName, ...without } = happyPayload()
    void firstName
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('missing ssnLast4 → 400 (was: NULL in db pre-fix)', async () => {
    const f = await seedPortfolio()
    const { ssnLast4, ...without } = happyPayload()
    void ssnLast4
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('missing startDate → 400', async () => {
    const f = await seedPortfolio()
    const { startDate, ...without } = happyPayload()
    void startDate
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('invalid payType enum → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), payType: 'contractor' })
    expect(res.status).toBe(400)
  })

  it('invalid payFrequency enum → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), payFrequency: 'quarterly' })
    expect(res.status).toBe(400)
  })

  it('invalid filingStatus enum → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), filingStatus: 'separated' })
    expect(res.status).toBe(400)
  })

  it('startDate wrong format → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), startDate: '01/15/2026' })
    expect(res.status).toBe(400)
  })

  it('ssnLast4 not 4 digits → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), ssnLast4: 'abcd' })
    expect(res.status).toBe(400)
  })

  it('payRate zero/negative → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), payRate: 0 })
    expect(res.status).toBe(400)
  })

  it('federalAllowances negative → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/employees')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), federalAllowances: -1 })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /employees/:id', () => {
  it('cross-landlord modify blocked → 404', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_employees (landlord_id, first_name, last_name, pay_type, pay_rate)
       VALUES ($1, 'B', 'Emp', 'salary', 50000) RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/employees/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ firstName: 'Hijacked' })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE-update preserves untouched fields', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_employees
         (landlord_id, first_name, last_name, pay_type, pay_rate, department)
       VALUES ($1, 'Ann', 'Smith', 'salary', 50000, 'maintenance') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/employees/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ title: 'Lead' })
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('Lead')
    expect(res.body.data.department).toBe('maintenance')  // preserved
    expect(res.body.data.first_name).toBe('Ann')          // preserved
  })
})
