// Common-area reservations + amenity alerts (launch feature).
//
// Two audiences on one router:
//  • Landlord/team — manage common areas, create private rentals /
//    closures / events (go live immediately), decide resident requests.
//  • Tenant — see reservable areas + upcoming holds at their property,
//    request a reservation, view/cancel their own.
//
// A reservation/closure going live (landlord-created, or a resident request
// approved / auto-approved) fans out an amenity-unavailable notification to
// every active resident of the property (see services/notifications).
//
// Conflict integrity: approvals run under a per-area advisory lock and a
// hard overlap check vs. other APPROVED holds (services/commonAreas).
//
// Note (TZ): open_time/close_time are stored + surfaced for display but not
// hard-enforced — correct enforcement needs a per-property timezone we don't
// model yet. Duration (max_reservation_hours) and lead time
// (advance_booking_days) ARE enforced; both are timezone-agnostic.
import { Router } from 'express'
import { z } from 'zod'
import {
  COMMON_AREA_RESERVATION_KINDS,
  LANDLORD_RESERVATION_KINDS,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { lockArea, findApprovedConflict, computeReservationFee, billReservationFee, settleReservationFeeOnCancel } from '../services/commonAreas'
import {
  notifyReservationRequested,
  notifyReservationDecision,
  notifyAmenityUnavailable,
  createNotification,
} from '../services/notifications'

export const commonAreasRouter = Router()
commonAreasRouter.use(requireAuth)

// Active-lease property ids for a tenant — gates which areas they can touch.
async function tenantPropertyIds(tenantId: string): Promise<string[]> {
  const rows = await query<{ property_id: string }>(
    `SELECT DISTINCT u.property_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id
       JOIN units  u ON u.id = l.unit_id
      WHERE vlat.tenant_id = $1`,
    [tenantId]
  )
  return rows.map(r => r.property_id)
}

async function loadArea(id: string) {
  return queryOne<any>(`SELECT * FROM common_areas WHERE id = $1`, [id])
}

// ── Validation ────────────────────────────────────────────────────────
const areaCreateSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  reservable: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  reservationFee: z.number().nonnegative().optional(),
  weekendFee: z.number().nonnegative().nullable().optional(),
  openTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  maxReservationHours: z.number().int().positive().nullable().optional(),
  advanceBookingDays: z.number().int().positive().nullable().optional(),
})
const areaUpdateSchema = areaCreateSchema.partial().omit({ propertyId: true }).extend({
  active: z.boolean().optional(),
})

const requestSchema = z.object({
  title: z.string().trim().max(160).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  guestCount: z.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
})
// Landlord-created hold: a kind + whether to alert residents.
const landlordReservationSchema = requestSchema.extend({
  kind: z.enum(LANDLORD_RESERVATION_KINDS as unknown as [string, ...string[]]),
  notifyResidents: z.boolean().optional(),
})

function validateWindow(area: any, startsAt: string, endsAt: string) {
  const s = new Date(startsAt), e = new Date(endsAt)
  if (!(e.getTime() > s.getTime())) throw new AppError(400, 'End must be after start')
  if (area.max_reservation_hours) {
    const hours = (e.getTime() - s.getTime()) / 3_600_000
    if (hours > area.max_reservation_hours)
      throw new AppError(400, `Reservation exceeds the ${area.max_reservation_hours}-hour limit for ${area.name}`)
  }
  if (area.advance_booking_days) {
    const maxLead = Date.now() + area.advance_booking_days * 86_400_000
    if (s.getTime() > maxLead)
      throw new AppError(400, `${area.name} can only be booked up to ${area.advance_booking_days} days ahead`)
  }
}

// Fire the resident amenity alert for a now-live reservation (best-effort;
// stamps residents_notified_at). Called AFTER the write commits.
async function fireAmenityAlert(reservationId: string) {
  const r = await queryOne<any>(
    `SELECT car.*, ca.name AS area_name, p.name AS property_name
       FROM common_area_reservations car
       JOIN common_areas ca ON ca.id = car.common_area_id
       JOIN properties   p  ON p.id  = car.property_id
      WHERE car.id = $1`,
    [reservationId]
  )
  if (!r || r.status !== 'approved' || !r.notify_residents) return
  const count = await notifyAmenityUnavailable({
    propertyId: r.property_id, landlordId: r.landlord_id, propertyName: r.property_name,
    areaName: r.area_name, kind: r.kind, reason: r.title,
    startsAt: r.starts_at, endsAt: r.ends_at, excludeTenantId: r.reserved_by_tenant_id,
  })
  await query(`UPDATE common_area_reservations SET residents_notified_at = now() WHERE id = $1`, [reservationId])
  return count
}

// ════════════════════════════════════════════════════════════════════
// LANDLORD — common-area management
// ════════════════════════════════════════════════════════════════════

// List areas for a property.
commonAreasRouter.get('/', async (req, res, next) => {
  try {
    const u = req.user!
    const propertyId = req.query.propertyId as string | undefined
    if (!propertyId) throw new AppError(400, 'propertyId required')
    const prop = await queryOne<any>(`SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(u, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    const areas = await query(
      `SELECT * FROM common_areas WHERE property_id = $1 ORDER BY active DESC, name`, [propertyId])
    res.json({ success: true, data: areas })
  } catch (e) { next(e) }
})

// Create an area.
commonAreasRouter.post('/', async (req, res, next) => {
  try {
    const u = req.user!
    const b = areaCreateSchema.parse(req.body)
    const prop = await queryOne<any>(`SELECT landlord_id FROM properties WHERE id = $1`, [b.propertyId])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(u, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    const row = await queryOne(
      `INSERT INTO common_areas
         (property_id, landlord_id, name, description, reservable, requires_approval,
          capacity, reservation_fee, weekend_fee, open_time, close_time, max_reservation_hours, advance_booking_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [b.propertyId, prop.landlord_id, b.name, b.description ?? null,
       b.reservable ?? true, b.requiresApproval ?? true, b.capacity ?? null,
       b.reservationFee ?? 0, b.weekendFee ?? null, b.openTime ?? null, b.closeTime ?? null,
       b.maxReservationHours ?? null, b.advanceBookingDays ?? null]
    )
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Update an area.
commonAreasRouter.patch('/:id', async (req, res, next) => {
  try {
    const u = req.user!
    const b = areaUpdateSchema.parse(req.body)
    const area = await loadArea(req.params.id)
    if (!area) throw new AppError(404, 'Common area not found')
    if (!canManageLandlordResource(u, area.landlord_id)) throw new AppError(403, 'Forbidden')
    const map: Record<string, any> = {
      name: b.name, description: b.description, reservable: b.reservable,
      requires_approval: b.requiresApproval, capacity: b.capacity,
      reservation_fee: b.reservationFee, weekend_fee: b.weekendFee, open_time: b.openTime, close_time: b.closeTime,
      max_reservation_hours: b.maxReservationHours, advance_booking_days: b.advanceBookingDays,
      active: b.active,
    }
    const sets: string[] = [], vals: any[] = []
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { vals.push(val); sets.push(`${col} = $${vals.length}`) }
    }
    if (!sets.length) { res.json({ success: true, data: area }); return }
    vals.push(req.params.id)
    const row = await queryOne(
      `UPDATE common_areas SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Soft-delete (deactivate) an area.
commonAreasRouter.delete('/:id', async (req, res, next) => {
  try {
    const u = req.user!
    const area = await loadArea(req.params.id)
    if (!area) throw new AppError(404, 'Common area not found')
    if (!canManageLandlordResource(u, area.landlord_id)) throw new AppError(403, 'Forbidden')
    await query(`UPDATE common_areas SET active = false, updated_at = now() WHERE id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// List reservations for an area (landlord view).
commonAreasRouter.get('/:id/reservations', async (req, res, next) => {
  try {
    const u = req.user!
    const area = await loadArea(req.params.id)
    if (!area) throw new AppError(404, 'Common area not found')
    if (!canAccessLandlordResource(u, area.landlord_id)) throw new AppError(403, 'Forbidden')
    const status = req.query.status as string | undefined
    const params: any[] = [req.params.id]
    let where = `car.common_area_id = $1`
    if (status) { params.push(status); where += ` AND car.status = $${params.length}` }
    const rows = await query(
      `SELECT car.*, us.first_name AS tenant_first_name, us.last_name AS tenant_last_name
         FROM common_area_reservations car
         LEFT JOIN tenants t ON t.id = car.reserved_by_tenant_id
         LEFT JOIN users  us ON us.id = t.user_id
        WHERE ${where}
        ORDER BY car.starts_at DESC`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Landlord creates a private rental / closure / event — goes live immediately.
commonAreasRouter.post('/:id/reservations', async (req, res, next) => {
  try {
    const u = req.user!
    const b = landlordReservationSchema.parse(req.body)
    const area = await loadArea(req.params.id)
    if (!area) throw new AppError(404, 'Common area not found')
    if (!canManageLandlordResource(u, area.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!area.active) throw new AppError(400, 'Common area is inactive')
    validateWindow(area, b.startsAt, b.endsAt)

    const client = await getClient()
    let id: string
    try {
      await client.query('BEGIN')
      await lockArea(client, area.id)
      const conflict = await findApprovedConflict(client, area.id, b.startsAt, b.endsAt)
      if (conflict) throw new AppError(409, `${area.name} is already reserved for an overlapping window`)
      const ins = await client.query(
        `INSERT INTO common_area_reservations
           (common_area_id, property_id, landlord_id, created_by_user_id, title, kind,
            starts_at, ends_at, status, guest_count, notes, notify_residents,
            decided_by_user_id, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,$10,$11,$4,now()) RETURNING id`,
        [area.id, area.property_id, area.landlord_id, u.userId, b.title ?? null, b.kind,
         b.startsAt, b.endsAt, b.guestCount ?? null, b.notes ?? null, b.notifyResidents ?? true]
      )
      id = ins.rows[0].id
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    await fireAmenityAlert(id)
    const row = await queryOne(`SELECT * FROM common_area_reservations WHERE id = $1`, [id])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Landlord decides a pending resident request: approve or reject.
commonAreasRouter.post('/reservations/:rid/decide', async (req, res, next) => {
  try {
    const u = req.user!
    const b = z.object({
      approve: z.boolean(),
      note: z.string().trim().max(2000).optional(),
    }).parse(req.body)
    const r = await queryOne<any>(`SELECT * FROM common_area_reservations WHERE id = $1`, [req.params.rid])
    if (!r) throw new AppError(404, 'Reservation not found')
    if (!canManageLandlordResource(u, r.landlord_id)) throw new AppError(403, 'Forbidden')
    if (r.status !== 'pending') throw new AppError(400, `Reservation is already ${r.status}`)

    if (!b.approve) {
      await query(
        `UPDATE common_area_reservations
            SET status='rejected', decided_by_user_id=$2, decided_at=now(), decision_note=$3, updated_at=now()
          WHERE id=$1`, [r.id, u.userId, b.note ?? null])
    } else {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await lockArea(client, r.common_area_id)
        const conflict = await findApprovedConflict(client, r.common_area_id, r.starts_at, r.ends_at, r.id)
        if (conflict) throw new AppError(409, 'Another reservation now occupies that window — decline or adjust')
        await client.query(
          `UPDATE common_area_reservations
              SET status='approved', decided_by_user_id=$2, decided_at=now(), decision_note=$3, updated_at=now()
            WHERE id=$1`, [r.id, u.userId, b.note ?? null])
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    }

    // Tell the resident; alert the property if it's now live.
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
        areaName: meta.area_name, propertyName: meta.property_name, approved: b.approve,
        startsAt: r.starts_at, endsAt: r.ends_at, decisionNote: b.note ?? null,
      })
    }
    if (b.approve) { await fireAmenityAlert(r.id); await billReservationFee(r.id) }
    const row = await queryOne(`SELECT * FROM common_area_reservations WHERE id = $1`, [r.id])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════════════════════════════════
// TENANT — reservable areas + requests
// ════════════════════════════════════════════════════════════════════

// Reservable areas at the tenant's property/properties, with upcoming holds
// so the resident can see what's free.
commonAreasRouter.get('/mine', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const propIds = await tenantPropertyIds(u.profileId)
    if (!propIds.length) { res.json({ success: true, data: [] }); return }
    const areas = await query(
      `SELECT id, property_id, name, description, reservable, requires_approval, capacity,
              reservation_fee, open_time, close_time, max_reservation_hours, advance_booking_days
         FROM common_areas
        WHERE property_id = ANY($1) AND active AND reservable
        ORDER BY name`, [propIds])
    // upcoming approved holds (so residents see unavailable windows)
    const holds = await query(
      `SELECT common_area_id, title, kind, starts_at, ends_at
         FROM common_area_reservations
        WHERE property_id = ANY($1) AND status='approved' AND ends_at > now()
        ORDER BY starts_at`, [propIds])
    const byArea: Record<string, any[]> = {}
    for (const h of holds) (byArea[h.common_area_id] ??= []).push(h)
    res.json({ success: true, data: areas.map(a => ({ ...a, upcoming: byArea[a.id] ?? [] })) })
  } catch (e) { next(e) }
})

// Tenant's own reservations.
commonAreasRouter.get('/my-reservations', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const rows = await query(
      `SELECT car.*, ca.name AS area_name
         FROM common_area_reservations car
         JOIN common_areas ca ON ca.id = car.common_area_id
        WHERE car.reserved_by_tenant_id = $1
        ORDER BY car.starts_at DESC`, [u.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Tenant requests a reservation. Auto-approves when the area doesn't require
// approval (conflict-checked); otherwise lands as 'pending' for the landlord.
commonAreasRouter.post('/:id/request', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const b = requestSchema.parse(req.body)
    const area = await loadArea(req.params.id)
    if (!area) throw new AppError(404, 'Common area not found')
    if (!area.active || !area.reservable) throw new AppError(400, 'This area is not reservable')
    const propIds = await tenantPropertyIds(u.profileId)
    if (!propIds.includes(area.property_id)) throw new AppError(403, 'Not a resident of this property')
    validateWindow(area, b.startsAt, b.endsAt)

    const autoApprove = !area.requires_approval
    let id: string

    if (autoApprove) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await lockArea(client, area.id)
        const conflict = await findApprovedConflict(client, area.id, b.startsAt, b.endsAt)
        if (conflict) throw new AppError(409, 'That window is already reserved — pick another time')
        const ins = await client.query(
          `INSERT INTO common_area_reservations
             (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id,
              title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount,
              decided_at)
           VALUES ($1,$2,$3,$4,$5,$6,'tenant_reservation',$7,$8,'approved',$9,$10,$11,now()) RETURNING id`,
          [area.id, area.property_id, area.landlord_id, u.profileId, u.userId,
           b.title ?? null, b.startsAt, b.endsAt, b.guestCount ?? null, b.notes ?? null, computeReservationFee(area, b.startsAt)])
        id = ins.rows[0].id
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
      await fireAmenityAlert(id)
      await billReservationFee(id)   // #4: charge the fee now that it's live
    } else {
      const ins = await queryOne<any>(
        `INSERT INTO common_area_reservations
           (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id,
            title, kind, starts_at, ends_at, status, guest_count, notes, fee_amount)
         VALUES ($1,$2,$3,$4,$5,$6,'tenant_reservation',$7,$8,'pending',$9,$10,$11) RETURNING id`,
        [area.id, area.property_id, area.landlord_id, u.profileId, u.userId,
         b.title ?? null, b.startsAt, b.endsAt, b.guestCount ?? null, b.notes ?? null, computeReservationFee(area, b.startsAt)])
      id = ins!.id
      // notify the landlord a request is pending
      const meta = await queryOne<any>(
        `SELECT lu.id AS landlord_user_id, lu.email AS landlord_email,
                tu.first_name, tu.last_name, p.name AS property_name
           FROM common_areas ca
           JOIN properties p ON p.id = ca.property_id
           JOIN landlords l ON l.id = ca.landlord_id
           JOIN users lu ON lu.id = l.user_id
           JOIN tenants t ON t.id = $2
           JOIN users tu ON tu.id = t.user_id
          WHERE ca.id = $1`, [area.id, u.profileId])
      if (meta?.landlord_user_id) {
        await notifyReservationRequested({
          landlordUserId: meta.landlord_user_id, landlordId: area.landlord_id,
          landlordEmail: meta.landlord_email,
          tenantName: `${meta.first_name ?? ''} ${meta.last_name ?? ''}`.trim() || 'A resident',
          areaName: area.name, propertyName: meta.property_name,
          startsAt: b.startsAt, endsAt: b.endsAt, reservationId: id, guestCount: b.guestCount ?? null,
        })
      }
    }

    const row = await queryOne(`SELECT * FROM common_area_reservations WHERE id = $1`, [id])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ════════════════════════════════════════════════════════════════════
// Shared — cancel (owning tenant or managing landlord)
// ════════════════════════════════════════════════════════════════════
commonAreasRouter.post('/reservations/:rid/cancel', async (req, res, next) => {
  try {
    const u = req.user!
    const r = await queryOne<any>(`SELECT * FROM common_area_reservations WHERE id = $1`, [req.params.rid])
    if (!r) throw new AppError(404, 'Reservation not found')
    const isOwningTenant = u.role === 'tenant' && r.reserved_by_tenant_id === u.profileId
    const isManager = canManageLandlordResource(u, r.landlord_id)
    if (!isOwningTenant && !isManager) throw new AppError(403, 'Forbidden')
    if (r.status === 'cancelled' || r.status === 'rejected')
      throw new AppError(400, `Reservation is already ${r.status}`)
    await query(
      `UPDATE common_area_reservations SET status='cancelled', updated_at=now() WHERE id=$1`, [r.id])
    // #4: apply the fee refund policy (≥48h ahead → refundable; inside 48h → fee stands).
    const feeOutcome = await settleReservationFeeOnCancel(r)
    if (feeOutcome === 'refund_due') {
      // The fee was already paid — flag the landlord to process the Stripe refund.
      const meta = await queryOne<any>(
        `SELECT lu.id AS landlord_user_id, lu.email, ca.name AS area_name
           FROM common_areas ca JOIN landlords l ON l.id = ca.landlord_id
           JOIN users lu ON lu.id = l.user_id WHERE ca.id = $1`, [r.common_area_id])
      if (meta?.landlord_user_id) {
        await createNotification({
          userId: meta.landlord_user_id, landlordId: r.landlord_id,
          type: 'amenity_fee_refund_due',
          title: `Refund due — ${meta.area_name} reservation cancelled`,
          body: `A paid ${meta.area_name} reservation was cancelled 48h+ ahead. Refund the $${Number(r.fee_amount).toFixed(2)} reservation fee.`,
          data: { reservationId: r.id, amount: r.fee_amount },
          sendEmail: true, emailTo: meta.email,
        })
      }
    }
    res.json({ success: true, data: { feeOutcome } })
  } catch (e) { next(e) }
})
