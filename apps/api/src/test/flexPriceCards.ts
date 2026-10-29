/**
 * THE FLEX PRICE CARDS THE SUITE RUNS ON — ONE DEFINITION (10/27).
 *
 * schema.sql is a schema-only dump, so flexpay_fee_schedule and
 * flexdeposit_fee_schedule arrive EMPTY. That matters now the Flex fees are
 * READ from those tables rather than being constants: a quote against an empty
 * schedule finds no bracket, and the services correctly REFUSE rather than
 * charge zero. Production always has these rows, so globalSetup seeds them into
 * the template before the worker databases are copied.
 *
 * ── WHY THIS LIVES IN ITS OWN FILE (the defect that put it here) ────────────
 *
 * dbHelpers treats both tables as catalogs it never truncates (CLEANUP_KEEPS),
 * so whatever a test file leaves in them is what every LATER file in the same
 * worker reads. services/flexFees.test.ts borrows the tables to assert the
 * grid formulas, and its afterAll used to DELETE both — leaving them empty for
 * the rest of that worker's run.
 *
 * The suite stayed green only when vitest happened to schedule nothing
 * price-dependent behind it. It did not, twice: one run failed in
 * depositForwarding ("a FlexDeposit top-up of $500.00 has no price in the
 * schedule"), the next in incomeBasisReservationMoney, each passing on its own.
 * A file that borrows a catalog has to put it back, and "back" has to mean one
 * agreed thing — hence this module, which both the setup and that file call.
 *
 * These are not a second source of truth for the prices:
 * services/flexFees.test.ts asserts these exact figures against the numbers Nic
 * set, so a production re-price that does not reach here fails there rather
 * than passing quietly.
 *
 * effective_from is 2020-01-01 for the same reason production's is — the first
 * schedule has no predecessor, and a schedule dated later than the bill being
 * priced resolves to no price at all.
 */

/** Anything that runs SQL: a pg Client, a pool, or the db module's `query`. */
export type SqlExec = (sql: string) => Promise<unknown>

/**
 * The note MUST begin "10/26" — migration 20261027100000 restates both grids
 * and identifies the rows it replaces by `note LIKE '10/26%'`. A seed note
 * outside that pattern makes its DELETE match nothing, and its INSERT then
 * collides with these rows on ux_flexpay_fee_bracket the moment the migration
 * chain is replayed (posPropaneProduct.test.ts applies every migration twice).
 * Keeping the prefix is what lets that migration stay untouched — an applied
 * migration is never edited.
 */
export const FLEX_SEED_NOTE = '10/26 test seed — the grid as agreed'

const FLEXPAY_SQL = `
  INSERT INTO flexpay_fee_schedule (rent_min, rent_max, benefit_wednesday, fee, effective_from, note)
  SELECT v.rent_min, v.rent_max, w.wed,
         CASE w.wed WHEN 2 THEN 23 + 5 * v.n WHEN 3 THEN 33 + 7 * v.n ELSE 43 + 9 * v.n END,
         DATE '2020-01-01', '${FLEX_SEED_NOTE}'
    FROM (VALUES (0, 0.00::numeric, 1000.00::numeric), (1, 1000.00, 1500.00),
                 (2, 1500.00, 2000.00), (3, 2000.00, 2500.00), (4, 2500.00, 3000.00)
         ) AS v(n, rent_min, rent_max)
   CROSS JOIN (VALUES (2), (3), (4)) AS w(wed)
   WHERE NOT EXISTS (SELECT 1 FROM flexpay_fee_schedule)`

const FLEXDEPOSIT_SQL = `
  INSERT INTO flexdeposit_fee_schedule (deposit_min, deposit_max, payments, fee, effective_from, note)
  SELECT v.deposit_min, v.deposit_max, p.payments,
         CASE p.payments WHEN 2 THEN v.two ELSE v.four END,
         DATE '2020-01-01', '${FLEX_SEED_NOTE}'
    FROM (VALUES (   0.00::numeric, 1000.00::numeric,  48::numeric,  67::numeric),
                 (1000.00,          1500.00,           67,           93),
                 (1500.00,          2000.00,           86,          120),
                 (2000.00,          2500.00,          105,          147),
                 (2500.00,          3000.00,          124,          173)
         ) AS v(deposit_min, deposit_max, two, four)
   CROSS JOIN (VALUES (2), (4)) AS p(payments)
   WHERE NOT EXISTS (SELECT 1 FROM flexdeposit_fee_schedule)`

/**
 * 10/27: what moving a FlexDeposit to a new unit costs — $25 to collect a
 * top-up in one pull, $5 to record the movement when it is split. Its own
 * migration inserts this row in production; a schema-only dump carries the
 * table but not the row, so the suite seeds it here with the grids.
 */
const MOVE_FEES_SQL = `
  INSERT INTO flexdeposit_move_fee_schedule
    (paid_in_full_fee, split_movement_fee, effective_from, note)
  SELECT 25.00, 5.00, DATE '2020-01-01', '${FLEX_SEED_NOTE}'
   WHERE NOT EXISTS (SELECT 1 FROM flexdeposit_move_fee_schedule)`

export const FLEXPAY_SEED_ROWS = 15
export const FLEXDEPOSIT_SEED_ROWS = 10

/**
 * Put both grids in place, if they are not already there. Safe to call again:
 * each insert is guarded on its own table being empty, so restoring after a
 * file that wiped them does the right thing and a second call does nothing.
 *
 * Throws when the row counts come out wrong — a grid seeded half way is worse
 * than one not seeded at all, because the refusals then look like product
 * behavior.
 */
export async function seedFlexPriceCards(exec: SqlExec): Promise<void> {
  await exec('RESET search_path')
  await exec(FLEXPAY_SQL)
  await exec(FLEXDEPOSIT_SQL)
  await exec(MOVE_FEES_SQL)
  // The two callers hand back different shapes — a pg Client returns
  // `{ rows }`, the db module's `query` returns the rows themselves — so the
  // count is read out of either rather than assuming one of them.
  const res = await exec(
    `SELECT (SELECT COUNT(*) FROM flexpay_fee_schedule) AS fp,
            (SELECT COUNT(*) FROM flexdeposit_fee_schedule) AS fd`) as
    Array<{ fp: string; fd: string }> | { rows: Array<{ fp: string; fd: string }> }
  const row = Array.isArray(res) ? res[0] : res?.rows?.[0]
  if (!row) throw new Error('Flex price cards: the count query returned nothing')
  const { fp, fd } = row
  if (Number(fp) !== FLEXPAY_SEED_ROWS || Number(fd) !== FLEXDEPOSIT_SEED_ROWS) {
    throw new Error(
      `Flex price cards seeded wrong: ${fp} FlexPay rows (want ${FLEXPAY_SEED_ROWS}), `
      + `${fd} FlexDeposit rows (want ${FLEXDEPOSIT_SEED_ROWS})`)
  }
}
