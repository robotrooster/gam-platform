/**
 * S607 — a credit lands on the OPEN balance immediately.
 *
 * Nic: "The credit needs to go to the balance and kind of zero it out so that
 * the landlord's not thinking that the tenant still owes money, the books look
 * good, everything's zeroed out."
 *
 * Before this, credits were only consumed when the NEXT invoice was generated —
 * so forgiving a late fee left it showing as owed for the rest of the month, and
 * because rent is pay-in-full, the forgiven charge also blocked the tenant from
 * paying anything at all.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantCreditsRouter } from '../routes/tenantCredits'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenant-credits', tenantCreditsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_credits'
})

async function seedLeaseWithCharges(charges: number[]) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    let day = 1
    for (const amt of charges) {
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'late_fee',$5,'pending', DATE '2026-09-01' + ($6::int), 'LATEFEE')`,
        [unitId, leaseId, tenantId, landlordId, amt, day++])
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { leaseId, tenantId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const openBalance = async (leaseId: string) => Number((await db.query<{ t: string }>(
  `SELECT COALESCE(SUM(amount),0)::text AS t FROM payments
    WHERE lease_id = $1 AND status = 'pending'`, [leaseId])).rows[0].t)

// ─── S638 (Nic, DIRECTIVE) — REWRITTEN. A CREDIT SETTLES NOTHING. ───────────
//
//   "The credit doesn't settle individual items. It takes just the total down.
//    It's not separatable. It's her rent, her trash, her water are line items
//    that combine to one bill. That one total charge has the credit applied
//    against it... The credit has to be applied and visible before they pay."
//
// Every test below used to assert the opposite: that posting a credit closed
// open charges one at a time, oldest first. That is what happened to Kim
// Harland — a $450 Move In Special was issued and instantly spent settling a
// $10.45 water row, a $25 trash row and five $5 late fees. Her credit read
// $389.55, her landlord saw settled charges no money had arrived for, and she
// was still shown the full rent.
//
// S637 had already banned SPLITTING a charge. This goes further: a credit does
// not touch a charge at all. It sits whole on the account and nets against the
// one total wherever a balance is shown or paid.
describe('S638 posting a credit changes no charge', () => {
  it('leaves every open charge exactly as it was', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)

    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 35, category: 'late_fee_refund', reason: 'waived' })
    expect(res.status).toBe(201)

    // The charges stand. Nothing was settled, nothing was split, nothing was
    // invented — the ledger still says what the resident was billed.
    expect(await openBalance(f.leaseId)).toBeCloseTo(35, 2)
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments
        WHERE lease_id = $1 AND status = 'settled'`, [f.leaseId])
    expect(Number(rows[0].n)).toBe(0)
  })

  it('keeps the credit whole, at its full face value', async () => {
    const f = await seedLeaseWithCharges([25, 5, 5])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 35, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(35, 2)
  })

  // A credit bigger than the bill is not change — the rest stays on account.
  it('a credit larger than the balance stays whole too', async () => {
    const f = await seedLeaseWithCharges([50])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 500, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(await openBalance(f.leaseId)).toBeCloseTo(50, 2)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(500, 2)
  })

  it('posts fine against a lease with nothing open', async () => {
    const f = await seedLeaseWithCharges([])
    const res = await request(buildApp()).post('/api/tenant-credits')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseId: f.leaseId, amount: 100, category: 'goodwill' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.amountRemaining ?? res.body.data.amount_remaining))
      .toBeCloseTo(100, 2)
  })
})

// ── S648 (Nic): "every dollar should only be counted once. Everywhere." ────
//
// The pay flows take a GENERAL (lease-less) credit off what is owed, so the
// step that spends credits has to be able to spend it too — otherwise the same
// general credit comes off every bill forever. And it is only ever the issuing
// landlord's to spend.
describe('S648 general credits', () => {
  it('are spent by the lease they cover, once', async () => {
    const f = await seedLeaseWithCharges([40])
    const { applyCreditsToOpenCharges } = await import('./creditApplication')
    const ll = (await db.query(`SELECT landlord_id FROM leases WHERE id=$1`, [f.leaseId])).rows[0].landlord_id
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,50,50,'goodwill')`, [ll, f.tenantId])
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await applyCreditsToOpenCharges(c, { leaseId: f.leaseId, scope: 'lease' })
      await c.query('COMMIT')
      expect(r.applied).toBe(40)
    } finally { c.release() }
    const left = (await db.query(`SELECT amount_remaining::float AS a FROM tenant_credits WHERE tenant_id=$1`, [f.tenantId])).rows[0].a
    expect(left).toBe(10)
  })

  it('never cross to another landlord', async () => {
    const f = await seedLeaseWithCharges([40])
    const other = await (async () => {
      const c = await db.connect()
      try { return (await seedLandlord(c)).landlordId } finally { c.release() }
    })()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,50,50,'goodwill')`, [other, f.tenantId])
    const { applyCreditsToOpenCharges } = await import('./creditApplication')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await applyCreditsToOpenCharges(c, { leaseId: f.leaseId, scope: 'lease' })
      await c.query('COMMIT')
      expect(r.applied).toBe(0)
    } finally { c.release() }
  })
})

// ── S654: rows a credit must never settle ───────────────────────────────────
// A work-trade line is paid in hours at month close; a neighbor's utility on a
// shared bill belongs to another landlord. Neither is this credit's to clear —
// at invoice generation (invoice scope) or anywhere on the lease (lease scope).
describe('S654 a credit passes over work-trade lines and a neighbor’s utility', () => {
  async function applyIn(leaseId: string, opts: { scope: 'invoice' | 'lease'; invoiceId?: string }) {
    const { applyCreditsToOpenCharges } = await import('./creditApplication')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await applyCreditsToOpenCharges(c, { leaseId, ...opts })
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('lease scope: an $8 work-trade line stays as it is', async () => {
    const f = await seedLeaseWithCharges([])
    const l = (await db.query(`SELECT unit_id, landlord_id FROM leases WHERE id=$1`, [f.leaseId])).rows[0]
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'utility',8,'pending','2026-09-01','UTILITY',NOW())`,
      [l.unit_id, f.leaseId, f.tenantId, l.landlord_id])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill')`, [l.landlord_id, f.tenantId, f.leaseId])
    expect((await applyIn(f.leaseId, { scope: 'lease' })).applied).toBe(0)
    expect(await openBalance(f.leaseId)).toBeCloseTo(8, 2)
  })

  it('invoice scope: neither the work-trade line nor the neighbor’s utility is touched', async () => {
    const f = await seedLeaseWithCharges([])
    const l = (await db.query(`SELECT unit_id, landlord_id FROM leases WHERE id=$1`, [f.leaseId])).rows[0]
    const nb = await (async () => { const c = await db.connect(); try { return await seedLandlord(c) } finally { c.release() } })()
    const { rows: [inv] } = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-S654-CA','2026-10-01',5,'pending') RETURNING id`,
      [l.landlord_id, f.tenantId, f.leaseId, l.unit_id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,'utility',8,'pending','2026-10-01','UTILITY',NOW())`,
      [inv.id, l.unit_id, f.leaseId, f.tenantId, l.landlord_id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,NULL,$3,$4,'utility',5,'pending','2026-10-01','UTILITY')`,
      [inv.id, l.unit_id, f.tenantId, nb.landlordId])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,20,20,'goodwill')`, [l.landlord_id, f.tenantId, f.leaseId])
    expect((await applyIn(f.leaseId, { scope: 'invoice', invoiceId: inv.id })).applied).toBe(0)
    const { rows } = await db.query(`SELECT status FROM payments WHERE invoice_id = $1`, [inv.id])
    expect(rows.map((r: any) => r.status)).toEqual(['pending', 'pending'])
  })
})
