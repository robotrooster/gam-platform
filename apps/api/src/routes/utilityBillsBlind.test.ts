/**
 * 10/20 — THE BLIND WALK'S ANSWER KEY WAS ONE GET AWAY.
 *
 * GET /api/utility/bills was declared with no permission gate and no property
 * scope, and selected `ub.*` — so reading_start, reading_end and usage_amount
 * rode out on every row. The caller it mattered most for is the front-desk
 * onsite_manager who holds nothing but "Enter meter readings": they walk the
 * park, and this handed them every utility bill in the company, other parks
 * included, each carrying last cycle's closing odometer value. Walk in knowing
 * that number and you can type a reading whose usage looks ordinary — which is
 * exactly what the rollover check, the usage-alert thresholds and the
 * landlord's double-check window all compare against, so all three pass.
 *
 * The meter list has withheld that figure from this same caller since 10/3.
 * These tests pin the rest of the rule where it was missing: the gate, the
 * property lock, the odometer off the row, and the two other reads that
 * skipped one of those — the readings spreadsheet (which IS the figures, and
 * admitted the unit-status permission the front desk carries) and the reading
 * history / recovery report, which took any property id a company's manager
 * cared to pass.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bills_blind'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

/**
 * One company, two parks. Each park has a space, a submeter, a resident and
 * one issued utility bill whose odometer figures are set explicitly — the
 * numbers a reader must not be shown.
 */
async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const park = async (name: string, readStart: number, readEnd: number) => {
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, name])
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      const billId = (await c.query<{ id: string }>(
        `INSERT INTO utility_bills
           (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
            charge_amount, status, billed_at, utility_type,
            usage_amount, reading_start, reading_end, reading_start_date, reading_end_date)
         VALUES ($1, $2, $3, $4, $5, '2026-09-01', 42.17, 'billed', NOW(), 'electric',
                 $6, $7, $8, '2026-08-31', '2026-09-30') RETURNING id`,
        [meterId, unitId, tenantId, leaseId, landlordId, readEnd - readStart, readStart, readEnd])).rows[0].id
      // The read the cycle closed on, so the history/export reads have a figure.
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1, '2026-09-30', $2, '2026-09-01', $3, 'monthly_cycle')`, [meterId, readEnd, userId])
      const tUser = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
      return { propertyId, unitId, meterId, tenantId, leaseId, billId, tenantUserId: tUser, readStart, readEnd }
    }
    const mountainView = await park('Mountain View', 1000, 1100)
    const oakPark      = await park('Oak Park', 2000, 2200)

    // A staffer of this company, assigned to Mountain View only.
    const staff = async (role: 'onsite_manager' | 'property_manager', perms: Record<string, boolean>) => {
      const uid = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', $2, 'Front', 'Desk', TRUE) RETURNING id`,
        [`staff-${randomUUID()}@test.dev`, role])).rows[0].id
      const table = role === 'onsite_manager' ? 'onsite_manager_scopes' : 'property_manager_scopes'
      await c.query(
        `INSERT INTO ${table} (user_id, landlord_id, property_ids, all_properties, permissions)
         VALUES ($1, $2, $3, FALSE, $4)`,
        [uid, landlordId, [mountainView.propertyId], JSON.stringify(perms)])
      return sign({ userId: uid, role, email: 'desk@t.dev', profileId: null, landlordId, permissions: perms })
    }
    const readerToken   = await staff('onsite_manager', { 'utility.read_meters': true })
    const deskToken     = await staff('onsite_manager', { 'utility.read_meters': true, 'units.view_status': true })
    const parkMgrToken  = await staff('property_manager', { 'properties.edit': true })
    await c.query('COMMIT')
    return {
      landlordId, userId, mountainView, oakPark,
      readerToken, deskToken, parkMgrToken,
      ownerToken:  sign({ userId, role: 'landlord', email: 'owner@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      tenantToken: sign({ userId: mountainView.tenantUserId, role: 'tenant', email: 'res@t.dev', profileId: mountainView.tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const bills = (token: string) =>
  request(buildApp()).get('/api/utility/bills').set('Authorization', `Bearer ${token}`)

/** Every leaf value in an answer, as text — so a uuid containing "1100" is not read as a leaked figure. */
function leakedValues(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(x => leakedValues(x, out))
  else if (v != null) out.push(String(v))
  return out
}

describe('GET /bills — the gate, the park, and the odometer', () => {
  it('the front desk that walks the meters cannot list bills at all', async () => {
    const f = await seed()
    const r = await bills(f.readerToken)
    expect(r.status).toBe(403)
    // And nothing came back with it: not the figure, not the other park.
    expect(leakedValues(r.body)).not.toContain('1100')
    expect(leakedValues(r.body)).not.toContain('2200')
  })

  it('a staffer who may see bills gets their own park only, never another park in the company', async () => {
    const f = await seed()
    const r = await bills(f.deskToken)
    expect(r.status).toBe(200)
    expect(r.body.data.map((b: any) => b.id)).toEqual([f.mountainView.billId])
    expect(r.body.data.map((b: any) => b.property_name)).toEqual(['Mountain View'])
  })

  it('and gets the charge without the figures a reading could be worked back from', async () => {
    const f = await seed()
    const row = (await bills(f.deskToken)).body.data[0]
    expect(Number(row.charge_amount)).toBeCloseTo(42.17, 2)
    expect(row.reading_end).toBeUndefined()
    expect(row.reading_start).toBeUndefined()
    expect(row.usage_amount).toBeUndefined()
    // The window a charge covers still reads — only the numbers are gone.
    expect(row.reading_end_date).toBeTruthy()
    expect(leakedValues(row)).not.toContain('1100')
    expect(leakedValues(row)).not.toContain('100')
  })

  it('the owner still sees every park and the readings each bill ran between', async () => {
    const f = await seed()
    const r = await bills(f.ownerToken)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(2)
    const mv = r.body.data.find((b: any) => b.id === f.mountainView.billId)
    expect(Number(mv.reading_start)).toBe(1000)
    expect(Number(mv.reading_end)).toBe(1100)
    expect(Number(mv.usage_amount)).toBe(100)
  })

  it('a resident still gets their own issued bill with its meter range, as their invoice prints it', async () => {
    const f = await seed()
    const r = await bills(f.tenantToken)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(1)
    expect(r.body.data[0].tenant_id).toBe(f.mountainView.tenantId)
    expect(Number(r.body.data[0].reading_end)).toBe(1100)
  })
})

describe('the readings spreadsheet is not handed to someone who walks blind', () => {
  const exportCsv = (token: string, propertyId: string) =>
    request(buildApp()).get(`/api/utility/readings/export?propertyId=${propertyId}`).set('Authorization', `Bearer ${token}`)

  it('a front desk with unit status is refused — the file is nothing but reading values', async () => {
    const f = await seed()
    const r = await exportCsv(f.deskToken, f.mountainView.propertyId)
    expect(r.status).toBe(403)
    expect(r.text).not.toContain('1100')
  })

  it('the owner still downloads it', async () => {
    const f = await seed()
    const r = await exportCsv(f.ownerToken, f.mountainView.propertyId)
    expect(r.status).toBe(200)
    expect(r.text).toContain('1100')
  })

  it('a manager assigned to one park cannot export another park at the same company', async () => {
    const f = await seed()
    expect((await exportCsv(f.parkMgrToken, f.mountainView.propertyId)).status).toBe(200)
    const other = await exportCsv(f.parkMgrToken, f.oakPark.propertyId)
    expect(other.status).toBe(403)
    expect(other.text).not.toContain('2200')
  })
})

describe('a park id in the query string is not a key to another park', () => {
  it('reading history: the manager assigned to Mountain View is refused Oak Park', async () => {
    const f = await seed()
    const mine = await request(buildApp())
      .get(`/api/utility/reading-history?propertyId=${f.mountainView.propertyId}`)
      .set('Authorization', `Bearer ${f.parkMgrToken}`)
    expect(mine.status).toBe(200)
    const theirs = await request(buildApp())
      .get(`/api/utility/reading-history?propertyId=${f.oakPark.propertyId}`)
      .set('Authorization', `Bearer ${f.parkMgrToken}`)
    expect(theirs.status).toBe(403)
    expect(leakedValues(theirs.body)).not.toContain('2200')
  })

  it('the recovery report: same answer, and the owner still reads both', async () => {
    const f = await seed()
    const window = 'from=2026-09-01&to=2026-09-30'
    const theirs = await request(buildApp())
      .get(`/api/utility/recovery?propertyId=${f.oakPark.propertyId}&${window}`)
      .set('Authorization', `Bearer ${f.parkMgrToken}`)
    expect(theirs.status).toBe(403)
    for (const p of [f.mountainView.propertyId, f.oakPark.propertyId]) {
      const owner = await request(buildApp())
        .get(`/api/utility/recovery?propertyId=${p}&${window}`)
        .set('Authorization', `Bearer ${f.ownerToken}`)
      expect(owner.status).toBe(200)
    }
  })
})
