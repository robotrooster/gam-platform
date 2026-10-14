/**
 * 10/14 (Nic) — each bill is paid on its own at the desk.
 *
 * "we set it up previously where somebody with two spaces, like Kevin Black,
 * could pay each invoice separately, but not partial of those invoices, but
 * was not required to pay both invoices together ... we also need to be able
 * to log each separate bill as one payment ... the only thing I wanted paid
 * together was the itemized lines of that invoice. It couldn't settle
 * separately, but each separate invoice is its own thing."
 *
 * Billy Miranda (Oak Park, RV 34 and RV 35, two leases): Tyler could not log
 * Billy's cash against RV 34 alone. Now the desk picks the bills:
 *   1. the window lists every open bill, by space, nothing picked for it;
 *   2. a picked bill is paid whole (all its lines together), never in part
 *      unless the property takes part payments;
 *   3. within one space the oldest bill is paid first (October waits for
 *      September); different spaces are independent;
 *   4. credit pays only the bills picked, and a space's own credit never pays
 *      another space's bill;
 *   5. money kept over the bills picked stays on that space.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))
const emailPaymentReceipt = vi.hoisted(() => vi.fn(async (..._a: any[]) => 'msg_test'))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<typeof import('../services/email')>()),
  emailPaymentReceipt,
  sendNotificationEmail: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { paymentsRouter } from './payments'
import { errorHandler } from '../middleware/errorHandler'
import { createIssuedCredit } from '../services/creditUse'

const TZ = 'America/Phoenix'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPaymentReceipt.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_pick_bills'
})

const sign = (userId: string, role: string, extra: Record<string, unknown> = {}) => jwt.sign(
  { userId, role, email: `${role}@t.dev`, permissions: {}, ...extra }, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Space { unitId: string; leaseId: string }
interface Stack {
  landlordId: string; ownerUserId: string; propertyId: string; tenantId: string; token: string
  rv34: Space; rv35: Space
}

/** Billy's household: one resident on two leases at one park — RV 34 and RV 35. */
async function stack(opts: { partial?: boolean } = {}): Promise<Stack> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone = $2, accept_partial_payments = $3 WHERE id = $1`,
      [propertyId, TZ, opts.partial === true])
    const tenantId = await seedTenant(c)
    const space = async (unitNumber: string, rent: number): Promise<Space> => {
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: rent })
      await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      return { unitId, leaseId }
    }
    const rv34 = await space('RV 34', 220)
    const rv35 = await space('RV 35', 440)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Billy Jose', last_name = 'Miranda' WHERE id = $1`, [tenantUserId])
    await c.query('COMMIT')
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propertyId, tenantId, rv34, rv35,
      token: sign(ll.userId, 'landlord', { profileId: ll.landlordId }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A bill (an invoice with its lines) on one space, due `daysAgo` days ago on the park's calendar. */
async function bill(s: Stack, sp: Space, charges: Array<{ type: 'rent' | 'utility'; amount: number }>, daysAgo: number) {
  const total = charges.reduce((t, x) => t + x.amount, 0)
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE $6)::date - $7::int, $8, $8, 'pending', NOW() - ($7::int || ' days')::interval) RETURNING id`,
    [s.landlordId, s.tenantId, sp.leaseId, sp.unitId, `INV-${Math.random().toString(36).slice(2, 9)}`, TZ, daysAgo, total])).rows[0].id
  const ids: string[] = []
  for (const ch of charges) {
    ids.push((await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, (NOW() AT TIME ZONE $8)::date - $9::int, $10, NOW() - ($9::int || ' days')::interval) RETURNING id`,
      [s.landlordId, s.tenantId, sp.unitId, sp.leaseId, ch.type, ch.amount, ch.type === 'rent' ? 'RENT' : 'UTILITY', TZ, daysAgo, inv])).rows[0].id)
  }
  return { invoiceId: inv, ids }
}

/** Billy's four open bills, as at Oak Park on 10/14. */
async function billysBills(s: Stack) {
  return {
    rv34Sep: await bill(s, s.rv34, [{ type: 'rent', amount: 220 }, { type: 'utility', amount: 237.07 }], 43),
    rv34Oct: await bill(s, s.rv34, [{ type: 'rent', amount: 220 }, { type: 'utility', amount: 150.13 }], 13),
    rv35Sep: await bill(s, s.rv35, [{ type: 'rent', amount: 440 }, { type: 'utility', amount: 5.22 }], 43),
    rv35Oct: await bill(s, s.rv35, [{ type: 'rent', amount: 440 }, { type: 'utility', amount: 5.22 }], 13),
  }
}

/** A credit the landlord gave (its own transaction). */
async function issueCredit(c: Parameters<typeof createIssuedCredit>[1]) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await createIssuedCredit(client, c)
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const record = (s: Stack, anchor: string, body: Record<string, unknown>) =>
  request(app()).post(`/api/payments/${anchor}/record-manual`).set('Authorization', `Bearer ${s.token}`).send(body)
const quote = (s: Stack, anchor: string, bills: string[] | null) =>
  request(app()).get(`/api/payments/${anchor}/record-manual/quote${bills === null ? '' : `?bills=${bills.join(',')}`}`)
    .set('Authorization', `Bearer ${s.token}`)
const statusOf = async (ids: string[]) => (await db.query<{ status: string }>(
  `SELECT status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY status`, [ids])).rows.map(r => r.status)
const usesOn = async (ids: string[]) => (await db.query<{ n: string }>(
  `SELECT COUNT(*)::text AS n FROM credit_uses WHERE payment_id = ANY($1::uuid[])`, [ids])).rows[0].n

describe('the desk lists every open bill, by space, and picks none', () => {
  it('nothing picked: every bill listed with the older bills of its space; nothing is being paid yet', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const res = await quote(s, b.rv35Sep.ids[0], [])
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.pickedBillIds).toEqual([])
    expect(d.rows).toEqual([])
    expect(d.currentTotal).toBe(0)
    expect(d.owedIfSaved).toBe(0)
    // The whole balance is still said: every bill, picked or not.
    expect(d.fullBalance).toBe(1717.64)
    const byId = new Map<string, any>(d.bills.map((x: any) => [x.id, x]))
    expect(byId.size).toBe(4)
    expect(byId.get(b.rv34Sep.invoiceId)).toMatchObject({ leaseId: s.rv34.leaseId, unitNumber: 'RV 34', total: 457.07, owed: 457.07, olderBillIds: [] })
    expect(byId.get(b.rv34Oct.invoiceId)).toMatchObject({ unitNumber: 'RV 34', total: 370.13, olderBillIds: [b.rv34Sep.invoiceId] })
    // A different space is independent: RV 35's October waits only for RV 35's September.
    expect(byId.get(b.rv35Oct.invoiceId).olderBillIds).toEqual([b.rv35Sep.invoiceId])
    // Each bill carries its own lines, together.
    expect(byId.get(b.rv35Oct.invoiceId).rows.map((r: any) => r.id).sort()).toEqual([...b.rv35Oct.ids].sort())
  })

  it('no pick named (an older screen, the assistant): every bill, as before', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const d = (await quote(s, b.rv35Sep.ids[0], null)).body.data
    expect(d.pickedBillIds).toBeNull()
    expect(d.currentTotal).toBe(1717.64)
  })
})

describe('Billy pays RV 34 alone (10/14)', () => {
  it('cash for RV 34\'s two bills settles exactly those — RV 35 is untouched', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const picks = [b.rv34Sep.invoiceId, b.rv34Oct.invoiceId]
    const q = (await quote(s, b.rv35Sep.ids[0], picks)).body.data
    expect(q.pickedBillIds.sort()).toEqual([...picks].sort())
    expect(q.currentTotal).toBe(827.2)
    expect(q.owedIfSaved).toBe(827.2)
    expect(q.fullBalance).toBe(1717.64)
    expect(q.pickRefusal).toBeNull()

    // The window was opened on RV 35's charge: the anchor only says whose balance it is.
    const res = await record(s, b.rv35Sep.ids[0], { method: 'cash', amountTendered: 827.2, bills: picks })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ amountSettled: 827.2, changeGiven: 0, partial: false })
    expect(res.body.data.settledPaymentIds.sort()).toEqual([...b.rv34Sep.ids, ...b.rv34Oct.ids].sort())
    expect(await statusOf([...b.rv34Sep.ids, ...b.rv34Oct.ids])).toEqual(['settled', 'settled', 'settled', 'settled'])
    expect(await statusOf([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toEqual(['pending', 'pending', 'pending', 'pending'])
    // The receipt is RV 34's.
    const rem = (await db.query<any>(`SELECT lease_id, amount::float AS amount FROM tenant_remittances WHERE id = $1`, [res.body.data.receiptId])).rows[0]
    expect(rem).toEqual({ lease_id: s.rv34.leaseId, amount: 827.2 })
  })

  it('the oldest bill of a space alone is fine; a newer one alone is refused — October waits for September', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const ok = await record(s, b.rv34Sep.ids[0], { method: 'cash', amountTendered: 457.07, bills: [b.rv34Sep.invoiceId] })
    expect(ok.status).toBe(200)
    expect(await statusOf(b.rv34Sep.ids)).toEqual(['settled', 'settled'])
    expect(await statusOf(b.rv34Oct.ids)).toEqual(['pending', 'pending'])

    const q = (await quote(s, b.rv35Oct.ids[0], [b.rv35Oct.invoiceId])).body.data
    expect(q.pickRefusal).toMatch(/^The [A-Z][a-z]+ bill on RV 35 is older and still open — pick it too\. In one space the oldest bill is paid first\.$/)
    const late = await record(s, b.rv35Oct.ids[0], { method: 'cash', amountTendered: 445.22, bills: [b.rv35Oct.invoiceId] })
    expect(late.status).toBe(422)
    expect(late.body.error).toBe(q.pickRefusal)
    expect(await statusOf([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toEqual(['pending', 'pending', 'pending', 'pending'])
    // RV 34's September was paid, so RV 34's October stands alone now.
    const next = await record(s, b.rv34Oct.ids[0], { method: 'cash', amountTendered: 370.13, bills: [b.rv34Oct.invoiceId] })
    expect(next.status).toBe(200)
  })

  it('a bill is paid whole — every line together; never part of it at a park that takes no part payments', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const short = await record(s, b.rv35Sep.ids[0], { method: 'cash', amountTendered: 440, bills: [b.rv35Sep.invoiceId] })
    expect(short.status).toBe(422)
    expect(short.body.error).toBe('That is $5.22 short — $440.00 against $445.22 owed. Rent is paid in full.')
    expect(await statusOf(b.rv35Sep.ids)).toEqual(['pending', 'pending'])
  })

  it('nothing picked is refused in plain words; a bill paid meanwhile is "look again"', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const none = await record(s, b.rv34Sep.ids[0], { method: 'cash', amountTendered: 100, bills: [] })
    expect(none.status).toBe(422)
    expect(none.body.error).toBe('Pick the bills this money pays — each bill is paid whole.')

    expect((await record(s, b.rv34Sep.ids[0], { method: 'cash', amountTendered: 457.07, bills: [b.rv34Sep.invoiceId] })).status).toBe(200)
    // A second desk, still showing RV 34's September as open.
    const again = await record(s, b.rv35Sep.ids[0], { method: 'cash', amountTendered: 457.07, bills: [b.rv34Sep.invoiceId] })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/A bill picked here is no longer open/)
    expect(await statusOf(b.rv35Sep.ids)).toEqual(['pending', 'pending'])
    // The quote leaves it out of every figure.
    const q = (await quote(s, b.rv35Sep.ids[0], [b.rv34Sep.invoiceId, b.rv35Sep.invoiceId])).body.data
    expect(q.pickedBillIds).toEqual([b.rv35Sep.invoiceId])
    expect(q.currentTotal).toBe(445.22)
  })

  it('a check over the picked bills: the extra stays on that space as money paid ahead', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const res = await record(s, b.rv35Sep.ids[0], {
      method: 'check', reference: '1042', amountTendered: 500, confirmWrittenAmount: true, bills: [b.rv34Sep.invoiceId],
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ surplus: 42.93, surplusHandling: 'credit' })
    const credit = (await db.query<any>(`SELECT lease_id FROM lease_prepaid_credits WHERE id = $1`, [res.body.data.creditId])).rows[0]
    expect(credit.lease_id).toBe(s.rv34.leaseId)
    // Never RV 35's: nothing of it went on RV 35's bills.
    expect(await usesOn([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toBe('0')
    expect(await statusOf([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toEqual(['pending', 'pending', 'pending', 'pending'])
  })
})

describe('credit pays only the bills picked', () => {
  it('a general credit goes on the picked bill, never set aside for a bill left for another day', async () => {
    const s = await stack()
    const b = await billysBills(s)
    await issueCredit({ landlordId: s.landlordId, tenantId: s.tenantId, amount: 100, category: 'goodwill', reason: 'test' })
    const q = (await quote(s, b.rv35Sep.ids[0], [b.rv35Sep.invoiceId])).body.data
    expect(q.creditAvailable).toBe(100)
    expect(q.owedIfUsed).toBe(345.22)
    const res = await record(s, b.rv35Sep.ids[0], { method: 'cash', amountTendered: 345.22, creditToUse: 100, bills: [b.rv35Sep.invoiceId] })
    expect(res.status).toBe(200)
    expect(res.body.data.creditUsed).toBe(100)
    expect(await statusOf(b.rv35Sep.ids)).toEqual(['settled', 'settled'])
    expect(await usesOn([...b.rv34Sep.ids, ...b.rv34Oct.ids, ...b.rv35Oct.ids])).toBe('0')
  })

  it('credit tied to one space never pays the other space\'s bill — two spaces, two households', async () => {
    const s = await stack()
    const b = await billysBills(s)
    await issueCredit({ landlordId: s.landlordId, tenantId: s.tenantId, leaseId: s.rv34.leaseId, amount: 50, category: 'goodwill', reason: 'test' })
    const rv35 = (await quote(s, b.rv35Sep.ids[0], [b.rv35Sep.invoiceId])).body.data
    expect(rv35.creditAvailable).toBe(0)
    const rv34 = (await quote(s, b.rv35Sep.ids[0], [b.rv34Sep.invoiceId])).body.data
    expect(rv34.creditAvailable).toBe(50)
  })
})

describe('a park that takes part payments', () => {
  it('the picked bills are paid oldest first; the rest of the newest rent stays owed; the other space is untouched', async () => {
    const s = await stack({ partial: true })
    const b = await billysBills(s)
    const res = await record(s, b.rv34Sep.ids[0], {
      method: 'cash', amountTendered: 557.07, bills: [b.rv34Sep.invoiceId, b.rv34Oct.invoiceId],
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ partial: true, stillOwed: 270.13 })
    expect(await statusOf(b.rv34Sep.ids)).toEqual(['settled', 'settled'])
    expect(await statusOf([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toEqual(['pending', 'pending', 'pending', 'pending'])
  })
})

describe('a bank deposit dated back: late fees judged on the bills picked', () => {
  /** A $5 late fee on a bill, charged `daysAgo` days ago. */
  async function lateFee(s: Stack, sp: Space, invoiceId: string, daysAgo: number) {
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, created_at)
       VALUES ($1, $2, $3, $4, 'late_fee', 5, 'pending', 'LATEFEE', (NOW() AT TIME ZONE $5)::date - $6::int, $7, NOW() - ($6::int || ' days')::interval)
       RETURNING id`, [s.landlordId, s.tenantId, sp.unitId, sp.leaseId, TZ, daysAgo, invoiceId])).rows[0].id
  }
  const daysAgoDate = async (n: number) => (await db.query<{ d: string }>(
    `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS d`, [TZ, n])).rows[0].d

  it('only the picked bills\' late fees come off — a space not picked keeps its own', async () => {
    const s = await stack()
    const b = await billysBills(s)
    const fees = [await lateFee(s, s.rv35, b.rv35Oct.invoiceId, 4), await lateFee(s, s.rv35, b.rv35Oct.invoiceId, 3)]
    const on = await daysAgoDate(5)
    // RV 34 picked: RV 35's late fees are not this payment's business.
    const rv34 = (await request(app()).get(`/api/payments/${b.rv34Sep.ids[0]}/record-manual/quote?depositedOn=${on}&bills=${b.rv34Sep.invoiceId}`)
      .set('Authorization', `Bearer ${s.token}`)).body.data
    expect(rv34.lateFeesOffIfPaidInFull).toBe(0)
    const paid34 = await record(s, b.rv34Sep.ids[0], {
      method: 'bank_deposit', reference: 'DEP-34', amountTendered: 457.07, depositedOn: on, bills: [b.rv34Sep.invoiceId],
    })
    expect(paid34.status).toBe(200)
    expect(paid34.body.data.lateFeesUnbilled).toBe(0)
    expect(await usesOn(fees)).toBe('0')

    // RV 35's two bills picked and paid in full: the fees charged after the deposit come off.
    const both = [b.rv35Sep.invoiceId, b.rv35Oct.invoiceId]
    const rv35 = (await request(app()).get(`/api/payments/${b.rv35Sep.ids[0]}/record-manual/quote?depositedOn=${on}&bills=${both.join(',')}`)
      .set('Authorization', `Bearer ${s.token}`)).body.data
    expect(rv35.lateFeesOffIfPaidInFull).toBe(10)
    expect(rv35.owedIfSaved).toBe(890.44)
    const paid35 = await record(s, b.rv35Sep.ids[0], {
      method: 'bank_deposit', reference: 'DEP-35', amountTendered: 890.44, depositedOn: on, bills: both,
    })
    expect(paid35.status).toBe(200)
    expect(paid35.body.data.lateFeesUnbilled).toBe(10)
    expect(await statusOf([...b.rv35Sep.ids, ...b.rv35Oct.ids])).toEqual(['settled', 'settled', 'settled', 'settled'])
  })
})
