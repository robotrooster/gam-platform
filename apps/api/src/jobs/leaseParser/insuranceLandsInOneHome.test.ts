/**
 * 11/01 — A RENTERS POLICY ON A SCANNED LEASE LANDS WHERE SOMEBODY WILL SEE IT.
 *
 * The lease parser has pulled carrier / policy number / expiry date off signed
 * leases since the initial schema, and wrote them to
 * `liability_insurance_policies` — a table with no reader anywhere in the
 * codebase. No route, no job, no screen. So the one thing GAM knew about a
 * resident's insurance went into a drawer nobody could open, and an expiry date
 * sitting in that drawer could not warn anybody.
 *
 * resolveIntent writes `insurance_policies` now (the one home for insurance), so
 * this drives the REAL path — resolveIntent itself, not a hand-written INSERT —
 * and asserts the policy comes out of the landlord's own lapse list. That is the
 * whole value of the repoint, and the thing a later session would quietly undo
 * by adding a second table.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db, query } from '../../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../../test/dbHelpers'
import { addDaysTo, todayIn } from '../../lib/timezone'

// Building a lease sends the resident their activation email; nothing here is
// about mail.
const { emailTenantOnboardedMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailTenantOnboarded: emailTenantOnboardedMock,
}))

import { resolveIntent } from './resolveIntent'
import { lapseListForUser } from '../../services/insurancePolicies'

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

/** An intent whose parsed lease carries a liability-insurance block. */
async function intentWithInsurance(
  co: Awaited<ReturnType<typeof company>>,
  liabilityInsurance: Record<string, unknown> | undefined,
) {
  const email = `import-${randomUUID().slice(0, 6)}@test.dev`
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES ($1,'x','tenant','New','Import') RETURNING id`, [email])
  const t = await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1,'onboarded') RETURNING id`, [u.rows[0].id])
  const parserOutput = {
    tenants: [{ firstName: { value: 'New' }, lastName: { value: 'Import' },
                email: { value: email }, phone: { value: '555-0000' } }],
    unit: { propertyName: { value: co.propertyName }, unitNumber: { value: co.unitNumber } },
    lease: { leaseStart: { value: '2026-02-01' }, monthlyRent: { value: 1000 } },
    ...(liabilityInsurance ? { liabilityInsurance } : {}),
  }
  const i = await db.query<{ id: string }>(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, parser_output)
     VALUES ($1, $2, 'parsed', $3::jsonb) RETURNING id`,
    [co.landlordId, t.rows[0].id, JSON.stringify(parserOutput)])
  return i.rows[0].id
}

/** The pass resolveIntent's landlord would carry, for the lapse-list read. */
const asLandlord = (userId: string, landlordId: string) => ({
  userId, role: 'landlord', email: `ll-${userId}@t.dev`,
  profileId: landlordId, landlordIds: [landlordId], permissions: {},
}) as any

describe('the lease parser writes the ONE home for insurance', () => {
  it("files the resident's renters policy against the lease it came off", async () => {
    const co = await company()
    const expiry = addDaysTo(todayIn(null), 10)
    const res: any = await resolveIntent(
      await intentWithInsurance(co, {
        carrierName:  { value: 'Lemonade' },
        policyNumber: { value: 'RL-20318' },
        expiryDate:   { value: expiry },
      }),
      [co.landlordId], {})
    expect(res.leaseId).toBeTruthy()

    const rows = await query<any>(
      `SELECT lease_id, coverage_type, carrier_name, policy_number,
              expiry_date::text AS expiry_date, recorded_by_user_id, verified_at, notes
         FROM insurance_policies`, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].lease_id).toBe(res.leaseId)
    expect(rows[0].coverage_type).toBe('renters_liability')
    expect(rows[0].carrier_name).toBe('Lemonade')
    expect(rows[0].policy_number).toBe('RL-20318')
    expect(rows[0].expiry_date).toBe(expiry)
    // The parser read a document; it did not attest to a certificate. Nobody's
    // name is on it and it is not verified.
    expect(rows[0].recorded_by_user_id).toBeNull()
    expect(rows[0].verified_at).toBeNull()
    expect(rows[0].notes).toMatch(/nobody has checked the certificate/)

    // Nothing is written to the superseded table any more.
    expect(await query(`SELECT 1 FROM liability_insurance_policies`, [])).toHaveLength(0)
  })

  it('and that policy turns up on the landlord\'s lapse list — the point of the repoint', async () => {
    const co = await company()
    const expiry = addDaysTo(todayIn(null), 10)
    await resolveIntent(
      await intentWithInsurance(co, {
        carrierName: { value: 'Lemonade' }, expiryDate: { value: expiry },
      }),
      [co.landlordId], {})

    const lapses = await lapseListForUser(asLandlord(co.userId, co.landlordId), 30)
    expect(lapses.expiringSoon.map(r => r.carrier_name)).toEqual(['Lemonade'])
    expect(lapses.expiringSoon[0].subject).toBe('resident')
    expect(lapses.expiringSoon[0].days_until_expiry).toBe(10)
    expect(lapses.expired).toEqual([])
  })

  it('keeps a policy number with no carrier printed on the page', async () => {
    const co = await company()
    await resolveIntent(
      await intentWithInsurance(co, { policyNumber: { value: 'RL-9' } }),
      [co.landlordId], {})
    const rows = await query<{ carrier_name: string; policy_number: string }>(
      `SELECT carrier_name, policy_number FROM insurance_policies`, [])
    expect(rows).toHaveLength(1)
    expect(rows[0].policy_number).toBe('RL-9')
    // carrier_name is NOT NULL, so "not stated" is recorded rather than the
    // whole policy being dropped.
    expect(rows[0].carrier_name).toBe('Not stated on the lease')
  })

  it('writes nothing when the lease says nothing about insurance', async () => {
    const co = await company()
    await resolveIntent(await intentWithInsurance(co, undefined), [co.landlordId], {})
    expect(await query(`SELECT 1 FROM insurance_policies`, [])).toHaveLength(0)
  })
})
