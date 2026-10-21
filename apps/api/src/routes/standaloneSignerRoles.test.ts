// 10/20 — THE SIGNER ROLE A LANDLORD CAN PLACE MUST BE ONE THEY CAN FILL.
//
// Blu built a work-trade form for his Mattoon property with a landlord box and
// a tenant box, added the document, and could not get it signed. Nic: "On the
// signing page, it only wants to let him pick either buyer or seller or...
// person one or person two. It wouldn't let the data box be targeted to
// landlord and tenant... you can't just have that be person one and person two
// when it needs to be, you know, if it's a tenant, it needs to be able to be
// signed by the tenant."
//
// The engine was never the problem. Three separate lists of roles were: what
// the field editor offered, what the New Contract signer picker offered, and
// what the document builder accepted. Only the picker was short, so a landlord
// box could be placed and then assigned to nobody — and a field whose role
// matches no signer is PRUNED, without a word, on a document that goes out
// looking finished.
//
// Two suites here. The first holds the lists together so they cannot drift
// apart again. The second is Blu's document, start to finish: a landlord field
// and a resident field, a real landlord and a real resident, both signatures.
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'
import { esignRouter, KNOWN_SIGNER_ROLES, landlordSignsFirst } from './esign'
import { errorHandler } from '../middleware/errorHandler'
import { NOT_A_RESIDENT_ACCOUNT } from '../jobs/leaseParser/resolveIntent'
import {
  DOCUMENT_SIGNER_ROLES, DOCUMENT_SIGNER_ROLE_LABEL, LEASE_DOCUMENT_TYPES,
  LEASE_SIGNER_ROLES, STANDALONE_DOCUMENT_TYPES, isAssignableSignerRole, isValidSignerRole,
} from '@gam/shared'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

const ESIGN_PAGE = path.resolve(__dirname, '../../../landlord/src/pages/ESignPage.tsx')

describe('signer roles — one vocabulary', () => {
  // THE TEST THAT WOULD HAVE CAUGHT BLU'S DOCUMENT. Every role on offer must be
  // a role the builder can bind a field to; anything else binds to nobody.
  it('every role the landlord can be offered is a role the builder accepts', () => {
    for (const role of DOCUMENT_SIGNER_ROLES) {
      expect(KNOWN_SIGNER_ROLES.has(role), `builder would prune every "${role}" field`).toBe(true)
    }
    // And nothing the builder accepts is hidden from the landlord — the other
    // direction, which is the half that actually broke.
    expect([...KNOWN_SIGNER_ROLES].sort()).toEqual([...DOCUMENT_SIGNER_ROLES].sort())
  })

  it('offers the landlord and the residents up to co-tenant 3', () => {
    // Nic: "any data field that can be picked in the regular template flow for
    // leases up to co tenant 3 etc. there should be uniformity."
    for (const role of ['landlord', 'primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3']) {
      expect(DOCUMENT_SIGNER_ROLES as readonly string[]).toContain(role)
      expect(LEASE_SIGNER_ROLES as readonly string[]).toContain(role)
    }
  })

  it('every offered role has a label and passes both role checks', () => {
    for (const role of DOCUMENT_SIGNER_ROLES) {
      // memory: gam-no-raw-enums-in-ui — never 'co_tenant_1' on screen.
      expect(DOCUMENT_SIGNER_ROLE_LABEL[role], role).toBeTruthy()
      expect(DOCUMENT_SIGNER_ROLE_LABEL[role]).not.toContain('_')
      expect(isAssignableSignerRole(role)).toBe(true)
      expect(isValidSignerRole(role)).toBe(true)
    }
    expect(new Set(DOCUMENT_SIGNER_ROLES).size).toBe(DOCUMENT_SIGNER_ROLES.length)
  })

  // The landlord's page must not keep a private copy of the vocabulary. This is
  // how the three lists drifted in the first place, so it is checked at the
  // source rather than trusted.
  it('the landlord page reads the shared list instead of writing its own', () => {
    const src = fs.readFileSync(ESIGN_PAGE, 'utf8')
    expect(src).toContain('DOCUMENT_SIGNER_ROLES')
    expect(src).toContain('DOCUMENT_SIGNER_ROLE_LABEL')
    // A hand-written LIST of role strings means somebody started a second
    // vocabulary again. Braces are excluded so a single signer object —
    // { role: 'landlord', name, email } — is not mistaken for one; those are
    // one person being named, not a list of what may be offered. Checked
    // against the 10/20 file: this catches the list Blu's bug came from and
    // nothing else in the page.
    const literals = src.match(
      /\[[^\[\]{}]*\x27(?:landlord|primary|co_tenant_[123]|seller|purchaser|party_[12]|witness)\x27[^\[\]{}]*\]/g) || []
    expect(literals, `hand-written signer role list(s): ${literals.join(' | ')}`).toEqual([])
  })
})

describe('a work-trade agreement a tenant actually signs', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_signer_roles'
  })

  /** Blu's setup: his own login, a resident of his company, and his form. */
  async function seedMattoon() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      // assertLandlordSigners: the landlord seat is reached at the address on
      // its own account, never one a request carried.
      const landlordEmail = (await c.query<{ email: string }>(
        'SELECT email FROM users WHERE id=$1', [landlordUserId])).rows[0].email

      const tenantId = await seedTenant(c)
      const resident = (await c.query<{ user_id: string; email: string }>(
        `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id=$1`,
        [tenantId])).rows[0]
      // A resident goes on a company's document only once they are that
      // company's — Curtis is Blu's, by invite.
      await c.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status)
         VALUES ($1, $2, 'not_uploaded')`, [landlordId, tenantId])

      // The form Blu built: a landlord signature and a tenant signature.
      const templateId = (await c.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active, purpose)
         VALUES ($1,'Mattoon Work Trade','/uploads/work-trade.pdf',TRUE,'work_trade_addendum')
         RETURNING id`, [landlordId])).rows[0].id
      const fieldId: Record<string, string> = {}
      for (const [i, role] of ['landlord', 'primary'].entries()) {
        fieldId[role] = (await c.query<{ id: string }>(
          `INSERT INTO lease_template_fields
             (template_id, field_type, signer_role, label, page, x, y, width, height, required)
           VALUES ($1,'signature',$2,$3,1,40,$4,160,28,TRUE) RETURNING id`,
          [templateId, role, `${role} signature`, 120 * i + 400])).rows[0].id
      }
      await c.query('COMMIT')

      const token = jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: landlordEmail,
          profileId: landlordId, landlordIds: [landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { landlordId, landlordUserId, landlordEmail, resident, templateId, fieldId, token }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const signerToken = (userId: string, role: string, email: string) =>
    jwt.sign({ userId, role, email, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })

  async function createDoc(f: Awaited<ReturnType<typeof seedMattoon>>, roles: [string, string]) {
    return request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        title: 'Mattoon work-trade agreement',
        documentType: 'general_contract',
        templateId: f.templateId,
        signers: [
          { userId: f.landlordUserId, role: roles[0], name: 'Blu Landlord', email: f.landlordEmail },
          { userId: f.resident.user_id, role: roles[1], name: 'Curtis Resident', email: f.resident.email },
        ],
      })
  }

  const fieldsOf = (docId: string) => db.query<any>(
    `SELECT id, signer_role, signer_id, required FROM lease_document_fields
      WHERE document_id=$1 ORDER BY signer_role`, [docId]).then(r => r.rows)

  it('binds the landlord and tenant boxes and both parties sign it through', async () => {
    const f = await seedMattoon()
    const app = buildApp()

    const created = await createDoc(f, ['landlord', 'primary'])
    expect(created.status).toBe(200)
    const docId = created.body.data.id

    // Both boxes survived the copy AND belong to a person. A null signer_id (or
    // a missing row) is the silent failure Blu hit.
    const fields = await fieldsOf(docId)
    expect(fields.map(r => r.signer_role)).toEqual(['landlord', 'primary'])
    for (const row of fields) expect(row.signer_id, `${row.signer_role} box bound to nobody`).not.toBeNull()

    const signers = await db.query<any>(
      `SELECT id, role, user_id, order_index FROM lease_document_signers
        WHERE document_id=$1 ORDER BY order_index`, [docId]).then(r => r.rows)
    expect(signers.map(s => s.role)).toEqual(['landlord', 'primary'])
    // Each box went to the right person, not merely to someone.
    const byRole = new Map(signers.map(s => [s.role, s.id]))
    for (const row of fields) expect(row.signer_id).toBe(byRole.get(row.signer_role))

    // The landlord signs first — the tenant is refused until then (S535).
    const early = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.resident.user_id, 'tenant', f.resident.email)}`)
      .send({ fieldValues: [] })
    expect(early.status).toBe(403)

    const llField = fields.find(r => r.signer_role === 'landlord')!
    const llSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: [{ fieldId: llField.id, value: 'Blu Landlord' }] })
    expect(llSigned.status).toBe(200)
    expect(llSigned.body.data.completed).toBeFalsy()

    const tField = (await fieldsOf(docId)).find(r => r.signer_role === 'primary')!
    const tSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.resident.user_id, 'tenant', f.resident.email)}`)
      .send({ fieldValues: [{ fieldId: tField.id, value: 'Curtis Resident' }] })
    expect(tSigned.status).toBe(200)
    expect(tSigned.body.data.completed).toBe(true)

    const doc = await db.query<any>(
      `SELECT status, lease_id, completed_at FROM lease_documents WHERE id=$1`, [docId]).then(r => r.rows[0])
    expect(doc.status).toBe('completed')
    expect(doc.status).not.toBe('execution_failed')
    // A work-trade agreement is its own instrument — it materializes no lease.
    expect(doc.lease_id).toBeNull()
    expect(doc.completed_at).not.toBeNull()
    const allSigned = await db.query<any>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1`, [docId]).then(r => r.rows)
    expect(allSigned.every(s => s.status === 'signed')).toBe(true)
  })

  // ── 10/20, THE OTHER HALF OF BLU'S FORM: HE PUT CURTIS ON ROW ONE ──────
  //
  // New Contract gives every signer row its own role select and no way to
  // reorder the rows, and the create route numbers them as they arrive. So
  // "resident first, me second" is an ordinary thing for a landlord to type,
  // and until now it produced a contract NEITHER party could ever sign: send
  // skips the landlord-first ordering check on a standalone document (S568 —
  // the creator's order governs), while the sign submit and the signing page
  // enforced "no tenant before the landlord" on every document type there is.
  // Curtis was told the landlord signs first; Blu was told it was not his turn;
  // the signing page pointed each of them at the other. No endpoint reorders a
  // sent document's signers, so the only way out was to void it and start
  // again, and nothing on either screen said why.
  //
  // Without landlordSignsFirst() in all three gates, the three expectations
  // below fail in that exact order: waitingOn says 'the landlord' with the page
  // read-only, Curtis's submit is a 403 "The landlord signs first", and Blu's
  // is a 403 "Not your turn to sign yet".
  it('honors the order the landlord typed — the resident signs, then the landlord', async () => {
    const f = await seedMattoon()
    const app = buildApp()

    const created = await request(app).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        title: 'Mattoon work-trade agreement',
        documentType: 'general_contract',
        templateId: f.templateId,
        signers: [
          { userId: f.resident.user_id, role: 'primary', name: 'Curtis Resident', email: f.resident.email },
          { userId: f.landlordUserId, role: 'landlord', name: 'Blu Landlord', email: f.landlordEmail },
        ],
      })
    expect(created.status).toBe(200)
    const docId = created.body.data.id

    // Row order is signing order — the modal sends no orderIndex of its own.
    const signers = await db.query<any>(
      `SELECT role, order_index FROM lease_document_signers
        WHERE document_id=$1 ORDER BY order_index`, [docId]).then(r => r.rows)
    expect(signers.map(s => [s.role, s.order_index])).toEqual([['primary', 1], ['landlord', 2]])

    // Send has always accepted this document and mailed row one.
    const sent = await request(app).post(`/api/esign/documents/${docId}/send`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(sent.status).toBe(200)

    // Curtis's page is his to fill, not a please-wait. This is where he was
    // told to wait for the landlord who was being told to wait for him.
    const curtisAuth = signerToken(f.resident.user_id, 'tenant', f.resident.email)
    const page = await request(app).get(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${curtisAuth}`)
    expect(page.status).toBe(200)
    expect(page.body.data.waitingOn).toBeNull()
    expect(page.body.data.readOnly).toBe(false)

    const tField = (await fieldsOf(docId)).find(r => r.signer_role === 'primary')!
    const tSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${curtisAuth}`)
      .send({ fieldValues: [{ fieldId: tField.id, value: 'Curtis Resident' }] })
    expect(tSigned.status).toBe(200)
    expect(tSigned.body.data.completed).toBeFalsy()

    const llField = (await fieldsOf(docId)).find(r => r.signer_role === 'landlord')!
    const llSigned = await request(app).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${signerToken(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: [{ fieldId: llField.id, value: 'Blu Landlord' }] })
    expect(llSigned.status).toBe(200)
    expect(llSigned.body.data.completed).toBe(true)

    const doc = await db.query<any>(
      `SELECT status, lease_id FROM lease_documents WHERE id=$1`, [docId]).then(r => r.rows[0])
    expect(doc.status).toBe('completed')
    expect(doc.lease_id).toBeNull()
  })

  // And the rule the gate came from is exactly as strict as it was. A LEASE
  // locks its terms with the landlord's signature before any resident accepts
  // them (S28 → S535), so every document type that carries lease values keeps
  // landlord-first — including the work-trade addendum that rides a lease send.
  // Only the three standalone contract types let their creator set the order.
  it('keeps landlord-first on every document that carries lease terms', () => {
    for (const t of LEASE_DOCUMENT_TYPES) {
      const standalone = (STANDALONE_DOCUMENT_TYPES as readonly string[]).includes(t)
      expect(landlordSignsFirst(t), t).toBe(!standalone)
    }
    expect(landlordSignsFirst('original_lease')).toBe(true)
    expect(landlordSignsFirst('work_trade_addendum')).toBe(true)
    // A type nobody recognizes gets the rule, not the exemption.
    expect(landlordSignsFirst(null)).toBe(true)
    expect(landlordSignsFirst('')).toBe(true)
  })

  // The defect itself, pinned: the roles the old picker offered were the five
  // generic ones, so Blu's landlord and tenant boxes matched no signer and were
  // dropped. Nothing errored. The document was simply unsignable.
  it('the old five-role picker would have dropped both of his boxes', async () => {
    const f = await seedMattoon()
    const created = await createDoc(f, ['seller', 'purchaser'])
    expect(created.status).toBe(200)
    expect(await fieldsOf(created.body.data.id)).toEqual([])
  })
})

// ── 10/20: THE SAME MODAL'S DEFAULT TYPE, AND A SALE THAT IS NOT ONE ────────
//
// Offering the landlord role has an edge the suite above does not walk. The
// New Contract modal opens on 'Purchase agreement', and a landlord who leaves
// that default and puts himself on his own paper could not sign it: the sign
// route read the document TYPE alone and ran the installment-sale gate, so his
// signature came back "The installment contract needs the number of payments"
// — a financed-home-sale sentence, on a contract with no sale boxes and no
// home — and the whole signature rolled back with it. Nothing on the page
// changes a document's type afterward, so his only way out was to void it and
// write it again.
//
// A financed sale is the sale of a UNIT: the home-sale setup and the packet
// both attach one, and a standalone document is attached to none. Both halves
// are pinned here — the refusal before the signature, and the critical
// "terms did not record" alarm after it when the template does carry sale
// boxes (a sale on no unit cannot record, and never needed to).
describe('a purchase agreement that is nobody\'s home sale', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_signer_roles'
  })

  /**
   * His own login, a resident of his company, and a contract template. With
   * `saleBoxes` the template carries the sale_* boxes a purchase-agreement
   * form may well have on it, filled in the way he would fill them.
   */
  async function seedContract(saleBoxes: boolean) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const landlordEmail = (await c.query<{ email: string }>(
        'SELECT email FROM users WHERE id=$1', [landlordUserId])).rows[0].email
      const tenantId = await seedTenant(c)
      const resident = (await c.query<{ user_id: string; email: string }>(
        `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id=$1`,
        [tenantId])).rows[0]
      await c.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status)
         VALUES ($1, $2, 'not_uploaded')`, [landlordId, tenantId])

      const templateId = (await c.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active, purpose)
         VALUES ($1,'Hand-written purchase agreement','/uploads/contract.pdf',TRUE,'other')
         RETURNING id`, [landlordId])).rows[0].id
      for (const [i, role] of ['landlord', 'primary'].entries()) {
        await c.query(
          `INSERT INTO lease_template_fields
             (template_id, field_type, signer_role, label, page, x, y, width, height, required)
           VALUES ($1,'signature',$2,$3,1,40,$4,160,28,TRUE)`,
          [templateId, role, `${role} signature`, 120 * i + 400])
      }
      if (saleBoxes) {
        for (const [col, label] of [['sale_monthly_payment', 'Monthly payment'],
                                    ['sale_term_months', 'Number of payments']]) {
          await c.query(
            `INSERT INTO lease_template_fields
               (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
             VALUES ($1,'text','landlord',$2,$3,1,40,200,160,28,TRUE)`,
            [templateId, label, col])
        }
      }
      await c.query('COMMIT')

      const token = jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: landlordEmail,
          profileId: landlordId, landlordIds: [landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { landlordId, landlordUserId, landlordEmail, resident, templateId, token }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const tokenFor = (userId: string, role: string, email: string) =>
    jwt.sign({ userId, role, email, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })

  /** The modal's default type, with himself on it — what he actually did. */
  async function createPurchaseAgreement(f: Awaited<ReturnType<typeof seedContract>>) {
    const created = await request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        title: 'Purchase agreement',
        documentType: 'purchase_agreement',
        templateId: f.templateId,
        signers: [
          { userId: f.landlordUserId, role: 'landlord', name: 'Blu Landlord', email: f.landlordEmail },
          { userId: f.resident.user_id, role: 'primary', name: 'Curtis Resident', email: f.resident.email },
        ],
      })
    expect(created.status).toBe(200)
    // A standalone document is bound to no unit — which is the whole point.
    const row = await db.query<any>(
      `SELECT unit_id, document_type FROM lease_documents WHERE id=$1`,
      [created.body.data.id]).then(r => r.rows[0])
    expect(row.unit_id).toBeNull()
    expect(row.document_type).toBe('purchase_agreement')
    return created.body.data.id as string
  }

  const myFields = (docId: string, role: string) => db.query<any>(
    `SELECT id, lease_column FROM lease_document_fields
      WHERE document_id=$1 AND signer_role=$2`, [docId, role]).then(r => r.rows)

  const homeSaleAlarms = () => db.query<any>(
    `SELECT category, title FROM admin_notifications WHERE category LIKE 'home_sale%'`, [])
    .then(r => r.rows)

  it('he signs his own plain purchase agreement', async () => {
    const f = await seedContract(false)
    const docId = await createPurchaseAgreement(f)
    const mine = await myFields(docId, 'landlord')

    const signed = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${tokenFor(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: mine.map(r => ({ fieldId: r.id, value: 'Blu Landlord' })) })
    // Without the fix: 400 "The installment contract needs the number of
    // payments." on a document that has nothing to do with a financed sale.
    expect(signed.status, signed.body?.error || '').toBe(200)

    // And the signature is on the paper — the refusal threw before the write,
    // outside any catch, so the whole pass rolled back with it.
    const me = await db.query<any>(
      `SELECT status, signed_at FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`,
      [docId]).then(r => r.rows[0])
    expect(me.status).toBe('signed')
    expect(me.signed_at).not.toBeNull()
    expect(await homeSaleAlarms()).toEqual([])
    expect(await db.query(`SELECT 1 FROM home_sale_contracts`, []).then(r => r.rowCount)).toBe(0)
  })

  it('sale boxes on a document with no unit raise no alarm and no sale', async () => {
    const f = await seedContract(true)
    const docId = await createPurchaseAgreement(f)
    const mine = await myFields(docId, 'landlord')
    const typed: Record<string, string> = {
      sale_monthly_payment: '350.00', sale_term_months: '24',
    }

    const signed = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${tokenFor(f.landlordUserId, 'landlord', f.landlordEmail)}`)
      .send({ fieldValues: mine.map(r => ({
        fieldId: r.id, value: r.lease_column ? typed[r.lease_column] : 'Blu Landlord' })) })
    expect(signed.status, signed.body?.error || '').toBe(200)

    // Without the fix: a critical home_sale_terms_failed every time anybody
    // signs one of these, because the sale cannot record on no unit.
    expect(await homeSaleAlarms()).toEqual([])

    // The resident signs too, and it completes as paper: no sale, no alarm.
    const theirs = await myFields(docId, 'primary')
    const done = await request(buildApp()).post(`/api/esign/sign/${docId}`)
      .set('Authorization', `Bearer ${tokenFor(f.resident.user_id, 'tenant', f.resident.email)}`)
      .send({ fieldValues: theirs.map(r => ({ fieldId: r.id, value: 'Curtis Resident' })) })
    expect(done.status, done.body?.error || '').toBe(200)
    expect(done.body.data.completed).toBe(true)
    expect(await homeSaleAlarms()).toEqual([])
    expect(await db.query(`SELECT 1 FROM home_sale_contracts`, []).then(r => r.rowCount)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// 10/20 — THE PATH THE SCREEN ACTUALLY TAKES: A NAME, AN EMAIL, A ROLE.
//
// The suites above pinned the vocabulary and proved Blu's form signs through —
// but they pinned each signer by user id, which New Contract never sends. The
// modal sends {name, email, role} and nothing else (ESignPage.tsx), so the
// server resolves the address itself and mints a free 'contact' account for an
// email GAM has never seen. The resident seat then refused that brand-new
// signer as "an account that isn't a resident's" — an account the landlord
// could not have heard of, created by his own click one line earlier, and no
// next step he could take. The picker was back to offering a role it could not
// always fill, which is the entire defect.
//
// So the screen's own path is a test now. The checks that matter are still
// checks: a landlord's or a staff member's login is not a resident, and
// another company's resident stays that company's.
describe('New Contract: the resident seat filled the way the screen fills it', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_signer_roles'
  })

  /** Blu's login and his two-signature form. No residents seeded on purpose. */
  async function seedBlu() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const landlordEmail = (await c.query<{ email: string }>(
        'SELECT email FROM users WHERE id=$1', [landlordUserId])).rows[0].email
      const templateId = (await c.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active, purpose)
         VALUES ($1,'Mattoon Work Trade','/uploads/work-trade.pdf',TRUE,'work_trade_addendum')
         RETURNING id`, [landlordId])).rows[0].id
      for (const [i, role] of ['landlord', 'primary'].entries()) {
        await c.query(
          `INSERT INTO lease_template_fields
             (template_id, field_type, signer_role, label, page, x, y, width, height, required)
           VALUES ($1,'signature',$2,$3,1,40,$4,160,28,TRUE)`,
          [templateId, role, `${role} signature`, 120 * i + 400])
      }
      await c.query('COMMIT')
      const token = jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: landlordEmail,
          profileId: landlordId, landlordIds: [landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { landlordId, landlordUserId, landlordEmail, templateId, token }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  /** Exactly the body ESignPage sends: no user ids anywhere. */
  function asTheScreenSends(
    f: Awaited<ReturnType<typeof seedBlu>>,
    resident: { name: string; email: string },
  ) {
    return request(buildApp()).post('/api/esign/standalone-documents')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        title: 'Mattoon work-trade agreement',
        documentType: 'general_contract',
        templateId: f.templateId,
        signers: [
          { role: 'landlord', name: 'Blu Landlord', email: f.landlordEmail },
          { role: 'primary', name: resident.name, email: resident.email },
        ],
      })
  }

  const boxes = (docId: string) => db.query<any>(
    `SELECT signer_role, signer_id FROM lease_document_fields
      WHERE document_id=$1 ORDER BY signer_role`, [docId]).then(r => r.rows)

  const accountFor = (email: string) => db.query<any>(
    `SELECT u.role, u.email,
            EXISTS (SELECT 1 FROM tenants t WHERE t.user_id = u.id) AS has_tenant
       FROM users u WHERE LOWER(u.email) = LOWER($1)`, [email]).then(r => r.rows[0])

  it('an email GAM has never seen fills the resident seat and both boxes bind', async () => {
    const f = await seedBlu()
    const res = await asTheScreenSends(f, { name: 'Curtis Newcomer', email: 'curtis.newcomer@example.test' })
    expect(res.status, res.body?.error || '').toBe(200)
    expect(res.body.data.mintedContacts).toBe(1)

    const fields = await boxes(res.body.data.id)
    expect(fields.map((r: any) => r.signer_role)).toEqual(['landlord', 'primary'])
    for (const row of fields) expect(row.signer_id, `${row.signer_role} box bound to nobody`).not.toBeNull()
  })

  it('the person it mints is a contact — a tenant account still comes only from an invite or screening', async () => {
    const f = await seedBlu()
    const res = await asTheScreenSends(f, { name: 'Curtis Newcomer', email: 'curtis.newcomer@example.test' })
    expect(res.status).toBe(200)
    const acct = await accountFor('curtis.newcomer@example.test')
    expect(acct.role).toBe('contact')
    expect(acct.has_tenant).toBe(false)
  })

  it('a landlord or staff login in the resident seat is still refused, and nothing is written', async () => {
    const f = await seedBlu()
    const other = await db.connect()
    let otherEmail: string
    try {
      await other.query('BEGIN')
      const o = await seedLandlord(other)
      otherEmail = (await other.query<{ email: string }>(
        'SELECT email FROM users WHERE id=$1', [o.userId])).rows[0].email
      await other.query('COMMIT')
    } catch (e) { await other.query('ROLLBACK'); throw e } finally { other.release() }

    const res = await asTheScreenSends(f, { name: 'Another Owner', email: otherEmail })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(NOT_A_RESIDENT_ACCOUNT)
    expect(await db.query(`SELECT 1 FROM lease_documents`).then(r => r.rowCount)).toBe(0)
  })

  it('another company\'s resident is still refused, with the next step', async () => {
    const f = await seedBlu()
    const c = await db.connect()
    let strangerEmail: string
    try {
      await c.query('BEGIN')
      const tenantId = await seedTenant(c)
      strangerEmail = (await c.query<{ email: string }>(
        `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id=$1`,
        [tenantId])).rows[0].email
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await asTheScreenSends(f, { name: 'Stranger Resident', email: strangerEmail })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no lease, invite or draft lease with this company/)
    expect(await db.query(`SELECT 1 FROM lease_documents`).then(r => r.rowCount)).toBe(0)
  })
})
