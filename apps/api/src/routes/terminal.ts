import { Router } from 'express'
import Stripe from 'stripe'
import { requireAuth, requirePerm } from '../middleware/auth'
import { resolveLandlordIdForUser } from '../lib/scope'
import { AppError } from '../middleware/errorHandler'

// S94: Stripe Terminal card-present POS flow. Five steps end-to-end:
//
//   1. Frontend: POST /terminal/connection-token → reader connects
//   2. Frontend: POST /terminal/create-payment-intent {amount} → PI id +
//      clientSecret
//   3. Frontend Stripe Terminal SDK: collectPaymentMethod() on the reader
//   4. Frontend: POST /terminal/capture/:id → captures held funds, returns
//      { id, status, amount }
//   5. Frontend: POST /api/pos/transactions {paymentMethod:'card', items,
//      subtotal, total, stripePaymentIntentId: <id from step 4>} →
//      writes the GAM-side audit row + decrements stock + auto-drafts POs
//
// Steps 4+5 are separate calls but the second is idempotent on
// stripePaymentIntentId — a network hiccup between them retries safely.

export const terminalRouter = Router()
terminalRouter.use(requireAuth)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })

// POST /api/terminal/connection-token
terminalRouter.post('/connection-token', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const token = await stripe.terminal.connectionTokens.create()
    res.json({ success: true, data: { secret: token.secret } })
  } catch (e) { next(e) }
})

// POST /api/terminal/create-payment-intent
terminalRouter.post('/create-payment-intent', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const { amount, currency = 'usd', description, metadata } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' })
    // S403 fixes:
    //   1. landlord_id metadata was set BEFORE `...metadata`, so a
    //      client could pass `metadata: { landlord_id: 'other-landlord' }`
    //      and override the server-set value. Audit attribution was
    //      client-controlled. Swap order so server fields win.
    //   2. profileId is the landlord_id for role=landlord but the
    //      user_id for team roles (PM/onsite_manager/maintenance).
    //      Pre-fix a PM ringing a sale wrote their user_id into the
    //      Stripe metadata as "landlord_id" — garbled audit trail.
    //      Resolve to the actual landlord_id via the shared helper.
    const landlordId = resolveLandlordIdForUser(req.user!)
    if (!landlordId) throw new AppError(400, 'No landlord scope on this user')
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: description || 'GAM POS Sale',
      metadata: { ...metadata, landlord_id: landlordId }
    })
    res.json({ success: true, data: { clientSecret: intent.client_secret, id: intent.id } })
  } catch (e) { next(e) }
})

// S419 (S403 finding): both capture and cancel routes previously
// accepted any PaymentIntent ID and forwarded it to Stripe with no
// ownership check. A landlord with pos.ring_sale who learned another
// landlord's PI id (shared system logs, support ticket leak, etc.)
// could capture or cancel that landlord's transaction.
//
// Fix: read the PI from Stripe first, compare metadata.landlord_id
// (stamped by /create-payment-intent in the S403 fix) against the
// caller's resolved landlord. 403 on mismatch; 404 if metadata is
// missing (defensive — should only happen for non-GAM PIs that
// somehow got their ID into the URL).
//
// Cost: one extra Stripe round-trip per capture/cancel. Acceptable
// given the security posture for POS card-present flows.
async function assertPiBelongsToCaller(piId: string, callerLandlordId: string) {
  const intent = await stripe.paymentIntents.retrieve(piId)
  const piLandlordId = (intent.metadata as any)?.landlord_id
  if (!piLandlordId) {
    throw new AppError(404, 'PaymentIntent has no landlord_id metadata; cannot verify ownership')
  }
  if (piLandlordId !== callerLandlordId) {
    throw new AppError(403, 'PaymentIntent does not belong to this landlord')
  }
  return intent
}

// POST /api/terminal/capture-payment-intent
// S94: returns id + amount alongside status so the frontend can pass
// the PI id straight into POST /api/pos/transactions for record-back.
terminalRouter.post('/capture/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const callerLandlordId = resolveLandlordIdForUser(req.user!)
    if (!callerLandlordId) throw new AppError(400, 'No landlord scope on this user')
    await assertPiBelongsToCaller(req.params.id, callerLandlordId)
    const intent = await stripe.paymentIntents.capture(req.params.id)
    res.json({ success: true, data: { id: intent.id, status: intent.status, amount: intent.amount } })
  } catch (e) { next(e) }
})

// POST /api/terminal/cancel-payment-intent
terminalRouter.post('/cancel/:id', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const callerLandlordId = resolveLandlordIdForUser(req.user!)
    if (!callerLandlordId) throw new AppError(400, 'No landlord scope on this user')
    await assertPiBelongsToCaller(req.params.id, callerLandlordId)
    await stripe.paymentIntents.cancel(req.params.id)
    res.json({ success: true })
  } catch (e) { next(e) }
})
