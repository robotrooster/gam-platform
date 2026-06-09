/**
 * S444 services-audit slice 20 — otp.ts Stripe state-machine half.
 *
 * Companion to otp.test.ts (S427 — qualification / enable / disable
 * / pure date utilities). Mocks the Stripe SDK at module level so
 * transfers.create is a vi.fn() we can drive per-test, then exercises
 * the four deferred functions:
 *
 *   processMonthlyAdvance — candidate selection (platform / landlord
 *     toggle / enrollment / lease status), advance row + payment row
 *     creation, idempotency via UNIQUE (cycle_month, tenant_id),
 *     no-Connect skip-with-error branch, Stripe-throws branch,
 *     rent/fee rounding.
 *   fireOtpAdvanceTransfer — success path (advance + payment flip to
 *     'advanced'/'settled', stripe_transfer_id stamped, advanced_at
 *     preserved by COALESCE on retry), failure path (transfer_error
 *     captured, admin notification, exception bubbles), NULL
 *     advance_payment_id tolerance.
 *   reconcileSettledRentPayment — type guard, cycle bucket match,
 *     status='advanced' gate, idempotent re-run.
 *   handleRentPaymentNsf — type guard, advanced-match → defaulted +
 *     disqualified + alert, non-match → no tenant mutation.
 *
 * NOT covered: otpScheduler.ts (file-header DISABLED with known schema
 * breaks — testing would lock in broken behavior).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('stripe', () => {
  const transfersCreate = vi.fn(async () => ({ id: 'tr_default' }))
  function FakeStripe(this: any) {
    this.transfers = { create: transfersCreate }
    // Other surfaces touched by getStripe consumers elsewhere — stub
    // so any incidental import chain doesn't blow up if exercised.
    this.accounts = { create: vi.fn(), retrieve: vi.fn() }
    this.accountSessions = { create: vi.fn() }
    this.customers = { create: vi.fn(), retrieve: vi.fn() }
    this.setupIntents = { create: vi.fn() }
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn() }
    this.payouts = { list: vi.fn(), retrieve: vi.fn(), create: vi.fn() }
  }
  ;(FakeStripe as any).__mocks = { transfersCreate }
  return { default: FakeStripe }
})

import Stripe from 'stripe'
import { db } from '../db'
import {
  processMonthlyAdvance,
  fireOtpAdvanceTransfer,
  reconcileSettledRentPayment,
  handleRentPaymentNsf,
} from './otp'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const stripeMocks: { transfersCreate: ReturnType<typeof vi.fn> } =
  (Stripe as any).__mocks

beforeEach(async () => {
  await cleanupAllSchema()
  stripeMocks.transfersCreate.mockReset()
  stripeMocks.transfersCreate.mockResolvedValue({ id: 'tr_default' } as any)
  // lib/stripe.ts:getStripe() throws if STRIPE_SECRET_KEY is unset; the
  // FakeStripe constructor doesn't actually read it, but the env-var
  // check guards the constructor call.
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
})

// ─── shared seeds ──────────────────────────────────────────────

async function enablePlatform(): Promise<void> {
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('otp_rollout_visible', TRUE, 'S444 test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

interface EnrolledSeed {
  tenantId: string
  landlordId: string
  landlordUserId: string
  unitId: string
  leaseId: string
}

async function seedEnrolledTenant(opts: {
  enrolled?:          boolean
  hasConnect?:        boolean
  landlordOtpEnabled?: boolean
  leaseStatus?:       'active' | 'pending' | 'terminated'
  rentAmount?:        number
} = {}): Promise<EnrolledSeed> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: opts.rentAmount })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, {
      unitId, landlordId,
      status:     opts.leaseStatus ?? 'active',
      rentAmount: opts.rentAmount ?? 1000,
    })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })

    if (opts.enrolled !== false) {
      await c.query(
        `UPDATE tenants
            SET on_time_pay_enrolled = TRUE,
                ach_verified = TRUE,
                background_check_status = 'approved'
          WHERE id = $1`,
        [tenantId])
    }
    if (opts.landlordOtpEnabled !== false) {
      await c.query(
        `UPDATE landlords SET otp_rollout_enabled = TRUE WHERE id = $1`,
        [landlordId])
    }
    if (opts.hasConnect !== false) {
      await c.query(
        `UPDATE users SET stripe_connect_account_id = 'acct_otp_test' WHERE id = $1`,
        [landlordUserId])
    }
    await c.query('COMMIT')
    return { tenantId, landlordId, landlordUserId, unitId, leaseId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── processMonthlyAdvance ─────────────────────────────────────

describe('processMonthlyAdvance', () => {
  it('platform flag off → returns zeros, no Stripe call', async () => {
    await seedEnrolledTenant()
    // system_features row never created → flag off.
    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.enrolled_tenants).toBe(0)
    expect(r.advances_created).toBe(0)
    expect(r.advances_funded).toBe(0)
    expect(r.advances_transfer_failed).toBe(0)
    expect(r.errors).toBe(0)
    expect(r.cycle_month).toBe('2026-06-01')
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('happy: enrolled tenant → advance + payment row created, Transfer fired with right shape', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ rentAmount: 1000 })
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_happy_otp' } as any)

    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.enrolled_tenants).toBe(1)
    expect(r.advances_created).toBe(1)
    expect(r.advances_funded).toBe(1)
    expect(r.advances_transfer_failed).toBe(0)
    expect(r.errors).toBe(0)
    expect(r.cycle_month).toBe('2026-06-01')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.status).toBe('advanced')
    expect(adv.stripe_transfer_id).toBe('tr_happy_otp')
    expect(adv.rent_amount).toBe('1000.00')
    expect(adv.fee_amount).toBe('10.00')        // 1000 * 0.01
    expect(adv.advance_amount).toBe('990.00')   // 1000 - 10
    // pg maps `date` columns to JS Date; check the YYYY-MM-DD prefix
    // via toISOString rather than asserting the full timestamp.
    expect(new Date(adv.cycle_month).toISOString().slice(0, 10)).toBe('2026-06-01')
    expect(adv.advance_payment_id).not.toBeNull()
    expect(adv.advanced_at).not.toBeNull()
    expect(adv.transfer_error).toBeNull()

    const { rows: [pay] } = await db.query<any>(
      `SELECT * FROM payments WHERE id = $1`, [adv.advance_payment_id])
    expect(pay.status).toBe('settled')
    expect(pay.type).toBe('fee')                // CHECK doesn't carry 'advance'
    expect(pay.entry_description).toBe('ONTIMEPAY')
    expect(pay.amount).toBe('990.00')

    // Stripe call shape — amount in cents, destination, metadata,
    // idempotency key.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const [body, callOpts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(body).toMatchObject({
      amount:      99000, // $990 → 99000 cents
      currency:    'usd',
      destination: 'acct_otp_test',
    })
    expect(body.description).toBe('OTP advance 2026-06-01')
    expect(body.metadata).toMatchObject({
      gam_purpose:     'otp_advance',
      gam_advance_id:  adv.id,
      gam_tenant_id:   seed.tenantId,
      gam_landlord_id: seed.landlordId,
      gam_cycle_month: '2026-06-01',
    })
    expect(callOpts.idempotencyKey).toBe(`otp_advance_${adv.id}`)
  })

  it('idempotency: second run skips via ON CONFLICT, no new Stripe call', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ rentAmount: 1000 })

    const r1 = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r1.advances_created).toBe(1)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)

    stripeMocks.transfersCreate.mockClear()
    const r2 = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r2.advances_created).toBe(0)
    expect(r2.advances_skipped_already_exist).toBe(1)
    expect(r2.advances_funded).toBe(0)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('no Connect account at advance time → row created in pending, no Stripe call, transferFailed++', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant({ hasConnect: false })

    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.advances_created).toBe(1)
    expect(r.advances_funded).toBe(0)
    expect(r.advances_transfer_failed).toBe(1)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.status).toBe('pending')           // unchanged from initial INSERT
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.transfer_attempted_at).not.toBeNull()
    expect(adv.transfer_error).toMatch(/no Stripe Connect account/i)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'otp_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].severity).toBe('warn')
  })

  it('Stripe Transfer throws → row stays pending with transfer_error, alert fired, transferFailed++', async () => {
    await enablePlatform()
    const seed = await seedEnrolledTenant()
    stripeMocks.transfersCreate.mockRejectedValueOnce(
      new Error('Insufficient platform balance'))

    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.advances_created).toBe(1)
    expect(r.advances_funded).toBe(0)
    expect(r.advances_transfer_failed).toBe(1)
    expect(r.errors).toBe(0)                     // caught by inner try, not outer

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE tenant_id = $1`, [seed.tenantId])
    expect(adv.status).toBe('pending')
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.transfer_error).toBe('Insufficient platform balance')
    expect(adv.transfer_attempted_at).not.toBeNull()
    // Linked payments row stays 'pending' — success-path CTE never ran.
    const { rows: [pay] } = await db.query<any>(
      `SELECT status FROM payments WHERE id = $1`, [adv.advance_payment_id])
    expect(pay.status).toBe('pending')

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'otp_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
  })

  it('candidate filter: tenant on_time_pay_enrolled=FALSE excluded', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ enrolled: false })
    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.enrolled_tenants).toBe(0)
    expect(r.advances_created).toBe(0)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('candidate filter: landlord otp_rollout_enabled=FALSE excluded', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ landlordOtpEnabled: false })
    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.enrolled_tenants).toBe(0)
    expect(r.advances_created).toBe(0)
  })

  it('candidate filter: terminated lease excluded', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ leaseStatus: 'terminated' })
    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.enrolled_tenants).toBe(0)
    expect(r.advances_created).toBe(0)
  })

  it('rent / fee rounding: $1234.56 rent → fee $12.35, advance $1222.21, transfer amount = 122221¢', async () => {
    await enablePlatform()
    await seedEnrolledTenant({ rentAmount: 1234.56 })
    const r = await processMonthlyAdvance(new Date(Date.UTC(2026, 4, 28, 12)))
    expect(r.advances_funded).toBe(1)

    const { rows: [adv] } = await db.query<any>(`SELECT * FROM otp_advances`)
    expect(adv.fee_amount).toBe('12.35')         // round2(1234.56 * 0.01)
    expect(adv.advance_amount).toBe('1222.21')   // 1234.56 - 12.35
    expect(adv.rent_amount).toBe('1234.56')

    const [body] = stripeMocks.transfersCreate.mock.calls[0]
    expect(body.amount).toBe(122221)             // round($1222.21 * 100)
  })
})

// ─── fireOtpAdvanceTransfer (direct unit) ──────────────────────

describe('fireOtpAdvanceTransfer', () => {
  async function seedPendingAdvance(opts: { withPayment?: boolean } = {}): Promise<{
    advanceId:  string
    paymentId:  string | null
    tenantId:   string
    landlordId: string
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

      let paymentId: string | null = null
      if (opts.withPayment !== false) {
        const { rows: [p] } = await c.query<{ id: string }>(
          `INSERT INTO payments
             (landlord_id, tenant_id, lease_id, unit_id,
              type, amount, status, entry_description, due_date)
           VALUES ($1, $2, $3, $4, 'fee', 990, 'pending', 'ONTIMEPAY', '2026-06-01')
           RETURNING id`,
          [landlordId, tenantId, leaseId, unitId])
        paymentId = p.id
      }
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO otp_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, fee_amount, advance_amount, status, advance_payment_id)
         VALUES ('2026-06-01', $1, $2, $3, $4, 1000, 10, 990, 'pending', $5)
         RETURNING id`,
        [tenantId, landlordId, unitId, leaseId, paymentId])
      await c.query('COMMIT')
      return { advanceId: a.id, paymentId, tenantId, landlordId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('success → advance "advanced", stripe_transfer_id stamped, advanced_at set, payment "settled"', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_fired' } as any)

    const result = await fireOtpAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_landlord_1',
      amount:          990,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })
    expect(result.stripeTransferId).toBe('tr_fired')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('advanced')
    expect(adv.stripe_transfer_id).toBe('tr_fired')
    expect(adv.advanced_at).not.toBeNull()
    expect(adv.transfer_attempted_at).not.toBeNull()
    expect(adv.transfer_error).toBeNull()

    const { rows: [pay] } = await db.query<any>(
      `SELECT status FROM payments WHERE id = $1`, [seed.paymentId])
    expect(pay.status).toBe('settled')

    // S244 idempotency contract.
    const [, callOpts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(callOpts.idempotencyKey).toBe(`otp_advance_${seed.advanceId}`)
  })

  it('failure → transfer_error captured, status stays "pending", admin notification, throws', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate.mockRejectedValueOnce(
      new Error('platform_account_inactive'))

    await expect(fireOtpAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_landlord_1',
      amount:          990,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })).rejects.toThrow('platform_account_inactive')

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('pending')
    expect(adv.stripe_transfer_id).toBeNull()
    expect(adv.transfer_error).toBe('platform_account_inactive')
    expect(adv.transfer_attempted_at).not.toBeNull()
    const { rows: [pay] } = await db.query<any>(
      `SELECT status FROM payments WHERE id = $1`, [seed.paymentId])
    expect(pay.status).toBe('pending')

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'otp_advance_transfer_failed'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].title).toMatch(/2026-06-01/)
    expect(notif[0].body).toContain(seed.advanceId)
  })

  it('caller-side idempotent: second success preserves advanced_at via COALESCE, updates stripe_transfer_id', async () => {
    const seed = await seedPendingAdvance()
    stripeMocks.transfersCreate
      .mockResolvedValueOnce({ id: 'tr_first' } as any)
      .mockResolvedValueOnce({ id: 'tr_second' } as any)

    await fireOtpAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_1',
      amount:          990,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })
    const { rows: [first] } = await db.query<any>(
      `SELECT advanced_at FROM otp_advances WHERE id = $1`, [seed.advanceId])

    // Force a clock gap so timestamps would differ if COALESCE wasn't
    // pinning advanced_at to the first-set value.
    await new Promise(r => setTimeout(r, 30))

    await fireOtpAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_1',
      amount:          990,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })
    const { rows: [second] } = await db.query<any>(
      `SELECT advanced_at, stripe_transfer_id FROM otp_advances WHERE id = $1`,
      [seed.advanceId])
    expect(new Date(second.advanced_at).getTime())
      .toBe(new Date(first.advanced_at).getTime())
    expect(second.stripe_transfer_id).toBe('tr_second')
  })

  it('tolerates NULL advance_payment_id — no payments row to flip, advance still "advanced"', async () => {
    const seed = await seedPendingAdvance({ withPayment: false })
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_nopay' } as any)

    await expect(fireOtpAdvanceTransfer({
      advanceId:       seed.advanceId,
      landlordConnect: 'acct_1',
      amount:          990,
      cycle:           '2026-06-01',
      tenantId:        seed.tenantId,
      landlordId:      seed.landlordId,
    })).resolves.toMatchObject({ stripeTransferId: 'tr_nopay' })

    const { rows: [adv] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(adv.status).toBe('advanced')
    expect(adv.stripe_transfer_id).toBe('tr_nopay')
  })
})

// ─── reconcileSettledRentPayment ───────────────────────────────

describe('reconcileSettledRentPayment', () => {
  async function setup(opts: {
    advanceStatus?:   'pending' | 'advanced'
    paymentType?:    'rent' | 'fee' | 'utility'
    paymentDueDate?: string
    cycleMonth?:     string
  } = {}): Promise<{ paymentId: string; advanceId: string; tenantId: string }> {
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
         VALUES ($1, $2, $3, $4, $5, 1000, 'settled', 'RENT', $6)
         RETURNING id`,
        [landlordId, tenantId, leaseId, unitId,
         opts.paymentType ?? 'rent',
         opts.paymentDueDate ?? '2026-06-15'])
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO otp_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, fee_amount, advance_amount, status)
         VALUES ($1, $2, $3, $4, $5, 1000, 10, 990, $6)
         RETURNING id`,
        [opts.cycleMonth ?? '2026-06-01',
         tenantId, landlordId, unitId, leaseId,
         opts.advanceStatus ?? 'advanced'])
      await c.query('COMMIT')
      return { paymentId: p.id, advanceId: a.id, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('rent payment with matching advanced advance → flips to reconciled + stamps payment id + reconciled_at', async () => {
    const seed = await setup()
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('reconciled')
    expect(a.reconciled_with_payment_id).toBe(seed.paymentId)
    expect(a.reconciled_at).not.toBeNull()
  })

  it('non-rent payment → type guard returns early, advance unchanged', async () => {
    const seed = await setup({ paymentType: 'fee' })
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('advanced')
  })

  it('cycle bucket mismatch (payment Aug, advance June) → no-op', async () => {
    const seed = await setup({
      paymentDueDate: '2026-08-15', cycleMonth: '2026-06-01',
    })
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('advanced')
  })

  it('advance still "pending" (not yet advanced) → WHERE status="advanced" filter blocks update', async () => {
    const seed = await setup({ advanceStatus: 'pending' })
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('pending')
  })

  it('unknown payment id → no-op (queryOne returns null)', async () => {
    await expect(reconcileSettledRentPayment(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })

  it('idempotent: second call leaves reconciled_at unchanged (status="advanced" filter)', async () => {
    const seed = await setup()
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a1] } = await db.query<any>(
      `SELECT reconciled_at FROM otp_advances WHERE id = $1`, [seed.advanceId])
    await new Promise(r => setTimeout(r, 20))
    await reconcileSettledRentPayment(seed.paymentId)
    const { rows: [a2] } = await db.query<any>(
      `SELECT reconciled_at FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(new Date(a2.reconciled_at).getTime())
      .toBe(new Date(a1.reconciled_at).getTime())
  })
})

// ─── handleRentPaymentNsf ──────────────────────────────────────

describe('handleRentPaymentNsf', () => {
  async function setup(opts: {
    advanceStatus?:  'pending' | 'advanced'
    paymentType?:    'rent' | 'fee'
    paymentDueDate?: string
    cycleMonth?:     string
  } = {}): Promise<{ paymentId: string; advanceId: string; tenantId: string }> {
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
      // Tenant is enrolled — handler is supposed to flip these OFF.
      await c.query(
        `UPDATE tenants SET on_time_pay_enrolled = TRUE, float_fee_active = TRUE
          WHERE id = $1`, [tenantId])
      const { rows: [p] } = await c.query<{ id: string }>(
        `INSERT INTO payments
           (landlord_id, tenant_id, lease_id, unit_id,
            type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, $5, 1000, 'failed', 'RENT', $6)
         RETURNING id`,
        [landlordId, tenantId, leaseId, unitId,
         opts.paymentType ?? 'rent',
         opts.paymentDueDate ?? '2026-06-15'])
      const { rows: [a] } = await c.query<{ id: string }>(
        `INSERT INTO otp_advances
           (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
            rent_amount, fee_amount, advance_amount, status)
         VALUES ($1, $2, $3, $4, $5, 1000, 10, 990, $6)
         RETURNING id`,
        [opts.cycleMonth ?? '2026-06-01',
         tenantId, landlordId, unitId, leaseId,
         opts.advanceStatus ?? 'advanced'])
      await c.query('COMMIT')
      return { paymentId: p.id, advanceId: a.id, tenantId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('matching advance → defaulted + tenant disenrolled + 180-day cooldown + admin alert', async () => {
    const seed = await setup()
    await handleRentPaymentNsf(seed.paymentId)

    const { rows: [a] } = await db.query<any>(
      `SELECT * FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('defaulted')
    expect(a.default_reason).toBe('tenant_nsf')
    expect(a.defaulted_at).not.toBeNull()

    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, float_fee_active,
              otp_disqualified_until, otp_disqualified_reason
         FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.on_time_pay_enrolled).toBe(false)
    expect(t.float_fee_active).toBe(false)
    expect(t.otp_disqualified_reason).toBe('nsf_on_advanced_month')
    const until = new Date(t.otp_disqualified_until).getTime()
    const expected = Date.now() + 180 * 24 * 60 * 60 * 1000
    expect(Math.abs(until - expected)).toBeLessThan(2 * 24 * 60 * 60 * 1000)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'otp_advance_defaulted'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].severity).toBe('warn')
    expect(notif[0].body).toContain(seed.advanceId)
  })

  it('non-rent payment → type guard returns early, tenant unchanged', async () => {
    const seed = await setup({ paymentType: 'fee' })
    await handleRentPaymentNsf(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('advanced')
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, otp_disqualified_until
         FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.on_time_pay_enrolled).toBe(true)
    expect(t.otp_disqualified_until).toBeNull()
  })

  it('no advance in "advanced" state → bail before any mutation (tenant stays enrolled, no alert)', async () => {
    const seed = await setup({ advanceStatus: 'pending' })
    await handleRentPaymentNsf(seed.paymentId)
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, otp_disqualified_until
         FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.on_time_pay_enrolled).toBe(true)
    expect(t.otp_disqualified_until).toBeNull()
    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'otp_advance_defaulted'`)
    expect(notif).toHaveLength(0)
  })

  it('unknown payment id → no-op', async () => {
    await expect(handleRentPaymentNsf(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })

  it('payment due_date in different cycle bucket → no advance match, no mutation', async () => {
    const seed = await setup({
      paymentDueDate: '2026-08-15', cycleMonth: '2026-06-01',
    })
    await handleRentPaymentNsf(seed.paymentId)
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM otp_advances WHERE id = $1`, [seed.advanceId])
    expect(a.status).toBe('advanced')
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled FROM tenants WHERE id = $1`, [seed.tenantId])
    expect(t.on_time_pay_enrolled).toBe(true)
  })
})
