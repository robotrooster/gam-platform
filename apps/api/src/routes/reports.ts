import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordIdForUser } from '../lib/scope'

export const reportsRouter = Router()
// S127: blanket requireLandlord lifted in favor of per-route perm gates.
// All reports require auth; specific perms gate per endpoint below.
// Owners auto-pass requirePerm via OWNER_ROLES short-circuit.
reportsRouter.use(requireAuth)

// Helper — get month date range
function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 0, 23, 59, 59)
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── SUMMARY (S69) ─────────────────────────────────────────────
// GET /api/reports/summary
// Backs the landlord ReportsPage. Per-landlord scoped (admin/super_admin
// see the whole platform).
//
// Returns:
//   collectedMtd     — sum of settled rent payments this calendar month
//   outstanding      — sum of unsettled invoice amounts (pending + partial)
//   occupancyRate    — round(100 × active / total) across landlord's units
//   monthly[]        — last 6 months: collected, disbursed, fees, net
//   ownerVsManager   — split of landlord's manager_fee vs owner_share
//                      ledger entries this month (16a)
reportsRouter.get('/summary', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const landlordId = isAdmin ? null : resolveLandlordIdForUser(req.user!)
    const userId = req.user!.userId
    if (!isAdmin && !landlordId) throw new AppError(400, 'No landlord scope on this user')

    const monthlyRows = isAdmin
      ? await query<any>(`
          SELECT to_char(date_trunc('month', settled_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS collected
            FROM payments
           WHERE status='settled' AND type='rent'
             AND settled_at > NOW() - INTERVAL '6 months'
           GROUP BY 1 ORDER BY 1 DESC
        `)
      : await query<any>(`
          SELECT to_char(date_trunc('month', settled_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS collected
            FROM payments
           WHERE landlord_id=$1 AND status='settled' AND type='rent'
             AND settled_at > NOW() - INTERVAL '6 months'
           GROUP BY 1 ORDER BY 1 DESC
        `, [landlordId])

    const disbursementRows = isAdmin
      ? await query<any>(`
          SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS disbursed,
                 SUM(fee_charged)::numeric AS fees
            FROM disbursements
           WHERE created_at > NOW() - INTERVAL '6 months'
             AND status IN ('pending', 'processing', 'settled')
           GROUP BY 1
        `)
      : await query<any>(`
          SELECT to_char(date_trunc('month', d.created_at), 'YYYY-MM') AS month,
                 SUM(d.amount)::numeric AS disbursed,
                 SUM(d.fee_charged)::numeric AS fees
            FROM disbursements d
           WHERE d.user_id = $1
             AND d.created_at > NOW() - INTERVAL '6 months'
             AND d.status IN ('pending', 'processing', 'settled')
           GROUP BY 1
        `, [userId])

    const monthlyMap = new Map<string, { collected: number; disbursed: number; fees: number }>()
    for (const r of monthlyRows) {
      monthlyMap.set(r.month, {
        collected: parseFloat(r.collected ?? '0'),
        disbursed: 0,
        fees: 0,
      })
    }
    for (const r of disbursementRows) {
      const existing = monthlyMap.get(r.month) ?? { collected: 0, disbursed: 0, fees: 0 }
      existing.disbursed = parseFloat(r.disbursed ?? '0')
      existing.fees = parseFloat(r.fees ?? '0')
      monthlyMap.set(r.month, existing)
    }
    const monthly = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 6)
      .map(([month, v]) => ({
        month,
        collected: v.collected,
        disbursed: v.disbursed,
        fees: v.fees,
        net: round2(v.collected - v.fees),
      }))

    const collectedMtdRow = isAdmin
      ? await queryOne<any>(`
          SELECT COALESCE(SUM(amount), 0)::numeric AS amount
            FROM payments
           WHERE status='settled' AND type='rent'
             AND settled_at >= date_trunc('month', NOW())
        `)
      : await queryOne<any>(`
          SELECT COALESCE(SUM(amount), 0)::numeric AS amount
            FROM payments
           WHERE landlord_id=$1 AND status='settled' AND type='rent'
             AND settled_at >= date_trunc('month', NOW())
        `, [landlordId])
    const collectedMtd = parseFloat(collectedMtdRow?.amount ?? '0')

    // Outstanding = invoice total minus settled payments matched to that invoice.
    // pending|partial invoices only — settled invoices net to zero.
    const outstandingRow = isAdmin
      ? await queryOne<any>(`
          SELECT COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0)::numeric AS amount
            FROM invoices i
            LEFT JOIN (
              SELECT invoice_id, SUM(amount) AS paid
                FROM payments WHERE status='settled' AND invoice_id IS NOT NULL
               GROUP BY invoice_id
            ) p ON p.invoice_id = i.id
           WHERE i.status IN ('pending', 'partial')
        `)
      : await queryOne<any>(`
          SELECT COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0)::numeric AS amount
            FROM invoices i
            LEFT JOIN (
              SELECT invoice_id, SUM(amount) AS paid
                FROM payments WHERE status='settled' AND invoice_id IS NOT NULL
               GROUP BY invoice_id
            ) p ON p.invoice_id = i.id
           WHERE i.landlord_id = $1 AND i.status IN ('pending', 'partial')
        `, [landlordId])
    const outstanding = parseFloat(outstandingRow?.amount ?? '0')

    const occRow = isAdmin
      ? await queryOne<any>(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='active')::int AS active
          FROM units
        `)
      : await queryOne<any>(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='active')::int AS active
          FROM units WHERE landlord_id = $1
        `, [landlordId])
    const total = parseInt(occRow?.total ?? '0', 10)
    const active = parseInt(occRow?.active ?? '0', 10)
    const occupancyRate = total > 0 ? Math.round(100 * active / total) : 0

    // 16a owner-vs-manager split for the calling user, this calendar month.
    // Both columns sum to "what hit my ledger this month".
    const splitRow = await queryOne<any>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type='allocation_owner_share'), 0)::numeric AS owner_share,
        COALESCE(SUM(amount) FILTER (WHERE type='allocation_manager_fee'), 0)::numeric AS manager_fee
      FROM user_balance_ledger
      WHERE user_id = $1
        AND created_at >= date_trunc('month', NOW())
    `, [userId])

    res.json({ success: true, data: {
      collectedMtd,
      outstanding,
      occupancyRate,
      occupiedUnits: active,
      totalUnits: total,
      monthly,
      ownerVsManager: {
        ownerShare: parseFloat(splitRow?.owner_share ?? '0'),
        managerFee: parseFloat(splitRow?.manager_fee ?? '0'),
      },
    } })
  } catch (e) { next(e) }
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── MONTHLY OWNER STATEMENT ───────────────────────────────────
reportsRouter.get('/monthly-statement', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = parseInt(req.query.month as string) || new Date().getMonth()
    const { start, end } = monthRange(year, month)
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    // Landlord info
    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone
      FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). landlords
    // never had pm_company_id / pm_fee_plan_id columns and the pm_companies
    // / pm_fee_plans tables don't exist. Response shape preserves the
    // pmInfo / pmPlan keys as null so the frontend doesn't break.
    const pmInfo = null
    const pmPlan = null

    // Properties with units
    const properties = await query<any>(`
      SELECT p.*, COUNT(u.id) as total_units,
        COUNT(u.id) FILTER (WHERE vuo.is_occupied) as occupied_units
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE p.landlord_id = $1
      GROUP BY p.id ORDER BY p.name`, [landlordId])

    // Unit detail for the month
    const units = await query<any>(`
      SELECT u.*, p.name as property_name,
        vuo.primary_first_name as tenant_first,
        vuo.primary_last_name as tenant_last,
        vuo.primary_email as tenant_email,
        vuo.is_occupied
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
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

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmFee
    // always 0 in the response; field preserved so the frontend doesn't
    // need a shape change.
    const pmFee = 0

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
          occupiedUnits:  units.filter((u:any) => u.is_occupied).length,
          vacantUnits:    units.filter((u:any) => !u.is_occupied).length,
          settledPayments: payments.filter((p:any) => p.status === 'settled').length,
          latePayments:    payments.filter((p:any) => p.status === 'late').length,
          failedPayments:  payments.filter((p:any) => p.status === 'failed').length,
        }
      }
    })
  } catch (e) { next(e) }
})

// ── ANNUAL TAX SUMMARY ────────────────────────────────────────
reportsRouter.get('/tax-summary', requirePerm('books.view'), async (req, res, next) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear()
    const start = `${year}-01-01`
    const end   = `${year}-12-31`
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

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

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmInfo
    // preserved as null in the response shape.
    const pmInfo = null

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
      FROM units WHERE landlord_id=$1 AND id IN (
        SELECT unit_id FROM v_unit_occupancy WHERE is_occupied
      )`, [landlordId])

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
reportsRouter.get('/property-pl', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = req.query.month ? parseInt(req.query.month as string) : null
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')
    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? new Date(year, month, 0).toISOString().split('T')[0] : `${year}-12-31`

    const properties = await query<any>(`
      SELECT p.*,
        COUNT(DISTINCT u.id) as total_units,
        COUNT(DISTINCT u.id) FILTER (WHERE vuo.is_occupied) as occupied_units,
        COALESCE(SUM(pm.amount) FILTER (WHERE pm.status='settled' AND pm.due_date >= $2 AND pm.due_date <= $3), 0) as rent_collected,
        COALESCE(SUM(mr.actual_cost) FILTER (WHERE mr.completed_at >= $2 AND mr.completed_at <= $3), 0) as maint_cost,
        COALESCE(SUM(mr.platform_fee) FILTER (WHERE mr.completed_at >= $2 AND mr.completed_at <= $3), 0) as maint_fees
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
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

// ── WORK TRADE 1099 SUMMARY ───────────────────────────────────
reportsRouter.get('/work-trade-1099', requirePerm('books.view'), async (req, res, next) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear()
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, l.ein
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [landlordId])

    // S408 fix: pre-fix SELECTed `t.ein as tenant_ein`, but tenants table
    // has no ein column (it exists on landlords + pm_companies +
    // books_contractors only). Route always 500'd with 42703 — the
    // 1099 work-trade summary surface was completely dead in production.
    // Surgical fix: drop the broken SELECT. Tenant TIN storage is a
    // separate hygiene item; nowhere to capture it today, so we can't
    // return it even if we wanted to.
    const agreements = await query<any>(`
      SELECT wta.*,
        u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last,
        us.email as tenant_email
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
