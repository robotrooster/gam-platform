/**
 * Tool: get_my_payment_methods (tenant READ).
 *
 * The tenant's SAVED rent-payment methods — every bank (ACH) and card. These
 * live on the tenant's STRIPE customer, NOT in user_bank_accounts (that table
 * is the landlord/PM payout-DESTINATION catalog — money going OUT — and is
 * empty for a rent-paying tenant, which is why the old query answered "no
 * methods" for everyone). Same source as GET /stripe/tenant/payment-methods
 * and the Pay Now picker: services/tenantBankMethods.loadTenantPaymentMethods.
 *
 * S655 (item L, keep the old bank): a tenant can now hold several banks, so
 * whether each one can be charged is read off THAT bank — a bank still waiting
 * on its microdeposits is not chargeable, while the verified bank beside it
 * still is. Before, every bank borrowed the tenant-level ach_verified flag and
 * a bank mid-verification (not yet attached to the customer) was missing
 * altogether. Returns bank name / card brand + last 4; never full account
 * numbers.
 */

import { loadTenantPaymentMethods } from '../../tenantBankMethods'
import type { AgentTool, AgentActor } from './types'

const NONE = 'No bank account or card is connected yet — the tenant sets one up in the Payments section.'

export const getMyPaymentMethods: AgentTool = {
  name: 'get_my_payment_methods',
  description:
    'Check which rent-payment methods the tenant has connected — every bank account (ACH) and card — ' +
    'and whether each one can be charged now. Use for “is my bank set up?”, “is my bank verified yet?”, ' +
    '“which card do I have on file?”, or “why can’t I pay?”. A bank still verifying (micro-deposits) is ' +
    'connected but not chargeable; a verified bank beside it still is. Returns only the last 4 digits / ' +
    'card brand, never full account numbers. Read-only.\n' +
    'Each method comes back with an id — that is what pay_my_balance charges. Use it; never say it out loud.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    let state
    try {
      state = await loadTenantPaymentMethods(actor.profileId)
    } catch {
      // Never claim "no methods" on a lookup failure — that would misinform a
      // tenant who actually has one. Report honestly so the agent retries/escalates.
      return {
        ok: false,
        error: 'could_not_check',
        note: 'Could not check the tenant’s saved payment methods right now — do NOT tell them they have none; try again or escalate.',
      }
    }
    if (!state || !state.hasCustomer) {
      return { ok: true, hasPaymentMethod: false, methods: [], note: NONE }
    }

    const methods = state.methods.map((m) => m.type === 'ach'
      ? {
          // S628: the id is what pay_my_balance charges. It is a
          // customer-scoped Stripe token — Stripe refuses a PaymentIntent whose
          // payment_method belongs to a different customer, and the charge path
          // always supplies THIS tenant's customer id — so it cannot be used
          // against anyone else's account. Never read it out to the tenant.
          id:                  m.id,
          type:                'ach' as const,
          bankName:            m.bankName,
          last4:               m.last4,
          chargeable:          m.chargeable,
          verificationPending: m.verifying,
          isDefault:           m.isDefault,
        }
      : {
          id:                  m.id,
          type:                'card' as const,
          brand:               m.brand,
          last4:               m.last4,
          chargeable:          true,                    // cards are chargeable immediately
          verificationPending: false,
          isDefault:           m.isDefault,
        })

    const notes: string[] = []
    if (methods.length === 0) notes.push(NONE)
    // A bank still verifying is either waiting on the tenant (the deposits) or
    // being checked by Stripe after they entered them — nothing left to do.
    const verifying = state.methods.some((m) => m.type === 'ach' && m.verificationStep === 'deposits')
    const beingChecked = state.methods.some((m) => m.type === 'ach' && m.verificationStep === 'checking')
    const bankChargeable = methods.some((m) => m.type === 'ach' && m.chargeable)
    if (state.achSuspended && methods.some((m) => m.type === 'ach')) {
      notes.push('Bank payments are switched off on this account because a bank payment was returned. They can pay by card. ' +
        'Do not offer a bank payment, and do not promise when it comes back — a person has to review it.')
    }
    if (verifying) {
      // S605: Stripe sends EITHER two small deposits OR a single $0.01 whose
      // statement description carries a six-digit code, chosen per bank. An
      // agent that names the wrong one sends the tenant looking for something
      // that isn't on their statement.
      notes.push(bankChargeable
        ? 'A new bank is still verifying — the tenant must finish the verification Stripe sent (either the two deposit amounts, or the six-digit code in the description of a $0.01 deposit, depending on their bank). Their other, verified bank still works meanwhile.'
        : 'A bank is connected but still verifying — the tenant must finish the verification Stripe sent (either the two deposit amounts, or the six-digit code in the description of a $0.01 deposit, depending on their bank) before it can be charged; they can pay by card in the meantime.')
    }
    if (beingChecked) {
      notes.push('The tenant has already entered their bank verification and Stripe is checking it now — there is nothing more ' +
        'for them to do. That bank can be charged once the check finishes' +
        (bankChargeable ? '; their other, verified bank still works meanwhile.' : '; they can pay by card in the meantime.'))
    }
    if (state.pendingLookupFailed) {
      notes.push('Could not check for a bank still verifying — if they say they added one, it may be waiting on its deposits.')
    }
    return {
      ok: true,
      hasPaymentMethod: methods.length > 0,
      methods,
      note: notes.length ? notes.join(' ') : undefined,
    }
  },
}
