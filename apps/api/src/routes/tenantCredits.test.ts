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
import { holdCredit, runWholeBillCheckAfterCommit, createPaidAhead } from '../services/creditUse'
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

  // Review fix (10/17): since 10/15 the credit goes on the balance the moment
  // it is issued, so a void finds nothing left. It must not read as if the
  // credit had been undone — a wrong amount comes back by billing it again.
  it('voiding a credit the balance already took says so, and does not claim it was taken back', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 500 })
    expect(issue.body.data.appliedToBalance).toBe(500)
    const v = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/void`).set(auth(f.tokenA))
    expect(v.status).toBe(200)
    expect(v.body.data.alreadyUsed).toBe(500)
    // 10/18: and it points at the thing that DOES take it back.
    expect(v.body.data.message).toBe(
      'Voided, but there was nothing left to take back. $500.00 of it had already gone on their open balance, '
      + 'and that stays paid. To take that back as well, undo the credit instead of voiding it.')
    // The $500 stays on the rent row: a void takes back only what is left.
    expect((await db.query<{ a: string }>(
      `SELECT SUM(amount)::text AS a FROM credit_uses WHERE payment_id = $1 AND status = 'applied'`, [rent])).rows[0].a)
      .toBe('500.00')
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

  // 10/15 (Nic): "Somebody can't go put $1,000 credit and not pay a $2,000
  // existing bill." A credit smaller than the bill goes on that bill now; the
  // rent row stays open for the rest and nothing is left on the account.
  it('a smaller credit goes on the open bill, the rest left owed, nothing left on the account', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 300 })
    expect(issue.status).toBe(201)
    expect(issue.body.data.paidBill).toBeNull()
    expect(issue.body.data.appliedToBalance).toBe(300)
    expect(issue.body.data.creditOnAccount).toBe(0)
    expect(issue.body.data.creditAvailable).toBe(0)
    expect(issue.body.data.message).toMatch(/\$300\.00 of the credit went on their open balance, oldest bill first/)
    const row = await db.query<{ status: string; issued: string }>(
      `SELECT status, issued_credit_amount::text AS issued FROM payments WHERE id = $1`, [rent])
    // The row is never cut in two: it stays open for the $700 money still owes.
    expect(row.rows[0].status).toBe('pending')
    expect(Number(row.rows[0].issued)).toBe(300)
    expect((await db.query<{ a: string }>(
      `SELECT SUM(amount)::text AS a FROM credit_uses WHERE payment_id = $1 AND status = 'applied'`, [rent])).rows[0].a)
      .toBe('300.00')
  })

  // The box tells the landlord what is owed BEFORE he gives anything away.
  it('the box says what is still owed, and says so plainly when nothing is', async () => {
    const f = await seed()
    await rentRow(f, 1000)
    const owed = await request(app).get(`/api/tenant-credits/owed?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    expect(owed.status).toBe(200)
    expect(owed.body.data.spaceOwed).toBe(1000)
    expect(owed.body.data.householdOwed).toBe(1000)
    expect(owed.body.data.message).toMatch(/still owes \$1000\.00\. A credit goes on that balance, oldest bill first/)
    // 10/18: and the way back from a wrong amount — undo it, inside the window.
    expect(owed.body.data.message).toMatch(
      /Only what is over the whole balance stays on their account\. Typed the wrong amount\? You can undo the credit for 30 days — what it paid goes back to owed\./)
    // Paid off, the same box says there is nothing for a credit to pay.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE lease_id = $1`, [f.leaseA])
    const clear = await request(app).get(`/api/tenant-credits/owed?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    expect(clear.body.data.spaceOwed).toBe(0)
    expect(clear.body.data.message).toMatch(/owes nothing right now, so the credit waits on their account/)
  })

  it('the box is only for a lease the caller manages', async () => {
    const f = await seed()
    const other = await request(app).get(`/api/tenant-credits/owed?leaseId=${f.leaseA}`).set(auth(f.tokenB))
    expect(other.status).toBe(403)
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

  /**
   * 10/18 (Nic) — UNDOING A CREDIT TYPED BY MISTAKE.
   *
   *   "We need to undo credit, but no undoing payments that were actually real
   *    money handed over ... refunds of real money are only at the property
   *    setting by that individual landlord."
   *
   * Since 10/15 a credit lands on the balance the moment it is issued, so a
   * void takes back only the leftover — usually nothing. The undo takes the
   * WHOLE credit back: every bill it settled is owed again, the credit is gone
   * from the account, and who did it and when stay on it.
   */
  it('a credit that paid the whole bill is undone: the bill is owed again, the credit is gone, and who did it is kept', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA))
      .send({ leaseId: f.leaseA, amount: 1000 })
    expect(issue.body.data.paidBill).toEqual({ charges: 1, creditUsed: 1000 })

    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(200)
    expect(undo.body.data.takenBackFromBills).toBe(1000)
    expect(undo.body.data.billsOwedAgain).toHaveLength(1)
    expect(undo.body.data.billsOwedAgain[0]).toMatchObject({ amount: 1000, backToOwed: true })
    // Plain words a person can find on the bill — never a row id.
    expect(undo.body.data.billsOwedAgain[0].what).toMatch(/^April Rent — /)
    expect(undo.body.data.message).toMatch(/^The \$1000\.00 credit is undone\. \$1000\.00 it had paid is owed again \(April Rent/)
    expect(undo.body.data.message).toMatch(/late from their own due dates again, as if the credit had never been given/)

    // The bill is owed again, whole, with no credit on it.
    const row = (await db.query<{ status: string; issued: string; settled_at: Date | null; notes: string | null }>(
      `SELECT status, issued_credit_amount::text AS issued, settled_at, notes FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.status).toBe('pending')
    expect(Number(row.issued)).toBe(0)
    expect(row.settled_at).toBeNull()
    expect(row.notes).toMatch(/Credit undone \d{4}-\d{2}-\d{2} — owed again/)
    // The credit is gone, with the whole amount recorded back on it, and the
    // spend is kept forever as a released record (never deleted).
    const credit = (await db.query<{ status: string; r: string; undone_at: Date | null; undone_by: string | null }>(
      `SELECT status, amount_remaining::text AS r, undone_at, undone_by FROM tenant_credits WHERE id = $1`,
      [issue.body.data.id])).rows[0]
    expect(credit.status).toBe('void')
    expect(Number(credit.r)).toBe(1000)
    expect(credit.undone_at).not.toBeNull()
    expect(credit.undone_by).toBe(f.userAId)
    expect((await db.query<{ status: string; release_reason: string }>(
      `SELECT status, release_reason FROM credit_uses WHERE tenant_credit_id = $1`, [issue.body.data.id])).rows)
      .toEqual([{ status: 'released', release_reason: 'credit_undone' }])
    // And it can never be undone (or used) twice.
    const again = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already voided or undone/)
  })

  // A credit that paid only PART of a bill: that part is owed again, and the
  // bill never changed status, so nothing is said about late fees.
  it('a credit that paid part of a bill: the part is owed again and the bill stays as it was', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 300 })
    expect(issue.body.data.appliedToBalance).toBe(300)

    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(200)
    expect(undo.body.data.takenBackFromBills).toBe(300)
    expect(undo.body.data.billsOwedAgain[0]).toMatchObject({ amount: 300, backToOwed: false })
    expect(undo.body.data.message).not.toMatch(/late from their own due dates/)
    const row = (await db.query<{ status: string; issued: string }>(
      `SELECT status, issued_credit_amount::text AS issued FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.status).toBe('pending')
    expect(Number(row.issued)).toBe(0)
  })

  // A credit that never paid anything (they owed nothing) is simply gone.
  it('a credit that paid nothing is undone with nothing to put back', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 75 })
    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(200)
    expect(undo.body.data.takenBackFromBills).toBe(0)
    expect(undo.body.data.message).toMatch(/It had not paid anything, so no bill changed\./)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [issue.body.data.id])).rows[0].status).toBe('void')
  })

  // THE LINE NIC DREW: real money is never undone. The refusal names the bill,
  // and nothing moves — not the credit, not the bill.
  it('refused, naming the bill, once real money is on one of the bills the credit paid', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 400 })
    // The rest was paid at the desk, so this bill now carries $600 of real money.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash' WHERE id = $1`, [rent])

    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/^April Rent — .* has \$600\.00 of real money on it\./)
    expect(undo.body.error).toMatch(/Nothing was undone — the credit stands as it is\./)
    expect(undo.body.error).toMatch(/only given back as a refund, which is the landlord's own to make/)
    // Nothing moved.
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [issue.body.data.id])).rows[0].status).toBe('active')
    const row = (await db.query<{ status: string; issued: string }>(
      `SELECT status, issued_credit_amount::text AS issued FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.status).toBe('settled')
    expect(Number(row.issued)).toBe(400)
  })

  // Nic named this one: money the tenant HANDED OVER. A bill the credit and
  // their own paid-ahead money both paid is never undone.
  it('refused when the bill was also paid with money the tenant paid ahead', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const money = await getClient()
    let paidAheadId: string
    try {
      await money.query('BEGIN')
      paidAheadId = await createPaidAhead(money, {
        leaseId: f.leaseA, tenantId: f.tenantA, amount: 600, fundedBy: 'landlord', receivedAt: '2026-04-15T12:00:00Z',
      })
      await money.query('COMMIT')
    } catch (e) { await money.query('ROLLBACK'); throw e } finally { money.release() }
    // The $400 credit and their $600 together cover the bill, so it settles.
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 400 })
    expect(issue.body.data.paidBill).toEqual({ charges: 1, creditUsed: 1000 })

    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/^April Rent — .* was paid with money the tenant paid ahead\./)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [issue.body.data.id])).rows[0].status).toBe('active')
    expect((await db.query('SELECT status FROM payments WHERE id=$1', [rent])).rows[0].status).toBe('settled')
    expect(Number((await db.query<{ r: string }>(
      `SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [paidAheadId!])).rows[0].r)).toBe(0)
  })

  // The standing rule still holds after an undo: credit never sits on an
  // account while they owe, so credit still on file goes on the reopened bill.
  it('credit still on the account goes on the bill the undo reopened', async () => {
    const f = await seed()
    const rent = await rentRow(f, 1000)
    const first = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 1000 })
    expect(first.body.data.paidBill).toEqual({ charges: 1, creditUsed: 1000 })
    // A second credit was given afterwards and had nothing to pay.
    const second = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 250 })
    expect(second.body.data.appliedToBalance).toBe(0)

    const undo = await request(app).post(`/api/tenant-credits/${first.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(200)
    expect(undo.body.data.message).toMatch(/Credit still on their account went on the open balance \(\$250\.00\)\./)
    // The bill is owed again less that $250 — never cut in two, still open.
    const row = (await db.query<{ status: string; issued: string }>(
      `SELECT status, issued_credit_amount::text AS issued FROM payments WHERE id = $1`, [rent])).rows[0]
    expect(row.status).toBe('pending')
    expect(Number(row.issued)).toBe(250)
  })

  it('refused while a payment still going through has part of the credit set aside', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 50 })
    const creditId = issue.body.data.id
    const rent = await rentRow(f, 1000, { status: 'processing', intent: 'pi_clearing_undo' })
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,950,950,0,'processing','ach','pi_clearing_undo',0) RETURNING id`,
      [f.tenantA, f.leaseA, f.landlordAId])).rows[0].id
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId, paymentId: rent, leaseId: f.leaseA, amount: 50, billingMonth: '2026-05-01' }],
        { remittanceId: rem, source: 'portal' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const undo = await request(app).post(`/api/tenant-credits/${creditId}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/\$50\.00 of this credit is set aside for a payment that is still going through/)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [creditId])).rows[0].status).toBe('active')
  })

  // The window (services/creditUse CREDIT_UNDO_WINDOW_DAYS): past a month the
  // bills' late fees and the tenant's payment history have moved on, so the way
  // back is to bill the money again.
  it('a credit older than the window cannot be undone, and the answer says what to do instead', async () => {
    const f = await seed()
    await rentRow(f, 1000)
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 100 })
    await db.query(`UPDATE tenant_credits SET created_at = now() - interval '31 days' WHERE id = $1`, [issue.body.data.id])
    const undo = await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/more than 30 days old, so it can no longer be undone/)
    expect(undo.body.error).toMatch(/Bill the money again instead, so the tenant sees the charge\./)
    // 10/18 review fix: the Undo button a list offers and the action itself read
    // the ONE expression, so they agree at the boundary to the second. They used
    // to disagree by up to a day — the list compared an interval, the action
    // counted whole elapsed days — so a credit 30 days and 12 hours old showed
    // no button and was undone anyway.
    const canUndo = async () => (await request(app)
      .get(`/api/tenant-credits?tenantId=${f.tenantA}`).set(auth(f.tokenA))).body.data
      .find((c: any) => c.id === issue.body.data.id)?.can_undo
    const age = (iv: string) =>
      db.query(`UPDATE tenant_credits SET created_at = now() - interval '${iv}' WHERE id = $1`, [issue.body.data.id])
    for (const iv of ['31 days', '30 days 12 hours', '30 days']) {
      await age(iv)
      expect(await canUndo()).toBe(false)
      expect((await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))).status).toBe(409)
    }
    // Inside the window: the button is there and the undo works.
    await age('29 days 23 hours')
    expect(await canUndo()).toBe(true)
    expect((await request(app).post(`/api/tenant-credits/${issue.body.data.id}/undo`).set(auth(f.tokenA))).status).toBe(200)
  })

  // 10/18 review fix: GAM writes credits of its own on this table — the one
  // that cancels a late fee the bank shows was never owed, the one that refunds
  // late fees the tenant really paid. None is the landlord's to take back, and
  // undoing the fee-cancelling one put back a fee the system had already
  // decided was never owed (and then broke that bank deposit's own Undo).
  it('a credit GAM wrote itself is not offered an Undo and cannot be undone', async () => {
    const f = await seed()
    const id = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1,$2,$3,25,25,'late_fee_refund','Late fees refunded — the bank shows rent was paid on October 3')
       RETURNING id`, [f.landlordAId, f.tenantA, f.leaseA])).rows[0].id
    const list = await request(app).get(`/api/tenant-credits?tenantId=${f.tenantA}`).set(auth(f.tokenA))
    expect(list.body.data.find((c: any) => c.id === id).can_undo).toBe(false)
    const undo = await request(app).post(`/api/tenant-credits/${id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/GAM wrote this credit itself/)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [id])).rows[0].status).toBe('active')
  })

  it('interest on the tenant\'s deposit cannot be undone either', async () => {
    const f = await seed()
    const id = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,12.50,12.50,'deposit_interest') RETURNING id`, [f.landlordAId, f.tenantA, f.leaseA])).rows[0].id
    const undo = await request(app).post(`/api/tenant-credits/${id}/undo`).set(auth(f.tokenA))
    expect(undo.status).toBe(409)
    expect(undo.body.error).toMatch(/owed by law/)
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [id])).rows[0].status).toBe('active')
  })

  // Who may: the same authority as issuing. Never another company, never the
  // tenant, never a bookkeeper (she does not act on a tenant's account).
  it('only the company that gave the credit can undo it — not another landlord, the tenant or a bookkeeper', async () => {
    const f = await seed()
    const issue = await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 100 })
    const id = issue.body.data.id
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const tenantToken = sign({ userId: f.tenantA, role: 'tenant', email: 't@t.dev', profileId: f.tenantA, permissions: {} })
    const bookkeeperToken = sign({ userId: f.userAId, role: 'bookkeeper', email: 'bk@t.dev', landlordId: f.landlordAId, permissions: {} })
    for (const token of [f.tokenB, tenantToken, bookkeeperToken]) {
      const res = await request(app).post(`/api/tenant-credits/${id}/undo`).set(auth(token))
      expect(res.status).toBe(403)
    }
    expect((await db.query('SELECT status FROM tenant_credits WHERE id=$1', [id])).rows[0].status).toBe('active')
  })

  // The list says where Undo is offered, so the button is never shown on a
  // credit it cannot touch.
  it('the list says which credits can still be undone', async () => {
    const f = await seed()
    const fresh = (await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 10 })).body.data.id
    const old = (await request(app).post('/api/tenant-credits').set(auth(f.tokenA)).send({ leaseId: f.leaseA, amount: 20 })).body.data.id
    await db.query(`UPDATE tenant_credits SET created_at = now() - interval '45 days' WHERE id = $1`, [old])
    const interest = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,5,5,'deposit_interest') RETURNING id`, [f.landlordAId, f.tenantA, f.leaseA])).rows[0].id
    const list = await request(app).get(`/api/tenant-credits?leaseId=${f.leaseA}`).set(auth(f.tokenA))
    const undoable = new Map(list.body.data.map((c: any) => [c.id, c.can_undo]))
    expect(undoable.get(fresh)).toBe(true)
    expect(undoable.get(old)).toBe(false)
    expect(undoable.get(interest)).toBe(false)
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
  // it now comes from netting a whole $1,000 charge against the $300 credit
  // recorded on it, not from rewriting the rent row.
  //
  // 10/15 (Nic): the credit no longer waits on the account for the tenant to
  // choose — "money gets applied to the most outstanding balance first" — so
  // the bill run puts it on the rent and the credit reads $0. The S637 rule it
  // still keeps: the ROW is whole. No $300 slice, no remainder row.
  it('S637: a $300 credit on $1000 rent → charge stays whole, the $300 goes on it, net owed $700', async () => {
    const f = await seed()
    await issueCredit(f.leaseA, f.tenantA, f.landlordAId, 300)
    await generateInvoices(NOW)

    // The rent charge is untouched — one row, still $1,000, nothing split.
    expect(await pendingOwed(f.leaseA)).toBe(1000)
    const charges = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE lease_id=$1 AND is_remainder = TRUE`, [f.leaseA])
    expect(Number(charges.rows[0].n)).toBe(0)

    // The credit went on the balance: none of it is left sitting.
    const { rows } = await db.query('SELECT amount_remaining FROM tenant_credits WHERE lease_id=$1', [f.leaseA])
    expect(Number(rows[0].amount_remaining)).toBe(0)
    const on = await db.query<{ a: string }>(
      `SELECT COALESCE(SUM(u.amount),0)::text AS a FROM credit_uses u
        WHERE u.lease_id = $1 AND u.status = 'applied'`, [f.leaseA])
    expect(on.rows[0].a).toBe('300.00')

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
