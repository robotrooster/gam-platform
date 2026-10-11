/**
 * S648 (Nic) — correcting a tenant's name or email follows the one-email flow.
 *
 * Fixing Clay Simpson's invite: the name went onto his account but not onto the
 * lease already drafted for him, and saving re-sent the OLD portal invite — an
 * email the flow no longer has. Nothing goes to a tenant before the landlord
 * signs; after, the one "set up and sign" email goes to wherever they are now.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailSigningRequestMock, emailTenantInviteMock } = vi.hoisted(() => ({
  emailSigningRequestMock: vi.fn(async (..._a: any[]) => undefined),
  emailTenantInviteMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: emailSigningRequestMock,
  emailTenantInvite: emailTenantInviteMock,
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  emailTenantInviteMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_contact'
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

async function fixture(opts: { landlordSigned: boolean; withDoc?: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    const tu = (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    // Never signed in: the account is still the landlord's to correct.
    await c.query(
      `UPDATE users SET first_name='Clay', last_name='Simpsosn', last_login_at=NULL,
              password_hash='$2b$10$placeholder_invite_pending', tenant_invite_accepted_at=NULL
        WHERE id=$1`, [tu])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const intent = await c.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id`, [landlordId, tenantId, unitId, propertyId])
    let documentId: string | null = null
    if (opts.withDoc !== false) {
      const d = await c.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
         VALUES ($1,$2,'RV 25 lease','original_lease',$3) RETURNING id`,
        [landlordId, unitId, opts.landlordSigned ? 'in_progress' : 'sent'])
      documentId = d.rows[0].id
      await c.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
         VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,$4)`,
        [documentId, landlordUserId, crypto.randomBytes(32).toString('hex'), opts.landlordSigned ? 'signed' : 'sent'])
      await c.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
         VALUES ($1,$2,'primary','Clay Simpsosn',$3,2,$4,$5)`,
        [documentId, tu, tenantEmail, crypto.randomBytes(32).toString('hex'), opts.landlordSigned ? 'sent' : 'pending'])
      for (const [col, val] of Object.entries({ tenant_name: 'Clay Simpsosn', occupant_names: 'Clay Simpsosn', tenant_email: tenantEmail })) {
        await c.query(
          `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
           VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
      }
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
      profileId: landlordId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { token, intentId: intent.rows[0].id, documentId, tenantUserId: tu, tenantEmail }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const edit = (f: { token: string; intentId: string }, body: any) =>
  request(buildApp()).patch(`/api/landlords/me/pending-intents/${f.intentId}/contact`)
    .set('Authorization', `Bearer ${f.token}`).send(body)

const docFields = async (documentId: string) => Object.fromEntries(
  (await db.query(`SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1`, [documentId]))
    .rows.map((r: any) => [r.lease_column, r.value]))

describe('correcting a tenant before the landlord signs', () => {
  it('fixes the name on the draft and emails nobody', async () => {
    const f = await fixture({ landlordSigned: false })
    const res = await edit(f, { lastName: 'Simpson', email: 'clay_simpson@example.com', resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(false)
    expect(res.body.data.heldUntilLandlordSigns).toBe(true)
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
    expect(emailTenantInviteMock).not.toHaveBeenCalled()

    expect(await docFields(f.documentId!)).toEqual({
      tenant_name: 'Clay Simpson', occupant_names: 'Clay Simpson', tenant_email: 'clay_simpson@example.com',
    })
    const signer = (await db.query(
      `SELECT name, email FROM lease_document_signers WHERE document_id=$1 AND role='primary'`, [f.documentId])).rows[0]
    expect(signer).toEqual({ name: 'Clay Simpson', email: 'clay_simpson@example.com' })
  })
})

describe('correcting a tenant after the landlord signed', () => {
  it('sends the one lease email to the new address with a fresh link, and leaves the signed page alone', async () => {
    const f = await fixture({ landlordSigned: true })
    await db.query(`UPDATE users SET tenant_invite_token='old-token' WHERE id=$1`, [f.tenantUserId])
    const res = await edit(f, { email: 'clay_simpson@example.com', resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    expect(emailTenantInviteMock).not.toHaveBeenCalled()
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url, meta] = emailSigningRequestMock.mock.calls[0]
    expect(to).toBe('clay_simpson@example.com')
    expect(url).toContain('/accept-invite?token=')
    expect(url).not.toContain('old-token')
    expect(meta.needsSetup).toBe(true)
    // the landlord has signed over these words — they stay as signed
    expect((await docFields(f.documentId!)).tenant_email).toBe(f.tenantEmail)
  })
})

describe('no lease drafted', () => {
  it('still sends the portal invite, the only way in', async () => {
    const f = await fixture({ landlordSigned: false, withDoc: false })
    const res = await edit(f, { resend: true })
    expect(res.status).toBe(200)
    expect(emailTenantInviteMock).toHaveBeenCalledTimes(1)
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
  })
})
