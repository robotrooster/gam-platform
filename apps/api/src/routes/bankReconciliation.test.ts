// S568: bank reconciliation — GAM disbursed figure, bank charges, difference.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { bankReconciliationRouter } from './bankReconciliation'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/bank-reconciliations', bankReconciliationRouter)
  app.use('/api/expenses', expensesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bankrec'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    // GAM sent them $2,000 in the period.
    await c.query(
      `INSERT INTO disbursements (landlord_id, user_id, amount, target_date, status)
       VALUES ($1, $2, 2000, '2026-08-15', 'settled')`, [landlordId, llUser])
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, unitId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('bank reconciliation', () => {
  it('context returns GAM disbursed + logged bank charges', async () => {
    const f = await seed()
    // Log a bank fee via /expenses (flows to P&L + shows in reconciliation).
    await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, category: 'bank_fees', amount: 25, expenseDate: '2026-08-20', description: 'Wire fee' }).expect(200)

    const res = await request(buildApp()).get('/api/bank-reconciliations/context?from=2026-08-01&to=2026-08-31')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.gamDisbursed).toBe(2000)
    expect(res.body.data.bankChargesTotal).toBe(25)
    expect(res.body.data.bankCharges).toHaveLength(1)
  })

  // S654 (Nic, DIRECTIVE): no default company. Each company has its own bank,
  // so a two-company account names the company on every read and write here —
  // and what it names is where the bank charge and the reconciliation land.
  it('S654: a two-company account reconciles the company it names', async () => {
    const c = await db.connect()
    let userId = '', llA = '', llB = ''
    try {
      await c.query('BEGIN')
      const a = await seedLandlord(c); userId = a.userId; llA = a.landlordId
      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])
      llB = b.rows[0].id
      await c.query(
        `INSERT INTO disbursements (landlord_id, user_id, amount, target_date, status)
         VALUES ($1, $3, 1000, '2026-08-15', 'settled'), ($2, $3, 3000, '2026-08-15', 'settled')`, [llA, llB, userId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const token = jwt.sign({ userId, role: 'landlord', email: 'two@t.dev', profileId: null, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const app = buildApp()

    // Naming nothing is asked, never defaulted.
    const ask = await request(app).get('/api/bank-reconciliations/context?from=2026-08-01&to=2026-08-31')
      .set('Authorization', `Bearer ${token}`)
    expect(ask.status).toBe(400)

    // The bank charge lands in the company named.
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`)
      .send({ landlordId: llB, category: 'bank_fees', amount: 15, expenseDate: '2026-08-20', description: 'Wire fee' })
      .expect(200)
    const ctxB = await request(app).get(`/api/bank-reconciliations/context?from=2026-08-01&to=2026-08-31&entityId=${llB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(ctxB.status).toBe(200)
    expect(ctxB.body.data.gamDisbursed).toBe(3000)
    expect(ctxB.body.data.bankChargesTotal).toBe(15)
    const ctxA = await request(app).get(`/api/bank-reconciliations/context?from=2026-08-01&to=2026-08-31&entityId=${llA}`)
      .set('Authorization', `Bearer ${token}`)
    expect(ctxA.body.data.gamDisbursed).toBe(1000)
    expect(ctxA.body.data.bankChargesTotal).toBe(0)

    const saved = await request(app).post('/api/bank-reconciliations').set('Authorization', `Bearer ${token}`)
      .send({ landlordId: llB, periodStart: '2026-08-01', periodEnd: '2026-08-31', statementBalance: 2985 })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(Number(saved.body.data.difference)).toBe(-15)
    const histB = await request(app).get(`/api/bank-reconciliations?entityId=${llB}`).set('Authorization', `Bearer ${token}`)
    expect(histB.body.data).toHaveLength(1)
    const histA = await request(app).get(`/api/bank-reconciliations?entityId=${llA}`).set('Authorization', `Bearer ${token}`)
    expect(histA.body.data).toHaveLength(0)
  })

  it('saving a reconciliation computes difference = statement − GAM disbursed', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/bank-reconciliations').set('Authorization', `Bearer ${f.token}`)
      .send({ periodStart: '2026-08-01', periodEnd: '2026-08-31', statementBalance: 1975 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.book_balance)).toBe(2000)
    expect(Number(res.body.data.difference)).toBe(-25)   // statement short by the $25 bank fee
    expect(res.body.data.status).toBe('completed')
    const list = await request(buildApp()).get('/api/bank-reconciliations').set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(1)
  })
})
