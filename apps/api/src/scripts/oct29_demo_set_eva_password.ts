/**
 * 10/29 — DEMO ONLY: give the demo resident a known password so the
 * FlexDeposit prompt can be looked at in a browser. Refuses to run anywhere
 * but gam_demo.
 */
import bcrypt from 'bcryptjs'
import { db } from '../db'

;(async () => {
  const n = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (n.rows[0].d !== 'gam_demo') throw new Error(`Refusing: database is ${n.rows[0].d}, not gam_demo`)
  const hash = await bcrypt.hash('tenant1234', 10)
  const r = await db.query(
    `UPDATE users SET password_hash = $1 WHERE email = 'eva@tenant.dev'`, [hash])
  console.log('rows updated:', r.rowCount)
  await db.end()
})().catch(e => { console.error(e); process.exit(1) })
