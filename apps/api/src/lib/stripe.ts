import Stripe from 'stripe'

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not set')
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
}

// S113 (current architecture): Stripe Connect Express + destination charges
// for inbound; Stripe Payouts for outbound. Connect helpers live in
// services/stripeConnect.ts (account create/onboarding, destination
// charges, transfers, payout/dispute webhooks). Outbound payouts to
// landlord/PM bank accounts fire via services/connectPayouts.ts. Tenant-
// facing rent charges run through services/stripeConnect.ts
// createRentDestinationCharge / createRentPlatformCharge — NOT a flat
// PaymentIntent helper here.

// ── TENANT ACH SETUP ──────────────────────────────────────────
// Creates a Financial Connections session for tenant bank account verification
export async function createTenantAchSetup({
  tenantId,
  email,
}: {
  tenantId: string
  email: string
}) {
  const stripe = getStripe()

  const customer = await stripe.customers.create({
    email,
    metadata: { tenantId },
  })

  const setupIntent = await stripe.setupIntents.create({
    customer: customer.id,
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: {
        financial_connections: {
          permissions: ['payment_method', 'balances'],
        },
        verification_method: 'instant',
      },
    },
    metadata: { tenantId },
  })

  return { customerId: customer.id, clientSecret: setupIntent.client_secret }
}
