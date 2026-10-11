/**
 * S550 — street-number address safety (pure helper).
 *
 * Property names repeat ("Oak Park" travels) and every park has an
 * "RV 01" — the street number on the lease is the coincidence-proof
 * check. Conflict ONLY when both sides carry a number and they differ.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../../test/dbHelpers'

// Don't send a real activation email when the confirmed supersede builds a lease.
const { emailTenantOnboardedMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailTenantOnboarded: emailTenantOnboardedMock,
}))

import { streetNumbersConflict, pickCandidateByAddress, resolveIntent } from './resolveIntent'

describe('streetNumbersConflict', () => {
  it('same street number → no conflict', () => {
    expect(streetNumbersConflict('22658 Highway 89 Yarnell AZ 85362', '22658 Highway 89')).toBe(false)
  })
  it('different street numbers → conflict (wrong Oak Park)', () => {
    expect(streetNumbersConflict('101 Desert Rose Ln', '22658 Highway 89')).toBe(true)
  })
  it('missing number on either side → no conflict (nothing to compare)', () => {
    expect(streetNumbersConflict('Highway 89 frontage', '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict('', '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict(null, '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict('22658 Highway 89', null)).toBe(false)
  })
})

describe('pickCandidateByAddress — two "Oak Park"s under one landlord', () => {
  const yarnell = { street1: '22658 Highway 89', name: 'Oak Park Yarnell' }
  const phoenix = { street1: '101 Desert Rose Ln', name: 'Oak Park Phoenix' }

  it('single candidate needs no address at all', () => {
    expect(pickCandidateByAddress([yarnell], null)).toBe(yarnell)
  })
  it('lease street number picks the right one of two', () => {
    expect(pickCandidateByAddress([yarnell, phoenix], '22658 Highway 89 Yarnell AZ 85362')).toBe(yarnell)
    expect(pickCandidateByAddress([yarnell, phoenix], '101 Desert Rose Ln, Phoenix AZ')).toBe(phoenix)
  })
  it('no usable address on the lease → ambiguous (never guess)', () => {
    expect(pickCandidateByAddress([yarnell, phoenix], 'Highway 89 frontage')).toBe('ambiguous')
    expect(pickCandidateByAddress([yarnell, phoenix], null)).toBe('ambiguous')
  })
  it('two candidates at the SAME street number → ambiguous', () => {
    const twin = { street1: '22658 Old Stage Rd', name: 'Oak Park Twin' }
    expect(pickCandidateByAddress([yarnell, twin], '22658 Highway 89')).toBe('ambiguous')
  })
})

// S582: resolving an imported lease into an already-leased unit must NOT silently
// end the sitting lease — it returns needsSupersedeConfirm; the actual supersede
// only happens once the landlord confirms.
describe('resolveIntent — supersede confirm gate', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  async function setup() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId, withLateFeeDecision: true })
      // sitting active lease + tenant on the unit (name 'Test Tenant' from seedTenant)
      const sittingTenant = await seedTenant(client)
      const oldLeaseId = await seedLease(client, { unitId, landlordId, status: 'active' })
      await seedLeaseTenant(client, { leaseId: oldLeaseId, tenantId: sittingTenant, role: 'primary' })
      await client.query('COMMIT')
      const prop = await db.query<{ name: string }>(`SELECT name FROM properties WHERE id=$1`, [propertyId])
      const unit = await db.query<{ unit_number: string }>(`SELECT unit_number FROM units WHERE id=$1`, [unitId])
      return { landlordId, unitId, oldLeaseId, propertyName: prop.rows[0].name, unitNumber: unit.rows[0].unit_number }
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  async function seedParsedIntent(landlordId: string, propertyName: string, unitNumber: string): Promise<string> {
    const email = `import-${randomUUID().slice(0, 6)}@test.dev`
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','New','Import') RETURNING id`, [email])
    const t = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1,'onboarded') RETURNING id`, [u.rows[0].id])
    const parserOutput = {
      tenants: [{ firstName: { value: 'New' }, lastName: { value: 'Import' }, email: { value: email }, phone: { value: '555-0000' } }],
      unit: { propertyName: { value: propertyName }, unitNumber: { value: unitNumber } },
      lease: { leaseStart: { value: '2026-02-01' }, monthlyRent: { value: 1000 } },
    }
    const i = await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, parser_output)
       VALUES ($1, $2, 'parsed', $3::jsonb) RETURNING id`,
      [landlordId, t.rows[0].id, JSON.stringify(parserOutput)])
    return i.rows[0].id
  }

  it('unit already leased → needsSupersedeConfirm, and the sitting lease is NOT ended', async () => {
    const s = await setup()
    const intentId = await seedParsedIntent(s.landlordId, s.propertyName, s.unitNumber)
    const res: any = await resolveIntent(intentId, [s.landlordId], {})
    expect(res.needsSupersedeConfirm).toBe(true)
    expect(res.supersedeLeaseId).toBe(s.oldLeaseId)
    expect(res.supersedeTenantName).toMatch(/Test Tenant/)
    // The sitting lease is untouched, and no new lease was built.
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [s.oldLeaseId])
    expect(old.rows[0].status).toBe('active')
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM leases WHERE unit_id=$1`, [s.unitId])
    expect(n.rows[0].n).toBe(1)
  })

  it('confirmSupersede=true → builds the lease and ends the prior one', async () => {
    const s = await setup()
    const intentId = await seedParsedIntent(s.landlordId, s.propertyName, s.unitNumber)
    const res: any = await resolveIntent(intentId, [s.landlordId], {}, { confirmSupersede: true })
    expect(res.leaseId).toBeTruthy()
    expect(res.supersededLeaseId).toBe(s.oldLeaseId)
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [s.oldLeaseId])
    expect(old.rows[0].status).toBe('terminated')
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM leases WHERE unit_id=$1 AND status='active'`, [s.unitId])
    expect(n.rows[0].n).toBe(1) // only the new one is active
  })
})

// S654: resolve takes the tenant's email from the landlord's own overrides, so
// it is a door onto any account on GAM. It follows the same rules as the other
// doors: only a resident's login is used, a password link is made only for an
// account that still needs setting up and belongs to no other company, and the
// link goes only by email to the address on the account, never back to the
// caller.
describe('S654: resolveIntent and existing accounts', () => {
  const PLACEHOLDER = '$2b$10$placeholder_invite_pending'
  beforeEach(async () => {
    await cleanupAllSchema()
    emailTenantOnboardedMock.mockClear()
  })

  async function company(email?: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c, email ? { email } : {})
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
      await c.query('COMMIT')
      const unitNumber = (await db.query(`SELECT unit_number FROM units WHERE id=$1`, [unitId])).rows[0].unit_number
      return { userId, landlordId, unitId, propertyName: 'Test Property', unitNumber }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  type Company = Awaited<ReturnType<typeof company>>

  /** The attack's setup: B's own intent for a throwaway address, in 'error'. */
  async function errorIntent(b: Company, email = `throwaway-${randomUUID().slice(0, 6)}@test.dev`) {
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'tenant', 'Throw', 'Away') RETURNING id`, [email, PLACEHOLDER])
    const t = await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    const i = await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'error') RETURNING id`,
      [b.landlordId, t.rows[0].id])
    return i.rows[0].id
  }

  const overridesFor = (b: Company, email: string): any => ({
    tenants: [{ firstName: { value: 'Vic' }, lastName: { value: 'Tim' }, email: { value: email } }],
    unit: { propertyName: { value: b.propertyName }, unitNumber: { value: b.unitNumber } },
    lease: { leaseStart: { value: '2026-02-01' }, monthlyRent: { value: 900 } },
  })

  const account = async (id: string) => (await db.query(
    `SELECT email, password_hash, tenant_invite_token, tenant_invite_expires_at FROM users WHERE id=$1`, [id])).rows[0]

  it("a resident with their own password gets no link, and their password is untouched", async () => {
    const b = await company()
    const email = `resident-${randomUUID().slice(0, 6)}@test.dev`
    const v = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, '$2b$10$their.own.real.password.hash', 'tenant', 'Vic', 'Tim') RETURNING id`, [email])).rows[0]
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [v.id])
    const before = await account(v.id)

    const res: any = await resolveIntent(await errorIntent(b), [b.landlordId], overridesFor(b, email.toUpperCase()))
    expect(res.userId).toBe(v.id)
    expect('activationUrl' in res).toBe(false)
    expect(res.alreadyOnPlatform).toBe(true)
    expect(res.inviteSent).toBe(false)
    expect(await account(v.id)).toEqual(before)
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it("another landlord's invitee gets no new link, and the first landlord's link keeps working", async () => {
    const a = await company()
    const b = await company()
    const email = `invitee-${randomUUID().slice(0, 6)}@test.dev`
    const v = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, $2, 'tenant', 'In', 'Vitee', 'first-live-link', NOW() + INTERVAL '7 days') RETURNING id`,
      [email, PLACEHOLDER])).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [v.id])).rows[0]
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [a.landlordId, t.id, a.unitId])
    const before = await account(v.id)

    const uploaded = await errorIntent(b)
    const res: any = await resolveIntent(uploaded, [b.landlordId], overridesFor(b, email))
    expect('activationUrl' in res).toBe(false)
    // S655 (Nic, 10/2): not refused, not attached — a lease sent to them to sign.
    expect(res.sentToSign).toBe(true)
    expect(res.message).toMatch(/another company/)
    expect(await account(v.id)).toEqual(before)
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
    expect((await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [b.unitId])).rows).toEqual([])
    // The upload's own invite was made for a different address (the landlord
    // corrected it): it is closed, never drafted into the household beside them.
    expect((await db.query(`SELECT cancelled_at FROM pending_tenant_intents WHERE id=$1`, [uploaded])).rows[0].cancelled_at).not.toBeNull()
    expect((await db.query(
      `SELECT tenant_id FROM pending_tenant_intents WHERE unit_id=$1 AND cancelled_at IS NULL`, [b.unitId])).rows)
      .toEqual([{ tenant_id: t.id }])
  })

  // A build that fails (the unit has no rent, or is already someone's) used to
  // leave the PDF's invite bound to the unit with no lease — and the hourly
  // sweep then drafted that household on its own, after the landlord was told
  // it had failed.
  it.each([
    ['the unit has no rent', async (b: Company) => { await db.query(`UPDATE units SET rent_amount = 0 WHERE id = $1`, [b.unitId]) }],
    ['the unit already has a lease', async (b: Company) => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const other = await seedTenant(c)
        const leaseId = await seedLease(c, { unitId: b.unitId, landlordId: b.landlordId, status: 'active' })
        await seedLeaseTenant(c, { leaseId, tenantId: other, role: 'primary' })
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    }],
  ])("a failed build for another company's resident leaves their invite exactly as it was (%s)", async (_why, breakUnit) => {
    const a = await company()
    const b = await company()
    const email = `resident-${randomUUID().slice(0, 6)}@test.dev`
    const v = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, '$2b$10$their.own.real.password.hash', 'tenant', 'Vic', 'Tim') RETURNING id`, [email])).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [v.id])).rows[0]
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [a.landlordId, t.id, a.unitId])
    const intentId = (await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'error') RETURNING id`,
      [b.landlordId, t.id])).rows[0].id
    await breakUnit(b)
    const snapshot = async () => (await db.query(
      `SELECT unit_id, property_id, draft_document_id, cancelled_at, resolved_at FROM pending_tenant_intents WHERE id=$1`,
      [intentId])).rows[0]
    const before = await snapshot()

    await expect(resolveIntent(intentId, [b.landlordId], overridesFor(b, email))).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
    expect(before.unit_id).toBeNull()
    expect((await db.query(
      `SELECT id FROM pending_tenant_intents WHERE unit_id=$1 AND tenant_id=$2`, [b.unitId, t.id])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM lease_documents WHERE unit_id=$1`, [b.unitId])).rows).toEqual([])
  })

  it("an e-sign witness another landlord set up gets no link", async () => {
    const a = await company()
    const b = await company()
    const email = `witness-${randomUUID().slice(0, 6)}@test.dev`
    const w = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'tenant', 'Wit', 'Ness') RETURNING id`, [email, PLACEHOLDER])).rows[0]
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'A lease', 'original_lease', 'sent') RETURNING id`, [a.landlordId, a.unitId])).rows[0]
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'witness', 'Wit Ness', $3, 3, $4, 'pending')`, [d.id, w.id, email, randomUUID()])

    const res: any = await resolveIntent(await errorIntent(b), [b.landlordId], overridesFor(b, email))
    expect(res.sentToSign).toBe(true)
    expect((await account(w.id)).tenant_invite_token).toBeNull()
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  // S655 (Nic, 10/2): "Imports are NEVER blocked." This used to refuse a
  // tenant of another landlord outright ("Cross-landlord onboarding requires
  // a separate flow"). Their paper lease now becomes a lease they sign: the
  // intent is bound to the unit, nothing active is written in their name,
  // and pressing Build again does not draft a second copy.
  it("another company's ACTIVE tenant is never refused: their PDF import becomes a lease sent to them to sign", async () => {
    const a = await company()
    const b = await company()
    await db.query(`UPDATE units SET rent_amount = 900 WHERE id = $1`, [b.unitId])
    const email = `resident-${randomUUID().slice(0, 6)}@test.dev`
    const v = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, '$2b$10$their.own.real.password.hash', 'tenant', 'Vic', 'Tim') RETURNING id`, [email])).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [v.id])).rows[0]
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const leaseId = await seedLease(c, { unitId: a.unitId, landlordId: a.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: t.id, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const intentId = (await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'error') RETURNING id`,
      [b.landlordId, t.id])).rows[0].id

    const res: any = await resolveIntent(intentId, [b.landlordId], overridesFor(b, email))
    expect(res.sentToSign).toBe(true)
    expect(res.tenantId).toBe(t.id)
    expect((await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [b.unitId])).rows).toEqual([])
    const bound = (await db.query(`SELECT unit_id, cancelled_at FROM pending_tenant_intents WHERE id=$1`, [intentId])).rows[0]
    expect(bound).toEqual({ unit_id: b.unitId, cancelled_at: null })
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it("a landlord's login, in any letter case, is refused and never made a resident", async () => {
    const a = await company(`Owner.${randomUUID().slice(0, 6)}@Test.dev`)
    const b = await company()
    const stored = (await account(a.userId)).email
    const before = await account(a.userId)

    await expect(resolveIntent(await errorIntent(b), [b.landlordId], overridesFor(b, stored.toLowerCase())))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/isn't a resident's/) })
    expect((await db.query(`SELECT id FROM tenants WHERE user_id=$1`, [a.userId])).rows).toEqual([])
    expect((await db.query(`SELECT id FROM leases WHERE unit_id=$1`, [b.unitId])).rows).toEqual([])
    expect(await account(a.userId)).toEqual(before)
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it("the landlord's own invitee who never set up gets the link by email, at the address on the account", async () => {
    const b = await company()
    const stored = `Kim.${randomUUID().slice(0, 6)}@Example.test`
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'tenant', 'Kim', 'H') RETURNING id`, [stored, PLACEHOLDER])).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    const intent = (await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'error') RETURNING id`,
      [b.landlordId, t.id])).rows[0]

    const res: any = await resolveIntent(intent.id, [b.landlordId], overridesFor(b, stored.toLowerCase()))
    expect(res.userId).toBe(u.id)
    expect('activationUrl' in res).toBe(false)
    expect(res.inviteSent).toBe(true)
    const token = (await account(u.id)).tenant_invite_token
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url] = emailTenantOnboardedMock.mock.calls[0]!
    expect(to).toBe(stored)
    expect(url).toMatch(new RegExp(`/accept-invite\\?token=${token}$`))
  })

  it('a brand-new address gets an account, and the link only by email', async () => {
    const b = await company()
    const email = `brand-new-${randomUUID().slice(0, 6)}@test.dev`
    const res: any = await resolveIntent(await errorIntent(b), [b.landlordId], overridesFor(b, email))
    expect('activationUrl' in res).toBe(false)
    expect(res.inviteSent).toBe(true)
    const u = (await db.query(`SELECT id, role, tenant_invite_token FROM users WHERE email=$1`, [email])).rows[0]
    expect(u.role).toBe('tenant')
    expect(u.tenant_invite_token).toMatch(/^[0-9a-f]{64}$/)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    expect(emailTenantOnboardedMock.mock.calls[0]![0]).toBe(email)
  })
})

// Final sweep (10/3): a paper import for another company's resident said
// "It's drafted… and waiting for your signature in Front Desk" even when
// nothing had drafted. It now reads like POST /me/onboard-tenant's message for
// the same person: the reason once, the step after it, and who was reached.
describe("final sweep: another company's resident — what the landlord is told", () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    emailTenantOnboardedMock.mockClear()
  })

  async function company() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
      await c.query('COMMIT')
      const unitNumber = (await db.query(`SELECT unit_number FROM units WHERE id=$1`, [unitId])).rows[0].unit_number
      return { userId, landlordId, propertyId, unitId, propertyName: 'Test Property', unitNumber }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  type Company = Awaited<ReturnType<typeof company>>

  /** A resident with their own password, living at `home` (another company). */
  async function residentAt(home: Company) {
    const email = `resident-${randomUUID().slice(0, 6)}@test.dev`
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, '$2b$10$their.own.real.password.hash', 'tenant', 'Vic', 'Tim') RETURNING id`, [email])).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const leaseId = await seedLease(c, { unitId: home.unitId, landlordId: home.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: t.id, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    return { userId: u.id, tenantId: t.id, email }
  }

  const intentFor = async (b: Company, tenantId: string, draftDocumentId: string | null = null) => (await db.query<{ id: string }>(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, draft_document_id)
     VALUES ($1, $2, 'error', $3) RETURNING id`, [b.landlordId, tenantId, draftDocumentId])).rows[0].id

  const overridesFor = (b: Company, email: string): any => ({
    tenants: [{ firstName: { value: ' Vic ' }, lastName: { value: 'Tim' }, email: { value: email } }],
    unit: { propertyName: { value: b.propertyName }, unitNumber: { value: b.unitNumber } },
    lease: { leaseStart: { value: '2026-02-01' }, monthlyRent: { value: 900 } },
  })

  it('nothing drafted: says so, gives the reason once and the step after it, and who was reached', async () => {
    const a = await company()
    const b = await company()   // no default lease for this kind of unit
    const r = await residentAt(a)

    const res: any = await resolveIntent(await intentFor(b, r.tenantId), [b.landlordId], overridesFor(b, r.email))
    expect(res.sentToSign).toBe(true)
    expect(res.draftedDocumentIds).toEqual([])
    expect(res.draftBlocked.length).toBeGreaterThan(0)
    const msg: string = res.message
    expect(msg).toMatch(/^Vic Tim already has a GAM account with another company/)
    expect(msg).toMatch(/could not be drafted yet/)
    expect(msg).not.toMatch(/waiting for your signature/)
    expect(msg).toContain(res.draftBlocked[0])
    expect(msg).not.toMatch(/\.\./)
    expect(msg.match(/drafts on its own/g)).toHaveLength(1)
    expect(msg.match(/Front Desk/g)).toHaveLength(1)
    expect(msg).toMatch(/Once it is drafted, sign it in Front Desk\./)
    // The usual invite went instead: a notice in the account they already use.
    expect(res.fallbackSent).toBe(true)
    expect(msg).toMatch(/sent a notice in their GAM account/)
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it('drafted: waiting for the landlord\'s signature in Front Desk, from the unit\'s own setup', async () => {
    const a = await company()
    const b = await company()
    await db.query(
      `UPDATE property_unit_type_late_fees
          SET no_late_fee = true, late_fee_grace_days = NULL, late_fee_initial_amount = NULL, late_fee_initial_type = NULL
        WHERE property_id = $1`, [b.propertyId])
    const tid = (await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
       VALUES ($1, 'Primary Apartment', 1, 'apartment', 1, 12, true) RETURNING id`, [b.landlordId])).rows[0].id
    for (const col of ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']) {
      await db.query(
        `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
         VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, col])
    }
    const r = await residentAt(a)

    const res: any = await resolveIntent(await intentFor(b, r.tenantId), [b.landlordId], overridesFor(b, r.email))
    expect(res.sentToSign).toBe(true)
    expect(res.draftedDocumentIds).toHaveLength(1)
    expect(res.fallbackSent).toBe(false)
    expect(res.message).toMatch(/is waiting for your signature in Front Desk/)
    expect(res.message).toMatch(/not the paper's terms/)
    expect(res.message).not.toMatch(/could not be drafted/)
    expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  })

  it('pressing Build again after the landlord signed says it waits on THEIR signature, not his', async () => {
    const a = await company()
    const b = await company()
    const r = await residentAt(a)
    const doc = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'A lease', 'original_lease', 'in_progress') RETURNING id`, [b.landlordId, b.unitId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'landlord', 'L L', 'll@test.dev', 1, $3, 'signed'),
              ($1, $4, 'primary', 'Vic Tim', $5, 2, $6, 'sent')`,
      [doc, b.userId, randomUUID(), r.userId, r.email, randomUUID()])
    await db.query(`UPDATE units SET rent_amount = 900 WHERE id = $1`, [b.unitId])

    const res: any = await resolveIntent(await intentFor(b, r.tenantId, doc), [b.landlordId], overridesFor(b, r.email))
    expect(res.sentToSign).toBe(true)
    expect(res.draftedDocumentIds).toEqual([doc])
    expect(res.fallbackSent).toBe(false)
    expect(res.message).toMatch(/you have signed it; it is waiting on their signature/)
    expect(res.message).not.toMatch(/waiting for your signature/)
    // Final sweep (10/3): the sentence before is about a person, so "Its lease"
    // had nothing to refer to. It names the lease plainly.
    expect(res.message).toBe(
      `Vic Tim already has a GAM account with another company, so they sign this lease themselves. ` +
      `The lease for Unit ${b.unitNumber} is drafted and you have signed it; it is waiting on their signature, ` +
      `and it starts when they sign. Nothing is billed before then.`)
    expect(res.message).not.toMatch(/\bIts\b/)
  })
})
