/**
 * 10/13 (Nic): "Customer profiles should mostly have birthdays." When a lease
 * finishes signing, the birthdate the tenant typed in it ("Birthdate 1") goes
 * onto their profile — matched to the name beside it (services/leaseBirthdates).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign_birthdates'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

async function fixture() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(c, { email: tenantEmail }) // named "Test Tenant"
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
    const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordId, unitId, tenantId,
      landlordUserId, tenantUserId, tenantEmail,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} }),
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: tenantEmail, profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The lease form's people table: the name box the landlord fills, the birthdate box the tenant fills. */
async function leaseDoc(f: Awaited<ReturnType<typeof fixture>>) {
  const documentId = (await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Birthday test','original_lease','in_progress') RETURNING id`, [f.landlordId, f.unitId])).rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent'),
            ($1,$4,'primary','Test Tenant',$5,2,$6,'sent')`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex'),
     f.tenantUserId, f.tenantEmail, crypto.randomBytes(32).toString('hex')])
  for (const [col, val] of Object.entries({
    start_date: '2025-01-01', end_date: '2027-12-31', rent_amount: '460.00',
    security_deposit: '460.00', rent_due_day: '1', lease_type: 'fixed_term', auto_renew: 'false',
  })) {
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
  }
  await db.query(
    `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, lease_column, value, required)
     VALUES ($1,'text','landlord','Tenant name 1','tenant_name','Test Tenant',FALSE)`, [documentId])
  const birthdate = (await db.query<{ id: string }>(
    `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, required)
     VALUES ($1,'date','primary','Birthdate 1',FALSE) RETURNING id`, [documentId])).rows[0].id
  return { documentId, birthdate }
}

const signAs = (documentId: string, token: string, fieldValues: any[] = []) =>
  request(buildApp()).post(`/api/esign/sign/${documentId}`).set('Authorization', `Bearer ${token}`).send({ fieldValues })

const birthdayOf = async (tenantId: string) =>
  (await db.query(`SELECT date_of_birth::text AS d FROM tenants WHERE id=$1`, [tenantId])).rows[0].d

describe('a lease finishing its signatures', () => {
  it('puts the birthdate the tenant typed onto their profile', async () => {
    const f = await fixture()
    const { documentId, birthdate } = await leaseDoc(f)
    expect((await signAs(documentId, f.landlordToken)).status).toBe(200)
    // Issued is not signed: nothing is copied until everyone has signed.
    expect(await birthdayOf(f.tenantId)).toBeNull()

    const res = await signAs(documentId, f.tenantToken, [{ fieldId: birthdate, value: '3/29/1960' }])
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    expect(await birthdayOf(f.tenantId)).toBe('1960-03-29')
  })

  it('never changes a birthday already on the profile', async () => {
    const f = await fixture()
    await db.query(`UPDATE tenants SET date_of_birth = '1960-03-28' WHERE id = $1`, [f.tenantId])
    const { documentId, birthdate } = await leaseDoc(f)
    await signAs(documentId, f.landlordToken)
    const res = await signAs(documentId, f.tenantToken, [{ fieldId: birthdate, value: '3/29/1960' }])
    expect(res.body.data.completed).toBe(true)
    expect(await birthdayOf(f.tenantId)).toBe('1960-03-28')
  })
})
