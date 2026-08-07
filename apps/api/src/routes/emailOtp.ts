/**
 * Email-code 2FA (S565).
 *
 * Second factor for admin/super_admin logins that don't use an authenticator
 * app. Flow:
 *   1. /login (password OK) — if the user has email_2fa_enabled and no TOTP,
 *      issueEmailOtp() emails a 6-digit code and /login returns
 *      { requiresEmailOtp: true, emailOtpSession: <short JWT> }.
 *   2. Client posts { emailOtpSession, code } to /api/auth/email-otp/verify.
 *      On match, the full session JWT is issued (same claim shape /login would
 *      have issued without 2FA).
 *   3. /resend re-issues a fresh code against the same pending session.
 *
 * The pending token carries `purpose: 'email_otp_pending'`, so requireAuth
 * rejects it everywhere except the verify/resend endpoints here — same guard
 * posture as the TOTP-pending token.
 */
import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { emailLoginCode } from '../services/email'
import { logger } from '../lib/logger'

export const emailOtpRouter = Router()

const OTP_TTL_MINUTES = 10
const PENDING_TTL_SECONDS = 15 * 60   // the session may outlive one code (allows a resend)
const FULL_SESSION_TTL = '7d'
const MAX_ATTEMPTS = 5
const BCRYPT_ROUNDS = 10

interface EmailOtpClaims {
  userId: string
  role: string
  email: string
  profileId: string | null
  landlordId?: string | null
  landlordIds?: string[] | null
  businessId?: string | null
  staffRole?: string | null
  permissions?: unknown
}

export function signEmailOtpSessionToken(claims: EmailOtpClaims): string {
  return jwt.sign(
    { ...claims, purpose: 'email_otp_pending' },
    process.env.JWT_SECRET!,
    { expiresIn: PENDING_TTL_SECONDS }
  )
}

function signFullToken(payload: object): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: FULL_SESSION_TTL })
}

/**
 * Generate + persist + email a fresh login code for a user. Any prior
 * unconsumed code is retired first (consumed) so only one code is ever live.
 * Returns the plaintext code ONLY so callers/tests can assert; production
 * callers ignore it (the code goes to the inbox, never the API response).
 */
export async function issueEmailOtp(
  userId: string,
  email: string,
  opts?: { skipSend?: boolean }
): Promise<string> {
  // 6-digit, zero-padded, cryptographically random.
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS)

  // Retire any live code so a resend supersedes the prior one.
  await query(
    `UPDATE login_email_otps SET consumed_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId]
  )
  await query(
    `INSERT INTO login_email_otps (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, 'login_2fa', NOW() + ($3 || ' minutes')::interval)`,
    [userId, codeHash, String(OTP_TTL_MINUTES)]
  )
  if (!opts?.skipSend) {
    try {
      await emailLoginCode(email, code, OTP_TTL_MINUTES, { userId })
    } catch (e) {
      logger.error({ err: e }, '[emailOtp] failed to send login code')
      // Don't leak send failure to the client as a hard error — the code is
      // stored; a resend can retry. But surface in logs.
    }
  }
  return code
}

const verifySchema = z.object({
  emailOtpSession: z.string(),
  code: z.string().min(4).max(10),
})

function readPendingSession(token: string): EmailOtpClaims & { purpose: string } {
  let session: any
  try {
    session = jwt.verify(token, process.env.JWT_SECRET!)
  } catch {
    throw new AppError(401, 'Sign-in session expired. Please log in again.')
  }
  if (!session || session.purpose !== 'email_otp_pending') {
    throw new AppError(401, 'Invalid sign-in session.')
  }
  return session
}

// POST /api/auth/email-otp/verify
emailOtpRouter.post('/verify', async (req, res, next) => {
  try {
    const { emailOtpSession, code } = verifySchema.parse(req.body)
    const session = readPendingSession(emailOtpSession)
    const userId = session.userId

    const otp = await queryOne<{
      id: string; code_hash: string; expires_at: string; attempts: number
    }>(
      `SELECT id, code_hash, expires_at, attempts
         FROM login_email_otps
        WHERE user_id = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    )
    if (!otp) throw new AppError(401, 'No active code. Request a new one.')
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      await query(`UPDATE login_email_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id])
      throw new AppError(401, 'Code expired. Request a new one.')
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      await query(`UPDATE login_email_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id])
      throw new AppError(401, 'Too many attempts. Request a new code.')
    }

    const ok = await bcrypt.compare(code.replace(/\s/g, ''), otp.code_hash)
    if (!ok) {
      await query(`UPDATE login_email_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id])
      throw new AppError(401, 'Invalid code.')
    }

    await query(`UPDATE login_email_otps SET consumed_at = NOW() WHERE id = $1`, [otp.id])

    // S578: completing an emailed code proves the user controls the address, so
    // it doubles as email verification. This lets signup's mandatory-2FA step
    // also verify the email (no separate link), and is a harmless no-op for an
    // already-verified login.
    await query(
      `UPDATE users
          SET email_verified = TRUE,
              email_verified_at = COALESCE(email_verified_at, NOW()),
              updated_at = NOW()
        WHERE id = $1 AND email_verified IS NOT TRUE`,
      [userId],
    )

    const token = signFullToken({
      userId:      session.userId,
      role:        session.role,
      email:       session.email,
      profileId:   session.profileId,
      landlordId:  session.landlordId ?? null,
      landlordIds: session.landlordIds ?? null,
      businessId:  session.businessId ?? null,
      staffRole:   session.staffRole ?? null,
      permissions: session.permissions ?? null,
    })
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: session.userId, email: session.email, role: session.role,
          profileId: session.profileId, landlordId: session.landlordId ?? null,
          permissions: session.permissions ?? null,
        },
      },
    })
  } catch (e) { next(e) }
})

// POST /api/auth/email-otp/resend
emailOtpRouter.post('/resend', async (req, res, next) => {
  try {
    const { emailOtpSession } = z.object({ emailOtpSession: z.string() }).parse(req.body)
    const session = readPendingSession(emailOtpSession)
    await issueEmailOtp(session.userId, session.email)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── Tenant email-2FA status (S571) ─────────────────────────────────────────
// Email 2FA is MANDATORY for every tenant, always (from signup) — it protects
// their private lease data. There is no enable/disable: it cannot be turned off.
// The code always goes to the LOGIN email (users.email) — there is no separate
// 2FA-email field, so changing the login email changes the destination
// automatically. This endpoint is read-only, for the informational Profile →
// Security card.
emailOtpRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne<{ email: string; role: string; email_2fa_enabled: boolean }>(
      `SELECT email, role, email_2fa_enabled FROM users WHERE id = $1`,
      [(req as any).user.userId]
    )
    if (!user) throw new AppError(404, 'User not found')
    res.json({
      success: true,
      data: {
        // Tenants are always on (mandatory); other roles reflect their flag.
        enabled: user.role === 'tenant' ? true : !!user.email_2fa_enabled,
        email:   user.email,   // where codes are sent (= login email)
      },
    })
  } catch (e) { next(e) }
})
