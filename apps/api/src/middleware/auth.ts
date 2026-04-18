import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { UserRole } from '@gam/shared'

export interface AuthPayload {
  userId:      string
  role:        UserRole
  email:       string
  profileId:   string
  landlordId?: string | null
  permissions?: Record<string, boolean> | null
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' })
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' })
    }
    next()
  }
}

export const requireAdmin    = requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export const requireLandlord = requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.LANDLORD)
export const requireTenant   = requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.TENANT)
