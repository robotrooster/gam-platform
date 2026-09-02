// ONE availability rule for every "is this unit free?" surface (S529,
// W-19 edit-reservation dropdown + W-48 applicant reach-out — and the
// create/move 409 guards in routes/units.ts, refactored onto the same
// predicate so the UIs can never drift from what the server enforces).
//
// A unit is free for a stay window when NO non-cancelled booking and NO
// active lease overlaps it. check_out / lease end_date use the exclusive
// departure-day convention (same-day turnover allowed); NULL lease end_date
// = open-ended, blocks indefinitely. A NULL window checkOut means "free from
// checkIn onward, forever" (the reach-out / lease-offer case).
//
// `excludeBookingId` lets an edit/move ignore the booking being edited AND
// any lease drafted from it (leases.source_booking_id) — after a landlord
// activates a booking-draft lease, editing the source booking must not 409
// against its own lease.
import { query, queryOne } from '../db'

export interface StayWindow {
  checkIn: string            // YYYY-MM-DD
  checkOut?: string | null   // YYYY-MM-DD; null/undefined = open-ended
  excludeBookingId?: string | null
}

export type StayConflict = 'booking' | 'lease' | 'pending_tenant' | null

export async function findStayConflict(unitId: string, w: StayWindow): Promise<StayConflict> {
  const booking = await queryOne<any>(`
    SELECT id FROM unit_bookings
    WHERE unit_id = $1 AND status NOT IN ('cancelled')
      AND ($2::uuid IS NULL OR id != $2)
      AND ($3::date IS NULL OR check_in < $3)
      AND check_out > $4`,
    [unitId, w.excludeBookingId ?? null, w.checkOut ?? null, w.checkIn])
  if (booking) return 'booking'
  const lease = await queryOne<any>(`
    SELECT id FROM leases
    WHERE unit_id = $1 AND status = 'active'
      AND ($2::uuid IS NULL OR source_booking_id IS NULL OR source_booking_id != $2)
      AND ($3::date IS NULL OR start_date < $3)
      AND (end_date IS NULL OR end_date > $4)`,
    [unitId, w.excludeBookingId ?? null, w.checkOut ?? null, w.checkIn])
  if (lease) return 'lease'
  // W-27 (S531): a unit bound to an OPEN pending-tenant intent is occupied
  // by a tenant completing onboarding (portfolio migration) — not bookable
  // regardless of window. Lifts when the intent resolves or is removed.
  const pending = await queryOne<any>(`
    SELECT id FROM pending_tenant_intents
    WHERE unit_id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL`, [unitId])
  return pending ? 'pending_tenant' : null
}

export const STAY_CONFLICT_MESSAGE: Record<Exclude<StayConflict, null>, string> = {
  booking: 'Unit is already booked for those dates',
  lease:   'Unit has an active lease covering those dates',
  pending_tenant: 'Unit is held for a tenant completing onboarding',
}

// Every unit of the landlord that is free for the window. RV compatibility
// (site layout / amp service) is filtered by the CALLER using the shared
// isSiteLayoutMismatch / isAmpServiceMismatch helpers — one semantic source
// in packages/shared, no SQL re-implementation. Subtype pricing is joined so
// consumers (reach-out rent prefill) read the unit's preset rent without a
// second query: unit override first, subtype fallback.
// S633: every company the ACCOUNT owns. A landlord checking what is free is
// asking about their whole portfolio; scoped to one entity the availability
// picker silently omitted the other park's spaces.
export async function findAvailableUnits(opts: {
  landlordIds: string[]
  window: StayWindow
  propertyId?: string | null
  scopedPropertyIds?: string[] | null   // staff allow-list; null = unrestricted
}): Promise<any[]> {
  const w = opts.window
  const params: any[] = [opts.landlordIds, w.excludeBookingId ?? null, w.checkOut ?? null, w.checkIn]
  let filter = ''
  if (opts.propertyId) filter += ` AND u.property_id = $${params.push(opts.propertyId)}`
  if (opts.scopedPropertyIds) filter += ` AND u.property_id = ANY($${params.push(opts.scopedPropertyIds)})`
  return query<any>(`
    SELECT u.id, u.unit_number, u.unit_type, u.status, u.property_id,
           u.is_bookable, u.rv_site_layout, u.rv_amp_service, u.lease_types_allowed,
           u.rent_amount, u.nightly_rate, u.weekly_rate, u.monthly_rate,
           s.name AS subtype_name,
           s.rent_amount AS subtype_rent_amount,
           s.monthly_rate AS subtype_monthly_rate,
           p.name AS property_name
    FROM units u
    JOIN properties p ON p.id = u.property_id
    LEFT JOIN property_unit_subtypes s ON s.id = u.subtype_id
    WHERE u.landlord_id = ANY($1::uuid[]) ${filter}
      -- S605: a retired unit keeps its history but is never offered again. The
      -- DB triggers already refuse a new lease/booking on one; this keeps it out
      -- of the picker so nobody is shown a choice that would then be rejected.
      AND u.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM unit_bookings b
        WHERE b.unit_id = u.id AND b.status NOT IN ('cancelled')
          AND ($2::uuid IS NULL OR b.id != $2)
          AND ($3::date IS NULL OR b.check_in < $3)
          AND b.check_out > $4)
      AND NOT EXISTS (
        SELECT 1 FROM leases l
        WHERE l.unit_id = u.id AND l.status = 'active'
          AND ($2::uuid IS NULL OR l.source_booking_id IS NULL OR l.source_booking_id != $2)
          AND ($3::date IS NULL OR l.start_date < $3)
          AND (l.end_date IS NULL OR l.end_date > $4))
      AND NOT EXISTS (
        SELECT 1 FROM pending_tenant_intents pti
        WHERE pti.unit_id = u.id AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL)
    ORDER BY p.name, u.unit_number`, params)
}
