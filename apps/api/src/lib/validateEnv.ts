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

export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new EnvValidationError([...missing])
  }
  for (const [k, why] of OPTIONAL_BUT_WARN) {
    if (!process.env[k]) {
      logger.warn({ envVar: k, impact: why }, 'optional env var unset')
    }
  }
}
