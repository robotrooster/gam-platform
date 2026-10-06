/**
 * 10/6 (Nic) — late fees that come off a bank deposit dated before them.
 *
 *   "I want to completely remove the late fees from the database to preserve
 *    these people's payment history at a hundred percent" — "any late fees
 *    that should not be charged after onboarding that happen just get zero not
 *    delete. this is just for onboarding" — "the late fee is only deleted
 *    during onboarding at landlord's discretion." — "if the tenant forgets to
 *    log the payment and gets a late fee it counts as late because of
 *    recording not that payment was late. The landlord has to spend their time
 *    going to remove the late fee. It needs to just zero it out, but still
 *    count against their on-time payment history because of that waste of
 *    time. They need to do it the right way to get the on-time payment history."
 *
 *   A. ONBOARDING BILL: deleted only when the landlord ticks the box (or uses
 *      "Delete this late fee" on a fee a reversal already zeroed); automatic
 *      reversals only zero. Owner / property manager only. Money against the
 *      row refuses the delete. The engine never charges that day again; an
 *      undo puts it back exactly.
 *   B. ANY OTHER BILL: zeroed as always; the payment's mark counts from the
 *      deposit's day only when the tenant reported the deposit before the fee
 *      posted — otherwise from the day the landlord recorded it (late), and the
 *      tenant is told why (C).
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
import { confirmDepositMatch, undoDepositMatch } from '../services/bankDepositConfirm'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { unreportedDepositLateTenantText, UNREPORTED_DEPOSIT_LATE_LANDLORD_TEXT } from '@gam/shared'

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
  `SELECT id, amount::float AS amount, status, notes FROM payments WHERE id = $1`, [id])).rows[0] ?? null
const marksOn = async (id: string) => (await db.query<{ event_type: string; paid_on: string }>(
  `SELECT event_type, to_char((event_data->>'paid_at')::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS paid_on
     FROM credit_events WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = $1
      AND superseded_by IS NULL`, [id, TZ])).rows
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

// ─── A. The onboarding bill ─────────────────────────────────────────────────

describe('A. onboarding month: deleted only when the landlord chooses', () => {
  it('the window is told when the box applies, and whether this person may tick it', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const q = await quote(s, b.rentId, b.dueDay)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: true })
    const desk = await staff(s, 'onsite_manager')
    expect((await quote(s, b.rentId, b.dueDay, desk)).body.data.canDeleteLateFees).toBe(false)

    // After onboarding, the box never applies.
    const t = await stack({ onboarding: false })
    const c = await lateBill(t)
    expect((await quote(t, c.rentId, c.dueDay)).body.data).toMatchObject({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 0 })
  })

  it('box ticked: the late fee is deleted — gone everywhere, kept only in the audit log — and the month counts on time', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-1', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 1, unreportedDepositCountsLate: false })
    expect(await row(b.feeId!)).toBeNull()
    expect((await db.query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [b.invoiceId])).rowCount).toBe(0)
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
    expect(audit[0].old_value).toMatchObject({ id: b.feeId, type: 'late_fee', due_date: b.feeDay })
    expect(audit[0].new_value).toMatchObject({ via: 'record_payment', beforeZeroing: { amount: 25, status: 'pending' } })
    // On time, from the deposit's day.
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    // The tenant hears only that the late fee came off.
    const n = await noticesFor(s.tenantUserId)
    expect(n.some(x => x.title === 'A late fee came off your bill' && !/still counts/.test(x.body))).toBe(true)
  })

  it('box left unticked: the late fee is zeroed, as always, and the month counts on time', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-2', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
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

  it('a late fee already paid is refunded as credit, never deleted', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s, { feeSettled: true })
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-5', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesRefunded: 25, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled' })
    expect((await db.query(`SELECT amount_original::float AS a, category FROM tenant_credits WHERE tenant_id = $1`, [s.tenantId])).rows)
      .toEqual([{ a: 25, category: 'late_fee_refund' }])
  })

  it('an automatic match (the bank feed) on an onboarding bill only zeroes the late fee', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const txn = await bankRow(s, b.dueDay)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash' })
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'late_fee_deleted'`)).rowCount).toBe(0)
  })

  it('"Delete this late fee" on a zeroed onboarding fee: offered on its line, owner or property manager only, then gone', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const txn = await bankRow(s, b.dueDay)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash' })

    // The line says it can be deleted — to the owner, not to the front desk.
    const desk = await staff(s, 'onsite_manager')
    const asOwner = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${s.token}`)
    expect((asOwner.body.data.payments as any[]).find(p => p.id === b.feeId)).toMatchObject({ can_delete_late_fee: true })
    const asDesk = await request(app()).get(`/api/tenants/${s.tenantId}/profile`).set('Authorization', `Bearer ${desk}`)
    const deskLine = (asDesk.body.data.payments as any[] ?? []).find(p => p.id === b.feeId)
    expect(deskLine?.can_delete_late_fee).toBeUndefined()

    const refused = await deleteLine(b.feeId!, desk)
    expect(refused.status).toBe(403)
    expect(await row(b.feeId!)).toMatchObject({ amount: 0 })

    const pm = await staff(s, 'property_manager')
    const ok = await deleteLine(b.feeId!, pm)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await row(b.feeId!)).toBeNull()
    expect((await db.query<any>(`SELECT new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows[0].new_value)
      .toMatchObject({ via: 'history_line' })
    // The mark the match wrote is untouched: on time.
    expect((await marksOn(b.rentId)).map(m => m.event_type)).toEqual(['payment_received_on_time'])
  })

  it('"Delete this late fee" is refused for a fee still owed, and for a zeroed fee after the onboarding month', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const owed = await deleteLine(b.feeId!, s.token)
    expect(owed.status).toBe(409)
    expect(owed.body.error).toBe('Only a late fee that already came off (it shows $0.00) can be deleted.')
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })

    const t = await stack({ onboarding: false })
    const c = await lateBill(t)
    await confirmDepositMatch({ bankTransactionId: await bankRow(t, c.dueDay), chargeIds: [c.rentId], method: 'cash' })
    const after = await deleteLine(c.feeId!, t.token)
    expect(after.status).toBe(409)
    expect(after.body.error).toMatch(/only on the onboarding month's bill/)
    expect(await row(c.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
  })

  it('a zeroed fee money is recorded against is refused: it stays zeroed', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await confirmDepositMatch({ bankTransactionId: await bankRow(s, b.dueDay), chargeIds: [b.rentId], method: 'cash' })
    // A receipt that (wrongly or not) applied money to it.
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, processing_fee_amount)
       VALUES ($1,$2,$3,25,25,0,'settled','cash',0) RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,25)`, [rem, b.feeId])
    const res = await deleteLine(b.feeId!, s.token)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Money is recorded against this late fee/)
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
  })

  it('box ticked but money is recorded against the fee: it stays zeroed, and the landlord is told why in plain words', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    // A bank payment once watched on it — money's own record points at the row.
    await db.query(`INSERT INTO ach_monitoring_log (payment_id, event_type, tenant_id, amount) VALUES ($1,'first_sender',$2,25)`,
      [b.feeId, s.tenantId])
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-M', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 0 })
    expect(res.body.data.lateFeeDeleteRefusals).toEqual([
      'Money is recorded against this late fee, so it can\'t be deleted. It stays at $0.00 — it no longer counts toward what they owe.',
    ])
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'late_fee_deleted'`)).rowCount).toBe(0)
    // Nothing refused: the list is empty.
    const t = await stack({ onboarding: true })
    const c = await lateBill(t)
    const ok = await record(t, c.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-M2', depositedOn: c.dueDay, deleteOnboardingLateFees: true,
    })
    expect(ok.body.data).toMatchObject({ lateFeesDeleted: 1, lateFeeDeleteRefusals: [] })
  })

  it('GAM staff (admin) may not delete a landlord\'s late fee — the landlord\'s choice only', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    await confirmDepositMatch({ bankTransactionId: await bankRow(s, b.dueDay), chargeIds: [b.rentId], method: 'cash' })
    const adminId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','admin','Gam','Admin',TRUE) RETURNING id`, [`adm-${randomUUID().slice(0, 8)}@test.dev`])).rows[0].id
    const admin = sign(adminId, 'admin')
    const line = await deleteLine(b.feeId!, admin)
    expect(line.status).toBe(403)
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
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

  it('undoing the match puts a deleted fee back exactly (same id, its amount owed again) and takes the mark back as any undo does', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const txn = await bankRow(s, b.dueDay)
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [b.rentId], method: 'cash', confirmedByUserId: s.ownerUserId })
    expect((await marksOn(b.rentId)).map(m => m.event_type)).toEqual(['payment_received_on_time'])
    expect((await deleteLine(b.feeId!, s.token)).status).toBe(200)
    expect(await row(b.feeId!)).toBeNull()

    const u = await undoDepositMatch({ bankTransactionId: txn, landlordId: s.landlordId, undoneBy: s.ownerUserId })
    expect(u.lateFeesRestored).toBe(1)
    expect(await row(b.feeId!)).toMatchObject({ id: b.feeId, amount: 25, status: 'pending' })
    expect(await row(b.rentId)).toMatchObject({ status: 'pending' })
    // The bill is as it was before the match: no live mark on the rent.
    expect(await marksOn(b.rentId)).toEqual([])
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'late_fee_restored' AND entity_id = $1`, [b.invoiceId])).rowCount).toBe(1)
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
})

// ─── B/C. After the onboarding month ────────────────────────────────────────

describe('B. after onboarding: zeroed, and the mark depends on who did the work', () => {
  it('the tenant reported the deposit before the fee posted: zeroed, on time from the deposit\'s day, report closed', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const report = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash', NOW() - interval '8 days') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-7', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, unreportedDepositCountsLate: false, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    expect((await db.query<any>(`SELECT status, recorded_remittance_id FROM tenant_declared_deposits WHERE id = $1`, [report])).rows[0])
      .toMatchObject({ status: 'recorded', recorded_remittance_id: res.body.data.receiptId })
  })

  it('no report and the fee had already posted: zeroed, but LATE from the day it was recorded — both sides told why', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-8', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, unreportedDepositCountsLate: true, lateFeesDeleted: 0 })
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
    const marks = await marksOn(b.rentId)
    expect(marks).toHaveLength(1)
    expect(marks[0].event_type).toMatch(/^payment_received_late_(minor|major|severe)$/)
    expect(marks[0].paid_on).toBe(await todayAtProperty())
    // The rent itself still settled on the deposit's day.
    expect((await db.query<{ d: string }>(
      `SELECT (settled_at AT TIME ZONE $2)::date::text AS d FROM payments WHERE id = $1`, [b.rentId, TZ])).rows[0].d).toBe(b.dueDay)
    const n = await noticesFor(s.tenantUserId)
    expect(n.map(x => x.body)).toContain(unreportedDepositLateTenantText(b.dueDay))
    expect(UNREPORTED_DEPOSIT_LATE_LANDLORD_TEXT).toBe(
      'The late fee came off. They didn\'t report this deposit, so it still counts as late on their payment history.')
  })

  it('a report made AFTER the fee posted is not the right way: it still counts late', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash', NOW() - interval '1 day')`, [s.tenantId, s.leaseId, s.landlordId, b.dueDay])
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-9', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.unreportedDepositCountsLate).toBe(true)
  })

  it('a report that already expired as "not found" is still the tenant\'s report: on time, closed as recorded, strike taken back', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const report = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, status, resolution_note, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash','unconfirmed','We could not find a matching deposit in the bank feed.', NOW() - interval '8 days')
       RETURNING id`, [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-U', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 25, unreportedDepositCountsLate: false })
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    expect((await db.query<any>(`SELECT status, recorded_remittance_id FROM tenant_declared_deposits WHERE id = $1`, [report])).rows[0])
      .toMatchObject({ status: 'recorded', recorded_remittance_id: res.body.data.receiptId })
    // No "wasn't reported" words to a tenant who did report it.
    expect((await noticesFor(s.tenantUserId)).some(n => /wasn't reported/.test(n.body))).toBe(false)
    const { declarationStrikes } = await import('../services/declaredDepositTrust')
    expect(await declarationStrikes(s.tenantId)).toBe(0)
  })

  it('an expired report for some OTHER deposit is left alone, and does not make this one on time', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const old = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, status, created_at)
       VALUES ($1,$2,$3,600,$4::date - 30,'cash','unconfirmed', NOW() - interval '40 days') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-U2', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.unreportedDepositCountsLate).toBe(true)
    expect((await db.query<any>(`SELECT status FROM tenant_declared_deposits WHERE id = $1`, [old])).rows[0].status).toBe('unconfirmed')
  })

  it('an older report for another deposit is not this one reported: the report for THIS deposit is closed, or else it counts late', async () => {
    // Last month's report, never recorded, and this month's — this month's is the one closed.
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const older = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date - 30,'cash', NOW() - interval '40 days') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const mine = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date,'cash', NOW() - interval '8 days') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId, b.dueDay])).rows[0].id
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-O1', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.unreportedDepositCountsLate).toBe(false)
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
    const st = async (id: string) => (await db.query<any>(`SELECT status FROM tenant_declared_deposits WHERE id = $1`, [id])).rows[0].status
    expect(await st(mine)).toBe('recorded')
    expect(await st(older)).toBe('pending')

    // Only last month's report: this deposit was never reported — it counts late.
    const t = await stack({ onboarding: false })
    const c = await lateBill(t)
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, created_at)
       VALUES ($1,$2,$3,600,$4::date - 30,'cash', NOW() - interval '40 days')`, [t.tenantId, t.leaseId, t.landlordId, c.dueDay])
    const late = await record(t, c.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-O2', depositedOn: c.dueDay })
    expect(late.status, JSON.stringify(late.body)).toBe(200)
    expect(late.body.data.unreportedDepositCountsLate).toBe(true)
    expect((await marksOn(c.rentId))[0].event_type).toMatch(/^payment_received_late_/)
  })

  it('the box never deletes after onboarding: the fee is zeroed', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, {
      method: 'bank_deposit', amountTendered: 600, reference: 'DEP-10', depositedOn: b.dueDay, deleteOnboardingLateFees: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.lateFeesDeleted).toBe(0)
    expect(await row(b.feeId!)).toMatchObject({ amount: 0, status: 'settled' })
  })

  it('recorded before any late fee posted: counts from the deposit\'s day, as always', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s, { noFee: true })
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-11', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesUnbilled: 0, unreportedDepositCountsLate: false })
    expect(await marksOn(b.rentId)).toEqual([{ event_type: 'payment_received_on_time', paid_on: b.dueDay }])
  })

  it('a late fee already paid is refunded as credit — and, unreported, the payment still counts late', async () => {
    const s = await stack({ onboarding: false })
    const b = await lateBill(s, { feeSettled: true })
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-12', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ lateFeesRefunded: 25, unreportedDepositCountsLate: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'settled' })
  })

  it('a part payment keeps the late fee and changes no mark rule', async () => {
    const s = await stack({ onboarding: false, partial: true })
    const b = await lateBill(s)
    const res = await record(s, b.rentId, { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-13', depositedOn: b.dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, lateFeesUnbilled: 0, unreportedDepositCountsLate: false })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })
  })

  it('"Post a payment" follows the same rules, and is told when its box applies', async () => {
    const s = await stack({ onboarding: true })
    const b = await lateBill(s)
    const q = await request(app()).get(`/api/payments/post-payment/quote?tenantId=${s.tenantId}&depositedOn=${b.dueDay}`)
      .set('Authorization', `Bearer ${s.token}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toEqual({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: true })
    expect(await row(b.feeId!)).toMatchObject({ amount: 25, status: 'pending' })   // a look changes nothing
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 600, reference: 'D-POST', receivedAt: b.dueDay, deleteOnboardingLateFees: true })
    expect(posted.status, JSON.stringify(posted.body)).toBe(200)
    expect(posted.body.data).toMatchObject({ lateFeesUnbilled: 25, lateFeesDeleted: 1 })
    expect(await row(b.feeId!)).toBeNull()
    expect((await db.query<any>(`SELECT new_value FROM audit_log WHERE action = 'late_fee_deleted'`)).rows[0].new_value)
      .toMatchObject({ via: 'post_payment' })
  })
})
