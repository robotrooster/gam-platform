/**
 * S630 DIRECTIVE (Nic): "Properties are not allowed to be deleted... landlords
 * are not allowed to delete properties as we need to check the full history of
 * stuff on the platform. Landlords can transfer property to another landlord,
 * they can be non-charged for a property if all the units become vacant. That is
 * it. Once the property is on the platform, it's on there forever."
 *
 * I had briefly given landlords a delete button. That was wrong. What remains is
 * an operator-only path for a record that was never a real property — and these
 * tests hold the line: a landlord is refused however clean the property is.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _r, n) => { req.headers.authorization && n() })
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

describe('DELETE /api/properties/:id', () => {
  let token = '', landlordId = '', userId = '', propId = ''

  beforeEach(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s450'
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      userId = ll.userId; landlordId = ll.landlordId
      propId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId,
                       landlordIds: [landlordId], permissions: {} },
                      process.env.JWT_SECRET!, { expiresIn: '1h' })
  })

  const del = (id = propId) => request(buildApp()).delete(`/api/properties/${id}`)
    .set('Authorization', `Bearer ${token}`)

  /** The platform operator — the only role that may remove a never-real record. */
  const adminDel = (id = propId) => request(buildApp()).delete(`/api/properties/${id}`)
    .set('Authorization', `Bearer ${jwt.sign(
      { userId, role: 'super_admin', email: 'nic@golddoor.io', permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })}`)

  it('REFUSES a landlord outright — a property is never theirs to delete', async () => {
    const res = await del()
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/cannot be deleted/i)
    expect(res.body.error).toMatch(/transfer/i)
    expect((await db.query('SELECT 1 FROM properties WHERE id=$1', [propId])).rows).toHaveLength(1)
  })

  it('the operator deletes a property that never had a tenancy, and its units with it', async () => {
    const c = await db.connect()
    try { await c.query('BEGIN'); await seedUnit(c, { propertyId: propId, landlordId }); await c.query('COMMIT') }
    finally { c.release() }

    const res = await adminDel()
    expect(res.status).toBe(200)
    const rows = await db.query('SELECT 1 FROM properties WHERE id=$1', [propId])
    expect(rows.rows).toHaveLength(0)
    const units = await db.query('SELECT 1 FROM units WHERE property_id=$1', [propId])
    expect(units.rows).toHaveLength(0)
  })

  it('REFUSES once anyone has held a lease there — GAM keeps that history', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: propId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await adminDel()
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/lease on record/i)
    expect((await db.query('SELECT 1 FROM properties WHERE id=$1', [propId])).rows).toHaveLength(1)
  })

  // The money row is the book of record and carries a running balance every
  // later entry is computed from. It is never deleted — only detached.
  it('keeps the revenue ledger entry and only clears its pointer', async () => {
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, property_id, notes)
       VALUES ('platform_fee_subscription', 10, 10, $1, 'test fee')`, [propId])
    await db.query(
      `INSERT INTO platform_fee_accruals
         (landlord_id, property_id, accrual_month, long_term_unit_count, short_stay_nights,
          short_stay_equivalent, total_billable, rate_per_unit, min_per_connect_account,
          total_amount, payer)
       VALUES ($1,$2,'2026-08-01',0,0,0,0,2,10,10,'landlord')`, [landlordId, propId])

    expect((await adminDel()).status).toBe(200)

    const ledger = await db.query<any>(
      `SELECT amount::float AS amount, property_id, notes FROM platform_revenue_ledger WHERE notes='test fee'`)
    expect(ledger.rows).toHaveLength(1)          // the money survives
    expect(ledger.rows[0].property_id).toBeNull() // only the pointer goes
    expect(ledger.rows[0].amount).toBe(10)
    // The accrual is a working calculation, not the record.
    const accr = await db.query('SELECT 1 FROM platform_fee_accruals WHERE property_id=$1', [propId])
    expect(accr.rows).toHaveLength(0)
  })

  it('another landlord cannot delete it either', async () => {
    const c = await db.connect()
    let otherToken = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      await c.query('COMMIT')
      otherToken = jwt.sign({ userId: other.userId, role: 'landlord', email: 'b@t.dev',
                              profileId: other.landlordId, landlordIds: [other.landlordId], permissions: {} },
                             process.env.JWT_SECRET!, { expiresIn: '1h' })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp()).delete(`/api/properties/${propId}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(403)
    expect((await db.query('SELECT 1 FROM properties WHERE id=$1', [propId])).rows).toHaveLength(1)
  })
})
