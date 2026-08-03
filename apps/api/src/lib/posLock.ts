/**
 * S574 — POS terminal lock screen: token types + capability enforcement.
 *
 * Two dedicated tokens back the cashier flow (kept in this dep-free lib so the
 * auth middleware can import the enforcement predicate without a route cycle):
 *
 *   1. TERMINAL TOKEN (purpose='pos_terminal') — binds a physical register to a
 *      business. Minted when an owner/manager (full session) taps "Activate this
 *      terminal". Long-lived. Because it carries a `purpose`, requireAuth rejects
 *      it everywhere; ONLY the /pos-lock/unlock endpoint accepts it (it verifies
 *      the purpose explicitly). So a stolen terminal token can do exactly one
 *      thing: present a passcode. It cannot read data or ring sales on its own.
 *
 *   2. CASHIER SESSION (no purpose, posLimited=true) — minted by /pos-lock/unlock
 *      when a valid passcode is presented. It IS a real session (passes
 *      requireAuth), but `posLimited` locks it to the POS register surface only
 *      (see isPosLimitedRequestAllowed). A cashier can ring, take payment, and
 *      refund (refund still gated by the pos.refund permission) — and nothing
 *      else. Reports, settings, staff, banking: all 403.
 *
 * The split is the whole security model: owners authenticate with a real second
 * factor for sensitive access; cashiers get a fast, deliberately-narrow session.
 */

import jwt from 'jsonwebtoken'

export const TERMINAL_TOKEN_PURPOSE = 'pos_terminal'
// Terminals stay bound for a good while — a register shouldn't need re-activation
// every day. Re-activation (owner full login) rotates it.
const TERMINAL_TTL = '90d'
// A cashier session lives one long shift; "Lock" clears it sooner.
const CASHIER_TTL = '12h'

export interface TerminalTokenClaims {
  businessId: string
}

export function signTerminalToken(claims: TerminalTokenClaims): string {
  return jwt.sign(
    { ...claims, purpose: TERMINAL_TOKEN_PURPOSE },
    process.env.JWT_SECRET!,
    { expiresIn: TERMINAL_TTL },
  )
}

/** Verify a terminal token, returning its businessId, or null if invalid/wrong purpose. */
export function verifyTerminalToken(token: string): TerminalTokenClaims | null {
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET!) as any
    if (p?.purpose !== TERMINAL_TOKEN_PURPOSE || !p?.businessId) return null
    return { businessId: p.businessId as string }
  } catch {
    return null
  }
}

export interface CashierSessionClaims {
  userId: string
  businessId: string
  staffRole: string | null
  permissions: unknown
}

export function signCashierSession(claims: CashierSessionClaims): string {
  // NOTE: intentionally NO `purpose` — this must pass requireAuth as a real
  // session. The `posLimited` flag is what constrains it.
  return jwt.sign(
    {
      userId:      claims.userId,
      role:        'business_staff',
      businessId:  claims.businessId,
      profileId:   claims.businessId,
      staffRole:   claims.staffRole,
      permissions: claims.permissions,
      posLimited:  true,
    },
    process.env.JWT_SECRET!,
    { expiresIn: CASHIER_TTL },
  )
}

/**
 * Capability gate for a posLimited (cashier) session. Returns true only for the
 * narrow set of endpoints a register cashier legitimately needs:
 *
 *   - the whole POS register surface (ring / pay / refund / receipt / config)
 *   - reading products + customers to build a sale
 *   - previewing a discount code
 *   - reading their own /auth/me (so the frontend session bootstrap works)
 *
 * Everything else — reports, dashboard, staff, settings, banking, inventory or
 * customer WRITES — is denied. Deny-by-default: anything not matched here 403s.
 *
 * `path` is req.originalUrl without its query string; `method` is upper-case.
 */
export function isPosLimitedRequestAllowed(method: string, path: string): boolean {
  const p = path.split('?')[0]
  const m = method.toUpperCase()

  // The full POS register surface (transactions, terminal card charges,
  // register-config, refunds, receipts, cash report). Refund + use are further
  // gated inside the handlers via requireBusinessAccess(pos.refund / pos.use).
  if (p.startsWith('/api/business-pos/')) return true

  // Self-read so the frontend's /auth/me bootstrap + retry works.
  if (m === 'GET' && p === '/api/auth/me') return true

  // Read products + customers to build a sale (READ only — no writes).
  if (m === 'GET' && p.startsWith('/api/business-inventory/items')) return true
  if (m === 'GET' && p.startsWith('/api/business-customers')) return true

  // Preview a discount code at the register.
  if (m === 'POST' && p === '/api/business-discounts/preview') return true

  return false
}
