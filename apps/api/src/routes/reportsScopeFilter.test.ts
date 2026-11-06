/**
 * 11/3 (Nic): THE REPORTS OVERVIEW NARROWS TO ONE COMPANY OR ONE PROPERTY.
 *
 *   "there's no filter to sort that monthly itemized monthly breakdown by
 *    property. Or by company. So you can't choose TruBlu Management or Oak
 *    Park Motel and RV until after you click into a specific month."
 *
 * What these pin, deliberately as RELATIONSHIPS between the slices rather than
 * as dollar figures, so the suite says something true about the rule instead of
 * re-stating the fixture:
 *
 *  - the slices ADD UP to the whole: company A's figures plus company B's are
 *    the unfiltered account's. A filter that double-counted, dropped a company
 *    or quietly ignored the parameter all break this one assertion.
 *  - the filter NARROWS, never widens: another account's company or property is
 *    refused, and a mismatched pair is refused.
 *  - a payout is per COMPANY. Filtered to one property of a company holding
 *    several there is no such figure, and the reply says so rather than
 *    reporting the whole company's payout beside one property's income.
 *  - the picker's options are the viewer's WHOLE scope, never the narrowed one
 *    — read off the narrowed scope the control would collapse to the company
 *    just chosen with no way back.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/reports', reportsRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reports_scope'
})

/** A park with a tenant on a lease and one settled rent payment due today. */
async function park(c: any, opts: { landlordId: string; userId: string; name: string; amount: number }) {
  const propertyId = await seedProperty(c, {
    landlordId: opts.landlordId, ownerUserId: opts.userId, managedByUserId: opts.userId })
  await c.query(`UPDATE properties SET name = $2, created_at = '2024-01-01' WHERE id = $1`, [propertyId, opts.name])
  const unitId = await seedUnit(c, { propertyId, landlordId: opts.landlordId })
  const tenantId = await seedTenant(c)
  const leaseId = await seedLease(c, { unitId, landlordId: opts.landlordId })
  await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
  // S655/dbHelpers convention: no settle time means paid AT NOON PHOENIX on the
  // due date, so "received" (settle day) and "billed" (due date) land in the
  // same month however late in the UTC day the suite runs.
  await c.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
                           entry_description, due_date, settled_at)
     VALUES ($1,$2,$3,'rent',$4,'settled','RENT', CURRENT_DATE,
             (CURRENT_DATE + TIME '12:00') AT TIME ZONE 'America/Phoenix')`,
    [unitId, tenantId, opts.landlordId, opts.amount])
  return { propertyId, unitId, tenantId, leaseId }
}

interface World {
  token: string; outsiderToken: string
  coA: string; coB: string
  propA: string; propB: string
  unitB: string; tenantB: string; userId: string
  outsiderCo: string; outsiderProp: string
}

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    // ONE ACCOUNT, TWO COMPANIES — the shape the filter exists for.
    const { userId, landlordId: coA } = await seedLandlord(c)
    const coB = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`,
      [userId])).rows[0].id
    await c.query(`UPDATE landlords SET business_name = 'Alpha Acres LLC' WHERE id = $1`, [coA])
    await c.query(`UPDATE landlords SET business_name = 'Beta Parks LLC'  WHERE id = $1`, [coB])
    const a = await park(c, { landlordId: coA, userId, name: 'Alpha Park', amount: 300 })
    const b = await park(c, { landlordId: coB, userId, name: 'Beta Park',  amount: 700 })
    // A payout stamped on company B only.
    await c.query(
      `INSERT INTO disbursements (user_id, landlord_id, amount, fee_charged, status, trigger_type, created_at)
       VALUES ($1, $2, 500, 5, 'settled', 'auto_friday', NOW())`, [userId, coB])

    // A different account entirely, for the refusals.
    const { userId: outUid, landlordId: outsiderCo } = await seedLandlord(c)
    const out = await park(c, { landlordId: outsiderCo, userId: outUid, name: 'Someone Else', amount: 900 })

    return {
      token: sign({ userId, role: 'landlord', email: 'owner@t.dev', profileId: null,
                    landlordIds: [coA, coB], permissions: {} }),
      outsiderToken: sign({ userId: outUid, role: 'landlord', email: 'out@t.dev', profileId: null,
                            landlordIds: [outsiderCo], permissions: {} }),
      coA, coB, propA: a.propertyId, propB: b.propertyId,
      unitB: b.unitId, tenantB: b.tenantId, userId,
      outsiderCo, outsiderProp: out.propertyId,
    }
  } finally { c.release() }
}

const summary = (token: string, qs = '') =>
  request(app()).get(`/api/reports/summary${qs}`).set('Authorization', `Bearer ${token}`)

describe('GET /api/reports/summary — one company or one property', () => {
  it('the slices add up to the whole account, every figure together', async () => {
    const w = await world()
    const all = (await summary(w.token)).body.data
    const onlyA = (await summary(w.token, `?landlordId=${w.coA}`)).body.data
    const onlyB = (await summary(w.token, `?landlordId=${w.coB}`)).body.data

    expect(all.thisMonth.received).toBeCloseTo(onlyA.thisMonth.received + onlyB.thisMonth.received, 2)
    expect(all.thisMonth.charged).toBeCloseTo(onlyA.thisMonth.charged + onlyB.thisMonth.charged, 2)
    expect(all.ytd.received).toBeCloseTo(onlyA.ytd.received + onlyB.ytd.received, 2)
    // Each company really is a different slice, not the same answer twice.
    expect(onlyA.thisMonth.received).toBeGreaterThan(0)
    expect(onlyB.thisMonth.received).toBeGreaterThan(onlyA.thisMonth.received)
    // No third company leaked into the account total — which the equality
    // above already proves, since A + B accounts for all of it — and the other
    // account reads its own park and nothing of this one's.
    const outsider = (await summary(w.outsiderToken)).body.data
    expect(outsider.thisMonth.received).toBeGreaterThan(0)
    expect(outsider.scope.companies).toHaveLength(1)
  })

  it('the monthly rows narrow with it, and their months stay the same months', async () => {
    const w = await world()
    const all = (await summary(w.token)).body.data
    const onlyA = (await summary(w.token, `?landlordId=${w.coA}`)).body.data
    expect(onlyA.monthly.map((m: any) => m.month)).toEqual(all.monthly.map((m: any) => m.month))
    const sum = (d: any) => d.monthly.reduce((t: number, m: any) => t + Number(m.received || 0), 0)
    const onlyB = (await summary(w.token, `?landlordId=${w.coB}`)).body.data
    expect(sum(all)).toBeCloseTo(sum(onlyA) + sum(onlyB), 2)
  })

  it('a property of a one-property company reads the same as that company', async () => {
    const w = await world()
    const byCompany = (await summary(w.token, `?landlordId=${w.coA}`)).body.data
    const byProperty = (await summary(w.token, `?propertyId=${w.propA}`)).body.data
    expect(byProperty.thisMonth.received).toBeCloseTo(byCompany.thisMonth.received, 2)
    // A payout IS that property's, because the company holds nothing else.
    expect(byProperty.scope.payoutsBelongHere).toBe(true)
  })

  it('offers the whole scope as options even while narrowed to one company', async () => {
    const w = await world()
    for (const qs of ['', `?landlordId=${w.coA}`, `?propertyId=${w.propA}`]) {
      const { scope } = (await summary(w.token, qs)).body.data
      expect(scope.companies.map((c: any) => c.name).sort()).toEqual(['Alpha Acres LLC', 'Beta Parks LLC'])
      expect(scope.companies.flatMap((c: any) => c.properties.map((p: any) => p.name)).sort())
        .toEqual(['Alpha Park', 'Beta Park'])
    }
    // The reply says which slice it is, so the screen can label the figures.
    expect((await summary(w.token, `?landlordId=${w.coA}`)).body.data.scope.landlordId).toBe(w.coA)
    expect((await summary(w.token, `?propertyId=${w.propA}`)).body.data.scope.propertyId).toBe(w.propA)
  })

  it('a payout follows its company, and never another one', async () => {
    const w = await world()
    const paid = (d: any) => d.monthly.reduce((t: number, m: any) => t + Number(m.disbursed || 0), 0)
    expect(paid((await summary(w.token, `?landlordId=${w.coB}`)).body.data)).toBeCloseTo(500, 2)
    expect(paid((await summary(w.token, `?landlordId=${w.coA}`)).body.data)).toBe(0)
    expect(paid((await summary(w.token)).body.data)).toBeCloseTo(500, 2)
  })

  it('one property of a company holding several reports NO payout of its own', async () => {
    const w = await world()
    // Give company B a second park, so "the company" and "the property" differ.
    const c = await db.connect()
    try {
      const { rows: [u] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM landlords WHERE id = $1`, [w.coB])
      await park(c, { landlordId: w.coB, userId: u.user_id, name: 'Beta Park Two', amount: 100 })
    } finally { c.release() }

    const byCompany = (await summary(w.token, `?landlordId=${w.coB}`)).body.data
    expect(byCompany.scope.payoutsBelongHere).toBe(true)
    expect(byCompany.monthly.some((m: any) => Number(m.disbursed || 0) > 0)).toBe(true)

    const byProperty = (await summary(w.token, `?propertyId=${w.propB}`)).body.data
    expect(byProperty.scope.payoutsBelongHere).toBe(false)
    expect(byProperty.monthly.every((m: any) => m.disbursed === null)).toBe(true)
    expect(byProperty.monthly.every((m: any) => m.fees === null)).toBe(true)
    // The income still narrows to the one park, which is the whole point.
    expect(byProperty.thisMonth.received).toBeLessThan(byCompany.thisMonth.received)
  })

  it('refuses another account’s company, another account’s property, and a mismatched pair', async () => {
    const w = await world()
    expect((await summary(w.token, `?landlordId=${w.outsiderCo}`)).status).toBe(403)
    expect((await summary(w.token, `?propertyId=${w.outsiderProp}`)).status).toBe(403)
    expect((await summary(w.outsiderToken, `?landlordId=${w.coA}`)).status).toBe(403)
    // Both named, and they disagree: refused rather than one silently winning.
    expect((await summary(w.token, `?landlordId=${w.coA}&propertyId=${w.propB}`)).status).toBe(400)
    // Both named and agreeing is fine.
    expect((await summary(w.token, `?landlordId=${w.coA}&propertyId=${w.propA}`)).status).toBe(200)
  })

  it('ignores a parameter that is not an id, rather than failing the page', async () => {
    const w = await world()
    const all = (await summary(w.token)).body.data
    const junk = (await summary(w.token, '?landlordId=&propertyId=not-an-id')).body.data
    expect(junk.thisMonth.received).toBeCloseTo(all.thisMonth.received, 2)
    expect(junk.scope.landlordId).toBeNull()
  })
})

// ── 11/3 (Nic): "12 rows on the table for rolling 12 at a glance." ──────────
/**
 * A ROLLING twelve — this month and the eleven before it — so the table reads
 * as a trailing-twelve review on any day of any month instead of shrinking to
 * one row every January.
 *
 * The second test is the one that earns its place. The payout column used to be
 * read through `NOW() - INTERVAL '6 months'`, a SECOND copy of the window
 * sitting beside the `months` the rows are built from. Widening the rows to
 * twelve without widening that interval would have zeroed Paid out on the six
 * oldest rows, and nothing on the screen would have looked broken. The window
 * is now taken from `months` itself, and this pins it: the OLDEST row in
 * whatever window the server returns has to carry both its money and its
 * payout. It calibrates off the reply rather than computing a date of its own,
 * so it cannot rot on a month boundary or in an evening UTC run.
 */
describe('GET /api/reports/summary — the rolling twelve', () => {
  it('returns twelve consecutive months, newest first, ending with this one', async () => {
    const w = await world()
    const d = (await summary(w.token)).body.data
    const months: string[] = d.monthly.map((m: any) => m.month)
    expect(months).toHaveLength(12)
    expect(months[0]).toBe(d.thisMonth.month)
    const monthBefore = (ym: string) => {
      const [y, m] = ym.split('-').map(Number)
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
    }
    // No gap, no repeat, no month out of order.
    for (let i = 1; i < months.length; i++) expect(months[i]).toBe(monthBefore(months[i - 1]))
  })

  it('carries the money AND the payout of the oldest month in its own window', async () => {
    const w = await world()
    const oldest: string = (await summary(w.token)).body.data.monthly.slice(-1)[0].month

    const c = await db.connect()
    try {
      await c.query(
        `INSERT INTO disbursements (user_id, landlord_id, amount, fee_charged, status, trigger_type, created_at)
         VALUES ($1, $2, 250, 2, 'settled', 'auto_friday', ($3::text || '-15')::date)`,
        [w.userId, w.coB, oldest])
      await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,'rent',444,'settled','RENT', ($4::text || '-05')::date,
                 (($4::text || '-05')::date + TIME '12:00') AT TIME ZONE 'America/Phoenix')`,
        [w.unitB, w.tenantB, w.coB, oldest])
    } finally { c.release() }

    const row = (d: any) => d.monthly.find((m: any) => m.month === oldest)
    const onlyB = (await summary(w.token, `?landlordId=${w.coB}`)).body.data
    expect(row(onlyB).received).toBeCloseTo(444, 2)
    expect(row(onlyB).disbursed).toBeCloseTo(250, 2)
    expect(row(onlyB).fees).toBeCloseTo(2, 2)

    // The same month, unfiltered, holds the same money — the widening is the
    // window's, not the filter's.
    const all = (await summary(w.token)).body.data
    expect(row(all).received).toBeCloseTo(444, 2)
    expect(row(all).disbursed).toBeCloseTo(250, 2)

    // Company A was not paid that month, and does not borrow B's payout.
    const onlyA = (await summary(w.token, `?landlordId=${w.coA}`)).body.data
    expect(row(onlyA).disbursed).toBe(0)
  })
})
