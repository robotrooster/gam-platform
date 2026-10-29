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
 *   8. 10/15 (Nic): the same for every other kind of credit — "money gets
 *      applied to the most outstanding balance first. Somebody can't go put
 *      $1,000 credit and not pay a $2,000 existing bill" — and the one-time
 *      sweep of credit already sitting on the books.
 *   9. Money kept at the desk sits on the space that can actually spend it:
 *      the one in that park which still owes, and never one the draw passes
 *      over (a bank payment already on its way).
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
import { sweepCreditSittingWhileOwing } from '../scripts/oct18_credit_never_sits_while_owing'

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

/**
 * 10/15 (Nic) — CREDIT NEVER SITS WHILE THE HOUSEHOLD OWES.
 *
 *   "If somebody has an outstanding balance, why would they be able to add
 *    credit for future bills? Money gets applied to the most outstanding
 *    balance first. Somebody can't go put $1,000 credit and not pay a $2,000
 *    existing bill. It doesn't work like that."
 *
 * The 10/6 rule put MONEY PAID AHEAD on the balance by itself; everything
 * above tests that. These are the other two kinds of credit — the credit a
 * landlord gives and the interest GAM credits on a deposit — which used to
 * wait on the account for a choice nobody made.
 */
describe('8. credit the landlord gave goes on the balance too', () => {
  const issuedLeft = async (id: string) => Number((await db.query<{ r: string }>(
    `SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [id])).rows[0].r)
  const issuedCredit = (s: Stack, amount: number, category = 'goodwill') => tx(c => createIssuedCredit(c, {
    landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.leaseId, amount, category, reason: 'test',
    createdBy: s.ownerUserId,
  }))

  it('$1,000 of credit against a $2,000 balance pays the oldest bills; $1,000 is still owed and no credit is left', async () => {
    const s = await stack({ rent: 1000 })
    const credit = await issuedCredit(s, 1000)
    const sep = await bill(s, '2026-09-01', [{ type: 'rent', amount: 1000 }])
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 1000 }])
    await wholeBalance(s)
    expect(await row(sep.ids[0])).toMatchObject({ status: 'settled', on_it: 1000 })
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', on_it: 0 })
    expect(await owedNow(s)).toBe(1000)
    expect(await issuedLeft(credit)).toBe(0)
  })

  it('a credit smaller than the oldest line pays part of it; the line stays whole and open', async () => {
    const s = await stack()
    const credit = await issuedCredit(s, 10)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    await wholeBalance(s)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', amount: 300, on_it: 10 })
    expect(await owedNow(s)).toBe(290)
    expect(await issuedLeft(credit)).toBe(0)
  })

  it('statutory interest on their deposit goes on the balance the same way', async () => {
    const s = await stack()
    const credit = await issuedCredit(s, 24, 'deposit_interest')
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }])
    await wholeBalance(s)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', on_it: 24 })
    expect(await issuedLeft(credit)).toBe(0)
  })

  it('only what is over the whole balance stays as credit', async () => {
    const s = await stack()
    const credit = await issuedCredit(s, 500)
    await bill(s, '2026-10-01', [{ type: 'rent', amount: 300 }, { type: 'utility', amount: 14.70 }])
    await wholeBalance(s)
    expect(await owedNow(s)).toBe(0)
    expect(await issuedLeft(credit)).toBe(185.30)
  })

  // Credit never pays a home payment or a GAM fee, so money owed on one of
  // those is not a balance the credit is "sitting beside".
  it('a home payment is not a balance credit can pay: the credit stays on the account', async () => {
    const s = await stack()
    const credit = await issuedCredit(s, 50)
    const oct = await bill(s, '2026-10-01', [{ type: 'home_payment', amount: 100 }])
    await wholeBalance(s)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', on_it: 0 })
    expect(await issuedLeft(credit)).toBe(50)
  })

  // The one-time sweep of what was already on the books.
  it('the sweep: a dry run changes nothing; --apply puts it on the balance; a second run finds nothing', async () => {
    const s = await stack({ rent: 1000 })
    const credit = await issuedCredit(s, 400)
    const oct = await bill(s, '2026-10-01', [{ type: 'rent', amount: 1000 }])
    // Review fix (10/17): the sweep covers every company (the rule is
    // platform-wide), so each line names the company whose money moves.
    await db.query(`UPDATE landlords SET business_name = 'Mountain View RV Park Ranch LLC' WHERE id = $1`, [s.landlordId])

    const c = await db.connect()
    let dry
    try {
      await c.query('BEGIN')
      dry = await sweepCreditSittingWhileOwing(c)
      await c.query('ROLLBACK')
    } finally { c.release() }
    expect(dry).toHaveLength(1)
    expect(dry[0]).toMatchObject({
      name: 'Marc Renspurger', company: 'Mountain View RV Park Ranch LLC', spaces: 'RV 52',
      creditHeld: 400, owedBefore: 1000, creditHeldAfter: 0, owedAfter: 600, leftSitting: null,
    })
    // Rolled back: the books are as they were.
    expect(await issuedLeft(credit)).toBe(400)
    expect(await row(oct.ids[0])).toMatchObject({ on_it: 0 })

    const applied = await tx(c2 => sweepCreditSittingWhileOwing(c2))
    expect(applied).toHaveLength(1)
    expect(await issuedLeft(credit)).toBe(0)
    expect(await row(oct.ids[0])).toMatchObject({ status: 'pending', amount: 1000, on_it: 400 })
    expect(await owedNow(s)).toBe(600)

    expect(await tx(c3 => sweepCreditSittingWhileOwing(c3))).toEqual([])
  })
})

/**
 * 9. Review fix (10/17): money kept at the desk has to sit where it can be
 * SPENT. Money paid ahead pays only its own space's bills, and the balance draw
 * passes over a space with a bank payment already on its way — so the extra
 * lands on the space in the park the money arrived at that still owes and that
 * the draw can reach. Before this it could park on the space that had just been
 * paid (because the oldest bill of all was in another park), where nothing
 * could ever spend it.
 */
/** Another park of the same company. */
const park = (s: Stack) => tx(async c => {
  const propertyId = await seedProperty(c, {
    landlordId: s.landlordId, ownerUserId: s.ownerUserId, managedByUserId: s.ownerUserId,
  })
  await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
  await c.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, TZ])
  return propertyId
})

/** Another space for the same resident, with its own unit and lease. */
const space = (s: Stack, propertyId: string, unitNumber: string, rent: number) => tx(async c => {
  const unitId = await seedUnit(c, { propertyId, landlordId: s.landlordId, rentAmount: rent })
  await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
  const leaseId = await seedLease(c, { unitId, landlordId: s.landlordId, rentAmount: rent, startDate: '2026-09-05' })
  await seedLeaseTenant(c, { leaseId, tenantId: s.tenantId, role: 'primary' })
  return { unitId, leaseId }
})

/** A rent bill on one space. */
async function billOn(s: Stack, sp: { unitId: string; leaseId: string }, due: string, amount: number) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,'pending',$8::timestamptz) RETURNING id`,
    [s.landlordId, s.tenantId, sp.leaseId, sp.unitId, `INV-${Math.random().toString(36).slice(2, 9)}`, due, amount,
     `${due}T14:00:00Z`])).rows[0].id
  const id = (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,$7,$8::timestamptz) RETURNING id`,
    [s.landlordId, s.tenantId, sp.unitId, sp.leaseId, amount, due, inv, `${due}T14:00:00Z`])).rows[0].id
  return { invoiceId: inv, id }
}

describe('9. money kept at the desk sits where it can be spent', () => {
  const record = (s: Stack, anchor: string, body: Record<string, unknown>) =>
    request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${s.token}`).send(body)
  const keptCredit = async (creditId: string) => (await db.query<{ lease_id: string; left: number }>(
    `SELECT lease_id, amount_remaining::float AS left FROM lease_prepaid_credits WHERE id = $1`, [creditId])).rows[0]
  const appliedOn = async (id: string) => (await db.query<{ a: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS a FROM credit_uses WHERE payment_id = $1 AND status = 'applied'`, [id])).rows[0].a

  it('the extra goes on the space in this park that owes, not on the one just paid and not to another park', async () => {
    const s = await stack()                                  // RV 52, another park, the oldest bill of all
    const oakPark = await park(s)
    const mh04 = await space(s, oakPark, 'MH 04', 200)
    const mh09 = await space(s, oakPark, 'MH 09', 150)
    await bill(s, '2026-09-01', [{ type: 'rent', amount: 300 }])
    const picked = await billOn(s, mh04, '2026-10-01', 200)
    const owing = await billOn(s, mh09, '2026-10-05', 150)

    const res = await record(s, picked.id, {
      method: 'check', reference: '2201', amountTendered: 250, confirmWrittenAmount: true, bills: [picked.invoiceId],
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ surplus: 50, surplusHandling: 'credit' })
    // It sits on MH 09 — the only space in this park that still owes — and the
    // draw spent it there the moment the payment committed.
    const credit = await keptCredit(res.body.data.creditId)
    expect(credit.lease_id).toBe(mh09.leaseId)
    expect(credit.left).toBe(0)
    expect(await appliedOn(owing.id)).toBe('50.00')
    // The receipt stays where the money was taken, and says what the extra did.
    const rem = (await db.query<{ lease_id: string; notes: string }>(
      `SELECT lease_id, notes FROM tenant_remittances WHERE id = $1`, [res.body.data.receiptId])).rows[0]
    expect(rem.lease_id).toBe(mh04.leaseId)
    expect(rem.notes).toContain('$50.00 over the bill goes on what MH 09 still owes')
  })

  it('a space with a bank payment already on its way is passed over — the money goes to the next space that owes', async () => {
    const s = await stack()
    const oakPark = await park(s)
    const mh04 = await space(s, oakPark, 'MH 04', 200)
    const mh09 = await space(s, oakPark, 'MH 09', 150)
    const mh12 = await space(s, oakPark, 'MH 12', 120)
    const picked = await billOn(s, mh04, '2026-10-01', 200)
    const retrying = await billOn(s, mh09, '2026-09-10', 150)
    const owing = await billOn(s, mh12, '2026-10-05', 120)
    // MH 09's bill is the oldest, but GAM is going to try its bank again: that
    // pull is the payer's, so the draw leaves that space alone.
    await db.query(
      `UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_mh09_pull', next_retry_at = now() + interval '3 days'
        WHERE id = $1`, [retrying.id])

    const res = await record(s, picked.id, {
      method: 'check', reference: '2202', amountTendered: 250, confirmWrittenAmount: true, bills: [picked.invoiceId],
    })
    expect(res.status).toBe(200)
    const credit = await keptCredit(res.body.data.creditId)
    expect(credit.lease_id).toBe(mh12.leaseId)
    expect(credit.left).toBe(0)
    expect(await appliedOn(owing.id)).toBe('50.00')
    expect(await appliedOn(retrying.id)).toBe('0')
  })
})

/**
 * 10. 10/18 (Nic), correcting what shipped — A CREDIT GOES ON THE HOUSEHOLD'S
 * OLDEST BILL, WHATEVER SPACE IT IS ON.
 *
 *   "If a person has two households, right, two spaces, two bills for October,
 *    they can't pay one for October and then pay that same one for November. It
 *    does need to go on the October bill for the other spot."
 *
 * Billy Jose Miranda holds RV 34 and RV 35 at Oak Park, each with a September
 * and an October bill. A credit the landlord gives him must clear BOTH
 * Septembers before either October — it used to be fenced to the space it was
 * issued on, so it could clear one space's September AND October while the
 * other space's September sat open.
 *
 * Two things do not move. Money the tenant PAID AHEAD stays with the space they
 * paid it for (10/17): a promise to the payer, which due-date order never
 * overrides. So does statutory interest on a deposit — GAM owes it back with
 * THAT deposit. Where that leaves credit sitting while they owe, the sweep says
 * why in plain words.
 */
describe("10. credit crosses both of a household's spaces by due date", () => {
  const issuedOnSpace = (s: Stack, leaseId: string, amount: number, category = 'goodwill') => tx(c => createIssuedCredit(c, {
    landlordId: s.landlordId, tenantId: s.tenantId, leaseId, amount, category, reason: 'test', createdBy: s.ownerUserId,
  }))
  const appliedOn = async (id: string) => Number((await db.query<{ a: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS a FROM credit_uses WHERE payment_id = $1 AND status = 'applied'`, [id])).rows[0].a)

  /** Billy: two spaces in one park, each with a September and an October bill. */
  async function billy() {
    const s = await stack()
    await db.query(`UPDATE users SET first_name = 'Billy Jose', last_name = 'Miranda' WHERE id = $1`, [s.tenantUserId])
    const oakPark = await park(s)
    const rv34 = await space(s, oakPark, 'RV 34', 400)
    const rv35 = await space(s, oakPark, 'RV 35', 400)
    return {
      s, rv34, rv35,
      sep34: await billOn(s, rv34, '2026-09-01', 400),
      sep35: await billOn(s, rv35, '2026-09-01', 400),
      oct34: await billOn(s, rv34, '2026-10-01', 400),
      oct35: await billOn(s, rv35, '2026-10-01', 400),
    }
  }

  it('an $800 credit issued on RV 35 clears BOTH Septembers, not RV 35’s September and October', async () => {
    const b = await billy()
    const credit = await issuedOnSpace(b.s, b.rv35.leaseId, 800)
    await wholeBalance(b.s)
    expect(await appliedOn(b.sep34.id)).toBe(400)
    expect(await appliedOn(b.sep35.id)).toBe(400)
    expect(await appliedOn(b.oct34.id)).toBe(0)
    expect(await appliedOn(b.oct35.id)).toBe(0)
    expect(Number((await db.query<{ r: string }>(
      `SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [credit])).rows[0].r)).toBe(0)
    expect(await owedNow(b.s)).toBe(800)
  })

  it('$1,200 pays both Septembers and then the older October: RV 34 is clear, RV 35’s October is still owed', async () => {
    const b = await billy()
    // RV 34's October is the older of the two Octobers by its own row (same due
    // date, so the one allocation order decides) — the point is that neither
    // October is touched until both Septembers are paid.
    await issuedOnSpace(b.s, b.rv35.leaseId, 1200)
    await wholeBalance(b.s)
    expect(await appliedOn(b.sep34.id)).toBe(400)
    expect(await appliedOn(b.sep35.id)).toBe(400)
    expect(await appliedOn(b.oct34.id) + await appliedOn(b.oct35.id)).toBe(400)
    expect(await owedNow(b.s)).toBe(400)
  })

  // The whole-bill rule must not settle one space's bill over another space's
  // older one: there is only enough credit for the Septembers.
  it('neither space’s whole bill is settled while the other space’s September is open', async () => {
    const b = await billy()
    await issuedOnSpace(b.s, b.rv35.leaseId, 800)
    await wholeBalance(b.s)
    const status = async (id: string) => (await db.query<{ s: string }>(`SELECT status AS s FROM payments WHERE id = $1`, [id])).rows[0].s
    expect(await status(b.sep34.id)).toBe('settled')
    expect(await status(b.sep35.id)).toBe('settled')
    expect(await status(b.oct34.id)).toBe('pending')
    expect(await status(b.oct35.id)).toBe('pending')
  })

  // 10/17 (Nic): money paid ahead is the payer's, for the space they paid it
  // for. Due-date order never moves it to the other space.
  it('money paid ahead on RV 35 pays RV 35’s bills even though RV 34’s September is older', async () => {
    const b = await billy()
    const money = await tx(c => createPaidAhead(c, {
      leaseId: b.rv35.leaseId, tenantId: b.s.tenantId, amount: 800, fundedBy: 'landlord', receivedAt: '2026-09-22T18:00:00Z',
    }))
    await wholeBalance(b.s)
    expect(await appliedOn(b.sep35.id)).toBe(400)
    expect(await appliedOn(b.oct35.id)).toBe(400)
    expect(await appliedOn(b.sep34.id)).toBe(0)
    expect(await creditLeft(money)).toBe(0)
  })

  // And where that leaves money sitting on a space that owes nothing, the sweep
  // says why in plain words instead of guessing.
  it('money paid ahead on a space that owes nothing is left alone, and the sweep says why', async () => {
    const b = await billy()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = ANY($1::uuid[])`,
      [[b.sep35.id, b.oct35.id]])
    await tx(c => createPaidAhead(c, {
      leaseId: b.rv35.leaseId, tenantId: b.s.tenantId, amount: 500, fundedBy: 'landlord', receivedAt: '2026-09-22T18:00:00Z',
    }))
    const swept = await tx(c => sweepCreditSittingWhileOwing(c))
    expect(swept).toHaveLength(1)
    expect(swept[0].leftSitting).toMatch(/money they paid ahead on a space that does not owe/)
    expect(await appliedOn(b.sep34.id)).toBe(0)
  })

  // 10/18 review fix: the household's figures pool the credits of everyone on a
  // shared space, but a credit is still the credit of the ONE person it was
  // given to. A co-resident of RV 35 who does not hold RV 34 has no claim on RV
  // 34's bills, and the credit ledger refuses that row outright — so sending it
  // there did not just misplace the credit, it killed the whole draw (the bill
  // stayed open, the credit stayed unspent, and GAM got an alert).
  it('a co-resident’s credit pays the space they share, never the oldest bill on a space they do not hold — and the draw still runs', async () => {
    const b = await billy()
    // The oldest bill of all is on RV 34, which the co-resident does not hold.
    const aug34 = await billOn(b.s, b.rv34, '2026-08-01', 400)
    const mate = await tx(async c => {
      const id = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: b.rv35.leaseId, tenantId: id, role: 'co_tenant' })
      return id
    })
    // The co-resident's credit is given first, so it is spent first.
    const mateCredit = await tx(c => createIssuedCredit(c, {
      landlordId: b.s.landlordId, tenantId: mate, leaseId: b.rv35.leaseId, amount: 400,
      category: 'goodwill', reason: 'test', createdBy: b.s.ownerUserId,
    }))
    const billyCredit = await issuedOnSpace(b.s, b.rv35.leaseId, 400)
    await wholeBalance(b.s)
    // The co-resident's credit paid the space they share; Billy's own paid the
    // older bill on the space only he holds.
    expect(await appliedOn(b.sep35.id)).toBe(400)
    expect(await appliedOn(aug34.id)).toBe(400)
    expect(await appliedOn(b.sep34.id)).toBe(0)
    const spentOn = async (creditId: string) => (await db.query<{ lease_id: string }>(
      `SELECT lease_id FROM credit_uses WHERE tenant_credit_id = $1 AND status = 'applied'`, [creditId])).rows
      .map(r => r.lease_id)
    expect(await spentOn(mateCredit)).toEqual([b.rv35.leaseId])
    expect(await spentOn(billyCredit)).toEqual([b.rv34.leaseId])
  })

  it('statutory interest on RV 35’s deposit pays only RV 35', async () => {
    const b = await billy()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = ANY($1::uuid[])`,
      [[b.sep35.id, b.oct35.id]])
    const interest = await issuedOnSpace(b.s, b.rv35.leaseId, 24, 'deposit_interest')
    await wholeBalance(b.s)
    expect(await appliedOn(b.sep34.id)).toBe(0)
    expect(Number((await db.query<{ r: string }>(
      `SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [interest])).rows[0].r)).toBe(24)
  })
})
