/**
 * S510 — card-update token generation + email dispatch.
 *
 * Reused by:
 *   - Owner-triggered "Send update-card link" button (businessCustomers route)
 *   - Auto-charge failure path in recurringInvoiceSend.ts
 *
 * Token is 32-byte hex (256 bits). 7-day expiry. Single-use enforced
 * by the public endpoint (marks used_at at the moment the PM swap
 * confirms).
 */

import crypto from 'crypto'
import { queryOne } from '../db'
import { logger } from '../lib/logger'

const TOKEN_TTL_DAYS = 7

interface IssueResult {
  token: string
  url: string
  expiresAt: Date
}

export async function issueCardUpdateToken(args: {
  businessId: string
  customerId: string
  triggeredByInvoiceId?: string | null
  createdByUserId?: string | null
}): Promise<IssueResult> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await queryOne(
    `INSERT INTO business_customer_payment_update_tokens
       (token, business_id, customer_id, triggered_by_invoice_id,
        expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [token, args.businessId, args.customerId,
     args.triggeredByInvoiceId ?? null,
     expiresAt.toISOString(),
     args.createdByUserId ?? null])
  const base = process.env.MARKETING_URL || 'http://localhost:3004'
  return {
    token,
    url: `${base}/update-payment/${token}`,
    expiresAt,
  }
}

/**
 * End-to-end: issue token + send the email. Returns true on email
 * sent, false on silent skip (no customer email on file). Throws on
 * hard failures so callers can surface to the UI; the recurring auto-
 * charge path logs and continues.
 */
export async function sendCardUpdateEmail(args: {
  businessId: string
  customerId: string
  triggeredByInvoiceId?: string | null
  createdByUserId?: string | null
  reasonHint?: 'auto_charge_failed' | 'expired' | 'manual'
}): Promise<boolean> {
  const customer = await queryOne<{
    email: string | null;
    first_name: string | null; last_name: string | null; company_name: string | null;
  }>(
    `SELECT email, first_name, last_name, company_name
       FROM business_customers WHERE id = $1`, [args.customerId])
  if (!customer?.email) {
    logger.info({ customerId: args.customerId },
      '[card-update] customer has no email; skipping')
    return false
  }
  const biz = await queryOne<{ name: string }>(
    `SELECT name FROM businesses WHERE id = $1`, [args.businessId])
  if (!biz) return false

  const issued = await issueCardUpdateToken(args)
  const fullName = `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
  const customerName = customer.company_name || fullName || null

  const { emailBusinessCardUpdateRequest } = await import('./email')
  await emailBusinessCardUpdateRequest({
    to: customer.email,
    customerName,
    businessName: biz.name,
    updateUrl: issued.url,
    expiresAt: issued.expiresAt,
    reasonHint: args.reasonHint ?? 'manual',
    ctx: {
      businessId: args.businessId,
      customerId: args.customerId,
      invoiceId: args.triggeredByInvoiceId ?? null,
    },
  })
  return true
}
