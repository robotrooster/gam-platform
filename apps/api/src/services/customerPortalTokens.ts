/**
 * S502 — customer self-service portal access tokens.
 *
 * A business's customer (no GAM login) gets a reusable link to a portal where
 * they see their invoice history + outstanding balance and pay open invoices.
 * The token is the bearer credential for /api/public/customer/:token.
 *
 * Reusable (unlike the single-use card-update token): the customer returns to
 * the same link through the relationship. 180-day expiry, host-revocable.
 * `getOrCreate` reuses a live token so re-issuing doesn't invalidate a link
 * the customer already has.
 */

import crypto from 'crypto'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

const PORTAL_TOKEN_TTL_DAYS = 180

export function customerPortalUrl(token: string): string {
  const base = process.env.CUSTOMER_PORTAL_URL || 'http://localhost:3014'
  return `${base}/account/${token}`
}

/** Get the customer's current live portal token, or mint a new one. Returns the URL too. */
export async function getOrCreateCustomerPortalToken(args: {
  businessId: string
  customerId: string
  createdByUserId?: string | null
}): Promise<{ token: string; url: string; expiresAt: Date }> {
  const existing = await queryOne<{ token: string; expires_at: string }>(
    `SELECT token, expires_at
       FROM business_customer_portal_tokens
      WHERE customer_id = $1 AND business_id = $2
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [args.customerId, args.businessId]
  )
  if (existing) {
    return { token: existing.token, url: customerPortalUrl(existing.token), expiresAt: new Date(existing.expires_at) }
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await queryOne(
    `INSERT INTO business_customer_portal_tokens
       (token, business_id, customer_id, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [token, args.businessId, args.customerId, expiresAt.toISOString(), args.createdByUserId ?? null]
  )
  return { token, url: customerPortalUrl(token), expiresAt }
}

export interface ResolvedCustomerPortal {
  tokenId: string
  businessId: string
  customerId: string
}

/**
 * Validate a portal token → the business + customer it scopes to. Returns null
 * for unknown / revoked / expired tokens (fails closed). Stamps last_used_at.
 */
export async function resolveCustomerPortalToken(token: string): Promise<ResolvedCustomerPortal | null> {
  if (!token || token.length < 16) return null
  const row = await queryOne<{
    id: string; business_id: string; customer_id: string;
    expires_at: string; revoked_at: string | null;
  }>(
    `SELECT id, business_id, customer_id, expires_at, revoked_at
       FROM business_customer_portal_tokens WHERE token = $1`,
    [token]
  )
  if (!row) return null
  if (row.revoked_at) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null

  await query(
    `UPDATE business_customer_portal_tokens SET last_used_at = now() WHERE id = $1`,
    [row.id]
  ).catch((err) => logger.error({ err }, '[customer-portal] last_used_at stamp failed'))

  return { tokenId: row.id, businessId: row.business_id, customerId: row.customer_id }
}

/**
 * Revoke all live portal tokens for a customer (the off-switch for a leaked /
 * stale link). Stamps revoked_at on every not-yet-revoked token; resolution
 * then fails closed. A subsequent getOrCreate mints a fresh link. Returns the
 * count revoked so the caller can distinguish "killed a link" from "nothing
 * was live". Idempotent — re-running revokes nothing further.
 */
export async function revokeCustomerPortalTokens(args: {
  businessId: string
  customerId: string
}): Promise<{ revoked: number }> {
  const rows = await query<{ id: string }>(
    `UPDATE business_customer_portal_tokens
        SET revoked_at = now()
      WHERE customer_id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [args.customerId, args.businessId]
  )
  return { revoked: rows.length }
}
