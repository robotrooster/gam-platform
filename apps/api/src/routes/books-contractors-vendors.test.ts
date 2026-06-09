/**
 * books.ts slice 2 — S384. Continues the books.ts test arc.
 *
 * Covered routes (6):
 *   - GET   /api/books/contractors
 *   - POST  /api/books/contractors
 *   - PATCH /api/books/contractors/:id
 *   - GET   /api/books/vendors
 *   - POST  /api/books/vendors
 *   - PATCH /api/books/vendors/:id
 *
 * After this slice: 14 of 40 books.ts routes covered (35%).
 *
 * Out of slice (S385-S387): payroll runs + bookkeeper invites,
 *   journal + transactions + bills, reports.
 *
 * Production findings flagged (NOT fixed):
 *   - POST /contractors has NO required-field validation. Body
 *     {} is accepted; row inserted with all-null first/last/
 *     business name. Data-quality bug; product call on what
 *     fields are minimally required (either firstName+lastName
 *     OR businessName). See "Items deferred" in S384 handoff.
 *   - GET /contractors does NOT filter by status (returns
 *     archived/inactive rows). GET /vendors DOES filter
 *     status='active'. Inconsistent. Same product call.
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
      landlordAToken: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: aId, permissions: {} }),
      landlordBToken: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: bId, permissions: {} }),
      adminToken:     sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// ───────────────────────────────────────────────────────────────────
// CONTRACTORS
// ───────────────────────────────────────────────────────────────────

describe('GET /contractors', () => {
  it('landlord sees only their own contractors (ordered created_at DESC)', async () => {
    const f = await seedPortfolio()
    // Seed two contractors for A and one for B; order by created_at DESC.
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, trade)
       VALUES ($1, 'Older', 'A', 'plumbing')`, [f.landlordAId])
    await new Promise(r => setTimeout(r, 5))
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, trade)
       VALUES ($1, 'Newer', 'A', 'electrical')`, [f.landlordAId])
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, trade)
       VALUES ($1, 'B', 'Contractor', 'roofing')`, [f.landlordBId])

    const res = await request(buildApp())
      .get('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].first_name).toBe('Newer')  // DESC by created_at
    expect(res.body.data[1].first_name).toBe('Older')
  })

  it('admin sees contractors across all landlords', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name) VALUES
        ($1, 'A1', 'X'),
        ($2, 'B1', 'Y')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/books/contractors')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /contractors', () => {
  // S412 (S384): all fields required; EIN/SSN conditional on entityType.
  it('happy individual: creates with all required fields + ssnLast4 (not ein)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'Jane', lastName: 'Doe',
        businessName: 'Jane Doe Plumbing',  // sole-prop dba name; still required
        email: 'jane@plumbing.test',
        phone: '5555550100',
        address: '123 Main St, Anywhere AZ 85000',
        entityType: 'individual',
        ssnLast4: '1234',
        trade: 'plumbing',
        payRate: 75.00, payUnit: 'hour',
        w9OnFile: true,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.first_name).toBe('Jane')
    expect(res.body.data.business_name).toBe('Jane Doe Plumbing')
    expect(res.body.data.entity_type).toBe('individual')
    expect(res.body.data.ssn_last4).toBe('1234')
    expect(res.body.data.ein).toBeNull()
    expect(res.body.data.pay_unit).toBe('hour')
    expect(res.body.data.w9_on_file).toBe(true)
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })

  it('happy business: creates with all required fields + ein (not ssnLast4)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'Jane', lastName: 'Doe',
        businessName: 'Acme Plumbing LLC',
        email: 'ops@acme-plumbing.test',
        phone: '5555550101',
        address: '456 Oak Ave, Anywhere AZ 85000',
        entityType: 'business',
        ein: '12-3456789',
        trade: 'plumbing',
        payRate: 100, payUnit: 'project',
        w9OnFile: true,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.ein).toBe('12-3456789')
    expect(res.body.data.ssn_last4).toBeNull()
    expect(res.body.data.entity_type).toBe('business')
  })

  it('S412 fix: empty body {} → 400 (was 201 pre-fix; created unidentifiable row)', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('missing firstName → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        lastName: 'Doe', businessName: 'X', email: 'x@x.test',
        phone: '5555550100', address: '1 St', entityType: 'individual',
        ssnLast4: '1234', trade: 't', payRate: 1, payUnit: 'hour',
        w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('invalid email format → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'X',
        email: 'not-an-email', phone: '5555550100', address: '1 St',
        entityType: 'individual', ssnLast4: '1234',
        trade: 't', payRate: 1, payUnit: 'hour', w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('payRate zero/negative → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'X', email: 'a@b.test',
        phone: '5555550100', address: '1 St', entityType: 'individual',
        ssnLast4: '1234', trade: 't', payRate: 0, payUnit: 'hour',
        w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('entityType=business without ein → 400 "ein required for entityType=business"', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'Acme LLC',
        email: 'a@b.test', phone: '5555550100', address: '1 St',
        entityType: 'business',  // ein omitted
        trade: 't', payRate: 1, payUnit: 'hour', w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('entityType=individual without ssnLast4 → 400 "ssnLast4 required for entityType=individual"', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'X', email: 'a@b.test',
        phone: '5555550100', address: '1 St', entityType: 'individual',
        // ssnLast4 omitted
        trade: 't', payRate: 1, payUnit: 'hour', w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('ein in wrong format → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'Acme LLC',
        email: 'a@b.test', phone: '5555550100', address: '1 St',
        entityType: 'business', ein: 'NOT-AN-EIN',
        trade: 't', payRate: 1, payUnit: 'hour', w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('ssnLast4 not 4 digits → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'X', email: 'a@b.test',
        phone: '5555550100', address: '1 St', entityType: 'individual',
        ssnLast4: 'abcd',  // not digits
        trade: 't', payRate: 1, payUnit: 'hour', w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })

  it('invalid payUnit → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/contractors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({
        firstName: 'J', lastName: 'D', businessName: 'X', email: 'a@b.test',
        phone: '5555550100', address: '1 St', entityType: 'individual',
        ssnLast4: '1234', trade: 't', payRate: 1, payUnit: 'monthly',
        w9OnFile: false,
      })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /contractors/:id', () => {
  it('cross-landlord modify blocked → 404', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name)
       VALUES ($1, 'B', 'Contractor') RETURNING id`, [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/contractors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ firstName: 'Hijacked' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('happy: COALESCE-update preserves untouched fields; w9_on_file accepts false explicitly', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_contractors
         (landlord_id, first_name, last_name, trade, pay_rate, w9_on_file)
       VALUES ($1, 'Jane', 'Doe', 'plumbing', 75, TRUE) RETURNING id`, [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/contractors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ trade: 'electrical', w9OnFile: false })
    expect(res.status).toBe(200)
    expect(res.body.data.trade).toBe('electrical')
    expect(res.body.data.w9_on_file).toBe(false)  // explicit false honored (?? operator)
    expect(res.body.data.first_name).toBe('Jane')  // preserved
    expect(Number(res.body.data.pay_rate)).toBe(75)  // preserved
  })
})

// ───────────────────────────────────────────────────────────────────
// VENDORS
// ───────────────────────────────────────────────────────────────────

describe('GET /vendors', () => {
  it('landlord sees only their own active vendors (excludes inactive)', async () => {
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
    expect(res.body.data[0].name).toBe('A Active')
  })

  it('ORDER BY name (alphabetical)', async () => {
    const f = await seedPortfolio()
    await db.query(
      `INSERT INTO books_vendors (landlord_id, name) VALUES
        ($1, 'Zebra Supply'),
        ($1, 'Apex Hardware'),
        ($1, 'Midway Materials')`,
      [f.landlordAId])
    const res = await request(buildApp())
      .get('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((v: any) => v.name)).toEqual([
      'Apex Hardware', 'Midway Materials', 'Zebra Supply',
    ])
  })
})

describe('POST /vendors', () => {
  // S416: strict zod validation. All fields required by default;
  // accountNumber and notes are the only two relaxations.
  const happyPayload = () => ({
    name:         'Acme Plumbing Supply',
    contactName:  'Joe Acme',
    email:        'joe@acme.test',
    phone:        '5555550100',
    address:      '100 Main St, Anywhere AZ 85000',
    category:     'plumbing',
    paymentTerms: 'net30',
    taxId:        '12-3456789',
  })

  it('happy: creates vendor with all required fields', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(happyPayload())
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Acme Plumbing Supply')
    expect(res.body.data.payment_terms).toBe('net30')
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.landlord_id).toBe(f.landlordAId)
  })

  it('S416 fix: empty body → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('missing name → 400', async () => {
    const f = await seedPortfolio()
    const { name, ...without } = happyPayload()
    void name
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('missing phone → 400', async () => {
    const f = await seedPortfolio()
    const { phone, ...without } = happyPayload()
    void phone
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('missing taxId → 400', async () => {
    const f = await seedPortfolio()
    const { taxId, ...without } = happyPayload()
    void taxId
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(without)
    expect(res.status).toBe(400)
  })

  it('invalid email format → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('invalid paymentTerms enum → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), paymentTerms: 'monthly' })
    expect(res.status).toBe(400)
  })

  it('taxId wrong format → 400', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), taxId: 'NOT-A-TAXID' })
    expect(res.status).toBe(400)
  })

  it('accountNumber + notes optional → 201', async () => {
    const f = await seedPortfolio()
    // Already exercised by the happy test (no accountNumber/notes sent);
    // this case explicitly pins the relaxation behavior.
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send(happyPayload())  // no accountNumber, no notes
    expect(res.status).toBe(201)
    expect(res.body.data.account_number).toBeNull()
    expect(res.body.data.notes).toBeNull()
  })

  it('SSN-format taxId (sole proprietor) → 201', async () => {
    const f = await seedPortfolio()
    const res = await request(buildApp())
      .post('/api/books/vendors')
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ ...happyPayload(), taxId: '123-45-6789' })
    expect(res.status).toBe(201)
  })
})

describe('PATCH /vendors/:id', () => {
  it('cross-landlord modify blocked → response not the row owned by the other landlord', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name) VALUES ($1, 'B Vendor') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ name: 'Hijacked' })
    // Note: unlike contractors, the vendors PATCH route does NOT throw
    // 404 when no row matches — it returns {success: true, data: undefined}.
    // Slight contract asymmetry vs contractors PATCH. Documented; not
    // a fix-it-right candidate since the row is correctly untouched.
    const verify = await db.query<{ name: string }>(
      `SELECT name FROM books_vendors WHERE id=$1`, [ins.rows[0].id])
    expect(verify.rows[0].name).toBe('B Vendor')  // not hijacked
    // Either status is acceptable here as long as data isn't modified.
    expect([200, 404]).toContain(res.status)
  })

  it('happy: COALESCE-update preserves untouched fields', async () => {
    const f = await seedPortfolio()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO books_vendors
         (landlord_id, name, contact_name, payment_terms, category)
       VALUES ($1, 'Acme', 'Joe', 'net30', 'plumbing') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/books/vendors/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.landlordAToken}`)
      .send({ paymentTerms: 'net15' })
    expect(res.status).toBe(200)
    expect(res.body.data.payment_terms).toBe('net15')
    expect(res.body.data.name).toBe('Acme')                  // preserved
    expect(res.body.data.contact_name).toBe('Joe')           // preserved
    expect(res.body.data.category).toBe('plumbing')          // preserved
  })
})
