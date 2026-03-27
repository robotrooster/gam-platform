import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const reportsRouter = Router()
reportsRouter.use(requireAuth, requireLandlord)

// Helper — get month date range
function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 0, 23, 59, 59)
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── MONTHLY OWNER STATEMENT ───────────────────────────────────
reportsRouter.get('/monthly-statement', async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = parseInt(req.query.month as string) || new Date().getMonth()
    const { start, end } = monthRange(year, month)
    const landlordId = req.user!.profileId

    // Landlord info
    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone
      FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

    // PM info if applicable
    const pmInfo = landlord?.pm_company_id ? await queryOne<any>(
      'SELECT * FROM pm_companies WHERE id=$1', [landlord.pm_company_id]) : null
    const pmPlan = landlord?.pm_fee_plan_id ? await queryOne<any>(
      'SELECT * FROM pm_fee_plans WHERE id=$1', [landlord.pm_fee_plan_id]) : null

    // Properties with units
    const properties = await query<any>(`
      SELECT p.*, COUNT(u.id) as total_units,
        COUNT(u.id) FILTER (WHERE u.tenant_id IS NOT NULL) as occupied_units
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      WHERE p.landlord_id = $1
      GROUP BY p.id ORDER BY p.name`, [landlordId])

    // Unit detail for the month
    const units = await query<any>(`
      SELECT u.*, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last,
        us.email as tenant_email
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN tenants t ON t.id = u.tenant_id
      LEFT JOIN users us ON us.id = t.user_id
      WHERE u.landlord_id = $1
      ORDER BY p.name, u.unit_number`, [landlordId])

    // Payments for the month
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN users us ON us.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.due_date >= $2 AND p.due_date <= $3
      ORDER BY pr.name, u.unit_number`, [landlordId, start, end])

    // Maintenance costs for the month
    const maintenance = await query<any>(`
      SELECT mr.*, u.unit_number, p.name as property_name
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE mr.landlord_id = $1
        AND mr.completed_at >= $2 AND mr.completed_at <= $3
        AND mr.actual_cost IS NOT NULL
      ORDER BY p.name, u.unit_number`, [landlordId, start, end])

    // Work trade this month
    const workTrade = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id = $1 AND wta.status = 'active'`, [landlordId])

    // Disbursements for the month
    const disbursements = await query<any>(`
      SELECT * FROM disbursements
      WHERE landlord_id = $1
        AND created_at >= $2 AND created_at <= $3
      ORDER BY created_at DESC`, [landlordId, start, end])

    // Calculations
    const totalCollected   = payments.filter((p:any) => p.status === 'settled').reduce((s:number, p:any) => s + parseFloat(p.amount||0), 0)
    const totalPlatformFees = units.filter((u:any) => u.status !== 'vacant').length * 15
    const totalMaintCost   = maintenance.reduce((s:number, m:any) => s + parseFloat(m.actual_cost||0), 0)
    const totalMaintFees   = maintenance.reduce((s:number, m:any) => s + parseFloat(m.platform_fee||0), 0)

    // PM fees
    let pmFee = 0
    if (pmPlan) {
      if (pmPlan.fee_type === 'percent') pmFee = totalCollected * (parseFloat(pmPlan.percent_rate) / 100)
      else if (pmPlan.fee_type === 'flat') pmFee = units.filter((u:any) => u.tenant_id).length * parseFloat(pmPlan.flat_amount)
      else if (pmPlan.fee_type === 'hybrid') {
        pmFee = (totalCollected * (parseFloat(pmPlan.percent_rate) / 100))
              + (units.filter((u:any) => u.tenant_id).length * parseFloat(pmPlan.flat_amount))
      }
    }

    const netToOwner = totalCollected - totalPlatformFees - totalMaintCost - totalMaintFees - pmFee

    res.json({
      success: true,
      data: {
        period: { year, month, start, end },
        landlord, pmInfo, pmPlan,
        properties, units, payments, maintenance, workTrade, disbursements,
        summary: {
          totalCollected, totalPlatformFees, totalMaintCost,
          totalMaintFees, pmFee, netToOwner,
          occupiedUnits:  units.filter((u:any) => u.tenant_id).length,
          vacantUnits:    units.filter((u:any) => !u.tenant_id).length,
          settledPayments: payments.filter((p:any) => p.status === 'settled').length,
          latePayments:    payments.filter((p:any) => p.status === 'late').length,
          failedPayments:  payments.filter((p:any) => p.status === 'failed').length,
        }
      }
    })
  } catch (e) { next(e) }
})

// ── ANNUAL TAX SUMMARY ────────────────────────────────────────
reportsRouter.get('/tax-summary', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear()
    const start = `${year}-01-01`
    const end   = `${year}-12-31`
    const landlordId = req.user!.profileId

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email
      FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

    // Total rent collected
    const rentStats = await queryOne<any>(`
      SELECT COALESCE(SUM(amount) FILTER (WHERE status='settled'), 0) as total_rent,
        COUNT(*) FILTER (WHERE status='settled') as payment_count
      FROM payments
      WHERE landlord_id=$1 AND due_date >= $2 AND due_date <= $3`,
      [landlordId, start, end])

    // Platform fees paid
    const platformFeeStats = await queryOne<any>(`
      SELECT COUNT(*) FILTER (WHERE status != 'vacant') * 15 as total_platform_fees
      FROM units WHERE landlord_id=$1`, [landlordId])

    // Maintenance expenses
    const maintStats = await queryOne<any>(`
      SELECT COALESCE(SUM(actual_cost), 0) as total_maint_cost,
        COALESCE(SUM(platform_fee), 0) as total_maint_fees,
        COUNT(*) as request_count
      FROM maintenance_requests
      WHERE landlord_id=$1 AND completed_at >= $2 AND completed_at <= $3`,
      [landlordId, start, end])

    // PM fees
    const pmInfo = landlord?.pm_company_id ? await queryOne<any>(
      'SELECT pc.*, fp.name as plan_name, fp.fee_type, fp.percent_rate, fp.flat_amount FROM pm_companies pc LEFT JOIN pm_fee_plans fp ON fp.id=$2 WHERE pc.id=$1',
      [landlord.pm_company_id, landlord.pm_fee_plan_id]) : null

    // Work trade — 1099 eligible
    const workTradeStats = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last, us.email as tenant_email
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1 AND wta.tax_year=$2`,
      [landlordId, year])

    // Security deposits held
    const depositStats = await queryOne<any>(`
      SELECT COALESCE(SUM(security_deposit), 0) as total_deposits
      FROM units WHERE landlord_id=$1 AND tenant_id IS NOT NULL`, [landlordId])

    // Monthly breakdown
    const monthlyBreakdown = await query<any>(`
      SELECT EXTRACT(MONTH FROM due_date)::int as month,
        COALESCE(SUM(amount) FILTER (WHERE status='settled'), 0) as collected,
        COUNT(*) FILTER (WHERE status='settled') as paid,
        COUNT(*) FILTER (WHERE status='failed') as failed
      FROM payments
      WHERE landlord_id=$1 AND due_date >= $2 AND due_date <= $3
      GROUP BY month ORDER BY month`,
      [landlordId, start, end])

    const totalRent   = parseFloat(rentStats?.total_rent || 0)
    const totalMaint  = parseFloat(maintStats?.total_maint_cost || 0)
    const maintFees   = parseFloat(maintStats?.total_maint_fees || 0)
    const workTradeVal = workTradeStats.reduce((s:number, w:any) => s + parseFloat(w.ytd_value||0), 0)

    res.json({
      success: true,
      data: {
        year, landlord, pmInfo,
        income: {
          totalRent,
          paymentCount: parseInt(rentStats?.payment_count || 0),
        },
        deductions: {
          platformFees:  parseInt(platformFeeStats?.total_platform_fees || 0),
          maintExpenses: totalMaint,
          maintFees,
          workTradeValue: workTradeVal,
        },
        deposits: {
          totalHeld: parseFloat(depositStats?.total_deposits || 0),
        },
        workTrade: workTradeStats,
        monthlyBreakdown,
        netIncome: totalRent - totalMaint - maintFees,
        w2099Threshold: workTradeStats.filter((w:any) => parseFloat(w.ytd_value||0) >= 600),
      }
    })
  } catch (e) { next(e) }
})

// ── PER-PROPERTY P&L ──────────────────────────────────────────
reportsRouter.get('/property-pl', async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = req.query.month ? parseInt(req.query.month as string) : null
    const landlordId = req.user!.profileId
    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? new Date(year, month, 0).toISOString().split('T')[0] : `${year}-12-31`

    const properties = await query<any>(`
      SELECT p.*,
        COUNT(DISTINCT u.id) as total_units,
        COUNT(DISTINCT u.id) FILTER (WHERE u.tenant_id IS NOT NULL) as occupied_units,
        COALESCE(SUM(pm.amount) FILTER (WHERE pm.status='settled' AND pm.due_date >= $2 AND pm.due_date <= $3), 0) as rent_collected,
        COALESCE(SUM(mr.actual_cost) FILTER (WHERE mr.completed_at >= $2 AND mr.completed_at <= $3), 0) as maint_cost,
        COALESCE(SUM(mr.platform_fee) FILTER (WHERE mr.completed_at >= $2 AND mr.completed_at <= $3), 0) as maint_fees
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN payments pm ON pm.unit_id = u.id
      LEFT JOIN maintenance_requests mr ON mr.unit_id = u.id
      WHERE p.landlord_id = $1
      GROUP BY p.id ORDER BY p.name`,
      [landlordId, start, end])

    const result = properties.map((p:any) => {
      const rent     = parseFloat(p.rent_collected || 0)
      const maint    = parseFloat(p.maint_cost || 0)
      const maintFee = parseFloat(p.maint_fees || 0)
      const platFee  = parseInt(p.occupied_units || 0) * (month ? 15 : 15*12)
      const netIncome = rent - maint - maintFee - platFee
      const maxRent  = 0 // Would need units sum
      return { ...p, rent_collected: rent, maint_cost: maint, maint_fees: maintFee,
        platform_fees: platFee, net_income: netIncome,
        occupancy_rate: parseInt(p.total_units||0) > 0
          ? Math.round((parseInt(p.occupied_units||0) / parseInt(p.total_units||0)) * 100) : 0 }
    })

    res.json({ success: true, data: { year, month, period: { start, end }, properties: result } })
  } catch (e) { next(e) }
})

// ── PM CLIENT REPORT ──────────────────────────────────────────
reportsRouter.get('/pm-client', async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = parseInt(req.query.month as string) || new Date().getMonth()
    const { start, end } = monthRange(year, month)
    const landlordId = req.user!.profileId

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, pc.name as pm_name, pc.access_code,
        fp.name as plan_name, fp.fee_type, fp.percent_rate, fp.flat_amount
      FROM landlords l JOIN users u ON u.id = l.user_id
      LEFT JOIN pm_companies pc ON pc.id = l.pm_company_id
      LEFT JOIN pm_fee_plans fp ON fp.id = l.pm_fee_plan_id
      WHERE l.id = $1`, [landlordId])

    if (!landlord?.pm_company_id) throw new AppError(400, 'Not connected to a PM company')

    const properties = await query<any>(`
      SELECT p.*,
        COUNT(DISTINCT u.id) as total_units,
        COUNT(DISTINCT u.id) FILTER (WHERE u.tenant_id IS NOT NULL) as occupied,
        COALESCE(SUM(pm.amount) FILTER (WHERE pm.status='settled'), 0) as rent_collected
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN payments pm ON pm.unit_id = u.id AND pm.due_date >= $2 AND pm.due_date <= $3
      WHERE p.landlord_id = $1
      GROUP BY p.id ORDER BY p.name`, [landlordId, start, end])

    const totalCollected = properties.reduce((s:number, p:any) => s + parseFloat(p.rent_collected||0), 0)
    const totalUnits     = properties.reduce((s:number, p:any) => s + parseInt(p.total_units||0), 0)
    const totalOccupied  = properties.reduce((s:number, p:any) => s + parseInt(p.occupied||0), 0)

    let pmFee = 0
    if (landlord.fee_type === 'percent') pmFee = totalCollected * (parseFloat(landlord.percent_rate||0) / 100)
    else if (landlord.fee_type === 'flat') pmFee = totalOccupied * parseFloat(landlord.flat_amount||0)
    else if (landlord.fee_type === 'hybrid') {
      pmFee = (totalCollected * (parseFloat(landlord.percent_rate||0) / 100))
            + (totalOccupied * parseFloat(landlord.flat_amount||0))
    }

    res.json({
      success: true,
      data: { year, month, landlord, properties,
        summary: { totalCollected, totalUnits, totalOccupied, pmFee,
          netToOwner: totalCollected - pmFee,
          occupancyRate: totalUnits > 0 ? Math.round((totalOccupied/totalUnits)*100) : 0 }
      }
    })
  } catch (e) { next(e) }
})

// ── WORK TRADE 1099 SUMMARY ───────────────────────────────────
reportsRouter.get('/work-trade-1099', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear()
    const landlordId = req.user!.profileId

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, l.ein
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [landlordId])

    const agreements = await query<any>(`
      SELECT wta.*,
        u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last,
        us.email as tenant_email,
        t.ein as tenant_ein
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1 AND wta.tax_year=$2
      ORDER BY us.last_name, us.first_name`,
      [landlordId, year])

    const eligible   = agreements.filter((a:any) => parseFloat(a.ytd_value||0) >= 600)
    const totalValue = agreements.reduce((s:number, a:any) => s + parseFloat(a.ytd_value||0), 0)

    res.json({
      success: true,
      data: { year, landlord, agreements, eligible,
        summary: { totalAgreements: agreements.length, eligible1099Count: eligible.length, totalValue } }
    })
  } catch (e) { next(e) }
})
