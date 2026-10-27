/**
 * Test DB helpers.
 *
 * `withRollback(fn)` runs `fn` inside a transaction that is always
 * rolled back at the end. Use this in test bodies so the schema
 * stays clean between tests with no truncation cost.
 *
 * Seed helpers (`seedLandlord`, `seedProperty`, `seedUnit`,
 * `seedAllocationRule`, `seedRentPayment`) insert just-enough rows to exercise
 * the allocation engine. The rate card the engine reads is STATED, not seeded:
 * `setEffectiveProcessingRate`, and the note on it says why.
 * Defaults match the GAM pricing model documented in CLAUDE.md;
 * each helper accepts overrides for the fields that vary per test.
 */

import { randomUUID } from 'crypto'
import { formatUnitNumber } from '../lib/format'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'

/**
 * 10/17 (Nic) — THE ROWS THE SUITE DOES NOT OWN.
 *
 * Everything else in the public schema is data some test created, and
 * cleanupAllSchema below empties it. These stay: GAM's own catalogs (what a
 * state requires, what a thing costs, what a document says), the archives the
 * compliance job writes, and the handful of append-only platform books that
 * carry no foreign keys at all and are cleared by the few files that read them.
 *
 * ADDING TO THIS LIST IS THE RARE CASE. A new table is a test's data by
 * default and gets emptied with no change here — that is the point of naming
 * what to keep rather than what to wipe. Name a table here only when its rows
 * are GAM's own reference data, seeded by a migration rather than by a test;
 * a test that seeds one of these is responsible for clearing it, because every
 * later file in the same worker will see what it left.
 *
 * platform_processing_rates is the one that has cost real time: it holds ONE
 * open row per payment method, so whichever file inserted first used to set the
 * rate every later file read. It stays here (the rate is a price card, not a
 * test's data) and each file now STATES the rate its numbers were worked out
 * on — setEffectiveProcessingRate below.
 */
const CLEANUP_KEEPS: readonly string[] = [
  // The migration runner's own record.
  'schema_migrations',
  // What a state requires of a landlord (S177 hard-compliance catalogs).
  'state_deposit_custody_rules', 'state_deposit_interest_rates', 'state_landlord_tenant_acts',
  'state_law_provisions', 'state_law_section_texts', 'state_nexus_thresholds',
  'state_property_tax_provisions', 'state_screening_tax_rates', 'state_tax_forms',
  'state_tax_registrations', 'flexpay_blocked_states',
  // What things cost, and how a score is computed.
  'platform_processing_rates', 'stripe_processing_costs', 'deposit_pool_yield_rates',
  'credit_score_formulas', 'flexpay_fee_schedule', 'flexdeposit_fee_schedule',
  // What the agents and the documents are made of.
  'agent_knowledge_chunks', 'disclosure_library_documents', 'disclosure_library_fields',
  'document_sleeves', 'library_coverage_items', 'platform_announcements', 'sales_calendar_feed',
  // The compliance archives (jobs/complianceArchive.ts moves rows HERE; the
  // change journal is never pruned, and neither are these).
  'ach_monitoring_log_archive', 'admin_action_log_archive', 'admin_notifications_archive',
  'audit_log_archive', 'email_send_log_archive',
  // Append-only platform books with no foreign keys — nothing in the schema
  // points at them, so no delete has ever reached them and no file has ever
  // depended on one being empty. The files that read them clear them
  // themselves (admin-nexus, nexusMonitor, emailSuppressions, gamDebitDispute,
  // s541-flexpay-inquiry). allocation_splits in particular REFUSES a row
  // delete, which is why it was never in the old cleanup's list.
  'allocation_splits', 'ledger_derived_facts', 'float_account_state',
  'reserve_fund_ledger', 'reserve_fund_state', 'nexus_revenue_tally',
  'platform_growth_snapshots', 'product_events', 'stripe_webhook_events',
  'email_suppressions',
]

/**
 * ONE ROUND TRIP, NOT ~190 (10/17).
 *
 * Nic, 10/14: "these deploys are taking longer and longer they used to take 10
 * or 15 minutes and now they're taking 45 minutes." This runs in `beforeEach`
 * in nearly every file in the package — once per TEST — and it was ~190
 * separate DELETE/TRUNCATE statements in hand-maintained foreign-key order,
 * measured at ~135 ms on an empty database and ~200 ms on a populated one. It
 * is now a single statement: ~1 ms, ~23 ms in the worst case measured (every
 * table in the database holding pages).
 *
 * WHAT IT DOES. Turns off triggers for the transaction, empties every table
 * that has anything in it, and lets the role revert. Nothing else.
 *
 * WHY session_replication_role. In 'replica' a session fires no triggers —
 * including the system triggers that enforce foreign keys. That single line
 * replaces the 600 lines this function used to be:
 *
 *   • NO ORDER TO MAINTAIN. Every "this child RESTRICTs that parent, so it
 *     clears first" note is moot, and so is the recurring bug those notes were
 *     written for: a new table added to the schema and not added here in the
 *     right place, leaving rows behind for the next file (S272/S275 and on).
 *     Cross-file leftovers are exactly what makes a file pass alone and fail in
 *     a suite, which is what has been blocking deploys.
 *   • THE PRODUCTION GUARDS STAY AS THEY ARE. A money row's BEFORE DELETE
 *     trigger that refuses removal ("the log is the log", a credit use kept
 *     forever, the append-only ledgers) is untouched in production and simply
 *     does not fire in this session — which is the same thing the old code
 *     reached for TRUNCATE a dozen times to get, and no weaker: TRUNCATE fires
 *     no row trigger either.
 *   • NOTHING IS LEFT DANGLING. Every table outside CLEANUP_KEEPS is emptied,
 *     and the keeps hold no foreign key into what is emptied (they are catalogs
 *     and FK-free fact tables — checked against pg_constraint). That invariant
 *     is the one rule for adding a name to CLEANUP_KEEPS.
 *
 * It needs a superuser (the suite connects as postgres, as globalSetup.ts
 * does); anything less raises on the set_config and the run fails loudly.
 *
 * WHY ONLY THE TABLES WITH PAGES. A row cannot live in zero pages, so
 * pg_relation_size(c.oid) > 0 is an exact "may have rows" test — and it is one
 * stat() per table rather than a planned DELETE per table, which is where the
 * old 135 ms actually went (statement planning and a handful of
 * information_schema lookups, not the round trips). A table that has pages but
 * no rows is emptied for nothing, which costs microseconds; a table with no
 * pages is skipped, which is almost all of them.
 *
 * WHAT THIS LEAVES BEHIND THAT THE OLD ONE DID NOT: nothing. Row counts for all
 * 383 tables were taken after the old chain and after this one, on the same
 * populated database. This empties six tables the old chain left standing:
 * audit_row_changes, which it cleared halfway through and then wrote to again
 * on its way down, and five whose rows survived a parent delete with their link
 * set to NULL — platform_fee_config, rvs, agent_interaction_logs (seen in the
 * comparison) and mobile_homes, analytics_data_gaps (same ON DELETE SET NULL
 * shape, per pg_constraint; no test writes either). Every file that reads those
 * cleared them by hand right after calling this already (platformFeeAccrual,
 * platformFeeTopUp, billingGrace, platformFeeMonthStays, landlordAgentActivity,
 * pmAgentActivity), and the journal assertions are all scoped to a table and a
 * row.
 *
 * The *_test rail (S578) moved INTO the statement. It used to be a separate
 * SELECT current_database() — one more round trip, and a gap between the check
 * and the wipe. A connection to anything not named *_test now raises before a
 * single row is touched, in the same transaction, so nothing can slip past.
 */
const WIPE_TEST_DATA = `
DO $cleanup$
DECLARE
  tbl text;
BEGIN
  IF right(current_database(), 5) <> '_test' THEN
    RAISE EXCEPTION 'cleanupAllSchema REFUSED: connected to "%", not a *_test database. Tests must run with DB_NAME=gam_test (use "npm test" from apps/api). This guard exists because a stray run once wiped the dev DB.', current_database();
  END IF;

  -- Transaction-scoped (the third argument): the role is back to 'origin' when
  -- this statement ends, however it ends, so the pooled connection never
  -- carries it into a test.
  PERFORM set_config('session_replication_role', 'replica', true);

  FOR tbl IN
    SELECT quote_ident(c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname <> ALL (ARRAY[${CLEANUP_KEEPS.map(t => `'${t}'`).join(', ')}])
       AND pg_relation_size(c.oid) > 0
     -- By name, so two of these running at once take their locks in the same
     -- order and cannot deadlock with each other.
     ORDER BY c.relname
  LOOP
    EXECUTE 'DELETE FROM ' || tbl;
  END LOOP;

  PERFORM set_config('session_replication_role', 'origin', true);
END
$cleanup$`

/**
 * Empty every table a test wrote to, leaving the catalogs in CLEANUP_KEEPS
 * alone. Called in `beforeEach` across the package; see the two notes above for
 * what it does and why it is one statement.
 *
 * RETRIED ON A DEADLOCK (10/17). A few files leave work IN FLIGHT when a test
 * ends — a request or a ledger drain the test did not await — and it is still
 * writing when the next test's `beforeEach` starts. Two transactions then take
 * row locks in opposite orders and Postgres kills one of them; which one is
 * arbitrary, so the suite would go red in a place that has nothing to do with
 * the test being run (routes/workTradeHoursPaidByHand.test.ts, 4 of its 12).
 * The old 190-statement chain hit the same race but, deleting in one fixed
 * order, it waited for the other transaction instead of deadlocking with it.
 *
 * A deadlock rolls this statement back whole, so a retry starts from where it
 * started and the in-flight work has since finished. Only a deadlock
 * (40P01) or a lock this session was not allowed to wait for (55P03) is
 * retried: a real error still fails the test, loudly, on the first try.
 */
export async function cleanupAllSchema(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query(WIPE_TEST_DATA)
      return
    } catch (e: any) {
      if ((e?.code !== '40P01' && e?.code !== '55P03') || attempt >= 5) throw e
      await new Promise(resolve => setTimeout(resolve, 20 * attempt))
    }
  }
}

/**
 * 10/21 — REMOVE A RESERVATION IN A TEST, PAST THE DELETE REFUSAL.
 *
 * Production cannot delete one at all: `trg_booking_block_delete` refuses it,
 * because the nights a reservation held are what GAM bills in arrears and
 * erasing the history was how a landlord could lower the bill (Nic, 10/21). A
 * handful of tests need a reservation to be simply ABSENT — they are testing
 * what a lookup does when there is no row — so they set the replica role for
 * the one statement, the way cleanupAllSchema sets it for the whole wipe.
 *
 * Nothing outside a test may use this. There is no application path.
 */
export async function deleteBookingsForTest(bookingId?: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('session_replication_role', 'replica', true)`)
    if (bookingId) await client.query(`DELETE FROM unit_bookings WHERE id = $1`, [bookingId])
    else await client.query(`DELETE FROM unit_bookings`)
    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    throw e
  } finally {
    client.release()
  }
}

export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    client.release()
  }
}

export async function seedLandlord(
  client: PoolClient,
  overrides: { email?: string; firstName?: string; lastName?: string } = {}
): Promise<{ userId: string; landlordId: string }> {
  const email = overrides.email || `landlord-${randomUUID()}@test.dev`
  const userRes = await client.query<{ id: string }>(
    // S281: pre-seed email_verified=TRUE so existing tests that hit
    // /login don't trip the verification gate. The verification flow
    // has its own suite (passwordReset + emailVerification) that
    // exercises false → true transitions explicitly.
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'landlord', $2, $3, TRUE) RETURNING id`,
    [email, overrides.firstName || 'Test', overrides.lastName || 'Landlord']
  )
  const userId = userRes.rows[0].id
  const llRes = await client.query<{ id: string }>(
    // S600: default test landlords to "live since the epoch" so the platform-fee
    // accrual gate lets them bill for ANY accrual month — including the fixed past
    // months (e.g. 2026-05) the platformFeeAccrual tests pass. Matches pre-grace
    // behavior. Grace-specific tests override billing_starts_at / billing_grace_until.
    `INSERT INTO landlords (user_id, billing_starts_at)
     VALUES ($1, DATE '2000-01-01') RETURNING id`,
    [userId]
  )
  return { userId, landlordId: llRes.rows[0].id }
}

export async function seedManager(
  client: PoolClient,
  overrides: { email?: string } = {}
): Promise<string> {
  const email = overrides.email || `manager-${randomUUID()}@test.dev`
  const res = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'property_manager', 'Test', 'Manager', TRUE) RETURNING id`,
    [email]
  )
  return res.rows[0].id
}

export async function seedTenant(
  client: PoolClient,
  overrides: { email?: string } = {}
): Promise<string> {
  const email = overrides.email || `tenant-${randomUUID()}@test.dev`
  const userRes = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'tenant', 'Test', 'Tenant', TRUE) RETURNING id`,
    [email]
  )
  const tRes = await client.query<{ id: string }>(
    `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`,
    [userRes.rows[0].id]
  )
  return tRes.rows[0].id
}

export async function seedProperty(
  client: PoolClient,
  params: {
    landlordId: string
    ownerUserId: string
    managedByUserId: string
    state?: string
    /**
     * 10/6 (Nic): properties.tenants_deposit_at_bank. Production starts every
     * property OFF; test properties start ON so the bank-deposit suites (the
     * tenant's report, the "Bank deposit" method, bank-feed matching) run the
     * paths they were written for. Pass false to test a property that does
     * not take bank deposits from tenants.
     */
    tenantsDepositAtBank?: boolean
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO properties
       (landlord_id, name, street1, city, state, zip,
        owner_user_id, managed_by_user_id, tenants_deposit_at_bank)
     VALUES ($1, 'Test Property', '1 Test St', 'Phoenix', $2, '85001', $3, $4, $5)
     RETURNING id`,
    [params.landlordId, params.state || 'AZ',
     params.ownerUserId, params.managedByUserId, params.tenantsDepositAtBank !== false]
  )
  return res.rows[0].id
}

export async function seedUnit(
  client: PoolClient,
  params: {
    propertyId: string
    landlordId: string
    rentAmount?: number
    unitType?: string
    withLateFeeDecision?: boolean
  }
): Promise<string> {
  const unitType = params.unitType ?? 'apartment'
  // S537: routes that onboard tenants onto a unit gate on an explicit
  // (property, unit_type) late-fee decision. Direct-SQL unit seeding is
  // NOT gated, so decision seeding is opt-in — suites that exercise
  // gated routes pass withLateFeeDecision (or call seedLateFeeDecision
  // themselves); suites asserting the undecided/no-policy state stay
  // untouched.
  if (params.withLateFeeDecision) {
    await seedLateFeeDecision(client, { propertyId: params.propertyId, unitType })
  }
  // S613: the seeded number is CANONICALISED, the way every production unit
  // number is (POST /units runs canonicalUnitNumber; retire runs
  // formatUnitNumber). Without this the fixture could store a number no real
  // unit could have, and unitRetire's "refuses a number already taken" test
  // failed roughly 6% of runs because of it:
  //
  //   randomUUID().slice(0,6) is HEX, so ~6% of the time it is all digits.
  //   'U-3f9a2b' formats to 'U-3F9A2B' — only case changes, and the clash check
  //   is case-insensitive, so it matched and the retire was refused.
  //   'U-123456' formats to 'U 123456' — the hyphen becomes a SPACE, which no
  //   longer matches the raw 'U-123456' the fixture stored, so no clash was
  //   found and the retire succeeded.
  //
  // A test-only defect, not a production one: real numbers are canonical on both
  // sides, so they always compare. Fixed by making the fixture behave like
  // production rather than by loosening the assertion.
  const res = await client.query<{ id: string }>(
    `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.propertyId, params.landlordId,
     formatUnitNumber(`U-${randomUUID().slice(0, 6)}`), params.rentAmount ?? 1000, unitType]
  )
  return res.rows[0].id
}

/** S537: explicit per-(property, unit_type) late-fee decision. Defaults to
 *  a $15/5-day fee decision; pass noLateFee for the no-fee shape. */
export async function seedLateFeeDecision(
  client: PoolClient,
  params: {
    propertyId: string
    unitType?: string
    noLateFee?: boolean
    initialAmount?: number
    graceDays?: number
    initialType?: 'flat' | 'percent_of_rent'
  }
): Promise<void> {
  const noFee = !!params.noLateFee
  await client.query(
    `INSERT INTO property_unit_type_late_fees
       (property_id, unit_type, no_late_fee, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (property_id, unit_type) DO NOTHING`,
    [params.propertyId, params.unitType ?? 'apartment', noFee,
     noFee ? null : (params.graceDays ?? 5),
     noFee ? null : (params.initialAmount ?? 15),
     noFee ? null : (params.initialType ?? 'flat')]
  )
}

export async function seedAllocationRule(
  client: PoolClient,
  params: {
    propertyId: string
    rentPercent?: number
    rentPercentFloor?: number
    rentPercentCeiling?: number
    achFeePayer?: 'landlord' | 'tenant'
    cardFeePayer?: 'landlord' | 'tenant'
    platformFeePayer?: 'landlord' | 'tenant'
    ownerBankAccountId?: string | null
  }
): Promise<void> {
  await client.query(
    `INSERT INTO property_allocation_rules
       (property_id, rent_percent, rent_percent_floor, rent_percent_ceiling,
        ach_fee_payer, card_fee_payer, platform_fee_payer,
        owner_bank_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [params.propertyId,
     params.rentPercent ?? null,
     params.rentPercentFloor ?? null,
     params.rentPercentCeiling ?? null,
     params.achFeePayer ?? 'tenant',
     params.cardFeePayer ?? 'tenant',
     params.platformFeePayer ?? 'landlord',
     params.ownerBankAccountId ?? null]
  )
}

/**
 * 10/17 — STATE THE RATE CARD A FILE'S NUMBERS WERE WORKED OUT ON.
 *
 * platform_processing_rates holds exactly ONE open row per payment method
 * (unique index ux_platform_processing_rates_active_per_method, where
 * effective_until IS NULL) and cleanupAllSchema deliberately leaves the table
 * alone, so the FIRST file in a run to insert a rate sets the rate every later
 * file reads (services/allocation.ts fetchActiveProcessingRate,
 * services/platformRevenue.ts, services/stripeCosts.ts all read that one row).
 *
 * A file that inserts "only if none is open" therefore passes or fails on who
 * ran first. That is what sent webhooks.test.ts and
 * incomeBasisReservationMoney.test.ts red inside deploy.sh on 10/15 and 10/16
 * while both passed alone; allocation.test.ts had already worked around it by
 * hand ("the file passed or failed depending on which suite the run happened to
 * start with"). Per-worker databases do not cure it — a worker still runs many
 * files on one database — so the cause is fixed here.
 *
 * This states the rate instead of hoping for it: whatever is open for that
 * method is retired and the wanted row becomes the open one. Rates are
 * effective-dated, so retiring is an UPDATE of effective_until, never a delete
 * — the row stays, which the change journal requires. effective_until is
 * pushed past effective_from so a row inserted a moment ago still closes
 * (the window CHECK demands until > from).
 */
export async function setEffectiveProcessingRate(
  // The pool or a checked-out client: the rate card is global, not per-lease, so
  // a file with no transaction in hand states its rate straight on the pool.
  client: Pick<PoolClient, 'query'>,
  params: {
    paymentMethod: 'ach' | 'card'
    customerFacingFlat: number
    customerFacingPercent: number
    stripeCostFlat: number
    stripeCostPercent: number
    customerFacingCap?: number | null
    stripeCostCap?: number | null
    notes?: string
  }
): Promise<void> {
  await client.query(
    `UPDATE platform_processing_rates
        SET effective_until = greatest(now(), effective_from + interval '1 microsecond')
      WHERE payment_method = $1 AND effective_until IS NULL`,
    [params.paymentMethod]
  )
  await client.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent,
        stripe_cost_flat, stripe_cost_percent, customer_facing_cap, stripe_cost_cap, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [params.paymentMethod,
     params.customerFacingFlat, params.customerFacingPercent,
     params.stripeCostFlat, params.stripeCostPercent,
     params.customerFacingCap ?? null, params.stripeCostCap ?? null,
     params.notes ?? null]
  )
}

export async function seedUserBankAccount(
  client: PoolClient,
  params: { userId: string }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO user_bank_accounts
       (user_id, nickname, account_holder_name, account_type,
        routing_number, account_number_last4, account_number_encrypted)
     VALUES ($1, 'Test Bank', 'Test User', 'checking',
             '123456789', '4321', 'enc')
     RETURNING id`,
    [params.userId]
  )
  return res.rows[0].id
}

export async function seedPmCompany(
  client: PoolClient,
  params: { bankAccountId: string; name?: string }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO pm_companies (name, bank_account_id)
     VALUES ($1, $2) RETURNING id`,
    [params.name || `PM Co ${randomUUID().slice(0, 6)}`, params.bankAccountId]
  )
  return res.rows[0].id
}

export async function seedPmFeePlan(
  client: PoolClient,
  params: {
    pmCompanyId: string
    feeType:
      | 'percent_of_rent'
      | 'percent_with_floor'
      | 'percent_with_ceiling'
      | 'flat_monthly'
      | 'per_unit'
      | 'leasing_fee'
      | 'maintenance_markup_pct'
    percent?: number
    flatAmount?: number
    floorAmount?: number
    ceilingAmount?: number
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO pm_fee_plans
       (pm_company_id, name, fee_type, percent, flat_amount,
        floor_amount, ceiling_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [params.pmCompanyId, `Plan ${randomUUID().slice(0, 6)}`,
     params.feeType,
     params.percent ?? null,
     params.flatAmount ?? null,
     params.floorAmount ?? null,
     params.ceilingAmount ?? null]
  )
  return res.rows[0].id
}

export async function attachPmToProperty(
  client: PoolClient,
  params: { propertyId: string; pmCompanyId: string; pmFeePlanId: string }
): Promise<void> {
  await client.query(
    `UPDATE properties SET pm_company_id=$2, pm_fee_plan_id=$3 WHERE id=$1`,
    [params.propertyId, params.pmCompanyId, params.pmFeePlanId]
  )
}

export async function seedLease(
  client: PoolClient,
  params: {
    unitId: string
    landlordId: string
    rentAmount?: number
    leaseType?: 'month_to_month' | 'fixed_term' | 'nnn_commercial'
    status?: 'pending' | 'active' | 'expired' | 'terminated'
    startDate?: string
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO leases
       (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [params.unitId, params.landlordId,
     params.rentAmount ?? 1000,
     params.leaseType ?? 'fixed_term',
     params.status ?? 'active',
     params.startDate ?? '2025-01-01']
  )
  return res.rows[0].id
}

export async function seedLeaseTenant(
  client: PoolClient,
  params: {
    leaseId: string
    tenantId: string
    role?: 'primary' | 'co_tenant'
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO lease_tenants (lease_id, tenant_id, role)
     VALUES ($1, $2, $3) RETURNING id`,
    [params.leaseId, params.tenantId, params.role ?? 'primary']
  )
  return res.rows[0].id
}

export async function seedLeaseFee(
  client: PoolClient,
  params: {
    leaseId: string
    feeType: string
    amount: number
    dueTiming: 'move_in' | 'monthly_ongoing' | 'move_out' | 'other'
    isRefundable?: boolean
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO lease_fees
       (lease_id, fee_type, amount, due_timing, is_refundable)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.leaseId, params.feeType, params.amount,
     params.dueTiming, params.isRefundable ?? false]
  )
  return res.rows[0].id
}

export async function seedSecurityDeposit(
  client: PoolClient,
  params: {
    unitId: string
    leaseId: string
    tenantId: string
    totalAmount: number
    collectedAmount?: number
    interestAccrued?: number
    heldBy?: 'gam_escrow' | 'landlord'
    status?: 'pending' | 'funded' | 'partial' | 'disbursed' | 'claimed'
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO security_deposits
       (unit_id, lease_id, tenant_id, total_amount, collected_amount,
        interest_accrued, held_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [params.unitId, params.leaseId, params.tenantId,
     params.totalAmount, params.collectedAmount ?? params.totalAmount,
     params.interestAccrued ?? 0,
     params.heldBy ?? 'gam_escrow',
     params.status ?? 'funded']
  )
  return res.rows[0].id
}

export async function seedDepositReturnDraft(
  client: PoolClient,
  params: {
    leaseId: string
    tenantId: string
    landlordId: string
    securityDepositId?: string | null
    totalDeposit: number
    cleaningFeeAmount?: number
    damageLines?: Array<{ description: string; amount: number }>
    otherDeductions?: Array<{ description: string; amount: number }>
    totalDeductions?: number
    refundAmount?: number
    gapAmount?: number
  }
): Promise<string> {
  const damage = params.damageLines ?? []
  const other = params.otherDeductions ?? []
  const damageTotal = damage.reduce((s, l) => s + l.amount, 0)
  const otherTotal = other.reduce((s, l) => s + l.amount, 0)
  const cleaning = params.cleaningFeeAmount ?? 0
  const totalDeductions = params.totalDeductions
    ?? (cleaning + damageTotal + otherTotal)
  const refund = params.refundAmount
    ?? Math.max(0, params.totalDeposit - totalDeductions)
  const gap = params.gapAmount
    ?? Math.max(0, totalDeductions - params.totalDeposit)
  const res = await client.query<{ id: string }>(
    `INSERT INTO deposit_returns
       (lease_id, tenant_id, landlord_id, security_deposit_id,
        total_deposit, cleaning_fee_amount,
        damage_lines, other_deductions,
        total_deductions, refund_amount, gap_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
             $9, $10, $11, 'draft') RETURNING id`,
    [params.leaseId, params.tenantId, params.landlordId,
     params.securityDepositId ?? null,
     params.totalDeposit, cleaning,
     JSON.stringify(damage), JSON.stringify(other),
     totalDeductions, refund, gap]
  )
  return res.rows[0].id
}

export async function seedUtilityMeter(
  client: PoolClient,
  params: {
    propertyId: string
    utilityType?: 'water' | 'gas' | 'electric' | 'sewer' | 'trash'
    billingMethod?: 'submeter' | 'rubs' | 'master_bill_to_landlord' | 'flat_rate'
    /** Required by the schema for a RUBS master; ignored for anything else. */
    rubsAllocationMethod?: string
  }
): Promise<string> {
  // S609: `billingMethod: 'rubs'` was accepted here but could never succeed —
  // utility_meters_check requires a RUBS master to carry an allocation method
  // and this helper never set one, so every attempt violated the constraint.
  // The option looked available and wasn't.
  const method = params.billingMethod ?? 'submeter'
  const alloc = method === 'rubs' ? (params.rubsAllocationMethod ?? 'occupant_count') : null
  // S613: nothing is read on trash or on a flat rate, so those carry NO odometer
  // width — the column is NULL there and the CHECK enforces it. The seed sets it
  // explicitly for everything else rather than leaning on a default that no
  // longer exists.
  const utilityType = params.utilityType ?? 'water'
  const dialless = utilityType === 'trash' || method === 'flat_rate'
  const res = await client.query<{ id: string }>(
    `INSERT INTO utility_meters
       (property_id, utility_type, label, billing_method, rubs_allocation_method, digits)
     VALUES ($1, $2, 'Test Meter', $3, $4, $5) RETURNING id`,
    [params.propertyId, utilityType, method, alloc, dialless ? null : 6]
  )
  return res.rows[0].id
}

export async function seedUtilityBill(
  client: PoolClient,
  params: {
    meterId: string
    unitId: string
    tenantId: string
    leaseId: string
    landlordId: string
    chargeAmount: number
    paymentId?: string | null
    billingCycleMonth?: string
    status?: 'unbilled' | 'billed' | 'paid' | 'disputed' | 'void'
    utilityType?: 'water' | 'gas' | 'electric' | 'sewer' | 'trash'
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO utility_bills
       (meter_id, unit_id, tenant_id, lease_id, landlord_id,
        billing_cycle_month, charge_amount, payment_id, status, utility_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [params.meterId, params.unitId, params.tenantId,
     params.leaseId, params.landlordId,
     params.billingCycleMonth ?? '2026-05-01',
     params.chargeAmount,
     params.paymentId ?? null,
     params.status ?? 'billed',
     params.utilityType ?? 'water']
  )
  return res.rows[0].id
}

export async function seedUtilityPayment(
  client: PoolClient,
  params: {
    unitId: string
    tenantId: string
    landlordId: string
    leaseId?: string
    amount: number
    status?: 'pending' | 'settled' | 'failed' | 'returned'
    stripePaymentIntentId?: string
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, lease_id, type, amount, status,
        entry_description, due_date, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4, 'utility', $5, $6, 'UTILITY', CURRENT_DATE, $7)
     RETURNING id`,
    [params.unitId, params.tenantId, params.landlordId,
     params.leaseId ?? null,
     params.amount,
     params.status ?? 'pending',
     params.stripePaymentIntentId ?? null]
  )
  return res.rows[0].id
}

export async function seedRentPayment(
  client: PoolClient,
  params: {
    unitId: string
    tenantId: string
    landlordId: string
    amount: number
    status?: 'pending' | 'settled' | 'failed' | 'returned'
    gamSupersedenceAmount?: number
    stripePaymentIntentId?: string
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, gam_supersedence_amount,
        stripe_payment_intent_id)
     VALUES ($1, $2, $3, 'rent', $4, $5, 'RENT', CURRENT_DATE, $6, $7)
     RETURNING id`,
    [params.unitId, params.tenantId, params.landlordId,
     params.amount, params.status ?? 'settled',
     params.gamSupersedenceAmount ?? 0,
     params.stripePaymentIntentId ?? null]
  )
  return res.rows[0].id
}
