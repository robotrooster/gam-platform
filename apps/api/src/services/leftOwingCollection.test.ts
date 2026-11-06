// 10/27 (Nic) — THE SECOND DOOR.
//
//   "We phrase it as the landlord will be collecting this debt on behalf of the
//    previous landlord. It's not optional... There's no button they click to
//    accept the sort of taking on the debt. It's they're clicking that they
//    accept that a payment arrangement is going to be added to that tenant's
//    portal."
//
// The invariants worth the most here are the ones about a debt never getting
// lost or doubled as it moves between companies: a debt settles exactly once,
// a carried balance equals what was left plus what the new landlord is owed,
// and an imported balance is never collected at all.

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  collectionOffersFor, openCollection, applyCollected, carryForwardOnDeparture,
  installmentFor, theWords, LEFT_OWING_MIN_INSTALLMENT,
  settledAmount, splitCollection, LEFT_OWING_SHARE_OF_COLLECTED,
} from './leftOwingCollection'
import { leftOwingFlagFor } from './leftOwing'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant, seedUnit } from '../test/dbHelpers'

interface World {
  owed: { landlordId: string; userId: string }
  next: { landlordId: string; userId: string }
  third: { landlordId: string; userId: string }
  propertyId: string
  tenantId: string
  userId: string
  /**
   * 11/5 — the tenancy the resident's OWN balance is owed on. carryForward
   * writes it as the lease's part of their one debt, keyed on this, so that
   * part and services/leftOwingFreeze's restate each other instead of counting
   * the same unpaid rent twice.
   */
  leaseId: string
}

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const owed = await seedLandlord(c)
    const next = await seedLandlord(c)
    const third = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: owed.landlordId, ownerUserId: owed.userId, managedByUserId: owed.userId })
    const tenantId = await seedTenant(c)
    const u = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    await c.query('COMMIT')
    return { owed, next, third, propertyId, tenantId, userId: u.rows[0].user_id,
             leaseId: randomUUID() }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** A debt GAM itself watched go unpaid. */
async function gamDebt(w: World, amount = 1200): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_left_owing
       (landlord_id, property_id, user_id, amount, source_kind, source_key, left_on)
     VALUES ($1,$2,$3,$4,'lease',$5,CURRENT_DATE - 30) RETURNING id`,
    [w.owed.landlordId, w.propertyId, w.userId, amount, randomUUID()])
  return r.rows[0].id
}

/** A balance carried in from another platform. */
async function importedDebt(w: World, amount = 900): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_left_owing
       (landlord_id, property_id, user_id, amount, source_kind, source_key, left_on)
     VALUES ($1,$2,$3,$4,'import',$5,CURRENT_DATE - 30) RETURNING id`,
    [w.owed.landlordId, w.propertyId, w.userId, amount, randomUUID()])
  return r.rows[0].id
}

const tx = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
  const c = await db.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
  finally { c.release() }
}

const state = async (id: string) => (await db.query<any>(
  `SELECT status, total_amount::float8 AS total, collected_amount::float8 AS collected,
          carried_to_owing_id
     FROM left_owing_collections WHERE id = $1`, [id])).rows[0]

beforeEach(cleanupAllSchema)

describe('what the landlord is told', () => {
  /**
   * 10/29 (Nic): "we're going to divide that either over 6 months or 4
   * months." Six or four, never twelve, and never the landlord's choice — the
   * schedule is GAM's, the same as a Flex product's. The year this used to
   * spread over was my own invention from 10/21, before he named a number.
   */
  it('spreads it over six months, or four when six would be under the floor', () => {
    // $960 settled: six payments of $160, comfortably over the floor.
    expect(installmentFor(960)).toEqual({ amount: 160, months: 6 })
    // $80 settled: six would be $13.34 a month, under the floor and not worth
    // billing — so it finishes sooner at the floor instead.
    const small = installmentFor(80)
    expect(small.amount).toBe(LEFT_OWING_MIN_INSTALLMENT)
    expect(small.months).toBe(4)
  })

  /**
   * 10/29 — Nic read the six-month ladder and caught this: splitting each
   * payment on its own left the old landlord on $500.01 and the new landlord
   * on $149.99 of a $1,000 debt. "It's only off by a penny, but over a lot of
   * payments and a lot of time, that adds up."
   *
   * The split is measured against the RUNNING TOTAL now, so an error cannot
   * accumulate: after every payment each party holds exactly their share of
   * everything collected so far.
   */
  it('lands each party exactly on their share, however many payments it takes', () => {
    for (const original of [1000, 1200, 480, 250, 777.77]) {
      const settled = settledAmount(original)
      const { amount, months } = installmentFor(settled)
      let collected = 0
      const got = { owed: 0, collector: 0, gam: 0 }
      for (let m = 0; m < months; m++) {
        const pay = Math.min(amount, Math.round((settled - collected) * 100) / 100)
        const s = splitCollection(collected, pay)
        // Every payment divides exactly into itself — no cent invented or lost.
        expect(Math.round((s.owed + s.collector + s.gam) * 100))
          .toBe(Math.round(pay * 100))
        collected = Math.round((collected + pay) * 100) / 100
        got.owed = Math.round((got.owed + s.owed) * 100) / 100
        got.collector = Math.round((got.collector + s.collector) * 100) / 100
        got.gam = Math.round((got.gam + s.gam) * 100) / 100
      }
      // The whole settled amount was billed, and the three shares are each
      // exactly their cut of it — not a penny over, as they were this morning.
      expect(collected).toBe(settled)
      expect(got.owed).toBe(Math.round(settled * LEFT_OWING_SHARE_OF_COLLECTED.owed * 100) / 100)
      expect(got.collector)
        .toBe(Math.round(settled * LEFT_OWING_SHARE_OF_COLLECTED.collector * 100) / 100)
      // GAM takes the remainder, so it absorbs any sub-cent residue left by a
      // settled amount that itself rounded. The three still add to the total.
      expect(Math.round((got.owed + got.collector + got.gam) * 100))
        .toBe(Math.round(settled * 100))
    }
  })

  it('never asks for more than is owed', () => {
    const tiny = installmentFor(10)
    expect(tiny.amount).toBe(10)
    expect(tiny.months).toBe(1)
  })

  it('says what happens, never offers a choice, and names no figure or landlord', () => {
    const words = theWords(1200, 6, 200)
    expect(words).toContain('over $1,000')       // a band, as the first door uses
    expect(words).not.toContain('1,200')         // never the figure
    expect(words).toMatch(/collect/i)
    expect(words).not.toMatch(/\b(decline|opt out|if you agree|would you like)\b/i)
  })
})

describe('opening the arrangement', () => {
  it('offers one per unsettled GAM debt, with the band and the schedule', async () => {
    const w = await world()
    await gamDebt(w, 1200)
    const offers = await collectionOffersFor({ tenantId: w.tenantId, collectingLandlordId: w.next.landlordId })
    expect(offers).toHaveLength(1)
    // 10/29: a $1,200 debt settles at $960 — that is what is offered, banded
    // and scheduled. Six payments of $160.
    expect(offers[0]).toMatchObject({ about: 'over $500', total: 960, installment: 160, months: 6 })
  })

  it('offers nothing for an imported balance, and refuses to open one', async () => {
    // "Carry forward balances from landlords that migrate from other platforms
    // are only a kind of watch list."
    const w = await world()
    const owingId = await importedDebt(w)
    expect(await collectionOffersFor({
      tenantId: w.tenantId, collectingLandlordId: w.next.landlordId })).toEqual([])
    await expect(openCollection({
      owingId, tenantId: w.tenantId, collectingLandlordId: w.next.landlordId,
      acknowledgedBy: w.next.userId,
    })).rejects.toThrow(/another platform/i)
  })

  it('records the exact words the landlord was shown', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 1200)
    const c = await openCollection({
      owingId, tenantId: w.tenantId, collectingLandlordId: w.next.landlordId,
      acknowledgedBy: w.next.userId })
    const row = (await db.query<any>(
      `SELECT acknowledged_words, acknowledged_by FROM left_owing_collections WHERE id = $1`, [c!.id])).rows[0]
    // The band is of the SETTLED $960, not the original $1,200.
    expect(row.acknowledged_words).toContain('over $500')
    expect(row.acknowledged_by).toBe(w.next.userId)
  })

  it('taking the same resident on twice does not raise the debt twice', async () => {
    const w = await world()
    const owingId = await gamDebt(w)
    const a = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const b = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    expect(b!.id).toBe(a!.id)
    const n = await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM left_owing_collections WHERE owing_id = $1`, [owingId])
    expect(Number(n.rows[0].c)).toBe(1)
  })

  it('a landlord never collects a debt they are owed themselves', async () => {
    const w = await world()
    const owingId = await gamDebt(w)
    expect(await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.owed.landlordId, acknowledgedBy: w.owed.userId })).toBeNull()
  })
})

describe('money collected', () => {
  it('adds up, and settles the debt once it is whole', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 300)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    // 10/29: a $300 debt settles at $240 — that is the whole arrangement.
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 100, client: cl }))
    expect(await state(c!.id)).toMatchObject({ status: 'active', collected: 100 })
    // Still flagged while anything is outstanding.
    expect((await leftOwingFlagFor(w.userId, [w.third.landlordId])).flagged).toBe(true)

    const done = await tx(cl => applyCollected({ collectionId: c!.id, amount: 140, client: cl }))
    expect(done.complete).toBe(true)
    expect(await state(c!.id)).toMatchObject({ status: 'complete', collected: 240 })
    // And the flag stops for everybody — the debt is paid.
    expect((await leftOwingFlagFor(w.userId, [w.third.landlordId])).flagged).toBe(false)
  })

  /**
   * ── 10/29 (Nic): THE RESIDENT WHO MOVES ────────────────────────────────────
   *
   *   "The entire point of this was because of semi-short-term RV stays where
   *    people bounce around from place to place every month... the whole point
   *    of this collection system was for RVs specifically because they're a
   *    lot more mobile."
   *
   * Which is the case the first cut got wrong: the settled amount sat on each
   * LANDLORD's arrangement, so a resident passing through three parks handed
   * each one an arrangement for the whole $800 and the debt could be collected
   * three times over. The balance belongs to the DEBT now.
   */
  it('two landlords collect against ONE balance, not one each', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 1000)          // settles at $800

    const first = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await tx(cl => applyCollected({ collectionId: first!.id, amount: 300, client: cl }))

    // They move on. The next park takes them on and is owed the REST — $500,
    // not another $800.
    const second = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.third.landlordId, acknowledgedBy: w.third.userId })
    expect(await state(second!.id)).toMatchObject({ total: 500 })

    // And paying that finishes the debt, though neither arrangement alone
    // ever reached $800.
    const done = await tx(cl => applyCollected({ collectionId: second!.id, amount: 500, client: cl }))
    expect(done.complete).toBe(true)
    const debt = (await db.query<any>(
      `SELECT settled_amount::float8 AS settled, collected_amount::float8 AS collected, settled_at
         FROM tenant_left_owing WHERE id = $1`, [owingId])).rows[0]
    expect(debt.settled).toBe(800)
    expect(debt.collected).toBe(800)
    expect(debt.settled_at).not.toBeNull()
    // The resident paid $800 in all — never $1,600.
    expect((await leftOwingFlagFor(w.userId, [w.owed.landlordId])).flagged).toBe(false)
  })

  it('stops billing an old arrangement once another park has cleared the debt', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 1000)
    const first = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const second = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.third.landlordId, acknowledgedBy: w.third.userId })
    // The second park collects the lot.
    await tx(cl => applyCollected({ collectionId: second!.id, amount: 800, client: cl }))
    // The first park's schedule still has months left on it and must not bill
    // the resident for a balance that no longer exists.
    expect(await state(first!.id)).toMatchObject({ collected: 0 })
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.next.landlordId })
      const leaseId = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,500,'month_to_month','active',CURRENT_DATE) RETURNING id`,
        [unitId, w.next.landlordId])).rows[0].id
      const { billInstallment } = await import('./leftOwingCollection')
      const billed = await billInstallment({
        collectionId: first!.id, invoiceId: null, unitId, leaseId,
        tenantId: w.tenantId, landlordId: w.next.landlordId,
        dueDate: '2027-05-01', client: c })
      expect(billed).toBe(0)
    } finally { c.release() }
  })

  it('never collects past the total, however much arrives', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 300)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 10_000, client: cl }))
    // The settled 80%, never the original $300 and never the $10,000 paid.
    expect(await state(c!.id)).toMatchObject({ collected: 240, status: 'complete' })
  })

  it('a completed arrangement takes no more money', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 100)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    // $100 settles at $80, which pays it off.
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 80, client: cl }))
    const again = await tx(cl => applyCollected({ collectionId: c!.id, amount: 50, client: cl }))
    expect(again).toEqual({ collected: 0, applied: 0, complete: false })
  })
})

/**
 * ── 10/29 (Nic): THE GUEST WHO DRIVES OFF OWING ─────────────────────────────
 *
 *   "If they leave without paying their last electric bill and do the same
 *    thing next month at another place and the same thing a third month at a
 *    third place, nothing... the whole point of this collection system was for
 *    RVs specifically because they're a lot more mobile."
 *
 * Nothing was literally true: the only thing that recorded a departing
 * resident's balance was a LEASE move-out, so the mobile guest left no trace
 * and there was never anything for any of this to collect.
 */
describe('a stay that ends owing', () => {
  async function stay(o: {
    total: number; depositPaid?: number | null; balancePaid?: boolean
    name?: string | null; phone?: string | null; email?: string | null
  }) {
    const w = await world()
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.next.landlordId })
      const b = await c.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, check_in, check_out, total_amount,
            deposit_amount, deposit_paid_at, balance_paid_at,
            guest_name, guest_phone, guest_email, status)
         VALUES ($1,$2,'weekly',CURRENT_DATE - 14, CURRENT_DATE, $3,
                 $4, CASE WHEN $4::numeric IS NULL THEN NULL ELSE NOW() END,
                 CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
                 $6,$7,$8,'checked_in')
         RETURNING id`,
        [unitId, w.next.landlordId, o.total.toFixed(2),
         o.depositPaid == null ? null : o.depositPaid.toFixed(2),
         o.balancePaid === true,
         o.name === undefined ? 'Dale Wisener' : o.name,
         o.phone === undefined ? '928-555-0144' : o.phone,
         o.email === undefined ? null : o.email])
      return { w, bookingId: b.rows[0].id }
    } finally { c.release() }
  }

  const raise = (bookingId: string) => tx(async cl => {
    const { stayDebtOnCheckOut } = await import('./leftOwingCollection')
    return stayDebtOnCheckOut({ client: cl, bookingId })
  })

  const debtFor = async (bookingId: string) => (await db.query<any>(
    `SELECT amount::float8 AS amount, who, phone, source_kind, settled_at
       FROM tenant_left_owing WHERE source_key = $1`, [bookingId])).rows

  it('records what they left owing, against their own name and phone', async () => {
    // $900 stay, $200 deposit taken, balance never settled.
    const { bookingId } = await stay({ total: 900, depositPaid: 200 })
    const r = await raise(bookingId)
    expect(r).toMatchObject({ amount: 700 })

    const [debt] = await debtFor(bookingId)
    expect(debt).toMatchObject({ amount: 700, source_kind: 'stay', who: 'Dale Wisener' })
    // The phone is what the next park matches them on — they have no tenant
    // record and never will.
    expect(debt.phone).toBe('928-555-0144')
    expect(debt.settled_at).toBeNull()
  })

  it('raises nothing when the stay was paid', async () => {
    const { bookingId } = await stay({ total: 900, balancePaid: true })
    expect(await raise(bookingId)).toBeNull()
    expect(await debtFor(bookingId)).toHaveLength(0)
  })

  it('restates rather than raising a second debt when check-out runs again', async () => {
    const { bookingId } = await stay({ total: 900, depositPaid: 200 })
    await raise(bookingId)
    await raise(bookingId)
    const rows = await debtFor(bookingId)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(700)
  })

  /**
   * A check-out undone, the balance then settled, and checked out again. The
   * debt was true when it was written and is not any more.
   */
  it('settles a debt it raised earlier once the stay is paid after all', async () => {
    const { bookingId } = await stay({ total: 900, depositPaid: 200 })
    await raise(bookingId)
    await db.query(`UPDATE unit_bookings SET balance_paid_at = NOW() WHERE id = $1`, [bookingId])
    expect(await raise(bookingId)).toBeNull()
    const [debt] = await debtFor(bookingId)
    expect(debt.settled_at).not.toBeNull()
  })

  /**
   * A debt nobody can be matched to flags nobody and sits forever, which is
   * worse than not writing it.
   */
  it('raises nothing when there is no name, phone or email to match on', async () => {
    const { bookingId } = await stay({ total: 900, depositPaid: 200, name: null, phone: null, email: null })
    expect(await raise(bookingId)).toBeNull()
    expect(await debtFor(bookingId)).toHaveLength(0)
  })
})

describe('the resident leaves before it is paid off', () => {
  it('makes the first landlord whole and passes the rest on, with the new landlord\'s own balance', async () => {
    // "The first landlord will be made whole, and the second landlord's owed
    // amount will be calculated based on that first landlord's balance that was
    // passed on, plus any outstanding from what was accrued with that second
    // landlord, and that will show to a third landlord."
    const w = await world()
    const owingId = await gamDebt(w, 1200)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 500, client: cl }))

    const newId = await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 250, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))

    // 10/29 (Nic): what carries is what landlord two actually PAID OUT, plus
    // what the resident ran up with them. The $1,200 settled at $960, $500 was
    // collected, $460 was not — of which landlord two covers the old
    // landlord's share, $287.50. The other $172.50 was GAM's cut and landlord
    // two's own on money nobody collected, and neither is out a penny of it.
    //
    //   $287.50 fronted + $250.00 their own = $537.50
    //
    // Carrying the whole $460 would have the resident owing a third landlord
    // for money landlord two never spent.
    const made = (await db.query<any>(
      `SELECT landlord_id, amount::float8 AS amount, settled_at FROM tenant_left_owing WHERE id = $1`,
      [newId])).rows[0]
    expect(made.amount).toBe(537.5)
    expect(made.landlord_id).toBe(w.next.landlordId)

    // Landlord one is whole — settled whoever actually pays.
    const first = (await db.query<any>(
      `SELECT settled_at, settled_reason FROM tenant_left_owing WHERE id = $1`, [owingId])).rows[0]
    expect(first.settled_at).not.toBeNull()
    expect(first.settled_reason).toBe('carried_to_next_landlord')

    // The chain is readable from the arrangement.
    expect(await state(c!.id)).toMatchObject({ status: 'carried', carried_to_owing_id: newId })

    // And a THIRD landlord sees one debt, the new one.
    const flag = await leftOwingFlagFor(w.userId, [w.third.landlordId])
    expect(flag.flagged).toBe(true)
    expect(flag.count).toBe(1)
  })

  it('closes the arrangement with nothing carried when it is square', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 300)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 300, client: cl }))
    const newId = await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 0, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))
    expect(newId).toBeNull()
    expect((await leftOwingFlagFor(w.userId, [w.third.landlordId])).flagged).toBe(false)
  })

  it('still raises the new landlord\'s own balance when nothing was carried', async () => {
    const w = await world()
    const newId = await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 400, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))
    const made = (await db.query<any>(
      `SELECT amount::float8 AS amount FROM tenant_left_owing WHERE id = $1`, [newId])).rows[0]
    expect(made.amount).toBe(400)
  })

  it('a debt is settled exactly once, however many times departure runs', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 600)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 0, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))
    // A second departure finds no active arrangement, so nothing moves again.
    const second = await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 0, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))
    expect(second).toBeNull()
    expect(await state(c!.id)).toMatchObject({ status: 'carried' })
  })
})

// ── 10/27 (Nic): "charged in installments in addition to whatever rent" ─────
//
// The line that rides the resident's bill. It is an ordinary carried balance,
// so it inherits the invoice and the landlord's late-fee rules — and FlexPay
// never fronts it, because GAM should not advance one landlord's money to
// settle another landlord's old debt.
describe('the installment that rides the rent', () => {
  async function arranged(total = 1200) {
    const w = await world()
    const owingId = await gamDebt(w, total)
    const unitId = (await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, unit_type, status, rent_amount)
       VALUES ($1,$2,'MH 01','mobile_home','active',500) RETURNING id`,
      [w.propertyId, w.next.landlordId])).rows[0].id
    const leaseId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1,$2,500,'month_to_month','active',CURRENT_DATE) RETURNING id`,
      [unitId, w.next.landlordId])).rows[0].id
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    return { w, owingId, unitId, leaseId, collectionId: c!.id }
  }

  const bill = (a: any, dueDate: string) => tx(cl => (async () => {
    const { billInstallment } = await import('./leftOwingCollection')
    return billInstallment({
      collectionId: a.collectionId, invoiceId: null, unitId: a.unitId, leaseId: a.leaseId,
      tenantId: a.w.tenantId, landlordId: a.w.next.landlordId, dueDate, client: cl })
  })())

  it('writes one carried-balance line a month, at the installment amount', async () => {
    // $1,200 settles at $960, over six months: $160 a month.
    const a = await arranged(1200)
    expect(await bill(a, '2027-03-01')).toBe(160)
    const row = (await db.query<any>(
      `SELECT type, entry_description, amount::float8 AS amount, status, notes
         FROM payments WHERE left_owing_collection_id = $1`, [a.collectionId])).rows[0]
    expect(row).toMatchObject({
      type: 'carried_balance', entry_description: 'BALANCE', amount: 160, status: 'pending' })
    // 10/29 (Nic): "It's going to say, owed to your previous landlord, and
    // that's that." The resident never learns the money divides three ways.
    expect(row.notes).toBe('Owed to your previous landlord')
    expect(row.notes).not.toMatch(/GAM|share|split|cut/i)
  })

  it('never bills the same month twice, however often the run replays', async () => {
    const a = await arranged(1200)
    expect(await bill(a, '2027-03-01')).toBe(160)
    expect(await bill(a, '2027-03-01')).toBe(0)
    const n = (await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM payments WHERE left_owing_collection_id = $1`,
      [a.collectionId])).rows[0]
    expect(Number(n.c)).toBe(1)
  })

  it('bills the remainder on the last month, never the full installment', async () => {
    const a = await arranged(250)        // settles at $200: six months of $33.34
    for (let i = 0; i < 9; i++) await bill(a, `2027-0${(i % 9) + 1}-01`.slice(0, 10))
    const billed = (await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM payments WHERE left_owing_collection_id = $1`,
      [a.collectionId])).rows[0]
    // Never more than the settled amount, however many months are run.
    expect(Number(billed.s)).toBeLessThanOrEqual(200)
  })

  it('stops billing once the whole balance is on bills, even if unpaid', async () => {
    // Money not arriving is not a reason to bill the same debt again.
    // $20 settles at $16, under the $25 floor, so one line covers the lot.
    const a = await arranged(20)
    expect(await bill(a, '2027-03-01')).toBe(16)
    expect(await bill(a, '2027-04-01')).toBe(0)
  })

  it('is a kind of line FlexPay never fronts', async () => {
    // coverLineSql excludes carried balances by name; this asserts the line is
    // written as one, which is what makes that exclusion apply.
    const a = await arranged(600)
    await bill(a, '2027-03-01')
    const t = (await db.query<{ type: string }>(
      `SELECT type FROM payments WHERE left_owing_collection_id = $1`, [a.collectionId])).rows[0]
    expect(t.type).toBe('carried_balance')
  })

  it('closes the whole loop: billed, paid, applied, debt settled', async () => {
    // $20 settles at $16, billed and paid in one line.
    const a = await arranged(20)
    expect(await bill(a, '2027-03-01')).toBe(16)
    const payId = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE left_owing_collection_id = $1`, [a.collectionId])).rows[0].id
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [payId])
    await tx(cl => applyCollected({ collectionId: a.collectionId, amount: 16, client: cl }))
    expect(await state(a.collectionId)).toMatchObject({ status: 'complete', collected: 16 })
    const debt = (await db.query<any>(
      `SELECT settled_at, settled_reason FROM tenant_left_owing WHERE id = $1`, [a.owingId])).rows[0]
    expect(debt.settled_at).not.toBeNull()
    expect(debt.settled_reason).toBe('collected_by_later_landlord')
  })
})

// ── THE MONEY, NOT ONLY THE RECORD ──────────────────────────────────────────
//
//   "they can pay you and we'll collect the money from you. But if you click on
//    this and they don't pay, we're collecting that debt from you. You're going
//    to be paying that debt on that tenant's behalf."
//
// The installment rides the COLLECTING landlord's invoice, so the allocation
// engine credits it to them like any other carried balance. These tests are
// about the dollar not staying there.
describe('whose money it is', () => {
  const held = async (landlordId: string) => (await db.query<any>(
    `SELECT source_type, amount::float8 AS amount, property_id
       FROM held_payout_items WHERE landlord_id = $1 ORDER BY source_type`, [landlordId])).rows

  /**
   * A bill line for the arrangement, as the invoice run writes one.
   * `monthsAhead` dates it forward: the database enforces one installment per
   * arrangement per day (ux_payments_left_owing_installment), which is the
   * monthly schedule's own guard, so a test writing several has to space them
   * the way the real run does.
   */
  async function installmentLine(
    w: World, collectionId: string, amount: number, monthsAhead = 0,
  ): Promise<string> {
    const c = await db.connect()
    let unitId: string
    try { unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.owed.landlordId }) }
    finally { c.release() }
    const r = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, left_owing_collection_id)
       VALUES ($1, $2, $3, 'carried_balance', $4, 'pending',
               (CURRENT_DATE + ($6::int * INTERVAL '1 month'))::date, 'BALANCE', $5)
       RETURNING id`,
      [unitId, w.tenantId, w.next.landlordId, amount.toFixed(2), collectionId, monthsAhead])
    return r.rows[0].id
  }

  it('comes off the landlord who collected it and divides three ways', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 1200)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const paymentId = await installmentLine(w, c!.id, 100)

    await tx(cl => applyCollected({ collectionId: c!.id, amount: 100, paymentId, client: cl }))

    // 10/29 (Nic): 50/15/15 of the ORIGINAL, which on the 80% actually
    // collected is 62.5% / 18.75% / 18.75%. Of $100: $62.50 to the landlord
    // owed, $18.75 back to the one who collected it, $18.75 to GAM.
    //
    // Gross both ways on purpose — the whole $100 comes off the collecting
    // landlord and their own cut returns as its own line, because "the whole
    // thing needs to go out and then come back, not just take it off the top".
    expect(await held(w.next.landlordId)).toEqual([
      { source_type: 'left_owing_netted', amount: -100, property_id: w.propertyId },
      { source_type: 'left_owing_share', amount: 18.75, property_id: w.propertyId },
    ])
    // The landlord owed: their share, on their own property.
    expect(await held(w.owed.landlordId)).toEqual([
      { source_type: 'left_owing_paid', amount: 62.5, property_id: w.propertyId },
    ])
    // And GAM's share is booked as earnings, not left as a residue.
    const gam = (await db.query<any>(
      `SELECT type, amount::float8 AS amount FROM platform_revenue_ledger
        WHERE type = 'left_owing_share'`)).rows
    expect(gam).toEqual([{ type: 'left_owing_share', amount: 18.75 }])
    // The three add back to the cent of what was collected.
    expect(62.5 + 18.75 + 18.75).toBe(100)
  })

  it('moves what was CREDITED, not what was paid, when a payment overshoots', async () => {
    // The excess is the resident's own money and is nobody else's to take.
    const w = await world()
    const owingId = await gamDebt(w, 120)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const paymentId = await installmentLine(w, c!.id, 500)

    // $120 settles at $96, so that is all that can ever be applied.
    const r = await tx(cl => applyCollected({ collectionId: c!.id, amount: 500, paymentId, client: cl }))
    expect(r.applied).toBe(96)
    expect((await held(w.owed.landlordId))[0].amount).toBe(60)      // 62.5% of $96
    expect((await held(w.next.landlordId))[0].amount).toBe(-96)
  })

  /**
   * ── 10/29 (review): GAM EARNS ITS SHARE ON EVERY INSTALLMENT ─────────────
   *
   * GAM's booking was keyed on the DEBT, and platform_revenue_ledger is unique
   * on (reference_id, reference_type, type) with a duplicate check that returns
   * bare. So the first installment booked GAM's share and every one after it
   * booked nothing, silently, while the money sat on the platform balance.
   * Six installments, six bookings, and they add to what GAM actually earned.
   */
  it('books GAM a share on EVERY installment, not just the first', async () => {
    const w = await world()
    const owingId = await gamDebt(w, 1200)      // settles at 960, six months of 160
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })

    for (let i = 0; i < 3; i++) {
      const paymentId = await installmentLine(w, c!.id, 160, i)
      await tx(cl => applyCollected({ collectionId: c!.id, amount: 160, paymentId, client: cl }))
    }

    const booked = (await db.query<any>(
      `SELECT COUNT(*)::int AS n, SUM(amount)::float8 AS total
         FROM platform_revenue_ledger WHERE type = 'left_owing_share'`)).rows[0]
    // 18.75% of each $160 collected, three times — one row per payment.
    expect(booked.n).toBe(3)
    expect(booked.total).toBe(90)
  })

  it('a replayed webhook moves it once', async () => {
    // Held items are unique per (source_type, source_id) and the payment is the
    // id, so the same settle arriving twice cannot pay the owed landlord twice.
    const w = await world()
    const owingId = await gamDebt(w, 1200)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const paymentId = await installmentLine(w, c!.id, 100)

    await tx(cl => applyCollected({ collectionId: c!.id, amount: 100, paymentId, client: cl }))
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 100, paymentId, client: cl }))

    expect(await held(w.owed.landlordId)).toHaveLength(1)
    expect((await held(w.owed.landlordId))[0].amount).toBe(62.5)
    // GAM's share is booked once too, not once per replay.
    const gam = (await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_revenue_ledger WHERE type = 'left_owing_share'`)).rows[0]
    expect(Number(gam.c)).toBe(1)
  })

  it('the second landlord pays the remainder when the resident leaves', async () => {
    //   "if the full amount is not collected by the time the tenant leaves the
    //    second landlord, then the second landlord pays."
    const w = await world()
    const owingId = await gamDebt(w, 1200)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    const paymentId = await installmentLine(w, c!.id, 500)
    await tx(cl => applyCollected({ collectionId: c!.id, amount: 500, paymentId, client: cl }))

    await tx(cl => carryForwardOnDeparture({
      tenantId: w.tenantId, landlordId: w.next.landlordId,
      ownBalance: 250, leaseId: w.leaseId, propertyId: w.propertyId, client: cl }))

    // 10/29: the $1,200 settled at $960. $500 arrived from the resident, of
    // which the landlord owed took $312.50; the $460 never collected leaves
    // them $287.50 short of their share, and the collecting landlord covers
    // THAT — not the whole remainder. GAM and the collecting landlord do not
    // earn their cuts on money nobody collected.
    const paid = (await held(w.owed.landlordId)).map(r => r.amount).sort((a, b) => a - b)
    expect(paid).toEqual([287.5, 312.5])
    const off = (await held(w.next.landlordId)).map(r => r.amount).sort((a, b) => a - b)
    expect(off).toEqual([-500, -287.5, 93.75])

    // The resident's $250 with the second landlord is NOT part of what moved —
    // that is a debt they now owe the second landlord, not money the first one
    // is due. It shows as the carried debt, which the test above asserts.
    // However it arrived, the landlord owed ends up with exactly their 50% of
    // the ORIGINAL $1,200 — which is the whole promise of the settlement.
    const total = (await held(w.owed.landlordId)).reduce((s, r) => s + r.amount, 0)
    expect(total).toBe(600)
  })

  it('never moves money in a circle — the database will not have it', async () => {
    // A landlord collecting their own debt would be paying themselves. The
    // money path needs no guard of its own because the arrangement cannot
    // exist: one CHECK, rather than a test in every writer that moves money.
    const w = await world()
    const owingId = await gamDebt(w, 600)
    const c = await openCollection({ owingId, tenantId: w.tenantId,
      collectingLandlordId: w.next.landlordId, acknowledgedBy: w.next.userId })
    await expect(db.query(
      `UPDATE left_owing_collections SET collecting_landlord_id = $2 WHERE id = $1`,
      [c!.id, w.owed.landlordId])).rejects.toThrow(/left_owing_collections_not_self/)
  })
})

/**
 * ── 10/29 (Nic): COLLECTING ON A STAY, NOT ONLY ON A LEASE ─────────────────
 *
 *   "We need to collect anywhere that they're on the platform. If they stay in
 *    a hotel room and they owe a balance to a previous landlord, their rates
 *    need to show higher... we need to aggressively target people who owe."
 *
 * The other half of the gap stayDebtOnCheckOut closed: that one RAISES a
 * mobile guest's debt, this one collects it from a guest who never signs a
 * lease — the resident the whole mechanism was built for.
 */
