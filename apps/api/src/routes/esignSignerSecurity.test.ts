/**
 * S654 — e-sign could hand one landlord another landlord's password link.
 *
 * Round-6 reproduction: landlord A invited X (never set up; A's live link sits on
 * X's account). Landlord B
 *   1. called POST /esign/witnesses/provision with X's address in capitals and
 *      got X's user id back (it returned the id of ANY account, any role);
 *   2. called POST /esign/documents with signers [B as landlord,
 *      { userId: X, role: 'primary', email: 'attacker@evil.test' }] — nothing
 *      checked the email was X's or that X had anything to do with B;
 *   3. signed. The relay asked tenantLeaseLink for X's link, which reused A's
 *      live token, and mailed it to attacker@evil.test.
 *
 * THE RULE these tests hold every door to: a password link only for an account
 * that still needs setting up and belongs to no other company, mailed only to
 * the address on the account, never returned to the caller. A landlord or
 * staff login is never treated as a resident. Everyone else is reached at
 * their own address with the plain signing link.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  emailSigningRequestMock, emailSigningReminderMock, emailSigningCompletedMock, createNotificationMock,
} = vi.hoisted(() => ({
  emailSigningRequestMock:   vi.fn(async (..._a: any[]) => 'msg'),
  emailSigningReminderMock:  vi.fn(async (..._a: any[]) => 'msg'),
  emailSigningCompletedMock: vi.fn(async (..._a: any[]) => 'msg'),
  createNotificationMock:    vi.fn(async (..._a: any[]) => ({ id: 'n_mock' })),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emailSigningRequest:   emailSigningRequestMock,
    emailSigningReminder:  emailSigningReminderMock,
    emailSigningCompleted: emailSigningCompletedMock,
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createNotification: createNotificationMock }
})
vi.mock('../services/adminNotifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createAdminNotification: vi.fn(async () => {}) }
})
vi.mock('../services/pdfStamp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, stampPdf: vi.fn(async () => {}) }
})

import { esignRouter } from './esign'
import { NOT_A_RESIDENT_ACCOUNT } from '../jobs/leaseParser/resolveIntent'
import { errorHandler } from '../middleware/errorHandler'

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'
const ATTACKER = 'attacker@evil.test'
const A_LIVE_LINK = 'a-live-link'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  emailSigningReminderMock.mockClear()
  emailSigningCompletedMock.mockClear()
  createNotificationMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_signer_security'
})

const tokenFor = (userId: string, landlordId: string, email: string) => jwt.sign(
  { userId, role: 'landlord', email, profileId: landlordId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

/** A resident who never set up their account, invited by `landlordId`. */
async function invitee(landlordId: string, propertyId: string, email: string, liveToken: string | null) {
  const c = await db.connect()
  let tenantId: string
  try { tenantId = await seedTenant(c, { email }) } finally { c.release() }
  const userId = (await db.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
  await db.query(
    `UPDATE users SET password_hash=$2, tenant_invite_token=$3, email_verified=FALSE,
            tenant_invite_expires_at = NOW() + INTERVAL '7 days', tenant_invite_accepted_at=NULL
      WHERE id=$1`, [userId, PLACEHOLDER, liveToken])
  await db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id)
     VALUES ($1, $2, 'not_uploaded', $3)`, [landlordId, tenantId, propertyId])
  return { userId: userId as string, tenantId, email }
}

async function seedWorld() {
  const c = await db.connect()
  let a: any, b: any
  try {
    await c.query('BEGIN')
    const la = await seedLandlord(c, { email: `landlord-a-${randomUUID().slice(0, 6)}@test.dev` })
    const pa = await seedProperty(c, { landlordId: la.landlordId, ownerUserId: la.userId, managedByUserId: la.userId })
    const ua = await seedUnit(c, { propertyId: pa, landlordId: la.landlordId })
    const lb = await seedLandlord(c, { email: `landlord-b-${randomUUID().slice(0, 6)}@test.dev` })
    const pb = await seedProperty(c, { landlordId: lb.landlordId, ownerUserId: lb.userId, managedByUserId: lb.userId })
    const ub = await seedUnit(c, { propertyId: pb, landlordId: lb.landlordId })
    await c.query('COMMIT')
    a = { ...la, propertyId: pa, unitId: ua }
    b = { ...lb, propertyId: pb, unitId: ub }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  a.email = (await db.query(`SELECT email FROM users WHERE id=$1`, [a.userId])).rows[0].email
  b.email = (await db.query(`SELECT email FROM users WHERE id=$1`, [b.userId])).rows[0].email
  a.token = tokenFor(a.userId, a.landlordId, a.email)
  b.token = tokenFor(b.userId, b.landlordId, b.email)
  // X: landlord A's invitee, never set up, holding A's live link.
  const x = await invitee(a.landlordId, a.propertyId, `x-${randomUUID().slice(0, 6)}@resident.test`, A_LIVE_LINK)
  // Y: landlord B's own invitee, never set up.
  const y = await invitee(b.landlordId, b.propertyId, `y-${randomUUID().slice(0, 6)}@resident.test`, null)
  return { a, b, x, y }
}

const userRow = async (id: string) =>
  (await db.query(`SELECT email, password_hash, tenant_invite_token, tenant_invite_expires_at,
                          tenant_invite_accepted_at FROM users WHERE id=$1`, [id])).rows[0]

const sentTo = (mock: any) => mock.mock.calls.map((c: any[]) => String(c[0]).toLowerCase())

/** A document of `landlordId` listing `userId` with whatever address its row
 *  holds — the shape any document made before this fix can still have. */
async function legacyDoc(landlord: { landlordId: string; userId: string; email: string; unitId: string },
                         userId: string, rowEmail: string) {
  const doc = (await db.query(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1, $2, 'Lease', 'original_lease', 'sent') RETURNING id`,
    [landlord.landlordId, landlord.unitId])).rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1, $2, 'landlord', 'Landlord', $3, 1, $4, 'sent')`,
    [doc, landlord.userId, landlord.email, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1, $2, 'primary', 'Resident', $3, 2, $4, 'pending')`,
    [doc, userId, rowEmail, crypto.randomBytes(32).toString('hex')])
  return doc as string
}

// ─────────────────────────────────────────────────────────────────────────────
// The exact round-6 attack, step by step.
// ─────────────────────────────────────────────────────────────────────────────

describe('S654 — landlord B cannot reach landlord A\'s invitee through e-sign', () => {
  it('the exact attack: provision by address in capitals, list as primary with B\'s address, sign', async () => {
    const w = await seedWorld()
    const xBefore = await userRow(w.x.userId)

    // 1. The witness lookup no longer hands B the account.
    const prov = await request(buildApp()).post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ email: w.x.email.toUpperCase(), firstName: 'Ex' })
    expect(prov.status).toBe(409)
    expect(prov.body.data).toBeUndefined()
    expect(JSON.stringify(prov.body)).not.toContain(w.x.userId)

    // 2. Even holding X's id, B cannot put X on B's lease.
    const doc = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 2 },
        ],
      })
    expect(doc.status).toBe(409)
    expect(doc.body.error).toMatch(/no lease, invite or draft lease with this company/)
    const xSeats = await db.query(`SELECT 1 FROM lease_document_signers WHERE user_id=$1`, [w.x.userId])
    expect(xSeats.rows).toHaveLength(0)

    // 3. Nothing went anywhere, and X's account is exactly as A left it.
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
    const xAfter = await userRow(w.x.userId)
    expect(xAfter).toEqual(xBefore)
  })

  it('a document that already lists X under B\'s address: B signs, and only X\'s own address hears', async () => {
    const w = await seedWorld()
    const xBefore = await userRow(w.x.userId)
    const docId = await legacyDoc(w.b, w.x.userId, ATTACKER)

    const res = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${w.b.token}`).send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.nextSigner).toBe(w.x.email)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite|a-live-link/)

    // One email, to X's own address. Whatever link it carries is the one A
    // already sent X — B's signature minted nothing and extended nothing.
    expect(sentTo(emailSigningRequestMock)).toEqual([w.x.email.toLowerCase()])
    expect(JSON.stringify(emailSigningRequestMock.mock.calls)).not.toContain(ATTACKER)
    expect(await userRow(w.x.userId)).toEqual(xBefore)
  })

  it('the Remind button on such a document mails only X\'s own address, and changes nothing on X', async () => {
    const w = await seedWorld()
    const xBefore = await userRow(w.x.userId)
    const docId = await legacyDoc(w.b, w.x.userId, ATTACKER)
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role='landlord'`, [docId])
    await db.query(`UPDATE lease_document_signers SET status='sent' WHERE document_id=$1 AND role='primary'`, [docId])
    await db.query(`UPDATE lease_documents SET status='in_progress' WHERE id=$1`, [docId])

    const res = await request(buildApp()).post(`/api/esign/documents/${docId}/remind`)
      .set('Authorization', `Bearer ${w.b.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.sentTo).toBe(w.x.email)
    expect(sentTo(emailSigningReminderMock)).toEqual([w.x.email.toLowerCase()])
    expect(JSON.stringify(emailSigningReminderMock.mock.calls)).not.toContain(ATTACKER)
    expect(await userRow(w.x.userId)).toEqual(xBefore)
  })

  it('once A\'s link has run out, B\'s signature mints nothing: X gets the plain signing link', async () => {
    const w = await seedWorld()
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [w.x.userId])
    const xBefore = await userRow(w.x.userId)
    const docId = await legacyDoc(w.b, w.x.userId, ATTACKER)
    const res = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${w.b.token}`).send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(sentTo(emailSigningRequestMock)).toEqual([w.x.email.toLowerCase()])
    const call = emailSigningRequestMock.mock.calls[0] as any[]
    expect(call[5]).not.toContain('accept-invite')
    expect(call[6].needsSetup).toBe(false)
    expect(await userRow(w.x.userId)).toEqual(xBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Variations.
// ─────────────────────────────────────────────────────────────────────────────

describe('S654 — witness role', () => {
  it('B cannot list A\'s invitee as a witness either', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'witness',  userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 3 },
        ],
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Ex has no lease, invite or draft lease with this company/)
  })

  it('provisioning a landlord login as a witness is refused, in any letter case, with no id', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ email: w.a.email.toUpperCase(), firstName: 'Ay' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/landlord or staff login/)
    expect(res.body.data).toBeUndefined()
  })

  it('a landlord login cannot be put in as a witness by id', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'witness',  userId: w.a.userId, name: 'Ay', email: ATTACKER, orderIndex: 3 },
        ],
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/landlord or staff login/)
  })

  it('B\'s own invitee, in mixed case, is reused as a witness — the id and nothing else', async () => {
    const w = await seedWorld()
    const before = await userRow(w.y.userId)
    const mixed = w.y.email.replace(/^y/, 'Y').replace('@resident', '@Resident')
    const res = await request(buildApp()).post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ email: mixed, firstName: 'Why' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ userId: w.y.userId, reused: true })
    expect(await userRow(w.y.userId)).toEqual(before)
  })

  it('a witness login A set up (no tenant profile) can witness for B, reached at its own address', async () => {
    const w = await seedWorld()
    const first = await request(buildApp()).post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${w.a.token}`)
      .send({ email: 'notary@witness.test', firstName: 'Nora', lastName: 'Notary' })
    expect(first.status).toBe(201)
    const again = await request(buildApp()).post('/api/esign/witnesses/provision')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ email: 'NOTARY@witness.test', firstName: 'Nora' })
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual({ userId: first.body.data.userId, reused: true })

    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'witness',  userId: again.body.data.userId, name: 'Nora', email: ATTACKER, orderIndex: 3 },
        ],
      })
    expect(res.status).toBe(201)
    const row = (await db.query(
      `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='witness'`, [res.body.data.id])).rows[0]
    expect(row.email).toBe('notary@witness.test')
  })
})

describe('S654 — a landlord or staff login is never a resident', () => {
  it('a landlord login as the primary tenant is refused (409 NOT_A_RESIDENT_ACCOUNT)', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.a.userId, name: 'Ay', email: ATTACKER, orderIndex: 2 },
        ],
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(NOT_A_RESIDENT_ACCOUNT)
  })

  it('a resident\'s login cannot sign for the landlord', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
        ],
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/resident's account can't sign for the landlord/)
  })
})

describe('S654 — a company\'s own resident: the body\'s address is ignored', () => {
  it('B\'s invitee listed with another address is stored, and mailed, at their own', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Lease', unitId: w.b.unitId,
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: ATTACKER, orderIndex: 2 },
        ],
      })
    expect(res.status).toBe(201)
    const docId = res.body.data.id
    const row = (await db.query(
      `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='primary'`, [docId])).rows[0]
    expect(row.email).toBe(w.y.email)

    // B signs: Y, who never set up and belongs only to B, gets the one
    // set-up-and-sign link — at Y's own address.
    await db.query(`UPDATE lease_documents SET status='sent' WHERE id=$1`, [docId])
    const signed = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${w.b.token}`).send({ fieldValues: [] })
    expect(signed.status).toBe(200)
    expect(sentTo(emailSigningRequestMock)).toEqual([w.y.email.toLowerCase()])
    const call = emailSigningRequestMock.mock.calls[0] as any[]
    expect(call[5]).toContain('/accept-invite?token=')
    expect(call[6].needsSetup).toBe(true)
  })

  it('A\'s own document for X still carries A\'s live link, to X\'s own address', async () => {
    const w = await seedWorld()
    const docId = await legacyDoc(w.a, w.x.userId, w.x.email.toUpperCase())
    const res = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${w.a.token}`).send({ fieldValues: [] })
    expect(res.status).toBe(200)
    expect(sentTo(emailSigningRequestMock)).toEqual([w.x.email.toLowerCase()])
    const call = emailSigningRequestMock.mock.calls[0] as any[]
    expect(call[5]).toContain(`/accept-invite?token=${A_LIVE_LINK}`)
    expect(call[6].needsSetup).toBe(true)
  })
})

describe('S654 — every route that takes signers', () => {
  it('standalone documents: A\'s invitee pinned by id is refused', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Purchase agreement', documentType: 'purchase_agreement',
        signers: [
          { userId: w.b.userId, role: 'seller', name: 'B', email: w.b.email },
          { userId: w.x.userId, role: 'purchaser', name: 'Ex', email: ATTACKER },
        ],
      })
    expect(res.status).toBe(409)
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM lease_document_signers WHERE user_id=$1`, [w.x.userId])
    expect(n.rows[0].n).toBe(0)
  })

  it('standalone documents: A\'s invitee found by address, in another case, is refused', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Contract', documentType: 'general_contract',
        signers: [
          { userId: w.b.userId, role: 'party_1', name: 'B', email: w.b.email },
          { role: 'party_2', name: 'Ex', email: w.x.email.toUpperCase() },
        ],
      })
    expect(res.status).toBe(409)
  })

  it('standalone documents: B\'s own resident is stored at their own address', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Purchase agreement', documentType: 'purchase_agreement',
        signers: [
          { userId: w.b.userId, role: 'seller', name: 'B', email: w.b.email },
          { userId: w.y.userId, role: 'purchaser', name: 'Why', email: ATTACKER },
        ],
      })
    expect(res.status).toBe(200)
    const row = (await db.query(
      `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='purchaser'`, [res.body.data.id])).rows[0]
    expect(row.email).toBe(w.y.email)
  })

  it('addendum-add: A\'s invitee cannot be added to B\'s lease as the new tenant', async () => {
    const w = await seedWorld()
    const c = await db.connect()
    let leaseId: string
    try {
      leaseId = await seedLease(c, { unitId: w.b.unitId, landlordId: w.b.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: w.y.tenantId })
    } finally { c.release() }
    const res = await request(buildApp()).post('/api/esign/documents/addendum-add')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, title: 'Add a roommate',
        signers: [
          { role: 'landlord',    userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',     userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'co_tenant_1', userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 3 },
        ],
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Ex has no lease, invite or draft lease with this company/)
  })

  it('addendum-terms: A\'s invitee cannot ride along as a witness', async () => {
    const w = await seedWorld()
    const c = await db.connect()
    let leaseId: string
    try {
      leaseId = await seedLease(c, { unitId: w.b.unitId, landlordId: w.b.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: w.y.tenantId })
    } finally { c.release() }
    const res = await request(buildApp()).post('/api/esign/documents/addendum-terms')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, title: 'Parking',
        signers: [
          { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'witness',  userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 3 },
        ],
      })
    expect(res.status).toBe(409)
  })

  it('addendum-remove: A\'s invitee cannot ride along as a witness', async () => {
    const w = await seedWorld()
    const c = await db.connect()
    let leaseId: string, ltB: string
    let z: { userId: string; tenantId: string }
    try {
      leaseId = await seedLease(c, { unitId: w.b.unitId, landlordId: w.b.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: w.y.tenantId })
      const zTenant = await seedTenant(c)
      z = { tenantId: zTenant, userId: (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [zTenant])).rows[0].user_id }
      ltB = await seedLeaseTenant(c, { leaseId, tenantId: zTenant, role: 'co_tenant' })
    } finally { c.release() }
    const res = await request(buildApp()).post('/api/esign/documents/addendum-remove')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, targetLeaseTenantId: ltB!, title: 'Roommate leaves',
        signers: [
          { role: 'landlord',    userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
          { role: 'primary',     userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'co_tenant_1', userId: z!.userId, name: 'Zed', email: 'zed@resident.test', orderIndex: 3 },
          { role: 'witness',     userId: w.x.userId, name: 'Ex', email: ATTACKER, orderIndex: 4 },
        ],
      })
    expect(res.status).toBe(409)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S654 round 7 — reading a document never hands out a signing token.
//
// GET /documents/:id returned every signer row whole, token included. A token
// is a full stand-in for its signer (S629): resident Y read the landlord row's
// token and signed B's lease as the landlord, and owner B read X's token and
// signed as X.
// ─────────────────────────────────────────────────────────────────────────────

const tenantBearer = (who: { userId: string; tenantId: string; email: string }) => jwt.sign(
  { userId: who.userId, role: 'tenant', email: who.email, profileId: who.tenantId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

/** B's lease for B's own invitee Y, made through the route. */
async function bLeaseForY(w: Awaited<ReturnType<typeof seedWorld>>) {
  const res = await request(buildApp()).post('/api/esign/documents')
    .set('Authorization', `Bearer ${w.b.token}`)
    .send({
      title: 'Lease', unitId: w.b.unitId,
      signers: [
        { role: 'landlord', userId: w.b.userId, name: 'B', email: w.b.email, orderIndex: 1 },
        { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
      ],
    })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

describe('S654 — GET /documents/:id never hands out a signing token', () => {
  it('neither the owner nor a resident signer sees any row\'s token', async () => {
    const w = await seedWorld()
    const docId = await bLeaseForY(w)
    const tokens = (await db.query(
      `SELECT token FROM lease_document_signers WHERE document_id=$1`, [docId])).rows.map((r: any) => r.token)
    expect(tokens).toHaveLength(2)

    for (const bearer of [w.b.token, tenantBearer(w.y)]) {
      const got = await request(buildApp()).get(`/api/esign/documents/${docId}`)
        .set('Authorization', `Bearer ${bearer}`)
      expect(got.status).toBe(200)
      expect(got.body.data.signers).toHaveLength(2)
      expect(got.body.data.signers.map((s: any) => s.role).sort()).toEqual(['landlord', 'primary'])
      const json = JSON.stringify(got.body)
      for (const t of tokens) expect(json).not.toContain(t)
      for (const s of got.body.data.signers) expect(s).not.toHaveProperty('token')
    }
  })

  it('a resident signer does not see another signer\'s IP address or browser', async () => {
    const w = await seedWorld()
    const docId = await bLeaseForY(w)
    await db.query(
      `UPDATE lease_document_signers SET ip_address='203.0.113.7', user_agent='LandlordBrowser/1.0'
        WHERE document_id=$1 AND role='landlord'`, [docId])
    const asY = await request(buildApp()).get(`/api/esign/documents/${docId}`)
      .set('Authorization', `Bearer ${tenantBearer(w.y)}`)
    expect(asY.status).toBe(200)
    expect(JSON.stringify(asY.body)).not.toMatch(/203\.0\.113\.7|LandlordBrowser/)
    // The company's own audit trail still shows it to the owner.
    const asB = await request(buildApp()).get(`/api/esign/documents/${docId}`)
      .set('Authorization', `Bearer ${w.b.token}`)
    const lord = asB.body.data.signers.find((s: any) => s.role === 'landlord')
    expect(lord.ip_address).toBe('203.0.113.7')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S654 round 7 — the landlord's seat belongs to the document company's logins.
//
// Landlord B posted a document with landlord A's login in the landlord seat
// and attacker@evil.test as its address: 201, the row was stored at the
// attacker's address, /send mailed it A's row token, and A was now a signer
// who could read B's document.
// ─────────────────────────────────────────────────────────────────────────────

describe('S654 — only the document company\'s own logins sign for the landlord', () => {
  const lease = (w: any, lord: any) => ({
    title: 'Lease', unitId: w.b.unitId,
    signers: [
      { role: 'landlord', orderIndex: 1, ...lord },
      { role: 'primary', userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
    ],
  })
  const seatsOf = async (userId: string) =>
    (await db.query(`SELECT 1 FROM lease_document_signers WHERE user_id=$1`, [userId])).rows.length

  it('landlord A\'s login in B\'s landlord seat is refused, at the attacker\'s address or A\'s own', async () => {
    const w = await seedWorld()
    for (const email of [ATTACKER, w.a.email.toUpperCase()]) {
      const res = await request(buildApp()).post('/api/esign/documents')
        .set('Authorization', `Bearer ${w.b.token}`)
        .send(lease(w, { userId: w.a.userId, name: 'Ay', email }))
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/owner or staff member of this company/)
    }
    expect(await seatsOf(w.a.userId)).toBe(0)
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
    expect(createNotificationMock).not.toHaveBeenCalled()
  })

  it('B\'s own login at an address that is not its own is refused', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: w.b.userId, name: 'B', email: ATTACKER }))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/own email, or to this property's lease-signing email when the property's own signer holds the seat/)
    expect(await seatsOf(w.b.userId)).toBe(0)
  })

  it('B\'s own address in capitals is stored as the account holds it; a blank one is filled in', async () => {
    const w = await seedWorld()
    for (const email of [w.b.email.toUpperCase(), undefined]) {
      const res = await request(buildApp()).post('/api/esign/documents')
        .set('Authorization', `Bearer ${w.b.token}`)
        .send(lease(w, { userId: w.b.userId, name: 'B', email }))
      expect(res.status).toBe(201)
      const row = (await db.query(
        `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [res.body.data.id])).rows[0]
      expect(row.email).toBe(w.b.email)
      await db.query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [res.body.data.id])
    }
  })

  it('the property\'s lease-signing address is allowed for the landlord seat', async () => {
    const w = await seedWorld()
    await db.query(`UPDATE properties SET lease_signing_email='Office@Park.test' WHERE id=$1`, [w.b.propertyId])
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: w.b.userId, name: 'B', email: 'office@park.test' }))
    expect(res.status).toBe(201)
    const row = (await db.query(
      `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [res.body.data.id])).rows[0]
    expect(row.email).toBe('Office@Park.test')
    // A's property's on-site address is no use to B.
    await db.query(`UPDATE properties SET lease_signing_email=NULL WHERE id=$1`, [w.b.propertyId])
    await db.query(`UPDATE properties SET lease_signing_email='a-office@park.test' WHERE id=$1`, [w.a.propertyId])
    await db.query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [res.body.data.id])
    const other = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: w.b.userId, name: 'B', email: 'a-office@park.test' }))
    expect(other.status).toBe(409)
  })

  // S654 round 8: the property's lease-signing address is chosen by the
  // property's owner, so it may carry only the link of the login the property
  // names as its signer (landlordSigningContact). Reproduced two ways with B's
  // lease-signing address set to the attacker's: (a) after A's owner was added
  // to B as a co-owner, A's owner and A's property manager each took B's seat
  // at that address (201), and /send mailed it A's manager's row token; (b)
  // A's property manager, attached to B's team without consent, did the same.
  it("(a) after A's owner is attached to B: neither A's owner nor A's manager can take B's seat at B's lease-signing address", async () => {
    const w = await seedWorld()
    await db.query(`UPDATE properties SET lease_signing_email=$2 WHERE id=$1`, [w.b.propertyId, ATTACKER])
    // The round-8 co-owner add (landlords.ts /members), as it left the data.
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id) VALUES ($1, $2)`, [w.b.landlordId, w.a.userId])
    const aMgr = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Ay', 'Manager', TRUE) RETURNING id, email`,
      [`a-mgr-${randomUUID().slice(0, 6)}@park.test`])).rows[0]
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [aMgr.id, w.a.landlordId])

    for (const who of [{ userId: w.a.userId, name: 'Ay' }, { userId: aMgr.id, name: 'Ay Manager' }]) {
      const res = await request(buildApp()).post('/api/esign/documents')
        .set('Authorization', `Bearer ${w.b.token}`)
        .send(lease(w, { ...who, email: ATTACKER.toUpperCase() }))
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/lease-signing email/)
      expect(await seatsOf(who.userId)).toBe(0)
    }
    expect((await db.query(
      `SELECT 1 FROM lease_document_signers WHERE lower(email)=lower($1)`, [ATTACKER])).rows).toHaveLength(0)
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
  })

  it("(b) A's property manager attached to B's team: refused at B's lease-signing address, nothing stored there", async () => {
    const w = await seedWorld()
    await db.query(`UPDATE properties SET lease_signing_email=$2 WHERE id=$1`, [w.b.propertyId, ATTACKER])
    const aMgr = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Ay', 'Manager', TRUE) RETURNING id, email`,
      [`a-mgr-${randomUUID().slice(0, 6)}@park.test`])).rows[0]
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [aMgr.id, w.a.landlordId])
    // The round-8 team-invite accept with no login, as it left the data.
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [aMgr.id, w.b.landlordId])

    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: aMgr.id, name: 'Ay Manager', email: ATTACKER }))
    expect(res.status).toBe(409)
    expect(await seatsOf(aMgr.id)).toBe(0)
    expect((await db.query(
      `SELECT 1 FROM lease_document_signers WHERE lower(email)=lower($1)`, [ATTACKER])).rows).toHaveLength(0)
  })

  it("B's own co-owner and staff reach the seat only at their own address; the property's named signer keeps the lease-signing one", async () => {
    const w = await seedWorld()
    await db.query(`UPDATE properties SET lease_signing_email='Office@Park.test' WHERE id=$1`, [w.b.propertyId])
    const co = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'landlord', 'Co', 'Owner', TRUE) RETURNING id, email`,
      [`co-${randomUUID().slice(0, 6)}@owner.test`])).rows[0]
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id) VALUES ($1, $2)`, [w.b.landlordId, co.id])
    const staff = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'On', 'Site', TRUE) RETURNING id, email`,
      [`onsite-${randomUUID().slice(0, 6)}@park.test`])).rows[0]
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [staff.id, w.b.landlordId])

    for (const who of [{ userId: co.id, name: 'Co Owner' }, { userId: staff.id, name: 'On Site' }]) {
      const res = await request(buildApp()).post('/api/esign/documents')
        .set('Authorization', `Bearer ${w.b.token}`)
        .send(lease(w, { ...who, email: 'office@park.test' }))
      expect(res.status).toBe(409)
      expect(await seatsOf(who.userId)).toBe(0)
    }
    const coOwn = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: co.id, name: 'Co Owner', email: co.email }))
    expect(coOwn.status).toBe(201)
    await db.query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [coOwn.body.data.id])

    const named = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: w.b.userId, name: 'B', email: 'office@park.test' }))
    expect(named.status).toBe(201)
    const row = (await db.query(
      `SELECT email FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [named.body.data.id])).rows[0]
    expect(row.email).toBe('Office@Park.test')
  })

  it('a staff member on B\'s account, and a co-owner, can hold the seat', async () => {
    const w = await seedWorld()
    const staff = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'On', 'Site', TRUE) RETURNING id, email`,
      [`onsite-${randomUUID().slice(0, 6)}@park.test`])).rows[0]
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties) VALUES ($1, $2, TRUE)`,
      [staff.id, w.b.landlordId])
    const res = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: staff.id, name: 'On Site', email: staff.email }))
    expect(res.status).toBe(201)
    await db.query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [res.body.data.id])

    const co = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'landlord', 'Co', 'Owner', TRUE) RETURNING id, email`,
      [`co-${randomUUID().slice(0, 6)}@owner.test`])).rows[0]
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id) VALUES ($1, $2)`, [w.b.landlordId, co.id])
    const res2 = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: co.id, name: 'Co Owner', email: co.email }))
    expect(res2.status).toBe(201)

    // A's staff member is not B's.
    await db.query(`UPDATE onsite_manager_scopes SET landlord_id=$2 WHERE user_id=$1`, [staff.id, w.a.landlordId])
    await db.query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [res2.body.data.id])
    const res3 = await request(buildApp()).post('/api/esign/documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send(lease(w, { userId: staff.id, name: 'On Site', email: staff.email }))
    expect(res3.status).toBe(409)
  })

  it('standalone documents: A\'s login in the landlord seat is refused, by id and by address in capitals', async () => {
    const w = await seedWorld()
    const byId = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Contract', documentType: 'general_contract',
        signers: [
          { userId: w.a.userId, role: 'landlord', name: 'Ay', email: ATTACKER },
          { userId: w.y.userId, role: 'party_2', name: 'Why', email: w.y.email },
        ],
      })
    expect(byId.status).toBe(409)
    const byAddress = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        title: 'Contract', documentType: 'general_contract',
        signers: [
          { role: 'landlord', name: 'Ay', email: w.a.email.toUpperCase() },
          { userId: w.y.userId, role: 'party_2', name: 'Why', email: w.y.email },
        ],
      })
    expect(byAddress.status).toBe(409)
    expect(await seatsOf(w.a.userId)).toBe(0)
  })

  it('addendum-terms: A\'s login in the landlord seat is refused', async () => {
    const w = await seedWorld()
    const c = await db.connect()
    let leaseId: string
    try {
      leaseId = await seedLease(c, { unitId: w.b.unitId, landlordId: w.b.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: w.y.tenantId })
    } finally { c.release() }
    const res = await request(buildApp()).post('/api/esign/documents/addendum-terms')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, title: 'Parking',
        signers: [
          { role: 'landlord', userId: w.a.userId, name: 'Ay', email: ATTACKER, orderIndex: 1 },
          { role: 'primary',  userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
        ],
      })
    expect(res.status).toBe(409)
    expect(await seatsOf(w.a.userId)).toBe(0)
  })

  it('addendum-add and addendum-remove: A\'s login in the landlord seat is refused', async () => {
    const w = await seedWorld()
    const c = await db.connect()
    let leaseId: string, ltZ: string
    let z: { userId: string; tenantId: string }
    try {
      leaseId = await seedLease(c, { unitId: w.b.unitId, landlordId: w.b.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: w.y.tenantId })
      const zTenant = await seedTenant(c)
      z = { tenantId: zTenant, userId: (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [zTenant])).rows[0].user_id }
      ltZ = await seedLeaseTenant(c, { leaseId, tenantId: zTenant, role: 'co_tenant' })
    } finally { c.release() }
    const lord = { role: 'landlord', userId: w.a.userId, name: 'Ay', email: ATTACKER, orderIndex: 1 }
    const add = await request(buildApp()).post('/api/esign/documents/addendum-add')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, title: 'Add a roommate',
        signers: [
          lord,
          { role: 'primary',     userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'co_tenant_1', userId: z!.userId,  name: 'Zed', email: 'zed@resident.test', orderIndex: 3 },
        ],
      })
    expect(add.status).toBe(409)
    expect(add.body.error).toMatch(/owner or staff member of this company/)
    const remove = await request(buildApp()).post('/api/esign/documents/addendum-remove')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({
        leaseId: leaseId!, targetLeaseTenantId: ltZ!, title: 'Roommate leaves',
        signers: [
          lord,
          { role: 'primary',     userId: w.y.userId, name: 'Why', email: w.y.email, orderIndex: 2 },
          { role: 'co_tenant_1', userId: z!.userId,  name: 'Zed', email: 'zed@resident.test', orderIndex: 3 },
        ],
      })
    expect(remove.status).toBe(409)
    expect(remove.body.error).toMatch(/owner or staff member of this company/)
    expect(await seatsOf(w.a.userId)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S654 round 7 — POST /esign/draft-household.
//
// It had requirePerm but no requireAuth, so req.user was never set and every
// call came back 401 — which the landlord app reads as "signed out", logging
// the landlord out right after inviting a household to a unit.
// ─────────────────────────────────────────────────────────────────────────────

describe('S654 — POST /esign/draft-household', () => {
  it('a real session gets an answer, not a 401', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/draft-household')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ unitId: w.b.unitId, emails: [w.y.email] })
    expect(res.status).toBe(200)
    // No default template is set, so nothing drafts — and it says why.
    expect(res.body.data.drafted).toBe(false)
    expect(res.body.data.reason).toMatch(/default lease template/)
  })

  it('without a session it is still refused', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/draft-household')
      .send({ unitId: w.b.unitId, emails: [w.y.email] })
    expect(res.status).toBe(401)
  })

  it('landlord A\'s invitee cannot be drafted onto B\'s unit', async () => {
    const w = await seedWorld()
    const res = await request(buildApp()).post('/api/esign/draft-household')
      .set('Authorization', `Bearer ${w.b.token}`)
      .send({ unitId: w.b.unitId, emails: [w.y.email, w.x.email.toUpperCase()] })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no lease, invite or draft lease with this company/)
    const seats = await db.query(`SELECT 1 FROM lease_document_signers WHERE user_id=$1`, [w.x.userId])
    expect(seats.rows).toHaveLength(0)
  })
})
