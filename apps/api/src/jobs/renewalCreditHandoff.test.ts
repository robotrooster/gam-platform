/**
 * S655 money plan Step 7 — the renewal hand-off moves credit that a payment
 * still in flight has set aside.
 *
 * At the hand-off the household's open money goes with them to the renewal
 * (scheduler.handOffOpenItemsToRenewal). It used to move a credit only when it
 * had money left on it. A credit a clearing bank payment had fully set aside
 * reads $0 left, so it stayed on the expired lease — and when that payment
 * then failed, the credit came back on a lease no bill would ever reach.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { handOffOpenItemsToRenewal } from './scheduler'
import {
  createIssuedCredit, createPaidAhead, holdCredit, applyCredit, applyHeldForRemittance, releaseHeldForRemittance,
  runWholeBillCheckAfterCommit, voidPaidAhead, householdQuote, planCredit, supersedeScheduledRetry,
} from '../services/creditUse'
import { deskQuote, settleManualRentPayment } from '../services/manualPaymentSettle'
import { planLeaseCharge, quoteLeaseCharge, chargeLeaseBalance } from '../services/rentCharge'
import { lockHousehold } from '../services/moneyPredicates'
import * as stripeConnect from '../services/stripeConnect'

// The portal charge reaches Stripe through this one call.
let piSeq = 0
vi.mock('../services/stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createRentPlatformCharge: vi.fn(async () => ({ id: `pi_renewal_test_${++piSeq}`, status: 'processing' })),
  }
})

// A charge that replaces a scheduled retry cancels that retry's intent after commit.
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ paymentIntents: { cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) } }),
}))

interface Fx { userId: string; landlordId: string; unitId: string; tenantId: string; oldLeaseId: string; renewalId: string }

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

async function fixture(): Promise<Fx> {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const oldLeaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460, startDate: '2025-10-01' })
    await c.query(`UPDATE leases SET end_date = '2026-09-30' WHERE id = $1`, [oldLeaseId])
    await seedLeaseTenant(c, { leaseId: oldLeaseId, tenantId, role: 'primary' })
    const renewalId = await seedLease(c, { unitId, landlordId, rentAmount: 480, status: 'pending', startDate: '2026-10-01' })
    await c.query(`UPDATE leases SET supersedes_lease_id = $2, signed_by_landlord = TRUE WHERE id = $1`, [renewalId, oldLeaseId])
    await seedLeaseTenant(c, { leaseId: renewalId, tenantId, role: 'primary' })
    return { userId, landlordId, unitId, tenantId, oldLeaseId, renewalId }
  })
}

async function charge(f: Fx, o: { leaseId: string; amount: number; status?: string; intent?: string | null; due?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,'rent',$5,$6,$7,'RENT',$8) RETURNING id`,
    [f.unitId, o.leaseId, f.tenantId, f.landlordId, o.amount.toFixed(2), o.status ?? 'pending', o.due ?? '2026-09-01', o.intent ?? null])
  return r.rows[0].id
}

async function clearingRemittance(f: Fx, intent: string, amount: number): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                     status, payment_method, stripe_payment_intent_id, processing_fee_amount)
     VALUES ($1,$2,$3,$4,$4,0,'processing','ach',$5,0) RETURNING id`,
    [f.tenantId, f.oldLeaseId, f.landlordId, amount.toFixed(2), intent])).rows[0].id
}

const leaseOf = async (table: 'tenant_credits' | 'lease_prepaid_credits', id: string) =>
  (await db.query<{ lease_id: string; r: string }>(`SELECT lease_id, amount_remaining::text AS r FROM ${table} WHERE id = $1`, [id])).rows[0]

beforeEach(async () => { await cleanupAllSchema() })

describe('renewal hand-off and credit set aside by a payment in flight', () => {
  /**
   * September's $460 rent is being paid by bank: $50 of a move-in special and
   * $410 of money paid ahead are set aside on it while the payment clears.
   * Both credits read $0 left.
   */
  async function inFlight(f: Fx) {
    const special = await tx(c => createIssuedCredit(c, {
      landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.oldLeaseId, amount: 50, category: 'goodwill', reason: 'move-in special', createdBy: f.userId }))
    const ahead = await tx(c => createPaidAhead(c, {
      leaseId: f.oldLeaseId, tenantId: f.tenantId, amount: 410, fundedBy: 'landlord', receivedAt: '2026-08-20T12:00:00Z' }))
    const rent = await charge(f, { leaseId: f.oldLeaseId, amount: 460, status: 'processing', intent: 'pi_sept' })
    const rem = await clearingRemittance(f, 'pi_sept', 1)
    await tx(c => holdCredit(c, [
      { creditKind: 'issued', creditId: special, paymentId: rent, leaseId: f.oldLeaseId, amount: 50, billingMonth: '2026-09-01' },
      { creditKind: 'paid_ahead', creditId: ahead, paymentId: rent, leaseId: f.oldLeaseId, amount: 410, billingMonth: '2026-09-01' },
    ], { remittanceId: rem, source: 'portal' }))
    return { special, ahead, rent, rem }
  }

  it('a credit fully held by an in-flight charge moves to the renewal', async () => {
    const f = await fixture()
    const x = await inFlight(f)
    expect(Number((await leaseOf('tenant_credits', x.special)).r)).toBe(0)

    const moved = await handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId)

    expect(moved.credits).toBe(1)
    expect(moved.paidAhead).toBe(1)
    expect((await leaseOf('tenant_credits', x.special)).lease_id).toBe(f.renewalId)
    expect((await leaseOf('lease_prepaid_credits', x.ahead)).lease_id).toBe(f.renewalId)
    // The uses are records of what happened on the old lease: unchanged.
    const uses = await db.query<{ lease_id: string; status: string }>(`SELECT lease_id, status FROM credit_uses ORDER BY amount`)
    expect(uses.rows).toEqual([
      { lease_id: f.oldLeaseId, status: 'held' },
      { lease_id: f.oldLeaseId, status: 'held' },
    ])
  })

  it('if that charge fails, the credit is released on the renewal', async () => {
    const f = await fixture()
    const x = await inFlight(f)
    await handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId)

    // The bank turns the payment down for good: everything it set aside comes back.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [x.rent])
    await tx(c => releaseHeldForRemittance(c, x.rem, 'payment_failed'))

    const special = await leaseOf('tenant_credits', x.special)
    const ahead = await leaseOf('lease_prepaid_credits', x.ahead)
    expect(special).toEqual({ lease_id: f.renewalId, r: '50.00' })
    expect(ahead).toEqual({ lease_id: f.renewalId, r: '410.00' })

    // ...and it is usable on the lease they are on: October's $460 bill on the
    // renewal is covered in full by the $460 that came back, and pays itself.
    await db.query(`UPDATE leases SET status = 'active' WHERE id = $1`, [f.renewalId])
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [f.oldLeaseId])
    const october = await charge(f, { leaseId: f.renewalId, amount: 460, due: '2026-10-01' })
    await runWholeBillCheckAfterCommit({ tenantId: f.tenantId, landlordId: f.landlordId, onlyLeaseIds: [f.renewalId] })
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [october])).rows[0].status).toBe('settled')
  })

  it('money already spent stays with the old lease as its history; a withdrawn credit stays put', async () => {
    const f = await fixture()
    const spent = await tx(c => createIssuedCredit(c, {
      landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.oldLeaseId, amount: 30, category: 'goodwill', reason: 'spent', createdBy: f.userId }))
    const row = await charge(f, { leaseId: f.oldLeaseId, amount: 30 })
    await tx(async c => {
      await applyCredit(c, [{ creditKind: 'issued', creditId: spent, paymentId: row, leaseId: f.oldLeaseId, amount: 30, billingMonth: '2026-09-01' }],
        { source: 'desk', createdBy: f.userId })
      await c.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [row])
    })
    const withdrawn = await tx(c => createPaidAhead(c, {
      leaseId: f.oldLeaseId, tenantId: f.tenantId, amount: 15, fundedBy: 'landlord', receivedAt: '2026-08-20T12:00:00Z' }))
    await tx(c => voidPaidAhead(c, withdrawn, 'bank deposit undone'))
    const leftOver = await tx(c => createPaidAhead(c, {
      leaseId: f.oldLeaseId, tenantId: f.tenantId, amount: 20, fundedBy: 'landlord', receivedAt: '2026-08-20T12:00:00Z' }))

    await handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId)

    expect((await leaseOf('tenant_credits', spent)).lease_id).toBe(f.oldLeaseId)
    expect((await leaseOf('lease_prepaid_credits', withdrawn)).lease_id).toBe(f.oldLeaseId)
    expect((await leaseOf('lease_prepaid_credits', leftOver)).lease_id).toBe(f.renewalId)
  })

  it('the hand-off waits for another writer holding the household', async () => {
    const f = await fixture()
    const holder = await db.connect()
    let done = false
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, f.tenantId, f.landlordId)
      // The other writer gives a credit on the old lease while it holds the household.
      await createIssuedCredit(holder, {
        landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.oldLeaseId, amount: 25, category: 'goodwill', reason: 'late', createdBy: f.userId })
      const handing = handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId).then(r => { done = true; return r })
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        // pg_locks is server-wide: only a wait in this test's own database counts.
        const w = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        waiting = Number(w.rows[0].n) > 0
        if (!waiting) await new Promise(r => setTimeout(r, 50))
      }
      expect(waiting).toBe(true)
      expect(done).toBe(false)
      await holder.query('COMMIT')
      // It moves the credit the other writer committed while it waited.
      expect((await handing).credits).toBe(1)
    } finally { holder.release() }
  })

  /**
   * After the hand-off a $50 move-in special sits on the renewal, but the old
   * lease's September bank payment bounced and its scheduled retry still holds
   * that $50. October's $480 rent is open on the renewal. With `amount` above
   * $50 the special has the rest free on it (an $80 special: $30 free).
   */
  async function movedCreditHeldByOldRetry(f: Fx, o: { amount?: number } = {}) {
    const special = await tx(c => createIssuedCredit(c, {
      landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.oldLeaseId, amount: o.amount ?? 50, category: 'goodwill', reason: 'move-in special', createdBy: f.userId }))
    const sept = await charge(f, { leaseId: f.oldLeaseId, amount: 460, status: 'processing', intent: 'pi_sept_retry' })
    const rem = await clearingRemittance(f, 'pi_sept_retry', 410)
    await tx(c => holdCredit(c, [
      { creditKind: 'issued', creditId: special, paymentId: sept, leaseId: f.oldLeaseId, amount: 50, billingMonth: '2026-09-01' },
    ], { remittanceId: rem, source: 'portal' }))
    await handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId)
    expect((await leaseOf('tenant_credits', special)).lease_id).toBe(f.renewalId)

    // The bank bounces it and a retry is scheduled: the $50 stays set aside on September's row.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = $1`, [sept])
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [f.oldLeaseId])
    await db.query(`UPDATE leases SET status = 'active' WHERE id = $1`, [f.renewalId])
    const oct = await charge(f, { leaseId: f.renewalId, amount: 480, due: '2026-10-01' })
    return { special, sept, oct, rem }
  }

  const deskWindow = async (f: Fx) => {
    const c = await db.connect()
    try { return await deskQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId }) } finally { c.release() }
  }
  const deskSettle = (f: Fx, oct: string, o: { amountTendered: number; creditToUse: number }) =>
    tx(c => settleManualRentPayment(c, {
      payment: { id: oct, landlord_id: f.landlordId, tenant_id: f.tenantId, unit_id: f.unitId, lease_id: f.renewalId, due_date: '2026-10-01' },
      method: 'check', settledAt: null, settleHousehold: true, sendReceipt: false,
      amountTendered: o.amountTendered, creditToUse: o.creditToUse,
    }))
  const statuses = async (ids: string[]) =>
    new Map((await db.query<{ id: string; status: string }>(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [ids])).rows.map(r => [r.id, r.status]))
  const heldUses = async (creditId: string) =>
    Number((await db.query<{ n: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS n FROM credit_uses WHERE tenant_credit_id = $1 AND status = 'held'`, [creditId])).rows[0].n)

  // The household figure counts the $50 wherever its hold sits: paying the
  // household (the desk, "Pay all" with the retrying bill first) replaces the
  // old lease's retry and gives it back, so the figure the payer is shown is
  // the same before and after that replacing.
  it('while the old lease\'s bank retry still holds a moved credit, the household still counts it as the renewal\'s', async () => {
    const f = await fixture()
    await movedCreditHeldByOldRetry(f)
    await tx(async c => {
      await lockHousehold(c, f.tenantId, f.landlordId)
      const quote = await householdQuote(c, { tenantId: f.tenantId, landlordId: f.landlordId, lock: true })
      expect(quote.leases.find(l => l.leaseId === f.renewalId)!.usableCredit).toBe(50)
      expect(planCredit(quote, f.oldLeaseId)).toEqual([])
      // Paying September now (which replaces the retry) frees it.
      expect(quote.leases.find(l => l.leaseId === f.oldLeaseId)!.heldReleasable).toBe(50)
      // The household's credit on file still shows the moved money.
      expect(quote.totals.creditOnFile).toBe(50)
    })
  })

  // 10/4 (was "a charge on the renewal alone does not spend credit the old
  // lease's retry still holds", which then refused the charge with a 409):
  // the free credit is used, the rest is charged, the held part waits.
  it('a charge on the renewal alone uses only the free credit; what the old lease\'s retry holds is shown as waiting', async () => {
    const f = await fixture()
    await movedCreditHeldByOldRetry(f)
    await tx(async c => {
      await lockHousehold(c, f.tenantId, f.landlordId)
      const plan = await planLeaseCharge(c, { tenantId: f.tenantId, scope: { kind: 'lease', leaseId: f.renewalId }, lock: true })
      // Paying October alone does not replace September's retry: the $50 is
      // left where it is, never spent below zero, and said in plain words.
      expect(plan.usableCredit).toBe(0)
      expect(plan.creditPlan).toEqual([])
      expect(plan.coversWholeBill).toBe(false)
      expect(plan.creditStillHeldElsewhere).toBe(50)
      expect(plan.creditWaitingNote).toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
      // Paying the old lease first (which replaces its retry) is what frees it.
      expect(plan.creditWaitingHeldBy).toEqual([f.oldLeaseId])
    })
  })

  // 10/4 (was "the renewal's credit figure is the same before and after paying
  // the old bill replaces its retry"): the figure is the credit free right now.
  it('the renewal\'s credit figure is the free credit: $0 while the old lease\'s retry holds the $50, $50 once paying the old bill replaces that retry ("Pay all", old bill first)', async () => {
    const f = await fixture()
    const { special, sept } = await movedCreditHeldByOldRetry(f)
    // One transaction, as a payment would run it, rolled back at the end.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await lockHousehold(c, f.tenantId, f.landlordId)
      const before = await planLeaseCharge(c, { tenantId: f.tenantId, scope: { kind: 'lease', leaseId: f.renewalId }, lock: true })
      // Paying September first replaces its retry and gives the $50 back.
      await supersedeScheduledRetry(c, [sept])
      const after = await planLeaseCharge(c, { tenantId: f.tenantId, scope: { kind: 'lease', leaseId: f.renewalId }, lock: true })
      expect(before.usableCredit).toBe(0)
      expect(before.creditStillHeldElsewhere).toBe(50)
      // Once September's retry is replaced, the $50 is free and the renewal's.
      expect(after.usableCredit).toBe(50)
      expect(after.creditStillHeldElsewhere).toBe(0)
      expect(after.creditWaitingNote).toBeNull()
      expect(after.creditWaitingHeldBy).toEqual([])
      expect(after.creditPlan.map(l => [l.creditId, l.amount])).toEqual([[special, 50]])
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })

  // Fix pass 4 (decisions.md #46 1b; was "a general credit the older retrying
  // bill takes is not also offered on the renewal", which set the general
  // credit aside for September even though September's retry pulls a fixed
  // amount and never uses credit — so autopay pulled October in full while
  // that credit sat unused). A bill whose payment is already on its way gets
  // no credit set aside: free credit goes to the bill being charged now.
  // "Pay all" plays the run through, so it never offers the same dollars twice.
  it('a bill whose bank retry is already scheduled gets no credit set aside: the renewal charged alone gets the free general credit, and Pay all never offers the same dollars twice', async () => {
    const f = await fixture()
    await movedCreditHeldByOldRetry(f)
    // $100 of general credit (no lease): any of the tenant's bills.
    const general = await tx(c => createIssuedCredit(c, {
      landlordId: f.landlordId, tenantId: f.tenantId, leaseId: null, amount: 100, category: 'goodwill', reason: 'general', createdBy: f.userId }))
    const old = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.oldLeaseId, useCredit: true, paymentMethodType: 'ach' })
    const renewal = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
    expect(old.creditOnFile).toBe(150)
    // Paying September now replaces its retry: it is the bill being charged, and the oldest.
    expect(old.usableCredit).toBe(100)
    expect(old.creditStillHeldElsewhere).toBe(0)
    // October charged alone (autopay, its own Pay button): September's retry
    // never uses credit, so the free $100 pays October. The special's $50 is
    // still waiting on September's retry, and the tenant is told so.
    expect(renewal.usableCredit).toBe(100)
    expect(renewal.creditPlan.map(l => [l.creditId, l.amount])).toEqual([[general, 100]])
    expect(renewal.landing.dueCents).toBe(38000)
    expect(renewal.creditStillHeldElsewhere).toBe(50)
    expect(renewal.creditWaitingNote).toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')
    expect(renewal.creditWaitingHeldBy).toEqual([f.oldLeaseId])

    // "Pay all": September first (it takes the $100; replacing its retry
    // frees the special's $50), then October with what is left — every dollar
    // offered once, nothing waiting.
    const after = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach', afterLeaseIds: [f.oldLeaseId] })
    expect(after.usableCredit).toBe(50)
    expect(after.creditStillHeldElsewhere).toBe(0)
    expect(after.creditWaitingNote).toBeNull()
    expect(old.usableCredit + after.usableCredit).toBe(old.creditOnFile)
  })

  it('a charge on the renewal alone spends the free general credit and leaves the old bill\'s retry and its hold as they were', async () => {
    const f = await fixture()
    await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_renewal' WHERE id = $1`, [f.tenantId])
    const { special, sept } = await movedCreditHeldByOldRetry(f)
    const general = await tx(c => createIssuedCredit(c, {
      landlordId: f.landlordId, tenantId: f.tenantId, leaseId: null, amount: 100, category: 'goodwill', reason: 'general', createdBy: f.userId }))
    const res = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.renewalId, amount: 380,
      paymentMethodId: 'pm_bank', paymentMethodType: 'ach', source: 'autopay',
      credit: { use: true, expected: 100 },
    })
    expect(res.status).toBe('processing')
    expect(res.creditUsed).toBe(100)
    expect(Number((await leaseOf('tenant_credits', general)).r)).toBe(0)
    expect(await heldUses(special)).toBe(50)
    const retry = (await db.query<{ status: string; retry: boolean }>(
      `SELECT status, next_retry_at IS NOT NULL AS retry FROM payments WHERE id = $1`, [sept])).rows[0]
    expect(retry).toEqual({ status: 'failed', retry: true })
  })

  // Fix pass 4: a paid-ahead credit a dispute still claims part of, with one
  // hold from this lease's own retry and one from the old lease's retry. The
  // claim comes off the free money first — after this charge replaces its own
  // retry, that includes what the retry gave back — so the quote counts only
  // what is left of the own retry's part. The quote used to say $50 here and
  // the charge found $30 ("Your credit changed", and a failed autopay month).
  it('a disputed paid-ahead credit held by both bills\' retries: the quote and the charge agree on what is free', async () => {
    const f = await fixture()
    await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_renewal' WHERE id = $1`, [f.tenantId])
    // $200 paid ahead by card on the old lease.
    const fund = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, gross_amount, processing_fee_amount)
       VALUES ($1,$2,$3,200,0,200,'settled','card','pi_fund_ahead',200,0) RETURNING id`,
      [f.tenantId, f.oldLeaseId, f.landlordId])).rows[0].id
    const ahead = await tx(c => createPaidAhead(c, {
      leaseId: f.oldLeaseId, tenantId: f.tenantId, amount: 200, fundedBy: 'gam', receivedAt: '2026-08-20T12:00:00Z', sourceRemittanceId: fund }))
    // September's bank payment set $50 of it aside.
    const sept = await charge(f, { leaseId: f.oldLeaseId, amount: 460, status: 'processing', intent: 'pi_sept_retry' })
    const septRem = await clearingRemittance(f, 'pi_sept_retry', 410)
    await tx(c => holdCredit(c, [
      { creditKind: 'paid_ahead', creditId: ahead, paymentId: sept, leaseId: f.oldLeaseId, amount: 50, billingMonth: '2026-09-01' },
    ], { remittanceId: septRem, source: 'portal' }))
    await handOffOpenItemsToRenewal(f.oldLeaseId, f.renewalId)
    expect((await leaseOf('lease_prepaid_credits', ahead)).lease_id).toBe(f.renewalId)
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [f.oldLeaseId])
    await db.query(`UPDATE leases SET status = 'active' WHERE id = $1`, [f.renewalId])
    // October's bank payment set another $50 aside on the renewal.
    const oct = await charge(f, { leaseId: f.renewalId, amount: 480, status: 'processing', intent: 'pi_oct_retry', due: '2026-10-01' })
    const octRem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,430,430,0,'processing','ach','pi_oct_retry',0) RETURNING id`,
      [f.tenantId, f.renewalId, f.landlordId])).rows[0].id
    await tx(c => holdCredit(c, [
      { creditKind: 'paid_ahead', creditId: ahead, paymentId: oct, leaseId: f.renewalId, amount: 50, billingMonth: '2026-10-01' },
    ], { remittanceId: octRem, source: 'portal' }))
    // Both bounce; both retries are scheduled, each still holding its $50.
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = ANY($1::uuid[])`, [[sept, oct]])
    expect(Number((await leaseOf('lease_prepaid_credits', ahead)).r)).toBe(100)
    // A card dispute on the $200 still claims $120 of it.
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
       VALUES ('dp_ahead', 'ch_ahead', 'pi_fund_ahead', $1, 120, 'needs_response')`, [f.landlordId])

    // Free for October's own charge: $100 left + $50 its retry gives back − $120 claimed = $30.
    const quote = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
    expect(quote.usableCredit).toBe(30)
    expect(quote.landing.dueCents).toBe(45000)
    const res = await chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.renewalId, amount: 450,
      paymentMethodId: 'pm_bank', paymentMethodType: 'ach', source: 'autopay',
      credit: { use: true, expected: quote.usableCredit },
    })
    expect(res.status).toBe('processing')
    expect(res.creditUsed).toBe(30)
    // September's retry keeps its $50.
    const septHeld = (await db.query<{ n: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS n FROM credit_uses WHERE prepaid_credit_id = $1 AND payment_id = $2 AND status = 'held'`, [ahead, sept])).rows[0].n
    expect(Number(septHeld)).toBe(50)
  })

  // Fix pass 3: the waiting sentence must be true whichever way the earlier
  // payment ends. It used to say the credit "will be ready when it clears" —
  // but when it clears, the held credit is SPENT on the earlier bill.
  it('when the old lease\'s retry clears, the credit it held pays September and never becomes free for the renewal', async () => {
    const f = await fixture()
    const { special, sept, rem } = await movedCreditHeldByOldRetry(f)
    const plan = (c: PoolClient) => planLeaseCharge(c, { tenantId: f.tenantId, scope: { kind: 'lease', leaseId: f.renewalId } })
    const before = await tx(plan)
    expect(before.creditStillHeldElsewhere).toBe(50)

    // The retry clears: the webhook spends what it set aside.
    await db.query(`UPDATE payments SET status = 'settled', next_retry_at = NULL WHERE id = $1`, [sept])
    expect(await tx(c => applyHeldForRemittance(c, rem))).toBe(50)

    const applied = (await db.query<{ payment_id: string; amount: string; status: string }>(
      `SELECT payment_id, amount::text AS amount, status FROM credit_uses WHERE tenant_credit_id = $1`, [special])).rows
    expect(applied).toEqual([{ payment_id: sept, amount: '50.00', status: 'applied' }])
    expect(Number((await leaseOf('tenant_credits', special)).r)).toBe(0)
    const after = await tx(plan)
    expect(after.usableCredit).toBe(0)
    expect(after.creditOnFile).toBe(0)
    expect(after.creditStillHeldElsewhere).toBe(0)
    expect(after.creditWaitingNote).toBeNull()
  })

  it('when the old lease\'s retry finally fails, the credit it held comes back to the account and the renewal may use it', async () => {
    const f = await fixture()
    const { special, sept, rem } = await movedCreditHeldByOldRetry(f)
    await db.query(`UPDATE payments SET next_retry_at = NULL WHERE id = $1`, [sept])
    expect(await tx(c => releaseHeldForRemittance(c, rem, 'payment_failed'))).toBe(50)

    expect(await leaseOf('tenant_credits', special)).toEqual({ lease_id: f.renewalId, r: '50.00' })
    const after = await tx(c => planLeaseCharge(c, { tenantId: f.tenantId, scope: { kind: 'lease', leaseId: f.renewalId } }))
    expect(after.usableCredit).toBe(50)
    expect(after.creditStillHeldElsewhere).toBe(0)
    expect(after.creditWaitingNote).toBeNull()
  })

  it('the desk window and the desk settle agree when a moved credit is held by the old lease\'s retry: Save', async () => {
    const f = await fixture()
    const { special, sept, oct } = await movedCreditHeldByOldRetry(f)
    const win = await deskWindow(f)
    expect(win.usableCredit).toBe(50)
    expect(win.creditOnFile).toBe(50)
    expect(win.owedIfSaved).toBe(940)
    expect(win.owedIfUsed).toBe(890)

    const res = await deskSettle(f, oct, { amountTendered: win.owedIfSaved, creditToUse: 0 })
    expect(new Set(res.settledPaymentIds)).toEqual(new Set([sept, oct]))
    const st = await statuses([sept, oct])
    expect(st.get(sept)).toBe('settled')
    expect(st.get(oct)).toBe('settled')
    // Saved: the whole $50 is back on the renewal, nothing set aside.
    const credit = await leaseOf('tenant_credits', special)
    expect(credit.lease_id).toBe(f.renewalId)
    expect(Number(credit.r)).toBe(50)
    expect(await heldUses(special)).toBe(0)
  })

  it('the desk window and the desk settle agree when a moved credit is held by the old lease\'s retry: Use', async () => {
    const f = await fixture()
    const { special, sept, oct } = await movedCreditHeldByOldRetry(f)
    const win = await deskWindow(f)
    expect(win.usableCredit).toBe(50)

    const res = await deskSettle(f, oct, { amountTendered: win.owedIfUsed, creditToUse: win.usableCredit })
    expect(new Set(res.settledPaymentIds)).toEqual(new Set([sept, oct]))
    const st = await statuses([sept, oct])
    expect(st.get(sept)).toBe('settled')
    expect(st.get(oct)).toBe('settled')
    // Used once, on October: September was paid in full in money.
    expect(Number((await leaseOf('tenant_credits', special)).r)).toBe(0)
    expect(await heldUses(special)).toBe(0)
    const applied = (await db.query<{ payment_id: string; amount: string }>(
      `SELECT payment_id, amount::text AS amount FROM credit_uses WHERE tenant_credit_id = $1 AND status = 'applied'`, [special])).rows
    expect(applied).toEqual([{ payment_id: oct, amount: '50.00' }])
  })

  describe('the portal Pay Now path (10/4)', () => {
    beforeAll(async () => {
      await db.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
         SELECT 'ach', 6, 0, 0, 0.5
          WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
    })
    beforeEach(() => { (stripeConnect.createRentPlatformCharge as any).mockClear() })

    const heldOn = async (creditId: string) =>
      (await db.query<{ payment_id: string; amount: string }>(
        `SELECT payment_id, amount::text AS amount FROM credit_uses
          WHERE tenant_credit_id = $1 AND status = 'held' ORDER BY amount`, [creditId])).rows
    const retryOf = async (id: string) =>
      (await db.query<{ status: string; retry: boolean }>(
        `SELECT status, next_retry_at IS NOT NULL AS retry FROM payments WHERE id = $1`, [id])).rows[0]

    it('Pay Now with "Use all" on a renewal whose moved credit the old lease\'s retry holds charges the rest of the bill and leaves the held part alone', async () => {
      const f = await fixture()
      await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_renewal' WHERE id = $1`, [f.tenantId])
      // An $80 special: $50 held by September's retry, $30 free.
      const { special, sept, oct } = await movedCreditHeldByOldRetry(f, { amount: 80 })

      // What the pay screen is shown.
      const quote = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
      expect(quote.usableCredit).toBe(30)
      expect(quote.landing.dueCents).toBe(45000)
      expect(quote.creditStillHeldElsewhere).toBe(50)
      expect(quote.creditWaitingNote).toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.')

      // The charge, answered against that figure: no refusal.
      const res = await chargeLeaseBalance({
        tenantId: f.tenantId, leaseId: f.renewalId, amount: 450,
        paymentMethodId: 'pm_bank', paymentMethodType: 'ach', source: 'portal',
        credit: { use: true, expected: quote.usableCredit },
      })
      expect(res.status).toBe('processing')
      expect(res.creditUsed).toBe(30)
      expect(res.creditWaitingNote).toBe(quote.creditWaitingNote)
      expect((stripeConnect.createRentPlatformCharge as any).mock.calls).toHaveLength(1)
      const rem = (await db.query<{ amount: string }>(`SELECT amount::text AS amount FROM tenant_remittances WHERE id = $1`, [res.remittanceId])).rows[0]
      expect(rem.amount).toBe('450.00')

      // The free $30 is set aside on October; September's retry keeps its $50.
      expect(await heldOn(special)).toEqual([{ payment_id: oct, amount: '30.00' }, { payment_id: sept, amount: '50.00' }])
      expect(await retryOf(sept)).toEqual({ status: 'failed', retry: true })
      expect((await retryOf(oct)).status).toBe('processing')
      expect(Number((await leaseOf('tenant_credits', special)).r)).toBe(0)
    })

    it('Pay Now on that renewal with all its credit held by the old retry charges the whole bill — no credit question, no refusal', async () => {
      const f = await fixture()
      await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_renewal' WHERE id = $1`, [f.tenantId])
      const { special, sept } = await movedCreditHeldByOldRetry(f)
      const quote = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
      expect(quote.usableCredit).toBe(0)
      expect(quote.landing.dueCents).toBe(48000)
      const res = await chargeLeaseBalance({
        tenantId: f.tenantId, leaseId: f.renewalId, amount: 480,
        paymentMethodId: 'pm_bank', paymentMethodType: 'ach', source: 'portal',
        credit: { use: true, expected: 0 },
      })
      expect(res.status).toBe('processing')
      expect(res.creditUsed).toBe(0)
      expect(await heldOn(special)).toEqual([{ payment_id: sept, amount: '50.00' }])
    })

    // Fix pass 3: the review's example — $100 on file: $30 can pay October,
    // $50 is held by September's retry, and the other $20 (a credit tied to
    // the old lease, whose only bill is the retrying one) used to go unsaid.
    it('every dollar on file is explained on one bill: $30 pays it, $50 waits on the old retry, $20 is kept for a bill on another lease', async () => {
      const f = await fixture()
      await movedCreditHeldByOldRetry(f, { amount: 80 })
      await tx(c => createIssuedCredit(c, {
        landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.oldLeaseId, amount: 20, category: 'goodwill', reason: 'old lease', createdBy: f.userId }))
      const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
      expect(q.creditOnFile).toBe(100)
      expect(q.usableCredit).toBe(30)
      expect(q.creditStillHeldElsewhere).toBe(50)
      expect(q.creditKeptElsewhere).toBe(20)
      expect(q.creditKeptForLater).toBe(0)
      expect(q.creditAlsoHeld).toBe(0)
      expect(q.creditRestNote).toBe('$20.00 of your credit is kept for a bill on another lease.')
    })

    // A bill the free credit covers in full never needs the held $50, so the
    // waiting figure is $0 — the held part is still said, in the rest.
    it('when free credit covers the bill, credit the old retry holds is still said, beside what is left for a later bill', async () => {
      const f = await fixture()
      await movedCreditHeldByOldRetry(f, { amount: 80 })
      await tx(c => createIssuedCredit(c, {
        landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.renewalId, amount: 500, category: 'goodwill', reason: 'later', createdBy: f.userId }))
      const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
      expect(q.creditOnFile).toBe(580)
      expect(q.usableCredit).toBe(480)
      expect(q.creditStillHeldElsewhere).toBe(0)
      expect(q.creditAlsoHeld).toBe(50)
      expect(q.creditKeptForLater).toBe(50)
      expect(q.creditRestNote).toBe('$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account. $50.00 of your credit stays on your account for a later bill.')
    })

    it('when the free credit covers the renewal bill it is paid with credit — nothing charged — recorded as the portal\'s, and the old retry keeps its hold', async () => {
      const f = await fixture()
      const { special, sept, oct } = await movedCreditHeldByOldRetry(f, { amount: 80 })
      // A later $500 credit on the renewal: with the $30 free on the special it
      // covers October's $480. The household plan would take the special's
      // held $50 too; the charge must not.
      const later = await tx(c => createIssuedCredit(c, {
        landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.renewalId, amount: 500, category: 'goodwill', reason: 'later', createdBy: f.userId }))
      const quote = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.renewalId, useCredit: true, paymentMethodType: 'ach' })
      expect(quote.usableCredit).toBe(480)
      expect(quote.coversWholeBill).toBe(true)
      expect(quote.creditStillHeldElsewhere).toBe(0)
      expect(quote.creditWaitingNote).toBeNull()

      const res = await chargeLeaseBalance({
        tenantId: f.tenantId, leaseId: f.renewalId, amount: 0, source: 'portal',
        credit: { use: true, expected: quote.usableCredit },
      })
      expect(res.paidWithCredit).toBe(true)
      expect(res.creditUsed).toBe(480)
      expect((stripeConnect.createRentPlatformCharge as any).mock.calls).toHaveLength(0)
      expect((await retryOf(oct)).status).toBe('settled')
      expect(await retryOf(sept)).toEqual({ status: 'failed', retry: true })
      expect(await heldOn(special)).toEqual([{ payment_id: sept, amount: '50.00' }])
      expect(Number((await leaseOf('tenant_credits', special)).r)).toBe(0)
      expect(Number((await leaseOf('tenant_credits', later)).r)).toBe(50)
      // Recorded as the payer's own press (the portal), not as the whole-bill rule.
      const sources = (await db.query<{ source: string }>(
        `SELECT DISTINCT source FROM credit_uses WHERE payment_id = $1 AND status = 'applied'`, [oct])).rows.map(r => r.source)
      expect(sources).toEqual(['portal'])
    })
  })
})
