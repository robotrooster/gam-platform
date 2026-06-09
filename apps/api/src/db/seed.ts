import bcrypt from 'bcryptjs'
import { db } from './index'

async function seed() {
  console.log('🌱  Seeding GAM demo data…')
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    // ── ADMIN USER ────────────────────────────────────────
    const adminHash = await bcrypt.hash('admin1234', 12)
    const { rows: [admin] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
        email_verified, email_verified_at)
      VALUES ('admin@gam.dev', $1, 'admin', 'Platform', 'Admin', '602-555-0001',
        TRUE, NOW())
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $1,
        email_verified = TRUE,
        email_verified_at = COALESCE(users.email_verified_at, NOW())
      RETURNING id`, [adminHash])
    console.log('  ✓ Admin:', admin.id)

    // ── LANDLORD 1 (demo — large portfolio) ───────────────
    const lHash = await bcrypt.hash('landlord1234', 12)
    const { rows: [lUser1] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
        email_verified, email_verified_at)
      VALUES ('james@demo.dev', $1, 'landlord', 'James', 'Thornton', '602-555-1001',
        TRUE, NOW())
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $1,
        email_verified = TRUE,
        email_verified_at = COALESCE(users.email_verified_at, NOW())
      RETURNING id`, [lHash])
    const { rows: [landlord1] } = await client.query(`
      INSERT INTO landlords (user_id, business_name, onboarding_complete, volume_tier)
      VALUES ($1, 'Thornton Properties LLC', TRUE, 'standard')
      RETURNING id`, [lUser1.id])
    console.log('  ✓ Landlord 1:', landlord1.id)

    // ── LANDLORD 2 (demo — small portfolio) ───────────────
    const { rows: [lUser2] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
        email_verified, email_verified_at)
      VALUES ('maria@demo.dev', $1, 'landlord', 'Maria', 'Reyes', '520-555-2001',
        TRUE, NOW())
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $1,
        email_verified = TRUE,
        email_verified_at = COALESCE(users.email_verified_at, NOW())
      RETURNING id`, [lHash])
    const { rows: [landlord2] } = await client.query(`
      INSERT INTO landlords (user_id, business_name, onboarding_complete, volume_tier)
      VALUES ($1, 'Reyes Rentals', TRUE, 'standard')
      RETURNING id`, [lUser2.id])
    console.log('  ✓ Landlord 2:', landlord2.id)

    // ── LANDLORD 3 — Nic's real-email landlord, no portfolio ───
    // S291: kept in seed.ts so a fresh `db:seed` restores this account
    // even after a drop+recreate. Intentionally has NO properties /
    // units / leases — Nic's full-walkthrough plan is to onboard a
    // real property through the landlord-portal UI from a clean slate.
    // Password defaults to landlord1234; change via the UI post-seed
    // if you want something different.
    const { rows: [lUser3] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
        email_verified, email_verified_at)
      VALUES ('realestaterhoades@gmail.com', $1, 'landlord', 'Nic', 'Rhoades', '602-555-9999',
        TRUE, NOW())
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $1,
        email_verified = TRUE,
        email_verified_at = COALESCE(users.email_verified_at, NOW())
      RETURNING id`, [lHash])
    await client.query(`
      INSERT INTO landlords (user_id, business_name, onboarding_complete, volume_tier)
      VALUES ($1, NULL, FALSE, 'standard')
      RETURNING id`, [lUser3.id])
    console.log('  ✓ Landlord 3 (Nic, no portfolio):', lUser3.id)

    // ── PROPERTY 1 ────────────────────────────────────────
    // S291: properties now require owner_user_id + managed_by_user_id
    // (NOT NULL). For self-managed demo properties both point at the
    // landlord's own user. PM-managed properties would differ; demo
    // stays simple.
    const { rows: [prop1] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type,
        owner_user_id, managed_by_user_id)
      VALUES ($1, 'Oak Street Apartments', '4821 W Oak St', 'Phoenix', 'AZ', '85031', 'residential',
        $2, $2)
      RETURNING id`, [landlord1.id, lUser1.id])

    const { rows: [prop2] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type,
        owner_user_id, managed_by_user_id)
      VALUES ($1, 'Mesa View Complex', '1140 S Dobson Rd', 'Mesa', 'AZ', '85202', 'residential',
        $2, $2)
      RETURNING id`, [landlord1.id, lUser1.id])

    const { rows: [prop3] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type,
        owner_user_id, managed_by_user_id)
      VALUES ($1, 'Tucson Budget Rentals', '2200 E Speedway Blvd', 'Tucson', 'AZ', '85719', 'residential',
        $2, $2)
      RETURNING id`, [landlord2.id, lUser2.id])

    console.log('  ✓ Properties:', [prop1?.id, prop2?.id, prop3?.id].filter(Boolean).length)

    // ── TENANTS ───────────────────────────────────────────
    const tHash = await bcrypt.hash('tenant1234', 12)
    const tenantData = [
      { email:'alice@tenant.dev', first:'Alice', last:'Morgan',   phone:'602-555-3001', ssi:false, late:0,  otp:false },
      { email:'bob@tenant.dev',   first:'Bob',   last:'Chen',     phone:'602-555-3002', ssi:true,  late:2,  otp:true  },
      { email:'carol@tenant.dev', first:'Carol', last:'Vasquez',  phone:'602-555-3003', ssi:false, late:0,  otp:false },
      { email:'dan@tenant.dev',   first:'Dan',   last:'Okafor',   phone:'480-555-3004', ssi:false, late:1,  otp:false },
      { email:'eva@tenant.dev',   first:'Eva',   last:'Schmidt',  phone:'480-555-3005', ssi:true,  late:3,  otp:true  },
      { email:'frank@tenant.dev', first:'Frank', last:'Williams', phone:'520-555-3006', ssi:false, late:0,  otp:false },
    ]

    const tenants: any[] = []
    for (const t of tenantData) {
      const { rows: [tu] } = await client.query(`
        INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
          email_verified, email_verified_at)
        VALUES ($1,$2,'tenant',$3,$4,$5, TRUE, NOW())
        ON CONFLICT (email) DO UPDATE SET
          password_hash = $2,
          email_verified = TRUE,
          email_verified_at = COALESCE(users.email_verified_at, NOW())
        RETURNING id`, [t.email, tHash, t.first, t.last, t.phone])
      const { rows: [ten] } = await client.query(`
        INSERT INTO tenants (user_id, ach_verified, ssi_ssdi, on_time_pay_enrolled,
          float_fee_active, income_arrival_day, credit_reporting_enrolled, late_payment_count)
        VALUES ($1, TRUE, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [tu.id, t.ssi, t.otp, t.otp, t.ssi ? 15 : null, !t.ssi, t.late])
      tenants.push(ten)
    }
    console.log('  ✓ Tenants:', tenants.length)

    // ── UNITS ─────────────────────────────────────────────
    if (prop1?.id) {
      const units1 = [
        { num:'101', beds:2, baths:1, rent:750,  tenant: tenants[0], status:'active',     otp:true  },
        { num:'102', beds:1, baths:1, rent:650,  tenant: tenants[1], status:'active',     otp:true  },
        { num:'103', beds:2, baths:2, rent:875,  tenant: tenants[2], status:'active',     otp:true  },
        { num:'104', beds:1, baths:1, rent:625,  tenant: null,       status:'vacant',     otp:false },
        { num:'105', beds:2, baths:1, rent:800,  tenant: tenants[3], status:'delinquent', otp:false },
        { num:'106', beds:3, baths:2, rent:1050, tenant: null,       status:'vacant',     otp:false },
      ]
      for (const u of units1) {
        await client.query(`
          INSERT INTO units (property_id, landlord_id, unit_number, bedrooms, bathrooms,
            rent_amount, security_deposit, status, on_time_pay_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (property_id, unit_number) DO NOTHING`,
          [prop1.id, landlord1.id, u.num,
           u.beds, u.baths, u.rent, u.rent, u.status, u.otp])
      }
    }

    if (prop2?.id) {
      const units2 = [
        { num:'201', beds:2, baths:1, rent:825,  tenant: tenants[4], status:'active',  otp:true  },
        { num:'202', beds:2, baths:2, rent:950,  tenant: null,       status:'vacant',  otp:false },
        { num:'203', beds:1, baths:1, rent:575,  tenant: tenants[5], status:'active',  otp:true  },
      ]
      for (const u of units2) {
        await client.query(`
          INSERT INTO units (property_id, landlord_id, unit_number, bedrooms, bathrooms,
            rent_amount, security_deposit, status, on_time_pay_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (property_id, unit_number) DO NOTHING`,
          [prop2.id, landlord1.id, u.num,
           u.beds, u.baths, u.rent, u.rent, u.status, u.otp])
      }
    }

    if (prop3?.id) {
      await client.query(`
        INSERT INTO units (property_id, landlord_id, unit_number, bedrooms, bathrooms,
          rent_amount, security_deposit, status)
        VALUES ($1,$2,'A1',1,1,550,550,'vacant'),($1,$2,'A2',2,1,700,700,'vacant')
        ON CONFLICT (property_id, unit_number) DO NOTHING`, [prop3.id, landlord2.id])
    }

    console.log('  ✓ Units seeded')

    // ── LEASES (S291) ─────────────────────────────────────
    // Pre-S291 the seed never created leases — units had a
    // "tenant" field locally but no lease row connected them, so
    // v_unit_occupancy reported zero occupied units and the
    // downstream payments seed silently no-op'd. Fix-forward:
    // create a lease + lease_tenants for every occupied unit,
    // 24 months back from today so the rent-history block below
    // has somewhere to attach.
    const HISTORY_MONTHS = 24
    const HISTORY_START = '2024-04-01'   // first lease start + first invoice cycle
    const occupiedUnits = await client.query<{
      id: string; rent_amount: string; landlord_id: string; tenant_id: string
    }>(`
      SELECT u.id, u.rent_amount, u.landlord_id, t.id AS tenant_id
      FROM units u
      JOIN tenants t ON t.user_id IN (SELECT user_id FROM tenants WHERE id IN (
        SELECT id FROM tenants ORDER BY id
      ))
      WHERE FALSE`)
    // The JOIN above is a placeholder — we use the in-memory
    // tenants[] + the unit-tenant mapping below instead.
    void occupiedUnits

    // Re-derive the unit→tenant mapping by querying units in the
    // order they were inserted, then matching against the local
    // tenants[] array via the original unit-data shape.
    const allUnits = await client.query<{
      id: string; unit_number: string; rent_amount: string;
      landlord_id: string; property_id: string;
    }>(`
      SELECT u.id, u.unit_number, u.rent_amount, u.landlord_id, u.property_id
      FROM units u
      JOIN properties p ON p.id = u.property_id
      WHERE p.landlord_id IN ($1, $2)
        AND u.status IN ('active', 'delinquent')
      ORDER BY p.id, u.unit_number`, [landlord1.id, landlord2.id])

    // Match each active/delinquent unit to a tenant. The order
    // matches the seed-time assignment: prop1 units 101..105 →
    // tenants 0..3; prop2 units 201, 203 → tenants 4, 5.
    const unitTenantPairs: {
      unitId: string; tenantId: string; rent: number;
      landlordId: string; unitNumber: string;
    }[] = []
    const tenantOrder = [0, 1, 2, 3, 4, 5]
    for (let i = 0; i < allUnits.rows.length && i < tenantOrder.length; i++) {
      const u = allUnits.rows[i]
      const ten = tenants[tenantOrder[i]]
      unitTenantPairs.push({
        unitId:     u.id,
        tenantId:   ten.id,
        rent:       Number(u.rent_amount),
        landlordId: u.landlord_id,
        unitNumber: u.unit_number,
      })
    }

    const leaseByUnit: Record<string, string> = {}
    for (const p of unitTenantPairs) {
      const { rows: [lease] } = await client.query<{ id: string }>(`
        INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status,
          start_date, end_date, rent_due_day, late_fee_grace_days,
          late_fee_enabled, late_fee_initial_amount, late_fee_initial_type)
        VALUES ($1, $2, $3, 'fixed_term', 'active',
          $4::date, NULL, 1, 5, TRUE, 50, 'flat')
        RETURNING id`,
        [p.unitId, p.landlordId, p.rent, HISTORY_START])
      await client.query(`
        INSERT INTO lease_tenants (lease_id, tenant_id, role, status)
        VALUES ($1, $2, 'primary', 'active')`,
        [lease.id, p.tenantId])
      leaseByUnit[p.unitId] = lease.id
    }
    console.log(`  ✓ Leases: ${unitTenantPairs.length}`)

    // ── 24 MONTHS OF RENT HISTORY (S291) ──────────────────
    // Settled monthly rent payments for each tenant from
    // 2024-04-01 → 2026-04-01 (May 2026 left unpaid — that's
    // "the current cycle" for the walkthrough). The delinquent
    // unit (status='delinquent') gets two 'failed' payments
    // mid-2025 + one 'pending' for the most recent month so
    // the admin Payments page shows realistic state variety.
    let paymentsInserted = 0
    let failedInserted = 0
    for (const p of unitTenantPairs) {
      const isDelinquent = await client.query<{ status: string }>(
        `SELECT status FROM units WHERE id = $1`, [p.unitId]
      )
      const delinquent = isDelinquent.rows[0]?.status === 'delinquent'

      for (let m = 0; m < HISTORY_MONTHS; m++) {
        // Realistic settle delay: 1-3 days after due.
        const settleDelay = 1 + (m % 3)
        // Inject 2 'failed' months for the delinquent tenant
        // (months 18 + 20 of the history — late 2025).
        const isFailedMonth = delinquent && (m === 18 || m === 20)
        const status = isFailedMonth ? 'failed' : 'settled'

        // All date math runs server-side in SQL to avoid timezone-
        // string round-tripping (JS Date.toString() emits GMT-named
        // offsets that pg can't parse as date literals).
        await client.query(`
          INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type,
            amount, status, entry_description, due_date, settled_at)
          VALUES (
            $1, $2, $3, $4, 'rent', $5, $6, 'RENT',
            (DATE '${HISTORY_START}' + ($7 || ' months')::interval)::date,
            CASE WHEN $6 = 'failed'
              THEN NULL
              ELSE (DATE '${HISTORY_START}' + ($7 || ' months')::interval
                    + ($8 || ' days')::interval)
            END
          )`,
          [p.unitId, p.tenantId, p.landlordId, leaseByUnit[p.unitId],
           p.rent, status, m, settleDelay])
        if (status === 'failed') failedInserted++; else paymentsInserted++
      }
    }
    console.log(`  ✓ Rent history: ${paymentsInserted} settled + ${failedInserted} failed across 24 months`)

    // ── DEMO DISBURSEMENTS — 24 monthly auto-Friday payouts ───
    // Settled monthly disbursement to each landlord matching the
    // sum of their tenants' settled rent. Same window as the
    // rent history: 2024-04 → 2026-04 (25 cycles).
    const monthlyTotals: Record<string, number> = {}
    for (const p of unitTenantPairs) {
      monthlyTotals[p.landlordId] = (monthlyTotals[p.landlordId] || 0) + p.rent
    }
    for (const [landlordId, total] of Object.entries(monthlyTotals)) {
      for (let m = 0; m < HISTORY_MONTHS; m++) {
        await client.query(`
          INSERT INTO disbursements (landlord_id, amount, unit_count, status,
            from_reserve, reserve_amount, target_date, initiated_at, settled_at)
          VALUES ($1, $2,
            (SELECT COUNT(*)::int FROM units
              WHERE landlord_id = $1 AND status IN ('active', 'delinquent')),
            'settled', FALSE, 0,
            (DATE '${HISTORY_START}' + ($3 || ' months')::interval + INTERVAL '5 days')::date,
            (DATE '${HISTORY_START}' + ($3 || ' months')::interval + INTERVAL '3 days')::timestamptz,
            (DATE '${HISTORY_START}' + ($3 || ' months')::interval + INTERVAL '5 days')::timestamptz)`,
          [landlordId, total, m])
      }
    }
    console.log(`  ✓ Disbursements: ${HISTORY_MONTHS * Object.keys(monthlyTotals).length} settled across 24 months`)

    // Re-query unit rows for the maintenance block below — the
    // legacy v_unit_occupancy join now actually returns rows
    // because we just created the leases above.
    const unitRows = await client.query(`
      SELECT u.id, vuo.primary_tenant_id AS tenant_id, u.landlord_id, u.rent_amount
      FROM units u
      JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE vuo.is_occupied = true LIMIT 5`)

    // ── DEMO MAINTENANCE ──────────────────────────────────
    const firstUnit = unitRows.rows[0]
    if (firstUnit) {
      await client.query(`
        INSERT INTO maintenance_requests (unit_id, tenant_id, landlord_id, title, description,
          priority, status, actual_cost, platform_fee, completed_at)
        VALUES
          ($1,$2,$3,'HVAC not cooling properly','Unit temperature stays above 85°F','high','completed',320,25.60,NOW()-INTERVAL '5 days'),
          ($1,$2,$3,'Bathroom faucet dripping','Cold water tap drips constantly','normal','open',NULL,NULL,NULL)
        ON CONFLICT DO NOTHING`,
        [firstUnit.id, firstUnit.tenant_id, firstUnit.landlord_id])
    }

    // ── RESERVE FUND STATE ────────────────────────────────
    await client.query(`
      UPDATE reserve_fund_state
      SET balance = 4200, target_balance = 12600, phase = 1, reserve_rate = 1.00, monthly_contribution = 796`)
    await client.query(`
      INSERT INTO reserve_fund_ledger (type, amount, balance_after, notes)
      VALUES
        ('contribution', 398, 398,   'Month 1 reserve contribution'),
        ('contribution', 796, 1194,  'Month 2 reserve contribution'),
        ('contribution', 796, 1990,  'Month 3 reserve contribution'),
        ('disbursement_cover', -875, 1115, 'On-Time Pay SLA — Jan 2026 shortfall'),
        ('contribution', 1990, 3105, 'Month 4 reserve contribution'),
        ('contribution', 1095, 4200, 'Month 5 reserve contribution')
      ON CONFLICT DO NOTHING`)

    // ── FLOAT ACCOUNT ─────────────────────────────────────
    await client.query(`
      UPDATE float_account_state
      SET balance = 26750, monthly_interest = 100`)

    await client.query('COMMIT')
    console.log('\n✅  Seed complete!')
    console.log('\n📋  Demo credentials:')
    console.log('   Admin:    admin@gam.dev                / admin1234')
    console.log('   Landlord: james@demo.dev                / landlord1234')
    console.log('   Landlord: maria@demo.dev                / landlord1234')
    console.log('   Landlord: realestaterhoades@gmail.com   / landlord1234  (Nic, no portfolio)')
    console.log('   Tenant:   alice@tenant.dev              / tenant1234')
    console.log('   Tenant:   bob@tenant.dev                / tenant1234  (SSI, On-Time Pay enrolled)')
    console.log('   Tenant:   eva@tenant.dev                / tenant1234  (SSI, delinquent history)\n')

  } catch (err: any) {
    await client.query('ROLLBACK')
    console.error('❌  Seed failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await db.end()
  }
}

seed()
