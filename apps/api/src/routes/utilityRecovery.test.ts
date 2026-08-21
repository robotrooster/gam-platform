/**
 * S613 — "how much utility did we not get back?"
 *
 * Nic: "Unbilled utility tracking would just be the difference between an owner
 * importing their total charges coming into the property and subtracting the
 * outgoing charges... over a whole year when there's fifty thousand dollars in
 * utilities and there's twelve thousand maybe not billed back to people, we
 * wanna see that."
 *
 * No new ledger: spent = the property's utility expenses, recovered = the bills
 * it sent, gap = the answer. The owner-occupied slice is named because it is
 * recorded as it happens; the rest of the gap stays unattributed rather than
 * being guessed at.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_recovery'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId, tenantId, leaseId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('GET /api/utility/recovery (S613)', () => {
  it('spent minus billed back is the gap, per utility and in total', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','water',1000,'2026-03-10'),
              ($1,$2,'utilities','electric',500,'2026-03-11')`,
      [f.landlordId, f.propertyId])
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'water','W','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','equal',0,0,700,0,0,'water')`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const water = res.body.data.lines.find((l: any) => l.utilityType === 'water')
    expect(water.spent).toBe(1000)
    expect(water.recovered).toBe(700)
    expect(water.notRecovered).toBe(300)

    // Electric was paid for and never billed back to anyone — the whole $500.
    const elec = res.body.data.lines.find((l: any) => l.utilityType === 'electric')
    expect(elec.spent).toBe(500)
    expect(elec.recovered).toBe(0)
    expect(elec.notRecovered).toBe(500)

    expect(res.body.data.totals.spent).toBe(1500)
    expect(res.body.data.totals.recovered).toBe(700)
    expect(res.body.data.totals.notRecovered).toBe(800)
  })

  it('names the owner-occupied slice of the gap', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, utility_type, amount, expense_date)
       VALUES ($1,$2,'utilities','trash',300,'2026-03-10')`, [f.landlordId, f.propertyId])
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
       VALUES ($1,'trash','T','flat_rate',0) RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_owner_use_absorptions (meter_id, unit_id, landlord_id, utility_type,
              billing_cycle_month, allocation_method, charge_amount, base_fee_share)
       VALUES ($1,$2,$3,'trash','2026-03-01','flat_rate',25,25)`,
      [meter.id, f.unitId, f.landlordId])

    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    const trash = res.body.data.lines.find((l: any) => l.utilityType === 'trash')
    expect(trash.spent).toBe(300)
    expect(trash.ownerOccupied).toBe(25)
    expect(trash.notRecovered).toBe(300)
  })

  // A landlord who never records the provider's bill has nothing to subtract
  // from. Reporting the whole recovery as a shortfall would be a lie.
  it('no expense recorded → the gap is null, not the whole amount', async () => {
    const f = await seed()
    const { rows: [meter] } = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rubs_allocation_method)
       VALUES ($1,'water','W','rubs',0,'occupant_count') RETURNING id`, [f.propertyId])
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id,
                                  billing_cycle_month, allocation_method, rate_per_unit,
                                  base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-03-01','equal',0,0,700,0,0,'water')`,
      [meter.id, f.unitId, f.tenantId, f.leaseId, f.landlordId])
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${f.token}`)
    const water = res.body.data.lines.find((l: any) => l.utilityType === 'water')
    expect(water.recovered).toBe(700)
    expect(water.notRecovered).toBeNull()
  })

  it('cross-landlord property → 403', async () => {
    const a = await seed()
    const b = await seed()
    const res = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${b.propertyId}&from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(403)
  })
})
