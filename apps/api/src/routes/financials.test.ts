/**
 * 10/11 (Nic) — the shared financial pages' totals count EVERY line.
 *
 * Bank activity lists the newest 1,000 bank lines and Payouts the newest 200
 * payouts and GAM charges. Their totals used to be added up from those lists,
 * so a busy month's money in and money out read low, and a GAM charge older
 * than the newest 200 that was still unpaid dropped out of "not yet taken".
 * The totals are now added up by the database over every line.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { financialsRouter, memoWithoutContact } from './financials'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/financials', financialsRouter)
  a.use(errorHandler)
  return a
}

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_financials'
})

async function owner() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const token = sign({ userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} })
    return { userId, landlordId, propertyId, token }
  } finally { c.release() }
}

describe('bank activity — money in and money out count every line in the days asked', () => {
  it('1,003 lines: the list is the newest 1,000, the totals are all of them', async () => {
    const o = await owner()
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, display_name) VALUES ($1, 'Operating') RETURNING id`, [o.landlordId])).rows[0].id
    // 1,000 newest lines of $2 in; an older $500 deposit and two older withdrawals.
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       SELECT $1, $2, 'new-' || g, DATE '2026-09-20', 2, 'SQUARE PAYOUT', 'needs_review' FROM generate_series(1, 1000) g`,
      [conn, o.landlordId])
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1, $2, 'old-in', '2026-09-02', 500, 'MOBILE DEPOSIT', 'needs_review'),
              ($1, $2, 'old-out-1', '2026-09-01', -40, 'HOME DEPOT #123', 'needs_review'),
              ($1, $2, 'old-out-2', '2026-09-01', -60.25, 'APS ELECTRIC', 'needs_review')`,
      [conn, o.landlordId])
    const r = await request(app()).get('/api/financials/bank-activity?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${o.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.transactions).toHaveLength(1000)
    expect(r.body.data.transactionCount).toBe(1003)
    expect(r.body.data.moneyIn).toBe(2500)
    expect(r.body.data.moneyOut).toBe(100.25)
    // Lines outside the days asked count nowhere.
    const sept1 = await request(app()).get('/api/financials/bank-activity?from=2026-09-01&to=2026-09-01').set('Authorization', `Bearer ${o.token}`)
    expect(sept1.body.data).toMatchObject({ transactionCount: 2, moneyIn: 0, moneyOut: 100.25 })
  })
})

describe('payouts — the totals count every payout and every GAM charge', () => {
  it('an unpaid GAM charge older than the newest 200 stays in "not yet taken"', async () => {
    const o = await owner()
    // 200 newer payouts of $10, an older $1,000 that landed and an older $300 still on its way.
    await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, created_at)
       SELECT $1, $2, 10, 'settled', 'auto_friday', TIMESTAMPTZ '2026-09-01T12:00:00Z' + g * interval '1 minute'
         FROM generate_series(1, 200) g`, [o.userId, o.landlordId])
    await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, created_at)
       VALUES ($1, $2, 1000, 'settled', 'auto_friday', '2025-01-03T12:00:00Z'),
              ($1, $2, 300, 'processing', 'auto_friday', '2025-01-02T12:00:00Z')`, [o.userId, o.landlordId])
    // 200 newer GAM charges taken in full; an older $50 never taken and an older $30 with $10 taken.
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, collected_at, source_type, created_at)
       SELECT $1, $2, 'subscription', 24, 24, now(), 'platform_fee', TIMESTAMPTZ '2026-09-01T12:00:00Z' + g * interval '1 minute'
         FROM generate_series(1, 200) g`, [o.landlordId, o.propertyId])
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, source_type, created_at)
       VALUES ($1, $2, 'subscription', 50, 0, 'platform_fee', '2025-02-01T12:00:00Z'),
              ($1, $2, 'subscription', 30, 10, 'platform_fee', '2025-03-01T12:00:00Z')`, [o.landlordId, o.propertyId])
    const r = await request(app()).get('/api/financials/payouts').set('Authorization', `Bearer ${o.token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.payouts).toHaveLength(200)
    expect(r.body.data.gamCharges).toHaveLength(200)
    expect(r.body.data.totalSettled).toBe(3000)
    expect(r.body.data.totalOnTheWay).toBe(300)
    expect(r.body.data.payoutCount).toBe(202)   // the page says: the newest 200 of 202
    expect(r.body.data.gamChargesOutstanding).toBe(70)
  })
})

describe("a bookkeeper's copy of a bank memo keeps the names and loses the contact details", () => {
  it.each([
    ['ZELLE FROM JANE DOE 4805551234', 'ZELLE FROM JANE DOE (phone hidden)'],
    ['ZELLE TO PAT (480) 555-1234 pat.lee@example.com', 'ZELLE TO PAT (phone hidden) (email hidden)'],
    ['VENMO +1 480.555.1234', 'VENMO (phone hidden)'],
    ['Zelle payment to Jane Doe JD.Rentals+mv@mail.example.co', 'Zelle payment to Jane Doe (email hidden)'],
    ['ZELLE TO JANE JANEDOE@GMAI', 'ZELLE TO JANE (email hidden)'],          // cut off by the bank
    ['ZELLE FROM JANEDOE4805551234', 'ZELLE FROM JANEDOE(phone hidden)'],     // letters right before it
    ['HOME DEPOT #123', 'HOME DEPOT #123'],
    ['CHECK 1042', 'CHECK 1042'],
    ['ACH CONF 123456789012', 'ACH CONF 123456789012'],
    ['ORIG CO ID 1234567890', 'ORIG CO ID 1234567890'],
  ])('%s', (memo, shown) => {
    expect(memoWithoutContact(memo)).toBe(shown)
  })
})

describe('Money in — owner contributions and sale proceeds stay in view, beside the total (10/11)', () => {
  it('they are not income, so not in the total, and not dropped from the page either', async () => {
    const o = await owner()
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1,$2,'laundry',25,'2026-09-07'), ($1,$2,'owner_contribution',5000,'2026-09-08'),
              ($1,$2,'sale_proceeds',1200,'2026-09-09')`, [o.landlordId, o.propertyId])
    const r = await request(app()).get('/api/financials/income?from=2026-09-01&to=2026-09-30').set('Authorization', `Bearer ${o.token}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.total).toBe(25)
    expect(r.body.data.besideTotal).toEqual([
      { key: 'ownerContributions', label: 'Owner contributions', amount: 5000 },
      { key: 'saleProceeds', label: 'Sale proceeds', amount: 1200 },
    ])
    const sept = r.body.data.months.find((m: any) => m.month === '2026-09')
    expect(sept.total).toBe(25)
    expect(sept.besideTotal.map((b: any) => b.amount)).toEqual([5000, 1200])
  })
})
