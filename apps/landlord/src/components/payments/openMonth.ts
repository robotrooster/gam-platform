// 10/13 (Nic) — THE PAYMENTS PAGE: THE RENT ROLL FOR THE OPEN MONTH.
//
// The small decisions the page makes from the server's rows
// (GET /api/balances/rent-roll/open-month, packages/shared/src/rentRoll.ts),
// kept here so they are tested on their own. The server decides the money, the
// status pill and the order; nothing here re-sorts or re-judges a row.
import {
  isSpaceOnlyRow, isStayRow, type OpenMonthRow, type RentRollProperty, type OpenMonthOtherMoney, type OpenMonthTotals,
  type OpenMonthSalePart,
} from '@gam/shared'
import { money, toCents, toDollars } from '../../lib/creditDesk'

/**
 * Which property the page shows (10/13, Nic: "you select either property and
 * view only those properties"; answered: "Always pick first … EXCEPT a company
 * with only one property opens straight to it"). The one picked, else the only
 * one the viewer may open; null asks which. A property sold out of the account
 * (`owned: false`) has no open month, so it is never offered here.
 */
export function propertyToShow(picked: string | null, properties: readonly RentRollProperty[] | undefined): string | null {
  if (picked) return picked
  const open = (properties ?? []).filter(p => p.owned)
  return open.length === 1 ? open[0].propertyId : null
}

/** The properties the page offers (those with an open month), by name. */
export function openProperties(properties: readonly RentRollProperty[] | undefined): RentRollProperty[] {
  return (properties ?? []).filter(p => p.owned).sort((a, b) => a.name.localeCompare(b.name))
}

/** "Glenda Moss & Russ Fuller" — the lease's residents, primary first (the server's order). */
export function householdName(row: Pick<OpenMonthRow, 'residents'>): string {
  return row.residents.map(r => r.name).filter(Boolean).join(' & ') || 'No tenant on file'
}

/**
 * Who a row is, in words: a household's residents, or — on a stay guest's row
 * (10/13, Nic: "the people that paid short-term stays") or a space in use — the
 * guest named on it. null: nobody to name (an empty space).
 */
export function rowName(row: Pick<OpenMonthRow, 'residents' | 'occupant' | 'status'>): string | null {
  if (isStayRow(row)) return row.occupant || 'Stay guest'
  if (isSpaceOnlyRow(row)) return row.occupant
  return householdName(row)
}

/**
 * A register sale or pay link this month names the row's space (10/13, Nic,
 * round 3: "Pay links / register sales that name a space go ON that space's
 * row") — on a space alone, its Paid and method cells say that money.
 *
 * Every row opens underneath (10/13, Nic: "can we have it where the vacant
 * units are still like the unit number is still directly in line with the
 * ones that are occupied? ... just make them all clickable even if they're
 * vacant and just show you know an expanded box with nothing ... I want the
 * layout to be nice and smooth"): a household its payments and charges, a stay
 * guest the money paid, a space alone that nothing is billed on it
 * (spaceOnlyWords) and any register money naming it.
 */
export function hasRegisterMoney(row: { otherMoney?: readonly unknown[] }): boolean {
  return (row.otherMoney?.length ?? 0) > 0
}

/**
 * A space nobody holds on a lease, opened (10/13, Nic: "an expanded box with
 * nothing"): "Vacant — nothing billed this month."; a space in use says what
 * is there — "Owner Use — no lease here, nothing billed this month."
 */
export function spaceOnlyWords(row: Pick<OpenMonthRow, 'status' | 'statusLabel'>): string {
  return row.status === 'vacant' || !row.statusLabel
    ? 'Vacant — nothing billed this month.'
    : `${row.statusLabel} — no lease here, nothing billed this month.`
}

/**
 * A register sale or pay link opens to its breakdown (10/13, Nic: "When
 * Andres Razo paid by card online for his stay ... it looks like that charge
 * is just for electric ... not clickable to show an expanded breakdown") —
 * each part with its own amount and what it is. A refund has none.
 */
export function saleOpens(line: Pick<OpenMonthOtherMoney, 'kind'> & { parts?: readonly unknown[] }): boolean {
  return line.kind === 'sale' && (line.parts?.length ?? 0) > 0
}

/** A quantity as the register sold it: 390, 6.8, 0.11 (never "390.000"). */
function qtyText(q: number): string {
  return Number(q).toLocaleString('en-US', { maximumFractionDigits: 3 })
}

/**
 * Under a part's name: what it is and how many — "Electric bill-back · 390
 * kWh × $0.21", "Site rent", "6.8 × $3.30". Null when there is nothing to add
 * (a tax, one of a thing with nothing said about it).
 */
export function salePartDetail(p: Pick<OpenMonthSalePart, 'kind' | 'what' | 'qty' | 'unitPrice' | 'unit'>): string | null {
  const many = p.kind === 'item' && p.qty !== null && p.unitPrice !== null && (p.qty !== 1 || !!p.unit)
    ? `${qtyText(p.qty!)}${p.unit ? ` ${p.unit}` : ''} × ${money(p.unitPrice!)}`
    : null
  return [p.what, many].filter(Boolean).join(' · ') || null
}

/**
 * Under the breakdown: the card fee the payer paid on top — never in the
 * money that came in. "Card fee the payer paid on top — not in the $752.17".
 * Null when none.
 */
export function cardFeeWords(line: Pick<OpenMonthOtherMoney, 'amount'> & { cardFee?: number }): string | null {
  return toCents(line.cardFee) > 0 ? `Card fee the payer paid on top — not in the ${money(line.amount)}` : null
}

/**
 * Under the Paid cell (10/13, Nic, round 3): the register's and the pay
 * links' money that names this row's space — "+ $752.17 register & pay links"
 * beside a bill's Paid, or on its own on a row with no bill ("$752.17 register
 * & pay links") — and what went back on it ("$10.00 refunded"). It is never in
 * Paid itself: it is no bill. Null when there is none; `amount` null when only
 * a refund came back this month (its sale was an earlier month's) — never a
 * "$0.00 register & pay links".
 */
export function registerWords(row: Pick<OpenMonthRow, 'paid'> & { otherIn?: number; otherRefunded?: number }):
  { amount: string | null; refunded: string | null } | null {
  const inC = toCents(row.otherIn), backC = toCents(row.otherRefunded)
  if (inC <= 0 && backC <= 0) return null
  return {
    amount: inC > 0 ? `${toCents(row.paid) > 0 ? '+ ' : ''}${money(toDollars(inC))} register & pay links` : null,
    refunded: backC > 0 ? `${money(toDollars(backC))} refunded` : null,
  }
}

/**
 * The Payment method column: how the row's bills (or stay) were paid this
 * month, then how the register sales and pay links on it were — each way once,
 * oldest first (the server's order).
 */
export function rowMethods(row: Pick<OpenMonthRow, 'methods'> & { otherMoney?: readonly Pick<OpenMonthOtherMoney, 'kind' | 'methodLabel'>[] }): string[] {
  const out = [...row.methods]
  for (const x of row.otherMoney ?? []) if (x.kind === 'sale' && !out.includes(x.methodLabel)) out.push(x.methodLabel)
  return out
}

/**
 * Under a stay row's Owed (10/13, Nic, round 3: "Stay rows SHOW what's still
 * owed"): the day its balance went out on its pay link, while unpaid — "pay
 * link sent Oct 12"; or, when nothing is owed on it yet (before arrival, not
 * billed — S649: the rest comes due on arrival day), what is left on the stay
 * and when — "$150.00 due on arrival, Nov 3". Null otherwise.
 */
export function stayOwedWords(row: Pick<OpenMonthRow, 'stay' | 'owed'>, dayWord: (ymd: string) => string): string | null {
  const s = row.stay
  if (!s) return null
  if (toCents(row.owed) > 0) return s.balanceBilledOn ? `pay link sent ${dayWord(s.balanceBilledOn)}` : null
  return toCents(s.owed) > 0 ? `${money(s.owed)} due on arrival, ${dayWord(s.checkIn)}` : null
}

/**
 * Under a stay row's Paid: what went back to the guest this month (an early
 * check-out's refund). Null when nothing did.
 */
export function stayRefundWords(row: Pick<OpenMonthRow, 'stay'>): string | null {
  const back = toCents(row.stay?.refunded)
  return back > 0 ? `${money(toDollars(back))} refunded` : null
}

/**
 * The head of the register-and-pay-links folder (10/13, Nic: "show all money
 * coming in"): how many sales and refunds, and — only when the server sent the
 * sums (decisions #25) — what came in and what went back. "9 sales · $187.85",
 * "2 sales · 1 refund · $45.00 · $5.00 refunded". 10/13 (Nic, round 3): "only
 * money with no space stays in the folder" — its sums are the folder's own
 * (folderIn / folderRefunded), never the money on the spaces' rows.
 */
export function otherMoneyMeta(lines: readonly Pick<OpenMonthOtherMoney, 'kind'>[],
                               totals?: Pick<OpenMonthTotals, 'folderIn' | 'folderRefunded'>): string {
  const sales = lines.filter(l => l.kind === 'sale').length
  const refunds = lines.length - sales
  const parts = [`${sales} sale${sales === 1 ? '' : 's'}`]
  if (refunds > 0) parts.push(`${refunds} refund${refunds === 1 ? '' : 's'}`)
  if (totals) {
    parts.push(money(totals.folderIn))
    if (toCents(totals.folderRefunded) > 0) parts.push(`${money(totals.folderRefunded)} refunded`)
  }
  return parts.join(' · ')
}

/** Who paid, in words: their name, else that nobody was named (a walk-in at the register). */
export function otherMoneyWho(line: Pick<OpenMonthOtherMoney, 'who'>): string {
  return line.who?.trim() || 'No name given'
}

/**
 * The tenant report a name opens (10/12, Nic: "the ability to pull up a report
 * about a specific tenant"), for that household's lease alone (10/13: a lease is
 * a household). Null when the row has nobody to report on (an empty space).
 */
export function reportPath(row: Pick<OpenMonthRow, 'householdId' | 'leaseId'>): string | null {
  if (!row.householdId) return null
  return `/tenants/${row.householdId}/report${row.leaseId ? `?leaseId=${encodeURIComponent(row.leaseId)}` : ''}`
}

/**
 * Owes anything here — this month's bills or an earlier month's (10/13, Nic:
 * "outstanding balances are always at the top of this list"; the server puts
 * these rows first).
 */
export function owesHere(row: Pick<OpenMonthRow, 'owed' | 'owedEarlier'>): boolean {
  return toCents(row.owed) + toCents(row.owedEarlier) > 0
}

/**
 * The row's own Record payment (10/13, Nic: "payments first. with a way to log
 * the payments"): on a row that still owes here, this month or earlier, for
 * someone who takes payments, when the desk window has a charge to open on
 * (it settles the household's whole balance from it). Never in eviction mode
 * ("we have eviction mode that blocks payments") — the server sends no charge
 * for it then either — and never on a space nobody holds on a lease.
 */
export function rowTakesPayment(row: OpenMonthRow, canTake: boolean): boolean {
  return canTake && !row.evictionMode && !isSpaceOnlyRow(row) && !!row.recordWith && owesHere(row)
}

/**
 * What the Paid cell says. Work trade reads the way the Rent Roll reads it —
 * "+ $X work trade" beside Paid — so Invoiced = Paid + work trade + Owed adds
 * up on the row (10/13: "the payments page is the rent roll for the open
 * month"). Both pages open only for viewers allowed to see work trade
 * ("View all payments" — S641, routes/balances seesWorkTrade).
 */
export function paidWords(v: { paid: number; workTrade: number }): { amount: string | null; workTrade: string | null } {
  const amount = toCents(v.paid) > 0 ? money(v.paid) : null
  return { amount, workTrade: toCents(v.workTrade) > 0 ? `${amount ? '+ ' : ''}${money(v.workTrade)} work trade` : null }
}

/**
 * Under the Owed cell: what is still owed here on EARLIER months (10/13, Nic:
 * "amount still owed if any"). Owed itself is this month's, so the row's
 * Invoiced, Paid and Owed still add up. Null when nothing is.
 */
export function earlierWords(v: Pick<OpenMonthRow, 'owed' | 'owedEarlier'>): string | null {
  if (toCents(v.owedEarlier) <= 0) return null
  return `${toCents(v.owed) > 0 ? '+ ' : ''}${money(v.owedEarlier)} from earlier months`
}

/**
 * One household the header's Record payment can offer. Exactly one of:
 *   record — something the desk takes is open: the desk window opens on it;
 *   ahead  — nothing the desk takes is open: a payment is posted ahead;
 *   blocked — eviction mode: nothing can be taken (said, nothing to press).
 */
export interface PayerChoice {
  key: string
  name: string
  space: string | null
  kind: 'record' | 'ahead' | 'blocked'
  /** Beside the name: "owes $X", "nothing owed — paying ahead", "Post a payment ahead". */
  side: string
  /** What stands in the way, in words (eviction mode; owed money the desk does not take). */
  note?: string
  row: OpenMonthRow
}

/**
 * The header's Record payment list for this property (decisions #29's picker,
 * read from this page's own rows): every household, in the page's order,
 * narrowed by a name or space typed. "owes $X" is the household's whole
 * balance here — this month and earlier — as the desk window shows it.
 */
export function payerChoices(rows: readonly OpenMonthRow[], typed: string): PayerChoice[] {
  const term = typed.trim().toLowerCase()
  const out: PayerChoice[] = []
  for (const row of rows) {
    if (isSpaceOnlyRow(row) || !row.householdId) continue
    const name = householdName(row)
    if (term && !`${name} ${row.space ?? ''}`.toLowerCase().includes(term)) continue
    const owedCents = toCents(row.owed) + toCents(row.owedEarlier)
    const base = { key: row.key, name, space: row.space, row }
    if (row.evictionMode) {
      out.push({ ...base, kind: 'blocked', side: '', note: 'Eviction mode — payments blocked' })
    } else if (row.recordWith) {
      out.push({ ...base, kind: 'record', side: `owes ${money(toDollars(owedCents))}` })
    } else if (owedCents > 0) {
      out.push({ ...base, kind: 'ahead', side: 'Post a payment ahead',
        note: `owes ${money(toDollars(owedCents))} that is not taken at the desk — it is paid online` })
    } else {
      out.push({ ...base, kind: 'ahead', side: 'nothing owed — paying ahead' })
    }
  }
  return out
}
