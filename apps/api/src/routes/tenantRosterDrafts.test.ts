/**
 * S655 (Nic, 10/2) — THE TENANT CSV IS A DRAFT ROSTER.
 *
 * The file fills a roster of who lives where. Nothing is emailed and no
 * account is made by the import. The landlord reviews each property's roster
 * and confirms it; confirming drafts each household's lease from the
 * landlord's own setup (the unit's rent, the unit type's default lease), the
 * leases wait for the landlord's signature, and each household hears from GAM
 * once — when the landlord signs. "Mark onboarding complete" is refused while
 * the property still has people on the roster nobody has confirmed.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision } from '../test/dbHelpers'

const { emailTenantOnboardedMock, emailTenantInviteMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => 'msg'),
  emailTenantInviteMock: vi.fn(async (..._a: any[]) => 'msg'),
}))
vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailTenantOnboarded: emailTenantOnboardedMock,
  emailTenantInvite: emailTenantInviteMock,
}))

import { landlordsRouter } from './landlords'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'
import { openOnboardingWindow, onboardingLateInMonth } from '../services/onboardingWindow'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  emailTenantInviteMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_roster'
})

async function seedDefaultLease(landlordId: string): Promise<void> {
  const tid = (await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
     VALUES ($1, 'Primary Apartment', 1, 'apartment', 1, 12, true) RETURNING id`, [landlordId])).rows[0].id
  for (const c of ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']) {
    await db.query(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
       VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, c])
  }
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','co_tenant_1','tenant_signature',1,10,140)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [tid])
}

async function fixture(opts: { template?: boolean; landlordAgeDays?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    if (opts.landlordAgeDays != null) {
      await c.query(`UPDATE landlords SET created_at = NOW() - ($2 * INTERVAL '1 day') WHERE id = $1`, [landlordId, opts.landlordAgeDays])
    }
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const propertyName = `Roster Park ${randomUUID().slice(0, 4)}`
    await c.query(`UPDATE properties SET name = $1 WHERE id = $2`, [propertyName, propertyId])
    await seedLateFeeDecision(c, { propertyId, unitType: 'apartment', noLateFee: true })
    const unitA = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const unitB = await seedUnit(c, { propertyId, landlordId, rentAmount: 750 })
    await c.query(`UPDATE units SET unit_number = 'Apt 01' WHERE id = $1`, [unitA])
    await c.query(`UPDATE units SET unit_number = 'Apt 02' WHERE id = $1`, [unitB])
    await c.query('COMMIT')
    if (opts.template !== false) await seedDefaultLease(landlordId)
    await openOnboardingWindow(propertyId)
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, propertyName, unitA, unitB, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof fixture>>

const csvOf = (f: F, rows: Array<[string, string, string, string]>) =>
  ['first_name,last_name,email,property_name,unit_number,monthly_rent,outstanding_balance',
   ...rows.map(([first, last, email, unit]) => `${first},${last},${email},${f.propertyName},${unit},950,`)].join('\n')

const saveDraft = (f: F, csv: string) => request(buildApp())
  .post('/api/landlords/me/onboard-tenants-csv/draft')
  .set('Authorization', `Bearer ${f.token}`)
  .send({ csv, source: 'generic', claimedPlatformName: 'OldSystem' })
const roster = (f: F) => request(buildApp())
  .get(`/api/landlords/me/tenant-roster?propertyId=${f.propertyId}`)
  .set('Authorization', `Bearer ${f.token}`)
const patch = (f: F, id: string, body: any) => request(buildApp())
  .patch(`/api/landlords/me/tenant-roster/${id}`)
  .set('Authorization', `Bearer ${f.token}`).send(body)
const confirm = (f: F) => request(buildApp())
  .post('/api/landlords/me/tenant-roster/confirm')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId })

const mail = () => emailTenantOnboardedMock.mock.calls.length + emailTenantInviteMock.mock.calls.length
const em = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}@test.dev`

/** A household of two on Apt 01, one person on Apt 02, one the file couldn't place. */
async function standardRoster(f: F) {
  const e = { a1: em('a1'), a2: em('a2'), b1: em('b1'), x: em('x') }
  const res = await saveDraft(f, csvOf(f, [
    ['Ann', 'One', e.a1, 'Apt 01'], ['Al', 'One', e.a2, 'Apt 01'],
    ['Bea', 'Two', e.b1, 'Apt 02'], ['Xavi', 'Lost', e.x, 'Apt 99'],
  ]))
  expect(res.status).toBe(200)
  return e
}

describe('the draft roster review', () => {
  it('groups people by unit, lists who is not placed, and names nothing wrong on a ready unit', async () => {
    const f = await fixture()
    await standardRoster(f)
    const r = await roster(f)
    expect(r.status).toBe(200)
    const units = r.body.data.units
    expect(units.map((u: any) => u.unitNumber)).toEqual(['Apt 01', 'Apt 02'])
    expect(units[0].people.map((p: any) => p.firstName)).toEqual(['Ann', 'Al'])
    expect(units[0].blockers).toEqual([])
    expect(units[0].rent).toBe(900)
    expect(units[0].hasDefaultLease).toBe(true)
    expect(r.body.data.notPlaced.map((p: any) => p.firstName)).toEqual(['Xavi'])
    expect(r.body.data.notPlaced[0].file.unitNumber).toBe('Apt 99')
    expect(r.body.data.window.open).toBe(true)
  })

  it('confirm is refused while someone is not placed — every problem listed, nothing created', async () => {
    const f = await fixture()
    const e = await standardRoster(f)
    const res = await confirm(f)
    expect(res.status).toBe(409)
    expect(res.body.problems.join(' ')).toMatch(/Xavi Lost isn't placed in a unit yet/)
    expect((await db.query(`SELECT id FROM users WHERE email = ANY($1)`, [Object.values(e)])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM pending_tenant_intents`)).rows).toEqual([])
    expect((await db.query(`SELECT id FROM lease_documents`)).rows).toEqual([])
  })

  it('placing, fixing and removing people: a unit at another property and an email already on the roster are refused', async () => {
    const f = await fixture()
    const other = await fixture()
    const e = await standardRoster(f)
    const r = await roster(f)
    const xavi = r.body.data.notPlaced[0]
    expect((await patch(f, xavi.id, { unitId: other.unitA })).status).toBe(400)
    const dupe = await patch(f, xavi.id, { email: e.a1.toUpperCase() })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toMatch(/already has that email/)
    const placed = await patch(f, xavi.id, { unitId: f.unitB, firstName: 'Xavier' })
    expect(placed.status).toBe(200)
    expect(placed.body.data).toMatchObject({ unitId: f.unitB, firstName: 'Xavier' })

    const al = r.body.data.units[0].people[1]
    const del = await request(buildApp()).delete(`/api/landlords/me/tenant-roster/${al.id}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(del.status).toBe(200)
    // Kept, just hidden.
    expect((await db.query(`SELECT discarded_at FROM tenant_roster_drafts WHERE id = $1`, [al.id])).rows[0].discarded_at).not.toBeNull()
    const after = await roster(f)
    expect(after.body.data.units[0].people.map((p: any) => p.firstName)).toEqual(['Ann'])
  })

  it('the old balance is the household\'s: the number typed on the unit card replaces every copy, and clearing it clears it', async () => {
    const f = await fixture()
    const a1 = em('a1'), a2 = em('a2')
    // The old system repeats the lease's balance on each co-tenant's row.
    const csv = ['first_name,last_name,email,property_name,unit_number,outstanding_balance',
      `Ann,One,${a1},${f.propertyName},Apt 01,300`, `Al,One,${a2},${f.propertyName},Apt 01,300`].join('\n')
    expect((await saveDraft(f, csv)).status).toBe(200)
    let unit = (await roster(f)).body.data.units[0]
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([300, 300])
    const holder = unit.people[0]

    expect((await patch(f, holder.id, { openingBalance: '125.50' })).status).toBe(200)
    unit = (await roster(f)).body.data.units[0]
    expect(unit.openingBalance).toBe(125.5)
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([125.5, null])

    expect((await patch(f, holder.id, { openingBalance: null })).status).toBe(200)
    unit = (await roster(f)).body.data.units[0]
    expect(unit.openingBalance).toBeNull()
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([null, null])
  })

  it('in a by-room unit each roommate keeps their own old balance: editing one never touches another\'s', async () => {
    // By the room, each person is their own lease and their own household.
    const f = await fixture()
    await db.query(`UPDATE units SET occupancy_mode = 'by_room', bedrooms = 3 WHERE id = $1`, [f.unitA])
    const a1 = em('a1'), a2 = em('a2')
    const csv = ['first_name,last_name,email,property_name,unit_number,outstanding_balance',
      `Ann,One,${a1},${f.propertyName},Apt 01,300`, `Al,One,${a2},${f.propertyName},Apt 01,150`].join('\n')
    expect((await saveDraft(f, csv)).status).toBe(200)
    let unit = (await roster(f)).body.data.units[0]
    expect(unit.occupancyMode).toBe('by_room')
    // No one balance for the unit — each person's is on their own row.
    expect(unit.openingBalance).toBeNull()
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([300, 150])
    const [ann] = unit.people

    expect((await patch(f, ann.id, { openingBalance: '125.50' })).status).toBe(200)
    unit = (await roster(f)).body.data.units[0]
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([125.5, 150])

    expect((await patch(f, ann.id, { openingBalance: null })).status).toBe(200)
    unit = (await roster(f)).body.data.units[0]
    expect(unit.people.map((p: any) => p.openingBalance)).toEqual([null, 150])
  })

  it('another landlord cannot read or change this roster', async () => {
    const f = await fixture()
    const stranger = await fixture()
    await standardRoster(f)
    const r = await roster(f)
    const res = await request(buildApp()).get(`/api/landlords/me/tenant-roster?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
    expect(res.status).toBe(403)
    const p = await patch(stranger, r.body.data.units[0].people[0].id, { firstName: 'Hacked' })
    expect(p.status).toBe(403)
  })
})

describe('confirming the roster', () => {
  async function placeEveryone(f: F) {
    const r = await roster(f)
    for (const p of r.body.data.notPlaced) await patch(f, p.id, { unitId: f.unitB })
  }

  it('drafts ONE lease per household from the landlord\'s setup, waiting for his signature, and emails NOBODY', async () => {
    const f = await fixture()
    const e = await standardRoster(f)
    // Xavi moves in with Bea.
    await placeEveryone(f)
    const res = await confirm(f)
    expect(res.status).toBe(200)
    expect(res.body.data.drafted).toBe(2)
    expect(res.body.data.units.map((u: any) => u.status)).toEqual(['drafted', 'drafted'])

    const docs = (await db.query<{ id: string; unit_id: string }>(
      `SELECT id, unit_id FROM lease_documents WHERE document_type = 'original_lease' AND status <> 'voided'`)).rows
    expect(docs).toHaveLength(2)
    const aDoc = docs.find(d => d.unit_id === f.unitA)!
    const signers = (await db.query<{ email: string; role: string; status: string }>(
      `SELECT email, role, status FROM lease_document_signers WHERE document_id = $1 ORDER BY order_index`, [aDoc.id])).rows
    expect(signers.map(s => s.role)).toEqual(['landlord', 'primary', 'co_tenant_1'])
    expect(signers.slice(1).map(s => s.email)).toEqual([e.a1, e.a2])
    expect(signers[0].status).not.toBe('signed')
    // The lease drafts at the UNIT's rent, not the file's 950.
    const rent = (await db.query(`SELECT value FROM lease_document_fields WHERE document_id = $1 AND lease_column = 'rent_amount'`, [aDoc.id])).rows[0]
    expect(Number(rent.value)).toBe(900)

    // Nobody hears anything until the landlord signs: no email, no setup link.
    expect(mail()).toBe(0)
    expect((await db.query(`SELECT tenant_invite_token FROM users WHERE email = ANY($1)`, [Object.values(e)])).rows
      .every((u: any) => u.tenant_invite_token == null)).toBe(true)
    // The landlord is emailed nothing either (no "Lease drafted" email per
    // unit): one summary notice in the app, beside each document's own bell.
    const notes = (await db.query(`SELECT title, type, email_sent FROM notifications WHERE user_id = $1`, [f.userId])).rows
    expect(notes.every((n: any) => n.email_sent === false)).toBe(true)
    const summary = notes.filter((n: any) => n.type === 'lease_ready_to_sign')
    expect(summary).toHaveLength(1)
    expect(summary[0].title).toMatch(/2 leases are waiting for your signature/)

    // Every row is stamped with the invite it became, and the roster is empty.
    const rows = (await db.query(`SELECT confirmed_at, intent_id FROM tenant_roster_drafts WHERE landlord_id = $1`, [f.landlordId])).rows
    expect(rows.every((r: any) => r.confirmed_at && r.intent_id)).toBe(true)
    expect((await roster(f)).body.data.count).toBe(0)
  })

  it('the result names each person whose lease starts on their own signature, unit by unit', async () => {
    const f = await fixture()
    const other = await fixture()
    // Another company already has Bea on file (an open invite there).
    const bea = em('bea')
    const beaTenant = (await db.query<{ id: string }>(
      `WITH u AS (INSERT INTO users (email, password_hash, role, first_name, last_name)
                  VALUES ($1, 'x', 'tenant', 'Bea', 'Two') RETURNING id)
       INSERT INTO tenants (user_id) SELECT id FROM u RETURNING id`, [bea])).rows[0].id
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id)
       VALUES ($1,$2,'not_uploaded',$3,$4)`, [other.landlordId, beaTenant, other.unitA, other.propertyId])
    const csv = ['first_name,last_name,email,property_name,unit_number',
      `Ann,One,${em('a1')},${f.propertyName},Apt 01`, `Bea,Two,${bea},${f.propertyName},Apt 02`].join('\n')
    expect((await saveDraft(f, csv)).status).toBe(200)

    const res = await confirm(f)
    expect(res.status).toBe(200)
    const byUnit = Object.fromEntries(res.body.data.units.map((u: any) => [u.unitNumber, u]))
    expect(byUnit['Apt 01'].ownSignature).toEqual([])
    expect(byUnit['Apt 02'].status).toBe('drafted')
    expect(byUnit['Apt 02'].ownSignature).toEqual(['Bea Two'])
  })

  it('a unit type with no default lease: confirm is refused and says where to set one', async () => {
    const f = await fixture({ template: false })
    await standardRoster(f)
    await placeEveryone(f)
    const res = await confirm(f)
    expect(res.status).toBe(409)
    expect(res.body.problems.join(' ')).toMatch(/No default lease is set/)
    expect((await db.query(`SELECT id FROM users WHERE role = 'tenant'`)).rows).toEqual([])
  })

  it('sitting residents confirmed while the window is open are papered as EXISTING tenancies — even after the landlord\'s first 28 days', async () => {
    const f = await fixture({ landlordAgeDays: 90 })
    await standardRoster(f)
    await placeEveryone(f)
    expect((await confirm(f)).status).toBe(200)
    const flags = (await db.query(`SELECT is_existing_tenancy FROM pending_tenant_intents WHERE unit_id IS NOT NULL`)).rows
    expect(flags.length).toBe(4)
    expect(flags.every((r: any) => r.is_existing_tenancy === true)).toBe(true)
  })

  it('a household the landlord says is NOT already living there is not papered as existing', async () => {
    const f = await fixture({ landlordAgeDays: 90 })
    await standardRoster(f)
    await placeEveryone(f)
    const r = await roster(f)
    for (const p of r.body.data.units[1].people) await patch(f, p.id, { existingResident: false })
    expect((await confirm(f)).status).toBe(200)
    const b = (await db.query(`SELECT is_existing_tenancy FROM pending_tenant_intents WHERE unit_id = $1`, [f.unitB])).rows
    expect(b.every((r: any) => r.is_existing_tenancy === false)).toBe(true)
  })
})

describe('"Mark onboarding complete" waits for the roster', () => {
  const complete = (f: F) => request(buildApp())
    .post(`/api/properties/${f.propertyId}/onboarding-complete`)
    .set('Authorization', `Bearer ${f.token}`).send({})

  it('is refused while the property has unconfirmed roster people, and works once they are confirmed', async () => {
    const f = await fixture()
    await standardRoster(f)
    const refused = await complete(f)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/4 people in this property's draft roster aren't confirmed yet/)
    expect((await db.query(`SELECT onboarding_completed_at FROM properties WHERE id = $1`, [f.propertyId])).rows[0].onboarding_completed_at).toBeNull()

    const r = await roster(f)
    for (const p of r.body.data.notPlaced) await patch(f, p.id, { unitId: f.unitB })
    expect((await confirm(f)).status).toBe(200)
    expect((await complete(f)).status).toBe(200)
  })

  it('the onboarding banner shows the draft count per property', async () => {
    const f = await fixture()
    await standardRoster(f)
    const res = await request(buildApp()).get('/api/landlords/me/onboarding-windows')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.find((w: any) => w.propertyId === f.propertyId).draftRosterCount).toBe(4)
  })
})

// S655 (Nic, 10/2): the first-bill late-fee waiver is the landlord's answer,
// flagged on the onboarding screen when it is late in the month.
describe('onboarding late in the month', () => {
  it('after the 20th is late', () => {
    expect(onboardingLateInMonth('2026-10-21', 'fixed_day', 1).lateInMonth).toBe(true)
    expect(onboardingLateInMonth('2026-10-20', 'fixed_day', 1).lateInMonth).toBe(false)
  })
  it('the first bill near is late, on any day of the month', () => {
    const r = onboardingLateInMonth('2026-10-08', 'fixed_day', 15)
    expect(r).toEqual({ lateInMonth: true, nextRentDueDate: '2026-10-15' })
    expect(onboardingLateInMonth('2026-10-02', 'fixed_day', 15).lateInMonth).toBe(false)
  })
  it('rolls the due date into next month (and next year) once this month\'s has passed', () => {
    expect(onboardingLateInMonth('2026-12-18', 'fixed_day', 5).nextRentDueDate).toBe('2027-01-05')
  })
  it('a move-in-day property has no fixed bill date — only the 20th rule applies', () => {
    expect(onboardingLateInMonth('2026-10-08', 'move_in_day', 10)).toEqual({ lateInMonth: false, nextRentDueDate: null })
  })
  it('the banner carries the flag for each property', async () => {
    const f = await fixture()
    const res = await request(buildApp()).get('/api/landlords/me/onboarding-windows')
      .set('Authorization', `Bearer ${f.token}`)
    const w = res.body.data.find((x: any) => x.propertyId === f.propertyId)
    expect(typeof w.lateInMonth).toBe('boolean')
    expect(w.nextRentDueDate).toMatch(/^\d{4}-\d{2}-01$/)
  })
})
