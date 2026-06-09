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
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
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
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      bkAToken:       sign({ userId: bk.rows[0].id, role: 'bookkeeper', email: 'bk@t.dev', profileId: bk.rows[0].id, permissions: { access_level: 'read_write' } }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedSettledPayment(f: PortfolioFixture, amount: number, dueDate = '2026-05-15') {
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
     VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT', $5)`,
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
