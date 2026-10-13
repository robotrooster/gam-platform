// 10/12 (Nic) — THE RENT ROLL: WHO STAYS ON IT AFTER MOVING OUT.
//
// "who stays on the Rent Roll after moving out = LANDLORD'S CHOICE (a setting
//  on the page: billed in last 12 months / while they owe / all time)."
//
// Every household on an occupied space is always a row. This decides which
// households that moved out stay on the page too, per company. Mirrors
// landlords_rent_roll_moved_out_check (landlords.rent_roll_moved_out).
//   billed_last_12_months  billed in the 12 months through the month picked
//                          (the default — the page's rule before 10/12)
//   while_owing            while they still owe anything there
//   all_time               every household ever billed there
export const RENT_ROLL_MOVED_OUT_RULES = ['billed_last_12_months', 'while_owing', 'all_time'] as const
export type RentRollMovedOutRule = typeof RENT_ROLL_MOVED_OUT_RULES[number]
export const RENT_ROLL_MOVED_OUT_DEFAULT: RentRollMovedOutRule = 'billed_last_12_months'
export const RENT_ROLL_MOVED_OUT_LABEL: Record<RentRollMovedOutRule, string> = {
  billed_last_12_months: 'Billed in the last 12 months',
  while_owing:           'While they still owe',
  all_time:              'All time',
}
/** The empty page's sentence: who appears here under each rule. */
export const RENT_ROLL_MOVED_OUT_NOTE: Record<RentRollMovedOutRule, string> = {
  billed_last_12_months: 'Households on an occupied space, and anyone who moved out but was billed in the last 12 months, appear here.',
  while_owing:           'Households on an occupied space, and anyone who moved out but still owes, appear here.',
  all_time:              'Households on an occupied space, and everyone who ever lived here, appear here.',
}
export function isRentRollMovedOutRule(v: unknown): v is RentRollMovedOutRule {
  return typeof v === 'string' && (RENT_ROLL_MOVED_OUT_RULES as readonly string[]).includes(v)
}
