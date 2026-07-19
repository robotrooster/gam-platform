// W-20 (S531, Nic): FULLY AUTOMATIC schedule self-compression.
//
// The Master Schedule packs itself: future reservations are re-sited to
// minimize scattered gaps, honoring each booking's requirements
// (required_site_layout / required_amp_service vs the unit's
// rv_site_layout / rv_amp_service — the same shared compatibility helpers
// the booking guards use). This works because guests are never told their
// site number at booking time — the morning-of-check-in reveal message
// (jobs side) delivers it, and site_reveal_sent_at PINS the booking from
// that moment on.
//
// A booking is MOVABLE only when every one of these holds:
//   • status is 'confirmed', or 'tentative' with an unexpired payment hold
//   • site_reveal_sent_at IS NULL — THE movement fence. Reveals go out an
//     hour before the site's check-in time (Nic), so even a same-day
//     arrival can be re-sited with zero guest-visible movement until then.
//   • not checked in
//   • no lease was drafted from it (leases.source_booking_id — moving it
//     would detach the lease from the unit the lease names)
// Everything else on the timeline — leases (fixed, per Nic), checked-in
// stays, revealed bookings — is a fixed obstacle.
//
// Packing: BEST-FIT greedy (Nic's objective: CONSOLIDATE). A booking
// prefers the site where it fits most SNUGLY between existing
// reservations — a 1-week stay slots into a 2-week gap between two
// bookings instead of landing on a wide-open site, so long contiguous
// runs stay available for long stays. Scoring: slack = days of leftover
// gap on each side of the window (an open side costs OPEN_SIDE, so a
// snug gap always beats a wide-open site); lower is better, ties break
// to the lower unit number. Deterministic and convergent — a booking
// already in its best slot stays put; one that fits nowhere keeps its
// current site.
import { query } from '../db'
import { logger } from '../lib/logger'
import { isSiteLayoutMismatch, isAmpServiceMismatch } from '@gam/shared'

interface Interval { checkIn: string; checkOut: string }
interface Site {
  id: string
  unit_number: string
  rv_site_layout: string | null
  rv_amp_service: string | null
  timeline: Interval[]
}

const overlaps = (a: Interval, b: Interval) =>
  a.checkIn < b.checkOut && a.checkOut > b.checkIn

// A side with no neighboring reservation "costs" this many days of slack —
// large enough that any real gap (snug fit) always wins over open space,
// while two-open-sides still ranks below one-open-side.
const OPEN_SIDE = 10_000

const dayDiff = (a: string, b: string) =>
  Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000)

// Callers hand us dates from mixed sources — request-body strings OR pg
// Date objects off a row. A Date compared against a 'YYYY-MM-DD' string
// coerces to NaN and silently defeats every overlap check (caught by the
// W-20 extension tests as a double-booking), so EVERY window entering this
// module is normalized to a day-string first.
export const dayStr = (v: string | Date): string =>
  typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)

/** Leftover-gap score for placing `win` on a timeline (assumed conflict-free). */
export function slackScore(timeline: Interval[], win: Interval): number {
  let prevEnd: string | null = null
  let nextStart: string | null = null
  for (const t of timeline) {
    if (t.checkOut <= win.checkIn && (!prevEnd || t.checkOut > prevEnd)) prevEnd = t.checkOut
    if (t.checkIn >= win.checkOut && (!nextStart || t.checkIn < nextStart)) nextStart = t.checkIn
  }
  const before = prevEnd ? dayDiff(prevEnd, win.checkIn) : OPEN_SIDE
  const after  = nextStart ? dayDiff(win.checkOut, nextStart) : OPEN_SIDE
  return before + after
}

export interface CompressionMove {
  bookingId: string
  guestName: string | null
  fromUnit: string
  toUnit: string
  checkIn: string
}

export async function compressPropertySchedule(propertyId: string): Promise<CompressionMove[]> {
  // Sites that can host a stay — same predicate as the public booking site.
  const siteRows = await query<any>(`
    SELECT id, unit_number, rv_site_layout, rv_amp_service
      FROM units
     WHERE property_id = $1
       AND is_bookable = TRUE
       AND (lease_types_allowed && ARRAY['nightly','weekly']::text[])
     ORDER BY unit_number`, [propertyId])
  if (siteRows.length < 2) return []
  const sites: Site[] = siteRows.map((s: any) => ({ ...s, timeline: [] }))
  const siteById = new Map(sites.map(s => [s.id, s]))

  // Fixed obstacles on those sites: leases (active/pending, any window that
  // still matters) + pinned bookings.
  const leaseRows = await query<any>(`
    SELECT unit_id, start_date::text AS check_in,
           COALESCE(end_date::text, '9999-12-31') AS check_out
      FROM leases
     WHERE unit_id = ANY($1::uuid[]) AND status IN ('active','pending')`,
    [sites.map(s => s.id)])
  for (const l of leaseRows) {
    siteById.get(l.unit_id)?.timeline.push({ checkIn: l.check_in, checkOut: l.check_out })
  }

  const bookingRows = await query<any>(`
    SELECT b.id, b.unit_id, b.guest_name, b.status, b.hold_expires_at,
           b.site_reveal_sent_at, b.required_site_layout, b.required_amp_service,
           b.locked_to_unit,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id) AS has_lease
      FROM unit_bookings b
     WHERE b.unit_id = ANY($1::uuid[])
       AND b.status NOT IN ('cancelled','no_show','checked_out')
       AND b.check_out > CURRENT_DATE
     ORDER BY b.check_in, (b.check_out::date - b.check_in::date) DESC`,
    [sites.map(s => s.id)])

  const movable: any[] = []
  for (const b of bookingRows) {
    const expiredHold = b.status === 'tentative' && b.hold_expires_at && new Date(b.hold_expires_at) < new Date()
    if (expiredHold) continue  // abandoned unpaid hold — not an obstacle, not movable
    const pinned =
      b.status === 'checked_in' ||
      b.site_reveal_sent_at != null ||
      b.has_lease ||
      b.locked_to_unit   // S547: snowbird lock — landlord pinned this stay to its site
    if (pinned || !['tentative', 'confirmed'].includes(b.status)) {
      siteById.get(b.unit_id)?.timeline.push({ checkIn: b.check_in, checkOut: b.check_out })
    } else {
      movable.push(b)
    }
  }
  if (movable.length === 0) return []

  // Best-fit pack. A booking that fits nowhere keeps its current site
  // (registered as an obstacle there so later placements respect it).
  const moves: CompressionMove[] = []
  for (const b of movable) {
    const win: Interval = { checkIn: b.check_in, checkOut: b.check_out }
    let placed: Site | null = null
    let bestScore = Infinity
    for (const s of sites) {
      if (isSiteLayoutMismatch(b.required_site_layout, s.rv_site_layout)) continue
      if (isAmpServiceMismatch(b.required_amp_service, s.rv_amp_service)) continue
      if (s.timeline.some(t => overlaps(t, win))) continue
      const score = slackScore(s.timeline, win)
      if (score < bestScore) { bestScore = score; placed = s }
    }
    const target = placed ?? siteById.get(b.unit_id) ?? null
    if (!target) continue
    target.timeline.push(win)
    if (placed && placed.id !== b.unit_id) {
      moves.push({
        bookingId: b.id,
        guestName: b.guest_name,
        fromUnit: siteById.get(b.unit_id)?.unit_number ?? b.unit_id,
        toUnit: placed.unit_number,
        checkIn: b.check_in,
      })
      await query(
        `UPDATE unit_bookings SET unit_id = $1, updated_at = NOW() WHERE id = $2`,
        [placed.id, b.id])
    }
  }
  if (moves.length) {
    logger.info(`[compress] property=${propertyId} moved ${moves.length} booking(s): ` +
      moves.map(m => `${m.fromUnit}→${m.toUnit} (${m.checkIn})`).join(', '))
  }
  return moves
}

/** Nightly sweep: every property that has movable future bookings. */
export async function compressAllSchedules(): Promise<number> {
  const props = await query<{ property_id: string }>(`
    SELECT DISTINCT u.property_id
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
     WHERE b.status IN ('tentative','confirmed')
       AND b.site_reveal_sent_at IS NULL
       AND b.check_in > CURRENT_DATE`)
  let total = 0
  for (const p of props) {
    try {
      total += (await compressPropertySchedule(p.property_id)).length
    } catch (e) {
      logger.error({ err: e }, `[compress] property=${p.property_id}`)
    }
  }
  return total
}

/**
 * W-20 refinement (Nic): booking-time assignment uses the SAME best-fit
 * objective as the packer — a new stay slots into the snuggest compatible
 * gap so wide-open sites stay free for longer stays. Returns the given
 * units ordered best-fit-first, conflicting units excluded. The caller
 * loops the order (advisory-lock race → next candidate).
 */
export async function rankUnitsBestFit(
  unitIds: string[],
  win: { checkIn: string | Date; checkOut: string | Date },
): Promise<string[]> {
  // No single-candidate shortcut: the conflict check below is part of the
  // contract (a caught test proved skipping it can double-book a site).
  if (unitIds.length === 0) return []
  const winN = { checkIn: dayStr(win.checkIn), checkOut: dayStr(win.checkOut) }
  const bookingRows = await query<any>(`
    SELECT unit_id, check_in::text AS check_in, check_out::text AS check_out
      FROM unit_bookings
     WHERE unit_id = ANY($1::uuid[])
       AND status NOT IN ('cancelled','no_show','checked_out')
       AND NOT (status = 'tentative' AND hold_expires_at IS NOT NULL AND hold_expires_at < now())`,
    [unitIds])
  const leaseRows = await query<any>(`
    SELECT unit_id, start_date::text AS check_in,
           COALESCE(end_date::text, '9999-12-31') AS check_out
      FROM leases
     WHERE unit_id = ANY($1::uuid[]) AND status IN ('active','pending')`,
    [unitIds])
  const timelines = new Map<string, Interval[]>(unitIds.map(id => [id, []]))
  for (const r of [...bookingRows, ...leaseRows]) {
    timelines.get(r.unit_id)?.push({ checkIn: r.check_in, checkOut: r.check_out })
  }
  const w: Interval = { checkIn: winN.checkIn, checkOut: winN.checkOut }
  return unitIds
    .map((id, idx) => {
      const tl = timelines.get(id) ?? []
      const conflict = tl.some(t => overlaps(t, w))
      return { id, idx, conflict, score: conflict ? Infinity : slackScore(tl, w) }
    })
    .filter(x => !x.conflict)
    .sort((a, b) => a.score - b.score || a.idx - b.idx)
    .map(x => x.id)
}

export interface RelocationResult {
  ok: boolean
  reason?: string
  moves: CompressionMove[]
}

/**
 * W-20 extension protection (Nic): a guest extending their stay takes
 * priority on their CURRENT site — the following (incoming) reservation is
 * relocated to another compatible open site instead of blocking the
 * extension. Safe because incoming guests don't learn their site until an
 * hour before check-in: an unrevealed booking can move with zero
 * guest-visible impact. Refuses (ok:false) when a blocker is already
 * revealed / checked in / lease-bound, or no compatible site is free.
 * Caller re-runs its conflict check after a successful relocation.
 */
export async function relocateBlockingBookings(
  unitId: string,
  win: { checkIn: string | Date; checkOut: string | Date },
  excludeBookingId: string,
): Promise<RelocationResult> {
  const winN = { checkIn: dayStr(win.checkIn), checkOut: dayStr(win.checkOut) }
  const blockers = await query<any>(`
    SELECT b.id, b.guest_name, b.status, b.hold_expires_at, b.site_reveal_sent_at,
           b.required_site_layout, b.required_amp_service, b.locked_to_unit,
           b.check_in::text AS check_in, b.check_out::text AS check_out,
           u.property_id, u.unit_number,
           EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id) AS has_lease
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
     WHERE b.unit_id = $1 AND b.id != $2
       AND b.status NOT IN ('cancelled','no_show','checked_out')
       AND NOT (b.status = 'tentative' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at < now())
       AND b.check_in < $3::date AND b.check_out > $4::date`,
    [unitId, excludeBookingId, winN.checkOut, winN.checkIn])

  const moves: CompressionMove[] = []
  for (const blk of blockers) {
    if (blk.status === 'checked_in') {
      return { ok: false, moves, reason: `The next reservation (${blk.guest_name ?? 'guest'}) is already checked in` }
    }
    if (blk.site_reveal_sent_at != null) {
      return { ok: false, moves, reason: `The next guest (${blk.guest_name ?? 'guest'}) was already told their site — it can't be moved` }
    }
    if (blk.has_lease) {
      return { ok: false, moves, reason: 'The next reservation has a drafted lease bound to this site' }
    }
    if (blk.locked_to_unit) {
      // S547: snowbird lock — the landlord pinned this stay to this exact site.
      return { ok: false, moves, reason: `The next reservation (${blk.guest_name ?? 'guest'}) is locked to this site by the landlord` }
    }
    // Candidate sites: same property, bookable, compatible with the
    // blocker's requirements, not this unit. Best-fit keeps the schedule
    // consolidated even mid-relocation.
    const candidates = await query<any>(`
      SELECT id, unit_number, rv_site_layout, rv_amp_service
        FROM units
       WHERE property_id = $1 AND id != $2
         AND is_bookable = TRUE
         AND (lease_types_allowed && ARRAY['nightly','weekly']::text[])
       ORDER BY unit_number`, [blk.property_id, unitId])
    const compatible = candidates.filter((c: any) =>
      !isSiteLayoutMismatch(blk.required_site_layout, c.rv_site_layout) &&
      !isAmpServiceMismatch(blk.required_amp_service, c.rv_amp_service))
    const ranked = await rankUnitsBestFit(
      compatible.map((c: any) => c.id),
      { checkIn: blk.check_in, checkOut: blk.check_out })
    if (!ranked.length) {
      return { ok: false, moves, reason: `No compatible open site for the next reservation (${blk.guest_name ?? 'guest'})` }
    }
    const target = candidates.find((c: any) => c.id === ranked[0])
    await query(`UPDATE unit_bookings SET unit_id = $1, updated_at = NOW() WHERE id = $2`, [ranked[0], blk.id])
    moves.push({
      bookingId: blk.id, guestName: blk.guest_name,
      fromUnit: blk.unit_number, toUnit: target?.unit_number ?? ranked[0],
      checkIn: blk.check_in,
    })
    logger.info(`[extend] relocated incoming booking ${blk.id}: ${blk.unit_number} → ${target?.unit_number} (extension priority)`)
  }
  return { ok: true, moves }
}
