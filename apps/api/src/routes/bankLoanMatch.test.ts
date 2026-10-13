/**
 * 10/12 (Nic) — GAM Books integrate: a bank line is the loan payment or the
 * loan's money arriving, never an expense or income of its own.
 *
 *   Nic 10/12: "loans/mortgages (principal / interest / escrow per payment)
 *   … ARE IN THIS BUILD"; L5: money out is ONE record.
 *
 * The Bank page's "What did this pay?" panel (routes/bankFeed match-record,
 * services/bankMoneyOut) offers the company's loans beside its bills; matching
 * one makes (or links) the loan payment through services/booksVendorsLoans
 * matchLoanPaymentForBankLine, Undo takes it back, and the loan's postings
 * move the bank on the bank's day (services/ledgerProjectors/loansAssets).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { errorHandler } from '../middleware/errorHandler'
import { bankFeedRouter } from './bankFeed'
import { projectLoan, projectLoanPayment } from '../services/ledgerProjectors/loansAssets'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_bank_loan_match'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/bank-feed', bankFeedRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, SECRET, { expiresIn: '1h' })
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` })

interface Co { landlordId: string; propertyId: string; connectionId: string; owner: string; bk: string; bkId: string }

async function company(moneyIn: 'any' | 'after_not_rent' | 'never' = 'after_not_rent'): Promise<Co> {
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET books_start_date = '2026-01-01' WHERE id = $1`, [landlordId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })
    const connectionId = (await c.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
      [landlordId])).rows[0].id
    const bkId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bea', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await c.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide, money_in_filing)
       VALUES ($1, $2, 'read_write', $3, TRUE, $4)`, [bkId, landlordId, [propertyId], moneyIn])
    return {
      landlordId, propertyId, connectionId, bkId,
      owner: sign({ userId: ownerId, role: 'landlord', email: 'o@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      bk: sign({ userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId, permissions: { access_level: 'read_write' } }),
    }
  } finally { c.release() }
}

async function line(co: Co, amount: number, day: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
     VALUES ($1, $2, $3, $4, $5, 'FIRST BANK MTG', 'FIRST BANK', 'needs_review', 'posted') RETURNING id`,
    [co.connectionId, co.landlordId, randomUUID(), day, amount.toFixed(2)])).rows[0].id
}

async function loan(co: Co, o: { start?: string; amount?: number; payment?: number; escrow?: number } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_loans (landlord_id, property_id, name, lender_name, original_amount, annual_rate, start_date,
                              payment_amount, escrow_amount, funded_to, funded_bank_connection_id)
     VALUES ($1, $2, 'Park mortgage', 'First Bank', $3, 6, $4, $5, $6, 'bank', $7) RETURNING id`,
    [co.landlordId, co.propertyId, o.amount ?? 120000, o.start ?? '2026-02-01', o.payment ?? 1200, o.escrow ?? 200, co.connectionId])).rows[0].id
}

/** Every line of a projector's postings as [day, kind, role, debit, credit] in cents. */
function flat(ps: any[]): Array<[string, string, string, number, number]> {
  return ps.flatMap(p => p.lines.map((l: any) => [p.intendedDate, p.postingKind ?? 'post', l.role, l.debitCents ?? 0, l.creditCents ?? 0]))
}

beforeEach(async () => { await cleanupAllSchema() })

describe('a money-out line is a loan payment', () => {
  it('offered with GAM\'s split; matched with the lender\'s split, the payment names the line; Undo voids it and the line is back in review', async () => {
    const co = await company()
    const l = await loan(co)
    const t = await line(co, -1200, '2026-03-02')
    const offered = await request(app()).get(`/api/bank-feed/transactions/${t}/matches`).set(as(co.owner))
    expect(offered.status).toBe(200)
    const rec = offered.body.data.records.find((r: any) => r.kind === 'loan_payment')
    expect(rec).toMatchObject({ id: l, amount: 1200 })
    expect(rec.split.principalCents + rec.split.interestCents + rec.split.escrowCents).toBe(120000)
    // Parts that do not add up to the line are refused.
    const bad = await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.bk))
      .send({ kind: 'loan_payment', recordId: l, split: { principalCents: 50000, interestCents: 50000, escrowCents: 0 } })
    expect(bad.status).toBe(400)
    // A bookkeeper matches money going out (L19), with the lender's statement's split.
    const ok = await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.bk))
      .send({ kind: 'loan_payment', recordId: l, split: { principalCents: 40000, interestCents: 60000, escrowCents: 20000 } })
    expect(ok.status).toBe(200)
    const p = (await db.query(`SELECT id, paid_on::text AS paid_on, principal::float, interest::float, escrow::float, source, method
                                 FROM books_loan_payments WHERE bank_transaction_id = $1 AND voided_at IS NULL`, [t])).rows
    expect(p).toEqual([expect.objectContaining({ paid_on: '2026-03-02', principal: 400, interest: 600, escrow: 200, source: 'bank_line', method: 'bank' })])
    const listed = (await request(app()).get(`/api/bank-feed/transactions?lineId=${t}`).set(as(co.owner))).body.data[0]
    expect(listed).toMatchObject({ status: 'matched', out_match_kind: 'loan_payment', out_match_loan_name: 'Park mortgage' })
    // Posted on the line's day straight from the bank: principal, interest, escrow.
    const c = await db.connect()
    try {
      expect(flat(await projectLoanPayment(c, p[0].id)).filter(x => x[2] !== 'clearing'))
        .toEqual(expect.arrayContaining([
          ['2026-03-02', 'post', 'mortgage_payable', 40000, 0],
          ['2026-03-02', 'post', 'mortgage_interest', 60000, 0],
          ['2026-03-02', 'post', 'loan_escrow', 20000, 0],
          ['2026-03-02', 'post', 'bank_checking', 0, 120000],
        ]))
    } finally { c.release() }
    // Undo: the payment made from the line is voided (kept); the line is back in review.
    const undo = await request(app()).post(`/api/bank-feed/transactions/${t}/undo-filing`).set(as(co.owner)).send({})
    expect(undo.status).toBe(200)
    expect((await db.query(`SELECT voided_at IS NOT NULL AS v FROM books_loan_payments WHERE id = $1`, [p[0].id])).rows[0].v).toBe(true)
    expect((await db.query(`SELECT status, matched_kind FROM bank_transactions WHERE id = $1`, [t])).rows[0])
      .toEqual({ status: 'needs_review', matched_kind: null })
  })

  it('a payment typed first on another day is linked, not made twice; it sits in Outstanding checks until the bank\'s day; Undo only unlinks it', async () => {
    const co = await company()
    const l = await loan(co)
    const typed = (await db.query<{ id: string }>(
      `INSERT INTO books_loan_payments (loan_id, landlord_id, paid_on, amount, principal, interest, escrow, method, bank_connection_id)
       VALUES ($1, $2, '2026-03-01', 1200, 400, 600, 200, 'bank', $3) RETURNING id`, [l, co.landlordId, co.connectionId])).rows[0].id
    const t = await line(co, -1200, '2026-03-03')
    const r = await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.owner)).send({ kind: 'loan_payment', recordId: l })
    expect(r.status).toBe(200)
    expect((await db.query(`SELECT count(*)::int AS n FROM books_loan_payments WHERE loan_id = $1`, [l])).rows[0].n).toBe(1)
    expect((await db.query(`SELECT bank_transaction_id FROM books_loan_payments WHERE id = $1`, [typed])).rows[0].bank_transaction_id).toBe(t)
    const c = await db.connect()
    try {
      const lines = flat(await projectLoanPayment(c, typed)).filter(x => x[2] !== 'clearing')
      expect(lines).toEqual(expect.arrayContaining([
        ['2026-03-01', 'post', 'outstanding_checks', 0, 120000],
        ['2026-03-03', 'bank_clear', 'outstanding_checks', 120000, 0],
        ['2026-03-03', 'bank_clear', 'bank_checking', 0, 120000],
      ]))
      // Outstanding checks nets to nothing once the bank paid it.
      expect(lines.filter(x => x[2] === 'outstanding_checks').reduce((s, x) => s + x[3] - x[4], 0)).toBe(0)
    } finally { c.release() }
    await request(app()).post(`/api/bank-feed/transactions/${t}/undo-filing`).set(as(co.owner)).send({}).expect(200)
    expect((await db.query(`SELECT voided_at, bank_transaction_id FROM books_loan_payments WHERE id = $1`, [typed])).rows[0])
      .toEqual({ voided_at: null, bank_transaction_id: null })
  })
})

describe('a money-in line is a loan\'s money arriving', () => {
  it('flagged on the list, offered, matched to the loan (dated the bank\'s day); a bookkeeper follows the owner\'s money-in choice', async () => {
    const co = await company('never')
    const l = await loan(co, { start: '2026-02-01', amount: 50000 })
    const t = await line(co, 50000, '2026-02-03')
    const listed = (await request(app()).get(`/api/bank-feed/transactions?lineId=${t}`).set(as(co.owner))).body.data[0]
    expect(listed.loan_funding_fits).toBe(true)
    const offered = await request(app()).get(`/api/bank-feed/transactions/${t}/matches`).set(as(co.owner))
    expect(offered.body.data.records).toEqual([expect.objectContaining({ kind: 'loan_funding', id: l, amount: 50000 })])
    // L19: this bookkeeper may file no money coming in.
    expect((await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.bk))
      .send({ kind: 'loan_funding', recordId: l })).status).toBe(403)
    // A split is only for a loan payment.
    expect((await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.owner))
      .send({ kind: 'loan_funding', recordId: l, split: { principalCents: 1, interestCents: 0, escrowCents: 0 } })).status).toBe(400)
    expect((await request(app()).post(`/api/bank-feed/transactions/${t}/match-record`).set(as(co.owner))
      .send({ kind: 'loan_funding', recordId: l })).status).toBe(200)
    expect((await db.query(`SELECT funded_bank_transaction_id FROM books_loans WHERE id = $1`, [l])).rows[0].funded_bank_transaction_id).toBe(t)
    const after = (await request(app()).get(`/api/bank-feed/transactions?lineId=${t}`).set(as(co.owner))).body.data[0]
    expect(after).toMatchObject({ status: 'matched', out_match_kind: 'loan_funding', out_match_loan_name: 'Park mortgage', loan_funding_fits: false })
    const c = await db.connect()
    try {
      const ps = await projectLoan(c, l)
      expect(ps.map(p => p.intendedDate)).toEqual(['2026-02-03'])
    } finally { c.release() }
    // Money going out is never matched as a loan's money arriving.
    const out = await line(co, -50000, '2026-02-03')
    expect((await request(app()).post(`/api/bank-feed/transactions/${out}/match-record`).set(as(co.owner))
      .send({ kind: 'loan_funding', recordId: l })).status).toBe(409)
    // Undo unlinks the loan; the deposit is back in review.
    await request(app()).post(`/api/bank-feed/transactions/${t}/undo-filing`).set(as(co.owner)).send({}).expect(200)
    expect((await db.query(`SELECT funded_bank_transaction_id FROM books_loans WHERE id = $1`, [l])).rows[0].funded_bank_transaction_id).toBeNull()
  })
})
