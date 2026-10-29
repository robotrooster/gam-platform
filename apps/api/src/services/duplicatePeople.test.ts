/**
 * 10/20 (Nic) — THE MATCHER, AND THE ONE RULE IT MUST NEVER BREAK.
 *
 *   "They have the same name. Same email, or maybe the email's different, but
 *    the phone number's the same. Or maybe the phone number is off by like 1.
 *    Maybe it's a typo... But have it be always have the landlord check that
 *    the customer is the same."
 *
 * The test that matters most in this file is "A NAME ON ITS OWN IS NOT A
 * MATCH". Two Smiths at an RV park are two people, and a list that pairs them
 * is a list Nic stops opening — at which point the real duplicate sits in it
 * unread until the man turns up and somebody else's rig is on his space.
 *
 * The second one that matters is CROSS-ACCOUNT: Nic must never be shown Blu's
 * guests, and a merge must never reach a row outside the account that asked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import {
  MERGE_ACCOUNT_MUST_KEEP, MERGE_BOTH_HAVE_TENANCY, MERGE_NO_ADDRESS, MERGE_SIGN_IN_KEPT,
  MERGE_TWO_ADDRESSES,
  dismissProposal, gatherPeople, holdsTenancy, mergePeople, nameMatch, normalizeEmail,
  normalizeName, normalizePhone, openProposals, proposePairs, scanForDuplicates, verdictFor,
  withinOneEdit, type PersonIdentity,
} from './duplicatePeople'
// The read check-in actually does when it asks whether this guest is screened.
import { guestScreeningContext } from './bookingLeaseDraft'

// ── NORMALIZING, WHICH IS WHERE A PARK EXPORT FIGHTS BACK ───────────────────

describe('normalizeName', () => {
  it('reads "Last, First" the way a park export writes it', () => {
    expect(normalizeName('JENKINS, ROBERT')).toEqual({ first: 'robert', last: 'jenkins', whole: 'robert jenkins' })
  })
  it('drops a suffix — Robert Jenkins Jr is Robert Jenkins in a park office', () => {
    expect(normalizeName('Robert Jenkins Jr.')?.whole).toBe('robert jenkins')
    expect(normalizeName('robert jenkins')?.whole).toBe('robert jenkins')
  })
  it('keeps both tokens when the second one is an initial, not a suffix', () => {
    expect(normalizeName('John V')).toEqual({ first: 'john', last: 'v', whole: 'john v' })
  })
  it('loses the punctuation and the accents', () => {
    expect(normalizeName("O'Brien, R.")).toEqual({ first: 'r', last: 'obrien', whole: 'r obrien' })
    expect(normalizeName('Núñez, José')?.whole).toBe('jose nunez')
    expect(normalizeName('Smith-Jones, Ann')?.last).toBe('smithjones')
  })
  it('does NOT swap on the comma when the name is a party of two', () => {
    // "Smith, Bob and Jane" — the comma separates PEOPLE, not last from first.
    // Swapping it invents a man called Bob-and-Jane Smith.
    expect(normalizeName('Smith, Bob and Jane')?.first).toBe('smith')
  })
  it('gives a one-word name a surname and no first name', () => {
    expect(normalizeName('Smith')).toEqual({ first: '', last: 'smith', whole: 'smith' })
  })
  it('is nothing at all for nothing at all', () => {
    expect(normalizeName('')).toBeNull()
    expect(normalizeName(null)).toBeNull()
    expect(normalizeName('   ...  ')).toBeNull()
  })
})

describe('normalizePhone', () => {
  it('reads every way a phone is written down', () => {
    expect(normalizePhone('(928) 555-1234')).toBe('9285551234')
    expect(normalizePhone('928.555.1234')).toBe('9285551234')
    expect(normalizePhone('+1 928 555 1234')).toBe('9285551234')
  })
  it('keeps the FIRST number when a cell holds two', () => {
    expect(normalizePhone('9285551234 / 9285559999')).toBe('9285551234')
  })
  it('refuses a fragment — matching on four digits pairs strangers', () => {
    expect(normalizePhone('1234')).toBeNull()
    expect(normalizePhone('')).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('strips plus-addressing everywhere', () => {
    expect(normalizeEmail('Bob+RV@Example.com')).toBe('bob@example.com')
  })
  it('strips dots at Gmail, which ignores them, and nowhere else', () => {
    expect(normalizeEmail('bob.jenkins@gmail.com')).toBe('bobjenkins@gmail.com')
    expect(normalizeEmail('bob.jenkins@googlemail.com')).toBe('bobjenkins@gmail.com')
    // At most providers bob.smith@ and bobsmith@ are two different people.
    expect(normalizeEmail('bob.jenkins@cox.net')).toBe('bob.jenkins@cox.net')
  })
  it('is nothing for something that is not an address', () => {
    expect(normalizeEmail('bob')).toBeNull()
    expect(normalizeEmail('@cox.net')).toBeNull()
    expect(normalizeEmail('bob@')).toBeNull()
  })
})

describe('withinOneEdit — "off by like 1. Maybe it\'s a typo."', () => {
  it('catches one wrong digit', () => expect(withinOneEdit('9285551234', '9285551235')).toBe(true))
  it('catches two digits swapped', () => expect(withinOneEdit('9285551234', '9285551243')).toBe(true))
  it('catches a dropped digit', () => expect(withinOneEdit('9285551234', '928555124')).toBe(true))
  it('is not interested in the same number', () => expect(withinOneEdit('9285551234', '9285551234')).toBe(false))
  it('stops at one edit — two is a different number', () => {
    expect(withinOneEdit('9285551234', '9285559999')).toBe(false)
    expect(withinOneEdit('9285551234', '9285551256')).toBe(false)
  })
})

describe('nameMatch', () => {
  const n = (s: string) => normalizeName(s)
  it('is exact when both names are there and both agree', () => {
    expect(nameMatch(n('Robert Jenkins'), n('JENKINS, ROBERT'))).toBe('exact')
  })
  it('is weak for an initial — what a text thread actually produces', () => {
    expect(nameMatch(n('R Jenkins'), n('Robert Jenkins'))).toBe('weak')
  })
  it('is weak for a shortening that is a real prefix', () => {
    expect(nameMatch(n('Rob Jenkins'), n('Robert Jenkins'))).toBe('weak')
  })
  it('refuses a nickname, because a nickname table also says Peggy is Margaret', () => {
    expect(nameMatch(n('Bob Jenkins'), n('Robert Jenkins'))).toBe('none')
  })
  it('refuses a two-letter prefix — "Jo" is Joanne as often as John', () => {
    expect(nameMatch(n('Jo Jenkins'), n('Joanne Jenkins'))).toBe('none')
  })
  it('is nothing when the surnames differ', () => {
    expect(nameMatch(n('Robert Jenkins'), n('Robert Jennings'))).toBe('none')
  })
})

// ── THE SCORING, WHICH IS WHERE THE ONE RULE LIVES ──────────────────────────

const person = (over: Partial<PersonIdentity> & { displayName: string }): PersonIdentity => ({
  key: `u:${randomUUID()}`, kind: 'account', userId: randomUUID(), tenantId: randomUUID(),
  bookingId: null, bookingIds: [], landlordId: randomUUID(),
  rawEmail: null, rawPhone: null, email: null, phone: null,
  name: normalizeName(over.displayName),
  reservations: 0, leases: 0, signedDocuments: 0, firstSeenAt: null,
  ...over,
})

describe('verdictFor — the signals Nic named, and nothing invented beside them', () => {
  it('SAME NAME ALONE IS NEVER A MATCH — two Smiths at an RV park are two people', () => {
    const a = person({ displayName: 'John Smith' })
    const b = person({ displayName: 'John Smith' })
    expect(verdictFor(a, b)).toBeNull()
  })

  it('same name + same email proposes, strongly', () => {
    const a = person({ displayName: 'Robert Jenkins', email: 'rj@cox.net' })
    const b = person({ displayName: 'Jenkins, Robert', email: 'rj@cox.net' })
    const v = verdictFor(a, b)!
    expect(v.confidence).toBe('strong')
    expect(v.signals).toEqual(['name_exact', 'email_exact'])
  })

  it('same name + same phone proposes even when the emails differ', () => {
    const a = person({ displayName: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    const b = person({ displayName: 'Robert Jenkins', email: 'bobj@gmail.com', phone: '9285551234' })
    const v = verdictFor(a, b)!
    expect(v.confidence).toBe('strong')
    expect(v.signals).toEqual(['name_exact', 'phone_exact'])
  })

  it('same name + a phone off by a digit proposes as likely, not strong', () => {
    const a = person({ displayName: 'Robert Jenkins', phone: '9285551234' })
    const b = person({ displayName: 'Robert Jenkins', phone: '9285551243' })
    const v = verdictFor(a, b)!
    expect(v.confidence).toBe('likely')
    expect(v.signals).toEqual(['name_exact', 'phone_typo'])
  })

  it('an initial beside an exact phone is only ever "possible"', () => {
    const a = person({ displayName: 'R Jenkins', phone: '9285551234' })
    const b = person({ displayName: 'Robert Jenkins', phone: '9285551234' })
    expect(verdictFor(a, b)!.confidence).toBe('possible')
  })

  it('an email on its own proposes nothing — a couple shares one inbox', () => {
    const a = person({ displayName: 'Robert Jenkins', email: 'house@cox.net' })
    const b = person({ displayName: 'Diane Albright', email: 'house@cox.net' })
    expect(verdictFor(a, b)).toBeNull()
  })

  it('a phone on its own proposes nothing — a couple shares one rig', () => {
    const a = person({ displayName: 'Robert Jenkins', phone: '9285551234' })
    const b = person({ displayName: 'Diane Albright', phone: '9285551234' })
    expect(verdictFor(a, b)).toBeNull()
  })

  it('a near-name beside a near-phone is a guess, so it proposes nothing', () => {
    const a = person({ displayName: 'R Jenkins', phone: '9285551234' })
    const b = person({ displayName: 'Robert Jenkins', phone: '9285551243' })
    expect(verdictFor(a, b)).toBeNull()
  })
})

describe('proposePairs', () => {
  it('asks each question once, whichever way round it was found', () => {
    const a = person({ displayName: 'Robert Jenkins', email: 'rj@cox.net', key: 'u:aaa' })
    const b = person({ displayName: 'Robert Jenkins', email: 'rj@cox.net', key: 'u:bbb' })
    const one = proposePairs([a, b]).pairs
    const other = proposePairs([b, a]).pairs
    expect(one).toHaveLength(1)
    expect(other).toHaveLength(1)
    expect(one[0].pairKey).toBe(other[0].pairKey)
  })
  it('never compares across surnames, so a park full of Smiths costs nothing', () => {
    const people = Array.from({ length: 40 }, (_, i) =>
      person({ displayName: `Guest${i} Family${i}`, email: 'same@cox.net' }))
    expect(proposePairs(people).pairs).toHaveLength(0)
  })
})

// ── AGAINST A REAL DATABASE ─────────────────────────────────────────────────

async function park(opts: { email?: string } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, opts.email ? { email: opts.email } : {})
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A reservation with a guest written on it and no account behind it. */
async function reservation(p: any, g: { name: string; email?: string | null; phone?: string | null; checkIn?: string }) {
  const rows = await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, guest_phone,
        lease_type, check_in, check_out, nights, status)
     VALUES ($1,$2,$3,$4,$5,'nightly',$6::date, $6::date + 7, 7, 'confirmed')
     RETURNING id`,
    [p.unitId, p.landlordId, g.name, g.email ?? null, g.phone ?? null, g.checkIn ?? '2027-03-01'])
  return rows[0].id
}

/** A person with a GAM sign-in, reachable from this park. */
async function account(p: any, a: { first: string; last: string; email: string; phone?: string; withLease?: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, email_verified)
       VALUES ($1,'x','tenant',$2,$3,$4,TRUE) RETURNING id`,
      [a.email, a.first, a.last, a.phone ?? null])
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    if (a.withLease) {
      const leaseId = await seedLease(c, { unitId: p.unitId, landlordId: p.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: t.rows[0].id })
    } else {
      // Reachable through a reservation instead — the shape a front desk
      // produces when it takes a stay for somebody with an account.
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, guest_name,
           lease_type, check_in, check_out, nights, status)
         VALUES ($1,$2,$3,$4,'nightly','2027-04-01','2027-04-08',7,'confirmed')`,
        [p.unitId, p.landlordId, t.rows[0].id, `${a.first} ${a.last}`])
    }
    await c.query('COMMIT')
    return { userId: u.rows[0].id, tenantId: t.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('scanForDuplicates', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('raises the duplicate the import and the text thread just made', async () => {
    const p = await park()
    // The old system's file spelled him with his email; Nic typed the second
    // one off a text thread with a different address and the same phone.
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '(928) 555-1234' })
    await reservation(p, { name: 'JENKINS, ROBERT', email: 'bobj@gmail.com', phone: '928-555-1234', checkIn: '2027-05-01' })

    const res = await scanForDuplicates({ landlordIds: [p.landlordId] })
    expect(res.raised).toBe(1)
    const open = await openProposals([p.landlordId])
    expect(open).toHaveLength(1)
    expect(open[0].confidence).toBe('strong')
    expect(open[0].signals).toEqual(['name_exact', 'phone_exact'])
  })

  it('catches the phone that is off by one digit', async () => {
    const p = await park()
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551234' })
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551243', checkIn: '2027-06-01' })
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    const open = await openProposals([p.landlordId])
    expect(open).toHaveLength(1)
    expect(open[0].confidence).toBe('likely')
    expect(open[0].signals).toContain('phone_typo')
  })

  it('raises NOTHING for two guests who only share a name', async () => {
    const p = await park()
    await reservation(p, { name: 'John Smith', phone: '9285551111' })
    await reservation(p, { name: 'John Smith', phone: '4805559999', checkIn: '2027-06-01' })
    const res = await scanForDuplicates({ landlordIds: [p.landlordId] })
    expect(res.raised).toBe(0)
    expect(await openProposals([p.landlordId])).toHaveLength(0)
  })

  it('treats one guest with three identical reservations as one person', async () => {
    const p = await park()
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234', checkIn: '2027-07-01' })
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234', checkIn: '2027-08-01' })
    const people = await gatherPeople([p.landlordId])
    expect(people).toHaveLength(1)
    expect(people[0].reservations).toBe(3)
    expect((await scanForDuplicates({ landlordIds: [p.landlordId] })).raised).toBe(0)
  })

  it('leaves a cancelled guest out — a called-off stay is not a decision worth making', async () => {
    const p = await park()
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    const dead = await reservation(p, { name: 'Robert Jenkins', email: 'other@cox.net', phone: '9285551234', checkIn: '2027-09-01' })
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [dead])
    expect((await scanForDuplicates({ landlordIds: [p.landlordId] })).raised).toBe(0)
  })

  it('NEVER shows one account another account\'s people', async () => {
    const mine = await park({ email: `nic-${randomUUID()}@test.dev` })
    const theirs = await park({ email: `blu-${randomUUID()}@test.dev` })
    await reservation(mine, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    await reservation(theirs, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })

    expect((await scanForDuplicates({ landlordIds: [mine.landlordId] })).raised).toBe(0)
    expect(await openProposals([mine.landlordId])).toHaveLength(0)
    expect(await openProposals([theirs.landlordId])).toHaveLength(0)
    // And one landlord's scan never gathers the other's guests at all.
    const people = await gatherPeople([mine.landlordId])
    expect(people).toHaveLength(1)
  })

  it('finds the same man at both of ONE account\'s parks', async () => {
    const p = await park()
    const second = await db.connect()
    let secondLandlordId: string
    let secondUnitId: string
    try {
      await second.query('BEGIN')
      const ll = await second.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [p.userId])
      secondLandlordId = ll.rows[0].id
      const prop = await seedProperty(second, {
        landlordId: secondLandlordId, ownerUserId: p.userId, managedByUserId: p.userId })
      secondUnitId = await seedUnit(second, { propertyId: prop, landlordId: secondLandlordId, unitType: 'rv_spot' })
      await second.query('COMMIT')
    } catch (e) { await second.query('ROLLBACK'); throw e } finally { second.release() }

    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    await reservation({ unitId: secondUnitId, landlordId: secondLandlordId },
      { name: 'Robert Jenkins', email: 'bobj@gmail.com', phone: '9285551234' })

    const res = await scanForDuplicates({ landlordIds: [p.landlordId, secondLandlordId] })
    expect(res.raised).toBe(1)
  })
})

describe('the answer sticks', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('"different people" is final — the pair does not come back next week', async () => {
    const p = await park();
    const owner = p.userId
    await reservation(p, { name: 'John Smith', email: 'js@cox.net', phone: '9285551234' })
    await reservation(p, { name: 'John Smith', email: 'other@cox.net', phone: '9285551234', checkIn: '2027-06-01' })
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    const [open] = await openProposals([p.landlordId])

    await dismissProposal({ proposalId: open.id, landlordIds: [p.landlordId], byUserId: owner })
    expect(await openProposals([p.landlordId])).toHaveLength(0)

    // Next Friday, and the Friday after.
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    expect(await openProposals([p.landlordId])).toHaveLength(0)
    const row = await query<{ status: string }>(
      `SELECT status FROM duplicate_person_proposals WHERE id = $1`, [open.id])
    expect(row[0].status).toBe('not_duplicate')
  })

  it('refuses to answer a question belonging to another account', async () => {
    const mine = await park({ email: `nic-${randomUUID()}@test.dev` })
    const theirs = await park({ email: `blu-${randomUUID()}@test.dev` })
    await reservation(theirs, { name: 'John Smith', email: 'js@cox.net', phone: '9285551234' })
    await reservation(theirs, { name: 'John Smith', email: 'two@cox.net', phone: '9285551234', checkIn: '2027-06-01' })
    await scanForDuplicates({ landlordIds: [theirs.landlordId] })
    const [open] = await openProposals([theirs.landlordId])

    await expect(dismissProposal({
      proposalId: open.id, landlordIds: [mine.landlordId], byUserId: mine.userId,
    })).rejects.toThrow(/not one of yours/)
  })
})

describe('mergePeople', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  async function pairOf(p: any) {
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    const [open] = await openProposals([p.landlordId])
    return open
  }

  it('TWO SIGN-INS: keeps both records, retires the folded address, moves nothing signed', async () => {
    const p = await park()
    const keeper = await account(p, {
      first: 'Calvin', last: 'Curtis', email: 'calvin@home.net', phone: '9285551234', withLease: true })
    const dupe = await account(p, {
      first: 'Calvin', last: 'Curtis', email: 'calvin.curtis@usda.gov', phone: '9285551234' })

    const open = await pairOf(p)
    const keeperSide = open.side_a_user_id === keeper.userId ? 'a' : 'b'
    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide, byUserId: p.userId })

    // BOTH ROWS STILL EXIST and both people are still findable by name.
    const users = await query<{ id: string; email: string; first_name: string }>(
      `SELECT id, email, first_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY email`,
      [[keeper.userId, dupe.userId]])
    expect(users).toHaveLength(2)
    const folded = users.find(u => u.id === dupe.userId)!
    const stays = users.find(u => u.id === keeper.userId)!
    expect(folded.email).toBe(`duplicate-${dupe.userId.slice(0, 8)}@invalid`)
    expect(folded.first_name).toBe('Calvin')                 // still findable by name
    expect(stays.email).toBe('calvin@home.net')              // kept its own sign-in
    expect(outcome.emailRetiredTo).toBe(folded.email)

    // The lease never moved. And NOBODY WAS SUSPENDED: tenants has no landlord
    // column, so the suspension this used to set reached every landlord on GAM
    // — it locked people out of portals Nic has nothing to do with. Retiring
    // the address is what closes this sign-in; there is nothing to flag.
    const t = await query<{ platform_status: string }>(
      `SELECT platform_status FROM tenants WHERE id = $1`, [dupe.tenantId])
    expect(t[0].platform_status).toBe('active')
    const leaseStill = await query<{ n: string }>(
      `SELECT count(*) AS n FROM lease_tenants WHERE tenant_id = $1`, [keeper.tenantId])
    expect(Number(leaseStill[0].n)).toBe(1)

    // Their reservations came across.
    expect(outcome.reservationsRepointed).toBe(1)
    const moved = await query<{ n: string }>(
      `SELECT count(*) AS n FROM unit_bookings WHERE tenant_id = $1`, [keeper.tenantId])
    expect(Number(moved[0].n)).toBe(1)

    // And the question is answered, for good.
    expect(await openProposals([p.landlordId])).toHaveLength(0)
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    expect(await openProposals([p.landlordId])).toHaveLength(0)
  })

  it('moves the sign-in address onto the survivor when the landlord asks for it', async () => {
    const p = await park()
    const keeper = await account(p, {
      first: 'Calvin', last: 'Curtis', email: 'calvin@home.net', phone: '9285551234', withLease: true })
    const dupe = await account(p, {
      first: 'Calvin', last: 'Curtis', email: 'calvin.curtis@usda.gov', phone: '9285551234' })
    const open = await pairOf(p)
    const keeperSide = open.side_a_user_id === keeper.userId ? 'a' : 'b'

    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide,
      signInAddress: 'folded', byUserId: p.userId })

    expect(outcome.emailMoved).toBe('calvin.curtis@usda.gov')
    const stays = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [keeper.userId])
    expect(stays[0].email).toBe('calvin.curtis@usda.gov')
    const gone = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [dupe.userId])
    expect(gone[0].email).toBe(`duplicate-${dupe.userId.slice(0, 8)}@invalid`)
  })

  it('REFUSES to fold an account into a reservation — a reservation cannot hold a lease', async () => {
    const p = await park()
    const acct = await account(p, {
      first: 'Robert', last: 'Jenkins', email: 'rj@cox.net', phone: '9285551234', withLease: true })
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551234' })
    const open = await pairOf(p)
    const guestSide = open.side_a_kind === 'guest' ? 'a' : 'b'
    await expect(mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide: guestSide, byUserId: p.userId,
    })).rejects.toThrow(MERGE_ACCOUNT_MUST_KEEP)
    expect(acct.userId).toBeTruthy()
    // Refused means refused: the question is still open.
    expect(await openProposals([p.landlordId])).toHaveLength(1)
  })

  it('A GUEST AND THEIR ACCOUNT: the reservation points at the person, and still reads as booked', async () => {
    const p = await park()
    const acct = await account(p, {
      first: 'Robert', last: 'Jenkins', email: 'rj@cox.net', phone: '9285551234', withLease: true })
    // The old system spelled him "Last, First" and had a different address for
    // him; the phone is the same, which is what raises the question.
    const bookingId = await reservation(p, {
      name: 'JENKINS, ROBERT', phone: '(928) 555-1234', email: 'bobj@gmail.com' })
    const open = await pairOf(p)
    const acctSide = open.side_a_user_id === acct.userId ? 'a' : 'b'

    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide: acctSide, byUserId: p.userId })
    expect(outcome.reservationsRepointed).toBe(1)

    const b = await query<{ tenant_id: string; guest_name: string; guest_email: string }>(
      `SELECT tenant_id, guest_name, guest_email FROM unit_bookings WHERE id = $1`, [bookingId])
    expect(b[0].tenant_id).toBe(acct.tenantId)
    // What the guest was TOLD is untouched — name and address exactly as booked.
    expect(b[0].guest_name).toBe('JENKINS, ROBERT')
    expect(b[0].guest_email).toBe('bobj@gmail.com')
  })

  it('TWO RESERVATIONS: fills the address that was missing, and never asks again', async () => {
    const p = await park()
    const withEmail = await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    const texted = await reservation(p, { name: 'Robert Jenkins', phone: '9285551243', checkIn: '2027-06-01' })
    const open = await pairOf(p)
    const keeperSide = open.side_a_booking_id === withEmail ? 'a' : 'b'

    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide, byUserId: p.userId })
    expect(outcome.emailsFilled).toBe(1)

    // The stay chain matches on tenant_id OR guest_email, so this is what makes
    // two halves of one guest read as one guest.
    const rows = await query<{ id: string; guest_email: string; folded_into_person_merge_id: string | null }>(
      `SELECT id, guest_email, folded_into_person_merge_id FROM unit_bookings ORDER BY check_in`)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.guest_email === 'rj@cox.net')).toBe(true)
    const stamped = rows.find(r => r.id === texted)!
    expect(stamped.folded_into_person_merge_id).not.toBeNull()

    // BOTH RESERVATIONS ARE STILL ON THE BOARD, and the pair never returns.
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    expect(await openProposals([p.landlordId])).toHaveLength(0)
    const merges = await query<{ n: string }>(`SELECT count(*) AS n FROM person_merges`)
    expect(Number(merges[0].n)).toBe(1)
  })

  it('REFUSES two reservations with two different addresses, rather than picking one', async () => {
    const p = await park()
    await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    await reservation(p, { name: 'Robert Jenkins', email: 'bobj@gmail.com', phone: '9285551234', checkIn: '2027-06-01' })
    const open = await pairOf(p)
    await expect(mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide: 'a', byUserId: p.userId,
    })).rejects.toThrow(MERGE_TWO_ADDRESSES)
    expect(await openProposals([p.landlordId])).toHaveLength(1)
  })

  it('REFUSES two reservations with no address at all — there is nothing to join them on', async () => {
    const p = await park()
    // Two texted reservations, a phone typo between them and no address on
    // either. Identical rows would be ONE guest, not two (gatherPeople groups
    // them), so the typo is what makes this a pair at all.
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551234' })
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551243', checkIn: '2027-06-01' })
    const open = await pairOf(p)
    await expect(mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide: 'a', byUserId: p.userId,
    })).rejects.toThrow(MERGE_NO_ADDRESS)
  })

  it('REFUSES when both sign-ins hold a lease — one of them would be locked out of their own', async () => {
    const p = await park()
    await account(p, { first: 'Robert', last: 'Jenkins', email: 'rj@cox.net', phone: '9285551234', withLease: true })
    await account(p, { first: 'Robert', last: 'Jenkins', email: 'bobj@gmail.com', phone: '9285551234', withLease: true })
    const open = await pairOf(p)
    await expect(mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide: 'a', byUserId: p.userId,
    })).rejects.toThrow(MERGE_BOTH_HAVE_TENANCY)
  })

  it('answers once — a second answer to the same question is refused', async () => {
    const p = await park()
    const withEmail = await reservation(p, { name: 'Robert Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    await reservation(p, { name: 'Robert Jenkins', phone: '9285551243', checkIn: '2027-06-01' })
    const open = await pairOf(p)
    const keeperSide = open.side_a_booking_id === withEmail ? 'a' : 'b'
    await mergePeople({ proposalId: open.id, landlordIds: [p.landlordId], keeperSide, byUserId: p.userId })
    await expect(mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide, byUserId: p.userId,
    })).rejects.toThrow(/already been answered/)
  })
})

// ── THE EDGE OF THE BOOK THAT ASKED ─────────────────────────────────────────
//
// 10/20 — the three that cost somebody something.
//
// A merge happens inside ONE landlord's book, but users and tenants have no
// landlord column: one person, one sign-in, the whole platform. These three
// tests are the three ways that went wrong in the version that shipped — a
// passed check stranded on the folded sign-in, a stranger's resident locked out
// of GAM, and another company's paperwork printed on Nic's screen.

/** A background check this company ran, and the guest paid for, and passed. */
async function passedCheck(opts: {
  landlordId: string; userId: string; tenantId: string; createdAt?: string
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO background_checks
       (landlord_id, user_id, tenant_id, status, amount_charged, decided_at, created_at)
     VALUES ($1,$2,$3,'approved',39.99, now(), COALESCE($4::timestamptz, now()))
     RETURNING id`,
    [opts.landlordId, opts.userId, opts.tenantId, opts.createdAt ?? null])
  return rows[0].id
}

/**
 * A lease document at SOMEBODY ELSE'S company with this person on the signer
 * list. `signed: false` is the man who is mid-signing — the shape that reads as
 * nothing at all in Nic's book, which is exactly why a merge could not see it.
 */
async function signerAtOtherCompany(opts: {
  landlordId: string; userId: string; email: string; name: string; signed: boolean
}): Promise<{ documentId: string; signerId: string }> {
  const doc = await query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, title, status)
     VALUES ($1, 'Lease agreement', $2) RETURNING id`,
    [opts.landlordId, opts.signed ? 'completed' : 'sent'])
  const signer = await query<{ id: string }>(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, token, status, signed_at)
     VALUES ($1,$2,'primary',$3,$4,$5,$6, CASE WHEN $7::boolean THEN now() ELSE NULL END)
     RETURNING id`,
    [doc[0].id, opts.userId, opts.name, opts.email,
     `tok-${randomUUID()}`, opts.signed ? 'signed' : 'sent', opts.signed])
  return { documentId: doc[0].id, signerId: signer[0].id }
}

describe('a merge stops at the edge of the book that asked', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  async function pairOf(p: any) {
    await scanForDuplicates({ landlordIds: [p.landlordId] })
    const [open] = await openProposals([p.landlordId])
    return open
  }

  it('DEFECT 1: the check he paid for and passed follows him, so he is not turned away at the gate', async () => {
    const p = await park()
    // Robert Jenkins has two sign-ins at the one park. Under the OLDER one he
    // paid for a background check for his 60-night stay and passed it.
    const older = await account(p, {
      first: 'Robert', last: 'Jenkins', email: 'rj@cox.net', phone: '9285551234' })
    const newer = await account(p, {
      first: 'Robert', last: 'Jenkins', email: 'bobj@gmail.com', phone: '9285551234' })
    const checkId = await passedCheck({
      landlordId: p.landlordId, userId: older.userId, tenantId: older.tenantId })

    // "Same person — keep the newer account."
    const open = await pairOf(p)
    const keeperSide = open.side_a_user_id === newer.userId ? 'a' : 'b'
    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [p.landlordId], keeperSide, byUserId: p.userId })
    expect(outcome.screeningMoved).toBe(1)

    // THE READ CHECK-IN ACTUALLY DOES. His reservations now resolve to the
    // surviving sign-in, so this is the person the gate asks about.
    const ctx = await guestScreeningContext(null, p.landlordId, null, newer.tenantId)
    expect(ctx.approvedCheckId).toBe(checkId)
    expect(ctx.approvedCheckAt).not.toBeNull()

    // And the check row itself is the same row — nothing was re-run, nothing
    // was erased, and it still carries what he was charged.
    const row = await query<{ user_id: string; tenant_id: string; status: string; amount_charged: string }>(
      `SELECT user_id, tenant_id, status, amount_charged FROM background_checks WHERE id = $1`, [checkId])
    expect(row[0].user_id).toBe(newer.userId)
    expect(row[0].tenant_id).toBe(newer.tenantId)
    expect(row[0].status).toBe('approved')
    expect(Number(row[0].amount_charged)).toBe(39.99)
    // His one platform-wide screening line follows the check that moved.
    const t = await query<{ background_check_id: string; background_check_status: string }>(
      `SELECT background_check_id, background_check_status FROM tenants WHERE id = $1`, [newer.tenantId])
    expect(t[0].background_check_id).toBe(checkId)
    expect(t[0].background_check_status).toBe('approved')
  })

  it('DEFECT 2: a merge in one park never takes a sign-in away from the rest of GAM', async () => {
    const mine = await park({ email: `nic-${randomUUID()}@test.dev` })
    const theirs = await park({ email: `blu-${randomUUID()}@test.dev` })

    // The man who stays: a lease at Nic's park, so he has to survive.
    const keeper = await account(mine, {
      first: 'Calvin', last: 'Curtis', email: 'calvin@home.net', phone: '9285551234', withLease: true })
    // The second sign-in: a reservation at Nic's park, and he is MID-SIGNING a
    // lease with a landlord Nic has never heard of. Nothing Nic can see says
    // so — an unsigned signer row is 0 leases and 0 signed documents here.
    const other = await account(mine, {
      first: 'Calvin', last: 'Curtis', email: 'calvin.curtis@usda.gov', phone: '9285551234' })
    await signerAtOtherCompany({
      landlordId: theirs.landlordId, userId: other.userId,
      email: 'calvin.curtis@usda.gov', name: 'Calvin Curtis', signed: false })

    const people = await gatherPeople([mine.landlordId])
    const foldedSide = people.find(x => x.userId === other.userId)!
    expect(foldedSide.leases).toBe(0)
    expect(foldedSide.signedDocuments).toBe(0)
    expect(holdsTenancy(foldedSide)).toBe(false)

    const open = await pairOf(mine)
    const keeperSide = open.side_a_user_id === keeper.userId ? 'a' : 'b'
    // Nic even asks for that address to become the survivor's sign-in.
    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [mine.landlordId], keeperSide,
      signInAddress: 'folded', byUserId: mine.userId })

    // HIS SIGN-IN IS UNTOUCHED. He can still sign in, esign still lets him
    // sign the other landlord's lease, and if it is already live he can still
    // reach the portal he pays his rent in.
    const u = await query<{ email: string; email_verified: boolean }>(
      `SELECT email, email_verified FROM users WHERE id = $1`, [other.userId])
    expect(u[0].email).toBe('calvin.curtis@usda.gov')
    expect(u[0].email_verified).toBe(true)
    const t = await query<{ platform_status: string }>(
      `SELECT platform_status FROM tenants WHERE id = $1`, [other.tenantId])
    expect(t[0].platform_status).toBe('active')
    // Which is to say: login still finds him by the address he uses.
    const login = await query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = 'calvin.curtis@usda.gov'`)
    expect(login.map(r => r.id)).toEqual([other.userId])
    // The survivor's own sign-in did not change either — no address moved.
    const stays = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [keeper.userId])
    expect(stays[0].email).toBe('calvin@home.net')
    expect(outcome.emailMoved).toBeNull()
    expect(outcome.emailRetiredTo).toBeNull()
    expect(outcome.signInLeftAlone).toBe(true)
    expect(outcome.summary).toContain(MERGE_SIGN_IN_KEPT)
    // And the join Nic asked for still happened, in Nic's own book.
    expect(outcome.reservationsRepointed).toBe(1)
    // The survivor holds a lease here rather than a reservation, so his one
    // reservation now is the one that came across.
    const moved = await query<{ n: string }>(
      `SELECT count(*) AS n FROM unit_bookings WHERE tenant_id = $1 AND landlord_id = $2`,
      [keeper.tenantId, mine.landlordId])
    expect(Number(moved[0].n)).toBe(1)
    expect(await openProposals([mine.landlordId])).toHaveLength(0)
  })

  it('DEFECT 3: another company\'s paperwork is invisible, and never decides one of Nic\'s merges', async () => {
    const mine = await park({ email: `nic-${randomUUID()}@test.dev` })
    const theirs = await park({ email: `blu-${randomUUID()}@test.dev` })

    const keeper = await account(mine, {
      first: 'Robert', last: 'Jenkins', email: 'rj@cox.net', phone: '9285551234', withLease: true })
    const other = await account(mine, {
      first: 'Robert', last: 'Jenkins', email: 'bobj@gmail.com', phone: '9285551234' })
    // He has already SIGNED a lease with the other company. Nic must not learn
    // that, and it must not decide anything about Nic's book.
    const elsewhere = await signerAtOtherCompany({
      landlordId: theirs.landlordId, userId: other.userId,
      email: 'bobj@gmail.com', name: 'Robert Jenkins', signed: true })

    const people = await gatherPeople([mine.landlordId])
    const foldedSide = people.find(x => x.userId === other.userId)!
    expect(foldedSide.signedDocuments).toBe(0)
    expect(foldedSide.leases).toBe(0)
    expect(holdsTenancy(foldedSide)).toBe(false)

    // NOTHING THE SCREEN IS HANDED REFERS TO IT. Not the count, not the
    // document, not the signature, not the company.
    const open = await pairOf(mine)
    const shown = JSON.stringify(open)
    expect(shown).not.toContain(elsewhere.documentId)
    expect(shown).not.toContain(elsewhere.signerId)
    expect(shown).not.toContain(theirs.landlordId)
    // Not one count in the payload says this man signed anything, on either
    // side, so the card cannot print "1 signed document" next to "0 leases".
    expect(shown).not.toMatch(/"signedDocuments":\s*[1-9]/)
    const sides = [open.snapshot.a, open.snapshot.b]
    expect(sides.map((x: any) => x.signedDocuments)).toEqual([0, 0])

    // And the merge is no longer refused on the strength of it. Before, this
    // read as "both sides hold a tenancy" because the other company's
    // signature counted, and Nic could not join two of his own records.
    const keeperSide = open.side_a_user_id === keeper.userId ? 'a' : 'b'
    const outcome = await mergePeople({
      proposalId: open.id, landlordIds: [mine.landlordId], keeperSide, byUserId: mine.userId })
    expect(outcome.reservationsRepointed).toBe(1)
    // THE INTERACTION: dropping the other company's signature from the count is
    // what lets this merge run at all, so the only thing now standing between
    // that man and a retired sign-in is the edge check. His signed lease
    // elsewhere keeps his sign-in exactly as it was.
    expect(outcome.signInLeftAlone).toBe(true)
    const u = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [other.userId])
    expect(u[0].email).toBe('bobj@gmail.com')
    const signed = await query<{ n: string }>(
      `SELECT count(*) AS n FROM lease_document_signers WHERE user_id = $1 AND signed_at IS NOT NULL`,
      [other.userId])
    expect(Number(signed[0].n)).toBe(1)   // his signature is untouched where it lives
  })
})
