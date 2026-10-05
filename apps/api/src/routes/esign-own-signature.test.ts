/**
 * S655 (Nic, 10/2) — "Nobody is attached to a company without their OWN
 * signature."
 *
 * Imports are never blocked, so a lease can be drafted for somebody who
 * already has a GAM account with ANOTHER company. For them the landlord's
 * signature (which, since S647, issues and bills everyone else's lease) issues
 * nothing: no lease, no bill, not this company's tenant — until they sign it
 * themselves. Everyone else is unchanged.
 *
 * Also here, because it happens at the same moment: an old system's balance
 * from the tenant CSV's draft roster posts as ONE charge on the household's
 * lease when it issues.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'
import { tenantsNeedingOwnSignature, inviteHouseholdToNewLease } from '../services/newLeaseInvite'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_own_signature'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function company() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId,
      token: sign({ userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Co = Awaited<ReturnType<typeof company>>

async function resident() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const email = `r-${randomUUID().slice(0, 8)}@test.dev`
    const tenantId = await seedTenant(c, { email })
    const userId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return { tenantId, userId, email,
      token: sign({ userId, role: 'tenant', email, profileId: tenantId, permissions: {} }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Res = Awaited<ReturnType<typeof resident>>

/** Company `co` has them on file: an open invite there (not a home — that would overlap). */
async function invitedAt(co: Co, r: Res) {
  await db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id)
     VALUES ($1,$2,'not_uploaded',$3,$4)`, [co.landlordId, r.tenantId, co.unitId, co.propertyId])
}

/** They live at company `co` (an active lease there). */
async function livesAt(co: Co, r: Res) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const unitId = await seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: co.landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId: r.tenantId, role: 'primary' })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A drafted lease on `co`'s unit with both parties unsigned, and the invite it
 * came from (a new one, or `intentId` — an invite that already exists).
 */
async function draftFor(co: Co, r: Res, intentId?: string, start = '2025-01-01'): Promise<string> {
  const documentId = (await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Lease','original_lease','in_progress') RETURNING id`, [co.landlordId, co.unitId])).rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent'),
            ($1,$4,'primary','R R',$5,2,$6,'sent')`,
    [documentId, co.userId, crypto.randomBytes(32).toString('hex'), r.userId, r.email, crypto.randomBytes(32).toString('hex')])
  for (const [col, val] of Object.entries({
    start_date: start, end_date: '2027-12-31', rent_amount: '1200.00',
    security_deposit: '1200.00', rent_due_day: '1', lease_type: 'fixed_term', auto_renew: 'false',
  })) {
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
  }
  if (intentId) {
    await db.query(`UPDATE pending_tenant_intents SET draft_document_id=$2 WHERE id=$1`, [intentId, documentId])
  } else {
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id, draft_document_id)
       VALUES ($1,$2,'not_uploaded',$3,$4,$5)`, [co.landlordId, r.tenantId, co.unitId, co.propertyId, documentId])
  }
  return documentId
}

const signAs = (documentId: string, token: string) =>
  request(buildApp()).post(`/api/esign/sign/${documentId}`).set('Authorization', `Bearer ${token}`).send({ fieldValues: [] })
const leasesOn = (unitId: string) => db.query(`SELECT * FROM leases WHERE unit_id=$1`, [unitId]).then(r => r.rows)
const chargesOn = (unitId: string) => db.query(`SELECT type, amount::float AS amount FROM payments WHERE unit_id=$1`, [unitId]).then(r => r.rows)

describe("another company's resident signs their own lease", () => {
  it("the landlord's signature issues nothing and bills nothing", async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await invitedAt(a, r)
    const documentId = await draftFor(b, r)
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([r.userId])

    const res = await signAs(documentId, b.token)
    expect(res.status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])
    expect((await db.query(`SELECT issued_at FROM lease_documents WHERE id=$1`, [documentId])).rows[0].issued_at).toBeNull()
    // Not this company's tenant: no lease_tenants row with company B.
    expect((await db.query(
      `SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id WHERE lt.tenant_id=$1 AND l.landlord_id=$2`,
      [r.tenantId, b.landlordId])).rows).toEqual([])
  })

  it('their own signature is what creates the lease and its first bill — once', async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await invitedAt(a, r)
    const documentId = await draftFor(b, r)
    await signAs(documentId, b.token)
    const res = await signAs(documentId, r.token)
    expect(res.status).toBe(200)
    expect(res.body.data.completed).toBe(true)
    const leases = await leasesOn(b.unitId)
    expect(leases).toHaveLength(1)
    expect(leases[0].signed_by_tenant).toBe(true)
    expect((await chargesOn(b.unitId)).length).toBeGreaterThan(0)
  })
})

describe('everyone else is unchanged', () => {
  it("a brand-new person's lease still issues on the landlord's signature", async () => {
    const b = await company()
    const r = await resident()
    const documentId = await draftFor(b, r)
    expect(await tenantsNeedingOwnSignature(documentId)).toEqual([])
    await signAs(documentId, b.token)
    expect(await leasesOn(b.unitId)).toHaveLength(1)
  })

  it('someone already on a lease with this company issues on the landlord\'s signature, whatever else they have', async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await livesAt(a, r)
    await livesAt(b, r)
    const documentId = await draftFor(b, r)
    expect(await tenantsNeedingOwnSignature(documentId)).toEqual([])
  })

  it("a renter-pool applicant (GAM's own pool, no other company) issues on the landlord's signature", async () => {
    const b = await company()
    const r = await resident()
    const pool = (await db.query<{ id: string }>(
      `WITH u AS (INSERT INTO users (email, password_hash, role, first_name, last_name)
                  VALUES ($1, 'x', 'landlord', 'GAM', 'Pool') RETURNING id)
       INSERT INTO landlords (user_id, is_system) SELECT id, true FROM u RETURNING id`,
      [`pool-${randomUUID().slice(0, 6)}@gam.test`])).rows[0].id
    await db.query(
      `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, consent_pool)
       VALUES ($1, $2, $3, 'approved', true)`, [pool, r.userId, r.tenantId])
    const documentId = await draftFor(b, r)
    expect(await tenantsNeedingOwnSignature(documentId)).toEqual([])
  })
})

describe("the old system's balance (tenant CSV roster)", () => {
  async function onRoster(co: Co, r: Res, balance: number) {
    const intentId = (await db.query<{ id: string }>(
      `SELECT id FROM pending_tenant_intents WHERE tenant_id=$1 AND unit_id=$2`, [r.tenantId, co.unitId])).rows[0].id
    await db.query(
      `INSERT INTO tenant_roster_drafts (landlord_id, property_id, unit_id, first_name, last_name, email,
                                         opening_balance, confirmed_at, intent_id)
       VALUES ($1,$2,$3,'R','R',$4,$5,NOW(),$6)`, [co.landlordId, co.propertyId, co.unitId, r.email, balance, intentId])
  }
  const openingBalances = (unitId: string) => db.query(
    `SELECT i.total_amount::float AS amount, i.late_fee_exempt, p.type, p.amount::float AS charge
       FROM invoices i JOIN payments p ON p.invoice_id = i.id
      WHERE i.unit_id = $1 AND i.is_opening_balance`, [unitId]).then(r => r.rows)

  it('posts as ONE carried-balance charge, with no late fees, when the landlord signs — and never again', async () => {
    const b = await company()
    const r = await resident()
    const documentId = await draftFor(b, r)
    await onRoster(b, r, 250)
    await signAs(documentId, b.token)
    expect(await openingBalances(b.unitId)).toEqual([{ amount: 250, late_fee_exempt: true, type: 'carried_balance', charge: 250 }])
    await signAs(documentId, r.token)
    expect(await openingBalances(b.unitId)).toHaveLength(1)
  })

  it("for another company's resident it posts when THEY sign, not before", async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await invitedAt(a, r)
    const documentId = await draftFor(b, r)
    await onRoster(b, r, 80)
    await signAs(documentId, b.token)
    expect(await openingBalances(b.unitId)).toEqual([])
    await signAs(documentId, r.token)
    expect(await openingBalances(b.unitId)).toEqual([{ amount: 80, late_fee_exempt: true, type: 'carried_balance', charge: 80 }])
  })

  it('a confirmed roster person invited to the same unit again after their lease ends is never billed the old balance twice', async () => {
    const b = await company()
    const r = await resident()
    const first = await draftFor(b, r)
    await onRoster(b, r, 250)
    await signAs(first, b.token)
    expect(await openingBalances(b.unitId)).toHaveLength(1)

    // The tenancy ends; the landlord invites the same person to the same unit.
    await db.query(`UPDATE leases SET status='terminated', end_date=CURRENT_DATE WHERE unit_id=$1`, [b.unitId])
    await db.query(`UPDATE lease_tenants SET status='removed' WHERE tenant_id=$1`, [r.tenantId])
    await inviteHouseholdToNewLease({
      unitId: b.unitId, people: [{ firstName: 'R', lastName: 'R', email: r.email }],
      authorize: () => {}, ownCompanies: [b.landlordId], byUserId: b.userId,
      existingResident: false, source: 'roster', requireUnitSetup: false,
    })
    const reopened = (await db.query(
      `SELECT id, resolved_at FROM pending_tenant_intents WHERE tenant_id=$1 AND unit_id=$2`, [r.tenantId, b.unitId])).rows
    expect(reopened).toHaveLength(1)
    expect(reopened[0].resolved_at).toBeNull()

    const second = await draftFor(b, r, reopened[0].id, '2026-06-01')
    expect((await signAs(second, b.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toHaveLength(2)
    expect(await openingBalances(b.unitId)).toHaveLength(1)
    const stamped = (await db.query(
      `SELECT opening_balance_posted_at, opening_balance_invoice_id FROM tenant_roster_drafts WHERE email=$1`, [r.email])).rows[0]
    expect(stamped.opening_balance_posted_at).not.toBeNull()
    expect(stamped.opening_balance_invoice_id).not.toBeNull()
  })

  it('nothing posts for a household with no old balance', async () => {
    const b = await company()
    const r = await resident()
    const documentId = await draftFor(b, r)
    await signAs(documentId, b.token)
    expect(await openingBalances(b.unitId)).toEqual([])
  })
})

describe("an overlapping home with another company", () => {
  // Nic (10/2): "Imports are NEVER blocked." The landlord's import and his
  // signature go through; nothing issues before the resident signs, and the
  // resident's own signature is where the overlap is settled.
  it("never refuses the landlord's signature; the resident's own signature is refused, without naming that company's unit", async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await livesAt(a, r)
    const aUnit = (await db.query(
      `SELECT u.unit_number FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.landlord_id = $1`, [a.landlordId])).rows[0].unit_number
    const documentId = await draftFor(b, r)
    const landlord = await signAs(documentId, b.token)
    expect(landlord.status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    const theirs = await signAs(documentId, r.token)
    expect(theirs.status).toBe(409)
    // Said to them about their own home, with what to do next.
    expect(theirs.body.error).toMatch(/You still have a lease with another company that overlaps this one/)
    expect(theirs.body.error).toMatch(/ask that landlord to end it/)
    expect(theirs.body.error).not.toContain(aUnit)
    expect(await leasesOn(b.unitId)).toEqual([])
  })

  it("never refuses the landlord's Send either", async () => {
    const a = await company()
    const b = await company()
    const r = await resident()
    await livesAt(a, r)
    const documentId = await draftFor(b, r)
    const sent = await request(buildApp()).post(`/api/esign/documents/${documentId}/send`)
      .set('Authorization', `Bearer ${b.token}`).send({})
    expect(sent.status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
  })

  it('an overlap with the SAME company still refuses the landlord (it is his own double-booking)', async () => {
    const b = await company()
    const r = await resident()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const leaseId = await seedLease(c, { unitId: b.unitId, landlordId: b.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: r.tenantId, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const documentId = await draftFor(b, r)
    const res = await signAs(documentId, b.token)
    expect(res.status).toBe(409)
  })
})

describe('an add-a-roommate addendum never attaches anyone on the landlord\'s signature alone', () => {
  /** B's own household: an active lease on a new unit with `holder` on it. */
  async function householdAt(co: Co, holder: Res): Promise<{ leaseId: string; unitId: string }> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: co.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: holder.tenantId, role: 'primary' })
      await c.query('COMMIT')
      return { leaseId, unitId }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  /** The addendum as POST /documents/addendum-add writes it: the document and a 'pending_add' spot. */
  async function addendumAdding(co: Co, home: { leaseId: string; unitId: string }, holder: Res, added: Res): Promise<string> {
    const documentId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
       VALUES ($1,$2,$3,'Add a roommate','addendum_add','in_progress') RETURNING id`,
      [co.landlordId, home.unitId, home.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent'),
              ($1,$4,'primary','H H',$5,2,$6,'sent'),
              ($1,$7,'co_tenant_1','R R',$8,3,$9,'sent')`,
      [documentId, co.userId, crypto.randomBytes(32).toString('hex'),
       holder.userId, holder.email, crypto.randomBytes(32).toString('hex'),
       added.userId, added.email, crypto.randomBytes(32).toString('hex')])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_reason, financial_responsibility, add_document_id)
       VALUES ($1,$2,'co_tenant','pending_add','roommate_added','joint_several',$3)`,
      [home.leaseId, added.tenantId, documentId])
    return documentId
  }
  const spotOf = (leaseId: string, r: Res) => db.query(
    `SELECT status FROM lease_tenants WHERE lease_id=$1 AND tenant_id=$2`, [leaseId, r.tenantId]).then(x => x.rows[0]?.status)

  it("another company's resident stays only proposed after the landlord signs, and joins when they sign", async () => {
    const a = await company()
    const b = await company()
    const holder = await resident()
    const r = await resident()
    await invitedAt(a, r)
    const home = await householdAt(b, holder)
    const documentId = await addendumAdding(b, home, holder, r)
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([r.userId])

    expect((await signAs(documentId, b.token)).status).toBe(200)
    expect(await spotOf(home.leaseId, r)).toBe('pending_add')
    expect((await signAs(documentId, holder.token)).status).toBe(200)
    expect(await spotOf(home.leaseId, r)).toBe('pending_add')
    const theirs = await signAs(documentId, r.token)
    expect(theirs.status).toBe(200)
    expect(theirs.body.data.reason).toBeUndefined()
    expect(theirs.body.data.completed).toBe(true)
    expect(await spotOf(home.leaseId, r)).toBe('active')
  })

  it('an unsigned addendum somewhere else in the account does not excuse them on a new lease', async () => {
    const a = await company()
    const b = await company()
    const holder = await resident()
    const r = await resident()
    await invitedAt(a, r)
    const home = await householdAt(b, holder)
    await addendumAdding(b, home, holder, r)
    const documentId = await draftFor(b, r)
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([r.userId])
    await signAs(documentId, b.token)
    expect(await leasesOn(b.unitId)).toEqual([])
  })

  it('a roommate spot they never signed for, ended with its lease, still leaves them needing their own signature', async () => {
    // Ending a lease (the landlord's PATCH, a termination, the nightly
    // lease-end job) makes an unsigned 'pending_add' spot 'void' (final sweep,
    // 10/3; before that it became 'removed'). That person never signed onto
    // anything.
    const a = await company()
    const b = await company()
    const holder = await resident()
    const r = await resident()
    await invitedAt(a, r)
    const home = await householdAt(b, holder)
    await addendumAdding(b, home, holder, r)
    await db.query(`UPDATE leases SET lease_type = 'month_to_month', end_date = NULL WHERE id = $1`, [home.leaseId])
    const ended = await request(buildApp()).patch(`/api/leases/${home.leaseId}`)
      .set('Authorization', `Bearer ${b.token}`).send({ status: 'terminated' })
    expect(ended.status).toBe(200)
    expect(await spotOf(home.leaseId, r)).toBe('void')

    const documentId = await draftFor(b, r)
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([r.userId])
    expect((await signAs(documentId, b.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])
    expect((await db.query(
      `SELECT lt.status FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
        WHERE lt.tenant_id = $1 AND l.landlord_id = $2 AND lt.status = 'active'`,
      [r.tenantId, b.landlordId])).rows).toEqual([])
  })

  it("a never-signed roommate spot an older lease ending marked 'removed' (before 10/3) still does not count", async () => {
    const a = await company()
    const b = await company()
    const holder = await resident()
    const r = await resident()
    await invitedAt(a, r)
    const home = await householdAt(b, holder)
    await addendumAdding(b, home, holder, r)
    await db.query(
      `UPDATE lease_tenants SET status = 'removed', removed_at = NOW(), removed_reason = 'lease_ended'
        WHERE lease_id = $1 AND tenant_id = $2`, [home.leaseId, r.tenantId])
    await db.query(`UPDATE leases SET status = 'terminated', terminated_at = NOW() WHERE id = $1`, [home.leaseId])

    const documentId = await draftFor(b, r)
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([r.userId])
  })

  it('a roommate spot they DID sign for, later ended, makes them this company\'s tenant already', async () => {
    const a = await company()
    const b = await company()
    const holder = await resident()
    const r = await resident()
    await invitedAt(a, r)
    const home = await householdAt(b, holder)
    const addendum = await addendumAdding(b, home, holder, r)
    await signAs(addendum, b.token)
    await signAs(addendum, holder.token)
    expect((await signAs(addendum, r.token)).status).toBe(200)
    expect(await spotOf(home.leaseId, r)).toBe('active')
    await db.query(`UPDATE leases SET lease_type = 'month_to_month', end_date = NULL WHERE id = $1`, [home.leaseId])
    expect((await request(buildApp()).patch(`/api/leases/${home.leaseId}`)
      .set('Authorization', `Bearer ${b.token}`).send({ status: 'terminated' })).status).toBe(200)
    expect(await spotOf(home.leaseId, r)).toBe('removed')

    const documentId = await draftFor(b, r)
    expect(await tenantsNeedingOwnSignature(documentId)).toEqual([])
  })
})

describe('a household with one of this company\'s residents and one of another company\'s', () => {
  /** One lease for several people, signing in this order after the landlord. */
  async function draftForHousehold(co: Co, people: Res[]): Promise<string> {
    const documentId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Lease','original_lease','in_progress') RETURNING id`, [co.landlordId, co.unitId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent')`,
      [documentId, co.userId, crypto.randomBytes(32).toString('hex')])
    for (let i = 0; i < people.length; i++) {
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sent')`,
        [documentId, people[i].userId, i === 0 ? 'primary' : `co_tenant_${i}`, `Person ${i + 1}`, people[i].email,
         i + 2, crypto.randomBytes(32).toString('hex')])
      await db.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id, draft_document_id)
         VALUES ($1,$2,'not_uploaded',$3,$4,$5)`, [co.landlordId, people[i].tenantId, co.unitId, co.propertyId, documentId])
    }
    for (const [col, val] of Object.entries({
      start_date: '2025-01-01', end_date: '2027-12-31', rent_amount: '1200.00',
      security_deposit: '1200.00', rent_due_day: '1', lease_type: 'fixed_term', auto_renew: 'false',
    })) {
      await db.query(
        `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
         VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
    }
    return documentId
  }
  const onLease = (unitId: string) => db.query(
    `SELECT lt.tenant_id, lt.status FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
      WHERE l.unit_id = $1 ORDER BY lt.role DESC`, [unitId]).then(x => x.rows)

  it('issues the moment the other company\'s resident signs (the landlord already signed), not when everyone has', async () => {
    const a = await company()
    const b = await company()
    const theirs = await resident()   // another company has them on file
    const ours = await resident()     // new to GAM: this company's from the landlord's signature
    await invitedAt(a, theirs)
    const documentId = await draftForHousehold(b, [theirs, ours])
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([theirs.userId])

    expect((await signAs(documentId, b.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])

    // Their signature was the only consent missing: the lease issues and bills now.
    const signed = await signAs(documentId, theirs.token)
    expect(signed.status).toBe(200)
    expect(signed.body.data.completed).not.toBe(true)
    const leases = await leasesOn(b.unitId)
    expect(leases).toHaveLength(1)
    expect((await chargesOn(b.unitId)).length).toBeGreaterThan(0)
    expect((await onLease(b.unitId)).map((t: any) => t.status)).toEqual(['active', 'active'])
    expect((await db.query(`SELECT issued_at, status FROM lease_documents WHERE id=$1`, [documentId])).rows[0].issued_at).not.toBeNull()

    // This company's resident signs last: the document completes, nothing is built or billed twice.
    const charges = (await chargesOn(b.unitId)).length
    const last = await signAs(documentId, ours.token)
    expect(last.status).toBe(200)
    expect(last.body.data.completed).toBe(true)
    expect(await leasesOn(b.unitId)).toHaveLength(1)
    expect((await chargesOn(b.unitId)).length).toBe(charges)
  })

  it('with two of another company\'s residents, the first of them signing issues nothing; the second does', async () => {
    const a = await company()
    const b = await company()
    const one = await resident()
    const two = await resident()
    const ours = await resident()
    await invitedAt(a, one)
    await invitedAt(a, two)
    const documentId = await draftForHousehold(b, [one, two, ours])
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId).sort()).toEqual([one.userId, two.userId].sort())

    await signAs(documentId, b.token)
    expect((await signAs(documentId, one.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])
    expect((await signAs(documentId, two.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toHaveLength(1)
    expect((await chargesOn(b.unitId)).length).toBeGreaterThan(0)
  })

  it("another company's resident's overlapping home never refuses a household member signing ahead of them; their own signature is refused", async () => {
    // The dead end this closes: the landlord signed, the person listed first
    // (this company's resident) was refused over the OTHER person's lease
    // elsewhere — which they cannot end, and which the refusal described to
    // them — and the other person never reached their own turn.
    const a = await company()
    const b = await company()
    const ours = await resident()
    const theirs = await resident()
    await livesAt(a, theirs)
    const aUnit = (await db.query(
      `SELECT u.unit_number FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.landlord_id = $1`, [a.landlordId])).rows[0].unit_number
    const documentId = await draftForHousehold(b, [ours, theirs])
    expect((await tenantsNeedingOwnSignature(documentId)).map(x => x.userId)).toEqual([theirs.userId])

    expect((await signAs(documentId, b.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])

    const mine = await signAs(documentId, ours.token)
    expect(mine.status).toBe(200)
    expect(mine.body.data.completed).not.toBe(true)
    // Their signature issues nothing: the lease still waits on the other company's resident.
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])

    const refused = await signAs(documentId, theirs.token)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/You still have a lease with another company that overlaps this one/)
    expect(refused.body.error).not.toContain(aUnit)
    expect((await db.query(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [documentId, theirs.userId])).rows[0].status)
      .not.toBe('signed')
    expect(await leasesOn(b.unitId)).toEqual([])
    expect(await chargesOn(b.unitId)).toEqual([])
  })

  it("this company's own household member signing first changes nothing while the other company's resident hasn't signed", async () => {
    const a = await company()
    const b = await company()
    const ours = await resident()
    const theirs = await resident()
    await invitedAt(a, theirs)
    const documentId = await draftForHousehold(b, [ours, theirs])
    await signAs(documentId, b.token)
    expect((await signAs(documentId, ours.token)).status).toBe(200)
    expect(await leasesOn(b.unitId)).toEqual([])
    const last = await signAs(documentId, theirs.token)
    expect(last.body.data.completed).toBe(true)
    expect(await leasesOn(b.unitId)).toHaveLength(1)
  })
})
