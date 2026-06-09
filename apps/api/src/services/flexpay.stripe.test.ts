/**
 * S445 services-audit slice 21 — flexpay.ts Stripe state-machine half.
 *
 * Companion to flexpay.test.ts (S431 — formula, eligibility, enroll/
 * cancel, auto-disenroll). Mocks both the Stripe SDK (for the direct
 * `stripe.transfers.create` in fireFlexPayAdvanceTransfer and the
 * `stripe.customers.retrieve` in processFlexPayPullDay) AND the
 * stripeConnect helper module (for the `createRentPlatformCharge` call
 * in processFlexPayPullDay) so the tenant-pull leg can be exercised
 * without dragging the full PI pipeline.
 *
 * Covers the five deferred functions:
 *   processGracePeriodAdvance — feature gate, candidate selection
 *     (enrollment / pull_day / lease status / grace-end day), OTP
 *     suppression dedup, no-Connect skip-with-error, happy Transfer,
 *     Stripe-throws branch, idempotency via ON CONFLICT.
 *   fireFlexPayAdvanceTransfer — success path (status='fronted',
 *     stripe_transfer_id, fronted_at preserved via COALESCE),
 *     failure path (transfer_error + admin alert + throws), Stripe
 *     call shape + idempotency key.
 *   processFlexPayPullDay — feature gate, pull-day candidate filter,
 *     no-customer-id branch (defaulted), no-default-PM branch
 *     (defaulted), happy createRentPlatformCharge call + payments row
 *     + advance flip to 'pulled', GAM-supersedence boost on amount.
 *   reconcileSettledFlexPayPayment — entry_description gate, status
 *     filter (only 'pulled' → 'reconciled'), idempotent re-run.
 *   handleFlexPayPaymentNsf — entry_description gate, retry_count<1
 *     short-circuit (ACH retry still in flight), retry_count>=1 +
 *     match → defaulted + 60-day tenant suspension + alert.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('stripe', () => {
  const transfersCreate = vi.fn(async () => ({ id: 'tr_default' }))
  const customersRetrieve = vi.fn(async () => ({
    id: 'cus_default',
    invoice_settings: { default_payment_method: 'pm_default' },
    default_source: null,
  }))
  function FakeStripe(this: any) {
    this.transfers = { create: transfersCreate }
    this.customers = { retrieve: customersRetrieve, create: vi.fn() }
    this.accounts = { create: vi.fn(), retrieve: vi.fn() }
    this.accountSessions = { create: vi.fn() }
    this.setupIntents = { create: vi.fn() }
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn() }
    this.payouts = { list: vi.fn(), retrieve: vi.fn(), create: vi.fn() }
  }
  ;(FakeStripe as any).__mocks = { transfersCreate, customersRetrieve }
  return { default: FakeStripe }
})

vi.mock('./stripeConnect', async () => {
  const createRentPlatformCharge = vi.fn(async () => ({
    id: 'pi_flexpay_mock', status: 'processing',
  }))
  return {
    createRentPlatformCharge,
    // No other helpers from this module are touched by flexpay.ts, but
    // include common ones as no-op stubs in case future code adds calls.
    createRentDestinationCharge: vi.fn(),
    computeApplicationFee:       vi.fn(() => 0),
  }
})

import Stripe from 'stripe'
import * as stripeConnect from './stripeConnect'
import { db } from '../db'
import {
  processGracePeriodAdvance,
  fireFlexPayAdvanceTransfer,
  processFlexPayPullDay,
  reconcileSettledFlexPayPayment,
  handleFlexPayPaymentNsf,
  FLEXPAY_NSF_COOLDOWN_DAYS,
} from './flexpay'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const stripeMocks: {
  transfersCreate:    ReturnType<typeof vi.fn>
  customersRetrieve:  ReturnType<typeof vi.fn>
} = (Stripe as any).__mocks

const createRentPlatformChargeMock =
  stripeConnect.createRentPlatformCharge as unknown as ReturnType<typeof vi.fn>

beforeEach(async () => {
  await cleanupAllSchema()
  stripeMocks.transfersCreate.mockReset()
  stripeMocks.transfersCreate.mockResolvedValue({ id: 'tr_default' } as any)
  stripeMocks.customersRetrieve.mockReset()
  stripeMocks.customersRetrieve.mockResolvedValue({
    id: 'cus_default',
    invoice_settings: { default_payment_method: 'pm_default' },
    default_source: null,
  } as any)
  createRentPlatformChargeMock.mockReset()
  createRentPlatformChargeMock.mockResolvedValue({
    id: 'pi_flexpay_mock', status: 'processing',
  })
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
})

async function enablePlatform(): Promise<void> {
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexpay_rollout_visible', TRUE, 'S445 test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

// ─── shared seeds ──────────────────────────────────────────────

interface GraceSeed {
  tenantId:        string
  landlordId:      string
  landlordUserId:  string
  unitId:          string
  leaseId:         string
}

/**
 * Seed an enrolled FlexPay tenant on a lease whose grace-end day matches
 * `graceEndDay`. By default: rent_due_day=1, grace=5 → grace-end=6.
 */
async function seedEnrolledTenant(opts: {
  enrolled?:           boolean
  pullDay?:            number
  hasConnect?:         boolean
  leaseStatus?:        'active' | 'pending' | 'terminated'
  rentAmount?:         number
  rentDueDay?:         number
  graceDays?:          number
  stripeCustomerId?:   string | null
} = {}): Promise<GraceSeed> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, {
      propertyId, landlordId, rentAmount: opts.rentAmount,
    })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, {
      unitId, landlordId,
      status:     opts.leaseStatus ?? 'active',
      rentAmount: opts.rentAmount ?? 1000,
    })
    await c.query(
      `UPDATE leases SET rent_due_day = $1, late_fee_grace_days = $2 WHERE id = $3`,
      [opts.rentDueDay ?? 1, opts.graceDays ?? 5, leaseId])
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })

    if (opts.enrolled !== false) {
      await c.query(
        `UPDATE tenants
            SET flexpay_enrolled = TRUE,
                flexpay_pull_day = $2,
                flexpay_monthly_fee = $3
          WHERE id = $1`,
        [tenantId, opts.pullDay ?? 15,
         5 + (opts.pullDay ?? 15) /* calculateFlexPayFee */])
    }
    if (opts.stripeCustomerId !== null) {
      await c.query(
        `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
        [tenantId, opts.stripeCustomerId ?? 'cus_test_flexpay'])
    }
    if (opts.hasConnect !== false) {
      await c.query(
        `UPDATE users SET stripe_connect_account_id = 'acct_flexpay_test' WHERE id = $1`,
        [landlordUserId])
    }
    await c.query('COMMIT')
    return { tenantId, landlordId, landlordUserId, unitId, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── processGracePeriodAdvance ─────────────────────────────────

describe('processGracePeriodAdvance', () => {
  // Default seed: rent_due_day=1 + grace=5 → grace-end=day 6
  const graceEndDate = new Date(Date.UTC(2026, 5, 6, 12)) // June 6, 2026

  it('feature flag off → returns zeros, no Stripe call, candidates not scanned', async () => {
    await seedEnrolledTenant()
    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.candidates_scanned).toBe(0)
    expect(r.advances_created).toBe(0)
    expect(r.advances_fronted).toBe(0)
    expect(r.cycle_month).toBe('2026-06-01')
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('happy: enrolled tenant on grace-end day → advance row + Transfer fired', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ rentAmount: 1000, pullDay: 15 })
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_flexpay_happy' } as any)

    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.candidates_scanned).toBe(1)
    expect(r.advances_created).toBe(1)
    expect(r.advances_fronted).toBe(1)
    expect(r.advances_suppressed_by_otp).toBe(0)
    expect(r.advances_transfer_failed).toBe(0)
    expect(r.errors).toBe(0)

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.status).toBe('fronted')
    expect(adv.stripe_transfer_id).toBe('tr_flexpay_happy')
    expect(adv.rent_amount).toBe('1000.00')
    expect(adv.tenant_fee_amount).toBe('20.00')   // 5 + 15
    expect(adv.pull_day).toBe(15)
    expect(adv.grace_advance_suppressed).toBe(false)
    expect(adv.fronted_at).not.toBeNull()
    expect(adv.transfer_error).toBeNull()

    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const [body, callOpts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(body).toMatchObject({
      amount:      100000,  // $1000 → 100,000 cents
      currency:    'usd',
      destination: 'acct_flexpay_test',
    })
    expect(body.description).toBe('FlexPay rent front 2026-06-01')
    expect(body.metadata).toMatchObject({
      gam_purpose:     'flexpay_advance',
      gam_advance_id:  adv.id,
      gam_tenant_id:   seed.tenantId,
      gam_landlord_id: seed.landlordId,
      gam_cycle_month: '2026-06-01',
    })
    expect(callOpts.idempotencyKey).toBe(`flexpay_advance_${adv.id}`)
  })

  it('idempotency: ON CONFLICT skips on re-run, no new Stripe call', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ rentAmount: 1000 })

    const r1 = await processGracePeriodAdvance(graceEndDate)
    expect(r1.advances_created).toBe(1)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)

    stripeMocks.transfersCreate.mockClear()
    const r2 = await processGracePeriodAdvance(graceEndDate)
    expect(r2.advances_created).toBe(0)
    expect(r2.advances_skipped_existing).toBe(1)
    expect(r2.advances_fronted).toBe(0)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('OTP already covered this cycle → suppressed, no Transfer, status fronted', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ rentAmount: 1000 })
    // Stamp an OTP advance with stripe_transfer_id for this cycle.
    await db.query(
      `INSERT INTO otp_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, fee_amount, advance_amount, status, stripe_transfer_id)
       VALUES ('2026-06-01', $1, $2, $3, $4, 1000, 10, 990, 'advanced', 'tr_otp_covers')`,
      [seed.tenantId, seed.landlordId, seed.unitId, seed.leaseId])

    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.advances_created).toBe(1)
    expect(r.advances_suppressed_by_otp).toBe(1)
    expect(r.advances_fronted).toBe(0)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.grace_advance_suppressed).toBe(true)
    expect(adv.status).toBe('fronted')           // INSERT'd as 'fronted' when suppressed
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.fronted_at).not.toBeNull()
  })

  it('OTP row exists but stripe_transfer_id NULL → NOT suppressed (Transfer fires)', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ rentAmount: 1000 })
    // OTP row exists but pending (no transfer id) — should NOT suppress
    // the FlexPay front since OTP didn't actually move money.
    await db.query(
      `INSERT INTO otp_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, fee_amount, advance_amount, status)
       VALUES ('2026-06-01', $1, $2, $3, $4, 1000, 10, 990, 'pending')`,
      [seed.tenantId, seed.landlordId, seed.unitId, seed.leaseId])
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_no_suppress' } as any)

    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.advances_suppressed_by_otp).toBe(0)
    expect(r.advances_fronted).toBe(1)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
  })

  it('no Connect at grace-end time → row in pending with transfer_error + alert + transferFailed++', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ hasConnect: false })

    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.advances_created).toBe(1)
    expect(r.advances_fronted).toBe(0)
    expect(r.advances_transfer_failed).toBe(1)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.status).toBe('pending')
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.transfer_attempted_at).not.toBeNull()
    expect(adv.transfer_error).toMatch(/no Stripe Connect account/i)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].severity).toBe('warn')
  })

  it('Stripe Transfer throws → row pending with transfer_error, alert, transferFailed++', async () => {
    await enablePlatform()
    await seedEnrolledTenant()
    stripeMocks.transfersCreate.mockRejectedValueOnce(new Error('platform_balance_insufficient'))

    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.advances_created).toBe(1)
    expect(r.advances_fronted).toBe(0)
    expect(r.advances_transfer_failed).toBe(1)
    expect(r.errors).toBe(0)

    const { rows: [adv] } = await db.query<any>(`SELECT * FROM flexpay_advances`)
    expect(adv.status).toBe('pending')
    expect(adv.transfer_error).toBe('platform_balance_insufficient')

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
  })

  it('candidate filter: flexpay_enrolled=FALSE excluded', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ enrolled: false })
    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.candidates_scanned).toBe(0)
  })

  it('candidate filter: terminated lease excluded', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ leaseStatus: 'terminated' })
    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.candidates_scanned).toBe(0)
  })

  it('day filter: not on grace-end day → no candidate', async () => {
    await enablePlatform()
    await seedEnrolledTenant()
    // rent_due_day=1 + grace=5 → grace-end is the 6th. Run on the 7th.
    const r = await processGracePeriodAdvance(new Date(Date.UTC(2026, 5, 7, 12)))
    expect(r.candidates_scanned).toBe(0)
  })

  it('lease.late_fee_grace_days = NULL falls back to default 5 days', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ graceDays: 5 })
    // Override grace to NULL explicitly to exercise the COALESCE fallback.
    await db.query(`UPDATE leases SET late_fee_grace_days = NULL WHERE id = $1`,
      [seed.leaseId])
    // rent_due_day=1 + default-grace=5 → grace-end=6
    const r = await processGracePeriodAdvance(graceEndDate)
    expect(r.candidates_scanned).toBe(1)
    expect(r.advances_fronted).toBe(1)
  })
})

// ─── fireFlexPayAdvanceTransfer (direct unit) ──────────────────

describe('fireFlexPayAdvanceTransfer', () => {
  async function seedPendingAdvance(): Promise<{
    advanceId: string; tenantId: string; landlordId: string
  }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, tenant_fee_amount, pull_day, status)
         VALUES ('2026-06-01', $1, $2, $3, $4, 1000, 20, 15, 'pending')
         RETURNING id`,
        [tenantId, landlordId, unitId, leaseId])
      await c.query('COMMIT')
      return { advanceId: a.id, tenantId, landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('success → status="fronted", stripe_transfer_id, fronted_at, error cleared', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_direct_happy' } as any)

    const r = await fireFlexPayAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_test_1',
      amount:          1000,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })
    expect(r.stripeTransferId).toBe('tr_direct_happy')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('fronted')
    expect(adv.stripe_transfer_id).toBe('tr_direct_happy')
    expect(adv.fronted_at).not.toBeNull()
    expect(adv.transfer_attempted_at).not.toBeNull()
    expect(adv.transfer_error).toBeNull()

    const [, callOpts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(callOpts.idempotencyKey).toBe(`flexpay_advance_${seed.advanceId}`)
  })

  it('failure → transfer_error captured, status stays "pending", admin alert, throws', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate.mockRejectedValueOnce(new Error('account_restricted'))

    await expect(fireFlexPayAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_test_1',
      amount:          1000,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })).rejects.toThrow('account_restricted')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('pending')
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.transfer_error).toBe('account_restricted')
    expect(adv.transfer_attempted_at).not.toBeNull()

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].title).toMatch(/2026-06-01/)
    expect(notif[0].body).toContain(seed.advanceId)
  })

  it('caller-side idempotent retry preserves fronted_at via COALESCE', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate
      .mockResolvedValueOnce({ id: 'tr_first' } as any)
      .mockResolvedValueOnce({ id: 'tr_second' } as any)

    await fireFlexPayAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_1', amount: 1000, cycle: '2026-06-01',
      tenantId:        seed.tenantId, landlordId: seed.landlordId,
    })
    const { rows: [first] } = await db.query<any>(
      `SELECT fronted_at FROM flexpay_advances WHERE id = $1`, [seed.advanceId])

    await new Promise(r => setTimeout(r, 30))

    await fireFlexPayAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_1', amount: 1000, cycle: '2026-06-01',
      tenantId:        seed.tenantId, landlordId: seed.landlordId,
    })
    const { rows: [second] } = await db.query<any>(
      `SELECT fronted_at, stripe_transfer_id FROM flexpay_advances WHERE id = $1`,
      [seed.advanceId])
    expect(new Date(second.fronted_at).getTime())
      .toBe(new Date(first.fronted_at).getTime())
    expect(second.stripe_transfer_id).toBe('tr_second')
  })
})

// ─── processFlexPayPullDay ─────────────────────────────────────

describe('processFlexPayPullDay', () => {
  // Seed a 'fronted' advance that is ready for the pull-day cron.
  async function seedFrontedAdvance(opts: {
    pullDay?:           number
    cycleMonth?:        string
    stripeCustomerId?:  string | null
    status?:            'pending' | 'fronted' | 'pulled'
  } = {}): Promise<{
    advanceId: string; tenantId: string; landlordId: string
  }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      if (opts.stripeCustomerId !== null) {
        await c.query(
          `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
          [tenantId, opts.stripeCustomerId ?? 'cus_pull_test'])
      }
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, tenant_fee_amount, pull_day, status)
         VALUES ($1, $2, $3, $4, $5, 1000, 20, $6, $7)
         RETURNING id`,
        [opts.cycleMonth ?? '2026-06-01',
         tenantId, landlordId, unitId, leaseId,
         opts.pullDay ?? 15,
         opts.status ?? 'fronted'])
      await c.query('COMMIT')
      return { advanceId: a.id, tenantId, landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  // Run on June 15, 2026 — matches the default pull_day of 15
  const pullDate = new Date(Date.UTC(2026, 5, 15, 12))

  it('feature flag off → returns zeros, no PI call', async () => {
    await seedFrontedAdvance()
    const r = await processFlexPayPullDay(pullDate)
    expect(r.candidates_scanned).toBe(0)
    expect(r.pulls_initiated).toBe(0)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
  })

  it('happy: pull-day match → createRentPlatformCharge + payments row + advance flips to "pulled"', async () => {
    await enablePlatform()
    const seed = await seedFrontedAdvance({ pullDay: 15 })

    const r = await processFlexPayPullDay(pullDate)
    expect(r.candidates_scanned).toBe(1)
    expect(r.pulls_initiated).toBe(1)
    expect(r.errors).toBe(0)

    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge.amount).toBe(1020)         // 1000 rent + 20 fee (no boost)
    expect(charge.stripeCustomerId).toBe('cus_pull_test')
    expect(charge.paymentMethodId).toBe('pm_default')
    expect(charge.paymentMethodTypes).toEqual(['us_bank_account'])
    expect(charge.entryDescription).toBe('FLEXPAY')
    expect(charge.metadata).toMatchObject({
      gam_purpose:    'flexpay_pull',
      gam_advance_id: seed.advanceId,
      gam_tenant_id:  seed.tenantId,
      gam_rent:       '1000',
      gam_fee:        '20',
    })

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('pulled')
    expect(adv.rent_payment_id).not.toBeNull()
    expect(adv.pulled_at).not.toBeNull()

    const { rows: [pay] } = await db.query<any>(
      `SELECT * FROM payments WHERE id = $1`, [adv.rent_payment_id])
    expect(pay.type).toBe('rent')
    expect(pay.entry_description).toBe('FLEXPAY')
    expect(pay.status).toBe('pending')
    expect(pay.stripe_payment_intent_id).toBe('pi_flexpay_mock')
    expect(pay.amount).toBe('1020.00')
    expect(pay.notes).toMatch(/FlexPay pull cycle 2026-06-01.*rent \$1000\.00.*fee \$20\.00/)
  })

  it('no stripe_customer_id → advance defaulted with reason=tenant_no_stripe_customer', async () => {
    await enablePlatform()
    const seed = await seedFrontedAdvance({ stripeCustomerId: null, pullDay: 15 })

    const r = await processFlexPayPullDay(pullDate)
    expect(r.candidates_scanned).toBe(1)
    expect(r.pulls_initiated).toBe(0)
    expect(r.errors).toBe(1)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('defaulted')
    expect(adv.default_reason).toBe('tenant_no_stripe_customer')
    expect(adv.defaulted_at).not.toBeNull()
  })

  it('no default payment method → advance defaulted with reason=tenant_no_default_payment_method', async () => {
    await enablePlatform()
    const seed = await seedFrontedAdvance({ pullDay: 15 })
    stripeMocks.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_pull_test',
      invoice_settings: { default_payment_method: null },
      default_source:   null,
    } as any)

    const r = await processFlexPayPullDay(pullDate)
    expect(r.errors).toBe(1)
    expect(r.pulls_initiated).toBe(0)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('defaulted')
    expect(adv.default_reason).toBe('tenant_no_default_payment_method')
  })

  it('legacy default_source fallback when invoice_settings.default_payment_method is null', async () => {
    await enablePlatform()
    const seed = await seedFrontedAdvance({ pullDay: 15 })
    stripeMocks.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_pull_test',
      invoice_settings: { default_payment_method: null },
      default_source:   'src_legacy_bank',
    } as any)

    const r = await processFlexPayPullDay(pullDate)
    expect(r.pulls_initiated).toBe(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge.paymentMethodId).toBe('src_legacy_bank')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('pulled')
  })

  it('day filter: pull_day !== today → no candidate', async () => {
    await enablePlatform()
    await seedFrontedAdvance({ pullDay: 10 })
    const r = await processFlexPayPullDay(pullDate)  // June 15
    expect(r.candidates_scanned).toBe(0)
  })

  it('status filter: only "fronted" advances picked up (pending/pulled/etc. excluded)', async () => {
    await enablePlatform()
    await seedFrontedAdvance({ pullDay: 15, status: 'pending' })
    const r = await processFlexPayPullDay(pullDate)
    expect(r.candidates_scanned).toBe(0)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
  })

  it('rent_payment_id IS NOT NULL (already pulled) → excluded', async () => {
    await enablePlatform()
    const seed = await seedFrontedAdvance({ pullDay: 15 })
    // Seed a real payments row + stamp it onto the advance.
    const { rows: [adv] } = await db.query<any>(
      `SELECT landlord_id, tenant_id, lease_id, unit_id
         FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (landlord_id, tenant_id, lease_id, unit_id,
          type, amount, status, entry_description, due_date)
       VALUES ($1, $2, $3, $4, 'rent', 1020, 'pending', 'FLEXPAY', '2026-06-01')
       RETURNING id`,
      [adv.landlord_id, adv.tenant_id, adv.lease_id, adv.unit_id])
    await db.query(
      `UPDATE flexpay_advances SET rent_payment_id = $1 WHERE id = $2`,
      [pay.id, seed.advanceId])
    const r = await processFlexPayPullDay(pullDate)
    expect(r.candidates_scanned).toBe(0)
  })
})

// ─── reconcileSettledFlexPayPayment ────────────────────────────

describe('reconcileSettledFlexPayPayment', () => {
  async function seedPulledAdvance(opts: {
    entryDescription?: string
    advanceStatus?:    'fronted' | 'pulled' | 'reconciled'
    cycleMonth?:       string
    paymentDueDate?:   string
  } = {}): Promise<{
    paymentId: string; advanceId: string; tenantId: string
  }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      const { rows: [p] } = await c.query<{ id: string }>(
        `INSERT INTO payments
           (landlord_id, tenant_id, lease_id, unit_id,
            type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, 'rent', 1020, 'settled', $5, $6)
         RETURNING id`,
        [landlordId, tenantId, leaseId, unitId,
         opts.entryDescription ?? 'FLEXPAY',
         opts.paymentDueDate ?? '2026-06-01'])
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, tenant_fee_amount, pull_day, status, rent_payment_id)
         VALUES ($1, $2, $3, $4, $5, 1000, 20, 15, $6, $7)
         RETURNING id`,
        [opts.cycleMonth ?? '2026-06-01',
         tenantId, landlordId, unitId, leaseId,
         opts.advanceStatus ?? 'pulled',
         p.id])
      await c.query('COMMIT')
      return { paymentId: p.id, advanceId: a.id, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('FLEXPAY-tagged rent + advance in "pulled" → flips to "reconciled" + reconciled_at', async () => {
    const seed = await seedPulledAdvance()
    await reconcileSettledFlexPayPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('reconciled')
    expect(a.reconciled_at).not.toBeNull()
  })

  it('non-FLEXPAY entry_description → entry_description gate, no-op', async () => {
    const seed = await seedPulledAdvance({ entryDescription: 'RENT' })
    await reconcileSettledFlexPayPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('pulled')
  })

  it('advance in "fronted" (not yet pulled) → WHERE status="pulled" filter blocks update', async () => {
    const seed = await seedPulledAdvance({ advanceStatus: 'fronted' })
    await reconcileSettledFlexPayPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('fronted')
  })

  it('unknown payment id → no-op', async () => {
    await expect(reconcileSettledFlexPayPayment(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })

  it('idempotent: second call leaves reconciled_at unchanged', async () => {
    const seed = await seedPulledAdvance()
    await reconcileSettledFlexPayPayment(seed.paymentId)
    const { rows: [a1] } = await db.query<any>(
      `SELECT reconciled_at FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    await new Promise(r => setTimeout(r, 20))
    await reconcileSettledFlexPayPayment(seed.paymentId)
    const { rows: [a2] } = await db.query<any>(
      `SELECT reconciled_at FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(new Date(a2.reconciled_at).getTime())
      .toBe(new Date(a1.reconciled_at).getTime())
  })
})

// ─── handleFlexPayPaymentNsf ───────────────────────────────────

describe('handleFlexPayPaymentNsf', () => {
  async function seedFailedPullPayment(opts: {
    entryDescription?: string
    retryCount?:       number
    advanceStatus?:    'fronted' | 'pulled' | 'nsf' | 'defaulted'
    cycleMonth?:       string
    paymentDueDate?:   string
  } = {}): Promise<{
    paymentId: string; advanceId: string; tenantId: string
  }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await c.query(
        `UPDATE tenants
            SET flexpay_enrolled = TRUE,
                flexpay_pull_day = 15,
                flexpay_monthly_fee = 20
          WHERE id = $1`, [tenantId])
      const { rows: [p] } = await c.query<{ id: string }>(
        `INSERT INTO payments
           (landlord_id, tenant_id, lease_id, unit_id,
            type, amount, status, entry_description, due_date, retry_count)
         VALUES ($1, $2, $3, $4, 'rent', 1020, 'failed', $5, $6, $7)
         RETURNING id`,
        [landlordId, tenantId, leaseId, unitId,
         opts.entryDescription ?? 'FLEXPAY',
         opts.paymentDueDate ?? '2026-06-01',
         opts.retryCount ?? 1])
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, tenant_fee_amount, pull_day, status, rent_payment_id)
         VALUES ($1, $2, $3, $4, $5, 1000, 20, 15, $6, $7)
         RETURNING id`,
        [opts.cycleMonth ?? '2026-06-01',
         tenantId, landlordId, unitId, leaseId,
         opts.advanceStatus ?? 'pulled',
         p.id])
      await c.query('COMMIT')
      return { paymentId: p.id, advanceId: a.id, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('FLEXPAY + retry_count=1 + matching pulled advance → defaulted + 60-day suspension + alert', async () => {
    const seed = await seedFailedPullPayment()
    await handleFlexPayPaymentNsf(seed.paymentId)

    const { rows: [a] } = await db.query<any>(
      `SELECT * FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('defaulted')
    expect(a.default_reason).toBe('tenant_nsf_second_failure')
    expect(a.defaulted_at).not.toBeNull()

    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_disqualified_until, flexpay_disqualified_reason
         FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_pull_day).toBeNull()
    expect(t.flexpay_monthly_fee).toBeNull()
    expect(t.flexpay_disqualified_reason).toBe('nsf_second_failure')
    const until = new Date(t.flexpay_disqualified_until).getTime()
    const expected = Date.now() + FLEXPAY_NSF_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
    expect(Math.abs(until - expected)).toBeLessThan(2 * 24 * 60 * 60 * 1000)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].severity).toBe('warn')
    expect(notif[0].body).toContain(seed.advanceId)
  })

  it('FLEXPAY + retry_count=0 (first failure) → no-op (ACH retry pipeline owns it)', async () => {
    const seed = await seedFailedPullPayment({ retryCount: 0 })
    await handleFlexPayPaymentNsf(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('pulled')
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.flexpay_enrolled).toBe(true)  // still enrolled
    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexpay_advance_defaulted'`)
    expect(notif).toHaveLength(0)
  })

  it('non-FLEXPAY entry_description → entry_description gate, no-op', async () => {
    const seed = await seedFailedPullPayment({ entryDescription: 'RENT' })
    await handleFlexPayPaymentNsf(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flexpay_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('pulled')
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.flexpay_enrolled).toBe(true)
  })

  it('matching advance in defaulted status → no-op (status filter excludes already-defaulted)', async () => {
    const seed = await seedFailedPullPayment({ advanceStatus: 'defaulted' })
    await handleFlexPayPaymentNsf(seed.paymentId)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.flexpay_enrolled).toBe(true)  // not toggled — handler bailed
  })

  it('unknown payment id → no-op', async () => {
    await expect(handleFlexPayPaymentNsf(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })
})
