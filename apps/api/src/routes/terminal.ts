import { Router } from 'express'
import Stripe from 'stripe'
import { requireAuth, requireLandlord } from '../middleware/auth'

export const terminalRouter = Router()
terminalRouter.use(requireAuth)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })

// POST /api/terminal/connection-token
terminalRouter.post('/connection-token', requireLandlord, async (req, res, next) => {
  try {
    const token = await stripe.terminal.connectionTokens.create()
    res.json({ success: true, data: { secret: token.secret } })
  } catch (e) { next(e) }
})

// POST /api/terminal/create-payment-intent
terminalRouter.post('/create-payment-intent', requireLandlord, async (req, res, next) => {
  try {
    const { amount, currency = 'usd', description, metadata } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' })
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: description || 'GAM POS Sale',
      metadata: { landlord_id: req.user!.profileId, ...metadata }
    })
    res.json({ success: true, data: { clientSecret: intent.client_secret, id: intent.id } })
  } catch (e) { next(e) }
})

// POST /api/terminal/capture-payment-intent
terminalRouter.post('/capture/:id', requireLandlord, async (req, res, next) => {
  try {
    const intent = await stripe.paymentIntents.capture(req.params.id)
    res.json({ success: true, data: { status: intent.status } })
  } catch (e) { next(e) }
})

// POST /api/terminal/cancel-payment-intent
terminalRouter.post('/cancel/:id', requireLandlord, async (req, res, next) => {
  try {
    await stripe.paymentIntents.cancel(req.params.id)
    res.json({ success: true })
  } catch (e) { next(e) }
})
