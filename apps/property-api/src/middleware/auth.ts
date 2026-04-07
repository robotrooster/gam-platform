import { Request, Response, NextFunction } from 'express'
import dotenv from 'dotenv'
dotenv.config()

const ALLOWED_ROLES = ['admin', 'super_admin', 'landlord', 'bookkeeper']

function decodeJwt(token: string): any {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(payload)
  } catch { return null }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })
  const payload = decodeJwt(header.slice(7))
  if (!payload) return res.status(401).json({ error: 'Invalid token' })
  if (!ALLOWED_ROLES.includes(payload.role)) return res.status(403).json({ error: 'Insufficient permissions' })
  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'Token expired' })
  ;(req as any).user = payload
  next()
}
