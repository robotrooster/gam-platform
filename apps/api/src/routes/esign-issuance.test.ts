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
// S648 (Nic): only where the landlord chose to waive late fees for the
// property. Otherwise the first bill carries late fees like any other.
async function papered(f: any, waiver: boolean | null) {
  await db.query(`UPDATE properties SET onboarding_late_fee_waiver=$2 WHERE id=$1`, [f.propertyId, waiver])
  await db.query(
    `INSERT INTO pending_tenant_intents
       (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy)
     VALUES ($1,$2,$3,$4,TRUE)`,
    [f.landlordId, f.tenantId, f.unitId, f.propertyId])
}
describe('an existing tenancy onboarded late', () => {
  for (const waiver of [false, null]) {
    it(`is billed late fees when the landlord's waiver answer is ${waiver}`, async () => {
      const f = await fixture()
      const documentId = await unsignedDoc(f)
      await papered(f, waiver)
      await signAs(documentId, f.landlordToken)
      const lease = (await leasesFor(f.unitId))[0]
      const inv = (await db.query(
        `SELECT late_fee_exempt FROM invoices WHERE lease_id=$1 ORDER BY created_at LIMIT 1`,
        [lease.id])).rows[0]
      expect(inv.late_fee_exempt).toBe(false)
    })
  }

  it('is not fined for a bill it had not been sent, when the landlord waived', async () => {
    const f = await fixture()
    const documentId = await unsignedDoc(f)
    await db.query(`UPDATE properties SET onboarding_late_fee_waiver=TRUE WHERE id=$1`, [f.propertyId])
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

// S647: voiding a lease the landlord signed takes back what the signature made.
// Before this, the document voided and the lease, its invoice and its charges
// stayed live — a bill for a tenancy nobody agreed to.
describe('voiding a lease the landlord already signed', () => {
  const voidDoc = (documentId: string, token: string) =>
    request(buildApp())
      .post(`/api/esign/documents/${documentId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'wrong rent' })

  async function openInvite(f: Fixture, extra: Record<string, any> = {}) {
    const cols = ['landlord_id', 'tenant_id', 'unit_id', 'property_id', ...Object.keys(extra)]
    const vals = [f.landlordId, f.tenantId, f.unitId, f.propertyId, ...Object.values(extra)]
    await db.query(
      `INSERT INTO pending_tenant_intents (${cols.join(',')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals)
  }

  it('terminates the lease, voids the invoice and removes the charges', async () => {
    const f = await fixture()
    await openInvite(f)
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)
    const lease = (await leasesFor(f.unitId))[0]
    expect(lease.status).toBe('active')

    const res = await voidDoc(documentId, f.landlordToken)
    expect(res.status).toBe(200)

    const after = (await db.query(`SELECT status, termination_reason FROM leases WHERE id=$1`,
      [lease.id])).rows[0]
    expect(after.status).toBe('terminated')
    expect(after.termination_reason).toMatch(/voided before the tenant signed/)

    const inv = await invoicesFor(f.unitId)
    expect(inv.length).toBeGreaterThan(0)                  // kept, as a record
    expect(inv.every((i: any) => i.status === 'void')).toBe(true)

    const charges = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE lease_id=$1`, [lease.id])
    expect(charges.rows[0].n).toBe(0)

    const lt = await db.query(`SELECT status FROM lease_tenants WHERE lease_id=$1`, [lease.id])
    expect(lt.rows.every((r: any) => r.status === 'void')).toBe(true)
  })

  it('puts the household back on the desk as a voided lease, without re-drafting it', async () => {
    const f = await fixture()
    await openInvite(f)
    const documentId = await unsignedDoc(f)
    await db.query(`UPDATE pending_tenant_intents SET draft_document_id=$1 WHERE unit_id=$2`,
      [documentId, f.unitId])
    await signAs(documentId, f.landlordToken)
    await voidDoc(documentId, f.landlordToken)

    const intent = (await db.query(
      `SELECT resolved_at, resolved_lease_id, draft_document_id FROM pending_tenant_intents
        WHERE unit_id=$1`, [f.unitId])).rows[0]
    expect(intent.resolved_at).toBeNull()
    expect(intent.resolved_lease_id).toBeNull()
    // Still pointing at the voided document: re-sending is the landlord's call.
    expect(intent.draft_document_id).toBe(documentId)
  })

  it('refuses when money has already been paid on the lease', async () => {
    const f = await fixture()
    await openInvite(f)
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)
    const lease = (await leasesFor(f.unitId))[0]
    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW()
        WHERE id = (SELECT id FROM payments WHERE lease_id=$1 LIMIT 1)`, [lease.id])

    const res = await voidDoc(documentId, f.landlordToken)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/superseding/i)
    const still = (await db.query(`SELECT status FROM leases WHERE id=$1`, [lease.id])).rows[0]
    expect(still.status).toBe('active')
    const doc = (await db.query(`SELECT status FROM lease_documents WHERE id=$1`, [documentId])).rows[0]
    expect(doc.status).not.toBe('voided')
  })

  it('ends the work-trade agreement the signature created, so re-signing makes only one', async () => {
    const f = await fixture()
    await openInvite(f, { is_work_trade: true, work_trade_hours_target: 40 })
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)
    const active = await db.query(
      `SELECT COUNT(*)::int AS n FROM work_trade_agreements WHERE unit_id=$1 AND status='active'`,
      [f.unitId])
    expect(active.rows[0].n).toBe(1)

    await voidDoc(documentId, f.landlordToken)
    const after = await db.query(
      `SELECT COUNT(*)::int AS n FROM work_trade_agreements WHERE unit_id=$1 AND status='active'`,
      [f.unitId])
    expect(after.rows[0].n).toBe(0)
  })

  it('puts released utility back on hold, and a re-signed lease picks it up again', async () => {
    const f = await fixture()
    await openInvite(f)
    const m = await db.query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method)
       VALUES ($1,'electric','E','submeter') RETURNING id`, [f.propertyId])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [m.rows[0].id, f.unitId])
    await db.query(
      `INSERT INTO suspended_utility_charges
         (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type, usage_amount, charge_amount)
       VALUES ($1,$2,$3,'2026-08-01','electric',100,21.00)`,
      [m.rows[0].id, f.unitId, f.landlordId])

    const first = await unsignedDoc(f)
    await signAs(first, f.landlordToken)
    const billed = await db.query(
      `SELECT COUNT(*)::int AS n FROM utility_bills WHERE unit_id=$1`, [f.unitId])
    expect(billed.rows[0].n).toBe(1)

    await voidDoc(first, f.landlordToken)
    const held = (await db.query(
      `SELECT released_at FROM suspended_utility_charges WHERE unit_id=$1`, [f.unitId])).rows[0]
    expect(held.released_at).toBeNull()
    const gone = await db.query(
      `SELECT COUNT(*)::int AS n FROM utility_bills WHERE unit_id=$1`, [f.unitId])
    expect(gone.rows[0].n).toBe(0)

    // Re-draft at the right terms and sign again: the $21 comes back, once.
    const second = await unsignedDoc(f)
    await signAs(second, f.landlordToken)
    const again = await db.query(
      `SELECT charge_amount::float AS amt FROM utility_bills WHERE unit_id=$1`, [f.unitId])
    expect(again.rows).toHaveLength(1)
    expect(again.rows[0].amt).toBe(21)
  })
})

// S647 (Nic): "Why do we keep having this problem where the stuck meters are not
// getting billed? This is like the sixth time." A lease being signed bills its
// first utilities down a different road from the monthly run, and that road
// skipped any meter that did not move.
describe('a stuck meter when the lease is signed', () => {
  async function stuckMeter(f: Fixture, opts: { existing: boolean }) {
    // An invite inside a landlord's first 28 days is an onboarding (existing)
    // tenancy by trigger. A genuine new move-in needs a landlord past that.
    if (!opts.existing) {
      await db.query(`UPDATE landlords SET created_at = NOW() - INTERVAL '90 days' WHERE id=$1`,
        [f.landlordId])
    }
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy)
       VALUES ($1,$2,$3,$4,$5)`, [f.landlordId, f.tenantId, f.unitId, f.propertyId, opts.existing])
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit)
       VALUES ($1,'electric',0.21) ON CONFLICT DO NOTHING`, [f.propertyId])
    const meter = async (unitId: string, start: number, end: number) => {
      const m = await db.query<{ id: string }>(
        `INSERT INTO utility_meters (property_id, utility_type, label, billing_method)
         VALUES ($1,'electric','E','submeter') RETURNING id`, [f.propertyId])
      await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
        [m.rows[0].id, unitId])
      await db.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
         VALUES ($1,'2026-08-01',$2,'2026-08-01','baseline',$4),
                ($1,'2026-09-02',$3,'2026-08-01','monthly_cycle',$4)`,
        [m.rows[0].id, start, end, f.landlordUserId])
    }
    // The resident's own meter: read the same number twice.
    await meter(f.unitId, 61808, 61808)
    // A lived-in neighbour of the same type with real usage to estimate from.
    const c = await db.connect()
    try {
      const { seedUnit: su, seedLease: sl } = await import('../test/dbHelpers')
      const other = await su(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      await sl(c, { unitId: other, landlordId: f.landlordId, status: 'active' })
      await meter(other, 5000, 5300)
    } finally { c.release() }
  }

  it('bills an existing resident at the low end of what the neighbours used', async () => {
    const f = await fixture()
    await stuckMeter(f, { existing: true })
    const documentId = await unsignedDoc(f)
    // Onboarded in September, as the real ones were, so September's invoice is
    // open to receive August's electric.
    await db.query(`UPDATE lease_document_fields SET value='2026-09-16'
                     WHERE document_id=$1 AND lease_column='start_date'`, [documentId])
    await db.query(`UPDATE lease_document_fields SET value='-'
                     WHERE document_id=$1 AND lease_column='end_date'`, [documentId])
    await signAs(documentId, f.landlordToken)

    const bill = (await db.query(
      `SELECT usage_amount::float AS usage, charge_amount::float AS amount,
              allocation_method, payment_id
         FROM utility_bills WHERE unit_id=$1`, [f.unitId])).rows[0]
    expect(bill).toBeTruthy()
    expect(bill.usage).toBe(300)
    expect(bill.amount).toBe(63)
    expect(bill.allocation_method).toBe('comparable_low')
    // On the first invoice, not left waiting for next month.
    expect(bill.payment_id).not.toBeNull()
  })

  it('bills nothing for a new move-in — the space was empty that cycle', async () => {
    const f = await fixture()
    await stuckMeter(f, { existing: false })
    const documentId = await unsignedDoc(f)
    await signAs(documentId, f.landlordToken)

    const bills = await db.query(`SELECT 1 FROM utility_bills WHERE unit_id=$1`, [f.unitId])
    expect(bills.rows).toHaveLength(0)
  })
})
