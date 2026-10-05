/**
 * books.ts slice 5 — S387. **CLOSES the books.ts test arc.**
 *
 * Covered routes (6):
 *   - GET /api/books/reports/pl
 *   - GET /api/books/reports/balance-sheet
 *   - GET /api/books/reports/cash-flow
 *   - GET /api/books/reports/owner-statements
 *   - GET /api/books/tax/summary
 *   - GET /api/books/rent-roll
 *
 * After this slice: **40 of 40 books.ts routes covered (100%)**.
 *
 * Production bugs fixed in this slice (2):
 *   - **GET /reports/pl rentIncome scope key bug**: subquery used
 *     `req.user.userId` against `landlords.user_id`. Admin and
 *     bookkeeper callers always got $0 rent income because their
 *     user_id doesn't match any landlord's user_id. Landlord
 *     callers worked by coincidence. Fix: use `lid` (the landlord
 *     scope id) directly — same shape as every other report query
 *     in this file.
 *   - **GET /rent-roll extra user_id AND clause**: had `($2::boolean
 *     OR l.user_id = $3::uuid)` filter where $2=role-is-admin and
 *     $3=caller's user_id. Bookkeepers got empty rent roll despite
 *     valid X-Client-Id scope, because their user_id doesn't match
 *     any landlord's user_id. Fix: drop the redundant clause — the
 *     `l.id = lid` filter (set by landlordScope, enforced by
 *     S383 middleware for bookkeepers) already provides the right
 *     trust boundary.
 *
 * Same root cause as S385+S386 cross-tenant scope cluster, but
 * inverted: pre-S387 these routes were OVER-restricting (excluded
 * legit bookkeeper/admin views) instead of UNDER-restricting
 * (exposing cross-tenant data). Wrong scope key in both directions.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_reports'
})

interface PortfolioFixture {
  landlordAUserId:  string
  landlordAId:      string
  landlordBId:      string
  propertyAId:      string
  unitAId:          string
  tenantAId:        string
  // Pre-seeded books_accounts on landlord A.
  acctIncomeA:      string
  acctExpenseA:     string
  acctAssetA:       string
  acctLiabilityA:   string
  acctEquityA:      string
  // Tokens.
  adminToken:       string
  landlordAToken:   string
  landlordBToken:   string
  bkAToken:         string  // bookkeeper assigned to A
  bkAUserId:        string
}

async function seedPortfolio(): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(client)
    const { userId: bUid, landlordId: bId } = await seedLandlord(client)
    const propAId = await seedProperty(client, {
      landlordId: aId, ownerUserId: aUid, managedByUserId: aUid,
    })
    const unitAId = await seedUnit(client, { propertyId: propAId, landlordId: aId, rentAmount: 1500 })
    await client.query(`UPDATE units SET status='active' WHERE id=$1`, [unitAId])
    const tenantAId = await seedTenant(client)
    const admin = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    const bk = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bk', 'A', TRUE) RETURNING id`,
      [`bk-${randomUUID()}@test.dev`])
    await client.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level)
       VALUES ($1, $2, 'read_write')`, [bk.rows[0].id, aId])
    // Seed one account of each type on landlord A so reports have rows.
    const acctRows = await client.query<{ id: string; type: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES
        ($1, '4010', 'Rental Income', 'income'),
        ($1, '5040', 'Repairs', 'expense'),
        ($1, '1010', 'Checking', 'asset'),
        ($1, '2010', 'AP', 'liability'),
        ($1, '3010', 'Owner Equity', 'equity')
       RETURNING id, type`,
      [aId])
    const byType = (t: string) => acctRows.rows.find((r: any) => r.type === t)!.id
    await client.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId, landlordBId: bId,
      propertyAId: propAId, unitAId, tenantAId,
      acctIncomeA:    byType('income'),
      acctExpenseA:   byType('expense'),
      acctAssetA:     byType('asset'),
      acctLiabilityA: byType('liability'),
      acctEquityA:    byType('equity'),
      bkAUserId: bk.rows[0].id,
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: null, landlordIds: [aId], permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: null, landlordIds: [bId], permissions: {} }),
      bkAToken:       sign({ userId: bk.rows[0].id, role: 'bookkeeper', email: 'bk@t.dev', profileId: bk.rows[0].id, permissions: { access_level: 'read_write' } }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedSettledPayment(f: PortfolioFixture, amount: number, dueDate = '2026-05-15') {
  // The P&L recognizes income on the CASH (settled) date — a settled payment
  // carries a settled_at (S568 shared computeLandlordPL, cash basis).
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
     VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT', $5::date, $5::date)`,
    [f.unitAId, f.tenantAId, f.landlordAId, amount, dueDate])
}

// ───────────────────────────────────────────────────────────────────
// GET /reports/pl
// ───────────────────────────────────────────────────────────────────

describe('GET /reports/pl', () => {
  it('landlord with no journal entries → zero totals + empty arrays', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.income).toHaveLength(1)   // 1 income account, period_amount=0
    expect(res.body.data.expenses).toHaveLength(1) // 1 expense account, period_amount=0
    expect(res.body.data.totalIncome).toBe(0)
    expect(res.body.data.totalExpenses).toBe(0)
    expect(res.body.data.netIncome).toBe(0)
    expect(res.body.data.gamRentIncome).toBe(0)
  })

  it('happy: journal entries in window contribute to income/expense period_amount; net = income - expense', async () => {
    const f = await seedPortfolio()
    // Post a balanced entry: $1000 to income (credit), $1000 to asset (debit).
    await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-15', description: 'Rent received',
        lines: [
          { accountId: f.acctAssetA,  debit: 1000, credit: 0 },
          { accountId: f.acctIncomeA, debit: 0,    credit: 1000 },
        ],
      })
    // Post an expense entry: $300 to expense (debit), $300 from asset (credit).
    await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-20', description: 'Repair bill',
        lines: [
          { accountId: f.acctExpenseA, debit: 300, credit: 0 },
          { accountId: f.acctAssetA,   debit: 0,   credit: 300 },
        ],
      })

    const res = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalIncome).toBe(1000)
    expect(res.body.data.totalExpenses).toBe(300)
    expect(res.body.data.netIncome).toBe(700)
  })

  it('S387 fix: bookkeeper sees rent income from settled payments (was: always $0)', async () => {
    const f = await seedPortfolio()
    await seedSettledPayment(f, 1500)
    const res = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordAId)
    expect(res.status).toBe(200)
    expect(res.body.data.gamRentIncome).toBe(1500)  // pre-fix: 0
  })

  it('S387 fix: admin sees rent income aggregated across all landlords', async () => {
    const f = await seedPortfolio()
    await seedSettledPayment(f, 1500)
    const res = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gamRentIncome).toBe(1500)  // pre-fix: 0
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /reports/balance-sheet
// ───────────────────────────────────────────────────────────────────

describe('GET /reports/balance-sheet', () => {
  it('groups by asset/liability/equity; balances flag uses Assets = Liab + Equity', async () => {
    const f = await seedPortfolio()
    // Manually set balances: 1000 asset, 400 liability, 600 equity → balanced.
    await db.query(`UPDATE books_accounts SET balance=1000 WHERE id=$1`, [f.acctAssetA])
    await db.query(`UPDATE books_accounts SET balance=400  WHERE id=$1`, [f.acctLiabilityA])
    await db.query(`UPDATE books_accounts SET balance=600  WHERE id=$1`, [f.acctEquityA])
    const res = await request(buildApp())
      .get('/api/books/reports/balance-sheet')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totalAssets).toBe(1000)
    expect(res.body.data.totalLiabilities).toBe(400)
    expect(res.body.data.totalEquity).toBe(600)
    expect(res.body.data.balances).toBe(true)
  })

  it('out-of-balance: balances=false', async () => {
    const f = await seedPortfolio()
    await db.query(`UPDATE books_accounts SET balance=1000 WHERE id=$1`, [f.acctAssetA])
    await db.query(`UPDATE books_accounts SET balance=900  WHERE id=$1`, [f.acctLiabilityA])
    // equity stays 0 → 1000 ≠ 900 + 0
    const res = await request(buildApp())
      .get('/api/books/reports/balance-sheet')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.body.data.balances).toBe(false)
  })

  it('cross-landlord isolation: landlord B sees only their own accounts (none seeded)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/reports/balance-sheet')
      .set('Authorization', `Bearer ${f.landlordBToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.assets).toHaveLength(0)
    expect(res.body.data.liabilities).toHaveLength(0)
    expect(res.body.data.equity).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /reports/cash-flow
// ───────────────────────────────────────────────────────────────────

describe('GET /reports/cash-flow', () => {
  it('aggregates rent + tx income + tx expense + payroll + bills + disbursements', async () => {
    const f = await seedPortfolio()
    await seedSettledPayment(f, 1500)
    await db.query(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type) VALUES
        ($1, '2026-05-10', 'misc income', 200, 'income'),
        ($1, '2026-05-11', 'misc expense', 100, 'expense')`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/books/reports/cash-flow?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.operating.inflows.rentCollected).toBe(1500)
    expect(res.body.data.operating.inflows.otherIncome).toBe(200)
    expect(res.body.data.operating.inflows.total).toBe(1700)
    expect(res.body.data.operating.outflows.expenses).toBe(100)
    expect(res.body.data.operating.net).toBe(1600)  // 1700 - 100
    expect(res.body.data.netCashFlow).toBe(1600)  // no disbursements
  })

  it('bookkeeper with valid X-Client-Id sees client cash flow', async () => {
    const f = await seedPortfolio()
    await seedSettledPayment(f, 1500)
    const res = await request(buildApp())
      .get('/api/books/reports/cash-flow?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordAId)
    expect(res.status).toBe(200)
    expect(res.body.data.operating.inflows.rentCollected).toBe(1500)
  })

  // S654: paid_at is a timestamp. Against a bare end date it was compared to
  // midnight at the START of that day, so a bill paid on the last day of the
  // range — or today, on the default range — dropped out of the outflows.
  it('a bill paid on the last day of the range counts; one paid the next day does not', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_bills (landlord_id, date, description, amount, amount_paid, status, paid_at) VALUES
        ($1, '2026-09-15', 'paid on the 30th', 400, 400, 'paid', '2026-09-30T15:00:00-07:00'),
        ($1, '2026-09-15', 'paid on Oct 1',    90,  90,  'paid', '2026-10-01T09:00:00-07:00')`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.operating.outflows.bills).toBe(400)
  })
})

describe('GET /reports/pl — the last day of the range (S654)', () => {
  it('rent settled at 3 pm on the end date is in the GAM P&L', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1, $2, $3, 'rent', 1500, 'settled', 'RENT', '2026-09-01', '2026-09-30T15:00:00-07:00')`,
      [f.unitAId, f.tenantAId, f.landlordAId])
    const res = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gamRentIncome).toBe(1500)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /reports/owner-statements
// ───────────────────────────────────────────────────────────────────

describe('GET /reports/owner-statements', () => {
  it('landlord-scoped: returns a statement only for caller landlord', async () => {
    const f = await seedPortfolio()
    await seedSettledPayment(f, 1500)
    const res = await request(buildApp())
      .get('/api/books/reports/owner-statements?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].landlord.id).toBe(f.landlordAId)
    expect(res.body.data[0].properties).toHaveLength(1)
    expect(Number(res.body.data[0].totalCollected)).toBe(1500)
  })

  it('admin sees all landlords in one call', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/reports/owner-statements?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)  // landlord A + B
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /tax/summary
// ───────────────────────────────────────────────────────────────────

describe('GET /tax/summary', () => {
  it('rolls up YTD payroll + 1099 contractors + employees + filingDeadlines', async () => {
    const f = await seedPortfolio()
    // Seed a contractor at $700 ytd (over $600 threshold for 1099).
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, ytd_paid, w9_on_file)
       VALUES ($1, 'Joe', 'Plumber', 700, TRUE)`,
      [f.landlordAId])
    // And one under threshold — should NOT appear.
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, ytd_paid)
       VALUES ($1, 'Lo', 'NoFile', 500)`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get(`/api/books/tax/summary?year=2026`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.year)).toBe(2026)
    expect(res.body.data.contractors1099).toHaveLength(1)
    expect(res.body.data.contractors1099[0].first_name).toBe('Joe')
    expect(Array.isArray(res.body.data.filingDeadlines)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /rent-roll
// ───────────────────────────────────────────────────────────────────

describe('GET /rent-roll', () => {
  it('landlord sees their own units with property + rent', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/rent-roll')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.units).toHaveLength(1)
    expect(res.body.data.units[0].property_name).toBe('Test Property')
    expect(Number(res.body.data.units[0].rent_amount)).toBe(1500)
    expect(res.body.data.totalExpected).toBe(1500)
  })

  it('S387 fix: bookkeeper with X-Client-Id sees client rent roll (was: empty)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/rent-roll')
      .set('Authorization', `Bearer ${f.bkAToken}`)
      .set('X-Client-Id', f.landlordAId)
    expect(res.status).toBe(200)
    expect(res.body.data.units).toHaveLength(1)  // pre-fix: 0
    expect(res.body.data.units[0].property_name).toBe('Test Property')
  })

  it('admin sees rent roll across all landlords', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/rent-roll')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.units).toHaveLength(1)  // only A has a unit; B has none
  })

  it('cross-landlord isolation: landlord B sees only their own units (none)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get('/api/books/rent-roll')
      .set('Authorization', `Bearer ${f.landlordBToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.units).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────
// S654: ONE DEFINITION OF LANDLORD INCOME (services/landlordPL.ts)
// $700 rent + $400 home-sale payment + $50 carried balance = 1,150 of income.
// A $6 GAM fee is GAM's, a $500 deposit is held (never income), and a FlexPay
// pull is GAM reimbursing its own front.
// ───────────────────────────────────────────────────────────────────

async function seedIncomeRows(f: PortfolioFixture, dueDate: string, settledAt: string) {
  const rows: Array<[string, number, string, string]> = [
    ['rent',            700, 'landlord', 'RENT'],
    ['home_payment',    400, 'landlord', 'HOMEPMT'],
    ['carried_balance',  50, 'landlord', 'BALANCE'],
    ['fee',               6, 'gam',      'DECLINEFEE'],
    ['deposit',         500, 'landlord', 'DEPOSIT'],
  ]
  for (const [type, amount, owner, entry] of rows) {
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description,
         due_date, settled_at, revenue_owner)
       VALUES ($1, $2, $3, $4, $5, 'settled', $6, $7::date, $8::timestamptz, $9)`,
      [f.unitAId, f.tenantAId, f.landlordAId, type, amount, entry, dueDate, settledAt, owner])
  }
  // A FlexPay pull dated the cycle's 15th so it cannot collide with the rent row.
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description,
       due_date, settled_at)
     VALUES ($1, $2, $3, 'rent', 725, 'settled', 'FLEXPAY', ($4::date + 14), $5::timestamptz)`,
    [f.unitAId, f.tenantAId, f.landlordAId, dueDate, settledAt])
}

describe('S654: Books reports use the one landlord income definition', () => {
  it('/reports/pl: the landlord P&L and the all-landlords total both say 1,150', async () => {
    const f = await seedPortfolio()
    await seedIncomeRows(f, '2026-09-01', '2026-09-03T10:00:00-07:00')
    const mine = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data.gamRentIncome).toBe(1150)
    expect(mine.body.data.gamPL.gross.balances).toBe(50)
    expect(mine.body.data.gamPL.gross.homeSale).toBe(400)
    expect(mine.body.data.gamPL.depositsHeld).toBe(500)
    const all = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(all.status).toBe(200)
    expect(all.body.data.gamRentIncome).toBe(1150)
  })

  it('/reports/cash-flow: rent collected 1,150, the deposit reported as held outside the totals', async () => {
    const f = await seedPortfolio()
    await seedIncomeRows(f, '2026-09-01', '2026-09-03T10:00:00-07:00')
    const res = await request(buildApp())
      .get('/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.operating.inflows.rentCollected).toBe(1150)
    expect(res.body.data.operating.inflows.total).toBe(1150)
    expect(res.body.data.depositsHeld).toBe(500)
  })

  it('/reports/owner-statements: collected 1,150 per property, deposits held 500', async () => {
    const f = await seedPortfolio()
    await seedIncomeRows(f, '2026-09-01', '2026-09-03T10:00:00-07:00')
    const res = await request(buildApp())
      .get('/api/books/reports/owner-statements?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    const st = res.body.data[0]
    expect(Number(st.properties[0].collected)).toBe(1150)
    expect(Number(st.properties[0].deposits_held)).toBe(500)
    expect(st.totalCollected).toBe(1150)
    expect(st.totalDepositsHeld).toBe(500)
  })

  it('/rent-roll: the unit collected 1,150 this month', async () => {
    const f = await seedPortfolio()
    const { rows: [{ d }] } = await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)
    await seedIncomeRows(f, d, new Date().toISOString())
    const res = await request(buildApp())
      .get('/api/books/rent-roll')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.units[0].collected_mtd)).toBe(1150)
    expect(res.body.data.totalCollected).toBe(1150)
  })
})

// ───────────────────────────────────────────────────────────────────
// S655: Books follows the landlord reports' "Money received" rule —
// money counts on the day it ARRIVED. Cash Flow is that same view.
// ───────────────────────────────────────────────────────────────────
describe('S655: Books money in, by the day it arrived', () => {
  async function leaseFor(f: PortfolioFixture): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,460,'month_to_month','active','2026-01-01') RETURNING id`, [f.unitAId, f.landlordAId])
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [r.rows[0].id, f.tenantAId])
    return r.rows[0].id
  }

  it("cash flow puts Todd's $920 in September with $460 as paid ahead", async () => {
    const f = await seedPortfolio()
    const leaseId = await leaseFor(f)
    // Sept 18: one $920 check — September's rent and $460 paid ahead for October.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, manual_method)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','RENT','2026-09-01','2026-09-18T13:04:41-07:00','check')`,
      [f.unitAId, leaseId, f.tenantAId, f.landlordAId])
    const credit = await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,460,460,'landlord','2026-09-18T13:04:41-07:00','2026-09-18T13:04:41-07:00') RETURNING id`,
      [leaseId, f.tenantAId])
    // Oct 1: the credit pays October's rent.
    const oct = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT','2026-10-01') RETURNING id`,
      [f.unitAId, leaseId, f.tenantAId, f.landlordAId])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,460,'2026-10-01','whole_bill','applied','2026-10-01T07:00:00-07:00')`,
      [credit.rows[0].id, oct.rows[0].id, leaseId])
    await db.query(`UPDATE payments SET status='settled', settled_at='2026-10-01T07:00:00-07:00' WHERE id=$1`, [oct.rows[0].id])

    const cf = async (start: string, end: string) => (await request(buildApp())
      .get(`/api/books/reports/cash-flow?startDate=${start}&endDate=${end}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    const sep = await cf('2026-09-01', '2026-09-30')
    expect(sep.operating.inflows.rentCollected).toBe(460)
    expect(sep.operating.inflows.paidAhead).toBe(460)
    expect(sep.operating.inflows.total).toBe(920)
    expect(sep.meta.note).toMatch(/day it arrived/)
    const oct1 = await cf('2026-10-01', '2026-10-31')
    expect(oct1.operating.inflows.rentCollected).toBe(0)
    expect(oct1.operating.inflows.paidAhead).toBe(0)
    // The P&L (Money received) agrees with the cash flow.
    const pl = (await request(buildApp()).get('/api/books/reports/pl?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    expect(pl.gamRentIncome).toBe(920)
    expect(pl.meta.basis.basis).toBe('received')
    const billed = (await request(buildApp()).get('/api/books/reports/pl?startDate=2026-10-01&endDate=2026-10-31&basis=billed')
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    expect(billed.gamRentIncome).toBe(460)
  })

  it('rent roll ignores paid future months', async () => {
    const f = await seedPortfolio()
    const { rows: [{ d, next }] } = await db.query<{ d: string; next: string }>(
      `SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d,
              (date_trunc('month', (now() AT TIME ZONE 'America/Phoenix')::date) + INTERVAL '1 month')::date::text AS next`)
    // This month's rent, and next month's paid early today.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,'rent',1500,'settled','RENT',$4::date,now()),
              ($1,$2,$3,'rent',1500,'settled','RENT',$5::date,now())`,
      [f.unitAId, f.tenantAId, f.landlordAId, d, next])
    for (const basis of ['received', 'billed']) {
      const res = await request(buildApp()).get(`/api/books/rent-roll?basis=${basis}`)
        .set('Authorization', `Bearer ${f.landlordAToken}`)
      expect(res.status).toBe(200)
      expect(Number(res.body.data.units[0].collected_mtd)).toBe(1500)
      expect(res.body.data.totalCollected).toBe(1500)
      expect(res.body.data.meta.basis.basis).toBe(basis)
    }
  })

  it('owner statements follow the switch: a bill paid late counts where the basis puts it', async () => {
    const f = await seedPortfolio()
    // August's rent paid Sept 2.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,'rent',1500,'settled','RENT','2026-08-01','2026-09-02T10:00:00-07:00')`,
      [f.unitAId, f.tenantAId, f.landlordAId])
    const st = async (basis: string, start: string, end: string) => (await request(buildApp())
      .get(`/api/books/reports/owner-statements?startDate=${start}&endDate=${end}&basis=${basis}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body
    expect((await st('received', '2026-09-01', '2026-09-30')).data[0].totalCollected).toBe(1500)
    expect((await st('received', '2026-08-01', '2026-08-31')).data[0].totalCollected).toBe(0)
    const billedAug = await st('billed', '2026-08-01', '2026-08-31')
    expect(billedAug.data[0].totalCollected).toBe(1500)
    expect(billedAug.meta.basis.label).toBe('Money billed')
  })

  // A move-out on Oct 15: $200 of rent swept to the $400 deposit and $100 of
  // cleaning — $300 kept, the rest refunded.
  async function moveOut(f: PortfolioFixture, o: { heldBy: 'landlord' | 'gam_escrow'; paidAhead?: number }) {
    const leaseId = await leaseFor(f)
    const fin = '2026-10-15T10:00:00-07:00'
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,400,400,'funded',$4)`, [f.unitAId, leaseId, f.tenantAId, o.heldBy])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',200,'paid_via_deposit','RENT','2026-10-01',$5::timestamptz)`,
      [f.unitAId, leaseId, f.tenantAId, f.landlordAId, fin])
    const pa = o.paidAhead ?? 0
    const dr = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, refund_amount, status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',200,300,$4,'sent_refund',$5::timestamptz) RETURNING id`,
      [leaseId, f.tenantAId, f.landlordAId, 400 + pa - 300, fin])
    if (pa > 0) {
      // Money paid ahead to the landlord in September joins the move-out pool.
      const c = await db.query<{ id: string }>(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
         VALUES ($1,$2,$3,$3,'landlord','2026-09-10T10:00:00-07:00','2026-09-10T10:00:00-07:00') RETURNING id`,
        [leaseId, f.tenantAId, pa])
      await db.query(
        `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
         VALUES ($1,$2,$3,$4,'2026-10-01','move_out','applied',$5::timestamptz,$5::timestamptz)`,
        [c.rows[0].id, dr.rows[0].id, leaseId, pa, fin])
    }
  }
  const cashFlowOct = async (f: PortfolioFixture) => (await request(buildApp())
    .get('/api/books/reports/cash-flow?startDate=2026-10-01&endDate=2026-10-31')
    .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data

  it('cash flow at move-out: a deposit the landlord already held and keeps is not new money', async () => {
    const f = await seedPortfolio()
    await moveOut(f, { heldBy: 'landlord' })
    const cf = await cashFlowOct(f)
    expect(cf.operating.inflows.rentCollected).toBe(0)
    expect(cf.operating.inflows.moveOut).toBe(0)
    expect(cf.operating.inflows.total).toBe(0)
    expect(cf.nonCash.keptAtMoveOut).toBe(300)
    // The P&L still counts the $300 kept (Money received).
    const pl = (await request(buildApp()).get('/api/books/reports/pl?startDate=2026-10-01&endDate=2026-10-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    expect(pl.gamRentIncome).toBe(300)
  })

  it('cash flow at move-out: a deposit GAM held in escrow arrives the day GAM pays the landlord its share', async () => {
    const f = await seedPortfolio()
    await moveOut(f, { heldBy: 'gam_escrow' })
    const cf = await cashFlowOct(f)
    expect(cf.operating.inflows.moveOut).toBe(300)
    expect(cf.operating.inflows.total).toBe(300)
    expect(cf.nonCash.keptAtMoveOut).toBe(0)
  })

  it('cash flow at move-out: paid-ahead money handed back is money going out', async () => {
    const f = await seedPortfolio()
    // $600 paid ahead in September (counted then); $300 is kept, so $300 of it goes back.
    await moveOut(f, { heldBy: 'landlord', paidAhead: 600 })
    const sep = (await request(buildApp()).get('/api/books/reports/cash-flow?startDate=2026-09-01&endDate=2026-09-30')
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    expect(sep.operating.inflows.paidAhead).toBe(600)
    const cf = await cashFlowOct(f)
    expect(cf.operating.inflows.moveOut).toBe(-300)
    expect(cf.nonCash.keptAtMoveOut).toBe(0)
  })

  // A renewal-chain move-out on Oct 15: $700 of rent left unpaid on the
  // PREVIOUS lease is swept to the $400 deposit held on the new lease (the
  // sweep reaches the whole chain); $100 of cleaning; the gap is $400.
  async function chainMoveOut(f: PortfolioFixture, heldBy: 'landlord' | 'gam_escrow') {
    const previous = await leaseFor(f)
    const current = await leaseFor(f)
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [previous])
    await db.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [current, previous])
    const fin = '2026-10-15T10:00:00-07:00'
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,400,400,'funded',$4)`, [f.unitAId, current, f.tenantAId, heldBy])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',700,'paid_via_deposit','RENT','2026-10-01',$5::timestamptz)`,
      [f.unitAId, previous, f.tenantAId, f.landlordAId, fin])
    const gap = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'fee',400,'pending','DEPOSIT','2026-10-15') RETURNING id`,
      [f.unitAId, current, f.tenantAId, f.landlordAId])
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5::timestamptz)`,
      [current, f.tenantAId, f.landlordAId, gap.rows[0].id, fin])
  }

  it('a renewal-chain move-out whose swept rent sits on the previous lease moves no cash when the landlord held the deposit (moveOut 0, kept 400)', async () => {
    const f = await seedPortfolio()
    await chainMoveOut(f, 'landlord')
    const cf = await cashFlowOct(f)
    expect(cf.operating.inflows.moveOut).toBe(0)       // was −300: no cash moved
    expect(cf.operating.inflows.total).toBe(0)
    expect(cf.nonCash.keptAtMoveOut).toBe(400)         // was 700: the pool only held $400
    const pl = (await request(buildApp()).get('/api/books/reports/pl?startDate=2026-10-01&endDate=2026-10-31')
      .set('Authorization', `Bearer ${f.landlordAToken}`)).body.data
    expect(pl.gamRentIncome).toBe(400)
  })

  it('a renewal-chain move-out with the deposit in GAM escrow: the landlord’s settlement arrives at move-out', async () => {
    const f = await seedPortfolio()
    await chainMoveOut(f, 'gam_escrow')
    const cf = await cashFlowOct(f)
    expect(cf.operating.inflows.moveOut).toBe(400)     // escrow 400 − refund 0, paid out at finalize
    expect(cf.nonCash.keptAtMoveOut).toBe(0)
  })
})

describe('S655: Books and a team member assigned to some properties (gam-audience-data-isolation)', () => {
  it('a park-2-only manager with books.view sees no park-1 money or tenants on /reports/pl, /reports/cash-flow, /reports/owner-statements or /rent-roll', async () => {
    const f = await seedPortfolio()
    const today = (await db.query<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d
    const at = `${today}T12:00:00-07:00`
    const c = await db.connect()
    let park2 = '', unit2 = ''
    try {
      // Park 1 (propertyA): $700 of rent, a tenant whose name and email must not leak.
      const lease1 = await seedLease(c, { unitId: f.unitAId, landlordId: f.landlordAId, rentAmount: 700 })
      await seedLeaseTenant(c, { leaseId: lease1, tenantId: f.tenantAId })
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',700,'settled','RENT',$5::date,$6::timestamptz)`,
        [f.unitAId, lease1, f.tenantAId, f.landlordAId, today, at])
      // Park 2: $300 of rent.
      park2 = await seedProperty(c, { landlordId: f.landlordAId, ownerUserId: f.landlordAUserId, managedByUserId: f.landlordAUserId })
      unit2 = await seedUnit(c, { propertyId: park2, landlordId: f.landlordAId, rentAmount: 300 })
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unit2])
      const tenant2 = await seedTenant(c)
      const lease2 = await seedLease(c, { unitId: unit2, landlordId: f.landlordAId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId: tenant2 })
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',300,'settled','RENT',$5::date,$6::timestamptz)`,
        [unit2, lease2, tenant2, f.landlordAId, today, at])
    } finally { c.release() }
    const park1Email = (await db.query<{ email: string }>(
      `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [f.tenantAId])).rows[0].email

    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const manager = async (scope: { parks: string[] } | 'all') => {
      const uid = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','property_manager','P','M') RETURNING id`,
        [`pm-${randomUUID()}@t.dev`])).rows[0].id
      await db.query(
        `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties) VALUES ($1,$2,$3::uuid[],$4)`,
        [uid, f.landlordAId, scope === 'all' ? [] : scope.parks, scope === 'all'])
      return sign({ userId: uid, role: 'property_manager', email: 'pm@t.dev', profileId: null,
                    landlordId: f.landlordAId, permissions: { 'books.view': true, 'payments.view_all': true } })
    }
    const as = (token: string) => (path: string) => request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)
    const range = `startDate=${today.slice(0, 8)}01&endDate=${today}`

    const pm = as(await manager({ parks: [park2] }))
    // The company documents: refused in plain words, with the next step.
    for (const path of [`/api/books/reports/pl?${range}`, `/api/books/reports/cash-flow?${range}`,
                        `/api/books/reports/owner-statements?${range}`]) {
      const refused = await pm(path)
      expect(refused.status).toBe(403)
      expect(refused.body.error).toMatch(/covers the whole company.*Ask the owner/)
      expect(JSON.stringify(refused.body)).not.toMatch(/700|1000/)
    }
    // The rent roll: park 2's unit and money only — no park-1 unit, tenant or email.
    const roll = (await pm('/api/books/rent-roll')).body.data
    expect(roll.units.map((u: any) => u.unit_id)).toEqual([unit2])
    expect(roll.totalCollected).toBe(300)
    expect(roll.totalExpected).toBe(300)
    expect(JSON.stringify(roll)).not.toContain(park1Email)

    // A manager with every property, and the owner, see the whole company.
    const all = as(await manager('all'))
    const plAll = await all(`/api/books/reports/pl?${range}`)
    expect(plAll.status).toBe(200)
    expect(plAll.body.data.gamPL.gross.total).toBe(1000)
    const owner = as(f.landlordAToken)
    expect((await owner(`/api/books/reports/cash-flow?${range}`)).body.data.operating.inflows.rentCollected).toBe(1000)
    const ownerRoll = (await owner('/api/books/rent-roll')).body.data
    expect(ownerRoll.units).toHaveLength(2)
    expect(ownerRoll.totalCollected).toBe(1000)
  })
})
