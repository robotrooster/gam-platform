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
import { leftOwingFlagFor, whereAndWhen, theTotal, monthInWords, LEFT_OWING_WORDS } from './leftOwing'

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

/** Somebody who left owing, with an account GAM has verified. */
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

describe('the flag another landlord sees', () => {
  it('is three words and a count — never the amount, the landlord, or the date', async () => {
    const w = await world()
    const userId = await personWhoLeftOwing(w, { amount: 1430.55, leftOn: '2024-08-14' })

    const flag = await leftOwingFlagFor(userId, [w.asking.landlordId])
    expect(flag.flagged).toBe(true)
    expect(flag.count).toBe(1)
    expect(flag.words).toBe(LEFT_OWING_WORDS)

    // The three things he said they must never see.
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
    expect(JSON.stringify(flag)).not.toMatch(/99|2023/)
  })
})

describe('who a flag may be matched to', () => {
  it('ONLY a verified account — never an unverified one', async () => {
    // A name is not an identity. Somebody who typed an address they do not own
    // must not be able to hang a debt on the person who does.
    const w = await world()
    const userId = await personWhoLeftOwing(w, { verified: false })
    expect((await leftOwingFlagFor(userId, [w.asking.landlordId])).flagged).toBe(false)
    await db.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [userId])
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
    // Not the day, not the amount, not the park, not the landlord.
    const everything = JSON.stringify(seen)
    expect(everything).not.toContain('14')
    expect(everything).not.toContain('1430')
    expect(everything).not.toContain(w.owed.landlordId)
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
