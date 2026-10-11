/**
 * S652 (Nic): "When I mark it back in service, is it going to show a history of
 * how long the site was out of order?... keep track of it on the back end so we
 * can say, okay, our average RV sites, when they go down, they're down for a
 * day or 10 days."
 *
 * Putting a site back in service never deleted anything — it stamps
 * cleared_at. These cover what now READS that record: the per-site history, the
 * calendar's faded stripes, and the downtime report.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { unitsRouter } from '../routes/units'
import { reportsRouter } from '../routes/reports'
import { errorHandler } from '../middleware/errorHandler'
import { clearOutOfOrder, outOfOrderHistoryForUnit, siteDowntimeReport } from './outOfOrder'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/units', unitsRouter)
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_ooo'
})

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA') }

async function seedPark() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const site = async (n: string) => {
      const id = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
      await c.query(`UPDATE units SET unit_number = $2, unit_type = 'rv_spot', is_bookable = TRUE WHERE id = $1`, [id, n])
      return id
    }
    const s1 = await site('RV 01'), s2 = await site('RV 02'), s3 = await site('RV 03')
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, s1, s2, s3,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

// An outage as it would sit in the table `daysAgo` after being marked, and —
// when `backAfter` is given — put back in service that many days later.
async function outage(p: any, unitId: string, daysAgo: number, backAfter: number | null, reason = 'broken pedestal') {
  const { rows: [o] } = await db.query<any>(
    `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, reason, created_by, created_at, cleared_at, cleared_by)
     VALUES ($1, $2, CURRENT_DATE - $3::int, $4, $5, NOW() - ($3::int || ' days')::interval,
             CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - (($3::int - $6::int) || ' days')::interval END,
             CASE WHEN $6::int IS NULL THEN NULL ELSE $5::uuid END)
     RETURNING id`, [unitId, p.landlordId, daysAgo, reason, p.userId, backAfter])
  return o.id as string
}

describe('out-of-order history', () => {
  it('putting a site back keeps the outage, with how long it ran', async () => {
    const p = await seedPark()
    const id = await outage(p, p.s1, 9, null)
    expect(await outOfOrderHistoryForUnit(p.s1)).toEqual([])          // still out — not history yet

    await db.query(`UPDATE unit_out_of_order SET created_at = created_at WHERE id = $1`, [id])
    await clearOutOfOrder({ id, landlordId: p.landlordId, userId: p.userId })
    const h = await outOfOrderHistoryForUnit(p.s1)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ starts_on: plusDays(-9), ended_on: plusDays(0), days_out: 9, reason: 'broken pedestal', put_back: true })
  })

  it('the site\'s own list separates open from over', async () => {
    const p = await seedPark()
    await outage(p, p.s1, 20, 6)            // over: 6 days
    const open = await outage(p, p.s1, 2, null)
    const res = await request(buildApp()).get(`/api/units/${p.s1}/out-of-order?history=1`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.open.map((w: any) => w.id)).toEqual([open])
    expect(res.body.data.history).toHaveLength(1)
    expect(res.body.data.history[0].days_out).toBe(6)
    // the plain list is unchanged — open windows only, as an array
    const plain = await request(buildApp()).get(`/api/units/${p.s1}/out-of-order`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(plain.body.data.map((w: any) => w.id)).toEqual([open])
  })

  it('an outage called off before it began was never an outage', async () => {
    const p = await seedPark()
    await db.query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, created_by, cleared_at, cleared_by)
       VALUES ($1, $2, CURRENT_DATE + 10, $3, NOW(), $3)`, [p.s1, p.landlordId, p.userId])
    expect(await outOfOrderHistoryForUnit(p.s1)).toEqual([])
    const rows = await siteDowntimeReport([p.landlordId], plusDays(-400), plusDays(400))
    expect(rows).toEqual([])
  })

  it('the calendar gets finished outages separately, and they block nothing', async () => {
    const p = await seedPark()
    await outage(p, p.s1, 12, 5)             // down 5 days, back a week ago
    await outage(p, p.s2, 1, 0, 'tripped breaker')   // down and back the same day
    await outage(p, p.s3, 3, null)           // still out
    const res = await request(buildApp())
      .get(`/api/units/schedule/master?from=${plusDays(-30)}&to=${plusDays(30)}&propertyId=${p.propertyId}`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.outOfOrder.map((o: any) => o.unit_id)).toEqual([p.s3])
    const hist = res.body.data.outOfOrderHistory
    const h1 = hist.find((o: any) => o.unit_id === p.s1)
    expect(h1).toMatchObject({ starts_on: plusDays(-12), ended_on: plusDays(-7), days_out: 5 })
    // same-day: zero days long, but the day it happened still shows
    const h2 = hist.find((o: any) => o.unit_id === p.s2)
    expect(h2).toMatchObject({ starts_on: plusDays(-1), ended_on: plusDays(0), days_out: 0 })

    const free = await db.query<any>(
      `SELECT unit_out_of_order_overlaps($1, CURRENT_DATE - 10, CURRENT_DATE - 8) AS past,
              unit_out_of_order_overlaps($1, CURRENT_DATE + 1, CURRENT_DATE + 3) AS future`, [p.s1])
    expect(free.rows[0]).toEqual({ past: false, future: false })
  })
})

describe('site downtime report', () => {
  it('averages finished outages only — a site still out has no length yet', async () => {
    const p = await seedPark()
    await outage(p, p.s1, 12, 2)      // 2 days
    await outage(p, p.s2, 30, 10)     // 10 days
    await outage(p, p.s3, 45, null)   // still out, 45 days and counting
    const rows = await siteDowntimeReport([p.landlordId], plusDays(-365), plusDays(1))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      unit_type: 'rv_spot', finished: 2, avg_days: 6, longest_days: 10, out_now: 1, longest_open_days: 45,
    })
  })

  it('the report route answers in the period asked for, and only for the caller', async () => {
    const p = await seedPark()
    const other = await seedPark()
    await outage(p, p.s1, 3, 1)
    await outage(other, other.s1, 5, 4)
    const y = new Date().getFullYear()
    const res = await request(buildApp()).get(`/api/reports/site-downtime?year=${y}`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(res.status).toBe(200)
    // An outage that started late December and ended in January belongs to
    // January's year; this one may straddle, so only the ownership is asserted.
    expect(res.body.data.rows.every((r: any) => r.property_id === p.propertyId)).toBe(true)
    const last = await request(buildApp()).get(`/api/reports/site-downtime?year=${y - 3}`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(last.body.data.rows.every((r: any) => r.finished === 0)).toBe(true)
  })
})
