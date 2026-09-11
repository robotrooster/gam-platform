/**
 * S641 — links must point at the deployed product.
 *
 * Nic: "Lisa's email link is trying to go to localhost. You keep sending links
 * to localhost when that's not what we're doing. You need to send links to the
 * real deployed version from now on."
 *
 * He is right that it keeps happening. Lisa's invitation read
 * LANDLORD_PORTAL_URL, a variable that has never existed in any environment —
 * the real one is LANDLORD_APP_URL — so it fell through to localhost:3001 and
 * every team invitation ever sent was unopenable. The signup link had the same
 * shape with a different ending: it fell back to app.goldassetmanagement.com,
 * a host that does not resolve.
 *
 * The last test here is the one that matters: it reads the source and fails if a
 * new link builder invents its own env name with a localhost default.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { portalUrl, portalLink } from './portalUrls'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('S641 portal URLs', () => {
  it('uses the configured URL', () => {
    process.env.LANDLORD_APP_URL = 'https://landlord.goldassetmanagement.com'
    expect(portalUrl('landlord')).toBe('https://landlord.goldassetmanagement.com')
  })

  it('trims a trailing slash so links never double up', () => {
    process.env.TENANT_APP_URL = 'https://tenant.goldassetmanagement.com/'
    expect(portalLink('tenant', '/verify-email')).toBe('https://tenant.goldassetmanagement.com/verify-email')
  })

  // The actual failure: a missing variable, in production, silently becoming a
  // link only this machine can open.
  it('never emits localhost in production, even with nothing configured', () => {
    process.env.NODE_ENV = 'production'
    for (const p of ['landlord', 'tenant', 'admin', 'pos', 'marketing'] as const) {
      delete process.env[
        { landlord: 'LANDLORD_APP_URL', tenant: 'TENANT_APP_URL', admin: 'ADMIN_APP_URL',
          pos: 'POS_APP_URL', marketing: 'MARKETING_URL' }[p]
      ]
      const url = portalUrl(p)
      expect(url).not.toMatch(/localhost|127\.0\.0\.1/)
      expect(url).toMatch(/^https:\/\//)
    }
  })

  it('still points at localhost in development, where that is the right answer', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.LANDLORD_APP_URL
    expect(portalUrl('landlord')).toMatch(/localhost/)
  })

  // ── THE GUARD ────────────────────────────────────────────────────────────
  //
  // A localhost default is FINE when the variable beside it is one production
  // actually sets — it is a dev convenience that never fires. The bug is an
  // INVENTED name: LANDLORD_PORTAL_URL had no value anywhere, so the fallback
  // was not a fallback, it was the behaviour. This flags that shape only, so
  // the check stays worth keeping instead of being switched off.
  it('no link is built from an env var nothing sets', () => {
    // Set in apps/api/.env and verified present in production.
    const CONFIGURED = new Set([
      'LANDLORD_APP_URL', 'TENANT_APP_URL', 'ADMIN_APP_URL', 'POS_APP_URL',
      'MARKETING_URL', 'API_PUBLIC_URL', 'STOREFRONT_URL_TEMPLATE', 'JITSI_BASE_URL',
    ])
    // Surfaces that are not launched and send nobody anything yet. Named here
    // deliberately: when one of them starts emailing, this list is where the
    // conversation about its real URL begins.
    const UNLAUNCHED = new Set([
      'BOOKS_APP_URL', 'PROPERTY_INTEL_APP_URL', 'LISTINGS_APP_URL', 'ADMIN_OPS_APP_URL',
      'PM_COMPANY_APP_URL', 'BUSINESS_APP_URL', 'FITNESS_APP_URL', 'CUSTOMER_PORTAL_URL',
      'STOREFRONT_APP_URL', 'BUSINESS_INVITE_URL',
    ])

    // Internal service endpoints that genuinely live on this machine. Nobody is
    // ever sent one — the model runs on the Mac Studio beside the API.
    const INTERNAL = new Set(['AUTO_FIELD_MODEL_URL', 'OSRM_URL', 'GEOCODER_URL'])

    const root = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
        if (full.endsWith('lib/portalUrls.ts')) continue
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          const m = line.match(/process\.env\.([A-Z_]+)\s*\|\|\s*[`'"]https?:\/\/localhost/)
          if (!m) return
          const name = m[1]
          if (CONFIGURED.has(name) || UNLAUNCHED.has(name) || INTERNAL.has(name)) return
          offenders.push(`${full.replace(root, 'src')}:${i + 1}  ${name}`)
        })
      }
    }
    walk(root)
    expect(offenders, offenders.length
      ? '\nThese build a link from an environment variable NOTHING SETS, so the\n'
        + 'localhost default is not a fallback — it is what every recipient gets.\n'
        + 'Use portalUrl()/portalLink() from lib/portalUrls, or add the name to\n'
        + 'CONFIGURED once it is genuinely set in production:\n\n'
        + offenders.join('\n') + '\n'
      : '').toEqual([])
  })
})
