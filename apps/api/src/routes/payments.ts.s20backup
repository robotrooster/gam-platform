import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { AchReturnCode, ACH_RETURN_CONFIG, PLATFORM_FEES } from '@gam/shared'

export const paymentsRouter = Router()
paymentsRouter.use(requireAuth)

// GET /api/payments — filtered by landlord or tenant
paymentsRouter.get('/', async (req, res, next) => {
  try {
    const { status, type, from, to, page = '1', limit = '50' } = req.query as Record<string,string>
    const offset = (parseInt(page) - 1) * parseInt(limit)
    const conditions: string[] = []
    const params: any[] = []
    let pi = 1

    if (req.user!.role === 'landlord') {
      conditions.push(`p.landlord_id = $${pi++}`); params.push(req.user!.profileId)
    } else if (req.user!.role === 'tenant') {
      conditions.push(`p.tenant_id = $${pi++}`); params.push(req.user!.profileId)
    }
    if (status)  { conditions.push(`p.status = $${pi++}`);       params.push(status) }
    if (type)    { conditions.push(`p.type = $${pi++}`);         params.push(type) }
    if (from)    { conditions.push(`p.due_date >= $${pi++}`);    params.push(from) }
    if (to)      { conditions.push(`p.due_date <= $${pi++}`);    params.push(to) }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const [{ total }] = await query<any>(
      `SELECT COUNT(*)::int AS total FROM payments p ${where}`, params
    )
    params.push(parseInt(limit), offset)
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name AS property_name,
        tu.first_name AS tenant_first, tu.last_name AS tenant_last
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN tenants t ON t.id = p.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      ${where}
      ORDER BY p.due_date DESC
      LIMIT $${pi} OFFSET $${pi+1}`, params
    )
    res.json({ success: true, data: payments, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) })
  } catch (e) { next(e) }
})

// POST /api/payments/initiate-rent-collection — trigger ACH pulls for upcoming month
// Called by scheduler on ~28th of month
paymentsRouter.post('/initiate-rent-collection', requireAdmin, async (req, res, next) => {
  try {
    const { targetMonth } = z.object({
      targetMonth: z.string().regex(/^\d{4}-\d{2}$/) // YYYY-MM
    }).parse(req.body)

    // Get all active units with verified ACH
    const units = await query<any>(`
      SELECT u.*, t.stripe_customer_id, t.ach_verified, t.on_time_pay_enrolled,
        t.float_fee_active, t.income_arrival_day, t.id AS tenant_profile_id,
        l.stripe_account_id
      FROM units u
      JOIN tenants t ON t.id = u.tenant_id
      JOIN landlords l ON l.id = u.landlord_id
      WHERE u.status = 'active'
        AND u.payment_block = FALSE
        AND t.ach_verified = TRUE
        AND l.stripe_account_id IS NOT NULL
    `)

    const [year, month] = targetMonth.split('-').map(Number)
    const dueDate = new Date(year, month - 1, 1) // 1st of target month

    let initiated = 0
    const errors: string[] = []

    for (const unit of units) {
      try {
        // Determine pull date based on On-Time Pay enrollment
        const pullDay = unit.on_time_pay_enrolled && unit.income_arrival_day
          ? unit.income_arrival_day  // SSI/SSDI: pull on income arrival day
          : 28                       // Standard: pull ~28th for 1st settlement

        const [payment] = await query<any>(`
          INSERT INTO payments
            (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
          VALUES ($1,$2,$3,'rent',$4,'pending','RENT',$5)
          RETURNING id`,
          [unit.id, unit.tenant_profile_id, unit.landlord_id, unit.rent_amount, dueDate]
        )

        // If float fee active, create float fee payment too
        if (unit.float_fee_active) {
          await query(`
            INSERT INTO payments
              (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
            VALUES ($1,$2,$3,'float_fee',$4,'pending','ONTIMEPAY',$5)`,
            [unit.id, unit.tenant_profile_id, unit.landlord_id, PLATFORM_FEES.FLOAT_FEE_MO, dueDate]
          )
        }

        initiated++
      } catch (err: any) {
        errors.push(`Unit ${unit.unit_number}: ${err.message}`)
      }
    }

    res.json({
      success: true,
      data: { initiated, errors, targetMonth }
    })
  } catch (e) { next(e) }
})

// POST /api/payments/initiate-disbursements — On-Time Pay SLA
// Disbursement SLA: initiated on or before 1st business day of month
// Platform fulfills from operational reserve if tenant hasn't settled yet
paymentsRouter.post('/initiate-disbursements', requireAdmin, async (req, res, next) => {
  try {
    const { targetDate } = z.object({
      targetDate: z.string()
    }).parse(req.body)

    // Get all landlords with active units
    const landlords = await query<any>(`
      SELECT l.id, l.stripe_account_id,
        SUM(u.rent_amount) AS total_rent,
        COUNT(u.id)::int AS unit_count,
        COALESCE(SUM(CASE WHEN p.status = 'settled' THEN p.amount ELSE 0 END), 0) AS collected,
        COALESCE(SUM(CASE WHEN p.status != 'settled' THEN p.amount ELSE 0 END), 0) AS uncollected
      FROM landlords l
      JOIN units u ON u.landlord_id = l.id AND u.status = 'active' AND u.payment_block = FALSE
      LEFT JOIN payments p ON p.landlord_id = l.id AND p.type = 'rent'
        AND p.due_date = $1
      WHERE l.stripe_account_id IS NOT NULL
      GROUP BY l.id, l.stripe_account_id`,
      [targetDate]
    )

    let disbursed = 0
    for (const landlord of landlords) {
      const fromReserve = landlord.uncollected > 0
      const [disb] = await query<any>(`
        INSERT INTO disbursements
          (landlord_id, amount, unit_count, status, from_reserve, reserve_amount, target_date)
        VALUES ($1,$2,$3,'pending',$4,$5,$6)
        RETURNING id`,
        [landlord.id, landlord.total_rent, landlord.unit_count,
         fromReserve, fromReserve ? landlord.uncollected : 0, targetDate]
      )
      if (fromReserve) {
        // Log reserve drawdown
        await query(`
          INSERT INTO reserve_fund_ledger (type, amount, balance_after, reference_id, notes)
          SELECT 'disbursement_cover', -$1, balance - $1, $2, 'On-Time Pay SLA fulfillment'
          FROM reserve_fund_state LIMIT 1`,
          [landlord.uncollected, disb.id]
        )
        await query(`UPDATE reserve_fund_state SET balance = balance - $1`, [landlord.uncollected])
      }
      disbursed++
    }

    res.json({ success: true, data: { disbursed, targetDate,
      message: 'Disbursements initiated per On-Time Pay SLA' } })
  } catch (e) { next(e) }
})

// POST /api/payments/:id/handle-return — process ACH return codes
// Zero tolerance: R05, R07, R10, R29 — immediate block
paymentsRouter.post('/:id/handle-return', requireAdmin, async (req, res, next) => {
  try {
    const { returnCode, returnReason } = z.object({
      returnCode:   z.nativeEnum(AchReturnCode),
      returnReason: z.string().optional(),
    }).parse(req.body)

    const config = ACH_RETURN_CONFIG[returnCode]
    const payment = await queryOne<any>(
      `SELECT * FROM payments WHERE id = $1`, [req.params.id]
    )
    if (!payment) throw new AppError(404, 'Payment not found')

    await query(`
      UPDATE payments SET status='returned', return_code=$1, return_reason=$2,
        zero_tolerance_flag=$3 WHERE id=$4`,
      [returnCode, returnReason ?? config.description, config.zeroTolerance, req.params.id]
    )

    // Log to NACHA monitoring
    await query(`
      INSERT INTO ach_monitoring_log
        (payment_id, event_type, tenant_id, amount, return_code, flagged)
      VALUES ($1,'return_received',$2,$3,$4,$5)`,
      [payment.id, payment.tenant_id, payment.amount, returnCode, config.zeroTolerance]
    )

    if (config.zeroTolerance) {
      // Zero tolerance — suspend ACH for this tenant immediately
      await query(`UPDATE tenants SET ach_verified = FALSE WHERE id = $1`, [payment.tenant_id])
      await query(`
        INSERT INTO ach_monitoring_log
          (payment_id, event_type, tenant_id, return_code, flagged, notes)
        VALUES ($1,'zero_tolerance_block',$2,$3,TRUE,'Tenant ACH suspended per NACHA zero-tolerance policy')`,
        [payment.id, payment.tenant_id, returnCode]
      )
    }

    res.json({ success: true, data: {
      returnCode,
      zeroTolerance: config.zeroTolerance,
      action: config.zeroTolerance ? 'Tenant ACH suspended — manual review required' : 'Return logged — retry eligible'
    }})
  } catch (e) { next(e) }
})
