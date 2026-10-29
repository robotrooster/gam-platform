/**
 * 10/22 (Nic) — ONE PERSON, SEVERAL COMPANIES.
 *
 * The property-management portal is folding into the landlord portal, because:
 *
 *   "Blue's going to be property managing for some other people. And he doesn't
 *    necessarily want to toggle between portals with a different login. He
 *    wants to just adjust a view in the same screen."
 *
 * The blocker was here, in two reads that each took the FIRST scope row they
 * found:
 *
 *   SELECT property_ids, all_properties FROM <scope table> WHERE user_id = $1 LIMIT 1
 *
 * The tables are keyed (user_id, landlord_id) and always were, so somebody
 * working for two owners had two rows — and got whichever came back first. One
 * owner's properties answered; the other's were invisible to every list and
 * refused by every action. Worse, if the row that came back first said
 * all_properties, it answered for a company that had granted nothing.
 *
 * The rule now is the platform's own (S654, "the property or the row names the
 * company; none is the default"): a property names its company, and that
 * company's own grant decides.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { assertPropertyInScope, getScopedPropertyIds } from './auth'
import type { AuthPayload } from './auth'

beforeEach(async () => { await cleanupAllSchema() })

/** A company with two properties on it. */
async function company() {
  const c: PoolClient = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const a = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const b = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedUnit(c, { propertyId: a, landlordId })
    await c.query('COMMIT')
    return { ownerUserId: userId, landlordId, propertyA: a, propertyB: b }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Somebody who works for people. */
async function person(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1, 'x', 'Blu', 'Manager', 'property_manager', TRUE) RETURNING id`,
    [`blu-${Math.random().toString(36).slice(2)}@t.dev`])
  return r.rows[0].id
}

/** A grant from one company: named properties, or the whole company. */
async function grant(userId: string, landlordId: string, o: {
  properties?: string[]; all?: boolean; permissions?: Record<string, boolean>
}) {
  await db.query(
    `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1, $2, $3::uuid[], $4, $5::jsonb)`,
    [userId, landlordId, o.properties ?? [], o.all === true, JSON.stringify(o.permissions ?? {})])
}

const asManager = (userId: string, landlordId: string): AuthPayload => ({
  userId, email: 'blu@t.dev', role: 'property_manager', landlordId,
} as AuthPayload)

describe('a manager working for two owners', () => {
  it('reaches a property at EACH of them — the bug that made a second login necessary', async () => {
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA] })
    await grant(blu, two.landlordId, { properties: [two.propertyA] })
    const user = asManager(blu, one.landlordId)

    await expect(assertPropertyInScope(user, one.propertyA)).resolves.toBeUndefined()
    await expect(assertPropertyInScope(user, two.propertyA)).resolves.toBeUndefined()
  })

  it('and is still refused the properties neither owner gave them', async () => {
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA] })
    await grant(blu, two.landlordId, { properties: [two.propertyA] })
    const user = asManager(blu, one.landlordId)

    await expect(assertPropertyInScope(user, one.propertyB)).rejects.toThrow(/not assigned to this property/)
    await expect(assertPropertyInScope(user, two.propertyB)).rejects.toThrow(/not assigned to this property/)
  })

  it('a WHOLE-COMPANY grant at one owner never reaches the other owner', async () => {
    // The dangerous shape: the first row found says "every property", and the
    // read used to apply it to whatever property was being asked about.
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true })
    await grant(blu, two.landlordId, { properties: [two.propertyA] })
    const user = asManager(blu, one.landlordId)

    await expect(assertPropertyInScope(user, one.propertyA)).resolves.toBeUndefined()
    await expect(assertPropertyInScope(user, one.propertyB)).resolves.toBeUndefined()
    await expect(assertPropertyInScope(user, two.propertyA)).resolves.toBeUndefined()
    // Not this one: owner two named one property, and "all" was owner one's word.
    await expect(assertPropertyInScope(user, two.propertyB)).rejects.toThrow(/not assigned/)
  })

  it('a company that granted them nothing refuses them, whatever they hold elsewhere', async () => {
    const one = await company()
    const stranger = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true })
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), stranger.propertyA))
      .rejects.toThrow(/not assigned to this property/)
  })

  it('somebody with no grant at all is told that, not told "not assigned"', async () => {
    const one = await company()
    const blu = await person()
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), one.propertyA))
      .rejects.toThrow(/No property scope assigned/)
  })

  it('an action with no property named still asks which one', async () => {
    const one = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA] })
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), null))
      .rejects.toThrow(/property must be selected/)
  })
})

describe('what they SEE across companies', () => {
  it('every property both owners gave them, in one list', async () => {
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA] })
    await grant(blu, two.landlordId, { properties: [two.propertyA, two.propertyB] })
    const seen = await getScopedPropertyIds(asManager(blu, one.landlordId))
    expect(seen).not.toBeNull()
    expect([...seen!].sort()).toEqual([one.propertyA, two.propertyA, two.propertyB].sort())
  })

  it('a whole-company grant spreads to THAT company, and no further', async () => {
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true })
    await grant(blu, two.landlordId, { properties: [two.propertyA] })
    const seen = await getScopedPropertyIds(asManager(blu, one.landlordId))
    expect([...seen!].sort()).toEqual([one.propertyA, one.propertyB, two.propertyA].sort())
  })

  it('"not narrowed anywhere" still reads as the whole company — the Books pages need it', async () => {
    // null is not "no filter"; it is "this person holds whole companies", which
    // is what lets them open a company-wide P&L. Returning a list instead
    // refused a manager who had every property of the only company they work
    // for, and the Books audience-isolation suite caught it.
    const one = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true })
    expect(await getScopedPropertyIds(asManager(blu, one.landlordId))).toBeNull()
  })

  it('narrowed at one owner means narrowed, even holding all of another', async () => {
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true })
    await grant(blu, two.landlordId, { properties: [two.propertyA] })
    expect(await getScopedPropertyIds(asManager(blu, one.landlordId))).not.toBeNull()
  })

  it('no grant anywhere sees nothing — never everything', async () => {
    const blu = await person()
    expect(await getScopedPropertyIds(asManager(blu, (await company()).landlordId))).toEqual([])
  })
})

describe('an owner is untouched by any of this', () => {
  it('sees everything of theirs and is never scope-checked', async () => {
    const one = await company()
    const owner = { userId: one.ownerUserId, email: 'o@t.dev', role: 'landlord' } as AuthPayload
    await expect(assertPropertyInScope(owner, one.propertyA)).resolves.toBeUndefined()
    expect(await getScopedPropertyIds(owner)).toBeNull()
  })
})

describe('a permission is granted by a company, not held by a person', () => {
  it("one owner's permission does not pass at the other owner's park", async () => {
    // The hole folding the portal in would have opened: a worker's pass carries
    // ONE flat permission set, so "issue refunds" granted at park A would have
    // passed the check at park B, which granted nothing of the kind.
    const one = await company()
    const two = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA], permissions: { 'pos.refund': true } })
    await grant(blu, two.landlordId, { properties: [two.propertyA], permissions: { 'take_payment': true } })
    const user = asManager(blu, one.landlordId)

    // Owner one gave refunds, owner two did not.
    await expect(assertPropertyInScope(user, one.propertyA, { perm: 'pos.refund' })).resolves.toBeUndefined()
    await expect(assertPropertyInScope(user, two.propertyA, { perm: 'pos.refund' }))
      .rejects.toThrow(/Insufficient permissions for this property/)
    // And the other way round.
    await expect(assertPropertyInScope(user, two.propertyA, { perm: 'take_payment' })).resolves.toBeUndefined()
    await expect(assertPropertyInScope(user, one.propertyA, { perm: 'take_payment' })).rejects.toThrow(/Insufficient/)
  })

  it('any one of several named permissions is enough, as elsewhere in GAM', async () => {
    const one = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { all: true, permissions: { 'pos.ring_sale': true } })
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), one.propertyA,
      { perm: ['take_payment', 'pos.ring_sale'] })).resolves.toBeUndefined()
  })

  it('naming no permission asks only about the property, exactly as before', async () => {
    const one = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA] })
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), one.propertyA)).resolves.toBeUndefined()
  })

  it('the property is still checked first — a permission cannot buy access', async () => {
    const one = await company()
    const blu = await person()
    await grant(blu, one.landlordId, { properties: [one.propertyA], permissions: { 'pos.refund': true } })
    await expect(assertPropertyInScope(asManager(blu, one.landlordId), one.propertyB, { perm: 'pos.refund' }))
      .rejects.toThrow(/not assigned to this property/)
  })

  it('an owner is never asked for a permission', async () => {
    const one = await company()
    const owner = { userId: one.ownerUserId, email: 'o@t.dev', role: 'landlord' } as AuthPayload
    await expect(assertPropertyInScope(owner, one.propertyA, { perm: 'pos.refund' })).resolves.toBeUndefined()
  })
})
