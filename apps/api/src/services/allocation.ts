/**
 * 16a Step 2: rent allocation engine.
 *
 * Single entry point: executeRentAllocation(client, paymentId, paymentMethod).
 * Caller (Stripe webhook) is responsible for the surrounding transaction.
 *
 * Splits a settled rent payment into:
 *   - allocation_owner_share   → user_balance_ledger (property owner)
 *   - allocation_manager_fee   → user_balance_ledger (property manager) [if separate]
 *   - banking_spread           → platform_revenue_ledger (GAM margin)
 *
 * Margin (banking_spread) is the difference between customer_facing rate
 * and stripe_cost rate. GAM never absorbs banking fees — landlord chooses
 * pass-through ('tenant') or absorb ('landlord') per fee, via the three
 * S116 per-property toggles: ach_fee_payer, card_fee_payer, platform_fee_payer.
 * The first two govern this engine; platform_fee_payer is consumed by the
 * monthly platform fee accrual job (S120).
 *
 * Idempotent: ux_user_balance_ledger_idempotent + ux_platform_revenue_ledger_idempotent
 * unique indexes prevent double-allocation on Stripe webhook redelivery.
 *
 * S64 scope: rent_percent (with floor/ceiling) only.
 * Deferred: flat_monthly_fee, per_unit_fee (monthly accrual job),
 *           placement_fee_share, maintenance_markup.
 */

import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler'

export type PaymentMethod = 'ach' | 'card'

const ALLOCATION_TYPES = [
  'allocation_owner_share',
  'allocation_manager_fee',
  'allocation_pm_company_fee',
] as const
type AllocationLedgerType = typeof ALLOCATION_TYPES[number]

interface PaymentRow {
  id: string
  unit_id: string | null
  type: string
  amount: string
  status: string
  gam_supersedence_amount: string
  sublease_markup_amount: string
  stripe_payment_intent_id: string | null
}

interface PropertyAndRuleRow {
  property_id: string
  owner_user_id: string
  managed_by_user_id: string
  // S116: three independent fee toggles replace the legacy banking_fee_payer.
  // The rate engine reads ach_fee_payer or card_fee_payer based on the
  // payment method; platform_fee_payer is consumed by the platform fee
  // accrual job (S120), not here.
  ach_fee_payer: 'landlord' | 'tenant' | null
  card_fee_payer: 'landlord' | 'tenant' | null
  platform_fee_payer: 'landlord' | 'tenant' | null
  rent_percent: string | null
  rent_percent_floor: string | null
  rent_percent_ceiling: string | null
  owner_bank_account_id: string | null
  pm_company_id: string | null
  pm_fee_plan_id: string | null
}

// S110: PM company cut data — joined when properties.pm_company_id is set.
// Plan fields are nullable per S108's loose-CHECK design; the rent-flow
// evaluator below only looks at fields relevant to recurring rent.
// (leasing_fee + maintenance_markup_pct fire on different triggers and
// are no-ops here.)
interface PmFeeRow {
  pm_bank_account_id: string | null    // pm_companies.bank_account_id
  pm_payout_user_id: string | null     // user_bank_accounts.user_id behind that bank
  fee_type: string
  percent: string | null
  flat_amount: string | null
  floor_amount: string | null
  ceiling_amount: string | null
}

interface ProcessingRateRow {
  customer_facing_flat: string | null
  customer_facing_percent: string | null
  customer_facing_cap: string | null
  stripe_cost_flat: string | null
  stripe_cost_percent: string | null
  stripe_cost_cap: string | null
}

/**
 * S603: what did Stripe ACTUALLY process, and which rows did it cover?
 *
 * A single charge can settle several payment rows (the FIFO lump in
 * /pay-balance stamps its PaymentIntent on every covered row). The processing
 * fee was charged ONCE against the whole lump, so allocation must reason about
 * the charge — not the row it happens to be looking at.
 *
 *   feeBase       — the sum the fee was computed against, i.e. what the tenant
 *                   chose to pay. Matches /pay-balance's `body.amount`.
 *   allocTotal    — sum of the rows allocation actually runs for (rent/utility),
 *                   which is what the fee gets apportioned across.
 *   isLastRow     — deterministic (id order) so exactly one row absorbs the
 *                   rounding remainder.
 *
 * A payment with no PaymentIntent (a recorded cash/check payment) is its own
 * charge of one row, which collapses to the pre-S603 behaviour.
 */
interface ChargeContext {
  feeBase:    number
  allocTotal: number
  isLastRow:  boolean
  priorRows:  { id: string; amount: number }[]
}

async function resolveChargeContext(
  client: PoolClient,
  payment: PaymentRow,
): Promise<ChargeContext> {
  const amount = parseFloat(payment.amount)
  const pi = payment.stripe_payment_intent_id
  if (!pi) {
    return { feeBase: amount, allocTotal: amount, isLastRow: true, priorRows: [] }
  }

  // Every row this charge settled. feeBase counts them ALL (a fee row swept up
  // by FIFO was part of what the tenant paid, so the fee was computed on it);
  // the apportionment set is only the rent/utility rows, because those are the
  // ones that produce ledger entries.
  const res = await client.query<{ id: string; amount: string; type: string }>(
    `SELECT id, amount::text AS amount, type
       FROM payments
      WHERE stripe_payment_intent_id = $1 AND status = 'settled'
      ORDER BY id`,
    [pi],
  )
  const all = res.rows
  if (all.length === 0) {
    return { feeBase: amount, allocTotal: amount, isLastRow: true, priorRows: [] }
  }

  const feeBase = round2(all.reduce((sum, r) => sum + parseFloat(r.amount), 0))
  const allocRows = all
    .filter(r => r.type === 'rent' || r.type === 'utility')
    .map(r => ({ id: r.id, amount: parseFloat(r.amount) }))
  const allocTotal = round2(allocRows.reduce((sum, r) => sum + r.amount, 0))

  const idx = allocRows.findIndex(r => r.id === payment.id)
  return {
    feeBase,
    allocTotal: allocTotal > 0 ? allocTotal : amount,
    isLastRow: idx === -1 || idx === allocRows.length - 1,
    priorRows: idx > 0 ? allocRows.slice(0, idx) : [],
  }
}

/**
 * S603: this row's share of a charge-wide amount, by its share of the covered
 * rows. The last row takes `whole - everything already given out` so the pieces
 * sum to the whole exactly — never a cent lost or invented.
 */
function apportion(whole: number, charge: ChargeContext, rowAmount: number): number {
  if (charge.allocTotal <= 0) return whole
  if (charge.isLastRow) {
    const given = charge.priorRows.reduce(
      (sum, r) => sum + round2(whole * (r.amount / charge.allocTotal)), 0)
    return round2(whole - given)
  }
  return round2(whole * (rowAmount / charge.allocTotal))
}

export async function executeRentAllocation(
  client: PoolClient,
  paymentId: string,
  paymentMethod: PaymentMethod
): Promise<void> {
  // 1. Lock + fetch payment row
  const payment = await fetchPayment(client, paymentId)

  // 2. Idempotency short-circuit (real guard is the unique index)
  if (await alreadyAllocated(client, paymentId)) {
    return
  }

  // 3. Resolve property + allocation rule via unit
  const prop = await fetchPropertyAndRule(client, payment.unit_id!)

  // 4. Resolve active processing rate
  const rate = await fetchActiveProcessingRate(client, paymentMethod)

  // 5. Compute splits
  const gross = parseFloat(payment.amount)
  const cfFlat = parseFloat(rate.customer_facing_flat!)
  const cfPercent = parseFloat(rate.customer_facing_percent!)
  const scFlat = parseFloat(rate.stripe_cost_flat!)
  const scPercent = parseFloat(rate.stripe_cost_percent!)
  // S551: caps are nullable — NULL means uncapped. The ACH row carries the
  // $6.00 customer cap ($3.00 cost cap) of the locked S113/S551 schedule.
  const cfCap = rate.customer_facing_cap != null ? parseFloat(rate.customer_facing_cap) : Infinity
  const scCap = rate.stripe_cost_cap != null ? parseFloat(rate.stripe_cost_cap) : Infinity

  // S603 (Nic): "We cannot have a discrepancy between landlord and the platform
  // with how much was processed... We have to be 100% accurate everywhere."
  //
  // Pre-S603 this computed BOTH fees from THIS ROW ALONE, which was wrong twice:
  //
  //   (A) The customer-facing fee was re-derived per row. Allocation runs once
  //       per settled row (webhooks.ts loops `settled.rows`), so a single charge
  //       covering a rent row AND a utility row booked the FLAT $6 ACH fee
  //       TWICE — $12 booked against $6 actually charged. With
  //       ach_fee_payer='landlord' that came straight out of the landlord's
  //       share (`splittable = gross - fee`), so the landlord was short real
  //       money. With the tenant paying, GAM booked revenue that never existed.
  //
  //   (B) Stripe's cost was measured against the RENT line, but Stripe bills on
  //       what it actually PROCESSED — rent plus any tenant-borne fee riding on
  //       top. Proven on the S600 live charge: $2.33 processed ($2.00 rent +
  //       $0.33 fee) was billed a $0.02 volume fee; 0.7% x $2.33 = $0.0163 -> 2c,
  //       whereas 0.7% x $2.00 would be 1c. Stripe has no idea part of the
  //       amount is GAM's fee.
  //
  // Fix: compute the fee and the cost ONCE for the whole charge — exactly as
  // routes/payments.ts /pay-balance did when it created it — then apportion
  // both across the rows that charge covered, by amount. Totals across all the
  // per-row allocations now equal what actually happened, penny for penny.
  const charge = await resolveChargeContext(client, payment)

  const wholeCustomerFee = round2(Math.min(cfFlat + charge.feeBase * (cfPercent / 100), cfCap))

  // A landlord-paid fee is DEDUCTED from the rent rather than added on top, so
  // Stripe only ever processed the rent itself. Tenant-paid rides on top and
  // Stripe takes its percentage of the grossed-up total.
  const feePayerForBase = paymentMethod === 'ach' ? prop.ach_fee_payer : prop.card_fee_payer
  const processedAmount = feePayerForBase === 'landlord'
    ? charge.feeBase
    : round2(charge.feeBase + wholeCustomerFee)

  const wholeStripeCost = round2(Math.min(scFlat + processedAmount * (scPercent / 100), scCap))

  // Apportion by this row's share of the charge. The LAST row (deterministic
  // id order) absorbs the rounding remainder so the per-row pieces sum to the
  // whole exactly — otherwise a 3-way split loses or invents a cent.
  const customerFacingFee = apportion(wholeCustomerFee, charge, gross)
  const stripeCost        = apportion(wholeStripeCost, charge, gross)
  const bankingSpread = round2(customerFacingFee - stripeCost)

  // S116: pick the right fee toggle based on the payment method.
  // ach_fee_payer applies to ACH; card_fee_payer applies to card.
  // platform_fee_payer is unrelated to per-payment processing — it
  // governs the monthly platform fee accrual (S120).
  // Same toggle as feePayerForBase above; kept as its own name because the
  // split math below reads it. `customerFacingFee` here is THIS ROW'S SHARE of
  // the one real fee, so a landlord-paid fee is deducted once across the
  // charge rather than once per row.
  const processingFeePayer = paymentMethod === 'ach'
    ? prop.ach_fee_payer
    : prop.card_fee_payer
  const splittable = processingFeePayer === 'landlord'
    ? round2(gross - customerFacingFee)
    : gross

  if (splittable < 0) {
    throw new AppError(409,
      `Allocation produced negative splittable amount (gross=${gross}, fee=${customerFacingFee}). ` +
      `Check rate config or ${paymentMethod}_fee_payer for property ${prop.property_id}.`
    )
  }

  // S261: GAM-supersedence — Q2a (PM cut on gross). PM company fee and
  // manager fee compute off `splittable` (pre-supersedence) so the PM
  // is contractually whole on the rent the tenant paid. The OWNER
  // share absorbs the supersedence cut — the landlord's Connect
  // received gross - app_fee_amount - (boost portion of app_fee). The
  // boost amount was already redirected to GAM at charge time; this
  // ledger entry reflects what actually landed in the landlord's
  // bank, not the gross.
  const supersedenceAmount = round2(parseFloat(payment.gam_supersedence_amount || '0'))

  // S581: sublease markup. When a SUBLESSEE paid, the invoice was for
  // sub_monthly_amount but the LANDLORD is only owed master_share_amount — the
  // difference (markup) goes to the SUBLESSOR (creditSublessorMarkupForPayment
  // credits it that same stamped amount at settle). So it comes out of the owner
  // share here, exactly like the GAM-supersedence boost: both are portions of the
  // gross the landlord never receives. 0 for non-sublease / full-pass-through
  // payments. (Pre-S581 this was dropped: owner_share was computed on the full
  // sub amount AND the sublessor was credited — GAM ate the markup.)
  const subleaseMarkup = round2(parseFloat(payment.sublease_markup_amount || '0'))

  // S110: PM company cut (third-party PM contracted on this property).
  // When properties.pm_company_id is set, the PM company REPLACES the
  // in-house manager fee — rent splits into (PM cut, owner share, banking
  // spread). The in-house manager fee path below is skipped because the
  // PM company is doing that role.
  let pmCompanyFee = 0
  let pmContext: PmFeeRow | null = null
  if (prop.pm_company_id !== null && prop.pm_fee_plan_id !== null) {
    pmContext = await fetchPmFeeContext(client, prop.pm_company_id, prop.pm_fee_plan_id)
    if (pmContext === null) {
      throw new AppError(409,
        `Property ${prop.property_id} references pm_company_id=${prop.pm_company_id} ` +
        `with pm_fee_plan_id=${prop.pm_fee_plan_id} but the join returned no rows. ` +
        `Verify the plan still exists and belongs to the company.`)
    }
    if (pmContext.pm_payout_user_id === null) {
      throw new AppError(409,
        `PM company ${prop.pm_company_id} has no bank routing (bank_account_id is null). ` +
        `Set bank_account_id on the pm_company before this property's rent can be allocated.`)
    }
    pmCompanyFee = computePmCutForRent(pmContext, splittable)
  }

  if (pmCompanyFee > splittable) {
    throw new AppError(409,
      `PM company fee (${pmCompanyFee}) exceeds splittable amount (${splittable}) for property ${prop.property_id}. ` +
      `Floor/ceiling config on pm_fee_plan ${prop.pm_fee_plan_id} invalid.`
    )
  }

  // Manager fee: rent_percent (with floor/ceiling clamp).
  // Skipped if (a) owner is self-managing, OR (b) a PM company is
  // contracted (the PM cut takes the manager-role's place).
  let managerFee = 0
  const ownerSelfManaged = prop.owner_user_id === prop.managed_by_user_id
  const pmCompanyContracted = prop.pm_company_id !== null
  if (!ownerSelfManaged && !pmCompanyContracted && prop.rent_percent !== null) {
    const pct = parseFloat(prop.rent_percent)
    let mc = round2(splittable * (pct / 100))
    if (prop.rent_percent_floor !== null) {
      const floor = parseFloat(prop.rent_percent_floor)
      if (mc < floor) mc = floor
    }
    if (prop.rent_percent_ceiling !== null) {
      const ceiling = parseFloat(prop.rent_percent_ceiling)
      if (mc > ceiling) mc = ceiling
    }
    managerFee = mc
  }

  if (managerFee + pmCompanyFee > splittable) {
    throw new AppError(409,
      `Manager fee (${managerFee}) + PM company fee (${pmCompanyFee}) exceeds splittable amount (${splittable}) for property ${prop.property_id}.`
    )
  }

  const ownerShare = round2(splittable - managerFee - pmCompanyFee - supersedenceAmount - subleaseMarkup)
  if (ownerShare < 0) {
    // Supersedence boost exceeded the splittable minus fees. By design
    // we cap the boost at `amount` (the payment amount) at PI creation
    // time, but PM/manager fees can push owner_share negative in edge
    // cases (e.g. high PM percent on a thin-margin property). The
    // PaymentIntent has already settled; flag for admin review rather
    // than rolling back. Owner ledger is clamped to 0 so the audit
    // trail doesn't double-count.
    throw new AppError(409,
      `Allocation produced negative owner_share for payment ${payment.id} ` +
      `(splittable=${splittable}, manager=${managerFee}, pm=${pmCompanyFee}, supersedence=${supersedenceAmount}, subleaseMarkup=${subleaseMarkup}). ` +
      `Property ${prop.property_id} fee config + supersedence boost combined to exceed splittable.`
    )
  }

  // 6. Post ledger entries.
  // Bank account snapshot semantics: stamp the routing target at write time.
  // Owner_share routes via the per-property bank assignment; manager_fee via
  // the manager's per-user default. NULL is acceptable on both; autoPayouts
  // will skip rows lacking a bank_account_id and they'll accumulate visible
  // balance until the assignment is corrected.
  await postUserLedgerEntry(client, {
    userId: prop.owner_user_id,
    type: 'allocation_owner_share',
    amount: ownerShare,
    referenceId: payment.id,
    referenceType: 'payment',
    propertyId: prop.property_id,
    bankAccountId: prop.owner_bank_account_id,
    notes: `Owner share of rent payment ${payment.id}`,
  })

  if (managerFee > 0) {
    const managerBankAccountId = await fetchUserDefaultManagementBank(
      client, prop.managed_by_user_id
    )
    await postUserLedgerEntry(client, {
      userId: prop.managed_by_user_id,
      type: 'allocation_manager_fee',
      amount: managerFee,
      referenceId: payment.id,
      referenceType: 'payment',
      propertyId: prop.property_id,
      bankAccountId: managerBankAccountId,
      notes: `Manager fee from rent payment ${payment.id}`,
    })
  }

  // S110: PM company cut entry. user_id = the user owning the pm_company's
  // assigned bank account (16a invariant: ledger entries are user-scoped;
  // the bank's owner is the recipient). bank_account_id is snapshotted at
  // write time so future bank reassignments don't retroactively re-route.
  if (pmCompanyFee > 0 && pmContext) {
    await postUserLedgerEntry(client, {
      userId: pmContext.pm_payout_user_id!,
      type: 'allocation_pm_company_fee',
      amount: pmCompanyFee,
      referenceId: payment.id,
      referenceType: 'payment',
      propertyId: prop.property_id,
      bankAccountId: pmContext.pm_bank_account_id,
      notes: `PM company fee (plan ${prop.pm_fee_plan_id}) from rent payment ${payment.id}`,
    })
  }

  if (bankingSpread !== 0) {
    await postPlatformLedgerEntry(client, {
      type: 'banking_spread',
      amount: bankingSpread,
      referenceId: payment.id,
      referenceType: 'payment',
      propertyId: prop.property_id,
      notes: `Banking spread on ${paymentMethod} rent payment ${payment.id}`,
    })
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

async function fetchPayment(client: PoolClient, paymentId: string): Promise<PaymentRow> {
  const res = await client.query<PaymentRow>(
    `SELECT id, unit_id, type, amount::text AS amount, status,
            gam_supersedence_amount::text AS gam_supersedence_amount,
            sublease_markup_amount::text AS sublease_markup_amount,
            stripe_payment_intent_id
       FROM payments WHERE id=$1 FOR UPDATE`,
    [paymentId]
  )
  const payment = res.rows[0]
  if (!payment) throw new AppError(404, `Payment ${paymentId} not found`)
  // S122: utility payments use the same allocation engine — same
  // banking-fee math, same owner/PM split, just a different
  // entry_description on the payment row. Webhook handler routes both
  // types here; reject anything else.
  if (payment.type !== 'rent' && payment.type !== 'utility') {
    throw new AppError(400,
      `executeRentAllocation requires payment.type IN ('rent','utility'), got '${payment.type}' (payment ${paymentId})`)
  }
  if (payment.status !== 'settled') {
    throw new AppError(400,
      `executeRentAllocation requires payment.status='settled', got '${payment.status}' (payment ${paymentId})`)
  }
  if (!payment.unit_id) {
    throw new AppError(400, `Payment ${paymentId} missing unit_id; cannot resolve property`)
  }
  return payment
}

async function alreadyAllocated(client: PoolClient, paymentId: string): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM user_balance_ledger
        WHERE reference_id=$1 AND reference_type='payment'
          AND type IN ('allocation_owner_share', 'allocation_manager_fee', 'allocation_pm_company_fee')
     ) AS exists`,
    [paymentId]
  )
  return res.rows[0].exists
}

async function fetchPropertyAndRule(client: PoolClient, unitId: string): Promise<PropertyAndRuleRow> {
  const res = await client.query<PropertyAndRuleRow>(
    `SELECT p.id AS property_id,
            p.owner_user_id,
            p.managed_by_user_id,
            p.pm_company_id,
            p.pm_fee_plan_id,
            r.ach_fee_payer,
            r.card_fee_payer,
            r.platform_fee_payer,
            r.rent_percent,
            r.rent_percent_floor,
            r.rent_percent_ceiling,
            r.owner_bank_account_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
  LEFT JOIN property_allocation_rules r ON r.property_id = p.id
      WHERE u.id=$1`,
    [unitId]
  )
  if (res.rowCount === 0) {
    throw new AppError(404, `Unit ${unitId} not found`)
  }
  const row = res.rows[0]
  // S116: the three new toggles are NOT NULL on rows backed by a rule.
  // If any is null, the property has no allocation rule (LEFT JOIN miss).
  if (row.ach_fee_payer === null || row.card_fee_payer === null) {
    throw new AppError(409,
      `Property ${row.property_id} has no allocation rule. ` +
      `An allocation rule is required before rent allocation can run.`)
  }
  return row
}

async function fetchActiveProcessingRate(
  client: PoolClient,
  paymentMethod: PaymentMethod
): Promise<ProcessingRateRow> {
  const res = await client.query<ProcessingRateRow>(
    `SELECT customer_facing_flat, customer_facing_percent, customer_facing_cap,
            stripe_cost_flat, stripe_cost_percent, stripe_cost_cap
       FROM platform_processing_rates
      WHERE payment_method=$1 AND effective_until IS NULL
      LIMIT 1`,
    [paymentMethod]
  )
  if (res.rowCount === 0) {
    throw new AppError(500, `No active processing rate for payment_method=${paymentMethod}`)
  }
  const rate = res.rows[0]
  if (
    rate.customer_facing_flat === null ||
    rate.customer_facing_percent === null ||
    rate.stripe_cost_flat === null ||
    rate.stripe_cost_percent === null
  ) {
    throw new AppError(503,
      `Processing rates for payment_method=${paymentMethod} not configured. ` +
      `Set rates in platform_processing_rates before enabling rent allocation.`)
  }
  return rate
}

// S110: pull pm_fee_plan + pm_company bank routing for a property. Returns
// null when either side isn't configured (no PM contracted, or PM hasn't
// set bank routing — which the property-assignment route should have
// blocked, but allocation defends in depth).
async function fetchPmFeeContext(
  client: PoolClient,
  pmCompanyId: string,
  pmFeePlanId: string
): Promise<PmFeeRow | null> {
  const res = await client.query<PmFeeRow>(
    `SELECT c.bank_account_id AS pm_bank_account_id,
            ba.user_id        AS pm_payout_user_id,
            fp.fee_type, fp.percent, fp.flat_amount,
            fp.floor_amount, fp.ceiling_amount
       FROM pm_companies c
       JOIN pm_fee_plans fp ON fp.id = $2 AND fp.pm_company_id = c.id
  LEFT JOIN user_bank_accounts ba ON ba.id = c.bank_account_id
      WHERE c.id = $1`,
    [pmCompanyId, pmFeePlanId]
  )
  if (res.rowCount === 0) return null
  return res.rows[0]
}

// S110/S111: evaluate the PM cut against the rent gross. Only PERCENT-based
// fee types fire from the per-payment path. flat_monthly + per_unit fire
// from the monthly accrual job (services/monthlyFeeAccrual) — same trigger
// split as the in-house manager fee model (rent_percent → per-payment;
// flat_monthly_fee + per_unit_fee → monthly). Mirroring the split prevents
// double-counting when rent payments arrive multiple times in a month.
// leasing_fee fires from the lease-creation hook (S111); maintenance_markup_pct
// fires from the maintenance invoice flow (deferred).
function computePmCutForRent(plan: PmFeeRow, splittable: number): number {
  switch (plan.fee_type) {
    case 'percent_of_rent': {
      if (plan.percent === null) return 0
      return round2(splittable * (parseFloat(plan.percent) / 100))
    }
    case 'percent_with_floor': {
      if (plan.percent === null) return 0
      const raw = round2(splittable * (parseFloat(plan.percent) / 100))
      const floor = plan.floor_amount !== null ? parseFloat(plan.floor_amount) : 0
      return raw < floor ? round2(floor) : raw
    }
    case 'percent_with_ceiling': {
      if (plan.percent === null) return 0
      const raw = round2(splittable * (parseFloat(plan.percent) / 100))
      const ceiling = plan.ceiling_amount !== null ? parseFloat(plan.ceiling_amount) : raw
      return raw > ceiling ? round2(ceiling) : raw
    }
    // Non-per-payment fee types — fire from other triggers.
    case 'flat_monthly':       // monthly accrual job (S111)
    case 'per_unit':           // monthly accrual job (S111)
    case 'leasing_fee':        // lease-creation hook (S111)
    case 'maintenance_markup_pct':  // maintenance invoice (deferred)
      return 0
    default:
      return 0
  }
}

async function fetchUserDefaultManagementBank(
  client: PoolClient,
  userId: string
): Promise<string | null> {
  const res = await client.query<{ default_management_payout_bank_account_id: string | null }>(
    `SELECT default_management_payout_bank_account_id FROM users WHERE id=$1`,
    [userId]
  )
  return res.rows[0]?.default_management_payout_bank_account_id ?? null
}

interface UserLedgerInsert {
  userId: string
  type: AllocationLedgerType
  amount: number
  referenceId: string
  referenceType: string
  propertyId?: string | null
  bankAccountId?: string | null
  notes?: string | null
}

async function postUserLedgerEntry(client: PoolClient, p: UserLedgerInsert): Promise<void> {
  // Advisory lock serializes ledger inserts per user across concurrent transactions.
  // Released automatically at transaction end.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`user_balance:${p.userId}`]
  )
  const prev = await client.query<{ balance_after: string }>(
    `SELECT balance_after FROM user_balance_ledger
      WHERE user_id=$1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [p.userId]
  )
  const prevBalance = (prev.rowCount && prev.rowCount > 0)
    ? parseFloat(prev.rows[0].balance_after)
    : 0
  const newBalance = round2(prevBalance + p.amount)
  await client.query(
    `INSERT INTO user_balance_ledger
      (user_id, type, amount, balance_after, reference_id, reference_type,
       property_id, bank_account_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [p.userId, p.type, p.amount, newBalance,
     p.referenceId, p.referenceType,
     p.propertyId ?? null, p.bankAccountId ?? null, p.notes ?? null]
  )
}

interface PlatformLedgerInsert {
  type: 'banking_spread' | 'manual_withdrawal_fee' | 'placement_fee_share' | 'adjustment'
  amount: number
  referenceId: string
  referenceType: string
  propertyId?: string | null
  notes?: string | null
}

async function postPlatformLedgerEntry(client: PoolClient, p: PlatformLedgerInsert): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`
  )
  const prev = await client.query<{ balance_after: string }>(
    `SELECT balance_after FROM platform_revenue_ledger
      ORDER BY created_at DESC, id DESC LIMIT 1`
  )
  const prevBalance = (prev.rowCount && prev.rowCount > 0)
    ? parseFloat(prev.rows[0].balance_after)
    : 0
  const newBalance = round2(prevBalance + p.amount)
  await client.query(
    `INSERT INTO platform_revenue_ledger
      (type, amount, balance_after, reference_id, reference_type, property_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.type, p.amount, newBalance,
     p.referenceId, p.referenceType, p.propertyId ?? null, p.notes ?? null]
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
