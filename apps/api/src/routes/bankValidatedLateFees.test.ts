/**
 * 10/6 (Nic, "Yes, build it") — when the bank shows the deposit, the bank's
 * date decides. NIC'S CONFIRMED TABLE:
 *
 *   | Situation                                   | Late fee                         | Payment history            |
 *   | Bank line MATCHED to the bill               | the bank's date decides; a fee   | counts from that day — ON  |
 *   |   (a tenant's report: the next-business-day | charged after it is ZEROED       | TIME if on time            |
 *   |   rule decides the day)                     |                                  |                            |
 *   | Onboarding month, logged by hand            | the landlord MAY delete it       | clean if deleted           |
 *   | Logged by hand, no bank line                | CREDITED against the bill        | LATE                       |
 *
 *   "If it was deposited on the 3rd, and the landlord chose to log it on the
 *    5th or the 6th, we're not going to just waive the late fee and still show
 *    that they paid late. It's determined by the matching transaction from the
 *    bank log. The only reason we have it any sort of different in the
 *    onboarding window is because of the landlord's bank maybe not being
 *    fully synced up yet."
 *
 * The bank-matched rows of the table (a deposit the feed or the landlord
 * matches to a bill; a tenant's report with the next-business-day rule) are
 * pinned in services/bankDepositConfirm.test.ts, services/
 * declaredDepositDateFlag.test.ts and routes/lateFeeDelete.test.ts. Here:
 *   1. RE-VALIDATION — a deposit logged by hand (credited, late) that the bank
 *      feed then shows: on time → the credit withdrawn, the fee zeroed, the
 *      mark corrected to on time through the correction chain; late → nothing
 *      changes. Tied by itself when certain; Undo puts it back exactly.
 *   2. THE PROPERTY SETTING "Tenants may deposit rent directly at the bank":
 *      off → the tenant's report, the "Bank deposit" method and the feed's own
 *      matching to a tenant's bill are all refused; on → all of it works.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) } }),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<typeof import('../services/email')>()),
  emailPaymentReceipt: vi.fn(async () => 'msg_test'),
  sendNotificationEmail: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { declaredDepositsRouter } from './declaredDeposits'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'
import { confirmDepositMatch, undoDepositMatch } from '../services/bankDepositConfirm'
import {
  matchRecordedDeposit, recordedDepositToTieBySelf, referenceInMemo, type RecordedDepositCandidate,
} from '../services/recordedDepositMatch'
import { reRateMarksFromBankDate } from '../services/creditLedgerEmitters'
import { reconcileDeposits } from '../services/bankFeed'
import { candidatesForDeposit } from '../services/bankDepositCandidates'
import { createSlip } from '../services/depositSlips'
import { BANK_SHOWS_LATE_FEE_NOTE } from '../services/lateFeeCredit'
import {
  BANK_DEPOSIT_METHOD_NOT_TAKEN, BANK_DEPOSIT_REPORT_NOT_TAKEN, lateFeeOffBankDateTenantText,
  lateFeeOffBankDateLandlordText, TENANTS_DEPOSIT_AT_BANK_HINT,
} from '@gam/shared'

const TZ = 'America/Phoenix'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use('/api/declared-deposits', declaredDepositsRouter)
  a.use('/api/properties', propertiesRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_bank_validated'
})

const sign = (userId: string, role: string, extra: Record<string, unknown> = {}) => jwt.sign(
  { userId, id: userId, role, email: `${role}@t.dev`, permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Stack {
  landlordId: string; ownerUserId: string; propertyId: string; unitId: string; leaseId: string
  tenantId: string; tenantUserId: string; token: string; tenantToken: string
}

/** One resident on a $600 lease, 3 grace days; `bank`: the property takes bank deposits from tenants. */
async function stack(o: { bank: boolean; onboarding?: boolean }): Promise<Stack> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, tenantsDepositAtBank: o.bank,
    })
    await c.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 600 })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 600 })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2, late_fee_grace_days = 3 WHERE id = $1`, [leaseId, o.onboarding === true])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propertyId, unitId, leaseId, tenantId, tenantUserId,
      token: sign(ll.userId, 'landlord', { profileId: ll.landlordId }),
      tenantToken: sign(tenantUserId, 'tenant', { profileId: tenantId }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A $600 rent bill due ten days ago with a $25 late fee charged five days after the due date. */
async function lateBill(s: Stack) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE $6)::date - 10, 600, 600, 'pending') RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${randomUUID().slice(0, 8)}`, TZ])).rows[0].id
  const rentId = (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
     VALUES ($1, $2, $3, $4, 'rent', 600, 'pending', 'RENT', (NOW() AT TIME ZONE $5)::date - 10, $6, NOW() - interval '10 days') RETURNING id`,
    [s.landlordId, s.tenantId, s.unitId, s.leaseId, TZ, inv])).rows[0].id
  const dueDay = (await db.query<{ d: string }>(`SELECT due_date::text AS d FROM payments WHERE id = $1`, [rentId])).rows[0].d
  const plus = async (n: number) => (await db.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [dueDay, n])).rows[0].d
  const feeDay = await plus(5)
  const feeId = (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description, created_at)
     VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date,'LATEFEE', NOW() - interval '5 days') RETURNING id`,
    [s.landlordId, s.tenantId, s.unitId, s.leaseId, inv, feeDay])).rows[0].id
  return { invoiceId: inv, rentId, feeId, dueDay, feeDay, plus }
}

const record = (s: Stack, anchor: string, body: Record<string, unknown>) =>
  request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${s.token}`).send(body)

/** The office logs the tenant's bank deposit by hand, from the bank's receipt (no bank line yet). */
async function handLogged(s: Stack, b: { rentId: string; dueDay: string }, reference = 'DEP-551203') {
  const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference, depositedOn: b.dueDay })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data as { receiptId: string; lateFeesUnbilled: number; lateFeeCountsLate: boolean }
}

/** The bank's line for a deposit posted on `posted`. */
async function bankRow(s: Stack, posted: string, o: { amount?: number; description?: string } = {}): Promise<string> {
  const conn = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, created_at) VALUES ($1,'stripe_fc','active', NOW() - interval '60 days') RETURNING id`,
    [s.landlordId])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,$4::date,$5,$6,'needs_review') RETURNING id`,
    [conn, s.landlordId, randomUUID(), posted, (o.amount ?? 600).toFixed(2), o.description ?? 'BRANCH DEPOSIT'])).rows[0].id
}

const row = async (id: string) => (await db.query<any>(
  `SELECT amount::float AS amount, status, notes, issued_credit_amount::float AS credited FROM payments WHERE id = $1`, [id])).rows[0] ?? null
const liveLateFeeCredits = async (feeId: string) => (await db.query<any>(
  `SELECT u.id AS use_id, tc.id AS credit_id, tc.status AS credit_status, u.status AS use_status
     FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
    WHERE u.payment_id = $1 AND u.source = 'late_fee_credit' ORDER BY tc.created_at, u.id`, [feeId])).rows
const marksOn = async (id: string) => (await db.query<{ id: string; event_type: string; paid_on: string; data: any }>(
  `SELECT id, event_type, to_char((event_data->>'paid_at')::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS paid_on, event_data AS data
     FROM credit_events WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = $1
      AND superseded_by IS NULL`, [id, TZ])).rows
const LATE = /^payment_received_late_(minor|major|severe)$/
const todayAtProperty = async () => (await db.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d
const txn = async (id: string) => (await db.query<any>(
  `SELECT status, auto_settle_undo, matched_payment_id FROM bank_transactions WHERE id = $1`, [id])).rows[0]
const noticesFor = async (userId: string) => (await db.query<{ title: string; body: string }>(
  `SELECT title, body FROM notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows

// ─── 1. Re-validation: the bank shows a deposit logged by hand ───────────────

describe('1. a deposit logged by hand, then the bank shows it — the bank\'s date decides', () => {
  it('logged by hand with no bank line: the never-owed fee is credited and the payment counts LATE (as live)', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    expect(rec).toMatchObject({ lateFeesUnbilled: 25, lateFeeCountsLate: true })
    expect(await row(b.feeId)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    const [m] = await marksOn(b.rentId)
    expect(m.event_type).toMatch(LATE)
    expect(m.paid_on).toBe(await todayAtProperty())
  })

  it('the bank posted it the day the receipt says: the credit is withdrawn, the fee zeroed, the mark corrected to ON TIME through the correction chain — and both sides are told', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    const [lfc] = await liveLateFeeCredits(b.feeId)
    const [lateMark] = await marksOn(b.rentId)
    const t = await bankRow(s, b.dueDay)

    const r = await matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })
    expect(r).toMatchObject({ effectivePaidDate: b.dueDay, recordedOn: b.dueDay, lateFeesOff: 25, lateFeesRefunded: 0, marksCorrected: 1 })

    // The fee is off at $0.00, its late-fee credit taken back and withdrawn.
    expect(await row(b.feeId)).toMatchObject({ amount: 0, status: 'settled', credited: 0 })
    expect((await row(b.feeId)).notes).toContain(`${BANK_SHOWS_LATE_FEE_NOTE}${b.dueDay}, before this fee was charged`)
    expect((await db.query<any>(`SELECT status, release_reason FROM credit_uses WHERE id = $1`, [lfc.use_id])).rows[0])
      .toEqual({ status: 'released', release_reason: 'late_fee_credit_withdrawn' })
    expect((await db.query<any>(`SELECT status FROM tenant_credits WHERE id = $1`, [lfc.credit_id])).rows[0].status).toBe('void')
    // The late mark is superseded (never edited) by an on-time mark from the bank's day.
    const [now] = await marksOn(b.rentId)
    expect(now).toMatchObject({ event_type: 'payment_received_on_time', paid_on: b.dueDay })
    expect(now.data).toMatchObject({ bank_validated: true, corrects_event_id: lateMark.id })
    expect(now.data.late_fee_on_bill).toBeUndefined()
    expect((await db.query<any>(`SELECT superseded_by, superseded_reason FROM credit_events WHERE id = $1`, [lateMark.id])).rows[0])
      .toEqual({ superseded_by: now.id, superseded_reason: 'data_entry_error_corrected' })
    // The bank line is tied to the receipt — no money moved again.
    const tr = await txn(t)
    expect(tr.status).toBe('matched')
    expect(tr.auto_settle_undo).toMatchObject({ kind: 'recorded_deposit', receiptId: rec.receiptId, effectivePaidDate: b.dueDay })
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM tenant_remittances WHERE tenant_id = $1`, [s.tenantId])).rows[0].n).toBe(1)
    expect((await db.query<any>(
      `SELECT payment_id, effective_paid_date::text AS d FROM bank_deposit_allocations WHERE bank_transaction_id = $1`, [t])).rows)
      .toEqual([{ payment_id: b.rentId, d: b.dueDay }])
    // Told, in plain words.
    await new Promise(r => setTimeout(r, 50))
    expect((await noticesFor(s.tenantUserId)).map(n => n.body))
      .toContain(lateFeeOffBankDateTenantText({ depositedOn: b.dueDay, amount: 25, count: 1 }))
    expect((await noticesFor(s.ownerUserId)).map(n => n.body).join(' '))
      .toContain(lateFeeOffBankDateLandlordText({ depositedOn: b.dueDay, amount: 25 }))

    // Idempotent: the line is matched now, so it cannot be tied twice, and re-rating again changes nothing.
    await expect(matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId }))
      .rejects.toThrow('This deposit has already been matched')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      expect(await reRateMarksFromBankDate(c, { paymentIds: [b.rentId], paidOn: b.dueDay })).toEqual([])
      await c.query('ROLLBACK')
    } finally { c.release() }
  })

  it('Undo puts the hand-logged state back exactly: the fee credited again, the late mark back, the line back to review — and it can be tied again', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    const feeBefore = await row(b.feeId)
    const [lateMark] = await marksOn(b.rentId)
    const t = await bankRow(s, b.dueDay)
    await matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })

    const u = await undoDepositMatch({ bankTransactionId: t, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    expect(u).toMatchObject({ kind: 'recorded_deposit', reopenedChargeIds: [], lateFeesRestored: 1 })
    // The fee: as the hand logging left it — charged, its whole amount a live late-fee credit, its notes as they were.
    expect(await row(b.feeId)).toEqual(feeBefore)
    const credits = await liveLateFeeCredits(b.feeId)
    expect(credits.filter(c => c.use_status === 'applied' && c.credit_status === 'active')).toHaveLength(1)
    // The mark: late again, from the day it was recorded (a copy appended — the chain is never rewritten).
    const [back] = await marksOn(b.rentId)
    expect(back.event_type).toBe(lateMark.event_type)
    expect(back.paid_on).toBe(lateMark.paid_on)
    expect(back.id).not.toBe(lateMark.id)
    // The payments the office recorded stand; the line waits for review, its allocations reversed.
    expect(await row(b.rentId)).toMatchObject({ status: 'settled' })
    expect((await db.query<any>(`SELECT status FROM tenant_remittances WHERE id = $1`, [rec.receiptId])).rows[0].status).toBe('settled')
    const tr = await txn(t)
    expect(tr.status).toBe('needs_review')
    expect(tr.auto_settle_undo).toMatchObject({ undone: true, was: { kind: 'recorded_deposit' } })
    expect((await db.query<any>(
      `SELECT bool_and(reversed_at IS NOT NULL) AS r FROM bank_deposit_allocations WHERE bank_transaction_id = $1`, [t])).rows[0].r).toBe(true)

    // A person can tie it again.
    const again = await matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })
    expect(again).toMatchObject({ lateFeesOff: 25, marksCorrected: 1 })
    expect(await row(b.feeId)).toMatchObject({ amount: 0, credited: 0 })
    expect((await marksOn(b.rentId))[0]).toMatchObject({ event_type: 'payment_received_on_time', paid_on: b.dueDay })
  })

  it('the bank shows the deposit LATE (posted after the next business day): nothing changes — the credit stays, the late mark stands', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    const feeBefore = await row(b.feeId)
    const [lateMark] = await marksOn(b.rentId)
    const t = await bankRow(s, await b.plus(7))   // a week later: after the fee was charged
    const r = await matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })
    expect(r).toMatchObject({ effectivePaidDate: await b.plus(7), lateFeesOff: 0, marksCorrected: 0 })
    expect(await row(b.feeId)).toEqual(feeBefore)
    expect((await liveLateFeeCredits(b.feeId)).every(c => c.use_status === 'applied' && c.credit_status === 'active')).toBe(true)
    expect(await marksOn(b.rentId)).toEqual([lateMark])
    expect((await txn(t)).status).toBe('matched')
  })

  it('the feed ties a line by itself only when certain: the reference number on the line picks between two same-amount deposits', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b, 'DEP-551203')
    // The rule: two recorded deposits of the same amount, or a twin bank line, and a person decides —
    // unless the reference number on the line picks one.
    const fits = (n: number, ref: boolean[]): RecordedDepositCandidate[] => ref.map((r, i) => ({
      receiptId: `r${i}`, tenantId: 't', tenantName: 'T', unitNumber: null, propertyName: null, amount: 600,
      recordedOn: b.dueDay, reference: `REF${i}`, referenceInMemo: r, depositsTaken: true,
    })).slice(0, n)
    expect(recordedDepositToTieBySelf(fits(2, [false, false]), b.dueDay, 0, false)).toBeNull()
    expect(recordedDepositToTieBySelf(fits(2, [true, false]), b.dueDay, 1, false)?.receiptId).toBe('r0')
    expect(recordedDepositToTieBySelf(fits(1, [false]), b.dueDay, 1, false)).toBeNull()        // a twin line of the same amount
    expect(recordedDepositToTieBySelf(fits(1, [false]), b.dueDay, 0, false)?.receiptId).toBe('r0')
    expect(recordedDepositToTieBySelf(fits(1, [false]), await b.plus(7), 0, false)).toBeNull()  // the bank does not bear the day out
    expect(recordedDepositToTieBySelf([{ ...fits(1, [true])[0], depositsTaken: false }], b.dueDay, 0, false)).toBeNull()
    // Review fix: a tenant who could have made it (a report, or an open bill of exactly that amount)
    // stops the no-reference tie; the reference number on the line still picks.
    expect(recordedDepositToTieBySelf(fits(1, [false]), b.dueDay, 0, true)).toBeNull()
    expect(recordedDepositToTieBySelf(fits(1, [true]), b.dueDay, 0, true)?.receiptId).toBe('r0')
    expect(referenceInMemo('DEP-551203', 'BRANCH DEPOSIT REF 551203')).toBe(false)
    expect(referenceInMemo('551203', 'BRANCH DEPOSIT REF 551203')).toBe(true)
    expect(referenceInMemo('12', 'DEPOSIT 12')).toBe(false)

    // End to end: the line carries the reference, and the sync ties it.
    const t = await bankRow(s, b.dueDay, { description: 'BRANCH DEPOSIT DEP-551203' })
    expect((await reconcileDeposits(s.landlordId)).recorded).toBe(1)
    expect((await txn(t)).auto_settle_undo).toMatchObject({ kind: 'recorded_deposit', receiptId: rec.receiptId, auto: true })
    expect(await row(b.feeId)).toMatchObject({ amount: 0 })
  })
})

describe('1b. review fixes — re-validation edges', () => {
  it('no reference on the line and another resident has an open bill of the same amount: the feed does NOT tie it by itself (two residents with the same rent)', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    // A second resident at the same property, the same $600 rent, still open.
    const c = await db.connect()
    let otherRent = ''
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: s.propertyId, landlordId: s.landlordId, rentAmount: 600 })
      const leaseId = await seedLease(c, { unitId, landlordId: s.landlordId, rentAmount: 600 })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      otherRent = (await c.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, created_at)
         VALUES ($1,$2,$3,$4,'rent',600,'pending','RENT',$5::date, NOW() - interval '10 days') RETURNING id`,
        [s.landlordId, tenantId, unitId, leaseId, b.dueDay])).rows[0].id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const t = await bankRow(s, b.dueDay)   // 'BRANCH DEPOSIT' — no reference number
    const r = await reconcileDeposits(s.landlordId)
    expect(r.recorded).toBe(0)
    expect(r.autoSettled).toBe(0)
    expect((await txn(t)).status).toBe('needs_review')
    expect(await row(b.feeId)).toMatchObject({ amount: 25, credited: 25 })   // the hand logging's state, untouched
    expect(await row(otherRent)).toMatchObject({ status: 'pending' })
    // With no other resident who could have made it, the same line IS tied by itself.
    await db.query(`DELETE FROM payments WHERE id = $1`, [otherRent])
    expect((await reconcileDeposits(s.landlordId)).recorded).toBe(1)
    expect((await txn(t)).auto_settle_undo).toMatchObject({ kind: 'recorded_deposit', receiptId: rec.receiptId })
  })

  it('two bank lines of the same amount tied to one recorded deposit at the same time: exactly one wins', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    const t1 = await bankRow(s, b.dueDay)
    const t2 = await bankRow(s, b.dueDay)
    const out = await Promise.allSettled([
      matchRecordedDeposit({ bankTransactionId: t1, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId }),
      matchRecordedDeposit({ bankTransactionId: t2, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId }),
    ])
    expect(out.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    const lost = out.find(o => o.status === 'rejected') as PromiseRejectedResult
    expect(String(lost.reason?.message)).toMatch(/Another bank line was tied to that recorded bank deposit meanwhile|can’t be this one/)
    const statuses = [(await txn(t1)).status, (await txn(t2)).status].sort()
    expect(statuses).toEqual(['matched', 'needs_review'])
    expect((await db.query<any>(
      `SELECT COUNT(DISTINCT bank_transaction_id)::int AS n FROM bank_deposit_allocations WHERE reversed_at IS NULL`)).rows[0].n).toBe(1)
  })

  it('a receipt the desk dated ON TIME that the bank posted later than the next business day, past grace: the on-time mark is corrected to LATE; Undo puts the on-time mark back', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    await db.query(`DELETE FROM payments WHERE id = $1`, [b.feeId])   // no late fee charged
    const rec = await handLogged(s, b)
    const [onTime] = await marksOn(b.rentId)
    expect(onTime.event_type).toBe('payment_received_on_time')
    const posted = await b.plus(7)   // well past the 3 grace days
    const t = await bankRow(s, posted)
    const r = await matchRecordedDeposit({ bankTransactionId: t, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })
    expect(r).toMatchObject({ effectivePaidDate: posted, lateFeesOff: 0, marksCorrected: 1 })
    const [now] = await marksOn(b.rentId)
    expect(now.event_type).toMatch(LATE)
    expect(now.paid_on).toBe(posted)
    expect(now.data).toMatchObject({ bank_validated: true, corrects_event_id: onTime.id })
    expect((await db.query<any>(`SELECT network_visibility FROM credit_events WHERE id = $1`, [now.id])).rows[0].network_visibility)
      .toBe('visible_to_gam_network')
    await undoDepositMatch({ bankTransactionId: t, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    const [back] = await marksOn(b.rentId)
    expect(back.event_type).toBe('payment_received_on_time')
    expect(back.paid_on).toBe(onTime.paid_on)
  })
})

// ─── 2. The property setting ────────────────────────────────────────────────

const phx = (offsetDays = 0) => DateTime.now().setZone(TZ).plus({ days: offsetDays }).toISODate()!

describe('2. "Tenants may deposit rent directly at the bank" (per property, default off)', () => {
  it('a new property starts OFF; the owner turns it on and off from the property page; another landlord cannot', async () => {
    const ll = await db.connect()
    let propertyId = ''
    let token = ''
    try {
      const l = await seedLandlord(ll)
      propertyId = (await ll.query<{ id: string }>(
        `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
         VALUES ($1,'Mountain View','1 Main','Mattoon','IL','61938',$2,$2) RETURNING id`, [l.landlordId, l.userId])).rows[0].id
      token = sign(l.userId, 'landlord', { profileId: l.landlordId })
    } finally { ll.release() }
    expect((await db.query<any>(`SELECT tenants_deposit_at_bank FROM properties WHERE id = $1`, [propertyId])).rows[0].tenants_deposit_at_bank).toBe(false)
    const on = await request(app()).patch(`/api/properties/${propertyId}/tenants-deposit-at-bank`).set('Authorization', `Bearer ${token}`).send({ allowed: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body.data).toEqual({ propertyId, tenantsDepositAtBank: true })
    const read = await request(app()).get(`/api/properties/${propertyId}`).set('Authorization', `Bearer ${token}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.data.tenantsDepositAtBank ?? read.body.data.tenants_deposit_at_bank).toBe(true)
    const off = await request(app()).patch(`/api/properties/${propertyId}/tenants-deposit-at-bank`).set('Authorization', `Bearer ${token}`).send({ allowed: false })
    expect(off.status).toBe(200)
    const other = await stack({ bank: true })
    const refused = await request(app()).patch(`/api/properties/${propertyId}/tenants-deposit-at-bank`).set('Authorization', `Bearer ${other.token}`).send({ allowed: true })
    expect(refused.status).toBe(403)
    expect(TENANTS_DEPOSIT_AT_BANK_HINT).toBe('Tenants deposit rent at your bank themselves. GAM matches each deposit to their bill using your bank feed.')
  })

  it('OFF: the tenant is not offered the report and the API refuses it in plain words', async () => {
    const s = await stack({ bank: false })
    const feed = await request(app()).get(`/api/declared-deposits/feed/${s.leaseId}`).set('Authorization', `Bearer ${s.tenantToken}`)
    expect(feed.status, JSON.stringify(feed.body)).toBe(200)
    expect(feed.body.data).toMatchObject({ depositsTaken: false, notTakenMessage: BANK_DEPOSIT_REPORT_NOT_TAKEN })
    const res = await request(app()).post('/api/declared-deposits').set('Authorization', `Bearer ${s.tenantToken}`)
      .send({ leaseId: s.leaseId, amount: 600, declaredDate: phx(0), method: 'cash', depositHour: 15, reference: 'DEP-9' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(BANK_DEPOSIT_REPORT_NOT_TAKEN)
    expect((await db.query(`SELECT 1 FROM tenant_declared_deposits`)).rowCount).toBe(0)
    // The payments screen reads the setting per lease (camelized) and leaves the button out.
    await lateBill(s)
    const ctx = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${s.tenantToken}`)
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200)
    expect(ctx.body.data.leases[0]).toMatchObject({ leaseId: s.leaseId, bankDepositsTaken: false })
  })

  it('OFF: "Bank deposit" is not offered to the landlord and the server refuses it on Record payment and Post a payment; cash still works', async () => {
    const s = await stack({ bank: false })
    const b = await lateBill(s)
    const q = await request(app()).get(`/api/payments/${b.rentId}/record-manual/quote`).set('Authorization', `Bearer ${s.token}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.bankDepositAllowed).toBe(false)
    const pq = await request(app()).get(`/api/payments/post-payment/quote?tenantId=${s.tenantId}`).set('Authorization', `Bearer ${s.token}`)
    expect(pq.status, JSON.stringify(pq.body)).toBe(200)
    expect(pq.body.data.bankDepositAllowed).toBe(false)

    const rec = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 625, reference: 'DEP-1', depositedOn: b.dueDay })
    expect(rec.status).toBe(409)
    expect(rec.body.error).toBe(BANK_DEPOSIT_METHOD_NOT_TAKEN)
    const post = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 625, reference: 'DEP-2', receivedAt: b.dueDay })
    expect(post.status).toBe(409)
    expect(post.body.error).toBe(BANK_DEPOSIT_METHOD_NOT_TAKEN)
    expect(await row(b.rentId)).toMatchObject({ status: 'pending' })

    const cash = await record(s, b.rentId, { method: 'cash', amountTendered: 625 })
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
  })

  it('OFF: the bank feed never matches a bank line to a tenant\'s bill by itself — a person still may', async () => {
    const s = await stack({ bank: false })
    const b = await lateBill(s)
    await db.query(`DELETE FROM payments WHERE id = $1`, [b.feeId])
    const t = await bankRow(s, await b.plus(1))   // exactly the whole bill, a memo that names nobody
    expect((await reconcileDeposits(s.landlordId)).autoSettled).toBe(0)
    expect(await row(b.rentId)).toMatchObject({ status: 'pending' })
    const row2 = (await db.query<any>(
      `SELECT id, landlord_id, amount::float AS amount, to_char(posted_date,'YYYY-MM-DD') AS posted_date, description FROM bank_transactions WHERE id = $1`, [t])).rows[0]
    // Review fix: the bill is still OFFERED to a person on the review screen (marked as one GAM never matches by itself).
    expect((await candidatesForDeposit(row2)).candidates).toEqual([
      expect.objectContaining({ chargeIds: [b.rentId], exact: true, depositsTaken: false }),
    ])
    await expect(confirmDepositMatch({ bankTransactionId: t, chargeIds: [b.rentId], method: 'cash', auto: true }))
      .rejects.toThrow(/don’t deposit rent at the bank, so GAM does not match a deposit to their bills by itself/)
    // The landlord, looking at it, may still say whose it is.
    const r = await confirmDepositMatch({ bankTransactionId: t, chargeIds: [b.rentId], method: 'cash', confirmedByUserId: s.ownerUserId })
    expect(r.settledChargeIds).toEqual([b.rentId])
  })

  it('OFF: the office\'s deposit slip matching is as before — a tenant\'s whole bill of the same amount still makes the slip wait for a person; with none, the slip matches', async () => {
    const s = await stack({ bank: false })
    const b = await lateBill(s)
    await db.query(`DELETE FROM payments WHERE id = $1`, [b.feeId])
    const day = await b.plus(1)
    await createSlip({
      landlordId: s.landlordId, depositDate: day, otherAmount: 600, otherNote: 'laundry quarters', otherIsNotRent: true,
      createdBy: s.ownerUserId,
    })
    const t = await bankRow(s, day)
    const r = await reconcileDeposits(s.landlordId)
    expect(r).toMatchObject({ slips: 0, autoSettled: 0 })
    expect((await txn(t)).status).toBe('needs_review')
    // No tenant bill fits: the slip matches by itself, as always.
    await db.query(`UPDATE payments SET amount = 550 WHERE id = $1`, [b.rentId])
    expect((await reconcileDeposits(s.landlordId)).slips).toBe(1)
    expect((await txn(t)).status).toBe('matched')
  })

  it('ON: the report, the "Bank deposit" method and the feed\'s own matching all work', async () => {
    const s = await stack({ bank: true })
    const b = await lateBill(s)
    const feed = await request(app()).get(`/api/declared-deposits/feed/${s.leaseId}`).set('Authorization', `Bearer ${s.tenantToken}`)
    expect(feed.body.data).toMatchObject({ depositsTaken: true })
    const ctx = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${s.tenantToken}`)
    expect(ctx.body.data.leases[0]).toMatchObject({ leaseId: s.leaseId, bankDepositsTaken: true })
    expect(feed.body.data.notTakenMessage).toBeUndefined()
    const rep = await request(app()).post('/api/declared-deposits').set('Authorization', `Bearer ${s.tenantToken}`)
      .send({ leaseId: s.leaseId, amount: 625, declaredDate: phx(0), method: 'cash', depositHour: 15, reference: 'DEP-9' })
    expect(rep.status, JSON.stringify(rep.body)).toBe(200)
    const q = await request(app()).get(`/api/payments/${b.rentId}/record-manual/quote`).set('Authorization', `Bearer ${s.token}`)
    expect(q.body.data.bankDepositAllowed).toBe(true)
    const pq = await request(app()).get(`/api/payments/post-payment/quote?tenantId=${s.tenantId}`).set('Authorization', `Bearer ${s.token}`)
    expect(pq.body.data.bankDepositAllowed).toBe(true)

    // The feed settles a whole bill to the cent by itself.
    const t = await stack({ bank: true })
    const c = await lateBill(t)
    await db.query(`DELETE FROM payments WHERE id = $1`, [c.feeId])
    await bankRow(t, await c.plus(1))
    expect((await reconcileDeposits(t.landlordId)).autoSettled).toBe(1)
    expect(await row(c.rentId)).toMatchObject({ status: 'settled' })
  })
})
