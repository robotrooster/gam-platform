/**
 * S431 services-audit slice 8: flexpay.ts. S655 (money plan Step 4): the
 * 1st-5th pull-day rule, autopay off at enrollment, one source for every
 * FlexPay figure, and the PDF carrying the shared terms.
 *
 * Covers the public surface that doesn't touch Stripe Connect or the
 * advance/pull-day state machine:
 *   - calculateFlexPayFee (pure formula)
 *   - cycleMonthForDate (pure date util)
 *   - isFlexPayVisible (feature flag)
 *   - getFlexPayEligibility (5 blocker conditions + eligible happy)
 *   - enrollFlexPay (visibility / terms / pullDay / eligibility gates
 *     + happy with acceptance + tenant flag flip)
 *   - cancelFlexPay (simple flag flip)
 *   - autoDisenrollFlexPayOnAchUnverified (idempotent, no cooldown)
 *
 * The cover and pull state machine (coverFlexPayCycle, processFlexPayPullDay,
 * repriceFlexPayRetryPayment, reconcileSettledFlexPayPayment,
 * handleFlexPayPaymentNsf, handleFlexPayPullReversed) is covered against a
 * mocked Stripe in flexpay.stripe.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the acceptance + email modules so enrollFlexPay can be tested
// without dragging in the full FlexSuite-acceptance pipeline.
const recordAcceptanceMock = vi.hoisted(() => vi.fn(async () => 'acc_mock_id'))
const renderAcceptanceMock  = vi.hoisted(() => vi.fn(async () => ({
  renderedText:     'Mock FlexPay Subscription Terms',
  populatedContent: { foo: 'bar' },
})))
const fireEmailMock = vi.hoisted(() => vi.fn(async () => undefined))

// S655: createRentPlatformCharge (stripeConnect) is exercised below against a
// mocked SDK, to see the FlexPay pull's idempotency key reach Stripe.
const paymentIntentsCreateMock = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({ id: 'pi_created', status: 'processing' })))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.paymentIntents = { create: paymentIntentsCreateMock }
  }
  return { default: FakeStripe }
})

vi.mock('./flexsuiteAcceptance', () => ({
  recordAcceptance: recordAcceptanceMock,
  renderFlexPayAcceptanceText: renderAcceptanceMock,
  fireFlexsuiteAcceptanceEmail: fireEmailMock,
  FLEXPAY_TEMPLATE_VERSION: 'v1.0.0-test',
}))

import {
  FLEXPAY_RETURNED_PULL_FEE, FLEXPAY_REJOIN_WAIT_DAYS, FLEXPAY_TERMS, PLATFORM_FEES,
} from '@gam/shared'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  FLEXPAY_MONTHLY_FEE, FLEXPAY_MAX_PULL_DAY, FLEXPAY_REHAB_CLEAN_PULLS,
  FLEXPAY_ACH_RETURN_FEE, FLEXPAY_NSF_COOLDOWN_DAYS, FLEXPAY_AUTOPAY_OFF_REASON,
  FLEXPAY_BLOCKER_LABEL, FLEXPAY_BLOCKERS, flexPayBlockerReasons,
  calculateFlexPayFee, cycleMonthForDate,
  isFlexPayVisible, getFlexPayEligibility,
  enrollFlexPay, cancelFlexPay, changeFlexPayPullDay,
  autoDisenrollFlexPayOnAchUnverified,
  applyFlexPayRehabProgress, handleFlexPayPaymentNsf, releaseHeldFlexPayCollection,
  FLEXPAY_HELD_NOTE, FLEXPAY_REQUEUE_NOTE_MARK, FLEXPAY_MAX_GAM_SIDE_REQUEUES,
} from './flexpay'
import { acceptancePdfBody, flexPayPlainTermsText } from './flexsuitePdf'

beforeEach(async () => {
  await cleanupAllSchema()
  recordAcceptanceMock.mockClear()
  recordAcceptanceMock.mockResolvedValue('acc_mock_id')
  fireEmailMock.mockClear()
})

// ─── calculateFlexPayFee (pure) ──────────────────────────────

describe('calculateFlexPayFee', () => {
  it('S562: FLAT $25 regardless of pull day (pull day is scheduling only)', () => {
    expect(calculateFlexPayFee(1)).toBe(FLEXPAY_MONTHLY_FEE)
    expect(calculateFlexPayFee(15)).toBe(25)
    expect(calculateFlexPayFee(FLEXPAY_MAX_PULL_DAY)).toBe(25)
  })

  it('pullDay below 1 → throws', () => {
    expect(() => calculateFlexPayFee(0)).toThrow(/integer 1\.\.28/)
  })

  it('pullDay above 28 → throws', () => {
    expect(() => calculateFlexPayFee(29)).toThrow(/integer 1\.\.28/)
  })

  it('non-integer pullDay → throws', () => {
    expect(() => calculateFlexPayFee(5.5)).toThrow(/integer/)
  })
})

// ─── cycleMonthForDate (pure date) ───────────────────────────

describe('cycleMonthForDate', () => {
  it('mid-month → that month\'s 1st', () => {
    expect(cycleMonthForDate(new Date(Date.UTC(2026, 5, 15)))).toBe('2026-06-01')
  })

  it('first-of-month → same date', () => {
    expect(cycleMonthForDate(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01')
  })

  it('December → December 1st (not next year)', () => {
    expect(cycleMonthForDate(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-01')
  })
})

// ─── isFlexPayVisible ────────────────────────────────────────

describe('isFlexPayVisible', () => {
  it('feature flag off (default) → false', async () => {
    expect(await isFlexPayVisible()).toBe(false)
  })

  it('flag enabled → true', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'S431')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    expect(await isFlexPayVisible()).toBe(true)
  })
})

// ─── getFlexPayEligibility ───────────────────────────────────

describe('getFlexPayEligibility', () => {
  async function seedTenantWithLease(opts: { ach?: boolean } = {}): Promise<{
    tenantId: string
    landlordId: string
    unitId: string
    leaseId: string
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
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      // FlexPay is SSDI/SSI-only (S512) — set the service-tier flag by default.
      await c.query(`UPDATE tenants SET ssi_ssdi=TRUE WHERE id=$1`, [tenantId])
      if (opts.ach !== false) {
        await c.query(`UPDATE tenants SET ach_verified=TRUE WHERE id=$1`, [tenantId])
      }
      await c.query('COMMIT')
      return { tenantId, landlordId, unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('unknown tenant → tenant_not_found', async () => {
    const r = await getFlexPayEligibility('00000000-0000-0000-0000-000000000000')
    expect(r.eligible).toBe(false)
    expect(r.blockers).toEqual(['tenant_not_found'])
  })

  it('ach unverified → ach_unverified blocker', async () => {
    const { tenantId } = await seedTenantWithLease({ ach: false })
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('ach_unverified')
    expect(r.eligible).toBe(false)
  })

  it('NSF cooldown in future → tenant_suspended_nsf + suspended_until', async () => {
    const { tenantId } = await seedTenantWithLease()
    await db.query(
      `UPDATE tenants SET flexpay_disqualified_until = NOW() + INTERVAL '30 days' WHERE id=$1`,
      [tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('tenant_suspended_nsf')
    expect(r.suspended_until).not.toBeNull()
  })

  it('NSF cooldown in past → not a blocker', async () => {
    const { tenantId } = await seedTenantWithLease()
    await db.query(
      `UPDATE tenants SET flexpay_disqualified_until = NOW() - INTERVAL '30 days' WHERE id=$1`,
      [tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).not.toContain('tenant_suspended_nsf')
  })

  it('S310 gate: active FlexDeposit plan → flex_deposit_active', async () => {
    const { tenantId, unitId, leaseId } = await seedTenantWithLease()
    await db.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount,
          flex_deposit_enabled, flex_deposit_plan_status, held_by)
       VALUES ($1, $2, $3, 1000, 500, TRUE, 'active', 'gam_escrow')`,
      [unitId, leaseId, tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('flex_deposit_active')
  })

  it('lease terminated → no_active_lease', async () => {
    const { tenantId, leaseId } = await seedTenantWithLease()
    await db.query(`UPDATE leases SET status='terminated' WHERE id=$1`, [leaseId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('no_active_lease')
  })

  it('S512: not SSDI/SSI → not_ssi_ssdi', async () => {
    const { tenantId } = await seedTenantWithLease()
    await db.query(`UPDATE tenants SET ssi_ssdi=FALSE WHERE id=$1`, [tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('not_ssi_ssdi')
    expect(r.eligible).toBe(false)
  })

  it('existing off-platform deposit (unfunded row) does NOT block — only FlexDeposit gates', async () => {
    // Landlords onboarding bring tenants with deposits paid off-platform; their
    // imported security_deposits rows can read "unfunded" but must not block FlexPay.
    const { tenantId, unitId, leaseId } = await seedTenantWithLease()
    await db.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1, $2, $3, 1000, 0, 'pending', 'landlord')`,
      [unitId, leaseId, tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r.eligible).toBe(true)
    expect(r.blockers).toEqual([])
  })

  it('all baseline conditions met → eligible=true, no blockers', async () => {
    const { tenantId } = await seedTenantWithLease()
    const r = await getFlexPayEligibility(tenantId)
    expect(r.eligible).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.suspended_until).toBeNull()
  })

  it('S581: a tenant on 2+ active leases → multiple_leases blocker (single-lease only)', async () => {
    const { tenantId, landlordId } = await seedTenantWithLease()
    // Same tenant, a SECOND active lease (e.g. a parking spot on another unit).
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ownerUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id=$1`, [landlordId])).rows[0].user_id
      const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      const unit2 = await seedUnit(c, { propertyId, landlordId })
      const lease2 = await seedLease(c, { unitId: unit2, landlordId })
      await seedLeaseTenant(c, { leaseId: lease2, tenantId, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const r = await getFlexPayEligibility(tenantId)
    expect(r.blockers).toContain('multiple_leases')
    expect(r.eligible).toBe(false)
  })

  // S655 Step 4 cleanup: GAM's float is never fronted again before it can be
  // collected — a tenant no pull may reach, or one whose earlier FlexPay
  // money is still open, cannot join.
  it('a tenant whose bank payments are stopped cannot join FlexPay', async () => {
    const { tenantId } = await seedTenantWithLease()
    // ach_verified still TRUE (a verified bank), but the NACHA block is set.
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [tenantId])
    const r = await getFlexPayEligibility(tenantId)
    expect(r).toMatchObject({ eligible: false, blockers: ['bank_payments_stopped'] })
  })

  it('an unrecovered FlexPay write-off blocks rejoining; a recovered one does not', async () => {
    const { tenantId, landlordId, unitId, leaseId } = await seedTenantWithLease()
    const { rows: [adv] } = await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount,
                                     tenant_fee_amount, pull_day, status, defaulted_at, default_reason)
       VALUES ('2026-09-01', $1, $2, $3, $4, 1000, 25, 20, 'defaulted', NOW(), 'pull_not_created') RETURNING id`,
      [tenantId, landlordId, unitId, leaseId])
    // Even a write-off GAM caused (no rejoin wait) blocks until it is collected.
    expect(await getFlexPayEligibility(tenantId)).toMatchObject({ eligible: false, blockers: ['write_off_not_recovered'] })
    await db.query(`UPDATE flexpay_advances SET status = 'reconciled', reconciled_at = NOW() WHERE id = $1`, [adv.id])
    expect(await getFlexPayEligibility(tenantId)).toMatchObject({ eligible: true, blockers: [] })
  })

  it('every blocker has a plain sentence; the rejoin wait names its day', () => {
    for (const b of FLEXPAY_BLOCKERS) {
      expect(FLEXPAY_BLOCKER_LABEL[b]).toMatch(/^[A-Z].*\.$/)
      expect(FLEXPAY_BLOCKER_LABEL[b]).not.toMatch(/_|\b(owe|owed|repay|loan|borrow|debt)\b/i)
    }
    expect(flexPayBlockerReasons({ blockers: ['tenant_suspended_nsf'], suspended_until: '2027-01-15T19:00:00Z' }))
      .toEqual(['GAM could not collect a FlexPay payment from your bank, so you can join FlexPay again on January 15, 2027.'])
  })
})

// ─── enrollFlexPay ───────────────────────────────────────────

describe('enrollFlexPay', () => {
  async function seedReady(): Promise<{ tenantId: string; userId: string }> {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'S431')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    // S544 survey-mode launch switch + S541 approved-inquiry gate — both
    // must be open for the enrollment machinery these tests exercise.
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_enrollment_open', TRUE, 'S544 launch switch')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
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
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(`UPDATE tenants SET ach_verified=TRUE, ssi_ssdi=TRUE WHERE id=$1`, [tenantId])
      // S541 demand-test gate: enrollment requires an APPROVED inquiry.
      await c.query(
        `INSERT INTO flexpay_inquiries (tenant_id, status, claimed_income_source, reviewed_at)
         VALUES ($1, 'approved', 'ssdi', now())`, [tenantId])
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, userId: user_id }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('feature flag off → refuses', async () => {
    const { tenantId, userId } = await seedReady()
    await db.query(`UPDATE system_features SET enabled=FALSE WHERE key='flexpay_rollout_visible'`)
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 10,
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not enabled/i)
  })

  it('acceptedTerms !== true → refuses', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 10,
      acceptedTerms: false, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/acceptance required/i)
  })

  it('pullDay out of range → refuses, naming the days a tenant may pick', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 30,  // > 28
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r).toEqual({ ok: false, reason: 'Pick a pull day from the 6th through the 28th. The 1st through the 5th are not offered.' })
  })

  it('ineligible tenant (ACH unverified) → refuses, saying why in plain words', async () => {
    const { tenantId, userId } = await seedReady()
    await db.query(`UPDATE tenants SET ach_verified=FALSE WHERE id=$1`, [tenantId])
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 10,
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r).toEqual({ ok: false, reason: FLEXPAY_BLOCKER_LABEL.ach_unverified })
  })

  it('an ineligible tenant is told why in plain words, never an enum', async () => {
    const { tenantId, userId } = await seedReady()
    await db.query(
      `UPDATE tenants SET ach_verified = FALSE, ach_suspended_at = NOW(),
                          flexpay_permanently_banned = TRUE WHERE id = $1`, [tenantId])
    const r = await enrollFlexPay({ tenantId, userId, pullDay: 10, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe([
      FLEXPAY_BLOCKER_LABEL.permanently_banned,
      FLEXPAY_BLOCKER_LABEL.ach_unverified,
      FLEXPAY_BLOCKER_LABEL.bank_payments_stopped,
    ].join(' '))
    expect(r.reason).not.toMatch(/_|Not eligible:/)
    expect(recordAcceptanceMock).not.toHaveBeenCalled()
  })

  it('happy: enrolled + fee stamped + acceptance recorded + email fired', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 10,
      acceptedTerms: true, ip: '1.2.3.4', userAgent: 'test/1.0',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fee).toBe(25)  // S562: flat $25 regardless of pull day
      expect(r.acceptanceId).toBe('acc_mock_id')
    }
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_enrolled_at FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(true)
    expect(t.flexpay_pull_day).toBe(10)
    expect(Number(t.flexpay_monthly_fee)).toBe(25)
    expect(t.flexpay_enrolled_at).not.toBeNull()
    expect(recordAcceptanceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, userId, productType: 'flexpay',
    }))
    // Email is fire-and-forget; just verify it was kicked off.
    expect(fireEmailMock).toHaveBeenCalled()
  })

  it('pull days 1-5 are refused at enrollment, in plain words, before anything is written', async () => {
    const { tenantId, userId } = await seedReady()
    for (const pullDay of [1, 2, 3, 4, 5]) {
      const r = await enrollFlexPay({ tenantId, userId, pullDay, acceptedTerms: true, ip: null, userAgent: null })
      expect(r).toEqual({ ok: false, reason: 'Pick a pull day from the 6th through the 28th. The 1st through the 5th are not offered.' })
    }
    expect(recordAcceptanceMock).not.toHaveBeenCalled()
    const { rows: [t] } = await db.query<any>(`SELECT flexpay_enrolled FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(false)
  })

  it('the 6th is the first day offered', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({ tenantId, userId, pullDay: 6, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(true)
  })

  it('enrollment turns autopay off, saying why, in the same transaction', async () => {
    const { tenantId, userId } = await seedReady()
    const { rows: [lt] } = await db.query<{ lease_id: string }>(
      `SELECT lease_id FROM lease_tenants WHERE tenant_id = $1`, [tenantId])
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day) VALUES ($1, $2, TRUE, 3)`,
      [tenantId, lt.lease_id])
    const r = await enrollFlexPay({ tenantId, userId, pullDay: 10, acceptedTerms: true, ip: null, userAgent: null })
    expect(r.ok).toBe(true)
    const { rows: [a] } = await db.query<any>(
      `SELECT enabled, disarmed_at, disarmed_reason FROM tenant_autopay WHERE tenant_id = $1`, [tenantId])
    expect(a.enabled).toBe(false)
    expect(a.disarmed_at).not.toBeNull()
    expect(a.disarmed_reason).toBe(FLEXPAY_AUTOPAY_OFF_REASON)
    expect(a.disarmed_reason).not.toMatch(/_/)   // plain words, never an enum
  })

  it('a refused enrollment leaves autopay on', async () => {
    const { tenantId, userId } = await seedReady()
    const { rows: [lt] } = await db.query<{ lease_id: string }>(
      `SELECT lease_id FROM lease_tenants WHERE tenant_id = $1`, [tenantId])
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day) VALUES ($1, $2, TRUE, 3)`,
      [tenantId, lt.lease_id])
    await enrollFlexPay({ tenantId, userId, pullDay: 3, acceptedTerms: true, ip: null, userAgent: null })
    const { rows: [a] } = await db.query<any>(`SELECT enabled FROM tenant_autopay WHERE tenant_id = $1`, [tenantId])
    expect(a.enabled).toBe(true)
  })

  it('email failure does NOT roll back enrollment (best-effort)', async () => {
    const { tenantId, userId } = await seedReady()
    fireEmailMock.mockRejectedValueOnce(new Error('SMTP down'))
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 10,
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(true)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(true)
  })
})

// ─── cancelFlexPay ───────────────────────────────────────────

describe('cancelFlexPay', () => {
  it('clears enrolled flag + pull_day + fee', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query(
        `UPDATE tenants
            SET flexpay_enrolled=TRUE, flexpay_pull_day=5, flexpay_monthly_fee=10
          WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await cancelFlexPay(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee
         FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(false)
    expect(t.flexpay_pull_day).toBeNull()
    expect(t.flexpay_monthly_fee).toBeNull()
  })
})

// ─── autoDisenrollFlexPayOnAchUnverified ─────────────────────

describe('autoDisenrollFlexPayOnAchUnverified', () => {
  it('disenrolls when currently enrolled', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      // As its one caller does (routes/payments.ts, a zero-tolerance bank
      // return): bank payments are stopped on the tenant first.
      await c.query(
        `UPDATE tenants SET flexpay_enrolled=TRUE, flexpay_pull_day=5,
                            flexpay_monthly_fee=10, ach_suspended_at = NOW() WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await autoDisenrollFlexPayOnAchUnverified(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until, user_id FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.flexpay_enrolled).toBe(false)
    // Step 10 (decisions #37.D, FlexPay terms §4.3 "Bank payments stopped"):
    // the tenant's side — the 90-day rejoin wait applies.
    expect(Math.abs(new Date(t.flexpay_disqualified_until).getTime() - (Date.now() + 90 * 86_400_000))).toBeLessThan(86_400_000)
    // The tenant is told FlexPay ended, why, and that autopay is off.
    const notes = (await db.query<any>(
      `SELECT title, body, action_url FROM notifications WHERE user_id = $1 AND type = 'flexpay_ended'`, [t.user_id])).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Your FlexPay has ended')
    expect(notes[0].body).toContain('Bank payments are stopped on your account after a bank payment was returned')
    expect(notes[0].body).toContain('Autopay is off. You can turn it on in Payments')
    expect(notes[0].action_url).toBe('/payments')
    // A second call ends nothing and tells nobody again.
    await autoDisenrollFlexPayOnAchUnverified(tenantId)
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'flexpay_ended'`, [t.user_id])).rowCount).toBe(1)
  })

  it('idempotent: second call is a noop', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query('COMMIT')
    } finally { c.release() }
    // Tenant starts NOT enrolled → WHERE filter excludes; UPDATE affects 0 rows.
    await autoDisenrollFlexPayOnAchUnverified(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(false)
  })
})

// ─── changeFlexPayPullDay (next-cycle-effective) ─────────────────
describe('changeFlexPayPullDay', () => {
  async function seedEnrolled(pullDay = 10): Promise<string> {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'test')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(
        `UPDATE tenants SET ach_verified=TRUE, ssi_ssdi=TRUE,
            flexpay_enrolled=TRUE, flexpay_pull_day=$2, flexpay_monthly_fee=$3 WHERE id=$1`,
        [tenantId, pullDay, 5 + pullDay])
      await c.query('COMMIT')
      return tenantId
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('happy: updates pull day + recomputes fee, effective next cycle', async () => {
    const tenantId = await seedEnrolled(10)
    const out = await changeFlexPayPullDay(tenantId, 20)
    expect(out.ok).toBe(true)
    expect(out.pullDay).toBe(20)
    expect(out.fee).toBe(25)            // $5 + 20
    expect(out.effective).toBe('next_cycle')
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_pull_day, flexpay_monthly_fee FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_pull_day).toBe(20)
    expect(Number(t.flexpay_monthly_fee)).toBe(25)
  })

  it('invalid pull day → rejected, no change', async () => {
    const tenantId = await seedEnrolled(10)
    const out = await changeFlexPayPullDay(tenantId, 31)
    expect(out.ok).toBe(false)
    const { rows: [t] } = await db.query<any>(`SELECT flexpay_pull_day FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_pull_day).toBe(10)   // unchanged
  })

  it('not enrolled → rejected', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'test')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query('COMMIT')
    } finally { c.release() }
    const out = await changeFlexPayPullDay(tenantId, 15)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/not enrolled/i)
  })

  it('the 1st-5th are refused, unchanged', async () => {
    const tenantId = await seedEnrolled(10)
    const out = await changeFlexPayPullDay(tenantId, 4)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/6th through the 28th/)
    const { rows: [t] } = await db.query<any>(`SELECT flexpay_pull_day FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_pull_day).toBe(10)
  })

  it('flag off → rejected', async () => {
    const tenantId = await seedEnrolled(10)
    await db.query(`UPDATE system_features SET enabled=FALSE WHERE key='flexpay_rollout_visible'`)
    const out = await changeFlexPayPullDay(tenantId, 20)
    expect(out.ok).toBe(false)
  })
})

// ─── S578: returner rehab clock + permanent (2nd-default) ban ─────
describe('S578 FlexPay returner rehab + permanent ban', () => {
  async function seed(): Promise<{ tenantId: string; landlordId: string; unitId: string; leaseId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(`UPDATE tenants SET ssi_ssdi=TRUE, ach_verified=TRUE WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, landlordId, unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  // A defaulted advance makes the tenant a "returner" (one prior default).
  const seedDefaultedAdvance = (ctx: any, cycleMonth: string) => db.query(
    `INSERT INTO flexpay_advances
       (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
     VALUES ($1,$2,$3,$4,$5,440,25,10,'defaulted',NOW())`,
    [cycleMonth, ctx.tenantId, ctx.landlordId, ctx.unitId, ctx.leaseId])
  const tenantState = async (id: string) => (await db.query<{
    flexpay_clean_streak: number; flexpay_returner_cleared: boolean; flexpay_permanently_banned: boolean; flexpay_disqualified_reason: string | null
  }>(`SELECT flexpay_clean_streak, flexpay_returner_cleared, flexpay_permanently_banned, flexpay_disqualified_reason FROM tenants WHERE id=$1`, [id])).rows[0]

  it('clean first-attempt pulls advance the streak; the 12th clears the returner mark', async () => {
    const ctx = await seed()
    await seedDefaultedAdvance(ctx, '2026-01-01')  // 1 prior default → returner
    for (let i = 0; i < FLEXPAY_REHAB_CLEAN_PULLS - 1; i++) await applyFlexPayRehabProgress(ctx.tenantId, 0)
    let s = await tenantState(ctx.tenantId)
    expect(s.flexpay_clean_streak).toBe(FLEXPAY_REHAB_CLEAN_PULLS - 1)
    expect(s.flexpay_returner_cleared).toBe(false)
    await applyFlexPayRehabProgress(ctx.tenantId, 0)  // 12th clean pull
    s = await tenantState(ctx.tenantId)
    expect(s.flexpay_returner_cleared).toBe(true)
  })

  it('a retry (retry_count>=1) resets the streak even though the pull ultimately cleared', async () => {
    const ctx = await seed()
    await seedDefaultedAdvance(ctx, '2026-01-01')
    for (let i = 0; i < 5; i++) await applyFlexPayRehabProgress(ctx.tenantId, 0)
    expect((await tenantState(ctx.tenantId)).flexpay_clean_streak).toBe(5)
    await applyFlexPayRehabProgress(ctx.tenantId, 1)  // a retry happened this cycle
    const s = await tenantState(ctx.tenantId)
    expect(s.flexpay_clean_streak).toBe(0)
    expect(s.flexpay_returner_cleared).toBe(false)
  })

  it('first-timer (no prior default) never accrues a streak — nothing to rehab', async () => {
    const ctx = await seed()
    await applyFlexPayRehabProgress(ctx.tenantId, 0)
    expect((await tenantState(ctx.tenantId)).flexpay_clean_streak).toBe(0)
  })

  it('permanently banned → eligibility blocker + enroll refused', async () => {
    const ctx = await seed()
    await db.query(`UPDATE tenants SET flexpay_permanently_banned=TRUE WHERE id=$1`, [ctx.tenantId])
    const elig = await getFlexPayEligibility(ctx.tenantId)
    expect(elig.eligible).toBe(false)
    expect(elig.blockers).toContain('permanently_banned')
  })

  it('2nd lifetime default → permanent ban (1st is only a 90-day suspend)', async () => {
    const ctx = await seed()
    await seedDefaultedAdvance(ctx, '2026-01-01')  // the 1st default, already on record
    // 2nd cycle sitting in 'pulled' whose retry payment just failed.
    const cycle = '2026-02-01'
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date, retry_count)
       VALUES ($1,$2,$3,$4,'rent',465,'failed','FLEXPAY',$5,1) RETURNING id`,
      [ctx.landlordId, ctx.tenantId, ctx.leaseId, ctx.unitId, cycle])
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day, status, rent_payment_id)
       VALUES ($1,$2,$3,$4,$5,440,25,10,'pulled',$6)`,
      [cycle, ctx.tenantId, ctx.landlordId, ctx.unitId, ctx.leaseId, pay.rows[0].id])
    await handleFlexPayPaymentNsf(pay.rows[0].id)
    const s = await tenantState(ctx.tenantId)
    expect(s.flexpay_permanently_banned).toBe(true)
    expect(s.flexpay_disqualified_reason).toBe('permanent_second_default')
  })
})

// ─── Step 10: a second ending of any kind ends FlexPay for good (terms §4.3) ───
describe('FlexPay ends for good the second time it ends, whatever the cause (terms §4.3)', () => {
  async function seed(): Promise<{ tenantId: string; landlordId: string; unitId: string; leaseId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(`UPDATE tenants SET ssi_ssdi=TRUE, ach_verified=TRUE WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, landlordId, unitId, leaseId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  /** Enrolled now; `since` days ago. */
  const enroll = (tenantId: string, sinceDays = 1) => db.query(
    `UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25,
                        flexpay_enrolled_at = NOW() - make_interval(days => $2::int) WHERE id = $1`, [tenantId, sinceDays])
  /** The wait from an ending passed, and the tenant joined again (enrollFlexPay's own gates allow it then). */
  const waitPassesAndRejoins = async (tenantId: string) => {
    await db.query(`UPDATE tenants SET flexpay_disqualified_until = NOW() - interval '2 days' WHERE id = $1`, [tenantId])
    await db.query(
      `UPDATE tenants SET flexpay_enrolled = TRUE, flexpay_pull_day = 10, flexpay_monthly_fee = 25,
                          flexpay_enrolled_at = NOW() - interval '1 day' WHERE id = $1`, [tenantId])
  }
  /** A covered month whose pull just failed for good (handleFlexPayPaymentNsf's terminal state). */
  async function failedPull(ctx: { tenantId: string; landlordId: string; unitId: string; leaseId: string }, cycle: string) {
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date, retry_count)
       VALUES ($1,$2,$3,$4,'rent',465,'failed','FLEXPAY',$5,2) RETURNING id`,
      [ctx.landlordId, ctx.tenantId, ctx.leaseId, ctx.unitId, cycle])).rows[0].id
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day, status, rent_payment_id)
       VALUES ($1,$2,$3,$4,$5,440,25,10,'pulled',$6)`,
      [cycle, ctx.tenantId, ctx.landlordId, ctx.unitId, ctx.leaseId, pay])
    return pay
  }
  const state = async (id: string) => (await db.query<any>(
    `SELECT flexpay_enrolled, flexpay_permanently_banned, flexpay_disqualified_until, flexpay_disqualified_reason FROM tenants WHERE id = $1`, [id])).rows[0]

  it('bank payments stopped twice ends FlexPay for good', async () => {
    const ctx = await seed()
    await enroll(ctx.tenantId)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    let s = await state(ctx.tenantId)
    expect(s).toMatchObject({ flexpay_enrolled: false, flexpay_permanently_banned: false, flexpay_disqualified_reason: 'bank_unavailable' })
    await waitPassesAndRejoins(ctx.tenantId)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    s = await state(ctx.tenantId)
    expect(s).toMatchObject({ flexpay_enrolled: false, flexpay_permanently_banned: true, flexpay_disqualified_reason: 'permanent_second_default' })
    expect(s.flexpay_disqualified_until).toBeNull()
    const elig = await getFlexPayEligibility(ctx.tenantId)
    expect(elig.blockers).toContain('permanently_banned')
    // The tenant is told it is for good.
    const { rows: [u] } = await db.query<any>(`SELECT user_id FROM tenants WHERE id = $1`, [ctx.tenantId])
    const notes = (await db.query<any>(`SELECT body FROM notifications WHERE user_id = $1 AND type = 'flexpay_ended' ORDER BY created_at`, [u.user_id])).rows
    expect(notes).toHaveLength(2)
    expect(notes[1].body).toContain('This is the second time, so FlexPay is no longer available on your account.')
  })

  it('bank payments stopped once, then a pull written off in a later enrollment, ends FlexPay for good', async () => {
    const ctx = await seed()
    await enroll(ctx.tenantId)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    await waitPassesAndRejoins(ctx.tenantId)
    const pay = await failedPull(ctx, '2026-11-01')
    await handleFlexPayPaymentNsf(pay)
    expect(await state(ctx.tenantId)).toMatchObject({ flexpay_permanently_banned: true, flexpay_disqualified_reason: 'permanent_second_default' })
  })

  it('a pull written off once, then bank payments stopped in a later enrollment, ends FlexPay for good', async () => {
    const ctx = await seed()
    await enroll(ctx.tenantId)
    const pay = await failedPull(ctx, '2026-09-01')
    await handleFlexPayPaymentNsf(pay)
    expect(await state(ctx.tenantId)).toMatchObject({ flexpay_permanently_banned: false, flexpay_disqualified_reason: 'pull_not_collected' })
    await waitPassesAndRejoins(ctx.tenantId)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    expect(await state(ctx.tenantId)).toMatchObject({ flexpay_enrolled: false, flexpay_permanently_banned: true })
  })

  it('bank payments stopped, then that same enrollment\'s collection written off, is ONE ending: the wait, never the ban', async () => {
    const ctx = await seed()
    await enroll(ctx.tenantId, 40)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    const pay = await failedPull(ctx, '2026-10-01')
    await handleFlexPayPaymentNsf(pay)
    const s = await state(ctx.tenantId)
    expect(s.flexpay_permanently_banned).toBe(false)
    expect(new Date(s.flexpay_disqualified_until).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000)
  })

  it('a failure on GAM\'s side never counts: an earlier GAM-caused write-off does not make a bank stop the second time', async () => {
    const ctx = await seed()
    await db.query(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day,
                                     status, defaulted_at, default_reason)
       VALUES ('2026-08-01',$1,$2,$3,$4,440,25,10,'defaulted',NOW() - interval '60 days','pull_not_created')`,
      [ctx.tenantId, ctx.landlordId, ctx.unitId, ctx.leaseId])
    await enroll(ctx.tenantId)
    await autoDisenrollFlexPayOnAchUnverified(ctx.tenantId)
    expect(await state(ctx.tenantId)).toMatchObject({ flexpay_permanently_banned: false, flexpay_disqualified_reason: 'bank_unavailable' })
  })
})

// ─── Step 10: a collection held for a person can be released ───
describe('releaseHeldFlexPayCollection', () => {
  async function heldCollection(): Promise<{ tenantId: string; advanceId: string; paymentId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(`UPDATE tenants SET ssi_ssdi=TRUE, ach_verified=TRUE, flexpay_enrolled=TRUE, flexpay_pull_day=10, flexpay_monthly_fee=25 WHERE id=$1`, [tenantId])
      const paymentId = (await c.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                               retry_count, stripe_payment_intent_id, revenue_owner)
         VALUES ($1,$2,$3,$4,'fee',469,'failed','FLEXPAY','2026-10-10',1,'pi_held_old','gam') RETURNING id`,
        [landlordId, tenantId, leaseId, unitId])).rows[0].id
      const marks = Array.from({ length: FLEXPAY_MAX_GAM_SIDE_REQUEUES }, (_, i) => `${FLEXPAY_REQUEUE_NOTE_MARK} 2026-10-0${i + 1}: it failed on GAM's side.`).join(' ')
      const advanceId = (await c.query<{ id: string }>(
        `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day,
                                       status, rent_payment_id, pull_date, notes)
         VALUES ('2026-10-01',$1,$2,$3,$4,440,25,10,'pulled',$5,'2026-10-10',$6) RETURNING id`,
        [tenantId, landlordId, unitId, leaseId, paymentId, `${marks} ${FLEXPAY_HELD_NOTE}`])).rows[0].id
      await c.query(`UPDATE payments SET flexpay_advance_id = $2 WHERE id = $1`, [paymentId, advanceId])
      await c.query('COMMIT')
      return { tenantId, advanceId, paymentId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a held collection is made again by the daily pull run once a person releases it, the bank\'s return fee carried at cost', async () => {
    const h = await heldCollection()
    const r = await releaseHeldFlexPayCollection(h.advanceId)
    expect(r).toMatchObject({ outcome: 'released', paymentId: h.paymentId })
    // $440 paid + $25 + one bank return's $4, nothing more.
    expect((r as any).collect).toBe(469)
    const adv = (await db.query<any>(`SELECT status, notes FROM flexpay_advances WHERE id = $1`, [h.advanceId])).rows[0]
    expect(adv.status).toBe('fronted')
    expect(adv.notes).toMatch(/Held collection released by a person/)
    const pay = (await db.query<any>(`SELECT status, stripe_payment_intent_id, amount::float AS a, retry_count FROM payments WHERE id = $1`, [h.paymentId])).rows[0]
    expect(pay).toMatchObject({ status: 'pending', stripe_payment_intent_id: null, a: 469, retry_count: 1 })
    // Nothing is held against the tenant.
    expect((await db.query<any>(`SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id = $1`, [h.tenantId])).rows[0])
      .toEqual({ flexpay_enrolled: true, flexpay_disqualified_until: null })
    // Releasing again changes nothing: it is no longer held.
    expect(await releaseHeldFlexPayCollection(h.advanceId)).toEqual({ outcome: 'not_held' })
  })

  it('a released collection that fails on GAM\'s side again is held again at once', async () => {
    const h = await heldCollection()
    await releaseHeldFlexPayCollection(h.advanceId)
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_again', next_retry_at = NULL WHERE id = $1`, [h.paymentId])
    const r = await handleFlexPayPaymentNsf(h.paymentId, undefined, { gamSide: true, why: 'Stripe refused the request' })
    expect(r).toMatchObject({ wroteOff: false, held: true })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [h.paymentId])).rows[0].status).toBe('failed')
  })

  it('a collection that is not held is never touched', async () => {
    const h = await heldCollection()
    await db.query(`UPDATE flexpay_advances SET notes = 'Cover 2026-10-05: paid 2 bill line(s).' WHERE id = $1`, [h.advanceId])
    expect(await releaseHeldFlexPayCollection(h.advanceId)).toEqual({ outcome: 'not_held' })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [h.paymentId])).rows[0].status).toBe('failed')
  })
})

// ─── S655: one source for every FlexPay figure ───────────────────
describe('FlexPay figures come from the shared terms', () => {
  it('the $25, the $4 returned-pull fee and the 90-day wait are the terms\' own figures', () => {
    expect(FLEXPAY_MONTHLY_FEE).toBe(PLATFORM_FEES.FLOAT_FEE_MO)
    expect(FLEXPAY_ACH_RETURN_FEE).toBe(FLEXPAY_RETURNED_PULL_FEE)
    expect(FLEXPAY_NSF_COOLDOWN_DAYS).toBe(FLEXPAY_REJOIN_WAIT_DAYS)
  })

  it('the FlexPay PDF carries every shared terms section ahead of the accepted text', () => {
    const body = acceptancePdfBody({ product: 'flexpay', renderedText: 'ACCEPTED TEXT' })
    for (const sec of FLEXPAY_TERMS) {
      expect(body).toContain(sec.title)
      expect(body).toContain(sec.body)
    }
    expect(body.indexOf(FLEXPAY_TERMS[0].title)).toBeLessThan(body.indexOf('ACCEPTED TEXT'))
    expect(body.startsWith(flexPayPlainTermsText())).toBe(true)
  })

  it('the FlexDeposit PDF is the accepted text alone', () => {
    expect(acceptancePdfBody({ product: 'flexdeposit', renderedText: 'DEPOSIT TEXT' })).toBe('DEPOSIT TEXT')
  })
})

// ─── S655: the pull's idempotency key reaches Stripe ──────────────
describe('createRentPlatformCharge idempotency key', () => {
  it('sends the key Stripe dedupes on when one is named, and nothing extra otherwise', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
    const { createRentPlatformCharge } = await import('./stripeConnect')
    paymentIntentsCreateMock.mockClear()
    const base = {
      amount: 1085, stripeCustomerId: 'cus_1', paymentMethodId: 'pm_1',
      paymentMethodTypes: ['us_bank_account'] as ('us_bank_account' | 'card')[], entryDescription: 'FLEXPAY',
    }
    await createRentPlatformCharge({ ...base, idempotencyKey: 'flexpay_pull_abc' })
    await createRentPlatformCharge(base)
    const [withKey, withoutKey] = paymentIntentsCreateMock.mock.calls
    expect(withKey[0]).toMatchObject({ amount: 108500, customer: 'cus_1', confirm: true })
    expect(withKey[1]).toEqual({ idempotencyKey: 'flexpay_pull_abc' })
    expect(withoutKey).toHaveLength(1)
  })
})
