/**
 * 10/20 (Nic) — A PAY LINK IS AN INVOICE. ITS UTILITY LINE CLOSES OUT THE BILL,
 * AND THE MONEY COUNTS AS UTILITY RECOVERY.
 *
 *   "Pay links should be kind of almost treated as if they were regular invoices
 *    because it has the utilities and the rent on there. And a lot of people
 *    that move out are going to get their final electric bill as a pay link
 *    anyway. So the system needs to distinguish when a pay link is sent to a
 *    person that it closes out that electric."
 *
 *   "There's no way to just charge somebody for electric when on move out...
 *    So it has to come from, or should be able to come from, the point of sale
 *    as well. The point of sale is just an extension of things."
 *
 *   Approved: "Paylink closes out electric. Yeah, do that. A utility bill can be
 *   sent as a paylink, and a paylink's utility line settles the bill and counts
 *   as recovery. Let's do that."
 *
 * ── THE TWO SHAPES, AND WHY THEY ARE TOLD APART STRUCTURALLY ─────────────────
 *
 * A link carries utility money in exactly two ways, and they never overlap:
 *
 *   RAISED FROM A BILL. The line is written by the server (raiseable bills →
 *     payLinkLineForBill), has NO catalog item, and names its bill:
 *     { id: null, name: 'Electric — September 2026 (RV 27)', utilityBillId: '…' }.
 *     The match is CARRIED. Nothing downstream ever pairs a dollar figure with
 *     the words "Electric (per kWh)" and hopes — a fuzzy match on an amount and
 *     an item name is not good enough for money, which is the whole lesson of
 *     the 10/20 propane work (pos_items.recovers_utility replaced exactly that).
 *
 *   RUNG UP BY HAND. The clerk taps a catalog button whose own row says what it
 *     is (pos_items.recovers_utility), with no bill behind it. This is what
 *     really happened: Andres Razo's August and September power at Mountain
 *     View, 387 and 390 kWh at $0.21, $163.17, paid in full on a link on
 *     10/06 — and RV 27's submeter has never had a utility_bills row for those
 *     cycles. The money came in; no bill was ever closed by it. It still has to
 *     count as recovery, so it is recorded here with utility_bill_id NULL rather
 *     than by writing a bill that never existed.
 *
 * A bill-raised line has no item_id, so pos_transaction_items.recovers_utility
 * is NULL on it by the propane lane's rule (a typed line invents no recovery). A
 * hand-rung line HAS an item_id and so cannot carry a utilityBillId. The two
 * populations are disjoint by construction, not by a flag somebody maintains,
 * which is why recordUtilityPayLinkSettlement can read both and never count one
 * line twice.
 *
 * ── NEVER COUNTED TWICE ──────────────────────────────────────────────────────
 *
 * Where a bill exists, the BILL is the single record of money billed back and
 * of money collected: it reads 'billed' while it is owed and 'paid' once the
 * link is paid, exactly as it would have if the resident had paid it in the
 * portal. A settlement row with a utility_bill_id therefore adds no second
 * figure — it only says HOW it was collected. A row with no bill is the only
 * kind that is itself a figure.
 *
 * Two partial unique indexes make the double impossible rather than unlikely:
 * one OPEN link per bill (two links out is two people asked for the same money)
 * and one SETTLED row per bill ever (a bill cannot be recorded as collected by
 * two payments).
 *
 * And the line a bill-raised link carries is deliberately invisible to the
 * recovery report's register sweep: it has no `cat`, so the sweep's
 * "category starts with utilit" test fails and routes/utility.ts counts the bill
 * alone. That is not a trick to dodge a string — a bill being collected is not
 * a catalog sale, so it has no merchandising category to give. The hand-rung
 * line keeps its real category, and its bill-less settlement row is the record
 * the report should read once lane 3 switches off the strings.
 *
 * ── THE PAYER'S INVOICE ──────────────────────────────────────────────────────
 *
 * Most final bills are already a charge row on an invoice (jobs/invoiceGeneration
 * generateFinalUtilityInvoice; jobs/serviceAgreementInvoices for a serviced
 * space). Leaving that charge owed while the link is paid would ask the same
 * person for the same money twice — exactly what "a bill settled by a pay link
 * must not also read as outstanding" forbids.
 *
 * So the charge is VOIDED when the link is paid (services/chargeVoids: "a charge
 * nobody owes is VOIDED, never deleted" — status 'voided', voided_at, a plain
 * reason, kept forever and in no balance or total). Voided and not settled, for
 * one reason that matters: GAM Books records income when a charge is BILLED, so
 * a settled charge would accrue the utility income a second time on top of the
 * register sale that actually took the money. A voided charge's income reverses
 * as a correction (ledgerProjectors/tenantCharges chargeSkipReason) and the sale
 * carries it. One income, one cash.
 *
 * ── WHAT A PART PAYMENT, AN OVERPAYMENT AND A REFUND DO ──────────────────────
 *
 *   PART PAYMENT cannot happen and must not be invented. A pay link is paid at
 *     its own figure on Stripe's page or not at all, and finalizePayLink already
 *     holds anything that arrives at another amount ('wrong_amount') WITHOUT
 *     recording a sale. So this file is never reached, the bill stays owed, and
 *     the landlord is told with a Refund button. Nothing here weakens that.
 *   OVERPAYMENT is the same mismatch and the same hold. A link raised from bills
 *     asks for the bills' own total; there is no "pay what you like" box to
 *     overpay into.
 *   A BILL ALREADY PAID some other way while the payer had the card page open is
 *     the money twice. Held under 'paid_twice' (utilityBillsNotPayable, read
 *     under the bills' locks before anything is recorded) and never recorded as
 *     a sale — the same answer the background-check line already gives.
 *   A REFUND OF THE WHOLE SALE UNDOES THE RECOVERY. Every dollar went back, so
 *     the settlement goes to 'refunded', the bill is owed again ('billed',
 *     paid_at and payment_id cleared so the straggler sweep can re-bill it) and
 *     the landlord is told. The voided charge row STAYS voided: it is a true
 *     record that the charge was voided the day the link was paid, and GAM
 *     writes a new ask rather than rewriting an old one (the same choice
 *     paymentReversal makes when it reopens a row).
 *   A PART REFUND PUTS NOTHING BACK ON THE BOOKS, AND THAT IS THE WHOLE POINT.
 *     Nic's wash rule — "Any refund, even partial, means no wash" — answers
 *     WHETHER A WASH HAPPENED. A wash is GAM's own decision not to bill, so any
 *     refund can call it off at no cost to anybody. A BILL is a real person's
 *     debt, and reopening it asks that person for money again. Those are not
 *     the same act and they cannot share a rule.
 *
 *     Reopening a bill on a part refund re-bills the full amount while the
 *     landlord is still holding most of the money. $44.94 of September electric
 *     is sent as a link, paid, the desk hands $5 back by mistake — and the
 *     resident is asked for $44.94 again, $39.94 of which is in the bank. On a
 *     link carrying two bills it is worse: refunding August's $81.27 also
 *     reopens September's $81.90, which nobody refunded a cent of.
 *
 *     And a part refund cannot be ATTRIBUTED, which is not a shortcoming to be
 *     worked around but the actual arithmetic. A sale carries utility U out of a
 *     total S; a refund R can only be proved to have reached the utility once it
 *     exceeds everything that is not utility, so what is certainly utility money
 *     back is max(0, R − (S − U)) — and that reaches U only when R reaches S.
 *     Short of the whole sale going back, no amount of cleverness says WHICH
 *     bill's money left, and guessing is exactly what this file refuses to do
 *     with the register's names and categories.
 *
 *     So: the settlements stay settled, the bills stay closed out, each row is
 *     noted with the refund that was taken, and the account holder is TOLD with
 *     the real figures so a person decides. If the utility really was the money
 *     handed back, it is asked for again at the counter or on a new link — the
 *     ordinary door. If the rest of the sale goes back later, that refund is the
 *     full one and the bills reopen on their own.
 */

import type { PoolClient } from 'pg'
import { UTILITY_TYPE_LABEL, UTILITY_TYPES, type UtilityType } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { voidUnowedCharges } from './chargeVoids'
import { isMoneyTakenOrMovingRow, lockHousehold, moneyTakenOrMovingRowSql } from './moneyPredicates'

type Q = Pick<PoolClient, 'query'>

/** Where a settlement row stands. Never rendered raw. */
export const UTILITY_PAY_LINK_STATUSES = ['open', 'settled', 'refunded', 'cancelled'] as const
export type UtilityPayLinkStatus = typeof UTILITY_PAY_LINK_STATUSES[number]

export const UTILITY_PAY_LINK_STATUS_LABEL: Record<UtilityPayLinkStatus, string> = {
  open:      'Sent, not paid yet',
  settled:   'Paid on the link',
  refunded:  'Refunded — owed again',
  cancelled: 'The link was closed',
}

/** Why the charge on the payer's invoice was voided. Stored on the row forever. */
export const COLLECTED_ON_A_PAY_LINK = 'Collected on a pay link — the payer paid it by card instead of on their bill'

/** The note left on a bill that is owed again because the link that paid it was refunded. */
export const PAY_LINK_REFUNDED_NOTE = 'The pay link that paid this was refunded, so it is owed again'

const round2 = (n: number) => Math.round(n * 100) / 100
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)

/** 'September 2026' for a cycle, however it arrives from the driver. */
function cycleWords(cycle: unknown): string {
  const d = cycle instanceof Date ? cycle : new Date(`${String(cycle).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(cycle ?? '')
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const isoDay = (d: unknown): string | null => {
  if (!d) return null
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** A utility bill as the register needs it to put it on a link. */
export interface UtilityBillForLink {
  billId: string
  landlordId: string
  propertyId: string
  unitId: string
  meterId: string
  /** What the park calls the space — display_label prints, unit_number is the back-end name (S652). */
  spaceLabel: string
  tenantId: string | null
  utilityType: UtilityType
  billingCycleMonth: string
  charge: number
  tax: number
  /** The bill's own tax rate as a FRACTION (utility_bills.tax_rate_pct / 100), for the line. */
  taxRate: number
  /** What the payer is asked for: the charge and its tax. */
  amount: number
  /** The charge row on their invoice, when it is already on one. */
  paymentId: string | null
  invoiceId: string | null
  /** Who GAM would email it to, from the bill's own payer. */
  payerName: string | null
  payerEmail: string | null
  /** The line as it goes on the link. */
  lineName: string
}

/**
 * What one bill reads as on the link, the email and the card page. Plain words,
 * never a raw enum: "Electric — September 2026 (RV 27)".
 */
export function payLinkLineNameForBill(b: { utilityType: UtilityType; billingCycleMonth: unknown; spaceLabel: string }): string {
  const space = b.spaceLabel?.trim()
  return `${UTILITY_TYPE_LABEL[b.utilityType]} — ${cycleWords(b.billingCycleMonth)}${space ? ` (${space})` : ''}`.slice(0, 120)
}

/**
 * The line a bill goes on the link as. No catalog item (it is a bill being
 * collected, not something off a shelf) and so NO `cat` either — the register's
 * category is a merchandising grouping and a bill has none to give. It names
 * its bill, which is the whole point: the match is carried, never guessed.
 *
 * Priced like any other taxed register line: the charge before tax, with the
 * bill's own rate on the line, so the sale records the utility tax AS TAX
 * instead of folding it into revenue the landlord does not get to keep. The
 * authoritative figures stay the bill's (and this settlement row's) — a rate
 * stored at four decimals is for the line, never for the money.
 */
export function payLinkLineForBill(b: UtilityBillForLink): Record<string, unknown> {
  return { id: null, name: b.lineName, qty: 1, price: round2(b.charge), tax: b.taxRate, utilityBillId: b.billId }
}

/** TRUE for a line the server wrote for a utility bill (keepLinkServerLines keeps these as they are). */
export const isUtilityBillLine = (l: any): boolean => !l?.id && isUuid(l?.utilityBillId)

/** The bill ids a link's lines name, in the order they sit on the link. */
export function utilityBillIdsOnLink(link: { items?: unknown }): string[] {
  const items = Array.isArray(link?.items) ? link.items : []
  return [...new Set(items.filter(isUtilityBillLine).map((l: any) => String(l.utilityBillId).toLowerCase()))]
}

/** A typed line by what it actually charges: its name, its price and its tax rate. */
const billLineKey = (l: any) =>
  `${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}|${(Number(l?.tax) || 0).toFixed(4)}`

/** What anybody is told who retyped a bill's line or lifted it out of the cart. */
export const utilityBillLineIsTheBillWords = (l: any, press: string): string =>
  `This link is their ${String(l?.name ?? 'utility')} bill ($${(Number(l?.price) || 0).toFixed(2)}) — that line is the bill itself `
  + `and stays as it is. Put it back the way it was, then press ${press} again; to stop asking for it, close the link.`

/**
 * 10/20 (Nic) — AND AT THE TILL, A BILL'S LINE IS STILL THE BILL.
 *
 * The counter may change the cart it settles a link with: "if we need to do
 * last minute prorations or adjustments, the functionality of the front counter
 * person needs to be there." A bill-raised line is the one line that cannot
 * bend, because settling the link closes the bill out AT THE BILL'S OWN FIGURE.
 * Retyped at $10, rung at half the quantity, or stripped of its tax, the sale
 * would take one amount and mark another collected; lifted out of the cart
 * altogether, the bill would read paid with nothing taken for it at all.
 *
 * So the line stays exactly as the server wrote it — same name, same price,
 * same quantity, same tax — and Adjust's answer is the till's answer too: to
 * stop asking for it, close the link.
 *
 * Nearly every link carries no bill, and those are left alone. The cart's lines
 * come back from the register without the server's marks (the bill id among
 * them), so they are matched on what they charge, exactly as Adjust matches
 * them (routes/posPayLinks keepLinkServerLines).
 */
export function assertUtilityBillLinesKept(link: any, items: unknown, press: string): void {
  const own = (Array.isArray(link?.items) ? link.items : []).filter(isUtilityBillLine)
  if (!own.length) return
  const cart = new Map<string, number>()
  for (const it of (Array.isArray(items) ? items : [])) {
    if ((it as any)?.id) continue   // a catalog line is never a bill
    const k = billLineKey(it)
    cart.set(k, (cart.get(k) ?? 0) + (Number((it as any)?.qty) || 0))
  }
  const want = new Map<string, { qty: number; line: any }>()
  for (const l of own) {
    const e = want.get(billLineKey(l)) ?? { qty: 0, line: l }
    e.qty += Number(l.qty) || 0
    want.set(billLineKey(l), e)
  }
  for (const [k, e] of want) {
    if (Math.abs((cart.get(k) ?? 0) - e.qty) > 1e-9) {
      throw new AppError(400, utilityBillLineIsTheBillWords(e.line, press))
    }
  }
}

const BILL_SELECT = `
  SELECT ub.id AS bill_id, ub.landlord_id, ub.meter_id, ub.unit_id, ub.tenant_id,
         ub.utility_type, to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
         ub.charge_amount::text AS charge, ub.tax_amount::text AS tax,
         ub.tax_rate_pct::text AS tax_rate_pct, ub.status,
         ub.payment_id, p.invoice_id, p.status AS charge_status,
         -- The charge's OWN answer about its money (chargeAlreadyAnswered).
         -- Read into every one of these three queries deliberately: a check
         -- reading a column one caller's SELECT left out is a check that
         -- quietly says "no".
         p.stripe_payment_intent_id AS charge_intent,
         p.work_trade_suspended_at AS charge_work_trade,
         un.property_id,
         COALESCE(NULLIF(un.display_label, ''), un.unit_number, '') AS space_label,
         TRIM(COALESCE(usr.first_name, '') || ' ' || COALESCE(usr.last_name, '')) AS payer_name,
         LOWER(usr.email) AS payer_email,
         -- Who the payer IS, for the one-payer-per-link refusal below. The
         -- person, not the tenancy row: one household is one balance (S652), so
         -- somebody's bills on two spaces in the same park are still one
         -- person's. Selected, never handed out — billFromRow drops it.
         usr.id AS payer_user_id
    FROM utility_bills ub
    JOIN units un ON un.id = ub.unit_id
    LEFT JOIN payments p ON p.id = ub.payment_id
    LEFT JOIN tenants tn ON tn.id = ub.tenant_id
    LEFT JOIN users usr ON usr.id = tn.user_id`

function billFromRow(r: any): UtilityBillForLink {
  const charge = round2(Number(r.charge) || 0)
  const tax = round2(Number(r.tax) || 0)
  const b: UtilityBillForLink = {
    billId: r.bill_id, landlordId: r.landlord_id, propertyId: r.property_id,
    unitId: r.unit_id, meterId: r.meter_id, spaceLabel: String(r.space_label ?? ''),
    tenantId: r.tenant_id ?? null,
    utilityType: r.utility_type as UtilityType,
    billingCycleMonth: isoDay(r.cycle) ?? String(r.cycle),
    charge, tax, amount: round2(charge + tax),
    taxRate: Math.round(((Number(r.tax_rate_pct) || 0) / 100) * 10000) / 10000,
    paymentId: r.payment_id ?? null, invoiceId: r.invoice_id ?? null,
    payerName: (r.payer_name || '').trim() || null,
    payerEmail: r.payer_email || null,
    lineName: '',
  }
  b.lineName = payLinkLineNameForBill(b)
  return b
}

/**
 * 10/20 (review) — WHETHER A BILL IS STILL OWED IS THE CHARGE'S ANSWER, NEVER
 * THE BILL'S STATUS ON ITS OWN.
 *
 * utility_bills.status is moved by one trigger (utility_bills_follow_payment)
 * and only when a charge reaches 'settled'. Three reachable states never get
 * there, and a bill in any of them reads 'billed' while its money is already
 * answered for:
 *
 *   IN FLIGHT. The resident paid their invoice by ACH, so the utility charge
 *     carries an intent and clears in three to five business days. Nothing has
 *     settled, so the bill still read 'billed' — the list offered it, the desk
 *     sent it, the payer paid $81.90 by card, and when the ACH landed the
 *     trigger's UPDATE found a bill already marked paid and did nothing. Two
 *     payments, one bill, and no trace of it but a second register sale.
 *   TAKEN FROM THE DEPOSIT. At move-out the sweep marks the unpaid utility
 *     charge 'paid_via_deposit' (services/depositReturn). No trigger fires on
 *     that status, and the final-bill loop beside it only touches bills with no
 *     charge at all, so the bill stays 'billed' for good — and the door offered
 *     a departed resident their electric again, on top of the deposit that had
 *     already paid it.
 *   PAID WITH HOURS. The charge is suspended under work trade. "Work trade is
 *     hours, not wages" — there is no cash owed to ask for. The production read
 *     on 10/20 found SIX live bills in exactly this state, $368.62 across
 *     Country Acres, Mountain View and Oak Park, which is what this door would
 *     have been pointed at first.
 *
 * In every case nothing is voided, nothing is held and nothing is logged: the
 * only record of the second collection is one more sale. So the question is put
 * to the CHARGE with the platform's one rule (moneyPredicates
 * isMoneyTakenOrMovingRow / moneyTakenOrMovingRowSql), at all three places this
 * door asks it — the list, the Send refusal, and the gate the payment goes
 * through as it lands.
 *
 * A bill with NO charge is untouched by this: nobody has been asked for it any
 * other way, so it is owed, which is the ordinary case and the Andres shape.
 */
type ChargeAnswered = 'in_flight' | 'paid' | 'from_deposit' | 'work_trade'

/** What the charge behind a bill row says about its money, or null for "still owed". */
function chargeAlreadyAnswered(r: any): ChargeAnswered | null {
  if (!r?.payment_id) return null
  if (!isMoneyTakenOrMovingRow({
    status: String(r.charge_status ?? ''),
    stripe_payment_intent_id: r.charge_intent ?? null,
    work_trade_suspended_at: r.charge_work_trade ?? null,
  } as any)) return null
  if (r.charge_status === 'paid_via_deposit') return 'from_deposit'
  if (r.charge_status === 'settled') return 'paid'
  if (r.charge_work_trade) return 'work_trade'
  return 'in_flight'
}

/** Why Send did nothing, and the step the person actually has. */
function chargeAnsweredSendWords(why: ChargeAnswered, lineName: string, press: string): string {
  switch (why) {
    case 'in_flight':
      return `The ${lineName} bill is already being paid — that payment has not cleared yet, so nothing was sent. `
        + 'Give it a few business days; if it comes back unpaid, send it then.'
    case 'from_deposit':
      return `The ${lineName} bill was already paid out of their security deposit, so nothing was sent. `
        + 'Open the list again to see what is still owed.'
    case 'work_trade':
      return `The ${lineName} bill is being paid with work-trade hours, so there is nothing to ask for. `
        + `Take it out of the list, then press ${press} again.`
    default:
      return `The ${lineName} bill is already paid, so nothing was sent. `
        + 'Open the list again to see what is still owed.'
  }
}

/** Why a payment that landed on the link was held instead of taken. */
function chargeAnsweredHoldWords(why: ChargeAnswered, what: string): string {
  switch (why) {
    case 'in_flight':
      return `The ${what} bill on this link is already being paid — that payment has not cleared yet, `
        + 'so this one was not taken as well.'
    case 'from_deposit':
      return `The ${what} bill on this link was already paid out of their security deposit.`
    case 'work_trade':
      return `The ${what} bill on this link is being paid with work-trade hours, so no money is owed on it.`
    default:
      return `The ${what} bill on this link was already paid.`
  }
}

/**
 * Every utility bill at this property that a link could be raised for: owed,
 * worth something, and not already out on one. What the register lists when
 * somebody asks to send a final bill.
 *
 * Deliberately NOT filtered to people who have left. A landlord may send a
 * current resident their electric by link too ("a lot of people that move out"
 * is the common case, not the only one), and GAM accommodates rather than
 * blocks.
 */
export async function utilityBillsSendable(
  q: Q, args: { landlordId: string; propertyId: string },
): Promise<UtilityBillForLink[]> {
  const rows = (await q.query(`${BILL_SELECT}
    WHERE ub.landlord_id = $1 AND un.property_id = $2
      AND ub.status IN ('unbilled', 'billed')
      AND ub.charge_amount + COALESCE(ub.tax_amount, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM utility_pay_link_settlements s
                       WHERE s.utility_bill_id = ub.id AND s.status IN ('open', 'settled'))
      -- Its charge has not already answered for the money (see above). Written
      -- as "no charge, OR the charge is not taken or moving" and never as a
      -- bare NOT: p is LEFT JOINed, so on a bill with no charge the NOT would
      -- be NULL and the ordinary owed bill would vanish off the list.
      AND (ub.payment_id IS NULL OR NOT ${moneyTakenOrMovingRowSql('p')})
    ORDER BY ub.billing_cycle_month DESC, space_label, ub.utility_type`,
    [args.landlordId, args.propertyId])).rows
  return rows.map(billFromRow)
}

/**
 * Read the named bills for sending, under their locks, and refuse in plain
 * words anything that cannot go out. Runs inside the caller's transaction so
 * the refusal and the link are decided on the same picture.
 *
 * `press` is the button the person pressed, so every refusal ends with a step
 * they actually have.
 */
export async function utilityBillsForSending(
  q: Q, args: { landlordId: string; propertyId: string; billIds: readonly string[]; press: string },
): Promise<UtilityBillForLink[]> {
  const ids = [...new Set(args.billIds.map(s => String(s).toLowerCase()).filter(isUuid))]
  if (!ids.length) {
    throw new AppError(400, `Pick at least one utility bill to send, then press ${args.press} again.`)
  }
  const rows = (await q.query(`${BILL_SELECT}
    WHERE ub.id = ANY($1::uuid[])
    ORDER BY ub.billing_cycle_month, ub.utility_type, ub.id
    FOR UPDATE OF ub`, [ids])).rows
  if (rows.length !== ids.length) {
    throw new AppError(404, `One of those utility bills is not there any more — open the list again, then press ${args.press}.`)
  }
  const bills = rows.map(billFromRow)
  for (const b of bills) {
    const r = rows.find((x: any) => x.bill_id === b.billId)!
    if (b.landlordId !== args.landlordId || b.propertyId !== args.propertyId) {
      throw new AppError(404, `One of those utility bills is not at this property — open the list again, then press ${args.press}.`)
    }
    if (r.status === 'paid') {
      throw new AppError(409, `The ${b.lineName} bill is already paid, so nothing was sent. Open the list again to see what is still owed.`)
    }
    if (r.status === 'void' || r.status === 'disputed') {
      throw new AppError(409, r.status === 'void'
        ? `The ${b.lineName} bill was voided — nobody owes it, so nothing was sent.`
        : `The ${b.lineName} bill is under dispute — settle the dispute first, then send it. Nothing was sent.`)
    }
    const answered = chargeAlreadyAnswered(r)
    if (answered) {
      throw new AppError(409, chargeAnsweredSendWords(answered, b.lineName, args.press))
    }
    if (!(b.amount > 0)) {
      throw new AppError(400, `The ${b.lineName} bill comes to $0.00, so there is nothing to ask for. Take it out of the list, then press ${args.press} again.`)
    }
    if (!(UTILITY_TYPES as readonly string[]).includes(b.utilityType)) {
      throw new AppError(409, `GAM does not know what kind of utility the ${b.billingCycleMonth} bill on ${b.spaceLabel || 'that space'} is, so it cannot be sent. Tell GAM support.`)
    }
  }
  // ── ONE LINK IS ONE PERSON'S BILL ───────────────────────────────────────────
  //
  // Nic's own words for what this door is: "the system needs to distinguish when
  // a pay link is sent to A PERSON that it closes out that electric." A link is
  // that person's invoice, and paying it closes out EVERY bill on it — each
  // bill's charge is voided off whatever invoice it sits on, with the words
  // "collected on a pay link", and each is written down as utility recovered.
  //
  // So two households' bills on one link is one household paying off the other's
  // debt without knowing it: the other resident's utility charge is voided off
  // their bill as though they had paid it, their invoice is retotaled down,
  // their bill reads paid, and the money shows as recovered. GAM would have lost
  // both the right to ask for it and any sign that it was ever owed. Nothing
  // downstream can tell that apart afterwards — the void is the same void — so
  // it is refused HERE, at the only door that can put a bill on a link.
  //
  // The payer is the PERSON. One person's bills on two spaces in the same park
  // are one balance (S652) and go out together; two people never do.
  const payerKeys = bills.map((_b, i) => String(rows[i].payer_user_id ?? bills[i].tenantId ?? ''))
  const firstFor = new Map<string, number>()
  payerKeys.forEach((k, i) => { if (!firstFor.has(k)) firstFor.set(k, i) })
  if (firstFor.size > 1) {
    const [i, j] = [...firstFor.values()]
    // A resident with no name on their account is named by their space, so the
    // clerk still knows which bill to take out.
    const who = (n: number) => (rows[n].payer_name || '').trim()
      || `the resident on ${bills[n].spaceLabel || 'that space'}`
    throw new AppError(400,
      `Those bills are not all one person's — the ${bills[i].lineName} bill is ${who(i)}'s and the `
      + `${bills[j].lineName} bill is ${who(j)}'s. One link is one person's bill, and whoever paid it would `
      + `settle the other's as well, so nothing was sent. Send each person their own bills: take one of them `
      + `out of the list, then press ${args.press} again.`)
  }
  // One link at a time per bill, and never a second collection of one.
  const taken = (await q.query(
    `SELECT s.utility_bill_id, s.status, s.pay_link_id
       FROM utility_pay_link_settlements s
      WHERE s.utility_bill_id = ANY($1::uuid[]) AND s.status IN ('open', 'settled')
      ORDER BY s.utility_bill_id`, [ids])).rows
  if (taken.length) {
    const b = bills.find((x: UtilityBillForLink) => x.billId === taken[0].utility_bill_id)!
    throw new AppError(409, taken[0].status === 'open'
      ? `A pay link for the ${b.lineName} bill is already out — nothing was sent. Close that link under Pay Links first, or press Send again on it.`
      : `The ${b.lineName} bill was already paid on a pay link, so nothing was sent. Open the list again to see what is still owed.`)
  }
  return bills
}

/**
 * Record that a link is out for these bills. Written in the same transaction as
 * the link itself: a link with no settlement rows would collect money nothing
 * could close out, and rows with no link would hold bills hostage.
 */
export async function openUtilityPayLinkSettlements(
  q: Q, args: { payLinkId: string; bills: readonly UtilityBillForLink[]; createdBy: string | null },
): Promise<string[]> {
  const out: string[] = []
  for (const b of args.bills) {
    const r = (await q.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, landlord_id, property_id, utility_bill_id, unit_id, meter_id,
          billing_cycle_month, utility_type, charge_amount, tax_amount, status, payment_id, created_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,'open',$11,$12,$13)
       RETURNING id`,
      [args.payLinkId, b.landlordId, b.propertyId, b.billId, b.unitId, b.meterId,
       b.billingCycleMonth, b.utilityType, b.charge.toFixed(2), b.tax.toFixed(2),
       b.paymentId, args.createdBy, b.lineName])).rows[0]
    out.push(r.id)
  }
  return out
}

/**
 * Why a link carrying utility bills cannot be paid now, or null. Read under the
 * bills' locks BEFORE anything is recorded, so the payment can be held instead
 * of recorded as a sale that settles a bill somebody else already paid.
 */
export async function utilityBillsNotPayable(q: Q, link: any): Promise<{ note: string } | null> {
  const ids = utilityBillIdsOnLink(link)
  if (!ids.length) return null
  const rows = (await q.query(
    `SELECT ub.id, ub.status, ub.utility_type, to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
            ub.payment_id, p.status AS charge_status,
            p.stripe_payment_intent_id AS charge_intent,
            p.work_trade_suspended_at AS charge_work_trade
       FROM utility_bills ub
       LEFT JOIN payments p ON p.id = ub.payment_id
      WHERE ub.id = ANY($1::uuid[]) ORDER BY ub.id FOR UPDATE OF ub`, [ids])).rows
  const words = (r: any) => `${UTILITY_TYPE_LABEL[r.utility_type as UtilityType] ?? 'Utility'} for ${cycleWords(r.cycle)}`
  const gone = rows.find((r: any) => r.status === 'void')
  if (gone) return { note: `The ${words(gone)} bill on this link was voided — nobody owes it.` }
  const paid = rows.find((r: any) => r.status === 'paid')
  if (paid) return { note: `The ${words(paid)} bill on this link was already paid.` }
  // The charge's own answer, for the states the bill's status never reaches
  // (see the header above utilityBillsSendable). Only ub is locked: the charge
  // is read, not written, and locking a payments row here — ahead of the
  // household lock recordUtilityPayLinkSettlement takes next — would put a row
  // lock in front of the advisory one and invert the order every other money
  // path keeps. The three states this catches last days or for good, so an
  // unlocked read sees them.
  const answered = rows.map((r: any) => ({ r, why: chargeAlreadyAnswered(r) })).find(x => x.why)
  if (answered) return { note: chargeAnsweredHoldWords(answered.why!, words(answered.r)) }
  if (rows.length !== ids.length) return { note: 'A utility bill on this link is no longer there.' }
  // Another payment settled it between the link going out and this one landing.
  const settled = (await q.query(
    `SELECT s.utility_bill_id FROM utility_pay_link_settlements s
      WHERE s.utility_bill_id = ANY($1::uuid[]) AND s.status = 'settled' LIMIT 1`, [ids])).rows[0]
  if (settled) {
    const r = rows.find((x: any) => x.id === settled.utility_bill_id)
    return { note: `The ${r ? words(r) : 'utility'} bill on this link was already paid on another pay link.` }
  }
  return null
}

export interface UtilitySettlementRecorded {
  /** Bills closed out by this sale. */
  bills: Array<{ billId: string; utilityType: UtilityType; amount: number }>
  /** Lines rung up by hand that are recovery with no bill behind them (the Andres shape). */
  withoutBill: Array<{ utilityType: UtilityType; amount: number }>
  /** Charge rows on the payer's invoice this collection voided. */
  chargesVoided: string[]
  /** Charges another record holds, which could not be voided — somebody has to look. */
  chargesHeld: string[]
}

/**
 * THE SETTLE. Called from finalizePayLink inside the sale's own transaction,
 * right after the sale is recorded: the bills this link named are closed out,
 * and every utility line on the sale is written down as recovery.
 *
 * Idempotent. A replayed webhook cannot reach here (finalizePayLink refuses a
 * PaymentIntent already recorded), but the unique indexes on the settlement
 * table mean a second run would be refused rather than double-counted anyway.
 */
export async function recordUtilityPayLinkSettlement(
  client: PoolClient, args: { link: any; saleId: string },
): Promise<UtilitySettlementRecorded> {
  const out: UtilitySettlementRecorded = { bills: [], withoutBill: [], chargesVoided: [], chargesHeld: [] }
  const billIds = utilityBillIdsOnLink(args.link)

  if (billIds.length) {
    // THE LOCK ORDER IS THE PLATFORM'S: household, then lease, then rows
    // (services/moneyPredicates). So whose households these bills belong to is
    // read WITHOUT a lock first, the household locks are taken in a fixed order,
    // and only then are the bills locked. Reading the bills first would take a
    // row lock ahead of the advisory one and invert the order against every
    // other money path. chargeVoids requires the household lock of its callers.
    const whose = (await client.query<{ tenant_id: string; landlord_id: string }>(
      `SELECT DISTINCT ub.tenant_id, ub.landlord_id FROM utility_bills ub
        WHERE ub.id = ANY($1::uuid[]) AND ub.tenant_id IS NOT NULL
        ORDER BY ub.tenant_id`, [billIds])).rows
    for (const w of whose) await lockHousehold(client, w.tenant_id, w.landlord_id)
    const rows = (await client.query(`${BILL_SELECT}
      WHERE ub.id = ANY($1::uuid[]) AND ub.status IN ('unbilled', 'billed')
      ORDER BY ub.id
      FOR UPDATE OF ub`, [billIds])).rows
    const bills = rows.map(billFromRow)
    // The gate above (utilityBillsNotPayable) holds a payment whose bill cannot
    // be closed, so this read should find every bill the link named. If it does
    // not, money came in and a bill stayed owed — said out loud, because the
    // whole fault this file was corrected for on 10/20 was a second collection
    // that left no trace anybody could read.
    if (bills.length !== billIds.length) {
      logger.error({ payLinkId: args.link.id, saleId: args.saleId,
                     named: billIds.length, closedOut: bills.length },
        '[utility-pay-link] a bill this link named was not closed out by the payment — the money is recorded, the bill is not')
    }
    for (const b of bills) {
      // The charge on their invoice, so nobody is asked twice. Voided, not
      // settled: the register sale carries the income (see the header).
      let voidedId: string | null = null
      if (b.paymentId) {
        // chargeVoids takes a bare query function; this is the same connection.
        const v = await voidUnowedCharges((t, pa) => client.query(t, pa), [b.paymentId], COLLECTED_ON_A_PAY_LINK)
        if (v.voided.length) { voidedId = v.voided[0].id; out.chargesVoided.push(v.voided[0].id) }
        if (v.held.length) out.chargesHeld.push(...v.held)
      }
      await client.query(
        `UPDATE utility_bills
            SET status = 'paid', paid_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status IN ('unbilled', 'billed')`, [b.billId])
      // The open row this link wrote becomes the settlement. A link raised
      // before this build (or one whose row was closed) gets its row now, so a
      // collection is never recorded as nothing.
      const claimed = (await client.query(
        `UPDATE utility_pay_link_settlements
            SET status = 'settled', settled_at = NOW(), pos_transaction_id = $3,
                payment_id = COALESCE($4, payment_id), updated_at = NOW()
          WHERE pay_link_id = $1 AND utility_bill_id = $2 AND status = 'open'
          RETURNING id`, [args.link.id, b.billId, args.saleId, voidedId])).rows[0]
      if (!claimed) {
        await client.query(
          `INSERT INTO utility_pay_link_settlements
             (pay_link_id, landlord_id, property_id, utility_bill_id, unit_id, meter_id,
              billing_cycle_month, utility_type, charge_amount, tax_amount,
              status, settled_at, pos_transaction_id, payment_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,'settled',NOW(),$11,$12,$13)`,
          [args.link.id, b.landlordId, b.propertyId, b.billId, b.unitId, b.meterId,
           b.billingCycleMonth, b.utilityType, b.charge.toFixed(2), b.tax.toFixed(2),
           args.saleId, voidedId, b.lineName])
      }
      out.bills.push({ billId: b.billId, utilityType: b.utilityType, amount: b.amount })
      // The bill came off their invoice: its totals follow what is left on it.
      if (b.invoiceId && voidedId) await retotalInvoice(client, b.invoiceId)
    }
  }

  // EVERY UTILITY LINE ON THE SALE, read from the line's OWN snapshot — the
  // propane lane's explicit column, never the item's name or its category. A
  // bill-raised line has no item and so no column, which is how these two
  // branches stay disjoint without a flag anybody has to maintain.
  const lines = (await client.query(
    `SELECT ti.id, ti.recovers_utility, ti.item_name,
            ROUND(ti.subtotal, 2)::text AS subtotal,
            ROUND(ti.subtotal * COALESCE(ti.tax_rate, 0), 2)::text AS tax
       FROM pos_transaction_items ti
      WHERE ti.transaction_id = $1 AND ti.recovers_utility IS NOT NULL
      ORDER BY ti.id`, [args.saleId])).rows
  for (const l of lines) {
    const type = String(l.recovers_utility) as UtilityType
    if (!(UTILITY_TYPES as readonly string[]).includes(type)) {
      // The CHECK makes this unreachable; said out loud rather than stored wrong.
      logger.error({ saleId: args.saleId, lineId: l.id, recoversUtility: l.recovers_utility },
        '[utility-pay-link] a sale line names a utility GAM does not know — not recorded as recovery')
      continue
    }
    const charge = round2(Number(l.subtotal) || 0)
    const tax = round2(Number(l.tax) || 0)
    if (!(charge + tax > 0)) continue
    // Which space and cycle it was for is unknown for a line somebody rang up
    // at the counter, and NULL there means "nobody said" — not zero. That is
    // the honest record; inventing a meter and a cycle to fill the columns is
    // how a report starts reading made-up numbers.
    const r = (await client.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, landlord_id, property_id, utility_bill_id, utility_type,
          charge_amount, tax_amount, status, settled_at, pos_transaction_id,
          pos_transaction_item_id, notes)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,'settled',NOW(),$7,$8,$9)
       ON CONFLICT (pos_transaction_item_id) WHERE pos_transaction_item_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [args.link.id, args.link.landlord_id, args.link.property_id, type,
       charge.toFixed(2), tax.toFixed(2), args.saleId, l.id, String(l.item_name ?? '').slice(0, 200)])).rows[0]
    if (r) out.withoutBill.push({ utilityType: type, amount: round2(charge + tax) })
  }

  if (out.bills.length || out.withoutBill.length) {
    logger.info({ payLinkId: args.link.id, saleId: args.saleId,
                  bills: out.bills.length, withoutBill: out.withoutBill.length,
                  chargesVoided: out.chargesVoided.length, chargesHeld: out.chargesHeld.length },
      '[utility-pay-link] utility money collected on a pay link')
  }
  return out
}

/**
 * An invoice's totals follow what is still on it after a line came off. The
 * same rollup services/renewalSuccessor runs; the payments trigger
 * (trg_payments_invoice_status_rollup) has already moved the status.
 */
async function retotalInvoice(q: Q, invoiceId: string): Promise<void> {
  await q.query(
    `WITH lines AS (
       SELECT p.type, p.amount, p.lease_fee_id, p.work_trade_suspended_at
         FROM payments p
        WHERE p.invoice_id = $1
          AND p.status IN ('pending', 'processing', 'settled', 'paid_via_deposit')),
     t AS (
       SELECT COALESCE(SUM(amount) FILTER (WHERE work_trade_suspended_at IS NULL AND type <> 'late_fee'), 0) AS total,
              COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0) AS rent,
              COALESCE(SUM(amount) FILTER (WHERE type = 'fee'
                                           OR (type = 'deposit' AND lease_fee_id IS NOT NULL)), 0) AS fees,
              COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND lease_fee_id IS NULL), 0) AS deposits,
              COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0) AS utilities,
              COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home
         FROM lines)
     UPDATE invoices i
        SET total_amount = t.total, subtotal_rent = t.rent, subtotal_fees = t.fees,
            subtotal_deposits = t.deposits, subtotal_utilities = t.utilities,
            subtotal_home_payments = t.home, updated_at = NOW()
       FROM t
      WHERE i.id = $1 AND i.status <> 'void'
        AND (i.total_amount, i.subtotal_rent, i.subtotal_fees, i.subtotal_deposits,
             i.subtotal_utilities, i.subtotal_home_payments)
            IS DISTINCT FROM (t.total, t.rent, t.fees, t.deposits, t.utilities, t.home)`,
    [invoiceId])
  await q.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [invoiceId])
}

/**
 * A link closed before it was paid lets go of the bills it was holding, so
 * another one can be raised for them. Runs in the cancel's own transaction.
 */
export async function releaseUtilityPayLinkSettlements(q: Q, payLinkId: string): Promise<number> {
  const r = await q.query(
    `UPDATE utility_pay_link_settlements
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE pay_link_id = $1 AND status = 'open'
      RETURNING id`, [payLinkId])
  return r.rows.length
}

export interface UtilityRefundReopened {
  billId: string | null
  utilityType: UtilityType
  amount: number
  landlordId: string
  propertyId: string
  spaceLabel: string | null
  cycle: string | null
}

/** A part refund that left the utility where it was, and the figures that say why. */
export interface UtilityPartRefundKept {
  landlordId: string
  propertyId: string
  /** What this refund handed back. */
  refunded: number
  /** Utility money on the sale that is still counted as collected. */
  stillCollected: number
  /** What is still closed out, for the words. */
  lines: readonly { billId: string | null; utilityType: UtilityType; amount: number; spaceLabel: string | null; cycle: string | null }[]
}

export interface UtilityRefundOutcome {
  /** Bills put back on the books, because the whole sale went back. */
  owedAgain: UtilityRefundReopened[]
  /** A part refund on a sale that had collected utility — told, never re-billed. */
  partRefund: UtilityPartRefundKept | null
}

const SETTLEMENT_SELECT = `s.id, s.utility_bill_id, s.utility_type, s.landlord_id, s.property_id,
                           (s.charge_amount + s.tax_amount)::text AS amount,
                           to_char(s.billing_cycle_month, 'YYYY-MM-DD') AS cycle`

/** The space each of these bills is on, for words a landlord can act on. */
async function spaceLabelsForBills(q: Q, billIds: readonly string[]): Promise<Map<string, string>> {
  if (!billIds.length) return new Map()
  const rows = (await q.query(
    `SELECT ub.id, COALESCE(NULLIF(un.display_label, ''), un.unit_number, '') AS space_label
       FROM utility_bills ub JOIN units un ON un.id = ub.unit_id
      WHERE ub.id = ANY($1::uuid[])`, [billIds])).rows
  return new Map(rows.map((r: any) => [r.id as string, String(r.space_label || '')]))
}

/**
 * WHAT A REFUND DOES TO UTILITY COLLECTED ON A PAY LINK.
 *
 * 10/20 (fix): this used to reopen every bill on the sale for a refund of ANY
 * size, and that is a bug with a real person on the other end of it. $44.94 of
 * September electric goes out as a link, the payer pays it, the desk hands $5
 * back — and the resident was asked for $44.94 again while $39.94 of their money
 * sat in the bank. On a link carrying two bills, refunding August's $81.27 also
 * reopened September's $81.90 that nobody refunded a cent of.
 *
 * Nic's rule the old code cited — "Any refund, even partial, means no wash" —
 * is about WHETHER A WASH HAPPENED. A wash is GAM's own choice not to bill, so
 * calling it off costs nobody anything. A bill is a person's debt. Reopening one
 * asks that person for money again, so it needs more than "a refund happened".
 *
 * It needs proof the utility's money is what went back, and there is exactly one
 * refund that proves it. A sale carries utility U out of a total S; a refund R
 * only certainly reaches the utility once it is bigger than everything that is
 * NOT utility, so the part that is certainly utility money back is
 * max(0, R − (S − U)) — which reaches U only when R reaches S. Short of the
 * whole refundable sale going back, nothing says which bill's money left, and
 * guessing at it is the same guessing this file refuses to do with the
 * register's item names.
 *
 * So:
 *   THE WHOLE SALE WENT BACK → every settlement goes to 'refunded' and every
 *     bill is owed again ('billed', paid_at cleared, payment_id cleared so the
 *     straggler sweep — utilityBilling attachStrandedUtilityBill — can put it
 *     back on an open invoice). The voided charge row stays voided: a true
 *     record of the day the link was paid, and GAM writes a new ask rather than
 *     rewriting an old one.
 *   PART OF IT WENT BACK → nothing is re-billed. The settlements stay settled,
 *     the bills stay closed out (the landlord is holding that money), each row
 *     is noted with the refund that was taken, and the account holder is told
 *     with the real figures so a person decides. If the rest goes back later,
 *     that refund is the full one and the bills reopen then.
 *
 * `fullyRefunded` is the caller's own "everything refundable has been handed
 * back" — cumulative across part refunds, and net of anything the sale carried
 * that is never refunded (a guest's background check is GAM's and stays GAM's).
 * It is not re-derived here: the refund route is where the money arithmetic for
 * a sale lives, and two places computing it is two places to get it wrong.
 *
 * Idempotent. A second refund on a sale with nothing settled finds nothing.
 */
export async function reopenUtilityPayLinkSettlements(
  q: Q, args: { saleId: string; reason: string; refundedAmount: number; fullyRefunded: boolean },
): Promise<UtilityRefundOutcome> {
  if (!args.fullyRefunded) {
    // Noted, not reopened. The note is the trail: the row still says the money
    // was collected, and says underneath it that some of it went back.
    const kept = (await q.query(
      `UPDATE utility_pay_link_settlements s
          SET notes = TRIM(COALESCE(s.notes || ' — ', '') || $2), updated_at = NOW()
        WHERE s.pos_transaction_id = $1 AND s.status = 'settled'
        RETURNING ${SETTLEMENT_SELECT}`,
      [args.saleId, `${args.reason} — part of the sale only, so this stays collected`])).rows
    if (!kept.length) return { owedAgain: [], partRefund: null }
    const spaces = await spaceLabelsForBills(q, kept.map((r: any) => r.utility_bill_id).filter(Boolean))
    logger.info({ saleId: args.saleId, refunded: round2(args.refundedAmount), lines: kept.length },
      '[utility-pay-link] a part refund on a sale that had collected utility — nothing re-billed, the account holder is told')
    return {
      owedAgain: [],
      partRefund: {
        landlordId: kept[0].landlord_id, propertyId: kept[0].property_id,
        refunded: round2(args.refundedAmount),
        stillCollected: round2(kept.reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0)),
        lines: kept.map((r: any) => ({
          billId: r.utility_bill_id ?? null,
          utilityType: r.utility_type as UtilityType,
          amount: round2(Number(r.amount) || 0),
          spaceLabel: spaces.get(r.utility_bill_id) || null,
          cycle: r.cycle ?? null,
        })),
      },
    }
  }

  const rows = (await q.query(
    `UPDATE utility_pay_link_settlements s
        SET status = 'refunded', refunded_at = NOW(), updated_at = NOW(),
            notes = TRIM(COALESCE(s.notes || ' — ', '') || $2)
      WHERE s.pos_transaction_id = $1 AND s.status = 'settled'
      RETURNING ${SETTLEMENT_SELECT}`,
    [args.saleId, args.reason])).rows
  if (!rows.length) return { owedAgain: [], partRefund: null }
  const billIds = rows.map((r: any) => r.utility_bill_id).filter(Boolean)
  if (billIds.length) {
    await q.query(
      `UPDATE utility_bills
          SET status = 'billed', paid_at = NULL, payment_id = NULL, updated_at = NOW(),
              notes = TRIM(COALESCE(notes || ' — ', '') || $2)
        WHERE id = ANY($1::uuid[]) AND status = 'paid'`,
      [billIds, PAY_LINK_REFUNDED_NOTE])
  }
  const spaces = await spaceLabelsForBills(q, billIds)
  return {
    owedAgain: rows.map((r: any) => ({
      billId: r.utility_bill_id ?? null,
      utilityType: r.utility_type as UtilityType,
      amount: round2(Number(r.amount) || 0),
      landlordId: r.landlord_id, propertyId: r.property_id,
      spaceLabel: spaces.get(r.utility_bill_id) || null,
      cycle: r.cycle ?? null,
    })),
    partRefund: null,
  }
}

/** What the landlord is told when a refund puts utility bills back on the books. */
export function utilityOwedAgainWords(back: readonly UtilityRefundReopened[]): { title: string; body: string } {
  const total = round2(back.reduce((s, b) => s + b.amount, 0))
  const what = back.map(b => `${UTILITY_TYPE_LABEL[b.utilityType]}${b.cycle ? ` for ${cycleWords(b.cycle)}` : ''}`
    + `${b.spaceLabel ? ` on ${b.spaceLabel}` : ''} ($${b.amount.toFixed(2)})`).join(', ')
  const bills = back.filter(b => b.billId).length
  return {
    title: `A refund put $${total.toFixed(2)} of utility back on the books`,
    body: `A pay link that had paid ${what} was refunded, so that money is not recovered any more. `
      + (bills > 0
        ? `${bills === 1 ? 'The bill is' : 'The bills are'} owed again and ${bills === 1 ? 'goes' : 'go'} back on the payer's next bill. `
          + 'Send it again under Pay Links, or take it at the counter.'
        : 'Nothing was billed for it, so ask for it again at the counter or on a new pay link.'),
  }
}

/**
 * Tell the account holder that a refund put utility back on the books. Called
 * AFTER the refund commits (email never runs inside a money transaction) and
 * never throws: a notice that fails must not undo a refund the card already got.
 */
export async function tellLandlordUtilityOwedAgain(back: readonly UtilityRefundReopened[]): Promise<void> {
  if (!back.length) return
  try {
    const { query } = await import('../db')
    const { createNotification } = await import('./notifications')
    const landlordId = back[0].landlordId
    const owner = (await query<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [landlordId]))[0]
    if (!owner) return
    const words = utilityOwedAgainWords(back)
    await createNotification({
      userId: owner.user_id, landlordId, type: 'utility_bill_owed_again',
      title: words.title, body: words.body,
      data: { bills: back.filter(b => b.billId).map(b => b.billId), amount: round2(back.reduce((s, b) => s + b.amount, 0)) },
      actionUrl: '/utility-meters',
    })
  } catch (err) {
    logger.error({ err }, '[utility-pay-link] could not tell the landlord that a refund put utility back on the books')
  }
}

/**
 * What the landlord is told when PART of a sale that had closed out a utility
 * bill goes back. Nobody is re-billed, so the notice has to say what GAM did,
 * why it did nothing more, and what the landlord can do — in that order.
 */
export function utilityPartRefundWords(kept: UtilityPartRefundKept): { title: string; body: string } {
  const what = kept.lines.map(b => `${UTILITY_TYPE_LABEL[b.utilityType]}${b.cycle ? ` for ${cycleWords(b.cycle)}` : ''}`
    + `${b.spaceLabel ? ` on ${b.spaceLabel}` : ''} ($${b.amount.toFixed(2)})`).join(', ')
  const bills = kept.lines.filter(b => b.billId).length
  return {
    title: `$${kept.refunded.toFixed(2)} was refunded on a sale that had paid $${kept.stillCollected.toFixed(2)} of utility`,
    body: `That sale had paid ${what}. `
      + (bills > 0
        ? `${bills === 1 ? 'That bill is' : 'Those bills are'} still closed out and nobody has been asked for it again. `
        : 'That money is still counted as recovered and nobody has been asked for it again. ')
      + 'Only part of the sale went back, so GAM cannot say whether the refund was the utility or the rest of the sale — '
      + `and re-billing the full amount would ask for money you are still holding. `
      + `If the refund really was the utility, ask for the difference at the counter or on a new pay link. `
      + `If the whole sale goes back later, ${bills === 1 ? 'the bill goes' : bills > 1 ? 'the bills go' : 'it goes'} back on the books on its own.`,
  }
}

/**
 * Tell the account holder that a part refund landed on a sale that had collected
 * utility, and that GAM left the bill closed out. Called AFTER the refund
 * commits and never throws, for the same reason as the notice above.
 */
export async function tellLandlordUtilityPartRefund(kept: UtilityPartRefundKept | null): Promise<void> {
  if (!kept || !kept.lines.length) return
  try {
    const { query } = await import('../db')
    const { createNotification } = await import('./notifications')
    const owner = (await query<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [kept.landlordId]))[0]
    if (!owner) return
    const words = utilityPartRefundWords(kept)
    await createNotification({
      userId: owner.user_id, landlordId: kept.landlordId, type: 'utility_part_refund_kept',
      title: words.title, body: words.body,
      data: { bills: kept.lines.filter(b => b.billId).map(b => b.billId),
              refunded: kept.refunded, stillCollected: kept.stillCollected },
      actionUrl: '/utility-meters',
    })
  } catch (err) {
    logger.error({ err }, '[utility-pay-link] could not tell the landlord about a part refund on a sale that had collected utility')
  }
}
