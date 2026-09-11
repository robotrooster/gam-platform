/**
 * S641 — one place that knows where the portals actually live.
 *
 * Nic: "Lisa's email link is trying to go to localhost. You keep sending links
 * to localhost when that's not what we're doing. You need to send links to the
 * real deployed version from now on."
 *
 * He is right that it keeps happening, and the reason is structural rather than
 * careless. Link builders were each written as
 *
 *     process.env.SOME_URL || 'http://localhost:3001'
 *
 * with the env var invented at the call site. `LANDLORD_PORTAL_URL` — the one
 * behind Lisa's invitation — has never existed in any environment: the real
 * variable is LANDLORD_APP_URL. The fallback is not a safety net in that shape,
 * it is a silent default that only reveals itself in somebody's inbox.
 *
 * Two rules here:
 *   1. The name is resolved in ONE place, so a typo cannot invent a new empty
 *      variable at a call site.
 *   2. In production there is no localhost fallback at all. A missing variable
 *      falls back to the KNOWN production host and logs loudly; it never emits a
 *      link nobody outside this machine can open.
 */
import { logger } from './logger'

export type Portal = 'landlord' | 'tenant' | 'admin' | 'pos' | 'marketing'

/** The canonical environment variable for each surface. One name, not several. */
const ENV_VAR: Record<Portal, string> = {
  landlord:  'LANDLORD_APP_URL',
  tenant:    'TENANT_APP_URL',
  admin:     'ADMIN_APP_URL',
  pos:       'POS_APP_URL',
  marketing: 'MARKETING_URL',
}

/**
 * Where each surface lives in production. Used only when the variable is
 * missing — which should never happen, and is logged as an error when it does.
 * Better a correct link and a loud log than a localhost link and silence.
 */
const PRODUCTION_HOST: Record<Portal, string> = {
  landlord:  'https://landlord.goldassetmanagement.com',
  tenant:    'https://tenant.goldassetmanagement.com',
  admin:     'https://admin.goldassetmanagement.com',
  pos:       'https://pos.goldassetmanagement.com',
  marketing: 'https://goldassetmanagement.com',
}

const DEV_HOST: Record<Portal, string> = {
  landlord:  'http://localhost:3001',
  tenant:    'http://localhost:3002',
  admin:     'http://localhost:3003',
  pos:       'http://localhost:3005',
  marketing: 'http://localhost:3004',
}

/** The base URL of a portal, with no trailing slash. */
export function portalUrl(portal: Portal): string {
  const raw = process.env[ENV_VAR[portal]]
  if (raw && raw.trim()) return raw.trim().replace(/\/+$/, '')

  if (process.env.NODE_ENV === 'production') {
    logger.error(
      { portal, expected: ENV_VAR[portal] },
      '[portal-url] environment variable missing in production — using the known host. Set it.',
    )
    return PRODUCTION_HOST[portal]
  }
  return DEV_HOST[portal]
}

/** A link into a portal. `path` may start with or without a slash. */
export function portalLink(portal: Portal, path: string): string {
  const base = portalUrl(portal)
  return `${base}/${String(path).replace(/^\/+/, '')}`
}
