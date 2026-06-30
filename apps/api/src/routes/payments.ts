import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { AchReturnCode, ACH_RETURN_CONFIG, PLATFORM_FEES } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { computeApplicationFee, createRentDestinationCharge, createRentPlatformCharge } from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
import { computeTenantGamOutstandingTotal } from '../services/supersedence'
import { logger } from '../lib/logger'

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

    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isTeamRole = role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance'
    if (role === 'landlord') {
      conditions.push(`p.landlord_id = $${pi++}`); params.push(req.user!.profileId)
    } else if (role === 'tenant') {
      conditions.push(`p.tenant_id = $${pi++}`); params.push(req.user!.profileId)
    } else if (isTeamRole) {
      // Team members scoped to their landlord; without a landlordId claim,
      // return nothing rather than leak across landlords. S81: also gate
      // on payments.view_all sub-perm — onsite/maintenance without explicit
      // permission do not see the landlord's payments roster.
      if (!req.user!.landlordId) {
        return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
      }
      if (req.user!.permissions?.['payments.view_all'] !== true) {
        return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
      }
      conditions.push(`p.landlord_id = $${pi++}`); params.push(req.user!.landlordId)
    } else if (!isAdmin) {
      // Unknown role with no scope — empty rather than leak.
      return res.json({ success: true, data: [], total: 0, page: 1, totalPages: 0 })
    }
    // admin/super_admin fall through with no role-based filter (full visibility).
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

    // Get all active units with verified ACH whose landlord has at least one
    // active bank account in the user_bank_accounts catalog. Pre-S67 the
    // gate was l.stripe_account_id (Connect-flavored, deleted in S67).
    const units = await query<any>(`
      SELECT u.*, t.stripe_customer_id, t.ach_verified, t.on_time_pay_enrolled,
        t.float_fee_active, t.income_arrival_day, t.id AS tenant_profile_id
      FROM units u
      JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      JOIN tenants t ON t.id = vuo.primary_tenant_id
      JOIN landlords l ON l.id = u.landlord_id
      WHERE u.status = 'active'
        AND u.payment_block = FALSE
        AND t.ach_verified = TRUE
        AND EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        )
    `)

    const [year, month] = targetMonth.split('-').map(Number)
    const dueDate = new Date(year, month - 1, 1) // 1st of target month

    let initiated = 0
    const errors: string[] = []

    let skipped = 0
    for (const unit of units) {
      try {
        // Determine pull date based on On-Time Pay enrollment
        const pullDay = unit.on_time_pay_enrolled && unit.income_arrival_day
          ? unit.income_arrival_day  // SSI/SSDI: pull on income arrival day
          : 28                       // Standard: pull ~28th for 1st settlement

        // S407 idempotency guard: pre-fix, calling this route twice for the
        // same targetMonth created DUPLICATE rent payment rows for every
        // unit (no UNIQUE constraint on payments(unit_id, type, due_date),
        // and the route loop INSERT'd unconditionally). A scheduler
        // misfire / admin double-click would double-bill every tenant.
        // Skip silently when an active rent row already exists for this
        // (unit, due_date). S414: the residual concurrent-write race is
        // now also closed by the partial UNIQUE index
        // ux_payments_unit_type_due_date_active.
        // S414 status filter: only skip when an ACTIVE (non-failed,
        // non-returned) row exists. Failed/returned rows are retry-
        // eligible — the system should be able to re-bill that month.
        const existing = await queryOne<{ id: string }>(
          `SELECT id FROM payments
            WHERE unit_id = $1
              AND type = 'rent'
              AND due_date = $2
              AND status NOT IN ('failed', 'returned')
            LIMIT 1`,
          [unit.id, dueDate]
        )
        if (existing) { skipped++; continue }

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
      data: { initiated, skipped, errors, targetMonth }
    })
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
      // ACH is the operating rail for FlexPay + OTP — once it's suspended those
      // subscriptions can't pull, so disenroll the tenant (best-effort; never
      // block the return handler). These were previously dead code (exported,
      // never called).
      try {
        const { autoDisenrollFlexPayOnAchUnverified } = await import('../services/flexpay')
        await autoDisenrollFlexPayOnAchUnverified(payment.tenant_id)
      } catch (e) { logger.error({ err: e, tenant_id: payment.tenant_id }, '[ach-return] flexpay auto-disenroll failed') }
      try {
        const { autoDisenrollOnAchUnverified } = await import('../services/otp')
        await autoDisenrollOnAchUnverified(payment.tenant_id)
      } catch (e) { logger.error({ err: e, tenant_id: payment.tenant_id }, '[ach-return] otp auto-disenroll failed') }
    }

    res.json({ success: true, data: {
      returnCode,
      zeroTolerance: config.zeroTolerance,
      action: config.zeroTolerance ? 'Tenant ACH suspended — manual review required' : 'Return logged — retry eligible'
    }})
  } catch (e) { next(e) }
})

// POST /api/payments/:id/pay — tenant initiates a destination charge for
// a pending rent payment row. (S117 — Stripe Connect destination charge
// model. Replaces the pre-Connect "tenant has no way to pay" gap.)
//
// Flow:
//   1. Tenant POSTs with their saved Stripe payment_method_id +
//      payment_method_type ('ach' or 'card')
//   2. Backend validates the payment row belongs to this tenant
//   3. Looks up the landlord's stripe_connect_account_id
//   4. Computes application_fee_amount via computeApplicationFee
//   5. Creates a destination charge — Stripe routes gross to landlord's
//      Connect, application_fee_amount to GAM's platform balance
//   6. Stamps stripe_payment_intent_id on the payment row, status →
//      'processing'
//   7. Webhook payment_intent.succeeded later flips to 'settled' and
//      runs allocation engine for the audit trail
paymentsRouter.post('/:id/pay', async (req: any, res, next) => {
  try {
    const body = z.object({
      paymentMethodId:   z.string().min(1),
      paymentMethodType: z.enum(['ach', 'card']),
    }).parse(req.body)

    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can call this endpoint')
    }

    // Fetch payment + verify ownership + status. S160+ cached Connect
    // readiness flags on users let us decide destination-vs-platform charge
    // without a live Stripe round-trip.
    const pmt = await queryOne<any>(
      `SELECT p.id, p.tenant_id, p.landlord_id, p.amount, p.status, p.type,
              p.entry_description, p.stripe_payment_intent_id, p.unit_id,
              p.due_date::text AS due_date,
              u.property_id, u.payment_block,
              t.stripe_customer_id,
              l.user_id AS landlord_user_id,
              lu.stripe_connect_account_id,
              lu.connect_charges_enabled,
              lu.connect_details_submitted
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN tenants t ON t.id = p.tenant_id
         JOIN landlords l ON l.id = p.landlord_id
         JOIN users lu ON lu.id = l.user_id
        WHERE p.id = $1`,
      [req.params.id]
    )
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (pmt.tenant_id !== req.user!.profileId) {
      throw new AppError(403, 'Not your payment')
    }
    // S511 #8b: eviction mode blocks ALL money routed to the landlord — every
    // payments-row charge here is a destination charge to the landlord's Connect,
    // and accepting any landlord-bound payment during an eviction can reset the
    // eviction timeline. GAM-side balances (FlexDeposit installments, etc.) run
    // through separate flows that aren't gated, so they keep collecting.
    if (pmt.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — payments to the landlord are paused. Accepting one could reset the eviction timeline. Contact the landlord.')
    }
    if (pmt.status === 'settled') {
      throw new AppError(409, 'Payment already settled')
    }
    if (pmt.status === 'processing' && pmt.stripe_payment_intent_id) {
      throw new AppError(409, 'Payment already in flight')
    }
    if (!pmt.stripe_customer_id) {
      throw new AppError(409, 'Tenant has no Stripe customer — complete ACH setup first')
    }

    // S113-PhaseA: don't fail the tenant payment when the destination Connect
    // isn't ready. Fall back to a standard charge (gross to GAM platform);
    // mark the payment platform_held; reconciliation Transfer fires when the
    // landlord eventually completes Connect onboarding. Otherwise tenants
    // hit a wall and spend the rent before we can collect.
    const landlordConnectReady =
      !!pmt.stripe_connect_account_id &&
      pmt.connect_charges_enabled === true &&
      pmt.connect_details_submitted === true

    const stripe = getStripe()

    // Read card country if relevant for the surcharge calculation
    let cardCountry: string | null = null
    if (body.paymentMethodType === 'card') {
      const pm = await stripe.paymentMethods.retrieve(body.paymentMethodId)
      cardCountry = pm.card?.country ?? null
    }

    const amount = parseFloat(pmt.amount)
    const baseApplicationFee = computeApplicationFee({
      amount,
      paymentMethod: body.paymentMethodType,
      cardCountry,
    })

    // S121: tenant-payer platform fee passthrough. Look up any unpaid
    // platform_fee_accruals on this property where payer='tenant'.
    // Sum their total_amount and add to application_fee_amount so GAM
    // collects the SaaS subscription fee on top of rent. Mark them paid
    // post-charge (after Stripe succeeds, so a charge failure leaves them
    // unclaimed for the next attempt).
    const unpaidAccruals = await query<{ id: string; total_amount: string }>(
      `SELECT id, total_amount FROM platform_fee_accruals
        WHERE property_id = $1
          AND payer = 'tenant'
          AND tenant_charge_id IS NULL
          AND total_amount > 0`,
      [pmt.property_id]
    )
    const passthroughAmount = unpaidAccruals.reduce(
      (sum, r) => sum + parseFloat(r.total_amount), 0
    )

    // S248: sublease markup detection. When this payment is for a unit
    // with an active sublease where the payer is the sublessee, the
    // landlord receives `master_share_amount` (not `sub_monthly_amount`).
    // The difference (markup) stays on platform balance and credits the
    // sublessor via subleaseAllocation on webhook success. Implementation:
    // add the markup to application_fee_amount so Stripe routes only
    // (gross - app_fee - markup) to landlord.
    let subleaseMarkup = 0
    if (pmt.type === 'rent') {
      const sub = await queryOne<{ sub: string; master: string }>(
        `SELECT s.sub_monthly_amount::text AS sub, s.master_share_amount::text AS master
           FROM subleases s
           JOIN leases l ON l.id = s.master_lease_id
          WHERE l.unit_id = $1
            AND s.sublessee_tenant_id = $2
            AND s.status = 'active'
            AND s.start_date <= $3::date
            AND (s.end_date IS NULL OR s.end_date >= $3::date)
          LIMIT 1`,
        [pmt.unit_id, pmt.tenant_id, pmt.due_date ?? new Date().toISOString().slice(0, 10)],
      )
      if (sub) {
        subleaseMarkup = Math.max(0, parseFloat(sub.sub) - parseFloat(sub.master))
      }
    }

    // S261: GAM-supersedence boost. Compute the tenant's outstanding
    // GAM-owed debt (FlexDeposit defaults + accelerated balance +
    // FlexCharge balances + FlexPay fees + custody fees) and route as
    // much of THIS rent payment as needed (oldest-first) into GAM's
    // platform balance via additional application_fee_amount. The
    // landlord receives gross - banking_fee - supersedence; the lease
    // still shows the rent paid in full. On webhook settle,
    // applyTenantSupersedence distributes the boost FIFO across the
    // live debt list.
    const gamSupersedenceAmount = pmt.tenant_id
      ? Math.min(amount, await computeTenantGamOutstandingTotal(pmt.tenant_id))
      : 0

    const applicationFeeAmount = Math.round(
      (baseApplicationFee + passthroughAmount + subleaseMarkup + gamSupersedenceAmount) * 100
    ) / 100

    const intent = landlordConnectReady
      ? await createRentDestinationCharge({
          amount,
          stripeCustomerId:        pmt.stripe_customer_id,
          paymentMethodId:         body.paymentMethodId,
          paymentMethodTypes:      body.paymentMethodType === 'ach' ? ['us_bank_account'] : ['card'],
          destinationConnectAccountId: pmt.stripe_connect_account_id,
          applicationFeeAmount,
          entryDescription:        pmt.entry_description,
          metadata: {
            gam_payment_id: pmt.id,
            tenant_id:      pmt.tenant_id,
            landlord_id:    pmt.landlord_id,
          },
        })
      : await createRentPlatformCharge({
          amount,
          stripeCustomerId:        pmt.stripe_customer_id,
          paymentMethodId:         body.paymentMethodId,
          paymentMethodTypes:      body.paymentMethodType === 'ach' ? ['us_bank_account'] : ['card'],
          entryDescription:        pmt.entry_description,
          metadata: {
            gam_payment_id: pmt.id,
            tenant_id:      pmt.tenant_id,
            landlord_id:    pmt.landlord_id,
          },
        })

    if (!landlordConnectReady) {
      // S113-PhaseA: notify admin that a payment landed on platform balance.
      // Reconciliation will fire automatically when the landlord finishes
      // Connect onboarding — but admin should see the case to nudge them.
      await createAdminNotification({
        severity: 'warn',
        category: 'platform_held_rent_charge',
        title:    `Rent collected to platform — landlord ${pmt.landlord_user_id} not Connect-ready`,
        body:     `Payment ${pmt.id} for $${amount} collected to GAM platform balance. Will reconcile via Transfer once landlord completes Connect onboarding.`,
        context: {
          payment_id:        pmt.id,
          landlord_id:       pmt.landlord_id,
          landlord_user_id:  pmt.landlord_user_id,
          amount,
          stripe_payment_intent_id: intent.id,
        },
      })
    }

    await query(
      `UPDATE payments
          SET status = CASE
                WHEN $1 = 'card' THEN 'settled'
                ELSE 'processing'
              END,
              stripe_payment_intent_id = $2,
              platform_held = $4,
              gam_supersedence_amount = $5
        WHERE id = $3`,
      [body.paymentMethodType, intent.id, pmt.id, !landlordConnectReady, gamSupersedenceAmount.toFixed(2)]
    )

    // S121: claim the unpaid tenant-payer accruals atomically. The filter
    // `AND tenant_charge_id IS NULL` defends against a concurrent rent-pay
    // claiming the same rows — only one UPDATE wins. Loser rows already
    // collected the surcharge from the tenant; over-collection scenario
    // is flagged for the reconciliation job (future).
    if (unpaidAccruals.length > 0) {
      const accrualIds = unpaidAccruals.map(r => r.id)
      await query(
        `UPDATE platform_fee_accruals
            SET tenant_charge_id = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[])
            AND tenant_charge_id IS NULL`,
        [pmt.id, accrualIds]
      )
    }

    res.json({
      success: true,
      data: {
        paymentIntentId:       intent.id,
        status:                intent.status,
        applicationFeeAmount,
        platformFeePassthrough: passthroughAmount,
        accrualsClaimed:       unpaidAccruals.length,
      },
    })
  } catch (e) { next(e) }
})
