// 10/27 (Nic) — WHAT CASH DOES GAM NEED, AND IN WHICH MONTH?
//
// FlexDeposit shows the landlord's books a settled deposit while the resident
// funds it over 2 or 4 installments. If the resident stops, the landlord is
// still owed what the lease says — Nic: "Any deposits we hold are absolutely
// going to the landlord. That is our risk to take, and that is why we are
// making the money on the flex deposit ... The landlord gets what they're
// owed, full stop." So the gap between what a resident funded and what their
// landlord is owed is GAM's cash to find, and it comes due THE DAY THAT
// TENANCY ENDS.
//
// His flowchart, which this implements literally and which short-circuits at
// every empty step:
//
//   1. This month coming up — is anybody moving out?        no -> stop, $0
//   2. Of those, do we hold a deposit for them?             no -> stop, $0
//   3. What is the landlord owed, and what did we collect?
//   4. Is there a difference?                               no -> no cash out
//   5. The difference IS the cash we need that month.
//
// TWO RULES THAT ARE NOT OBVIOUS:
//
// * The planning number assumes THE LANDLORD KEEPS THE WHOLE DEPOSIT (Nic:
//   "for the reserve, we need to assume that the landlord is going to keep the
//   entirety of the deposit"). The true figure only exists once the landlord
//   types their deductions at move-out, and it is usually smaller — the
//   earmark that was not needed comes back. That reconciliation is
//   depositReturn's job; this file is the forecast, so it is deliberately the
//   pessimistic one.
//
// * Only residents whose deposit GAM HOLDS can produce a dollar of this, and
//   it is the whole population (Nic: "The data on other people moving out
//   doesn't matter if we don't have the deposit"). Today that population is
//   empty, so every number here is a true $0 rather than an estimate of one.
//
// WHY THERE IS AN "UNSCHEDULED" BUCKET AS WELL AS A CALENDAR. 73 of 83 active
// leases are month-to-month with no end date at all, nothing enforces the 30
// days the lease asks for (services/moveOutNotice.ts), and real notice at this
// counter runs three or four days. So a scheduled month tells you what is
// already known, and the unscheduled figure is what could still arrive with
// almost no warning. The reserve has to answer the second one; the calendar
// is what you watch.

import { query, queryOne } from '../db'
import { FLEXDEPOSIT_RESERVE_TYPES } from '@gam/shared'

/**
 * 10/27 — WHAT FLEXDEPOSIT HAS BANKED, LESS WHAT IT HAS PAID OUT.
 *
 * Nic: "we need no capital until the first leases end. we hold custody so its
 * pure money now. we start building the seed asap to protect against
 * defaults."
 *
 * So the reserve is not a target or a ratio — it is a balance, and it is
 * computed from the four FlexDeposit lines on GAM's one revenue book rather
 * than stored anywhere. Fees are positive, a shortfall paid to a landlord is
 * negative, a later recovery positive again; a plain SUM is therefore the
 * answer with no special-casing.
 *
 * NOT the `reserve_fund_state` table. That one is FlexPay-scoped by its own
 * comment, its balance is 0.00, nothing in production has ever written it, and
 * its only rows are three repeated seed runs of the shelved On-Time Pay model
 * — yet the admin Overview reads it as "Default Reserve". Anything sized off
 * that number is sized off nothing.
 *
 * Deliberately scoped to the four FlexDeposit types. GAM's rent spread,
 * subscriptions and screening margin are real income but they are not standing
 * behind this product, and letting them inflate this figure would let the
 * ceiling rise on money earmarked for something else.
 */
export async function flexDepositReserve(): Promise<number> {
  const r = await queryOne<{ balance: string }>(
    // SUM(amount), never balance_after — a backdated row restates every later
    // row's running balance (services/platformRevenue.ts says so outright).
    `SELECT COALESCE(SUM(amount), 0)::text AS balance
       FROM platform_revenue_ledger
      WHERE type = ANY($1::text[])`,
    [[...FLEXDEPOSIT_RESERVE_TYPES]],
  )
  return Math.round(Number(r?.balance ?? 0) * 100) / 100
}

/** One departing resident whose deposit GAM holds. */
export interface FlexDepositDeparture {
  deposit_id:             string
  lease_id:               string
  tenant_id:              string
  tenant_name:            string
  property_id:            string
  property_name:          string
  unit_label:             string
  /** The day the tenancy ends. Null in the unscheduled bucket. */
  end_date:               string | null
  /** When a clerk recorded the move-out, if one did. A bare end date on a
   *  fixed term is a date nobody has confirmed; this is a human saying so. */
  notice_recorded_at:     string | null
  /** What the landlord's books read — the whole deposit. */
  owed:                   number
  /** What the resident actually funded and GAM is holding. */
  funded:                 number
  /** owed − funded: GAM's cash if the landlord keeps everything. */
  unfunded:               number
  installments_paid:      number
  installments_remaining: number
}

export interface FlexDepositExposureMonth {
  /** 'YYYY-MM' */
  month:       string
  departures:  FlexDepositDeparture[]
  owed:        number
  funded:      number
  /** The answer to step 5 for this month. */
  cash_needed: number
}

export interface FlexDepositExposure {
  /** Step 1/2 of the flowchart: the whole population that can cost anything. */
  custody_plans:     number
  /** Every unfunded dollar outstanding, scheduled or not. The standing
   *  requirement, because any of these residents can give days' notice. */
  custody_unfunded:  number
  /** The months ahead that have a known departure with a deposit we hold.
   *  Empty when nobody is scheduled — the flowchart stopping at step 1. */
  months:            FlexDepositExposureMonth[]
  /** The heaviest single month, which is the figure to hold cash against. */
  peak_month:        { month: string; cash_needed: number } | null
  /** Custody plans with no known end date (month-to-month, overwhelmingly). */
  unscheduled_plans:    number
  unscheduled_unfunded: number
  /** Nic's allowance for a departure nobody saw coming. At this book size a
   *  percentage is worth less than one person, so the honest unit is the
   *  single largest unfunded balance among residents with no notice given:
   *  one surprise, covered in full. */
  unexpected_allowance: number
  /** FlexDeposit fees banked less shortfalls paid. See flexDepositReserve. */
  reserve:              number
  /**
   * The cash GAM should have standing by right now: the heaviest known month
   * plus one unexpected departure. Compared against `reserve`, this is the
   * whole answer to "can we take another plan on".
   */
  cash_required:        number
  /** reserve − cash_required. Negative means the next departure is uncovered. */
  headroom:             number
  generated_at:         string
}

/**
 * The set of deposits GAM is actually holding under a FlexDeposit plan.
 *
 * Three guards that the existing capacity query (flexDeposit.ts:206) does not
 * have, each a real way to count a dollar that is not there:
 *   - `voided_at IS NULL` and `status <> 'voided'`: a voided row can keep
 *     flex_deposit_enabled TRUE and its plan status 'active'.
 *   - collected is clamped to the total before subtracting. GAM-first routing
 *     (supersedence.ts:330) raises collected_amount with no LEAST() clamp,
 *     unlike the other three writers, so collected can exceed the total and a
 *     bare subtraction would go negative.
 *   - the deposit's own unit decides whose tenancy this is, so a deposit is
 *     never counted against a lease it does not belong to.
 */
const CUSTODY_PLAN = `
  sd.flex_deposit_enabled = TRUE
  AND sd.flex_deposit_plan_status = 'active'
  AND sd.voided_at IS NULL
  AND sd.status <> 'voided'`

const UNFUNDED = `GREATEST(sd.total_amount - LEAST(COALESCE(sd.collected_amount, 0), sd.total_amount), 0)`

/**
 * WHOSE TENANCY ACTUALLY ENDS, which is not the same as whose lease has a date
 * in it. Two exclusions, both of which would otherwise put money in a month
 * where no deposit is ever returned:
 *
 *   - A TENANT-OWNED DWELLING does not end on its end date. The 2am job
 *     (jobs/scheduler.ts:344-352) wipes the date and flips the lease to
 *     month-to-month: nothing vacates, no deposit return is cut. The resident
 *     owns the home and is renting the ground under it.
 *   - A RENT-TO-OWN end date is a final purchase installment, not a departure.
 *     Nine of the ten end-dated active leases in production are these, running
 *     to 2033. Read naively they put trailer purchases into a 2031
 *     deposit-exposure bucket.
 *
 * A cancelled home-sale contract is NOT an exclusion — that tenancy is a
 * tenancy again, and its end date means what it says.
 */
const TENANCY_ENDS = `
  l.status = 'active'
  AND l.end_date IS NOT NULL
  AND u.dwelling_ownership = 'landlord'
  AND NOT EXISTS (
    SELECT 1 FROM home_sale_contracts hsc
     WHERE hsc.lease_id = l.id AND hsc.status = 'active')`

interface Row {
  deposit_id: string; lease_id: string; tenant_id: string
  first_name: string | null; last_name: string | null
  property_id: string; property_name: string | null
  unit_label: string | null
  end_date: string | null; notice_recorded_at: string | null
  owed: string; funded: string; unfunded: string
  installments_paid: number | null; installments_remaining: number | null
  scheduled: boolean
}

const money = (s: string | null | undefined) => Math.round(Number(s ?? 0) * 100) / 100
const name = (r: Row) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Resident'

function toDeparture(r: Row): FlexDepositDeparture {
  return {
    deposit_id: r.deposit_id, lease_id: r.lease_id, tenant_id: r.tenant_id,
    tenant_name: name(r),
    property_id: r.property_id, property_name: r.property_name ?? 'Property',
    unit_label: r.unit_label ?? '—',
    end_date: r.end_date, notice_recorded_at: r.notice_recorded_at,
    owed: money(r.owed), funded: money(r.funded), unfunded: money(r.unfunded),
    installments_paid: r.installments_paid ?? 0,
    installments_remaining: r.installments_remaining ?? 0,
  }
}

/**
 * The board. `monthsAhead` bounds the calendar; the unscheduled bucket and the
 * standing total are never bounded, because a resident with no end date can
 * leave in any of them.
 */
export async function flexDepositExposure(monthsAhead = 12): Promise<FlexDepositExposure> {
  const horizon = Math.max(1, Math.min(60, Math.trunc(monthsAhead)))

  const rows = await query<Row>(
    `SELECT sd.id                        AS deposit_id,
            sd.lease_id,
            sd.tenant_id,
            us.first_name,
            us.last_name,
            p.id                         AS property_id,
            p.name                       AS property_name,
            COALESCE(u.display_label, u.unit_number) AS unit_label,
            CASE WHEN ${TENANCY_ENDS} THEN l.end_date::text ELSE NULL END AS end_date,
            l.move_out_notice_at::text   AS notice_recorded_at,
            sd.total_amount::text        AS owed,
            LEAST(COALESCE(sd.collected_amount, 0), sd.total_amount)::text AS funded,
            ${UNFUNDED}::text            AS unfunded,
            sd.installments_paid,
            sd.installments_remaining,
            (${TENANCY_ENDS}
              AND l.end_date < (date_trunc('month', CURRENT_DATE)
                                + make_interval(months => $1::int))) AS scheduled
       FROM security_deposits sd
       JOIN leases     l  ON l.id  = sd.lease_id
       JOIN units      u  ON u.id  = sd.unit_id
       JOIN properties p  ON p.id  = u.property_id
       JOIN tenants    t  ON t.id  = sd.tenant_id
       JOIN users      us ON us.id = t.user_id
      WHERE ${CUSTODY_PLAN}
      ORDER BY l.end_date NULLS LAST, p.name, unit_label`,
    [horizon],
  )

  const custody_unfunded = money(String(rows.reduce((s, r) => s + Number(r.unfunded), 0)))

  // Step 1: nobody scheduled -> the calendar is empty and no month needs cash.
  // Not an estimate of zero; there is nothing to estimate.
  const byMonth = new Map<string, FlexDepositDeparture[]>()
  for (const r of rows) {
    if (!r.scheduled || !r.end_date) continue
    const m = r.end_date.slice(0, 7)
    const list = byMonth.get(m) ?? []
    list.push(toDeparture(r))
    byMonth.set(m, list)
  }

  const months: FlexDepositExposureMonth[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, departures]) => ({
      month,
      departures,
      owed:        money(String(departures.reduce((s, d) => s + d.owed, 0))),
      funded:      money(String(departures.reduce((s, d) => s + d.funded, 0))),
      cash_needed: money(String(departures.reduce((s, d) => s + d.unfunded, 0))),
    }))

  const peak = months.reduce<FlexDepositExposureMonth | null>(
    (best, m) => (m.cash_needed > 0 && (!best || m.cash_needed > best.cash_needed) ? m : best), null)

  // No end date, or an end date that is not a departure (tenant-owned ground
  // lease, rent-to-own horizon): the tenancy can end with days of warning and
  // the reserve is the only thing standing behind it.
  const unscheduled = rows.filter((r) => !r.end_date)
  const unscheduledUnfunded = unscheduled.reduce((s, r) => s + Number(r.unfunded), 0)

  // The allowance is one person, not a percentage — at this book size a
  // fraction of a resident is worth less than a dollar, and the realistic
  // surprise is one notice nobody expected. Residents who have ALREADY given
  // notice are excluded: they are on the calendar, not a surprise.
  const allowance = unscheduled
    .filter((r) => !r.notice_recorded_at)
    .reduce((mx, r) => Math.max(mx, Number(r.unfunded)), 0)

  // Always read, even with no plans: a balance that has been building since the
  // first fee is worth seeing before there is anything to spend it on.
  const reserve = await flexDepositReserve()

  // What to have standing by: the heaviest KNOWN month, plus one departure
  // nobody saw coming. Not the whole unfunded book — a resident two months
  // into a four-payment plan on a year lease cannot cost anything this month.
  const cash_required = money(String((peak?.cash_needed ?? 0) + allowance))

  return {
    custody_plans:        rows.length,
    custody_unfunded,
    months,
    peak_month:           peak ? { month: peak.month, cash_needed: peak.cash_needed } : null,
    unscheduled_plans:    unscheduled.length,
    unscheduled_unfunded: money(String(unscheduledUnfunded)),
    unexpected_allowance: money(String(allowance)),
    reserve,
    cash_required,
    headroom:             money(String(reserve - cash_required)),
    generated_at:         new Date().toISOString(),
  }
}
