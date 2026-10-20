/**
 * 10/11 (Nic) — MONEY IN, BY TYPE.
 *
 *   "incoming income type pools, monthly, daily, electric bill back, etc."
 *
 * What a bookkeeper (and the owner, on the same page) reads instead of a
 * payment list: the money that arrived, added up by what it was for, by month
 * and by day. NOTHING per person — no tenant, no name, no unit, no lease — so
 * it can be handed to someone who keeps the books without handing them the
 * rent roll.
 *
 * Built on the one income definition every report reads (services/incomeBasis,
 * Money received), so the total here IS the P&L's income total for the same
 * days and properties. A pool is:
 *   - lot/space rent, split by how the space is rented: a lease's own rent is
 *     "Monthly rent"; rent on a lease drafted from a reservation follows that
 *     reservation (nightly, weekly, month) — RENT_POOLS
 *   - every other income category as the reports already name it (electric,
 *     water, sewer, trash, propane, late fees, home payments, register sales,
 *     stays and pay links, other income, ...) — INCOME_CATEGORIES
 *   - money in the total with no category (paid ahead, kept from deposits,
 *     returned or disputed, ...) under its P&L line's name — REPORT_LINES
 * Deposits received are NOT income (they are held), so they sit beside the
 * total, never inside it. 10/11: so do bank deposits filed as an owner
 * contribution or the proceeds of a sale (incomeBasis puts them beside the
 * total): they are money that reached the bank, so the page lists them under
 * the total instead of dropping them from view (besideTotal). *
 * 10/12 (Nic): Charged and Owed beside Received, per type — the Money billed
 * facts for the same days and properties (each bill in the month it was due,
 * less credits given; what of it is still owed today), pooled the same way.
 * The months and days stay money that arrived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 10/19 (Nic) — THE ROWS ARE THE LINES THE BOOKS KEEP.
 *
 *   "i need the books breakdown for september mountain view. it still looks
 *    the same for betty she doesnt see any new information."
 *   "We need to make the books actually display the right way. So that she can
 *    see it if she needs to go back to it later."
 *
 * The 10/17 itemization works — the ledger splits rent by the space it is for
 * into real accounts (4010-1 RV long-term rent, 4010-2 Mobile home lot rent,
 * …) — and NONE of it reached this page, because this page grouped rent by the
 * payment cadence (monthly / nightly / weekly / month stays) instead. So the
 * person reading what came in saw one "Monthly rent" line while the books
 * underneath had the unit-type split she files from.
 *
 * Once a company's reports read the ledger, the rows here are the books' own
 * lines: each fact is split by the income lines it was posted on
 * (IncomeEvent.detail, services/ledgerReports — one rule for every report, no
 * second taxonomy here), and what no line itemizes keeps its group's own row,
 * named "… — not itemized". No company that is not on the ledger changes at
 * all: it has no itemized facts, so it reads exactly as it did.
 *
 * THE CADENCE IS NOT DROPPED (Nic, 10/17: short-term stays must be
 * distinguishable from long-term). Cadence and term are INDEPENDENT facts
 * about one dollar — a lease drafted from a nightly reservation is long-term
 * rent sold by the night — so nesting one inside the other would print a
 * contradiction. They are two groupings of ONE set of facts, side by side:
 * `pools` by what the books call it, `rentSoldAs` by how the space was sold.
 * Both are read off the same facts in the same pass, so rentSoldAs is the
 * lot/space rent of `pools` to the cent — its own test holds it there.
 *
 * WHAT WAS SOLD, AND THE LUMPS. The item detail under Register sales and the
 * words on each entry filed as other money in are NOT rebuilt here: they are
 * services/booksTaxSales' own read (the Sales & tax page's), off the same
 * postings, so the two pages cannot disagree. That read only exists for a
 * company on the ledger, which is the only company this page itemizes for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 10/19 (review) — THE CADENCE IS READ OFF THE RENT ROWS, NOT OFF THE BILL.
 *
 * "rentSoldAs is the lot/space rent of `pools` to the cent" was asserted above
 * and was not true. The rent rows are the ledger's rent LINES, and money that
 * came in as a long-term stay posts to a rent line too — the books' own rule,
 * a month stay or 30 nights and over is long-term rent — while rentSoldAs only
 * counted facts whose bill was categorized as space rent. At Mountain View in
 * October that left $1,178.00 charged and $1,767.00 received sitting on the
 * rent rows and outside a card that says on screen it is the same money.
 *
 * So the cadence is now added up FROM THE ROWS: the lot/space rent inside each
 * fact's own rows, on the cadence the lease it was billed on was sold at. A
 * stay carries no lease to read a cadence off, and a 30-night stay can have
 * been sold by the night, the week or the month, so that money is shown as the
 * long-term stay it is rather than filed under a cadence GAM guessed at. The
 * card adds up to the rent rows in every column again, and it cannot drift
 * apart from them the next time the rows change, because it is made of them.
 *
 * 10/19 (review) — AND THE CADENCE IS BY MONTH AND BY DAY TOO. The month and
 * day tables take their columns from the rows, so when the rows became the
 * books' lines the cadence columns went out of those tables with them: "how
 * much nightly stay rent came in in September?" had no answer on the page any
 * more. Every month and every day now carries its own cadence cut of the rent
 * it received (PoolPeriod.rentSoldAs), beside the lines and never mixed into
 * them, so the same question reads the same way at every grain.
 */
import {
  RENT_POOLS, RENT_POOL_LABEL, INCOME_CATEGORIES, INCOME_CATEGORY_LABEL,
  LEDGER_RENT_LINES, LEDGER_STAY_LINES, ledgerIncomeDetailOf, ledgerIncomeNotItemizedLabel,
  type RentPool, type IncomeCategory, type BooksSalesBreakdown, type BooksOtherIncomeBreakdown,
} from '@gam/shared'
import { query } from '../db'
import type { PropertyCutoff } from '../lib/bookkeeperScope'
import { booksSoldDetail } from './booksTaxSales'
import {
  incomeEvents, basisMeta, REPORT_LINES, REPORT_LINE_LABEL, ASIDE_LINE_LABEL, ledgerOwedDay,
  type IncomeEvent, type ReportLine,
} from './incomeBasis'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Every pool key in display order: rent pools, then categories, then uncategorized lines. */
export const INCOME_POOL_ORDER: readonly string[] = [
  ...RENT_POOLS,
  ...INCOME_CATEGORIES.filter(c => c !== 'space_rent'),
  ...REPORT_LINES,
]

/**
 * 10/19: the itemized lines a category's money splits into, in the books' own
 * report order (packages/shared booksLedger: the line's sub-account under Space
 * and lot rent / Stay income, and the home-sale roles). The keys are
 * ledgerIncomeDetailOf's, so a row here and a line on the monthly report are
 * the same line with the same name.
 */
const DETAIL_KEYS_OF: Partial<Record<IncomeCategory, readonly string[]>> = {
  space_rent:          LEDGER_RENT_LINES.map(v => `rent_line:${v}`),
  stays_and_pay_links: LEDGER_STAY_LINES.map(v => `stay_line:${v}`),
  home_payments:       ['home_sales', 'home_note_interest'],
}

/**
 * 10/19: the pool order for a company whose reports read the ledger — every
 * category's itemized lines, then the category itself (the part of it no line
 * itemizes), then the money with no category. Rent is NOT grouped by cadence
 * here: that is `rentSoldAs`, the same money cut the other way.
 */
export const LEDGER_INCOME_POOL_ORDER: readonly string[] = [
  ...INCOME_CATEGORIES.flatMap(c => [...(DETAIL_KEYS_OF[c] ?? []), c as string]),
  ...REPORT_LINES,
]

/** The itemized line a pool key is, when it is one (ledgerIncomeDetailOf's own answer). */
function detailOfKey(key: string): { label: string } | null {
  const at = key.indexOf(':')
  return at < 0 ? ledgerIncomeDetailOf(null, null, key) : ledgerIncomeDetailOf(key.slice(0, at), key.slice(at + 1))
}

export function incomePoolLabel(key: string): string {
  const detail = detailOfKey(key)
  if (detail) return detail.label
  if ((RENT_POOLS as readonly string[]).includes(key)) return RENT_POOL_LABEL[key as RentPool]
  if ((INCOME_CATEGORIES as readonly string[]).includes(key)) return INCOME_CATEGORY_LABEL[key as IncomeCategory]
  if ((REPORT_LINES as readonly string[]).includes(key)) return REPORT_LINE_LABEL[key as ReportLine]
  return 'Other'
}

/** unit_bookings.lease_type → the rent pool a stay's rent lands in. */
const STAY_POOL: Record<string, RentPool> = {
  nightly:        'nightly_stays',
  weekly:         'weekly_stays',
  month_to_month: 'month_stays',
  long_term:      'month_stays',
}

/**
 * 10/19 (review): the row rent money sits on when there is no cadence on
 * record for it. Money that arrived as a LONG-TERM STAY books to a rent line
 * (the books' own rule: a month stay, or 30 nights and over, is long-term
 * rent), so it is on the rent rows — but a stay is not billed on a lease, so
 * there is no reservation to read a cadence off, and a 30-night stay can have
 * been sold by the night, by the week or by the month. The money is shown as
 * the long-term stay it is instead of being filed under a guess, so the card
 * still adds up to the rent rows to the cent.
 */
const RENT_SOLD_LONG_TERM_STAY = 'long_term_stay'
const RENT_SOLD_LONG_TERM_STAY_LABEL = 'Sold as a long-term stay'
/** Every row the cadence card can show, in display order. */
const RENT_SOLD_ORDER: readonly string[] = [...RENT_POOLS, RENT_SOLD_LONG_TERM_STAY]
const rentSoldLabel = (key: string): string =>
  key === RENT_SOLD_LONG_TERM_STAY ? RENT_SOLD_LONG_TERM_STAY_LABEL : RENT_POOL_LABEL[key as RentPool]

/** A row that holds lot/space rent: an itemized rent line, or the group itself. */
const isRentRow = (key: string): boolean => key === 'space_rent' || key.startsWith('rent_line:')

/**
 * The lot/space rent inside one fact's rows — exactly the money the rent rows
 * hold, which is what makes the cadence card the same money as those rows.
 */
function rentOfRows(pieces: readonly { key: string; amount: number }[]): number {
  return round2(pieces.reduce((t, p) => t + (isRentRow(p.key) ? p.amount : 0), 0))
}

/** Money beside a total, never in it. */
export interface BesideRow { key: string; label: string; amount: number }

export interface PoolRow {
  key: string; label: string
  /** Received: money that arrived (the pool's figure since 10/11). */
  amount: number
  /** 10/12: Charged and Owed for the same type and days. */
  charged: number; owed: number
}

/**
 * 10/11: money in the bank that is not income, listed beside the total (never
 * in it).
 *
 * 10/19 (Nic): tax collected joins them. It arrived with a sale and it is the
 * agency's, never income — but it WAS one of the September figures at Mountain
 * View ($8.95 of privilege tax), and a figure that is simply absent from the
 * page a bookkeeper reads is the problem this whole pass is about. It is listed
 * beside the total exactly as deposits received are, and never inside it. What
 * has been sent on and what is still sitting in each tax account is the Sales &
 * tax page's answer; this one only says the money came in.
 */
const BESIDE_TOTAL_LINES = ['ownerContributions', 'saleProceeds', 'taxCollected'] as const
type BesideTotalLine = typeof BESIDE_TOTAL_LINES[number]
const isBesideTotal = (line: string): line is BesideTotalLine =>
  (BESIDE_TOTAL_LINES as readonly string[]).includes(line)
/**
 * A period's pools as a LIST of { key, amount }, never an object keyed by pool:
 * the API camelizes every object key on the way out, which would turn
 * 'monthly_rent' into 'monthlyRent' and part it from its own label.
 */
export interface PoolPeriod {
  total: number; depositsHeld: number; pools: Array<{ key: string; amount: number }>
  /** Not income and not in `total`: owner contributions and sale proceeds (non-zero only). */
  besideTotal: BesideRow[]
  /**
   * 10/19 (review): the lot/space rent this month or day received, by how the
   * space was sold — the same money as its own rent rows, cut the other way, so
   * "how much nightly stay rent came in in September?" has an answer at every
   * grain and not only for the whole period. A list for the same reason `pools`
   * is one: the API camelizes object keys, and a cadence key is data.
   * Empty for a company whose rows are still the cadence itself.
   */
  rentSoldAs: Array<{ key: string; amount: number }>
}
interface PoolAcc {
  total: number; depositsHeld: number; pools: Map<string, number>; notIncome: Map<BesideTotalLine, number>
  /** The rent of `pools`, by how the space was sold (10/19 review). */
  soldAs: Map<string, number>
}

export interface IncomePools {
  period: { start: string; end: string }
  basis: ReturnType<typeof basisMeta>
  pools: PoolRow[]
  total: number
  /** 10/12: the Charged and Owed totals beside `total` (Received). */
  charged: number
  owed: number
  depositsHeld: number
  besideTotal: BesideRow[]
  months: Array<{ month: string } & PoolPeriod>
  days: Array<{ day: string } & PoolPeriod>
  /**
   * 10/19 (Nic): TRUE when the rows above are the lines the company's books
   * keep (its reports read the ledger). FALSE: the rows are the older groups,
   * rent by how it is paid for — nothing below is filled in.
   */
  itemized: boolean
  /**
   * 10/19: the SAME lot/space rent money as the rent rows above, grouped by how
   * the space was sold (a lease's own rent, or the nightly / weekly / monthly
   * reservation its lease was drafted from). Two cuts of one set of facts: this
   * adds up to the rent rows to the cent.
   */
  rentSoldAs: PoolRow[]
  /** 10/19: every item the period's register sales sold, and how it ties to the Register sales account. */
  register?: BooksSalesBreakdown
  /** 10/19: money filed as other money in rather than rung up, in the words of each record. */
  otherMoneyIn?: BooksOtherIncomeBreakdown
}

/**
 * The pool one fact belongs to, or null when it is not in the total.
 * `itemized`: the company reads the ledger, so rent is NOT pooled by cadence —
 * the fact's own itemized lines are its rows (poolPiecesOf) and this is only
 * the group the part no line itemizes falls back to.
 */
export function poolOf(e: IncomeEvent, stayTypeByLease: Map<string, string>, itemized = false): string | null {
  if (!e.inTotal) return null
  if (e.category === 'space_rent' && !itemized) {
    const stay = e.leaseId ? stayTypeByLease.get(e.leaseId) : undefined
    return (stay && STAY_POOL[stay]) || 'monthly_rent'
  }
  if (e.category) return e.category
  return e.line
}

/**
 * 10/19: the rows one fact lands on — the income lines the books posted it on
 * (its share of each), and what they do not cover on its own group's row. A
 * fact's pieces add up to its amount, so every column still totals what it did.
 */
export function poolPiecesOf(
  e: IncomeEvent, stayTypeByLease: Map<string, string>, itemized: boolean,
): Array<{ key: string; amount: number }> {
  // A fact in no total has no row, itemized or not (the Owed column reads the
  // amounts still owed as though they were, and says so where it does).
  if (!e.inTotal) return []
  const group = poolOf(e, stayTypeByLease, itemized)
  if (!itemized || !e.detail?.length) return group ? [{ key: group, amount: e.amount }] : []
  const out: Array<{ key: string; amount: number }> = []
  for (const p of e.detail) {
    if (!p.amount) continue
    const same = out.find(x => x.key === p.key)
    if (same) same.amount = round2(same.amount + p.amount)
    else out.push({ key: p.key, amount: p.amount })
  }
  const left = round2(e.amount - out.reduce((a, x) => a + x.amount, 0))
  if (Math.abs(left) >= 0.005 && group) out.push({ key: group, amount: left })
  return out
}

/**
 * 10/19 (review): how the space one fact's rent was for was sold. A lease
 * follows the reservation it was drafted from, else it is the lease's own
 * monthly rent. Stay money has no lease, so it goes on the long-term-stay row
 * rather than under a cadence nothing on record says (see
 * RENT_SOLD_LONG_TERM_STAY). Which money this applies to is the rows' answer
 * (rentOfRows), never the bill's category.
 */
function rentSoldAsOf(e: IncomeEvent, stayTypeByLease: Map<string, string>): string {
  const stay = e.leaseId ? stayTypeByLease.get(e.leaseId) : undefined
  if (stay && STAY_POOL[stay]) return STAY_POOL[stay]
  return e.category === 'stays_and_pay_links' ? RENT_SOLD_LONG_TERM_STAY : 'monthly_rent'
}

export async function incomePools(q: {
  landlordIds: string[]; propertyIds: string[] | null; start: string; end: string
  /** 10/12: a former property's money stops at the day it left (lib/bookkeeperScope). */
  cutoffs?: readonly PropertyCutoff[]
}): Promise<IncomePools> {
  const [events, billed] = await Promise.all([
    incomeEvents({
      landlordIds: q.landlordIds, propertyIds: q.propertyIds, start: q.start, end: q.end, basis: 'received',
      cutoffs: q.cutoffs,
    }),
    incomeEvents({
      landlordIds: q.landlordIds, propertyIds: q.propertyIds, start: q.start, end: q.end, basis: 'billed',
      cutoffs: q.cutoffs,
    }),
  ])
  // 10/19: the facts came from the books, so they carry the lines each was
  // posted on and the rows are those lines (see the header).
  const itemized = events.some(e => !!e.ledger) || billed.some(e => !!e.ledger)
  const order = itemized ? LEDGER_INCOME_POOL_ORDER : INCOME_POOL_ORDER
  // How each lease's space is rented: by the reservation it was drafted from.
  // 10/19 (review): stay money can carry a lease too (a lease drafted from a
  // reservation), so its cadence is read the same way rather than assumed.
  const RENT_ROW_CATEGORIES = ['space_rent', 'stays_and_pay_links']
  const leaseIds = [...new Set([...events, ...billed]
    .filter(e => e.leaseId && (!e.category || RENT_ROW_CATEGORIES.includes(e.category)))
    .map(e => e.leaseId!))]
  const stayTypeByLease = new Map<string, string>()
  if (leaseIds.length) {
    const rows = await query<{ id: string; lease_type: string }>(
      `SELECT l.id, b.lease_type FROM leases l JOIN unit_bookings b ON b.id = l.source_booking_id
        WHERE l.id = ANY($1::uuid[])`, [leaseIds])
    for (const r of rows) stayTypeByLease.set(r.id, r.lease_type)
  }

  const blank = (): PoolAcc => ({ total: 0, depositsHeld: 0, pools: new Map(), notIncome: new Map(), soldAs: new Map() })
  const all = blank()
  const months = new Map<string, PoolAcc>()
  const days = new Map<string, PoolAcc>()
  const add = (
    p: PoolAcc, pieces: Array<{ key: string; amount: number }>, e: IncomeEvent,
    sold?: { key: string; amount: number },
  ) => {
    if (pieces.length) {
      for (const x of pieces) p.pools.set(x.key, (p.pools.get(x.key) ?? 0) + x.amount)
      p.total += e.amount
      if (sold) p.soldAs.set(sold.key, (p.soldAs.get(sold.key) ?? 0) + sold.amount)
    } else if (e.line === 'depositsHeld') {
      p.depositsHeld += e.amount
    } else if (isBesideTotal(e.line)) {
      p.notIncome.set(e.line, (p.notIncome.get(e.line) ?? 0) + e.amount)
    }
  }
  // 10/19: rent the other way round — by how the space was sold. Taken from the
  // facts' own rent ROWS (rentOfRows), so it cannot add up to a different figure
  // than those rows do, whatever the bill it arrived on was categorized as.
  const soldChargedBy = new Map<string, number>()
  const soldOwedBy = new Map<string, number>()
  /** The rent in one fact's rows and the row it was sold on, when there is any. */
  const soldOf = (e: IncomeEvent, pieces: Array<{ key: string; amount: number }>) => {
    if (!itemized) return undefined
    const amount = rentOfRows(pieces)
    return amount ? { key: rentSoldAsOf(e, stayTypeByLease), amount } : undefined
  }
  for (const e of events) {
    const pieces = poolPiecesOf(e, stayTypeByLease, itemized)
    if (!pieces.length && e.line !== 'depositsHeld' && !isBesideTotal(e.line)) continue
    const m = e.day.slice(0, 7)
    if (!months.has(m)) months.set(m, blank())
    if (!days.has(e.day)) days.set(e.day, blank())
    const sold = soldOf(e, pieces)
    add(all, pieces, e, sold); add(months.get(m)!, pieces, e, sold); add(days.get(e.day)!, pieces, e, sold)
  }
  const tidy = (p: PoolAcc): PoolPeriod => ({
    total: round2(p.total),
    depositsHeld: round2(p.depositsHeld),
    pools: order
      .map(k => ({ key: k, amount: round2(p.pools.get(k) ?? 0) }))
      .filter(x => x.amount !== 0),
    besideTotal: BESIDE_TOTAL_LINES
      .map(k => ({ key: k, label: ASIDE_LINE_LABEL[k], amount: round2(p.notIncome.get(k) ?? 0) }))
      .filter(x => x.amount !== 0),
    rentSoldAs: RENT_SOLD_ORDER
      .map(k => ({ key: k, amount: round2(p.soldAs.get(k) ?? 0) }))
      .filter(x => x.amount !== 0),
  })
  // 10/12: Charged and Owed per type, from the bills of the same days.
  const chargedBy = new Map<string, number>()
  const owedBy = new Map<string, number>()
  // 10/12 (Nic, ledger P8): on the books, Owed is what tenants still owed at
  // the end of the last day read (the 'owed' facts); facts in no total are
  // never Charged.
  const owedDay = ledgerOwedDay(billed)
  for (const e of billed) {
    if (e.ledger === 'owed') {
      // An amount owed is in no total itself; it is owed on its bill's type.
      if (e.day !== owedDay) continue
      const owedPieces = poolPiecesOf({ ...e, inTotal: true }, stayTypeByLease, itemized)
      for (const x of owedPieces) owedBy.set(x.key, (owedBy.get(x.key) ?? 0) + x.amount)
      const owedSold = soldOf(e, owedPieces)
      if (owedSold) soldOwedBy.set(owedSold.key, (soldOwedBy.get(owedSold.key) ?? 0) + owedSold.amount)
      continue
    }
    if (!e.inTotal) continue
    const pieces = poolPiecesOf(e, stayTypeByLease, itemized)
    if (!pieces.length) continue
    for (const x of pieces) chargedBy.set(x.key, (chargedBy.get(x.key) ?? 0) + x.amount)
    if (e.part === 'stillOwed') for (const x of pieces) owedBy.set(x.key, (owedBy.get(x.key) ?? 0) + x.amount)
    const sold = soldOf(e, pieces)
    if (sold) {
      soldChargedBy.set(sold.key, (soldChargedBy.get(sold.key) ?? 0) + sold.amount)
      if (e.part === 'stillOwed') soldOwedBy.set(sold.key, (soldOwedBy.get(sold.key) ?? 0) + sold.amount)
    }
  }
  // 10/19: what was sold item by item, and the lumps filed as other money in —
  // services/booksTaxSales' own read (the Sales & tax page's), off the same
  // postings. Only for a company on the ledger: there are no postings to read
  // otherwise, and its rows are not itemized anyway.
  const sold = itemized
    ? await booksSoldDetail(
      { landlordIds: q.landlordIds, propertyIds: q.propertyIds ?? null, cutoffs: q.cutoffs ?? null },
      q.start.slice(0, 10), q.end.slice(0, 10))
    : null
  const t = tidy(all)
  return {
    period: { start: q.start.slice(0, 10), end: q.end.slice(0, 10) },
    basis: basisMeta('received'),
    pools: mergePools(t.pools, chargedBy, owedBy, order),
    total: t.total,
    charged: round2([...chargedBy.values()].reduce((x, v) => x + v, 0)),
    owed: round2([...owedBy.values()].reduce((x, v) => x + v, 0)),
    depositsHeld: t.depositsHeld,
    besideTotal: t.besideTotal,
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, p]) => ({ month, ...tidy(p) })),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, p]) => ({ day, ...tidy(p) })),
    itemized,
    rentSoldAs: itemized
      ? RENT_SOLD_ORDER
        .map(k => ({
          key: k, label: rentSoldLabel(k),
          amount: round2(all.soldAs.get(k) ?? 0), charged: round2(soldChargedBy.get(k) ?? 0), owed: round2(soldOwedBy.get(k) ?? 0),
        }))
        .filter(r => r.amount !== 0 || r.charged !== 0 || r.owed !== 0)
      : [],
    ...(sold ? { register: sold.sales, otherMoneyIn: sold.otherIncome } : {}),
  }
}

/**
 * 10/12: every type with money in any of the three columns, in display order,
 * labeled — Received (`amount`), Charged and Owed side by side.
 *
 * 10/19: a group that has itemized lines of its own in the list keeps its own
 * row for the part no line itemizes, named as the part it is ("Lot/space rent
 * — not itemized"), so the rows always add up to the column and nobody reads
 * it as the whole of the rent.
 */
function mergePools(
  received: Array<{ key: string; amount: number }>, charged: Map<string, number>, owed: Map<string, number>,
  order: readonly string[] = INCOME_POOL_ORDER,
): PoolRow[] {
  const rec = new Map(received.map(r => [r.key, r.amount]))
  const rows = order
    .map(k => ({
      key: k, label: incomePoolLabel(k),
      amount: round2(rec.get(k) ?? 0), charged: round2(charged.get(k) ?? 0), owed: round2(owed.get(k) ?? 0),
    }))
    .filter(r => r.amount !== 0 || r.charged !== 0 || r.owed !== 0)
  const shown = new Set(rows.map(r => r.key))
  return rows.map(r => {
    const lines = DETAIL_KEYS_OF[r.key as IncomeCategory]
    return lines?.some(k => shown.has(k)) ? { ...r, label: ledgerIncomeNotItemizedLabel(r.label) } : r
  })
}
