/**
 * S654 — the landlord's "send a balance reminder" email carries the same Pay
 * now link as the bill.
 *
 * The bill's link signs the resident in with just their password (opening it
 * from their own inbox is the proof the emailed code exists for). The reminder
 * built its own plain /payments link, so a resident who tapped it was still
 * sent off to find a code. The landlord agent's send_balance_reminder calls
 * this same route, so it is covered here too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const { emailBalanceDueSpy } = vi.hoisted(() => ({
  emailBalanceDueSpy: vi.fn(async (..._args: any[]) => 'msg_reminder' as string | null),
}))
// Capture the link instead of mailing it; every other sender stays real.
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBalanceDue: emailBalanceDueSpy }
})

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
} from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { verifyEmailFactorToken } from './emailOtp'
import { portalLink } from '../lib/portalUrls'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBalanceDueSpy.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_balance_reminder'
})

async function seedOwing() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
    const tenantEmail = `pat-${randomUUID()}@mailer-test.co`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',CURRENT_DATE)`,
      [ll.landlordId, unitId, leaseId, tenantId])
    const tenantUserId = (await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return { ...ll, tenantId, tenantUserId, tenantEmail }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

function remind(f: { userId: string; landlordId: string; tenantId: string }) {
  const token = jwt.sign(
    { userId: f.userId, role: 'landlord', email: 'll@t.dev',
      profileId: f.landlordId, landlordIds: [f.landlordId], permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return request(buildApp())
    .post(`/api/landlords/me/tenants/${f.tenantId}/balance-reminder`)
    .set('Authorization', `Bearer ${token}`)
}

describe('POST /api/landlords/me/tenants/:tenantId/balance-reminder', () => {
  it('the Pay now link vouches for the resident\'s own login and lands on Payments', async () => {
    const f = await seedOwing()
    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data.sent).toBe(true)
    expect(emailBalanceDueSpy).toHaveBeenCalledTimes(1)

    const [to, args] = emailBalanceDueSpy.mock.calls[0] as [string, { portalUrl: string; total: number }]
    expect(to).toBe(f.tenantEmail)                  // mailed to the address the token is bound to
    expect(args.total).toBe(460)
    expect(args.portalUrl.startsWith(portalLink('tenant', 'login?ef='))).toBe(true)
    const u = new URL(args.portalUrl)
    expect(u.searchParams.get('to')).toBe('/payments')
    expect(verifyEmailFactorToken(u.searchParams.get('ef')!))
      .toEqual({ userId: f.tenantUserId, email: f.tenantEmail })
  })

  it('the token is the tenant\'s, never the landlord\'s who pressed send', async () => {
    const f = await seedOwing()
    await remind(f)
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { portalUrl: string }]
    const vouched = verifyEmailFactorToken(new URL(args.portalUrl).searchParams.get('ef')!)
    expect(vouched?.userId).not.toBe(f.userId)
  })

  it('nothing owed: no email, so no link goes out at all', async () => {
    const f = await seedOwing()
    await db.query(`UPDATE payments SET status = 'settled' WHERE tenant_id = $1`, [f.tenantId])
    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data.sent).toBe(false)
    expect(emailBalanceDueSpy).not.toHaveBeenCalled()
  })
})

// ── S654: paid-ahead credit is spent bill by bill, as in the portal ────────
//
// The reminder read the paid-ahead draw for the OLDEST bill's month only and
// took it off the whole total. With a $100 monthly draw over a September and
// an October bill that is $100 off, while the portal and the charge take $100
// from each month: the email asked $820 when the resident owed $720.
describe('S654: the reminder\'s figure is the portal\'s figure', () => {
  async function seedBills(f: { landlordId: string; tenantId: string }, leaseId: string, unitId: string,
                           bills: [string, number][]) {
    let n = 0
    for (const [due, amount] of bills) {
      const inv = await db.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
        [f.landlordId, f.tenantId, leaseId, unitId, `INV-REM-${randomUUID().slice(0, 8)}-${++n}`, due, amount])
      await db.query(
        `INSERT INTO payments (invoice_id, landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending','RENT',$7)`,
        [inv.rows[0].id, f.landlordId, unitId, leaseId, f.tenantId, amount, due])
    }
  }
  async function seedResident() {
    const c = await db.connect()
    try {
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
      const tenantId = await seedTenant(c, { email: `res-${randomUUID()}@mailer-test.co` })
      await seedLeaseTenant(c, { leaseId, tenantId })
      return { ...ll, unitId, leaseId, tenantId }
    } finally { c.release() }
  }

  it('a $100 monthly draw over two open bills takes $100 off each: $720, not $820', async () => {
    const f = await seedResident()
    await seedBills(f, f.leaseId, f.unitId, [['2026-09-01', 460], ['2026-10-01', 460]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
                    VALUES ($1,$2,1000,1000)`, [f.leaseId, f.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [f.leaseId])

    const res = await remind(f)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sent: true, total: 720, prepaidApplied: 200, creditApplied: 0 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { total: number; creditApplied: number }]
    expect(args.total).toBe(720)
    expect(args.creditApplied).toBe(200)
  })

  it('paid-ahead first, then the landlord\'s credit; a payment already in flight is not owed', async () => {
    const f = await seedResident()
    await seedBills(f, f.leaseId, f.unitId, [['2026-10-01', 460]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
                    VALUES ($1,$2,10,10)`, [f.leaseId, f.tenantId])
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
                    VALUES ($1,$2,$3,50,50,'goodwill')`, [f.landlordId, f.tenantId, f.leaseId])
    // A card payment already started on an older row: in flight, not owed.
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'utility',75,'pending','UTILITY','2026-09-15','pi_in_flight')`,
      [f.landlordId, f.unitId, f.leaseId, f.tenantId])

    const res = await remind(f)
    expect(res.body.data).toMatchObject({ sent: true, total: 400, prepaidApplied: 10, creditApplied: 50, lines: 1 })
  })

  it('another landlord\'s charges and credit stay out of this landlord\'s reminder', async () => {
    const mine = await seedResident()
    const theirs = await seedResident()
    // The same resident also rents from the other landlord.
    const c = await db.connect()
    let theirLease: string
    try {
      theirLease = await seedLease(c, { unitId: theirs.unitId, landlordId: theirs.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: theirLease, tenantId: mine.tenantId })
    } finally { c.release() }
    await seedBills({ landlordId: theirs.landlordId, tenantId: mine.tenantId }, theirLease!, theirs.unitId, [['2026-08-01', 300]])
    await db.query(`INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
                    VALUES ($1,$2,NULL,200,200,'goodwill')`, [theirs.landlordId, mine.tenantId])
    await seedBills(mine, mine.leaseId, mine.unitId, [['2026-10-01', 460]])

    const res = await remind(mine)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sent: true, total: 460, creditApplied: 0, lines: 1 })
    const [, args] = emailBalanceDueSpy.mock.calls[0] as [string, { lines: any[] }]
    expect(args.lines).toHaveLength(1)
  })
})

