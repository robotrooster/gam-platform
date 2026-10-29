/**
 * 10/21 (Nic) — PAID FOR, AND NOBODY CAN REACH THEM.
 *
 *   "if it goes to a typoed folder or bounces, how would the tenant sign in to
 *    complete the check if they can't sign in with a typoed email? Because they
 *    would need the two-factor authentication anyway, right? And then nothing
 *    shows the desk it's waiting. Yeah, we need a way to resend it."
 *
 * The hole was not a missing button. A check bought at the counter is found
 * again BY THE EMAIL THE STAY WAS SOLD TO. Every GAM account is created with
 * email 2FA on and login needs a verified address, so a guest whose address was
 * mistyped cannot read the code — and signing up with their real address does
 * not rescue them either, because the paid check is keyed to the wrong one and
 * would not be found. They would be asked to pay a second time. Their money sat
 * there and the only trace was a line in a log.
 *
 * So the test that matters most here is the last one: correcting the address
 * MOVES the check, and the person at the real address is then found by it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const sent: { to: string; prepaid: boolean }[] = []
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: vi.fn(async (to: string, _n: any, _p: any, _u: any, ctx: any) => {
    sent.push({ to, prepaid: !!ctx?.prepaid })
  }),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

const SECRET = 'test-secret-screening-waiting'
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/background', backgroundRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => { await cleanupAllSchema(); process.env.JWT_SECRET = SECRET; sent.length = 0 })

interface W { landlordId: string; propertyId: string; unitId: string; token: string; otherToken: string }

async function world(): Promise<W> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const other = await seedLandlord(c)
    await c.query('COMMIT')
    const tok = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: `ll-${lid.slice(0, 6)}@t.dev`, landlordIds: [lid], permissions: {} },
      SECRET, { expiresIn: '1h' })
    return { landlordId, propertyId, unitId, token: tok(userId, landlordId), otherToken: tok(other.userId, other.landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A stay sold at the counter, and the check that was paid for with it. */
async function paidCheck(w: W, email: string | null, o: { status?: string; name?: string } = {}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out,
                                status, lease_type, total_amount, screening_required)
     VALUES ($1,$2,$3,$4, CURRENT_DATE + 2, CURRENT_DATE + 26, 'confirmed','month_to_month',900,TRUE)
     RETURNING id`, [w.unitId, w.landlordId, o.name ?? 'Dale Carter', email])
  const { rows: [sp] } = await db.query<{ id: string }>(
    `INSERT INTO screening_prepayments (landlord_id, property_id, booking_id, email, amount, source, status)
     VALUES ($1,$2,$3,$4,46.03,'register',$5) RETURNING id`,
    [w.landlordId, w.propertyId, b.id, email, o.status ?? 'unused'])
  return sp.id
}

const waiting = (w: W, q = '') => request(app()).get(`/api/background/waiting${q}`).set('Authorization', `Bearer ${w.token}`)
const resend = (w: W, id: string, body: any = {}) =>
  request(app()).post(`/api/background/waiting/${id}/resend`).set('Authorization', `Bearer ${w.token}`).send(body)

describe('background checks paid for and waiting on the guest', () => {
  it('lists who paid, what they paid, and the address the link would actually go to', async () => {
    const w = await world()
    await paidCheck(w, 'dale@typo.dev')
    const res = await waiting(w)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({
      amount: 46.03, source: 'register', guest_name: 'Dale Carter',
      sends_to: 'dale@typo.dev', property_name: expect.any(String),
    })
  })

  it('shows only this account\'s, and never another landlord\'s', async () => {
    const w = await world()
    const id = await paidCheck(w, 'dale@typo.dev')
    const theirs = await request(app()).get('/api/background/waiting').set('Authorization', `Bearer ${w.otherToken}`)
    expect(theirs.body.data).toEqual([])
    // And they cannot reach into it by id either.
    const grab = await request(app()).post(`/api/background/waiting/${id}/resend`)
      .set('Authorization', `Bearer ${w.otherToken}`).send({})
    expect(grab.status).toBe(404)
    expect(sent).toEqual([])
  })

  it('a check already done, or taken back, is not waiting on anybody', async () => {
    const w = await world()
    const used = await paidCheck(w, 'done@t.dev', { status: 'used' })
    const voided = await paidCheck(w, 'gone@t.dev', { status: 'void' })
    expect((await waiting(w)).body.data).toEqual([])
    expect((await resend(w, used)).status).toBe(409)
    expect((await resend(w, voided)).status).toBe(409)
    expect(sent).toEqual([])
  })

  it('sends the link again, and says it is already paid for', async () => {
    const w = await world()
    const id = await paidCheck(w, 'dale@real.dev')
    const res = await resend(w, id)
    expect(res.status).toBe(200)
    expect(res.body.data.sentTo).toBe('dale@real.dev')
    expect(sent).toEqual([{ to: 'dale@real.dev', prepaid: true }])
  })

  it('refuses an address that is not one', async () => {
    const w = await world()
    const id = await paidCheck(w, 'dale@real.dev')
    const res = await resend(w, id, { email: 'dale at real dot dev' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not look like an email/i)
    expect(sent).toEqual([])
  })

  it('a check sold with no address at all says so instead of failing quietly', async () => {
    const w = await world()
    const id = await paidCheck(w, null)
    const res = await resend(w, id)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no email address/i)
    // And once one is typed in, it goes.
    expect((await resend(w, id, { email: 'Found@Later.dev' })).status).toBe(200)
    expect(sent).toEqual([{ to: 'found@later.dev', prepaid: true }])
  })

  it('CORRECTING the address moves the check to it — the whole point', async () => {
    const w = await world()
    const id = await paidCheck(w, 'dale@typo.dev')
    const res = await resend(w, id, { email: '  Dale@Real.dev ' })
    expect(res.status).toBe(200)
    expect(res.body.data.sentTo).toBe('dale@real.dev')
    expect(sent).toEqual([{ to: 'dale@real.dev', prepaid: true }])

    // The record moved, not just the one email. This is what lets the person at
    // the real address be matched to the money (routes/background
    // unusedScreeningPrepayment matches on it) instead of being charged twice.
    const { rows: [sp] } = await db.query<{ email: string }>(
      `SELECT email FROM screening_prepayments WHERE id = $1`, [id])
    expect(sp.email).toBe('dale@real.dev')
    expect((await waiting(w)).body.data[0].sends_to).toBe('dale@real.dev')
  })

  it('narrows to one park when the desk is standing in one', async () => {
    const w = await world()
    await paidCheck(w, 'here@t.dev')
    expect((await waiting(w, `?propertyId=${w.propertyId}`)).body.data).toHaveLength(1)
    expect((await waiting(w, `?propertyId=${randomUUID()}`)).body.data).toEqual([])
  })
})
