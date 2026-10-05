/**
 * Common-area reservations + amenity alerts (launch feature).
 *
 * Covers: area CRUD scoping, landlord closure → resident fan-out alert,
 * tenant request → landlord pending notification → approve → resident
 * decision + amenity alert (reserving tenant excluded), auto-approve path,
 * overlap-conflict 409, non-resident 403, and window validation.
 *
 * Email layer mocked so createNotification still writes in-app notification
 * rows (which we assert on) without attempting real delivery.
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
// S655: a bank retry the cancel stopped is canceled at Stripe after the commit.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))

import { commonAreasRouter } from './commonAreas'
import { computeReservationFee } from '../services/commonAreas'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_common_areas'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/common-areas', commonAreasRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()

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

// Two-resident property + landlord. Returns ids + tokens.
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
      landlordId, propertyId,
      llToken: token({ userId: llUser, role: 'landlord', profileId: landlordId, landlordId }),
      t1, t1User, t1Token: token({ userId: t1User, role: 'tenant', profileId: t1 }),
      t2, t2User,
    }
  } finally { client.release() }
}

const PLUS = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

// Reservation-flow tests need a *reservable* area (the create default is
// reservable=false — "announce-only" — matching the landlord UI toggle, which
// is off unless the landlord turns it on for a bookable amenity). Default the
// helper to reservable:true; pass reservable:false to exercise announce-only.
async function makeArea(llToken: string, propertyId: string, over: any = {}) {
  const res = await request(app).post('/api/common-areas')
    .set('Authorization', `Bearer ${llToken}`)
    .send({ propertyId, name: 'Clubhouse', reservable: true, ...over })
  return res
}

beforeEach(async () => { await cleanupAllSchema(); stripeCancel.mockClear() })

describe('common areas — management', () => {
  it('landlord creates + lists + updates an area; foreign landlord is blocked', async () => {
    const f = await fixture()
    const create = await makeArea(f.llToken, f.propertyId, { capacity: 30, reservationFee: 50, maxReservationHours: 4 })
    expect(create.status).toBe(201)
    expect(create.body.data.name).toBe('Clubhouse')
    expect(Number(create.body.data.reservation_fee)).toBe(50)

    const list = await request(app).get(`/api/common-areas?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.llToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)

    const patch = await request(app).patch(`/api/common-areas/${create.body.data.id}`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ capacity: 50 })
    expect(patch.status).toBe(200)
    expect(patch.body.data.capacity).toBe(50)

    // a different landlord cannot read this property's areas
    const other = await fixture()
    const blocked = await request(app).get(`/api/common-areas?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${other.llToken}`)
    expect(blocked.status).toBe(403)
  })

  it('a newly-created area is NOT reservable by default (announce-only)', async () => {
    const f = await fixture()
    // No `reservable` in the body → the handler defaults it off, so the area is
    // announce-only and never surfaces in the tenant reservation tab.
    const create = await request(app).post('/api/common-areas')
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ propertyId: f.propertyId, name: 'Laundry room' })
    expect(create.status).toBe(201)
    expect(create.body.data.reservable).toBe(false)
    // A tenant request against an announce-only area is refused.
    const reqRes = await request(app).post(`/api/common-areas/${create.body.data.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(50) })
    expect(reqRes.status).toBe(400)
    expect(reqRes.body.error).toMatch(/not reservable/i)
  })
})

describe('amenity alerts', () => {
  it('landlord maintenance closure goes live and alerts every resident', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const res = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'maintenance_closure', title: 'Chemical treatment', startsAt: PLUS(24), endsAt: PLUS(27) })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('approved')
    // both residents notified (closure has no reserving tenant to exclude)
    expect(await notifCount('amenity_unavailable')).toBe(2)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })

  it('landlord can suppress the resident alert', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'private_rental', startsAt: PLUS(24), endsAt: PLUS(26), notifyResidents: false })
    expect(await notifCount('amenity_unavailable')).toBe(0)
  })
})

describe('tenant request → approval flow', () => {
  it('request lands pending + notifies landlord; approve alerts other residents + the requester', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data // requires_approval default true

    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ title: 'Birthday party', startsAt: PLUS(48), endsAt: PLUS(51), guestCount: 12 })
    expect(reqRes.status).toBe(201)
    expect(reqRes.body.data.status).toBe('pending')
    expect(reqRes.body.data.reserved_by_tenant_id).toBe(f.t1)
    expect(await notifCount('reservation_requested')).toBe(1)

    const decide = await request(app).post(`/api/common-areas/reservations/${reqRes.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: true })
    expect(decide.status).toBe(200)
    expect(decide.body.data.status).toBe('approved')
    // requester gets a decision notice
    expect(await notifCount('reservation_decision', f.t1User)).toBe(1)
    // amenity alert goes to the OTHER resident only (requester excluded)
    expect(await notifCount('amenity_unavailable')).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('reject notifies the requester and fires no amenity alert', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(50) })
    const decide = await request(app).post(`/api/common-areas/reservations/${reqRes.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: false, note: 'Booked for staff event' })
    expect(decide.body.data.status).toBe('rejected')
    expect(await notifCount('reservation_decision', f.t1User)).toBe(1)
    expect(await notifCount('amenity_unavailable')).toBe(0)
  })

  it('auto-approve area: tenant request goes straight to approved + alerts others', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false })).body.data
    const reqRes = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(10), endsAt: PLUS(12) })
    expect(reqRes.body.data.status).toBe('approved')
    expect(await notifCount('reservation_requested')).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })
})

describe('guards', () => {
  it('overlapping approved hold is rejected with 409', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const first = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'event', startsAt: PLUS(24), endsAt: PLUS(28) })
    expect(first.status).toBe(201)
    const overlap = await request(app).post(`/api/common-areas/${area.id}/reservations`)
      .set('Authorization', `Bearer ${f.llToken}`)
      .send({ kind: 'private_rental', startsAt: PLUS(26), endsAt: PLUS(30) })
    expect(overlap.status).toBe(409)
  })

  it('non-resident tenant cannot request', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId)).body.data
    const outsider = await fixture() // a tenant at a different property
    const res = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${outsider.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(50) })
    expect(res.status).toBe(403)
  })

  it('reservation exceeding the hour cap is rejected', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { maxReservationHours: 3 })).body.data
    const res = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(48), endsAt: PLUS(54) })
    expect(res.status).toBe(400)
  })
})

describe('reservation fee charging (#4)', () => {
  const feePayments = (tenantId: string) =>
    db.query(`SELECT id, amount, status FROM payments WHERE tenant_id=$1 AND type='fee'`, [tenantId])

  it('demand pricing: weekend uses weekend_fee, weekday uses base', () => {
    const area = { reservation_fee: 50, weekend_fee: 90 }
    // 2026-06-27 is a Saturday; 2026-06-30 is a Tuesday.
    expect(computeReservationFee(area, '2026-06-27T15:00:00Z')).toBe(90)
    expect(computeReservationFee(area, '2026-06-30T15:00:00Z')).toBe(50)
    expect(computeReservationFee({ reservation_fee: 50, weekend_fee: null }, '2026-06-27T15:00:00Z')).toBe(50)
  })

  it('auto-approved reservation bills the fee as a tenant payment', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })
    expect(r.status).toBe(201)
    const pays = await feePayments(f.t1)
    expect(pays.rows).toHaveLength(1)
    expect(Number(pays.rows[0].amount)).toBe(40)
    expect(r.body.data.fee_payment_id).toBeTruthy()
  })

  it('cancel ≥48h ahead voids an unpaid fee', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await feePayments(f.t1)).rows).toHaveLength(0) // unpaid fee removed
  })

  /** The tenant's fee, bounced: a bank payment was tried on it and turned down. */
  async function bouncedFee(f: any, r: any, o: { pi: string; retryInDays?: number }) {
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id=$2,
              next_retry_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END
        WHERE id=$1`, [r.fee_payment_id, o.pi, o.retryInDays ?? null])
    const rem = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,40,40,0,'failed','ach',$3,0) RETURNING id`, [f.t1, f.landlordId, o.pi])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,40)`,
      [rem.rows[0].id, r.fee_payment_id])
  }
  const householdRequired = async (tenantId: string, landlordId: string) => {
    const { householdQuote } = await import('../services/creditUse')
    const c = await db.connect()
    try { return (await householdQuote(c as PoolClient, { tenantId, landlordId })).totals.required } finally { c.release() }
  }

  // decisions #48.5 (renamed from "cancel ≥48h ahead keeps a fee a payment was
  // tried on, and tells GAM"): a charge nobody owes that a payment touched is
  // voided in a recorded way — kept, never deleted, left out of every balance.
  it('cancel ≥48h ahead voids a fee a payment was tried on as a kept record: off the balance, nothing to review', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await bouncedFee(f, r, { pi: 'pi_fee_bounced' })
    expect(await householdRequired(f.t1, f.landlordId)).toBe(40)    // owed before the cancel

    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('voided')
    const res = await db.query(`SELECT status, fee_voided, fee_payment_id FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toMatchObject({ status: 'cancelled', fee_voided: true, fee_payment_id: r.fee_payment_id })
    // The record stays — voided, stamped with when and why.
    const fee = await db.query<any>(`SELECT status, voided_at, void_reason, next_retry_at FROM payments WHERE id=$1`, [r.fee_payment_id])
    expect(fee.rows[0]).toMatchObject({ status: 'voided', next_retry_at: null,
      void_reason: 'The reservation it was for was canceled or released, so the fee is no longer owed.' })
    expect(fee.rows[0].voided_at).not.toBeNull()
    // A canceled reservation whose fee had a failed pull no longer counts in the household's bill.
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    // Nothing for anyone to review, and no "still shows on your account" notice.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('a voided fee is a record: no delete path removes it, and it cannot be owed again or changed', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await bouncedFee(f, r, { pi: 'pi_fee_record' })
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    // Every path that deletes a charge deletes only one still owed.
    expect((await db.query(`DELETE FROM payments WHERE id=$1 AND status IN ('pending','failed')`, [r.fee_payment_id])).rowCount).toBe(0)
    await expect(db.query(`UPDATE payments SET status='pending', voided_at=NULL, void_reason=NULL WHERE id=$1`, [r.fee_payment_id]))
      .rejects.toThrow(/it is a record and does not change/)
    await expect(db.query(`UPDATE payments SET amount=1 WHERE id=$1`, [r.fee_payment_id])).rejects.toThrow(/does not change/)
    // ...and a paid charge is never voided: it has money behind it (refunded instead).
    const paid = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,'fee',5,'settled','OTHERFEE',CURRENT_DATE,now()) RETURNING id`, [f.landlordId, f.t1])
    await expect(db.query(
      `UPDATE payments SET status='voided', voided_at=now(), void_reason='x' WHERE id=$1`, [paid.rows[0].id]))
      .rejects.toThrow(/only a charge still owed can be voided/)
  })

  it('cancel ≥48h ahead stops a bank retry of the fee alone, after the cancel is saved, and voids the fee', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    // The tenant paid it by bank, the bank turned it down, and it is due to be tried again.
    await bouncedFee(f, r, { pi: 'pi_fee_retry', retryInDays: 3 })
    // Stripe is asked to cancel only once the cancel is committed (seen from another connection).
    const seenAtCancel: string[] = []
    stripeCancel.mockImplementationOnce(async (id: string) => {
      const saved = await db.query<{ status: string }>(`SELECT status FROM common_area_reservations WHERE id=$1`, [r.id])
      seenAtCancel.push(saved.rows[0].status)
      return { id, status: 'canceled' }
    })

    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect(stripeCancel).toHaveBeenCalledWith('pi_fee_retry')
    expect(seenAtCancel).toEqual(['cancelled'])
    const fee = await db.query<{ status: string; next_retry_at: Date | null }>(
      `SELECT status, next_retry_at FROM payments WHERE id=$1`, [r.fee_payment_id])
    expect(fee.rows[0]).toEqual({ status: 'voided', next_retry_at: null })   // the record stays; nothing pulls it
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('a tried fee with account credit already spent on it is kept, and GAM and the tenant are told why', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await bouncedFee(f, r, { pi: 'pi_fee_credit' })
    // $10 of a landlord-issued credit was spent on it.
    const fee = (await db.query<any>(`SELECT lease_id FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0]
    const credit = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill') RETURNING id`, [f.landlordId, f.t1, fee.lease_id])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,10,'2026-10-01','desk','applied',now())`, [credit.rows[0].id, r.fee_payment_id, fee.lease_id])

    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('kept')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('failed')
    const alert = await db.query(`SELECT body FROM admin_notifications WHERE category='reservation_fee_kept'`)
    expect(alert.rows).toHaveLength(1)
    expect(alert.rows[0].body).toMatch(/was canceled, so its \$40\.00 fee is no longer owed/)
    expect(alert.rows[0].body).toMatch(/account credit was already spent on it, so it could not be voided/)
    const told = await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE type='amenity_unavailable' AND user_id=$1`, [f.t1User])
    expect(told.rows).toHaveLength(1)
    expect(told.rows[0].body).toBe('Your reservation at Clubhouse was canceled. The $40.00 fee still shows on your account ' +
      'because account credit was already used on it. It has been sent for review.')
    expect(told.rows[0].body).not.toMatch(/take it off|refund/i)
  })

  /** The fee and the household's $460 rent bounced together on one bank pull. */
  async function bouncedWithRent(f: any, r: any, o: { pi: string; retryInDays: number | null }) {
    await bouncedFee(f, r, { pi: o.pi, retryInDays: o.retryInDays ?? undefined })
    const fee = (await db.query<any>(`SELECT lease_id, unit_id FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0]
    const rent = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, next_retry_at)
       VALUES ($1,$2,$3,$4,'rent',460,'failed','RENT',CURRENT_DATE,$5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END) RETURNING id`,
      [f.landlordId, f.t1, fee.lease_id, fee.unit_id, o.pi, o.retryInDays])
    return rent.rows[0].id
  }

  // decisions #52 (renamed from 'a bank retry still to come that also carries
  // the rent is left to run: the fee is kept and GAM and the tenant are told
  // why'): the fee is not decided under a payment still in flight. It waits —
  // no "kept" alert, no tenant notice — and the sweep decides it.
  it('a refundable cancel whose fee rides a bank retry still to come with the rent waits: the retry is left to run, nothing is voided, and nobody is told yet', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const rent = await bouncedWithRent(f, r, { pi: 'pi_fee_and_rent', retryInDays: 3 })

    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    // Nothing is stopped: the household keeps its rent retry.
    const rows = await db.query<{ id: string; status: string; retry: Date | null }>(
      `SELECT id, status, next_retry_at AS retry FROM payments WHERE id = ANY($1::uuid[])`, [[r.fee_payment_id, rent]])
    for (const row of rows.rows) {
      expect(row.status).toBe('failed')
      expect(row.retry).not.toBeNull()
    }
    expect(stripeCancel).not.toHaveBeenCalled()
    const res = await db.query(`SELECT status, fee_voided, fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ status: 'cancelled', fee_voided: false, fee_refund_due: false, decision_note: caService.reservationFeeWaitLine('refund') })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    // The sweep leaves it alone while the retry is still to come.
    await processTenantEvents()
    expect((await db.query(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note)
      .toBe(caService.reservationFeeWaitLine('refund'))
  })

  it('a waiting fee whose shared bank retry fails for good is taken off by the sweep: never collected, the rent stays owed, and the landlord is never told to refund it', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const rent = await bouncedWithRent(f, r, { pi: 'pi_fee_and_rent_fails', retryInDays: 3 })
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    // The last retry bounced too.
    await db.query(`UPDATE payments SET next_retry_at=NULL, retry_count=2 WHERE id = ANY($1::uuid[])`, [[r.fee_payment_id, rent]])
    await processTenantEvents()
    const rows = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [[r.fee_payment_id, rent]])
    expect(Object.fromEntries(rows.rows.map(x => [x.id, x.status]))).toEqual({ [r.fee_payment_id]: 'voided', [rent]: 'failed' })
    const res = await db.query(`SELECT fee_voided, fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, fee_refund_due: false, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.voided })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
    // Decided once: a later run changes nothing.
    await processTenantEvents()
    expect((await db.query(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note)
      .toBe(caService.RESERVATION_FEE_DECIDED_NOTE.voided)
  })

  it('a waiting fee whose shared bank retry clears is flagged for refund and the landlord is told once', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const rent = await bouncedWithRent(f, r, { pi: 'pi_fee_and_rent_clears', retryInDays: 3 })
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    await db.query(`UPDATE payments SET status='settled', settled_at=now(), next_retry_at=NULL WHERE id = ANY($1::uuid[])`, [[r.fee_payment_id, rent]])
    await processTenantEvents()
    await processTenantEvents()
    const res = await db.query(`SELECT fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_refund_due: true, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.refund_due })
    const n = await db.query<{ body: string }>(`SELECT body FROM notifications WHERE type='amenity_fee_refund_due'`)
    expect(n.rows).toHaveLength(1)
    expect(n.rows[0].body).toBe("A canceled Clubhouse reservation's $40.00 fee was still being paid when it was canceled, and that payment has now gone through. The fee is not owed, so refund it.")
  })

  it('a pull shared with the rent but with no retry left is no reason to keep the fee: it is voided as a record', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const rent = await bouncedWithRent(f, r, { pi: 'pi_fee_and_rent_done', retryInDays: null })
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('voided')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [rent])).rows[0].status).toBe('failed')
    expect(await householdRequired(f.t1, f.landlordId)).toBe(460)    // the rent is still owed; the fee is not
    expect(stripeCancel).not.toHaveBeenCalled()
  })

  /**
   * The tenant paid the fee, then a card dispute took the money back and
   * reopened it as a new owed row (payments.reversal_id). `reopened` is what
   * became of that row.
   */
  async function disputedFee(f: any, r: any, reopened: { status: 'pending' | 'settled'; amount?: number } | null) {
    await db.query(`UPDATE payments SET status='returned', settled_at=now(), stripe_payment_intent_id='pi_fee_disputed' WHERE id=$1`,
      [r.fee_payment_id])
    const rev = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,'card_dispute',40,'evt_fee_dispute','{}'::jsonb) RETURNING id`, [r.fee_payment_id, f.landlordId, f.t1])
    if (!reopened) return null
    const n = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             reversal_id, settled_at, revenue_owner)
       SELECT landlord_id, tenant_id, lease_id, unit_id, type, $2, $3, entry_description, due_date, $4,
              CASE WHEN $3 = 'settled' THEN now() END, revenue_owner
         FROM payments WHERE id = $1 RETURNING id`,
      [r.fee_payment_id, reopened.amount ?? 40, reopened.status, rev.rows[0].id])
    return n.rows[0].id
  }

  it('a disputed fee canceled ≥48h ahead: the row the dispute reopened is voided, the disputed record stays returned', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const reopened = await disputedFee(f, r, { status: 'pending' })
    expect(await householdRequired(f.t1, f.landlordId)).toBe(40)    // owed again after the dispute

    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('returned')
    const n = await db.query<any>(`SELECT status, void_reason FROM payments WHERE id=$1`, [reopened])
    expect(n.rows[0]).toEqual({ status: 'voided', void_reason: 'The reservation it was for was canceled or released, so the fee is no longer owed.' })
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    const res = await db.query(`SELECT fee_voided, fee_payment_id FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, fee_payment_id: r.fee_payment_id })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('a disputed fee the tenant paid again, canceled ≥48h ahead, is flagged for the landlord to refund', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await disputedFee(f, r, { status: 'settled' })
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('refund_due')
  })

  it('a disputed fee with nothing reopened yet is kept, and GAM and the tenant are told it is a dispute', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await disputedFee(f, r, null)
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('kept')
    const alert = await db.query<{ body: string; context: any }>(`SELECT body, context FROM admin_notifications WHERE category='reservation_fee_kept'`)
    expect(alert.rows[0].context.why).toBe('disputed')
    expect(alert.rows[0].body).toMatch(/a dispute or bank return took its money back/)
    expect(alert.rows[0].body).not.toMatch(/account credit was already spent/)
    const told = await db.query<{ body: string }>(`SELECT body FROM notifications WHERE type='amenity_unavailable' AND user_id=$1`, [f.t1User])
    expect(told.rows[0].body).toMatch(/because a dispute or bank return on it is still being sorted out\. It has been sent for review\.$/)
  })

  it('a disputed fee whose reopened bill was already voided another way is voided: nothing owed, no dispute alert, no notice', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const reopened = await disputedFee(f, r, { status: 'pending' })
    await db.query(`UPDATE payments SET status='voided', voided_at=now(), void_reason='Voided elsewhere' WHERE id=$1`, [reopened])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await db.query(`SELECT status, void_reason FROM payments WHERE id=$1`, [reopened])).rows[0])
      .toEqual({ status: 'voided', void_reason: 'Voided elsewhere' })   // left exactly as the other path voided it
    expect((await db.query(`SELECT fee_voided FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].fee_voided).toBe(true)
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('a disputed fee reopened in two parts, one already voided and one still owed, is voided whole', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const owedPart = await disputedFee(f, r, { status: 'pending', amount: 25 })
    const rev = (await db.query<{ reversal_id: string }>(`SELECT reversal_id FROM payments WHERE id=$1`, [owedPart])).rows[0].reversal_id
    const gonePart = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date, reversal_id, revenue_owner)
       SELECT landlord_id, tenant_id, lease_id, unit_id, type, 15, 'pending', entry_description, due_date, $2, revenue_owner
         FROM payments WHERE id = $1 RETURNING id`, [r.fee_payment_id, rev])).rows[0].id
    await db.query(`UPDATE payments SET status='voided', voided_at=now(), void_reason='Voided elsewhere' WHERE id=$1`, [gonePart])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [owedPart])).rows[0].status).toBe('voided')
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
  })

  it('a disputed fee reopened for only part of it is kept: the rest is still paid', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const reopened = await disputedFee(f, r, { status: 'pending', amount: 15 })
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('kept')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [reopened])).rows[0].status).toBe('pending')
  })

  // decisions #52 (renamed from 'a fee with a card payment that may still be
  // going through is kept, not voided under it'): it waits, and GAM is not
  // alerted about a fee nobody has decided yet.
  it('a fee with a card payment that may still be going through waits: not voided under it, no alert, no refund notice', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_card_confirming' WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  it('a fee still clearing at a refundable cancel that then fails is voided, never collected, and the landlord is never told to refund it', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_clearing' WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    let res = await db.query(`SELECT fee_refund_due, fee_voided FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_refund_due: false, fee_voided: false })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    // Still clearing: the sweep waits.
    await processTenantEvents()
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('processing')
    // The bank pull bounced, no retry left.
    await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL WHERE id=$1`, [r.fee_payment_id])
    await processTenantEvents()
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('voided')
    res = await db.query(`SELECT fee_refund_due, fee_voided FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_refund_due: false, fee_voided: true })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
  })

  it('a fee still clearing at a refundable cancel that then settles is flagged for refund, and only then is the landlord told', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_clearing_ok' WHERE id=$1`, [r.fee_payment_id])
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [r.fee_payment_id])
    await processTenantEvents()
    const res = await db.query(`SELECT fee_refund_due, fee_voided FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_refund_due: true, fee_voided: false })
    expect(await notifCount('amenity_fee_refund_due')).toBe(1)
  })

  // ── review fix pass 2: the waiting-fee paths with no test, and the note ──

  /** A card payment on the fee, started and waiting on the cardholder (3-D Secure): a receipt + the fee 'processing'. */
  async function cardClearing(f: any, r: any, pi: string) {
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id=$2 WHERE id=$1`, [r.fee_payment_id, pi])
    const rem = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,40,40,0,'processing','card',$3,0) RETURNING id`, [f.t1, f.landlordId, pi])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,40)`,
      [rem.rows[0].id, r.fee_payment_id])
    return rem.rows[0].id
  }

  it('a card payment still clearing at a refundable cancel that the 30-minute hold then releases: the sweep voids the fee as a record, nothing is pulled, and nobody is told to refund', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const rem = await cardClearing(f, r, 'pi_fee_3ds')
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    // The hold ran out (jobs/paymentReconcile releaseUnconfirmedCharge): the bill
    // opens again with no payment on it, and the receipt closes as failed.
    await db.query(`UPDATE payments SET status='pending', stripe_payment_intent_id=NULL, next_retry_at=NULL WHERE id=$1`, [r.fee_payment_id])
    await db.query(`UPDATE tenant_remittances SET status='failed' WHERE id=$1`, [rem])
    await processTenantEvents()
    const fee = await db.query<any>(`SELECT status, next_retry_at, void_reason FROM payments WHERE id=$1`, [r.fee_payment_id])
    // A payment was tried on it (its receipt points at it), so it is kept as a voided record, never deleted.
    expect(fee.rows[0]).toEqual({ status: 'voided', next_retry_at: null, void_reason: caService.RESERVATION_FEE_VOID_REASON })
    const res = await db.query(`SELECT fee_voided, fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, fee_refund_due: false, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.voided })
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    expect(stripeCancel).not.toHaveBeenCalled()
  })

  it('a payment clearing at a refundable cancel that fails into a bank retry of the fee alone: the sweep voids the fee and stops that retry, canceling it at Stripe only after the decision is saved', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_alone_retry' WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    // The bank turned it down and scheduled a retry of the fee ALONE.
    await bouncedFee(f, r, { pi: 'pi_fee_alone_retry', retryInDays: 3 })
    const seenAtCancel: Array<string | null> = []
    stripeCancel.mockImplementationOnce(async (id: string) => {
      const saved = await db.query<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])
      seenAtCancel.push(saved.rows[0]?.status ?? null)
      return { id, status: 'canceled' }
    })
    await processTenantEvents()
    expect(stripeCancel).toHaveBeenCalledWith('pi_fee_alone_retry')
    expect(seenAtCancel).toEqual(['voided'])   // the void was committed before Stripe was asked
    const fee = await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [r.fee_payment_id])
    expect(fee.rows[0]).toEqual({ status: 'voided', next_retry_at: null })
    const res = await db.query(`SELECT fee_voided, fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, fee_refund_due: false, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.voided })
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
  })

  it('the note the landlord typed when approving survives a cancel whose fee waits, and the decided words follow it', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: true, reservationFee: 40 })).body.data
    const req0 = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })
    const decide = await request(app).post(`/api/common-areas/reservations/${req0.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: true, note: 'Bring your own chairs.' })
    expect(decide.status).toBe(200)
    const r = (await db.query<any>(`SELECT * FROM common_area_reservations WHERE id=$1`, [req0.body.data.id])).rows[0]
    expect(r.fee_payment_id).toBeTruthy()
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_note' WHERE id=$1`, [r.fee_payment_id])
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    const note = async () => (await db.query<{ decision_note: string }>(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note
    expect(await note()).toBe(`Bring your own chairs.\n\n${caService.reservationFeeWaitLine('refund')}`)
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [r.fee_payment_id])
    await processTenantEvents()
    expect(await note()).toBe(`Bring your own chairs.\n\n${caService.RESERVATION_FEE_DECIDED_NOTE.refund_due}`)
    expect(await notifCount('amenity_fee_refund_due')).toBe(1)
  })

  it('a waiting fee is found by its key, not its words: a note written by an older wording is still decided', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_old_words' WHERE id=$1`, [r.fee_payment_id])
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    await db.query(`UPDATE common_area_reservations SET decision_note=$2 WHERE id=$1`,
      [r.id, `${caService.RESERVATION_FEE_WAIT_KEY.refund} Words from an earlier deploy.`])
    await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL WHERE id=$1`, [r.fee_payment_id])
    await processTenantEvents()
    const res = await db.query(`SELECT fee_voided, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.voided })
  })

  it('a landlord’s approve note containing a waiting-fee key is saved with the key neutralized — the landlord’s words never carry GAM’s record', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: true, reservationFee: 40 })).body.data
    const req0 = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })
    const decide = await request(app).post(`/api/common-areas/reservations/${req0.body.data.id}/decide`)
      .set('Authorization', `Bearer ${f.llToken}`).send({ approve: true, note: `${caService.RESERVATION_FEE_WAIT_KEY.refund} see you there` })
    expect(decide.status).toBe(200)
    const saved = (await db.query<{ decision_note: string }>(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [req0.body.data.id])).rows[0]
    expect(saved.decision_note).toBe('(fee_wait:refund] see you there')
    expect(caService.readFeeWait(saved.decision_note).how).toBeNull()
  })

  it('a waiting-fee key inside a landlord’s own words (as the assistant can save them) never makes a canceled reservation read as waiting: the sweep leaves it alone, nobody is told to refund', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    // Canceled with nothing waiting (the fee unpaid, nothing tried — taken off at the cancel).
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.status).toBe(200)
    expect(cancel.body.data.feeOutcome).not.toBe('waiting')
    // A landlord note with a key in the middle of the words, and one whose key is
    // not in the last paragraph.
    const mid = `Please ${caService.RESERVATION_FEE_WAIT_KEY.refund} and ${caService.RESERVATION_FEE_WAIT_KEY.stands} are just words.`
    await db.query(`UPDATE common_area_reservations SET decision_note=$2 WHERE id=$1`, [r.id, mid])
    expect(caService.readFeeWait(mid).how).toBeNull()
    expect(await caService.reservationFeesWaiting()).toEqual([])
    const notLast = `${caService.RESERVATION_FEE_WAIT_KEY.refund} first\n\nBring chairs.`
    await db.query(`UPDATE common_area_reservations SET decision_note=$2 WHERE id=$1`, [r.id, notLast])
    expect(caService.readFeeWait(notLast).how).toBeNull()
    expect(await caService.reservationFeesWaiting()).toEqual([])
    await processTenantEvents()
    const res = await db.query(`SELECT fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_refund_due: false, decision_note: notLast })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  it('a waiting fee decided after a landlord note that carried a key: the key in the note is neutralized, so it is decided once and the refund notice goes once', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_key_in_note' WHERE id=$1`, [r.fee_payment_id])
    // A note saved before this fix (or by the assistant), whose LAST paragraph started with a key.
    await db.query(`UPDATE common_area_reservations SET decision_note=$2 WHERE id=$1`,
      [r.id, `${caService.RESERVATION_FEE_WAIT_KEY.refund} typed by the landlord`])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [r.fee_payment_id])
    await processTenantEvents()
    await processTenantEvents()
    const note = (await db.query<{ decision_note: string }>(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note
    expect(note).toBe(`(fee_wait:refund] typed by the landlord\n\n${caService.RESERVATION_FEE_DECIDED_NOTE.refund_due}`)
    expect(caService.readFeeWait(note).how).toBeNull()
    expect(await notifCount('amenity_fee_refund_due')).toBe(1)
  })

  it('a waiting fee whose payment went through and was then taken back by a dispute before the sweep: the fee comes off and the note says it was taken back — never “did not go through”', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_then_disputed' WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    // It settled, then a dispute took it back and reopened it as owed.
    const reopened = await disputedFee(f, r, { status: 'pending' })
    await processTenantEvents()
    const res = await db.query(`SELECT fee_voided, fee_refund_due, decision_note FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ fee_voided: true, fee_refund_due: false, decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.voided_taken_back })
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [reopened])).rows[0].status).toBe('voided')
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0].status).toBe('returned')
    expect(await householdRequired(f.t1, f.landlordId)).toBe(0)
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  it('the sweep reaches every waiting fee, page by page: fees still in flight never starve the ones behind them', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const made: any[] = []
    for (let i = 0; i < 3; i++) {
      const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
        .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72 + i * 3), endsAt: PLUS(73 + i * 3) })).body.data
      await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id=$2 WHERE id=$1`, [r.fee_payment_id, `pi_page_${i}`])
      const c = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
      expect(c.body.data.feeOutcome).toBe('waiting')
      made.push(r)
    }
    made.sort((a, b) => (a.id < b.id ? -1 : 1))
    // The two first in id order are still clearing; only the last one failed for good.
    await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL WHERE id=$1`, [made[2].fee_payment_id])
    expect(await caService.reservationFeesWaiting({ limit: 1 })).toEqual([made[0].id])
    const decided = await caService.decideAllWaitingReservationFees(1)
    expect(decided).toEqual({ [made[2].id]: 'voided' })
    const notes = await db.query<{ id: string; decision_note: string }>(
      `SELECT id, decision_note FROM common_area_reservations WHERE id = ANY($1::uuid[])`, [made.map(m => m.id)])
    const byId = Object.fromEntries(notes.rows.map(x => [x.id, x.decision_note]))
    expect(byId[made[0].id]).toBe(caService.reservationFeeWaitLine('refund'))
    expect(byId[made[1].id]).toBe(caService.reservationFeeWaitLine('refund'))
    expect(byId[made[2].id]).toBe(caService.RESERVATION_FEE_DECIDED_NOTE.voided)
  })

  it('a waiting fee the sweep must keep tells the tenant it is an update about a reservation canceled earlier, never a second "Reservation canceled"', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_kept_late' WHERE id=$1`, [r.fee_payment_id])
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    // It failed for good, and account credit had been spent on it: it cannot come off.
    await bouncedFee(f, r, { pi: 'pi_fee_kept_late' })
    const fee = (await db.query<any>(`SELECT lease_id FROM payments WHERE id=$1`, [r.fee_payment_id])).rows[0]
    const credit = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill') RETURNING id`, [f.landlordId, f.t1, fee.lease_id])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,10,'2026-10-01','desk','applied',now())`, [credit.rows[0].id, r.fee_payment_id, fee.lease_id])
    await processTenantEvents()
    expect((await db.query(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note)
      .toBe(caService.RESERVATION_FEE_DECIDED_NOTE.kept)
    const told = await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE type='amenity_unavailable' AND user_id=$1`, [f.t1User])
    expect(told.rows).toHaveLength(1)
    expect(told.rows[0].title).toBe('Update on your canceled reservation — Clubhouse')
    expect(told.rows[0].body).toBe('An update on your reservation at Clubhouse, which was canceled earlier. The $40.00 fee still shows on your account ' +
      'because account credit was already used on it. It has been sent for review.')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(1)
  })

  it('a fee still clearing at a cancel inside 48 hours stands: nothing waits, nothing is flagged', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(10), endsAt: PLUS(12) })).body.data
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_fee_late' WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('fee_stands')
    expect((await db.query(`SELECT decision_note FROM common_area_reservations WHERE id=$1`, [r.id])).rows[0].decision_note).toBeNull()
  })

  it('a fee removed on cancel sends the tenant no kept-fee notice', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.llToken}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('voided')
    expect(await notifCount('amenity_unavailable', f.t1User)).toBe(0)
  })

  it('a reservation already canceled is refused in plain words, and changes nothing', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`).set('Authorization', `Bearer ${f.t1Token}`).send({})
    const again = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.llToken}`).send({})
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('This reservation was already canceled.')
  })

  it('a paid fee canceled ≥48h ahead is flagged for the landlord to refund', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(72), endsAt: PLUS(74) })).body.data
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [r.fee_payment_id])
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('refund_due')
    const res = await db.query(`SELECT status, fee_refund_due FROM common_area_reservations WHERE id=$1`, [r.id])
    expect(res.rows[0]).toEqual({ status: 'cancelled', fee_refund_due: true })
    const n = await db.query(`SELECT title, body FROM notifications WHERE type='amenity_fee_refund_due'`)
    expect(n.rows).toHaveLength(1)
    expect(n.rows[0].title).toMatch(/reservation canceled$/)
    expect(n.rows[0].body).toMatch(/canceled at least 48 hours ahead/)
  })

  it('cancel inside 48h leaves the fee standing', async () => {
    const f = await fixture()
    const area = (await makeArea(f.llToken, f.propertyId, { requiresApproval: false, reservationFee: 40 })).body.data
    const r = (await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({ startsAt: PLUS(10), endsAt: PLUS(12) })).body.data
    const cancel = await request(app).post(`/api/common-areas/reservations/${r.id}/cancel`)
      .set('Authorization', `Bearer ${f.t1Token}`).send({})
    expect(cancel.body.data.feeOutcome).toBe('fee_stands')
    expect((await feePayments(f.t1)).rows).toHaveLength(1) // still owed
  })
})

// ── W-44 (S531): tenant private events ────────────────────────────────
import { processTenantEvents } from '../jobs/scheduler'

describe('W-44 private events', () => {
  it('event booking uses the event deposit and defers the announcement until paid', async () => {
    const f = await fixture()
    const area = await makeArea(f.llToken, f.propertyId, {
      requiresApproval: false, eventsEnabled: true, eventDepositAmount: 50,
    })
    const res = await request(app).post(`/api/common-areas/${area.body.data.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ kind: 'event', title: 'Birthday bash', startsAt: PLUS(48), endsAt: PLUS(52) })
    expect(res.status).toBe(201)
    const r = await db.query(
      `SELECT kind, fee_amount, status, residents_notified_at FROM common_area_reservations WHERE id=$1`,
      [res.body.data.id])
    expect(r.rows[0].kind).toBe('event')
    expect(Number(r.rows[0].fee_amount)).toBe(50)
    expect(r.rows[0].status).toBe('approved')
    // Deposit unpaid → announcement deferred (no resident alert yet).
    expect(r.rows[0].residents_notified_at).toBeNull()
    expect(await notifCount('amenity_unavailable')).toBe(0)

    // Settle the deposit → the hourly sweep announces to the OTHER resident.
    await db.query(
      `UPDATE payments SET status='settled', settled_at=now()
        WHERE id=(SELECT fee_payment_id FROM common_area_reservations WHERE id=$1)`,
      [res.body.data.id])
    await processTenantEvents()
    const after = await db.query(
      `SELECT residents_notified_at FROM common_area_reservations WHERE id=$1`, [res.body.data.id])
    expect(after.rows[0].residents_notified_at).not.toBeNull()
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })

  it('events are rejected on areas without events_enabled', async () => {
    const f = await fixture()
    const area = await makeArea(f.llToken, f.propertyId, { requiresApproval: false })
    const res = await request(app).post(`/api/common-areas/${area.body.data.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ kind: 'event', startsAt: PLUS(48), endsAt: PLUS(52) })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not host private events/i)
  })

  it('auto-releases an unpaid event at start time (space becomes not private)', async () => {
    const f = await fixture()
    const area = await makeArea(f.llToken, f.propertyId, {
      requiresApproval: false, eventsEnabled: true, eventDepositAmount: 50,
    })
    const res = await request(app).post(`/api/common-areas/${area.body.data.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ kind: 'event', startsAt: PLUS(1), endsAt: PLUS(5) })
    expect(res.status).toBe(201)
    // Time-travel: pull the start into the past; deposit still pending.
    await db.query(
      `UPDATE common_area_reservations SET starts_at = now() - interval '1 minute' WHERE id=$1`,
      [res.body.data.id])
    await processTenantEvents()
    const r = await db.query(
      `SELECT status, fee_voided, fee_payment_id, decision_note FROM common_area_reservations WHERE id=$1`,
      [res.body.data.id])
    expect(r.rows[0].status).toBe('cancelled')
    expect(r.rows[0].fee_voided).toBe(true)
    expect(r.rows[0].fee_payment_id).toBeNull()
    expect(r.rows[0].decision_note).toMatch(/deposit unpaid/i)
  })

  it('an auto-release keeps the note the landlord typed when approving, with the release reason after it', async () => {
    const f = await fixture()
    const area = await makeArea(f.llToken, f.propertyId, {
      requiresApproval: false, eventsEnabled: true, eventDepositAmount: 50,
    })
    const res = await request(app).post(`/api/common-areas/${area.body.data.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ kind: 'event', startsAt: PLUS(1), endsAt: PLUS(5) })
    await db.query(
      `UPDATE common_area_reservations SET starts_at = now() - interval '1 minute', decision_note = 'Pay the deposit by Friday.' WHERE id=$1`,
      [res.body.data.id])
    await processTenantEvents()
    const r = await db.query(`SELECT status, decision_note FROM common_area_reservations WHERE id=$1`, [res.body.data.id])
    expect(r.rows[0]).toEqual({ status: 'cancelled',
      decision_note: 'Pay the deposit by Friday.\n\nAuto-released: event deposit unpaid by start time' })
  })
})

// ── A reservation fee paid again after a dispute is paid ───────────────
import { reservationFeePaidSql, RESERVATION_FEE_VOID_REASON } from '../services/commonAreas'
import * as caService from '../services/commonAreas'
import * as moneyPreds from '../services/moneyPredicates'
import { fireAmenityAlert } from './commonAreas'

describe('a reservation fee a dispute took back and the tenant paid again counts as paid', () => {
  /** An event booked with its $50 deposit billed; returns the reservation and its fee row. */
  async function bookedEvent(f: any) {
    const area = (await makeArea(f.llToken, f.propertyId, {
      requiresApproval: false, eventsEnabled: true, eventDepositAmount: 50,
    })).body.data
    const res = await request(app).post(`/api/common-areas/${area.id}/request`)
      .set('Authorization', `Bearer ${f.t1Token}`)
      .send({ kind: 'event', title: 'Birthday bash', startsAt: PLUS(48), endsAt: PLUS(52) })
    expect(res.status).toBe(201)
    const fee = (await db.query<{ fee_payment_id: string }>(
      `SELECT fee_payment_id FROM common_area_reservations WHERE id=$1`, [res.body.data.id])).rows[0].fee_payment_id
    return { reservationId: res.body.data.id as string, fee }
  }
  /** The deposit was paid, a card dispute took it back, and the dispute reopened it as `reopened`. */
  async function disputed(f: any, fee: string, reopened: 'pending' | 'settled' | 'processing') {
    await db.query(`UPDATE payments SET status='returned', settled_at=now(), stripe_payment_intent_id='pi_ev_disputed' WHERE id=$1`, [fee])
    const rev = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,'card_dispute',50,'evt_ev_dispute','{}'::jsonb) RETURNING id`, [fee, f.landlordId, f.t1])
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             reversal_id, settled_at, revenue_owner)
       SELECT landlord_id, tenant_id, lease_id, unit_id, type, amount, $2, entry_description, due_date, $3,
              CASE WHEN $2 = 'settled' THEN now() END, revenue_owner
         FROM payments WHERE id = $1`, [fee, reopened, rev.rows[0].id])
  }
  const paid = async (fee: string, statuses?: string[]) =>
    (await db.query<{ paid: boolean }>(`SELECT ${reservationFeePaidSql('$1::uuid', statuses)} AS paid`, [fee])).rows[0].paid

  it('reads paid for a paid fee, and for a disputed fee whose reopened bill was paid again — never for one still owed', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    expect(await paid(a.fee)).toBe(false)                     // billed, not paid
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [a.fee])
    expect(await paid(a.fee)).toBe(true)

    await cleanupAllSchema()
    const g = await fixture()
    const b = await bookedEvent(g)
    await disputed(g, b.fee, 'pending')
    expect(await paid(b.fee)).toBe(false)                     // the dispute reopened it and it is owed again
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE reversal_id IS NOT NULL`)
    expect(await paid(b.fee)).toBe(true)                      // paid again
    expect(await paid(b.fee, ['settled'])).toBe(true)
  })

  it('a reopened bill still clearing counts as paid for the release, but not as arrived money for the announcement', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'processing')
    expect(await paid(a.fee)).toBe(true)
    expect(await paid(a.fee, ['settled'])).toBe(false)
  })

  it('an event whose deposit was disputed and then paid again is announced to the other residents', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(0)
    await fireAmenityAlert(a.reservationId)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
    const r = await db.query(`SELECT residents_notified_at FROM common_area_reservations WHERE id=$1`, [a.reservationId])
    expect(r.rows[0].residents_notified_at).not.toBeNull()
  })

  it('an event whose disputed deposit is still owed again is not announced', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await fireAmenityAlert(a.reservationId)
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(0)
  })

  // ── the hourly event sweep (jobs/scheduler processTenantEvents) ──────────
  /** Pull the event's start into the past, so the sweep's release pass looks at it. */
  const started = (reservationId: string) =>
    db.query(`UPDATE common_area_reservations SET starts_at = now() - interval '1 minute' WHERE id=$1`, [reservationId])
  const reservation = async (id: string) => (await db.query(
    `SELECT status, fee_voided, fee_payment_id, residents_notified_at FROM common_area_reservations WHERE id=$1`, [id])).rows[0]
  const releasedNotices = async (userId: string) => (await db.query(
    `SELECT body FROM notifications WHERE type='amenity_unavailable' AND user_id=$1 AND title LIKE 'Event released%'`, [userId])).rows

  it('the hourly sweep never releases a disputed event deposit the tenant paid again', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
    const rows = await db.query(`SELECT status FROM payments WHERE id=$1 OR reversal_id IS NOT NULL ORDER BY reversal_id NULLS FIRST`, [a.fee])
    expect(rows.rows.map(r => r.status)).toEqual(['returned', 'settled'])   // nothing voided, nothing kept from them
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('the hourly sweep never releases an event whose disputed deposit is clearing again', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'processing')
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('the hourly sweep announces an event whose disputed deposit was paid again', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    await processTenantEvents()
    expect((await reservation(a.reservationId)).residents_notified_at).not.toBeNull()
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(1)
  })

  it('the hourly sweep does not announce an event whose disputed deposit is only clearing again (money not arrived)', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'processing')
    await processTenantEvents()
    expect((await reservation(a.reservationId)).residents_notified_at).toBeNull()
    expect(await notifCount('amenity_unavailable', f.t2User)).toBe(0)
  })

  it('a deposit paid again after the scan is seen under the lock, before anything changes: the event stays', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await started(a.reservationId)
    // The tenant's payment lands after the sweep's scan, just before it takes the household lock.
    const realLock = moneyPreds.lockHousehold
    const lock = vi.spyOn(moneyPreds, 'lockHousehold').mockImplementationOnce(async (...args: Parameters<typeof realLock>) => {
      await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE reversal_id IS NOT NULL`)
      return realLock(...args)
    })
    const voidPass = vi.spyOn(caService, 'voidUnpaidReservationFee')
    try {
      await processTenantEvents()
      expect(lock).toHaveBeenCalled()
      expect(voidPass).not.toHaveBeenCalled()
    } finally { lock.mockRestore(); voidPass.mockRestore() }
    expect((await reservation(a.reservationId)).status).toBe('approved')
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('a deposit whose payment lands while the release holds the lock keeps the event: nothing is committed', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await started(a.reservationId)
    // The deposit settles between the fresh read and the deposit row's own lock.
    const realVoid = caService.voidUnpaidReservationFee
    const voidPass = vi.spyOn(caService, 'voidUnpaidReservationFee').mockImplementationOnce(async (...args: Parameters<typeof realVoid>) => {
      await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [a.fee])
      return realVoid(...args)
    })
    try {
      await processTenantEvents()
      expect(voidPass).toHaveBeenCalledTimes(1)
    } finally { voidPass.mockRestore() }
    const r = await reservation(a.reservationId)
    expect(r).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('a disputed deposit still owed at the start is released: the reopened bill is voided as a record and the property hears it is open again', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    // It had been announced when the deposit was first paid.
    await db.query(`UPDATE common_area_reservations SET residents_notified_at = now() - interval '1 day' WHERE id=$1`, [a.reservationId])
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('cancelled')
    const fee = await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])
    expect(fee.rows[0].status).toBe('returned')                       // the dispute's record, untouched
    const reopened = await db.query(`SELECT status, voided_at IS NOT NULL AS stamped, void_reason FROM payments WHERE reversal_id IS NOT NULL`)
    expect(reopened.rows).toEqual([{ status: 'voided', stamped: true, void_reason: RESERVATION_FEE_VOID_REASON }])
    expect(await releasedNotices(f.t1User)).toHaveLength(1)
    const openAgain = await db.query(
      `SELECT title FROM notifications WHERE type='amenity_unavailable' AND user_id=$1 AND title LIKE '%open again%'`, [f.t2User])
    expect(openAgain.rows).toHaveLength(1)
  })

  it('a disputed deposit whose reopened bill was already voided another way is released with no dispute alert and no kept line', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await db.query(
      `UPDATE payments SET status='voided', voided_at=now(), void_reason='Voided elsewhere' WHERE reversal_id IS NOT NULL`)
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'cancelled', fee_voided: true })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rowCount).toBe(0)
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    // No kept line (nothing still shows, nothing went for review). The reason
    // itself is said truly: the payment was taken back (fix pass 2 wording).
    expect(told[0].body).not.toMatch(/still shows|review|being sorted out/)
    expect(told[0].body).toMatch(/the payment for its deposit was taken back by a dispute or bank return\./)
  })

  it('a deposit whose card payment may still be going through is not released this run; the next run releases it once that payment is released', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    // A card payment on it was started and may still be going through.
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_ev_moving' WHERE id=$1`, [a.fee])
    await started(a.reservationId)
    const voidPass = vi.spyOn(caService, 'voidUnpaidReservationFee')
    try {
      await processTenantEvents()
      expect(voidPass).not.toHaveBeenCalled()
    } finally { voidPass.mockRestore() }
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
    // The payment did not go through: the bill is owed again, with nothing in flight.
    await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL, stripe_payment_intent_id=NULL WHERE id=$1`, [a.fee])
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('cancelled')
    expect(await releasedNotices(f.t1User)).toHaveLength(1)
  })

  it('a deposit whose card payment was going through and then settled keeps the event', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_ev_moving' WHERE id=$1`, [a.fee])
    await started(a.reservationId)
    await processTenantEvents()
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [a.fee])
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    const fee = await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])
    expect(fee.rows[0].status).toBe('settled')
  })

  it('a disputed deposit whose reopened bill has a payment going through is not released this run', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_ev_repay' WHERE reversal_id IS NOT NULL`)
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
    const reopened = await db.query(`SELECT status FROM payments WHERE reversal_id IS NOT NULL`)
    expect(reopened.rows).toEqual([{ status: 'pending' }])
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('a payment started on the deposit after the scan is seen under the lock: nothing changes this run', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await started(a.reservationId)
    const realLock = moneyPreds.lockHousehold
    const lock = vi.spyOn(moneyPreds, 'lockHousehold').mockImplementationOnce(async (...args: Parameters<typeof realLock>) => {
      await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_ev_late' WHERE id=$1`, [a.fee])
      return realLock(...args)
    })
    const voidPass = vi.spyOn(caService, 'voidUnpaidReservationFee')
    try {
      await processTenantEvents()
      expect(lock).toHaveBeenCalled()
      expect(voidPass).not.toHaveBeenCalled()
    } finally { lock.mockRestore(); voidPass.mockRestore() }
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('an event the landlord moved later after the scan is not released', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await started(a.reservationId)
    const realLock = moneyPreds.lockHousehold
    const lock = vi.spyOn(moneyPreds, 'lockHousehold').mockImplementationOnce(async (...args: Parameters<typeof realLock>) => {
      await db.query(`UPDATE common_area_reservations SET starts_at = now() + interval '2 days' WHERE id=$1`, [a.reservationId])
      return realLock(...args)
    })
    try {
      await processTenantEvents()
      expect(lock).toHaveBeenCalled()
    } finally { lock.mockRestore() }
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    const fee = await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])
    expect(fee.rows[0].status).toBe('pending')
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('an event whose area had auto-release turned off after the scan is not released', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await started(a.reservationId)
    const realLock = moneyPreds.lockHousehold
    const lock = vi.spyOn(moneyPreds, 'lockHousehold').mockImplementationOnce(async (...args: Parameters<typeof realLock>) => {
      await db.query(
        `UPDATE common_areas SET event_auto_release = FALSE
          WHERE id = (SELECT common_area_id FROM common_area_reservations WHERE id=$1)`, [a.reservationId])
      return realLock(...args)
    })
    try {
      await processTenantEvents()
      expect(lock).toHaveBeenCalled()
    } finally { lock.mockRestore() }
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  /** The $50 deposit's bank pull bounced; a retry still to come carries it together with the household's $900 rent. */
  async function bouncedWithRent(fee: string) {
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ev_shared', next_retry_at=now() + interval '1 day'
        WHERE id=$1`, [fee])
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, next_retry_at, revenue_owner)
       SELECT landlord_id, tenant_id, lease_id, unit_id, 'rent', 900, 'failed', 'RENT', due_date, 'pi_ev_shared',
              now() + interval '1 day', revenue_owner
         FROM payments WHERE id = $1 RETURNING id`, [fee])).rows[0].id
  }

  // decisions #52 (renamed from 'a deposit that has to stay at the release
  // tells the tenant and GAM why — never "for now"', which released the event
  // while the retry still carried the deposit): a payment in flight decides.
  it('a deposit a bank retry bundled with rent still carries is not released while the retry is to come; the retry clearing keeps the event', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    const rent = await bouncedWithRent(a.fee)
    await started(a.reservationId)
    const voidPass = vi.spyOn(caService, 'voidUnpaidReservationFee')
    try {
      await processTenantEvents()
      expect(voidPass).not.toHaveBeenCalled()
    } finally { voidPass.mockRestore() }
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
    expect(stripeCancel).not.toHaveBeenCalled()
    // The retry ran and cleared: the deposit is paid, the event is theirs.
    await db.query(`UPDATE payments SET status='settled', settled_at=now(), next_retry_at=NULL WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
  })

  it('a deposit a bank retry bundled with rent carried is released once that retry fails for good: the deposit is voided, the rent stays owed', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    const rent = await bouncedWithRent(a.fee)
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
    // The last retry bounced too: nothing will pull the deposit or the rent again.
    await db.query(`UPDATE payments SET next_retry_at=NULL, retry_count=2 WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'cancelled', fee_voided: true })
    const rows = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    expect(Object.fromEntries(rows.rows.map(r => [r.id, r.status]))).toEqual({ [a.fee]: 'voided', [rent]: 'failed' })
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    expect(told[0].body).not.toMatch(/still shows/)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
  })

  it('a deposit bundled with rent on a retry marked for a date but with no tries left is released AND voided: "in flight" and "a shared retry" are one rule', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    const rent = await bouncedWithRent(a.fee)
    await db.query(`UPDATE payments SET retry_count=2 WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])   // next_retry_at still set
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'cancelled', fee_voided: true })
    const rows = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    expect(Object.fromEntries(rows.rows.map(r => [r.id, r.status]))).toEqual({ [a.fee]: 'voided', [rent]: 'failed' })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
  })

  it('a retry marked for a date but with no tries left is no payment in flight: the event is released', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ev_spent', next_retry_at=now() + interval '1 day', retry_count=2
        WHERE id=$1`, [a.fee])
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'cancelled', fee_voided: true })
  })

  // Renamed from 'a deposit that has to stay at the release tells the tenant
  // and GAM why — never "for now"', which released the event and left the
  // reopened $20 owed: autopay or the next pay-in-full collected it for an
  // event taken away. A deposit that cannot be taken off holds the release.
  it('a deposit that cannot be taken off at the start time keeps the event: nothing changes, nothing stays owed for a released event, and GAM is told once', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    // The dispute reopened only $20 of the $50 (the rest is still paid).
    await db.query(`UPDATE payments SET amount = 20 WHERE reversal_id IS NOT NULL`)
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false, fee_payment_id: a.fee })
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    const reopened = (await db.query(`SELECT status FROM payments WHERE reversal_id IS NOT NULL`)).rows
    expect(reopened).toEqual([{ status: 'pending' }])   // untouched: still owed for an event still theirs
    const gam = await db.query<{ why: string; how: string; title: string }>(
      `SELECT context->>'why' AS why, context->>'how' AS how, title FROM admin_notifications WHERE category='reservation_fee_kept'`)
    expect(gam.rows).toHaveLength(1)
    expect(gam.rows[0]).toMatchObject({ why: 'disputed', how: 'release_held' })
    expect(gam.rows[0].title).toMatch(/^A private event was not released because its deposit could not be taken off/)
    // The sweep runs hourly: GAM is not told again.
    await processTenantEvents()
    await processTenantEvents()
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(1)
    expect((await reservation(a.reservationId)).status).toBe('approved')
  })

  it('a deposit with account credit already spent on it holds the release the same way: the credit stays spent, the event stays, GAM is told why', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_ev_bounced', next_retry_at=NULL, retry_count=2 WHERE id=$1`, [a.fee])
    const fee = (await db.query<any>(`SELECT lease_id FROM payments WHERE id=$1`, [a.fee])).rows[0]
    const credit = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill') RETURNING id`, [f.landlordId, f.t1, fee.lease_id])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,10,'2026-10-01','desk','applied',now())`, [credit.rows[0].id, a.fee, fee.lease_id])
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'approved', fee_voided: false })
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])).rows[0].status).toBe('failed')
    expect((await db.query(`SELECT status FROM credit_uses WHERE payment_id=$1`, [a.fee])).rows[0].status).toBe('applied')
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    const gam = await db.query<{ why: string }>(`SELECT context->>'why' AS why FROM admin_notifications WHERE category='reservation_fee_kept'`)
    expect(gam.rows).toEqual([{ why: 'credit_spent' }])
  })

  // ── a deposit disputed more than once ──────────────────────────────────
  /** The reopened row `rowId` was paid again, then a second dispute took that back and reopened it as `reopened`. */
  async function disputedAgain(f: any, rowId: string, reopened: 'pending' | 'settled' | 'processing'): Promise<string> {
    await db.query(`UPDATE payments SET status='returned', settled_at=now(), stripe_payment_intent_id='pi_ev_disputed_2' WHERE id=$1`, [rowId])
    const rev = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,'card_dispute',50,'evt_ev_dispute_2','{}'::jsonb) RETURNING id`, [rowId, f.landlordId, f.t1])
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             reversal_id, settled_at, revenue_owner)
       SELECT landlord_id, tenant_id, lease_id, unit_id, type, amount, $2, entry_description, due_date, $3,
              CASE WHEN $2 = 'settled' THEN now() END, revenue_owner
         FROM payments WHERE id = $1 RETURNING id`, [rowId, reopened, rev.rows[0].id])).rows[0].id
  }
  const firstReopened = async (fee: string) => (await db.query<{ id: string }>(
    `SELECT n.id FROM payments n JOIN payment_reversals pr ON pr.id = n.reversal_id WHERE pr.payment_id = $1`, [fee])).rows[0].id

  it('a deposit disputed twice and paid a third time counts as paid: the sweep keeps the event and announces it', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    await disputedAgain(f, await firstReopened(a.fee), 'settled')
    expect(await paid(a.fee)).toBe(true)
    expect(await paid(a.fee, ['settled'])).toBe(true)
    await processTenantEvents()            // announces (the start is two days off)
    expect((await reservation(a.reservationId)).residents_notified_at).not.toBeNull()
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
    expect(await releasedNotices(f.t1User)).toHaveLength(0)
    const statuses = (await db.query(`SELECT status FROM payments WHERE id = $1 OR reversal_id IS NOT NULL ORDER BY created_at, id`, [a.fee])).rows
    expect(statuses.map(r => r.status).sort()).toEqual(['returned', 'returned', 'settled'])   // nothing voided
  })

  it('a deposit disputed twice whose last reopened bill has a payment going through is not released', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    const last = await disputedAgain(f, await firstReopened(a.fee), 'pending')
    await db.query(`UPDATE payments SET stripe_payment_intent_id='pi_ev_third' WHERE id=$1`, [last])
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')
  })

  it('a deposit disputed twice whose last reopened bill is still owed is released: only that bill is voided, the disputed records stay', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'settled')
    const mid = await firstReopened(a.fee)
    const last = await disputedAgain(f, mid, 'pending')
    await started(a.reservationId)
    await processTenantEvents()
    expect(await reservation(a.reservationId)).toMatchObject({ status: 'cancelled', fee_voided: true })
    const rows = await db.query(`SELECT id, status FROM payments WHERE id = ANY($1::uuid[])`, [[a.fee, mid, last]])
    expect(Object.fromEntries(rows.rows.map(r => [r.id, r.status])))
      .toEqual({ [a.fee]: 'returned', [mid]: 'returned', [last]: 'voided' })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='reservation_fee_kept'`)).rows).toHaveLength(0)
  })

  // ── the release notice says what is true (decisions #52: a release can come
  // days after the start, once a payment in flight fails for good) ──────────
  /** Pull the event's start AND end into the past (its time is over). */
  const over = (reservationId: string) => db.query(
    `UPDATE common_area_reservations SET starts_at = now() - interval '3 days', ends_at = now() - interval '2 days 20 hours' WHERE id=$1`,
    [reservationId])

  it('a deposit whose bank retry failed for good after the event ended: the tenant is told the payment did not go through, never "open to everyone", and the property hears nothing', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    const rent = await bouncedWithRent(a.fee)
    // It had been announced (paid, then the pull bounced).
    await db.query(`UPDATE common_area_reservations SET residents_notified_at = now() - interval '5 days' WHERE id=$1`, [a.reservationId])
    await over(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('approved')     // the retry is still to come
    await db.query(`UPDATE payments SET next_retry_at=NULL, retry_count=2 WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('cancelled')
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    expect(told[0].body).toBe('Your private event at Clubhouse was released because the payment for its deposit did not go through.')
    expect(told[0].body).not.toMatch(/open to everyone|by the start time/)
    const openAgain = await db.query(
      `SELECT 1 FROM notifications WHERE type='amenity_unavailable' AND user_id=$1 AND title LIKE '%open again%'`, [f.t2User])
    expect(openAgain.rows).toHaveLength(0)
  })

  it('a deposit nothing was tried on, released while the event is still on: "not paid by the start time", and the space is open to everyone', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await started(a.reservationId)
    await processTenantEvents()
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    expect(told[0].body).toBe('Your private event at Clubhouse was released because the deposit wasn\u2019t paid by the start time. The space is open to everyone as usual.')
  })

  it('a deposit a dispute took back and still owed: the tenant is told the payment was taken back', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await started(a.reservationId)
    await processTenantEvents()
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/^Your private event at Clubhouse was released because the payment for its deposit was taken back by a dispute or bank return\. The space is open to everyone as usual\./)
  })

  it('a deposit a dispute took back whose reopened bill then bounced for good: the tenant is told the latest thing, that the payment did not go through', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    // The reopened bill was paid by bank and the pull bounced with no retry left.
    await db.query(
      `UPDATE payments SET status='failed', next_retry_at=NULL, retry_count=2, stripe_payment_intent_id=NULL WHERE reversal_id IS NOT NULL`)
    await started(a.reservationId)
    await processTenantEvents()
    expect((await reservation(a.reservationId)).status).toBe('cancelled')
    const told = await releasedNotices(f.t1User)
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/^Your private event at Clubhouse was released because the payment for its deposit did not go through\./)
    expect(told[0].body).not.toMatch(/taken back/)
  })

  // Renamed from 'GAM’s alert for a deposit kept at a release never says a
  // bank retry was left to run': a deposit that would have to stay no longer
  // releases the event, so the alert says the event was left in place.
  it('GAM’s alert for a held release says the event was left in place and the deposit is still owed, and never that a bank retry was left to run', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await disputed(f, a.fee, 'pending')
    await db.query(`UPDATE payments SET amount = 20 WHERE reversal_id IS NOT NULL`)   // only part reopened
    await started(a.reservationId)
    await processTenantEvents()
    const gam = await db.query(`SELECT body FROM admin_notifications WHERE category='reservation_fee_kept'`)
    expect(gam.rows).toHaveLength(1)
    expect(gam.rows[0].body).not.toMatch(/retry/i)
    expect(gam.rows[0].body).toMatch(/so the event was left in place \(still theirs\) and nothing was changed: the deposit is still owed\./)
    expect(gam.rows[0].body).toMatch(/a dispute or bank return took its money back/)
  })

  // ── a private event canceled while its deposit is still being paid (#52) ──
  const evNote = async (id: string) => (await db.query<{ decision_note: string | null; fee_refund_due: boolean; fee_voided: boolean }>(
    `SELECT decision_note, fee_refund_due, fee_voided FROM common_area_reservations WHERE id=$1`, [id])).rows[0]
  const cancelEvent = (f: any, id: string) => request(app).post(`/api/common-areas/reservations/${id}/cancel`)
    .set('Authorization', `Bearer ${f.t1Token}`).send({})

  it('an event canceled while its deposit is clearing waits; the payment then failing takes the deposit off, never collected', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_ev_clearing' WHERE id=$1`, [a.fee])
    const cancel = await cancelEvent(f, a.reservationId)
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    expect((await evNote(a.reservationId)).decision_note).toBe(caService.reservationFeeWaitLine('stands'))
    await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL WHERE id=$1`, [a.fee])
    await processTenantEvents()
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])).rows[0].status).toBe('voided')
    expect(await evNote(a.reservationId)).toEqual({ decision_note: caService.RESERVATION_DEPOSIT_DECIDED_NOTE.voided, fee_refund_due: false, fee_voided: true })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  // Fix pass 2 (review LOW). Pins the rule as it stands: whether a 'stands'
  // deposit taken back BEFORE the sweep should stay owed instead is Nic's call.
  it('an event canceled while its deposit is clearing, whose payment then went through and was taken back by a dispute before the sweep, comes off and the note says the deposit was taken back', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_ev_clearing_tb' WHERE id=$1`, [a.fee])
    const cancel = await cancelEvent(f, a.reservationId)
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    expect((await evNote(a.reservationId)).decision_note).toBe(caService.reservationFeeWaitLine('stands', 'event'))
    await disputed(f, a.fee, 'pending')
    await processTenantEvents()
    expect(await evNote(a.reservationId)).toEqual({ decision_note: caService.RESERVATION_DEPOSIT_DECIDED_NOTE.voided_taken_back, fee_refund_due: false, fee_voided: true })
    expect((await evNote(a.reservationId)).decision_note).not.toMatch(/\bfee\b/)
    expect((await db.query(`SELECT status FROM payments WHERE reversal_id IS NOT NULL`)).rows.map(r => r.status)).toEqual(['voided'])
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])).rows[0].status).toBe('returned')
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  it('every decided and waiting note on a private event calls its money a deposit, never a fee; a reservation’s still say fee', () => {
    for (const k of Object.keys(caService.RESERVATION_FEE_DECIDED_NOTE) as Array<keyof typeof caService.RESERVATION_FEE_DECIDED_NOTE>) {
      expect(caService.reservationFeeDecidedNote(k, 'event')).not.toMatch(/\bfee\b/)
      expect(caService.reservationFeeDecidedNote(k, 'event')).toMatch(/deposit/)
      expect(caService.reservationFeeDecidedNote(k, 'tenant_reservation')).toBe(caService.RESERVATION_FEE_DECIDED_NOTE[k])
    }
    for (const k of ['refund', 'stands'] as const) {
      const line = caService.reservationFeeWaitLine(k, 'event')
      expect(line.startsWith(caService.RESERVATION_FEE_WAIT_KEY[k])).toBe(true)   // the sweep's key never changes
      expect(caService.readFeeWait(line).how).toBe(k)
      expect(line.slice(caService.RESERVATION_FEE_WAIT_KEY[k].length)).not.toMatch(/\bfee\b/)
    }
    expect(caService.reservationFeeWaitLine('refund')).toBe(`${caService.RESERVATION_FEE_WAIT_KEY.refund} ${caService.RESERVATION_FEE_WAIT_NOTE.refund}`)
  })

  it('an event canceled while its deposit is clearing waits; the payment then settling makes the deposit stand, with no refund notice', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET status='processing', stripe_payment_intent_id='pi_ev_clearing_ok' WHERE id=$1`, [a.fee])
    await cancelEvent(f, a.reservationId)
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [a.fee])
    await processTenantEvents()
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [a.fee])).rows[0].status).toBe('settled')
    expect(await evNote(a.reservationId)).toEqual({ decision_note: caService.RESERVATION_FEE_DECIDED_NOTE.stands, fee_refund_due: false, fee_voided: false })
    expect(await notifCount('amenity_fee_refund_due')).toBe(0)
  })

  it('an event canceled while its unpaid deposit rides a bank retry shared with the rent waits; the retry pulling it flags it for refund (it was owed by nobody)', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    const rent = await bouncedWithRent(a.fee)
    const cancel = await cancelEvent(f, a.reservationId)
    expect(cancel.body.data.feeOutcome).toBe('waiting')
    expect(stripeCancel).not.toHaveBeenCalled()
    expect((await evNote(a.reservationId)).decision_note).toBe(caService.reservationFeeWaitLine('refund', 'event'))
    await db.query(`UPDATE payments SET status='settled', settled_at=now(), next_retry_at=NULL WHERE id = ANY($1::uuid[])`, [[a.fee, rent]])
    await processTenantEvents()
    expect(await evNote(a.reservationId)).toEqual({ decision_note: caService.RESERVATION_DEPOSIT_DECIDED_NOTE.refund_due, fee_refund_due: true, fee_voided: false })
    expect(await notifCount('amenity_fee_refund_due')).toBe(1)
    // The landlord's refund notice calls it the deposit it is.
    const told = (await db.query<{ body: string }>(`SELECT body FROM notifications WHERE type='amenity_fee_refund_due'`)).rows[0].body
    expect(told).toMatch(/deposit was still being paid when it was canceled/)
    expect(told).toMatch(/The deposit is not owed, so refund it\./)
    expect(told).not.toMatch(/\bfee\b/)
  })

  it('an event canceled with its deposit already paid stands at once: nothing waits', async () => {
    const f = await fixture()
    const a = await bookedEvent(f)
    await db.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [a.fee])
    const cancel = await cancelEvent(f, a.reservationId)
    expect(cancel.body.data.feeOutcome).toBe('fee_stands')
    expect((await evNote(a.reservationId)).decision_note).toBeNull()
  })
})

describe('eventReleasedNotice', () => {
  const at = new Date('2026-10-04T18:00:00Z')
  it('says the true reason, and "open to everyone" only while the event is not over', () => {
    expect(caService.eventReleasedNotice({ areaName: 'Pool', how: 'not_paid', endsAt: '2026-10-04T20:00:00Z', now: at }))
      .toBe('Your private event at Pool was released because the deposit wasn\u2019t paid by the start time. The space is open to everyone as usual.')
    expect(caService.eventReleasedNotice({ areaName: 'Pool', how: 'did_not_go_through', endsAt: '2026-10-04T17:00:00Z', now: at }))
      .toBe('Your private event at Pool was released because the payment for its deposit did not go through.')
    expect(caService.eventReleasedNotice({ areaName: 'Pool', how: 'taken_back', endsAt: '2026-10-04T18:00:00Z', now: at }))
      .toBe('Your private event at Pool was released because the payment for its deposit was taken back by a dispute or bank return.')
  })
})
