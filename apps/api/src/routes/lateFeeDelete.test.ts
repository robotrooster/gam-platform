/**
 * 10/6 (Nic) — late fees that come off a bank deposit dated before them. THE
 * FINAL RULE, verbatim:
 *
 *   "Late fees are not automatically on time because of the onboarding month.
 *    That's the landlord's discretion. This landlord does not want to give
 *    grace past the grace period for late fees for tenants that are screwing
 *    stuff up. So the late fee is only available to be completely deleted
 *    during the onboarding month. Other than that, they get a credit against
 *    their bill and the late payment still shows on their payment history."
 *   Of a tenant who reported their deposit first: "No exceptions".
 *
 *   A. LOGGED BY HAND (no bank line): CREDIT, NEVER ZERO — the fee stays as
 *      charged, a late-fee credit is applied to it, the bill nets to zero. The
 *      bill's rent counts LATE, from the day it was recorded — onboarding month
 *      or not, reported first or not. A fee already paid is refunded as
 *      credit, still late. A part payment keeps the fee owed.
 *      10/6 (Nic, "Yes, build it"): a BANK LINE matched to the bill is the
 *      other way round — "It's determined by the matching transaction from the
 *      bank log": the never-owed fee is zeroed and the payment counts from the
 *      bank's day, on time if on time (routes/bankValidatedLateFees.test.ts).
 *   B. DELETE, ONBOARDING MONTH ONLY, the landlord's choice (owner or property
 *      manager; never the front desk or GAM staff): the box on Record payment
 *      deletes the fee outright with no credit and no late mark; "Delete this
 *      late fee" on a credited onboarding fee deletes it AND its credit and
 *      replaces the late mark with the mark from the deposit's date. The engine
 *      never charges that day again; Undo of a bank match puts it back exactly.
 *   C. An onboarding bill with NO late fee keeps the onboarding month's
 *      positive-only rule.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<typeof import('../services/email')>()),
  emailPaymentReceipt: vi.fn(async () => 'msg_test'),
  sendNotificationEmail: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { confirmDepositMatch, undoDepositMatch, reverseLateFees } from '../services/bankDepositConfirm'
import { matchRecordedDeposit } from '../services/recordedDepositMatch'
import { BANK_SHOWS_LATE_FEE_NOTE } from '../services/lateFeeCredit'
import { createIssuedCredit, applyCredit, holdCredit } from '../services/creditUse'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import {
  lateFeeCreditedTenantText, LATE_FEE_CREDITED_LANDLORD_TEXT, LATE_FEE_DELETED_LANDLORD_TEXT,
  LATE_FEE_DELETED_STILL_LATE_LANDLORD_TEXT, LATE_FEE_NOT_CREDITED_STILL_OWED_TEXT, paidByLabel,
} from '@gam/shared'

const TZ = 'America/Phoenix'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use('/api/tenants', tenantsRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_late_fee_delete'
})

const sign = (userId: string, role: string, extra: Record<string, unknown> = {}) => jwt.sign(
  { userId, role, email: `${role}@t.dev`, permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Stack {
  landlordId: string; ownerUserId: string; propertyId: string; unitId: string; leaseId: string
  tenantId: string; tenantUserId: string; token: string
}

/** One resident on a $600 lease; `onboarding`: the lease came onto GAM mid-tenancy. */
async function stack(o: { onboarding: boolean; partial?: boolean }): Promise<Stack> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, accept_partial_payments = $3 WHERE id = $1`, [propertyId, TZ, o.partial === true])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 600 })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 600 })
    await c.query(`UPDATE leases SET is_existing_tenancy = $2, late_fee_grace_days = 3 WHERE id = $1`, [leaseId, o.onboarding])
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propertyId, unitId, leaseId, tenantId, tenantUserId,
      token: sign(ll.userId, 'landlord', { profileId: ll.landlordId }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A $600 rent bill due ten days ago (written that day) with a $25 late fee charged five days after the due date, posted then. */
async function lateBill(s: Stack, o: { feeSettled?: boolean; noFee?: boolean } = {}) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE $6)::date - 10, 600, 600, 'pending') RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${randomUUID().slice(0, 8)}`, TZ])).rows[0].id
  const rentId = (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
     VALUES ($1, $2, $3, $4, 'rent', 600, 'pending', 'RENT', (NOW() AT TIME ZONE $5)::date - 10, $6, NOW() - interval '10 days') RETURNING id`,
    [s.landlordId, s.tenantId, s.unitId, s.leaseId, TZ, inv])).rows[0].id
  const dueDay = (await db.query<{ d: string }>(`SELECT due_date::text AS d FROM payments WHERE id = $1`, [rentId])).rows[0].d
  const feeDay = (await db.query<{ d: string }>(`SELECT ($1::date + 5)::text AS d`, [dueDay])).rows[0].d
  const feeId = o.noFee ? null : (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description,
                           settled_at, manual_method, created_at)
     VALUES ($1,$2,$3,$4,$5,'late_fee',25,$6,$7::date,'LATEFEE',
             CASE WHEN $6 = 'settled' THEN NOW() END, CASE WHEN $6 = 'settled' THEN 'cash' END, NOW() - interval '5 days') RETURNING id`,
    [s.landlordId, s.tenantId, s.unitId, s.leaseId, inv, o.feeSettled ? 'settled' : 'pending', feeDay])).rows[0].id
  return { invoiceId: inv, rentId, feeId, dueDay, feeDay }
}

const record = (s: Stack, anchor: string, body: Record<string, unknown>, token = s.token) =>
  request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${token}`).send(body)
const quote = (s: Stack, anchor: string, depositedOn: string, token = s.token) =>
  request(app()).get(`/api/payments/${anchor}/record-manual/quote?depositedOn=${depositedOn}`).set('Authorization', `Bearer ${token}`)
const deleteLine = (id: string, token: string) =>
  request(app()).post(`/api/payments/${id}/delete-late-fee`).set('Authorization', `Bearer ${token}`).send({})

const row = async (id: string) => (await db.query<any>(
  `SELECT id, amount::float AS amount, status, notes, issued_credit_amount::float AS credited FROM payments WHERE id = $1`, [id])).rows[0] ?? null
/** The late-fee credits on a fee (10/6): the credit and its use, live or taken back. */
const lateFeeCredits = async (feeId: string) => (await db.query<any>(
  `SELECT u.id AS use_id, u.status AS use_status, u.release_reason, u.payment_id, tc.id AS credit_id, tc.status AS credit_status,
          tc.amount_original::float AS amount, tc.category
     FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
    WHERE u.source = 'late_fee_credit' AND (u.payment_id = $1 OR tc.reason LIKE '%' AND u.id IN (
            SELECT (jsonb_array_elements_text(new_value->'creditWithdrawn'->'useIds'))::uuid FROM audit_log
             WHERE action = 'late_fee_deleted' AND new_value->>'paymentId' = $1::text))
    ORDER BY u.id`, [feeId])).rows
const credits = async (tenantId: string) => (await db.query<any>(
  `SELECT amount_original::float AS amount, category, status FROM tenant_credits WHERE tenant_id = $1 ORDER BY created_at`, [tenantId])).rows
const marksOn = async (id: string) => (await db.query<{ event_type: string; paid_on: string }>(
  `SELECT event_type, to_char((event_data->>'paid_at')::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS paid_on
     FROM credit_events WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = $1
      AND superseded_by IS NULL`, [id, TZ])).rows
const LATE = /^payment_received_late_(minor|major|severe)$/
/** The rent counts LATE, once, from today (the day it was recorded). */
async function lateFromToday(rentId: string) {
  const m = await marksOn(rentId)
  expect(m).toHaveLength(1)
  expect(m[0].event_type).toMatch(LATE)
  expect(m[0].paid_on).toBe(await todayAtProperty())
}
const todayAtProperty = async () => (await db.query<{ d: string }>(`SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d
const noticesFor = async (userId: string) => (await db.query<{ title: string; body: string }>(
  `SELECT title, body FROM notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows

/** A staff member of this landlord: property manager or on-site front desk (take_payment). */
async function staff(s: Stack, role: 'property_manager' | 'onsite_manager'): Promise<string> {
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Staff','Member',TRUE) RETURNING id`, [`st-${randomUUID().slice(0, 8)}@test.dev`, role])).rows[0].id
  const perms = { 'payments.view': true, 'balances.view': true, take_payment: true }
  if (role === 'property_manager') {
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, permissions) VALUES ($1,$2,TRUE,$3::jsonb)`,
      [u, s.landlordId, JSON.stringify(perms)])
  } else {
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions) VALUES ($1,$2,$3,$4::jsonb)`,
      [u, s.landlordId, [s.propertyId], JSON.stringify(perms)])
  }
  return sign(u, role, { landlordId: s.landlordId, permissions: perms })
}

/** The bank row a deposit posted on `posted` makes (GAM reads this landlord's bank). */
async function bankRow(s: Stack, posted: string, amount = 600): Promise<string> {
  const conn = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, created_at) VALUES ($1,'stripe_fc','active', NOW() - interval '60 days') RETURNING id`,
    [s.landlordId])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,$4::date,$5,'BRANCH DEPOSIT','needs_review') RETURNING id`,
    [conn, s.landlordId, randomUUID(), posted, amount.toFixed(2)])).rows[0].id
}

/**
 * 10/6 (Nic, "Yes, build it"): the office logs the tenant's bank deposit BY
 * HAND, from the bank's receipt, before any bank line shows it — the
 * never-owed late fee is credited and the payment counts late.
 */
async function handLogged(s: Stack, b: { rentId: string; dueDay: string }, token = s.token) {
  const res = await record(s, b.rentId,
    { method: 'bank_deposit', amountTendered: 600, reference: `DEP-H-${randomUUID().slice(0, 6)}`, depositedOn: b.dueDay }, token)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data
}

// ─── A. Logged by hand: credit, never zero. Matched to a bank line: the bank decides ─

describe('A. a never-owed late fee is credited — the fee stays, the bill nets out, the payment counts late', () => {
  it('onboarding month, box left unticked: credited, and LATE from the day it was recorded — no onboarding pass', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-2', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 0, lateFeeCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    expect((await row(b.feeId!)).notes).toContain(`Late fee credited: rent was paid ${b.dueDay}`)
    const lfc = await lateFeeCredits(b.feeId!)
    expect(lfc).toHaveLength(1)
    expect(lfc[0]).toMatchObject({ use_status: 'applied', credit_status: 'active', amount: 25, category: 'late_fee_refund' })
    // The bill nets to zero.
    expect((await db.query<any>(`SELECT status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0].status).toBe('settled')
    expect((await db.query<any>(`SELECT money_part::float AS m FROM v_payment_money WHERE payment_id = $1`, [b.feeId])).rows[0].m).toBe(0)
    await lateFromToday(b.rentId)
    // The rent itself still settled on the deposit's day.
    expect((await db.query<{ d: string }>(
      `SELECT (settled_at AT TIME ZONE $2)::date::text AS d FROM payments WHERE id = $1`, [b.rentId, TZ])).rows[0].d).toBe(b.dueDay)
    // The tenant is told, in Nic's words.
    expect((await noticesFor(s.tenantUserId)).map(n => n.body))
      .toContain(lateFeeCreditedTenantText({ depositedOn: b.dueDay, credited: 25, refunded: 0, count: 1 }))
  })

  it('after onboarding, no report: credited, LATE from the day it was recorded, both sides told', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-8', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeeCountsLate: true, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    await lateFromToday(b.rentId)
    const day = new Date(`${b.dueDay}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    expect((await noticesFor(s.tenantUserId)).map(n => n.body)).toContain(
      `Your landlord found your payment from ${day} and credited the $25 late fee. ` +
      'Because it wasn\'t recorded before the late fee posted, it still counts as a late payment on your payment history.')
    expect(LATE_FEE_CREDITED_LANDLORD_TEXT).toBe('The late fee was credited. It still counts as a late payment on their history.')
  })

  it('"No exceptions": the tenant reported the deposit before the fee posted — still credited and still LATE; the report is closed', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const report = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash', NOW() - interval '8 days') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-7', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeeCountsLate: true, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, credited: 25 })
    await lateFromToday(b.rentId)
    expect((await db.query<any>(`SELECT status, recorded_remittance_id FROM tenant_declared_deposits WHERE id = $1`, [report])).rows[0])
      .toMatchObject({ status: 'recorded', recorded_remittance_id: res.body.data.receiptId })
  })

  it('"No exceptions" on the onboarding bill too: reported first, onboarding month — credited and LATE', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash', NOW() - interval '8 days')`, [s.tenantId, s.leaseId, s.landlordId, b.dueDay])
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-7B', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.lateFeeCountsLate).toBe(true)
    await lateFromToday(b.rentId)
  })

  it('a late fee already paid is refunded as credit — and the payment still counts late', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s, { feeSettled: true })
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-12', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesRefunded: 25, lateFeesUnbilled: 0, lateFeeCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 0 })
    expect(await credits(s.tenantId)).toEqual([{ amount: 25, category: 'late_fee_refund', status: 'active' }])
    await lateFromToday(b.rentId)
  })

  it('a part payment keeps the late fee owed — nothing is credited', async () => {
    const s = await stack({ onboarding: false, partial: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-13', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, lateFeesUnbilled: 0, lateFeeCountsLate: false })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending', credited: 0 })
    expect(await lateFeeCredits(b.feeId!)).toEqual([])
  })

  it('recorded before any late fee posted: counts from the deposit\'s day, as always', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s, { noFee: true })
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-11', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 0, lateFeeCountsLate: false })
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
  })

  it('10/6 "Yes, build it": a bank line matched to the bill — the bank\'s date decides: the never-owed fee comes off at $0.00 (never credited, never deleted) and the payment counts ON TIME from the bank\'s day, onboarding month or not', async () => {
    for (const onboarding of [true, false]) {
      const s = await stack({ onboarding })
      const b = await lateBill(s)
      const txn = await bankRow(s, b.dueDay)
      const r = await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash' })
      expect(r.lateFeesUnbilled).toBe(25)
      expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled', credited: 0 })
      expect((await row(b.feeId!)).notes).toContain(`${BANK_SHOWS_LATE_FEE_NOTE}${b.dueDay}, before this fee was charged`)
      expect(await lateFeeCredits(b.feeId!)).toEqual([])
      expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'late_fee_deleted'`)).rowCount).toBe(0)
      expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
      expect((await db.query<any>(`SELECT event_data FROM credit_events WHERE event_data->>'payment_id' = $1`, [b.rentId])).rows[0].event_data)
        .toMatchObject({ bank_validated: true })
      expect((await db.query<any>(`SELECT status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0].status).toBe('settled')
      // The tenant's own history says why it is $0.00, in words.
      const mine = await request(app()).get('/api/tenants/payments')
        .set('Authorization', `Bearer ${sign(s.tenantUserId, 'tenant', { profileId: s.tenantId })}`)
      const line = (mine.body.data as any[]).find(p => p.id === b.feeId)
      expect(paidByLabel(line.paid_by ?? line.paidBy, null)).toBe('Came off — the bank\'s date')
      await cleanupAllSchema()
    }
  })

  it('the box never deletes after onboarding: the fee is credited', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-10', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesDeleted: 0, lateFeesUnbilled: 25, lateFeeCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, credited: 25 })
  })

  it('undoing a bank match puts the zeroed fee back exactly: owed again at $25, no credit anywhere, no mark left', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const before = await row(b.feeId!)
    const txn = await bankRow(s, b.dueDay)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash', confirmedByUserId: s.ownerUserId })
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    expect(u.lateFeesRestored).toBe(1)
    expect(await row(b.feeId!)).toEqual(before)
    expect(await row(b.rentId)).toMatchObject({ status: 'pending' })
    expect(await lateFeeCredits(b.feeId!)).toEqual([])
    expect(await credits(s.tenantId)).toEqual([])
    expect(await marksOn(b.rentId)).toEqual([])
    expect((await db.query<any>(`SELECT status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0].status).not.toBe('settled')
  })

  it('"Post a payment" credits the same way', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 600, reference: 'D-POST-C', receivedAt: b.dueDay })
    expect(posted.status, JSON.stringify(posted.body)).toBe(200)
    expect(posted.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 0, lateFeeCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, credited: 25 })
    await lateFromToday(b.rentId)
  })
})

// ─── B. Delete — the onboarding month only, the landlord's choice ───────────

describe('B. onboarding month: deleted only when the landlord chooses', () => {
  it('the window is told when the box applies, and whether this person may tick it', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const q = await quote(s, b.rentId, b.dueDay)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending', credited: 0 })   // a look changes nothing
    expect(await credits(s.tenantId)).toEqual([])
    const desk = await staff(s, 'onsite_manager')
    expect((await quote(s, b.rentId, b.dueDay, desk)).body.data.canDeleteLateFees).toBe(false)

    // After onboarding, the box never applies.
    const t = await stack({ onboarding: false })
    const c = await lateBill(t)
    expect((await quote(t, c.rentId, c.dueDay)).body.data).toMatchObject({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 0 })
  })

  it('box ticked: the late fee is deleted with NO credit — gone everywhere, kept only in the audit log — and nothing late on their record', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-1', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 0, lateFeesDeleted: 1, lateFeeCountsLate: false, lateFeeDeleteRefusals: [] })
    expect(await row(b.feeId!)).toBeNull()
    expect(await credits(s.tenantId)).toEqual([])
    expect((await db.query(`SELECT 1 FROM credit_uses WHERE source = 'late_fee_credit'`)).rowCount).toBe(0)
    expect((await db.query<any>(`SELECT subtotal_late_fees::float AS f, status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0])
      .toEqual({ f: 0, status: 'settled' })
    // The resident's own list of charges no longer has it.
    const profile = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${s.token}`)
    expect((profile.body.data.payments as any[]).some(p => p.type === 'late_fee')).toBe(false)
    // The full row is kept for the record.
    const audit = (await db.query<any>(
      `SELECT user_id, entity_id, old_value, new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ user_id: s.ownerUserId, entity_id: b.invoiceId })
    expect(audit[0].old_value).toMatchObject({ id: b.feeId, type: 'late_fee', due_date: b.feeDay, amount: 25, status: 'pending' })
    expect(audit[0].new_value).toMatchObject({ via: 'record_payment', kind: 'never_owed', neverOwedSince: b.dueDay, creditWithdrawn: null })
    // On time, from the deposit's day.
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    // Nothing to tell the tenant about a late fee.
    expect((await noticesFor(s.tenantUserId)).some(n => /late fee/i.test(n.title + n.body))).toBe(false)
    expect(LATE_FEE_DELETED_LANDLORD_TEXT).toBe('The late fee was deleted — nothing shows on their record.')
  })

  it('only the owner or a property manager may tick it — the front desk is refused and nothing is recorded', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const desk = await staff(s, 'onsite_manager')
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-3', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    }, desk)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Only the owner or a property manager can delete a late fee/)
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })
    expect(await row(b.rentId)).toMatchObject({ status: 'pending' })
    const pm = await staff(s, 'property_manager')
    const ok = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-3', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    }, pm)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await row(b.feeId!)).toBeNull()
  })

  it('a part payment leaves the late fee on the bill — nothing is deleted', async () => {
    const s = await stack({ onboarding: true, partial: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 500, reference: 'DEP-4', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, lateFeesUnbilled: 0, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })
  })

  it('a late fee already paid is refunded as credit, never deleted — and counts late', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s, { feeSettled: true })
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-5', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesRefunded: 25, lateFeesDeleted: 0, lateFeeCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled' })
    expect(await credits(s.tenantId)).toEqual([{ amount: 25, category: 'late_fee_refund', status: 'active' }])
    await lateFromToday(b.rentId)
  })

  it('"Delete this late fee" on a credited onboarding fee: offered on its line, owner or property manager only — the fee AND its credit go, and the late mark is replaced by the deposit-date mark', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await handLogged(s, b)
    await lateFromToday(b.rentId)
    const [lfc] = await lateFeeCredits(b.feeId!)
    const lateMark = (await db.query<{ id: string }>(
      `SELECT id FROM credit_events WHERE event_data->>'payment_id' = $1 AND superseded_by IS NULL`, [b.rentId])).rows[0].id

    // The line says it can be deleted — to the owner, not to the front desk.
    const desk = await staff(s, 'onsite_manager')
    const asOwner = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${s.token}`)
    expect((asOwner.body.data.payments as any[]).find(p => p.id === b.feeId)).toMatchObject({ can_delete_late_fee: true })
    const asDesk = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${desk}`)
    const deskLine = (asDesk.body.data.payments as any[] ?? []).find(p => p.id === b.feeId)
    expect(deskLine?.can_delete_late_fee).toBeUndefined()

    const refused = await deleteLine(b.feeId!, desk)
    expect(refused.status).toBe(403)
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, credited: 25 })

    const pm = await staff(s, 'property_manager')
    const ok = await deleteLine(b.feeId!, pm)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.message).toBe('The late fee was deleted — nothing shows on their record.')
    expect(await row(b.feeId!)).toBeNull()
    // Its credit is taken back off it and withdrawn — both kept, neither spendable.
    expect((await db.query<any>(`SELECT status, release_reason, payment_id FROM credit_uses WHERE id = $1`, [lfc.use_id])).rows[0])
      .toEqual({ status: 'released', release_reason: 'late_fee_credit_withdrawn', payment_id: null })
    expect((await db.query<any>(`SELECT status FROM tenant_credits WHERE id = $1`, [lfc.credit_id])).rows[0].status).toBe('void')
    const audit = (await db.query<any>(`SELECT old_value, new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows[0]
    expect(audit.new_value).toMatchObject({ via: 'history_line', kind: 'credited',
      creditWithdrawn: { amount: 25, useIds: [lfc.use_id], creditIds: [lfc.credit_id] } })
    expect(audit.old_value).toMatchObject({ id: b.feeId, amount: 25, issued_credit_amount: 0 })
    // The late mark is superseded (never edited) by the mark from the deposit's date.
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    const old = (await db.query<any>(`SELECT superseded_by, superseded_reason FROM credit_events WHERE id = $1`, [lateMark])).rows[0]
    expect(old.superseded_reason).toBe('data_entry_error_corrected')
    expect((await db.query<any>(`SELECT event_data FROM credit_events WHERE id = $1`, [old.superseded_by])).rows[0].event_data)
      .toMatchObject({ corrects_event_id: lateMark, late_fee_deleted: true })
  })

  it('"Delete this late fee" also takes a fee the code before 10/6 zeroed', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'bank_deposit' WHERE id = $1`, [b.rentId])
    await db.query(
      `UPDATE payments SET amount = 0, status = 'settled', settled_at = NOW(),
              notes = 'Reversed: rent was paid ' || $2 || ', before this fee accrued' WHERE id = $1`, [b.feeId, b.dueDay])
    const ok = await deleteLine(b.feeId!, s.token)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await row(b.feeId!)).toBeNull()
    expect((await db.query<any>(`SELECT new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows[0].new_value)
      .toMatchObject({ kind: 'zeroed', creditWithdrawn: null })
  })

  it('"Delete this late fee" is refused for a fee still owed, and for a credited fee after the onboarding month (it stays credited)', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const owed = await deleteLine(b.feeId!, s.token)
    expect(owed.status).toBe(409)
    expect(owed.body.error).toBe('Only a late fee that was credited because the rent was already in the bank can be deleted.')
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })

    const t = await stack({ onboarding: false })
    const c = await lateBill(t)
    await handLogged(t, c)
    const after = await deleteLine(c.feeId!, t.token)
    expect(after.status).toBe(409)
    expect(after.body.error).toMatch(/only on the onboarding month's bill\. This one stays credited/)
    expect(await row(c.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    await lateFromToday(c.rentId)
    // Never offered on its line either.
    const profile = await request(app()).get(`/api/tenants/${t.tenantId}/profile`).set('Authorization', `Bearer ${t.token}`)
    expect((profile.body.data.payments as any[]).find(p => p.id === c.feeId)?.can_delete_late_fee).toBeUndefined()
  })

  it('a credited fee money is recorded against is refused: it stays credited', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await handLogged(s, b)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, processing_fee_amount)
       VALUES ($1,$2,$3,25,25,0,'settled','cash',0) RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,25)`, [rem, b.feeId])
    const res = await deleteLine(b.feeId!, s.token)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Money is recorded against this late fee/)
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    expect((await lateFeeCredits(b.feeId!))[0]).toMatchObject({ use_status: 'applied', credit_status: 'active' })
  })

  it('box ticked but money is recorded against the fee: it is credited instead, and the landlord is told why in plain words', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    // A bank payment once watched on it — money's own record points at the row.
    await db.query(`INSERT INTO ach_monitoring_log (payment_id, event_type, tenant_id, amount) VALUES ($1,'first_sender',$2,25)`,
      [b.feeId, s.tenantId])
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-M', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 0, lateFeeCountsLate: true })
    expect(res.body.data.lateFeeDeleteRefusals).toEqual([
      'Money is recorded against this late fee, so it can\'t be deleted. It stays credited — it no longer counts toward what they owe, and it still counts as a late payment on their history.',
    ])
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'late_fee_deleted'`)).rowCount).toBe(0)
  })

  it('GAM staff (admin) may not delete a landlord\'s late fee — the landlord\'s choice only', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await handLogged(s, b)
    const adminId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','admin','Gam','Admin',TRUE) RETURNING id`, [`adm-${randomUUID().slice(0, 8)}@test.dev`])).rows[0].id
    const admin = sign(adminId, 'admin')
    const line = await deleteLine(b.feeId!, admin)
    expect(line.status).toBe(403)
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    const profile = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${admin}`)
    const adminLine = ((profile.body.data?.payments as any[]) ?? []).find(p => p.id === b.feeId)
    expect(adminLine?.can_delete_late_fee).toBeUndefined()

    const t = await stack({ onboarding: true })
    const c = await lateBill(t)
    const boxed = await record(t, c.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-A', depositedOn: c.dueDay, deleteOnboardingLateFees: true,
    }, admin)
    expect(boxed.status).toBe(403)
    expect(await row(c.feeId!)).toMatchObject({ amount: 25, status: 'pending' })
  })

  it('a fee the landlord deleted in the onboarding month stays deleted when the bank later shows the deposit — and Undo of that match changes nothing on it', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const rec = await handLogged(s, b)
    const [lfc] = await lateFeeCredits(b.feeId!)
    expect((await deleteLine(b.feeId!, s.token)).status).toBe(200)
    expect(await row(b.feeId!)).toBeNull()
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])

    const txn = await bankRow(s, b.dueDay)
    const m = await matchRecordedDeposit({ bankTransactionId: txn, receiptId: rec.receiptId, confirmedByUserId: s.ownerUserId })
    expect(m).toMatchObject({ effectivePaidDate: b.dueDay, lateFeesOff: 0, marksCorrected: 0 })
    expect(await row(b.feeId!)).toBeNull()
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])

    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    expect(u).toMatchObject({ kind: 'recorded_deposit', lateFeesRestored: 0 })
    expect(await row(b.feeId!)).toBeNull()
    expect(await row(b.rentId)).toMatchObject({ status: 'settled' })
    expect((await db.query<any>(`SELECT status FROM tenant_credits WHERE id = $1`, [lfc.credit_id])).rows[0].status).toBe('void')
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
  })

  it('the late-fee engine never charges a deleted fee again', async () => {
    const s = await stack({ onboarding: true })
    await db.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_initial_type = 'flat', late_fee_initial_amount = 25 WHERE id = $1`, [s.leaseId])
    const b = await lateBill(s, { noFee: true })
    await generateLateFeesForInvoice(b.invoiceId)
    const fee = (await db.query<{ id: string; d: string }>(
      `SELECT id, due_date::text AS d FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [b.invoiceId])).rows
    expect(fee).toHaveLength(1)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-6', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await row(fee[0].id)).toBeNull()
    // The rent is reopened (say, the deposit bounced) — the engine charges every
    // late day it finds unpaid, but never the one the landlord deleted.
    await db.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [b.rentId])
    await generateLateFeesForInvoice(b.invoiceId)
    expect((await db.query(
      `SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee' AND due_date = $2::date`, [b.invoiceId, fee[0].d])).rowCount).toBe(0)
  })

  it('"Post a payment" follows the same rules, and is told when its box applies', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const q = await request(app()).get(`/api/payments/post-payment/quote?tenantId=${s.tenantId}&depositedOn=${b.dueDay}`)
      .set('Authorization', `Bearer ${s.token}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toEqual({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: true, bankDepositAllowed: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })   // a look changes nothing
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 600, reference: 'D-POST', receivedAt: b.dueDay, deleteOnboardingLateFees: true })
    expect(posted.status, JSON.stringify(posted.body)).toBe(200)
    expect(posted.body.data).toMatchObject({ lateFeesUnbilled: 0, lateFeesDeleted: 1, lateFeeCountsLate: false })
    expect(await row(b.feeId!)).toBeNull()
    expect((await db.query<any>(`SELECT new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows[0].new_value)
      .toMatchObject({ via: 'post_payment' })
  })
})

// ─── C. The onboarding month's positive-only rule ───────────────────────────

describe('C. the onboarding month without a late fee stays positive-only; with one, late is late', () => {
  it('paid late in the onboarding month with no late fee on the bill: no mark at all', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s, { noFee: true })
    const res = await record(s, b.rentId, { method: 'cash', amountTendered: 600 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await marksOn(b.rentId)).toEqual([])
  })

  it('paid late in the onboarding month with a late fee owed on the bill: LATE', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'cash', amountTendered: 625 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    await lateFromToday(b.rentId)
  })
})

// ─── D. Review fixes (10/6) ─────────────────────────────────────────────────

/** A second $25 late fee on the same bill, charged six days after the due date — already paid in cash. */
async function secondPaidFee(s: Stack, b: { invoiceId: string; dueDay: string }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description,
                           settled_at, manual_method, created_at)
     VALUES ($1,$2,$3,$4,$5,'late_fee',25,'settled',$6::date + 6,'LATEFEE', NOW(), 'cash', NOW() - interval '4 days') RETURNING id`,
    [s.landlordId, s.tenantId, s.unitId, s.leaseId, b.invoiceId, b.dueDay])).rows[0].id
}

describe('D. what the landlord is told matches what is left on the bill', () => {
  it('box ticked, but another late fee stays on the bill (already paid, refunded): deleted, and the landlord is told it STILL counts late', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const paid = await secondPaidFee(s, b)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-D1', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({
      lateFeesDeleted: 1, lateFeesRefunded: 25, lateFeeCountsLate: true, lateFeeDeletedStillLate: true,
    })
    expect(await row(b.feeId!)).toBeNull()
    expect(await row(paid)).toMatchObject({ amount: 25, status: 'settled' })
    await lateFromToday(b.rentId)
  })

  it('box ticked and nothing else on the bill: "nothing shows on their record" stands', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-D2', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.body.data).toMatchObject({ lateFeesDeleted: 1, lateFeeCountsLate: false, lateFeeDeletedStillLate: false })
  })

  it('"Delete this late fee" with another late fee still on the bill: deleted, the late mark stands, and the message says so', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const paid = await secondPaidFee(s, b)
    await handLogged(s, b)
    await lateFromToday(b.rentId)
    const ok = await deleteLine(b.feeId!, s.token)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ deleted: true, lateFeeLeftOnBill: true, message: LATE_FEE_DELETED_STILL_LATE_LANDLORD_TEXT })
    expect(await row(b.feeId!)).toBeNull()
    expect(await row(paid)).toMatchObject({ amount: 25 })
    await lateFromToday(b.rentId)
  })

  it('a fee that already carried the landlord\'s own credit: credited for the rest, and Undo still takes it back exactly', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    // $10 of a goodwill credit was applied to the late fee before the deposit was found.
    const c = await db.connect()
    let goodwill = ''
    try {
      await c.query('BEGIN')
      goodwill = await createIssuedCredit(c, { landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.leaseId, amount: 10, category: 'goodwill' })
      const month = (await c.query<{ m: string }>(`SELECT to_char(date_trunc('month', $1::date), 'YYYY-MM-DD') AS m`, [b.dueDay])).rows[0].m
      await applyCredit(c, [{ creditKind: 'issued', creditId: goodwill, paymentId: b.feeId!, leaseId: s.leaseId, amount: 10, billingMonth: month }],
        { source: 'desk' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending', credited: 10 })

    const txn = await bankRow(s, b.dueDay)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash', confirmedByUserId: s.ownerUserId })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled', credited: 25 })
    const snap = (await db.query<any>(`SELECT auto_settle_undo FROM bank_transactions WHERE id = $1`, [txn])).rows[0].auto_settle_undo
    expect(snap.lateFeesCredited).toEqual([expect.objectContaining({ paymentId: b.feeId, amount: 15, priorIssued: 10 })])

    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    expect(u.lateFeesRestored).toBe(1)
    // Owed again exactly as before: the goodwill $10 still on it, the late-fee credit and the refund withdrawn.
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending', credited: 10 })
    expect((await db.query<any>(`SELECT status FROM tenant_credits WHERE id = $1`, [goodwill])).rows[0].status).toBe('active')
    expect((await db.query<any>(
      `SELECT status FROM tenant_credits WHERE tenant_id = $1 AND category = 'late_fee_refund'`, [s.tenantId])).rows.map(r => r.status))
      .toEqual(['void', 'void'])
  })

  it('box ticked, but the fee can be neither deleted nor credited (credit set aside on it): the landlord is told it is still owed, never "stays credited"', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const rem = (await c.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, processing_fee_amount)
         VALUES ($1,$2,$3,15,0,15,'processing','ach',0) RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
      const credit = await createIssuedCredit(c, { landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.leaseId, amount: 10, category: 'goodwill' })
      const month = (await c.query<{ m: string }>(`SELECT to_char(date_trunc('month', $1::date), 'YYYY-MM-DD') AS m`, [b.dueDay])).rows[0].m
      await holdCredit(c, [{ creditKind: 'issued', creditId: credit, paymentId: b.feeId!, leaseId: s.leaseId, amount: 10, billingMonth: month }],
        { remittanceId: rem, source: 'portal' })
      const r = await reverseLateFees(c, b.invoiceId, b.dueDay, {
        settlingIds: [b.rentId], tenantId: s.tenantId, landlordId: s.landlordId, leaseId: s.leaseId, createdBy: s.ownerUserId,
        refundPaid: false, deleteOnboarding: { deletedBy: s.ownerUserId, via: 'record_payment' },
      })
      expect(r.deleted).toEqual([])
      expect(r.credited).toEqual([])
      expect(r.deleteRefusals).toEqual([LATE_FEE_NOT_CREDITED_STILL_OWED_TEXT])
      expect(r.deleteRefusals.join(' ')).not.toMatch(/stays credited/)
      const f = (await c.query<any>(`SELECT amount::float AS amount, status FROM payments WHERE id = $1`, [b.feeId])).rows[0]
      expect(f).toEqual({ amount: 25, status: 'pending' })
      await c.query('ROLLBACK')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  })

  it('the credited fee reads "Late fee credited" in the tenant\'s own history, and its credit\'s reason gives the day in plain words', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    await handLogged(s, b)
    const tenantToken = sign(s.tenantUserId, 'tenant', { profileId: s.tenantId })
    const res = await request(app()).get('/api/tenants/payments').set('Authorization', `Bearer ${tenantToken}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const line = (res.body.data as any[]).find(p => p.id === b.feeId)
    expect(line.paid_by ?? line.paidBy).toBe('late_fee_credit')
    expect(paidByLabel('late_fee_credit', null)).toBe('Late fee credited')
    const day = new Date(`${b.dueDay}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const reason = (await db.query<{ reason: string }>(
      `SELECT tc.reason FROM tenant_credits tc JOIN credit_uses u ON u.tenant_credit_id = tc.id WHERE u.payment_id = $1`, [b.feeId])).rows[0].reason
    expect(reason).toBe(`Late fee credited — the bank shows rent was paid on ${day}, before this fee was charged`)
  })
})
