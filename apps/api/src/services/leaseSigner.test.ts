// S605 (Nic): one designated lease signer per property, with automatic fallback.
//
// "Have it go to the landlord when there's no on-site manager selected, and have
// it go to the on-site manager if permission is checked. Limit that permission
// to only one user per property. And if that person gets fired or removed from
// permission, then it defaults back to the landlord or the owner."
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { resolveLeaseSigner } from './leaseSigner'

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

async function ctx() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const { rows: [mgr] } = await c.query<any>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('mgr@mailer-test.co','x','onsite_manager','Ona','Site') RETURNING id`)
    await c.query('COMMIT')
    return { ownerUserId: userId, landlordId, propertyId, mgrId: mgr.id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const scope = (mgrId: string, landlordId: string, propertyId: string, perms: object) =>
  db.query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions)
     VALUES ($1,$2,ARRAY[$3]::uuid[],$4::jsonb)`,
    [mgrId, landlordId, propertyId, JSON.stringify(perms)])

describe('resolveLeaseSigner', () => {
  it('no designation → the account owner signs', async () => {
    const c = await ctx()
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.ownerUserId)
    expect(s?.isOwner).toBe(true)
  })

  it('designated + entitled manager signs instead', async () => {
    const c = await ctx()
    await scope(c.mgrId, c.landlordId, c.propertyId, { 'leases.sign': true })
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`, [c.propertyId, c.mgrId])
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.mgrId)
    expect(s?.isOwner).toBe(false)
  })

  // "If that person gets fired or removed from permission, then it defaults back
  // to the landlord." No one should have to remember to clear the setting.
  it('permission revoked → falls back to the owner', async () => {
    const c = await ctx()
    await scope(c.mgrId, c.landlordId, c.propertyId, { 'leases.sign': true })
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`, [c.propertyId, c.mgrId])
    await db.query(`UPDATE onsite_manager_scopes SET permissions='{"leases.sign": false}'::jsonb WHERE user_id=$1`, [c.mgrId])
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.ownerUserId)
  })

  it('removed from the property → falls back to the owner', async () => {
    const c = await ctx()
    await scope(c.mgrId, c.landlordId, c.propertyId, { 'leases.sign': true })
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`, [c.propertyId, c.mgrId])
    await db.query(`UPDATE onsite_manager_scopes SET property_ids='{}'::uuid[] WHERE user_id=$1`, [c.mgrId])
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.ownerUserId)
  })

  it('scope removed entirely (fired) → falls back to the owner', async () => {
    const c = await ctx()
    await scope(c.mgrId, c.landlordId, c.propertyId, { 'leases.sign': true })
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`, [c.propertyId, c.mgrId])
    await db.query(`DELETE FROM onsite_manager_scopes WHERE user_id=$1`, [c.mgrId])
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.ownerUserId)
  })

  it('an all_properties manager is entitled without being listed', async () => {
    const c = await ctx()
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, permissions)
       VALUES ($1,$2,TRUE,'{"leases.sign": true}'::jsonb)`, [c.mgrId, c.landlordId])
    await db.query(`UPDATE properties SET lease_signer_user_id=$2 WHERE id=$1`, [c.propertyId, c.mgrId])
    const s = await resolveLeaseSigner(c.landlordId, c.propertyId)
    expect(s?.userId).toBe(c.mgrId)
  })
})
