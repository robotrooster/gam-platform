/**
 * S574 — POS terminal lock screen (activate + unlock).
 *
 *   POST /api/pos-lock/activate   (full session: owner or staff) → terminal token
 *   POST /api/pos-lock/unlock     (terminal token + passcode)     → cashier session
 *
 * Flow: an owner/manager signs in fully (email + 2FA for the owner) on a
 * register and taps "Activate this terminal" → we mint a long-lived TERMINAL
 * TOKEN bound to their business and hand it to the device. From then on the
 * device shows a lock screen; a cashier enters their 4–6 digit passcode →
 * /unlock trades the terminal token + passcode for a capability-locked CASHIER
 * SESSION (posLimited) scoped to the POS register only.
 *
 * See lib/posLock.ts for the token/enforcement model.
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'
import {
  signTerminalToken,
  verifyTerminalToken,
  signCashierSession,
} from '../lib/posLock'

export const posLockRouter = Router()

// ── POST /activate ─────────────────────────────────────────────
// Mint a terminal token for the requester's business. Requires a FULL session
// (owner or active staff) + the 'pos' feature enabled. A posLimited cashier
// session can't reach here (blocked upstream by requireAuth's posLimited gate),
// so a cashier can't re-bind the terminal.
posLockRouter.post('/activate', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = await requireBusinessAccess(req, { feature: 'pos' })
    res.json({ success: true, data: { terminalToken: signTerminalToken({ businessId }) } })
  } catch (e) { next(e) }
})

// ── POST /unlock ───────────────────────────────────────────────
// Terminal-token-authenticated (NOT requireAuth — the terminal token carries a
// `purpose` and is rejected by requireAuth by design). Trades a passcode for a
// cashier session.
const unlockSchema = z.object({
  passcode: z.string().regex(/^\d{4,6}$/, 'Enter your 4 to 6 digit passcode'),
}).strict()

posLockRouter.post('/unlock', async (req, res, next) => {
  try {
    const header = req.headers.authorization
    const terminal = header?.startsWith('Bearer ') ? verifyTerminalToken(header.slice(7)) : null
    if (!terminal) throw new AppError(401, 'This register is not activated. Ask an owner or manager to activate it.')

    const { passcode } = unlockSchema.parse(req.body)

    // Candidate cashiers: active staff of this business with a passcode set.
    // Match by bcrypt.compare (hashes differ even for equal plaintext, so we
    // can't index this — fine for a small register team).
    const candidates = await query<{
      user_id: string; staff_role: string; permissions: unknown; pos_passcode_hash: string
    }>(
      `SELECT bu.user_id, bu.staff_role, bu.permissions, bu.pos_passcode_hash
         FROM business_users bu
         JOIN businesses b ON b.id = bu.business_id
        WHERE bu.business_id = $1 AND bu.status = 'active'
          AND b.status IN ('active','suspended')
          AND bu.pos_passcode_hash IS NOT NULL`,
      [terminal.businessId])

    let matched: (typeof candidates)[number] | null = null
    for (const c of candidates) {
      if (await bcrypt.compare(passcode, c.pos_passcode_hash)) { matched = c; break }
    }
    // Uniform error whether the passcode is wrong or nobody has one — never
    // reveal which. (Set-time uniqueness guarantees at most one match.)
    if (!matched) throw new AppError(401, 'Incorrect passcode.')

    const staffUser = await queryOne<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM users WHERE id = $1`, [matched.user_id])

    const token = signCashierSession({
      userId:      matched.user_id,
      businessId:  terminal.businessId,
      staffRole:   matched.staff_role,
      permissions: matched.permissions,
    })
    res.json({
      success: true,
      data: {
        token,
        cashier: {
          firstName: staffUser?.first_name ?? '',
          lastName:  staffUser?.last_name ?? '',
          staffRole: matched.staff_role,
        },
      },
    })
  } catch (e) { next(e) }
})
