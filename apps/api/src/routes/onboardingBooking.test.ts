/**
 * S605: token-prefilled onboarding-call booking.
 * Covers the security property that matters — identity comes from the TOKEN,
 * never from the request body — plus prefill, enumeration-safety, and expiry.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Two limiters cover these routes: the router-wide sales limiter (15/min) and
// the tight demo-booking limiter on the POST (5 per 10 min). Every request in
// this suite comes from one IP, so both trip mid-run. Raise them for the suite;
// each reads `max` per-request, so setting the env here is enough. That they
// trip at all confirms both correctly cover the new endpoints.
process.env.DEMO_BOOK_RATE_MAX = '1000'
process.env.SALES_AGENT_RATE_MAX = '1000'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailDemoBookingConfirmation: vi.fn(async () => 'x'),
  sendDemoBookedHeadsUp: vi.fn(async () => 'x'),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { salesAgentRouter } from './agent'
import { errorHandler } from '../middleware/errorHandler'

// Mount just the router under test — importing ../index would boot a second
// listener on :4000 and collide with the running dev/prod API.
function buildApp() {
  const a = express()
  a.use(express.json())
  a.use('/api/sales', salesAgentRouter)
  a.use(errorHandler)
  return a
}
const app = buildApp()

const OFFERED = async (): Promise<string> => {
  const r = await request(app).get('/api/sales/onboarding/slots')
  const days = r.body?.data?.days || []
  const first = days[0]?.slots?.[0]?.startsAt
  if (!first) throw new Error('no onboarding slots offered — availability missing?')
  return first
}

async function seedTokenFor(opts: { expired?: boolean } = {}) {
  const client = await db.connect()
  let landlordId = '', userId = ''
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client, { firstName: 'Charlie', lastName: 'Moore' })
    landlordId = ll.landlordId; userId = ll.userId
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

  await db.query(`UPDATE users SET phone = '6025551234' WHERE id = $1`, [userId])
  const t = await db.query<{ token: string }>(
    `INSERT INTO landlord_onboarding_booking_tokens (user_id, landlord_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval) RETURNING token`,
    [userId, landlordId, opts.expired ? '-1' : '30'])
  return { token: t.rows[0].token, userId, landlordId }
}

beforeEach(async () => {
  await cleanupAllSchema()
  // BOTH kinds, same Mon–Fri 1–4pm block as production. Demo availability isn't
  // incidental here: without it the cross-kind test below would compare against
  // an empty demo list and pass whether or not the exclusion actually works.
  for (const kind of ['onboarding', 'demo']) {
    await db.query(
      `INSERT INTO sales_call_availability (weekday, start_time, end_time, kind, active)
       SELECT d, TIME '13:00', TIME '16:00', $1, TRUE FROM generate_series(1,5) AS d`, [kind])
  }
})

describe('GET /api/sales/onboarding/prefill/:token', () => {
  it('returns the landlord’s own identity, and nothing else', async () => {
    const { token } = await seedTokenFor()
    const r = await request(app).get(`/api/sales/onboarding/prefill/${token}`).expect(200)

    expect(r.body.data).toMatchObject({ firstName: 'Charlie', name: 'Charlie Moore' })
    expect(r.body.data.email).toContain('@')
    // No account/portfolio state leaks to a token holder.
    expect(Object.keys(r.body.data).sort()).toEqual(['email', 'firstName', 'name', 'phone'])
  })

  it('unknown, malformed and expired tokens are indistinguishable (all 404)', async () => {
    const { token: expired } = await seedTokenFor({ expired: true })
    for (const t of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid', expired]) {
      const r = await request(app).get(`/api/sales/onboarding/prefill/${t}`)
      expect(r.status).toBe(404)
      expect(r.body.error).toBe('Not found')
    }
  })
})

describe('POST /api/sales/onboarding', () => {
  it('books using the identity on the TOKEN, ignoring any name/email in the body', async () => {
    const { token, userId } = await seedTokenFor()
    const startsAt = await OFFERED()
    const real = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])

    const r = await request(app).post('/api/sales/onboarding').send({
      token, startsAt, unitRange: '11–50',
      // An attacker's attempt to book in someone else's name:
      name: 'Someone Else', email: 'attacker@evil.test',
    }).expect(201)

    expect(r.body.data.startsAt).toBe(startsAt)
    const slot = await db.query<{ prospect_email: string; prospect_name: string; kind: string }>(
      `SELECT prospect_email, prospect_name, kind FROM sales_call_slots WHERE starts_at = $1`, [startsAt])
    expect(slot.rows[0].kind).toBe('onboarding')
    expect(slot.rows[0].prospect_email).toBe(real.rows[0].email)
    expect(slot.rows[0].prospect_email).not.toBe('attacker@evil.test')
    expect(slot.rows[0].prospect_name).toBe('Charlie Moore')
  })

  it('rejects a bad token without booking anything', async () => {
    const startsAt = await OFFERED()
    await request(app).post('/api/sales/onboarding')
      .send({ token: '00000000-0000-0000-0000-000000000000', startsAt }).expect(404)
    const n = await db.query<{ c: string }>(`SELECT count(*) AS c FROM sales_call_slots`)
    expect(Number(n.rows[0].c)).toBe(0)
  })

  it('rejects a time that was never offered', async () => {
    const { token } = await seedTokenFor()
    await request(app).post('/api/sales/onboarding')
      .send({ token, startsAt: '2026-08-17T09:00:00.000Z' }).expect(409)
  })

  it('an onboarding booking blocks that same slot for a demo — one rep, one calendar', async () => {
    const { token } = await seedTokenFor()
    const startsAt = await OFFERED()

    const demoSlots = async () => {
      const r = await request(app).get('/api/sales/demo/slots')
      return (r.body?.data?.days || []).flatMap((d: any) => d.slots || []).map((s: any) => s.startsAt)
    }
    // Guard the assertion below against passing vacuously on an empty list.
    expect(await demoSlots()).toContain(startsAt)

    await request(app).post('/api/sales/onboarding').send({ token, startsAt }).expect(201)

    expect(await demoSlots()).not.toContain(startsAt)
  })

  it('stays redeemable after use, so a reschedule from the same email still works', async () => {
    const { token } = await seedTokenFor()
    const startsAt = await OFFERED()
    await request(app).post('/api/sales/onboarding').send({ token, startsAt }).expect(201)

    // Token still resolves — used_at is recorded but never gates redemption.
    await request(app).get(`/api/sales/onboarding/prefill/${token}`).expect(200)
    const used = await db.query<{ used_at: Date | null }>(
      `SELECT used_at FROM landlord_onboarding_booking_tokens WHERE token = $1`, [token])
    expect(used.rows[0].used_at).not.toBeNull()
  })
})
