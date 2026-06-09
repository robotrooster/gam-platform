/**
 * Deposit-return workflow tests.
 *
 * Workflow-only — no real money movement. The Stripe Transfer +
 * gap-charge paths are exercised in their "no credentials on file"
 * fallback branches:
 *   - landlord disbursement: leave `stripe_connect_account_id` NULL
 *     on the landlord user → fireLandlordDisbursementTransfer
 *     short-circuits to an admin notification before any Stripe call.
 *   - gap auto-charge: leave `stripe_customer_id` NULL on the tenant
 *     → attemptGapAutoCharge short-circuits to gap_charge_failed=TRUE
 *     before importing the Stripe SDK.
 * Both branches let us pin the surrounding workflow (status flips,
 * payment-row creation, credit-event emission, admin notifications,
 * unpaid-balance sweep) without needing a Stripe mock.
 *
 * `calculateDepositReturn` and `finalizeDepositReturn` both use the
 * singleton `db` pool internally — per-test BEGIN/ROLLBACK on a
 * separate client wouldn't be visible to them. Each test uses a
 * try/finally pattern with explicit cleanup at the end. Suite-level
 * fixtures (allocation rates, etc.) don't apply here — every test
 * starts from an empty schema.
 */

import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  calculateDepositReturn,
  finalizeDepositReturn,
} from './depositReturn'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedLeaseFee,
  seedSecurityDeposit, seedDepositReturnDraft,
  seedRentPayment,
} from '../test/dbHelpers'

// Pool lifecycle: don't end the singleton in afterAll. Multiple test
// files share the same process under vitest singleFork — whichever
// file ran first would otherwise close the pool out from under the
// rest. The process exit handles teardown.

beforeEach(cleanupAllSchema)

interface LeaseStack {
  ownerUserId: string
  landlordId: string
  tenantId: string
  propertyId: string
  unitId: string
  leaseId: string
  depositId: string
}

async function buildLeaseStack(
  opts: {
    depositTotal?: number
    depositCollected?: number
    interestAccrued?: number
    cleaningFeeAmount?: number
    heldBy?: 'gam_escrow' | 'landlord'
  } = {}
): Promise<LeaseStack> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    const unitId = await seedUnit(client, {
      propertyId, landlordId, rentAmount: 1000,
    })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    if (opts.cleaningFeeAmount) {
      await seedLeaseFee(client, {
        leaseId, feeType: 'cleaning_fee',
        amount: opts.cleaningFeeAmount, dueTiming: 'move_out',
      })
    }
    const depositId = await seedSecurityDeposit(client, {
      unitId, leaseId, tenantId,
      totalAmount: opts.depositTotal ?? 500,
      collectedAmount: opts.depositCollected ?? opts.depositTotal ?? 500,
      interestAccrued: opts.interestAccrued ?? 0,
      heldBy: opts.heldBy ?? 'gam_escrow',
    })
    return {
      ownerUserId, landlordId, tenantId,
      propertyId, unitId, leaseId, depositId,
    }
  } finally {
    client.release()
  }
}

async function makeDraft(stack: LeaseStack, opts: {
  totalDeposit: number
  cleaningFeeAmount?: number
  totalDeductions?: number
  refundAmount?: number
  gapAmount?: number
}): Promise<string> {
  const client = await getClient()
  try {
    return await seedDepositReturnDraft(client, {
      leaseId: stack.leaseId,
      tenantId: stack.tenantId,
      landlordId: stack.landlordId,
      securityDepositId: stack.depositId,
      ...opts,
    })
  } finally {
    client.release()
  }
}

describe('calculateDepositReturn', () => {
  it('full refund: no deductions → refund = full deposit, gap = 0', async () => {
    await buildLeaseStack({ depositTotal: 500 })
    const lease = await db.query<{ id: string }>(`SELECT id FROM leases LIMIT 1`)
    const calc = await calculateDepositReturn(lease.rows[0].id)
    expect(calc).not.toBeNull()
    expect(calc!.total_deposit).toBe(500)
    expect(calc!.total_deductions).toBe(0)
    expect(calc!.refund_amount).toBe(500)
    expect(calc!.gap_amount).toBe(0)
  })

  it('partial refund: cleaning + damage subtract from deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, cleaningFeeAmount: 100 })
    const calc = await calculateDepositReturn(
      stack.leaseId,
      [{ description: 'wall hole', amount: 50 }],
    )
    expect(calc!.cleaning_fee_amount).toBe(100)
    expect(calc!.damage_lines_total).toBe(50)
    expect(calc!.total_deductions).toBe(150)
    expect(calc!.refund_amount).toBe(350)
    expect(calc!.gap_amount).toBe(0)
  })

  it('gap: deductions exceed deposit → refund 0, gap = excess', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, cleaningFeeAmount: 500 })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.total_deductions).toBe(500)
    expect(calc!.refund_amount).toBe(0)
    expect(calc!.gap_amount).toBe(200)
  })

  it('S188 interest_accrued: added to tenant pool, increases refund', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, interestAccrued: 12.34 })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.interest_accrued).toBe(12.34)
    // tenant pool = 500 + 12.34 = 512.34, no deductions → refund 512.34
    expect(calc!.refund_amount).toBe(512.34)
  })

  it('S180 auto-sweep: unpaid rent payment rolls into total_deductions', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    const client = await getClient()
    try {
      const paymentId = await seedRentPayment(client, {
        unitId: stack.unitId,
        tenantId: stack.tenantId,
        landlordId: stack.landlordId,
        amount: 200,
        status: 'failed',
      })
      await client.query(
        `UPDATE payments SET lease_id=$1 WHERE id=$2`,
        [stack.leaseId, paymentId],
      )
    } finally {
      client.release()
    }
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.unpaid_balance_total).toBe(200)
    expect(calc!.unpaid_balance_lines).toHaveLength(1)
    expect(calc!.total_deductions).toBe(200)
    expect(calc!.refund_amount).toBe(300)
  })

  it('S262 deposit pool: uses collected_amount, not total_amount', async () => {
    // FlexDeposit-style: promised 500, only 400 collected (one
    // installment missed). Deposit pool is the actual escrow balance.
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 400 })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.total_deposit).toBe(400)
    expect(calc!.refund_amount).toBe(400)
  })

  it('returns null for unknown lease', async () => {
    const calc = await calculateDepositReturn(randomUUID())
    expect(calc).toBeNull()
  })
})

describe('finalizeDepositReturn — workflow', () => {
  it('partial refund branch: status → sent_refund, negative-amount DEPOSIT payment row, admin notification fired for landlord with no Connect', async () => {
    // Deposit collected 500, cleaning 100 → refund 400 to tenant.
    // Landlord disbursement = collected (500) - refund (400) = 100.
    // No Connect account → admin notification fires for the landlord cut.
    const stack = await buildLeaseStack({
      depositTotal: 500, cleaningFeeAmount: 100,
    })
    const draftId = await makeDraft(stack, {
      totalDeposit: 500, cleaningFeeAmount: 100,
      totalDeductions: 100, refundAmount: 400, gapAmount: 0,
    })

    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')
    expect(final.refund_payment_id).not.toBeNull()
    expect(final.gap_payment_id).toBeNull()

    const refundPayment = await db.query(
      `SELECT amount::text AS amount, entry_description, status
         FROM payments WHERE id=$1`,
      [final.refund_payment_id]
    )
    expect(refundPayment.rows[0]).toMatchObject({
      amount: '-400.00',
      entry_description: 'DEPOSIT',
      status: 'pending',
    })

    const adminNotifs = await db.query(
      `SELECT category FROM admin_notifications
        WHERE category='deposit_disbursement_pending_no_connect'`
    )
    expect(adminNotifs.rows).toHaveLength(1)

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_ref_id=$1`,
      [stack.tenantId]
    )
    expect(events.rows.map(r => r.event_type))
      .toContain('deposit_returned_partial')
  })

  it('full refund branch: deposit fully refunded → landlord disbursement = 0 → no Connect notification', async () => {
    // Edge case: no deductions, landlord owes the tenant everything.
    // Disbursement = collected (500) - refund (500) = 0 → fireLandlord
    // returns before checking the Connect account.
    const stack = await buildLeaseStack({ depositTotal: 500 })
    const draftId = await makeDraft(stack, {
      totalDeposit: 500, refundAmount: 500, gapAmount: 0,
    })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')

    const notifs = await db.query(
      `SELECT category FROM admin_notifications
        WHERE category='deposit_disbursement_pending_no_connect'`
    )
    expect(notifs.rows).toHaveLength(0)

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_ref_id=$1`,
      [stack.tenantId]
    )
    expect(events.rows.map(r => r.event_type))
      .toContain('deposit_returned_full')
  })

  it('gap branch: status → sent_gap, positive-amount payment row, gap_charge_failed=TRUE for missing Stripe customer', async () => {
    const stack = await buildLeaseStack({
      depositTotal: 300, cleaningFeeAmount: 500,
    })
    const draftId = await makeDraft(stack, {
      totalDeposit: 300, cleaningFeeAmount: 500,
      totalDeductions: 500, refundAmount: 0, gapAmount: 200,
    })

    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_gap')
    expect(final.refund_payment_id).toBeNull()
    expect(final.gap_payment_id).not.toBeNull()
    expect(Number(final.gap_amount)).toBe(200)

    const gapPayment = await db.query(
      `SELECT amount::text AS amount, entry_description, status
         FROM payments WHERE id=$1`,
      [final.gap_payment_id]
    )
    expect(gapPayment.rows[0]).toMatchObject({
      amount: '200.00',
      entry_description: 'DEPOSIT',
      status: 'pending',
    })

    // Post-commit gap charge fired → no stripe_customer_id → marked failed.
    const refetch = await db.query(
      `SELECT gap_charge_failed, gap_charge_failure_reason
         FROM deposit_returns WHERE id=$1`,
      [draftId]
    )
    expect(refetch.rows[0].gap_charge_failed).toBe(true)
    expect(refetch.rows[0].gap_charge_failure_reason).toMatch(/no stripe customer/i)

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_ref_id=$1`,
      [stack.tenantId]
    )
    const types = events.rows.map(r => r.event_type)
    expect(types).toContain('deposit_returned_zero')
    expect(types).toContain('tenancy_ended_with_balance')
  })

  it('zero branch: deposit exactly equals deductions → sent_zero, no payment rows', async () => {
    const stack = await buildLeaseStack({
      depositTotal: 300, cleaningFeeAmount: 300,
    })
    const draftId = await makeDraft(stack, {
      totalDeposit: 300, cleaningFeeAmount: 300,
      totalDeductions: 300, refundAmount: 0, gapAmount: 0,
    })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_zero')
    expect(final.refund_payment_id).toBeNull()
    expect(final.gap_payment_id).toBeNull()

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_ref_id=$1`,
      [stack.tenantId]
    )
    expect(events.rows.map(r => r.event_type))
      .toContain('deposit_returned_zero')
  })

  it('S180 sweep: unpaid payment flips to paid_via_deposit and re-pulled at finalize', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    const client = await getClient()
    try {
      const unpaidPayId = await seedRentPayment(client, {
        unitId: stack.unitId,
        tenantId: stack.tenantId,
        landlordId: stack.landlordId,
        amount: 150,
        status: 'failed',
      })
      await client.query(
        `UPDATE payments SET lease_id=$1 WHERE id=$2`,
        [stack.leaseId, unpaidPayId],
      )
    } finally {
      client.release()
    }
    // Draft was created before the unpaid row was seeded (zero
    // unpaid_balance_amount snapshot). finalize re-pulls live and
    // recomputes.
    const draftId = await makeDraft(stack, {
      totalDeposit: 500, refundAmount: 500, gapAmount: 0,
    })

    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')
    expect(Number(final.unpaid_balance_amount)).toBe(150)
    expect(Number(final.refund_amount)).toBe(350)

    const sweptRows = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE lease_id=$1 AND type='rent'`,
      [stack.leaseId]
    )
    expect(sweptRows.rows[0].status).toBe('paid_via_deposit')
  })

  it('rejects re-finalize on already-finalized draft', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    const draftId = await makeDraft(stack, {
      totalDeposit: 500, refundAmount: 500, gapAmount: 0,
    })
    await finalizeDepositReturn(draftId, stack.ownerUserId)
    await expect(finalizeDepositReturn(draftId, stack.ownerUserId))
      .rejects.toThrow(/already finalized/i)
  })

  it('held_by=landlord skips landlord-disbursement notification (legacy escrow path)', async () => {
    // Pre-S260 leases have held_by=landlord — landlord already has the
    // money. fireLandlordDisbursementTransfer returns early without
    // logging a notification.
    const stack = await buildLeaseStack({
      depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 100,
    })
    const draftId = await makeDraft(stack, {
      totalDeposit: 500, cleaningFeeAmount: 100,
      totalDeductions: 100, refundAmount: 400, gapAmount: 0,
    })
    await finalizeDepositReturn(draftId, stack.ownerUserId)
    const notifs = await db.query(
      `SELECT category FROM admin_notifications
        WHERE category='deposit_disbursement_pending_no_connect'`
    )
    expect(notifs.rows).toHaveLength(0)
  })
})
