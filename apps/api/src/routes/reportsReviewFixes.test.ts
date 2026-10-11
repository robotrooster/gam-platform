/**
 * S655 money plan, Step 15 review fixes on the reports API:
 *  - the Overview month row's net IS the net of the P&L it opens
 *  - decisions #25: the grand total owed reaches owners and property managers only
 *  - a charge behind a total is filed under the day it counted (a dispute of a
 *    September payment is listed on its October day, not the September settle day)
 *  - the report engine (T-12, custom reports) subtracts lot rent like the P&L
 *  - the tax year's paid-ahead leftover is named for what it is
 *
 * Every pass is shaped as auth.ts mints it (S633: a landlord's profileId null).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { reportsRouter, paidAheadLeftoverLabel } from './reports'
import { errorHandler } from '../middleware/errorHandler'
import { todayIn, monthStartOf } from '../lib/timezone'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reports_review'
})

const sign = (claims: object) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface F {
  uid: string; lid: string; propId: string; unitId: string; tenantId: string; leaseId: string
  owner: string
}

async function seed(): Promise<F> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: uid, landlordId: lid } = await seedLandlord(c)
    const propId = await seedProperty(c, { landlordId: lid, ownerUserId: uid, managedByUserId: uid })
    await c.query(`UPDATE properties SET created_at = '2024-01-01' WHERE id = $1`, [propId])
    const unitId = await seedUnit(c, { propertyId: propId, landlordId: lid })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: lid })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return {
      uid, lid, propId, unitId, tenantId, leaseId,
      owner: sign({ userId: uid, role: 'landlord', email: 'o@t.dev', profileId: null, landlordId: null,
                    landlordIds: [lid], permissions: null }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const get = (token: string, path: string) =>
  request(buildApp()).get(path).set('Authorization', `Bearer ${token}`)

async function settledRent(f: F, amount: number, dueDate: string, settledAt: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
     VALUES ($1,$2,$3,$4,'rent',$5,'settled','RENT',$6::date,$7::timestamptz) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.lid, amount, dueDate, settledAt])).rows[0].id
}

/** A card dispute of a settled row on `at`: the row goes 'returned' and a fresh row reopens at its amount. */
async function dispute(f: F, paymentId: string, amount: number, at: string): Promise<void> {
  const rev = await db.query<{ id: string }>(
    `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                    stripe_event_id, raw_event, created_at)
     VALUES ($1,$2,$3,$4,'card_dispute',$5,$6,'{}',$7::timestamptz) RETURNING id`,
    [paymentId, f.lid, f.tenantId, f.leaseId, amount, `evt_${randomUUID()}`, at])
  await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [paymentId])
  await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
     SELECT unit_id, lease_id, tenant_id, landlord_id, type, $2, 'pending', entry_description, due_date, $3
       FROM payments WHERE id = $1`, [paymentId, amount, rev.rows[0].id])
}

async function teamPass(f: F, role: 'property_manager' | 'onsite_manager'): Promise<string> {
  const uid = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x',$2,'T','M') RETURNING id`,
    [`${role}-${randomUUID()}@t.dev`, role])).rows[0].id
  const table = role === 'property_manager' ? 'property_manager_scopes' : 'onsite_manager_scopes'
  await db.query(`INSERT INTO ${table} (user_id, landlord_id, property_ids, all_properties) VALUES ($1,$2,'{}',TRUE)`, [uid, f.lid])
  return sign({ userId: uid, role, email: `${role}@t.dev`, profileId: null, landlordId: f.lid,
                permissions: { 'payments.view_all': true } })
}

describe('Reports overview: each month row nets the way the P&L it opens nets', () => {
  it('the row\'s net is the P&L net (income less platform fee, maintenance, lot rent and entered expenses), both ways', async () => {
    const f = await seed()
    const today = todayIn(null)
    const monthFirst = monthStartOf(today)
    await settledRent(f, 700, today, new Date(Date.now() - 60_000).toISOString())
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1,$2,'Fix','d','completed',75,NOW() - INTERVAL '1 minute')`, [f.unitId, f.lid])
    await db.query(
      `INSERT INTO lot_rent_charges (unit_id, property_id, landlord_id, billing_month, amount) VALUES ($1,$2,$3,$4::date,120)`,
      [f.unitId, f.propId, f.lid, monthFirst])
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description)
       VALUES ($1,$2,'insurance',50,$3::date,'Policy')`, [f.lid, f.propId, today])
    for (const basis of ['received', 'billed']) {
      const sum = (await get(f.owner, `/api/reports/summary?basis=${basis}`)).body.data
      expect(sum.monthly.length).toBe(6)
      for (const row of sum.monthly) {
        const [y, m] = row.month.split('-').map(Number)
        const pl = (await get(f.owner, `/api/reports/monthly-pl?year=${y}&month=${m}&basis=${basis}`)).body.data
        expect(row.collected).toBe(pl.gross.total)
        expect(row.expenses).toBe(pl.expenses.total)
        expect(row.net).toBe(pl.net)
      }
      const now = sum.monthly[0]
      expect(now.collected).toBe(700)
      // Lot rent, the repair and the entered expense are all inside the net.
      expect(now.net).toBeLessThanOrEqual(700 - 120 - 75 - 50)
    }
  })
})

describe('decisions #25: the grand total of what everyone owes', () => {
  async function seedOwed(f: F) {
    await db.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,300,'pending')`,
      [f.lid, f.tenantId, f.leaseId, f.unitId, `INV-${randomUUID().slice(0, 8)}`])
  }

  it('reaches the account owner and a property manager', async () => {
    const f = await seed()
    await seedOwed(f)
    const owner = (await get(f.owner, '/api/reports/summary')).body.data
    expect(owner.outstanding).toBe(300)
    const pm = await get(await teamPass(f, 'property_manager'), '/api/reports/summary')
    expect(pm.status).toBe(200)
    expect(pm.body.data.outstanding).toBe(300)
  })

  it('is left out of the reply for on-site staff with "View all payments" — not just hidden', async () => {
    const f = await seed()
    await seedOwed(f)
    const res = await get(await teamPass(f, 'onsite_manager'), '/api/reports/summary')
    expect(res.status).toBe(200)
    expect('outstanding' in res.body.data).toBe(false)
    expect(JSON.stringify(res.body)).not.toMatch(/"outstanding"/)
    // The rest of the summary is still theirs.
    expect(res.body.data.monthly.length).toBe(6)
  })
})

describe('the charges behind a total are filed under the day they counted', () => {
  it('a dispute in October of a September payment is an October row on its October day; September keeps the payment', async () => {
    const f = await seed()
    const sep = await settledRent(f, 460, '2026-09-01', '2026-09-18T10:00:00-07:00')
    await dispute(f, sep, 460, '2026-10-10T10:00:00-07:00')
    const oct = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=10')).body.data
    const octRow = oct.payments.find((p: any) => p.id === sep)
    expect(octRow).toMatchObject({ day: '2026-10-10', amount: -460 })
    const sept = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=9')).body.data
    expect(sept.payments.find((p: any) => p.id === sep)).toMatchObject({ day: '2026-09-18', amount: 460 })
  })

  it('a payment and its dispute in the same month are two rows on their own days — one charge, summing to the total', async () => {
    const f = await seed()
    const p = await settledRent(f, 460, '2026-10-01', '2026-10-03T10:00:00-07:00')
    await dispute(f, p, 460, '2026-10-10T10:00:00-07:00')
    const oct = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=10')).body.data
    const rows = oct.payments.filter((r: any) => r.id === p)
    expect(rows.map((r: any) => [r.day, r.amount])).toEqual([['2026-10-10', -460], ['2026-10-03', 460]])
    expect(new Set(oct.payments.map((r: any) => r.key)).size).toBe(oct.payments.length)
    expect(oct.paymentCount).toBe(1)
    expect(oct.rowsTotal).toBe(0)
    const statement = (await get(f.owner, '/api/reports/monthly-statement?year=2026&month=10')).body.data
    expect(statement.rowsTotal).toBe(0)
  })

  it('Money billed files each bill on its due day', async () => {
    const f = await seed()
    const p = await settledRent(f, 500, '2026-08-05', '2026-08-07T10:00:00-07:00')
    const aug = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=8&basis=billed')).body.data
    expect(aug.payments.find((r: any) => r.id === p)).toMatchObject({ day: '2026-08-05', dueDate: '2026-08-05' })
  })
})

describe('the report engine (T-12, custom reports) subtracts lot rent like the P&L', () => {
  async function seedAugust(f: F) {
    await settledRent(f, 900, '2026-08-01', '2026-08-05T10:00:00-07:00')
    await db.query(
      `INSERT INTO lot_rent_charges (unit_id, property_id, landlord_id, billing_month, amount) VALUES ($1,$2,$3,'2026-08-01',120)`,
      [f.unitId, f.propId, f.lid])
    await db.query(
      `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description)
       VALUES ($1,$2,'insurance',30,'2026-08-12','Policy')`, [f.lid, f.propId])
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1,$2,'Fix','d','completed',40,'2026-08-20T10:00:00-07:00')`, [f.unitId, f.lid])
  }

  it('a custom report over a month nets exactly what that month\'s P&L nets, lot rent included', async () => {
    const f = await seed()
    await seedAugust(f)
    const q = (await get(f.owner, '/api/reports/query?start=2026-08-01&end=2026-08-31&level=portfolio&bucket=total')).body.data
    const pl = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=8')).body.data
    expect(q.totals.expenses.lotRent).toBe(120)
    expect(pl.expenses.lotRent).toBe(120)
    expect(q.totals.expenses.total).toBe(pl.expenses.total)
    expect(q.totals.net).toBe(pl.net)
  })

  it('the T-12\'s August carries the lot rent and nets like the P&L', async () => {
    const f = await seed()
    await seedAugust(f)
    const t12 = (await get(f.owner, '/api/reports/t12?asOf=2026-10-03')).body.data
    const aug = t12.rows.filter((r: any) => r.period === '2026-08')
    expect(aug.reduce((s: number, r: any) => s + r.expenses.lotRent, 0)).toBe(120)
    const pl = (await get(f.owner, '/api/reports/monthly-pl?year=2026&month=8')).body.data
    expect(Math.round(aug.reduce((s: number, r: any) => s + r.net, 0) * 100) / 100).toBe(pl.net)
    expect(t12.meta.lotRentIncluded).toBe(true)
  })

  it('a unit-level report puts lot rent on its own lot; a day-by-day report says it is left out', async () => {
    const f = await seed()
    await seedAugust(f)
    const unit = (await get(f.owner, '/api/reports/query?start=2026-08-01&end=2026-08-31&level=unit&bucket=total')).body.data
    expect(unit.rows.find((r: any) => r.unitId === f.unitId).expenses.lotRent).toBe(120)
    const daily = (await get(f.owner, '/api/reports/query?start=2026-08-01&end=2026-08-31&level=portfolio&bucket=daily')).body.data
    expect(daily.totals.expenses.lotRent).toBe(0)
    expect(daily.meta.lotRentIncluded).toBe(false)
  })
})

describe('the tax year\'s money paid ahead and not used', () => {
  it('is "for next year\'s bills" once Dec 31 has passed, and only "not used yet" while the year runs', () => {
    expect(paidAheadLeftoverLabel(2026, '2026-10-03')).toBe('Paid ahead, not used yet')
    expect(paidAheadLeftoverLabel(2026, '2026-12-31')).toBe('Paid ahead, not used yet')
    expect(paidAheadLeftoverLabel(2026, '2027-01-01')).toBe("Paid ahead for next year's bills")
    expect(paidAheadLeftoverLabel(2025, '2026-10-03')).toBe("Paid ahead for next year's bills")
  })

  it('the tax summary of a finished year names the leftover as next year\'s bills', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,920,920,'landlord','2025-12-20T10:00:00-07:00','2025-12-20T10:00:00-07:00')`,
      [f.leaseId, f.tenantId])
    const tax = (await get(f.owner, '/api/reports/tax-summary?year=2025')).body.data
    expect(tax.paidAheadNextYear).toEqual({ label: "Paid ahead for next year's bills", amount: 920 })
  })

  it('the tax summary of the year still running does not call money for this year\'s later bills "next year\'s"', async () => {
    const f = await seed()
    const year = Number(todayIn(null).slice(0, 4))
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,460,460,'landlord',NOW() - INTERVAL '1 minute',NOW() - INTERVAL '1 minute')`,
      [f.leaseId, f.tenantId])
    const tax = (await get(f.owner, `/api/reports/tax-summary?year=${year}`)).body.data
    expect(tax.paidAheadNextYear).toEqual({ label: 'Paid ahead, not used yet', amount: 460 })
  })
})
