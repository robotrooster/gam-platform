// S568: generic (standalone) e-sign — purchase agreements / contracts with
// arbitrary signers + roles, no lease binding. Verifies the additive path
// works and does not disturb the lease-document engine.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_standalone'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: sellerUser, landlordId } = await seedLandlord(c)
    const buyerTenant = await seedTenant(c)
    const buyerUser = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [buyerTenant])).rows[0].user_id
    await c.query('COMMIT')
    const token = jwt.sign({ userId: sellerUser, role: 'landlord', email: 'seller@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, sellerUser, buyerUser, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('POST /api/esign/standalone-documents', () => {
  const mk = (f: any, over: any = {}) => ({
    title: 'Home purchase agreement', documentType: 'purchase_agreement',
    signers: [
      { userId: f.sellerUser, role: 'seller', name: 'Sally Seller', email: 'seller@t.dev' },
      { userId: f.buyerUser, role: 'purchaser', name: 'Bob Buyer', email: 'buyer@t.dev' },
    ], ...over,
  })

  it('creates a non-lease document with seller + purchaser signers', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send(mk(f))
    expect(res.status).toBe(200)
    const docId = res.body.data.id
    const doc = await db.query<any>(`SELECT document_type, lease_id, unit_id FROM lease_documents WHERE id=$1`, [docId])
    expect(doc.rows[0].document_type).toBe('purchase_agreement')
    expect(doc.rows[0].lease_id).toBeNull()
    expect(doc.rows[0].unit_id).toBeNull()
    const signers = await db.query<any>(`SELECT role FROM lease_document_signers WHERE document_id=$1 ORDER BY role`, [docId])
    expect(signers.rows.map(r => r.role)).toEqual(['purchaser', 'seller'])
  })

  it('rejects a lease document type on the standalone endpoint → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send(mk(f, { documentType: 'original_lease' }))
    expect(res.status).toBe(400)
  })

  it('rejects duplicate signer roles → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send(mk(f, {
        signers: [
          { userId: f.sellerUser, role: 'party_1', name: 'A', email: 'a@t.dev' },
          { userId: f.buyerUser, role: 'party_1', name: 'B', email: 'b@t.dev' },
        ],
      }))
    expect(res.status).toBe(400)
  })

  it('mints a free contact account (customer pool) for a new-email signer', async () => {
    const f = await seed()
    const newEmail = `newbuyer-${Math.floor(performance.now())}@ext.dev`
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send({
        title: 'Contract', documentType: 'general_contract',
        signers: [
          { userId: f.sellerUser, role: 'party_1', name: 'Sam', email: 'seller@t.dev' },
          { role: 'party_2', name: 'New Person', email: newEmail },  // no userId
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.data.mintedContacts).toBe(1)
    const contact = await db.query<any>(`SELECT role, email_verified, tenant_invite_token FROM users WHERE LOWER(email)=$1`, [newEmail])
    expect(contact.rows).toHaveLength(1)
    expect(contact.rows[0].role).toBe('contact')       // customer pool
    expect(contact.rows[0].email_verified).toBe(false) // must activate (consent gate)
    expect(contact.rows[0].tenant_invite_token).toBeTruthy() // reuses the existing activate→sign flow
    // Re-sending to the SAME email reuses the account (no duplicate).
    const again = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send({
        title: 'Contract 2', documentType: 'general_contract',
        signers: [
          { userId: f.sellerUser, role: 'party_1', name: 'Sam', email: 'seller@t.dev' },
          { role: 'party_2', name: 'New Person', email: newEmail },
        ],
      })
    expect(again.body.data.mintedContacts).toBe(0)   // reused, not re-created
    const count = await db.query<any>(`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email)=$1`, [newEmail])
    expect(count.rows[0].n).toBe(1)
  })

  it('a minted contact activates as role=contact (not mis-issued a tenant identity)', async () => {
    const f = await seed()
    const email = `activator-${Math.floor(performance.now())}@ext.dev`
    await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send({
        title: 'Contract', documentType: 'general_contract',
        signers: [
          { userId: f.sellerUser, role: 'party_1', name: 'Sam', email: 'seller@t.dev' },
          { role: 'party_2', name: 'Ann Activator', email },
        ],
      }).expect(200)
    const { rows: [c] } = await db.query<any>(`SELECT tenant_invite_token FROM users WHERE LOWER(email)=$1`, [email])
    const act = await request(buildApp()).post('/api/tenants/accept-invite')
      .send({ token: c.tenant_invite_token, password: 'password1234', acceptedTerms: true })
    expect(act.status).toBe(200)
    expect(act.body.data.user.role).toBe('contact')       // NOT tenant
    // S578: mandatory email-2FA at activation — a pending session (the contact
    // trades the emailed code at /email-otp/verify before reaching /sign).
    expect(act.body.data.requiresEmailOtp).toBe(true)
    expect(act.body.data.emailOtpSession).toBeTruthy()
    const activated = await db.query<any>(`SELECT email_verified, role FROM users WHERE LOWER(email)=$1`, [email])
    expect(activated.rows[0].email_verified).toBe(true)
    expect(activated.rows[0].role).toBe('contact')
  })

  it('accepts a custom signer role label', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`).send(mk(f, {
        documentType: 'general_contract',
        signers: [
          { userId: f.sellerUser, role: 'contractor', name: 'C', email: 'c@t.dev' },
          { userId: f.buyerUser, role: 'client', name: 'D', email: 'd@t.dev' },
        ],
      }))
    expect(res.status).toBe(200)
  })
})

// S576 (B-8): completion path for no-lease document types. buildLeaseFromDocument
// has no switch case for standalone / work_trade_addendum types — calling it
// unconditionally on full-signing dumped a legally-signed doc into
// execution_failed and skipped the PDF stamp. These MUST complete cleanly.
describe('POST /api/esign/sign — no-lease document completion', () => {
  const signerToken = (userId: string) =>
    jwt.sign({ userId, role: 'contact', email: `${userId}@t.dev`, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

  // Insert a doc of an arbitrary document_type directly (work_trade_addendum has
  // no create endpoint yet — its send wiring is the follow-up this fix unblocks).
  async function insertDoc(landlordId: string, documentType: string,
    signers: Array<{ userId: string; role: string; email: string; order: number }>) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const doc = (await c.query<any>(
        `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
         VALUES ($1, NULL, NULL, $2, $3, 'in_progress') RETURNING id`,
        [landlordId, `${documentType} doc`, documentType])).rows[0]
      for (const s of signers) {
        await c.query(
          `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'sent')`,
          [doc.id, s.userId, s.role, s.role, s.email, s.order, `tok-${s.userId}-${s.order}`])
      }
      await c.query('COMMIT')
      return doc.id as string
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  async function signAll(app: any, docId: string,
    signers: Array<{ userId: string }>) {
    let last: any
    for (const s of signers) {
      last = await request(app).post(`/api/esign/sign/${docId}`)
        .set('Authorization', `Bearer ${signerToken(s.userId)}`).send({ fieldValues: [] })
    }
    return last
  }

  it('a fully-signed general_contract ends completed (not execution_failed)', async () => {
    const f = await seed()
    const app = buildApp()
    const signers = [
      { userId: f.sellerUser, role: 'party_1', email: 'seller@t.dev', order: 1 },
      { userId: f.buyerUser,  role: 'party_2', email: 'buyer@t.dev',  order: 2 },
    ]
    const docId = await insertDoc(f.landlordId, 'general_contract', signers)

    const res = await signAll(app, docId, signers)
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()
    // No lease is materialized for a standalone contract.
    expect(res.body.data.leaseId).toBeUndefined()

    const doc = await db.query<any>(`SELECT status, lease_id, completed_at FROM lease_documents WHERE id=$1`, [docId])
    expect(doc.rows[0].status).toBe('completed')
    expect(doc.rows[0].status).not.toBe('execution_failed')
    expect(doc.rows[0].lease_id).toBeNull()
    expect(doc.rows[0].completed_at).not.toBeNull()
  })

  it('a fully-signed work_trade_addendum ends completed (not execution_failed)', async () => {
    const f = await seed()
    const app = buildApp()
    const signers = [
      { userId: f.sellerUser, role: 'party_1', email: 'seller@t.dev', order: 1 },
      { userId: f.buyerUser,  role: 'party_2', email: 'buyer@t.dev',  order: 2 },
    ]
    const docId = await insertDoc(f.landlordId, 'work_trade_addendum', signers)

    const res = await signAll(app, docId, signers)
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(res.body.data.executionFailed).toBeUndefined()

    const doc = await db.query<any>(`SELECT status FROM lease_documents WHERE id=$1`, [docId])
    expect(doc.rows[0].status).toBe('completed')
  })
})
