/**
 * 10/11 (Nic): "a bookkeeper in the bookkeeper portal scoped to certain
 * properties should see those properties in the bookkeeper portal as well.
 * We're treating them as two different things and it's not. It's kind of like
 * the point of sale where it's byte identical."
 *
 * Every file in this folder is the SAME BYTES in apps/landlord and apps/books
 * (financials-parity.test.ts) — except this one. It is the only thing that
 * differs between the two apps: how a page talks to the API, shows a toast or
 * a question, and learns who is looking. Keep it tiny; anything a page needs
 * beyond these goes in a shared file, not here.
 *
 * THIS COPY: GAM Books (its own pass, gam_books_token, and the company it has
 * open, sent as X-Client-Id — the same header every Books page sends).
 */
import { createContext, useContext } from 'react'
import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'
import { toast as appToast, appConfirm as appAsk } from '../components/dialogs'

const ENV = (import.meta as any).env || {}
const API = ENV.VITE_API_URL || 'http://localhost:4000'
const TOKEN = 'gam_books_token'
const CLIENT_KEY = 'gam_books_client'

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
  const serverSays = e?.response?.data?.error ?? e?.response?.data?.message
  if (typeof serverSays === 'string' && serverSays.trim()) e.message = serverSays
  if (e?.response?.status === 401) {
    try { localStorage.removeItem(TOKEN) } catch { /* blocked storage */ }
    window.location.href = '/login'
  }
  // 10/11: the open client is no longer one this bookkeeper keeps. Forget it
  // and tell the app (main.tsx), so the client picker comes back.
  if (e?.response?.status === 403 && /^You are not assigned to (that company's books|this client)/.test(String(e?.response?.data?.error ?? ''))) {
    try { for (const k of [CLIENT_KEY, 'gam_books_client_name', 'gam_books_client_user']) localStorage.removeItem(k) } catch { /* blocked storage */ }
    window.dispatchEvent(new Event('gam-books-client-gone'))
  }
  return Promise.reject(e)
})
applyCamelizeInterceptor(api)

/** GET → the response's `data`. */
export function finGet<T = any>(url: string): Promise<T> {
  return api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)
}
/** POST → the whole envelope ({ success, data }). */
export function finPost<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T }> {
  return api.post<{ success: boolean; data: T }>(url, body).then(r => r.data)
}
/** PATCH → the response's `data`. */
export function finPatch<T = any>(url: string, body?: any): Promise<T> {
  return api.patch<{ success: boolean; data: T }>(url, body).then(r => r.data.data)
}
/** A file upload (multipart). */
export function finUpload<T = any>(url: string, form: FormData): Promise<T> {
  return api.post<{ success: boolean; data: T }>(url, form, { headers: { 'Content-Type': 'multipart/form-data' } })
    .then(r => r.data.data)
}
/** Open a file the API serves only to a signed-in viewer (a receipt). */
export async function openProtectedFile(url: string): Promise<void> {
  const path = url.replace(/^\/api/, '')
  const r = await api.get(path, { responseType: 'blob' })
  const blobUrl = URL.createObjectURL(r.data as Blob)
  window.open(blobUrl, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}

/**
 * The one company GAM Books has open (X-Client-Id). Books reads one company's
 * books at a time, so a company list on a shared page is that company alone.
 */
export function pinnedCompanyId(): string | null {
  try { return localStorage.getItem(CLIENT_KEY) } catch { return null }
}

export function toast(text: string): void { appToast(text) }
export function toastError(text: string): void { appToast.error(text) }
export function appConfirm(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return appAsk(message, opts)
}

/** The report tabs a bookkeeper sees (the API serves them nothing else). */
const BOOKKEEPER_CAN = new Set(['reports.tab.overview', 'reports.tab.property', 'reports.export'])

export interface Viewer {
  role: string
  isBookkeeper: boolean
  /** Owners hold everything; a bookkeeper the P&L tabs. */
  can: (perm: string) => boolean
  /** Opens one of the owner's own pages (Balances...), or null where there is none to open. */
  openOwnerPage: ((path: string) => void) | null
}

/** Books' sign-in lives in main.tsx; it tells these pages who is looking. */
export const FinancialsViewerContext = createContext<{ role: string }>({ role: 'landlord' })

/** Is a bookkeeper looking? */
export function useIsBookkeeper(): boolean {
  return useContext(FinancialsViewerContext).role === 'bookkeeper'
}

export function useViewer(): Viewer {
  const { role } = useContext(FinancialsViewerContext)
  const isBookkeeper = role === 'bookkeeper'
  return {
    role,
    isBookkeeper,
    can: (perm: string) => isBookkeeper ? BOOKKEEPER_CAN.has(perm) : true,
    // Balances, Payments and the rest are the landlord portal's, not Books'.
    openOwnerPage: null,
  }
}
