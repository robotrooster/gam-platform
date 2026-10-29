/**
 * 10/20 (Nic), on the register's customer list: "that could be people from my
 * other property could be customers at this property for propane. I shouldn't
 * have to toggle."
 *
 * HIS TWO PARKS ARE TWO COMPANIES. Mountain View RV Ranch sits under Mountain
 * View RV Park Ranch LLC; Oak Park Motel and RV sits under Oak Park Motel and
 * RV LLC. One property each, two `landlords` rows, one account. The sibling
 * suite (posPeople.platformWide) pins the two-properties-of-ONE-company shape,
 * which is the one shape Nic does not have — so it could not see that the
 * register's whole person model was keyed on a single `landlords` row. Keyed
 * that way, the propane case he described crossed an ENTITY boundary: his Oak
 * Park resident walked up to the Mountain View counter and read as a stranger
 * from an unrelated landlord, and picking him INSERTED a second record for the
 * same man — his own second charge account, his own saved cards, his own
 * running total. The duplicates we had just stopped manufacturing per property,
 * manufactured per LLC instead.
 *
 * This file pins the account as the line, in both directions:
 *   1. one man, ONE record, across two companies of the same account;
 *   2. he is NAMEABLE at the other company's counter, and his own record there;
 *   3. a company owned by somebody else is still a different book — found only
 *      as a name and a masked hint, and never folded in;
 *   4. and the co-owner trap: sharing an owner-member with a company is NOT
 *      sharing a book, which is why this reads ownership and not
 *      account_companies().
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { searchPeople, customerFromElsewhere, residentRecord, salePerson, findSamePerson, linkSaleToPerson } from './posPeople'

beforeEach(async () => { await cleanupAllSchema() })

/**
 * ONE account, TWO companies, one park each — Nic's actual shape. `a` is the
 * park he rings propane at, `b` the park the man lives at.
 */
async function twoCompaniesOneAccount() {
  const c = await db.connect()
  try {
    const { userId, landlordId: coA } = await seedLandlord(c)
    const coB = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at)
       VALUES ($1, 'Second Park LLC', DATE '2000-01-01') RETURNING id`, [userId])).rows[0].id
    const parkA = await seedProperty(c, { landlordId: coA, ownerUserId: userId, managedByUserId: userId })
    const parkB = await seedProperty(c, { landlordId: coB, ownerUserId: userId, managedByUserId: userId })
    return { userId, coA, coB, parkA, parkB }
  } finally { c.release() }
}

/** Somebody with a GAM account of their own. */
async function person(first: string, last: string, over: { email?: string; phone?: string } = {}) {
  const email = over.email ?? `${first}.${last}.${randomUUID().slice(0, 6)}@elsewhere.dev`.toLowerCase()
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
     VALUES ($1,'x','tenant',$2,$3,$4) RETURNING id`,
    [email, first, last, over.phone ?? null])).rows[0].id
  const tenantId = (await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])).rows[0].id
  return { userId, tenantId, email, phone: over.phone ?? null }
}

/** Put `tenantId` on a live lease at `propertyId`, taken by their own signature. */
async function livesAt(landlordId: string, propertyId: string, tenantId: string, site?: string) {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId, landlordId })
    if (site) await db.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, site])
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await db.query(`UPDATE lease_tenants SET status = 'active' WHERE lease_id = $1`, [leaseId])
    await db.query(`UPDATE leases SET signed_by_tenant = TRUE WHERE id = $1`, [leaseId])
    return { unitId, leaseId }
  } finally { c.release() }
}

/** Every live register record this ACCOUNT holds, whichever of its companies filed it. */
const recordsOnAccount = async (userId: string) => (await db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM pos_customers c JOIN landlords l ON l.id = c.landlord_id
    WHERE l.user_id = $1 AND c.archived_at IS NULL`, [userId])).rows[0].n

describe('one register book per account, not per LLC', () => {
  it('a resident of the account\'s OTHER company keeps one record at this counter', async () => {
    const { userId, coA, coB, parkA, parkB } = await twoCompaniesOneAccount()
    const bob = await person('Bob', 'Housley')
    await livesAt(coB, parkB, bob.tenantId)
    // He bought propane at his own park once, so the account already wrote him down.
    const his = await residentRecord(db, coB, bob.tenantId, userId)
    expect(await recordsOnAccount(userId)).toBe(1)

    // The far counter — a different LLC of the same account — types his name.
    const hits = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'Housley', allowElsewhere: true, caller: userId })
    const named = hits.filter((h) => h.name === 'Bob Housley')
    // Once. Not once as "ours" and again as a stranger from elsewhere.
    expect(named).toHaveLength(1)
    // And as the account's own man: his record, not a sealed pick.
    expect(named[0].customerId).toBe(his)
    expect(named[0].kind).not.toBe('elsewhere')
    expect(named[0].pick).toBeUndefined()

    // Ringing him up at the far counter names HIM, not a 404.
    expect(await salePerson(coA, { posCustomerId: his }, userId)).toMatchObject({ tenantId: bob.tenantId, customerId: his })
    expect((await salePerson(coA, { tenantId: bob.tenantId }, userId))?.customerId).toBe(his)

    // Reaching him by the record-maker's own doors lands on the same row, and
    // the account still holds exactly one of him.
    expect(await residentRecord(db, coA, bob.tenantId, userId)).toBe(his)
    expect(await findSamePerson(db, coA, bob.email, null, userId)).toEqual({ tenantId: bob.tenantId })
    expect(await recordsOnAccount(userId)).toBe(1)
  })

  it('picking him from the far counter\'s list does not mint a second him', async () => {
    const { userId, coA, coB, parkA, parkB } = await twoCompaniesOneAccount()
    const bob = await person('Bob', 'Housley')
    await livesAt(coB, parkB, bob.tenantId)
    const his = await residentRecord(db, coB, bob.tenantId, userId)

    // Whatever the clerk picks him by — his own record, or a pick the search
    // sealed before he had one — one man, one row on this account.
    const picked = await residentRecord(db, coA, bob.tenantId, userId)
    expect(picked).toBe(his)
    expect(await recordsOnAccount(userId)).toBe(1)

    // And a second person who has no record yet is written down ONCE, under
    // whichever company's counter wrote him.
    const ann = await person('Ann', 'Treadwell')
    await livesAt(coB, parkB, ann.tenantId)
    const annAtA = await residentRecord(db, coA, ann.tenantId, userId)
    expect(await residentRecord(db, coB, ann.tenantId, userId)).toBe(annAtA)
    expect(await recordsOnAccount(userId)).toBe(2)
    void parkA
  })

  it('the other park\'s resident with no record yet is NAMED here, with his park and site', async () => {
    // THE PROPANE CASE AS NIC DESCRIBED IT. The man lives at Oak Park and has
    // never bought anything, so no register record exists anywhere — nothing
    // for a book, however wide, to find. Before 10/20 he came back from
    // searchElsewhere drawn as a stranger: "Bob Housley", "b•••@…", no site,
    // and a sealed pick the desk could only take on faith. He is Nic's
    // resident. "The landlord at each property can't see what the other one
    // does" is about a different landlord, so this is named in full.
    const { userId, coA, coB, parkA, parkB } = await twoCompaniesOneAccount()
    await db.query(`UPDATE properties SET name = 'Oak Park Motel and RV' WHERE id = $1`, [parkB])
    const bob = await person('Bob', 'Housley', { phone: '6025550177' })
    await livesAt(coB, parkB, bob.tenantId, '12')
    expect(await recordsOnAccount(userId)).toBe(0)

    const hits = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'Housley', allowElsewhere: true, caller: userId })
    const named = hits.filter((h) => h.name === 'Bob Housley')
    expect(named).toHaveLength(1)
    expect(named[0].kind).toBe('resident')
    expect(named[0].tenantId).toBe(bob.tenantId)
    expect(named[0].pick).toBeUndefined()
    // WHICH ONE HE IS, in the words the desk confirms him by: his status, the
    // park (another of the account's, so it is named), and his site.
    expect(named[0].hint).toBe('resident · Oak Park Motel and RV · Site 12')
    // He lives under one of the account's leases, so his own contact is this
    // register's to read — and not masked, which is for another account's.
    expect(named[0].email).toBe(bob.email)
    expect(named[0].phone).toBe('6025550177')

    // RINGING HIM UP, down the path the register actually takes: the clerk
    // picks him, the sale is linked by tenant id (PATCH
    // /pos/transactions/:id/customer → linkSaleToPerson).
    const saleId = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, property_id)
       VALUES ($1, $2, 'cash', 24, 0, 24, 'completed', $3) RETURNING id`, [coA, userId, parkA])).rows[0].id
    const linked = await linkSaleToPerson(db, { landlordId: coA, saleId, target: { kind: 'resident', tenantId: bob.tenantId }, userId, caller: userId })
    expect(linked.customer_name).toBe('Bob Housley')
    expect(linked.tenant_id).toBe(bob.tenantId)
    const his = linked.pos_customer_id!

    // He was written down ONCE, and the row is reachable from either counter —
    // no second him at the park he lives at, which is the whole point.
    expect(await recordsOnAccount(userId)).toBe(1)
    expect(await residentRecord(db, coB, bob.tenantId, userId)).toBe(his)
    expect(await recordsOnAccount(userId)).toBe(1)
    // And he is still one row at this counter, now carrying his record.
    const again = (await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'Housley', allowElsewhere: true, caller: userId }))
      .filter((h) => h.name === 'Bob Housley')
    expect(again).toHaveLength(1)
    expect(again[0].customerId).toBe(his)
    expect(again[0].hint).toBe('resident · Oak Park Motel and RV · Site 12')
  })

  it('another account is still another book — a name, a masked hint, nothing else', async () => {
    const { userId, coA, parkA } = await twoCompaniesOneAccount()
    const theirs = await twoCompaniesOneAccount()           // somebody else entirely
    const sam = await person('Sam', 'Quint', { email: 'sam.quint.9f3@othercompany.dev' })
    await livesAt(theirs.coB, theirs.parkB, sam.tenantId)
    await residentRecord(db, theirs.coB, sam.tenantId, theirs.userId)

    // Found only by the stricter rule, and drawn as a stranger.
    const hits = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'Quint', allowElsewhere: true, caller: userId })
    const named = hits.filter((h) => h.name === 'Sam Quint')
    expect(named).toHaveLength(1)
    expect(named[0].kind).toBe('elsewhere')
    expect(named[0].email).toBeNull()
    expect(named[0].phone).toBeNull()
    expect(named[0].customerId).toBeNull()
    expect(named[0].tenantId).toBeNull()
    expect(named[0].hint).toBe('s•••@othercompany.dev')

    // Nothing of their business comes with him: no site, no park, no history,
    // no ids — the hint is the whole of what the desk is given.
    expect(named[0].hint).not.toMatch(/Site|Park|resident/i)
    expect(Object.keys(named[0]).sort()).toEqual(
      ['customerId', 'email', 'firstName', 'hint', 'key', 'kind', 'lastName', 'name', 'phone', 'pick', 'tenantId'])

    // And a PIECE of his email finds nobody — the masked hint cannot be grown
    // into the rest of it one character at a time (elsewhereFilter).
    const piece = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'quint.9f3@othercom', allowElsewhere: true, caller: userId })
    expect(piece.filter((h) => h.name === 'Sam Quint')).toHaveLength(0)
    const whole = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'sam.quint.9f3@othercompany.dev', allowElsewhere: true, caller: userId })
    expect(whole.filter((h) => h.name === 'Sam Quint')).toHaveLength(1)

    // Picking him writes a record of THIS account's, holding nothing of theirs.
    const made = await customerFromElsewhere(db, coA, userId, named[0].pick!, userId)
    expect(made.existing).toBe(false)
    expect(made.tenantId).toBeNull()
    const row = (await db.query<any>(
      `SELECT landlord_id, email, phone, tenant_id FROM pos_customers WHERE id = $1`, [made.customerId])).rows[0]
    expect(row.landlord_id).toBe(coA)
    expect(row.email).toBeNull()
    expect(row.phone).toBeNull()
    expect(row.tenant_id).toBeNull()
    // Their own record is untouched, and still theirs.
    expect(await recordsOnAccount(userId)).toBe(1)
    expect(await recordsOnAccount(theirs.userId)).toBe(1)
  })

  it('a co-owner on the books does NOT merge two accounts\' customer books', async () => {
    // The trap account_companies() falls into, and the reason this reads
    // ownership: Nic's Oak Park has an owner-member who also owns a company of
    // his own in another state. Their customers are not Nic's customers.
    const { userId, coA, parkA } = await twoCompaniesOneAccount()
    const outside = await twoCompaniesOneAccount()
    await db.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [coA, outside.userId])

    const kay = await person('Kay', 'Mattoon')
    await livesAt(outside.coA, outside.parkA, kay.tenantId)
    const hers = await residentRecord(db, outside.coA, kay.tenantId, outside.userId)

    // Her record is in HER account's book, not in this one.
    const book = (await db.query<{ id: string }>(
      `SELECT c.id FROM pos_customers c WHERE c.landlord_id IN (SELECT register_book_companies($1, $2))`, [coA, userId])).rows
    expect(book.map((r) => r.id)).not.toContain(hers)

    // At this counter she is a stranger, and ringing her record here is refused.
    const hits = await searchPeople({ landlordId: coA, propertyId: parkA, userId, q: 'Mattoon', allowElsewhere: true, caller: userId })
    expect(hits.filter((h) => h.name === 'Kay Mattoon').map((h) => h.kind)).toEqual(['elsewhere'])
    await expect(salePerson(coA, { posCustomerId: hers }, userId)).rejects.toThrow(/not on this register/i)
  })
})
