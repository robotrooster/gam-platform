/**
 * S652 — a lease says which documents it already contains.
 *
 * Nic: "I want it to auto-confirm based on uploaded leases... If somebody uploads
 * a new lease, have it reread on the upload... if I change my draft next year,
 * and I leave out some of the stuff that was auto selected on the first lease, it
 * needs to reread that and deselect the options that are no longer applicable."
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { detectCoverings, readDocument } from './sleeveDetection'
import { setSleeveCoverings, sleevesForLandlord } from './documentSleeves'

const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
const DIR = path.join(process.cwd(), 'uploads', 'leases')
const written: string[] = []

async function pdf(lines: string[]): Promise<string> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  lines.forEach((t, i) => page.drawText(t, { x: 54, y: 740 - i * 18, size: 10, font }))
  const name = `sleeve-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, name), await doc.save())
  written.push(path.join(DIR, name))
  return name
}
afterEach(() => { for (const f of written.splice(0)) try { fs.unlinkSync(f) } catch { /* gone */ } })

const LEASE_WITH_RULES = [
  'LANDLORD: Test Park LLC P.O. Box 12, Mattoon IL',
  '6. SECURITY DEPOSIT',
  'The deposit is held in a separate account.',
  '8. PARK RULES',
  'Tenant received the park rules before signing.',
  '9. RENT INCREASES',
  'Landlord shall give 90 days notice of any rent increase.',
]
const LEASE_WITHOUT_RULES = LEASE_WITH_RULES.filter(l => !/PARK RULES|park rules/.test(l))

let ll: { landlordId: string; userId: string; propertyId: string }
let sl: Record<string, string>

beforeEach(async () => {
  await cleanupAllSchema()
  await query(`DELETE FROM sleeve_coverings`); await query(`UPDATE lease_templates SET sleeve_id=NULL`)
  await query(`DELETE FROM document_sleeves`)
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const p = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId, state: 'IL' })
    await seedUnit(c, { propertyId: p, landlordId: a.landlordId, unitType: 'mobile_home' })
    await c.query('COMMIT')
    ll = { ...a, propertyId: p }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  const mk = async (key: string, type: string, title: string, sort: number) => (await query<{ id: string }>(
    `INSERT INTO document_sleeves (sleeve_key, state_code, kind, purpose, disclosure_type, unit_types, title, sort_order)
     VALUES ($1,'IL','disclosure','state_disclosure',$2,ARRAY['mobile_home'],$3,$4) RETURNING id`, [key, type, title, sort]))[0].id
  sl = {
    owner: await mk('doc:IL:mh:owner', 'owner_agent_identity', 'Illinois: Owner & Manager Disclosure', 101),
    deposit: await mk('doc:IL:mh:deposit', 'security_deposit_terms', 'Illinois: Security Deposit Terms', 103),
    rules: await mk('doc:IL:mh:rules', 'park_rules', 'Illinois: Park Rules', 104),
    rent: await mk('doc:IL:mh:rent', 'rent_increase_notice', 'Illinois: Rent Increase Notice', 110),
  }
})

async function lease(file: string) {
  return (await query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, purpose, unit_type, property_id, base_pdf_url)
     VALUES ($1,'Park Lease','lease','mobile_home',$2,$3) RETURNING id`,
    [ll.landlordId, ll.propertyId, `/api/esign/files/${file}`]))[0].id
}
const coverOf = async (sleeveId: string) => query<any>(
  `SELECT template_id, source FROM sleeve_coverings WHERE sleeve_id=$1`, [sleeveId])

describe('reading a lease', () => {
  it('finds sections by their headings, and the owner block by its address', async () => {
    const found = (await readDocument(path.join(DIR, await pdf(LEASE_WITH_RULES)))).map(f => f.disclosureType)
    expect(found).toEqual(expect.arrayContaining(['owner_agent_identity', 'security_deposit_terms', 'park_rules']))
  })

  it('never claims a notice sent later — a lease cannot contain a rent increase that has not happened', async () => {
    const found = (await readDocument(path.join(DIR, await pdf(LEASE_WITH_RULES)))).map(f => f.disclosureType)
    expect(found).not.toContain('rent_increase_notice')
  })

  it('a MENTION is not a section: "received the park rules" alone covers nothing', async () => {
    const found = (await readDocument(path.join(DIR, await pdf(['Tenant acknowledges the park rules were posted.']))))
      .map(f => f.disclosureType)
    expect(found).not.toContain('park_rules')
  })
})

describe('covering sleeves from it', () => {
  it('ticks what it found, with the passage as evidence', async () => {
    const t = await lease(await pdf(LEASE_WITH_RULES))
    await detectCoverings(exec, t)
    expect(await coverOf(sl.rules)).toEqual([{ template_id: t, source: 'auto' }])
    expect((await coverOf(sl.rent)).length).toBe(0)
    const ev = await query<any>(`SELECT evidence FROM sleeve_coverings WHERE sleeve_id=$1`, [sl.rules])
    expect(ev[0].evidence).toMatch(/PARK RULES/)
  })

  it('a new PDF without the section un-ticks it — "next year\'s draft"', async () => {
    const t = await lease(await pdf(LEASE_WITH_RULES))
    await detectCoverings(exec, t)
    await query(`UPDATE lease_templates SET base_pdf_url=$2 WHERE id=$1`, [t, `/api/esign/files/${await pdf(LEASE_WITHOUT_RULES)}`])
    await detectCoverings(exec, t)
    expect((await coverOf(sl.rules)).length).toBe(0)
    expect((await coverOf(sl.deposit)).length).toBe(1)     // still in the new draft
  })

  it('never undoes what the landlord ticked themselves', async () => {
    const t = await lease(await pdf(LEASE_WITHOUT_RULES))
    await setSleeveCoverings(exec, [ll.landlordId], sl.rules, [t])       // "it's in there" — their call
    await detectCoverings(exec, t)
    expect(await coverOf(sl.rules)).toEqual([{ template_id: t, source: 'manual' }])
  })

  it('a hand edit keeps an automatic tick automatic, so next year can still clear it', async () => {
    const t = await lease(await pdf(LEASE_WITH_RULES))
    await detectCoverings(exec, t)
    await setSleeveCoverings(exec, [ll.landlordId], sl.rules, [t])       // re-saved, unchanged
    expect((await coverOf(sl.rules))[0].source).toBe('auto')
  })

  it('a notice cannot be marked as inside another document', async () => {
    const t = await lease(await pdf(LEASE_WITH_RULES))
    await expect(setSleeveCoverings(exec, [ll.landlordId], sl.rent, [t])).rejects.toThrow(/notice/i)
  })

  it('notices sit under their own heading', async () => {
    const st = (await sleevesForLandlord(exec, [ll.landlordId])).states[0]
    expect(st.sleeves.find((x: any) => x.id === sl.rent)?.group).toBe('notices_later')
  })
})

describe('an account that reaches two companies', () => {
  it('sees each government form once, even when both companies hold a copy', async () => {
    // Blu is an owner-member of Oak Park as well as his own company; both held
    // a copy of the federal Sales form and the page listed it twice.
    const c = await db.connect(); let other: any
    try {
      await c.query('BEGIN')
      other = await seedLandlord(c)
      await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId, state: 'AZ' })
      await c.query('COMMIT')
    } finally { c.release() }
    const d = (await query<{ id: string }>(
      `INSERT INTO disclosure_library_documents (disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url)
       VALUES ('lead_based_paint','US','sale',NULL,'Federal: Lead — Sales','EPA','https://epa.gov/x','/api/esign/files/x.pdf') RETURNING id`))[0].id
    for (const who of [ll.landlordId, other.landlordId]) {
      await query(`INSERT INTO lease_templates (landlord_id, name, purpose, library_document_id) VALUES ($1,'Federal: Lead — Sales','state_disclosure',$2)`, [who, d])
    }
    const view = await sleevesForLandlord(exec, [ll.landlordId, other.landlordId])
    expect(view.federal.map((x: any) => x.title)).toEqual(['Federal: Lead — Sales'])
    await query(`DELETE FROM lease_templates WHERE library_document_id=$1`, [d])
    await query(`DELETE FROM disclosure_library_documents WHERE id=$1`, [d])
  })
})
