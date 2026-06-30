import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'

// ============================================================
// Portfolio-wide bookings list. Companion to /api/units/:id/bookings
// (per-unit), this provides a flat queryable view with filters
// for the BookingsPage.
//
// Visibility: landlord/PM-scoped via canAccessLandlordResource.
// Owner roles see everything in their portfolio; team-roles see
// what their scope row allows.
// ============================================================

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth)

bookingsRouter.get('/', async (req, res, next) => {
  try {
    const u = req.user!
    const role = u.role
    const filters: string[] = []
    const params: any[] = []

    // Landlord-scope. Owners read their own; admins read all.
    if (role !== 'admin' && role !== 'super_admin') {
      const landlordId = role === 'landlord' ? u.profileId : u.landlordId
      if (!landlordId) throw new AppError(403, 'No landlord scope')
      params.push(landlordId)
      filters.push(`b.landlord_id = $${params.length}`)
    }

    if (req.query.status) {
      params.push(req.query.status)
      filters.push(`b.status = $${params.length}`)
    }
    if (req.query.source) {
      params.push(req.query.source)
      filters.push(`b.source = $${params.length}`)
    }
    if (req.query.unitId) {
      params.push(req.query.unitId)
      filters.push(`b.unit_id = $${params.length}`)
    }
    if (req.query.from) {
      params.push(req.query.from)
      filters.push(`b.check_out >= $${params.length}`)
    }
    if (req.query.to) {
      params.push(req.query.to)
      filters.push(`b.check_in <= $${params.length}`)
    }
    if (req.query.q) {
      params.push(`%${(req.query.q as string).toLowerCase()}%`)
      filters.push(`(LOWER(b.guest_name) LIKE $${params.length} OR LOWER(b.guest_email) LIKE $${params.length})`)
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

    const rows = await query<any>(
      `SELECT b.id,
              b.unit_id,
              u.unit_number,
              u.unit_type,
              p.name AS property_name,
              p.requires_booking_acknowledgment,
              b.landlord_id,
              b.guest_name,
              b.guest_email,
              b.guest_phone,
              b.lease_type,
              b.check_in,
              b.check_out,
              b.nights,
              b.nightly_rate,
              b.weekly_rate,
              b.total_amount,
              b.platform_fee,
              b.status,
              b.source,
              b.notes,
              b.acknowledgment_signed_at,
              b.created_at
         FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
        ${where}
        ORDER BY b.check_in DESC
        LIMIT 500`,
      params,
    )

    // Defense-in-depth: drop any row whose landlord the requester
    // doesn't have scope to read (only matters for team roles
    // whose `landlord_id` claim may not match every booking).
    const filtered = rows.filter(r => canAccessLandlordResource(u, r.landlord_id))

    res.json({ success: true, data: filtered })
  } catch (e) {
    next(e)
  }
})

// ============================================================
// Booking change requests (guest-agent track, S501).
// A booking guest's stay-change ask (late checkout / early check-in /
// extra night / other) is recorded by the request_booking_change agent
// tool into booking_change_requests as a draft — the agent never mutates
// the booking. This is the host's review surface: list the requests and
// approve/decline them. Approving is an acknowledgment, not an automatic
// booking edit (pricing/date changes stay a deliberate host action on the
// booking itself) — same draft-with-approval posture as the agent tool.
// ============================================================

// GET /api/bookings/change-requests — the host's review queue.
// Defaults to open ('requested') items; ?status=approved|declined|cancelled
// or ?status=all returns history.
bookingsRouter.get('/change-requests', async (req, res, next) => {
  try {
    const u = req.user!
    const role = u.role
    const filters: string[] = []
    const params: any[] = []

    if (role !== 'admin' && role !== 'super_admin') {
      const landlordId = role === 'landlord' ? u.profileId : u.landlordId
      if (!landlordId) throw new AppError(403, 'No landlord scope')
      params.push(landlordId)
      filters.push(`cr.landlord_id = $${params.length}`)
    }

    const status = typeof req.query.status === 'string' ? req.query.status : 'requested'
    if (status !== 'all') {
      params.push(status)
      filters.push(`cr.status = $${params.length}`)
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

    const rows = await query<any>(
      `SELECT cr.id,
              cr.booking_id,
              cr.landlord_id,
              cr.request_type,
              cr.details,
              cr.status,
              cr.resolved_at,
              cr.resolved_by_user_id,
              cr.created_at,
              COALESCE(NULLIF(TRIM(resolver.first_name || ' ' || resolver.last_name), ''), resolver.email) AS resolved_by_name,
              b.unit_id,
              b.guest_name,
              b.guest_email,
              b.check_in,
              b.check_out,
              b.status AS booking_status,
              u.unit_number,
              p.name AS property_name
         FROM booking_change_requests cr
         JOIN unit_bookings b ON b.id = cr.booking_id
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
    LEFT JOIN users resolver ON resolver.id = cr.resolved_by_user_id
        ${where}
        ORDER BY (cr.status = 'requested') DESC, cr.created_at DESC
        LIMIT 500`,
      params,
    )

    // Defense-in-depth: drop any row the requester can't read (team roles).
    const filtered = rows.filter(r => canAccessLandlordResource(u, r.landlord_id))

    res.json({ success: true, data: filtered })
  } catch (e) {
    next(e)
  }
})

// PATCH /api/bookings/change-requests/:id — approve or decline an open
// request. Only an open ('requested') row transitions; resolving twice is a
// no-op error. Stamps resolver + time. The guest has no account, so there's
// no guest notification — the host follows up with the guest directly (as the
// agent already told them it would).
bookingsRouter.patch('/change-requests/:id', async (req, res, next) => {
  try {
    const u = req.user!
    const body = z.object({ status: z.enum(['approved', 'declined']) }).parse(req.body ?? {})

    const cr = await queryOne<{ id: string; landlord_id: string; status: string }>(
      `SELECT id, landlord_id, status FROM booking_change_requests WHERE id = $1`,
      [req.params.id],
    )
    if (!cr) throw new AppError(404, 'Change request not found')
    if (!canManageLandlordResource(u, cr.landlord_id)) throw new AppError(403, 'Forbidden')
    if (cr.status !== 'requested') {
      throw new AppError(409, `This request is already ${cr.status}.`)
    }

    const updated = await queryOne<any>(
      `UPDATE booking_change_requests
          SET status = $1, resolved_at = now(), resolved_by_user_id = $2
        WHERE id = $3 AND status = 'requested'
      RETURNING id, status, resolved_at, resolved_by_user_id`,
      [body.status, u.userId, req.params.id],
    )
    if (!updated) throw new AppError(409, 'This request was just resolved by someone else.')

    res.json({ success: true, data: updated })
  } catch (e) {
    next(e)
  }
})
