// 10/12 (Nic) — GAM BOOKS, PHASE P6: MONEY OUT IS ONE RECORD
//
// gam-ledger-design-2026-10-12 §6 I, §11, §12, adapted to Nic's 10/12 answers
// (gam-nic-answers-2026-10-12):
//
//   L5  "those all sound like real expenses. just let bookkeeper/landlord
//        create custom labels or categories to charge things off to"
//       → no forced expense kinds. The landlord (or bookkeeper) makes and edits
//         their own expense AND income categories, and each category points at
//         an account in the company's fully editable chart. A category pointed
//         at an equity account ("Owner draw") stays off the Profit & Loss by
//         itself. GAM seeds sensible defaults (the old fixed lists become the
//         seed, not the list).
//       → money out is ONE record: an Expense. A bill is an unpaid expense;
//         filing a bank line creates or matches an expense; cash that never
//         touched the bank is logged by hand and never has to match a bank line.
//   L6  a repair closed with a cost: the landlord's choice (Books setting) —
//       an unpaid bill by itself, or a "Record as bill" button.
//   L19 bookkeepers filing money coming in: the landlord's choice per
//       bookkeeper. Money going out stays open to them.
//
// THIS FILE holds only what phase P6's money-out lane owns: categories,
// expense payments, bank lines going out matched to a record, the bookkeeper's
// money-in choice and the repair-bill choice. Vendors, loans and fixed assets
// are packages/shared/src/booksVendorsLoans.ts; the ledger's own lists are
// booksLedger.ts.
//
// Every list here is mirrored by a CHECK in migrations 20261014180000-180500;
// the API tests hold the two together (services/booksCategories.test.ts).
// Displayed values go through the *_LABEL maps, never the raw value. This file
// imports from booksLedger.ts only (which imports nothing), so there is no
// load-order cycle with index.ts.
import { LEDGER_REPORT_CATEGORIES } from './booksLedger'
import type { BooksAccountType, LedgerAccountRole, LedgerReportCategory } from './booksLedger'

// ─── Categories ─────────────────────────────────────────────────────────────

/** books_categories.direction: which way the money goes. */
export const BOOKS_CATEGORY_DIRECTIONS = ['expense', 'income'] as const
export type BooksCategoryDirection = typeof BOOKS_CATEGORY_DIRECTIONS[number]
export const BOOKS_CATEGORY_DIRECTION_LABEL: Record<BooksCategoryDirection, string> = {
  expense: 'Money out',
  income:  'Money in',
}

/**
 * The books_account_map kind each direction's categories are mapped under
 * (LEDGER_MAP_KINDS): map_value is the category's id, the account is where
 * that category's money posts from the map row's day on.
 */
export const BOOKS_CATEGORY_MAP_KIND = {
  expense: 'expense_category',
  income:  'income_category',
} as const satisfies Record<BooksCategoryDirection, string>
export type BooksCategoryMapKind = typeof BOOKS_CATEGORY_MAP_KIND[BooksCategoryDirection]

/**
 * books_categories.system_use: a category a GAM feature made or uses.
 * 'payroll' categories are filed by the payroll run itself and are kept off
 * the everyday pickers, where choosing one by hand would be a mistake. 'loan'
 * and 'fixed_asset' are for the Loans and Fixed assets pages' own categories
 * (booksVendorsLoans), which ARE offered.
 */
export const BOOKS_CATEGORY_SYSTEM_USES = ['payroll', 'loan', 'fixed_asset'] as const
export type BooksCategorySystemUse = typeof BOOKS_CATEGORY_SYSTEM_USES[number]
export const BOOKS_CATEGORY_SYSTEM_USE_LABEL: Record<BooksCategorySystemUse, string> = {
  payroll:     'Used by payroll',
  loan:        'Used by a loan',
  fixed_asset: 'Used by a fixed asset',
}
/** The system uses whose categories are never offered in an everyday category picker. */
export const BOOKS_CATEGORY_PICKER_HIDDEN_USES = ['payroll'] as const satisfies readonly BooksCategorySystemUse[]

/** The longest name a category may have. */
export const BOOKS_CATEGORY_NAME_MAX = 80

export interface BooksCategorySeed {
  /** books_categories.system_key — stable, never shown. */
  key: string
  /** What the category is called until the company renames it. */
  name: string
  /** The posting role whose account the category posts to until the company points it elsewhere. */
  role: LedgerAccountRole
  systemUse?: BooksCategorySystemUse
}

/**
 * GAM's starting expense categories. The first fifteen are the old fixed list
 * (EXPENSE_CATEGORIES in index.ts — services/booksCategories.test.ts holds them
 * equal, in order), each pointed at the chart account the design gives it (§5
 * category maps). The rest are the chart's other everyday expenses, the owner
 * taking money out (equity — never on the P&L), and what payroll leaves to
 * pay. The SQL seed (books_seed_categories(), migration 20261014180000, and
 * the newest migration that re-creates it — 20261014240100 added Work trade
 * labor) lists the same rows; the same test holds the two together.
 */
export const BOOKS_DEFAULT_EXPENSE_CATEGORIES = [
  { key: 'maintenance',         name: 'Maintenance',                role: 'repairs_maintenance' },
  { key: 'repairs',             name: 'Repairs',                    role: 'repairs_maintenance' },
  { key: 'utilities',           name: 'Utilities',                  role: 'utilities_expense' },
  { key: 'insurance',           name: 'Insurance',                  role: 'insurance' },
  { key: 'property_tax',        name: 'Property tax',               role: 'property_taxes' },
  { key: 'management',          name: 'Management',                 role: 'management_fees' },
  { key: 'supplies',            name: 'Supplies',                   role: 'supplies' },
  { key: 'landscaping',         name: 'Landscaping',                role: 'landscaping' },
  { key: 'professional',        name: 'Legal / professional',       role: 'professional_fees' },
  { key: 'mortgage_interest',   name: 'Mortgage interest',          role: 'mortgage_interest' },
  { key: 'hoa',                 name: 'HOA',                        role: 'hoa_fees' },
  { key: 'advertising',         name: 'Advertising',                role: 'advertising' },
  { key: 'lot_rent',            name: 'Lot rent',                   role: 'lot_rent_expense' },
  { key: 'bank_fees',           name: 'Bank fees / charges',        role: 'bank_fees' },
  { key: 'other',               name: 'Other',                      role: 'other_expenses' },
  { key: 'pest_control',        name: 'Pest control',               role: 'pest_control' },
  { key: 'accounting',          name: 'Accounting and bookkeeping', role: 'accounting_fees' },
  { key: 'software',            name: 'Software and subscriptions', role: 'software_subscriptions' },
  { key: 'vehicle_travel',      name: 'Vehicle and travel',         role: 'vehicle_travel' },
  { key: 'contractor_payments', name: 'Contractor payments',        role: 'contractor_payments' },
  { key: 'wages',               name: 'Wages paid outside payroll', role: 'payroll_expense' },
  { key: 'owner_draw',          name: 'Owner draw',                 role: 'owner_draws' },
  { key: 'payroll_take_home',   name: 'Payroll: take-home pay',     role: 'net_pay_payable',     systemUse: 'payroll' },
  { key: 'payroll_taxes',       name: 'Payroll: taxes owed',        role: 'payroll_liabilities', systemUse: 'payroll' },
  // 10/12 (Nic): extra work-trade hours the landlord paid by hand (check or
  // cash, Mark paid on the Work Trade page) are money out, so they are an
  // Expense — filed here, on the chart's Work-trade labor account. Migration
  // 20261014240100 adds it to the SQL seed and to every company already
  // seeded (services/workTradeBooksPay recordWorkTradeHoursPaidByHand).
  { key: 'work_trade_labor',    name: 'Work trade labor',           role: 'work_trade_labor' },
] as const satisfies readonly BooksCategorySeed[]

/**
 * GAM's starting income categories: the old fixed list (OTHER_INCOME_CATEGORIES
 * in index.ts), in order, each pointed at the design's account (§5). The owner
 * putting money in is equity and the proceeds of selling something sit in
 * suspense until classified — neither is income, so neither is on the P&L.
 */
export const BOOKS_DEFAULT_INCOME_CATEGORIES = [
  { key: 'laundry',               name: 'Laundry',               role: 'laundry_vending' },
  { key: 'vending',               name: 'Vending',               role: 'laundry_vending' },
  { key: 'storage',               name: 'Storage',               role: 'storage_fees' },
  { key: 'utility_reimbursement', name: 'Utility reimbursement', role: 'utility_other' },
  { key: 'late_fees',             name: 'Late fees',             role: 'late_fees' },
  { key: 'application_fees',      name: 'Application fees',      role: 'application_fees' },
  { key: 'pet_fees',              name: 'Pet fees',              role: 'pet_fees' },
  { key: 'parking',               name: 'Parking',               role: 'other_income' },
  { key: 'propane_fuel',          name: 'Propane / fuel',        role: 'utility_propane' },
  { key: 'insurance_claim',       name: 'Insurance claim',       role: 'other_income' },
  { key: 'tax_refund',            name: 'Tax refund',            role: 'other_income' },
  { key: 'sale_proceeds',         name: 'Sale proceeds',         role: 'suspense' },
  { key: 'owner_contribution',    name: 'Owner contribution',    role: 'owner_equity' },
  { key: 'interest',              name: 'Interest earned',       role: 'interest_earned' },
  { key: 'other',                 name: 'Other income',          role: 'other_income' },
] as const satisfies readonly BooksCategorySeed[]

export const BOOKS_DEFAULT_CATEGORIES: Record<BooksCategoryDirection, readonly BooksCategorySeed[]> = {
  expense: BOOKS_DEFAULT_EXPENSE_CATEGORIES,
  income:  BOOKS_DEFAULT_INCOME_CATEGORIES,
}

/** The role a category posts to when it names none of its own (a category the company made without picking an account). */
export const BOOKS_CATEGORY_FALLBACK_ROLE: Record<BooksCategoryDirection, LedgerAccountRole> = {
  expense: 'other_expenses',
  income:  'other_income',
}

/**
 * The account type that keeps a category's money on the Profit & Loss: an
 * expense category pointed at an expense account, an income category at an
 * income account. Pointed anywhere else (an owner draw at equity, payroll's
 * take-home pay at a liability, a purchase at an asset) its money is real
 * money out or in, but not a cost or earnings of the business.
 */
export const BOOKS_CATEGORY_PL_TYPE: Record<BooksCategoryDirection, BooksAccountType> = {
  expense: 'expense',
  income:  'income',
}

/** True when a category pointed at an account of `accountType` counts on the Profit & Loss. */
export function booksCategoryOnProfitAndLoss(direction: BooksCategoryDirection, accountType: string | null | undefined): boolean {
  return accountType === BOOKS_CATEGORY_PL_TYPE[direction]
}

/**
 * The category word the older reports know (landlord_expenses.category /
 * landlord_other_income.category — they group by the old fixed lists): a
 * seeded category keeps its own key, any other category reads as 'other'
 * there. The category's real name is books_categories.name.
 */
export function booksCategoryLegacyKey(direction: BooksCategoryDirection, systemKey: string | null | undefined): string {
  const seeds = direction === 'expense' ? BOOKS_LEGACY_EXPENSE_KEYS : BOOKS_LEGACY_INCOME_KEYS
  return systemKey && (seeds as readonly string[]).includes(systemKey) ? systemKey : 'other'
}
/** The old fixed expense list (EXPENSE_CATEGORIES): the first fifteen seeds. */
export const BOOKS_LEGACY_EXPENSE_KEYS = BOOKS_DEFAULT_EXPENSE_CATEGORIES.slice(0, 15).map(c => c.key)
/** The old fixed income list (OTHER_INCOME_CATEGORIES): every income seed. */
export const BOOKS_LEGACY_INCOME_KEYS = BOOKS_DEFAULT_INCOME_CATEGORIES.map(c => c.key)

/**
 * The report category a category's ledger lines carry
 * (ledger_posting_lines.report_category): an expense category its own old key
 * when it is one of the old fixed list, else 'other'; an income category
 * 'other_income' when it is on the P&L, else 'not_income'.
 */
export function booksCategoryReportCategory(
  direction: BooksCategoryDirection, systemKey: string | null | undefined, onProfitAndLoss: boolean,
): LedgerReportCategory {
  if (direction === 'income') return onProfitAndLoss ? 'other_income' : 'not_income'
  const key = booksCategoryLegacyKey('expense', systemKey)
  return ((LEDGER_REPORT_CATEGORIES as readonly string[]).includes(key) ? key : 'other') as LedgerReportCategory
}

/**
 * ledger_posting_lines.expense_kind on a money-out line: the TYPE of account
 * the expense's category charges to — derived, never chosen (Nic L5: no forced
 * kinds). Reports count a cash line toward expenses only when it is 'expense'.
 */
export const MONEY_OUT_LINE_KINDS = ['asset', 'liability', 'equity', 'income', 'expense'] as const
export type MoneyOutLineKind = typeof MONEY_OUT_LINE_KINDS[number]

// ─── Expense payments ───────────────────────────────────────────────────────

/**
 * landlord_expense_payments.method — how a payment toward an expense was made,
 * and so where the money came from on the books:
 *   bank        out of a linked bank account (a bank line pays it, or will)
 *   check       a check written; it clears when the bank line arrives
 *   card        a credit card (owed to the card until the card is paid)
 *   cash        cash from the office drawer
 *   owner_paid  the owner paid it personally (money the owner put in)
 *   other       paid before GAM recorded how (expenses logged before 10/12,
 *               old Books bills and transactions) — sits "to classify" until
 *               someone says how
 */
export const LANDLORD_EXPENSE_PAYMENT_METHODS = ['bank', 'check', 'card', 'cash', 'owner_paid', 'other'] as const
export type LandlordExpensePaymentMethod = typeof LANDLORD_EXPENSE_PAYMENT_METHODS[number]
export const LANDLORD_EXPENSE_PAYMENT_METHOD_LABEL: Record<LandlordExpensePaymentMethod, string> = {
  bank:       'From the bank',
  check:      'Check',
  card:       'Credit card',
  cash:       'Cash from the office',
  owner_paid: 'Paid personally by the owner',
  other:      'Paid (how was not recorded)',
}
/** The methods a person picks when recording a payment by hand. */
export const LANDLORD_EXPENSE_PAYMENT_METHODS_ENTERED = ['cash', 'check', 'card', 'owner_paid', 'bank'] as const satisfies readonly LandlordExpensePaymentMethod[]

/**
 * landlord_expense_payments.source:
 *   payment     recorded by a person (or a GAM feature) as it happened
 *   bank_match  a bank line filed or matched to the expense
 *   migrated    written when money out became one record (10/12): one per
 *               expense logged before, and one per old Books bill payment
 */
export const LANDLORD_EXPENSE_PAYMENT_SOURCES = ['payment', 'bank_match', 'migrated'] as const
export type LandlordExpensePaymentSource = typeof LANDLORD_EXPENSE_PAYMENT_SOURCES[number]

/** An expense's state, worked out from its payments (v_expense_balance). */
export const EXPENSE_PAY_STATES = ['unpaid', 'partial', 'paid'] as const
export type ExpensePayState = typeof EXPENSE_PAY_STATES[number]
export const EXPENSE_PAY_STATE_LABEL: Record<ExpensePayState, string> = {
  unpaid:  'Unpaid',
  partial: 'Partly paid',
  paid:    'Paid',
}

/**
 * How an expense is entered on the Expenses page: paid now (and how), or a
 * bill — owed, not paid yet, with a due date.
 */
export const EXPENSE_ENTRY_PAID_NOW = 'paid' as const
export const EXPENSE_ENTRY_BILL = 'bill' as const

/** landlord_expenses.migrated_from_table / landlord_other_income.migrated_from_table. */
export const MONEY_OUT_MIGRATED_FROM_TABLES = ['books_bills', 'books_transactions'] as const
export type MoneyOutMigratedFromTable = typeof MONEY_OUT_MIGRATED_FROM_TABLES[number]
export const MONEY_OUT_MIGRATED_FROM_LABEL: Record<MoneyOutMigratedFromTable, string> = {
  books_bills:        'Moved from GAM Books Bills',
  books_transactions: 'Moved from GAM Books Transactions',
}

/** How many days either side of a bank line an open expense may sit and still be offered as its match (design §12). */
export const EXPENSE_MATCH_WINDOW_DAYS = 7
/** The most open expenses one bank line is matched to at once. */
export const EXPENSE_MATCH_MAX = 20

// ─── Bank lines going out, matched to a record ──────────────────────────────

/**
 * bank_transactions.matched_kind — what a money-OUT bank line was matched to
 * (status 'matched'). Money GAM sends or records already has its record; the
 * bank line matches it and never makes an expense of its own (design §12).
 *   expenses     one or several open expenses (their payments name the line)
 *   gam_debit    GAM's fee debit
 *   pos_refund   a register refund paid by check
 *   refund_part  a refund to a tenant or guest paid by check
 *   transfer     money moved to another of the company's linked accounts
 *   loan_payment 10/12 (Nic): a payment on one of the company's loans — the
 *                loan payment (principal / interest / escrow) names the line
 *                (books_loan_payments.bank_transaction_id) and is what posts
 */
export const BANK_OUT_MATCH_KINDS = ['expenses', 'gam_debit', 'pos_refund', 'refund_part', 'transfer', 'loan_payment'] as const
export type BankOutMatchKind = typeof BANK_OUT_MATCH_KINDS[number]
export const BANK_OUT_MATCH_KIND_LABEL: Record<BankOutMatchKind, string> = {
  expenses:     'Expenses you logged',
  gam_debit:    'GAM fees taken from your bank',
  pos_refund:   'A register refund by check',
  refund_part:  'A refund check to a tenant or guest',
  transfer:     'A transfer between your accounts',
  loan_payment: 'A payment on your loan',
}
/** The order a money-out line's matches are offered in (design §12). */
export const BANK_OUT_MATCH_ORDER: readonly BankOutMatchKind[] = ['expenses', 'gam_debit', 'pos_refund', 'refund_part', 'transfer', 'loan_payment']

/**
 * 10/12 (Nic): what a money-IN bank line can be matched to on the same
 * panel (bank_transactions.matched_kind, status 'matched'):
 *   loan_funding a loan's money arriving in the bank account it was made
 *                into (books_loans.funded_bank_transaction_id names the line;
 *                the loan is what posts). Never filed as income.
 * A bookkeeper matches one only as the owner chose for them (Nic L19).
 */
export const BANK_IN_MATCH_KINDS = ['loan_funding'] as const
export type BankInMatchKind = typeof BANK_IN_MATCH_KINDS[number]
/** Every value bank_transactions.matched_kind takes (its CHECK). */
export const BANK_LINE_MATCH_KINDS = [...BANK_OUT_MATCH_KINDS, ...BANK_IN_MATCH_KINDS] as const
export type BankLineMatchKind = typeof BANK_LINE_MATCH_KINDS[number]
export const BANK_LINE_MATCH_KIND_LABEL: Record<BankLineMatchKind, string> = {
  ...BANK_OUT_MATCH_KIND_LABEL,
  loan_funding: 'Money from your loan arriving',
}

/**
 * 10/12 review (Nic L5, design §12 "match first"): the error code the Bank
 * page's filing (categorize / split) answers with (409) when a money-out line
 * fits something already on record to the cent — an open bill, a check
 * written, GAM's fee debit, a refund check, a transfer or a loan payment —
 * with the fits beside it (`matches`). Filed as a new expense anyway, the
 * same money would count twice (an open bill left owed, GAM's fees expensed
 * twice). The person matches it, or says it is none of them (`notAMatch`).
 */
export const BANK_MATCH_FIRST_CODE = 'MATCH_FIRST'

// ─── Bookkeepers and money coming in (Nic L19) ──────────────────────────────

/**
 * bookkeeper_scopes.money_in_filing — what a bookkeeper may file of the money
 * COMING IN on the bank feed, the owner's choice per bookkeeper. A deposit
 * filed or ignored leaves the rent queue, so a tenant's rent filed as "other
 * income" stays open on the tenant's account and late fees follow:
 *   any             file any deposit
 *   after_not_rent  only a deposit the owner marked "Not rent" (the default —
 *                   design §11; "Not rent" is the owner's to mark)
 *   never           never file money coming in
 * Money going out is always open to a bookkeeper with the bank (the
 * company-wide box). A bookkeeper never records a tenant's payment, matches a
 * deposit to a tenant's bill or marks one "Not rent".
 */
export const BOOKKEEPER_MONEY_IN_FILING = ['any', 'after_not_rent', 'never'] as const
export type BookkeeperMoneyInFiling = typeof BOOKKEEPER_MONEY_IN_FILING[number]
export const BOOKKEEPER_MONEY_IN_FILING_LABEL: Record<BookkeeperMoneyInFiling, string> = {
  any:            'May file any deposit',
  after_not_rent: 'Only deposits marked "Not rent"',
  never:          'Never files money coming in',
}
export const DEFAULT_BOOKKEEPER_MONEY_IN_FILING: BookkeeperMoneyInFiling = 'after_not_rent'

// ─── Repairs closed with a cost (Nic L6) ────────────────────────────────────

/**
 * landlords.books_repair_bills — what a repair closed with a cost does, the
 * owner's choice on the Books settings page. NULL = not chosen yet: nothing
 * is made by itself and the button is offered.
 *   automatic  an unpaid bill (an expense) for the cost, made when the repair
 *              is completed, kept in step while it is unpaid
 *   button     only when someone presses "Record as bill"
 */
export const BOOKS_REPAIR_BILL_MODES = ['automatic', 'button'] as const
export type BooksRepairBillMode = typeof BOOKS_REPAIR_BILL_MODES[number]
export const BOOKS_REPAIR_BILL_MODE_LABEL: Record<BooksRepairBillMode, string> = {
  automatic: 'Make an unpaid bill by itself',
  button:    'Only when someone presses "Record as bill"',
}
