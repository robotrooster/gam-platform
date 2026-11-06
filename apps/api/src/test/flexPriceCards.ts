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
 * 10/31 — GAM's cut of a finished contractor-marketplace job.
 *
 * Here for the same reason the grids are: services/marketplace.ts treats a
 * missing card as an ERROR and never as a zero, so a test file that borrowed
 * the table would hand every later file that refusal in place of a rate. The
 * marketplace suite deliberately empties it to prove the refusal, which is
 * exactly the case this guards.
 */
/**
 * 10/31 — what financing a job costs. The FlexDeposit curve, continued.
 *
 * Here for the same reason the grids are: a missing bracket is an ERROR in
 * services/jobFinancing, never a free plan, so a file that emptied this table
 * would hand every later file that refusal in place of a fee. The financing
 * suite deliberately prices above the top bracket to prove the refusal, which
 * is exactly the case this guards.
 */
const JOB_FINANCING_SQL = `
  INSERT INTO job_financing_fee_schedule (job_min, job_max, payments, fee, effective_from, note)
  SELECT v.job_min, v.job_max, v.payments, v.fee, DATE '2020-01-01', 'test seed'
    FROM (VALUES
      (0,1000,2,25),(0,1000,4,70),(1000,1500,2,35),(1000,1500,4,105),
      (1500,2000,2,45),(1500,2000,4,140),(2000,2500,2,60),(2000,2500,4,175),
      (2500,3000,2,70),(2500,3000,4,210),(3000,4000,2,95),(3000,4000,4,280),
      (4000,5000,2,120),(4000,5000,4,355),
      (5000,7500,2,175),(5000,7500,4,530),(5000,7500,6,880),(5000,7500,12,1940),
      (7500,10000,2,235),(7500,10000,4,705),(7500,10000,6,1175),(7500,10000,12,2585),
      (10000,12500,2,295),(10000,12500,4,880),(10000,12500,6,1470),(10000,12500,12,3230),
      (12500,15000,2,355),(12500,15000,4,1060),(12500,15000,6,1765),(12500,15000,12,3880),
      (15000,20000,2,470),(15000,20000,4,1410),(15000,20000,6,2350),(15000,20000,12,5170)
    ) AS v(job_min, job_max, payments, fee)
   WHERE NOT EXISTS (SELECT 1 FROM job_financing_fee_schedule)`

/**
 * 10/31 — where the top spot is sold and what it costs there.
 *
 * Two tiny stand-ins rather than the 439 published areas: a file that needs a
 * real metro reads the live table, and what this guards is only that
 * `requirePlacementRate` finds a band at all, since a missing band is an ERROR
 * by design and would otherwise leak into every later file in the run.
 */
const MARKETPLACE_AREA_SQL = `
  INSERT INTO marketplace_areas (area_kind, area_key, name, states, cost_index, index_source, index_year)
  SELECT v.k, v.key, v.name, v.states, v.idx, 'BEA Regional Price Parities, all items', 2024
    FROM (VALUES
      ('metro','99901','Testville-Fixture, AZ',ARRAY['AZ']::text[],100.000),
      ('state_rural','AZ','Arizona, outside the metro areas',ARRAY['AZ']::text[],100.700)
    ) AS v(k, key, name, states, idx)
   WHERE NOT EXISTS (SELECT 1 FROM marketplace_areas)`

const MARKETPLACE_PLACEMENT_SQL = `
  INSERT INTO marketplace_placement_rates (index_min, index_max, monthly_price, effective_from, note)
  SELECT v.lo, v.hi, v.price, DATE '2020-01-01', 'test seed'
    FROM (VALUES
      (0,86,20),(86,90,25),(90,94,35),(94,98,45),(98,102,55),
      (102,106,70),(106,110,85),(110,112,105),(112,999,120)
    ) AS v(lo, hi, price)
   WHERE NOT EXISTS (SELECT 1 FROM marketplace_placement_rates)`

const MARKETPLACE_CUT_SQL = `
  INSERT INTO marketplace_cut_rates (percent, effective_from, note)
  SELECT 3.000, DATE '2020-01-01', 'test seed'
  WHERE NOT EXISTS (SELECT 1 FROM marketplace_cut_rates)`

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
  await exec(MARKETPLACE_CUT_SQL)
  await exec(JOB_FINANCING_SQL)
  await exec(MARKETPLACE_AREA_SQL)
  await exec(MARKETPLACE_PLACEMENT_SQL)
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
