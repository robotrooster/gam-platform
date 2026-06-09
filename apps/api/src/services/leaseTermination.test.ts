/**
 * leaseTermination — early-termination quote + request lifecycle.
 *
 * Surfaces under test:
 *   - quoteFee                      3-priority fee resolution
 *   - getActiveOrLatestRequest      'requested' first, then most-recent
 *   - requestEarlyTermination       no-policy path + fee-charged paths
 *                                   (Stripe customer missing / charge
 *                                   ok / charge failure)
 *   - waiveFeeAndTerminate          status gate + terminates lease
 *   - cancelRequest                 status gate
 *
 * Mocks Stripe (customers.retrieve, paymentIntents.create) — the
 * service dynamically imports the SDK at call time. createAdminNotification
 * is mocked too (charge-failure side effect).
 *
 * creditLedger.appendEvent runs against the real chain so the integration
 * actually produces credit_events rows; verified in the no-policy +
 * waive tests.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  customersRetrieveMock,
  paymentIntentsCreateMock,
  createAdminNotificationMock,
} = vi.hoisted(() => ({
  customersRetrieveMock:        vi.fn(async () => ({}) as any),
  paymentIntentsCreateMock:     vi.fn(async () => ({ id: 'pi_mock' }) as any),
  createAdminNotificationMock:  vi.fn(async () => {}),
}))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.customers = { retrieve: customersRetrieveMock }
    this.paymentIntents = { create: paymentIntentsCreateMock }
  }
  return { default: FakeStripe }
})
vi.mock('./adminNotifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createAdminNotification: createAdminNotificationMock }
})

import {
  quoteFee,
  getActiveOrLatestRequest,
  requestEarlyTermination,
  waiveFeeAndTerminate,
  cancelRequest,
} from './leaseTermination'

beforeEach(async () => {
  await cleanupAllSchema()
  customersRetrieveMock.mockReset()
  paymentIntentsCreateMock.mockReset()
  createAdminNotificationMock.mockReset()
  customersRetrieveMock.mockResolvedValue({})
  paymentIntentsCreateMock.mockResolvedValue({ id: 'pi_mock' })
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy'
})

interface SeedFixture {
  landlordUserId: string
  landlordId:     string
  tenantUserId:   string
  tenantId:       string
  unitId:         string
  propertyId:     string
  leaseId:        string
}

async function seedFixture(opts: {
  rentAmount?: number
  leaseStatus?: 'pending' | 'active' | 'expired' | 'terminated'
  defaultTerminationMonths?: number | null
} = {}): Promise<SeedFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    if (opts.defaultTerminationMonths !== undefined) {
      await client.query(
        `UPDATE landlords SET default_early_termination_months_rent = $1 WHERE id = $2`,
        [opts.defaultTerminationMonths, landlordId],
      )
    }
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, {
      unitId, landlordId,
      rentAmount: opts.rentAmount ?? 1500,
      status: (opts.leaseStatus as any) ?? 'active',
    })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { landlordUserId, landlordId, tenantUserId, tenantId, unitId, propertyId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedLeaseSpecificFee(leaseId: string, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
     VALUES ($1, 'early_termination_fee', $2, FALSE, 'other')`,
    [leaseId, amount],
  )
}

// ─── quoteFee ──────────────────────────────────────────────────

describe('quoteFee — 3-priority fee resolution', () => {
  it('priority 1: lease-specific fee row → fee_basis=lease_specific, amount from row, multiplier null', async () => {
    const f = await seedFixture({ rentAmount: 1500 })
    await seedLeaseSpecificFee(f.leaseId, 2000)
    const q = await quoteFee(f.leaseId)
    expect(q.fee_basis).toBe('lease_specific')
    expect(q.fee_amount).toBe(2000)
    expect(q.rent_amount).toBe(1500)
    expect(q.months_rent_multiplier).toBeNull()
  })

  it('priority 2: landlord_default_early_termination_months_rent × rent → fee_basis=landlord_default', async () => {
    const f = await seedFixture({ rentAmount: 1500, defaultTerminationMonths: 2 })
    const q = await quoteFee(f.leaseId)
    expect(q.fee_basis).toBe('landlord_default')
    expect(q.fee_amount).toBe(3000)  // 1500 * 2
    expect(q.months_rent_multiplier).toBe(2)
  })

  it('priority 3: no policy → fee_basis=no_policy, amount=0', async () => {
    const f = await seedFixture({ rentAmount: 1500 })
    const q = await quoteFee(f.leaseId)
    expect(q.fee_basis).toBe('no_policy')
    expect(q.fee_amount).toBe(0)
  })

  it('lease-specific wins over landlord default', async () => {
    const f = await seedFixture({ rentAmount: 1500, defaultTerminationMonths: 3 })
    // Default would give 4500; lease-specific row overrides.
    await seedLeaseSpecificFee(f.leaseId, 750)
    const q = await quoteFee(f.leaseId)
    expect(q.fee_basis).toBe('lease_specific')
    expect(q.fee_amount).toBe(750)
  })

  it('throws when lease not found', async () => {
    await expect(quoteFee('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/)
  })

  it('non-integer multiplier produces correct rounded amount', async () => {
    const f = await seedFixture({ rentAmount: 1500, defaultTerminationMonths: 1.5 })
    const q = await quoteFee(f.leaseId)
    expect(q.fee_amount).toBe(2250)  // 1500 * 1.5
  })
})

// ─── getActiveOrLatestRequest ──────────────────────────────────

describe('getActiveOrLatestRequest', () => {
  it('returns null when no request exists', async () => {
    const f = await seedFixture()
    expect(await getActiveOrLatestRequest(f.leaseId)).toBeNull()
  })

  it("returns the 'requested' row even when a more-recent cancelled row exists", async () => {
    const f = await seedFixture()
    // Older 'requested' row
    const r1 = await db.query<{ id: string }>(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status)
       VALUES ($1, $2, $3, $4, 1000, 'lease_specific', 'requested') RETURNING id`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId],
    )
    // Newer 'cancelled' row
    await db.query(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status, created_at)
       VALUES ($1, $2, $3, $4, 1500, 'landlord_default', 'cancelled', NOW() + INTERVAL '1 hour')`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId],
    )
    const out = await getActiveOrLatestRequest(f.leaseId)
    expect(out!.id).toBe(r1.rows[0].id)
    expect(out!.status).toBe('requested')
  })

  it('when no active request, returns the most recent by created_at', async () => {
    const f = await seedFixture()
    // Older cancelled
    await db.query(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status, created_at)
       VALUES ($1, $2, $3, $4, 1000, 'lease_specific', 'cancelled', NOW() - INTERVAL '2 hours')`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId],
    )
    // Newer failed
    const newer = await db.query<{ id: string }>(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status, created_at)
       VALUES ($1, $2, $3, $4, 1500, 'landlord_default', 'failed', NOW()) RETURNING id`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId],
    )
    const out = await getActiveOrLatestRequest(f.leaseId)
    expect(out!.id).toBe(newer.rows[0].id)
    expect(out!.status).toBe('failed')
  })
})

// ─── requestEarlyTermination — no-policy path ──────────────────

describe('requestEarlyTermination — no-policy path', () => {
  it('happy: no policy → request fee_waived, lease terminated, no Stripe call, credit events emitted', async () => {
    const f = await seedFixture()  // no fee, no default
    const { request, chargeStatus } = await requestEarlyTermination({
      leaseId: f.leaseId,
      tenantId: f.tenantId,
      requestedByUserId: f.tenantUserId,
      reason: 'Job relocation',
    })
    expect(chargeStatus).toBe('no_charge_needed')
    expect(request.status).toBe('fee_waived')
    expect(request.fee_amount).toBe('0.00')
    expect(request.fee_waiver_reason).toBe('no_policy_on_file')
    expect(request.terminated_at).toBeTruthy()
    // Stripe NOT called
    expect(customersRetrieveMock).not.toHaveBeenCalled()
    expect(paymentIntentsCreateMock).not.toHaveBeenCalled()
    // Lease + tenants + unit cascade
    const lease = await db.query<{ status: string; terminated_at: string }>(
      `SELECT status, terminated_at FROM leases WHERE id = $1`, [f.leaseId],
    )
    expect(lease.rows[0].status).toBe('terminated')
    expect(lease.rows[0].terminated_at).toBeTruthy()
    const lt = await db.query<{ status: string; removed_reason: string }>(
      `SELECT status, removed_reason FROM lease_tenants WHERE lease_id = $1`, [f.leaseId],
    )
    expect(lt.rows[0].status).toBe('removed')
    expect(lt.rows[0].removed_reason).toBe('lease_ended')
    const unit = await db.query<{ status: string }>(`SELECT status FROM units WHERE id = $1`, [f.unitId])
    expect(unit.rows[0].status).toBe('vacant')
    // Two credit events (tenant subject + landlord subject)
    const events = await db.query<{ event_type: string; subject_type: string; event_data: any }>(
      `SELECT ev.event_type, cs.subject_type, ev.event_data
         FROM credit_events ev JOIN credit_subjects cs ON cs.id = ev.subject_id`,
    )
    expect(events.rows).toHaveLength(2)
    const tenantEv = events.rows.find(e => e.subject_type === 'tenant')
    expect(tenantEv?.event_type).toBe('lease_terminated_early_by_tenant')
    expect(tenantEv?.event_data.no_policy).toBe(true)
    const landlordEv = events.rows.find(e => e.subject_type === 'landlord')
    expect(landlordEv?.event_type).toBe('lease_terminated_early_by_tenant')
  })

  it('throws when lease not active or pending', async () => {
    const f = await seedFixture({ leaseStatus: 'expired' })
    await expect(requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })).rejects.toThrow(/Cannot terminate lease in status expired/)
  })

  it('throws on duplicate active request', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status)
       VALUES ($1, $2, $3, $4, 0, 'no_policy', 'requested')`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId],
    )
    await expect(requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })).rejects.toThrow(/already in progress/)
  })
})

// ─── requestEarlyTermination — fee > 0 path ────────────────────

describe('requestEarlyTermination — Stripe charge path', () => {
  async function attachStripeCustomer(tenantId: string, customerId: string = 'cus_mock') {
    await db.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, tenantId])
  }

  it('no stripe_customer_id on file → status=failed, fee_charge_failed=TRUE, admin notification fired', async () => {
    const f = await seedFixture({ defaultTerminationMonths: 1 })  // fee = 1500
    const { request, chargeStatus } = await requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })
    expect(chargeStatus).toBe('failed')
    expect(request.status).toBe('failed')
    expect(request.fee_charge_failed).toBe(true)
    expect(request.fee_charge_failure_reason).toMatch(/No Stripe customer/)
    expect(createAdminNotificationMock).toHaveBeenCalledTimes(1)
  })

  it('Stripe customer has no default payment method → status=failed with reason', async () => {
    const f = await seedFixture({ defaultTerminationMonths: 1 })
    await attachStripeCustomer(f.tenantId)
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_mock',
      invoice_settings: {},
      default_source: null,
    })
    const { request, chargeStatus } = await requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })
    expect(chargeStatus).toBe('failed')
    expect(request.fee_charge_failure_reason).toMatch(/No default payment method/)
  })

  it('Stripe charge succeeds → status=fee_paid, lease terminated, payments row created', async () => {
    const f = await seedFixture({ defaultTerminationMonths: 1 })
    await attachStripeCustomer(f.tenantId)
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_mock',
      invoice_settings: { default_payment_method: 'pm_mock' },
    })
    const { request, chargeStatus } = await requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })
    expect(chargeStatus).toBe('paid')
    expect(request.status).toBe('fee_paid')
    expect(request.fee_paid_at).toBeTruthy()
    expect(request.terminated_at).toBeTruthy()
    expect(request.fee_payment_id).toBeTruthy()
    // Stripe called correctly
    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1)
    const callArgs = (paymentIntentsCreateMock.mock.calls[0] as unknown as any[])[0]
    expect(callArgs.amount).toBe(150000)  // $1500 in cents
    expect(callArgs.customer).toBe('cus_mock')
    expect(callArgs.payment_method).toBe('pm_mock')
    expect(callArgs.off_session).toBe(true)
    expect(callArgs.metadata.gam_kind).toBe('early_termination_fee')
    // Payments row created
    const pay = await db.query<{ status: string; type: string; amount: string }>(
      `SELECT status, type, amount FROM payments WHERE id = $1`, [request.fee_payment_id!],
    )
    expect(pay.rows[0].type).toBe('fee')
    expect(Number(pay.rows[0].amount)).toBe(1500)
    // Lease terminated
    const lease = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])
    expect(lease.rows[0].status).toBe('terminated')
  })

  it('Stripe charge throws → status=failed with reason, lease stays active', async () => {
    const f = await seedFixture({ defaultTerminationMonths: 1 })
    await attachStripeCustomer(f.tenantId)
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_mock',
      invoice_settings: { default_payment_method: 'pm_mock' },
    })
    paymentIntentsCreateMock.mockRejectedValueOnce(new Error('Card declined'))
    const { request, chargeStatus } = await requestEarlyTermination({
      leaseId: f.leaseId, tenantId: f.tenantId, requestedByUserId: f.tenantUserId,
    })
    expect(chargeStatus).toBe('failed')
    expect(request.status).toBe('failed')
    expect(request.fee_charge_failure_reason).toMatch(/Card declined/)
    // Lease still active
    const lease = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])
    expect(lease.rows[0].status).toBe('active')
    expect(createAdminNotificationMock).toHaveBeenCalledTimes(1)
  })
})

// ─── waiveFeeAndTerminate ──────────────────────────────────────

describe('waiveFeeAndTerminate', () => {
  async function seedRequestedRequest(f: SeedFixture, status: 'requested' | 'failed' | 'fee_paid' | 'fee_waived' = 'requested'): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status)
       VALUES ($1, $2, $3, $4, 1500, 'landlord_default', $5) RETURNING id`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId, status],
    )
    return r.rows[0].id
  }

  it('happy: waives from requested → status=fee_waived, lease terminated, credit events emitted', async () => {
    const f = await seedFixture()
    const reqId = await seedRequestedRequest(f, 'requested')
    const updated = await waiveFeeAndTerminate({
      requestId: reqId, waivedByUserId: f.landlordUserId, reason: 'Hardship — deployment',
    })
    expect(updated.status).toBe('fee_waived')
    expect(updated.fee_waived_at).toBeTruthy()
    expect(updated.fee_waived_by_user_id).toBe(f.landlordUserId)
    expect(updated.fee_waiver_reason).toBe('Hardship — deployment')
    expect(updated.terminated_at).toBeTruthy()
    // Lease + cascade
    const lease = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])
    expect(lease.rows[0].status).toBe('terminated')
    // Credit events (landlord-driven termination event)
    const ev = await db.query<{ event_type: string }>(
      `SELECT ev.event_type FROM credit_events ev`,
    )
    expect(ev.rows.map(r => r.event_type).sort()).toEqual([
      'lease_terminated_early_by_landlord',
      'lease_terminated_early_by_landlord',
    ])
  })

  it('also waives from failed status', async () => {
    const f = await seedFixture()
    const reqId = await seedRequestedRequest(f, 'failed')
    // Also stamp fee_charge_failed=true to verify it gets cleared
    await db.query(
      `UPDATE lease_termination_requests SET fee_charge_failed = TRUE WHERE id = $1`,
      [reqId],
    )
    const updated = await waiveFeeAndTerminate({
      requestId: reqId, waivedByUserId: f.landlordUserId,
    })
    expect(updated.status).toBe('fee_waived')
    expect(updated.fee_charge_failed).toBe(false)  // cleared
  })

  it('throws when status is fee_paid (already finalized)', async () => {
    const f = await seedFixture()
    const reqId = await seedRequestedRequest(f, 'fee_paid')
    await expect(waiveFeeAndTerminate({
      requestId: reqId, waivedByUserId: f.landlordUserId,
    })).rejects.toThrow(/Cannot waive request in status fee_paid/)
  })

  it('throws on unknown request id', async () => {
    await expect(waiveFeeAndTerminate({
      requestId: '00000000-0000-0000-0000-000000000000',
      waivedByUserId: 'irrelevant',
    })).rejects.toThrow(/Request not found/)
  })
})

// ─── cancelRequest ─────────────────────────────────────────────

describe('cancelRequest', () => {
  async function seedRequest(f: SeedFixture, status: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO lease_termination_requests
         (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, status)
       VALUES ($1, $2, $3, $4, 0, 'no_policy', $5) RETURNING id`,
      [f.leaseId, f.tenantId, f.landlordId, f.tenantUserId, status],
    )
    return r.rows[0].id
  }

  it('cancels a requested row', async () => {
    const f = await seedFixture()
    const id = await seedRequest(f, 'requested')
    const out = await cancelRequest(id)
    expect(out!.status).toBe('cancelled')
  })

  it('cancels a failed row', async () => {
    const f = await seedFixture()
    const id = await seedRequest(f, 'failed')
    const out = await cancelRequest(id)
    expect(out!.status).toBe('cancelled')
  })

  it('throws when status is fee_paid', async () => {
    const f = await seedFixture()
    const id = await seedRequest(f, 'fee_paid')
    await expect(cancelRequest(id)).rejects.toThrow(/Cannot cancel request in status fee_paid/)
  })

  it('throws when status is fee_waived', async () => {
    const f = await seedFixture()
    const id = await seedRequest(f, 'fee_waived')
    await expect(cancelRequest(id)).rejects.toThrow(/Cannot cancel request in status fee_waived/)
  })

  it('returns null for unknown id', async () => {
    const out = await cancelRequest('00000000-0000-0000-0000-000000000000')
    expect(out).toBeNull()
  })
})
