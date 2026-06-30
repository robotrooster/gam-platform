/**
 * Common-area reservations + amenity alerts (launch feature).
 *
 * Covers: area CRUD scoping, landlord closure → resident fan-out alert,
 * tenant request → landlord pending notification → approve → resident
 * decision + amenity alert (reserving tenant excluded), auto-approve path,
 * overlap-conflict 409, non-resident 403, and window validation.
 *
 * Email layer mocked so createNotification still writes in-app notification
 * rows (which we assert on) without attempting real delivery.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { PoolClient } from 'pg'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => null) }
})

import { commonAreasRouter } from './commonAreas'
import { computeReservationFee } from '../services/commonAreas'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_common_areas'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/common-areas', commonAreasRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()

function token(p: { userId: string; role: string; profileId: string; landlordId?: string }) {
  return jwt.sign(
    { userId: p.userId, role: p.role, email: `${p.userId}@t.dev`, profileId: p.profileId,
      landlordId: p.landlordId ?? null, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}
async function tenantUserId(client: PoolClient, tenantId: string) {
  const r = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
  return r.rows[0].user_id
}
async function notifCount(type: string, userId?: string) {
  const r = userId
    ? await db.query(`SELECT count(*)::int n FROM notifications WHERE type=$1 AND user_id=$2`, [type, userId])
    : await db.query(`SELECT count(*)::int n FROM notifications WHERE type=$1`, [type])
  return r.rows[0].n as number
}

// Two-resident property + landlord. Returns ids + tokens.
async function fixture() {
  const client = await db.connect()
  try {
    const { userId: llUser, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unit1 = await seedUnit(client, { propertyId, landlordId })
    const unit2 = await seedUnit(client, { propertyId, landlordId })
    const t1 = await seedTenant(client)
    const t2 = await seedTenant(client)
    const l1 = await seedLease(client, { unitId: unit1, landlordId })
    const l2 = await seedLease(client, { unitId: unit2, landlordId })
    await seedLeaseTenant(client, { leaseId: l1, tenantId: t1 })
    await seedLeaseTenant(client, { leaseId: l2, tenantId: t2 })
    const t1User = await tenantUserId(client, t1)
    const t2User = await tenantUserId(client, t2)
    return {
      landlordId, propertyId,
      llToken: token({ userId: llUser, role: 'landlord', profileId: landlordId, landlordId }),
      t1, t1User, t1Token: token({ userId: t1User, role: 'tenant', profileId: t1 }),
      t2, t2User,
    }
  } finally { client.release() }
}

const PLUS = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

async function makeArea(llToken: string, propertyId: string, over: any = {}) {
  const res = await request(app).post('/api/common-areas')
    .set('Authorization', `Bearer ${llToken}`)
    .send({ propertyId, name: 'Clubhouse', ...over })
  return res
}

beforeEach(async () => { await cleanupAllSchema() })

describe('common areas — management', () => {
  it('landlord creates + lists + updates an area; foreign landlord is blocked', async () => {
    const f = await fixture()
    const create = await makeArea(f.llToken, f.propertyId, { capacity: 30, reservationFee: 50, maxReservationHours: 4 })
    expect(create.status).toBe(201)
    expect(create.body.data.name).toBe('Clubhouse')
    expect(Number(create.body.data.reservation_fee)).toBe(50)

    const list = await request(app).get(`/api/common-areas?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.llToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)

    const patch = await request(app).patch(`/api/common-areas/${create.body.data.id}`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ capacity: 50 })
    expect(patch.status).toBe(200)
    expect(patch.body.data.capacity).toBe(50)

    // a different landlord cannot read this property's areas
    const other = await fixture()
    const blocked = await request(app).get(`/api/common-areas?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${other.llToken}`)
    expect(blocked.status).toBe(403)
  })
})

describe('amenity alerts', () => {
  it('landlord maintenance closure goes live and alerts every resident', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const res = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'maintenance_closure', title: 'Chemical treatment', startsAt: PLUS(24), endsAt: PLUS(27) })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('approved')
    // both residents notified (closure has no reserving tenant to exclude)
    expect(await notifCount('amenity_unavailable')).toBe(2)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })

  it('landlord can suppress the resident alert', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'private_rental', startsAt: PLUS(24), endsAt: PLUS(26), notifyResidents: false })
    expect(await notifCount('amenity_unavailable')).toBe(0)
  })
})

describe('tenant request → approval flow', () => {
  it('request lands pending + notifies landlord; approve alerts other residents + the requester', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data // requires_approval default true

    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ title: 'Birthday party', startsAt: PLUS(48), endsAt: PLUS(51), guestCount: 12 })
    expect(reqRes.status).toBe(201)
    expect(reqRes.body.data.status).toBe('pending')
    expect(reqRes.body.data.reserved_by_tenant_id).toBe(f.t1)
    expect(await notifCount('reservation_requested')).toBe(1)

    const decide = await request(app).post(`/api/common-areas/reservations/${reqRes.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: true })
    expect(decide.status).toBe(200)
    expect(decide.body.data.status).toBe('approved')
    // requester gets a decision notice
    expect(await notifCount('reservation_decision', f.t1User)).toBe(1)
    // amenity alert goes to the OTHER resident only (requester excluded)
    expect(await notifCount('amenity_unavailable')).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('reject notifies the requester and fires no amenity alert', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(50) })
    const decide = await request(app).post(`/api/common-areas/reservations/${reqRes.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: false, note: 'Booked for staff event' })
    expect(decide.body.data.status).toBe('rejected')
    expect(await notifCount('reservation_decision', f.t1User)).toBe(1)
    expect(await notifCount('amenity_unavailable')).toBe(0)
  })

  it('auto-approve area: tenant request goes straight to approved + alerts others', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false })).body.data
    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(10), endsAt: PLUS(12) })
    expect(reqRes.body.data.status).toBe('approved')
    expect(await notifCount('reservation_requested')).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })
})

describe('guards', () => {
  it('overlapping approved hold is rejected with 409', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const first = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'event', startsAt: PLUS(24), endsAt: PLUS(28) })
    expect(first.status).toBe(201)
    const overlap = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'private_rental', startsAt: PLUS(26), endsAt: PLUS(30) })
    expect(overlap.status).toBe(409)
  })

  it('non-resident tenant cannot request', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const outsider = await fixture() // a tenant at a different property
    const res = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${outsider.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(50) })
    expect(res.status).toBe(403)
  })

  it('reservation exceeding the hour cap is rejected', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { maxReservationHours: 3 })).body.data
    const res = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(54) })
    expect(res.status).toBe(400)
  })
})

describe('reservation fee charging (#4)', () => {
  const feePayments = (tenantId: string) =>
    db.query(`SELECT id, amount, status FROM payments WHERE tenant_id=$1 AND type='fee'`, [tenantId])

  it('demand pricing: weekend uses weekend_fee, weekday uses base', () => {
    const area = { reservation_fee: 50, weekend_fee: 90 }
    // 2026-06-27 is a Saturday; 2026-06-30 is a Tuesday.
    expect(computeReservationFee(area, '2026-06-27T15:00:00Z')).toBe(90)
    expect(computeReservationFee(area, '2026-06-30T15:00:00Z')).toBe(50)
    expect(computeReservationFee({ reservation_fee: 50, weekend_fee: null }, '2026-06-27T15:00:00Z')).toBe(50)
  })

  it('auto-approved reservation bills the fee as a tenant payment', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })
    expect(r.status).toBe(201)
    const pays = await feePayments(f.t1)
    expect(pays.rows).toHaveLength(1)
    expect(Number(pays.rows[0].amount)).toBe(40)
    expect(r.body.data.fee_payment_id).toBeTruthy()
  })

  it('cancel ≥48h ahead voids an unpaid fee', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await feePayments(f.t1)).rows).toHaveLength(0) // unpaid fee removed
  })

  it('cancel inside 48h leaves the fee standing', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(10), endsAt: PLUS(12) })).body.data
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('fee_stands')
    expect((await feePayments(f.t1)).rows).toHaveLength(1) // still owed
  })
})
