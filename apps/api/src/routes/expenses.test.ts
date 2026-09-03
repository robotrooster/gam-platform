// S568: landlord-entered expenses — unit-linked / common, per-unit allocation,
// totals, void.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { landlordExpensesTotal, unitAllocatedExpenses } from '../services/landlordExpenses'
import { expensesRouter } from './expenses'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/expenses', expensesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_expenses'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitA = await seedUnit(c, { propertyId, landlordId })
    const unitB = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, unitA, unitB, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const mk = (over: any) => ({ category: 'repairs', amount: 100, expenseDate: '2026-08-10', ...over })

describe('landlord expenses', () => {
  // S637 (Nic, whose account owns Oak Park Motel and RV LLC AND Mountain View
  // RV Park Ranch LLC): GET /expenses answered "You own more than one company.
  // Choose which one this record belongs to." — on a LIST. The tab could not be
  // opened at all by the only kind of account S633 exists to support, because
  // the WRITE resolver was scoping the read.
  //
  // Reads span; writes name. Both halves are asserted here.
  it('S637: an account owning TWO entities lists expenses from both', async () => {
    const c = await db.connect()
    let userId = '', llA = '', llB = ''
    try {
      await c.query('BEGIN')
      const a = await seedLandlord(c); userId = a.userId; llA = a.landlordId
      const propA = await seedProperty(c, { landlordId: llA, ownerUserId: userId, managedByUserId: userId })
      await seedUnit(c, { propertyId: propA, landlordId: llA })
      const b = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])
      llB = b.rows[0].id
      const propB = await seedProperty(c, { landlordId: llB, ownerUserId: userId, managedByUserId: userId })
      await seedUnit(c, { propertyId: propB, landlordId: llB })
      await c.query(
        `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description, status)
         VALUES ($1,$2,'repairs',100,'2026-08-10','Company A roof','active'),
                ($3,$4,'repairs',200,'2026-08-11','Company B fence','active')`,
        [llA, propA, llB, propB])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    // profileId null — what auth.ts mints for a landlord since S633.
    const token = jwt.sign({ userId, role: 'landlord', email: 'two@t.dev', profileId: null, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const all = await request(buildApp()).get('/api/expenses').set('Authorization', `Bearer ${token}`)
    expect(all.status).toBe(200)
    expect((all.body.data as any[]).map(e => e.description).sort())
      .toEqual(['Company A roof', 'Company B fence'])

    // ?entityId= still narrows — and still authorises through the same resolver.
    const justB = await request(buildApp()).get(`/api/expenses?entityId=${llB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(justB.status).toBe(200)
    expect((justB.body.data as any[]).map(e => e.description)).toEqual(['Company B fence'])

    // An entity the account does NOT own is still refused.
    const foreign = await request(buildApp()).get(`/api/expenses?entityId=${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
    expect(foreign.status).toBe(403)

    // The WRITE half is unchanged: two companies, no target named → asked which.
    const write = await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${token}`)
      .send(mk({ category: 'repairs', amount: 50, description: 'Ambiguous' }))
    expect(write.status).toBe(400)
    expect(String(write.body.error)).toMatch(/more than one company/i)
  })

  it('creates a unit-linked expense', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ unitId: f.unitA, category: 'maintenance', amount: 250, description: 'Water heater' }))
    expect(res.status).toBe(200)
    expect(res.body.data.unit_id).toBe(f.unitA)
    expect(res.body.data.is_common).toBe(false)
  })

  it('receipt-files: only the owning landlord fetches a receipt; another landlord 403 (S587)', async () => {
    const f = await seed()
    const created = await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ unitId: f.unitA, category: 'repairs', amount: 100, description: 'Parts' })).expect(200)
    const att = await request(buildApp())
      .post(`/api/expenses/${created.body.data.id}/receipt`).set('Authorization', `Bearer ${f.token}`)
      .attach('receipt', Buffer.from('invoice-bytes'), { filename: 'inv.pdf', contentType: 'application/pdf' })
    expect(att.status).toBe(200)
    const url: string = att.body.data.receipt_url
    expect(url).toMatch(/\/api\/expenses\/receipt-files\//)

    // Owning landlord → 200 (the file exists on disk).
    await request(buildApp()).get(url).set('Authorization', `Bearer ${f.token}`).expect(200)

    // A different landlord → 403 (not their receipt).
    const other = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'o@t.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    await request(buildApp()).get(url).set('Authorization', `Bearer ${other}`).expect(403)
  })

  it('creates a common expense allocated per unit; unit share = amount / unit count', async () => {
    const f = await seed()   // property has 2 units
    await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ propertyId: f.propertyId, category: 'insurance', amount: 600, isCommon: true, allocatePerUnit: true }))
      .expect(200)
    // Also a unit-linked expense on unit A.
    await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ unitId: f.unitA, category: 'repairs', amount: 100 })).expect(200)

    // Unit A: 100 direct + 600/2 allocated = 400. Unit B: just 300 allocated.
    expect(await unitAllocatedExpenses(f.unitA, '2026-08-01', '2026-08-31')).toBe(400)
    expect(await unitAllocatedExpenses(f.unitB, '2026-08-01', '2026-08-31')).toBe(300)
    // Landlord total = 600 + 100 = 700.
    expect(await landlordExpensesTotal(f.landlordId, '2026-08-01', '2026-08-31')).toBe(700)
  })

  // S603 (Nic): allocation is now UNCONDITIONAL. Any expense not tied to one
  // unit spreads across all units on the property, whether or not the landlord
  // ticked allocate_per_unit. Leaving a cost unspread made per-unit operating
  // cost read lower than reality — the very number an owner uses to judge
  // whether a unit earns its keep. The flag no longer affects reporting.
  it('common expense spreads per-unit even when allocatePerUnit is false', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ propertyId: f.propertyId, category: 'landscaping', amount: 200, isCommon: true, allocatePerUnit: false }))
      .expect(200)
    // 2 units on the property → $200 / 2 = $100 each, not $0.
    expect(await unitAllocatedExpenses(f.unitA, '2026-08-01', '2026-08-31')).toBe(100)
    expect(await unitAllocatedExpenses(f.unitB, '2026-08-01', '2026-08-31')).toBe(100)
    expect(await landlordExpensesTotal(f.landlordId, '2026-08-01', '2026-08-31')).toBe(200)
  })

  it('void removes it from totals', async () => {
    const f = await seed()
    const created = await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ unitId: f.unitA, amount: 150 }))
    await request(buildApp()).post(`/api/expenses/${created.body.data.id}/void`).set('Authorization', `Bearer ${f.token}`).send({}).expect(200)
    expect(await landlordExpensesTotal(f.landlordId, '2026-08-01', '2026-08-31')).toBe(0)
  })

  it('rejects an invalid category → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/expenses').set('Authorization', `Bearer ${f.token}`)
      .send(mk({ unitId: f.unitA, category: 'bribes' }))
    expect(res.status).toBe(400)
  })
})
