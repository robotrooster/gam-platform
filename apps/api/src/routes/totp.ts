/**
 * TOTP 2FA endpoints (S288).
 *
 * Flow:
 *   1. User logs in with email + password.
 *   2. If user.totp_enabled, /login returns
 *      `{ requires_totp: true, totp_session: <short-lived JWT> }`
 *      instead of the full session JWT.
 *   3. Client calls /api/auth/totp/verify with the totp_session and
 *      the 6-digit code (or a recovery code). On success the full
 *      JWT is issued.
 *
 * Enrollment is post-login:
 *   1. /api/auth/totp/enroll-start (full JWT required) generates a
 *      secret, returns the otpauth URL + QR data URI + 10 recovery
 *      codes (plaintext, one-shot). Stores secret + hashed codes.
 *   2. User scans the QR with their authenticator, enters the first
 *      6-digit code.
 *   3. /api/auth/totp/enroll-confirm verifies the code. If valid,
 *      flips totp_enabled=TRUE.
 *   4. From the next login on, the user is gated through /verify.
 *
 * Disable requires password re-confirmation to prevent a stolen
 * session from silently dropping the second factor.
 */

import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import {
  generateTotpSecret,
  otpauthUrlToQrDataUri,
  verifyTotpToken,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../lib/totp'

export const totpRouter = Router()

const TOTP_SESSION_TTL_SECONDS = 5 * 60   // 5 minutes
const FULL_SESSION_TTL = '7d'

function signFullToken(payload: object): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: FULL_SESSION_TTL })
}

/**
 * Mint a short-lived TOTP-pending token. Holds the user context the
 * /verify endpoint needs to issue the full JWT once the code clears.
 * Distinct `purpose` claim so a stolen totp_session can't be used
 * anywhere requireAuth() runs.
 */
export function signTotpSessionToken(payload: {
  userId:      string
  role:        string
  email:       string
  profileId:   string | null
  landlordId?: string | null
  permissions?: unknown
}): string {
  return jwt.sign(
    { ...payload, purpose: 'totp_pending' },
    process.env.JWT_SECRET!,
    { expiresIn: TOTP_SESSION_TTL_SECONDS }
  )
}

// ── POST /api/auth/totp/enroll-start ────────────────────────────
totpRouter.post('/enroll-start', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId as string
    const user = await queryOne<{
      email: string; totp_enabled: boolean
    }>(`SELECT email, totp_enabled FROM users WHERE id = $1`, [userId])
    if (!user) throw new AppError(404, 'User not found')
    if (user.totp_enabled) {
      throw new AppError(409, 'Two-factor authentication is already enabled. Disable it first to re-enroll.')
    }

    const { secret, otpauthUrl } = generateTotpSecret(user.email)
    const qrDataUri = await otpauthUrlToQrDataUri(otpauthUrl)
    const recoveryCodes = generateRecoveryCodes(10)
    const codeHashes = await Promise.all(recoveryCodes.map(hashRecoveryCode))

    // Atomic: stash secret + replace any prior unused recovery codes.
    // (Re-running enroll-start before confirming is harmless — the
    // old secret/codes get overwritten by the new ones, and nothing
    // could authenticate against the old set yet because
    // totp_enabled stayed false.)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE users SET totp_secret = $1 WHERE id = $2`,
        [secret, userId]
      )
      await client.query(
        `DELETE FROM user_totp_recovery_codes WHERE user_id = $1`,
        [userId]
      )
      for (const hash of codeHashes) {
        await client.query(
          `INSERT INTO user_totp_recovery_codes (user_id, code_hash)
           VALUES ($1, $2)`,
          [userId, hash]
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({
      success: true,
      data: {
        otpauthUrl,
        qrDataUri,
        // Recovery codes shown ONCE — the client is responsible for
        // displaying them and reminding the user to save. They are
        // not retrievable later.
        recoveryCodes,
      },
    })
  } catch (e) { next(e) }
})

const enrollConfirmSchema = z.object({
  token: z.string().min(6).max(10),  // 6 digits, allow trim spaces
})

// ── POST /api/auth/totp/enroll-confirm ──────────────────────────
totpRouter.post('/enroll-confirm', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId as string
    const { token } = enrollConfirmSchema.parse(req.body)
    const user = await queryOne<{
      totp_secret: string | null; totp_enabled: boolean
    }>(`SELECT totp_secret, totp_enabled FROM users WHERE id = $1`, [userId])
    if (!user) throw new AppError(404, 'User not found')
    if (user.totp_enabled) {
      throw new AppError(409, 'Two-factor authentication is already enabled.')
    }
    if (!user.totp_secret) {
      throw new AppError(400, 'Start enrollment first via /api/auth/totp/enroll-start.')
    }
    if (!verifyTotpToken(token, user.totp_secret)) {
      throw new AppError(400, 'Invalid code. Try again with the current code from your authenticator app.')
    }
    await db.query(
      `UPDATE users
          SET totp_enabled = TRUE,
              totp_enrolled_at = NOW()
        WHERE id = $1`,
      [userId]
    )
    res.json({ success: true, data: { message: 'Two-factor authentication enabled.' } })
  } catch (e) { next(e) }
})

const disableSchema = z.object({
  password: z.string().min(1),
})

// ── POST /api/auth/totp/disable ─────────────────────────────────
totpRouter.post('/disable', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId as string
    const { password } = disableSchema.parse(req.body)
    const user = await queryOne<{
      password_hash: string; totp_enabled: boolean
    }>(`SELECT password_hash, totp_enabled FROM users WHERE id = $1`, [userId])
    if (!user) throw new AppError(404, 'User not found')
    if (!user.totp_enabled) {
      throw new AppError(400, 'Two-factor authentication is not enabled.')
    }
    // Re-confirm with password — a stolen session shouldn't be able
    // to silently drop the second factor.
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) throw new AppError(401, 'Incorrect password.')

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE users
            SET totp_enabled     = FALSE,
                totp_secret      = NULL,
                totp_enrolled_at = NULL
          WHERE id = $1`,
        [userId]
      )
      await client.query(
        `DELETE FROM user_totp_recovery_codes WHERE user_id = $1`,
        [userId]
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    res.json({ success: true, data: { message: 'Two-factor authentication disabled.' } })
  } catch (e) { next(e) }
})

const verifySchema = z.object({
  totpSession: z.string().min(1),
  code:        z.string().min(6),
})

// ── POST /api/auth/totp/verify ──────────────────────────────────
// No requireAuth — this consumes a short-lived totp_session token
// minted by /login when the user has TOTP enabled.
totpRouter.post('/verify', async (req, res, next) => {
  try {
    const { totpSession, code } = verifySchema.parse(req.body)

    let session: any
    try {
      session = jwt.verify(totpSession, process.env.JWT_SECRET!)
    } catch {
      throw new AppError(401, 'TOTP session expired. Please log in again.')
    }
    if (!session || session.purpose !== 'totp_pending') {
      throw new AppError(401, 'Invalid TOTP session.')
    }
    const userId = session.userId as string
    const user = await queryOne<{
      totp_secret: string | null; totp_enabled: boolean; email: string
    }>(`SELECT totp_secret, totp_enabled, email FROM users WHERE id = $1`, [userId])
    if (!user || !user.totp_enabled || !user.totp_secret) {
      throw new AppError(401, 'Two-factor authentication is not active on this account.')
    }

    // Try TOTP first; fall through to recovery code only if it's
    // not a 6-digit token shape (recovery codes are 10 hex with a
    // hyphen — distinct shape).
    let accepted = false
    let recoveryCodeId: string | null = null
    const cleaned = code.replace(/\s/g, '')
    if (/^\d{6}$/.test(cleaned)) {
      accepted = verifyTotpToken(cleaned, user.totp_secret)
    } else {
      // Recovery code path. Compare against every unused row's hash —
      // bcrypt comparisons are not constant-time per row, but the
      // recovery_code_hashes index ensures we only check unused codes
      // for this user. 10 comparisons max.
      const unused = await query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash
           FROM user_totp_recovery_codes
          WHERE user_id = $1
            AND used_at IS NULL`,
        [userId],
      )
      for (const row of unused) {
        if (await verifyRecoveryCode(cleaned, row.code_hash)) {
          accepted = true
          recoveryCodeId = row.id
          break
        }
      }
    }

    if (!accepted) {
      throw new AppError(401, 'Invalid code.')
    }

    // Mark recovery code used on successful redemption. Single-use.
    if (recoveryCodeId) {
      await db.query(
        `UPDATE user_totp_recovery_codes
            SET used_at = NOW()
          WHERE id = $1`,
        [recoveryCodeId]
      )
    }

    // Mint the full session JWT — same claim shape /login would
    // issue had TOTP not been required.
    const token = signFullToken({
      userId:      session.userId,
      role:        session.role,
      email:       session.email,
      profileId:   session.profileId,
      landlordId:  session.landlordId ?? null,
      permissions: session.permissions ?? null,
    })

    res.json({
      success: true,
      data: {
        token,
        user: {
          id:          session.userId,
          email:       session.email,
          role:        session.role,
          profileId:   session.profileId,
          landlordId:  session.landlordId ?? null,
          permissions: session.permissions ?? null,
        },
      },
    })
  } catch (e) { next(e) }
})

