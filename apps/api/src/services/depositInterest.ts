/**
 * S188: deposit interest accrual engine.
 *
 * Encodes the S177 carve-out: per-state hardcoded rates with annual-
 * refresh migration cadence, accrued monthly per-deposit, summed
 * back into security_deposits.interest_accrued for the deposit-return
 * service to read at finalize.
 *
 * S604 CORE MODEL (Nic) — earn on everything, pay only what is required:
 *   EARNED: GAM puts 100% of pooled deposit principal to work (T-bills et al).
 *     Earning is NOT conditioned on any statute, state, or unit type. Every
 *     held dollar earns, so every held deposit gets an accrual row.
 *   OWED:   GAM pays statutory interest ONLY where the state AND unit type
 *     require it, and only the required amount. No statute → owed = 0, which
 *     is a real row, not a skip.
 *   SPREAD: earned − owed is GAM's to keep. Signed — a statute above market
 *     (AZ mobile home 5% vs a ~4% T-bill) is negative and GAM funds it.
 *
 * S241 policy lock — interest ownership:
 *   GAM-held deposit + state requires statutory interest → tenant
 *   GAM-held deposit + state silent on interest             → GAM
 *   Landlord-held deposit (held_by='landlord')              → landlord
 *
 * The first case is what interest_amount implements: where a state (and unit
 * type) obliges interest, the accrued amount flows to the tenant pool in
 * depositReturn.calculateDepositReturn. The second case is the DEFAULT — a
 * state with no row owes nothing, so interest_amount is 0 and the whole market
 * yield is GAM's. S604 changed how that case is RECORDED: it used to produce no
 * row at all, which left GAM's largest earning bucket invisible; it now writes
 * a row with owed = 0 and the earned/spread columns populated. The third case
 * is filtered upstream — held_by='landlord' rows never reach this engine.
 *
 * Per-month accrual model:
 *   interest = principal * (annual_rate_pct / 100) * (days_held / 365)
 *
 * principal_amount: security_deposits.collected_amount (the actual
 *   amount held, not total_amount which is the contracted amount —
 *   matters when a deposit is partially funded).
 *
 * days_held: full days during the accrual_month that the deposit was
 *   held in escrow. Partial first month (deposit funded mid-month) and
 *   partial last month (deposit disbursed mid-month) compute days from
 *   the actual transition dates.
 *
 * State coverage: only states listed in state_deposit_interest_rates for the
 * relevant effective_year OWE anything. Unlisted states have no statutory
 * requirement under GAM's framing, so their deposits accrue at owed = 0 and
 * the full market yield stays with GAM (S241 lock above). Those rows are still
 * written — that is where most of the spread lives.
 *
 * Scheduling: monthly cron, fires day 1 at ~3am to accrue for the
 * previous month. Idempotent via UNIQUE(security_deposit_id,
 * accrual_month) — re-running for the same month is a no-op.
 */

import { getClient, query, queryOne } from '../db'
import { logger } from '../lib/logger'

export interface MonthlyAccrualResult {
  accrued_count:   number
  /** Deposits not held during the month, already accrued, or zero-principal.
   *  S604: NO LONGER includes "state has no statutory rate" — those accrue too,
   *  at owed = 0, because GAM still earns on the principal. */
  skipped_count:   number
  error_count:     number
  /** OWED — statutory interest credited to tenants this month. */
  total_interest:  number
  /** EARNED — market yield on the pooled principal this month. */
  total_earned:    number
  /** earned − owed: GAM's keep. Signed. */
  total_spread:    number
  month:           string  // YYYY-MM-01
}

interface DepositForAccrual {
  id:               string
  lease_id:         string
  landlord_id:      string  // S190: needed for override lookup
  collected_amount: string
  monthly_rent:     string | null   // S604: for deposit-size thresholds
  state:            string
  unit_type:        string | null   // S604: selects the unit-type-specific rate row
  property_units:   number | null   // S604: for size gates (IL 25+, NY 6+)
  funded_at:        string | null    // earliest installment payment date
  disbursed_at:     string | null
}

/**
 * S190: Resolve the effective rate for (state, year) for a given
 * landlord. Statutory hardcoded catalog wins if present; falls back
 * to the per-landlord override table for variable-rate states.
 * Returns null if neither source has a rate.
 */
export interface ResolvedRate {
  source:           'statutory' | 'landlord_override'
  state_code:       string
  effective_year:   number
  annual_rate_pct:  number
  /** Which statute this came from, and which unit types it governs — carried so
   *  an accrual row records WHY it accrued, not just how much. */
  unit_types?:      string[]
  act_key?:         string | null
  /** S604: displayed to the tenant on the deposit-interest surface. Overrides
   *  carry no citation (they exist precisely because the state publishes a
   *  variable rate rather than a fixed statutory one), so this is nullable. */
  statute_citation?: string | null
  notes?:            string | null
  /** S604: HOW the obligation is computed — not every statute is a flat rate.
   *  Only 'fixed' can owe more than the pool earned. */
  rate_basis?:        'fixed' | 'lesser_of_actual' | 'share_of_actual'
                    | 'actual_earned' | 'actual_minus_admin' | 'index_linked' | 'none'
  actual_share_pct?:    number | null
  admin_retention_pct?: number | null
  /** Gates: the obligation only attaches past these thresholds. */
  min_tenure_months?:   number | null
  min_property_units?:  number | null
  /** S604 deposit-SIZE thresholds. 'trigger' = the whole deposit earns once it
   *  exceeds the threshold (NM); 'excess_only' = only the amount ABOVE the
   *  threshold earns (OH). When both legs are set the statute takes WHICHEVER
   *  IS GREATER. */
  threshold_rule?:         'trigger' | 'excess_only' | null
  threshold_amount?:       number | null
  threshold_months_rent?:  number | null
}

/**
 * S604: reduce the principal to the portion the statute actually charges
 * interest on.
 *
 *   OH § 5321.16(A) — 5% "on the EXCESS" over fifty dollars or one month's
 *     periodic rent, whichever is greater. A $1,000 deposit against $800 rent
 *     earns on $200, not $1,000. Treating it as the whole deposit would overpay
 *     five-fold on a typical tenancy.
 *   NM § 47-8-18(A)(1) — passbook interest is owed only where the deposit
 *     EXCEEDS one month's rent, but then on the whole deposit. Treating that as
 *     excess-only would underpay it just as badly.
 */
export function principalSubjectToInterest(
  rate:      Pick<ResolvedRate, 'threshold_rule' | 'threshold_amount' | 'threshold_months_rent'>,
  principal: number,
  monthlyRent: number | null,
): number {
  if (!rate.threshold_rule) return principal
  const legs: number[] = []
  if (rate.threshold_amount != null) legs.push(rate.threshold_amount)
  if (rate.threshold_months_rent != null && monthlyRent != null) {
    legs.push(rate.threshold_months_rent * monthlyRent)
  }
  if (legs.length === 0) return principal
  const threshold = Math.max(...legs)   // "whichever is greater"
  if (principal <= threshold) return 0
  return rate.threshold_rule === 'excess_only' ? principal - threshold : principal
}

/**
 * S604: apply the statutory BASIS to produce what is actually owed.
 *
 *   fixed            — the flat rate, regardless of what was earned. The only
 *                      basis that can exceed earnings (AZ mobile home 5%).
 *   lesser_of_actual — MIN(rate, earned). Massachusetts: "five per cent per year
 *                      or other such lesser amount of interest as has been
 *                      received from the bank". Cannot lose.
 *   share_of_actual  — a percentage OF earnings (FL: at least 75% of the
 *                      account's annualized average). GAM keeps the rest.
 *                      Cannot lose.
 *
 * `earned` is null when no market rate is on file. In that case a basis that
 * depends on actual earnings cannot be evaluated, so it falls back to the flat
 * rate — the conservative direction, since under-paying a statutory obligation
 * is the expensive mistake (AZ § 33-1431(D) penalises at TWICE the amount
 * wrongfully withheld).
 */
export function applyRateBasis(
  basis:          ResolvedRate['rate_basis'] | undefined,
  flatInterest:   number,
  earned:         number | null,
  actualSharePct: number | null | undefined,
  opts: {
    /** principal x days/365 — the base an admin retention is charged against. */
    adminBase?:          number
    adminRetentionPct?:  number | null
  } = {},
): number {
  // A verified "this state owes nothing" is not the same as "unknown" — it is
  // recorded explicitly so nobody re-researches it, and it owes zero.
  if (basis === 'none') return 0
  if (earned == null) return flatInterest
  switch (basis) {
    case 'lesser_of_actual':
      // MA: "five per cent per year or other such lesser amount of interest as
      // has been received from the bank".
      return Math.min(flatInterest, earned)
    case 'share_of_actual':
      // FL: landlord elects at least 75% of the account's annualized average.
      return earned * ((actualSharePct ?? 100) / 100)
    case 'actual_earned':
      // ND/NH/IA-after-5yr: the whole yield passes through to the tenant.
      return earned
    case 'actual_minus_admin': {
      // NY § 7-103 / PA § 511.2: the landlord keeps "a sum equivalent to one per
      // cent per annum upon the security money so deposited" and the BALANCE of
      // the interest goes to the tenant. The retention is on PRINCIPAL, not on
      // the interest, so it is computed against the same principal x time base.
      const retention = (opts.adminBase ?? 0) * ((opts.adminRetentionPct ?? 0) / 100)
      return Math.max(0, earned - retention)
    }
    case 'index_linked':
      // The published index is stored in annual_rate_pct and refreshed annually,
      // so it evaluates like a fixed rate for the year in force.
      return flatInterest
    case 'fixed':
    default:
      return flatInterest
  }
}

/**
 * S604: some obligations only switch on past a threshold.
 *   tenure        — IA (first FIVE YEARS belong to the landlord), NH (held one
 *                   year or longer), PA (held more than two years)
 *   property size — IL (parks "regularly containing 25 or more mobile homes"),
 *                   NY (six-or-more-family dwellings)
 * Below the gate the state owes nothing, and GAM keeps the whole yield.
 */
export function gateApplies(
  rate:          Pick<ResolvedRate, 'min_tenure_months' | 'min_property_units'>,
  monthsHeld:    number,
  propertyUnits: number | null,
): boolean {
  if (rate.min_tenure_months != null && monthsHeld < rate.min_tenure_months) return false
  if (rate.min_property_units != null &&
      (propertyUnits == null || propertyUnits < rate.min_property_units)) return false
  return true
}

/**
 * S603 (Nic): deposit interest is UNIT-TYPE specific, not merely state-specific.
 *
 * Arizona, from GAM's own 50-state corpus, is the proof: a mobile home owes
 * "not less than five per cent annual interest" (A.R.S. § 33-1431(B), Mobile Home
 * Parks Act) while an apartment under § 33-1321 and an RV long-term space under
 * § 33-2121 owe NOTHING. Same state, three unit types, two obligations. Resolving
 * on state alone would have been wrong for two of the three — and Oak Park is the
 * property type carrying the 5%.
 *
 * Resolution order:
 *   1. a statutory row whose `unit_types` CONTAINS this unit's type  (most specific)
 *   2. the state's blanket statutory row (`unit_types = '{}'`)
 *   3. a landlord override
 *   4. null — the state owes nothing on this unit type
 *
 * `unitType` is optional so existing callers keep working; without it only the
 * blanket row can match, which is the pre-S603 behaviour.
 */
export async function resolveRateForLandlord(
  landlordId: string,
  stateCode:  string,
  year:       number,
  unitType?:  string | null,
): Promise<ResolvedRate | null> {
  const statutory = await queryOne<{
    annual_rate_pct:  string
    effective_year:   number
    unit_types:       string[]
    act_key:          string | null
    statute_citation: string
    notes:            string | null
    rate_basis:          ResolvedRate['rate_basis']
    actual_share_pct:    string | null
    admin_retention_pct: string | null
    min_tenure_months:      number | null
    min_property_units:     number | null
    threshold_rule:         'trigger' | 'excess_only' | null
    threshold_amount:       string | null
    threshold_months_rent:  string | null
  }>(
    `SELECT annual_rate_pct, effective_year, unit_types, act_key,
            statute_citation, notes, rate_basis, actual_share_pct,
            admin_retention_pct, min_tenure_months, min_property_units,
            threshold_rule, threshold_amount, threshold_months_rent
       FROM state_deposit_interest_rates
      WHERE state_code = $1 AND effective_year = $2
        AND (($3::text IS NOT NULL AND $3 = ANY(unit_types))
             OR cardinality(unit_types) = 0)
      -- A unit-type-specific row outranks the state's blanket row.
      ORDER BY cardinality(unit_types) DESC
      LIMIT 1`,
    [stateCode, year, unitType ?? null],
  )
  if (statutory) {
    return {
      source:          'statutory',
      state_code:      stateCode,
      effective_year:  statutory.effective_year,
      annual_rate_pct: parseFloat(statutory.annual_rate_pct),
      unit_types:      statutory.unit_types,
      act_key:         statutory.act_key,
      statute_citation: statutory.statute_citation,
      notes:            statutory.notes,
      rate_basis:       statutory.rate_basis,
      actual_share_pct: statutory.actual_share_pct == null
        ? null : parseFloat(statutory.actual_share_pct),
      admin_retention_pct: statutory.admin_retention_pct == null
        ? null : parseFloat(statutory.admin_retention_pct),
      min_tenure_months:  statutory.min_tenure_months,
      min_property_units: statutory.min_property_units,
      threshold_rule:     statutory.threshold_rule,
      threshold_amount:   statutory.threshold_amount == null
        ? null : parseFloat(statutory.threshold_amount),
      threshold_months_rent: statutory.threshold_months_rent == null
        ? null : parseFloat(statutory.threshold_months_rent),
    }
  }

  const override = await queryOne<{
    annual_rate_pct: string
    effective_year:  number
    source_notes:    string | null
  }>(
    `SELECT annual_rate_pct, effective_year, source_notes
       FROM landlord_deposit_interest_rate_overrides
      WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3
      LIMIT 1`,
    [landlordId, stateCode, year],
  )
  if (override) {
    return {
      source:          'landlord_override',
      state_code:      stateCode,
      effective_year:  override.effective_year,
      annual_rate_pct: parseFloat(override.annual_rate_pct),
      statute_citation: null,  // overrides exist because the state has no fixed rate
      notes:            override.source_notes,
      rate_basis:       'fixed',
      actual_share_pct: null,
    }
  }

  return null
}

const isoMonthStart = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

const daysInMonth = (year: number, monthZeroIdx: number): number =>
  new Date(Date.UTC(year, monthZeroIdx + 1, 0)).getUTCDate()

/**
 * Compute the interest for a single deposit for a single accrual month.
 * Returns null if the state has no rate (skip), or if the deposit
 * wasn't held during any part of this month (skip).
 */
export interface AccrualComputation {
  /** OWED — statutory interest credited to the tenant. 0 when the state owes
   *  nothing on this unit type (the majority case; per the S241 lock the yield
   *  on those deposits stays with GAM). */
  interest_amount:  number
  days_held:        number
  days_in_month:    number
  state_code:       string
  effective_year:   number
  annual_rate_pct:  number
  principal_amount: number
  /** S604: the resolution provenance, carried through to the accrual row so a
   *  row records WHY it accrued. unit_type is the INPUT that selected the rate;
   *  act_key + rate_source describe the rule that matched. */
  unit_type:        string | null
  act_key:          string | null
  rate_source:      ResolvedRate['source'] | null
  rate_basis:       ResolvedRate['rate_basis'] | null
  /** EARNED — what this principal yielded at the market rate over the same
   *  days. null when no market rate is on file for the month. */
  earned_amount:    number | null
  market_rate_pct:  number | null
  /** earned − owed. SIGNED: negative means the statute obliges more than the
   *  pool earned and GAM funds the difference. */
  spread_amount:    number | null
}

/**
 * S604: the market yield in force for an accrual month — the EARNED side.
 * Most recent rate at or before the month, so a rate stays in force until
 * a new one is filed rather than lapsing to zero between entries.
 */
export async function resolveMarketYieldRate(monthStartIso: string): Promise<number | null> {
  const row = await queryOne<{ annual_rate_pct: string }>(
    `SELECT annual_rate_pct
       FROM deposit_pool_yield_rates
      WHERE effective_month <= $1::date
      ORDER BY effective_month DESC
      LIMIT 1`,
    [monthStartIso],
  )
  return row ? parseFloat(row.annual_rate_pct) : null
}

export async function computeMonthlyAccrual(
  deposit:      DepositForAccrual,
  monthStartIso: string,  // YYYY-MM-01
): Promise<AccrualComputation | null> {
  const monthStart = new Date(`${monthStartIso}T00:00:00Z`)
  const year = monthStart.getUTCFullYear()
  const monthZero = monthStart.getUTCMonth()
  const dim = daysInMonth(year, monthZero)
  const monthEnd = new Date(Date.UTC(year, monthZero + 1, 0))

  // Determine "held" date range within this month.
  // funded_at is the earliest moment the deposit was held in escrow;
  // disbursed_at is when it left. Both are timestamps; we floor to
  // dates for the accrual math.
  const fundedDate = deposit.funded_at ? new Date(deposit.funded_at) : null
  const disbursedDate = deposit.disbursed_at ? new Date(deposit.disbursed_at) : null

  if (!fundedDate) return null  // not yet funded; nothing to accrue
  if (fundedDate > monthEnd) return null  // funded after this month
  if (disbursedDate && disbursedDate < monthStart) return null  // already disbursed before this month

  const heldFrom = fundedDate > monthStart ? fundedDate : monthStart
  const heldUntil = disbursedDate && disbursedDate < monthEnd ? disbursedDate : monthEnd
  const daysHeld = Math.max(
    0,
    Math.floor((heldUntil.getTime() - heldFrom.getTime()) / (1000 * 60 * 60 * 24)) + 1,
  )
  if (daysHeld === 0) return null

  // S190: Look up the effective rate for this state and year.
  // Statutory catalog wins; falls back to per-landlord override for
  // variable-rate states (NY/NJ/CT/IL/PA/NH).
  //
  // S604: the unit type is passed so a unit-type-specific statute can match.
  // Without it only a blanket state row could ever match, which meant an
  // Arizona mobile home — the one unit type in that state that IS owed 5% —
  // accrued nothing, while a state with a blanket rule would have paid
  // interest on unit types its statute never covered.
  const rate = await resolveRateForLandlord(
    deposit.landlord_id, deposit.state, year, deposit.unit_type,
  )

  const principal = parseFloat(deposit.collected_amount)
  if (principal <= 0) return null

  // S604: a missing statutory rate is NO LONGER a skip. GAM earns market yield
  // on every dollar of pooled principal it custodies, and under the S241 lock
  // the states that are SILENT on interest are precisely the ones where that
  // yield is entirely GAM's — i.e. where most of the spread lives. Skipping
  // them (pre-S604) meant the only deposits GAM could see earnings on were the
  // handful it owed statutory interest on. The row is now written whenever the
  // deposit was HELD; owed is simply 0 where nothing is owed.
  const owedPct  = rate?.annual_rate_pct ?? 0
  // S604: OWED may be charged on only part of the principal (OH excess-only) or
  // not at all below a size trigger (NM). EARNED is always on the whole
  // principal — GAM holds every dollar regardless of what is owed on it.
  const owedPrincipal = rate
    ? principalSubjectToInterest(rate, principal,
        deposit.monthly_rent == null ? null : parseFloat(deposit.monthly_rent))
    : 0
  const flatInterest = owedPrincipal * (owedPct / 100) * (daysHeld / 365)

  const marketPct = await resolveMarketYieldRate(monthStartIso)
  const earned = marketPct == null
    ? null
    : principal * (marketPct / 100) * (daysHeld / 365)

  // S604: not every statute is a flat rate. Massachusetts owes the LESSER of 5%
  // and what the bank actually paid; Florida lets the landlord elect a SHARE of
  // actual earnings. Encoding those as flat percentages would have GAM paying
  // more than the law asks — the most expensive kind of error here, because it
  // is self-inflicted and recurs every month on every deposit in the state.
  // S604: some obligations only switch on past a tenure or property-size gate
  // (IA five years, NH one year, PA two years, IL 25+ homes, NY 6+ family).
  // Below the gate the state owes nothing and GAM keeps the whole yield.
  const monthsHeld = Math.floor(
    (monthStart.getTime() - fundedDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
  const gated = rate ? gateApplies(rate, monthsHeld, deposit.property_units) : false

  const interest = rate && gated
    ? applyRateBasis(rate.rate_basis, flatInterest, earned, rate.actual_share_pct, {
        adminBase:         owedPrincipal * (daysHeld / 365),
        adminRetentionPct: rate.admin_retention_pct,
      })
    : 0

  const round4 = (n: number) => Math.round(n * 10000) / 10000
  const owedAmount = round4(interest)
  const earnedAmount = earned == null ? null : round4(earned)

  return {
    interest_amount:  owedAmount,
    days_held:        daysHeld,
    days_in_month:    dim,
    state_code:       rate?.state_code ?? deposit.state,
    effective_year:   rate?.effective_year ?? year,
    annual_rate_pct:  owedPct,
    principal_amount: principal,
    unit_type:        deposit.unit_type ?? null,
    act_key:          rate?.act_key ?? null,
    rate_source:      rate?.source ?? null,
    rate_basis:       rate?.rate_basis ?? null,
    earned_amount:    earnedAmount,
    market_rate_pct:  marketPct,
    // Signed on purpose — a statute above market (AZ mobile home 5% vs a 4%
    // T-bill) yields a negative spread GAM funds, and that is the number worth
    // seeing.
    spread_amount:    earnedAmount == null ? null : round4(earnedAmount - owedAmount),
  }
}

/**
 * Run accrual for every active deposit for the given month. Idempotent
 * via the UNIQUE(security_deposit_id, accrual_month) constraint.
 *
 * "Active" = security_deposits.status IN ('funded','partial','claimed')
 *   AND collected_amount > 0
 *   AND held_by = 'gam_escrow'  (statutory interest only flows when GAM
 *     holds the funds; if the landlord is holding the deposit directly,
 *     that's their compliance responsibility — GAM doesn't accrue on
 *     funds it doesn't custody)
 *
 * For each eligible deposit + state pair, compute the month's interest,
 * INSERT the accrual row, and UPDATE security_deposits.interest_accrued
 * to the new cumulative sum. All-or-nothing per deposit (one tx per).
 */
export async function runMonthlyAccrual(monthStartIso: string): Promise<MonthlyAccrualResult> {
  const result: MonthlyAccrualResult = {
    accrued_count: 0,
    skipped_count: 0,
    error_count:   0,
    total_interest: 0,
    total_earned:   0,
    total_spread:   0,
    month: monthStartIso,
  }

  // Pull every active deposit + property state. funded_at is derived
  // from the earliest payment row tagged as a deposit collection; if
  // no funding events exist (collected_amount > 0 but no rows), we
  // fall back to security_deposits.created_at (deposit row creation
  // = collection event in legacy data).
  const candidates = await query<DepositForAccrual>(
    `SELECT
        sd.id,
        sd.lease_id,
        l.landlord_id,
        sd.collected_amount::text AS collected_amount,
        u.rent_amount::text AS monthly_rent,
        p.state,
        u.unit_type,
        (SELECT COUNT(*)::int FROM units u2 WHERE u2.property_id = p.id) AS property_units,
        COALESCE(
          (SELECT MIN(pmt.due_date::timestamp)
             FROM payments pmt
            WHERE pmt.entry_description = 'DEPOSIT'
              AND pmt.lease_id = sd.lease_id
              AND pmt.status = 'settled'),
          sd.created_at
        )::text AS funded_at,
        sd.disbursed_at::text AS disbursed_at
       FROM security_deposits sd
       JOIN leases l     ON l.id = sd.lease_id
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sd.status IN ('funded', 'partial', 'claimed')
        AND sd.collected_amount > 0
        AND sd.held_by = 'gam_escrow'`,
  )

  for (const deposit of candidates) {
    try {
      const calc = await computeMonthlyAccrual(deposit, monthStartIso)
      if (!calc) {
        result.skipped_count += 1
        continue
      }
      const client = await getClient()
      try {
        await client.query('BEGIN')

        // Idempotent: ON CONFLICT DO NOTHING means re-running this
        // job for the same month is a no-op. Need to check if we
        // actually inserted to know whether to advance the running
        // total.
        const insert = await client.query<{ id: string }>(
          `INSERT INTO security_deposit_interest_accruals
             (security_deposit_id, lease_id, accrual_month,
              state_code, effective_year, annual_rate_pct,
              principal_amount, days_held, days_in_month, interest_amount,
              unit_type, act_key, rate_source, rate_basis,
              earned_amount, market_rate_pct, spread_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17)
           ON CONFLICT (security_deposit_id, accrual_month) DO NOTHING
           RETURNING id`,
          [
            deposit.id, deposit.lease_id, monthStartIso,
            calc.state_code, calc.effective_year, calc.annual_rate_pct,
            calc.principal_amount, calc.days_held, calc.days_in_month,
            calc.interest_amount,
            calc.unit_type, calc.act_key, calc.rate_source, calc.rate_basis,
            calc.earned_amount, calc.market_rate_pct, calc.spread_amount,
          ],
        )

        if (insert.rows.length > 0) {
          // Advance the running total. Sum from the accrual log so
          // we get the canonical figure even if security_deposits.
          // interest_accrued was hand-corrected at some point.
          await client.query(
            `UPDATE security_deposits sd
                SET interest_accrued = (
                      SELECT COALESCE(SUM(interest_amount), 0)
                        FROM security_deposit_interest_accruals
                       WHERE security_deposit_id = sd.id
                    ),
                    updated_at = NOW()
              WHERE sd.id = $1`,
            [deposit.id],
          )
          result.accrued_count += 1
          result.total_interest += calc.interest_amount
          result.total_earned   += calc.earned_amount ?? 0
          result.total_spread   += calc.spread_amount ?? 0
        } else {
          result.skipped_count += 1  // already accrued for this month
        }

        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      result.error_count += 1
      logger.error({ err: e, ctx: deposit.id }, '[deposit-interest] accrual failed for')
    }
  }

  return result
}

/**
 * Convenience: run accrual for the previous month relative to "now".
 * The cron uses this so the job runs on day 1 and accrues the just-
 * completed month.
 */
export async function runPreviousMonthAccrual(): Promise<MonthlyAccrualResult> {
  const now = new Date()
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return runMonthlyAccrual(isoMonthStart(prevMonth))
}

/**
 * Read accrual history for a single deposit. Used by tenant + landlord
 * dashboard surfaces.
 */
export async function getAccrualHistory(securityDepositId: string) {
  return query<{
    accrual_month:     string
    state_code:        string
    annual_rate_pct:   string
    principal_amount:  string
    days_held:         number
    interest_amount:   string
    unit_type:         string | null
    act_key:           string | null
    rate_source:       string | null
    created_at:        string
  }>(
    // ⚠️ TENANT-FACING (GET /api/tenants/me/deposit-interest). This selects an
    // EXPLICIT column list, never `*`, and must NEVER include earned_amount /
    // market_rate_pct / spread_amount — those are GAM's margin on the tenant's
    // own money. Same boundary S603 drew when calcNetPerUnit leaked to
    // landlords. Admin reporting uses getPoolSpreadByMonth() below.
    `SELECT accrual_month::text, state_code, annual_rate_pct::text,
            principal_amount::text, days_held, interest_amount::text,
            unit_type, act_key, rate_source,
            created_at::text
       FROM security_deposit_interest_accruals
      WHERE security_deposit_id = $1
      ORDER BY accrual_month ASC`,
    [securityDepositId],
  )
}

/**
 * S604 ADMIN-ONLY: the pool's earned-vs-owed position by month.
 *
 * "owed is by statute. earned is by market. subtract the difference." (Nic)
 *
 * This is GAM's margin on tenant money and is gated to admin surfaces — it must
 * never reach a tenant or a landlord payload. `spread` is signed: a month in
 * which statutory obligations (e.g. Arizona's mobile-home 5%) outrun the market
 * rate reports NEGATIVE, meaning GAM funded the difference.
 */
export async function getPoolSpreadByMonth(opts: { from?: string; to?: string } = {}) {
  return query<{
    accrual_month:   string
    deposits:        number
    principal:       string
    owed:            string
    earned:          string
    spread:          string
    market_rate_pct: string | null
  }>(
    `SELECT accrual_month::text,
            COUNT(*)::int                            AS deposits,
            SUM(principal_amount)::text              AS principal,
            SUM(interest_amount)::text               AS owed,
            COALESCE(SUM(earned_amount), 0)::text    AS earned,
            COALESCE(SUM(spread_amount), 0)::text    AS spread,
            MAX(market_rate_pct)::text               AS market_rate_pct
       FROM security_deposit_interest_accruals
      WHERE ($1::date IS NULL OR accrual_month >= $1::date)
        AND ($2::date IS NULL OR accrual_month <= $2::date)
      GROUP BY accrual_month
      ORDER BY accrual_month DESC`,
    [opts.from ?? null, opts.to ?? null],
  )
}
