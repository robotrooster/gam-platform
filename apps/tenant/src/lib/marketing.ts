/**
 * S636 (Nic): the Terms of Service and Privacy Policy links on the invite
 * acceptance page were unusable in two separate ways.
 *
 * 1. They sat inside the <label> wrapping the "I agree" checkbox, so a click on
 *    a link was forwarded to the control — you toggled the box instead of
 *    opening the document. See the stopPropagation at the call site.
 * 2. This URL fell back to http://localhost:3004, and VITE_MARKETING_URL was
 *    not set when the tenant app was built. The DEPLOYED bundle carried
 *    localhost six times over, so every one of these links pointed a resident's
 *    phone at their own machine.
 *
 * The fallback is now the real site, and localhost is used only when the app is
 * actually being served from localhost. A missing build variable can no longer
 * ship a dead link to a tenant.
 */
const isLocal = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')

export const MARKETING_URL: string =
  (import.meta as any).env?.VITE_MARKETING_URL ||
  (isLocal ? 'http://localhost:3004' : 'https://goldassetmanagement.com')

export const CONSUMER_TERMS_URL = `${MARKETING_URL}/consumer/terms`
export const CONSUMER_PRIVACY_URL = `${MARKETING_URL}/consumer/privacy`
