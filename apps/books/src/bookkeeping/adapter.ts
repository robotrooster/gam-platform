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
 * THIS COPY: GAM Books (its own pass, gam_books_token, and the company it has
 * open, sent as X-Client-Id — the same as every other Books request).
 */
import { createContext, useContext } from 'react'
import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'
import { toast as appToast, appConfirm as appAsk } from '../components/dialogs'

const ENV = (import.meta as any).env || {}
const API = ENV.VITE_API_URL || 'http://localhost:4000'
const TOKEN = 'gam_books_token'
const CLIENT_KEY = 'gam_books_client'

// The same rules as Books' own requests (main.tsx): its pass, the company it
// has open, a dead pass back to sign-in, and a company this bookkeeper no
// longer keeps forgotten so the client picker comes back.
const api = axios.create({ baseURL: `${API}/api` })
api.interceptors.request.use(c => {
  let token: string | null = null
  let client: string | null = null
  try { token = localStorage.getItem(TOKEN); client = localStorage.getItem(CLIENT_KEY) } catch { /* blocked storage */ }
  if (token) c.headers.Authorization = `Bearer ${token}`
  if (client) c.headers['X-Client-Id'] = client
  return c
})
api.interceptors.response.use(r => r, e => {
  if (e?.response?.status === 401) {
    try { localStorage.removeItem(TOKEN) } catch { /* blocked storage */ }
    window.location.href = '/login'
  }
  if (e?.response?.status === 403 && /^You are not assigned to (that company's books|this client)/.test(String(e?.response?.data?.error ?? ''))) {
    try { for (const k of [CLIENT_KEY, 'gam_books_client_name', 'gam_books_client_user']) localStorage.removeItem(k) } catch { /* blocked storage */ }
    window.dispatchEvent(new Event('gam-books-client-gone'))
  }
  return Promise.reject(e)
})
applyCamelizeInterceptor(api)

/** GET → the response's `data`. */
export function booksGet<T = any>(url: string): Promise<T> {
  return api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)
}
/** POST → the whole envelope ({ success, data, message }). */
export function booksPost<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T; message?: string }> {
  return api.post<{ success: boolean; data: T; message?: string }>(url, body).then(r => r.data)
}
/** PATCH → the whole envelope ({ success, data }). */
export function booksPatch<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T }> {
  return api.patch<{ success: boolean; data: T }>(url, body).then(r => r.data)
}

/** A toast; toast.error for a red one. */
export function toast(text: string): void { appToast(text) }
toast.error = (text: string): void => { appToast.error(text) }
export function appConfirm(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return appAsk(message, opts)
}

/** Books' sign-in lives in main.tsx; it tells these pages who is looking. */
export const BooksViewerContext = createContext<{ role: string }>({ role: '' })

/** The signed-in role (a business account's books have no GAM income). */
export function useBooksRole(): string {
  return useContext(BooksViewerContext).role
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

/** Where each page lives in GAM Books (main.tsx routes and sidebar read these). */
export const BOOKS_PATHS: Record<BooksPage, string> = {
  dashboard:       '/dashboard',
  employees:       '/payroll/employees',
  contractors:     '/payroll/contractors',
  vendors:         '/payroll/vendors',
  runPayroll:      '/payroll/runs',
  payHistory:      '/payroll/history',
  taxForms:        '/payroll/tax-forms',
  accounts:        '/books/accounts',
  journal:         '/books/journal',
  transactions:    '/books/transactions',
  reconcile:       '/books/reconcile',
  bills:           '/bills',
  profitLoss:      '/reports/pl',
  balanceSheet:    '/reports/balance-sheet',
  cashFlow:        '/reports/cash-flow',
  ownerStatements: '/reports/owner-statements',
  taxCenter:       '/tax',
  booksSettings:   '/books/settings',
  openingBalances: '/books/opening-balances',
  loans:           '/books/loans',
  fixedAssets:     '/books/fixed-assets',
  categories:      '/books/categories',
  closeMonth:      '/books/close-month',
  trialBalance:    '/reports/trial-balance',
  generalLedger:   '/reports/general-ledger',
}

/** The address of a Books page in this app. */
/**
 * 10/12 (Nic, L5): where this app's Expenses page is — a landlord company's old
 * Books Bills and Transactions moved onto it, and their pages point there.
 */
export function expensesPagePath(): string {
  return '/financials/expenses'
}

export function booksPath(page: BooksPage): string {
  return BOOKS_PATHS[page]
}
