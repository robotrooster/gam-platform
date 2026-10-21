/**
 * A CO-OWNER OF ONE COMPANY IS NOT THE ACCOUNT.
 *
 * 10/20 — the hole the first cut of the register book opened, and the one it
 * was written to avoid, arriving from the other direction.
 *
 * The lane (posPeople.twoCompanies) is Nic's: "that could be people from my
 * other property could be customers at this property for propane. I shouldn't
 * have to toggle." His two parks are two LLCs under one account, so the book a
 * register reads had to become the ACCOUNT's companies. register_book_companies
 * derived that set from OWNERSHIP ALONE — the companies registered to whoever
 * owns the company passed in — and said so on purpose: "the set is the same
 * whoever is signed in."
 *
 * It is not the same, and the person it is not the same for is named in that
 * same file. Oak Park's registered owner is Nic. Blu is an owner-MEMBER of Oak
 * Park and the registered owner of TruBlu Management LLC — his own company, his
 * own landlord. Standing at Oak Park's register, which he is entitled to stand
 * at, the ownership-only book handed him Mountain View: Nic's residents by
 * name, park and site, with the live email and phone on their own GAM accounts
 * and a saved card on each one chargeable at his counter. Measured read-only
 * against production: 65 people, 65 emails, 42 phones. Before 10/20 every one
 * of those reads was refused.
 *
 * So the book is the account's companies INTERSECTED with the caller's own, and
 * this file pins all four corners of that, because three of them are what makes
 * the fix a fix rather than a revert:
 *
 *   1. the ACCOUNT OWNER still reads his whole account — the propane case;
 *   2. the DESK still reads the account it works for (Nic, decisions #11:
 *      "they are his customers and the desk has to find them") — a cashier
 *      holds no company of her own, so she asks on the account's behalf;
 *   3. a CO-OWNER reads the companies he actually co-owns, and no siblings:
 *      not the list, not the contact, not the card, not the record by id;
 *   4. and the escape hatch in tenantLivesHereSql closes for him too — a lease
 *      the landlord signs alone is the forgery that guard exists to stop, and
 *      a sibling company counted as "not elsewhere" had been unlocking it.
 *
 * Run:
 *   DB_NAME=gam_fin_test TEST_DB_NAME=gam_fin_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *   npx vitest run src/services/registerBook.coOwner.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

// A card on file is the sharpest end of this: the question is whether Blu's
// register is handed a chargeable card, so Stripe always has one to hand back.
// Nothing here talks to Stripe; the gate being tested is in our own SQL.
const CARD = { id: 'pm_test_visa', type: 'card', card: { brand: 'visa', last4: '4242' } }
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    customers: { retrieve: async (id: string) => ({ id, invoice_settings: { default_payment_method: CARD.id } }) },
    paymentMethods: {
      retrieve: async () => CARD,
      list: async () => ({ data: [CARD] }),
    },
  }),
}))

import type { AuthPayload } from '../middleware/auth'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { searchPeople, residentRecord } from './posPeople'
import { savedCardFor } from './posCardOnFile'
import { bookCaller } from './registerBook'

beforeEach(async () => { await cleanupAllSchema() })

/**
 * Nic's shape, plus the co-owner who sits on one of his companies.
 *
 *   account   = Nic, who owns BOTH companies
 *   oak / mtn = his two LLCs, one park each
 *   blu       = an owner-member of `oak` who also owns `truBlu`, his own company
 *   lisa      = the on-site manager at `oak`: a team role, no company of her own
 */
async function nicsAccountAndItsCoOwner() {
  const c = await db.connect()
  try {
    const { userId: nic, landlordId: oak } = await seedLandlord(c, { firstName: 'Nic', lastName: 'Rhoades' })
    const mtn = (await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at)
       VALUES ($1, 'Mountain View RV Park Ranch LLC', DATE '2000-01-01') RETURNING id`, [nic])).rows[0].id
    await c.query(`UPDATE landlords SET business_name = 'Oak Park Motel and RV LLC' WHERE id = $1`, [oak])

    // Blu: his own landlord, and an owner-member of Oak Park. Production has
    // him in landlord_members on Oak Park only — never on Mountain View.
    const { userId: blu, landlordId: truBlu } = await seedLandlord(c, { firstName: 'Blu', lastName: 'Haws' })
    await c.query(`UPDATE landlords SET business_name = 'TruBlu Management LLC' WHERE id = $1`, [truBlu])
    await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [oak, blu])
    // The registered owner is a member of his own companies too (routes/auth
    // resolves landlordIds from this table), so seed what login would see.
    for (const co of [oak, mtn]) {
      await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')
                     ON CONFLICT DO NOTHING`, [co, nic])
    }
    await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')
                   ON CONFLICT DO NOTHING`, [truBlu, blu])

    const lisa = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Lisa', 'Fuentes', TRUE) RETURNING id`,
      [`lisa-${randomUUID().slice(0, 8)}@oakpark.dev`])).rows[0].id

    const oakPark = await seedProperty(c, { landlordId: oak, ownerUserId: nic, managedByUserId: nic })
    const mtnPark = await seedProperty(c, { landlordId: mtn, ownerUserId: nic, managedByUserId: nic })
    await c.query(`UPDATE properties SET name = 'Mountain View RV Ranch' WHERE id = $1`, [mtnPark])
    await c.query(`UPDATE properties SET name = 'Oak Park Motel and RV' WHERE id = $1`, [oakPark])
    return { nic, blu, lisa, oak, mtn, truBlu, oakPark, mtnPark }
  } finally { c.release() }
}

/** Somebody with a GAM account, a live email and phone, and a card saved on it. */
async function resident(first: string, last: string, phone: string) {
  const email = `${first}.${last}.${randomUUID().slice(0, 6)}@elsewhere.dev`.toLowerCase()
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
     VALUES ($1,'x','tenant',$2,$3,$4) RETURNING id`, [email, first, last, phone])).rows[0].id
  const tenantId = (await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id, stripe_customer_id) VALUES ($1, $2) RETURNING id`,
    [userId, `cus_${randomUUID().slice(0, 10)}`])).rows[0].id
  return { userId, tenantId, email, phone }
}

/**
 * Put them on a live lease at `propertyId`. `signedByTenant` false is the S647
 * shape: the landlord's signature alone builds the lease and the place reads
 * 'active' before the resident has agreed to anything.
 */
async function livesAt(landlordId: string, propertyId: string, tenantId: string,
                       site: string, signedByTenant = true) {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await db.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, site])
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await db.query(`UPDATE lease_tenants SET status = 'active' WHERE lease_id = $1`, [leaseId])
    await db.query(`UPDATE leases SET signed_by_tenant = $2 WHERE id = $1`, [leaseId, signedByTenant])
    return { unitId, leaseId }
  } finally { c.release() }
}

/** The session a real request would carry, for bookCaller. */
const session = (over: Partial<AuthPayload>): AuthPayload => ({
  userId: '', role: 'landlord', email: 'x@y.dev', profileId: null, ...over,
} as AuthPayload)

const look = (opts: { at: string; park: string; by: string; q: string; caller: string | null }) =>
  searchPeople({ landlordId: opts.at, propertyId: opts.park, userId: opts.by, q: opts.q,
                 allowElsewhere: true, caller: opts.caller })

describe('the register book stops at the caller\'s own companies', () => {
  it('the account OWNER still reads his other park at this counter — the propane case', async () => {
    const a = await nicsAccountAndItsCoOwner()
    const curtis = await resident('Curtis', 'Prendergast', '6025550177')
    await livesAt(a.mtn, a.mtnPark, curtis.tenantId, 'MH 19')

    const named = (await look({ at: a.oak, park: a.oakPark, by: a.nic, q: 'Prendergast', caller: a.nic }))
      .filter((h) => h.name === 'Curtis Prendergast')
    expect(named).toHaveLength(1)
    expect(named[0].kind).toBe('resident')
    expect(named[0].hint).toBe('resident · Mountain View RV Ranch · Site MH 19')
    expect(named[0].email).toBe(curtis.email)
    expect(named[0].phone).toBe('6025550177')
    // And his card is chargeable at Nic's other counter: one account, one book.
    const card = await savedCardFor({ tenantId: curtis.tenantId, landlordId: a.oak, caller: a.nic })
    expect(card?.last4).toBe('4242')
  })

  it('the DESK reads the account it works for — a cashier holds no company of her own', async () => {
    const a = await nicsAccountAndItsCoOwner()
    const curtis = await resident('Curtis', 'Prendergast', '6025550177')
    await livesAt(a.mtn, a.mtnPark, curtis.tenantId, 'MH 19')

    // Lisa's token carries ONE company — the whole of a team scope — so she is
    // the case landlordScopeIds could never answer. bookCaller asks for her on
    // the account's behalf.
    const asLisa = await bookCaller(session({ userId: a.lisa, role: 'onsite_manager', landlordId: a.oak }), a.oak, query)
    expect(asLisa).toBe(a.nic)
    const named = (await look({ at: a.oak, park: a.oakPark, by: a.lisa, q: 'Prendergast', caller: asLisa }))
      .filter((h) => h.name === 'Curtis Prendergast')
    expect(named).toHaveLength(1)
    expect(named[0].kind).toBe('resident')
    expect(named[0].hint).toBe('resident · Mountain View RV Ranch · Site MH 19')
  })

  it('a CO-OWNER of one company gets no sibling: no site, no live contact, no card', async () => {
    const a = await nicsAccountAndItsCoOwner()
    const curtis = await resident('Curtis', 'Prendergast', '6025550177')
    await livesAt(a.mtn, a.mtnPark, curtis.tenantId, 'MH 19')
    // The record Mountain View's own counter keeps for him.
    const hisRecord = await residentRecord(db, a.mtn, curtis.tenantId, a.nic)

    // Blu asks as himself, which is what a real request does: he is role
    // 'landlord', so bookCaller hands the SQL his own user id.
    const asBlu = await bookCaller(session({ userId: a.blu, role: 'landlord', landlordIds: [a.oak, a.truBlu] }), a.oak, query)
    expect(asBlu).toBe(a.blu)

    const hits = await look({ at: a.oak, park: a.oakPark, by: a.blu, q: 'Prendergast', caller: asBlu })
    const named = hits.filter((h) => h.name === 'Curtis Prendergast')
    // He is findable by NAME — that is the stranger rule, and it is all of it.
    for (const h of named) {
      expect(h.kind).toBe('elsewhere')
      expect(h.email).toBeNull()
      expect(h.phone).toBeNull()
      expect(h.tenantId).toBeNull()
      expect(h.customerId).toBeNull()
      expect(h.hint ?? '').not.toMatch(/Site|Mountain View|resident/i)
    }
    // Nothing of Nic's rode along in the payload at all.
    const wire = JSON.stringify(hits)
    for (const secret of [curtis.email, '6025550177', '5550177', curtis.tenantId, hisRecord, a.mtn, a.mtnPark]) {
      expect(wire).not.toContain(secret)
    }
    expect(wire).not.toContain('MH 19')

    // The card on Curtis's own GAM account is not Blu's to charge.
    expect(await savedCardFor({ tenantId: curtis.tenantId, landlordId: a.oak, caller: asBlu })).toBeNull()
    // Nor by naming Mountain View's record for him outright.
    await expect(savedCardFor({ posCustomerId: hisRecord, landlordId: a.oak, caller: asBlu }))
      .rejects.toThrow(/not on this register/i)
    // Nic, at the same counter, still gets both.
    expect((await savedCardFor({ posCustomerId: hisRecord, landlordId: a.oak, caller: a.nic }))?.last4).toBe('4242')
  })

  it('a lease the co-owner signs ALONE does not unlock a sibling\'s resident', async () => {
    // THE SECONDARY EFFECT, and the reason tenantLivesHereSql has an escape
    // hatch at all. Since S647 a landlord's signature alone builds an active
    // lease, so the strict gate asks for the TENANT's signature — unless this
    // account is the only one they have ever dealt with, in which case nothing
    // on their account came from anywhere else and their own contact is its
    // register's to read. With the book widened by ownership alone, a sibling
    // company counted as "not elsewhere", so Oak Park could draft a lease for a
    // Mountain View resident, sign it by itself, and read their live contact
    // and card — which is precisely the forgery the guard was added to stop.
    const a = await nicsAccountAndItsCoOwner()
    const dana = await resident('Dana', 'Kirkbride', '6025550188')
    await livesAt(a.mtn, a.mtnPark, dana.tenantId, 'MH 7')
    // Blu drafts her a place at Oak Park and signs it himself. Nobody asked her.
    await livesAt(a.oak, a.oakPark, dana.tenantId, '12', /* signedByTenant */ false)

    const asBlu = await bookCaller(session({ userId: a.blu, role: 'landlord', landlordIds: [a.oak, a.truBlu] }), a.oak, query)
    const hit = (await look({ at: a.oak, park: a.oakPark, by: a.blu, q: 'Kirkbride', caller: asBlu }))
      .find((h) => h.name === 'Dana Kirkbride')
    // She is named at his counter — she has a place there, drafted or not — but
    // the contact on her own account is not what he reads.
    expect(hit).toBeTruthy()
    expect(hit!.email).toBeNull()
    expect(hit!.phone).toBeNull()
    expect(await savedCardFor({ tenantId: dana.tenantId, landlordId: a.oak, caller: asBlu })).toBeNull()
  })

  it('and a caller nobody can name reads the one company, never the account', async () => {
    // Fail closed, and in this direction on purpose: a call site that cannot
    // say who is asking narrows the book to the company the route authorized.
    const a = await nicsAccountAndItsCoOwner()
    const curtis = await resident('Curtis', 'Prendergast', '6025550177')
    await livesAt(a.mtn, a.mtnPark, curtis.tenantId, 'MH 19')

    expect(await bookCaller(session({ userId: 'nobody', role: 'tenant' }), a.oak, query)).toBeNull()
    const named = (await look({ at: a.oak, park: a.oakPark, by: a.nic, q: 'Prendergast', caller: null }))
      .filter((h) => h.name === 'Curtis Prendergast' && h.kind === 'resident')
    expect(named).toHaveLength(0)
    expect(await savedCardFor({ tenantId: curtis.tenantId, landlordId: a.oak, caller: null })).toBeNull()
  })
})
