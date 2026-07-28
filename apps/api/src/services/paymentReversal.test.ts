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

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
vi.mock('./reversalRecovery', () => ({ decideReversalRecovery: decideRecoveryMock }))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { handlePaymentReversal, resolveReversalOnTenantPayment, type PaymentReversalInput } from './paymentReversal'

interface Ctx {
  landlordId: string; unitId: string; tenantId: string
  leaseId: string; invoiceId: string; paymentId: string
}

async function seedCtx(paymentStatus: 'settled' | 'pending' = 'settled'): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId })
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

beforeEach(async () => {
  await cleanupAllSchema()
  lateFeeMock.mockClear()
  notifyReversedMock.mockClear()
  adminNotifyMock.mockClear()
  responsiblePartyMock.mockClear()
  decideRecoveryMock.mockClear()
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

  it('partial clawback → GAM keeps (false) + raises an admin reconciliation alert', async () => {
    const revId = await seedRev('scheduled_netting', 300)
    const client = await db.connect()
    try { expect(await resolveReversalOnTenantPayment(client, revId)).toBe(false) } finally { client.release() }
    expect(adminNotifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'payment_reversal_partial_clawback_tenant_paid' }))
  })
})
