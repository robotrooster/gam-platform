/**
 * 10/18 (Nic) — WHAT HAPPENS WHEN SOMEBODY LEAVES EARLY IS THE PROPERTY'S CALL.
 *
 *   "refunds are pro rated to the next price down ... the 4 day rate against
 *    the weekly rate is the difference for the refund IF THE LANDLORD DOES
 *    REFUNDS AT ALL AT THAT PROPERTY. the only way it is different is for
 *    longer term people for rent pro ration. moving in or out at the middle of
 *    a month and also only if the landlord allows the pro rate. THESE SHOULD
 *    ALL BE PROPERTY LEVEL SETTINGS."
 *
 * Two answers on the property: properties.early_departure_refunds and
 * properties.prorates_mid_month_rent, added by migration 20261020120000.
 *
 * ONE PLACE knows whether the database being talked to has them yet, because
 * GAM applies a migration to production ahead of the code that uses it and a
 * check-out, a lease page or a property form must not break in the window
 * between the two — in either order, since a rollback puts the old code back on
 * the new schema.
 *
 *   - READING: `departureRuleSql` never names the column. `to_jsonb(p) ->> 'col'`
 *     is NULL for a column that is not there, which falls through to TRUE —
 *     money back, and proration, the behavior that was there before the columns
 *     and the behavior the columns default to.
 *   - WRITING: an UPDATE cannot dodge a missing column that way; Postgres
 *     raises 42703 as it plans the statement, which inside a transaction takes
 *     the whole thing down with it (a property form that answered both
 *     questions created no property at all). So a write asks
 *     `departureRulesStored()` first and is told plainly when the answer cannot
 *     be kept yet, instead of failing as something else.
 *
 * Once 20261020120000 is applied everywhere, the reads become plain `p.<col>`
 * and this module goes away.
 */
import { query } from '../db'

type Q = { query: Function }

/**
 * One of the two answers, read whether or not the column exists yet. `alias` is
 * the properties table's alias in the surrounding query.
 */
export const departureRuleSql = (col: 'early_departure_refunds' | 'prorates_mid_month_rent', alias = 'p'): string =>
  `COALESCE((to_jsonb(${alias}) ->> '${col}')::boolean, TRUE)`

/** True once seen: a column that exists is never dropped, so a yes is remembered. */
let bothColumnsSeen = false

/**
 * Whether the two answers can be STORED on this database yet. A no is asked
 * again next time — the migration may land at any moment, and nothing should
 * need a restart to notice.
 */
export async function departureRulesStored(q: Q = { query }): Promise<boolean> {
  if (bothColumnsSeen) return true
  const out = await q.query(
    `SELECT (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'properties'
                AND column_name IN ('early_departure_refunds', 'prorates_mid_month_rent')) = 2 AS ready`, [])
  const rows = Array.isArray(out) ? out : out?.rows ?? []
  bothColumnsSeen = rows[0]?.ready === true
  return bothColumnsSeen
}

/**
 * What the landlord reads when the answer cannot be kept yet — plain, and it
 * says what to do. They are never told it saved: every property is behaving as
 * "money back, and proration" until the column is there to say otherwise.
 */
export const DEPARTURE_RULES_NOT_STORED_YET =
  'GAM is part-way through an update, so that answer cannot be saved just yet. '
  + 'Until it is, this property gives money back when someone leaves early and prorates a mid-month '
  + 'move, the way it always has. Try again in a few minutes.'
