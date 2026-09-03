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
    // The path was '/api/units/:unitId' until portalActionPaths.test.ts caught
    // it: that route does not exist. Unit edits are split by concern —
    // /details, /status, /number, /type — and a guessed path would have 404'd
    // in front of a customer with the agent unable to say why.
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/details',
    pathParams: ['unitId'],
    description:
      'Change a unit’s details — rent, deposit, bedrooms, bathrooms, size, accessibility. Use for ' +
      '"put 204 up to $1,250" or "204 is actually a two bed". Say what you are changing and what it ' +
      'was before, so a wrong unit is caught before it is saved.\n' +
      'This does NOT change whether the unit is available — that is set_unit_status.',
    params: {
      unitId: { type: 'string', description: 'The unit id, resolved from a lookup — never asked of the landlord.' },
      rentAmount: { type: 'number', description: 'New asking rent.' },
      securityDeposit: { type: 'number', description: 'New standard deposit.' },
      bedrooms: { type: 'integer', description: 'Bedrooms.' },
      bathrooms: { type: 'number', description: 'Bathrooms.' },
      sqft: { type: 'integer', description: 'Square feet.' },
      unitType: { type: 'string', description: 'apartment, single_family, rv_spot, campsite, mobile_home, hotel_room, storage, parking, boat_slip, land_lot, commercial' },
      isAdaAccessible: { type: 'boolean', description: 'Whether the unit is ADA accessible.' },
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
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
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

  // ── LANDLORD · the lease clock ───────────────────────────────────────
  {
    id: 'offer_renewal',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/offer-renewal',
    pathParams: ['leaseId'],
    description:
      'Tell a tenant their landlord is willing to renew, which opens the renewal conversation and ' +
      'lets the tenant answer. Use for "let apt 204 know I\u2019ll renew them". It does NOT set the new ' +
      'rent or the new term — the landlord offers those separately, so do not quote a figure here ' +
      'and do not imply one has been agreed.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'serve_non_renewal_notice',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/non-renewal',
    pathParams: ['leaseId'],
    description:
      'Serve written notice that a lease will NOT be renewed and ends on its end date. This is a ' +
      'legal notice with a clock attached, not a note — read back the tenant, the unit and the end ' +
      'date, say plainly that it is formal notice of non-renewal, and get an unambiguous yes. If the ' +
      'landlord is only thinking about it, do not call this.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'hibernate_lease',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/hibernate',
    pathParams: ['leaseId'],
    description:
      'Pause an active lease — a seasonal site nobody is on over winter, a tenant away for months. ' +
      'Billing stops while it is hibernating and the lease is still theirs. Use resume_lease to ' +
      'start it again.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'resume_lease',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/resume',
    pathParams: ['leaseId'],
    description:
      'Bring a hibernating lease back into billing, when a seasonal tenant returns or a unit comes ' +
      'back into use. Use for "put lot 12 back on" or "the Hendersons are back for the winter".\n' +
      'Rent starts being charged again from the resume date, so say which date that is — a lease ' +
      'resumed a week early bills a week nobody was living there.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },

  // ── LANDLORD · unit lifecycle ────────────────────────────────────────
  {
    id: 'set_unit_status',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/status',
    pathParams: ['unitId'],
    description:
      'Change what a unit is doing: vacant, available, active, delinquent, suspended, or owner_use. ' +
      'Use owner_use for a unit the owner or their family lives in — it carries no lease and no rent ' +
      'and is not advertised. Use for "take lot 7 off the market" or "I\u2019m moving into 12".',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      status: { type: 'string', description: 'vacant, available, active, delinquent, suspended, owner_use' },
    },
    required: ['unitId', 'status'],
    confirmFirst: true,
  },
  {
    id: 'retire_unit',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/retire',
    pathParams: ['unitId'],
    description:
      'Retire a unit that no longer exists or can no longer be rented — a lot that was sold, a ' +
      'building pulled down. It keeps all its history and stops being billable or bookable, and it ' +
      'can never hold a lease again. GAM does not delete; this is the correct way to remove one. ' +
      'Confirm hard: this is not how you make a unit temporarily unavailable — that is ' +
      'set_unit_status.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      unitNumber: { type: 'string', description: 'The unit number, typed back as confirmation that this is the right one.' },
      reason: { type: 'string', description: 'Why it is being retired, in their words.' },
    },
    required: ['unitId', 'unitNumber'],
    confirmFirst: true,
  },

  // ── LANDLORD · documents out for signature ───────────────────────────
  {
    id: 'send_document_for_signature',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/:documentId/send',
    pathParams: ['documentId'],
    description:
      'Send a prepared document to its signers. Use for "send the lease to apt 204". The document ' +
      'must already exist and be built — this only puts it in front of the people who sign it.\n' +
      'It goes to a real person and cannot be recalled, so read back what the document is and who is ' +
      'about to receive it. If they are unsure which document, list them rather than picking one.',
    params: { documentId: { type: 'string', description: 'The document id, from a lookup — never asked of the landlord.' } },
    required: ['documentId'],
    confirmFirst: true,
  },
  {
    id: 'void_document',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/:documentId/void',
    pathParams: ['documentId'],
    description:
      'Void a document that should not be signed — wrong terms, wrong tenant, superseded. It stays ' +
      'on record as voided rather than vanishing. Signers can no longer sign it. Use for "kill the ' +
      'lease I sent to 204, the rent was wrong".',
    params: {
      documentId: { type: 'string', description: 'The document id, from a lookup.' },
      reason: { type: 'string', description: 'Why it is being voided, in their words — this is the audit trail.' },
    },
    required: ['documentId'],
    confirmFirst: true,
  },

  // ── LANDLORD · meters and utility billing ────────────────────────────
  {
    id: 'record_meter_reading',
    audience: 'landlord', method: 'POST', path: '/api/utility/meters/:meterId/readings',
    pathParams: ['meterId'],
    description:
      'Record a meter reading so the utility can be billed for that cycle. Use when they read a meter ' +
      'and tell you the number: "lot 14 water is at 89,120". readingValue is the number ON THE DIAL, ' +
      'not the usage since last time — GAM works the usage out from the previous reading. ' +
      'billingCycleMonth is the month being billed as YYYY-MM-01.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      readingDate: { type: 'string', description: 'YYYY-MM-DD — the day it was read. Today unless they said otherwise.' },
      readingValue: { type: 'number', description: 'The number showing on the meter, not the difference.' },
      billingCycleMonth: { type: 'string', description: 'YYYY-MM-01 — the cycle this reading bills.' },
    },
    required: ['meterId', 'readingDate', 'readingValue', 'billingCycleMonth'],
    confirmFirst: true,
  },
  {
    id: 'start_meter_reading_run',
    audience: 'landlord', method: 'POST', path: '/api/utility/reading-runs',
    pathParams: [],
    description:
      'Open a reading run for a property — the monthly round where every meter gets read before the ' +
      'utilities are billed. Use for "start this month\u2019s readings at Sunset Palms". Leave ' +
      'cycleMonth off for the current cycle.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      cycleMonth: { type: 'string', description: 'YYYY-MM-01. Omit for the current cycle.' },
    },
    required: ['propertyId'],
  },

  // ── LANDLORD · work trade ────────────────────────────────────────────
  {
    id: 'create_work_trade_agreement',
    audience: 'landlord', method: 'POST', path: '/api/work-trade',
    pathParams: [],
    description:
      'Set up a work-trade agreement — a tenant works off part of their rent. Use for "Dan\u2019s going ' +
      'to do the grounds for $200 off". Work trade pays for the month they are living in, so the ' +
      'agreement starts when the work does.\n' +
      'This is money against somebody\u2019s rent: read back the tenant, the unit, the duties, the start ' +
      'date and the monthly hours before creating it.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      tenantId: { type: 'string', description: 'The tenant id, from a lookup.' },
      startDate: { type: 'string', description: 'YYYY-MM-DD — when the arrangement begins.' },
      endDate: { type: 'string', description: 'YYYY-MM-DD, if it is for a fixed period.' },
      duties: { type: 'string', description: 'What they will actually do, in the landlord\u2019s words.' },
      monthlyHoursTarget: { type: 'integer', description: 'Hours a month the agreement expects.' },
    },
    required: ['unitId', 'tenantId', 'startDate'],
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
  {
    id: 'report_bank_deposit',
    audience: 'tenant', method: 'POST', path: '/api/declared-deposits',
    pathParams: [],
    description:
      'Report that the tenant paid at the bank — walked in and deposited cash, or handed over a ' +
      'check or money order. Use when they say "I already paid it in at the bank on Tuesday".\n' +
      'This does NOT settle the charge on its own. It tells their landlord what they say they paid ' +
      'and when, and it is matched against the bank record when the money shows up. Say that plainly: ' +
      'they should not walk away thinking the balance is cleared. Take the reference number if the ' +
      'deposit or the money order has one — it is what makes the match work.\n' +
      'declaredDate is the day THEY went to the bank, in their own timezone, which can legitimately ' +
      'be later than the date at the property. Never tell them a date they give you is in the future.',
    params: {
      leaseId: { type: 'string', description: 'Their lease id, from get_my_lease.' },
      amount: { type: 'number', description: 'How much they paid in.' },
      declaredDate: { type: 'string', description: 'YYYY-MM-DD — the day they went to the bank.' },
      method: { type: 'string', description: 'cash, check, or money_order.' },
      reference: { type: 'string', description: 'Deposit slip, check or money-order number, if there is one.' },
    },
    required: ['leaseId', 'amount', 'declaredDate', 'method'],
    confirmFirst: true,
  },
  {
    id: 'set_up_autopay',
    audience: 'tenant', method: 'PUT', path: '/api/autopay',
    pathParams: [],
    description:
      'Turn autopay on or off for the tenant\u2019s lease, and choose which day it pulls. Use for "just ' +
      'take it automatically" or "turn that off, I want to pay manually".\n' +
      'CONFIRM CLEARLY when switching it ON: money will leave their account without them doing ' +
      'anything, on the day chosen, for the full rent. Read back the day and that it is the whole ' +
      'balance, not part of it. Leave pullDay out to charge on the day rent is due, which is the ' +
      'ordinary case; 1-28 otherwise, because a 29th does not exist every month.',
    params: {
      leaseId: { type: 'string', description: 'Their lease id, from get_my_lease.' },
      enabled: { type: 'boolean', description: 'true to turn autopay on, false to turn it off.' },
      pullDay: { type: 'integer', description: '1-28. Omit to charge on the rent due date.' },
    },
    required: ['leaseId', 'enabled'],
    confirmFirst: true,
  },
  // ── LANDLORD · the business itself (S628) ────────────────────────────
  //
  // Nic: "anything I could get on and do as a landlord, I should be able to
  // tell the agent to do." Settings were the biggest untouched area — 36
  // endpoints — and they are the ones a landlord changes once and then cannot
  // find again, which is exactly the kind of thing you ask an assistant for.
  {
    id: 'update_business_settings',
    audience: 'landlord', method: 'PATCH', path: '/api/landlords/me',
    description:
      'Change the landlord\u2019s own business settings — the business name on their paperwork, their ' +
      'EIN, the dollar figure above which a maintenance job needs their approval, the figure above ' +
      'which a deposit return needs their approval, and their standard early-termination charge in ' +
      'months of rent. Use for "stop asking me about repairs under $500" or "we changed our LLC name".\n' +
      'Only send the fields they actually asked to change; anything you leave out is kept as it was. ' +
      'For the early-termination policy, send defaultEarlyTerminationMonthsRent as null to say there ' +
      'is no standing policy — that is different from sending zero, which means no charge.',
    params: {
      businessName: { type: 'string', description: 'The legal or trading name of their business.' },
      ein: { type: 'string', description: 'Their federal EIN.' },
      maintApprovalThreshold: { type: 'number', description: 'Maintenance jobs above this dollar figure wait for their approval.' },
      depositReturnApprovalThreshold: { type: 'number', description: 'Deposit returns above this dollar figure wait for their approval.' },
      defaultEarlyTerminationMonthsRent: { type: 'number', description: 'Standing early-termination charge, in months of rent. null means no policy on file.' },
    },
    required: [],
    confirmFirst: true,
  },
  {
    id: 'create_entity',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/entities',
    description:
      'Create another entity — a second LLC, partnership or holding company — for the same person to ' +
      'hold properties under. Use for "I am buying the duplex under a new LLC" or "that park is owned ' +
      'by a different company". Same land owner, different companies is how real estate is actually ' +
      'held, and each entity keeps its own properties, books and payouts.\n' +
      'A new entity starts with no payout account and no properties, so nothing is billed until it ' +
      'goes live. Read the name back before creating it — an entity is a real company record.',
    params: {
      businessName: { type: 'string', description: 'The name of the new entity, exactly as it is registered.' },
      ein: { type: 'string', description: 'Its EIN, if they have one yet.' },
    },
    required: ['businessName'],
    confirmFirst: true,
  },

  // ── LANDLORD · deposit interest, where the money is not theirs ────────
  {
    id: 'set_deposit_interest_rate',
    audience: 'landlord', method: 'PUT', path: '/api/landlords/me/deposit-interest-overrides',
    description:
      'Record the deposit-interest rate to pay in a state that does not publish a fixed one — the ' +
      'variable-rate states where the figure is the landlord\u2019s own bank passbook rate or the rate ' +
      'the state publishes each year. Use for "New Jersey is 0.35% this year".\n' +
      'This only applies where the state leaves the rate open. If the state sets the rate in statute, ' +
      'the system already uses that figure and will refuse this — say so plainly rather than trying ' +
      'again, because the statutory rate is what gets paid either way. Ask where they got the number ' +
      'and put it in sourceNotes, because this is money owed to tenants and the source matters later.',
    params: {
      stateCode: { type: 'string', description: 'Two-letter state code, e.g. NJ.' },
      effectiveYear: { type: 'integer', description: 'The year this rate applies to.' },
      annualRatePct: { type: 'number', description: 'The annual rate as a percentage — 0.35 means 0.35%, not 35%.' },
      sourceNotes: { type: 'string', description: 'Where the figure came from — the bank, the state\u2019s published notice.' },
    },
    required: ['stateCode', 'effectiveYear', 'annualRatePct'],
    confirmFirst: true,
  },
  {
    id: 'remove_deposit_interest_rate',
    audience: 'landlord', method: 'DELETE',
    path: '/api/landlords/me/deposit-interest-overrides/:state/:year',
    pathParams: ['state', 'year'],
    description:
      'Remove a deposit-interest rate they entered for a state and year, when it was wrong or entered ' +
      'twice. Removing it does not stop interest being owed — it removes the FIGURE, and without one ' +
      'that state and year has no rate on file at all. Say that before you do it.',
    params: {
      state: { type: 'string', description: 'Two-letter state code.' },
      year: { type: 'integer', description: 'The year the rate was entered for.' },
    },
    required: ['state', 'year'],
    confirmFirst: true,
  },

  // ── LANDLORD · handing a property to a manager ───────────────────────
  {
    id: 'invite_property_manager',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/pm-property-invitations',
    description:
      'Invite a property-management company to take on one of their properties. Use for "get Desert ' +
      'Ridge PM onto Sunset Palms".\n' +
      'This sends a real invitation email and, if the company accepts, hands them the day-to-day ' +
      'running of that property. Read back which company, which property and what scope before you ' +
      'send it. Scope "manage" is full day-to-day management and is the one that can carry a fee ' +
      'plan; the narrower scopes do not. They can revoke an invitation that has not been accepted.',
    params: {
      pmCompanyId: { type: 'string', description: 'The management company id, from a lookup — never asked of the landlord.' },
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      invitedEmail: { type: 'string', description: 'The email address at the management company to send it to.' },
      proposedScope: { type: 'string', description: 'What the company would be taking on. Defaults to manage, which is full day-to-day management.' },
      proposedFeePlanId: { type: 'string', description: 'The fee plan being proposed, if there is one. Only applies to the manage scope.' },
    },
    required: ['pmCompanyId', 'propertyId', 'invitedEmail'],
    confirmFirst: true,
  },
  {
    id: 'accept_pm_invitation',
    audience: 'landlord', method: 'POST',
    path: '/api/landlords/me/pm-property-invitations/:invId/accept',
    pathParams: ['invId'],
    description:
      'Accept an invitation a management company sent asking to manage one of their properties. Use ' +
      'for "yes, let them take it on".\n' +
      'If a different company already manages that property, this only goes through when replace is ' +
      'true — and that REMOVES the current manager. Never set replace without saying who is being ' +
      'replaced and getting a yes to that specific thing.',
    params: {
      invId: { type: 'string', description: 'The invitation id, from a lookup.' },
      replace: { type: 'boolean', description: 'true to hand the property over even though another company manages it today.' },
    },
    required: ['invId'],
    confirmFirst: true,
  },
  {
    id: 'reject_pm_invitation',
    audience: 'landlord', method: 'POST',
    path: '/api/landlords/me/pm-property-invitations/:invId/reject',
    pathParams: ['invId'],
    description:
      'Turn down an invitation a management company sent. Use for "no thanks, tell them we are ' +
      'staying self-managed". A reason is optional and the company sees it, so keep it civil and in ' +
      'the landlord\u2019s own words.',
    params: {
      invId: { type: 'string', description: 'The invitation id, from a lookup.' },
      reason: { type: 'string', description: 'Why, in their words. The company reads this.' },
    },
    required: ['invId'],
    confirmFirst: true,
  },
  {
    id: 'revoke_pm_invitation',
    audience: 'landlord', method: 'DELETE',
    path: '/api/landlords/me/pm-property-invitations/:invId',
    pathParams: ['invId'],
    description:
      'Take back an invitation THEY sent to a management company, before it has been accepted. Use ' +
      'for "cancel that invite to Desert Ridge, we went with someone else". This only works on ' +
      'invitations they sent; one sent TO them is turned down with the reject action instead.',
    params: { invId: { type: 'string', description: 'The invitation id, from a lookup.' } },
    required: ['invId'],
    confirmFirst: true,
  },
  {
    id: 'set_default_pm_company',
    audience: 'landlord', method: 'PATCH', path: '/api/landlords/me/default-pm-company',
    description:
      'Set which management company new properties default to, or clear it so new properties start ' +
      'self-managed. Use for "put everything new under Desert Ridge from now on". Send pmCompanyId ' +
      'as null to clear it.\n' +
      'This changes what happens NEXT — it does not move any property they already have.',
    params: {
      pmCompanyId: { type: 'string', description: 'The management company id, or null to clear the default. It must be one already linked to a property of theirs.' },
    },
    required: ['pmCompanyId'],
    confirmFirst: true,
  },
  // ── LANDLORD · properties (S628) ─────────────────────────────────────
  //
  // 24 endpoints, none of them reachable before. A landlord adds a property
  // once and then edits its fee schedule and late-fee policy for years, and
  // those are the settings people cannot find twice.
  {
    id: 'add_property',
    audience: 'landlord', method: 'POST', path: '/api/properties',
    description:
      'Add a property to their portfolio — a building, a park, a single house, whatever they bought. ' +
      'Use for "I closed on the fourplex on Roosevelt".\n' +
      'The FULL ADDRESS is the property. If they already have one at the same street address and ' +
      'suite line it will be refused as a duplicate, and that refusal is usually right — read it out ' +
      'rather than trying a different name. Adding the property does NOT add units; that is add_units ' +
      'once this comes back with an id. landlordId only matters when they hold properties under more ' +
      'than one entity, and then it is which company owns THIS one.\n' +
      'The whole address is required. If they name the building without one, ask for it \u2014 do not '  +
      'invent a street, city or zip to get the call through.',
    params: {
      name: { type: 'string', description: 'What they call it — "Sunset Palms", "412 Roosevelt".' },
      street1: { type: 'string', description: 'Street address.' },
      street2: { type: 'string', description: 'Suite, unit or building line. Part of what makes the address unique.' },
      city: { type: 'string', description: 'City.' },
      state: { type: 'string', description: 'State.' },
      zip: { type: 'string', description: 'ZIP code.' },
      type: { type: 'string', description: 'residential, rv_longterm, rv_weekly, rv_nightly, or mixed.' },
      operatorOwnsLand: { type: 'boolean', description: 'false only for a homes-only park where somebody else owns the land under it.' },
      landlordId: { type: 'string', description: 'Which of their entities owns it. Leave out unless they said a different company.' },
    },
    required: ['name', 'street1', 'city', 'state', 'zip'],
    confirmFirst: true,
  },
  {
    id: 'update_property',
    audience: 'landlord', method: 'PATCH', path: '/api/properties/:propertyId',
    pathParams: ['propertyId'],
    description:
      'Change a property\u2019s name, address, or its default late-fee policy. Use for "the park is ' +
      'called Sunset Palms now" or "give everyone at Oak Street five days grace".\n' +
      'The late-fee fields here are the PROPERTY DEFAULT that flows into new leases. They do not ' +
      'change a lease somebody has already signed — that lease keeps the terms it was signed with, ' +
      'and saying otherwise would be wrong. For a policy that differs by unit type at the same ' +
      'property, use set_late_fee_policy instead.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      name: { type: 'string', description: 'New name.' },
      street1: { type: 'string', description: 'Street address.' },
      street2: { type: 'string', description: 'Suite or building line.' },
      city: { type: 'string', description: 'City.' },
      state: { type: 'string', description: 'State.' },
      zip: { type: 'string', description: 'ZIP code.' },
      lateFeeEnabled: { type: 'boolean', description: 'Whether late fees apply here at all.' },
      lateFeeGraceDays: { type: 'integer', description: 'Days after the due date before a fee applies.' },
      lateFeeInitialAmount: { type: 'number', description: 'The first late fee — dollars, or a percent if the type says so.' },
      lateFeeInitialType: { type: 'string', description: 'flat or percent_of_rent.' },
    },
    required: ['propertyId'],
    confirmFirst: true,
  },
  {
    id: 'set_property_fee',
    audience: 'landlord', method: 'POST', path: '/api/properties/:propertyId/fee-schedule',
    pathParams: ['propertyId'],
    description:
      'Set or change one fee on a property\u2019s fee schedule — a pet fee, a move-in fee, monthly ' +
      'parking, an application fee. Use for "pets are $300 at Sunset Palms".\n' +
      'This is the SCHEDULE, the standing price at that property. It does not charge anybody: an ' +
      'existing tenant is billed with charge_a_fee. Say which it is you are doing, because a landlord ' +
      'who meant to bill one tenant and got a property-wide price change will not notice for a month.\n' +
      'isRefundable separates a deposit from a fee, and dueTiming says when it lands — move_in, ' +
      'monthly_ongoing, move_out or other. Both change what the tenant owes, so ask rather than guess.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      feeType: { type: 'string', description: 'pet_deposit, key_deposit, cleaning_deposit, move_in_fee, cleaning_fee, pet_fee, application_fee, amenity_fee, hoa_transfer_fee, lease_prep_fee, pet_rent, parking_rent, storage_rent, amenity_fee_monthly, trash_fee, pest_control_fee, technology_fee, last_month_rent, early_termination_fee, other_fee' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      isRefundable: { type: 'boolean', description: 'true for a deposit they get back, false for a fee they do not.' },
      dueTiming: { type: 'string', description: 'move_in, monthly_ongoing, move_out, or other.' },
      description: { type: 'string', description: 'What it is, in their words. Required in practice for other_fee.' },
      slotIndex: { type: 'integer', description: 'Only for other_fee, when there is more than one — 0, 1, 2.' },
    },
    required: ['propertyId', 'feeType', 'amount', 'isRefundable', 'dueTiming'],
    confirmFirst: true,
  },
  {
    id: 'remove_property_fee',
    audience: 'landlord', method: 'DELETE',
    path: '/api/properties/:propertyId/fee-schedule/:rowId',
    pathParams: ['propertyId', 'rowId'],
    description:
      'Take a fee off a property\u2019s fee schedule, so new tenants are not charged it. Use for "we ' +
      'stopped charging the technology fee". Tenants already on a lease that included it keep the ' +
      'terms they signed — this changes what happens next, not what was agreed.',
    params: {
      propertyId: { type: 'string', description: 'The property id.' },
      rowId: { type: 'string', description: 'The fee row id, from the fee-schedule lookup.' },
    },
    required: ['propertyId', 'rowId'],
    confirmFirst: true,
  },
  {
    id: 'set_late_fee_policy',
    audience: 'landlord', method: 'PUT',
    path: '/api/properties/:propertyId/late-fee-overrides',
    pathParams: ['propertyId'],
    description:
      'Set the late-fee policy for one KIND of unit at a property — RV spots on one rule, apartments ' +
      'on another. Use for "RV spots get no late fee" (send noLateFee true) or "$25 then $5 a day ' +
      'after five days".\n' +
      'Late fees are one of the few numbers a state actually caps, so before you set one, check it ' +
      'against the statute with your law tools and say what you found. accrualAmount, accrualType and ' +
      'accrualPeriod are one decision — send all three or none. capAmount and capType likewise.\n' +
      'Leases already signed keep their own stamped terms; this changes new ones.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      unitType: { type: 'string', description: 'apartment, single_family, rv_spot, campsite, mobile_home, hotel_room, storage, parking, boat_slip, land_lot, commercial' },
      noLateFee: { type: 'boolean', description: 'true means this kind of unit has no late fee at all. Send nothing else with it.' },
      graceDays: { type: 'integer', description: 'Days past due before a fee applies. 0 to 60.' },
      initialAmount: { type: 'number', description: 'The first fee.' },
      initialType: { type: 'string', description: 'flat or percent_of_rent.' },
      accrualAmount: { type: 'number', description: 'The recurring amount that follows the first fee.' },
      accrualType: { type: 'string', description: 'flat or percent_of_rent.' },
      accrualPeriod: { type: 'string', description: 'daily, weekly or monthly.' },
      accrualFrom: { type: 'string', description: 'Where the daily count starts: due_date_inclusive (default), due_date, or grace_end.' },
      capAmount: { type: 'number', description: 'The most the late fees can add up to.' },
      capType: { type: 'string', description: 'flat or percent_of_rent.' },
    },
    required: ['propertyId', 'unitType'],
    confirmFirst: true,
  },
  {
    id: 'remove_late_fee_policy',
    audience: 'landlord', method: 'DELETE',
    path: '/api/properties/:propertyId/late-fee-overrides/:unitType',
    pathParams: ['propertyId', 'unitType'],
    description:
      'Remove the late-fee policy for one kind of unit at a property. Without a policy that class has ' +
      'NO late fee — removing it is not the same as resetting it to a default, because there is no ' +
      'default. Say that before you do it.',
    params: {
      propertyId: { type: 'string', description: 'The property id.' },
      unitType: { type: 'string', description: 'The unit type whose policy is being removed.' },
    },
    required: ['propertyId', 'unitType'],
    confirmFirst: true,
  },
  {
    id: 'add_unit_subtype',
    audience: 'landlord', method: 'POST', path: '/api/properties/:propertyId/unit-subtypes',
    pathParams: ['propertyId'],
    description:
      'Create a unit subtype at a property — a named class of unit with its own layout and price, ' +
      'like "Back In / 50 amp" or "2 Bed / 1 Bath". Use for "all the pull-through spots are $650".\n' +
      'A subtype is the template new units of that class are stamped from, so getting the rent and ' +
      'deposit right here saves setting them one unit at a time. Facts that do not apply to the type ' +
      'are dropped — bedrooms on an RV spot, amp service on an apartment. For RV spots and mobile ' +
      'homes, dwellingOwnership is the difference between renting them the LOT and renting them the ' +
      'home on it, so ask which rather than assuming.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      unitType: { type: 'string', description: 'apartment, single_family, rv_spot, campsite, mobile_home, hotel_room, storage, parking, boat_slip, land_lot, commercial' },
      name: { type: 'string', description: 'What they call this class, in their words.' },
      bedrooms: { type: 'integer', description: 'Bedrooms, for a dwelling.' },
      bathrooms: { type: 'number', description: 'Bathrooms, for a dwelling.' },
      rvSiteLayout: { type: 'string', description: 'none, back_in or pull_through. RV spots only.' },
      rvAmpService: { type: 'string', description: 'none, 30, 50 or both. RV spots only.' },
      storageSize: { type: 'string', description: 'The size as they say it — "10x20". Storage only.' },
      rentAmount: { type: 'number', description: 'Monthly rent for this class.' },
      securityDeposit: { type: 'number', description: 'Standard deposit for this class.' },
      nightlyRate: { type: 'number', description: 'Nightly rate, where they rent by the night.' },
      weeklyRate: { type: 'number', description: 'Weekly rate.' },
      monthlyRate: { type: 'number', description: 'Monthly rate, where it differs from rent.' },
      dwellingOwnership: { type: 'string', description: 'landlord if they own the home on it, tenant if the tenant does. RV spots and mobile homes only.' },
    },
    required: ['propertyId', 'unitType', 'name'],
    confirmFirst: true,
  },
  {
    id: 'assign_units_to_subtype',
    audience: 'landlord', method: 'PUT',
    path: '/api/properties/:propertyId/unit-subtypes/:rowId/units',
    pathParams: ['propertyId', 'rowId'],
    description:
      'Say which existing units belong to a subtype. Use for "spots 20 through 36 are all pull-through ' +
      '50 amp". The list REPLACES whatever was linked before, so send every unit that belongs, not ' +
      'just the new ones.\n' +
      'By default this only classifies them. applyDetails true also REWRITES those units with the ' +
      'subtype\u2019s rent, deposit and layout — that overwrites what is on each unit today, so never ' +
      'set it without saying so and getting a yes to that specific thing.',
    params: {
      propertyId: { type: 'string', description: 'The property id.' },
      rowId: { type: 'string', description: 'The subtype id, from a lookup.' },
      unitIds: { type: 'array', description: 'Every unit id that belongs to this subtype. The list replaces the old one.' },
      applyDetails: { type: 'boolean', description: 'true to overwrite those units with the subtype\u2019s rent, deposit and layout.' },
    },
    required: ['propertyId', 'rowId', 'unitIds'],
    confirmFirst: true,
  },
  {
    id: 'remove_unit_subtype',
    audience: 'landlord', method: 'DELETE',
    path: '/api/properties/:propertyId/unit-subtypes/:rowId',
    pathParams: ['propertyId', 'rowId'],
    description:
      'Delete a unit subtype. Units that were created from it KEEP their rent, deposit and layout — ' +
      'they simply stop being classified. Nothing about a tenant or a lease changes.',
    params: {
      propertyId: { type: 'string', description: 'The property id.' },
      rowId: { type: 'string', description: 'The subtype id, from a lookup.' },
    },
    required: ['propertyId', 'rowId'],
    confirmFirst: true,
  },
  {
    id: 'update_unit_listing',
    audience: 'landlord', method: 'PATCH', path: '/api/properties/units/:unitId/listing',
    pathParams: ['unitId'],
    description:
      'Edit how a unit reads to somebody looking for a place — its description, the date it is ' +
      'available, and whether it shows as vacant on the listings. Use for "put 204 on the market from ' +
      'the first" or "rewrite the blurb, it still says new carpet".\n' +
      'Write the description in the landlord\u2019s voice about the unit they actually have. Never ' +
      'invent a feature — a listing is a representation somebody rents on.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      availableDate: { type: 'string', description: 'When it is available, as YYYY-MM-DD.' },
      listingDescription: { type: 'string', description: 'The listing text.' },
      listedVacant: { type: 'boolean', description: 'Whether it shows as available to rent.' },
      bedrooms: { type: 'integer', description: 'Bedrooms.' },
      bathrooms: { type: 'number', description: 'Bathrooms.' },
      sqft: { type: 'integer', description: 'Square feet.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'set_fee_payers',
    audience: 'landlord', method: 'PATCH', path: '/api/properties/:propertyId/allocation-rule',
    pathParams: ['propertyId'],
    description:
      'Set who covers the payment-processing fees at a property, and which bank account its payouts ' +
      'land in. Use for "we will eat the ACH fee at Oak Street".\n' +
      'Each payer is either landlord or tenant. Two things are NOT open: the card fee stays with the ' +
      'tenant, and the platform fee is always the landlord\u2019s. If they ask to move either, say so ' +
      'plainly rather than sending it and reporting a change that did not happen. The manual fee is ' +
      'the cash, check and money-order handling fee and it defaults to the tenant.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      achFeePayer: { type: 'string', description: 'landlord or tenant — who covers the bank-transfer fee.' },
      manualFeePayer: { type: 'string', description: 'landlord or tenant — who covers the cash, check and money-order fee.' },
      ownerBankAccountId: { type: 'string', description: 'The bank account this property pays out to, from a lookup. It must belong to the owner and be active.' },
    },
    required: ['propertyId'],
    confirmFirst: true,
  },
  {
    id: 'assign_property_manager',
    audience: 'landlord', method: 'PATCH', path: '/api/properties/:propertyId/manager',
    pathParams: ['propertyId'],
    description:
      'Put one of their own people in charge of a property day to day, or hand it back to themselves. ' +
      'Use for "Maria runs Sunset Palms now"; send userId as null to take it back.\n' +
      'This is a person on their team, not an outside management company — a company is ' +
      'invite_property_manager. The person must already have a manager scope covering that property, ' +
      'and the property must not be assigned to a management company. If either is not true the ' +
      'system says so; read that back rather than working around it.',
    params: {
      propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' },
      userId: { type: 'string', description: 'The team member\u2019s user id, or null to return the property to the owner.' },
    },
    required: ['propertyId', 'userId'],
    confirmFirst: true,
  },
  {
    id: 'close_property_onboarding',
    audience: 'landlord', method: 'POST', path: '/api/properties/:propertyId/onboarding-complete',
    pathParams: ['propertyId'],
    description:
      'Close the onboarding window on a property, once every sitting tenant has been entered. Use for ' +
      '"that park is fully loaded now".\n' +
      'This has a consequence worth saying out loud: while the window is open, tenants who were ' +
      'already living there can be brought on without a background check. After it closes, EVERY new ' +
      'tenant at that property has to screen. Do not close it if they still have people to enter.',
    params: { propertyId: { type: 'string', description: 'The property as the landlord refers to it — its NAME is fine ("Oak Park"). You do NOT need to look up an id first, and you must never ask them for one. A property id from a previous lookup also works.' } },
    required: ['propertyId'],
    confirmFirst: true,
  },
  // ── LANDLORD · the books (S628) ──────────────────────────────────────
  //
  // 23 endpoints. Nothing here MOVES money — GAM does not pay a landlord's
  // vendors and does not run their payroll through a bank. Every one of these
  // writes a RECORD, and the descriptions say so, because an agent that lets a
  // landlord believe a plumber was paid has done real damage with a true
  // sentence about a database row.
  {
    id: 'add_vendor',
    audience: 'landlord', method: 'POST', path: '/api/books/vendors',
    description:
      'Add a vendor to their books — a plumber, a landscaper, a supplier. Use for "set up Desert ' +
      'Plumbing so I can start putting their invoices in".\n' +
      'Everything here has to come from the landlord or from the vendor\u2019s own paperwork. NEVER ' +
      'invent an email, a phone number or a tax id to get the record to save — ask for what is ' +
      'missing. The tax id is an EIN (XX-XXXXXXX) or an SSN (XXX-XX-XXXX) and the system checks the ' +
      'shape, so read it back digit by digit if they said it out loud.',
    params: {
      name: { type: 'string', description: 'The business name.' },
      contactName: { type: 'string', description: 'The person they deal with there.' },
      email: { type: 'string', description: 'Their email.' },
      phone: { type: 'string', description: 'Their phone number.' },
      address: { type: 'string', description: 'Their address.' },
      category: { type: 'string', description: 'What they do — plumbing, landscaping, supplies.' },
      paymentTerms: { type: 'string', description: 'net15, net30, net45, net60, due_on_receipt, or cod.' },
      taxId: { type: 'string', description: 'EIN as XX-XXXXXXX or SSN as XXX-XX-XXXX.' },
      accountNumber: { type: 'string', description: 'The landlord\u2019s account number with that vendor, if there is one.' },
      notes: { type: 'string', description: 'Anything else worth keeping on the record.' },
    },
    required: ['name', 'contactName', 'email', 'phone', 'address', 'category', 'paymentTerms', 'taxId'],
    confirmFirst: true,
  },
  {
    id: 'update_vendor',
    audience: 'landlord', method: 'PATCH', path: '/api/books/vendors/:vendorId',
    pathParams: ['vendorId'],
    description:
      'Update a vendor on their books — new contact, new number, different terms, or mark them ' +
      'inactive when they stop using them. Use for "Desert Plumbing changed hands, new email is...". ' +
      'Only send what changed.',
    params: {
      vendorId: { type: 'string', description: 'The vendor id, from a lookup.' },
      name: { type: 'string', description: 'Business name.' },
      contactName: { type: 'string', description: 'Contact person.' },
      email: { type: 'string', description: 'Email.' },
      phone: { type: 'string', description: 'Phone.' },
      category: { type: 'string', description: 'What they do.' },
      paymentTerms: { type: 'string', description: 'net15, net30, net45, net60, due_on_receipt, or cod.' },
      status: { type: 'string', description: 'active or inactive.' },
      notes: { type: 'string', description: 'Notes on the record.' },
    },
    required: ['vendorId'],
    confirmFirst: true,
  },
  {
    id: 'record_bill',
    audience: 'landlord', method: 'POST', path: '/api/books/bills',
    description:
      'Enter a bill they have received but not yet paid, so it shows in what they owe. Use for "the ' +
      'roofer sent a $4,200 invoice, due the 15th".\n' +
      'This records a bill. It does NOT pay anybody and no money leaves anywhere. When it is paid, ' +
      'that is pay_bill, and that is also a record rather than a transfer. Attach the vendor when ' +
      'they name one, so the bill lands against what that vendor is owed instead of floating loose.',
    params: {
      date: { type: 'string', description: 'The date on the bill, YYYY-MM-DD.' },
      description: { type: 'string', description: 'What it is for, in their words.' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      vendorId: { type: 'string', description: 'The vendor id, from a lookup, when they named one.' },
      billNumber: { type: 'string', description: 'The invoice number on the bill.' },
      dueDate: { type: 'string', description: 'When it is due, YYYY-MM-DD.' },
      category: { type: 'string', description: 'How they categorise it.' },
      accountId: { type: 'string', description: 'The ledger account it posts to, from a lookup.' },
      notes: { type: 'string', description: 'Anything else about it.' },
    },
    required: ['date', 'description', 'amount'],
    confirmFirst: true,
  },
  {
    id: 'pay_bill',
    audience: 'landlord', method: 'POST', path: '/api/books/bills/:billId/pay',
    pathParams: ['billId'],
    description:
      'Record that a bill has been paid — in full, or a part payment. Use for "I sent the roofer ' +
      '$2,000 today".\n' +
      'This RECORDS the payment on their books. GAM does not send the money; they paid it, or they ' +
      'are about to. Never say the vendor has been paid by GAM.\n' +
      'Leave amount out to close the bill for whatever is left on it. If the amount is MORE than the ' +
      'bill has outstanding the system stops and tells you by how much — read that back and get an ' +
      'explicit yes before sending it again with acceptOverpayment true, because the extra becomes a ' +
      'credit sitting with that vendor rather than money on this bill.',
    params: {
      billId: { type: 'string', description: 'The bill id, from a lookup.' },
      amount: { type: 'number', description: 'How much was paid. Leave out to pay off the remaining balance.' },
      acceptOverpayment: { type: 'boolean', description: 'Only after the system flagged an overpayment and they said yes to it explicitly.' },
    },
    required: ['billId'],
    confirmFirst: true,
  },
  {
    id: 'record_book_transaction',
    audience: 'landlord', method: 'POST', path: '/api/books/transactions',
    description:
      'Put a cash transaction on the books that came from outside the platform — a cheque they wrote, ' +
      'a deposit made at the branch, a card charge on the business account. Use for "add a $180 ' +
      'hardware store run on the 3rd".\n' +
      'Rent a tenant paid THROUGH the platform is already on the books; adding it here counts it ' +
      'twice. If it is money that already came through GAM, say so rather than recording it.',
    params: {
      date: { type: 'string', description: 'When it happened, YYYY-MM-DD.' },
      description: { type: 'string', description: 'What it was, in their words.' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      type: { type: 'string', description: 'income or expense.' },
      category: { type: 'string', description: 'How they categorise it.' },
      accountId: { type: 'string', description: 'The ledger account it belongs to, from a lookup.' },
      reference: { type: 'string', description: 'Cheque number, confirmation number, receipt number.' },
    },
    required: ['date', 'description', 'amount', 'type'],
    confirmFirst: true,
  },
  {
    id: 'update_book_transaction',
    audience: 'landlord', method: 'PATCH', path: '/api/books/transactions/:txId',
    pathParams: ['txId'],
    description:
      'Fix a transaction on the books — a wrong date, a typo in the amount, the wrong category or ' +
      'the wrong account. Use for "that hardware run was $108, not $180".\n' +
      'Send every field you want it to end up with, not only the one that changed: category, account ' +
      'and reference are REPLACED by what you send, so leaving one out clears it.',
    params: {
      txId: { type: 'string', description: 'The transaction id, from a lookup.' },
      date: { type: 'string', description: 'YYYY-MM-DD.' },
      description: { type: 'string', description: 'What it was.' },
      amount: { type: 'number', description: 'How much.' },
      type: { type: 'string', description: 'income or expense.' },
      category: { type: 'string', description: 'Category. Omitting it clears it.' },
      accountId: { type: 'string', description: 'Ledger account id. Omitting it clears it.' },
      reference: { type: 'string', description: 'Reference. Omitting it clears it.' },
    },
    required: ['txId'],
    confirmFirst: true,
  },
  {
    id: 'reconcile_book_transaction',
    audience: 'landlord', method: 'PATCH', path: '/api/books/transactions/:txId/reconcile',
    pathParams: ['txId'],
    description:
      'Mark a transaction as reconciled — it has been matched against the bank statement and agreed. ' +
      'Use for "that one is confirmed, tick it off". This is a bookkeeping flag; it changes no ' +
      'amount and moves no money.',
    params: { txId: { type: 'string', description: 'The transaction id, from a lookup.' } },
    required: ['txId'],
  },
  {
    id: 'add_ledger_account',
    audience: 'landlord', method: 'POST', path: '/api/books/accounts',
    description:
      'Add an account to their chart of accounts. Use for "I want a separate line for pool ' +
      'maintenance".\n' +
      'The code has to be unique in their books and the type is what makes the reports come out ' +
      'right — asset, liability, equity, income or expense. If they are not sure which, ask what the ' +
      'account is FOR and work it out from that rather than guessing. If they have no chart at all ' +
      'yet, seed_chart_of_accounts gives them a standard one in one step.',
    params: {
      code: { type: 'string', description: 'The account number, e.g. 6120. Unique in their books.' },
      name: { type: 'string', description: 'What the account is called.' },
      type: { type: 'string', description: 'asset, liability, equity, income, or expense.' },
      subtype: { type: 'string', description: 'A narrower grouping, e.g. bank, current, fixed.' },
      description: { type: 'string', description: 'What belongs in it.' },
    },
    required: ['code', 'name', 'type'],
    confirmFirst: true,
  },
  {
    id: 'update_ledger_account',
    audience: 'landlord', method: 'PATCH', path: '/api/books/accounts/:accountId',
    pathParams: ['accountId'],
    description:
      'Rename a ledger account, change what it is for, or make it inactive. Use for "call 6120 ' +
      'Grounds instead of Landscaping". The code and the type cannot be changed here — a different ' +
      'type is a different account.',
    params: {
      accountId: { type: 'string', description: 'The account id, from a lookup.' },
      name: { type: 'string', description: 'New name.' },
      subtype: { type: 'string', description: 'New subtype.' },
      description: { type: 'string', description: 'What belongs in it.' },
      active: { type: 'boolean', description: 'false to stop it being used on new entries.' },
    },
    required: ['accountId'],
    confirmFirst: true,
  },
  {
    id: 'retire_ledger_account',
    audience: 'landlord', method: 'DELETE', path: '/api/books/accounts/:accountId',
    pathParams: ['accountId'],
    description:
      'Stop an account being used, when they no longer need it. It is marked inactive rather than ' +
      'deleted — everything already posted to it stays exactly where it is and the old reports do ' +
      'not change. Say that, because "delete the account" sounds like the history goes too.',
    params: { accountId: { type: 'string', description: 'The account id, from a lookup.' } },
    required: ['accountId'],
    confirmFirst: true,
  },
  {
    id: 'seed_chart_of_accounts',
    audience: 'landlord', method: 'POST', path: '/api/books/accounts/seed',
    description:
      'Give them a standard chart of accounts for a rental business in one step, when their books ' +
      'are empty. Use for "I have not set any of this up, just give me the normal one".\n' +
      'Offer this before walking somebody through adding accounts one at a time — it is the whole ' +
      'set, and they can rename anything afterwards.',
    params: {},
    required: [],
    confirmFirst: true,
  },
  {
    id: 'post_journal_entry',
    audience: 'landlord', method: 'POST', path: '/api/books/journal',
    description:
      'Post a manual journal entry. Use only when they are asking for one in accounting terms — an ' +
      'adjustment, a depreciation entry, a correction their accountant asked for.\n' +
      'This is real double-entry: every line names an account and either a debit or a credit, and the ' +
      'debits must equal the credits or the system refuses it. Do NOT invent which accounts an entry ' +
      'touches — read their chart of accounts first and read the lines back to them before posting. ' +
      'For an ordinary expense or a bill, use record_book_transaction or record_bill instead; those ' +
      'are what a landlord actually means nine times in ten.',
    params: {
      date: { type: 'string', description: 'The entry date, YYYY-MM-DD.' },
      description: { type: 'string', description: 'What the entry is for.' },
      lines: { type: 'array', description: 'The lines. Each is an object with accountId, an optional description, and debit and credit amounts. Total debits must equal total credits.' },
      reference: { type: 'string', description: 'A reference for the entry.' },
    },
    required: ['date', 'description', 'lines'],
    confirmFirst: true,
  },
  {
    id: 'void_journal_entry',
    audience: 'landlord', method: 'POST', path: '/api/books/journal/:entryId/void',
    pathParams: ['entryId'],
    description:
      'Void a journal entry that was wrong. The account balances it moved are put back, and the ' +
      'entry stays on the books marked voided rather than vanishing — the audit trail is the point. ' +
      'Use for "reverse that depreciation entry, it was for the wrong year".',
    params: { entryId: { type: 'string', description: 'The entry id, from a lookup.' } },
    required: ['entryId'],
    confirmFirst: true,
  },
  {
    id: 'add_employee',
    audience: 'landlord', method: 'POST', path: '/api/books/employees',
    description:
      'Add an employee to their payroll records — the maintenance tech, the office manager. Use for ' +
      '"put Danny on payroll at $22 an hour".\n' +
      'A payroll record needs ALL of this and the system refuses without it: name, email, phone, ' +
      'address, the last four of their SSN, how and how often they are paid, their filing status and ' +
      'federal allowances from their W-4, their state withholding percentage, their title, their ' +
      'department, and their start date. That is a lot to ask for in a chat, so if the landlord does ' +
      'not have it all to hand, say what is still needed rather than sending a half-filled record — ' +
      'and NEVER fill a gap yourself. A guessed withholding percentage is a wrong paycheque.\n' +
      'This is a PAYROLL RECORD. It does not give anybody a login or any access to the portal; that ' +
      'is a separate thing entirely and not something you do. Say so if they seem to expect it.',
    params: {
      firstName: { type: 'string', description: 'First name.' },
      lastName: { type: 'string', description: 'Last name.' },
      email: { type: 'string', description: 'Their email.' },
      phone: { type: 'string', description: 'Their phone number.' },
      address: { type: 'string', description: 'Their home address.' },
      ssnLast4: { type: 'string', description: 'The last four digits of their SSN — exactly four digits. Never guess these.' },
      payType: { type: 'string', description: 'hourly or salary.' },
      payRate: { type: 'number', description: 'Hourly rate, or annual salary for a salaried employee.' },
      payFrequency: { type: 'string', description: 'weekly, biweekly, semimonthly, or monthly.' },
      filingStatus: { type: 'string', description: 'single, married, or head_of_household — from their W-4.' },
      federalAllowances: { type: 'integer', description: 'Federal allowances from their W-4.' },
      stateWithholdingPct: { type: 'number', description: 'State withholding as a percentage. Their figure, never estimated.' },
      title: { type: 'string', description: 'Their job title.' },
      department: { type: 'string', description: 'Which department they are in.' },
      startDate: { type: 'string', description: 'When they started, YYYY-MM-DD.' },
    },
    required: ['firstName', 'lastName', 'email', 'phone', 'address', 'ssnLast4', 'payType',
               'payRate', 'payFrequency', 'filingStatus', 'federalAllowances',
               'stateWithholdingPct', 'title', 'department', 'startDate'],
    confirmFirst: true,
  },
  {
    id: 'update_employee',
    audience: 'landlord', method: 'PATCH', path: '/api/books/employees/:employeeId',
    pathParams: ['employeeId'],
    description:
      'Update an employee\u2019s payroll record — a raise, a new title, or marking them no longer ' +
      'active. Use for "Danny is going to $25 from the first". Only send what changed.',
    params: {
      employeeId: { type: 'string', description: 'The employee id, from a lookup.' },
      firstName: { type: 'string', description: 'First name.' },
      lastName: { type: 'string', description: 'Last name.' },
      email: { type: 'string', description: 'Email.' },
      title: { type: 'string', description: 'Job title.' },
      payType: { type: 'string', description: 'hourly or salary.' },
      payRate: { type: 'number', description: 'New rate or salary.' },
      status: { type: 'string', description: 'active or inactive.' },
      phone: { type: 'string', description: 'Phone number.' },
    },
    required: ['employeeId'],
    confirmFirst: true,
  },
  {
    id: 'add_contractor',
    audience: 'landlord', method: 'POST', path: '/api/books/contractors',
    description:
      'Add a 1099 contractor to their books — somebody they pay for work who is not an employee. Use ' +
      'for "add Jose, he does the yards, 1099".\n' +
      'The difference between a contractor and an employee is a tax question with real consequences, ' +
      'and it is theirs or their accountant\u2019s to answer, not yours. Record what they tell you; do ' +
      'not advise them on which one somebody is.\n' +
      'A name is required. If they have not given one, ask.',
    params: {
      name: { type: 'string', description: 'Their name or business name.' },
      email: { type: 'string', description: 'Email.' },
      phone: { type: 'string', description: 'Phone.' },
      taxId: { type: 'string', description: 'EIN or SSN, as it appears on their W-9.' },
      address: { type: 'string', description: 'Address.' },
      category: { type: 'string', description: 'What they do.' },
    },
    required: ['name'],
    confirmFirst: true,
  },
  {
    id: 'update_contractor',
    audience: 'landlord', method: 'PATCH', path: '/api/books/contractors/:contractorId',
    pathParams: ['contractorId'],
    description:
      'Update a 1099 contractor on their books — a new phone number, a new address, a different ' +
      'category of work, or marking them inactive when they stop using them. Use for "Jose has a ' +
      'new number" or "we do not use that landscaper any more".\n' +
      'Only send what changed. Marking somebody inactive does not remove them: what they were paid ' +
      'stays on the books, which is what their 1099 is built from.',
    params: {
      contractorId: { type: 'string', description: 'The contractor id, from a lookup.' },
      name: { type: 'string', description: 'Name.' },
      email: { type: 'string', description: 'Email.' },
      phone: { type: 'string', description: 'Phone.' },
      address: { type: 'string', description: 'Address.' },
      category: { type: 'string', description: 'What they do.' },
      status: { type: 'string', description: 'active or inactive.' },
    },
    required: ['contractorId'],
    confirmFirst: true,
  },
  {
    id: 'approve_payroll_run',
    audience: 'landlord', method: 'POST', path: '/api/books/payroll/runs/:runId/approve',
    pathParams: ['runId'],
    description:
      'Approve a payroll run that is sitting in draft. Use for "yes, approve the run for the period ' +
      'ending the 15th".\n' +
      'Approving posts the run to each employee\u2019s year-to-date figures — gross, withholding, net — ' +
      'which is what their W-2s are built from. It does NOT pay anybody: GAM does not send wages, and ' +
      'they still pay their people however they normally do. Read back the period, the pay date and ' +
      'the number of people on it before approving, and never approve a run you have not read.',
    params: { runId: { type: 'string', description: 'The payroll run id, from a lookup.' } },
    required: ['runId'],
    confirmFirst: true,
  },
  {
    id: 'void_payroll_run',
    audience: 'landlord', method: 'POST', path: '/api/books/payroll/runs/:runId/void',
    pathParams: ['runId'],
    description:
      'Void a payroll run. If it was already approved, the year-to-date figures it added to each ' +
      'employee are backed out again. Use for "kill that run, the hours were wrong". The run stays ' +
      'on the books marked voided.',
    params: { runId: { type: 'string', description: 'The payroll run id, from a lookup.' } },
    required: ['runId'],
    confirmFirst: true,
  },
  // ── LANDLORD · charging and forgiving (S628) ─────────────────────────
  //
  // "Waive Bob's late fee" was a question the landlord agent could explain and
  // not do. It is now two actions, deliberately separate: a credit forgives
  // money already billed and leaves both the charge and the forgiveness on the
  // record; a cancel withdraws a charge that has not been billed yet. GAM
  // never erases, so neither one makes anything disappear.
  {
    id: 'add_one_off_charge',
    audience: 'landlord', method: 'POST', path: '/api/one-off-charges',
    description:
      'Add a one-off charge to a tenant that will go on their next invoice — a lease violation, ' +
      'damage, a replacement, a service they asked for. Use for "charge 204 $120 for the screen door".\n' +
      'The reason is PRINTED ON THE TENANT\u2019S INVOICE, so write it as something they will read and ' +
      'understand — a charge nobody can explain is one nobody should be able to add. The internal ' +
      'note is only for the landlord. billOnOrAfter pushes it to a later cycle, which is what they ' +
      'want for a big repair somebody was warned about.\n' +
      'The tenant\u2019s live tenancy decides the unit and the lease, so all you need is who.',
    params: {
      tenantId: { type: 'string', description: 'The tenant id, from a lookup. Confirm the person and unit before charging.' },
      chargeType: { type: 'string', description: 'violation, damage, replacement, service, or other.' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      reason: { type: 'string', description: 'What it is for. The tenant reads this on their invoice.' },
      incidentDate: { type: 'string', description: 'When it happened, YYYY-MM-DD.' },
      internalNote: { type: 'string', description: 'Anything for the landlord\u2019s own record. The tenant does not see this.' },
      billOnOrAfter: { type: 'string', description: 'Hold it until this date, YYYY-MM-DD. Leave out to bill next cycle.' },
    },
    required: ['tenantId', 'chargeType', 'amount', 'reason', 'incidentDate'],
    confirmFirst: true,
  },
  {
    id: 'cancel_one_off_charge',
    audience: 'landlord', method: 'PATCH', path: '/api/one-off-charges/:chargeId/cancel',
    pathParams: ['chargeId'],
    description:
      'Withdraw a one-off charge before it reaches an invoice. Use for "drop that screen-door charge, ' +
      'it was already broken".\n' +
      'It is cancelled with a reason rather than deleted, so "why did this go away" always has an ' +
      'answer. A charge that has ALREADY been billed cannot be cancelled here — that one is unwound ' +
      'by crediting it (issue_tenant_credit), which leaves both the charge and the forgiveness on the ' +
      'record. If the system says it is already billed, say that and offer the credit instead.',
    params: {
      chargeId: { type: 'string', description: 'The charge id, from a lookup.' },
      reason: { type: 'string', description: 'Why it is being withdrawn.' },
    },
    required: ['chargeId'],
    confirmFirst: true,
  },
  {
    id: 'issue_tenant_credit',
    audience: 'landlord', method: 'POST', path: '/api/tenant-credits',
    description:
      'Credit a tenant\u2019s account — waive a late fee, make good on something, or apply a goodwill ' +
      'adjustment. Use for "waive Bob\u2019s late fee" or "knock $150 off for the week without hot water".\n' +
      'The credit lands on their OPEN BALANCE straight away, not at the next invoice. That matters: ' +
      'rent is pay-in-full, so a forgiven charge left sitting there would block them from paying ' +
      'anything at all. Anything the open charges do not use stays on the credit for next time.\n' +
      'This is the landlord\u2019s decision to make and yours to carry out — never suggest a waiver to a ' +
      'tenant and never imply one is coming. Read back who, how much and what for.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      amount: { type: 'number', description: 'How much to credit, in dollars.' },
      category: { type: 'string', description: 'What kind of credit it is — how the landlord would categorise it.' },
      reason: { type: 'string', description: 'Why, in their words.' },
    },
    required: ['leaseId', 'amount'],
    confirmFirst: true,
  },
  {
    id: 'void_tenant_credit',
    audience: 'landlord', method: 'POST', path: '/api/tenant-credits/:creditId/void',
    pathParams: ['creditId'],
    description:
      'Void what is left of a credit that was issued by mistake. Anything the credit has ALREADY been ' +
      'used against stays used — voiding does not claw back a charge it already settled, it only ' +
      'stops the remainder. Say that, because "cancel the credit" sounds like it undoes everything.',
    params: { creditId: { type: 'string', description: 'The credit id, from a lookup.' } },
    required: ['creditId'],
    confirmFirst: true,
  },

  // ── LANDLORD · the maintenance side of the business (S628) ────────────
  //
  // These are the permissions a maintenance worker or onsite manager actually
  // holds. The dispatcher forwards the caller's own claims, so a worker whose
  // account cannot approve a purchase is refused by requirePerm exactly as
  // they would be in the portal.
  {
    id: 'clock_in',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/shifts/clock-in',
    description:
      'Start the caller\u2019s own shift. Use for "clock me in". If they are already on a shift the ' +
      'system says so — tell them rather than starting a second one.',
    params: {},
    required: [],
  },
  {
    id: 'clock_out',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/shifts/clock-out',
    description:
      'End the caller\u2019s own shift. Use for "clock me out, done for the day". Their notes go on the ' +
      'shift record, so if they said what they got done, put it in.',
    params: { notes: { type: 'string', description: 'What they did on the shift, in their words.' } },
    required: [],
  },
  {
    id: 'create_daily_task',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/tasks',
    description:
      'Put a task on the board for the maintenance crew — one job, or something that repeats. Use ' +
      'for "have someone check the pool chemicals every morning".\n' +
      'This is the crew\u2019s own task list. It is NOT a tenant maintenance request: a tenant reporting ' +
      'a broken heater is a maintenance request, which has a tenant waiting on it and its own ' +
      'approval and cost trail. Do not put one of those here.',
    params: {
      title: { type: 'string', description: 'What needs doing, short.' },
      description: { type: 'string', description: 'The detail.' },
      assignedTo: { type: 'string', description: 'The user id of the person it goes to, from a lookup. Leave out for the whole crew.' },
      dueDate: { type: 'string', description: 'When it is due, YYYY-MM-DD.' },
      recurrence: { type: 'string', description: 'none, daily, weekly, or monthly.' },
    },
    required: ['title'],
    confirmFirst: true,
  },
  {
    id: 'complete_daily_task',
    audience: 'landlord', method: 'PATCH', path: '/api/maint-portal/tasks/:taskId/complete',
    pathParams: ['taskId'],
    description:
      'Mark a task on the maintenance crew\u2019s board as done, and record who finished it. Use for ' +
      '"the pool is done" or "Danny finished the gutters".\n' +
      'This is the crew\u2019s own task list, not a tenant\u2019s maintenance request — a tenant has ' +
      'somebody waiting on an answer, and completing one of those is a different action.',
    params: { taskId: { type: 'string', description: 'The task id, from a lookup.' } },
    required: ['taskId'],
  },
  {
    id: 'add_inventory_item',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/parts',
    description:
      'Add a part or a piece of equipment to inventory. Use for "add the new mower at Sunset Palms" ' +
      'or "we stock 40 of the 3/4 inch elbows".\n' +
      'Equipment lives AT a property, so put the property on it when they name one — without it the ' +
      'item only shows on the portfolio-wide list and nobody at the park can find it. minQuantity is ' +
      'the level that triggers a reorder, so it is worth asking.',
    params: {
      name: { type: 'string', description: 'What it is.' },
      propertyId: { type: 'string', description: 'The property it lives at, from a lookup.' },
      quantity: { type: 'number', description: 'How many on hand.' },
      minQuantity: { type: 'number', description: 'Reorder when it drops to this.' },
      unit: { type: 'string', description: 'each, box, foot — how they count it.' },
      location: { type: 'string', description: 'Where it is kept — "shop", "trailer".' },
      cost: { type: 'number', description: 'What one costs.' },
      sku: { type: 'string', description: 'Part or SKU number.' },
      description: { type: 'string', description: 'Anything else about it.' },
    },
    required: ['name'],
    confirmFirst: true,
  },
  {
    id: 'update_inventory_item',
    audience: 'landlord', method: 'PATCH', path: '/api/maint-portal/parts/:partId',
    pathParams: ['partId'],
    description:
      'Change a stocked item — most often the count after somebody used some, but also its price, ' +
      'where it is kept, or which property it lives at when equipment moves between parks. Use for ' +
      '"we are down to six elbows" or "the mower is at Oak Street now".\n' +
      'quantity is the count it should now BE, not the change. Say the number back.',
    params: {
      partId: { type: 'string', description: 'The item id, from a lookup.' },
      quantity: { type: 'number', description: 'The new count on hand — the total, not the difference.' },
      name: { type: 'string', description: 'What it is.' },
      minQuantity: { type: 'number', description: 'Reorder level.' },
      location: { type: 'string', description: 'Where it is kept.' },
      cost: { type: 'number', description: 'What one costs.' },
      sku: { type: 'string', description: 'Part or SKU number.' },
      description: { type: 'string', description: 'Description.' },
      unit: { type: 'string', description: 'How they count it.' },
      propertyId: { type: 'string', description: 'Move it to this property. Send null to unassign it.' },
    },
    required: ['partId'],
    confirmFirst: true,
  },
  {
    id: 'remove_inventory_item',
    audience: 'landlord', method: 'DELETE', path: '/api/maint-portal/parts/:partId',
    pathParams: ['partId'],
    description:
      'Take an item off the inventory list entirely — sold equipment, a part they no longer stock. ' +
      'Use for "the old mower is gone". To say they are simply out of something, set its quantity to ' +
      'zero instead; that keeps the item on the list so it can be reordered.',
    params: { partId: { type: 'string', description: 'The item id, from a lookup.' } },
    required: ['partId'],
    confirmFirst: true,
  },
  {
    id: 'request_purchase',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/purchases',
    description:
      'Raise a purchase request for parts or materials, so somebody with the authority can approve ' +
      'it. Use for "I need $340 of PVC to finish the line at spot 12".\n' +
      'This ASKS. It does not buy anything and does not release any money. Attach the work order when ' +
      'the spend belongs to a job, so the cost lands against it.',
    params: {
      items: { type: 'array', description: 'What is being bought — a list, each with what it is and how many.' },
      totalEstimate: { type: 'number', description: 'What they think it will come to.' },
      workOrderId: { type: 'string', description: 'The maintenance request this is for, from a lookup.' },
      notes: { type: 'string', description: 'Why it is needed.' },
    },
    required: ['items'],
    confirmFirst: true,
  },
  {
    id: 'approve_purchase_request',
    audience: 'landlord', method: 'PATCH', path: '/api/maint-portal/purchases/:purchaseId/approve',
    pathParams: ['purchaseId'],
    description:
      'Approve a purchase request the crew raised. Use for "go ahead on the PVC". A budget limit caps ' +
      'what they may spend against it, which is worth offering when the estimate was a guess.',
    params: {
      purchaseId: { type: 'string', description: 'The request id, from a lookup.' },
      budgetLimit: { type: 'number', description: 'The most they may spend on it.' },
    },
    required: ['purchaseId'],
    confirmFirst: true,
  },
  {
    id: 'deny_purchase_request',
    audience: 'landlord', method: 'PATCH', path: '/api/maint-portal/purchases/:purchaseId/deny',
    pathParams: ['purchaseId'],
    description:
      'Turn down a purchase request. Use for "no, that can wait until next month". Somebody is ' +
      'waiting on the answer, so offer to tell them why.',
    params: { purchaseId: { type: 'string', description: 'The request id, from a lookup.' } },
    required: ['purchaseId'],
    confirmFirst: true,
  },
  {
    id: 'schedule_recurring_maintenance',
    audience: 'landlord', method: 'POST', path: '/api/maint-portal/scheduled',
    description:
      'Set up maintenance that comes round on a schedule — filters, gutters, backflow tests, septic ' +
      'pumping. Use for "service the pumps every six months".\n' +
      'When it is completed the next date is worked out from the recurrence automatically, so this is ' +
      'set once and forgotten. Put it against a property, or a unit if it is that specific.',
    params: {
      title: { type: 'string', description: 'What gets done.' },
      recurrence: { type: 'string', description: 'weekly, monthly, quarterly, biannual, or annual.' },
      description: { type: 'string', description: 'What it involves.' },
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      unitId: { type: 'string', description: 'The unit, if it is unit-specific.' },
      assignedTo: { type: 'string', description: 'The user id it goes to, from a lookup.' },
      nextDue: { type: 'string', description: 'When it is next due, YYYY-MM-DD.' },
      estimatedHours: { type: 'number', description: 'How long it takes.' },
    },
    required: ['title', 'recurrence'],
    confirmFirst: true,
  },
  {
    id: 'complete_scheduled_maintenance',
    audience: 'landlord', method: 'PATCH', path: '/api/maint-portal/scheduled/:scheduledId/complete',
    pathParams: ['scheduledId'],
    description:
      'Mark a scheduled maintenance job done. The next due date rolls forward on its own from the ' +
      'recurrence, so tell them when it comes round again.',
    params: { scheduledId: { type: 'string', description: 'The scheduled job id, from a lookup.' } },
    required: ['scheduledId'],
  },
  // ── BOTH SIDES · telling GAM what is missing (S628) ──────────────────
  {
    id: 'submit_feature_request',
    audience: 'landlord', method: 'POST', path: '/api/feature-requests',
    description:
      'Send a feature request to the GAM team. Use whenever somebody says the software cannot do ' +
      'something they need — "there is no way to X", "it would be great if I could Y", "why can I ' +
      'not Z".\n' +
      'Offer this instead of leaving a dead end. When you have just told someone something is not ' +
      'possible, that is exactly the moment to ask whether they want it passed on. Write the ' +
      'description in THEIR words and include what they were trying to do, not a tidy summary — the ' +
      'problem is more useful to build from than the solution they proposed.',
    params: {
      title: { type: 'string', description: 'One line naming what they want.' },
      description: { type: 'string', description: 'What they were trying to do and why the software got in the way, in their words.' },
    },
    required: ['title', 'description'],
  },
  {
    id: 'send_feature_request',
    audience: 'tenant', method: 'POST', path: '/api/feature-requests',
    description:
      'Send a feature request to the GAM team, when the app itself cannot do something the tenant ' +
      'needs. Use for "there is no way to see my payment history" or "I wish I could get a receipt".\n' +
      'This is only for the SOFTWARE. Something about the property — a repair, the parking, the ' +
      'neighbours — is a maintenance request or a complaint for their landlord, and sending it here ' +
      'would file it where nobody who can fix it will ever read it.',
    params: {
      title: { type: 'string', description: 'One line naming what they want.' },
      description: { type: 'string', description: 'What they were trying to do, in their words.' },
    },
    required: ['title', 'description'],
  },

  // ── LANDLORD · smaller surfaces that had no action at all (S628) ──────
  {
    id: 'resolve_booking_change_request',
    audience: 'landlord', method: 'PATCH', path: '/api/bookings/change-requests/:requestId',
    pathParams: ['requestId'],
    description:
      'Approve or decline a guest\u2019s request to change their booking — different dates, a ' +
      'different length of stay. Use for "yes, let them move it to the 12th".\n' +
      'The guest has no account here, so nothing is sent to them automatically: whichever way it ' +
      'goes, the host tells the guest. Say that, and offer to draft the message.',
    params: {
      requestId: { type: 'string', description: 'The change-request id, from a lookup.' },
      status: { type: 'string', description: 'approved or declined.' },
    },
    required: ['requestId', 'status'],
    confirmFirst: true,
  },
  {
    id: 'set_home_owner',
    audience: 'landlord', method: 'PUT', path: '/api/home-ownerships/unit/:unitId',
    pathParams: ['unitId'],
    description:
      'Record who owns the home sitting on a lot — the park, the household living in it, or an ' +
      'outside investor. Use for "the trailer on 14 belongs to the Alvarez family now".\n' +
      'Name an existing account with ownerUserId when they have one; otherwise a name and an email ' +
      'creates a contact record for them, which is how an outside investor gets on the books without ' +
      'signing up for anything. Any previous owner is kept as history — this is a chain of title, not ' +
      'a field. That makes it worth getting right, so read the name and the unit back.',
    params: {
      unitId: { type: 'string', description: 'The unit the home sits on, from a lookup.' },
      ownerUserId: { type: 'string', description: 'The owner\u2019s existing account id, when they have one.' },
      ownerName: { type: 'string', description: 'The owner\u2019s name, when they have no account yet.' },
      ownerEmail: { type: 'string', description: 'The owner\u2019s email, when they have no account yet.' },
      acquiredVia: { type: 'string', description: 'How they came to own it — how the landlord describes it.' },
      saleDocumentId: { type: 'string', description: 'The signed document for the sale, if there is one.' },
      notes: { type: 'string', description: 'Anything else about the transfer.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_home_sale_contract',
    audience: 'landlord', method: 'POST', path: '/api/home-sales/:contractId/cancel',
    pathParams: ['contractId'],
    description:
      'Cancel a financed home-sale contract that is still running. Use for "the Alvarez sale fell ' +
      'through".\n' +
      'Cancelling stops the remaining installments. Installments already billed stay owed — GAM never ' +
      'erases, and the home does NOT become theirs, because the flip to tenant-owned happens on ' +
      'payoff. Say all three of those before you do it; "cancel the sale" sounds like it unwinds ' +
      'everything, and it does not.',
    params: { contractId: { type: 'string', description: 'The contract id, from a lookup.' } },
    required: ['contractId'],
    confirmFirst: true,
  },
  {
    id: 'record_bank_reconciliation',
    audience: 'landlord', method: 'POST', path: '/api/bank-reconciliations',
    description:
      'Save a bank reconciliation for a period — the statement balance they are reconciling to, and ' +
      'the dates it covers. Use for "reconcile March, the statement says $18,402.11".\n' +
      'The statement balance is the figure ON THEIR BANK STATEMENT. Never work it out for them and ' +
      'never round it: reconciling to a number nobody checked is worse than not reconciling.',
    params: {
      periodStart: { type: 'string', description: 'First day of the period, YYYY-MM-DD.' },
      periodEnd: { type: 'string', description: 'Last day of the period, YYYY-MM-DD.' },
      statementBalance: { type: 'number', description: 'The closing balance printed on their bank statement.' },
      accountId: { type: 'string', description: 'Which bank account, from a lookup, when they have more than one.' },
    },
    required: ['periodStart', 'periodEnd', 'statementBalance'],
    confirmFirst: true,
  },
  {
    id: 'rename_bank_account',
    audience: 'landlord', method: 'PATCH', path: '/api/bank-accounts/:accountId',
    pathParams: ['accountId'],
    description:
      'Rename one of their own bank accounts, so they can tell them apart. Use for "call that one ' +
      'Operating". This changes the LABEL only — nothing about the account itself. You cannot add a ' +
      'bank account or change its numbers; that is entered by them directly and never through you.',
    params: {
      accountId: { type: 'string', description: 'The bank account id, from a lookup.' },
      nickname: { type: 'string', description: 'What to call it.' },
    },
    required: ['accountId', 'nickname'],
  },
  {
    id: 'archive_bank_account',
    audience: 'landlord', method: 'POST', path: '/api/bank-accounts/:accountId/archive',
    pathParams: ['accountId'],
    description:
      'Archive one of their own bank accounts so it stops being offered. Use for "we closed that ' +
      'account".\n' +
      'Check first whether any property pays out to it — archiving the account a property pays into ' +
      'leaves that payout with nowhere to land. Say which properties use it before you archive it.',
    params: { accountId: { type: 'string', description: 'The bank account id, from a lookup.' } },
    required: ['accountId'],
    confirmFirst: true,
  },

  // ── LANDLORD · utility service agreements (S628) ──────────────────────
  {
    id: 'create_utility_service_agreement',
    audience: 'landlord', method: 'POST', path: '/api/utility/service-agreements',
    description:
      'Set up a utility service agreement — billing somebody for utilities on a space that is not a ' +
      'lease. The neighbour on the well, the shop on the shared meter, the cash-in-hand arrangement ' +
      'that predates GAM. Use for "bill the guy on the east well $40 a month".\n' +
      'Nothing is invoiced until the payer has agreed. Either they accept the invite themselves, or ' +
      'the landlord states on the record that they already agreed — payerAlreadyAgreed, with a note ' +
      'saying how they know. Do not set that flag on your own initiative; it is the landlord\u2019s ' +
      'statement to make and it is what makes the invoices legitimate. householdSize matters wherever ' +
      'a shared bill is split by headcount.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      label: { type: 'string', description: 'What the landlord calls that space. It shows on the invoice.' },
      payer: { type: 'object', description: 'Who pays: firstName, lastName, email and phone.' },
      serviceAddress: { type: 'string', description: 'The address being served, when it differs.' },
      note: { type: 'string', description: 'Anything about the arrangement.' },
      billingDueDay: { type: 'integer', description: 'Day of the month the invoice is due, 1-31.' },
      startDate: { type: 'string', description: 'When billing starts, YYYY-MM-DD.' },
      householdSize: { type: 'integer', description: 'How many people live there, for a headcount split.' },
      payerAlreadyAgreed: { type: 'boolean', description: 'Only when the landlord states they already agreed. Their statement, not your assumption.' },
      payerAgreementNote: { type: 'string', description: 'How the landlord knows they agreed.' },
    },
    required: ['propertyId', 'label', 'payer'],
    confirmFirst: true,
  },
  {
    id: 'update_utility_service_agreement',
    audience: 'landlord', method: 'PATCH', path: '/api/utility/service-agreements/:agreementId',
    pathParams: ['agreementId'],
    description:
      'Change a utility service agreement — the due day, the service address, a note, or end it. Use ' +
      'for "the east well guy moved out on the 3rd".\n' +
      'Ending it stops FUTURE invoices. Anything already billed stays owed; an unpaid balance does ' +
      'not vanish because the arrangement did. Send the end date with it, or the billing window has ' +
      'no close.',
    params: {
      agreementId: { type: 'string', description: 'The agreement id, from a lookup.' },
      status: { type: 'string', description: 'active or ended.' },
      endDate: { type: 'string', description: 'When it ends, YYYY-MM-DD. Send this whenever ending it.' },
      billingDueDay: { type: 'integer', description: 'Day of the month invoices are due, 1-31.' },
      serviceAddress: { type: 'string', description: 'The address being served.' },
      note: { type: 'string', description: 'A note on the arrangement.' },
      payerAlreadyAgreed: { type: 'boolean', description: 'The landlord stating, after the fact, that the payer agreed.' },
      payerAgreementNote: { type: 'string', description: 'How they know.' },
    },
    required: ['agreementId'],
    confirmFirst: true,
  },
  {
    id: 'give_utility_moveout_notice',
    audience: 'tenant', method: 'POST', path: '/api/utility/service-agreements/mine/moveout-notice',
    description:
      'Tell the landlord the payer is moving out and needs a final utility bill. Use for "I am out on ' +
      'the 30th, I need my last bill".\n' +
      'This is a NOTICE, not the end of the service. The landlord still has to take the final ' +
      'reading and close the period, so say that: their billing does not stop the moment they press ' +
      'this, and they will still owe whatever the final reading comes to.',
    params: {
      expectedOn: { type: 'string', description: 'The date they expect to be out, YYYY-MM-DD.' },
      note: { type: 'string', description: 'Anything they want the landlord to know.' },
    },
    required: ['expectedOn'],
    confirmFirst: true,
  },

  // ── TENANT · their own screening (S628) ──────────────────────────────
  {
    id: 'cancel_my_screening',
    audience: 'tenant', method: 'POST', path: '/api/background/:checkId/cancel',
    pathParams: ['checkId'],
    description:
      'Cancel a background check the tenant started and no longer wants. Use for "I found somewhere ' +
      'else, cancel it".\n' +
      'Nothing was delivered, so what they paid is refunded in full. Only a check still in progress ' +
      'can be cancelled — one that has already come back cannot, and if the system says so, tell ' +
      'them that rather than trying again.',
    params: { checkId: { type: 'string', description: 'The check id, from their screening status.' } },
    required: ['checkId'],
    confirmFirst: true,
  },
  {
    id: 'withdraw_from_renter_pool',
    audience: 'tenant', method: 'POST', path: '/api/background/pool/withdraw',
    description:
      'Take the tenant out of the renter pool, so landlords stop being able to reach them through ' +
      'it. Use for "stop sending my details to landlords" or "I found a place".\n' +
      'Withdrawing does not undo a landlord who already got in touch, and it does not delete their ' +
      'screening — it stops NEW landlords finding them. Say that plainly.',
    params: {},
    required: [],
    confirmFirst: true,
  },
  // ── LANDLORD · getting a tenant onto the platform (S628) ─────────────
  //
  // The invite is the single highest-traffic thing a landlord does and it had
  // no action. It had no TESTS either — tenantInvite.test.ts pins the route
  // first, per the S627 handoff, and writing them found that the invite email
  // was never sent at all.
  {
    id: 'invite_tenant',
    audience: 'landlord', method: 'POST', path: '/api/tenants/invite',
    description:
      'Invite somebody to the tenant portal. Use for "send an invite to Nadia for 204" or "invite the ' +
      'Reyes family to apply".\n' +
      'There are TWO shapes and the difference matters to the person receiving it. Give a PROPERTY ' +
      'and they are a prospective applicant: they set a password and complete a background check, and ' +
      'a unit is assigned later when the lease is drawn. Give a UNIT and they are going into that ' +
      'unit: no application, straight to activating their account and signing.\n' +
      'If the landlord has not said which they mean, ASK — do not pick. Sending an applicant invite ' +
      'to somebody already living there puts a background check in front of a sitting resident, and ' +
      'sending a unit invite to an applicant skips the screening the landlord wanted.\n' +
      'They get an email with a link that expires in seven days. Invite one person at a time and ' +
      'invite the person who holds the lease FIRST — the order is kept, and the first one invited is ' +
      'the primary resident.',
    params: {
      email: { type: 'string', description: 'Their email. Read it back before sending — a typo goes to a stranger.' },
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their last name.' },
      phone: { type: 'string', description: 'Their phone number, if the landlord has it.' },
      propertyId: { type: 'string', description: 'For an APPLICANT who will be screened. The property id, from a lookup.' },
      unitId: { type: 'string', description: 'For somebody going into a specific unit with no screening. The unit id, from a lookup.' },
    },
    required: ['email', 'firstName'],
    confirmFirst: true,
  },
  {
    id: 'waive_screening',
    audience: 'landlord', method: 'POST', path: '/api/tenants/:tenantId/waive-screening',
    pathParams: ['tenantId'],
    description:
      'Bring a SITTING tenant onto the platform without a background check, during a property\u2019s ' +
      'onboarding window. Use for "the Alvarez family have lived in 12 for six years, they do not ' +
      'need screening".\n' +
      'This is NOT a skip-screening switch. It only works while that property\u2019s onboarding window is ' +
      'open, only for somebody already living in the unit, and only on the landlord\u2019s attestation ' +
      'that they are an existing resident — which is recorded with their name against it. Ask them to ' +
      'confirm that in so many words before you set attested; do not set it because it seemed implied. ' +
      'Once the window closes, every new applicant screens and this stops working.',
    params: {
      tenantId: { type: 'string', description: 'The tenant id, from a lookup.' },
      propertyId: { type: 'string', description: 'The property they live at, from a lookup.' },
      unitId: { type: 'string', description: 'The unit they occupy, from a lookup. It must be at that property.' },
      attested: { type: 'boolean', description: 'The landlord\u2019s own statement that this person already lives there. Only true after they say so explicitly.' },
    },
    required: ['tenantId', 'propertyId', 'unitId', 'attested'],
    confirmFirst: true,
  },

  // ── TENANT · their own account and the products offered to them ──────
  {
    id: 'update_my_profile',
    audience: 'tenant', method: 'PATCH', path: '/api/tenants/profile',
    description:
      'Update the tenant\u2019s own contact details — their phone number, their email, a short bio. Use ' +
      'for "my new number is..." .\n' +
      'Changing their EMAIL changes what they sign in with, so read the new address back character by ' +
      'character and get a yes before sending it. If that address already belongs to another account ' +
      'the system refuses it; say so rather than trying a variation.',
    params: {
      phone: { type: 'string', description: 'Their phone number.' },
      email: { type: 'string', description: 'Their email — this is also their sign-in. Confirm it before changing it.' },
      bio: { type: 'string', description: 'A short bio for their profile.' },
    },
    required: [],
    confirmFirst: true,
  },
  // S637: `nudge_landlord_banking` removed. It described the landlord's bank
  // setup to the tenant and blamed it for a payment failure that does not
  // happen — rent collects to GAM's platform balance when Connect is not ready
  // (routes/payments.ts:389). Nic (DIRECTIVE): "I don't want any forward facing
  // messages that tell them anything about our bank account." The endpoint it
  // called is deleted too; see routes/tenants.ts.
  {
    id: 'answer_income_questionnaire',
    audience: 'tenant', method: 'POST', path: '/api/tenants/questionnaires/:questionnaireId/answer',
    pathParams: ['questionnaireId'],
    description:
      'Record the tenant\u2019s answers to a questionnaire about how their income arrives — which ' +
      'programme pays them, on what day, and whether they want to hear more. Use when they answer ' +
      'those questions in the conversation.\n' +
      'These are THEIR answers about their own money, so put down what they said and nothing you ' +
      'worked out. If they did not name the day their benefit lands, do not derive it — ask. Saying ' +
      'they are interested files a request; make sure that is what they meant.',
    params: {
      questionnaireId: { type: 'string', description: 'The questionnaire id, from their notifications.' },
      incomeSource: { type: 'string', description: 'ssi, ssdi, other_fixed, or none — as they described it.' },
      interested: { type: 'boolean', description: 'Whether they want to hear more. Only true if they said so.' },
      benefitSchedule: { type: 'string', description: 'The pattern their benefit pays on: ssi_day_1, ssdi_day_3, ssdi_wed_2, ssdi_wed_3, ssdi_wed_4, or fixed_day.' },
      benefitDay: { type: 'integer', description: 'The day of the month it lands, 1-28, for a fixed day.' },
    },
    required: ['questionnaireId', 'incomeSource', 'interested'],
    confirmFirst: true,
  },
  {
    id: 'dismiss_questionnaire',
    audience: 'tenant', method: 'POST', path: '/api/tenants/questionnaires/:questionnaireId/dismiss',
    pathParams: ['questionnaireId'],
    description:
      'Put a questionnaire away when the tenant does not want to answer it. Use for "I am not ' +
      'interested" or "stop asking me". Do it and let it go — do not ask why and do not offer it ' +
      'again in the same conversation.',
    params: { questionnaireId: { type: 'string', description: 'The questionnaire id.' } },
    required: ['questionnaireId'],
  },
  {
    id: 'register_flexpay_interest',
    audience: 'tenant', method: 'POST', path: '/api/tenants/flexpay/inquiry',
    description:
      'File the tenant\u2019s interest in FlexPay, which moves their rent due date to line up with the ' +
      'day their income actually arrives. Use for "my cheque comes on the 3rd and rent is due on the ' +
      '1st" or "can I pay later in the month".\n' +
      'This REQUESTS it. It does not enrol them, it does not change anything about this month\u2019s ' +
      'rent, and it is reviewed before anything happens — say all three, because someone who thinks ' +
      'their due date just moved will not pay on the 1st.\n' +
      'benefitSchedule is the PATTERN their income pays on, which is better than a bare day; take the ' +
      'day only when the pattern does not fit. If they already have a request on file the system says ' +
      'so, and that is the answer.',
    params: {
      incomeSource: { type: 'string', description: 'ssi, ssdi, other_fixed, or none — how they described their income.' },
      benefitSchedule: { type: 'string', description: 'ssi_day_1, ssdi_day_3, ssdi_wed_2, ssdi_wed_3, ssdi_wed_4, or fixed_day.' },
      benefitDay: { type: 'integer', description: 'The day of the month it lands, 1-28.' },
      note: { type: 'string', description: 'Anything they want to add, in their words.' },
    },
    required: ['incomeSource'],
    confirmFirst: true,
  },
  {
    id: 'change_flexpay_pull_day',
    audience: 'tenant', method: 'PATCH', path: '/api/tenants/flexpay/pull-day',
    description:
      'Change the day FlexPay pulls from the tenant\u2019s account. Use for "my benefit moved to the 5th".\n' +
      'It takes effect NEXT cycle — this month is already set and does not move. The fee is worked ' +
      'out from the new day, so read back both the day and what it will cost from next cycle before ' +
      'you send it.',
    params: { pullDay: { type: 'integer', description: 'The day of the month to pull, 1-28.' } },
    required: ['pullDay'],
    confirmFirst: true,
  },
  {
    id: 'cancel_flexpay',
    audience: 'tenant', method: 'DELETE', path: '/api/tenants/flexpay',
    description:
      'Cancel FlexPay for the tenant. Use for "I do not need this any more".\n' +
      'Say what it means before you do it: from the next cycle their rent is due on the ordinary due ' +
      'date again, and anything already advanced this cycle still has to be settled. Leaving should ' +
      'be easy, so do not argue with them or pitch it back — do it, and tell them what changes.',
    params: {},
    required: [],
    confirmFirst: true,
  },
  {
    id: 'cancel_flexdeposit',
    audience: 'tenant', method: 'DELETE', path: '/api/tenants/flexdeposit',
    description:
      'Cancel the tenant\u2019s FlexDeposit instalment plan. Use for "I would rather just pay the deposit ' +
      'outright".\n' +
      'Cancelling stops the remaining instalments. It does NOT refund what they have already paid in ' +
      'and it does NOT reduce the deposit they owe — the balance becomes due the ordinary way. Say ' +
      'that plainly first; somebody who hears "cancelled" and expects money back will be angry later.',
    params: {},
    required: [],
    confirmFirst: true,
  },
  {
    id: 'register_flexcredit_interest',
    audience: 'tenant', method: 'POST', path: '/api/tenants/flexcredit/inquiry',
    description:
      'File the tenant\u2019s interest in having their rent payments reported to the credit bureaus. Use ' +
      'for "does paying rent help my credit?" when they say they want it.\n' +
      'This records interest only. Nothing is reported and nothing about their credit changes — do ' +
      'not tell them their rent is now being reported. If the answer comes back saying it is not ' +
      'available, tell them that honestly rather than implying they are on a list.',
    params: {},
    required: [],
  },
  // ── TENANT · paying (S628) ───────────────────────────────────────────
  //
  // Nic, asked directly whether the agent should be able to pull the money:
  // yes, with a read-back. The agent already sets up autopay, which moves the
  // same money on a schedule and needed the same care; doing it once on
  // request is not a bigger step than agreeing to do it every month.
  //
  // The read-back is not a formality. Rent is pay-in-full platform-wide, the
  // processing fee depends on the METHOD and on who the property makes pay it,
  // and a card carries a surcharge a bank transfer does not. So there are two
  // actions here on purpose: the quote works out the real total and moves
  // nothing, and the payment is what happens after they have heard it.
  {
    id: 'get_payment_quote',
    audience: 'tenant', method: 'POST', path: '/api/payments/quote',
    description:
      'Work out what a payment will ACTUALLY cost before charging anything — the rent plus the ' +
      'processing fee, for the method they are about to use. Nothing is charged and no money moves.\n' +
      'Call this BEFORE pay_my_balance, every time, and read the total back. The fee is not the same ' +
      'on both methods and it is not always the tenant\u2019s to pay — some properties cover the bank ' +
      'fee, none of them cover the card one. A tenant who is told "$1,200" and is charged $1,242.55 ' +
      'has been misled by you, not by the property.',
    params: {
      amount: { type: 'number', description: 'The rent amount they are paying, before any fee.' },
      method: { type: 'string', description: 'ach for a bank transfer, card for a card.' },
      leaseId: { type: 'string', description: 'Their lease id, from get_my_lease. Without it the fee is estimated as tenant-paid.' },
    },
    required: ['amount', 'method'],
  },
  {
    id: 'pay_my_balance',
    audience: 'tenant', method: 'POST', path: '/api/payments/pay-balance',
    description:
      'Charge the tenant\u2019s saved payment method and settle what they owe on their lease. Use when ' +
      'they ask to pay — "pay my rent", "take it off my card", "let us get that sorted".\n' +
      'BEFORE YOU CALL THIS, all four:\n' +
      '  1. get_my_balance_breakdown, so the amount is theirs and not one you carried over from ' +
      'earlier in the conversation.\n' +
      '  2. get_my_payment_methods, and use the id of one that is chargeable. A bank still waiting on ' +
      'verification cannot be charged, however recently they linked it.\n' +
      '  3. get_payment_quote for that exact amount and method.\n' +
      '  4. Say the total out loud — the rent, the fee, the method by its last four digits — and get ' +
      'a plain yes. Not an "ok thanks", not a yes to something else two turns ago.\n' +
      'Rent is pay-in-full: a part payment is not accepted, so if they cannot cover it, say so and ' +
      'talk about what can be done rather than sending a charge that will be refused. Leave leaseId ' +
      'out unless they hold more than one lease; each lease is paid as its own charge.\n' +
      'A bank transfer takes days to clear. It is paid the moment it goes through here — do NOT tell ' +
      'them it has landed with their landlord, and do NOT charge it a second time because it still ' +
      'reads as processing.',
    params: {
      amount: { type: 'number', description: 'How much to charge, from their balance — the full amount owed.' },
      paymentMethodId: { type: 'string', description: 'The id of the saved method to charge, from get_my_payment_methods. It must be one that is chargeable.' },
      paymentMethodType: { type: 'string', description: 'ach or card — matching the method you chose.' },
      leaseId: { type: 'string', description: 'Which lease, only when they hold more than one.' },
      serviceAgreementId: { type: 'string', description: 'For a utility-only payer with no lease, settling their whole bill.' },
    },
    required: ['amount', 'paymentMethodId', 'paymentMethodType'],
    confirmFirst: true,
  },
  // ── LANDLORD · the unit itself (S628) ────────────────────────────────
  //
  // update_unit already covered rent, deposit and size. Everything a unit
  // actually IS lives on four other routes, split by concern — its number, its
  // type and rates, how it is occupied, what utilities the tenant carries.
  {
    id: 'renumber_unit',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/number',
    pathParams: ['unitId'],
    description:
      'Change a unit\u2019s number or name, so it matches the signage on the ground. Use for "spot 14 is ' +
      'actually 14A" or "they renumbered the whole back row".\n' +
      'The number is how everybody refers to the unit — the tenant, the crew, the ledger — so read ' +
      'back the old one and the new one together. If another unit at that property already has the ' +
      'number, the system refuses it; that refusal is right and means they have two units in mind.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      unitNumber: { type: 'string', description: 'The new number or name, as it reads on the ground.' },
    },
    required: ['unitId', 'unitNumber'],
    confirmFirst: true,
  },
  {
    id: 'set_unit_type_and_rates',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/type',
    pathParams: ['unitId'],
    description:
      'Set what KIND of unit this is and what it rents for by the night, week or month — plus the ' +
      'things that only matter for that kind: RV layout and amp service, whether the home on the lot ' +
      'is theirs or the tenant\u2019s, stay lengths, check-in and check-out times, and whether it can be ' +
      'booked at all. Use for "spot 12 is a pull-through 50 amp, $65 a night".\n' +
      'dwellingOwnership is the difference between renting somebody the LOT and renting them the home ' +
      'standing on it — never assume which, and it changes what the tenant is responsible for. ' +
      'isBookable false takes the unit off the booking site without changing anything else.\n' +
      'Only send what they actually told you.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      unitType: { type: 'string', description: 'apartment, single_family, rv_spot, campsite, mobile_home, hotel_room, storage, parking, boat_slip, land_lot, commercial' },
      nightlyRate: { type: 'number', description: 'Nightly rate.' },
      weeklyRate: { type: 'number', description: 'Weekly rate.' },
      monthlyRate: { type: 'number', description: 'Monthly rate.' },
      minStayNights: { type: 'integer', description: 'Shortest stay allowed.' },
      maxStayNights: { type: 'integer', description: 'Longest stay allowed.' },
      checkInTime: { type: 'string', description: 'Check-in time, e.g. 15:00.' },
      checkOutTime: { type: 'string', description: 'Check-out time, e.g. 11:00.' },
      isBookable: { type: 'boolean', description: 'Whether it can be booked at all.' },
      rvSiteLayout: { type: 'string', description: 'none, back_in or pull_through. RV spots only.' },
      rvAmpService: { type: 'string', description: 'none, 30, 50 or both. RV spots only.' },
      dwellingOwnership: { type: 'string', description: 'landlord if the park owns the home on it, tenant if the tenant does.' },
      lotRentAmount: { type: 'number', description: 'The lot rent, where the tenant owns the home.' },
      unitDescription: { type: 'string', description: 'How the unit reads to somebody booking it.' },
      isMultiLevel: { type: 'boolean', description: 'Whether it has more than one level.' },
      isAdaAccessible: { type: 'boolean', description: 'Whether it is ADA accessible.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'set_unit_occupancy_mode',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/occupancy-mode',
    pathParams: ['unitId'],
    description:
      'Switch a unit between being let as ONE place on one lease (whole_unit) and being let room by ' +
      'room on separate leases (by_room). Use for "I am renting the four bedrooms separately now".\n' +
      'This changes how every lease on the unit works, so say what it means before you send it. A ' +
      'unit that already carries more than one active lease cannot go back to whole_unit until all ' +
      'but one of those leases has ended — the system says so, and it is not something to work around.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      occupancyMode: { type: 'string', description: 'whole_unit or by_room.' },
    },
    required: ['unitId', 'occupancyMode'],
    confirmFirst: true,
  },
  {
    id: 'set_unit_subtype',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/subtype',
    pathParams: ['unitId'],
    description:
      'Put one unit into a subtype, or take it out with subtypeId null. Use for "spot 12 is one of ' +
      'the pull-through 50 amps".\n' +
      'By default this only classifies it. applyDetails true also OVERWRITES that unit with the ' +
      'subtype\u2019s rent, deposit and layout — say so and get a yes to that specific thing. A retired ' +
      'unit keeps the details it was retired with and cannot be changed.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      subtypeId: { type: 'string', description: 'The subtype id, or null to take it out of one.' },
      applyDetails: { type: 'boolean', description: 'true to overwrite the unit with the subtype\u2019s rent, deposit and layout.' },
    },
    required: ['unitId', 'subtypeId'],
    confirmFirst: true,
  },
  {
    id: 'set_utility_responsibility',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/utility-responsibility',
    pathParams: ['unitId'],
    description:
      'Say whether the TENANT or the LANDLORD carries a given utility at a unit — water, electric, ' +
      'gas, trash, sewer. Use for "the tenant pays their own power at 204".\n' +
      'This decides who gets billed for it, so it is a money decision and not a label. Do one utility ' +
      'per call and read back which one and which way round. If the system refuses because there is ' +
      'billing already running on it, that is the answer — say so rather than trying again.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      utilityType: { type: 'string', description: 'Which utility — water, electric, gas, trash, sewer, and so on.' },
      tenantResponsible: { type: 'boolean', description: 'true if the tenant carries it, false if the landlord does.' },
      note: { type: 'string', description: 'Anything about the arrangement.' },
    },
    required: ['unitId', 'utilityType', 'tenantResponsible'],
    confirmFirst: true,
  },
  {
    id: 'mark_unit_available',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/mark-available',
    pathParams: ['unitId'],
    description:
      'Put a vacant unit on the market. Use for "204 is ready, list it". It only works from vacant — ' +
      'a unit that is still occupied or being turned has to get there first, and the system will say ' +
      'which state it is actually in.',
    params: { unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' } },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'mark_unit_vacant',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/mark-vacant',
    pathParams: ['unitId'],
    description:
      'Take a unit back OFF the market, from available to vacant. Use for "hold 204, I want to redo ' +
      'the floors first". It only works from available.',
    params: { unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' } },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'activate_unit',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/activate',
    pathParams: ['unitId'],
    description:
      'Make a unit live, so it starts billing. Use for "the Alvarez lease starts on the first, turn ' +
      'that unit on".\n' +
      'This is when the unit starts costing the landlord the monthly platform fee, so say that. It ' +
      'needs a rent amount and an active lease first; without either the system refuses and tells you ' +
      'which is missing. scheduledFor turns it on at a future moment instead of now — use it when the ' +
      'lease starts later, so nobody pays for a month nobody was living there.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      scheduledFor: { type: 'string', description: 'A future date and time to turn it on, in full ISO form. Must be in the future.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_scheduled_activation',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/cancel-scheduled-activation',
    pathParams: ['unitId'],
    description:
      'Call off an activation that was scheduled for later. Use for "the move-in fell through, do not ' +
      'turn 204 on". If nothing is scheduled the system says so, which usually means the unit is ' +
      'already live and they meant something else — ask.',
    params: { unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' } },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'set_eviction_mode',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/eviction-mode',
    pathParams: ['unitId'],
    description:
      'Turn eviction mode on or off for a unit. Use ONLY when the landlord says in so many words that ' +
      'they are evicting, or that they are stopping one.\n' +
      'Eviction mode PAUSES every payment to the landlord from that unit, because accepting rent ' +
      'during an eviction can reset the eviction clock in many states and undo the filing. Read that ' +
      'consequence back in plain words and get an explicit yes to it — confirm exists so nobody ' +
      'switches this on in passing. Turning it OFF lets payments through again.\n' +
      'You are not advising them on whether to evict, and you do not tell them what their state ' +
      'requires. That is their lawyer\u2019s. If they ask whether they can evict, that is a legal ' +
      'question and it escalates.\n' +
      'S630 (Nic): once it is on, ALSO tell them that turning it on in GAM is not legal service — ' +
      'depending on where the property is, a notice affecting a tenancy may have to be handed over ' +
      'in person or sent by certified mail to count, and they should check their local ' +
      'requirements. Generic only; never name a state\u2019s rule.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      enable: { type: 'boolean', description: 'true to start eviction mode, false to end it.' },
      confirm: { type: 'boolean', description: 'Must be true. Only after they have heard that payments to them stop, and said yes to that.' },
    },
    required: ['unitId', 'enable', 'confirm'],
    confirmFirst: true,
  },
  // ── LANDLORD · the lease (S628) ──────────────────────────────────────
  {
    id: 'update_lease',
    audience: 'landlord', method: 'PATCH', path: '/api/leases/:leaseId',
    pathParams: ['leaseId'],
    description:
      'Change the money and the term on an existing lease — rent, deposit, the dates, the notice ' +
      'period, and this lease\u2019s own late-fee terms. Use for "their rent goes to $1,050 in March" or ' +
      '"push the end date to the 30th".\n' +
      'This is a SIGNED AGREEMENT. Changing what it says is not the same as agreeing it with the ' +
      'tenant, and a rent figure the tenant never agreed to is not enforceable however it reads in ' +
      'the system. If the change is one both sides need to sign, that is an addendum — say so. S630 (Nic): A RENT INCREASE TAKES EFFECT AT RENEWAL, not whenever the landlord says — a fixed term holds the rent it was signed at until it ends. So before touching rent: work out WHICH unit they mean (a "12" can be an RV spot and an apartment at the same park), read the actual lease, and tell them the soonest the new figure could start, which is its end date. Sooner than that needs an addendum both sides sign.\n' +
      'Who is ON the lease cannot be changed here at all; that goes through the e-sign addendum flow. ' +
      'Setting status to terminated or expired ENDS the tenancy: every tenant comes off it and the ' +
      'unit goes vacant. Never do that as part of some other edit.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      rentAmount: { type: 'number', description: 'New monthly rent.' },
      securityDeposit: { type: 'number', description: 'New deposit amount.' },
      startDate: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
      endDate: { type: 'string', description: 'End date, YYYY-MM-DD, or null for open-ended.' },
      status: { type: 'string', description: 'active, pending, expired or terminated. The last two END the tenancy.' },
      leaseType: { type: 'string', description: 'month_to_month, fixed_term, or nnn_commercial.' },
      noticeDaysRequired: { type: 'string', description: 'How many days notice either side must give.' },
      expirationNoticeDays: { type: 'string', description: 'How many days before expiry notice is due.' },
      lateFeeEnabled: { type: 'boolean', description: 'Whether late fees apply on this lease.' },
      lateFeeGraceDays: { type: 'integer', description: 'Days past due before a fee applies.' },
      lateFeeInitialAmount: { type: 'number', description: 'The first late fee.' },
      lateFeeInitialType: { type: 'string', description: 'flat or percent_of_rent.' },
    },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'set_rent_components',
    audience: 'landlord', method: 'PUT', path: '/api/leases/:leaseId/rent-components',
    pathParams: ['leaseId'],
    description:
      'Break the rent on a lease into named parts — base rent, lot rent, pet rent, parking, storage ' +
      '— so the tenant\u2019s invoice shows what they are actually paying for. Use for "$650 is $500 lot ' +
      'and $150 for the park model".\n' +
      'The parts must add up EXACTLY to the lease rent, or the system refuses and tells you the two ' +
      'figures. That is a real check, not a formality: a split that does not reconcile means the rent ' +
      'or the split is wrong, so read the numbers back rather than adjusting one to make it fit.\n' +
      'The list REPLACES whatever was there. Send an empty list to clear the split entirely.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      components: { type: 'array', description: 'The parts. Each has a kind, a label the tenant reads, and an amount. They must total the lease rent.' },
    },
    required: ['leaseId', 'components'],
    confirmFirst: true,
  },
  {
    id: 'explain_fee_override',
    audience: 'landlord', method: 'PATCH', path: '/api/leases/:leaseId/fees/:feeId',
    pathParams: ['leaseId', 'feeId'],
    description:
      'Write down WHY a fee on this lease differs from the property\u2019s standard one. Use for "the pet ' +
      'fee is $150 here because it is one cat, not two".\n' +
      'The reason is the record of a deal somebody made. Put down what the landlord actually said, ' +
      'not a tidied version — this is what gets read back in a year when nobody remembers.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      feeId: { type: 'string', description: 'The fee id on that lease, from a lookup.' },
      override_reason: { type: 'string', description: 'Why this lease\u2019s fee is different, in their words.' },
    },
    required: ['leaseId', 'feeId', 'override_reason'],
    confirmFirst: true,
  },
  {
    id: 'bill_one_off_charge_to_lease',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/charge',
    pathParams: ['leaseId'],
    description:
      'Put a one-off charge straight onto a lease as its own invoice, payable through the normal ' +
      'path. Use when the landlord names the LEASE rather than the person.\n' +
      'The description is what the tenant sees on the invoice, so write it for them. If the landlord ' +
      'is describing something that HAPPENED — damage, a violation, a call-out — add_one_off_charge ' +
      'is the better fit: it records the incident date and the kind of charge alongside the money, ' +
      'and this one does not.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      amount: { type: 'number', description: 'How much, in dollars.' },
      description: { type: 'string', description: 'What it is for. The tenant reads this.' },
      dueDate: { type: 'string', description: 'When it is due, YYYY-MM-DD.' },
    },
    required: ['leaseId', 'amount', 'description'],
    confirmFirst: true,
  },
  {
    id: 'add_carried_balance',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/carried-balance',
    pathParams: ['leaseId'],
    description:
      'Bring a debt a tenant already owed on the landlord\u2019s OLD system onto the platform, so their ' +
      'balance is the whole truth. Use for "they were $2,000 behind before we moved over".\n' +
      'Late fees are OFF on it by default and should usually stay off — the nightly engine walks ' +
      'unpaid invoices, so a carried balance with fees on begins compounding the day it is entered, ' +
      'and somebody on a catch-up plan should not be fined for arrears from the old system. Only turn ' +
      'them on if the landlord says those particular arrears were already accruing.\n' +
      'ONE carried balance per lease. A second is almost always somebody entering the same debt ' +
      'twice, and the system refuses it.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      amount: { type: 'number', description: 'What they already owed when the landlord moved over.' },
      description: { type: 'string', description: 'What it is, so the tenant recognises it.' },
      dueDate: { type: 'string', description: 'When it is due, YYYY-MM-DD.' },
      accruesLateFees: { type: 'boolean', description: 'Leave false unless the landlord says those arrears were already accruing fees.' },
    },
    required: ['leaseId', 'amount'],
    confirmFirst: true,
  },
  {
    id: 'set_seasonal_tenancy',
    audience: 'landlord', method: 'PUT', path: '/api/leases/:leaseId/seasonal',
    pathParams: ['leaseId'],
    description:
      'Mark a lease as seasonal and say which part of the year they are here — the snowbird who comes ' +
      'back to the same spot every November. Use for "they are here November through March, same spot ' +
      'each year".\n' +
      'isPriority means they get first refusal on that spot for the next season. That is a promise to ' +
      'a person, so only set it if the landlord says so.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      seasonStartMonth: { type: 'integer', description: 'Month the season starts, 1-12.' },
      seasonStartDay: { type: 'integer', description: 'Day of that month, 1-31.' },
      seasonEndMonth: { type: 'integer', description: 'Month the season ends, 1-12.' },
      seasonEndDay: { type: 'integer', description: 'Day of that month, 1-31.' },
      isPriority: { type: 'boolean', description: 'true if they get first refusal on the spot next season.' },
    },
    required: ['leaseId', 'seasonStartMonth', 'seasonStartDay', 'seasonEndMonth', 'seasonEndDay'],
    confirmFirst: true,
  },
  {
    id: 'clear_seasonal_tenancy',
    audience: 'landlord', method: 'DELETE', path: '/api/leases/:leaseId/seasonal',
    pathParams: ['leaseId'],
    description:
      'Take the seasonal arrangement off a lease, when they are staying year-round now or are not ' +
      'coming back. This also drops any first-refusal they had on the spot — say so.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'start_deposit_return',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/deposit-return',
    pathParams: ['leaseId'],
    description:
      'Open the deposit return for a lease that has ended. Use for "let us settle the Alvarez ' +
      'deposit".\n' +
      'For a dwelling or a storage unit this needs a FINALISED move-out walkthrough first — the ' +
      'landlord approves deductions looking at photographs, not on memory. If the system refuses for ' +
      'that reason, the answer is to do the walkthrough, not to try again. An RV spot is exempt, ' +
      'because the pull-out meter read IS its walkthrough.\n' +
      'This opens a draft. Nothing is refunded and nothing is deducted until it is finalised.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'add_deposit_deductions',
    audience: 'landlord', method: 'PATCH', path: '/api/leases/:leaseId/deposit-return',
    pathParams: ['leaseId'],
    description:
      'Put damage deductions and notes on an open deposit-return draft. Use for "take $340 off for ' +
      'the carpet".\n' +
      'EVERY deduction needs at least one photo or receipt already uploaded and attached by its ' +
      'document id — the system refuses the whole thing otherwise, and that rule is what makes a ' +
      'deduction defensible when the tenant disputes it. If they have not uploaded the evidence yet, ' +
      'say that is what is needed rather than sending it without.\n' +
      'The list REPLACES the deductions on the draft; send all of them, not just the new one. Nothing ' +
      'is final until the return is finalised.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      damageLines: { type: 'array', description: 'The deductions. Each needs a description, an amount, and the document ids of its photos or receipts.' },
      notes: { type: 'string', description: 'Notes on the return, in the landlord\u2019s words.' },
    },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'finalize_deposit_return',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/deposit-return/finalize',
    pathParams: ['leaseId'],
    description:
      'Finalise the deposit return. This is the one that COUNTS: it settles what is deducted and what ' +
      'goes back, and it is what the tenant sees.\n' +
      'Read the whole thing back before you call it — the deposit held, every deduction with its ' +
      'reason, and the figure being returned — and get an explicit yes to that total. A deposit ' +
      'return is on a statutory clock in most states and is the single most disputed thing in ' +
      'renting; there is no version of this that should be done quickly.\n' +
      'A staff member may finalise up to the landlord\u2019s own approval threshold; above it, it parks ' +
      'and waits for the landlord. If it comes back parked, that is not a failure — tell them it is ' +
      'waiting on the owner.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'waive_early_termination_fee',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/waive-early-termination',
    pathParams: ['leaseId'],
    description:
      'Waive the early-termination fee on a tenant\u2019s request and let them out of the lease. Use for ' +
      '"let them go, do not charge them" — a job transfer, a death in the family, a landlord who ' +
      'simply wants the unit back.\n' +
      'This does TWO things and the second is the one people miss: it waives the fee AND it ends the ' +
      'lease. Say both. It only works on a request that is open; if there is none the system says so, ' +
      'and the tenant has to ask first.\n' +
      'This is the landlord\u2019s call. Never offer it to a tenant and never hint that it might happen.',
    params: {
      leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' },
      reason: { type: 'string', description: 'Why it is being waived, for the record.' },
    },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'request_background_check_for_lease',
    audience: 'landlord', method: 'POST', path: '/api/leases/:leaseId/request-background-check',
    pathParams: ['leaseId'],
    description:
      'Ask the tenant on a lease to complete a background check. Use for "get a check on the new ' +
      'people in 204".\n' +
      'This ASKS them to complete one; it does not run a check and it decides nothing. The screening ' +
      'decision itself is never yours to make — when the result comes back, the landlord records ' +
      'approve or decline themselves.',
    params: { leaseId: { type: 'string', description: 'The lease as the landlord refers to it — the unit NUMBER ("204") or the tenant\'s name ("the Alvarez lease") is fine. You do NOT need to look up an id first, and you must never ask them for one. A lease id from a previous lookup also works.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },

  // ── TENANT · ending a lease early (S628) ─────────────────────────────
  {
    id: 'request_early_termination',
    audience: 'tenant', method: 'POST', path: '/api/leases/:leaseId/terminate-early',
    pathParams: ['leaseId'],
    description:
      'Ask to end the lease before its end date. Use for "I got a job in Denver, I need out" or "can ' +
      'I break my lease?".\n' +
      'Get the figure FIRST with get_my_termination_quote and read it back. Breaking a lease usually ' +
      'costs money — what it costs is in the lease they signed — and somebody who asks the question ' +
      'has often not seen the number yet. Do not send this until they have heard it and said yes ' +
      'knowing it.\n' +
      'It is a REQUEST. The landlord may waive the fee or may not; that is theirs, and you never ' +
      'suggest they might. They can cancel it before it goes through.',
    params: {
      leaseId: { type: 'string', description: 'Their lease id, from get_my_lease.' },
      reason: { type: 'string', description: 'Why they need to leave, in their words. The landlord reads this.' },
    },
    required: ['leaseId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_early_termination',
    audience: 'tenant', method: 'POST', path: '/api/leases/:leaseId/terminate-early/cancel',
    pathParams: ['leaseId'],
    description:
      'Withdraw an early-termination request the tenant made. Use for "the job fell through, I am ' +
      'staying". Their lease carries on exactly as it was.',
    params: { leaseId: { type: 'string', description: 'Their lease id, from get_my_lease.' } },
    required: ['leaseId'],
    confirmFirst: true,
  },
  // ── LANDLORD · e-sign (S628) ─────────────────────────────────────────
  //
  // Sending an existing document and voiding one already worked. What was
  // missing is DRAWING ONE UP — the agent could talk about a lease it had no
  // way to produce. The raw document builder is deliberately left out: it takes
  // a hand-assembled signer list with resolved user ids, and a wrong signer on
  // a lease is worse than no tool. draft_household_lease does the same job from
  // a unit and a list of emails, which is what a landlord actually has.
  {
    id: 'draft_household_lease',
    audience: 'landlord', method: 'POST', path: '/api/esign/draft-household',
    description:
      'Draw up the lease for everybody moving into a unit, off that unit type\u2019s default template. ' +
      'Use straight after inviting a household — "now get their lease ready".\n' +
      'ORDER MATTERS: the first email is the primary resident, the one who holds the lease. The rest ' +
      'ride as co-tenants. Get that from the landlord rather than guessing from who was mentioned ' +
      'first.\n' +
      'Everybody has to have a tenant account already — invite them first. If none of them do, it ' +
      'comes back saying so and nothing is drafted; say that rather than reporting a lease that does ' +
      'not exist. This DRAFTS. Nothing is sent to anybody until send_document_for_signature.',
    params: {
      unitId: { type: 'string', description: 'The unit they are moving into, from a lookup.' },
      emails: { type: 'array', description: 'Their email addresses, PRIMARY RESIDENT FIRST. One to eight.' },
    },
    required: ['unitId', 'emails'],
    confirmFirst: true,
  },
  {
    id: 'draft_renewal_document',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/renewal',
    description:
      'Draw up the renewal lease for a tenant staying on. Use for "get the Alvarez renewal ready".\n' +
      'This collects NO TERMS — not the new rent, not the new dates. That is deliberate and it is the ' +
      'GAM standard: THE LEASE IS THE DOCUMENT, so the landlord types the new figures into the ' +
      'drafted lease itself during their signing pass. Do NOT ask them for a rent here and do not ' +
      'quote one; tell them the draft is ready and the numbers go in when they sign it.\n' +
      'A second open renewal draft on the same lease is a mistake and the system refuses it — void ' +
      'the first or send it.',
    params: {
      leaseId: { type: 'string', description: 'The lease being renewed, from a lookup.' },
      templateId: { type: 'string', description: 'Which lease template to draft from, from a lookup. Required.' },
    },
    required: ['leaseId', 'templateId'],
    confirmFirst: true,
  },
  {
    id: 'draft_terms_addendum',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/addendum-terms',
    description:
      'Draw up an addendum that changes the money on a live lease — a rent change, or a new recurring ' +
      'charge like parking or a garage. Use for "put their space rent up to $520 from March" or "they ' +
      'are taking the carport, $40 a month".\n' +
      'Each change carries its own EFFECTIVE DATE, and on completion the nightly job applies it to ' +
      'billing on that date. So the date is not decoration: get it from the landlord and read it back ' +
      'with the amount.\n' +
      'mode is the landlord\u2019s call and it turns on their local law, never on anything you decide. ' +
      '"agreement" means the tenant signs it. "notice" means the landlord issues it and the tenant ' +
      'does not sign. If they have not said which, ASK — do not default to one. You do not tell them ' +
      'which their state allows; that is a legal question and it escalates.\n' +
      'The signers work themselves out from the lease. This DRAFTS; nothing goes to anybody until it ' +
      'is sent.',
    params: {
      leaseId: { type: 'string', description: 'The lease being amended, from a lookup.' },
      title: { type: 'string', description: 'What the addendum is called. Both sides read this.' },
      templateId: { type: 'string', description: 'The template to draft from, from a lookup.' },
      mode: { type: 'string', description: 'agreement (the tenant signs) or notice (the landlord issues it). The landlord decides; ask.' },
      scheduledChanges: { type: 'array', description: 'The money changes. A rent change has changeType rent, an effectiveDate and a newRentAmount; a recurring charge has changeType recurring_fee, an effectiveDate, a feeType, a feeAmount and an optional feeDescription.' },
    },
    required: ['leaseId', 'title'],
    confirmFirst: true,
  },
  {
    id: 'create_lease_template',
    audience: 'landlord', method: 'POST', path: '/api/esign/templates',
    description:
      'Create a lease template from a PDF the landlord has already uploaded. Use for "set up the ' +
      'template for the mobile-home lots".\n' +
      'You cannot upload the PDF for them — that is a file, and it is theirs to put in. If they have ' +
      'not uploaded one yet, say that is the first step.\n' +
      'depositMonths is the deposit as MONTHS OF RENT, and it is what every lease from this template ' +
      'charges, so confirm the number. defaultTermMonths left out means month-to-month. Setting the ' +
      'unit type is what lets this become that type\u2019s default later.',
    params: {
      name: { type: 'string', description: 'What the template is called.' },
      basePdfUrl: { type: 'string', description: 'The uploaded PDF, from a lookup. The landlord uploads it themselves.' },
      unitType: { type: 'string', description: 'Which kind of unit it is for — apartment, mobile_home, rv_spot, and so on.' },
      propertyId: { type: 'string', description: 'Limit it to one property, if they want that.' },
      description: { type: 'string', description: 'What it is for, in their words.' },
      depositMonths: { type: 'number', description: 'The deposit as months of rent, 0 to 12. Leave out to fill the deposit in by hand each time.' },
      defaultTermMonths: { type: 'integer', description: 'Default term in months, 1 to 120. Leave out for month-to-month.' },
      pageCount: { type: 'integer', description: 'How many pages the PDF has.' },
      purpose: { type: 'string', description: 'lease, or work_trade_addendum for their own work-trade form.' },
    },
    required: ['name'],
    confirmFirst: true,
  },
  {
    id: 'update_lease_template',
    audience: 'landlord', method: 'PATCH', path: '/api/esign/templates/:templateId',
    pathParams: ['templateId'],
    description:
      'Change a lease template — its name, which unit type it is for, the deposit months, the default ' +
      'term. Use for "the deposit on the lot template should be one month, not two".\n' +
      'This changes what NEW leases drawn from it say. Leases already signed keep their own terms, ' +
      'and leases already drafted keep what they were drafted with. Say that.',
    params: {
      templateId: { type: 'string', description: 'The template id, from a lookup.' },
      name: { type: 'string', description: 'New name.' },
      description: { type: 'string', description: 'What it is for.' },
      unitType: { type: 'string', description: 'Which kind of unit it is for.' },
      propertyId: { type: 'string', description: 'Limit it to one property.' },
      depositMonths: { type: 'number', description: 'Deposit as months of rent, 0 to 12.' },
      defaultTermMonths: { type: 'integer', description: 'Default term in months.' },
    },
    required: ['templateId'],
    confirmFirst: true,
  },
  {
    id: 'set_default_lease_template',
    audience: 'landlord', method: 'POST', path: '/api/esign/templates/:templateId/set-default',
    pathParams: ['templateId'],
    description:
      'Make a template the default for its unit type, so leases draft from it automatically. Use for ' +
      '"use that one for all the RV spots from now on".\n' +
      'A default is PER UNIT TYPE, so the template has to have a unit type set first — if it does ' +
      'not, the system says so and that is the thing to fix. Setting this one clears whichever was ' +
      'the default before, so name the one being replaced.\n' +
      'This is worth offering unprompted: a unit with no default template is a unit whose lease never ' +
      'drafts, and a landlord waiting on a draft that will never come has no way to know why.',
    params: {
      templateId: { type: 'string', description: 'The template id, from a lookup.' },
      isDefault: { type: 'boolean', description: 'true to make it the default, false to clear it. Defaults to true.' },
    },
    required: ['templateId'],
    confirmFirst: true,
  },
  {
    id: 'delete_lease_template',
    audience: 'landlord', method: 'DELETE', path: '/api/esign/templates/:templateId',
    pathParams: ['templateId'],
    description:
      'Remove a lease template they no longer use. Documents already drawn from it are untouched — ' +
      'this only stops new ones being drafted from it. If it was a unit type\u2019s default, that unit ' +
      'type is left with NO default and its leases will stop drafting; say that first and offer to ' +
      'set another one.',
    params: { templateId: { type: 'string', description: 'The template id, from a lookup.' } },
    required: ['templateId'],
    confirmFirst: true,
  },

  // ── LANDLORD · the utility cycle (S628) ──────────────────────────────
  //
  // Recording a reading and starting a run already worked. The rest of the
  // month — the meters themselves, what they serve, the rates, and turning
  // readings into bills — did not.
  {
    id: 'add_utility_meter',
    audience: 'landlord', method: 'POST', path: '/api/utility/meters',
    description:
      'Add a utility meter at a property. Use for "there is a water master on the north half" or ' +
      '"spot 12 has its own electric submeter".\n' +
      'billingMethod is the decision that matters. A SUBMETER measures exactly one unit and bills what ' +
      'that unit used. A RUBS MASTER measures a pool of units and splits one bill between them by a ' +
      'rule. Ask which it is rather than inferring it from the word they used.\n' +
      'digits is how many digits are on the physical meter FACE, and readingMultiplier is what one ' +
      'turn of the last digit is worth — a water register that counts per hundred gallons is 100, so ' +
      '413 on the dial is 41,300 gallons. Both are properties of the hardware; ask, do not assume, ' +
      'because getting them wrong misprices every bill from it.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      utilityType: { type: 'string', description: 'water, electric, gas, sewer, trash, and so on.' },
      label: { type: 'string', description: 'What the landlord calls it — "north water master".' },
      billingMethod: { type: 'string', description: 'submeter (one unit) or a RUBS master (a pool split by a rule).' },
      ratePerUnit: { type: 'number', description: 'What one unit of usage costs.' },
      baseFee: { type: 'number', description: 'A flat fee on top of usage.' },
      rubsAllocationMethod: { type: 'string', description: 'How a RUBS pool is split between its units.' },
      rubsBasis: { type: 'string', description: 'Whether the pool is priced by usage times rate, or by dividing the provider\u2019s actual bill.' },
      digits: { type: 'integer', description: 'How many digits are on the meter face.' },
      readingMultiplier: { type: 'number', description: 'What one turn of the last digit is worth. 100 for a register counting per hundred gallons.' },
    },
    required: ['propertyId', 'utilityType', 'label', 'billingMethod'],
    confirmFirst: true,
  },
  {
    id: 'update_utility_meter',
    audience: 'landlord', method: 'PATCH', path: '/api/utility/meters/:meterId',
    pathParams: ['meterId'],
    description:
      'Change a meter — its label, its rate, its base fee, its face digits, or mark it broken or ' +
      'repaired. Use for "water went to $0.006 a gallon" or "the meter on 12 is dead".\n' +
      'How a reading is INTERPRETED and how a bill is CALCULATED — the utility type, the billing ' +
      'method, the digits, the multiplier — can be changed freely until the meter has actually ' +
      'measured or billed something, and are frozen after that. That is deliberate: changing them ' +
      'later would silently re-interpret readings already taken and bills already sent. If the system ' +
      'refuses on those grounds, read that back; it is not a bug to work around.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      label: { type: 'string', description: 'What it is called.' },
      utilityType: { type: 'string', description: 'What it measures. Frozen once it has history.' },
      billingMethod: { type: 'string', description: 'How it bills. Frozen once it has history.' },
      ratePerUnit: { type: 'number', description: 'What one unit of usage costs.' },
      baseFee: { type: 'number', description: 'Flat fee on top of usage.' },
      digits: { type: 'integer', description: 'Digits on the meter face. Frozen once it has history.' },
      readingMultiplier: { type: 'number', description: 'What one turn of the last digit is worth. Frozen once it has history.' },
      rubsAllocationMethod: { type: 'string', description: 'How a RUBS pool is split.' },
      rubsBasis: { type: 'string', description: 'How the pool is priced.' },
    },
    required: ['meterId'],
    confirmFirst: true,
  },
  {
    id: 'assign_units_to_meter',
    audience: 'landlord', method: 'POST', path: '/api/utility/meters/:meterId/units',
    pathParams: ['meterId'],
    description:
      'Say which units a meter serves. Use for "the north master covers spots 1 through 14".\n' +
      'A SUBMETER serves exactly one unit — sending several against one is refused, and rightly, ' +
      'because it means the landlord has the wrong meter in mind. A RUBS master is the one that takes ' +
      'a list.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      unitIds: { type: 'array', description: 'The unit ids it serves. One only for a submeter.' },
      unitId: { type: 'string', description: 'A single unit id, for a submeter.' },
    },
    required: ['meterId'],
    confirmFirst: true,
  },
  {
    id: 'set_meter_unit_quantity',
    audience: 'landlord', method: 'PATCH',
    path: '/api/utility/meters/:meterId/units/:unitId',
    pathParams: ['meterId', 'unitId'],
    description:
      'Say how many of a service one unit takes — the household with a second trash can pays for two. ' +
      'Use for "spot 12 has two cans".\n' +
      'Quantity ONLY, never price. The rate stays the property\u2019s and is the same for everyone; what ' +
      'changes is how many of it this unit is billed for. Do not use this to charge somebody a ' +
      'different rate.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      quantity: { type: 'integer', description: 'How many of the service this unit takes, 1 to 99.' },
    },
    required: ['meterId', 'unitId', 'quantity'],
    confirmFirst: true,
  },
  {
    id: 'bill_back_meter',
    audience: 'landlord', method: 'POST', path: '/api/utility/meters/:meterId/bill-back',
    pathParams: ['meterId'],
    description:
      'Start billing a utility back to every unit on a meter that is not already carrying it — the ' +
      'park that never charged for trash and now does. Use for "we are charging for water at Sunset ' +
      'Palms from now on".\n' +
      'This touches EVERY unit on that meter at once, which is the point: doing it one at a time ' +
      'across twenty-seven spaces is how half get missed. A responsibility that came from a SIGNED ' +
      'LEASE is never touched — this only fills the silences. Say how many units it will affect ' +
      'before you send it.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      note: { type: 'string', description: 'Why, for the record.' },
    },
    required: ['meterId'],
    confirmFirst: true,
  },
  {
    id: 'set_utility_tax_rate',
    audience: 'landlord', method: 'POST', path: '/api/utility/tax-rates',
    description:
      'Set the tax rate applied to a utility at a property. Use for "water is taxed at 4.5% here".\n' +
      'This is a rate their local authority sets, not one they choose — take the figure from them and ' +
      'do not work it out. It is a percentage: 4.5 means 4.5%, not 450%.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      utilityType: { type: 'string', description: 'Which utility is taxed.' },
      taxRatePct: { type: 'number', description: 'The rate as a percentage — 4.5 means 4.5%.' },
      label: { type: 'string', description: 'What the tax is called locally.' },
    },
    required: ['propertyId', 'utilityType', 'taxRatePct'],
    confirmFirst: true,
  },
  {
    id: 'set_property_utility_rate',
    audience: 'landlord', method: 'POST', path: '/api/utility/property-rates',
    description:
      'Set the property-wide rate for a utility — what everybody there pays per unit of usage, plus ' +
      'any flat fee. Use for "trash is $18 a month at the park".\n' +
      'This is the standing price at that property and it changes what every unit on it is billed ' +
      'next cycle. Read back the utility, the rate and the property together.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      utilityType: { type: 'string', description: 'Which utility.' },
      ratePerUnit: { type: 'number', description: 'What one unit of usage costs.' },
      baseFee: { type: 'number', description: 'A flat monthly fee.' },
      sewerRatePerUnit: { type: 'number', description: 'The sewer rate, where sewer is billed off water usage.' },
      prevailingResidentialRate: { type: 'number', description: 'The prevailing residential rate, where the state caps what a park may charge.' },
    },
    required: ['propertyId', 'utilityType'],
    confirmFirst: true,
  },
  {
    id: 'complete_reading_run',
    audience: 'landlord', method: 'POST', path: '/api/utility/reading-runs/:runId/complete',
    pathParams: ['runId'],
    description:
      'Close a meter-reading run once every meter has been read. Use for "that is all the meters ' +
      'done".\n' +
      'Completing it is what makes those readings billable. If any reading is still waiting on a ' +
      'double-check, deal with that first — a run closed over an unresolved read bills a number ' +
      'nobody confirmed.',
    params: { runId: { type: 'string', description: 'The reading run id, from a lookup.' } },
    required: ['runId'],
    confirmFirst: true,
  },
  {
    id: 'generate_utility_bills',
    audience: 'landlord', method: 'POST', path: '/api/utility/generate-bills',
    description:
      'Turn a completed month of readings into utility bills. Use for "run the water bills for March".\n' +
      'cycleMonth is the FIRST of the month, as YYYY-MM-01. Re-running the same cycle does not ' +
      'duplicate anything, so a second run after fixing one meter is safe and worth saying — a ' +
      'landlord who thinks they will double-bill will not re-run it.\n' +
      'Scope it to a meter or a property when they name one; without either it runs the whole ' +
      'portfolio, which is rarely what somebody asking about one park meant. Generating is not ' +
      'sending: the bills land unbilled and are finalised one by one.',
    params: {
      cycleMonth: { type: 'string', description: 'The first of the month being billed, as YYYY-MM-01.' },
      meterId: { type: 'string', description: 'Just this meter, from a lookup.' },
      propertyId: { type: 'string', description: 'Just this property, from a lookup.' },
    },
    required: ['cycleMonth'],
    confirmFirst: true,
  },
  {
    id: 'finalize_utility_bill',
    audience: 'landlord', method: 'POST', path: '/api/utility/bills/:billId/finalize',
    pathParams: ['billId'],
    description:
      'Finalise a utility bill so it goes to the tenant and can be paid. Use for "send that one out".\n' +
      'THIS is the moment the tenant owes it — until now the bill existed but was not theirs. Read ' +
      'back the unit, the usage and the amount before you do it. Only an unbilled bill can be ' +
      'finalised; if the system says it is already billed, it has already gone.',
    params: { billId: { type: 'string', description: 'The bill id, from a lookup.' } },
    required: ['billId'],
    confirmFirst: true,
  },
  // ── LANDLORD · the bank feed (S628) ──────────────────────────────────
  //
  // Categorising and ignoring a transaction already worked. Matching a DEPOSIT
  // to the charges it paid did not, and that is the one that matters: in a park
  // where every lot pays the same rent, an amount identifies nobody.
  {
    id: 'confirm_deposit_match',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/deposits/:depositId/confirm',
    pathParams: ['depositId'],
    description:
      'Say which charges a bank deposit paid off. Use for "that $1,300 on the 4th was spot 12 and ' +
      'spot 19".\n' +
      'The LANDLORD confirms this, never you. In a park where every lot pays the same rent an amount ' +
      'identifies nobody, and a confident wrong answer books one tenant\u2019s money onto another\u2019s ' +
      'ledger — and from there onto their credit file. Read back the deposit, the date, and every ' +
      'charge you are about to mark paid, by tenant and unit, and get a yes to that list.\n' +
      'If the landlord is not sure who it was, mark_deposit_not_rent is the honest way out. Never ' +
      'pick the most likely tenant to close the loop.',
    params: {
      depositId: { type: 'string', description: 'The bank deposit id, from the unmatched-deposit queue.' },
      chargeIds: { type: 'array', description: 'The charge ids this deposit paid, 1 to 20. From the candidate shortlist on that deposit.' },
      method: { type: 'string', description: 'cash, check or money_order — how it reached the bank.' },
      declarationId: { type: 'string', description: 'The tenant\u2019s own declaration of this payment, when one lines up.' },
    },
    required: ['depositId', 'chargeIds', 'method'],
    confirmFirst: true,
  },
  {
    id: 'mark_deposit_not_rent',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/deposits/:depositId/not-rent',
    pathParams: ['depositId'],
    description:
      'Say a deposit was not a tenant payment at all — an owner contribution, an insurance cheque, a ' +
      'refund. It goes back to the ordinary categorising flow as other income.\n' +
      'Offer this whenever the landlord is unsure. Without it, somebody staring at a shortlist of ' +
      'tenants who did NOT pay this deposit has no honest way out except to pick one, and that is the ' +
      'outcome this exists to prevent.',
    params: { depositId: { type: 'string', description: 'The bank deposit id, from the queue.' } },
    required: ['depositId'],
    confirmFirst: true,
  },
  {
    id: 'sync_bank_connection',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/connections/:connectionId/sync',
    pathParams: ['connectionId'],
    description:
      'Pull the latest transactions from a connected bank account now, instead of waiting for the ' +
      'nightly run. Use for "I deposited it this morning, is it showing yet?".\n' +
      'Banks post on their own schedule — a deposit made today may genuinely not be there yet, and a ' +
      'sync that finds nothing is not a fault. Say that rather than syncing twice.',
    params: { connectionId: { type: 'string', description: 'The bank connection id, from a lookup.' } },
    required: ['connectionId'],
  },
  {
    id: 'set_books_start_date',
    audience: 'landlord', method: 'PUT', path: '/api/bank-feed/books-start-date',
    description:
      'Set the date the landlord\u2019s books begin — bank transactions before it are left alone rather ' +
      'than pulled in for categorising. Use for "we moved over on the first of June, do not bother ' +
      'with anything before that".\n' +
      'Send null to clear it and take everything the connection offers. Moving it FORWARD leaves ' +
      'earlier transactions out of the books; say that before you change it on somebody who has ' +
      'already been categorising.',
    params: { date: { type: 'string', description: 'The first day the books cover, YYYY-MM-DD, or null for no start date.' } },
    required: ['date'],
    confirmFirst: true,
  },
  {
    id: 'disconnect_bank_connection',
    audience: 'landlord', method: 'POST', path: '/api/bank-feed/connections/:connectionId/disconnect',
    pathParams: ['connectionId'],
    description:
      'Disconnect a bank account from the feed. Use for "we closed that account".\n' +
      'New transactions stop arriving. Everything already pulled in stays on the books — this does ' +
      'not erase history. The bank feed is how a landlord reconciles what they were actually paid, so ' +
      'if they have no other account connected, say what they lose before you do it.',
    params: { connectionId: { type: 'string', description: 'The bank connection id, from a lookup.' } },
    required: ['connectionId'],
    confirmFirst: true,
  },

  // ── LANDLORD · amenities (S628) ──────────────────────────────────────
  {
    id: 'create_common_area',
    audience: 'landlord', method: 'POST', path: '/api/common-areas',
    description:
      'Add a shared amenity residents can use or book — a clubhouse, a laundry, a pool, a pickleball ' +
      'court. Use for "put the clubhouse on so people can reserve it".\n' +
      'reservable false makes it something residents can see but not book. requiresApproval true ' +
      'means the landlord decides each request rather than it going through on its own — that is a ' +
      'real workload difference, so ask which they want. A reservation fee is money a resident pays, ' +
      'so read it back.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      name: { type: 'string', description: 'What residents call it.' },
      description: { type: 'string', description: 'What it is and any rules, in their words.' },
      reservable: { type: 'boolean', description: 'Whether residents can book it at all.' },
      requiresApproval: { type: 'boolean', description: 'true if the landlord approves each request.' },
      capacity: { type: 'integer', description: 'How many people it holds.' },
      reservationFee: { type: 'number', description: 'What a booking costs.' },
      weekendFee: { type: 'number', description: 'A different fee at weekends.' },
      openTime: { type: 'string', description: 'Earliest bookable time, as HH:MM.' },
      closeTime: { type: 'string', description: 'Latest bookable time, as HH:MM.' },
      maxReservationHours: { type: 'integer', description: 'Longest single booking, in hours.' },
      advanceBookingDays: { type: 'integer', description: 'How far ahead residents may book.' },
      monthlyReservationLimit: { type: 'integer', description: 'How many bookings one person gets a month. Leave out for unlimited.' },
      eventsEnabled: { type: 'boolean', description: 'Whether residents may book it for a private event.' },
      eventDepositAmount: { type: 'number', description: 'Deposit for a private event.' },
    },
    required: ['propertyId', 'name'],
    confirmFirst: true,
  },
  {
    id: 'update_common_area',
    audience: 'landlord', method: 'PATCH', path: '/api/common-areas/:areaId',
    pathParams: ['areaId'],
    description:
      'Change an amenity — its hours, its fee, its booking rules, or take it out of service with ' +
      'active false. Use for "the pool closes at nine now" or "clubhouse is shut for the remodel".\n' +
      'Taking it out of service stops new bookings. It does NOT tell the people who have already ' +
      'booked it — offer to message them, because a resident turning up to a locked clubhouse is the ' +
      'outcome to avoid.',
    params: {
      areaId: { type: 'string', description: 'The amenity id, from a lookup.' },
      name: { type: 'string', description: 'What it is called.' },
      description: { type: 'string', description: 'What it is and its rules.' },
      active: { type: 'boolean', description: 'false takes it out of service.' },
      reservable: { type: 'boolean', description: 'Whether residents can book it.' },
      requiresApproval: { type: 'boolean', description: 'Whether the landlord approves each request.' },
      capacity: { type: 'integer', description: 'How many people it holds.' },
      reservationFee: { type: 'number', description: 'What a booking costs.' },
      weekendFee: { type: 'number', description: 'Weekend fee.' },
      openTime: { type: 'string', description: 'Earliest bookable time, HH:MM.' },
      closeTime: { type: 'string', description: 'Latest bookable time, HH:MM.' },
      maxReservationHours: { type: 'integer', description: 'Longest single booking, in hours.' },
      advanceBookingDays: { type: 'integer', description: 'How far ahead residents may book.' },
      monthlyReservationLimit: { type: 'integer', description: 'Bookings per person per month.' },
    },
    required: ['areaId'],
    confirmFirst: true,
  },
  {
    id: 'hold_common_area',
    audience: 'landlord', method: 'POST', path: '/api/common-areas/:areaId/reservations',
    pathParams: ['areaId'],
    description:
      'Block out an amenity for the landlord\u2019s own use — a closure for maintenance, a park event, a ' +
      'private rental. Use for "the clubhouse is booked for the potluck on the 14th".\n' +
      'This goes live immediately and takes those hours off residents. If it clashes with a booking ' +
      'somebody already has, the system says so — that resident planned around it, so take that ' +
      'seriously rather than moving them. notifyResidents true tells everyone at the property.',
    params: {
      areaId: { type: 'string', description: 'The amenity id, from a lookup.' },
      kind: { type: 'string', description: 'What kind of hold it is — a closure, an event, a private rental.' },
      startsAt: { type: 'string', description: 'When it starts, in full ISO form.' },
      endsAt: { type: 'string', description: 'When it ends, in full ISO form.' },
      title: { type: 'string', description: 'What to call it. Residents see this.' },
      notes: { type: 'string', description: 'Anything else about it.' },
      guestCount: { type: 'integer', description: 'How many people are expected.' },
      notifyResidents: { type: 'boolean', description: 'true to tell everyone at the property.' },
    },
    required: ['areaId', 'kind', 'startsAt', 'endsAt'],
    confirmFirst: true,
  },
  {
    id: 'retire_common_area',
    audience: 'landlord', method: 'DELETE', path: '/api/common-areas/:areaId',
    pathParams: ['areaId'],
    description:
      'Remove an amenity that no longer exists. If they are only closing it for a while, ' +
      'update_common_area with active false is the better answer and keeps its history — offer that ' +
      'first. Bookings people already hold on it need telling about either way.',
    params: { areaId: { type: 'string', description: 'The amenity id, from a lookup.' } },
    required: ['areaId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_amenity_reservation',
    audience: 'landlord', method: 'POST', path: '/api/common-areas/reservations/:reservationId/cancel',
    pathParams: ['reservationId'],
    description:
      'Cancel a booking on an amenity. Use for "cancel the clubhouse on Saturday".\n' +
      'Somebody was counting on this. If a fee was paid on it, cancelling here does not on its own ' +
      'put that money back — say so, and if they want it refunded that is a money question and it ' +
      'escalates. Offer to message the resident about it.',
    params: { reservationId: { type: 'string', description: 'The reservation id, from a lookup.' } },
    required: ['reservationId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_my_amenity_reservation',
    audience: 'tenant', method: 'POST', path: '/api/common-areas/reservations/:reservationId/cancel',
    pathParams: ['reservationId'],
    description:
      'Cancel a booking the tenant made on an amenity. Use for "I do not need the clubhouse on ' +
      'Saturday any more".\n' +
      'If they paid a fee on it, do not promise it back — cancelling frees the slot, and anything ' +
      'about the money is for their landlord. Say what you did and what you cannot say.',
    params: { reservationId: { type: 'string', description: 'Their reservation id, from get_my_amenities.' } },
    required: ['reservationId'],
    confirmFirst: true,
  },

  // ── LANDLORD · inspections and surveys (S628) ────────────────────────
  {
    id: 'reschedule_inspection',
    audience: 'landlord', method: 'PATCH', path: '/api/inspections/:inspectionId',
    pathParams: ['inspectionId'],
    description:
      'Move an inspection to a different time, or add notes to it. Use for "push the move-out ' +
      'walkthrough at 204 to Thursday".\n' +
      'Only an inspection that has not been submitted can be edited — once it is in, the record is ' +
      'the record. Somebody is expecting you at the old time, so offer to tell them.',
    params: {
      inspectionId: { type: 'string', description: 'The inspection id, from a lookup.' },
      scheduledFor: { type: 'string', description: 'The new date and time, in full ISO form. null to unschedule it.' },
      notes: { type: 'string', description: 'Notes on the inspection.' },
    },
    required: ['inspectionId'],
    confirmFirst: true,
  },
  {
    id: 'finalize_inspection',
    audience: 'landlord', method: 'POST', path: '/api/inspections/:inspectionId/finalize',
    pathParams: ['inspectionId'],
    description:
      'Finalise an inspection. This CLOSES the record: it is what a deposit deduction later rests on, ' +
      'and a move-out walkthrough has to be finalised before the deposit return can even start.\n' +
      'It needs both signatures and every item filled in. If the system refuses, it says exactly what ' +
      'is missing — read that back rather than trying again. Nothing about it can be changed ' +
      'afterwards, so say that first.',
    params: { inspectionId: { type: 'string', description: 'The inspection id, from a lookup.' } },
    required: ['inspectionId'],
    confirmFirst: true,
  },
  {
    id: 'flag_inspection_suspicious',
    audience: 'landlord', method: 'POST', path: '/api/inspections/:inspectionId/flag-suspicious',
    pathParams: ['inspectionId'],
    description:
      'Flag a tenant-submitted periodic inspection that does not look right — photographs that do not ' +
      'match the unit, an obviously copied form. Use for "those pictures are from last year".\n' +
      'This is an accusation on somebody\u2019s record, so it needs a real reason in the landlord\u2019s own ' +
      'words and their explicit go-ahead. Only a tenant-submitted periodic inspection can be flagged. ' +
      'Do not suggest flagging one; that is theirs to raise.',
    params: {
      inspectionId: { type: 'string', description: 'The inspection id, from a lookup.' },
      reason: { type: 'string', description: 'What is wrong with it, in the landlord\u2019s words.' },
    },
    required: ['inspectionId', 'reason'],
    confirmFirst: true,
  },
  {
    id: 'close_survey',
    audience: 'landlord', method: 'POST', path: '/api/surveys/:surveyId/close',
    pathParams: ['surveyId'],
    description:
      'Close a survey so no more responses come in. Use for "that is enough, close the pool survey".\n' +
      'Only a survey that has been sent can be closed. Say how many responses they got before you do ' +
      'it — closing at four responses out of forty is usually not what somebody meant.',
    params: { surveyId: { type: 'string', description: 'The survey id, from a lookup.' } },
    required: ['surveyId'],
    confirmFirst: true,
  },
  {
    id: 'copy_survey',
    audience: 'landlord', method: 'POST', path: '/api/surveys/:surveyId/copy',
    pathParams: ['surveyId'],
    description:
      'Copy a survey to another property, so the same questions can be asked there. Use for "run that ' +
      'same one at Oak Street". The copy arrives as a DRAFT — it is not sent to anybody until they ' +
      'send it.',
    params: {
      surveyId: { type: 'string', description: 'The survey to copy, from a lookup.' },
      targetPropertyId: { type: 'string', description: 'The property to copy it to, from a lookup.' },
    },
    required: ['surveyId', 'targetPropertyId'],
    confirmFirst: true,
  },
  {
    id: 'delete_survey',
    audience: 'landlord', method: 'DELETE', path: '/api/surveys/:surveyId',
    pathParams: ['surveyId'],
    description:
      'Delete a survey. If anybody has answered it, those answers go with it — people took the time ' +
      'to reply, so say what is being lost and get a yes to that specifically. If they only want it ' +
      'to stop, close_survey keeps the answers and is almost always what they meant.',
    params: { surveyId: { type: 'string', description: 'The survey id, from a lookup.' } },
    required: ['surveyId'],
    confirmFirst: true,
  },

  // ── LANDLORD · work trade (S628) ─────────────────────────────────────
  {
    id: 'decide_work_trade_hours',
    audience: 'landlord', method: 'PATCH', path: '/api/work-trade/logs/:logId',
    pathParams: ['logId'],
    description:
      'Approve or reject hours a tenant logged against their work-trade agreement. Use for "yes, ' +
      'those eight hours are right" or "he was not here Tuesday".\n' +
      'Approved hours come off what that tenant owes, so this IS money. A rejection needs a reason ' +
      'the tenant can read and understand — they worked, or believe they did, and "rejected" with ' +
      'nothing after it is how this goes wrong.',
    params: {
      logId: { type: 'string', description: 'The logged-hours id, from get_work_trade_status.' },
      action: { type: 'string', description: 'approve or reject.' },
      rejectionReason: { type: 'string', description: 'Why, in the landlord\u2019s words. The tenant reads this.' },
    },
    required: ['logId', 'action'],
    confirmFirst: true,
  },
  {
    id: 'update_work_trade_agreement',
    audience: 'landlord', method: 'PATCH', path: '/api/work-trade/:agreementId',
    pathParams: ['agreementId'],
    description:
      'Change a work-trade agreement — the monthly hours, which charges the work offsets, whether ' +
      'unused hours carry forward, or pause or end it. Use for "make it twenty hours a month" or ' +
      '"pause Danny\u2019s trade while he is away".\n' +
      'This changes what somebody owes each month. Read back the hours, what they cover, and from ' +
      'when. Ending it means their rent goes back to being paid in full — say that in those words, ' +
      'because it is the part that gets missed.',
    params: {
      agreementId: { type: 'string', description: 'The agreement id, from get_work_trade_status.' },
      status: { type: 'string', description: 'active, paused or ended.' },
      endDate: { type: 'string', description: 'When it ends, YYYY-MM-DD.' },
      monthlyHoursTarget: { type: 'integer', description: 'Hours a month the work is worth.' },
      coveredCharges: { type: 'array', description: 'Which kinds of charge the work offsets.' },
      carryForwardMonths: { type: 'integer', description: 'How many months unused hours carry forward, 0 to 24.' },
    },
    required: ['agreementId'],
    confirmFirst: true,
  },
  {
    id: 'set_work_trade_target',
    audience: 'landlord', method: 'PATCH', path: '/api/work-trade/property/:propertyId/target',
    pathParams: ['propertyId'],
    description:
      'Set the default monthly work-trade hours at a property, which new agreements start from. Use ' +
      'for "trade at the park is fifteen hours a month".\n' +
      'This is the DEFAULT for new agreements. Agreements already running keep their own hours — it ' +
      'does not change what anybody currently owes.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      target: { type: 'integer', description: 'Default hours a month for new agreements.' },
    },
    required: ['propertyId', 'target'],
    confirmFirst: true,
  },

  // ── LANDLORD · entry notices (S628) ──────────────────────────────────
  {
    id: 'give_entry_notice',
    audience: 'landlord', method: 'POST', path: '/api/entry-requests',
    description:
      'Give a tenant notice that somebody needs to come into their home. Use for "tell 204 the ' +
      'plumber is coming Thursday morning".\n' +
      'A notice ANCHORS to the thing it is for — either an open maintenance call or a scheduled ' +
      'inspection — and exactly one of the two. That is what supplies the unit, the tenant and the ' +
      'reason, so there is no free-text reason to write and none to invent. If there is no ' +
      'maintenance request or inspection yet, that is the first step, not this.\n' +
      'This is a LEGAL NOTICE. Every state sets a minimum notice period and most set permitted hours; ' +
      'check the figure with your law tools and say what you found rather than assuming twenty-four ' +
      'hours. Read the window back before you send it — somebody plans their day around it.',
    params: {
      maintenanceRequestId: { type: 'string', description: 'The maintenance call this entry is for, from a lookup. Send this OR an inspection, never both.' },
      inspectionId: { type: 'string', description: 'The scheduled inspection this entry is for, from a lookup. Send this OR a maintenance call, never both.' },
      proposedEntryWindowStart: { type: 'string', description: 'Start of the arrival window, in full ISO form.' },
      proposedEntryWindowEnd: { type: 'string', description: 'End of the arrival window, in full ISO form.' },
    },
    required: ['proposedEntryWindowStart', 'proposedEntryWindowEnd'],
    confirmFirst: true,
  },
  {
    id: 'record_entry',
    audience: 'landlord', method: 'POST', path: '/api/entry-requests/:entryRequestId/record-entry',
    pathParams: ['entryRequestId'],
    description:
      'Record that the entry actually happened — when somebody went in, and what was done. Use for ' +
      '"the plumber was in at ten, fixed the valve".\n' +
      'This is the record that a notice was honoured as given, which is exactly what gets asked about ' +
      'later. Put down what they tell you and nothing you assume.',
    params: {
      entryRequestId: { type: 'string', description: 'The entry request id, from a lookup.' },
      enteredAt: { type: 'string', description: 'When they actually went in, in full ISO form.' },
      notes: { type: 'string', description: 'Who went in and what was done, in their words.' },
    },
    required: ['entryRequestId', 'enteredAt'],
    confirmFirst: true,
  },
  // ── LANDLORD · the reading round (S628) ──────────────────────────────
  //
  // BLIND ENTRY IS THE POINT. Nic's directive: staff field-entry shows no prior
  // values and no error giveaways, and a bad entry goes to a double-check queue
  // instead of being bounced back with a hint. So none of these descriptions
  // let the agent read the previous number out — that would defeat the control
  // by conversation rather than by code.
  {
    id: 'record_reading_in_run',
    audience: 'landlord', method: 'POST',
    path: '/api/utility/reading-runs/:runId/meters/:meterId/reading',
    pathParams: ['runId', 'meterId'],
    description:
      'Record a meter reading inside an open reading run — the monthly round, meter by meter. Use for ' +
      '"lot 14 water reads 89,120".\n' +
      'readingValue is the number ON THE DIAL, not the usage since last time. GAM works usage out ' +
      'from the previous reading.\n' +
      'DO NOT TELL THEM WHAT THE LAST READING WAS, and do not tell them whether the number they gave ' +
      'looks high or low. Readings are entered blind on purpose: somebody who knows the expected ' +
      'figure produces it. If the number is out of line the system routes it to a double-check ' +
      'quietly, and that is the whole control.\n' +
      'billAmount only matters on a RUBS master priced from the provider\u2019s actual dollar bill; it is ' +
      'ignored everywhere else. Reading the last meter closes the run and bills the cycle, so say ' +
      'that when it happens.',
    params: {
      runId: { type: 'string', description: 'The open reading run, from a lookup.' },
      meterId: { type: 'string', description: 'The meter being read, from a lookup.' },
      readingValue: { type: 'integer', description: 'The number showing on the dial. Not the usage.' },
      billAmount: { type: 'number', description: 'The provider\u2019s dollar charge for the cycle. Only for a RUBS master priced from the actual bill.' },
    },
    required: ['runId', 'meterId', 'readingValue'],
    confirmFirst: true,
  },
  {
    id: 'submit_meter_double_check',
    audience: 'landlord', method: 'POST',
    path: '/api/utility/reading-runs/:runId/double-checks/:meterId',
    pathParams: ['runId', 'meterId'],
    description:
      'Submit a second, independent reading for a meter the system asked to have checked. Use when ' +
      'somebody has gone back out and read it again.\n' +
      'Take the number they give you and send it. Do NOT tell them the first reading, do not tell ' +
      'them what would resolve the flag, and do not suggest a value — a second read that was told ' +
      'what to say is not a second read. If they ask what the first one was, say you cannot give ' +
      'them that and explain why in one line: the point is two independent looks.',
    params: {
      runId: { type: 'string', description: 'The reading run, from a lookup.' },
      meterId: { type: 'string', description: 'The meter being re-read, from a lookup.' },
      readingValue: { type: 'integer', description: 'The number on the dial, read again.' },
      billAmount: { type: 'number', description: 'The provider\u2019s dollar charge, for a RUBS master priced from the actual bill.' },
    },
    required: ['runId', 'meterId', 'readingValue'],
    confirmFirst: true,
  },
  {
    id: 'record_special_meter_read',
    audience: 'landlord', method: 'POST', path: '/api/utility/meters/:meterId/reads',
    pathParams: ['meterId'],
    description:
      'Record a read taken OUTSIDE the monthly round — a move-in or move-out baseline, a check after ' +
      'a repair, a reading taken because somebody disputes a bill. Use for "read the meter when the ' +
      'Alvarez family pulled out".\n' +
      'A move-out baseline is what keeps a departed guest\u2019s usage off the next arrival\u2019s bill, so ' +
      'it is worth offering when somebody leaves. The monthly cycle read is NOT one of these — that ' +
      'one only comes from the reading run, and the system refuses it here.\n' +
      'Same rule as the round: the value is the dial, and you do not tell them what it was last time.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      readingValue: { type: 'integer', description: 'The number on the dial.' },
      reason: { type: 'string', description: 'Why it was read now — move-in, move-out, a repair, a dispute. Not monthly_cycle.' },
      reasonNote: { type: 'string', description: 'Any detail about it, in their words.' },
    },
    required: ['meterId', 'readingValue', 'reason'],
    confirmFirst: true,
  },
  {
    id: 'correct_meter_reading',
    audience: 'landlord', method: 'PATCH',
    path: '/api/utility/meters/:meterId/readings/:readingId',
    pathParams: ['meterId', 'readingId'],
    description:
      'Correct a reading that was written down wrong — a transposed digit, the wrong date. Use for ' +
      '"that was 89,120, not 89,210".\n' +
      'Changing a reading changes what somebody was billed for that cycle, so read the old number and ' +
      'the new one back together and get a yes. If a bill has already gone out on it, say that — the ' +
      'tenant has seen a figure that is about to change.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      readingId: { type: 'string', description: 'The reading id, from a lookup.' },
      readingValue: { type: 'number', description: 'The corrected number on the dial.' },
      readingDate: { type: 'string', description: 'The corrected date, YYYY-MM-DD.' },
      note: { type: 'string', description: 'Why it was corrected.' },
    },
    required: ['meterId', 'readingId'],
    confirmFirst: true,
  },
  {
    id: 'resolve_reading_review',
    audience: 'landlord', method: 'POST', path: '/api/utility/readings/:readingId/resolve-review',
    pathParams: ['readingId'],
    description:
      'Settle a reading the system flagged for review, when the number went BACKWARDS. There are ' +
      'exactly two explanations and they bill differently, so this is a question for the landlord, ' +
      'not a guess:\n' +
      '  rollover true — the odometer wrapped past its last digit. Real usage happened and it bills ' +
      'the wrap-around: the rest of the dial plus the new number.\n' +
      '  rollover false — the meter was swapped or reset. NOTHING bills that cycle, because nobody ' +
      'knows what was used.\n' +
      'Ask which it was in those terms — "did the dial roll over, or was the meter replaced?" — and ' +
      'never pick for them. correctedValue is for when the reading itself was also written down ' +
      'wrong. If the run already completed, billing re-runs for that meter on its own.',
    params: {
      readingId: { type: 'string', description: 'The flagged reading, from a lookup.' },
      rollover: { type: 'boolean', description: 'true if the dial wrapped round, false if the meter was swapped or reset.' },
      correctedValue: { type: 'integer', description: 'The right number, if the reading was also written down wrong.' },
    },
    required: ['readingId'],
    confirmFirst: true,
  },
  {
    id: 'unassign_unit_from_meter',
    audience: 'landlord', method: 'DELETE',
    path: '/api/utility/meters/:meterId/units/:unitId',
    pathParams: ['meterId', 'unitId'],
    description:
      'Stop a meter serving a unit. Use for "spot 12 is off the north master, it has its own now".\n' +
      'From the next cycle that unit is not billed off this meter. Bills already issued stand. If ' +
      'nothing else serves that unit, it stops being billed for that utility at all — say so, ' +
      'because a unit quietly getting free water is exactly the kind of thing nobody notices.',
    params: {
      meterId: { type: 'string', description: 'The meter id, from a lookup.' },
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
    },
    required: ['meterId', 'unitId'],
    confirmFirst: true,
  },
  {
    id: 'remove_utility_meter',
    audience: 'landlord', method: 'DELETE', path: '/api/utility/meters/:meterId',
    pathParams: ['meterId'],
    description:
      'Remove a meter entirely. Use for "that meter was set up by mistake".\n' +
      'If it has readings or bills behind it the system refuses, and that refusal is correct — a ' +
      'meter with history is what the bills were calculated from. For one that is simply out of use, ' +
      'the answer is to stop it serving units rather than to delete it. Say which of the two they ' +
      'actually mean before you send this.',
    params: { meterId: { type: 'string', description: 'The meter id, from a lookup.' } },
    required: ['meterId'],
    confirmFirst: true,
  },

  // ── LANDLORD · addenda and the rest of e-sign (S628) ─────────────────
  {
    id: 'draft_add_tenant_addendum',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/addendum-add',
    description:
      'Draw up an addendum ADDING somebody to a live lease — a partner moving in, an adult child ' +
      'coming onto it. Use for "put Maria on the lease at 204".\n' +
      'Who is on a lease cannot be changed by editing the lease; it has to be signed by everybody, ' +
      'and that is what this is for. The person being added needs a GAM account first — invite them ' +
      'if they have none.\n' +
      'This DRAFTS. Nothing goes to anybody until it is sent.',
    params: {
      leaseId: { type: 'string', description: 'The lease, from a lookup.' },
      title: { type: 'string', description: 'What the addendum is called. Everybody signing reads this.' },
      signers: { type: 'array', description: 'Everybody who signs: the landlord, the existing tenants and the person being added. Each needs their userId, role and name, from a lookup.' },
      templateId: { type: 'string', description: 'The template to draft from, from a lookup.' },
    },
    required: ['leaseId', 'title', 'signers'],
    confirmFirst: true,
  },
  {
    id: 'draft_remove_tenant_addendum',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/addendum-remove',
    description:
      'Draw up an addendum REMOVING somebody from a live lease — a roommate moving out while the ' +
      'others stay. Use for "take Chris off 204, the other two are staying".\n' +
      'This is a serious document: the person coming off stops being liable for the rent, and if they ' +
      'were the primary, somebody else has to take that on — that is promoteLeaseTenantId, and ' +
      'leaving it out on a primary is the mistake to avoid. Name who is coming off and who is ' +
      'becoming primary, out loud, before you draft it.\n' +
      'It does not settle any deposit and it does not clear what they already owe.',
    params: {
      leaseId: { type: 'string', description: 'The lease, from a lookup.' },
      targetLeaseTenantId: { type: 'string', description: 'The lease-tenant record of the person coming off, from a lookup.' },
      promoteLeaseTenantId: { type: 'string', description: 'Who becomes primary, when the person leaving was the primary.' },
      title: { type: 'string', description: 'What the addendum is called.' },
      signers: { type: 'array', description: 'Everybody who signs. Each needs their userId, role and name, from a lookup.' },
      templateId: { type: 'string', description: 'The template to draft from, from a lookup.' },
    },
    required: ['leaseId', 'targetLeaseTenantId', 'title', 'signers'],
    confirmFirst: true,
  },
  {
    id: 'draft_work_trade_addendum',
    audience: 'landlord', method: 'POST', path: '/api/esign/documents/work-trade-addendum',
    description:
      'Draw up the addendum that puts a work-trade agreement in writing on the lease. Use after ' +
      'setting one up: "get Danny\u2019s trade on paper".\n' +
      'Work trade offsets rent, so having it signed is what makes it an agreement rather than an ' +
      'understanding. Offer this whenever a work-trade agreement is created without one.',
    params: {
      workTradeAgreementId: { type: 'string', description: 'The work-trade agreement, from get_work_trade_status.' },
      templateId: { type: 'string', description: 'The landlord\u2019s work-trade addendum template, from a lookup.' },
    },
    required: ['workTradeAgreementId'],
    confirmFirst: true,
  },
  {
    id: 'auto_place_template_fields',
    audience: 'landlord', method: 'POST', path: '/api/esign/templates/:templateId/auto-fields',
    pathParams: ['templateId'],
    description:
      'Have the system work out where the signature and date fields go on a template\u2019s PDF, instead ' +
      'of the landlord placing every one by hand. Use for "can you figure out where the fields go on ' +
      'this one?".\n' +
      'It runs in the background and takes a moment. Tell them it is running and that they should ' +
      'check the placements before using the template — a field in the wrong place puts somebody\u2019s ' +
      'signature in the wrong box on a lease.',
    params: { templateId: { type: 'string', description: 'The template id, from a lookup.' } },
    required: ['templateId'],
    confirmFirst: true,
  },
  {
    id: 'add_witness',
    audience: 'landlord', method: 'POST', path: '/api/esign/witnesses/provision',
    description:
      'Set up a witness so they can be added as a signer on a document. Use where the landlord says ' +
      'a lease needs witnessing — some states and some document types require it.\n' +
      'Whether a witness is REQUIRED is a legal question and not yours to answer. Set one up when ' +
      'they ask for one; if they are asking whether they need one, that escalates.',
    params: {
      email: { type: 'string', description: 'The witness\u2019s email.' },
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their last name.' },
    },
    required: ['email', 'firstName'],
    confirmFirst: true,
  },

  // ── LANDLORD · handing a property over (S628) ────────────────────────
  {
    id: 'set_property_pm_assignment',
    audience: 'landlord', method: 'PATCH', path: '/api/properties/:propertyId/pm-assignment',
    pathParams: ['propertyId'],
    description:
      'Put a property under a management company directly, or take it back with pmCompanyId null. ' +
      'Use for "Desert Ridge runs Sunset Palms now, on the standard plan".\n' +
      'This is a FINANCIAL decision — a fee plan attaches to it and the company gets paid out of the ' +
      'property. A fee plan without a company makes no sense and is refused; so is a company with no ' +
      'bank account set up, or one that is not active. Read those refusals back rather than retrying.\n' +
      'Where the company has to AGREE first, invite_property_manager is the flow. This one assigns.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      pmCompanyId: { type: 'string', description: 'The management company, from a lookup. null takes the property back.' },
      pmFeePlanId: { type: 'string', description: 'Their fee plan, from a lookup. Must belong to that company.' },
    },
    required: ['propertyId', 'pmCompanyId', 'pmFeePlanId'],
    confirmFirst: true,
  },
  {
    id: 'set_lease_signer',
    audience: 'landlord', method: 'PUT', path: '/api/properties/:propertyId/lease-signer',
    pathParams: ['propertyId'],
    description:
      'Say who signs leases on the landlord\u2019s behalf at a property — a manager with authority to ' +
      'sign, or the owner themselves with userId null. Use for "Maria signs the leases at Sunset ' +
      'Palms".\n' +
      'This puts somebody\u2019s name on binding agreements, so read back who it is and which property.',
    params: {
      propertyId: { type: 'string', description: 'The property, from a lookup.' },
      userId: { type: 'string', description: 'The signer\u2019s user id, from a lookup, or null for the owner.' },
    },
    required: ['propertyId', 'userId'],
    confirmFirst: true,
  },
  {
    id: 'onboard_applicant_to_unit',
    audience: 'landlord', method: 'POST', path: '/api/properties/applications/:applicationId/onboard',
    pathParams: ['applicationId'],
    description:
      'Turn an approved application into a tenant on the unit they applied for — this drafts their ' +
      'lease. Use for "let us get the Reyes application moving".\n' +
      'The application has to be tied to a specific unit; if it is not, a unit gets assigned first ' +
      'and the system says so. Nothing here decides the application — approving or declining an ' +
      'applicant is the landlord\u2019s to record, never yours.',
    params: { applicationId: { type: 'string', description: 'The application id, from get_pending_applications.' } },
    required: ['applicationId'],
    confirmFirst: true,
  },
  {
    id: 'approve_property_transfer',
    audience: 'landlord', method: 'POST',
    path: '/api/properties/transfer-request/:requestId/approve',
    pathParams: ['requestId'],
    description:
      'Accept a property somebody is transferring to this account. Use for "yes, take on the ' +
      'duplex".\n' +
      'This moves OWNERSHIP of a property, with its units, leases and tenants. Read back which ' +
      'property and who it is coming from, and get an unambiguous yes — this is not something to do ' +
      'off a "sure".',
    params: { requestId: { type: 'string', description: 'The transfer request id, from a lookup.' } },
    required: ['requestId'],
    confirmFirst: true,
  },
  {
    id: 'decline_property_transfer',
    audience: 'landlord', method: 'POST',
    path: '/api/properties/transfer-request/:requestId/decline',
    pathParams: ['requestId'],
    description:
      'Turn down a property somebody is trying to transfer to this account. The property stays with ' +
      'whoever holds it now. Offer to say why on their behalf if they want that.',
    params: { requestId: { type: 'string', description: 'The transfer request id, from a lookup.' } },
    required: ['requestId'],
    confirmFirst: true,
  },

  // ── LANDLORD · the onboarding transition (S628) ──────────────────────
  {
    id: 'record_prior_arrangement',
    audience: 'landlord', method: 'POST', path: '/api/payments/:paymentId/record-prior-arrangement',
    pathParams: ['paymentId'],
    description:
      'Mark the FIRST rent charge on an IMPORTED lease as already settled off-platform, from before ' +
      'the landlord came onto GAM. Use for "they paid me for June in cash before we moved over".\n' +
      'It comes off the books, no money moves, and NO manual-payment fee is charged — unlike ' +
      'record_cash_payment, which is money received NOW and does carry that fee where one applies. ' +
      'Getting the two the wrong way round bills a tenant for something they should not pay, so ask ' +
      'WHEN they paid rather than inferring it. Do not quote the fee amount; it is not the same for ' +
      'every tenant and you have not been given it.\n' +
      'It only works on an imported lease, only on the first rent charge, and only during the ' +
      'onboarding window. If the system refuses on any of those, record_cash_payment is almost ' +
      'certainly what they actually meant.',
    params: { paymentId: { type: 'string', description: 'The rent charge, from a lookup.' } },
    required: ['paymentId'],
    confirmFirst: true,
  },
  {
    id: 'edit_survey',
    audience: 'landlord', method: 'PATCH', path: '/api/surveys/:surveyId',
    pathParams: ['surveyId'],
    description:
      'Change a survey while it is still a draft — its title, its questions. Use for "add a question ' +
      'about the pool hours".\n' +
      'Only a DRAFT can be edited. Once it has gone out the questions are fixed, because people have ' +
      'already answered the ones that were asked — if they want different questions on a sent survey, ' +
      'copying it to a new draft is the honest way.',
    params: {
      surveyId: { type: 'string', description: 'The survey id, from a lookup.' },
      title: { type: 'string', description: 'The survey title.' },
      description: { type: 'string', description: 'What it is about.' },
      anonymous: { type: 'boolean', description: 'Whether answers are anonymous.' },
      questions: { type: 'array', description: 'The questions. Each has a prompt, a question_type, options where it needs them, and whether it is required.' },
    },
    required: ['surveyId'],
    confirmFirst: true,
  },
  // ── LANDLORD · getting sitting tenants onto the platform (S628) ──────
  //
  // Three routes, three different situations, and picking the wrong one is the
  // mistake that matters — one MIGRATES a paper lease that already exists, one
  // invites somebody to sign a NEW lease, and one parks a person with no lease
  // information at all. The descriptions exist to make the agent ask which.
  {
    id: 'migrate_existing_tenant',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/onboard-tenant',
    description:
      'Bring a tenant who is ALREADY LIVING THERE onto the platform, with the lease they already ' +
      'signed on paper. Use for "the Alvarez family are in 12, their lease runs to next March, rent ' +
      'is $650".\n' +
      'S630 (Nic): DO NOT PROMISE THAT THE INVITE FINISHES THIS. It creates the account and the lease TERMS from what they tell you, and that is all — the signed lease DOCUMENT is not in GAM until the landlord uploads a scan of the one in their folder, or sends the tenant a digital one to sign (their existing template is fine, same terms). Say that plainly as the next step, in the same breath as the invite. Telling a landlord their four-year tenant is onboarded when no lease document exists is how they find out at the worst possible moment.' +
      'This creates the tenant AND an imported lease from the terms they give you, and emails the ' +
      'person an activation link. No background check and no application — they already live there.\n' +
      'THE TERMS COME FROM THE PAPER LEASE, not from you. Rent, dates, deposit, late-fee terms: read ' +
      'each one back as they give it, and if they do not know a figure, ask rather than filling in ' +
      'something reasonable. This lease becomes what the tenant is billed on.\n' +
      'If they are signing a NEW lease rather than moving one over, that is ' +
      'invite_tenant_to_sign_lease. If the landlord does not have the lease terms to hand, ' +
      'park_pending_tenant holds the person until they do.',
    params: {
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their last name.' },
      email: { type: 'string', description: 'Their email. Read it back — a typo goes to a stranger.' },
      phone: { type: 'string', description: 'Their phone number.' },
      unitId: { type: 'string', description: 'The unit they live in — the unit NUMBER is fine ("12", "RV 07"). Never ask the landlord for an id.' },
      leaseStart: { type: 'string', description: 'When the existing lease started, YYYY-MM-DD.' },
      leaseEnd: { type: 'string', description: 'When it ends, YYYY-MM-DD. Leave out for month-to-month.' },
      monthlyRent: { type: 'number', description: 'The rent on the signed lease.' },
      securityDeposit: { type: 'number', description: 'The deposit already held.' },
      lateFeeAmount: { type: 'number', description: 'The late fee the signed lease states.' },
      lateFeeGraceDays: { type: 'integer', description: 'The grace period the signed lease states. Ask — live leases run 0, 3 and 5 days, so there is no default worth guessing.' },
      noticeDaysRequired: { type: 'integer', description: 'Notice either side must give, per the lease.' },
      autoRenew: { type: 'boolean', description: 'Whether the paper lease renews on its own.' },
    },
    required: ['firstName', 'lastName', 'email', 'phone', 'unitId', 'leaseStart', 'monthlyRent'],
    confirmFirst: true,
  },
  {
    id: 'invite_tenant_to_sign_lease',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/onboard-new-lease-tenant',
    description:
      'Invite somebody to a unit for a lease they are going to SIGN. Use for "the Reyes family are ' +
      'taking 204, send them the paperwork".\n' +
      'NO lease is created here — the signed document becomes the lease, which is the GAM standard. ' +
      'The draft fills itself in from the unit and its default template when they accept, so the ' +
      'unit needs a rent amount set first; the system refuses without one and that is the thing to ' +
      'fix.\n' +
      'For a household, call this again for the same unit before anybody signs. Adding somebody voids ' +
      'the unsigned draft so the whole roster re-drafts together — that is correct, not a fault, and ' +
      'worth saying if they see it happen.\n' +
      'If the tenant is already living there on a paper lease, migrate_existing_tenant is the one.\n' +
      'You need their first name, last name, email AND phone before you can send anything. A '  +
      'landlord who says "the Reyes family are taking 204" has given you a surname and a unit and '  +
      'nothing else \u2014 ask for the rest in one go, and never guess an email. This mails a real '  +
      'person real paperwork: a guessed address sends somebody\u2019s lease to a stranger and reports '  +
      'it back to the landlord as done.',
    params: {
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their last name.' },
      email: { type: 'string', description: 'Their email.' },
      phone: { type: 'string', description: 'Their phone number.' },
      unitId: { type: 'string', description: 'The unit they are moving into, from a lookup.' },
    },
    required: ['firstName', 'lastName', 'email', 'phone', 'unitId'],
    confirmFirst: true,
  },
  {
    id: 'park_pending_tenant',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/onboard-tenant-pending',
    description:
      'Put a tenant on the books with just their name, email and phone, when the landlord does not ' +
      'have the lease to hand yet. Use for "I know they are in 14, I will have to dig the lease out".\n' +
      'NOTHING is sent to the tenant. No account activation, no email — they sit in the pending pool ' +
      'until the landlord uploads the lease and it becomes real, and only then does the tenant hear ' +
      'anything. Say that, because "I added them" sounds like they were contacted.\n' +
      'Naming the unit reserves it: that spot stops being offered for guest bookings while the ' +
      'person is pending, which is what protects a permanent RV tenant mid-migration.\n' +
      'All four \u2014 first name, last name, email, phone \u2014 are required. If the landlord has only '  +
      'some of them, ask for the rest rather than parking a half-identified person on their books.',
    params: {
      firstName: { type: 'string', description: 'Their first name.' },
      lastName: { type: 'string', description: 'Their last name.' },
      email: { type: 'string', description: 'Their email.' },
      phone: { type: 'string', description: 'Their phone number.' },
      unitId: { type: 'string', description: 'The unit they already occupy, from a lookup.' },
    },
    required: ['firstName', 'lastName', 'email', 'phone'],
    confirmFirst: true,
  },
  {
    id: 'cancel_pending_tenant',
    audience: 'landlord', method: 'DELETE', path: '/api/landlords/me/pending-tenants/:intentId',
    pathParams: ['intentId'],
    description:
      'Take somebody out of the pending pool — entered twice, or they never moved in after all. Use ' +
      'for "drop the pending one on 14, that never happened".\n' +
      'If they named a unit, this releases it back to guest bookings. The person heard nothing when ' +
      'they were added, so they hear nothing now either.',
    params: { intentId: { type: 'string', description: 'The pending-tenant id, from a lookup.' } },
    required: ['intentId'],
    confirmFirst: true,
  },

  // ── LANDLORD · odds and ends (S628) ──────────────────────────────────
  {
    id: 'respond_to_dispute',
    audience: 'landlord', method: 'POST', path: '/api/landlords/me/disputes/:disputeId/respond',
    pathParams: ['disputeId'],
    description:
      'Submit the landlord\u2019s evidence and response on a payment dispute. Use for "here is the signed ' +
      'lease and the receipt for that chargeback".\n' +
      'This is a formal response somebody adjudicates, and there is usually one shot at it. Write ' +
      'response_notes in the landlord\u2019s own words and read it back before sending — do not tidy it ' +
      'into something they did not say. Evidence has to be uploaded by them first; you have no file ' +
      'to attach.\n' +
      'You do not advise them on whether they will win. If they ask, that escalates.',
    params: {
      disputeId: { type: 'string', description: 'The dispute id, from a lookup.' },
      evidence: { type: 'object', description: 'The evidence, as named fields pointing at what they uploaded.' },
      response_notes: { type: 'string', description: 'Their account of it, in their own words.' },
    },
    required: ['disputeId'],
    confirmFirst: true,
  },
  {
    id: 'set_portal_theme',
    audience: 'landlord', method: 'PATCH', path: '/api/landlords/theme',
    description:
      'Change the accent colour and font their portal uses. Use for "make it green" — cosmetic, ' +
      'nothing about the business changes.',
    params: {
      themeAccent: { type: 'string', description: 'The accent colour they want.' },
      fontStyle: { type: 'string', description: 'The font style they want.' },
    },
    required: [],
  },
  {
    id: 'set_unit_inspection_attributes',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/inspection-attributes',
    pathParams: ['unitId'],
    description:
      'Record the facts about a unit that change what an inspection checklist asks — whether it has ' +
      'more than one level, whether it is ADA accessible. Use for "204 is a two-storey".\n' +
      'These drive the checklist somebody works through on site, so a wrong one means a missing ' +
      'question rather than a wrong label.',
    params: {
      unitId: { type: 'string', description: 'The unit as the landlord refers to it — the unit NUMBER is fine ("spot 7", "Apt 204", "RV 28"). You do NOT need to look up an id first, and you must never ask them for one: they do not have it. A unit id from a previous lookup also works.' },
      isMultiLevel: { type: 'boolean', description: 'Whether it has more than one level.' },
      isAdaAccessible: { type: 'boolean', description: 'Whether it is ADA accessible.' },
    },
    required: ['unitId'],
    confirmFirst: true,
  },
  {
    id: 'cancel_service_interruption',
    audience: 'landlord', method: 'POST', path: '/api/service-interruptions/:noticeId/cancel',
    pathParams: ['noticeId'],
    description:
      'Call off an outage notice that went out and turned out not to be needed — the shut-off was ' +
      'cancelled, the contractor rescheduled. Use for "water is not going off after all".\n' +
      'Do it quickly. Residents have made arrangements around it, and this is different from ' +
      'resolving one: resolved means it happened and is over, cancelled means it never happened.',
    params: { noticeId: { type: 'string', description: 'The notice id, from get_service_interruptions.' } },
    required: ['noticeId'],
    confirmFirst: true,
  },
  {
    id: 'start_payroll_run',
    audience: 'landlord', method: 'POST', path: '/api/books/payroll/runs',
    description:
      'Calculate a DRAFT payroll run for a pay period. Use for "work up payroll for the first half of ' +
      'March".\n' +
      'Nothing is posted and nobody is paid — this produces figures the landlord reads and then ' +
      'approves, or does not. Hours and withholding are THEIR numbers: hoursMap is hours per ' +
      'employee, taxMap is federal and state withholding per employee, and an employee left out of ' +
      'taxMap withholds nothing beyond Social Security and Medicare. Never estimate either. If they ' +
      'do not have the hours to hand, that is what is needed first.',
    params: {
      periodStart: { type: 'string', description: 'First day of the pay period, YYYY-MM-DD.' },
      periodEnd: { type: 'string', description: 'Last day of the pay period, YYYY-MM-DD.' },
      payDate: { type: 'string', description: 'The day people are paid, YYYY-MM-DD.' },
      payFrequency: { type: 'string', description: 'weekly, biweekly, semimonthly or monthly.' },
      employeeIds: { type: 'array', description: 'Which employees are on this run, from a lookup.' },
      hoursMap: { type: 'object', description: 'Hours worked, keyed by employee id. Their figures, never estimated.' },
      taxMap: { type: 'object', description: 'Federal and state withholding per employee, keyed by employee id. Their figures.' },
    },
    required: ['periodStart', 'periodEnd', 'payDate', 'payFrequency', 'employeeIds'],
    confirmFirst: true,
  },

  // ── TENANT · taking something back (S628) ────────────────────────────
  {
    id: 'withdraw_deposit_report',
    audience: 'tenant', method: 'DELETE', path: '/api/declared-deposits/:reportId',
    pathParams: ['reportId'],
    description:
      'Withdraw a cash-or-cheque payment the tenant reported, when they got it wrong — the wrong ' +
      'amount, the wrong date, or it turned out they had not paid yet. Use for "ignore that, I made ' +
      'a mistake".\n' +
      'Once the landlord has acted on the report it can no longer be withdrawn, and the system says ' +
      'so. That is not a fault: tell them it has already been picked up and that the fix now goes ' +
      'through their landlord.',
    params: { reportId: { type: 'string', description: 'The report id, from their reported payments.' } },
    required: ['reportId'],
    confirmFirst: true,
  },
  // ── LANDLORD · guest bookings on a unit (S628) ───────────────────────
  //
  // An RV park's other half. These are STAYS rather than tenancies — a guest
  // with no account, no lease and no portal, so nothing here notifies them and
  // the host is the one who talks to them.
  {
    id: 'create_unit_booking',
    audience: 'landlord', method: 'POST', path: '/api/units/:unitId/bookings',
    pathParams: ['unitId'],
    description:
      'Book a unit for a guest — a nightly or weekly stay, or a hold on the spot. Use for "put the ' +
      'Hendersons on spot 7, the 12th to the 19th".\n' +
      'checkOut has to be after checkIn and the system says so. A stay that clashes with a lease or ' +
      'another booking is refused; read that back rather than moving somebody.\n' +
      'requiredSiteLayout and requiredAmpService are what the RIG needs — a 50-amp pull-through is ' +
      'not a preference, it is whether they can plug in. Ask if they mentioned a rig at all.\n' +
      'Nothing is emailed to the guest by this. Guest access is sent separately.',
    params: {
      unitId: { type: 'string', description: 'The unit or spot, from a lookup.' },
      leaseType: { type: 'string', description: 'nightly, weekly, month_to_month, long_term, or lease_hold.' },
      checkIn: { type: 'string', description: 'Arrival date, YYYY-MM-DD.' },
      checkOut: { type: 'string', description: 'Departure date, YYYY-MM-DD. Must be after arrival.' },
      guestName: { type: 'string', description: 'The guest\u2019s name.' },
      guestEmail: { type: 'string', description: 'Their email, if the host has it.' },
      guestPhone: { type: 'string', description: 'Their phone number.' },
      nightlyRate: { type: 'number', description: 'The nightly rate for this stay.' },
      weeklyRate: { type: 'number', description: 'The weekly rate for this stay.' },
      totalAmount: { type: 'number', description: 'The total for the stay.' },
      requiredSiteLayout: { type: 'string', description: 'none, back_in or pull_through — what the rig needs.' },
      requiredAmpService: { type: 'string', description: 'none, 30, 50 or both — what the rig needs.' },
      notes: { type: 'string', description: 'Anything about the stay.' },
      source: { type: 'string', description: 'Where the booking came from — a phone call, a walk-up.' },
      tenantId: { type: 'string', description: 'For a stay by somebody who already has an account.' },
    },
    required: ['unitId', 'leaseType', 'checkIn', 'checkOut'],
    confirmFirst: true,
  },
  {
    id: 'update_unit_booking',
    audience: 'landlord', method: 'PATCH', path: '/api/units/:unitId/bookings/:bookingId',
    pathParams: ['unitId', 'bookingId'],
    description:
      'Change a guest booking — its dates, its status, the guest\u2019s details, or move it to a ' +
      'different spot. Use for "they are staying an extra two nights" or "move them to 9, the water ' +
      'is off on 7".\n' +
      'Moving the stay to a different unit is what unitId does here. Cancelling it is a status ' +
      'change, and the guest is NOT told automatically — offer to draft the message, because a guest ' +
      'arriving at a spot that is no longer theirs is the outcome to avoid.',
    params: {
      unitId: { type: 'string', description: 'The unit the booking is currently on, from a lookup.' },
      bookingId: { type: 'string', description: 'The booking id, from a lookup.' },
      status: { type: 'string', description: 'The booking status — confirmed, cancelled, and so on.' },
      checkIn: { type: 'string', description: 'New arrival date, YYYY-MM-DD.' },
      checkOut: { type: 'string', description: 'New departure date, YYYY-MM-DD.' },
      guestName: { type: 'string', description: 'The guest\u2019s name.' },
      guestEmail: { type: 'string', description: 'Their email.' },
      guestPhone: { type: 'string', description: 'Their phone.' },
      requiredSiteLayout: { type: 'string', description: 'What the rig needs.' },
      requiredAmpService: { type: 'string', description: 'What the rig needs.' },
      lockedToUnit: { type: 'boolean', description: 'true to stop the booking being moved to another spot automatically.' },
      notes: { type: 'string', description: 'Notes on the stay.' },
    },
    required: ['unitId', 'bookingId'],
    confirmFirst: true,
  },
  {
    id: 'send_guest_access',
    audience: 'landlord', method: 'POST',
    path: '/api/units/:unitId/bookings/:bookingId/guest-access',
    pathParams: ['unitId', 'bookingId'],
    description:
      'Give a guest their access link for a booking — emailed to them, or as a QR code the host can ' +
      'show or print. Use for "send the Hendersons their check-in details".\n' +
      'A guest has no account, so this link IS their way in. Confirm the email address out loud ' +
      'before sending: a typo means somebody who has paid for a stay arrives with nothing.',
    params: {
      unitId: { type: 'string', description: 'The unit, from a lookup.' },
      bookingId: { type: 'string', description: 'The booking id, from a lookup.' },
      delivery: { type: 'string', description: 'email or qr.' },
      sendEmail: { type: 'boolean', description: 'Whether to email it to the guest.' },
    },
    required: ['unitId', 'bookingId'],
    confirmFirst: true,
  },
  {
    id: 'revoke_guest_access',
    audience: 'landlord', method: 'DELETE',
    path: '/api/units/:unitId/bookings/:bookingId/guest-access',
    pathParams: ['unitId', 'bookingId'],
    description:
      'Revoke a guest\u2019s access link. Use for "kill the link for spot 7, that booking is off".\n' +
      'The link stops working immediately, and the guest is not told — so if they are still expected, ' +
      'this is not what the host meant. Ask which they want.',
    params: {
      unitId: { type: 'string', description: 'The unit, from a lookup.' },
      bookingId: { type: 'string', description: 'The booking id, from a lookup.' },
    },
    required: ['unitId', 'bookingId'],
    confirmFirst: true,
  },
  {
    id: 'acknowledge_booking_rules',
    audience: 'landlord', method: 'PATCH',
    path: '/api/units/:unitId/bookings/:bookingId/acknowledge',
    pathParams: ['unitId', 'bookingId'],
    description:
      'Record that the guest signed the property rules for their stay. Use for "the Hendersons signed ' +
      'the park rules".\n' +
      'This is the HOST confirming they saw it signed. Only mark it when the landlord says the guest ' +
      'actually signed — it is a record of something that happened, not a box to tidy.',
    params: {
      unitId: { type: 'string', description: 'The unit, from a lookup.' },
      bookingId: { type: 'string', description: 'The booking id, from a lookup.' },
    },
    required: ['unitId', 'bookingId'],
    confirmFirst: true,
  },

  // ── LANDLORD · the last of onboarding, and the applicant pool ────────
  {
    id: 'resolve_pending_tenant',
    audience: 'landlord', method: 'POST',
    path: '/api/landlords/me/pending-tenants/:intentId/resolve',
    pathParams: ['intentId'],
    description:
      'Turn a pending tenant into a real lease, once their lease document has been read. Use for "go ' +
      'ahead and set up the Alvarez lease from that PDF".\n' +
      'The terms come from the parsed document. landlordOverrides is for the fields the parser got ' +
      'wrong or could not find — send only what the LANDLORD corrected, in their words, and read each ' +
      'correction back. Do not override a figure because it looks odd to you.\n' +
      'If the unit already has a sitting lease, resolving into it ENDS that lease, and the system ' +
      'stops and asks. Never send confirmSupersede without saying whose tenancy ends and getting a ' +
      'yes to that specific thing.',
    params: {
      intentId: { type: 'string', description: 'The pending-tenant id, from a lookup.' },
      landlordOverrides: { type: 'object', description: 'Fields the landlord corrected on the parsed lease. Only what they actually corrected.' },
      confirmSupersede: { type: 'boolean', description: 'Only after they have heard that the sitting lease on that unit will END, and said yes to it.' },
    },
    required: ['intentId'],
    confirmFirst: true,
  },
  {
    id: 'reach_out_to_applicant',
    audience: 'landlord', method: 'POST', path: '/api/background/pool/:poolId/reach-out',
    pathParams: ['poolId'],
    description:
      'Contact somebody in the renter pool about a unit. Use for "get in touch with that applicant ' +
      'about spot 9".\n' +
      'This reaches a real person who is looking for somewhere to live, so the message is the ' +
      'landlord\u2019s and it goes out in their words. Offer a unit only if they named one — the unit ' +
      'has to be genuinely available, and the system refuses one with a lease or a booking on it.\n' +
      'One approach per applicant: a second is refused, and that is correct rather than something to ' +
      'retry. GAM is a conduit here and not a screening agency, so never characterise the person to ' +
      'the landlord beyond what the pool entry says.',
    params: {
      poolId: { type: 'string', description: 'The pool entry id, from a lookup.' },
      unitId: { type: 'string', description: 'The unit being offered, from a lookup. It must be available.' },
      message: { type: 'string', description: 'What the landlord wants to say, in their words. The applicant reads this.' },
    },
    required: ['poolId'],
    confirmFirst: true,
  },

  // ── TENANT · the pool, reapplying, and hardship ──────────────────────
  {
    id: 'respond_to_landlord_interest',
    audience: 'tenant', method: 'PATCH', path: '/api/background/pool/match/:matchId/respond',
    pathParams: ['matchId'],
    description:
      'Answer a landlord who reached out through the renter pool — interested, or not. Use for "yes, ' +
      'tell them I want to see it" or "not that one".\n' +
      'Saying no closes that one approach and nothing else; they stay in the pool for other ' +
      'landlords. Saying yes passes their answer and their message on. Either way it can only be ' +
      'answered once, so make sure it is what they meant.',
    params: {
      matchId: { type: 'string', description: 'The approach id, from their notifications.' },
      interested: { type: 'boolean', description: 'true if they want to hear more, false if not.' },
      message: { type: 'string', description: 'Anything they want to say back, in their words.' },
    },
    required: ['matchId', 'interested'],
    confirmFirst: true,
  },
  {
    id: 'reapply_after_denial',
    audience: 'tenant', method: 'POST', path: '/api/background/reapply',
    description:
      'Start a fresh application after one was denied. Use for "can I try again?".\n' +
      'There is a cooldown after a denial and it is not waivable. If they are still inside it the ' +
      'system says how many days are left — give them that number plainly rather than a vague "not ' +
      'yet", and do not speculate about whether a new application would go better.',
    params: {},
    required: [],
    confirmFirst: true,
  },
  {
    id: 'record_hardship_context',
    audience: 'tenant', method: 'POST', path: '/api/credit/hardship-context',
    description:
      'Record a period of genuine hardship against the tenant\u2019s rent record — a job loss, a medical ' +
      'event, a death in the family — so that a stretch of late payments has its reason attached ' +
      'rather than standing bare. Use when they explain WHY they fell behind.\n' +
      'Do not promise this changes an outcome, because you do not know that it will. What it does is ' +
      'make sure the context travels with the record instead of being lost.\n' +
      'Take the dates and the category from them. This is their account of their own life and it is ' +
      'not yours to characterise or to tidy — if they say it started in March, it started in March.',
    params: {
      category: { type: 'string', description: 'What kind of hardship it was, as they describe it.' },
      startDate: { type: 'string', description: 'When it began, YYYY-MM-DD.' },
      endDate: { type: 'string', description: 'When it ended, YYYY-MM-DD. Leave out if it is ongoing.' },
      note: { type: 'string', description: 'What happened, in their words.' },
    },
    required: ['category', 'startDate'],
    confirmFirst: true,
  },
]

const BY_ID = new Map(PORTAL_ACTIONS.map((a) => [a.id, a]))
export function getPortalAction(id: string): PortalAction | undefined { return BY_ID.get(id) }
export function portalActionsFor(audience: AgentAudience): PortalAction[] {
  return PORTAL_ACTIONS.filter((a) => a.audience === audience)
}
