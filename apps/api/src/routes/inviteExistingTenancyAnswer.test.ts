/**
 * 10/19 (Nic): "Fix invite flag overridden in first 28 days."
 *
 * Whether an invite papers a tenancy that ALREADY EXISTS decides real money.
 * An existing resident's page 8 is all zeros plus one whole month's rent —
 * nothing about their tenancy started the day they signed, only the paperwork
 * did, and they already paid the landlord for the month off-platform. A genuine
 * new move-in is billed the prorated stretch, the security deposit, the pet and
 * utility deposits and the move-in fee.
 *
 * Two rules used to decide it. The right one is the app's (services/
 * newLeaseInvite + services/onboardingWindow): the landlord ATTESTS it, and the
 * onboarding window — the property's, or the landlord's own 28 days — has to be
 * open. The wrong one was a database trigger that looked only at the landlord's
 * age and only ever forced the flag ON. Because the column is NOT NULL DEFAULT
 * false it could not tell "the landlord said new move-in" from "nobody said
 * anything", so for an account's first 28 days it overwrote an explicit new
 * move-in with "they already live here" and zeroed that money — on the one
 * screen where nobody could put it back.
 *
 * These need migration 20261021160000, which is not on production yet:
 *   DB_NAME=<yours>_test TEST_APPLY_MIGRATIONS_AFTER=20261020125959 npx vitest run
 * (the package script's DB_NAME=gam_test builds from schema.sql alone, and
 * schema.sql still carries the trigger.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
  emailTenantInvite: vi.fn(async () => undefined),
  emailTenantOnboarded: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { createDocumentRecord } from './esign'
import { inviteHouseholdToNewLease } from '../services/newLeaseInvite'
import { getOnboardingWindow, listOnboardingWindowsForLandlord } from '../services/onboardingWindow'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_existing_tenancy_answer'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

// Page 8 IS the move-in invoice (S648). These are the boxes the answer moves.
const FEE_BOXES = ['pet_deposit', 'utility_deposit', 'move_in_fee']
const RENT_BOXES = ['move_in_first_month_rent', 'move_in_proration', 'move_in_security_deposit', 'move_in_total_due']
const PAGE2 = ['rent_amount', 'start_date', 'security_deposit']

/**
 * A company whose account was created just now — so the landlord's own 28-day
 * migration window is OPEN and the property's is not (seedProperty never stamps
 * onboarding_started_at). That is the exact state the trigger used to speak in.
 */
async function company(opts: { accountAgeDays?: number; propertyWindowOpen?: boolean;
                               propertyWindowStartedDaysAgo?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    if (opts.accountAgeDays != null) {
      await c.query(`UPDATE landlords SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [landlordId, String(opts.accountAgeDays)])
    }
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.propertyWindowOpen) {
      await c.query(`UPDATE properties SET onboarding_started_at = now() WHERE id = $1`, [propertyId])
    }
    // The band: a property whose window opened long enough ago to have CLOSED
    // (base 14 days under 10 units) while the account is still inside its own 28.
    if (opts.propertyWindowStartedDaysAgo != null) {
      await c.query(
        `UPDATE properties SET onboarding_started_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [propertyId, String(opts.propertyWindowStartedDaysAgo)])
    }
    const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
    // A fixed mid-month start, so the prorated stretch is the same figure on
    // every run (the draft takes the unit's available date when it is future).
    await c.query(
      `UPDATE units SET unit_type='apartment', rent_amount=500, security_deposit=350,
              available_date='2099-09-16' WHERE id=$1`, [unitId])
    // late_fee_terms: the property carries a late-fee policy (seedUnit's
    // decision), and drafting refuses unless the terms APPEAR in the document.
    // This template states them as a clause, which is how most leases do it.
    const tpl = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, unit_type, is_unit_type_default, base_pdf_url, is_active, late_fee_terms)
       VALUES ($1,'Lease','apartment',TRUE,'/uploads/lease.pdf',TRUE,
               '{"graceDays":5,"initialAmount":25,"initialType":"flat"}'::jsonb)
       RETURNING id`, [landlordId])
    const templateId = tpl.rows[0].id
    const box = async (tag: string, page: number, i: number) => c.query(
      `INSERT INTO lease_template_fields
         (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
       VALUES ($1,'text','landlord',$2,$2,$3,10,$4,80,14,FALSE)`, [templateId, tag, page, 20 * i + 20])
    for (const [i, tag] of PAGE2.entries()) await box(tag, 2, i)
    for (const [i, tag] of [...RENT_BOXES, ...FEE_BOXES].entries()) await box(tag, 8, i)
    // The property's own fee list for apartments — what a NEW resident is billed.
    await c.query(
      `INSERT INTO property_fee_schedules (property_id, unit_type, fee_type, amount, is_refundable, due_timing) VALUES
         ($1,'apartment','pet_deposit',350,TRUE,'move_in'),
         ($1,'apartment','utility_deposit',100,TRUE,'move_in'),
         ($1,'apartment','move_in_fee',50,FALSE,'move_in')`, [propertyId])
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, templateId,
      token: jwt.sign({ userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Co = Awaited<ReturnType<typeof company>>

/** Door 1 — "Add one tenant" (POST /me/onboard-tenant-pending, routes/landlords). */
async function addOneTenant(co: Co, existingResident: boolean) {
  const res = await request(buildApp())
    .post('/api/landlords/me/onboard-tenant-pending')
    .set('Authorization', `Bearer ${co.token}`)
    .send({ firstName: 'Kay', lastName: 'Howard', email: `kay-${randomUUID().slice(0, 8)}@test.dev`,
            unitId: co.unitId, existingResident })
  expect(res.status).toBe(200)
  return res.body.data.intentId as string
}

/** Door 2 — the new-lease invite (services/newLeaseInvite), which drafts as it goes. */
async function inviteHousehold(co: Co, existingResident: boolean, email?: string) {
  const out = await inviteHouseholdToNewLease({
    unitId: co.unitId,
    people: [{ firstName: 'Clint', lastName: 'Cook', email: email ?? `clint-${randomUUID().slice(0, 8)}@test.dev` }],
    authorize: () => {}, ownCompanies: [co.landlordId], byUserId: co.userId,
    existingResident, source: 'invite',
  })
  return { intentId: out.people[0].intentId, email: out.people[0].email }
}

const flagOf = async (intentId: string) => (await db.query<{ f: boolean }>(
  `SELECT is_existing_tenancy AS f FROM pending_tenant_intents WHERE id = $1`, [intentId])).rows[0].f

/**
 * Draft the lease and read page 8 — the money the answer decides. A resident
 * must already be invited to the unit: the prefill reads their invite.
 */
async function pageEight(co: Co): Promise<Record<string, string | null>> {
  const tenantUser = (await db.query<{ user_id: string; email: string }>(
    `SELECT t.user_id, u.email FROM pending_tenant_intents i
       JOIN tenants t ON t.id = i.tenant_id JOIN users u ON u.id = t.user_id
      WHERE i.unit_id = $1 AND i.cancelled_at IS NULL ORDER BY i.created_at LIMIT 1`, [co.unitId])).rows[0]
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: co.landlordId, templateId: co.templateId, unitId: co.unitId, leaseId: null,
      title: 'Lease', basePdfUrl: null, documentType: 'original_lease' as any,
      targetLeaseTenantId: null, promoteLeaseTenantId: null,
      signers: [
        { userId: co.userId, role: 'landlord', name: 'LL', email: 'll@mailer-test.co', orderIndex: 1 },
        { userId: tenantUser.user_id, role: 'primary', name: 'Kay Howard', email: tenantUser.email, orderIndex: 2 },
      ],
    })
    await client.query('COMMIT')
    const rows = await db.query<{ lease_column: string; value: string | null }>(
      `SELECT lease_column, value FROM lease_document_fields WHERE document_id = $1 AND page = 8`, [doc.id])
    return Object.fromEntries(rows.rows.map(r => [r.lease_column, r.value]))
  } finally { client.release() }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSIDE THE LANDLORD'S FIRST 28 DAYS — where the trigger used to speak.
// ─────────────────────────────────────────────────────────────────────────────
describe('a landlord inside their first 28 days', () => {
  it('"Add one tenant": a genuine new move-in stays a new move-in', async () => {
    const co = await company()
    expect(await flagOf(await addOneTenant(co, false))).toBe(false)
  })

  it('"Add one tenant": an attested sitting resident is an existing tenancy', async () => {
    const co = await company()
    expect(await flagOf(await addOneTenant(co, true))).toBe(true)
  })

  it('the new-lease invite: a genuine new move-in stays a new move-in', async () => {
    const co = await company()
    expect(await flagOf((await inviteHousehold(co, false)).intentId)).toBe(false)
  })

  it('the new-lease invite: an attested sitting resident is an existing tenancy', async () => {
    const co = await company()
    expect(await flagOf((await inviteHousehold(co, true)).intentId)).toBe(true)
  })

  // The money. This is what the trigger was quietly throwing away.
  it('the new move-in is billed move-in rent, the deposit and the fees', async () => {
    const co = await company()
    await addOneTenant(co, false)
    const p8 = await pageEight(co)
    // Starting 16 September on $500 rent due on the 1st: $250 for the half
    // month, the $350 deposit, and the property's apartment fee list
    // (350 + 100 + 50). Total $1,100.
    expect(p8).toEqual({
      move_in_first_month_rent: '0.00',
      move_in_proration: '250.00',
      move_in_security_deposit: '350.00',
      move_in_total_due: '1100.00',
      pet_deposit: '350.00',
      utility_deposit: '100.00',
      move_in_fee: '50.00',
    })
  })

  it('the attested sitting resident is billed the month and nothing else', async () => {
    const co = await company()
    await addOneTenant(co, true)
    expect(await pageEight(co)).toEqual({
      move_in_first_month_rent: '500.00',
      move_in_proration: '0.00',
      move_in_security_deposit: '0.00',
      move_in_total_due: '500.00',
      pet_deposit: '0.00',
      utility_deposit: '0.00',
      move_in_fee: '0.00',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE BAND — the property's 14 days are up, the landlord's 28 are not.
//
// This is where the dropped trigger used to be the ONLY thing producing the
// answer, and where the screens used to offer no box at all: they gated the
// attestation on the property's window alone, so a sitting resident papered on
// day 20 was billed the whole new-move-in packet with nothing anywhere to say
// otherwise. The server rule has always been EITHER window (S631), and the
// screens now read that one answer off the window payload
// (existingTenancyOpen) instead of re-deriving it from `open`.
//
// The two halves stay separate: papered as sitting, screens anyway.
// ─────────────────────────────────────────────────────────────────────────────
describe('after the property window closes but inside the landlord 28 days', () => {
  const band = () => company({ propertyWindowStartedDaysAgo: 20 })

  it('the window payload says the property is closed but the answer is still available', async () => {
    const co = await band()
    const w = await getOnboardingWindow(co.propertyId)
    expect(w.open).toBe(false)              // no background-check waive here
    expect(w.accountWindowOpen).toBe(true)
    expect(w.existingTenancyOpen).toBe(true) // the money answer is still askable
    const listed = (await listOnboardingWindowsForLandlord([co.landlordId]))
      .find(r => r.propertyId === co.propertyId)!
    expect([listed.open, listed.accountWindowOpen, listed.existingTenancyOpen]).toEqual([false, true, true])
  })

  it('"Add one tenant": an attested sitting resident is still an existing tenancy', async () => {
    const co = await band()
    expect(await flagOf(await addOneTenant(co, true))).toBe(true)
  })

  it('"Add one tenant": a genuine new move-in is still a new move-in', async () => {
    const co = await band()
    expect(await flagOf(await addOneTenant(co, false))).toBe(false)
  })

  // The $600. Both doors, same unit, same day, same answer — the two used to
  // disagree because one of them sent "yes" from a box it had never drawn.
  it('both doors bill the attested sitting resident the month and nothing else', async () => {
    const one = await band()
    await addOneTenant(one, true)
    expect(await pageEight(one)).toEqual({
      move_in_first_month_rent: '500.00', move_in_proration: '0.00',
      move_in_security_deposit: '0.00', move_in_total_due: '500.00',
      pet_deposit: '0.00', utility_deposit: '0.00', move_in_fee: '0.00',
    })
    const two = await band()
    await inviteHousehold(two, true)
    expect((await pageEight(two)).move_in_total_due).toBe('500.00')
  })

  it('and both bill the genuine new move-in the full packet', async () => {
    const one = await band()
    await addOneTenant(one, false)
    expect((await pageEight(one)).move_in_total_due).toBe('1100.00')
    const two = await band()
    await inviteHousehold(two, false)
    expect((await pageEight(two)).move_in_total_due).toBe('1100.00')
  })

  // Papered as sitting does NOT waive the background check in the band: that is
  // the property's window alone (S579) and it never reopens.
  it('the sitting resident still screens — the grandfather window is closed', async () => {
    const co = await band()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant-pending')
      .set('Authorization', `Bearer ${co.token}`)
      .send({ firstName: 'Kay', lastName: 'Howard', email: `kay-${randomUUID().slice(0, 8)}@test.dev`,
              unitId: co.unitId, existingResident: true })
    expect(res.status).toBe(200)
    expect(res.body.data.screeningWaived).toBe(false)
    // ...while the money answer did land.
    expect(await flagOf(res.body.data.intentId)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OUTSIDE THE WINDOW — unchanged by any of this.
// ─────────────────────────────────────────────────────────────────────────────
describe('outside both onboarding windows', () => {
  it('"Add one tenant": a new move-in is a new move-in', async () => {
    const co = await company({ accountAgeDays: 60 })
    expect(await flagOf(await addOneTenant(co, false))).toBe(false)
  })

  it('"Add one tenant": even an attested sitting resident is not an existing tenancy', async () => {
    const co = await company({ accountAgeDays: 60 })
    expect(await flagOf(await addOneTenant(co, true))).toBe(false)
  })

  it('the new-lease invite: both answers behave exactly as before', async () => {
    const co = await company({ accountAgeDays: 60 })
    expect(await flagOf((await inviteHousehold(co, true)).intentId)).toBe(false)
    const other = await company({ accountAgeDays: 60 })
    expect(await flagOf((await inviteHousehold(other, false)).intentId)).toBe(false)
  })

  it('the attested resident at an old account is billed as a new move-in', async () => {
    const co = await company({ accountAgeDays: 60 })
    await addOneTenant(co, true)
    expect((await pageEight(co)).move_in_security_deposit).toBe('350.00')
  })

  // EITHER window counts: the property's own open window is enough on its own,
  // which is what a landlord onboarding a park bought months later experiences.
  it('an open property window is enough at an old account', async () => {
    const co = await company({ accountAgeDays: 60, propertyWindowOpen: true })
    expect(await flagOf(await addOneTenant(co, true))).toBe(true)
    const other = await company({ accountAgeDays: 60, propertyWindowOpen: true })
    expect(await flagOf((await inviteHousehold(other, true)).intentId)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Deliberate and untouched: once a landlord has attested a sitting resident,
// re-inviting them to the same unit does not turn them into a new move-in and
// bill them move-in money.
// ─────────────────────────────────────────────────────────────────────────────
describe('attested once, attested across a re-invite', () => {
  it('a re-invite without the attestation leaves the existing tenancy standing', async () => {
    const co = await company()
    const first = await inviteHousehold(co, true)
    expect(await flagOf(first.intentId)).toBe(true)
    const again = await inviteHousehold(co, false, first.email)
    expect(again.intentId).toBe(first.intentId)
    expect(await flagOf(first.intentId)).toBe(true)
  })
})
