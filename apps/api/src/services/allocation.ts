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
 * S655 (money plan Step 2): the split is of the money GAM HOLDS for the
 * landlord on the row (v_payment_money.gam_held_part), never of the row's face
 * amount. Credit the landlord issued, and paid-ahead money the landlord already
 * holds, pay part of a row without any money reaching GAM, so they are never
 * paid out; the processing fee is on money only; cuts that exceed what GAM
 * holds are capped with an admin alert instead of throwing.
 *
 * S64 scope: rent_percent (with floor/ceiling) only.
 * Deferred: flat_monthly_fee, per_unit_fee (monthly accrual job),
 *           placement_fee_share, maintenance_markup.
 */

import type { PoolClient } from 'pg'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export type PaymentMethod = 'ach' | 'card'

/**
 * S609: the charge kinds that carry an owner share. `late_fee` and `fee` joined
 * `rent`/`utility` on Nic's directive that lease-derived fees are the
 * landlord's. Membership here is necessary but NOT sufficient — the row must
 * also be revenue_owner='landlord' (a 'fee' row can be either side's).
 *
 * `home_payment`: a park-owned home sold to the household on payments is
 * billed like rent (homeSale.ts), so the money the tenant pays toward it is
 * split like rent — the landlord's owner share, paid out in the Tuesday batch
 * when GAM holds the money. GAM takes no cut of it beyond the normal processing
 * fee. Without it here a home payment the tenant paid by card or bank sat on
 * GAM's balance with no owner share and was never paid out. One paid at the
 * desk is the landlord's already: it carries nothing GAM holds and books
 * nothing.
 * This list says which kinds carry an owner share; it is not what FlexPay
 * pays. FlexPay NEVER pays a home payment (decisions #35 point 7(e): a payment
 * toward owning a home is a real-property interest GAM will not hold a claim
 * in), so the FlexPay cover must leave home_payment out by name (flexpay
 * coverLineSql), as it leaves out carried_balance.
 *
 * `carried_balance`: an old balance the household owes the landlord (carried
 * over from the landlord's previous system, or a work-trade shortfall). Paid
 * online (rentCharge, any amount) the money lands on GAM's balance
 * platform_held like rent, so it is split like rent and paid out in the
 * Tuesday batch. Without it here that money sat on GAM's balance with no owner
 * share and was never paid out. Credit never pays one (the credit_uses trigger
 * refuses it) and the FlexPay cover never does (flexpay coverLineSql leaves it
 * out by name), so adding it here changes neither. The payout line reads it
 * with payoutComposition's fallback word until it gets its own.
 *
 * NOT included: `deposit` (held in trust, released at move-out by
 * services/depositReturn), `platform_fee` / `float_fee` (GAM's by definition).
 */
export const ALLOCATABLE_PAYMENT_TYPES = ['rent', 'utility', 'late_fee', 'fee', 'home_payment', 'carried_balance'] as const

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
  revenue_owner: string
  gam_supersedence_amount: string
  sublease_markup_amount: string
  stripe_payment_intent_id: string | null
  /** cash, check, money order or prior arrangement: settled at the desk, never through Stripe */
  manual_method: string | null
  /** the company the row is billed for: a landlord-paid fee with no owner share to come out of is netted from its payout */
  landlord_id: string
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
 * S655 (money plan Step 2): how one charge row was paid, from v_payment_money.
 *
 *   issued             landlord-issued credit: never income, never paid out
 *   landlordHeldCredit paid-ahead money the landlord already holds
 *   gamFundedCredit    paid-ahead money GAM holds + deposit interest
 *   moneyPart          the row's own money (card, bank, FlexPay float, cash...)
 *   gamHeldPart        what GAM holds FOR THE LANDLORD on this row — the ONLY
 *                      figure a payout may carry: GAM-funded credit, plus the
 *                      money part when Stripe or the FlexPay float paid this row
 */
interface RowMoney {
  amount: number
  issued: number
  landlordHeldCredit: number
  gamFundedCredit: number
  moneyPart: number
  gamHeldPart: number
}

async function fetchRowMoney(client: PoolClient, paymentId: string): Promise<RowMoney> {
  const r = await client.query<{
    amount: string; issued_credit_amount: string; landlord_held_credit: string
    gam_funded_credit: string; money_part: string; gam_held_part: string
  }>(
    `SELECT amount::text, issued_credit_amount::text, landlord_held_credit::text,
            gam_funded_credit::text, money_part::text, gam_held_part::text
       FROM v_payment_money WHERE payment_id = $1`,
    [paymentId])
  const m = r.rows[0]
  if (!m) throw new AppError(404, `Payment ${paymentId} not found`)
  return {
    amount: parseFloat(m.amount),
    issued: parseFloat(m.issued_credit_amount),
    landlordHeldCredit: parseFloat(m.landlord_held_credit),
    gamFundedCredit: parseFloat(m.gam_funded_credit),
    moneyPart: parseFloat(m.money_part),
    gamHeldPart: parseFloat(m.gam_held_part),
  }
}

/**
 * S603: what did Stripe ACTUALLY process, and which rows did it cover?
 *
 * A single charge can settle several payment rows (the FIFO lump in
 * /pay-balance stamps its PaymentIntent on every covered row). The processing
 * fee was charged ONCE against the whole lump, so allocation must reason about
 * the charge — not the row it happens to be looking at.
 *
 * S655: the fee is charged on MONEY only. Credit that paid part of a row (the
 * tenant chose "Use all $X") moved no money, so it is in neither the fee base
 * nor the share each row carries of the fee.
 *
 *   feeBase       — the money the fee was computed on: the remittance's amount
 *                   (what the tenant chose to pay, surplus included) when one
 *                   exists, else the money part of every row the charge settled.
 *   allocTotal    — the money part of the rows allocation books for (the
 *                   landlord's allocatable rows with gam_held_part > 0), which
 *                   is what the fee gets apportioned across. It may be 0:
 *                   credit paid every landlord row in full and the money paid
 *                   only a GAM row (a returned-payment fee).
 *   isLastRow     — deterministic (id order) among those same rows, so exactly
 *                   one row that BOOKS absorbs the rounding remainder — and,
 *                   when allocTotal is 0, the whole fee, so it is booked once
 *                   per charge, never once per row and never zero times.
 *   inSet         — this row is one of those rows. A row outside a set that
 *                   has rows takes no share: the set's rows carry the whole fee
 *                   between them, so a share here would book part of it twice.
 *
 * A payment with no PaymentIntent is its own charge of one row, which
 * collapses to the pre-S603 behavior on its money part.
 */
interface ChargeContext {
  feeBase:    number
  allocTotal: number
  isLastRow:  boolean
  inSet:      boolean
  priorRows:  { id: string; amount: number }[]
  /**
   * S655 review (round 3): NO landlord row on the charge carries money GAM
   * holds (credit GAM does not hold — a credit the landlord gave, paid-ahead
   * money the landlord already has — paid every one of them in full, and the
   * money paid only a GAM row), and this row is the one that books the charge's
   * fee anyway: the last, by id, of the landlord rows the settle runs
   * allocation for. Exactly one row per such charge; false everywhere else.
   */
  feeOnlyRow: boolean
}

async function resolveChargeContext(
  client: PoolClient,
  payment: PaymentRow,
  money: RowMoney,
): Promise<ChargeContext> {
  // A row settled at the desk (cash, check, money order, prior arrangement)
  // moved no money through Stripe, so it carries no processing fee of its own
  // and no share of any charge's fee — even when it still carries an old
  // bounced intent, and even when GAM-held credit paid part of it (that credit
  // went through Stripe's fee back when it was paid, S609). Cash and checks are
  // free (S630).
  if (payment.manual_method) {
    return { feeBase: 0, allocTotal: 0, isLastRow: false, inSet: false, priorRows: [], feeOnlyRow: false }
  }
  const own = money.moneyPart
  const pi = payment.stripe_payment_intent_id
  if (!pi) {
    return { feeBase: own, allocTotal: own, isLastRow: true, inSet: true, priorRows: [], feeOnlyRow: false }
  }

  // Every row carrying this intent that is settled, by its money part. feeBase
  // counts every one the CHARGE paid (a fee row swept up by FIFO was part of
  // what the tenant paid, so the fee was computed on it) — not a row that still
  // carries an old bounced intent but was settled at the desk (manual_method).
  // The apportionment set is only the rows that actually post ledger entries:
  // the landlord's allocatable rows with money GAM holds on them.
  const res = await client.query<{
    id: string; money_part: string; gam_held_part: string; type: string; revenue_owner: string
    at_desk: boolean; gam_keeps_repayment: boolean; has_unit: boolean
  }>(
    `SELECT p.id, vm.money_part::text AS money_part, vm.gam_held_part::text AS gam_held_part,
            p.type, p.revenue_owner, (p.manual_method IS NOT NULL) AS at_desk,
            (p.unit_id IS NOT NULL) AS has_unit,
            -- A reopened row whose reversal the landlord was not fully clawed
            -- back for: GAM keeps the re-payment and no owner split runs
            -- (paymentReversal.resolveReversalOnTenantPayment, same test).
            (p.reversal_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM payment_reversals r
                WHERE r.id = p.reversal_id
                  AND (r.recovery_status = 'recovered' OR r.recovered_amount >= r.reversed_amount))) AS gam_keeps_repayment
       FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
      WHERE p.stripe_payment_intent_id = $1 AND p.status = 'settled'
      ORDER BY p.id`,
    [pi],
  )
  const all = res.rows
  if (all.length === 0) {
    return { feeBase: own, allocTotal: own, isLastRow: true, inSet: true, priorRows: [], feeOnlyRow: false }
  }

  // S609 pay-ahead / S655: the money the tenant handed over is the remittance's
  // amount — rows paid plus any surplus banked as paid-ahead money. Stripe
  // charged us on every dollar it processed, and the route computed the
  // customer fee on that amount. Without a remittance (an older charge), the
  // rows' money is the whole of it.
  const rem = await client.query<{ n: string; amount: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount), 0)::text AS amount
       FROM tenant_remittances WHERE stripe_payment_intent_id = $1`,
    [pi])
  const feeBase = Number(rem.rows[0]?.n ?? 0) > 0
    ? round2(parseFloat(rem.rows[0].amount))
    : round2(all.filter(r => !r.at_desk).reduce((sum, r) => sum + parseFloat(r.money_part), 0))

  // Rows that produce ledger entries — the set the processing fee is
  // apportioned across, by money. S609: late fees and landlord fees carry an
  // owner share too. GAM-owned rows are part of feeBase (the tenant paid them)
  // but produce no owner split. S655 review: a row with nothing GAM holds on it
  // (paid whole by paid-ahead money the landlord holds or by credit the
  // landlord gave) books nothing — executeRentAllocation returns before the
  // fee — and neither does a reopened row whose re-payment GAM keeps (the
  // webhook skips its allocation). A row settled at the desk under an old
  // intent books no fee (it moved no Stripe money), even when GAM-held credit
  // on it books an owner share. None of them is part of the split. Left in,
  // any could be the "last row" that takes the whole fee or the rounding cent,
  // or take a share by cash Stripe never processed, and that part of the fee
  // would be booked zero times (GAM absorbing it).
  const allocRows = all
    .filter(r => (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(r.type)
              && r.revenue_owner === 'landlord'
              && parseFloat(r.gam_held_part) > 0
              && !r.gam_keeps_repayment
              && !r.at_desk)
    .map(r => ({ id: r.id, amount: parseFloat(r.money_part) }))
  const allocTotal = round2(allocRows.reduce((sum, r) => sum + r.amount, 0))

  // The REAL money sum, even 0. (Falling back to this row's own money put the
  // whole fee on every row when credit paid them all: a landlord-paid $6 ACH
  // fee booked twice on rent and water, S655 review.)
  const idx = allocRows.findIndex(r => r.id === payment.id)

  // S655 review (round 3): when no row is in the set — credit GAM does not hold
  // paid every landlord row in full and the money paid only a GAM row — the fee
  // still has to be booked, once. It goes on the last (id order) of the
  // landlord rows the settle runs allocation for (the webhook allocates every
  // landlord row of an ALLOCATABLE_PAYMENT_TYPES kind with a unit — rent,
  // utility, late fee, fee, home payment and carried-over balance; never a
  // reopened row whose re-payment GAM keeps, never a desk row), so exactly one of those
  // calls books it (executeRentAllocation → bookFeeWithNoHeldShare).
  const feeRows = allocRows.length > 0 ? [] : all.filter(r =>
    (ALLOCATABLE_PAYMENT_TYPES as readonly string[]).includes(r.type)
    && r.revenue_owner === 'landlord' && r.has_unit && !r.gam_keeps_repayment && !r.at_desk)
  return {
    feeBase,
    allocTotal,
    // With no row in the set, a row outside it is the only place left to book
    // the fee (isLastRow). While the set has rows, a row outside it takes no
    // share at all (inSet false: apportion gives it 0) — the set's rows carry
    // the whole fee between them.
    isLastRow: idx === -1 ? allocRows.length === 0 : idx === allocRows.length - 1,
    inSet: idx !== -1,
    priorRows: idx > 0 ? allocRows.slice(0, idx) : [],
    feeOnlyRow: feeRows.length > 0 && feeRows[feeRows.length - 1].id === payment.id,
  }
}

/**
 * S603: this row's share of a charge-wide amount, by its share of the covered
 * rows' money. The last row takes `whole - everything already given out` so
 * the pieces sum to the whole exactly — never a cent lost or invented.
 * S655: when no landlord row on the charge carries money (credit paid them
 * all), there is nothing to share by, and the last row carries it all — once.
 * A row outside a set that has rows takes nothing: the set's rows already
 * carry the whole of it, so a share here would book that part twice.
 */
function apportion(whole: number, charge: ChargeContext, rowMoney: number): number {
  if (charge.allocTotal <= 0) return charge.isLastRow ? whole : 0
  if (!charge.inSet) return 0
  if (charge.isLastRow) {
    const given = charge.priorRows.reduce(
      (sum, r) => sum + round2(whole * (r.amount / charge.allocTotal)), 0)
    return round2(whole - given)
  }
  return round2(whole * (rowMoney / charge.allocTotal))
}

export interface AllocationOptions {
  /**
   * S609 pay-ahead: the processing fee on this row was ALREADY collected, at
   * the moment the tenant paid ahead. Set when releasing prepaid credit to the
   * landlord — the money is months old, it has been sitting on GAM's balance
   * since the original charge, and Stripe was paid its cut back then (the
   * surplus is inside that charge's feeBase). Charging a second fee now would
   * bill the same dollar twice and shrink the owner share.
   * S655: also a credit-only settle and the FlexPay cover.
   *
   * Only the FEE is suppressed. Manager fee, PM company cut, supersedence and
   * sublease markup all still apply — the landlord's split of rent does not
   * change because the tenant paid it early.
   */
  feeAlreadyCollected?: boolean
  /**
   * S652 (Nic): "it's an estimate that should not exist." Stripe's actual fee
   * on the charge, in dollars, read from its balance transaction at settlement.
   * When present it replaces the rate-table estimate of Stripe's cost, so the
   * banking spread the book records is the real margin on this payment.
   * Network costs are billed by Stripe monthly and stay a monthly line.
   */
  actualStripeFeeTotal?: number | null
}

/**
 * Book the landlord's side of one settled charge row.
 *
 * S655 (money plan Step 2) — THE OWNER SHARE IS ONLY EVER MONEY GAM HOLDS.
 * The gross is the row's gam_held_part (v_payment_money): what Stripe or the
 * FlexPay float paid on this row, plus GAM-funded credit (paid-ahead money that
 * came through Stripe, deposit interest). Never a credit the landlord issued
 * (nobody paid it), never paid-ahead money the landlord already holds (a check
 * they deposited: paying it out again is bug 1, S654). A row whose
 * gam_held_part is 0 writes nothing.
 *
 * Manager and PM cuts are earned on the row's INCOME (amount less issued
 * credit), whoever holds it, and come out of the GAM-held share. When they
 * exceed it (a manager-fee floor on a row the landlord mostly collected in
 * cash), the cut is capped at what GAM holds, the owner share is clamped at 0,
 * and an admin is told — never a throw: a credit lowering the gross must not
 * stop a tenant's payment from settling.
 */
export async function executeRentAllocation(
  client: PoolClient,
  paymentId: string,
  paymentMethod: PaymentMethod,
  opts: AllocationOptions = {}
): Promise<void> {
  // 1. Lock + fetch payment row
  const payment = await fetchPayment(client, paymentId)

  // 2. Idempotency short-circuit (real guard is the unique index)
  if (await alreadyAllocated(client, paymentId)) {
    return
  }

  // 3. How the row was paid. Nothing GAM holds → nothing to pay out. The
  //    charge's processing fee is still booked once (S655 review, round 3):
  //    when credit GAM does not hold paid every landlord row on a card or bank
  //    charge in full, the money paid only a GAM row, and no row would book it.
  const money = await fetchRowMoney(client, paymentId)
  const heldGross = round2(money.gamHeldPart)
  if (heldGross <= 0) {
    if (!opts.feeAlreadyCollected) await bookFeeWithNoHeldShare(client, payment, money, paymentMethod, opts)
    return
  }
  const income = round2(money.amount - money.issued)

  // 4. Resolve property + allocation rule via unit
  const prop = await fetchPropertyAndRule(client, payment.unit_id!)

  // 5. The processing fee, on money only. A credit-only settle, a FlexPay
  //    cover and a paid-ahead release carry no fee of their own.
  let customerFacingFee = 0
  let stripeCost = 0
  if (!opts.feeAlreadyCollected) {
    // S603 (Nic): "We cannot have a discrepancy between landlord and the platform
    // with how much was processed... We have to be 100% accurate everywhere."
    //
    // The fee and Stripe's cost are computed ONCE for the whole charge — exactly
    // as /pay-balance did when it created it — then apportioned across the rows
    // that charge covered. Pre-S603 each row re-derived both from itself, which
    // booked a flat ACH fee once per row (a landlord-paid $6 taken twice) and
    // measured Stripe's cost on the rent line instead of what Stripe processed.
    const charge = await resolveChargeContext(client, payment, money)
    const whole = await wholeChargeFee(client, paymentMethod, prop, charge, opts)

    // This row's share, by its MONEY. The LAST row (id order) absorbs the
    // rounding remainder so the pieces sum to the whole exactly.
    customerFacingFee = apportion(whole.customerFee, charge, money.moneyPart)
    stripeCost = apportion(whole.stripeCost, charge, money.moneyPart)
  }
  const bankingSpread = round2(customerFacingFee - stripeCost)

  // S116: ach_fee_payer applies to ACH; card_fee_payer to card. A landlord-paid
  // fee comes out of what GAM holds for them (once per charge, by share).
  const processingFeePayer = paymentMethod === 'ach' ? prop.ach_fee_payer : prop.card_fee_payer
  const landlordFee = processingFeePayer === 'landlord' ? customerFacingFee : 0
  // The cuts are earned on the landlord's whole income from the row; the money
  // to pay them is only what GAM holds.
  const splittableIncome = round2(Math.max(0, income - landlordFee))
  const splittableHeld = round2(heldGross - landlordFee)

  // S261: GAM-supersedence — the boost was redirected to GAM at charge time;
  // S581: sublease markup goes to the sublessor. Both are portions of the gross
  // the landlord never receives, so both come out of the owner share.
  const supersedenceAmount = round2(parseFloat(payment.gam_supersedence_amount || '0'))
  const subleaseMarkup = round2(parseFloat(payment.sublease_markup_amount || '0'))

  // S110: PM company cut (third-party PM contracted on this property) replaces
  // the in-house manager fee.
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
    pmCompanyFee = computePmCutForRent(pmContext, splittableIncome)
  }

  // Manager fee: rent_percent (with floor/ceiling clamp). Skipped if the owner
  // self-manages, or a PM company is contracted (the PM cut takes its place).
  let managerFee = 0
  const ownerSelfManaged = prop.owner_user_id === prop.managed_by_user_id
  const pmCompanyContracted = prop.pm_company_id !== null
  if (!ownerSelfManaged && !pmCompanyContracted && prop.rent_percent !== null) {
    const pct = parseFloat(prop.rent_percent)
    let mc = round2(splittableIncome * (pct / 100))
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

  // S655: everything comes out of what GAM holds. Supersedence and markup
  // already left at charge time, so they are first; then the PM cut, then the
  // manager fee; the owner gets the rest. Short → cap, clamp, tell an admin.
  const room = round2(Math.max(0, splittableHeld - supersedenceAmount - subleaseMarkup))
  const pmPaid = round2(Math.min(pmCompanyFee, room))
  const managerPaid = round2(Math.min(managerFee, round2(room - pmPaid)))
  const ownerShare = round2(room - pmPaid - managerPaid)
  const shortBy = round2(
    (pmCompanyFee - pmPaid) + (managerFee - managerPaid)
    + Math.max(0, supersedenceAmount + subleaseMarkup - Math.max(0, splittableHeld)))
  if (shortBy > 0.005 || splittableHeld < -0.005) {
    await recordAllocationAlert(client, {
      paymentId: payment.id,
      propertyId: prop.property_id,
      title: `Fees on payment ${payment.id} are more than GAM holds for the landlord`,
      body:
        `GAM holds $${heldGross.toFixed(2)} of this $${money.amount.toFixed(2)} charge for the landlord ` +
        `(the rest was paid with credit the landlord gave or money the landlord already collected). ` +
        `Fees due from it: processing $${landlordFee.toFixed(2)}, PM company $${pmCompanyFee.toFixed(2)}, ` +
        `manager $${managerFee.toFixed(2)}, supersedence $${supersedenceAmount.toFixed(2)}, ` +
        `sublease markup $${subleaseMarkup.toFixed(2)}. Paid: PM $${pmPaid.toFixed(2)}, manager ` +
        `$${managerPaid.toFixed(2)}, owner $${ownerShare.toFixed(2)}; $${shortBy.toFixed(2)} was not covered. ` +
        `Collect it from the landlord directly.`,
      context: {
        payment_id: payment.id, property_id: prop.property_id, gam_held_part: heldGross, income,
        landlord_fee: landlordFee, pm_company_fee: pmCompanyFee, manager_fee: managerFee,
        supersedence: supersedenceAmount, sublease_markup: subleaseMarkup,
        pm_paid: pmPaid, manager_paid: managerPaid, owner_share: ownerShare, short_by: shortBy,
      },
    })
  }

  // 6. Post ledger entries.
  // Bank account snapshot semantics: stamp the routing target at write time.
  // Owner_share routes via the per-property bank assignment; manager_fee via
  // the manager's per-user default. NULL is acceptable on both; autoPayouts
  // will skip rows lacking a bank_account_id and they'll accumulate visible
  // balance until the assignment is corrected. The owner share is written
  // even at $0 (a clamp): it is what marks the row allocated.
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

  if (managerPaid > 0) {
    const managerBankAccountId = await fetchUserDefaultManagementBank(
      client, prop.managed_by_user_id
    )
    await postUserLedgerEntry(client, {
      userId: prop.managed_by_user_id,
      type: 'allocation_manager_fee',
      amount: managerPaid,
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
  if (pmPaid > 0 && pmContext) {
    await postUserLedgerEntry(client, {
      userId: pmContext.pm_payout_user_id!,
      type: 'allocation_pm_company_fee',
      amount: pmPaid,
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
      // S650: what the customer actually paid, so the month can be trued up
      // against Stripe's real invoices (the estimate above is conservative).
      customerFeeCharged: customerFacingFee,
      referenceId: payment.id,
      referenceType: 'payment',
      propertyId: prop.property_id,
      notes: `Banking spread on ${paymentMethod} rent payment ${payment.id}`,
    })
  }
}

/**
 * The processing fee on one whole charge, and Stripe's cost of it: computed
 * once, the same way the charge route priced it, before any row's share.
 */
async function wholeChargeFee(
  client: PoolClient,
  paymentMethod: PaymentMethod,
  prop: PropertyAndRuleRow,
  charge: ChargeContext,
  opts: AllocationOptions,
): Promise<{ customerFee: number; stripeCost: number }> {
  const rate = await fetchActiveProcessingRate(client, paymentMethod)
  const cfFlat = parseFloat(rate.customer_facing_flat!)
  const cfPercent = parseFloat(rate.customer_facing_percent!)
  const scFlat = parseFloat(rate.stripe_cost_flat!)
  const scPercent = parseFloat(rate.stripe_cost_percent!)
  // S551: caps are nullable — NULL means uncapped. The ACH row carries the
  // $6.00 customer cap ($3.00 cost cap) of the locked S113/S551 schedule.
  const cfCap = rate.customer_facing_cap != null ? parseFloat(rate.customer_facing_cap) : Infinity
  const scCap = rate.stripe_cost_cap != null ? parseFloat(rate.stripe_cost_cap) : Infinity
  // No money processed (feeBase 0: a row with no intent that credit paid
  // whole) carries no fee, not a flat $6 or 55 cents on nothing.
  const customerFee = charge.feeBase > 0
    ? round2(Math.min(cfFlat + charge.feeBase * (cfPercent / 100), cfCap)) : 0
  // A landlord-paid fee is DEDUCTED from the rent rather than added on top, so
  // Stripe only ever processed the rent itself. Tenant-paid rides on top and
  // Stripe takes its percentage of the grossed-up total.
  const feePayerForBase = paymentMethod === 'ach' ? prop.ach_fee_payer : prop.card_fee_payer
  const processedAmount = feePayerForBase === 'landlord'
    ? charge.feeBase
    : round2(charge.feeBase + customerFee)
  const stripeCost = opts.actualStripeFeeTotal != null
    ? round2(opts.actualStripeFeeTotal)
    : charge.feeBase > 0 ? round2(Math.min(scFlat + processedAmount * (scPercent / 100), scCap)) : 0
  return { customerFee, stripeCost }
}

/**
 * S655 review (round 3) — a card or bank charge whose landlord rows were ALL
 * paid in full by credit GAM does not hold (a credit the landlord gave,
 * paid-ahead money the landlord already has), so the money paid only a GAM row
 * (a returned-payment fee). Every landlord row has gam_held_part 0 and books
 * no owner share, so without this the charge's processing fee and GAM's spread
 * were booked ZERO times: a tenant-paid card fee missing from GAM's book, and
 * under ach_fee_payer = 'landlord' the landlord's fee never taken — GAM
 * absorbing Stripe's cost. Reached by "Use all $X" when credit covers the
 * landlord lines and only a GAM fee is left.
 *
 * Booked once per charge, on the one row resolveChargeContext names
 * (feeOnlyRow), and never twice (an existing spread on any row of the charge
 * stops it). No owner share, no manager or PM cut (there is no money GAM holds
 * for the landlord to take them from). A landlord-paid fee has no owner share
 * to come out of, so it is netted from the landlord's next payout as its own
 * line (a negative held item, one per charge). Inside a savepoint: a property
 * missing its payout setup is told to an admin and never rolls back the
 * tenant's settle.
 */
async function bookFeeWithNoHeldShare(
  client: PoolClient,
  payment: PaymentRow,
  money: RowMoney,
  paymentMethod: PaymentMethod,
  opts: AllocationOptions,
): Promise<void> {
  const pi = payment.stripe_payment_intent_id
  // Cash and checks are free; a row with no Stripe charge moved no money.
  if (payment.manual_method || !pi) return
  const charge = await resolveChargeContext(client, payment, money)
  if (!charge.feeOnlyRow || charge.feeBase <= 0) return
  const booked = await client.query(
    `SELECT 1 FROM platform_revenue_ledger l JOIN payments p ON p.id = l.reference_id
      WHERE l.reference_type = 'payment' AND l.type = 'banking_spread'
        AND p.stripe_payment_intent_id = $1
      LIMIT 1`, [pi])
  if ((booked.rowCount ?? 0) > 0) return

  await client.query('SAVEPOINT charge_fee_no_share')
  try {
    const prop = await fetchPropertyAndRule(client, payment.unit_id!)
    const whole = await wholeChargeFee(client, paymentMethod, prop, charge, opts)
    const payer = paymentMethod === 'ach' ? prop.ach_fee_payer : prop.card_fee_payer
    if (payer === 'landlord' && whole.customerFee > 0) {
      await client.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
         VALUES ($1, 'platform_fee', $2, $3, $4)
         ON CONFLICT (source_type, source_id) DO NOTHING`,
        [payment.landlord_id, `processing_fee:${pi}`, (-whole.customerFee).toFixed(2),
         `${paymentMethod === 'ach' ? 'Bank payment' : 'Card'} fee you cover for your tenant ` +
         `($${charge.feeBase.toFixed(2)} payment; credit paid your charges on it)`])
    }
    const spread = round2(whole.customerFee - whole.stripeCost)
    if (spread !== 0) {
      await postPlatformLedgerEntry(client, {
        type: 'banking_spread',
        amount: spread,
        customerFeeCharged: whole.customerFee,
        referenceId: payment.id,
        referenceType: 'payment',
        propertyId: prop.property_id,
        notes: `Banking spread on ${paymentMethod} charge ${pi} (credit paid every landlord row on it)`,
      })
    }
    await client.query('RELEASE SAVEPOINT charge_fee_no_share')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT charge_fee_no_share')
    logger.error({ err: e, paymentId: payment.id, paymentIntentId: pi }, '[allocation] the processing fee on a credit-paid charge could not be booked')
    await recordAllocationAlert(client, {
      paymentId: payment.id,
      propertyId: '',
      category: 'allocation_fee_not_booked',
      title: `The processing fee on charge ${pi} could not be booked`,
      body:
        `Credit paid every landlord charge on this card or bank payment, so its processing fee is booked on its own, ` +
        `and that failed (${e instanceof Error ? e.message : String(e)}). The tenant's payment settled normally. ` +
        `Usually a property missing its payout setup; fix it and book the fee for this payment.`,
      context: { payment_id: payment.id, stripe_payment_intent_id: pi, fee_base: charge.feeBase },
    })
  }
}

/**
 * S655: an allocation that had to cap a cut or clamp the owner share (or, with
 * its own category, a fee it could not book). Written
 * on the caller's transaction inside a savepoint, so it commits with the
 * settle it describes and a failure to record it never undoes the settle.
 */
async function recordAllocationAlert(
  client: PoolClient,
  a: { paymentId: string; propertyId: string; title: string; body: string; context: Record<string, unknown>; category?: string },
): Promise<void> {
  await client.query('SAVEPOINT allocation_alert')
  try {
    await client.query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('warn', $4, $1, $2, $3)`,
      [a.title, a.body, JSON.stringify(a.context), a.category ?? 'allocation_fees_exceed_held'])
    await client.query('RELEASE SAVEPOINT allocation_alert')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT allocation_alert')
    logger.error({ err: e, paymentId: a.paymentId }, '[allocation] could not record the fee-shortfall alert')
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

async function fetchPayment(client: PoolClient, paymentId: string): Promise<PaymentRow> {
  const res = await client.query<PaymentRow>(
    `SELECT id, unit_id, type, amount::text AS amount, status, revenue_owner,
            gam_supersedence_amount::text AS gam_supersedence_amount,
            sublease_markup_amount::text AS sublease_markup_amount,
            stripe_payment_intent_id, manual_method, landlord_id
       FROM payments WHERE id=$1 FOR UPDATE`,
    [paymentId]
  )
  const payment = res.rows[0]
  if (!payment) throw new AppError(404, `Payment ${paymentId} not found`)
  // S122: utility payments use the same allocation engine — same
  // banking-fee math, same owner/PM split, just a different
  // entry_description on the payment row.
  //
  // S609 (Nic, DIRECTIVE): late fees and landlord-billed fees join them.
  // "Late fees that come from the lease and are on the invoice need to go to
  // the landlord according to the lease. If you're talking about late fees that
  // would be in the one-off charges, those also need to go to the landlord. I
  // don't know why that would go to GAM."
  //
  // He is right, and until now they didn't: only rent and utilities were split
  // out, so a late fee off the signed lease settled with NO owner share and the
  // money stopped on GAM's books. Silent — the tenant's balance was correct and
  // the landlord had no line to miss.
  //
  // The gate is `revenue_owner`, NOT the type: a 'fee' row can belong to either
  // side (a landlord's hand-billed lease fee and a GAM subscription are both
  // written as 'SUBSCRIP'). Callers stamp ownership at creation; this reads it.
  if (!ALLOCATABLE_PAYMENT_TYPES.includes(payment.type as any)) {
    throw new AppError(400,
      `executeRentAllocation requires payment.type IN (${ALLOCATABLE_PAYMENT_TYPES.join(',')}), got '${payment.type}' (payment ${paymentId})`)
  }
  if (payment.revenue_owner !== 'landlord') {
    throw new AppError(400,
      `Payment ${paymentId} is GAM revenue (revenue_owner='${payment.revenue_owner}') — it has no owner share.`)
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
  /** S650: the processing fee the customer paid on this charge (spread rows). */
  customerFeeCharged?: number
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
      (type, amount, balance_after, reference_id, reference_type, property_id, notes, customer_fee_charged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.type, p.amount, newBalance,
     p.referenceId, p.referenceType, p.propertyId ?? null, p.notes ?? null,
     p.customerFeeCharged ?? null]
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
