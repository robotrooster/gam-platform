/**
 * 10/20 (Nic) — DELIVERED PROPANE AND DISPENSED PROPANE, AND THE ONE RULE THAT
 * TELLS THEM APART.
 *
 *   "Propane is a product in the point of sale. On delivery to the site, that is
 *    a utility. It's basically at Mountain View, the distinction line is going
 *    to be larger tanks that the company will come fill are only at mobile home
 *    sites. At another property that's yet to be onboarded, that will also
 *    happen at RV sites. So it needs to not be unit type exclusive. But it does
 *    need to have the distinction between delivery and dispensed."
 *
 * Two different things happen to the same molecule and they are not the same
 * money:
 *
 *   DELIVERED — a truck fills the tank ON the space. That is a utility: it bills
 *     back off the delivery (propane_fills, gallons x the fill's own price, plus
 *     the property's propane tax and the ticket's delivery share), it rides the
 *     monthly bill, and it counts as utility recovery.
 *   DISPENSED — somebody fills a bottle at the counter and pays for it there.
 *     That is a PRODUCT: the register's own price, the 6.60% transaction
 *     privilege tax on top, sales revenue, and never a cent of utility recovery.
 *
 * WHY THIS FILE EXISTS. The distinction was real in the data (two tables) and
 * nowhere in the code — nothing NAMED it, so the only thing standing between
 * $328 of taxable fuel revenue and the utility recovery report was that the word
 * "Propane" happens to match none of the patterns the register sweep greps for.
 *
 * AND WHY IT TAKES NO UNIT TYPE. Nic was unusually exact about the reason:
 * delivered tanks are on mobile home sites at Mountain View TODAY and will be on
 * RV sites at a property that has not been onboarded yet. A rule that read
 * units.unit_type would be right at one park and wrong at the next one on its
 * first day — with a truck already gone and gallons nobody could bill. So the
 * inputs below are deliberately narrow: a space says for itself whether a tank
 * gets filled there (units.has_propane_tank, S613), and a catalog button says
 * for itself whether it is a bill-back (pos_items.recovers_utility, 10/20).
 * Neither type can even see a unit type, which is the point — a future change
 * that wants one has to widen a signature in daylight.
 */

import type { UtilityType } from '@gam/shared'

export const PROPANE_MODES = ['delivered', 'dispensed'] as const
export type PropaneMode = typeof PROPANE_MODES[number]

/** Never render the raw word. */
export const PROPANE_MODE_LABEL: Record<PropaneMode, string> = {
  delivered: 'Delivered to the space',
  dispensed: 'Dispensed at the counter',
}

/**
 * Does a truck fill a tank on this space? The space's own answer and nothing
 * else's — not its type, not its property's.
 *
 * Takes the one field on purpose. A caller holding a whole unit row passes
 * `{ has_propane_tank: u.has_propane_tank }` and cannot accidentally reach for
 * u.unit_type on the way past.
 */
export function spaceTakesDeliveredPropane(space: { has_propane_tank: boolean | null }): boolean {
  return space.has_propane_tank === true
}

/**
 * What a register line is, from the line itself.
 *
 * `recoversUtility` is pos_items.recovers_utility on the catalog item, or the
 * snapshot pos_transaction_items.recovers_utility on a sale that already
 * happened. NULL means the landlord says this button is a product — so a
 * propane button is DISPENSED, and it stays dispensed no matter what the
 * category is called or how the item is named. A line that names 'propane'
 * recovers a delivery (a final propane bill collected on a pay link, say).
 *
 * This replaces reading two free-text strings. Both of those used to arrive in
 * the request body, so what money WAS could be decided by what a register
 * typed.
 */
export function propaneModeOfLine(line: { recoversUtility: UtilityType | string | null }): PropaneMode {
  return line.recoversUtility ? 'delivered' : 'dispensed'
}

/**
 * Is this register line utility money given back, and which utility? The
 * explicit answer, with no fallback: NULL is an answer — "a product" — not a
 * missing value. Anything that sweeps utilities reads this and can never pick up
 * a product, whatever it is named or categorized as.
 */
export function lineRecoversUtility(line: { recoversUtility: UtilityType | string | null }): UtilityType | null {
  return (line.recoversUtility || null) as UtilityType | null
}
