/**
 * 10/4 (decisions #37.B, #38) — CHECK A GUEST OUT, AND SETTLE THE MONEY.
 *
 *   GET  /api/units/:unitId/bookings/:bookingId/check-out?leftOn=YYYY-MM-DD
 *        What checking this guest out on that day means for the money: what
 *        was booked, what was stayed, what was paid (and how), and the one
 *        question to answer. The refund choices are left out here for anyone
 *        without "Issue refunds" (#38 Q5).
 *   GET  …/check-out/refund-preview?amount=N
 *        "Refund a different amount": where that amount goes back.
 *   POST …/check-out   { leftOn, choice, refundAmount?, quoteToken, idempotencyKey }
 *        Checks the guest out (when they are not out yet) and records the
 *        money decision in one transaction, then sends any card refunds.
 *   POST …/check-out/parts/:partId/retry
 *        Try again on a card refund that failed — from the done screen, or
 *        later from the stay (the schedule's Try again, the owner's to-do).
 *   POST …/check-out/parts/:partId/cash-instead
 *        "Give it back in cash instead" on a card refund that failed: the
 *        money is handed back at the desk and recorded, so it is never sent
 *        to the card as well (fix round 2).
 *
 * "Check guests out" (guests.check_out) gets in; refunds also need "Issue
 * refunds" (pos.refund), checked inside (services/earlyCheckOut). Property-
 * locked staff only reach stays at their properties.
 */
import { Router } from 'express'
import { requireAuth, requirePerm, userHasPerm, assertPropertyInScope } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { queryOne } from '../db'
import { logger } from '../lib/logger'
import { syncStayUtilityAgreement } from '../services/stayTerms'
import {
  quoteEarlyCheckOut, decideEarlyCheckOut, retryRefundPart, givePartBackInCash, previewRefund, resumeStaleParts, healLeaseEnd,
  CheckoutChanged, poolQ,
} from '../services/earlyCheckOut'

export const stayCheckOutRouter = Router()
stayCheckOutRouter.use(requireAuth)

const GONE = 'That reservation is not on the schedule any more — close this window and look it up again.'

/** The stay, reachable by this caller, on the unit the path names. */
async function stayFor(req: any): Promise<{ id: string; landlord_id: string; unit_id: string; property_id: string }> {
  const ok = (x: unknown) => /^[0-9a-f-]{36}$/i.test(String(x ?? ''))
  if (!ok(req.params.bookingId) || !ok(req.params.unitId)) throw new AppError(404, GONE)
  const b = await queryOne<{ id: string; landlord_id: string; unit_id: string; property_id: string }>(
    `SELECT b.id, b.landlord_id, b.unit_id, u.property_id
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [req.params.bookingId])
  if (!b || b.unit_id !== req.params.unitId) throw new AppError(404, GONE)
  if (!canManageLandlordResource(req.user, b.landlord_id)) throw new AppError(403, 'Forbidden')
  await assertPropertyInScope(req.user, b.property_id)
  return b
}

const day = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

const CHECK_OUT_PERMS = ['guests.check_out', 'pos.refund'] as const

stayCheckOutRouter.get('/:unitId/bookings/:bookingId/check-out', requirePerm(...CHECK_OUT_PERMS), async (req, res, next) => {
  try {
    const b = await stayFor(req)
    // Self-heal: a card refund left waiting by a crash goes out now, and a
    // long stay whose lease did not end on the day they left is ended now.
    await resumeStaleParts(b.id)
    await healLeaseEnd(b.id, req.user!.userId)
    // 10/5 (Nic, R11 — M8): and a checked-out stay's utility agreement that
    // still runs (a check-out saved before it could be ended) ends on the day
    // they left. No change for a stay still here.
    const out = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM unit_bookings WHERE id = $1 AND status = 'checked_out'`, [b.id])
    if (out) {
      await syncStayUtilityAgreement(b.id).catch((err) =>
        logger.error({ err, bookingId: b.id }, '[check-out] could not bring the stay\'s utility agreement in step'))
    }
    const quote = await quoteEarlyCheckOut(poolQ, b.id, {
      leftOn: day(req.query.leftOn), canRefund: userHasPerm(req.user, 'pos.refund'), canCheckOut: userHasPerm(req.user, 'guests.check_out') })
    res.json({ success: true, data: quote })
  } catch (e) { next(e) }
})

stayCheckOutRouter.get('/:unitId/bookings/:bookingId/check-out/refund-preview', requirePerm('pos.refund'), async (req, res, next) => {
  try {
    const b = await stayFor(req)
    const amount = Number(req.query.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Type how much to refund (more than $0.00).')
    const out = await previewRefund(poolQ, b.id, amount)
    res.json({ success: true, data: out.parts })
  } catch (e) { next(e) }
})

stayCheckOutRouter.post('/:unitId/bookings/:bookingId/check-out', requirePerm(...CHECK_OUT_PERMS), async (req, res, next) => {
  try {
    const b = await stayFor(req)
    const body = req.body ?? {}
    const result = await decideEarlyCheckOut({
      bookingId: b.id,
      actor: {
        userId: req.user!.userId,
        canCheckOut: userHasPerm(req.user, 'guests.check_out'),
        canRefund: userHasPerm(req.user, 'pos.refund'),
      },
      leftOn: day(body.leftOn),
      choice: body.choice ?? null,
      refundAmount: body.refundAmount == null ? null : Number(body.refundAmount),
      quoteToken: String(body.quoteToken ?? ''),
      idempotencyKey: String(body.idempotencyKey ?? ''),
    })
    res.json({ success: true, data: result })
  } catch (e: any) {
    // Fresh at the moment of action: what changed is handed back, so the
    // window shows the latest without another call.
    if (e instanceof CheckoutChanged) {
      return res.status(409).json({ success: false, code: 'checkout_changed', error: e.message, data: e.quote })
    }
    if (e?.code === 'already_decided') {
      return res.status(409).json({ success: false, code: 'already_decided', error: e.message })
    }
    next(e)
  }
})

stayCheckOutRouter.post('/:unitId/bookings/:bookingId/check-out/parts/:partId/retry', requirePerm('pos.refund'), async (req, res, next) => {
  try {
    const b = await stayFor(req)
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.partId))) throw new AppError(404, 'That refund is not on this stay.')
    const result = await retryRefundPart(req.params.partId, b.id)
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

stayCheckOutRouter.post('/:unitId/bookings/:bookingId/check-out/parts/:partId/cash-instead', requirePerm('pos.refund'), async (req, res, next) => {
  try {
    const b = await stayFor(req)
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.partId))) throw new AppError(404, 'That refund is not on this stay.')
    const result = await givePartBackInCash(req.params.partId, b.id, req.user!.userId)
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})
