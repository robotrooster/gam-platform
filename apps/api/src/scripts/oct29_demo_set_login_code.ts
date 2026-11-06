/** 10/29 — DEMO ONLY: set a known 2FA code for the demo resident. Refuses outside gam_demo. */
import bcrypt from 'bcryptjs'
import { db } from '../db'
;(async () => {
  const n = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (n.rows[0].d !== 'gam_demo') throw new Error(`Refusing: database is ${n.rows[0].d}`)
  const hash = await bcrypt.hash('135792', 10)
  const r = await db.query(
    `UPDATE login_email_otps SET code_hash = $1, attempts = 0
      WHERE consumed_at IS NULL AND expires_at > NOW()
        AND user_id = (SELECT id FROM users WHERE email = 'eva@tenant.dev')`, [hash])
  console.log('otp rows set:', r.rowCount)
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })
