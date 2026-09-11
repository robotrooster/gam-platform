/**
 * S641 (Nic) — the printed name under a signature is the person who SIGNED.
 *
 *   "Nobody who's signing the landlord side of the legal document signs Oak
 *    Park Motel and RV. They sign their name as the agent of the landlord. So
 *    it needs to show the printed version of the name of the person signing."
 *
 * Two things were being conflated. The landlord as a PARTY to the lease is the
 * entity; the name under the signature line is the human acting as its agent.
 * The prefill used to take the account owner regardless, which is correct only
 * while the owner is also the signer — and Mountain View already routes signing
 * to a named on-site person.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { landlordSigningContact } from './landlordSigningContact'

beforeEach(async () => { await cleanupAllSchema() })

async function seed(signerName: string | null) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c, { firstName: 'Nic', lastName: 'Rhoades' })
    await c.query(`UPDATE landlords SET business_name='Oak Park Motel and RV LLC' WHERE id=$1`, [ll.landlordId])
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    if (signerName) {
      await c.query(`UPDATE properties SET lease_signing_name=$2, lease_signing_email='onsite@test.dev' WHERE id=$1`,
        [propertyId, signerName])
    }
    await c.query('COMMIT')
    return { ...ll, propertyId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('the name printed under the landlord signature', () => {
  it('is the on-site person when the property routes signing to them', async () => {
    const { landlordId, propertyId } = await seed('Lisa Scheeler')
    const signer = await landlordSigningContact(landlordId, { propertyId })
    // what the prefill now uses
    expect(signer!.name).toBe('Lisa Scheeler')
    // and NOT the account owner, which is what it used to print
    expect(signer!.name).not.toBe(`${signer!.firstName} ${signer!.lastName}`)
  })

  it('falls back to the owner when nobody else is named', async () => {
    const { landlordId, propertyId } = await seed(null)
    const signer = await landlordSigningContact(landlordId, { propertyId })
    expect(signer!.name).toBe('Nic Rhoades')
  })

  it('is never the entity — an LLC does not sign, its agent does', async () => {
    const { landlordId, propertyId } = await seed('Lisa Scheeler')
    const signer = await landlordSigningContact(landlordId, { propertyId })
    expect(signer!.name).not.toContain('LLC')
  })
})
