/**
 * S637 — filtering the dashboard to one property.
 *
 * Nic: "I need to be able to filter from the dashboard to see what other
 * co-owners are seeing. Right now, all properties are blended on the
 * dashboard. And when a co-owner only sees one property because they don't
 * own all the properties together with me, they're seeing different
 * information on the cards."
 *
 * The one that matters most is the last: propertyId arrives in a query
 * string, and an unchecked one would read another landlord's portfolio
 * through an endpoint that has already passed its auth check.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
// The camelCase middleware lives in index.ts, not on the router — a test
// harness mounting the router alone sees the raw snake_case columns.
import { landlordsRouter } from './landlords'
// 10/18: the Outstanding card and the balances page are held to each other in
// one test below — equal on the charges, and apart by exactly the two
// categories that page adds — so this suite asks both of them.
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

const SECRET = 'test_jwt_secret_dashfilter'
let token: string, meUserId: string, propA: string, propB: string, otherProp: string

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const me = await seedLandlord(c)
    meUserId = me.userId
    propA = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    propB = await seedProperty(c, { landlordId: me.landlordId, ownerUserId: me.userId, managedByUserId: me.userId })
    // Two occupied units on A, one on B — so a filter changes the numbers.
    // 10/12 (Nic): Expected Monthly Rent is the rent the active LEASES bill.
    for (const rent of [500, 700]) {
      const u = await seedUnit(c, { propertyId: propA, landlordId: me.landlordId })
      await c.query(`UPDATE units SET status='active', rent_amount=$2 WHERE id=$1`, [u, rent])
      await seedLease(c, { unitId: u, landlordId: me.landlordId, rentAmount: rent })
    }
    const ub = await seedUnit(c, { propertyId: propB, landlordId: me.landlordId })
    await c.query(`UPDATE units SET status='active', rent_amount=300 WHERE id=$1`, [ub])
    await seedLease(c, { unitId: ub, landlordId: me.landlordId, rentAmount: 300 })

    const other = await seedLandlord(c)
    otherProp = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
    await c.query('COMMIT')
    token = jwt.sign(
      { userId: me.userId, role: 'landlord', email: 'me@t.dev', profileId: null,
        landlordIds: [me.landlordId], permissions: {} },
      SECRET, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const dash = (qs = '') => request(buildApp())
  .get(`/api/landlords/me/dashboard${qs}`).set('Authorization', `Bearer ${token}`)
const balances = () => request(buildApp())
  .get('/api/balances').set('Authorization', `Bearer ${token}`)

describe('GET /landlords/me/dashboard?propertyId=', () => {
  it('blends every property when nothing is chosen', async () => {
    const res = await dash()
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.property_count).toBe(2)
  })

  // 10/12 (Nic): the leases' rent, never a unit's listing — the figure the
  // Rent Roll the card opens totals (R&N's Springville SFH TOWN HOME read
  // $1,750 here and $0 there).
  it('a space marked occupied with no active lease adds nothing', async () => {
    const c = await db.connect()
    try {
      const { rows: [{ landlord_id }] } = await c.query(`SELECT landlord_id FROM properties WHERE id=$1`, [propB])
      const u = await seedUnit(c, { propertyId: propB, landlordId: landlord_id })
      await c.query(`UPDATE units SET status='active', rent_amount=1750 WHERE id=$1`, [u])
    } finally { c.release() }
    const res = await dash()
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1500)
    expect(res.body.data.payable_rent_units).toBe(3)
  })

  it('narrows the cards to the chosen property', async () => {
    const res = await dash(`?propertyId=${propA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(2)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(1200)
    expect(res.body.data.property_count).toBe(1)
  })

  it('narrows to the smaller one too — this is the co-owner view', async () => {
    const res = await dash(`?propertyId=${propB}`)
    expect(res.body.data.total_units).toBe(1)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(300)
  })

  it("REFUSES another landlord's property id", async () => {
    const res = await dash(`?propertyId=${otherProp}`)
    expect(res.status).toBe(404)
  })

  it('refuses an id that does not exist at all', async () => {
    const res = await dash(`?propertyId=${randomUUID()}`)
    expect(res.status).toBe(404)
  })

  it('treats an empty propertyId as the blended view, not an error', async () => {
    const res = await dash('?propertyId=')
    expect(res.status).toBe(200)
    expect(res.body.data.total_units).toBe(3)
  })
})

// S654 (Nic): "until a unit is actually delinquent past its grace period, I
// would really love for that to say outstanding units… flag a difference
// between outstanding and delinquent based on when the grace period ends."
// And of the old "late fees accruing on 7": "make sure that's accurate."
describe('S654 outstanding vs delinquent vs accruing', () => {
  // The bill is written three days before it is due (on time), unless
  // `writtenDaysAgo` says when GAM wrote it (10/12, Nic: a bill written after
  // its due date is late counted from the day it was written).
  async function unitOwing(opts: {
    daysPastDue: number; graceDays: number; fee: number; exempt?: boolean
    amount?: number; writtenDaysAgo?: number; dailyFee?: number
  }) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [{ landlord_id }] } = await c.query(`SELECT landlord_id FROM properties WHERE id=$1`, [propA])
      const unitId = await seedUnit(c, { propertyId: propA, landlordId: landlord_id })
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
      const { rows: [lease] } = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                             late_fee_enabled, late_fee_initial_amount, late_fee_initial_type, late_fee_grace_days,
                             late_fee_accrual_type, late_fee_accrual_amount, late_fee_accrual_period, late_fee_accrual_from)
         VALUES ($1,$2,500,'month_to_month','active', CURRENT_DATE - 60, true, $3, 'flat', $4,
                 CASE WHEN $5::numeric IS NOT NULL THEN 'flat' END, $5,
                 CASE WHEN $5::numeric IS NOT NULL THEN 'daily' END, 'due_date_inclusive') RETURNING id`,
        [unitId, landlord_id, opts.fee, opts.graceDays, opts.dailyFee ?? null])
      // Days in the property's own calendar (seedProperty's zone), noon there.
      const { rows: [{ due, written }] } = await c.query<{ due: string; written: Date }>(
        `SELECT ((NOW() AT TIME ZONE pr.timezone)::date - $2::int)::text AS due,
                ((((NOW() AT TIME ZONE pr.timezone)::date - COALESCE($3::int, $2::int + 3)) + TIME '12:00')
                   AT TIME ZONE pr.timezone) AS written
           FROM properties pr WHERE pr.id = $1`, [propA, opts.daysPastDue, opts.writtenDaysAgo ?? null])
      const { rows: [inv] } = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status, late_fee_exempt, created_at)
         VALUES ($1,$2,$3,$4, $5::date, $7, $7, 'pending', $6, $8) RETURNING id`,
        [landlord_id, lease.id, unitId, `INV-${randomUUID().slice(0, 8)}`, due, !!opts.exempt, opts.amount ?? 500, written])
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
         VALUES ($1,$2,$3,$4,'rent',$6,'pending', $5::date, 'RENT', $7)`,
        [inv.id, unitId, lease.id, landlord_id, due, opts.amount ?? 500, written])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('counts owing, past-grace, and fee-will-be-charged separately', async () => {
    await unitOwing({ daysPastDue: 0,  graceDays: 5, fee: 50 })              // due today: outstanding only
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0 })               // past grace, $0 fee: delinquent, no fee
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50, exempt: true }) // past grace, waived: delinquent, no fee
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50 })              // past grace, real fee: accruing
    await unitOwing({ daysPastDue: 3,  graceDays: 5, fee: 50 })              // inside grace: outstanding only
    const res = await dash()
    expect(res.status).toBe(200)
    expect(res.body.data.units_owing).toBe(5)
    expect(res.body.data.units_past_grace).toBe(3)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  it('a longer grace period keeps a unit outstanding, not delinquent', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 15, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_owing).toBe(1)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(0)
  })

  // 10/12 (Nic): the dashboard reads the one lateness rule every money screen
  // and the late-fee engine use (services/lateness): late from the lateness
  // start + GREATEST(grace, 1), the start being the due date or the day GAM
  // wrote the bill when later. It used to say "today > due + grace", so the
  // first late day — the day the fee charges — read "not past grace".
  it('the first late day is past grace: the 6th, with 5 days of grace', async () => {
    await unitOwing({ daysPastDue: 4, graceDays: 5, fee: 50 })   // the 5th: grace
    await unitOwing({ daysPastDue: 5, graceDays: 5, fee: 50 })   // the 6th: late, the fee charges tonight
    const res = await dash()
    expect(res.body.data.units_owing).toBe(2)
    expect(res.body.data.units_past_grace).toBe(1)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  it('a grace of 0: due today is on time, due yesterday is late', async () => {
    await unitOwing({ daysPastDue: 0, graceDays: 0, fee: 50 })
    await unitOwing({ daysPastDue: 1, graceDays: 0, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_past_grace).toBe(1)
  })

  it('a bill written after its due date counts its grace from the day it was written', async () => {
    // Due 10 days ago, written 2 days ago, 5 days of grace: still in grace.
    await unitOwing({ daysPastDue: 10, writtenDaysAgo: 2, graceDays: 5, fee: 50 })
    // Written 5 days ago: today is its first late day.
    await unitOwing({ daysPastDue: 10, writtenDaysAgo: 5, graceDays: 5, fee: 50 })
    const res = await dash()
    expect(res.body.data.units_owing).toBe(2)
    expect(res.body.data.units_past_grace).toBe(1)
  })

  it('a $0 line is never past grace, and a unit owing only $0 does not owe', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 50, amount: 0 })
    const res = await dash()
    // 10/12 (Nic): $0 lines are ignored — the headline said "owes" with nothing owed.
    expect(res.body.data.units_owing).toBe(0)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(0)
  })

  // 10/12 (Nic, Q-a): "it rides the original due date." A line added to a bill
  // already late is fined from the BILL's late clock (the engine starts on the
  // day the bill was written), so the unit is accruing — while the line itself,
  // written yesterday, is still inside its own grace (Outstanding's rule).
  it('a line added to a late bill is accruing on the bill\'s clock', async () => {
    // Oak Park terms: no first fee, $5 a day counted back to the due date.
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0, dailyFee: 5 })
    const { rows: [rent] } = await db.query<{ id: string; invoice_id: string; unit_id: string; lease_id: string; landlord_id: string; due_date: string }>(
      `SELECT p.id, p.invoice_id, p.unit_id, p.lease_id, p.landlord_id, p.due_date::text AS due_date
         FROM payments p JOIN units u ON u.id = p.unit_id WHERE u.property_id = $1 AND p.type = 'rent'`, [propA])
    // The rent was paid before the due date; a $40 utility line joined the bill yesterday.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() - INTERVAL '12 days', manual_method = 'cash' WHERE id = $1`, [rent.id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'utility',40,'pending',$5::date,'UTILITY', NOW() - INTERVAL '1 day')`,
      [rent.invoice_id, rent.unit_id, rent.lease_id, rent.landlord_id, rent.due_date])
    const res = await dash()
    expect(res.body.data.units_owing).toBe(1)
    expect(res.body.data.units_past_grace).toBe(0)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })

  // Every Oak Park lease: no first fee, $5 a day counted back to the due date.
  // The engine charges it; the card said "no fee will be charged".
  it('a daily fee with a $0 first fee is accruing', async () => {
    await unitOwing({ daysPastDue: 10, graceDays: 5, fee: 0, dailyFee: 5 })
    const res = await dash()
    expect(res.body.data.units_past_grace).toBe(1)
    expect(res.body.data.delinquent_units_accruing_late_fees).toBe(1)
  })
})

// S655 (decision #4): the trend and the property-health card read the same
// category totals as the property report. They used to sum EVERY settled row,
// so a deposit held for a tenant and GAM's own fee showed as the landlord's
// revenue on the heartbeat.
describe('S655 the trend and the property-health card count income only', () => {
  async function rowsOn(propertyId: string, rows: Array<[string, string, number, string]>) {
    const { rows: [u] } = await db.query<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM units WHERE property_id = $1 ORDER BY id LIMIT 1`, [propertyId])
    const { rows: [{ d }] } = await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/Phoenix')::date::text AS d`)
    for (const [i, [type, entry, amount, owner]] of rows.entries()) {
      await db.query(
        `INSERT INTO payments (unit_id, landlord_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
         VALUES ($1,$2,$3,$4,'settled',$5,$6::date - $8::int,now(),$7)`,
        [u.id, u.landlord_id, type, amount, entry, d, owner, i])
    }
  }

  it('a deposit held and a GAM fee are not revenue on the trend', async () => {
    await rowsOn(propA, [
      ['rent', 'RENT', 500, 'landlord'],
      ['utility', 'UTILITY', 40, 'landlord'],
      ['deposit', 'DEPOSIT', 700, 'held'],
      ['fee', 'DECLINEFEE', 6, 'gam'],
    ])
    const res = await dash()
    const now = res.body.data.trend[res.body.data.trend.length - 1]
    expect(now.revenue).toBe(540)
    expect(now.rent_revenue).toBe(500)
    expect(now.other_revenue).toBe(40)
    expect(res.body.data.property_health.total).toBe(540)
    expect(res.body.data.trend).toHaveLength(6)
  })

  it('narrowing to a property narrows the trend and the property-health card too', async () => {
    await rowsOn(propA, [['rent', 'RENT', 500, 'landlord']])
    await rowsOn(propB, [['rent', 'RENT', 300, 'landlord']])
    expect((await dash()).body.data.property_health.total).toBe(800)
    const a = (await dash(`?propertyId=${propA}`)).body.data
    expect(a.property_health.total).toBe(500)
    expect(a.trend[a.trend.length - 1].revenue).toBe(500)
    expect((await dash(`?propertyId=${propB}`)).body.data.property_health.total).toBe(300)
  })

  it('refuses an unknown basis', async () => {
    expect((await dash('?basis=accrual')).status).toBe(400)
  })

  /**
   * ── 10/18 (Nic): EVERY FIGURE UNDER THE METER MOVES WITH THE PICKER ──────
   *
   *   "it's still showing that 9,683 is owed when I filter to Mountain View,
   *    but outstanding in the top KPI card only shows $1,415."
   *
   * He could not tell whether the table under the meter had changed, because a
   * receivables balance barely moves month to month. It does change — all of
   * it does — and the one above only proved the Received total. Every figure
   * the card draws is checked here: the health trio and its percentage, the
   * money table's three columns, and the trend beat behind them.
   *
   * $500 rent paid and $200 still owed at property A; $300 paid and $100 owed
   * at property B. Nothing here can read right by coincidence: no two
   * properties share a figure and no column equals another.
   */
  it('narrowing changes the health trio, its percentage and all three money columns', async () => {
    await rowsOn(propA, [['rent', 'RENT', 500, 'landlord']])
    await rowsOn(propB, [['rent', 'RENT', 300, 'landlord']])
    await owedOn(propA, 200)
    await owedOn(propB, 100)
    const three = (d: any) => ({
      invoiced: d.rent_health.invoiced, paid: d.rent_health.paid, owed: d.rent_health.owed,
      pct: Math.round((d.rent_health.paid / d.rent_health.invoiced) * 100),
      charged: sumCol(d, 'charged'), received: sumCol(d, 'received'), tableOwed: sumCol(d, 'owed'),
      beat: d.trend[d.trend.length - 1].revenue,
    })
    const blended = three((await dash()).body.data)
    const a = three((await dash(`?propertyId=${propA}`)).body.data)
    const b = three((await dash(`?propertyId=${propB}`)).body.data)
    expect(blended).toEqual({ invoiced: 1100, paid: 800, owed: 300, pct: 73, charged: 1100, received: 800, tableOwed: 300, beat: 800 })
    expect(a).toEqual({ invoiced: 700, paid: 500, owed: 200, pct: 71, charged: 700, received: 500, tableOwed: 200, beat: 500 })
    expect(b).toEqual({ invoiced: 400, paid: 300, owed: 100, pct: 75, charged: 400, received: 300, tableOwed: 100, beat: 300 })
    // Not one figure in the block is shared between the two properties.
    for (const k of Object.keys(a) as Array<keyof typeof a>) expect(a[k]).not.toBe(b[k])
  })

  /**
   * A second resident at the property whose rent is still owed: in `invoiced`,
   * out of `paid`. On its own space, because one rent charge per space per due
   * date is the rule (ux_payments_unit_rent_due_date_active).
   */
  async function owedOn(propertyId: string, amount: number) {
    const { rows: [u] } = await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM units WHERE property_id = $1 LIMIT 1`, [propertyId])
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId, landlordId: u.landlord_id })
      await c.query(
        `INSERT INTO payments (unit_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
         VALUES ($1, $2, 'rent', $3, 'pending', 'RENT', (now() AT TIME ZONE 'America/Phoenix')::date, 'landlord')`,
        [unitId, u.landlord_id, amount])
    } finally { c.release() }
  }

  /** One of the money table's three columns, added down its categories. */
  const sumCol = (d: any, k: 'charged' | 'received' | 'owed') =>
    Math.round(d.property_health.categories.reduce((s: number, c: any) => s + Number(c[k]), 0) * 100) / 100
})

/**
 * ── 10/18 (Nic): THE OUTSTANDING CARD DROPPED THE LATE FEES ────────────────
 *
 *   "underneath the property health, it's still showing that 9,683 is owed
 *    when I filtered a Mountain View, but outstanding in the top KPI card only
 *    shows $1,415. You're, you're pulling numbers from different spots here.
 *    So that is a huge problem for a landlord to see incorrect numbers."
 *
 * A late fee is kept out of invoices.total_amount on purpose (the trigger
 * fn_invoice_late_fee_subtotal_rollup_single carries it in subtotal_late_fees;
 * workTradeCoverage.BILL_TOTAL_SQL leaves type='late_fee' out of every total a
 * writer computes). The card summed total_amount less paid, so it dropped every
 * accrued late fee. The card reads the one shared open-charge rule now
 * (services/openBalances), the rule the balances page it links to already read.
 *
 * The first test asks BOTH endpoints in one go and asserts they agree, so the
 * two definitions can never come apart again without a red test.
 */
describe('10/18 Outstanding counts every open charge, and ties to the balances page', () => {
  interface Charge {
    type: string
    amount: number
    /** A card or bank payment of this charge is still clearing. */
    clearing?: boolean
    /** Work trade covers it: settled in hours at month close, never owed. */
    workTrade?: boolean
    /**
     * Whose money the charge is. 'gam' is a GAM fee the tenant pays GAM (the $1
     * declined-card fee, a failed FlexDeposit pull): never the landlord's
     * receivable. Default 'landlord'.
     */
    revenueOwner?: 'landlord' | 'gam' | 'held'
    /** The entry code, when the type does not spell it (payments_entry_description_check). */
    entry?: string
    /** Credit already spent on this charge — only the remainder is owed. */
    creditApplied?: number
  }

  /**
   * One bill on its own space at `propertyId`. `total_amount` is set the way
   * every production writer sets it (workTradeCoverage.BILL_TOTAL_SQL): the
   * lines actually owed, with late fees and work-trade lines left out of it.
   * A GAM fee is outside it too — routes/webhooks INSERTs the row onto an
   * existing bill and nothing recomputes total_amount (schema.sql has only
   * fn_invoice_late_fee_subtotal_rollup_single and fn_invoice_status_rollup).
   */
  async function billOn(propertyId: string, charges: Charge[]) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [{ landlord_id }] } = await c.query(
        `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
      const unitId = await seedUnit(c, { propertyId, landlordId: landlord_id })
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
      const leaseId = await seedLease(c, { unitId, landlordId: landlord_id, rentAmount: 500 })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      const inTotal = charges
        .filter(ch => ch.type !== 'late_fee' && !ch.workTrade && (ch.revenueOwner ?? 'landlord') !== 'gam')
        .reduce((s, ch) => s + ch.amount, 0)
      const { rows: [inv] } = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, lease_id, unit_id, tenant_id, invoice_number, due_date,
                               subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,$5, (now() AT TIME ZONE 'America/Phoenix')::date, $6, $6, 'pending') RETURNING id`,
        [landlord_id, leaseId, unitId, tenantId, `INV-${randomUUID().slice(0, 8)}`, inTotal])
      for (const ch of charges) {
        const { rows: [pay] } = await c.query<{ id: string }>(
          `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
                                 status, due_date, entry_description, stripe_payment_intent_id,
                                 work_trade_suspended_at, revenue_owner)
           VALUES ($1,$2,$3,$4,$5,$6,$7, $8, (now() AT TIME ZONE 'America/Phoenix')::date, $9, $10, $11, $12)
           RETURNING id`,
          [inv.id, unitId, leaseId, tenantId, landlord_id, ch.type, ch.amount,
           ch.clearing ? 'processing' : 'pending',
           ch.entry ?? ch.type.toUpperCase().replace(/_/g, ''),
           ch.clearing ? `pi_${randomUUID().slice(0, 12)}` : null,
           ch.workTrade ? new Date().toISOString() : null,
           ch.revenueOwner ?? 'landlord'])
        if (ch.creditApplied) {
          const { rows: [cr] } = await c.query<{ id: string }>(
            `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining,
                                         category, status)
             VALUES ($1,$2,$3,$4,$4,'goodwill','active') RETURNING id`,
            [landlord_id, tenantId, leaseId, ch.creditApplied])
          await c.query(
            `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month,
                                      source, status, applied_at)
             VALUES ($1,$2,$3,$4, date_trunc('month', now())::date, 'desk', 'applied', now())`,
            [cr.id, pay.id, leaseId, ch.creditApplied])
        }
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  /**
   * Property A owes $610: a $460 rent bill carrying a $90 accrued late fee
   * ($550 really owed, $460 under the old rule), plus a $100 utility with $40
   * of credit already spent on it ($60 left). A $200 rent line on hold for work
   * trade owes nothing and is reported as traded.
   *
   * Property B owes $345: a $300 rent bill with a $45 late fee. Its $777 rent
   * and $55 utility are clearing at the bank — already paid, never owed.
   *
   * No figure is shared between the two properties.
   */
  async function seedBills() {
    await billOn(propA, [{ type: 'rent', amount: 460 }, { type: 'late_fee', amount: 90 }])
    await billOn(propA, [{ type: 'rent', amount: 200, workTrade: true }])
    await billOn(propA, [{ type: 'utility', amount: 100, creditApplied: 40 }])
    await billOn(propB, [{ type: 'rent', amount: 300 }, { type: 'late_fee', amount: 45 }])
    await billOn(propB, [{ type: 'rent', amount: 777, clearing: true }])
    await billOn(propB, [{ type: 'utility', amount: 55, clearing: true }])
  }

  /** What the card summed before: unpaid invoice balances, late fees outside them. */
  async function oldRuleOutstanding(propertyId?: string): Promise<number> {
    const { rows: [r] } = await db.query<{ n: string }>(`
      SELECT COALESCE(SUM(GREATEST(i.total_amount - COALESCE(p.paid, 0), 0)), 0)::text AS n
        FROM invoices i
        LEFT JOIN (SELECT invoice_id, SUM(amount) FILTER (WHERE status IN ('settled','processing')) AS paid
                     FROM payments WHERE invoice_id IS NOT NULL GROUP BY invoice_id) p ON p.invoice_id = i.id
       WHERE i.status IN ('pending','partial')
         AND ($1::uuid IS NULL OR i.unit_id IN (SELECT id FROM units WHERE property_id = $1))`,
      [propertyId ?? null])
    return Number(r.n)
  }

  /**
   * An open register ticket at `propertyId`, the live production shape: one
   * metered line, qty x price, no tax (pos_open_tickets f13f1e2e… at Mountain
   * View on 10/18 was 107 kWh at $0.21 = $22.47).
   */
  async function openTicket(propertyId: string, items: Array<{ qty: number; price: number; tax?: number }>) {
    const { rows: [{ landlord_id }] } = await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    // A ticket names somebody (pos_open_tickets_one_customer): the live one is
    // a register customer, so this one is too.
    const customerId = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email)
       VALUES ($1,'Dale','Pumphrey',$2) RETURNING id`,
      [landlord_id, `dale-${randomUUID().slice(0, 8)}@example.test`])).rows[0].id
    await db.query(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, pos_customer_id, items, note, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'Electric, read at the pump','open')`,
      [landlord_id, propertyId, meUserId, customerId,
       JSON.stringify(items.map((i, n) => ({ name: `Line ${n + 1}`, qty: i.qty, price: i.price, tax: i.tax ?? 0 })))])
  }

  /** An open one-time pay link at `propertyId` — money owed by someone with no lease. */
  async function payLink(propertyId: string, total: number) {
    const { rows: [{ landlord_id }] } = await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    await db.query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, total, customer_name, customer_email, status)
       VALUES ($1,$2,$3,$4,'one_time','Move-out bill', $5::jsonb, $6, $6, 'Andres Razo',
               'andres@example.test','open')`,
      [`tok_${randomUUID().slice(0, 12)}`, landlord_id, propertyId, meUserId,
       JSON.stringify([{ name: 'Move-out bill', qty: 1, price: total, tax: 0 }]), total])
  }

  // THE TIE, AND THE ONE PLACE IT IS NOT A TIE. Both replies in one test, read
  // off the same data in the same breath, blended and per property.
  //
  // On the charges they are ONE figure: the card reads the same rule over the
  // same rows (lib/rentCollected outstandingBalanceOf → services/openBalances).
  //
  // GET /api/balances then adds two categories no charge row can carry — every
  // open one-time POS pay link and every open register ticket (routes/balances;
  // outstandingTotals says so in its own doc comment) — into meta.totals.owed
  // and by_property. That is money owed by somebody who may have no lease at
  // all, so it is in the front desk's to-do list and not in a landlord's
  // receivable. 10/18 production had exactly one: an open $22.47 electric
  // ticket at Mountain View, which is why the Front Desk read $13,092.55 while
  // the card read $13,070.08.
  //
  // Both are seeded, so this test fails if the card starts counting them, if
  // the page stops, or if the charge figures drift apart by a cent.
  it('ties with the balances page on charges, and differs by exactly what that page adds', async () => {
    await seedBills()
    await openTicket(propA, [{ qty: 107, price: 0.21 }])   // $22.47, the live shape
    await payLink(propB, 40)
    const card = (await dash()).body.data
    const bal = await balances()
    expect(bal.status).toBe(200)
    const totals = bal.body.meta.totals
    const byProp = new Map<string, number>(
      totals.by_property.map((p: any) => [p.property_id, Number(p.owed)]))

    // The charges, blended: one figure, and the ticket and link are not in it.
    expect(Number(card.outstanding)).toBe(955)
    expect(Number(totals.owed)).toBeCloseTo(955 + 22.47 + 40, 2)
    expect(Number(totals.owed) - 22.47 - 40).toBeCloseTo(Number(card.outstanding), 2)

    const a = (await dash(`?propertyId=${propA}`)).body.data
    const b = (await dash(`?propertyId=${propB}`)).body.data
    expect(Number(a.outstanding)).toBe(610)
    expect(Number(b.outstanding)).toBe(345)
    // Per property the same shape: the ticket sits at A, the link at B.
    expect(byProp.get(propA)).toBeCloseTo(610 + 22.47, 2)
    expect(byProp.get(propB)).toBeCloseTo(345 + 40, 2)
  })

  // 10/18 review: reading the charge rows directly would have put GAM's own
  // money into the figure a landlord reads as what their residents owe THEM.
  // The old invoice rule could not see these rows at all (nothing recomputes
  // invoices.total_amount, so a fee row added to an existing bill was never
  // inside the total it subtracted from), so the migration had to say so.
  // routes/webhooks writes one of these on every refused card attempt.
  it("leaves GAM's own fee out of the landlord's Outstanding", async () => {
    await billOn(propA, [
      { type: 'rent', amount: 460 },
      // The exact row routes/webhooks writes on a refused card attempt.
      { type: 'fee', amount: 1, revenueOwner: 'gam', entry: 'DECLINEFEE' },
    ])
    expect(Number((await dash(`?propertyId=${propA}`)).body.data.outstanding)).toBe(460)
  })

  // The defect itself, in dollars: the late fees were simply missing.
  it('counts an accrued late fee the invoice total never carried', async () => {
    await billOn(propA, [{ type: 'rent', amount: 460 }, { type: 'late_fee', amount: 90 }])
    // The bill really owes $550; its total_amount is $460 and subtotal_late_fees $90.
    const { rows: [inv] } = await db.query<{ total_amount: string; subtotal_late_fees: string }>(
      `SELECT i.total_amount::text, i.subtotal_late_fees::text FROM invoices i
         JOIN units u ON u.id = i.unit_id WHERE u.property_id = $1`, [propA])
    expect(Number(inv.total_amount)).toBe(460)
    expect(Number(inv.subtotal_late_fees)).toBe(90)
    expect(await oldRuleOutstanding(propA)).toBe(460)
    expect(Number((await dash(`?propertyId=${propA}`)).body.data.outstanding)).toBe(550)
  })

  it('narrows with the property picker, and shares no amount between properties', async () => {
    await seedBills()
    const blended = Number((await dash()).body.data.outstanding)
    const a = Number((await dash(`?propertyId=${propA}`)).body.data.outstanding)
    const b = Number((await dash(`?propertyId=${propB}`)).body.data.outstanding)
    expect(a).toBe(610)
    expect(b).toBe(345)
    expect(a).not.toBe(b)
    // Every dollar at exactly one property: the two add up to the blended figure.
    expect(a + b).toBe(blended)
  })

  // S640 (Nic): "It's not outstanding... not really real money at this point."
  it('leaves a work-trade line out of owed and still reports what the trades are worth', async () => {
    await billOn(propA, [{ type: 'rent', amount: 200, workTrade: true }])
    const a = (await dash(`?propertyId=${propA}`)).body.data
    expect(Number(a.outstanding)).toBe(0)
    expect(Number(a.work_trade_suspended)).toBe(200)
  })

  // decisions #29: a payment clearing is already paid — not owed, and if it
  // bounces the reopened row is owed again.
  it('does not count a payment that is clearing', async () => {
    await billOn(propB, [{ type: 'rent', amount: 777, clearing: true }])
    expect(Number((await dash(`?propertyId=${propB}`)).body.data.outstanding)).toBe(0)
  })

  // openAmountSql: a charge owes its amount less the credit already spent on it.
  it('counts only the remainder of a charge a credit has partly paid', async () => {
    await billOn(propA, [{ type: 'utility', amount: 100, creditApplied: 40 }])
    expect(Number((await dash(`?propertyId=${propA}`)).body.data.outstanding)).toBe(60)
  })
})
