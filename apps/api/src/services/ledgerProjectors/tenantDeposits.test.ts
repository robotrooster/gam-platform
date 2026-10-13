/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family D: deposits, move-out and
 * refunds post themselves (gam-ledger-design-2026-10-12 §6 D1-D4; §17).
 *
 *   Nic 10/12: "security deposits = liability, income only when kept"; G10: a
 *   card refund gives the fee back and the landlord eats it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { db } from '../../db'
import { inTx } from '../../test/ledgerFixtures'
import {
  cleanupTenantLedger, tenantCo, bill, receipt, drain, bal, activeLines, triples, sourceError, paidAhead, issuedCredit, spend, type TenantCo,
} from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'
import { paidAheadCheck } from '../ledgerTenantChecks'
import { STAY_SHORTENED_CREDIT_NOTE } from '../bookingLeaseBilling'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})
// 10/12 (Nic, ledger review): leave no paid-ahead choice behind — the shared
// cleanupAllSchema the next file runs does not clear them (they name a lease).
afterAll(async () => {
  await cleanupTenantLedger()
})

/** A finalized move-out (the facts depositReturn.finalize leaves). */
async function moveOut(co: TenantCo, o: {
  deposit: number; cleaning?: number; damage?: number; swept?: number; refund: number; gap?: number; gapPaymentId?: string | null
  status?: string; securityDepositId?: string | null; at?: string
}): Promise<string> {
  const cleaning = o.cleaning ?? 0
  const damage = o.damage ?? 0
  const swept = o.swept ?? 0
  const r = await db.query<{ id: string }>(
    `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, security_deposit_id, total_deposit, cleaning_fee_amount, damage_lines,
                                  other_deductions, total_deductions, refund_amount, gap_amount, unpaid_balance_amount, status,
                                  gap_payment_id, finalized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [co.leaseId, co.tenantId, co.landlordId, o.securityDepositId ?? null, o.deposit, cleaning,
     JSON.stringify(damage ? [{ description: 'Broken window', amount: damage }] : []),
     cleaning + damage + swept, o.refund, o.gap ?? 0, swept, o.status ?? (o.refund > 0 ? 'sent_refund' : o.gap ? 'sent_gap' : 'sent_zero'),
     o.gapPaymentId ?? null, o.at ?? '2026-10-31T18:00:00Z'])
  return r.rows[0].id
}

async function refundPart(co: TenantCo, returnId: string, o: { kind: string; toward: number; cardFeeBack?: number; payoutDrop?: number; at?: string }): Promise<string> {
  const cfb = o.cardFeeBack ?? 0
  const r = await db.query<{ id: string }>(
    `INSERT INTO stay_refund_parts (landlord_id, deposit_return_id, seq, kind, toward_amount, card_fee_back, amount, payout_drop, label,
                                    status, refunded_at, stripe_payment_intent_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'Deposit refund', $8, $9, $10) RETURNING id`,
    [co.landlordId, returnId, o.kind, o.toward, cfb, o.toward + cfb, o.payoutDrop ?? 0,
     o.kind === 'cash' ? 'handed_back' : 'refunded', o.at ?? '2026-11-03T18:00:00Z',
     o.kind === 'card' || o.kind === 'bank' ? 'pi_refund' : null])
  return r.rows[0].id
}

describe('a deposit from billing to move-out', () => {
  it('kept in part, refunded in part: 2020 goes to zero, only what was kept is income, GAM sends the refund from what it holds', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 1000, due: '2026-09-01', depositCollectedBy: 'gam' })
    await receipt(co, { method: 'card', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 1000 }] })
    // The last month's water was unpaid: the deposit pays it at move-out.
    const water = await bill(co, { type: 'utility', amount: 60, due: '2026-10-01' })
    await db.query(`UPDATE payments SET status = 'paid_via_deposit', settled_at = '2026-10-31T18:00:00Z' WHERE id = $1`, [water])
    const ret = await moveOut(co, { deposit: 1000, cleaning: 150, damage: 90, swept: 60, refund: 700 })
    const part = await refundPart(co, ret, { kind: 'card', toward: 700 })
    await drain()
    expect(triples(await activeLines('deposit_return', ret))).toEqual([
      ['security_deposits_payable', 24000, 0], ['deposit_deductions_kept', 0, 24000],
    ])
    expect(triples(await activeLines('payment', water), 'paid_from_deposit')).toEqual([
      ['security_deposits_payable', 6000, 0], ['ar_tenants', 0, 6000],
    ])
    expect(triples(await activeLines('refund_part', part))).toEqual([
      ['security_deposits_payable', 70000, 0], ['deposits_gam_holds', 0, 70000],
    ])
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(0)
    expect(await bal(co.landlordId, 'deposit_deductions_kept')).toBe(-24000)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    // What GAM still holds is what the deductions kept — released to the
    // landlord by the move-out's held item (phase P5, design G4).
    expect(await bal(co.landlordId, 'deposits_gam_holds')).toBe(30000)
  })

  it('kept whole: deductions beyond the deposit leave a move-out balance the tenant owes', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 500, due: '2026-09-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 500 }] })
    const gapRow = await bill(co, { type: 'fee', entry: 'DEPOSIT', amount: 120, due: '2026-10-31' })
    const ret = await moveOut(co, { deposit: 500, cleaning: 200, damage: 420, refund: 0, gap: 120, gapPaymentId: gapRow })
    await drain()
    expect(triples(await activeLines('deposit_return', ret))).toEqual([
      ['security_deposits_payable', 62000, 0], ['deposit_deductions_kept', 0, 62000],
      ['ar_tenants', 12000, 0], ['security_deposits_payable', 0, 12000],
    ])
    expect(await activeLines('payment', gapRow)).toEqual([])   // the move-out books its charge, not the row
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(12000)
    expect(await bal(co.landlordId, 'deposit_deductions_kept')).toBe(-62000)
  })

  it('returned whole, by check: 2015 until the bank shows it; by cash: out of the drawer', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 400, due: '2026-09-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 400 }] })
    const ret = await moveOut(co, { deposit: 400, refund: 400 })
    const check = await refundPart(co, ret, { kind: 'check', toward: 300 })
    const cash = await refundPart(co, ret, { kind: 'cash', toward: 100 })
    await drain()
    expect(await activeLines('deposit_return', ret)).toEqual([])
    expect(triples(await activeLines('refund_part', check))).toEqual([['security_deposits_payable', 30000, 0], ['outstanding_checks', 0, 30000]])
    expect(triples(await activeLines('refund_part', cash))).toEqual([['security_deposits_payable', 10000, 0], ['undeposited_funds', 0, 10000]])
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(0)
    // A reversed or failed part posts nothing (a correction).
    await db.query(`UPDATE stay_refund_parts SET status = 'failed', refunded_at = NULL WHERE id = $1`, [check])
    await drain()
    expect(await activeLines('refund_part', check)).toEqual([])
  })

  it('a card refund that gives the card fee back: the landlord eats the fee ("Card fees refunded", 5117), off their payout', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 300, due: '2026-09-01', depositCollectedBy: 'gam' })
    await receipt(co, { method: 'card', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 300 }] })
    const ret = await moveOut(co, { deposit: 300, refund: 300 })
    const part = await refundPart(co, ret, { kind: 'card', toward: 300, cardFeeBack: 11.05, payoutDrop: 11.05 })
    await drain()
    expect(triples(await activeLines('refund_part', part))).toEqual([
      ['security_deposits_payable', 30000, 0], ['card_fees_refunded', 1105, 0], ['due_from_gam', 0, 1105], ['deposits_gam_holds', 0, 30000],
    ])
  })
})

// 10/12 (Nic, ledger review): refund parts that draw on paid-ahead money.
describe('refunds of paid-ahead money', () => {
  it('a long stay\'s early check-out refunds from the credit its rent was moved to: 2050 goes down, rent is cut once (C8 only)', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 1000, due: '2026-09-01' })
    await receipt(co, { method: 'card', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: rent, amount: 1000 }] })
    // The stay was shortened: the rent paid past the new end moved to credit (C8).
    const credit = await paidAhead(co, { amount: 400, fundedBy: 'reclassified', receivedAt: '2026-09-20T18:00:00Z',
      sourcePaymentId: rent, note: STAY_SHORTENED_CREDIT_NOTE })
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, stay_terms)
       VALUES ($1, $2, '2026-09-01', '2026-09-20', 'month_to_month', 'checked_out', 'lease') RETURNING id`, [co.unitId, co.landlordId])).rows[0].id
    const decision = (await db.query<{ id: string }>(
      `INSERT INTO stay_checkout_decisions (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth,
                                            paid, refund_total, decided_at)
       VALUES ($1, $2, $3, '2026-09-20', 'overpaid', 'refund_other', 'decided', 1000, 600, 1000, 300, now()) RETURNING id`,
      [booking, co.landlordId, co.leaseId])).rows[0].id
    const part = async (seq: number, kind: string, toward: number, cfb: number) => (await db.query<{ id: string }>(
      `INSERT INTO stay_refund_parts (decision_id, booking_id, landlord_id, seq, kind, prepaid_credit_id, toward_amount, card_fee_back, amount,
                                      payout_drop, label, status, refunded_at, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $7::numeric + $8::numeric, $9, 'Rent paid ahead', $10,
               '2026-09-21T18:00:00Z', $11) RETURNING id`,
      [decision, booking, co.landlordId, seq, kind, credit, toward, cfb, kind === 'card' ? toward + cfb : 0,
       kind === 'credit' ? 'credited' : 'refunded', kind === 'card' ? 'pi_rent' : null])).rows[0].id
    const card = await part(1, 'card', 300, 10)
    const back = await part(2, 'credit', 100, 0)
    // The card part is a recorded spend of the credit; credit back to credit stays on it.
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 300, '2026-09-01', 'refund', 'applied', '2026-09-21T18:00:00Z')`, [credit, card, co.leaseId])
    await drain()
    expect(triples(await activeLines('refund_part', card))).toEqual([
      ['tenant_prepayments', 30000, 0], ['card_fees_refunded', 1000, 0], ['due_from_gam', 0, 31000],
    ])
    expect(await activeLines('refund_part', back)).toEqual([])
    expect(await bal(co.landlordId, 'space_rent')).toBe(-100000 + 40000)   // the shortening only
    expect(await bal(co.landlordId, 'tenant_prepayments')).toBe(-10000)     // 400 moved to credit, 300 refunded
    const c = await db.connect()
    try {
      expect(await paidAheadCheck.run(c, { landlordId: co.landlordId })).toEqual([])
    } finally {
      c.release()
    }
  })

  it('paid-ahead money refunded back as the landlord\'s own credit: 2050 becomes credit given, and its later use nets out', async () => {
    const co = await tenantCo()
    const credit = await paidAhead(co, { amount: 50, fundedBy: 'landlord', receivedAt: '2026-08-12T19:00:00Z', note: 'Paid ahead before GAM' })
    const choice = (await db.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, idempotency_key, decided_by)
       VALUES ($1, $2, 50, 'refund_all', 50, 'k-credit-back', $3) RETURNING id`, [co.leaseId, co.landlordId, co.ownerUserId])).rows[0].id
    const part = (await db.query<{ id: string }>(
      `INSERT INTO stay_refund_parts (paid_ahead_choice_id, landlord_id, seq, kind, prepaid_credit_id, toward_amount, amount, label, status, refunded_at)
       VALUES ($1, $2, 1, 'credit', $3, 50, 50, 'Back to their account credit', 'credited', '2026-10-05T18:00:00Z') RETURNING id`,
      [choice, co.landlordId, credit])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, refund_part_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 50, '2026-10-01', 'refund', 'applied', '2026-10-05T18:00:00Z')`, [credit, part, co.leaseId])
    const given = await issuedCredit(co, { amount: 50, category: 'other', leaseId: null })
    const rent = await bill(co, { amount: 50, due: '2026-11-01' })
    await spend(co, { paymentId: rent, tenantCreditId: given, amount: 50, appliedAt: '2026-11-01T15:00:00Z' })
    await drain()
    expect(triples(await activeLines('refund_part', part))).toEqual([['tenant_prepayments', 5000, 0], ['credits_given', 0, 5000]])
    expect(await bal(co.landlordId, 'credits_given')).toBe(0)
    expect(await bal(co.landlordId, 'tenant_prepayments')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
  })
})

describe('D2: a deposit the tenant pays in installments', () => {
  it('shows the full deposit at enrollment (never the installments); a shortfall at move-out is an adjustment', async () => {
    const co = await tenantCo()
    const sd = await inTx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status, flex_deposit_enabled,
                                        flex_deposit_plan_status)
         VALUES ($1, $2, $3, 900, 600, 'gam_escrow', 'partial', TRUE, 'active') RETURNING id`, [co.unitId, co.leaseId, co.tenantId])).rows[0].id
      for (const [n, status, settled] of [[1, 'settled', '2026-09-01T18:00:00Z'], [2, 'settled', '2026-10-01T18:00:00Z'], [3, 'missed', null]] as const) {
        await c.query(
          `INSERT INTO flex_deposit_installments (security_deposit_id, tenant_id, installment_number, installment_count, amount, due_date,
                                                  status, settled_at, created_at)
           VALUES ($1, $2, $3, 3, 300, '2026-09-01'::date + ($3 - 1) * interval '1 month', $4, $5, '2026-08-25T18:00:00Z')`,
          [id, co.tenantId, n, status, settled])
      }
      return id
    })
    // An installment pull row books nothing on the landlord's book.
    const pull = await bill(co, { type: 'deposit', amount: 300, due: '2026-09-01', status: 'settled', settledAt: '2026-09-01T18:00:00Z' })
    await db.query(`UPDATE flex_deposit_installments SET payment_id = $1 WHERE security_deposit_id = $2 AND installment_number = 1`, [pull, sd])
    await drain()
    const lines = await activeLines('security_deposit', sd)
    expect(lines[0]?.day).toBe('2026-08-25')
    expect(triples(lines)).toEqual([['deposits_gam_holds', 90000, 0], ['security_deposits_payable', 0, 90000]])
    expect(await activeLines('payment', pull)).toEqual([])
    const ret = await moveOut(co, { deposit: 600, cleaning: 100, refund: 500, securityDepositId: sd })
    await drain()
    expect(triples(await activeLines('deposit_return', ret))).toEqual([
      ['security_deposits_payable', 10000, 0], ['deposit_deductions_kept', 0, 10000],
      ['security_deposits_payable', 30000, 0], ['deposits_gam_holds', 0, 30000],
    ])
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(-50000)   // the refund still to send
  })
})

describe('what is refused, with a reason', () => {
  it('a deposit carried forward to another lease waits (its record moves in place; nothing to post the hand-over from)', async () => {
    const co = await tenantCo()
    const ret = await moveOut(co, { deposit: 500, refund: 0, status: 'sent_carried_forward' })
    await drain()
    expect(await activeLines('deposit_return', ret)).toEqual([])
    expect(await sourceError('deposit_return', ret)).toMatchObject({ reason_code: 'missing_fact' })
  })
})
