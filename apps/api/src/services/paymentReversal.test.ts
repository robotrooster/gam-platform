/**
 * S561 Phase 3: post-settlement payment reversal handler.
 *
 * handlePaymentReversal reopens a tenant's obligation after an already-settled,
 * already-batched rent payment reverses (late ACH return/unauthorized or card
 * chargeback), and records the landlord receivable. Verifies the two-row reopen
 * (original → 'returned', fresh 'pending' rent the tenant re-pays), the
 * pass-through reversal fee row, invoice reopen, the immediate late-fee
 * back-fill trigger, the bold landlord notification, and idempotency.
 *
 * Late-fee engine, notifications, admin alerts, and responsible-party lookup
 * are mocked — this is a unit test of the handler's DB mechanics + wiring.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'

const lateFeeMock = vi.hoisted(() => vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })))
const notifyReversedMock = vi.hoisted(() => vi.fn(async () => undefined))
const adminNotifyMock = vi.hoisted(() => vi.fn(async () => undefined))
const responsiblePartyMock = vi.hoisted(() => vi.fn(async () => ({
  primaries: [{ user_id: 'll-user', email: 'landlord@test.dev', phone: null }],
})))
const decideRecoveryMock = vi.hoisted(() => vi.fn(async () => null))

vi.mock('../jobs/lateFees', () => ({ generateLateFeesForInvoice: lateFeeMock }))
vi.mock('./notifications', () => ({ notifyRentReversed: notifyReversedMock }))
vi.mock('./adminNotifications', () => ({ createAdminNotification: adminNotifyMock }))
vi.mock('./responsibleParty', () => ({ getPropertyResponsibleParty: responsiblePartyMock }))
vi.mock('./reversalRecovery', () => ({ decideReversalRecovery: decideRecoveryMock, decideEventRecovery: decideRecoveryMock }))
// Fix pass (rev8): a test can make the charge's paid-ahead take-back answer
// "try again in a moment" (DisputeRetryLater); every other test runs the real one.
const clawOverride = vi.hoisted(() => ({ fn: null as null | ((...a: any[]) => Promise<any>) }))
vi.mock('./creditUse', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    clawBackDisputedCharge: (...args: any[]) => (clawOverride.fn ? clawOverride.fn(...args) : actual.clawBackDisputedCharge(...args)),
  }
})

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import {
  handlePaymentReversal, resolveReversalOnTenantPayment, disputeFeeBorneCents, DISPUTE_FEE_RULE, type PaymentReversalInput,
  disputeShareLineSql, disputeFeeLineSql,
} from './paymentReversal'

interface Ctx {
  landlordId: string; unitId: string; tenantId: string
  leaseId: string; invoiceId: string; paymentId: string
}

async function seedCtx(paymentStatus: 'settled' | 'pending' = 'settled', o: { ownerShare?: boolean; unpaidShare?: boolean } = {}): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId })
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    const { rows: [inv] } = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4, CURRENT_DATE, 1000, 'settled') RETURNING id`,
      [landlordId, leaseId, unitId, 'INV-' + Math.random().toString(36).slice(2, 8)]
    )
    const invoiceId = inv.id
    const { rows: [pay] } = await c.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, invoice_id, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,'rent',1000,$5,'RENT',CURRENT_DATE,$6,'pi_orig',
               CASE WHEN $5 = 'settled' THEN NOW() ELSE NULL END)
       RETURNING id`,
      [unitId, leaseId, tenantId, landlordId, paymentStatus, invoiceId]
    )
    // S655: the landlord was paid an owner share on it (the batch carried it:
    // its transfer is stamped), so GAM recovers it from them. `unpaidShare`:
    // booked, still on GAM's balance (no batch ran yet).
    if (o.ownerShare !== false && paymentStatus === 'settled') {
      await c.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, stripe_transfer_id)
         VALUES ($1, 'allocation_owner_share', 1000, 1000, $2, 'payment', $3)`,
        [landlordUserId, pay.id, o.unpaidShare ? null : 'tr_paid_tuesday'])
    }
    await c.query('COMMIT')
    return { landlordId, unitId, tenantId, leaseId, invoiceId, paymentId: pay.id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

function inputFor(ctx: Ctx, eventId = 'evt_test_1'): PaymentReversalInput {
  return {
    paymentId:     ctx.paymentId,
    reversalType:  'ach_unauthorized',
    reversedAmount: 1000,
    reversalFee:    4,
    stripeEventId:  eventId,
    stripeObjectId: 'du_test',
    rawEvent:       { id: eventId, type: 'charge.dispute.created' },
  }
}

// S655: one record per (event, row). The old one-per-event constraint goes in
// contract step C0 (db/contract/20261003109000_credit_ledger_guards.sql); it is
// dropped for this file only and put back after ONLY if it was there, so later
// suites see the schema this file found — before C0 on a plain run, after C0
// on the final run that applies it first (money plan Step 16).
let hadOldConstraint = false
beforeAll(async () => {
  hadOldConstraint = (await db.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'payment_reversals_stripe_event_id_key'`)).rowCount === 1
  await db.query(`ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_stripe_event_id_key`)
})
afterAll(async () => {
  if (!hadOldConstraint) return
  await cleanupAllSchema()
  await db.query(`ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_stripe_event_id_key UNIQUE (stripe_event_id)`)
})

beforeEach(async () => {
  await cleanupAllSchema()
  lateFeeMock.mockClear()
  notifyReversedMock.mockClear()
  adminNotifyMock.mockClear()
  responsiblePartyMock.mockClear()
  decideRecoveryMock.mockClear()
})

describe('handlePaymentReversal — "try again in a moment" (fix pass rev8)', () => {
  it('a take-back that must wait (a refund of this money was being sent) writes nothing, raises no failure alert, and is thrown for the webhook to retry', async () => {
    const ctx = await seedCtx('settled')
    const { DisputeRetryLater } = await import('./creditUse')
    clawOverride.fn = async () => { throw new DisputeRetryLater('refund_part_busy', 'A refund of this money was being sent at that same moment — try again in a moment.') }
    try {
      await expect(handlePaymentReversal(inputFor(ctx, 'evt_retry_later'))).rejects.toBeInstanceOf(DisputeRetryLater)
    } finally { clawOverride.fn = null }
    expect(adminNotifyMock.mock.calls.filter((c: any[]) => c[0]?.category === 'payment_reversal_failed')).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM payment_reversals WHERE stripe_event_id = 'evt_retry_later'`)).rowCount).toBe(0)
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [ctx.paymentId])).rows[0].status).toBe('settled')
    // The redelivery, once the refund is no longer being sent, goes through.
    const again = await handlePaymentReversal(inputFor(ctx, 'evt_retry_later'))
    expect(again.handled).toBe(true)
  })

  it('any other failure still raises the critical alert', async () => {
    const ctx = await seedCtx('settled')
    clawOverride.fn = async () => { throw new Error('boom') }
    try {
      await expect(handlePaymentReversal(inputFor(ctx, 'evt_boom'))).rejects.toThrow('boom')
    } finally { clawOverride.fn = null }
    expect(adminNotifyMock.mock.calls.filter((c: any[]) => c[0]?.category === 'payment_reversal_failed')).toHaveLength(1)
  })
})

describe('handlePaymentReversal', () => {
  it('reopens the tenant obligation two-row + records the receivable + notifies', async () => {
    const ctx = await seedCtx('settled')
    const res = await handlePaymentReversal(inputFor(ctx))
    expect(res.handled).toBe(true)

    // Receivable row
    const rev = await db.query(`SELECT * FROM payment_reversals WHERE stripe_event_id = $1`, ['evt_test_1'])
    expect(rev.rows).toHaveLength(1)
    expect(rev.rows[0]).toMatchObject({ payment_id: ctx.paymentId, reversal_type: 'ach_unauthorized', recovery_status: 'pending', status: 'open' })
    expect(Number(rev.rows[0].reversed_amount)).toBe(1000)
    expect(Number(rev.rows[0].reversal_fee)).toBe(4)

    // Original → returned
    const orig = await db.query(`SELECT status, return_code FROM payments WHERE id = $1`, [ctx.paymentId])
    expect(orig.rows[0].status).toBe('returned')
    expect(orig.rows[0].return_code).toBe('ach_unauthorized')

    // Fresh pending rent the tenant re-pays (null PI, original due date, 1000)
    const newRent = await db.query(
      `SELECT * FROM payments WHERE invoice_id = $1 AND type='rent' AND status='pending' AND id <> $2`,
      [ctx.invoiceId, ctx.paymentId]
    )
    expect(newRent.rows).toHaveLength(1)
    expect(newRent.rows[0].stripe_payment_intent_id).toBeNull()
    expect(Number(newRent.rows[0].amount)).toBe(1000)

    // Pass-through reversal fee row
    const fee = await db.query(`SELECT * FROM payments WHERE invoice_id = $1 AND type='fee' AND status='pending'`, [ctx.invoiceId])
    expect(fee.rows).toHaveLength(1)
    expect(Number(fee.rows[0].amount)).toBe(4)

    // Invoice reopened
    const invRow = await db.query(`SELECT status FROM invoices WHERE id = $1`, [ctx.invoiceId])
    expect(invRow.rows[0].status).toBe('pending')

    // Side effects: immediate late-fee back-fill + bold landlord alert
    expect(lateFeeMock).toHaveBeenCalledWith(ctx.invoiceId)
    expect(notifyReversedMock).toHaveBeenCalledTimes(1)
    // Recovery method decided immediately.
    expect(decideRecoveryMock).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a re-delivered reversal is a no-op, no duplicate rows', async () => {
    const ctx = await seedCtx('settled')
    await handlePaymentReversal(inputFor(ctx))
    const res2 = await handlePaymentReversal(inputFor(ctx))
    expect(res2.handled).toBe(false)  // original is now 'returned' → skipped

    const revs = await db.query(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [ctx.paymentId])
    expect(revs.rows).toHaveLength(1)
    const newRent = await db.query(
      `SELECT id FROM payments WHERE invoice_id = $1 AND type='rent' AND status='pending' AND id <> $2`,
      [ctx.invoiceId, ctx.paymentId]
    )
    expect(newRent.rows).toHaveLength(1)
    const fee = await db.query(`SELECT id FROM payments WHERE invoice_id = $1 AND type='fee'`, [ctx.invoiceId])
    expect(fee.rows).toHaveLength(1)
  })

  it('skips a payment that never settled (pre-settlement failures are achRetry’s job)', async () => {
    const ctx = await seedCtx('pending')
    const res = await handlePaymentReversal(inputFor(ctx))
    expect(res.handled).toBe(false)
    expect(res.reason).toContain('not_settled')
    const revs = await db.query(`SELECT id FROM payment_reversals WHERE payment_id = $1`, [ctx.paymentId])
    expect(revs.rows).toHaveLength(0)
  })
})

describe('handlePaymentReversal — S655 per-row records', () => {
  it('a reopened row keeps its lease fee and its owner: a disputed pet fee stays the landlord\'s, a GAM fee stays GAM\'s', async () => {
    const ctx = await seedCtx('settled')
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable)
       VALUES ($1, 'pet_deposit', 30, 'move_in', FALSE) RETURNING id`, [ctx.leaseId])).rows[0].id
    const pet = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, invoice_id, stripe_payment_intent_id, settled_at, lease_fee_id, notes)
       VALUES ($1,$2,$3,$4,'fee',30,'settled','DEPOSIT',CURRENT_DATE,$5,'pi_orig',NOW(),$6,'Pet deposit') RETURNING id`,
      [ctx.unitId, ctx.leaseId, ctx.tenantId, ctx.landlordId, ctx.invoiceId, fee])).rows[0].id
    const gamFee = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, invoice_id, stripe_payment_intent_id, settled_at, revenue_owner, notes)
       VALUES ($1,$2,$3,$4,'fee',1,'settled','DECLINEFEE',CURRENT_DATE,$5,'pi_orig',NOW(),'gam','Declined card attempt — pi_x') RETURNING id`,
      [ctx.unitId, ctx.leaseId, ctx.tenantId, ctx.landlordId, ctx.invoiceId])).rows[0].id

    const res = await handlePaymentReversal({ ...inputFor(ctx), paymentId: null, paymentIntentId: 'pi_orig', reversedAmount: null })
    expect(res.handled).toBe(true)
    expect(res.rows).toHaveLength(3)
    const reopened = await db.query<any>(
      `SELECT r.payment_id AS orig, p.amount::float AS amount, p.lease_fee_id, p.revenue_owner, p.entry_description, p.notes
         FROM payment_reversals r JOIN payments p ON p.reversal_id = r.id
        WHERE r.stripe_event_id = 'evt_test_1' ORDER BY p.amount`)
    expect(reopened.rows.map((r: any) => [r.orig, r.amount, r.lease_fee_id, r.revenue_owner, r.entry_description])).toEqual([
      [gamFee, 1, null, 'gam', 'DECLINEFEE'],
      [pet, 30, fee, 'landlord', 'DEPOSIT'],
      [ctx.paymentId, 1000, null, 'landlord', 'RENT'],
    ])
    // The reopened line reads as the line it was.
    expect(reopened.rows[1].notes).toBe('Pet deposit — reopened after a payment reversal')
    // Recovery only where the landlord was paid: the rent (its owner share is booked).
    const rec = await db.query<any>(
      `SELECT payment_id, recovery_status FROM payment_reversals WHERE stripe_event_id = 'evt_test_1' ORDER BY reversed_amount`)
    expect(rec.rows.map((r: any) => r.recovery_status)).toEqual(['not_needed', 'not_needed', 'pending'])
    // One fee row, one landlord notice for the event.
    expect((await db.query(`SELECT 1 FROM payments WHERE entry_description = 'RETURNFEE'`)).rowCount).toBe(1)
    expect(notifyReversedMock).toHaveBeenCalledTimes(1)
  })

  it('a row whose owner share is still on GAM\'s balance (no payout yet) is withheld, never also asked back', async () => {
    const ctx = await seedCtx('settled', { unpaidShare: true })
    const res = await handlePaymentReversal(inputFor(ctx))
    expect(res.handled).toBe(true)
    const rev = await db.query<any>(
      `SELECT recovery_status, recovered_amount::float AS rec, outcome, status FROM payment_reversals WHERE stripe_event_id = 'evt_test_1'`)
    expect(rev.rows).toEqual([{ recovery_status: 'recovered', rec: 1000, outcome: 'landlord_clawback', status: 'resolved' }])
    // The share is withheld (never paid by a batch), and nothing is asked of the landlord.
    const share = await db.query<any>(`SELECT stripe_transfer_id FROM user_balance_ledger WHERE reference_id = $1`, [ctx.paymentId])
    expect(share.rows[0].stripe_transfer_id).toMatch(/^withheld:/)
    expect(decideRecoveryMock).not.toHaveBeenCalled()
    expect(res.rows[0]).toMatchObject({ landlordRecovery: false, withheld: 1000 })
  })

  it('a row whose owner share was never paid out needs no landlord recovery', async () => {
    const ctx = await seedCtx('settled', { ownerShare: false })
    const res = await handlePaymentReversal(inputFor(ctx))
    expect(res.handled).toBe(true)
    const rev = await db.query<any>(`SELECT recovery_status, status FROM payment_reversals WHERE stripe_event_id = 'evt_test_1'`)
    expect(rev.rows).toEqual([{ recovery_status: 'not_needed', status: 'open' }])
    expect(decideRecoveryMock).not.toHaveBeenCalled()
  })
})

describe('resolveReversalOnTenantPayment', () => {
  async function seedRev(recoveryStatus: string, recoveredAmount: number, reversedAmount = 1000): Promise<string> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const { rows: [pay] } = await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,'rent',$4,'returned','RENT',CURRENT_DATE) RETURNING id`,
        [unitId, tenantId, landlordId, reversedAmount])
      const { rows: [rev] } = await c.query<{ id: string }>(
        `INSERT INTO payment_reversals
           (payment_id, landlord_id, reversal_type, reversed_amount, reversal_fee,
            stripe_event_id, raw_event, recovery_method, recovery_status, recovered_amount, status)
         VALUES ($1,$2,'ach_unauthorized',$3,4,$4,'{}','netting',$5,$6,'recovering') RETURNING id`,
        [pay.id, landlordId, reversedAmount, 'evt_' + Math.random().toString(36).slice(2, 8), recoveryStatus, recoveredAmount])
      await c.query('COMMIT')
      return rev.id
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('GAM keeps (returns false) + cancels netting when the landlord was not clawed back', async () => {
    const revId = await seedRev('scheduled_netting', 0)
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(false) } finally { client.release() }
    const { rows: [r] } = await db.query<any>(
      `SELECT outcome, late_fee_owner, status, recovery_status FROM payment_reversals WHERE id=$1`, [revId])
    expect(r).toMatchObject({ outcome: 'tenant_paid', late_fee_owner: 'gam', status: 'resolved', recovery_status: 'not_needed' })
  })

  it('re-disburses (returns true) when the landlord was fully clawed back', async () => {
    const revId = await seedRev('recovered', 1000)
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(true) } finally { client.release() }
    const { rows: [r] } = await db.query<any>(
      `SELECT outcome, late_fee_owner, recovery_status FROM payment_reversals WHERE id=$1`, [revId])
    expect(r).toMatchObject({ outcome: 'tenant_paid', late_fee_owner: 'gam', recovery_status: 'recovered' })
  })

  it('the tenant pays again before the paid-out part was recovered: GAM keeps it and pays the landlord back the share it withheld', async () => {
    // A second record on a row: $100 of it was withheld from the $100 the
    // first record still owed the landlord (a netting line), the rest had
    // gone out and was still to be recovered when the tenant paid again.
    const revId = await seedRev('pending', 100, 300)
    const { rows: [r0] } = await db.query<any>(`SELECT landlord_id FROM payment_reversals WHERE id = $1`, [revId])
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'dispute', $2, -100, 'withheld')`, [r0.landlord_id, `owner_share_withheld:${revId}`])
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(false) } finally { client.release() }
    const back = await db.query<any>(
      `SELECT landlord_id, amount::float AS a FROM held_payout_items WHERE source_type = 'dispute' AND source_id = $1`, [`owner_share_returned:${revId}`])
    expect(back.rows).toEqual([{ landlord_id: r0.landlord_id, a: 100 }])
    const { rows: [r] } = await db.query<any>(`SELECT recovery_status, outcome FROM payment_reversals WHERE id = $1`, [revId])
    expect(r).toMatchObject({ recovery_status: 'not_needed', outcome: 'tenant_paid' })
    expect(adminNotifyMock).not.toHaveBeenCalledWith(expect.objectContaining({ category: 'payment_reversal_partial_clawback_tenant_paid' }))
    // A second call changes nothing.
    const c2 = await db.connect()
    try { await resolveReversalOnTenantPayment(c2, revId) } finally { c2.release() }
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE source_id = $1`, [`owner_share_returned:${revId}`])).rowCount).toBe(1)
  })

  it('a reopened row paid from the security deposit leaves the landlord recovery standing (the deposit money is the landlord\'s)', async () => {
    const revId = await seedRev('scheduled_netting', 0)
    const { rows: [o] } = await db.query<any>(
      `SELECT p.unit_id, p.tenant_id, p.landlord_id FROM payment_reversals r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1`, [revId])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id, settled_at)
       VALUES ($1,$2,$3,'rent',1000,'paid_via_deposit','RENT',CURRENT_DATE,$4,NOW())`, [o.unit_id, o.tenant_id, o.landlord_id, revId])
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(true) } finally { client.release() }
    const { rows: [r] } = await db.query<any>(`SELECT recovery_status, status, outcome FROM payment_reversals WHERE id = $1`, [revId])
    expect(r).toMatchObject({ recovery_status: 'scheduled_netting', status: 'recovering', outcome: 'tenant_paid' })
    expect((await db.query(`SELECT 1 FROM held_payout_items`)).rowCount).toBe(0)
  })

  it('partial clawback → GAM keeps (false) + raises an admin reconciliation alert', async () => {
    const revId = await seedRev('scheduled_netting', 300)
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(false) } finally { client.release() }
    expect(adminNotifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'payment_reversal_partial_clawback_tenant_paid' }))
  })
})

describe('who bears the fee a dispute took back (one rule, DISPUTE_FEE_RULE)', () => {
  it('the rule in force is decisions #38 Q4 (Nic, FINAL): GAM keeps the fee it earned, the landlord carries the whole fee', () => {
    expect(DISPUTE_FEE_RULE).toBe('landlord_bears_whole_fee')
    // $6.00 fee charged, GAM's spread $3.00: the landlord carries all $6.00.
    expect(disputeFeeBorneCents('landlord_bears_whole_fee', { feeCents: 600, spreadCents: 300, feeTaken: 600, feeTotal: 600 })).toBe(600)
  })
  it('under the superseded money-plan rule the landlord would carry only Stripe\'s kept cost', () => {
    expect(disputeFeeBorneCents('gam_gives_up_spread', { feeCents: 600, spreadCents: 300, feeTaken: 600, feeTotal: 600 })).toBe(300)
  })
  it('a dispute that took back half the fee carries half', () => {
    expect(disputeFeeBorneCents('gam_gives_up_spread', { feeCents: 600, spreadCents: 300, feeTaken: 300, feeTotal: 600 })).toBe(150)
    expect(disputeFeeBorneCents('landlord_bears_whole_fee', { feeCents: 600, spreadCents: 300, feeTaken: 300, feeTotal: 600 })).toBe(300)
  })
})

describe('the payout lines a dispute writes are told apart from a register chargeback', () => {
  it('the share and fee predicates pick out only the reversal\'s own lines, never a chargeback on a sale', async () => {
    const c = await db.connect()
    let landlordId: string
    try { landlordId = (await seedLandlord(c)).landlordId } finally { c.release() }
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES
         ($1, 'dispute', 'owner_share_untouched:r1', 300),
         ($1, 'dispute', 'owner_share_withheld:r2', -100),
         ($1, 'dispute', 'owner_share_returned:r3', 994),
         ($1, 'dispute', 'stripe_fee_kept:pi_x:' || $1::text, -6),
         ($1, 'dispute', 'du_register_chargeback', -45),
         ($1, 'refund', 'owner_share_untouched:not_a_dispute', 5)`, [landlordId])
    const pick = async (where: string) => (await db.query<{ source_id: string }>(
      `SELECT h.source_id FROM held_payout_items h WHERE ${where} ORDER BY h.source_id`)).rows.map(r => r.source_id)
    expect(await pick(disputeShareLineSql('h'))).toEqual(
      ['owner_share_returned:r3', 'owner_share_untouched:r1', 'owner_share_withheld:r2'])
    expect(await pick(disputeFeeLineSql('h'))).toEqual([`stripe_fee_kept:pi_x:${landlordId}`])
    // What is left of 'dispute' is the chargeback alone.
    expect(await pick(`h.source_type = 'dispute' AND NOT ${disputeShareLineSql('h')} AND NOT ${disputeFeeLineSql('h')}`))
      .toEqual(['du_register_chargeback'])
  })
})
