/**
 * S647 — the ONE link a tenant gets for their lease.
 *
 * Nic (S647, DIRECTIVE), describing the flow as designed: "When I type in a
 * bunch of names to send invites to, it doesn't send them. It drafts up a bunch
 * of leases for me to sign. After I sign it, they click the email, and
 * acceptance and signing all becomes one flow for the tenant."
 *
 * So a tenant who has never set up their account does not get a bare signing
 * link — that is how a resident ends up with two emails, one to "accept" and
 * one to "sign", and believes the first was the second. They get the portal
 * invite link, carrying the lease as its destination: set a password, enter
 * the emailed code, land on the signature. One email, one flow.
 *
 * A tenant who already has a working login gets the ordinary signing link.
 *
 * Every place that emails a TENANT about a lease to sign goes through here —
 * the relay after the landlord signs, the daily reminders, the 48-hour resend,
 * and the landlord's manual "remind" button — so none of them can drift back to
 * the two-email shape.
 */
import { randomBytes } from 'crypto'
import { queryOne, query } from '../db'

const PLACEHOLDER_HASH = '$2b$10$placeholder_invite_pending'

/** How long a freshly dispatched setup link stays valid. Matches the invite route. */
const SETUP_LINK_DAYS = 7

function tenantAppUrl(): string {
  return process.env.TENANT_APP_URL || 'http://localhost:3002'
}

export interface TenantLeaseLink {
  url: string
  /** True when this link also sets up their account. Drives the email copy. */
  needsSetup: boolean
}

export async function tenantLeaseLink(args: {
  userId: string | null
  documentId: string
  signerToken?: string | null
}): Promise<TenantLeaseLink> {
  const signUrl = `${tenantAppUrl()}/sign/${args.signerToken || args.documentId}`
  if (!args.userId) return { url: signUrl, needsSetup: false }

  const u = await queryOne<{ needs_setup: boolean; token: string | null }>(
    `SELECT (password_hash = $2 AND tenant_invite_accepted_at IS NULL) AS needs_setup,
            tenant_invite_token AS token
       FROM users WHERE id = $1`, [args.userId, PLACEHOLDER_HASH])
  if (!u?.needs_setup) return { url: signUrl, needsSetup: false }

  // Reuse the token they may already hold from an older invite email, so both
  // that email and this one work; mint one only if there is none. Either way
  // the clock restarts NOW — the lease may have been drafted days before the
  // landlord signed it, and a link that is dead on arrival is worse than none.
  const token = u.token || randomBytes(32).toString('hex')
  await query(
    `UPDATE users
        SET tenant_invite_token = $2,
            tenant_invite_expires_at = NOW() + ($3 || ' days')::interval,
            tenant_invite_sent_at = COALESCE(tenant_invite_sent_at, NOW()),
            updated_at = NOW()
      WHERE id = $1`, [args.userId, token, String(SETUP_LINK_DAYS)])

  const next = encodeURIComponent(`/sign/${args.documentId}`)
  return {
    url: `${tenantAppUrl()}/accept-invite?token=${token}&next=${next}`,
    needsSetup: true,
  }
}
