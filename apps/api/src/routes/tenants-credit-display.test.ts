/**
 * S655 (money plan, Step 11) — the credit a landlord sees beside a balance.
 *
 * Nic (10/2): "landlord screens show the full balance with 'credit available
 * $X' beside it." The tenant page showed one figure, the paid-ahead money, and
 * nothing for credit the landlord had given, and nothing for what of it could
 * actually pay their bills. Two figures now: everything on the account, and
 * what would pay the bill right now (the household plan the tenant's Pay Now
 * and the desk offer). They differ — a monthly draw cap, a home payment credit
 * never pays, a credit tied to one lease.
 *
 * Also the lease's monthly draw (PATCH /api/leases/:id/prepaid-draw): raising
 * it can make the paid-ahead money cover the whole bill, which then pays itself
 * (Nic: credit applies by itself only when it covers the WHOLE bill).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { PoolClient } from 'pg'

const sendPaymentReceipt = vi.hoisted(() => vi.fn(async () => 'msg_test'))
vi.mock('../services/paymentReceipt', () => ({ sendPaymentReceipt }))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_credit_display'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sendPaymentReceipt.mockClear()
})

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function household() {
  return tx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 589 })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    const rent = (await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',589,'pending',date_trunc('month', CURRENT_DATE)::date,'RENT') RETURNING id`,
      [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
    return { ...ll, propertyId, unitId, leaseId, tenantId, rent }
  })
}

const ownerToken = (h: { userId: string; landlordId: string }) => jwt.sign(
  { userId: h.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds: [h.landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

/** An on-site worker; `propertyIds` locks them to those parks (omitted: every park). */
async function staffToken(h: { landlordId: string }, permissions: Record<string, boolean>, propertyIds?: string[]) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Desk','Clerk',TRUE) RETURNING id`, [`desk-${Date.now()}-${Math.random()}@t.dev`])
  await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,$3,$4)`,
    [u.rows[0].id, h.landlordId, !propertyIds, propertyIds ?? []])
  return jwt.sign(
    { userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', profileId: null, landlordId: h.landlordId, permissions },
    process.env.JWT_SECRET!, { expiresIn: '10m' })
}

const profile = (tenantId: string, token: string) =>
  request(buildApp()).get(`/api/tenants/${tenantId}/profile`).set('Authorization', `Bearer ${token}`)

describe('the tenant page shows total credit and usable credit', () => {
  it('the tenant page shows total credit and usable credit', async () => {
    const h = await household()
    // $2,000 paid ahead, but the lease draws only $200 a month; plus $50 from the landlord.
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [h.leaseId, h.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id = $1`, [h.leaseId])
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
                    VALUES ($1,$2,NULL,50,50,'goodwill','test','active')`, [h.landlordId, h.tenantId])
    const res = await profile(h.tenantId, ownerToken(h))
    expect(res.status).toBe(200)
    expect(res.body.data.credit).toEqual({
      total: 2050, usable: 250, paidAhead: 2000, fromLandlord: 50, depositInterest: 0,
    })
    expect(res.body.data.paidAhead).toBe(2000)
  })

  it('a withdrawn paid-ahead credit is in neither figure', async () => {
    const h = await household()
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, voided_at, void_reason)
                    VALUES ($1,$2,80,80,'landlord',NOW(),'undone bank deposit')`, [h.leaseId, h.tenantId])
    const res = await profile(h.tenantId, ownerToken(h))
    expect(res.body.data.credit).toMatchObject({ total: 0, usable: 0 })
    expect(res.body.data.paidAhead).toBe(0)
  })

  it('paid-ahead money a card dispute of its own funding still claims is not shown as paid ahead', async () => {
    const h = await household()
    // $300 paid ahead by card; the cardholder disputed $100 of that charge.
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,300,0,300,'settled','card','pi_td_claim',NOW()) RETURNING id`,
      [h.tenantId, h.leaseId, h.landlordId])).rows[0].id
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, source_remittance_id, received_at)
                    VALUES ($1,$2,300,300,'gam',$3,NOW())`, [h.leaseId, h.tenantId, rem])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
       VALUES ('dp_td_claim','ch_td_claim','pi_td_claim',$1,100,'needs_response')`, [h.landlordId])
    const res = await profile(h.tenantId, ownerToken(h))
    expect(res.status).toBe(200)
    expect(res.body.data.paidAhead).toBe(200)
    expect(res.body.data.credit).toMatchObject({ total: 200, paidAhead: 200 })
  })

  it('the Leases page\'s paid ahead leaves out what a dispute of its funding still claims, as the tenant page does', async () => {
    const h = await household()
    const paidAheadByCard = async (amount: number, pi: string) => {
      const rem = (await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                         payment_method, stripe_payment_intent_id, settled_at)
         VALUES ($1,$2,$3,$4,0,$4,'settled','card',$5,NOW()) RETURNING id`,
        [h.tenantId, h.leaseId, h.landlordId, amount, pi])).rows[0].id
      await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, source_remittance_id, received_at)
                      VALUES ($1,$2,$3,$3,'gam',$4,NOW())`, [h.leaseId, h.tenantId, amount, rem])
    }
    const dispute = (id: string, pi: string, amount: number) => db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
       VALUES ($1,$1,$2,$3,$4,'needs_response')`, [id, pi, h.landlordId, amount])
    const leasesPage = async () => {
      const res = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${ownerToken(h)}`)
      expect(res.status).toBe(200)
      const rows = res.body.data ?? res.body
      return Number(rows.find((l: any) => l.id === h.leaseId).prepaid_credit_remaining)
    }
    // $300 paid ahead by card, $100 of it disputed; $50 paid ahead at no dispute.
    await paidAheadByCard(300, 'pi_lp_claim')
    await paidAheadByCard(50, 'pi_lp_clean')
    expect(await leasesPage()).toBe(350)
    await dispute('dp_lp_claim', 'pi_lp_claim', 100)
    expect(await leasesPage()).toBe(250)
    expect((await profile(h.tenantId, ownerToken(h))).body.data.paidAhead).toBe(250)
    // The cardholder disputed the whole charge: none of that $300 is theirs.
    await db.query(`UPDATE connect_disputes SET amount = 300 WHERE stripe_dispute_id = 'dp_lp_claim'`)
    expect(await leasesPage()).toBe(50)
    expect((await profile(h.tenantId, ownerToken(h))).body.data.paidAhead).toBe(50)
  })

  it('paid ahead is the household\'s: money a co-tenant paid ahead on the lease shows on each of their pages', async () => {
    const h = await household()
    const co = await tx(async c => {
      const id = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: h.leaseId, tenantId: id, role: 'co_tenant' })
      return id
    })
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,120,120,'landlord')`, [h.leaseId, co])
    for (const who of [h.tenantId, co]) {
      const res = await profile(who, ownerToken(h))
      expect(res.body.data.paidAhead).toBe(120)
      expect(res.body.data.credit).toMatchObject({ paidAhead: 120 })
    }
  })

  it('the front desk that takes payments sees it; staff who may not see money get no figure', async () => {
    const h = await household()
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
                    VALUES ($1,$2,NULL,30,30,'goodwill','test','active')`, [h.landlordId, h.tenantId])
    const desk = await profile(h.tenantId, await staffToken(h, { take_payment: true }))
    expect(desk.status).toBe(200)
    expect(desk.body.data.credit).toMatchObject({ total: 30, usable: 30 })
    const maint = await profile(h.tenantId, await staffToken(h, {}))
    expect(maint.status).toBe(200)
    expect(maint.body.data.credit).toBeNull()
  })

  it('another company\'s credit never shows on this company\'s page', async () => {
    const h = await household()
    const other = await tx(c => seedLandlord(c))
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
                    VALUES ($1,$2,NULL,500,500,'goodwill','test','active')`, [other.landlordId, h.tenantId])
    const res = await profile(h.tenantId, ownerToken(h))
    expect(res.body.data.credit).toMatchObject({ total: 0, usable: 0 })
  })
})

describe('PATCH /api/leases/:id/prepaid-draw', () => {
  const setDraw = (h: any, monthlyDraw: number | null) => request(buildApp())
    .patch(`/api/leases/${h.leaseId}/prepaid-draw`).set('Authorization', `Bearer ${ownerToken(h)}`).send({ monthlyDraw })

  it('clearing the cap lets paid-ahead money that covers the whole bill pay it', async () => {
    const h = await household()
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [h.leaseId, h.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id = $1`, [h.leaseId])
    const res = await setDraw(h, null)
    expect(res.status).toBe(200)
    expect(res.body.data.paidByCredit).toBe(1)
    const row = await db.query(`SELECT status FROM payments WHERE id = $1`, [h.rent])
    expect(row.rows[0].status).toBe('settled')
    expect(res.body.data.creditAvailable).toBe(0)            // nothing left owing for it to pay
  })

  it('a lower cap settles nothing and says what the credit would pay now', async () => {
    const h = await household()
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [h.leaseId, h.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 300 WHERE id = $1`, [h.leaseId])
    const res = await setDraw(h, 150)
    expect(res.status).toBe(200)
    expect(res.body.data.paidByCredit).toBe(0)
    expect(res.body.data.creditAvailable).toBe(150)
    const row = await db.query(`SELECT status FROM payments WHERE id = $1`, [h.rent])
    expect(row.rows[0].status).toBe('pending')
  })

  it('a front desk locked to one property cannot change the monthly draw of a lease at another, and nothing is settled', async () => {
    const h = await household()
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [h.leaseId, h.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [h.leaseId])
    const otherPark = await tx(c => seedProperty(c, { landlordId: h.landlordId, ownerUserId: h.userId, managedByUserId: h.userId }))
    const patch = (token: string) => request(buildApp())
      .patch(`/api/leases/${h.leaseId}/prepaid-draw`).set('Authorization', `Bearer ${token}`).send({ monthlyDraw: null })

    // Locked to the other park: refused, the limit the landlord set stands, the bill stays open.
    const elsewhere = await patch(await staffToken(h, { take_payment: true }, [otherPark]))
    expect(elsewhere.status).toBe(403)
    expect(elsewhere.body.error ?? elsewhere.body.message).toMatch(/a property you do not work at/)
    expect((await db.query(`SELECT prepaid_monthly_draw::text AS cap FROM leases WHERE id = $1`, [h.leaseId])).rows[0].cap).toBe('100.00')
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [h.rent])).rows[0].status).toBe('pending')

    // Locked to this lease's park: allowed.
    const here = await patch(await staffToken(h, { take_payment: true }, [h.propertyId]))
    expect(here.status).toBe(200)
    expect(here.body.data.paidByCredit).toBe(1)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [h.rent])).rows[0].status).toBe('settled')
  })

  it('staff with every property may still change the monthly draw', async () => {
    const h = await household()
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 300 WHERE id = $1`, [h.leaseId])
    const res = await request(buildApp())
      .patch(`/api/leases/${h.leaseId}/prepaid-draw`)
      .set('Authorization', `Bearer ${await staffToken(h, { take_payment: true })}`).send({ monthlyDraw: 150 })
    expect(res.status).toBe(200)
    expect(res.body.data.monthlyDraw).toBe(150)
  })

  it('a raised cap that still does not cover the whole bill settles nothing (credit never pays part of a bill by itself)', async () => {
    const h = await household()
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [h.leaseId, h.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [h.leaseId])
    const res = await setDraw(h, 400)
    expect(res.body.data.paidByCredit).toBe(0)
    expect(res.body.data.creditAvailable).toBe(400)
    const row = await db.query(`SELECT status FROM payments WHERE id = $1`, [h.rent])
    expect(row.rows[0].status).toBe('pending')
  })
})
