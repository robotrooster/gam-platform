/**
 * 10/20 (Nic), shown a "Possible Duplicates" tab in his own sidebar: "That
 * doesn't need to be its own tab. That's kind of ridiculous. What needs to
 * happen is you go into the point of sale and you view the customer list...
 * a customer in GAM, in fact, should be one customer platform wide... The
 * landlord at each property can't see what the other one does, but when they
 * start typing in their name on the point of sale as a customer, they are
 * there. It needs to be platform wide, because otherwise it's going to want to
 * merge nobody and create separate records for every single place that you ever
 * possibly go that's using this."
 *
 * The behavior he is describing is built (services/posPeople searchPeople,
 * searchElsewhere, customerFromElsewhere). Nothing was asserting it, which is
 * the dangerous part: the privacy line is the half that cannot be allowed to
 * drift. "The landlord at each property can't see what the other one does" is
 * one function's worth of SQL away from leaking a person's business, and a
 * well-meant widening of the search would never fail a test. So this file pins
 * BOTH halves at once — found, yes; anything about them, never:
 *
 *   1. one person, one row, across two of the company's own properties;
 *   2. somebody who exists only at ANOTHER company is found by a whole email
 *      or a whole phone — as a name and a masked hint, and nothing else;
 *   3. the response carries none of their history, email, phone or ids;
 *   4. picking somebody who already has a record here reuses it — the register
 *      does not mint a second person.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { searchPeople, customerFromElsewhere, residentRecord } from './posPeople'

beforeEach(async () => { await cleanupAllSchema() })

/** A company with two properties — the park he stays at, the park he buys propane at. */
async function companyWithTwoParks() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const parks: string[] = []
    for (const _ of [0, 1]) {
      parks.push(await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId }))
    }
    return { landlordId, userId, parkA: parks[0], parkB: parks[1] }
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

/** Put `tenantId` on a live lease at `propertyId`. */
async function livesAt(landlordId: string, propertyId: string, tenantId: string) {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    // They took the place THEMSELVES — tenantLivesHereSql only counts a lease
    // the tenant signed too, so a company cannot sign one for another
    // company's resident and read their contact off the back of it.
    await db.query(`UPDATE lease_tenants SET status = 'active' WHERE lease_id = $1`, [leaseId])
    await db.query(`UPDATE leases SET signed_by_tenant = TRUE WHERE id = $1`, [leaseId])
    return { unitId, leaseId }
  } finally { c.release() }
}

const countRecords = async (landlordId: string) => (await db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM pos_customers WHERE landlord_id = $1 AND archived_at IS NULL`,
  [landlordId])).rows[0].n

describe('one customer, platform wide', () => {
  it('is ONE row at the register of either of the company\'s parks', async () => {
    // He lives at park B. He walks into park A for propane and the desk types
    // his name. "I shouldn't have to toggle."
    const { landlordId, userId, parkA, parkB } = await companyWithTwoParks()
    const bob = await person('Bob', 'Housley')
    await livesAt(landlordId, parkB, bob.tenantId)

    const atA = await searchPeople({ landlordId, propertyId: parkA, userId, q: 'Housley', allowElsewhere: true, caller: userId })
    const atB = await searchPeople({ landlordId, propertyId: parkB, userId, q: 'Housley', allowElsewhere: true, caller: userId })

    // Found at both counters, and ONCE at each — not one row per park.
    const named = (hits: typeof atA) => hits.filter((h) => h.name === 'Bob Housley')
    expect(named(atA)).toHaveLength(1)
    expect(named(atB)).toHaveLength(1)

    // HOW he reads at each counter. This was the open question of the lane
    // before — he was drawn as a stranger at the far counter, masked hint and a
    // sealed pick — and Nic answered it on 10/20: "The landlord at each
    // property can't see what the other one does" means a DIFFERENT LANDLORD.
    // These parks are one company of one account, so the man is theirs at both
    // counters: the same named resident, with the site the desk confirms him
    // by, to anyone with register access — a cashier included. The masked
    // treatment is for another ACCOUNT's people (the next test).
    expect(named(atB)[0].kind).toBe('resident')
    expect(named(atB)[0].hint).toMatch(/^resident · Site /)
    expect(named(atA)[0].kind).toBe('resident')
    expect(named(atA)[0].tenantId).toBe(bob.tenantId)
    expect(named(atA)[0].pick).toBeUndefined()
    // The park is named too, because "Site 7" at the wrong park is worse than
    // no site at all; at his own counter it would be on every row, so it is not.
    expect(named(atA)[0].hint).toMatch(/^resident · .+ · Site /)
    expect(named(atB)[0].hint).not.toMatch(/ · .+ · Site /)
    // He lives under one of this company's leases, so his own contact is this
    // register's to read (tenantLivesHereSql) — at either park, as before.
    expect(named(atA)[0].email).toBe(bob.email)

    // And picking him at EITHER counter lands on the same single record: the
    // company's own resident, found by tenant id, so there is nothing to merge.
    const fromA = await residentRecord(db, landlordId, bob.tenantId, userId)
    const fromB = await residentRecord(db, landlordId, bob.tenantId, userId)
    expect(fromA).toBe(fromB)
    expect(await countRecords(landlordId)).toBe(1)
  })

  it('a person who buys at one park and stays at the other keeps one record and one history', async () => {
    const { landlordId, userId, parkA, parkB } = await companyWithTwoParks()
    const bob = await person('Bob', 'Propane')
    await livesAt(landlordId, parkB, bob.tenantId)
    const recordId = await residentRecord(db, landlordId, bob.tenantId, userId)

    // A propane sale rung at park A, against the one record.
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, pos_customer_id, tenant_id, subtotal, tax_amount, total, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,20,0,20,'cash','completed')`,
      [landlordId, parkA, userId, recordId, bob.tenantId])

    // The desk at park B types his name: still one row, and still that record.
    const hits = (await searchPeople({ landlordId, propertyId: parkB, userId, q: 'Propane', allowElsewhere: true, caller: userId }))
      .filter((h) => h.name === 'Bob Propane')
    expect(hits).toHaveLength(1)
    expect(hits[0].customerId).toBe(recordId)
    expect(await countRecords(landlordId)).toBe(1)
  })
})

describe('somebody who belongs to another company', () => {
  it('is found by a WHOLE email — as a name and a masked hint, and nothing else', async () => {
    const mine = await companyWithTwoParks()
    const theirs = await companyWithTwoParks()
    const stranger = await person('Nora', 'Vance', { email: 'nora.vance@gmail.com', phone: '+1 (602) 555-0199' })
    await livesAt(theirs.landlordId, theirs.parkA, stranger.tenantId)

    const hits = await searchPeople({
      landlordId: mine.landlordId, propertyId: mine.parkA, userId: mine.userId,
      q: 'nora.vance@gmail.com', allowElsewhere: true, caller: mine.userId,
    })
    const hit = hits.find((h) => h.name === 'Nora Vance')
    expect(hit).toBeTruthy()
    expect(hit!.kind).toBe('elsewhere')

    // THE LINE NIC DREW: "the landlord at each property can't see what the
    // other one does." A name, and a hint that tells two Noras apart. The hint
    // is the masked email because the clerk typed that email themselves; it
    // hands back nothing they did not already have.
    expect(hit!.hint).toBe('n•••@gmail.com')
    expect(hit!.email).toBeNull()
    expect(hit!.phone).toBeNull()
    expect(hit!.tenantId).toBeNull()
    expect(hit!.customerId).toBeNull()

    // Nothing else of theirs rode along in the payload at all — not the other
    // company, not the park, not "resident", not a lease, balance or id.
    const wire = JSON.stringify(hit)
    for (const secret of [
      stranger.tenantId, stranger.userId, theirs.landlordId, theirs.parkA, theirs.parkB,
      '602', '5550199', '0199', 'nora.vance@gmail.com',
    ]) expect(wire).not.toContain(secret)
    expect(wire).not.toMatch(/resident|lease|balance|site|Site/i)
  })

  it('is found by a WHOLE phone number, and never by a piece of one', async () => {
    const mine = await companyWithTwoParks()
    const theirs = await companyWithTwoParks()
    const stranger = await person('Dale', 'Mercer', { email: 'dale@mercer.dev', phone: '6025550143' })
    await livesAt(theirs.landlordId, theirs.parkA, stranger.tenantId)

    const look = (q: string) => searchPeople({
      landlordId: mine.landlordId, propertyId: mine.parkA, userId: mine.userId, q, allowElsewhere: true, caller: mine.userId })

    expect((await look('6025550143')).some((h) => h.name === 'Dale Mercer')).toBe(true)
    // A piece of a number lists nobody, so a hint can never be grown into the rest.
    expect((await look('5550143')).some((h) => h.name === 'Dale Mercer')).toBe(false)
    expect((await look('0143')).some((h) => h.name === 'Dale Mercer')).toBe(false)
    // A piece of an email, likewise.
    expect((await look('mercer.dev')).some((h) => h.name === 'Dale Mercer')).toBe(false)

    // Typed whole, the hint may show the last four — it is what they typed.
    const whole = (await look('6025550143')).find((h) => h.name === 'Dale Mercer')!
    expect(whole.hint).toBe('phone ••0143')
    expect(whole.phone).toBeNull()
  })
})

describe('picking somebody who is already here', () => {
  it('reuses their record instead of minting a second person', async () => {
    const mine = await companyWithTwoParks()
    const theirs = await companyWithTwoParks()
    // He is at the company's OWN park B, and the desk at park A picks him.
    const bob = await person('Bob', 'Reuse')
    await livesAt(mine.landlordId, mine.parkB, bob.tenantId)
    const already = await residentRecord(db, mine.landlordId, bob.tenantId, mine.userId)
    expect(await countRecords(mine.landlordId)).toBe(1)

    const hits = await searchPeople({
      landlordId: mine.landlordId, propertyId: mine.parkA, userId: mine.userId,
      q: 'Reuse', allowElsewhere: true, caller: mine.userId })
    const hit = hits.find((h) => h.name === 'Bob Reuse')!

    if (hit.pick) {
      const made = await customerFromElsewhere(db, mine.landlordId, mine.userId, hit.pick, mine.userId)
      expect(made.existing).toBe(true)
      expect(made.customerId).toBe(already)
    } else {
      expect(hit.customerId).toBe(already)
    }
    // The point of the whole lane: no second row to go and merge later.
    expect(await countRecords(mine.landlordId)).toBe(1)

    // A genuine stranger picked from elsewhere DOES get a record — here, and
    // only here. That is the per-company record the register runs on.
    const stranger = await person('Vic', 'Outside', { email: 'vic@outside.dev' })
    await livesAt(theirs.landlordId, theirs.parkA, stranger.tenantId)
    const sHit = (await searchPeople({
      landlordId: mine.landlordId, propertyId: mine.parkA, userId: mine.userId,
      q: 'vic@outside.dev', allowElsewhere: true, caller: mine.userId })).find((h) => h.name === 'Vic Outside')!
    const first = await customerFromElsewhere(db, mine.landlordId, mine.userId, sHit.pick!, mine.userId)
    expect(first.existing).toBe(false)
    // Picked a second time, the SAME record comes back — elsewhere_ref is the
    // platform person, so one human never becomes two rows here either.
    const second = await customerFromElsewhere(db, mine.landlordId, mine.userId, sHit.pick!, mine.userId)
    expect(second.customerId).toBe(first.customerId)
    expect(await countRecords(mine.landlordId)).toBe(2)
    // And nothing was written into the other company's book.
    expect(await countRecords(theirs.landlordId)).toBe(0)
  })
})
