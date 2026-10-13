/**
 * GAM Books — the one Vendors list (10/12, Nic), which replaced the separate
 * Contractors (1099) list.
 *
 *   Nic, 10/12: "VENDORS = one list of everyone the company pays (contractors,
 *   garbage company, power company) with a type; contractors get a 1099 box
 *   and their payments add up per calendar year."
 *
 * Covered routes (routes/booksLoansAssets.ts, on booksRouter):
 *   - GET   /api/books/vendors
 *   - POST  /api/books/vendors
 *   - PATCH /api/books/vendors/:id
 * and the Contractors routes are gone (the old list is folded in, migration
 * 20261014190000).
 *
 * The S412 / S416 rules carry over: a vendor needs its name, a contact, an
 * email, a phone and an address; terms are one of the listed ones; account #
 * and notes are optional. 10/12: what kind of vendor it is is required; the
 * taxpayer ID is optional; only a contractor carries the 1099 box; a Social
 * Security number is kept as its last four digits only and never sent back.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_books_cv'
})

interface PortfolioFixture {
  landlordAId:    string
  landlordBId:    string
  landlordAToken: string
  landlordBToken: string
  adminToken:     string
}

async function seedPortfolio(): Promise<PortfolioFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(client)
    const { userId: bUid, landlordId: bId } = await seedLandlord(client)
    const admin = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAId: aId, landlordBId: bId,
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: null, landlordIds: [aId], permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: null, landlordIds: [bId], permissions: {} }),
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

const happyPayload = () => ({
  vendorType:   'supplier',
  name:         'Acme Plumbing Supply',
  contactName:  'Joe Acme',
  email:        'joe@acme.test',
  phone:        '5555550100',
  address:      '100 Main St, Anywhere AZ 85000',
  category:     'plumbing',
  paymentTerms: 'net30',
  taxId:        '12-3456789',
})

// ───────────────────────────────────────────────────────────────────
// THE CONTRACTORS LIST IS FOLDED IN
// ───────────────────────────────────────────────────────────────────

describe('the Contractors (1099) routes are gone — a contractor is a vendor', () => {
  it('GET / POST /contractors answer 404', async () => {
    const f = await seedPortfolio()
    const get = await request(buildApp()).get('/api/books/contractors').set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(get.status).toBe(404)
    const post = await request(buildApp()).post('/api/books/contractors').set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ firstName: 'J', lastName: 'D' })
    expect(post.status).toBe(404)
  })

  it('a contractor from the old list shows on the Vendors list as a contractor with the 1099 box', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, trade, ssn_last4, entity_type)
       VALUES ($1, 'Older', 'A', 'plumbing', '1234', 'individual')`, [f.landlordAId])
    const res = await request(buildApp()).get('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ name: 'Older A', vendor_type: 'contractor', is_1099: true, trade: 'plumbing',
      tax_classification: 'individual', tax_id_last4: '1234', has_tax_id: true })
    expect(res.body.data[0]).not.toHaveProperty('ssn_last4')
  })
})

// ───────────────────────────────────────────────────────────────────
// VENDORS
// ───────────────────────────────────────────────────────────────────

describe('GET /vendors', () => {
  it('landlord sees only their own active vendors (inactive ones on ?includeInactive=true), with the year\'s figures', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_vendors (landlord_id, name, status) VALUES
        ($1, 'A Active', 'active'),
        ($1, 'A Inactive', 'inactive'),
        ($2, 'B Active', 'active')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ name: 'A Active', vendor_type: 'other', paid_this_year: 0, owed: 0 })
    const all = await request(buildApp())
      .get('/api/books/vendors?includeInactive=true')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(all.body.data.map((v: any) => v.name)).toEqual(['A Active', 'A Inactive'])
  })

  it('ORDER BY name (alphabetical); ?type= one kind', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_vendors (landlord_id, name, vendor_type) VALUES
        ($1, 'Zebra Supply', 'supplier'),
        ($1, 'apex Hardware', 'supplier'),
        ($1, 'Midway Power', 'utility')`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.name)).toEqual(['apex Hardware', 'Midway Power', 'Zebra Supply'])
    const util = await request(buildApp()).get('/api/books/vendors?type=utility').set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(util.body.data.map((v: any) => v.name)).toEqual(['Midway Power'])
  })

  it('an admin with no company chosen reads an empty list, never every company\'s', async () => {
    const f = await seedPortfolio()
    await db.query(`INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'A1'), ($2, 'B1')`, [f.landlordAId, f.landlordBId])
    const res = await request(buildApp()).get('/api/books/vendors').set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })
})

describe('POST /vendors', () => {
  it('happy: creates vendor with all required fields; an EIN is shown by its last four only', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(happyPayload())
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: 'Acme Plumbing Supply', payment_terms: 'net30', status: 'active',
      landlord_id: f.landlordAId, vendor_type: 'supplier', is_1099: false, tax_id_last4: '6789', has_tax_id: true })
    expect(res.body.data).not.toHaveProperty('tax_id')
    expect((await db.query(`SELECT tax_id, ssn_last4 FROM books_vendors WHERE id = $1`, [res.body.data.id])).rows[0])
      .toEqual({ tax_id: '12-3456789', ssn_last4: null })
  })

  it('S416 fix: empty body → 400; what kind of vendor it is is required', async () => {
    const f = await seedPortfolio()
    const empty = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`).send({})
    expect(empty.status).toBe(400)
    const { vendorType, ...without } = happyPayload()
    void vendorType
    const res = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`).send(without)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/what kind of vendor/)
  })

  it('missing name → 400; missing phone → 400', async () => {
    const f = await seedPortfolio()
    const { name, ...noName } = happyPayload()
    const { phone, ...noPhone } = happyPayload()
    void name; void phone
    for (const body of [noName, noPhone]) {
      const res = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`).send(body)
      expect(res.status).toBe(400)
    }
  })

  // 10/11, 10/12: the taxpayer ID is optional — most vendors (utilities,
  // insurers, the county) never give one.
  it('missing taxId → 201, none on file', async () => {
    const f = await seedPortfolio()
    const { taxId, ...without } = happyPayload()
    void taxId
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ has_tax_id: false, tax_id_last4: null })
  })

  it('invalid email, terms or taxpayer ID → 400', async () => {
    const f = await seedPortfolio()
    for (const bad of [{ email: 'not-an-email' }, { paymentTerms: 'monthly' }, { taxId: 'NOT-A-TAXID' }, { vendorType: 'landlord' }]) {
      const res = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`)
        .send({ ...happyPayload(), ...bad })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
  })

  it('accountNumber + notes optional → 201', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), accountNumber: '', notes: '' })
    expect(res.status).toBe(201)
    expect(res.body.data.account_number).toBeNull()
    expect(res.body.data.notes).toBeNull()
  })

  it('a Social Security number (a sole proprietor) is kept as its last four digits only', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), vendorType: 'contractor', is1099: true, taxClassification: 'individual', taxId: '123-45-6789' })
    expect(res.status).toBe(201)
    expect(res.body.data.tax_id_last4).toBe('6789')
    expect((await db.query(`SELECT tax_id, ssn_last4 FROM books_vendors WHERE id = $1`, [res.body.data.id])).rows[0])
      .toEqual({ tax_id: null, ssn_last4: '6789' })
  })

  it('a contractor with the 1099 box, their W-9 box, trade and rate; only a contractor gets the 1099 box', async () => {
    const f = await seedPortfolio()
    const ok = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), vendorType: 'contractor', is1099: true, taxClassification: 'llc', w9OnFile: true,
        trade: 'Plumbing', payRate: 85, payUnit: 'hour' })
    expect(ok.status).toBe(201)
    expect(ok.body.data).toMatchObject({ vendor_type: 'contractor', is_1099: true, tax_classification: 'llc', w9_on_file: true,
      trade: 'Plumbing', pay_rate: 85, pay_unit: 'hour' })
    const refused = await request(buildApp()).post('/api/books/vendors').set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), vendorType: 'utility', is1099: true })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/Only a contractor gets the 1099 box/)
  })
})

describe('PATCH /vendors/:id', () => {
  it('cross-landlord modify blocked → 404, the row untouched', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'B Vendor') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
    const verify = await db.query<{ name: string }>(`SELECT name FROM books_vendors WHERE id=$1`, [ins.rows[0].id])
    expect(verify.rows[0].name).toBe('B Vendor')
  })

  it('happy: only what was sent changes; inactive keeps the vendor', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_vendors
         (landlord_id, name, contact_name, payment_terms, category)
       VALUES ($1, 'Acme', 'Joe', 'net30', 'plumbing') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ paymentTerms: 'net15', status: 'inactive' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ payment_terms: 'net15', name: 'Acme', contact_name: 'Joe', category: 'plumbing', status: 'inactive' })
  })

  it('a contractor that stops being one loses the 1099 box and its rate; a blank taxpayer ID box keeps the one on file', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name, vendor_type, is_1099, pay_rate, pay_unit, tax_id)
       VALUES ($1, 'Jose', 'contractor', TRUE, 25, 'hour', '12-3456789') RETURNING id`, [f.landlordAId])
    const res = await request(buildApp()).patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`).send({ vendorType: 'supplier', taxId: '' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ vendor_type: 'supplier', is_1099: false, pay_rate: null, pay_unit: null, tax_id_last4: '6789' })
    const back = await request(buildApp()).patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`).send({ is1099: true })
    expect(back.status).toBe(400)
  })
})
