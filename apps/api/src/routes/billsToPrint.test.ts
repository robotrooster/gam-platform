/**
 * 10/27 (Nic) — PAPER BILLS.
 *
 *   "It's a setting on the landlord page, a property level setting. Do you want
 *    to print paper copies of the bills when these are generated? Make it
 *    easier. Just make a button on each invoice that can be printed and make it
 *    where there's a quick print all outstanding button."
 *
 * The sheet is built from services/openBills — the same query the on-screen
 * breakdown reads — so paper and screen cannot disagree about what is owed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
} from '../test/dbHelpers'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'

const TZ = 'America/Phoenix'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/balances', balancesRouter)
  a.use(errorHandler)
  return a
}
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_bills_print'
})
const sign = (userId: string, profileId: string) => jwt.sign(
  { userId, role: 'landlord', email: 'll@t.dev', profileId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

/** One park, two households, each owing a bill with a utility line carrying its meter read. */
async function park() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, TZ])
    const make = async (unitNumber: string, first: string, rent: number, water: number) => {
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: rent })
      await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const tu = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
      await c.query(`UPDATE users SET first_name = $2, last_name = 'Resident' WHERE id = $1`, [tu, first])
      const inv = (await c.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                               subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 3, $6, $7, 'pending') RETURNING id`,
        [ll.landlordId, tenantId, leaseId, unitId, `INV-${unitNumber.replace(/\W/g, '')}`, rent, rent + water])).rows[0].id
      for (const [type, amount, notes] of [
        ['rent', rent, null],
        ['utility', water, 'Water — meter 1204 → 1261'],
      ] as const) {
        await c.query(
          `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status,
                                 entry_description, due_date, invoice_id)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7, CURRENT_DATE - 3, $8)`,
          [ll.landlordId, tenantId, unitId, leaseId, type, amount,
           type === 'rent' ? 'RENT' : 'UTILITY', inv])
        if (notes) await c.query(
          `UPDATE payments SET notes = $2 WHERE invoice_id = $1 AND type = 'utility'`, [inv, notes])
      }
      return { tenantId, unitId, leaseId, unitNumber }
    }
    const a = await make('MH 01', 'Ada', 500, 61.25)
    const b = await make('MH 02', 'Ben', 450, 18.40)
    await c.query('COMMIT')
    return { ...ll, propertyId, a, b, token: sign(ll.userId, ll.landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const get = (s: any, qs: string) =>
  request(app()).get(`/api/balances/bills-to-print?${qs}`).set('Authorization', `Bearer ${s.token}`)

describe('the paper bill sheet', () => {
  it('prints every outstanding bill at a property, one household each', async () => {
    const s = await park()
    const r = await get(s, `propertyId=${s.propertyId}`)
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.property.id).toBe(s.propertyId)
    expect(d.households).toHaveLength(2)
    const byUnit = new Map<string, any>(d.households.map((h: any) => [h.unitNumber, h]))
    expect([...byUnit.keys()].sort()).toEqual(['MH 01', 'MH 02'])
    const ada = byUnit.get('MH 01')
    expect(ada.name).toBe('Ada Resident')
    expect(ada.bills).toHaveLength(1)
    expect(Number(ada.bills[0].balance)).toBe(561.25)
  })

  it('carries the meter read onto the sheet — the reason these get hand-delivered', async () => {
    const s = await park()
    const d = (await get(s, `propertyId=${s.propertyId}`)).body.data
    const ada = d.households.find((h: any) => h.unitNumber === 'MH 01')
    const water = ada.bills[0].lines.find((l: any) => l.label === 'Water')
    expect(water).toBeTruthy()
    expect(water.detail).toContain('meter 1204 → 1261')
    expect(Number(water.amount)).toBe(61.25)
  })

  it('prints one household on its own when asked for one', async () => {
    const s = await park()
    const d = (await get(s, `propertyId=${s.propertyId}&tenantId=${s.b.tenantId}`)).body.data
    expect(d.households).toHaveLength(1)
    expect(d.households[0].unitNumber).toBe('MH 02')
    expect(Number(d.households[0].bills[0].balance)).toBe(468.40)
  })

  it('a paid-up park prints nothing rather than an empty sheet per door', async () => {
    const s = await park()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE landlord_id = $1`, [s.landlordId])
    const d = (await get(s, `propertyId=${s.propertyId}`)).body.data
    expect(d.households).toEqual([])
  })

  it('prints from the resident alone — the button on a bill knows no park', async () => {
    const s = await park()
    const d = (await get(s, `tenantId=${s.a.tenantId}`)).body.data
    expect(d.property.id).toBe(s.propertyId)
    expect(d.households).toHaveLength(1)
    expect(d.households[0].unitNumber).toBe('MH 01')
  })

  it('prints ONE bill when a bill is named', async () => {
    const s = await park()
    const all = (await get(s, `tenantId=${s.a.tenantId}`)).body.data
    const billId = all.households[0].bills[0].id
    const one = (await get(s, `tenantId=${s.a.tenantId}&invoiceId=${billId}`)).body.data
    expect(one.households[0].bills.map((b: any) => b.id)).toEqual([billId])
  })

  it('a derived property is still locked to what the viewer may see', async () => {
    const mine = await park()
    const theirs = await park()
    // Their resident, my token: the derive must not become a way round the lock.
    expect((await get(mine, `tenantId=${theirs.a.tenantId}`)).status).toBe(404)
  })

  // ── 10/27 (Nic): WHAT THEY HAVE ALREADY PUT IN COMES OFF ─────────────────
  //
  //   "if there's any credits or paid ahead amounts partial payments, anything
  //    like that on there, I would hope it would reflect above the balance due
  //    so that it actually takes it into consideration."
  //
  // The statement shows Subtotal, then Payments received and Credit applied as
  // deductions, then Balance due. These are the figures it adds up.
  it('money paid and credit applied come off the balance, and are each said', async () => {
    const s = await park()
    // Ada paid her rent; her water is still open.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW()
        WHERE tenant_id = $1 AND type = 'rent'`, [s.a.tenantId])
    const d = (await get(s, `tenantId=${s.a.tenantId}`)).body.data
    const bill = d.households[0].bills[0]
    // The wire is snake_case; the landlord app camelizes it on the way in.
    expect(Number(bill.amount_paid)).toBe(500)     // the rent, in money
    expect(Number(bill.balance)).toBe(61.25)       // the water, still owed
    // Invoiced is what it all came to — paid plus credit plus still owed, so
    // the three figures on the statement are arithmetically consistent.
    expect(Number(bill.total_amount)).toBe(561.25)
    expect(Number(bill.amount_paid) + Number(bill.credit_applied) + Number(bill.balance))
      .toBeCloseTo(Number(bill.total_amount), 2)
  })

  it('carries the letterhead — a hand-delivered bill names the office', async () => {
    const s = await park()
    await db.query(
      `UPDATE properties SET street1 = '100 Mesa Rd', city = 'Mesa', state = 'AZ', zip = '85201',
                             office_email = 'office@park.test', office_phone = '480-555-0100'
        WHERE id = $1`, [s.propertyId])
    const d = (await get(s, `propertyId=${s.propertyId}`)).body.data
    expect(d.property).toMatchObject({
      address: '100 Mesa Rd', cityLine: 'Mesa, AZ 85201',
      email: 'office@park.test', phone: '480-555-0100',
    })
    expect(d.property.company).toBeTruthy()
  })

  it('refuses a property that is not yours', async () => {
    const s = await park()
    const other = await park()
    expect((await get(s, `propertyId=${other.propertyId}`)).status).toBe(404)
  })

  it('needs a property', async () => {
    const s = await park()
    expect((await get(s, '')).status).toBe(400)
  })
})
