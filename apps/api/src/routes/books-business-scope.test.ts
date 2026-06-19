/**
 * books.ts — S459 business-owner scope.
 *
 * GAM Books is reused by business customers (apps/business). Owner-scoped
 * tables now carry landlord_id XOR business_id (migration 20260619120000).
 * These tests prove a business_owner:
 *   - reaches the engine and gets business_id-scoped rows,
 *   - is isolated from landlord books (both directions),
 *   - can run the owner-generic P&L report,
 *   - is blocked from the landlord-only surfaces (rent-roll / owner-
 *     statements / tax-summary).
 *
 * The existing books-*.test.ts suites are the landlord regression net —
 * the ${col} conversion is byte-identical for landlords (col='landlord_id').
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { booksRouter } from './books'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/books', booksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_business'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function seedBusinessOwner(): Promise<{ userId: string; businessId: string; token: string }> {
  const email = `bizowner-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Acme Hauling', 'trash_hauling', $2) RETURNING id`, [u.id, email])
  return {
    userId: u.id, businessId: b.id,
    token: sign({ userId: u.id, role: 'business_owner', email,
                  profileId: b.id, businessId: b.id, permissions: {} }),
  }
}

describe('books.ts — business_owner scope (S459)', () => {
  it('business_owner can create + list a chart-of-accounts account (business_id-scoped)', async () => {
    const o = await seedBusinessOwner()
    const create = await request(buildApp())
      .post('/api/books/accounts').set('Authorization', `Bearer ${o.token}`)
      .send({ code: '4010', name: 'Service Revenue', type: 'income' })
    expect(create.status).toBe(201)
    expect(create.body.data.business_id).toBe(o.businessId)
    expect(create.body.data.landlord_id).toBeNull()

    const list = await request(buildApp())
      .get('/api/books/accounts').set('Authorization', `Bearer ${o.token}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((a: any) => a.code)).toContain('4010')
  })

  it('business books are isolated from landlord books (both directions)', async () => {
    const o = await seedBusinessOwner()
    // Landlord with their own account.
    const client = await db.connect()
    let landlordId = '', landlordUserId = ''
    try {
      await client.query('BEGIN')
      const seeded = await seedLandlord(client)
      landlordId = seeded.landlordId; landlordUserId = seeded.userId
      await client.query('COMMIT')
    } finally { client.release() }
    const landlordToken = sign({ userId: landlordUserId, role: 'landlord',
      email: 'll@t.dev', profileId: landlordId, permissions: {} })

    await request(buildApp()).post('/api/books/accounts')
      .set('Authorization', `Bearer ${landlordToken}`)
      .send({ code: '5040', name: 'Repairs', type: 'expense' })
    await request(buildApp()).post('/api/books/accounts')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ code: '6010', name: 'Fuel', type: 'expense' })

    const bizList = await request(buildApp()).get('/api/books/accounts')
      .set('Authorization', `Bearer ${o.token}`)
    const bizCodes = bizList.body.data.map((a: any) => a.code)
    expect(bizCodes).toContain('6010')
    expect(bizCodes).not.toContain('5040') // landlord's account hidden

    const llList = await request(buildApp()).get('/api/books/accounts')
      .set('Authorization', `Bearer ${landlordToken}`)
    const llCodes = llList.body.data.map((a: any) => a.code)
    expect(llCodes).toContain('5040')
    expect(llCodes).not.toContain('6010') // business's account hidden
  })

  it('business_owner can record an expense transaction and run the P&L report', async () => {
    const o = await seedBusinessOwner()
    const tx = await request(buildApp()).post('/api/books/transactions')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ date: '2026-06-01', description: 'Dump fees', amount: 120, type: 'expense' })
    expect(tx.status).toBe(201)
    expect(tx.body.data.business_id).toBe(o.businessId)

    const pl = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2026-01-01&endDate=2026-12-31')
      .set('Authorization', `Bearer ${o.token}`)
    expect(pl.status).toBe(200)
    // No landlord rent ever leaks into a business P&L.
    expect(pl.body.data.gamRentIncome).toBe(0)
  })

  it('P&L auto-includes real revenue: completed POS sales + collected invoices', async () => {
    const o = await seedBusinessOwner()
    // Completed POS sale ($200).
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, total_amount, payment_method)
       VALUES ($1, 'R-1', 'completed', 200, 'cash')`, [o.businessId])
    // A customer + a fully-paid invoice ($300).
    const { rows: [c] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name, street1, city, state, zip)
       VALUES ($1, 'individual', 'Pat', 'Doe', '1 St', 'Phoenix', 'AZ', '85001') RETURNING id`,
      [o.businessId])
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          total_amount, amount_paid, sent_at, paid_at)
       VALUES ($1, $2, 'INV-1', 'paid', CURRENT_DATE, CURRENT_DATE, 300, 300, now(), now())`,
      [o.businessId, c.id])

    const pl = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2020-01-01&endDate=2099-12-31')
      .set('Authorization', `Bearer ${o.token}`)
    expect(pl.status).toBe(200)
    expect(pl.body.data.gamBusinessRevenue).toBe(500) // 200 POS + 300 collected
    // A draft (uncollected) invoice must NOT count.
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          total_amount, amount_paid)
       VALUES ($1, $2, 'INV-2', 'draft', CURRENT_DATE, CURRENT_DATE, 999, 0)`,
      [o.businessId, c.id])
    const pl2 = await request(buildApp())
      .get('/api/books/reports/pl?startDate=2020-01-01&endDate=2099-12-31')
      .set('Authorization', `Bearer ${o.token}`)
    expect(pl2.body.data.gamBusinessRevenue).toBe(500) // unchanged
  })

  it('landlord P&L carries no business revenue', async () => {
    const client = await db.connect()
    let landlordId = '', landlordUserId = ''
    try {
      await client.query('BEGIN')
      const s = await seedLandlord(client)
      landlordId = s.landlordId; landlordUserId = s.userId
      await client.query('COMMIT')
    } finally { client.release() }
    const token = sign({ userId: landlordUserId, role: 'landlord',
      email: 'll@t.dev', profileId: landlordId, permissions: {} })
    const pl = await request(buildApp()).get('/api/books/reports/pl')
      .set('Authorization', `Bearer ${token}`)
    expect(pl.status).toBe(200)
    expect(pl.body.data.gamBusinessRevenue).toBe(0)
  })

  it('business_owner can edit and delete a transaction; another owner cannot', async () => {
    const o = await seedBusinessOwner()
    const create = await request(buildApp()).post('/api/books/transactions')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ date: '2026-06-01', description: 'Dump fee', amount: 100, type: 'expense' })
    const txId = create.body.data.id

    // Edit.
    const edit = await request(buildApp()).patch(`/api/books/transactions/${txId}`)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ description: 'Landfill fee', amount: 125 })
    expect(edit.status).toBe(200)
    expect(edit.body.data.description).toBe('Landfill fee')
    expect(+edit.body.data.amount).toBe(125)

    // A different business owner cannot edit or delete it (404, scoped out).
    const other = await seedBusinessOwner()
    const foreignEdit = await request(buildApp()).patch(`/api/books/transactions/${txId}`)
      .set('Authorization', `Bearer ${other.token}`).send({ amount: 9 })
    expect(foreignEdit.status).toBe(404)
    const foreignDel = await request(buildApp()).delete(`/api/books/transactions/${txId}`)
      .set('Authorization', `Bearer ${other.token}`)
    expect(foreignDel.status).toBe(404)

    // Owner deletes it.
    const del = await request(buildApp()).delete(`/api/books/transactions/${txId}`)
      .set('Authorization', `Bearer ${o.token}`)
    expect(del.status).toBe(200)
    const list = await request(buildApp()).get('/api/books/transactions')
      .set('Authorization', `Bearer ${o.token}`)
    expect(list.body.data.find((t: any) => t.id === txId)).toBeUndefined()
  })

  it('business_owner is blocked from landlord-only surfaces', async () => {
    const o = await seedBusinessOwner()
    for (const path of ['/api/books/rent-roll',
                        '/api/books/reports/owner-statements',
                        '/api/books/tax/summary']) {
      const res = await request(buildApp()).get(path)
        .set('Authorization', `Bearer ${o.token}`)
      expect(res.status).toBe(403)
    }
  })
})
