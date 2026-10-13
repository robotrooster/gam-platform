// S568 → 10/12 (Nic, ledger P9): the landlord's own bank-reconciliation door,
// re-based on the ledger. It STARTS a statement (the assistant's
// record_bank_reconciliation) and lists the history; ticking and finishing are
// on the Bank Reconciliation page (routes/booksClose.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedProperty } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { bankReconciliationRouter } from './bankReconciliation'
import { errorHandler } from '../middleware/errorHandler'
import { drainLedgerOutbox } from '../services/ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { createLandlordExpense } from '../services/landlordExpenses'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/bank-reconciliations', bankReconciliationRouter)
  app.use(errorHandler)
  return app
}
const app = buildApp()

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bankrec'
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

const passFor = (userId: string, landlordIds: string[]) =>
  jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })

/** A company with one linked bank and $40 paid from it by hand on Sept 6. */
async function companyWithBank(co?: LedgerCompany): Promise<LedgerCompany & { connectionId: string }> {
  const c = co ?? await ledgerCompany()
  const connectionId = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
    [c.landlordId])).rows[0].id
  await createLandlordExpense({
    landlordId: c.landlordId, propertyId: c.propertyId, category: 'repairs', amount: 40, expenseDate: '2026-09-06',
    payment: { method: 'bank', bankConnectionId: connectionId },
  })
  expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
  return { ...c, connectionId }
}

describe('the landlord\'s bank reconciliation door, on the ledger', () => {
  it('starts a statement on the company\'s one linked bank at the figure printed on it, and lists it', async () => {
    const co = await companyWithBank()
    const auth = { Authorization: `Bearer ${passFor(co.ownerUserId, [co.landlordId])}` }
    // The old body still works: periodStart is accepted and not needed.
    const res = await request(app).post('/api/bank-reconciliations').set(auth)
      .send({ periodStart: '2026-09-01', periodEnd: '2026-09-30', statementBalance: -40 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.reconciliation).toMatchObject({ status: 'open', statementDate: '2026-09-30', statementBalance: -40 })
    expect(res.body.data.account).toMatchObject({ bankConnectionId: co.connectionId, linked: true })
    expect(res.body.data).toMatchObject({ difference: -40, canFinish: false })
    expect(res.body.data.lines.map((l: any) => l.amount)).toEqual([-40])

    const list = await request(app).get('/api/bank-reconciliations').set(auth)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ status: 'open', statementDate: '2026-09-30', accountName: expect.stringMatching(/Checking: Operating/) })

    // The statement's last day is required; a balance must be a number.
    expect((await request(app).post('/api/bank-reconciliations').set(auth).send({ statementBalance: 1 })).status).toBe(400)
    expect((await request(app).post('/api/bank-reconciliations').set(auth).send({ periodEnd: '2026-09-30', statementBalance: 'lots' })).status).toBe(400)
  })

  it('a company with no bank account on its books yet is told to link one; naming another company\'s account is refused', async () => {
    const co = await ledgerCompany()
    const auth = { Authorization: `Bearer ${passFor(co.ownerUserId, [co.landlordId])}` }
    const none = await request(app).post('/api/bank-reconciliations').set(auth).send({ periodEnd: '2026-09-30', statementBalance: 0 })
    expect(none.status).toBe(409)
    expect(none.body.error).toMatch(/Link the bank/)
    const other = await companyWithBank()
    const theirs = await request(app).post('/api/bank-reconciliations').set(auth)
      .send({ periodEnd: '2026-09-30', statementBalance: 0, accountId: other.connectionId })
    expect(theirs.status).toBe(404)
  })

  // S654 (Nic, DIRECTIVE): no default company. A two-company account names the
  // company on every read and write here.
  it('S654: a two-company account reconciles the company it names, never a default', async () => {
    const a = await companyWithBank()
    const b = (await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, books_start_date) VALUES ($1, DATE '2000-01-01', DATE '2026-01-01') RETURNING id`,
      [a.ownerUserId])).rows[0].id
    await db.query(`DELETE FROM ledger_outbox WHERE source_type = 'opening' AND source_id = $1`, [b])
    const propB = await inTx(c => seedProperty(c, { landlordId: b, ownerUserId: a.ownerUserId, managedByUserId: a.ownerUserId }))
    await companyWithBank({ ...a, landlordId: b, propertyId: propB, owner: { landlordId: b } })
    const auth = { Authorization: `Bearer ${passFor(a.ownerUserId, [a.landlordId, b])}` }

    const ask = await request(app).post('/api/bank-reconciliations').set(auth).send({ periodEnd: '2026-09-30', statementBalance: -40 })
    expect(ask.status).toBe(400)
    const inB = await request(app).post('/api/bank-reconciliations').set(auth)
      .send({ landlordId: b, periodEnd: '2026-09-30', statementBalance: -40 })
    expect(inB.status, JSON.stringify(inB.body)).toBe(200)
    expect((await request(app).get(`/api/bank-reconciliations?entityId=${b}`).set(auth)).body.data).toHaveLength(1)
    expect((await request(app).get(`/api/bank-reconciliations?entityId=${a.landlordId}`).set(auth)).body.data).toHaveLength(0)
    expect((await request(app).get(`/api/bank-reconciliations?entityId=${randomUUID()}`).set(auth)).status).toBe(403)
  })
})
