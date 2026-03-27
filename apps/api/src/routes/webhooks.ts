import { Router } from 'express'
import Stripe from 'stripe'
import { query } from '../db'

export const webhooksRouter = Router()

// Stripe webhook — raw body required (set before express.json() in index.ts)
webhooksRouter.post('/stripe', async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' })
  const sig = req.headers['stripe-signature'] as string
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` })
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent
      await query(
        `UPDATE payments SET status='settled', settled_at=NOW(), stripe_payment_intent_id=$1 WHERE stripe_payment_intent_id=$1`,
        [pi.id]
      )
      // Replenish reserve if this was a previously-fronted disbursement
      await query(`
        UPDATE reserve_fund_state SET balance = balance + $1
        WHERE EXISTS (SELECT 1 FROM disbursements WHERE from_reserve=TRUE AND stripe_payout_id IS NULL)
        AND $1 > 0`, [0] // TODO: calculate actual replenishment
      )
      break
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent
      await query(
        `UPDATE payments SET status='failed', stripe_payment_intent_id=$1 WHERE stripe_payment_intent_id=$1`,
        [pi.id]
      )
      break
    }
    case 'payout.paid': {
      const payout = event.data.object as Stripe.Payout
      await query(
        `UPDATE disbursements SET status='settled', settled_at=NOW(), stripe_payout_id=$1 WHERE stripe_payout_id=$1`,
        [payout.id]
      )
      break
    }
  }

  res.json({ received: true })
})
