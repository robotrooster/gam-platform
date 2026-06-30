import type { PoolClient } from 'pg'
import { query } from '../db'
import type { UnitBookingEventType } from '@gam/shared'

// ============================================================
// S517 / Walkthrough #10 — Master Schedule booking change-history.
//
// recordBookingEvent appends one audit row per change. diffBookingChange
// turns an old→new unit_bookings pair into the right event(s) so the route
// just calls it after an update.
// ============================================================

export interface RecordEventOpts {
  bookingId: string | null
  unitId: string
  landlordId: string
  eventType: UnitBookingEventType
  summary: string
  detail?: Record<string, unknown>
  actorUserId?: string | null
  client?: PoolClient
}

export async function recordBookingEvent(o: RecordEventOpts): Promise<void> {
  const sql = `INSERT INTO unit_booking_events
     (booking_id, unit_id, landlord_id, event_type, summary, detail, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`
  const params = [o.bookingId, o.unitId, o.landlordId, o.eventType, o.summary,
    JSON.stringify(o.detail ?? {}), o.actorUserId ?? null]
  if (o.client) { await o.client.query(sql, params); return }
  await query(sql, params)
}

const guestLabel = (b: any) => b.guest_name || b.guestName || 'Guest'

function dayDelta(oldOut: string, newOut: string): string {
  const d = Math.round((new Date(newOut).getTime() - new Date(oldOut).getTime()) / 86400000)
  if (d === 0) return ''
  return d > 0 ? `${d} day${d === 1 ? '' : 's'} added` : `${-d} day${d === -1 ? '' : 's'} removed`
}

const dstr = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10))

/**
 * Emit the change-history events for a booking update by diffing old → new.
 * Records a 'cancelled' event when status flips to cancelled; 'moved' when the
 * unit changes; 'dates_changed' (with a "N days added/removed" note) when the
 * stay window changes; 'status_changed' for other status transitions.
 */
export async function recordBookingChange(old: any, next: any, actorUserId: string | null): Promise<void> {
  const landlordId = old.landlord_id
  const base = { bookingId: old.id, landlordId, actorUserId }

  if (next.status === 'cancelled' && old.status !== 'cancelled') {
    await recordBookingEvent({ ...base, unitId: old.unit_id, eventType: 'cancelled',
      summary: `Reservation for ${guestLabel(old)} cancelled`,
      detail: { from_status: old.status } })
    return
  }

  if (String(next.unit_id) !== String(old.unit_id)) {
    await recordBookingEvent({ ...base, unitId: next.unit_id, eventType: 'moved',
      summary: `${guestLabel(old)} moved to another unit`,
      detail: { from_unit_id: old.unit_id, to_unit_id: next.unit_id } })
  }

  const oldIn = dstr(old.check_in), oldOut = dstr(old.check_out)
  const newIn = dstr(next.check_in), newOut = dstr(next.check_out)
  if (oldIn !== newIn || oldOut !== newOut) {
    const delta = dayDelta(oldOut, newOut)
    await recordBookingEvent({ ...base, unitId: next.unit_id, eventType: 'dates_changed',
      summary: `${guestLabel(old)} dates: ${oldIn}→${oldOut} ⇒ ${newIn}→${newOut}${delta ? ` (${delta})` : ''}`,
      detail: { from: { check_in: oldIn, check_out: oldOut }, to: { check_in: newIn, check_out: newOut }, delta } })
  }

  if (next.status !== old.status && next.status !== 'cancelled') {
    await recordBookingEvent({ ...base, unitId: next.unit_id, eventType: 'status_changed',
      summary: `${guestLabel(old)} status: ${old.status} → ${next.status}`,
      detail: { from_status: old.status, to_status: next.status } })
  }
}
