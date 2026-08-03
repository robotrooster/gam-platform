/**
 * Dev helper: ensure Nic's real OWNER super_admin account exists, and mint a
 * 7-day session token for it so the admin console can be entered without the
 * login form. The token is a normal full session JWT (no `purpose` scope), so
 * requireAuth accepts it and requireSuperAdmin passes — same shape /login would
 * issue. Signs with the app's own JWT_SECRET (loaded by importing ../db, which
 * calls dotenv on the apps/api/.env file); the secret is never printed.
 *
 * Env overrides: OWNER_EMAIL, OWNER_PASSWORD.
 */
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query, queryOne } from '../db'

const EMAIL = process.env.OWNER_EMAIL || 'nic@golddoor.io'
const PASSWORD = process.env.OWNER_PASSWORD || 'GoldOwner2026!'

;(async () => {
  const hash = await bcrypt.hash(PASSWORD, 12)
  let user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email=$1', [EMAIL])
  if (!user) {
    user = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, totp_enabled)
       VALUES ($1,$2,'super_admin','Nic','Rhoades',TRUE,FALSE) RETURNING id`,
      [EMAIL, hash]
    )
    console.log('CREATED super_admin')
  } else {
    await query(
      `UPDATE users SET role='super_admin', password_hash=$2, email_verified=TRUE WHERE email=$1`,
      [EMAIL, hash]
    )
    console.log('PROMOTED/UPDATED existing user to super_admin')
  }
  const claims = {
    userId: user!.id, role: 'super_admin', email: EMAIL,
    profileId: null, landlordId: null, landlordIds: null,
    businessId: null, staffRole: null, permissions: null,
  }
  const token = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '7d' })
  console.log('EMAIL:' + EMAIL)
  console.log('USERID:' + user!.id)
  console.log('TOKEN:' + token)
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
