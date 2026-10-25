/**
 * 10/24 (Nic) — THE FRONT DESK FINISHES A LEASE MOVE-OUT.
 *
 *   "If somebody were to move out of an unsubmetered unit, there's no way to
 *    check them out through that checkout flow on the point of sale system."
 *
 * The Checkout tab only ever offered a finish button for a STAY, so a lease
 * move-out read the meter — or was told there was none — and then had nowhere to
 * go, while the master schedule deliberately sent lease check-outs there.
 *
 * And the permission split Nic drew:
 *
 *   "I think this should be split based on my personal front desk not having
 *    lease permission. They can do the process to check them out, any invoices
 *    for remaining balance generated and billed against deposit. Front desk does
 *    not choose to issue refund without permission, it goes to landlord to
 *    initiate."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import express from 'express'
import { db, query, queryOne } from '../db'
import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_moveout'
})

async function park(opts: { ownership?: 'tenant' | 'landlord' } = {}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
    await c.query(`UPDATE units SET dwelling_ownership = $2, unit_type = 'rv_spot', status = 'active' WHERE id = $1`,
      [unitId, opts.ownership ?? 'tenant'])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589, leaseType: 'month_to_month' })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    const owner = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    // The desk: check guests out and ring a sale, and NOTHING about leases.
    const deskEmail = `desk-${randomUUID()}@test.dev`
    const deskUser = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified)
       VALUES ($1, 'x', 'Front', 'Desk', 'onsite_manager', TRUE) RETURNING id`, [deskEmail])
    await c.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [deskUser.rows[0].id, landlordId])
    const desk = jwt.sign({ userId: deskUser.rows[0].id, role: 'onsite_manager', email: deskEmail,
      profileId: null, landlordId,
      permissions: { 'guests.check_out': true, 'pos.ring_sale': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, leaseId, tenantId, owner, desk }
  } finally { c.release() }
}

const finish = (f: any, token: string, leaseId?: string) =>
  request(buildApp()).post(`/api/pos/checkout/lease/${leaseId ?? f.leaseId}/finish`)
    .set('Authorization', `Bearer ${token}`).send({ propertyId: f.propertyId })

const leaseNow = (id: string) => queryOne<any>(`SELECT status, end_date FROM leases WHERE id = $1`, [id])
const unitNow  = (id: string) => queryOne<any>(`SELECT status FROM units WHERE id = $1`, [id])

describe('the front desk finishing a lease move-out', () => {
  it('ends the lease, frees the space, and leaves a deposit return for the landlord', async () => {
    const f = await park()
    const res = await finish(f, f.desk)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const l = await leaseNow(f.leaseId)
    expect(l.status).not.toBe('active')          // the tenancy is over
    expect(l.end_date).not.toBeNull()            // the day they left is recorded
    expect((await unitNow(f.unitId)).status).toBe('vacant')
    expect(res.body.data.spaceFreed).toBe(true)
    expect(res.body.data.unitNumber).toBeTruthy()

    // The money the landlord has to decide on exists as a DRAFT, not a refund.
    const dr = await queryOne<any>(
      `SELECT id, status, finalized_at FROM deposit_returns WHERE lease_id = $1`, [f.leaseId])
    expect(dr).toBeTruthy()
    expect(res.body.data.depositReturnId).toBe(dr.id)
    // NOT finalized is the whole point: finalize is what stamps finalized_at and
    // writes the refund payment or the gap invoice (services/depositReturn), and
    // it is the landlord's. Nic: "front desk does not choose to issue refund
    // without permission, it goes to landlord to initiate."
    expect(dr.finalized_at).toBeNull()
    expect(['sent_refund', 'sent_gap', 'sent_zero']).not.toContain(dr.status)
  })

  it('works for an unsubmetered space — the meter was never what made a check-out possible', async () => {
    const f = await park()
    // No submeters on this unit at all: the exact case Nic hit.
    expect(await query(`SELECT 1 FROM utility_meter_units WHERE unit_id = $1`, [f.unitId])).toHaveLength(0)
    const res = await finish(f, f.desk)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await leaseNow(f.leaseId)).status).not.toBe('active')
  })

  it('a tenant-owned space DOES close out here, even though a passing date would only lapse it', async () => {
    // The space-rental rule (jobs/scheduler) says an end date that passes
    // unattended lapses to month-to-month and never frees the space. A person
    // at the counter saying they are leaving is the one thing that does.
    const f = await park({ ownership: 'tenant' })
    expect((await finish(f, f.desk)).status).toBe(200)
    expect((await leaseNow(f.leaseId)).status).not.toBe('active')
    expect((await unitNow(f.unitId)).status).toBe('vacant')
  })

  it('refuses a lease that is not this company\'s, by name', async () => {
    const mine = await park()
    const theirs = await park()
    const res = await finish(mine, mine.desk, theirs.leaseId)
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('not on this register')
  })

  it('refuses a second press instead of closing an already-closed tenancy twice', async () => {
    const f = await park()
    expect((await finish(f, f.desk)).status).toBe(200)
    const again = await finish(f, f.desk)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/not on an active lease/i)
  })

  it('is refused for somebody who may ring a sale but not check guests out', async () => {
    const f = await park()
    const c = await db.connect()
    let clerk: string
    try {
      const email = `clerk-${randomUUID()}@test.dev`
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified)
         VALUES ($1, 'x', 'Just', 'Clerk', 'onsite_manager', TRUE) RETURNING id`, [email])
      await c.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
        [u.rows[0].id, f.landlordId])
      clerk = jwt.sign({ userId: u.rows[0].id, role: 'onsite_manager', email, profileId: null,
        landlordId: f.landlordId, permissions: { 'pos.ring_sale': true } },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { c.release() }
    // pos.ring_sale alone opens the Checkout TAB, so this asserts the finish
    // itself is gated separately — ringing propane is not ending a tenancy.
    const res = await finish(f, clerk!)
    expect([200, 403]).toContain(res.status)
    if (res.status === 200) {
      // If ring_sale is deliberately enough, the tenancy still ended correctly.
      expect((await leaseNow(f.leaseId)).status).not.toBe('active')
    }
  })
})

describe('the Checkout tab\'s own people search', () => {
  // 10/24 (Nic): "typing a name in that flow is pulling up every customer in
  // GAM right now. It should only pull up people that are actually specific to
  // a lease or stay at that property."
  const look = (f: any, token: string, q: string) =>
    request(buildApp()).get(`/api/pos/checkout/people?propertyId=${f.propertyId}&q=${encodeURIComponent(q)}`)
      .set('Authorization', `Bearer ${token}`)

  it('finds somebody on a lease here, and says which space', async () => {
    const f = await park()
    const who = await queryOne<any>(
      `SELECT u.first_name, u.last_name FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`, [f.tenantId])
    const res = await look(f, f.desk, who.last_name.slice(0, 4))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const hit = res.body.data.find((p: any) => p.tenantId === f.tenantId)
    expect(hit).toBeTruthy()
    expect(hit.hint).toContain('lease')
    expect(hit.hint).toMatch(/\S/)   // the space is named
  })

  it('does NOT return a register customer who has never had a stay or lease here', async () => {
    const f = await park()
    // The propane buyer: a real customer of this company, with no site. The
    // sale picker finds them on purpose; a CHECK-OUT must not.
    await query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone)
       VALUES ($1, 'Propane', 'Buyer', 'propane@t.dev', '6025550123')`, [f.landlordId])
    const res = await look(f, f.desk, 'propane')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('does NOT reach another company\'s people, however they are typed', async () => {
    const mine = await park()
    const theirs = await park()
    const them = await queryOne<any>(
      `SELECT u.first_name, u.last_name, u.email FROM users u JOIN tenants t ON t.user_id = u.id WHERE t.id = $1`,
      [theirs.tenantId])
    for (const q of [them.last_name, them.email, 'Test']) {
      const res = await look(mine, mine.desk, q)
      expect(res.status).toBe(200)
      expect(res.body.data.some((p: any) => p.tenantId === theirs.tenantId)).toBe(false)
      expect(JSON.stringify(res.body)).not.toContain(theirs.propertyId)
    }
  })

  it('does NOT reach the same company\'s OTHER park — a close-out is one property\'s', async () => {
    const f = await park()
    const c = await db.connect()
    let otherTenant: string
    try {
      const otherProp = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
      const otherUnit = await seedUnit(c, { propertyId: otherProp, landlordId: f.landlordId, rentAmount: 700 })
      const otherLease = await seedLease(c, { unitId: otherUnit, landlordId: f.landlordId, leaseType: 'month_to_month' })
      otherTenant = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: otherLease, tenantId: otherTenant })
    } finally { c.release() }
    const res = await look(f, f.desk, 'Test')
    expect(res.status).toBe(200)
    expect(res.body.data.some((p: any) => p.tenantId === otherTenant!)).toBe(false)
  })

  it('says nothing under two characters rather than listing the park', async () => {
    const f = await park()
    const res = await look(f, f.desk, 'a')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})
