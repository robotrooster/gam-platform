// 10/13 (Nic) — THE PAYMENTS PAGE: THE RENT ROLL FOR THE OPEN MONTH.
//
// The small decisions the page makes from the server's rows
// (GET /api/balances/rent-roll/open-month, packages/shared/src/rentRoll.ts),
// kept here so they are tested on their own. The server decides the money, the
// status pill and the order; nothing here re-sorts or re-judges a row.
import {
  isSpaceOnlyRow, isStayRow, type OpenMonthRow, type RentRollProperty, type OpenMonthOtherMoney, type OpenMonthTotals,
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
 * A row that opens underneath: a household (its payments and charges) or a
 * stay guest (10/13: "details of the money that was paid"). A space alone has
 * nothing to open.
 */
export function rowOpens(row: Pick<OpenMonthRow, 'status'>): boolean {
  return !isSpaceOnlyRow(row)
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
 * "2 sales · 1 refund · $45.00 · $5.00 refunded".
 */
export function otherMoneyMeta(lines: readonly Pick<OpenMonthOtherMoney, 'kind'>[],
                               totals?: Pick<OpenMonthTotals, 'otherIn' | 'otherRefunded'>): string {
  const sales = lines.filter(l => l.kind === 'sale').length
  const refunds = lines.length - sales
  const parts = [`${sales} sale${sales === 1 ? '' : 's'}`]
  if (refunds > 0) parts.push(`${refunds} refund${refunds === 1 ? '' : 's'}`)
  if (totals) {
    parts.push(money(totals.otherIn))
    if (toCents(totals.otherRefunded) > 0) parts.push(`${money(totals.otherRefunded)} refunded`)
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
