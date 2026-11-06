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
  // 10/6 (Nic): the credit GAM writes to net out a late fee a bank deposit's
  // date shows was never owed — the fee stays as charged and this pays it
  // ("they get a credit against their bill"). services/lateFeeCredit.
  'late_fee_credit',
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
  late_fee_credit:   'Late fee credited',
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
 * released ∈ payment_failed | payment_canceled | superseded (a held use);
 * late_fee_credit_withdrawn (10/6: a late-fee credit taken back off its late
 * fee — an undone bank match, or the fee deleted in the onboarding month);
 * credit_undone (10/18: a credit the landlord gave, taken back whole because
 * it was typed by mistake — what it paid comes back off every bill it paid);
 * reversed = funding_reversed.
 */
export const CREDIT_USE_RELEASE_REASONS = ['payment_failed', 'payment_canceled', 'superseded', 'funding_reversed', 'late_fee_credit_withdrawn', 'credit_undone'] as const
export type CreditUseReleaseReason = typeof CREDIT_USE_RELEASE_REASONS[number]
export const CREDIT_USE_RELEASE_REASON_LABEL: Record<CreditUseReleaseReason, string> = {
  payment_failed:   'The payment failed',
  payment_canceled: 'The payment was canceled',
  superseded:       'Replaced by a newer payment',
  funding_reversed: 'The money behind the credit was returned or disputed',
  late_fee_credit_withdrawn: 'The late-fee credit was taken back',
  credit_undone: 'The credit was undone',
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
/**
 * 10/11 (Nic): "incoming income type pools, monthly, daily, electric bill back,
 * etc." Lot/space rent split by HOW the space is rented — a lease's own rent,
 * or the rent of a stay drafted from a nightly, weekly or monthly reservation
 * (unit_bookings.lease_type of the lease's source booking). The other pools are
 * INCOME_CATEGORIES as they are. Read by the shared Income page.
 */
export const RENT_POOLS = ['monthly_rent', 'nightly_stays', 'weekly_stays', 'month_stays'] as const
export type RentPool = typeof RENT_POOLS[number]
export const RENT_POOL_LABEL: Record<RentPool, string> = {
  monthly_rent:  'Monthly rent',
  nightly_stays: 'Nightly stays',
  weekly_stays:  'Weekly stays',
  month_stays:   'Month stays',
}

/** The utility categories, in report order. A utility type outside this list is utility_other. */
export const INCOME_UTILITY_CATEGORIES = ['electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other'] as const satisfies readonly IncomeCategory[]

// ─── Database enum mirrors touched by the money plan ─────────────────────────

/** Mirrors platform_revenue_ledger_type_check (M2 adds flexpay_subscription). */
export const PLATFORM_REVENUE_TYPES = [
  'banking_spread', 'manual_withdrawal_fee', 'placement_fee_share',
  'platform_fee_subscription', 'screening_margin', 'adjustment', 'flexpay_subscription',
  // 10/12 (Nic): a card reader's markup — what GAM charged the landlord less
  // GAM's actual cost of the reader. Only the markup is earnings; the cost
  // part of the payments is GAM's money coming back (readerOrderMoney).
  'device_markup',
  // 10/27: FlexDeposit, which until now earned money with nowhere to put it —
  // the fee was a payments row and never reached this book, while FlexPay's
  // cycle fee always did. The last two are the OTHER side of the product:
  // GAM covers a landlord for the part of a deposit a resident never funded
  // ("The landlord gets what they're owed, full stop"), so that outflow is a
  // line here rather than an 'adjustment'. See the migration
  // 20261028020000_flexdeposit_revenue_and_reserve.sql.
  'flexdeposit_fee',
  'flexdeposit_move_fee',
  /** NEGATIVE — cash paid to a landlord for an unfunded deposit. */
  'flexdeposit_shortfall',
  /** That money coming back, when a resident later pays through GAM. */
  'flexdeposit_recovery',
  // 10/29 (Nic): GAM's 15% of a left-owing settlement, "for the coordination".
  // Booked per collection as it arrives, never on the arrangement — a debt
  // that is part-paid earns GAM only the part that was paid.
  'left_owing_share',
  // 10/31 (Nic): 3% of a finished contractor-marketplace job, off the
  // contractor's payout. Booked when the job is marked complete, against the
  // amount it ACTUALLY finished at, at the rate snapshotted when it was
  // awarded. Nothing is earned on a job that is merely bid or awarded — the
  // whole competitive position is that GAM charges for won, finished work and
  // never for a listing or a lead.
  'marketplace_job_cut',
] as const
export type PlatformRevenueTypeValue = typeof PLATFORM_REVENUE_TYPES[number]

/**
 * 10/27 — the types the FlexDeposit reserve is computed from.
 *
 * The reserve is simply what FlexDeposit has earned less what it has paid out,
 * so it is a SUM over exactly these four and nothing else: GAM's other revenue
 * lines (rent spread, subscriptions, screening) are not standing behind this
 * product and must not inflate the number that decides how many plans can be
 * taken on.
 *
 * Signs are already correct in the rows, so the reserve is a plain SUM(amount)
 * — never a sum of absolute values, and never read off balance_after, which a
 * backdated row restates (services/platformRevenue.ts).
 */
export const FLEXDEPOSIT_RESERVE_TYPES = [
  'flexdeposit_fee', 'flexdeposit_move_fee',
  'flexdeposit_shortfall', 'flexdeposit_recovery',
] as const satisfies readonly PlatformRevenueTypeValue[]

/**
 * Mirrors held_payout_items_source_type_check.
 *
 * 10/27: this WAS a second hand-written copy of the same list that
 * landlordGamMoney.ts holds as HELD_ITEM_SOURCES, and the two drifted the
 * moment a source type was added — the CHECK and one list moved, the other did
 * not, and migrations.creditUses.test.ts went red for a list nobody knew was a
 * duplicate. CLAUDE.md's rule is one definition per allowed-value set, so this
 * is now an alias of that one and cannot drift again.
 */
export { HELD_ITEM_SOURCES as HELD_PAYOUT_SOURCE_TYPES } from './landlordGamMoney'
export type { HeldItemSource as HeldPayoutSourceType } from './landlordGamMoney'

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
export const BANK_MATCH_KINDS = ['gam_payout', 'tenant_deposit', 'deposit_slip', 'auto_filed', 'returned_check'] as const
export type BankMatchKind = typeof BANK_MATCH_KINDS[number]
export const BANK_MATCH_KIND_LABEL: Record<BankMatchKind, string> = {
  gam_payout:     'GAM payout',
  tenant_deposit: 'Tenant’s bank deposit',
  deposit_slip:   'Bank deposit slip',
  auto_filed:     'Filed by itself',
  // 10/14 (Nic, answer 15): a check the bank returned out of a deposit, taken back by itself.
  returned_check: 'Returned check',
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
 * equal.
 *
 * 10/27: this is the FIRST rung of a ladder, and the "a second time ends
 * FlexPay for good (S578)" that used to be written here is gone — see
 * FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS.
 */
export const FLEXPAY_REJOIN_WAIT_DAYS = 90

/**
 * 10/27 (Nic) — THE COOL-OFF LADDER, AND WHY IT IS COUNTED IN DAYS ON GAM.
 *
 *   "90 days is a cool-off period before they're re-invited for the first
 *    time. After that, the time might be longer. 6 months the second time and
 *    a year the third time."
 *
 * Indexed by how many times they have defaulted, so the 1st default waits the
 * 90 days above, the 2nd six months, the 3rd and anything after it a year.
 * Getting current is a SEPARATE condition and both must hold: "They can't just
 * get back in if they haven't paid what they owe."
 *
 * These are days OF TENANCY ON THE PLATFORM, not calendar days:
 *
 *   "If they're 3 months into their year-long cooldown and they switch
 *    landlords, that cooldown only counts while they're on GAM. So if they
 *    leave GAM for 2 years, they need to be back on GAM for the remaining 9
 *    months."
 *
 * Which is why nothing stores an end date — a stored date keeps ticking while
 * somebody is gone. services/flexpay.ts computes the elapsed figure from the
 * tenant's actual leases (flexPayCooldown).
 *
 * This REPLACES the S578 rule that a 2nd lifetime default was terminal. A
 * permanent ban and a six-month second cool-off cannot both be true.
 */
export const FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS = [90, 182, 365] as const

/** The cool-off for an Nth default, in days on the platform. */
export function flexPayCooldownDays(defaultCount: number): number {
  if (!Number.isFinite(defaultCount) || defaultCount <= 0) return 0
  const i = Math.min(Math.trunc(defaultCount), FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS.length) - 1
  return FLEXPAY_COOLDOWN_ON_PLATFORM_DAYS[i]
}

/**
 * 10/27 (Nic) — WHAT A SECOND CHANCE COSTS.
 *
 *   "they can get back on at the same price the first time. I get that things
 *    happen. Maybe somebody had an issue with their bank... Maybe we have a
 *    tier up for re-entry pricing. Every chart on the table, every possible
 *    price point on that chart would be $5 more on a re-entry. I think that
 *    keeps it simple."
 *
 * So the FIRST return is at the ordinary grid price, and from the second
 * default onward every bracket in every Wednesday column is $5 dearer. One
 * flat step, not an escalating one — he asked for simple.
 *
 * It is NOT risk pricing keyed to anything about the person: it is keyed to a
 * count of times GAM could not collect, which is a fact about this account's
 * own history with this product. The grid itself stays uniform for everybody
 * on the same rung.
 */
export const FLEXPAY_REENTRY_SURCHARGE = 5

/** Dearer by the surcharge from the second default on; the grid price before. */
export function flexPayReentrySurcharge(defaultCount: number): number {
  return Number.isFinite(defaultCount) && defaultCount >= 2 ? FLEXPAY_REENTRY_SURCHARGE : 0
}

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
