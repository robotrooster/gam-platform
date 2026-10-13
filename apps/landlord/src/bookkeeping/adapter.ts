/**
 * 10/12 (Nic): "Bookkeeping" in the landlord menu brings the GAM Books pages
 * INSIDE the landlord portal — one set of pages, the same bytes in both apps,
 * like the Financials pages.
 *
 * Every file in this folder is the SAME BYTES in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts) — except this one. It is the only thing that
 * differs between the two apps: how a page talks to the API, shows a toast or
 * a question, learns who is looking and links to another Books page. Keep it
 * tiny; anything a page needs beyond these goes in a shared file, not here.
 *
 * THIS COPY: the landlord portal (gam_token, its own sign-in and dialogs). The
 * Books API reads one company's books at a time, so every request names the
 * company whose books are open (X-Client-Id): the Bookkeeping host in main.tsx
 * sets it — the owner's chosen company, or the bookkeeper's own — before any
 * page asks for anything. The server checks it is theirs either way.
 */
import { api } from '../lib/api'
import { toast as appToast, appConfirm as appAsk } from '../components/dialogs'
import { useAuth } from '../context/AuthContext'

let openCompany: string | null = null

/** The company whose books are open (null: the server takes the account's only one). */
export function setBooksCompany(id: string | null): void { openCompany = id }

function naming() {
  return openCompany ? { headers: { 'X-Client-Id': openCompany } } : undefined
}

/** GET → the response's `data`. */
export function booksGet<T = any>(url: string): Promise<T> {
  return api.get<{ success: boolean; data: T }>(url, naming()).then(r => r.data.data)
}
/** POST → the whole envelope ({ success, data, message }). */
export function booksPost<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T; message?: string }> {
  return api.post<{ success: boolean; data: T; message?: string }>(url, body, naming()).then(r => r.data)
}
/** PATCH → the whole envelope ({ success, data }). */
export function booksPatch<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T }> {
  return api.patch<{ success: boolean; data: T }>(url, body, naming()).then(r => r.data)
}

/** A toast; toast.error for a red one. */
export function toast(text: string): void { appToast(text) }
toast.error = (text: string): void => { appToast.error(text) }
export function appConfirm(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return appAsk(message, opts)
}

/** The signed-in role (a business account's books have no GAM income — never one here). */
export function useBooksRole(): string {
  return useAuth().user?.role ?? ''
}

/** The Books pages, by name — each app files them under its own addresses. */
export type BooksPage =
  | 'dashboard' | 'employees' | 'contractors' | 'vendors' | 'runPayroll' | 'payHistory' | 'taxForms'
  | 'accounts' | 'journal' | 'transactions' | 'reconcile' | 'bills'
  | 'profitLoss' | 'balanceSheet' | 'cashFlow' | 'ownerStatements' | 'taxCenter'
  // 10/12 (Nic): the company's books settings and what its books start with.
  | 'booksSettings' | 'openingBalances'
  // 10/12 (Nic): loans (principal / interest / escrow) and fixed assets.
  | 'loans' | 'fixedAssets'
  // 10/12 (Nic, L5): the company's own categories for money out and in.
  | 'categories'
  // 10/12 (Nic, ledger P8): the trial balance and the general ledger.
  | 'trialBalance' | 'generalLedger'
  // 10/12 (Nic, ledger P9): closing a month (bank reconciliation is 'reconcile').
  | 'closeMonth'

/**
 * Where each page lives in the landlord portal: under /bookkeeping, so none can
 * clash with the portal's own pages (its Reports, Bank, Expenses...). The
 * routes (main.tsx) and the Bookkeeping menu (Layout.tsx) read these.
 */
export const BOOKS_PATHS: Record<BooksPage, string> = {
  dashboard:       '/bookkeeping/dashboard',
  employees:       '/bookkeeping/employees',
  contractors:     '/bookkeeping/contractors',
  vendors:         '/bookkeeping/vendors',
  runPayroll:      '/bookkeeping/run-payroll',
  payHistory:      '/bookkeeping/pay-history',
  taxForms:        '/bookkeeping/tax-forms',
  accounts:        '/bookkeeping/accounts',
  journal:         '/bookkeeping/journal',
  transactions:    '/bookkeeping/transactions',
  reconcile:       '/bookkeeping/reconciliation',
  bills:           '/bookkeeping/bills',
  profitLoss:      '/bookkeeping/profit-loss',
  balanceSheet:    '/bookkeeping/balance-sheet',
  cashFlow:        '/bookkeeping/cash-flow',
  ownerStatements: '/bookkeeping/owner-statements',
  taxCenter:       '/bookkeeping/tax-center',
  booksSettings:   '/bookkeeping/settings',
  openingBalances: '/bookkeeping/opening-balances',
  loans:           '/bookkeeping/loans',
  fixedAssets:     '/bookkeeping/fixed-assets',
  categories:      '/bookkeeping/categories',
  closeMonth:      '/bookkeeping/close-month',
  trialBalance:    '/bookkeeping/trial-balance',
  generalLedger:   '/bookkeeping/general-ledger',
}

/** The address of a Books page in this app. */
/**
 * 10/12 (Nic, L5): where this app's Expenses page is — a landlord company's old
 * Books Bills and Transactions moved onto it, and their pages point there.
 */
export function expensesPagePath(): string {
  return '/expenses'
}

export function booksPath(page: BooksPage): string {
  return BOOKS_PATHS[page]
}
