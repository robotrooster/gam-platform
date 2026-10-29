/**
 * 10/20 — THE EXTRA ZERO ON A MOVE-OUT READ.
 *
 * Nic's monthly reading run has held an implausible read for the landlord since
 * S533: usage over the utility type's threshold flags, bills nothing, and waits
 * for a human to look at it. The move-out read never got that guard, and the
 * move-out read is the one that cannot afford to be missing it — the monthly
 * one sits on a bill nobody has sent yet, while this one bills, invoices and
 * emails the departing tenant in the same breath.
 *
 * The case, as it happened on paper: electric submeter, six-digit face, twelve
 * cents a kWh, the read before is 12000. At the counter the clerk types 120000.
 * Nothing stopped it — 120000 is under the six-digit cap and it is ABOVE the
 * previous read, so the rollover guard never looked at it — and 108,000 kWh
 * went out as a $12,960 final bill, invoiced, emailed to the person driving
 * away, pointed at their deposit. The desk saw "Read recorded — final bill
 * created" and no figure at all.
 *
 * What is tested is the guard AND the way out of it, because a hold that no
 * human can finish is the same money lost by a quieter route:
 *
 *   - the typo bills nothing, invoices nobody, emails nobody;
 *   - the desk stays BLIND — told the situation, never the number, never which
 *     way they were off;
 *   - the landlord's double-check queue shows the read beside the one before it,
 *     which is the one surface that is allowed to;
 *   - correcting it there bills the real usage, same day;
 *   - CONFIRMING it bills the big number — a read the landlord says is genuine
 *     must never be held forever;
 *   - a space move's held closing read still bills the old space with no "final
 *     bill" email, because the resident never left;
 *   - and an ordinary move-out read is untouched.
 *
 * Run (the migration this needs is deliberately not on production yet):
 *
 *   DB_NAME=gam_cb_test TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *     npx vitest run routes/utilityMoveOutReadDoubleCheck.test
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'
import { billMoveOutRead } from '../services/utilityBilling'
import { camelCaseKeys } from '../lib/caseConversion'

function buildApp() {
  const app = express()
  app.use(express.json())
  // The API camelizes every response; the landlord's double-check queue reads
  // camelCase off this one, so the test has to see what the browser sees.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_move_out_double_check'
})

/** An electric submeter at 12c/kWh on a six-digit face, read 12000 ten days
 *  ago, with one household on the space who owes their own electric. */
async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: l.landlordId })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`UPDATE utility_meters SET rate_per_unit = 0.12, base_fee = 0 WHERE id = $1`, [meterId])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: l.landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'electric', TRUE)`, [leaseId])
    await c.query(`UPDATE leases SET start_date = CURRENT_DATE - 200 WHERE id = $1`, [leaseId])
    // The read before: ten days ago, 12000.
    await c.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 10, 12000, date_trunc('month', CURRENT_DATE - 10)::date, $2, 'monthly_cycle')`,
      [meterId, l.userId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId: l.userId, role: 'landlord', email: 'owner@t.dev', profileId: l.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ...l, propertyId, unitId, meterId, tenantId, leaseId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The desk recording a final read, exactly as the reads-due to-do posts it. */
const recordFinalRead = (f: { meterId: string; token: string; leaseId: string }, readingValue: number) =>
  request(buildApp()).post(`/api/utility/meters/${f.meterId}/reads`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({ readingValue, reason: 'move_out_final', leaseId: f.leaseId })

const resolve = (f: { token: string }, readingId: string, body: object) =>
  request(buildApp()).post(`/api/utility/readings/${readingId}/resolve-review`)
    .set('Authorization', `Bearer ${f.token}`).send(body)

const bills = async (meterId: string) =>
  (await db.query<{ usage: number; charge: number; status: string; payment_id: string | null }>(
    `SELECT usage_amount::float AS usage, charge_amount::float AS charge, status, payment_id
       FROM utility_bills WHERE meter_id = $1 ORDER BY created_at`, [meterId])).rows

const finalInvoiceNotices = async () =>
  (await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'final_utility_invoice'`)).rows[0].n

const flaggedRead = async (meterId: string) =>
  (await db.query<any>(
    `SELECT reading_value::float AS reading_value, needs_review, review_note, reason,
            move_out_lease_id, move_out_space_move
       FROM utility_meter_readings WHERE meter_id = $1 AND reason <> 'monthly_cycle'
       ORDER BY created_at DESC LIMIT 1`, [meterId])).rows[0]

/** Every leaf value in an answer, as text — for asking "is the number in here
 *  anywhere" without a substring scan across ids that happen to contain it. */
function leaves(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(x => leaves(x, out))
  else if (v != null) out.push(String(v))
  return out
}

describe('a move-out read with a slipped digit waits for the landlord', () => {
  it('120000 for 12000: nothing is billed, nothing is invoiced, nobody is emailed', async () => {
    const f = await seed()
    const r = await recordFinalRead(f, 120000)
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(false)

    // No $12,960 anywhere: no charge, no invoice, no payment, no notice.
    expect(await bills(f.meterId)).toEqual([])
    expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM payments WHERE type = 'utility'`)).rows).toHaveLength(0)
    expect(await finalInvoiceNotices()).toBe(0)

    // The read is KEPT (it is the next arrival's baseline) and it is now the
    // landlord's to settle, with the household the desk named carried on it.
    const read = await flaggedRead(f.meterId)
    expect(read.reading_value).toBe(120000)
    expect(read.needs_review).toBe(true)
    expect(read.review_note).toMatch(/108,000/)
    expect(read.move_out_lease_id).toBe(f.leaseId)
  })

  it('the desk stays blind: the answer names the situation, never the number', async () => {
    const f = await seed()
    const r = await recordFinalRead(f, 120000)
    const text = leaves(r.body)
    for (const n of ['120000', '108000', '108,000', '12960', '12,960', '12000']) {
      expect(text.some(v => v.includes(n))).toBe(false)
    }
    // It still says WHY it did not bill (S639) — a reason, not a reading.
    expect(r.body.data.billingNote).toMatch(/double-check/i)
    expect(r.body.data.billingNote).not.toMatch(/\d/)
  })

  it('the landlord — and only the landlord — sees it beside the read before it', async () => {
    const f = await seed()
    await recordFinalRead(f, 120000)
    const q = await request(buildApp())
      .get(`/api/utility/readings/flagged?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toHaveLength(1)
    expect(Number(q.body.data[0].readingValue)).toBe(120000)
    expect(Number(q.body.data[0].priorReadingValue)).toBe(12000)
  })

  it('corrected in the double-check window, the real final bill goes out the same day', async () => {
    const f = await seed()
    const held = await recordFinalRead(f, 120000)
    const r = await resolve(f, held.body.data.id, { correctedValue: 12500 })
    expect(r.status).toBe(200)
    expect(r.body.data.billsCreated).toBe(1)

    // 500 kWh at 12c — not 108,000 — invoiced and on a payment, today.
    const rows = await bills(f.meterId)
    expect(rows).toHaveLength(1)
    expect(rows[0].usage).toBe(500)
    expect(rows[0].charge).toBe(60)
    expect(rows[0].status).toBe('billed')
    expect(rows[0].payment_id).not.toBeNull()
    const inv = await db.query<{ due_date: string; total: number }>(
      `SELECT due_date::text AS due_date, total_amount::float AS total FROM invoices`)
    expect(inv.rows).toHaveLength(1)
    expect(inv.rows[0].total).toBe(60)
    expect(await finalInvoiceNotices()).toBeGreaterThan(0)
  })

  it('confirmed genuine, it bills — a read the landlord has looked at is never held again', async () => {
    const f = await seed()
    const held = await recordFinalRead(f, 120000)
    // No corrected value: the landlord re-checked the meter and the face really
    // does read 120000 (a shop on the space, a month of welding).
    const r = await resolve(f, held.body.data.id, {})
    expect(r.status).toBe(200)
    expect(r.body.data.billsCreated).toBe(1)
    const rows = await bills(f.meterId)
    expect(rows).toHaveLength(1)
    expect(rows[0].usage).toBe(108000)
    expect(rows[0].charge).toBe(12960)
    expect((await flaggedRead(f.meterId)).needs_review).toBe(false)
  })

  it('a space move\'s held closing read bills the old space with no "final bill" email', async () => {
    const f = await seed()
    // The closing read a space move takes, held by the same guard.
    const read = await db.query<{ id: string }>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason, reason_note)
       VALUES ($1, CURRENT_DATE, 120000, date_trunc('month', CURRENT_DATE)::date, $2, 'other', 'Closing read')
       RETURNING id`, [f.meterId, f.userId])
    const first = await billMoveOutRead(f.meterId, read.rows[0].id, { leaseId: f.leaseId, spaceMove: true })
    expect(first.billed).toBe(false)
    expect((await flaggedRead(f.meterId)).move_out_space_move).toBe(true)

    const r = await resolve(f, read.rows[0].id, { correctedValue: 12500 })
    expect(r.status).toBe(200)
    expect(r.body.data.billsCreated).toBe(1)
    // The resident is staying: the old space's usage rides their next regular
    // bill, so there is no final invoice and no "your last days" notice.
    const rows = await bills(f.meterId)
    expect(rows).toHaveLength(1)
    expect(rows[0].usage).toBe(500)
    expect(rows[0].payment_id).toBeNull()
    expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
    expect(await finalInvoiceNotices()).toBe(0)
  })

  it('an ordinary move-out read is untouched — it bills and invoices on the spot', async () => {
    const f = await seed()
    const r = await recordFinalRead(f, 12400)
    expect(r.status).toBe(201)
    expect(r.body.data.billed).toBe(true)
    const rows = await bills(f.meterId)
    expect(rows).toHaveLength(1)
    expect(rows[0].usage).toBe(400)
    expect(rows[0].charge).toBe(48)
    expect((await flaggedRead(f.meterId)).needs_review).toBe(false)
  })
})
