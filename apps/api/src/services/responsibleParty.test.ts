/**
 * responsibleParty — S183 property-routing resolver.
 *
 * Single source of truth for "who gets pinged about this property?"
 * Three resolution paths:
 *   1. PM company path (property-level pm_company_id OR landlord default)
 *      → primaries = all active pm_staff (multi-user fan-out)
 *   2. Individual delegation (managed_by_user_id ≠ owner_user_id)
 *      → primaries = [the delegated manager]
 *   3. Self-managed → primaries = [owner]
 *
 * Used by every notification surface (maintenance / inspections /
 * sublease decisions / deposits / supersedence). A bug here =
 * silently broken notification routing across multiple flows.
 *
 * Pure-logic tests; no HTTP, no mocks. Each test asserts the
 * `{ primaries, owner, is_delegated, kind }` shape end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { getPropertyResponsibleParty } from './responsibleParty'

beforeEach(cleanupAllSchema)

// All seeds use db.query so each statement auto-commits — no explicit
// transaction shenanigans, no cross-connection visibility issues.
async function seedLandlordHere(): Promise<{ userId: string; landlordId: string }> {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'landlord', 'Test', 'Landlord', TRUE) RETURNING id`,
    [`ll-${randomUUID()}@test.dev`],
  )
  const userId = u.rows[0].id
  const l = await db.query<{ id: string }>(
    `INSERT INTO landlords (user_id) VALUES ($1) RETURNING id`,
    [userId],
  )
  return { userId, landlordId: l.rows[0].id }
}

async function seedUser(role: string = 'landlord'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'Test', 'User', TRUE) RETURNING id`,
    [`user-${randomUUID()}@test.dev`, role],
  )
  return r.rows[0].id
}

async function seedProperty(opts: {
  landlordId: string
  ownerUserId: string
  managedByUserId: string
  pmCompanyId?: string | null
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO properties (landlord_id, name, street1, city, state, zip,
                             owner_user_id, managed_by_user_id, pm_company_id)
     VALUES ($1, 'Test Property', '1 Test St', 'Phoenix', 'AZ', '85001', $2, $3, $4)
     RETURNING id`,
    [opts.landlordId, opts.ownerUserId, opts.managedByUserId, opts.pmCompanyId ?? null],
  )
  return r.rows[0].id
}

async function seedPmCompany(name: string = 'Test PM Co'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pm_companies (name) VALUES ($1) RETURNING id`,
    [name],
  )
  return r.rows[0].id
}

async function seedPmStaff(opts: {
  pmCompanyId: string
  userId:      string
  role?:       'owner' | 'manager' | 'staff'
  status?:     'active' | 'inactive' | 'removed'
}): Promise<void> {
  await db.query(
    `INSERT INTO pm_staff (pm_company_id, user_id, role, status)
     VALUES ($1, $2, $3, $4)`,
    [opts.pmCompanyId, opts.userId, opts.role ?? 'staff', opts.status ?? 'active'],
  )
}

// ─── 404 path ───────────────────────────────────────────────────

describe('getPropertyResponsibleParty — property does not exist', () => {
  it('returns null', async () => {
    const out = await getPropertyResponsibleParty(randomUUID())
    expect(out).toBeNull()
  })
})

// (The "owner row orphaned" and "manager row orphaned" null/empty
// branches in the source are defensive — schema FKs
// (`properties_owner_user_id_fkey`, `properties_managed_by_user_id_fkey`)
// prevent the underlying users rows from being deleted while a property
// references them, so these branches are unreachable in normal DB state.
// They stay in the code for safety against future schema relaxation.)

// ─── Self-managed ───────────────────────────────────────────────

describe('self-managed (owner == manager, no pm_company)', () => {
  it('returns owner as the sole primary, is_delegated=false, kind=self_managed', async () => {
    const { userId, landlordId } = await seedLandlordHere()
    const propertyId = await seedProperty({ landlordId, ownerUserId: userId, managedByUserId: userId })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe('self_managed')
    expect(out!.is_delegated).toBe(false)
    expect(out!.primaries).toHaveLength(1)
    expect(out!.primaries[0].user_id).toBe(userId)
    expect(out!.owner.user_id).toBe(userId)
  })
})

// ─── Individual delegation ──────────────────────────────────────

describe('individual delegation (managed_by_user_id ≠ owner_user_id)', () => {
  it('returns the delegated manager as the primary, owner separate', async () => {
    const { userId: ownerUserId, landlordId } = await seedLandlordHere()
    const managerUserId = await seedUser('property_manager')
    const propertyId = await seedProperty({
      landlordId, ownerUserId, managedByUserId: managerUserId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe('individual')
    expect(out!.is_delegated).toBe(true)
    expect(out!.primaries).toHaveLength(1)
    expect(out!.primaries[0].user_id).toBe(managerUserId)
    expect(out!.owner.user_id).toBe(ownerUserId)
  })
})

// ─── PM company path ────────────────────────────────────────────

describe('PM company path — property-level pm_company_id', () => {
  it('returns all active pm_staff as primaries, owner as escalation', async () => {
    const { userId: ownerUserId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany()
    const staff1 = await seedUser('property_manager')
    const staff2 = await seedUser('property_manager')
    const staff3 = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId, userId: staff1, role: 'manager' })
    await seedPmStaff({ pmCompanyId, userId: staff2, role: 'owner' })
    await seedPmStaff({ pmCompanyId, userId: staff3, role: 'staff' })
    const propertyId = await seedProperty({
      landlordId, ownerUserId, managedByUserId: ownerUserId, pmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe('pm_company')
    expect(out!.is_delegated).toBe(true)
    expect(out!.primaries).toHaveLength(3)
    expect(out!.owner.user_id).toBe(ownerUserId)
    const primaryIds = out!.primaries.map(p => p.user_id).sort()
    expect(primaryIds).toEqual([staff1, staff2, staff3].sort())
  })

  it('staff returned in role ORDER BY ascending (manager < owner < staff alphabetically — comment in source is misleading)', async () => {
    // The service code orders by ps.role with a comment claiming
    // "owner > manager > staff (alpha sort matches priority)" — but
    // alphabetically that's manager < owner < staff. Test the ACTUAL
    // behavior so any future change to the ORDER BY clause registers
    // as a regression here. (Functional impact: notifications fan out
    // to all three regardless of order, so this is documentation
    // drift, not a user-visible bug.)
    const { userId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany()
    // Seed in non-alpha order to make sure ORDER BY is doing the work.
    const staffUserId      = await seedUser('property_manager')
    const ownerStaffUserId = await seedUser('property_manager')
    const managerUserId    = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId, userId: staffUserId,      role: 'staff' })
    await seedPmStaff({ pmCompanyId, userId: ownerStaffUserId, role: 'owner' })
    await seedPmStaff({ pmCompanyId, userId: managerUserId,    role: 'manager' })
    const propertyId = await seedProperty({
      landlordId, ownerUserId: userId, managedByUserId: userId, pmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.primaries.map(p => p.user_id)).toEqual([
      managerUserId,    // 'manager' (m)
      ownerStaffUserId, // 'owner' (o)
      staffUserId,      // 'staff' (s)
    ])
  })

  it('filters out inactive and removed staff', async () => {
    const { userId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany()
    const activeId   = await seedUser('property_manager')
    const inactiveId = await seedUser('property_manager')
    const removedId  = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId, userId: activeId,   role: 'manager', status: 'active' })
    await seedPmStaff({ pmCompanyId, userId: inactiveId, role: 'manager', status: 'inactive' })
    await seedPmStaff({ pmCompanyId, userId: removedId,  role: 'manager', status: 'removed' })
    const propertyId = await seedProperty({
      landlordId, ownerUserId: userId, managedByUserId: userId, pmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.primaries.map(p => p.user_id)).toEqual([activeId])
  })

  it('returns empty primaries when PM company has no active staff (owner still set for escalation)', async () => {
    const { userId: ownerUserId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany()
    // PM company exists but has zero staff rows.
    const propertyId = await seedProperty({
      landlordId, ownerUserId, managedByUserId: ownerUserId, pmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.kind).toBe('pm_company')
    expect(out!.is_delegated).toBe(true)
    expect(out!.primaries).toEqual([])
    expect(out!.owner.user_id).toBe(ownerUserId)
  })

  it('PM company path takes precedence over individual delegation', async () => {
    // Both managed_by_user_id (≠ owner) AND pm_company_id are set; the
    // resolver should route to PM company, not the individual manager.
    const { userId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany()
    const pmStaffUserId = await seedUser('property_manager')
    const managerUserId = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId, userId: pmStaffUserId, role: 'manager' })
    const propertyId = await seedProperty({
      landlordId, ownerUserId: userId, managedByUserId: managerUserId, pmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.kind).toBe('pm_company')
    expect(out!.primaries.map(p => p.user_id)).toEqual([pmStaffUserId])
  })
})

describe('PM company path — landlord default pm_company_id', () => {
  it('falls back to landlords.default_pm_company_id when property pm_company_id is null', async () => {
    const { userId, landlordId } = await seedLandlordHere()
    const pmCompanyId = await seedPmCompany('Default PM')
    const staffUserId = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId, userId: staffUserId, role: 'manager' })
    await db.query(
      `UPDATE landlords SET default_pm_company_id = $1 WHERE id = $2`,
      [pmCompanyId, landlordId],
    )
    const propertyId = await seedProperty({
      landlordId, ownerUserId: userId, managedByUserId: userId, pmCompanyId: null,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.kind).toBe('pm_company')
    expect(out!.primaries.map(p => p.user_id)).toEqual([staffUserId])
  })

  it('property-level pm_company_id overrides landlord default', async () => {
    const { userId, landlordId } = await seedLandlordHere()
    const propertyPmCompanyId        = await seedPmCompany('Property PM')
    const landlordDefaultPmCompanyId = await seedPmCompany('Default PM')
    const propertyStaffUserId = await seedUser('property_manager')
    const defaultStaffUserId  = await seedUser('property_manager')
    await seedPmStaff({ pmCompanyId: propertyPmCompanyId,        userId: propertyStaffUserId, role: 'manager' })
    await seedPmStaff({ pmCompanyId: landlordDefaultPmCompanyId, userId: defaultStaffUserId,  role: 'manager' })
    await db.query(
      `UPDATE landlords SET default_pm_company_id = $1 WHERE id = $2`,
      [landlordDefaultPmCompanyId, landlordId],
    )
    const propertyId = await seedProperty({
      landlordId, ownerUserId: userId, managedByUserId: userId, pmCompanyId: propertyPmCompanyId,
    })
    const out = await getPropertyResponsibleParty(propertyId)
    expect(out!.kind).toBe('pm_company')
    // Only the property-level PM company's staff comes back. defaultStaffUserId silenced.
    expect(out!.primaries.map(p => p.user_id)).toEqual([propertyStaffUserId])
    expect(defaultStaffUserId).toBeTruthy()  // referenced for clarity
  })
})
