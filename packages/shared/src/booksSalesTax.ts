/**
 * 10/17 (Nic) — WHAT WAS SOLD, AND WHAT TAX WAS COLLECTED, ITEM BY ITEM
 *
 *   Nic, 10/17: "There is things listed as other income or just sales. Sales
 *   need to be broken down separately because we collect lodging tax for
 *   short-term stays and we collect sales tax on propane for the transaction
 *   privilege tax. Those need to be itemized so we can file that tax to the
 *   right departments and pay that correctly — the landlord needs to be able
 *   to do that... we need more breakdown so we can see exactly how much of
 *   each item was sold and how much of each tax separated by category was
 *   collected. That way it can be forwarded on to the right agencies, or the
 *   right amounts logged."
 *
 * The shapes the books' Sales & tax page reads (apps/{books,landlord}/src/
 * financials/SalesTaxPage.tsx) and the service that builds them
 * (apps/api/src/services/booksTaxSales.ts). This file imports nothing.
 *
 * Nothing here renumbers the chart: the breakdown sits UNDERNEATH the accounts
 * that already hold the money (Register sales 4500, Sales tax payable 2040 and
 * its named sub-accounts, Lodging tax payable 2042, Utility tax payable 2045).
 */

// ─── What was sold ───────────────────────────────────────────────────────────

/** One thing sold in the period: how many and for how much, before tax. */
export interface BooksSoldItem {
  /** The name the sale recorded ("Propane", "Dump station"). */
  name: string
  /** How it is sold, when the catalog says ('gal', 'night'…); null when it does not. */
  unit: string | null
  /** How many went out (gallons, nights, tickets). */
  qty: number
  /** What they sold for at their price, before any discount and before tax. */
  sales: number
  /** How many sales carried it. */
  salesCount: number
}

/** The register category the items were sold under. */
export interface BooksSoldCategory {
  /** The category's name as the sale recorded it; null when the sale named none. */
  category: string | null
  /** The category's name for the screen (never a raw key). */
  label: string
  items: BooksSoldItem[]
  /** The category's own total, before discounts and tax. */
  sales: number
}

/**
 * How the item lines add up to what the books posted to Register sales:
 * itemLines − discounts − towardStays − backgroundChecks + cashSurcharge +
 * corrections = posted.
 *
 * 10/17 (review): this is a RECONCILIATION, not an identity, and the page must
 * not promise otherwise. The left side is added up from the sale's own item
 * lines; `posted` is what the books actually credited to Register sales, which
 * the projector derives from the sale's own total. The two agree on every sale
 * GAM has ever written — and `difference` is there to catch the day they do
 * not, which is a defect worth seeing rather than a figure worth hiding.
 */
export const BOOKS_SALES_TIE_TERMS = [
  'itemLines', 'discounts', 'towardStays', 'backgroundChecks', 'cashSurcharge', 'corrections', 'posted',
] as const
export type BooksSalesTieTerm = typeof BOOKS_SALES_TIE_TERMS[number]
/** The sign each term carries in the bridge (posted is the total, not a term). */
export const BOOKS_SALES_TIE_TERM_SIGN: Record<BooksSalesTieTerm, 1 | -1 | 0> = {
  itemLines: 1, discounts: -1, towardStays: -1, backgroundChecks: -1, cashSurcharge: 1, corrections: 1, posted: 0,
}
export const BOOKS_SALES_TIE_TERM_LABEL: Record<BooksSalesTieTerm, string> = {
  itemLines:        'Everything sold, at its price',
  discounts:        'Less discounts given',
  towardStays:      'Less what paid toward a stay',
  backgroundChecks: 'Less background-check fees',
  cashSurcharge:    'Plus a card fee kept in the drawer',
  corrections:      'Plus corrections to earlier sales',
  posted:           'Register sales in the books',
}
export const BOOKS_SALES_TIE_TERM_NOTE: Record<BooksSalesTieTerm, string> = {
  itemLines:        'Every line of every sale that posted in these days, at the price it rang up.',
  discounts:        'A discount comes off the sale, so it never reached an account.',
  towardStays:      'Money toward a stay is held as a guest deposit and earned as stay income when the guest arrives.',
  backgroundChecks: 'A background check is GAM’s money the sale carried; it is never the company’s income.',
  cashSurcharge:    'A card fee a cash sale took stays in the drawer and is the company’s.',
  corrections:      'A sale changed after its month closed is taken back and re-posted; anything else that moved the Register sales account over these days lands here too.',
  posted:           'What the books credited to Register sales over these days. Money given back is on Sales returns, beside this.',
}

export interface BooksSalesTie {
  itemLines: number
  discounts: number
  towardStays: number
  backgroundChecks: number
  cashSurcharge: number
  corrections: number
  /** What the books posted to Register sales (4500) over the period, the sign of income. */
  posted: number
  /** itemLines − discounts − towardStays − backgroundChecks + cashSurcharge + corrections − posted. Zero when the page ties. */
  difference: number
  /** Money given back on the Sales returns account (4520) over the period, shown beside, never netted in. */
  returns: number
}

export interface BooksSalesBreakdown {
  categories: BooksSoldCategory[]
  tie: BooksSalesTie
  /** How many sales the breakdown read. */
  salesCount: number
}

/** The category line a sale with no register category of its own is shown under. */
export const BOOKS_SOLD_NO_CATEGORY_LABEL = 'No category'

// ─── What tax was collected ──────────────────────────────────────────────────

/** The liability accounts a tax collected from a customer sits in (books ledger roles). */
export const BOOKS_TAX_ROLES = ['sales_tax_payable', 'lodging_tax_payable', 'utility_tax_payable'] as const
export type BooksTaxRole = typeof BOOKS_TAX_ROLES[number]
/** What a tax on that account is called when the money carries no name of its own. */
export const BOOKS_TAX_ROLE_LABEL: Record<BooksTaxRole, string> = {
  sales_tax_payable:   'Sales tax',
  lodging_tax_payable: 'Lodging tax',
  utility_tax_payable: 'Utility tax',
}

/**
 * The line a tax lands on when the sale that charged it never recorded WHICH
 * tax it was. It is a defect, not a tax: it is shown by name so the bookkeeper
 * can see it needs fixing before she files (scripts/oct17_name_unnamed_sale_taxes).
 */
export const BOOKS_TAX_UNNAMED_LABEL = 'Not itemized — the sale did not record which tax'

/** One rate a named tax was charged at inside the period (a rate change makes two). */
export interface BooksTaxRateRow {
  /** The rate as a fraction (0.066 = 6.6%); 0 when the sale recorded none. */
  rate: number
  /**
   * The sales the tax was charged on at this rate: the sale lines charged at
   * that rate, added up, less what was handed back to a customer.
   *
   * 10/17 (review): an agency's form multiplies this by the rate and expects
   * the tax, so the figure is only ever shown when it does. A sale GAM cannot
   * read a clean base off — two taxes stacked on one line (the line records the
   * COMBINED rate, so neither tax matches it), a discounted sale, a chargeback —
   * has its base WORKED BACK from the money instead (collected ÷ rate) and
   * `estimated` is set, so the row is always arithmetic she can submit and the
   * page says which rows were derived.
   */
  taxableSales: number
  /** TRUE when the base was worked back from the money instead of read off the lines. */
  estimated: boolean
  /** What was charged at this rate (the account's own figure, split across the rates). */
  collected: number
}

/** One named tax, for one agency, over the period. */
export interface BooksTaxRow {
  /** The landlord's own name for it ("Transaction privilege tax", "Lodging tax"). */
  label: string
  /** The name the money carries on its ledger lines; null when it carries none. */
  taxName: string | null
  /** The liability account the money sits in. */
  accountCode: string
  accountName: string
  accountRole: BooksTaxRole | null
  /** The rates it was charged at in the period, and the sales behind each. */
  rates: BooksTaxRateRow[]
  /** The sales it was charged on in the period (its rate rows added up). */
  taxableSales: number
  /** TRUE when any of the taxable sales was worked back from the tax (see BooksTaxRateRow). */
  estimated: boolean
  /** Charged to customers in the period (give-backs taken off). */
  collected: number
  /** Sent to the agency in the period. */
  paid: number
  /** Still sitting in the account at the end of the period — what is left to send. */
  unpaid: number
  /** TRUE on the line that exists only because a sale did not say which tax it was. */
  unnamed: boolean
}

export interface BooksTaxBreakdown {
  rows: BooksTaxRow[]
  totals: { taxableSales: number; collected: number; paid: number; unpaid: number }
}

// ─── The other half of what Nic named: "other income" ───────────────────────

/**
 * 10/17 (Nic): "There is things listed as OTHER INCOME or just sales... We're
 * also showing some other miscellaneous income."
 *
 * Money in that was filed as other income rather than rung up at the register:
 * at Mountain View that is the Square card sales from before the GAM card
 * reader — propane and overnight stays, logged as five lumps. Each one is shown
 * with the category it was filed under, in the words the record itself used, so
 * "Other income $457.43" reads as what it was.
 *
 * It is listed SEPARATELY from what was sold, because it is a different kind of
 * record: a lump somebody logged, with no item lines and no tax split. That
 * matters for the filing, so `noTaxSplit` says how much of it is money whose
 * record never recorded any tax at all — any lodging or privilege tax inside it
 * is NOT in the tax table, and has to be worked out from the original receipts.
 */
export const BOOKS_OTHER_INCOME_ROLES = ['other_income', 'laundry_vending', 'interest_earned'] as const
export type BooksOtherIncomeRole = typeof BOOKS_OTHER_INCOME_ROLES[number]

/** One kind of other money in, over the period. */
export interface BooksOtherIncomeRow {
  /** The account it sits in. */
  accountCode: string
  accountName: string
  /** The category it was filed under, by the company's own name for it; null when it was filed under none. */
  category: string | null
  /** The line's name for the screen (the category, else the account). */
  label: string
  /** What the record said it was, in whoever logged it's own words. */
  description: string | null
  /** Who it came from, when the record says. */
  payer: string | null
  amount: number
  /** How many records add up to it. */
  records: number
  /** TRUE when it is a lump somebody logged: no item lines behind it, and no tax recorded inside it. */
  lumpSum: boolean
}

export interface BooksOtherIncomeBreakdown {
  rows: BooksOtherIncomeRow[]
  total: number
  /** Of `total`, the part logged as a lump with no tax recorded inside it. */
  noTaxSplit: number
}

/** The line a record that was filed under no category of its own is shown under. */
export const BOOKS_OTHER_INCOME_NO_CATEGORY_LABEL = 'No category'

/** What the page tells the bookkeeper about money logged as a lump, before she files. */
export const BOOKS_OTHER_INCOME_NO_TAX_NOTE =
  'This money was logged as a lump, so no tax was recorded inside it. Any lodging or sales tax it contains is not in the tax table below — work it out from the original receipts before you file.'

/**
 * 10/19 (Nic): the Money in page carries the same lists, under the rows that
 * hold the money, so a bookkeeper reading what came in does not have to leave
 * the page to find out what it was. Two sentences only that page needs:
 *
 * NOT_ITEMIZABLE — a lump filed as other money in cannot be broken down from
 * inside GAM. GAM holds the amount and the words whoever logged it used; what
 * was inside it lives wherever the money was taken. Saying so plainly is the
 * honest answer, and better than a guessed split: at Mountain View one of these
 * lumps is propane AND overnight stays together, and nothing on record says how
 * much of it was which.
 *
 * COUNTER_NOT_METERED — a register category is the company's own word for what
 * it sells, and a company may well call counter propane "Utilities". That is
 * its data and GAM does not rename it; this says what the page must not let it
 * imply, because a metered utility billed to a space and a bottle of propane
 * sold over the counter are collected under different rules and forwarded to
 * different agencies.
 */
export const BOOKS_OTHER_INCOME_NOT_ITEMIZABLE_NOTE =
  'A lump is one entry: GAM holds the amount and the words whoever logged it, not the items inside it, so it cannot be broken down in here. The detail is wherever the money was taken.'
export const BOOKS_SOLD_COUNTER_NOT_METERED_NOTE =
  'These are the register’s own names for what it sells. Goods sold over the counter are not the metered utilities billed to a space — those are their own rows above, and their tax is not the same tax.'

/** GET /api/books/tax/sales-breakdown. */
export interface BooksSalesAndTax {
  period: { start: string; end: string; label: string }
  sales: BooksSalesBreakdown
  /** Money in filed as other income rather than rung up — the other half Nic named. */
  otherIncome: BooksOtherIncomeBreakdown
  taxes: BooksTaxBreakdown
}

// ─── Naming a sale's taxes ───────────────────────────────────────────────────

/** One named tax on a sale (pos_transactions.tax_breakdown). */
export interface NamedSaleTax { name: string; rate: number; amount: number }

/**
 * The two names that are NOT an agency's. posTax falls back to the item's own
 * bare rate and calls it BARE_ITEM_RATE_NAME; routes/pos writes
 * PLACEHOLDER_TAX_NAME when nothing of the company's resolved at all. Neither
 * names a department, so neither may ever be written onto a sale as if it did:
 * a tax named "Tax" would get its own chart sub-account ("Sales tax payable:
 * Tax") and read on the breakdown as a filable agency line. Money GAM cannot
 * name belongs on the generic account, where the page shows it BY NAME as
 * BOOKS_TAX_UNNAMED_LABEL and says it must be settled before filing.
 *
 * Every writer of pos_transactions.tax_breakdown filters these two
 * (isNamedAgencyTax): routes/posPayLinks on a goods link, and the one-time
 * naming script.
 */
export const BARE_ITEM_RATE_NAME = 'Item tax rate'
export const PLACEHOLDER_TAX_NAME = 'Tax'

/** Does this resolved tax name an agency the money can be filed with? */
export function isNamedAgencyTax(t: { name?: unknown; amount?: unknown }): boolean {
  const name = typeof t.name === 'string' ? t.name.trim() : ''
  if (!name || name === BARE_ITEM_RATE_NAME || name === PLACEHOLDER_TAX_NAME) return false
  return Number(t.amount) > 0
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Pure: `parts` scaled so the amounts add up to `taxAmount` exactly, the
 * rounding cent on the largest. The same rule routes/pos taxBreakdownFor uses
 * on the way in; the pay link and the one-time naming script both scale the
 * rates they resolve to the tax the sale actually charged, so a breakdown
 * recovered later can never change what the customer paid.
 */
export function scaleNamedTaxes(parts: readonly NamedSaleTax[], taxAmount: number): NamedSaleTax[] {
  const target = round2(Number(taxAmount) || 0)
  if (!(target > 0)) return []
  const kept = parts.filter(p => Number(p.amount) > 0).map(p => ({ name: p.name, rate: Number(p.rate) || 0, amount: Number(p.amount) }))
  const sum = kept.reduce((a, p) => a + p.amount, 0)
  if (!kept.length || sum <= 0) return []
  for (const p of kept) p.amount = round2((p.amount * target) / sum)
  const drift = round2(target - kept.reduce((a, p) => a + p.amount, 0))
  if (drift !== 0) {
    const biggest = [...kept].sort((a, b) => b.amount - a.amount)[0]
    biggest.amount = round2(biggest.amount + drift)
  }
  return kept
}
