// 10/11 (Nic) — GAM Books: the ledger's, payroll's and payables' allowed
// values and the few pieces of arithmetic both the API and the Books screens
// do, said once.
//
// Why this file exists: Add Employee, Add Contractor and Add Vendor could not
// save. The screens offered values the API refused ('married_higher'; 'llc',
// 's_corp', 'c_corp', 'partnership' against individual|business; 'prepaid'
// against 'cod'), because each side kept its own list. And the payroll preview
// guessed 80 hours for every pay frequency while the server used 40 for weekly
// and 80 for everything else, so the preview and the run disagreed. Now
// routes/books.ts validates against these lists and the Books screens build
// their pickers from them; the hours, the Social Security wage base and the
// normal-balance sign come from the functions here on both sides.
//
// Displayed values go through the *_LABEL maps, never the raw value.
// This file imports nothing from index.ts (index.ts re-exports it), so there is
// no load-order cycle.

// ─── Chart of accounts ───────────────────────────────────────────────────────

/** books_accounts.type. Mirrors books_accounts_type_check. */
export const BOOKS_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const
export type BooksAccountType = typeof BOOKS_ACCOUNT_TYPES[number]
export const BOOKS_ACCOUNT_TYPE_LABEL: Record<BooksAccountType, string> = {
  asset:     'Asset',
  liability: 'Liability',
  equity:    'Equity',
  income:    'Income',
  expense:   'Expense',
}

/** The types a debit raises. A credit raises every other type. */
export const BOOKS_DEBIT_NORMAL_ACCOUNT_TYPES = ['asset', 'expense'] as const satisfies readonly BooksAccountType[]

/**
 * An account's balance the way people read it.
 *
 * books_accounts.balance is stored as debits minus credits whatever the type —
 * one rule for every posting, so the stored figures of a balanced ledger add up
 * to zero. Read that way, money owed (a liability), the owner's equity and
 * income earned all show as negative numbers. This turns the stored figure into
 * the account's normal sign: an asset or expense as stored, a liability, equity
 * or income account flipped.
 */
export function booksNormalBalance(type: string, storedBalance: number | string | null | undefined): number {
  const stored = Number(storedBalance) || 0
  const shown = (BOOKS_DEBIT_NORMAL_ACCOUNT_TYPES as readonly string[]).includes(type) ? stored : -stored
  // Whole cents, and never "-$0.00".
  const cents = Math.round(shown * 100)
  return cents === 0 ? 0 : cents / 100
}

// ─── Cash transactions and journal entries ───────────────────────────────────

/** books_transactions.type: money in or money out. */
export const BOOKS_TRANSACTION_TYPES = ['income', 'expense'] as const
export type BooksTransactionType = typeof BOOKS_TRANSACTION_TYPES[number]
export const BOOKS_TRANSACTION_TYPE_LABEL: Record<BooksTransactionType, string> = {
  income:  'Income',
  expense: 'Expense',
}

/**
 * journal_entries.type. Mirrors journal_entries_type_check. An entry of any
 * other type is refused rather than stored as a label nothing reads.
 *
 * 10/12 (Nic, GAM Books ledger): a bookkeeper's adjusting entry (a month-end
 * accrual or reclass on top of the automatic postings) and a reversing entry
 * (one that takes back an earlier entry, journal_entries.reverses_entry_id)
 * are kinds of their own, so the general ledger can tell them from an
 * ordinary hand entry. Automatic postings never go into journal_entries — they
 * live in ledger_postings.
 */
export const BOOKS_JOURNAL_ENTRY_TYPES = ['manual', 'adjusting', 'reversing'] as const
export type BooksJournalEntryType = typeof BOOKS_JOURNAL_ENTRY_TYPES[number]
export const BOOKS_JOURNAL_ENTRY_TYPE_LABEL: Record<BooksJournalEntryType, string> = {
  manual:    'Journal entry',
  adjusting: 'Adjusting entry',
  reversing: 'Reversing entry',
}

/**
 * A dollar amount as whole cents. Debits and credits are added and compared as
 * integers: summed as decimals, 0.1 + 0.2 is not 0.3, and a one-cent imbalance
 * hid inside the old "within a cent" tolerance.
 */
export function booksCents(amount: number | string | null | undefined): number {
  return Math.round((Number(amount) || 0) * 100)
}

// ─── Payroll ─────────────────────────────────────────────────────────────────

/** books_employees.pay_type. */
export const BOOKS_PAY_TYPES = ['hourly', 'salary'] as const
export type BooksPayType = typeof BOOKS_PAY_TYPES[number]
export const BOOKS_PAY_TYPE_LABEL: Record<BooksPayType, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
}

/** books_employees.pay_frequency and payroll_runs.pay_frequency. */
export const BOOKS_PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
export type BooksPayFrequency = typeof BOOKS_PAY_FREQUENCIES[number]
export const BOOKS_PAY_FREQUENCY_LABEL: Record<BooksPayFrequency, string> = {
  weekly:      'Weekly',
  biweekly:    'Every two weeks',
  semimonthly: 'Twice a month',
  monthly:     'Monthly',
}
export const BOOKS_PAY_PERIODS_PER_YEAR: Record<BooksPayFrequency, number> = {
  weekly:      52,
  biweekly:    26,
  semimonthly: 24,
  monthly:     12,
}

/** A full-time year: 40 hours × 52 weeks. */
export const BOOKS_FULL_TIME_HOURS_PER_YEAR = 2080

/**
 * The hours an hourly employee is paid for when the person running payroll
 * enters none: a full-time year spread over the pay periods — weekly 40,
 * every two weeks 80, twice a month 86.67, monthly 173.33. The server's run and
 * the Run Payroll preview both call this, so the preview shows what the run
 * will pay.
 */
export function booksDefaultHours(frequency: BooksPayFrequency): number {
  const periods = BOOKS_PAY_PERIODS_PER_YEAR[frequency]
  if (!periods) throw new Error(`Unknown pay frequency: ${frequency}`)
  return Math.round((BOOKS_FULL_TIME_HOURS_PER_YEAR / periods) * 100) / 100
}

/**
 * books_employees.filing_status — the W-4 Step 1(c) boxes. GAM does not
 * compute income-tax withholding (S592: the bookkeeper enters it), so this is
 * kept for the employee's record.
 */
export const BOOKS_EMPLOYEE_FILING_STATUSES = ['single', 'married', 'head_of_household'] as const
export type BooksEmployeeFilingStatus = typeof BOOKS_EMPLOYEE_FILING_STATUSES[number]
export const BOOKS_EMPLOYEE_FILING_STATUS_LABEL: Record<BooksEmployeeFilingStatus, string> = {
  single:            'Single or married filing separately',
  married:           'Married filing jointly',
  head_of_household: 'Head of household',
}

/**
 * The Social Security wage base by calendar year: the most of one employee's
 * wages in a year that the 6.2% Social Security tax applies to. Federal, the
 * same for every employer — set by the Social Security Administration each
 * fall for the next year.
 *
 * ANNUAL REFRESH: add next year's figure when the SSA announces it (October).
 * Until it is added, a year past the table uses the latest year known.
 */
export const SOCIAL_SECURITY_WAGE_BASE_BY_YEAR: Readonly<Record<number, number>> = {
  2024: 168600,
  2025: 176100,
  2026: 184500,
}

/**
 * 10/12 (Nic, ledger P7): the federal payroll tax rates GAM works out itself.
 * S592: GAM computes only what is the same fixed rate for every employer —
 * Social Security (6.2% up to the year's wage base, paid by the employee AND
 * matched by the employer) and Medicare (1.45% each; the 0.9% Additional
 * Medicare Tax on wages over $200,000 is the employee's alone). Income-tax
 * withholding and the unemployment taxes (FUTA, SUTA — the rate an employer
 * pays depends on its state and its own record) are the bookkeeper's figures.
 */
export const SOCIAL_SECURITY_TAX_RATE = 0.062
export const MEDICARE_TAX_RATE = 0.0145
export const ADDITIONAL_MEDICARE_TAX_RATE = 0.009
export const ADDITIONAL_MEDICARE_WAGE_THRESHOLD = 200000

/**
 * 10/12 (Nic, ledger P7): what the EMPLOYER owes for Social Security and
 * Medicare on one paycheck, recorded on the payroll line itself (it used to be
 * worked out only on the Tax Center, from the year's totals). `ytdGrossBefore`
 * is the employee's pay earlier in the pay date's calendar year. The employer's
 * Social Security matches the employee's to the cent (same rate, same wage
 * base); its Medicare is 1.45% of the whole check.
 */
export function booksEmployerFica(grossPay: number, ytdGrossBefore: number, ssWageBase: number): { employerSs: number; employerMedicare: number } {
  const ssEligible = Math.max(0, Math.min(grossPay, ssWageBase - ytdGrossBefore))
  return {
    employerSs: +(ssEligible * SOCIAL_SECURITY_TAX_RATE).toFixed(2),
    employerMedicare: +(grossPay * MEDICARE_TAX_RATE).toFixed(2),
  }
}

/** payroll_runs.status. Mirrors payroll_runs_status_check (migration 20261014200100). */
export const BOOKS_PAYROLL_RUN_STATUSES = ['draft', 'approved', 'voided'] as const
export type BooksPayrollRunStatus = typeof BOOKS_PAYROLL_RUN_STATUSES[number]
export const BOOKS_PAYROLL_RUN_STATUS_LABEL: Record<BooksPayrollRunStatus, string> = {
  draft:    'Draft',
  approved: 'Approved',
  voided:   'Voided',
}

/** The Social Security wage base for `year` (the latest known year past the table). */
export function socialSecurityWageBase(year: number): number {
  const known = SOCIAL_SECURITY_WAGE_BASE_BY_YEAR[year]
  if (known !== undefined) return known
  const years = Object.keys(SOCIAL_SECURITY_WAGE_BASE_BY_YEAR).map(Number).sort((a, b) => a - b)
  return SOCIAL_SECURITY_WAGE_BASE_BY_YEAR[years[years.length - 1]]
}

// 10/12 (Nic, ledger P6): contractors (W-9 classifications, pay units) and
// vendors (payment terms) moved to booksVendorsLoans.ts — one list of everyone
// the company pays.

// ─── Bills ───────────────────────────────────────────────────────────────────

/**
 * books_bill_payments.source. Mirrors books_bill_payments_source_check.
 * 'payment' is recorded by the pay route as it happens; 'backfill' was rebuilt
 * from a bill paid before payments had rows of their own (10/11), dated the
 * best day known.
 */
export const BOOKS_BILL_PAYMENT_SOURCES = ['payment', 'backfill'] as const
export type BooksBillPaymentSource = typeof BOOKS_BILL_PAYMENT_SOURCES[number]

// ═════════════════════════════════════════════════════════════════════════════
// THE AUTOMATIC LEDGER (10/12, Nic — "GAM Books replaces QuickBooks")
// ═════════════════════════════════════════════════════════════════════════════
//
// Every money event posts its own balanced lines into ledger_postings /
// ledger_posting_lines, tagged with its property, rebuildable from the source
// rows (gam-ledger-design-2026-10-12 §3-§9, §13-§14). This block is the one
// definition of every allowed value the engine and its tables use; each list
// is mirrored by a CHECK in the 20261013200xxx migrations, and the API tests
// hold the two together.
//
// Nic's 10/12 answers that shape it:
//   - Posted within about a minute of the money event (a drain every minute,
//     plus a kick right after a money write commits) and a nightly tie-out.
//   - The chart of accounts is FULLY EDITABLE: a company may rename, add and
//     delete accounts. Automatic postings therefore never name an account; they
//     name a POSTING ROLE ("tenant receivables", "late fees"), and the company's
//     books_account_map says which account that role posts to today. GAM seeds
//     the map; the company may repoint it. A repoint applies to postings dated
//     from the day it is made — history stays where it was posted.
//   - Closing a month is optional and the owner decides who may close and who
//     may reopen (books_close_by / books_reopen_by).
//   - A fix to a month that is still open: the owner's choice per company —
//     change that month (restate) or show it on the day it was made (day_made).
//     After a month is closed, a fix always lands in the first open month,
//     labeled as a correction.
//   - Received leads the Profit & Loss (reports come in a later phase).

/** Nic 10/12 (L2): the P&L leads with money received; Charged sits beside it. */
export const LEDGER_PL_LEAD_COLUMN = 'received' as const

// ─── Posting roles (the automatic chart) ─────────────────────────────────────

/**
 * One posting role: what an automatic line books to, and the account GAM seeds
 * for it (code, name, type). `control`: the account carries a balance GAM can
 * prove from the money records (receivables, money GAM holds, deposits owed),
 * so a hand journal line is refused on the account a control role maps to.
 * `parent`: the seeded account sits under the parent role's account.
 * `computed`: the role is never posted to (retained earnings is worked out).
 *
 * Codes are suggestions — a company may renumber or rename any account; the map
 * keeps working. 5155 is GAM's platform fees because 5150 is already
 * "Software & Subscriptions". Names stay neutral and never name a tenant
 * product (CLAUDE.md, FlexSuite siloing).
 */
export const LEDGER_ACCOUNT_ROLE_DEFS = [
  // Assets
  { role: 'bank_checking',               code: '1010', name: 'Checking',                                          type: 'asset',     control: false },
  { role: 'bank_savings',                code: '1020', name: 'Savings',                                           type: 'asset',     control: false },
  { role: 'own_deposit_account',         code: '1030', name: 'Security deposit account (your own)',               type: 'asset',     control: false },
  { role: 'undeposited_funds',           code: '1040', name: 'Undeposited funds (drawer and desk receipts)',      type: 'asset',     control: true },
  { role: 'deposits_in_transit',         code: '1045', name: 'Deposits in transit',                               type: 'asset',     control: true },
  { role: 'due_from_gam',                code: '1050', name: 'Due from GAM: payable to you',                      type: 'asset',     control: true },
  { role: 'due_from_gam_tenant_money',   code: '1055', name: 'Due from GAM: tenant money GAM holds',              type: 'asset',     control: true },
  { role: 'stripe_in_transit',           code: '1060', name: 'Stripe balance, on its way to your bank',           type: 'asset',     control: true },
  { role: 'deposits_gam_holds',          code: '1070', name: 'Deposits GAM holds for you',                        type: 'asset',     control: true },
  { role: 'suspense',                    code: '1099', name: 'Suspense: to classify',                             type: 'asset',     control: false },
  { role: 'ar_tenants',                  code: '1100', name: 'Accounts receivable: tenants',                      type: 'asset',     control: true },
  { role: 'ar_store_accounts',           code: '1120', name: 'Accounts receivable: store charge accounts',        type: 'asset',     control: true },
  { role: 'prepaid_expenses',            code: '1200', name: 'Prepaid expenses and vendor credit',                type: 'asset',     control: false },
  { role: 'inventory',                   code: '1210', name: 'Inventory',                                         type: 'asset',     control: false },
  // 10/12 (Nic, ledger P6): the escrow part of each loan payment — money the
  // lender holds to pay property tax and insurance (the Loans page).
  { role: 'loan_escrow',                 code: '1250', name: 'Escrow held by your lender',                        type: 'asset',     control: false },
  { role: 'home_notes_receivable',       code: '1310', name: 'Home-sale notes receivable',                        type: 'asset',     control: true },
  { role: 'rental_property',             code: '1500', name: 'Rental property',                                   type: 'asset',     control: false },
  { role: 'accumulated_depreciation',    code: '1510', name: 'Accumulated depreciation',                          type: 'asset',     control: false },
  { role: 'homes_held_for_sale',         code: '1520', name: 'Homes held for sale',                               type: 'asset',     control: false },
  { role: 'equipment',                   code: '1530', name: 'Equipment',                                         type: 'asset',     control: false },
  // Liabilities
  { role: 'accounts_payable',            code: '2010', name: 'Accounts payable',                                  type: 'liability', control: true },
  { role: 'outstanding_checks',          code: '2015', name: 'Outstanding checks and debits',                     type: 'liability', control: true },
  { role: 'security_deposits_payable',   code: '2020', name: 'Security deposits payable',                         type: 'liability', control: true },
  { role: 'payroll_liabilities',         code: '2030', name: 'Payroll liabilities',                               type: 'liability', control: false },
  { role: 'payroll_federal_withholding', code: '2031', name: 'Payroll liabilities: federal withholding',          type: 'liability', control: false, parent: 'payroll_liabilities' },
  { role: 'payroll_state_withholding',   code: '2032', name: 'Payroll liabilities: state withholding',            type: 'liability', control: false, parent: 'payroll_liabilities' },
  { role: 'payroll_fica',                code: '2033', name: 'Payroll liabilities: Social Security and Medicare', type: 'liability', control: false, parent: 'payroll_liabilities' },
  // 10/12 (Nic, ledger P7): the employer's unemployment taxes are recorded on
  // every payroll run (FUTA federal, SUTA state) and owed until paid, each on
  // its own liability like the other payroll taxes.
  { role: 'payroll_futa',                code: '2034', name: 'Payroll liabilities: federal unemployment tax',     type: 'liability', control: false, parent: 'payroll_liabilities' },
  { role: 'net_pay_payable',             code: '2035', name: 'Net pay payable',                                   type: 'liability', control: false },
  { role: 'payroll_suta',                code: '2036', name: 'Payroll liabilities: state unemployment tax',       type: 'liability', control: false, parent: 'payroll_liabilities' },
  { role: 'sales_tax_payable',           code: '2040', name: 'Sales tax payable',                                 type: 'liability', control: false },
  { role: 'lodging_tax_payable',         code: '2042', name: 'Lodging tax payable',                               type: 'liability', control: false },
  { role: 'utility_tax_payable',         code: '2045', name: 'Utility tax payable',                               type: 'liability', control: false },
  { role: 'tenant_prepayments',          code: '2050', name: 'Tenant prepayments (paid ahead)',                   type: 'liability', control: true },
  { role: 'guest_deposits',              code: '2060', name: 'Guest deposits, not yet earned',                    type: 'liability', control: true },
  { role: 'due_to_gam',                  code: '2080', name: 'Due to GAM',                                        type: 'liability', control: true },
  { role: 'equipment_owed_to_gam',       code: '2085', name: 'Equipment owed to GAM, not yet billed',             type: 'liability', control: true },
  { role: 'mortgage_payable',            code: '2100', name: 'Mortgage payable',                                  type: 'liability', control: false },
  { role: 'credit_card_payable',         code: '2110', name: 'Credit card payable',                               type: 'liability', control: false },
  // Equity
  { role: 'owner_equity',                code: '3010', name: 'Owner equity and contributions',                    type: 'equity',    control: false },
  { role: 'owner_draws',                 code: '3020', name: 'Owner draws',                                       type: 'equity',    control: false },
  { role: 'retained_earnings',           code: '3030', name: 'Retained earnings',                                 type: 'equity',    control: false, computed: true },
  { role: 'opening_balance_equity',      code: '3900', name: 'Opening balance equity',                            type: 'equity',    control: false },
  { role: 'interproperty_clearing',      code: '3950', name: 'Inter-property clearing',                           type: 'equity',    control: true },
  // Income
  { role: 'space_rent',                  code: '4010', name: 'Space and lot rent',                                type: 'income',    control: false },
  { role: 'late_fees',                   code: '4020', name: 'Late fees',                                         type: 'income',    control: false },
  { role: 'application_fees',            code: '4030', name: 'Application fees',                                  type: 'income',    control: false },
  { role: 'pet_fees',                    code: '4040', name: 'Pet fees',                                          type: 'income',    control: false },
  { role: 'laundry_vending',             code: '4050', name: 'Laundry and vending',                               type: 'income',    control: false },
  { role: 'storage_fees',                code: '4060', name: 'Storage',                                           type: 'income',    control: false },
  { role: 'utility_reimbursements',      code: '4070', name: 'Utility reimbursements',                            type: 'income',    control: false },
  { role: 'utility_electric',            code: '4071', name: 'Utility reimbursements: electric',                  type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_water',               code: '4072', name: 'Utility reimbursements: water',                     type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_sewer',               code: '4073', name: 'Utility reimbursements: sewer',                     type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_gas',                 code: '4074', name: 'Utility reimbursements: gas',                       type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_trash',               code: '4075', name: 'Utility reimbursements: trash',                     type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_propane',             code: '4076', name: 'Utility reimbursements: propane',                   type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'utility_other',               code: '4079', name: 'Utility reimbursements: other',                     type: 'income',    control: false, parent: 'utility_reimbursements' },
  { role: 'other_fees',                  code: '4080', name: 'Other fees',                                        type: 'income',    control: false },
  { role: 'credits_given',               code: '4095', name: 'Credits given',                                     type: 'income',    control: false },
  { role: 'work_trade_discount',         code: '4096', name: 'Work-trade discount',                               type: 'income',    control: false },
  { role: 'home_sales',                  code: '4300', name: 'Home sales',                                        type: 'income',    control: false },
  { role: 'home_note_interest',          code: '4310', name: 'Interest on home notes',                            type: 'income',    control: false },
  { role: 'stay_income',                 code: '4400', name: 'Stay income',                                       type: 'income',    control: false },
  { role: 'register_sales',              code: '4500', name: 'Register sales',                                    type: 'income',    control: false },
  { role: 'sales_returns',               code: '4520', name: 'Sales returns',                                     type: 'income',    control: false },
  { role: 'deposit_deductions_kept',     code: '4800', name: 'Deposit deductions kept',                           type: 'income',    control: false },
  { role: 'other_income',                code: '4900', name: 'Other income',                                      type: 'income',    control: false },
  { role: 'interest_earned',             code: '4910', name: 'Interest earned',                                   type: 'income',    control: false },
  // Expenses
  { role: 'mortgage_interest',           code: '5010', name: 'Mortgage and loan interest',                        type: 'expense',   control: false },
  { role: 'property_taxes',              code: '5020', name: 'Property taxes',                                    type: 'expense',   control: false },
  { role: 'insurance',                   code: '5030', name: 'Property insurance',                                type: 'expense',   control: false },
  { role: 'repairs_maintenance',         code: '5040', name: 'Repairs and maintenance',                           type: 'expense',   control: false },
  { role: 'utilities_expense',           code: '5050', name: 'Utilities',                                         type: 'expense',   control: false },
  { role: 'landscaping',                 code: '5060', name: 'Landscaping',                                       type: 'expense',   control: false },
  { role: 'pest_control',                code: '5070', name: 'Pest control',                                      type: 'expense',   control: false },
  { role: 'management_fees',             code: '5080', name: 'Management fees',                                   type: 'expense',   control: false },
  { role: 'advertising',                 code: '5090', name: 'Advertising and marketing',                         type: 'expense',   control: false },
  { role: 'professional_fees',           code: '5100', name: 'Legal and professional fees',                       type: 'expense',   control: false },
  { role: 'accounting_fees',             code: '5110', name: 'Accounting and bookkeeping',                        type: 'expense',   control: false },
  { role: 'processing_fees',             code: '5115', name: 'Processing fees you pay',                           type: 'expense',   control: false },
  { role: 'chargeback_fees',             code: '5116', name: 'Chargeback and return fees',                        type: 'expense',   control: false },
  // 10/12 (Nic, G10): "a refunded card sale gives the fee back and the landlord
  // eats it" — the card fee a customer gets back with a refund is the
  // landlord's cost, shown as its own expense line (ledger P5).
  { role: 'card_fees_refunded',          code: '5117', name: 'Card fees refunded',                                type: 'expense',   control: false },
  { role: 'payroll_expense',             code: '5120', name: 'Payroll',                                           type: 'expense',   control: false },
  { role: 'employer_payroll_taxes',      code: '5125', name: 'Employer payroll taxes',                            type: 'expense',   control: false },
  { role: 'contractor_payments',         code: '5130', name: 'Contractor payments',                               type: 'expense',   control: false },
  { role: 'supplies',                    code: '5140', name: 'Supplies',                                          type: 'expense',   control: false },
  { role: 'software_subscriptions',      code: '5150', name: 'Software and subscriptions',                        type: 'expense',   control: false },
  { role: 'gam_platform_fees',           code: '5155', name: 'GAM platform fees',                                 type: 'expense',   control: false },
  { role: 'vehicle_travel',              code: '5160', name: 'Vehicle and travel',                                type: 'expense',   control: false },
  { role: 'depreciation_expense',        code: '5170', name: 'Depreciation',                                      type: 'expense',   control: false },
  { role: 'bad_debt',                    code: '5180', name: 'Bad debt',                                          type: 'expense',   control: false },
  { role: 'work_trade_labor',            code: '5190', name: 'Work-trade labor',                                  type: 'expense',   control: false },
  { role: 'cash_over_short',             code: '5195', name: 'Cash over and short',                               type: 'expense',   control: false },
  { role: 'lot_rent_expense',            code: '5200', name: 'Lot rent',                                          type: 'expense',   control: false },
  { role: 'hoa_fees',                    code: '5210', name: 'HOA fees',                                          type: 'expense',   control: false },
  { role: 'bank_fees',                   code: '5220', name: 'Bank fees',                                         type: 'expense',   control: false },
  { role: 'cost_of_goods_sold',          code: '5300', name: 'Cost of goods sold',                                type: 'expense',   control: false },
  { role: 'cost_of_homes_sold',          code: '5310', name: 'Cost of homes sold',                                type: 'expense',   control: false },
  { role: 'other_expenses',              code: '5900', name: 'Other expenses',                                    type: 'expense',   control: false },
] as const satisfies readonly {
  role: string; code: string; name: string; type: BooksAccountType; control: boolean; parent?: string; computed?: boolean
}[]

export type LedgerAccountRole = typeof LEDGER_ACCOUNT_ROLE_DEFS[number]['role']
export type LedgerAccountRoleDef = {
  role: LedgerAccountRole; code: string; name: string; type: BooksAccountType
  control: boolean; parent?: LedgerAccountRole; computed?: boolean
}
/** Every posting role, in chart order. Mirrors ledger_account_role_type() in the database. */
export const LEDGER_ACCOUNT_ROLES: readonly LedgerAccountRole[] = LEDGER_ACCOUNT_ROLE_DEFS.map(r => r.role)
export const LEDGER_ACCOUNT_ROLE_BY_NAME: Readonly<Record<LedgerAccountRole, LedgerAccountRoleDef>> =
  Object.fromEntries(LEDGER_ACCOUNT_ROLE_DEFS.map(r => [r.role, r as LedgerAccountRoleDef])) as Record<LedgerAccountRole, LedgerAccountRoleDef>
/** The roles whose account refuses hand journal lines. Mirrors ledger_account_role_is_control(). */
export const LEDGER_CONTROL_ROLES: readonly LedgerAccountRole[] = LEDGER_ACCOUNT_ROLE_DEFS.filter(r => r.control).map(r => r.role)

/**
 * books_account_map.map_kind — what a map row points from.
 *   role             a posting role (map_value = the role) → its account
 *   bank_connection  one linked bank (map_value = bank_connections.id) → its
 *                    own sub-account under Checking
 *   sales_tax        one named sales tax (map_value = the tax's name) → its
 *                    own sub-account under Sales tax payable
 */
// 10/12 (Nic, ledger P6): 'loan' — one loan on the Loans page (map_value =
// books_loans.id) → its own sub-account under Mortgage payable, so the balance
// sheet shows what is owed on each loan.
export const LEDGER_MAP_KINDS = ['role', 'bank_connection', 'sales_tax', 'loan',
  // 10/12 (Nic, ledger P6, L5): a category the landlord or bookkeeper made
  // (map_value = books_categories.id) → the account it charges to. A category
  // may point at any account but one GAM keeps (a control account); until it
  // is pointed, a seeded category charges to its default role's account.
  'expense_category', 'income_category'] as const
export type LedgerMapKind = typeof LEDGER_MAP_KINDS[number]
/** The role a map kind's sub-accounts hang under (and share their type with). */
export const LEDGER_MAP_KIND_PARENT_ROLE: Record<Exclude<LedgerMapKind, 'role'>, LedgerAccountRole> = {
  bank_connection: 'bank_checking',
  sales_tax:       'sales_tax_payable',
  loan:            'mortgage_payable',
  // 10/12 (ledger P6): not a parent — the role a category falls back to when
  // it names no account and no default role. Categories never get a
  // sub-account of their own (services/booksLedgerChart resolveAccount).
  expense_category: 'other_expenses',
  income_category:  'other_income',
}

/**
 * The effective_from of a role's first map row — "from the beginning". Every
 * later repoint is dated the day it is made (never inside a closed month).
 */
export const LEDGER_MAP_BEGINNING = '1900-01-01'

// ─── Sources, postings and lines ─────────────────────────────────────────────

/**
 * ledger_postings.source_type / ledger_outbox.source_type: the money record a
 * posting is rebuilt from (one projector per type). The outbox capture
 * triggers name these keys; a key with no registered projector waits in the
 * outbox until its phase ships (P4 tenant money, P5 register / bookings /
 * payouts, P6 money out, P7 payroll and journals).
 */
export const LEDGER_SOURCE_TYPES = [
  'payment', 'remittance', 'prepaid_credit', 'credit_use', 'allocation', 'payment_reversal',
  'held_item', 'transfer_intent', 'disbursement', 'connect_payout', 'instant_margin',
  'gam_charge', 'gam_debit', 'reader_order',
  'pos_sale', 'pos_refund', 'pos_eod', 'pos_held', 'booking', 'refund_part',
  'security_deposit', 'deposit_return', 'home_sale', 'opening',
  'expense', 'expense_payment', 'other_income', 'deposit_slip', 'bank_match',
  'payroll_run', 'manual_journal', 'property_transfer', 'work_trade_hours',
  // 10/12 (Nic, ledger P4): one home-sale installment paid outside GAM (design
  // A7b) — its own source, because each posts on its own billing month and a
  // contract's installments cannot share one posting.
  'home_installment',
  // 10/12 (Nic, ledger P6 — loans and fixed assets): a loan (funded, or its
  // balance on the books start date), one loan payment (principal / interest
  // / escrow), and a fixed asset ('<asset>' its opening, '<asset>|YYYY-MM' a
  // month of depreciation). Their lists are in booksVendorsLoans.ts.
  'loan', 'loan_payment', 'fixed_asset',
] as const
export type LedgerSourceType = typeof LEDGER_SOURCE_TYPES[number]

/**
 * ledger_postings.posting_kind: one source may post more than one independent
 * posting (a charge row that is also a prior arrangement; a reversal's charge
 * part and its credit-spend part). 'main' is a source's only posting.
 */
export const LEDGER_POSTING_KINDS = [
  'main', 'charge', 'prior_arrangement', 'gam_cover', 'work_trade', 'credit_spend',
  // 10/12 (Nic, ledger P4): a bill the security deposit paid at move-out
  // (status paid_via_deposit), and a home sale taken back (its own day).
  'paid_from_deposit', 'cancellation',
  // 10/12 (Nic, ledger P6): an expense payment the bank line cleared on a later
  // day than it was made (a check): Dr outstanding checks / Cr the bank.
  'bank_clear',
] as const
export type LedgerPostingKind = typeof LEDGER_POSTING_KINDS[number]

/**
 * ledger_postings.role: a posting as projected ('post'), or the exact
 * negation of an earlier posting that a correction superseded ('reversal').
 */
export const LEDGER_POSTING_ROLES = ['post', 'reversal'] as const
export type LedgerPostingRole = typeof LEDGER_POSTING_ROLES[number]

/**
 * ledger_posting_lines.cash_effect: 'in' marks a line that counts in
 * Received (money arriving, or going back out on its own day as a negative);
 * 'out' marks money paid out. NULL for every other line.
 */
export const LEDGER_CASH_EFFECTS = ['in', 'out'] as const
export type LedgerCashEffect = typeof LEDGER_CASH_EFFECTS[number]

/**
 * ledger_posting_lines.report_category: the income categories reports group
 * by (money.ts INCOME_CATEGORIES), the money that is not income, and the
 * expense categories (index.ts EXPENSE_CATEGORIES). Spelled out here (this file
 * imports nothing); packages/shared booksLedger.test.ts holds it equal to
 * INCOME_CATEGORIES + LEDGER_NOT_INCOME_REPORT_CATEGORIES + EXPENSE_CATEGORIES.
 */
export const LEDGER_NOT_INCOME_REPORT_CATEGORIES = [
  'paid_ahead', 'deposits', 'tax_collected', 'not_income', 'credits_given', 'work_trade', 'refunds', 'opening',
] as const
export const LEDGER_REPORT_CATEGORIES = [
  // INCOME_CATEGORIES
  'space_rent',
  'electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other',
  'late_fees', 'home_payments', 'other_fees', 'balances_collected',
  'register_sales', 'stays_and_pay_links', 'other_income',
  // LEDGER_NOT_INCOME_REPORT_CATEGORIES
  'paid_ahead', 'deposits', 'tax_collected', 'not_income', 'credits_given', 'work_trade', 'refunds', 'opening',
  // EXPENSE_CATEGORIES
  'maintenance', 'repairs', 'utilities', 'insurance', 'property_tax', 'management',
  'supplies', 'landscaping', 'professional', 'mortgage_interest', 'hoa', 'advertising',
  'lot_rent', 'bank_fees', 'other',
] as const
export type LedgerReportCategory = typeof LEDGER_REPORT_CATEGORIES[number]

// ─── Outbox, errors and runs ─────────────────────────────────────────────────

/** ledger_source_errors.reason_code: why a source could not post (it stays in the outbox). */
export const LEDGER_SOURCE_ERROR_REASONS = [
  'projector_error', // the projector threw reading the source
  'post_error',      // writing the posting failed (a ledger trigger refused it)
  'unbalanced',      // the projected lines did not balance
  'no_books_start',  // the company has no books start date yet
  'owner_not_ready', // the owner's books cannot post yet (a business, before its phase)
  'missing_fact',    // a stored fact the projector needs is missing (design §4 M2)
] as const
export type LedgerSourceErrorReason = typeof LEDGER_SOURCE_ERROR_REASONS[number]

/**
 * 10/12 (Nic) review: ledger_outbox.source_type of the mark a MOVED books start
 * date leaves (the landlords trigger in migration 20261013200600; never a
 * posting source, so not in LEDGER_SOURCE_TYPES). source_id is
 * 'landlord id|from|to': every source of that company dated from `from` up to
 * (not including) `to` crossed the start date, and the engine re-projects each.
 */
export const LEDGER_OUTBOX_BOOKS_START = 'books_start' as const

/** ledger_rebuild_runs.mode. 'check' is the nightly tie-out (design §8). */
export const LEDGER_RUN_MODES = ['dry_run', 'apply', 'from_scratch', 'check'] as const
export type LedgerRunMode = typeof LEDGER_RUN_MODES[number]
export const LEDGER_RUN_STATUSES = ['running', 'done', 'failed', 'refused'] as const
export type LedgerRunStatus = typeof LEDGER_RUN_STATUSES[number]

/** books_opening_items.kind — what a hand-entered opening balance is (design §4, J1). */
export const LEDGER_OPENING_ITEM_KINDS = ['bank', 'deposit_held', 'paid_ahead_held', 'other'] as const
export type LedgerOpeningItemKind = typeof LEDGER_OPENING_ITEM_KINDS[number]
export const LEDGER_OPENING_ITEM_KIND_LABEL: Record<LedgerOpeningItemKind, string> = {
  bank:            'Bank balance',
  deposit_held:    'Deposit you hold',
  paid_ahead_held: 'Paid-ahead money you hold',
  other:           'Other opening balance',
}

// ─── Month close (design §13; Nic 10/12 L3, L4) ──────────────────────────────

/** books_period_closes.action. */
export const LEDGER_CLOSE_ACTIONS = ['close', 'reopen'] as const
export type LedgerCloseAction = typeof LEDGER_CLOSE_ACTIONS[number]

/**
 * landlords.books_close_by / books_reopen_by — who may close a month and who
 * may reopen one. The owner decides (Nic, 10/12: "landlord's choice"). A
 * bookkeeper counts only with the company-wide box (10/12, decision 2: every
 * bookkeeper does full bookkeeping, one level — services/ledgerClose).
 */
export const LEDGER_CLOSE_PERMISSIONS = ['owner', 'owner_or_bookkeeper'] as const
export type LedgerClosePermission = typeof LEDGER_CLOSE_PERMISSIONS[number]
export const LEDGER_CLOSE_PERMISSION_LABEL: Record<LedgerClosePermission, string> = {
  owner:               'Only the owner',
  owner_or_bookkeeper: 'The owner or a bookkeeper with the company-wide box',
}
/** Defaults: a company-wide bookkeeper may close; only the owner reopens (design §13 recommendation). */
export const DEFAULT_LEDGER_CLOSE_BY: LedgerClosePermission = 'owner_or_bookkeeper'
export const DEFAULT_LEDGER_REOPEN_BY: LedgerClosePermission = 'owner'

/**
 * landlords.books_open_month_fixes — where a fix to a month that is still open
 * shows (Nic, 10/12: "landlord's choice"):
 *   restate   the month it belongs to changes (QuickBooks' way)
 *   day_made  the month is left alone; the fix shows on the day it was made
 * A closed month is never changed either way: its fixes land in the first open
 * month, labeled as corrections.
 */
export const LEDGER_OPEN_MONTH_FIX_MODES = ['restate', 'day_made'] as const
export type LedgerOpenMonthFixMode = typeof LEDGER_OPEN_MONTH_FIX_MODES[number]
export const LEDGER_OPEN_MONTH_FIX_MODE_LABEL: Record<LedgerOpenMonthFixMode, string> = {
  restate:  'Change that month',
  day_made: 'Show the fix on the day it was made',
}
export const DEFAULT_LEDGER_OPEN_MONTH_FIXES: LedgerOpenMonthFixMode = 'restate'

// ─── Register stock (Nic 10/12, L8: "landlord's choice") ────────────────────

/**
 * landlords.books_register_stock — how the company's books count what register
 * stock costs (Nic, 10/12, L8: "landlord's choice"):
 *   expense_when_bought  stock is an expense the day it is bought (the money-out
 *                        record says so); a sale posts no cost
 *   cost_per_item_sold   stock bought is inventory; each sale moves what its
 *                        items cost (pos_transaction_items.cost_price × qty, as
 *                        recorded with the sale) from Inventory to Cost of
 *                        goods sold on the sale's day
 * landlords.books_register_stock_from is the first day the current choice
 * applies (NULL: from the books start) — a change never re-dates sales already
 * booked. Mirrors landlords_books_register_stock_check (migration
 * 20261014100000).
 */
export const LEDGER_REGISTER_STOCK_METHODS = ['expense_when_bought', 'cost_per_item_sold'] as const
export type LedgerRegisterStockMethod = typeof LEDGER_REGISTER_STOCK_METHODS[number]
export const LEDGER_REGISTER_STOCK_METHOD_LABEL: Record<LedgerRegisterStockMethod, string> = {
  expense_when_bought: 'Count stock as an expense when you buy it',
  cost_per_item_sold:  'Count what each item cost when it sells',
}
/** Design §6 Q12 recommendation: expense when bought (item costs are recorded either way). */
export const DEFAULT_LEDGER_REGISTER_STOCK_METHOD: LedgerRegisterStockMethod = 'expense_when_bought'

// ─── Capture: which changes mark a source for posting (design §7) ────────────

/**
 * Each money table's statement-level capture triggers (ledger_capture_<table>_
 * ins/upd/del) write the keys of the rows a statement changed into
 * ledger_outbox. An UPDATE is captured only when one of these columns changed,
 * so bookkeeping-only writes (platform_held, notes, retry timers, sync stamps)
 * write nothing. These are the columns the table's projector may read; the
 * API's ledgerCoverage test holds every trigger's list to this one.
 */
export const LEDGER_CAPTURE_COLUMNS = {
  payments: ['landlord_id', 'unit_id', 'lease_id', 'tenant_id', 'type', 'amount', 'status', 'due_date', 'settled_at',
    'entry_description', 'lease_fee_id', 'invoice_id', 'reversal_id', 'revenue_owner', 'manual_method', 'voided_at',
    'home_sale_installment_id', 'flexpay_advance_id', 'is_remainder', 'sublease_markup_amount',
    'gam_supersedence_amount', 'payment_channel', 'issued_credit_amount', 'deposit_collected_by',
    // 10/12 (Nic, ledger P4): the charge posts at amount + work_trade_credit and
    // the shortfall row is space rent (design A1, A9, C5).
    'work_trade_credit', 'work_trade_settlement_id'],
  tenant_remittances: ['landlord_id', 'tenant_id', 'lease_id', 'amount', 'applied_amount', 'unapplied_amount',
    'gross_amount', 'processing_fee_amount', 'status', 'payment_method', 'settled_at', 'undone_at'],
  remittance_applications: ['remittance_id', 'payment_id', 'amount_applied'],
  lease_prepaid_credits: ['lease_id', 'received_lease_id', 'tenant_id', 'amount_original', 'funded_by', 'received_at',
    'voided_at', 'source_remittance_id', 'source_payment_id', 'left_by_choice_id'],
  credit_uses: ['tenant_credit_id', 'prepaid_credit_id', 'payment_id', 'deposit_return_id', 'payment_reversal_id',
    'remittance_id', 'refund_part_id', 'paid_ahead_choice_id', 'lease_id', 'amount', 'source', 'status', 'applied_at',
    'released_at'],
  tenant_credits: ['landlord_id', 'tenant_id', 'lease_id', 'amount_original', 'category', 'status', 'voided_at'],
  allocation_splits: ['payment_id', 'landlord_id', 'property_id', 'remittance_id', 'credit_use_id', 'gross_held',
    'landlord_fee_withheld', 'landlord_fee_uncovered', 'supersedence', 'sublease_markup', 'pm_fee_due', 'pm_paid',
    'manager_fee_due', 'manager_paid', 'short_by', 'owner_share'],
  payment_reversals: ['payment_id', 'landlord_id', 'tenant_id', 'lease_id', 'reversal_type', 'reversed_amount',
    'reversal_fee', 'status', 'outcome', 'recovery_method', 'recovery_status', 'recovered_amount', 'recovered_at',
    'resolved_at', 'created_at'],
  held_payout_items: ['landlord_id', 'business_id', 'property_id', 'source_type', 'source_id', 'amount',
    'payout_intent_id', 'created_at'],
  platform_transfer_intents: ['landlord_id', 'business_id', 'destination_connect_account_id', 'amount', 'gross_owed',
    'netted_amount', 'status', 'transferred_at', 'purpose', 'deposit_return_id', 'flexcharge_statement_id',
    'disbursement_id'],
  landlord_gam_charge_collections: ['charge_id', 'platform_transfer_intent_id', 'landlord_gam_debit_id', 'amount',
    'collected_at'],
  disbursements: ['landlord_id', 'user_id', 'amount', 'status', 'settled_at', 'initiated_at', 'fee_charged',
    'stripe_payout_id', 'stripe_account_id', 'bank_account_id', 'trigger_type'],
  connect_payouts: ['stripe_payout_id', 'stripe_account_id', 'user_id', 'amount', 'status', 'arrival_date',
    'failure_code'],
  landlord_instant_margins: ['landlord_id', 'amount', 'status', 'collected_at', 'source_disbursement_id'],
  landlord_gam_charges: ['landlord_id', 'property_id', 'kind', 'amount', 'source_type', 'source_id', 'voided_at',
    'created_at', 'reader_order_id', 'installment_number'],
  landlord_gam_debits: ['landlord_id', 'charges_amount', 'bank_cost_amount', 'total_amount', 'status', 'charge_ids',
    'settled_at',
    // 10/13 (Nic): a pull the landlord's bank disputed posts its own taking-back
    // on the dispute's day (migration 20261015140100).
    'disputed_at'],
  pos_reader_orders: ['landlord_id', 'property_id', 'status', 'price', 'installments', 'installment_amount',
    'installments_raised', 'shipped_at', 'cancelled_at'],
  pos_transactions: ['landlord_id', 'property_id', 'tenant_id', 'payment_method', 'subtotal', 'discount_amount',
    'tax_amount', 'tax_breakdown', 'surcharge', 'total', 'platform_fee', 'status', 'voided_at', 'created_at',
    'pay_link_id', 'paid_online'],
  pos_transaction_items: ['transaction_id', 'item_id', 'item_category', 'qty', 'unit_price', 'cost_price', 'tax_rate',
    'subtotal'],
  pos_refunds: ['transaction_id', 'landlord_id', 'amount', 'refund_method', 'card_fee_refunded', 'tax_refunded',
    'stay_refund_part_id', 'reversed_at', 'created_at'],
  pos_eod_settlements: ['landlord_id', 'property_id', 'business_day', 'opening_float', 'cash_sales', 'cash_refunds',
    'cash_drawer_actual', 'status', 'closed_at'],
  pos_held_payments: ['landlord_id', 'property_id', 'pay_link_id', 'booking_id', 'amount', 'stripe_fee_kept', 'status',
    'refunded_at', 'created_at'],
  unit_bookings: ['landlord_id', 'unit_id', 'tenant_id', 'status', 'check_in', 'check_out', 'booked_check_out',
    'nights', 'total_amount', 'nightly_rate', 'deposit_amount', 'deposit_paid_at', 'balance_paid_at', 'cancelled_at',
    'pos_transaction_id', 'lease_type', 'stay_terms'],
  stay_payments: ['booking_id', 'landlord_id', 'kind', 'pos_transaction_id', 'method', 'toward_stay', 'card_fee',
    'landlord_card_fee', 'lodging_tax_amount', 'paid_at'],
  stay_refund_parts: ['landlord_id', 'booking_id', 'decision_id', 'kind', 'stay_payment_id', 'remittance_id',
    'prepaid_credit_id', 'pos_transaction_id', 'toward_amount', 'card_fee_back', 'amount', 'payout_drop',
    'lodging_tax_share', 'status', 'refunded_at', 'reversed_at', 'replaces_part_id', 'paid_ahead_choice_id',
    'deposit_return_id', 'deposit_payment_id'],
  security_deposits: ['lease_id', 'tenant_id', 'unit_id', 'total_amount', 'status', 'held_by', 'flex_deposit_enabled',
    'flex_deposit_plan_status', 'carried_from_deposit_id'],
  deposit_returns: ['landlord_id', 'lease_id', 'security_deposit_id', 'status', 'finalized_at', 'total_deposit',
    'cleaning_fee_amount', 'damage_lines', 'other_deductions', 'total_deductions', 'refund_amount', 'gap_amount',
    'unpaid_balance_amount', 'refund_from_gam', 'refund_from_landlord', 'refund_payment_id', 'gap_payment_id',
    'landlord_part_handed_back_on'],
  home_sale_contracts: ['landlord_id', 'unit_id', 'tenant_id', 'sale_price', 'down_payment', 'financed_amount',
    'annual_interest_rate', 'term_months', 'start_month', 'plan_type', 'status', 'cancelled_at', 'paid_off_at',
    'created_at',
    // 10/12 (Nic, ledger review): the sale is dated by activated_at and tagged
    // with its lease (design J1, J2) — a change of either alone re-posts it.
    'activated_at', 'lease_id'],
  landlord_expenses: ['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'expense_date', 'is_common',
    'allocate_per_unit', 'status', 'voided_at', 'utility_type', 'vendor', 'bank_transaction_id',
    // 10/12 (Nic, ledger P6): the category it charges to and who was paid
    // (its payments' cash lines carry both, so a change marks them too), and
    // the manager's-cut bill of a split (Nic L18: the split posts its cost).
    'category_id', 'vendor_id', 'allocation_split_id'],
  landlord_expense_payments: ['expense_id', 'landlord_id', 'paid_on', 'amount', 'method',
    'bank_connection_id', 'bank_transaction_id', 'voided_at'],
  landlord_other_income: ['landlord_id', 'property_id', 'unit_id', 'category', 'amount', 'income_date', 'is_common',
    'status', 'voided_at', 'bank_transaction_id', 'category_id'],
  bank_deposit_slips: ['landlord_id', 'property_id', 'deposit_date', 'total', 'other_amount', 'source', 'status',
    'bank_transaction_id', 'matched_at', 'voided_at'],
  bank_deposit_slip_items: ['slip_id', 'remittance_id', 'pos_transaction_id', 'amount', 'voided_at'],
  payroll_runs: ['landlord_id', 'business_id', 'pay_date', 'status', 'total_gross', 'total_federal_tax',
    'total_state_tax', 'total_ss', 'total_medicare', 'total_net', 'approved_at', 'voided_at',
    // 10/12 (Nic, ledger P7): the employer's own taxes, recorded per run (design J3).
    'total_employer_ss', 'total_employer_medicare', 'total_futa', 'total_suta'],
  payroll_run_lines: ['run_id', 'employee_id', 'gross_pay', 'federal_tax', 'state_tax', 'ss_tax', 'medicare_tax',
    'other_deductions', 'net_pay',
    // 10/12 (Nic, ledger P7): the employer's taxes on each paycheck (design J3).
    'employer_ss_tax', 'employer_medicare_tax', 'futa_tax', 'suta_tax'],
  journal_entries: ['landlord_id', 'business_id', 'date', 'type', 'status', 'voided_at', 'reverses_entry_id',
    'adjusts_line_key'],
  journal_entry_lines: ['entry_id', 'account_id', 'debit', 'credit', 'property_id', 'unit_id', 'lease_id'],
  property_transfers: ['property_id', 'from_landlord_id', 'to_landlord_id', 'transferred_at', 'moved'],
  work_trade_extra_hours: ['landlord_id', 'tenant_id', 'agreement_id', 'period_month', 'hours', 'rate', 'amount',
    'pay_method', 'status', 'paid_on', 'paid_at', 'books_reference_id'],
  books_opening_items: ['landlord_id', 'business_id', 'kind', 'lease_id', 'tenant_id', 'property_id',
    'bank_connection_id', 'amount', 'as_of', 'voided_at', 'account_id'],
  // 10/12 (Nic, ledger P6): the loan register and the fixed-asset list
  // (migrations 20261014190200 / 190300; their lists are in booksVendorsLoans.ts).
  // A loan's change marks its own posting and every payment's (the payments
  // carry its property and name); an asset's marks its opening and each month
  // of depreciation that has ended.
  books_loans: ['landlord_id', 'business_id', 'property_id', 'name', 'original_amount', 'start_date',
    'funded_to', 'funded_bank_connection_id', 'opening_balance', 'opening_escrow', 'voided_at',
    // 10/12 (Nic, integrate): the bank line the loan's money arrived as dates it (20261014210100).
    'funded_bank_transaction_id'],
  books_loan_payments: ['loan_id', 'landlord_id', 'business_id', 'paid_on', 'amount', 'principal', 'interest', 'escrow',
    'method', 'bank_connection_id', 'voided_at',
    // 10/12 (Nic, integrate): the bank line that paid it clears it on the bank's day (20261014210100).
    'bank_transaction_id'],
  books_fixed_assets: ['landlord_id', 'business_id', 'property_id', 'name', 'asset_class', 'cost', 'salvage_value',
    'acquired_on', 'in_service_date', 'life_years', 'method', 'prior_depreciation', 'source_expense_id', 'voided_at'],
  // Dependent tables: a projector reads them, so they mark the key that reads them.
  utility_bills: ['payment_id', 'meter_id', 'landlord_id', 'charge_amount', 'tax_amount', 'utility_type'],
  home_sale_installments: ['contract_id', 'payment_id', 'billing_month', 'amount', 'principal_portion',
    'interest_portion', 'settled_off_platform_at'],
  flex_deposit_installments: ['payment_id', 'security_deposit_id'],
  invoices: ['is_opening_balance', 'work_trade_credit_amount'],
  lease_fees: ['fee_type', 'money_kind', 'is_refundable', 'due_timing'],
  bank_deposit_allocations: ['bank_transaction_id', 'payment_id', 'landlord_id', 'amount', 'effective_paid_date',
    'reversed_at'],
  bank_transactions: ['bank_connection_id', 'landlord_id', 'posted_date', 'amount', 'status', 'matched_payment_id',
    'matched_disbursement_id', 'expense_id', 'landlord_other_income_id',
    // 10/12 (Nic, ledger review): the bank-match posting reads the receipt it
    // names (design B5/B6); a matched payout line also marks that payout (G3).
    'auto_settle_undo',
    // 10/12 (Nic, ledger P6): money out matched to a record GAM already has
    // (a GAM fee pull, a refund check, a transfer between linked accounts).
    'matched_kind', 'matched_gam_debit_id', 'matched_pos_refund_id', 'matched_refund_part_id',
    'matched_transfer_line_id'],
} as const satisfies Record<string, readonly string[]>
export type LedgerCaptureTable = keyof typeof LEDGER_CAPTURE_COLUMNS
export const LEDGER_CAPTURE_TABLES = Object.keys(LEDGER_CAPTURE_COLUMNS) as LedgerCaptureTable[]

/**
 * Every table with a money column that has NO capture triggers, each with why
 * (gam-ledger-design-2026-10-12 §7: "every table with a numeric money column
 * has the triggers or is named in LEDGER_EXCLUDED_TABLES"). The API's
 * ledgerCoverage test fails on a money table that is in neither list, so a new
 * money table is decided on the day it is made. When a later phase's projector
 * starts reading one of these, it moves to LEDGER_CAPTURE_COLUMNS (and its
 * migration calls ledger_install_capture).
 */
const BUSINESS_BOOKS_LATER = "the business portal's own books (a later phase); never on a landlord's ledger"
const CONFIGURATION = 'configuration (rates, prices, terms), not money moved'
export const LEDGER_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  // GAM's own book and the tenant products (design §6 K)
  platform_revenue_ledger: "GAM's own book, never a landlord's",
  stripe_processing_costs: "GAM's own cost record",
  reserve_fund_ledger: "GAM's own reserve",
  flex_deposit_custody_charges: 'a tenant product fee GAM keeps (FlexDeposit), never on the landlord book',
  flexcredit_charges: 'a tenant product fee GAM keeps',
  flexpay_advances: 'GAM float, never on the landlord book',
  otp_advances: 'On-Time Pay is shelved; its advances were GAM float, never on the landlord book',
  screening_fee_accruals: "GAM's screening earnings",
  screening_prepayments: "GAM's screening earnings",
  background_checks: "GAM's screening money; the applicant's fee never reaches a landlord's book",
  commission_accruals: "GAM's sales commissions",
  pos_reader_order_costs: "GAM's own cost of a card reader (Nic A1b); the landlord's book carries the price charged (pos_reader_orders, landlord_gam_charges, design H4)",
  platform_fee_accruals: "GAM's fee worked out; what the landlord owes posts through landlord_gam_charges (design H1)",
  monthly_fee_accruals: "GAM's fee worked out; what the landlord owes posts through landlord_gam_charges (design H1)",
  platform_fee_config: CONFIGURATION,
  landlord_platform_fee_overrides: CONFIGURATION,
  pm_monthly_fee_accruals: 'the PM company owner-statement layer, not a landlord posting source',
  user_balance_ledger: 'balances follow from allocation_splits and the payout records',
  ledger_derived_facts: 'a note on which stored facts were worked out, not money moved',
  // Gated or shelved
  flex_charge_statements: 'store charge accounts are gated (design F7)',
  flex_charge_transactions: 'store charge accounts are gated (design F7)',
  lot_rent_charges: 'lot rent is shelved (subleasing_enabled); when it ships it posts through an expense (design I5)',
  subleases: 'subleasing is shelved',
  sublessee_invitations: 'subleasing is shelved',
  sublessor_credit_balances: 'subleasing is shelved',
  // The business portal
  business_bookable_services: BUSINESS_BOOKS_LATER,
  business_inventory_items: BUSINESS_BOOKS_LATER,
  business_invoice_lines: BUSINESS_BOOKS_LATER,
  business_invoice_payments: BUSINESS_BOOKS_LATER,
  business_invoices: BUSINESS_BOOKS_LATER,
  business_platform_fee_accruals: BUSINESS_BOOKS_LATER,
  business_pos_transaction_lines: BUSINESS_BOOKS_LATER,
  business_pos_transactions: BUSINESS_BOOKS_LATER,
  business_quote_lines: BUSINESS_BOOKS_LATER,
  business_quotes: BUSINESS_BOOKS_LATER,
  business_recurring_invoice_lines: BUSINESS_BOOKS_LATER,
  business_work_order_lines: BUSINESS_BOOKS_LATER,
  business_work_orders: BUSINESS_BOOKS_LATER,
  // The old GAM Books records (design §12: P6 moves each into an Expense or
  // other income with its origin kept, and its money posts from there)
  books_bills: 'old GAM Books record; P6 moves it into an Expense and it posts from there',
  books_bill_payments: 'old GAM Books record; P6 moves it into an expense payment and it posts from there',
  books_transactions: 'old GAM Books record; P6 moves it into an Expense or other income and it posts from there',
  books_vendors: "a payee's details and running totals, not money moved",
  books_contractors: "a payee's details and running totals, not money moved",
  books_employees: "a payee's details and pay rates, not money moved",
  // 10/12 (Nic, ledger P9): bank reconciliation reads the ledger; it never posts to it.
  bank_reconciliation_items: 'which ledger lines a bank statement cleared — a check of the books, not money moved',
  contractors: "a payee's details and rates, not money moved",
  // Billed as payments rows — the payment row is what posts
  leases: 'lease terms; each bill is a payments row',
  lease_rent_components: 'lease terms; each bill is a payments row',
  lease_template_conditional_fees: 'a lease template, not money moved',
  lease_termination_requests: 'a request; the fee it bills is a payments row',
  scheduled_lease_changes: 'a change waiting to be made; what it bills is a payments row',
  tenant_one_off_charges: 'a charge before it is billed; once billed it is a payments row (payment_id)',
  propane_fills: 'billed as payments rows',
  propane_fill_installments: 'billed as payments rows',
  common_area_reservations: 'its fee is billed as a payments row (fee_payment_id)',
  common_areas: CONFIGURATION,
  suspended_utility_charges: 'a utility charge held back; once released it is billed as a payments row',
  security_deposit_interest_accruals: 'interest worked out; it reaches the tenant as an applied credit (credit_uses, design C4)',
  lease_prepaid_credit_draws: "the per-month measure of paid-ahead draws (the monthly cap); each draw's money moves as a credit_uses row",
  // Decisions and reports whose money moves through another table
  paid_ahead_choices: 'a decision; its money moves through credit_uses, lease_prepaid_credits, held items and refund parts (design C6, C7, C10)',
  stay_checkout_decisions: 'a decision; its money moves through stay_refund_parts and payments (design D4)',
  connect_disputes: "Stripe's dispute record; the money posts through payment_reversals and held_payout_items (design E1, E2, F4)",
  tenant_declared_deposits: "a tenant's report of a bank deposit; the money posts when a bank line or receipt is matched",
  work_trade_settlements: "a month's work-trade close; its money is on the payment rows it settles (design A9, C5)",
  maintenance_requests: "a repair's cost posts only through its expense, never by itself (design I3)",
  purchase_requests: 'a request to buy; what is bought posts as an expense',
  pos_purchase_orders: 'an order to a supplier; a received order becomes an expense (design F8)',
  pos_purchase_order_items: 'an order to a supplier; a received order becomes an expense (design F8)',
  pos_pay_links: 'a link to pay; money paid through it is a register sale or a held payment',
  pos_sessions: 'a register cart before the sale; pos_transactions is the sale',
  pos_session_items: 'a register cart before the sale; pos_transaction_items is the sale',
  utility_owner_use_absorptions: "the landlord's own use of a utility it pays for; no money moves",
  // Configuration, measurements, logs, not money
  pos_items: CONFIGURATION,
  pos_item_variants: CONFIGURATION,
  pos_price_history: 'a log of catalog prices',
  pm_fee_plans: CONFIGURATION,
  properties: CONFIGURATION,
  units: CONFIGURATION,
  tenants: 'a person, not money moved',
  property_allocation_rules: CONFIGURATION,
  property_fee_schedules: CONFIGURATION,
  property_unit_subtypes: CONFIGURATION,
  property_unit_type_late_fees: CONFIGURATION,
  property_utility_rates: CONFIGURATION,
  state_application_fee_caps: 'a rate table',
  state_deposit_interest_rates: 'a rate table',
  utility_meters: CONFIGURATION,
  utility_meter_readings: 'a measurement; what it bills is a utility bill and a payments row',
  utility_reading_runs: 'a summary of the bills a run made',
  utility_service_agreements: CONFIGURATION,
  ach_monitoring_log: 'a log',
  ach_monitoring_log_archive: 'a log',
  fitness_milestones: 'not money (pounds)',
  generated_routes: 'not money (miles, minutes)',
}

// ─── Fingerprints and amounts ────────────────────────────────────────────────

/** Whole cents as a numeric(12,2) literal, exact for any safe integer (no float rounding). */
export function ledgerCentsToNumeric(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Not a whole number of cents: ${cents}`)
  const neg = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.trunc(abs / 100)
  const frac = abs % 100
  return `${neg ? '-' : ''}${whole}.${frac < 10 ? '0' : ''}${frac}`
}

// ─── The company's books choices (Nic 10/12: "landlord's choice") ────────────
//
// 10/12 (Nic): how a company's books count a few kinds of money is the OWNER's
// choice, made on the Books settings page (routes/booksSettings.ts,
// apps/*/src/bookkeeping/BooksSettingsPage.tsx). Each is a landlords column
// (migration 20261014001000) whose CHECK lists the same values. (Register stock,
// L8, is the register lane's books_register_stock — LEDGER_REGISTER_STOCK_METHODS
// above — and the same page sets it.)
//
// NULL means "not chosen yet". GAM picks none of these accounting methods for a
// company — the way it never picks a books start date (Nic, L16: "TruBlu picks
// its own start date, no default set by GAM"). A record whose posting depends
// on a method that is not chosen waits, and posts once the owner chooses.
// Who may write off a balance starts at the narrowest choice, the owner only.
//
// A method is chosen once: after the company's books have posted, changing it
// would rewrite what already posted (a rebuild reads today's choice), so the
// API refuses a change then. Choosing one that was never chosen is always
// allowed (nothing posted under it).

/**
 * landlords.books_history_start — how the books start date
 * (landlords.books_start_date, the bank feed's cutoff too) was picked:
 *   since_joining  the first day of the month the company joined GAM
 *   start_date     a date the owner picked; what came before it opens as
 *                  starting balances (the Opening balances step)
 * NULL with a start date set: picked on the Bank page before this setting
 * existed — it reads as start_date.
 */
export const BOOKS_HISTORY_STARTS = ['since_joining', 'start_date'] as const
export type BooksHistoryStart = typeof BOOKS_HISTORY_STARTS[number]
export const BOOKS_HISTORY_START_LABEL: Record<BooksHistoryStart, string> = {
  since_joining: 'Since joining GAM',
  start_date:    'From a date you pick',
}

/**
 * landlords.books_home_sale_method (Nic L11): a home sold on payments counts
 *   whole_sale_at_signing  the whole sale when it is signed; what the buyer
 *                          still owes is a note owed to the landlord, each
 *                          payment split into principal and interest
 *   income_as_paid         as income when each payment comes in
 */
export const BOOKS_HOME_SALE_METHODS = ['whole_sale_at_signing', 'income_as_paid'] as const
export type BooksHomeSaleMethod = typeof BOOKS_HOME_SALE_METHODS[number]
export const BOOKS_HOME_SALE_METHOD_LABEL: Record<BooksHomeSaleMethod, string> = {
  whole_sale_at_signing: 'The whole sale when it is signed',
  income_as_paid:        'Income as each payment comes in',
}

/**
 * landlords.books_work_trade_method (Nic L12): work-trade hours that cover rent
 *   rent_and_labor  full rent as income, the hours as a labor cost
 *   rent_discount   rent as income less what the hours covered
 */
export const BOOKS_WORK_TRADE_METHODS = ['rent_and_labor', 'rent_discount'] as const
export type BooksWorkTradeMethod = typeof BOOKS_WORK_TRADE_METHODS[number]
export const BOOKS_WORK_TRADE_METHOD_LABEL: Record<BooksWorkTradeMethod, string> = {
  rent_and_labor: 'Full rent, plus the hours as a labor cost',
  rent_discount:  'A rent discount',
}

/**
 * landlords.books_company_costs_method (Nic L7): costs that belong to no one
 * property (payroll, company-wide bills)
 *   company_bucket  stay in a Company column of their own
 *   split_by_units  are split across the properties by how many units each has
 */
export const BOOKS_COMPANY_COST_METHODS = ['company_bucket', 'split_by_units'] as const
export type BooksCompanyCostMethod = typeof BOOKS_COMPANY_COST_METHODS[number]
export const BOOKS_COMPANY_COST_METHOD_LABEL: Record<BooksCompanyCostMethod, string> = {
  company_bucket: 'A Company column of their own',
  split_by_units: 'Split across your properties by units',
}

/**
 * landlords.books_write_off_by (Nic L15: "owner decides who can write off;
 * kept on record, never erased"). A write-off takes money off what a tenant
 * owes, so the choices are the people who may already issue a tenant credit
 * (the owner, and property managers); a bookkeeper never acts on a tenant's
 * account (design §11).
 */
export const LEDGER_WRITE_OFF_PERMISSIONS = ['owner', 'owner_or_property_manager'] as const
export type LedgerWriteOffPermission = typeof LEDGER_WRITE_OFF_PERMISSIONS[number]
export const LEDGER_WRITE_OFF_PERMISSION_LABEL: Record<LedgerWriteOffPermission, string> = {
  owner:                     'Only the owner',
  owner_or_property_manager: 'The owner or a property manager',
}
export const DEFAULT_LEDGER_WRITE_OFF_BY: LedgerWriteOffPermission = 'owner'

/**
 * The opening balances an owner enters on the Opening balances step
 * (routes/booksSettings.ts). books_opening_items.amount reads the way the
 * balance does: a bank account's balance (negative when overdrawn), a deposit
 * the landlord holds (always positive), and an "other" item in its account's
 * normal sense — an asset the company has, a liability it owes, equity — on
 * the account it names (books_opening_items.account_id). paid_ahead_held is
 * not entered yet: whether money a tenant paid ahead before GAM should also
 * become a credit the tenant can spend is an open product question.
 */
export const LEDGER_OPENING_ITEM_KINDS_ENTERED = ['bank', 'deposit_held', 'other'] as const satisfies readonly LedgerOpeningItemKind[]
export type LedgerOpeningItemKindEntered = typeof LEDGER_OPENING_ITEM_KINDS_ENTERED[number]

// ─── Payroll and hand journal entries in the ledger (10/12, Nic — phase P7) ──
//
// gam-ledger-design-2026-10-12 §6 J3, J4. A payroll run posts on its PAY DATE:
// wages (5120) and the employer's taxes (5125) as expenses; what was withheld
// and what the employer owes as payroll liabilities (2031-2036); the take-home
// pay as Net pay payable (2035). A bookkeeper's journal entry posts exactly as
// entered, each line on its own property, with GAM's inter-property clearing
// lines (3950) added in the ledger only.

/**
 * payroll_run_expenses.kind — what a payroll run leaves owed, as the unpaid
 * money-out records it creates when it is approved (design J3: "also creates
 * unpaid payroll_net and tax_payment expenses that bank lines match"). Money
 * out is one record (Nic 10/12, L5): each is an ordinary unpaid expense on the
 * Expenses record (phase P6 — no expense "kinds"; it carries the Take-home pay
 * or Payroll taxes category), and the bank line that pays it matches it. This
 * link says which payroll liability each one clears, and the expense's
 * posting books Dr that liability / Cr Accounts payable.
 *   payroll_net   one per paycheck: the take-home pay (clears Net pay payable)
 *   tax_payment   one per payroll liability the run left owed (clears it)
 */
export const PAYROLL_EXPENSE_KINDS = ['payroll_net', 'tax_payment'] as const
export type PayrollExpenseKind = typeof PAYROLL_EXPENSE_KINDS[number]
export const PAYROLL_EXPENSE_KIND_LABEL: Record<PayrollExpenseKind, string> = {
  payroll_net: 'Take-home pay',
  tax_payment: 'Payroll tax payment',
}

/**
 * The payroll liabilities a run leaves owed, in the order the tax payments are
 * listed, each with the words it shows under (never the raw role).
 */
export const PAYROLL_LIABILITY_PARTS = [
  { role: 'payroll_federal_withholding', label: 'Federal income tax withheld' },
  { role: 'payroll_fica',                label: 'Social Security and Medicare' },
  { role: 'payroll_futa',                label: 'Federal unemployment tax' },
  { role: 'payroll_state_withholding',   label: 'State income tax withheld' },
  { role: 'payroll_suta',                label: 'State unemployment tax' },
  { role: 'payroll_liabilities',         label: 'Other payroll deductions' },
] as const satisfies readonly { role: LedgerAccountRole; label: string }[]
export type PayrollLiabilityRole = typeof PAYROLL_LIABILITY_PARTS[number]['role']

/**
 * payroll_run_expenses.liability_role — the payroll liability an expense a run
 * created clears: Net pay payable for a paycheck's take-home pay, else one of
 * PAYROLL_LIABILITY_PARTS. Mirrors payroll_run_expenses_role_check (migration
 * 20261014200300). The expense's own posting (phase P6) books Dr this role /
 * Cr Accounts payable instead of its category's account
 * (services/payrollMoneyOut payrollLiabilityRolesOfExpenses).
 */
export const PAYROLL_EXPENSE_LIABILITY_ROLES = [
  'net_pay_payable', 'payroll_federal_withholding', 'payroll_fica', 'payroll_futa',
  'payroll_state_withholding', 'payroll_suta', 'payroll_liabilities',
] as const satisfies readonly LedgerAccountRole[]
export type PayrollExpenseLiabilityRole = typeof PAYROLL_EXPENSE_LIABILITY_ROLES[number]

/**
 * 10/12 (Nic, ledger P7): the kinds of journal entry a bookkeeper writes by
 * hand on the Journal page. A reversing entry is never typed: it is made by
 * "Reverse" on the entry it takes back (POST /books/journal/:id/reverse), which
 * names that entry and swaps every line's side.
 */
export const BOOKS_JOURNAL_ENTRY_TYPES_TYPED = ['manual', 'adjusting'] as const satisfies readonly BooksJournalEntryType[]

/**
 * journal_entries.adjusts_line_key — the automatic record an adjusting entry
 * adjusts: '<source type>:<source id>' (a rent bill 'payment:<id>', a payout
 * 'disbursement:<id>' …). The record, not one line of it: a posting's lines
 * are re-made whenever its record changes, the record stays. A bookkeeper's
 * own entries are never "automatic records" (manual_journal is refused).
 */
/**
 * 10/12 (Nic, ledger P7): what kind of money record an automatic posting (or
 * the record an adjusting entry adjusts) comes from, in words — never the raw
 * source type. A type missing here reads "An automatic record".
 */
export const LEDGER_SOURCE_TYPE_LABEL: Readonly<Partial<Record<LedgerSourceType, string>>> = {
  payment: 'A tenant bill',
  remittance: 'A payment received',
  prepaid_credit: 'Money paid ahead',
  credit_use: 'A credit used',
  allocation: 'A payment split',
  payment_reversal: 'A payment taken back',
  held_item: 'Money GAM held',
  transfer_intent: 'A transfer to your bank',
  disbursement: 'A payout',
  connect_payout: 'A payout',
  instant_margin: 'An instant payout fee',
  gam_charge: 'A GAM charge',
  gam_debit: 'A GAM bank debit',
  reader_order: 'A card reader order',
  pos_sale: 'A register sale',
  pos_refund: 'A register refund',
  pos_eod: 'A register day close',
  pos_held: 'A register payment held',
  booking: 'A stay',
  refund_part: 'A refund',
  security_deposit: 'A security deposit',
  deposit_return: 'A move-out',
  home_sale: 'A home sale',
  home_installment: 'A home-sale installment',
  opening: 'The opening balances',
  expense: 'An expense',
  expense_payment: 'An expense payment',
  other_income: 'Other income',
  deposit_slip: 'A bank deposit slip',
  bank_match: 'A bank line',
  payroll_run: 'A payroll run',
  property_transfer: 'A property transfer',
  work_trade_hours: 'Work-trade extra hours',
  // 10/12 (Nic, ledger P8): the general ledger names a bookkeeper's own entry too.
  manual_journal: 'A journal entry',
  // 10/12 (Nic, ledger P6): the loan register and fixed assets.
  loan: 'A loan',
  loan_payment: 'A loan payment',
  fixed_asset: 'A fixed asset and its depreciation',
}

export function ledgerSourceKey(sourceType: LedgerSourceType, sourceId: string): string {
  return `${sourceType}:${sourceId}`
}
export function parseLedgerSourceKey(key: string): { sourceType: LedgerSourceType; sourceId: string } | null {
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return null
  const sourceType = key.slice(0, i)
  const sourceId = key.slice(i + 1)
  if (!(LEDGER_SOURCE_TYPES as readonly string[]).includes(sourceType) || sourceType === 'manual_journal') return null
  if (!/^[0-9A-Za-z._:|-]{1,200}$/.test(sourceId)) return null
  return { sourceType: sourceType as LedgerSourceType, sourceId }
}

// 10/12 (Nic, ledger P6): vendors, loans and fixed assets — their lists and
// arithmetic — are in booksVendorsLoans.ts.

// ─── Close and reconcile (Nic 10/12 L3, decision 2; design §13, phase P9) ───

/**
 * bank_reconciliations.status for a reconciliation on the ledger — one bank
 * account of the chart against one statement:
 *   open       being worked: lines are ticked off against the statement
 *   completed  the difference reached $0.00 and its lines are frozen
 *   undone     taken back (the latest one only, never inside a closed month),
 *              or an open one set aside; kept on record with why
 * Values match bank_reconciliations_status_check (20261014230000).
 */
export const BANK_RECONCILIATION_STATUSES = ['open', 'completed', 'undone'] as const
export type BankReconciliationStatus = typeof BANK_RECONCILIATION_STATUSES[number]
export const BANK_RECONCILIATION_STATUS_LABEL: Record<BankReconciliationStatus, string> = {
  open:      'In progress',
  completed: 'Reconciled',
  undone:    'Undone',
}

/**
 * bank_reconciliation_items.source — how a ledger line came to be cleared on a
 * statement:
 *   bank_line    it came from a bank line the feed matched or filed (arrives ticked)
 *   ticked       a person ticked it off the statement
 *   opening      the bank's balance on the books start date
 *   cancels_out  a line and the line that took it back, both on this
 *                statement: together they are $0.00
 */
export const BANK_RECONCILIATION_ITEM_SOURCES = ['bank_line', 'ticked', 'opening', 'cancels_out'] as const
export type BankReconciliationItemSource = typeof BANK_RECONCILIATION_ITEM_SOURCES[number]
export const BANK_RECONCILIATION_ITEM_SOURCE_LABEL: Record<BankReconciliationItemSource, string> = {
  bank_line:   'Matched to the bank line',
  ticked:      'Ticked off the statement',
  opening:     'Opening balance',
  cancels_out: 'Taken back the same statement',
}

/** bank_reconciliation_items.release_reason — why a cleared line was let go (the item is kept). */
export const BANK_RECONCILIATION_ITEM_RELEASES = ['unticked', 'reconciliation_undone'] as const
export type BankReconciliationItemRelease = typeof BANK_RECONCILIATION_ITEM_RELEASES[number]

/**
 * What the close-month screen warns about without blocking the close (design
 * §13; kept on the close's record, books_period_closes.warnings):
 *   unfiled_bank_lines            bank lines dated in or before the month nobody filed
 *   suspense_balance              money sitting in "Suspense: to classify" (1099)
 *   overdue_bills                 unpaid bills due on or before the month's end
 *   unlinked_bank_not_reconciled  a bank account with no linked feed, with money
 *                                 on it, not reconciled through the month's end
 */
export const LEDGER_CLOSE_WARNINGS = [
  'unfiled_bank_lines', 'suspense_balance', 'overdue_bills', 'unlinked_bank_not_reconciled',
] as const
export type LedgerCloseWarning = typeof LEDGER_CLOSE_WARNINGS[number]
/** books_period_closes.action, as the close-month history says it. */
export const LEDGER_CLOSE_ACTION_LABEL: Record<LedgerCloseAction, string> = {
  close:  'Closed',
  reopen: 'Reopened',
}

export const LEDGER_CLOSE_WARNING_LABEL: Record<LedgerCloseWarning, string> = {
  unfiled_bank_lines:           'Bank lines not filed yet',
  suspense_balance:             'Money in Suspense: to classify',
  overdue_bills:                'Unpaid bills past their due date',
  unlinked_bank_not_reconciled: 'A bank account with no linked feed is not reconciled',
}
