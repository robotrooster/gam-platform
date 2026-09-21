/**
 * S652 — the shelf of government-published forms.
 *
 * Nic: "the library should only be government published documents that
 * something we're not altering at all... they can't alter the document, but
 * when they send it out for signature, it needs to have e-signature flow on it
 * where the page can at least have the tenant's initials that they received it
 * as part of the lease signing flow."
 *
 * The load-bearing assertions are the two halves of that sentence: the words and
 * boxes are out of the landlord's reach, AND the form still signs like anything
 * else. Plus the one GAM must never do — say what anybody is required to send.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { camelCaseKeys } from '../lib/caseConversion'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'
import { resyncAdoptions } from '../services/disclosureLibrary'

let il: { landlordId: string; userId: string; propertyId: string }
let az: { landlordId: string; userId: string; propertyId: string }

function buildApp() {
  const a = express()
  a.use(express.json())
  // The API camelizes on the way out (index.ts). A suite that skips it asserts
  // a wire contract nothing actually serves — see the camelize regression tests.
  a.use((_req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body: any) => json(camelCaseKeys(body))
    next()
  })
  a.use('/api/esign', esignRouter)
  a.use(errorHandler)
  return a
}

function token(who: { userId: string; landlordId: string }) {
  return jwt.sign(
    { userId: who.userId, role: 'landlord', email: 'll@test.dev',
      profileId: who.landlordId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

/** A form on the shelf. `jurisdiction` 'US' is federal. */
async function shelve(opts: {
  jurisdiction: string
  disclosureType?: string
  name?: string
  appliesTo?: string
  unitTypes?: string[] | null
  version?: number
  pdf?: string
}) {
  const r = await query<{ id: string }>(
    `INSERT INTO disclosure_library_documents
       (disclosure_type, jurisdiction, applies_to, unit_types, name, description,
        source_name, source_url, publication_ref, base_pdf_url, page_count, version)
     VALUES ($1,$2,$3,$4,$5,'',$6,'https://example.gov/form','REF-1',$7,1,$8)
     RETURNING id`,
    [opts.disclosureType ?? 'lead_based_paint', opts.jurisdiction, opts.appliesTo ?? 'any',
     opts.unitTypes ?? null, opts.name ?? 'A Published Form',
     'Example Agency', opts.pdf ?? '/api/esign/files/v1.pdf', opts.version ?? 1])
  const id = r[0].id
  await query(
    `INSERT INTO disclosure_library_fields
       (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order)
     VALUES ($1,'initials','primary','Tenant received it','tenant_initial',1,50,50,40,16,TRUE,1),
            ($1,'signature','primary','Tenant signature','tenant_signature',1,50,200,200,30,TRUE,2)`,
    [id])
  return id
}

beforeEach(async () => {
  await cleanupAllSchema()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const a = await seedLandlord(client)
    const aProp = await seedProperty(client, {
      landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId, state: 'IL' })
    await seedUnit(client, { propertyId: aProp, landlordId: a.landlordId, unitType: 'mobile_home' })

    const b = await seedLandlord(client)
    const bProp = await seedProperty(client, {
      landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId, state: 'AZ' })
    await seedUnit(client, { propertyId: bProp, landlordId: b.landlordId, unitType: 'rv_spot' })
    await client.query('COMMIT')
    il = { ...a, propertyId: aProp }
    az = { ...b, propertyId: bProp }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
})

const get = (who: typeof il) =>
  request(buildApp()).get('/api/esign/library').set('Authorization', `Bearer ${token(who)}`)

describe('GET /api/esign/library — what is on the shelf', () => {
  it('shows a federal form to everybody', async () => {
    await shelve({ jurisdiction: 'US', name: 'Federal Thing' })
    for (const who of [il, az]) {
      const r = await get(who).expect(200)
      expect(r.body.documents.map((d: any) => d.name)).toContain('Federal Thing')
    }
  })

  it('shows a state form only where the landlord actually operates', async () => {
    await shelve({ jurisdiction: 'IL', name: 'Illinois Thing' })
    expect((await get(il).expect(200)).body.documents.map((d: any) => d.name)).toContain('Illinois Thing')
    expect((await get(az).expect(200)).body.documents.map((d: any) => d.name)).not.toContain('Illinois Thing')
  })

  it('a form written for one kind of space stays off the others', async () => {
    // The IL landlord runs mobile homes, the AZ landlord RV spots.
    await shelve({ jurisdiction: 'US', name: 'Mobile Homes Only', unitTypes: ['mobile_home'] })
    expect((await get(il).expect(200)).body.documents.map((d: any) => d.name)).toContain('Mobile Homes Only')
    expect((await get(az).expect(200)).body.documents.map((d: any) => d.name)).not.toContain('Mobile Homes Only')
  })

  it('names the publisher, because that is the whole claim the shelf makes', async () => {
    await shelve({ jurisdiction: 'US' })
    const d = (await get(il).expect(200)).body.documents[0]
    expect(d.publishedBy).toBe('Example Agency')
    expect(d.sourceUrl).toBe('https://example.gov/form')
  })

  it('never says anybody is required to send anything', async () => {
    // Same rule the /disclosures endpoint is held to. GAM stocks a shelf; it
    // does not practise law. Nic: "We don't police what's required where."
    await shelve({ jurisdiction: 'IL' })
    const body = JSON.stringify((await get(il).expect(200)).body)
    for (const word of ['required', 'must ', 'mandatory', 'violation', 'complian']) {
      expect(body.toLowerCase()).not.toContain(word)
    }
  })

  it('a retired or superseded form is off the shelf', async () => {
    const old = await shelve({ jurisdiction: 'US', name: 'Last Year' })
    const fresh = await shelve({ jurisdiction: 'US', name: 'This Year', version: 2 })
    await query(`UPDATE disclosure_library_documents SET superseded_by_id=$2 WHERE id=$1`, [old, fresh])
    const names = (await get(il).expect(200)).body.documents.map((d: any) => d.name)
    expect(names).toContain('This Year')
    expect(names).not.toContain('Last Year')
  })
})

describe('POST /api/esign/library/:id/adopt', () => {
  const adopt = (who: typeof il, docId: string) =>
    request(buildApp()).post('/api/esign/library/adopt')
      .set('Authorization', `Bearer ${token(who)}`).send({ documentId: docId })

  it('puts it on the shelf as a template, with the fields the library wrote', async () => {
    const docId = await shelve({ jurisdiction: 'US', name: 'Federal Thing' })
    const r = await adopt(il, docId).expect(200)
    const tpl = await query<any>(`SELECT * FROM lease_templates WHERE id=$1`, [r.body.templateId])
    expect(tpl[0].library_document_id).toBe(docId)
    expect(tpl[0].base_pdf_url).toBe('/api/esign/files/v1.pdf')
    const fields = await query<any>(`SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY sort_order`, [r.body.templateId])
    // The signing layer is the point: an unaltered page nobody can initial is
    // not a document anybody can send.
    expect(fields.map(f => f.field_type)).toEqual(['initials', 'signature'])
    expect(fields[0].signer_role).toBe('primary')
  })

  it('a federal form carries no state code; a state form does', async () => {
    const fed = await shelve({ jurisdiction: 'US', name: 'Fed' })
    const state = await shelve({ jurisdiction: 'IL', name: 'IL' })
    const a = await adopt(il, fed).expect(200)
    const b = await adopt(il, state).expect(200)
    const rows = await query<any>(`SELECT id, state_code FROM lease_templates WHERE id = ANY($1::uuid[])`,
      [[a.body.templateId, b.body.templateId]])
    expect(rows.find(r => r.id === a.body.templateId)!.state_code).toBeNull()
    expect(rows.find(r => r.id === b.body.templateId)!.state_code).toBe('IL')
  })

  it('adopting twice is the same shelf, not a second copy', async () => {
    const docId = await shelve({ jurisdiction: 'US' })
    const first = await adopt(il, docId).expect(200)
    const second = await adopt(il, docId).expect(200)
    expect(second.body.templateId).toBe(first.body.templateId)
    expect(second.body.alreadyHeld).toBe(true)
    const n = await query<any>(`SELECT count(*)::int AS c FROM lease_templates WHERE library_document_id=$1`, [docId])
    expect(n[0].c).toBe(1)
  })
})

describe('an adopted form is the government\'s, not the landlord\'s', () => {
  let templateId: string
  let docId: string
  beforeEach(async () => {
    docId = await shelve({ jurisdiction: 'US', name: 'Federal Thing' })
    const r = await request(buildApp()).post('/api/esign/library/adopt')
      .set('Authorization', `Bearer ${token(il)}`).send({ documentId: docId }).expect(200)
    templateId = r.body.templateId
  })

  it('refuses a rename or any other content edit', async () => {
    const r = await request(buildApp()).patch(`/api/esign/templates/${templateId}`)
      .set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'My Own Version' }).expect(409)
    // The message has to send them somewhere, not just say no.
    expect(String(r.body.error || r.body.message)).toMatch(/upload your own/i)
    const after = await query<any>(`SELECT name FROM lease_templates WHERE id=$1`, [templateId])
    expect(after[0].name).toBe('Federal Thing')
  })

  it('refuses moving, adding or deleting the boxes', async () => {
    await request(buildApp()).put(`/api/esign/templates/${templateId}/fields`)
      .set('Authorization', `Bearer ${token(il)}`)
      .send({ fields: [{ fieldType: 'text', page: 1, x: 1, y: 1, width: 10, height: 10 }] })
      .expect(409)
    const f = await query<any>(`SELECT id FROM lease_template_fields WHERE template_id=$1`, [templateId])
    expect(f.length).toBe(2)
    await request(buildApp()).delete(`/api/esign/templates/${templateId}/fields/${f[0].id}`)
      .set('Authorization', `Bearer ${token(il)}`).expect(409)
  })

  it('still lets them read it and take it off their shelf', async () => {
    await request(buildApp()).get(`/api/esign/templates/${templateId}`)
      .set('Authorization', `Bearer ${token(il)}`).expect(200)
    await request(buildApp()).delete(`/api/esign/templates/${templateId}`)
      .set('Authorization', `Bearer ${token(il)}`).expect(200)
    const t = await query<any>(`SELECT is_active FROM lease_templates WHERE id=$1`, [templateId])
    expect(t[0].is_active).toBe(false)
  })

  it('a stranger cannot reach it at all', async () => {
    await request(buildApp()).patch(`/api/esign/templates/${templateId}`)
      .set('Authorization', `Bearer ${token(az)}`).send({ name: 'x' }).expect(404)
  })
})

describe('the annual refresh', () => {
  it('reaches every landlord holding the old version', async () => {
    const v1 = await shelve({ jurisdiction: 'US', name: 'Form v1', pdf: '/api/esign/files/v1.pdf' })
    for (const who of [il, az]) {
      await request(buildApp()).post('/api/esign/library/adopt')
        .set('Authorization', `Bearer ${token(who)}`).send({ documentId: v1 }).expect(200)
    }
    const v2 = await shelve({ jurisdiction: 'US', name: 'Form v2', version: 2, pdf: '/api/esign/files/v2.pdf' })
    await query(`UPDATE disclosure_library_documents SET superseded_by_id=$2 WHERE id=$1`, [v1, v2])

    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    expect(await resyncAdoptions(exec, v1, v2)).toBe(2)

    const rows = await query<any>(`SELECT name, base_pdf_url, library_document_id FROM lease_templates WHERE library_document_id=$1`, [v2])
    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(r.name).toBe('Form v2')
      expect(r.base_pdf_url).toBe('/api/esign/files/v2.pdf')
    }
    // Fields were replaced, not doubled.
    const f = await query<any>(`SELECT count(*)::int AS c FROM lease_template_fields WHERE template_id=$1`, [rows[0] && (await query<any>(`SELECT id FROM lease_templates WHERE library_document_id=$1 LIMIT 1`, [v2]))[0].id])
    expect(f[0].c).toBe(2)
  })

  it('cannot reach a document that was already drafted', async () => {
    // A tenant who signed version 1 signed version 1. lease_documents carries
    // its own base_pdf_url and its own copied fields for exactly this reason.
    const v1 = await shelve({ jurisdiction: 'US', name: 'Form v1', pdf: '/api/esign/files/v1.pdf' })
    const a = await request(buildApp()).post('/api/esign/library/adopt')
      .set('Authorization', `Bearer ${token(il)}`).send({ documentId: v1 }).expect(200)
    const doc = await query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, template_id, title, base_pdf_url, document_type, status)
       VALUES ($1,$2,'Sent copy','/api/esign/files/v1.pdf','general_contract','sent') RETURNING id`,
      [il.landlordId, a.body.templateId])

    const v2 = await shelve({ jurisdiction: 'US', name: 'Form v2', version: 2, pdf: '/api/esign/files/v2.pdf' })
    await query(`UPDATE disclosure_library_documents SET superseded_by_id=$2 WHERE id=$1`, [v1, v2])
    const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
    await resyncAdoptions(exec, v1, v2)

    const after = await query<any>(`SELECT base_pdf_url FROM lease_documents WHERE id=$1`, [doc[0].id])
    expect(after[0].base_pdf_url).toBe('/api/esign/files/v1.pdf')
  })
})

describe('naming the form out loud', () => {
  // gam-agent-ids-are-spoken-not-uuids: an action whose only handle is a uuid
  // "from a lookup" is an action nobody can reach by talking.
  const adoptByName = (who: typeof il, formName: string) =>
    request(buildApp()).post('/api/esign/library/adopt')
      .set('Authorization', `Bearer ${token(who)}`).send({ formName })

  it('finds it on a partial name', async () => {
    await shelve({ jurisdiction: 'US', name: 'Lead-Based Paint Disclosure — Rental' })
    const r = await adoptByName(il, 'lead-based paint').expect(200)
    const t = await query<any>(`SELECT name FROM lease_templates WHERE id=$1`, [r.body.templateId])
    expect(t[0].name).toBe('Lead-Based Paint Disclosure — Rental')
  })

  it('refuses to pick when two could match, and names them', async () => {
    await shelve({ jurisdiction: 'US', name: 'Lead-Based Paint Disclosure — Rental' })
    await shelve({ jurisdiction: 'US', name: 'Lead-Based Paint Disclosure — Sale' })
    const r = await adoptByName(il, 'lead-based paint').expect(409)
    const msg = String(r.body.error || r.body.message)
    expect(msg).toContain('Rental')
    expect(msg).toContain('Sale')
    expect(await query<any>(`SELECT count(*)::int AS c FROM lease_templates WHERE library_document_id IS NOT NULL`))
      .toEqual([{ c: 0 }])
  })

  it('says what IS on the shelf when nothing matches', async () => {
    await shelve({ jurisdiction: 'US', name: 'Lead-Based Paint Disclosure — Rental' })
    const r = await adoptByName(il, 'radon').expect(404)
    expect(String(r.body.error || r.body.message)).toContain('Lead-Based Paint Disclosure — Rental')
  })

  it('cannot reach a form published for a state they do not operate in', async () => {
    await shelve({ jurisdiction: 'IL', name: 'Illinois Park Pamphlet' })
    // The AZ landlord can't name their way onto another state's shelf.
    await adoptByName(az, 'Illinois Park Pamphlet').expect(404)
  })
})
