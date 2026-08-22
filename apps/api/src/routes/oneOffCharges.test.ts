/**
 * S616 — charging for something that happened.
 *
 * Nic: "you are saying a landlord charging a parking violation would get the
 * charge ignored?" It would not have been ignored — there was nowhere to enter
 * it. Every payments row came from a specific system flow and every lease_fees
 * row came from the lease document.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { oneOffChargesRouter } from './oneOffCharges'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { generateInvoices } from '../jobs/invoiceGeneration'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/one-off-charges', oneOffChargesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_oneoff'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, {
      unitId, landlordId, status: 'active', rentAmount: 900, startDate: '2026-01-01',
    })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(`UPDATE leases SET rent_due_day = 1 WHERE id = $1`, [leaseId])
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId, tenantId, leaseId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

// billOnOrAfter is set explicitly rather than left to its default. The default
// is CURRENT_DATE — correct in production, where a charge entered today rides
// the next invoice — but these tests generate invoices at a SIMULATED date in
// the past, and the database's CURRENT_DATE is the real one.
const violation = {
  chargeType: 'violation', amount: 50,
  reason: 'Parking in the fire lane', incidentDate: '2026-03-14',
  billOnOrAfter: '2026-03-14',
}

describe('POST /api/one-off-charges (S616)', () => {
  it('records a violation against the tenant’s live tenancy', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
    expect(Number(res.body.data.amount)).toBe(50)

    // The unit, lease and landlord come from the TENANCY, never the request —
    // a body-supplied lease id would let a caller charge someone else's tenant.
    const { rows: [row] } = await db.query<any>(
      `SELECT lease_id, unit_id, landlord_id FROM tenant_one_off_charges WHERE id=$1`,
      [res.body.data.id])
    expect(row.lease_id).toBe(f.leaseId)
    expect(row.unit_id).toBe(f.unitId)
    expect(row.landlord_id).toBe(f.landlordId)
  })

  it('refuses a charge with no explanation', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation, reason: '' })
    expect(res.status).toBe(400)
  })

  it('refuses another landlord’s tenant', async () => {
    const mine = await seed()
    const theirs = await seed()
    const res = await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ tenantId: theirs.tenantId, ...violation })
    expect(res.status).toBe(403)
  })

  it('lands on the tenant’s next invoice, with the reason and the date', async () => {
    const f = await seed()
    await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation })

    await generateInvoices(new Date('2026-04-05T14:00:00Z'))

    const { rows: [inv] } = await db.query<any>(
      `SELECT id, subtotal_fees::text AS fees, total_amount::text AS total
         FROM invoices WHERE lease_id = $1 ORDER BY due_date DESC LIMIT 1`,
      [f.leaseId])
    expect(Number(inv.fees)).toBe(50)
    expect(Number(inv.total)).toBe(950)   // $900 rent + $50 violation

    const { rows: [pay] } = await db.query<any>(
      `SELECT amount::text, type, entry_description, notes
         FROM payments WHERE invoice_id = $1 AND type = 'fee'`, [inv.id])
    expect(Number(pay.amount)).toBe(50)
    // Not 'SUBSCRIP' — a fire-lane fine is not a subscription on a bank statement.
    expect(pay.entry_description).toBe('OTHERFEE')
    expect(pay.notes).toBe('Parking in the fire lane (Mar 14)')

    // Stamped so the next run cannot bill it twice.
    const { rows: [c] } = await db.query<any>(
      `SELECT status, payment_id FROM tenant_one_off_charges WHERE lease_id=$1`,
      [f.leaseId])
    expect(c.status).toBe('billed')
    expect(c.payment_id).not.toBeNull()
  })

  it('does not bill twice when generation runs again', async () => {
    const f = await seed()
    await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation })

    await generateInvoices(new Date('2026-04-05T14:00:00Z'))
    await generateInvoices(new Date('2026-05-06T14:00:00Z'))

    const { rows } = await db.query<any>(
      `SELECT p.id FROM payments p WHERE p.lease_id = $1 AND p.entry_description = 'OTHERFEE'`,
      [f.leaseId])
    expect(rows).toHaveLength(1)
  })

  it('waits for the cycle a landlord pushed it to', async () => {
    const f = await seed()
    await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation, billOnOrAfter: '2026-06-01' })

    await generateInvoices(new Date('2026-04-05T14:00:00Z'))
    const { rows: early } = await db.query<any>(
      `SELECT id FROM payments WHERE lease_id=$1 AND entry_description='OTHERFEE'`,
      [f.leaseId])
    expect(early).toHaveLength(0)

    const { rows: [c] } = await db.query<any>(
      `SELECT status FROM tenant_one_off_charges WHERE lease_id=$1`, [f.leaseId])
    expect(c.status).toBe('pending')
  })
})

describe('PATCH /api/one-off-charges/:id/cancel (S616)', () => {
  it('withdraws an unbilled charge with a reason rather than deleting it', async () => {
    const f = await seed()
    const created = await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation })

    const res = await request(buildApp())
      .patch(`/api/one-off-charges/${created.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ reason: 'Spoke to them, letting it go' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')

    // GAM never erases: the row is still there with the reason on it.
    const { rows } = await db.query<any>(
      `SELECT status, cancel_reason FROM tenant_one_off_charges WHERE id=$1`,
      [created.body.data.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].cancel_reason).toBe('Spoke to them, letting it go')

    await generateInvoices(new Date('2026-04-05T14:00:00Z'))
    const { rows: pays } = await db.query<any>(
      `SELECT id FROM payments WHERE lease_id=$1 AND entry_description='OTHERFEE'`,
      [f.leaseId])
    expect(pays).toHaveLength(0)
  })

  // Money already billed is unwound by crediting it, so both the charge and the
  // forgiveness stay on the record.
  it('refuses to cancel one that is already on an invoice', async () => {
    const f = await seed()
    const created = await request(buildApp())
      .post('/api/one-off-charges')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.tenantId, ...violation })
    await generateInvoices(new Date('2026-04-05T14:00:00Z'))

    const res = await request(buildApp())
      .patch(`/api/one-off-charges/${created.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/credit/i)
  })
})
