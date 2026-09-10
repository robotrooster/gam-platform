/**
 * S640 (Nic, DIRECTIVE) — work trade is not expected revenue and not outstanding.
 *
 *   "Outstanding and expected monthly rents are probably calculating the work
 *    trade people. Those need to be subtracted from those KPI cards. Those
 *    people are not gonna be paying. It's not outstanding... Keep track of each
 *    work trade total in terms of a line item of revenue that's not coming in,
 *    but don't keep track of it in the outstanding balance or the expected
 *    monthly rent."
 *
 * Six spaces at Mountain View and Oak Park trade rent for labour, $2,869 a month
 * of it. That rent is real and contracted, but it arrives as work, never as
 * money — so counting it as Expected promises the landlord cash that no bank
 * account will ever see, and counting the open invoice as Outstanding sends them
 * chasing a debt that settles in hours at month close.
 *
 * It comes out of both and gets its own figure. Not deleted, not hidden.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_wtrevenue'
})

interface Fx {
  token: string; landlordId: string; propertyId: string
  cashUnit: string; tradeUnit: string; tradeTenantId: string; cashTenantId: string
}

/** One space paying cash at $500, one trading its $460 rent for work. */
async function seed(opts: { coveredCharges?: string[] } = {}): Promise<Fx> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const cashUnit  = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
    const tradeUnit = await seedUnit(c, { propertyId, landlordId, rentAmount: 460 })
    await c.query(`UPDATE units SET status='active' WHERE id IN ($1,$2)`, [cashUnit, tradeUnit])

    const mk = async (unitId: string, rent: number) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant','A','B',TRUE) RETURNING id`, [`wt-${randomUUID()}@t.dev`])
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
      const l = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,$3,'month_to_month','active', CURRENT_DATE - 40) RETURNING id`,
        [unitId, landlordId, rent])
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`,
        [l.rows[0].id, t.rows[0].id])
      return { tenantId: t.rows[0].id, leaseId: l.rows[0].id }
    }
    const cash  = await mk(cashUnit, 500)
    const trade = await mk(tradeUnit, 460)

    await c.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, covered_charges)
       VALUES ($1,$2,$3, CURRENT_DATE - 40, 'active', 80, $4)`,
      [tradeUnit, trade.tenantId, landlordId, opts.coveredCharges ?? ['rent', 'water']])

    // Two open invoices, one of each kind. The work-trade one issues GROSS and
    // carries a suspended charge row — that is how the month is billed while it
    // is still being worked (S624).
    const inv = async (unitId: string, tenantId: string, leaseId: string, amt: number, suspended: boolean) => {
      const i = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 5, $6, $6, 'pending') RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`, amt])
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
                               status, due_date, entry_description, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending', CURRENT_DATE - 5, 'RENT', $7)`,
        [i.rows[0].id, unitId, leaseId, tenantId, landlordId, amt, suspended ? new Date() : null])
    }
    await inv(cashUnit,  cash.tenantId,  cash.leaseId,  500, false)
    await inv(tradeUnit, trade.tenantId, trade.leaseId, 460, true)

    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { token, landlordId, propertyId, cashUnit, tradeUnit,
             tradeTenantId: trade.tenantId, cashTenantId: cash.tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const dashboard = (f: Fx) => request(buildApp())
  .get('/api/landlords/me/dashboard').set('Authorization', `Bearer ${f.token}`)

describe('S640 work trade is out of the money totals', () => {
  it('Expected Monthly Rent counts only the rent that will arrive as money', async () => {
    const f = await seed()
    const res = await dashboard(f)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(500)
    expect(Number(res.body.data.work_trade_rent)).toBe(460)
    expect(res.body.data.work_trade_units).toBe(1)
  })

  it('Outstanding drops the suspended charge and reports it separately', async () => {
    const f = await seed()
    const res = await dashboard(f)
    expect(Number(res.body.data.outstanding)).toBe(500)
    expect(Number(res.body.data.work_trade_suspended)).toBe(460)
  })

  // An agreement that trades only the utilities still expects the rent in cash.
  // Zeroing that unit would understate the roll by a whole space.
  it('leaves rent alone when the agreement does not cover rent', async () => {
    const f = await seed({ coveredCharges: ['water', 'electric'] })
    const res = await dashboard(f)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(960)
    expect(Number(res.body.data.work_trade_rent)).toBe(0)
  })

  it('the rent roll splits the same way the card does, and still lists the space', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/landlords/me/rent-roll').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.total)).toBe(500)
    expect(Number(res.body.data.work_trade_total)).toBe(460)
    expect(res.body.data.rows).toHaveLength(2)
    expect(res.body.data.rows.filter((r: any) => r.work_trade)).toHaveLength(1)
  })

  // The regression this protects against: a NULL from the work-trade lateral
  // join read as "not work trade" the wrong way round would zero every ordinary
  // unit on the roll.
  it('a portfolio with no work trade at all is unchanged', async () => {
    const c = await getClient()
    let token = '', landlordId = ''
    try {
      await c.query('BEGIN')
      const seeded = await seedLandlord(c)
      landlordId = seeded.landlordId
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: seeded.userId, managedByUserId: seeded.userId })
      const u = await seedUnit(c, { propertyId, landlordId, rentAmount: 725 })
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [u])
      await c.query('COMMIT')
      token = jwt.sign(
        { userId: seeded.userId, role: 'landlord', email: 'l2@t.dev', landlordIds: [landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/dashboard').set('Authorization', `Bearer ${token}`)
    expect(Number(res.body.data.monthly_rent_volume)).toBe(725)
    expect(Number(res.body.data.work_trade_rent)).toBe(0)
  })
})
