/**
 * Property + Unit CSV onboarding endpoints (S29X / Phase A).
 *
 * Covers:
 *   - POST /api/landlords/me/onboard-properties-csv/validate
 *     • happy path (new property + new units)
 *     • find-or-create on (name, street1) match
 *     • duplicate unit-number-within-property blocker
 *     • property collision against existing unit (warn + skip)
 *     • missing-required-field validation
 *   - POST /api/landlords/me/onboard-properties-csv/commit
 *     • atomic property + unit + allocation_rule creation
 *     • default allocation rule values (tenant/tenant/landlord)
 *     • idempotent property creation across batch rows
 *     • skip-existing-unit on commit
 *   - GET /api/landlords/me/onboard-properties-csv/template
 *     • generic + Buildium templates
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

async function seedLandlordWithToken(): Promise<{
  userId: string; landlordId: string; token: string; email: string
}> {
  const email = `ll-${Math.random().toString(36).slice(2)}@test.dev`
  const hash = await bcrypt.hash('pw123456789012', 4)
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'landlord', 'Test', 'Landlord', TRUE) RETURNING id`,
    [email, hash],
  )
  const userId = u.rows[0].id
  const l = await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
    [userId],
  )
  const landlordId = l.rows[0].id
  const token = jwt.sign(
    { userId, role: 'landlord', email, profileId: landlordId, permissions: {} },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  )
  return { userId, landlordId, token, email }
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_csv_property'
})

describe('GET /api/landlords/me/onboard-properties-csv/template', () => {
  it('returns the generic GAM template with canonical headers + example row', async () => {
    const { token } = await seedLandlordWithToken()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-properties-csv/template?source=generic')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const lines = res.text.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('property_name')
    expect(lines[0]).toContain('street1')
    expect(lines[0]).toContain('unit_number')
    expect(lines[0]).toContain('rent_amount')
  })

  it('returns a Buildium template with platform-preferred headers', async () => {
    const { token } = await seedLandlordWithToken()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-properties-csv/template?source=buildium')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Property')   // property_name first alias
    expect(res.text).toContain('Unit')        // unit_number first alias
  })

  it('rejects unknown source', async () => {
    const { token } = await seedLandlordWithToken()
    const res = await request(buildApp())
      .get('/api/landlords/me/onboard-properties-csv/template?source=zillow')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
  })
})

describe('POST /api/landlords/me/onboard-properties-csv/validate', () => {
  it('happy path — single new property with one unit, zero blockers', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,street2,city,state,zip,timezone,property_type,unit_number,bedrooms,bathrooms,sqft,unit_type,rent_amount,security_deposit',
      'Sunset Apartments,100 Main St,,Phoenix,AZ,85001,America/Phoenix,residential,4B,2,1.5,850,apartment,1850,1850',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({
      total: 1, blockers: 0, ready: 1, newProperties: 1, newUnits: 1,
    })
    expect(res.body.data.rows[0].issues).toEqual([])
  })

  it('blocks rows missing required fields (property_name, unit_number, rent_amount)', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      ',100 Main St,Phoenix,AZ,85001,4B,1850',         // missing property_name
      'Sunset,200 Main St,Phoenix,AZ,85001,,1850',     // missing unit_number
      'Sunset,300 Main St,Phoenix,AZ,85001,4C,',       // missing rent_amount
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBeGreaterThanOrEqual(3)
    const fields = res.body.data.rows.flatMap((r: any) =>
      r.issues.filter((i: any) => i.severity === 'block').map((i: any) => i.field)
    )
    expect(fields).toContain('property_name')
    expect(fields).toContain('unit_number')
    expect(fields).toContain('rent_amount')
  })

  it('blocks invalid rent_amount (negative or non-numeric)', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,-100',
      'Sunset,100 Main St,Phoenix,AZ,85001,4C,abc',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const rentIssues = res.body.data.rows
      .flatMap((r: any) => r.issues.filter((i: any) => i.field === 'rent_amount'))
    expect(rentIssues.length).toBe(2)
  })

  it('blocks duplicate unit_number within the same property in the same CSV', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1850',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1850',  // duplicate
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    const dupIssues = res.body.data.rows[1].issues
      .filter((i: any) => i.field === 'unit_number' && i.severity === 'block')
    expect(dupIssues.length).toBeGreaterThan(0)
  })

  it('warns + auto-resolves when unit already exists at an existing property', async () => {
    const { userId, landlordId, token } = await seedLandlordWithToken()
    // Pre-seed an existing property + unit
    const p = await db.query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                               owner_user_id, managed_by_user_id)
       VALUES ($1, 'Sunset Apartments', '100 Main St', 'Phoenix', 'AZ', '85001',
               $2, $2) RETURNING id`,
      [landlordId, userId],
    )
    await db.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1, $2, '4B', 1850)`,
      [p.rows[0].id, landlordId],
    )

    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      'Sunset Apartments,100 Main St,Phoenix,AZ,85001,4B,1850',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].resolvedPropertyId).toBeTruthy()
    expect(res.body.data.rows[0].resolvedUnitId).toBeTruthy()
    const warnings = res.body.data.rows[0].issues
      .filter((i: any) => i.severity === 'warn' && i.field === 'unit_number')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('translates Buildium-shaped columns via applyPropertyMapping before validation', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'Property,Address,City,State,Zip,Unit,Bedrooms,Bathrooms,Market Rent',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,2,1.5,1850',
    ].join('\n')

    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'buildium' })

    expect(res.status).toBe(200)
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.rows[0].propertyName).toBe('Sunset')
    expect(res.body.data.rows[0].rentAmount).toBe('1850')
  })

  it('400 on empty CSV body', async () => {
    const { token } = await seedLandlordWithToken()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv: '', source: 'generic' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/landlords/me/onboard-properties-csv/commit', () => {
  it('atomically creates property + units + default allocation rule', async () => {
    const { landlordId, token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,bedrooms,bathrooms,rent_amount,security_deposit',
      'Sunset Apartments,100 Main St,Phoenix,AZ,85001,4B,2,1.5,1850,1850',
      'Sunset Apartments,100 Main St,Phoenix,AZ,85001,4C,1,1,1500,1500',
      'Mesa Pads,200 Mesa Rd,Mesa,AZ,85201,1A,3,2,2200,2200',
    ].join('\n')

    // First validate to get the resolved-row payload
    const valRes = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(valRes.body.data.summary.blockers).toBe(0)

    const commitRes = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: valRes.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })

    expect(commitRes.status).toBe(200)
    expect(commitRes.body.data.propertiesCreated).toBe(2)  // Sunset + Mesa
    expect(commitRes.body.data.unitsCreated).toBe(3)

    // Confirm DB state
    const props = await db.query<any>(
      `SELECT name, street1 FROM properties WHERE landlord_id = $1 ORDER BY name`,
      [landlordId],
    )
    expect(props.rows).toHaveLength(2)
    expect(props.rows[0].name).toBe('Mesa Pads')
    expect(props.rows[1].name).toBe('Sunset Apartments')

    const units = await db.query<any>(
      `SELECT unit_number FROM units WHERE landlord_id = $1 ORDER BY unit_number`,
      [landlordId],
    )
    expect(units.rows.map(r => r.unit_number)).toEqual(['1A', '4B', '4C'])

    // Default allocation rule landed on every new property
    const rules = await db.query<any>(
      `SELECT ach_fee_payer, card_fee_payer, platform_fee_payer
         FROM property_allocation_rules
        WHERE property_id IN (SELECT id FROM properties WHERE landlord_id = $1)`,
      [landlordId],
    )
    expect(rules.rows).toHaveLength(2)
    for (const r of rules.rows) {
      expect(r.ach_fee_payer).toBe('tenant')
      expect(r.card_fee_payer).toBe('tenant')
      expect(r.platform_fee_payer).toBe('landlord')
    }
  })

  it('shares one property across multiple unit rows (find-or-create within batch)', async () => {
    const { landlordId, token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      'Sunset,100 Main St,Phoenix,AZ,85001,A,1000',
      'Sunset,100 Main St,Phoenix,AZ,85001,B,1000',
      'Sunset,100 Main St,Phoenix,AZ,85001,C,1000',
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })

    expect(commit.body.data.propertiesCreated).toBe(1)
    expect(commit.body.data.unitsCreated).toBe(3)

    const propCount = await db.query<{ c: string }>(
      `SELECT count(*)::text as c FROM properties WHERE landlord_id = $1`,
      [landlordId],
    )
    expect(propCount.rows[0].c).toBe('1')
  })

  it('skips creating units that already exist at the property (matched in validate)', async () => {
    const { userId, landlordId, token } = await seedLandlordWithToken()
    const propRes = await db.query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                               owner_user_id, managed_by_user_id)
       VALUES ($1, 'Sunset', '100 Main St', 'Phoenix', 'AZ', '85001', $2, $2)
       RETURNING id`,
      [landlordId, userId],
    )
    await db.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount)
       VALUES ($1, $2, '4B', 1850)`,
      [propRes.rows[0].id, landlordId],
    )

    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1850',  // exists — skip on commit
      'Sunset,100 Main St,Phoenix,AZ,85001,4C,1500',  // new — create
    ].join('\n')

    const val = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })

    const commit = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: val.body.data.rows, source: 'generic', claimedPlatformName: 'TestPlatform' })

    expect(commit.body.data.propertiesCreated).toBe(0)
    expect(commit.body.data.unitsCreated).toBe(1)
    expect(commit.body.data.unitsSkipped).toBe(1)
  })

  it('rejects commit when any row carries a blocker', async () => {
    const { token } = await seedLandlordWithToken()
    const fakeRow = {
      rowIndex: 0,
      propertyName: '', street1: '', city: '', state: '', zip: '',
      unitNumber: '4B', rentAmount: '1850',
      bedrooms: '', bathrooms: '', sqft: '', unitType: '',
      securityDeposit: '', timezone: '', street2: '', propertyType: '',
      issues: [
        { severity: 'block', field: 'property_name', message: 'Required' },
      ],
    }
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [fakeRow] })
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────
//  S491: state-law warnings on CSV property validate
//  Recompute-on-validate posture mirrors S483 (tenant GET /lease) and
//  S486 (property GET /:id) — landlord sees a hedged factual notice
//  during the import preview, before commit, so they can correct or
//  acknowledge before shipping the data.
// ─────────────────────────────────────────────────────────────────────

async function seedAzDepositCap(): Promise<void> {
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO state_landlord_tenant_acts
       (state_code, act_key, act_name, unit_types, source_date, effective_year)
     VALUES ('AZ', 'residential', 'AZ Residential Landlord-Tenant Act',
             ARRAY['apartment','single_family']::text[], '2026-06-09', 2026)
     ON CONFLICT DO NOTHING
     RETURNING id`)
  const actId = a?.id ?? (await db.query<{ id: string }>(
    `SELECT id FROM state_landlord_tenant_acts WHERE state_code='AZ' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
  await db.query(
    `INSERT INTO state_law_provisions
       (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
        summary, statute_citation, source_url, source_date, effective_year)
     VALUES ($1, 'AZ', 'deposit_max_months', 'max', 1.5, 'months of rent',
             'Security deposit may not exceed 1.5 months of rent',
             'A.R.S. § 33-1321', 'https://www.azleg.gov/ars/33/01321.htm',
             '2026-06-09', 2026)
     ON CONFLICT DO NOTHING`, [actId])
}

describe('S491: state-law warnings on CSV property validate', () => {
  it('AZ row with deposit 2.0× rent → warn issue surfaced', async () => {
    const { token } = await seedLandlordWithToken()
    await seedAzDepositCap()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount,security_deposit',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1500,3000',
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const warns = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'warn' && i.field === 'security_deposit')
    expect(warns.length).toBe(1)
    expect(warns[0].message).toMatch(/above the 1\.5/)
    expect(warns[0].message).toMatch(/AZ/)
    expect(res.body.data.summary.warnings).toBeGreaterThanOrEqual(1)
    // Row still ships as ready — warnings don't block commit.
    expect(res.body.data.summary.blockers).toBe(0)
    expect(res.body.data.summary.ready).toBe(1)
  })

  it('AZ row with deposit 1.0× rent → no state-law warn', async () => {
    const { token } = await seedLandlordWithToken()
    await seedAzDepositCap()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount,security_deposit',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1500,1500',
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const warns = res.body.data.rows[0].issues.filter((i: any) => i.field === 'security_deposit')
    expect(warns.length).toBe(0)
  })

  it('Uncatalogued state ("XX") → no state-law warn even if deposit is huge', async () => {
    const { token } = await seedLandlordWithToken()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount,security_deposit',
      'Sunset,100 Main St,Anywhere,XX,12345,4B,1500,5000',
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const warns = res.body.data.rows[0].issues.filter((i: any) => i.field === 'security_deposit')
    expect(warns.length).toBe(0)
  })

  it('Missing deposit → no state-law check fires', async () => {
    const { token } = await seedLandlordWithToken()
    await seedAzDepositCap()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount,security_deposit',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1500,',  // empty deposit
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const warns = res.body.data.rows[0].issues.filter((i: any) => i.field === 'security_deposit')
    expect(warns.length).toBe(0)
  })

  it('Mixed batch: 1 AZ above-cap row + 1 AZ within-range row → only one warn', async () => {
    const { token } = await seedLandlordWithToken()
    await seedAzDepositCap()
    const csv = [
      'property_name,street1,city,state,zip,unit_number,rent_amount,security_deposit',
      'Sunset,100 Main St,Phoenix,AZ,85001,4B,1500,3000',  // above
      'Sunset,100 Main St,Phoenix,AZ,85001,4C,1500,1500',  // within
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ csv, source: 'generic' })
    expect(res.status).toBe(200)
    const totalWarns = res.body.data.rows.flatMap((r: any) =>
      r.issues.filter((i: any) => i.severity === 'warn' && i.field === 'security_deposit'),
    )
    expect(totalWarns.length).toBe(1)
  })
})
