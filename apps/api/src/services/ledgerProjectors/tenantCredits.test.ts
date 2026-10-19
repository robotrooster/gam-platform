/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family C: credits, paid-ahead
 * money and work trade post themselves (gam-ledger-design-2026-10-12 §6
 * C1-C10; §17 "Projectors").
 *
 *   Nic 10/12: paid-ahead money GAM holds is NOT on the landlord's balance
 *   sheet until it pays a bill (L13); work trade covering rent is the
 *   landlord's choice — rent plus a labor cost, or a rent discount (L12).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { db } from '../../db'
import {
  tenantCo, addLease, bill, receipt, paidAhead, issuedCredit, spend, drain, bal, received, activeLines, triples, sourceError,
} from '../../test/ledgerTenantFixtures'
import { cleanupTenantLedger } from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'
import { STAY_SHORTENED_CREDIT_NOTE } from '../bookingLeaseBilling'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})
// 10/12 (Nic, ledger integrate): leave no paid-ahead choice behind — the shared
// cleanupAllSchema the next file runs does not clear them (they name a lease).
afterAll(async () => {
  await cleanupTenantLedger()
})

describe('C1: paid-ahead money pays a bill', () => {
  it('money the landlord holds: Dr 2050 on the lease it arrived on / Cr receivables — not received again; clearing between properties', async () => {
    const co = await tenantCo()
    const { remittanceId, creditId } = await receipt(co, { method: 'cash', settledAt: '2026-09-02T17:00:00Z', apps: [], surplus: 300 })
    // The money is carried to the tenant's lease on property 2 (it keeps where it arrived).
    const second = await addLease(co)
    await db.query(`UPDATE lease_prepaid_credits SET received_lease_id = lease_id, lease_id = $2 WHERE id = $1`, [creditId, second.leaseId])
    const rent = await bill(co, { amount: 300, due: '2026-10-01', unitId: second.unitId, leaseId: second.leaseId })
    const use = await spend(co, { paymentId: rent, prepaidCreditId: creditId!, amount: 300, appliedAt: '2026-10-01T15:00:00Z', leaseId: second.leaseId })
    await drain()
    const lines = await activeLines('credit_use', use)
    expect(triples(lines)).toEqual([['tenant_prepayments', 30000, 0], ['ar_tenants', 0, 30000]])
    expect(lines.find(l => l.role === 'tenant_prepayments')?.propertyId).toBe(co.propertyId)
    expect(lines.find(l => l.role === 'ar_tenants')?.propertyId).toBe(co.propertyId2)
    expect(lines.filter(l => l.system).map(l => [l.role, l.propertyId, l.dr, l.cr])).toEqual([
      ['interproperty_clearing', co.propertyId, 0, 30000], ['interproperty_clearing', co.propertyId2, 30000, 0],
    ].sort((a, b) => (String(a[1]) < String(b[1]) ? -1 : 1)))
    expect(lines.every(l => l.cash === null)).toBe(true)
    expect(await bal(co.landlordId, 'tenant_prepayments')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await received(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)   // counted in September, when it arrived
    expect(await activeLines('remittance', remittanceId)).toHaveLength(2)
  })

  it('money GAM holds (L13): nothing when it arrives; Due from GAM and RECEIVED the day it pays the bill', async () => {
    const co = await tenantCo()
    const sept = await bill(co, { amount: 500, due: '2026-09-01' })
    const { creditId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
      apps: [{ paymentId: sept, amount: 500 }], surplus: 500 })
    const oct = await bill(co, { amount: 500, due: '2026-10-01' })
    const use = await spend(co, { paymentId: oct, prepaidCreditId: creditId!, amount: 500, appliedAt: '2026-10-01T15:00:00Z', source: 'whole_bill' })
    await drain()
    expect(triples(await activeLines('credit_use', use))).toEqual([['due_from_gam', 50000, 0], ['ar_tenants', 0, 50000]])
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30')).toBe(50000)
    expect(await received(co.landlordId, '2026-10-01', '2026-10-31', 'space_rent')).toBe(50000)
    expect(await bal(co.landlordId, 'tenant_prepayments')).toBe(0)
  })
})

describe('C2 / C3 / C4: credits spent on a bill', () => {
  it('a credit the landlord gave is a minus line (4095); a late-fee refund credit comes off late fees; deposit interest is GAM\'s money, received', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 400, due: '2026-09-01' })
    const late = await bill(co, { type: 'late_fee', amount: 25, due: '2026-09-06' })
    const goodwill = await issuedCredit(co, { amount: 50, category: 'goodwill' })
    const lateRefund = await issuedCredit(co, { amount: 25, category: 'late_fee_refund' })
    const interest = await issuedCredit(co, { amount: 12.34, category: 'deposit_interest' })
    const u1 = await spend(co, { paymentId: rent, tenantCreditId: goodwill, amount: 50, appliedAt: '2026-09-01T15:00:00Z', settle: false })
    const u2 = await spend(co, { paymentId: late, tenantCreditId: lateRefund, amount: 25, appliedAt: '2026-09-07T15:00:00Z', source: 'late_fee_credit' })
    const u3 = await spend(co, { paymentId: rent, tenantCreditId: interest, amount: 12.34, appliedAt: '2026-09-02T15:00:00Z', settle: false })
    await drain()
    expect(triples(await activeLines('credit_use', u1))).toEqual([['credits_given', 5000, 0], ['ar_tenants', 0, 5000]])
    expect((await activeLines('credit_use', u1)).find(l => l.role === 'credits_given')?.category).toBe('credits_given')
    expect(triples(await activeLines('credit_use', u2))).toEqual([['late_fees', 2500, 0], ['ar_tenants', 0, 2500]])
    expect(triples(await activeLines('credit_use', u3))).toEqual([['due_from_gam', 1234, 0], ['ar_tenants', 0, 1234]])
    expect((await activeLines('credit_use', u3)).find(l => l.role === 'ar_tenants')?.cash).toBe('in')
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(40000 - 5000 - 1234)
  })

  it('a credit given back when a stay is shortened (released) re-projects to nothing', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 400, due: '2026-09-01' })
    const credit = await issuedCredit(co, { amount: 100, category: 'goodwill' })
    const use = await spend(co, { paymentId: rent, tenantCreditId: credit, amount: 100, appliedAt: '2026-09-01T15:00:00Z', settle: false })
    await drain()
    expect(await bal(co.landlordId, 'credits_given')).toBe(10000)
    await db.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'stay_shortened' WHERE id = $1`, [use])
    await drain()
    expect(await activeLines('credit_use', use)).toEqual([])
    expect(await bal(co.landlordId, 'credits_given')).toBe(0)
  })

  // 10/18 (Nic): a credit the landlord gave, undone because it was typed by
  // mistake — the books take it back off themselves, the same way.
  it('a credit undone re-projects to nothing: Credits given goes back to zero', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 400, due: '2026-09-01' })
    const credit = await issuedCredit(co, { amount: 100, category: 'goodwill' })
    const use = await spend(co, { paymentId: rent, tenantCreditId: credit, amount: 100, appliedAt: '2026-09-01T15:00:00Z', settle: false })
    await drain()
    expect(await bal(co.landlordId, 'credits_given')).toBe(10000)
    await db.query(`UPDATE credit_uses SET status = 'released', released_at = now(), release_reason = 'credit_undone' WHERE id = $1`, [use])
    await drain()
    expect(await activeLines('credit_use', use)).toEqual([])
    expect(await bal(co.landlordId, 'credits_given')).toBe(0)
  })
})

describe('C5: work-trade hours, by the owner\'s choice (L12)', () => {
  it('rent and labor: full rent is income and the hours a labor cost', async () => {
    const co = await tenantCo({ workTrade: 'rent_and_labor' })
    const id = await bill(co, { amount: 100, due: '2026-09-01', workTradeCredit: 360 })
    await drain()
    const lines = await activeLines('payment', id)
    expect(triples(lines, 'charge')).toEqual([['ar_tenants', 46000, 0], ['space_rent', 0, 46000]])
    expect(triples(lines, 'work_trade')).toEqual([['work_trade_labor', 36000, 0], ['ar_tenants', 0, 36000]])
    expect(lines.find(l => l.kind === 'work_trade')?.day).toBe('2026-09-01')
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(10000)
  })

  it('rent discount: the hours come off rent as a discount', async () => {
    const co = await tenantCo({ workTrade: 'rent_discount' })
    const id = await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-09-30T18:00:00Z', workTradeCredit: 460 })
    await drain()
    expect(triples(await activeLines('payment', id), 'work_trade')).toEqual([['work_trade_discount', 46000, 0], ['ar_tenants', 0, 46000]])
    expect(await bal(co.landlordId, 'space_rent') + await bal(co.landlordId, 'work_trade_discount')).toBe(0)
  })

  it('left out (10/14): the hours cover rent and nothing shows in the books', async () => {
    const co = await tenantCo({ workTrade: 'left_out' })
    const id = await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-09-30T18:00:00Z', workTradeCredit: 460 })
    await drain()
    expect(triples(await activeLines('payment', id), 'work_trade')).toEqual([['space_rent', 46000, 0], ['ar_tenants', 0, 46000]])
    expect(await bal(co.landlordId, 'space_rent')).toBe(0)
    expect(await bal(co.landlordId, 'work_trade_discount')).toBe(0)
    expect(await bal(co.landlordId, 'work_trade_labor')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
  })

  it('left out, part paid in money: only the money counts as rent', async () => {
    const co = await tenantCo({ workTrade: 'left_out' })
    await bill(co, { amount: 100, due: '2026-09-01', workTradeCredit: 360 })
    await drain()
    expect(Math.abs(await bal(co.landlordId, 'space_rent'))).toBe(10000)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(10000)
  })

  it('not chosen yet: the bill waits on the owner', async () => {
    const co = await tenantCo()
    const id = await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-09-30T18:00:00Z', workTradeCredit: 460 })
    await drain()
    expect(await activeLines('payment', id)).toEqual([])
    expect(await sourceError('payment', id)).toMatchObject({ reason_code: 'owner_not_ready' })
  })
})

describe('paid-ahead money arriving (B2, C8) and C7, C10', () => {
  it('rent of a shortened stay moved to credit: no longer rent, now the guest\'s paid-ahead money', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 900, due: '2026-09-01', status: 'settled', settledAt: '2026-09-01T15:00:00Z' })
    const anchored = await paidAhead(co, { amount: 300, fundedBy: 'reclassified', receivedAt: '2026-09-15T15:00:00Z',
      sourcePaymentId: rent, note: STAY_SHORTENED_CREDIT_NOTE })
    const leftover = await paidAhead(co, { amount: 80, fundedBy: 'reclassified', receivedAt: '2026-09-01T15:00:00Z',
      note: 'Reservation deposit paid before the lease — the part the first bill\'s rent did not use' })
    const before = await paidAhead(co, { amount: 37.6, fundedBy: 'landlord', receivedAt: '2026-08-12T19:00:00Z',
      note: 'Paid ahead before GAM (was entered as a credit)' })
    await drain()
    expect(triples(await activeLines('prepaid_credit', anchored))).toEqual([['space_rent', 30000, 0], ['tenant_prepayments', 0, 30000]])
    expect(triples(await activeLines('prepaid_credit', leftover))).toEqual([['stay_income', 8000, 0], ['tenant_prepayments', 0, 8000]])
    expect(triples(await activeLines('prepaid_credit', before))).toEqual([['opening_balance_equity', 3760, 0], ['tenant_prepayments', 0, 3760]])
  })

  it('C7 "Keep it": paid-ahead money left at an ended lease becomes other income (from 2050, or from GAM for money it held)', async () => {
    const co = await tenantCo()
    const held = await paidAhead(co, { amount: 60, fundedBy: 'landlord', receivedAt: '2026-09-01T15:00:00Z', note: 'x' })
    const gam = await paidAhead(co, { amount: 40, fundedBy: 'gam', receivedAt: '2026-09-01T15:00:00Z', note: 'y' })
    const choice = (await db.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_choice, rest_amount,
                                       released_amount, idempotency_key, decided_by)
       VALUES ($1, $2, 100, 'no_refund', 0, 'keep', 100, 40, 'k1', $3) RETURNING id`, [co.leaseId, co.landlordId, co.ownerUserId])).rows[0].id
    const ids = []
    for (const [credit, amount] of [[held, 60], [gam, 40]] as const) {
      ids.push((await db.query<{ id: string }>(
        `INSERT INTO credit_uses (prepaid_credit_id, paid_ahead_choice_id, lease_id, amount, billing_month, source, status, applied_at)
         VALUES ($1, $2, $3, $4, '2026-10-01', 'paid_ahead_choice', 'applied', '2026-10-05T15:00:00Z') RETURNING id`,
        [credit, choice, co.leaseId, amount])).rows[0].id)
    }
    await drain()
    expect(triples(await activeLines('credit_use', ids[0]))).toEqual([['tenant_prepayments', 6000, 0], ['other_income', 0, 6000]])
    expect(triples(await activeLines('credit_use', ids[1]))).toEqual([['due_from_gam', 4000, 0], ['other_income', 0, 4000]])
    expect(await received(co.landlordId, '2026-10-01', '2026-10-31', 'other_income')).toBe(4000)
  })

  it('C10 paid-ahead money used at move-out joins what the move-out settles (Cr 2020)', async () => {
    const co = await tenantCo()
    const credit = await paidAhead(co, { amount: 150, fundedBy: 'landlord', receivedAt: '2026-09-01T15:00:00Z', note: 'z' })
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
       VALUES ($1, $2, $3, 0, 150, 'draft') RETURNING id`, [co.leaseId, co.tenantId, co.landlordId])).rows[0].id
    const use = (await db.query<{ id: string }>(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 150, '2026-10-01', 'move_out', 'applied', '2026-10-31T15:00:00Z') RETURNING id`,
      [credit, dr, co.leaseId])).rows[0].id
    await drain()
    expect(triples(await activeLines('credit_use', use))).toEqual([['tenant_prepayments', 15000, 0], ['security_deposits_payable', 0, 15000]])
  })

  // 10/12 (Nic, ledger review): deposit interest GAM credited, used at the
  // move-out, goes back with the deposit GAM holds (1070) — never into Due from
  // GAM (1050), where no payout line would ever explain it.
  it('C10 deposit interest used at move-out joins the deposit GAM holds (1070), not Due from GAM', async () => {
    const co = await tenantCo()
    const interest = await issuedCredit(co, { amount: 12.5, category: 'deposit_interest' })
    const ret = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
       VALUES ($1, $2, $3, 0, 0, 'draft') RETURNING id`, [co.leaseId, co.tenantId, co.landlordId])).rows[0].id
    const use = (await db.query<{ id: string }>(
      `INSERT INTO credit_uses (tenant_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 12.5, '2026-10-01', 'move_out', 'applied', '2026-10-31T15:00:00Z') RETURNING id`,
      [interest, ret, co.leaseId])).rows[0].id
    await drain()
    const lines = await activeLines('credit_use', use)
    expect(triples(lines)).toEqual([['deposits_gam_holds', 1250, 0], ['security_deposits_payable', 0, 1250]])
    expect(lines.find(l => l.role === 'deposits_gam_holds')).toMatchObject({ leaseId: co.leaseId, cash: null })
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(0)
  })
})
