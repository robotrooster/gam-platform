/**
 * Property-visitor agent tools (S601) — the pre-booking property agent's tools.
 * Proves: correct live pricing/availability, the booking handoff, and — most
 * importantly — that every tool is HARD-SCOPED to actor.propertyId (no cross-
 * property leakage) and refuses when no property is bound. No LLM involved; the
 * tools' execute() is called directly.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { getClient } from '../../../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../../../test/dbHelpers'
import { getPropertyInfo } from './getPropertyInfo'
import { getPropertyPricing } from './getPropertyPricing'
import { checkPropertyAvailability } from './checkPropertyAvailability'
import { createBookingCheckout } from './createBookingCheckout'
import { getToolsForProfile } from './index'
import { getEntryProfile } from '../profiles'
import type { AgentActor } from './types'

function plusDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

/** A property with a public booking site + two RV site types (back-in / pull-through). */
async function seedBookableProperty(opts: { slug: string; backInNightly?: number; pullThruNightly?: number }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET public_booking_enabled=TRUE, booking_slug=$2,
              booking_intro='Welcome to the park', booking_deposit_pct=20, short_term_tax_rate=0 WHERE id=$1`,
      [propertyId, opts.slug])
    const subtype = async (name: string, layout: string, amp: string, nightly: number, weekly: number) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name, rv_site_layout, rv_amp_service, nightly_rate, weekly_rate)
         VALUES ($1,'rv_spot',$2,$3,$4,$5,$6) RETURNING id`,
        [propertyId, name, layout, amp, nightly, weekly])
      return r.rows[0].id
    }
    const backInId = await subtype('Back-in 30A', 'back_in', '30', opts.backInNightly ?? 45, 270)
    const pullThruId = await subtype('Pull-through 50A', 'pull_through', '50', opts.pullThruNightly ?? 65, 390)
    const mkUnit = async (subtypeId: string) => {
      const unitId = await seedUnit(client, { propertyId, landlordId, unitType: 'rv_spot' })
      await client.query(
        `UPDATE units SET is_bookable=TRUE, lease_types_allowed=ARRAY['nightly','weekly'], subtype_id=$2 WHERE id=$1`,
        [unitId, subtypeId])
      return unitId
    }
    await mkUnit(backInId)
    await mkUnit(pullThruId)
    await client.query('COMMIT')
    return { propertyId, landlordId, backInId, pullThruId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const actorFor = (propertyId?: string): AgentActor =>
  ({ userId: 'sess-1', role: 'visitor', profileId: propertyId ?? 'sess-1', propertyId })

beforeEach(async () => { await cleanupAllSchema() })

describe('property agent — registration + audience isolation', () => {
  it('the visitor profile exposes exactly the four property tools', () => {
    const profile = getEntryProfile('visitor')!
    expect(profile).toBeTruthy()
    const names = getToolsForProfile(profile).map((t) => t.name).sort()
    expect(names).toEqual(['check_availability', 'create_booking_checkout', 'get_property_info', 'get_property_pricing'])
  })

  it('every property tool is visitor-only (never surfaced to other audiences)', () => {
    for (const t of [getPropertyInfo, getPropertyPricing, checkPropertyAvailability, createBookingCheckout]) {
      expect(t.audiences).toEqual(['visitor'])
    }
  })
})

describe('property agent — scope guard (no property bound)', () => {
  it('each tool refuses when actor.propertyId is missing', async () => {
    const a = actorFor(undefined)
    for (const t of [getPropertyInfo, getPropertyPricing, checkPropertyAvailability, createBookingCheckout]) {
      const r: any = await t.execute({ checkIn: plusDays(2), checkOut: plusDays(4), siteTypeId: 'x', guestName: 'A', guestEmail: 'a@b.com' }, a)
      expect(r.ok).toBe(false)
    }
  })
})

describe('property agent — live pricing', () => {
  it('lists each site type with its layout + live rate', async () => {
    const { propertyId } = await seedBookableProperty({ slug: 'park-a', backInNightly: 45, pullThruNightly: 65 })
    const r: any = await getPropertyPricing.execute({}, actorFor(propertyId))
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries(r.siteTypes.map((s: any) => [s.name, s]))
    expect(byName['Back-in 30A'].layout).toBe('Back-in')
    expect(byName['Back-in 30A'].nightlyRate).toBe(45)
    expect(byName['Pull-through 50A'].layout).toBe('Pull-through')
    expect(byName['Pull-through 50A'].nightlyRate).toBe(65)
    expect(byName['Pull-through 50A'].ampService).toBe('50 amp')
  })
})

describe('property agent — HARD property scope (no cross-property leak)', () => {
  it('pricing for property A never returns property B’s site types', async () => {
    const a = await seedBookableProperty({ slug: 'park-a', backInNightly: 45 })
    await seedBookableProperty({ slug: 'park-b', backInNightly: 999 })  // distinct rates
    const r: any = await getPropertyPricing.execute({}, actorFor(a.propertyId))
    expect(r.ok).toBe(true)
    // Only A's rate appears; B's 999 nightly must never leak in.
    const rates = r.siteTypes.map((s: any) => s.nightlyRate)
    expect(rates).toContain(45)
    expect(rates).not.toContain(999)
    expect(r.siteTypes).toHaveLength(2)
  })
})

describe('property agent — availability quote', () => {
  it('quotes a real total for open dates (3 nights, no tax)', async () => {
    const { propertyId } = await seedBookableProperty({ slug: 'park-a', backInNightly: 45, pullThruNightly: 65 })
    const r: any = await checkPropertyAvailability.execute(
      { checkIn: plusDays(10), checkOut: plusDays(13) }, actorFor(propertyId))
    expect(r.ok).toBe(true)
    expect(r.nights).toBe(3)
    const byName = Object.fromEntries(r.siteTypes.map((s: any) => [s.name, s]))
    expect(byName['Back-in 30A'].available).toBe(true)
    expect(byName['Back-in 30A'].total).toBe(135)   // 3 × 45
    expect(byName['Pull-through 50A'].total).toBe(195) // 3 × 65
  })
})

describe('property agent — booking handoff', () => {
  it('creates a hold + returns a checkout for an available site type', async () => {
    const { propertyId, pullThruId } = await seedBookableProperty({ slug: 'park-a' })
    const r: any = await createBookingCheckout.execute({
      siteTypeId: pullThruId,
      checkIn: plusDays(20), checkOut: plusDays(23),
      guestName: 'Dana Guest', guestEmail: 'dana@example.com',
    }, actorFor(propertyId))
    expect(r.ok).toBe(true)
    expect(r.bookingId).toBeTruthy()
    expect(r.total).toBeGreaterThan(0)
    expect(r.siteType).toBe('Pull-through 50A')
  })

  it('rejects a bad email before touching the schedule', async () => {
    const { propertyId, pullThruId } = await seedBookableProperty({ slug: 'park-a' })
    const r: any = await createBookingCheckout.execute({
      siteTypeId: pullThruId,
      checkIn: plusDays(20), checkOut: plusDays(23),
      guestName: 'Dana Guest', guestEmail: 'not-an-email',
    }, actorFor(propertyId))
    expect(r.ok).toBe(false)
  })

  it('refuses a site type that belongs to a different property', async () => {
    const a = await seedBookableProperty({ slug: 'park-a' })
    const b = await seedBookableProperty({ slug: 'park-b' })
    // A visitor scoped to property A cannot book property B's site type.
    const r: any = await createBookingCheckout.execute({
      siteTypeId: b.pullThruId,
      checkIn: plusDays(20), checkOut: plusDays(23),
      guestName: 'Dana Guest', guestEmail: 'dana@example.com',
    }, actorFor(a.propertyId))
    expect(r.ok).toBe(false)
  })
})
