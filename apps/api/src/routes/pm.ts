import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import crypto from 'crypto'

export const pmRouter = Router()

// ── PM COMPANY SELF-REGISTRATION ──────────────────────────────

// POST /api/pm/companies — create PM company (any authenticated user)
pmRouter.post('/companies', requireAuth, async (req, res, next) => {
  try {
    const { name, contactName, email, phone, website } = req.body
    if (!name) throw new AppError(400, 'Company name required')

    const accessCode  = crypto.randomBytes(4).toString('hex').toUpperCase()
    const reportToken = crypto.randomBytes(24).toString('hex')

    const company = await queryOne<any>(`
      INSERT INTO pm_companies (name, contact_name, email, phone, website, access_code, report_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, contactName||null, email||null, phone||null, website||null, accessCode, reportToken])

    res.status(201).json({ success: true, data: company })
  } catch (e) { next(e) }
})

// GET /api/pm/companies/:id — get PM company
pmRouter.get('/companies/:id', requireAuth, async (req, res, next) => {
  try {
    const company = await queryOne<any>('SELECT * FROM pm_companies WHERE id=$1', [req.params.id])
    if (!company) throw new AppError(404, 'Company not found')
    res.json({ success: true, data: company })
  } catch (e) { next(e) }
})

// GET /api/pm/companies/by-code/:code — look up PM company by access code
pmRouter.get('/companies/by-code/:code', async (req, res, next) => {
  try {
    const company = await queryOne<any>(
      'SELECT id, name, contact_name, email, website FROM pm_companies WHERE access_code=$1 AND is_active=TRUE',
      [req.params.code.toUpperCase()])
    if (!company) throw new AppError(404, 'No PM company found with that code')
    res.json({ success: true, data: company })
  } catch (e) { next(e) }
})

// ── FEE PLANS ────────────────────────────────────────────────

// GET /api/pm/companies/:id/plans
pmRouter.get('/companies/:id/plans', async (req, res, next) => {
  try {
    const plans = await query<any>(
      'SELECT * FROM pm_fee_plans WHERE pm_company_id=$1 AND is_active=TRUE ORDER BY name',
      [req.params.id])
    res.json({ success: true, data: plans })
  } catch (e) { next(e) }
})

// POST /api/pm/companies/:id/plans
pmRouter.post('/companies/:id/plans', requireAuth, async (req, res, next) => {
  try {
    const { name, feeType, percentRate, flatAmount, description } = req.body
    const plan = await queryOne<any>(`
      INSERT INTO pm_fee_plans (pm_company_id, name, fee_type, percent_rate, flat_amount, description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, name, feeType, percentRate||null, flatAmount||null, description||null])
    res.status(201).json({ success: true, data: plan })
  } catch (e) { next(e) }
})

// ── LANDLORD CONNECTION ────────────────────────────────────────

// POST /api/pm/connect — landlord connects to PM via access code
pmRouter.post('/connect', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { accessCode, feePlanId } = req.body
    const company = await queryOne<any>(
      'SELECT * FROM pm_companies WHERE access_code=$1 AND is_active=TRUE',
      [accessCode.toUpperCase()])
    if (!company) throw new AppError(404, 'Invalid access code')

    // Upsert connection
    const conn = await queryOne<any>(`
      INSERT INTO pm_landlord_connections (pm_company_id, landlord_id, fee_plan_id)
      VALUES ($1,$2,$3)
      ON CONFLICT (pm_company_id, landlord_id) DO UPDATE SET fee_plan_id=$3, status='active'
      RETURNING *`,
      [company.id, req.user!.profileId, feePlanId||null])

    // Update landlord record
    await query('UPDATE landlords SET management_type=$1, pm_company_id=$2, pm_fee_plan_id=$3 WHERE id=$4',
      ['pm', company.id, feePlanId||null, req.user!.profileId])

    res.json({ success: true, data: { connection: conn, company } })
  } catch (e) { next(e) }
})

// ── PM DASHBOARD ──────────────────────────────────────────────

// GET /api/pm/dashboard — PM company sees all managed properties
pmRouter.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    // Find PM company for this user (via landlord connection or direct)
    const pmCompany = await queryOne<any>(`
      SELECT pc.* FROM pm_companies pc
      JOIN pm_landlord_connections plc ON plc.pm_company_id = pc.id
      JOIN landlords l ON l.id = plc.landlord_id
      WHERE l.user_id = $1 AND pc.is_active = TRUE
      LIMIT 1`, [req.user!.userId])

    if (!pmCompany) throw new AppError(404, 'No PM company found for this account')

    // All landlords connected to this PM
    const landlords = await query<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email,
        plc.fee_plan_id, fp.name as plan_name, fp.fee_type,
        fp.percent_rate, fp.flat_amount,
        COUNT(DISTINCT p.id) as property_count,
        COUNT(DISTINCT un.id) as unit_count,
        COUNT(DISTINCT un.id) FILTER (WHERE vuo.is_occupied) as occupied_count,
        COALESCE(SUM(un.rent_amount) FILTER (WHERE vuo.is_occupied), 0) as collected_rent,
        COALESCE(SUM(un.rent_amount), 0) as max_rent
      FROM pm_landlord_connections plc
      JOIN landlords l ON l.id = plc.landlord_id
      JOIN users u ON u.id = l.user_id
      LEFT JOIN pm_fee_plans fp ON fp.id = plc.fee_plan_id
      LEFT JOIN properties p ON p.landlord_id = l.id
      LEFT JOIN units un ON un.property_id = p.id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = un.id
      WHERE plc.pm_company_id = $1 AND plc.status = 'active'
      GROUP BY l.id, u.first_name, u.last_name, u.email, plc.fee_plan_id,
        fp.name, fp.fee_type, fp.percent_rate, fp.flat_amount`,
      [pmCompany.id])

    // Calculate PM fees per landlord
    const withFees = landlords.map((l: any) => {
      const collectedRent = parseFloat(l.collected_rent || 0)
      const maxRent = parseFloat(l.max_rent || 0)
      let pmFee = 0
      if (l.fee_type === 'percent') {
        pmFee = collectedRent * (parseFloat(l.percent_rate || 0) / 100)
      } else if (l.fee_type === 'flat') {
        pmFee = parseInt(l.unit_count || 0) * parseFloat(l.flat_amount || 0)
      } else if (l.fee_type === 'hybrid') {
        pmFee = (collectedRent * (parseFloat(l.percent_rate || 0) / 100))
              + (parseInt(l.unit_count || 0) * parseFloat(l.flat_amount || 0))
      }
      return { ...l, pmFee: pmFee.toFixed(2) }
    })

    const totalPMRevenue = withFees.reduce((s: number, l: any) => s + parseFloat(l.pmFee), 0)
    const totalUnits     = withFees.reduce((s: number, l: any) => s + parseInt(l.unit_count || 0), 0)
    const totalOccupied  = withFees.reduce((s: number, l: any) => s + parseInt(l.occupied_count || 0), 0)
    const totalMaxRent   = withFees.reduce((s: number, l: any) => s + parseFloat(l.max_rent || 0), 0)

    res.json({
      success: true,
      data: {
        company: pmCompany,
        landlords: withFees,
        summary: { totalPMRevenue, totalUnits, totalOccupied, totalMaxRent,
          clientCount: withFees.length,
          occupancyRate: totalUnits > 0 ? Math.round((totalOccupied / totalUnits) * 100) : 0 }
      }
    })
  } catch (e) { next(e) }
})

// GET /api/pm/report/:token — public shareable report (no auth)
pmRouter.get('/report/:token', async (req, res, next) => {
  try {
    const company = await queryOne<any>(
      'SELECT * FROM pm_companies WHERE report_token=$1 AND is_active=TRUE',
      [req.params.token])
    if (!company) throw new AppError(404, 'Report not found')

    const summary = await queryOne<any>(`
      SELECT
        COUNT(DISTINCT plc.landlord_id) as client_count,
        COUNT(DISTINCT p.id) as property_count,
        COUNT(DISTINCT un.id) as unit_count,
        COUNT(DISTINCT un.id) FILTER (WHERE vuo.is_occupied) as occupied_count,
        COALESCE(SUM(un.rent_amount) FILTER (WHERE vuo.is_occupied), 0) as collected_rent,
        COALESCE(SUM(un.rent_amount), 0) as max_rent
      FROM pm_landlord_connections plc
      JOIN properties p ON p.landlord_id = plc.landlord_id
      JOIN units un ON un.property_id = p.id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = un.id
      WHERE plc.pm_company_id = $1 AND plc.status = 'active'`, [company.id])

    res.json({
      success: true,
      data: {
        company: { name: company.name, website: company.website },
        summary,
        generatedAt: new Date().toISOString()
      }
    })
  } catch (e) { next(e) }
})

// ── PM FEE CALCULATION HELPER ─────────────────────────────────

// GET /api/pm/landlord-fees — get PM fee info for logged-in landlord
pmRouter.get('/landlord-fees', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const landlord = await queryOne<any>(`
      SELECT l.*, pc.name as pm_name, pc.access_code,
        fp.name as plan_name, fp.fee_type, fp.percent_rate, fp.flat_amount
      FROM landlords l
      LEFT JOIN pm_companies pc ON pc.id = l.pm_company_id
      LEFT JOIN pm_fee_plans fp ON fp.id = l.pm_fee_plan_id
      WHERE l.id = $1`, [req.user!.profileId])

    res.json({ success: true, data: landlord })
  } catch (e) { next(e) }
})
