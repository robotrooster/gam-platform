/**
 * Service interruptions / utility outage broadcasts.
 *
 * Covers: emergency (immediate) property-wide post → all residents alerted +
 * status active; scheduled (future) post → status scheduled; unit-subset
 * targeting hits only that unit's resident; resolve + all-clear; cancel;
 * tenant live-notice feed; and the unit-not-in-property / foreign-landlord
 * guards. Email mocked so createNotification still writes in-app rows.
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

import { serviceInterruptionsRouter } from './serviceInterruptions'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_service_int'

const app = (() => {
  const a = express()
  a.use(express.json({ limit: '2mb' }))
  a.use('/api/service-interruptions', serviceInterruptionsRouter)
  a.use(errorHandler)
  return a
})()

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

// Two units, one resident each.
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
      landlordId, propertyId, unit1, unit2,
      llToken: token({ userId: llUser, role: 'landlord', profileId: landlordId, landlordId }),
      t1, t1User, t1Token: token({ userId: t1User, role: 'tenant', profileId: t1 }),
      t2, t2User,
    }
  } finally { client.release() }
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

beforeEach(async () => { await cleanupAllSchema() })

describe('service interruptions — broadcast', () => {
  it('emergency property-wide outage alerts all residents and is active now', async () => {
    const f = await fixture()
    const res = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'water', isEmergency: true,
        title: 'Water main break', expectedRestoreAt: inHours(3) })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.is_emergency).toBe(true)
    expect(res.body.data.notified).toBe(2)
    expect(await notifCount('service_interruption')).toBe(2)
    expect(await notifCount('service_interruption', f.t1User)).toBe(1)
    expect(await notifCount('service_interruption', f.t2User)).toBe(1)
  })

  it('future-dated notice is scheduled', async () => {
    const f = await fixture()
    const res = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'power', startsAt: inHours(24), expectedRestoreAt: inHours(28) })
    expect(res.body.data.status).toBe('scheduled')
    expect(await notifCount('service_interruption')).toBe(2)
  })

  it('unit-subset notice only alerts that unit\'s resident', async () => {
    const f = await fixture()
    const res = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, unitIds: [f.unit1], utilityType: 'elevator', startsAt: inHours(2) })
    expect(res.body.data.notified).toBe(1)
    expect(await notifCount('service_interruption', f.t1User)).toBe(1)
    expect(await notifCount('service_interruption', f.t2User)).toBe(0)
  })

  it('resolve with all-clear notifies residents and flips status', async () => {
    const f = await fixture()
    const post = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'water', isEmergency: true })
    const resolve = await request(app).post(`/api/service-interruptions/${post.body.data.id}/resolve`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ sendAllClear: true })
    expect(resolve.status).toBe(200)
    expect(resolve.body.data.status).toBe('resolved')
    expect(resolve.body.data.restore_notified_at).toBeTruthy()
    // 2 outage + 2 restored = 4 service_interruption rows
    expect(await notifCount('service_interruption')).toBe(4)
  })

  it('cancel flips status and blocks double-resolve', async () => {
    const f = await fixture()
    const post = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'gas', startsAt: inHours(5) })
    const cancel = await request(app).post(`/api/service-interruptions/${post.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${f.llToken}`).send({})
    expect(cancel.status).toBe(200)
    const reResolve = await request(app).post(`/api/service-interruptions/${post.body.data.id}/resolve`)
      .set('Authorization', `Bearer ${f.llToken}`).send({})
    expect(reResolve.status).toBe(400)
  })
})

describe('tenant feed + guards', () => {
  it('tenant sees live notices affecting them', async () => {
    const f = await fixture()
    // property-wide active + a unit2-only notice (should NOT reach t1)
    await request(app).post('/api/service-interruptions').set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'water', isEmergency: true })
    await request(app).post('/api/service-interruptions').set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, unitIds: [f.unit2], utilityType: 'elevator', startsAt: inHours(2) })
    const mine = await request(app).get('/api/service-interruptions/mine')
      .set('Authorization', `Bearer ${f.t1Token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1) // only the property-wide one
    expect(mine.body.data[0].utility_type).toBe('water')
  })

  it('rejects units not in the property', async () => {
    const f = await fixture()
    const other = await fixture()
    const res = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, unitIds: [other.unit1], utilityType: 'power', startsAt: inHours(2) })
    expect(res.status).toBe(400)
  })

  it('foreign landlord cannot post to a property', async () => {
    const f = await fixture()
    const other = await fixture()
    const res = await request(app).post('/api/service-interruptions')
      .set('Authorization', `Bearer ${other.llToken}`)
      .send({ propertyId: f.propertyId, utilityType: 'water', isEmergency: true })
    expect(res.status).toBe(403)
  })
})
