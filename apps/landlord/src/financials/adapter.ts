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
 * THIS COPY: the landlord portal (gam_token, its own sign-in and dialogs).
 */
import { useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { api, apiGet, apiPost, apiPatch } from '../lib/api'
import { toast as appToast, appConfirm as appAsk } from '../components/dialogs'
import { useAuth } from '../context/AuthContext'
import { usePerms } from '../lib/permissions'

// The portal's own helpers, so every screen (and every test that stands in
// for them) reaches the API one way.
/** GET → the response's `data`. */
export function finGet<T = any>(url: string): Promise<T> {
  return apiGet<T>(url)
}
/** POST → the whole envelope ({ success, data }). */
export function finPost<T = any>(url: string, body?: any): Promise<{ success: boolean; data: T }> {
  return apiPost<T>(url, body) as Promise<{ success: boolean; data: T }>
}
/** PATCH → the response's `data`. */
export function finPatch<T = any>(url: string, body?: any): Promise<T> {
  return apiPatch<T>(url, body)
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
 * The one company this app has open, when it opens one at a time. The landlord
 * portal reads every company the account owns, so: none.
 */
export function pinnedCompanyId(): string | null { return null }

export function toast(text: string): void { appToast(text) }
export function toastError(text: string): void { appToast.error(text) }
export function appConfirm(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return appAsk(message, opts)
}

/** The report tabs a bookkeeper sees (the API serves them nothing else). */
const BOOKKEEPER_CAN = new Set(['reports.tab.overview', 'reports.tab.property', 'reports.export'])
/**
 * 10/12 (Nic): the report tabs a bookkeeper sees only with the owner's box —
 * the monthly property report ("Sees the monthly property report on screen").
 * Read off GET /financials/scope (the menu reads the same query); the server
 * refuses the report without the box either way.
 */
const BOOKKEEPER_BOX_CAN: Record<string, (scope: { seesMonthlyReport?: boolean }) => boolean> = {
  'reports.tab.monthly': scope => scope.seesMonthlyReport === true,
}

export interface Viewer {
  role: string
  isBookkeeper: boolean
  /** Owners hold everything; a bookkeeper the P&L tabs; staff their own keys. */
  can: (perm: string) => boolean
  /** Opens one of the owner's own pages (Balances...), or null where there is none to open. */
  openOwnerPage: ((path: string) => void) | null
}

/**
 * Is a bookkeeper looking? Reads the sign-in alone (no router), so a company
 * picker can ask it from anywhere a screen puts one.
 */
export function useIsBookkeeper(): boolean {
  const ctx = useAuth() as { user?: { role?: string } | null } | null
  return ctx?.user?.role === 'bookkeeper'
}

export function useViewer(): Viewer {
  const { user } = useAuth()
  const { can } = usePerms()
  const navigate = useNavigate()
  const role = user?.role || 'landlord'
  const isBookkeeper = role === 'bookkeeper'
  const { data: scope } = useQuery<{ seesMonthlyReport?: boolean }>('financials-scope',
    () => apiGet('/financials/scope'), { enabled: isBookkeeper, staleTime: 60_000 })
  const bookkeeperCan = (perm: string) => BOOKKEEPER_CAN.has(perm) || (!!scope && !!BOOKKEEPER_BOX_CAN[perm]?.(scope))
  return {
    role,
    isBookkeeper,
    can: (perm: string) => isBookkeeper ? bookkeeperCan(perm) : can(perm),
    // The portal's own pages, as before — except for a bookkeeper, who has none.
    openOwnerPage: isBookkeeper ? null : (path: string) => navigate(path),
  }
}
