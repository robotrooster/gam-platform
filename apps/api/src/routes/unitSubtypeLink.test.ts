/**
 * S613 — linking existing units to a property's unit subtypes.
 *
 * Nic (Oak Park): "I also wanna figure out how to link subtypes to different
 * units because there's nowhere that I can see that links those."
 *
 * `units.subtype_id` existed since S527 but was written only at unit creation.
 * These cover the two ways it can now be set — one unit from the unit page,
 * many units from the subtype — and the rule that makes it safe to do on an
 * occupied park: the subtype OWNS the price, so a unit takes its class's
 * numbers, and that is harmless mid-tenancy because a tenant is billed from
 * leases.rent_amount (the lease is law).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { unitsRouter } from './units'
import { utilityRouter } from './utility'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_subtype_link'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const rvA = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const rvB = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const apt = await seedUnit(c, { propertyId, landlordId, unitType: 'apartment' })
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', profileId: landlordId, landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, rvA, rvB, apt, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function makeSubtype(app: any, f: any, body: any) {
  const res = await request(app).post(`/api/properties/${f.propertyId}/unit-subtypes`)
    .set('Authorization', `Bearer ${f.token}`).send(body)
  expect(res.status).toBe(200)
  return res.body.data
}

describe('unit ↔ subtype linking (S613)', () => {
  it('links one unit and shows the subtype name back on the unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 50 amp', rvSiteLayout: 'back_in', rvAmpService: '50',
    })
    const res = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })
    expect(res.status).toBe(200)
    const unit = await request(app).get(`/api/units/${f.rvA}`).set('Authorization', `Bearer ${f.token}`)
    expect(unit.body.data.subtype_id ?? unit.body.data.subtypeId).toBe(s.id)
    expect(unit.body.data.subtype_name ?? unit.body.data.subtypeName).toBe('Back-in 50 amp')
  })

  it('applying pushes the physical facts onto the unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 30 amp', rvSiteLayout: 'back_in', rvAmpService: '30',
      rentAmount: 440,
    })
    await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id, applyDetails: true })
    const row = (await db.query(`SELECT rv_site_layout, rv_amp_service, rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.rv_site_layout).toBe('back_in')
    expect(row.rv_amp_service).toBe('30')
    expect(Number(row.rent_amount)).toBe(440)
  })

  // S613: an occupied park has to be classifiable, and moving a space into a
  // class takes that class's asking price. The TENANT is unaffected — the lease
  // carries its own rent and that is what bills.
  it('an occupied unit takes its class price; the lease keeps its own rent', async () => {
    const app = buildApp(); const f = await seed()
    const c = await db.connect()
    let leaseId = ''
    try { leaseId = await seedLease(c, { unitId: f.rvA, landlordId: f.landlordId, status: 'active', rentAmount: 380 }) }
    finally { c.release() }
    const s = await makeSubtype(app, f, {
      unitType: 'rv_spot', name: 'Back-in 50 amp', rvSiteLayout: 'back_in', rvAmpService: '50', rentAmount: 999,
    })
    const res = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id, applyDetails: true })
    expect(res.status).toBe(200)
    const row = (await db.query(`SELECT subtype_id, rv_amp_service, rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.subtype_id).toBe(s.id)
    expect(row.rv_amp_service).toBe('50')
    expect(Number(row.rent_amount)).toBe(999)   // the asking price is the class's
    const lease = (await db.query(`SELECT rent_amount FROM leases WHERE id=$1`, [leaseId])).rows[0]
    expect(Number(lease.rent_amount)).toBe(380) // what the tenant actually pays
  })

  // The behaviour Nic expected and did not have: raise the class, every unit
  // in it follows. Enforced by DB trigger, so it holds whichever door edits it.
  it('editing a class price moves every unit in it, and nothing else', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rentAmount: 440 })
    const other = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 30 amp', rentAmount: 400 })
    await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA] })
    await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${other.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvB] })

    await request(app).post(`/api/properties/${f.propertyId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ id: s.id, unitType: 'rv_spot', name: 'Back-in 50 amp', rentAmount: 480 })

    const rows = (await db.query(`SELECT id, rent_amount FROM units WHERE id = ANY($1::uuid[])`, [[f.rvA, f.rvB]])).rows
    expect(Number(rows.find((r: any) => r.id === f.rvA).rent_amount)).toBe(480)
    expect(Number(rows.find((r: any) => r.id === f.rvB).rent_amount)).toBe(400)
  })

  it('a unit IN a subtype cannot be priced on its own', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rentAmount: 440 })
    await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })
    const res = await request(app).patch(`/api/units/${f.rvA}/details`)
      .set('Authorization', `Bearer ${f.token}`).send({ rentAmount: 700 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Back-in 50 amp/)
    const row = (await db.query(`SELECT rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(Number(row.rent_amount)).toBe(440)
  })

  // Subtypes are OPTIONAL (Nic). A landlord adding one unit types a rent and
  // never hears the word — the unit stands alone and owns its price.
  it('a unit created with a bare rent has no subtype and keeps its own price', async () => {
    const app = buildApp(); const f = await seed()
    const res = await request(app).post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, unitNumber: '301', unitType: 'apartment',
              bedrooms: 2, bathrooms: 1, rentAmount: 1200, securityDeposit: 1200 })
    expect(res.status).toBe(201)
    const row = (await db.query(`SELECT subtype_id, rent_amount FROM units WHERE id=$1`, [res.body.data.id])).rows[0]
    expect(row.subtype_id).toBeNull()
    expect(Number(row.rent_amount)).toBe(1200)

    const edit = await request(app).patch(`/api/units/${res.body.data.id}/details`)
      .set('Authorization', `Bearer ${f.token}`).send({ rentAmount: 1250 })
    expect(edit.status).toBe(200)
    expect(Number(edit.body.data.rent_amount)).toBe(1250)
  })

  it('refuses a subtype for a different kind of unit', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    const res = await request(app).patch(`/api/units/${f.apt}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/different kind of unit/i)
  })

  it('bulk assign sets membership — unchecked units are unlinked', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rvAmpService: '50' })

    const both = await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA, f.rvB] })
    expect(both.status).toBe(200)
    expect(both.body.data.linked).toBe(2)

    const one = await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA] })
    expect(one.status).toBe(200)
    const rows = (await db.query(`SELECT id, subtype_id FROM units WHERE id = ANY($1::uuid[])`, [[f.rvA, f.rvB]])).rows
    expect(rows.find((r: any) => r.id === f.rvA).subtype_id).toBe(s.id)
    expect(rows.find((r: any) => r.id === f.rvB).subtype_id).toBeNull()
  })

  it('bulk assign offers only units of the subtype\'s own type', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    const list = await request(app).get(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.status).toBe(200)
    const ids = list.body.data.map((r: any) => r.id).sort()
    expect(ids).toEqual([f.rvA, f.rvB].sort())
  })

  it('the subtype list reports how many units carry it', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp' })
    await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA, f.rvB] })
    const list = await request(app).get(`/api/properties/${f.propertyId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data[0].unit_count).toBe(2)
  })

  // Leaving a subtype hands the price back to the unit — it must NOT reprice.
  it('leaving a subtype keeps the price the unit has, and frees it to change', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rentAmount: 520 })
    await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: s.id })

    const out = await request(app).patch(`/api/units/${f.rvA}/subtype`)
      .set('Authorization', `Bearer ${f.token}`).send({ subtypeId: null })
    expect(out.status).toBe(200)
    const row = (await db.query(`SELECT subtype_id, rent_amount FROM units WHERE id=$1`, [f.rvA])).rows[0]
    expect(row.subtype_id).toBeNull()
    expect(Number(row.rent_amount)).toBe(520)   // kept, not reset

    const edit = await request(app).patch(`/api/units/${f.rvA}/details`)
      .set('Authorization', `Bearer ${f.token}`).send({ rentAmount: 600 })
    expect(edit.status).toBe(200)
    expect(Number(edit.body.data.rent_amount)).toBe(600)
  })

  // And a unit still inside a class must never drift from its neighbours.
  it('two units in one class cannot be priced apart', async () => {
    const app = buildApp(); const f = await seed()
    const s = await makeSubtype(app, f, { unitType: 'rv_spot', name: 'Back-in 50 amp', rentAmount: 440 })
    await request(app).put(`/api/properties/${f.propertyId}/unit-subtypes/${s.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitIds: [f.rvA, f.rvB] })
    const res = await request(app).patch(`/api/units/${f.rvA}/details`)
      .set('Authorization', `Bearer ${f.token}`).send({ rentAmount: 700 })
    expect(res.status).toBe(400)
    const rows = (await db.query(`SELECT rent_amount FROM units WHERE id = ANY($1::uuid[])`, [[f.rvA, f.rvB]])).rows
    expect(rows.every((r: any) => Number(r.rent_amount) === 440)).toBe(true)
  })
})

// S613 (Nic, DIRECTIVE): "All those things should be selectable in the same
// spot even though it's not always a meter... Propane could be RUBS, trash
// could be RUBS. So all of those things need to all be in the utilities
// workflow." These cover the arrangements the unit page can now create, since
// the picker offered electric and water submeters and nothing else.
describe('every utility arrangement can be made from the unit (S613)', () => {
  it('a flat trash charge: sets the property price once, then joins units to it', async () => {
    const app = buildApp(); const f = await seed()
    const rate = await request(app).post('/api/utility/property-rates')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, utilityType: 'trash', ratePerUnit: 25, baseFee: 0 })
    expect([200, 201]).toContain(rate.status)
    const meter = await request(app).post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, utilityType: 'trash', label: 'Trash',
              billingMethod: 'flat_rate', baseFee: 0, assignUnitId: f.rvA })
    expect(meter.status).toBe(201)
    const join = await request(app).post(`/api/utility/meters/${meter.body.data.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitId: f.rvB })
    expect(join.status).toBe(201)
  })

  // Propane could not be a meter at all — the CHECK constraint listed
  // water/gas/electric/sewer/trash — so a central tank split across spaces was
  // impossible to configure.
  it('propane can be a shared master, a flat charge, or a per-space tank', async () => {
    const app = buildApp(); const f = await seed()
    const master = await request(app).post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, utilityType: 'propane', label: 'Park tank',
              billingMethod: 'rubs', rubsAllocationMethod: 'occupant_count', baseFee: 0,
              assignUnitId: f.rvA })
    expect(master.status).toBe(201)

    const flat = await request(app).post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, utilityType: 'propane', label: 'Propane flat',
              billingMethod: 'flat_rate', baseFee: 0, assignUnitId: f.rvB })
    expect(flat.status).toBe(201)

    const tank = await request(app).patch(`/api/units/${f.apt}/details`)
      .set('Authorization', `Bearer ${f.token}`).send({ hasPropaneTank: true })
    expect(tank.status).toBe(200)
    expect(tank.body.data.has_propane_tank).toBe(true)
  })

  // The gate that silently stops any utility billing (handoff §1a) is now
  // visible on the unit rather than only discoverable by nothing happening.
  it('the unit reports which utilities its lease actually bills', async () => {
    const app = buildApp(); const f = await seed()
    const c = await db.connect()
    let leaseId = ''
    try { leaseId = await seedLease(c, { unitId: f.rvA, landlordId: f.landlordId, status: 'active' }) }
    finally { c.release() }
    await db.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'water', true), ($1, 'trash', false)`, [leaseId])
    const res = await request(app).get(`/api/units/${f.rvA}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const billed = res.body.data.tenant_billed_utilities ?? res.body.data.tenantBilledUtilities
    expect(billed).toContain('water')
    expect(billed).not.toContain('trash')
  })
})

// S613 (Nic, DIRECTIVE): "The accuracy we're going for is that the things that
// are IN the lease cannot be ALTERED on the charge, not that no other charges
// happen. Trash or other stuff may be an addendum when billed back separately."
describe('charges outside the lease (S613)', () => {
  async function activeLease(unitId: string, landlordId: string) {
    const c = await db.connect()
    try { return await seedLease(c, { unitId, landlordId, status: 'active' }) } finally { c.release() }
  }

  it('a utility the lease never mentioned can be billed back, recorded as an addendum', async () => {
    const app = buildApp(); const f = await seed()
    const leaseId = await activeLease(f.rvA, f.landlordId)
    const res = await request(app).patch(`/api/units/${f.rvA}/utility-responsibility`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ utilityType: 'trash', tenantResponsible: true, note: 'signed addendum 2026-08' })
    expect(res.status).toBe(200)
    const row = (await db.query(
      `SELECT tenant_responsible, source, set_by_user_id, note FROM lease_utility_responsibilities
        WHERE lease_id = $1 AND utility_type = 'trash'`, [leaseId])).rows[0]
    expect(row.tenant_responsible).toBe(true)
    expect(row.source).toBe('addendum')
    expect(row.set_by_user_id).toBe(f.userId)
    expect(row.note).toMatch(/addendum/)
  })

  // The half of the rule that stays: what the signed lease FIXES cannot move.
  it('a responsibility that came from the signed lease cannot be switched off', async () => {
    const app = buildApp(); const f = await seed()
    const leaseId = await activeLease(f.rvA, f.landlordId)
    await db.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible, source)
       VALUES ($1, 'water', true, 'lease')`, [leaseId])
    const res = await request(app).patch(`/api/units/${f.rvA}/utility-responsibility`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ utilityType: 'water', tenantResponsible: false })
    expect(res.status).toBe(409)
    const row = (await db.query(
      `SELECT tenant_responsible FROM lease_utility_responsibilities
        WHERE lease_id = $1 AND utility_type = 'water'`, [leaseId])).rows[0]
    expect(row.tenant_responsible).toBe(true)
  })

  it('no active lease → says there is nobody to bill', async () => {
    const app = buildApp(); const f = await seed()
    const res = await request(app).patch(`/api/units/${f.rvA}/utility-responsibility`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ utilityType: 'trash', tenantResponsible: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no active lease/i)
  })

  // The bulk door — a park that starts charging for trash hits this on every
  // lease at once, and one unit at a time is how half of them get missed.
  it('bill-back covers every unit on the meter in one go', async () => {
    const app = buildApp(); const f = await seed()
    await activeLease(f.rvA, f.landlordId)
    await activeLease(f.rvB, f.landlordId)
    const meter = await request(app).post('/api/utility/meters')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, utilityType: 'trash', label: 'Trash',
              billingMethod: 'flat_rate', baseFee: 0, assignUnitId: f.rvA })
    await request(app).post(`/api/utility/meters/${meter.body.data.id}/units`)
      .set('Authorization', `Bearer ${f.token}`).send({ unitId: f.rvB })

    const before = await request(app).get(`/api/utility/meters?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    const m = before.body.data.find((x: any) => x.id === meter.body.data.id)
    expect((m.units_not_billing ?? m.unitsNotBilling).length).toBe(2)

    const res = await request(app).post(`/api/utility/meters/${meter.body.data.id}/bill-back`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.leasesUpdated).toBe(2)

    const after = await request(app).get(`/api/utility/meters?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    const m2 = after.body.data.find((x: any) => x.id === meter.body.data.id)
    expect((m2.units_not_billing ?? m2.unitsNotBilling).length).toBe(0)
  })
})
