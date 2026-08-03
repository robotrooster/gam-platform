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
// Creates a SetupIntent for tenant bank-account verification via MICRODEPOSITS.
//
// S570 (Nic): we do NOT use Financial Connections instant verification here.
// Instant verification bills $1.50 per successful verification (Stripe FC
// pricing), which is underwater against the ~$2/occupied-unit/month platform
// fee once closer + CS commissions are paid. Microdeposit verification is FREE
// ("complimentary" on Stripe's pricing page) — Stripe drops two small deposits,
// the tenant confirms them 1–3 days later, and the account verifies with no FC
// charge. No `financial_connections` block (that IS the instant/FC path) and no
// `balances` permission (we never read balance data). Card stays instant.
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
        verification_method: 'microdeposits',
      },
    },
    metadata: { tenantId },
  })

  return { customerId: customer.id, clientSecret: setupIntent.client_secret }
}
