import Stripe from 'stripe'

// ── S639: A TEST RUN MUST NEVER REACH LIVE STRIPE ────────────────────────────
//
// Nic: "I have fifty one transactions, and, like, probably forty of them are
// incomplete... They're all spammed at five sixteen PM on September second.
// Where are all these tries coming from? I'm assuming the person only paid
// once."
//
// He did. 43 of the 51 were PaymentIntents in `requires_payment_method` — a
// card was never entered on any of them — and 41 carried a metadata userId that
// does not exist in the production database. They were created by the TEST
// SUITE against the live key.
//
// apps/api/.env holds the live secret, globalSetup loads it with dotenv, and
// vitest runs singleFork so one shared process imports every route module. Six
// test files exercise the screening intake without mocking Stripe, so
// background.ts built a real client at import and every intake test minted a
// real PaymentIntent on Nic's live account, against seeded users that were
// dropped with the test database seconds later.
//
// Per-file vi.mock('stripe') was the only thing standing between the suite and
// the live account, and five files out of six did not have it. That is not a
// safeguard, it is a coincidence. This is the safeguard: under vitest, a LIVE
// key is refused outright. A test-mode key still works (nothing real moves), so
// anyone who genuinely wants to exercise Stripe in a test can point at one.
export function stripeSecretKeyOrNull(): string | undefined {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return undefined
  const underTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST_POOL_ID || !!process.env.VITEST
  if (underTest && key.startsWith('sk_live')) return undefined
  return key
}

export function getStripe() {
  const key = stripeSecretKeyOrNull()
  if (!key) {
    throw new Error(
      process.env.STRIPE_SECRET_KEY
        ? 'Refusing to use a LIVE Stripe key from a test run (S639) — mock stripe, or set a test-mode key'
        : 'STRIPE_SECRET_KEY not set')
  }
  return new Stripe(key, { apiVersion: '2023-10-16' })
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
