/**
 * S430 services-audit slice 7a: addendumActor.ts.
 *
 * Resolution priority pinned end-to-end via real DB seeds:
 *   1. owner — user_id matches landlords.user_id
 *   2. gam_admin — users.role in (admin, super_admin)
 *   3. pm — property_manager_scopes row for landlord
 *   4. team — fallback (other scoped roles)
 *   5. unknown — null userId / no users row
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import {
  addendumActorRoleLabel,
  resolveAddendumActor,
  resolveTenantNames,
} from './addendumActor'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function seedUser(role: string = 'tenant'): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', $2, 'Alice', 'Smith', TRUE) RETURNING id`,
    [`u-${randomUUID()}@test.dev`, role])
  return id
}

// ─── addendumActorRoleLabel ──────────────────────────────────

describe('addendumActorRoleLabel', () => {
  it('maps each role to its display label', () => {
    expect(addendumActorRoleLabel('owner')).toBe('Owner')
    expect(addendumActorRoleLabel('gam_admin')).toBe('GAM Admin')
    expect(addendumActorRoleLabel('pm')).toBe('Property Manager')
    expect(addendumActorRoleLabel('team')).toBe('Team')
    expect(addendumActorRoleLabel('unknown')).toBe('—')
  })
})

// ─── resolveAddendumActor ────────────────────────────────────

describe('resolveAddendumActor', () => {
  it('null userId → role=unknown, name=(unknown)', async () => {
    const r = await resolveAddendumActor(null, randomUUID())
    expect(r.user_id).toBeNull()
    expect(r.name).toBe('(unknown)')
    expect(r.role).toBe('unknown')
  })

  it('userId not in users → role=unknown, name=(unknown user)', async () => {
    const r = await resolveAddendumActor(randomUUID(), randomUUID())
    expect(r.role).toBe('unknown')
    expect(r.name).toBe('(unknown user)')
  })

  it('owner: user_id matches landlords.user_id → role=owner', async () => {
    const c = await db.connect()
    let landlordId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId; userId = r.userId
      await c.query('COMMIT')
    } finally { c.release() }
    const actor = await resolveAddendumActor(userId, landlordId)
    expect(actor.role).toBe('owner')
    expect(actor.user_id).toBe(userId)
  })

  it('gam_admin: user.role=admin and not the landlord owner → role=gam_admin', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      landlordId = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const adminId = await seedUser('admin')
    const r = await resolveAddendumActor(adminId, landlordId)
    expect(r.role).toBe('gam_admin')
  })

  it('gam_admin: super_admin also maps to gam_admin', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      landlordId = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const superId = await seedUser('super_admin')
    const r = await resolveAddendumActor(superId, landlordId)
    expect(r.role).toBe('gam_admin')
  })

  it('pm: property_manager_scopes row for this landlord → role=pm', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      landlordId = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const pmUserId = await seedUser('property_manager')
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, permissions)
       VALUES ($1, $2, '{}'::jsonb)`,
      [pmUserId, landlordId])
    const r = await resolveAddendumActor(pmUserId, landlordId)
    expect(r.role).toBe('pm')
  })

  it('pm scope for a DIFFERENT landlord does NOT match', async () => {
    // PM scoped to landlord A; resolving for landlord B → fallback team.
    const c = await db.connect()
    let landlordA = ''; let landlordB = ''
    try {
      await c.query('BEGIN')
      landlordA = (await seedLandlord(c)).landlordId
      landlordB = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const pmUserId = await seedUser('property_manager')
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, permissions)
       VALUES ($1, $2, '{}'::jsonb)`,
      [pmUserId, landlordA])
    const r = await resolveAddendumActor(pmUserId, landlordB)
    expect(r.role).toBe('team')
  })

  it('team fallback: scoped role with no PM scope → team', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      landlordId = (await seedLandlord(c)).landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const maintenanceUserId = await seedUser('maintenance')
    const r = await resolveAddendumActor(maintenanceUserId, landlordId)
    expect(r.role).toBe('team')
  })

  it('returns name as "first last" trimmed', async () => {
    const c = await db.connect()
    let landlordId = ''; let userId = ''
    try {
      await c.query('BEGIN')
      const r = await seedLandlord(c)
      landlordId = r.landlordId; userId = r.userId
      await c.query('COMMIT')
    } finally { c.release() }
    const actor = await resolveAddendumActor(userId, landlordId)
    expect(actor.name).toBe('Test Landlord')  // seedLandlord uses these as defaults
  })
})

// ─── resolveTenantNames ──────────────────────────────────────

describe('resolveTenantNames', () => {
  it('empty array → empty result', async () => {
    expect(await resolveTenantNames([])).toEqual([])
  })

  async function seedTenantWithName(first: string, last: string): Promise<string> {
    const { rows: [{ id: uid }] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', $2, $3, TRUE) RETURNING id`,
      [`t-${randomUUID()}@test.dev`, first, last])
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [uid])
    return id
  }

  it('all resolvable → names returned in input order', async () => {
    const tA = await seedTenantWithName('Alice', 'Anderson')
    const tB = await seedTenantWithName('Bob', 'Brown')
    const tC = await seedTenantWithName('Carol', 'Clark')
    const names = await resolveTenantNames([tC, tA, tB])
    expect(names).toEqual(['Carol Clark', 'Alice Anderson', 'Bob Brown'])
  })

  it('unresolvable ids become "(unknown)" in their position', async () => {
    const tA = await seedTenantWithName('Alice', 'Anderson')
    const unknownId = randomUUID()
    const names = await resolveTenantNames([tA, unknownId])
    expect(names).toEqual(['Alice Anderson', '(unknown)'])
  })

  it('duplicate ids resolve to the same name multiple times', async () => {
    const tA = await seedTenantWithName('Alice', 'Anderson')
    const names = await resolveTenantNames([tA, tA])
    expect(names).toEqual(['Alice Anderson', 'Alice Anderson'])
  })
})
