/**
 * Property-scoped VIEWS for scoped staff (S526) — the read-side companion to
 * the POS property-lock (pos-property-scope.test.ts).
 *
 * A property-locked worker (front-desk preset) may only SEE data at their
 * assigned properties across: /units/schedule/master, /units/schedule/history,
 * /bookings, /bookings/change-requests, /balances. Owners + all_properties
 * see landlord-wide. Also covers the S526 key fix: the schedule endpoints now
 * accept the CATALOG keys (schedule.tab.*, bookings.view) that the permissions
 * page actually grants — pre-fix a front-desk user 403'd on their own tabs.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from './../test/dbHelpers'
import { unitsRouter } from './units'
import { bookingsRouter } from './bookings'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use('/api/bookings', bookingsRouter)
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_sched_scope'
})

// The keys the Front Desk preset grants (catalog keys — NOT the legacy
// guests.check_in / units.view_status set).
const FRONT_DESK_PERMS = {
  'schedule.tab.timeline': true, 'schedule.tab.list': true,
  'schedule.tab.units': true, 'schedule.tab.history': true,
  'bookings.view': true, 'bookings.change_requests': true,
  'balances.view': true,
}

interface Fixture {
  landlordId: string
  ownerToken: string
  deskToken:  string   // onsite_manager scoped to property A only
  propAId: string
  propBId: string
  unitAId: string
  unitA2Id: string
  unitBId: string
  bookingAId: string
  bookingBId: string
}

async function seed(opts: { allProperties?: boolean } = {}): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUid, landlordId } = await seedLandlord(client)
    const propAId = await seedProperty(client, { landlordId, ownerUserId: ownerUid, managedByUserId: ownerUid })
    const propBId = await seedProperty(client, { landlordId, ownerUserId: ownerUid, managedByUserId: ownerUid })
    const unitAId = await seedUnit(client, { propertyId: propAId, landlordId })
    // S527: lease-free unit — active leases now block reservations, so the
    // reservation-create tests need a unit without the fixture lease below.
    const unitA2Id = await seedUnit(client, { propertyId: propAId, landlordId })
    const unitBId = await seedUnit(client, { propertyId: propBId, landlordId })

    const seedBooking = async (unitId: string, guest: string) => {
      const { rows: [{ id }] } = await client.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type,
           check_in, check_out, nights, total_amount, platform_fee, source)
         VALUES ($1, $2, $3, 'nightly', CURRENT_DATE + 2, CURRENT_DATE + 5, 3, 300, 15, 'direct')
         RETURNING id`, [unitId, landlordId, guest])
      return id
    }
    const bookingAId = await seedBooking(unitAId, 'Guest A')
    const bookingBId = await seedBooking(unitBId, 'Guest B')

    // Unpaid invoice per unit → one balance row per property.
    const tenantId = await seedTenant(client)
    for (const unitId of [unitAId, unitBId]) {
      const leaseId = await seedLease(client, { unitId, landlordId })
      await client.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
           due_date, total_amount, status)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE - 10, 500, 'pending')`,
        [landlordId, tenantId, leaseId, unitId, `INV-${unitId.slice(0, 8)}`])
    }

    const desk = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Front', 'Desk', TRUE) RETURNING id`,
      [`desk-${landlordId.slice(0, 8)}@test.dev`])
    await client.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3, $4)`,
      [desk.rows[0].id, landlordId, opts.allProperties ? [] : [propAId], !!opts.allProperties])
    await client.query('COMMIT')

    const sign = (claims: any) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordId, propAId, propBId, unitAId, unitA2Id, unitBId, bookingAId, bookingBId,
      ownerToken: sign({ userId: ownerUid, role: 'landlord', email: 'o@t.dev', profileId: landlordId, permissions: {} }),
      deskToken:  sign({ userId: desk.rows[0].id, role: 'onsite_manager', email: 'd@t.dev',
                         profileId: desk.rows[0].id, landlordId, permissions: FRONT_DESK_PERMS }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('schedule/master — catalog keys + property scope', () => {
  it('front-desk catalog keys grant access (pre-S526 fix these 403d)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
  })

  it('scoped worker only sees units + bookings at their property', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    const unitIds = (res.body.data.units as any[]).map(u => u.id)
    expect(unitIds).toContain(f.unitAId)
    expect(unitIds).not.toContain(f.unitBId)
    const bookingIds = (res.body.data.bookings as any[]).map(b => b.id)
    expect(bookingIds).toContain(f.bookingAId)
    expect(bookingIds).not.toContain(f.bookingBId)
  })

  it('owner sees landlord-wide', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    const unitIds = (res.body.data.units as any[]).map(u => u.id)
    expect(unitIds).toContain(f.unitAId)
    expect(unitIds).toContain(f.unitBId)
  })

  it('all_properties worker sees landlord-wide', async () => {
    const f = await seed({ allProperties: true })
    const res = await request(buildApp())
      .get('/api/units/schedule/master')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    const unitIds = (res.body.data.units as any[]).map(u => u.id)
    expect(unitIds).toContain(f.unitBId)
  })
})

describe('GET /bookings — property scope', () => {
  it('scoped worker only sees their property’s reservations', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    const ids = (res.body.data as any[]).map(b => b.id)
    expect(ids).toContain(f.bookingAId)
    expect(ids).not.toContain(f.bookingBId)
  })

  it('worker WITHOUT bookings.view → 403 (read gate added S526)', async () => {
    const f = await seed()
    const noPerm = jwt.sign(
      { userId: randomUUID(), role: 'onsite_manager', email: 'n@t.dev',
        profileId: f.landlordId, landlordId: f.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${noPerm}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /balances — property scope + landlordId resolution', () => {
  it('scoped worker only sees balances at their property (and the worker landlordId resolves — pre-S526 this was empty)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/balances')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    const propIds = (res.body.data as any[]).map(r => r.property_id)
    expect(propIds).toContain(f.propAId)
    expect(propIds).not.toContain(f.propBId)
  })

  it('owner sees balances landlord-wide', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/balances')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    const propIds = (res.body.data as any[]).map(r => r.property_id)
    expect(propIds).toContain(f.propAId)
    expect(propIds).toContain(f.propBId)
  })
})

describe('schedule/history — property scope', () => {
  it('scoped worker only sees events at their property', async () => {
    const f = await seed()
    // Booking events are best-effort in the route; seed rows directly.
    for (const [unitId, bookingId] of [[f.unitAId, f.bookingAId], [f.unitBId, f.bookingBId]] as const) {
      await db.query(
        `INSERT INTO unit_booking_events (booking_id, unit_id, landlord_id, event_type, summary)
         VALUES ($1, $2, $3, 'created', 'seeded')`,
        [bookingId, unitId, f.landlordId])
    }
    const res = await request(buildApp())
      .get('/api/units/schedule/history')
      .set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    const unitNumbers = res.body.data as any[]
    expect(unitNumbers.length).toBe(1)
  })
})

describe('reservation writes — property lock', () => {
  it('scoped worker cannot create a reservation on the other property', async () => {
    const f = await seed()
    const withCreate = jwt.sign(
      { userId: (jwt.decode(f.deskToken) as any).userId, role: 'onsite_manager', email: 'd@t.dev',
        profileId: f.landlordId, landlordId: f.landlordId,
        permissions: { ...FRONT_DESK_PERMS, 'schedule.create_reservation': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post(`/api/units/${f.unitBId}/bookings`)
      .set('Authorization', `Bearer ${withCreate}`)
      .send({ guestName: 'X', leaseType: 'nightly', checkIn: '2027-01-01', checkOut: '2027-01-03' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not assigned to this property/i)
  })

  it('scoped worker CAN create a reservation on their own property', async () => {
    const f = await seed()
    const withCreate = jwt.sign(
      { userId: (jwt.decode(f.deskToken) as any).userId, role: 'onsite_manager', email: 'd@t.dev',
        profileId: f.landlordId, landlordId: f.landlordId,
        permissions: { ...FRONT_DESK_PERMS, 'schedule.create_reservation': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post(`/api/units/${f.unitA2Id}/bookings`)
      .set('Authorization', `Bearer ${withCreate}`)
      .send({ guestName: 'X', leaseType: 'nightly', checkIn: '2027-01-01', checkOut: '2027-01-03' })
    expect(res.status).toBe(201)
  })
})
