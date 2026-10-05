import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, userHasPerm } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emailTenantInvite } from '../services/email'
import { isDisposableEmail } from '../lib/email'
import { logger } from '../lib/logger'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'
import { signEmailOtpSessionToken, issueEmailOtp } from './emailOtp'
import { applyScreeningWaive, WAIVER_NOT_RECORDED_MESSAGE } from '../services/onboardingWindow'
import { landlordScopeIds } from '../lib/landlordScope'
import { portalLink } from '../lib/portalUrls'

export const tenantsRouter = Router()

// ── PRE-AUTH PUBLIC ROUTES ────────────────────────────────────
// Declared BEFORE tenantsRouter.use(requireAuth) below so the
// router-level middleware doesn't gate them. Two flavors:
//   1. Invite onboarding routes — the invite token IS the auth.
//      An invited tenant has no JWT yet when they click the
//      invite link, so requireAuth would 401 them and break
//      onboarding.
//   2. Avatar file serve — used by <img src> elements that don't
//      send the Authorization header. Gating these returned 401
//      to every avatar load (S380 fix). Filename param is sanitized
//      via path.basename to block ../ traversal.

// POST /api/tenants/accept-invite — tenant sets password and activates account
// S537: landlord-scoped tenant list — the picker feed for the landlord
// portal (lease form, screening, entry requests, FlexCharge, POS tab).
// This root GET was missing since the beginning: five pages called it
// and silently rendered empty pickers off the 404. Returns every tenant
// with any lease under the calling landlord (newest lease's unit for
// display), deduped.
tenantsRouter.get('/', requireAuth, async (req: any, res, next) => {
  try {
    // S633: every tenant under every company the account owns. This is the
    // picker five landlord screens read from — scoped to one entity it silently
    // dropped half the roster, which reads as "that tenant isn't on GAM".
    const landlordIds = landlordScopeIds(req.user!)
    if (!landlordIds.length) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(
      `SELECT DISTINCT ON (t.id)
              t.id, uu.first_name, uu.last_name, uu.email, uu.phone,
              un.unit_number, p.name AS property_name, l.status AS lease_status
         FROM tenants t
         JOIN users uu ON uu.id = t.user_id
         JOIN lease_tenants lt ON lt.tenant_id = t.id
         JOIN leases l ON l.id = lt.lease_id
         JOIN units un ON un.id = l.unit_id
         JOIN properties p ON p.id = un.property_id
        WHERE l.landlord_id = ANY($1::uuid[])
        ORDER BY t.id, l.created_at DESC`,
      [landlordIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// S654: the only accounts an invite link may activate.
const INVITE_ACCOUNT_ROLES: readonly string[] = ['tenant', 'contact']

const PLACEHOLDER_HASH = '$2b$10$placeholder_invite_pending'

/**
 * S654: accept-invite is FIRST-TIME SETUP only. The link sets the account's
 * password, so it works only on an account still waiting for its first one:
 * the placeholder password every invite door writes. Landlord B's utility
 * agreement once minted a token on a resident who had signed up through
 * screening with a password of their own (so had never "accepted" an invite),
 * and this route took that token and replaced their working password.
 *
 * One other shape is still first-time: an e-sign contact minted by
 * services/signerAccounts (S568) carries an unguessable random hash instead of
 * the placeholder. Contacts are only ever created that way, and every route
 * that sets a password (this one, reset-password, change-password) stamps
 * sessions_valid_from, so a contact with none — and no sign-in — has never had
 * a password anyone knows.
 *
 * Mirrored in SQL by FIRST_TIME_SETUP_SQL for /invite-info.
 */
function stillFirstTimeSetup(u: { password_hash: string; role: string; sessions_valid_from: Date | null; last_login_at: Date | null }): boolean {
  if (u.password_hash === PLACEHOLDER_HASH) return true
  return u.role === 'contact' && !u.sessions_valid_from && !u.last_login_at
}
const FIRST_TIME_SETUP_SQL = `(password_hash = '${PLACEHOLDER_HASH}'
   OR (role = 'contact' AND sessions_valid_from IS NULL AND last_login_at IS NULL))`

tenantsRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const { token, password, phone, ssiSsdi, acceptedTerms } = req.body
    if (!token || !password) return res.status(400).json({ success: false, error: 'Token and password required' })
    if (password.length < 12) return res.status(400).json({ success: false, error: 'Password must be at least 12 characters' })
    if (acceptedTerms !== true) return res.status(400).json({ success: false, error: 'You must accept the Terms of Service and Privacy Policy to activate your account' })

    // ── S637: ACTIVATION IS ONE TRANSACTION, AND THE TOKEN GOES LAST ────────
    //
    // Laurel Rhoades, MH 02 Mountain View, 2026-09-02 19:18. She set a password
    // and a phone number, the page told her it failed, and her retry said
    // "invalid or expired invite link". Both were true at once: her password,
    // phone and terms acceptance were SAVED, and her invite token was already
    // gone — cleared by the same statement, two lines in — while her invite was
    // never marked accepted and her lease was never drafted. She was stranded
    // between having an account and not having one, with the only way back in
    // already spent.
    //
    // The route ran with no transaction at all, and three statements after that
    // UPDATE were unguarded while every other side effect in it sat in a
    // try/catch. One of them threw. Which one hardly matters: the shape was
    // that a single-use credential was consumed BEFORE the work it authorized
    // was done, so any failure anywhere after it cost the tenant their only
    // route in.
    //
    // Now: everything that defines the account lands together or not at all,
    // and the token is cleared in the SAME transaction as the work it pays for.
    // A rollback leaves the token intact, so the tenant simply tries again and
    // the link still works. Everything after the commit — lease drafting, the
    // landlord notification, the 2FA code — is best-effort by design and can
    // never un-activate an account that already exists.
    //
    // SELECT ... FOR UPDATE, because two taps on a slow phone are two requests:
    // the second blocks until the first commits, then finds no token and is
    // refused, rather than both racing through and double-drafting a lease.
    const client = await getClient()
    let user: any
    let tenant: any
    try {
      await client.query('BEGIN')

      // S654: a live link has a clock. An unaccepted token with no expiry is
      // dead (every invite door writes one); the NULL case is kept only for a
      // link already spent, whose expiry activation clears, so its holder
      // still hears ALREADY_ACCEPTED below.
      user = (await client.query(
        `SELECT * FROM users
          WHERE tenant_invite_token = $1
            AND (tenant_invite_expires_at > NOW() OR tenant_invite_accepted_at IS NOT NULL)
          FOR UPDATE`,
        [token])).rows[0]

      // S654: an invite link only sets up a resident's account, or an e-sign
      // signer's contact account (S568 activates those here too). Any other
      // login is an invalid link: a token that reached a landlord's or staff
      // account must never set its password.
      if (user && !INVITE_ACCOUNT_ROLES.includes(user.role)) user = undefined

      // S654: and only while the account still needs its first password. An
      // account that finished setup through this link is told so just below
      // (ALREADY_ACCEPTED); any other account with a password of its own gets
      // the same answer as a link that never existed, and nothing is written.
      if (user && !user.tenant_invite_accepted_at && !stillFirstTimeSetup(user)) user = undefined

      // ── S637: "ALREADY DONE" IS NOT "EXPIRED" ──────────────────────────
      //
      // Nic: "Several more people tell me that their invite expired when they
      // already accepted it... they think that it locked them out, and they
      // need a new invite."
      //
      // They were right to be confused: activation used to clear the token, so
      // a tenant reopening their own email looked identical to someone holding
      // a bad link, and both were told the link was invalid or expired. For
      // somebody who had just successfully set a password, that is false and it
      // reads as being locked out of an account that exists and works.
      //
      // The token is kept now and marked accepted instead. It authorizes
      // nothing once accepted — this branch refuses it — so a forwarded link is
      // not a way in. It exists only so we can tell them the truth.
      if (user?.tenant_invite_accepted_at) {
        await client.query('ROLLBACK')
        return res.status(409).json({
          success: false,
          code: 'ALREADY_ACCEPTED',
          error: 'You have already set up your account with this link. Sign in with your email and password — you do not need a new invite.',
        })
      }
      if (!user) {
        await client.query('ROLLBACK')
        return res.status(404).json({ success: false, error: 'Invalid or expired invite link' })
      }

      const bcrypt = require('bcryptjs')
      const hash = await bcrypt.hash(password, 10)

      // S29X: stamp terms acceptance on activation. Landlord-created users are
      // inserted with NULL acceptance timestamps; the tenant accepts here when
      // they take over their account for the first time.
      //
      // S578: email-2FA is switched on as part of the SAME write. It used to be
      // a separate UPDATE near the end of the route, which is how Laurel ended
      // up with a password but email_2fa_enabled still false — a half-built
      // account whose state depended on how far the request happened to get.
      //
      // S637: the token is spent HERE, in the transaction, so it is spent only
      // if the activation it authorizes actually commits. It is MARKED rather
      // than deleted — see the ALREADY_ACCEPTED branch above. The expiry is
      // cleared so an accepted invite never also reports as timed out.
      await client.query(
        `UPDATE users SET password_hash=$1, sessions_valid_from=NOW(),
                          tenant_invite_accepted_at=NOW(),
                          tenant_invite_expires_at=NULL,
                          email_verified=TRUE,
                          email_2fa_enabled=TRUE,
                          phone=COALESCE($2,phone),
                          accepted_tos_at=NOW(), accepted_privacy_at=NOW()
           WHERE id=$3`,
        [hash, phone || null, user.id])

      if (ssiSsdi !== undefined) {
        await client.query('UPDATE tenants SET ssi_ssdi=$1 WHERE user_id=$2', [!!ssiSsdi, user.id])
      }

      // S616 (Nic): a UTILITY-SERVICE payer agreeing to be billed.
      //
      // A serviced space's payer has no lease, no application and no prior
      // relationship with GAM — accepting this invite is the only moment they
      // ever consent to anything. Until it happens (or the landlord attests they
      // agreed off-platform) their charges accrue but no invoice is issued, so
      // this stamp is what actually releases the billing.
      await client.query(
        `UPDATE utility_service_agreements sa
            SET payer_accepted_at = NOW(), updated_at = NOW()
           FROM tenants t
          WHERE t.user_id = $1
            AND sa.tenant_id = t.id
            AND sa.status = 'active'
            AND sa.payer_accepted_at IS NULL`,
        [user.id])

      // S568: role-aware — activate the account under the user's ACTUAL role.
      // Real tenants keep role='tenant' (unchanged); an e-sign 'contact'
      // (customer pool, no tenant profile) activates as 'contact' with a null
      // profileId so they're never mis-issued a tenant identity.
      tenant = (await client.query('SELECT id FROM tenants WHERE user_id=$1', [user.id])).rows[0] ?? null

      await client.query('COMMIT')
    } catch (e) {
      // The token is still on the user, so the link the tenant already has in
      // their inbox keeps working. That is the whole point.
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      throw e
    }
    client.release()

    // S558 (Flow B): stamp this person's unit-bound intent as accepted, then
    // auto-draft the lease(s) if the unit's roster is now ready. Best-effort in
    // its own transaction — a draft failure never blocks the tenant's login.
    try {
      // S629 (Nic): a person can hold invites to SEVERAL units — two spots, two
      // leases, one login. This took LIMIT 1, so accepting drafted a lease for
      // the newest invite and left the other sitting there for ever, with the
      // tenant given no way to reach it. Every open invite is accepted and
      // drafted on the way in.
      // S652 (Nic, Shannon Gregory): the invite is ACCEPTED the moment the person
      // sets their account up — whether or not the lease already issued on the
      // landlord's signature. Only the invites still waiting to draft were being
      // stamped, so a co-tenant whose lease had existed since the 16th accepted
      // on the 22nd and the front desk kept saying she had not.
      await query(
        `UPDATE pending_tenant_intents pti SET accepted_at = NOW(), updated_at = NOW()
           FROM tenants t
          WHERE t.id = pti.tenant_id AND t.user_id = $1
            AND pti.cancelled_at IS NULL AND pti.accepted_at IS NULL`, [user.id])
      const intents = await query<{ id: string; unit_id: string }>(
        `SELECT pti.id, pti.unit_id
           FROM pending_tenant_intents pti JOIN tenants t ON t.id = pti.tenant_id
          WHERE t.user_id = $1 AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL AND pti.unit_id IS NOT NULL
          ORDER BY pti.created_at`, [user.id])
      for (const intent of intents) {
        const draftClient = await getClient()
        try {
          await draftClient.query('BEGIN')
          await draftClient.query(`UPDATE pending_tenant_intents SET accepted_at=NOW(), updated_at=NOW() WHERE id=$1 AND accepted_at IS NULL`, [intent.id])
          const { autoDraftLeasesForUnit } = await import('../services/leaseOnboarding')
          const { createDocumentRecord } = await import('./esign')
          const out = await autoDraftLeasesForUnit(draftClient as any, intent.unit_id, createDocumentRecord)
          await draftClient.query('COMMIT')
          // S636: send AFTER the commit — autoSendDraftedDocument reads through
          // the pool and cannot see rows this transaction has not committed yet.
          // Best-effort: a mail failure must not undo a lease that exists.
          const { autoSendDraftedDocument } = await import('./esign')
          for (const docId of out.draftedDocumentIds) {
            await autoSendDraftedDocument(docId).catch(err =>
              logger.error({ err, docId }, '[ONBOARD-NEW-LEASE] auto-send after draft failed'))
          }
        } catch (draftErr) {
          await draftClient.query('ROLLBACK').catch(() => {})
          logger.error({ err: draftErr, ctx: user.id }, '[ONBOARD-NEW-LEASE] auto-draft on accept failed')
        } finally {
          draftClient.release()
        }
      }
    } catch (e) {
      logger.error({ err: e, ctx: user.id }, '[ONBOARD-NEW-LEASE] accept-intent lookup failed')
    }

    // S174: notify the landlord that their invited tenant accepted. Best-
    // effort — failure here doesn't roll back the activation. Resolves the
    // landlord via the tenant's most-recent active lease; if no lease is
    // attached yet (rare — invitations usually fire from a lease build),
    // skip the notify.
    try {
      // S186: routed through responsible-party resolver. Tenant
      // onboarding is a day-to-day manager event, not owner-financial.
      const ctx = await queryOne<{
        landlord_id_pk: string
        property_id:    string
        unit_number:    string
        property_name:  string
      }>(`
        SELECT l.id  AS landlord_id_pk,
               pr.id AS property_id,
               un.unit_number,
               pr.name AS property_name
          FROM v_lease_active_tenants vlat
          JOIN tenants    t  ON t.id = vlat.tenant_id
          JOIN leases     ls ON ls.id = vlat.lease_id AND ls.status = 'active'
          JOIN units      un ON un.id = ls.unit_id
          JOIN properties pr ON pr.id = un.property_id
          JOIN landlords  l  ON l.id = pr.landlord_id
         WHERE t.user_id = $1
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
      `, [user.id])
      if (ctx) {
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(ctx.property_id)
        if (targets) {
          const { notifyTenantInviteAccepted } = await import('../services/notifications')
          for (const recipient of targets.primaries) {
            await notifyTenantInviteAccepted({
              landlordUserId: recipient.user_id,
              landlordId:     ctx.landlord_id_pk,
              landlordEmail:  recipient.email,
              tenantName:     `${user.first_name} ${user.last_name}`,
              tenantEmail:    user.email,
              unitNumber:     ctx.unit_number,
              propertyName:   ctx.property_name,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[tenant-invite-accepted-notify] failed:')
    }

    // S578 (Nic): mandatory email-2FA at activation — same posture as the
    // landlord /register + prospect signup paths. The landlord created this user
    // with email_2fa_enabled defaulting off; flip it on and issue a PENDING
    // session (not a full token). The client trades the emailed 6-digit code at
    // /api/auth/email-otp/verify for the real token; that verify step also marks
    // the email verified. The lease auto-draft + landlord notify above still run
    // at accept time (activation), independent of the 2FA gate.
    // S637: the 2FA flag is now set inside the activation transaction above —
    // it is part of what the account IS, not a step that may or may not be
    // reached. What remains here is the code SEND, which talks to an email
    // provider and is therefore the single most likely thing in this route to
    // fail on a bad day.
    //
    // It is guarded, and its failure does NOT fail the request. The account is
    // already committed and the token is already spent; throwing here would
    // hand back an error for an activation that genuinely happened — which is
    // exactly how Laurel ended up locked out. The client is told whether the
    // code actually went, so it can say "we couldn't send your code, tap
    // resend" instead of "invalid link".
    const emailOtpSession = signEmailOtpSessionToken({
      userId: user.id, role: user.role, email: user.email, profileId: tenant?.id ?? null,
      landlordId: null, landlordIds: null, businessId: null, staffRole: null, permissions: null,
    })
    let otpSent = true
    try {
      await issueEmailOtp(user.id, user.email)
    } catch (e) {
      otpSent = false
      logger.error({ err: e, ctx: user.id }, '[accept-invite] activation committed but the 2FA code could not be sent')
    }

    res.json({
      success: true,
      data: {
        requiresEmailOtp: true, emailOtpSession, otpSent,
        user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
      }
    })
  } catch (e) { next(e) }
})

// GET /api/tenants/invite-info?token= — get invite details without auth
tenantsRouter.get('/invite-info', async (req, res, next) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).json({ success: false, error: 'Token required' })

    // S410 (S377): read tenant_invite_token + enforce expiry.
    // S654: the same accounts accept-invite would take — first-time setup, or
    // one that finished setup through this link (the page then says so).
    const user = await queryOne<any>(
      `SELECT id, email, first_name, last_name FROM users
        WHERE tenant_invite_token = $1
          AND (tenant_invite_expires_at > NOW() OR tenant_invite_accepted_at IS NOT NULL)
          AND role = ANY($2::text[])
          AND (tenant_invite_accepted_at IS NOT NULL OR ${FIRST_TIME_SETUP_SQL})`,
      [token as string, INVITE_ACCOUNT_ROLES])
    if (!user) return res.status(404).json({ success: false, error: 'Invalid or expired invite' })

    const unit = await queryOne<any>(`
      SELECT u.unit_number, u.rent_amount, p.name as property_name, p.street1, p.city, p.state
      FROM v_lease_active_tenants vlat
      JOIN tenants t ON t.id = vlat.tenant_id
      JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE t.user_id = $1
      ORDER BY (vlat.role = 'primary') DESC
      LIMIT 1`, [user.id])

    res.json({ success: true, data: { user, unit } })
  } catch (e) { next(e) }
})

// GET /api/tenants/avatar-files/:filename — public static serve.
// avatarDir is defined further down (after requireAuth) for the
// POST /avatar route; compute path inline here to avoid hoisting
// the constant above the rest of the module state.
tenantsRouter.get('/avatar-files/:filename', async (req: any, res: any, next: any) => {
  try {
    // path.basename strips any directory components from the param —
    // blocks ../../etc/passwd traversal attempts. Multer writes
    // filenames as Date.now()-randomHex+ext, so a legit filename
    // is always already a basename.
    const safe = path.basename(req.params.filename)
    const fp = path.join(process.cwd(), 'uploads', 'avatars', safe)
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    // S409 (S398 Nic-locked decision): "strong fix" — always serve
    // avatars with image/* Content-Type regardless of on-disk extension.
    // Belt-and-suspenders defense against the XSS extension-mismatch
    // class: even if a legacy file on disk has a .html extension from
    // pre-upload-normalization (or some future upload bug),
    // res.sendFile would normally derive Content-Type from extname →
    // text/html → browser executes as HTML. Pinning the header upfront
    // means the on-disk extension can never drive Content-Type.
    const extLower = path.extname(safe).toLowerCase()
    const contentType =
      extLower === '.png'  ? 'image/png'  :
      extLower === '.webp' ? 'image/webp' :
      extLower === '.gif'  ? 'image/gif'  :
      'image/jpeg'  // .jpg/.jpeg/anything else
    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(fp)
  } catch(e) { next(e) }
})

// ──────────────────────────────────────────────────────────────
tenantsRouter.use(requireAuth)

// ── S637: NOTHING TENANT-FACING SAYS ANYTHING ABOUT THE LANDLORD'S BANK ──
//
// Nic (DIRECTIVE, verbatim): "as long as there's nothing that tells the tenants
// that they can't pay yet, that's fine. The tenants need to be able to pay. I
// don't want any forward facing messages that tell them anything about our bank
// account."
//
// Two endpoints lived here and both are deleted:
//
//   GET  /me/landlord-banking-status  (S162) — reported the landlord's Connect
//        readiness to the tenant as a `ready` boolean. No client ever called it.
//   POST /me/nudge-landlord-banking   (S163) — let a tenant email their landlord
//        a reminder to finish setting up their bank details.
//
// Both rested on a premise that is false: that a landlord without a payout-ready
// Connect account stops their tenant paying. routes/payments.ts:389 does the
// opposite on purpose — it falls back to a standard charge, holds the money on
// GAM's platform balance (platform_held), and services/landlordPassthrough.ts
// releases it when Connect completes. Rent collects the entire time.
//
// So the nudge told a tenant their landlord had not finished their banking AND
// blamed a payment failure that never happened. The tenant agent carried it as
// a described action (services/agents/portalActions.ts, removed with this), which
// meant a tenant asking "why can't I pay?" would have been told about their
// landlord's bank account. That is a disclosure across the audience boundary,
// and it was not even true.
//
// The landlord is still prompted to finish Connect — on THEIR side, through
// /landlords/me/todos. A tenant is not the right messenger for it.
//
// Do not reintroduce either endpoint. If a tenant genuinely cannot pay, the
// reason will be about THEIR payment method, and it belongs in that error.

tenantsRouter.get('/me', async (req, res, next) => {
  try {
    // S655: a new lease whose lease before it ended early, nobody signed — not theirs to sign.
    const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
    const tenant = await queryOne<any>(`
      SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
        u.stripe_connect_account_id,
        -- S637 (Nic, the Fierro household at MH 07): a lease document that this
        -- person is a signer on and that is still moving. Mireya signed her
        -- lease, the landlord signed it, and the document sat at 'in_progress'
        -- because her CO-TENANT had not signed yet — so no lease row exists, so
        -- unit_id is NULL, so the portal decided she was an applicant and showed
        -- her nothing but a background check. She had already done her part.
        --
        -- Signing is not applying. This is the signal that says so, and it holds
        -- from the moment a document reaches them until the lease exists.
        --
        -- S655: a NEW LEASE for the home they already live in (renews_lease_id)
        -- is not this. It comes back as pending_renewal_* below and shows as a
        -- banner — never the signing lock-in, which stays for new tenants.
        (SELECT d.id FROM lease_document_signers lds
           JOIN lease_documents d ON d.id = lds.document_id
          WHERE lds.user_id = u.id
            AND d.status IN ('sent','in_progress')
            AND d.renews_lease_id IS NULL
          ORDER BY d.created_at DESC LIMIT 1) AS pending_lease_document_id,
        -- S655 (Nic, 10/2): their new lease, signed by the landlord and waiting
        -- on them. They keep paying rent and using the portal meanwhile.
        nlw.document_id AS pending_renewal_document_id,
        nlw.start_date  AS pending_renewal_start_date,
        nlw.rent_amount AS pending_renewal_rent,
        nlw.is_my_turn  AS pending_renewal_waiting_on_is_me,
        un.id AS unit_id, un.unit_number, un.rent_amount, un.status AS unit_status,
        pr.name AS property_name, pr.street1, pr.city, pr.state,
        sd.total_amount AS deposit_total, sd.collected_amount AS deposit_collected,
        sd.flex_deposit_enabled, sd.installments_remaining,
        CASE
          WHEN sd.id IS NULL THEN false
          WHEN sd.flex_deposit_enabled = true AND sd.installments_remaining > 0 THEN false
          WHEN sd.collected_amount >= sd.total_amount THEN true
          ELSE false
        END AS deposit_fully_funded,
        -- S581: FlexPay is single-lease only. Flag it PAUSED for an ENROLLED
        -- tenant who now holds more than one active lease, so the home dashboard
        -- row and the Flex Advantage card both read from ONE server-computed
        -- signal (mirrors getFlexPayEligibility's 'multiple_leases' blocker + the
        -- advance-cron guard — the tenant isn't fronted while this is true).
        (t.flexpay_enrolled = true AND (
          SELECT COUNT(*)
            FROM lease_tenants lt2
            JOIN leases l2 ON l2.id = lt2.lease_id
           WHERE lt2.tenant_id = t.id
             AND lt2.status = 'active'
             AND l2.status IN ('active', 'pending')
             -- S655: a new lease of their own home is the same tenancy, not a
             -- second lease.
             AND NOT EXISTS (
               SELECT 1 FROM lease_tenants lt3 JOIN leases l3 ON l3.id = lt3.lease_id
                WHERE l3.id = l2.supersedes_lease_id AND lt3.tenant_id = t.id
                  AND lt3.status = 'active' AND l3.status IN ('active', 'pending'))
        ) > 1) AS flexpay_paused_multi_lease,
        -- S579: the live invite/onboarding binding, so an APPLICANT (no lease yet)
        -- has a landlord + property to attribute their background check to. Falls
        -- back to the active lease's landlord/property for a housed tenant.
        COALESCE(pti.landlord_id, pr.landlord_id) AS landlord_id,
        COALESCE(pti.property_id, pr.id)          AS property_id,
        -- S615: this person may have NO LEASE and still belong here — a space
        -- next door on the landlord's trash or power, billed under a utility
        -- service agreement. Nic: "That person should really have access to the
        -- tenant portal to get on and pay their bill."
        --
        -- Everything above resolves through an ACTIVE LEASE, so for them it is
        -- all NULL and the portal would greet them with "undefined · Unit
        -- undefined" over a rent card that can never have a number in it. This
        -- is the signal that says which kind of person is logged in, so the home
        -- page can show what is actually true of them.
        sa.id                AS utility_service_agreement_id,
        sa.service_address   AS utility_service_address,
        sa.billing_due_day   AS utility_service_due_day,
        -- S616: so the portal shows "final bill requested" instead of offering
        -- the button again to somebody who already pressed it.
        sa.moveout_notice_at,
        to_char(sa.moveout_expected_on, 'YYYY-MM-DD') AS moveout_expected_on,
        sau.unit_number      AS utility_service_space,
        sap.name             AS utility_service_property_name,
        -- ── S639: ACCEPTED THE INVITE, WAITING ON THE HOUSEHOLD ─────────────
        --
        -- Nic: "I have people trying to log in and sign their lease when other
        -- household members have not accepted the portal invite yet, and it's
        -- trying to offer them to pay for a background check, and I've told
        -- them, no, you don't have to do that... a lot of people think that is
        -- about to happen to them."
        --
        -- A lease only drafts once EVERY invited person on the unit has
        -- accepted, so whoever accepts first waits — with no lease, no lease
        -- document, and no background-check approval. Every existing signal was
        -- therefore false for them, the nav collapsed to Application, and a
        -- grandfathered resident who owes nothing was shown a $44.99 screening
        -- and reasonably concluded it was being demanded of them.
        --
        -- They are inside a tenancy, not applying for one. This says so, and
        -- carries what they are waiting on so the portal can tell them.
        -- ── S651: IN THE RENTER POOL, NOT IN A TENANCY ─────────────────────
        --
        -- Someone who took a background check without a landlord behind it is
        -- looking for somewhere to live. They have no unit, no lease, no
        -- invite and no utility agreement — but they ARE screening-approved,
        -- which made every gate above treat them as a fully housed tenant and
        -- hand them the whole portal: Payments with nothing to pay,
        -- Maintenance with nothing to fix, a Lease tab with no lease.
        --
        -- Nic: they get "a real tenant-portal login in a suspended state — no
        -- lease, nothing to do — until they connect with a landlord", and what
        -- they CAN do is browse places near them. This is the signal that says
        -- which of those two people is logged in.
        (SELECT ap.id FROM application_pool ap
          WHERE ap.user_id = t.user_id AND ap.status = 'available'
          ORDER BY ap.created_at DESC LIMIT 1) AS renter_pool_entry_id,
        ob.unit_number       AS onboarding_unit_number,
        ob.property_name     AS onboarding_property_name,
        ob.household_pending AS onboarding_household_pending,
        ob.household_pending_names AS onboarding_household_pending_names,
        ob.screening_waived  AS onboarding_screening_waived,
        -- S639 (Nic): "does the person from that household get the name of who
        -- the next signer is that it's waiting on?... That way the household can
        -- help propel itself to completion instead of each individual person
        -- keep trying to talk to the office."
        --
        -- Who the open lease document is actually waiting on — the lowest
        -- unsigned signer in signing order, the same rule the e-sign page and
        -- the reminder job use. Names only, and only people on this person's own
        -- unit: a household already knows who lives there, and the alternative
        -- is three adults each phoning the office to ask the same question.
        sig.name             AS pending_lease_waiting_on_name,
        sig.role             AS pending_lease_waiting_on_role,
        (sig.user_id = u.id) AS pending_lease_waiting_on_is_me,
        -- S655 (Nic, 10/2): whether that unsigned lease takes their portal
        -- over (the S648 signing lock-in). It does, unless they already rent
        -- or take utilities from ANOTHER company on GAM: a lease from a new
        -- landlord can reach someone who lives elsewhere on GAM (nobody is
        -- attached without their own signature), and the lock-in would stop
        -- them paying what they owe there. A tenancy with the lease's own
        -- account — including the very lease they are signing, which the
        -- landlord's signature already issued — keeps the lock-in. NULL when
        -- nothing is waiting.
        (SELECT NOT EXISTS (
                  SELECT 1 FROM lease_tenants lkt JOIN leases lkl ON lkl.id = lkt.lease_id
                   WHERE lkt.tenant_id = t.id AND lkt.status = 'active'
                     AND lkl.status IN ('active', 'pending')
                     AND lkl.landlord_id NOT IN (SELECT public.account_companies(lkd.landlord_id)))
            AND NOT EXISTS (
                  SELECT 1 FROM utility_service_agreements lks
                   WHERE lks.tenant_id = t.id AND lks.status = 'active'
                     AND lks.landlord_id NOT IN (SELECT public.account_companies(lkd.landlord_id)))
           FROM lease_document_signers lkds
           JOIN lease_documents lkd ON lkd.id = lkds.document_id
          WHERE lkds.user_id = u.id
            AND lkd.status IN ('sent','in_progress')
            AND lkd.renews_lease_id IS NULL
          ORDER BY lkd.created_at DESC LIMIT 1) AS pending_lease_locks,
        -- S639 (Nic): "does the middle tenant project their name onto the first
        -- and third tenant so that everybody can know full transparency where
        -- everything's at?"
        --
        -- Yes — and the next name alone only tells you the front of the queue.
        -- The whole roster in signing order, with who has signed, lets any one
        -- of three adults see the entire state of their own lease: what is done,
        -- who is holding it, and who comes after. Same view the landlord has.
        roster.signers       AS pending_lease_signers
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT un2.*
        FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN units un2 ON un2.id = l.unit_id
        WHERE vlat.tenant_id = t.id
        ORDER BY (vlat.role = 'primary') DESC
        LIMIT 1
      ) un ON TRUE
      LEFT JOIN properties pr ON pr.id = un.property_id
      LEFT JOIN security_deposits sd ON sd.tenant_id = t.id
      LEFT JOIN LATERAL (
        SELECT landlord_id, property_id
        FROM pending_tenant_intents
        WHERE tenant_id = t.id AND cancelled_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) pti ON TRUE
      LEFT JOIN LATERAL (
        SELECT sa2.id, sa2.service_address, sa2.billing_due_day, sa2.unit_id,
               sa2.moveout_notice_at, sa2.moveout_expected_on
          FROM utility_service_agreements sa2
         WHERE sa2.tenant_id = t.id AND sa2.status = 'active'
         ORDER BY sa2.start_date DESC
         LIMIT 1
      ) sa ON TRUE
      LEFT JOIN units sau      ON sau.id = sa.unit_id
      LEFT JOIN properties sap ON sap.id = sau.property_id
      -- S639: their accepted, unit-bound, still-open invite — and how many
      -- people on that same space have not accepted yet, which is the only
      -- thing standing between them and a lease.
      LEFT JOIN LATERAL (
        SELECT obu.unit_number, obp.name AS property_name,
               (SELECT COUNT(*)::int FROM pending_tenant_intents o
                 WHERE o.unit_id = ob2.unit_id
                   AND o.cancelled_at IS NULL AND o.resolved_at IS NULL
                   AND o.accepted_at IS NULL) AS household_pending,
               EXISTS (SELECT 1 FROM pending_tenant_intents w
                        WHERE w.tenant_id = t.id AND w.screening_waived
                          AND w.cancelled_at IS NULL) AS screening_waived,
               -- S639: by name, so the household can chase each other rather
               -- than the office. Excludes the person asking — telling somebody
               -- they are waiting on themselves is how you lose them.
               (SELECT COALESCE(
                   ARRAY_AGG(TRIM(CONCAT_WS(' ', ou.first_name, ou.last_name))
                             ORDER BY ou.first_name), '{}')
                  FROM pending_tenant_intents o
                  JOIN tenants ot ON ot.id = o.tenant_id
                  JOIN users ou ON ou.id = ot.user_id
                 WHERE o.unit_id = ob2.unit_id
                   AND o.cancelled_at IS NULL AND o.resolved_at IS NULL
                   AND o.accepted_at IS NULL
                   AND ot.id <> t.id) AS household_pending_names
          FROM pending_tenant_intents ob2
          JOIN units obu      ON obu.id = ob2.unit_id
          JOIN properties obp ON obp.id = obu.property_id
         WHERE ob2.tenant_id = t.id
           AND ob2.unit_id IS NOT NULL
           AND ob2.accepted_at IS NOT NULL
           AND ob2.cancelled_at IS NULL
           AND ob2.resolved_at IS NULL
         ORDER BY ob2.created_at DESC
         LIMIT 1
      ) ob ON TRUE
      -- S639: the next person owed a signature on the lease document this
      -- person is a signer on.
      LEFT JOIN LATERAL (
        SELECT lds2.name, lds2.role, lds2.user_id
          FROM lease_document_signers lds2
         WHERE lds2.document_id = (
                 SELECT d.id FROM lease_document_signers lds3
                   JOIN lease_documents d ON d.id = lds3.document_id
                  WHERE lds3.user_id = u.id AND d.status IN ('sent','in_progress')
                    AND d.renews_lease_id IS NULL
                  ORDER BY d.created_at DESC LIMIT 1)
           AND lds2.status <> 'signed'
         ORDER BY lds2.order_index
         LIMIT 1
      ) sig ON TRUE
      -- S639: every signer on that same document, in signing order.
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(JSON_BUILD_OBJECT(
                 'name', r.name, 'role', r.role,
                 'signed', r.status = 'signed',
                 'isMe', r.user_id = u.id
               ) ORDER BY r.order_index) AS signers
          FROM lease_document_signers r
         WHERE r.document_id = (
                 SELECT d.id FROM lease_document_signers lds4
                   JOIN lease_documents d ON d.id = lds4.document_id
                  WHERE lds4.user_id = u.id AND d.status IN ('sent','in_progress')
                    AND d.renews_lease_id IS NULL
                  ORDER BY d.created_at DESC LIMIT 1)
      ) roster ON TRUE
      -- S655: the new lease waiting on them, once the landlord has signed it
      -- (issued: it has a lease). Before that there is nothing for them to see.
      LEFT JOIN LATERAL (
        SELECT d.id AS document_id,
               to_char(nl.start_date, 'YYYY-MM-DD') AS start_date,
               nl.rent_amount::text AS rent_amount,
               NOT EXISTS (SELECT 1 FROM lease_document_signers e
                            WHERE e.document_id = d.id AND e.status <> 'signed'
                              AND (e.order_index < lds5.order_index OR e.role = 'landlord')) AS is_my_turn
          FROM lease_document_signers lds5
          JOIN lease_documents d ON d.id = lds5.document_id
          JOIN leases nl ON nl.id = d.lease_id
         WHERE lds5.user_id = u.id AND lds5.status <> 'signed'
           AND d.renews_lease_id IS NOT NULL
           AND d.status IN ('sent','in_progress')
           AND nl.status IN ('pending','active')
           -- Not one whose lease before it ENDED EARLY with nobody signed: it
           -- never starts and is being canceled — no banner asking them to sign.
           AND NOT ${followsLeaseEndedEarlyUnsigned('nl')}
         ORDER BY d.created_at DESC LIMIT 1
      ) nlw ON TRUE
      WHERE t.id = $1`, [req.user!.profileId!])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    res.json({ success: true, data: tenant })
  } catch (e) { next(e) }
})


// ── S581: landlord NOTICES (blocking portal pop-up) ──────────────────────
// A NOTICE addendum (e.g. a rent-increase the tenant can't refuse) is not signed
// by the tenant — instead they get a blocking pop-up on login to view + acknowledge.

// GET /api/tenants/lease-notices — pending notices for the pop-up. Stamps
// viewed_at on first surface (proof the tenant saw it), before they acknowledge.
tenantsRouter.get('/lease-notices', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId!
    const rows = await query<any>(
      `SELECT ln.id, ln.title, ln.body,
              to_char(ln.effective_date, 'YYYY-MM-DD') AS effective_date,
              ln.created_at, ln.viewed_at,
              u.unit_number, p.name AS property_name
         FROM lease_notices ln
         JOIN leases l     ON l.id = ln.lease_id
         JOIN units u      ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE ln.tenant_id = $1 AND ln.status = 'pending'
        ORDER BY ln.created_at ASC`,
      [tenantId])
    const unviewed = rows.filter((r: any) => !r.viewed_at).map((r: any) => r.id)
    if (unviewed.length > 0) {
      await query(
        `UPDATE lease_notices SET viewed_at = NOW(), updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND viewed_at IS NULL`, [unviewed])
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/tenants/lease-notices/:id/acknowledge — tenant clicks Acknowledge to
// dismiss the pop-up. Records acknowledged_at (+ viewed_at). Idempotent, own-notice.
tenantsRouter.post('/lease-notices/:id/acknowledge', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId!
    const r = await query<{ id: string }>(
      `UPDATE lease_notices
          SET status = 'acknowledged',
              acknowledged_at = COALESCE(acknowledged_at, NOW()),
              viewed_at = COALESCE(viewed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [req.params.id, tenantId])
    if (r.length === 0) throw new AppError(404, 'Notice not found')
    res.json({ success: true, data: { id: r[0].id, acknowledged: true } })
  } catch (e) { next(e) }
})

// ── GET /api/tenants/me/payment-health ───────────────────────────────────
// #12: the tenant's own view of the Payment Health card the landlord sees on
// TenantDetailPage — same metric (settled / total payments → on-time rate)
// computed from the authenticated tenant's own payments. Gives the resident
// a positive, at-a-glance read on their standing.
tenantsRouter.get('/me/payment-health', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const tenantId = req.user!.profileId!
    const s = await queryOne<any>(`
      SELECT
        COUNT(*) AS total_payments,
        COUNT(*) FILTER (WHERE status = 'settled') AS settled,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) AS total_paid,
        MIN(due_date) AS first_payment
      FROM payments WHERE tenant_id = $1
        -- A voided charge (decisions #48.5) was owed by nobody: it is not a payment.
        AND status <> 'voided'`, [req.user!.profileId!])
    const total = parseInt(s?.total_payments || 0)
    const settled = parseInt(s?.settled || 0)
    const firstPayment = s?.first_payment ? new Date(s.first_payment) : null
    const tenantMonths = firstPayment
      ? Math.floor((Date.now() - firstPayment.getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0

    // S595 (Nic): TRUE on-time payment health for the heartbeat monitor — of the
    // tenant's billed obligations (rent/utility/fee/home_payment) that have
    // RESOLVED (settled, or already past due_date + the lease grace window), how
    // many settled ON TIME (by due_date + grace). Per-month for the last 6 months
    // (the beats) + the window rate (the color). This is on-time-ness, NOT total
    // paid — a tenant who always pays but always late reads unhealthy here.
    // Excludes late_fees (the penalty) and deposits (one-time move-in).
    const otRows = await query<any>(`
      WITH obl AS (
        SELECT date_trunc('month', p.due_date) AS m,
               (p.status = 'settled'
                 AND p.settled_at::date <= p.due_date + COALESCE(l.late_fee_grace_days, 0)) AS on_time,
               (p.status = 'settled'
                 OR (p.due_date + COALESCE(l.late_fee_grace_days, 0)) < CURRENT_DATE) AS counted
          FROM payments p
          LEFT JOIN leases l ON l.id = p.lease_id
         WHERE p.tenant_id = $1
           AND p.type IN ('rent','utility','fee','home_payment')
           -- A voided charge was owed by nobody: never an on-time or late mark.
           AND p.status <> 'voided'
           AND p.due_date >= (date_trunc('month', CURRENT_DATE) - interval '5 months')::date
      )
      SELECT to_char(m, 'Mon') AS month, to_char(m, 'YYYY-MM') AS ym,
             COUNT(*) FILTER (WHERE counted)             AS total,
             COUNT(*) FILTER (WHERE counted AND on_time) AS on_time
        FROM obl
       GROUP BY m
       ORDER BY m`, [tenantId])
    const winTotal  = otRows.reduce((n: number, r: any) => n + parseInt(r.total || 0), 0)
    const winOnTime = otRows.reduce((n: number, r: any) => n + parseInt(r.on_time || 0), 0)

    res.json({
      success: true,
      data: {
        onTimeRate: total > 0 ? Math.round((settled / total) * 100) : 0,
        settledCount: settled,
        failedCount: parseInt(s?.failed || 0),
        totalPayments: total,
        totalPaid: parseFloat(s?.total_paid || 0),
        tenantMonths,
        // S595: real on-time health (drives the tenant heartbeat monitor).
        onTime: {
          pct: winTotal > 0 ? Math.round((winOnTime / winTotal) * 100) : null,
          resolved: winTotal,
          onTimeCount: winOnTime,
          months: otRows.map((r: any) => {
            const t = parseInt(r.total || 0), ot = parseInt(r.on_time || 0)
            return { month: r.month, ym: r.ym, total: t, onTime: ot, rate: t > 0 ? ot / t : null }
          }),
        },
      },
    })
  } catch (e) { next(e) }
})


// ── GET /api/tenants/me/move-in-gate ─────────────────────────────────────
// Tenant #6 (Nic 2026-06-26): the move-in inspection must be COMPLETED within
// 48 hours of the lease start date. Past that, an incomplete (still-draft)
// move-in inspection LOCKS the tenant out of the rest of the portal until they
// finish it, and they assume liability for any undocumented conditions. The
// first time the window lapses we stamp move_in_deadline_missed_at as the audit
// record of when that liability shifted.
//
// Scope choice: the gate only fires when a move-in inspection actually EXISTS
// and is still 'draft' past the deadline — a tenant is never locked out for the
// landlord never having started one. The inspection routes stay reachable so
// the locked-out tenant can still go complete it (the one allowed action).
tenantsRouter.get('/me/move-in-gate', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const row = await queryOne<any>(`
      SELECT i.id, i.status, i.move_in_deadline_missed_at,
             l.start_date,
             (l.start_date::timestamptz + interval '48 hours') AS deadline
        FROM v_lease_active_tenants vlat
        JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        JOIN unit_inspections i
          ON i.tenant_id = vlat.tenant_id
         AND i.inspection_type = 'move_in'
         AND (i.lease_id = l.id OR i.unit_id = l.unit_id)
       WHERE vlat.tenant_id = $1
         AND i.status <> 'cancelled'
       ORDER BY i.created_at DESC
       LIMIT 1`, [req.user!.profileId!])

    if (!row) { res.json({ success: true, data: { gated: false, hasMoveIn: false } }); return }

    const completed = row.status !== 'draft'   // tenant_signed/landlord_signed/finalized/disputed
    const overdue = !completed && new Date() > new Date(row.deadline)

    // Stamp the moment liability first shifts (idempotent).
    if (overdue && !row.move_in_deadline_missed_at) {
      await query(`UPDATE unit_inspections SET move_in_deadline_missed_at = now() WHERE id = $1 AND move_in_deadline_missed_at IS NULL`, [row.id])
    }

    res.json({
      success: true,
      data: {
        hasMoveIn: true,
        inspectionId: row.id,
        completed,
        deadline: row.deadline,
        overdue,
        gated: overdue,            // locked out of the rest of the portal
        liabilityAssumedAt: row.move_in_deadline_missed_at ?? (overdue ? new Date().toISOString() : null),
      },
    })
  } catch (e) { next(e) }
})


// ── GET /api/tenants/me/deposit-interest ─────────────────────────────────
// S189: tenant-facing view of statutory deposit interest. Surfaces the
// principal + collected_amount + cumulative interest_accrued + per-month
// accrual log + the state rate the deposit accrues at. Tenants see what
// they're owed in real-time, not only at move-out.
//
// Returns null deposit when tenant has no security deposit row.
// Returns empty rate / accruals when the deposit's state has no
// hardcoded statutory rate (tenant in NV, AZ, etc.) — UI shows the
// principal but no interest line.
/**
 * S652 — THE LAW FOR YOUR HOME.
 *
 * Nic: "upload each Landlord Tenant Act... where relevant to that unit type and
 * to that state, the applicable Landlord Tenant Act shows up in the tenant's
 * portal as a side menu option... show the version so that it can be updated
 * when we update it. That should be accessible automatically to all tenants
 * based on how the unit type is set up. As long as the landlord sets the unit
 * type the right way, the tenant will automatically get the correct thing, with
 * us providing it on the landlord's behalf."
 *
 * For each home the tenant has a lease on: the state's landlord-tenant act for
 * that kind of space, as the agency prints it, and the state's plain-language
 * guides. Straight from the government library — so a new edition shelved there
 * is what every tenant sees next time, with its edition shown.
 */
tenantsRouter.get('/me/laws', async (req, res, next) => {
  try {
    const tenantId = req.user!.profileId!
    const homes = await query<{ lease_id: string; state: string; unit_type: string; property_name: string; unit_number: string }>(
      `SELECT DISTINCT l.id AS lease_id, p.state, u.unit_type, p.name AS property_name,
              COALESCE(NULLIF(u.display_label, ''), u.unit_number) AS unit_number
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE lt.tenant_id = $1 AND l.status IN ('active','pending') AND p.state IS NOT NULL`,
      [tenantId])
    const out = []
    for (const h of homes) {
      const docs = await query<any>(
        `SELECT id, name, description, disclosure_type, source_name, publication_ref, effective_from, base_pdf_url, page_count
           FROM disclosure_library_documents
          WHERE jurisdiction = $1
            AND disclosure_type IN ('landlord_tenant_act', 'tenant_rights_guide')
            AND retired_at IS NULL AND superseded_by_id IS NULL
            AND (unit_types IS NULL OR $2 = ANY(unit_types))
          ORDER BY (disclosure_type = 'landlord_tenant_act') DESC, lower(name)`,
        [h.state, h.unit_type])
      out.push({
        leaseId: h.lease_id, state: h.state, propertyName: h.property_name, unitNumber: h.unit_number,
        documents: docs.map(d => ({
          id: d.id, name: d.name, description: d.description,
          kind: d.disclosure_type === 'landlord_tenant_act' ? 'act' : 'guide',
          publishedBy: d.source_name, edition: d.publication_ref, effectiveFrom: d.effective_from,
          pdfUrl: d.base_pdf_url, pageCount: d.page_count,
        })),
      })
    }
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

tenantsRouter.get('/me/deposit-interest', async (req, res, next) => {
  try {
    const tenantId = req.user!.profileId!

    const deposit = await queryOne<{
      id:                 string
      lease_id:           string
      total_amount:       string
      collected_amount:   string
      interest_accrued:   string
      status:             string
      held_by:            string
      state:              string | null
      unit_type:          string | null
      property_name:      string | null
      created_at:         string
    }>(
      `SELECT sd.id, sd.lease_id,
              sd.total_amount::text     AS total_amount,
              sd.collected_amount::text AS collected_amount,
              sd.interest_accrued::text AS interest_accrued,
              sd.status, sd.held_by,
              p.state, u.unit_type, p.name AS property_name,
              sd.created_at::text AS created_at
         FROM security_deposits sd
         JOIN leases    l ON l.id = sd.lease_id
         JOIN units     u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE sd.tenant_id = $1
        ORDER BY sd.created_at DESC
        LIMIT 1`,
      [tenantId],
    )

    if (!deposit) {
      return res.json({ success: true, data: { deposit: null, rate: null, accruals: [] } })
    }

    // Look up the effective rate for the deposit's state, UNIT TYPE, and the
    // current accrual year. Statutory catalog wins; falls back to the
    // landlord's S190 override for variable-rate states. Returns null
    // if neither has a rate — tenant sees principal-only.
    //
    // S604: this used to run its OWN state-only `LIMIT 1` lookup. Once the
    // S603 catalog became unit-type specific that read the wrong row: an
    // Arizona APARTMENT tenant was shown 5.0000% citing A.R.S. § 33-1431(B),
    // the MOBILE HOME statute, for interest they are owed none of — and it
    // disagreed with what the accrual engine actually booked. There is one
    // resolver now; the tenant is quoted the same rule that accrues.
    const currentYear = new Date().getUTCFullYear()
    let rate: {
      source:           'statutory' | 'landlord_override'
      state_code:       string
      effective_year:   number
      annual_rate_pct:  string
      statute_citation: string | null
      notes:            string | null
    } | null = null

    if (deposit.state) {
      const landlordRow = await queryOne<{ landlord_id: string }>(
        `SELECT l.landlord_id FROM leases l WHERE l.id = $1`,
        [deposit.lease_id],
      )
      if (landlordRow) {
        const { resolveRateForLandlord } = await import('../services/depositInterest')
        const resolved = await resolveRateForLandlord(
          landlordRow.landlord_id, deposit.state, currentYear, deposit.unit_type,
        )
        if (resolved) {
          rate = {
            source:           resolved.source,
            state_code:       resolved.state_code,
            effective_year:   resolved.effective_year,
            annual_rate_pct:  resolved.annual_rate_pct.toFixed(4),
            statute_citation: resolved.statute_citation ?? null,
            notes:            resolved.notes ?? null,
          }
        }
      }
    }

    const { getAccrualHistory } = await import('../services/depositInterest')
    const accruals = await getAccrualHistory(deposit.id)

    res.json({
      success: true,
      data: {
        deposit,
        rate,
        accruals,
      },
    })
  } catch (e) { next(e) }
})

// ── POST /api/tenants/verify-ach — REMOVED (S655, money plan Step 5) ──────
// It was a mock left from before Stripe: any tenant could type four digits and
// mark themselves bank-verified with no bank behind it, which is the gate for
// FlexPay and FlexDeposit. A bank is verified only by Stripe's microdeposits
// (routes/stripe.ts confirm-setup and microdeposits/verify; the
// setup_intent.succeeded webhook), and recorded by
// services/tenantBankMethods.recordVerifiedTenantBank.



// ── FLEXCHARGE (S252) ─────────────────────────────────────────────────────
// Tenant-side view of FlexCharge accounts the tenant holds (potentially
// one per property where they're enrolled). Pre-S252 routes targeted
// a one-account-per-tenant model that no longer matches the schema —
// rewritten to use the service layer.

// GET /api/tenants/flexcharge — list all accounts for this tenant
tenantsRouter.get('/flexcharge', async (req, res, next) => {
  try {
    const { isFlexChargeVisible, getFlexChargeAccountsForTenant } = await import('../services/flexCharge')
    if (!await isFlexChargeVisible()) return res.json({ success: true, data: { visible: false } })
    const accounts = await getFlexChargeAccountsForTenant(req.user!.profileId!)
    res.json({ success: true, data: { visible: true, accounts } })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexcharge/dispute/:txId
// S253: real dispute engine. Tenant disputes their own FlexCharge
// transaction → tx marked 'disputed', account 'disqualified'
// (permanent — admin manually unblocks). 3 distinct disputers
// against the same landlord in a trailing 90-day window flips the
// landlord's FlexCharge eligibility off platform-wide.
tenantsRouter.post('/flexcharge/dispute/:txId', async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason || String(reason).trim().length < 3) {
      throw new AppError(400, 'Dispute reason required (min 3 chars)')
    }
    const { disputeFlexChargeTransaction } = await import('../services/flexCharge')
    const out = await disputeFlexChargeTransaction({
      transactionId:    req.params.txId,
      disputerTenantId: req.user!.profileId!,
      reason:           String(reason),
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexcharge/:accountId/pay — S583 revolving: pay DOWN the
// balance (more than the auto-pulled minimum, up to paying in full → no interest
// next cycle). Charges the tenant's default method; the balance credit + merchant
// transfer settle on the webhook.
tenantsRouter.post('/flexcharge/:accountId/pay', async (req, res, next) => {
  try {
    const { amount } = z.object({ amount: z.number().positive() }).parse(req.body)
    const { payDownFlexCharge } = await import('../services/flexCharge')
    const out = await payDownFlexCharge({
      accountId: req.params.accountId,
      tenantId:  req.user!.profileId!,
      amount,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// ── FLEXPAY (S245) ────────────────────────────────────────────────────────
// FlexPay is a tenant-paid payment-scheduling service. The tenant picks
// a rent pull day (1-28) and pays a $5 + day-of-month fee each cycle.
// GAM fronts the rent to the landlord on the lease's grace-period-end
// day; the tenant's ACH pull on their chosen day reimburses GAM and
// collects the scheduling fee. See services/flexpay.ts for engine.

// ── S542: platform-originated questionnaires (LANDLORD-INVISIBLE) ──
// Tenant-only surfaces. No landlord route may ever expose this table.
tenantsRouter.get('/questionnaires', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const rows = await query<any>(
      `SELECT id, trigger_type, created_at
         FROM tenant_questionnaires
        WHERE tenant_id = $1 AND status = 'pending'
        ORDER BY created_at ASC`,
      [req.user!.profileId!])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

tenantsRouter.post('/questionnaires/:id/answer', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const body = z.object({
      incomeSource: z.enum(['ssi', 'ssdi', 'other_fixed', 'none']),
      interested:   z.boolean(),
      benefitDay:   z.number().int().min(1).max(28).optional(),
      benefitSchedule: z.enum(['ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day']).optional(),
    }).parse(req.body)
    const { answerQuestionnaire } = await import('../services/tenantQuestionnaires')
    const out = await answerQuestionnaire({
      tenantId: req.user!.profileId!,
      questionnaireId: req.params.id,
      answers: body,
    })
    if (!out.ok) throw new AppError(409, out.reason)
    res.json({ success: true, data: { inquiryFiled: out.inquiryFiled } })
  } catch (e) { next(e) }
})

tenantsRouter.post('/questionnaires/:id/dismiss', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { dismissQuestionnaire } = await import('../services/tenantQuestionnaires')
    const ok = await dismissQuestionnaire(req.user!.profileId!, req.params.id)
    if (!ok) throw new AppError(404, 'Questionnaire not found or already completed')
    res.json({ success: true, data: { dismissed: true } })
  } catch (e) { next(e) }
})

// ── S542b: FlexPay proof-of-income upload ───────────────────────────
// Imported tenants have no income data on file (they never ran the
// new-tenant flow), and FlexPay is hard-gated to PROVEN SSI/SSDI —
// so the tenant shows proof directly TO THE PLATFORM here (award
// letter / benefit verification letter), attached to their inquiry.
// Landlord never sees it: served only via the tenant's own GET below
// and the admin queue's GET (routes/admin.ts). S409 posture: on-disk
// extension normalized from validated MIME, Content-Type pinned at
// serve time.
const FLEXPAY_PROOF_MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
}
const flexpayProofDir = path.join(process.cwd(), 'uploads', 'flexpay-proofs')
if (!fs.existsSync(flexpayProofDir)) fs.mkdirSync(flexpayProofDir, { recursive: true })
const flexpayProofUpload = multer({
  storage: multer.diskStorage({
    destination: flexpayProofDir,
    filename: (_req: any, file: any, cb: any) => {
      const ext = FLEXPAY_PROOF_MIME_TO_EXT[file.mimetype] ?? '.pdf'
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (FLEXPAY_PROOF_MIME_TO_EXT[file.mimetype]) cb(null, true)
    else cb(new Error('PDF, JPEG, PNG or WEBP only'))
  },
})

tenantsRouter.post('/flexpay/inquiry/proof', flexpayProofUpload.single('file'), async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    if (!req.file) throw new AppError(400, 'No file')
    const inq = await queryOne<{ id: string; status: string; proof_file_path: string | null }>(
      `SELECT id, status, proof_file_path FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId!])
    if (!inq) throw new AppError(409, 'No FlexPay request on file — tap "I’m interested" first')
    if (inq.status !== 'pending') throw new AppError(409, 'Your request has already been reviewed')
    // Replace semantics: one active document; unlink the old one.
    if (inq.proof_file_path) {
      fs.unlink(path.join(flexpayProofDir, path.basename(inq.proof_file_path)), () => {})
    }
    await query(
      `UPDATE flexpay_inquiries
          SET proof_file_path = $2, proof_original_name = $3,
              proof_uploaded_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [inq.id, req.file.filename, String(req.file.originalname || 'proof').slice(0, 200)])

    // S546: automated verification — reads the PDF, matches lease-
    // holder names, scans for benefit language. Mismatch/unreadable →
    // SILENT hold; the response never reveals the outcome.
    const { verifyProofDocument } = await import('../services/flexpayAutoVerify')
    await verifyProofDocument(inq.id)

    res.json({ success: true, data: { uploaded: true, originalName: req.file.originalname } })
  } catch (e) { next(e) }
})

// Tenant's own proof view. Content-Type pinned from the stored
// (MIME-normalized) extension — never from client input.
export function flexpayProofContentType(filename: string): string {
  if (filename.endsWith('.pdf')) return 'application/pdf'
  if (filename.endsWith('.png')) return 'image/png'
  if (filename.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
tenantsRouter.get('/flexpay/inquiry/proof-file', async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const inq = await queryOne<{ proof_file_path: string | null }>(
      `SELECT proof_file_path FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId!])
    if (!inq?.proof_file_path) throw new AppError(404, 'No proof on file')
    const fp = path.join(flexpayProofDir, path.basename(inq.proof_file_path))
    if (!fs.existsSync(fp)) throw new AppError(404, 'File missing')
    res.setHeader('Content-Type', flexpayProofContentType(fp))
    fs.createReadStream(fp).pipe(res)
  } catch (e) { next(e) }
})

// GET /api/tenants/flex-visibility — S541: which Flex products the
// tenant portal may surface. Per-product rollout flags drive the UI
// (the old client-side LAUNCH_HIDDEN gate showed all-or-nothing);
// flipping one product on shows exactly that product.
tenantsRouter.get('/flex-visibility', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    const [flexpay, flexdeposit, flexcredit] = await Promise.all([
      isFeatureEnabled('flexpay_rollout_visible'),
      isFeatureEnabled('flexdeposit_rollout_visible'),
      isFeatureEnabled('flexcredit_rollout_visible'),
    ])
    res.json({ success: true, data: { flexpay, flexdeposit, flexcredit } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexpay — current enrollment + eligibility
tenantsRouter.get('/flexpay', async (req, res, next) => {
  try {
    const { isFlexPayVisible, isFlexPayEnrollmentOpen, getFlexPayEligibility, calculateFlexPayFee } = await import('../services/flexpay')
    const visible = await isFlexPayVisible()
    if (!visible) return res.json({ success: true, data: { visible: false } })
    // S544: survey mode — visible but not launched. Drives the
    // "coming soon" tenant framing; enrollment refuses server-side too.
    const enrollmentOpen = await isFlexPayEnrollmentOpen()

    const row = await queryOne<any>(
      `SELECT flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee,
              flexpay_enrolled_at, flexpay_disqualified_until,
              flexpay_disqualified_reason
         FROM tenants WHERE id = $1`,
      [req.user!.profileId!],
    )
    const eligibility = await getFlexPayEligibility(req.user!.profileId!)

    // S541: demand-test gate — the tenant's inquiry disposition drives
    // the card state (inquire → pending → approved-can-enroll / declined).
    const inquiry = await queryOne<any>(
      `SELECT id, status, claimed_income_source, created_at, reviewed_at,
              proof_original_name, proof_uploaded_at
         FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId!],
    )

    // S542c (Nic): tenants NEVER see a queue number — no promises.
    // Ordering (float-need first, then FIFO) lives admin-side only;
    // the tenant just knows they're in line, plus a state hold when
    // their state is legally blocked (place preserved either way).
    let stateHold = false
    if (inquiry?.status === 'pending') {
      const hold = await queryOne(
        `SELECT 1
           FROM lease_tenants lt
           JOIN leases l ON l.id = lt.lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties pr ON pr.id = u.property_id
           JOIN flexpay_blocked_states bs ON bs.state = pr.state
          WHERE lt.tenant_id = $1 AND lt.status = 'active'
            AND l.status IN ('active', 'pending')
          LIMIT 1`,
        [req.user!.profileId!])
      stateHold = !!hold
    }

    res.json({
      success: true,
      data: {
        visible: true,
        enrollmentOpen,
        ...row,
        eligibility,
        inquiry,
        stateHold,
        previewFee: row?.flexpay_pull_day ? calculateFlexPayFee(row.flexpay_pull_day) : null,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexpay/inquiry — S541 demand-test entry point.
// The tenant raises a hand ("I'm interested"); GAM reviews the lease,
// verifies SSI/SSDI income, and approves from the admin portal. Low
// friction by design: no ACH / eligibility precheck here — that all
// gates ENROLLMENT, not interest. One inquiry row per tenant.
tenantsRouter.post('/flexpay/inquiry', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFlexPayVisible } = await import('../services/flexpay')
    if (!(await isFlexPayVisible())) throw new AppError(409, 'FlexPay is not available')

    const body = z.object({
      // S545: all income types accepted — non-SSI/SSDI files a TIER-2
      // request (same queue, behind SSI/SSDI, income-hold on approval).
      incomeSource: z.enum(['ssi', 'ssdi', 'other_fixed', 'none']),
      // S545b: the PATTERN the program pays on (SSI 1st, SSDI 3rd or
      // Nth Wednesday, fixed day). Preferred over a raw day.
      benefitSchedule: z.enum(['ssi_day_1', 'ssdi_day_3', 'ssdi_wed_2', 'ssdi_wed_3', 'ssdi_wed_4', 'fixed_day']).optional(),
      // S542c: raw day — used with fixed_day schedules / legacy calls.
      benefitDay:   z.number().int().min(1).max(28).optional(),
      note:         z.string().max(1000).optional(),
    }).parse(req.body)

    // Derive the conservative arrival day from the schedule (latest
    // day the pattern can land) — float math runs on days.
    const { benefitScheduleToDay } = await import('@gam/shared')
    const derivedDay = body.benefitSchedule
      ? benefitScheduleToDay(body.benefitSchedule, body.benefitDay ?? null)
      : body.benefitDay ?? null

    const existing = await queryOne<{ status: string }>(
      `SELECT status FROM flexpay_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId!],
    )
    if (existing) throw new AppError(409, 'You already have a FlexPay request on file')

    const row = await queryOne<any>(
      `INSERT INTO flexpay_inquiries (tenant_id, claimed_income_source, desired_pull_day, benefit_schedule, tenant_note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, claimed_income_source, created_at`,
      [req.user!.profileId!, body.incomeSource, derivedDay, body.benefitSchedule ?? null, body.note ?? null],
    )

    // S545c: silent birthdate-consistency check — may place a
    // verification hold. NO tenant-facing signal either way.
    const { runBirthdateCheck } = await import('../services/flexpayVerification')
    await runBirthdateCheck(row!.id)

    const { createAdminNotification } = await import('../services/adminNotifications')
    await createAdminNotification({
      severity: 'info',
      category: 'flexpay_inquiry',
      title: 'New FlexPay interest request',
      body: `Tenant ${req.user!.profileId!} requested FlexPay (claims ${body.incomeSource.toUpperCase()}). Review in Admin → FlexPay Requests.`,
      context: { tenant_id: req.user!.profileId!, inquiry_id: row.id },
    })

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexpay/enroll
// body: { pullDay: 1..28, acceptedTerms: true }
// S314: explicit acceptance gate. The Subscription Terms snapshot is
// persisted to flexsuite_enrollment_acceptances inside the same tx.
tenantsRouter.post('/flexpay/enroll', async (req, res, next) => {
  try {
    const { enrollFlexPay } = await import('../services/flexpay')
    const pullDay = Number(req.body?.pullDay)
    const acceptedTerms = req.body?.acceptedTerms === true
    const out = await enrollFlexPay({
      tenantId:      req.user!.profileId!,
      userId:        req.user!.userId,
      pullDay,
      acceptedTerms,
      ip:            req.ip ?? null,
      userAgent:     req.headers['user-agent'] ?? null,
    })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { pullDay, fee: out.fee, acceptanceId: out.acceptanceId } })
  } catch (e) { next(e) }
})

// PATCH /api/tenants/flexpay/pull-day — change the scheduled pull day.
// Takes effect NEXT cycle (the current cycle's advance is already locked);
// the fee recomputes to $5 + the new day for future cycles.
tenantsRouter.patch('/flexpay/pull-day', async (req, res, next) => {
  try {
    const { changeFlexPayPullDay } = await import('../services/flexpay')
    const out = await changeFlexPayPullDay(req.user!.profileId!, Number(req.body?.pullDay))
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { pullDay: out.pullDay, fee: out.fee, effective: out.effective } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexpay/terms?pullDay=15
// S314: server-rendered populated Subscription Terms preview for the
// "Read full terms" link in the enrollment modal. No persistence —
// same render fn that runs at acceptance, returned for display.
tenantsRouter.get('/flexpay/terms', async (req, res, next) => {
  try {
    const { calculateFlexPayFee } = await import('../services/flexpay')
    const { renderFlexPayAcceptanceText, FLEXPAY_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const pullDay = Number(req.query.pullDay)
    if (!Number.isInteger(pullDay) || pullDay < 1 || pullDay > 28) {
      throw new AppError(400, 'pullDay must be an integer 1..28')
    }
    const fee = calculateFlexPayFee(pullDay)
    const { renderedText } = await renderFlexPayAcceptanceText({
      tenantId:  req.user!.profileId!,
      userId:    req.user!.userId,
      pullDay,
      fee,
      ip:        null,
      userAgent: null,
    })
    res.json({
      success: true,
      data: { version: FLEXPAY_TEMPLATE_VERSION, pullDay, fee, renderedText },
    })
  } catch (e) { next(e) }
})

// ── FlexSuite re-acceptance (S323) ────────────────────────────────────────
// When a template version bumps, currently-enrolled tenants are prompted
// to re-accept the new populated terms. The prior acceptance row stays
// in place as historical evidence; the new row carries the current
// version forward.

// GET /api/tenants/flexsuite/re-acceptance-status
// Returns the list of products with a pending re-acceptance. Empty
// array = nothing to prompt. The tenant portal calls this once on
// auth-resolved mount.
tenantsRouter.get('/flexsuite/re-acceptance-status', async (req, res, next) => {
  try {
    const { getPendingReAcceptances } =
      await import('../services/flexsuiteAcceptance')
    const pending = await getPendingReAcceptances(req.user!.profileId!)
    res.json({ success: true, data: { pending } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexsuite/re-acceptance-preview?product=flexpay|flexdeposit
// Renders the current-version populated terms for a tenant who's
// already enrolled. The pull day / installment count comes from the
// tenant's existing enrollment state, not the request.
tenantsRouter.get('/flexsuite/re-acceptance-preview', async (req, res, next) => {
  try {
    const { renderReAcceptanceTerms, FLEXPAY_TEMPLATE_VERSION, FLEXDEPOSIT_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const product = String(req.query.product || '')
    if (product !== 'flexpay' && product !== 'flexdeposit') {
      throw new AppError(400, 'product must be flexpay or flexdeposit')
    }
    const { renderedText } = await renderReAcceptanceTerms({
      tenantId:  req.user!.profileId!,
      userId:    req.user!.userId,
      product,
      ip:        null,
      userAgent: null,
    })
    res.json({
      success: true,
      data: {
        product,
        version:      product === 'flexpay' ? FLEXPAY_TEMPLATE_VERSION : FLEXDEPOSIT_TEMPLATE_VERSION,
        renderedText,
      },
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexsuite/re-accept
// Body: { product: 'flexpay' | 'flexdeposit', acceptedTerms: true }
// Persists a new acceptance row at the current template version.
tenantsRouter.post('/flexsuite/re-accept', async (req, res, next) => {
  try {
    const product = String(req.body?.product || '')
    if (product !== 'flexpay' && product !== 'flexdeposit') {
      throw new AppError(400, 'product must be flexpay or flexdeposit')
    }
    if (req.body?.acceptedTerms !== true) {
      throw new AppError(400, 'acceptedTerms must be true')
    }
    const { commitReAcceptance } =
      await import('../services/flexsuiteAcceptance')
    const acceptanceId = await commitReAcceptance({
      tenantId:  req.user!.profileId!,
      userId:    req.user!.userId,
      product,
      ip:        req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    })
    res.json({ success: true, data: { acceptanceId, product } })
  } catch (e) { next(e) }
})

// DELETE /api/tenants/flexpay — cancel enrollment
tenantsRouter.delete('/flexpay', async (req, res, next) => {
  try {
    const { cancelFlexPay } = await import('../services/flexpay')
    await cancelFlexPay(req.user!.profileId!)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── FLEXDEPOSIT (S246; custody model S514) ─────────────────────────────────
// FlexDeposit splits the security deposit into 2-6 installments based on
// deposit amount × Checkr BG risk_level. The tenant funds their OWN deposit
// into GAM custody: installment 1 at move-in, the rest monthly. GAM advances
// nothing — the deposit is held in custody (gam_escrow) and the deposit-return
// flow settles against what was actually collected. A missed installment only
// leaves the deposit under-funded (no acceleration/recourse — ToS § 9.1.5).
// $3/month custody fee applies while GAM holds the deposit.

// GET /api/tenants/flexdeposit — eligibility + active plan + schedule
tenantsRouter.get('/flexdeposit', async (req, res, next) => {
  try {
    const { isFlexDepositVisible, getFlexDepositEligibility } = await import('../services/flexDeposit')
    const visible = await isFlexDepositVisible()
    if (!visible) return res.json({ success: true, data: { visible: false } })

    const eligibility = await getFlexDepositEligibility(req.user!.profileId!)

    // Active plan view: any installments rows belonging to this tenant.
    const plan = await query<any>(
      `SELECT i.installment_number, i.installment_count, i.amount::text,
              i.due_date::text, i.status, i.settled_at::text,
              i.security_deposit_id
         FROM flex_deposit_installments i
        WHERE i.tenant_id = $1
        ORDER BY i.installment_number ASC`,
      [req.user!.profileId!],
    )

    // S514: deposit-row context for the LeasePage. Returns the most recently
    // created FlexDeposit deposit for this tenant + how much is still
    // unfunded into custody, so the page can offer the voluntary pay-ahead.
    // No acceleration/in_default banner exists under the custody model.
    const deposit = await queryOne<{
      id:                        string
      flex_deposit_plan_status:  string | null
      total_amount:              string
      collected_amount:          string
      unfunded_amount:           string
    }>(
      `SELECT sd.id, sd.flex_deposit_plan_status,
              sd.total_amount::text     AS total_amount,
              sd.collected_amount::text AS collected_amount,
              COALESCE((
                SELECT SUM(amount)
                  FROM flex_deposit_installments
                 WHERE security_deposit_id = sd.id
                   AND status IN ('pending', 'missed')
              ), 0)::text               AS unfunded_amount
         FROM security_deposits sd
        WHERE sd.tenant_id = $1
          AND sd.flex_deposit_enabled = TRUE
        ORDER BY sd.created_at DESC
        LIMIT 1`,
      [req.user!.profileId!],
    )

    res.json({ success: true, data: { visible: true, eligibility, plan, deposit } })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/pay-ahead — tenant-initiated voluntary
// pay-ahead from the LeasePage. Fires one ACH pull for the unfunded
// (pending + missed) installments; success flips the plan to 'completed'.
// A failure is benign — the plan stays 'active' and scheduled pulls
// continue (custody model: no acceleration, no balance-due-in-full).
tenantsRouter.post('/flexdeposit/pay-ahead', async (req, res, next) => {
  try {
    const { payAheadFlexDeposit } = await import('../services/flexDeposit')
    const out = await payAheadFlexDeposit({ tenantId: req.user!.profileId! })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/flexdeposit/enroll
// body: { installmentCount: 2..6, acceptedTerms: true }
// S260 (acknowledgedTos) → S314 (acceptedTerms): the gate now also
// persists the populated SLA snapshot to
// flexsuite_enrollment_acceptances inside the same tx as the
// installment-row inserts. Legacy `acknowledgedTos: true` accepted
// for backward compat.
tenantsRouter.post('/flexdeposit/enroll', async (req, res, next) => {
  try {
    const { enrollFlexDeposit } = await import('../services/flexDeposit')
    const installmentCount = Number(req.body?.installmentCount)
    const acceptedTerms =
      req.body?.acceptedTerms === true || req.body?.acknowledgedTos === true
    const out = await enrollFlexDeposit({
      tenantId:         req.user!.profileId!,
      userId:           req.user!.userId,
      installmentCount,
      acceptedTerms,
      ip:               req.ip ?? null,
      userAgent:        req.headers['user-agent'] ?? null,
    })
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true, data: { ...out.plan, acceptanceId: out.acceptanceId } })
  } catch (e) { next(e) }
})

// GET /api/tenants/flexdeposit/terms?installmentCount=3
// S314: server-rendered populated SLA preview for the "Read full
// agreement" link. Computes the same schedule enrollment would
// produce, renders the SLA with placeholders filled, returns the
// text. No persistence.
tenantsRouter.get('/flexdeposit/terms', async (req, res, next) => {
  try {
    const { previewFlexDepositSchedule } = await import('../services/flexDeposit')
    const { renderFlexDepositAcceptanceText, FLEXDEPOSIT_TEMPLATE_VERSION } =
      await import('../services/flexsuiteAcceptance')
    const installmentCount = Number(req.query.installmentCount)
    if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 6) {
      throw new AppError(400, 'installmentCount must be an integer 2..6')
    }
    const preview = await previewFlexDepositSchedule({
      tenantId: req.user!.profileId!,
      installmentCount,
    })
    if (!preview.ok) throw new AppError(400, preview.reason)
    const { renderedText } = await renderFlexDepositAcceptanceText({
      tenantId:               req.user!.profileId!,
      userId:                 req.user!.userId,
      depositId:              preview.depositId,
      installmentCount,
      installments:           preview.schedule.installments,
      totalInstallmentAmount: preview.schedule.totalInstallmentAmount,
      moveInDate:             preview.schedule.startDate,
      ip:                     null,
      userAgent:              null,
    })
    res.json({
      success: true,
      data: {
        version:          FLEXDEPOSIT_TEMPLATE_VERSION,
        installmentCount,
        installments:     preview.schedule.installments,
        uncollectedAtMoveIn: preview.schedule.uncollectedAtMoveIn,
        renderedText,
      },
    })
  } catch (e) { next(e) }
})

// S255: deposit portability — when a tenant's current lease enters
// termination and they have another GAM lease pending/active, they
// can authorize carry-forward of the deposit instead of receiving
// a refund. Backend gates on detection eligibility; UI prompts at
// the termination flow.

// GET /api/tenants/me/deposit/portability/eligibility?leaseId=...
tenantsRouter.get('/me/deposit/portability/eligibility', async (req, res, next) => {
  try {
    const leaseId = String(req.query.leaseId || '')
    if (!leaseId) throw new AppError(400, 'leaseId required')
    const { detectPortabilityEligible } = await import('../services/depositPortability')
    const result = await detectPortabilityEligible({
      leaseId,
      tenantId: req.user!.profileId!,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/tenants/me/deposit/portability/authorize
//   body: { depositId, targetLeaseId, signature }
tenantsRouter.post('/me/deposit/portability/authorize', async (req, res, next) => {
  try {
    const { depositId, targetLeaseId, signature } = req.body || {}
    if (!depositId || !targetLeaseId || !signature) {
      throw new AppError(400, 'depositId, targetLeaseId, signature required')
    }
    const { authorizeDepositPortability } = await import('../services/depositPortability')
    const out = await authorizeDepositPortability({
      tenantId:      req.user!.profileId!,
      depositId,
      targetLeaseId,
      signature,
      ip:            req.ip ?? null,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// POST /api/tenants/me/deposit/portability/decline { depositId }
tenantsRouter.post('/me/deposit/portability/decline', async (req, res, next) => {
  try {
    const { depositId } = req.body || {}
    if (!depositId) throw new AppError(400, 'depositId required')
    const { declineDepositPortability } = await import('../services/depositPortability')
    await declineDepositPortability({
      tenantId:  req.user!.profileId!,
      depositId,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// DELETE /api/tenants/flexdeposit — cancel BEFORE move-in only
tenantsRouter.delete('/flexdeposit', async (req, res, next) => {
  try {
    const { cancelFlexDeposit } = await import('../services/flexDeposit')
    const out = await cancelFlexDeposit(req.user!.profileId!)
    if (!out.ok) return res.status(400).json({ success: false, error: out.reason })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/tenants/enroll-credit-reporting
// FlexCredit (rent-payment reporting via Esusu). Gated on the
// flexcredit_rollout_visible flag — OFF at launch. The product is NOT built
// (no Esusu integration / billing yet), so until the flag is on we must NOT
// flip the column or promise reporting that doesn't happen.
tenantsRouter.post('/enroll-credit-reporting', async (req, res, next) => {
  try {
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    if (!await isFeatureEnabled('flexcredit_rollout_visible')) {
      return res.json({ success: true, data: { visible: false } })
    }
    await query(`UPDATE tenants SET credit_reporting_enrolled=TRUE WHERE id=$1`, [req.user!.profileId!])
    res.json({ success: true, message: 'Credit reporting enrolled — $5/month reported to all 3 bureaus' })
  } catch (e) { next(e) }
})

// ── S565: FlexCredit DEMAND-CAPTURE (interest survey) ────────────────
// Separate from FlexPay (no income verification — credit reporting needs none).
// Captures interest only; NO billing/Esusu enrollment happens here (that's the
// later launch phase, gated on breakeven). Gated on flexcredit_rollout_visible
// so it stays hidden until the demand test opens.

// GET the tenant's own FlexCredit interest state (for the portal card).
tenantsRouter.get('/flexcredit/inquiry', async (req, res, next) => {
  try {
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    const visible = await isFeatureEnabled('flexcredit_rollout_visible')
    const inq = await queryOne<{ status: string; created_at: string }>(
      `SELECT status, created_at FROM flexcredit_inquiries WHERE tenant_id = $1`,
      [req.user!.profileId!]
    )
    res.json({ success: true, data: { visible, interested: !!inq, status: inq?.status ?? null } })
  } catch (e) { next(e) }
})

// POST — file (or re-affirm) interest. Idempotent per tenant.
tenantsRouter.post('/flexcredit/inquiry', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant only')
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    if (!await isFeatureEnabled('flexcredit_rollout_visible')) {
      return res.json({ success: true, data: { visible: false, inquiryFiled: false } })
    }
    await query(
      `INSERT INTO flexcredit_inquiries (tenant_id, status)
       VALUES ($1, 'interested')
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = NOW()`,
      [req.user!.profileId!]
    )
    res.json({ success: true, data: { visible: true, inquiryFiled: true } })
  } catch (e) { next(e) }
})

tenantsRouter.get('/payments', async (req, res, next) => {
  try {
    const payments = await query<any>(`
      SELECT p.*, u.unit_number, pr.name AS property_name,
             -- S654: how it was paid, for the history's "Paid by" column.
             COALESCE(p.manual_method, rm.payment_method) AS paid_by
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN tenant_remittances rm ON p.stripe_payment_intent_id IS NOT NULL
                                     AND rm.stripe_payment_intent_id = p.stripe_payment_intent_id
      WHERE p.tenant_id = $1
      ORDER BY p.due_date DESC LIMIT 24`, [req.user!.profileId!])
    res.json({ success: true, data: payments })
  } catch (e) { next(e) }
})

// ── S654: every tie an account has to a company, read from the schema ──────
//
// Round 8, reproduced: landlord B re-addressed a never-set-up account whose
// only ties to company A were a cancelled invite, A's background check on them
// and a $250 one-off charge. The hand-written list here counted leases, open
// invites, drafts, utility agreements, payments and signer seats, so it said
// "not tied": the address moved to B's mailbox, the setup link mailed there
// set the password, and A's screening decision came with the login.
//
// So the list is no longer written by hand. Every column in the database that
// points at a person (a foreign key to users or tenants) is a tie to the
// company on that row: its landlord_id, any column that references landlords,
// businesses or pm_companies, or a company table's own id. A row with no
// company of its own ties through the row it hangs off (a signer seat through
// its document, a lease's tenant row through the lease, a work-trade log
// through its agreement). Cancelled, voided and finished rows count the same
// as live ones. A table added later counts the day it exists. The query is
// built once per process from the catalog.
const COMPANY_TABLES = new Set(['landlords', 'businesses', 'pm_companies'])
// Person columns the schema gives no foreign key; named so they count too.
const UNKEYED_PERSON_COLUMNS: Array<[table: string, column: string, refers: 'users' | 'tenants']> = [
  ['payment_reversals', 'tenant_id', 'tenants'],
  ['landlord_member_history', 'user_id', 'users'],
  ['product_events', 'user_id', 'users'],
]
const SQL_IDENT = /^[a-z_][a-z0-9_]*$/

interface TieQuery { sql: string; sources: string[] }
let tieQuery: Promise<TieQuery> | null = null

async function buildTieQuery(): Promise<TieQuery> {
  const fks = await query<{ tbl: string; col: string; reftbl: string; refcol: string }>(
    `SELECT cl.relname AS tbl, a.attname AS col, rcl.relname AS reftbl, ra.attname AS refcol
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
       JOIN pg_class rcl ON rcl.oid = c.confrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
        AND c.conparentid = 0 AND NOT cl.relispartition`)
  const cols = await query<{ tbl: string; col: string; type: string }>(
    `SELECT c.table_name AS tbl, c.column_name AS col, c.udt_name AS type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'`)
  const uuidCols = new Set(cols.filter(c => c.type === 'uuid').map(c => `${c.tbl}.${c.col}`))
  const safe = (...names: string[]) => names.every(n => SQL_IDENT.test(n))

  // The company columns a table carries itself.
  const companyCols = (tbl: string): string[] => {
    const out = new Set<string>()
    if (COMPANY_TABLES.has(tbl)) out.add('id')
    if (uuidCols.has(`${tbl}.landlord_id`)) out.add('landlord_id')
    for (const f of fks) if (f.tbl === tbl && COMPANY_TABLES.has(f.reftbl)) out.add(f.col)
    return [...out].filter(c => safe(c))
  }

  const people: Array<{ tbl: string; col: string; refers: string }> = fks
    .filter(f => (f.reftbl === 'users' || f.reftbl === 'tenants') && f.refcol === 'id' && f.tbl !== 'users')
    .map(f => ({ tbl: f.tbl, col: f.col, refers: f.reftbl }))
  for (const [tbl, col, refers] of UNKEYED_PERSON_COLUMNS) {
    if (uuidCols.has(`${tbl}.${col}`)) people.push({ tbl, col, refers })
  }

  const branches: string[] = []
  const sources: string[] = []
  for (const p of people) {
    if (!safe(p.tbl, p.col)) continue
    const who = p.refers === 'users'
      ? `x."${p.col}" = $1::uuid`
      : `x."${p.col}" IN (SELECT id FROM mine)`
    const own = companyCols(p.tbl)
    if (own.length > 0) {
      for (const c of own) {
        const source = `${p.tbl}.${p.col}`
        branches.push(`SELECT x."${c}"::text AS company_id, '${source}' AS source FROM "${p.tbl}" x WHERE ${who}`)
        sources.push(source)
      }
      continue
    }
    for (const f of fks) {
      if (f.tbl !== p.tbl || f.col === p.col || f.reftbl === 'users' || f.reftbl === 'tenants') continue
      if (!safe(f.col, f.reftbl, f.refcol)) continue
      for (const c of companyCols(f.reftbl)) {
        const source = `${p.tbl}.${p.col} > ${f.reftbl}`
        branches.push(
          `SELECT r."${c}"::text AS company_id, '${source}' AS source FROM "${p.tbl}" x ` +
          `JOIN "${f.reftbl}" r ON r."${f.refcol}" = x."${f.col}" WHERE ${who}`)
        sources.push(source)
      }
    }
  }
  const sql =
    `WITH mine AS MATERIALIZED (SELECT id FROM tenants WHERE user_id = $1::uuid)
     SELECT company_id, source FROM (
       ${branches.join('\n       UNION ALL ')}
     ) ties
     WHERE company_id IS NOT NULL AND NOT (company_id = ANY($2::text[]))
     LIMIT $3`
  return { sql, sources: Array.from(new Set(sources)).sort() }
}

function tieQueryOnce(): Promise<TieQuery> {
  if (!tieQuery) tieQuery = buildTieQuery().catch(e => { tieQuery = null; throw e })
  return tieQuery
}

/** S654: where the tie check looks (table.column, "> parent" when it ties through the row it hangs off). */
export async function companyTieSources(): Promise<string[]> {
  return (await tieQueryOnce()).sources
}

/**
 * S654: the ties this account has to companies outside `own`, of ANY kind
 * (see above). `limit` 1 answers "is there one" without reading the rest.
 */
export async function companyTiesOutside(
  userId: string, own: Iterable<string>, limit = 1000,
): Promise<Array<{ companyId: string; source: string }>> {
  const { sql } = await tieQueryOnce()
  const rows = await query<{ company_id: string; source: string }>(
    sql, [userId, Array.from(new Set(own)), limit])
  const seen = new Set<string>()
  return rows
    .filter(r => { const k = `${r.company_id} ${r.source}`; if (seen.has(k)) return false; seen.add(k); return true })
    .map(r => ({ companyId: r.company_id, source: r.source }))
}

// S654: does this account belong to a company outside `own`? Any tie at all
// counts (companyTiesOutside): a lease, an invite (cancelled ones too), a
// draft, a signer seat on any of its documents, a background check, a charge,
// an invoice, a document, a booking, a staff or owner seat. Such an account is
// never re-addressed, renamed or handed a fresh password link by another
// company. accountTiedElsewhere (resolveIntent.ts) asks this first.
export async function residentTiedElsewhere(userId: string, own: Iterable<string>): Promise<boolean> {
  return (await companyTiesOutside(userId, own, 1)).length > 0
}

// POST /api/tenants/invite — landlord invites a tenant.
// S81: gated by tenants.create. Pre-S81 the route had bare requireAuth
// (router-level), so any authenticated user including the tenant being
// invited could call it. canAccessLandlordResource still enforces unit
// scope after admission.
//
// Two kinds of invite:
//   - to a UNIT (a household that is moving in, has lived here before, or —
//     during the onboarding window — already lives here). S655: these go
//     through the one invite function every door uses (services/newLeaseInvite):
//     the whole household in one call (`residents`), the lease drafted at once
//     and waiting for the landlord's signature, NOBODY emailed until he signs
//     (S647). This route used to email the tenant "set up your account" at
//     invite time even when the lease had drafted — an email before the
//     landlord signed and a second one when he did — and it drafted the lease
//     for the first person only: a second person invited to the same home was
//     left off the lease.
//   - to a PROPERTY (a new applicant who screens first; no unit yet). They get
//     the invite email now, because their next step is theirs.
//
// S655 (Nic, 10/2): invites are EMAIL-ONLY. A setup link sets the account's
// password, so it goes only to the person's own address and never comes back
// in a response — not even for an account this invite just made.
tenantsRouter.post('/invite', requirePerm('tenants.invite'), async (req, res, next) => {
  try {
    const { email, firstName, lastName, unitId, phone, propertyId } = req.body
    // S652 (Nic, option 2): "This person has lived here before" — the landlord
    // attests it, the check is skipped, the attestation is recorded and counted
    // against the property's rolling allowance (see applyReturningResidentWaive).
    const returningResident = req.body.returningResident === true
    // S655: a household invited to its unit together; one person still works.
    const residents: Array<{ email?: string; firstName?: string; lastName?: string; phone?: string }> =
      Array.isArray(req.body.residents) && req.body.residents.length
        ? req.body.residents
        : [{ email, firstName, lastName, phone }]
    const lead = residents[0] ?? {}
    if (!lead.email || !lead.firstName || (!unitId && !propertyId)) {
      return res.status(400).json({ success: false, error: 'Email, name and a unit or property are required' })
    }
    if (returningResident && !unitId) {
      return res.status(400).json({ success: false, error: 'A returning resident is invited to their space.' })
    }
    if (!unitId && residents.length > 1) {
      return res.status(400).json({ success: false, error: 'Invite applicants to a property one at a time. A household is invited to its unit together.' })
    }
    // S417: block disposable email domains so invites can't be sent to
    // throwaway addresses. Defeats the verification gate downstream.
    for (const r of residents) {
      if (typeof r.email === 'string' && isDisposableEmail(r.email)) {
        return res.status(400).json({ success: false,
          error: 'Disposable / temporary email addresses are not allowed' })
      }
    }

    // Resolve the landlord + property the invite binds to. Inviting a tenant
    // ties them to the property's landlord — admin override + team-role scope
    // are both valid here.
    let inviteLandlordId: string
    let inviterPropertyId: string | null = null
    if (unitId) {
      const unit = await queryOne<any>(`SELECT id, landlord_id, property_id FROM units WHERE id = $1`, [unitId])
      if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' })
      inviteLandlordId = unit.landlord_id
      inviterPropertyId = unit.property_id
    } else {
      const property = await queryOne<any>(`SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
      if (!property) return res.status(404).json({ success: false, error: 'Property not found' })
      inviteLandlordId = property.landlord_id
      inviterPropertyId = property.id
    }
    if (!canAccessLandlordResource(req.user, inviteLandlordId)) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }

    // ── A UNIT: the one invite function ────────────────────────────────────
    if (unitId) {
      if (returningResident) {
        // Over the allowance the option is simply refused (S652) — before
        // anything is written, so no half-made invite is left behind.
        const { returningResidentAllowance, RETURNING_ALLOWANCE_USED_MESSAGE } = await import('../services/onboardingWindow')
        if ((await returningResidentAllowance(inviterPropertyId!)).left <= 0) {
          throw new AppError(409, RETURNING_ALLOWANCE_USED_MESSAGE)
        }
      }
      const { inviteHouseholdToNewLease, packetIds } = await import('../services/newLeaseInvite')
      const out = await inviteHouseholdToNewLease({
        unitId,
        people: residents.map(r => ({
          firstName: String(r.firstName ?? ''), lastName: String(r.lastName ?? ''),
          email: String(r.email ?? ''), phone: r.phone ?? null,
        })),
        authorize: () => {},   // canAccessLandlordResource, above
        ownCompanies: [inviteLandlordId, ...landlordScopeIds(req.user!)],
        byUserId: req.user!.userId,
        // "Already lives here" (onboarding window open) grandfathers past the
        // background check and papers an existing tenancy, the same as the
        // Tenant Onboarding page.
        existingResident: req.body.existingResident === true,
        returningResident,
        homeSale: req.body.homeSale ? (typeof req.body.homeSale === 'object' ? req.body.homeSale : { selling: true }) : null,
        packageTemplateIds: packetIds(req.body.packageTemplateIds),
        source: 'invite',
        requireUnitSetup: false,
        requireLastName: false,
        fallbackEmail: 'invite',
      })

      // S605 (Nic): remember the unit this invite was for, household order
      // preserved — setting a unit type's default lease later refires drafting
      // for every unit still waiting.
      for (const p of out.people) {
        const seq = await queryOne<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pending_lease_drafts WHERE unit_id = $1`, [unitId])
        await query(
          `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (unit_id, tenant_user_id) DO NOTHING`,
          [out.landlordId, unitId, p.userId, Number(seq?.n ?? 0)])
      }
      logger.info({ unitId, people: out.people.length, drafted: out.draftedDocumentIds.length }, '[INVITE] household invited to a unit')

      const first = out.people[0]
      return res.json({
        success: true,
        data: {
          userId: first.userId,
          tenantId: first.tenantId,
          email: first.email,
          // An invite email went out only when the lease could not draft.
          inviteSent: first.notified === 'email',
          // S616: so the screen never says "invite sent" for someone already on GAM.
          alreadyOnPlatform: first.alreadyOnPlatform,
          leaseDrafted: out.draftedDocumentIds.length > 0,
          draftBlocked: out.draftBlocked,
          people: out.people.map(p => ({
            email: p.email, name: `${p.firstName} ${p.lastName}`.trim(),
            inviteSent: p.notified === 'email', alreadyOnPlatform: p.alreadyOnPlatform,
            screeningWaived: p.screeningWaived, needsOwnSignature: p.needsOwnSignature,
            // S655: what actually reached them — 'email', 'notice', or null for
            // nothing (a lease drafted, or the fallback could not be sent). The
            // screen says "told there" only for a notice that went.
            notified: p.notified,
          })),
        },
      })
    }

    // ── A PROPERTY: a new applicant who screens first ──────────────────────
    const tempHash = '$2b$10$placeholder_invite_pending'

    // S654: one account per address, whatever its letter case. An exact match
    // missed 'LANDLORD@X.DEV' for a landlord stored lowercase, and a second
    // login was made on their address with its link handed to the inviter.
    const emailNorm = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' })
    }
    const matches = await query<{ id: string; role: string; email: string; needs_setup: boolean }>(
      `SELECT id, role, email,
              (password_hash = $2 AND tenant_invite_accepted_at IS NULL) AS needs_setup
         FROM users WHERE lower(email) = $1
        ORDER BY (email = lower(email)) DESC, created_at`,
      [emailNorm, tempHash])
    // S654: only a resident's account can be invited, never a landlord's,
    // staff's or an e-sign contact's.
    if (matches.some(m => m.role !== 'tenant')) {
      return res.status(409).json({ success: false,
        error: "This email belongs to a GAM account that isn't a resident's, so it can't be invited as a tenant. Use the resident's own email." })
    }
    let user: { id: string; email: string } | null = matches[0] ?? null

    // S654: a password link is minted only for an account that still needs
    // setting up and belongs to no other landlord. Anyone else is already on
    // GAM (S616): no link, and an existing link another landlord sent keeps
    // working.
    let mintToken = false
    if (user && matches[0].needs_setup) {
      mintToken = !(await residentTiedElsewhere(user.id, [inviteLandlordId, ...landlordScopeIds(req.user!)]))
    }
    if (!user) {
      user = await queryOne<{ id: string; email: string }>(`
        INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
        VALUES ($1,$2,'tenant',$3,$4,$5) RETURNING id, email`,
        [emailNorm, tempHash, firstName, lastName || '', phone || null])
      mintToken = true
    }

    // Create the tenant record — but only if there is not one already.
    //
    // S628: this was `INSERT ... ON CONFLICT DO NOTHING`, and tenants.user_id
    // carries a PLAIN index (idx_tenants_user_id), not a unique one, so a
    // second invite to the same address minted a SECOND tenants row for the
    // same user. Look up first, then insert.
    let tenantId: string | undefined =
      (await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at ASC LIMIT 1',
        [user!.id]))?.id
    if (!tenantId) {
      tenantId = (await queryOne<any>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [user!.id]))?.id
    }

    // S579: a PROPERTY-level screening invite (no unit yet) records a
    // property-bound intent so the background check the applicant completes
    // links to this property. unit_id stays NULL: no unit, no lease draft.
    //
    // S655: one live no-unit row per person PER COMPANY — the conflict target
    // is (tenant_id, landlord_id). Keyed on the tenant alone, company Y's
    // invite re-pointed company X's row at Y's park, and X's row is where X's
    // screening waiver lives. Until the post-deploy step drops the old
    // tenant-only index, a person whose live no-unit row belongs to ANOTHER
    // company collides with it (23505): their row is left untouched, the
    // invite still goes, and this one simply isn't recorded on a row yet.
    if (tenantId) {
      try {
        await query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id, unit_id)
           VALUES ($1, $2, 'not_uploaded', $3, NULL)
           ON CONFLICT (tenant_id, landlord_id) WHERE cancelled_at IS NULL AND unit_id IS NULL
           DO UPDATE SET property_id = EXCLUDED.property_id, resolved_at = NULL, updated_at = NOW()`,
          [inviteLandlordId, tenantId, inviterPropertyId])
      } catch (err: any) {
        if (err?.code !== '23505') throw err
        logger.warn({ tenantId, landlordId: inviteLandlordId },
          '[INVITE] another company holds this person\'s open no-unit row; left untouched')
      }
    }

    // S410 (S377): the purpose-scoped column, 7-day expiry.
    let inviteToken: string | null = null
    if (mintToken) {
      inviteToken = crypto.randomBytes(32).toString('hex')
      await query(
        `UPDATE users
            SET tenant_invite_token = $1,
                tenant_invite_expires_at = NOW() + INTERVAL '7 days'
          WHERE id = $2`,
        [inviteToken, user!.id])
    }

    // S654: portalLink, never a localhost fallback (S641 rule).
    const acceptUrl = inviteToken ? portalLink('tenant', `accept-invite?token=${inviteToken}`) : null
    logger.info(`[INVITE] Tenant invite: ${emailNorm}`)

    // S628: SEND IT. Best-effort: the account and the token already exist, so
    // failing the request would leave a half-made invite behind. Their next
    // step is a background check.
    //
    // S655: what actually reached them, so the screen never says an email or
    // a notice went when the send failed ('email' | 'notice' | null).
    let notified: 'email' | 'notice' | null = null
    try {
      const ctxRow = await queryOne<any>(
        `SELECT p.name AS property_name,
                COALESCE(NULLIF(la.business_name, ''),
                         NULLIF(TRIM(lu.first_name || ' ' || lu.last_name), ''),
                         'Your landlord') AS landlord_name
           FROM landlords la
           JOIN users lu ON lu.id = la.user_id
           LEFT JOIN properties p ON p.id = $2::uuid
          WHERE la.id = $1`,
        [inviteLandlordId, inviterPropertyId])
      const landlordName = ctxRow?.landlord_name || 'Your landlord'
      const propertyName = ctxRow?.property_name || 'their property'
      if (acceptUrl) {
        // S654: to the address on the account, never the one typed.
        await emailTenantInvite(user!.email, firstName, landlordName, propertyName, null, acceptUrl, true,
          { landlordId: inviteLandlordId, tenantId })
        notified = 'email'
      } else {
        // S616/S654: already on GAM. Tell them in the account they have.
        const { createNotification } = await import('../services/notifications')
        await createNotification({
          userId: user!.id,
          landlordId: inviteLandlordId,
          type: 'invited_to_apply',
          title: `${landlordName} invited you to apply at ${propertyName}`,
          body: 'Sign in to your GAM account as usual to continue.',
          data: { unitId: null, propertyId: inviterPropertyId, tenantId },
          actionUrl: '/',
        })
        notified = 'notice'
      }
    } catch (emailErr) {
      logger.error({ err: emailErr, ctx: emailNorm }, '[INVITE] invite notice failed for')
    }

    res.json({
      success: true,
      data: {
        userId: user!.id,
        tenantId,
        email: user!.email,
        // S655: email-only — no link in the response, for anyone. True only
        // when the email actually went.
        inviteSent: notified === 'email',
        notified,
        // S616: so the screen never says "invite sent" for someone already on GAM.
        alreadyOnPlatform: !mintToken,
      }
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/:tenantId/waive-screening — grandfather a SITTING tenant
// past the background check during a property's onboarding window.
//
// This is NOT a landlord "skip screening" toggle. It is only permitted while
// the property's onboarding window is OPEN, only for an occupied unit's sitting
// tenant, and only with the landlord's attestation that the person is an
// existing resident. Outside the window there is no waive — every new applicant
// screens. It records the waiver on this company's intent row (only this
// account reads it as "screened"; the person's own screening status is never
// touched) and records an audit trail. It deliberately does NOT touch the
// tenant's intent unit_id (that would auto-draft a lease colliding with the
// e-sign onboarding) — the grandfathered unit is recorded in a dedicated column.
// See services/onboardingWindow.ts + memory gam-screening-grandfather-onboarding-window.
tenantsRouter.post('/:tenantId/waive-screening', requirePerm('tenants.invite'), async (req, res, next) => {
  try {
    const { tenantId } = req.params
    const { propertyId, unitId, attested } = req.body
    if (!propertyId || !unitId) {
      return res.status(400).json({ success: false, error: 'propertyId and unitId (the occupied unit) are required' })
    }
    if (attested !== true) {
      return res.status(400).json({ success: false, error: 'You must attest this person is an existing resident to waive screening' })
    }
    const property = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!property) return res.status(404).json({ success: false, error: 'Property not found' })
    if (!canAccessLandlordResource(req.user, property.landlord_id)) {
      return res.status(403).json({ success: false, error: 'Forbidden' })
    }
    const unit = await queryOne<{ id: string; property_id: string }>(
      `SELECT id, property_id FROM units WHERE id = $1`, [unitId])
    if (!unit || unit.property_id !== propertyId) {
      return res.status(400).json({ success: false, error: 'Unit does not belong to that property' })
    }
    // The person must actually be coming onto THIS unit with THIS company: a
    // live invite to it, or a lease on it. Before, any tenant id on GAM could
    // be waived by any landlord with an open window — a brand-new landlord
    // could mark a stranger (or someone denied elsewhere) as screened. Same 404
    // for "no such person" and "not yours to waive", so it reveals nothing.
    const onboarding = await queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM tenants t
        WHERE t.id = $1
          AND (EXISTS (SELECT 1 FROM pending_tenant_intents i
                        WHERE i.tenant_id = t.id AND i.unit_id = $2
                          AND i.landlord_id = $3 AND i.cancelled_at IS NULL)
               OR EXISTS (SELECT 1 FROM lease_tenants lt
                            JOIN leases l ON l.id = lt.lease_id
                           WHERE lt.tenant_id = t.id AND l.unit_id = $2
                             AND l.landlord_id = $3
                             AND l.status IN ('active', 'pending')))`,
      [tenantId, unitId, property.landlord_id])
    if (!onboarding) {
      return res.status(404).json({ success: false,
        error: 'Tenant not found. Invite them to this unit first, then waive their screening.' })
    }

    const result = await applyScreeningWaive({
      tenantId, landlordId: property.landlord_id, propertyId, unitId, byUserId: req.user!.userId,
    })
    if (!result.waived) {
      if (result.reason === 'window_closed') {
        return res.status(403).json({ success: false,
          error: "This property's onboarding window has closed — a background check is required." })
      }
      if (result.reason === 'unit_taken') {
        return res.status(409).json({ success: false, error: 'This unit already has a grandfathered resident.' })
      }
      if (result.reason === 'not_recorded') {
        return res.status(409).json({ success: false, error: WAIVER_NOT_RECORDED_MESSAGE })
      }
    }
    // The waiver is this company's record; the person's own screening status
    // is untouched (see services/onboardingWindow.ts recordWaiver).
    res.json({ success: true, data: { tenantId, status: 'waived' } })
  } catch (e) { next(e) }
})

// /accept-invite and /invite-info are declared at the top of
// this file, BEFORE tenantsRouter.use(requireAuth). See header
// comment on the pre-auth public routes section.

// GET /api/tenants/:id/profile — a resident's profile.
//
// Who sees what:
//  - the resident themselves and GAM admin: the person's whole GAM life;
//  - a landlord, or a scoped staff member, who has had this person on one of
//    their leases: ONLY what happened with their own company (or the other
//    companies of the same account). Never another company's units, payments,
//    maintenance, work trade or late marks. A staff member assigned to
//    particular properties sees only what happened at those properties, and
//    cannot open someone who has never had a lease or invitation there.
//
// Before this the gate asked "is this landlord related to the person at all?"
// and then every query filtered on tenant_id alone, so a landlord who got the
// person onto one lease could read another company's rent history, its
// payment notes, its maintenance notes and costs, plus the person's bank
// last-4, date of birth and Stripe id off the whole tenants row. Every block
// below now carries the same company scope, and a landlord or staff viewer
// gets named fields only — the ones the Tenant page draws.
//
// S641 (Nic, on his on-site manager): "I don't want her to see ... the payment
// histories from people." Staff without payments.view_all or books.view get no
// payment history, no work trade and no money figures here — except the
// paid-ahead figure for a front desk that posts payments (take_payment).
// A landlord or staff viewer never gets the SSI/SSDI flag (GAM-side only).
tenantsRouter.get('/:id/profile', async (req, res, next) => {
  try {
    const tenantRow = await queryOne<any>(`
      SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
        u.created_at as account_created
      FROM tenants t
      JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`, [req.params.id])
    if (!tenantRow) throw new AppError(404, 'Tenant not found')

    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isSelf = role === 'tenant' && req.user!.profileId! === req.params.id
    // null = unrestricted (admin, self). Otherwise the companies this viewer
    // may see that the person has actually been on a lease with.
    let scope: string[] | null = null
    if (!isAdmin && !isSelf) {
      const relatedLandlords = await query<{ landlord_id: string }>(`
        SELECT DISTINCT l.landlord_id
          FROM lease_tenants lt
          JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $1
      `, [req.params.id])
      scope = relatedLandlords
        .map(r => r.landlord_id)
        .filter(id => canAccessLandlordResource(req.user, id))
      if (!scope.length) throw new AppError(403, 'Forbidden')
    }
    const scoped = scope !== null
    const seesPayments = !scoped || userHasPerm(req.user, 'payments.view_all', 'books.view')
    // S655: a staff member assigned to particular properties (a property
    // manager, on-site manager or maintenance worker whose scope is not "all
    // properties") sees this person's time at THOSE properties only — never
    // the company's other parks. null = no property limit (owners, GAM admin,
    // all-properties staff, the resident themselves); [] = sees no history.
    const propScope: string[] | null = scoped
      ? await (await import('../middleware/auth')).getScopedPropertyIds(req.user)
      : null
    // ...and such a staff member opens the person at all only when the person
    // has had a lease, or has an open invitation, at one of those properties.
    // The history lists below are already limited to them, but the contact
    // card (name, email, phone) would still have shown someone from the
    // company's other parks.
    if (propScope !== null) {
      const atAssignedProperty = await queryOne<{ ok: boolean }>(`
        SELECT (EXISTS (SELECT 1 FROM lease_tenants lt
                          JOIN leases l ON l.id = lt.lease_id
                          JOIN units u ON u.id = l.unit_id
                         WHERE lt.tenant_id = $1
                           AND l.landlord_id = ANY($2::uuid[])
                           AND u.property_id = ANY($3::uuid[]))
             OR EXISTS (SELECT 1 FROM pending_tenant_intents i
                          LEFT JOIN units iu ON iu.id = i.unit_id
                         WHERE i.tenant_id = $1
                           AND i.cancelled_at IS NULL
                           AND i.landlord_id = ANY($2::uuid[])
                           AND COALESCE(iu.property_id, i.property_id) = ANY($3::uuid[]))) AS ok`,
        [req.params.id, scope, propScope])
      if (!atAssignedProperty?.ok) {
        throw new AppError(403,
          "This resident has never had a lease at the properties you're assigned to. Ask the owner if you need their details.")
      }
    }

    // A landlord or staff viewer gets the fields the Tenant page uses and
    // nothing else: no Stripe id, bank or routing digits, date of birth,
    // mailing address, Flex enrollment or screening fields.
    // S655 (Nic, 10/2): no SSI/SSDI flag either. "That's our check for the
    // flex products" — it is GAM's eligibility check, kept GAM-side (the
    // resident themselves and GAM admin still get it on the whole row). Source
    // of income is nothing a landlord decides anything on.
    const tenant = scoped
      ? {
          id: tenantRow.id,
          user_id: tenantRow.user_id,
          first_name: tenantRow.first_name,
          last_name: tenantRow.last_name,
          email: tenantRow.email,
          phone: tenantRow.phone,
          ach_verified: tenantRow.ach_verified,
          avatar_url: tenantRow.avatar_url,
          account_created: tenantRow.account_created,
        }
      : tenantRow

    // Units occupied — with this company only, for a scoped viewer.
    const units = await query<any>(`
      SELECT DISTINCT u.id, u.unit_number, u.rent_amount, u.status,
        p.name as property_name, p.street1, p.city, p.state,
        l.start_date, l.end_date,
        (lt.status = 'active' AND l.status = 'active') as is_current
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE lt.tenant_id = $1
        AND ($2::uuid[] IS NULL OR l.landlord_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
      ORDER BY is_current DESC, start_date DESC`, [req.params.id, scope, propScope])

    // FlexPay never surfaces to the landlord (CLAUDE.md S541): GAM's FlexPay
    // pull rows are left out of the list and the stats for every viewer, and
    // the unscoped branch (GAM admin, the resident) names its columns so
    // flexpay_advance_id is never sent.
    const payments = !seesPayments ? [] : await query<any>(`
      SELECT ${scoped
        ? `p.id, p.type, p.amount, p.status, p.due_date, p.settled_at, p.processed_at,
           p.manual_method, p.work_trade_suspended_at`
        : `p.id, p.unit_id, p.lease_id, p.tenant_id, p.landlord_id, p.type, p.amount, p.status,
           p.stripe_payment_intent_id, p.stripe_charge_id, p.ach_trace_number, p.entry_description,
           p.return_code, p.return_reason, p.zero_tolerance_flag, p.due_date, p.processed_at,
           p.settled_at, p.retry_count, p.notes, p.created_at, p.lease_fee_id, p.invoice_id,
           p.next_retry_at, p.last_retry_at, p.platform_held, p.sublease_credit_applied,
           p.gam_supersedence_amount, p.gam_supersedence_breakdown, p.gam_supersedence_applied_at,
           p.import_source, p.imported_at, p.import_extra_data, p.is_remainder, p.reversal_id,
           p.manual_method, p.sublease_markup_amount, p.home_sale_installment_id, p.revenue_owner,
           p.work_trade_suspended_at, p.payment_channel, p.issued_credit_amount`}, u.unit_number, pr.name as property_name
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE p.tenant_id = $1
        AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
        AND ($2::uuid[] IS NULL OR p.landlord_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
      ORDER BY p.due_date DESC
      LIMIT 36`, [req.params.id, scope, propScope])

    // Lifetime payment stats. S652 (Nic): lateCount is the number of charges
    // the credit ledger recorded as paid past grace — once per charge, the
    // same events the score reads. The old tenants.late_payment_count column
    // was bumped every morning a balance stayed open and is no longer kept.
    // A scoped viewer counts only late marks on THIS company's charges: the
    // ledger event names the payment it was raised for. The ledger itself is
    // unchanged.
    const lateRow = !seesPayments ? null : await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_type = 'tenant' AND cs.subject_ref_id = $1
          AND ce.superseded_by IS NULL
          AND ce.event_type IN ('payment_received_late_minor','payment_received_late_major','payment_received_late_severe')
          AND ($2::uuid[] IS NULL OR EXISTS (
                SELECT 1 FROM payments p
                  LEFT JOIN units pu ON pu.id = p.unit_id
                 WHERE p.id::text = ce.event_data->>'payment_id'
                   AND p.landlord_id = ANY($2::uuid[])
                   AND ($3::uuid[] IS NULL OR pu.property_id = ANY($3::uuid[]))))`,
      [req.params.id, scope, propScope])
    // S652 (Nic): a work-trade charge is paid in hours — it counts as paid.
    const paymentStats = !seesPayments ? null : await queryOne<any>(`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'settled' OR work_trade_suspended_at IS NOT NULL) as settled,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COALESCE(SUM(amount) FILTER (WHERE status = 'settled'), 0) as total_paid,
        COALESCE(AVG(amount) FILTER (WHERE status = 'settled'), 0) as avg_payment,
        MIN(due_date) as first_payment,
        MAX(due_date) as last_payment
      FROM payments
      WHERE tenant_id = $1
        AND entry_description IS DISTINCT FROM 'FLEXPAY'
        -- A voided charge (decisions #48.5) was owed by nobody and paid by
        -- nothing: it stays in the list above as a record, but it is never a
        -- payment in these counts (it would drag the on-time rate down).
        AND status <> 'voided'
        AND ($2::uuid[] IS NULL OR landlord_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR unit_id IN (SELECT id FROM units WHERE property_id = ANY($3::uuid[])))`,
      [req.params.id, scope, propScope])

    // Maintenance requests — this company's only, for a scoped viewer, and
    // never its internal notes.
    const maintenance = await query<any>(`
      SELECT ${scoped
        ? 'mr.id, mr.title, mr.status, mr.priority, mr.created_at, mr.actual_cost'
        : 'mr.*'}, u.unit_number, p.name as property_name
      FROM maintenance_requests mr
      LEFT JOIN units u ON u.id = mr.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE mr.tenant_id = $1
        AND ($2::uuid[] IS NULL OR mr.landlord_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
      ORDER BY mr.created_at DESC
      LIMIT 20`, [req.params.id, scope, propScope])

    // Work trade agreements (S641: a private arrangement — staff without the
    // payment permissions do not get it).
    const workTrade = !seesPayments ? [] : await query<any>(`
      SELECT ${scoped
        ? `wta.id, wta.status, wta.start_date, wta.end_date, wta.monthly_hours_target,
           wta.tracks_hours, wta.covered_charges, wta.landlord_id`
        : 'wta.*'}, u.unit_number, p.name as property_name
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE wta.tenant_id = $1
        AND ($2::uuid[] IS NULL OR wta.landlord_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
      ORDER BY wta.created_at DESC`, [req.params.id, scope, propScope])

    // S652: money that arrived before its bill — shown on the Tenant page so
    // nobody posts it twice. (S652 wrote this into the avatar upload by
    // mistake, so the page's "Paid ahead" line never had a number.) Scoped to
    // this company's leases.
    // S655: it is a money figure, so it follows the S641 rule above — only a
    // viewer who may see payments gets it, plus the front desk that posts them
    // (take_payment), which needs it so the same check is not posted twice.
    // Everyone else gets null, never a number.
    const seesPaidAhead = seesPayments || userHasPerm(req.user, 'take_payment')

    // S655 (Nic, 10/2): ALL the credit on their account, and what of it would
    // pay their bills right now. They differ: paid-ahead money stops at a
    // monthly draw cap, credit pays only the landlord's own rent, utilities and
    // fees (never a GAM fee, a home payment or a neighbor's utility), and
    // credit tied to one lease pays only that lease. Usable is the household
    // plan the tenant's Pay Now and the desk offer ("credit available $X"); the
    // balance itself is never netted. Same money rule as seesPaidAhead above: only
    // a viewer who may see payments, or the desk that takes them. A
    // property-locked viewer sees only the credit of the leases at their
    // properties (a general credit is the person's with this company, shown).
    let credit: null | {
      total: number; usable: number; paidAhead: number; fromLandlord: number; depositInterest: number
    } = null
    // "Paid ahead: $X — covers their next invoice" (the post-payment card).
    // S655: the same household money the credit figures read (creditBeside —
    // one rule): a withdrawn credit is not in it, and neither is paid-ahead
    // money a dispute or bank return of its own funding still claims (it is
    // not the tenant's; creditUse.householdQuote withholds it). Money a
    // scheduled retry is holding is already set against a bill, so it is not
    // "paid ahead" here (credit.paidAhead, everything on file, includes it).
    let paidAhead: number | null = null
    if (seesPaidAhead) {
      const companies = scope ?? (await query<{ landlord_id: string }>(
        `SELECT DISTINCT l.landlord_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id WHERE lt.tenant_id = $1
         UNION SELECT DISTINCT tc.landlord_id FROM tenant_credits tc WHERE tc.tenant_id = $1
         UNION SELECT DISTINCT l.landlord_id FROM lease_prepaid_credits c JOIN leases l ON l.id = c.lease_id WHERE c.tenant_id = $1`,
        [req.params.id])).map(r => r.landlord_id)
      const leaseScope = propScope === null ? null : (await query<{ id: string }>(
        `SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id
          WHERE l.landlord_id = ANY($1::uuid[]) AND u.property_id = ANY($2::uuid[])`,
        [companies, propScope])).map(r => r.id)
      const { creditBeside } = await import('../services/openBalances')
      const c = await creditBeside({ tenantId: req.params.id, landlordIds: companies, leaseIds: leaseScope })
      credit = {
        total: c.onFile, usable: c.usable,
        paidAhead: c.paidAhead, fromLandlord: c.fromLandlord, depositInterest: c.depositInterest,
      }
      paidAhead = c.paidAheadRemaining
    }

    // Lifetime metrics
    const firstPayment = paymentStats?.first_payment ? new Date(paymentStats.first_payment) : null
    const tenantMonths = firstPayment
      ? Math.floor((Date.now() - firstPayment.getTime()) / (1000 * 60 * 60 * 24 * 30))
      : 0
    const settled = parseInt(paymentStats?.settled || 0)
    const total = parseInt(paymentStats?.total_payments || 0)
    const onTimeRate = total > 0 ? Math.round((settled / total) * 100) : 0

    res.json({
      success: true,
      data: {
        tenant,
        units,
        payments,
        maintenance,
        workTrade,
        paidAhead,
        credit,
        // True when this viewer may not see payment history (S641). The page
        // hides the payment cards rather than drawing zeros.
        paymentsHidden: !seesPayments,
        stats: seesPayments ? {
          tenantMonths,
          totalPaid:    parseFloat(paymentStats?.total_paid || 0),
          avgPayment:   parseFloat(paymentStats?.avg_payment || 0),
          settledCount: settled,
          failedCount:  parseInt(paymentStats?.failed || 0),
          lateCount:    parseInt(lateRow?.n || '0', 10),
          totalPayments: total,
          onTimeRate,
          firstPayment: paymentStats?.first_payment,
          lastPayment:  paymentStats?.last_payment,
          unitsOccupied: units.length,
          maintenanceCount: maintenance.length,
        } : {
          tenantMonths: null,
          totalPaid:    null,
          avgPayment:   null,
          settledCount: null,
          failedCount:  null,
          lateCount:    null,
          totalPayments: null,
          onTimeRate:   null,
          firstPayment: null,
          lastPayment:  null,
          unitsOccupied: units.length,
          maintenanceCount: maintenance.length,
        }
      }
    })
  } catch (e) { next(e) }
})

// POST /api/tenants/:id/transfer — move tenant to a new unit
tenantsRouter.post('/:id/transfer', requirePerm('tenants.transfer_unit'), async (req, res, next) => {
  // Removed S20. Unit transfers are not a distinct operation under the
  // multi-tenant lease model. The equivalent workflow is:
  //   1. Terminate the existing lease (PATCH /leases/:id status=terminated)
  //   2. Create a new e-sign document for the new unit with the same tenant(s)
  //   3. All parties sign → new lease row created on the new unit
  // This endpoint intentionally returns 501 until a purpose-built flow exists.
  res.status(501).json({
    success: false,
    error: 'Unit transfer endpoint retired. Terminate the current lease and create a new lease via e-sign on the new unit.'
  })
})

tenantsRouter.get('/:id/available-units', requirePerm('tenants.archive'), async (req, res, next) => {
  try {
    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.rent_amount, u.bedrooms, u.bathrooms, u.sqft,
        p.name as property_name, p.street1, p.city
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1 AND u.status = 'vacant'
        AND NOT EXISTS (
          SELECT 1 FROM leases l
          WHERE l.unit_id = u.id AND l.status IN ('active', 'pending')
        )
      ORDER BY p.name, u.unit_number`,
      [req.user!.profileId!])
    res.json({ success: true, data: units })
  } catch (e) { next(e) }
})

// ── TENANT PROFILE UPDATE ─────────────────────────────────────
//
// S411 (S398/S380 Nic-locked decision): "fix all 3" email validations
// plus a 4th defensive check. S417 extracted the disposable-domain
// helper to lib/email so the same block list applies to all
// email-accepting routes.

const profileSchema = z.object({
  phone:       z.string().nullish(),
  // .trim() runs before .email() so surrounding whitespace doesn't
  // make the input fail format validation.
  email:       z.string().trim().email('Invalid email format').nullish(),
  bio:         z.string().nullish(),
  themeAccent: z.string().nullish(),
  fontStyle:   z.string().nullish(),
})

tenantsRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const body = profileSchema.parse(req.body)
    const { phone, email, bio, themeAccent, fontStyle } = body

    if (email) {
      const normalized = email.trim().toLowerCase()
      if (isDisposableEmail(normalized)) {
        throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
      }
      // S380 (b): pre-check uniqueness. Returns clean 409 instead of
      // the 500 from the DB unique-constraint violation.
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2 LIMIT 1`,
        [normalized, req.user!.userId])
      if (existing) {
        throw new AppError(409, 'This email is already in use by another account')
      }
      // Only update email when it was supplied. COALESCE-style: omitted
      // body field preserves current value (fixes the 4th defensive
      // case — null-clobber from missing email).
      await query('UPDATE users SET phone=$1, email=$2 WHERE id=$3',
        [phone||null, normalized, req.user!.userId])
    } else {
      await query('UPDATE users SET phone=COALESCE($1,phone) WHERE id=$2',
        [phone||null, req.user!.userId])
    }
    if (req.user!.profileId!) {
      await query('UPDATE tenants SET bio=$1, theme_accent=$2, font_style=$3 WHERE id=$4',
        [bio||null, themeAccent||null, fontStyle||null, req.user!.profileId!])
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})


// Avatar upload
// S409 (S398 Nic-locked decision): "strong fix" XSS defense layer 2 —
// normalize the on-disk extension based on validated MIME, not on the
// client-supplied originalname extension. Mirrors the S399 properties.ts
// + S394 esign + S395 pending-tenants fixes. The serve route also pins
// Content-Type so even legacy files survive, but defending at both
// layers is the right posture for a public-served file class.
const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
}
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars')
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true })
const avatarStorage = multer.diskStorage({
  destination: avatarDir,
  filename: (_req: any, file: any, cb: any) => {
    const ext = AVATAR_MIME_TO_EXT[file.mimetype] ?? '.jpg'
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext)
  }
})
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req: any, file: any, cb: any) => {
  if (['image/jpeg','image/png','image/webp'].includes(file.mimetype)) cb(null, true)
  else cb(new Error('JPEG PNG WEBP only'))
}})

tenantsRouter.post('/avatar', requireAuth, avatarUpload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file')
    const url = '/api/tenants/avatar-files/' + req.file.filename
    if (req.user!.profileId!) await query('UPDATE tenants SET avatar_url=$1 WHERE id=$2', [url, req.user!.profileId!])
    // S655: the S652 paid-ahead figure lives on GET /:id/profile only. A copy
    // of its query sat here, reading req.params.id — which this route does not
    // have — on every photo upload.
    res.json({ success: true, data: { url } })
  } catch(e) { next(e) }
})

// /avatar-files/:filename is declared at the top of this file,
// BEFORE tenantsRouter.use(requireAuth). See pre-auth header.

// S654: a password change ends every OTHER session (every pass minted before
// it). It used to end the tenant's own too: the stamp was NOW() and the reply
// carried no new pass, so the very next /auth/me or /auth/refresh refused the
// pass they had just used and threw them out of the portal for changing their
// own password. Now:
//   - the stamp is a WHOLE second, taken from the clock that stamps passes
//     (a pass's iat is whole seconds; /auth/me and /refresh compare exactly),
//     and the fresh pass is minted after it, so it can never read as "before";
//   - the reply carries that fresh pass, and the Profile page stores it;
//   - the pass asking must itself postdate the last change (the /refresh rule):
//     this mints a pass, and a pass a previous change ended must not trade the
//     password for a new one without the emailed code;
//   - a wrong current password is 400, not 401, so no portal reads a typo as
//     "your session ended" and signs the person out;
//   - a pass minted earlier in the SAME whole second as the change is not
//     ended by it. The window is under a second, and closing it would also end
//     a real new sign-in made in the rest of that second.
//
// S655 (final sweep): the fresh pass goes to a TENANT only, built from the
// database. This route is open to every signed-in role, and the pass used to be
// copied from the asking pass's own claims. A team member whose access the
// landlord had pulled (scope row deleted, so /auth/refresh answers 403
// "deactivated") could trade their own password for a fresh seven days still
// carrying the pulled permissions, and repeat it every week. Now:
//   - only a tenant (the pass AND the account) gets a pass back — the tenant
//     Profile page is the only caller. Its claims are the ones /auth/refresh
//     builds for a tenant, read from the database, never copied forward;
//   - every other role still changes the password and gets no pass, as before:
//     the change ends their current pass, and signing in again runs the scope
//     check;
//   - a locked account (users.locked_until still ahead) is refused with 401
//     before anything changes, as /auth/refresh refuses it. The pass still
//     works, so the sentence says how many minutes are left and never "sign in
//     again"; the Profile page shows it and keeps the pass;
//   - the new password follows the one minimum every password door uses
//     (PASSWORD_MIN_LEN, S631).
tenantsRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {}
    if (!currentPassword || !newPassword || typeof currentPassword !== 'string') {
      throw new AppError(400, 'Current and new password required')
    }
    const { PASSWORD_MIN_LEN } = await import('@gam/shared')
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LEN) {
      throw new AppError(400, `New password must be at least ${PASSWORD_MIN_LEN} characters`)
    }
    const bcrypt = require('bcryptjs')
    const user = await queryOne<{
      password_hash: string; sessions_valid_from: Date | null; locked_until: Date | null
      role: string; email: string; tenant_id: string | null
    }>(
      `SELECT u.password_hash, u.sessions_valid_from, u.locked_until, u.role, u.email,
              (SELECT t.id FROM tenants t WHERE t.user_id = u.id LIMIT 1) AS tenant_id
         FROM users u WHERE u.id=$1`, [req.user!.userId])
    if (!user) throw new AppError(404, 'User not found')
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      // The pass itself still works, so the sentence never says "sign in
      // again" — the tenant is still signed in and only this change waits.
      // It says how long, in whole minutes, so the next step is plain.
      const minutesLeft = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000))
      throw new AppError(401,
        `Your account is temporarily locked after too many sign-in attempts. ` +
        `Try again in ${minutesLeft} ${minutesLeft === 1 ? 'minute' : 'minutes'}, or reset your password from the sign-in page.`)
    }
    const { assertPassPostdatesPasswordChange } = await import('./auth')
    assertPassPostdatesPasswordChange(req.user, user.sessions_valid_from)
    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) throw new AppError(400, 'Your current password is incorrect. Check it and try again.')
    const hash = await bcrypt.hash(newPassword, 10)
    const changedAtSecond = Math.floor(Date.now() / 1000)
    await query(
      'UPDATE users SET password_hash=$1, sessions_valid_from=to_timestamp($3::double precision) WHERE id=$2',
      [hash, req.user!.userId, changedAtSecond])
    if (req.user!.role !== 'tenant' || user.role !== 'tenant') {
      return res.json({ success: true })
    }
    // A tenant's claims as /auth/refresh builds them (sessionClaimsFor): no
    // scope, no company, nothing carried over from the asking pass. Same
    // policy: a rolling pass gets a fresh seven days, a fixed one keeps its
    // original end (lib/sessionToken.ts).
    const { renewSessionToken } = await import('../lib/sessionToken')
    const tenantClaims = {
      userId:      req.user!.userId,
      role:        user.role,
      email:       user.email,
      profileId:   user.tenant_id,
      landlordId:  null,
      landlordIds: null,
      businessId:  null,
      staffRole:   null,
      permissions: null,
    }
    const token = renewSessionToken(tenantClaims, req.user!)
    res.json({ success: true, data: { token } })
  } catch (e) { next(e) }
})

// ── TENANT LEASE SIGNING ──────────────────────────────────────
tenantsRouter.get('/lease', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const unit = await queryOne<any>(`
      SELECT u.* FROM units u
      JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.tenant_id = $1 AND lt.status = 'active'
      LIMIT 1`, [tenant.id])
    if (!unit) throw new AppError(404, 'No active unit')
    // S483: extended SELECT pulls property state + security_deposit
    // (from lease_fees post-S196) so the state-law compute below has
    // all the inputs it needs without a second round-trip.
    const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
    const lease = await queryOne<any>(`
      SELECT l.*, p.name as property_name, p.state as property_state,
        u.unit_number,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        COALESCE(vuo.primary_first_name || ' ' || vuo.primary_last_name, '') as tenant_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE l.unit_id = $1 AND l.status IN ('pending','active')
        -- S655: never a new lease whose lease before it ENDED EARLY with nobody
        -- signed — nobody is staying on; it never starts and is being canceled.
        AND NOT ${followsLeaseEndedEarlyUnsigned('l')}
      -- S655: the lease in force first. A new lease waiting to start is the
      -- NEXT lease (attached below), not "their lease".
      ORDER BY (l.status = 'active') DESC, l.created_at DESC LIMIT 1`, [unit.id])
    const nextLease = lease ? await nextLeaseFor(lease.id) : null

    // S483: state-law warnings recomputed against the persisted lease.
    // The tenant sees the same hedged factual notice the landlord saw
    // at PATCH time — completes the both-party transparency loop for
    // lease terms (S478 closed it for entry requests). Best-effort.
    let stateLawWarnings: LawFlag[] = []
    if (lease) {
      try {
        stateLawWarnings = await checkLeaseAgainstStateLaw({
          stateCode:             lease.property_state,
          rentAmount:            Number(lease.rent_amount),
          securityDepositAmount: lease.security_deposit != null ? Number(lease.security_deposit) : null,
          lateFeeInitialAmount:  lease.late_fee_initial_amount != null ? Number(lease.late_fee_initial_amount) : null,
          lateFeeInitialType:    lease.late_fee_initial_type,
          lateFeeGraceDays:      lease.late_fee_grace_days != null ? Number(lease.late_fee_grace_days) : null,
        })
      } catch (e) {
        logger.error({ err: e, lease_id: lease.id }, '[stateLaw] tenant lease GET checks failed')
      }
    }

    res.json({
      success: true,
      // S508: document_url always points at the on-demand lease-PDF endpoint
      // so the in-browser viewer renders every lease (generated from terms when
      // there's no e-signed/imported PDF). camelized → lease.documentUrl.
      data: lease
        ? { ...lease, document_url: `/api/leases/${lease.id}/pdf`, state_law_warnings: stateLawWarnings, next_lease: nextLease }
        : lease,
    })
  } catch (e) { next(e) }
})

/**
 * S655 (Nic, 10/2): the household's NEW LEASE, once the landlord has signed it
 * — it takes over on its start date whether or not they have signed, so the
 * lease page shows it as what comes next ("Your next lease starts …") instead of
 * a second, identical lease, and without the expiring-lease countdown or the
 * "are you staying?" question on the one it follows.
 */
async function nextLeaseFor(leaseId: string): Promise<any | null> {
  return queryOne<any>(`
    SELECT s.id, to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.rent_amount, s.rent_due_day,
           s.status, s.signed_by_tenant,
           (SELECT d.id FROM lease_documents d
             WHERE d.lease_id = s.id AND d.status IN ('sent','in_progress','completed')
             ORDER BY d.created_at DESC LIMIT 1) AS document_id
      FROM leases s
     WHERE s.supersedes_lease_id = $1
       AND s.status IN ('pending','active')
       AND s.signed_by_landlord = TRUE
     ORDER BY s.start_date ASC LIMIT 1`, [leaseId])
}

// S554 (Oak Park): a tenant can hold MORE THAN ONE active lease — e.g. space
// rent on two mobile homes under the same landlord (the same-landlord overlap
// exception in esign.ts allows this deliberately). GET /lease (above) returns
// only the first (LIMIT 1); this plural route returns EVERY active/pending
// lease so the portal can switch between them. Billing is already per-lease
// (payments/invoices carry lease_id), so this closes the display gap.
tenantsRouter.get('/leases', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
    const leases = await query<any>(`
      SELECT l.*, p.name as property_name, p.state as property_state,
        u.unit_number,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit,
        lu.first_name || ' ' || lu.last_name as landlord_name,
        COALESCE(vuo.primary_first_name || ' ' || vuo.primary_last_name, '') as tenant_name
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE lt.tenant_id = $1
        AND lt.status = 'active'
        AND l.status IN ('pending', 'active')
        -- S655: never a new lease whose lease before it ENDED EARLY with nobody
        -- signed. With the lease it follows gone from this list it used to show
        -- as their own lease, offered for signing — and a signature made it
        -- stand and bill a household that had left.
        AND NOT ${followsLeaseEndedEarlyUnsigned('l')}
      ORDER BY (l.status = 'active') DESC, l.created_at DESC`, [tenant.id])

    // S655: a new lease of a lease in this list is that lease's NEXT lease, not
    // a second lease — it rides on the one it follows (next_lease) instead of
    // showing as a second, identical "Property · Unit" in the switcher.
    const listed = new Set((leases as any[]).map((l: any) => l.id))
    const followers = (leases as any[]).filter((l: any) =>
      l.supersedes_lease_id && listed.has(l.supersedes_lease_id) && l.signed_by_landlord)
    const folded = new Set(followers.map((l: any) => l.id))

    const enriched = []
    for (const lease of (leases as any[]).filter((l: any) => !folded.has(l.id))) {
      let stateLawWarnings: LawFlag[] = []
      try {
        stateLawWarnings = await checkLeaseAgainstStateLaw({
          stateCode:             lease.property_state,
          rentAmount:            Number(lease.rent_amount),
          securityDepositAmount: lease.security_deposit != null ? Number(lease.security_deposit) : null,
          lateFeeInitialAmount:  lease.late_fee_initial_amount != null ? Number(lease.late_fee_initial_amount) : null,
          lateFeeInitialType:    lease.late_fee_initial_type,
          lateFeeGraceDays:      lease.late_fee_grace_days != null ? Number(lease.late_fee_grace_days) : null,
        })
      } catch (e) {
        logger.error({ err: e, lease_id: lease.id }, '[stateLaw] tenant leases GET checks failed')
      }
      const nextLease = followers.some((f: any) => f.supersedes_lease_id === lease.id)
        ? await nextLeaseFor(lease.id) : null
      enriched.push({ ...lease, document_url: `/api/leases/${lease.id}/pdf`, state_law_warnings: stateLawWarnings, next_lease: nextLease })
    }

    res.json({ success: true, data: enriched })
  } catch (e) { next(e) }
})

tenantsRouter.post('/lease/sign', requireAuth, async (req, res, next) => {
  // Removed S20. Tenant signing is handled exclusively by the e-sign flow.
  // Tenants sign documents at POST /api/esign/sign/:documentId after a
  // landlord creates a lease_documents record and sends it.
  res.status(410).json({
    success: false,
    error: 'Direct lease signing is no longer supported. Signatures are handled through e-sign at /api/esign/sign/:documentId.'
  })
})

// S210 (S202 carry): addendum history for the tenant's active lease.
// Returns lease_addendum_recorded credit-ledger events scoped to the
// requesting tenant + their current lease. Includes event_data.changes
// (the diff) so the LeasePage UI can render what actually changed in
// each addendum — the /credit page shows the events but redacts the
// per-event payload, which leaves the tenant unable to see WHAT the
// addendum modified.
tenantsRouter.get('/lease/addendums', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<{ id: string }>(
      'SELECT id FROM tenants WHERE user_id=$1', [req.user!.userId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const lease = await queryOne<{ id: string; landlord_id: string }>(`
      SELECT l.id, l.landlord_id
        FROM leases l
        JOIN lease_tenants lt ON lt.lease_id = l.id
       WHERE lt.tenant_id = $1
         AND lt.status = 'active'
         AND l.status IN ('active', 'pending')
       -- S655: the lease in force, not a new lease still waiting to start.
       ORDER BY (l.status = 'active') DESC, l.created_at DESC
       LIMIT 1`,
      [tenant.id]
    )
    if (!lease) return res.json({ success: true, data: [] })

    const events = await query<{
      id: string
      occurred_at: string
      changes: Array<{ field: string; from: string; to: string }>
      pdf_filename: string | null
      recorded_by_user_id: string | null
    }>(`
      SELECT ev.id,
             ev.occurred_at,
             ev.event_data->'changes'              AS changes,
             ev.event_data->>'pdf_filename'        AS pdf_filename,
             ev.event_data->>'recorded_by_user_id' AS recorded_by_user_id
        FROM credit_events ev
        JOIN credit_subjects cs ON cs.id = ev.subject_id
       WHERE cs.subject_type = 'tenant'
         AND cs.subject_ref_id = $1
         AND ev.event_type = 'lease_addendum_recorded'
         AND ev.event_data->>'lease_id' = $2
         AND ev.superseded_by IS NULL
       ORDER BY ev.occurred_at DESC`,
      [tenant.id, lease.id]
    )

    // S214: resolve recorded_by_user_id to display name. Tenants get
    // name only; role attribution doesn't help them. Resolution is
    // per-event because dev volume is low; if catalog grows large,
    // batch by deduping the user IDs first.
    const { resolveAddendumActor } = await import('../services/addendumActor')
    const resolved = await Promise.all(
      events.map(async (e) => {
        const actor = await resolveAddendumActor(e.recorded_by_user_id, lease.landlord_id)
        return {
          id:               e.id,
          occurred_at:      e.occurred_at,
          changes:          e.changes,
          pdf_filename:     e.pdf_filename,
          recorded_by_name: actor.name,
        }
      })
    )

    res.json({ success: true, data: resolved })
  } catch (e) { next(e) }
})

tenantsRouter.get('/work-trade', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT t.id FROM tenants t WHERE t.user_id=$1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'Tenant not found')
    const agreement = await queryOne<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name, p.id AS property_id
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE wta.tenant_id=$1 AND wta.status='active'
      ORDER BY wta.created_at DESC LIMIT 1`, [tenant.id])
    res.json({ success: true, data: agreement || null })
  } catch (e) { next(e) }
})

// DEPRECATED (S381): predates the FlexCharge subsystem (S109+).
// The legacy SQL referenced pos_transactions.settled which doesn't
// exist in the schema — any call would have 500'd. The canonical
// tenant-side charge-account surface is GET /api/tenants/flexcharge
// (delegates to services/flexCharge), which returns the accounts
// (with credit_limit + outstanding balance derived from
// flex_charge_statements) and transactions for the tenant.
// Returns 410 to prevent any straggler client from re-attempting
// the broken endpoint.
tenantsRouter.get('/charge-account', requireAuth, async (_req, res) => {
  res.status(410).json({
    success: false,
    error: 'Tenant-side /charge-account is deprecated. Use /api/tenants/flexcharge for FlexCharge account + transaction data.',
  })
})
