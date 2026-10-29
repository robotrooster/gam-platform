/**
 * 10/20 (Nic) — THE WORDS FOR "THIS LOOKS LIKE THE SAME PERSON".
 *
 *   "for merging two people, bring it up to the landlord. Say, hey, this looks
 *    like the same person. They have the same name. Same email, or maybe the
 *    email's different, but the phone number's the same. Or maybe the phone
 *    number is off by like 1. Maybe it's a typo. There's a lot of ways to kind
 *    of clarify that. But have it be always have the landlord check that the
 *    customer is the same."
 *
 * One list of signals, one list of confidences, one set of English sentences
 * for both of them — so the API that scores a pair and the screen that asks
 * about it can never disagree about what a signal is or what it means. Nothing
 * stored here is ever printed raw; every value has a sentence beside it.
 */

/**
 * WHAT MADE US ASK. Deliberately the five Nic named and nothing invented
 * beside them.
 *
 * `name_exact` on its own is never a proposal and never will be — two Smiths
 * at an RV park are two people. A name signal is the thing every rule below
 * REQUIRES, not the thing any rule rests on.
 */
export const DUPLICATE_SIGNALS = [
  'name_exact',
  'name_weak',
  'email_exact',
  'phone_exact',
  'phone_typo',
] as const
export type DuplicateSignal = typeof DUPLICATE_SIGNALS[number]

/** Each signal in the landlord's words, as a sentence about the two records. */
export const DUPLICATE_SIGNAL_LABEL: Record<DuplicateSignal, string> = {
  name_exact: 'Same name',
  name_weak:  'Nearly the same name — an initial or a shortened first name',
  email_exact: 'Same email address',
  phone_exact: 'Same phone number',
  phone_typo:  'Phone number off by one digit — looks like a typo',
}

/** How sure the signals make us. The landlord decides either way. */
export const DUPLICATE_CONFIDENCES = ['strong', 'likely', 'possible'] as const
export type DuplicateConfidence = typeof DUPLICATE_CONFIDENCES[number]

export const DUPLICATE_CONFIDENCE_LABEL: Record<DuplicateConfidence, string> = {
  strong:   'Almost certainly the same person',
  likely:   'Probably the same person',
  possible: 'Might be the same person',
}

/** Where a proposal has got to. Nothing is ever merged without an answer here. */
export const DUPLICATE_PROPOSAL_STATUSES = ['open', 'merged', 'not_duplicate'] as const
export type DuplicateProposalStatus = typeof DUPLICATE_PROPOSAL_STATUSES[number]

export const DUPLICATE_PROPOSAL_STATUS_LABEL: Record<DuplicateProposalStatus, string> = {
  open:          'Waiting on you',
  merged:        'You said: same person',
  not_duplicate: 'You said: different people',
}

/**
 * The two kinds of record a person can be in GAM today.
 *
 * `account` is a sign-in — a users row, with the resident's leases, payments
 * and signatures hanging off it. `guest` is a reservation and nothing else:
 * the name, email and phone written on the booking, which is all a reservation
 * brought in from the old system or typed off a text thread ever has.
 */
export const PERSON_SIDE_KINDS = ['account', 'guest'] as const
export type PersonSideKind = typeof PERSON_SIDE_KINDS[number]

export const PERSON_SIDE_KIND_LABEL: Record<PersonSideKind, string> = {
  account: 'Has a GAM account',
  guest:   'Reservation only — no GAM account',
}
