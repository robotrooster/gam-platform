import Stripe from 'stripe'

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not set')
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
}

// ── ACH RENT COLLECTION ───────────────────────────────────────
// Creates a Stripe PaymentIntent for ACH debit from tenant bank account
// entry_description maps to NACHA CCD/PPD entry description field
export async function createRentPaymentIntent({
  amount,          // in dollars
  stripeCustomerId,
  paymentMethodId, // saved ACH payment method
  entryDescription, // 'RENT' | 'SUBSCRIP' | 'DEPOSIT' | 'UTILITY' | 'ONTIMEPAY'
  metadata,
}: {
  amount: number
  stripeCustomerId: string
  paymentMethodId: string
  entryDescription: string
  metadata?: Record<string, string>
}) {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // cents
    currency: 'usd',
    customer: stripeCustomerId,
    payment_method: paymentMethodId,
    payment_method_types: ['us_bank_account'],
    confirm: true,
    mandate_data: {
      customer_acceptance: {
        type: 'online',
        online: { ip_address: '0.0.0.0', user_agent: 'GAM-Platform/1.0' },
      },
    },
    payment_method_options: {
      us_bank_account: {
        financial_connections: { permissions: ['payment_method'] },
      },
    },
    description: `${entryDescription} - Gold Asset Management`,
    metadata: { entryDescription, ...metadata },
  })
  return intent
}

// ── LANDLORD DISBURSEMENT ─────────────────────────────────────
// Sends payout to landlord's connected Stripe account
// This is the On-Time Pay SLA fulfillment
export async function createLandlordPayout({
  amount,
  stripeAccountId,
  description,
  metadata,
}: {
  amount: number
  stripeAccountId: string
  description: string
  metadata?: Record<string, string>
}) {
  const stripe = getStripe()
  // Transfer from platform to connected account
  const transfer = await stripe.transfers.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    destination: stripeAccountId,
    description,
    metadata: metadata || {},
  })
  return transfer
}

// ── STRIPE CONNECT ONBOARDING ─────────────────────────────────
// Creates an account link for landlord to complete Stripe Connect onboarding
export async function createConnectOnboardingLink({
  landlordId,
  email,
  returnUrl,
  refreshUrl,
}: {
  landlordId: string
  email: string
  returnUrl: string
  refreshUrl: string
}) {
  const stripe = getStripe()

  // Create or retrieve connected account
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    capabilities: {
      transfers: { requested: true },
      us_bank_account_ach_payments: { requested: true },
    },
    metadata: { landlordId },
  })

  const link = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  })

  return { accountId: account.id, url: link.url }
}

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

// ── COST CALCULATOR ───────────────────────────────────────────
export function calcStripeRentCost(rentAmount: number) {
  const ach    = Math.min(rentAmount * 0.008, 5.00)
  const payout = rentAmount * 0.0025 + 0.25
  const acct   = 2.00 / 50 // avg 50 units/landlord
  return { ach, payout, acct, total: ach + payout + acct }
}
