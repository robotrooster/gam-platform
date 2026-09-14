/**
 * PM-company twin of apps/tenant/src/lib/marketing.ts (S636). The pm-company
 * registration page carried the exact bug S636 fixed for tenants: its
 * Terms/Privacy hrefs fell back to http://localhost:3004 because
 * VITE_MARKETING_URL was never set in any deployed build — so the "read the
 * terms" link on the consent step pointed a registering PM company at their own
 * machine.
 *
 * The fallback is the real site; localhost is used only when the app itself is
 * being served from localhost. A missing build variable can no longer ship a
 * dead link.
 */
const isLocal = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

export const MARKETING_URL: string =
  (import.meta as any).env?.VITE_MARKETING_URL ||
  (isLocal ? 'http://localhost:3004' : 'https://goldassetmanagement.com')

export const BUSINESS_TERMS_URL = `${MARKETING_URL}/business/terms`
export const BUSINESS_PRIVACY_URL = `${MARKETING_URL}/business/privacy`
