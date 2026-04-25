import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { UnitStatus, calcNetPerUnit, getReservePhase, PLATFORM_FEES, UNIT_STATUSES } from '@gam/shared'
import { formatUnitNumber } from '../lib/format'

export const unitsRouter = Router()
unitsRouter.use(requireAuth)

// GET /api/units  — landlord sees their units, admin sees all
unitsRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const landlordFilter = isAdmin
      ? '' : `AND u.landlord_id = '${req.user!.profileId}'`
    const propertyFilter = req.query.propertyId ? `AND u.property_id = '${req.query.propertyId}'` : ''
    const units = await query<any>(`
      SELECT u.*,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        vuo.primary_tenant_id AS tenant_id,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.tenant_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE 1=1 ${landlordFilter} ${propertyFilter}
      ORDER BY p.name, u.unit_number
    `)
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// GET /api/units/:id
unitsRouter.get('/:id', async (req, res, next) => {
  try {
    const unit = await queryOne<any>(`
      SELECT u.*, p.name AS property_name, p.type AS property_type,
        p.street1, p.city, p.state, p.zip,
        ul.first_name AS landlord_first, ul.last_name AS landlord_last,
        te.ssi_ssdi, te.on_time_pay_enrolled, te.ach_verified,
        vuo.primary_first_name AS tenant_first,
        vuo.primary_last_name AS tenant_last,
        vuo.primary_email AS tenant_email,
        vuo.primary_phone AS tenant_phone,
        vuo.primary_tenant_id AS tenant_id,
        vuo.tenant_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users ul ON ul.id = l.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants te ON te.id = vuo.primary_tenant_id
      WHERE u.id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin' && unit.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Forbidden')
    }
    res.json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// POST /api/units
unitsRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      propertyId:      z.string().uuid(),
      unitNumber:      z.string(),
      bedrooms:        z.number().int().min(0).default(1),
      bathrooms:       z.number().min(0).default(1),
      sqft:            z.number().int().nullable().optional(),
      rentAmount:      z.number().positive(),
      securityDeposit: z.number().min(0).default(0),
    }).parse(req.body)

    // Verify property belongs to this landlord
    const prop = await queryOne<any>(
      `SELECT id FROM properties WHERE id = $1 AND landlord_id = $2`,
      [body.propertyId, req.user!.profileId]
    )
    if (!prop) throw new AppError(403, 'Property not found or not yours')

    const [unit] = await query<any>(`
      INSERT INTO units (property_id, landlord_id, unit_number, bedrooms, bathrooms, sqft, rent_amount, security_deposit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [body.propertyId, req.user!.profileId, formatUnitNumber(body.unitNumber), body.bedrooms,
       body.bathrooms, body.sqft ?? null, body.rentAmount, body.securityDeposit]
    )
    res.status(201).json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/status — set unit status
unitsRouter.patch('/:id/status', requireLandlord, async (req, res, next) => {
  try {
    const { status } = z.object({
      status: z.enum([...UNIT_STATUSES] as [string, ...string[]])
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== req.user!.profileId && req.user!.role !== 'admin' && req.user!.role !== 'super_admin') {
      throw new AppError(403, 'Forbidden')
    }
    const [updated] = await query<any>(
      `UPDATE units SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/eviction-mode — Eviction mode — HARD BLOCK all tenant ACH
// Hard-blocks tenant ACH while eviction is active. Landlord is responsible for knowing their local eviction rules.
unitsRouter.post('/:id/eviction-mode', requireLandlord, async (req, res, next) => {
  try {
    const { enable, confirm } = z.object({
      enable:  z.boolean(),
      confirm: z.boolean().refine(v => v === true, 'Must confirm eviction mode')
    }).parse(req.body)

    const unit = await queryOne<any>(`SELECT * FROM units WHERE id = $1`, [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.landlord_id !== req.user!.profileId && req.user!.role !== 'admin') {
      throw new AppError(403, 'Forbidden')
    }

    const [updated] = await query<any>(`
      UPDATE units
      SET payment_block = $1,
          payment_block_set_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          payment_block_set_by = CASE WHEN $1 THEN $2 ELSE NULL END
      WHERE id = $3
      RETURNING *`,
      [enable, req.user!.userId, req.params.id]
    )
    res.json({
      success: true,
      data: updated,
      message: enable
        ? '⚠️ EVICTION MODE ACTIVE — All tenant ACH hard blocked. Check your local laws before accepting any payment.'
        : 'Eviction mode deactivated — ACH collections resumed'
    })
  } catch (e) { next(e) }
})

// GET /api/units/:id/economics
unitsRouter.get('/:id/economics', async (req, res, next) => {
  try {
    const unit = await queryOne('SELECT * FROM units WHERE id = $1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    const [{ count }] = await query('SELECT COUNT(*)::int AS count FROM units WHERE landlord_id = $1 AND status = $2', [unit.landlord_id, 'active'])
    const { rate } = getReservePhase(count)
    const econ = calcNetPerUnit(unit.rent_amount, rate)
    const fee = unit.status === 'active' ? PLATFORM_FEES.ACTIVE_UNIT : unit.status === 'direct_pay' ? PLATFORM_FEES.DIRECT_PAY_UNIT : 0
    const feeNum = Number(fee)
    const ps = await queryOne("SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_collected, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('month', NOW())), 0) as this_month, COALESCE(SUM(amount) FILTER (WHERE status = 'settled' AND due_date >= date_trunc('year', NOW())), 0) as this_year, COUNT(*) FILTER (WHERE status = 'settled') as settled_count, COUNT(*) FILTER (WHERE status = 'failed') as failed_count, MIN(due_date) as first_payment FROM payments WHERE unit_id = $1", [req.params.id])
    const ms = await queryOne("SELECT COALESCE(SUM(actual_cost), 0) as total_cost, COALESCE(SUM(actual_cost) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) as this_month_cost, COUNT(*) as total_requests FROM maintenance_requests WHERE unit_id = $1", [req.params.id])
    const fp = ps && ps.first_payment ? new Date(ps.first_payment) : null
    const months = fp ? Math.floor((Date.now() - fp.getTime()) / (1000*60*60*24*30)) : 0
    const lc = parseFloat(ps && ps.total_collected || 0)
    const lm = parseFloat(ms && ms.total_cost || 0)
    res.json({ success: true, data: { ...econ, platformFee: fee, reserveRate: rate, occupiedPortfolio: count, netRentMonthly: unit.rent_amount - feeNum, netRentYearly: (unit.rent_amount - feeNum) * 12, netThisMonth: parseFloat(ps && ps.this_month || 0) - feeNum - parseFloat(ms && ms.this_month_cost || 0), netThisYear: parseFloat(ps && ps.this_year || 0) - (feeNum*12) - lm, tenantMonths: months, lifetimeCollected: lc, lifetimeMaintCost: lm, lifetimeNet: lc - (feeNum*months) - lm, lifetimePlatformFees: feeNum*months, settledCount: parseInt(ps && ps.settled_count || 0), failedCount: parseInt(ps && ps.failed_count || 0), totalRequests: parseInt(ms && ms.total_requests || 0) } })
  } catch (e) { next(e) }
})

// ── UNIT TYPE + SHORT-TERM CONFIG ─────────────────────────────

const LEASE_TYPE_MATRIX: Record<string, string[]> = {
  residential:     ['month_to_month', 'long_term'],
  rv_spot:         ['nightly', 'weekly', 'month_to_month', 'long_term'],
  storage:         ['month_to_month', 'long_term'],
  parking:         ['nightly', 'weekly', 'month_to_month', 'long_term'],
  short_term_cabin:['nightly', 'weekly', 'month_to_month'],
}

// PATCH /api/units/:id/type — set unit type and rates
unitsRouter.patch('/:id/type', requireLandlord, async (req, res, next) => {
  try {
    const { unitType, nightlyRate, weeklyRate, monthlyRate, minStayNights, maxStayNights,
            checkInTime, checkOutTime, amenities, unitDescription, isBookable } = req.body

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')

    const leaseTypesAllowed = LEASE_TYPE_MATRIX[unitType] || LEASE_TYPE_MATRIX['residential']

    const updated = await queryOne<any>(`UPDATE units SET
      unit_type=$1, lease_types_allowed=$2, nightly_rate=$3, weekly_rate=$4, monthly_rate=$5,
      min_stay_nights=$6, max_stay_nights=$7, check_in_time=$8, check_out_time=$9,
      amenities=$10, unit_description=$11, is_bookable=$12, updated_at=NOW()
      WHERE id=$13 RETURNING *`,
      [unitType||'residential', leaseTypesAllowed, nightlyRate||null, weeklyRate||null,
       monthlyRate||null, minStayNights||1, maxStayNights||null,
       checkInTime||'15:00', checkOutTime||'11:00',
       amenities||[], unitDescription||null, isBookable??false, unit.id])

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/units/:id/availability — get booked dates
unitsRouter.get('/:id/availability', async (req, res, next) => {
  try {
    const { from, to } = req.query
    const fromDate = from || new Date().toISOString().split('T')[0]
    const toDate = to || new Date(Date.now() + 90*24*60*60*1000).toISOString().split('T')[0]

    const bookings = await query<any>(`
      SELECT id, check_in, check_out, status, lease_type, guest_name
      FROM unit_bookings
      WHERE unit_id=$1 AND status NOT IN ('cancelled') AND check_out >= $2 AND check_in <= $3
      ORDER BY check_in`, [req.params.id, fromDate, toDate])

    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// POST /api/units/:id/bookings — create booking
unitsRouter.post('/:id/bookings', requireLandlord, async (req, res, next) => {
  try {
    const { guestName, guestEmail, guestPhone, leaseType, checkIn, checkOut,
            tenantId, nightlyRate, weeklyRate, totalAmount, notes, source } = req.body

    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')

    // Check allowed lease types
    if (unit.lease_types_allowed && !unit.lease_types_allowed.includes(leaseType)) {
      throw new AppError(400, `Lease type '${leaseType}' not allowed for ${unit.unit_type} units`)
    }

    // Check for conflicts
    const conflict = await queryOne<any>(`
      SELECT id FROM unit_bookings
      WHERE unit_id=$1 AND status NOT IN ('cancelled')
      AND check_in < $2 AND check_out > $3`,
      [unit.id, checkOut, checkIn])
    if (conflict) throw new AppError(409, 'Unit is already booked for those dates')

    const nights = Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000*60*60*24))
    const platformFee = (totalAmount || 0) * 0.05 // 5% platform fee on short-term

    const booking = await queryOne<any>(`INSERT INTO unit_bookings
      (unit_id, landlord_id, tenant_id, guest_name, guest_email, guest_phone,
       lease_type, check_in, check_out, nights, nightly_rate, weekly_rate,
       total_amount, platform_fee, notes, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [unit.id, req.user!.profileId, tenantId||null, guestName||null, guestEmail||null,
       guestPhone||null, leaseType, checkIn, checkOut, nights,
       nightlyRate||unit.nightly_rate||null, weeklyRate||unit.weekly_rate||null,
       totalAmount||0, platformFee, notes||null, source||'direct'])

    res.status(201).json({ success: true, data: booking })
  } catch (e) { next(e) }
})

// GET /api/units/:id/bookings — list bookings for a unit
unitsRouter.get('/:id/bookings', requireLandlord, async (req, res, next) => {
  try {
    const bookings = await query<any>(`
      SELECT b.*, u.unit_number, u.unit_type
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      WHERE b.unit_id=$1 AND b.landlord_id=$2
      ORDER BY b.check_in DESC`, [req.params.id, req.user!.profileId])
    res.json({ success: true, data: bookings })
  } catch (e) { next(e) }
})

// PATCH /api/units/:id/bookings/:bookingId — update booking (status, move dates, swap unit)
unitsRouter.patch('/:id/bookings/:bookingId', requireLandlord, async (req, res, next) => {
  try {
    const { status, notes, checkIn, checkOut, unitId } = req.body
    const booking = await queryOne<any>('SELECT * FROM unit_bookings WHERE id=$1 AND landlord_id=$2', [req.params.bookingId, req.user!.profileId])
    if (!booking) throw new AppError(404, 'Booking not found')

    const newUnitId = unitId || booking.unit_id
    const newCheckIn = checkIn || booking.check_in
    const newCheckOut = checkOut || booking.check_out

    // If dates or unit changed, verify target unit exists and check for conflicts
    if (checkIn || checkOut || unitId) {
      const targetUnit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [newUnitId, req.user!.profileId])
      if (!targetUnit) throw new AppError(404, 'Target unit not found')

      const conflict = await queryOne<any>(`
        SELECT id FROM unit_bookings
        WHERE unit_id=$1 AND id != $2 AND status NOT IN ('cancelled')
        AND check_in < $3 AND check_out > $4`,
        [newUnitId, booking.id, newCheckOut, newCheckIn])
      if (conflict) throw new AppError(409, 'Unit already booked for those dates')
    }

    const nights = Math.ceil((new Date(newCheckOut).getTime() - new Date(newCheckIn).getTime()) / (1000*60*60*24))

    const updated = await queryOne<any>(`
      UPDATE unit_bookings
      SET status=COALESCE($1,status), notes=COALESCE($2,notes),
          unit_id=$3, check_in=$4, check_out=$5, nights=$6, updated_at=NOW()
      WHERE id=$7 RETURNING *`,
      [status||null, notes||null, newUnitId, newCheckIn, newCheckOut, nights, booking.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// GET /api/units/schedule — master schedule across all units for a landlord
unitsRouter.get('/schedule/master', requireLandlord, async (req, res, next) => {
  try {
    const { from, to, unitType } = req.query
    const fromDate = from || new Date().toISOString().split('T')[0]
    const toDate = to || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0]

    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.unit_type, u.status, u.rent_amount,
        u.nightly_rate, u.weekly_rate, u.is_bookable, u.lease_types_allowed,
        u.check_in_time, u.check_out_time, u.amenities, u.unit_description,
        p.name as property_name,
        vuo.primary_first_name as tenant_first,
        vuo.primary_last_name as tenant_last
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.landlord_id=$1 ${unitType ? "AND u.unit_type=$2" : ""}
      ORDER BY u.unit_type, p.name, u.unit_number`,
      unitType ? [req.user!.profileId, unitType] : [req.user!.profileId])

    // Get all bookings in range
    const bookings = await query<any>(`
      SELECT b.*, u.unit_number, u.unit_type, p.name as property_name
      FROM unit_bookings b
      JOIN units u ON u.id = b.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE b.landlord_id=$1 AND b.status NOT IN ('cancelled')
        AND b.check_out >= $2 AND b.check_in <= $3
      ORDER BY b.check_in`, [req.user!.profileId, fromDate, toDate])

    // Get active leases in range
    const leases = await query<any>(`
      SELECT l.*, u.unit_number, u.unit_type, p.name as property_name,
        vlat.first_name, vlat.last_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN LATERAL (
        SELECT first_name, last_name
        FROM v_lease_active_tenants
        WHERE lease_id = l.id AND role = 'primary'
        LIMIT 1
      ) vlat ON TRUE
      WHERE u.landlord_id=$1 AND l.status='active'
        AND l.end_date >= $2 AND l.start_date <= $3
      ORDER BY l.start_date`, [req.user!.profileId, fromDate, toDate])

    res.json({ success: true, data: { units, bookings, leases, range: { from: fromDate, to: toDate } } })
  } catch (e) { next(e) }
})


// ─── UNIT ACTIVATION / AVAILABILITY (landlord-controlled) ──────

// POST /api/units/:id/mark-available — vacant → available (listed, no billing yet)
unitsRouter.post('/:id/mark-available', requireLandlord, async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.status !== 'vacant') throw new AppError(400, `Cannot mark available from status '${unit.status}'. Only vacant units can be marked available.`)
    const updated = await queryOne<any>(`UPDATE units SET status='available', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/mark-vacant — available → vacant (withdraw from listing)
unitsRouter.post('/:id/mark-vacant', requireLandlord, async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.status !== 'available') throw new AppError(400, `Cannot mark vacant from status '${unit.status}'. Only available units can be marked vacant.`)
    const updated = await queryOne<any>(`UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/units/:id/activate — gate: lease + tenant + rent. Optional scheduledFor ISO datetime (UTC).
unitsRouter.post('/:id/activate', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({ scheduledFor: z.string().datetime().optional() }).parse(req.body)
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (unit.status === 'active') throw new AppError(400, 'Unit is already active')
    if (!unit.rent_amount || unit.rent_amount <= 0) throw new AppError(400, 'Cannot activate without a rent amount')

    const activeLease = await queryOne<any>(`SELECT id FROM leases WHERE unit_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [req.params.id])
    if (!activeLease) throw new AppError(400, 'Cannot activate without an active lease')

    if (body.scheduledFor) {
      const when = new Date(body.scheduledFor)
      if (isNaN(when.getTime())) throw new AppError(400, 'Invalid scheduledFor datetime')
      if (when.getTime() <= Date.now()) throw new AppError(400, 'scheduledFor must be in the future')
      const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=$1, scheduled_activation_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [when, req.user!.userId, req.params.id])
      return res.json({ success: true, data: updated, scheduled: true })
    }

    // Immediate activation
    const updated = await queryOne<any>(`UPDATE units SET status='active', scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated, scheduled: false })
  } catch (e) { next(e) }
})

// POST /api/units/:id/cancel-scheduled-activation
unitsRouter.post('/:id/cancel-scheduled-activation', requireLandlord, async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!unit.scheduled_activation_at) throw new AppError(400, 'No scheduled activation to cancel')
    const updated = await queryOne<any>(`UPDATE units SET scheduled_activation_at=NULL, scheduled_activation_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
