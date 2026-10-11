/**
 * 10/4 (decisions #47a) — the move-out page's refund routes and the owner's
 * to-do list, end to end through the real routes (Stripe mocked):
 *   GET  /api/leases/:id/deposit-return                         refund_progress
 *   POST /api/leases/:id/deposit-return/refund-parts/:part/try-again
 *   POST /api/leases/:id/deposit-return/refund-parts/:part/cash
 *   POST /api/leases/:id/deposit-return/landlord-part/handed-back
 *   POST /api/leases/:id/deposit-return/landlord-part/undo
 *   GET  /api/landlords/me/todos                                depositRefunds
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const stripeMocks = vi.hoisted(() => ({
  refundsCreate: vi.fn(async (params: any): Promise<any> => ({ id: `re_${params.payment_intent}`, status: 'succeeded' })),
  refundsList: vi.fn(async (): Promise<any> => ({ data: [] })),
  paymentIntentsRetrieve: vi.fn(async (id: string): Promise<any> => ({ id, status: 'succeeded' })),
  transfersCreate: vi.fn(async () => ({ id: 'tr_test' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getStripe: () => ({
      refunds: { create: stripeMocks.refundsCreate, list: stripeMocks.refundsList },
      paymentIntents: { retrieve: stripeMocks.paymentIntentsRetrieve },
      transfers: { create: stripeMocks.transfersCreate },
    }),
  }
})

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedSecurityDeposit,
} from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_deposit_refund_send'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leases', leasesRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.payment_intent}`, status: 'succeeded' }))
})

/** A finalized-ready move-out: $500 deposit — $300 paid by card through GAM, $200 paid at the desk — and $100 of damage. */
async function seedMoveOut() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000, unitType: 'rv_spot' })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await seedSecurityDeposit(c, { unitId, leaseId, tenantId, totalAmount: 500, heldBy: 'gam_escrow' })
    await c.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [landlordId])
    const intent = `pi_dep_${randomUUID().slice(0, 8)}`
    for (const [amount, online] of [[300, true], [200, false]] as const) {
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               settled_at, platform_held, manual_method, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'deposit',$5,'settled',CURRENT_DATE - 30,'DEPOSIT',NOW() - interval '30 days',$6,$7,$8)`,
        [unitId, leaseId, tenantId, landlordId, amount, online, online ? null : 'cash', online ? intent : null])
    }
    await c.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,300,300,'card',$4,'settled')`, [tenantId, leaseId, landlordId, intent])
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const tz = (await c.query(`SELECT timezone FROM properties WHERE id=$1`, [propertyId])).rows[0].timezone
    return { leaseId, landlordId, token, intent, tz, propertyId, userId }
  } finally { c.release() }
}

async function finalize(app: express.Express, f: { leaseId: string; token: string }) {
  const auth = { Authorization: `Bearer ${f.token}` }
  expect((await request(app).post(`/api/leases/${f.leaseId}/deposit-return`).set(auth)).status).toBeLessThan(300)
  const patched = await request(app).patch(`/api/leases/${f.leaseId}/deposit-return`).set(auth)
    .send({ damageLines: [{ description: 'Broken window', amount: 100, evidenceDocumentIds: [] }] })
  if (patched.status >= 300) {
    // The route needs a photo per damage line: put the line on the draft directly.
    await db.query(`UPDATE deposit_returns SET damage_lines = $2::jsonb WHERE lease_id = $1`,
      [f.leaseId, JSON.stringify([{ description: 'Broken window', amount: 100 }])])
  }
  const res = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/finalize`).set(auth).send({})
  expect(res.status).toBe(200)
  return res.body.data
}

describe('#47a: the move-out page shows how the refund goes back, and its buttons work', () => {
  it('GET shows each part GAM sent and the landlord’s own part; Mark handed back takes a day, refuses a second mark, and Undo backs it out', async () => {
    const app = buildApp()
    const f = await seedMoveOut()
    const auth = { Authorization: `Bearer ${f.token}` }
    const final = await finalize(app, f)
    expect(final).toMatchObject({ status: 'sent_refund', refund_from_gam: '300.00', refund_from_landlord: '100.00' })
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: f.intent, amount: 30000 })

    const got = await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)
    expect(got.status).toBe(200)
    const progress = got.body.data.refund_progress
    expect(progress.parts).toEqual([expect.objectContaining({ kind: 'card', amount: 300, status: 'refunded', done: true })])
    expect(progress.landlord_part).toEqual({ amount: 100, handed_back_on: null, handed_back_by_name: null })
    // Said to the owner in the staff voice — never "your card" / "returned to you" — and
    // how the landlord's part reaches them, never that it was already handed back (fix pass 4).
    expect(progress.reach_words).toBe('$300.00 back to the card they paid with; $100.00 back to them in cash at the office.')

    const todos = await request(app).get('/api/landlords/me/todos').set(auth)
    expect(todos.status).toBe(200)
    expect(todos.body.data.depositRefunds).toEqual([expect.objectContaining({ type: 'deposit_refund_hand_back' })])
    expect(todos.body.data.counts.depositRefunds).toBe(1)

    const today = todayIn(f.tz)
    const bad = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/landlord-part/handed-back`).set(auth)
      .send({ handedBackOn: 'yesterday' })
    expect(bad.status).toBe(400)
    const stale = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/landlord-part/handed-back`).set(auth)
      .send({ handedBackOn: today, expectedAmount: 99 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/amount to hand back changed/)
    const ok = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/landlord-part/handed-back`).set(auth)
      .send({ handedBackOn: today, expectedAmount: 100 })
    expect(ok.status).toBe(200)
    expect(ok.body.data.words[0]).toMatch(/^Marked handed back: \$100\.00 on /)
    const twice = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/landlord-part/handed-back`).set(auth)
      .send({ handedBackOn: today, expectedAmount: 100 })
    expect(twice.status).toBe(409)
    expect(twice.body.error).toMatch(/already marked handed back/)
    expect((await request(app).get('/api/landlords/me/todos').set(auth)).body.data.depositRefunds).toEqual([])
    const again = await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)
    expect(again.body.data.refund_progress.landlord_part.handed_back_on).toBe(today)

    const undo = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/landlord-part/undo`).set(auth)
    expect(undo.status).toBe(200)
    expect((await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)).body.data.refund_progress.landlord_part.handed_back_on).toBeNull()
  })

  it('a refund the card turned down: the page offers Try again and Give it back in cash instead; cash records it and pays the landlord what GAM held', async () => {
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.payment_intent}`, status: 'failed' }))
    const app = buildApp()
    const f = await seedMoveOut()
    const auth = { Authorization: `Bearer ${f.token}` }
    await finalize(app, f)
    const got = await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)
    const [part] = got.body.data.refund_progress.parts
    expect(part).toMatchObject({ status: 'failed', can_try_again: true, can_give_in_cash: true, done: false })
    expect(part.words).toMatch(/The card company turned this refund down/)
    const todos = (await request(app).get('/api/landlords/me/todos').set(auth)).body.data.depositRefunds
    expect(todos.map((t: any) => t.type).sort()).toEqual(['deposit_refund_hand_back', 'deposit_refund_not_sent'])

    // Try again — still turned down: said once (the part's own line says why), nothing else changes.
    const tried = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/refund-parts/${part.id}/try-again`).set(auth)
    expect(tried.status).toBe(200)
    expect(tried.body.data.words).toEqual(['Tried again — it did not go out. The refund below says why and what to do next.'])
    const reread = (await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)).body.data.refund_progress.parts[0]
    expect(reread.words).toMatch(/turned this refund down/)

    // The amount the page showed goes with the press: a different one is refused, nothing handed back.
    const stale = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/refund-parts/${part.id}/cash`).set(auth)
      .send({ expectedAmount: 250 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/amount to give back changed/)
    const cash = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/refund-parts/${part.id}/cash`).set(auth)
      .send({ expectedAmount: 300 })
    expect(cash.status).toBe(200)
    expect(cash.body.data).toMatchObject({ handBack: true })
    expect(cash.body.data.words[0]).toBe('Hand back $300.00 in cash now.')
    // #47c: never who held it — only where it goes.
    expect(cash.body.data.words[1]).toBe('It is recorded as given back — nothing goes to the card, and $300.00 is added to your next payout.')
    const held = (await db.query(`SELECT source_type, amount::float AS amount FROM held_payout_items WHERE source_id LIKE 'cash-part:%'`)).rows
    expect(held).toEqual([{ source_type: 'deposit_settlement', amount: 300 }])
    const after = (await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set(auth)).body.data.refund_progress
    expect(after.parts.map((p: any) => p.status)).toEqual(['handed_back'])
    // A part from another move-out is never found here.
    const wrong = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/refund-parts/${randomUUID()}/cash`).set(auth)
    expect(wrong.status).toBe(404)
  })
})

// ── Fix pass 3: who may press, checked by the server ──────────────────────────

/** A team member (on-site manager) with these permissions, on every property or only the ones named. */
async function staffToken(landlordId: string, permissions: Record<string, boolean>, scope: { all?: boolean; propertyIds?: string[] }) {
  const c = await db.connect()
  try {
    const userId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Lisa', 'Staff', TRUE) RETURNING id`, [`staff-${randomUUID()}@t.dev`])).rows[0].id
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], $4)`, [userId, landlordId, scope.propertyIds ?? [], scope.all === true])
    return jwt.sign({ userId, role: 'onsite_manager', email: 's@t.dev', landlordId, permissions },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  } finally { c.release() }
}

/** Everything the four presses could change, to prove a refused press changed nothing. */
const moneyState = async (leaseId: string) => ({
  parts: (await db.query(
    `SELECT p.id, p.kind, p.status, p.amount::float AS amount, p.failure FROM stay_refund_parts p
       JOIN deposit_returns dr ON dr.id = p.deposit_return_id WHERE dr.lease_id = $1 ORDER BY p.created_at, p.id`, [leaseId])).rows,
  handedBack: (await db.query(`SELECT landlord_part_handed_back_on FROM deposit_returns WHERE lease_id = $1`, [leaseId])).rows,
  held: (await db.query(`SELECT source_id, amount::float AS amount FROM held_payout_items ORDER BY source_id`)).rows,
})

describe('Fix pass 3: the four refund presses are checked on the server, not only hidden on the page', () => {
  async function failedMoveOut() {
    // The card refund is turned down, so a part waits for Try again or cash.
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.payment_intent}`, status: 'failed' }))
    const app = buildApp()
    const f = await seedMoveOut()
    await finalize(app, f)
    const [part] = (await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set({ Authorization: `Bearer ${f.token}` }))
      .body.data.refund_progress.parts
    return { app, f, part }
  }
  const presses = (leaseId: string, partId: string) => [
    { url: `/api/leases/${leaseId}/deposit-return/refund-parts/${partId}/try-again`, body: {} },
    { url: `/api/leases/${leaseId}/deposit-return/refund-parts/${partId}/cash`, body: { expectedAmount: 300 } },
    { url: `/api/leases/${leaseId}/deposit-return/landlord-part/handed-back`, body: { handedBackOn: '2026-10-04', expectedAmount: 100 } },
    { url: `/api/leases/${leaseId}/deposit-return/landlord-part/undo`, body: {} },
  ]

  it('a team member without "Deposit return / move-out" gets 403 on Try again, cash, Mark handed back and Undo — and nothing changes', async () => {
    const { app, f, part } = await failedMoveOut()
    const before = await moneyState(f.leaseId)
    const calls = stripeMocks.refundsCreate.mock.calls.length
    const staff = await staffToken(f.landlordId, { 'pos.refund': true }, { all: true })
    for (const p of presses(f.leaseId, part.id)) {
      const res = await request(app).post(p.url).set('Authorization', `Bearer ${staff}`).send(p.body)
      expect(res.status).toBe(403)
    }
    expect(await moneyState(f.leaseId)).toEqual(before)
    expect(stripeMocks.refundsCreate.mock.calls.length).toBe(calls)
  })

  it('a team member locked to another property gets 403 in plain words on each press — and nothing changes', async () => {
    const { app, f, part } = await failedMoveOut()
    const c = await db.connect()
    let other: string
    try { other = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId }) }
    finally { c.release() }
    const before = await moneyState(f.leaseId)
    const calls = stripeMocks.refundsCreate.mock.calls.length
    const staff = await staffToken(f.landlordId, { 'leases.deposit_return': true, 'pos.refund': true }, { propertyIds: [other!] })
    const { DEPOSIT_RETURN_SCOPE_WORDS } = await import('./leases')
    for (const p of presses(f.leaseId, part.id)) {
      const res = await request(app).post(p.url).set('Authorization', `Bearer ${staff}`).send(p.body)
      expect(res.status).toBe(403)
      expect(res.body.error).toBe(DEPOSIT_RETURN_SCOPE_WORDS)
    }
    expect(await moneyState(f.leaseId)).toEqual(before)
    expect(stripeMocks.refundsCreate.mock.calls.length).toBe(calls)
  })

  it('opening the move-out as a read-only viewer moves no money (a part left "sending" is not resent), and the refund progress still shows', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const app = buildApp()
    const f = await seedMoveOut()
    await finalize(app, f)
    // As if a crash left the part "sending" for more than ten minutes.
    await db.query(
      `UPDATE stay_refund_parts p SET status = 'pending', failure = NULL, created_at = NOW() - interval '1 hour'
         FROM deposit_returns dr WHERE dr.id = p.deposit_return_id AND dr.lease_id = $1`, [f.leaseId])
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.payment_intent}`, status: 'succeeded' }))
    const calls = stripeMocks.refundsCreate.mock.calls.length
    const before = await moneyState(f.leaseId)
    const reader = await staffToken(f.landlordId, {}, { all: true })
    const got = await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set('Authorization', `Bearer ${reader}`)
    expect(got.status).toBe(200)
    expect(got.body.data.viewer_can_run_move_out).toBe(false)
    expect(got.body.data.refund_progress.parts).toEqual([expect.objectContaining({ amount: 300, status: 'pending', done: false })])
    expect(got.body.data.refund_progress.landlord_part).toMatchObject({ amount: 100 })
    expect(stripeMocks.refundsCreate.mock.calls.length).toBe(calls)
    expect(await moneyState(f.leaseId)).toEqual(before)
  })

  it('GAM staff (admin) giving a part back in cash are told "the landlord\'s next payout" — never "your"', async () => {
    const { app, f, part } = await failedMoveOut()
    const adminId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'Gam', 'Admin', TRUE) RETURNING id`, [`admin-${randomUUID()}@t.dev`])).rows[0].id
    const admin = jwt.sign({ userId: adminId, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const got = await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set('Authorization', `Bearer ${admin}`)
    expect(got.body.data).toMatchObject({ viewer_is_owner: true, viewer_is_landlord: false })
    const cash = await request(app).post(`/api/leases/${f.leaseId}/deposit-return/refund-parts/${part.id}/cash`)
      .set('Authorization', `Bearer ${admin}`).send({ expectedAmount: 300 })
    expect(cash.status).toBe(200)
    expect(cash.body.data.words[1]).toBe('It is recorded as given back — nothing goes to the card, and $300.00 is added to the landlord\'s next payout.')
    expect((await request(app).get(`/api/leases/${f.leaseId}/deposit-return`).set({ Authorization: `Bearer ${f.token}` })).body.data.viewer_is_landlord).toBe(true)
  })
})
