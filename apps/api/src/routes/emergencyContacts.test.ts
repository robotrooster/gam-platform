/**
 * S640 — the emergency contact list the front desk works from.
 *
 * Nic: "one lady, Carine Covarrubius, has her daughter, Irma, as an emergency
 * contact. She didn't put the phone number down. Irma is also a tenant... what
 * if two or three other people have the same person as an emergency contact?"
 *
 * Both cases are real at Mountain View. These test the two things that make the
 * page worth opening: a number we can offer for a contact who named nobody
 * reachable, and knowing when one person is the call for several households.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { emergencyContactsRouter } from './emergencyContacts'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/emergency-contacts', emergencyContactsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_ec'
})

interface Fx {
  ownerToken: string; deskToken: string; strangerToken: string
  landlordId: string; propertyId: string
  coreenTenantId: string; irmaUserId: string
}

/** Coreen in MH 13 with "Irma Fuentes" and no number; Irma reachable elsewhere. */
async function seed(): Promise<Fx> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: ownerId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: ownerId, managedByUserId: ownerId })

    const mkTenant = async (first: string, last: string, phone: string | null) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, phone)
         VALUES ($1,'x','tenant',$2,$3,TRUE,$4) RETURNING id`,
        [`ec-${randomUUID()}@t.dev`, first, last, phone])
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      return { userId: u.rows[0].id, tenantId: t.rows[0].id }
    }
    const house = async (tenantId: string, rent: number) => {
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: rent })
      const l = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,$3,'month_to_month','active', CURRENT_DATE - 30) RETURNING id`,
        [unitId, landlordId, rent])
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`,
        [l.rows[0].id, tenantId])
    }

    const coreen = await mkTenant('Coreen', 'Covarrubias', null)
    const irma   = await mkTenant('Irma', 'Fuentes', '5202043181')
    const bret   = await mkTenant('Bret', 'Robinson', null)
    await house(coreen.tenantId, 460)
    await house(bret.tenantId, 460)
    // Irma is in the system but holds no current lease — which is why the match
    // has to search users rather than active tenants.

    // Coreen's lease said "Irma Fuentes". Bret's said so too, so one person is
    // the emergency contact for two households.
    for (const t of [coreen.tenantId, bret.tenantId]) {
      await c.query(
        `INSERT INTO emergency_contacts (tenant_id, name, raw_text, source, sort_order)
         VALUES ($1, 'Irma Fuentes', 'Irma Fuentes', 'lease', 0)`, [t])
    }
    // The desk person is a real onsite_manager with a real scope row — that is
    // what getScopedPropertyIds reads, and a token alone would have shown them
    // nothing.
    const desk = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
      [`desk-${randomUUID()}@t.dev`])
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
       VALUES ($1,$2,$3,FALSE,$4)`,
      [desk.rows[0].id, landlordId, [propertyId], JSON.stringify({ 'front_desk.view': true })])
    await c.query('COMMIT')

    const sign = (userId: string, perms: any, role: string, claims: any) => jwt.sign(
      { userId, role, email: 'x@t.dev', permissions: perms, ...claims },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    // A different account entirely, with its OWN landlord id. Signing the
    // stranger with this fixture's landlordIds would have tested nothing.
    const stranger = await (async () => {
      const s = await getClient()
      try {
        await s.query('BEGIN')
        const other = await seedLandlord(s)
        await s.query('COMMIT')
        return sign(other.userId, {}, 'landlord', { landlordIds: [other.landlordId] })
      } finally { s.release() }
    })()

    return {
      ownerToken: sign(ownerId, {}, 'landlord', { landlordIds: [landlordId] }),
      deskToken:  sign(desk.rows[0].id, { 'front_desk.view': true }, 'onsite_manager', { landlordId }),
      strangerToken: stranger,
      landlordId, propertyId,
      coreenTenantId: coreen.tenantId, irmaUserId: irma.userId,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

// The harness mounts the router directly, so responses stay snake_case — the
// real API camelizes on the way out. Asserting camelCase here would pass
// against a shape production never returns.
const roster = (token: string) => request(buildApp())
  .get('/api/emergency-contacts').set('Authorization', `Bearer ${token}`)

describe('S640 emergency contact roster', () => {
  it('offers Irma’s number for the contact who named her and left it blank', async () => {
    const f = await seed()
    const res = await roster(f.ownerToken)
    expect(res.status).toBe(200)
    const coreen = res.body.data.find((r: any) => r.tenant_first === 'Coreen')
    expect(coreen.contact_name).toBe('Irma Fuentes')
    expect(coreen.contact_phone).toBeNull()
    expect(coreen.suggestion).toMatchObject({ phone: '5202043181', fromName: 'Irma Fuentes' })
  })

  // Nic asked this one directly. One person being the call for several
  // households is worth surfacing, not deduplicating away.
  it('says when one person is the contact for more than one household', async () => {
    const f = await seed()
    const res = await roster(f.ownerToken)
    const coreen = res.body.data.find((r: any) => r.tenant_first === 'Coreen')
    expect(coreen.shared_with_count).toBe(2)
  })

  it('a front-desk person can read it with nothing but front_desk.view', async () => {
    const f = await seed()
    const res = await roster(f.deskToken)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
  })

  it('another account sees none of it', async () => {
    const f = await seed()
    const res = await roster(f.strangerToken)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

describe('S640 recording one at the counter', () => {
  const put = (token: string, body: any) => request(buildApp())
    .put('/api/emergency-contacts').set('Authorization', `Bearer ${token}`).send(body)

  it('fills in the blank number and marks it confirmed', async () => {
    const f = await seed()
    const res = await put(f.deskToken, {
      tenantId: f.coreenTenantId, name: 'Irma Fuentes', phone: '(520) 204-3181', relationship: 'Daughter',
    })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT phone, relationship, source, confirmed_at FROM emergency_contacts WHERE tenant_id=$1`,
      [f.coreenTenantId])
    expect(rows[0].phone).toBe('5202043181')      // stored as digits, however typed
    expect(rows[0].relationship).toBe('Daughter')
    expect(rows[0].source).toBe('staff')
    expect(rows[0].confirmed_at).not.toBeNull()
  })

  it('refuses a number that is not ten digits rather than storing a stub', async () => {
    const f = await seed()
    const res = await put(f.deskToken, { tenantId: f.coreenTenantId, name: 'Irma', phone: '520-204' })
    expect(res.status).toBe(400)
  })

  it('refuses a blank contact', async () => {
    const f = await seed()
    const res = await put(f.deskToken, { tenantId: f.coreenTenantId, name: '  ', phone: '' })
    expect(res.status).toBe(400)
  })

  // A tenant id is body-supplied, so it is checked against what this caller may
  // see — names and unit numbers repeat across parks.
  it('refuses a tenant belonging to another account', async () => {
    const f = await seed()
    const res = await put(f.strangerToken, { tenantId: f.coreenTenantId, name: 'X', phone: '5205551234' })
    expect(res.status).toBe(404)
  })

  it('confirm marks it current without retyping anything', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/emergency-contacts/confirm').set('Authorization', `Bearer ${f.deskToken}`)
      .send({ tenantId: f.coreenTenantId })
    expect(res.status).toBe(200)
    const { rows } = await db.query<any>(
      `SELECT confirmed_at, name FROM emergency_contacts WHERE tenant_id=$1`, [f.coreenTenantId])
    expect(rows[0].confirmed_at).not.toBeNull()
    expect(rows[0].name).toBe('Irma Fuentes')   // untouched
  })
})
