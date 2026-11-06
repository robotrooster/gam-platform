// 10/27 (Nic) — the one search bar.
//
//   "I can type John, and every tenant I have named John will show up in a
//    list... if I type in mobile home 5, I can see that at 2 or 3 different
//    properties. And then I can just click on the one I want."
//
// The tests that matter most are the SCOPE ones. A search bar reaches
// everything by design, so if its scope is wrong it is the widest leak in the
// portal: a manager holding one park must never find another park's resident,
// and one company must never find another's.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { portalSearch } from './portalSearch'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

interface Park { landlordId: string; propertyId: string; units: Record<string, string> }

async function park(o: {
  property: string
  /** unit_number -> optional display label */
  spaces: Array<[string, string | null, string]>
  landlordId?: string
  ownerUserId?: string
}): Promise<Park> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    let landlordId = o.landlordId
    let ownerUserId = o.ownerUserId
    if (!landlordId) {
      const l = await seedLandlord(client)
      landlordId = l.landlordId; ownerUserId = l.userId
    }
    const propertyId = await seedProperty(client, {
      landlordId: landlordId!, ownerUserId: ownerUserId!, managedByUserId: ownerUserId! })
    await client.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, o.property])
    const units: Record<string, string> = {}
    for (const [num, label, type] of o.spaces) {
      const unitId = await seedUnit(client, { propertyId, landlordId: landlordId!, rentAmount: 500 })
      await client.query(
        `UPDATE units SET unit_number = $2, display_label = $3, unit_type = $4 WHERE id = $1`,
        [unitId, num, label, type])
      units[num] = unitId
    }
    await client.query('COMMIT')
    return { landlordId: landlordId!, propertyId, units }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

async function resident(p: Park, unitNum: string, first: string, last: string): Promise<string> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const tenantId = await seedTenant(client)
    await client.query(
      `UPDATE users SET first_name = $2, last_name = $3
         WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    const leaseId = await seedLease(client, {
      unitId: p.units[unitNum], landlordId: p.landlordId, rentAmount: 500, status: 'active' })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    await client.query('COMMIT')
    return tenantId
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

const find = (p: { landlordIds: string[]; scoped?: string[] | null }, q: string) =>
  portalSearch({ landlordIds: p.landlordIds, scopedPropertyIds: p.scoped ?? null, q })

beforeEach(cleanupAllSchema)

describe('finding a resident by any part of a name', () => {
  it('lists every resident with that first name', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 01', null, 'mobile_home'], ['MH 02', null, 'mobile_home']] })
    await resident(p, 'MH 01', 'Juno', 'Abernathy')
    await resident(p, 'MH 02', 'Juno', 'Belmont')
    const r = await find({ landlordIds: [p.landlordId] }, 'juno')
    const names = r.hits.filter(h => h.kind === 'resident').map(h => h.title).sort()
    expect(names).toEqual(['Juno Abernathy', 'Juno Belmont'])
  })

  it('finds them by a fragment of the surname too, and says where they are', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 07', null, 'mobile_home']] })
    await resident(p, 'MH 07', 'Soren', 'Thistlewood')
    const r = await find({ landlordIds: [p.landlordId] }, 'thistle')
    const hit = r.hits.find(h => h.kind === 'resident')!
    expect(hit.title).toBe('Soren Thistlewood')
    expect(hit.where).toContain('Pine Ridge')
    expect(hit.href).toMatch(/^\/tenants\//)
  })

  it('waits for two characters — one matches most of a portfolio', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 01', null, 'mobile_home']] })
    await resident(p, 'MH 01', 'Juno', 'Abernathy')
    expect((await find({ landlordIds: [p.landlordId] }, 'j')).hits).toEqual([])
  })
})

describe('finding a space the way somebody says it', () => {
  it('"mobile home 5" finds it at every property that has one', async () => {
    // His case exactly: the same space number at more than one park, and the
    // property is part of the answer so they can tell them apart.
    const l = await db.connect()
    let landlordId: string, ownerUserId: string
    try {
      await l.query('BEGIN')
      const seeded = await seedLandlord(l)
      landlordId = seeded.landlordId; ownerUserId = seeded.userId
      await l.query('COMMIT')
    } finally { l.release() }
    await park({ property: 'Pine Ridge', landlordId: landlordId!, ownerUserId: ownerUserId!,
                 spaces: [['MH 05', null, 'mobile_home']] })
    await park({ property: 'Cedar Flats', landlordId: landlordId!, ownerUserId: ownerUserId!,
                 spaces: [['MH 05', null, 'mobile_home']] })
    const r = await find({ landlordIds: [landlordId!] }, 'mobile home 5')
    const where = r.hits.filter(h => h.kind === 'space').map(h => h.where).sort()
    expect(where).toEqual(['Cedar Flats', 'Pine Ridge'])
  })

  it('matches a number as a whole number, not a substring', async () => {
    // A substring match returned MH 15 and MH 25 for "5", which is the
    // opposite of what he asked for.
    const p = await park({ property: 'Pine Ridge', spaces: [
      ['MH 05', null, 'mobile_home'], ['MH 15', null, 'mobile_home'], ['MH 25', null, 'mobile_home']] })
    const r = await find({ landlordIds: [p.landlordId] }, 'mh 5')
    expect(r.hits.filter(h => h.kind === 'space').map(h => h.title)).toEqual(['MH 05'])
  })

  it('ignores the leading zero nobody types', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 05', null, 'mobile_home']] })
    for (const q of ['mh 5', 'mh 05', '5 mh']) {
      const r = await find({ landlordIds: [p.landlordId] }, q)
      expect(r.hits.filter(h => h.kind === 'space')).toHaveLength(1)
    }
  })

  it('finds it by the label the landlord gave it', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 29', 'Lot 29', 'mobile_home']] })
    const r = await find({ landlordIds: [p.landlordId] }, 'lot 29')
    expect(r.hits.filter(h => h.kind === 'space').map(h => h.title)).toEqual(['Lot 29'])
  })

  it('says who is in it, because that is the next thing anybody asks', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['RV 12', null, 'rv_spot']] })
    await resident(p, 'RV 12', 'Wren', 'Oakhurst')
    const r = await find({ landlordIds: [p.landlordId] }, 'rv 12')
    expect(r.hits.find(h => h.kind === 'space')!.note).toBe('Wren Oakhurst')
  })

  it('finds a property by name', async () => {
    const p = await park({ property: 'Cedar Flats', spaces: [['MH 01', null, 'mobile_home']] })
    const r = await find({ landlordIds: [p.landlordId] }, 'cedar')
    const hit = r.hits.find(h => h.kind === 'property')!
    expect(hit.title).toBe('Cedar Flats')
    expect(hit.href).toBe(`/properties/${p.propertyId}`)
  })
})

describe('the scope, which is the whole risk of a search bar', () => {
  it('never reaches another company', async () => {
    const mine   = await park({ property: 'Pine Ridge', spaces: [['MH 01', null, 'mobile_home']] })
    const theirs = await park({ property: 'Other Park', spaces: [['MH 01', null, 'mobile_home']] })
    await resident(mine,   'MH 01', 'Juno', 'Abernathy')
    await resident(theirs, 'MH 01', 'Juno', 'Belmont')
    const r = await find({ landlordIds: [mine.landlordId] }, 'juno')
    expect(r.hits.filter(h => h.kind === 'resident').map(h => h.title)).toEqual(['Juno Abernathy'])
    expect(r.hits.every(h => h.where !== 'Other Park')).toBe(true)
  })

  it('narrows a staff member to their own property', async () => {
    const l = await db.connect()
    let landlordId: string, ownerUserId: string
    try {
      await l.query('BEGIN')
      const seeded = await seedLandlord(l)
      landlordId = seeded.landlordId; ownerUserId = seeded.userId
      await l.query('COMMIT')
    } finally { l.release() }
    const a = await park({ property: 'Pine Ridge', landlordId: landlordId!, ownerUserId: ownerUserId!,
                           spaces: [['MH 01', null, 'mobile_home']] })
    const b = await park({ property: 'Cedar Flats', landlordId: landlordId!, ownerUserId: ownerUserId!,
                           spaces: [['MH 02', null, 'mobile_home']] })
    await resident(a, 'MH 01', 'Juno', 'Abernathy')
    await resident(b, 'MH 02', 'Juno', 'Belmont')
    // A manager holding only Pine Ridge.
    const r = await find({ landlordIds: [landlordId!], scoped: [a.propertyId] }, 'juno')
    expect(r.hits.filter(h => h.kind === 'resident').map(h => h.title)).toEqual(['Juno Abernathy'])
    expect(r.hits.find(h => h.kind === 'property' && h.title === 'Cedar Flats')).toBeUndefined()
  })

  it('null scope means NOT NARROWED, not "no properties"', async () => {
    // Getting this backwards hides an owner's whole portfolio from them.
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 01', null, 'mobile_home']] })
    await resident(p, 'MH 01', 'Juno', 'Abernathy')
    const r = await find({ landlordIds: [p.landlordId], scoped: null }, 'juno')
    expect(r.hits.length).toBeGreaterThan(0)
  })

  it('finds nothing at all for a caller with no company', async () => {
    const p = await park({ property: 'Pine Ridge', spaces: [['MH 01', null, 'mobile_home']] })
    await resident(p, 'MH 01', 'Juno', 'Abernathy')
    expect((await find({ landlordIds: [] }, 'juno')).hits).toEqual([])
  })
})
