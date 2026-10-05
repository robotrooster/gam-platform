/**
 * The Payments ledger, a monthly rent roll of payments (decisions #29, #26,
 * #35.1 and #36.A, Nic 10/3): GET /api/balances/payments-by-month.
 *
 * #35.1: "the Payments ledger/rent roll is filed by the BILL's month — each
 * payment sits under the month of the invoice it paid (its due month) and shows
 * the day it was paid (a late payer who paid September's bill in October
 * appears under SEPTEMBER, 'paid Oct 3, 2 days late')." #36.A: "a payment that
 * paid several bills shows under each bill's month with the part that went to
 * it ... the rent roll shows each month's bill as paid FROM the paid-ahead
 * credit on the day it was applied ... The arrival of the $5,000 itself is not
 * a rent-roll line." #29 (kept): one line per payment — who, space, date paid,
 * amount, method, what it paid for, and 'on time' or 'N days late' ...
 * Work-trade households get one line per month 'Work trade — covered' (no
 * amount) ... Bank payments still clearing are listed and marked 'clearing'; a
 * returned one is marked 'returned'. A month total shows only to owners /
 * property managers (#25). And S641, kept by #29: staff with only "View
 * payments" never see settled history.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// A real card dispute runs paymentReversal.handlePaymentReversal, as the live
// charge.dispute.created webhook does. Its side trips (the late-fee back-fill,
// the landlord's alert, the recovery decision) are not what these tests read.
vi.mock('../jobs/lateFees', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateLateFeesForInvoice: vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })),
}))
vi.mock('../services/responsibleParty', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), getPropertyResponsibleParty: vi.fn(async () => null),
}))
vi.mock('../services/reversalRecovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), decideReversalRecovery: vi.fn(async () => null),
}))

import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedUtilityMeter, seedUtilityBill } from '../test/dbHelpers'
import { todayIn, addDaysTo } from '../lib/timezone'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'
import { listOpenTenantBalances } from '../services/openBalances'
import {
  LEDGER_TOTAL_COUNTS_HELD_DEPOSITS, CREDIT_TAKEN_BACK_MARKS_RETURNED, LEDGER_PAYMENT_STATUS_LABEL,
  creditPaidOnDay, countsInLedgerTotal, isTrustHeldDeposit, ledgerPaymentStatus, returnedByPart,
} from '../services/paymentsByMonth'
import { createPaidAhead, runWholeBillCheckAfterCommit } from '../services/creditUse'
import { handlePaymentReversal } from '../services/paymentReversal'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema() })

let seq = 0
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function park() {
  return inTx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    return { ...ll, propertyId }
  })
}

async function resident(name: string) {
  return inTx(async c => {
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name=$2, last_name=$3 WHERE id=(SELECT user_id FROM tenants WHERE id=$1)`, [tenantId, first, last])
    return tenantId
  })
}

async function space(p: { landlordId: string; propertyId: string }, unitNumber: string) {
  return inTx(async c => {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    await c.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId })
    return { unitId, leaseId }
  })
}

const ENTRY: Record<string, string> = { late_fee: 'LATEFEE', home_payment: 'HOMEPMT', fee: 'OTHERFEE', deposit: 'DEPOSIT' }
/**
 * One bill (invoice) with these lines; returns the charge ids in order. Every
 * line is written the way the product writes it: revenue_owner is left to its
 * default ('landlord'), exactly as jobs/moveInBundle writes a security deposit.
 */
async function bill(p: { landlordId: string }, tenantId: string, s: { unitId: string; leaseId: string },
                    dueDate: string, lines: Array<[string, number, string?]>): Promise<string[]> {
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [p.landlordId, tenantId, s.leaseId, s.unitId, `INV-PL-${++seq}`, dueDate, lines.reduce((a, [, x]) => a + x, 0)])
  const ids: string[] = []
  for (const [type, amt, notes] of lines) {
    ids.push((await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING id`,
      [inv.rows[0].id, s.unitId, s.leaseId, tenantId, p.landlordId, type, amt, dueDate, ENTRY[type] ?? type.toUpperCase(), notes ?? null])).rows[0].id)
  }
  return ids
}

interface ReceiptIn {
  tenantId: string; leaseId: string; landlordId: string
  amount: number; applied: number; unapplied?: number
  method: 'ach' | 'card' | 'cash' | 'check' | 'money_order'
  status?: 'processing' | 'settled' | 'failed'
  createdAt: string; settledAt?: string | null; pi?: string | null
}
async function receipt(r: ReceiptIn): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                     payment_method, stripe_payment_intent_id, created_at, settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz) RETURNING id`,
    [r.tenantId, r.leaseId, r.landlordId, r.amount, r.applied, r.unapplied ?? 0, r.status ?? 'settled', r.method,
     r.pi ?? null, r.createdAt, r.status === 'processing' || r.status === 'failed' ? null : (r.settledAt ?? r.createdAt)])).rows[0].id
}
async function apply(remittanceId: string, paymentId: string, amount: number) {
  await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [remittanceId, paymentId, amount])
}
async function settle(ids: string[], at: string, manualMethod: string | null = null, pi: string | null = null) {
  await db.query(
    `UPDATE payments SET status='settled', settled_at=$2::timestamptz, manual_method=$3,
            stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id) WHERE id = ANY($1::uuid[])`,
    [ids, at, manualMethod, pi])
}

const ownerToken = (f: { userId: string; landlordId: string }) => jwt.sign(
  { userId: f.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds: [f.landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

async function teamToken(f: { landlordId: string }, role: 'property_manager' | 'onsite_manager',
                         permissions: Record<string, boolean>, propertyIds: string[] | null = null) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`,
    [`${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,$3,$4)`,
    [u.rows[0].id, f.landlordId, propertyIds === null, propertyIds ?? []])
  return jwt.sign({ userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: f.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

async function ledger(token: string, month?: string) {
  return request(buildApp()).get(`/api/balances/payments-by-month${month ? `?month=${month}` : ''}`)
    .set('Authorization', `Bearer ${token}`)
}

describe('decisions #35.1: a payment is filed under the month of the bill it paid', () => {
  it('a September bill paid on Oct 3 is September\'s, "paid Oct 3", late from its due date', async () => {
    const p = await park()
    const t = await resident('Lou Later')
    const s = await space(p, 'RV 20')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 450]])
    // Oct 3, 10 am in Phoenix.
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 450, applied: 450,
      method: 'cash', createdAt: '2026-10-03T17:00:00Z' })
    await apply(r, rent, 450)
    await settle([rent], '2026-10-03T17:00:00Z', 'cash')
    const sept = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(sept.payments).toHaveLength(1)
    expect(sept.payments[0]).toMatchObject({
      id: r, paid_on: '2026-10-03', arrived_on: '2026-10-03', amount: 450, paid_for: 'September rent',
      days_late: 32, timing_label: '32 days late',
    })
    expect((await ledger(ownerToken(p), '2026-10')).body.data.payments).toEqual([])
  })

  it('a bank payment made Sept 28 for October\'s bill is October\'s: the day it was made, the day it cleared', async () => {
    const p = await park()
    const t = await resident('Ann Arrival')
    const s = await space(p, 'RV 1')
    const [rent] = await bill(p, t, s, '2026-10-01', [['rent', 440]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 440, applied: 440,
      method: 'ach', createdAt: '2026-09-28T18:00:00Z', settledAt: '2026-10-02T18:00:00Z', pi: 'pi_arrive' })
    await apply(r, rent, 440)
    await settle([rent], '2026-10-02T18:00:00Z', null, 'pi_arrive')
    const sept = await ledger(ownerToken(p), '2026-09')
    expect(sept.body.data.payments).toEqual([])
    const oct = await ledger(ownerToken(p), '2026-10')
    expect(oct.status).toBe(200)
    const [pay] = oct.body.data.payments
    expect(pay.paid_on).toBe('2026-09-28')
    expect(pay.arrived_on).toBe('2026-10-02')
    expect(pay.amount).toBe(440)
    expect(pay.method_label).toBe('Bank (ACH)')
    // Made on the 28th for a bill due the 1st: on time (the postmark).
    expect(pay.timing_label).toBe('On time')
  })

  it('a payment is dated by the property\'s own day, not UTC', async () => {
    const p = await park()                                      // Phoenix
    const t = await resident('Late Evening')
    const s = await space(p, 'RV 2')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 300]])
    // 8 pm on Sept 30 in Phoenix is Oct 1 in UTC.
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300,
      method: 'cash', createdAt: '2026-10-01T03:00:00Z' })
    await apply(r, rent, 300)
    await settle([rent], '2026-10-01T03:00:00Z', 'cash')
    const sept = (await ledger(ownerToken(p), '2026-09')).body.data.payments
    expect(sept).toHaveLength(1)
    expect(sept[0].paid_on).toBe('2026-09-30')
    expect((await ledger(ownerToken(p), '2026-10')).body.data.payments).toHaveLength(0)
  })

  it('decisions #36.A: one payment that paid two months\' bills shows under each month with the part that went to it', async () => {
    const p = await park()
    const t = await resident('Two Months')
    const s = await space(p, 'RV 21')
    const [sep] = await bill(p, t, s, '2026-09-01', [['rent', 450]])
    const [oct] = await bill(p, t, s, '2026-10-01', [['rent', 450], ['utility', 30, 'Water meter 10 → 20']])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 930, applied: 930,
      method: 'check', createdAt: '2026-10-04T17:00:00Z' })
    await apply(r, sep, 450)
    await apply(r, oct[0] as any, 0.01).catch(() => undefined)
    await db.query(`DELETE FROM remittance_applications WHERE remittance_id = $1 AND payment_id <> $2`, [r, sep])
    await apply(r, oct, 450)
    const [, water] = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE invoice_id = (SELECT invoice_id FROM payments WHERE id = $1) ORDER BY amount DESC`, [oct])).rows.map(x => x.id)
    await apply(r, water, 30)
    await settle([sep, oct, water], '2026-10-04T17:00:00Z', 'check')
    const sept = (await ledger(ownerToken(p), '2026-09')).body.data
    const octM = (await ledger(ownerToken(p), '2026-10')).body.data
    expect(sept.payments).toHaveLength(1)
    expect(octM.payments).toHaveLength(1)
    // The same payment, each month showing only what went to its bills.
    expect(sept.payments[0]).toMatchObject({ id: r, amount: 450, owed: 450, paid_for: 'September rent', paid_on: '2026-10-04' })
    expect(sept.payments[0].lines.map((l: any) => l.payment_id)).toEqual([sep])
    expect(octM.payments[0]).toMatchObject({ id: r, amount: 480, owed: 480, paid_for: 'October rent, October water', timing_label: 'On time' })
    expect(sept.totals.paid).toBe(450)
    expect(octM.totals.paid).toBe(480)
  })
})

describe('one line per payment, its charges nested', () => {
  it('who, space, date, owed, paid, method and what it paid for', async () => {
    const p = await park()
    const t = await resident('Jane Doe')
    const s = await space(p, 'RV 14')
    const [rent, water] = await bill(p, t, s, '2026-10-01', [['rent', 900], ['utility', 25, 'Water meter 100 → 140']])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 925, applied: 925,
      method: 'check', createdAt: '2026-10-01T17:00:00Z' })
    await apply(r, rent, 900)
    await apply(r, water, 25)
    await settle([rent, water], '2026-10-01T17:00:00Z', 'check')
    const { payments } = (await ledger(ownerToken(p), '2026-10')).body.data
    expect(payments).toHaveLength(1)
    const [pay] = payments
    expect(pay).toMatchObject({
      name: 'Jane Doe', unit_number: 'RV 14', paid_on: '2026-10-01', owed: 925, amount: 925,
      method: 'check', method_label: 'Check', status: 'settled', status_label: 'Paid',
      paid_for: 'October rent, October water', timing_label: 'On time', kind: 'receipt',
    })
    expect(pay.lines.map((l: any) => [l.label, l.paid])).toEqual([['Rent', 900], ['Water', 25]])
    expect(pay.lines[1].detail).toMatch(/100 → 140/)
  })

  it('money and account credit apart: Kim\'s $486 money order against $935.45 with a $450 credit', async () => {
    const p = await park()
    const t = await resident('Kim Harland')
    const s = await space(p, 'RV 22')
    const [rent, fee] = await bill(p, t, s, '2026-09-01', [['rent', 900], ['fee', 35.45, 'Move-in fee']])
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,450,450,'goodwill','Move In Special','active',$4) RETURNING id`, [p.landlordId, t, s.leaseId, p.userId])).rows[0].id
    const at = '2026-09-09T17:00:00Z'
    // The desk spends the credit and writes the receipt in one transaction: one moment.
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,450,'2026-09-01','desk','applied',$4::timestamptz)`, [credit, rent, s.leaseId, at])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 486, applied: 485.45,
      unapplied: 0.55, method: 'money_order', createdAt: at })
    await apply(r, rent, 450)
    await apply(r, fee, 35.45)
    await settle([rent, fee], at, 'money_order')
    const { payments, totals } = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(payments).toHaveLength(1)
    // What went to September's bills: $485.45 of money and the $450 credit. The
    // $0.55 the desk kept is paid-ahead money, not a line on the roll (#36.A).
    expect(payments[0]).toMatchObject({ owed: 935.45, amount: 485.45, credit_applied: 450, method_label: 'Money order', paid_for: 'September move-in fee, September rent' })
    expect(payments[0]).not.toHaveProperty('kept_as_credit')
    expect(payments[0].lines.find((l: any) => l.payment_id === rent)).toMatchObject({ paid: 450, credit: 450 })
    expect(payments[0].lines.find((l: any) => l.payment_id === fee)).toMatchObject({ paid: 35.45, credit: 0 })
    expect(totals).toMatchObject({ paid: 485.45, paid_from_credit: 450 })
  })
})

describe('Todd: a two-month check, filed by the bills it paid (#35.1, #36.A)', () => {
  it('September shows the $460 that paid September\'s bill; October shows its rent "Paid from credit" on Oct 1, with $0 of money', async () => {
    const p = await park()
    const t = await resident('Todd Niemeyer')
    const s = await space(p, 'MH 08')
    const [sept] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 920, applied: 460,
      unapplied: 460, method: 'check', createdAt: '2026-09-18T17:00:00Z' })
    await apply(r, sept, 460)
    await settle([sept], '2026-09-18T17:00:00Z', 'check')
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, source_remittance_id, funded_by, received_at)
       VALUES ($1,$2,460,460,$3,'landlord','2026-09-18T17:00:00Z') RETURNING id`, [s.leaseId, t, r])).rows[0].id
    const [oct] = await bill(p, t, s, '2026-10-01', [['rent', 460]])
    // The 7 am bill run: the credit covers the whole bill, so it pays it.
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,460,'2026-10-01','whole_bill','applied','2026-10-01T14:00:00Z')`, [credit, oct, s.leaseId])
    await settle([oct], '2026-10-01T14:00:00Z')

    const sep = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(sep.payments).toHaveLength(1)
    // The check's second month is paid-ahead money: not a line of its own.
    expect(sep.payments[0]).toMatchObject({ id: r, amount: 460, owed: 460, credit_applied: 0, paid_for: 'September rent', paid_on: '2026-09-18' })
    expect(sep.totals).toMatchObject({ paid: 460, paid_from_credit: 0 })

    const octM = (await ledger(ownerToken(p), '2026-10')).body.data
    expect(octM.payments).toHaveLength(1)
    expect(octM.payments[0]).toMatchObject({
      kind: 'credit', amount: 0, credit_applied: 460, owed: 460, method: 'credit', method_label: 'Paid from credit',
      paid_for: 'October rent', paid_on: '2026-10-01', timing_label: 'On time', status: 'settled',
      // No money arrived in October: the check's money arrived in September.
      arrived_on: null,
    })
    // No new money came in from Todd in October: the bill was paid from credit.
    expect(octM.totals).toMatchObject({ paid: 0, paid_from_credit: 460 })
  })
})

describe('decisions #36.A: money paid ahead pays each later month\'s bill, and each roll shows it', () => {
  /** The first of the month `n` months from today's (GAM's calendar), 'YYYY-MM-DD'. */
  const firstOfMonth = (n: number) => {
    const [y, m] = todayIn(null).split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    return d.toISOString().slice(0, 10)
  }
  async function household(rent: number) {
    const p = await park()
    const t = await resident('Paid Ahead')
    const s = await space(p, 'MH 30')
    await inTx(c => seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: t }))
    await db.query(`UPDATE leases SET rent_amount = $2 WHERE id = $1`, [s.leaseId, rent])
    return { p, t, s }
  }
  /** Money handed over at the desk with nothing owed: all of it paid ahead (the real path). */
  async function payAhead(h: { p: any; t: string; s: any }, amount: number) {
    const at = new Date().toISOString()
    const r = await receipt({ tenantId: h.t, leaseId: h.s.leaseId, landlordId: h.p.landlordId, amount, applied: 0,
      unapplied: amount, method: 'check', createdAt: at })
    await inTx(c => createPaidAhead(c, { leaseId: h.s.leaseId, tenantId: h.t, amount, fundedBy: 'landlord', receivedAt: at, sourceRemittanceId: r }))
    return r
  }
  /** The bill run: the month's bill is made, then the whole-bill check pays it from credit when credit covers all of it. */
  async function billRun(h: { p: any; t: string; s: any }, due: string, rent: number) {
    const [row] = await bill(h.p, h.t, h.s, due, [['rent', rent]])
    const res = await runWholeBillCheckAfterCommit({ tenantId: h.t, landlordId: h.p.landlordId })
    expect(res?.settledIds).toEqual([row])
    return row
  }

  it('$5,000 paid ahead: the next two months\' rolls each show their rent "Paid from credit" on the 1st; the arrival is not a line', async () => {
    const h = await household(1000)
    const thisMonth = firstOfMonth(0).slice(0, 7)
    const m1 = firstOfMonth(1)
    const m2 = firstOfMonth(2)
    const r = await payAhead(h, 5000)
    await billRun(h, m1, 1000)
    await billRun(h, m2, 1000)

    // The $5,000 itself lives in the household's credit history, not on the roll.
    const arrival = (await ledger(ownerToken(h.p), thisMonth)).body.data
    expect(arrival.payments).toEqual([])
    expect(JSON.stringify(arrival)).not.toContain(r)

    for (const due of [m1, m2]) {
      const month = (await ledger(ownerToken(h.p), due.slice(0, 7))).body.data
      expect(month.payments).toHaveLength(1)
      expect(month.payments[0]).toMatchObject({
        kind: 'credit', amount: 0, credit_applied: 1000, owed: 1000, method_label: 'Paid from credit',
        paid_on: due, arrived_on: null, timing_label: 'On time', status: 'settled',
      })
      expect(month.payments[0].paid_for).toMatch(/ rent$/)
      expect(month.totals).toMatchObject({ paid: 0, paid_from_credit: 1000, payments: 1 })
    }
  })

  it('credit that arrives after the bill was due pays it that day, and the roll reads that day and how late it was', async () => {
    const h = await household(700)
    const lastMonthDue = firstOfMonth(-1)
    await bill(h.p, h.t, h.s, lastMonthDue, [['rent', 700]])
    await payAhead(h, 700)
    const res = await runWholeBillCheckAfterCommit({ tenantId: h.t, landlordId: h.p.landlordId })
    expect(res?.settledIds).toHaveLength(1)
    const today = todayIn(null)
    const month = (await ledger(ownerToken(h.p), lastMonthDue.slice(0, 7))).body.data
    expect(month.payments).toHaveLength(1)
    const late = Math.round((Date.parse(today) - Date.parse(lastMonthDue)) / 86_400_000)
    expect(month.payments[0]).toMatchObject({ kind: 'credit', paid_on: today, method_label: 'Paid from credit', days_late: late })
  })

  it('creditPaidOnDay is the later of the bill\'s due date and the day the credit paid it', () => {
    expect(creditPaidOnDay('2026-10-03', '2026-11-01')).toBe('2026-11-01')
    expect(creditPaidOnDay('2026-10-03', '2026-10-01')).toBe('2026-10-03')
    expect(creditPaidOnDay('2026-10-01', '2026-10-01')).toBe('2026-10-01')
  })
})

describe('statutory deposit interest', () => {
  it('a bill paid by deposit interest is new money to the landlord that day: "Deposit interest", counted as paid', async () => {
    const p = await park()
    const t = await resident('Inter Est')
    const s = await space(p, 'RV 23')
    const [water] = await bill(p, t, s, '2026-09-01', [['utility', 12.5, 'Water meter 1 → 2']])
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,12.5,12.5,'deposit_interest','Deposit interest','active',$4) RETURNING id`, [p.landlordId, t, s.leaseId, p.userId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,12.5,'2026-09-01','whole_bill','applied','2026-09-01T14:00:00Z')`, [credit, water, s.leaseId])
    await settle([water], '2026-09-01T14:00:00Z')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ kind: 'credit', amount: 12.5, credit_applied: 0, method_label: 'Deposit interest', paid_on: '2026-09-01', arrived_on: '2026-09-01' })
    expect(data.totals).toMatchObject({ paid: 12.5, paid_from_credit: 0 })
  })

  it('deposit interest that pays a bill before its due date arrived the day it paid it; the line reads the due date', async () => {
    const p = await park()
    const t = await resident('Early Interest')
    const s = await space(p, 'RV 43')
    const [water] = await bill(p, t, s, '2026-10-01', [['utility', 12.5, 'Water meter 1 → 2']])
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,12.5,12.5,'deposit_interest','Deposit interest','active',$4) RETURNING id`, [p.landlordId, t, s.leaseId, p.userId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,12.5,'2026-10-01','whole_bill','applied','2026-09-25T18:00:00Z')`, [credit, water, s.leaseId])
    await settle([water], '2026-09-25T18:00:00Z')
    const data = (await ledger(ownerToken(p), '2026-10')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({
      kind: 'credit', method_label: 'Deposit interest', amount: 12.5,
      paid_on: '2026-10-01', arrived_on: '2026-09-25', days_late: 0, timing_label: 'On time',
    })
  })

  it('a bill paid from paid-ahead credit alone has no day money arrived', async () => {
    const p = await park()
    const t = await resident('Only Credit')
    const s = await space(p, 'RV 46')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 200]])
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1,$2,200,200,'landlord','2026-08-20T17:00:00Z') RETURNING id`, [s.leaseId, t])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,200,'2026-09-01','whole_bill','applied','2026-08-28T18:00:00Z')`, [credit, rent, s.leaseId])
    await settle([rent], '2026-08-28T18:00:00Z')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments[0]).toMatchObject({ kind: 'credit', amount: 0, credit_applied: 200, method_label: 'Paid from credit', paid_on: '2026-09-01', arrived_on: null })
  })
})

describe('on time or N days late', () => {
  it('measured from the due date of the oldest bill it paid, honoring the grace period', async () => {
    const p = await park()
    const onTime = await resident('Grace Kept')
    const late = await resident('Grace Missed')
    const a = await space(p, 'RV 3')
    const b = await space(p, 'RV 4')
    const [r1] = await bill(p, onTime, a, '2026-09-01', [['rent', 300]])
    const [r2] = await bill(p, late, b, '2026-09-01', [['rent', 300]])
    for (const [tenant, sp, row, at] of [[onTime, a, r1, '2026-09-06T18:00:00Z'], [late, b, r2, '2026-09-09T18:00:00Z']] as const) {
      const r = await receipt({ tenantId: tenant, leaseId: sp.leaseId, landlordId: p.landlordId, amount: 300, applied: 300, method: 'cash', createdAt: at })
      await apply(r, row, 300)
      await settle([row], at, 'cash')
    }
    const { payments } = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(payments.find((x: any) => x.tenant_id === onTime)).toMatchObject({ days_late: 0, timing_label: 'On time' })
    expect(payments.find((x: any) => x.tenant_id === late)).toMatchObject({ days_late: 8, timing_label: '8 days late' })
  })
})

describe('clearing and returned', () => {
  it('a bank payment still clearing is listed as clearing; a bounced one as returned; a declined card is not a payment', async () => {
    const p = await park()
    const month = todayIn(null).slice(0, 7)
    const now = new Date().toISOString()
    const t1 = await resident('Clear Ing')
    const t2 = await resident('Bounce Back')
    const t3 = await resident('Card Declined')
    const s1 = await space(p, 'RV 5'); const s2 = await space(p, 'RV 6'); const s3 = await space(p, 'RV 7')
    const due = `${month}-01`
    const [a] = await bill(p, t1, s1, due, [['rent', 500]])
    const [b] = await bill(p, t2, s2, due, [['rent', 400]])
    const [c] = await bill(p, t3, s3, due, [['rent', 300]])
    const r1 = await receipt({ tenantId: t1, leaseId: s1.leaseId, landlordId: p.landlordId, amount: 500, applied: 500, method: 'ach', status: 'processing', createdAt: now, pi: 'pi_c1' })
    await apply(r1, a, 500)
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_c1' WHERE id=$1`, [a])
    const r2 = await receipt({ tenantId: t2, leaseId: s2.leaseId, landlordId: p.landlordId, amount: 400, applied: 400, method: 'ach', status: 'failed', createdAt: now, pi: 'pi_c2' })
    await apply(r2, b, 400)
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_c2' WHERE id=$1`, [b])
    const r3 = await receipt({ tenantId: t3, leaseId: s3.leaseId, landlordId: p.landlordId, amount: 300, applied: 300, method: 'card', status: 'failed', createdAt: now, pi: 'pi_c3' })
    await apply(r3, c, 300)
    const data = (await ledger(ownerToken(p))).body.data
    expect(data.month).toBe(month)
    const byTenant = (id: string) => data.payments.find((x: any) => x.tenant_id === id)
    expect(byTenant(t1)).toMatchObject({ status: 'clearing', status_label: 'Clearing', amount: 500 })
    expect(byTenant(t2)).toMatchObject({ status: 'returned', status_label: 'Returned' })
    expect(byTenant(t3)).toBeUndefined()
    // Neither is money that arrived.
    expect(data.totals).toMatchObject({ paid: 0, clearing: 500 })
  })

  it('a bounced bank payment whose retry is clearing reads Clearing, same as Outstanding', async () => {
    const p = await park()
    const month = todayIn(null).slice(0, 7)
    const t = await resident('Re Try')
    const s = await space(p, 'RV 24')
    const [rent] = await bill(p, t, s, `${month}-01`, [['rent', 500]])
    // The first pull bounced (the receipt is 'failed'); the retry re-confirmed
    // the same intent and the row is clearing again.
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 500, applied: 500,
      method: 'ach', status: 'failed', createdAt: new Date().toISOString(), pi: 'pi_retry_1' })
    await apply(r, rent, 500)
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_retry_1' WHERE id=$1`, [rent])
    const [outstanding] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    expect(outstanding).toMatchObject({ status: 'clearing', clearing: 500, balance: '0.00' })
    const data = (await ledger(ownerToken(p))).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ id: r, status: 'clearing', status_label: 'Clearing', amount: 500, arrived_on: null })
    expect(data.totals).toMatchObject({ paid: 0, clearing: 500 })
  })

  it('a card payment disputed after it arrived stays in its month, marked returned', async () => {
    const p = await park()
    const t = await resident('Dee Spute')
    const s = await space(p, 'RV 8')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 450]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 450, applied: 450, method: 'card', createdAt: '2026-09-02T17:00:00Z', pi: 'pi_disp' })
    await apply(r, rent, 450)
    await settle([rent], '2026-09-02T17:00:00Z', null, 'pi_disp')
    // Marked returned with no reversal record (a return recorded by hand,
    // history): all of its money came back, as before.
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [rent])
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments[0]).toMatchObject({ status: 'returned', amount: 450, returned: 450 })
    expect(data.payments[0].lines).toEqual([expect.objectContaining({ paid: 450, returned: 450 })])
    expect(data.totals).toMatchObject({ paid: 450, returned_since: 450 })
  })

  it('a bank payment that bounced before it cleared came back whole, and is not money that arrived', async () => {
    const p = await park()
    const t = await resident('Bo Unce')
    const s = await space(p, 'RV 25')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 400]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 400, applied: 400,
      method: 'ach', status: 'failed', createdAt: '2026-09-01T17:00:00Z', pi: 'pi_bounce_whole' })
    await apply(r, rent, 400)
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_bounce_whole' WHERE id=$1`, [rent])
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 400, returned: 400, arrived_on: null })
    expect(data.totals).toMatchObject({ paid: 0, returned_since: 0 })
  })

  it('a payment\'s status comes from one rule: its own money first, then any part taken back since', () => {
    const settled = { status: 'settled', retrying: false }
    const clearing = { status: 'processing', retrying: false }
    const retrying = { status: 'failed', retrying: true }
    const bounced = { status: 'failed', retrying: false }
    const none = { moneyReturned: false, creditTakenBack: false }
    expect(ledgerPaymentStatus({ receipt: settled, ...none })).toBe('settled')
    expect(ledgerPaymentStatus({ receipt: null, ...none })).toBe('settled')
    expect(ledgerPaymentStatus({ receipt: clearing, ...none })).toBe('clearing')
    expect(ledgerPaymentStatus({ receipt: retrying, ...none })).toBe('clearing')
    expect(ledgerPaymentStatus({ receipt: bounced, ...none })).toBe('returned')
    // A dispute or bank return that took back some of the payment's own money.
    expect(ledgerPaymentStatus({ receipt: settled, moneyReturned: true, creditTakenBack: false })).toBe('returned')
    expect(ledgerPaymentStatus({ receipt: null, moneyReturned: true, creditTakenBack: false })).toBe('returned')
    // Its own money stayed; paid-ahead credit it used was taken back since:
    // the one switch decides (its figures say what came back either way).
    expect(CREDIT_TAKEN_BACK_MARKS_RETURNED).toBe(true)
    expect(ledgerPaymentStatus({ receipt: settled, moneyReturned: false, creditTakenBack: true })).toBe('returned')
    expect(ledgerPaymentStatus({ receipt: clearing, moneyReturned: false, creditTakenBack: true })).toBe('returned')
    // A bill paid from credit alone whose credit was all taken back: nothing of it stands.
    expect(ledgerPaymentStatus({ receipt: null, moneyReturned: false, creditTakenBack: true, nothingStands: true })).toBe('returned')
    expect(LEDGER_PAYMENT_STATUS_LABEL.returned).toBe('Returned')
  })
})

// The live charge.dispute.created webhook calls handlePaymentReversal with the
// dispute's amount. The ledger counts what each charge lost by its reversal
// record (payment_reversals.reversed_amount), as the reports do (money plan §2
// "Returned or disputed"), never the whole payment for a part of it.
describe('a dispute takes back only what it disputed', () => {
  async function cardPaid(p: { landlordId: string }, t: string, s: { leaseId: string }, ids: string[], amounts: number[], pi: string, at: string) {
    const total = amounts.reduce((a, x) => a + x, 0)
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: total, applied: total,
      method: 'card', createdAt: at, pi })
    for (let i = 0; i < ids.length; i++) await apply(r, ids[i], amounts[i])
    await settle(ids, at, null, pi)
    return r
  }
  const dispute = (paymentId: string, amount: number, eventId: string) => handlePaymentReversal({
    paymentId, reversalType: 'card_dispute', reversedAmount: amount, reversalFee: 15, stripeEventId: eventId, rawEvent: {},
  })

  it('a $100 dispute of a $460 rent payment: returned_since is $100, and once the reopened $100 is paid the month keeps $460', async () => {
    const p = await park()
    const t = await resident('Part Dispute')
    const s = await space(p, 'RV 30')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    const r = await cardPaid(p, t, s, [rent], [460], 'pi_part_100', '2026-09-01T17:00:00Z')
    const rev = await dispute(rent, 100, 'evt_part_100')
    expect(rev.handled).toBe(true)

    let data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 460, returned: 100 })
    expect(data.payments[0].lines).toEqual([expect.objectContaining({ payment_id: rent, paid: 460, returned: 100 })])
    expect(data.totals).toMatchObject({ paid: 460, returned_since: 100 })

    // The reopened $100 is paid at the desk in cash.
    const reopened = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [rev.reversalId])).rows[0].id
    const desk = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 100, applied: 100,
      method: 'cash', createdAt: '2026-09-20T17:00:00Z' })
    await apply(desk, reopened, 100)
    await settle([reopened], '2026-09-20T17:00:00Z', 'cash')
    data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments.find((x: any) => x.id === desk)).toMatchObject({ status: 'settled', amount: 100, returned: 0 })
    expect(data.payments.find((x: any) => x.id === r)).toMatchObject({ status: 'returned', returned: 100 })
    expect(data.totals).toMatchObject({ paid: 560, returned_since: 100 })
    // What stayed with the landlord for September: $460, the bill.
    expect(Math.round((data.totals.paid - data.totals.returned_since) * 100) / 100).toBe(460)
  })

  it('a dispute of the water line of a rent+water payment returns only the water', async () => {
    const p = await park()
    const t = await resident('Wat Er')
    const s = await space(p, 'RV 31')
    const [rent, water] = await bill(p, t, s, '2026-09-01', [['rent', 460], ['utility', 40, 'Water']])
    const r = await cardPaid(p, t, s, [rent, water], [460, 40], 'pi_rent_water', '2026-09-01T17:00:00Z')
    // What the dispute handler writes for a charge that paid two rows (money
    // plan §3, one record per row, reversed_amount = what that row lost): the
    // water lost $40 (returned, reopened), the rent lost nothing ($0 record,
    // still settled). Written here, not through the handler: until contract
    // step C0 drops the one-record-per-event constraint (it is in no test
    // database), the handler cannot write a second record for one event.
    const record = (paymentId: string, amount: number) => db.query(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      reversal_fee, stripe_event_id, raw_event, recovery_status, status)
       VALUES ($1,$2,$3,$4,'card_dispute',$5,15,$6,'{}'::jsonb,$7,$8)`,
      [paymentId, p.landlordId, t, s.leaseId, amount, `evt_water_only_${paymentId}`,
       amount > 0 ? 'pending' : 'not_needed', amount > 0 ? 'open' : 'resolved'])
    await record(water, 40)
    await record(rent, 0)
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [water])

    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 500, returned: 40 })
    const line = (id: string) => data.payments[0].lines.find((l: any) => l.payment_id === id)
    expect(line(rent)).toMatchObject({ label: 'Rent', paid: 460, returned: 0 })
    expect(line(water)).toMatchObject({ label: 'Water', paid: 40, returned: 40 })
    expect(data.totals).toMatchObject({ paid: 500, returned_since: 40 })
  })

  it('a disputed water line\'s reopened row is named Water on Outstanding and the ledger', async () => {
    const p = await park()
    const t = await resident('Re Opened')
    const s = await space(p, 'RV 32')
    // A metered water charge: its name comes from its utility bill, and its own note says nothing.
    const [rent, water] = await bill(p, t, s, '2026-09-01', [['rent', 460], ['utility', 40]])
    await inTx(async c => {
      const meterId = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'water' })
      await seedUtilityBill(c, { meterId, unitId: s.unitId, tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId,
        chargeAmount: 40, paymentId: water, utilityType: 'water' })
    })
    // Rent and water each paid by its own card charge; the water's is disputed.
    await cardPaid(p, t, s, [rent], [460], 'pi_named_rent', '2026-09-01T17:00:00Z')
    await cardPaid(p, t, s, [water], [40], 'pi_named_water', '2026-09-01T17:05:00Z')
    const rev = await dispute(water, 40, 'evt_named_water')
    const reopened = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [rev.reversalId])).rows[0].id

    // Outstanding: what the desk sees owed again.
    const out = await request(buildApp()).get(`/api/balances/${t}/invoices`).set('Authorization', `Bearer ${ownerToken(p)}`)
    expect(out.status).toBe(200)
    const owedLine = out.body.data.flatMap((i: any) => i.lines).find((l: any) => l.id === reopened)
    expect(owedLine).toMatchObject({ label: 'Water', open: true })
    expect(owedLine.detail).toBeNull()

    // The ledger, once the reopened water is paid at the desk.
    const desk = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 40, applied: 40,
      method: 'cash', createdAt: '2026-09-21T17:00:00Z' })
    await apply(desk, reopened, 40)
    await settle([reopened], '2026-09-21T17:00:00Z', 'cash')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    const paid = data.payments.find((x: any) => x.id === desk)
    expect(paid.lines).toEqual([expect.objectContaining({ payment_id: reopened, label: 'Water', detail: null })])
    expect(paid.paid_for).toBe('September water')
  })

  // A later bill paid with money and paid-ahead credit, and then the card
  // payment that FUNDED that credit is disputed (money plan §3, Dispute: each
  // spend of the disputed charge's paid-ahead money goes 'reversed' and its row
  // reopens for the use amount, with its own record). The later payment's own
  // money was not disputed; the credit it used no longer stands.
  describe('a later bill paid with money and paid-ahead credit whose funding was disputed', () => {
    async function fundAhead(p: { landlordId: string }, t: string, s: { leaseId: string }, amount: number, pi: string, at: string) {
      // A card payment made with nothing owed: all of it paid ahead, held by GAM.
      const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount, applied: 0,
        unapplied: amount, method: 'card', createdAt: at, pi })
      const credit = await inTx(c => createPaidAhead(c, { leaseId: s.leaseId, tenantId: t, amount, fundedBy: 'gam', receivedAt: at, sourceRemittanceId: r }))
      return { r, credit }
    }
    /** The live charge.dispute.created webhook on the FUNDING charge (paymentReversal step 4 reopens the later bill). */
    async function disputeFunding(pi: string, eventId: string) {
      const rev = await handlePaymentReversal({ paymentIntentId: pi, reversalType: 'card_dispute', reversalFee: 15, stripeEventId: eventId, rawEvent: {} })
      expect(rev.handled).toBe(true)
      const spend = rev.rows.find(x => x.kind === 'credit_spend')!
      expect(spend).toBeDefined()
      return spend
    }
    async function payReopened(p: { landlordId: string }, t: string, s: { leaseId: string }, reopened: string, amount: number, at: string) {
      const desk = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount, applied: amount, method: 'cash', createdAt: at })
      await apply(desk, reopened, amount)
      await settle([reopened], at, 'cash')
      return desk
    }

    it('a card payer: the payment\'s own money is not returned, and the reversed credit is not counted as paid', async () => {
      const p = await park()
      const t = await resident('Fund Ed')
      const s = await space(p, 'RV 40')
      const { credit } = await fundAhead(p, t, s, 200, 'pi_fund_card', '2026-08-20T17:00:00Z')
      const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 500]])
      // Pay Now: $300 by card, $200 of the paid-ahead credit set aside on the
      // charge and applied when it settled.
      const at = '2026-09-01T17:00:00Z'
      const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300,
        method: 'card', createdAt: at, pi: 'pi_sept_card' })
      await db.query(
        `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, remittance_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,$4,200,'2026-09-01','portal','applied',$5::timestamptz)`, [credit, rent, s.leaseId, r, at])
      await apply(r, rent, 300)
      await settle([rent], at, null, 'pi_sept_card')

      const spend = await disputeFunding('pi_fund_card', 'evt_fund_card')
      expect(spend).toMatchObject({ paymentId: rent, lost: 200 })

      let data = (await ledger(ownerToken(p), '2026-09')).body.data
      expect(data.payments).toHaveLength(1)
      // The $300 card payment kept its money; the $200 of credit it used came back.
      expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 300, returned: 0, credit_applied: 200, credit_returned: 200 })
      expect(data.payments[0].lines).toEqual([expect.objectContaining({ payment_id: rent, paid: 300, returned: 0, credit: 200, credit_returned: 200 })])
      expect(data.totals).toMatchObject({ paid: 300, paid_from_credit: 0, returned_since: 0, credit_returned_since: 200 })

      // The reopened $200 is paid: September adds up to the $500 bill, every dollar once.
      const desk = await payReopened(p, t, s, spend.newPaymentId!, 200, '2026-09-15T17:00:00Z')
      data = (await ledger(ownerToken(p), '2026-09')).body.data
      expect(data.payments.find((x: any) => x.id === desk)).toMatchObject({ status: 'settled', amount: 200, returned: 0 })
      expect(data.totals).toMatchObject({ paid: 500, paid_from_credit: 0, returned_since: 0, credit_returned_since: 200 })
      const t0 = data.totals
      expect(Math.round((t0.paid - t0.returned_since + t0.paid_from_credit) * 100) / 100).toBe(500)
    })

    it('a desk (cash) payer: the cash is not returned, and the reversed credit is not counted as paid', async () => {
      const p = await park()
      const t = await resident('Cash Ed')
      const s = await space(p, 'RV 41')
      const { credit } = await fundAhead(p, t, s, 200, 'pi_fund_desk', '2026-08-20T17:00:00Z')
      const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 500]])
      // The desk spends the credit and writes the cash receipt in one transaction: one moment.
      const at = '2026-09-03T17:00:00Z'
      await db.query(
        `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1,$2,$3,200,'2026-09-01','desk','applied',$4::timestamptz)`, [credit, rent, s.leaseId, at])
      const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300, method: 'cash', createdAt: at })
      await apply(r, rent, 300)
      await settle([rent], at, 'cash')

      const spend = await disputeFunding('pi_fund_desk', 'evt_fund_desk')
      expect(spend).toMatchObject({ paymentId: rent, lost: 200 })

      let data = (await ledger(ownerToken(p), '2026-09')).body.data
      expect(data.payments).toHaveLength(1)
      expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 300, returned: 0, credit_applied: 200, credit_returned: 200, method_label: 'Cash' })
      expect(data.payments[0].lines).toEqual([expect.objectContaining({ payment_id: rent, paid: 300, returned: 0, credit: 200, credit_returned: 200 })])
      expect(data.totals).toMatchObject({ paid: 300, paid_from_credit: 0, returned_since: 0, credit_returned_since: 200 })

      await payReopened(p, t, s, spend.newPaymentId!, 200, '2026-09-16T17:00:00Z')
      data = (await ledger(ownerToken(p), '2026-09')).body.data
      expect(data.totals).toMatchObject({ paid: 500, paid_from_credit: 0, returned_since: 0, credit_returned_since: 200 })
    })

    // Both charges behind one bill disputed, in either order: the card that
    // paid the bill and the card that funded the credit it used. A water line:
    // a rent row reopened twice for one due date is Step 10's to make possible
    // (its idempotency index takes one pending rent row per lease and due date).
    for (const order of ['the funding first', 'the bill\'s own card first'] as const) {
      it(`a bill whose own card and whose credit's funding were both disputed (${order}): each part counted once`, async () => {
        const p = await park()
        const t = await resident('Both Ways')
        const s = await space(p, 'RV 42')
        const { credit } = await fundAhead(p, t, s, 200, 'pi_fund_both', '2026-08-20T17:00:00Z')
        const [water] = await bill(p, t, s, '2026-09-01', [['utility', 500, 'Water']])
        const at = '2026-09-01T17:00:00Z'
        const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300,
          method: 'card', createdAt: at, pi: 'pi_sept_both' })
        await db.query(
          `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, remittance_id, amount, billing_month, source, status, applied_at)
           VALUES ($1,$2,$3,$4,200,'2026-09-01','portal','applied',$5::timestamptz)`, [credit, water, s.leaseId, r, at])
        await apply(r, water, 300)
        await settle([water], at, null, 'pi_sept_both')

        const own = () => handlePaymentReversal({ paymentIntentId: 'pi_sept_both', reversalType: 'card_dispute', reversalFee: 15,
          stripeEventId: 'evt_own_both', rawEvent: {} })
        if (order === 'the funding first') {
          await disputeFunding('pi_fund_both', 'evt_fund_both')
          expect((await own()).handled).toBe(true)
        } else {
          expect((await own()).handled).toBe(true)
          await disputeFunding('pi_fund_both', 'evt_fund_both')
        }

        const data = (await ledger(ownerToken(p), '2026-09')).body.data
        expect(data.payments).toHaveLength(1)
        expect(data.payments[0]).toMatchObject({ id: r, status: 'returned', amount: 300, returned: 300, credit_applied: 200, credit_returned: 200 })
        expect(data.payments[0].lines).toEqual([expect.objectContaining({ payment_id: water, label: 'Water', paid: 300, returned: 300, credit: 200, credit_returned: 200 })])
        expect(data.totals).toMatchObject({ paid: 300, returned_since: 300, paid_from_credit: 0, credit_returned_since: 200 })

        // Owed again: the card's $300 and the credit's $200, each once.
        const reopened = await db.query<{ amount: string }>(
          `SELECT amount::text FROM payments WHERE reversal_id IS NOT NULL AND status = 'pending' AND type = 'utility' ORDER BY amount`)
        expect(reopened.rows.map(x => Number(x.amount))).toEqual([200, 300])
        const [outstanding] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
        const fees = await db.query<{ s: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS s FROM payments
            WHERE tenant_id = $1 AND status = 'pending' AND type <> 'utility'`, [t])
        expect(Number(outstanding.balance)).toBe(500 + Number(fees.rows[0].s))
      })
    }
  })

  it('the money comes off the disputed card or bank payment first; desk money comes back only when no card or bank money was on the charge', () => {
    const parts = [
      { act: 'desk', intent: null, moneyC: 10000 },
      { act: 'card', intent: 'pi_a', moneyC: 36000 },
    ]
    expect(Object.fromEntries(returnedByPart({ intent: 'pi_a' }, parts, 10000))).toEqual({ card: 10000 })
    // Never more than the act put on the charge, and never the desk's while a card paid it.
    expect(Object.fromEntries(returnedByPart({ intent: 'pi_a' }, parts, 50000))).toEqual({ card: 36000 })
    // No reversal record: the whole charge came back, from every act.
    expect(Object.fromEntries(returnedByPart({ intent: 'pi_a' }, parts, null))).toEqual({ desk: 10000, card: 36000 })
    // A record on a charge only the desk paid.
    expect(Object.fromEntries(returnedByPart({ intent: null }, [parts[0]], 4000))).toEqual({ desk: 4000 })
    // A $0 record takes nothing back.
    expect(returnedByPart({ intent: 'pi_a' }, parts, 0).size).toBe(0)
  })
})

describe('work trade', () => {
  it('a work-trade household gets one "Work trade — covered" line for the month, with no amount', async () => {
    const p = await park()
    const t = await resident('Walt Trade')
    const s = await space(p, 'RV 9')
    const ids = await bill(p, t, s, '2026-09-01', [['rent', 589], ['utility', 30]])
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = ANY($1::uuid[])`, [ids])
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.work_trade).toEqual([{ tenant_id: t, name: 'Walt Trade', unit_number: 'RV 9', property_name: expect.any(String), label: 'Work trade — covered' }])
    expect(JSON.stringify(data.work_trade)).not.toMatch(/589|619/)
    expect(data.payments).toEqual([])
  })

  it('a closed work-trade month keeps its "Work trade — covered" line', async () => {
    const p = await park()
    const t = await resident('Clo Sed')
    const s = await space(p, 'RV 25')
    const ids = await bill(p, t, s, '2026-08-01', [['rent', 589], ['utility', 30]])
    // The month close (jobs/workTradeSettlement): covered lines settle at $0,
    // the suspension is cleared and the hours' value lands on the invoice.
    await db.query(
      `UPDATE payments SET amount = 0, status = 'settled', settled_at = '2026-09-01T07:00:00Z', work_trade_suspended_at = NULL
        WHERE id = ANY($1::uuid[])`, [ids])
    await db.query(
      `UPDATE invoices SET total_amount = 0, work_trade_credit_amount = 619
        WHERE id = (SELECT invoice_id FROM payments WHERE id = $1)`, [ids[0]])
    const data = (await ledger(ownerToken(p), '2026-08')).body.data
    expect(data.work_trade).toEqual([expect.objectContaining({ tenant_id: t, label: 'Work trade — covered' })])
    expect(JSON.stringify(data)).not.toMatch(/619|589/)
    expect(data.payments).toEqual([])
    expect(data.months).toContain('2026-08')
  })
})

describe('who sees it', () => {
  it('decisions #25: the month total goes to owners and property managers only', async () => {
    const p = await park()
    const t = await resident('Tot Al')
    const s = await space(p, 'RV 10')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 300]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300, method: 'cash', createdAt: '2026-09-02T17:00:00Z' })
    await apply(r, rent, 300)
    await settle([rent], '2026-09-02T17:00:00Z', 'cash')
    expect((await ledger(ownerToken(p), '2026-09')).body.data.totals.paid).toBe(300)
    const pm = await ledger(await teamToken(p, 'property_manager', { 'payments.view_all': true }), '2026-09')
    expect(pm.body.data.totals.paid).toBe(300)
    const desk = await ledger(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }), '2026-09')
    expect(desk.status).toBe(200)
    expect(desk.body.data.payments).toHaveLength(1)
    expect(desk.body.data.totals).toBeUndefined()
  })

  it('S641: staff with only "View payments" never see settled history', async () => {
    const p = await park()
    const res = await ledger(await teamToken(p, 'onsite_manager', { 'payments.view': true, 'balances.view': true }))
    expect(res.status).toBe(403)
  })

  it('a property-locked viewer sees only payments at their properties', async () => {
    const p = await park()
    const other = await inTx(c => seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }))
    const t1 = await resident('Here Paid')
    const t2 = await resident('There Paid')
    const s1 = await space(p, 'RV 11')
    const s2 = await space({ ...p, propertyId: other }, 'RV 12')
    for (const [t, s] of [[t1, s1], [t2, s2]] as const) {
      const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 300]])
      const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 300, applied: 300, method: 'cash', createdAt: '2026-09-02T17:00:00Z' })
      await apply(r, rent, 300)
      await settle([rent], '2026-09-02T17:00:00Z', 'cash')
    }
    const scoped = await ledger(await teamToken(p, 'onsite_manager', { 'payments.view_all': true }, [p.propertyId]), '2026-09')
    expect(scoped.body.data.payments.map((x: any) => x.tenant_id)).toEqual([t1])
    const owner = await ledger(ownerToken(p), '2026-09')
    expect(owner.body.data.payments).toHaveLength(2)
  })
})

describe('never on a landlord\'s ledger', () => {
  it('GAM\'s FlexPay pull and GAM\'s own fees; a payment that paid one shows only the landlord\'s part', async () => {
    const p = await park()
    const t = await resident('Flex Payer')
    const s = await space(p, 'RV 13')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    const gamFee = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'fee',4,'pending','2026-09-01','RETURNFEE','gam') RETURNING id`, [s.unitId, s.leaseId, t, p.landlordId])).rows[0].id
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 464, applied: 464, method: 'card', createdAt: '2026-09-03T17:00:00Z', pi: 'pi_mix' })
    await apply(r, rent, 460)
    await apply(r, gamFee, 4)
    await settle([rent, gamFee], '2026-09-03T17:00:00Z', null, 'pi_mix')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner, settled_at, notes)
       VALUES ($1,$2,$3,$4,'fee',25,'settled','2026-09-20','FLEXPAY','gam','2026-09-20T17:00:00Z','FlexPay September')`,
      [s.unitId, s.leaseId, t, p.landlordId])
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ amount: 460, owed: 460, paid_for: 'September rent' })
    expect(JSON.stringify(data)).not.toMatch(/flexpay/i)
    // No Stripe id ever leaves the server.
    expect(JSON.stringify(data)).not.toContain('pi_mix')
  })
})

describe('a security deposit held in trust', () => {
  it('a security deposit written as move-in writes it is listed on the payment that paid it, and kept out of the month total as the reports do (one switch)', async () => {
    const p = await park()
    const t = await resident('Dep Osit')
    const s = await space(p, 'RV 26')
    const [rent, deposit] = await bill(p, t, s, '2026-09-01', [['rent', 500], ['deposit', 300]])
    // jobs/moveInBundle writes the deposit with the default owner, the landlord.
    const row = (await db.query(`SELECT type, entry_description, revenue_owner FROM payments WHERE id = $1`, [deposit])).rows[0]
    expect(row).toEqual({ type: 'deposit', entry_description: 'DEPOSIT', revenue_owner: 'landlord' })
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 800, applied: 800,
      method: 'cash', createdAt: '2026-09-01T17:00:00Z' })
    await apply(r, rent, 500)
    await apply(r, deposit, 300)
    await settle([rent, deposit], '2026-09-01T17:00:00Z', 'cash')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ amount: 800, owed: 800 })
    expect(data.payments[0].lines.map((l: any) => l.payment_id).sort()).toEqual([rent, deposit].sort())
    expect(data.payments[0].lines.find((l: any) => l.payment_id === deposit)).toMatchObject({ label: 'Security deposit', paid: 300 })
    // Not decided by Nic; until he answers the total agrees with the reports.
    expect(LEDGER_TOTAL_COUNTS_HELD_DEPOSITS).toBe(false)
    expect(data.totals.paid).toBe(500)
  })

  it('a deposit shortfall the tenant paid after move-out counts in the month total, as the reports count it', async () => {
    const p = await park()
    const t = await resident('Short Fall')
    const s = await space(p, 'RV 27')
    // depositReturn's shortfall row: a fee on the DEPOSIT entry with no lease fee behind it.
    const shortfall = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,'fee',120,'pending','2026-09-10','DEPOSIT','Owed past the deposit') RETURNING id`,
      [s.unitId, s.leaseId, t, p.landlordId])).rows[0].id
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 120, applied: 120,
      method: 'check', createdAt: '2026-09-12T17:00:00Z' })
    await apply(r, shortfall, 120)
    await settle([shortfall], '2026-09-12T17:00:00Z', 'check')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ amount: 120 })
    expect(data.totals.paid).toBe(120)
  })

  it('which parts count in the month total: never money paid ahead (counted when it pays a bill), a deposit per the one switch, rent, fees and the shortfall always', () => {
    // A security deposit, a FlexDeposit installment and a refundable deposit box are all type 'deposit'.
    expect(isTrustHeldDeposit({ type: 'deposit' })).toBe(true)
    expect(isTrustHeldDeposit({ type: 'fee' })).toBe(false)
    expect(countsInLedgerTotal({ type: 'deposit', revenue_owner: 'landlord' })).toBe(LEDGER_TOTAL_COUNTS_HELD_DEPOSITS)
    // Paid ahead (held): never in the money total, whatever the deposit switch says.
    expect(countsInLedgerTotal({ type: 'fee', revenue_owner: 'held' })).toBe(false)
    expect(countsInLedgerTotal({ type: 'deposit', revenue_owner: 'held' })).toBe(false)
    // Rent, a fee and the move-out shortfall (a 'fee') count.
    expect(countsInLedgerTotal({ type: 'rent', revenue_owner: 'landlord' })).toBe(true)
    expect(countsInLedgerTotal({ type: 'fee', revenue_owner: 'landlord' })).toBe(true)
  })
})

describe('bills covered after a payment that failed', () => {
  async function cover(p: any, t: string, s: any, rent: string) {
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (tenant_id, lease_id, landlord_id, unit_id, cycle_month, rent_amount, tenant_fee_amount, pull_day, status)
       VALUES ($1,$2,$3,$4,'2026-09-01',460,25,20,'fronted') RETURNING id`, [t, s.leaseId, p.landlordId, s.unitId])).rows[0].id
    await db.query(`UPDATE payments SET status='settled', settled_at='2026-09-05T17:00:00Z', platform_held=TRUE, flexpay_advance_id=$2,
                           notes='Paid on time' WHERE id=$1`, [rent, adv])
    return adv
  }

  it('a bill covered after a declined card attempt is listed once', async () => {
    const p = await park()
    const t = await resident('Cover After')
    const s = await space(p, 'RV 41')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    // rentCharge writes the receipt's lines when the charge is created; the
    // card was declined, so the receipt failed with its lines in place.
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 460, applied: 460,
      method: 'card', status: 'failed', createdAt: '2026-09-02T17:00:00Z', pi: 'pi_declined' })
    await apply(r, rent, 460)
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_declined' WHERE id=$1`, [rent])
    const adv = await cover(p, t, s, rent)
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ kind: 'settled', amount: 460, status: 'settled', method_label: 'Online payment', paid_for: 'September rent' })
    expect(data.totals).toMatchObject({ paid: 460 })
    const json = JSON.stringify(data)
    expect(json).not.toContain(r)
    expect(json).not.toContain('pi_declined')
    expect(json).not.toContain(adv)
    expect(json).not.toMatch(/flexpay/i)
  })

  it('a bill covered after a bounced bank payment: the bounce is listed as returned, the cover as the payment', async () => {
    const p = await park()
    const t = await resident('Bounce Cover')
    const s = await space(p, 'RV 44')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 460, applied: 460,
      method: 'ach', status: 'failed', createdAt: '2026-09-01T15:00:00Z', pi: 'pi_bounced' })
    await apply(r, rent, 460)
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_bounced' WHERE id=$1`, [rent])
    await cover(p, t, s, rent)
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(2)
    expect(data.payments.find((x: any) => x.id === r)).toMatchObject({ status: 'returned', arrived_on: null })
    expect(data.payments.find((x: any) => x.id !== r)).toMatchObject({ kind: 'settled', status: 'settled', amount: 460 })
    // Only the cover's money arrived: the rent is counted once.
    expect(data.totals).toMatchObject({ paid: 460, returned_since: 0, clearing: 0 })
    expect(JSON.stringify(data)).not.toContain('pi_bounced')
  })
})

describe('a co-resident pays at the desk with the household\'s credit', () => {
  async function household() {
    const p = await park()
    const prim = await resident('Prim Ary')
    const co = await resident('Co Tenant')
    const s = await space(p, 'RV 42')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: prim })
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: co, role: 'co_tenant' })
    })
    return { p, prim, co, s }
  }
  async function paidAheadCredit(leaseId: string, tenantId: string, amount: number) {
    return (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1,$2,$3,$3,'landlord','2026-08-20T17:00:00Z') RETURNING id`, [leaseId, tenantId, amount])).rows[0].id
  }
  async function useCredit(credit: string, paymentId: string, leaseId: string, amount: number, at: string) {
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,$4,'2026-09-01','desk','applied',$5::timestamptz)`, [credit, paymentId, leaseId, amount, at])
  }

  it('a co-tenant\'s desk payment with household credit is one line', async () => {
    const { p, prim, co, s } = await household()
    const [rent] = await bill(p, prim, s, '2026-09-01', [['rent', 600]])
    const at = '2026-09-03T17:00:00Z'
    await useCredit(await paidAheadCredit(s.leaseId, prim, 100), rent, s.leaseId, 100, at)
    const r = await receipt({ tenantId: co, leaseId: s.leaseId, landlordId: p.landlordId, amount: 500, applied: 500, method: 'cash', createdAt: at })
    await apply(r, rent, 500)
    await settle([rent], at, 'cash')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ id: r, kind: 'receipt', name: 'Co Tenant', amount: 500, credit_applied: 100, owed: 600 })
    expect(data.totals).toMatchObject({ paid: 500, paid_from_credit: 100 })
  })

  it('credit spent on another space the payer is on, in the same desk payment, is the same line', async () => {
    const { p, prim, co, s } = await household()
    const s2 = await space(p, 'RV 45')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s2.leaseId, tenantId: prim })
      await seedLeaseTenant(c, { leaseId: s2.leaseId, tenantId: co, role: 'co_tenant' })
    })
    const [rent] = await bill(p, prim, s, '2026-09-01', [['rent', 500]])
    const [rent2] = await bill(p, prim, s2, '2026-09-01', [['rent', 80]])
    const at = '2026-09-03T18:00:00Z'
    await useCredit(await paidAheadCredit(s2.leaseId, prim, 80), rent2, s2.leaseId, 80, at)
    const r = await receipt({ tenantId: co, leaseId: s.leaseId, landlordId: p.landlordId, amount: 500, applied: 500, method: 'cash', createdAt: at })
    await apply(r, rent, 500)
    await settle([rent, rent2], at, 'cash')
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ id: r, amount: 500, credit_applied: 80, owed: 580 })
    expect(data.payments[0].lines.map((l: any) => l.payment_id).sort()).toEqual([rent, rent2].sort())
  })
})

describe('the month', () => {
  it('the current month says how many households still owe — a count, never dollars; a past month does not', async () => {
    const p = await park()
    const t = await resident('Still Owes')
    const s = await space(p, 'RV 15')
    await bill(p, t, s, addDaysTo(todayIn(null), -3), [['rent', 300]])
    const now = (await ledger(ownerToken(p))).body.data
    expect(now.still_owe_households).toBe(1)
    expect(JSON.stringify(now)).not.toMatch(/"300/)
    const past = (await ledger(ownerToken(p), '2026-01')).body.data
    expect(past.still_owe_households).toBeNull()
  })

  it('history settled with no receipt is listed, one line for the act that settled it', async () => {
    const p = await park()
    const t = await resident('Old Desk')
    const s = await space(p, 'RV 16')
    const [rent, water] = await bill(p, t, s, '2026-09-01', [['rent', 440], ['utility', 17.07, 'Water']])
    await settle([rent, water], '2026-09-04T18:00:00Z', 'cash')
    const { payments } = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ kind: 'settled', amount: 457.07, method_label: 'Cash', paid_for: 'September rent, September water' })
  })

  it('the picker lists months with payments, newest first, and always the current month', async () => {
    const p = await park()
    const t = await resident('Pick Er')
    const s = await space(p, 'RV 17')
    const [aug] = await bill(p, t, s, '2026-08-01', [['rent', 100]])
    const [sep] = await bill(p, t, s, '2026-09-01', [['rent', 100]])
    await settle([aug], '2026-08-03T18:00:00Z', 'cash')
    await settle([sep], '2026-09-03T18:00:00Z', 'cash')
    const { months } = (await ledger(ownerToken(p), '2026-09')).body.data
    const current = todayIn(null).slice(0, 7)
    expect(months[0]).toBe([current, '2026-09'].sort().reverse()[0])
    expect(months).toContain(current)
    expect(months.indexOf('2026-09')).toBeLessThan(months.indexOf('2026-08'))
  })

  it('a month that is not YYYY-MM is refused in plain words', async () => {
    const p = await park()
    const res = await ledger(ownerToken(p), 'October')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM/)
  })
})

describe('payments that paid no bill, and bills no tenant paid directly', () => {
  it('decisions #36.A: money paid ahead with no bill open is not a line on the roll', async () => {
    const p = await park()
    const t = await resident('Early Bird')
    const s = await space(p, 'RV 18')
    const r = await receipt({ tenantId: t, leaseId: s.leaseId, landlordId: p.landlordId, amount: 200, applied: 0, unapplied: 200,
      method: 'cash', createdAt: '2026-09-25T17:00:00Z' })
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toEqual([])
    expect(data.totals).toMatchObject({ paid: 0, payments: 0 })
    expect(JSON.stringify(data)).not.toContain(r)
  })

  it('a bill GAM covered on time is listed as an online payment, with no FlexPay wording', async () => {
    const p = await park()
    const t = await resident('Cover Ed')
    const s = await space(p, 'RV 19')
    const [rent] = await bill(p, t, s, '2026-09-01', [['rent', 460]])
    const adv = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (tenant_id, lease_id, landlord_id, unit_id, cycle_month, rent_amount, tenant_fee_amount, pull_day, status)
       VALUES ($1,$2,$3,$4,'2026-09-01',460,25,20,'fronted') RETURNING id`, [t, s.leaseId, p.landlordId, s.unitId])).rows[0].id
    await db.query(`UPDATE payments SET status='settled', settled_at='2026-09-05T17:00:00Z', platform_held=TRUE, flexpay_advance_id=$2,
                           notes='Paid on time' WHERE id=$1`, [rent, adv])
    const data = (await ledger(ownerToken(p), '2026-09')).body.data
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0]).toMatchObject({ kind: 'settled', amount: 460, method_label: 'Online payment' })
    expect(JSON.stringify(data)).not.toMatch(/flexpay/i)
    // The cover's id never reaches the landlord, not even as a line's id.
    expect(JSON.stringify(data)).not.toContain(adv)
  })
})
