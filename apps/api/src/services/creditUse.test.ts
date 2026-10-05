/**
 * S655 money plan Step 2 — the credit engine (services/creditUse).
 *
 * Nic (10/2): credit applies by itself only when it covers the WHOLE bill;
 * otherwise the payer chooses "Use all $X" or "Save it for later". Every spend
 * is one row in credit_uses, and only a landlord's own rent, utilities, late
 * fees and fees on the credit's lease can be paid by credit.
 *
 * Each test builds its own household on a *_test database (cleanupAllSchema).
 */
import fs from 'fs'
import path from 'path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import {
  householdQuote, planCredit, buildCreditPlan, holdCredit, applyCredit,
  applyHeldForRemittance, releaseHeldForRemittance, supersedeScheduledRetry,
  settleFromCredit, settleWholeBillIfCovered, createPaidAhead, createIssuedCredit,
  voidPaidAhead, clawBackRemittanceCredit, runWholeBillCheckAfterCommit, type QuoteRow,
  takeBackDisputedCredit, clawBackDisputedCharge, reverseHeldSpendsOfDisputedMoney, takeBackCreditAgainstRecord,
} from './creditUse'

// Receipts go out only after a commit; this file checks THAT and WHAT is sent.
const sendPaymentReceipt = vi.hoisted(() => vi.fn(async () => 'msg_test'))
vi.mock('./paymentReceipt', () => ({ sendPaymentReceipt }))

// ─── Fixture ──────────────────────────────────────────────────────────────────

interface House {
  userId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; leaseId: string
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

async function house(opts: { landlordId?: string; userId?: string; tenantId?: string; rent?: number } = {}): Promise<House> {
  return tx(async c => {
    const ll = opts.landlordId ? { landlordId: opts.landlordId, userId: opts.userId! } : await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = opts.tenantId ?? await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: opts.rent ?? 460, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return { userId: ll.userId, landlordId: ll.landlordId, propertyId, unitId, tenantId, leaseId }
  })
}

let createdTick = 0
async function charge(h: House, o: {
  amount: number; type?: string; entry?: string; due?: string; owner?: string; status?: string
  leaseId?: string | null; landlordId?: string; unitId?: string; invoiceId?: string | null
  leaseFeeId?: string | null; nextRetryAt?: string | null; intent?: string | null; reversalId?: string | null
}): Promise<string> {
  createdTick++
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status,
                           due_date, entry_description, revenue_owner, lease_fee_id, next_retry_at,
                           stripe_payment_intent_id, reversal_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + ($16 || ' milliseconds')::interval)
     RETURNING id`,
    [o.unitId ?? h.unitId, o.leaseId === undefined ? h.leaseId : o.leaseId, h.tenantId, o.landlordId ?? h.landlordId,
     o.invoiceId ?? null, o.type ?? 'rent', o.amount.toFixed(2), o.status ?? 'pending', o.due ?? '2026-10-01',
     o.entry ?? (o.type === 'utility' ? 'UTILITY' : o.type === 'late_fee' ? 'LATEFEE' : o.type === 'fee' ? 'OTHERFEE' : 'RENT'),
     o.owner ?? 'landlord', o.leaseFeeId ?? null, o.nextRetryAt ?? null, o.intent ?? null, o.reversalId ?? null,
     String(createdTick)])
  return r.rows[0].id
}

async function invoiceFor(h: House, due = '2026-10-01'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO invoices (lease_id, unit_id, tenant_id, landlord_id, invoice_number, due_date, subtotal_rent, total_amount, status)
     VALUES ($1,$2,$3,$4,'INV-' || substr(md5(random()::text),1,10), $5, 0, 0, 'pending') RETURNING id`,
    [h.leaseId, h.unitId, h.tenantId, h.landlordId, due])
  return r.rows[0].id
}

const paidAhead = (h: House, amount: number, fundedBy: 'landlord' | 'gam' | 'reclassified' = 'landlord', leaseId = h.leaseId, extra: { sourceRemittanceId?: string } = {}) =>
  tx(c => createPaidAhead(c, { leaseId, tenantId: h.tenantId, amount, fundedBy, receivedAt: '2026-09-15T12:00:00Z', ...extra }))
const issued = (h: House, amount: number, o: { leaseId?: string | null; category?: string } = {}) =>
  tx(c => createIssuedCredit(c, {
    landlordId: h.landlordId, tenantId: h.tenantId, leaseId: o.leaseId === undefined ? h.leaseId : o.leaseId,
    amount, category: o.category ?? 'goodwill', reason: 'test', createdBy: h.userId,
  }))
const quote = (h: House, includeReleasable = true) =>
  tx(c => householdQuote(c, { tenantId: h.tenantId, landlordId: h.landlordId, includeReleasable }))
const wholeBill = (h: House) =>
  tx(c => settleWholeBillIfCovered(c, { tenantId: h.tenantId, landlordId: h.landlordId, receipt: false }))
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status
const remainingPaidAhead = async (id: string) => Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [id])).rows[0].r)
const remainingIssued = async (id: string) => Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [id])).rows[0].r)
const uses = async (where = 'TRUE', params: unknown[] = []) => (await db.query<any>(
  `SELECT id, tenant_credit_id, prepaid_credit_id, payment_id, amount::float AS amount, status, source, release_reason,
          to_char(billing_month,'YYYY-MM-DD') AS month
     FROM credit_uses WHERE ${where} ORDER BY held_at, id`, params)).rows
const ownerShare = async (paymentId: string) => {
  const r = await db.query<{ a: string }>(
    `SELECT amount::text AS a FROM user_balance_ledger WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share'`, [paymentId])
  return r.rows[0] ? Number(r.rows[0].a) : null
}
async function remittance(h: House, o: { amount: number; method?: 'ach' | 'card'; intent?: string; status?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     status, payment_method, stripe_payment_intent_id, processing_fee_amount)
     VALUES ($1,$2,$3,$4,$4,0,$5,$6,$7,0) RETURNING id`,
    [h.tenantId, h.leaseId, h.landlordId, o.amount.toFixed(2), o.status ?? 'processing', o.method ?? 'ach',
     o.intent ?? `pi_test_${Math.random().toString(36).slice(2)}`])
  return r.rows[0].id
}

async function reversalOf(paymentId: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
     VALUES ($1, 'card_dispute', 460, 'evt_' || gen_random_uuid(), '{}'::jsonb) RETURNING id`, [paymentId])).rows[0].id
}

beforeEach(async () => { await cleanupAllSchema(); createdTick = 0; sendPaymentReceipt.mockClear() })

// ─── Where credit may go ──────────────────────────────────────────────────────

describe('which bills credit may pay', () => {
  it('paid-ahead money pays only its own lease', async () => {
    const h = await house()
    const other = await house({ landlordId: h.landlordId, userId: h.userId, tenantId: h.tenantId })
    await paidAhead(h, 500)
    const mine = await charge(h, { amount: 460 })
    const theirs = await charge(other, { amount: 460 })
    const q = await quote(h)
    expect(q.leaseIds.sort()).toEqual([h.leaseId, other.leaseId].sort())
    expect(planCredit(q, other.leaseId)).toEqual([])
    expect(planCredit(q, h.leaseId)).toMatchObject([{ paymentId: mine, amount: 460, creditKind: 'paid_ahead' }])
    // The database refuses it too.
    const creditId = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits`)).rows[0].id
    await expect(tx(c => applyCredit(c, [{ creditKind: 'paid_ahead', creditId, paymentId: theirs, leaseId: other.leaseId, amount: 10, billingMonth: '2026-10-01' }], { source: 'desk' })))
      .rejects.toThrow(/own lease|not an eligible/)
  })

  it('a general credit is spent once across the household, oldest bill first', async () => {
    const h = await house()
    const second = await house({ landlordId: h.landlordId, userId: h.userId, tenantId: h.tenantId })
    const general = await issued(h, 500, { leaseId: null })
    const newer = await charge(h, { amount: 460, due: '2026-10-01' })
    const older = await charge(second, { amount: 300, due: '2026-09-01' })
    const q = await quote(h)
    // Oldest bill first, across both leases; never more than the credit in total.
    expect(q.plan.map(l => [l.paymentId, l.amount])).toEqual([[older, 300], [newer, 200]])
    expect(planCredit(q, second.leaseId).reduce((s, l) => s + l.amount, 0)).toBe(300)
    expect(planCredit(q, h.leaseId).reduce((s, l) => s + l.amount, 0)).toBe(200)
    expect(q.totals.usableCredit).toBe(500)
    // Spending lease by lease never spends the credit twice.
    await tx(c => applyCredit(c, planCredit(q, second.leaseId), { source: 'portal' }))
    await tx(c => applyCredit(c, planCredit(q, h.leaseId), { source: 'portal' }))
    expect(await remainingIssued(general)).toBe(0)
    await expect(tx(c => applyCredit(c, planCredit(q, h.leaseId), { source: 'portal' }))).rejects.toThrow()
  })

  it("a removed roommate's credit and quote never take the remaining tenant's bill", async () => {
    // T moved out of the lease; U took her place and has October's rent open.
    const t = await house()
    const uId = await tx(c => seedTenant(c))
    await db.query(
      `UPDATE lease_tenants SET status = 'removed', removed_at = now(), removed_reason = 'moved_out' WHERE lease_id = $1 AND tenant_id = $2`,
      [t.leaseId, t.tenantId])
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1, $2, 'co_tenant', 'active')`, [t.leaseId, uId])
    const u: House = { ...t, tenantId: uId }
    const uRent = await charge(u, { amount: 950 })
    const tGoodwill = await issued(t, 1000, { leaseId: null })

    // T's household no longer includes U's bill: nothing required, nothing usable.
    const qt = await quote(t)
    expect(qt.totals.required).toBe(0)
    expect(qt.totals.usableCredit).toBe(0)
    expect(qt.plan).toEqual([])
    // ...and the whole-bill rule never spends T's credit on it.
    const wb = await runWholeBillCheckAfterCommit({ tenantId: t.tenantId, landlordId: t.landlordId })
    expect(wb?.settledIds).toEqual([])
    expect(await statusOf(uRent)).toBe('pending')
    expect(await remainingIssued(tGoodwill)).toBe(1000)
    expect(await uses()).toEqual([])

    // U's own quote still has the bill (the lease is U's household now).
    const qu = await quote(u)
    expect(qu.leases.find(l => l.leaseId === t.leaseId)!.requiredIds).toEqual([uRent])
    expect(qu.totals.usableCredit).toBe(0)                 // T's general credit is not U's

    // A row billed to T herself on the lease she left is still hers: her
    // quote has it, and her credit covering it settles it — and only it.
    const tFee = await charge(t, { amount: 25, type: 'late_fee', due: '2026-09-06' })
    const qt2 = await quote(t)
    expect(qt2.leases.find(l => l.leaseId === t.leaseId)!.requiredIds).toEqual([tFee])
    expect(qt2.totals.usableCredit).toBe(25)
    await runWholeBillCheckAfterCommit({ tenantId: t.tenantId, landlordId: t.landlordId })
    expect(await statusOf(tFee)).toBe('settled')
    expect(await statusOf(uRent)).toBe('pending')
    expect(await remainingIssued(tGoodwill)).toBe(975)
  })

  it("shelved 2: a neighbor landlord's utility is never paid by this landlord's credit; usable stops at eligible rows", async () => {
    const h = await house()
    const neighbor = await house()
    const inv = await invoiceFor(h)
    await issued(h, 1000)
    const rent = await charge(h, { amount: 460, invoiceId: inv })
    // S616: the neighbor's water rides this tenant's invoice: the neighbor's row, on no lease.
    const water = await charge(h, { amount: 40, type: 'utility', invoiceId: inv, landlordId: neighbor.landlordId, unitId: neighbor.unitId, leaseId: null })
    const q = await quote(h)
    const lq = q.leases.find(l => l.leaseId === h.leaseId)!
    expect(lq.requiredIds.sort()).toEqual([rent, water].sort())
    expect(lq.requiredTotal).toBe(500)
    expect(lq.neighborTotal).toBe(40)
    expect(lq.usableCredit).toBe(460)          // stops at the eligible rows
    expect(q.plan.find(l => l.paymentId === water)).toBeUndefined()
    expect(lq.coversWholeBill).toBe(false)
  })

  it('shelved 3: GAM fees, move-out deposit rows, FlexPay pulls and platform fees are never paid by credit', async () => {
    const h = await house()
    const credit = await issued(h, 1000)
    const gamFee = await charge(h, { amount: 6, type: 'fee', entry: 'RETURNFEE', owner: 'gam' })
    const moveOut = await charge(h, { amount: 120, type: 'fee', entry: 'DEPOSIT' })
    const flexpay = await charge(h, { amount: 25, type: 'fee', entry: 'FLEXPAY', owner: 'gam' })
    const platform = await charge(h, { amount: 10, type: 'platform_fee', entry: 'SUBSCRIP', owner: 'gam' })
    const q = await quote(h)
    expect(q.plan).toEqual([])
    for (const paymentId of [gamFee, moveOut, flexpay, platform]) {
      await expect(tx(c => applyCredit(c, [{ creditKind: 'issued', creditId: credit, paymentId, leaseId: h.leaseId, amount: 5, billingMonth: '2026-10-01' }], { source: 'desk' })))
        .rejects.toThrow(/not an eligible/)
    }
  })

  it('shelved 4: home payments are never paid by any credit', async () => {
    const h = await house()
    await paidAhead(h, 500)
    await issued(h, 500)
    await issued(h, 500, { leaseId: null })
    const home = await charge(h, { amount: 200, type: 'home_payment', entry: 'HOMEPMT' })
    const q = await quote(h)
    expect(q.plan).toEqual([])
    expect(q.leases[0].bankPayableTotal).toBe(200)   // the desk may still take it
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(home)).toBe('pending')
  })

  it('reopened rows and rows a work-trade agreement covers are never paid by credit', async () => {
    const h = await house()
    await issued(h, 1000)
    const orig = await charge(h, { amount: 460, status: 'returned' })
    const rev = await reversalOf(orig)
    const reopened = await charge(h, { amount: 460, reversalId: rev })
    const q = await quote(h)
    expect(q.leases[0].requiredIds).toContain(reopened)
    expect(q.plan.find(l => l.paymentId === reopened)).toBeUndefined()
    const wt = await charge(h, { amount: 300, due: '2026-11-01' })
    await db.query(`UPDATE payments SET work_trade_suspended_at = now() WHERE id = $1`, [wt])
    const q2 = await quote(h)
    expect(q2.plan.find(l => l.paymentId === wt)).toBeUndefined()
    expect(q2.leases[0].requiredIds).not.toContain(wt)
  })
})

// ─── The whole-bill rule ──────────────────────────────────────────────────────

describe('the whole-bill rule', () => {
  it('shelved 1: a credit covering the whole bill settles it — nothing shows $0 beside an open bill', async () => {
    const h = await house()
    const credit = await paidAhead(h, 460)
    const rent = await charge(h, { amount: 460 })
    const before = await quote(h)
    expect(before.leases[0].coversWholeBill).toBe(true)
    const r = await wholeBill(h)
    expect(r.settledIds).toEqual([rent])
    expect(await statusOf(rent)).toBe('settled')
    expect(await remainingPaidAhead(credit)).toBe(0)
    const after = await quote(h)
    expect(after.totals.required).toBe(0)
    expect(after.totals.creditOnFile).toBe(0)
    const row = (await db.query<any>(`SELECT notes, manual_method, platform_held FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.notes).toMatch(/Paid with account credit/)
    expect(row.manual_method).toBeNull()
    expect(row.platform_held).toBe(false)   // the landlord took this money already
    expect(await ownerShare(rent)).toBeNull()
    expect(await uses()).toMatchObject([{ status: 'applied', source: 'whole_bill', amount: 460, month: '2026-10-01' }])
  })

  it("MH 25: $10 saved against a $460 bill settles nothing and is offered to the tenant", async () => {
    const h = await house()
    const credit = await paidAhead(h, 10)
    const rent = await charge(h, { amount: 460 })
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(rent)).toBe('pending')
    expect(await remainingPaidAhead(credit)).toBe(10)
    const q = await quote(h)
    expect(q.leases[0].usableCredit).toBe(10)
    expect(q.leases[0].requiredTotal).toBe(460)
    expect(await uses()).toEqual([])
  })

  it('older open rows on the lease are part of the whole bill', async () => {
    const h = await house()
    await paidAhead(h, 500)
    const old = await charge(h, { amount: 30, type: 'late_fee', due: '2026-09-06' })
    const rent = await charge(h, { amount: 460 })
    expect((await wholeBill(h)).settledIds.sort()).toEqual([old, rent].sort())
    // $490 bill, $500 credit: both settled, $10 left.
    expect((await quote(h)).totals.creditOnFile).toBe(10)
  })

  it("a bill with a GAM fee or a neighbor's utility never auto-settles", async () => {
    const h = await house()
    await issued(h, 1000)
    const rent = await charge(h, { amount: 460 })
    const fee = await charge(h, { amount: 6, type: 'fee', entry: 'RETURNFEE', owner: 'gam' })
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(rent)).toBe('pending')
    expect(await statusOf(fee)).toBe('pending')

    const h2 = await house()
    const neighbor = await house()
    const inv = await invoiceFor(h2)
    await issued(h2, 1000)
    const rent2 = await charge(h2, { amount: 460, invoiceId: inv })
    await charge(h2, { amount: 40, type: 'utility', invoiceId: inv, landlordId: neighbor.landlordId, unitId: neighbor.unitId, leaseId: null })
    expect((await wholeBill(h2)).settledIds).toEqual([])
    expect(await statusOf(rent2)).toBe('pending')
  })

  it('a lease with a scheduled bank retry is skipped', async () => {
    const h = await house()
    await issued(h, 1000)
    const rent = await charge(h, { amount: 460, status: 'failed', intent: 'pi_retry_1', nextRetryAt: '2026-10-08T11:00:00Z' })
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(rent)).toBe('failed')
  })

  // decisions.md #46 1b: a bill whose payment is already on its way (a
  // scheduled bank retry for a fixed amount) gets no credit set aside — that
  // retry never uses credit. The free credit goes to a newer bill it covers
  // in full, which settles itself, instead of waiting behind the older one.
  it('#46 1b: an older bill with a scheduled retry sets no credit aside; the newer bill the general credit covers settles itself', async () => {
    const a = await house()
    const b = await house({ landlordId: a.landlordId, userId: a.userId, tenantId: a.tenantId })
    const general = await issued(a, 460, { leaseId: null })
    const retrying = await charge(a, { amount: 460, due: '2026-09-01', status: 'failed', intent: 'pi_retry_older', nextRetryAt: '2026-10-08T11:00:00Z' })
    const newer = await charge(b, { amount: 460, due: '2026-10-01' })
    // The free-only plan (the whole-bill rule's) skips the retrying row.
    const free = await quote(a, false)
    expect(free.plan.map(l => l.paymentId)).toEqual([newer])
    expect(free.leases.find(l => l.leaseId === b.leaseId)!.coversWholeBill).toBe(true)
    const r = await wholeBill(a)
    expect(r.settledIds).toEqual([newer])
    expect(await statusOf(newer)).toBe('settled')
    expect(await statusOf(retrying)).toBe('failed')
    expect(await remainingIssued(general)).toBe(0)
  })

  // Fix pass 3: this is the HOUSEHOLD plan with releasable credit (the desk
  // window, open balances, tenant credits read it) — not the payer's charge
  // plan. The payer's pay screen and autopay skip the retrying bill
  // (rentCharge chargeCreditLines; jobs/renewalCreditHandoff.test.ts and
  // jobs/autopayRunner.test.ts pin that). Whether these staff readers should
  // follow #46 1b too is for their owners (reported, fix pass 3).
  it('#46 1b does not change the household plan with releasable credit (staff readers): a general credit still goes to the older retrying bill first', async () => {
    const a = await house()
    const b = await house({ landlordId: a.landlordId, userId: a.userId, tenantId: a.tenantId })
    await issued(a, 460, { leaseId: null })
    const retrying = await charge(a, { amount: 460, due: '2026-09-01', status: 'failed', intent: 'pi_retry_older2', nextRetryAt: '2026-10-08T11:00:00Z' })
    await charge(b, { amount: 460, due: '2026-10-01' })
    expect((await quote(a)).plan.map(l => l.paymentId)).toEqual([retrying])
  })

  // S655 review (round 2): a shortened stay keeps rent past its new end when a
  // payment was tried on it (GAM never erases a record). The lease no longer
  // owes it, so credit must never pay it — not by the whole-bill rule, not by
  // "Use all $X" — and nobody is asked to pay it.
  it("rent past a booking-schedule stay's end is never asked for or paid by credit; the whole-bill rule leaves the bill and tells GAM once", async () => {
    const h = await house()
    await db.query(`UPDATE leases SET lease_source = 'booking_draft', end_date = '2026-10-15' WHERE id = $1`, [h.leaseId])
    const oct = await charge(h, { amount: 460, due: '2026-10-01' })                                         // inside the stay
    const nov = await charge(h, { amount: 460, due: '2026-11-01', status: 'failed', intent: 'pi_nov_bounced' }) // past the end, kept
    const credit = await paidAhead(h, 2000, 'reclassified')
    const q = await quote(h)
    const lq = q.leases[0]
    const row = (id: string) => lq.rows.find(r => r.id === id)!
    expect(row(nov)).toMatchObject({ pastStayEnd: true, payable: true, required: false, bankPayable: false, creditEligible: false })
    expect(row(oct)).toMatchObject({ pastStayEnd: false, required: true, creditEligible: true })
    expect(lq.requiredIds).toEqual([oct])
    expect(lq.pastStayEndRentIds).toEqual([nov])
    expect(lq.pastStayEndRentTotal).toBe(460)
    // "Use all $X" offers only what the lease owes.
    expect(lq.usableCredit).toBe(460)
    expect(planCredit(q, h.leaseId).map(l => l.paymentId)).toEqual([oct])
    expect(lq.heldBackByPastStayEnd).toBe(true)
    // A plan built by hand cannot put credit on it either.
    await expect(tx(c => applyCredit(c, [{ creditKind: 'paid_ahead', creditId: credit, paymentId: nov, leaseId: h.leaseId, amount: 460, billingMonth: '2026-11-01' }], { source: 'desk' })))
      .rejects.toThrow(/rent for after the stay ended/)

    // The whole-bill rule leaves the bill alone while the kept rent is there.
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(oct)).toBe('pending')
    expect(await statusOf(nov)).toBe('failed')
    expect(await remainingPaidAhead(credit)).toBe(2000)
    expect(await uses()).toEqual([])
    const alerts = async () => (await db.query<any>(
      `SELECT body, context FROM admin_notifications WHERE category = 'whole_bill_past_stay_end_rent'`)).rows
    expect(await alerts()).toHaveLength(1)
    expect((await alerts())[0].body).toContain('November 2026 $460.00')
    expect((await alerts())[0].context).toMatchObject({ lease_id: h.leaseId, past_stay_end_rent_ids: [nov] })
    // Told once: the next bill run and late-fee check add nothing, even after it is read.
    await db.query(`UPDATE admin_notifications SET acknowledged_at = now()`)
    await wholeBill(h)
    await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    expect(await alerts()).toHaveLength(1)

    // Once the kept rent is no longer open (however GAM takes it off), the credit pays the bill.
    await db.query(`UPDATE payments SET status = 'paid_via_deposit' WHERE id = $1`, [nov])
    expect((await wholeBill(h)).settledIds).toEqual([oct])
    expect(await remainingPaidAhead(credit)).toBe(1540)
  })

  it('shelved 7: no credit path splits a row; two late fees on one day settle whole (no 23505)', async () => {
    const h = await house()
    await issued(h, 100)
    const a = await charge(h, { amount: 25, type: 'late_fee', due: '2026-10-06' })
    const b = await charge(h, { amount: 25, type: 'late_fee', due: '2026-10-06' })
    const before = Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payments`)).rows[0].n)
    expect((await wholeBill(h)).settledIds.sort()).toEqual([a, b].sort())
    const rows = (await db.query<any>(`SELECT amount::float AS amount, status, is_remainder FROM payments ORDER BY id`)).rows
    expect(rows).toHaveLength(before)
    expect(rows.every((r: any) => r.amount === 25 && r.status === 'settled' && r.is_remainder === false)).toBe(true)
    // "Use all" on a bigger bill pays PART of a row with credit and never cuts it in two.
    const h2 = await house()
    await issued(h2, 10)
    const rent = await charge(h2, { amount: 460 })
    const q = await quote(h2)
    await tx(c => applyCredit(c, planCredit(q, h2.leaseId), { source: 'desk' }))
    const r2 = (await db.query<any>(`SELECT amount::float AS amount, status, issued_credit_amount::float AS issued FROM payments WHERE lease_id = $1`, [h2.leaseId])).rows
    expect(r2).toEqual([{ amount: 460, status: 'pending', issued: 10 }])
    expect(await statusOf(rent)).toBe('pending')
    // A later credit sees only the $450 still open on that row.
    await issued(h2, 1000)
    const again = await quote(h2)
    expect(again.leases[0].creditAlreadyApplied).toBe(10)
    expect(planCredit(again, h2.leaseId)).toMatchObject([{ paymentId: rent, amount: 450 }])
    expect(again.leases[0].coversWholeBill).toBe(true)
  })

  it("creating a credit settles nothing until the caller's commit", async () => {
    const h = await house()
    const rent = await charge(h, { amount: 460 })
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: h.leaseId, amount: 460, category: 'goodwill', createdBy: h.userId })
      await createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 5, fundedBy: 'landlord', receivedAt: new Date() })
      // Still open inside the creating transaction: nothing settled itself.
      expect((await c.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('pending')
      expect((await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM credit_uses`)).rows[0].n).toBe('0')
      await c.query('COMMIT')
    } finally { c.release() }
    expect(await statusOf(rent)).toBe('pending')
    // The caller's own whole-bill check, after its commit, is what settles it.
    expect((await wholeBill(h)).settledIds).toEqual([rent])
  })

  it('after a credit is committed, the after-commit check settles the covered bill and sends the "paid with your account credit" receipt', async () => {
    const h = await house()
    const rent = await charge(h, { amount: 460 })
    await issued(h, 460)
    expect(sendPaymentReceipt).not.toHaveBeenCalled()
    const r = await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId })
    expect(r?.settledIds).toEqual([rent])
    expect(await statusOf(rent)).toBe('settled')
    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
    expect(sendPaymentReceipt).toHaveBeenCalledWith(expect.objectContaining({ paymentIds: [rent], method: 'your account credit' }))
    // Nothing left to do: a second check settles nothing and sends nothing.
    expect((await runWholeBillCheckAfterCommit({ tenantId: h.tenantId, landlordId: h.landlordId }))?.settledIds).toEqual([])
    expect(sendPaymentReceipt).toHaveBeenCalledTimes(1)
  })

  it('the bill still stands when settling it fails: that lease rolls back, an admin is told', async () => {
    const h = await house()
    // GAM-held paid-ahead money needs the property's payout setup to book the
    // landlord's share; without an allocation rule that step throws.
    await db.query(`DELETE FROM property_allocation_rules WHERE property_id = $1`, [h.propertyId])
    const credit = await paidAhead(h, 460, 'gam')
    const rent = await charge(h, { amount: 460 })
    const r = await wholeBill(h)
    expect(r.settledIds).toEqual([])
    expect(await statusOf(rent)).toBe('pending')
    expect(await remainingPaidAhead(credit)).toBe(460)
    expect(await uses()).toEqual([])
    const n = await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'whole_bill_credit_failed'`)
    expect(n.rowCount).toBe(1)
  })
})

// ─── Spend order and the monthly cap ─────────────────────────────────────────

describe('spend order', () => {
  it('order: paid-ahead, then lease credit and deposit interest, then general credit, oldest rows first', async () => {
    const h = await house()
    const general = await issued(h, 100, { leaseId: null })              // created first, spent last
    const interest = await issued(h, 20, { leaseId: null, category: 'deposit_interest' })
    const leaseCredit = await issued(h, 30)
    const ahead = await paidAhead(h, 40)
    const sep = await charge(h, { amount: 50, type: 'utility', due: '2026-09-01' })
    const oct = await charge(h, { amount: 460, due: '2026-10-01' })
    const q = await quote(h)
    expect(q.plan.map(l => [l.creditId, l.paymentId, l.amount])).toEqual([
      [ahead, sep, 40],          // paid ahead first, on the oldest row
      [interest, sep, 10],       // tier two, by age: interest was created before the lease credit
      [interest, oct, 10],
      [leaseCredit, oct, 30],
      [general, oct, 100],       // the tenant's general credit last
    ])
    expect(q.plan.find(l => l.creditId === interest)!.creditKind).toBe('deposit_interest')
  })

  it('on one due date the credit goes on rent before water and trash (Kim Harland)', async () => {
    const h = await house()
    await issued(h, 450)
    // Same due date, same creation instant: only the type order decides.
    const ids = (await db.query<{ id: string; type: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       SELECT $1, $2, $3, $4, t.type, t.amount, 'pending', DATE '2026-09-01', t.entry, TIMESTAMPTZ '2026-09-04 13:12:54-07'
         FROM (VALUES ('utility', 10.45, 'UTILITY'), ('utility', 25.00, 'UTILITY'), ('rent', 900.00, 'RENT')) AS t(type, amount, entry)
       RETURNING id, type`, [h.unitId, h.leaseId, h.tenantId, h.landlordId])).rows
    const rent = ids.find(r => r.type === 'rent')!.id
    expect((await quote(h)).plan).toMatchObject([{ paymentId: rent, amount: 450 }])
  })

  it('the monthly paid-ahead cap counts held and applied uses', async () => {
    const h = await house()
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id = $1`, [h.leaseId])
    const ahead = await paidAhead(h, 2000)
    const water = await charge(h, { amount: 60, type: 'utility' })
    const rent = await charge(h, { amount: 589 })
    // Held on a charge that is clearing: counts against October.
    const rem = await remittance(h, { amount: 529 })
    await tx(c => holdCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: water, leaseId: h.leaseId, amount: 60, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'portal' }))
    let q = await quote(h, false)
    expect(planCredit(q, h.leaseId)).toMatchObject([{ paymentId: rent, amount: 140 }])
    // Applied: still counts.
    await tx(c => applyHeldForRemittance(c, rem))
    q = await quote(h)
    expect(planCredit(q, h.leaseId)).toMatchObject([{ paymentId: rent, amount: 140 }])
    // Given back: no longer counts.
    const h2 = await house()
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id = $1`, [h2.leaseId])
    const ahead2 = await paidAhead(h2, 2000)
    const w2 = await charge(h2, { amount: 60, type: 'utility' })
    const r2 = await charge(h2, { amount: 589 })
    const rem2 = await remittance(h2, { amount: 529 })
    await tx(c => holdCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead2, paymentId: w2, leaseId: h2.leaseId, amount: 60, billingMonth: '2026-10-01' }], { remittanceId: rem2, source: 'portal' }))
    await tx(c => releaseHeldForRemittance(c, rem2, 'payment_failed'))
    q = await quote(h2)
    // Same due date: rent before water, so the month's $200 goes on rent.
    expect(planCredit(q, h2.leaseId)).toMatchObject([{ paymentId: r2, amount: 200 }])
    expect(planCredit(q, h2.leaseId).find(l => l.paymentId === w2)).toBeUndefined()
    // November is a fresh month.
    const nov = await charge(h, { amount: 589, due: '2026-11-01' })
    q = await quote(h)
    expect(planCredit(q, h.leaseId).find(l => l.paymentId === nov)).toMatchObject({ amount: 200, billingMonth: '2026-11-01' })
  })

  it('buildCreditPlan never covers a row twice or past its amount', () => {
    const row = (id: string, amount: number, due: string): QuoteRow => ({
      id, leaseId: 'L', scopeLeaseId: 'L', invoiceId: null, landlordId: 'X', tenantId: 'T', type: 'rent',
      entryDescription: 'RENT', revenueOwner: 'landlord', status: 'pending', amount, dueDate: due,
      createdAt: '2026-09-01T00:00:00.000Z', billingMonth: `${due.slice(0, 7)}-01`, stripePaymentIntentId: null,
      nextRetryAt: null, payable: true, inFlight: false, required: true, bankPayable: true, creditEligible: true,
      carried: false, gamOwned: false, neighbor: false, retryScheduled: false, heldOnRow: 0, appliedOnRow: 0,
      pastStayEnd: false,
    })
    const credit = (id: string, kind: 'paid_ahead' | 'issued', amt: number, leaseId: string | null) => ({
      kind, id, leaseId, tenantId: 'T', amountRemaining: amt, releasable: 0, disputed: 0, createdAt: '2026-08-01T00:00:00.000Z',
      fundedBy: null, gamHeld: false, category: null,
    })
    const plan = buildCreditPlan({
      rows: [row('a', 100, '2026-09-01'), row('b', 50, '2026-10-01')],
      credits: [credit('c1', 'paid_ahead', 120, 'L'), credit('c2', 'issued', 500, null)],
      caps: new Map([['L', null]]), drawn: new Map(), tenantId: 'T', tenantOnLease: new Set(['L']), includeReleasable: true,
    })
    expect(plan.map(l => [l.creditId, l.paymentId, l.amount])).toEqual([['c1', 'a', 100], ['c1', 'b', 20], ['c2', 'b', 30]])
  })
})

// ─── Charges that clear later ─────────────────────────────────────────────────

describe('credit set aside on a charge that is clearing', () => {
  it('held → applied once; held → released gives it back once', async () => {
    const h = await house()
    const credit = await issued(h, 10)
    const rent = await charge(h, { amount: 460 })
    const rem = await remittance(h, { amount: 450 })
    const q = await quote(h)
    await tx(c => holdCredit(c, planCredit(q, h.leaseId), { remittanceId: rem, source: 'portal' }))
    expect(await remainingIssued(credit)).toBe(0)
    expect(await tx(c => applyHeldForRemittance(c, rem))).toBe(10)
    expect(await tx(c => applyHeldForRemittance(c, rem))).toBe(0)       // a replayed webhook changes nothing
    expect((await db.query<any>(`SELECT issued_credit_amount::float AS i FROM payments WHERE id = $1`, [rent])).rows[0].i).toBe(10)
    expect(await tx(c => releaseHeldForRemittance(c, rem, 'payment_failed'))).toBe(0)  // nothing held any more
    expect(await remainingIssued(credit)).toBe(0)

    const rem2 = await remittance(h, { amount: 460 })
    const credit2 = await issued(h, 25)
    const late = await charge(h, { amount: 25, type: 'late_fee' })
    await tx(c => holdCredit(c, [{ creditKind: 'issued', creditId: credit2, paymentId: late, leaseId: h.leaseId, amount: 25, billingMonth: '2026-10-01' }], { remittanceId: rem2, source: 'autopay' }))
    expect(await tx(c => releaseHeldForRemittance(c, rem2, 'payment_canceled'))).toBe(25)
    expect(await tx(c => releaseHeldForRemittance(c, rem2, 'payment_canceled'))).toBe(0)
    expect(await remainingIssued(credit2)).toBe(25)
  })

  it('only a card or bank charge may hold credit', async () => {
    const h = await house()
    const credit = await issued(h, 10)
    const rent = await charge(h, { amount: 460 })
    await expect(tx(c => holdCredit(c, [{ creditKind: 'issued', creditId: credit, paymentId: rent, leaseId: h.leaseId, amount: 10, billingMonth: '2026-10-01' }], { remittanceId: 'x', source: 'desk' })))
      .rejects.toThrow(/card or bank/)
  })

  it("supersedeScheduledRetry releases the old remittance's held credit once and returns the intent to cancel", async () => {
    const h = await house()
    const credit = await issued(h, 10)
    const rent = await charge(h, { amount: 460 })
    const water = await charge(h, { amount: 40, type: 'utility' })
    const rem = await remittance(h, { amount: 490, intent: 'pi_old_pull' })
    const q = await quote(h)
    await tx(c => holdCredit(c, planCredit(q, h.leaseId), { remittanceId: rem, source: 'portal' }))
    // The pull bounced; a retry is scheduled on both rows.
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_old_pull', next_retry_at = now() + interval '3 days' WHERE id = ANY($1::uuid[])`, [[rent, water]])
    // Paying now sees the held $10 as usable again.
    const now = await quote(h)
    expect(now.leases[0].heldReleasable).toBe(10)
    expect(now.leases[0].usableCredit).toBe(10)
    expect(now.leases[0].scheduledRetries).toMatchObject([{ paymentIntentId: 'pi_old_pull' }])
    // The whole-bill rule never counts it.
    expect((await quote(h, false)).leases[0].usableCredit).toBe(0)

    const r = await tx(c => supersedeScheduledRetry(c, [rent]))
    expect(r).toEqual({ cancelAfterCommit: ['pi_old_pull'], released: 10 })
    expect(await remainingIssued(credit)).toBe(10)
    expect(await uses()).toMatchObject([{ status: 'released', release_reason: 'superseded' }])
    const sched = (await db.query<any>(`SELECT next_retry_at FROM payments WHERE id = ANY($1::uuid[])`, [[rent, water]])).rows
    expect(sched.every((s: any) => s.next_retry_at === null)).toBe(true)
    // Once: a second call finds nothing.
    expect(await tx(c => supersedeScheduledRetry(c, [rent]))).toEqual({ cancelAfterCommit: [], released: 0 })
    // And the credit is free for the new payment.
    const after = await quote(h)
    await tx(c => applyCredit(c, planCredit(after, h.leaseId), { source: 'desk' }))
    expect(await remainingIssued(credit)).toBe(0)
  })
})

// ─── Credit-only settle ───────────────────────────────────────────────────────

describe('settleFromCredit ("Pay with credit — nothing charged")', () => {
  it('settles every required row and books the GAM-held part with no second fee, marking the row platform_held', async () => {
    const h = await house()
    const ahead = await paidAhead(h, 500, 'gam')
    const rent = await charge(h, { amount: 460 })
    const r = await tx(c => settleFromCredit(c, { leaseId: h.leaseId, tenantId: h.tenantId, source: 'portal', expectedCredit: 460, receipt: false }))
    expect(r.settledIds).toEqual([rent])
    expect(r.creditUsed).toBe(460)
    expect(r.ownerShareBooked).toBe(460)
    expect(await ownerShare(rent)).toBe(460)
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE reference_id = $1`, [rent])).rowCount).toBe(0)
    const row = (await db.query<any>(`SELECT platform_held, manual_method FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row).toEqual({ platform_held: true, manual_method: null })
    expect(await remainingPaidAhead(ahead)).toBe(40)
  })

  it('refuses with 409 when the credit moved since the screen loaded, and charges nothing', async () => {
    const h = await house()
    await issued(h, 460)
    const rent = await charge(h, { amount: 460 })
    await expect(tx(c => settleFromCredit(c, { leaseId: h.leaseId, tenantId: h.tenantId, source: 'portal', expectedCredit: 500, receipt: false })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/now \$460\.00/) })
    expect(await statusOf(rent)).toBe('pending')
    expect(await uses()).toEqual([])
  })

  it('refuses when the credit does not cover the whole bill', async () => {
    const h = await house()
    await issued(h, 10)
    await charge(h, { amount: 460 })
    await expect(tx(c => settleFromCredit(c, { leaseId: h.leaseId, tenantId: h.tenantId, source: 'portal', receipt: false })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/does not cover this whole bill/) })
  })

  it('pays over a scheduled retry: the retry gives its credit back first and is returned for canceling', async () => {
    const h = await house()
    await issued(h, 460)
    const rent = await charge(h, { amount: 460 })
    const rem = await remittance(h, { amount: 450, intent: 'pi_bounced' })
    const credit2 = await issued(h, 10)
    await tx(c => holdCredit(c, [{ creditKind: 'issued', creditId: credit2, paymentId: rent, leaseId: h.leaseId, amount: 10, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'autopay' }))
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_bounced', next_retry_at = now() + interval '3 days' WHERE id = $1`, [rent])
    const r = await tx(c => settleFromCredit(c, { leaseId: h.leaseId, tenantId: h.tenantId, source: 'portal', receipt: false }))
    expect(r.settledIds).toEqual([rent])
    expect(r.cancelAfterCommit).toEqual(['pi_bounced'])
    expect(await statusOf(rent)).toBe('settled')
  })
})

describe('createIssuedCredit', () => {
  it('refuses $0, an unknown category, and a lease of another landlord', async () => {
    const h = await house()
    const other = await house()
    const make = (o: Partial<{ amount: number; category: string; leaseId: string }>) => tx(c => createIssuedCredit(c, {
      landlordId: h.landlordId, tenantId: h.tenantId, leaseId: o.leaseId ?? h.leaseId,
      amount: o.amount ?? 10, category: o.category ?? 'goodwill', createdBy: h.userId,
    }))
    await expect(make({ amount: 0 })).rejects.toMatchObject({ statusCode: 400 })
    await expect(make({ category: 'bonus' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(make({ leaseId: other.leaseId })).rejects.toMatchObject({ statusCode: 409 })
    expect((await db.query(`SELECT 1 FROM tenant_credits`)).rowCount).toBe(0)
  })
})

// ─── Withdrawing paid-ahead money ─────────────────────────────────────────────

describe('voidPaidAhead', () => {
  it('withdraws unused money, leaves amount_remaining as it was, and takes it out of every quote', async () => {
    const h = await house()
    const ahead = await paidAhead(h, 40)
    await charge(h, { amount: 460 })
    await tx(c => voidPaidAhead(c, ahead, 'the bank deposit was undone'))
    const row = (await db.query<any>(`SELECT amount_remaining::float AS r, void_reason FROM lease_prepaid_credits WHERE id = $1`, [ahead])).rows[0]
    expect(row).toEqual({ r: 40, void_reason: 'the bank deposit was undone' })
    expect((await quote(h)).totals.creditOnFile).toBe(0)
  })

  it('is refused once the money was used', async () => {
    const h = await house()
    const ahead = await paidAhead(h, 40)
    await charge(h, { amount: 460 })
    const q = await quote(h)
    await tx(c => applyCredit(c, planCredit(q, h.leaseId), { source: 'desk' }))
    await expect(tx(c => voidPaidAhead(c, ahead, 'undo'))).rejects.toMatchObject({ statusCode: 409 })
  })
})

// ─── Disputes ─────────────────────────────────────────────────────────────────

describe('clawBackRemittanceCredit', () => {
  async function disputedSurplus() {
    const h = await house()
    // A $1,000 card payment paid $460 and banked $540 paid ahead through GAM.
    const rem = await remittance(h, { amount: 1000, method: 'card', status: 'settled' })
    const ahead = await paidAhead(h, 540, 'gam', h.leaseId, { sourceRemittanceId: rem })
    const nov = await charge(h, { amount: 460, due: '2026-11-01' })
    const dec = await charge(h, { amount: 60, type: 'utility', due: '2026-12-01' })
    const q = await quote(h)
    await tx(c => applyCredit(c, planCredit(q, h.leaseId), { source: 'whole_bill' }))
    const orig = await charge(h, { amount: 460, status: 'returned', due: '2026-10-01' })
    const rev = await reversalOf(orig)
    return { h, rem, ahead, nov, dec, rev }
  }

  it("dispute clawback reverses later spends of a disputed remittance's paid-ahead money and drains the rest", async () => {
    const { rem, ahead, nov, dec, rev } = await disputedSurplus()
    expect(await remainingPaidAhead(ahead)).toBe(20)
    const r = await tx(c => clawBackRemittanceCredit(c, rem, rev))
    expect(r.creditId).toBe(ahead)
    expect(r.reversed.map(x => [x.paymentId, x.amount]).sort()).toEqual([[dec, 60], [nov, 460]].sort())
    expect(r.drained).toBe(540)
    expect(await remainingPaidAhead(ahead)).toBe(0)
    const all = await uses()
    expect(all.filter((u: any) => u.status === 'reversed')).toHaveLength(2)
    expect(all.filter((u: any) => u.source === 'reversal')).toMatchObject([{ status: 'applied', amount: 540 }])
    // I1: original = remaining + live uses.
    const live = all.filter((u: any) => u.status === 'applied' || u.status === 'held').reduce((s: number, u: any) => s + u.amount, 0)
    expect(live).toBe(540)
  })

  it('a partial clawback takes unspent money first, then whole spends newest first', async () => {
    const { rem, ahead, dec, rev } = await disputedSurplus()
    // $80 disputed: $20 unspent, then the newest spend ($60 December water).
    const r = await tx(c => clawBackRemittanceCredit(c, rem, rev, { maxAmount: 80 }))
    expect(r.reversed.map(x => x.paymentId)).toEqual([dec])
    expect(r.clawed).toBe(80)
    expect(await remainingPaidAhead(ahead)).toBe(0)
  })

  it('no paid-ahead money behind the remittance: nothing to claw back', async () => {
    const h = await house()
    const rem = await remittance(h, { amount: 460, method: 'card', status: 'settled' })
    const orig = await charge(h, { amount: 460, status: 'returned' })
    const rev = await reversalOf(orig)
    expect(await tx(c => clawBackRemittanceCredit(c, rem, rev))).toMatchObject({ creditId: null, drained: 0 })
  })

  // S655 review: the clawback leaves money a charge in flight set aside (stillHeld).
  // When that charge then fails, is canceled or is replaced, releasing it used to
  // put disputed money back on the credit — spendable again, and paid out again
  // if GAM-funded. Round 2: what the dispute still claims is read from the
  // dispute itself (connect_disputes, as recordDisputeEvent writes it) less what
  // came off the charge's rows and the credit, so a release takes back exactly
  // what the dispute took — no more, no less.
  /**
   * A card payment (pi_funding) paid October's $460 (and $40 of water when
   * `standing`) and banked `ahead` paid ahead through GAM; November's $460 rent
   * is being paid with `held` of that credit plus the rest by a bank payment
   * still clearing (pi_nov).
   */
  async function setAsideWhenDisputed(o: { ahead: number; held: number; standing?: boolean }) {
    const h = await house()
    const total = 460 + (o.standing ? 40 : 0) + o.ahead
    const funding = await remittance(h, { amount: total, method: 'card', status: 'settled', intent: 'pi_funding' })
    const oct = await charge(h, { amount: 460, status: 'settled', intent: 'pi_funding' })
    const water = o.standing ? await charge(h, { amount: 40, type: 'utility', status: 'settled', intent: 'pi_funding' }) : null
    const ahead = await paidAhead(h, o.ahead, 'gam', h.leaseId, { sourceRemittanceId: funding })
    const nov = await charge(h, { amount: 460, due: '2026-11-01' })
    const pay = await remittance(h, { amount: 460 - o.held, intent: 'pi_nov' })
    await tx(c => holdCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: nov, leaseId: h.leaseId, amount: o.held, billingMonth: '2026-11-01' }],
      { remittanceId: pay, source: 'portal' }))
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_nov' WHERE id = $1`, [nov])
    return { h, funding, total, oct, water, ahead, nov, pay }
  }
  /** Stripe opens a dispute of `amount` on a charge (recordDisputeEvent writes it). */
  const disputeOpened = async (amount: number, intent = 'pi_funding') => (await db.query<{ id: string }>(
    `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
     VALUES ('dp_' || gen_random_uuid(), 'ch_' || gen_random_uuid(), $1, $2, 'needs_response') RETURNING id`,
    [intent, amount.toFixed(2)])).rows[0].id
  /**
   * The dispute handler's record for `row` (one per event and row): the row lost
   * `amount` and reopens (returned); a row that lost nothing keeps its status.
   */
  const rowRecord = async (row: string, amount: number) => {
    if (amount > 0) await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [row])
    return (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1, 'card_dispute', $2, 'evt_' || gen_random_uuid(), '{}'::jsonb) RETURNING id`,
      [row, amount.toFixed(2)])).rows[0].id
  }
  const usable = async (h: House) => (await quote(h)).totals
  const drainsOf = async (credit: string) =>
    (await uses(`prepaid_credit_id = $1 AND source = 'reversal'`, [credit])).map((u: any) => [u.amount, u.status])

  it('disputed paid-ahead money set aside by a charge that later fails is never spendable again', async () => {
    const { h, funding, total, oct, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 540, held: 400 })
    // The whole $1,000 charge is disputed: October reopens in full.
    await disputeOpened(total)
    const rev = await rowRecord(oct, 460)
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, rev))
    expect(claw.drained).toBe(140)                                 // the unspent part
    expect(claw.heldClaimed).toBe(400)
    expect(claw.stillHeld).toMatchObject([{ paymentId: nov, amount: 400 }])

    // November's bank payment fails for good: its $400 of credit is not given back.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    expect(await remainingPaidAhead(ahead)).toBe(0)
    const t = await usable(h)
    expect(t.creditOnFile).toBe(0)
    expect(t.usableCredit).toBe(0)
    expect(await drainsOf(ahead)).toEqual([[140, 'applied'], [400, 'applied']])
    expect((await db.query<any>(`SELECT COUNT(DISTINCT payment_reversal_id)::int AS n FROM credit_uses WHERE prepaid_credit_id = $1 AND source = 'reversal'`, [ahead])).rows[0].n).toBe(1)
    // I1 holds: $540 = $0 remaining + $540 of live uses (both drains).
    const live = (await uses(`prepaid_credit_id = $1 AND status IN ('held','applied')`, [ahead])).reduce((s: number, u: any) => s + u.amount, 0)
    expect(live).toBe(540)
    // The whole-bill rule finds nothing to spend on November.
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(nov)).toBe('failed')
  })

  it('disputed paid-ahead money wholly set aside at the dispute is drained when the tenant pays over that retry', async () => {
    // Nothing unspent and nothing spent when the dispute lands: the clawback
    // writes no drain; the dispute's record on the funding charge's reopened
    // row is what the later take-back names.
    const { h, funding, total, oct, ahead, nov } = await setAsideWhenDisputed({ ahead: 400, held: 400 })
    await disputeOpened(total)
    const rev = await rowRecord(oct, 460)
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, rev))
    expect(claw.drained).toBe(0)
    expect(claw.stillHeld).toHaveLength(1)
    // The bank payment bounced with a retry scheduled; the tenant pays now.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = $1`, [nov])
    const r = await tx(c => supersedeScheduledRetry(c, [nov]))
    expect(r.cancelAfterCommit).toEqual(['pi_nov'])
    expect(await remainingPaidAhead(ahead)).toBe(0)
    expect((await usable(h)).usableCredit).toBe(0)
    expect(await uses(`prepaid_credit_id = $1 AND source = 'reversal'`, [ahead])).toMatchObject([{ amount: 400, status: 'applied' }])
  })

  it('a partial dispute that left a row of the funding charge standing gives the set-aside money back to the tenant', async () => {
    const { h, funding, oct, water, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 540, held: 400, standing: true })
    // $140 disputed: the unspent $140 covers it, so no row loses money.
    await disputeOpened(140)
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, null, { maxAmount: 140 }))
    expect(claw).toMatchObject({ clawed: 140, heldClaimed: 0, drained: 0, drainPending: 140 })
    // The handler records the event on the charge's rows (each lost $0) and takes the $140 back.
    const rev = await rowRecord(water!, 0)
    await rowRecord(oct, 0)
    expect(await tx(c => takeBackDisputedCredit(c, ahead, rev))).toEqual({ drained: 140, withdrawn: false, unrecorded: 0 })
    expect([await statusOf(oct), await statusOf(water!)]).toEqual(['settled', 'settled'])
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    // That $400 was never part of the dispute: it is the tenant's to spend.
    expect(await remainingPaidAhead(ahead)).toBe(400)
    expect((await usable(h)).usableCredit).toBe(400)
    expect(await drainsOf(ahead)).toEqual([[140, 'applied']])
  })

  it('a partial dispute that reopens every row leaves set-aside money the dispute did not take with the tenant', async () => {
    // $860 = October's $460 + $400 paid ahead, all of it set aside by November's
    // bank payment. A $460 dispute that the handler took entirely off October
    // (it reopened in full) took nothing from the paid-ahead money.
    const { h, total, oct, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 400, held: 400 })
    expect(total).toBe(860)
    await disputeOpened(460)
    await rowRecord(oct, 460)
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    // Stripe took back $460, all of it October's: GAM keeps none of the tenant's $400.
    expect(await remainingPaidAhead(ahead)).toBe(400)
    expect(await drainsOf(ahead)).toEqual([])
    expect((await usable(h)).usableCredit).toBe(400)
  })

  it('a partial dispute counts set-aside money before rows: rows reopen only for the rest, and a failed charge gives back only what the dispute did not take', async () => {
    // $1,000 = October $460 + $540 paid ahead: $400 set aside on November, $140 unspent.
    const { h, funding, oct, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 540, held: 400 })
    await disputeOpened(300)
    // §3: the surplus first — the unspent $140, then $160 of the $400 set aside.
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, null, { maxAmount: 300 }))
    expect(claw).toMatchObject({ drainPending: 140, heldClaimed: 160, clawed: 300, reversed: [] })
    // Nothing is left for the rows: October loses $0 and stays paid.
    const rev = await rowRecord(oct, 300 - claw.clawed)
    expect((await tx(c => takeBackDisputedCredit(c, ahead, rev))).drained).toBe(140)
    expect(await statusOf(oct)).toBe('settled')
    // November's bank payment fails: $160 of its $400 was the dispute's; $240 is the tenant's.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    expect(await remainingPaidAhead(ahead)).toBe(240)
    expect(await drainsOf(ahead)).toEqual([[140, 'applied'], [160, 'applied']])
    expect((await usable(h)).usableCredit).toBe(240)
    // I1: $540 = $240 remaining + $300 drained.
    const live = (await uses(`prepaid_credit_id = $1 AND status IN ('held','applied')`, [ahead])).reduce((s: number, u: any) => s + u.amount, 0)
    expect(live).toBe(300)
  })

  it('a $460 dispute on $860 with $400 set aside: October reopens for $60 and the failed charge takes back the $400', async () => {
    const { funding, oct, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 400, held: 400 })
    await disputeOpened(460)
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, null, { maxAmount: 460 }))
    expect(claw).toMatchObject({ heldClaimed: 400, clawed: 400, drainPending: 0 })
    const rev = await rowRecord(oct, 460 - claw.clawed)          // $60 comes off October
    expect((await tx(c => takeBackDisputedCredit(c, ahead, rev))).drained).toBe(0)
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))
    // $460 = $60 off October + the $400 set aside.
    expect(await remainingPaidAhead(ahead)).toBe(0)
    expect(await drainsOf(ahead)).toEqual([[400, 'applied']])
  })

  it('a charge that clears after the dispute claimed its set-aside money reverses that spend and takes back only the claimed part', async () => {
    const { funding, oct, ahead, nov, pay } = await setAsideWhenDisputed({ ahead: 540, held: 400 })
    await disputeOpened(300)
    await tx(c => clawBackRemittanceCredit(c, funding, null, { maxAmount: 300 }))
    const rev = await rowRecord(oct, 0)
    await tx(c => takeBackDisputedCredit(c, ahead, rev))
    // November's payment clears: the $400 set aside is spent — $160 of it disputed money.
    await db.query(`UPDATE payments SET status = 'settled' WHERE id = $1`, [nov])
    expect(await tx(c => applyHeldForRemittance(c, pay))).toBe(400)
    const r = await tx(c => reverseHeldSpendsOfDisputedMoney(c, pay))
    expect(r.reversed.map(x => [x.paymentId, x.amount])).toEqual([[nov, 400]])   // November reopens for $400 (Step 10)
    expect(r.drained).toBe(160)
    expect(await remainingPaidAhead(ahead)).toBe(240)
    expect(await drainsOf(ahead)).toEqual([[140, 'applied'], [160, 'applied']])
    // Redelivered: nothing more.
    expect(await tx(c => reverseHeldSpendsOfDisputedMoney(c, pay))).toEqual({ reversed: [], drained: 0, pendingCredits: [] })
  })

  /** A $400 card payment (pi_surplus) that paid no bill: all of it banked paid ahead through GAM. */
  async function surplusOnly(h: House) {
    const funding = await remittance(h, { amount: 400, method: 'card', status: 'settled', intent: 'pi_surplus' })
    const ahead = await paidAhead(h, 400, 'gam', h.leaseId, { sourceRemittanceId: funding })
    return { funding, ahead }
  }

  it('a disputed charge that paid no rows never leaves its paid-ahead money spendable or paid out', async () => {
    const h = await house()
    const { ahead } = await surplusOnly(h)
    // November's $400 is being paid with all of that credit by a bank payment still clearing.
    const nov = await charge(h, { amount: 400, due: '2026-11-01' })
    const pay = await remittance(h, { amount: 0.01, intent: 'pi_nov2' })
    await tx(c => holdCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: nov, leaseId: h.leaseId, amount: 400, billingMonth: '2026-11-01' }],
      { remittanceId: pay, source: 'portal' }))
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_nov2' WHERE id = $1`, [nov])
    // The $400 charge is disputed in full. No row carries it, so no reversal record can.
    await disputeOpened(400, 'pi_surplus')
    // November's payment fails before any handler ran: the $400 is not given back.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    const row = (await db.query<any>(`SELECT voided_at IS NOT NULL AS voided, void_reason FROM lease_prepaid_credits WHERE id = $1`, [ahead])).rows[0]
    expect(row.voided).toBe(true)
    expect(row.void_reason).toMatch(/disputed/)
    const t = await usable(h)
    expect([t.usableCredit, t.creditOnFile]).toEqual([0, 0])
    // The whole-bill rule spends nothing, so nothing is paid out to the owner.
    expect((await wholeBill(h)).settledIds).toEqual([])
    expect(await statusOf(nov)).toBe('failed')
    expect(await ownerShare(nov)).toBeNull()
    // The dispute handler, by charge, finds the credit already withdrawn.
    const r = await tx(c => clawBackDisputedCharge(c, { paymentIntentId: 'pi_surplus', reversalId: null }))
    expect(r).toMatchObject({ creditId: ahead, withdrawn: true, reversed: [], drained: 0 })
  })

  it('the dispute handler withdraws a fully disputed no-row charge\'s credit and undoes its spends', async () => {
    const h = await house()
    const { ahead } = await surplusOnly(h)
    const water = await charge(h, { amount: 150, type: 'utility' })
    await tx(c => applyCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: water, leaseId: h.leaseId, amount: 150, billingMonth: '2026-10-01' }], { source: 'whole_bill' }))
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [water])
    await disputeOpened(400, 'pi_surplus')
    const r = await tx(c => clawBackDisputedCharge(c, { paymentIntentId: 'pi_surplus', reversalId: null }))
    expect(r.withdrawn).toBe(true)
    expect(r.reversed.map(x => [x.paymentId, x.amount])).toEqual([[water, 150]])   // the handler reopens the water
    // I1: $400 = $400 remaining (withdrawn) + no live use.
    expect(await remainingPaidAhead(ahead)).toBe(400)
    expect(await uses(`prepaid_credit_id = $1 AND status IN ('held','applied')`, [ahead])).toEqual([])
    expect((await usable(h)).creditOnFile).toBe(0)
  })

  it('a partial dispute of a charge that paid no rows keeps the disputed part out of every quote and tells GAM once', async () => {
    const h = await house()
    const { ahead } = await surplusOnly(h)
    await charge(h, { amount: 460 })
    await disputeOpened(150, 'pi_surplus')
    const r = await tx(c => clawBackDisputedCharge(c, { paymentIntentId: 'pi_surplus', reversalId: null, maxAmount: 150 }))
    expect(r).toMatchObject({ creditId: ahead, withdrawn: false, unrecorded: 150, drained: 0 })
    const q = await quote(h)
    expect(q.totals.creditOnFile).toBe(250)
    expect(q.totals.usableCredit).toBe(250)
    expect(q.credits.find(c => c.id === ahead)?.disputed).toBe(150)
    await tx(c => clawBackDisputedCharge(c, { paymentIntentId: 'pi_surplus', reversalId: null, maxAmount: 150 }))
    const alerts = (await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'disputed_credit_unrecorded' AND context->>'credit_id' = $1`, [ahead])).rowCount
    expect(alerts).toBe(1)
  })

  it('paid-ahead money a recorded dispute claims is kept out of the quote before the dispute handler runs', async () => {
    const h = await house()
    const funding = await remittance(h, { amount: 1000, method: 'card', status: 'settled', intent: 'pi_funding' })
    await charge(h, { amount: 460, status: 'settled', intent: 'pi_funding' })
    await paidAhead(h, 540, 'gam', h.leaseId, { sourceRemittanceId: funding })
    await charge(h, { amount: 460, due: '2026-11-01' })
    expect((await usable(h)).usableCredit).toBe(460)
    const d = await disputeOpened(100)
    expect((await usable(h)).creditOnFile).toBe(440)
    // Stripe moves it to the full charge: none of it is the tenant's.
    await db.query(`UPDATE connect_disputes SET amount = 1000 WHERE id = $1`, [d])
    expect(await usable(h)).toMatchObject({ creditOnFile: 0, usableCredit: 0 })
    // A dispute GAM won gave the money back.
    await db.query(`UPDATE connect_disputes SET status = 'won' WHERE id = $1`, [d])
    expect((await usable(h)).creditOnFile).toBe(540)
  })

  it('choice46c triage: a partial dispute that reverses a spend on a row of the charge, then a released set-aside, takes back exactly the claimed amount (the spend is never counted twice)', async () => {
    // $1,000 = October's $460 (its own money) + $540 paid ahead through GAM.
    // $60 of it paid a water row that carries the same charge (the charge
    // failed for good, then succeeded); $400 is set aside by November's bank
    // payment still clearing; $80 is unspent.
    const h = await house()
    const funding = await remittance(h, { amount: 1000, method: 'card', status: 'settled', intent: 'pi_funding' })
    await charge(h, { amount: 460, status: 'settled', intent: 'pi_funding' })
    const ahead = await paidAhead(h, 540, 'gam', h.leaseId, { sourceRemittanceId: funding })
    const water = await charge(h, { amount: 60, type: 'utility' })
    await tx(c => applyCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: water, leaseId: h.leaseId, amount: 60, billingMonth: '2026-10-01' }], { source: 'whole_bill' }))
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = 'pi_funding' WHERE id = $1`, [water])
    const nov = await charge(h, { amount: 460, due: '2026-11-01' })
    const pay = await remittance(h, { amount: 60, intent: 'pi_nov' })
    await tx(c => holdCredit(c, [{ creditKind: 'paid_ahead', creditId: ahead, paymentId: nov, leaseId: h.leaseId, amount: 400, billingMonth: '2026-11-01' }],
      { remittanceId: pay, source: 'portal' }))
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_nov' WHERE id = $1`, [nov])
    expect(await remainingPaidAhead(ahead)).toBe(80)
    // A $540 dispute: the unspent $80, the $400 set aside, then the $60 water spend.
    await disputeOpened(540)
    const claw = await tx(c => clawBackRemittanceCredit(c, funding, null, { maxAmount: 540 }))
    expect(claw).toMatchObject({ heldClaimed: 400, clawed: 540, drainPending: 140 })
    expect(claw.reversed.map(x => [x.paymentId, x.amount])).toEqual([[water, 60]])
    // The handler's records: the water row loses the $60 spend (reopens); October loses nothing.
    const rev = await rowRecord(water, 60)
    await db.query(`INSERT INTO payment_reversals (payment_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
                    SELECT p.id, 'card_dispute', 0, 'evt_' || gen_random_uuid(), '{}'::jsonb FROM payments p
                     WHERE p.stripe_payment_intent_id = 'pi_funding' AND p.type = 'rent'`)
    expect((await tx(c => takeBackDisputedCredit(c, ahead, rev))).drained).toBe(140)
    // November's bank payment fails: all $400 it set aside was the dispute's.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [nov])
    expect(await tx(c => releaseHeldForRemittance(c, pay, 'payment_failed'))).toBe(400)
    expect(await drainsOf(ahead)).toEqual([[140, 'applied'], [400, 'applied']])
    expect(await remainingPaidAhead(ahead)).toBe(0)
    expect((await usable(h)).usableCredit).toBe(0)
  })

  it('choice46c triage: takeBackCreditAgainstRecord takes a credit back against a record once per call, never more than it holds, and nothing off a withdrawn credit', async () => {
    const h = await house()
    const { ahead } = await surplusOnly(h)
    const holder = await charge(h, { amount: 1, status: 'returned', intent: 'pi_surplus' })
    const rec = await rowRecord(holder, 0)
    expect(await tx(c => takeBackCreditAgainstRecord(c, ahead, rec, 15000))).toBe(15000)
    expect(await tx(c => takeBackCreditAgainstRecord(c, ahead, rec, 999900))).toBe(25000)
    expect(await remainingPaidAhead(ahead)).toBe(0)
    expect(await drainsOf(ahead)).toEqual([[150, 'applied'], [250, 'applied']])
    const other = await paidAhead(await house(), 50, 'gam')
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'test' WHERE id = $1`, [other])
    expect(await tx(c => takeBackCreditAgainstRecord(c, other, rec, 100))).toBe(0)
  })

  it('choice46c (decisions #51): a whole dispute of a no-row charge reports clawed truthfully — money a move-out pool took is not counted, and GAM is told the rest', async () => {
    const h = await house()
    const { ahead } = await surplusOnly(h)
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
       VALUES ($1,$2,$3,0,0,'sent_zero') RETURNING id`, [h.leaseId, h.tenantId, h.landlordId])).rows[0].id
    await db.query(`INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
                    VALUES ($1,$2,$3,100,'2026-10-01','move_out','applied',now())`, [ahead, dr, h.leaseId])
    const r = await tx(c => clawBackDisputedCharge(c, { paymentIntentId: 'pi_surplus', reversalId: null }))
    expect(r).toMatchObject({ withdrawn: true, clawed: 300 })
    const told = (await db.query<any>(`SELECT title, body, context FROM admin_notifications WHERE category = 'disputed_credit_short'`)).rows
    expect(told).toHaveLength(1)
    expect(told[0].context.short).toBe(100)
    expect(told[0].body).toMatch(/^A card payment that paid no bill was disputed in full/)
  })
})

// ─── The contract guards (C0) ─────────────────────────────────────────────────

describe('every credit write goes through the ledger', () => {
  it('the whole path passes with the C0 guards on (direct balance writes refused)', async () => {
    const h = await house()
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'contract', '20261003109000_credit_ledger_guards.sql'), 'utf8')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query(sql)
      const general = await createIssuedCredit(c, { landlordId: h.landlordId, tenantId: h.tenantId, leaseId: null, amount: 30, category: 'goodwill', createdBy: h.userId })
      await createPaidAhead(c, { leaseId: h.leaseId, tenantId: h.tenantId, amount: 440, fundedBy: 'gam', receivedAt: new Date() })
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-10-01','RENT')`, [h.unitId, h.leaseId, h.tenantId, h.landlordId])
      const r = await settleWholeBillIfCovered(c, { tenantId: h.tenantId, landlordId: h.landlordId, receipt: false })
      expect(r.settledIds).toHaveLength(1)
      expect((await c.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [general])).rows[0].r).toBe('10.00')
      // Anything else is refused.
      await c.query('SAVEPOINT direct')
      await expect(c.query(`UPDATE tenant_credits SET amount_remaining = 0 WHERE id = $1`, [general])).rejects.toThrow(/only through credit_uses/)
      await c.query('ROLLBACK TO SAVEPOINT direct')
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })
})

// ─── Choice46d: decisions #48.7 — a bill a dispute reopened, paid with the credit that dispute gave back ──

describe('decisions #48.7: a bill a dispute reopened may be paid with the credit that same dispute gave back', () => {
  it('buildCreditPlan: only that paid-ahead credit pays the reopened bill, and only up to what the dispute gave back of it; every other credit is still refused there', () => {
    const row = (id: string, amount: number, extra: Partial<QuoteRow> = {}): QuoteRow => ({
      id, leaseId: 'L', scopeLeaseId: 'L', invoiceId: null, landlordId: 'X', tenantId: 'T', type: 'rent',
      entryDescription: 'RENT', revenueOwner: 'landlord', status: 'pending', amount, dueDate: '2026-10-01',
      createdAt: '2026-09-01T00:00:00.000Z', billingMonth: '2026-10-01', stripePaymentIntentId: null,
      nextRetryAt: null, payable: true, inFlight: false, required: true, bankPayable: true, creditEligible: true,
      carried: false, gamOwned: false, neighbor: false, retryScheduled: false, heldOnRow: 0, appliedOnRow: 0,
      pastStayEnd: false, ...extra,
    })
    const credit = (id: string, kind: 'paid_ahead' | 'issued', amt: number, leaseId: string | null, createdAt: string) => ({
      kind, id, leaseId, tenantId: 'T', amountRemaining: amt, releasable: 0, disputed: 0, createdAt,
      fundedBy: null, gamHeld: false, category: null,
    })
    const plan = buildCreditPlan({
      rows: [row('reopened', 60, { disputeCredits: [{ creditId: 'P', cap: 50 }] }), row('b', 30, { dueDate: '2026-10-02' })],
      credits: [
        credit('R', 'paid_ahead', 300, 'L', '2026-07-01T00:00:00.000Z'),
        credit('P', 'paid_ahead', 200, 'L', '2026-08-01T00:00:00.000Z'),
        credit('Q', 'issued', 500, null, '2026-06-01T00:00:00.000Z'),
      ],
      caps: new Map([['L', null]]), drawn: new Map(), tenantId: 'T', tenantOnLease: new Set(['L']), includeReleasable: true,
    })
    expect(plan.map(l => [l.creditId, l.paymentId, l.amount])).toEqual([['R', 'b', 30], ['P', 'reopened', 50]])
  })

  /**
   * A $60 water bill paid with $60 of GAM-held paid-ahead money P; the card
   * payment that brought P in was disputed, the spend was undone and the bill
   * reopened for $60, and P still has the money ($200). `recovered`: the
   * landlord was already charged back for the original.
   */
  async function reopenedByDispute(recovered: boolean) {
    const h = await house()
    const p = await paidAhead(h, 200, 'gam')
    const orig = await charge(h, { amount: 60, type: 'utility', due: '2026-09-01' })
    const q0 = await quote(h)
    await tx(c => applyCredit(c, planCredit(q0, h.leaseId).filter(l => l.paymentId === orig), { source: 'whole_bill' }))
    await db.query(`UPDATE payments SET status = 'returned', settled_at = now() WHERE id = $1`, [orig])
    await db.query(`UPDATE credit_uses SET status = 'reversed', released_at = now(), release_reason = 'funding_reversed' WHERE payment_id = $1`, [orig])
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event,
                                      recovery_status, recovered_amount)
       VALUES ($1,$2,$3,$4,'card_dispute',60,'evt_' || gen_random_uuid(),'{}'::jsonb,$5,$6) RETURNING id`,
      [orig, h.landlordId, h.tenantId, h.leaseId, recovered ? 'recovered' : 'pending', recovered ? 60 : 0])).rows[0].id
    const reopened = await charge(h, { amount: 60, type: 'utility', due: '2026-09-01', reversalId: rev })
    return { h, p, orig, rev, reopened }
  }

  it('the quote offers it, the whole-bill rule settles the reopened bill from it, and the reversal resolves (the tenant paid)', async () => {
    const { h, p, rev, reopened } = await reopenedByDispute(false)
    const q = await quote(h)
    expect(q.plan.map(l => [l.creditId, l.paymentId, l.amount])).toEqual([[p, reopened, 60]])
    expect(q.leases[0].coversWholeBill).toBe(true)
    const r = await wholeBill(h)
    expect(r?.settledIds).toEqual([reopened])
    expect(await statusOf(reopened)).toBe('settled')
    const pr = (await db.query<any>(`SELECT outcome, status FROM payment_reversals WHERE id = $1`, [rev])).rows[0]
    expect(pr).toEqual({ outcome: 'tenant_paid', status: 'resolved' })
    expect(await remainingPaidAhead(p)).toBe(140)
  })

  it('the landlord is paid for the bill exactly once: not charged back yet → GAM keeps the re-payment (no second owner share); already charged back → it is paid to them again', async () => {
    const a = await reopenedByDispute(false)
    await wholeBill(a.h)
    expect(await ownerShare(a.reopened)).toBeNull()
    await cleanupAllSchema()
    const b = await reopenedByDispute(true)
    await wholeBill(b.h)
    expect(await ownerShare(b.reopened)).toBe(60)
  })

  it('a reopened bill takes no other credit: a landlord-issued credit never pays it', async () => {
    const { h, p, reopened } = await reopenedByDispute(false)
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'test' WHERE id = $1`, [p])
    await issued(h, 500)
    const q = await quote(h)
    expect(q.plan.find(l => l.paymentId === reopened)).toBeUndefined()
    expect(q.leases[0].coversWholeBill).toBe(false)
  })
})
