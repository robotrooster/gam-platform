/**
 * 10/4 (decisions #46.1) — THE LANDLORD'S CHOICE FOR PAID-AHEAD MONEY LEFT ON
 * AN ENDED LEASE (services/paidAheadChoice).
 *
 *   GET  /api/leases/:leaseId/paid-ahead-choice
 *        The tenant, the space, the paid-ahead money left and how it was paid,
 *        and the choices (or why it waits, and where to finish that first).
 *        Card or bank refunds of this lease left "sending" for 10+ minutes are
 *        sent again first (resumeStalePaidAheadParts).
 *   GET  …/paid-ahead-choice/refund-preview?amount=N
 *        "Refund a different amount": where it goes back, the landlord's exact
 *        cost, and the choices for the rest.
 *   POST …/paid-ahead-choice   { refundChoice, refundAmount?, restChoice?, quoteToken, idempotencyKey }
 *        Decided once. Anything that changed since the page loaded is a 409
 *        with the fresh view (code 'paid_ahead_changed', or 'already_decided'
 *        when someone else decided it a moment ago).
 *   POST …/paid-ahead-choice/parts/:partId/retry
 *        Try again on a card or bank refund that did not go out. One that can
 *        never be sent (its register sale was already refunded at the
 *        register, its payment was disputed or returned by the bank, or a
 *        dispute already took that money back) is refused with a 409 in plain
 *        words saying what to do instead; the page never offers it.
 *   POST …/paid-ahead-choice/parts/:partId/cash
 *        "Give it back in cash instead" for a card or bank refund that did not
 *        go out (failed, or sent back by Stripe) — the way out when the card is
 *        closed (earlyCheckOut.givePartBackInCash). On money GAM holds, what
 *        GAM held is released to the landlord once: their cost is the card fee.
 *        The press comes before the hand-back (choice46c): Stripe is asked
 *        first, and only the reply says "Hand back $X in cash now." (handBack).
 *        A refund that reached the card but was not recorded is refused (409):
 *        Try again records it. Pressed again after an earlier press was
 *        recorded (its answer lost, or a colleague's): the reply says when
 *        and by whom — by you: hand it back if you have not (handBack); by
 *        someone else: ask them first. Another request working on the same
 *        refund: 409 coded 'refund_busy' ("…then press Check again"). A press
 *        that could not finish checking the refund first: 503, nothing handed
 *        back.
 *
 * A press that fails in a way the server cannot vouch for (not a refusal it
 * worded) answers 500 coded 'outcome_unknown' — "could not tell", never
 * "nothing was saved" — and the page reads what became of it from the next look.
 *
 * Card and bank refunds go back to the card or bank on every ended lease, a
 * stay behind it or not. "Leave it as their credit" spends nothing: it stays
 * the tenant's money paid ahead and follows them to their next lease here.
 *
 * Every call needs "Issue refunds" (pos.refund). Property-locked staff reach
 * only leases at their properties.
 */
import { Router } from 'express'
import { requireAuth, userHasPerm, assertPropertyInScope } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { queryOne } from '../db'
import {
  paidAheadView, previewPaidAheadRefund, decidePaidAhead, retryPaidAheadPart, resumeStalePaidAheadParts, PaidAheadChanged,
  givePaidAheadPartBackInCash, RefundBusy,
  PAID_AHEAD_PERM_WORDS,
} from '../services/paidAheadChoice'
import { logger } from '../lib/logger'
import { poolQ } from '../services/earlyCheckOut'

export const paidAheadChoiceRouter = Router()

const GONE = 'That lease is not on this account any more — go back to Leases and open it again.'
/** A part id that is not one (the page refetches in place on any error). */
const PART_GONE = 'That refund is not on this lease any more, so nothing was changed. The page now shows the latest.'

/**
 * Choice46d (review): a press whose outcome the server itself cannot vouch for
 * (an unexpected failure — it may have come after the work was saved, say
 * while the reply was being put together) is said as that, coded
 * 'outcome_unknown', never as "nothing was saved": the page reads what became
 * of it from the next look. A cash press that met another request working on
 * the same refund is coded 'refund_busy' (the same reading). Every refusal the
 * service words itself (AppError) goes out as it is.
 */
const OUTCOME_UNKNOWN = 'GAM could not tell if that went through. The page now shows the latest — look at that line again before giving anything.'
function pressError(e: any, req: any, res: any, next: any) {
  if (e instanceof RefundBusy) return res.status(409).json({ success: false, code: e.code, error: e.message })
  if (e instanceof AppError) return next(e)
  logger.error({ err: e, path: req.originalUrl }, '[paid-ahead-choice] a press failed unexpectedly')
  return res.status(500).json({ success: false, code: 'outcome_unknown', error: OUTCOME_UNKNOWN })
}

/** The lease, reachable by this caller with "Issue refunds". */
async function leaseFor(req: any): Promise<{ id: string; landlord_id: string; property_id: string }> {
  if (!userHasPerm(req.user, 'pos.refund')) throw new AppError(403, PAID_AHEAD_PERM_WORDS)
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.leaseId ?? ''))) throw new AppError(404, GONE)
  const l = await queryOne<{ id: string; landlord_id: string; property_id: string }>(
    `SELECT l.id, l.landlord_id, u.property_id FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [req.params.leaseId])
  if (!l) throw new AppError(404, GONE)
  if (!canManageLandlordResource(req.user, l.landlord_id)) throw new AppError(403, 'That lease belongs to another account.')
  await assertPropertyInScope(req.user, l.property_id)
  return l
}

paidAheadChoiceRouter.get('/:leaseId/paid-ahead-choice', requireAuth, async (req, res, next) => {
  try {
    const l = await leaseFor(req)
    // A card or bank refund left "sending" after a crash is sent again on open
    // (never leaves the owner's to-do pointing at a screen where nothing happens).
    await resumeStalePaidAheadParts(l.id).catch((err) => logger.error({ err, leaseId: l.id }, '[paid-ahead-choice] could not resume refunds'))
    res.json({ success: true, data: await paidAheadView(poolQ, l.id, { viewerId: req.user!.userId }) })
  } catch (e) { next(e) }
})

paidAheadChoiceRouter.get('/:leaseId/paid-ahead-choice/refund-preview', requireAuth, async (req, res, next) => {
  try {
    const l = await leaseFor(req)
    const amount = Number(req.query.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'Type how much to refund (more than $0.00).')
    res.json({ success: true, data: await previewPaidAheadRefund(poolQ, l.id, amount) })
  } catch (e) { next(e) }
})

paidAheadChoiceRouter.post('/:leaseId/paid-ahead-choice', requireAuth, async (req, res, next) => {
  try {
    const l = await leaseFor(req)
    const body = req.body ?? {}
    const result = await decidePaidAhead({
      leaseId: l.id,
      actor: { userId: req.user!.userId, canRefund: userHasPerm(req.user, 'pos.refund') },
      refundChoice: body.refundChoice,
      refundAmount: body.refundAmount == null || body.refundAmount === '' ? null : Number(body.refundAmount),
      restChoice: body.restChoice ?? null,
      quoteToken: String(body.quoteToken ?? ''),
      idempotencyKey: String(body.idempotencyKey ?? ''),
    })
    res.json({ success: true, data: result })
  } catch (e: any) {
    // Fresh at the moment of action: what changed is handed back, so the page
    // shows the latest without another call.
    if (e instanceof PaidAheadChanged) {
      return res.status(409).json({ success: false, code: e.kind, error: e.message, data: e.view })
    }
    pressError(e, req, res, next)
  }
})

paidAheadChoiceRouter.post('/:leaseId/paid-ahead-choice/parts/:partId/retry', requireAuth, async (req, res, next) => {
  try {
    const l = await leaseFor(req)
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.partId))) throw new AppError(404, PART_GONE)
    res.json({ success: true, data: await retryPaidAheadPart(l.id, req.params.partId, { canRefund: true, userId: req.user!.userId }) })
  } catch (e) { pressError(e, req, res, next) }
})

paidAheadChoiceRouter.post('/:leaseId/paid-ahead-choice/parts/:partId/cash', requireAuth, async (req, res, next) => {
  try {
    const l = await leaseFor(req)
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.partId))) throw new AppError(404, PART_GONE)
    res.json({ success: true, data: await givePaidAheadPartBackInCash(l.id, req.params.partId, { userId: req.user!.userId, canRefund: true }) })
  } catch (e) { pressError(e, req, res, next) }
})
