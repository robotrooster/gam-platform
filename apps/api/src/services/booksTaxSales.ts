/**
 * 10/17 (Nic) — WHAT WAS SOLD, AND WHAT TAX WAS COLLECTED, FOR THE FILING
 *
 *   Nic, 10/17: "There is things listed as other income or just sales. Sales
 *   need to be broken down separately because we collect lodging tax for
 *   short-term stays and we collect sales tax on propane for the transaction
 *   privilege tax. Those need to be itemized so we can file that tax to the
 *   right departments and pay that correctly — the landlord needs to be able
 *   to do that, for Mountain View. We're also showing some other miscellaneous
 *   income that I think she said was a weird amount, $13 and some change.
 *   Nothing we have priced comes out that way... we need more breakdown so we
 *   can see exactly how much of each item was sold and how much of each tax
 *   separated by category was collected. That way it can be forwarded on to
 *   the right agencies, or the right amounts logged."
 *
 * The $13 and some change was FOUR GALLONS OF PROPANE AT $3.30 = $13.20 (a pay
 * link paid 9/29, $0.87 of tax on top). The arithmetic was right; the books
 * showed one lump on 4500 Register sales with no item detail, so there was no
 * way to see it was propane. This module is the detail underneath the accounts
 * that already hold the money — NOTHING here renumbers the chart:
 *
 *   WHAT WAS SOLD      every item sold in the period with its quantity and its
 *                      dollars, grouped by its register category, and a bridge
 *                      that shows how those lines add up to exactly what the
 *                      books posted to Register sales (4500). Both sides are
 *                      read off the SAME postings, so the page cannot disagree
 *                      with the books: `difference` is 0.
 *   OTHER MONEY IN     money filed as other income instead of rung up — at
 *                      Mountain View the Square card sales from before the GAM
 *                      card reader — named by the category it was filed under
 *                      and by the words whoever logged it used, with how much
 *                      of it is a lump that recorded no tax inside it.
 *   WHAT TAX WAS       each named tax (Lodging tax, Transaction privilege tax,
 *   COLLECTED          a utility tax, anything the landlord named) with the
 *                      sales it was charged on, the rate(s) it was charged at,
 *                      what was collected, what has been sent to the agency and
 *                      what is still sitting in the liability account. The
 *                      account is named on every row, because that is the money
 *                      the bookkeeper is forwarding.
 *
 * Read off the LEDGER for every figure that has to tie (what each account
 * holds), and off the sale's own rows for the detail the ledger does not carry
 * (which item, how many, at what rate). Every line is read on its ACCOUNTING
 * date, as every other books report is, so a closed month never changes.
 *
 * A tax whose sale never recorded WHICH tax it was shows on its own line, named
 * (BOOKS_TAX_UNNAMED_LABEL) — it is a defect to fix before filing, not a tax
 * (scripts/oct17_name_unnamed_sale_taxes.ts names them; routes/posPayLinks now
 * names a goods pay link's taxes when the sale is written, so no new sale can
 * land there).
 *
 * Read-only. Writes nothing.
 */
import { query } from '../db'
import {
  BOOKS_OTHER_INCOME_NO_CATEGORY_LABEL, BOOKS_OTHER_INCOME_ROLES, BOOKS_SOLD_NO_CATEGORY_LABEL,
  BOOKS_TAX_ROLES, BOOKS_TAX_ROLE_LABEL, BOOKS_TAX_UNNAMED_LABEL,
  type BooksOtherIncomeBreakdown, type BooksOtherIncomeRow,
  type BooksSalesAndTax, type BooksSalesBreakdown, type BooksSoldCategory, type BooksSoldItem,
  type BooksTaxBreakdown, type BooksTaxRateRow, type BooksTaxRole, type BooksTaxRow,
} from '@gam/shared'
import { cutoffsParam, withinCutoffsSql } from '../lib/bookkeeperScope'
import type { LedgerScope } from './ledgerReports'

const round2 = (n: number) => Math.round(n * 100) / 100
const cents = (v: string | number | null | undefined) => Math.round((Number(v ?? 0) || 0) * 100)
const ymd = (d: string) => String(d).slice(0, 10)

/** The income account the register's goods land on, and the account a give-back lands on. */
const SALES_ROLE = 'register_sales'
const RETURNS_ROLE = 'sales_returns'
/** What a sale credits for money that paid a stay: held until the guest arrives (registerSale). */
const STAY_HELD_ROLE = 'guest_deposits'

/** Pushes a parameter and returns its placeholder. */
function param(params: unknown[], v: unknown): string {
  params.push(v)
  return `$${params.length}`
}

/**
 * The scope's WHERE conditions on the line table aliased `l` — the company (or
 * companies), the properties the viewer keeps, and a bookkeeper's clean cut at
 * a sale. The same three conditions services/ledgerReports puts on every
 * report; written here so this module reads the lines on its own.
 */
function scopeWhere(s: LedgerScope, params: unknown[], l = 'l'): string {
  const conds = [`${l}.landlord_id = ANY(${param(params, [...s.landlordIds])}::uuid[])`]
  if (s.propertyIds) conds.push(`${l}.property_id = ANY(${param(params, [...s.propertyIds])}::uuid[])`)
  if (s.cutoffs?.length) conds.push(withinCutoffsSql(`${l}.property_id`, `${l}.accounting_date`, param(params, cutoffsParam(s.cutoffs))))
  return conds.join(' AND ')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The records of one kind whose own posting lands in the period and in scope —
 * the active post only (a record changed since has exactly one), so nothing is
 * read twice. Returns their ids.
 */
async function postedSourceIds(s: LedgerScope, sourceType: string, start: string, end: string): Promise<string[]> {
  const params: unknown[] = [ymd(start), ymd(end), sourceType]
  const rows = await query<{ source_id: string }>(
    `SELECT DISTINCT p.source_id
       FROM ledger_postings p
       JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.source_type = $3 AND p.role = 'post' AND p.superseded_at IS NULL
        AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeWhere(s, params)}`, params)
  // source_id is text; these ids are always uuids, so anything else is not ours.
  return rows.map(r => r.source_id).filter(id => UUID.test(id))
}

/** One row of the itemized list, as the database hands it back. */
interface SoldRow { category: string | null; name: string; unit: string | null; qty: string; sales: string; n: number }

/**
 * Every item the period's sales sold: how many went out and what they sold for
 * before tax, grouped by the register category.
 *
 * The NAME is the catalog item's when the line came from the catalog, so the
 * same thing sold on a pay link ("RV site — monthly — 31 nights at site RV 10
 * (Oct 4 → Nov 4)") and at the counter add up on ONE line; a one-off line the
 * cashier typed keeps its own wording. The CATEGORY is the catalog's too, so a
 * category reads one way down the page (a pay link's stored line can say
 * 'misc' for something the catalog files under Stays).
 */
async function soldItems(saleIds: string[]): Promise<BooksSoldCategory[]> {
  if (!saleIds.length) return []
  const rows = await query<SoldRow>(
    `SELECT COALESCE(pc.name, NULLIF(TRIM(i.item_category), '')) AS category,
            COALESCE(si.name, i.item_name)                       AS name,
            si.stay_unit                                         AS unit,
            SUM(i.qty)::text                                     AS qty,
            SUM(i.subtotal)::text                                AS sales,
            COUNT(DISTINCT i.transaction_id)::int                AS n
       FROM pos_transaction_items i
       LEFT JOIN pos_items si      ON si.id = i.item_id
       LEFT JOIN pos_categories pc ON pc.id = si.category_id
      WHERE i.transaction_id = ANY($1::uuid[])
      GROUP BY 1, 2, 3
      ORDER BY 1 NULLS LAST, 5 DESC, 2`, [saleIds])
  const byCategory = new Map<string | null, BooksSoldCategory>()
  for (const r of rows) {
    const key = r.category ?? null
    let group = byCategory.get(key)
    if (!group) {
      group = { category: key, label: key ?? BOOKS_SOLD_NO_CATEGORY_LABEL, items: [], sales: 0 }
      byCategory.set(key, group)
    }
    const item: BooksSoldItem = {
      name: r.name, unit: r.unit ?? null,
      // How many went out — gallons and kWh come with decimals, so the
      // quantity keeps three of them (4 gallons reads 4, 4.6 reads 4.6).
      qty: Math.round((Number(r.qty) || 0) * 1000) / 1000,
      sales: round2(Number(r.sales)), salesCount: Number(r.n) || 0,
    }
    group.items.push(item)
    group.sales = round2(group.sales + item.sales)
  }
  // Biggest category first; a category with no name last (it is the leftovers).
  return [...byCategory.values()].sort((a, b) =>
    (a.category === null ? 1 : 0) - (b.category === null ? 1 : 0) || b.sales - a.sales)
}

/**
 * How the item lines add up to what the books posted to Register sales. The
 * register's own posting rule (ledgerProjectors/registerSale) is, per sale:
 *
 *   Register sales credit = subtotal − discount − background check
 *                           − what paid toward a stay + a cash sale's card fee
 *
 * so the bridge below is that identity, added up — every term read the way the
 * projector reads it (the stay share off the posting's own Guest deposits
 * credit, the background check off the rows recorded with the sale), and
 * `posted` read off the account itself. `difference` is the proof.
 */
async function salesTie(s: LedgerScope, start: string, end: string, saleIds: string[]): Promise<BooksSalesBreakdown['tie']> {
  const fromSales = saleIds.length
    ? (await query<{ item_lines: string; subtotal: string; discount: string; cash_surcharge: string; screening: string }>(
      `SELECT COALESCE(SUM((SELECT COALESCE(SUM(i.subtotal), 0) FROM pos_transaction_items i
                             WHERE i.transaction_id = t.id)), 0)::text AS item_lines,
              COALESCE(SUM(t.subtotal), 0)::text        AS subtotal,
              COALESCE(SUM(t.discount_amount), 0)::text AS discount,
              COALESCE(SUM(CASE WHEN t.payment_method IN ('card', 'card_on_file') THEN 0 ELSE t.surcharge END), 0)::text AS cash_surcharge,
              COALESCE(SUM((SELECT COALESCE(SUM(sp.amount), 0) FROM screening_prepayments sp
                             WHERE sp.source_id IS NOT NULL
                               AND sp.source_id IN (t.id, COALESCE(t.pay_link_id, t.id)))), 0)::text AS screening
         FROM pos_transactions t WHERE t.id = ANY($1::uuid[])`, [saleIds]))[0]
    : undefined

  // What of those sales paid toward a stay: the postings' own Guest deposits
  // credits (held until the guest arrives, earned by the booking's projector).
  const stayParams: unknown[] = [ymd(start), ymd(end)]
  const stayHeld = saleIds.length
    ? (await query<{ n: string }>(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
         FROM ledger_posting_lines l
         JOIN ledger_postings p ON p.id = l.posting_id
        WHERE p.source_type = 'pos_sale' AND p.role = 'post' AND p.superseded_at IS NULL
          AND p.source_id = ANY(${param(stayParams, saleIds)}::text[])
          AND l.account_role = '${STAY_HELD_ROLE}'
          AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeWhere(s, stayParams)}`, stayParams))[0]
    : undefined

  // The account itself: everything on Register sales over these days, and the
  // part of it that is NOT one of the active sale postings above (a sale taken
  // back and re-posted after its month closed, or anything else that moved it).
  const postedParams: unknown[] = [ymd(start), ymd(end)]
  const posted = (await query<{ posted: string; corrections: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS posted,
            COALESCE(SUM(CASE WHEN p.source_type = 'pos_sale' AND p.role = 'post' AND p.superseded_at IS NULL
                              THEN 0 ELSE l.credit - l.debit END), 0)::text AS corrections
       FROM ledger_posting_lines l
       JOIN ledger_postings p ON p.id = l.posting_id
      WHERE l.account_role = '${SALES_ROLE}'
        AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeWhere(s, postedParams)}`, postedParams))[0]

  const returnParams: unknown[] = [ymd(start), ymd(end)]
  const returns = (await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS n
       FROM ledger_posting_lines l
      WHERE l.account_role = '${RETURNS_ROLE}'
        AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeWhere(s, returnParams)}`, returnParams))[0]

  const itemLines = cents(fromSales?.item_lines)
  const discounts = cents(fromSales?.discount)
  const towardStays = cents(stayHeld?.n)
  const backgroundChecks = cents(fromSales?.screening)
  const cashSurcharge = cents(fromSales?.cash_surcharge)
  const corrections = cents(posted?.corrections)
  const postedCents = cents(posted?.posted)
  return {
    itemLines: itemLines / 100,
    discounts: discounts / 100,
    towardStays: towardStays / 100,
    backgroundChecks: backgroundChecks / 100,
    cashSurcharge: cashSurcharge / 100,
    corrections: corrections / 100,
    posted: postedCents / 100,
    difference: (itemLines - discounts - towardStays - backgroundChecks + cashSurcharge + corrections - postedCents) / 100,
    returns: cents(returns?.n) / 100,
  }
}

/** One (name, rate) pair a period's sales charged, with the sales behind it. */
interface RateFact { name: string; rate: number; amountCents: number; taxableCents: number; records: number }

/**
 * The rates the period's sales charged each named tax at, and the sales behind
 * each — from the sale's OWN record of what it charged
 * (pos_transactions.tax_breakdown, written when the sale was rung up), LESS
 * what was handed back to a customer over the same days.
 *
 * The sales a tax was charged on are read off the sale's lines: the lines
 * charged at that rate, added up. A give-back is read off the refund's own
 * record the same way the refund projector reads it — its tax split across the
 * sale's own tax mix (registerRefund scaleTaxParts) — so the base comes down
 * with the money and the two columns she files from stay on one basis.
 *
 * 10/17 (review): pos_transaction_items.tax_rate is the COMBINED rate of every
 * named tax on the line (posTax effectiveItemTaxes), so matching a single tax's
 * rate against it reads a clean base only when that tax was the only one on the
 * line. Nothing here trusts that: `taxesCollected` checks every row's base
 * against the money before it is shown (base × rate must be the tax collected),
 * and works the base back from the money when it does not — which is why this
 * returns the sale count too, for the rounding allowance that check needs.
 */
async function rateFacts(saleIds: string[], refundIds: string[]): Promise<RateFact[]> {
  if (!saleIds.length && !refundIds.length) return []
  const rows = await query<{ name: string; rate: string; amount: string; taxable: string; records: number }>(
    `WITH sold AS (
       -- What each sale charged, by name and rate, and the base read off its lines.
       SELECT t.id AS record_id, b->>'name' AS name,
              ROUND(COALESCE((b->>'rate')::numeric, 0), 4)   AS rate,
              ROUND(COALESCE((b->>'amount')::numeric, 0), 2) AS amount,
              CASE WHEN COALESCE((b->>'rate')::numeric, 0) <= 0 THEN 0
                   ELSE (SELECT COALESCE(SUM(i.subtotal), 0) FROM pos_transaction_items i
                          WHERE i.transaction_id = t.id
                            AND ROUND(i.tax_rate, 4) = ROUND(COALESCE((b->>'rate')::numeric, 0), 4)) END AS taxable
         FROM pos_transactions t
         CROSS JOIN LATERAL jsonb_array_elements(t.tax_breakdown) b
        WHERE t.id = ANY($1::uuid[]) AND jsonb_typeof(t.tax_breakdown) = 'array'
          AND b ? 'name' AND COALESCE((b->>'amount')::numeric, 0) > 0),
     -- A give-back: its tax split across the sale's own mix, and the base that
     -- tax was charged on (the tax over its rate — the arithmetic the agency
     -- form does, so the row stays submittable after a refund).
     given_back AS (
       SELECT r.id AS record_id, b->>'name' AS name,
              ROUND(COALESCE((b->>'rate')::numeric, 0), 4) AS rate,
              ROUND(r.tax_refunded * COALESCE((b->>'amount')::numeric, 0) / NULLIF(mix.total, 0), 2) AS amount
         FROM pos_refunds r
         JOIN pos_transactions t ON t.id = r.transaction_id
         CROSS JOIN LATERAL jsonb_array_elements(t.tax_breakdown) b
         CROSS JOIN LATERAL (SELECT COALESCE(SUM(COALESCE((x->>'amount')::numeric, 0)), 0) AS total
                               FROM jsonb_array_elements(t.tax_breakdown) x) mix
        -- No filter of its own on which refunds count: $2 is the refunds whose
        -- ACTIVE posting lands in these days, which is the projector's own
        -- answer to that question (an early check-out's part, a store-charge
        -- refund and anything it refuses never post, so never appear here).
        WHERE r.id = ANY($2::uuid[]) AND r.tax_refunded > 0
          AND jsonb_typeof(t.tax_breakdown) = 'array'
          AND b ? 'name' AND COALESCE((b->>'amount')::numeric, 0) > 0 AND mix.total > 0),
     charged_and_given_back AS (
       SELECT record_id, name, rate, amount, taxable FROM sold
       UNION ALL
       SELECT record_id, name, rate, -amount,
              CASE WHEN rate > 0 THEN -ROUND(amount / rate, 2) ELSE 0 END
         FROM given_back)
     SELECT name, rate::text AS rate, SUM(amount)::text AS amount, SUM(taxable)::text AS taxable,
            COUNT(DISTINCT record_id)::int AS records
       FROM charged_and_given_back GROUP BY 1, 2 HAVING SUM(amount) <> 0 ORDER BY 1, 2`, [saleIds, refundIds])
  return rows.map(r => ({
    name: r.name, rate: Number(r.rate) || 0,
    amountCents: cents(r.amount), taxableCents: cents(r.taxable), records: Number(r.records) || 0,
  }))
}

/**
 * `total` split across `weights` to the cent, biggest remainder first (so the
 * rate rows always add up to the account's own figure).
 */
function splitCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, w) => a + Math.abs(w), 0)
  if (!weights.length) return []
  if (sum === 0) {
    const out = weights.map(() => 0)
    out[0] = total
    return out
  }
  const exact = weights.map(w => (total * Math.abs(w)) / sum)
  const out = exact.map(v => Math.trunc(v))
  let left = total - out.reduce((a, v) => a + v, 0)
  const order = exact.map((v, i) => ({ i, frac: v - Math.trunc(v) })).sort((a, b) => b.frac - a.frac)
  for (const o of order) {
    if (left === 0) break
    const step = left > 0 ? 1 : -1
    out[o.i] += step
    left -= step
  }
  return out
}

/**
 * The base one rate row shows, and whether it was read or derived.
 *
 * 10/17 (review): the filing multiplies the base by the rate and expects the
 * tax, so a base that fails that arithmetic is never shown as if it passed. The
 * base read off the sale lines is kept only when base × rate IS the money
 * collected, allowing a cent for each record's own rounding; otherwise it is
 * worked back from the money (collected ÷ rate) and the row says so. That one
 * rule covers every way the lines can read short — two named taxes stacked on
 * one line (the line records their COMBINED rate, so neither matches it), a
 * discount that scaled the tax but not the line, a chargeback that took the
 * money back without a sale line to take back with it.
 */
function baseFor(f: RateFact, collectedCents: number): { taxableSales: number; estimated: boolean } {
  if (f.rate <= 0) return { taxableSales: 0, estimated: false }
  const allowance = 1 + Math.ceil(f.records / 2)
  const read = f.taxableCents
  if (read > 0 && Math.abs(Math.round(read * f.rate) - collectedCents) <= allowance) {
    return { taxableSales: read / 100, estimated: false }
  }
  return { taxableSales: Math.round(collectedCents / f.rate) / 100, estimated: true }
}

/**
 * Each named tax over the period: what it was charged on, at what rate, what
 * was collected, what has been sent to the agency and what is still sitting in
 * the account.
 *
 * Collected, paid and unpaid are the ACCOUNT'S own figures (the ledger), read
 * the way services/ledgerReports ledgerTaxSummary reads them: tax given back to
 * a customer (a refund, a chargeback) comes off Collected and is never "paid to
 * the government", and a reversal undoes what its original did. The rates come
 * from the sales' own records and are split so they add up to Collected to the
 * cent.
 *
 * Only the taxes a customer pays and the company forwards are here: sales tax
 * and its named sub-accounts, lodging tax, utility tax. Payroll tax is the Tax
 * Center's (it is not collected from a customer).
 */
async function taxesCollected(
  s: LedgerScope, start: string, end: string, saleIds: string[], refundIds: string[],
): Promise<BooksTaxBreakdown> {
  const params: unknown[] = [ymd(start), ymd(end), [...BOOKS_TAX_ROLES]]
  const rows = await query<{
    code: string; name: string; role: string | null; tax_name: string | null; cr: string; dr: string; bal: string
  }>(
    `WITH x AS (
       SELECT a.code, a.name, l.account_role AS role, l.tax_name, l.accounting_date, l.debit, l.credit,
              ps.role = 'reversal' AS undo,
              (l.cash_effect = 'in' OR l.report_category = 'tax_collected') AS taken_in
         FROM ledger_posting_lines l
         JOIN books_accounts a ON a.id = l.account_id
         JOIN ledger_postings ps ON ps.id = l.posting_id
        WHERE l.account_role = ANY($3::text[]) AND l.accounting_date <= $2::date AND ${scopeWhere(s, params)})
     SELECT x.code, x.name, x.role, x.tax_name,
            COALESCE(SUM(CASE WHEN x.undo THEN (CASE WHEN x.taken_in THEN x.credit ELSE 0 END) - x.debit
                              ELSE x.credit - (CASE WHEN x.taken_in THEN x.debit ELSE 0 END) END)
                       FILTER (WHERE x.accounting_date >= $1::date), 0)::text AS cr,
            COALESCE(SUM(CASE WHEN x.undo THEN -(CASE WHEN x.taken_in THEN 0 ELSE x.credit END)
                              ELSE (CASE WHEN x.taken_in THEN 0 ELSE x.debit END) END)
                       FILTER (WHERE x.accounting_date >= $1::date), 0)::text AS dr,
            SUM(x.credit - x.debit)::text AS bal
       FROM x
      GROUP BY 1, 2, 3, 4 ORDER BY x.code, x.tax_name`, params)

  const facts = await rateFacts(saleIds, refundIds)
  const out: BooksTaxRow[] = []
  for (const r of rows) {
    const collected = cents(r.cr)
    const paid = cents(r.dr)
    const unpaid = cents(r.bal)
    if (!collected && !paid && !unpaid) continue
    const role = (BOOKS_TAX_ROLES as readonly string[]).includes(r.role ?? '') ? (r.role as BooksTaxRole) : null
    const mine = r.tax_name ? facts.filter(f => f.name === r.tax_name) : []
    // The rate rows carry the account's own Collected, split by what the sales
    // say each rate charged — so the rows can never add up to something else.
    const share = splitCents(collected, mine.map(f => f.amountCents))
    const rates: BooksTaxRateRow[] = mine.map((f, i) => {
      const got = share[i] ?? 0
      return { rate: f.rate, collected: got / 100, ...baseFor(f, got) }
    })
    // A tax the sale never named is a defect to fix, not a tax: it is the
    // generic Sales tax payable account with no name on the money. Lodging and
    // utility tax carry no name of their own by design (one account each), so
    // they are named after the account they sit in.
    const unnamed = !r.tax_name && role === 'sales_tax_payable'
    out.push({
      label: r.tax_name ?? (unnamed || !role ? BOOKS_TAX_UNNAMED_LABEL : BOOKS_TAX_ROLE_LABEL[role]),
      taxName: r.tax_name ?? null,
      accountCode: r.code, accountName: r.name, accountRole: role,
      rates,
      taxableSales: round2(rates.reduce((a, x) => a + x.taxableSales, 0)),
      estimated: rates.some(x => x.estimated),
      collected: collected / 100, paid: paid / 100, unpaid: unpaid / 100,
      unnamed,
    })
  }
  // An unnamed line last: it is the one that needs fixing, not one she files.
  out.sort((a, b) => (a.unnamed ? 1 : 0) - (b.unnamed ? 1 : 0) || b.collected - a.collected || a.label.localeCompare(b.label))
  return {
    rows: out,
    totals: {
      taxableSales: round2(out.reduce((t, r) => t + r.taxableSales, 0)),
      collected: round2(out.reduce((t, r) => t + r.collected, 0)),
      paid: round2(out.reduce((t, r) => t + r.paid, 0)),
      unpaid: round2(out.reduce((t, r) => t + r.unpaid, 0)),
    },
  }
}

/**
 * 10/17 (Nic): "There is things listed as OTHER INCOME or just sales... We're
 * also showing some other miscellaneous income that I think she said was a
 * weird amount."
 *
 * Money in the period that was FILED as other income instead of rung up at the
 * register — at Mountain View, the Square card sales from before the GAM card
 * reader: propane and overnight stays, logged as five lumps on 4900 Other
 * income. Named here by the category it was filed under and by the words
 * whoever logged it used, so the account reads as what it actually was.
 *
 * Read off the SAME ledger lines that make up the accounts' own figures (the
 * income category the line carries, and its memo), so the list adds up to the
 * accounts to the cent. The record behind a hand-logged lump is joined on for
 * who paid it, which the ledger line does not carry.
 *
 * `noTaxSplit` is the part of it that is a logged lump: no item lines, and no
 * tax recorded inside it. That is the sentence the bookkeeper needs before she
 * files, because any lodging or privilege tax inside those lumps is not in the
 * tax table.
 */
async function otherMoneyIn(s: LedgerScope, start: string, end: string): Promise<BooksOtherIncomeBreakdown> {
  const params: unknown[] = [ymd(start), ymd(end), [...BOOKS_OTHER_INCOME_ROLES]]
  const rows = await query<{
    code: string; name: string; category: string | null; description: string | null
    payer: string | null; amount: string; records: number; lump: boolean
  }>(
    `SELECT a.code, a.name,
            c.name                                       AS category,
            NULLIF(TRIM(COALESCE(l.memo, '')), '')       AS description,
            NULLIF(TRIM(COALESCE(o.payer, '')), '')      AS payer,
            -- The account's own figure: a posting taken back and re-posted
            -- leaves the superseded post AND its reversal, which cancel, so the
            -- plain sum is the balance (the same read the trial balance uses).
            SUM(l.credit - l.debit)::text                AS amount,
            COUNT(DISTINCT ps.source_id)::int            AS records,
            BOOL_OR(ps.source_type = 'other_income')     AS lump
       FROM ledger_posting_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN ledger_postings ps ON ps.id = l.posting_id
       LEFT JOIN books_categories c ON l.map_kind = 'income_category' AND c.id::text = l.map_value
       LEFT JOIN landlord_other_income o ON ps.source_type = 'other_income' AND o.id::text = ps.source_id
      WHERE l.account_role = ANY($3::text[]) AND l.accounting_date BETWEEN $1::date AND $2::date
        AND ${scopeWhere(s, params)}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 6 DESC, 1, 3 NULLS LAST`, params)

  const out: BooksOtherIncomeRow[] = []
  for (const r of rows) {
    const amount = cents(r.amount)
    if (!amount) continue
    out.push({
      accountCode: r.code, accountName: r.name,
      category: r.category ?? null,
      label: r.category ?? r.name ?? BOOKS_OTHER_INCOME_NO_CATEGORY_LABEL,
      description: r.description ?? null, payer: r.payer ?? null,
      amount: amount / 100, records: Number(r.records) || 0, lumpSum: r.lump === true,
    })
  }
  out.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
  return {
    rows: out,
    total: round2(out.reduce((t, r) => t + r.amount, 0)),
    noTaxSplit: round2(out.filter(r => r.lumpSum).reduce((t, r) => t + r.amount, 0)),
  }
}

/** What was sold and what tax was collected over `start`…`end`, for the filing. */
export async function booksSalesAndTax(s: LedgerScope, start: string, end: string, label: string): Promise<BooksSalesAndTax> {
  const [saleIds, refundIds] = await Promise.all([
    postedSourceIds(s, 'pos_sale', start, end),
    postedSourceIds(s, 'pos_refund', start, end),
  ])
  const [categories, tie, otherIncome, taxes] = await Promise.all([
    soldItems(saleIds),
    salesTie(s, start, end, saleIds),
    otherMoneyIn(s, start, end),
    taxesCollected(s, start, end, saleIds, refundIds),
  ])
  return {
    period: { start: ymd(start), end: ymd(end), label },
    sales: { categories, tie, salesCount: saleIds.length },
    otherIncome,
    taxes,
  }
}
