/**
 * Boot-time env validation.
 *
 * Called once from `src/index.ts` before the express app even
 * starts. Throws on missing required vars — better to crash the
 * process at boot than to ship requests against a misconfigured
 * runtime that issues forgeable tokens or silently no-ops.
 *
 * Currently required:
 *   - JWT_SECRET (signing + verify for every authenticated route)
 *
 * Optional but worth flagging when absent (warn-only): Stripe,
 * Resend, Sentry. Their absence is fine in dev and partially-
 * configured envs; warning helps the operator notice.
 */

import { logger } from './logger'

const REQUIRED_VARS = ['JWT_SECRET'] as const

const OPTIONAL_BUT_WARN = [
  ['STRIPE_SECRET_KEY',     'Stripe charges + Connect transfers will fail'],
  ['STRIPE_WEBHOOK_SECRET', 'Stripe webhook verification will reject every event'],
  ['RESEND_API_KEY',        'Outbound email will fail (Resend client unauth)'],
  ['DB_PASSWORD',           'pg client may fail to connect (depending on auth method)'],
] as const

export class EnvValidationError extends Error {
  constructor(public missing: string[]) {
    super(`Missing required env var(s): ${missing.join(', ')}`)
    this.name = 'EnvValidationError'
  }
}

export class DemoSafetyError extends Error {
  constructor(msg: string) { super(msg); this.name = 'DemoSafetyError' }
}

/**
 * S630 (Nic): the demo environment "can never take real payments... it needs to
 * be fully separated" so demo data never bleeds into the real business.
 *
 * A demo instance is identified by its DATABASE, not by a flag someone can
 * forget to set — pointing at gam_demo IS the declaration. Booting one with live
 * Stripe credentials is refused outright rather than warned about, because the
 * failure mode is charging a real card during a sales call, and a warning in a
 * log nobody reads is not a control.
 *
 * Deliberately also refuses the reverse: production must never run against the
 * demo database, or real tenants would be reading seeded data.
 */
export function assertDemoIsolation(): void {
  const db = String(process.env.DB_NAME || '')
  const isDemoDb = /demo/i.test(db)
  const stripeKey = String(process.env.STRIPE_SECRET_KEY || '')
  const liveStripe = stripeKey.startsWith('sk_live')

  if (isDemoDb && liveStripe) {
    throw new DemoSafetyError(
      `Refusing to start: DB_NAME="${db}" is a demo database but STRIPE_SECRET_KEY is a LIVE key ` +
      `(sk_live…). A demo instance must never be able to move real money. ` +
      `Use a test key, or unset STRIPE_SECRET_KEY entirely.`)
  }
  if (!isDemoDb && process.env.GAM_DEMO_MODE === 'true') {
    throw new DemoSafetyError(
      `Refusing to start: GAM_DEMO_MODE=true but DB_NAME="${db}" is not a demo database. ` +
      `A demo instance must not run against real customer data.`)
  }
}

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new EnvValidationError([...missing])
  }
  assertDemoIsolation()
  for (const [k, why] of OPTIONAL_BUT_WARN) {
    if (!process.env[k]) {
      logger.warn({ envVar: k, impact: why }, 'optional env var unset')
    }
  }
}
