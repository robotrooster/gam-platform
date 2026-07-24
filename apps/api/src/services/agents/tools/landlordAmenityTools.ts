/**
 * Landlord amenity tools (S552).
 *
 * get_pending_amenity_requests (READ) — resident reservation requests
 * awaiting a decision across the landlord's properties.
 *
 * decide_amenity_reservation (ACTION, confirm-first) — approve or decline a
 * pending request. Mirrors POST /common-areas/reservations/:rid/decide
 * exactly: approval re-checks the window under the area lock (a conflicting
 * approval that landed meanwhile turns into a clear error), notifies the
 * resident, fires the property alert, and bills the reservation fee.
 * Hard-scoped to the landlord's own reservations.
 */

import { query, queryOne, getClient } from '../../../db'
import { lockArea, findApprovedConflict, billReservationFee } from '../../commonAreas'
import { fireAmenityAlert } from '../../../routes/commonAreas'
import { notifyReservationDecision } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

export const getPendingAmenityRequests: AgentTool = {
  name: 'get_pending_amenity_requests',
  description:
    'Resident amenity-reservation requests awaiting the landlord’s decision — who, which area, the window, ' +
    'guest count, and the fee that applies if approved. Use for “any amenity requests waiting on me?”. ' +
    'Read-only; decide with decide_amenity_reservation.',
  parameters: { type: 'object', properties: {} },
  audiences: ['landlord'],

  async execute(_args, actor: AgentActor) {
    const rows = await query<any>(
      `SELECT car.id, ca.name AS area_name, p.name AS property_name,
              car.kind, car.title, car.starts_at, car.ends_at, car.guest_count,
              car.fee_amount::float AS fee_amount, car.created_at,
              (tu.first_name || ' ' || tu.last_name) AS tenant_name
         FROM common_area_reservations car
         JOIN common_areas ca ON ca.id = car.common_area_id
         JOIN properties p ON p.id = car.property_id
         LEFT JOIN tenants t ON t.id = car.reserved_by_tenant_id
         LEFT JOIN users tu ON tu.id = t.user_id
        WHERE car.landlord_id = $1 AND car.status = 'pending'
        ORDER BY car.starts_at ASC
        LIMIT 30`,
      [actor.profileId]
    )
    return {
      ok: true,
      pending: rows,
      note: rows.length === 0 ? 'No amenity requests are waiting.' : `${rows.length} request(s) awaiting a decision.`,
    }
  },
}

export const decideAmenityReservation: AgentTool = {
  name: 'decide_amenity_reservation',
  description:
    'Approve or decline a PENDING resident amenity request. Get the reservationId from ' +
    'get_pending_amenity_requests and CONFIRM the landlord’s decision explicitly before calling. Approving ' +
    'bills the reservation fee to the resident and announces the hold; declining notifies them with your ' +
    'optional note.',
  parameters: {
    type: 'object',
    properties: {
      reservationId: { type: 'string', description: 'From get_pending_amenity_requests.' },
      approve: { type: 'boolean', description: 'true to approve, false to decline.' },
      note: { type: 'string', description: 'Optional note shown to the resident (esp. when declining).' },
    },
    required: ['reservationId', 'approve'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const rid = String(args.reservationId ?? '').trim()
    const approve = args.approve === true
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 2000) : null
    if (!rid) return { ok: false, error: 'A reservationId is required (from get_pending_amenity_requests).' }

    const r = await queryOne<any>(
      `SELECT * FROM common_area_reservations WHERE id = $1 AND landlord_id = $2`,
      [rid, actor.profileId]
    )
    if (!r) return { ok: false, error: 'No such reservation on this account.' }
    if (r.status !== 'pending') return { ok: false, error: `That reservation is already ${r.status}.` }

    if (!approve) {
      await query(
        `UPDATE common_area_reservations
            SET status='rejected', decided_by_user_id=$2, decided_at=now(), decision_note=$3, updated_at=now()
          WHERE id=$1`,
        [r.id, actor.userId, note]
      )
    } else {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await lockArea(client, r.common_area_id)
        const conflict = await findApprovedConflict(client, r.common_area_id, r.starts_at, r.ends_at, r.id)
        if (conflict) {
          await client.query('ROLLBACK')
          return { ok: false, error: 'Another approved reservation now occupies that window — decline this one or have the resident pick a new time.' }
        }
        await client.query(
          `UPDATE common_area_reservations
              SET status='approved', decided_by_user_id=$2, decided_at=now(), decision_note=$3, updated_at=now()
            WHERE id=$1`,
          [r.id, actor.userId, note]
        )
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally { client.release() }
    }

    // Resident notification + (on approval) property alert and fee billing —
    // same order as the portal route.
    try {
      const tenantUser = await queryOne<any>(
        `SELECT us.id AS user_id, us.email FROM tenants t JOIN users us ON us.id = t.user_id WHERE t.id = $1`,
        [r.reserved_by_tenant_id])
      const meta = await queryOne<any>(
        `SELECT ca.name AS area_name, p.name AS property_name
           FROM common_areas ca JOIN properties p ON p.id = ca.property_id WHERE ca.id = $1`,
        [r.common_area_id])
      if (tenantUser?.email && meta) {
        await notifyReservationDecision({
          tenantUserId: tenantUser.user_id, tenantEmail: tenantUser.email,
          areaName: meta.area_name, propertyName: meta.property_name, approved: approve,
          startsAt: r.starts_at, endsAt: r.ends_at, decisionNote: note,
        })
      }
    } catch { /* best-effort */ }
    if (approve) {
      await fireAmenityAlert(r.id).catch(() => {})
      await billReservationFee(r.id).catch(() => {})
    }
    return {
      ok: true,
      reservationId: r.id,
      decision: approve ? 'approved' : 'rejected',
      message: approve
        ? `Approved — the resident has been notified${Number(r.fee_amount) > 0 ? ` and the $${Number(r.fee_amount).toFixed(2)} fee billed` : ''}.`
        : 'Declined — the resident has been notified.',
    }
  },
}
