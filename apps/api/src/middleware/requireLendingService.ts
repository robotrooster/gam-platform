import type { Request, Response, NextFunction } from 'express'
import { AppError } from './errorHandler'

// ============================================================
// Lending-service gate.
//
// The credit score itself is internal-only per the locked design rule:
// only GAM lending services (FlexPay/Charge/Credit/Deposit underwriting)
// see raw composite scores. External landlords screening prospective
// tenants get the stats panel and event list only — never the number.
//
// In v1 there is no separate lending microservice; the gate accepts:
//   - super_admin / admin (operator override for inspection)
//   - a request bearing X-Gam-Lending-Token equal to env
//     CREDIT_LENDING_SERVICE_TOKEN (set by GAM internal services that
//     need score reads — populated when the lending modules call
//     each other inside the API process or call out via internal RPC)
//
// The token check stays simple: a constant-time-comparable shared secret
// scoped to internal services. v2+ replaces it with a signed-JWT scheme
// when lending services move to their own process.
// ============================================================

export function requireLendingService(req: Request, res: Response, next: NextFunction) {
  const role = req.user?.role
  if (role === 'admin' || role === 'super_admin') return next()

  const headerToken = req.header('x-gam-lending-token')
  const expected = process.env.CREDIT_LENDING_SERVICE_TOKEN
  if (expected && headerToken && constantTimeEquals(headerToken, expected)) {
    return next()
  }

  return next(new AppError(403, 'Score endpoint restricted to GAM lending services'))
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
