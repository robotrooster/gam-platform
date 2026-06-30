import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordIdForUser } from '../lib/scope'
import { platformFeesByProperty, periodMonths } from '../services/platformFee'

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

function round2(n: number): number {
  return Math.round(n * 100) / 100
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

    // YTD: settled rent collected per calendar month for the current year, so
    // the Overview can chart MTD-in-context + the YTD trend without a second
    // call. Same payments.view_all scope as the rest of /summary.
    const ytdRows = isAdmin
      ? await query<any>(`
          SELECT to_char(date_trunc('month', settled_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS collected
            FROM payments
           WHERE status='settled' AND type='rent'
             AND settled_at >= date_trunc('year', NOW())
           GROUP BY 1 ORDER BY 1
        `)
      : await query<any>(`
          SELECT to_char(date_trunc('month', settled_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS collected
            FROM payments
           WHERE landlord_id=$1 AND status='settled' AND type='rent'
             AND settled_at >= date_trunc('year', NOW())
           GROUP BY 1 ORDER BY 1
        `, [landlordId])
    const ytdMonthly = ytdRows.map((r: any) => ({ month: r.month, collected: parseFloat(r.collected ?? '0') }))
    const ytdCollected = round2(ytdMonthly.reduce((s: number, m: any) => s + m.collected, 0))

    res.json({ success: true, data: {
      collectedMtd,
      ytdCollected,
      outstanding,
      occupancyRate,
      occupiedUnits: active,
      totalUnits: total,
      monthly,
      ytdMonthly,
      ownerVsManager: {
        ownerShare: parseFloat(splitRow?.owner_share ?? '0'),
        managerFee: parseFloat(splitRow?.manager_fee ?? '0'),
      },
    } })
  } catch (e) { next(e) }
})

// ── MONTHLY P&L DRILL-IN (S512 #20) ───────────────────────────
// GET /api/reports/monthly-pl?year=YYYY&month=M
// Backs the clickable drill-in on the landlord ReportsPage monthly
// table. Where /summary gives the 6-month roll-up, this returns one
// month's profit-and-loss with the ACTUAL-PAYMENT-DATE breakdown:
//   gross     — settled income recognized by settled_at (rent + other)
//   expenses  — GAM platform fee (actual billed income via
//               platformFeesByProperty), maintenance actual cost, and the
//               8% maintenance platform fee
//   net       — gross.total − expenses.total
//   payments[] — every settled payment whose settled_at lands in the
//               month, newest first, with the real payment date, method
//               (ACH vs card, inferred from the rail columns), tenant,
//               unit + property. The frontend groups these by day.
// Scoped per-landlord (resolveLandlordIdForUser), mirroring the other
// owner-statement reports. Platform fee uses the live launch model, not
// PLATFORM_FEES.ACTIVE_UNIT (stale $15 — see walkthrough #34), so the
// P&L reconciles with the landlord Dashboard's fee card.
reportsRouter.get('/monthly-pl', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const now   = new Date()
    const year  = parseInt(req.query.year as string)  || now.getFullYear()
    const month = parseInt(req.query.month as string) || (now.getMonth() + 1)
    if (month < 1 || month > 12) throw new AppError(400, 'month must be 1-12')
    const { start, end } = monthRange(year, month)
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    // Settled income recognized in-month by ACTUAL payment date.
    const payments = await query<any>(`
      SELECT p.id, p.settled_at, p.amount, p.type,
             p.ach_trace_number, p.stripe_charge_id, p.stripe_payment_intent_id,
             u.unit_number, pr.name AS property_name,
             us.first_name AS tenant_first, us.last_name AS tenant_last
        FROM payments p
        LEFT JOIN units u       ON u.id  = p.unit_id
        LEFT JOIN properties pr ON pr.id = u.property_id
        LEFT JOIN tenants t     ON t.id  = p.tenant_id
        LEFT JOIN users us      ON us.id = t.user_id
       WHERE p.landlord_id = $1 AND p.status = 'settled'
         AND p.settled_at >= $2 AND p.settled_at <= $3
       ORDER BY p.settled_at DESC`, [landlordId, start, end])

    let grossRent = 0
    let grossOther = 0
    const paymentRows = payments.map((p: any) => {
      const amt = parseFloat(p.amount || 0)
      if (p.type === 'rent') grossRent += amt
      else grossOther += amt
      const method = p.ach_trace_number ? 'ACH'
        : (p.stripe_charge_id || p.stripe_payment_intent_id) ? 'Card'
        : '—'
      const tenantName = [p.tenant_first, p.tenant_last].filter(Boolean).join(' ') || null
      return {
        id: p.id,
        settledAt: p.settled_at,
        amount: amt,
        type: p.type,
        method,
        tenantName,
        unitNumber: p.unit_number ?? null,
        propertyName: p.property_name ?? null,
      }
    })
    const grossTotal = round2(grossRent + grossOther)

    // GAM platform fee — actual billed income for this month (accruals, with a
    // live estimate for an un-accrued current month), summed across properties.
    // NOT a current-occupancy snapshot, which read $0 on short-stay revenue and
    // any property vacant at query time despite in-month earnings.
    const feeMap = await platformFeesByProperty(landlordId, periodMonths(year, month))
    const platformFee = round2(Array.from(feeMap.values()).reduce((s, v) => s + v, 0))

    // Maintenance expense recognized by completion date in-month. The landlord
    // pays only the actual cost — the maintenance platform fee (reserved for the
    // future contractor marketplace) is never surfaced or deducted.
    const maintRow = await queryOne<any>(`
      SELECT COALESCE(SUM(actual_cost), 0)::numeric AS maint_cost
        FROM maintenance_requests
       WHERE landlord_id = $1
         AND completed_at >= $2 AND completed_at <= $3
         AND actual_cost IS NOT NULL`, [landlordId, start, end])
    const maintenance = round2(parseFloat(maintRow?.maint_cost ?? '0'))

    const expensesTotal = round2(platformFee + maintenance)
    const net = round2(grossTotal - expensesTotal)

    res.json({ success: true, data: {
      period: { year, month, start, end },
      gross: { rent: round2(grossRent), other: round2(grossOther), total: grossTotal },
      expenses: { platformFee, maintenance, total: expensesTotal },
      net,
      paymentCount: paymentRows.length,
      payments: paymentRows,
    } })
  } catch (e) { next(e) }
})

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

    // ── P&L calculations ──────────────────────────────────────
    const settled = payments.filter((p:any) => p.status === 'settled')
    const sumTypes = (types: string[]) => round2(settled
      .filter((p:any) => types.includes(p.type))
      .reduce((s:number, p:any) => s + parseFloat(p.amount||0), 0))

    // Income — operating income only. Deposits are custody/liability, not income,
    // so they're tracked separately and kept out of the P&L total + net.
    const rentCollected     = sumTypes(['rent'])
    const otherIncome       = sumTypes(['fee', 'utility', 'late_fee'])
    const depositsCollected = sumTypes(['deposit'])
    const totalIncome       = round2(rentCollected + otherIncome)
    const totalCollected    = round2(settled.reduce((s:number, p:any) => s + parseFloat(p.amount||0), 0)) // all settled (incl. deposits) — reference only

    // Platform fee = GAM's actual billed income for the month (accruals, with a
    // live estimate for an un-accrued current month), across the landlord's
    // properties. Period-based and short-stay-aware — not the current-occupancy
    // snapshot that read $0 on properties earning via nightly/weekly bookings.
    const feeMap = await platformFeesByProperty(landlordId, periodMonths(year, month))
    const totalPlatformFees = round2(Array.from(feeMap.values()).reduce((s, v) => s + v, 0))
    // Landlord pays only the actual maintenance cost; the maintenance platform
    // fee (reserved for the future contractor marketplace) is never surfaced.
    const totalMaintCost    = round2(maintenance.reduce((s:number, m:any) => s + parseFloat(m.actual_cost||0), 0))

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmFee always 0.
    const pmFee = 0

    const totalExpenses = round2(totalPlatformFees + totalMaintCost + pmFee)
    const netToOwner    = round2(totalIncome - totalExpenses)

    res.json({
      success: true,
      data: {
        period: { year, month, start, end },
        landlord, pmInfo, pmPlan,
        properties, units, payments, maintenance, workTrade, disbursements,
        summary: {
          // income
          rentCollected, otherIncome, depositsCollected, totalIncome, totalCollected,
          // expenses
          totalPlatformFees, totalMaintCost, pmFee, totalExpenses,
          netToOwner,
          // occupancy + payment counts
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

    // Platform fees paid — GAM's actual billed income, summed over each month of
    // the year that has elapsed (accruals where present, live estimate where not).
    // Period-based + short-stay-aware: no longer a current-occupancy snapshot ×12,
    // which both projected unbilled future months and zeroed out short-stay income.
    const annualFeeMap = await platformFeesByProperty(landlordId, periodMonths(year, null))
    const annualPlatformFees = round2(Array.from(annualFeeMap.values()).reduce((s, v) => s + v, 0))

    // Maintenance expenses — actual cost only (the maintenance platform fee is
    // never surfaced to the landlord).
    const maintStats = await queryOne<any>(`
      SELECT COALESCE(SUM(actual_cost), 0) as total_maint_cost,
        COUNT(*) as request_count
      FROM maintenance_requests
      WHERE landlord_id=$1 AND completed_at >= $2 AND completed_at <= $3`,
      [landlordId, start, end])

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmInfo
    // preserved as null in the response shape.
    const pmInfo = null

    // Work trade — 1099 eligible. S517: the bartered value is the actual
    // work-trade credit applied to the tenant's invoices that year
    // (invoices.work_trade_credit_amount), not the retired ytd_value dollar
    // ledger. Only agreements with real credit in the year are reported.
    const workTradeStats = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last, us.email as tenant_email,
        COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                   WHERE i.work_trade_agreement_id = wta.id
                     AND EXTRACT(YEAR FROM i.due_date) = $2), 0) AS credit_value
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1
        AND COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                       WHERE i.work_trade_agreement_id = wta.id
                         AND EXTRACT(YEAR FROM i.due_date) = $2), 0) > 0`,
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
    const workTradeVal = workTradeStats.reduce((s:number, w:any) => s + parseFloat(w.credit_value||0), 0)

    res.json({
      success: true,
      data: {
        year, landlord, pmInfo,
        income: {
          totalRent,
          paymentCount: parseInt(rentStats?.payment_count || 0),
        },
        deductions: {
          platformFees:  annualPlatformFees,
          maintExpenses: totalMaint,
          workTradeValue: workTradeVal,
        },
        deposits: {
          totalHeld: parseFloat(depositStats?.total_deposits || 0),
        },
        workTrade: workTradeStats,
        monthlyBreakdown,
        // Net = rent − GAM platform fee − maintenance cost. (Excludes the 8%
        // maintenance platform fee, which isn't billed today; and the platform
        // fee is now correctly subtracted — it was previously omitted here.)
        netIncome: round2(totalRent - annualPlatformFees - totalMaint),
        w2099Threshold: workTradeStats.filter((w:any) => parseFloat(w.credit_value||0) >= 600),
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

    // Scalar subqueries per concern — NOT multiple LEFT JOINs of payments +
    // maintenance onto units. Joining two one-to-many tables to the same unit
    // fans out (P payments × M maintenance rows), which multiplied each money
    // SUM by the other table's row count whenever a unit had both. Subqueries
    // keep each aggregate independent and correct (and let the per-property
    // drill-in reconcile with this row).
    const properties = await query<any>(`
      SELECT p.*,
        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS total_units,
        (SELECT COUNT(*) FROM units u
           JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
          WHERE u.property_id = p.id AND vuo.is_occupied) AS occupied_units,
        (SELECT COALESCE(SUM(pm.amount), 0) FROM payments pm
           JOIN units u ON u.id = pm.unit_id
          WHERE u.property_id = p.id AND pm.status='settled'
            AND pm.due_date >= $2 AND pm.due_date <= $3) AS rent_collected,
        (SELECT COALESCE(SUM(mr.actual_cost), 0) FROM maintenance_requests mr
           JOIN units u ON u.id = mr.unit_id
          WHERE u.property_id = p.id
            AND mr.completed_at >= $2 AND mr.completed_at <= $3) AS maint_cost
      FROM properties p
      WHERE p.landlord_id = $1
      ORDER BY p.name`,
      [landlordId, start, end])

    // Platform fee per property = GAM's actual billed income over the period
    // (accruals + live estimate for un-accrued months), period-based and
    // short-stay-aware — replaces the current-occupancy snapshot that read $0 on
    // earning properties with no active long-term lease at query time. The
    // maintenance platform fee is never surfaced; landlord net = rent − maint − fee.
    const feeMap = await platformFeesByProperty(landlordId, periodMonths(year, month))

    const result = properties.map((p:any) => {
      const rent     = parseFloat(p.rent_collected || 0)
      const maint    = parseFloat(p.maint_cost || 0)
      const platFee  = round2(feeMap.get(p.id) ?? 0)
      const netIncome = round2(rent - maint - platFee)
      return { ...p, rent_collected: rent, maint_cost: maint,
        platform_fees: platFee, net_income: netIncome,
        occupancy_rate: parseInt(p.total_units||0) > 0
          ? Math.round((parseInt(p.occupied_units||0) / parseInt(p.total_units||0)) * 100) : 0 }
    })

    res.json({ success: true, data: { year, month, period: { start, end }, properties: result } })
  } catch (e) { next(e) }
})

// ── PER-PROPERTY DETAIL DRILL-IN ──────────────────────────────
// GET /api/reports/property-detail?propertyId=UUID&year=YYYY[&month=M]
// Backs the click-into-a-property drill-in on the By Property tab. Same
// period semantics as /property-pl (month omitted = full calendar year) so
// the modal reconciles with the row the user clicked. Each aggregate is its
// own query — no payments×maintenance fan-out. Scoped to the caller's
// landlord; a property owned by anyone else returns 404.
reportsRouter.get('/property-detail', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const propertyId = req.query.propertyId as string
    if (!propertyId) throw new AppError(400, 'propertyId is required')
    const year  = parseInt(req.query.year as string)  || new Date().getFullYear()
    const month = req.query.month ? parseInt(req.query.month as string) : null
    if (month !== null && (month < 1 || month > 12)) throw new AppError(400, 'month must be 1-12')
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')

    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? new Date(year, month, 0).toISOString().split('T')[0] : `${year}-12-31`
    const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`

    const property = await queryOne<any>(`
      SELECT p.id, p.name, p.city, p.state, p.type,
        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS total_units,
        (SELECT COUNT(*) FROM units u
           JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
          WHERE u.property_id = p.id AND vuo.is_occupied) AS occupied_units
      FROM properties p
      WHERE p.id = $1 AND p.landlord_id = $2`, [propertyId, landlordId])
    if (!property) throw new AppError(404, 'Property not found')

    const occupied = parseInt(property.occupied_units || '0', 10)
    const totalUnits = parseInt(property.total_units || '0', 10)

    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.status, u.bedrooms, u.bathrooms, u.rent_amount,
        vuo.is_occupied,
        vuo.primary_first_name AS tenant_first, vuo.primary_last_name AS tenant_last
      FROM units u
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.property_id = $1
      ORDER BY u.unit_number`, [propertyId])

    const payments = await query<any>(`
      SELECT pmt.id, pmt.settled_at, pmt.due_date, pmt.amount, pmt.type, pmt.status,
        u.unit_number, us.first_name AS tenant_first, us.last_name AS tenant_last
      FROM payments pmt
      JOIN units u ON u.id = pmt.unit_id
      LEFT JOIN tenants t ON t.id = pmt.tenant_id
      LEFT JOIN users us ON us.id = t.user_id
      WHERE u.property_id = $1
        AND pmt.due_date >= $2 AND pmt.due_date <= $3
      ORDER BY pmt.due_date DESC`, [propertyId, start, end])

    const maintenance = await query<any>(`
      SELECT mr.id, mr.title, mr.status, mr.actual_cost, mr.completed_at,
        u.unit_number
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      WHERE u.property_id = $1
        AND mr.completed_at >= $2 AND mr.completed_at <= $3
        AND mr.actual_cost IS NOT NULL
      ORDER BY mr.completed_at DESC`, [propertyId, start, end])

    // Calendar-year collected per month — drives the modal's mini trend chart.
    const trendRows = await query<any>(`
      SELECT to_char(date_trunc('month', pmt.due_date), 'YYYY-MM') AS month,
             SUM(pmt.amount)::numeric AS collected
      FROM payments pmt
      JOIN units u ON u.id = pmt.unit_id
      WHERE u.property_id = $1 AND pmt.status='settled'
        AND pmt.due_date >= $2 AND pmt.due_date <= $3
      GROUP BY 1 ORDER BY 1`, [propertyId, yearStart, yearEnd])

    const collected = round2(payments
      .filter((p: any) => p.status === 'settled')
      .reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0))
    const maintCost = round2(maintenance.reduce((s: number, m: any) => s + parseFloat(m.actual_cost || 0), 0))
    // Platform fee = GAM's actual billed income for this property over the period
    // (accruals + live estimate for un-accrued months) — period-based and
    // short-stay-aware, so a property that earned rent never shows a $0 fee. The
    // maintenance platform fee is never surfaced; landlord pays only actual cost.
    const feeMap = await platformFeesByProperty(landlordId, periodMonths(year, month), propertyId)
    const platformFee = round2(feeMap.get(propertyId) ?? 0)
    const net = round2(collected - maintCost - platformFee)

    res.json({ success: true, data: {
      property: {
        id: property.id, name: property.name, city: property.city, state: property.state, type: property.type,
        totalUnits, occupiedUnits: occupied,
        occupancyRate: totalUnits > 0 ? Math.round(100 * occupied / totalUnits) : 0,
      },
      period: { year, month, start, end },
      summary: { collected, maintCost, platformFee, net },
      units: units.map((u: any) => ({
        id: u.id, unitNumber: u.unit_number, status: u.status,
        bedrooms: u.bedrooms, bathrooms: parseFloat(u.bathrooms),
        rent: parseFloat(u.rent_amount || 0), isOccupied: !!u.is_occupied,
        tenantName: [u.tenant_first, u.tenant_last].filter(Boolean).join(' ') || null,
      })),
      payments: payments.map((p: any) => ({
        id: p.id, settledAt: p.settled_at, dueDate: p.due_date,
        amount: parseFloat(p.amount || 0), type: p.type, status: p.status,
        unitNumber: p.unit_number ?? null,
        tenantName: [p.tenant_first, p.tenant_last].filter(Boolean).join(' ') || null,
      })),
      maintenance: maintenance.map((m: any) => ({
        id: m.id, title: m.title, status: m.status,
        actualCost: parseFloat(m.actual_cost || 0),
        completedAt: m.completed_at, unitNumber: m.unit_number ?? null,
      })),
      monthlyTrend: trendRows.map((r: any) => ({ month: r.month, collected: parseFloat(r.collected ?? '0') })),
    } })
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
    // S517: report the actual work-trade credit applied to invoices that
    // year as the bartered value (the retired tax_year + ytd_value dollar
    // ledger is gone). Only agreements with real credit in the year appear.
    const agreements = await query<any>(`
      SELECT wta.*,
        u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last,
        us.email as tenant_email,
        COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                   WHERE i.work_trade_agreement_id = wta.id
                     AND EXTRACT(YEAR FROM i.due_date) = $2), 0) AS credit_value
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1
        AND COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                       WHERE i.work_trade_agreement_id = wta.id
                         AND EXTRACT(YEAR FROM i.due_date) = $2), 0) > 0
      ORDER BY us.last_name, us.first_name`,
      [landlordId, year])

    const eligible   = agreements.filter((a:any) => parseFloat(a.credit_value||0) >= 600)
    const totalValue = agreements.reduce((s:number, a:any) => s + parseFloat(a.credit_value||0), 0)

    res.json({
      success: true,
      data: { year, landlord, agreements, eligible,
        summary: { totalAgreements: agreements.length, eligible1099Count: eligible.length, totalValue } }
    })
  } catch (e) { next(e) }
})
