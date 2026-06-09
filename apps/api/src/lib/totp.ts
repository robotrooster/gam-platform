/**
 * TOTP helpers (S288).
 *
 * Wraps otplib's RFC-6238 authenticator + qrcode for server-side QR
 * generation. Why a helper module: keeps the otplib import boundary
 * narrow and gives tests a single mock point. The authenticator
 * defaults (SHA-1, 6 digits, 30s window) match every mainstream
 * authenticator app — don't change them without breaking enrollment
 * for existing users.
 */

import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

const ISSUER = 'GAM'

/**
 * Generate a new TOTP secret + the otpauth URL the authenticator
 * scans. The URL is `otpauth://totp/<issuer>:<label>?secret=...&issuer=...`;
 * we return both so the route can store secret in DB and embed the
 * URL in the QR code.
 *
 * Label is the user's email (RFC 6238 §6 recommends an identifier
 * that distinguishes accounts in the authenticator UI — the email
 * is what users will recognize).
 */
export function generateTotpSecret(userEmail: string): {
  secret:     string
  otpauthUrl: string
} {
  const secret     = authenticator.generateSecret()
  const otpauthUrl = authenticator.keyuri(userEmail, ISSUER, secret)
  return { secret, otpauthUrl }
}

/**
 * Render an otpauth URL as a QR code data URI (PNG, base64-encoded).
 * Frontend mounts `<img src={qrDataUri} />` directly — no extra
 * client-side QR library required.
 */
export async function otpauthUrlToQrDataUri(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', width: 240 })
}

/**
 * Verify a 6-digit TOTP token against a stored secret. Returns true
 * if the token is within the current 30-second window (or the
 * adjacent windows, per otplib's default of `window: 1`). Adjacent-
 * window tolerance handles clock skew between server + authenticator.
 */
export function verifyTotpToken(token: string, secret: string): boolean {
  // Strip spaces — some authenticators display tokens as `123 456`.
  const cleaned = token.replace(/\s/g, '')
  if (!/^\d{6}$/.test(cleaned)) return false
  try {
    return authenticator.check(cleaned, secret)
  } catch {
    return false
  }
}

/**
 * Generate `count` recovery codes. Each is a 10-character hex string
 * with a hyphen mid-way for readability (`abc12-de345`). Plaintext
 * is returned once to the user during enrollment; the caller hashes
 * each via `hashRecoveryCode` before storing.
 *
 * 10 codes by default — matches what GitHub / Google / 1Password
 * surface on their 2FA enrollment screens. Enough to survive
 * authenticator loss without making users feel obligated to print.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex')  // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

/**
 * Bcrypt the recovery code for at-rest storage. Same cost factor as
 * password_hash so brute-forcing a stolen recovery_codes_table dump
 * has identical economics.
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcrypt.hash(code, 12)
}

/**
 * Compare a presented recovery code against a stored hash. Used at
 * /totp/verify when the user submits a recovery code instead of a
 * TOTP token.
 */
export async function verifyRecoveryCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash)
}

/**
 * Roles for which TOTP is mandatory at launch. The /login response
 * sets `must_enroll_totp: true` when the user's role is in this set
 * and they haven't enrolled yet. Frontend uses the flag to gate
 * access until enrollment completes.
 *
 * `landlord` and `pm_company` were originally proposed for this list
 * but Nic called for optional-with-prompts at launch to avoid blocking
 * real users; flip them to mandatory after several weeks of adoption.
 * Tenants stay optional indefinitely (they only see their own bank
 * info and don't initiate transfers).
 *
 * Note: there's no `admin_ops` user role — the apps/admin-ops portal
 * authenticates `admin` + `super_admin` users with a separate token
 * (`gam_admin_ops_token`) but the underlying `users.role` is still
 * `admin` or `super_admin`. So the two-role set below covers both
 * the admin console and the admin-ops portal.
 */
export const MANDATORY_TOTP_ROLES = new Set<string>([
  'admin',
  'super_admin',
])
