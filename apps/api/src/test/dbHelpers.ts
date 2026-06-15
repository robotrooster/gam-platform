/**
 * Test DB helpers.
 *
 * `withRollback(fn)` runs `fn` inside a transaction that is always
 * rolled back at the end. Use this in test bodies so the schema
 * stays clean between tests with no truncation cost.
 *
 * Seed helpers (`seedLandlord`, `seedProperty`, `seedUnit`,
 * `seedAllocationRule`, `seedProcessingRate`, `seedRentPayment`)
 * insert just-enough rows to exercise the allocation engine.
 * Defaults match the GAM pricing model documented in CLAUDE.md;
 * each helper accepts overrides for the fields that vary per test.
 */

import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'

/**
 * Wipe every table any suite in this package writes to. FK-dependency
 * order — children before parents. Centralized here so adding a new
 * suite-touched table updates every suite at once (avoids the
 * cross-file leakage that bit S272 / S275 — leaseLifecycle leaves
 * invoices, depositReturn's local cleanupAll didn't know to drop them
 * before leases, FK violation on the next beforeEach).
 *
 * platform_processing_rates intentionally NOT wiped — allocation.test
 * seeds it once in beforeAll and other suites use INSERT ON CONFLICT
 * DO NOTHING / INSERT ... WHERE NOT EXISTS, so leaving the singleton
 * rows in place is correct.
 */
export async function cleanupAllSchema(): Promise<void> {
  // S332: dispute lifecycle tables FK to credit_events; clear before
  // the parents. credit_scores + credit_stats FK to subjects.
  await db.query(`DELETE FROM credit_disputes`)
  await db.query(`DELETE FROM credit_hardship_contexts`)
  await db.query(`DELETE FROM credit_scores`)
  await db.query(`DELETE FROM credit_stats`)
  await db.query(`DELETE FROM credit_events`)
  await db.query(`DELETE FROM credit_subjects`)
  await db.query(`DELETE FROM admin_notifications`)
  // S362: admin_action_log + system_features FK users with NO ACTION
  // (default). Wipe both before users delete. system_features rows
  // come from migration seeds in prod, but the test DB is schema-only
  // — tests seed what they need inline.
  await db.query(`DELETE FROM admin_action_log`)
  await db.query(`DELETE FROM system_features`)
  // S368: CSV review queue tables. csv_import_attempts CASCADEs on
  // landlords delete so wipes transitively, but platform_review_status
  // + platform_claim_promotions have user FKs (SET NULL) and persist
  // across tests — clear explicitly.
  await db.query(`DELETE FROM platform_review_status`)
  await db.query(`DELETE FROM platform_claim_promotions`)
  // S370: ach_monitoring_log FK payments + tenants (NO ACTION default).
  // Blocks parent deletes; clear before payments/tenants get wiped.
  await db.query(`DELETE FROM ach_monitoring_log`)
  // S346: notification_preferences CASCADE on users delete but explicit
  // clear keeps each test's prefs scope-controlled inside a describe.
  await db.query(`DELETE FROM notification_preferences`)
  await db.query(`DELETE FROM notifications`)
  await db.query(`DELETE FROM connect_disputes`)
  // S358: connect_payouts FK users (SET NULL) + pm_companies (SET NULL).
  // Rows survive parent deletes — explicit cleanup keeps tests
  // scope-deterministic.
  await db.query(`DELETE FROM connect_payouts`)
  // S364: email_send_log FK landlords (SET NULL) — same posture.
  await db.query(`DELETE FROM email_send_log`)
  // S365: otp_advances FK landlords/tenants/units/leases/payments (NO ACTION).
  // Rows block parent deletes — clear before users/landlords/tenants/payments.
  await db.query(`DELETE FROM otp_advances`)
  // S445: flexpay_advances FKs landlords/tenants/units/leases/payments
  // (same NO ACTION posture as otp_advances above). Without this clear,
  // any test that creates a FlexPay advance traps the next file's
  // cleanupAllSchema on leases/users delete.
  await db.query(`DELETE FROM flexpay_advances`)
  await db.query(`DELETE FROM utility_bills`)
  await db.query(`DELETE FROM utility_meters`)
  await db.query(`DELETE FROM deposit_returns`)
  // S331: FlexSuite acceptance audit + FlexDeposit installment plan
  // tables — both FK to tenants / security_deposits; clear before the
  // parents. background_checks FKs tenants + landlords — also wipe.
  await db.query(`DELETE FROM flexsuite_enrollment_acceptances`)
  await db.query(`DELETE FROM flex_deposit_installments`)
  await db.query(`DELETE FROM background_checks`)
  await db.query(`DELETE FROM security_deposits`)
  // Accrual tables FK to user_balance_ledger / platform_revenue_ledger
  // via ledger_entry_id, so they must be cleared before the ledger
  // tables they reference.
  await db.query(`DELETE FROM monthly_fee_accruals`)
  await db.query(`DELETE FROM pm_monthly_fee_accruals`)
  await db.query(`DELETE FROM platform_fee_accruals`)
  await db.query(`DELETE FROM user_balance_ledger`)
  await db.query(`DELETE FROM platform_revenue_ledger`)
  // lease_termination_requests FKs payments.id (fee_payment_id) and
  // leases.id; clear before either.
  await db.query(`DELETE FROM lease_termination_requests`)
  // S446: flex_charge_statements.payment_id FKs payments (NO ACTION) —
  // and flex_charge_transactions.statement_id FKs statements. Clear the
  // chain transactions → statements → accounts BEFORE payments so the
  // payments DELETE below doesn't trip the FK on any test that fired
  // processFlexChargeStatementBilling. (Previously these lived next to
  // the POS chain at the bottom, which only worked when no statement
  // had been billed — i.e. payment_id IS NULL.)
  await db.query(`DELETE FROM flex_charge_transactions`)
  await db.query(`DELETE FROM flex_charge_statements`)
  await db.query(`DELETE FROM flex_charge_accounts`)
  await db.query(`DELETE FROM payments`)
  await db.query(`DELETE FROM invoices`)
  await db.query(`DELETE FROM invoice_sequences`)
  await db.query(`DELETE FROM lease_fees`)
  // S335: addendum_remove docs have a CHECK constraint requiring
  // target_lease_tenant_id IS NOT NULL. The FK from lease_documents
  // to lease_tenants is ON DELETE SET NULL, so a direct DELETE FROM
  // lease_tenants triggers a SET NULL on target_lease_tenant_id that
  // violates the CHECK on any addendum_remove row. Break the FK
  // direction by clearing lease_tenants' link columns first, then
  // delete the addendum_remove docs outright before the lease_tenants
  // wipe.
  await db.query(`UPDATE lease_tenants SET add_document_id = NULL, remove_document_id = NULL`)
  await db.query(`DELETE FROM lease_documents WHERE document_type = 'addendum_remove'`)
  await db.query(`DELETE FROM lease_tenants`)
  // Subleases ↔ sublessee_invitations have a circular FK
  // (subleases.sublessee_invitation_id → sublessee_invitations.id and
  // sublessee_invitations.sublease_id → subleases.id). Both columns are
  // nullable; clear them to break the cycle before deleting either
  // table. sublessor_credit_balances FKs subleases — clear first.
  await db.query(`DELETE FROM sublessor_credit_balances`)
  await db.query(`UPDATE subleases SET sublessee_invitation_id = NULL`)
  await db.query(`UPDATE sublessee_invitations SET sublease_id = NULL`)
  await db.query(`DELETE FROM subleases`)
  await db.query(`DELETE FROM sublessee_invitations`)
  // unit_inspections FKs leases.id (children — items / photos /
  // signatures — cascade on parent delete per schema FKs).
  await db.query(`DELETE FROM unit_inspections`)
  // lease_documents FKs leases.id; its children (signers / fields)
  // cascade on parent delete.
  await db.query(`DELETE FROM lease_documents`)
  await db.query(`DELETE FROM leases`)
  // Maintenance comments FK to maintenance_requests; both FK to units.
  // contractors FKs reverse — clear after maintenance_requests releases
  // its contractor_id refs.
  await db.query(`DELETE FROM maintenance_comments`)
  await db.query(`DELETE FROM maintenance_requests`)
  await db.query(`DELETE FROM contractors`)
  // S355: unit_applications FK units (SET NULL) + landlords (SET NULL) —
  // rows survive parent deletes, so explicit cleanup is required to keep
  // tests scope-deterministic. unit_photos / property_fee_schedules /
  // property_duplicate_flags all CASCADE via units / properties.
  await db.query(`DELETE FROM unit_applications`)
  // S350: unit_bookings FK units RESTRICT; clear before units.
  await db.query(`DELETE FROM unit_bookings`)
  // S351: entry-request rows FK units (request) + requests (response).
  // Responses CASCADE on request delete, but explicit clear keeps the
  // FK chain order obvious for future readers.
  await db.query(`DELETE FROM unit_entry_request_responses`)
  await db.query(`DELETE FROM unit_entry_requests`)
  // S381: work_trade_agreements FKs units (RESTRICT) and is the parent
  // for work_trade_logs + work_trade_periods (both CASCADE on agreement
  // delete). Clear before units.
  await db.query(`DELETE FROM work_trade_agreements`)
  await db.query(`DELETE FROM units`)
  await db.query(`DELETE FROM property_allocation_rules`)
  // S338: POS chain. All landlord-FK'd with ON DELETE RESTRICT;
  // must clear before landlords delete. Children cascade where
  // possible (transaction_items, inventory_log, purchase_order_items
  // all CASCADE on parent delete). S339: pos_refunds → pos_transactions
  // is RESTRICT, so refunds must be cleared before transactions.
  // S340 / S446: flex_charge_* chain is now cleared earlier (above the
  // payments DELETE) because flex_charge_statements.payment_id FKs
  // payments. Order within the chain: transactions → statements →
  // accounts (transactions.statement_id FKs statements).
  await db.query(`DELETE FROM pos_refunds`)
  // S342: pos_eod_settlements FKs landlords (RESTRICT) and reads from
  // pos_transactions / pos_refunds — clear it before transactions.
  await db.query(`DELETE FROM pos_eod_settlements`)
  // S343: pos_sessions FKs pos_transactions via completed_transaction_id;
  // session_items cascade on parent session delete.
  await db.query(`DELETE FROM pos_sessions`)
  await db.query(`DELETE FROM pos_transactions`)
  await db.query(`DELETE FROM pos_purchase_orders`)
  await db.query(`DELETE FROM pos_items`)
  await db.query(`DELETE FROM pos_categories`)
  await db.query(`DELETE FROM pos_vendors`)
  await db.query(`DELETE FROM pos_tax_rates`)
  // S390: pos_discounts FKs landlords RESTRICT; clear before
  // landlords. pos_item_variants CASCADE on pos_items (auto-cleared
  // when items go).
  await db.query(`DELETE FROM pos_discounts`)
  await db.query(`DELETE FROM pos_item_variants`)
  // S345: terminal readers FK landlord (default RESTRICT). Clear before
  // landlords; no children to cascade.
  await db.query(`DELETE FROM pos_terminal_readers`)
  await db.query(`DELETE FROM pos_customer_invitations`)
  await db.query(`DELETE FROM pos_customers`)
  // S348: maintenance-portal tables — all FK landlords with RESTRICT.
  // purchase_requests FKs maintenance_requests via work_order_id (already
  // wiped above), users via requested_by/approved_by. scheduled_maintenance
  // FKs properties (wiped below us) — clear before properties too.
  await db.query(`DELETE FROM purchase_requests`)
  await db.query(`DELETE FROM parts_inventory`)
  await db.query(`DELETE FROM daily_tasks`)
  await db.query(`DELETE FROM scheduled_maintenance`)
  await db.query(`DELETE FROM shifts`)
  // S349: scope tables + invitations + platform_events. Scope tables
  // FK users + landlords (RESTRICT); invitations FK landlords + users
  // (invited_by_user_id / accepted_user_id / revoked_by_user_id);
  // platform_events FKs invitations via subject_id (currently the only
  // subject_type) — clear in dependency order.
  await db.query(`DELETE FROM platform_events`)
  await db.query(`DELETE FROM property_manager_scopes`)
  await db.query(`DELETE FROM onsite_manager_scopes`)
  await db.query(`DELETE FROM maintenance_worker_scopes`)
  await db.query(`DELETE FROM bookkeeper_scopes`)
  // S383: books_* tables CASCADE on landlords delete, but admin-scoped
  // accounts (landlord_id IS NULL) don't cascade. Explicit clear keeps
  // tests deterministic across runs that mix admin + landlord scope.
  // S385: payroll_run_lines CASCADE on payroll_runs delete, but
  // RESTRICT on books_employees — clear runs first so the employees
  // delete below doesn't trip the FK.
  await db.query(`DELETE FROM payroll_runs`)
  // S386: journal_entry_lines + books_bills + books_transactions all
  // RESTRICT-FK to books_accounts (and bills RESTRICTs to books_vendors).
  // Clear the children before books_accounts/vendors below.
  await db.query(`DELETE FROM journal_entries`)
  await db.query(`DELETE FROM books_bills`)
  await db.query(`DELETE FROM books_transactions`)
  await db.query(`DELETE FROM books_accounts`)
  await db.query(`DELETE FROM books_employees`)
  await db.query(`DELETE FROM books_contractors`)
  await db.query(`DELETE FROM books_vendors`)
  await db.query(`DELETE FROM invitations`)
  // S352: PM company chain — pm_invitations / pm_staff / pm_fee_plans /
  // pm_property_invitations all FK pm_companies CASCADE, so wiping
  // pm_companies cleans them transitively. pm_monthly_fee_accruals
  // (RESTRICT) is already wiped above. landlords.default_pm_company_id
  // and properties.pm_company_id are SET NULL, so no blocking concern.
  await db.query(`DELETE FROM pm_companies`)
  await db.query(`DELETE FROM properties`)
  // S449: disbursements FKs landlords, user_bank_accounts, AND users.
  // Without this cleanup any test that wrote a disbursement (e.g.,
  // POST /me/withdrawals) traps the next file's beforeEach on the
  // landlord/user DELETE. Same pattern as the S445 flexpay_advances
  // and S446 flex_charge cleanup additions. stripeConnectWebhooks.test.ts
  // pre-cleaned this manually; that workaround is now obsolete.
  await db.query(`DELETE FROM disbursements`)
  // S453: businesses chain — businesses.owner_user_id FKs users,
  // business_users.user_id FKs users (both no ON DELETE), so leaving
  // any business row in place traps the users DELETE. business_users +
  // business_customers CASCADE on businesses delete, so the parent
  // wipe transitively clears them.
  // S456: business_user_invitations also CASCADEs on businesses, but
  // invited_by_user_id + accepted_user_id FK users directly (no ON
  // DELETE), so clear the chain explicitly before users DELETE.
  await db.query(`DELETE FROM business_user_invitations`)
  // S459: appointments CASCADE on businesses but their created_by_user_id
  // FKs users with no ON DELETE; clearing transitively via businesses
  // wipe is fine for the FK direction, but explicit DELETE makes the
  // chain readable.
  // S460: recurring_schedules CASCADE on businesses too. Order is
  // important — appointments has an FK back to recurring_schedules
  // (ON DELETE SET NULL), so dropping appointments first is fine,
  // but the FK gets exercised on the schedules-delete pass.
  // S463: route_stops + generated_routes CASCADE on businesses, but
  // route_stops.appointment_id FKs appointments (no ON DELETE) so
  // they must be cleared BEFORE the appointments DELETE below.
  await db.query(`DELETE FROM route_stops`)
  await db.query(`DELETE FROM generated_routes`)
  await db.query(`DELETE FROM appointments`)
  await db.query(`DELETE FROM recurring_schedules`)
  // S462: route infrastructure tables. vehicles.home_depot_id FKs
  // depots so trucks must be cleared first; depots / dump_locations
  // are sibling-CASCADE on businesses but explicit clear keeps order
  // readable.
  await db.query(`DELETE FROM vehicles`)
  await db.query(`DELETE FROM depots`)
  await db.query(`DELETE FROM dump_locations`)
  await db.query(`DELETE FROM businesses`)
  await db.query(`DELETE FROM landlords`)
  await db.query(`DELETE FROM tenants`)
  await db.query(`DELETE FROM users`)
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
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
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
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO properties
       (landlord_id, name, street1, city, state, zip,
        owner_user_id, managed_by_user_id)
     VALUES ($1, 'Test Property', '1 Test St', 'Phoenix', $2, '85001', $3, $4)
     RETURNING id`,
    [params.landlordId, params.state || 'AZ',
     params.ownerUserId, params.managedByUserId]
  )
  return res.rows[0].id
}

export async function seedUnit(
  client: PoolClient,
  params: {
    propertyId: string
    landlordId: string
    rentAmount?: number
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.propertyId, params.landlordId,
     `U-${randomUUID().slice(0, 6)}`, params.rentAmount ?? 1000]
  )
  return res.rows[0].id
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

export async function seedProcessingRate(
  client: PoolClient,
  params: {
    paymentMethod: 'ach' | 'card'
    customerFacingFlat: number
    customerFacingPercent: number
    stripeCostFlat: number
    stripeCostPercent: number
  }
): Promise<void> {
  await client.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent,
        stripe_cost_flat, stripe_cost_percent)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.paymentMethod,
     params.customerFacingFlat, params.customerFacingPercent,
     params.stripeCostFlat, params.stripeCostPercent]
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
    billingMethod?: 'submeter' | 'rubs' | 'master_bill_to_landlord'
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO utility_meters
       (property_id, utility_type, label, billing_method)
     VALUES ($1, $2, 'Test Meter', $3) RETURNING id`,
    [params.propertyId,
     params.utilityType ?? 'water',
     params.billingMethod ?? 'submeter']
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
  }
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO utility_bills
       (meter_id, unit_id, tenant_id, lease_id, landlord_id,
        billing_cycle_month, charge_amount, payment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [params.meterId, params.unitId, params.tenantId,
     params.leaseId, params.landlordId,
     params.billingCycleMonth ?? '2026-05-01',
     params.chargeAmount,
     params.paymentId ?? null,
     params.status ?? 'billed']
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
