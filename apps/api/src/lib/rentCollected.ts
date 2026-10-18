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
import { query } from '../db'
import { todayIn, monthStartOf } from './timezone'
import { incomeEvents, summarize, ledgerOwedDay, landlordIncomeSql, type IncomeEvent } from '../services/incomeBasis'
import { withinCutoffsSql, cutoffsParam, type PropertyCutoff } from './bookkeeperScope'

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
 * @param opts.scope  'rent' (default: rent rows and money paid ahead — the rent
 *                    card) or 'all' (every income line: the dashboard's "Money
 *                    received this month" card). 10/17: NOT the property-health
 *                    percentage any more — that reads invoiced against paid,
 *                    its own figure below (rentHealthMtd), for the reasons
 *                    spelled out there.
 * @param opts.month  any day in the month (default: this month in Phoenix)
 * @param opts.cutoffs 10/12: a former property's facts after the day it left
 *                    are left out (a bookkeeper's clean cut at a sale)
 */
export async function collectedRentMtd(
  landlordIds?: string[] | null,
  property?: string | readonly string[] | null,
  opts: { scope?: 'rent' | 'all'; month?: string; basis?: IncomeBasis; cutoffs?: readonly PropertyCutoff[] } = {},
): Promise<RentCollected> {
  const start = monthStartOf((opts.month ?? todayIn(null)).slice(0, 10))
  const end = lastDayOf(start)
  const propertyIds = property == null ? null : typeof property === 'string' ? [property] : [...property]
  const q = { landlordIds: landlordIds ?? null, start, end, propertyIds, cutoffs: opts.cutoffs }
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
  // 10/12 (Nic, ledger P8): on the books, of what was billed — what tenants
  // paid against bills in the month, and what they still owed at its end
  // (every bill, design §10); nothing is "clearing" on the books.
  const fromBooks = bx.some(e => !!e.ledger)
  const picked = fromBooks ? pick(bx) : []
  const owedDay = fromBooks ? ledgerOwedDay(picked) : null
  const sumOf = (f: (e: IncomeEvent) => boolean) => round2(picked.filter(f).reduce((x, e) => x + e.amount, 0))
  return {
    basis,
    collected: r.total,
    inFlight: r.beside.clearing,
    paidAhead: r.lines.paidAhead,
    billed: fromBooks
      ? {
          amount: b.total,
          collected: round2(-sumOf(e => e.ledger === 'proof' && e.proofTerm === 'received')) || 0,
          clearing: 0,
          stillOwed: sumOf(e => e.ledger === 'owed' && e.day === owedDay),
        }
      : {
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

// ─── The payment-health percentage ──────────────────────────────────────────

/**
 * 10/17 (Nic): "when I sort my dashboard between all properties and a specific
 * property, something is not reading right... I've got $2,000 in outstanding
 * rent, but my payment health is only showing sixty-five percent... When I pick
 * Mountain View, it goes up to 67%. That is crazy wrong for how few people have
 * left to pay." And the rule he gave: "the property health matches what was
 * invoiced and what was paid. work trade isnt billed until a shortfall so it
 * shouldnt apply here unless an invoice generates."
 *
 * So the health card gets its OWN figure, BESIDE the money cards rather than
 * out of them. Money received and Money billed answer a different question —
 * what arrived, what was charged — and the books parity check leans on both, so
 * neither can be bent to this one. Health read the Money billed figures, and
 * two things were wrong with that:
 *
 *   1. RENT HELD FOR WORK TRADE counted as billed and unpaid. The books charge
 *      a bill on hold for work trade on its due day like any other bill, while
 *      the money records leave it out until the work-trade month settles —
 *      services/ledgerParity names that as a difference the books make on
 *      purpose. Mountain View went live on the books on 10/14, so from that day
 *      its seven held bills, $3,478, sat inside what was "billed" with nothing
 *      against them, in a month where nobody owes them: they settle in HOURS,
 *      and only a shortfall ever becomes a bill. Out of BOTH sides until an
 *      invoice really generates.
 *   2. RENT SETTLED BY SOMETHING OTHER THAN MONEY did not count as paid. Rent
 *      paid with an account credit, or with money the resident paid ahead,
 *      settles the bill — but no money arrives this month, so the "money
 *      received against bills" half of the books' receivables movement never
 *      sees it. $1,791.36 of Mountain View's October rent, most of it one
 *      resident's bill covered by a credit for money she had paid off-platform.
 *
 * Measured 10/16 on Mountain View's October: the card read $21,980 billed
 * against $14,649.64 received, 67%. Invoiced against paid it reads $18,502
 * against $16,441 — 89%, $2,061 left to collect, which is the "$2,000" Nic said
 * he had left.
 *
 * WHAT `owed` IS NOT: the Outstanding card beside it on the dashboard
 * (routes/landlords.ts, the S640/S654 block). That card sums EVERY open invoice
 * balance — all charge types, every month — so it is a running receivables
 * figure, while `owed` here is THIS MONTH'S RENT alone. The two are the same
 * money only when nothing else is open, which is why Mountain View looks like
 * agreement and the portfolio does not: measured 10/17, Mountain View reads
 * $1,415 either way, while Oak Park's October rent owes $3,300 against an
 * Outstanding card of $8,354.43 — September rent and utilities that really are
 * owed, and that this figure has no business hiding. So each number says on
 * screen which months and which charges it counts, and neither is bent to match
 * the other.
 *
 * The figure, then: a month's RENT BILLS by due date, bills on hold for work
 * trade left out, and a bill counts as PAID once it is settled whatever settled
 * it — money, money still clearing at the bank (the resident has paid, the bank
 * is moving it), money kept from a deposit, an account credit, money paid
 * ahead. Read off the money records whichever source the reports read, because
 * "what was invoiced and what was paid" is a question about the bills, and the
 * Outstanding card beside it reads them too.
 */
export interface RentHealth {
  /** The month's rent bills, the ones on hold for work trade left out. */
  invoiced: number
  /** Of `invoiced`, the part that is settled — whatever settled it. */
  paid: number
  /** `invoiced` less `paid`: what residents still owe on the month's rent. */
  owed: number
  /** Rent on hold for work trade this month — in neither figure above. */
  workTradeHeld: number
}

/**
 * @param landlordIds null/undefined = platform-wide (admin lens); [] = nothing
 * @param property    one property (the dashboard's picker), a list (a team
 *                    member's properties), or null for every one
 * @param opts.month  any day in the month (default: this month in Phoenix)
 * @param opts.cutoffs a bookkeeper's clean cut at a sale (lib/bookkeeperScope)
 */
export async function rentHealthMtd(
  landlordIds?: string[] | null,
  property?: string | readonly string[] | null,
  opts: { month?: string; cutoffs?: readonly PropertyCutoff[] } = {},
): Promise<RentHealth> {
  const propertyIds = property == null ? null : typeof property === 'string' ? [property] : [...property]
  if (landlordIds?.length === 0 || propertyIds?.length === 0) {
    return { invoiced: 0, paid: 0, owed: 0, workTradeHeld: 0 }
  }
  const start = monthStartOf((opts.month ?? todayIn(null)).slice(0, 10))
  const end = lastDayOf(start)
  // The same statuses the rent card calls "sent": landed, still clearing at the
  // bank, or kept from a deposit. A returned or failed charge is owed again.
  const SENT = RENT_RECEIVED_STATUSES.map(s => `'${s}'`).join(', ')
  const HELD = 'p.work_trade_suspended_at'
  const [r] = await query<{ invoiced: number; paid: number; work_trade_held: number }>(`
    SELECT COALESCE(SUM(GREATEST(p.amount, 0)) FILTER (WHERE ${HELD} IS NULL), 0)::float AS invoiced,
           COALESCE(SUM(GREATEST(p.amount, 0)) FILTER (WHERE ${HELD} IS NULL
                      AND p.status IN (${SENT})), 0)::float AS paid,
           COALESCE(SUM(GREATEST(p.amount, 0)) FILTER (WHERE ${HELD} IS NOT NULL), 0)::float AS work_trade_held
      FROM payments p
      LEFT JOIN leases pl ON pl.id = p.lease_id
      LEFT JOIN units u ON u.id = COALESCE(p.unit_id, pl.unit_id)
     WHERE ($1::uuid[] IS NULL OR p.landlord_id = ANY($1::uuid[]))
       AND p.type = 'rent' AND ${landlordIncomeSql('p')}
       -- A voided charge is owed by nobody and was never paid; it is out of
       -- every figure (the rule services/incomeBasis payCte applies).
       AND p.status <> 'voided'
       AND p.due_date BETWEEN $2::date AND $3::date
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
       AND ${withinCutoffsSql('u.property_id', 'p.due_date', '$5')}`,
    [landlordIds ?? null, start, end, propertyIds, cutoffsParam(opts.cutoffs)])
  const invoiced = round2(Number(r?.invoiced ?? 0))
  const paid = round2(Number(r?.paid ?? 0))
  return { invoiced, paid, owed: round2(invoiced - paid), workTradeHeld: round2(Number(r?.work_trade_held ?? 0)) }
}
