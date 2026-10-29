// READ-ONLY: sign a session token for Nic's own landlord user so the desk
// endpoint can be read exactly as the browser reads it. Writes nothing.
import jwt from 'jsonwebtoken'
import '/Users/nicholasrhoades/gam/apps/api/src/db'
const claims = {
  userId: '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3', role: 'landlord',
  email: 'realestaterhoades@gmail.com',
  profileId: null, landlordId: '96ec7df3-362d-4777-b54c-e9604313820f', landlordIds: null,
  businessId: null, staffRole: null, permissions: null,
}
console.log(jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '30m' }))
process.exit(0)
