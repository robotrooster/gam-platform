// S165: Stripe webhook event-list verification.
//
// Usage:
//   cd apps/api
//   npm run verify:webhooks          # check the live mode currently configured by STRIPE_SECRET_KEY
//
// Lists every Stripe webhook endpoint registered against the account and
// confirms the events GAM relies on are enabled on at least one endpoint.
// Exits 0 if every required event is covered, exits 1 if any are missing.
//
// Required events (the gates and ledger writes that depend on each):
//   account.updated                — flips users.connect_*_enabled and
//                                    pm_companies.connect_*_enabled (S159+).
//                                    Without this, every readiness gate
//                                    stays at default false in prod.
//   payment_intent.succeeded       — drives rent allocation (S64+).
//   payment_intent.payment_failed  — flips payments.status to 'failed'.
//   payout.paid / .failed          — disbursement settlement tracking
//                                    (services/disbursementFiring + S118).
//   charge.dispute.created /
//   charge.dispute.closed          — dispute logging (services/stripeConnect
//                                    → recordDisputeEvent).
//
// Add to this list when new webhook handlers go in routes/webhooks.ts.

import 'dotenv/config'
import Stripe from 'stripe'

const REQUIRED_EVENTS = [
  'account.updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payout.paid',
  'payout.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
]

async function main() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    console.error('STRIPE_SECRET_KEY not set — abort')
    process.exit(1)
  }
  const stripe = new Stripe(key)

  const endpoints: Stripe.WebhookEndpoint[] = []
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
    endpoints.push(ep)
  }

  if (endpoints.length === 0) {
    console.error('✗ No webhook endpoints registered on this Stripe account.')
    console.error('  Configure one at https://dashboard.stripe.com/webhooks pointing at')
    console.error('  GAM\'s POST /api/webhooks/stripe with the events listed below.')
    process.exit(1)
  }

  // For each required event, find which (if any) endpoint(s) listen for it.
  // Stripe allows '*' wildcard subscriptions; treat '*' as covering everything.
  const coverage: Record<string, string[]> = {}
  for (const want of REQUIRED_EVENTS) coverage[want] = []
  for (const ep of endpoints) {
    const events = ep.enabled_events ?? []
    const wildcardAll = events.includes('*')
    for (const want of REQUIRED_EVENTS) {
      if (wildcardAll || events.includes(want)) {
        coverage[want].push(ep.url)
      }
    }
  }

  console.log(`Checked ${endpoints.length} webhook endpoint(s):`)
  for (const ep of endpoints) {
    const status = ep.status === 'enabled' ? '✓' : '⚠'
    console.log(`  ${status} ${ep.url}  status=${ep.status}  events=${(ep.enabled_events ?? []).length}`)
  }
  console.log('')

  const missing = REQUIRED_EVENTS.filter(e => coverage[e].length === 0)
  if (missing.length === 0) {
    console.log('✓ All required events covered:')
    for (const e of REQUIRED_EVENTS) {
      console.log(`  ✓ ${e.padEnd(34)} → ${coverage[e].length} endpoint(s)`)
    }
    process.exit(0)
  }

  console.error('✗ Missing event coverage:')
  for (const e of REQUIRED_EVENTS) {
    if (coverage[e].length === 0) {
      console.error(`  ✗ ${e}`)
    } else {
      console.log(`  ✓ ${e.padEnd(34)} → ${coverage[e].length} endpoint(s)`)
    }
  }
  console.error('')
  console.error(`Add the missing event(s) to one of the registered endpoints in the`)
  console.error(`Stripe Dashboard, or use stripe.webhookEndpoints.update(id, { enabled_events: [...] })`)
  console.error(`to add them via the API.`)
  process.exit(1)
}

main().catch(err => {
  console.error('verify-stripe-webhooks failed:', err)
  process.exit(1)
})
