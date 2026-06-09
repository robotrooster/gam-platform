/**
 * S427 services-audit slice 4: otp.ts.
 *
 * Covers the public surface that doesn't touch Stripe Connect or the
 * advance state machine:
 *   - isOtpVisibleForLandlord (platform + per-landlord gates)
 *   - getQualificationStatus (5 blocker conditions + eligible happy)
 *   - enableOtpForTenant (visibility / connect / qualification / lease
 *     gates + happy)
 *   - disableOtpForTenant (simple flag flip)
 *   - disqualifyTenantForNsf (180-day cooldown)
 *   - autoDisenrollOnAchUnverified (no cooldown)
 *   - cycleMonthFor (FOLLOWING month's 1st)
 *   - cycleMonthForRentDue (rent due_date → month bucket)
 *   - isLastBusinessDayOfMonth
 *
 * Deferred (heavy Stripe Connect / state machine paths):
 *   - processMonthlyAdvance, fireOtpAdvanceTransfer,
 *     reconcileSettledRentPayment, handleRentPaymentNsf
 *
 * Not covered: `services/otpScheduler.ts` — file header marks it
 * DISABLED with known schema breaks (units.tenant_id removed in S26;
 * disbursements column shape changed in 16a). Testing would lock in
 * broken behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  isOtpVisibleForLandlord,
  getQualificationStatus,
  enableOtpForTenant,
  disableOtpForTenant,
  disqualifyTenantForNsf,
  autoDisenrollOnAchUnverified,
  cycleMonthFor,
  cycleMonthForRentDue,
  isLastBusinessDayOfMonth,
} from './otp'

beforeEach(async () => {
  await cleanupAllSchema()
})

// ─── isOtpVisibleForLandlord ─────────────────────────────────

describe('isOtpVisibleForLandlord', () => {
  it('platform flag off → false even if landlord toggle on', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId
      await c.query(`UPDATE landlords SET otp_rollout_enabled=TRUE WHERE id=$1`, [landlordId])
      await c.query('COMMIT')
    } finally { c.release() }
    // No system_features row → off.
    expect(await isOtpVisibleForLandlord(landlordId)).toBe(false)
  })

  it('platform on + landlord toggle on → true', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('otp_rollout_visible', TRUE, 'S427 test')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId
      await c.query(`UPDATE landlords SET otp_rollout_enabled=TRUE WHERE id=$1`, [landlordId])
      await c.query('COMMIT')
    } finally { c.release() }
    expect(await isOtpVisibleForLandlord(landlordId)).toBe(true)
  })

  it('platform on + landlord toggle off → false', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('otp_rollout_visible', TRUE, 'S427 test')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    // landlords.otp_rollout_enabled defaults FALSE.
    expect(await isOtpVisibleForLandlord(landlordId)).toBe(false)
  })
})

// ─── getQualificationStatus ──────────────────────────────────

describe('getQualificationStatus', () => {
  async function seedTenantOnLease(): Promise<{ tenantId: string; landlordId: string; unitId: string; leaseId: string; depositId: string }> {
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
      const { rows: [{ id: depositId }] } = await c.query<{ id: string }>(
        `INSERT INTO security_deposits
           (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by)
         VALUES ($1, $2, $3, 1000, 1000, 'gam_escrow') RETURNING id`,
        [unitId, leaseId, tenantId])
      // Bring tenant to qualifying baseline.
      await c.query(
        `UPDATE tenants SET ach_verified=TRUE, background_check_status='approved'
          WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return { tenantId, landlordId, unitId, leaseId, depositId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('unknown tenant → tenant_not_found, not eligible', async () => {
    const r = await getQualificationStatus('00000000-0000-0000-0000-000000000000')
    expect(r.eligible).toBe(false)
    expect(r.blockers).toEqual(['tenant_not_found'])
  })

  it('ach not verified → ach_unverified blocker', async () => {
    const { tenantId } = await seedTenantOnLease()
    await db.query(`UPDATE tenants SET ach_verified=FALSE WHERE id=$1`, [tenantId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).toContain('ach_unverified')
    expect(r.eligible).toBe(false)
  })

  it('bg check not approved → bg_check_not_approved', async () => {
    const { tenantId } = await seedTenantOnLease()
    await db.query(`UPDATE tenants SET background_check_status='denied' WHERE id=$1`, [tenantId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).toContain('bg_check_not_approved')
  })

  it('deposit not fully funded → deposit_not_funded', async () => {
    const { tenantId, depositId } = await seedTenantOnLease()
    await db.query(`UPDATE security_deposits SET collected_amount=500 WHERE id=$1`, [depositId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).toContain('deposit_not_funded')
  })

  it('active FlexDeposit installments remaining → flex_deposit_active', async () => {
    const { tenantId, depositId } = await seedTenantOnLease()
    await db.query(
      `UPDATE security_deposits
          SET flex_deposit_enabled=TRUE, installments_remaining=3, collected_amount=400
        WHERE id=$1`, [depositId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).toContain('flex_deposit_active')
    expect(r.blockers).not.toContain('deposit_not_funded')  // mutually exclusive
  })

  it('NSF cooldown in future → nsf_cooldown + cooldown_until populated', async () => {
    const { tenantId } = await seedTenantOnLease()
    await db.query(
      `UPDATE tenants SET otp_disqualified_until = NOW() + INTERVAL '60 days' WHERE id=$1`,
      [tenantId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).toContain('nsf_cooldown')
    expect(r.cooldown_until).not.toBeNull()
  })

  it('NSF cooldown in past → not a blocker', async () => {
    const { tenantId } = await seedTenantOnLease()
    await db.query(
      `UPDATE tenants SET otp_disqualified_until = NOW() - INTERVAL '30 days' WHERE id=$1`,
      [tenantId])
    const r = await getQualificationStatus(tenantId)
    expect(r.blockers).not.toContain('nsf_cooldown')
  })

  it('all baseline conditions met → eligible=true, no blockers', async () => {
    const { tenantId } = await seedTenantOnLease()
    const r = await getQualificationStatus(tenantId)
    expect(r.eligible).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.cooldown_until).toBeNull()
  })
})

// ─── enableOtpForTenant ──────────────────────────────────────

describe('enableOtpForTenant', () => {
  async function seedReady(): Promise<{
    tenantId: string; landlordId: string; landlordUserId: string
  }> {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('otp_rollout_visible', TRUE, 'S427')
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
      await c.query(
        `INSERT INTO security_deposits
           (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by)
         VALUES ($1, $2, $3, 1000, 1000, 'gam_escrow')`,
        [unitId, leaseId, tenantId])
      // Bring tenant to qualifying.
      await c.query(
        `UPDATE tenants SET ach_verified=TRUE, background_check_status='approved' WHERE id=$1`,
        [tenantId])
      // Flip landlord visibility flag + stamp Connect account.
      await c.query(`UPDATE landlords SET otp_rollout_enabled=TRUE WHERE id=$1`, [landlordId])
      await c.query(
        `UPDATE users SET stripe_connect_account_id='acct_test_otp' WHERE id=$1`,
        [landlordUserId])
      await c.query('COMMIT')
      return { tenantId, landlordId, landlordUserId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('platform/landlord visibility OFF → refuses', async () => {
    const { tenantId, landlordId, landlordUserId } = await seedReady()
    await db.query(`UPDATE landlords SET otp_rollout_enabled=FALSE WHERE id=$1`, [landlordId])
    const r = await enableOtpForTenant({
      tenantId, landlordId, enabledByUserId: landlordUserId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not enabled for this landlord/i)
  })

  it('landlord has no Stripe Connect account → refuses with clear message', async () => {
    const { tenantId, landlordId, landlordUserId } = await seedReady()
    await db.query(
      `UPDATE users SET stripe_connect_account_id=NULL WHERE id=$1`, [landlordUserId])
    const r = await enableOtpForTenant({
      tenantId, landlordId, enabledByUserId: landlordUserId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Stripe Connect/)
  })

  it('tenant not qualified → refuses with blocker list', async () => {
    const { tenantId, landlordId, landlordUserId } = await seedReady()
    await db.query(`UPDATE tenants SET ach_verified=FALSE WHERE id=$1`, [tenantId])
    const r = await enableOtpForTenant({
      tenantId, landlordId, enabledByUserId: landlordUserId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/ach_unverified/)
  })

  it('tenant not on active lease with landlord → refuses', async () => {
    const { tenantId, landlordId, landlordUserId } = await seedReady()
    await db.query(`UPDATE leases SET status='terminated' WHERE landlord_id=$1`, [landlordId])
    const r = await enableOtpForTenant({
      tenantId, landlordId, enabledByUserId: landlordUserId,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not on an active lease/i)
  })

  it('happy: all gates pass → flips on_time_pay_enrolled + float_fee_active', async () => {
    const { tenantId, landlordId, landlordUserId } = await seedReady()
    const r = await enableOtpForTenant({
      tenantId, landlordId, enabledByUserId: landlordUserId,
    })
    expect(r.ok).toBe(true)
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, float_fee_active FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.on_time_pay_enrolled).toBe(true)
    expect(t.float_fee_active).toBe(true)
  })
})

// ─── disableOtpForTenant ─────────────────────────────────────

describe('disableOtpForTenant', () => {
  it('flips on_time_pay_enrolled + float_fee_active FALSE', async () => {
    const c = await db.connect()
    let tenantId = ''; let landlordId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId
      tenantId = await seedTenant(c)
      await c.query(
        `UPDATE tenants SET on_time_pay_enrolled=TRUE, float_fee_active=TRUE WHERE id=$1`,
        [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await disableOtpForTenant({ tenantId, landlordId, reason: 'tenant requested' })
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, float_fee_active FROM tenants WHERE id=$1`,
      [tenantId])
    expect(t.on_time_pay_enrolled).toBe(false)
    expect(t.float_fee_active).toBe(false)
  })
})

// ─── disqualifyTenantForNsf ──────────────────────────────────

describe('disqualifyTenantForNsf', () => {
  it('stamps otp_disqualified_until 180 days out + reason + disenrolls', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query(
        `UPDATE tenants SET on_time_pay_enrolled=TRUE, float_fee_active=TRUE WHERE id=$1`,
        [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await disqualifyTenantForNsf(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled, float_fee_active, otp_disqualified_until,
              otp_disqualified_reason FROM tenants WHERE id=$1`, [tenantId])
    expect(t.on_time_pay_enrolled).toBe(false)
    expect(t.float_fee_active).toBe(false)
    expect(t.otp_disqualified_reason).toBe('nsf_on_advanced_month')
    // 180 days out ±2 days tolerance.
    const until = new Date(t.otp_disqualified_until).getTime()
    const expected = Date.now() + 180 * 24 * 60 * 60 * 1000
    expect(Math.abs(until - expected)).toBeLessThan(2 * 24 * 60 * 60 * 1000)
  })
})

// ─── autoDisenrollOnAchUnverified ────────────────────────────

describe('autoDisenrollOnAchUnverified', () => {
  it('disenrolls only if currently enrolled (idempotent on already-disenrolled)', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query(
        `UPDATE tenants SET on_time_pay_enrolled=TRUE, float_fee_active=TRUE WHERE id=$1`,
        [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await autoDisenrollOnAchUnverified(tenantId)
    let { rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled FROM tenants WHERE id=$1`, [tenantId])
    expect(t.on_time_pay_enrolled).toBe(false)
    // Second call: no-op (no rows match the WHERE filter).
    await autoDisenrollOnAchUnverified(tenantId)
    ;({ rows: [t] } = await db.query<any>(
      `SELECT on_time_pay_enrolled FROM tenants WHERE id=$1`, [tenantId]))
    expect(t.on_time_pay_enrolled).toBe(false)
  })

  it('no cooldown stamped (distinct from disqualifyTenantForNsf)', async () => {
    const c = await db.connect()
    let tenantId = ''
    try {
      await c.query('BEGIN')
      tenantId = await seedTenant(c)
      await c.query(`UPDATE tenants SET on_time_pay_enrolled=TRUE WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
    } finally { c.release() }
    await autoDisenrollOnAchUnverified(tenantId)
    const { rows: [t] } = await db.query<any>(
      `SELECT otp_disqualified_until FROM tenants WHERE id=$1`, [tenantId])
    expect(t.otp_disqualified_until).toBeNull()
  })
})

// ─── pure date utilities ─────────────────────────────────────

describe('cycleMonthFor', () => {
  it('mid-month → following month\'s 1st', () => {
    expect(cycleMonthFor(new Date(Date.UTC(2026, 5, 15)))).toBe('2026-07-01')
  })

  it('December cron → next-year January 1st', () => {
    expect(cycleMonthFor(new Date(Date.UTC(2026, 11, 28)))).toBe('2027-01-01')
  })

  it('January cron → February 1st', () => {
    expect(cycleMonthFor(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-02-01')
  })
})

describe('cycleMonthForRentDue', () => {
  it('mid-month rent due → that month\'s 1st bucket', () => {
    expect(cycleMonthForRentDue(new Date(Date.UTC(2026, 10, 5)))).toBe('2026-11-01')
  })

  it('first-of-month rent due → same date', () => {
    expect(cycleMonthForRentDue(new Date(Date.UTC(2026, 2, 1)))).toBe('2026-03-01')
  })
})

describe('isLastBusinessDayOfMonth', () => {
  it('weekend → false', () => {
    // 2026-04-04 = Saturday
    expect(isLastBusinessDayOfMonth(new Date(Date.UTC(2026, 3, 4)))).toBe(false)
  })

  it('last weekday of month → true', () => {
    // 2026-04-30 = Thursday; May 1 is Friday so April 30 is NOT the
    // last business day. Use 2026-05-29 (Friday); May 30+31 are Sat/Sun.
    expect(isLastBusinessDayOfMonth(new Date(Date.UTC(2026, 4, 29)))).toBe(true)
  })

  it('mid-month weekday → false', () => {
    expect(isLastBusinessDayOfMonth(new Date(Date.UTC(2026, 4, 15)))).toBe(false)
  })

  it('month ending Sunday → the Friday before is last business day', () => {
    // 2026-06: last day is Tue 30. So June 30 itself is last business day.
    expect(isLastBusinessDayOfMonth(new Date(Date.UTC(2026, 5, 30)))).toBe(true)
  })
})
