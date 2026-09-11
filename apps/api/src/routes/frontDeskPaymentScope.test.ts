/**
 * S641 (Nic) — what the front desk sees on the Payments tab.
 *
 *   "I don't want her seeing the histories at all… You have payment history,
 *    covered by work trade and outstanding balances [on one tab]. The
 *    outstanding balances section of the payments tab is where you have to
 *    record a payment. My front desk needs to be able to record the damn
 *    payment."
 *
 * The tab was BLANK for her: the page renders three sections from one query and
 * that query returned an empty array to anybody without payments.view_all. So
 * `payments.view` is now the narrow grant it always read like — money still to
 * collect, and nothing else.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentsRouter)
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_front_desk'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })

    // One rent row per lease per due date — ux_payments_rent_idempotent is what
    // stops a cycle being billed twice, so each of these is its own month.
    const mk = async (type: string, amount: number, status: string, suspended: boolean, monthsAgo: number) =>
      c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'RENT',CURRENT_DATE - ($9::int || ' months')::interval,$8)`,
        [ll.landlordId, unitId, leaseId, tenantId, type, amount, status,
         suspended ? new Date() : null, monthsAgo])

    await mk('rent', 460, 'pending', false, 0)   // owed — she must see this
    await mk('rent', 500, 'settled', false, 1)   // history — she must not
    await mk('rent', 300, 'pending', true,  2)   // work trade — she must not

    // the front desk user
    const fd = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
      [`fd-${Math.random().toString(36).slice(2)}@test.dev`])
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [fd.rows[0].id, ll.landlordId, [propertyId],
       JSON.stringify({ 'payments.view': true, 'balances.view': true, take_payment: true })])
    await c.query('COMMIT')

    const sign = (uid: string, role: string, perms: any, lid: string | null) => jwt.sign(
      { userId: uid, role, email: 'x@t.dev', profileId: role === 'landlord' ? lid : null,
        landlordId: ll.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    return {
      ll, tenantId, propertyId,
      ownerToken: sign(ll.userId, 'landlord', {}, ll.landlordId),
      deskToken: sign(fd.rows[0].id, 'onsite_manager',
        { 'payments.view': true, 'balances.view': true, take_payment: true }, null),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('the front desk Payments tab', () => {
  it('is no longer blank — the money still to collect comes back', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
  })

  it('shows ONLY what is owed — no settled history, no work trade', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.deskToken}`)
    const amounts = res.body.data.map((p: any) => Number(p.amount)).sort()
    expect(amounts).toEqual([460])
  })

  it('the owner still sees everything', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.ownerToken}`)
    const amounts = res.body.data.map((p: any) => Number(p.amount)).sort((a: number, b: number) => a - b)
    expect(amounts).toEqual([300, 460, 500])
  })

  it('a staff member with neither grant still gets nothing', async () => {
    const f = await seed()
    const bare = jwt.sign(
      { userId: '00000000-0000-0000-0000-000000000001', role: 'onsite_manager',
        email: 'x@t.dev', landlordId: f.ll.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${bare}`)
    expect(res.body.data).toEqual([])
  })
})

describe('work trade stays private on the balances screen', () => {
  it('the figure is withheld from the front desk, not merely hidden on screen', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/balances/${f.tenantId}/invoices`).set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    for (const inv of res.body.data) {
      expect(inv).not.toHaveProperty('work_trade_credit_amount')
      expect(inv).not.toHaveProperty('workTradeCreditAmount')
    }
  })

  it('the owner still gets it', async () => {
    const f = await seed()
    // An invoice belongs to a lease OR a service agreement, never neither.
    await db.query(
      `INSERT INTO invoices (landlord_id, tenant_id, unit_id, lease_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status, work_trade_credit_amount)
       SELECT $1, $2, u.id, l.id, 'INV-WT1', CURRENT_DATE, 460, 460, 'pending', 100
         FROM units u JOIN leases l ON l.unit_id = u.id
        WHERE u.property_id = $3 LIMIT 1`,
      [f.ll.landlordId, f.tenantId, f.propertyId])
    const res = await request(buildApp())
      .get(`/api/balances/${f.tenantId}/invoices`).set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.some((i: any) => i.work_trade_credit_amount !== undefined)).toBe(true)
  })
})
