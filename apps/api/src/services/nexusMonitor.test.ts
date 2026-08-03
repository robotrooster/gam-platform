/**
 * S565: nexus monitor + screening-tax gate.
 *
 * Covers the load-bearing money/compliance logic:
 *   - screeningIntakeFee(state): tax collected ONLY when a state is both
 *     taxable AND registered (the two-layer gate). $0 otherwise.
 *   - getNexusDashboard: crossed / approaching / under / registered / no_threshold
 *     status logic, honoring count_rule (or / and / revenue_only).
 *   - recomputeNexusTally: aggregates GAM own-revenue by customer state.
 *   - setStateRegistration: flips the collection gate.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  recomputeNexusTally,
  getNexusDashboard,
  setStateRegistration,
} from './nexusMonitor'
import { screeningIntakeFee } from '../routes/background'

const YEAR = 2026

async function clearCatalog() {
  await db.query('DELETE FROM nexus_revenue_tally')
  await db.query('DELETE FROM state_tax_registrations')
  await db.query('DELETE FROM state_screening_tax_rates')
  await db.query('DELETE FROM state_nexus_thresholds')
  await db.query('DELETE FROM platform_fee_accruals')
}

async function seedTaxRow(state: string, taxable: boolean, rate: number, basis = 'screening') {
  await db.query(
    `INSERT INTO state_screening_tax_rates (state_code, effective_year, taxable, rate_pct, basis, status)
     VALUES ($1,$2,$3,$4,$5,'research')`,
    [state, YEAR, taxable, rate, basis]
  )
}

async function seedThreshold(state: string, revenue: number | null, txn: number | null, rule: string) {
  await db.query(
    `INSERT INTO state_nexus_thresholds (state_code, effective_year, revenue_threshold_usd, txn_threshold, count_rule, status)
     VALUES ($1,$2,$3,$4,$5,'research')`,
    [state, YEAR, revenue, txn, rule]
  )
}

async function seedTally(state: string, year: number, revenue: number, txn = 1) {
  await db.query(
    `INSERT INTO nexus_revenue_tally (state_code, period_year, revenue_usd, txn_count)
     VALUES ($1,$2,$3,$4)`,
    [state, year, revenue, txn]
  )
}

beforeEach(async () => {
  await cleanupAllSchema()
  await clearCatalog()
})

describe('screening tax gate (screeningIntakeFee)', () => {
  it('collects $0 in a taxable state that is NOT registered', async () => {
    await seedTaxRow('TX', true, 6.25)
    const fee = await screeningIntakeFee('TX')
    expect(fee.tax).toBe(0)
  })

  it('collects tax in a taxable state once registered — base is the screening line only', async () => {
    await seedTaxRow('TX', true, 6.25)
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee('TX')
    // screening $37.94 × 6.25% = 2.37125 → 2.37 (gamFee margin NOT in base)
    expect(fee.tax).toBe(2.37)
    expect(fee.total).toBeGreaterThan(fee.screening + fee.gamFee + fee.processing)
  })

  it('collects $0 in a registered but NON-taxable state', async () => {
    await seedTaxRow('UT', false, 0)
    await setStateRegistration('UT', true)
    const fee = await screeningIntakeFee('UT')
    expect(fee.tax).toBe(0)
  })

  it('collects $0 when no applicant state is given', async () => {
    await seedTaxRow('TX', true, 6.25)
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee(null)
    expect(fee.tax).toBe(0)
  })

  it('honors basis=screening_plus_gamfee (taxes screening + margin)', async () => {
    await seedTaxRow('TX', true, 10, 'screening_plus_gamfee')
    await setStateRegistration('TX', true)
    const fee = await screeningIntakeFee('TX')
    // (37.94 + 5) × 10% = 4.294 → 4.29
    expect(fee.tax).toBe(4.29)
  })
})

describe('nexus dashboard status logic', () => {
  it('flags crossed / approaching / under and computes summary', async () => {
    await seedThreshold('TX', 500000, null, 'revenue_only')
    await seedThreshold('CA', 500000, null, 'revenue_only')
    await seedThreshold('AZ', 100000, null, 'revenue_only')
    await seedThreshold('NM', 100000, null, 'revenue_only')
    await seedTally('TX', YEAR, 600000)   // ≥ 500k → crossed
    await seedTally('CA', YEAR, 450000)   // 90% of 500k → approaching
    await seedTally('AZ', YEAR, 85000)    // 85% of 100k → approaching
    await seedTally('NM', YEAR, 40000)    // 40% → under

    const d = await getNexusDashboard(YEAR)
    const by = (s: string) => d.states.find((x) => x.stateCode === s)!
    expect(by('TX').status).toBe('crossed')
    expect(by('CA').status).toBe('approaching')
    expect(by('AZ').status).toBe('approaching')
    expect(by('NM').status).toBe('under')
    expect(d.summary.crossed).toBe(1)
    expect(d.summary.approaching).toBe(2)
  })

  it('registered wins over crossed (collection already live)', async () => {
    await seedThreshold('TX', 500000, null, 'revenue_only')
    await seedTally('TX', YEAR, 600000)
    await setStateRegistration('TX', true)
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'TX')!.status).toBe('registered')
    expect(d.summary.registered).toBe(1)
    expect(d.summary.crossed).toBe(0)
  })

  it('count_rule=and requires BOTH revenue and txn over threshold', async () => {
    await seedThreshold('NY', 500000, 100, 'and')
    await seedTally('NY', YEAR, 600000, 50)  // revenue over, txn under → NOT crossed
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'NY')!.status).not.toBe('crossed')
  })

  it('no_threshold for no-sales-tax states', async () => {
    await seedThreshold('OR', null, null, 'revenue_only')
    const d = await getNexusDashboard(YEAR)
    expect(d.states.find((x) => x.stateCode === 'OR')!.status).toBe('no_threshold')
  })

  it('uses max(current YTD, prior year) as the conservative measure', async () => {
    await seedThreshold('AZ', 100000, null, 'revenue_only')
    await seedTally('AZ', YEAR, 40000)       // current small
    await seedTally('AZ', YEAR - 1, 120000)  // prior year over threshold
    const d = await getNexusDashboard(YEAR)
    const az = d.states.find((x) => x.stateCode === 'AZ')!
    expect(az.measureUsd).toBe(120000)
    expect(az.status).toBe('crossed')
  })
})

describe('recomputeNexusTally aggregation', () => {
  it('sums platform-fee revenue by property state', async () => {
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','T','L',TRUE) RETURNING id`,
      [`ll-${randomUUID()}@test.dev`]
    )).rows[0].id
    const landlordId = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`, [userId]
    )).rows[0].id
    const propId = (await db.query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
       VALUES ($1,'P','1 St','Dallas','TX','75001',$2,$2) RETURNING id`,
      [landlordId, userId]
    )).rows[0].id
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, total_billable, rate_per_unit, min_per_property, total_amount, payer)
       VALUES ($1,$2,'2026-06-01',5,2,10,250.00,'landlord')`,
      [landlordId, propId]
    )

    const res = await recomputeNexusTally(YEAR)
    expect(res.rows).toBeGreaterThanOrEqual(1)
    const row = (await db.query<{ revenue_usd: string }>(
      `SELECT revenue_usd FROM nexus_revenue_tally WHERE state_code='TX' AND period_year=$1`, [YEAR]
    )).rows[0]
    expect(row).toBeTruthy()
    expect(parseFloat(row.revenue_usd)).toBe(250)
  })
})

describe('setStateRegistration', () => {
  it('flips registration on then off', async () => {
    await setStateRegistration('TX', true)
    let r = (await db.query<{ registered: boolean; registered_date: string | null }>(
      `SELECT registered, registered_date FROM state_tax_registrations WHERE state_code='TX'`
    )).rows[0]
    expect(r.registered).toBe(true)
    expect(r.registered_date).toBeTruthy()

    await setStateRegistration('TX', false)
    r = (await db.query<{ registered: boolean; registered_date: string | null }>(
      `SELECT registered, registered_date FROM state_tax_registrations WHERE state_code='TX'`
    )).rows[0]
    expect(r.registered).toBe(false)
    expect(r.registered_date).toBeNull()
  })
})
