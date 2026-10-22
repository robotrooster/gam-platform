/**
 * 10/20–21 (Nic) — WHAT ANOTHER LANDLORD IS AND IS NOT TOLD.
 *
 *   "They just can't see specifics. They can't see an exact dollar amount.
 *    They can't see who the other landlord was. They can't see when it
 *    happened, but they can just be flagged as high risk, owes other people
 *    money. They need to settle up."
 *
 * Almost every test here is about something NOT being said. That is the
 * feature: the table holds the amount, the landlord and the dates, and the
 * whole job of this code is that none of them comes out.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import {
  leftOwingFlagFor, whereAndWhen, theTotal, monthInWords, LEFT_OWING_WORDS,
  debtsMatching, openMatchReviews, decideMatchReview,
} from './leftOwing'
import { expectNoFigures } from '../test/noLeaks'

beforeEach(async () => { await cleanupAllSchema() })

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const owed = await seedLandlord(c)                 // the landlord who is out of pocket
    const asking = await seedLandlord(c)               // a different landlord, later
    const propertyId = await seedProperty(c, {
      landlordId: owed.landlordId, ownerUserId: owed.userId, managedByUserId: owed.userId })
    await c.query(`UPDATE properties SET city = 'Las Vegas', state = 'NV' WHERE id = $1`, [propertyId])
    await c.query('COMMIT')
    return { owed, asking, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Somebody who left owing, with the debt pointed at their account. */
async function personWhoLeftOwing(w: any, o: { verified?: boolean; amount?: number; leftOn?: string } = {}) {
  const userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1, $2, 'x', 'Dale', 'Pruitt', 'tenant', $3)`,
    [userId, `dale-${userId.slice(0, 8)}@t.dev`, o.verified !== false])
  await db.query(
    `INSERT INTO tenant_left_owing (landlord_id, property_id, user_id, email, who, amount, source_kind, source_key, left_on)
     VALUES ($1,$2,$3,'dale@t.dev','Dale Pruitt',$4,'stay',$5,$6)`,
    [w.owed.landlordId, w.propertyId, userId, o.amount ?? 1430.55, randomUUID(), o.leftOn ?? '2024-08-14'])
  return userId
}

/**
 * A debt off an imported invoice, pointed at NOBODY — which is what the
 * onboarding import actually produces. The only way to this one is the contact
 * points.
 */
async function importedDebt(w: any, o: {
  who?: string | null; email?: string | null; phone?: string | null
  amount?: number; leftOn?: string
}) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_left_owing
       (landlord_id, property_id, user_id, email, phone, who, amount, source_kind, source_key, left_on)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,'import',$7,$8) RETURNING id`,
    [w.owed.landlordId, w.propertyId, o.email ?? null, o.phone ?? null, o.who ?? null,
     o.amount ?? 1430.55, randomUUID(), o.leftOn ?? '2024-08-14'])
  return r.rows[0].id
}

describe('the flag another landlord sees', () => {
  it('is three words and a count — never the amount, the landlord, or the date', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w, { amount: 1430.55, leftOn: '2024-08-14' })

    const flag = await leftOwingFlagFor(userId, [w.asking.landlordId])
    expect(flag.flagged).toBe(true)
    expect(flag.count).toBe(1)
    expect(flag.words).toBe(LEFT_OWING_WORDS)

    // The three things he said they must never see. The key set is asserted
    // first so the digit checks below can never start reading a random id: a
    // fourth field fails this line deterministically instead of failing the
    // ones under it one deploy in six.
    expect(Object.keys(flag).sort()).toEqual(['count', 'flagged', 'words'])
    const everything = JSON.stringify(flag)
    expect(everything).not.toContain('1430')
    expect(everything).not.toContain('2024')
    expect(everything).not.toContain(w.owed.landlordId)
    // And nothing resembling a figure at all.
    expect(everything).not.toMatch(/\$|\d+\.\d\d/)
  })

  it('says nothing about somebody who owes nobody', async () => {
    const w = await world()
    const clean = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role, email_verified)
       VALUES ($1,'clean@t.dev','x','Ann','Reed','tenant',TRUE)`, [clean])
    expect(await leftOwingFlagFor(clean, [w.asking.landlordId])).toMatchObject({ flagged: false, count: 0, words: '' })
  })

  it('goes quiet the moment the money is square — a flag is a live fact, not a record of a bad month', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w)
    expect((await leftOwingFlagFor(userId, [w.asking.landlordId])).flagged).toBe(true)
    await db.query(`UPDATE tenant_left_owing SET settled_at = NOW(), settled_reason = 'paid' WHERE user_id = $1`, [userId])
    expect((await leftOwingFlagFor(userId, [w.asking.landlordId])).flagged).toBe(false)
    // The row is KEPT — GAM erases nothing; settled_at is what silences it.
    expect(await query(`SELECT 1 FROM tenant_left_owing WHERE user_id = $1`, [userId])).toHaveLength(1)
  })

  it('is never shown to the landlord who is owed — they have the whole story already', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w)
    expect((await leftOwingFlagFor(userId, [w.owed.landlordId])).flagged).toBe(false)
    expect((await leftOwingFlagFor(userId, [w.asking.landlordId])).flagged).toBe(true)
  })

  it('counts several debts without hinting at any of them', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w)
    await db.query(
      `INSERT INTO tenant_left_owing (landlord_id, property_id, user_id, amount, source_kind, source_key, left_on)
       VALUES ($1,$2,$3,99.99,'lease',$4,'2023-02-01')`,
      [w.owed.landlordId, w.propertyId, userId, randomUUID()])
    const flag = await leftOwingFlagFor(userId, [w.asking.landlordId])
    expect(flag.count).toBe(2)
    expect(Object.keys(flag).sort()).toEqual(['count', 'flagged', 'words'])
    expectNoFigures(flag, [99, 2023])
  })
})

describe('who a flag may be matched to', () => {
  it('a debt the landlord pointed at an account counts, verified or not', async () => {
    // 10/22 (Nic) OVERRULED the first cut, which required a verified GAM
    // account: "It's a flag only matches a verified GAM account. That's not
    // right." Pointing the debt at an account is a statement by the landlord
    // who is out of pocket, made when they brought it in — not a guess by us,
    // and not something an unverified email changes.
    const w = await world()
    const userId = await personWhoLeftOwing(w, { verified: false })
    expect((await leftOwingFlagFor(userId, [w.asking.landlordId])).flagged).toBe(true)
  })

  it('says nothing at all when there is no account to match on', async () => {
    const w = await world()
    await db.query(
      `INSERT INTO tenant_left_owing (landlord_id, property_id, user_id, email, who, amount, source_kind, source_key, left_on)
       VALUES ($1,$2,NULL,'walkin@t.dev','A Walk-In',500,'stay',$3,'2024-08-14')`,
      [w.owed.landlordId, w.propertyId, randomUUID()])
    // A guest who never made an account leaves a row a human can read, and no
    // flag anybody can be matched to. That is the right way round.
    expect(await leftOwingFlagFor(null, [w.asking.landlordId])).toMatchObject({ flagged: false })
  })
})

describe('the first door — where and when, free', () => {
  it('gives the month and the town, and nothing nearer than that', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w, { amount: 1430.55, leftOn: '2024-08-14' })
    const [seen] = await whereAndWhen({
      userId, askingLandlordIds: [w.asking.landlordId], byUserId: w.asking.userId })
    expect(seen.when).toBe('August of 2024')
    expect(seen.where).toBe('Las Vegas, NV')
    // THE SHAPE IS THE GUARANTEE: three fields and no more, so a fourth cannot
    // be added later carrying the amount or the park without this failing.
    expect(Object.keys(seen).sort()).toEqual(['owingId', 'when', 'where'])
    // Not the day, not the amount, not the park, not the landlord — read off
    // the two fields that carry WORDS. (Not off the whole row stringified: that
    // drags in a random id, and this failed on a deploy the day it was written,
    // on a uuid that happened to have "14" inside it.)
    const words = `${seen.when} ${seen.where}`
    expect(words).not.toContain('14')
    expect(words).not.toContain('1430')
    expect(words).not.toContain(w.owed.landlordId)
  })

  it('is written down, and pressing it twice takes on nothing', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w)
    const open = () => whereAndWhen({ userId, askingLandlordIds: [w.asking.landlordId], byUserId: w.asking.userId })
    await open(); await open()
    const log = await query<any>(`SELECT door FROM tenant_left_owing_reveals`)
    expect(log).toHaveLength(1)
    expect(log[0].door).toBe('where_and_when')
  })

  it('opens nothing on a debt that is settled, or on the landlord\'s own', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w)
    expect(await whereAndWhen({ userId, askingLandlordIds: [w.owed.landlordId], byUserId: w.owed.userId })).toEqual([])
    await db.query(`UPDATE tenant_left_owing SET settled_at = NOW() WHERE user_id = $1`, [userId])
    expect(await whereAndWhen({ userId, askingLandlordIds: [w.asking.landlordId], byUserId: w.asking.userId })).toEqual([])
  })

  it('a month in words is the month, never the day', () => {
    expect(monthInWords('2024-08-14')).toBe('August of 2024')
    expect(monthInWords('2026-01-01')).toBe('January of 2026')
    for (const bad of [null, '', 'August 2024', '2024-08']) expect(monthInWords(bad as any)).toBeNull()
  })
})

describe('the second door', () => {
  it('refuses out loud rather than quietly doing nothing', async () => {
    // It buys the debt. Until Nic has signed off on how GAM collects it, the
    // honest thing is for anybody who wires a button to this to hear about it.
    await expect(theTotal()).rejects.toThrow(/not built yet/)
  })
})

describe('TWO CONTACT POINTS AGREEING — the rule Nic gave on 10/22', () => {
  const DALE = { name: 'Dale Pruitt', email: 'dale@old.dev', phone: '602-555-9999' }

  it('name + email is enough, with no GAM account anywhere', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', email: 'dale@old.dev' })
    const flag = await leftOwingFlagFor(DALE, [w.asking.landlordId])
    expect(flag).toMatchObject({ flagged: true, count: 1, words: LEFT_OWING_WORDS })
  })

  it('name + phone is enough — "most of the time they don\'t change both"', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', phone: '(602) 555-9999' })
    // A new email entirely; the phone is the one that carried over.
    const flag = await leftOwingFlagFor({ ...DALE, email: 'dale@brandnew.dev' }, [w.asking.landlordId])
    expect(flag.flagged).toBe(true)
  })

  it('a nickname counts: Nick Rhodes against Nicholas Rhodes, same email', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Nick Rhodes', email: 'nick@old.dev' })
    expect((await leftOwingFlagFor(
      { name: 'Nicholas Rhodes', email: 'NICK@old.dev' }, [w.asking.landlordId])).flagged).toBe(true)
  })

  it('a contact point ALONE is not enough — a shared email, a different person', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Ann Reed', email: 'house@old.dev' })
    const flag = await leftOwingFlagFor({ name: 'Dale Pruitt', email: 'house@old.dev' }, [w.asking.landlordId])
    expect(flag.flagged).toBe(false)
    // And it did not vanish either: a person at GAM has it, with both names.
    const open = await openMatchReviews()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      matchedOn: 'email', nameAgreement: 'different', debtName: 'Ann Reed', personName: 'Dale Pruitt',
    })
  })

  it('a name ALONE is not enough — two people really are called Dale Pruitt', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', email: 'theotherdale@old.dev', phone: '480-555-1111' })
    const flag = await leftOwingFlagFor(DALE, [w.asking.landlordId])
    expect(flag.flagged).toBe(false)
    // Nothing matched at all, so there is nothing for a person to research.
    expect(await openMatchReviews()).toEqual([])
  })

  it('the debt is still only shown to OTHER landlords', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', email: 'dale@old.dev' })
    expect((await leftOwingFlagFor(DALE, [w.owed.landlordId])).flagged).toBe(false)
    expect((await leftOwingFlagFor(DALE, [w.asking.landlordId])).flagged).toBe(true)
  })

  it('and a settled debt matches nobody', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', email: 'dale@old.dev' })
    await db.query(`UPDATE tenant_left_owing SET settled_at = NOW(), settled_reason = 'paid'`)
    expect((await leftOwingFlagFor(DALE, [w.asking.landlordId])).flagged).toBe(false)
  })

  it('counts two debts of the same person without hinting at either', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Dale Pruitt', email: 'dale@old.dev', amount: 500 })
    await importedDebt(w, { who: 'D. Pruitt', email: 'dale@old.dev', phone: '602-555-9999', amount: 99.99 })
    const flag = await leftOwingFlagFor(DALE, [w.asking.landlordId])
    // The second is an initial — close, not decided by rule — so it is NOT
    // counted and NOT shown. One flag, one debt, until a person says otherwise.
    expect(flag.count).toBe(1)
    expect(Object.keys(flag).sort()).toEqual(['count', 'flagged', 'words'])
    expectNoFigures(flag, [500, 99.99])
  })
})

describe('the close calls go to a person, and nothing is shown while they wait', () => {
  it('an initial for a first name waits, and the first door stays shut', async () => {
    const w = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    const person = { name: 'Dale Pruitt', email: 'dale@old.dev' }
    expect((await leftOwingFlagFor(person, [w.asking.landlordId])).flagged).toBe(false)
    expect(await whereAndWhen({ person, askingLandlordIds: [w.asking.landlordId], byUserId: w.asking.userId })).toEqual([])

    const open = await openMatchReviews()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      debtName: 'D Pruitt', personName: 'Dale Pruitt', matchedOn: 'email', nameAgreement: 'unsure',
    })
    expect(open[0].why).toMatch(/a person needs to look/)
  })

  it('a brother at the same phone number waits', async () => {
    const w = await world()
    await importedDebt(w, { who: 'Wayne Pruitt', phone: '6025559999' })
    expect((await leftOwingFlagFor(
      { name: 'Dale Pruitt', phone: '602-555-9999' }, [w.asking.landlordId])).flagged).toBe(false)
    expect((await openMatchReviews())[0]).toMatchObject({ matchedOn: 'phone', nameAgreement: 'unsure' })
  })

  it('the same pair is raised once, however many landlords look', async () => {
    const w = await world()
    const other = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    const person = { name: 'Dale Pruitt', email: 'dale@old.dev' }
    for (const l of [w.asking.landlordId, other.asking.landlordId, w.asking.landlordId]) {
      await leftOwingFlagFor(person, [l])
    }
    expect(await openMatchReviews()).toHaveLength(1)
  })

  it('"same person" makes it count for every landlord who asks after that', async () => {
    const w = await world()
    const owingId = await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    const person = { name: 'Dale Pruitt', email: 'dale@old.dev' }
    await leftOwingFlagFor(person, [w.asking.landlordId])
    const review = (await openMatchReviews())[0]
    expect(review.owingId).toBe(owingId)

    const said = await decideMatchReview({ reviewId: review.id, samePerson: true, byUserId: w.asking.userId })
    expect(said).toMatchObject({ decided: true })
    expect(said.why).toMatch(/same person/)

    expect((await leftOwingFlagFor(person, [w.asking.landlordId])).flagged).toBe(true)
    const door = await whereAndWhen({ person, askingLandlordIds: [w.asking.landlordId], byUserId: w.asking.userId })
    expect(door).toEqual([{ owingId, when: 'August of 2024', where: 'Las Vegas, NV' }])
    expect(await openMatchReviews()).toEqual([])
  })

  it('"somebody else" puts it away for good', async () => {
    const w = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    const person = { name: 'Dale Pruitt', email: 'dale@old.dev' }
    await leftOwingFlagFor(person, [w.asking.landlordId])
    const review = (await openMatchReviews())[0]
    await decideMatchReview({ reviewId: review.id, samePerson: false, byUserId: w.asking.userId })

    expect((await leftOwingFlagFor(person, [w.asking.landlordId])).flagged).toBe(false)
    expect(await openMatchReviews()).toEqual([])
    // And it is not raised again on the next search.
    await leftOwingFlagFor(person, [w.asking.landlordId])
    expect(await openMatchReviews()).toEqual([])
  })

  it('deciding twice is refused, not silently overwritten', async () => {
    const w = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    await leftOwingFlagFor({ name: 'Dale Pruitt', email: 'dale@old.dev' }, [w.asking.landlordId])
    const review = (await openMatchReviews())[0]
    expect(await decideMatchReview({ reviewId: review.id, samePerson: true, byUserId: w.asking.userId }))
      .toMatchObject({ decided: true })
    const again = await decideMatchReview({ reviewId: review.id, samePerson: false, byUserId: w.asking.userId })
    expect(again.decided).toBe(false)
    expect(again.why).toMatch(/already been decided/)
  })

  it('the research desk sees everything — that is what research takes', async () => {
    const w = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev', amount: 1430.55, leftOn: '2024-08-14' })
    await leftOwingFlagFor({ name: 'Dale Pruitt', email: 'dale@old.dev' }, [w.asking.landlordId])
    const r = (await openMatchReviews())[0]
    // A GAM admin, not a landlord: the amount, the day and who was owed.
    expect(r.amount).toBe(1430.55)
    expect(r.leftOn).toBe('2024-08-14')
    expect(r.owedTo).toBeTruthy()
    expect(r.source).toMatch(/^import:/)
  })
})

describe('reading without raising anything', () => {
  it('debtsMatching can look and write nothing', async () => {
    const w = await world()
    await importedDebt(w, { who: 'D Pruitt', email: 'dale@old.dev' })
    const seen = await debtsMatching({ name: 'Dale Pruitt', email: 'dale@old.dev' },
      [w.asking.landlordId], { raiseReviews: false })
    expect(seen).toHaveLength(1)
    expect(seen[0].verdict).toBe('review')
    expect(await openMatchReviews()).toEqual([])
  })
})
