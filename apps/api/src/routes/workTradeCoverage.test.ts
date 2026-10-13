/**
 * 10/12 (Nic, Curtis Clabough) — a change of what a work trade covers reaches
 * the bills already out.
 *
 *   "for some reason you're billing him water or it's set up to bill him water.
 *    His utilities should be fully covered as well."
 *
 * PATCH /work-trade/:id with coveredCharges used to change only the NEXT bill.
 * These drive the route against a real database: a type ADDED parks its open
 * charges the way the monthly run does — and widens the month's covered basis,
 * so the month close covers them instead of handing them straight back — and a
 * type TAKEN OFF does what the landlord chose (keep covered / put back).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { workTradeRouter } from './workTrade'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { runWorkTradeSettlement } from '../jobs/workTradeSettlement'
import { attachStrandedUtilityBill } from '../services/utilityBilling'
import { hourRateFor } from '../services/workTradeSettlement'

const SUSPENDED = 'Work trade — suspended while the hours are worked; settled at month close'

function app() {
  const a = express()
  a.use(express.json())
  // The production wire contract: every response is camelCased (index.ts).
  a.use((_req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body: any) => json(camelCaseKeys(body))
    next()
  })
  a.use('/api/work-trade', workTradeRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_workTradeCoverage'
})

interface World {
  landlordId: string; userId: string; tenantId: string; tenantUserId: string
  unitId: string; leaseId: string; propertyId: string; meterId: string
  agreementId: string; ownerToken: string; tenantToken: string
}

/** Curtis's shape: a 25-hour trade covering rent; October's bill holds rent (parked) and water (owed). */
async function world(o: { covers?: string[] } = {}): Promise<World> {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 450 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 450 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water' })
    const agreementId = (await c.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours,
          covered_charges, carry_forward_months)
       VALUES ($1,$2,$3,'2026-10-01','active',25,TRUE,$4::text[],3) RETURNING id`,
      [unitId, tenantId, landlordId, o.covers ?? ['rent']])).rows[0].id
    return {
      landlordId, userId, tenantId, tenantUserId, unitId, leaseId, propertyId, meterId, agreementId,
      ownerToken: sign({ userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} }),
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} }),
    }
  } finally { c.release() }
}

/** A month's bill: rent (parked under the trade) and a water line, plus its open period. */
async function bill(w: World, month: string, o: { waterParked?: boolean; waterStatus?: string; basis?: number } = {}): Promise<{ invoiceId: string; waterId: string; rentId: string }> {
  const c = await getClient()
  try {
    const waterParked = o.waterParked === true
    const total = waterParked ? 0 : 110.55
    const invoiceId = (await c.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount, work_trade_agreement_id, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,$6::date,450,110.55,$7,$8,TRUE) RETURNING id`,
      [w.landlordId, w.tenantId, w.leaseId, w.unitId, `WT-${randomUUID().slice(0, 8)}`, month, total, w.agreementId])).rows[0].id
    const rentId = (await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, notes, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,'rent',450,'pending',$6::date,'RENT',$7,NOW()) RETURNING id`,
      [invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId, month, SUSPENDED])).rows[0].id
    const waterId = (await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, notes, work_trade_suspended_at, settled_at)
       VALUES ($1,$2,$3,$4,$5,'utility',110.55,$6,$7::date,'UTILITY',$8,$9::timestamptz,
               CASE WHEN $6 = 'settled' THEN NOW() END) RETURNING id`,
      [invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId, o.waterStatus ?? 'pending', month,
       waterParked ? `Water meter 03470 → 03537 — ${SUSPENDED}` : 'Water meter 03470 → 03537',
       waterParked ? new Date().toISOString() : null])).rows[0].id
    await seedUtilityBill(c, { meterId: w.meterId, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId,
      landlordId: w.landlordId, chargeAmount: 110.55, paymentId: waterId, billingCycleMonth: month, utilityType: 'water' })
    const basis = o.basis ?? (waterParked ? 560.55 : 450)
    await c.query(
      `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount,
                                           period_start, period_end)
       VALUES ($1,$2,$3::date,25,$4,$5,$3::date,($3::date + interval '1 month - 1 day')::date)`,
      [w.agreementId, invoiceId, month, hourRateFor(basis, 25).toFixed(4), basis.toFixed(2)])
    return { invoiceId, waterId, rentId }
  } finally { c.release() }
}

const line = async (id: string) => (await db.query(
  `SELECT status, amount::float AS amount, work_trade_suspended_at IS NOT NULL AS parked, notes
     FROM payments WHERE id=$1`, [id])).rows[0]
const total = async (invoiceId: string) => Number((await db.query(
  `SELECT total_amount::float AS t FROM invoices WHERE id=$1`, [invoiceId])).rows[0].t)
const period = async (invoiceId: string) => (await db.query(
  `SELECT status, basis_amount::float AS basis, hour_rate::float AS rate, target_hours::float AS target,
          credit_applied::float AS credit
     FROM work_trade_settlements WHERE invoice_id=$1`, [invoiceId])).rows[0]
async function logHours(w: World, workDate: string, hours: number) {
  await db.query(
    `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
     VALUES ($1,$2,$3,$4::date,$5,'work','approved')`, [w.agreementId, w.tenantId, w.userId, workDate, hours])
}
const patch = (w: World, token: string, body: object) =>
  request(app()).patch(`/api/work-trade/${w.agreementId}`).set('Authorization', `Bearer ${token}`).send(body)

describe('adding a type to a work trade reaches the bills already out', () => {
  it('parks the open water on the current month, widens its basis, and the month close covers it', async () => {
    const w = await world()
    const oct = await bill(w, '2026-10-01')
    expect(await total(oct.invoiceId)).toBe(110.55)        // the bug: water billed as owed

    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent', 'water'] })
    expect(r.status).toBe(200)
    expect(r.body.data.coverage).toMatchObject({ parked: 1, parkedAmount: 110.55, putBack: 0 })

    const water = await line(oct.waterId)
    expect(water).toMatchObject({ status: 'pending', amount: 110.55, parked: true })
    expect(water.notes).toContain(SUSPENDED)
    expect(await total(oct.invoiceId)).toBe(0)
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 560.55, rate: hourRateFor(560.55, 25), target: 25 })

    // November 1: he worked his 25 hours — the whole bill is covered, water included.
    await logHours(w, '2026-10-20', 25)
    const run = await runWorkTradeSettlement('2026-10-01')
    expect(run.errors).toEqual([])
    expect(await line(oct.waterId)).toMatchObject({ status: 'settled', amount: 0, parked: false })
    expect(await line(oct.rentId)).toMatchObject({ status: 'settled', amount: 0, parked: false })
    expect(await total(oct.invoiceId)).toBe(0)
  })

  it('a month already settled covers the newly covered charge at once, from the hours it has', async () => {
    const w = await world()
    const sep = await bill(w, '2026-09-01')
    await logHours(w, '2026-09-20', 25)
    await runWorkTradeSettlement('2026-09-01')
    expect((await period(sep.invoiceId)).status).toBe('settled')
    expect(await line(sep.waterId)).toMatchObject({ status: 'pending', amount: 110.55, parked: false })

    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent', 'water'] })
    expect(r.status).toBe(200)
    expect(r.body.data.coverage).toMatchObject({ covered: 1, coveredAmount: 110.55, parked: 0 })
    const water = await line(sep.waterId)
    expect(water).toMatchObject({ status: 'settled', amount: 0, parked: false })
    expect(water.notes).toContain('Covered by work-trade credit')
    expect(await total(sep.invoiceId)).toBe(0)
    expect(await period(sep.invoiceId)).toMatchObject({ basis: 560.55, credit: 560.55 })
  })

  it('never touches a paid charge, a late fee, or a fee GAM keeps', async () => {
    const w = await world()
    const oct = await bill(w, '2026-10-01', { waterStatus: 'settled' })
    const lateFee = (await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',25,'pending','2026-10-01','LATEFEE') RETURNING id`,
      [oct.invoiceId, w.unitId, w.leaseId, w.tenantId, w.landlordId])).rows[0].id
    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent', 'water', 'fees'] })
    expect(r.status).toBe(200)
    expect(r.body.data.coverage).toMatchObject({ parked: 0, covered: 0 })
    expect(await line(oct.waterId)).toMatchObject({ status: 'settled', parked: false })
    expect(await line(lateFee)).toMatchObject({ status: 'pending', parked: false, amount: 25 })
  })

  it('an empty coverage is refused — it reads as "everything" to the billing runs', async () => {
    const w = await world()
    const r = await patch(w, w.ownerToken, { coveredCharges: [] })
    expect(r.status).toBe(400)
  })
})

describe('taking a type off: the landlord chooses what happens to its open charges', () => {
  it('reports the open parked charges by kind for the question', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    await bill(w, '2026-10-01', { waterParked: true })
    const r = await request(app()).get(`/api/work-trade/${w.agreementId}/covered-open`)
      .set('Authorization', `Bearer ${w.ownerToken}`)
    expect(r.status).toBe(200)
    expect(r.body.data.water).toEqual({ count: 1, amount: 110.55 })
    expect(r.body.data.rent).toEqual({ count: 1, amount: 450 })
  })

  it('not sent (keep covered): the parked charges stay parked, the basis and totals stand', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01', { waterParked: true })
    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent'] })
    expect(r.status).toBe(200)
    expect(r.body.data.coverage).toMatchObject({ putBack: 0, parked: 0 })
    expect(await line(oct.waterId)).toMatchObject({ status: 'pending', parked: true })
    expect(await total(oct.invoiceId)).toBe(0)
    expect((await period(oct.invoiceId)).basis).toBe(560.55)

    // ...and the month close still covers it.
    await logHours(w, '2026-10-20', 25)
    await runWorkTradeSettlement('2026-10-01')
    expect(await line(oct.waterId)).toMatchObject({ status: 'settled', amount: 0 })
  })

  it('keep_covered sent explicitly does the same', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01', { waterParked: true })
    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent'], openCoveredCharges: 'keep_covered' })
    expect(r.status).toBe(200)
    expect(await line(oct.waterId)).toMatchObject({ parked: true })
  })

  it('put_back: the open water goes back on the balance, the basis shrinks, the totals are rebuilt', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01', { waterParked: true })
    // A water charge already settled at a month close, on an older bill — never touched.
    const sep = await bill(w, '2026-09-01', { waterParked: true })
    await db.query(`UPDATE payments SET status='settled', amount=0, settled_at=NOW(), work_trade_suspended_at=NULL,
                           notes='Covered by work-trade credit' WHERE id=$1`, [sep.waterId])

    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent'], openCoveredCharges: 'put_back' })
    expect(r.status).toBe(200)
    expect(r.body.data.coverage).toMatchObject({ putBack: 1, putBackAmount: 110.55 })
    const water = await line(oct.waterId)
    expect(water).toMatchObject({ status: 'pending', amount: 110.55, parked: false })
    expect(water.notes).not.toContain('suspended')
    expect(water.notes).toContain('No longer covered by the work trade')
    expect(water.notes).toContain('Water meter 03470')
    expect(await total(oct.invoiceId)).toBe(110.55)
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 450, rate: hourRateFor(450, 25) })
    // The rent stays parked; the settled line is untouched.
    expect(await line(oct.rentId)).toMatchObject({ parked: true })
    expect(await line(sep.waterId)).toMatchObject({ status: 'settled', amount: 0, notes: 'Covered by work-trade credit' })

    // At the close only the rent is covered; the water is owed.
    await logHours(w, '2026-10-20', 25)
    await runWorkTradeSettlement('2026-10-01')
    expect(await line(oct.rentId)).toMatchObject({ status: 'settled', amount: 0 })
    expect(await line(oct.waterId)).toMatchObject({ status: 'pending', amount: 110.55 })
    expect(await total(oct.invoiceId)).toBe(110.55)
  })
})

describe('a month nothing has been credited against is priced over what is parked on its bill', () => {
  // 10/12 review: basis ± the lines changed went wrong for a line parked
  // without the basis growing — it was never in the basis to take out.
  it('put back water that was never in the basis: the rent keeps its price, and no rent comes back owed', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    // The water is parked, but the month still prices the rent alone ($450).
    const oct = await bill(w, '2026-10-01', { waterParked: true, basis: 450 })
    const r = await patch(w, w.ownerToken, { coveredCharges: ['rent'], openCoveredCharges: 'put_back' })
    expect(r.status).toBe(200)
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 450, rate: hourRateFor(450, 25), target: 25 })

    await logHours(w, '2026-10-20', 25)
    await runWorkTradeSettlement('2026-10-01')
    expect(await line(oct.rentId)).toMatchObject({ status: 'settled', amount: 0 })
    expect(await line(oct.waterId)).toMatchObject({ status: 'pending', amount: 110.55 })
    expect(await total(oct.invoiceId)).toBe(110.55)               // the water only
  })

  it('a month left asking no hours gets its hours back when coverage returns — never covered outright', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01')                       // rent parked; the water not attached yet
    await db.query(`DELETE FROM utility_bills WHERE payment_id = $1`, [oct.waterId])
    await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'test' WHERE id = $1`, [oct.waterId])

    expect((await patch(w, w.ownerToken, { coveredCharges: ['water'], openCoveredCharges: 'put_back' })).status).toBe(200)
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 0, target: 0 })

    // He changes his mind: rent is covered again, and the month asks its 25 hours.
    expect((await patch(w, w.ownerToken, { coveredCharges: ['rent', 'water'] })).status).toBe(200)
    expect(await line(oct.rentId)).toMatchObject({ parked: true })
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 450, target: 25, rate: hourRateFor(450, 25) })

    // No hours worked: nothing is waived.
    await runWorkTradeSettlement('2026-10-01')
    expect(await line(oct.rentId)).not.toMatchObject({ status: 'settled', amount: 0 })
  })
})

describe('a covered utility share released onto a bill already out', () => {
  // 10/12 review: it was parked with the month's covered amount left as it
  // was; the close credited only that and lifted every suspension, so the
  // covered water came back owed at every close.
  it('is parked and the month re-priced over it, so the close covers it too', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01', { waterParked: true })   // $450 + $110.55 parked, basis $560.55
    const c = await getClient()
    let billId: string
    try {
      billId = await seedUtilityBill(c, { meterId: w.meterId, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId,
        landlordId: w.landlordId, chargeAmount: 40, billingCycleMonth: '2026-09-01', status: 'unbilled', utilityType: 'water' })
    } finally { c.release() }
    expect(await attachStrandedUtilityBill(billId)).toBe(true)

    const share = (await db.query(`SELECT payment_id FROM utility_bills WHERE id = $1`, [billId])).rows[0].payment_id
    expect(await line(share)).toMatchObject({ status: 'pending', amount: 40, parked: true })
    expect(await total(oct.invoiceId)).toBe(0)
    expect(await period(oct.invoiceId)).toMatchObject({ basis: 600.55, rate: hourRateFor(600.55, 25) })

    await logHours(w, '2026-10-20', 25)
    await runWorkTradeSettlement('2026-10-01')
    expect(await line(share)).toMatchObject({ status: 'settled', amount: 0, parked: false })
    expect(await line(oct.waterId)).toMatchObject({ status: 'settled', amount: 0 })
    expect(await total(oct.invoiceId)).toBe(0)
  })

  it('a share the trade does not cover is owed, as before', async () => {
    const w = await world({ covers: ['rent'] })
    const oct = await bill(w, '2026-10-01')                        // water owed: $110.55
    const c = await getClient()
    let billId: string
    try {
      billId = await seedUtilityBill(c, { meterId: w.meterId, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId,
        landlordId: w.landlordId, chargeAmount: 40, billingCycleMonth: '2026-09-01', status: 'unbilled', utilityType: 'water' })
    } finally { c.release() }
    expect(await attachStrandedUtilityBill(billId)).toBe(true)
    expect(await total(oct.invoiceId)).toBe(150.55)
    expect((await period(oct.invoiceId)).basis).toBe(450)
  })
})

describe('who may change coverage', () => {
  async function teamToken(w: World, role: 'property_manager' | 'onsite_manager', permissions: Record<string, boolean>) {
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`, [`${role}-${randomUUID()}@t.dev`, role])
    const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
    await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties) VALUES ($1,$2,TRUE)`, [u.rows[0].id, w.landlordId])
    return sign({ userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: w.landlordId, permissions })
  }

  it('an owner and a manager with work-trade permission may; nobody else', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const oct = await bill(w, '2026-10-01', { waterParked: true })
    const other = await world()
    const body = { coveredCharges: ['rent'], openCoveredCharges: 'put_back' }

    expect((await patch(w, w.tenantToken, body)).status).toBe(403)
    expect((await patch(w, other.ownerToken, body)).status).toBe(403)
    expect((await patch(w, await teamToken(w, 'property_manager', {}), body)).status).toBe(403)
    expect((await patch(w, await teamToken(w, 'onsite_manager', { 'work_trade.manage': true }), body)).status).toBe(403)
    expect(await line(oct.waterId)).toMatchObject({ parked: true })          // nothing moved

    const pm = await patch(w, await teamToken(w, 'property_manager', { 'work_trade.manage': true }), body)
    expect(pm.status).toBe(200)
    expect(await line(oct.waterId)).toMatchObject({ parked: false })
  })

  it('the open-charges question is the landlord side\'s only', async () => {
    const w = await world({ covers: ['rent', 'water'] })
    const r = await request(app()).get(`/api/work-trade/${w.agreementId}/covered-open`)
      .set('Authorization', `Bearer ${w.tenantToken}`)
    expect(r.status).toBe(403)
  })
})
