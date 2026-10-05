/**
 * 10/5 (Nic): replies go to whoever runs what the email is about — never a copy
 * to GAM for the landlord's business.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { replyAddressesFor } from './replyRouting'

beforeEach(async () => { await cleanupAllSchema() })

async function park(o: { managed?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, { email: `owner-${randomUUID().slice(0, 6)}@park.dev` })
    let managerId = userId
    if (o.managed) {
      managerId = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','property_manager','M','M') RETURNING id`,
        [`manager-${randomUUID().slice(0, 6)}@park.dev`])).rows[0].id
    }
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: managerId })
    await c.query('COMMIT')
    const email = async (id: string) => (await db.query(`SELECT email FROM users WHERE id=$1`, [id])).rows[0].email
    return { userId, landlordId, propertyId, ownerEmail: await email(userId), managerEmail: await email(managerId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('where a reply about a property lands', () => {
  it('the property\\u2019s office email, when it has one', async () => {
    const p = await park({ managed: true })
    await db.query(`UPDATE properties SET office_email = ' Office@Park.dev ' WHERE id = $1`, [p.propertyId])
    expect(await replyAddressesFor({ kind: 'property', propertyId: p.propertyId })).toEqual(['office@park.dev'])
  })

  it('no office email: whoever runs it — the manager when someone else runs it', async () => {
    const p = await park({ managed: true })
    expect(await replyAddressesFor({ kind: 'property', propertyId: p.propertyId })).toEqual([p.managerEmail])
  })

  it('no office email and the owner runs it: the owner', async () => {
    const p = await park()
    expect(await replyAddressesFor({ kind: 'property', propertyId: p.propertyId })).toEqual([p.ownerEmail])
  })

  it('a retired or unusable office email is skipped, never used', async () => {
    const p = await park()
    await db.query(`UPDATE properties SET office_email = 'retired-1@retired.invalid' WHERE id = $1`, [p.propertyId])
    expect(await replyAddressesFor({ kind: 'property', propertyId: p.propertyId })).toEqual([p.ownerEmail])
  })
})

describe('everything else', () => {
  it('GAM\\u2019s own mail, nothing said, or an unknown property: GAM support (null = the default)', async () => {
    expect(await replyAddressesFor(undefined)).toBeNull()
    expect(await replyAddressesFor({ kind: 'gam' })).toBeNull()
    expect(await replyAddressesFor({ kind: 'property', propertyId: randomUUID() })).toBeNull()
  })

  it('a named person: that person', async () => {
    const p = await park()
    expect(await replyAddressesFor({ kind: 'person', userId: p.userId })).toEqual([p.ownerEmail])
  })
})
