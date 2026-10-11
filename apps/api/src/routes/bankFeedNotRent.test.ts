/**
 * "Not a rent payment" on the owner's bank review (POST /bank-feed/deposits/:id/not-rent).
 *
 * It used to touch only updated_at, so the deposit came straight back on the
 * match list with the same tenants offered — and the transfer note
 * (decisions #48.1, #52) sends the owner to exactly this button for their own
 * TRANSFER. Now pressing it:
 *   - takes the deposit off the rent-matching list for good;
 *   - leaves it waiting on the Bank feed ('needs_review'), still fileable;
 *   - keeps GAM's automatic steps off it (a tenant's report the bank confirms,
 *     a tenant's whole bill to the cent) — the owner said it is not rent;
 *   - can be undone with one button, back exactly as it was.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { bankFeedRouter } from './bankFeed'
import { errorHandler } from '../middleware/errorHandler'
import { reconcileDeposits } from '../services/bankFeed'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const SECRET = 'test_jwt_secret_not_rent'
function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/bank-feed', bankFeedRouter)
  a.use(errorHandler)
  return a
}

interface Park {
  landlordId: string; userId: string; token: string; connectionId: string; propertyId: string
  tenantId: string; leaseId: string; rentId: string
}

/** One lot owing $450 rent, the owner signed in. */
async function park(): Promise<Park> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const connectionId = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
      [landlordId])).rows[0].id
    const tenantId = await seedTenant(client)
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 450 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const rentId = (await client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',450,'pending',CURRENT_DATE,'RENT') RETURNING id`,
      [unitId, leaseId, tenantId, landlordId])).rows[0].id
    process.env.JWT_SECRET = SECRET
    const token = jwt.sign({ userId, role: 'landlord', email: 'owner@t.dev', profileId: landlordId,
      landlordIds: [landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    return { landlordId, userId, token, connectionId, propertyId, tenantId, leaseId, rentId }
  } finally { client.release() }
}

async function deposit(p: Park, description: string, amount = 450): Promise<string> {
  return (await db.query(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,'needs_review') RETURNING id`,
    [p.connectionId, p.landlordId, randomUUID(), amount.toFixed(2), description])).rows[0].id
}

/** The tenant reported paying this in at the branch: with the bank row, two signals that settle by themselves. */
async function tenantReported(p: Park, amount = 450) {
  await db.query(
    `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,'cash')`, [p.tenantId, p.leaseId, p.landlordId, amount.toFixed(2)])
}

const as = (p: Park) => ({ Authorization: `Bearer ${p.token}` })
const unmatchedIds = async (p: Park): Promise<string[]> => {
  const res = await request(app()).get('/api/bank-feed/deposits/unmatched').set(as(p))
  expect(res.status).toBe(200)
  return res.body.data.deposits.map((d: any) => d.transactionId ?? d.transaction_id)
}
const notRent = (p: Park, id: string) => request(app()).post(`/api/bank-feed/deposits/${id}/not-rent`).set(as(p)).send({})
const undo = (p: Park, id: string) => request(app()).post(`/api/bank-feed/deposits/${id}/not-rent/undo`).set(as(p)).send({})
const txn = async (id: string) => (await db.query(
  `SELECT status, matched_payment_id, auto_settle_undo FROM bank_transactions WHERE id=$1`, [id])).rows[0]
const rentStatus = async (p: Park) => (await db.query(`SELECT status FROM payments WHERE id=$1`, [p.rentId])).rows[0].status

beforeEach(cleanupAllSchema)

describe('Not a rent payment', () => {
  it('takes the deposit off the rent-matching list, and it stays off when the list is read again', async () => {
    const p = await park()
    const id = await deposit(p, 'ONLINE TRANSFER FROM CHK 1234')
    expect(await unmatchedIds(p)).toEqual([id])

    const res = await notRent(p, id)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id, amount: 450, setAside: true })
    expect(await unmatchedIds(p)).toEqual([])
    expect(await unmatchedIds(p)).toEqual([])
  })

  it('leaves the deposit waiting on the Bank feed, where the owner can still file it', async () => {
    const p = await park()
    const id = await deposit(p, 'ONLINE TRANSFER FROM CHK 1234')
    await notRent(p, id)
    expect((await txn(id)).status).toBe('needs_review')
    const feed = await request(app()).get('/api/bank-feed/transactions?status=needs_review').set(as(p))
    expect(feed.status).toBe(200)
    expect(JSON.stringify(feed.body.data)).toContain(id)

    const filed = await request(app()).post(`/api/bank-feed/transactions/${id}/categorize`).set(as(p))
      .send({ category: 'owner_contribution', scopeKind: 'property_common', propertyId: p.propertyId })
    expect(filed.status).toBe(200)
    expect((await txn(id)).status).toBe('categorized')
  })

  it('GAM never settles it by itself afterwards, even with a tenant’s matching report the bank would confirm', async () => {
    const p = await park()
    await tenantReported(p)
    const id = await deposit(p, 'ATM CASH DEPOSIT')
    await notRent(p, id)
    const r = await reconcileDeposits(p.landlordId)
    expect(r.declared + r.autoSettled + r.autoFiled + r.inferred + r.slips).toBe(0)
    expect(await txn(id)).toMatchObject({ status: 'needs_review', matched_payment_id: null })
    expect(await rentStatus(p)).toBe('pending')
  })

  it('Undo puts it back exactly as it was: on the list, and open to the automatic steps again', async () => {
    const p = await park()
    await tenantReported(p)
    const id = await deposit(p, 'ATM CASH DEPOSIT')
    await notRent(p, id)
    const back = await undo(p, id)
    expect(back.status).toBe(200)
    expect((await txn(id)).auto_settle_undo).toBeNull()
    expect(await unmatchedIds(p)).toEqual([id])
    // Nothing of the owner's "no" is left: the tenant's report and the bank row settle it.
    await reconcileDeposits(p.landlordId)
    expect((await txn(id)).status).toBe('matched')
    expect(await rentStatus(p)).toBe('settled')
  })

  it('keeps the record of a match a person undid earlier, through the mark and its Undo', async () => {
    const p = await park()
    await tenantReported(p)
    const id = await deposit(p, 'ATM CASH DEPOSIT')
    const undone = { version: 1, undone: true, undoneAt: '2026-10-03T10:00:00.000Z', undoneBy: p.userId, was: { receiptId: 'r1' } }
    await db.query(`UPDATE bank_transactions SET auto_settle_undo = $2::jsonb WHERE id=$1`, [id, JSON.stringify(undone)])

    await notRent(p, id)
    expect((await txn(id)).auto_settle_undo).toMatchObject(undone)
    await undo(p, id)
    expect((await txn(id)).auto_settle_undo).toEqual(undone)
    // The earlier "no" still stands: GAM does not settle it by itself.
    await reconcileDeposits(p.landlordId)
    expect(await rentStatus(p)).toBe('pending')
  })

  it('pressed twice is harmless: the first mark stands', async () => {
    const p = await park()
    const id = await deposit(p, 'DEPOSIT')
    await notRent(p, id)
    const first = (await txn(id)).auto_settle_undo
    expect((await notRent(p, id)).status).toBe(200)
    expect((await txn(id)).auto_settle_undo).toEqual(first)
  })

  it('a deposit matched or filed meanwhile is refused in plain words, and nothing changes', async () => {
    const p = await park()
    const id = await deposit(p, 'DEPOSIT')
    await db.query(`UPDATE bank_transactions SET status='ignored', ignored_reason='landlord' WHERE id=$1`, [id])
    const res = await notRent(p, id)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That deposit is no longer waiting to be matched: it was matched, filed or ignored meanwhile.')
    expect((await txn(id)).auto_settle_undo).toBeNull()
  })

  it('Undo after the owner filed it on the Bank feed is refused in plain words', async () => {
    const p = await park()
    const id = await deposit(p, 'ONLINE TRANSFER FROM CHK 1234')
    await notRent(p, id)
    await db.query(`UPDATE bank_transactions SET status='ignored', ignored_reason='landlord' WHERE id=$1`, [id])
    const res = await undo(p, id)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That deposit was already filed or ignored on the Bank feed, so it cannot come back to this list.')
  })

  it('Undo pressed again after another tab already undid it says it is back on the list, never that it was filed', async () => {
    const p = await park()
    const id = await deposit(p, 'ATM CASH DEPOSIT')
    await notRent(p, id)
    const first = await undo(p, id)
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ id, alreadyBack: false })
    const second = await undo(p, id)
    expect(second.status).toBe(200)
    expect(second.body.data).toEqual({ id, alreadyBack: true })
    expect(await txn(id)).toMatchObject({ status: 'needs_review', auto_settle_undo: null })
    expect(await unmatchedIds(p)).toEqual([id])
  })

  it('Undo after the deposit was matched on the Bank feed meanwhile says it was matched', async () => {
    const p = await park()
    const id = await deposit(p, 'ATM CASH DEPOSIT')
    await notRent(p, id)
    await db.query(`UPDATE bank_transactions SET status='matched' WHERE id=$1`, [id])
    const res = await undo(p, id)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('That deposit was matched on the Bank feed meanwhile, so it cannot come back to this list.')
  })

  it('the deposits set aside and still waiting on the Bank feed are listed with the queue, so the owner can still Undo after a reload', async () => {
    const p = await park()
    const id = await deposit(p, 'ONLINE TRANSFER FROM CHK 1234')
    await notRent(p, id)
    const res = await request(app()).get('/api/bank-feed/deposits/unmatched').set(as(p))
    expect(res.status).toBe(200)
    expect(res.body.data.deposits).toEqual([])
    expect(res.body.data.setAside).toHaveLength(1)
    expect(res.body.data.setAside[0]).toMatchObject({ transactionId: id, amount: 450, description: 'ONLINE TRANSFER FROM CHK 1234' })
    expect(res.body.data.setAside[0].postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(res.body.data.setAside[0].setAt).toBeTruthy()
    expect(res.body.data.setAsideRemaining).toBe(0)
    // Undo from that list: it is back in the queue and no longer set aside.
    expect((await undo(p, id)).status).toBe(200)
    const after = await request(app()).get('/api/bank-feed/deposits/unmatched').set(as(p))
    expect(after.body.data.setAside).toEqual([])
    expect(after.body.data.deposits.map((d: any) => d.transactionId)).toEqual([id])
  })

  it('a set-aside deposit the owner filed on the Bank feed leaves the set-aside list (there is nothing left to undo)', async () => {
    const p = await park()
    const id = await deposit(p, 'ONLINE TRANSFER FROM CHK 1234')
    await notRent(p, id)
    await db.query(`UPDATE bank_transactions SET status='ignored', ignored_reason='landlord' WHERE id=$1`, [id])
    const res = await request(app()).get('/api/bank-feed/deposits/unmatched').set(as(p))
    expect(res.body.data.setAside).toEqual([])
  })

  it('another company’s set-aside deposits are never listed', async () => {
    const p = await park()
    const q = await park()
    const id = await deposit(q, 'DEPOSIT')
    await db.query(
      `UPDATE bank_transactions SET auto_settle_undo = jsonb_build_object('notRent', jsonb_build_object('at', now())) WHERE id=$1`, [id])
    const res = await request(app()).get('/api/bank-feed/deposits/unmatched').set(as(p))
    expect(res.body.data.setAside).toEqual([])
  })

  it('another company’s deposit is not found', async () => {
    const p = await park()
    const q = await park()
    const id = await deposit(q, 'DEPOSIT')
    expect((await notRent(p, id)).status).toBe(404)
    expect((await txn(id)).auto_settle_undo).toBeNull()
  })
})
