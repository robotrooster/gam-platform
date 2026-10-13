/**
 * 10/12 (Nic, G6): a stay shortened past rent a payment was tried on — the
 * landlord CHOOSES, at the moment they shorten it, on the schedule (Edit or
 * drag) and in the Check out window: take those charges off, or keep them
 * owed. Asked before anything is saved ('stay_shortened_attempted'), answered
 * with `pastEndAttempted`, carried out by the lease sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel, retrieve: async (id: string) => ({ id }) } }),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedAllocationRule } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { unitsRouter } from './units'
import { stayCheckOutRouter } from './stayCheckOut'
import { STAY_SHORTENED_CHOSEN_VOID_REASON } from '../services/bookingLeaseBilling'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/units', stayCheckOutRouter)
  a.use('/api/units', unitsRouter)
  a.use(errorHandler)
  return a
}

const NOW = new Date('2026-10-03T03:00:00Z')   // Oct 2 in Phoenix
const settle = () => new Promise(r => setTimeout(r, 300))

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stay_shortened'
  stripeCancel.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

/** A Sep 1 – Dec 1 stay on a signed lease; Sep and Oct paid; November's bank pull bounced. */
async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix', timezone_source = 'manual' WHERE id = $1`, [propertyId])
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(`UPDATE units SET lease_types_allowed = '{}', is_bookable = TRUE, nightly_rate = 60, weekly_rate = 350, monthly_rate = 1500 WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const stay = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights, total_amount, platform_fee,
                                  status, source, booked_check_out)
       VALUES ($1,$2,'Pat Ruiz','month_to_month','2026-09-01','2026-12-01',91,4500,0,'checked_in','direct','2026-12-01') RETURNING id`,
      [landlordId, unitId])).rows[0].id
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, lease_source, source_booking_id)
       VALUES ($1,$2,1500,'fixed_term','active','2026-09-01','2026-12-01','booking_draft',$3) RETURNING id`,
      [unitId, landlordId, stay])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    await c.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',1500,'settled','RENT','2026-09-01', now()),
              ($1,$2,$3,$4,'rent',1500,'settled','RENT','2026-10-01', now())`, [unitId, tenantId, landlordId, leaseId])
    const nov = (await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',1500,'failed','RENT','2026-11-01','pi_nov_bounced') RETURNING id`,
      [unitId, tenantId, landlordId, leaseId])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, unitId, stay, leaseId, nov, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('the schedule: shortening a stay past rent a bank pull bounced on', () => {
  it('asks first, saves nothing; answered "take it off", the rent is voided as the landlord chose', async () => {
    const f = await seed()
    const first = await request(app()).patch(`/api/units/${f.unitId}/bookings/${f.stay}`)
      .set('Authorization', `Bearer ${f.token}`).send({ checkOut: '2026-10-20' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ code: 'stay_shortened_attempted' })
    expect(first.body.charges).toEqual([expect.objectContaining({ paymentId: f.nov, dueDate: '2026-11-01', amount: 1500, paymentTried: true })])
    expect(first.body.choices).toEqual({ void: 'Take those charges off', keep: 'Keep them owed' })
    // Nothing was saved.
    expect((await db.query<any>(`SELECT to_char(check_out, 'YYYY-MM-DD') AS d FROM unit_bookings WHERE id = $1`, [f.stay])).rows[0].d).toBe('2026-12-01')

    const second = await request(app()).patch(`/api/units/${f.unitId}/bookings/${f.stay}`)
      .set('Authorization', `Bearer ${f.token}`).send({ checkOut: '2026-10-20', pastEndAttempted: 'void' })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    await settle()
    const row = (await db.query<any>(`SELECT status, void_reason FROM payments WHERE id = $1`, [f.nov])).rows[0]
    expect(row).toEqual({ status: 'voided', void_reason: STAY_SHORTENED_CHOSEN_VOID_REASON })
    const choice = (await db.query<any>(`SELECT choice, chosen_by, applied_at IS NOT NULL AS applied FROM stay_shortened_charge_choices`)).rows
    expect(choice).toEqual([{ choice: 'void', chosen_by: f.userId, applied: true }])
  })

  it('an answer that is not one of the two is asked again', async () => {
    const f = await seed()
    const r = await request(app()).patch(`/api/units/${f.unitId}/bookings/${f.stay}`)
      .set('Authorization', `Bearer ${f.token}`).send({ checkOut: '2026-10-20', pastEndAttempted: 'maybe' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('stay_shortened_attempted')
  })
})

describe('the Check out window', () => {
  it('shows the question with the charges, and refuses a check-out without an answer', async () => {
    const f = await seed()
    const q = await request(app()).get(`/api/units/${f.unitId}/bookings/${f.stay}/check-out?leftOn=2026-10-02`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.pastEndAttempted).toMatchObject({ charges: [expect.objectContaining({ paymentId: f.nov })] })
    expect(q.body.data.pastEndAttempted.words).toContain('The stay now ends October 2, 2026')

    const r = await request(app()).post(`/api/units/${f.unitId}/bookings/${f.stay}/check-out`)
      .set('Authorization', `Bearer ${f.token}`).send({ leftOn: '2026-10-02', choice: null, quoteToken: q.body.data.quoteToken, idempotencyKey: 'k1' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('stay_shortened_attempted')
    expect((await db.query(`SELECT 1 FROM stay_shortened_charge_choices`)).rowCount).toBe(0)

    // Answered: the answer is written before the check-out ends the lease.
    await request(app()).post(`/api/units/${f.unitId}/bookings/${f.stay}/check-out`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leftOn: '2026-10-02', choice: null, quoteToken: q.body.data.quoteToken, idempotencyKey: 'k2', pastEndAttempted: 'keep' })
    const choice = (await db.query<any>(`SELECT choice, to_char(new_check_out, 'YYYY-MM-DD') AS d FROM stay_shortened_charge_choices`)).rows
    expect(choice).toEqual([{ choice: 'keep', d: '2026-10-02' }])
  })
})
