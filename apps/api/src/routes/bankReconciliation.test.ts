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
