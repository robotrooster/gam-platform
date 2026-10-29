/**
 * 10/20 — WHO MAY SEE A METER READING FIGURE. ONE DEFINITION, NOT ONE PER ROUTE.
 *
 * Blind staff entry (S559) exists so a reading cannot be worked backwards: the
 * person who walks the park is never shown what the meter said last time, so
 * they cannot type a number that produces normal-looking usage. Every guard
 * downstream — the rollover check, METER_USAGE_ALERT_THRESHOLDS, the landlord's
 * double-check window — compares this month against last month, so all three
 * pass at once for anyone who knew last month's figure before they walked.
 *
 * GET /utility/meters has honored that since 10/3, by asking userHasPerm for
 * 'properties.edit' / 'units.edit' before it hands back the opening read's
 * value. The rule was written as a line inside that one handler, so the next
 * route that returned a reading did not inherit it, and two did not:
 *
 *   - GET /utility/bills returned `ub.*` — reading_start, reading_end and
 *     usage_amount per row — with NO permission gate and NO property scope at
 *     all. A front-desk onsite_manager holding only { 'utility.read_meters' }
 *     and scoped to one park got every utility bill in the company, each one
 *     carrying last cycle's closing odometer value. 84 of 175 bills in
 *     production carry reading_end, so this was not a theoretical column.
 *   - GET /utility/readings/export let 'units.view_status' download the
 *     readings spreadsheet — every reading of every meter, by month. That is
 *     an onsite_manager permission, the same role that takes the walk, and the
 *     meter list deliberately withholds the reading value from it.
 *
 * So the rule lives here now and the routes ask this question instead of
 * writing their own version of it. The audience is the people who may CHANGE
 * meter setup: they are the ones correcting a mistyped read, and nobody blind
 * is among them. Prices are a separate, wider tier (units.view_status keeps
 * them) because a price is not a figure a reading can be reverse-engineered
 * from — see the meter list.
 */
import type { Request } from 'express'
import { userHasPerm } from '../middleware/auth'

/**
 * The permissions that carry sight of a reading figure. Owner roles pass
 * through userHasPerm without holding a key, as everywhere else.
 */
export const METER_READING_VALUE_PERMS = ['properties.edit', 'units.edit'] as const

/** May this caller be shown what a meter actually said? */
export function canSeeMeterReadingValues(user: Request['user']): boolean {
  return userHasPerm(user, ...METER_READING_VALUE_PERMS)
}

/**
 * A utility bill with the odometer taken off it: the two readings the cycle ran
 * between, and the usage that is their difference. The dates stay — the same
 * posture as the meter list, which keeps the opening read's id and date and
 * drops only its number — so a staffer can still see which window a charge
 * covers, just not the figures to aim at.
 *
 * Takes and returns a loose row because every caller is handing over a
 * SELECT ub.* row that carries the join's extra columns too.
 */
export function withoutReadingFigures<T extends Record<string, any>>(
  bill: T,
): Omit<T, 'reading_start' | 'reading_end' | 'usage_amount'> {
  const { reading_start, reading_end, usage_amount, ...rest } = bill
  return rest
}
