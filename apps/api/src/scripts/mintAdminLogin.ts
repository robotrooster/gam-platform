/** Dev helper: mint a 7-day session token for a REGULAR admin (role='admin')
 * so the portfolio-manager (scoped) admin view can be inspected without the
 * login form / email 2FA. Signs with the app's own JWT_SECRET. */
import jwt from 'jsonwebtoken'
import { queryOne } from '../db'

const EMAIL = process.env.ADMIN_EMAIL || 'admin@gam.dev'
;(async () => {
  const user = await queryOne<{ id: string; role: string }>('SELECT id, role FROM users WHERE email=$1', [EMAIL])
  if (!user) { console.error('NO_USER'); process.exit(1) }
  const claims = {
    userId: user.id, role: user.role, email: EMAIL,
    profileId: null, landlordId: null, landlordIds: null,
    businessId: null, staffRole: null, permissions: null,
  }
  console.log('ROLE:' + user.role)
  console.log('TOKEN:' + jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '7d' }))
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
