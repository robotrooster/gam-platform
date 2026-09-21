/**
 * S652 — sleeves and cards.
 *
 * Nic: "if I upload my Arizona property and twelve documents are anticipated,
 * that shows twelve blanks... They're not required to use the blank spots. But
 * that hint of hey, there's more things to upload is there." And: "the library
 * should only show relevant stuff to properties they've uploaded."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { signingPackagesRouter } from './signingPackages'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

let il: { landlordId: string; userId: string; propertyId: string }
let az: { landlordId: string; userId: string; propertyId: string }

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => { const j = res.json.bind(res); res.json = (b: any) => j(camelCaseKeys(b)); next() })
  a.use('/api/esign', esignRouter)
  a.use('/api/signing-packages', signingPackagesRouter)
  a.use(errorHandler)
  return a
}
const token = (w: { userId: string; landlordId: string }) => jwt.sign(
  { userId: w.userId, role: 'landlord', email: 'll@test.dev', profileId: w.landlordId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

async function sleeve(key: string, state: string, kind: string, purpose: string, units: string[], title: string,
                      sort: number, disclosureType: string | null = null, appliesTo = 'any') {
  const r = await query<{ id: string }>(
    `INSERT INTO document_sleeves (sleeve_key, state_code, kind, purpose, disclosure_type, unit_types, applies_to, title, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [key, state, kind, purpose, disclosureType, units, appliesTo, title, sort])
  return r[0].id
}

let s: Record<string, string>
beforeEach(async () => {
  await cleanupAllSchema()
  await query(`DELETE FROM sleeve_coverings`); await query(`UPDATE lease_templates SET sleeve_id=NULL`)
  await query(`DELETE FROM document_sleeves`); await query(`DELETE FROM disclosure_library_fields`)
  await query(`DELETE FROM disclosure_library_documents`)
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const ap = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId, state: 'IL' })
    await seedUnit(c, { propertyId: ap, landlordId: a.landlordId, unitType: 'mobile_home' })
    const b = await seedLandlord(c)
    const bp = await seedProperty(c, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId, state: 'AZ' })
    await seedUnit(c, { propertyId: bp, landlordId: b.landlordId, unitType: 'rv_spot' })
    await c.query('COMMIT')
    il = { ...a, propertyId: ap }; az = { ...b, propertyId: bp }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  s = {
    ilMhLease: await sleeve('lease:IL:mobile_home', 'IL', 'lease', 'lease', ['mobile_home'], 'Illinois: Mobile Home Lease', 4),
    ilRvLease: await sleeve('lease:IL:rv_spot', 'IL', 'lease', 'lease', ['rv_spot'], 'Illinois: RV Spot Lease', 2),
    ilSale:    await sleeve('sale:IL:mobile_home', 'IL', 'sale_contract', 'installment_sale', ['mobile_home'], 'Illinois: Mobile Home Sale Contract', 50, null, 'sale'),
    ilRules:   await sleeve('doc:IL:mobile_home:park_rules', 'IL', 'disclosure', 'state_disclosure', ['mobile_home'], 'Illinois: Park Rules (Mobile Home Lots)', 105, 'park_rules'),
    ilOwner:   await sleeve('doc:IL:mobile_home:owner_agent_identity', 'IL', 'disclosure', 'state_disclosure', ['mobile_home'], 'Illinois: Owner & Manager Disclosure (Mobile Home Lots)', 101, 'owner_agent_identity'),
    azRvLease: await sleeve('lease:AZ:rv_spot', 'AZ', 'lease', 'lease', ['rv_spot'], 'Arizona: RV Spot Lease', 2),
  }
})

const sleevesOf = async (w: typeof il) =>
  (await request(app()).get('/api/esign/sleeves').set('Authorization', `Bearer ${token(w)}`).expect(200)).body.data

describe('what a landlord sees', () => {
  it('only their states, only the kinds of space they run there', async () => {
    const d = await sleevesOf(il)
    expect(d.states.map((x: any) => x.state)).toEqual(['IL'])
    const titles = d.states[0].sleeves.map((x: any) => x.title)
    expect(titles).toContain('Illinois: Mobile Home Lease')
    expect(titles).not.toContain('Illinois: RV Spot Lease')      // they run no RV spots
    expect(titles).not.toContain('Arizona: RV Spot Lease')       // not their state
  })

  it('numbers the set: leases, then sale contract, then documents — empty ones included', async () => {
    const st = (await sleevesOf(il)).states[0]
    expect(st.sleeves.map((x: any) => [x.number, x.title, x.filled])).toEqual([
      [1, 'Illinois: Mobile Home Lease', false],
      [2, 'Illinois: Mobile Home Sale Contract', false],
      [3, 'Illinois: Owner & Manager Disclosure (Mobile Home Lots)', false],
      [4, 'Illinois: Park Rules (Mobile Home Lots)', false],
    ])
    expect([st.filled, st.total]).toEqual([0, 4])
  })

  it('never says a document is required', async () => {
    const body = JSON.stringify(await sleevesOf(il))
    for (const w of ['required', 'must ', 'mandatory', 'violation', 'complian']) expect(body.toLowerCase()).not.toContain(w)
  })

  it('government forms come already filled — Federal for everyone, a state\'s only where they operate', async () => {
    await query(
      `INSERT INTO disclosure_library_documents (disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url)
       VALUES ('lead_based_paint','US','sale',ARRAY['apartment','single_family','mobile_home','hotel_room'],'Federal: Lead — Sales','EPA','https://epa.gov/x','/api/esign/files/a.pdf'),
              ('tenant_rights_guide','IL','any',ARRAY['mobile_home'],'Illinois: Guide','IDPH','https://idph/x','/api/esign/files/b.pdf')`)
    const ilView = await sleevesOf(il)
    expect(ilView.federal.map((x: any) => x.title)).toEqual(['Federal: Lead — Sales'])
    expect(ilView.states[0].sleeves.find((x: any) => x.title === 'Illinois: Guide')?.filled).toBe(true)
    // AZ runs RV spots: lead paperwork is for housing, and IL's guide is not theirs.
    const azView = await sleevesOf(az)
    expect(azView.federal).toEqual([])
    expect(JSON.stringify(azView)).not.toContain('Illinois: Guide')
  })
})

describe('filing templates', () => {
  it('a template uploaded INTO a sleeve takes the sleeve\'s facts', async () => {
    const r = await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Our Park Rules', sleeveId: s.ilRules }).expect(201)
    const t = (await query<any>(`SELECT * FROM lease_templates WHERE id=$1`, [r.body.data.id]))[0]
    expect([t.sleeve_id, t.purpose, t.unit_type, t.state_code, t.disclosure_type])
      .toEqual([s.ilRules, 'state_disclosure', 'mobile_home', 'IL', 'park_rules'])
    const st = (await sleevesOf(il)).states[0]
    expect(st.sleeves.find((x: any) => x.id === s.ilRules).cards.map((c: any) => c.name)).toEqual(['Our Park Rules'])
  })

  it('a template made the old way is filed where it plainly belongs', async () => {
    const r = await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Lot Lease', purpose: 'lease', unitType: 'mobile_home', propertyId: il.propertyId }).expect(201)
    expect((await query<any>(`SELECT sleeve_id FROM lease_templates WHERE id=$1`, [r.body.data.id]))[0].sleeve_id).toBe(s.ilMhLease)
  })

  it('anything it cannot confidently file stays visible under Other documents', async () => {
    await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Pool Waiver', purpose: 'other' }).expect(201)
    expect((await sleevesOf(il)).other.map((c: any) => c.name)).toEqual(['Pool Waiver'])
  })
})

describe('"it\'s in another document"', () => {
  // Nothing is detected: the landlord says which of their documents already
  // contain this one, and can name more than one — Nic: "my lease for both
  // properties is identical... you need to be able to select both."
  let leaseA: string, leaseB: string
  beforeEach(async () => {
    leaseA = (await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Park A Lease', sleeveId: s.ilMhLease }).expect(201)).body.data.id
    leaseB = (await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Park B Lease', sleeveId: s.ilMhLease }).expect(201)).body.data.id
  })
  const cover = (w: typeof il, sleeveId: string, ids: string[]) =>
    request(app()).put(`/api/esign/sleeves/${sleeveId}/cover`).set('Authorization', `Bearer ${token(w)}`).send({ templateIds: ids })
  const rulesSleeve = async () => (await sleevesOf(il)).states[0].sleeves.find((x: any) => x.id === s.ilRules)

  it('can name every document it is in, and counts as filled', async () => {
    await cover(il, s.ilRules, [leaseA, leaseB]).expect(200)
    const r = await rulesSleeve()
    expect(r.filled).toBe(true)
    expect(r.coveredBy.map((c: any) => c.name).sort()).toEqual(['Park A Lease', 'Park B Lease'])
  })

  it('an empty list clears it', async () => {
    await cover(il, s.ilRules, [leaseA]).expect(200)
    await cover(il, s.ilRules, []).expect(200)
    const r = await rulesSleeve()
    expect([r.filled, r.coveredBy]).toEqual([false, []])
  })

  it('a lease or sale contract cannot be "in" another document — it is its own', async () => {
    await cover(il, s.ilSale, [leaseA]).expect(400)
  })

  it('refuses somebody else\'s document, and a state they don\'t operate in', async () => {
    await cover(az, s.ilRules, [leaseA]).expect(404)
    await cover(il, s.azRvLease, [leaseA]).expect(404)
  })
})

describe('grouping', () => {
  it('each sleeve says which heading it sits under', async () => {
    const byTitle = Object.fromEntries((await sleevesOf(il)).states[0].sleeves.map((x: any) => [x.title, x.group]))
    expect(byTitle['Illinois: Mobile Home Lease']).toBe('contracts')
    expect(byTitle['Illinois: Mobile Home Sale Contract']).toBe('contracts')
    expect(byTitle['Illinois: Park Rules (Mobile Home Lots)']).toBe('mobile_home_lots')
  })
})

describe('packages', () => {
  it('keep their state', async () => {
    const r = await request(app()).post('/api/signing-packages').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'IL rent-to-own', unitType: 'mobile_home', stateCode: 'IL', items: [] }).expect(201)
    const p = (await query<any>(`SELECT state_code FROM document_packages WHERE id=$1`, [r.body.data?.id ?? r.body.id]))[0]
    expect(p.state_code).toBe('IL')
  })
})

describe('replacing a template\'s PDF', () => {
  // Boxes are kept by page and position, apart from the PDF — a replacement
  // slides in underneath them unless it drops a page a box is on.
  it('keeps the boxes, and refuses a PDF missing a page one sits on', async () => {
    const id = (await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Lot Lease', sleeveId: s.ilMhLease, basePdfUrl: '/api/esign/files/old.pdf', pageCount: 9 }).expect(201)).body.data.id
    await query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, page, x, y) VALUES ($1,'signature','primary',9,50,50)`, [id])

    const r = await request(app()).patch(`/api/esign/templates/${id}`).set('Authorization', `Bearer ${token(il)}`)
      .send({ basePdfUrl: '/api/esign/files/new.pdf', pageCount: 8 }).expect(409)
    expect(String(r.body.error || r.body.message)).toMatch(/page 9/)

    await request(app()).patch(`/api/esign/templates/${id}`).set('Authorization', `Bearer ${token(il)}`)
      .send({ basePdfUrl: '/api/esign/files/new.pdf', pageCount: 9 }).expect(200)
    const t = (await query<any>(`SELECT base_pdf_url FROM lease_templates WHERE id=$1`, [id]))[0]
    expect(t.base_pdf_url).toBe('/api/esign/files/new.pdf')
    expect((await query<any>(`SELECT count(*)::int c FROM lease_template_fields WHERE template_id=$1`, [id]))[0].c).toBe(1)
  })
})

describe('free government versions', () => {
  it('a state\'s own version fills its sleeve until the landlord uploads theirs, and sits in the section underneath', async () => {
    await query(
      `INSERT INTO disclosure_library_documents (disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url)
       VALUES ('park_rules','IL','any',ARRAY['mobile_home'],'Illinois: Model Park Rules','IDPH','https://idph/x','/api/esign/files/m.pdf')`)
    const st = (await sleevesOf(il)).states[0]
    const rules = st.sleeves.find((x: any) => x.id === s.ilRules)
    expect(rules.filled).toBe(true)
    expect(rules.freeVersion.title).toBe('Illinois: Model Park Rules')
    // and underneath, with the other government documents — last
    expect(st.sleeves[st.sleeves.length - 1].group).toBe('government')

    await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Our Own Rules', sleeveId: s.ilRules }).expect(201)
    const after = (await sleevesOf(il)).states[0].sleeves.find((x: any) => x.id === s.ilRules)
    expect(after.cards.map((c: any) => c.name)).toEqual(['Our Own Rules'])
  })

  it('a state model lease lines up with that state\'s lease sleeve', async () => {
    await query(
      `INSERT INTO disclosure_library_documents (purpose, disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url)
       VALUES ('lease',NULL,'IL','rental',ARRAY['mobile_home'],'Illinois: Model Lot Lease','State','https://x','/api/esign/files/l.pdf')`)
    const lease = (await sleevesOf(il)).states[0].sleeves.find((x: any) => x.id === s.ilMhLease)
    expect(lease.freeVersion.title).toBe('Illinois: Model Lot Lease')
  })
})

describe('uploading a PDF', () => {
  it('refuses one that is locked against editing — it could never be signed', async () => {
    const r = await request(app()).post('/api/esign/upload').set('Authorization', `Bearer ${token(il)}`)
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -4>>endobj\ntrailer<</Encrypt 1 0 R/Root 2 0 R>>\n%%EOF'), 'locked.pdf')
    expect(r.status).toBe(400)
  })
})

describe('the landlord\'s document list', () => {
  it('leaves out voided documents — they never became agreements', async () => {
    // Blu: voided documents that were never executed are clutter in his history.
    for (const [title, status] of [['Sent one', 'sent'], ['Voided one', 'voided'], ['Signed one', 'completed']]) {
      await query(`INSERT INTO lease_documents (landlord_id, title, document_type, status) VALUES ($1,$2,'general_contract',$3)`,
        [il.landlordId, title, status])
    }
    const r = await request(app()).get('/api/esign/documents').set('Authorization', `Bearer ${token(il)}`).expect(200)
    const titles = (r.body.data ?? r.body).map((d: any) => d.title).sort()
    expect(titles).toEqual(['Sent one', 'Signed one'])
    // the row itself is kept
    expect((await query<any>(`SELECT count(*)::int c FROM lease_documents WHERE status='voided'`))[0].c).toBe(1)
  })
})
