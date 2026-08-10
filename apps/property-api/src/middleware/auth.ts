import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config()

const ALLOWED_ROLES = ['admin', 'super_admin', 'landlord', 'bookkeeper']

// S595 sweep — CRITICAL FIX: the previous implementation hand-rolled a
// base64 decode of the JWT payload and NEVER verified the signature, so any
// caller could forge `{role:'admin',exp:<future>}` and get full access to the
// entire parcel database (owner PII + a POST bulk-update write path). Now we
// verify the HMAC signature with the shared JWT_SECRET (same secret the main
// API signs with), which also enforces expiry, and reject purpose-scoped
// tokens (e.g. the totp_pending 2FA-gate token) exactly like the main API's
// requireAuth. Fail CLOSED if the secret isn't configured.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })

  const secret = process.env.JWT_SECRET
  if (!secret) {
    console.error('[property-api] JWT_SECRET is not set — refusing all authenticated requests')
    return res.status(500).json({ error: 'Server auth is misconfigured' })
  }

  let payload: any
  try {
    payload = jwt.verify(header.slice(7), secret) // verifies signature + expiry
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  // A purpose-scoped token (e.g. the 2FA-pending session) carries the real
  // role but must never be accepted as a full session.
  if (payload.purpose) return res.status(401).json({ error: 'Invalid token' })
  if (!ALLOWED_ROLES.includes(payload.role)) return res.status(403).json({ error: 'Insufficient permissions' })

  ;(req as any).user = payload
  next()
}
