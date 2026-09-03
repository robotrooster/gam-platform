/**
 * S636 — property-scoped rental application + its QR.
 *
 * Nic: "I need a link that takes them to that flow through a QR code.
 * It needs to map that tenant inquiry or invite or background to that
 * specific property."
 *
 * Every piece of the applicant flow already existed; none of it carried
 * the property. These hold the connector: the slug scopes the write, a
 * unit from another park cannot be smuggled in, and the landlord can
 * fetch a printable code without asking anyone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

vi.mock('../services/notifications', () => ({ createNotification: vi.fn(async () => undefined) }))

import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

let fx: {
  slug: string; propertyId: string; landlordId: string; unitId: string
  otherPropertyId: string; otherUnitId: string; token: string; otherToken: string
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_applyqr'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const { userId: oUid, landlordId: oLid } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const otherPropertyId = await seedProperty(c, { landlordId: oLid, ownerUserId: oUid, managedByUserId: oUid })
    const slug = `park-${randomUUID().slice(0, 8)}`
    await c.query(`UPDATE properties SET booking_slug=$1, public_booking_enabled=TRUE WHERE id=$2`, [slug, propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const otherUnitId = await seedUnit(c, { propertyId: otherPropertyId, landlordId: oLid })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    fx = {
      slug, propertyId, landlordId, unitId, otherPropertyId, otherUnitId,
      token: sign({ userId, role: 'landlord', email: 'a@t.dev', profileId: landlordId, permissions: {} }),
      otherToken: sign({ userId: oUid, role: 'landlord', email: 'b@t.dev', profileId: oLid, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
})

// Exactly what Checkr's Tenant API needs to open an order — nothing more
// is asked at the QR, because Checkr collects the rest on its own form.
const APPLICANT = { firstName: 'Randall', lastName: 'Cox', email: 'r@cox.dev', phone: '555-0100' }

describe('GET /api/properties/:id/apply-link', () => {
  it('encodes the SCREENING page with the property bound — not a GAM form', async () => {
    const res = await request(buildApp())
      .get(`/api/properties/${fx.propertyId}/apply-link`)
      .set('Authorization', `Bearer ${fx.token}`)
    expect(res.status).toBe(200)
    const url: string = res.body.data.url
    expect(url).toContain('/background-check')
    expect(url).toContain(`propertyId=${fx.propertyId}`)
    expect(url).toContain(`landlordId=${fx.landlordId}`)
    // Nothing on the property's own site — the applicant should not be asked
    // for anything the screening flow collects anyway.
    expect(url).not.toContain('/apply')
    expect(res.body.data.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('says so plainly when the property has no public site instead of erroring', async () => {
    const res = await request(buildApp())
      .get(`/api/properties/${fx.otherPropertyId}/apply-link`)
      .set('Authorization', `Bearer ${fx.otherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.url).toBeNull()
    expect(res.body.data.reason).toBe('no_booking_slug')
  })

  it("403s another landlord's property", async () => {
    const res = await request(buildApp())
      .get(`/api/properties/${fx.propertyId}/apply-link`)
      .set('Authorization', `Bearer ${fx.otherToken}`)
    expect(res.status).toBe(403)
  })
})
