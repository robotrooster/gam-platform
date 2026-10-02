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
