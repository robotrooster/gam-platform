/**
 * A FULLY EXECUTED DOCUMENT LOCKS ITS SIGNING LINK (10/30, Nic).
 *
 * What he saw, on his phone: he opened landlord.goldassetmanagement.com while
 * NOT signed in, and a completed lease for a resident — their name, their
 * space, the terms — rendered above the sign-in screen.
 *
 * It was not a leak in the sense of a hole: the token in that URL was the
 * landlord signer slot on that very document, and the gate deliberately admits
 * a signer token so a link mailed to someone works without a session (S629).
 * The defect was that the gate checked for 'voided' and never for 'completed',
 * so the link stayed live forever after there was anything left to sign.
 *
 * His decision, verbatim: "as soon as everybody's signed the document and it's
 * fully executed, it should lock, because signing was just bypassed for ease of
 * onboarding. But to actually view anything, it should be immediately, you have
 * to get signed back in."
 *
 * So both doors close on completion — the signing page AND the PDF behind it.
 * Locking one and leaving the other is a lock on a room with no wall. Nothing
 * is taken from the signer: both completed-document emails attach the signed
 * PDF and send them to their portal home, not to a token URL.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  // The same headers index.ts puts in front of this path in production. Without
  // them a test proves the wrong thing: the first version of this file mounted
  // the router bare, passed, and hid that the forced `Content-Type:
  // application/pdf` was stopping res.json() from labelling the refusal — so
  // the real server was answering with JSON bytes dressed as a PDF and no
  // caller could read the sentence. Drive what ships.
  app.use('/api/esign/files', (_req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL')
    res.setHeader('Content-Security-Policy', 'frame-ancestors *')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    next()
  })
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_completed_lock'
})

/** A document in `status`, with one signer holding a 64-hex token. */
async function documentWithSigner(status: string) {
  const c = await db.connect()
  let landlordId: string
  let tenantUserId: string
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c, { email: `ll-${randomUUID().slice(0, 8)}@test.dev` })
    const propertyId = await seedProperty(c, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId,
    })
    await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c, { email: `res-${randomUUID().slice(0, 8)}@test.dev` })
    await c.query('COMMIT')
    landlordId = ll.landlordId
    tenantUserId = (await db.query(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  const basePdfUrl = `/api/esign/files/lock-${randomUUID().slice(0, 8)}.pdf`
  const doc = (await db.query(
    `INSERT INTO lease_documents (landlord_id, title, status, base_pdf_url)
     VALUES ($1, 'Lot Lease', $2, $3) RETURNING id`,
    [landlordId, status, basePdfUrl])).rows[0]

  // A real token is 64 hex characters; the gate rejects any other shape before
  // it ever reaches the database.
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, token, status)
     VALUES ($1, $2, 'primary', 'A Resident', 'res@test.dev', $3, $4)`,
    [doc.id, tenantUserId, token, status === 'completed' ? 'signed' : 'pending'])

  return { documentId: doc.id as string, token, basePdfUrl }
}

describe('a completed document closes its signing link', () => {
  it('refuses to open the signing page, and says why in plain words', async () => {
    const { token } = await documentWithSigner('completed')
    const r = await request(buildApp()).get(`/api/esign/sign/${token}`)
    expect(r.status).toBe(410)
    expect(r.body.success).toBe(false)
    expect(r.body.code).toBe('document_completed')
    // The reader is told where their copy actually is, not just refused.
    expect(r.body.error).toMatch(/fully signed/i)
    expect(r.body.error).toMatch(/sign in/i)
  })

  it('refuses a signature submitted through the closed link', async () => {
    const { token } = await documentWithSigner('completed')
    const r = await request(buildApp())
      .post(`/api/esign/sign/${token}`)
      .send({ fieldValues: [] })
    expect(r.status).toBe(410)
    expect(r.body.code).toBe('document_completed')
  })

  it('refuses the PDF behind it, so the lock is not a door with no wall', async () => {
    const { token, basePdfUrl } = await documentWithSigner('completed')
    const filename = basePdfUrl.split('/').pop()!
    const r = await request(buildApp()).get(`/api/esign/files/${filename}?t=${token}`)
    expect(r.status).toBe(410)
    expect(r.body.code).toBe('document_completed')
    // Readable as JSON, not as PDF bytes nobody can parse.
    expect(r.headers['content-type']).toMatch(/application\/json/)
  })

  it('still lets a signer in while the document is unfinished', async () => {
    // The point of the gate is that an emailed link opens without a session.
    // Breaking that for an in-progress document would stop onboarding dead, so
    // this asserts the lock is specific to completion and nothing wider.
    const { token } = await documentWithSigner('in_progress')
    const r = await request(buildApp()).get(`/api/esign/sign/${token}`)
    expect(r.status).not.toBe(410)
    expect(r.body?.code).not.toBe('document_completed')
  })

  it('still serves the PDF to a signer while the document is unfinished', async () => {
    const { token, basePdfUrl } = await documentWithSigner('in_progress')
    const filename = basePdfUrl.split('/').pop()!
    const r = await request(buildApp()).get(`/api/esign/files/${filename}?t=${token}`)
    // The file itself is not on disk in a test, so a 404 is the right answer
    // here — what matters is that the gate let the token through rather than
    // closing it as completed.
    expect(r.status).not.toBe(410)
    expect(r.body?.code).not.toBe('document_completed')
  })
})
