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
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
      VALUES ('admin@gam.dev', $1, 'admin', 'Platform', 'Admin', '602-555-0001')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id`, [adminHash])
    console.log('  ✓ Admin:', admin.id)

    // ── LANDLORD 1 (demo — large portfolio) ───────────────
    const lHash = await bcrypt.hash('landlord1234', 12)
    const { rows: [lUser1] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
      VALUES ('james@demo.dev', $1, 'landlord', 'James', 'Thornton', '602-555-1001')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id`, [lHash])
    const { rows: [landlord1] } = await client.query(`
      INSERT INTO landlords (user_id, business_name, stripe_bank_verified, onboarding_complete, volume_tier)
      VALUES ($1, 'Thornton Properties LLC', TRUE, TRUE, 'standard')
      ON CONFLICT (user_id) DO UPDATE SET onboarding_complete = TRUE
      RETURNING id`, [lUser1.id])
    console.log('  ✓ Landlord 1:', landlord1.id)

    // ── LANDLORD 2 (demo — small portfolio) ───────────────
    const { rows: [lUser2] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
      VALUES ('maria@demo.dev', $1, 'landlord', 'Maria', 'Reyes', '520-555-2001')
      ON CONFLICT (email) DO UPDATE SET password_hash = $1
      RETURNING id`, [lHash])
    const { rows: [landlord2] } = await client.query(`
      INSERT INTO landlords (user_id, business_name, stripe_bank_verified, onboarding_complete, volume_tier)
      VALUES ($1, 'Reyes Rentals', TRUE, TRUE, 'standard')
      ON CONFLICT (user_id) DO UPDATE SET onboarding_complete = TRUE
      RETURNING id`, [lUser2.id])
    console.log('  ✓ Landlord 2:', landlord2.id)

    // ── PROPERTY 1 ────────────────────────────────────────
    const { rows: [prop1] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type)
      VALUES ($1, 'Oak Street Apartments', '4821 W Oak St', 'Phoenix', 'AZ', '85031', 'residential')
      ON CONFLICT DO NOTHING
      RETURNING id`, [landlord1.id])

    const { rows: [prop2] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type)
      VALUES ($1, 'Mesa View Complex', '1140 S Dobson Rd', 'Mesa', 'AZ', '85202', 'residential')
      ON CONFLICT DO NOTHING
      RETURNING id`, [landlord1.id])

    const { rows: [prop3] } = await client.query(`
      INSERT INTO properties (landlord_id, name, street1, city, state, zip, type)
      VALUES ($1, 'Tucson Budget Rentals', '2200 E Speedway Blvd', 'Tucson', 'AZ', '85719', 'residential')
      ON CONFLICT DO NOTHING
      RETURNING id`, [landlord2.id])

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
        INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
        VALUES ($1,$2,'tenant',$3,$4,$5)
        ON CONFLICT (email) DO UPDATE SET password_hash = $2
        RETURNING id`, [t.email, tHash, t.first, t.last, t.phone])
      const { rows: [ten] } = await client.query(`
        INSERT INTO tenants (user_id, ach_verified, ssi_ssdi, on_time_pay_enrolled,
          float_fee_active, income_arrival_day, credit_reporting_enrolled, late_payment_count)
        VALUES ($1, TRUE, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id) DO UPDATE SET ach_verified = TRUE
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
          INSERT INTO units (property_id, landlord_id, tenant_id, unit_number, bedrooms, bathrooms,
            rent_amount, security_deposit, status, on_time_pay_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (property_id, unit_number) DO NOTHING`,
          [prop1.id, landlord1.id, u.tenant?.id ?? null, u.num,
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
          INSERT INTO units (property_id, landlord_id, tenant_id, unit_number, bedrooms, bathrooms,
            rent_amount, security_deposit, status, on_time_pay_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (property_id, unit_number) DO NOTHING`,
          [prop2.id, landlord1.id, u.tenant?.id ?? null, u.num,
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

    // ── DEMO DISBURSEMENTS ────────────────────────────────
    await client.query(`
      INSERT INTO disbursements (landlord_id, amount, unit_count, status, from_reserve,
        reserve_amount, target_date, initiated_at, settled_at)
      VALUES
        ($1, 4075.00, 5, 'settled', FALSE, 0, '2026-03-01', '2026-02-28', '2026-03-01'),
        ($1, 4075.00, 5, 'settled', FALSE, 0, '2026-02-01', '2026-01-31', '2026-02-01'),
        ($1, 4075.00, 5, 'settled', TRUE,  875, '2026-01-01', '2025-12-31', '2026-01-01'),
        ($2, 1400.00, 2, 'settled', FALSE, 0, '2026-03-01', '2026-02-28', '2026-03-01')
      ON CONFLICT DO NOTHING`, [landlord1.id, landlord2.id])

    // ── DEMO PAYMENTS ─────────────────────────────────────
    const unitRows = await client.query(`
      SELECT u.id, u.tenant_id, u.landlord_id, u.rent_amount FROM units u
      WHERE u.tenant_id IS NOT NULL LIMIT 5`)
    for (const u of unitRows.rows) {
      await client.query(`
        INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, settled_at)
        VALUES ($1,$2,$3,'rent',$4,'settled','RENT','2026-03-01','2026-03-03'),
               ($1,$2,$3,'rent',$4,'settled','RENT','2026-02-01','2026-02-03'),
               ($1,$2,$3,'rent',$4,'settled','RENT','2026-01-01','2026-01-03')
        ON CONFLICT DO NOTHING`,
        [u.id, u.tenant_id, u.landlord_id, u.rent_amount])
    }

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
    console.log('   Admin:    admin@gam.dev        / admin1234')
    console.log('   Landlord: james@demo.dev        / landlord1234')
    console.log('   Landlord: maria@demo.dev        / landlord1234')
    console.log('   Tenant:   alice@tenant.dev      / tenant1234')
    console.log('   Tenant:   bob@tenant.dev        / tenant1234  (SSI, On-Time Pay enrolled)')
    console.log('   Tenant:   eva@tenant.dev        / tenant1234  (SSI, delinquent history)\n')

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
