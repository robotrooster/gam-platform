// ─────────────────────────────────────────────────────────────
// 10/20 — THE DOOR NIC ASKED FOR: A DOCUMENT SENT FROM THE RESIDENT'S FILE
// ─────────────────────────────────────────────────────────────
//
// Blu built a work-trade form for Mattoon with a landlord box and a tenant box,
// added the document, and could not get it signed. Nic, on how he expected it
// to work: "can he just go into Curtis's file, add a template that way, and
// have it signed to him? Like, there's some sort of broken flow there that we
// need to get fixed."
//
// So the resident's page fills the seats itself — the resident is the Primary
// Tenant, whoever signs for the landlord is the Landlord, the rest of their
// household takes the co-tenant boxes. Nobody has to know what a signer role
// is, which is the entire point: knowing was the old price of getting a
// document signed.
//
// The other half of the rule (D9, 10/20): a box OFFERED must be a box somebody
// can be put in. A form with a witness box cannot be filled from a resident's
// page, so it is not offered there — it says so, and names the screen that can
// send it. The silent bind-to-nobody is what cost Blu his evening.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'
import { householdSignerRows, planResidentSeats } from '../services/signerSeats'
import { computeActionGap } from '../services/agents/actionGap'
import { printedUnitNumber } from '@gam/shared'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_resident_page_signing'
})

/** A box on a form, bound to the role whose signature or value fills it. */
type Box = { role: string; column?: string }

interface Fixture {
  landlordId: string
  landlordUserId: string
  landlordEmail: string
  propertyId: string
  unitId: string
  unitNumber: string
  leaseId: string
  resident: { tenantId: string; userId: string; email: string }
  coResident: { tenantId: string; userId: string; email: string } | null
  token: string
}

/**
 * Blu's park: his login, a space, a lease, Curtis on it — and optionally a
 * second resident in the household, which is where the lease's own word for a
 * co-tenant ('co_tenant') used to reach the document builder as a role no form
 * can carry.
 */
async function seedMattoon(opts: { coResident?: boolean } = {}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const landlordEmail = (await c.query<{ email: string }>(
      'SELECT email FROM users WHERE id=$1', [landlordUserId])).rows[0].email
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const unitNumber = (await c.query<{ unit_number: string }>(
      'SELECT unit_number FROM units WHERE id=$1', [unitId])).rows[0].unit_number
    const leaseId = await seedLease(c, { unitId, landlordId })

    const person = async (first: string) => {
      const tenantId = await seedTenant(c)
      const row = (await c.query<{ user_id: string; email: string }>(
        `UPDATE users SET first_name=$2 FROM tenants t
          WHERE t.id=$1 AND users.id=t.user_id
          RETURNING users.id AS user_id, users.email`, [tenantId, first])).rows[0]
      return { tenantId, userId: row.user_id, email: row.email }
    }
    const resident = await person('Curtis')
    await seedLeaseTenant(c, { leaseId, tenantId: resident.tenantId, role: 'primary' })
    let coResident: Fixture['coResident'] = null
    if (opts.coResident) {
      coResident = await person('Dana')
      await seedLeaseTenant(c, { leaseId, tenantId: coResident.tenantId, role: 'co_tenant' })
    }
    await c.query('COMMIT')

    const token = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: landlordEmail,
        profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, landlordUserId, landlordEmail, propertyId, unitId, unitNumber,
             leaseId, resident, coResident, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** One of the landlord's own forms, with a box for each role named. */
async function seedForm(
  landlordId: string,
  opts: { name?: string; purpose?: string; boxes: Box[]; pdf?: boolean } = { boxes: [] },
): Promise<string> {
  const c = await db.connect()
  try {
    const templateId = (await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active, purpose)
       VALUES ($1,$2,$3,TRUE,$4) RETURNING id`,
      [landlordId, opts.name ?? 'Mattoon Work Trade',
       opts.pdf === false ? null : '/uploads/work-trade.pdf', opts.purpose ?? 'work_trade_addendum'])).rows[0].id
    for (const [i, box] of opts.boxes.entries()) {
      await c.query(
        `INSERT INTO lease_template_fields
           (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
         VALUES ($1,$2,$3,$4,$5,1,40,$6,160,28,TRUE)`,
        [templateId, box.column ? 'text' : 'signature', box.role,
         box.column ?? `${box.role} signature`, box.column ?? null, 120 * i + 400])
    }
    return templateId
  } finally { c.release() }
}

const signerToken = (userId: string, role: string, email: string) =>
  jwt.sign({ userId, role, email, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })

const forms = (f: Fixture) => request(buildApp())
  .get(`/api/esign/resident-forms/${f.resident.tenantId}`)
  .set('Authorization', `Bearer ${f.token}`)

const raise = (f: Fixture, templateId: string, body: any = {}) => request(buildApp())
  .post('/api/esign/resident-documents')
  .set('Authorization', `Bearer ${f.token}`)
  .send({ tenantId: f.resident.tenantId, templateId, ...body })

const docFields = (docId: string) => db.query<any>(
  `SELECT id, signer_role, signer_id, lease_column, value FROM lease_document_fields
    WHERE document_id=$1 ORDER BY signer_role, lease_column NULLS FIRST`, [docId]).then(r => r.rows)

describe("a document raised from the resident's own page", () => {
  it("fills the seats itself and both parties sign it through — Blu's form, end to end", async () => {
    const f = await seedMattoon()
    // The form he built: his signature, Curtis's signature, and the space's
    // number printed on it.
    const templateId = await seedForm(f.landlordId, {
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'landlord', column: 'unit_number' }],
    })
    const app = buildApp()

    // 1. His own page says what will happen before he presses anything.
    const list = await forms(f)
    expect(list.status).toBe(200)
    expect(list.body.data.resident.name).toBe('Curtis Tenant')
    const offered = list.body.data.forms.find((x: any) => x.id === templateId)
    expect(offered.sendable).toBe(true)
    expect(offered.reason).toBeNull()
    // Who signs, in plain words, with nobody having picked a role.
    expect(offered.willSign.map((s: any) => [s.label, s.name])).toEqual([
      ['Landlord', 'Test Landlord'],
      ['Primary Tenant', 'Curtis Tenant'],
    ])
    expect(offered.leftOff).toEqual([])
    expect(offered.suggestedTitle).toContain('Curtis Tenant')

    // 2. He presses send.
    const created = await raise(f, templateId)
    expect(created.status, created.body?.error || '').toBe(201)
    const docId = created.body.data.id

    // Every box belongs to a person. A null signer_id is the silent failure.
    const fields = await docFields(docId)
    expect(fields.filter(r => r.signer_role === 'landlord').length).toBe(2)
    expect(fields.filter(r => r.signer_role === 'primary').length).toBe(1)
    for (const row of fields) expect(row.signer_id, `${row.signer_role} box bound to nobody`).not.toBeNull()
    // The space came along, so the form's own unit box comes out filled — with
    // what GAM prints for that space (S632: the form already says "Lot #").
    expect(fields.find(r => r.lease_column === 'unit_number')?.value)
      .toBe(printedUnitNumber(null, f.unitNumber))

    const doc = await db.query<any>(
      `SELECT document_type, unit_id, lease_id, title FROM lease_documents WHERE id=$1`,
      [docId]).then(r => r.rows[0])
    expect(doc.document_type).toBe('general_contract')
    expect(doc.unit_id).toBe(f.unitId)
    // It is its own instrument: it makes no lease and changes no tenancy.
    expect(doc.lease_id).toBeNull()

    // 3. Sending it mails each of them their link. This is the step that used
    // to refuse a document carrying a SPACE as a double-booking of that space.
    const sent = await request(app).post(`/api/esign/documents/${docId}/send`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(sent.status, sent.body?.error || '').toBe(200)

    // 4. Both signatures, landlord first.
    const mine = (await docFields(docId)).filter(r => r.signer_role === 'landlord')
    const llSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: mine.map(r => ({
        fieldId: r.id, value: r.lease_column ? printedUnitNumber(null, f.unitNumber) : 'Test Landlord' })) })
    expect(llSigned.status, llSigned.body?.error || '').toBe(200)
    expect(llSigned.body.data.completed).toBeFalsy()

    const theirs = (await docFields(docId)).filter(r => r.signer_role === 'primary')
    const tSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.resident.userId, 'tenant', f.resident.email)}`)
      .send({ fieldValues: theirs.map(r => ({ fieldId: r.id, value: 'Curtis Tenant' })) })
    expect(tSigned.status, tSigned.body?.error || '').toBe(200)
    expect(tSigned.body.data.completed).toBe(true)

    const done = await db.query<any>(
      `SELECT status, lease_id, completed_at FROM lease_documents WHERE id=$1`, [docId]).then(r => r.rows[0])
    expect(done.status).toBe('completed')
    expect(done.status).not.toBe('execution_failed')
    expect(done.lease_id).toBeNull()
    expect(done.completed_at).not.toBeNull()

    // 5. And his page shows it, so he is not left wondering whether it went.
    const after = await forms(f)
    expect(after.body.data.documents.map((d: any) => [d.title, d.status]))
      .toEqual([[doc.title, 'completed']])
  })

  it('the person whose page it is signs as the tenant even when the lease calls them a co-tenant', async () => {
    const f = await seedMattoon({ coResident: true })
    // Raise it from the SECOND resident's page: the document is theirs.
    const templateId = await seedForm(f.landlordId, { boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const created = await request(buildApp()).post('/api/esign/resident-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: f.coResident!.tenantId, templateId })
    expect(created.status, created.body?.error || '').toBe(201)
    const primary = await db.query<any>(
      `SELECT user_id FROM lease_document_signers WHERE document_id=$1 AND role='primary'`,
      [created.body.data.id]).then(r => r.rows[0])
    expect(primary.user_id).toBe(f.coResident!.userId)
  })

  it('the rest of the household takes the co-tenant boxes', async () => {
    const f = await seedMattoon({ coResident: true })
    const templateId = await seedForm(f.landlordId, {
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'co_tenant_1' }],
    })
    const list = await forms(f)
    const offered = list.body.data.forms.find((x: any) => x.id === templateId)
    expect(offered.sendable).toBe(true)
    expect(offered.willSign.map((s: any) => s.name)).toEqual(['Test Landlord', 'Curtis Tenant', 'Dana Tenant'])

    const created = await raise(f, templateId)
    expect(created.status, created.body?.error || '').toBe(201)
    const signers = await db.query<any>(
      `SELECT role, user_id, order_index FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`,
      [created.body.data.id]).then(r => r.rows)
    expect(signers.map(s => s.role)).toEqual(['landlord', 'primary', 'co_tenant_1'])
    expect(signers[2].user_id).toBe(f.coResident!.userId)
    for (const row of await docFields(created.body.data.id)) expect(row.signer_id).not.toBeNull()
  })

  it('says which box is left off when the household does not fill it', async () => {
    const f = await seedMattoon()
    const templateId = await seedForm(f.landlordId, {
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'co_tenant_1' }],
    })
    const offered = (await forms(f)).body.data.forms.find((x: any) => x.id === templateId)
    // Curtis lives alone, so the second resident's box has nobody — said out
    // loud, rather than pruned in silence the way Blu's whole form was.
    expect(offered.sendable).toBe(true)
    expect(offered.leftOff).toEqual([{ role: 'co_tenant_1', label: 'Co-Tenant 1' }])

    const created = await raise(f, templateId)
    expect(created.status).toBe(201)
    expect(created.body.data.leftOff).toEqual([{ role: 'co_tenant_1', label: 'Co-Tenant 1' }])
    const fields = await docFields(created.body.data.id)
    expect(fields.map(r => r.signer_role)).toEqual(['landlord', 'primary'])
  })

  // D9: a role offered must be a role that can be assigned — at every door.
  it('does not offer a form whose witness box nobody here can fill, and refuses it', async () => {
    const f = await seedMattoon()
    const templateId = await seedForm(f.landlordId, {
      name: 'Bill of sale', purpose: 'other',
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'witness' }],
    })
    const offered = (await forms(f)).body.data.forms.find((x: any) => x.id === templateId)
    expect(offered.sendable).toBe(false)
    expect(offered.reason).toContain('Witness')
    expect(offered.reason).toContain('New Contract')

    // And the server says the same sentence to anything that asks anyway.
    const refused = await raise(f, templateId)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe(offered.reason)
    expect(await db.query(`SELECT 1 FROM lease_documents`, []).then(r => r.rowCount)).toBe(0)
  })

  // A form whose signature has to CHANGE A LEASE goes out from the door that
  // also does the billing. Signed paper GAM would not act on is worse than no
  // door: the lease is law, and it would say one thing while the bill said
  // another.
  it('offers no lease, no addendum and no installment sale contract from a resident page', async () => {
    const f = await seedMattoon()
    const leaseForm = await seedForm(f.landlordId, {
      name: 'Oak Park lease', purpose: 'lease', boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const saleForm = await seedForm(f.landlordId, {
      name: 'Rent to own', purpose: 'installment_sale', boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const addendumForm = await seedForm(f.landlordId, {
      name: 'Rent change addendum', purpose: 'addendum', boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const offered = (await forms(f)).body.data.forms.map((x: any) => x.id)
    expect(offered).not.toContain(leaseForm)
    expect(offered).not.toContain(saleForm)
    expect(offered).not.toContain(addendumForm)

    const lease = await raise(f, leaseForm)
    expect(lease.status).toBe(400)
    expect(lease.body.error).toContain('Leases screen')
    const sale = await raise(f, saleForm)
    expect(sale.status).toBe(400)
    expect(sale.body.error).toContain('home sale')
    const addendum = await raise(f, addendumForm)
    expect(addendum.status).toBe(400)
    expect(addendum.body.error).toContain('Leases → Change')
  })

  // A landlord box with nobody in it is the defect this whole lane is about, so
  // it refuses rather than leaving that box off a signed agreement. Checked on
  // the seat plan itself: a company always has an owner login behind it
  // (landlords.user_id is NOT NULL), so the database cannot produce this state
  // — and the rule should not depend on that staying true.
  it('refuses, never prunes, when nobody can be put in the landlord box', () => {
    const plan = planResidentSeats(['landlord', 'primary'], {
      tenantId: 't1', residentName: 'Curtis Tenant', residentEmail: 'c@t.dev',
      unitId: null, unitLabel: null, propertyName: null,
      seats: new Map([['primary', { userId: 'u1', name: 'Curtis Tenant', email: 'c@t.dev', phone: null }]]),
    })
    expect(plan.sendable).toBe(false)
    expect(plan.reason).toContain('who signs for the landlord')
    expect(plan.leftOff).toEqual([])
  })

  it('says so when the form has no signature boxes yet', async () => {
    const f = await seedMattoon()
    const templateId = await seedForm(f.landlordId, { boxes: [] })
    const offered = (await forms(f)).body.data.forms.find((x: any) => x.id === templateId)
    expect(offered.sendable).toBe(false)
    expect(offered.reason).toContain('no signature boxes')
    expect((await raise(f, templateId)).status).toBe(400)
  })

  it("never opens another company's resident, or another company's form", async () => {
    const f = await seedMattoon()
    const other = await seedMattoon()
    expect((await request(buildApp())
      .get(`/api/esign/resident-forms/${other.resident.tenantId}`)
      .set('Authorization', `Bearer ${f.token}`)).status).toBe(404)

    const mine = await seedForm(f.landlordId, { boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const stranger = await request(buildApp()).post('/api/esign/resident-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ tenantId: other.resident.tenantId, templateId: mine })
    expect(stranger.status).toBe(404)

    const theirForm = await seedForm(other.landlordId, { boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    expect((await raise(f, theirForm)).status).toBe(404)
    expect(await db.query(`SELECT 1 FROM lease_documents`, []).then(r => r.rowCount)).toBe(0)
  })

  // The space on the document is why this one matters: the occupancy check
  // reads a document with a unit and a start date as a lease being written on
  // that space, and the resident already lives there. Unguarded, the landlord's
  // own signature on his own agreement came back "Cannot sign: ... would
  // double-book" about the tenancy the agreement is FOR.
  it('signs a form that has its own start-date box on it', async () => {
    const f = await seedMattoon()
    const templateId = await seedForm(f.landlordId, {
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'landlord', column: 'start_date' }],
    })
    const app = buildApp()
    const created = await raise(f, templateId)
    expect(created.status, created.body?.error || '').toBe(201)
    const docId = created.body.data.id
    expect((await request(app).post(`/api/esign/documents/${docId}/send`)
      .set('Authorization', `Bearer ${f.token}`).send({})).status).toBe(200)

    const mine = (await docFields(docId)).filter(r => r.signer_role === 'landlord')
    const signed = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: mine.map(r => ({
        fieldId: r.id, value: r.lease_column === 'start_date' ? '11/01/2026' : 'Test Landlord' })) })
    expect(signed.status, signed.body?.error || '').toBe(200)
    // And the date he typed is on the paper.
    expect((await docFields(docId)).find(r => r.lease_column === 'start_date')?.value).toBe('11/01/2026')
  })

  it('sends for a resident who has no lease at all — the paper needs none', async () => {
    const f = await seedMattoon()
    await db.query(`UPDATE lease_tenants SET status='removed' WHERE tenant_id=$1`, [f.resident.tenantId])
    // Still this company's: the invite they came in on.
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1,$2,'not_uploaded')`,
      [f.landlordId, f.resident.tenantId])
    const templateId = await seedForm(f.landlordId, { boxes: [{ role: 'landlord' }, { role: 'primary' }] })
    const offered = (await forms(f)).body.data.forms.find((x: any) => x.id === templateId)
    expect(offered.sendable).toBe(true)
    const created = await raise(f, templateId)
    expect(created.status, created.body?.error || '').toBe(201)
    const doc = await db.query<any>(
      `SELECT unit_id, lease_id FROM lease_documents WHERE id=$1`, [created.body.data.id]).then(r => r.rows[0])
    expect(doc.unit_id).toBeNull()
    expect(doc.lease_id).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 10/20 — THE LEASE'S WORD FOR A SECOND RESIDENT IS NOT A SIGNER ROLE
// ─────────────────────────────────────────────────────────────
//
// lease_tenants.role holds 'primary' or 'co_tenant' — two values, by its own
// CHECK constraint. A template's boxes are bound to 'primary' and
// 'co_tenant_1'..'co_tenant_3'. Three doors (the renewal, the work-trade
// addendum, and the auto-draft that follows a renewal) handed the lease's word
// straight to the document builder, so the SECOND resident on a lease arrived
// as 'co_tenant' — a role no form can carry. Before the S652 unknown-role
// guard every co-tenant box was pruned in silence; since it, the build refuses
// with a 500 nobody can act on. 23 live leases have a co-tenant.
describe('a household with a co-tenant', () => {
  it('maps a lease roster onto the boxes a form actually has', () => {
    const roster = [
      { user_id: 'u1', first_name: 'Curtis', last_name: 'Tenant', email: 'c@t.dev' },
      { user_id: 'u2', first_name: 'Dana', last_name: 'Tenant', email: 'd@t.dev' },
      { user_id: 'u3', first_name: 'Eve', last_name: 'Tenant', email: 'e@t.dev' },
      { user_id: 'u4', first_name: 'Finn', last_name: 'Tenant', email: 'f@t.dev' },
    ]
    expect(householdSignerRows(roster, { startOrderIndex: 2 }).map(s => [s.role, s.orderIndex])).toEqual([
      ['primary', 2], ['co_tenant_1', 3], ['co_tenant_2', 4], ['co_tenant_3', 5],
    ])
    // A fifth resident has no box to sign. Said in words the landlord can act
    // on, rather than reaching the builder as 'co_tenant_4'.
    expect(() => householdSignerRows([...roster,
      { user_id: 'u5', first_name: 'Gus', last_name: 'Tenant', email: 'g@t.dev' }]))
      .toThrow(/Gus Tenant/)
  })

  it('sends its work-trade addendum — the second resident used to kill the whole document', async () => {
    const f = await seedMattoon({ coResident: true })
    const templateId = await seedForm(f.landlordId, {
      purpose: 'work_trade_addendum',
      boxes: [{ role: 'landlord' }, { role: 'primary' }, { role: 'co_tenant_1' }],
    })
    const agreementId = (await db.query<{ id: string }>(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status)
       VALUES ($1,$2,$3,CURRENT_DATE,'active') RETURNING id`,
      [f.unitId, f.resident.tenantId, f.landlordId])).rows[0].id

    const created = await request(buildApp()).post('/api/esign/documents/work-trade-addendum')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ workTradeAgreementId: agreementId, templateId })
    // Without the mapping: 500 — 'Cannot build this document: signer role
    // "co_tenant" matches no box on any form.'
    expect(created.status, created.body?.error || '').toBe(201)
    const signers = await db.query<any>(
      `SELECT role, user_id FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`,
      [created.body.data.id]).then(r => r.rows)
    expect(signers.map(s => s.role)).toEqual(['landlord', 'primary', 'co_tenant_1'])
    expect(signers[2].user_id).toBe(f.coResident!.userId)
    // And every box on the form belongs to one of them — none pruned.
    const fields = await docFields(created.body.data.id)
    expect(fields.map(r => r.signer_role)).toEqual(['co_tenant_1', 'landlord', 'primary'])
    for (const row of fields) expect(row.signer_id).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 10/20 — AN ACCOUNT WITH TWO COMPANIES, ON THE SEND FORM
// ─────────────────────────────────────────────────────────────
//
// The send form asks who is on the lease (GET /esign/recipients), and that read
// compared leases.landlord_id to the LIST of the account's companies with `=`
// instead of ANY(). Postgres accepts a one-element '{uuid}' as a uuid, so it
// worked for every landlord who owns one company and raised "invalid input
// syntax for type uuid" the moment an account owned two — and Nic's own two
// parks are two companies (S633). Nothing covered it.
describe('the people on the lease, for an account that owns two companies', () => {
  it('lists the household at the second company', async () => {
    const first = await seedMattoon()
    const second = await seedMattoon()
    const token = jwt.sign(
      { userId: first.landlordUserId, role: 'landlord', email: first.landlordEmail,
        profileId: first.landlordId, landlordIds: [first.landlordId, second.landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const res = await request(buildApp())
      .get(`/api/esign/recipients?propertyId=${second.propertyId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status, res.body?.error || '').toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].tenants.map((t: any) => t.userId)).toEqual([second.resident.userId])
    // And the other park's lease is not in this property's list.
    const mine = await request(buildApp())
      .get(`/api/esign/recipients?unitId=${first.unitId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data[0].tenants.map((t: any) => t.userId)).toEqual([first.resident.userId])
  })
})

// ───────────────────────────────────────────────────────────
// 10/20 — THIS LANE HOLDS ITS OWN PARITY DECISION
// ───────────────────────────────────────────────────────────
//
// The standing rule since S628: every mutating endpoint is either something the
// assistant can reach or is NAMED with the reason it is not, and
// services/agents/actionGap.test.ts goes red the moment one is neither. This
// lane's POST /resident-documents went in as neither — "I did not think about
// it", which is the one state that test exists to make impossible.
//
// The gate working is not the same as somebody holding it. Another lane saw the
// red and reported it as "not from this lane"; this lane, which owns the route,
// did not mention it at all, so the decision had no owner. That is the root
// cause, and this is the fix for it: the gate now sits in the file about the
// route, so the next door opened on a resident's page fails HERE, in front of
// whoever is adding it, instead of in somebody else's suite.
describe('every door this lane opens on a resident\'s page carries a parity decision', () => {
  /** METHOD + path for each mutating /resident-* route esign.ts declares. */
  const laneDoors = (): string[] => {
    const src = readFileSync(join(__dirname, 'esign.ts'), 'utf8')
    return [...src.matchAll(/^\s*esignRouter\.(post|patch|put|delete)\(\s*'(\/resident-[^']*)'/gm)]
      .map(m => `${m[1].toUpperCase()} ${m[2]}`)
  }

  it('finds the doors — otherwise this test is guarding nothing', () => {
    // A renamed route or a changed router variable would empty the scan, and an
    // empty list passes every assertion below without reading anything.
    expect(laneDoors()).toContain('POST /resident-documents')
  })

  it('each is reachable by the assistant, or named with the reason it is not', () => {
    const open = new Set(computeActionGap().open
      .filter(e => e.area === 'esign')
      .map(e => e.declared))
    const undecided = laneDoors().filter(d => open.has(d))
    expect(undecided, undecided.length
      ? `\nThis lane opened ${undecided.join(', ')} and decided nothing about it. Either give ` +
        'it an action in services/agents/portalActions.ts, or name it in DELIBERATE in ' +
        'services/agents/actionGap.ts with why it is not one — and say which in the report.\n'
      : '').toEqual([])
  })

  it('and where the answer is "a person presses this", the reason is one somebody can act on', () => {
    const doors = new Set(laneDoors())
    const named = computeActionGap().deliberate
      .filter(e => e.area === 'esign' && doors.has(e.declared))
    for (const e of named) {
      // Not "no" and not "n/a". A later session has to be able to tell a
      // decision from an oversight without re-deriving it.
      expect(e.why.length, `${e.declared}: "${e.why}"`).toBeGreaterThan(80)
    }
  })
})
