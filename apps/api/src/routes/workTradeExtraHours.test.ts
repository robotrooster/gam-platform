/**
 * 10/12 (Nic) — extra hours, through the routes.
 *
 *   - the landlord picks per agreement: bank, or pay at a rate by payroll (W-2)
 *     or a contractor payment (1099);
 *   - paid extra hours are paid "Both" ways: Mark paid (by hand) or Send to GAM
 *     Books — an owner or a manager with work-trade permission, nobody else;
 *   - the tenant sees the rate and amount for PAID extra hours, hours only for
 *     banked ones, and never a rate or dollar value for the trade hours (S643)
 *     — on the API response and in the tenant agent's tool output.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { workTradeRouter } from './workTrade'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { runWorkTradeSettlement } from '../jobs/workTradeSettlement'
import { hourRateFor } from '../services/workTradeSettlement'
import { getWorkTradeStanding } from '../services/agents/tools/getWorkTradeStanding'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_workTradeExtraHours'
})

interface World {
  landlordId: string; userId: string; tenantId: string; tenantUserId: string
  agreementId: string; ownerToken: string; tenantToken: string
}

/**
 * An 80-hour trade on $500 September and October bills, with `worked` hours
 * approved in September (86 by default: 6 beyond the month). `mode` sets what
 * extra hours do; 'pay' is $15 an hour by payroll (W-2).
 */
async function world(o: { mode?: 'bank' | 'pay'; worked?: number } = {}): Promise<World> {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const agreementId = (await c.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours,
          carry_forward_months, extra_hours_mode, extra_hours_rate, extra_hours_pay_method)
       VALUES ($1,$2,$3,'2026-09-01','active',80,TRUE,3,$4,$5,$6) RETURNING id`,
      [unitId, tenantId, landlordId, o.mode ?? 'bank', o.mode === 'pay' ? 15 : null,
       o.mode === 'pay' ? 'payroll_w2' : null])).rows[0].id
    for (const month of ['2026-09-01', '2026-10-01']) {
      const inv = (await c.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
         VALUES ($1,$2,$3,$4,$5,$6::date,500,0,$7,TRUE) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `WT-${randomUUID().slice(0, 8)}`, month, agreementId])).rows[0].id
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,'rent',500,'pending',$6::date,'RENT',NOW())`,
        [inv, unitId, leaseId, tenantId, landlordId, month])
      await c.query(
        `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount,
                                             period_start, period_end)
         VALUES ($1,$2,$3::date,80,$4,500,$3::date,($3::date + interval '1 month - 1 day')::date)`,
        [agreementId, inv, month, hourRateFor(500, 80).toFixed(4)])
    }
    await c.query(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
       VALUES ($1,$2,$3,'2026-09-15',$4,'work','approved')`, [agreementId, tenantId, userId, o.worked ?? 86])
    return {
      landlordId, userId, tenantId, tenantUserId, agreementId,
      ownerToken: sign({ userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} }),
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} }),
    }
  } finally { c.release() }
}

async function teamToken(w: World, role: 'property_manager' | 'onsite_manager', permissions: Record<string, boolean>) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Team','Member',TRUE) RETURNING id`, [`${role}-${randomUUID()}@t.dev`, role])
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(`INSERT INTO ${table} (user_id, landlord_id, all_properties) VALUES ($1,$2,TRUE)`, [u.rows[0].id, w.landlordId])
  return sign({ userId: u.rows[0].id, role, email: 'team@t.dev', profileId: null, landlordId: w.landlordId, permissions })
}

const payableId = async (w: World) => (await db.query(
  `SELECT id FROM work_trade_extra_hours WHERE agreement_id=$1`, [w.agreementId])).rows[0]?.id as string
const payable = async (id: string) => (await db.query(
  `SELECT status, to_char(paid_on,'YYYY-MM-DD') AS paid_on, paid_how, paid_note, pay_method,
          sent_to_books_at IS NOT NULL AS sent, books_reference_id
     FROM work_trade_extra_hours WHERE id=$1`, [id])).rows[0]

describe('the extra-hours setting', () => {
  it('a landlord sets an agreement to pay extra hours at a rate, by payroll or 1099', async () => {
    const w = await world()
    const r = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
      .set('Authorization', `Bearer ${w.ownerToken}`)
      .send({ extraHours: 'pay', extraHoursRate: 15, extraHoursPayMethod: 'contractor_1099' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ extraHoursMode: 'pay', extraHoursRate: '15.00', extraHoursPayMethod: 'contractor_1099' })
  })

  it('paying extra hours needs a rate and a way to pay', async () => {
    const w = await world()
    const r = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ extraHours: 'pay' })
    expect(r.status).toBe(400)
    const bad = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ extraHours: 'pay', extraHoursRate: 15, extraHoursPayMethod: 'venmo' })
    expect(bad.status).toBe(400)
  })

  it('a rate is dollars and cents: a fraction of a cent is refused as a 400, not a 500', async () => {
    // 10/12 review: numeric(10,2) stored 0.004 as 0.00 and broke the positive-rate CHECK.
    const w = await world()
    for (const rate of [0.004, 15.125, 0]) {
      const r = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
        .set('Authorization', `Bearer ${w.ownerToken}`)
        .send({ extraHours: 'pay', extraHoursRate: rate, extraHoursPayMethod: 'payroll_w2' })
      expect(r.status).toBe(400)
    }
    const ok = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
      .set('Authorization', `Bearer ${w.ownerToken}`)
      .send({ extraHours: 'pay', extraHoursRate: 0.01, extraHoursPayMethod: 'payroll_w2' })
    expect(ok.status).toBe(200)
  })

  it('switching back to banking keeps the rate for next time', async () => {
    const w = await world({ mode: 'pay' })
    const r = await request(app()).patch(`/api/work-trade/${w.agreementId}`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ extraHours: 'bank' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ extraHoursMode: 'bank', extraHoursRate: '15.00' })
  })
})

describe('paying extra hours: Mark paid and Send to GAM Books', () => {
  it('lists what is owed across the account, then Mark paid records the date, how and note', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const list = await request(app()).get('/api/work-trade/extra-hours').set('Authorization', `Bearer ${w.ownerToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ hours: 6, rate: 15, amount: 90, status: 'unpaid', payMethod: 'payroll_w2' })

    const id = await payableId(w)
    const r = await request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ paidOn: '2026-10-05', paidHow: 'check', note: 'check #1042' })
    expect(r.status).toBe(200)
    expect(await payable(id)).toMatchObject({ status: 'paid', paid_on: '2026-10-05', paid_how: 'check', paid_note: 'check #1042' })
    // Paid once is paid.
    const again = await request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ paidOn: '2026-10-05', paidHow: 'cash' })
    expect(again.status).toBe(409)
    // Off the to-pay list.
    const after = await request(app()).get('/api/work-trade/extra-hours').set('Authorization', `Bearer ${w.ownerToken}`)
    expect(after.body.data).toHaveLength(0)
  })

  it('Send to GAM Books marks it sent with its pay method and leaves the Books reference empty', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const id = await payableId(w)
    const r = await request(app()).post(`/api/work-trade/extra-hours/${id}/send-to-books`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ payMethod: 'contractor_1099' })
    expect(r.status).toBe(200)
    expect(await payable(id)).toMatchObject({ status: 'sent_to_books', sent: true, pay_method: 'contractor_1099', books_reference_id: null })
    expect((await request(app()).post(`/api/work-trade/extra-hours/${id}/send-to-books`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({})).status).toBe(409)
    // Paid another way after all: Mark paid still closes it.
    const paid = await request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ paidOn: '2026-10-06', paidHow: 'cash' })
    expect(paid.status).toBe(200)
  })

  it('a date in the future is refused', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const r = await request(app()).post(`/api/work-trade/extra-hours/${await payableId(w)}/mark-paid`)
      .set('Authorization', `Bearer ${w.ownerToken}`).send({ paidOn: '2999-01-01', paidHow: 'cash' })
    expect(r.status).toBe(400)
  })

  it('only an owner or a manager with work-trade permission may pay', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const id = await payableId(w)
    const other = await world()
    const paidBody = { paidOn: '2026-10-05', paidHow: 'cash' }
    const tries: Array<[string, number]> = [
      [w.tenantToken, 403],
      [other.ownerToken, 403],
      [await teamToken(w, 'property_manager', { 'work_trade.view': true }), 403],
      [await teamToken(w, 'onsite_manager', { 'work_trade.manage': true }), 403],
    ]
    for (const [token, code] of tries) {
      expect((await request(app()).post(`/api/work-trade/extra-hours/${id}/mark-paid`)
        .set('Authorization', `Bearer ${token}`).send(paidBody)).status).toBe(code)
      expect((await request(app()).post(`/api/work-trade/extra-hours/${id}/send-to-books`)
        .set('Authorization', `Bearer ${token}`).send({})).status).toBe(code)
    }
    expect((await payable(id)).status).toBe('unpaid')
    expect((await request(app()).get('/api/work-trade/extra-hours').set('Authorization', `Bearer ${w.tenantToken}`)).status).toBe(403)

    const pm = await teamToken(w, 'property_manager', { 'work_trade.manage': true })
    expect((await request(app()).post(`/api/work-trade/extra-hours/${id}/send-to-books`)
      .set('Authorization', `Bearer ${pm}`).send({})).status).toBe(200)
  })

  it('the list of who is owed what is read only by those who may pay it', async () => {
    // 10/12 review: pay owed to a person is private (S641) — a team role that
    // can see work trade but not pay it never reads the list.
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const list = (token: string) => request(app()).get('/api/work-trade/extra-hours').set('Authorization', `Bearer ${token}`)
    expect((await list(await teamToken(w, 'onsite_manager', { 'work_trade.view': true }))).status).toBe(403)
    const pm = await list(await teamToken(w, 'property_manager', { 'work_trade.view': true }))
    expect(pm.status).toBe(200)
    expect(pm.body.data).toHaveLength(1)
  })
})

describe('what the tenant sees', () => {
  it('paid extra hours carry their rate and amount; the trade hours carry none', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const r = await request(app()).get(`/api/work-trade/${w.agreementId}/standing?month=2026-10-01`)
      .set('Authorization', `Bearer ${w.tenantToken}`)
    expect(r.status).toBe(200)
    const s = r.body.data
    expect(s.carriedValue).toBeNull()
    expect(s.summary).not.toMatch(/\$/)
    expect(s.extraHours.recent).toEqual([
      { periodMonth: '2026-09-01', hours: 6, how: 'paid', rate: 15, amount: 90, status: 'unpaid' }])
    expect(s.extraHours.summary).toBe('6 extra hours in September × $15.00 = $90.00 — paid separately by your landlord')
  })

  it('banked extra hours are hours only, and a carried trade shortfall is never priced', async () => {
    const w = await world({ worked: 86 })
    await runWorkTradeSettlement('2026-09-01')
    // October falls 30 short and carries.
    await db.query(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
       VALUES ($1,$2,$3,'2026-10-15',44,'work','approved')`, [w.agreementId, w.tenantId, w.userId])
    await runWorkTradeSettlement('2026-10-01')
    const tenant = (await request(app()).get(`/api/work-trade/${w.agreementId}/standing?month=2026-11-01`)
      .set('Authorization', `Bearer ${w.tenantToken}`)).body.data
    expect(tenant.carriedHours).toBe(30)        // 80 − 44 − 6 banked
    expect(tenant.carriedValue).toBeNull()
    expect(tenant.summary).not.toMatch(/\$/)
    expect(JSON.stringify(tenant.extraHours)).not.toMatch(/\$|"rate":\d|"amount":\d/)
    expect(tenant.extraHours.recent[0]).toMatchObject({ how: 'banked', hours: 6, rate: null, amount: null })

    // The landlord's copy prices the shortfall (their side of the ledger).
    const landlord = (await request(app()).get(`/api/work-trade/${w.agreementId}/standing?month=2026-11-01`)
      .set('Authorization', `Bearer ${w.ownerToken}`)).body.data
    expect(landlord.carriedValue).toBe(187.5)
  })

  it('the agreement row hides a kept rate from the tenant while the agreement banks', async () => {
    const w = await world({ mode: 'pay' })
    await db.query(`UPDATE work_trade_agreements SET extra_hours_mode='bank' WHERE id=$1`, [w.agreementId])
    const t = (await request(app()).get(`/api/work-trade/${w.agreementId}`).set('Authorization', `Bearer ${w.tenantToken}`)).body.data
    expect(t.agreement.extraHoursRate).toBeNull()
    const l = (await request(app()).get(`/api/work-trade/${w.agreementId}`).set('Authorization', `Bearer ${w.ownerToken}`)).body.data
    expect(l.agreement.extraHoursRate).toBe('15.00')
  })

  it('the tenant agent\'s tool: hours for the trade, rate and amount only for paid extra hours', async () => {
    const w = await world({ mode: 'pay' })
    await runWorkTradeSettlement('2026-09-01')
    const out: any = await getWorkTradeStanding.execute({}, { profileId: w.tenantId, userId: w.tenantUserId, role: 'tenant' } as any)
    expect(out.ok).toBe(true)
    // Every trade figure is hours.
    for (const k of ['hoursThisMonth', 'hoursCarriedOver', 'hoursToBeStraight', 'hoursBanked']) {
      expect(typeof out[k]).toBe('number')
    }
    expect(out.summary).not.toMatch(/\$/)
    expect(out).not.toHaveProperty('carriedValue')
    expect(out.extraHours).toEqual([
      { month: '2026-09-01', hours: 6, paidSeparatelyByLandlord: true, extraHoursRate: 15, amount: 90, paid: false }])

    const b = await world({ worked: 86 })
    await runWorkTradeSettlement('2026-09-01')
    const banked: any = await getWorkTradeStanding.execute({}, { profileId: b.tenantId, userId: b.tenantUserId, role: 'tenant' } as any)
    expect(banked.extraHours).toEqual([{ month: '2026-09-01', hours: 6, banked: true }])
  })
})
