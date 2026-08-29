/**
 * S630 (Nic): "I wanna log in to my portfolio with one email, but when I get an
 * email saying there's a new draft lease that needs to be signed, I need it to
 * go to separate emails... That way whoever's managing the account on-site can
 * sign leases on behalf of me at that property without having full access to
 * all of my emails and all of my properties."
 *
 * Nic's two entities (Oak Park, Mountain View) share one login, so before this
 * every lease from both properties landed in the same inbox.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { db } from '../db'
import { landlordSigningContact } from './landlordSigningContact'
import {
  seedLandlord, seedProperty, seedUnit, cleanupAllSchema,
} from '../test/dbHelpers'

describe('landlordSigningContact — lease signing routes per property', () => {
  let ownerUserId = '', landlordId = '', oakId = '', mtnId = '', oakUnit = ''

  beforeEach(async () => {
    await cleanupAllSchema()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      ownerUserId = ll.userId; landlordId = ll.landlordId
      oakId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      mtnId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      oakUnit = await seedUnit(c, { propertyId: oakId, landlordId })
      await c.query(
        `UPDATE properties SET lease_signing_email='oakpark@onsite.test' WHERE id=$1`, [oakId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  })

  it('routes to the property address, and falls back to the account for the other', async () => {
    const oak = await landlordSigningContact(landlordId, { propertyId: oakId })
    const mtn = await landlordSigningContact(landlordId, { propertyId: mtnId })
    const account = await db.query<any>(`SELECT email FROM users WHERE id=$1`, [ownerUserId])
      .then((r: any) => r.rows[0])

    expect(oak!.email).toBe('oakpark@onsite.test')
    expect(oak!.delegatedEmail).toBe('oakpark@onsite.test')
    // Same login, different destination — that is the whole point.
    expect(mtn!.email).toBe(account.email)
    expect(mtn!.delegatedEmail).toBeNull()
    expect(oak!.accountEmail).toBe(mtn!.accountEmail)
  })

  it('resolves the property from a unit', async () => {
    const byUnit = await landlordSigningContact(landlordId, { unitId: oakUnit })
    expect(byUnit!.email).toBe('oakpark@onsite.test')
  })

  it('keeps the OWNER as the person the lease names, unless a signer is named', async () => {
    const owner = await db.query<any>(
      `SELECT first_name, last_name FROM users WHERE id=$1`, [ownerUserId]).then((r: any) => r.rows[0])
    const before = await landlordSigningContact(landlordId, { propertyId: oakId })
    expect(before!.name).toBe(`${owner.first_name} ${owner.last_name}`.trim())

    await db.query(`UPDATE properties SET lease_signing_name='Dana Okonkwo' WHERE id=$1`, [oakId])
    const after = await landlordSigningContact(landlordId, { propertyId: oakId })
    expect(after!.name).toBe('Dana Okonkwo')
    expect(after!.firstName).toBe(owner.first_name)   // owner identity intact
  })

  // This decides where a signable lease link is mailed, so a property id from
  // somewhere else must never redirect it.
  it('ignores a property belonging to a different landlord', async () => {
    const c = await db.connect()
    let foreign = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      foreign = await seedProperty(c, {
        landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
      await c.query(
        `UPDATE properties SET lease_signing_email='attacker@evil.test' WHERE id=$1`, [foreign])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await landlordSigningContact(landlordId, { propertyId: foreign })
    const account = await db.query<any>(`SELECT email FROM users WHERE id=$1`, [ownerUserId])
      .then((r: any) => r.rows[0])
    expect(res!.email).toBe(account.email)
    expect(res!.email).not.toBe('attacker@evil.test')
  })

  afterAll(async () => { await cleanupAllSchema() })
})
