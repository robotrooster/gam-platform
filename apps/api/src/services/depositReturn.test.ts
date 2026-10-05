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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// S655: the move-out balance is charged as GAM's platform charge, made
// unconfirmed, saved, then confirmed (attemptGapAutoCharge); the escrow
// settlement goes out as a transfer. Both are mocked; nothing reaches Stripe.
// Tests that leave the tenant with no Stripe customer and the landlord with no
// Connect account never call either, exactly as before.
const stripeMocks = vi.hoisted(() => {
  const made: any[] = []
  const lastMadeMetadata = () => made[made.length - 1]?.metadata ?? {}
  return {
  made,
  customersRetrieve: vi.fn(async (id: string): Promise<any> => ({ id, invoice_settings: { default_payment_method: 'pm_default' } })),
  paymentMethodsRetrieve: vi.fn(async (id: string): Promise<any> => ({ id, type: 'card', card: { country: 'US' } })),
  paymentIntentsCreate: vi.fn(async (params: any, _opts?: any): Promise<any> => {
    made.push(params)
    return { id: 'pi_gap_test', status: 'requires_confirmation', payment_method_types: params.payment_method_types }
  }),
  paymentIntentsConfirm: vi.fn(async (id: string, _params?: any, _opts?: any): Promise<any> => ({ id, status: 'succeeded' })),
  // Echoes the metadata the move-out balance charge was made with (its own intent).
  paymentIntentsRetrieve: vi.fn(async (id: string): Promise<any> => ({
    id, status: 'succeeded', payment_method_types: ['card'], metadata: lastMadeMetadata() })),
  paymentIntentsCancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
  transfersCreate: vi.fn(async (..._args: any[]) => ({ id: 'tr_test' })),
  }
})
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getStripe: () => ({
      customers: { retrieve: stripeMocks.customersRetrieve },
      paymentMethods: { retrieve: stripeMocks.paymentMethodsRetrieve },
      paymentIntents: {
        create: stripeMocks.paymentIntentsCreate,
        confirm: stripeMocks.paymentIntentsConfirm,
        retrieve: stripeMocks.paymentIntentsRetrieve,
        cancel: stripeMocks.paymentIntentsCancel,
      },
      transfers: { create: stripeMocks.transfersCreate },
    }),
  }
})

// Step 9 review (fix pass 2): the payment webhook (routes/webhooks.ts) is
// driven for real by one test below; it builds its own Stripe client from the
// 'stripe' package, so that package is a small fake here — the signature check
// reads the body as the event, and the charge lookups the settle makes answer
// from these mocks. Nothing reaches Stripe.
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.webhooks = {
      constructEvent: (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8')),
    }
    this.balanceTransactions = { retrieve: async () => ({ fee: 0 }) }
    this.charges = { retrieve: async (id: string) => ({ id }) }
    this.customers = { retrieve: stripeMocks.customersRetrieve }
    this.paymentMethods = { retrieve: stripeMocks.paymentMethodsRetrieve }
    this.paymentIntents = {
      create: stripeMocks.paymentIntentsCreate, confirm: stripeMocks.paymentIntentsConfirm,
      retrieve: stripeMocks.paymentIntentsRetrieve, cancel: stripeMocks.paymentIntentsCancel,
    }
    this.transfers = { create: stripeMocks.transfersCreate }
  }
  return { default: FakeStripe }
})

import { db, getClient } from '../db'
import {
  calculateDepositReturn,
  finalizeDepositReturn,
  createOrFetchDraft,
  attemptGapAutoCharge,
  finishPendingGapCharges,
  GAP_CHARGE_REASON,
} from './depositReturn'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedLeaseFee,
  seedSecurityDeposit, seedDepositReturnDraft,
  seedRentPayment, seedUtilityMeter, seedUtilityBill,
  seedAllocationRule,
} from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'

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

  it('S548 final utilities: uninvoiced meter-read bills deduct from the deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 150 })
    const client = await getClient()
    try {
      const meterId = await seedUtilityMeter(client, { propertyId: stack.propertyId, utilityType: 'electric' })
      // Final read billed 87.50, never attached to an invoice (guest left).
      await seedUtilityBill(client, {
        meterId, unitId: stack.unitId, tenantId: stack.tenantId,
        leaseId: stack.leaseId, landlordId: stack.landlordId,
        chargeAmount: 87.50, status: 'billed', utilityType: 'electric',
      })
    } finally { client.release() }
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.final_utility_total).toBe(87.50)
    expect(calc!.total_deductions).toBe(87.50)
    // $150 monthly-stay deposit − final electric = $62.50 back to the guest.
    expect(calc!.refund_amount).toBe(62.50)
  })

  // Was 'S548 prepaid credit: paid-ahead money pays the deductions first; what
  // is left is not refunded with the deposit' — decision #46.2 (Nic, 10/4,
  // FINAL) turned the order round: the deposit pays first.
  it('#46.2: the deposit pays the deductions first; paid-ahead money pays only what the deposit cannot, and what is left of it is never refunded with the deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    // Long-stay guest overpaid by 348.33 (schedule sync banked it) and the
    // final invoices only netted part — 100 remains at lease end. The credit is
    // seeded already part-spent, the way the money-history backfill records
    // history (gam.credit_backfill), so this also holds with the C0 ledger
    // guards on (a new credit otherwise starts whole).
    const seed = await db.connect()
    try {
      await seed.query('BEGIN')
      await seed.query(`SET LOCAL gam.credit_backfill = 'on'`)
      await seed.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
         VALUES ($1, $2, 348.33, 100)`, [stack.leaseId, stack.tenantId])
      await seed.query('COMMIT')
    } catch (e) { await seed.query('ROLLBACK'); throw e } finally { seed.release() }
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.prepaid_credit_remaining).toBe(100)
    // No deductions: the deposit comes back whole, and the $100 stays paid
    // ahead for the landlord's choice (decisions #38 Q8, #46.1) — never refunded here.
    expect(calc!.refund_amount).toBe(500)
    expect(calc!.prepaid_credit_used).toBe(0)
    expect(calc!.prepaid_credit_left).toBe(100)
    // A $30 damage line comes out of the deposit; the paid-ahead money is untouched.
    const withDamage = await calculateDepositReturn(stack.leaseId, [{ description: 'scuffs', amount: 30 }])
    expect(withDamage!.refund_amount).toBe(470)
    expect(withDamage!.prepaid_credit_used).toBe(0)
    expect(withDamage!.prepaid_credit_left).toBe(100)
    // Only what the deposit cannot cover comes out of the paid-ahead money.
    const big = await calculateDepositReturn(stack.leaseId, [{ description: 'carpet', amount: 550 }])
    expect(big!.refund_amount).toBe(0)
    expect(big!.prepaid_credit_used).toBe(50)
    expect(big!.prepaid_credit_left).toBe(50)
    expect(big!.gap_amount).toBe(0)
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
  it('S548 end-of-stay: finalize settles final utility bills from the deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 150 })
    let billId: string
    const client = await getClient()
    try {
      const meterId = await seedUtilityMeter(client, { propertyId: stack.propertyId, utilityType: 'electric' })
      billId = await seedUtilityBill(client, {
        meterId, unitId: stack.unitId, tenantId: stack.tenantId,
        leaseId: stack.leaseId, landlordId: stack.landlordId,
        chargeAmount: 87.50, status: 'billed', utilityType: 'electric',
      })
    } finally { client.release() }
    const draftId = await makeDraft(stack, { totalDeposit: 150 })

    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    // Live math: 150 pool − 87.50 final electric = 62.50 refund.
    expect(final.status).toBe('sent_refund')
    expect(Number(final.refund_amount)).toBe(62.50)

    const bill = await db.query<any>(
      `SELECT status, payment_id FROM utility_bills WHERE id=$1`, [billId!])
    expect(bill.rows[0].status).toBe('paid')
    expect(bill.rows[0].payment_id).not.toBeNull()
    const pay = await db.query<any>(
      `SELECT type, status, amount::numeric AS a FROM payments WHERE id=$1`, [bill.rows[0].payment_id])
    expect(pay.rows[0]).toMatchObject({ type: 'utility', status: 'paid_via_deposit' })
    expect(Number(pay.rows[0].a)).toBe(87.50)
  })

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
    expect(refetch.rows[0].gap_charge_failure_reason).toBe(GAP_CHARGE_REASON.noMethod)

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

// ─── S550: conditional fees never auto-sweep until assessed FAILED ──

// S654: the rows finalize writes were due CURRENT_DATE — the database's day,
// not the park's. A park in a zone far from the server's (Kiritimati is a day
// ahead of Phoenix most of the day) shows the difference.
describe("S654 finalize dates its rows on the property's calendar", () => {
  const TZ = 'Pacific/Kiritimati'

  it('final utility settlement and the refund row are due the property\'s today', async () => {
    const stack = await buildLeaseStack({ depositTotal: 150 })
    await db.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [stack.propertyId, TZ])
    let billId: string
    const client = await getClient()
    try {
      const meterId = await seedUtilityMeter(client, { propertyId: stack.propertyId, utilityType: 'electric' })
      billId = await seedUtilityBill(client, {
        meterId, unitId: stack.unitId, tenantId: stack.tenantId,
        leaseId: stack.leaseId, landlordId: stack.landlordId,
        chargeAmount: 87.50, status: 'billed', utilityType: 'electric',
      })
    } finally { client.release() }
    const draftId = await makeDraft(stack, { totalDeposit: 150 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')

    const rows = await db.query<{ type: string; due: string }>(
      `SELECT type, due_date::text AS due FROM payments
        WHERE id IN ((SELECT payment_id FROM utility_bills WHERE id = $1), $2)
        ORDER BY type`,
      [billId!, final.refund_payment_id])
    expect(rows.rows).toEqual([
      { type: 'fee', due: todayIn(TZ) },
      { type: 'utility', due: todayIn(TZ) },
    ])
  })

  it('a move-out balance is due the property\'s today', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, cleaningFeeAmount: 500 })
    await db.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [stack.propertyId, TZ])
    const draftId = await makeDraft(stack, {
      totalDeposit: 300, cleaningFeeAmount: 500,
      totalDeductions: 500, refundAmount: 0, gapAmount: 200,
    })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_gap')
    const gap = await db.query<{ due: string }>(
      `SELECT due_date::text AS due FROM payments WHERE id = $1`, [final.gap_payment_id])
    expect(gap.rows[0].due).toBe(todayIn(TZ))
  })
})

describe('S550 — conditional lease fees in the sweep', () => {
  async function addConditionalFee(leaseId: string, amount: number, result: string | null) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO lease_fees
         (lease_id, fee_type, amount, due_timing, is_refundable, description, condition_text, condition_result)
       VALUES ($1, 'other_fee', $2, 'move_out', FALSE, 'Carpet cleaning',
               'Carpets professionally cleaned within 3 days of move-out, else this charge applies.', $3)
       RETURNING id`,
      [leaseId, amount, result],
    )
    return r.rows[0].id
  }

  it('unassessed conditional fee does NOT sum into the deduction', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    await addConditionalFee(stack.leaseId, 150, null)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.cleaning_fee_amount).toBe(0)
  })

  it('condition met = no charge; condition FAILED = the fee sweeps', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, cleaningFeeAmount: 100 })
    await addConditionalFee(stack.leaseId, 150, 'met')
    let calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.cleaning_fee_amount).toBe(100) // unconditional fee only

    await addConditionalFee(stack.leaseId, 75, 'failed')
    calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.cleaning_fee_amount).toBe(175) // + only the FAILED one
  })
})

/**
 * S609 (Nic): "We need to set it where any future installments preset for
 * propane become due in full on a final bill at a move out. That's the only
 * place where acceleration would still be needed."
 *
 * The opposite case from the acceleration that was REMOVED. Accelerating on a
 * new fill punished a tenant still living there and paying on schedule;
 * accelerating at move-out collects propane already delivered and burned, from
 * the person who used it. There is no future invoice left to put it on.
 */
describe('S609 remaining propane comes due at move-out', () => {
  async function fillWithSchedule(f: LeaseStack, gallons: number, installments: number) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const fill = await c.query<{ id: string }>(
        `INSERT INTO propane_fills
           (property_id, landlord_id, unit_id, lease_id, tenant_id, gallons,
            price_per_gallon, total_amount, installment_count, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,3,$7,$8,$9) RETURNING id`,
        [f.propertyId, f.landlordId, f.unitId, f.leaseId, f.tenantId,
         gallons, gallons * 3, installments, f.ownerUserId])
      const per = Math.round((gallons * 3 / installments) * 100) / 100
      for (let i = 0; i < installments; i++) {
        await c.query(
          `INSERT INTO propane_fill_installments
             (fill_id, installment_number, amount, gallons, billing_cycle_month, payment_id)
           VALUES ($1,$2,$3,$4, (date_trunc('month', CURRENT_DATE) + make_interval(months => $5::int))::date, NULL)`,
          [fill.rows[0].id, i + 1, per, gallons / installments, i + 1])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('turns every unbilled installment into a charge on the final bill', async () => {
    const f = await buildLeaseStack()
    await fillWithSchedule(f, 120, 4)          // $360 over four months, none billed

    // Before: nothing payable — they are future charges, like next month's rent.
    const before = await db.query(
      `SELECT id FROM payments WHERE lease_id=$1 AND entry_description='PROPANE'`, [f.leaseId])
    expect(before.rows).toHaveLength(0)

    await createOrFetchDraft(f.leaseId)

    const after = await db.query<any>(
      `SELECT amount FROM payments WHERE lease_id=$1 AND entry_description='PROPANE'`, [f.leaseId])
    expect(after.rows).toHaveLength(4)
    expect(after.rows.reduce((s: number, r: any) => s + Number(r.amount), 0)).toBeCloseTo(360, 2)

    // And every installment now points at its charge — none left unbilled.
    const unbilled = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM propane_fill_installments i
         JOIN propane_fills fl ON fl.id = i.fill_id
        WHERE fl.lease_id = $1 AND i.payment_id IS NULL`, [f.leaseId])
    expect(unbilled.rows[0].n).toBe(0)
  })

  it('re-opening the draft does not charge twice', async () => {
    const f = await buildLeaseStack()
    await fillWithSchedule(f, 120, 4)
    await createOrFetchDraft(f.leaseId)
    await createOrFetchDraft(f.leaseId)
    const after = await db.query(
      `SELECT id FROM payments WHERE lease_id=$1 AND entry_description='PROPANE'`, [f.leaseId])
    expect(after.rows).toHaveLength(4)
  })
})

// ─── S655 (money plan §3, Move-out; Step 9) ─────────────────────────────────

async function paidAhead(stack: LeaseStack, amount: number, o: { fundedBy?: 'landlord' | 'gam' | 'reclassified'; voided?: boolean } = {}) {
  return (await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits
       (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, voided_at, void_reason)
     VALUES ($1,$2,$3,$3,$4,NOW(), CASE WHEN $5 THEN NOW() END, CASE WHEN $5 THEN 'withdrawn in a test' END)
     RETURNING id`,
    [stack.leaseId, stack.tenantId, amount.toFixed(2), o.fundedBy ?? 'landlord', o.voided === true])).rows[0].id
}

async function openLine(stack: LeaseStack, o: { amount: number; status?: string; intent?: string | null; workTrade?: boolean; retryAt?: boolean; entry?: string; type?: string; owner?: string }) {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           revenue_owner, stripe_payment_intent_id, work_trade_suspended_at, next_retry_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE - 5,$8,$9,$10,
             CASE WHEN $11 THEN NOW() END, CASE WHEN $12 THEN NOW() + interval '2 days' END) RETURNING id`,
    [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, o.type ?? 'rent', o.amount.toFixed(2),
     o.status ?? 'pending', o.entry ?? 'RENT', o.owner ?? 'landlord', o.intent ?? null,
     o.workTrade === true, o.retryAt === true])).rows[0].id
}

describe('S655: move-out pools paid-ahead money through the credit ledger', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('move-out pools paid-ahead money as credit uses; voided credit stays out', async () => {
    // 10/4 (#46.2): a $610 cleaning fee on a $500 deposit — the deposit pays
    // $500 of it, the paid-ahead money only the $110 it cannot.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 610 })
    const a = await paidAhead(stack, 100)
    const c = await paidAhead(stack, 30, { fundedBy: 'reclassified' })
    const voided = await paidAhead(stack, 50, { voided: true })

    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.prepaid_credit_remaining).toBe(130)
    expect(calc!.prepaid_credit_used).toBe(110)

    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 610 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    // The deposit is used up; $110 of the paid-ahead money pays the rest
    // (oldest first); nothing is owed and nothing refunded.
    expect(Number(final.refund_amount)).toBe(0)
    expect(Number(final.gap_amount)).toBe(0)

    const uses = (await db.query(
      `SELECT prepaid_credit_id, amount::float AS amount, source, status, deposit_return_id
         FROM credit_uses ORDER BY amount DESC`)).rows
    expect(uses).toEqual([
      { prepaid_credit_id: a, amount: 100, source: 'move_out', status: 'applied', deposit_return_id: draftId },
      { prepaid_credit_id: c, amount: 10, source: 'move_out', status: 'applied', deposit_return_id: draftId },
    ])
    const left = (await db.query(
      `SELECT id, amount_remaining::float AS r FROM lease_prepaid_credits`)).rows
    expect(Object.fromEntries(left.map((x: any) => [x.id, x.r]))).toEqual({ [a]: 0, [c]: 20, [voided]: 50 })
  })

  it('paid-ahead money the deductions do not take stays paid ahead for the landlord’s refund choice — never refunded with the deposit — and GAM is told once', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const credit = await paidAhead(stack, 300, { fundedBy: 'reclassified' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 40 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')
    // 10/4 (#46.2): the deposit pays the $40 cleaning; all $300 paid ahead is left.
    expect(Number(final.refund_amount)).toBe(460)
    // The refund row is the deposit only — none of the paid-ahead money.
    const refundRow = (await db.query(`SELECT amount::float AS amount FROM payments WHERE id=$1`, [final.refund_payment_id])).rows[0]
    expect(refundRow.amount).toBe(-460)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(300)
    // Nothing GAM held was released to the landlord for the $300 still waiting.
    expect(await heldItems()).toEqual([])
    const told = (await db.query(
      `SELECT body, context FROM admin_notifications WHERE category='deposit_return_paid_ahead_left'`)).rows
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ deposit_return_id: draftId, amount: 300 })
    expect(told[0].body).toMatch(/\$300\.00 the tenant paid ahead .* not refunded with the deposit: the landlord decides/)
    // 10/4 (decisions #46.1): the notice points at the landlord's one screen for it.
    expect(told[0].body).toMatch(/No refund, Refund all of it, or Refund a different amount, then for anything not refunded, Keep it or Leave it as their credit/)
    expect(told[0].body).toContain(`/leases/${stack.leaseId}/paid-ahead-choice`)
  })

  // Fix pass 3: a long stay's early check-out banks rent paid past the day they
  // left (STAY_SHORTENED_CREDIT_NOTE) and asks the landlord the refund question.
  async function checkOutCredit(stack: LeaseStack, amount: number) {
    const { STAY_SHORTENED_CREDIT_NOTE } = await import('./bookingLeaseBilling')
    return (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits
         (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, note, created_at)
       VALUES ($1,$2,$3,$3,'reclassified',NOW(),$4, NOW() - interval '1 day') RETURNING id`,
      [stack.leaseId, stack.tenantId, amount.toFixed(2), STAY_SHORTENED_CREDIT_NOTE])).rows[0].id
  }
  async function checkOutQuestion(stack: LeaseStack, o: { status: 'pending' | 'decided'; choice?: string }) {
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, nights, lease_type, nightly_rate, total_amount, status)
       VALUES ($1,$2,'Long Stay',CURRENT_DATE - 40, CURRENT_DATE - 10, 30, 'long_term', 0, 1000, 'checked_out') RETURNING id`,
      [stack.unitId, stack.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO stay_checkout_decisions
         (booking_id, landlord_id, lease_id, left_on, question, choice, status, booked_price, stayed_worth, paid, price_after, decided_at)
       VALUES ($1,$2,$3,CURRENT_DATE - 10,'overpaid',$4,$5,1000,700,1000,
               CASE WHEN $5 = 'decided' THEN 1000 END, CASE WHEN $5 = 'decided' THEN NOW() END)`,
      [booking, stack.landlordId, stack.leaseId, o.choice ?? null, o.status])
  }
  const paidAheadNotes = async () => (await db.query(
    `SELECT title, body, context FROM admin_notifications WHERE category='deposit_return_paid_ahead_left' ORDER BY created_at`)).rows

  it('paid-ahead money the landlord already answered at an early check-out ("No refund") is not put back to them as "the landlord decides" — GAM is told their choice', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const credit = await checkOutCredit(stack, 300)
    await checkOutQuestion(stack, { status: 'decided', choice: 'no_refund' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 40 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    // 10/4 (#46.2): the deposit pays the cleaning; the $300 is untouched.
    expect(Number(final.refund_amount)).toBe(460)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(300)
    const told = await paidAheadNotes()
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ deposit_return_id: draftId, amount: 300, early_checkout: 'decided' })
    expect(told[0].body).toMatch(/already chose “No refund \(keep the price as booked\)”/)
    expect(told[0].body).not.toMatch(/the landlord decides/)
  })

  it('"No refund" at a long stay\'s check-out leaves the rest the tenant\'s money paid ahead until the landlord chooses Keep it or Leave it as their credit on the paid-ahead money screen — never called the landlord\'s', async () => {
    // Was: "...it pays the move-out bill before the deposit..." (fix pass 4).
    // 10/4 (decisions #46.1): after "No refund" the LANDLORD chooses what
    // happens to it — Keep it, or Leave it as their credit — on one screen; the
    // notice says so and links there. Which pays the move-out bill first is
    // the move-out's own rule (decisions #46.2), not this notice's.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const credit = await checkOutCredit(stack, 300)
    await checkOutQuestion(stack, { status: 'decided', choice: 'no_refund' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 40 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    // 10/4 (#46.2): the deposit pays the $40 cleaning; none of the $300 is spent.
    expect(Number(final.refund_amount)).toBe(460)
    const uses = (await db.query(
      `SELECT prepaid_credit_id, amount::float AS amount, source, deposit_return_id FROM credit_uses`)).rows
    expect(uses).toEqual([])
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(300)
    const told = await paidAheadNotes()
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/They still choose what happens to it — Keep it, or Leave it as their credit/)
    expect(told[0].body).toContain(`/leases/${stack.leaseId}/paid-ahead-choice`)
    expect(told[0].body).toMatch(/still the tenant’s money paid ahead/)
    expect(told[0].body).not.toMatch(/landlord’s/)
  })

  it('paid-ahead money whose early check-out question is still waiting gets no second notice; other paid-ahead money left is still told', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const fromCheckOut = await checkOutCredit(stack, 300)   // the deposit pays the $40 cleaning (#46.2)
    const other = await paidAhead(stack, 100)
    await checkOutQuestion(stack, { status: 'pending' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 40 })
    await finalizeDepositReturn(draftId, stack.ownerUserId)
    const left = (await db.query(`SELECT id, amount_remaining::float AS r FROM lease_prepaid_credits`)).rows
    expect(Object.fromEntries(left.map((x: any) => [x.id, x.r]))).toEqual({ [fromCheckOut]: 300, [other]: 100 })
    const told = await paidAheadNotes()
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ amount: 100, early_checkout: null })
    expect(told[0].body).toMatch(/\$100\.00 the tenant paid ahead .* the landlord decides/)
  })

  it('finalize is refused while a payment holds credit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const credit = await paidAhead(stack, 100)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,950,950,'ach','pi_clearing_with_credit') RETURNING id`,
      [stack.tenantId, stack.leaseId, stack.landlordId])).rows[0].id
    const rent = await openLine(stack, { amount: 1000, status: 'processing', intent: 'pi_clearing_with_credit' })
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,50,date_trunc('month', CURRENT_DATE)::date,'portal','held')`,
      [credit, rent, rem, stack.leaseId])

    const draftId = await makeDraft(stack, { totalDeposit: 500 })
    await expect(finalizeDepositReturn(draftId, stack.ownerUserId))
      .rejects.toThrow(/still clearing with account credit set aside/)
    const d = (await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draftId])).rows[0]
    expect(d.status).toBe('draft')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses WHERE source='move_out'`)).rows[0].n).toBe(0)
  })

  it('landlord-held deposit: GAM-held paid-ahead is released to the landlord even when deductions take it all', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 900 })
    await paidAhead(stack, 200, { fundedBy: 'gam' })
    await paidAhead(stack, 40, { fundedBy: 'landlord' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 900 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_gap')
    expect(Number(final.gap_amount)).toBe(160)                  // 900 − (500 + 200 + 40)

    const items = (await db.query(
      `SELECT h.landlord_id, h.source_type, h.amount::float AS amount, u.prepaid_credit_id IS NOT NULL AS is_use
         FROM held_payout_items h LEFT JOIN credit_uses u ON u.id::text = h.source_id`)).rows
    // Only the money GAM held — the landlord already holds the $40 they took.
    expect(items).toEqual([{ landlord_id: stack.landlordId, source_type: 'prepaid_draw', amount: 200, is_use: true }])
  })

  // Was 'GAM escrow: landlord-held paid-ahead larger than the deductions pays
  // them, the rest stays paid ahead, and GAM pays back only the deposit it
  // held' — under #46.2 the deposit pays the deductions, so none of the
  // paid-ahead money is spent at all.
  it('GAM escrow with $800 paid ahead to the landlord: the deposit pays the $100 cleaning, all $800 stays paid ahead, GAM refunds the $400 left of what it holds and sends the landlord the $100 it kept', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 100 })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    const credit = await paidAhead(stack, 800, { fundedBy: 'landlord' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 100 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(400)
    expect(Number((final as any).refund_from_gam)).toBe(400)
    expect(Number((final as any).refund_from_landlord)).toBe(0)
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect((stripeMocks.transfersCreate.mock.calls[0] as [any])[0]).toMatchObject({ amount: 10000 })
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(800)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses`)).rows[0].n).toBe(0)
  })

  it('GAM escrow: GAM-held paid-ahead money that paid what the deposit could not rides the landlord’s settlement transfer', async () => {
    // #46.2: a $600 cleaning on a $500 deposit — the deposit pays $500, the
    // $100 paid ahead through GAM pays the rest.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 600 })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    await paidAhead(stack, 100, { fundedBy: 'gam' })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 600 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(0)
    expect(Number(final.gap_amount)).toBe(0)
    // escrow 500 kept + GAM-held paid-ahead 100 = 600 to the landlord.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = stripeMocks.transfersCreate.mock.calls[0] as [any, any]
    expect(params).toMatchObject({ amount: 60000, destination: 'acct_landlord_test' })
    expect(opts).toEqual({ idempotencyKey: `deposit_disb_${draftId}` })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM held_payout_items`)).rows[0].n).toBe(0)
  })

  it('the deposit never pays a work-trade line or GAM’s FlexPay collection', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const covered = await openLine(stack, { amount: 200, workTrade: true })
    const flexpay = await openLine(stack, { amount: 75, type: 'fee', entry: 'FLEXPAY', owner: 'gam' })
    const owed = await openLine(stack, { amount: 50, type: 'utility', entry: 'UTILITY' })
    const draftId = await makeDraft(stack, { totalDeposit: 500 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(Number(final.unpaid_balance_amount)).toBe(50)
    expect(Number(final.refund_amount)).toBe(450)
    const st = async (id: string) => (await db.query(`SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status
    expect(await st(covered)).toBe('pending')
    expect(await st(flexpay)).toBe('pending')
    expect(await st(owed)).toBe('paid_via_deposit')
  })

  it('a swept line waiting on a bank retry loses its retry, and the old pull is canceled', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const bounced = await openLine(stack, { amount: 150, status: 'failed', intent: 'pi_bounced_retry', retryAt: true })
    const draftId = await makeDraft(stack, { totalDeposit: 500 })
    await finalizeDepositReturn(draftId, stack.ownerUserId)
    const row = (await db.query(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [bounced])).rows[0]
    expect(row).toEqual({ status: 'paid_via_deposit', next_retry_at: null })
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_bounced_retry')
  })

  it('the saved draft shows the same refund finalize pays (final utilities and paid-ahead money included)', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord' })
    const client = await getClient()
    try {
      const meterId = await seedUtilityMeter(client, { propertyId: stack.propertyId, utilityType: 'water' })
      await seedUtilityBill(client, {
        meterId, unitId: stack.unitId, tenantId: stack.tenantId,
        leaseId: stack.leaseId, landlordId: stack.landlordId,
        chargeAmount: 40, status: 'billed', utilityType: 'water',
      })
    } finally { client.release() }
    await paidAhead(stack, 60)
    const draft = await createOrFetchDraft(stack.leaseId)
    const { applyDeductionsToDraft } = await import('./depositReturn')
    const saved = await applyDeductionsToDraft(draft.id, { damageLines: [{ description: 'scuffs', amount: 20 }] })
    // #46.2: 300 − (40 + 20) = 240 back; the $60 paid ahead stays for the landlord's choice.
    expect(Number(saved!.refund_amount)).toBe(240)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(240)
  })
})

describe('S655: the move-out balance is charged once, like any portal payment', () => {
  beforeEach(() => { vi.clearAllMocks(); stripeMocks.made.length = 0 })

  async function gapStack(): Promise<{ stack: LeaseStack; draftId: string; gapId: string }> {
    const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_gap_test' WHERE id=$1`, [stack.tenantId])
    const draftId = await makeDraft(stack, { totalDeposit: 300, cleaningFeeAmount: 500 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    return { stack, draftId, gapId: final.gap_payment_id! }
  }
  const gapRow = async (id: string) => (await db.query(
    `SELECT status, stripe_payment_intent_id, platform_held FROM payments WHERE id=$1`, [id])).rows[0]
  const receipts = async (tenantId: string) => (await db.query(
    `SELECT id, amount::float AS amount, gross_amount::float AS gross, processing_fee_amount::float AS fee,
            payment_method, stripe_payment_intent_id, status
       FROM tenant_remittances WHERE tenant_id=$1 ORDER BY created_at, id`, [tenantId])).rows
  const draftOf = async (id: string) => (await db.query(
    `SELECT gap_charge_failed, gap_charge_failure_reason FROM deposit_returns WHERE id=$1`, [id])).rows[0]
  const adminNotes = async (category: string) => (await db.query(
    `SELECT body, context FROM admin_notifications WHERE category=$1 ORDER BY created_at`, [category])).rows

  it('success: the charge is saved on the gap row and its receipt BEFORE it is confirmed, card fee on top, off-session', async () => {
    const { stack, draftId, gapId } = await gapStack()
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = stripeMocks.paymentIntentsCreate.mock.calls[0] as [any, any]
    // $200 + the card fee (3.5% + $0.55) = $207.55, made unconfirmed.
    expect(params).toMatchObject({
      amount: 20755, customer: 'cus_gap_test', payment_method: 'pm_default',
      payment_method_types: ['card'], confirm: false,
    })
    expect(params.metadata).toMatchObject({
      gam_payment_id: gapId, gam_lease_id: stack.leaseId, tenant_id: stack.tenantId,
      entry_description: 'DEPOSIT', platform_held: 'true',
    })
    const rem = await receipts(stack.tenantId)
    expect(rem).toHaveLength(1)
    expect(rem[0]).toMatchObject({ amount: 200, gross: 207.55, fee: 7.55, payment_method: 'card', stripe_payment_intent_id: 'pi_gap_test' })
    expect(params.metadata.gam_remittance_id).toBe(rem[0].id)
    expect(opts).toEqual({ idempotencyKey: `deposit_gap_${rem[0].id}` })

    // Confirmed once, off-session (the tenant has moved out), with its own key.
    expect(stripeMocks.paymentIntentsConfirm).toHaveBeenCalledTimes(1)
    expect(stripeMocks.paymentIntentsConfirm.mock.calls[0]).toEqual(
      ['pi_gap_test', { off_session: true }, { idempotencyKey: 'deposit_gap_confirm_pi_gap_test' }])
    // Saved before it was confirmed: the row already names it when the money moves.
    expect(stripeMocks.paymentIntentsCreate.mock.invocationCallOrder[0])
      .toBeLessThan(stripeMocks.paymentIntentsConfirm.mock.invocationCallOrder[0])
    expect(await gapRow(gapId)).toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_gap_test', platform_held: true })
    expect((await draftOf(draftId)).gap_charge_failed).toBe(false)
  })

  it('a bank account: confirmed with the bank mandate, and a payment still clearing leaves the row waiting for the webhook', async () => {
    stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'us_bank_account' }))
    stripeMocks.paymentIntentsConfirm.mockImplementationOnce(async (id: string) => ({ id, status: 'processing' }))
    try {
      const { stack, draftId, gapId } = await gapStack()
      const [params] = stripeMocks.paymentIntentsCreate.mock.calls[0] as [any]
      // $200 + the flat $6 bank fee.
      expect(params).toMatchObject({ amount: 20600, payment_method_types: ['us_bank_account'], confirm: false })
      expect(params.payment_method_options.us_bank_account.financial_connections.permissions).toEqual(['payment_method'])
      const [, confirmParams] = stripeMocks.paymentIntentsConfirm.mock.calls[0] as [string, any]
      expect(confirmParams.mandate_data.customer_acceptance.type).toBe('online')
      expect(confirmParams).not.toHaveProperty('off_session')
      expect(await gapRow(gapId)).toEqual({ status: 'processing', stripe_payment_intent_id: 'pi_gap_test', platform_held: true })
      expect(await receipts(stack.tenantId)).toEqual([expect.objectContaining({
        payment_method: 'ach', status: 'processing', stripe_payment_intent_id: 'pi_gap_test', gross: 206 })])
      expect((await draftOf(draftId)).gap_charge_failed).toBe(false)
      expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
    } finally {
      stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'card', card: { country: 'US' } }))
    }
  })

  it('running it again after the charge went through charges nothing more', async () => {
    const { stack, draftId, gapId } = await gapStack()
    await attemptGapAutoCharge(draftId, { gapPaymentId: gapId })
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.paymentIntentsConfirm).toHaveBeenCalledTimes(1)
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_gap_test')
    expect(await receipts(stack.tenantId)).toHaveLength(1)
  })

  it('a declined card is let go: the gap is owed and payable again, the receipt closes as failed, and a new try is a new charge', async () => {
    stripeMocks.paymentIntentsConfirm.mockImplementationOnce(async () => {
      const e: any = new Error('Your card was declined.')
      e.type = 'StripeCardError'
      e.raw = { payment_intent: { id: 'pi_gap_test', status: 'requires_payment_method' } }
      throw e
    })
    const { stack, draftId, gapId } = await gapStack()
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_gap_test')
    expect(await gapRow(gapId)).toEqual({ status: 'pending', stripe_payment_intent_id: null, platform_held: false })
    expect(await receipts(stack.tenantId)).toEqual([expect.objectContaining({ status: 'failed', stripe_payment_intent_id: 'pi_gap_test' })])
    const d = await draftOf(draftId)
    expect(d.gap_charge_failed).toBe(true)
    expect(d.gap_charge_failure_reason).toBe(GAP_CHARGE_REASON.cardDeclined)

    // Trying again is a new charge with its own receipt and key — never the declined one replayed.
    stripeMocks.paymentIntentsCreate.mockImplementationOnce(async (params: any) => (
      { id: 'pi_gap_second', status: 'requires_confirmation', payment_method_types: params.payment_method_types }))
    await attemptGapAutoCharge(draftId, { gapPaymentId: gapId })
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(2)
    const rems = await receipts(stack.tenantId)
    expect(rems).toHaveLength(2)
    expect(stripeMocks.paymentIntentsCreate.mock.calls[1][1]).toEqual({ idempotencyKey: `deposit_gap_${rems[1].id}` })
    expect(rems[1]).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_second' })
    expect(await gapRow(gapId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_second' })
    // It went through: nothing is left telling the landlord it failed.
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: false, gap_charge_failure_reason: null })
  })

  // Was asserting the generic didNotGoThrough wording: the payment webhook now
  // passes how 'card_declined' for a card the bank declined (leftovers fix), so
  // the landlord reads the specific cardDeclined words.
  it('a declined card the payment webhook already noted tells GAM once and keeps the first note — "card declined" — for the landlord', async () => {
    // Stripe's payment_intent.payment_failed lands while finalize is still
    // letting the declined charge go (fix pass 4).
    stripeMocks.paymentIntentsConfirm.mockImplementationOnce(async (intentId: string) => {
      const row = (await db.query<{ id: string }>(
        `SELECT id FROM payments WHERE stripe_payment_intent_id=$1`, [intentId])).rows[0]
      const { noteGapChargeReturned } = await import('./depositReturn')
      expect(await noteGapChargeReturned(row.id, 'payment_intent.payment_failed', { how: 'card_declined' })).toBe(true)
      const e: any = new Error('Your card was declined.')
      e.type = 'StripeCardError'
      e.raw = { payment_intent: { id: intentId, status: 'requires_payment_method' } }
      throw e
    })
    const { draftId, gapId } = await gapStack()
    expect(await gapRow(gapId)).toEqual({ status: 'pending', stripe_payment_intent_id: null, platform_held: false })
    const d = await draftOf(draftId)
    expect(d.gap_charge_failed).toBe(true)
    expect(d.gap_charge_failure_reason).toBe(GAP_CHARGE_REASON.cardDeclined)
    const n = await adminNotes('deposit_return_gap_charge_failed')
    expect(n).toHaveLength(1)
    expect(n[0].body).toMatch(/payment_intent\.payment_failed/)
  })

  it('the record is saved before any money moves: when saving fails after the intent is made, it is never confirmed and nothing is charged', async () => {
    // Something else already holds this intent id: saving it on the receipt fails, and the whole save rolls back.
    stripeMocks.paymentIntentsCreate.mockImplementationOnce(async (params: any) => {
      await db.query(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, notes)
         VALUES ($1,$2,$3,1,1,'card','pi_gap_test','a clash')`,
        [params.metadata.tenant_id, params.metadata.gam_lease_id, params.metadata.landlord_id])
      return { id: 'pi_gap_test', status: 'requires_confirmation', payment_method_types: ['card'] }
    })
    const { stack, draftId, gapId } = await gapStack()
    expect(stripeMocks.paymentIntentsConfirm).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_gap_test')
    expect(await gapRow(gapId)).toEqual({ status: 'pending', stripe_payment_intent_id: null, platform_held: false })
    // Only the clashing row exists: this attempt's receipt rolled back with the claim.
    expect((await receipts(stack.tenantId)).map((r: any) => r.amount)).toEqual([1])
    const d = await draftOf(draftId)
    expect(d.gap_charge_failed).toBe(true)
    expect(d.gap_charge_failure_reason).toBe(GAP_CHARGE_REASON.notSetUp)
    // GAM is told what happened, in Stripe's terms; the landlord never is.
    const n = await adminNotes('deposit_return_gap_charge_failed')
    expect(n).toHaveLength(1)
    expect(n[0].body).toMatch(/pi_gap_test/)
  })

  it('a charge saved but never confirmed (Stripe could not be reached) is finished by GAM, never made twice, and the landlord is asked nothing', async () => {
    stripeMocks.paymentIntentsConfirm
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async () => { throw new Error('socket hang up') })
    const { draftId, gapId } = await gapStack()
    expect(await gapRow(gapId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_test' })
    // Not the landlord's to collect (the row carries the charge): their page is not told it failed.
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: false, gap_charge_failure_reason: null })
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
    // GAM is told, with Stripe's words.
    const told = await adminNotes('deposit_return_gap_charge_unfinished')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/socket hang up/)
    expect(told[0].context).toMatchObject({ deposit_return_id: draftId, payment_id: gapId, stripe_payment_intent_id: 'pi_gap_test' })

    // GAM's finisher finds it saved and never confirmed, and confirms THAT charge.
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async (id: string) => (
      { id, status: 'requires_confirmation', payment_method_types: ['card'], metadata: stripeMocks.made[0].metadata }))
    const r = await finishPendingGapCharges({ olderThanMinutes: 0 })
    expect(r).toMatchObject({ checked: 1, outcomes: { moving: 1, let_go: 0, unfinished: 0, not_ours: 0 }, errors: [] })
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.paymentIntentsConfirm).toHaveBeenCalledTimes(3)
    for (const call of stripeMocks.paymentIntentsConfirm.mock.calls) {
      expect(call[0]).toBe('pi_gap_test')
      expect(call[2]).toEqual({ idempotencyKey: 'deposit_gap_confirm_pi_gap_test' })
    }
    expect(await gapRow(gapId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_test' })
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: false, gap_charge_failure_reason: null })
  })

  it('a saved charge that can no longer go through is let go by the finisher: the move-out balance is payable again and the landlord is told in plain words', async () => {
    stripeMocks.paymentIntentsConfirm
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async () => { throw new Error('socket hang up') })
    const { stack, draftId, gapId } = await gapStack()
    // By the next run the card's bank has refused it.
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async (id: string) => (
      { id, status: 'requires_payment_method', payment_method_types: ['card'], metadata: stripeMocks.made[0].metadata }))
    const r = await finishPendingGapCharges({ olderThanMinutes: 0 })
    expect(r.outcomes).toMatchObject({ let_go: 1 })
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_gap_test')
    expect(await gapRow(gapId)).toEqual({ status: 'pending', stripe_payment_intent_id: null, platform_held: false })
    expect(await receipts(stack.tenantId)).toEqual([expect.objectContaining({ status: 'failed', stripe_payment_intent_id: 'pi_gap_test' })])
    const d = await draftOf(draftId)
    expect(d).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.didNotGoThrough('card') })
    expect(d.gap_charge_failure_reason).toMatch(/ask the tenant to pay the move-out balance online, or record it at the desk/)
    // Nothing more for the finisher to do.
    expect((await finishPendingGapCharges({ olderThanMinutes: 0 })).checked).toBe(0)
  })

  it('the landlord never reads Stripe’s states or errors; GAM gets them', async () => {
    // The confirm comes back refused, with no error: Stripe's state is all there is to say why.
    stripeMocks.paymentIntentsConfirm.mockImplementationOnce(async (id: string) => ({ id, status: 'requires_payment_method' }))
    const first = await gapStack()
    const reason = (await draftOf(first.draftId)).gap_charge_failure_reason
    expect(reason).toBe(GAP_CHARGE_REASON.didNotGoThrough('card'))
    expect(reason).not.toMatch(/requires_|Stripe|socket|\(/)
    const n = await adminNotes('deposit_return_gap_charge_failed')
    expect(n).toHaveLength(1)
    expect(n[0].body).toMatch(/requires_payment_method/)
    expect(n[0].context).toMatchObject({ reason: GAP_CHARGE_REASON.didNotGoThrough('card') })

    // Every reason the landlord can be shown is plain words that name a next step they can take.
    const all = Object.values(GAP_CHARGE_REASON).map(v => (typeof v === 'function' ? [v('card'), v('ach')] : [v])).flat()
    for (const text of all) {
      expect(text).not.toMatch(/requires_|Stripe|socket|intent|\.$/)
      // Either nothing was charged, or (cameBack) it was and the bank sent it back.
      expect(text).toMatch(/nothing was charged|was not charged|came back unpaid, so it is owed again/)
      expect(text).toMatch(/ask the tenant to pay the move-out balance online, or record it at the desk$/)
    }
  })

  it('an unfinished charge tells GAM once, however many runs it takes', async () => {
    const unreachable = () => stripeMocks.paymentIntentsConfirm
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
    unreachable()
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async () => { throw new Error('socket hang up') })
    const { draftId, gapId } = await gapStack()
    // Next run: Stripe answers the check, but the confirm is still unreachable.
    unreachable()
    stripeMocks.paymentIntentsRetrieve
      .mockImplementationOnce(async (id: string) => (
        { id, status: 'requires_confirmation', payment_method_types: ['card'], metadata: stripeMocks.made[0].metadata }))
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
    const r = await finishPendingGapCharges({ olderThanMinutes: 0 })
    expect(r.outcomes).toMatchObject({ unfinished: 1 })
    // And a run where Stripe cannot be reached at all changes nothing either.
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async () => { throw new Error('socket hang up') })
    expect((await finishPendingGapCharges({ olderThanMinutes: 0 })).outcomes).toMatchObject({ unfinished: 1 })
    const notes = await adminNotes('deposit_return_gap_charge_unfinished')
    expect(notes).toHaveLength(1)
    // It says how to finish the charge, and never promises a run nobody scheduled.
    expect(notes[0].body).toMatch(/GAM's hourly move-out charge finisher \(depositReturn\.finishPendingGapCharges\) tries it again/)
    expect(notes[0].body).not.toMatch(/next run/)
    expect(await gapRow(gapId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_gap_test' })
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: false, gap_charge_failure_reason: null })
  })

  it('the finisher leaves alone a charge being made right now and a payment the tenant started themselves', async () => {
    stripeMocks.paymentIntentsConfirm
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
      .mockImplementationOnce(async () => { throw new Error('socket hang up') })
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async () => { throw new Error('socket hang up') })
    await gapStack()                                          // saved a moment ago: its own run may still be finishing it
    // Another household's move-out balance the tenant is paying in the portal (their own receipt).
    const other = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
    const otherDraft = await makeDraft(other, { totalDeposit: 300, cleaningFeeAmount: 500 })
    const otherGap = (await finalizeDepositReturn(otherDraft, other.ownerUserId)).gap_payment_id!
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_portal_own' WHERE id=$1`, [otherGap])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, notes, created_at)
       VALUES ($1,$2,$3,200,200,'card','pi_portal_own','Paid online', NOW() - interval '1 day')`,
      [other.tenantId, other.leaseId, other.landlordId])
    vi.clearAllMocks()
    expect((await finishPendingGapCharges()).checked).toBe(0)
    expect(stripeMocks.paymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsConfirm).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
  })

  it('a payment the tenant started on the row themselves is never confirmed or canceled by the move-out charge', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
    const draftId = await makeDraft(stack, { totalDeposit: 300, cleaningFeeAmount: 500 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)          // no Stripe customer: not charged
    const gapId = final.gap_payment_id!
    // The tenant is paying it in the portal; their card is waiting on their bank's check.
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_portal_3ds' WHERE id=$1`, [gapId])
    vi.clearAllMocks()
    stripeMocks.paymentIntentsRetrieve.mockImplementationOnce(async (id: string) => (
      { id, status: 'requires_action', payment_method_types: ['card'], metadata: { gam_charge_source: 'portal' } }))
    await attemptGapAutoCharge(draftId, { gapPaymentId: gapId })
    expect(stripeMocks.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_portal_3ds')
    expect(await stripeMocks.paymentIntentsRetrieve.mock.results[0].value).toMatchObject({ status: 'requires_action' })
    expect(stripeMocks.paymentIntentsConfirm).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCancel).not.toHaveBeenCalled()
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
    expect(await gapRow(gapId)).toMatchObject({ status: 'processing', stripe_payment_intent_id: 'pi_portal_3ds' })
  })

  it('a bank account is not charged while bank payments are paused', async () => {
    stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'us_bank_account' }))
    try {
      const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
      await db.query(`UPDATE tenants SET stripe_customer_id='cus_gap_test', ach_suspended_at=NOW() WHERE id=$1`, [stack.tenantId])
      const draftId = await makeDraft(stack, { totalDeposit: 300, cleaningFeeAmount: 500 })
      await finalizeDepositReturn(draftId, stack.ownerUserId)
      expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled()
      const d = (await db.query(`SELECT gap_charge_failure_reason FROM deposit_returns WHERE id=$1`, [draftId])).rows[0]
      expect(d.gap_charge_failure_reason).toMatch(/Bank payments are paused/)
    } finally {
      stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'card', card: { country: 'US' } }))
    }
  })
})

describe('Step 9 review: what joins the move-out pool', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('paid-ahead money a dispute still claims stays out of the move-out pool; the rest joins it', async () => {
    // #46.2: a $560 cleaning on a $500 deposit — $60 is beyond the deposit.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 560 })
    // A $300 card payment left $100 paid ahead through GAM; $40 of that payment is now disputed.
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, stripe_payment_intent_id, gross_amount)
       VALUES ($1,$2,$3,300,200,100,'settled','card','pi_overpaid',300) RETURNING id`,
      [stack.tenantId, stack.leaseId, stack.landlordId])).rows[0].id
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, source_remittance_id)
       VALUES ($1,$2,100,100,'gam',NOW(),$3) RETURNING id`, [stack.leaseId, stack.tenantId, rem])).rows[0].id
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
       VALUES ('dp_test', 'ch_test', 'pi_overpaid', $1, 40, 'needs_response')`, [stack.landlordId])

    expect((await calculateDepositReturn(stack.leaseId))!.prepaid_credit_remaining).toBe(60)
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 560 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    // The deposit pays $500 of the cleaning; the usable $60 pays the rest.
    expect(Number(final.refund_amount)).toBe(0)
    expect(Number(final.gap_amount)).toBe(0)
    const uses = (await db.query(`SELECT amount::float AS amount, source FROM credit_uses WHERE prepaid_credit_id=$1`, [credit])).rows
    expect(uses).toEqual([{ amount: 60, source: 'move_out' }])
    // The disputed $40 stays where the dispute can take it.
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(40)
  })

  it('paid-ahead money left on the lease a renewal replaced is pooled with the renewal’s, and keeps the lease it arrived on', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    // The move-out's deductions (a $600 cleaning on the renewal: $100 beyond the deposit) take all the paid-ahead money.
    const client = await getClient()
    let renewalId: string
    try {
      await client.query(`UPDATE leases SET status='expired' WHERE id=$1`, [stack.leaseId])
      renewalId = await seedLease(client, { unitId: stack.unitId, landlordId: stack.landlordId, rentAmount: 1000, startDate: '2026-01-01' })
      await client.query(`UPDATE leases SET supersedes_lease_id=$2, lease_source='esigned' WHERE id=$1`, [renewalId, stack.leaseId])
      await seedLeaseTenant(client, { leaseId: renewalId, tenantId: stack.tenantId, role: 'primary' })
      await client.query(
        `INSERT INTO lease_documents (landlord_id, title, status, renews_lease_id, lease_id, issued_at)
         VALUES ($1,'Renewal','completed',$2,$3, now())`, [stack.landlordId, stack.leaseId, renewalId])
      // The deposit moved to the renewal, as the renewal hand-off does.
      await client.query(`UPDATE security_deposits SET lease_id=$2 WHERE id=$1`, [stack.depositId, renewalId])
      // #46.2: the renewal's $600 cleaning — the deposit pays $500, the paid-ahead money the rest.
      await seedLeaseFee(client, { leaseId: renewalId, feeType: 'cleaning_fee', amount: 600, dueTiming: 'move_out' })
    } finally { client.release() }
    const onOld = await paidAhead(stack, 70)
    const onNew = await paidAhead({ ...stack, leaseId: renewalId }, 30)

    const renewal = { ...stack, leaseId: renewalId }
    expect((await calculateDepositReturn(renewalId))!.prepaid_credit_remaining).toBe(100)
    const draftId = await makeDraft(renewal, { totalDeposit: 500, cleaningFeeAmount: 600 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(0)
    expect(Number(final.gap_amount)).toBe(0)
    const uses = (await db.query(
      `SELECT prepaid_credit_id, lease_id, amount::float AS amount FROM credit_uses WHERE deposit_return_id=$1 ORDER BY amount DESC`,
      [draftId])).rows
    // The old lease's money went with the tenancy first (as the renewal hand-off moves it), then joined.
    expect(uses).toEqual([
      { prepaid_credit_id: onOld, lease_id: renewalId, amount: 70 },
      { prepaid_credit_id: onNew, lease_id: renewalId, amount: 30 },
    ])
    const credits = (await db.query(
      `SELECT id, lease_id, amount_remaining::float AS r FROM lease_prepaid_credits ORDER BY amount_original DESC`)).rows
    expect(credits).toEqual([{ id: onOld, lease_id: renewalId, r: 0 }, { id: onNew, lease_id: renewalId, r: 0 }])
    // Step 9 final fix (fix pass 1): moved for the move-out, the old lease's
    // money still reads as ARRIVED on the old lease (received_lease_id, set
    // once) — Money received and the owner statement never move a past month.
    // The renewal's own money never moved, so it has none.
    expect((await db.query(
      `SELECT id, received_lease_id FROM lease_prepaid_credits ORDER BY amount_original DESC`)).rows)
      .toEqual([{ id: onOld, received_lease_id: stack.leaseId }, { id: onNew, received_lease_id: null }])
  })

  it('a deposit carried forward to the next lease leaves paid-ahead money where it is, and GAM is told', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(`UPDATE security_deposits SET portability_status='authorized', portability_authorized_at=NOW() WHERE id=$1`, [stack.depositId])
    const credit = await paidAhead(stack, 80)
    const draftId = await makeDraft(stack, { totalDeposit: 500 })
    const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(final.status).toBe('sent_carried_forward')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses`)).rows[0].n).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(80)
    const alert = (await db.query(
      `SELECT context FROM admin_notifications WHERE category='deposit_carry_forward_paid_ahead_left'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].context).toMatchObject({ deposit_return_id: draftId, amount: 80 })
  })
})

// ─── Step 9 review: the move-out pool is split by who holds each deposit ─────
//
// A pet, key or cleaning deposit (S653) paid through GAM stays on GAM's balance
// (the weekly payout never passes a deposit through); one paid at the desk or by
// bank deposit is with the landlord. Who holds a dollar is a fact, and no
// landlord is ever charged for money GAM holds, nor paid for money they hold.

async function boxDeposit(stack: LeaseStack, o: {
  feeType: 'pet_deposit' | 'key_deposit' | 'cleaning_deposit'; amount: number; via: 'gam' | 'desk'; description?: string
}): Promise<string> {
  const feeId = (await db.query<{ id: string }>(
    `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind, description)
     VALUES ($1,$2,$3,'move_in',TRUE,'deposit',$4) RETURNING id`,
    [stack.leaseId, o.feeType, o.amount.toFixed(2), o.description ?? null])).rows[0].id
  return depositPayment(stack, { amount: o.amount, via: o.via, leaseFeeId: feeId })
}

/** A settled deposit payment: through GAM (card/bank, on GAM's balance) or taken at the desk. */
async function depositPayment(stack: LeaseStack, o: { amount: number; via: 'gam' | 'desk'; leaseFeeId?: string | null }): Promise<string> {
  const gam = o.via === 'gam'
  const tag = randomUUID().slice(0, 8)
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           lease_fee_id, revenue_owner, settled_at, platform_held, manual_method,
                           stripe_payment_intent_id, stripe_charge_id)
     VALUES ($1,$2,$3,$4,'deposit',$5,'settled',CURRENT_DATE - 30,'DEPOSIT',$6,'landlord',NOW() - interval '30 days',
             $7,$8,$9,$10) RETURNING id`,
    [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, o.amount.toFixed(2), o.leaseFeeId ?? null,
     gam, gam ? null : 'cash', gam ? `pi_dep_${tag}` : null, gam ? `ch_dep_${tag}` : null])).rows[0].id
}

const heldItems = async () => (await db.query(
  `SELECT landlord_id, source_type, source_id, amount::float AS amount, description
     FROM held_payout_items ORDER BY amount DESC, source_id`)).rows

describe('Step 9 review: the move-out pool is split by who holds each deposit', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('GAM escrow, a pet deposit paid through GAM and nothing kept: the tenant gets it all back and the landlord is charged nothing', async () => {
    // The reviewer's case: $500 escrow + a $200 pet deposit paid in the portal.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.total_deposit)).toBe(700)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(700)
    // GAM held all $700 and paid all $700 back: nothing owed either way.
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  // Was 'GAM escrow, one deposit paid through GAM and one at the desk: the
  // landlord is netted only what they hold' — under #46.3 GAM never refunds or
  // nets money the landlord holds: they hand their part back themselves.
  // Was '… GAM refunds the $700 it holds, the landlord hands back the $50 key
  // deposit themselves …' with the note "$700.00 goes back the way the deposit
  // was paid online; $50.00 is handed back at the office". Under #47a GAM SENDS
  // its part back the way it was paid: the $200 pet deposit paid by card goes
  // back to the card; the $500 escrow record has no card or bank payment behind
  // it, so it is given back at the office (on the owner's to-do list) with the
  // landlord's $50 — and the note says only how each part reaches the tenant (#47c).
  it('#46.3/#47a GAM escrow, one deposit paid through GAM and one at the desk: GAM sends the $700 it holds ($200 back to the card, $500 with no card payment to give back at the office), the landlord hands back the $50 key deposit themselves, and nothing is netted from them', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    await boxDeposit(stack, { feeType: 'key_deposit', amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ refund_amount: 750, refund_from_gam: 700, refund_from_landlord: 50 })
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(750)              // 500 + 200 + 50, nothing kept
    expect(Number((final as any).refund_from_gam)).toBe(700)
    expect(Number((final as any).refund_from_landlord)).toBe(50)
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
    const note = (await db.query(`SELECT notes FROM payments WHERE id=$1`, [final.refund_payment_id])).rows[0].notes
    // decisions #47c: how each part comes back, never who holds it.
    expect(note).toMatch(/\$200\.00 back to your card; \$550\.00 returned to you at the office\./)
    expect(note).not.toMatch(/holds|GAM sends/)
  })

  it('GAM escrow with deductions: the landlord’s transfer counts the deposit GAM held, never the one they hold', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 300 })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    await boxDeposit(stack, { feeType: 'key_deposit', amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(450)              // 750 − 300 cleaning
    // escrow 500 + pet deposit GAM held 200 − refund 450 = 250 to the landlord
    // (who also keeps the $50 key deposit they hold: 300 kept in all).
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect((stripeMocks.transfersCreate.mock.calls[0] as [any])[0]).toMatchObject({ amount: 25000 })
    expect(await heldItems()).toEqual([])
  })

  it('landlord-held deposit, one deposit paid through GAM and one at the desk: GAM releases what it holds, and only that', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam', description: 'Dog deposit' })
    await boxDeposit(stack, { feeType: 'key_deposit', amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(750)              // the landlord pays it, from what they hold
    // The landlord is told to pay $750 but holds only $550: GAM releases the
    // $200 pet deposit it holds. Never the $50 the landlord took at the desk.
    const items = await heldItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ landlord_id: stack.landlordId, source_type: 'deposit_settlement', source_id: pet, amount: 200 })
    expect(items[0].description).toMatch(/Dog deposit the tenant paid through GAM, released to you/)
  })

  it('landlord-held deposit with deductions taking it all: GAM still releases the deposit it holds', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 900 })
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    await boxDeposit(stack, { feeType: 'key_deposit', amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_gap')
    expect(Number(final.gap_amount)).toBe(150)                 // 900 − 750
    expect((await heldItems()).map((i: any) => [i.source_type, i.source_id, i.amount]))
      .toEqual([['deposit_settlement', pet, 200]])
  })

  it('landlord-held deposit the tenant paid through GAM (a state GAM cannot hold deposits in): GAM releases it, never more than the record counts', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const paid = await depositPayment(stack, { amount: 500, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(500)
    const items = await heldItems()
    expect(items.map((i: any) => [i.source_type, i.source_id, i.amount])).toEqual([['deposit_settlement', paid, 500]])
    expect(items[0].description).toMatch(/security deposit the tenant paid through GAM, released to you/)
  })

  it('a deposit that settled after the draft was made is in the pool finalize pays', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.total_deposit)).toBe(500)
    await boxDeposit(stack, { feeType: 'cleaning_deposit', amount: 75, via: 'desk' })
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.total_deposit)).toBe(575)
    expect(Number(final.refund_amount)).toBe(575)
    expect(await heldItems()).toEqual([])                       // the landlord holds the $75
  })

  it('a deposit carried forward leaves the pet deposit where it is, and GAM is told who holds it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(`UPDATE security_deposits SET portability_status='authorized', portability_authorized_at=NOW() WHERE id=$1`, [stack.depositId])
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_carried_forward')
    expect(await heldItems()).toEqual([])
    const alert = (await db.query(
      `SELECT body, context FROM admin_notifications WHERE category='deposit_carry_forward_paid_ahead_left'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].context).toMatchObject({ deposits: [{ payment_id: pet, amount: 200, gam_held: true }], deposits_amount: 200 })
    expect(alert[0].body).toMatch(/a \$200\.00 pet deposit \(GAM holds it\)/)
  })

  it('paid-ahead money already spent through the credit ledger before move-out (a check-out money decision) is never refunded again', async () => {
    // The contract any other decision on paid-ahead money (early check-out's
    // "No refund", a refund to the card) must meet: spend or withdraw it
    // through credit_uses first, and move-out pools only what is left.
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const credit = await paidAhead(stack, 300, { fundedBy: 'reclassified' })
    const rent = await openLine(stack, { amount: 100 })
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,100,date_trunc('month', CURRENT_DATE)::date,'desk','applied',now())`,
      [credit, rent, stack.leaseId])
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    // Nothing is owed, so nothing is pooled: the deposit comes back, and the
    // $200 still unspent stays paid ahead for the landlord's refund choice.
    expect(Number(final.refund_amount)).toBe(500)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses WHERE source='move_out'`)).rows[0].n).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(200)
  })
})

// ─── Step 9 review (fix pass 1) ──────────────────────────────────────────────

describe('Step 9 review (fix pass 1): every dollar of a move-out counted once', () => {
  beforeEach(() => { vi.clearAllMocks(); stripeMocks.made.length = 0 })

  const withConnect = (stack: LeaseStack) =>
    db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
  const statusOf = async (id: string) => (await db.query(`SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status

  it('deposit interest is paid once: months the annual payout credited are never paid again at move-out, the credited interest the tenant never spent is refunded with the deposit, and nothing accrues or is credited after it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 1000, heldBy: 'gam_escrow' })
    await withConnect(stack)
    const accrue = (monthsAgo: number) => db.query(
      `INSERT INTO security_deposit_interest_accruals
         (security_deposit_id, lease_id, accrual_month, state_code, effective_year, annual_rate_pct,
          principal_amount, days_held, days_in_month, interest_amount)
       VALUES ($1,$2,(date_trunc('month', CURRENT_DATE) - make_interval(months => $3))::date,'AZ',2026,5,1000,30,30,4.1667)`,
      [stack.depositId, stack.leaseId, monthsAgo])
    const resum = () => db.query(
      `UPDATE security_deposits sd SET interest_accrued =
         (SELECT SUM(interest_amount) FROM security_deposit_interest_accruals WHERE security_deposit_id = sd.id)
        WHERE sd.id = $1`, [stack.depositId])
    // A year of interest ($50.00), credited to the tenant by the annual payout.
    for (let m = 14; m >= 3; m--) await accrue(m)
    await resum()
    const { payAnnualDepositInterest } = await import('./depositInterestPayout')
    const paid = await payAnnualDepositInterest()
    expect(paid.paid).toBe(1)
    expect(paid.totalCredited).toBe(50)
    // One more month accrues before move-out; the record's running total is $54.17.
    await accrue(2)
    await resum()
    expect(Number((await db.query(`SELECT interest_accrued FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0].interest_accrued)).toBe(54.17)

    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.interest_accrued).toBe(4.17)                   // only the month not yet paid
    expect(calc!.deposit_interest_credited).toBe(50)            // credited a year ago, never spent
    expect(calc!.refund_amount).toBe(1054.17)
    const draft = await createOrFetchDraft(stack.leaseId)
    const { applyDeductionsToDraft } = await import('./depositReturn')
    expect(Number((await applyDeductionsToDraft(draft.id, {}))!.refund_amount)).toBe(1054.17)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(1054.17)
    // GAM held 1000 + 4.17 + the $50 it credited, and paid it all back: nothing to the landlord.
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
    expect(await heldItems()).toEqual([])
    const ev = (await db.query(
      `SELECT event_data FROM credit_events WHERE event_type='deposit_interest_paid'`)).rows
    expect(ev).toHaveLength(1)
    expect(ev[0].event_data).toMatchObject({ interest_accrued_total: 4.17, interest_paid_to_tenant: 4.17 })

    // The deposit is returned: every month is paid, the record is disbursed …
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM security_deposit_interest_accruals WHERE security_deposit_id=$1 AND paid_at IS NULL`,
      [stack.depositId])).rows[0].n).toBe(0)
    const sd = (await db.query(`SELECT status, disbursed_at IS NOT NULL AS out FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0]
    expect(sd).toEqual({ status: 'disbursed', out: true })
    // … so no later accrual or payout touches it.
    const { runMonthlyAccrual } = await import('./depositInterest')
    const monthStart = (await db.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS m`)).rows[0].m
    const acc = await runMonthlyAccrual(monthStart)
    expect(acc.accrued_count + acc.skipped_count + acc.error_count).toBe(0)
    const again = await payAnnualDepositInterest(new Date(Date.now() + 400 * 86_400_000))
    expect(again.scanned).toBe(0)

    // The $50 the annual payout credited joined the move-out through the
    // credit ledger: spent once, on this move-out, and nothing is left on the
    // ended lease.
    const credits = (await db.query(
      `SELECT category, amount_original::float AS original, amount_remaining::float AS remaining, status
         FROM tenant_credits WHERE lease_id = $1`, [stack.leaseId])).rows
    expect(credits).toEqual([{ category: 'deposit_interest', original: 50, remaining: 0, status: 'active' }])
    const uses = (await db.query(
      `SELECT kind, amount::float AS amount, source, status, deposit_return_id, gam_held FROM v_credit_uses`)).rows
    expect(uses).toEqual([{ kind: 'deposit_interest', amount: 50, source: 'move_out', status: 'applied', deposit_return_id: draft.id, gam_held: true }])
  })

  it('carried forward: landlord A is settled for the deductions the deposit paid, and only the rest moves to the next lease', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 200 })
    await withConnect(stack)
    // The tenant's next lease, at another landlord, with the tenant on it.
    const next = await (async () => {
      const client = await getClient()
      try {
        const b = await seedLandlord(client)
        const propertyId = await seedProperty(client, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
        const unitId = await seedUnit(client, { propertyId, landlordId: b.landlordId, rentAmount: 900 })
        const leaseId = await seedLease(client, { unitId, landlordId: b.landlordId, rentAmount: 900 })
        await seedLeaseTenant(client, { leaseId, tenantId: stack.tenantId, role: 'primary' })
        return { leaseId, unitId }
      } finally { client.release() }
    })()
    await db.query(
      `UPDATE security_deposits SET portability_status='authorized', portability_authorized_at=NOW(),
              portability_target_lease_id=$2 WHERE id=$1`, [stack.depositId, next.leaseId])
    const rent = await openLine(stack, { amount: 100 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_carried_forward')
    expect(Number(final.gap_amount)).toBe(0)
    expect(final.gap_payment_id).toBeNull()
    expect(await statusOf(rent)).toBe('paid_via_deposit')
    // $300 of the $500 paid landlord A's deductions, paid to landlord A …
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect((stripeMocks.transfersCreate.mock.calls[0] as [any])[0]).toMatchObject({ amount: 30000, destination: 'acct_landlord_test' })
    // … and the record really moved to the next lease carrying only the $200
    // left: a $500 deposit there (no deposit of its own), $200 of it held.
    const sd = (await db.query(
      `SELECT lease_id, unit_id, collected_amount::float AS c, total_amount::float AS t, status, portability_status, held_by
         FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0]
    expect(sd).toEqual({
      lease_id: next.leaseId, unit_id: next.unitId, c: 200, t: 500, status: 'partial',
      portability_status: 'carried_forward', held_by: 'gam_escrow',
    })
    // Nothing of it stays on the ended lease.
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM security_deposits WHERE lease_id=$1`, [stack.leaseId])).rows[0].n).toBe(0)
  })

  it('carried forward with deductions beyond the deposit: none of it is carried and the shortfall is charged like any other', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 700 })
    await withConnect(stack)
    await db.query(`UPDATE security_deposits SET portability_status='authorized', portability_authorized_at=NOW() WHERE id=$1`, [stack.depositId])
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_carried_forward')
    expect(Number(final.gap_amount)).toBe(200)
    const gap = (await db.query(
      `SELECT type, amount::float AS amount, status, entry_description, lease_fee_id FROM payments WHERE id=$1`, [final.gap_payment_id])).rows[0]
    expect(gap).toEqual({ type: 'fee', amount: 200, status: 'pending', entry_description: 'DEPOSIT', lease_fee_id: null })
    // The tenant has no saved method, so the landlord is told to collect it.
    expect((await db.query(`SELECT gap_charge_failed FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].gap_charge_failed).toBe(true)
    const sd = (await db.query(`SELECT collected_amount::float AS c, status FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0]
    expect(sd).toEqual({ c: 0, status: 'pending' })
    expect((stripeMocks.transfersCreate.mock.calls[0] as [any])[0]).toMatchObject({ amount: 50000 })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_events WHERE event_type='tenancy_ended_with_balance'`)).rows[0].n).toBe(1)
  })

  it('GAM escrow: GAM’s own line the deposit pays is GAM’s — kept out of the landlord’s settlement', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    await withConnect(stack)
    const fee = await openLine(stack, { amount: 4, type: 'fee', entry: 'RETURNFEE', owner: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(496)
    expect(await statusOf(fee)).toBe('paid_via_deposit')
    // GAM held 500, paid back 496 and keeps its own $4: nothing goes to the landlord.
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
    expect(await heldItems()).toEqual([])
  })

  it('landlord-held deposit: GAM’s own line the deposit paid comes out of the landlord’s next payout', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await openLine(stack, { amount: 4, type: 'fee', entry: 'RETURNFEE', owner: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(496)
    const items = await heldItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ landlord_id: stack.landlordId, source_type: 'deposit_settlement', source_id: `gam_lines:${draft.id}`, amount: -4 })
    expect(items[0].description).toMatch(/returned-payment fee/)
    expect(items[0].description).toMatch(/it is GAM's, so it comes out of this payout/)
  })

  it('a prepaid box is never paid from the deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const box = await openLine(stack, { amount: 300, type: 'fee', entry: 'OTHERFEE', owner: 'held' })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.unpaid_balance_lines.map((l) => l.payment_id)).not.toContain(box)
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(500)
    expect(await statusOf(box)).toBe('pending')
  })

  it('an unpaid non-refundable pet fee is paid from the deposit', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const feeId = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
       VALUES ($1,'pet_deposit',150,'move_in',FALSE,'fee') RETURNING id`, [stack.leaseId])).rows[0].id
    const pet = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, lease_fee_id)
       VALUES ($1,$2,$3,$4,'fee',150,'pending',CURRENT_DATE - 20,'DEPOSIT',$5) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, feeId])).rows[0].id
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.unpaid_balance_lines.map((l) => l.payment_id)).toEqual([pet])
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(350)
    expect(await statusOf(pet)).toBe('paid_via_deposit')
  })

  it('decisions #48.6: finalize waits while a payment toward the deposit is still clearing, and says the day it should clear', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id, platform_held)
       VALUES ($1,$2,$3,$4,'deposit',200,'processing',CURRENT_DATE,'DEPOSIT','pi_deposit_clearing',TRUE)`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId))
      .rejects.toThrow(/^A \$200\.00 payment toward the security deposit, made [A-Z][a-z]{2} \d{1,2}, \d{4}, is still clearing, so the move-out can’t be finalized yet\. It should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')
    expect((await db.query(`SELECT status FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0].status).toBe('funded')
  })

  it('a card payment toward the deposit the tenant never finished (bank confirmation abandoned) still blocks finalize, but the landlord is told the next step and GAM is told once by name', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    // The deposit charge was made at move-in; the card attempt on it ten days ago is still waiting on the tenant.
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id, platform_held, created_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'processing',CURRENT_DATE - 60,'DEPOSIT','pi_deposit_abandoned',TRUE, NOW() - INTERVAL '60 days') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,200,200,0,'card','pi_deposit_abandoned', NOW() - INTERVAL '10 days')`,
      [stack.tenantId, stack.leaseId, stack.landlordId])
    const { STUCK_DEPOSIT_PAYMENT_MESSAGE } = await import('./depositReturn')
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    expect(STUCK_DEPOSIT_PAYMENT_MESSAGE).toMatch(/GAM has been told and will check it with the payment processor, then finish or cancel it/)
    // Fix pass 3: the landlord is never told as fact that nothing was charged — a stuck payment's state is unknown until GAM looks.
    expect(STUCK_DEPOSIT_PAYMENT_MESSAGE).not.toMatch(/nothing was charged/)
    const notes = (await db.query(
      `SELECT context FROM admin_notifications WHERE category='deposit_payment_stuck_at_move_out'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].context).toMatchObject({ payment_id: charge, stripe_payment_intent_id: 'pi_deposit_abandoned', deposit_return_id: draft.id })
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')

    // Once GAM cancels it (the canceled webhook gives the row back), finalize goes through.
    await db.query(`UPDATE payments SET status='pending', stripe_payment_intent_id=NULL, platform_held=FALSE WHERE id=$1`, [charge])
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')
  })

  it('a bank retry of a deposit payment is aged from the retry: a receipt 10 days old retried 2 days ago gets the ordinary “still clearing” refusal (a bank payment, with the day it should clear) and GAM is not told', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, platform_held, created_at, retry_count, last_retry_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'processing',CURRENT_DATE - 60,'DEPOSIT','pi_deposit_retried',TRUE,
               NOW() - INTERVAL '60 days', 1, NOW() - INTERVAL '2 days')`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,200,200,0,'ach','pi_deposit_retried', NOW() - INTERVAL '10 days')`,
      [stack.tenantId, stack.leaseId, stack.landlordId])
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId))
      .rejects.toThrow(/^A \$200\.00 bank payment toward the security deposit, made .+, is still clearing, so the move-out can’t be finalized yet\. It should clear by .+\./)
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category='deposit_payment_stuck_at_move_out'`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')
  })

  it('a bank retry of a deposit payment that itself sticks past a week is a new attempt: GAM is told about it once', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, platform_held, created_at, retry_count, last_retry_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'processing',CURRENT_DATE - 60,'DEPOSIT','pi_deposit_retry_stuck',TRUE,
               NOW() - INTERVAL '60 days', 1, NOW() - INTERVAL '9 days') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    const { STUCK_DEPOSIT_PAYMENT_MESSAGE } = await import('./depositReturn')
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    const notes = (await db.query(
      `SELECT context FROM admin_notifications WHERE category='deposit_payment_stuck_at_move_out'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].context).toMatchObject({ payment_id: charge, stripe_payment_intent_id: 'pi_deposit_retry_stuck' })
  })

  it('a bank payment toward the deposit that came back and is set to be tried again blocks finalize, in plain words; once it is let go, finalize goes through', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, platform_held, created_at, retry_count, next_retry_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'failed',CURRENT_DATE - 60,'DEPOSIT','pi_deposit_retry_set',FALSE,
               NOW() - INTERVAL '60 days', 0, NOW() + INTERVAL '2 days') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(
      /^A \$200\.00 bank payment toward the security deposit came back and is set to be tried again on [A-Z][a-z]{2} \d{1,2}, \d{4}, so the move-out can’t be finalized yet\. If that try goes through it should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category='deposit_payment_stuck_at_move_out'`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')
    // Out of retries (or the retry canceled): nothing is in flight, so finalize goes through.
    await db.query(`UPDATE payments SET next_retry_at = NULL WHERE id=$1`, [charge])
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_refund')
  })

  it('a deposit payment GAM releases to the landlord no longer reads as a deposit GAM holds', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const paid = await depositPayment(stack, { amount: 500, via: 'gam' })
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 100, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect((await heldItems()).map((i: any) => i.source_id).sort()).toEqual([paid, pet].sort())
    const held = (await db.query(
      `SELECT id, platform_held FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id`, [[paid, pet]])).rows
    expect(held.every((r: any) => r.platform_held === false)).toBe(true)
  })

  it('a move-out balance charge that comes back unpaid is told to the landlord, once', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_gap_test' WHERE id=$1`, [stack.tenantId])
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect((await db.query(`SELECT gap_charge_failed FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].gap_charge_failed).toBe(false)

    const { noteGapChargeReturned } = await import('./depositReturn')
    expect(await noteGapChargeReturned(final.gap_payment_id!, 'charge.failed after it was sent')).toBe(true)
    const dr = (await db.query(`SELECT gap_charge_failed, gap_charge_failure_reason FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0]
    expect(dr).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.cameBack('card') })
    expect(await noteGapChargeReturned(final.gap_payment_id!)).toBe(false)
    const notes = (await db.query(`SELECT body FROM admin_notifications WHERE category='deposit_return_gap_charge_failed'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toMatch(/charge\.failed after it was sent/)
    // A payment that is no move-out balance is nobody's note.
    expect(await noteGapChargeReturned(await openLine(stack, { amount: 10 }))).toBe(false)
  })
})

describe('Step 9 review (fix pass 1): a security deposit paid by bank deposit comes back at move-out', () => {
  beforeEach(() => { vi.clearAllMocks() })

  /** The record owes $500 and holds nothing; the tenant pays it by a $500 bank deposit the landlord matches. */
  async function paidByBankDeposit(heldBy: 'landlord' | 'gam_escrow'): Promise<LeaseStack> {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy })
    await db.query(`UPDATE security_deposits SET status='pending' WHERE id=$1`, [stack.depositId])
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'deposit',500,'pending',CURRENT_DATE - 40,'DEPOSIT') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
      [stack.landlordId])).rows[0].id
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,CURRENT_DATE - 38,500,'MOBILE DEPOSIT','needs_review') RETURNING id`,
      [conn, stack.landlordId, randomUUID()])).rows[0].id
    const { confirmDepositMatch } = await import('./bankDepositConfirm')
    await confirmDepositMatch({ bankTransactionId: txn, chargeIds: [charge], method: 'check' })
    const sd = (await db.query(`SELECT collected_amount::float AS c, held_by FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0]
    // 10/4 (decisions #46.3): the record counts it either way, and says the
    // landlord holds it — it went into their bank, whatever was planned.
    expect(sd).toEqual({ c: 500, held_by: 'landlord' })
    return stack
  }

  it('landlord-held: a bank-matched security deposit is refunded at move-out', async () => {
    const stack = await paidByBankDeposit('landlord')
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.total_deposit)).toBe(500)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(500)
    // The landlord holds it and pays it back: GAM releases nothing.
    expect(await heldItems()).toEqual([])
  })

  // Replaces 'GAM escrow: a bank-matched security deposit stays off GAM's
  // record … (OPEN ITEM for Nic)'. Nic answered (decisions #46.3, 10/4, FINAL):
  // a deposit paid straight into the landlord's bank is held by the landlord.
  it('#46.3: a security deposit planned for GAM but paid into the landlord’s bank is the landlord’s — the record counts it, the landlord refunds it themselves at move-out, and GAM sends and nets nothing (the note: returned to you at the office)', async () => {
    const stack = await paidByBankDeposit('gam_escrow')
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    // GAM was told, for information only.
    expect((await db.query(
      `SELECT severity FROM admin_notifications WHERE category='escrow_deposit_paid_to_landlord'`)).rows).toEqual([{ severity: 'info' }])
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.total_deposit)).toBe(500)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ refund_amount: 500, refund_from_gam: 0, refund_from_landlord: 500 })
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(500)
    expect(Number((final as any).refund_from_gam)).toBe(0)
    expect(Number((final as any).refund_from_landlord)).toBe(500)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
    expect(await heldItems()).toEqual([])
    const note = (await db.query(`SELECT notes FROM payments WHERE id=$1`, [final.refund_payment_id])).rows[0].notes
    // decisions #47c: the note says how the money comes back, never who holds it.
    // Was "It is handed back at the office." (#47a wording: how it reaches the tenant).
    expect(note).toMatch(/\$500\.00 returned to you at the office\./)
    expect(note).not.toMatch(/holds|GAM sends/)
  })
})

// ── Step 9 review (fix pass 2): the move-out balance charge settled by the real payment webhook ──

describe('Step 9 review (fix pass 2): the payment webhook settles a move-out balance charge', () => {
  beforeEach(() => { vi.clearAllMocks(); stripeMocks.made.length = 0 })
  const addedRates: string[] = []
  afterEach(async () => {
    if (addedRates.length > 0) await db.query(`DELETE FROM platform_processing_rates WHERE id = ANY($1::uuid[])`, [addedRates.splice(0)])
  })

  async function postSucceeded(intentId: string, metadata: Record<string, string>) {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { webhooksRouter } = await import('../routes/webhooks')
    process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
    const app = express()
    app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
    app.use('/webhooks', webhooksRouter)
    const body = JSON.stringify({
      id: `evt_${intentId}_${randomUUID().slice(0, 8)}`, type: 'payment_intent.succeeded',
      data: { object: { id: intentId, metadata, payment_method_types: ['card'],
        latest_charge: { id: `ch_${intentId}`, payment_method_details: { type: 'card' } } } },
    })
    return request(app).post('/webhooks/stripe').set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(body)
  }

  it('success settles the move-out balance row and its receipt, books the landlord’s share once, and creates no paid-ahead money; a redelivery changes nothing', async () => {
    const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
    await db.query(`UPDATE tenants SET stripe_customer_id='cus_gap_test' WHERE id=$1`, [stack.tenantId])
    const client = await getClient()
    try {
      await seedAllocationRule(client, { propertyId: stack.propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      // Rates only if none is active: cleanupAllSchema keeps this table, and an
      // earlier file in the same run may already have seeded an active rate
      // (one active rate per method). Rows this test adds are removed at its
      // end (afterEach), so a later file seeds its own. The test asserts no
      // rate-specific figure.
      for (const [method, flat, pct, costFlat, costPct] of [['card', 0.55, 3.5, 0.26, 2.9], ['ach', 6, 0, 0, 0.5]] as const) {
        const added = await client.query<{ id: string }>(
          `INSERT INTO platform_processing_rates
             (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
           SELECT $1, $2, $3, $4, $5
            WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = $1 AND effective_until IS NULL)
           RETURNING id`,
          [method, flat, pct, costFlat, costPct])
        addedRates.push(...added.rows.map((r) => r.id))
      }
    } finally { client.release() }
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    const gapId = final.gap_payment_id!
    expect(Number(final.gap_amount)).toBe(200)
    // The charge is saved on the row and confirmed; the row waits for the webhook.
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [gapId])).rows[0].status).toBe('processing')
    const metadata = stripeMocks.made[0].metadata as Record<string, string>
    expect(metadata.gam_kind).toBe('deposit_return_gap')

    const res = await postSucceeded('pi_gap_test', metadata)
    expect(res.status).toBe(200)
    const row = (await db.query(`SELECT status, settled_at IS NOT NULL AS settled FROM payments WHERE id=$1`, [gapId])).rows[0]
    expect(row).toEqual({ status: 'settled', settled: true })
    const rem = (await db.query(
      `SELECT status, amount::float AS amount, unapplied_amount::float AS unapplied FROM tenant_remittances WHERE stripe_payment_intent_id='pi_gap_test'`)).rows
    expect(rem).toEqual([{ status: 'settled', amount: 200, unapplied: 0 }])
    const share = async () => (await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS total FROM user_balance_ledger
        WHERE reference_id=$1 AND type='allocation_owner_share'`, [gapId])).rows[0]
    const first = await share()
    expect(first.n).toBe(1)
    expect(first.total).toBeGreaterThan(0)
    // Nothing paid ahead: the charge was exactly the balance.
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM lease_prepaid_credits WHERE tenant_id=$1`, [stack.tenantId])).rows[0].n).toBe(0)
    // The deposit record (returned at move-out) is not raised by it.
    expect((await db.query(`SELECT status, collected_amount::float AS c FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0])
      .toEqual({ status: 'disbursed', c: 300 })

    // Stripe redelivers the same success: nothing is settled or booked again.
    expect((await postSucceeded('pi_gap_test', metadata)).status).toBe(200)
    expect(await share()).toEqual(first)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM lease_prepaid_credits WHERE tenant_id=$1`, [stack.tenantId])).rows[0].n).toBe(0)
  })

  // 10/4 (decisions #46.3): the Stripe webhook is the electronic settle — it
  // raises the deposit record and records GAM as the holder.
  it.each([
    ['an imported lease planned for the landlord, in a state GAM may hold deposits in', 'landlord', true, 'gam_escrow'],
    ['a state GAM may not hold deposits in', 'landlord', false, 'landlord'],
  ] as const)('#46.3: a security deposit paid online (the payment webhook) is held by GAM where the custody gate allows — %s', async (_label, planned, supported, heldBy) => {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: planned })
    await db.query(`UPDATE security_deposits SET status='pending' WHERE id=$1`, [stack.depositId])
    if (supported) {
      await db.query(`UPDATE properties SET state='QB' WHERE id=$1`, [stack.propertyId])
      await db.query(
        `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
         VALUES ('QB', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported'`)
    }
    const intent = `pi_dep_online_${randomUUID().slice(0, 8)}`
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, gross_amount)
       VALUES ($1,$2,$3,500,500,'card',$4,500) RETURNING id`,
      [stack.tenantId, stack.leaseId, stack.landlordId, intent])).rows[0].id
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, platform_held)
       VALUES ($1,$2,$3,$4,'deposit',500,'processing',CURRENT_DATE,'DEPOSIT',$5,TRUE) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, intent])).rows[0].id
    await db.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,500)`, [rem, charge])
    const res = await postSucceeded(intent, { gam_remittance_id: rem, gam_lease_id: stack.leaseId, tenant_id: stack.tenantId })
    expect(res.status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [charge])).rows[0].status).toBe('settled')
    expect((await db.query(
      `SELECT collected_amount::float AS c, status, held_by FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0])
      .toEqual({ c: 500, status: 'funded', held_by: heldBy })
    await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QB'`)
  })
})

// ─── Step 9 review (fix pass 2): the landlord hears when the move-out balance charge comes back ──
//
// The payment webhook (routes/webhooks.ts) calls depositReturn.noteGapChargeReturned
// for a move-out balance charge (metadata gam_kind 'deposit_return_gap') that
// fails for good, is canceled in Stripe, or is taken back by a dispute after it
// went through. The generic row handling still runs: the row is payable again.

describe('Step 9 review (fix pass 2): a move-out balance charge that fails or comes back is told to the landlord', () => {
  beforeEach(() => { vi.clearAllMocks(); stripeMocks.made.length = 0 })

  async function postEvent(type: string, object: Record<string, unknown>) {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { webhooksRouter } = await import('../routes/webhooks')
    process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
    const app = express()
    app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
    app.use('/webhooks', webhooksRouter)
    const body = JSON.stringify({ id: `evt_${type}_${randomUUID().slice(0, 8)}`, type, data: { object } })
    return request(app).post('/webhooks/stripe').set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(body)
  }

  /** A $200 move-out balance charged to the tenant's saved card (or bank), left waiting on the webhook. */
  async function chargedGap(method: 'card' | 'ach'): Promise<{ stack: LeaseStack; draftId: string; gapId: string; metadata: Record<string, string> }> {
    if (method === 'ach') stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'us_bank_account' }))
    stripeMocks.paymentIntentsConfirm.mockImplementationOnce(async (id: string) => ({ id, status: 'processing' }))
    try {
      const stack = await buildLeaseStack({ depositTotal: 300, heldBy: 'landlord', cleaningFeeAmount: 500 })
      await db.query(`UPDATE tenants SET stripe_customer_id='cus_gap_test' WHERE id=$1`, [stack.tenantId])
      const draftId = await makeDraft(stack, { totalDeposit: 300, cleaningFeeAmount: 500 })
      const final = await finalizeDepositReturn(draftId, stack.ownerUserId)
      const gapId = final.gap_payment_id!
      expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [gapId])).rows[0].status).toBe('processing')
      return { stack, draftId, gapId, metadata: stripeMocks.made[0].metadata as Record<string, string> }
    } finally {
      stripeMocks.paymentMethodsRetrieve.mockImplementation(async (id: string) => ({ id, type: 'card', card: { country: 'US' } }))
    }
  }
  const draftOf = async (id: string) => (await db.query(
    `SELECT gap_charge_failed, gap_charge_failure_reason FROM deposit_returns WHERE id=$1`, [id])).rows[0]
  const failNotes = async () => (await db.query(
    `SELECT body FROM admin_notifications WHERE category='deposit_return_gap_charge_failed'`)).rows

  it('a bank charge for the move-out balance that fails for good: the row is owed again and the landlord is told it came back unpaid, once', async () => {
    const { draftId, gapId, metadata } = await chargedGap('ach')
    const failed = {
      id: 'pi_gap_test', metadata, payment_method_types: ['us_bank_account'],
      last_payment_error: { code: 'account_closed', message: 'The bank account is closed', payment_method: { type: 'us_bank_account' } },
    }
    expect((await postEvent('payment_intent.payment_failed', failed)).status).toBe(200)
    expect((await db.query(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [gapId])).rows[0])
      .toEqual({ status: 'failed', next_retry_at: null })
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.cameBack('ach') })
    const notes = await failNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toMatch(/payment_intent\.payment_failed/)
    // Stripe redelivers it: the landlord and GAM are not told again.
    expect((await postEvent('payment_intent.payment_failed', failed)).status).toBe(200)
    expect(await failNotes()).toHaveLength(1)
  })

  it('a bank failure that will be tried again tells the landlord nothing yet', async () => {
    const { draftId, gapId, metadata } = await chargedGap('ach')
    const res = await postEvent('payment_intent.payment_failed', {
      id: 'pi_gap_test', metadata, payment_method_types: ['us_bank_account'],
      last_payment_error: { code: 'R01', message: 'Insufficient funds', payment_method: { type: 'us_bank_account' } },
    })
    expect(res.status).toBe(200)
    const row = (await db.query(`SELECT status, next_retry_at IS NOT NULL AS retry FROM payments WHERE id=$1`, [gapId])).rows[0]
    expect(row).toEqual({ status: 'failed', retry: true })
    expect((await draftOf(draftId)).gap_charge_failed).toBe(false)
    expect(await failNotes()).toHaveLength(0)
  })

  it('leftovers fix: a card the bank declines for the move-out balance (payment_failed, card_error): the landlord reads that the card was declined, not the generic words', async () => {
    const { draftId, gapId, metadata } = await chargedGap('card')
    const res = await postEvent('payment_intent.payment_failed', {
      id: 'pi_gap_test', metadata, payment_method_types: ['card'],
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.',
                            payment_method: { type: 'card' } },
    })
    expect(res.status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [gapId])).rows[0].status).toBe('failed')
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.cardDeclined })
  })

  it('a move-out balance charge canceled in Stripe while its row waits: the row is owed again and the landlord is told it did not go through', async () => {
    const { draftId, gapId, metadata } = await chargedGap('card')
    expect((await postEvent('payment_intent.canceled', { id: 'pi_gap_test', metadata, payment_method_types: ['card'] })).status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [gapId])).rows[0].status).toBe('failed')
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.didNotGoThrough('card') })
  })

  it('a move-out balance charge disputed after it went through: the balance is reopened and the landlord is told it came back unpaid', async () => {
    const { draftId, gapId, metadata } = await chargedGap('card')
    const ok = await postEvent('payment_intent.succeeded', {
      id: 'pi_gap_test', metadata, payment_method_types: ['card'],
      latest_charge: { id: 'ch_pi_gap_test', payment_method_details: { type: 'card' } },
    })
    expect(ok.status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [gapId])).rows[0].status).toBe('settled')
    expect((await draftOf(draftId)).gap_charge_failed).toBe(false)

    const disputed = await postEvent('charge.dispute.created', {
      id: 'dp_gap_test', charge: 'ch_pi_gap_test', payment_intent: 'pi_gap_test', amount: 20755, currency: 'usd',
      reason: 'fraudulent', status: 'needs_response', balance_transactions: [{ fee: 1500 }],
    })
    expect(disputed.status).toBe(200)
    const reopened = (await db.query(
      `SELECT p.status FROM payments p JOIN payment_reversals pr ON pr.id = p.reversal_id WHERE pr.payment_id=$1`, [gapId])).rows
    expect(reopened).toEqual([{ status: 'pending' }])
    expect(await draftOf(draftId)).toEqual({ gap_charge_failed: true, gap_charge_failure_reason: GAP_CHARGE_REASON.cameBack('card') })
    const notes = await failNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toMatch(/charge\.dispute\.created dp_gap_test \(fraudulent\)/)
  })

  it('any other charge that fails is never told as a move-out balance', async () => {
    const { draftId } = await chargedGap('card')
    // A rent charge on the same lease, with no move-out metadata.
    const res = await postEvent('payment_intent.canceled', { id: 'pi_some_rent', metadata: {}, payment_method_types: ['card'] })
    expect(res.status).toBe(200)
    expect((await draftOf(draftId)).gap_charge_failed).toBe(false)
  })
})

describe('Step 9 review (fix pass 2): what the credit ledger lets a move-out spend', () => {
  it('only deposit interest on the move-out’s own lease joins it — landlord-issued credit never does', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    const draftId = await makeDraft(stack, { totalDeposit: 500 })
    const credit = async (category: string) => (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,25,25,$4) RETURNING id`,
      [stack.landlordId, stack.tenantId, stack.leaseId, category])).rows[0].id
    const moveOutUse = (creditId: string) => db.query(
      `INSERT INTO credit_uses (tenant_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,25,date_trunc('month', CURRENT_DATE)::date,'move_out','applied',now())`,
      [creditId, draftId, stack.leaseId])
    await expect(moveOutUse(await credit('goodwill'))).rejects.toThrow(/Only deposit interest on this lease joins its move-out/)
    await moveOutUse(await credit('deposit_interest'))
    expect((await db.query(
      `SELECT amount_remaining::float AS r FROM tenant_credits WHERE category='deposit_interest'`)).rows[0].r).toBe(0)
  })
})

// ─── 10/4 (decisions #46.2, Nic, FINAL): the deposit pays the deductions first ──

describe('decision #46.2: move-out deductions come out of the deposit first; paid-ahead money pays only what the deposit cannot', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('$500 deposit, $300 paid ahead, $40 cleaning → refund $460, paid-ahead used $0, $300 left', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const credit = await paidAhead(stack, 300)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ refund_amount: 460, gap_amount: 0, prepaid_credit_used: 0, prepaid_credit_left: 300 })
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.refund_amount)).toBe(460)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 460, expectedGap: 0 })
    expect(final).toMatchObject({ status: 'sent_refund', gap_payment_id: null })
    expect(Number(final.refund_amount)).toBe(460)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses`)).rows[0].n).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(300)
  })

  it('$500 deposit, $300 paid ahead, $650 damage → refund $0, paid-ahead used $150, $150 left, no gap charge', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const older = await paidAhead(stack, 100)
    const newer = await paidAhead(stack, 200)
    await db.query(`UPDATE lease_prepaid_credits SET created_at = NOW() - interval '10 days' WHERE id=$1`, [older])
    const damage = [{ description: 'Broken door', amount: 650 }]
    const calc = await calculateDepositReturn(stack.leaseId, damage)
    expect(calc).toMatchObject({ refund_amount: 0, gap_amount: 0, prepaid_credit_used: 150, prepaid_credit_left: 150 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const { applyDeductionsToDraft } = await import('./depositReturn')
    await applyDeductionsToDraft(draft.id, { damageLines: damage })
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 0, expectedGap: 0 })
    expect(final.status).toBe('sent_zero')
    expect(final.gap_payment_id).toBeNull()
    // Only the $150 beyond the deposit is spent — oldest credit first.
    const uses = (await db.query(
      `SELECT prepaid_credit_id, amount::float AS amount, source FROM credit_uses ORDER BY amount DESC`)).rows
    expect(uses).toEqual([
      { prepaid_credit_id: older, amount: 100, source: 'move_out' },
      { prepaid_credit_id: newer, amount: 50, source: 'move_out' },
    ])
    const left = (await db.query(`SELECT id, amount_remaining::float AS r FROM lease_prepaid_credits`)).rows
    expect(Object.fromEntries(left.map((x: any) => [x.id, x.r]))).toEqual({ [older]: 0, [newer]: 150 })
  })

  it('$500 deposit, $100 paid ahead, $800 damage → refund $0, $100 used, $200 gap charge', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await paidAhead(stack, 100)
    const damage = [{ description: 'Carpet', amount: 800 }]
    const calc = await calculateDepositReturn(stack.leaseId, damage)
    expect(calc).toMatchObject({ refund_amount: 0, gap_amount: 200, prepaid_credit_used: 100, prepaid_credit_left: 0 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const { applyDeductionsToDraft } = await import('./depositReturn')
    await applyDeductionsToDraft(draft.id, { damageLines: damage })
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(final.status).toBe('sent_gap')
    expect(Number(final.gap_amount)).toBe(200)
    const gap = (await db.query(`SELECT amount::float AS amount, status FROM payments WHERE id=$1`, [final.gap_payment_id])).rows[0]
    expect(gap).toEqual({ amount: 200, status: 'pending' })
    expect((await db.query(`SELECT COALESCE(SUM(amount), 0)::float AS t FROM credit_uses WHERE source='move_out'`)).rows[0].t).toBe(100)
  })

  it('deposit interest still owed is on the deposit side too: it pays deductions before any paid-ahead money', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, interestAccrued: 20, cleaningFeeAmount: 510 })
    const credit = await paidAhead(stack, 50)
    const calc = await calculateDepositReturn(stack.leaseId)
    // 500 + 20 interest pays the 510; $10 back; the $50 untouched.
    expect(calc).toMatchObject({ refund_amount: 10, prepaid_credit_used: 0, prepaid_credit_left: 50 })
    const draftId = await makeDraft(stack, { totalDeposit: 500, cleaningFeeAmount: 510 })
    await finalizeDepositReturn(draftId, stack.ownerUserId)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(50)
  })
})

// ─── Deposit-page review: one move-out fee source, checked at the moment of action ──

describe('deposit-page review: finalize pays the live move-out fees and checks the figures the confirm showed under its locks', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('a conditional fee the walkthrough marks failed after Begin Move-Out: the draft, its confirm and finalize all count it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const carpet = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, condition_text)
       VALUES ($1, 'other_fee', 75, 'other', FALSE, 'Carpets cleaned within 3 days of move-out') RETURNING id`,
      [stack.leaseId])).rows[0].id
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.refund_amount)).toBe(460)                         // unassessed: no charge
    await db.query(`UPDATE lease_fees SET condition_result='failed' WHERE id=$1`, [carpet])
    expect((await calculateDepositReturn(stack.leaseId))!.refund_amount).toBe(385)
    const { applyDeductionsToDraft } = await import('./depositReturn')
    const saved = await applyDeductionsToDraft(draft.id, {})
    expect(Number(saved!.cleaning_fee_amount)).toBe(115)                  // the stored figure is refreshed
    expect(Number(saved!.refund_amount)).toBe(385)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 385, expectedGap: 0 })
    expect(Number(final.refund_amount)).toBe(385)
    expect(Number(final.cleaning_fee_amount)).toBe(115)
  })

  it('a move-out fee edited after the confirm opened: finalize refuses under its locks with the plain-words 409, and nothing is written', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    const draft = await createOrFetchDraft(stack.leaseId)
    await db.query(`UPDATE lease_fees SET amount = 65 WHERE lease_id=$1 AND due_timing='move_out'`, [stack.leaseId])
    const { FIGURES_CHANGED_MESSAGE } = await import('./depositReturn')
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 460, expectedGap: 0 }))
      .rejects.toThrow(FIGURES_CHANGED_MESSAGE)
    const row = (await db.query(`SELECT status, finalized_at FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0]
    expect(row).toEqual({ status: 'draft', finalized_at: null })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE lease_id=$1`, [stack.leaseId])).rows[0].n).toBe(0)
  })
})

// ─── 10/4 (decisions #46.3, Nic, FINAL): whoever holds a deposit refunds it ──

describe('decision #46.3: each deposit is refunded by whoever holds it', () => {
  beforeEach(() => { vi.clearAllMocks() })
  // A made-up state GAM may hold deposits in. cleanupAllSchema keeps the
  // custody catalog, so the row goes again after each test (another file uses
  // its own made-up states for the fail-closed rule).
  afterEach(async () => { await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QA'`) })
  async function supportedState(stack: LeaseStack) {
    await db.query(`UPDATE properties SET state='QA' WHERE id=$1`, [stack.propertyId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('QA', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported'`)
  }

  it('security deposit paid at the desk (the landlord holds it) and a pet deposit paid through GAM: GAM refunds the $200 pet deposit, the landlord hands back the $500 themselves, nothing is released or netted', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await supportedState(stack)
    await depositPayment(stack, { amount: 500, via: 'desk' })
    await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam', description: 'Dog deposit' })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ refund_amount: 700, refund_from_gam: 200, refund_from_landlord: 500 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number((final as any).refund_from_gam)).toBe(200)
    expect(Number((final as any).refund_from_landlord)).toBe(500)
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('the same with $600 of deductions: they come out of the $500 the landlord holds first, then $100 of the pet deposit GAM holds goes to the landlord; GAM refunds the $100 left', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 600 })
    await supportedState(stack)
    await depositPayment(stack, { amount: 500, via: 'desk' })
    await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(100)
    expect(Number((final as any).refund_from_gam)).toBe(100)
    expect(Number((final as any).refund_from_landlord)).toBe(0)
    const items = await heldItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source_type: 'deposit_settlement', source_id: `kept:${draft.id}`, amount: 100 })
    expect(items[0].description).toMatch(/deposit money paid online, kept for the move-out deductions — released to you/)
    // decisions #47c (Nic): never who holds the deposit, on any line a landlord reads.
    expect(items[0].description).not.toMatch(/GAM held|you hold|held by/)
  })

  it('a GAM escrow deposit partly paid through GAM and topped up at the desk: GAM refunds its part, the landlord theirs', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    await depositPayment(stack, { amount: 300, via: 'gam' })
    await depositPayment(stack, { amount: 200, via: 'desk' })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ refund_amount: 500, refund_from_gam: 300, refund_from_landlord: 200 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number((final as any).refund_from_gam)).toBe(300)
    expect(Number((final as any).refund_from_landlord)).toBe(200)
    expect(await heldItems()).toEqual([])                      // never netted from the landlord
  })
})

// ─── 10/4 (decisions #46.4, Nic, FINAL): an unpaid deposit is zeroed when the lease ends ──

describe('decision #46.4: a deposit, or up-front rent paid ahead, the tenant never paid is closed at move-out — never deducted', () => {
  beforeEach(() => { vi.clearAllMocks() })
  async function boxCharge(stack: LeaseStack, o: { feeType: string; amount: number; kind: 'deposit' | 'prepaid' | 'fee'; refundable?: boolean }) {
    const feeId = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
       VALUES ($1,$2,$3,'move_in',$4,$5) RETURNING id`,
      [stack.leaseId, o.feeType, o.amount.toFixed(2), o.refundable ?? o.kind !== 'fee', o.kind])).rows[0].id
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             lease_fee_id, revenue_owner)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_DATE - 40,$7,$8,$9) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId,
       o.kind === 'deposit' ? 'deposit' : 'fee', o.amount.toFixed(2),
       o.kind === 'deposit' ? 'DEPOSIT' : o.feeType === 'last_month_rent' ? 'RENT' : 'SUBSCRIP', feeId,
       o.kind === 'prepaid' ? 'held' : 'landlord'])).rows[0].id
  }
  const rowOf = async (id: string) => (await db.query(
    `SELECT status, amount::float AS amount, notes FROM payments WHERE id=$1`, [id])).rows[0]

  it('an unpaid security deposit, an unpaid pet deposit and an unpaid up-front last month’s rent close at $0 with a plain note; unpaid rent and a non-refundable fee still go on the final bill', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: 'landlord' })
    await db.query(`UPDATE security_deposits SET status='pending' WHERE id=$1`, [stack.depositId])
    const security = await openLine(stack, { amount: 500, type: 'deposit', entry: 'DEPOSIT' })
    const pet = await boxCharge(stack, { feeType: 'pet_deposit', amount: 200, kind: 'deposit' })
    const lastMonth = await boxCharge(stack, { feeType: 'last_month_rent', amount: 1000, kind: 'prepaid' })
    const petFee = await boxCharge(stack, { feeType: 'pet_fee', amount: 35, kind: 'fee', refundable: false })
    const rent = await openLine(stack, { amount: 1000 })

    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc!.closed_at_move_out_total).toBe(1700)
    expect(calc!.closed_at_move_out_lines.map((l) => [l.payment_id, l.kind, l.amount]).sort())
      .toEqual([[security, 'deposit', 500], [pet, 'deposit', 200], [lastMonth, 'prepaid', 1000]].sort())
    // Never deducted: only the rent and the pet fee are swept.
    expect(calc!.unpaid_balance_total).toBe(1035)
    expect(calc!.gap_amount).toBe(1035)

    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.gap_amount)).toBe(1035)
    for (const id of [security, pet]) {
      expect(await rowOf(id)).toMatchObject({ status: 'settled', amount: 0 })
      expect((await rowOf(id)).notes).toMatch(/Closed at move-out: this deposit was never paid, and a deposit is only ever refunded — it is no longer owed/)
    }
    expect(await rowOf(lastMonth)).toMatchObject({ status: 'settled', amount: 0 })
    expect((await rowOf(lastMonth)).notes).toMatch(/Closed at move-out: this last month’s rent due up front was never paid, and the months it was for are billed as ordinary rent — it is no longer owed/)
    // Closing a never-paid box banks nothing as paid-ahead money.
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM lease_prepaid_credits`)).rows[0].n).toBe(0)
    expect((await rowOf(rent)).status).toBe('paid_via_deposit')
    expect((await rowOf(petFee)).status).toBe('paid_via_deposit')
  })

  it('money already paid is never touched: a settled deposit is refunded, only the unpaid one closes', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const paid = await depositPayment(stack, { amount: 500, via: 'desk' })
    const unpaidKey = await boxCharge(stack, { feeType: 'key_deposit', amount: 50, kind: 'deposit' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(500)
    expect(await rowOf(paid)).toMatchObject({ status: 'settled', amount: 500 })
    expect(await rowOf(unpaidKey)).toMatchObject({ status: 'settled', amount: 0 })
  })

  it('a deposit payment that bounced and is not being tried again closes too; one whose money is on its way blocks finalize instead', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: 'landlord' })
    const bounced = await openLine(stack, { amount: 500, type: 'deposit', entry: 'DEPOSIT', status: 'failed', intent: 'pi_dep_bounced' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(await rowOf(bounced)).toMatchObject({ status: 'settled', amount: 0 })

    const other = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: 'landlord' })
    await openLine(other, { amount: 500, type: 'deposit', entry: 'DEPOSIT', status: 'processing', intent: 'pi_dep_clearing' })
    const d2 = await createOrFetchDraft(other.leaseId)
    await expect(finalizeDepositReturn(d2.id, other.ownerUserId)).rejects.toThrow(/still clearing/)
  })

  it('the household balance and Outstanding Balances no longer show a closed line', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: 'landlord' })
    await db.query(`UPDATE security_deposits SET status='pending' WHERE id=$1`, [stack.depositId])
    await openLine(stack, { amount: 500, type: 'deposit', entry: 'DEPOSIT' })
    const { listOpenTenantBalances, openBalanceSql } = await import('./openBalances')
    const owedRows = async () => (await db.query(
      `SELECT COUNT(*)::int AS n FROM payments p WHERE p.lease_id = $1 AND ${openBalanceSql('p')}`, [stack.leaseId])).rows[0].n
    expect(await owedRows()).toBe(1)
    expect((await listOpenTenantBalances({ landlordIds: [stack.landlordId] })).map((b) => b.tenant_id)).toContain(stack.tenantId)
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(await owedRows()).toBe(0)
    expect((await listOpenTenantBalances({ landlordIds: [stack.landlordId] })).map((b) => b.tenant_id)).not.toContain(stack.tenantId)
  })
})


// ─── Step 9 review (fix pass 2) ─────────────────────────────────────────────

describe('step 9 review (fix pass 2): a deposit the bank sent back is not refunded by GAM, and its reopened line closes', () => {
  beforeEach(() => { vi.clearAllMocks() })

  /** The $500 deposit paid through GAM, then sent back: the original row 'returned', a fresh unpaid row reopened. */
  async function returnedDeposit(stack: LeaseStack): Promise<{ original: string; reopened: string; reversal: string }> {
    const original = await depositPayment(stack, { amount: 500, via: 'gam' })
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [original])
    const reversal = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, recovery_status, status)
       VALUES ($1,$2,$3,$4,'ach_return',500,$5,'{}'::jsonb,'not_needed','open') RETURNING id`,
      [original, stack.landlordId, stack.tenantId, stack.leaseId, `evt_${randomUUID().slice(0, 8)}`])).rows[0].id
    const reopened = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             revenue_owner, reversal_id)
       VALUES ($1,$2,$3,$4,'deposit',500,'pending',CURRENT_DATE - 30,'DEPOSIT','landlord',$5) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, reversal])).rows[0].id
    return { original, reopened, reversal }
  }

  it('a $500 deposit paid through GAM, sent back by the bank and never paid again: move-out refunds $0 from GAM and closes the reopened line', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    const r = await returnedDeposit(stack)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ total_deposit: 0, refund_amount: 0, gap_amount: 0, refund_from_gam: 0, refund_from_landlord: 0 })
    expect(calc!.closed_at_move_out_lines.map((l) => [l.payment_id, l.kind, l.amount])).toEqual([[r.reopened, 'deposit', 500]])
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 0, expectedGap: 0 })
    expect(final.status).toBe('sent_zero')
    expect(final.refund_payment_id).toBeNull()
    expect(Number((final as any).refund_from_gam)).toBe(0)
    const reopened = (await db.query(`SELECT status, amount::float AS amount, notes FROM payments WHERE id=$1`, [r.reopened])).rows[0]
    expect(reopened).toMatchObject({ status: 'settled', amount: 0 })
    expect(reopened.notes).toMatch(/Closed at move-out: this deposit was never paid/)
    expect((await db.query(`SELECT status FROM payment_reversals WHERE id=$1`, [r.reversal])).rows[0].status).toBe('resolved')
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('a reversal still recovering from the landlord is left as it is when its reopened deposit line closes', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow' })
    const r = await returnedDeposit(stack)
    await db.query(`UPDATE payment_reversals SET recovery_status = 'pending' WHERE id=$1`, [r.reversal])
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect((await db.query(`SELECT status FROM payment_reversals WHERE id=$1`, [r.reversal])).rows[0].status).toBe('open')
  })

  it('the reopened deposit paid again at the desk: the record is not raised a second time, and the landlord refunds the $500 they now hold', async () => {
    const stack = await buildLeaseStack({ depositTotal: 600, depositCollected: 500, heldBy: 'gam_escrow' })
    await db.query(`UPDATE security_deposits SET status='partial' WHERE id=$1`, [stack.depositId])
    const r = await returnedDeposit(stack)
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='cash' WHERE id=$1`, [r.reopened])
    const { reconcileSettledDepositPayment } = await import('./leaseFeesSync')
    const raised = await reconcileSettledDepositPayment(r.reopened)
    expect(raised).toMatchObject({ amount: 0, heldBy: 'landlord' })
    const rec = (await db.query(`SELECT collected_amount::float AS c, held_by FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0]
    expect(rec).toEqual({ c: 500, held_by: 'landlord' })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({
      total_deposit: 500, refund_amount: 500, refund_from_gam: 0, refund_from_landlord: 500, closed_at_move_out_total: 0,
    })
  })
})

describe('step 9 review (fix pass 2): one rule for who collected a deposit — the record and the refund split agree', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(async () => { await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QB'`) })

  it.each([
    ['a card or bank payment through GAM (on GAM’s balance)', { platformHeld: true, intent: true, manual: null }, 'gam_escrow', { refund_from_gam: 500, refund_from_landlord: 0 }],
    ['a card payment whose money went straight to the landlord (not on GAM’s balance)', { platformHeld: false, intent: true, manual: null }, 'landlord', { refund_from_gam: 0, refund_from_landlord: 500 }],
    ['cash at the desk', { platformHeld: false, intent: false, manual: 'cash' }, 'landlord', { refund_from_gam: 0, refund_from_landlord: 500 }],
    ['a check at the desk', { platformHeld: false, intent: false, manual: 'check' }, 'landlord', { refund_from_gam: 0, refund_from_landlord: 500 }],
  ] as const)('%s', async (_what, how, heldBy, split) => {
    const stack = await buildLeaseStack({ depositTotal: 500, depositCollected: 0, heldBy: 'gam_escrow' })
    await db.query(`UPDATE security_deposits SET status='pending' WHERE id=$1`, [stack.depositId])
    await db.query(`UPDATE properties SET state='QB' WHERE id=$1`, [stack.propertyId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('QB', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported'`)
    const tag = randomUUID().slice(0, 8)
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             revenue_owner, settled_at, platform_held, manual_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'deposit',500,'settled',CURRENT_DATE - 30,'DEPOSIT','landlord',NOW(),$5,$6,$7) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, how.platformHeld, how.manual,
       how.intent ? `pi_${tag}` : null])).rows[0].id
    const { reconcileSettledDepositPayment } = await import('./leaseFeesSync')
    await reconcileSettledDepositPayment(pay)
    expect((await db.query(`SELECT held_by FROM security_deposits WHERE id=$1`, [stack.depositId])).rows[0].held_by).toBe(heldBy)
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ refund_amount: 500, ...split })
  })
})

describe('step 9 review (fix pass 2): with no deposit record, only deposit money that settled is counted', () => {
  it('the lease’s $500 deposit fee is not money held: $0 deposit, $0 back', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    await db.query(`DELETE FROM security_deposits WHERE id=$1`, [stack.depositId])
    const c = await getClient()
    try { await seedLeaseFee(c, { leaseId: stack.leaseId, feeType: 'security_deposit', amount: 500, dueTiming: 'move_in' }) }
    finally { c.release() }
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ total_deposit: 0, refund_amount: 0 })
  })

  it('a $500 security deposit paid at the desk with no record: counted, and the landlord refunds it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500 })
    await db.query(`DELETE FROM security_deposits WHERE id=$1`, [stack.depositId])
    await depositPayment(stack, { amount: 500, via: 'desk' })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({
      total_deposit: 500, refund_amount: 500, refund_from_gam: 0, refund_from_landlord: 500,
    })
  })
})

describe('step 9 review (fix pass 2): a carried-forward deposit follows #46.2 — what it cannot cover comes from the pet, key and cleaning deposits, then the paid-ahead money', () => {
  beforeEach(() => { vi.clearAllMocks() })
  async function carried(stack: LeaseStack) {
    await db.query(`UPDATE security_deposits SET portability_status='authorized', portability_authorized_at=NOW() WHERE id=$1`, [stack.depositId])
  }

  it('$300 paid ahead and deductions $200 more than the $500 deposit: no shortfall charge, $200 of the paid-ahead money used, $100 left', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 700 })
    await carried(stack)
    const credit = await paidAhead(stack, 300)
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({
      refund_amount: 0, gap_amount: 0, prepaid_credit_used: 200, prepaid_credit_left: 100,
    })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 0, expectedGap: 0 })
    expect(final).toMatchObject({ status: 'sent_carried_forward', gap_payment_id: null })
    expect((await db.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM credit_uses WHERE source='move_out'`)).rows[0].t).toBe(200)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(100)
    const alert = (await db.query(`SELECT body FROM admin_notifications WHERE category='deposit_carry_forward_paid_ahead_left'`)).rows
    expect(alert[0].body).toMatch(/\$100\.00 of money they paid ahead/)
  })

  it('a pet deposit pays before the paid-ahead money; what is beyond both is the shortfall', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 900 })
    await carried(stack)
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'gam' })
    await paidAhead(stack, 100)
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ gap_amount: 100, prepaid_credit_used: 100, prepaid_credit_left: 0 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.gap_amount)).toBe(100)
    // The $200 pet deposit GAM held paid landlord A's deductions: released to them, no longer counted as held.
    expect((await heldItems()).map((i: any) => [i.source_type, i.source_id, i.amount]))
      .toEqual([['deposit_settlement', `kept:${draft.id}`, 200]])
    expect((await db.query(`SELECT platform_held FROM payments WHERE id=$1`, [pet])).rows[0].platform_held).toBe(false)
    // Nothing of it is left on the old lease to tell GAM about.
    const alert = (await db.query(`SELECT context FROM admin_notifications WHERE category='deposit_carry_forward_paid_ahead_left'`)).rows
    expect(alert).toHaveLength(0)
  })

  it('a pet deposit the deductions only partly take: the rest stays on the old lease and GAM is told', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 550 })
    await carried(stack)
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 200, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(await heldItems()).toEqual([])                       // the landlord holds it — nothing moves
    const alert = (await db.query(`SELECT context FROM admin_notifications WHERE category='deposit_carry_forward_paid_ahead_left'`)).rows
    expect(alert[0].context).toMatchObject({ deposits: [{ payment_id: pet, amount: 150, gam_held: false }], deposits_amount: 150 })
  })
})

describe('decisions #48.6: finalize waits while ANY payment on the tenancy is still clearing, and says when it should clear', () => {
  it('a rent payment still clearing (not a deposit) holds up the move-out, naming it, the day it was made and the day it should clear; once it settles, finalize goes through', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const rent = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, platform_held, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE - 2,'RENT','pi_rent_clearing',TRUE, NOW() - INTERVAL '1 day') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,450,450,0,'ach','pi_rent_clearing', NOW() - INTERVAL '1 day')`,
      [stack.tenantId, stack.leaseId, stack.landlordId])
    const draft = await createOrFetchDraft(stack.leaseId)
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toMatch(/^A \$450\.00 bank payment toward rent, made [A-Z][a-z]{2} \d{1,2}, \d{4}, is still clearing, so the move-out can’t be finalized yet\. It should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(said!.words)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category='deposit_payment_stuck_at_move_out'`)).rows[0].n).toBe(0)
    // It clears: nothing is in flight, so finalize goes through.
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [rent])
    expect(await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)).toBeNull()
    expect((await finalizeDepositReturn(draft.id, stack.ownerUserId)).status).toBe('sent_refund')
  })

  it('a bank payment clears in five business days from the day it was made — never a weekend day counted', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    // Made on a Friday (2026-10-02): five business days later is Friday 2026-10-09.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'utility',80,'processing','2026-10-01','UTILITY','pi_util_clearing', '2026-10-02T18:00:00Z')`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,80,80,0,'ach','pi_util_clearing', '2026-10-02T18:00:00Z')`,
      [stack.tenantId, stack.leaseId, stack.landlordId])
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toBe('A $80.00 bank payment toward a utility bill, made Oct 2, 2026, is still clearing, so the move-out can’t be finalized yet. ' +
      'It should clear by Oct 9, 2026. Finalize once it clears or fails.')
  })

  it('two payments clearing on the tenancy (one a deposit payment set to be tried again): both named, with the last day either should clear', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE,'RENT','pi_two_a', NOW()),
              ($1,$2,$3,$4,'deposit',60,'failed',CURRENT_DATE,'DEPOSIT','pi_two_b', NOW())`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    await db.query(`UPDATE payments SET next_retry_at = NOW() + INTERVAL '3 days' WHERE stripe_payment_intent_id = 'pi_two_b'`)
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(
      /^2 payments on this tenancy are still clearing — \$450\.00 toward rent and \$60\.00 toward the security deposit \(to be tried again [A-Z][a-z]{2} \d{1,2}, \d{4}\) — so the move-out can’t be finalized yet\. The last should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once they clear or fail\.$/)
  })

  it('a payment on a bill of the lease (a line with no lease of its own) counts too', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,40) RETURNING id`,
      [stack.landlordId, stack.tenantId, stack.leaseId, stack.unitId, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'processing',CURRENT_DATE,'UTILITY','pi_on_bill', NOW())`,
      [inv, stack.unitId, stack.tenantId, stack.landlordId])
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(/^A \$40\.00 payment toward a utility bill/)
  })
})

describe('decisions #48.6 (fix pass 3): a payment toward money paid ahead still clearing holds the move-out too', () => {
  /** A card payment made when nothing was owed (rentCharge's pay-ahead): a receipt with no bill line, all of it unapplied. */
  const payAheadReceipt = async (stack: LeaseStack, o: { method: 'card' | 'ach'; amount: number; madeAgo: string; intent: string }) =>
    (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method,
                                       stripe_payment_intent_id, status, created_at)
       VALUES ($1,$2,$3,$4,0,$4,$5,$6,'processing', NOW() - $7::interval) RETURNING id`,
      [stack.tenantId, stack.leaseId, stack.landlordId, o.amount, o.method, o.intent, o.madeAgo])).rows[0].id

  it('finalize is refused with the clear-by words while it clears; once it settles it is in the move-out pool, left for the landlord’s refund choice', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const rem = await payAheadReceipt(stack, { method: 'card', amount: 300, madeAgo: '1 hour', intent: 'pi_pay_ahead_clearing' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toMatch(/^A \$300\.00 card payment toward money paid ahead, made [A-Z][a-z]{2} \d{1,2}, \d{4}, is still clearing, so the move-out can’t be finalized yet\. It should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(said!.words)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')

    // It settles the way the webhook's surplus rule banks it: the receipt settled, its money paid-ahead credit on the lease.
    const { createPaidAhead } = await import('./creditUse')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE tenant_remittances SET status='settled', settled_at=NOW() WHERE id=$1`, [rem])
      await createPaidAhead(c, { leaseId: stack.leaseId, tenantId: stack.tenantId, amount: 300, fundedBy: 'gam',
        receivedAt: new Date(), sourceRemittanceId: rem, note: 'Paid ahead through GAM' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect(await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)).toBeNull()
    const figures = await calculateDepositReturn(stack.leaseId)
    expect(figures!.prepaid_credit_remaining).toBe(300)
    expect(figures!.prepaid_credit_left).toBe(300)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    // Never refunded here: it stays the tenant's paid-ahead money on the lease for the landlord's choice (#46.1).
    expect((await db.query(`SELECT amount_remaining::float AS left FROM lease_prepaid_credits WHERE source_remittance_id=$1`, [rem])).rows[0].left).toBe(300)
  })

  it('a bank payment toward money paid ahead: “bank”, five business days to clear', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await payAheadReceipt(stack, { method: 'ach', amount: 120, madeAgo: '1 hour', intent: 'pi_pay_ahead_bank' })
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toMatch(/^A \$120\.00 bank payment toward money paid ahead, made /)
    expect(said!.stuck).toEqual([])
  })

  it('a receipt that paid a bill and carried extra ahead: the bill line and the extra are both named, never the same money twice', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const rent = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE,'RENT','pi_rent_plus_ahead') RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,500,450,50,'ach','pi_rent_plus_ahead') RETURNING id`,
      [stack.tenantId, stack.leaseId, stack.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,450)`, [rem, rent])
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toMatch(/^2 payments on this tenancy are still clearing — \$450\.00 toward rent and \$50\.00 toward money paid ahead — /)
  })

  it('one waiting more than a week: GAM is told, the same words as any stuck payment', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const rem = await payAheadReceipt(stack, { method: 'ach', amount: 80, madeAgo: '9 days', intent: 'pi_pay_ahead_stuck' })
    const { tenancyPaymentsClearing, STUCK_DEPOSIT_PAYMENT_MESSAGE } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toBe(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    expect(said!.stuck.map(r => ({ id: r.id, intent: r.intent }))).toEqual([{ id: rem, intent: 'pi_pay_ahead_stuck' }])
  })
})

describe('decisions #48.6 (fix pass 2): the clearing words are never a dead end', () => {
  it('a payment waiting more than a week: the words say GAM has been told — never a clear-by day long gone', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE - 10,'RENT','pi_rent_stuck', NOW() - INTERVAL '9 days')`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    const { tenancyPaymentsClearing, STUCK_DEPOSIT_PAYMENT_MESSAGE } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.words).toBe(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    expect(said!.stuck).toHaveLength(1)
    expect(said!.words).not.toMatch(/should clear by/)
  })

  it('a card payment still processing past its clear-by day (not yet a week): “should have cleared by”, never “should clear by” a day gone', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE - 6,'RENT','pi_card_late', NOW() - INTERVAL '6 days')`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,450,450,0,'card','pi_card_late', NOW() - INTERVAL '6 days')`,
      [stack.tenantId, stack.leaseId, stack.landlordId])
    const { tenancyPaymentsClearing } = await import('./depositReturn')
    const said = await tenancyPaymentsClearing((t, v) => db.query(t, v), stack.leaseId)
    expect(said!.stuck).toHaveLength(0)
    expect(said!.words).toMatch(/^A \$450\.00 card payment toward rent, made [A-Z][a-z]{2} \d{1,2}, \d{4}, is still clearing, so the move-out can’t be finalized yet\. It should have cleared by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
  })

  it('the clear-by day skips bank holidays as well as weekends', async () => {
    const { addBusinessDays } = await import('./depositReturn')
    // Thu Oct 8, 2026 + 5: Fri 9, (Mon 12 is Columbus Day), Tue 13, Wed 14, Thu 15, Fri 16.
    expect(addBusinessDays('2026-10-08', 5)).toBe('2026-10-16')
    // Wed Nov 25, 2026 + 2: (Thu 26 is Thanksgiving), Fri 27, Mon 30.
    expect(addBusinessDays('2026-11-25', 2)).toBe('2026-11-30')
    // An ordinary week is unchanged: Fri Oct 2 + 5 = Fri Oct 9.
    expect(addBusinessDays('2026-10-02', 5)).toBe('2026-10-09')
  })

  it('a bank retry the move-out stops that also carried another lease’s line: GAM is told by name, once, at finalize', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    // Another lease of the same household, with a line on the same bank pull.
    const otherLease = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, status, start_date, lease_type)
       SELECT unit_id, landlord_id, 300, 'active', CURRENT_DATE - 30, lease_type FROM leases WHERE id = $1 RETURNING id`, [stack.leaseId])).rows[0].id
    const [mine, theirs] = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, next_retry_at, retry_count)
       VALUES ($1,$2,$3,$4,'rent',100,'failed',CURRENT_DATE - 3,'RENT','pi_shared_retry', NOW() + INTERVAL '2 days', 0),
              ($1,$5,$3,$4,'rent',70,'failed',CURRENT_DATE - 3,'RENT','pi_shared_retry', NOW() + INTERVAL '2 days', 0)
       RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, otherLease])).rows.map(r => r.id)
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [mine])).rows[0].status).toBe('paid_via_deposit')
    expect((await db.query(`SELECT status, next_retry_at FROM payments WHERE id = $1`, [theirs])).rows[0])
      .toEqual({ status: 'failed', next_retry_at: null })
    const notes = (await db.query(
      `SELECT title, context FROM admin_notifications WHERE category = 'move_out_stopped_shared_retry'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('A move-out stopped a bank retry that also paid another lease')
    expect(notes[0].context.payment_ids).toEqual([theirs])
  })
})

describe('step 9 review (fix pass 2): finalize waits while an up-front last month’s rent payment is still clearing', () => {
  it('a prepaid box payment processing: finalize refuses in plain words, nothing written', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const feeId = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
       VALUES ($1,'last_month_rent',1000,'move_in',FALSE,'prepaid') RETURNING id`, [stack.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             lease_fee_id, revenue_owner, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'fee',1000,'processing',CURRENT_DATE - 2,'RENT',$5,'held','pi_lmr_clearing')`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, feeId])
    const draft = await createOrFetchDraft(stack.leaseId)
    await expect(finalizeDepositReturn(draft.id, stack.ownerUserId)).rejects.toThrow(
      /^A \$1000\.00 payment toward last month’s rent \(paid up front\), made .+, is still clearing, so the move-out can’t be finalized yet\. It should clear by .+\./)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE id=$1`, [draft.id])).rows[0].status).toBe('draft')
  })
})

// Step 9 review (fix pass 3) + final fix (fix pass 1): every dollar counted
// once in GAM's own balance book (stripeCosts.loadPlatformBalanceBook). Before
// a move-out each settled deposit payment GAM took (platform_held) is a
// deposit GAM holds. Finalize clears platform_held on the payments it used up:
// the part the deductions kept rides a held item or the escrow transfer, and
// the rest is the refund GAM still owes the tenant (deposit_returns
// .refund_from_gam, its refund row pending) — counted on its own liability
// line inside depositsInTrust until it is sent. Before fix pass 1 that refund
// was counted nowhere and read as GAM's own money.
describe('after a move-out GAM’s book counts each deposit dollar once: kept items plus the refunds GAM still owes', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const book = async () => {
    const { loadPlatformBalanceBook } = await import('./stripeCosts')
    const b = await loadPlatformBalanceBook()
    return { inTrust: b.depositsInTrust, held: b.heldItemsOwed }
  }
  const gamMayHoldHere = async (stack: LeaseStack) => {
    await db.query(`UPDATE properties SET state = 'XZ' WHERE id = $1`, [stack.propertyId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('XZ', 'supported', TRUE, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status = 'supported', allows_treasury_bills = TRUE`)
  }

  it('a $300 pet deposit paid through GAM on a landlord-held record, $650 of deductions: the $150 kept item and the $150 GAM owes are all GAM holds — the pet payment no longer counts too', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 650 })
    await gamMayHoldHere(stack)
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 300, via: 'gam' })
    expect(await book()).toEqual({ inTrust: 300, held: 0 })      // before: the $300 GAM took, held in trust
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    // 800 held (500 the landlord's, 300 GAM's), 650 kept: 500 from the landlord's, 150 from GAM's.
    expect(final).toMatchObject({ status: 'sent_refund' })
    expect(Number(final.refund_amount)).toBe(150)
    expect(Number((final as any).refund_from_gam)).toBe(150)
    expect(Number((final as any).refund_from_landlord)).toBe(0)
    expect((await heldItems()).map((i: any) => [i.source_type, i.source_id, i.amount]))
      .toEqual([['deposit_settlement', `kept:${draft.id}`, 150]])
    expect((await db.query(`SELECT platform_held FROM payments WHERE id = $1`, [pet])).rows[0].platform_held).toBe(false)
    const b = await book()
    expect(b).toEqual({ inTrust: 150, held: 150 })                // the refund GAM owes + the kept item
    expect(b.inTrust + b.held).toBe(300)                          // exactly the $300 GAM took in
  })

  it('a $500 security deposit paid through GAM on a GAM-escrow record, $100 cleaning: GAM’s book still holds the $400 it owes back, never $0', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 100 })
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [stack.landlordId])
    const sec = await depositPayment(stack, { amount: 500, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number(final.refund_amount)).toBe(400)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)  // the $100 kept goes to the landlord
    expect((stripeMocks.transfersCreate.mock.calls[0] as [any])[0]).toMatchObject({ amount: 10000 })
    expect((await db.query(`SELECT platform_held FROM payments WHERE id = $1`, [sec])).rows[0].platform_held).toBe(false)
    expect(await book()).toEqual({ inTrust: 400, held: 0 })
  })

  it('the refund GAM owes leaves the book only when its refund parts actually go back — never because the refund row alone reads settled', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 100 })
    await depositPayment(stack, { amount: 500, via: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(await book()).toMatchObject({ inTrust: 400 })
    // The refund row marked settled by hand while its part is still open: still the tenant's money GAM holds.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [final.refund_payment_id])
    expect(await book()).toMatchObject({ inTrust: 400 })
    // The part goes back to the card: it leaves the book, and the refund row follows the parts.
    await db.query(
      `UPDATE stay_refund_parts SET status = 'refunded', refunded_at = NOW(), failure = NULL, stripe_refund_id = 're_test_sent'
        WHERE deposit_return_id = $1`, [draft.id])
    const { syncDepositRefundRow } = await import('./depositRefundSend')
    await syncDepositRefundRow(draft.id)
    expect(await book()).toMatchObject({ inTrust: 0 })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [final.refund_payment_id])).rows[0].status).toBe('settled')
  })

  it('a refund only the landlord hands back is never on GAM’s book', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 100 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(Number((final as any).refund_from_landlord)).toBe(400)
    expect(await book()).toEqual({ inTrust: 0, held: 0 })
  })

  it('a deposit payment GAM took still reads as collected by GAM after the move-out used it (never relabeled the landlord’s)', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', cleaningFeeAmount: 100 })
    const sec = await depositPayment(stack, { amount: 500, via: 'gam' })
    const desk = await depositPayment(stack, { amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    const { depositCollectedBySql } = await import('./leaseFeesSync')
    const rows = (await db.query(
      `SELECT p.id, ${depositCollectedBySql('p')} AS by FROM payments p WHERE p.id = ANY($1::uuid[])`, [[sec, desk]])).rows
    expect(Object.fromEntries(rows.map((r: any) => [r.id, r.by]))).toEqual({ [sec]: 'gam', [desk]: 'landlord' })
  })

  // Fix pass 3: read on the PAYMENT itself — a pet deposit GAM held on a lease
  // whose security deposit the landlord holds read 'landlord' once finalize
  // cleared its platform_held (the record GAM did not hold was all it read).
  it('a security deposit paid at the desk and a pet deposit paid through GAM: the pet payment reads as collected by GAM before and after the move-out, the desk one as the landlord’s', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 650 })
    await gamMayHoldHere(stack)
    const desk = await depositPayment(stack, { amount: 500, via: 'desk' })
    const pet = await boxDeposit(stack, { feeType: 'pet_deposit', amount: 300, via: 'gam' })
    const { depositCollectedBySql } = await import('./leaseFeesSync')
    const by = async () => Object.fromEntries((await db.query(
      `SELECT p.id, ${depositCollectedBySql('p')} AS by FROM payments p WHERE p.id = ANY($1::uuid[])`, [[desk, pet]])).rows
      .map((r: any) => [r.id, r.by]))
    expect(await by()).toEqual({ [desk]: 'landlord', [pet]: 'gam' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    const after = (await db.query(`SELECT platform_held, released_by_deposit_return_id FROM payments WHERE id = $1`, [pet])).rows[0]
    expect(after).toEqual({ platform_held: false, released_by_deposit_return_id: draft.id })
    expect(await by()).toEqual({ [desk]: 'landlord', [pet]: 'gam' })
  })

  // Fix pass 2: the post-move-out reading follows a RECORDED fact — the deposit
  // record GAM held (held_by 'gam_escrow') — never "settled before finalize".
  it('a deposit paid online but passed straight to the landlord (a record the landlord holds) reads as the landlord’s before and after the move-out', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 100 })
    const passed = await depositPayment(stack, { amount: 500, via: 'gam' })
    await db.query(`UPDATE payments SET platform_held = FALSE WHERE id = $1`, [passed])
    const { depositCollectedBySql } = await import('./leaseFeesSync')
    const by = async () => (await db.query(
      `SELECT ${depositCollectedBySql('p')} AS by FROM payments p WHERE p.id = $1`, [passed])).rows[0].by
    expect(await by()).toBe('landlord')
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(await by()).toBe('landlord')
  })

  it('a deposit payment the landlord took at the desk is never touched (it was never GAM’s)', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const key = await boxDeposit(stack, { feeType: 'key_deposit', amount: 50, via: 'desk' })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId)
    const r = (await db.query(`SELECT platform_held, manual_method FROM payments WHERE id = $1`, [key])).rows[0]
    expect(r).toEqual({ platform_held: false, manual_method: 'cash' })
  })
})

// Step 9 review (fix pass 3): interest accrued on the part of a GAM-escrow
// deposit record the tenant paid the landlord directly is the landlord's to
// pay back — GAM never pays interest on money it does not hold.
describe('fix pass 3: deposit interest is refunded by whoever holds the money it accrued on', () => {
  it('a $500 GAM record, $300 paid through GAM and $200 at the desk, $10 interest owed: GAM refunds $306, the landlord $204', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', interestAccrued: 10 })
    await depositPayment(stack, { amount: 300, via: 'gam' })
    await depositPayment(stack, { amount: 200, via: 'desk' })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ interest_accrued: 10, refund_amount: 510, refund_from_gam: 306, refund_from_landlord: 204 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, {
      expectedRefund: 510, expectedGap: 0, expectedRefundFromGam: 306, expectedRefundFromLandlord: 204,
    })
    expect(Number((final as any).refund_from_gam)).toBe(306)
    expect(Number((final as any).refund_from_landlord)).toBe(204)
  })

  it('a GAM record GAM holds all of: all the interest is GAM’s to pay, as before', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'gam_escrow', interestAccrued: 10 })
    await depositPayment(stack, { amount: 500, via: 'gam' })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ refund_amount: 510, refund_from_gam: 510, refund_from_landlord: 0 })
  })
})

// Step 9 review (fix pass 3): a lease fee already billed on this tenancy is
// not deducted from the deposit again (every dollar counted once).
describe('fix pass 3: a move-out fee already billed or waived is never deducted again', () => {
  const terminationRequest = async (stack: LeaseStack, o: { status: string; feePaymentId?: string | null; waived?: boolean }) => {
    await db.query(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, fee_payment_id, status,
          fee_waived_at, fee_paid_at)
       VALUES ($1, $2, $3, $4, 300, 'lease_specific', $5, $6,
               CASE WHEN $7 THEN NOW() END, CASE WHEN $6 = 'fee_paid' THEN NOW() END)`,
      [stack.leaseId, stack.tenantId, stack.landlordId, stack.ownerUserId, o.feePaymentId ?? null, o.status, o.waived === true])
  }
  const feeRow = async (stack: LeaseStack, o: { amount: number; status: string; notes: string; entry?: string }) =>
    (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes, settled_at)
       VALUES ($1, $2, $3, $4, 'fee', $5, $6, CURRENT_DATE - 5, $7, $8, CASE WHEN $6 = 'settled' THEN NOW() END) RETURNING id`,
      [stack.unitId, stack.leaseId, stack.tenantId, stack.landlordId, o.amount.toFixed(2), o.status, o.entry ?? 'SUBSCRIP', o.notes])).rows[0].id

  it('the early-termination fee charged by the termination request and paid: the move-out deducts $0 for it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(`INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable) VALUES ($1, 'early_termination_fee', 300, 'other', FALSE)`, [stack.leaseId])
    const paid = await feeRow(stack, { amount: 300, status: 'settled', notes: `Early-termination fee for lease ${stack.leaseId}`, entry: 'LATEFEE' })
    await terminationRequest(stack, { status: 'fee_paid', feePaymentId: paid })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ cleaning_fee_amount: 0, total_deductions: 0, refund_amount: 500 })
  })

  it('a fee billed with Bill fee and still unpaid: counted once — in the unpaid balance, never again as a move-out fee', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(`INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, description) VALUES ($1, 'other_fee', 75, 'other', FALSE, 'Gate arm')`, [stack.leaseId])
    await feeRow(stack, { amount: 75, status: 'pending', notes: 'admin-billed: other_fee — Gate arm' })
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ cleaning_fee_amount: 0, unpaid_balance_total: 75, total_deductions: 75, refund_amount: 425 })
    const draft = await createOrFetchDraft(stack.leaseId)
    const final = await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedRefund: 425, expectedGap: 0 })
    expect(Number(final.refund_amount)).toBe(425)
    expect(Number(final.cleaning_fee_amount)).toBe(0)
  })

  it('an early-termination fee the landlord waived: $0', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(`INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable) VALUES ($1, 'early_termination_fee', 300, 'other', FALSE)`, [stack.leaseId])
    await terminationRequest(stack, { status: 'fee_waived', waived: true })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ cleaning_fee_amount: 0, refund_amount: 500 })
  })

  it('a move-out fee nobody billed yet is still deducted, as the lease says', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 40 })
    await db.query(`INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable) VALUES ($1, 'other_fee', 25, 'other', FALSE)`, [stack.leaseId])
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ cleaning_fee_amount: 65, refund_amount: 435 })
  })
  // Fix pass 1 (final fix): a Bill-fee charge has no link to its fee, so each
  // charge is paired with ONE fee of its type (otherFeesNotBilled).
  it('a fee edited after it was billed is still the fee that charge billed — never deducted again on top', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, description) VALUES ($1, 'other_fee', 75, 'other', FALSE, 'Gate arm') RETURNING id`,
      [stack.leaseId])).rows[0].id
    await feeRow(stack, { amount: 75, status: 'settled', notes: 'admin-billed: other_fee — Gate arm' })
    await db.query(`UPDATE lease_fees SET amount = 90 WHERE id = $1`, [fee])
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ cleaning_fee_amount: 0, total_deductions: 0, refund_amount: 500 })
  })

  it('two fees of the same type and amount with only one billed: the other is still deducted, once', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, description)
       VALUES ($1, 'other_fee', 50, 'other', FALSE, 'Parking violation'), ($1, 'other_fee', 50, 'other', FALSE, 'Parking violation')`,
      [stack.leaseId])
    await feeRow(stack, { amount: 50, status: 'settled', notes: 'admin-billed: other_fee — Parking violation' })
    expect(await calculateDepositReturn(stack.leaseId)).toMatchObject({ cleaning_fee_amount: 50, refund_amount: 450 })
  })

  it('a charge pairs with the fee of its type closest in amount: an edited $120 fee billed at $100 leaves the unbilled $50 fee deducted', async () => {
    const { otherFeesNotBilled } = await import('./depositReturn')
    const left = otherFeesNotBilled(
      [{ id: 'a', feeType: 'other_fee', cents: 12000 }, { id: 'b', feeType: 'other_fee', cents: 5000 }, { id: 'c', feeType: 'cleaning_fee', cents: 4000 }],
      [{ feeType: 'other_fee', cents: 10000 }])
    expect([...left].sort()).toEqual(['b', 'c'])
  })
})

// Step 9 (final fix, fix pass 1): once the landlord chose "Leave it as their
// credit" (decisions #46.1a — lease_prepaid_credits.left_by_choice_id), that
// money is decided: it waits for the tenant's next lease with this landlord.
// A later move-out on the lease (a final bill sent the landlord through Begin
// Move-Out after the choice) neither counts nor offers it again.
describe('money already left as the tenant’s credit is never counted or offered again by a move-out', () => {
  beforeEach(() => { vi.clearAllMocks() })
  // The shared schema cleanup does not reach paid_ahead_choices (it points at
  // the lease), so this file clears its own.
  afterEach(async () => {
    await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = NULL WHERE left_by_choice_id IS NOT NULL`)
    await db.query(`DELETE FROM paid_ahead_choices`)
  })

  const leaveAsCredit = async (stack: LeaseStack, creditId: string, amount: number) => {
    const choice = (await db.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_choice, rest_amount,
                                       idempotency_key, decided_by)
       VALUES ($1, $2, $3, 'no_refund', 0, 'credit', $3, $4, $5) RETURNING id`,
      [stack.leaseId, stack.landlordId, amount.toFixed(2), randomUUID(), stack.ownerUserId])).rows[0].id
    await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = $2 WHERE id = $1`, [creditId, choice])
  }

  it('$500 deposit, $650 of damage, $300 paid ahead already left as their credit and $100 not: only the $100 pays what the deposit cannot, the $300 is untouched', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 650 })
    const left = await paidAhead(stack, 300)
    await leaveAsCredit(stack, left, 300)
    const open = await paidAhead(stack, 100)
    const calc = await calculateDepositReturn(stack.leaseId)
    expect(calc).toMatchObject({ prepaid_credit_remaining: 100, prepaid_credit_used: 100, prepaid_credit_left: 0, gap_amount: 50 })
    const draft = await createOrFetchDraft(stack.leaseId)
    await finalizeDepositReturn(draft.id, stack.ownerUserId, { expectedGap: 50, expectedPaidAheadUsed: 100 })
    const uses = (await db.query(`SELECT prepaid_credit_id, amount::float AS amount FROM credit_uses WHERE source = 'move_out'`)).rows
    expect(uses).toEqual([{ prepaid_credit_id: open, amount: 100 }])
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id = $1`, [left])).rows[0].amount_remaining)).toBe(300)
  })
})

// Step 9 (final fix, fix pass 1): a team member's finalize is held to the
// landlord's approval limit by finalize itself, under its locks, on the refund
// it would pay now — a caller that sends no figures can no longer be paid more
// than the limit allows.
describe('a team member’s finalize is judged against the approval limit under finalize’s locks', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('a $500 refund over a $300 limit: parked for the landlord, nothing paid; asked again it stays parked; the owner’s finalize pays it', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord' })
    const draft = await createOrFetchDraft(stack.leaseId)
    const first = await finalizeDepositReturn(draft.id, stack.ownerUserId, {}, { approvalThreshold: 300 })
    expect(first).toMatchObject({ status: 'awaiting_approval', parked: 'now' })
    expect(Number(first.refund_amount)).toBe(500)
    const row = (await db.query(`SELECT status, finalized_at, refund_payment_id FROM deposit_returns WHERE id = $1`, [draft.id])).rows[0]
    expect(row).toEqual({ status: 'awaiting_approval', finalized_at: null, refund_payment_id: null })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE lease_id = $1`, [stack.leaseId])).rows[0].n).toBe(0)
    expect(await finalizeDepositReturn(draft.id, stack.ownerUserId, {}, { approvalThreshold: 300 })).toMatchObject({ parked: 'already' })
    const owner = await finalizeDepositReturn(draft.id, stack.ownerUserId)
    expect(owner).toMatchObject({ status: 'sent_refund' })
    expect(owner.parked).toBeUndefined()
  })

  it('a refund that grew past the limit after the page read it is parked, not paid (judged on the live refund)', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 250 })
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(Number(draft.refund_amount)).toBe(250)
    await db.query(`DELETE FROM lease_fees WHERE lease_id = $1 AND fee_type = 'cleaning_fee'`, [stack.leaseId])
    const r = await finalizeDepositReturn(draft.id, stack.ownerUserId, {}, { approvalThreshold: 300 })
    expect(r).toMatchObject({ status: 'awaiting_approval', parked: 'now' })
    expect(Number(r.refund_amount)).toBe(500)
  })

  it('a refund within the limit is finalized as usual', async () => {
    const stack = await buildLeaseStack({ depositTotal: 500, heldBy: 'landlord', cleaningFeeAmount: 250 })
    const draft = await createOrFetchDraft(stack.leaseId)
    expect(await finalizeDepositReturn(draft.id, stack.ownerUserId, {}, { approvalThreshold: 300 })).toMatchObject({ status: 'sent_refund' })
  })
})
