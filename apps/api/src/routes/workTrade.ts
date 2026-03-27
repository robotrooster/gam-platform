import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const workTradeRouter = Router()
workTradeRouter.use(requireAuth)

// ── HELPERS ──────────────────────────────────────────────────

async function getAgreementForLandlord(agreementId: string, landlordProfileId: string) {
  const agreement = await queryOne<any>(
    'SELECT * FROM work_trade_agreements WHERE id=$1', [agreementId]
  )
  if (!agreement) throw new AppError(404, 'Agreement not found')
  if (agreement.landlord_id !== landlordProfileId && !(await isAdmin(landlordProfileId))) {
    throw new AppError(403, 'Forbidden')
  }
  return agreement
}

async function isAdmin(userId: string) {
  const u = await queryOne<any>('SELECT role FROM users WHERE id=$1', [userId])
  return u?.role === 'admin'
}

// ── CREATE AGREEMENT ─────────────────────────────────────────

workTradeRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      unitId:         z.string().uuid(),
      tenantId:       z.string().uuid(),
      tradeType:      z.enum(['full','partial','credit']),
      hourlyRate:     z.number().positive(),
      weeklyHours:    z.number().positive(),
      marketRent:     z.number().positive(),
      cashRent:       z.number().min(0).default(0),
      duties:         z.string().optional(),
      startDate:      z.string(),
      endDate:        z.string().optional(),
      renewalTerms:   z.string().optional(),
    }).parse(req.body)

    // Verify unit belongs to landlord
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [body.unitId, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found or access denied')

    // Calculate max monthly credit
    const monthlyHours = body.weeklyHours * (52 / 12)
    const tradeCreditMax = monthlyHours * body.hourlyRate
    const cashRent = body.tradeType === 'full' ? 0 : body.cashRent

    const agreement = await queryOne<any>(`
      INSERT INTO work_trade_agreements
        (unit_id, tenant_id, landlord_id, trade_type, hourly_rate, weekly_hours,
         market_rent, cash_rent, trade_credit_max, duties, start_date, end_date, renewal_terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [body.unitId, body.tenantId, req.user!.profileId, body.tradeType,
       body.hourlyRate, body.weeklyHours, body.marketRent, cashRent,
       tradeCreditMax, body.duties || null, body.startDate,
       body.endDate || null, body.renewalTerms || null]
    )

    // Create the first open period
    const now = new Date()
    const monthlyCommitHours = body.weeklyHours * (52 / 12)
    await query(`
      INSERT INTO work_trade_periods
        (agreement_id, period_month, period_year, hours_committed, cash_due)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`,
      [agreement!.id, now.getMonth() + 1, now.getFullYear(), monthlyCommitHours, cashRent]
    )

    res.json({ success: true, data: agreement })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT BY UNIT ─────────────────────────────────────

workTradeRouter.get('/unit/:unitId', async (req, res, next) => {
  try {
    const agreement = await queryOne<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last, u.email as tenant_email,
        un.unit_number, p.name as property_name
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.unit_id=$1 AND wta.status='active'
      ORDER BY wta.created_at DESC LIMIT 1`,
      [req.params.unitId]
    )
    res.json({ success: true, data: agreement })
  } catch (e) { next(e) }
})

// ── GET AGREEMENT WITH LOGS ───────────────────────────────────

workTradeRouter.get('/:id', async (req, res, next) => {
  try {
    const agreement = await queryOne<any>('SELECT * FROM work_trade_agreements WHERE id=$1', [req.params.id])
    if (!agreement) throw new AppError(404, 'Not found')

    const logs = await query<any>(`
      SELECT wtl.*, u.first_name, u.last_name,
        ru.first_name as reviewer_first, ru.last_name as reviewer_last
      FROM work_trade_logs wtl
      JOIN users u ON u.id = wtl.submitted_by
      LEFT JOIN users ru ON ru.id = wtl.reviewed_by
      WHERE wtl.agreement_id=$1
      ORDER BY wtl.work_date DESC`, [req.params.id])

    const periods = await query<any>(
      'SELECT * FROM work_trade_periods WHERE agreement_id=$1 ORDER BY period_year DESC, period_month DESC',
      [req.params.id]
    )

    // Current period stats
    const now = new Date()
    const currentPeriod = periods.find(p =>
      p.period_month === now.getMonth() + 1 && p.period_year === now.getFullYear()
    )
    const pendingLogs = logs.filter(l => l.status === 'pending')
    const approvedThisPeriod = logs.filter(l =>
      l.status === 'approved' &&
      new Date(l.work_date).getMonth() + 1 === now.getMonth() + 1 &&
      new Date(l.work_date).getFullYear() === now.getFullYear()
    )
    const hoursApprovedThisPeriod = approvedThisPeriod.reduce((s: number, l: any) => s + parseFloat(l.hours), 0)

    res.json({
      success: true,
      data: {
        agreement,
        logs,
        periods,
        currentPeriod,
        stats: {
          pendingCount: pendingLogs.length,
          hoursThisPeriod: hoursApprovedThisPeriod,
          hoursCommitted: parseFloat(agreement.weekly_hours) * (52 / 12),
        }
      }
    })
  } catch (e) { next(e) }
})

// ── TENANT: SUBMIT HOURS ──────────────────────────────────────

workTradeRouter.post('/:id/logs', async (req, res, next) => {
  try {
    const body = z.object({
      workDate:    z.string(),
      hours:       z.number().positive().max(24),
      description: z.string().min(3),
    }).parse(req.body)

    const agreement = await queryOne<any>('SELECT * FROM work_trade_agreements WHERE id=$1', [req.params.id])
    if (!agreement) throw new AppError(404, 'Agreement not found')
    if (agreement.status !== 'active') throw new AppError(400, 'Agreement is not active')

    // Verify caller is the tenant on this agreement OR landlord
    if (req.user!.role === 'tenant' && req.user!.profileId !== agreement.tenant_id) {
      throw new AppError(403, 'Forbidden')
    }

    const log = await queryOne<any>(`
      INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [agreement.id, agreement.tenant_id, req.user!.userId, body.workDate, body.hours, body.description]
    )

    res.json({ success: true, data: log })
  } catch (e) { next(e) }
})

// ── LANDLORD: APPROVE / REJECT LOG ───────────────────────────

workTradeRouter.patch('/logs/:logId', requireLandlord, async (req, res, next) => {
  try {
    const { action, rejectionReason } = z.object({
      action:          z.enum(['approve','reject']),
      rejectionReason: z.string().optional(),
    }).parse(req.body)

    const log = await queryOne<any>(
      'SELECT * FROM work_trade_logs WHERE id=$1', [req.params.logId]
    )
    if (!log) throw new AppError(404, 'Log not found')

    const agreement = await getAgreementForLandlord(log.agreement_id, req.user!.profileId)
    const creditValue = action === 'approve' ? parseFloat(log.hours) * parseFloat(agreement.hourly_rate) : null

    const updated = await queryOne<any>(`
      UPDATE work_trade_logs SET
        status=$1, reviewed_by=$2, reviewed_at=NOW(),
        rejection_reason=$3, credit_value=$4
      WHERE id=$5 RETURNING *`,
      [action === 'approve' ? 'approved' : 'rejected',
       req.user!.userId, rejectionReason || null, creditValue, log.id]
    )

    // Update period hours if approved
    if (action === 'approve') {
      const workDate = new Date(log.work_date)
      await query(`
        UPDATE work_trade_periods SET
          hours_worked = hours_worked + $1,
          credit_earned = credit_earned + $2
        WHERE agreement_id=$3 AND period_month=$4 AND period_year=$5`,
        [log.hours, creditValue, agreement.id,
         workDate.getMonth() + 1, workDate.getFullYear()]
      )

      // Update YTD value and flag 1099 if over $600
      await query(`
        UPDATE work_trade_agreements SET
          ytd_value = ytd_value + $1,
          flag_1099 = CASE WHEN ytd_value + $1 >= 600 THEN TRUE ELSE flag_1099 END
        WHERE id=$2`, [creditValue, agreement.id]
      )
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── LANDLORD: RECONCILE PERIOD ────────────────────────────────

workTradeRouter.post('/:id/reconcile', requireLandlord, async (req, res, next) => {
  try {
    const { month, year } = z.object({
      month: z.number().int().min(1).max(12),
      year:  z.number().int().min(2020),
    }).parse(req.body)

    const agreement = await getAgreementForLandlord(req.params.id, req.user!.profileId)

    const period = await queryOne<any>(`
      SELECT * FROM work_trade_periods
      WHERE agreement_id=$1 AND period_month=$2 AND period_year=$3`,
      [agreement.id, month, year]
    )
    if (!period) throw new AppError(404, 'Period not found')
    if (period.status === 'reconciled') throw new AppError(400, 'Already reconciled')

    const hoursShort = Math.max(0, period.hours_committed - period.hours_worked)
    const shortfallCharge = hoursShort * parseFloat(agreement.hourly_rate)
    const cashDue = parseFloat(agreement.cash_rent) + shortfallCharge

    const updated = await queryOne<any>(`
      UPDATE work_trade_periods SET
        hours_short=$1, shortfall_charge=$2, cash_due=$3,
        status='reconciled', reconciled_at=NOW()
      WHERE id=$4 RETURNING *`,
      [hoursShort, shortfallCharge, cashDue, period.id]
    )

    // Open next period
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear  = month === 12 ? year + 1 : year
    const monthlyCommit = parseFloat(agreement.weekly_hours) * (52 / 12)
    await query(`
      INSERT INTO work_trade_periods
        (agreement_id, period_month, period_year, hours_committed, cash_due)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`,
      [agreement.id, nextMonth, nextYear, monthlyCommit, agreement.cash_rent]
    )

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ── GET ALL WORK TRADE FOR LANDLORD (dashboard) ───────────────

workTradeRouter.get('/', requireLandlord, async (req, res, next) => {
  try {
    const agreements = await query<any>(`
      SELECT wta.*,
        u.first_name as tenant_first, u.last_name as tenant_last,
        un.unit_number, p.name as property_name,
        (SELECT COUNT(*) FROM work_trade_logs wtl WHERE wtl.agreement_id=wta.id AND wtl.status='pending') as pending_count
      FROM work_trade_agreements wta
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users u ON u.id = t.user_id
      JOIN units un ON un.id = wta.unit_id
      JOIN properties p ON p.id = un.property_id
      WHERE wta.landlord_id=$1
      ORDER BY wta.created_at DESC`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: agreements })
  } catch (e) { next(e) }
})

// ── UPDATE AGREEMENT STATUS ───────────────────────────────────

workTradeRouter.patch('/:id', requireLandlord, async (req, res, next) => {
  try {
    const { status, endDate } = z.object({
      status:  z.enum(['active','paused','ended']).optional(),
      endDate: z.string().optional(),
    }).parse(req.body)

    await getAgreementForLandlord(req.params.id, req.user!.profileId)

    const updated = await queryOne<any>(`
      UPDATE work_trade_agreements SET
        status=COALESCE($1,status),
        end_date=COALESCE($2,end_date),
        updated_at=NOW()
      WHERE id=$3 RETURNING *`,
      [status || null, endDate || null, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
