import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
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
