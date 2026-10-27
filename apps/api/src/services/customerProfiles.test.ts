/**
 * ONE GAM CUSTOMER PER PERSON (Nic, 10/25) — the spine.
 *
 * "Anywhere that person pops up in GAM, it is one GAM account" — and the two
 * things that keep it honest: three points before anybody is merged, and a
 * business never learning where else somebody appears.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { resolveProfile, lookupForBusiness, appearancesForAdmin, profileForRef, updateProfilePoints } from './customerProfiles'

beforeEach(async () => { await cleanupAllSchema() })

const DOMINIC = { firstName: 'Dominic', lastName: 'Gonzalez', phone: '(928) 555-0100' }

async function company() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    await c.query('COMMIT')
    return ll
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const posRow = async (landlordId: string, p: { first: string; last: string; phone?: string; email?: string }) => {
  const r = await queryOne<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, phone, email)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [landlordId, p.first, p.last, p.phone ?? null, p.email ?? null])
  return r!.id
}

describe('three points make one GAM customer, across companies', () => {
  it('the same person at two different companies is one profile', async () => {
    const park = await company()
    const mechanic = await company()
    const atPark = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    const atMechanic = await posRow(mechanic.landlordId, { first: 'dominic', last: 'GONZALEZ', phone: '(928) 555-0100' })

    const a = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: atPark, landlordId: park.landlordId })
    const b = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: atMechanic, landlordId: mechanic.landlordId })

    expect(a!.created).toBe(true)
    expect(b!.created).toBe(false)             // recognised, not re-created
    expect(b!.profileId).toBe(a!.profileId)    // ONE GAM customer
    expect(b!.matchedOn.sort()).toEqual(['first_name', 'last_name', 'phone'])
    expect(await query(`SELECT 1 FROM customer_profiles`)).toHaveLength(1)
  })

  it('a resident and a register customer are the same person', async () => {
    // The case Nic described: somebody who lives here and also buys propane.
    const park = await company()
    const c = await db.connect()
    let tenantId: string
    try {
      await c.query('BEGIN'); tenantId = await seedTenant(c); await c.query('COMMIT')
    } finally { c.release() }
    const reg = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })

    const r1 = await resolveProfile(undefined, DOMINIC, { kind: 'tenant', refId: tenantId!, landlordId: park.landlordId })
    const r2 = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: reg, landlordId: park.landlordId })
    expect(r2!.profileId).toBe(r1!.profileId)
    expect(await profileForRef('tenant', tenantId!)).toBe(r1!.profileId)
  })

  it('two points never merge two people', async () => {
    const park = await company()
    const one = await posRow(park.landlordId, { first: 'Mike', last: 'Smith', phone: '9285550100' })
    const two = await posRow(park.landlordId, { first: 'Mike', last: 'Smith', phone: '9285559999' })
    const a = await resolveProfile(undefined,
      { firstName: 'Mike', lastName: 'Smith', phone: '9285550100' },
      { kind: 'pos_customer', refId: one, landlordId: park.landlordId })
    const b = await resolveProfile(undefined,
      { firstName: 'Mike', lastName: 'Smith', phone: '9285559999' },
      { kind: 'pos_customer', refId: two, landlordId: park.landlordId })
    expect(b!.profileId).not.toBe(a!.profileId)
    expect(await query(`SELECT 1 FROM customer_profiles`)).toHaveLength(2)
  })

  it('a row with fewer than three points of its own is left alone', async () => {
    // Of 749 register rows, the ones holding only a name identify nobody.
    const park = await company()
    const thin = await posRow(park.landlordId, { first: 'Mike', last: 'Smith' })
    const out = await resolveProfile(undefined, { firstName: 'Mike', lastName: 'Smith' },
      { kind: 'pos_customer', refId: thin, landlordId: park.landlordId })
    expect(out).toBeNull()
    expect(await query(`SELECT 1 FROM customer_profiles`)).toHaveLength(0)
  })

  it('refuses rather than guessing when two profiles both match', async () => {
    const park = await company()
    // Two profiles that each agree on three points with what comes in.
    await query(`INSERT INTO customer_profiles (first_name, last_name, phone, email)
                 VALUES ('dominic','gonzalez','9285550100', NULL)`)
    await query(`INSERT INTO customer_profiles (first_name, last_name, phone, email)
                 VALUES ('dominic','gonzalez', NULL, 'd@example.com')`)
    const row = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100', email: 'd@example.com' })
    await expect(resolveProfile(undefined,
      { firstName: 'Dominic', lastName: 'Gonzalez', phone: '9285550100', email: 'd@example.com' },
      { kind: 'pos_customer', refId: row, landlordId: park.landlordId }))
      .rejects.toThrow(/more than one GAM customer/)
  })

  it('linking the same row twice changes nothing', async () => {
    const park = await company()
    const row = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    const a = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: row, landlordId: park.landlordId })
    const b = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: row, landlordId: park.landlordId })
    expect(b!.profileId).toBe(a!.profileId)
    expect(await query(`SELECT 1 FROM customer_profile_links`)).toHaveLength(1)
  })
})

describe('what a business learns, and what it does not', () => {
  it('a lookup gives a name and a phone — never where else they appear', async () => {
    const park = await company()
    const mechanic = await company()
    const atPark = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    const atMech = await posRow(mechanic.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: atPark, landlordId: park.landlordId })
    await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: atMech, landlordId: mechanic.landlordId })

    const hits = await lookupForBusiness({ phone: '928-555-0100' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ firstName: 'dominic', lastName: 'gonzalez', phone: '9285550100' })
    // Nic: "won't tell me what other parks they've necessarily stayed at, or
    // when, or where." No email either — that is one of the identifying points.
    expect(Object.keys(hits[0]).sort()).toEqual(['firstName', 'lastName', 'phone', 'profileId'])
  })

  it('a lookup with nothing real to look up finds nobody', async () => {
    const park = await company()
    const row = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: row, landlordId: park.landlordId })
    expect(await lookupForBusiness({ phone: '' })).toHaveLength(0)
    expect(await lookupForBusiness({ lastName: 'g' })).toHaveLength(0)   // one letter lists nobody
  })

  it('only GAM staff see everywhere somebody appears', async () => {
    const park = await company()
    const row = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    const r = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: row, landlordId: park.landlordId })

    await expect(appearancesForAdmin(r!.profileId, { role: 'landlord' })).rejects.toThrow(/Only GAM staff/)
    const seen = await appearancesForAdmin(r!.profileId, { role: 'admin' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'pos_customer', refId: row, landlordId: park.landlordId })
  })
})

describe('a phone number that changes does not make a second person', () => {
  it('the points can be edited, and who changed them is recorded', async () => {
    const park = await company()
    const row = await posRow(park.landlordId, { first: 'Dominic', last: 'Gonzalez', phone: '9285550100' })
    const r = await resolveProfile(undefined, DOMINIC, { kind: 'pos_customer', refId: row, landlordId: park.landlordId })
    const who = await queryOne<{ id: string }>(`SELECT id FROM users LIMIT 1`)

    await updateProfilePoints(r!.profileId, { phone: '928-555-0199' }, who!.id)
    const after = await queryOne<any>(
      `SELECT phone, points_changed_by, points_changed_at IS NOT NULL AS stamped
         FROM customer_profiles WHERE id = $1`, [r!.profileId])
    expect(after).toMatchObject({ phone: '9285550199', points_changed_by: who!.id, stamped: true })
    // The same person, found at the new number, still one profile.
    expect((await lookupForBusiness({ phone: '9285550199' }))[0].profileId).toBe(r!.profileId)
    expect(await query(`SELECT 1 FROM customer_profiles`)).toHaveLength(1)
  })
})
