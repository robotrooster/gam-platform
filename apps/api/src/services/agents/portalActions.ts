/**
 * S626 — THE ALLOWLIST. What the agent may do, and nothing else.
 *
 * This file is the answer to both halves of Nic's instruction at once. Every
 * entry is a thing a landlord or tenant can do in their own portal, so adding
 * one closes a real gap; and an action NOT in this file cannot be reached by
 * any wording, any prompt, or any instruction smuggled into a message — the
 * dispatcher refuses it before a request is built.
 *
 * WHAT MAY NEVER BE ADDED HERE, whatever anyone asks:
 *   - credentials of any kind: passwords, reset flows, OTP, two-factor
 *   - card or bank entry, which belongs to Stripe's own elements
 *   - admin, business-portal, POS or public-booking surfaces — other products
 *   - anything under /platform or a superadmin route
 *
 * The descriptions are written for the model to CHOOSE by, so they say when to
 * use the action in a person's words, not what the endpoint is named. The
 * confirm-first flag is set on anything that moves money, sends something to
 * another person, or cannot be undone.
 */
import type { AgentAudience } from './types'

export interface PortalAction {
  id: string
  audience: AgentAudience
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET'
  /** Express path, ':name' segments filled from pathParams. */
  path: string
  /** Which args go in the path rather than the body. */
  pathParams?: string[]
  /** Shown to the model — when to use it, in a person's words. */
  description: string
  /** JSON-schema properties for the tool. */
  params: Record<string, { type: string; description: string }>
  required?: string[]
  /** Read the details back and get an explicit yes before calling. */
  confirmFirst?: boolean
}

export const PORTAL_ACTIONS: readonly PortalAction[] = [
  // ── LANDLORD · the portfolio itself ──────────────────────────────────
  {
    id: 'add_units',
    audience: 'landlord', method: 'POST', path: '/api/units',
    description:
      'Add one or more units to a property — apartments, RV spots, mobile-home lots, storage, ' +
      'whatever the property holds. Use for "add 12 RV spots to Sunset Palms" or "I built another ' +
      'cabin". quantity creates a numbered block in one go, and startAt names where the numbering ' +
      'begins so it matches the signage on the ground rather than starting from one.',
    params: {
      propertyId: { type: 'string', description: 'The property id — get it from the portfolio lookup, never ask the landlord for it.' },
      unitNumber: { type: 'string', description: 'The number or name of the first unit, as it reads on the ground.' },
      quantity: { type: 'integer', description: 'How many to create (default 1, max 200).' },
      startAt: { type: 'integer', description: 'Number the block from here — for a park whose second RV block runs 20-36.' },
      unitType: { type: 'string', description: 'apartment, single_family, rv_spot, campsite, mobile_home, hotel_room, storage, parking, boat_slip, land_lot, commercial' },
      bedrooms: { type: 'integer', description: 'Bedrooms, for a dwelling.' },
      bathrooms: { type: 'number', description: 'Bathrooms, for a dwelling.' },
      rentAmount: { type: 'number', description: 'Asking rent, if they gave one.' },
      securityDeposit: { type: 'number', description: 'Standard deposit for these units, if they gave one.' },
    },
    required: ['propertyId', 'unitNumber'],
    confirmFirst: true,
  },
  {
    id: 'update_unit',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId',
    pathParams: ['unitId'],
    description:
      'Change a unit’s details — rent, deposit, bedrooms, status, description. Use for "put 204 up ' +
      'to $1,250" or "mark lot 7 out of service". Say what you are changing and what it was before.',
    params: {
      unitId: { type: 'string', description: 'The unit id, resolved from a lookup — never asked of the landlord.' },
      rentAmount: { type: 'number', description: 'New asking rent.' },
      securityDeposit: { type: 'number', description: 'New standard deposit.' },
      status: { type: 'string', description: 'vacant, occupied, maintenance, unavailable — only if they asked to change it.' },
      bedrooms: { type: 'integer', description: 'Bedrooms.' },
      bathrooms: { type: 'number', description: 'Bathrooms.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },

  // ── LANDLORD · money in ──────────────────────────────────────────────
  {
    id: 'charge_a_fee',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/bill-fee',
    pathParams: ['leaseId'],
    description:
      'Bill a one-off fee to a tenant against their lease — a lease violation, an early-termination ' +
      'charge, a cost they agreed to cover. Use for "charge apt 204 $75 for the broken window". ' +
      'This puts a real charge on somebody’s ledger, so read back who, how much and what for, and ' +
      'get an explicit yes. It is not for rent and not for a utility bill.',
    params: {
      leaseId: { type: 'string', description: 'The lease id, from a lookup.' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      description: { type: 'string', description: 'What the charge is for, in their words — the tenant sees this.' },
    },
    required: ['leaseId', 'amount', 'description'],
    confirmFirst: true,
  },

  // ── LANDLORD · the books ─────────────────────────────────────────────
  {
    id: 'void_expense',
    audience: 'landlord', method: 'POST', path: '/api/expenses/:expenseId/void',
    pathParams: ['expenseId'],
    description:
      'Void an expense that was recorded by mistake. It stays on the books as a voided row rather ' +
      'than disappearing — GAM never erases. Use for "that $340 plumber bill was wrong".',
    params: { expenseId: { type: 'string', description: 'The expense id, from a lookup.' } },
    required: ['expenseId'],
    confirmFirst: true,
  },

  // ── LANDLORD · the bank feed ─────────────────────────────────────────
  {
    id: 'categorize_bank_transaction',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/transactions/:transactionId/categorize',
    pathParams: ['transactionId'],
    description:
      'File a transaction from the bank feed under a category so it lands on the P&L. Use when they ' +
      'are going through the feed: "that one was insurance". Money OUT is an expense; money IN that ' +
      'is not a GAM payout is other income — never categorise a matched GAM payout, that double-counts it.',
    params: {
      transactionId: { type: 'string', description: 'The transaction id from the bank feed.' },
      category: { type: 'string', description: 'The expense or income category it belongs to.' },
    },
    required: ['transactionId', 'category'],
  },
  {
    id: 'ignore_bank_transaction',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/transactions/:transactionId/ignore',
    pathParams: ['transactionId'],
    description:
      'Dismiss a bank-feed transaction that is not part of the rental business — a personal card, a ' +
      'transfer between their own accounts. It stops asking about it.',
    params: { transactionId: { type: 'string', description: 'The transaction id from the bank feed.' } },
    required: ['transactionId'],
  },

  // ── LANDLORD · notices ───────────────────────────────────────────────
  {
    id: 'cancel_entry_request',
    audience: 'landlord', method: 'POST', path: '/api/entry-requests/:entryRequestId/cancel',
    pathParams: ['entryRequestId'],
    description:
      'Call off a notice to enter a unit that is no longer needed — the contractor cancelled, the ' +
      'problem fixed itself. The tenant is told it is off.',
    params: { entryRequestId: { type: 'string', description: 'The entry request id, from a lookup.' } },
    required: ['entryRequestId'],
    confirmFirst: true,
  },

  // ── TENANT ───────────────────────────────────────────────────────────
  {
    id: 'log_work_trade_hours',
    audience: 'tenant', method: 'POST', path: '/api/work-trade/:agreementId/logs',
    pathParams: ['agreementId'],
    description:
      'Log hours the tenant worked under their work-trade agreement, so the credit lands against the ' +
      'month they are living in. Use for "I did four hours on the grounds Saturday". Confirm the ' +
      'hours and the date back before sending — these become money against their rent.',
    params: {
      agreementId: { type: 'string', description: 'Their work-trade agreement id, from get_work_trade_standing.' },
      hours: { type: 'number', description: 'How many hours.' },
      workDate: { type: 'string', description: 'YYYY-MM-DD. Today if they did not say.' },
      description: { type: 'string', description: 'What they did, in their words.' },
    },
    required: ['agreementId', 'hours', 'workDate'],
    confirmFirst: true,
  },
  {
    id: 'acknowledge_lease_notice',
    audience: 'tenant', method: 'POST', path: '/api/tenants/lease-notices/:noticeId/acknowledge',
    pathParams: ['noticeId'],
    description:
      'Mark that the tenant has read a notice from their landlord. Only after they have actually ' +
      'seen what it says — read it to them first, then acknowledge it if they want to. Acknowledging ' +
      'is a record that they were told.',
    params: { noticeId: { type: 'string', description: 'The notice id.' } },
    required: ['noticeId'],
    confirmFirst: true,
  },
]

const BY_ID = new Map(PORTAL_ACTIONS.map((a) => [a.id, a]))
export function getPortalAction(id: string): PortalAction | undefined { return BY_ID.get(id) }
export function portalActionsFor(audience: AgentAudience): PortalAction[] {
  return PORTAL_ACTIONS.filter((a) => a.audience === audience)
}
