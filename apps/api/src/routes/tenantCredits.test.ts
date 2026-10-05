/**
 * S577 — landlord-issued tenant account credits.
 * API (issue / list / void / scoping) + consumption through generateInvoices
 * (independent of work-trade).
 *
 * S655 (Nic, 10/2): a credit pays a bill by itself only when it covers the
 * whole bill — at the bill run and the moment it is issued. A void is a
 * status: what was left stays recorded and can never be used.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { tenantCreditsRouter } from './tenantCredits'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { errorHandler } from '../middleware/errorHandler'
import { holdCredit, runWholeBillCheckAfterCommit } from '../services/creditUse'
import { lockHousehold } from '../services/moneyPredicates'

const app = express()
app.use(express.json())
app.use('/api/tenant-credits', tenantCreditsRouter)
app.use(errorHandler)

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tc'
})

async function seed() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const A = await seedLandlord(c)
    const B = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: A.landlordId, ownerUserId: A.userId, managedByUserId: A.userId })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: A.landlordId, rentAmount: 1000 })
    const leaseA = await seedLease(c, { unitId: unitA, landlordId: A.landlordId, rentAmount: 1000, status: 'active', startDate: '2026-04-01' })
    await c.query('UPDATE leases SET rent_due_day=1 WHERE id=$1', [leaseA])
    const tenantA = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId: tenantA, role: 'primary' })
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      leaseA, tenantA, landlordAId: A.landlordId, unitA, landlordBId: B.landlordId, userAId: A.userId,
      tokenA: sign({ userId: A.userId, role: 'landlord', email: 'a@t.dev', profileId: A.landlordId, permissions: {} }),
      tokenB: sign({ userId: B.userId, role: 'landlord', email: 'b@t.dev', profileId: B.landlordId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const NOW = new Date('2026-05-05T12:00:00Z')

/** An open (or clearing) rent charge on lease A. */
async function rentRow(f: { leaseA: string; unitA: string; tenantA: string; landlordAId: string }, amount: number,
  o: { status?: string; intent?: string } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,'rent',$5,$6,'2026-04-20','RENT',$7) RETURNING id`,
    [f.unitA, f.leaseA, f.tenantA, f.landlordAId, amount.toFixed(2), o.status ?? 'pending', o.intent ?? null])
  return r.rows[0].id
}

describe('tenant credits — API', () => {
  it('landlord issues a credit (201) and can list it', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 42.94, category: 'screening_cap', reason: 'AZ cap' })
    expect(issue.status).toBe(201)
    expect(Number(issue.body.data.amount_remaining)).toBeCloseTo(42.94, 2)
    const list = await request(app).get(`/api/tenant-credits?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].category).toBe('screening_cap')
    expect(list.body.data[0].amount_usable).toBe('42.94')
  })

  it('another landlord cannot issue on the lease (403)', async () => {
    const f = await seed()
    const res = await request(app).post('/api/tenant-credits').set(auth(f.tokenB))
      .send({ leaseId: f.leaseA, amount: 50 })
    expect(res.status).toBe(403)
  })

  it('void leaves amount_remaining as it was', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 100 })
    const id = issue.body.data.id
    const v = await request(app).post(`/api/tenant-credits/${id}/void`).set(auth(f.tokenA))
    expect(v.status).toBe(200)
    expect(v.body.data.message).toMatch(/\$100\.00 left on this credit can no longer be used/)
    const { rows } = await db.query('SELECT status, amount_remaining, voided_at FROM tenant_credits WHERE id=$1', [id])
    expect(rows[0].status).toBe('void')
    // A void is a status, not a spend: the ledger is the only thing that moves the figure.
    expect(Number(rows[0].amount_remaining)).toBe(100)
    expect(rows[0].voided_at).not.toBeNull()
    // The list says what can still be spent: nothing, though the leftover stays on record.
    const list = await request(app).get(`/api/tenant-credits?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    expect(list.body.data[0]).toMatchObject({ status: 'void', amount_remaining: '100.00', amount_usable: '0.00' })
    // And a void credit pays nothing, even a bill it would cover in full.
    const rent = await rentRow(f, 100)
    await runWholeBillCheckAfterCommit({ tenantId: f.tenantA, landlordId: f.landlordAId })
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT 1 FROM credit_uses WHERE tenant_credit_id = $1`, [id])).rows).toHaveLength(0)
    const again = await request(app).post(`/api/tenant-credits/${id}/void`).set(auth(f.tokenA))
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('This credit is already void.')
  })

  it('a credit covering the whole open bill settles it', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 1000, category: 'overcharge' })
    expect(issue.status).toBe(201)
    expect(issue.body.data.paidBill).toEqual({ charges: 1, creditUsed: 1000 })
    expect(issue.body.data.message).toMatch(/paid the tenant's whole open bill \(\$1000\.00\)/)
    const row = await db.query<{ status: string; issued: string }>(
      `SELECT status, issued_credit_amount::text AS issued FROM payments WHERE id = $1`, [rent])
    expect(row.rows[0].status).toBe('settled')
    // Paid by a credit the landlord gave: never the landlord's income.
    expect(Number(row.rows[0].issued)).toBe(1000)
    const left = await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [issue.body.data.id])
    expect(Number(left.rows[0].r)).toBe(0)
  })

  it('a smaller credit settles nothing and shows as available', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 300 })
    expect(issue.status).toBe(201)
    expect(issue.body.data.paidBill).toBeNull()
    expect(issue.body.data.creditOnAccount).toBe(300)
    expect(issue.body.data.creditAvailable).toBe(300)
    expect(issue.body.data.message).toMatch(/pays a bill by itself only when it covers the whole bill/)
    expect((await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('pending')
    expect(Number(issue.body.data.amount_remaining)).toBe(300)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rows).toHaveLength(0)
  })

  it('a credit cannot be voided while a payment holds it', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 50 })
    const creditId = issue.body.data.id
    // A bank payment still clearing has set $50 of it aside on the rent.
    const rent = await rentRow(f, 1000, { status: 'processing', intent: 'pi_clearing_1' })
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,950,950,0,'processing','ach','pi_clearing_1',0) RETURNING id`,
      [f.tenantA, f.leaseA, f.landlordAId])).rows[0].id
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId, paymentId: rent, leaseId: f.leaseA, amount: 50, billingMonth: '2026-05-01' }],
        { remittanceId: rem, source: 'portal' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const v = await request(app).post(`/api/tenant-credits/${creditId}/void`).set(auth(f.tokenA))
    expect(v.status).toBe(409)
    expect(v.body.error).toMatch(/\$50\.00 of this credit is set aside for a payment that is still going through/)
    const { rows } = await db.query('SELECT status FROM tenant_credits WHERE id=$1', [creditId])
    expect(rows[0].status).toBe('active')
  })

  it('interest on the tenant\'s deposit cannot be voided by the landlord', async () => {
    const f = await seed()
    const id = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,12.50,12.50,'deposit_interest') RETURNING id`, [f.landlordAId, f.tenantA, f.leaseA])).rows[0].id
    const v = await request(app).post(`/api/tenant-credits/${id}/void`).set(auth(f.tokenA))
    expect(v.status).toBe(409)
    expect(v.body.error).toMatch(/owed by law/)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [id])).rows[0].status).toBe('active')
  })

  it('another landlord sees none of this tenant\'s credits with this landlord', async () => {
    const f = await seed()
    await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 25 })
    // A general credit (no lease) used to skip the check entirely.
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,40,40,'goodwill')`, [f.landlordAId, f.tenantA])
    const mine = await request(app).get(`/api/tenant-credits?tenantId=${f.tenantA}`).set(auth(f.tokenA))
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(2)
    expect(mine.body.data[0].landlord_id).toBeUndefined()
    const theirs = await request(app).get(`/api/tenant-credits?tenantId=${f.tenantA}`).set(auth(f.tokenB))
    expect(theirs.status).toBe(200)
    expect(theirs.body.data).toEqual([])
    const byLease = await request(app).get(`/api/tenant-credits?leaseId=${f.leaseA}`).set(auth(f.tokenB))
    expect(byLease.status).toBe(403)
  })

  it('issuing a credit waits for another writer holding the household', async () => {
    const f = await seed()
    const holder = await getClient()
    let done = false
    try {
      await holder.query('BEGIN')
      await lockHousehold(holder, f.tenantA, f.landlordAId)
      const issuing = request(app).post('/api/tenant-credits').set(auth(f.tokenA))
        .send({ leaseId: f.leaseA, amount: 10 }).then(r => { done = true; return r })
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        waiting = Number(w.rows[0].n) > 0
        if (!waiting) await new Promise(r => setTimeout(r, 50))
      }
      expect(waiting).toBe(true)
      expect(done).toBe(false)
      await holder.query('COMMIT')
      expect((await issuing).status).toBe(201)
    } finally { holder.release() }
  })
})

describe('tenant credits — consumption at invoice generation', () => {
  async function issueCredit(leaseId: string, tenantId: string, landlordId: string, amount: number) {
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,$4,$4,'goodwill')`, [landlordId, tenantId, leaseId, amount.toFixed(2)])
  }
  async function pendingOwed(leaseId: string) {
    const inv = await db.query<any>('SELECT id FROM invoices WHERE lease_id=$1', [leaseId])
    const pays = await db.query<any>(
      `SELECT COALESCE(SUM(amount),0)::float AS owed FROM payments
        WHERE invoice_id=$1 AND status='pending'`, [inv.rows[0].id])
    return Math.round(pays.rows[0].owed * 100) / 100
  }

  // S637 (Nic, DIRECTIVE): "It's a credit against the overall ledger, not
  // fucking settling partial payments. We don't do partial payments."
  //
  // This used to assert the SPLIT: a $300 credit carved the $1,000 rent into a
  // $300 settled slice and a $700 pending remainder, so raw pending came to
  // $700. The tenant still owes $700 — that answer was never in dispute — but
  // it now comes from netting a whole $1,000 charge against a $300 credit
  // sitting on the account, not from rewriting the rent row.
  it('S637: a $300 credit on $1000 rent → charge stays whole, $300 stays on account, net owed $700', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 300)
    await generateInvoices(NOW)

    // The rent charge is untouched — one row, still $1,000, nothing split.
    expect(await pendingOwed(f.leaseA)).toBe(1000)
    const charges = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE lease_id=$1 AND is_remainder = TRUE`, [f.leaseA])
    expect(Number(charges.rows[0].n)).toBe(0)

    // The credit is still owed to the tenant, in full.
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(300)

    // And the number that matters — what they actually owe — is $700.
    expect(await pendingOwed(f.leaseA) - 300).toBe(700)
  })

  it('a $1000 credit on $1000 rent → owes $0; credit drawn to 0', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 1000)
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(0)
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(0)
  })

  it('a $1500 credit on $1000 rent → owes $0; $500 carries forward', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 1500)
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(0)
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(500)
  })

  it('a voided credit is NOT consumed', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, status)
       VALUES ($1,$2,$3,300,300,'goodwill','void')`, [f.landlordAId, f.tenantA, f.leaseA])
    await generateInvoices(NOW)
    expect(await pendingOwed(f.leaseA)).toBe(1000)
  })
})
