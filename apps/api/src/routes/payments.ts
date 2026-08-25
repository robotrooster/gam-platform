import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { chargeLandlord } from '../services/landlordGamAccount'
import { requireAuth, requireAdmin, requirePerm } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { AchReturnCode, ACH_RETURN_CONFIG, PLATFORM_FEES,
         MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_FEE, paymentMethodCosts,
         PRIOR_ARRANGEMENT_METHOD } from '@gam/shared'
import { getStripe } from '../lib/stripe'
import { computePlatformCut, createRentPlatformCharge } from '../services/stripeConnect'
import { createAdminNotification } from '../services/adminNotifications'
import { computeTenantGamOutstandingTotal } from '../services/supersedence'
import { chargeLeaseBalance, chargeLeaseBalanceSchema, resolveTargetLease,
         suggestedPayAheadFor } from '../services/rentCharge'
import { allocateOldestFirst } from '@gam/shared'
import { getClient } from '../db'
import { logger } from '../lib/logger'

export const paymentsRouter = Router()
paymentsRouter.use(requireAuth)

// POST /api/payments/quote — pre-charge fee disclosure (S601, Nic). Given the rent
// amount + method + lease, returns EXACTLY what the tenant will be charged: base rent
// plus the processing fee when the property routes the fee to the tenant (card is
// ALWAYS tenant-paid; ACH depends on the property's ach_fee_payer). Mirrors the charge
// math in POST /:id/pay so the pay UI shows the real total BEFORE the tenant confirms —
// no tenant should be blindsided by a card surcharge they never saw.
paymentsRouter.post('/quote', async (req, res, next) => {
  try {
    const body = z.object({
      amount:  z.number().positive(),
      method:  z.enum(['ach', 'card']),
      leaseId: z.string().uuid().optional(),
    }).parse(req.body)

    let feePayer: string = 'tenant'   // default when no rule (mirrors /pay: null → tenant pays)
    if (body.leaseId) {
      const row = await queryOne<{ ach_fee_payer: string | null; card_fee_payer: string | null }>(
        `SELECT r.ach_fee_payer, r.card_fee_payer
           FROM leases l
           JOIN units u ON u.id = l.unit_id
           JOIN property_allocation_rules r ON r.property_id = u.property_id
          WHERE l.id = $1`, [body.leaseId])
      feePayer = (body.method === 'ach' ? row?.ach_fee_payer : row?.card_fee_payer) ?? 'tenant'
    }
    const tenantPaysFee = feePayer !== 'landlord'
    // cardCountry omitted → US base rate; a non-US card adds 1.5% at charge time (flagged in the UI).
    const fee = tenantPaysFee ? computePlatformCut({ amount: body.amount, paymentMethod: body.method }) : 0
    const total = Math.round((body.amount + fee) * 100) / 100
    res.json({ success: true, data: {
      base: body.amount, method: body.method, fee, tenantPaysFee, total,
      intlCardSurcharge: body.method === 'card',
    } })
  } catch (e) { next(e) }
})

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
      // S620: own + co-owned entities (Nic: a co-owner sees what the owner sees).
      conditions.push(`p.landlord_id = ANY($${pi++})`); params.push(landlordScopeIds(req.user!))
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
    // admin/super_admin fall through: super_admin sees everything; a regular
    // admin (portfolio manager) is scoped to landlords they close or service.
    if (role === 'admin') {
      conditions.push(`p.landlord_id IN (SELECT id FROM landlords WHERE portfolio_manager_id = $${pi} OR service_manager_id = $${pi})`)
      params.push(req.user!.userId); pi++
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
        tu.first_name AS tenant_first, tu.last_name AS tenant_last,
        -- S568: is this the FIRST open rent charge of a lease while the LANDLORD
        -- is still inside their onboarding reconciliation window? If so the
        -- landlord may mark it paid off-platform (old-system autopay overlap),
        -- fee-free. Mirrors the route guard. New-vs-imported is irrelevant.
        (p.type = 'rent' AND p.status IN ('pending', 'failed')
          AND ld.reconciliation_until IS NOT NULL AND ld.reconciliation_until > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM payments p2
             WHERE p2.lease_id = p.lease_id AND p2.type = 'rent'
               AND p2.status IN ('settled', 'paid_via_deposit') AND p2.id <> p.id)
        ) AS prior_arrangement_eligible
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN landlords ld ON ld.id = p.landlord_id
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
              (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
            -- -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share.
            VALUES ($1,$2,$3,'float_fee',$4,'pending','ONTIMEPAY',$5,'gam')`,
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
      // OTP auto-disenroll (gated/no-op while OTP is hidden; kept for re-enable).
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
//   4. Computes application_fee_amount via computePlatformCut
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
              -- S554 Connect re-anchor: prefer the landlord ENTITY's account +
              -- its capability flags; fall back to the founding owner's user
              -- account during the transition. The flags MUST come from the
              -- same entity that owns the account being charged (a plain
              -- COALESCE on the booleans would always pick landlords' false).
              COALESCE(l.stripe_connect_account_id, lu.stripe_connect_account_id) AS stripe_connect_account_id,
              CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_charges_enabled   ELSE lu.connect_charges_enabled   END AS connect_charges_enabled,
              CASE WHEN l.stripe_connect_account_id IS NOT NULL THEN l.connect_details_submitted ELSE lu.connect_details_submitted END AS connect_details_submitted,
              -- S562: who bears the processing fee (must MATCH allocation.ts's
              -- settle-time branch exactly, or GAM under/over-collects). Lives
              -- on property_allocation_rules, not properties.
              par.ach_fee_payer, par.card_fee_payer
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN tenants t ON t.id = p.tenant_id
         JOIN landlords l ON l.id = p.landlord_id
         JOIN users lu ON lu.id = l.user_id
         LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
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
    // S533/S534 payment priority (Nic): ACCELERATED propane outranks rent
    // but NEVER interrupts the charge — the ACH pulls in full and settle-
    // time redistribution (services/propaneRedistribution.ts, webhook)
    // applies the funds propane-first, splitting the rent row. There is
    // deliberately NO pay-time disclosure (S534): warning the tenant
    // before/at confirmation invites backing out mid-flow and stranding
    // failed ACH pulls. The tenant is informed AFTER the money moves, by
    // the settle-time 'propane_priority_applied' notification in
    // webhooks.ts. (GAM balances outrank both — supersedence skims at
    // its own layer.)
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
    const basePlatformCut = computePlatformCut({
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

    // S248/S581: sublease markup detection. When this payment is for a unit
    // with an active sublease where the payer is the sublessee, the landlord is
    // owed `master_share_amount`, not `sub_monthly_amount` — the difference
    // (markup) goes to the sublessor. Under platform-holds (S560) it is STAMPED
    // on the payment (sublease_markup_amount) so services/allocation.ts subtracts
    // it from owner_share and creditSublessorMarkupForPayment credits the
    // sublessor that same amount at settle. (Pre-S581 it was added only to the
    // now-dead application_fee_amount — see the migration: the markup was dropped
    // from the landlord's payout, so GAM ate it.)
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

    const platformCutAmount = Math.round(
      (basePlatformCut + passthroughAmount + subleaseMarkup + gamSupersedenceAmount) * 100
    ) / 100

    // S562: the tenant bears the processing fee UNLESS the property routes it to
    // the landlord. Mirror allocation.ts EXACTLY (`=== 'landlord'` is the only
    // landlord branch; null / 'tenant' → tenant pays). When the tenant pays, the
    // fee must be ADDED to the charge — under platform-holds GAM keeps its cut by
    // NOT transferring it, so if the fee isn't collected up front the landlord
    // still gets full rent (allocation splittable=gross) and GAM eats Stripe's
    // cost every payment (violates the #1 no-fee-absorption rule).
    const feePayer = body.paymentMethodType === 'ach' ? pmt.ach_fee_payer : pmt.card_fee_payer
    const tenantPaysProcessingFee = feePayer !== 'landlord'
    // S562: the tenant-borne amounts that ride ON TOP of rent = the processing
    // fee (when they're the fee payer) + the tenant-payer platform-fee
    // passthrough (`passthroughAmount` is already the sum of payer='tenant'
    // unclaimed accruals, so it's naturally $0 when the landlord pays the
    // platform fee — the launch default). Same leak, same fix: under platform-
    // holds these must be collected in the charge, or GAM eats them.
    const tenantBorneOnTop = (tenantPaysProcessingFee ? basePlatformCut : 0) + passthroughAmount
    const chargeAmount = Math.round((amount + tenantBorneOnTop) * 100) / 100

    // S560 money-flow rebuild (Phase 1): ALWAYS charge to the platform balance —
    // no destination charge. Rent is held by GAM and batched out to the landlord
    // on the weekly (Friday-delivered) run. GAM keeps its cut by simply not
    // transferring it, and the settle-time allocation ledger records who is owed
    // what. The tenant-borne processing fee (S562) rides on top of the charge.
    const intent = await createRentPlatformCharge({
      amount: chargeAmount,
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
      // The money is held fine, but this landlord has no payout-ready Connect
      // account, so the weekly batch can't disburse to them yet. Nudge admin to
      // get them onboarded; funds release on the batch once they're ready.
      await createAdminNotification({
        severity: 'warn',
        category: 'platform_held_rent_charge',
        title:    `Held rent can't batch out — landlord ${pmt.landlord_user_id} not Connect-ready`,
        body:     `Payment ${pmt.id} for $${amount} is held on the GAM platform balance. It will be batched to the landlord once they finish Connect onboarding.`,
        context: {
          payment_id:        pmt.id,
          landlord_id:       pmt.landlord_id,
          landlord_user_id:  pmt.landlord_user_id,
          amount,
          stripe_payment_intent_id: intent.id,
        },
      })
    }

    // S560: card, like ACH, stays 'processing' until the webhook confirms —
    // the webhook's settle path (gated on status != 'settled') is what runs
    // allocation, supersedence, Flex crediting, and PM/manager transfers.
    // Pre-fix, card was stamped 'settled' here, so the webhook skipped ALL of
    // that for card payments. (Matches the /pay-balance FIFO route.)
    await query(
      `UPDATE payments
          SET status = 'processing',
              stripe_payment_intent_id = $1,
              platform_held = TRUE,
              gam_supersedence_amount = $3,
              sublease_markup_amount = $4
        WHERE id = $2`,
      [intent.id, pmt.id, gamSupersedenceAmount.toFixed(2), subleaseMarkup.toFixed(2)]
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
        platformCutAmount,
        platformFeePassthrough: passthroughAmount,
        accrualsClaimed:       unpaidAccruals.length,
      },
    })
  } catch (e) { next(e) }
})

// ── S537 (Nic): ONE "Pay now" — FIFO oldest-first application ─────────
// The tenant portal shows a READ-ONLY oldest-first ledger and a single
// Pay Now. The tenant may pay the full balance or MORE (paying ahead) —
// never less.
//
// S616 (Nic): this comment used to describe a per-property
// accept_partial_payments setting. That column was dead — enforcement in
// chargeLeaseBalance has always been unconditional — and it has been dropped,
// because partial payments are not a setting: "in the case of it going to two
// different operators, how would you allocate that? The charges happened at the
// exact same time." A converged invoice carries one landlord's rent and
// another's utilities, both due the same day; any rule for who gets paid first
// is GAM picking a winner between two landlords.
//
// Mechanics: allocateOldestFirst plans the application. Rows covered in
// FULL get this charge's PI stamped (status 'processing') — the standard
// payment_intent.succeeded path then settles them all, running the
// allocation engine + credit ledger per row unchanged. A PARTIALLY
// covered row is SPLIT at initiation (the propaneRedistribution
// pattern): the applied slice carries the PI, the remainder stays a
// pending row so "short is short" late-fee mechanics remain truthful.
// Any pay-ahead remainder is recorded on the remittance; the webhook
// turns it into a lease_prepaid_credit on settlement.
// S537: everything the tenant's Pay Now card needs in one fetch — the
// outstanding oldest-first ledger + the total. Rent is pay-in-full only
// (Nic) — no partial-payment concept, so nothing about partials is sent.
// S607 (Nic): "If the landlord is covering the ten dollars, it needs to be
// visible to them so they can track it. If the landlord is not covering the ten
// dollars, it doesn't need to be visible to them."
//
// When the tenant reimburses it, the landlord is whole and the fee is none of
// their business — it appears on the tenant's bill and nowhere else. When the
// landlord ABSORBS it, it is a real cost that reduces their payout, and an
// unexplained deduction is exactly the surprise the onboarding toggle exists to
// prevent: ten cash payments is $100 off a disbursement with nothing naming it.
//
// Reads platform_revenue_ledger, which is otherwise admin-only (finances.ts
// deliberately does not expose it) — so this endpoint is narrowly scoped to ONE
// reference_type and to properties the caller actually owns or manages.
paymentsRouter.get('/absorbed-manual-fees', async (req: any, res, next) => {
  try {
    const role = req.user!.role
    const landlordId = role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    if (!landlordId) throw new AppError(403, 'Landlord scope required')
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 6))

    const rows = await query<any>(`
      SELECT prl.id, prl.amount::float AS amount, prl.created_at, prl.notes,
             p.id AS property_id, p.name AS property_name,
             u.unit_number
        FROM platform_revenue_ledger prl
        JOIN properties p ON p.id = prl.property_id
        LEFT JOIN payments pay ON pay.id = prl.reference_id
        LEFT JOIN units u ON u.id = pay.unit_id
       WHERE prl.reference_type = 'manual_payment_fee'
         AND p.landlord_id = $1
         AND prl.created_at >= NOW() - ($2::int * INTERVAL '1 month')
       ORDER BY prl.created_at DESC
       LIMIT 500`, [landlordId, months])

    const total = Math.round(rows.reduce((s: number, r: any) => s + r.amount, 0) * 100) / 100
    res.json({ success: true, data: { total, count: rows.length, months, rows } })
  } catch (e) { next(e) }
})

paymentsRouter.get('/balance-context', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const rows = await query<any>(
      `SELECT p.id, p.amount::float AS amount, p.due_date::text AS due_date, p.type,
              p.entry_description, p.notes, p.lease_id, u.payment_block,
              u.unit_number, pr.name AS property_name,
              -- S615: the ONLY reliable mark of a utility-service charge. A
              -- NULL lease_id is not it: ordinary tenants have lease-less
              -- payment rows too, and treating those as service charges pulled
              -- them out of their own balance group.
              inv.service_agreement_id,
              COALESCE(par.manual_fee_payer, 'tenant') AS manual_fee_payer,
              -- S607: has this tenant ever had rent satisfied? The first manual
              -- payment is free, so the quote must know which side of that the
              -- tenant is on rather than promising a discount they already spent.
              --
              -- Scoped EXACTLY as record-manual scopes it: by lease when the row
              -- carries one, otherwise by tenant. record-manual falls back the
              -- same way (scopeCol = lease_id when present, else tenant_id),
              -- and a quote that scopes differently from the charge is the drift
              -- this whole breakdown exists to avoid.
              NOT EXISTS (
                SELECT 1 FROM payments pp
                 WHERE pp.type = 'rent'
                   AND pp.status IN ('settled', 'paid_via_deposit')
                   AND (CASE WHEN p.lease_id IS NOT NULL
                             THEN pp.lease_id = p.lease_id
                             ELSE pp.tenant_id = p.tenant_id END)) AS manual_first_free
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN properties pr ON pr.id = u.property_id
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
        WHERE p.tenant_id = $1
          AND ((p.status = 'pending' AND p.stripe_payment_intent_id IS NULL)
               OR p.status = 'failed')
        ORDER BY p.due_date ASC, p.created_at ASC`,
      [req.user!.profileId])
    const total = Math.round(rows.reduce((sum: number, r: any) => sum + r.amount, 0) * 100) / 100

    // S581 (Nic): group the ledger BY LEASE. Each lease is paid as its own
    // charge (see /pay-balance), so the portal renders one Pay button per
    // lease. A tenant with a single lease (launch norm) gets exactly one group.
    const byLease = new Map<string, {
      leaseId: string; propertyName: string; unitNumber: string
      paymentBlocked: boolean; outstanding: number; rows: any[]
      manualFeePayer: 'tenant' | 'landlord'; manualFirstFree: boolean
    }>()
    // S615: a UTILITY-SERVICE payer's rows carry NO lease_id. Left in the
    // grouping below they would all collapse into one group keyed `null`, and
    // that group would render a Pay button that calls /pay-balance with a null
    // lease — which resolves to a lease filter matching nothing and answers
    // "Nothing outstanding to pay" on a bill the person is looking at. They are
    // split out here and paid per charge instead (see serviceCharges below),
    // which the pay modal already supports.
    const serviceRows = rows.filter((r: any) => r.service_agreement_id != null)
    const leaseRows   = rows.filter((r: any) => r.service_agreement_id == null)

    for (const r of leaseRows) {
      let g = byLease.get(r.lease_id)
      if (!g) {
        g = { leaseId: r.lease_id, propertyName: r.property_name, unitNumber: r.unit_number,
              paymentBlocked: !!r.payment_block, outstanding: 0, rows: [],
              manualFeePayer: r.manual_fee_payer, manualFirstFree: !!r.manual_first_free }
        byLease.set(r.lease_id, g)
      }
      g.outstanding = Math.round((g.outstanding + r.amount) * 100) / 100
      g.rows.push(r)
    }
    // S607 (Nic): "maybe on the invoice, it can show a breakdown of what each
    // bill would be by payment method... that way they see all the avenues and
    // the price at the point the invoice comes out." Priced from the same
    // formula that charges (processingFeeFor), so the quote is honoured.
    const leases = await Promise.all([...byLease.values()].map(async l => {
      const landlordCovers = l.manualFeePayer === 'landlord'
      const manualFee = (landlordCovers || l.manualFirstFree) ? 0 : MANUAL_PAYMENT_FEE
      return {
        ...l,
        methodCosts: paymentMethodCosts(l.outstanding, { manualFee }),
        manualFeeCoveredByLandlord: landlordCovers,
        manualFeeFirstFree: l.manualFirstFree,
        // What the landlord is absorbing on their behalf, so the tenant can see
        // it as a line rather than only as an absence.
        manualFeeAbsorbed: landlordCovers ? MANUAL_PAYMENT_FEE : 0,
        // S609: a SUGGESTION for the amount box — roughly what the balance plus
        // the rest of the lease term's rent comes to. NOT a limit (Nic): a
        // tenant may pay any amount above their balance, because utilities are
        // unknowable until a meter is read and any ceiling lands wrong at the
        // end of a lease.
        suggestedPayAhead: Math.round((l.outstanding + await suggestedPayAheadFor(l.leaseId)) * 100) / 100,
      }
    }))

    // S615: each open charge on a service agreement, paid on its own through
    // the existing per-charge route. Deliberately NOT run through /pay-balance:
    // that path is lease-keyed end to end (FIFO scope, pay-in-full guard,
    // eviction hold, sublease markup), and widening the engine that moves every
    // tenant's rent is a bigger change than billing the neighbour needs.
    // S616 (Nic): the payer's outstanding balance, grouped PER AGREEMENT —
    // exactly the way `leases` above groups a tenant's balance per lease.
    //
    // "Their trash and electric needs to be on one bill if they have more than
    // one utility through this subsystem." The invoice already carries every
    // utility for the cycle; what was wrong was handing the portal a flat list
    // of ROWS, which rendered a Pay button per utility — two charges and two
    // processing fees for one month at one address.
    //
    // Named for the agreement, not "bills": an invoice IS the bill (Nic), and a
    // second name for it alongside `invoices` in the same payload would invent
    // a distinction that does not exist.
    const byAgreement = new Map<string, {
      serviceAgreementId: string; outstanding: number
      unitNumber: string; propertyName: string; dueDate: string
      rows: any[]; methodCosts?: any
    }>()
    for (const r of serviceRows) {
      let g = byAgreement.get(r.service_agreement_id)
      if (!g) {
        g = {
          serviceAgreementId: r.service_agreement_id,
          outstanding: 0,
          unitNumber: r.unit_number,
          propertyName: r.property_name,
          dueDate: r.due_date,
          rows: [],
        }
        byAgreement.set(r.service_agreement_id, g)
      }
      g.outstanding = Math.round((g.outstanding + r.amount) * 100) / 100
      // The oldest date on the bill is the one that matters for lateness.
      if (r.due_date < g.dueDate) g.dueDate = r.due_date
      g.rows.push({
        id: r.id, amount: r.amount, dueDate: r.due_date,
        type: r.type, notes: r.notes,
      })
    }
    const serviceAgreements = [...byAgreement.values()].map(a => ({
      ...a,
      methodCosts: paymentMethodCosts(a.outstanding, { manualFee: 0 }),
    }))

    res.json({ success: true, data: {
      totalOutstanding: total,
      // Legacy scalar retained for older clients: blocked only if EVERY lease
      // is blocked (a per-lease `leases[].paymentBlocked` is the real signal).
      paymentBlocked: leases.length ? leases.every(l => l.paymentBlocked) : false,
      leases,
      serviceAgreements,
      rows,
    } })
  } catch (e) { next(e) }
})

// S539: tenant-facing "where every dollar went" — the tenant's Pay Now
// remittances with their per-line FIFO applications (stored in
// remittance_applications since S537, never surfaced until now), plus
// any prepaid credit still waiting for invoice generation to consume.
paymentsRouter.get('/remittances', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Only tenants can call this endpoint')
    const tenantId = req.user!.profileId

    const remits = await query<any>(
      `SELECT id, amount::float AS amount,
              applied_amount::float AS applied_amount,
              unapplied_amount::float AS unapplied_amount,
              status, payment_method,
              created_at, settled_at
         FROM tenant_remittances
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [tenantId])

    const linesByRemit = new Map<string, any[]>()
    if (remits.length > 0) {
      const lines = await query<any>(
        `SELECT ra.remittance_id, ra.payment_id,
                ra.amount_applied::float AS amount_applied,
                p.type, p.due_date::text AS due_date,
                p.entry_description, p.status AS payment_status
           FROM remittance_applications ra
           JOIN payments p ON p.id = ra.payment_id
          WHERE ra.remittance_id = ANY($1::uuid[])
          ORDER BY p.due_date ASC, p.created_at ASC`,
        [remits.map((r: any) => r.id)])
      for (const ln of lines) {
        const bucket = linesByRemit.get(ln.remittance_id)
        if (bucket) bucket.push(ln)
        else linesByRemit.set(ln.remittance_id, [ln])
      }
    }

    const credits = await query<any>(
      `SELECT id, amount_original::float AS amount_original,
              amount_remaining::float AS amount_remaining, created_at
         FROM lease_prepaid_credits
        WHERE tenant_id = $1 AND amount_remaining > 0
        ORDER BY created_at ASC`,
      [tenantId])
    const prepaidRemaining = Math.round(
      credits.reduce((sum: number, c: any) => sum + c.amount_remaining, 0) * 100) / 100

    res.json({ success: true, data: {
      remittances: remits.map((r: any) => ({ ...r, lines: linesByRemit.get(r.id) ?? [] })),
      prepaidRemaining,
    } })
  } catch (e) { next(e) }
})

paymentsRouter.post('/pay-balance', async (req: any, res, next) => {
  try {
    const body = chargeLeaseBalanceSchema.parse(req.body)
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only tenants can call this endpoint')
    }
    const tenantId = req.user!.profileId

    // S616 (Nic): a payer with no lease — the neighbour buying trash and
    // electric — settles their agreement's whole bill in one charge. "Their
    // trash and electric needs to be on one bill if they have more than one
    // utility through this subsystem." Ownership is checked against the
    // agreement rather than a lease, which they do not have.
    if (body.serviceAgreementId) {
      const owns = await queryOne<{ id: string }>(
        `SELECT id FROM utility_service_agreements
          WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [body.serviceAgreementId, tenantId])
      if (!owns) throw new AppError(404, 'Service agreement not found')
      const result = await chargeLeaseBalance({
        tenantId,
        serviceAgreementId: body.serviceAgreementId,
        amount:            body.amount,
        paymentMethodId:   body.paymentMethodId,
        paymentMethodType: body.paymentMethodType,
        source:            'portal',
      })
      return res.json({ success: true, data: result })
    }

    const leaseId = await resolveTargetLease(tenantId, body.leaseId ?? null)

    // S609: the charge itself lives in services/rentCharge so the autopay
    // runner charges through the exact same code — one implementation of "how
    // rent is charged", never two that can drift.
    const result = await chargeLeaseBalance({
      tenantId,
      leaseId,
      amount:            body.amount,
      paymentMethodId:   body.paymentMethodId,
      paymentMethodType: body.paymentMethodType,
      source:            'portal',
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/payments/:id/record-manual — S562.
//
// Landlord/staff records that a tenant paid a pending rent charge OFF-PLATFORM
// (cash / check / money order). The rent obligation is satisfied WITHOUT GAM
// moving any money: the row is marked settled with platform_held=FALSE,
// stripe_payment_intent_id=NULL, and manual_method set. It reads as "paid"
// everywhere that treats settled as paid (balance / FIFO / late-fee / rent-roll),
// while the weekly batch (services/landlordPassthrough.ts) SKIPS it because that
// path requires platform_held=TRUE — so the landlord, who already physically
// holds the cash, is never double-paid. type='fee' rows aren't disbursed either,
// so the $10 fee below stays GAM revenue (same as RETURNFEE).
//
// Each manual payment carries a flat $10 fee (a tenant-owed 'fee' row,
// entry_description 'MANUALPAY') EXCEPT the tenant's FIRST rent payment on the
// lease — waived to give them time to onboard ACH. The tenant portal discloses
// the future $10 charge.
//
// Auth: requirePerm('take_payment') (owner roles auto-pass; staff need the
// take_payment sub-permission). canManageLandlordResource confirms scope.
const recordManualSchema = z.object({
  method:    z.enum(MANUAL_PAYMENT_METHODS),   // 'cash' | 'check' | 'money_order'
  reference: z.string().max(120).optional(),   // check # / money-order # for the audit trail
})

paymentsRouter.post('/:id/record-manual', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = recordManualSchema.parse(req.body)
    await client.query('BEGIN')

    // Lock the rent row so a concurrent /pay can't settle it underneath us.
    const pmt = (await client.query<any>(
      // S607: the properties join is gone with the 21-day gate it fed — nothing
      // else in this route needed it.
      `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.unit_id,
              p.lease_id, p.amount::float AS amount, p.due_date::text AS due_date,
              u.payment_block,
              COALESCE(par.manual_fee_payer, 'tenant') AS manual_fee_payer,
              -- S620: screened tenants do not get the free first manual
              -- payment; see the waiver comment below.
              t.background_check_status
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         LEFT JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [req.params.id])).rows[0]
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, pmt.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (pmt.type !== 'rent') {
      throw new AppError(409, 'Only rent charges can be recorded as a manual payment')
    }
    if (pmt.status !== 'pending' && pmt.status !== 'failed') {
      throw new AppError(409, `This charge is not open (status: ${pmt.status})`)
    }
    // Eviction pause (matches the tenant pay routes): accepting/booking landlord-
    // bound money can reset the eviction timeline, so recording is blocked too.
    if (pmt.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused. Contact the landlord.')
    }

    // Waiver (Nic, S607 — supersedes the S570 two-part rule): the $10 manual fee
    // is waived when this is the tenant's FIRST satisfied rent on the lease.
    // Because this code only runs inside record-manual, that is exactly Nic's
    // rule: "only the first payment ran through the platform, and only if it was
    // cash on that first payment. If they pay card the first time, they lose that
    // freebie." A tenant who paid an earlier invoice by card has priorPaid > 0 and
    // gets no waiver on a later manual payment.
    //
    // THE 21-DAY PROPERTY-CREATION GATE IS GONE (Nic): "the anchor is wrong."
    // It counted from properties.created_at, so it burned down during the
    // landlord's SETUP — meters, units, templates, invites — and tenants
    // inherited whatever slice was left. At Oak Park that was four days. The
    // waiver is meant to give each tenant one gentle first payment, not to reward
    // whoever happened to pay while the park was still being configured.
    //
    // Deliberately NO date gate of any kind. Nic: "I like not gating it because I
    // specifically have people at Oak Park that come in on the fifth because of
    // the grace period." A tenant paying September rent on the 10th still gets
    // their one free manual payment — they simply owe whatever LATE FEES have
    // accrued by then, which is a separate charge on a separate clock.
    //
    // Rent rows carry a lease_id in production; fall back to tenant_id if absent.
    const scopeCol = pmt.lease_id ? 'lease_id' : 'tenant_id'
    const scopeVal = pmt.lease_id ?? pmt.tenant_id
    const priorPaid = (await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payments
        WHERE ${scopeCol} = $1 AND type = 'rent'
          AND status IN ('settled', 'paid_via_deposit')
          AND id <> $2`,
      [scopeVal, pmt.id])).rows[0]
    // S607 (Nic): exactly ONE thing makes this fee free — the tenant's FIRST
    // rent payment, paid this way. Nothing else.
    //
    //   "It's only free the first payment and only if they do cash. If they do
    //    any old school payments any other months, that's not free."
    //
    // The landlord's toggle does NOT waive the fee, it MOVES it. An earlier cut
    // of this treated 'landlord covers' as 'nobody pays', which quietly billed
    // GAM's $10 to no one at all. Nic: "if they use cash the second month and the
    // landlord covers, that means the LANDLORD gets charged."
    const landlordCovers = pmt.manual_fee_payer === 'landlord'
    const firstPayment = parseInt(priorPaid.n, 10) === 0

    // S620 (Nic): the free first payment exists to help a LANDLORD MIGRATE the
    // tenants they already have — not as a perk for everyone who ever signs up.
    //
    //   "It's not a thing for other tenants that just sign up later on and
    //    exist. It's to help the onboarding flow for landlords... anybody that
    //    does the background check workflow through Checkr, they do not get
    //    that protection window."
    //
    // The background check IS the discriminator, and it beats a date window:
    // an existing tenant being carried over is never screened (they already
    // live there), while after the 21-day onboarding window the ONLY way to
    // add a tenant is through screening. So the status encodes the window for
    // free and cannot drift out of sync with it.
    //
    // 'not_started' and 'waived' mean nobody ran a check — a migrated tenant.
    // Anything else means they came through the screening flow and pay the $10.
    const screened = !['not_started', 'waived', null, undefined]
      .includes(pmt.background_check_status as any)
    const feeWaived = firstPayment && !screened       // free — and only this
    const feeToLandlord = !feeWaived && landlordCovers // moved, not erased
    const feeToTenant  = !feeWaived && !landlordCovers

    // Satisfy the rent obligation off-platform. platform_held stays FALSE.
    const refNote = body.reference ? ` (ref ${body.reference})` : ''
    await client.query(
      `UPDATE payments
          SET status = 'settled', settled_at = NOW(), manual_method = $2,
              platform_held = FALSE,
              notes = COALESCE(notes || ' — ', '') || $3
        WHERE id = $1`,
      [pmt.id, body.method, `Recorded as manual ${body.method} payment${refNote}`])

    // The flat manual-payment fee — GAM revenue either way. Billed to the tenant
    // as an ordinary charge, or posted straight to GAM's revenue ledger when the
    // landlord absorbs it (their payouts net it out, the same route the
    // landlord-borne platform fee takes).
    let feePaymentId: string | null = null
    if (feeToLandlord) {
      const prev = await client.query<{ balance_after: string }>(
        `SELECT balance_after FROM platform_revenue_ledger
          ORDER BY created_at DESC, id DESC LIMIT 1`)
      const prevBal = prev.rowCount ? parseFloat(prev.rows[0].balance_after) : 0
      // Idempotent on (reference_id, reference_type, type) — a retried recording
      // cannot post the fee twice.
      await client.query(
        `INSERT INTO platform_revenue_ledger
           (type, amount, balance_after, reference_id, reference_type, property_id, notes)
         SELECT 'manual_withdrawal_fee', $1, $2, $3, 'manual_payment_fee', u.property_id, $4
           FROM units u WHERE u.id = $5
         ON CONFLICT (reference_id, reference_type, type) WHERE reference_id IS NOT NULL
         DO NOTHING`,
        [MANUAL_PAYMENT_FEE.toFixed(2),
         (Math.round((prevBal + MANUAL_PAYMENT_FEE) * 100) / 100).toFixed(2),
         pmt.id,
         `$${MANUAL_PAYMENT_FEE.toFixed(2)} manual-payment fee absorbed by the landlord — ${body.method} rent payment due ${pmt.due_date}`,
         pmt.unit_id])

      // S620: and RECORD THAT THE LANDLORD OWES IT. The line above books the
      // fee as GAM revenue; nothing recorded that GAM had not actually been
      // paid. A cash payment moves no money through GAM, so there was nothing
      // to net it out of and no trace it was owed — GAM was booking income it
      // had no mechanism to collect. This charge is what the next disbursement
      // nets against.
      const propRow = await client.query<{ property_id: string }>(
        `SELECT property_id FROM units WHERE id = $1`, [pmt.unit_id])
      await chargeLandlord(client, {
        landlordId: pmt.landlord_id,
        propertyId: propRow.rows[0]?.property_id ?? null,
        kind: 'manual_payment_fee',
        amount: MANUAL_PAYMENT_FEE,
        sourceType: 'manual_payment_fee',
        sourceId: pmt.id,
        notes: `${body.method} rent payment due ${pmt.due_date} — fee absorbed by the landlord`,
      })
    }
    if (feeToTenant) {
      feePaymentId = (await client.query<{ id: string }>(
        // NO invoice_id, DELIBERATELY. S620 (Nic): "let's make sure that one
        // little fee doesn't start accruing extra late fees" — it is already a
        // fee, and a money order made out for the wrong amount can leave it
        // sitting unpaid for days or into the next cycle.
        //
        // The late-fee engine works invoice by invoice, so a row belonging to
        // no invoice is invisible to it and CANNOT grow. That matters most on
        // leases whose late fee accrues DAILY against the outstanding balance
        // rather than as a flat percentage — a percentage would add pennies to
        // this, a daily accrual would compound on it indefinitely.
        //
        // DO NOT attach these to an invoice. The protection is the absence.
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, notes, revenue_owner)
         -- -- S609: GAM's own fee (REVENUE_OWNERS, packages/shared) — never an owner share. Nic confirmed S609 this one stays
         -- GAM's: it covers manual reconciliation and both Terms documents say so.
         VALUES ($1, $2, $3, $4, 'fee', $5, 'pending', 'MANUALPAY', CURRENT_DATE, $6, 'gam')
         RETURNING id`,
        [pmt.unit_id, pmt.lease_id, pmt.tenant_id, pmt.landlord_id,
         MANUAL_PAYMENT_FEE.toFixed(2),
         `$${MANUAL_PAYMENT_FEE.toFixed(2)} manual-payment fee — ${body.method} rent payment due ${pmt.due_date}`])).rows[0].id
    }

    await client.query('COMMIT')
    res.json({
      success: true,
      data: {
        paymentId:    pmt.id,
        status:       'settled',
        method:       body.method,
        feeWaived,
        feeAmount:    feeWaived ? 0 : MANUAL_PAYMENT_FEE,
        // Who the fee landed on. 'tenant' raises a charge they must pay;
        // 'landlord' posts it to GAM revenue and nets out of their payout;
        // 'none' only ever means the free first payment.
        feeBilledTo:  feeWaived ? 'none' : (landlordCovers ? 'landlord' : 'tenant'),
        feePaymentId,
        // S607: these are now TWO different reasons a fee was not raised, and
        // the caller must be able to tell them apart — "your first one is free"
        // and "your landlord covers this" are different things to say to a
        // tenant, and only one of them stops being true next month.
        firstPayment: parseInt(priorPaid.n, 10) === 0,
        coveredByLandlord: landlordCovers,
      },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// POST /api/payments/:id/record-prior-arrangement — S568 (Nic).
// Onboarding-transition ONLY: mark the FIRST rent charge of an IMPORTED lease as
// paid via a prior off-platform arrangement. It comes off the books, no money
// moves, and NO manual-payment fee is charged. Distinct from record-manual (a
// cash/check received now) — this is "already paid before they came onto GAM."
//
// Hard gating (all enforced here, no landlord toggle): rent charge, still open,
// lease_source='imported' (a brand-new GAM lease has no prior arrangement),
// within PRIOR_ARRANGEMENT_TRANSITION_DAYS of onboarding, and it must be the
// FIRST rent charge (no already-satisfied rent on the lease). Fee-free always.
paymentsRouter.post('/:id/record-prior-arrangement', requirePerm('take_payment'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const pmt = (await client.query<any>(
      `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.lease_id,
              p.due_date::text AS due_date, u.payment_block,
              (ld.reconciliation_until IS NOT NULL AND ld.reconciliation_until > NOW()) AS within_window
         FROM payments p
         JOIN units u ON u.id = p.unit_id
         JOIN landlords ld ON ld.id = p.landlord_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [req.params.id])).rows[0]
    if (!pmt) throw new AppError(404, 'Payment not found')
    if (!canManageLandlordResource(req.user, pmt.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (pmt.type !== 'rent') {
      throw new AppError(409, 'Only a rent charge can be marked as a prior arrangement')
    }
    if (pmt.status !== 'pending' && pmt.status !== 'failed') {
      throw new AppError(409, `This charge is not open (status: ${pmt.status})`)
    }
    if (pmt.payment_block) {
      throw new AppError(409, 'This unit is in eviction mode — recording a payment is paused.')
    }
    // Landlord onboarding reconciliation window only (old-system autopay overlap).
    // New-vs-imported is irrelevant; what matters is the landlord still migrating.
    if (!pmt.within_window) {
      throw new AppError(409, 'The onboarding reconciliation window has closed for this landlord — record payments normally.')
    }
    // First rent charge only — no already-satisfied rent on the lease.
    const priorPaid = (await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payments
        WHERE lease_id = $1 AND type = 'rent'
          AND status IN ('settled', 'paid_via_deposit') AND id <> $2`,
      [pmt.lease_id, pmt.id])).rows[0]
    if (parseInt(priorPaid.n, 10) > 0) {
      throw new AppError(409, 'Prior-arrangement only applies to the first rent charge; a later rent charge has already been paid.')
    }

    // Satisfy the obligation off-platform. platform_held FALSE, no fee row.
    await client.query(
      `UPDATE payments
          SET status = 'settled', settled_at = NOW(), manual_method = $2,
              platform_held = FALSE,
              notes = COALESCE(notes || ' — ', '') ||
                      'Paid off-platform via prior arrangement (onboarding transition)'
        WHERE id = $1`,
      [pmt.id, PRIOR_ARRANGEMENT_METHOD])

    await client.query('COMMIT')
    res.json({
      success: true,
      data: { paymentId: pmt.id, status: 'settled', method: PRIOR_ARRANGEMENT_METHOD, feeCharged: false },
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})
