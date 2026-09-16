/**
 * S647 — the landlord's signature issues the lease.
 *
 * Nic (DIRECTIVE): "Bill it out to everybody upon my signature." And on the
 * ordering: "My signature is done before they even accept — that way their
 * accept and sign is all one flow."
 *
 * Before this, a lease row and its move-in invoice appeared only when the LAST
 * signer finished, so a household that accepted a portal invite and then never
 * signed produced nothing billable at all. Thirteen were sitting in exactly
 * that state.
 *
 * These tests exist because the change moves WHEN money is created, and the two
 * failure modes are both expensive: billing nobody (the old behaviour) and
 * billing twice (the obvious way to get the new one wrong).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailSigningRequestMock } = vi.hoisted(() => ({
  emailSigningRequestMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: emailSigningRequestMock,
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_issuance'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

interface Fixture {
  landlordId: string; landlordUserId: string; landlordToken: string
  tenantId: string; tenantUserId: string; tenantToken: string; tenantEmail: string
  unitId: string; propertyId: string
}

async function fixture(): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(client, { email: tenantEmail })
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query('COMMIT')
    const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordId, landlordUserId, propertyId, unitId, tenantId, tenantEmail,
      tenantUserId: tu.rows[0].user_id,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord',
        email: 'll@test.dev', profileId: landlordId, permissions: {} }),
      tenantToken: sign({ userId: tu.rows[0].user_id, role: 'tenant',
        email: tenantEmail, profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** A lease document with BOTH parties still unsigned — the real starting state. */
async function unsignedDoc(f: Fixture): Promise<string> {
  const d = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Issuance test','original_lease','in_progress') RETURNING id`,
    [f.landlordId, f.unitId])
  const documentId = d.rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent')`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'primary','T T',$3,2,$4,'sent')`,
    [documentId, f.tenantUserId, f.tenantEmail, crypto.randomBytes(32).toString('hex')])
  for (const [col, val] of Object.entries({
    start_date: '2025-01-01', end_date: '2025-12-31', rent_amount: '1200.00',
    security_deposit: '1200.00', rent_due_day: '1', lease_type: 'fixed_term',
    auto_renew: 'false',
  })) {
    await db.query(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
  }
  return documentId
}

const signAs = (documentId: string, token: string) =>
  request(buildApp())
    .post(`/api/esign/sign/${documentId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ fieldValues: [] })

const leasesFor = (unitId: string) =>
  db.query(`SELECT * FROM leases WHERE unit_id=$1`, [unitId]).then(r => r.rows)
const invoicesFor = (unitId: string) =>
  db.query(`SELECT * FROM invoices WHERE unit_id=$1`, [unitId]).then(r => r.rows)

describe('the landlord signs', () => {
  it('creates the lease and the first invoice before the tenant has signed', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)

    const res = await signAs(documentId, f.landlordToken)
    expect(res.status).toBe(200)

    const leases = await leasesFor(f.unitId)
    expect(leases).toHaveLength(1)
    const invoices = await invoicesFor(f.unitId)
    expect(invoices.length).toBeGreaterThan(0)

    const doc = (await db.query(
      `SELECT status, issued_at, completed_at FROM lease_documents WHERE id=$1`,
      [documentId])).rows[0]
    expect(doc.issued_at).not.toBeNull()
    // Issued is not executed. The tenant still owes a signature and the
    // document must not claim otherwise.
    expect(doc.status).toBe('in_progress')
    expect(doc.completed_at).toBeNull()
  })

  it('does not put the tenant\'s signature on the lease before they sign', async () => {
    // The lease PDF prints these two flags as its signature block, so writing
    // TRUE here would sign a document nobody signed.
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)

    const lease = (await leasesFor(f.unitId))[0]
    expect(lease.signed_by_landlord).toBe(true)
    expect(lease.signed_by_tenant).toBe(false)
    expect(lease.signed_at).toBeNull()
  })

  it('makes the household billable — the whole point', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)

    // A back-dated lease is active immediately, which is what the monthly
    // invoice cron and the platform-fee accrual both key off.
    const lease = (await leasesFor(f.unitId))[0]
    expect(lease.status).toBe('active')

    const charges = await db.query(
      `SELECT type, amount::float AS amount FROM payments WHERE unit_id=$1`, [f.unitId])
    expect(charges.rows.length).toBeGreaterThan(0)
  })
})

describe('then the tenant signs', () => {
  it('executes the document without building a second lease or invoice', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)

    const leasesAfterIssue = await leasesFor(f.unitId)
    const invoicesAfterIssue = await invoicesFor(f.unitId)

    const res = await signAs(documentId, f.tenantToken)
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)

    // The money must not move twice. This is the failure mode that costs a
    // tenant a second deposit and a second first month.
    expect(await leasesFor(f.unitId)).toHaveLength(leasesAfterIssue.length)
    expect(await invoicesFor(f.unitId)).toHaveLength(invoicesAfterIssue.length)
  })

  it('records their signature and completes the document', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)
    await signAs(documentId, f.tenantToken)

    const doc = (await db.query(
      `SELECT status, completed_at, issued_at FROM lease_documents WHERE id=$1`,
      [documentId])).rows[0]
    expect(doc.status).toBe('completed')
    expect(doc.completed_at).not.toBeNull()
    // issued_at survives execution — they answer different questions.
    expect(doc.issued_at).not.toBeNull()

    const lease = (await leasesFor(f.unitId))[0]
    expect(lease.signed_by_tenant).toBe(true)
    expect(lease.signed_at).not.toBeNull()
  })

  it('never produces a second lease or invoice, however many times it is re-signed', async () => {
    // S581 guarded the one-time side effects with an "already built" test, which
    // S647 made useless: every lease is already built by the time the tenant
    // signs, so that test would have skipped the PDF stamp and the completion
    // emails on every execution. The guard is now a compare-and-swap on the
    // completion transition itself.
    //
    // A true concurrent race is not reproducible from a test client, so what is
    // pinned here is the consequence that actually costs money: no repeat of
    // the signing flow can bill a tenant a second deposit and a second first
    // month.
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)
    const first = await signAs(documentId, f.tenantToken)
    expect(first.body.data.completed).toBe(true)

    const leases = await leasesFor(f.unitId)
    const invoices = await invoicesFor(f.unitId)

    // Re-open the signature and run it again — the crudest version of a replay.
    await db.query(
      `UPDATE lease_document_signers SET status='sent', signed_at=NULL
        WHERE document_id=$1 AND role='primary'`, [documentId])
    await signAs(documentId, f.tenantToken)

    expect(await leasesFor(f.unitId)).toHaveLength(leases.length)
    expect(await invoicesFor(f.unitId)).toHaveLength(invoices.length)
    const charges = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE unit_id=$1 AND type='deposit'`, [f.unitId])
    expect(charges.rows[0].n).toBeLessThanOrEqual(1)
  })
})

// S647: the first invoice of an existing tenancy is dated the 1st of its
// billing cycle, which can already be weeks in the past — that is deliberate
// (an existing resident knows when rent is due). What must NOT follow is a late
// fee for missing a bill nobody had sent them. invoiceGeneration has exempted
// this since S637; the move-in invoice had not.
describe('an existing tenancy onboarded late', () => {
  it('is not fined for a bill it had not been sent', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    // Papering a resident who has lived there for years. esign reads this off
    // the INVITE, which is where the landlord said which kind of tenancy it was.
    await db.query(
      `INSERT INTO pending_tenant_intents
         (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy)
       VALUES ($1,$2,$3,$4,TRUE)`,
      [f.landlordId, f.tenantId, f.unitId, f.propertyId])

    await signAs(documentId, f.landlordToken)
    const lease = (await leasesFor(f.unitId))[0]
    expect(lease.is_existing_tenancy).toBe(true)
    const inv = (await db.query(
      `SELECT late_fee_exempt, due_date FROM invoices WHERE lease_id=$1
        ORDER BY created_at LIMIT 1`, [lease.id])).rows[0]
    expect(inv.late_fee_exempt).toBe(true)
  })
})

describe('a lease that never gets a tenant signature', () => {
  it('still bills, which is the thirteen households this was built for', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)

    // Tenant never signs. The document sits in_progress forever — and the
    // landlord has a lease, an invoice and a balance to chase, instead of
    // nothing at all.
    const doc = (await db.query(
      `SELECT status FROM lease_documents WHERE id=$1`, [documentId])).rows[0]
    expect(doc.status).toBe('in_progress')

    const lease = (await leasesFor(f.unitId))[0]
    expect(lease).toBeTruthy()
    expect(lease.status).toBe('active')
    expect((await invoicesFor(f.unitId)).length).toBeGreaterThan(0)
  })
})

// S647 (Nic, DIRECTIVE): "After I sign it, they click the email, and
// acceptance and signing all becomes one flow for the tenant."
describe('the email the tenant gets when the landlord signs', () => {
  it('sets up their account and opens the lease, if they never set one up', async () => {
    const f = await fixture()
    await db.query(
      `UPDATE users SET password_hash='$2b$10$placeholder_invite_pending',
                        tenant_invite_accepted_at=NULL WHERE id=$1`, [f.tenantUserId])
    const documentId = await unsignedDoc(f)
    // As drafted for real: the tenant is not asked until the landlord signs.
    await db.query(`UPDATE lease_document_signers SET status='pending', invite_sent=FALSE
                     WHERE document_id=$1 AND role='primary'`, [documentId])
    await signAs(documentId, f.landlordToken)

    const toTenant = emailSigningRequestMock.mock.calls.filter(c => c[0] === f.tenantEmail)
    expect(toTenant).toHaveLength(1)
    const [, , , , , url, ctx] = toTenant[0] as any[]
    expect(url).toContain('/accept-invite?token=')
    expect(url).toContain(encodeURIComponent(`/sign/${documentId}`))
    expect(ctx.needsSetup).toBe(true)
  })

  it('is the ordinary signing link for someone who already has a login', async () => {
    const f = await fixture()
    await db.query(`UPDATE users SET tenant_invite_accepted_at=NOW() WHERE id=$1`, [f.tenantUserId])
    const documentId = await unsignedDoc(f)
    // As drafted for real: the tenant is not asked until the landlord signs.
    await db.query(`UPDATE lease_document_signers SET status='pending', invite_sent=FALSE
                     WHERE document_id=$1 AND role='primary'`, [documentId])
    await signAs(documentId, f.landlordToken)

    const toTenant = emailSigningRequestMock.mock.calls.filter(c => c[0] === f.tenantEmail)
    expect(toTenant).toHaveLength(1)
    const [, , , , , url, ctx] = toTenant[0] as any[]
    expect(url).toMatch(/\/sign\//)
    expect(url).not.toContain('accept-invite')
    expect(ctx.needsSetup).toBe(false)
  })
})
