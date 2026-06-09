/**
 * S431 services-audit slice 8: flexpay.ts.
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
 * Deferred (heavy Stripe Connect / state machine):
 *   - processGracePeriodAdvance, fireFlexPayAdvanceTransfer,
 *     processFlexPayPullDay, reconcileSettledFlexPayPayment,
 *     handleFlexPayPaymentNsf
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

vi.mock('./flexsuiteAcceptance', () => ({
  recordAcceptance: recordAcceptanceMock,
  renderFlexPayAcceptanceText: renderAcceptanceMock,
  fireFlexsuiteAcceptanceEmail: fireEmailMock,
  FLEXPAY_TEMPLATE_VERSION: 'v1.0.0-test',
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  FLEXPAY_FEE_BASE, FLEXPAY_MAX_PULL_DAY,
  calculateFlexPayFee, cycleMonthForDate,
  isFlexPayVisible, getFlexPayEligibility,
  enrollFlexPay, cancelFlexPay,
  autoDisenrollFlexPayOnAchUnverified,
} from './flexpay'

beforeEach(async () => {
  await cleanupAllSchema()
  recordAcceptanceMock.mockClear()
  recordAcceptanceMock.mockResolvedValue('acc_mock_id')
  fireEmailMock.mockClear()
})

// ─── calculateFlexPayFee (pure) ──────────────────────────────

describe('calculateFlexPayFee', () => {
  it('formula: $5 base + pullDay; pullDay=1 → $6; pullDay=28 → $33', () => {
    expect(calculateFlexPayFee(1)).toBe(FLEXPAY_FEE_BASE + 1)
    expect(calculateFlexPayFee(15)).toBe(20)
    expect(calculateFlexPayFee(FLEXPAY_MAX_PULL_DAY)).toBe(33)
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

  it('all baseline conditions met → eligible=true, no blockers', async () => {
    const { tenantId } = await seedTenantWithLease()
    const r = await getFlexPayEligibility(tenantId)
    expect(r.eligible).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.suspended_until).toBeNull()
  })
})

// ─── enrollFlexPay ───────────────────────────────────────────

describe('enrollFlexPay', () => {
  async function seedReady(): Promise<{ tenantId: string; userId: string }> {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'S431')
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
      await c.query(`UPDATE tenants SET ach_verified=TRUE WHERE id=$1`, [tenantId])
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
      tenantId, userId, pullDay: 5,
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not enabled/i)
  })

  it('acceptedTerms !== true → refuses', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 5,
      acceptedTerms: false, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/acceptance required/i)
  })

  it('pullDay out of range → refuses', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 30,  // > 28
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Pull day/i)
  })

  it('ineligible tenant (ACH unverified) → refuses with blocker list', async () => {
    const { tenantId, userId } = await seedReady()
    await db.query(`UPDATE tenants SET ach_verified=FALSE WHERE id=$1`, [tenantId])
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 5,
      acceptedTerms: true, ip: null, userAgent: null,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/ach_unverified/)
  })

  it('happy: enrolled + fee stamped + acceptance recorded + email fired', async () => {
    const { tenantId, userId } = await seedReady()
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 5,
      acceptedTerms: true, ip: '1.2.3.4', userAgent: 'test/1.0',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fee).toBe(10)  // $5 base + 5
      expect(r.acceptanceId).toBe('acc_mock_id')
    }
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_enrolled_at FROM tenants WHERE id=$1`, [tenantId])
    expect(t.flexpay_enrolled).toBe(true)
    expect(t.flexpay_pull_day).toBe(5)
    expect(Number(t.flexpay_monthly_fee)).toBe(10)
    expect(t.flexpay_enrolled_at).not.toBeNull()
    expect(recordAcceptanceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, userId, productType: 'flexpay',
    }))
    // Email is fire-and-forget; just verify it was kicked off.
    expect(fireEmailMock).toHaveBeenCalled()
  })

  it('email failure does NOT roll back enrollment (best-effort)', async () => {
    const { tenantId, userId } = await seedReady()
    fireEmailMock.mockRejectedValueOnce(new Error('SMTP down'))
    const r = await enrollFlexPay({
      tenantId, userId, pullDay: 5,
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
      await c.query(
        `UPDATE tenants SET flexpay_enrolled=TRUE, flexpay_pull_day=5,
                            flexpay_monthly_fee=10 WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await autoDisenrollFlexPayOnAchUnverified(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT flexpay_enrolled, flexpay_disqualified_until FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.flexpay_enrolled).toBe(false)
    // No cooldown stamped — distinct from NSF disqualify.
    expect(t.flexpay_disqualified_until).toBeNull()
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
