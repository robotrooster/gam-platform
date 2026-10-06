/**
 * 10/5 (Nic) — residents who pay by walking into the bank, and part payments.
 *
 * "in Mattoon, they go into the bank and deposit cash into the bank ... he
 * needs to log the cash payments that people made ... a reference number to the
 * bank deposit in case somebody else happens to deposit the same amount. And
 * then also maybe ... add a picture of the receipt ... he would also like it to
 * be able to take a partial payment ... We need that to log that and still be
 * able to charge late fees to the people that didn't pay in full."
 *
 *   1. "Bank deposit" is its own recorded method: the reference is required,
 *      the photo optional; no change is ever given (anything over is credit,
 *      like a check); it is free; it is never cash on hand to be deposited.
 *   2. The photo is served only to that landlord's own people, per row.
 *   3. "Accept partial payments" per property (default off): recorded money
 *      pays the oldest bills first, the rest of a rent bill stays open, late
 *      fees keep applying to it, and the bill's on-time or late mark waits for
 *      the day it is paid in full. Online payments still pay in full.
 */
import fs from 'fs'
import path from 'path'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// A bank pull a settle replaced is canceled at Stripe after the commit.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))
// The receipt is rendered for real; only the send is caught.
const emailPaymentReceipt = vi.hoisted(() => vi.fn(async (..._a: any[]) => 'msg_test'))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<typeof import('../services/email')>()),
  emailPaymentReceipt,
  sendNotificationEmail: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { propertiesRouter } from './properties'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'
import { cashNotBanked } from '../services/depositSlips'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { PART_PAYMENT_REST_NOTE } from '../services/manualPaymentSettle'

const TZ = 'America/Phoenix'
const uploaded: string[] = []

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use('/api/properties', propertiesRouter)
  a.use('/api/balances', balancesRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPaymentReceipt.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_bank_deposit_partial'
})

afterAll(() => {
  // The photos these tests uploaded.
  for (const f of uploaded) { try { fs.unlinkSync(f) } catch { /* already gone */ } }
})

const sign = (userId: string, role: string, extra: Record<string, unknown> = {}) => jwt.sign(
  { userId, role, email: `${role}@t.dev`, permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Stack {
  landlordId: string; ownerUserId: string; propertyId: string; unitId: string; leaseId: string; tenantId: string
  tenantUserId: string; token: string
}

/** A landlord, a property (partial payments as asked), one resident on a $600 lease. */
async function stack(opts: { partial?: boolean; rent?: number } = {}): Promise<Stack> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, accept_partial_payments = $3 WHERE id = $1`,
      [propertyId, TZ, opts.partial === true])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 600 })
    await c.query(`UPDATE units SET unit_number = 'Lot 7' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 600 })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Rae', last_name = 'Tull' WHERE id = $1`, [tenantUserId])
    await c.query('COMMIT')
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propertyId, unitId, leaseId, tenantId, tenantUserId,
      token: sign(ll.userId, 'landlord', { profileId: ll.landlordId }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A bill (an invoice with its charges) due `daysAgo` days ago on the property's calendar. */
async function bill(s: Stack, charges: Array<{ type: 'rent' | 'utility'; amount: number }>, daysAgo = 0) {
  const total = charges.reduce((t, x) => t + x.amount, 0)
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE $6)::date - $7::int, $8, $8, 'pending') RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${Math.random().toString(36).slice(2, 9)}`, TZ, daysAgo, total])).rows[0].id
  const ids: string[] = []
  for (const ch of charges) {
    ids.push((await db.query<{ id: string }>(
      // Written on its due date, as the monthly run writes a bill.
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, (NOW() AT TIME ZONE $8)::date - $9::int, $10, NOW() - ($9::int || ' days')::interval) RETURNING id`,
      [s.landlordId, s.tenantId, s.unitId, s.leaseId, ch.type, ch.amount, ch.type === 'rent' ? 'RENT' : 'UTILITY', TZ, daysAgo, inv])).rows[0].id)
  }
  return { invoiceId: inv, ids }
}

const record = (s: Stack, anchor: string, body: Record<string, unknown>, token = s.token) =>
  request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${token}`).send(body)

const row = async (id: string) => (await db.query<any>(
  `SELECT id, type, amount::float AS amount, status, manual_method, platform_held, is_remainder, invoice_id, due_date::text AS due_date, notes
     FROM payments WHERE id = $1`, [id])).rows[0]

const rowsOfInvoice = async (invoiceId: string) => (await db.query<any>(
  `SELECT id, type, amount::float AS amount, status, is_remainder FROM payments
    WHERE invoice_id = $1 AND type <> 'late_fee' ORDER BY is_remainder, created_at, id`, [invoiceId])).rows

const marksOn = async (paymentIds: string[]) => (await db.query<{ event_type: string; payment_id: string }>(
  `SELECT event_type, event_data->>'payment_id' AS payment_id FROM credit_events
    WHERE event_type LIKE 'payment_received_%' AND event_data->>'payment_id' = ANY($1::text[])`, [paymentIds])).rows

const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

async function uploadPhoto(receiptId: string, token: string, opts: { contentType?: string; filename?: string } = {}) {
  const res = await request(app()).post(`/api/payments/remittances/${receiptId}/deposit-photo`)
    .set('Authorization', `Bearer ${token}`)
    .attach('photo', tinyJpeg, { filename: opts.filename ?? 'bank-receipt.jpg', contentType: opts.contentType ?? 'image/jpeg' })
  const url: string | undefined = res.body?.data?.depositPhotoUrl
  if (url) uploaded.push(path.join(process.cwd(), 'uploads', 'bank-deposit-receipts', path.basename(url)))
  return res
}

// ─── 1. Bank deposit: its own recorded method ────────────────────────────────

describe('Bank deposit — recorded from the bank\'s receipt', () => {
  it('needs the deposit reference number, like a check needs its number', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/deposit reference number from the bank's receipt/)
    expect((await row(b.ids[0])).status).toBe('pending')
  })

  it('is recorded as the landlord\'s money: settled, never paid out by GAM, free, no change, its own method on the receipt', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-7781' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ method: 'bank_deposit', changeGiven: 0, surplus: 0, partial: false, stillOwed: 0 })
    expect(await row(b.ids[0])).toMatchObject({ status: 'settled', manual_method: 'bank_deposit', platform_held: false })
    const rem = (await db.query<any>(
      `SELECT payment_method, reference, amount::float AS amount, gross_amount, processing_fee_amount::float AS fee, deposit_photo_url
         FROM tenant_remittances WHERE id = $1`, [res.body.data.receiptId])).rows[0]
    expect(rem).toEqual({ payment_method: 'bank_deposit', reference: 'DEP-7781', amount: 600, gross_amount: null, fee: 0, deposit_photo_url: null })
    // Free: nothing else was charged to anyone — the bill's one row, and no platform revenue booked.
    expect((await db.query(`SELECT 1 FROM payments WHERE tenant_id = $1`, [s.tenantId])).rowCount).toBe(1)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE landlord_id = $1`, [s.landlordId]).catch(() => ({ rowCount: 0 }))).rowCount).toBe(0)
    // The receipt says how it was paid.
    expect(emailPaymentReceipt).toHaveBeenCalledTimes(1)
    expect(emailPaymentReceipt.mock.calls[0][1]).toMatchObject({ method: 'bank deposit', reference: 'DEP-7781', amount: 600 })
  })

  it('never gives change: over the bill asks to confirm the amount on the bank\'s receipt, then keeps the extra as credit', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const ask = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 650, reference: 'DEP-1' })
    expect(ask.status).toBe(422)
    expect(ask.body.error).toBe("You typed $650.00 against $600.00 owed — is the bank deposit really $650.00? Check the amount on the bank's receipt, then confirm.")
    const change = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 650, reference: 'DEP-1', surplusHandling: 'change', confirmWrittenAmount: true })
    expect(change.status).toBe(422)
    expect(change.body.error).toMatch(/No change can be given on a bank deposit/)
    const ok = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 650, reference: 'DEP-1', confirmWrittenAmount: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ changeGiven: 0, surplus: 50, surplusHandling: 'credit' })
    const credit = (await db.query<any>(
      `SELECT amount_original::float AS amount, funded_by FROM lease_prepaid_credits WHERE id = $1`, [ok.body.data.creditId])).rows[0]
    expect(credit).toEqual({ amount: 50, funded_by: 'landlord' })
  })

  it('is never cash on hand waiting to be deposited — a cash payment is', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const viaBank = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-2' })
    expect(viaBank.status).toBe(200)
    expect((await cashNotBanked(db, s.landlordId)).map(i => i.id)).not.toContain(viaBank.body.data.receiptId)
    // The same money handed over as cash is cash to take to the bank.
    const s2 = await stack()
    const b2 = await bill(s2, [{ type: 'rent', amount: 600 }])
    const cash = await record(s2, b2.ids[0], { method: 'cash', amountTendered: 600 })
    expect(cash.status).toBe(200)
    expect((await cashNotBanked(db, s2.landlordId)).map(i => i.id)).toContain(cash.body.data.receiptId)
  })

  it('is posted ahead the same way (reference required) from the tenant\'s page', async () => {
    const s = await stack()
    const missing = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 300 })
    expect(missing.status).toBe(422)
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 300, reference: 'DEP-AHEAD' })
    expect(posted.status).toBe(200)
    const rem = (await db.query<any>(`SELECT payment_method, reference FROM tenant_remittances WHERE id = $1`, [posted.body.data.remittanceId])).rows[0]
    expect(rem).toEqual({ payment_method: 'bank_deposit', reference: 'DEP-AHEAD' })
    expect((await cashNotBanked(db, s.landlordId)).map(i => i.id)).not.toContain(posted.body.data.remittanceId)
  })
})

// ─── 2. The photo of the bank's receipt ──────────────────────────────────────

describe('the photo of the bank\'s receipt', () => {
  it('goes only on a bank deposit, images only, and is served only to that landlord\'s own people', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-PHOTO' })
    expect(res.status).toBe(200)
    const receiptId = res.body.data.receiptId

    // Not an image: refused, nothing stored.
    const pdf = await uploadPhoto(receiptId, s.token, { contentType: 'application/pdf', filename: 'r.pdf' })
    expect(pdf.status).toBe(400)

    const up = await uploadPhoto(receiptId, s.token)
    expect(up.status).toBe(200)
    const url: string = up.body.data.depositPhotoUrl
    expect(url).toMatch(/^\/api\/payments\/deposit-photos\/[A-Za-z0-9_.-]+\.jpg$/)
    const servePath = url.replace(/^\/api\/payments/, '/api/payments')

    // The owner sees it.
    const own = await request(app()).get(servePath).set('Authorization', `Bearer ${s.token}`)
    expect(own.status).toBe(200)
    expect(Buffer.from(own.body).equals(tinyJpeg)).toBe(true)

    // Another landlord, the tenant, and a GAM admin do not — it reads as missing.
    const other = await stack()
    expect((await request(app()).get(servePath).set('Authorization', `Bearer ${other.token}`)).status).toBe(404)
    const tenantToken = sign(s.tenantUserId, 'tenant', { profileId: s.tenantId })
    expect((await request(app()).get(servePath).set('Authorization', `Bearer ${tenantToken}`)).status).toBe(404)
    const admin = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'G', 'Admin', TRUE) RETURNING id`, [`admin-${Date.now()}@t.dev`])).rows[0].id
    expect((await request(app()).get(servePath).set('Authorization', `Bearer ${sign(admin, 'admin')}`)).status).toBe(404)
    // Without signing in: nothing.
    expect((await request(app()).get(servePath)).status).toBe(401)

    // A staffer of this landlord assigned to ANOTHER property cannot see it; one at this property can.
    const mkStaff = async (propertyIds: string[]) => {
      const u = (await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'onsite_manager', 'Desk', 'Staff', TRUE) RETURNING id`,
        [`desk-${Math.random().toString(36).slice(2)}@t.dev`])).rows[0].id
      await db.query(
        `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions) VALUES ($1, $2, $3, $4::jsonb)`,
        [u, s.landlordId, propertyIds, JSON.stringify({ take_payment: true })])
      return sign(u, 'onsite_manager', { landlordId: s.landlordId, permissions: { take_payment: true } })
    }
    const elsewhere = (await db.query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
       VALUES ($1, 'Other Park', '1 Elm', 'Mattoon', 'IL', '61938', $2, $2) RETURNING id`, [s.landlordId, s.ownerUserId])).rows[0].id
    expect((await request(app()).get(servePath).set('Authorization', `Bearer ${await mkStaff([elsewhere])}`)).status).toBe(403)
    expect((await request(app()).get(servePath).set('Authorization', `Bearer ${await mkStaff([s.propertyId])}`)).status).toBe(200)

    // Another landlord cannot attach a photo to this receipt either.
    expect((await uploadPhoto(receiptId, other.token)).status).toBe(404)

    // The Payments ledger shows the reference and the photo to the landlord.
    const month = (b && (await db.query<{ m: string }>(`SELECT to_char(due_date, 'YYYY-MM') AS m FROM payments WHERE id = $1`, [b.ids[0]])).rows[0].m)
    const ledger = await request(app()).get(`/api/balances/payments-by-month?month=${month}`).set('Authorization', `Bearer ${s.token}`)
    expect(ledger.status).toBe(200)
    const line = (ledger.body.data.payments as any[]).find(p => p.receipt_id === receiptId || p.receiptId === receiptId)
    expect(line).toMatchObject({ method_label: 'Bank deposit', reference: 'DEP-PHOTO', deposit_photo_url: url })
  })

  it('is refused on a cash payment', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const cash = await record(s, b.ids[0], { method: 'cash', amountTendered: 600 })
    expect(cash.status).toBe(200)
    const up = await uploadPhoto(cash.body.data.receiptId, s.token)
    expect(up.status).toBe(409)
    expect(up.body.error).toMatch(/only on a payment recorded as a bank deposit/)
  })
})

// ─── 3. Part payments ────────────────────────────────────────────────────────

describe('Accept partial payments (per property, default off)', () => {
  it('off: a short payment is refused exactly as before', async () => {
    const s = await stack()
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const quote = await request(app()).get(`/api/payments/${b.ids[0]}/record-manual/quote`).set('Authorization', `Bearer ${s.token}`)
    expect(quote.body.data.partialPaymentsAllowed).toBe(false)
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-3' })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('That is $100.00 short — $500.00 against $600.00 owed. Rent is paid in full.')
    expect(await rowsOfInvoice(b.invoiceId)).toEqual([{ id: b.ids[0], type: 'rent', amount: 600, status: 'pending', is_remainder: false }])
  })

  it('the setting is the landlord\'s to turn on and off on the property', async () => {
    const s = await stack()
    const on = await request(app()).patch(`/api/properties/${s.propertyId}/partial-payments`).set('Authorization', `Bearer ${s.token}`).send({ accept: true })
    expect(on.status).toBe(200)
    expect(on.body.data.acceptPartialPayments).toBe(true)
    const got = await request(app()).get(`/api/properties/${s.propertyId}`).set('Authorization', `Bearer ${s.token}`)
    expect(got.body.data.acceptPartialPayments ?? got.body.data.accept_partial_payments).toBe(true)
    const other = await stack()
    const forbidden = await request(app()).patch(`/api/properties/${s.propertyId}/partial-payments`).set('Authorization', `Bearer ${other.token}`).send({ accept: false })
    expect(forbidden.status).toBe(403)
    const off = await request(app()).patch(`/api/properties/${s.propertyId}/partial-payments`).set('Authorization', `Bearer ${s.token}`).send({ accept: false })
    expect(off.body.data.acceptPartialPayments).toBe(false)
  })

  it('on: $500 against $600 rent settles $500 and the $100 rest stays open on the same bill — every dollar counted once', async () => {
    const s = await stack({ partial: true })
    const b = await bill(s, [{ type: 'rent', amount: 600 }])
    const quote = await request(app()).get(`/api/payments/${b.ids[0]}/record-manual/quote`).set('Authorization', `Bearer ${s.token}`)
    expect(quote.body.data.partialPaymentsAllowed).toBe(true)
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-4' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, stillOwed: 100, amountSettled: 500, changeGiven: 0, surplus: 0 })
    const rows = await rowsOfInvoice(b.invoiceId)
    expect(rows).toEqual([
      { id: b.ids[0], type: 'rent', amount: 500, status: 'settled', is_remainder: false },
      { id: expect.any(String), type: 'rent', amount: 100, status: 'pending', is_remainder: true },
    ])
    const rest = await row(rows[1].id)
    expect(rest).toMatchObject({ invoice_id: b.invoiceId, due_date: (await row(b.ids[0])).due_date, notes: PART_PAYMENT_REST_NOTE })
    // The paid slice says so in plain words — and that is a payment tag, never
    // shown as what the charge is (no "separate row" on any screen or email).
    expect((await row(b.ids[0])).notes).toMatch(/^paid in part; \$100\.00 still owed — Recorded as manual bank deposit payment/)
    expect(res.body.data.stillOwedRows).toEqual([expect.objectContaining({ id: rows[1].id, amount: 100, restOf: b.ids[0], type: 'rent' })])
    // The receipt and where its money went: $500, all of it on the paid slice.
    const rem = (await db.query<any>(`SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied FROM tenant_remittances WHERE id = $1`, [res.body.data.receiptId])).rows[0]
    expect(rem).toEqual({ amount: 500, applied: 500, unapplied: 0 })
    const apps = (await db.query<any>(`SELECT payment_id, amount_applied::float AS amount FROM remittance_applications WHERE remittance_id = $1`, [res.body.data.receiptId])).rows
    expect(apps).toEqual([{ payment_id: b.ids[0], amount: 500 }])
    expect((await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0].status).toBe('partial')
    // The receipt says what was paid and what is still owed.
    expect(emailPaymentReceipt).toHaveBeenCalledTimes(1)
    const args = emailPaymentReceipt.mock.calls[0][1]
    expect(args.amount).toBe(500)
    expect(args.lines).toEqual([expect.objectContaining({ amount: 500, detail: expect.stringMatching(/paid in part$/) })])
    expect(args.lines[0].detail).not.toMatch(/separate row|still owed/)
    expect(args.stillOwed).toEqual([expect.objectContaining({ amount: 100 })])

    // The rest is paid later — in full this time — and the bill closes.
    const restPaid = await record(s, rows[1].id, { method: 'cash', amountTendered: 100 })
    expect(restPaid.status).toBe(200)
    expect(restPaid.body.data.partial).toBe(false)
    expect((await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [b.invoiceId])).rows[0].status).toBe('settled')
  })

  it('pays the oldest bill first: September in full, then part of October', async () => {
    const s = await stack({ partial: true })
    const sep = await bill(s, [{ type: 'rent', amount: 600 }], 31)
    const oct = await bill(s, [{ type: 'rent', amount: 600 }], 0)
    const res = await record(s, oct.ids[0], { method: 'cash', amountTendered: 800 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, stillOwed: 400, changeGiven: 0 })
    expect(await rowsOfInvoice(sep.invoiceId)).toEqual([{ id: sep.ids[0], type: 'rent', amount: 600, status: 'settled', is_remainder: false }])
    expect((await rowsOfInvoice(oct.invoiceId)).map(r => [r.amount, r.status, r.is_remainder])).toEqual([[200, 'settled', false], [400, 'pending', true]])
  })

  it('passes by a bill that cannot be paid in part and keeps what is left as credit', async () => {
    const s = await stack({ partial: true })
    const b = await bill(s, [{ type: 'rent', amount: 600 }, { type: 'utility', amount: 50 }], 0)
    const res = await record(s, b.ids[0], { method: 'check', amountTendered: 620, reference: '1042' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, stillOwed: 50, amountSettled: 600, surplus: 20, surplusHandling: 'credit' })
    expect((await row(b.ids[0])).status).toBe('settled')
    expect(await row(b.ids[1])).toMatchObject({ status: 'pending', amount: 50 })
    expect(res.body.data.stillOwedRows).toEqual([expect.objectContaining({ id: b.ids[1], amount: 50, restOf: null })])
  })

  it('late fees keep applying to the rest, on the whole month\'s rent as the lease says', async () => {
    const s = await stack({ partial: true })
    await db.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = 3,
              late_fee_initial_type = 'percent_of_rent', late_fee_initial_amount = 10
        WHERE id = $1`, [s.leaseId])
    const b = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-LATE' })
    expect(res.status).toBe(200)
    await generateLateFeesForInvoice(b.invoiceId)
    const fees = (await db.query<{ amount: number }>(
      `SELECT amount::float AS amount FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [b.invoiceId])).rows
    // 10% of the month's $600 rent — as if unpaid — not 10% of the $100 rest.
    expect(fees).toEqual([{ amount: 60 }])
  })

  it('a bill paid in full on time gets no late fee (the contrast)', async () => {
    const s = await stack({ partial: true })
    await db.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = 3,
              late_fee_initial_type = 'flat', late_fee_initial_amount = 25 WHERE id = $1`, [s.leaseId])
    const b = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    expect((await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-FULL' })).status).toBe(200)
    await generateLateFeesForInvoice(b.invoiceId)
    expect((await db.query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [b.invoiceId])).rowCount).toBe(0)
  })

  it('no on-time or late mark on a part payment; the bill gets its mark the day it is paid in full', async () => {
    const s = await stack({ partial: true })
    await db.query(`UPDATE leases SET late_fee_grace_days = 3 WHERE id = $1`, [s.leaseId])
    const b = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    const part = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-MARK' })
    expect(part.status).toBe(200)
    const restId = part.body.data.stillOwedRows[0].id
    expect(await marksOn([b.ids[0], restId])).toEqual([])
    const full = await record(s, restId, { method: 'cash', amountTendered: 100 })
    expect(full.status).toBe(200)
    const marks = await marksOn([b.ids[0], restId])
    expect(marks).toHaveLength(1)
    expect(marks[0].payment_id).toBe(restId)
    // Paid in full ten days after the due date, past a three-day grace: late —
    // counted from the bill the rest belongs to, not from the day the rest row was written.
    expect(marks[0].event_type).toMatch(/^payment_received_late_/)
  })

  it('a bank deposit counts from the day it was deposited, not the day it was typed in', async () => {
    const s = await stack()
    await db.query(`UPDATE leases SET late_fee_grace_days = 3 WHERE id = $1`, [s.leaseId])
    const b = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    const dueDay = (await row(b.ids[0])).due_date as string
    // A date in the future, a date on cash, and a date that is not real are refused.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'D-F', depositedOn: tomorrow })).body.error)
      .toBe('The date deposited cannot be after today.')
    expect((await record(s, b.ids[0], { method: 'cash', amountTendered: 600, depositedOn: dueDay })).body.error)
      .toBe('A deposit date is taken only for a bank deposit.')
    expect((await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'D-X', depositedOn: '2026-02-31' })).status).toBe(422)
    expect(await row(b.ids[0])).toMatchObject({ status: 'pending' })
    // Deposited on the due date, logged ten days later: on time.
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'D-ONTIME', depositedOn: dueDay })
    expect(res.status).toBe(200)
    const settledOn = (await db.query<{ d: string }>(
      `SELECT (settled_at AT TIME ZONE 'UTC')::date::text AS d FROM payments WHERE id = $1`, [b.ids[0]])).rows[0].d
    expect(settledOn).toBe(dueDay)
    const remOn = (await db.query<{ d: string }>(
      `SELECT (settled_at AT TIME ZONE 'UTC')::date::text AS d FROM tenant_remittances WHERE id = $1`, [res.body.data.receiptId])).rows[0].d
    expect(remOn).toBe(dueDay)
    const marks = await marksOn([b.ids[0]])
    expect(marks.map(m => m.event_type)).toEqual(['payment_received_on_time'])
  })

  it('the Front Desk list says whether the household can pay part', async () => {
    const off = await stack()
    await bill(off, [{ type: 'rent', amount: 600 }], 2)
    const on = await stack({ partial: true })
    await bill(on, [{ type: 'rent', amount: 600 }], 2)
    const rowsOf = async (t: Stack) => (await request(app()).get('/api/balances').set('Authorization', `Bearer ${t.token}`)).body.data
    expect((await rowsOf(off)).map((r: any) => r.accept_partial_payments)).toEqual([false])
    expect((await rowsOf(on)).map((r: any) => r.accept_partial_payments)).toEqual([true])
  })

  it('online payments still pay in full, even where the property takes part payments', async () => {
    const s = await stack({ partial: true })
    await bill(s, [{ type: 'rent', amount: 600 }])
    await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_test' WHERE id = $1`, [s.tenantId])
    const { chargeLeaseBalance } = await import('../services/rentCharge')
    await expect(chargeLeaseBalance({
      tenantId: s.tenantId, leaseId: s.leaseId, amount: 500,
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal',
    })).rejects.toThrow(/Rent must be paid in full/)
  })
})

// ── 10/5 (Nic): a bank deposit dated before late fees were charged ──────────
//
// "late fees go by when the tenant actually made the deposit" (S624). The
// office logs a resident's bank deposit days later, from the bank's receipt;
// a late fee charged for a day after the money was in the bank was never
// owed. Paid in full, it comes off exactly as a tenant's corroborated report
// takes it off; paid in part, every late fee stays.
describe('a bank deposit dated before a late fee', () => {
  /** A $600 rent bill due ten days ago, with a $25 late fee charged five days after the due date. */
  async function lateBill(opts: { partial?: boolean; feeSettled?: boolean } = {}) {
    const s = await stack({ partial: opts.partial })
    const b = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    const dueDay = (await row(b.ids[0])).due_date as string
    const feeDay = (await db.query<{ d: string }>(`SELECT ($1::date + 5)::text AS d`, [dueDay])).rows[0].d
    const feeId = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description, settled_at, manual_method)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,$6,$7::date,'LATEFEE',
               CASE WHEN $6 = 'settled' THEN NOW() END, CASE WHEN $6 = 'settled' THEN 'cash' END) RETURNING id`,
      [s.landlordId, s.tenantId, s.unitId, s.leaseId, b.invoiceId, opts.feeSettled ? 'settled' : 'pending', feeDay])).rows[0].id
    return { s, b, dueDay, feeDay, feeId }
  }
  const quote = (s: Stack, anchor: string, depositedOn?: string) => request(app())
    .get(`/api/payments/${anchor}/record-manual/quote${depositedOn ? `?depositedOn=${depositedOn}` : ''}`)
    .set('Authorization', `Bearer ${s.token}`)

  it('the window’s bill leaves the fee off when the deposit was made before it — and changes nothing', async () => {
    const { s, b, dueDay, feeId } = await lateBill()
    const plain = await quote(s, b.ids[0])
    expect(plain.body.data.currentTotal).toBe(625)
    const dated = await quote(s, b.ids[0], dueDay)
    expect(dated.status).toBe(200)
    expect(dated.body.data.currentTotal).toBe(600)
    expect(dated.body.data.lateFeesOffIfPaidInFull).toBe(25)
    // A quote is only a look: the fee is still owed until the payment is recorded.
    expect(await row(feeId)).toMatchObject({ amount: 25, status: 'pending' })
  })

  it('paid in full: the late fee charged after the deposit comes off (zeroed, kept, with the reason)', async () => {
    const { s, b, dueDay, feeId } = await lateBill()
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-BACK', depositedOn: dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.lateFeesUnbilled).toBe(25)
    expect(res.body.data.lateFeesRefunded).toBe(0)
    const fee = await row(feeId)
    expect(fee).toMatchObject({ amount: 0, status: 'settled' })
    expect(fee.notes).toContain(`Reversed: rent was paid ${dueDay}, before this fee accrued`)
    expect(await row(b.ids[0])).toMatchObject({ status: 'settled', manual_method: 'bank_deposit' })
    // 10/6 (Nic): the tenant never reported this deposit and the fee had
    // already posted, so the landlord had to find it — the fee is still
    // zeroed, but the bill counts from the day it was recorded (late), not the
    // deposit's day (routes/lateFeeDelete.test.ts has the reported case).
    expect((await marksOn([b.ids[0]])).map(m => m.event_type)).toEqual([expect.stringMatching(/^payment_received_late_/)])
    expect(res.body.data.unreportedDepositCountsLate).toBe(true)
  })

  it('a late fee the tenant already paid comes back as a late-fee refund credit', async () => {
    const { s, b, dueDay, feeId } = await lateBill({ feeSettled: true })
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-REF', depositedOn: dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.lateFeesRefunded).toBe(25)
    expect(await row(feeId)).toMatchObject({ amount: 25, status: 'settled' })   // money that moved is not erased
    const credit = (await db.query(
      `SELECT amount_original::float AS amount, category FROM tenant_credits WHERE tenant_id = $1`, [s.tenantId])).rows
    expect(credit).toEqual([{ amount: 25, category: 'late_fee_refund' }])
  })

  it('paid only in part: the late fee stays', async () => {
    const { s, b, dueDay, feeId } = await lateBill({ partial: true })
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 500, reference: 'DEP-PART', depositedOn: dueDay })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.partial).toBe(true)
    expect(res.body.data.lateFeesUnbilled).toBe(0)
    expect(await row(feeId)).toMatchObject({ amount: 25, status: 'pending' })
    expect(res.body.data.stillOwed).toBe(125)
  })

  it('a fee charged on or before the deposit date was earned and stays (the money is then short)', async () => {
    const { s, b, feeDay, feeId } = await lateBill()
    const res = await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-LATE', depositedOn: feeDay })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/\$25\.00 short/)
    expect(await row(feeId)).toMatchObject({ amount: 25, status: 'pending' })
    expect(await row(b.ids[0])).toMatchObject({ status: 'pending' })
  })

  it('a deposit date in the future is refused, on the window and when posted', async () => {
    const { s, b, feeId } = await lateBill()
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 600, reference: 'D-F', depositedOn: later })).body.error)
      .toBe('The date deposited cannot be after today.')
    expect((await quote(s, b.ids[0], later)).status).toBe(422)
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 600, reference: 'D-F', receivedAt: later })
    expect(posted.status).toBe(422)
    expect(posted.body.error).toBe('The date deposited cannot be after today.')
    expect(await row(feeId)).toMatchObject({ amount: 25, status: 'pending' })
  })

  // 10/5 (Nic): judged BILL BY BILL. "A bill paid in full gets the reversal; a
  // bill paid only in part keeps its late fees" — never the household at once.
  it('two bills: the one the deposit pays in full loses its later fee, the one it pays only in part keeps its own', async () => {
    const s = await stack({ partial: true })
    const sept = await bill(s, [{ type: 'rent', amount: 600 }], 40)
    const oct = await bill(s, [{ type: 'rent', amount: 600 }], 10)
    const octDue = (await row(oct.ids[0])).due_date as string
    const feeDay = (await db.query<{ d: string }>(`SELECT ($1::date + 5)::text AS d`, [octDue])).rows[0].d
    const addFee = async (invoiceId: string) => (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending',$6::date,'LATEFEE') RETURNING id`,
      [s.landlordId, s.tenantId, s.unitId, s.leaseId, invoiceId, feeDay])).rows[0].id
    const septFee = await addFee(sept.invoiceId)
    const octFee = await addFee(oct.invoiceId)

    // The window shows each bill's fee, so a part payment can say which come back.
    const q = await quote(s, sept.ids[0], octDue)
    expect(q.body.data.lateFeesOffIfPaidInFull).toBe(50)
    expect(q.body.data.lateFeesOffByBill).toEqual(expect.arrayContaining([
      { invoiceId: sept.invoiceId, amount: 25 }, { invoiceId: oct.invoiceId, amount: 25 },
    ]))

    // $900 deposited the day October was due: September ($600) in full, October in part.
    const res = await record(s, sept.ids[0], { method: 'bank_deposit', amountTendered: 900, reference: 'DEP-2BILLS', depositedOn: octDue })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.partial).toBe(true)
    expect(res.body.data.lateFeesUnbilled).toBe(25)
    expect(await row(septFee)).toMatchObject({ amount: 0, status: 'settled' })
    expect(await row(sept.ids[0])).toMatchObject({ status: 'settled' })
    expect(await row(octFee)).toMatchObject({ amount: 25, status: 'pending' })
    // October: $300 paid, $300 rest open, and its $25 fee still owed.
    expect(res.body.data.stillOwed).toBe(325)
  })

  it('the date can\'t be after today where the PROPERTY is — never UTC\'s calendar', async () => {
    const { s, b } = await lateBill()
    const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const nextDay = (d: string) => new Date(Date.parse(d + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10)
    // Far behind UTC: the property's tomorrow is often UTC's today — refused all the same.
    await db.query(`UPDATE properties SET timezone = 'Pacific/Pago_Pago' WHERE id = $1`, [s.propertyId])
    const tomorrow = nextDay(todayIn('Pacific/Pago_Pago'))
    expect((await quote(s, b.ids[0], tomorrow)).status).toBe(422)
    expect((await record(s, b.ids[0], { method: 'bank_deposit', amountTendered: 625, reference: 'D-TZ', depositedOn: tomorrow })).body.error)
      .toBe('The date deposited cannot be after today.')
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 625, reference: 'D-TZ', receivedAt: tomorrow })
    expect(posted.body.error).toBe('The date deposited cannot be after today.')
    // Far ahead of UTC: the property's today is often UTC's tomorrow — taken.
    await db.query(`UPDATE properties SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [s.propertyId])
    expect((await quote(s, b.ids[0], todayIn('Pacific/Kiritimati'))).status).toBe(200)
  })

  it('"Post a payment" takes the same date the same way: paid in full, the fee comes off', async () => {
    const { s, dueDay, feeId } = await lateBill()
    const posted = await request(app()).post('/api/payments/post-payment').set('Authorization', `Bearer ${s.token}`)
      .send({ tenantId: s.tenantId, method: 'bank_deposit', amount: 600, reference: 'D-POST', receivedAt: dueDay })
    expect(posted.status, JSON.stringify(posted.body)).toBe(200)
    expect(posted.body.data.lateFeesUnbilled).toBe(25)
    expect(posted.body.data.paidAhead).toBe(0)
    expect(await row(feeId)).toMatchObject({ amount: 0, status: 'settled' })
  })
})
