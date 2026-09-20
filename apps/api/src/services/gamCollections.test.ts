/**
 * S652 — GAM's collections book.
 *
 * Nic: "we need a log on the admin side that money that we are actually
 * expected to take in is taken in. We need to operate bookkeeping on our own
 * stats. And immediately reach out to people when there's a problem."
 *
 * The load-bearing number is `uncollectable`: money GAM is owed with no route
 * to collect it. It should be zero, and when it is not, somebody is about to
 * run a park for free.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'

const notes: any[] = []
vi.mock('./notifications', () => ({
  createNotification: vi.fn(async (n: any) => { notes.push(n) }),
}))

import { collectionsBook, noticeUncollectableLandlords } from './gamCollections'

beforeEach(async () => { await cleanupAllSchema(); notes.length = 0 })

async function landlordOwing(amount: number, collected = 0) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { landlordId } = await seedLandlord(c)
    await c.query(
      `INSERT INTO landlord_gam_charges (landlord_id, kind, amount, collected_amount, source_type)
       VALUES ($1,'subscription',$2,$3,'platform_fee')`,
      [landlordId, amount, collected])
    await c.query('COMMIT')
    return landlordId
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('what GAM was owed against what arrived', () => {
  it('separates billed from collected, and names the gap', async () => {
    await landlordOwing(100, 100)   // settled
    await landlordOwing(480, 0)     // not
    const book = await collectionsBook()
    expect(book.billed).toBe(580)
    expect(book.collected).toBe(100)
    expect(book.outstanding).toBe(480)
  })

  it('lists the settled ones too, because a ratio needs a denominator', async () => {
    // A report that only shows problems cannot say whether it is two out of
    // three or two out of two hundred.
    await landlordOwing(100, 100)
    await landlordOwing(480, 0)
    const book = await collectionsBook()
    expect(book.rows).toHaveLength(2)
    expect(book.rows.some((r) => r.outstanding === 0)).toBe(true)
  })

  it('counts a debt with no route to collect as uncollectable', async () => {
    // No payment flow to net against and no bank on file: this is the number
    // that means somebody is running a park for free.
    await landlordOwing(480, 0)
    const book = await collectionsBook()
    expect(book.uncollectable).toBe(480)
    expect(book.rows[0].route).toBe('none')
  })

  it('does not count a debt that netting will take care of', async () => {
    const landlordId = await landlordOwing(480, 0)
    await query(
      `INSERT INTO payments (landlord_id, amount, status, type, due_date, entry_description)
       VALUES ($1, 1200, 'settled', 'rent', CURRENT_DATE, 'RENT')`, [landlordId])
    const book = await collectionsBook()
    expect(book.rows[0].route).toBe('netting')
    expect(book.uncollectable).toBe(0)
  })

  it('ages the oldest unpaid charge', async () => {
    const landlordId = await landlordOwing(480, 0)
    await query(
      `UPDATE landlord_gam_charges SET created_at = NOW() - INTERVAL '40 days' WHERE landlord_id = $1`,
      [landlordId])
    const book = await collectionsBook()
    expect(book.rows[0].oldestUnpaidDays).toBeGreaterThanOrEqual(39)
  })
})

describe('reaching out before anything is locked', () => {
  it('tells the landlord once, and records that it did', async () => {
    const landlordId = await landlordOwing(480, 0)
    const first = await noticeUncollectableLandlords()
    expect(first.notified).toBe(1)
    expect(notes[0].type).toBe('gam_balance_uncollectable')
    expect(notes[0].sendEmail).toBe(true)
    expect(notes[0].emailHtml).toMatch(/480\.00/)
    // Tenants being unaffected is the sentence that stops a landlord panicking
    // and telling their residents something alarming.
    expect(notes[0].emailHtml).toMatch(/tenants are not/i)

    // A monthly drip about the same unlinked bank teaches people to filter it.
    const second = await noticeUncollectableLandlords()
    expect(second.notified).toBe(0)
    expect(notes).toHaveLength(1)

    const [l] = await query<any>(`SELECT uncollectable_notice_at FROM landlords WHERE id = $1`, [landlordId])
    expect(l.uncollectable_notice_at).toBeTruthy()
  })

  it('says nothing to a landlord under the threshold', async () => {
    // $40 is not worth a $6 transfer or an email. The debt simply waits.
    await landlordOwing(40, 0)
    const r = await noticeUncollectableLandlords()
    expect(r.notified).toBe(0)
    expect(notes).toHaveLength(0)
  })

  it('does not chase somebody already locked', async () => {
    const landlordId = await landlordOwing(480, 0)
    await query(`UPDATE landlords SET platform_locked_at = NOW() WHERE id = $1`, [landlordId])
    const r = await noticeUncollectableLandlords()
    expect(r.notified).toBe(0)
  })
})
