/**
 * W-20 (S531): schedule self-compression — the nightly packer.
 * Verifies: packing toward low-numbered sites, requirement compatibility
 * (amp service), pinning (revealed / checked-in / lease-drafted / same-day
 * bookings never move), and lease obstacles.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { compressPropertySchedule, rankUnitsBestFit, slackScore, relocateBlockingBookings } from './scheduleCompression'

beforeEach(async () => { await cleanupAllSchema() })

function plusDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

async function seedPark() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // Sites 01–04: 01/02 are 30A back-in, 03/04 are 50A pull-through.
    const mkSite = async (num: string, amp: string, layout: string) => {
      const id = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
      // seedUnit generates a random unit_number — pin it: the packer's
      // ordering (and these assertions) depend on unit_number order.
      await client.query(
        `UPDATE units SET unit_number=$4, is_bookable=TRUE,
                lease_types_allowed=ARRAY['nightly','weekly'],
                nightly_rate=50, rv_amp_service=$2, rv_site_layout=$3 WHERE id=$1`,
        [id, amp, layout, num])
      return id
    }
    const s1 = await mkSite('RV 01', '30', 'back_in')
    const s2 = await mkSite('RV 02', '30', 'back_in')
    const s3 = await mkSite('RV 03', '50', 'pull_through')
    const s4 = await mkSite('RV 04', '50', 'pull_through')
    await client.query('COMMIT')
    return { landlordId, propertyId, s1, s2, s3, s4 }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function booking(unitId: string, landlordId: string, checkIn: string, checkOut: string, extra: Record<string, any> = {}) {
  const cols: Record<string, any> = {
    unit_id: unitId, landlord_id: landlordId, lease_type: 'nightly',
    check_in: checkIn, check_out: checkOut, status: 'confirmed',
    guest_name: 'G', guest_email: 'g@example.com',
    required_site_layout: 'none', required_amp_service: 'none',
    ...extra,
  }
  const keys = Object.keys(cols)
  const r = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(cols))
  return r.rows[0].id
}

async function unitOf(bookingId: string): Promise<string> {
  const r = await db.query<{ unit_id: string }>(
    `SELECT unit_id FROM unit_bookings WHERE id=$1`, [bookingId])
  return r.rows[0].unit_id
}

describe('compressPropertySchedule', () => {
  it('packs future bookings toward low-numbered compatible sites', async () => {
    const p = await seedPark()
    // Two no-requirement bookings scattered on high sites; RV 01/02 empty.
    const b1 = await booking(p.s4, p.landlordId, plusDays(5), plusDays(8))
    const b2 = await booking(p.s3, p.landlordId, plusDays(6), plusDays(9))
    const moves = await compressPropertySchedule(p.propertyId)
    expect(moves).toHaveLength(2)
    expect(await unitOf(b1)).toBe(p.s1)   // earliest check-in → first site
    expect(await unitOf(b2)).toBe(p.s2)   // overlaps b1 → next site
  })

  it('honors amp requirements — a 50A booking never lands on a 30A site', async () => {
    const p = await seedPark()
    const b = await booking(p.s4, p.landlordId, plusDays(5), plusDays(8),
      { required_amp_service: '50', required_site_layout: 'pull_through' })
    const moves = await compressPropertySchedule(p.propertyId)
    // RV 01/02 are 30A back-in — incompatible. Packs to RV 03 (first 50A).
    expect(moves).toHaveLength(1)
    expect(await unitOf(b)).toBe(p.s3)
  })

  it('never moves pinned bookings — the reveal stamp is THE fence (revealed / checked-in stay; same-day UNREVEALED may move)', async () => {
    const p = await seedPark()
    const revealed = await booking(p.s4, p.landlordId, plusDays(5), plusDays(8),
      { site_reveal_sent_at: new Date() })
    const checkedIn = await booking(p.s3, p.landlordId, plusDays(-1), plusDays(2),
      { status: 'checked_in' })
    const moves = await compressPropertySchedule(p.propertyId)
    expect(moves).toHaveLength(0)
    expect(await unitOf(revealed)).toBe(p.s4)
    expect(await unitOf(checkedIn)).toBe(p.s3)
  })

  it('treats leases as fixed obstacles and packs around them', async () => {
    const p = await seedPark()
    // Open-ended active lease occupies RV 01 forever.
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, status, start_date, rent_amount, lease_type, rent_due_day)
       VALUES ($1, $2, 'active', $3, 900, 'month_to_month', 1)`,
      [p.s1, p.landlordId, plusDays(-30)])
    const b = await booking(p.s4, p.landlordId, plusDays(5), plusDays(8))
    const moves = await compressPropertySchedule(p.propertyId)
    expect(moves).toHaveLength(1)
    expect(await unitOf(b)).toBe(p.s2)   // RV 01 blocked by the lease
  })

  it("GAP-FILLING (Nic's objective): a week-long stay slots into a snug gap between two pinned bookings instead of a wide-open site", async () => {
    const p = await seedPark()
    // RV 01 has two REVEALED (pinned) bookings leaving an 8-day gap
    // (days +10 → +18). RV 02 is wide open.
    await booking(p.s1, p.landlordId, plusDays(2), plusDays(10), { site_reveal_sent_at: new Date() })
    await booking(p.s1, p.landlordId, plusDays(18), plusDays(25), { site_reveal_sent_at: new Date() })
    // A movable 7-night booking currently sits on wide-open RV 02.
    const b = await booking(p.s2, p.landlordId, plusDays(10), plusDays(17))
    const moves = await compressPropertySchedule(p.propertyId)
    // Best-fit pulls it INTO RV 01's gap (slack 0+1) — RV 02 stays wide
    // open for longer stays.
    expect(moves).toHaveLength(1)
    expect(await unitOf(b)).toBe(p.s1)
  })

  it('booking-time assignment ranks the snug gap first (rankUnitsBestFit)', async () => {
    const p = await seedPark()
    await booking(p.s2, p.landlordId, plusDays(2), plusDays(10), { site_reveal_sent_at: new Date() })
    await booking(p.s2, p.landlordId, plusDays(17), plusDays(25), { site_reveal_sent_at: new Date() })
    // New 7-night stay fits RV 02's gap exactly; RV 01 is wide open.
    const ranked = await rankUnitsBestFit([p.s1, p.s2], { checkIn: plusDays(10), checkOut: plusDays(17) })
    expect(ranked[0]).toBe(p.s2)
    // A conflicting window excludes the occupied site entirely.
    const ranked2 = await rankUnitsBestFit([p.s1, p.s2], { checkIn: plusDays(3), checkOut: plusDays(6) })
    expect(ranked2).toEqual([p.s1])
  })

  it('slackScore prefers snug over open (pure)', () => {
    const win = { checkIn: '2026-08-10', checkOut: '2026-08-17' }
    const snug = [
      { checkIn: '2026-08-01', checkOut: '2026-08-10' },
      { checkIn: '2026-08-18', checkOut: '2026-08-25' },
    ]
    expect(slackScore(snug, win)).toBe(1)          // 0 before + 1 after
    expect(slackScore([], win)).toBe(20_000)       // both sides open
    expect(slackScore([snug[0]], win)).toBe(10_000) // one side open
  })

  it("EXTENSION PROTECTION (Nic): extending a stay boots the following unrevealed reservation to an open compatible site", async () => {
    const p = await seedPark()
    // Sitting guest on RV 03 through day +5; incoming guest arrives +5 on
    // the same site (back-to-back). Sitting guest wants to extend to +8.
    const sitting = await booking(p.s3, p.landlordId, plusDays(-2), plusDays(5), { status: 'checked_in' })
    const incoming = await booking(p.s3, p.landlordId, plusDays(5), plusDays(9),
      { required_amp_service: '50', required_site_layout: 'pull_through' })
    const r = await relocateBlockingBookings(p.s3, { checkIn: plusDays(-2), checkOut: plusDays(8) }, sitting)
    expect(r.ok).toBe(true)
    expect(r.moves).toHaveLength(1)
    // Incoming needs 50A pull-through → RV 04 (RV 01/02 are 30A back-in).
    expect(await unitOf(incoming)).toBe(p.s4)
  })

  it('extension is refused when the incoming guest was already told their site', async () => {
    const p = await seedPark()
    const sitting = await booking(p.s3, p.landlordId, plusDays(-2), plusDays(5), { status: 'checked_in' })
    await booking(p.s3, p.landlordId, plusDays(5), plusDays(9),
      { site_reveal_sent_at: new Date() })
    const r = await relocateBlockingBookings(p.s3, { checkIn: plusDays(-2), checkOut: plusDays(8) }, sitting)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/already told their site/i)
  })

  it('extension is refused when no compatible site is open for the incoming guest', async () => {
    const p = await seedPark()
    const sitting = await booking(p.s3, p.landlordId, plusDays(-2), plusDays(5), { status: 'checked_in' })
    await booking(p.s3, p.landlordId, plusDays(5), plusDays(9),
      { required_amp_service: '50', required_site_layout: 'pull_through' })
    // The only other 50A pull-through (RV 04) is occupied for the window.
    await booking(p.s4, p.landlordId, plusDays(4), plusDays(10), { site_reveal_sent_at: new Date() })
    const r = await relocateBlockingBookings(p.s3, { checkIn: plusDays(-2), checkOut: plusDays(8) }, sitting)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no compatible open site/i)
  })

  it('is idempotent — a packed schedule produces zero moves', async () => {
    const p = await seedPark()
    const b1 = await booking(p.s4, p.landlordId, plusDays(5), plusDays(8))
    await compressPropertySchedule(p.propertyId)
    const second = await compressPropertySchedule(p.propertyId)
    expect(second).toHaveLength(0)
    expect(await unitOf(b1)).toBe(p.s1)
  })
})
