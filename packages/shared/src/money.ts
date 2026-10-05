// S655 money plan (Step 1): the shared vocabulary for credits, the two report
// bases, the property breakdown, bank deposits and FlexPay.
//
// One definition of each allowed-value set, mirrored by the database CHECKs
// named beside it. Every app and route imports from here; nothing re-declares
// these lists. Displayed values go through the *_LABEL maps, never through the
// raw value.
//
// This file imports nothing from index.ts (index.ts re-exports it), so there is
// no load-order cycle.

// ─── Credit ledger (credit_uses) ─────────────────────────────────────────────

/** Which path spent a credit. Mirrors credit_uses_source_check (M4). */
export const CREDIT_USE_SOURCES = [
  'portal', 'autopay', 'front_desk_reader', 'desk', 'landlord_agent',
  'whole_bill', 'move_out', 'reversal', 'backfill',
  // 10/4 (decisions #38 Q8): paid-ahead money refunded at a long stay's early
  // check-out (credit_uses.refund_part_id → stay_refund_parts).
  'refund',
  // 10/4 (decisions #46.1): the rest of the paid-ahead money left on an ended
  // lease after the landlord's choice — kept by the landlord, or left as the
  // tenant's account credit (credit_uses.paid_ahead_choice_id → paid_ahead_choices).
  'paid_ahead_choice',
] as const
export type CreditUseSource = typeof CREDIT_USE_SOURCES[number]
export const CREDIT_USE_SOURCE_LABEL: Record<CreditUseSource, string> = {
  portal:            'Tenant portal',
  autopay:           'Autopay',
  front_desk_reader: 'Card reader at the front desk',
  desk:              'Front desk',
  landlord_agent:    'Landlord assistant',
  whole_bill:        'Paid the whole bill by itself',
  move_out:          'Move-out',
  reversal:          'Dispute or bank return',
  backfill:          'Recorded from history',
  refund:            'Refunded at an early check-out',
  paid_ahead_choice: 'Landlord chose after the lease ended',
}

/** Sources that may set credit aside while a Stripe charge clears (credit_uses_held_rides_a_charge). */
export const CREDIT_USE_HOLDING_SOURCES = ['portal', 'autopay', 'front_desk_reader'] as const satisfies readonly CreditUseSource[]

/** Mirrors credit_uses_status_check (M4). */
export const CREDIT_USE_STATUSES = ['held', 'applied', 'released', 'reversed'] as const
export type CreditUseStatus = typeof CREDIT_USE_STATUSES[number]
export const CREDIT_USE_STATUS_LABEL: Record<CreditUseStatus, string> = {
  held:     'Set aside while the payment clears',
  applied:  'Used',
  released: 'Given back',
  reversed: 'Undone (the money behind it was returned)',
}
/** A held or applied use is live: it has taken money off the credit. */
export const CREDIT_USE_LIVE_STATUSES = ['held', 'applied'] as const satisfies readonly CreditUseStatus[]

/**
 * Why a use stopped being live. Mirrors credit_uses_status_stamps (M4):
 * released ∈ payment_failed | payment_canceled | superseded;
 * reversed = funding_reversed.
 */
export const CREDIT_USE_RELEASE_REASONS = ['payment_failed', 'payment_canceled', 'superseded', 'funding_reversed'] as const
export type CreditUseReleaseReason = typeof CREDIT_USE_RELEASE_REASONS[number]
export const CREDIT_USE_RELEASE_REASON_LABEL: Record<CreditUseReleaseReason, string> = {
  payment_failed:   'The payment failed',
  payment_canceled: 'The payment was canceled',
  superseded:       'Replaced by a newer payment',
  funding_reversed: 'The money behind the credit was returned or disputed',
}
/** The reasons a HELD use may be released for (everything but funding_reversed). */
export const CREDIT_USE_HELD_RELEASE_REASONS = ['payment_failed', 'payment_canceled', 'superseded'] as const satisfies readonly CreditUseReleaseReason[]
export type CreditUseHeldReleaseReason = typeof CREDIT_USE_HELD_RELEASE_REASONS[number]

/** v_credit_uses.kind. */
export const CREDIT_KINDS = ['issued', 'deposit_interest', 'paid_ahead'] as const
export type CreditKind = typeof CREDIT_KINDS[number]
export const CREDIT_KIND_LABEL: Record<CreditKind, string> = {
  issued:           'Credit from the landlord',
  deposit_interest: 'Deposit interest',
  paid_ahead:       'Paid ahead',
}

/** Who holds paid-ahead money. Mirrors lease_prepaid_credits_funded_by_check (M3). */
export const PREPAID_FUNDED_BY = ['landlord', 'gam', 'reclassified'] as const
export type PrepaidFundedBy = typeof PREPAID_FUNDED_BY[number]
export const PREPAID_FUNDED_BY_LABEL: Record<PrepaidFundedBy, string> = {
  landlord:     'Paid ahead (landlord took it)',
  gam:          'Paid ahead through GAM',
  reclassified: 'Stay shortened',
}

// ─── Reports: "Money received" / "Money billed" ──────────────────────────────

export const INCOME_BASES = ['received', 'billed'] as const
export type IncomeBasis = typeof INCOME_BASES[number]
export const DEFAULT_INCOME_BASIS: IncomeBasis = 'received'
export const INCOME_BASIS_LABEL: Record<IncomeBasis, string> = {
  received: 'Money received',
  billed:   'Money billed',
}
/**
 * The note shown on every report and returned as meta.basis.
 *
 * Nic (10/2): "Money received" is strictly the day money ARRIVED. Todd
 * Niemeyer's one check for two months counts in full in September; October is
 * $0 from him when the paid-ahead half pays October's rent.
 */
export const INCOME_BASIS_NOTE: Record<IncomeBasis, string> = {
  received:
    'Counted on the day the money arrived. Money paid ahead counts when it arrives, not again when it pays a later bill. A credit you give is never income.',
  billed:
    "Counted in the month each bill was due, paid or not. 'Still owed' is inside the total; 'Collected so far' is beside it. A credit you give comes off as 'Credits given'.",
}

/** The lines of a landlord P&L's income block. */
export const INCOME_LINES = [
  'rent', 'fees', 'utilities', 'lateFees', 'homeSale', 'balances',
  'paidAhead',
  'keptFromDeposits', 'depositDeductions', 'depositShortfall',
  'registerAndStays', 'otherIncome',
  'returned', 'stayShortened', 'creditsGiven', 'paidAheadRefunded',
] as const
export type IncomeLine = typeof INCOME_LINES[number]
export const INCOME_LINE_LABEL: Record<IncomeLine, string> = {
  rent:              'Rent',
  fees:              'Fees',
  utilities:         'Utilities',
  lateFees:          'Late fees',
  homeSale:          'Home/trailer payments',
  balances:          'Balances collected',
  paidAhead:         'Paid ahead for later bills',
  keptFromDeposits:  'Kept from deposits',
  depositDeductions: 'Deposit deductions kept',
  depositShortfall:  'Deposit shortfall collected',
  registerAndStays:  'Register sales, stays and pay links',
  otherIncome:       'Other income',
  returned:          'Returned or disputed',
  stayShortened:     'Stay shortened',
  creditsGiven:      'Credits given',
  paidAheadRefunded: 'Paid-ahead money refunded',
}
/** Lines that only ever take money OFF the total (shown as negatives). */
export const INCOME_NEGATIVE_LINES = ['returned', 'stayShortened', 'creditsGiven', 'paidAheadRefunded'] as const satisfies readonly IncomeLine[]

/** "Money billed": what became of each billed dollar, as of today. They add up to the bill. */
export const BILLED_PARTS = ['paid', 'clearing', 'coveredByPaidAhead', 'coveredByDepositInterest', 'keptFromDeposit', 'stillOwed'] as const
export type BilledPart = typeof BILLED_PARTS[number]
export const BILLED_PART_LABEL: Record<BilledPart, string> = {
  paid:                     'Paid',
  clearing:                 'Still clearing',
  coveredByPaidAhead:       'Covered by money paid ahead',
  coveredByDepositInterest: 'Covered by deposit interest',
  keptFromDeposit:          'Kept from deposit',
  stillOwed:                'Still owed',
}

/**
 * Decision #4 (Nic, 10/2): the property report leads with income BY CATEGORY,
 * billed vs collected, in this order. The dashboard property-health card reads
 * the same totals.
 */
export const INCOME_CATEGORIES = [
  'space_rent',
  'electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other',
  'late_fees',
  'home_payments',
  'other_fees',
  'balances_collected',
  'register_sales',
  'stays_and_pay_links',
  'other_income',
] as const
export type IncomeCategory = typeof INCOME_CATEGORIES[number]
export const INCOME_CATEGORY_LABEL: Record<IncomeCategory, string> = {
  space_rent:          'Lot/space rent',
  electric:            'Electric',
  water:               'Water',
  sewer:               'Sewer',
  gas:                 'Natural gas',
  trash:               'Trash',
  propane:             'Propane',
  utility_other:       'Other utilities',
  late_fees:           'Late fees',
  home_payments:       'Home/trailer payments',
  other_fees:          'Other fees',
  balances_collected:  'Balances collected',
  register_sales:      'Register sales',
  stays_and_pay_links: 'Stays and pay links',
  other_income:        'Other income',
}
/** The utility categories, in report order. A utility type outside this list is utility_other. */
export const INCOME_UTILITY_CATEGORIES = ['electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other'] as const satisfies readonly IncomeCategory[]

// ─── Database enum mirrors touched by the money plan ─────────────────────────

/** Mirrors platform_revenue_ledger_type_check (M2 adds flexpay_subscription). */
export const PLATFORM_REVENUE_TYPES = [
  'banking_spread', 'manual_withdrawal_fee', 'placement_fee_share',
  'platform_fee_subscription', 'screening_margin', 'adjustment', 'flexpay_subscription',
] as const
export type PlatformRevenueTypeValue = typeof PLATFORM_REVENUE_TYPES[number]

/** Mirrors held_payout_items_source_type_check (M11 adds deposit_settlement). */
export const HELD_PAYOUT_SOURCE_TYPES = [
  'pos_sale', 'booking_deposit', 'business_invoice_payment', 'business_pos_sale',
  'refund', 'dispute', 'platform_fee', 'prepaid_draw', 'deposit_settlement',
] as const
export type HeldPayoutSourceType = typeof HELD_PAYOUT_SOURCE_TYPES[number]

// ─── Bank: deposit slips, match kinds, rent channels ─────────────────────────

/** Mirrors bank_deposit_slips_status_check (M8). */
export const DEPOSIT_SLIP_STATUSES = ['open', 'matched', 'void'] as const
export type DepositSlipStatus = typeof DEPOSIT_SLIP_STATUSES[number]
export const DEPOSIT_SLIP_STATUS_LABEL: Record<DepositSlipStatus, string> = {
  open:    'Waiting for the bank',
  matched: 'Matched to the bank',
  void:    'Voided',
}

/** Mirrors bank_deposit_slips_source_check (M8). */
export const DEPOSIT_SLIP_SOURCES = ['staff', 'inferred'] as const
export type DepositSlipSource = typeof DEPOSIT_SLIP_SOURCES[number]
export const DEPOSIT_SLIP_SOURCE_LABEL: Record<DepositSlipSource, string> = {
  staff:    'Made by staff',
  inferred: 'Worked out by GAM',
}

/**
 * What a matched money-in bank row was matched TO. index.ts's
 * BANK_TXN_MATCH_KINDS is this same list (one definition).
 */
export const BANK_MATCH_KINDS = ['gam_payout', 'tenant_deposit', 'deposit_slip', 'auto_filed'] as const
export type BankMatchKind = typeof BANK_MATCH_KINDS[number]
export const BANK_MATCH_KIND_LABEL: Record<BankMatchKind, string> = {
  gam_payout:     'GAM payout',
  tenant_deposit: 'Tenant’s bank deposit',
  deposit_slip:   'Bank deposit slip',
  auto_filed:     'Filed by itself',
}

/**
 * Payers that send landlords RENT from other software. A deposit from one of
 * these is never filed as other income by itself, however often the landlord
 * filed one before (risk: rent mis-filed as income). Normalized the way
 * bankFeed.normalizeMerchant normalizes a memo (upper case, words only).
 * Combined brands are listed by each name a memo may carry
 * (Zego/PayLease, RentCafe/Yardi).
 */
export const RENT_CHANNEL_PAYERS = [
  'DOORLOOP', 'APPFOLIO', 'BUILDIUM', 'RENTREDI', 'AVAIL', 'TENANTCLOUD',
  'ZILLOW', 'COZY', 'ZEGO', 'PAYLEASE', 'CLICKPAY', 'RENTCAFE', 'YARDI',
  'RENTEC', 'INNAGO', 'BASELANE', 'STESSA',
] as const

/**
 * True when a bank memo (raw or already normalized) names a rent channel, as a
 * whole word: "DOORLOOP INC PAYOUT" is, "AVAILABLE BALANCE" is not.
 */
export function isRentChannelPayer(memo: string | null | undefined): boolean {
  if (!memo) return false
  const words = ` ${String(memo).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  return RENT_CHANNEL_PAYERS.some(p => words.includes(` ${p} `))
}

// ─── FlexPay ─────────────────────────────────────────────────────────────────

/** Nic (10/2): no FlexPay pull on the 1st through the 5th. */
export const FLEXPAY_FORBIDDEN_PULL_DAYS = [1, 2, 3, 4, 5] as const
/** A failed pull is tried again this many calendar days later. */
export const FLEXPAY_PULL_RETRY_DAYS = 3
/** At most this many retries after the first failed pull (2 retries in all). */
export const FLEXPAY_PULL_MAX_RETRIES = 2
/**
 * What a retry adds: the fee GAM is charged when a bank sends a FlexPay pull
 * back, passed on at cost with no markup (CLAUDE.md FlexPay; FlexPay terms
 * § 4.2). The FlexPay service charges it as FLEXPAY_ACH_RETURN_FEE
 * (apps/api/src/services/flexpay.ts); a test holds the two equal.
 */
export const FLEXPAY_RETURNED_PULL_FEE = 4
/**
 * Days a tenant cannot join FlexPay again after GAM could not collect a pull
 * on its last try: the last retry, or the first try on a closed bank account,
 * which is never retried (Consumer ToS § 9.2). Only a terminal failure ends
 * FlexPay; a failed first retry with the second still scheduled does not. The
 * FlexPay service locks it as FLEXPAY_NSF_COOLDOWN_DAYS; a test holds the two
 * equal. A second time ends FlexPay for that tenant for good (S578).
 */
export const FLEXPAY_REJOIN_WAIT_DAYS = 90

export interface FlexPayTermsSection {
  key: string
  title: string
  body: string
}

/**
 * The FlexPay terms, in plain words: ONE set of sections that the tenant app,
 * the terms PDF, emails and admin all render, so they cannot drift from each
 * other or from the code. Every figure is the code's own: the $25 is
 * PLATFORM_FEES.FLOAT_FEE_MO, the retry schedule FLEXPAY_PULL_RETRY_DAYS and
 * FLEXPAY_PULL_MAX_RETRIES, the $4 FLEXPAY_RETURNED_PULL_FEE and the wait
 * FLEXPAY_REJOIN_WAIT_DAYS (all tested against the text).
 *
 * Words matter here (CLAUDE.md, S304): FlexPay is a subscription, never framed
 * as a loan. No "borrow", "lend", "repay" or "owe GAM"; GAM "collects" on the
 * pull day, and anything not collected is the tenant's GAM balance, taken first
 * from their next payment through GAM (Consumer ToS GAM-first routing).
 */
export const FLEXPAY_TERMS: readonly FlexPayTermsSection[] = [
  {
    key: 'covers_the_bill',
    title: 'FlexPay pays your monthly bill on time',
    body:
      'FlexPay is a payment-date subscription. If your monthly bill is still open on the last day of your grace period, FlexPay pays the whole bill to your landlord that day: the rent, the utilities and the other fees on that month\'s bill. ' +
      'Those lines are paid before your grace period ends, so no late fee applies to them. ' +
      'FlexPay does not pay late fees already charged, balances from earlier months, a security deposit or any other refundable deposit, a home payment (a payment toward buying your home), GAM\'s own fees, or a line whose payment is already in progress. ' +
      'Those stay yours to pay, and a line still open after your grace period can draw your landlord\'s late fee. Credit saved on your account stays yours: FlexPay does not use it.',
  },
  {
    key: 'pull_day',
    title: 'GAM collects on your pull day',
    body:
      'On the pull day you chose, GAM collects the amount FlexPay paid plus the $25 monthly fee from your bank account, in one payment. Your pull day can be any day from the 6th through the 28th. The 1st through the 5th are not offered.',
  },
  {
    key: 'monthly_fee',
    title: 'The $25 monthly fee',
    body:
      'FlexPay costs $25 for every month you are enrolled, whether it pays a large bill, a small one or nothing. In a month you pay your bill yourself before the grace period ends, FlexPay pays nothing and GAM takes only the $25 on your pull day.',
  },
  {
    key: 'failed_pull',
    title: 'If a payment to GAM does not go through',
    body:
      `If your bank sends the payment back because there was not enough money in the account, GAM tries again ${FLEXPAY_PULL_RETRY_DAYS} calendar days later, up to ${FLEXPAY_PULL_MAX_RETRIES} retries in all. ` +
      `Each retry also collects $${FLEXPAY_RETURNED_PULL_FEE}: the fee GAM is charged when a bank sends a payment back, passed on at cost with no markup, once for each time your bank has sent this payment back so far. ` +
      'A payment refused because the bank account is closed is not tried again. ' +
      'Anything not collected becomes your GAM balance, which is taken first from the next payment you make through GAM.',
  },
  {
    key: 'rejoining',
    title: 'If GAM cannot collect after the last try',
    body:
      'The last try is the last retry, or the first try when the bank account is closed. ' +
      `If it does not go through, your FlexPay ends, and you cannot join FlexPay again for ${FLEXPAY_REJOIN_WAIT_DAYS} days. ` +
      'The same happens if bank payments are stopped on your account after a returned payment, or there is no verified bank account on your account: FlexPay ends, and a bill it has not paid yet stays yours to pay. ' +
      'You can join again only after the wait, and once what FlexPay paid and its fee have been collected. ' +
      'If it happens a second time, you cannot join FlexPay again. ' +
      'A problem on GAM\'s side never counts against you: FlexPay keeps going, GAM collects once the problem is fixed, and if that problem made a bill late, GAM pays the late fee.',
  },
  {
    key: 'autopay',
    title: 'Autopay is turned off',
    body:
      'Joining FlexPay turns autopay off for your bill, because FlexPay pays the bill and GAM collects on your pull day.',
  },
]
