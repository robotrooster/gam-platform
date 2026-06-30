import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { UserRole } from '@gam/shared'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { sendPasswordResetEmail, sendEmailVerification } from '../services/email'
import { isDisposableEmail } from '../lib/email'
import { signTotpSessionToken } from './totp'
import { MANDATORY_TOTP_ROLES } from '../lib/totp'

// S80: scope-table dispatch for login / refresh JWT claims. Replaced the
// pre-S80 team_members LEFT JOIN. Role-keyed lookup against the right
// per-role scope table; bookkeeper returns its access_level packed into
// the same permissions shape so JWT consumers don't need to special-case.
async function getScopeForUser(userId: string, role: string):
  Promise<{
    landlordId: string | null
    permissions: Record<string, any> | null
    /** S168: per-manager Connect opt-in toggle. Property_manager only;
     *  null for other worker roles since they have no rent-share path. */
    directDepositEnabled?: boolean
    /** S453: business-side scope. Set for business_staff (resolved from
     *  business_users). landlordId stays null — business_staff lives
     *  in a parallel scope tree, not the landlord one. */
    businessId?: string | null
    staffRole?:  string | null
  } | null>
{
  if (role === 'business_staff') {
    const r = await queryOne<any>(
      `SELECT business_id, staff_role, permissions
         FROM business_users
        WHERE user_id = $1 AND status = 'active'
        LIMIT 1`,
      [userId])
    return r ? {
      landlordId: null,
      businessId: r.business_id,
      staffRole:  r.staff_role,
      permissions: r.permissions || {},
    } : null
  }
  if (role === 'property_manager') {
    const r = await queryOne<any>(
      `SELECT landlord_id, permissions, direct_deposit_enabled
         FROM property_manager_scopes WHERE user_id = $1 LIMIT 1`,
      [userId])
    return r ? {
      landlordId: r.landlord_id,
      permissions: r.permissions || {},
      directDepositEnabled: !!r.direct_deposit_enabled,
    } : null
  }
  if (role === 'onsite_manager') {
    const r = await queryOne<any>(
      `SELECT landlord_id, permissions FROM onsite_manager_scopes WHERE user_id = $1 LIMIT 1`,
      [userId])
    return r ? { landlordId: r.landlord_id, permissions: r.permissions || {} } : null
  }
  if (role === 'maintenance') {
    const r = await queryOne<any>(
      `SELECT landlord_id, permissions FROM maintenance_worker_scopes WHERE user_id = $1 LIMIT 1`,
      [userId])
    return r ? { landlordId: r.landlord_id, permissions: r.permissions || {} } : null
  }
  if (role === 'bookkeeper') {
    const r = await queryOne<any>(
      `SELECT landlord_id, access_level FROM bookkeeper_scopes WHERE user_id = $1 LIMIT 1`,
      [userId])
    return r ? { landlordId: r.landlord_id, permissions: { access_level: r.access_level } } : null
  }
  return null
}

export const authRouter = Router()

// S282: minimum 12 chars (was 8). Modern guidance (NIST SP 800-63B)
// favors length over composition rules because composition pushes
// users toward predictable patterns ("Password1!") that don't help
// against modern attacks. Length increases brute-force cost
// directly. Composition checks intentionally skipped.
const PASSWORD_MIN_LEN = 12

const registerSchema = z.object({
  email:     z.string().email(),
  password:  z.string().min(PASSWORD_MIN_LEN),
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  phone:     z.string().optional(),
  role:      z.enum(['landlord', 'tenant']),
  // Legal acceptance — frontend gate sets this true when the user
  // checks the Terms + Privacy acknowledgement at registration.
  // We refuse the request if it's false or missing so the timestamps
  // on users.accepted_tos_at / accepted_privacy_at are never a lie.
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy to register' }),
  }),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
})

function signToken(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' })
}

// POST /api/auth/register
authRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body)
    // S417: disposable-domain block on the main self-serve signup path.
    if (isDisposableEmail(body.email)) {
      throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
    }
    const exists = await queryOne('SELECT id FROM users WHERE email = $1', [body.email])
    if (exists) throw new AppError(409, 'Email already registered')

    const hash = await bcrypt.hash(body.password, 12)
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Model C (PM-company self-register + all registrations): require
      // email verification in production, auto-verify in local dev so
      // testing doesn't need to click an email link. 'test' is excluded so
      // the email-verification suites still exercise the real gate.
      const env = process.env.NODE_ENV
      const devAutoVerify = env !== 'production' && env !== 'test'

      const [user] = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
                            accepted_tos_at, accepted_privacy_at, email_verified, email_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW(), $7, ${devAutoVerify ? 'NOW()' : 'NULL'})
         RETURNING id, email, role, first_name, last_name`,
        [body.email, hash, body.role, body.firstName, body.lastName, body.phone ?? null, devAutoVerify]
      ).then(r => r.rows)

      let profileId: string
      if (body.role === 'landlord') {
        const [l] = await client.query(
          `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [user.id]
        ).then(r => r.rows)
        profileId = l.id
      } else {
        const [t] = await client.query(
          `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [user.id]
        ).then(r => r.rows)
        profileId = t.id
      }

      await client.query('COMMIT')

      // S281: mint + email verification token AFTER commit. Failure
      // here doesn't fail the registration — the user can request a
      // resend via /api/auth/resend-verification. Skipped in dev where
      // the account is already auto-verified (model C).
      if (!devAutoVerify) void mintAndSendVerifyEmail(user.id, user.email, user.first_name)

      const token = signToken({ userId: user.id, role: user.role, email: user.email, profileId })
      res.status(201).json({
        success: true,
        data: { token, user: { id: user.id, email: user.email, role: user.role,
          firstName: user.first_name, lastName: user.last_name, profileId } }
      })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// S280: per-account lockout config. 5 failures → 15-min lock.
// Defends against credential-stuffing distributed across many IPs
// (the per-IP rate-limit at /api/auth/* doesn't help against that).
const LOGIN_FAIL_LIMIT = 5
const LOGIN_LOCK_MINUTES = 15

// POST /api/auth/login
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body)
    const user = await queryOne<any>(
      `SELECT u.*,
              COALESCE(l.id, t.id, b.id) AS profile_id,
              b.id                       AS business_id
       FROM users u
       LEFT JOIN landlords  l ON l.user_id = u.id
       LEFT JOIN tenants    t ON t.user_id = u.id
       -- S453: business_owner login also resolves business_id directly.
       -- business_staff users go through getScopeForUser instead because
       -- their business_id lives in the scope row.
       LEFT JOIN businesses b ON b.owner_user_id = u.id AND b.status = 'active'
       WHERE u.email = $1`, [email]
    )
    if (!user) throw new AppError(401, 'Invalid credentials')

    // S280: lockout gate — BEFORE bcrypt.compare. Even with the
    // right password, a locked account stays locked until the
    // window expires. (Successful unlock requires either waiting
    // out the timer or using password reset.)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError(
        401,
        `Account temporarily locked. Try again after ${new Date(user.locked_until).toISOString()} or reset your password.`
      )
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      // Bump the counter; lock if we've hit the threshold. Combined
      // into one UPDATE so a flurry of concurrent bad-password
      // attempts can't slip past the gate by reading a stale count.
      await db.query(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE
                  WHEN failed_login_count + 1 >= $2
                    THEN NOW() + ($3 || ' minutes')::interval
                  ELSE locked_until
                END
          WHERE id = $1`,
        [user.id, LOGIN_FAIL_LIMIT, LOGIN_LOCK_MINUTES]
      )
      throw new AppError(401, 'Invalid credentials')
    }

    // S280: success path resets the counter + clears any expired
    // lockout. Keeps the `users` row clean over time even when the
    // user mixes successful + failed logins.
    await db.query(
      `UPDATE users
          SET last_login_at = NOW(),
              failed_login_count = 0,
              locked_until = NULL
        WHERE id = $1`,
      [user.id]
    )

    // S281: email verification gate. AFTER bcrypt + counter reset so
    // an unverified user with wrong password gets generic "Invalid
    // credentials"; only after proving the password do we tell them
    // "please verify". Auto-resend the verification email to make
    // recovery one-click — they may have lost the original.
    if (!user.email_verified) {
      void mintAndSendVerifyEmail(user.id, user.email, user.first_name)
      throw new AppError(
        401,
        'Please verify your email before signing in. A new verification link was just sent.'
      )
    }

    // For landlord-assignable roles + business_staff, look up the scope
    // row to pull (landlordId | businessId) + permissions for the JWT
    // claim. Absence of a scope row for a worker role means the user was
    // scoped at some point but their scope was revoked — block login.
    // S453: business_staff joins the worker list and goes through the
    // same gate. business_owner is NOT a worker — its business_id comes
    // off the JOIN's `business_id` column directly.
    const isWorkerRole = ['property_manager','onsite_manager','maintenance','bookkeeper','business_staff'].includes(user.role)
    const scope = isWorkerRole ? await getScopeForUser(user.id, user.role) : null
    if (isWorkerRole && !scope) {
      const msg = user.role === 'business_staff'
        ? 'Your account has been deactivated. Contact your business owner.'
        : 'Your account has been deactivated. Contact your landlord.'
      throw new AppError(403, msg)
    }
    const profileId = user.profile_id || scope?.landlordId || scope?.businessId || null
    // S453: businessId carries either the owner's business (from JOIN) or
    // the staff member's scoped business (from getScopeForUser). null for
    // any non-business role.
    const businessId = user.role === 'business_owner'
      ? (user.business_id || null)
      : (scope?.businessId || null)
    const staffRole = user.role === 'business_staff'
      ? (scope?.staffRole || null)
      : null

    // S288: TOTP gate. If the user has 2FA enabled, don't issue the
    // full session JWT yet — mint a short-lived totp_session that
    // the client trades for the full token after submitting a valid
    // 6-digit code (or a recovery code) at /api/auth/totp/verify.
    if (user.totp_enabled) {
      const totpSession = signTotpSessionToken({
        userId:      user.id,
        role:        user.role,
        email:       user.email,
        profileId,
        landlordId:  scope?.landlordId || null,
        permissions: scope?.permissions || null,
      })
      return res.json({
        success: true,
        data: { requiresTotp: true, totpSession },
      })
    }

    const token = signToken({
      userId: user.id, role: user.role, email: user.email,
      profileId,
      landlordId: scope?.landlordId || null,
      businessId,
      staffRole,
      permissions: scope?.permissions || null,
    })
    res.json({
      success: true,
      data: { token, user: {
        id: user.id, email: user.email, role: user.role,
        firstName: user.first_name, lastName: user.last_name,
        profileId,
        landlordId: scope?.landlordId || null,
        businessId,
        staffRole,
        permissions: scope?.permissions || null,
        directDepositEnabled: scope?.directDepositEnabled ?? false,
        // S288: forces enrollment-flow on first login post-rollout for
        // roles where TOTP is mandatory at launch. Frontend uses this
        // to gate access until totp_enabled flips TRUE.
        mustEnrollTotp: MANDATORY_TOTP_ROLES.has(user.role) && !user.totp_enabled,
      }}
    })
  } catch (e) { next(e) }
})

// GET /api/auth/me
// S67: bank_account_ready is derived from active user_bank_accounts rows
// (the 16a per-user catalog) rather than landlords.stripe_bank_verified
// (the pre-16a Stripe Connect flag, slated for deletion).
// S82: includes landlordId + permissions for worker roles so the
// landlord-portal nav can perm-filter on page load. Source of truth is
// the scope table (re-fetched, not cached on the JWT) so toggle changes
// land on the next /me without forcing logout.
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne<any>(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone,
         u.totp_enabled,
         COALESCE(l.id, t.id, b.id) AS profile_id,
         l.business_name, l.onboarding_complete,
         b.id   AS business_id,
         b.name AS business_name_b,
         b.business_type,
         EXISTS (
           SELECT 1 FROM user_bank_accounts ba
            WHERE ba.user_id = u.id AND ba.status = 'active'
         ) AS bank_account_ready,
         t.ach_verified, t.on_time_pay_enrolled, t.credit_reporting_enrolled
       FROM users u
       LEFT JOIN landlords  l ON l.user_id = u.id
       LEFT JOIN tenants    t ON t.user_id = u.id
       LEFT JOIN businesses b ON b.owner_user_id = u.id AND b.status = 'active'
       WHERE u.id = $1`, [req.user!.userId]
    )
    if (!user) throw new AppError(404, 'User not found')

    const isWorkerRole = ['property_manager','onsite_manager','maintenance','bookkeeper','business_staff'].includes(user.role)
    const scope = isWorkerRole ? await getScopeForUser(user.id, user.role) : null
    // S453: business_owner has business_id directly from the JOIN; staff
    // resolves through scope. Mirrored both ways so frontend can read
    // either naming.
    const businessId = user.role === 'business_owner'
      ? (user.business_id || null)
      : (scope?.businessId || null)
    const staffRole = user.role === 'business_staff'
      ? (scope?.staffRole || null)
      : null

    // Emit both snake_case (for any legacy consumer) and camelCase
    // (what AuthContext.AuthUser expects) for the new fields.
    res.json({ success: true, data: {
      ...user,
      landlord_id: scope?.landlordId || null,
      landlordId:  scope?.landlordId || null,
      business_id: businessId,
      businessId,
      staff_role:  staffRole,
      staffRole,
      permissions: scope?.permissions || null,
      // S168: surfaces the per-manager Connect opt-in toggle so the
      // landlord-portal nav can gate the /banking entry for managers
      // without an extra round-trip on each render.
      directDepositEnabled: scope?.directDepositEnabled ?? false,
      // S289: server-computed flag — true when the user's role is in
      // MANDATORY_TOTP_ROLES AND they haven't enrolled. Frontend uses
      // it to force the /totp/enroll flow before any other route.
      // Computing on the server keeps the role-policy single-sourced
      // in lib/totp.ts (no second client-side copy to drift).
      //
      // Emit both casings: the production response goes through the
      // camelCase middleware in index.ts that converts snake → camel
      // wire-side, but a few consumers (and some test harnesses)
      // bypass that middleware. Both keys land at all times.
      totpEnabled:    !!user.totp_enabled,
      mustEnrollTotp: MANDATORY_TOTP_ROLES.has(user.role) && !user.totp_enabled,
    }})
  } catch (e) { next(e) }
})

// POST /api/auth/refresh
authRouter.post('/refresh', requireAuth, (req, res) => {
  // req.user comes back from jwt.verify with iat+exp set; jwt.sign refuses
  // to re-mint a token when expiresIn is supplied AND the payload already
  // carries an exp. Strip both before re-signing so signToken's '7d' TTL
  // is the only one in play.
  const { iat, exp, ...claims } = req.user as any
  const token = signToken(claims)
  res.json({ success: true, data: { token } })
})

// PATCH /api/auth/me — update user profile
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { firstName, lastName, phone } = req.body
    await query(`UPDATE users SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name), phone=COALESCE($3,phone), updated_at=NOW() WHERE id=$4`,
      [firstName||null, lastName||null, phone||null, req.user!.userId])
    const user = await queryOne<any>('SELECT * FROM users WHERE id=$1', [req.user!.userId])
    res.json({ success: true, data: user })
  } catch(e) { next(e) }
})

// POST /api/auth/register-prospect — public, creates tenant account from listings page
authRouter.post('/register-prospect', async (req, res, next) => {
  try {
    const { firstName, lastName, email, password, phone, unitId, landlordId, acceptedTerms } = req.body
    if (!firstName || !lastName || !email || !password)
      throw new AppError(400, 'firstName, lastName, email, password required')
    if (password.length < PASSWORD_MIN_LEN)
      throw new AppError(400, `Password must be at least ${PASSWORD_MIN_LEN} characters`)
    if (acceptedTerms !== true)
      throw new AppError(400, 'You must accept the Terms of Service and Privacy Policy to register')
    // S417: disposable-domain block on the public prospect registration
    // path. Without this, mailinator addresses could create tenant
    // accounts wholesale, defeating verification and adverse-selection
    // defenses.
    if (typeof email === 'string' && isDisposableEmail(email)) {
      throw new AppError(400, 'Disposable / temporary email addresses are not allowed')
    }

    // Check email not already taken
    const existing = await queryOne('SELECT id FROM users WHERE email=$1', [email])
    if (existing) throw new AppError(409, 'An account with this email already exists. Please sign in.')

    const hash = await bcrypt.hash(password, 12)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Create user
      const { rows: [user] } = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
                            accepted_tos_at, accepted_privacy_at)
         VALUES ($1,$2,'tenant',$3,$4,$5, NOW(), NOW()) RETURNING *`,
        [email, hash, firstName, lastName, phone || null]
      )

      // Create tenant profile
      const { rows: [tenant] } = await client.query(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING *`,
        [user.id]
      )

      // Unit assignment happens via e-sign, not at signup.
      // unitId in the request body is ignored here; landlord sends a lease
      // document through /api/esign after the account exists.

      await client.query('COMMIT')

      // S281: mint + email verification token after commit.
      void mintAndSendVerifyEmail(user.id, user.email, user.first_name)

      // Issue token. S277: dropped the `|| 'gam_dev_secret'` fallback —
      // the literal string is committed to the repo, so it would
      // forge tokens for any user if JWT_SECRET were ever unset in
      // prod. Match the rest of the codebase: non-null assertion
      // fails-closed when env is unset.
      const token = jwt.sign(
        { userId: user.id, role: 'tenant', profileId: tenant.id, landlordId: landlordId || null },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      )

      res.status(201).json({ success: true, data: { token, user: { id: user.id, email: user.email, firstName, lastName, role: 'tenant' } } })
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  } catch (e) { next(e) }
})

// ── S279: password reset ──────────────────────────────────────
//
// Two-step flow. `forgot-password` always returns 200 regardless of
// whether the email exists — leaking that distinction lets an attacker
// enumerate accounts. `reset-password` consumes the token once and
// does NOT auto-sign-in: forcing a fresh login proves the user
// remembers the new password.
//
// Token: 32-byte hex, single-use, 1h TTL. Stored on
// `users.reset_token` (S277 surfaced this column existed but no route
// touched it). Cleared on successful use.

const forgotPasswordSchema = z.object({ email: z.string().email() })
const resetPasswordSchema  = z.object({
  token:       z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LEN),
})

const RESET_TOKEN_TTL_MINUTES = 60

// POST /api/auth/forgot-password
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body)
    const user = await queryOne<{ id: string; first_name: string | null }>(
      `SELECT id, first_name FROM users WHERE email = $1`,
      [email],
    )
    if (user) {
      // 32 bytes hex = 64 chars. Cryptographically random; safe to put
      // in a URL query param.
      const token = crypto.randomBytes(32).toString('hex')
      await query(
        `UPDATE users
            SET reset_token = $1,
                reset_token_expires = NOW() + ($2 || ' minutes')::interval
          WHERE id = $3`,
        [token, RESET_TOKEN_TTL_MINUTES, user.id],
      )
      // Where the link goes is per-deploy. RESET_PASSWORD_URL points at
      // whichever portal (tenant by default, but landlord/admin work
      // too since the underlying form just consumes the token).
      const base = process.env.RESET_PASSWORD_URL
        || 'http://localhost:3002/reset-password'
      const resetUrl = `${base}?token=${encodeURIComponent(token)}`
      // Fire-and-forget — don't let email-send latency bound the
      // response time, and don't surface email failures to the
      // unauthenticated caller. Failures land in email_send_log
      // (services/email.ts:send) for ops visibility.
      void sendPasswordResetEmail(email, user.first_name, resetUrl, { userId: user.id })
    }
    // Same response shape regardless of whether the email existed.
    res.json({ success: true, data: { message: 'If an account exists for that email, a reset link has been sent.' } })
  } catch (e) { next(e) }
})

// POST /api/auth/reset-password
authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body)
    const user = await queryOne<{ id: string }>(
      `SELECT id FROM users
        WHERE reset_token = $1
          AND reset_token_expires IS NOT NULL
          AND reset_token_expires > NOW()`,
      [token],
    )
    if (!user) throw new AppError(400, 'Reset link is invalid or expired')

    const hash = await bcrypt.hash(newPassword, 12)
    // Clear the token in the SAME UPDATE to enforce single-use — a
    // concurrent attempt with the same token sees reset_token=NULL on
    // re-query and 400s.
    // S280: a successful reset also clears any lockout state. The
    // user proved control of the registered email; that's stronger
    // evidence than waiting out a 15-min lockout timer.
    await query(
      `UPDATE users
          SET password_hash = $1,
              reset_token = NULL,
              reset_token_expires = NULL,
              failed_login_count = 0,
              locked_until = NULL,
              updated_at = NOW()
        WHERE id = $2`,
      [hash, user.id],
    )
    res.json({ success: true, data: { message: 'Password updated. Please sign in with your new password.' } })
  } catch (e) { next(e) }
})

// ── S281: email verification ──────────────────────────────────
//
// users.email_verified gates /login. New registrations write the
// row with email_verified=false + a verify_token; the registration
// JWT is still issued (current-session UX stays smooth), but logging
// out and back in requires verification.
//
// Token: 32-byte hex, single-use. No TTL — verification email might
// sit in a spam folder for days, and there's no security benefit to
// expiring it (compared to password-reset where the security model
// is "limit the window an intercepted email is dangerous").

const verifyEmailSchema     = z.object({ token: z.string().min(1) })
const resendVerifySchema    = z.object({ email: z.string().email() })

async function mintAndSendVerifyEmail(userId: string, email: string, firstName: string | null): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex')
  await query(
    `UPDATE users SET email_verify_token = $1 WHERE id = $2`,
    [token, userId],
  )
  const base = process.env.VERIFY_EMAIL_URL
    || 'http://localhost:3002/verify-email'
  const verifyUrl = `${base}?token=${encodeURIComponent(token)}`
  // Fire-and-forget; failures land in email_send_log.
  void sendEmailVerification(email, firstName, verifyUrl, { userId })
}

// POST /api/auth/verify-email
authRouter.post('/verify-email', async (req, res, next) => {
  try {
    const { token } = verifyEmailSchema.parse(req.body)
    // Single-use: the same UPDATE clears the token. A replay sees
    // email_verify_token=NULL and matches no row.
    const r = await query<{ id: string }>(
      `UPDATE users
          SET email_verified = TRUE,
              email_verified_at = NOW(),
              email_verify_token = NULL,
              updated_at = NOW()
        WHERE email_verify_token = $1
        RETURNING id`,
      [token],
    )
    if (r.length === 0) throw new AppError(400, 'Verification link is invalid or already used')
    res.json({ success: true, data: { message: 'Email verified. You can now sign in.' } })
  } catch (e) { next(e) }
})

// POST /api/auth/resend-verification
//
// Anti-enumeration: same 200 response shape whether the email exists
// or not, and whether the account is verified or not. Internally:
// known + unverified → mint new token + send email; everyone else
// → no-op.
authRouter.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = resendVerifySchema.parse(req.body)
    const user = await queryOne<{
      id: string; first_name: string | null; email_verified: boolean
    }>(
      `SELECT id, first_name, email_verified FROM users WHERE email = $1`,
      [email],
    )
    if (user && !user.email_verified) {
      await mintAndSendVerifyEmail(user.id, email, user.first_name)
    }
    res.json({ success: true, data: { message: 'If an account exists for that email and is not yet verified, a verification email has been sent.' } })
  } catch (e) { next(e) }
})
