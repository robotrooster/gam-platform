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
 *
 * S654 — THE PASSWORD LINK HAS RULES OF ITS OWN.
 *
 * The setup link sets the account's password. Landlord B put landlord A's
 * invitee on B's own lease with B's address in the signer's email box, signed,
 * and this function handed over the live token A had already sent the invitee —
 * mailed to B. B then set the invitee's password and accepted the terms in
 * their name. So a setup link goes out only when ALL of these hold:
 *
 *   - the account still needs setting up (placeholder password, invite never
 *     accepted);
 *   - the address it will be mailed to is the one on the account, in any
 *     letter case. A caller says where it is sending (`sendTo`); a caller that
 *     doesn't is mailing the signer row's address, so that is what is checked;
 *   - a token is minted, or its clock restarted, only for an account that
 *     belongs to no company outside the document's own account
 *     (accountTiedElsewhere). Another company's invitee is left exactly as
 *     that company left them: a live link they already hold rides along to
 *     their own address unchanged, so either email sets them up; with none,
 *     nothing is minted and they get the plain signing link, which works
 *     without a password (S629);
 *   - a token the account already holds is reused only while it is still
 *     live. One that has run out is replaced with a fresh one, never given
 *     more days: it may have been mailed to an address since corrected.
 *
 * Anything else gets the plain signing link, and the account's token is not
 * read, minted or extended.
 *
 * Callers that mail the link say where with `sendTo`, and send to the address
 * on the signer's own account (the landlord's row keeps its own; see
 * signerDeliveryAddress in routes/esign.ts).
 */
import { randomBytes } from 'crypto'
import { queryOne, query } from '../db'
import { portalUrl } from '../lib/portalUrls'

const PLACEHOLDER_HASH = '$2b$10$placeholder_invite_pending'

/** How long a freshly dispatched setup link stays valid. Matches the invite route. */
const SETUP_LINK_DAYS = 7

// S654: through portalUrl, never a localhost fallback (S641).
function tenantAppUrl(): string {
  return portalUrl('tenant')
}

export interface TenantLeaseLink {
  url: string
  /** True when this link also sets up their account. Drives the email copy. */
  needsSetup: boolean
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

export async function tenantLeaseLink(args: {
  userId: string | null
  documentId: string
  signerToken?: string | null
  /**
   * S654: the address this link will be mailed to. Left out, it is the
   * signer row's address on this document, which is where every caller that
   * omits it sends.
   */
  sendTo?: string | null
}): Promise<TenantLeaseLink> {
  const signUrl = `${tenantAppUrl()}/sign/${args.signerToken || args.documentId}`
  if (!args.userId) return { url: signUrl, needsSetup: false }

  const u = await queryOne<{ needs_setup: boolean; token: string | null; live: boolean; email: string }>(
    `SELECT (password_hash = $2 AND tenant_invite_accepted_at IS NULL) AS needs_setup,
            tenant_invite_token AS token,
            COALESCE(tenant_invite_expires_at > NOW(), false) AS live,
            email
       FROM users WHERE id = $1`, [args.userId, PLACEHOLDER_HASH])
  if (!u?.needs_setup) return { url: signUrl, needsSetup: false }

  // S654: the document's company and this account's place on it. No document,
  // or no seat on it for this account, means no setup link.
  const seat = await queryOne<{ landlord_id: string; signer_email: string | null }>(
    `SELECT d.landlord_id, s.email AS signer_email
       FROM lease_documents d
       LEFT JOIN lease_document_signers s ON s.document_id = d.id AND s.user_id = $2
      WHERE d.id = $1
      ORDER BY (s.token = $3) DESC NULLS LAST
      LIMIT 1`, [args.documentId, args.userId, args.signerToken ?? null])
  if (!seat?.signer_email) return { url: signUrl, needsSetup: false }

  // S654: only to the address on the account itself.
  const sendTo = args.sendTo ?? seat.signer_email
  if (!sameAddress(sendTo, u.email)) return { url: signUrl, needsSetup: false }

  const next = encodeURIComponent(`/sign/${args.documentId}`)
  const setupUrl = (token: string) => `${tenantAppUrl()}/accept-invite?token=${token}&next=${next}`

  // S654: nothing is minted or extended for an account another company holds.
  // "Own" is every company the document's account holds (account_companies),
  // the same set the other doors pass as [landlordId, ...landlordScopeIds].
  // Their own live link, if they have one, goes along untouched — to their own
  // address only, checked above.
  const own = await query<{ id: string }>(
    `SELECT account_companies($1::uuid) AS id`, [seat.landlord_id])
  const { accountTiedElsewhere } = await import('../jobs/leaseParser/resolveIntent')
  if (await accountTiedElsewhere(args.userId, own.map(r => r.id))) {
    return u.token && u.live
      ? { url: setupUrl(u.token), needsSetup: true }
      : { url: signUrl, needsSetup: false }
  }

  // Reuse the token they may already hold from an older invite email, so both
  // that email and this one work — but only while it is still live. Either way
  // the clock restarts NOW: the lease may have been drafted days before the
  // landlord signed it, and a link that is dead on arrival is worse than none.
  // S654: the rules above make that token this company's own invite.
  //
  // S654: a token that has run out (or never had a clock) is never revived.
  // One was minted at invite time and mailed to a mistyped address; the
  // landlord corrected the address and signed eight days later, and this
  // function used to give that same token seven more days — so whoever reads
  // the mistyped mailbox held a working password link. A run-out token is
  // replaced with a fresh one, sent only to the account's own address.
  //
  // One statement, so the "still live?" test and the write cannot be split by
  // a second send landing at the same moment: whichever runs second finds the
  // fresh token live and keeps it, and the first email's link keeps working.
  // The setup test is repeated here so an account set up in the meantime is
  // left alone.
  const set = await queryOne<{ token: string }>(
    `UPDATE users
        SET tenant_invite_token = CASE
              WHEN tenant_invite_token IS NOT NULL AND tenant_invite_expires_at > NOW()
                THEN tenant_invite_token
              ELSE $2 END,
            tenant_invite_expires_at = NOW() + ($3 || ' days')::interval,
            tenant_invite_sent_at = COALESCE(tenant_invite_sent_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND password_hash = $4 AND tenant_invite_accepted_at IS NULL
      RETURNING tenant_invite_token AS token`,
    [args.userId, randomBytes(32).toString('hex'), String(SETUP_LINK_DAYS), PLACEHOLDER_HASH])
  if (!set?.token) return { url: signUrl, needsSetup: false }

  return { url: setupUrl(set.token), needsSetup: true }
}
