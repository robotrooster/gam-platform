/**
 * Amenity tools (S552).
 *
 * get_my_amenities (tenant READ) — the reservable amenities at the tenant's
 * property with rules/fees + the tenant's own reservations. Mirrors
 * GET /common-areas/mine and /my-reservations.
 *
 * request_amenity_reservation (tenant ACTION, confirm-first) — books an
 * amenity window for the tenant, using the SAME helpers the portal route
 * uses (loadArea/validateWindow from routes/commonAreas — safe import, the
 * route never imports agent code — plus services/commonAreas for locking,
 * conflict checks, fee math, caps, and billing). Auto-approves and BILLS
 * exactly like the portal when the area doesn't require approval; otherwise
 * lands as a pending request for the landlord. The agent must state the fee
 * and get an explicit yes BEFORE calling — reservation fees are real
 * charges. Cancellation stays in the portal (its refund rules are shown
 * there); the agent explains the ≥48-hours-ahead refund policy instead.
 */

import { query, queryOne, getClient } from '../../../db'
import {
  lockArea, findApprovedConflict, computeReservationFee,
  billReservationFee, assertMonthlyReservationLimit,
} from '../../commonAreas'
import { loadArea, validateWindow, fireAmenityAlert } from '../../../routes/commonAreas'
import { notifyReservationRequested } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

async function tenantPropertyIds(tenantId: string): Promise<string[]> {
  const rows = await query<{ property_id: string }>(
    `SELECT DISTINCT u.property_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
       JOIN units u ON u.id = l.unit_id
      WHERE vlat.tenant_id = $1`,
    [tenantId]
  )
  return rows.map((r) => r.property_id)
}

export const getMyAmenities: AgentTool = {
  name: 'get_my_amenities',
  description:
    'The reservable amenities at the tenant’s property — name, capacity, reservation fee, hours, booking rules ' +
    '(approval needed or instant), upcoming reserved windows — plus the tenant’s own reservations and their ' +
    'status. Use before requesting a reservation, and to answer “what can I book / when is the clubhouse free / ' +
    'what are my reservations?”. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const propIds = await tenantPropertyIds(actor.profileId)
    if (propIds.length === 0) return { ok: true, amenities: [], reservations: [], note: 'No active lease — no amenities to show.' }
    const areas = await query<any>(
      `SELECT id, name, description, requires_approval, capacity,
              reservation_fee::float AS reservation_fee, open_time, close_time,
              max_reservation_hours, advance_booking_days, events_enabled,
              event_deposit_amount::float AS event_deposit_amount
         FROM common_areas
        WHERE property_id = ANY($1) AND active AND reservable
        ORDER BY name`, [propIds])
    const mine = await query<any>(
      `SELECT car.id, ca.name AS area_name, car.kind, car.starts_at, car.ends_at,
              car.status, car.fee_amount::float AS fee_amount
         FROM common_area_reservations car
         JOIN common_areas ca ON ca.id = car.common_area_id
        WHERE car.reserved_by_tenant_id = $1
        ORDER BY car.starts_at DESC
        LIMIT 20`, [actor.profileId])
    return {
      ok: true,
      amenities: areas,
      reservations: mine,
      note: 'Weekend dates can carry a different fee — the exact fee is computed when a request is made. ' +
        'Areas with requires_approval=false confirm (and bill) instantly; others go to the property for approval.',
    }
  },
}

export const requestAmenityReservation: AgentTool = {
  name: 'request_amenity_reservation',
  description:
    'Reserve an amenity for the tenant. CONFIRM FIRST: state the area, the exact start/end time, and the fee ' +
    '(from get_my_amenities; weekend rates may differ — the result reports the final fee) and get an explicit ' +
    'yes before calling, because instant-book areas are billed immediately. areaId comes from get_my_amenities. ' +
    'Times are ISO datetimes. Use kind "event" only for private events at areas that host them (non-refundable ' +
    'deposit applies).',
  parameters: {
    type: 'object',
    properties: {
      areaId: { type: 'string', description: 'The amenity id (from get_my_amenities).' },
      startsAt: { type: 'string', description: 'Start, ISO datetime (e.g. 2026-08-02T14:00:00).' },
      endsAt: { type: 'string', description: 'End, ISO datetime.' },
      kind: { type: 'string', description: '"standard" (default) or "event" for a private event.' },
      title: { type: 'string', description: 'Optional short label (e.g. "Birthday party").' },
      guestCount: { type: 'number', description: 'Optional expected guest count.' },
    },
    required: ['areaId', 'startsAt', 'endsAt'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const areaId = String(args.areaId ?? '').trim()
    const startsAt = String(args.startsAt ?? '').trim()
    const endsAt = String(args.endsAt ?? '').trim()
    const kind = String(args.kind ?? 'standard').trim().toLowerCase() === 'event' ? 'event' : 'standard'
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null
    const guestCount = typeof args.guestCount === 'number' && args.guestCount > 0 ? Math.floor(args.guestCount) : null
    if (!areaId || !startsAt || !endsAt) return { ok: false, error: 'areaId, startsAt, and endsAt are all required.' }

    const area = await loadArea(areaId)
    if (!area) return { ok: false, error: 'No such amenity.' }
    if (!area.active || !area.reservable) return { ok: false, error: 'That area is not reservable.' }
    if (kind === 'event' && !area.events_enabled) return { ok: false, error: `${area.name} does not host private events.` }
    const propIds = await tenantPropertyIds(actor.profileId)
    if (!propIds.includes(area.property_id)) return { ok: false, error: 'That amenity is not at this tenant’s property.' }
    try {
      validateWindow(area, startsAt, endsAt)
      await assertMonthlyReservationLimit(area, { tenantId: actor.profileId }, startsAt)
    } catch (e: any) {
      return { ok: false, error: e?.message || 'That window is not bookable.' }
    }
    const fee = kind === 'event' ? Number(area.event_deposit_amount || 0) : computeReservationFee(area, startsAt)
    const notifyFlag = kind === 'event' ? area.event_announce !== false : true

    if (!area.requires_approval) {
      const client = await getClient()
      let id: string
      try {
        await client.query('BEGIN')
        await lockArea(client, area.id)
        const conflict = await findApprovedConflict(client, area.id, startsAt, endsAt)
        if (conflict) { await client.query('ROLLBACK'); return { ok: false, error: 'That window is already reserved — pick another time.' } }
        const ins = await client.query<{ id: string }>(
          `INSERT INTO common_area_reservations
             (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id,
              title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount,
              notify_residents, decided_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,NULL,$11,$12,now()) RETURNING id`,
          [area.id, area.property_id, area.landlord_id, actor.profileId, actor.userId,
           title, kind, startsAt, endsAt, guestCount, fee, notifyFlag])
        id = ins.rows[0].id
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally { client.release() }
      await fireAmenityAlert(id)
      await billReservationFee(id)
      return {
        ok: true, reservationId: id, status: 'approved', fee,
        message: `Booked — ${area.name} is reserved.` + (fee > 0 ? ` The $${fee.toFixed(2)} fee has been billed to the tenant's account.` : ''),
      }
    }

    const ins = await queryOne<{ id: string }>(
      `INSERT INTO common_area_reservations
         (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id,
          title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount, notify_residents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,NULL,$11,$12) RETURNING id`,
      [area.id, area.property_id, area.landlord_id, actor.profileId, actor.userId,
       title, kind, startsAt, endsAt, guestCount, fee, notifyFlag])
    const meta = await queryOne<any>(
      `SELECT lu.id AS landlord_user_id, lu.email AS landlord_email,
              tu.first_name, tu.last_name, p.name AS property_name
         FROM common_areas ca
         JOIN properties p ON p.id = ca.property_id
         JOIN landlords l ON l.id = ca.landlord_id
         JOIN users lu ON lu.id = l.user_id
         JOIN tenants t ON t.id = $2
         JOIN users tu ON tu.id = t.user_id
        WHERE ca.id = $1`, [area.id, actor.profileId])
    if (meta?.landlord_user_id) {
      await notifyReservationRequested({
        landlordUserId: meta.landlord_user_id, landlordId: area.landlord_id,
        landlordEmail: meta.landlord_email,
        tenantName: `${meta.first_name ?? ''} ${meta.last_name ?? ''}`.trim() || 'A resident',
        areaName: area.name, propertyName: meta.property_name,
        startsAt, endsAt, reservationId: ins!.id, guestCount,
      }).catch(() => { /* best-effort */ })
    }
    return {
      ok: true, reservationId: ins!.id, status: 'pending', fee,
      message: `Request sent — ${area.name} needs the property's approval. ` +
        (fee > 0 ? `If approved, the $${fee.toFixed(2)} fee applies. ` : '') +
        'The tenant will be notified of the decision.',
    }
  },
}
