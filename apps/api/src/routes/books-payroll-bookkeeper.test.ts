/**
 * books.ts slice 3 — S385. Continues the books.ts test arc.
 *
 * Covered routes (10):
 *   - GET    /api/books/payroll/runs
 *   - GET    /api/books/payroll/runs/:id
 *   - POST   /api/books/payroll/runs              (calculate draft)
 *   - POST   /api/books/payroll/runs/:id/approve  (finalize + YTD update)
 *   - POST   /api/books/payroll/runs/:id/void     (reverse YTD if approved)
 *   - GET    /api/books/bookkeeper/clients
 *   - GET    /api/books/bookkeeper/all
 *   - POST   /api/books/bookkeeper/invite
 *   - POST   /api/books/bookkeeper/assign
 *   - DELETE /api/books/bookkeeper/revoke
 *
 * After this slice: 24 of 40 books.ts routes covered (60%).
 *
 * Production bugs fixed in this slice (3):
 *   - **POST /bookkeeper/invite**: landlord caller could pass
 *     landlordIds = [<other-landlord-id>] and create a bookkeeper_scopes
 *     row granting a proxy bookkeeper access to a landlord they don't
 *     own. Cross-landlord privilege escalation.
 *   - **POST /bookkeeper/assign**: same flaw — landlord A could assign
 *     any bookkeeper to landlord B's books.
 *   - **DELETE /bookkeeper/revoke**: same flaw — landlord A could
 *     revoke landlord B's bookkeeper at will (denial-of-service).
 *
 * All three fixes share the same shape: if the caller's role is
 * 'landlord', the landlordId(s) in the body must match the caller's
 * own profileId. Admin retains cross-landlord authority.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_pb'
})

interface PortfolioFixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  adminToken:      string
  landlordAToken:  string
  landlordBToken:  string
  bookkeeperUserId: string  // assigned to A read_write
  bkToken:         string
}

async function seedPortfolio(): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(client)
    const { userId: bUid, landlordId: bId } = await seedLandlord(client)
    const admin = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const bk = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Book', 'A', TRUE) RETURNING id`,
      [`bk-${randomUUID()}@test.dev`])
    await client.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level)
       VALUES ($1, $2, 'read_write')`, [bk.rows[0].id, aId])
    await client.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      bookkeeperUserId: bk.rows[0].id,
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      bkToken:        sign({ userId: bk.rows[0].id, role: 'bookkeeper', email: 'bk@t.dev', profileId: bk.rows[0].id, permissions: { access_level: 'read_write' } }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedEmployee(landlordId: string, opts: {
  firstName?: string; lastName?: string; payType?: string; payRate?: number;
  filingStatus?: string; statePct?: number; status?: string;
} = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO books_employees
       (landlord_id, first_name, last_name, pay_type, pay_rate, pay_frequency,
        filing_status, state_withholding_pct, status)
     VALUES ($1,$2,$3,$4,$5,'biweekly',$6,$7,$8) RETURNING id`,
    [landlordId, opts.firstName ?? 'Test', opts.lastName ?? 'Emp',
     opts.payType ?? 'salary', opts.payRate ?? 52000,
     opts.filingStatus ?? 'single', opts.statePct ?? 0,
     opts.status ?? 'active'])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// PAYROLL RUNS
// ───────────────────────────────────────────────────────────────────

describe('GET /payroll/runs', () => {
  it('landlord sees only their own runs', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency)
       VALUES ($1, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly'),
              ($2, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/payroll/runs')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })
})

describe('GET /payroll/runs/:id', () => {
  it('unknown id → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/books/payroll/runs/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/run not found/i)
  })

  it('cross-landlord blocked → 404', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency)
       VALUES ($1, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .get(`/api/books/payroll/runs/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns run + lines joined to employee names', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId, { firstName: 'Ann', lastName: 'Smith' })
    const run = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency)
       VALUES ($1, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly') RETURNING id`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO payroll_run_lines
         (run_id, employee_id, pay_type, gross_pay, net_pay)
       VALUES ($1, $2, 'salary', 2000, 1500)`,
      [run.rows[0].id, empId])
    const res = await request(buildApp())
      .get(`/api/books/payroll/runs/${run.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.lines).toHaveLength(1)
    expect(res.body.data.lines[0].first_name).toBe('Ann')
    expect(Number(res.body.data.lines[0].gross_pay)).toBe(2000)
  })
})

describe('POST /payroll/runs (calculate draft)', () => {
  it('missing fields → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/payroll/runs')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ periodStart: '2026-01-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('no active employees in employeeIds → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/payroll/runs')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        periodStart: '2026-01-01', periodEnd: '2026-01-14',
        payDate: '2026-01-20', payFrequency: 'biweekly',
        employeeIds: [randomUUID()],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no active employees/i)
  })

  it('happy with 1 salary employee: creates draft run + line with gross = annualRate / 26', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId, { payType: 'salary', payRate: 52000 })
    const res = await request(buildApp())
      .post('/api/books/payroll/runs')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        periodStart: '2026-01-01', periodEnd: '2026-01-14',
        payDate: '2026-01-20', payFrequency: 'biweekly',
        employeeIds: [empId],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('draft')
    expect(res.body.data.employee_count).toBe(1)
    expect(res.body.data.lines).toHaveLength(1)
    // 52000 / 26 biweekly periods = 2000
    expect(Number(res.body.data.lines[0].gross_pay)).toBe(2000)
    expect(Number(res.body.data.total_gross)).toBe(2000)
    // totals match line sums (defense-in-depth)
    const fed = Number(res.body.data.total_federal_tax)
    const net = Number(res.body.data.total_net)
    expect(Number(res.body.data.lines[0].federal_tax)).toBe(fed)
    expect(Number(res.body.data.lines[0].net_pay)).toBe(net)
  })

  it('happy with hourly employee + hoursMap: gross = rate × hours', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId, { payType: 'hourly', payRate: 25 })
    const res = await request(buildApp())
      .post('/api/books/payroll/runs')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        periodStart: '2026-01-01', periodEnd: '2026-01-14',
        payDate: '2026-01-20', payFrequency: 'biweekly',
        employeeIds: [empId],
        hoursMap: { [empId]: 80 },
      })
    expect(res.status).toBe(201)
    // 25 × 80 = 2000
    expect(Number(res.body.data.lines[0].gross_pay)).toBe(2000)
    expect(Number(res.body.data.lines[0].hours_worked)).toBe(80)
  })
})

describe('POST /payroll/runs/:id/approve', () => {
  async function seedDraftRun(f: PortfolioFixture, empId: string, grossPay = 2000) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency, status)
       VALUES ($1, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly', 'draft') RETURNING id`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO payroll_run_lines
         (run_id, employee_id, pay_type, gross_pay, federal_tax, state_tax, ss_tax, medicare_tax, net_pay)
       VALUES ($1, $2, 'salary', $3, 240, 0, 124, 29, $4)`,
      [r.rows[0].id, empId, grossPay, grossPay - 240 - 124 - 29])
    return r.rows[0].id
  }

  it('unknown id → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/books/payroll/runs/${randomUUID()}/approve`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('non-draft status (already approved) → 400', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId)
    const runId = await seedDraftRun(f, empId)
    await db.query(`UPDATE payroll_runs SET status='approved' WHERE id=$1`, [runId])
    const res = await request(buildApp())
      .post(`/api/books/payroll/runs/${runId}/approve`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already/i)
  })

  it('happy: flips status to approved + bumps employee YTD totals', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId)
    const runId = await seedDraftRun(f, empId, 2000)
    const res = await request(buildApp())
      .post(`/api/books/payroll/runs/${runId}/approve`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('approved')
    const emp = await db.query<{ ytd_gross: string; ytd_net: string }>(
      `SELECT ytd_gross, ytd_net FROM books_employees WHERE id=$1`, [empId])
    expect(Number(emp.rows[0].ytd_gross)).toBe(2000)
    expect(Number(emp.rows[0].ytd_net)).toBe(2000 - 240 - 124 - 29)
  })
})

describe('POST /payroll/runs/:id/void', () => {
  async function seedApprovedRun(f: PortfolioFixture, empId: string, grossPay = 2000) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (landlord_id, period_start, period_end, pay_date, pay_frequency, status, approved_at)
       VALUES ($1, '2026-01-01', '2026-01-14', '2026-01-20', 'biweekly', 'approved', NOW()) RETURNING id`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO payroll_run_lines
         (run_id, employee_id, pay_type, gross_pay, federal_tax, state_tax, ss_tax, medicare_tax, net_pay)
       VALUES ($1, $2, 'salary', $3, 240, 0, 124, 29, $4)`,
      [r.rows[0].id, empId, grossPay, grossPay - 240 - 124 - 29])
    // YTD on employee reflects approved run.
    await db.query(
      `UPDATE books_employees SET ytd_gross=$1, ytd_federal_tax=240, ytd_ss=124, ytd_medicare=29, ytd_net=$2 WHERE id=$3`,
      [grossPay, grossPay - 240 - 124 - 29, empId])
    return r.rows[0].id
  }

  it('already voided → 400', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId)
    const runId = await seedApprovedRun(f, empId)
    await db.query(`UPDATE payroll_runs SET status='voided' WHERE id=$1`, [runId])
    const res = await request(buildApp())
      .post(`/api/books/payroll/runs/${runId}/void`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already voided/i)
  })

  it('voiding an approved run reverses YTD totals', async () => {
    const f = await seedPortfolio()
    const empId = await seedEmployee(f.landlordAId)
    const runId = await seedApprovedRun(f, empId, 2000)
    const res = await request(buildApp())
      .post(`/api/books/payroll/runs/${runId}/void`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    const emp = await db.query<{ ytd_gross: string; ytd_net: string }>(
      `SELECT ytd_gross, ytd_net FROM books_employees WHERE id=$1`, [empId])
    expect(Number(emp.rows[0].ytd_gross)).toBe(0)  // reversed
    expect(Number(emp.rows[0].ytd_net)).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// BOOKKEEPER MANAGEMENT
// ───────────────────────────────────────────────────────────────────

describe('GET /bookkeeper/clients', () => {
  it('bookkeeper self-fetch returns their assigned clients', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/bookkeeper/clients')
      .set('Authorization', `Bearer ${f.bkToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].landlord_id).toBe(f.landlordAId)
    expect(res.body.data[0].access_level).toBe('read_write')
  })

  it('admin sees all bookkeeper-scope rows across the platform', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/bookkeeper/clients')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('landlord caller → 403 (route is bookkeeper/admin-only)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/bookkeeper/clients')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /bookkeeper/all', () => {
  it('admin sees all bookkeepers grouped by user', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/bookkeeper/all')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(f.bookkeeperUserId)
    expect(Number(res.body.data[0].client_count)).toBe(1)
  })

  it('non-admin (landlord) → 403', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/bookkeeper/all')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /bookkeeper/invite — S385 cross-landlord fix', () => {
  it('missing required fields → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/invite')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ email: 'x@y.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('landlord A inviting bookkeeper into landlord B → 403 (was: cross-tenant grant)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/invite')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        email: `bkx-${randomUUID()}@t.dev`, firstName: 'B', lastName: 'K',
        password: 'longpass1234',
        landlordIds: [f.landlordBId],  // not landlord A
        accessLevel: 'read_write',
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/their own books/i)
    // Confirm no scope row was created.
    const scopes = await db.query(
      `SELECT id FROM bookkeeper_scopes WHERE landlord_id=$1 AND access_level='read_write'`,
      [f.landlordBId])
    expect(scopes.rows.filter((r: any) => r.id).length).toBe(0)
  })

  it('landlord A inviting bookkeeper into their own landlord A → happy 201', async () => {
    const f = await seedPortfolio()
    const email = `bky-${randomUUID()}@t.dev`
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/invite')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        email, firstName: 'B', lastName: 'K',
        password: 'longpass1234',
        landlordIds: [f.landlordAId],
        accessLevel: 'read_write',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.clientsAssigned).toBe(1)
    // Confirm scope row exists.
    const u = await db.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [email])
    const scopes = await db.query(
      `SELECT access_level FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [u.rows[0].id, f.landlordAId])
    expect(scopes.rows).toHaveLength(1)
  })

  it('admin can invite into any landlord (retains cross-landlord authority)', async () => {
    const f = await seedPortfolio()
    const email = `bkz-${randomUUID()}@t.dev`
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/invite')
      .set('Authorization', `Bearer ${f.adminToken}`)
      .send({
        email, firstName: 'B', lastName: 'K',
        password: 'longpass1234',
        landlordIds: [f.landlordAId, f.landlordBId],
        accessLevel: 'read_only',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.clientsAssigned).toBe(2)
  })
})

describe('POST /bookkeeper/assign — S385 cross-landlord fix', () => {
  it('landlord A assigning to landlord B → 403', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/assign')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ bookkeeperUserId: f.bookkeeperUserId, landlordId: f.landlordBId, accessLevel: 'read_write' })
    expect(res.status).toBe(403)
    // Confirm no scope row was added.
    const scopes = await db.query(
      `SELECT id FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [f.bookkeeperUserId, f.landlordBId])
    expect(scopes.rows).toHaveLength(0)
  })

  it('landlord A assigning to own landlord A → happy (upsert)', async () => {
    const f = await seedPortfolio()
    // Already exists from fixture. Re-assign with read_only — should upsert.
    const res = await request(buildApp())
      .post('/api/books/bookkeeper/assign')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ bookkeeperUserId: f.bookkeeperUserId, landlordId: f.landlordAId, accessLevel: 'read_only' })
    expect(res.status).toBe(200)
    const scopes = await db.query<{ access_level: string }>(
      `SELECT access_level FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [f.bookkeeperUserId, f.landlordAId])
    expect(scopes.rows[0].access_level).toBe('read_only')
  })
})

describe('DELETE /bookkeeper/revoke — S385 cross-landlord fix', () => {
  it('landlord B revoking landlord A bookkeeper → 403; scope row intact', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .delete('/api/books/bookkeeper/revoke')
      .set('Authorization', `Bearer ${f.landlordBToken}`)
      .send({ bookkeeperUserId: f.bookkeeperUserId, landlordId: f.landlordAId })
    expect(res.status).toBe(403)
    const scopes = await db.query(
      `SELECT id FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [f.bookkeeperUserId, f.landlordAId])
    expect(scopes.rows).toHaveLength(1)  // not deleted
  })

  it('landlord A revoking own bookkeeper → happy; scope row removed', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .delete('/api/books/bookkeeper/revoke')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ bookkeeperUserId: f.bookkeeperUserId, landlordId: f.landlordAId })
    expect(res.status).toBe(200)
    const scopes = await db.query(
      `SELECT id FROM bookkeeper_scopes WHERE user_id=$1 AND landlord_id=$2`,
      [f.bookkeeperUserId, f.landlordAId])
    expect(scopes.rows).toHaveLength(0)
  })
})
