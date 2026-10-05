/**
 * S642 (Nic): ONE definition of "rent collected this month".
 *
 *   "There is a four hundred and sixty dollar discrepancy there… Collected this
 *    month needs to show any in-flight stuff. Those two cards need to match up."
 *
 * S655 (money plan, Step 3): the figure now follows the "Money received" /
 * "Money billed" switch, from the same facts every report reads
 * (services/incomeBasis), so the dashboard card, the Reports page and the agent
 * cannot disagree:
 *
 *   Money received — the money that ARRIVED this month (Nic, 10/2: "how much
 *     money came in this month, ACTUALLY came in"). Paid-ahead money counts the
 *     day it arrives and $0 when it pays this month's bill. Money still
 *     clearing (ACH takes ~4 business days) is its OWN figure beside it — the
 *     card says "+ $Y still clearing" — never summed into what arrived.
 *   Money billed — what was billed this month (by due date, credits the
 *     landlord gave taken off), with collected so far, clearing and still owed
 *     inside it.
 *
 * A FlexPay pull is never collected rent (GAM collecting its own float back).
 *
 * S642 parity: every landlord-facing card that says "collected this month"
 * reads this — the landlord dashboard's rent and income cards (routes/
 * landlords.ts, through rentCollectedFrom), the Reports summary (routes/
 * reports.ts) and the agent's portfolio stats (getPortfolioStats). A card that
 * sums the full amount of settled + processing + paid_via_deposit rows instead
 * counts credit-paid parts and money still clearing as arrived, and disagrees
 * with these. The admin overview does NOT read this (it did not at HEAD
 * either): its "monthly rent volume" is its own platform-wide SQL in
 * routes/admin.ts, the full amount of rent rows settled, clearing or kept
 * from a deposit — a volume figure, not a landlord's income.
 */
import { DEFAULT_INCOME_BASIS, type IncomeBasis } from '@gam/shared'
import { todayIn, monthStartOf } from './timezone'
import { incomeEvents, summarize, type IncomeEvent } from '../services/incomeBasis'

/** Rent the tenant has SENT — landed, or debited and still clearing. */
export const RENT_RECEIVED_STATUSES = ['settled', 'processing', 'paid_via_deposit'] as const

export interface RentCollected {
  basis: IncomeBasis
  /** Money received this month (Money received), NOT counting money still clearing. */
  collected: number
  /** Money still clearing — shown beside `collected`, never inside it. */
  inFlight: number
  /** Of `collected`, paid-ahead money that arrived this month for later bills. */
  paidAhead: number
  /** Money billed this month: the bill and what became of it (adds up to `amount`). */
  billed: { amount: number; collected: number; clearing: number; stillOwed: number }
}

const round2 = (n: number) => Math.round(n * 100) / 100

function lastDayOf(monthFirst: string): string {
  const [y, m] = monthFirst.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * @param landlordIds null/undefined = platform-wide (admin lens)
 * @param property    optional property filter: one property (the landlord
 *                    dashboard's picker) or a list (a team member assigned to
 *                    some properties sees only theirs; an empty list sees nothing)
 * @param opts.scope  'rent' (default: rent rows and money paid ahead, the rent
 *                    card and the property-health percentage) or 'all' (every
 *                    income line: the dashboard's "Money received this month"
 *                    card)
 * @param opts.month  any day in the month (default: this month in Phoenix)
 */
export async function collectedRentMtd(
  landlordIds?: string[] | null,
  property?: string | readonly string[] | null,
  opts: { scope?: 'rent' | 'all'; month?: string; basis?: IncomeBasis } = {},
): Promise<RentCollected> {
  const start = monthStartOf((opts.month ?? todayIn(null)).slice(0, 10))
  const end = lastDayOf(start)
  const propertyIds = property == null ? null : typeof property === 'string' ? [property] : [...property]
  const q = { landlordIds: landlordIds ?? null, start, end, propertyIds }
  const [rx, bx] = await Promise.all([
    incomeEvents({ ...q, basis: 'received' }),
    incomeEvents({ ...q, basis: 'billed' }),
  ])
  return rentCollectedFrom(rx, bx, opts.scope ?? 'rent', opts.basis ?? DEFAULT_INCOME_BASIS)
}

/**
 * The same figures from facts already read for ONE month (a screen that has
 * read a wider window filters it to the month first). Pure.
 */
export function rentCollectedFrom(
  rx: readonly IncomeEvent[], bx: readonly IncomeEvent[], scope: 'rent' | 'all', basis: IncomeBasis,
): RentCollected {
  // Rent scope: the rent rows only — their own money (kept from a deposit
  // included), a reversal of it, their clearing, their bill and its credits —
  // plus money paid ahead that arrived this month (shown as "incl. $X paid
  // ahead"; it is almost always rent, and under Money received it counts the
  // day it arrives, not again when it pays the rent), and what takes it back
  // off: paid-ahead money handed back at move-out, and the clawback of
  // paid-ahead money whose charge was disputed (a 'returned' line with no
  // category — every other reversal carries its row's category).
  //
  // Reservation money is never rent: a reservation deposit counted as a stay
  // the day it was paid. So the stay-shortened money Money billed takes back
  // off the reservation ("Moved to credit"), and the reservation money handed
  // back or kept at move-out (a 'paidAheadRefunded' fact incomeBasis files
  // under the stay — a deposit's leftover, or a shortened stay's reservation
  // share), stay off the rent card; only paid-ahead money handed back with no
  // category is rent's.
  //
  // A move-out whose shortfall is larger than its deductions needs nothing
  // extra here: incomeBasis puts each swept bill's share of that shortfall on
  // the bill's own row (matched to the move-out, never by lease, so a bill
  // swept from the previous lease of a renewal chain is included). Swept rent
  // therefore counts what the pool kept for it under Money received, and
  // under Money billed its share of the shortfall is still owed — so the rent
  // card and the income card agree when all that was swept was rent. When the
  // tenant pays the shortfall, Money received hands each swept bill its share
  // back under the bill's category ("Deposit shortfall collected"), so the
  // rent card collects the swept rent then, as Money billed does.
  const RENT_LINES = new Set([
    'rent', 'keptFromDeposits', 'depositShortfall', 'returned', 'stayShortened', 'creditsGiven', 'clearing', 'creditsYouGave',
  ])
  const rentOnly = (e: IncomeEvent) =>
    (e.category === 'space_rent' && RENT_LINES.has(e.line))
    || e.line === 'paidAhead'
    || (e.line === 'paidAheadRefunded' && e.category === null)
    // The clawback of disputed paid-ahead money: no category and no bill behind it.
    || (e.line === 'returned' && e.category === null && e.paymentId === null)
  const pick = (list: readonly IncomeEvent[]) => scope === 'rent' ? list.filter(rentOnly) : list
  const r = summarize(pick(rx), 'received')
  const b = summarize(pick(bx), 'billed')
  return {
    basis,
    collected: r.total,
    inFlight: r.beside.clearing,
    paidAhead: r.lines.paidAhead,
    billed: {
      amount: b.total,
      collected: b.beside.collectedSoFar,
      clearing: b.beside.clearing,
      stillOwed: b.beside.stillOwed,
    },
  }
}

/** The income card's shape from the 'all'-scope figures. */
export function incomeCardFrom(all: RentCollected, basis: IncomeBasis): IncomeCard {
  return {
    basis,
    received: { amount: all.collected, paidAhead: all.paidAhead, clearing: round2(all.inFlight) },
    billed: all.billed,
  }
}

export interface IncomeCard {
  basis: IncomeBasis
  received: { amount: number; paidAhead: number; clearing: number }
  billed: { amount: number; collected: number; clearing: number; stillOwed: number }
}

/** The dashboard's income card, both ways (the switch picks which one leads). */
export async function incomeCardMtd(
  landlordIds: string[] | null, property: string | readonly string[] | null, basis: IncomeBasis, month?: string,
): Promise<IncomeCard> {
  const all = await collectedRentMtd(landlordIds, property, { scope: 'all', month, basis })
  return incomeCardFrom(all, basis)
}
