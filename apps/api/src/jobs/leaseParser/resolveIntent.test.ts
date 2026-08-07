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
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailTenantOnboarded: vi.fn(async () => {}),
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
    const res: any = await resolveIntent(intentId, s.landlordId, {})
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
    const res: any = await resolveIntent(intentId, s.landlordId, {}, { confirmSupersede: true })
    expect(res.leaseId).toBeTruthy()
    expect(res.supersededLeaseId).toBe(s.oldLeaseId)
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [s.oldLeaseId])
    expect(old.rows[0].status).toBe('terminated')
    const n = await db.query<{ n: number }>(`SELECT count(*)::int n FROM leases WHERE unit_id=$1 AND status='active'`, [s.unitId])
    expect(n.rows[0].n).toBe(1) // only the new one is active
  })
})
