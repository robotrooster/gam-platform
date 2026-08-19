/**
 * Tool: get_my_payment_methods (tenant READ).
 *
 * The tenant's SAVED rent-payment methods — bank (ACH) and/or card. These
 * live on the tenant's STRIPE customer, NOT in user_bank_accounts (that table
 * is the landlord/PM payout-DESTINATION catalog — money going OUT — and is
 * empty for a rent-paying tenant, which is why the old query answered "no
 * methods" for everyone). Mirrors GET /stripe/tenant/payment-methods, the same
 * source the Pay Now picker uses.
 *
 * Returns bank name / card brand + last 4 + whether each is chargeable now. A
 * just-linked ACH bank is connected but NOT chargeable until the tenant
 * confirms the two micro-deposits (tenants.ach_verified). Never returns full
 * account numbers.
 */

import { query } from '../../../db'
import { getStripe } from '../../../lib/stripe'
import type { AgentTool, AgentActor } from './types'

export const getMyPaymentMethods: AgentTool = {
  name: 'get_my_payment_methods',
  description:
    'Check whether the tenant has a rent-payment method connected — a bank account (ACH) and/or a card — ' +
    'and each one’s status. Use for “is my bank set up?”, “is my bank verified yet?”, “which card do I have ' +
    'on file?”, or “why can’t I pay?”. A bank pending micro-deposit verification is connected but not yet ' +
    'chargeable (pay by card meanwhile). Returns only the last 4 digits / card brand, never full account ' +
    'numbers. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    // Tenant identity → their Stripe customer + the ACH verification flag.
    const rows = await query<{ stripe_customer_id: string | null; ach_verified: boolean }>(
      `SELECT stripe_customer_id, ach_verified FROM tenants WHERE id = $1`,
      [actor.profileId]
    )
    const tenant = rows[0]
    if (!tenant || !tenant.stripe_customer_id) {
      return {
        ok: true,
        hasPaymentMethod: false,
        methods: [],
        note: 'No bank account or card is connected yet — the tenant sets one up in the Payments section.',
      }
    }

    try {
      const stripe = getStripe()
      const [achList, cardList] = await Promise.all([
        stripe.paymentMethods.list({ customer: tenant.stripe_customer_id, type: 'us_bank_account', limit: 20 }),
        stripe.paymentMethods.list({ customer: tenant.stripe_customer_id, type: 'card', limit: 20 }),
      ])
      const methods = [
        ...achList.data.map((pm) => ({
          type:                'ach' as const,
          bankName:            pm.us_bank_account?.bank_name ?? null,
          last4:               pm.us_bank_account?.last4 ?? null,
          chargeable:          !!tenant.ach_verified,   // ACH usable only after micro-deposit confirm
          verificationPending: !tenant.ach_verified,
        })),
        ...cardList.data.map((pm) => ({
          type:                'card' as const,
          brand:               pm.card?.brand ?? null,
          last4:               pm.card?.last4 ?? null,
          chargeable:          true,                    // cards are chargeable immediately
          verificationPending: false,
        })),
      ]
      const bankPendingVerify = methods.some((m) => m.type === 'ach' && m.verificationPending)
      return {
        ok: true,
        hasPaymentMethod: methods.length > 0,
        methods,
        note:
          methods.length === 0
            ? 'No bank account or card is connected yet — the tenant sets one up in the Payments section.'
            : bankPendingVerify
              // S605: Stripe sends EITHER two small deposits OR a single $0.01
              // whose statement description carries a six-digit code, chosen per
              // bank. An agent that names the wrong one sends the tenant looking
              // for something that isn't on their statement.
              ? 'A bank is connected but still verifying — the tenant must finish the verification Stripe sent (either the two deposit amounts, or the six-digit code in the description of a $0.01 deposit, depending on their bank) before it can be charged; they can pay by card in the meantime.'
              : undefined,
      }
    } catch {
      // Never claim "no methods" on a lookup failure — that would misinform a
      // tenant who actually has one. Report honestly so the agent retries/escalates.
      return {
        ok: false,
        error: 'could_not_check',
        note: 'Could not check the tenant’s saved payment methods right now — do NOT tell them they have none; try again or escalate.',
      }
    }
  },
}
