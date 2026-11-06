/**
 * 10/28 — THE TAKEOVER, DRIVEN THE WAY A LANDLORD DRIVES IT.
 *
 * Nic: "I can see that it works, but I don't know that it actually works. You
 * get what I'm saying?"
 *
 * He is right to ask. services/spotSuccession.test.ts has nineteen tests and
 * every one of them calls the service function directly. Nothing exercised the
 * route the GoldSign → Send Document screen actually posts to, which is the
 * precise gap that let the Invite Tenant modal ship a "Taking over an occupied
 * spot" group whose server side refuses it with a 409. A screen wired to
 * nothing passes every service test ever written.
 *
 * So this file starts at the HTTP door:
 *   POST /api/esign/documents   (with replacesLeaseId — what the screen sends)
 *   POST /api/esign/sign/:id    (the landlord)
 *   POST /api/esign/sign/:id    (the replacement — the signature that fires it)
 * and then runs the nightly sweep on top, because that is where the handover
 * was being quietly undone until today.
 *
 * The shape is Blue's: a tenant-owned mobile home on a rented space,
 * month-to-month with no end date, one resident leaving and one taking over.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
  emailLeaseFullyExecuted: vi.fn(async () => undefined),
  emailSpaceHandedOver: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLeaseTenant } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { backgroundRouter } from './background'
import { tenantsRouter } from './tenants'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { processLeaseEnds } from '../jobs/scheduler'
import { todayIn } from '../lib/timezone'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_takeover'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use('/api/background', backgroundRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

const token = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

/**
 * A space with somebody on it, and somebody else ready to take it: the state
 * Blue is in. The sitting lease is month-to-month with NO end date, which is
 * every space rental on the platform (73 of the 83 live leases).
 */
async function spaceWithASittingResident() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 589 })
    // Tenant-owned dwelling on a rented space — Blue's mobile home.
    await client.query(
      `UPDATE units SET dwelling_ownership = 'tenant', unit_type = 'mobile_home', status = 'active'
        WHERE id = $1`, [unitId])

    const leavingEmail = `leaving-${randomUUID()}@test.dev`
    const leavingTenantId = await seedTenant(client, { email: leavingEmail })
    const sitting = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, end_date,
                           rent_amount, signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'active', 'month_to_month', CURRENT_DATE - 400, NULL, 589, TRUE, TRUE)
       RETURNING id`, [unitId, landlordId])
    await seedLeaseTenant(client, { leaseId: sitting.rows[0].id, tenantId: leavingTenantId })

    const takingOverEmail = `takingover-${randomUUID()}@test.dev`
    const takingOverTenantId = await seedTenant(client, { email: takingOverEmail })
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [takingOverTenantId])
    // Blue's actual situation: the person taking over applied to HIS park and
    // passed HIS background check, and has nothing else with him — no lease, no
    // invite, no draft. Before 10/28 that made them a stranger to every door
    // (esign.ts residentsTiedHere), so Send Document answered "Invite them
    // first" and the invite door refused the occupied space.
    const bc = await client.query<{ id: string }>(
      `INSERT INTO background_checks (user_id, landlord_id, status, first_name, last_name, property_id)
       VALUES ($1, $2, 'approved', 'New', 'Resident', $3) RETURNING id`,
      [tu.rows[0].user_id, landlordId, propertyId])

    // The screening door drafts off the unit type's DEFAULT template (the
    // GoldSign door is handed one by the landlord instead), so a park with none
    // set gets `needsTemplate` and no document — a configuration gap, not a
    // takeover failure. Blue's park has one; the fixture needs one too.
    await client.query(
      `INSERT INTO lease_templates (landlord_id, name, unit_type, is_unit_type_default, base_pdf_url, is_active)
       VALUES ($1, 'mobile_home lease', 'mobile_home', TRUE, '/uploads/lease.pdf', TRUE)`,
      [landlordId])

    // S654: the landlord's signing link goes ONLY to that login's own address,
    // so the fixture has to use the real one rather than a made-up label.
    const lu = await client.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [landlordUserId])

    await client.query('COMMIT')
    return {
      checkId: bc.rows[0].id,
      landlordEmail: lu.rows[0].email,
      landlordId, landlordUserId, propertyId, unitId,
      sittingLeaseId: sitting.rows[0].id, leavingTenantId, leavingEmail,
      takingOverTenantId, takingOverEmail, takingOverUserId: tu.rows[0].user_id,
      landlordToken: token({ userId: landlordUserId, role: 'landlord', email: lu.rows[0].email,
        profileId: landlordId, permissions: {} }),
      takingOverToken: token({ userId: tu.rows[0].user_id, role: 'tenant',
        email: takingOverEmail, profileId: takingOverTenantId, permissions: {} }),
    }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** Exactly what the Send Document screen posts when the replaces box is ticked. */
const sendDocument = (f: any, body: Record<string, unknown>) =>
  request(buildApp())
    .post('/api/esign/documents')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({
      unitId: f.unitId,
      title: 'Lease — space takeover',
      signers: [
        { userId: f.landlordUserId, role: 'landlord', name: 'L L', email: f.landlordEmail },
        { userId: f.takingOverUserId, role: 'primary', name: 'New Resident', email: f.takingOverEmail },
      ],
      prefillValues: {
        start_date: todayIn(null),
        rent_amount: '589.00',
        rent_due_day: '1',
        lease_type: 'month_to_month',
      },
      ...body,
    })

/**
 * The lease values. On a real send these come off the template the landlord
 * picked (its bound fields); this harness picks no template, so they are
 * written on directly — the same thing esign-issuance.test.ts does. Without
 * them the document executes into nothing (status 'execution_failed') and no
 * lease is ever created, which is a missing template, not a missing takeover.
 */
async function leaseValues(documentId: string, startIso: string) {
  for (const [col, val] of Object.entries({
    start_date: startIso,
    rent_amount: '589.00',
    rent_due_day: '1',
    lease_type: 'month_to_month',
    auto_renew: 'false',
  })) {
    await db.query(
      `INSERT INTO lease_document_fields
         (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
  }
}

const signAs = (documentId: string, tok: string) =>
  request(buildApp())
    .post(`/api/esign/sign/${documentId}`)
    .set('Authorization', `Bearer ${tok}`)
    .send({ fieldValues: [] })

const leaseRow = async (id: string) => (await db.query<any>(
  `SELECT status, lease_type, to_char(end_date,'YYYY-MM-DD') AS end_date,
          signed_by_tenant, signed_by_landlord, replaces_lease_id
     FROM leases WHERE id = $1`, [id])).rows[0]

const today = () => todayIn(null)

/**
 * 11/01: this took the wall clock in UTC and stepped back a day, while today()
 * is GAM's home calendar — and from 5pm Phoenix those two expressions name the
 * SAME day, so the pair quietly stopped being a day apart. Derived from today()
 * now, which is the only way "the day before the new lease starts" can be
 * guaranteed to be exactly that.
 */
const yesterday = () => {
  const d = new Date(`${today()}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

describe('GoldSign → Send Document, with the replaces box ticked', () => {
  it('the door accepts the takeover and records WHICH tenancy is being replaced', async () => {
    const f = await spaceWithASittingResident()
    const res = await sendDocument(f, { replacesLeaseId: f.sittingLeaseId })
    expect(res.status).toBe(201)
    const doc = (await db.query<any>(
      `SELECT unit_id, replaces_lease_id FROM lease_documents WHERE id = $1`,
      [res.body.data.id])).rows[0]
    // Not taken on trust from the browser — stored, and checked against the space.
    expect(doc.replaces_lease_id).toBe(f.sittingLeaseId)
    expect(doc.unit_id).toBe(f.unitId)
  })

  it('refuses a replacement pointed at a lease that is not on this space', async () => {
    const f = await spaceWithASittingResident()
    const other = await spaceWithASittingResident()
    const res = await sendDocument(f, { replacesLeaseId: other.sittingLeaseId })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('the LANDLORD signature alone releases nobody', async () => {
    const f = await spaceWithASittingResident()
    const created = await sendDocument(f, { replacesLeaseId: f.sittingLeaseId })
    expect(created.status).toBe(201)
    await leaseValues(created.body.data.id, today())

    const signed = await signAs(created.body.data.id, f.landlordToken)
    expect(signed.status).toBe(200)

    // Nic (10/24, with Blue): "if the other person never fully commits, he
    // can't release the original person and then be stuck with nothing."
    const sitting = await leaseRow(f.sittingLeaseId)
    expect(sitting.status).toBe('active')
    expect(sitting.end_date).toBeNull()
  })

  it("the REPLACEMENT's signature hands the space over", async () => {
    const f = await spaceWithASittingResident()
    const created = await sendDocument(f, { replacesLeaseId: f.sittingLeaseId })
    await leaseValues(created.body.data.id, today())
    await signAs(created.body.data.id, f.landlordToken)
    const res = await signAs(created.body.data.id, f.takingOverToken)
    expect(res.status).toBe(200)

    // The sitting lease now ends the day before the new one starts.
    const sitting = await leaseRow(f.sittingLeaseId)
    expect(sitting.end_date).toBe(yesterday())

    // And the new tenancy is a real lease on the same space, naming what it replaced.
    const replacement = (await db.query<any>(
      `SELECT id, status, replaces_lease_id, signed_by_tenant, signed_by_landlord
         FROM leases WHERE unit_id = $1 AND id <> $2`, [f.unitId, f.sittingLeaseId])).rows
    expect(replacement).toHaveLength(1)
    expect(replacement[0].replaces_lease_id).toBe(f.sittingLeaseId)
    expect(replacement[0].signed_by_tenant).toBe(true)
    expect(replacement[0].signed_by_landlord).toBe(true)

    // The space is never freed — somebody is always on it.
    const unit = (await db.query<any>(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0]
    expect(unit.status).toBe('active')
  })

  it('and the nightly sweep does not undo it', async () => {
    // The half that was broken until today: the sweep saw a tenant-owned
    // dwelling with a past end date and set it back to NULL, month-to-month —
    // the departing resident still billing on a space already signed away.
    const f = await spaceWithASittingResident()
    const created = await sendDocument(f, { replacesLeaseId: f.sittingLeaseId })
    await leaseValues(created.body.data.id, today())
    await signAs(created.body.data.id, f.landlordToken)
    await signAs(created.body.data.id, f.takingOverToken)

    await processLeaseEnds()

    const sitting = await leaseRow(f.sittingLeaseId)
    expect(sitting.end_date).toBe(yesterday())   // the signed date STANDS
    expect(sitting.status).toBe('expired')       // and the tenancy actually ended
    // (lease_type stays whatever it was — a space rental IS month-to-month. The
    // lapse is identified by the end date being erased while the lease stays
    // active, which is what the two assertions above rule out.)
    // Still occupied: the replacement has it.
    const unit = (await db.query<any>(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0]
    expect(unit.status).toBe('active')
  })
})

/**
 * THE SCREENING DOOR — the one Nic wants Blue to use.
 *
 *   "I don't want him to do the gold sign send document flow. I want him to do
 *    the flow from the background check — the screened applicant that's already
 *    in the list — invite them to a unit that's already occupied."
 *
 * Same destination as GoldSign, reached from the applicant's own row: the
 * document carries the tenancy it replaces, and the replacement's signature is
 * what hands the space over.
 */
describe('Background Checks → Draft lease, onto an occupied space', () => {
  const draftFromCheck = (f: any, body: Record<string, unknown>) =>
    request(buildApp())
      .post(`/api/background/${f.checkId}/draft-lease`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send(body)

  it('drafts the takeover and records WHICH tenancy is being replaced', async () => {
    const f = await spaceWithASittingResident()
    const res = await draftFromCheck(f, { unitId: f.unitId, takeover: true })
    expect(res.status).toBe(200)
    const docId = (res.body.data ?? res.body).documentId
    expect(docId).toBeTruthy()
    const doc = (await db.query<any>(
      `SELECT unit_id, replaces_lease_id FROM lease_documents WHERE id = $1`, [docId])).rows[0]
    expect(doc.replaces_lease_id).toBe(f.sittingLeaseId)
    expect(doc.unit_id).toBe(f.unitId)
  })

  it('REFUSES the same space when the takeover is not confirmed — rather than quietly double-leasing it', async () => {
    const f = await spaceWithASittingResident()
    const res = await draftFromCheck(f, { unitId: f.unitId })
    expect(res.status).toBe(409)
    // And nothing was created: one lease on that space, the sitting one.
    const leases = (await db.query<any>(
      `SELECT id FROM leases WHERE unit_id = $1`, [f.unitId])).rows
    expect(leases).toHaveLength(1)
    expect(leases[0].id).toBe(f.sittingLeaseId)
  })

  it('hands the space over on the replacement\'s signature, exactly like GoldSign', async () => {
    const f = await spaceWithASittingResident()
    const res = await draftFromCheck(f, { unitId: f.unitId, takeover: true })
    const docId = (res.body.data ?? res.body).documentId
    await leaseValues(docId, today())
    await signAs(docId, f.landlordToken)
    await signAs(docId, f.takingOverToken)

    const sitting = await leaseRow(f.sittingLeaseId)
    expect(sitting.end_date).toBe(yesterday())

    // And the sweep leaves the handover alone.
    await processLeaseEnds()
    const after = await leaseRow(f.sittingLeaseId)
    expect(after.end_date).toBe(yesterday())
    expect(after.status).toBe('expired')
    const unit = (await db.query<any>(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0]
    expect(unit.status).toBe('active')
  })
})

/**
 * THE INVITE DOOR — Tenants → Invite Tenant → "Taking over an occupied spot".
 *
 * This group has been on the screen since 10/26 and every click on it was
 * refused by the whole-unit occupancy cap, because nothing told the service a
 * takeover was intended. Same destination as the other two doors now.
 */
describe('Tenants → Invite Tenant, onto an occupied space', () => {
  const invite = (f: any, body: Record<string, unknown>) =>
    request(buildApp())
      .post('/api/tenants/invite')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        unitId: f.unitId,
        firstName: 'New', lastName: 'Resident', email: f.takingOverEmail,
        residents: [{ firstName: 'New', lastName: 'Resident', email: f.takingOverEmail, phone: null }],
        ...body,
      })

  it('takes the space over when the occupied group was chosen', async () => {
    const f = await spaceWithASittingResident()
    const res = await invite(f, { takeover: true })
    expect(res.status).toBeLessThan(300)
    // The drafted lease document names the tenancy it replaces.
    const docs = (await db.query<any>(
      `SELECT replaces_lease_id FROM lease_documents
        WHERE unit_id = $1 AND document_type = 'original_lease'`, [f.unitId])).rows
    expect(docs.length).toBeGreaterThan(0)
    expect(docs.some(d => d.replaces_lease_id === f.sittingLeaseId)).toBe(true)
  })

  it('still refuses an ordinary invite onto somebody else\'s home', async () => {
    const f = await spaceWithASittingResident()
    const res = await invite(f, {})
    expect(res.status).toBe(409)
  })
})

/**
 * THE TENANT ONBOARDING ROSTER — the same flow as the invite modal, different
 * screen and different endpoint, which is exactly why the 10/26 takeover group
 * reached one and not the other.
 */
describe('Tenant Onboarding roster, onto an occupied space', () => {
  const onboard = (f: any, body: Record<string, unknown>) =>
    request(buildApp())
      .post('/api/landlords/me/onboard-new-lease-tenant')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        unitId: f.unitId,
        people: [{ firstName: 'New', lastName: 'Resident', email: f.takingOverEmail, phone: null }],
        ...body,
      })

  it('takes the space over, naming the tenancy it replaces', async () => {
    const f = await spaceWithASittingResident()
    const res = await onboard(f, { takeover: true })
    expect(res.status).toBeLessThan(300)
    const docs = (await db.query<any>(
      `SELECT replaces_lease_id FROM lease_documents
        WHERE unit_id = $1 AND document_type = 'original_lease'`, [f.unitId])).rows
    expect(docs.some(d => d.replaces_lease_id === f.sittingLeaseId)).toBe(true)
  })

  it('refuses an ordinary placement onto an occupied space', async () => {
    const f = await spaceWithASittingResident()
    const res = await onboard(f, {})
    expect(res.status).toBe(409)
  })
})
