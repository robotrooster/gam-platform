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

describe('"already in my lease"', () => {
  let leaseId: string
  beforeEach(async () => {
    const r = await request(app()).post('/api/esign/templates').set('Authorization', `Bearer ${token(il)}`)
      .send({ name: 'Mattoon Lease', sleeveId: s.ilMhLease }).expect(201)
    leaseId = r.body.data.id
  })

  it('a covered sleeve counts as filled and says what covers it', async () => {
    await request(app()).post(`/api/esign/sleeves/${s.ilRules}/cover`).set('Authorization', `Bearer ${token(il)}`)
      .send({ templateId: leaseId }).expect(200)
    const rules = (await sleevesOf(il)).states[0].sleeves.find((x: any) => x.id === s.ilRules)
    expect(rules.filled).toBe(true)
    expect(rules.coveredBy.name).toBe('Mattoon Lease')
    await request(app()).delete(`/api/esign/sleeves/${s.ilRules}/cover`).set('Authorization', `Bearer ${token(il)}`).expect(200)
    expect((await sleevesOf(il)).states[0].sleeves.find((x: any) => x.id === s.ilRules).filled).toBe(false)
  })

  it('cannot be covered with somebody else\'s document, or in a state they don\'t operate in', async () => {
    await request(app()).post(`/api/esign/sleeves/${s.ilRules}/cover`).set('Authorization', `Bearer ${token(az)}`)
      .send({ templateId: leaseId }).expect(404)
    await request(app()).post(`/api/esign/sleeves/${s.azRvLease}/cover`).set('Authorization', `Bearer ${token(il)}`)
      .send({ templateId: leaseId }).expect(404)
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
