/**
 * Financing a contractor-marketplace job — what a landlord can actually carry.
 *
 * 10/31 (Nic): "We're also going to offer financing for landlords. Landlords
 * can do a big job... Let's match kind of our flex deposit scale with the
 * Affirm style 2 or 4 payments, and have an appropriately matched fee
 * according to that."
 *
 * Asked how far up the brackets should run, he answered with an affordability
 * rule rather than a ceiling:
 *
 *   "based on landlord revenue and ability to repay. a one unit landlord at 800
 *    rent can never cover a job that big. lets say monthly payment 2 or 4 has
 *    to be equal or less than 25 percent of incoming invoices. scoped to leased
 *    units not short term stays. short term stays price off the lowest income
 *    over the last 6 months"
 *
 * THERE IS NO MAXIMUM JOB SIZE. There is a maximum MONTHLY PAYMENT, which is a
 * quarter of what the book brings in, and the job it can reach follows from how
 * many payments it is spread over. A one-unit park at $800 rent can carry $200
 * a month, so $400 over two payments or $800 over four — and a $20,000 roof is
 * simply not available to them, which is the point.
 *
 * THE BOOK IS READ IN TWO HALVES, because the two halves are not equally
 * trustworthy:
 *
 *   - LEASED SPACES invoice the same amount every month, so the figure used is
 *     FLAT RENT AND NOTHING ELSE. His words, 10/31: "it only needs to be flat
 *     rent. It should not count any utilities for bill back or late fees,
 *     because those are variables that can change." So no utility bill-back, no
 *     late fees, and no monthly ongoing lease fees either — a fee can be added,
 *     removed or re-rated, and a payment plan agreed against it would be
 *     measured on something that moved.
 *
 *   - EVERYTHING ELSE — short stays above all — is taken at its WORST month out
 *     of the last six, never its average. A park that takes nothing in July
 *     contributes nothing from stays, because a payment plan has to survive
 *     July. His words: "short term stays price off the lowest income over the
 *     last 6 months."
 *
 * One deliberate widening of his words: he named short-term stays, and the
 * worst-month rule is applied to ALL non-lease income, register sales and other
 * income included. Those are unpredictable in exactly the way stays are, GAM's
 * one definition of income (services/incomeBasis) reports stays and register
 * sales on a single line so they cannot be separated without writing a second
 * definition of income, and taking the lower figure can only ever make a plan
 * safer. Said out loud in `basis` on the result so nobody has to guess.
 *
 * This decides SIZE only. What financing COSTS is a price card and is not set
 * here — and, as with every other GAM price, a missing card must be an error
 * rather than a free plan.
 */
import {
  installmentSplit,
  FINANCING_FEE_SPLIT_ACROSS_PAYMENTS,
  FINANCING_PAYMENT_COUNTS,
  FINANCING_PAYMENT_SHARE_OF_INCOME,
  FINANCING_VARIABLE_LOOKBACK_MONTHS,
  type FinancingPaymentCount,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { todayIn, dateIn } from '../lib/timezone'
import { incomeEvents } from './incomeBasis'
import { requireMarketplaceCutPercent } from './marketplace'
import { isFeatureEnabled } from './systemFeatures'

/**
 * What a landlord is told while financing is held closed.
 *
 * Not "unavailable" and not an error: the marketplace itself is open, and the
 * sentence has to leave them somewhere to go rather than reading as a fault.
 */
export const FINANCING_CLOSED =
  'Paying for a job over several months is not open yet. Post the job and take bids '
  + 'now — the price you award is what you pay, and nothing here changes it.'

/**
 * A capacity with nothing in it, for the closed answer.
 *
 * Stated rather than measured on purpose: while financing is off, a quote does
 * not go reading somebody's rent roll to tell them no.
 */
function financingClosedCapacity(asOf: string): FinancingCapacity {
  return {
    asOf,
    leaseMonthly: 0, leasesCounted: 0,
    variableMonthly: 0, variableMonths: [], variableWorstMonth: null,
    monthlyIncome: 0, maxMonthlyPayment: 0,
    maxFinanced: { 2: 0, 4: 0, 6: 0, 12: 0 },
    whyNone: FINANCING_CLOSED,
    basis: 'Financing is not open, so nothing was measured.',
  }
}

/**
 * What GAM charges to spread `amount` over `payments`.
 *
 * Throws when no bracket covers it — the same discipline as every other GAM
 * price card. A job above the top bracket resolves to NOTHING, and "not
 * offered" must never be able to degrade into "free". Over $20,000 there is no
 * row on purpose; above that the landlord pays the contractor the ordinary way.
 */
export async function requireFinancingFee(
  amount: number, payments: FinancingPaymentCount, on: Date | string = new Date(),
): Promise<number> {
  // GAM'S CALENDAR, NOT UTC. toISOString() is already tomorrow after 5pm
  // Phoenix, so a card dated "from tomorrow" was in force this evening — a
  // re-price reaching back into a plan being priced right now. Caught by the
  // financing suite's own re-price test.
  const day = typeof on === 'string' ? on : dateIn(null, on)
  const row = await queryOne<{ fee: string }>(
    `SELECT fee::text AS fee
       FROM job_financing_fee_schedule
      WHERE $1::numeric > job_min AND $1::numeric <= job_max
        AND payments = $2
        AND effective_from <= $3::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [amount, payments, day])
  if (!row) {
    throw new AppError(409,
      `GAM does not finance a job of ${money(amount)} over ${payments} payments. `
      + `Jobs up to $20,000 can be spread; above that the landlord pays the contractor directly.`)
  }
  const fee = Number(row.fee)
  if (!Number.isFinite(fee) || fee < 0) {
    throw new AppError(500,
      'The financing price on file for that job size is not a usable number, so no plan was set up.')
  }
  return fee
}

/**
 * WHAT GAM HAS TO FRONT — the reserve pool question.
 *
 * 10/31 (Nic): "We need a special reserve pool to pay for these sorts of jobs,
 * because the contractor is going to need their money as soon as the job is
 * done. So we have to get, like, on a $10,000 job, if that's the finished
 * price, and we take $300 at 3%, the contractor needs $9,700... the first
 * payment of either 4 or 6 on that, let's say 4, is going to be what, $2,500
 * with our installment loan, $2,600. So we need roughly $7,000 out of pocket
 * for a $10,000 job. So we need roughly 70% in the pool."
 *
 * His arithmetic exactly, and it generalises:
 *
 *     to the contractor   = job − GAM's cut
 *     collected on day 1  = (job + financing fee) ÷ payments
 *     OUT OF POCKET       = the first minus the second
 *
 * On a $10,000 job at 3% over four payments that is $9,700 − $2,631.25 =
 * $7,068.75, which is 70.7% of the job — his 70%.
 *
 * THE PLAN LENGTH DRIVES IT, and the longer plan is the hungrier one:
 *
 *     2 payments   ~45% of the job
 *     4 payments   ~71%
 *     6 payments   ~79%          ← and held two months longer
 *
 * So the six-payment option that lets a smaller park reach a big job is also
 * the one that costs the pool most. Both facts are true and both belong in the
 * same sentence whenever this is discussed.
 *
 * This figure is on every quote, because a plan GAM cannot fund is not a plan,
 * however well the landlord can afford it.
 */
export interface FinancingOutlay {
  /** The contractor is paid the finished price less GAM's marketplace cut. */
  toContractor: number
  /** GAM's 3% of the finished job, kept rather than paid out. */
  marketplaceCut: number
  /** Collected from the landlord with the first payment. */
  collectedOnDayOne: number
  /** What the reserve pool has to fund on the day the job finishes. */
  outOfPocket: number
  /** That as a share of the job, for sizing the pool. */
  shareOfJob: number
}

export function financingOutlay(opts: {
  amount: number
  payments: FinancingPaymentCount
  /** The financing fee for this job and plan length. */
  fee: number
  /** GAM's marketplace cut, as a percent. From the price card, never a constant. */
  cutPercent: number
}): FinancingOutlay {
  const marketplaceCut = cents(opts.amount * (opts.cutPercent / 100))
  const toContractor = cents(opts.amount - marketplaceCut)
  const pieces = installmentSplit(cents(opts.amount + opts.fee), opts.payments)
  const collectedOnDayOne = pieces[0]
  const outOfPocket = cents(toContractor - collectedOnDayOne)
  return {
    toContractor,
    marketplaceCut,
    collectedOnDayOne,
    outOfPocket,
    shareOfJob: opts.amount > 0 ? Math.round(outOfPocket / opts.amount * 10000) / 10000 : 0,
  }
}

/** A month of the unpredictable half, so a screen can show the working. */
export interface FinancingMonth {
  /** 'YYYY-MM' on the property's own calendar. */
  month: string
  amount: number
}

export interface FinancingCapacity {
  asOf: string
  /** What leased spaces invoice every month: rent plus monthly ongoing fees. */
  leaseMonthly: number
  leasesCounted: number
  /**
   * The worst month of the last six, over everything that is not a lease
   * charge. Zero when any one of those months took nothing.
   */
  variableMonthly: number
  variableMonths: FinancingMonth[]
  /** Which month set the figure, so an operator can see why it is low. */
  variableWorstMonth: string | null
  /** leaseMonthly + variableMonthly. */
  monthlyIncome: number
  /** A quarter of it, rounded down to the cent. */
  maxMonthlyPayment: number
  /**
   * The biggest TOTAL each plan length can carry — the job PLUS its fee, since
   * the fee is spread across the payments and the landlord repays both.
   *
   * Named for what it is. The largest JOB is this less the fee for whatever
   * bracket it lands in, which is a smaller number and cannot be stated without
   * knowing the bracket: a $200-a-month ceiling carries $400 over two payments,
   * which is a $352 job once its $48 fee is in.
   */
  maxFinanced: Record<FinancingPaymentCount, number>
  /**
   * A plain sentence when nothing can be financed, for the screen to show
   * instead of a row of zeros. Null when there is capacity.
   */
  whyNone: string | null
  /** How the unpredictable half was measured, stated rather than assumed. */
  basis: string
}

const cents = (n: number) => Math.round(n * 100) / 100
/** For a sentence an operator reads: $2,631.25, not $2631.25. */
const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Down to the cent: a payment ceiling must never round UP past the rule. */
const floorCents = (n: number) => Math.floor(n * 100) / 100

/** The month 'YYYY-MM' that `isoDay` falls in. */
const monthOf = (isoDay: string) => String(isoDay).slice(0, 7)

/** `n` whole months before the month of `isoDay`, as 'YYYY-MM'. */
function monthsBefore(isoDay: string, n: number): string {
  const [y, m] = monthOf(isoDay).split('-').map(Number)
  const total = (y * 12 + (m - 1)) - n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

const firstDayOf = (month: string) => `${month}-01`
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  // Day 0 of the next month is the last day of this one.
  const d = new Date(Date.UTC(y, m, 0))
  return d.toISOString().slice(0, 10)
}

/**
 * The flat rent this landlord's leased spaces invoice in a month.
 *
 * FLAT RENT ONLY (Nic, 10/31): "it only needs to be flat rent. It should not
 * count any utilities for bill back or late fees, because those are variables
 * that can change."
 *
 * So `leases.rent_amount` on active leases, and nothing added to it. Utility
 * bill-backs move with the meter, a late fee only exists when somebody is late,
 * and a monthly ongoing lease fee can be added or re-rated at any time — none
 * of them is a figure a two- or four-month commitment should be measured
 * against. The whole point of splitting the book in two is that this half does
 * not move.
 *
 * Deliberately NOT the money collected: a leased space's INVOICE is the
 * predictable thing, and a resident who pays late still owes it.
 */
async function leaseInvoicesMonthly(
  landlordIds: string[], propertyIds: string[] | null,
): Promise<{ total: number; count: number }> {
  if (landlordIds.length === 0) return { total: 0, count: 0 }
  if (propertyIds !== null && propertyIds.length === 0) return { total: 0, count: 0 }
  const rows = await query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(l.rent_amount), 0)::text AS total,
            COUNT(*)::text AS count
       FROM leases l
       JOIN units u      ON u.id = l.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE l.status = 'active'
        AND p.landlord_id = ANY($1::uuid[])
        AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))`,
    [landlordIds, propertyIds])
  const r = rows[0]
  return { total: cents(Number(r?.total ?? 0)), count: Number(r?.count ?? 0) }
}

/**
 * The lines that are a lease's own charges, and so belong to the predictable
 * half rather than the measured one.
 *
 * Everything NOT in here — stays and register sales above all — is measured at
 * its worst month. `returned`, `creditsGiven` and the other give-backs are left
 * out of both halves: they are money going the other way and counting them as
 * income would be absurd, while subtracting them twice would understate a book
 * that has already had the reversal taken off it.
 */
const LEASE_OWN_LINES = new Set<string>([
  'rent', 'fees', 'utilities', 'lateFees', 'balances', 'homeSale', 'paidAhead',
])
const GIVE_BACKS = new Set<string>([
  'returned', 'stayShortened', 'creditsGiven', 'paidAheadRefunded',
])

/**
 * The worst month, out of the last six complete ones, of everything that is not
 * a lease charge.
 *
 * COMPLETE months only: the month in progress is half-counted by definition and
 * would always look like the worst one, which would make capacity collapse on
 * the 1st of every month and recover by the 28th.
 */
async function variableWorstMonth(
  landlordIds: string[], propertyIds: string[] | null, asOf: string,
): Promise<{ amount: number; months: FinancingMonth[]; worst: string | null }> {
  if (landlordIds.length === 0) return { amount: 0, months: [], worst: null }
  if (propertyIds !== null && propertyIds.length === 0) return { amount: 0, months: [], worst: null }

  const months: string[] = []
  for (let n = FINANCING_VARIABLE_LOOKBACK_MONTHS; n >= 1; n--) {
    months.push(monthsBefore(asOf, n))
  }
  const events = await incomeEvents({
    landlordIds,
    propertyIds,
    start: firstDayOf(months[0]),
    end: lastDayOf(months[months.length - 1]),
    // Money actually received: "income", not what was invoiced. A stay that was
    // booked and never paid for is not capacity.
    basis: 'received',
  })

  const byMonth = new Map<string, number>(months.map(m => [m, 0]))
  for (const e of events) {
    if (!e.inTotal) continue
    if (LEASE_OWN_LINES.has(e.line) || GIVE_BACKS.has(e.line)) continue
    const m = monthOf(e.day)
    if (!byMonth.has(m)) continue
    byMonth.set(m, (byMonth.get(m) ?? 0) + e.amount)
  }

  const series: FinancingMonth[] = months.map(m => ({ month: m, amount: cents(byMonth.get(m) ?? 0) }))
  let worst = series[0]
  for (const s of series) if (s.amount < worst.amount) worst = s
  // Never below zero. Belt and braces: the give-back lines are already excluded
  // above and landlord_other_income forbids a negative amount, so no month can
  // currently come out negative — but a month that somehow did brought in
  // nothing, it does not owe the plan money, and capacity must not go backwards.
  return { amount: Math.max(0, worst.amount), months: series, worst: worst.month }
}

/**
 * What this landlord can finance, and why.
 *
 * `propertyIds` narrows to some of the company's properties (a worker's scope);
 * null means every property the companies own. An empty list is a caller scoped
 * to nothing and gets zero capacity, never the whole book.
 */
export async function financingCapacityFor(opts: {
  landlordIds: string[]
  propertyIds?: string[] | null
  /** 'YYYY-MM-DD'; defaults to today on GAM's own calendar. */
  asOf?: string
}): Promise<FinancingCapacity> {
  const asOf = opts.asOf ?? todayIn(null)
  const propertyIds = opts.propertyIds ?? null

  const [lease, variable] = await Promise.all([
    leaseInvoicesMonthly(opts.landlordIds, propertyIds),
    variableWorstMonth(opts.landlordIds, propertyIds, asOf),
  ])

  const monthlyIncome = cents(lease.total + variable.amount)
  const maxMonthlyPayment = floorCents(monthlyIncome * FINANCING_PAYMENT_SHARE_OF_INCOME)

  const maxFinanced = {} as Record<FinancingPaymentCount, number>
  for (const n of FINANCING_PAYMENT_COUNTS) maxFinanced[n] = cents(maxMonthlyPayment * n)

  let whyNone: string | null = null
  if (maxMonthlyPayment <= 0) {
    whyNone = lease.count === 0 && variable.amount === 0
      ? 'There is no rent coming in on this company yet, so there is nothing a payment plan could be measured against.'
      : 'What this company brings in each month is too small to carry any payment plan yet.'
  }

  return {
    asOf,
    leaseMonthly: lease.total,
    leasesCounted: lease.count,
    variableMonthly: variable.amount,
    variableMonths: variable.months,
    variableWorstMonth: variable.worst,
    monthlyIncome,
    maxMonthlyPayment,
    maxFinanced,
    whyNone,
    basis: `Flat rent on leased spaces — no utilities, no late fees — plus the worst of the last `
      + `${FINANCING_VARIABLE_LOOKBACK_MONTHS} complete months for everything else `
      + `(stays, the register, other income). The payment may not exceed `
      + `${Math.round(FINANCING_PAYMENT_SHARE_OF_INCOME * 100)}% of that.`,
  }
}

/**
 * Can this landlord finance a job of `amount` over `payments`?
 *
 * Returns the monthly figure either way, so a refusal can say what they COULD
 * do rather than only that they cannot do this.
 */
export async function canFinance(opts: {
  landlordIds: string[]
  propertyIds?: string[] | null
  amount: number
  payments: FinancingPaymentCount
  asOf?: string
  /**
   * The fee, when the caller has already priced it. Left out, it is read from
   * the price card — which is the normal path and the one that refuses a job
   * too big to finance at all.
   */
  fee?: number
}): Promise<{
  allowed: boolean
  /** The job plus the fee: what the landlord actually repays. */
  financedTotal: number
  fee: number
  /** Every payment, in order. The fee is spread, so they are equal to the cent. */
  schedule: number[]
  /**
   * What GAM has to front out of the reserve pool on the day the job finishes.
   * Null when the job could not be priced at all.
   */
  outlay: FinancingOutlay | null
  monthlyPayment: number
  maxMonthlyPayment: number
  /** The biggest total this plan length can carry, fee included. */
  maxFinancedAtThisLength: number
  capacity: FinancingCapacity
  refusal: string | null
}> {
  // FINANCING IS HELD CLOSED (10/31, Nic: "just have financing jobs off").
  //
  // The gate is here rather than on a route because financing has no route
  // yet — this is what stops it growing one that is live the day it is wired.
  // Everything below is correct and tested; what is missing is the money to
  // fund it, and a plan GAM cannot fund must not be quotable.
  if (!(await isFeatureEnabled('job_financing_enabled'))) {
    return {
      allowed: false, financedTotal: 0, fee: 0, schedule: [], outlay: null,
      monthlyPayment: 0, maxMonthlyPayment: 0, maxFinancedAtThisLength: 0,
      capacity: financingClosedCapacity(opts.asOf ?? todayIn(null)),
      refusal: FINANCING_CLOSED,
    }
  }
  const capacity = await financingCapacityFor(opts)
  const sane = Number.isFinite(opts.amount) && opts.amount > 0
  // THE RULE MEASURES WHAT THEY ACTUALLY PAY, so the fee is in it.
  //
  // 10/31 (Nic): "For landlords, we can split. We could split the fee for
  // landlords across the whole thing, across the 4 payments." So the job and
  // the fee are spread together and every payment is the same — which is also
  // why the figure the 25% rule tests is simply the payment.
  const fee = sane ? (opts.fee ?? await requireFinancingFee(opts.amount, opts.payments)) : 0
  const financedTotal = cents(opts.amount + fee)
  // THE LARGEST PIECE, NOT THE AVERAGE.
  //
  // A plan divides to the cent with the rounding on the last payment
  // (installmentSplit, the same split the card-reader plan uses), so $800.01
  // over four is 200.00, 200.00, 200.00, 200.01 — and the month that has to
  // carry 200.01 is the one the rule is about. Testing the average let a job
  // through whose real biggest payment was over the ceiling.
  const pieces = sane ? installmentSplit(financedTotal, opts.payments) : [NaN]
  const monthlyPayment = Math.max(...pieces)
  const maxFinancedAtThisLength = capacity.maxFinanced[opts.payments] ?? 0
  const allowed = opts.amount > 0
    && Number.isFinite(opts.amount)
    && monthlyPayment <= capacity.maxMonthlyPayment

  let refusal: string | null = null
  if (!allowed) {
    if (!(opts.amount > 0) || !Number.isFinite(opts.amount)) {
      refusal = 'A job has to have an amount before it can be spread over payments.'
    } else if (capacity.whyNone) {
      refusal = capacity.whyNone
    } else {
      // The other plan length is priced on ITS OWN row — a 4-payment plan costs
      // more than a 2-payment one, so comparing the job alone would promise a
      // monthly figure that does not exist.
      let other: { n: FinancingPaymentCount; monthly: number } | null = null
      for (const n of FINANCING_PAYMENT_COUNTS) {
        if (n === opts.payments) continue
        try {
          const f = await requireFinancingFee(opts.amount, n)
          const m = Math.max(...installmentSplit(cents(opts.amount + f), n))
          if (m <= capacity.maxMonthlyPayment) { other = { n, monthly: m }; break }
        } catch { /* not financeable at that length either */ }
      }
      refusal = other
        ? `Over ${opts.payments} payments this job comes to ${money(monthlyPayment)} a month, more than `
          + `the ${money(capacity.maxMonthlyPayment)} this company's flat rent supports. Over ${other.n} `
          + `payments it would be ${money(other.monthly)} a month, which it does.`
        : `This job comes to ${money(monthlyPayment)} a month over ${opts.payments} payments, and this `
          + `company's flat rent supports ${money(capacity.maxMonthlyPayment)} a month. Spread over four `
          + `payments it could carry about ${money(capacity.maxFinanced[4])} including the fee.`
    }
  }
  const outlay = sane
    ? financingOutlay({
        amount: opts.amount, payments: opts.payments, fee,
        // The cut comes from its own price card, as it does everywhere else.
        cutPercent: await requireMarketplaceCutPercent(opts.asOf ?? todayIn(null)),
      })
    : null
  return {
    allowed, financedTotal, fee, schedule: sane ? pieces : [], outlay,
    monthlyPayment, maxMonthlyPayment: capacity.maxMonthlyPayment,
    maxFinancedAtThisLength, capacity, refusal,
  }
}
