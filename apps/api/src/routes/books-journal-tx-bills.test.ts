/**
 * books.ts slice 4 — S386. Continues the books.ts test arc.
 *
 * Covered routes (10):
 *   - GET   /api/books/journal
 *   - GET   /api/books/journal/:id
 *   - POST  /api/books/journal
 *   - POST  /api/books/journal/:id/void
 *   - GET   /api/books/transactions
 *   - POST  /api/books/transactions
 *   - PATCH /api/books/transactions/:id/reconcile
 *   - GET   /api/books/bills
 *   - POST  /api/books/bills
 *   - POST  /api/books/bills/:id/pay
 *
 * After this slice: 34 of 40 books.ts routes covered (85%).
 * Slice 5 (reports — pl/balance-sheet/cash-flow/owner/tax/rent-roll,
 * ~6 routes) closes the books arc.
 *
 * Production bugs fixed in this slice (3):
 *   - **POST /journal**: line accountId NOT scope-validated. Landlord
 *     could pass another landlord's account_id; the per-line
 *     `UPDATE books_accounts SET balance = balance + $1 WHERE id=$2`
 *     would mutate that other landlord's financial state.
 *     **HIGH severity — cross-tenant financial corruption.**
 *   - **POST /transactions**: `accountId` from body, no scope check.
 *     Cross-tenant ref pollution; GET would surface wrong account_name
 *     via the LEFT JOIN.
 *   - **POST /bills**: `vendorId` from body, no scope check. The
 *     follow-on `UPDATE books_vendors SET ap_balance = ap_balance + $1
 *     WHERE id=$2` would bump another landlord's AP balance.
 *
 * Same fix pattern as S385: validate id belongs to caller's
 * landlord for non-admin callers. Admin retains cross-landlord
 * authority.
 *
 * Production finding flagged (NOT fixed):
 *   - POST /bills/:id/pay does NOT cap overpayment. A payment
 *     amount > bill remaining results in `amount_paid > amount`
 *     and `ytd_paid` over-credited (ap_balance is floored at 0
 *     via GREATEST(0, ...)). Probably a product call on whether
 *     to allow over-pay (advances) or reject.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_jtb'
})

interface PortfolioFixture {
  landlordAId:     string
  landlordBId:     string
  adminToken:      string
  landlordAToken:  string
  landlordBToken:  string
  // Pre-seeded accounts on each landlord (asset DR + income CR types
  // so journal posts can balance).
  accountAAssetId:  string
  accountAIncomeId: string
  accountBAssetId:  string
  vendorAId:       string
  vendorBId:       string
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
    // Pre-seed accounts so journal posts can use them.
    const aAsset = await client.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'A Bank', 'asset') RETURNING id`, [aId])
    const aIncome = await client.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '4010', 'A Rent', 'income') RETURNING id`, [aId])
    const bAsset = await client.query<{ id: string }>(
      `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '1010', 'B Bank', 'asset') RETURNING id`, [bId])
    const aVendor = await client.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'A Vendor') RETURNING id`, [aId])
    const bVendor = await client.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'B Vendor') RETURNING id`, [bId])
    await client.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAId: aId, landlordBId: bId,
      accountAAssetId:  aAsset.rows[0].id,
      accountAIncomeId: aIncome.rows[0].id,
      accountBAssetId:  bAsset.rows[0].id,
      vendorAId: aVendor.rows[0].id,
      vendorBId: bVendor.rows[0].id,
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// ───────────────────────────────────────────────────────────────────
// JOURNAL ENTRIES
// ───────────────────────────────────────────────────────────────────

describe('GET /journal', () => {
  it('landlord-scoped + line_count populated', async () => {
    const f = await seedPortfolio()
    const e = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (landlord_id, date, description) VALUES ($1, '2026-05-01', 'A entry') RETURNING id`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit) VALUES
        ($1, $2, 100, 0), ($1, $3, 0, 100)`,
      [e.rows[0].id, f.accountAAssetId, f.accountAIncomeId])
    // Other landlord — should not appear
    await db.query(
      `INSERT INTO journal_entries (landlord_id, date, description) VALUES ($1, '2026-05-01', 'B entry')`,
      [f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].description).toBe('A entry')
    expect(Number(res.body.data[0].line_count)).toBe(2)
  })
})

describe('GET /journal/:id', () => {
  it('unknown id → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .get(`/api/books/journal/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord blocked → 404', async () => {
    const f = await seedPortfolio()
    const e = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (landlord_id, date, description) VALUES ($1, '2026-05-01', 'B') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .get(`/api/books/journal/${e.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns entry + lines joined to account code/name', async () => {
    const f = await seedPortfolio()
    const e = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (landlord_id, date, description) VALUES ($1, '2026-05-01', 'Test') RETURNING id`,
      [f.landlordAId])
    await db.query(
      `INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 100, 0)`,
      [e.rows[0].id, f.accountAAssetId])
    const res = await request(buildApp())
      .get(`/api/books/journal/${e.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.lines[0].code).toBe('1010')
    expect(res.body.data.lines[0].account_name).toBe('A Bank')
  })
})

describe('POST /journal — double-entry + S386 scope fix', () => {
  it('missing date/description/lines → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/required/i)
  })

  it('debits != credits → 400 out-of-balance', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Imbalanced',
        lines: [
          { accountId: f.accountAAssetId,  debit: 100, credit: 0 },
          { accountId: f.accountAIncomeId, debit: 0,   credit: 90 },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/out of balance/i)
  })

  it('zero-amount entry → 400 must have debit and credit', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Zero',
        lines: [
          { accountId: f.accountAAssetId, debit: 0, credit: 0 },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least one debit/i)
  })

  it('missing accountId on a line → 400 each line requires accountId (S386 validation order)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Missing acct',
        lines: [
          { accountId: f.accountAAssetId,  debit: 100, credit: 0 },
          {                                 debit: 0,   credit: 100 },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/each line requires accountId/i)
  })

  it('S386 fix: line referencing another landlord account → 403, no rows written', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Cross-tenant attempt',
        lines: [
          { accountId: f.accountAAssetId,  debit: 100, credit: 0 },
          { accountId: f.accountBAssetId,  debit: 0,   credit: 100 },  // landlord B account
        ],
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not in your chart/i)
    // Confirm: no journal_entries row created, no balance changes on B
    const entries = await db.query(`SELECT id FROM journal_entries`)
    expect(entries.rows).toHaveLength(0)
    const bBank = await db.query<{ balance: string }>(
      `SELECT balance FROM books_accounts WHERE id=$1`, [f.accountBAssetId])
    expect(Number(bBank.rows[0].balance)).toBe(0)
  })

  it('happy: posts balanced entry; updates account balances; returns lines', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Rent received',
        lines: [
          { accountId: f.accountAAssetId,  debit: 1500, credit: 0 },
          { accountId: f.accountAIncomeId, debit: 0,    credit: 1500 },
        ],
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.total_debits)).toBe(1500)
    expect(Number(res.body.data.total_credits)).toBe(1500)
    expect(res.body.data.lines).toHaveLength(2)
    // Asset (debit side): balance += 1500
    const asset = await db.query<{ balance: string }>(
      `SELECT balance FROM books_accounts WHERE id=$1`, [f.accountAAssetId])
    expect(Number(asset.rows[0].balance)).toBe(1500)
    // Income (credit side): balance -= 1500 (debit - credit = -1500)
    const income = await db.query<{ balance: string }>(
      `SELECT balance FROM books_accounts WHERE id=$1`, [f.accountAIncomeId])
    expect(Number(income.rows[0].balance)).toBe(-1500)
  })
})

describe('POST /journal/:id/void', () => {
  it('unknown → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/books/journal/${randomUUID()}/void`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('happy: voiding reverses account balances', async () => {
    const f = await seedPortfolio()
    // Use the route to post an entry so account balances reflect it.
    const post = await request(buildApp())
      .post('/api/books/journal')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'To void',
        lines: [
          { accountId: f.accountAAssetId,  debit: 500, credit: 0 },
          { accountId: f.accountAIncomeId, debit: 0,   credit: 500 },
        ],
      })
    const entryId = post.body.data.id

    const res = await request(buildApp())
      .post(`/api/books/journal/${entryId}/void`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    const asset = await db.query<{ balance: string }>(
      `SELECT balance FROM books_accounts WHERE id=$1`, [f.accountAAssetId])
    expect(Number(asset.rows[0].balance)).toBe(0)  // reversed
    const income = await db.query<{ balance: string }>(
      `SELECT balance FROM books_accounts WHERE id=$1`, [f.accountAIncomeId])
    expect(Number(income.rows[0].balance)).toBe(0)
  })

  it('already-voided → 400', async () => {
    const f = await seedPortfolio()
    const e = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (landlord_id, date, description, status) VALUES ($1, '2026-05-01', 'Pre-voided', 'voided') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/journal/${e.rows[0].id}/void`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already voided/i)
  })
})

// ───────────────────────────────────────────────────────────────────
// TRANSACTIONS
// ───────────────────────────────────────────────────────────────────

describe('GET /transactions', () => {
  it('landlord-scoped + supports type filter', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type) VALUES
        ($1, '2026-05-01', 'rent A', 1000, 'income'),
        ($1, '2026-05-02', 'expense A', 200, 'expense'),
        ($2, '2026-05-01', 'rent B', 1500, 'income')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/transactions?type=income')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].description).toBe('rent A')
  })
})

describe('POST /transactions — S386 scope fix', () => {
  it('missing fields → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/transactions')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01' })
    expect(res.status).toBe(400)
  })

  it('S386 fix: accountId from another landlord → 403, no row written', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/transactions')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'cross-tenant', amount: 100, type: 'income',
        accountId: f.accountBAssetId,
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not in your chart/i)
    const txs = await db.query(`SELECT id FROM books_transactions`)
    expect(txs.rows).toHaveLength(0)
  })

  it('happy: creates tx with valid accountId', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/transactions')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Rent deposit', amount: 1500, type: 'income',
        accountId: f.accountAAssetId,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.account_id).toBe(f.accountAAssetId)
    expect(Number(res.body.data.amount)).toBe(1500)
  })
})

describe('PATCH /transactions/:id/reconcile', () => {
  it('cross-landlord blocked → 404', async () => {
    const f = await seedPortfolio()
    const tx = await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type) VALUES
        ($1, '2026-05-01', 'B tx', 100, 'income') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/transactions/${tx.rows[0].id}/reconcile`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(404)
  })

  it('happy: flips reconciled to TRUE + stamps reconciled_at', async () => {
    const f = await seedPortfolio()
    const tx = await db.query<{ id: string }>(
      `INSERT INTO books_transactions (landlord_id, date, description, amount, type) VALUES
        ($1, '2026-05-01', 'A tx', 100, 'income') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/transactions/${tx.rows[0].id}/reconcile`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.reconciled).toBe(true)
    expect(res.body.data.reconciled_at).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────
// BILLS & AP
// ───────────────────────────────────────────────────────────────────

describe('GET /bills', () => {
  it('landlord-scoped + vendor_name joined', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_bills (landlord_id, vendor_id, date, description, amount) VALUES
        ($1, $2, '2026-05-01', 'A bill', 500)`,
      [f.landlordAId, f.vendorAId])
    await db.query(
      `INSERT INTO books_bills (landlord_id, vendor_id, date, description, amount) VALUES
        ($1, $2, '2026-05-01', 'B bill', 300)`,
      [f.landlordBId, f.vendorBId])
    const res = await request(buildApp())
      .get('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].description).toBe('A bill')
    expect(res.body.data[0].vendor_name).toBe('A Vendor')
  })
})

describe('POST /bills — S386 scope fix', () => {
  it('missing fields → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01' })
    expect(res.status).toBe(400)
  })

  it('S386 fix: vendorId from another landlord → 403; A vendor ap_balance untouched', async () => {
    const f = await seedPortfolio()
    const bBalanceBefore = await db.query<{ ap_balance: string }>(
      `SELECT ap_balance FROM books_vendors WHERE id=$1`, [f.vendorBId])
    const res = await request(buildApp())
      .post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'cross-tenant bill', amount: 500,
        vendorId: f.vendorBId,  // landlord B vendor
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not in your books/i)
    const bBalanceAfter = await db.query<{ ap_balance: string }>(
      `SELECT ap_balance FROM books_vendors WHERE id=$1`, [f.vendorBId])
    expect(bBalanceAfter.rows[0].ap_balance).toBe(bBalanceBefore.rows[0].ap_balance)
  })

  it('happy: creates bill; bumps vendor ap_balance by amount', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        date: '2026-05-01', description: 'Plumbing', amount: 500,
        vendorId: f.vendorAId,
      })
    expect(res.status).toBe(201)
    const vendor = await db.query<{ ap_balance: string }>(
      `SELECT ap_balance FROM books_vendors WHERE id=$1`, [f.vendorAId])
    expect(Number(vendor.rows[0].ap_balance)).toBe(500)
  })
})

describe('POST /bills/:id/pay', () => {
  it('unknown bill → 404', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post(`/api/books/bills/${randomUUID()}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 100 })
    expect(res.status).toBe(404)
  })

  it('already-paid → 400', async () => {
    const f = await seedPortfolio()
    const bill = await db.query<{ id: string }>(
      `INSERT INTO books_bills (landlord_id, vendor_id, date, description, amount, amount_paid, status)
       VALUES ($1, $2, '2026-05-01', 'Done', 100, 100, 'paid') RETURNING id`,
      [f.landlordAId, f.vendorAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 10 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already paid/i)
  })

  it('partial pay: status=partial; amount_paid bumped; vendor balances adjusted', async () => {
    const f = await seedPortfolio()
    // Seed bill via the route so vendor.ap_balance starts at 500.
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 500, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 200 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('partial')
    expect(Number(res.body.data.amount_paid)).toBe(200)
    const vendor = await db.query<{ ap_balance: string; ytd_paid: string }>(
      `SELECT ap_balance, ytd_paid FROM books_vendors WHERE id=$1`, [f.vendorAId])
    expect(Number(vendor.rows[0].ap_balance)).toBe(300)  // 500 - 200
    expect(Number(vendor.rows[0].ytd_paid)).toBe(200)
  })

  it('full pay (no explicit amount): pays remaining; status=paid; paid_at stamped', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 500, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({})  // no amount → defaults to remaining
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paid')
    expect(res.body.data.paid_at).not.toBeNull()
    expect(Number(res.body.data.amount_paid)).toBe(500)
  })

  // ── S413 (S386): two-phase overpayment confirmation ─────────

  it('S413 fix: overpayment without acceptOverpayment → 409 + requiresOverpaymentConfirm flag', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 100, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 150 })  // $50 over
    expect(res.status).toBe(409)
    expect(res.body.requiresOverpaymentConfirm).toBe(true)
    expect(Number(res.body.billRemaining)).toBe(100)
    expect(Number(res.body.overpaymentAmount)).toBe(50)
    expect(res.body.vendorId).toBe(f.vendorAId)
    // Verify NO state change on the 409.
    const after = await db.query<{ amount_paid: string; status: string }>(
      `SELECT amount_paid, status FROM books_bills WHERE id=$1`, [bill.rows[0].id])
    expect(Number(after.rows[0].amount_paid)).toBe(0)
    expect(after.rows[0].status).not.toBe('paid')
    const vendor = await db.query<{ credit_balance: string }>(
      `SELECT credit_balance FROM books_vendors WHERE id=$1`, [f.vendorAId])
    expect(Number(vendor.rows[0].credit_balance)).toBe(0)
  })

  it('S413 fix: overpayment with acceptOverpayment=true → bill caps at amount + excess to vendor credit_balance', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 100, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 150, acceptOverpayment: true })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paid')
    expect(Number(res.body.data.amount_paid)).toBe(100)  // CAPPED at amount
    expect(Number(res.body.overpaymentCreditRecorded)).toBe(50)
    // Vendor accounting: ytd_paid only counts what hit the bill; the
    // excess flows to credit_balance.
    const vendor = await db.query<{ ap_balance: string; ytd_paid: string; credit_balance: string }>(
      `SELECT ap_balance, ytd_paid, credit_balance FROM books_vendors WHERE id=$1`,
      [f.vendorAId])
    expect(Number(vendor.rows[0].ytd_paid)).toBe(100)
    expect(Number(vendor.rows[0].credit_balance)).toBe(50)
  })

  it('S413: exact amount (no overpayment) → status=paid, credit_balance untouched', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 100, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 100 })  // exact, no overpayment
    expect(res.status).toBe(200)
    expect(Number(res.body.overpaymentCreditRecorded)).toBe(0)
    const vendor = await db.query<{ credit_balance: string }>(
      `SELECT credit_balance FROM books_vendors WHERE id=$1`, [f.vendorAId])
    expect(Number(vendor.rows[0].credit_balance)).toBe(0)
  })

  it('S413: tiny rounding (<= $0.01) does NOT trigger 409 (floating-point tolerance)', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 100, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 100.005 })  // 0.5 cent over — within tolerance
    expect(res.status).toBe(200)
  })

  it('S413: subsequent payment after partial does not double-count credit', async () => {
    const f = await seedPortfolio()
    await request(buildApp()).post('/api/books/bills')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ date: '2026-05-01', description: 'Bill', amount: 100, vendorId: f.vendorAId })
    const bill = await db.query<{ id: string }>(
      `SELECT id FROM books_bills WHERE landlord_id=$1 LIMIT 1`, [f.landlordAId])
    // First: partial $60
    await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 60 })
    // Second: $80 (would be $40 over the remaining $40)
    const res = await request(buildApp())
      .post(`/api/books/bills/${bill.rows[0].id}/pay`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ amount: 80, acceptOverpayment: true })
    expect(res.status).toBe(200)
    expect(Number(res.body.overpaymentCreditRecorded)).toBe(40)
    const vendor = await db.query<{ ytd_paid: string; credit_balance: string }>(
      `SELECT ytd_paid, credit_balance FROM books_vendors WHERE id=$1`, [f.vendorAId])
    expect(Number(vendor.rows[0].ytd_paid)).toBe(100)  // $60 + $40, NOT $140
    expect(Number(vendor.rows[0].credit_balance)).toBe(40)
  })
})
