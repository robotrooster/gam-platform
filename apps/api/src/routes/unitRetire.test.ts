/**
 * S605: retire & replace a unit.
 *
 * The load-bearing assertions are the STRUCTURAL ones — that a retired unit
 * cannot take a lease or a booking no matter which code path tries, because
 * that (not a query filter) is what makes "a retired unit is never billed" true.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { UNIT_CLONE_COPIED, UNIT_CLONE_RESET, unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'
import { findAvailableUnits } from '../services/unitAvailability'

let ctx: { landlordId: string; userId: string; propertyId: string; unitId: string }

function buildApp() {
  const a = express()
  a.use(express.json())
  a.use('/api/units', unitsRouter)
  a.use(errorHandler)
  return a
}
/** Real JWT, same shape as the main units suite — auth runs for real here. */
function token() {
  return jwt.sign(
    { userId: ctx.userId, role: 'landlord', email: 'll@test.dev',
      profileId: ctx.landlordId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

beforeEach(async () => {
  await cleanupAllSchema()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId })
    await client.query('COMMIT')
    ctx = { landlordId: ll.landlordId, userId: ll.userId, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  await query(`UPDATE units SET unit_number='RV 05', rv_amp_service='50', rv_site_layout='back_in',
               nightly_rate=40, weekly_rate=200, security_deposit=350 WHERE id=$1`, [ctx.unitId])
})

const asLandlord = () => buildApp()

describe('POST /api/units/:id/retire', () => {
  it('retires the old unit and creates the replacement, linked both ways', async () => {
    const r = await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`)
      .send({ unitNumber: 'RV 5A', reason: 'renumbered to match new signage' })
      .expect(201)

    const { retired, replacement } = r.body.data
    expect(retired.retired_at).not.toBeNull()
    expect(retired.unit_number).toBe('RV 05')          // history untouched
    expect(replacement.unit_number).toBe('RV 5A')
    expect(replacement.retired_at).toBeNull()
    expect(replacement.status).toBe('vacant')
    // Linked in BOTH directions — the point of the design.
    expect(retired.superseded_by_unit_id).toBe(replacement.id)
    expect(replacement.replaces_unit_id).toBe(ctx.unitId)
  })

  it('the replacement inherits physical + pricing attributes', async () => {
    const r = await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 5A' }).expect(201)
    expect(r.body.data.replacement).toMatchObject({
      rv_amp_service: '50',
      rv_site_layout: 'back_in',
      nightly_rate: '40.00',
      weekly_rate: '200.00',
      security_deposit: '350.00',
      property_id: ctx.propertyId,
      landlord_id: ctx.landlordId,
    })
  })

  it('refuses to reuse the same number, and refuses a number already taken', async () => {
    await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 05' }).expect(400)

    const client = await db.connect()
    try { await seedUnit(client, { propertyId: ctx.propertyId, landlordId: ctx.landlordId }) }
    finally { client.release() }
    const taken = await query<{ unit_number: string }>(
      `SELECT unit_number FROM units WHERE property_id=$1 AND id<>$2`, [ctx.propertyId, ctx.unitId])
    await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: taken[0].unit_number }).expect(409)
  })

  it('refuses while an active lease exists — the tenancy must be settled first', async () => {
    const c = await db.connect()
    try { await seedLease(c, { unitId: ctx.unitId, landlordId: ctx.landlordId, status: 'active' }) }
    finally { c.release() }

    const r = await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 5A' }).expect(409)
    expect(r.body.error).toMatch(/active or pending lease/i)
  })

  it('is refused twice — a retired unit cannot be retired again', async () => {
    await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 5A' }).expect(201)
    await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 5B' }).expect(409)
  })
})

describe('a retired unit is structurally out of service', () => {
  async function retire() {
    const r = await request(asLandlord())
      .post(`/api/units/${ctx.unitId}/retire`).set('Authorization', `Bearer ${token()}`).send({ unitNumber: 'RV 5A' }).expect(201)
    return r.body.data.replacement.id as string
  }

  it('the DB refuses a new lease on it — covering every lease-creation path at once', async () => {
    await retire()
    await expect(query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,440,'fixed_term','active', CURRENT_DATE)`,
      [ctx.unitId, ctx.landlordId])
    ).rejects.toThrow(/retired/i)
  })

  it('the DB refuses a new booking on it', async () => {
    await retire()
    await expect(query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, status, lease_type)
       VALUES ($1,$2, CURRENT_DATE + 5, CURRENT_DATE + 8, 'confirmed', 'nightly')`,
      [ctx.unitId, ctx.landlordId])
    ).rejects.toThrow(/retired/i)
  })

  it('never appears in the availability picker, but its replacement does', async () => {
    const replacementId = await retire()
    const avail = await findAvailableUnits({
      landlordId: ctx.landlordId,
      window: { checkIn: new Date().toISOString().slice(0, 10), checkOut: null, excludeBookingId: null } as any,
    })
    const ids = avail.map((u: any) => u.id)
    expect(ids).not.toContain(ctx.unitId)
    expect(ids).toContain(replacementId)
  })

  it('is hidden from the default unit list, and shown only when asked for', async () => {
    await retire()
    const def = await request(asLandlord()).get('/api/units').set('Authorization', `Bearer ${token()}`).expect(200)
    expect(def.body.data.map((u: any) => u.id)).not.toContain(ctx.unitId)

    const withHistory = await request(asLandlord()).get('/api/units?includeRetired=true').set('Authorization', `Bearer ${token()}`).expect(200)
    const found = withHistory.body.data.find((u: any) => u.id === ctx.unitId)
    expect(found).toBeTruthy()
    expect(found.retired_at).not.toBeNull()
    expect(found.superseded_by_unit_id).toBeTruthy()   // link to its successor
  })

  it('keeps its history — past payments still resolve to the retired record', async () => {
    await retire()
    const rows = await query<{ c: string }>(`SELECT count(*) AS c FROM units WHERE id=$1`, [ctx.unitId])
    expect(Number(rows[0].c)).toBe(1)
  })
})

describe('clone column classification', () => {
  it('every units column is classified as copied or deliberately reset', async () => {
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='units'`)
    const classified = new Set<string>([...UNIT_CLONE_COPIED, ...Object.keys(UNIT_CLONE_RESET)])
    const unclassified = cols.map((c) => c.column_name).filter((c) => !classified.has(c))

    // A new units column must be an explicit decision: copy it onto the
    // replacement, or say why it resets. Silence would mean a physical
    // attribute quietly not carrying over on retire & replace.
    expect(unclassified).toEqual([])
  })
})
