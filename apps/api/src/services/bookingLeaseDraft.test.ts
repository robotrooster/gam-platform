/**
 * The guest-history read every long-stay decision leans on
 * (guestScreeningContext): an approved check this account may rely on, and
 * whether the guest has rented or stayed here continuously since.
 *
 * S639 drafted a lease and emailed a screening link once a reservation crossed
 * 30 nights. 10/5 (Nic, R3): "No automatic lease anywhere" — that is gone
 * (services/stayTerms owns the lease/stay choice and the prepaid screening,
 * stayTerms.test.ts), and the old auto-draft (maybeDraftLeaseFromBooking) is
 * deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { guestScreeningContext, screeningHistorySentence } from './bookingLeaseDraft'

beforeEach(async () => { await cleanupAllSchema() })

describe('10/5 R3: no automatic lease', () => {
  it('the threshold auto-draft is gone — nothing is left to call it', async () => {
    const mod = await import('./bookingLeaseDraft')
    expect('maybeDraftLeaseFromBooking' in mod).toBe(false)
  })
})

// S654: the continuity walk read every lease date as an Invalid Date (a bare
// pg DATE stringified as "Fri Jul 10"), so the walk never advanced and
// continuity was judged off the check date alone. These two cases pin both
// directions: a lease chain that DOES reach today, and an old check with a
// long gap before the current lease.
async function seedHistory(
  email: string, checkDaysAgo: number,
  leases: Array<{ startAgo: number; endAgo: number | null; status: 'active' | 'expired' }>,
) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c, { email })
    const { rows: [t] } = await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    await c.query(
      `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, decided_at)
       VALUES ($1, $2, $3, 'approved', now() - ($4 || ' days')::interval)`,
      [landlordId, t.user_id, tenantId, checkDaysAgo])
    for (const l of leases) {
      const leaseUnit = await seedUnit(c, { propertyId, landlordId })
      const { rows: [d] } = await c.query(
        `SELECT (CURRENT_DATE - $1::int)::text AS s,
                CASE WHEN $2::int IS NULL THEN NULL ELSE (CURRENT_DATE - $2::int)::text END AS e`,
        [l.startAgo, l.endAgo])
      const leaseId = await seedLease(c, { unitId: leaseUnit, landlordId, rentAmount: 900, startDate: d.s, status: l.status })
      await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [leaseId, d.e])
      await seedLeaseTenant(c, { leaseId, tenantId })
    }
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount)
       VALUES ($1, $2, 'Long Stayer', $3, CURRENT_DATE, CURRENT_DATE + 45, 'confirmed', 'month_to_month', 900)
       RETURNING id`,
      [unitId, landlordId, email])
    await c.query('COMMIT')
    return b.id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The history the long-stay notices read, for this booking's guest and company. */
async function contextFor(bookingId: string) {
  const { rows: [b] } = await db.query(
    `SELECT guest_email, landlord_id FROM unit_bookings WHERE id = $1`, [bookingId])
  return guestScreeningContext(b.guest_email, b.landlord_id, null)
}

describe('S654 continuity since an approved check', () => {
  it('a lease starting 5 days after the check and ending 10 days ago is continuous', async () => {
    const email = `cont-${randomUUID().slice(0, 6)}@test.dev`
    const bookingId = await seedHistory(email, 90, [{ startAgo: 85, endAgo: 10, status: 'expired' }])
    const ctx = await contextFor(bookingId)
    expect(ctx.approvedCheckAt).toBeTruthy()
    expect(ctx.continuousTenancySince).toBe(true)
    expect(screeningHistorySentence(ctx)).toMatch(/no new check is needed/)
  })

  it('an old check with a long gap before the current lease is NOT continuous', async () => {
    const email = `gap-${randomUUID().slice(0, 6)}@test.dev`
    const bookingId = await seedHistory(email, 200, [{ startAgo: 20, endAgo: null, status: 'active' }])
    const ctx = await contextFor(bookingId)
    expect(ctx.approvedCheckAt).toBeTruthy()
    expect(ctx.continuousTenancySince).toBe(false)
    expect(screeningHistorySentence(ctx)).toMatch(/haven't stayed with you continuously since/)
  })
})

// S655: the screening context read ANY company's approved check and walked the
// guest's leases at EVERY GAM landlord. Company B's notification then told B
// that company A had approved the guest, on what date, and that the guest had
// lived at other GAM properties since — and B's own screening email was skipped
// on A's say-so. Each company's screening decision is its own.
describe('S655 another company’s check and leases never count', () => {
  // pooled: the applicant ticked "share my screening". viaPoolAccount: the
  // check was run through GAM's renter-pool intake (the is_system pool
  // account) instead of for company A.
  async function seedApprovedElsewhere(email: string, opts: { pooled?: boolean; viaPoolAccount?: boolean } = {}) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      // Company A screened and housed the guest.
      const a = await seedLandlord(c)
      const aProp = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
      const tenantId = await seedTenant(c, { email })
      const { rows: [t] } = await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
      let checkLandlordId = a.landlordId
      if (opts.viaPoolAccount) {
        const pool = await seedLandlord(c)
        await c.query(`UPDATE landlords SET is_system = true WHERE id = $1`, [pool.landlordId])
        checkLandlordId = pool.landlordId
      }
      await c.query(
        `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, decided_at, consent_pool)
         VALUES ($1, $2, $3, 'approved', now() - INTERVAL '90 days', $4)`,
        [checkLandlordId, t.user_id, tenantId, !!opts.pooled])
      const aUnit = await seedUnit(c, { propertyId: aProp, landlordId: a.landlordId })
      const { rows: [d] } = await c.query(`SELECT (CURRENT_DATE - 85)::text AS s`)
      const leaseId = await seedLease(c, { unitId: aUnit, landlordId: a.landlordId, rentAmount: 900, startDate: d.s, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      // Company B takes the long-stay booking.
      const b = await seedLandlord(c)
      const bProp = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
      const bUnit = await seedUnit(c, { propertyId: bProp, landlordId: b.landlordId })
      const { rows: [bk] } = await c.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount)
         VALUES ($1, $2, 'Long Stayer', $3, CURRENT_DATE, CURRENT_DATE + 45, 'confirmed', 'month_to_month', 900)
         RETURNING id`, [bUnit, b.landlordId, email])
      await c.query('COMMIT')
      return bk.id
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a guest approved and housed by another company reads as nothing on file to B', async () => {
    const email = `else-${randomUUID().slice(0, 6)}@test.dev`
    const ctx = await contextFor(await seedApprovedElsewhere(email))
    expect(ctx.approvedCheckAt).toBeNull()
    expect(ctx.continuousTenancySince).toBe(false)
    const said = screeningHistorySentence(ctx)
    expect(said).not.toMatch(/passed a/i)
    expect(said).toMatch(/No background check with you is on file/)
  })

  it('a check another company ran stays that company’s, even with the share box ticked — not counted, not revealed', async () => {
    const email = `shared-${randomUUID().slice(0, 6)}@test.dev`
    const ctx = await contextFor(await seedApprovedElsewhere(email, { pooled: true }))
    expect(ctx.approvedCheckAt).toBeNull()
    expect(ctx.continuousTenancySince).toBe(false)
    expect(screeningHistorySentence(ctx)).not.toMatch(/passed a/i)
  })

  it('a check the guest ran through GAM’s renter pool still counts', async () => {
    const email = `pool-${randomUUID().slice(0, 6)}@test.dev`
    const ctx = await contextFor(await seedApprovedElsewhere(email, { pooled: true, viaPoolAccount: true }))
    expect(ctx.approvedCheckAt).toBeTruthy()
    // Their leases elsewhere are still not this company's business.
    expect(ctx.continuousTenancySince).toBe(false)
  })

  it('a renter-pool intake the guest did NOT agree to share does not count', async () => {
    const email = `nopool-${randomUUID().slice(0, 6)}@test.dev`
    const ctx = await contextFor(await seedApprovedElsewhere(email, { pooled: false, viaPoolAccount: true }))
    expect(ctx.approvedCheckAt).toBeNull()
  })
})
