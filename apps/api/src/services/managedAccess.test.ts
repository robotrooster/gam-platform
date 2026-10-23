/**
 * 10/22–23 (Nic) — ONE LOGIN THAT OWNS ONE PARK AND MANAGES ANOTHER.
 *
 * The shape the whole fold is for: Blu owns Country Acres and manages Oak Park
 * for its owner, from one account, seeing each as itself.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { grantManagedAccess, revokeManagedAccess, companiesForAccount, READ_ONLY_MANAGED_PERMISSIONS } from './managedAccess'
import { assertPropertyInScope, getScopedPropertyIds } from '../middleware/auth'
import type { AuthPayload } from '../middleware/auth'

beforeEach(async () => { await cleanupAllSchema() })

/** An owner with two parks. */
async function owner() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const engaged = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const theirs = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query('COMMIT')
    return { userId, landlordId, engaged, theirs }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A management company, its owner, and a maintenance tech on its staff. */
async function managementCompany() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: bluUserId, landlordId: bluOwnCompany } = await seedLandlord(c)
    const pm = (await c.query<{ id: string }>(
      `INSERT INTO pm_companies (name, created_by_user_id) VALUES ('TruBlu Management LLC', $1) RETURNING id`,
      [bluUserId])).rows[0]
    await c.query(
      `INSERT INTO pm_staff (pm_company_id, user_id, role, permissions, status)
       VALUES ($1, $2, 'owner', '{}'::jsonb, 'active')`, [pm.id, bluUserId])
    const techId = randomUUID()
    await c.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role, email_verified)
       VALUES ($1, $2, 'x', 'Tess', 'Wrench', 'property_manager', TRUE)`,
      [techId, `tess-${techId.slice(0, 8)}@t.dev`])
    await c.query(
      `INSERT INTO pm_staff (pm_company_id, user_id, role, permissions, status)
       VALUES ($1, $2, 'staff', $3::jsonb, 'active')`,
      [pm.id, techId, JSON.stringify({ maintenance: { view: true, edit: true } })])
    await c.query('COMMIT')
    return { pmCompanyId: pm.id, bluUserId, bluOwnCompany, techId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const asLandlord = (userId: string): AuthPayload => ({ userId, email: 'b@t.dev', role: 'landlord' } as AuthPayload)
const asTech = (userId: string): AuthPayload => ({ userId, email: 't@t.dev', role: 'property_manager' } as AuthPayload)

describe('an owner engages a management company for ONE park', () => {
  it("its people reach that park and nothing else of the owner's", async () => {
    const o = await owner()
    const pm = await managementCompany()
    const out = await grantManagedAccess(db, {
      pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    expect(out.people).toBe(2)

    for (const who of [asLandlord(pm.bluUserId), asTech(pm.techId)]) {
      await expect(assertPropertyInScope(who, o.engaged)).resolves.toBeUndefined()
      await expect(assertPropertyInScope(who, o.theirs)).rejects.toThrow()
    }
  })

  it("and Blu's OWN company is untouched by it — he is still its owner", async () => {
    const o = await owner()
    const pm = await managementCompany()
    const own = await seedPropertyFor(pm.bluOwnCompany, pm.bluUserId)
    await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    // His own park: owner, no narrowing, no permission questions.
    await expect(assertPropertyInScope(asLandlord(pm.bluUserId), own, { perm: 'anything.at.all' }))
      .resolves.toBeUndefined()
    // The owner's park: managed, so the grant decides.
    await expect(assertPropertyInScope(asLandlord(pm.bluUserId), o.engaged, { perm: 'pos.refund' }))
      .rejects.toThrow(/has not given you that/)
  })

  it('the picker reads both, each as what it is', async () => {
    const o = await owner()
    const pm = await managementCompany()
    await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    const mine = await companiesForAccount(db, pm.bluUserId)
    expect(mine.map(c => c.role)).toEqual(['owner', 'manager'])
    expect(mine.find(c => c.role === 'manager')).toMatchObject({
      landlordId: o.landlordId, viaPmCompanyId: pm.pmCompanyId })
    expect(mine.find(c => c.role === 'owner')).toMatchObject({ viaPmCompanyId: null })
  })
})

describe('what the owner agreed to is the ceiling', () => {
  it("a 'view' engagement can change nothing, whatever the PM gave their staff", async () => {
    const o = await owner()
    const pm = await managementCompany()
    await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'view', grantedByUserId: o.userId })
    const tech = asTech(pm.techId)
    // Their own boss gave them maintenance.edit; this owner did not agree to it.
    await expect(assertPropertyInScope(tech, o.engaged, { perm: 'maintenance.view' })).resolves.toBeUndefined()
    await expect(assertPropertyInScope(tech, o.engaged, { perm: 'maintenance.edit' }))
      .rejects.toThrow(/Insufficient permissions for this property|has not given you that/)
  })

  it("a 'manage' engagement carries the staff member's own permissions", async () => {
    const o = await owner()
    const pm = await managementCompany()
    await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    const tech = asTech(pm.techId)
    await expect(assertPropertyInScope(tech, o.engaged, { perm: 'maintenance.edit' })).resolves.toBeUndefined()
    // And not something nobody gave them.
    await expect(assertPropertyInScope(tech, o.engaged, { perm: 'pos.refund' })).rejects.toThrow()
  })

  it('the read-only set is only ever reads', async () => {
    for (const k of READ_ONLY_MANAGED_PERMISSIONS) expect(k).toMatch(/\.view$/)
  })
})

describe('when the engagement ends', () => {
  it('the park comes off their people, and the membership goes with the last of it', async () => {
    const o = await owner()
    const pm = await managementCompany()
    await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    await revokeManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId, propertyId: o.engaged })

    await expect(assertPropertyInScope(asTech(pm.techId), o.engaged)).rejects.toThrow()
    expect(await query(`SELECT 1 FROM landlord_members WHERE landlord_id = $1 AND user_id = $2`,
      [o.landlordId, pm.techId])).toHaveLength(0)
  })

  it('but a second park of the same owner is kept', async () => {
    const o = await owner()
    const pm = await managementCompany()
    for (const p of [o.engaged, o.theirs]) {
      await grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
        propertyId: p, scope: 'manage', grantedByUserId: o.userId })
    }
    await revokeManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId, propertyId: o.engaged })
    await expect(assertPropertyInScope(asTech(pm.techId), o.theirs)).resolves.toBeUndefined()
    await expect(assertPropertyInScope(asTech(pm.techId), o.engaged)).rejects.toThrow()
    expect(await query(`SELECT 1 FROM landlord_members WHERE landlord_id = $1 AND user_id = $2`,
      [o.landlordId, pm.techId])).toHaveLength(1)
  })
})

describe('granting is safe to run again', () => {
  it('twice is the same as once — a staff change catches up, nothing duplicates', async () => {
    const o = await owner()
    const pm = await managementCompany()
    const g = () => grantManagedAccess(db, { pmCompanyId: pm.pmCompanyId, landlordId: o.landlordId,
      propertyId: o.engaged, scope: 'manage', grantedByUserId: o.userId })
    await g(); await g(); await g()
    const rows = await query<{ property_ids: string[] }>(
      `SELECT property_ids FROM property_manager_scopes WHERE user_id = $1 AND landlord_id = $2`,
      [pm.techId, o.landlordId])
    expect(rows).toHaveLength(1)
    expect(rows[0].property_ids).toEqual([o.engaged])
    expect(await getScopedPropertyIds(asTech(pm.techId))).toEqual([o.engaged])
  })
})

/** A park under a company, for the "his own is untouched" case. */
async function seedPropertyFor(landlordId: string, ownerUserId: string): Promise<string> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const id = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await c.query('COMMIT')
    return id
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
