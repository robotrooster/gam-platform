/**
 * S558 — smooth manual lease onboarding pipeline (Flow B, new leases).
 *
 * Exercises the real chain across landlords + tenants routers:
 *   POST /me/onboard-new-lease-tenant  (unit-linked invite, no lease row)
 *   POST /tenants/accept-invite        (accept → auto-draft when roster ready)
 *   → the e-sign document auto-drafts off the unit's default template with
 *     rent/deposit/term pre-filled, mode-aware (whole_unit shared vs by_room
 *     stacked), with the occupancy cap + co-tenant repair.
 *
 * emailTenantOnboarded is mocked; everything else writes the real DB chain.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision, seedTenant, seedLease } from '../test/dbHelpers'
import { autoDraftLeasesForUnit } from '../services/leaseOnboarding'

const { emailTenantOnboardedMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailTenantOnboarded: emailTenantOnboardedMock }
})

import { landlordsRouter } from './landlords'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pipeline'
})

interface Base { landlordUserId: string; landlordId: string; landlordToken: string; propertyId: string; unitId: string }

async function seedBase(occupancyMode = 'whole_unit', bedrooms = 1): Promise<Base> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // No-fee decision → template needs no late-fee fields for drafting.
    await seedLateFeeDecision(client, { propertyId, unitType: 'apartment', noLateFee: true })
    await client.query(`UPDATE units SET occupancy_mode=$1, bedrooms=$2 WHERE id=$3`, [occupancyMode, bedrooms, unitId])
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedDefaultTemplate(landlordId: string, depositMonths: number | null, termMonths: number | null): Promise<string> {
  const t = await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
     VALUES ($1, 'Primary Apartment', 1, 'apartment', $2, $3, true) RETURNING id`,
    [landlordId, depositMonths, termMonths])
  const tid = t.rows[0].id
  const cols = ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']
  for (const c of cols) {
    await db.query(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
       VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, c])
  }
  // Signature fields so both parties have a place to sign.
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','co_tenant_1','tenant_signature',1,10,140)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [tid])
  return tid
}

async function onboard(f: Base, email: string, first = 'A') {
  return request(buildApp())
    .post('/api/landlords/me/onboard-new-lease-tenant')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ firstName: first, lastName: 'Tester', email, phone: '555-0000', unitId: f.unitId })
}

async function inviteToken(email: string): Promise<string> {
  const r = await db.query<{ tenant_invite_token: string }>(`SELECT tenant_invite_token FROM users WHERE email=$1`, [email])
  return r.rows[0].tenant_invite_token
}

async function accept(token: string) {
  return request(buildApp()).post('/api/tenants/accept-invite').send({ token, password: 'password1234', acceptedTerms: true })
}

async function draftsForUnit(unitId: string) {
  const r = await db.query<any>(`SELECT id, status FROM lease_documents WHERE unit_id=$1 AND document_type='original_lease' ORDER BY created_at`, [unitId])
  return r.rows
}
async function fieldVals(documentId: string): Promise<Record<string, string | null>> {
  const r = await db.query<{ lease_column: string; value: string | null }>(`SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column IS NOT NULL`, [documentId])
  return Object.fromEntries(r.rows.map(x => [x.lease_column, x.value]))
}
async function signerRoles(documentId: string): Promise<string[]> {
  const r = await db.query<{ role: string }>(`SELECT role FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [documentId])
  return r.rows.map(x => x.role)
}

describe('onboard-new-lease-tenant (Flow B)', () => {
  it('creates a unit-bound intent + invite token and NO lease row', async () => {
    const f = await seedBase()
    const email = `t-${randomUUID().slice(0, 6)}@x.dev`
    const res = await onboard(f, email)
    expect(res.status).toBe(200)
    const intent = await db.query(`SELECT unit_id, accepted_at, draft_document_id FROM pending_tenant_intents WHERE unit_id=$1`, [f.unitId])
    expect(intent.rows.length).toBe(1)
    expect(intent.rows[0].accepted_at).toBeNull()
    const leases = await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [f.unitId])
    expect(leases.rows.length).toBe(0)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to invite before the unit has rent set', async () => {
    const f = await seedBase()
    await db.query(`UPDATE units SET rent_amount=0 WHERE id=$1`, [f.unitId])
    const res = await onboard(f, `t-${randomUUID().slice(0, 6)}@x.dev`)
    expect(res.status).toBe(400)
  })

  it('whole_unit: blocks a second lease when one is already active (409)', async () => {
    const f = await seedBase('whole_unit')
    const c = await db.connect()
    try {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, status: 'active' })
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'primary','active')`, [leaseId, tenantId])
    } finally { c.release() }
    const res = await onboard(f, `t-${randomUUID().slice(0, 6)}@x.dev`)
    expect(res.status).toBe(409)
  })
})

describe('accept → auto-draft', () => {
  // S647 (Nic, DIRECTIVE): "I want to sign my side of the lease for everybody
  // even before they accept the portal invite." This test used to prove the
  // opposite — that nothing drafted until the whole household had accepted.
  it('whole_unit: drafts ONE shared lease for the household BEFORE anyone accepts, deposit + term pre-filled', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1.5, 12)
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')

    // Nobody has accepted. The second invite voided the one-person draft and
    // re-drafted it with both, so exactly one live lease is waiting on the
    // landlord's signature.
    const live = (await draftsForUnit(f.unitId)).filter(d => d.status !== 'voided')
    expect(live.length).toBe(1)

    // Accepting afterwards does not draft a second copy.
    await accept(await inviteToken(eA))
    await accept(await inviteToken(eB))
    const drafts = (await draftsForUnit(f.unitId)).filter(d => d.status !== 'voided')
    expect(drafts.length).toBe(1)
    const roles = await signerRoles(drafts[0].id)
    expect(roles).toContain('landlord')
    expect(roles).toContain('primary')
    expect(roles).toContain('co_tenant_1')
    const vals = await fieldVals(drafts[0].id)
    expect(vals.rent_amount).toBe('1000.00')
    expect(vals.security_deposit).toBe('1500.00') // 1000 × 1.5, from the template
    // S635 (Nic): a tagged value is written onto the SIGNED DOCUMENT, so an enum
    // reaches the page as English. Was 'fixed_term' until a resident's lease
    // printed "month_to_month" in the rental-term blank.
    expect(vals.lease_type).toBe('Fixed term')
    expect(vals.start_date).toBeTruthy()
    expect(vals.end_date).toBeTruthy()
  })

  it('by_room: each accepted person gets their OWN lease; caps at 2×bedrooms', async () => {
    const f = await seedBase('by_room', 1) // cap = 2
    await seedDefaultTemplate(f.landlordId, 1, null) // month-to-month
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')
    await accept(await inviteToken(eA))
    await accept(await inviteToken(eB))
    const drafts = await draftsForUnit(f.unitId)
    expect(drafts.length).toBe(2) // two independent leases
    for (const d of drafts) {
      const roles = await signerRoles(d.id)
      expect(roles.filter(r => r === 'primary').length).toBe(1)
      expect(roles).not.toContain('co_tenant_1')
      expect((await fieldVals(d.id)).lease_type).toBe('Month-to-month')   // S635: humanised onto the page
    }
    // Third onboard exceeds the 2×bedrooms cap.
    const third = await onboard(f, `c-${randomUUID().slice(0, 6)}@x.dev`)
    expect(third.status).toBe(409)
  })

  it('whole_unit repair: adding a co-tenant voids the unsigned draft and re-drafts with all three', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`, eC = `c-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')
    const first = await draftsForUnit(f.unitId)
    expect(first.filter(d => d.status !== 'voided').length).toBe(1)
    const firstLiveId = first.find(d => d.status !== 'voided')!.id

    // Add a 3rd co-tenant → the unsigned draft voids and re-drafts with all
    // three straight away (S647: drafting no longer waits for acceptance).
    const add = await onboard(f, eC, 'Ccc')
    expect(add.status).toBe(200)
    const afterAdd = await draftsForUnit(f.unitId)
    expect(afterAdd.find(d => d.id === firstLiveId)!.status).toBe('voided')
    const live = afterAdd.filter(d => d.status !== 'voided')
    expect(live.length).toBe(1)
    const roles = await signerRoles(live[0].id)
    expect(roles).toContain('co_tenant_2')
  })

  // S647: once the landlord has signed, the lease is issued and billing. Voiding
  // it to re-draft with an extra person would orphan a live lease and invoice.
  it('whole_unit: refuses to add a co-tenant once the landlord has signed', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    await onboard(f, `a-${randomUUID().slice(0, 6)}@x.dev`, 'Aaa')
    const live = (await draftsForUnit(f.unitId)).filter(d => d.status !== 'voided')
    await db.query(`UPDATE lease_documents SET issued_at = NOW() WHERE id = $1`, [live[0].id])

    const add = await onboard(f, `b-${randomUUID().slice(0, 6)}@x.dev`, 'Bbb')
    expect(add.status).toBe(409)
    expect(add.body.error).toMatch(/addendum/i)
    const still = await db.query(`SELECT status FROM lease_documents WHERE id=$1`, [live[0].id])
    expect(still.rows[0].status).not.toBe('voided')
  })
})

// S582: a draft failure during accept must NOT abort the accept transaction
// (which would silently roll back the tenant's acceptance) and must NOT fail
// silently — it's contained in a SAVEPOINT and the landlord is notified.
describe('accept → auto-draft: draft failure is contained', () => {
  it('createDocumentRecord throw → no throw, txn survives, landlord notified, acceptance kept', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1.5, 12) // resolveDefaultTemplate returns a template
    const email = `fail-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, email) // creates the unit-bound pending intent (+ user + tenant)
    // S647: the invite now drafts on its own. Clear that so this test still
    // exercises what it is about — a draft that FAILS inside the accept txn.
    await db.query(
      `UPDATE lease_documents SET status='voided' WHERE unit_id=$1`, [f.unitId])
    await db.query(
      `UPDATE pending_tenant_intents SET draft_document_id=NULL WHERE unit_id=$1`, [f.unitId])

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Stamp acceptance in the SAME transaction the auto-draft runs in — this
      // is what would be lost if the draft failure aborted the whole txn.
      await client.query(
        `UPDATE pending_tenant_intents SET accepted_at=NOW() WHERE unit_id=$1 AND resolved_at IS NULL`,
        [f.unitId])

      const throwingCreateDoc = async () => { throw new Error('template missing required late-fee field') }
      const res = await autoDraftLeasesForUnit(client as any, f.unitId, throwingCreateDoc)

      // Contained: it did NOT throw, and nothing was drafted.
      expect(res.draftedDocumentIds).toEqual([])
      // The transaction is still healthy (SAVEPOINT rollback, not a full abort).
      const ping = await client.query('SELECT 1 AS ok')
      expect(ping.rows[0].ok).toBe(1)
      // Acceptance survives the commit.
      await client.query('COMMIT')
    } finally { client.release() }

    const acc = await db.query<{ accepted_at: string | null }>(
      `SELECT accepted_at FROM pending_tenant_intents WHERE unit_id=$1`, [f.unitId])
    expect(acc.rows[0].accepted_at).not.toBeNull()

    // Landlord got a visible blocked-draft notification (not a silent dead-end).
    const notif = await db.query<{ type: string }>(
      `SELECT type FROM notifications WHERE user_id=$1 AND type='lease_draft_blocked'`, [f.landlordUserId])
    expect(notif.rows.length).toBeGreaterThanOrEqual(1)
  })
})


// ─── S636: a drafted lease is not done until it is SENT ──────────────────────
//
// autoSendDraftedDocument reads through the POOL, and it was being called from
// inside the accept transaction — so it looked for a document that had not been
// committed, found nothing, returned false, and every lease drafted on
// acceptance sat at `pending` with the landlord never emailed. Nic noticed the
// symptom, not the cause: "Why are some leases saying pending and some saying
// sent?"
//
// Every test here asserted the document EXISTS. None asserted anyone was told
// about it, which is why a year of drafts could go out unsent without a failure.
describe('S636 an invited household gets a lease that is actually sent', () => {
  it('the drafted document reaches status sent, and the landlord is the one invited', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1.5, 12)
    const eA = `a-${randomUUID().slice(0, 6)}@x.dev`, eB = `b-${randomUUID().slice(0, 6)}@x.dev`
    await onboard(f, eA, 'Aaa'); await onboard(f, eB, 'Bbb')
    await accept(await inviteToken(eA))
    await accept(await inviteToken(eB))

    // S647: the household was drafted at invite time — the second invite voided
    // the one-person copy — so only the live document counts.
    const { rows } = await db.query<any>(
      `SELECT id, status FROM lease_documents WHERE unit_id = $1 AND status <> 'voided'`, [f.unitId])
    expect(rows).toHaveLength(1)
    // THE POINT: not 'pending'. A draft nobody was told about helps no one.
    expect(rows[0].status).toBe('sent')

    const signers = await db.query<any>(
      `SELECT role, status, invite_sent FROM lease_document_signers
        WHERE document_id = $1 ORDER BY order_index`, [rows[0].id])
    // The landlord signs first and is the only person emailed at this stage —
    // tenants are relayed to after each signature.
    expect(signers.rows[0].role).toBe('landlord')
    expect(signers.rows[0].invite_sent).toBe(true)
    expect(signers.rows.slice(1).every((s: any) => s.invite_sent === false)).toBe(true)
  })
})

// ─── S647: what the front desk sees ──────────────────────────────────────────
//
// Nic: "it's still saying waiting on them to accept the invite is 16 people. I
// want to sign my end of the lease for… [them]." Two things had to become true
// on the pending list for that to work, and neither had a test before.
describe('S647 the front desk after drafting moved to invite time', () => {
  async function pending(f: Base) {
    const r = await request(buildApp())
      .get('/api/landlords/me/pending-tenants')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r.status).toBe(200)
    return r.body.data as any[]
  }

  it('an invited, unaccepted person reads as invited — not accepted — and waits on the landlord', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    await onboard(f, `a-${randomUUID().slice(0, 6)}@x.dev`, 'Aaa')

    const [row] = await pending(f)
    // Being named on a draft used to count as proof of acceptance. It isn't now.
    expect(row.inviteState).toBe('invited')
    expect(row.leaseDocStatus).toBeTruthy()
    expect(row.leaseWaitingOnRole).toBe('landlord')
  })

  it('stays on the list after the landlord signs, while the tenant still owes theirs', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    await onboard(f, `a-${randomUUID().slice(0, 6)}@x.dev`, 'Aaa')
    // Simulate issuance: the landlord has signed, the lease is built, and S638
    // has closed the invite.
    const [before] = await pending(f)
    await db.query(
      `UPDATE lease_document_signers SET status='signed', signed_at=NOW()
        WHERE document_id=$1 AND role='landlord'`, [before.leaseDocId])
    await db.query(
      `UPDATE lease_documents SET status='in_progress', issued_at=NOW() WHERE id=$1`,
      [before.leaseDocId])
    await db.query(
      `UPDATE pending_tenant_intents SET resolved_at=NOW() WHERE unit_id=$1`, [f.unitId])

    const rows = await pending(f)
    expect(rows).toHaveLength(1)
    expect(rows[0].leaseWaitingOnRole).toBe('primary')
  })

  it('drops off once the lease is fully signed', async () => {
    const f = await seedBase('whole_unit')
    await seedDefaultTemplate(f.landlordId, 1, 12)
    await onboard(f, `a-${randomUUID().slice(0, 6)}@x.dev`, 'Aaa')
    const [before] = await pending(f)
    await db.query(`UPDATE lease_documents SET status='completed' WHERE id=$1`, [before.leaseDocId])
    await db.query(`UPDATE pending_tenant_intents SET resolved_at=NOW() WHERE unit_id=$1`, [f.unitId])
    expect(await pending(f)).toHaveLength(0)
  })
})
