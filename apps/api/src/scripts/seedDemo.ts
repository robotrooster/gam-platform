/**
 * DEMO SEED (S527, Nic) — wipe + rebuild the demo world so EVERY landlord
 * menu shows items at different stages of complete/incomplete, demonstrating
 * each workflow from every entry point.
 *
 * Run: node -r ts-node/register src/scripts/seedDemo.ts   (from apps/api)
 *
 * Keeps: user accounts (logins unchanged), landlords rows, staff permission
 * grants + scope rows (Dana's property lock is RE-POINTED to the new RV
 * resort at the end), platform/config/state-law tables, lease templates.
 * Wipes: all operational data (properties, units, tenants, leases, payments,
 * invoices, bookings, maintenance, inspections, screening, amenities,
 * documents, inventory, POS, flex, notifications) via TRUNCATE CASCADE.
 *
 * Demo cast (james@demo.dev / landlord1234 — the demo landlord):
 *   Sunset Palms RV Resort  — subtypes configured; RV spots + storage;
 *                             bookings past/current/upcoming; 35-night stay
 *                             with auto-drafted lease; change request pending
 *   Oak Street Apartments   — Studio + 2BR subtypes; long-term tenants in
 *                             every payment state
 *   Copper Canyon Homes     — NO subtypes/config (shows the blank states)
 *   Tenants (@tenant.dev / tenant1234): alice current; bob delinquent;
 *   carol expiring soon; dan month-to-month; eva lease pending signature;
 *   frank eviction mode; grace FlexDeposit custody 2/4; henry mid-onboarding;
 *   iris applicant (bg submitted); jack applicant (bg approved, in pool)
 */
import { db } from '../db'
import { appendEvent } from '../services/creditLedger'
import { refreshAllSubjectStats } from '../services/creditStats'
import { recomputeAllSubjects } from '../services/creditScore'

const today = new Date()
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }
const addMonths = (n: number) => { const d = new Date(today); d.setMonth(d.getMonth() + n); return iso(d) }
const firstOfMonth = (offset: number) => { const d = new Date(today.getFullYear(), today.getMonth() + offset, 1); return iso(d) }

async function main() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')

    // ── WIPE ─────────────────────────────────────────────────────────
    // users → user_bank_accounts and tenants → background_checks are
    // PARENT-side FKs: TRUNCATE ... CASCADE on those two tables would chain
    // upward into users/landlords and erase every login. Null the pointer,
    // truncate everything else, then plain-DELETE those two at the end.
    await c.query(`UPDATE users SET default_management_payout_bank_account_id = NULL`)
    const wipe = [
      'properties',            // cascades: units, subtypes, allocation rules, common_areas…
      'tenants',               // cascades: tenant-linked rows
      'unit_bookings', 'booking_change_requests', 'unit_booking_waitlists',
      'leases', 'lease_documents', 'lease_fees',
      'payments', 'invoices', 'security_deposits', 'deposit_returns',
      'maintenance_requests', 'unit_inspections', 'unit_entry_requests',
      'application_pool', 'adverse_action_notices', 'unit_applications',
      'common_areas', 'common_area_reservations',
      'documents', 'document_batches', 'parts_inventory',
      'notifications', 'tenant_notifications', 'admin_notifications',
      'pending_tenant_intents', 'invitations',
      'flex_deposit_installments', 'flex_deposit_custody_charges', 'flexpay_advances',
      'flexsuite_enrollment_acceptances', 'security_deposit_interest_accruals',
      'user_balance_ledger', 'disbursements', 'platform_fee_accruals',
      'monthly_fee_accruals', 'platform_revenue_ledger',
      'credit_subjects', 'credit_events', 'credit_scores', 'credit_stats', 'credit_disputes',
      'pos_transactions', 'pos_sessions', 'pos_items', 'pos_categories', 'pos_customers',
      'lease_renewal_requests', 'lease_termination_requests',
    ]
    for (const t of wipe) {
      await c.query(`TRUNCATE TABLE ${t} CASCADE`)
    }
    await c.query(`DELETE FROM background_checks`)
    await c.query(`DELETE FROM user_bank_accounts`)

    // ── ACTORS ───────────────────────────────────────────────────────
    const james = await c.query(`SELECT u.id AS user_id, l.id AS landlord_id FROM users u JOIN landlords l ON l.user_id = u.id WHERE u.email = 'james@demo.dev'`)
    if (!james.rows.length) throw new Error('james@demo.dev landlord missing')
    const LL = james.rows[0].landlord_id as string
    const OWNER = james.rows[0].user_id as string

    const hash = (await c.query(`SELECT password_hash FROM users WHERE email = 'alice@tenant.dev'`)).rows[0]?.password_hash
      ?? (await c.query(`SELECT password_hash FROM users WHERE email = 'james@demo.dev'`)).rows[0].password_hash

    // Tenant users — upsert by email so logins stay tenant1234.
    const tenantUser = async (email: string, first: string, last: string) => {
      const r = await c.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, $2, 'tenant', $3, $4, TRUE)
         ON CONFLICT (email) DO UPDATE SET first_name = $3, last_name = $4, role = 'tenant'
         RETURNING id`, [email, hash, first, last])
      return r.rows[0].id as string
    }
    const U = {
      alice: await tenantUser('alice@tenant.dev', 'Alice', 'Morgan'),
      bob:   await tenantUser('bob@tenant.dev', 'Bob', 'Chen'),
      carol: await tenantUser('carol@tenant.dev', 'Carol', 'Vasquez'),
      dan:   await tenantUser('dan@tenant.dev', 'Dan', 'Okafor'),
      eva:   await tenantUser('eva@tenant.dev', 'Eva', 'Schmidt'),
      frank: await tenantUser('frank@tenant.dev', 'Frank', 'Williams'),
      grace: await tenantUser('grace@tenant.dev', 'Grace', 'Littlefeather'),
      henry: await tenantUser('henry@tenant.dev', 'Henry', 'Park'),
      iris:  await tenantUser('iris@tenant.dev', 'Iris', 'Nguyen'),
      jack:  await tenantUser('jack@tenant.dev', 'Jack', 'Romero'),
    }

    // ── PROPERTIES ───────────────────────────────────────────────────
    const prop = async (name: string, street: string, city: string, zip: string, extra: Record<string, any> = {}) => {
      const cols = ['landlord_id', 'name', 'street1', 'city', 'state', 'zip', 'owner_user_id', 'managed_by_user_id', ...Object.keys(extra)]
      const vals = [LL, name, street, city, 'AZ', zip, OWNER, OWNER, ...Object.values(extra)]
      const r = await c.query(
        `INSERT INTO properties (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)
      return r.rows[0].id as string
    }
    const sunset = await prop('Sunset Palms RV Resort', '4400 E Main St', 'Mesa', '85205', {
      nightly_rate: 55, weekly_rate: 320, monthly_rate: 900, short_term_tax_rate: 12,
      unit_types: '{rv_spot,storage}',
      // W-20 (S531): public booking site live in the demo — guests book by
      // SITE TYPE; the system assigns the unit and reveals it morning-of.
      public_booking_enabled: true, booking_slug: 'sunset-palms', booking_deposit_pct: 25,
    })
    const oak = await prop('Oak Street Apartments', '2210 N Oak St', 'Phoenix', '85004', {
      unit_types: '{apartment}',
    })
    const copper = await prop('Copper Canyon Homes', '78 W Canyon Rd', 'Tucson', '85701', {
      unit_types: '{single_family}',
    })
    // S527 W-39: BACKDATE onboarding — the platform fee (and any
    // from-onboarding-forward math) charges from properties.created_at.
    // Freshly-seeded properties would show $0 fees for every past month,
    // which reads as a bug in demos. (Established old-seed convention;
    // real customer data is never backdated.)
    await c.query(
      `UPDATE properties SET created_at = now() - interval '14 months' WHERE id = ANY($1::uuid[])`,
      [[sunset, oak, copper]])

    // ── SUBTYPES (sunset + oak configured; copper deliberately BLANK) ─
    const subtype = async (propertyId: string, unitType: string, name: string, f: Record<string, any>) => {
      const cols = ['property_id', 'unit_type', 'name', ...Object.keys(f)]
      const vals = [propertyId, unitType, name, ...Object.values(f)]
      const r = await c.query(
        `INSERT INTO property_unit_subtypes (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals)
      return r.rows[0].id as string
    }
    const stPull = await subtype(sunset, 'rv_spot', 'Pull-through 50 amp', { rv_site_layout: 'pull_through', rv_amp_service: '50', rent_amount: 900, security_deposit: 300, nightly_rate: 65, weekly_rate: 360, monthly_rate: 950 })
    const stBack = await subtype(sunset, 'rv_spot', 'Back-in 30 amp', { rv_site_layout: 'back_in', rv_amp_service: '30', rent_amount: 800, security_deposit: 300, nightly_rate: 48, weekly_rate: 290, monthly_rate: 850 })
    await subtype(sunset, 'storage', '10x20', { storage_size: '10x20', rent_amount: 150, security_deposit: 100 })
    const stStudio = await subtype(oak, 'apartment', 'Studio', { bedrooms: 0, bathrooms: 1, rent_amount: 750, security_deposit: 750 })
    const st2br = await subtype(oak, 'apartment', '2BR Standard', { bedrooms: 2, bathrooms: 1.5, rent_amount: 1150, security_deposit: 1150 })

    // ── UNITS ────────────────────────────────────────────────────────
    const unit = async (propertyId: string, num: string, f: Record<string, any>) => {
      const base: Record<string, any> = { property_id: propertyId, landlord_id: LL, unit_number: num, status: 'vacant', ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO units (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    const rvDefaults = { unit_type: 'rv_spot', bedrooms: 0, bathrooms: 0, is_bookable: true, lease_types_allowed: '{nightly,weekly,month_to_month,long_term}' }
    const rv: Record<string, string> = {}
    for (let i = 1; i <= 5; i++) rv[`P${i}`] = await unit(sunset, `RV ${String(i).padStart(2, '0')}`, { ...rvDefaults, rv_site_layout: 'pull_through', rv_amp_service: '50', rent_amount: 900, security_deposit: 300, nightly_rate: 65, weekly_rate: 360, monthly_rate: 950, subtype_id: stPull })
    for (let i = 6; i <= 10; i++) rv[`B${i}`] = await unit(sunset, `RV ${String(i).padStart(2, '0')}`, { ...rvDefaults, rv_site_layout: 'back_in', rv_amp_service: '30', rent_amount: 800, security_deposit: 300, nightly_rate: 48, weekly_rate: 290, monthly_rate: 850, subtype_id: stBack })
    const stor1 = await unit(sunset, 'Storage 01', { unit_type: 'storage', bedrooms: 0, bathrooms: 0, rent_amount: 150, security_deposit: 100, storage_size: '10x20' })
    await unit(sunset, 'Storage 02', { unit_type: 'storage', bedrooms: 0, bathrooms: 0, rent_amount: 150, security_deposit: 100, storage_size: '10x20' })

    const apt: Record<string, string> = {}
    apt['101'] = await unit(oak, 'Apt 101', { unit_type: 'apartment', bedrooms: 0, bathrooms: 1, rent_amount: 750, security_deposit: 750, subtype_id: stStudio })
    apt['102'] = await unit(oak, 'Apt 102', { unit_type: 'apartment', bedrooms: 0, bathrooms: 1, rent_amount: 750, security_deposit: 750, subtype_id: stStudio })
    apt['201'] = await unit(oak, 'Apt 201', { unit_type: 'apartment', bedrooms: 2, bathrooms: 1.5, rent_amount: 1150, security_deposit: 1150, subtype_id: st2br })
    apt['202'] = await unit(oak, 'Apt 202', { unit_type: 'apartment', bedrooms: 2, bathrooms: 1.5, rent_amount: 1150, security_deposit: 1150, subtype_id: st2br })
    apt['203'] = await unit(oak, 'Apt 203', { unit_type: 'apartment', bedrooms: 2, bathrooms: 1.5, rent_amount: 1150, security_deposit: 1150, subtype_id: st2br })
    apt['204'] = await unit(oak, 'Apt 204', { unit_type: 'apartment', bedrooms: 2, bathrooms: 1.5, rent_amount: 1195, security_deposit: 1195, subtype_id: st2br })

    const canyon: Record<string, string> = {}
    canyon['1'] = await unit(copper, 'House 01', { unit_type: 'single_family', bedrooms: 3, bathrooms: 2, rent_amount: 1650, security_deposit: 1650 })
    canyon['2'] = await unit(copper, 'House 02', { unit_type: 'single_family', bedrooms: 3, bathrooms: 2, rent_amount: 1650, security_deposit: 1650 })
    canyon['3'] = await unit(copper, 'House 03', { unit_type: 'single_family', bedrooms: 4, bathrooms: 2.5, rent_amount: 1900, security_deposit: 1900 })

    // ── TENANTS ──────────────────────────────────────────────────────
    const tenant = async (userId: string, f: Record<string, any> = {}) => {
      const base: Record<string, any> = { user_id: userId, ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO tenants (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    const T = {
      alice: await tenant(U.alice, { ach_verified: true,  background_check_status: 'approved' }),
      bob:   await tenant(U.bob,   { ach_verified: true,  background_check_status: 'approved' }),
      carol: await tenant(U.carol, { ach_verified: true,  background_check_status: 'approved' }),
      dan:   await tenant(U.dan,   { ach_verified: true,  background_check_status: 'approved' }),
      eva:   await tenant(U.eva,   { ach_verified: false, background_check_status: 'approved' }),
      frank: await tenant(U.frank, { ach_verified: true,  background_check_status: 'approved' }),
      grace: await tenant(U.grace, { ach_verified: true,  background_check_status: 'approved', ssi_ssdi: true }),
      henry: await tenant(U.henry, { ach_verified: false, background_check_status: 'not_started' }),
    }

    // ── LEASES ───────────────────────────────────────────────────────
    const lease = async (unitId: string, tenantId: string | null, f: Record<string, any>) => {
      const base: Record<string, any> = { unit_id: unitId, landlord_id: LL, lease_type: 'fixed_term', status: 'active', rent_due_day: 1, ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO leases (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      const id = r.rows[0].id as string
      if (tenantId) await c.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [id, tenantId])
      return id
    }
    // Active, healthy — Alice on Apt 201 (started 8 months ago, 12-mo term)
    const lAlice = await lease(apt['201'], T.alice, { rent_amount: 1150, start_date: addMonths(-8), end_date: addMonths(4) })
    // Delinquent — Bob on Apt 101
    const lBob = await lease(apt['101'], T.bob, { rent_amount: 750, start_date: addMonths(-6), end_date: addMonths(6) })
    // Expiring in 21 days — Carol on Apt 202 (renewal window)
    const lCarol = await lease(apt['202'], T.carol, { rent_amount: 1150, start_date: addMonths(-11), end_date: addDays(21) })
    // Month-to-month (open-ended) — Dan on Apt 102
    const lDan = await lease(apt['102'], T.dan, { rent_amount: 750, start_date: addMonths(-14), end_date: null, lease_type: 'month_to_month' })
    // Pending signature — Eva on Apt 203 (lease drafted, not yet signed)
    const lEva = await lease(apt['203'], T.eva, { rent_amount: 1150, start_date: addDays(10), end_date: addMonths(12), status: 'pending', needs_review: false })
    // Eviction mode — Frank on Apt 204 (suspended unit below)
    const lFrank = await lease(apt['204'], T.frank, { rent_amount: 1195, start_date: addMonths(-9), end_date: addMonths(3) })
    // Long-term RV with FlexDeposit custody — Grace on RV 08
    const lGrace = await lease(rv['B8'], T.grace, { rent_amount: 850, start_date: addMonths(-2), end_date: addMonths(10) })
    // Terminated history — Dan's old studio (ended 3 months ago)
    await lease(apt['102'], null, { rent_amount: 700, start_date: addMonths(-26), end_date: addMonths(-3), status: 'terminated' })

    // W-30 (S529): landlord-billable fees live IN the lease terms
    // (due_timing='other') — the Bill Fee button offers ONLY these rows and
    // bills the row's amount. Seed them so the flow is demoable.
    const leaseFee = (leaseId: string, feeType: string, amount: number, description: string) =>
      c.query(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, is_override, description)
         VALUES ($1, $2, $3, FALSE, 'other', FALSE, $4)`,
        [leaseId, feeType, amount, description])
    await leaseFee(lAlice, 'early_termination_fee', 2300, 'Two months rent if terminated before the end date (§ 7)')
    await leaseFee(lBob,   'early_termination_fee', 1500, 'Early termination per § 7')
    await leaseFee(lBob,   'other_fee',             75,   'Lease-violation fee per § 12 (noise/parking/pets)')
    await leaseFee(lCarol, 'early_termination_fee', 2300, 'Two months rent if terminated before the end date (§ 7)')
    await leaseFee(lGrace, 'other_fee',             50,   'Site-rules violation fee per park addendum § 4')

    // Unit statuses to match
    const setUnit = (id: string, status: string, extra = '') => c.query(`UPDATE units SET status = $1 ${extra} WHERE id = $2`, [status, id])
    await setUnit(apt['201'], 'active')
    await setUnit(apt['101'], 'delinquent')
    await setUnit(apt['202'], 'active')
    await setUnit(apt['102'], 'active')
    await setUnit(apt['204'], 'suspended', ', payment_block = TRUE')
    await setUnit(rv['B8'], 'active')
    await setUnit(rv['P2'], 'active')

    // ── PAYMENTS + INVOICES ──────────────────────────────────────────
    const pay = async (f: Record<string, any>) => {
      const base: Record<string, any> = { landlord_id: LL, type: 'rent', entry_description: 'RENT', status: 'settled', ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO payments (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    let invNo = 1000
    const invoice = async (f: Record<string, any>) => {
      const base: Record<string, any> = { landlord_id: LL, invoice_number: `INV-${invNo++}`, status: 'settled', ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO invoices (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    // 3 months of settled rent for the healthy tenants; current month pending.
    const healthy: Array<[string, string, string, number]> = [
      [lAlice, T.alice, apt['201'], 1150], [lCarol, T.carol, apt['202'], 1150],
      [lDan, T.dan, apt['102'], 750], [lGrace, T.grace, rv['B8'], 850],
    ]
    for (const [lid, tid, uid, rent] of healthy) {
      for (let m = -3; m <= -1; m++) {
        await pay({ lease_id: lid, tenant_id: tid, unit_id: uid, amount: rent, due_date: firstOfMonth(m), status: 'settled', settled_at: firstOfMonth(m) })
        await invoice({ lease_id: lid, tenant_id: tid, unit_id: uid, total_amount: rent, subtotal_rent: rent, due_date: firstOfMonth(m), status: 'settled' })
      }
      await pay({ lease_id: lid, tenant_id: tid, unit_id: uid, amount: rent, due_date: firstOfMonth(0), status: 'pending' })
      await invoice({ lease_id: lid, tenant_id: tid, unit_id: uid, total_amount: rent, subtotal_rent: rent, due_date: firstOfMonth(0), status: 'pending' })
    }
    // Bob: last month FAILED + overdue invoice + late fee pending (balance).
    await pay({ lease_id: lBob, tenant_id: T.bob, unit_id: apt['101'], amount: 750, due_date: firstOfMonth(-1), status: 'failed' })
    await invoice({ lease_id: lBob, tenant_id: T.bob, unit_id: apt['101'], total_amount: 750, subtotal_rent: 750, due_date: firstOfMonth(-1), status: 'pending' })
    await pay({ lease_id: lBob, tenant_id: T.bob, unit_id: apt['101'], amount: 50, type: 'late_fee', entry_description: 'LATEFEE', due_date: addDays(-20), status: 'pending' })
    await pay({ lease_id: lBob, tenant_id: T.bob, unit_id: apt['101'], amount: 750, due_date: firstOfMonth(0), status: 'pending' })
    // Frank (eviction): two months unpaid.
    for (const m of [-2, -1]) {
      await pay({ lease_id: lFrank, tenant_id: T.frank, unit_id: apt['204'], amount: 1195, due_date: firstOfMonth(m), status: 'failed' })
      await invoice({ lease_id: lFrank, tenant_id: T.frank, unit_id: apt['204'], total_amount: 1195, subtotal_rent: 1195, due_date: firstOfMonth(m), status: 'pending' })
    }

    // ── SECURITY DEPOSITS ────────────────────────────────────────────
    const deposit = async (unitId: string, leaseId: string, tenantId: string, f: Record<string, any>) => {
      const base: Record<string, any> = { unit_id: unitId, lease_id: leaseId, tenant_id: tenantId, held_by: 'landlord', status: 'funded', ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO security_deposits (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    await deposit(apt['201'], lAlice, T.alice, { total_amount: 1150, collected_amount: 1150 })
    await deposit(apt['101'], lBob, T.bob, { total_amount: 750, collected_amount: 750 })
    await deposit(apt['202'], lCarol, T.carol, { total_amount: 1150, collected_amount: 1150 })
    await deposit(apt['204'], lFrank, T.frank, { total_amount: 1195, collected_amount: 1195 })
    // Grace: FlexDeposit CUSTODY plan — 2 of 4 installments collected.
    const graceDep = await deposit(rv['B8'], lGrace, T.grace, {
      held_by: 'gam_escrow', status: 'partial', total_amount: 300, collected_amount: 150,
      flex_deposit_enabled: true, installment_count: 4, installment_amount: 75,
      installments_paid: 2, installments_remaining: 2, next_installment_date: addDays(12),
      flex_deposit_plan_status: 'active', custody_fee_active: true,
    })
    await c.query(`UPDATE tenants SET flex_deposit_enrolled = TRUE WHERE id = $1`, [T.grace])

    // ── WORK TRADE (W-54/W-56, S531) ─────────────────────────────────
    // Grace runs a groundskeeping work-trade: approved + pending hours so
    // the landlord reconciliation surface has real work in it.
    const wtAgr = await c.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, duties, start_date, status)
       VALUES ($1, $2, $3, 'Groundskeeping: mow common areas, empty pavilion trash, pool skimming', $4, 'active')
       RETURNING id`, [rv['B8'], T.grace, LL, addDays(-60)])
    const WT = wtAgr.rows[0].id
    const wtLog = (daysAgo: number, hours: number, descr: string, status: string) => c.query(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7='approved' THEN now() END)`,
      [WT, T.grace, U.grace, addDays(-daysAgo), hours, descr, status])
    await wtLog(12, 6.0, 'Mowed common areas + trimmed pavilion hedges', 'approved')
    await wtLog(8,  5.5, 'Pool skimming + skimmer basket replacement', 'approved')
    await wtLog(4,  4.0, 'Emptied pavilion trash, pressure-washed walkway', 'approved')
    await wtLog(1,  7.0, 'Mowed all common areas, edged along Row A', 'pending')
    await wtLog(0,  3.5, 'Morning pool skim + chemical check assist', 'pending')

    // ── UTILITY SUB-METERS + READING RUN (S532) ────────────────────
    // RV spots are always sub-metered for electric (Nic). One pedestal
    // meter per spot, assigned 1:1 — utilityBilling bills full usage to
    // EVERY unit on a submeter, so a shared submeter double-bills.
    // Grace's spot keeps the original "Pedestal Row A" label.
    //
    // Demo state matches the end-of-month reading-run workflow: every
    // meter has ONLY a prior-cycle baseline (dated month-end), and an
    // OPEN run for the current cycle — the walkthrough enters current
    // readings through the guided walk, which auto-bills leased spots
    // (Grace: enter 1250 → 250 kWh × $0.14 = $35.00 on her next invoice).
    await c.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'electric', TRUE) ON CONFLICT DO NOTHING`, [lGrace])
    const cycleNow = new Date(); cycleNow.setDate(1)
    const cyclePrev = new Date(cycleNow); cyclePrev.setMonth(cyclePrev.getMonth() - 1)
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
    const prevMonthEnd = (() => { const d = new Date(cycleNow); d.setDate(0)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    const pedestal = async (label: string, unitId: string, baseline: number) => {
      const m = await c.query(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rate_per_unit, base_fee)
         VALUES ($1, 'electric', $2, 'submeter', 0.14, 0) RETURNING id`, [sunset, label])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [m.rows[0].id, unitId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [m.rows[0].id, prevMonthEnd, baseline, iso(cyclePrev), OWNER])
    }
    await pedestal('Pedestal Row A',  rv['B8'],  1000)
    await pedestal('Pedestal RV 01',  rv['P1'],  4210)
    await pedestal('Pedestal RV 02',  rv['P2'],  2840)
    await pedestal('Pedestal RV 03',  rv['P3'],  1520)
    await pedestal('Pedestal RV 04',  rv['P4'],  3105)
    await pedestal('Pedestal RV 05',  rv['P5'],  5230)
    await pedestal('Pedestal RV 06',  rv['B6'],   980)
    await pedestal('Pedestal RV 07',  rv['B7'],  2444)
    await pedestal('Pedestal RV 09',  rv['B9'],     0)
    await pedestal('Pedestal RV 10',  rv['B10'],    0)
    // Open reading run for the current cycle (the walkthrough's prompt).
    await c.query(
      `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on)
       VALUES ($1, $2, $3, CURRENT_DATE)
       ON CONFLICT (property_id, billing_cycle_month) DO NOTHING`,
      [sunset, LL, iso(cycleNow)])
    for (let n = 1; n <= 4; n++) {
      await c.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count, amount, due_date, status, settled_at, primary_pull_date)
         VALUES ($1, $2, $3, 4, 75, $4, $5, $6, $4)`,
        [graceDep, T.grace, n, addDays((n - 3) * 30 + 12), n <= 2 ? 'settled' : 'pending', n <= 2 ? new Date() : null])
    }

    // ── BOOKINGS (RV) ────────────────────────────────────────────────
    const booking = async (unitId: string, guest: string, ci: string, co: string, f: Record<string, any> = {}) => {
      const nights = Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000)
      const base: Record<string, any> = {
        unit_id: unitId, landlord_id: LL, guest_name: guest, lease_type: 'nightly',
        check_in: ci, check_out: co, nights, total_amount: nights * 65 * 1.12, platform_fee: 0, source: 'direct',
        guest_email: `${guest.split(' ')[0].toLowerCase()}@example.com`, guest_phone: '480-555-0100', ...f,
      }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO unit_bookings (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    await booking(rv['P1'], 'Hank Fletcher', addDays(-9), addDays(-5), { status: 'checked_out' })
    const current = await booking(rv['P1'], 'Rosa Delgado', addDays(-2), addDays(3), { status: 'checked_in' })
    await booking(rv['P3'], 'Bill Tanaka', addDays(2), addDays(6))
    await booking(rv['P4'], 'June Whitfield', addDays(5), addDays(12))
    await booking(rv['B6'], 'Ollie Grant', addDays(1), addDays(4), { lease_type: 'nightly', total_amount: 3 * 48 * 1.12 })
    // 35-night stay → auto-drafted lease awaiting landlord review.
    const longStay = await booking(rv['P5'], 'Marta Ibanez', addDays(4), addDays(39), { lease_type: 'month_to_month', total_amount: 950 * 1.17 })
    await lease(rv['P5'], null, {
      rent_amount: 950, start_date: addDays(4), end_date: addDays(39),
      status: 'pending', needs_review: true, lease_source: 'booking_draft', source_booking_id: longStay,
      lease_type: 'month_to_month',
    })
    // Pending change request on the in-house stay.
    await c.query(
      `INSERT INTO booking_change_requests (booking_id, landlord_id, request_type, status, details)
       VALUES ($1, $2, 'late_checkout', 'requested', 'Would like to check out at 2pm if possible')`,
      [current, LL])

    // ── MAINTENANCE (all four states) ────────────────────────────────
    const maint = async (unitId: string, tenantId: string | null, title: string, f: Record<string, any>) => {
      const base: Record<string, any> = { unit_id: unitId, landlord_id: LL, tenant_id: tenantId, title, description: title, ...f }
      const cols = Object.keys(base)
      const r = await c.query(`INSERT INTO maintenance_requests (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    const faucetReq = await maint(apt['201'], T.alice, 'Kitchen faucet dripping', { status: 'open', priority: 'normal', category: 'plumbing' })
    await maint(apt['102'], T.dan, 'AC not cooling below 82°F', { status: 'in_progress', priority: 'high', category: 'hvac' })
    await maint(rv['B8'], T.grace, 'Pedestal breaker trips on 30A load', { status: 'awaiting_approval', priority: 'high', category: 'electrical', estimated_cost: 780 })
    await maint(apt['202'], T.carol, 'Bedroom window latch replaced', { status: 'completed', priority: 'low', category: 'general', completed_at: new Date() })

    // ── INSPECTIONS ──────────────────────────────────────────────────
    await c.query(
      `INSERT INTO unit_inspections (unit_id, landlord_id, inspection_type, status, tenant_id, lease_id)
       VALUES ($1, $2, 'move_in', 'draft', $3, $4)`, [apt['203'], LL, T.eva, lEva])
    await c.query(
      `INSERT INTO unit_inspections (unit_id, landlord_id, inspection_type, status, tenant_id, lease_id)
       VALUES ($1, $2, 'periodic', 'finalized', $3, $4)`, [apt['201'], LL, T.alice, lAlice])

    // ── SCREENING: background checks + applicant pool ────────────────
    const bg = async (userId: string, f: Record<string, any>) => {
      // S527 W-6: checks carry applicant-entered identity fields — populate
      // from the user so the Background Checks page shows names.
      const u = (await c.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [userId])).rows[0]
      const base: Record<string, any> = { landlord_id: LL, user_id: userId, first_name: u.first_name, last_name: u.last_name, consent_credit: true, consent_criminal: true, consent_pool: true, ...f }
      const cols = Object.keys(base)
      const r = await c.query(
        `INSERT INTO background_checks (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(base))
      return r.rows[0].id as string
    }
    await bg(U.iris, { status: 'submitted' })
    const jackBg = await bg(U.jack, { status: 'approved', risk_level: 'low' })
    // Pool preview fields matter (S527 W-48): pre-purchase the pool shows a
    // REDACTED preview (employment/income/location/risk — identity only
    // unlocks after report purchase), so those fields must be populated.
    await c.query(
      `INSERT INTO application_pool
         (background_check_id, user_id, status, employment_status, monthly_income,
          city, state, zip, risk_level, risk_score)
       VALUES ($1, $2, 'available', 'full_time', 4200, 'Mesa', 'AZ', '85205', 'low', 12)`,
      [jackBg, U.jack])

    // ── TENANT ONBOARDING (Henry mid-flow) ───────────────────────────
    await c.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'not_uploaded')`,
      [LL, T.henry])

    // ── AMENITIES ────────────────────────────────────────────────────
    const area = async (propertyId: string, name: string, fee: number) => {
      const r = await c.query(
        `INSERT INTO common_areas (property_id, landlord_id, name, reservation_fee) VALUES ($1, $2, $3, $4) RETURNING id`,
        [propertyId, LL, name, fee])
      return r.rows[0].id as string
    }
    const club = await area(sunset, 'Clubhouse', 25)
    await area(sunset, 'Pool', 0)
    await area(oak, 'Community Laundry', 0)
    await c.query(
      `INSERT INTO common_area_reservations
         (common_area_id, property_id, landlord_id, reserved_by_tenant_id, created_by_user_id,
          title, kind, starts_at, ends_at, status, fee_amount)
       VALUES ($1, $2, $3, $4, $5, 'Birthday gathering', 'tenant_reservation', $6, $7, 'pending', 25)`,
      [club, sunset, LL, T.grace, U.grace,
       new Date(Date.now() + 5 * 86400000), new Date(Date.now() + 5 * 86400000 + 3 * 3600000)])

    // ── DOCUMENTS ────────────────────────────────────────────────────
    await c.query(
      `INSERT INTO documents (landlord_id, type, name, url) VALUES
       ($1, 'lease', 'Standard RV Site Lease (blank)', '/uploads/leases/demo-lease.pdf'),
       ($1, 'notice', 'Pool Maintenance Notice — July', '/uploads/docs/demo-notice.pdf')`, [LL])

    // ── E-SIGN LEASE TEMPLATE (W-7, S531) ────────────────────────────
    // One usable template so the renewal-decision flow (and any e-sign
    // send) can draft documents in the demo. Terms fields (rent/dates/
    // deposit) are LANDLORD-fillable in the document per the "lease is
    // the document" standard; identity fields prefill from the flow.
    // Templates survive the wipe (see Keeps) — guard against duplicating
    // on re-runs.
    const existingTmpl = await c.query(
      `SELECT id FROM lease_templates WHERE landlord_id = $1 AND name = 'Standard Residential Lease'`, [LL])
    const tmplRes = existingTmpl.rows.length ? existingTmpl : await c.query(
      `INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count)
       VALUES ($1, 'Standard Residential Lease', 'Demo lease template', '/api/esign/files/demo-lease.pdf', 1)
       RETURNING id`, [LL])
    const TMPL = tmplRes.rows[0].id
    if (!existingTmpl.rows.length) await c.query(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order) VALUES
       ($1,'text','landlord','Tenant Name','tenant_name',1,72,120,220,24,true,1),
       ($1,'text','landlord','Unit Number','unit_number',1,320,120,120,24,true,2),
       ($1,'text','landlord','Monthly Rent','rent_amount',1,72,170,140,24,true,3),
       ($1,'date','landlord','Lease Start','start_date',1,240,170,130,24,true,4),
       ($1,'date','landlord','Lease End','end_date',1,400,170,130,24,false,5),
       ($1,'text','landlord','Security Deposit','security_deposit',1,72,220,140,24,false,6),
       ($1,'signature','landlord','Landlord Signature','landlord_signature',1,72,600,200,40,true,7),
       ($1,'date','landlord','Date Signed','date_signed',1,300,600,120,24,true,8),
       ($1,'signature','primary','Tenant Signature','tenant_signature',1,72,680,200,40,true,9),
       ($1,'date','primary','Date Signed','date_signed',1,300,680,120,24,true,10)`, [TMPL])

    // ── INVENTORY (one low-stock) ────────────────────────────────────
    await c.query(
      `INSERT INTO parts_inventory (landlord_id, name, quantity, min_quantity, unit) VALUES
       ($1, 'Air filters 20x20x1', 24, 10, 'each'),
       ($1, 'Water heater elements', 2, 4, 'each'),
       ($1, '50A RV receptacles', 6, 3, 'each'),
       ($1, 'Door lock sets', 8, 5, 'each')`, [LL])

    // ── POS catalog (one low-stock) ──────────────────────────────────
    const posCat = (await c.query(
      `INSERT INTO pos_categories (landlord_id, property_id, name) VALUES ($1, $2, 'Camp Store') RETURNING id`,
      [LL, sunset])).rows[0].id
    await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, cost_price, sell_price, stock_qty, stock_min, stock_max) VALUES
       ($1, $2, $3, 'Propane refill (20lb)', 9.50, 21.99, 40, 10, 60),
       ($1, $2, $3, 'Bag of ice (10lb)', 0.90, 3.50, 55, 20, 80),
       ($1, $2, $3, 'RV sewer hose kit', 14.00, 32.99, 3, 5, 15),
       ($1, $2, $3, 'Firewood bundle', 3.25, 8.99, 30, 10, 50),
       ($1, $2, $3, 'Sunscreen SPF 50', 4.10, 11.99, 12, 5, 25)`, [LL, sunset, posCat])

    // ── BANK ACCOUNT ─────────────────────────────────────────────────
    await c.query(
      `INSERT INTO user_bank_accounts (user_id, nickname, account_holder_name, account_type, routing_number, account_number_last4, account_number_encrypted, status)
       VALUES ($1, 'Operating — Desert West CU', 'James Thornton', 'checking', '122105278', '4417', 'demo-encrypted', 'active')`, [OWNER])

    // ── NOTIFICATIONS (unread for the landlord) ──────────────────────
    // S527 W-1: action_url deep-links to the SPECIFIC item — /maintenance and
    // /leases both support ?open=<id>.
    const martaDraft = (await c.query(
      `SELECT id FROM leases WHERE source_booking_id = $1`, [longStay])).rows[0].id
    await c.query(
      `INSERT INTO notifications (user_id, type, title, body, action_url) VALUES
       ($1, 'maintenance_submitted', 'New maintenance request', 'Kitchen faucet dripping — Apt 201, Oak Street Apartments', '/maintenance?open=' || $2),
       ($1, 'lease_expiring', 'Lease expiring soon', 'Carol Vasquez — Apt 202 lease ends in 21 days', '/leases?open=' || $3),
       ($1, 'pos_low_stock', 'Inventory low', 'Water heater elements below minimum (2 of 4)', '/inventory'),
       ($1, 'lease_drafted_from_booking', 'Lease drafted from reservation', 'Marta Ibanez — RV 05, 35-night stay needs review', '/leases?open=' || $4)`,
      [OWNER, faucetReq, lCarol, martaDraft])

    // ── RENTAL HISTORY (S527 W-51): credit-ledger payment events ─────
    // MUST go through appendEvent — credit_events are hash-chained; raw
    // inserts would break chain verification. Same shape as the Stripe
    // webhook emitter. Alice = clean multi-month record; Bob = rough patch.
    const history = async (tenantId: string, monthOffset: number, kind: 'on_time' | 'late_minor' | 'late_major', amount: number) => {
      const due = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1)
      const paid = new Date(due)
      paid.setDate(kind === 'on_time' ? 1 : kind === 'late_minor' ? 9 : 21)
      await appendEvent({
        subjectType: 'tenant',
        subjectRefId: tenantId,
        eventType: kind === 'on_time' ? 'payment_received_on_time'
          : kind === 'late_minor' ? 'payment_received_late_minor' : 'payment_received_late_major',
        eventData: {
          payment_type: 'rent', amount: String(amount),
          due_date: due.toISOString(), paid_at: paid.toISOString(), grace_days: 5,
        },
        occurredAt: paid,
        attestationSource: 'stripe_attested',
        dimensionTags: ['payment_reliability'],
        networkVisibility: kind === 'on_time' ? 'visible_to_current_landlord' : 'visible_to_gam_network',
      }, c)
    }
    for (let m = -8; m <= -1; m++) await history(T.alice, m, 'on_time', 1150)   // clean record
    for (const [m, k] of [[-6, 'on_time'], [-5, 'on_time'], [-4, 'late_minor'], [-3, 'on_time'], [-2, 'late_major'], [-1, 'late_minor']] as const) {
      await history(T.bob, m, k, 750)                                            // rough patch
    }
    for (let m = -2; m <= -1; m++) await history(T.grace, m, 'on_time', 850)

    // ── RE-POINT Dana's property lock to the new RV resort ───────────
    await c.query(
      `UPDATE onsite_manager_scopes s SET property_ids = ARRAY[$1]::uuid[]
        WHERE s.landlord_id = $2 AND s.all_properties = FALSE
          AND s.user_id = (SELECT id FROM users WHERE email = 'testdesk-demo@golddoor.io')`,
      [sunset, LL])

    await c.query('COMMIT')

    // Post-commit: build stats/scores the nightly cron would (so the
    // screening page shows on-time % immediately, not after 2am).
    await refreshAllSubjectStats()
    await recomputeAllSubjects()

    console.log('✓ Demo world seeded.')
    console.log(`  Properties: Sunset Palms (${sunset.slice(0, 8)}), Oak Street (${oak.slice(0, 8)}), Copper Canyon (${copper.slice(0, 8)})`)
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
    await db.end()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
