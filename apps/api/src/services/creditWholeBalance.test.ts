/**
 * 10/6 (Nic) — credit goes against the WHOLE balance, never line by line.
 *
 *   "Credits need to not settle by line item. It needs to be a credit against
 *    the entire balance ... So why the hell would the credit not be applied to
 *    the entire balance? Why is it trying to settle line items? ... his
 *    outstanding balance is really only $17.64." And, of the Bowmans' $500
 *    bank deposit: "why is it talking about credit when they didn't even make
 *    a full payment to begin with?"
 *
 *   1. Marc Renspurger's exact case: $297.06 paid ahead against $300 rent +
 *      $14.70 electric — $17.64 owed, and no line marked as covered by credit
 *      "collected by the landlord".
 *   2. Credit larger than the balance: everything paid, the rest stays credit.
 *   3. Oldest bill first, across months.
 *   4. The desk's "Use" applies credit that pays only part of the bill (the
 *      pay-in-full rule governs their own money, never their credit) — and
 *      still refuses a tenant's own short cash where part payments are off.
 *   5. The portal's figures: the bill, the credit applied, what is still owed.
 *   6. The Bowmans' $500 part payment: no credit anywhere.
 *   7. The data fix: a dry run changes nothing; --apply fixes Marc to $17.64
 *      and zeroes his six late fees; a second run finds nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'

const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel, list: async () => ({ data: [] }) } }),
}))
const emailPaymentReceipt = vi.hoisted(() => vi.fn(async (..._a: any[]) => 'msg_test'))
vi.mock('./email', async (orig) => ({
  ...(await orig<typeof import('./email')>()),
  emailPaymentReceipt,
  sendNotificationEmail: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedAllocationRule } from '../test/dbHelpers'
import { paymentsRouter } from '../routes/payments'
import { balancesRouter } from '../routes/balances'
import { errorHandler } from '../middleware/errorHandler'
import { createPaidAhead, createIssuedCredit, settleWholeBillIfCovered, householdQuote } from './creditUse'
import {
  applyCreditToWholeBalance, CREDIT_SHOULD_HAVE_PAID_NOTE, EXEMPT_BILL_NOTE,
} from '../scripts/oct6_apply_credit_to_whole_balance'

const TZ = 'America/Phoenix'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use('/api/balances', balancesRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPaymentReceipt.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_credit_whole_balance'
})

const sign = (userId: string, role: string, extra: Record<string, unknown> = {}) => jwt.sign(
  { userId, role, email: `${role}@t.dev`, permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Stack {
  landlordId: string; ownerUserId: string; propertyId: string; unitId: string; leaseId: string; tenantId: string
  tenantUserId: string; token: string; tenantToken: string
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

async function stack(opts: { partial?: boolean; bankDeposits?: boolean; rent?: number } = {}): Promise<Stack> {
  return tx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    await c.query(`UPDATE properties SET timezone = $2, accept_partial_payments = $3, tenants_deposit_at_bank = $4 WHERE id = $1`,
      [propertyId, TZ, opts.partial === true, opts.bankDeposits === true])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 300 })
    await c.query(`UPDATE units SET unit_number = 'RV 52' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 300, startDate: '2026-09-05' })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Marc', last_name = 'Renspurger' WHERE id = $1`, [tenantUserId])
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propertyId, unitId, leaseId, tenantId, tenantUserId,
      token: sign(ll.userId, 'landlord', { profileId: ll.landlordId }),
      tenantToken: sign(tenantUserId, 'tenant', { profileId: tenantId }),
    }
  })
}

type Line = { type: 'rent' | 'utility' | 'late_fee' | 'home_payment'; amount: number; due?: string; notes?: string }
const ENTRY: Record<Line['type'], string> = { rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE', home_payment: 'HOMEPMT' }

/** A bill due `due`, written `writtenAt` (the bill run's moment), with its lines. */
async function bill(s: Stack, due: string, lines: Line[], o: { writtenAt?: string; exempt?: boolean } = {}) {
  const writtenAt = o.writtenAt ?? `${due}T14:00:00Z`
  const total = lines.filter(l => l.type !== 'late_fee').reduce((t, l) => t + l.amount, 0)
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status,
                           late_fee_exempt, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,'pending',$8,$9::timestamptz) RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${Math.random().toString(36).slice(2, 9)}`, due, total, o.exempt === true, writtenAt])).rows[0].id
  const ids: string[] = []
  for (const l of lines) {
    ids.push((await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8::date,$9,$10,$11::timestamptz) RETURNING id`,
      [s.landlordId, s.tenantId, s.unitId, s.leaseId, l.type, l.amount, ENTRY[l.type], l.due ?? due, inv, l.notes ?? null, writtenAt])).rows[0].id)
  }
  return { invoiceId: inv, ids }
}

const paidAhead = (s: Stack, amount: number, receivedAt = '2026-09-22T18:00:00Z') =>
  tx(c => createPaidAhead(c, { leaseId: s.leaseId, tenantId: s.tenantId, amount, fundedBy: 'landlord', receivedAt }))
const issued = (s: Stack, amount: number) =>
  tx(c => createIssuedCredit(c, { landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.leaseId, amount, category: 'goodwill', reason: 'test', createdBy: s.ownerUserId }))
const wholeBalance = (s: Stack) =>
  tx(c => settleWholeBillIfCovered(c, { tenantId: s.tenantId, landlordId: s.landlordId, receipt: false }))
const row = async (id: string) => (await db.query<{ status: string; amount: number; on_it: number; notes: string | null }>(
  `SELECT p.status, p.amount::float AS amount, p.notes,
          (SELECT COALESCE(SUM(u.amount), 0) FROM credit_uses u WHERE u.payment_id = p.id AND u.status = 'applied')::float AS on_it
     FROM payments p WHERE p.id = $1`, [id])).rows[0]
const owedNow = async (s: Stack) => {
  const q = await tx(c => householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId, includeReleasable: false }))
  return Math.round(q.leases.reduce((t, l) => t + l.rows.filter(r => r.required)
    .reduce((x, r) => x + Math.round((r.amount - r.appliedOnRow) * 100), 0), 0)) / 100
}
const creditLeft = async (id: string) =>
  Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [id])).rows[0].r)

/** Marc's account as production had it on Oct 6: the old per-line draw paid the electric only. */
async function marcAsHeOct6(s: Stack) {
  const credit = await paidAhead(s, 297.06)
  const oct = await bill(s, '2026-10-01', [
    { type: 'rent', amount: 300 },
    { type: 'utility', amount: 14.70, notes: 'Electric meter 29229 → 29299 (Sep 2 → Sep 30) · 70 kWh' },
  ], { writtenAt: '2026-10-01T14:00:00Z' })
  const [rent, electric] = oct.ids
  // The old draw: $14.70 on the electric, settled with the misleading note.
  await db.query(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
     VALUES ($1,$2,$3,14.70,'2026-10-01','whole_bill','applied','2026-10-01T14:00:00Z')`, [credit, electric, s.leaseId])
  await db.query(
    `UPDATE payments SET status = 'settled', settled_at = '2026-10-01T14:00:00Z',
            notes = notes || ' — covered by prepaid credit (paid ahead) (collected by the landlord, not GAM)' WHERE id = $1`, [electric])
  // Six $5 late fees, Oct 1–6, on a bill marked late-fee exempt afterwards.
  const fees: string[] = []
  for (let d = 1; d <= 6; d++) {
    fees.push((await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1,$2,$3,$4,'late_fee',5,'pending','LATEFEE',$5::date,$6,'2026-10-06T07:00:00Z') RETURNING id`,
      [s.landlordId, s.tenantId, s.unitId, s.leaseId, `2026-10-0${d}`, oct.invoiceId])).rows[0].id)
  }
  await db.query(`UPDATE invoices SET late_fee_exempt = TRUE WHERE id = $1`, [oct.invoiceId])
  return { credit, invoiceId: oct.invoiceId, rent, electric, fees }
}

describe('1. Marc Renspurger: credit against the whole balance', () => {
  it('$297.06 paid ahead against $300 rent + $14.70 electric: $17.64 owed, the rent never cut in two', async () => {
    const s = await stack()
    const credit = await paidAhead(s, 297.06)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 14.70 }])
    await wholeBalance(s)
    expect(await creditLeft(credit)).toBe(0)
    expect(await owedNow(s)).toBe(17.64)
    // Oldest first, rent before electric on the same day: $297.06 on the rent,
    // $2.94 of it and the $14.70 electric still owed — never a row cut in two.
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', amount: 300, on_it: 297.06 })
    expect(await row(oct.ids[1])).toMatchObject({ status: 'pending', amount: 14.70, on_it: 0 })
  })

  it('his account as it stood: the $282.36 left goes on the rent — $14.70 + $282.36 applied, $17.64 owed', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    await db.query(`UPDATE payments SET amount = 0, status = 'settled', settled_at = now() WHERE id = ANY($1::uuid[])`, [m.fees])
    await wholeBalance(s)
    expect(await creditLeft(m.credit)).toBe(0)
    expect(await row(m.electric)).toMatchObject({ status: 'settled', on_it: 14.70 })
    expect(await row(m.rent)).toMatchObject({ status: 'pending', amount: 300, on_it: 282.36 })
    expect(await owedNow(s)).toBe(17.64)
  })

  it('the balance screen shows one balance — charges, credit applied, still owed — and no line "covered by … collected by the landlord"', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    await db.query(`UPDATE payments SET amount = 0, status = 'settled', settled_at = now() WHERE id = ANY($1::uuid[])`, [m.fees])
    await wholeBalance(s)
    const res = await request(app()).get(`/api/balances/${s.tenantId}/invoices`).set('Authorization', `Bearer ${s.token}`)
    expect(res.status).toBe(200)
    const inv = res.body.data.find((i: any) => i.id === m.invoiceId)
    // (The app's camelCase middleware is not on this test router: the wire is snake here.)
    expect(inv.balance).toBe(17.64)
    expect(inv.credit_applied).toBe(297.06)
    expect(inv.amount_paid).toBe(0)         // no money paid: never "paid $14.70 of $344.70"
    expect(inv.total_amount).toBe(314.70)
    for (const l of inv.lines) {
      expect(String(l.detail ?? '')).not.toMatch(/covered by|collected by the landlord|not GAM/i)
      expect(String(l.label)).not.toMatch(/covered by|collected by the landlord/i)
    }
    const electric = inv.lines.find((l: any) => l.id === m.electric)
    expect(electric.label).toBe('Electric')
    expect(electric.paid).toBe(0)
    expect(electric.credit_applied).toBe(14.70)
  })
})

describe('2–3. more credit than the balance; oldest bill first across months', () => {
  it('credit larger than the balance pays everything; the rest stays as credit', async () => {
    const s = await stack()
    const credit = await paidAhead(s, 500)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 14.70 }])
    const r = await wholeBalance(s)
    expect(r.settledIds.sort()).toEqual([...oct.ids].sort())
    expect(await owedNow(s)).toBe(0)
    expect(await creditLeft(credit)).toBe(185.30)
  })

  it('oldest bill first, across months: September\'s water in full, then part of October\'s rent', async () => {
    const s = await stack()
    const credit = await paidAhead(s, 100)
    const sep = await bill(s, '2026-09-01', [{ type: 'utility', amount: 50 }])
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    await wholeBalance(s)
    expect(await row(sep.ids[0])).toMatchObject({ status: 'settled', on_it: 50 })
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', on_it: 50 })
    expect(await owedNow(s)).toBe(250)
    expect(await creditLeft(credit)).toBe(0)
  })
})

describe('4. the desk: credit is never held back by the pay-in-full rule', () => {
  const record = (s: Stack, anchor: string, body: Record<string, unknown>) =>
    request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${s.token}`).send(body)

  it('"Use" with nothing handed over applies credit that pays only part of the bill — the rest stays owed', async () => {
    const s = await stack({ partial: false })
    await issued(s, 100)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    const res = await record(s, oct.ids[0], { method: 'cash', amountTendered: 0, creditToUse: 100 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ creditUsed: 100, amountSettled: 0, stillOwed: 200 })
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', amount: 300, on_it: 100 })
    expect(await owedNow(s)).toBe(200)
  })

  it('the pay-in-full rule still refuses a tenant\'s own short cash where part payments are off', async () => {
    const s = await stack({ partial: false })
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    const res = await record(s, oct.ids[0], { method: 'cash', amountTendered: 150 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/short.*Rent is paid in full/)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', on_it: 0 })
  })

  it('"Use" with cash that, with the credit, pays the bill: the credit goes on first, the cash pays the rest', async () => {
    const s = await stack({ partial: false })
    await issued(s, 100)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 20 }])
    const res = await record(s, oct.ids[0], { method: 'cash', amountTendered: 220, creditToUse: 100 })
    expect(res.status).toBe(200)
    expect(await owedNow(s)).toBe(0)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'settled', on_it: 100 })
  })
})

describe('5. the portal reads the same balance', () => {
  it('balance-context: the whole bill, less the credit already applied, is what is still owed', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    await db.query(`UPDATE payments SET amount = 0, status = 'settled', settled_at = now() WHERE id = ANY($1::uuid[])`, [m.fees])
    await wholeBalance(s)
    const res = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${s.tenantToken}`)
    expect(res.status).toBe(200)
    const lease = res.body.data.leases.find((l: any) => l.leaseId === s.leaseId)
    expect(lease.requiredNow).toBe(17.64)
    expect(lease.outstanding).toBe(300)
    expect(lease.usableCredit).toBe(0)
  })

  it('credit the landlord gave is offered at Pay against the whole balance, part of a line allowed', async () => {
    const s = await stack()
    await issued(s, 100)
    await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 14.70 }])
    const res = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${s.tenantToken}`)
    const lease = res.body.data.leases.find((l: any) => l.leaseId === s.leaseId)
    expect(lease.usableCredit).toBe(100)
    expect(lease.payIfSaved).toBe(314.70)
    expect(lease.payIfUsed).toBe(214.70)
  })
})

describe('6. the Bowmans: a $500 bank deposit against $639.60, part payments on', () => {
  it('pays $500 of it — $139.60 stays owed — and nothing anywhere becomes credit', async () => {
    const s = await stack({ partial: true, bankDeposits: true, rent: 450 })
    const oct = await bill(s, '2026-10-01', [
      { type: 'home_payment', amount: 100 },
      { type: 'rent', amount: 450 },
      { type: 'utility', amount: 39.60 },
      { type: 'late_fee', amount: 50, due: '2026-10-06' },
    ])
    const res = await request(app()).post(`/api/payments/${oct.ids[1]}/record-manual`).set('Authorization', `Bearer ${s.token}`)
      .send({ method: 'bank_deposit', amountTendered: 500, reference: 'DEP-BOWMAN' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, amountSettled: 500, stillOwed: 139.60, surplus: 0 })
    expect(res.body.data.creditId).toBeNull()
    expect(res.body.data.creditUsed).toBe(0)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE tenant_id = $1`, [s.tenantId])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM credit_uses WHERE lease_id = $1`, [s.leaseId])).rowCount).toBe(0)
    expect(await owedNow(s)).toBe(139.60)
    // The receipt says what was paid and what stays owed — no credit.
    const receipt = (await db.query<{ notes: string }>(`SELECT notes FROM tenant_remittances WHERE tenant_id = $1`, [s.tenantId])).rows[0]
    expect(receipt.notes).not.toMatch(/credit/i)
    expect(receipt.notes).toMatch(/Part payment: \$139\.60 still owed/)
  })
})

describe('7. the data fix (scripts/oct6_apply_credit_to_whole_balance)', () => {
  it('a dry run changes nothing', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    const alertsBefore = (await db.query(`SELECT 1 FROM admin_notifications`)).rowCount
    const c = await db.connect()
    let report
    try {
      await c.query('BEGIN')
      report = await applyCreditToWholeBalance(c, { tenantIds: [s.tenantId], zeroExemptFor: [s.tenantId] })
      await c.query('ROLLBACK')
    } finally { c.release() }
    expect(report.households).toHaveLength(1)
    expect(report.households[0].owedAfter).toBe(17.64)
    // Review fix: nothing is written outside the rolled-back transaction.
    expect((await db.query(`SELECT 1 FROM admin_notifications`)).rowCount).toBe(alertsBefore)
    expect(await creditLeft(m.credit)).toBe(282.36)
    expect(await row(m.rent)).toMatchObject({ status: 'pending', on_it: 0 })
    for (const f of m.fees) expect(await row(f)).toMatchObject({ status: 'pending', amount: 5 })
  })

  it('--apply fixes Marc to $17.64, zeroes his six late fees (never deletes them), and a second run finds nothing', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    const r = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId], zeroExemptFor: [s.tenantId] }))
    const h = r.households[0]
    expect(h.owedBefore).toBe(330)
    expect(h.owedAfter).toBe(17.64)
    expect(h.paidAheadBefore).toBe(282.36)
    expect(h.paidAheadAfter).toBe(0)
    expect(h.zeroed.map(z => z.paymentId).sort()).toEqual([...m.fees].sort())
    expect(h.zeroed.every(z => z.why === 'exempt_bill' && z.amount === 5)).toBe(true)
    expect(h.applied).toEqual([expect.objectContaining({ paymentId: m.rent, amount: 282.36, rowAmount: 300, nowOwed: 17.64 })])
    expect(h.listed).toEqual([])
    for (const f of m.fees) {
      const fee = await row(f)
      expect(fee).toMatchObject({ status: 'settled', amount: 0 })
      expect(fee.notes).toContain(EXEMPT_BILL_NOTE)
    }
    expect((await db.query(`SELECT 1 FROM payments WHERE id = ANY($1::uuid[])`, [m.fees])).rowCount).toBe(6)
    expect(await owedNow(s)).toBe(17.64)
    expect(await row(m.rent)).toMatchObject({ status: 'pending', amount: 300, on_it: 282.36 })

    const again = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId], zeroExemptFor: [s.tenantId] }))
    expect(again.households).toEqual([])
    expect(await owedNow(s)).toBe(17.64)
  })

  it('zeroes the late fees on a bill the money paid ahead would have paid in full; lists those on a bill it would not have', async () => {
    // Paid-ahead $400 received before October's $300 bill: October would have
    // been paid in full — its late fee goes. November's $300 bill after it:
    // $100 left would not have paid it — its late fee is listed, untouched.
    const s = await stack()
    const credit = await paidAhead(s, 400, '2026-09-20T18:00:00Z')
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'late_fee', amount: 25, due: '2026-10-06' }])
    const nov = await bill(s, '2026-11-01', [{ type: 'rent', amount: 300 }, { type: 'late_fee', amount: 25, due: '2026-11-06' }])
    const r = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId] }))
    const h = r.households[0]
    expect(h.zeroed).toEqual([expect.objectContaining({ paymentId: oct.ids[1], why: 'credit_would_have_paid' })])
    expect(h.listed).toEqual([expect.objectContaining({ paymentId: nov.ids[1] })])
    expect((await row(oct.ids[1])).notes).toContain(CREDIT_SHOULD_HAVE_PAID_NOTE)
    expect(await row(nov.ids[1])).toMatchObject({ status: 'pending', amount: 25 })
    expect(await row(oct.ids[0])).toMatchObject({ status: 'settled', on_it: 300 })
    expect(await row(nov.ids[0])).toMatchObject({ status: 'pending', on_it: 100 })
    expect(await creditLeft(credit)).toBe(0)
  })

  it('review fix: a late-fee-exempt bill of a household Nic did not name keeps its fees — listed, never zeroed', async () => {
    const s = await stack()
    const m = await marcAsHeOct6(s)
    const r = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId] }))
    const h = r.households[0]
    expect(h.zeroed).toEqual([])
    expect(h.listed.map(l => l.paymentId).sort()).toEqual([...m.fees].sort())
    expect(h.listed.every(l => /late-fee exempt/.test(l.why))).toBe(true)
    for (const f of m.fees) expect(await row(f)).toMatchObject({ status: 'pending', amount: 5 })
    // The money still goes on the balance.
    expect(await owedNow(s)).toBe(47.64)
  })

  it('review fix: a bill the tenant later paid part of with their own money is judged as issued — its fee is listed, not zeroed', async () => {
    // $600 rent, $200 paid ahead before the bill: the credit never covered it,
    // so its late fee was owed. The tenant then paid $450 at the desk (a part
    // payment: $450 slice settled, $150 rest open). $200 >= $150 must not make
    // the fee look like the credit's fault.
    const s = await stack({ rent: 600 })
    await paidAhead(s, 200, '2026-09-20T18:00:00Z')
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 600 }, { type: 'late_fee', amount: 25, due: '2026-10-06' }])
    await db.query(`UPDATE payments SET amount = 450, status = 'settled', settled_at = now() WHERE id = $1`, [oct.ids[0]])
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, entry_description, due_date, is_remainder)
       VALUES ($1,$2,$3,$4,$5,'rent',150,'pending','RENT','2026-10-01',TRUE)`, [s.landlordId, s.tenantId, s.unitId, s.leaseId, oct.invoiceId])
    const r = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId] }))
    const h = r.households[0]
    expect(h.zeroed).toEqual([])
    expect(h.listed).toEqual([expect.objectContaining({ paymentId: oct.ids[1] })])
    // Not zeroed: it stays a $25 fee. The live rule then puts the $200 paid
    // ahead on what is open, oldest first — the $150 rest, then the fee.
    const fee = await row(oct.ids[1])
    expect(fee).toMatchObject({ amount: 25, on_it: 25 })
    expect(fee.notes ?? '').not.toContain(CREDIT_SHOULD_HAVE_PAID_NOTE)
  })

  it('review fix: the monthly draw limit counts — a bill the limit would have kept the money off keeps its fee (listed)', async () => {
    const s = await stack()
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [s.leaseId])
    await paidAhead(s, 400, '2026-09-20T18:00:00Z')
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'late_fee', amount: 25, due: '2026-10-06' }])
    const r = await tx(c => applyCreditToWholeBalance(c, { tenantIds: [s.tenantId] }))
    const h = r.households[0]
    expect(h.zeroed).toEqual([])
    expect(h.listed).toEqual([expect.objectContaining({ paymentId: oct.ids[1] })])
  })
})

describe('review fix: a stay\'s rent for a month not yet due is never paid in part from money paid ahead', () => {
  it('paid ahead pays October in full; the rest waits as paid ahead instead of sitting on a future month a shortening could cut', async () => {
    const s = await stack()
    await db.query(`UPDATE leases SET lease_source = 'booking_draft', end_date = '2100-01-01' WHERE id = $1`, [s.leaseId])
    const credit = await paidAhead(s, 400)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    const later = await bill(s, '2099-12-01', [{ type: 'rent', amount: 300 }])
    await wholeBalance(s)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'settled', on_it: 300 })
    expect(await row(later.ids[0])).toMatchObject({ status: 'pending', on_it: 0 })
    expect(await creditLeft(credit)).toBe(100)
  })

  it('a future month the money covers in full is still paid (a shortening banks it back)', async () => {
    const s = await stack()
    await db.query(`UPDATE leases SET lease_source = 'booking_draft', end_date = '2100-01-01' WHERE id = $1`, [s.leaseId])
    const credit = await paidAhead(s, 700)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    const later = await bill(s, '2099-12-01', [{ type: 'rent', amount: 300 }])
    await wholeBalance(s)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'settled', on_it: 300 })
    expect(await row(later.ids[0])).toMatchObject({ status: 'settled', on_it: 300 })
    expect(await creditLeft(credit)).toBe(100)
  })
})
