/**
 * 10/20 (Nic) — RETURNING IS DERIVED FROM THE CUSTOMER DATA, NOT TICKED.
 *
 *   "Any completed prior stay at that property, at any of your properties? I'd
 *    say completed stay at any properties of yours with no time limit. They're
 *    a known quantity."
 *
 *   "It's just, I want the system to derive that somebody's returning from
 *    having customer data versus the landlord manually choosing to mark it."
 *
 *   "I would say if they're returning by history, they do count against that
 *    cap. Because the thing is, that cap is only counted against long-term
 *    stays. I have several people that come and stay 1 or 2 weeks every winter.
 *    Like they just do on their way to Mexico or whatever. None of those people
 *    are going to count against that cap. It's only the seasonal people."
 *
 * So:
 *   D1  A completed stay at ANY property on the landlord's ACCOUNT, no time
 *       limit, means no background check. Nobody is asked and nothing is
 *       written — no attestation, no allowance to refuse.
 *   D2  Another landlord's guest book never counts.
 *   D3  The rolling-year allowance counts a derived returning guest ONLY when
 *       the new stay is a month or longer. A two-week winter visitor never
 *       consumes a place, however many years they come back.
 *   D4  The landlord's attestation stays — it is still the only answer for
 *       somebody who stayed here before GAM existed.
 *   D5  A stay is "completed" when a person at the desk saw them. A reservation
 *       nobody ever checked in is not a stay: it reads exactly like a no-show,
 *       which is the row somebody would plant to buy a free waiver.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { stayNeeds, priorCompletedStay } from './stayTerms'
import { returningResidentAllowance } from './onboardingWindow'

beforeEach(cleanupAllSchema)

interface World {
  userId: string; landlordId: string; propertyId: string; unitId: string; unit2Id: string
}

/** One park with two sites, so the rolling-year allowance is 1 (25% of 2, rounded up). */
async function world(): Promise<World> {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const unit2Id = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    return { userId, landlordId, propertyId, unitId, unit2Id }
  } finally { c.release() }
}

/** Another company of the SAME account: a second landlords row for one owner. */
async function siblingCompany(w: World): Promise<{ landlordId: string; propertyId: string; unitId: string }> {
  const c = await getClient()
  try {
    const { rows: [ll] } = await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [w.userId])
    const propertyId = await seedProperty(c, { landlordId: ll.id, ownerUserId: w.userId, managedByUserId: w.userId })
    return { landlordId: ll.id, propertyId, unitId: await seedUnit(c, { propertyId, landlordId: ll.id, unitType: 'rv_spot' }) }
  } finally { c.release() }
}

const email = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}@test.dev`

async function tenantFor(addr: string): Promise<string> {
  const c = await getClient()
  try { return await seedTenant(c, { email: addr }) } finally { c.release() }
}

/** A reservation row, dated in days from today. `status` defaults to a finished stay. */
async function stay(o: {
  landlordId: string; unitId: string; from: number; to: number
  email?: string | null; tenantId?: string | null; status?: string; soldTo?: number
}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, tenant_id, guest_name, guest_email, check_in, check_out, booked_check_out,
        status, lease_type, total_amount)
     VALUES ($1, $2, $3, 'Pat Ruiz', $4, CURRENT_DATE + $5::int, CURRENT_DATE + $6::int,
             CASE WHEN $7::int IS NULL THEN NULL ELSE CURRENT_DATE + $7::int END,
             $8, 'month_to_month', 900)
     RETURNING id`,
    [o.unitId, o.landlordId, o.tenantId ?? null, o.email ?? null, o.from, o.to, o.soldTo ?? null,
     o.status ?? 'checked_out'])
  return b.id
}

/**
 * 10/20 (review): the door passes the guest's NAME beside their address, and
 * these stays are all the one guest the `stay()` helper writes — so the name
 * here is theirs. An address on its own stopped being identity when a shared
 * mailbox was found waiving a stranger's check (services/stayTerms
 * samePersonName; the cases live in stayReturningIdentity.test.ts). These
 * tests are about WHICH STAYS and WHICH ACCOUNTS count, not about who somebody
 * is, so they are asked as a door asks: name and address together.
 */
const needs = (w: World, o: {
  email?: string | null; tenantId?: string | null; guestName?: string | null; from: number; to: number
  bookingId?: string | null; returning?: boolean; offerReturning?: boolean
}) => db.query<{ a: string; b: string }>(
  `SELECT (CURRENT_DATE + $1::int)::text AS a, (CURRENT_DATE + $2::int)::text AS b`, [o.from, o.to])
  .then(r => stayNeeds({
    landlordId: w.landlordId, propertyId: w.propertyId,
    bookingId: o.bookingId ?? null, tenantId: o.tenantId ?? null, email: o.email ?? null,
    guestName: o.guestName === undefined ? 'Pat Ruiz' : o.guestName,
    checkIn: r.rows[0].a, checkOut: r.rows[0].b,
    returning: o.returning, offerReturning: o.offerReturning,
  }))

// ── D1 / D2: THE DERIVATION ──────────────────────────────────────────────────

describe('a guest GAM has a completed stay for', () => {
  it('needs no background check, and nothing is written for it — nobody ticked anything', async () => {
    const w = await world()
    const e = email('known')
    const prior = await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -46, email: e })

    const booked = await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: 10, to: 35, email: e, status: 'confirmed',
    })
    const n = await needs(w, { email: e, from: 10, to: 35, bookingId: booked })
    expect(n.nights).toBe(25)
    expect(n).toMatchObject({ screening: 'returning', returningBasis: 'history', screeningFee: null })
    expect(n.returningHistory).toMatchObject({ bookingId: prior, propertyId: w.propertyId })
    // Derived, so there is no attestation to record and no allowance to spend.
    expect(n.returningAttestNow).toBe(false)
    expect(n.returningOffer).toBeNull()
    const { rows: [row] } = await db.query(
      `SELECT returning_guest_at, returning_guest_by FROM unit_bookings WHERE id = $1`, [booked])
    expect(row).toEqual({ returning_guest_at: null, returning_guest_by: null })
  })

  it('a first-timer is not returning — the check and its fee are due', async () => {
    const w = await world()
    const n = await needs(w, { email: email('new'), from: 10, to: 35 })
    expect(n.screening).toBe('fee_due')
    expect(n.returningBasis).toBeNull()
    expect(n.returningHistory).toBeNull()
    expect(n.screeningFee!.amount).toBeGreaterThan(0)
  })

  it('counts a stay at a sibling company of the same account, and never another landlord\'s', async () => {
    const w = await world()
    const e = email('roamer')
    const sib = await siblingCompany(w)
    const atSibling = await stay({ landlordId: sib.landlordId, unitId: sib.unitId, from: -90, to: -80, email: e })
    const n = await needs(w, { email: e, from: 10, to: 35 })
    expect(n).toMatchObject({ screening: 'returning', returningBasis: 'history' })
    expect(n.returningHistory).toMatchObject({ bookingId: atSibling, propertyId: sib.propertyId })

    // The same guest's history at a DIFFERENT account proves nothing here.
    const stranger = await world()
    const f = email('stranger-guest')
    await stay({ landlordId: stranger.landlordId, unitId: stranger.unitId, from: -90, to: -80, email: f })
    expect((await needs(w, { email: f, from: 10, to: 35 })).screening).toBe('fee_due')
  })

  it('joins the same person by their resident account and by the address on the booking', async () => {
    const w = await world()
    const e = email('both-ways')
    const tenantId = await tenantFor(e)

    // booked to the resident account with no address on the row; priced by address
    const byAccount = await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -50, tenantId })
    expect(await needs(w, { email: e, from: 10, to: 35 }))
      .toMatchObject({ screening: 'returning', returningHistory: { bookingId: byAccount } })

    // and the other way round: a bare address on the old row, priced by account
    await db.query(`DELETE FROM unit_bookings WHERE id = $1`, [byAccount])
    const byEmail = await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -50, email: e })
    expect(await needs(w, { tenantId, from: 10, to: 35 }))
      .toMatchObject({ screening: 'returning', returningHistory: { bookingId: byEmail } })
  })

  it('never reads an address match on a stay booked to somebody else\'s account', async () => {
    const w = await world()
    const e = email('shared-address')
    await tenantFor(e)
    const other = await tenantFor(email('other-person'))
    // Same address typed on the row, but the stay belongs to a different resident.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -50, email: e, tenantId: other })
    expect((await needs(w, { email: e, from: 10, to: 35 })).screening).toBe('fee_due')
  })
})

// ── D5: WHAT COUNTS AS A COMPLETED STAY ──────────────────────────────────────

describe('what counts as a stay they actually took', () => {
  it('a reservation nobody ever checked in is not a stay; once the desk checks them in it is', async () => {
    const w = await world()
    const e = email('noshow')
    const id = await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -46, email: e, status: 'confirmed' })
    expect((await needs(w, { email: e, from: 10, to: 35 })).screening).toBe('fee_due')

    for (const dead of ['cancelled', 'no_show', 'tentative']) {
      await db.query(`UPDATE unit_bookings SET status = $2 WHERE id = $1`, [id, dead])
      expect((await needs(w, { email: e, from: 10, to: 35 })).screening, dead).toBe('fee_due')
    }

    // The desk let them in and never closed it — nothing auto-closes a departed stay.
    await db.query(`UPDATE unit_bookings SET status = 'checked_in' WHERE id = $1`, [id])
    expect((await needs(w, { email: e, from: 10, to: 35 }))).toMatchObject({
      screening: 'returning', returningBasis: 'history',
    })
  })

  it('a continuous stay is never its own history', async () => {
    const w = await world()
    const e = email('rolling')
    // Checked out of one site and straight onto the next: one visit, not two.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -20, to: 0, email: e })
    const n = await needs(w, { email: e, from: 0, to: 25 })
    expect(n.nights).toBe(45)              // the chain adds up, as it always did
    expect(n.chain.bookingIds).toHaveLength(1)
    expect(n.screening).toBe('fee_due')
    expect(n.returningHistory).toBeNull()
  })

  it('priorCompletedStay only looks before the stay being priced', async () => {
    const w = await world()
    const e = email('future')
    const soon = await db.query<{ d: string }>(`SELECT (CURRENT_DATE + 10)::text AS d`)
    // A finished stay that ends AFTER the new stay starts is not prior to it.
    await stay({ landlordId: w.landlordId, unitId: w.unit2Id, from: 5, to: 20, email: e })
    expect(await priorCompletedStay({ landlordId: w.landlordId, email: e, before: soon.rows[0].d })).toBeNull()
  })
})

// ── D3: THE ROLLING-YEAR ALLOWANCE ───────────────────────────────────────────

describe('the rolling-year allowance', () => {
  it('a two-week winter visitor consumes no place, however many years they come back', async () => {
    const w = await world()
    const e = email('mexico-run')
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 0, allowance: 1, left: 1 })

    for (const from of [-350, -300, -250, -200, -100, -40]) {
      await stay({ landlordId: w.landlordId, unitId: w.unitId, from, to: from + 14, email: e })
      expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 0, left: 1 })
    }
    // And the next two-week visit never even asks about a check.
    const n = await needs(w, { email: e, from: 10, to: 24 })
    expect(n).toMatchObject({ nights: 14, screening: 'not_needed', returningBasis: null })
  })

  it('a month-or-longer returning stay consumes one, and the same person again is free', async () => {
    const w = await world()
    const e = email('seasonal')
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -300, to: -286, email: e })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 0, left: 1 })

    const winter = await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: 10, to: 45, email: e, status: 'confirmed',
    })
    expect(await needs(w, { email: e, from: 10, to: 45, bookingId: winter }))
      .toMatchObject({ screening: 'returning', returningBasis: 'history' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 1, allowance: 1, left: 0 })

    // The same person's second long stay this year is the same person — no new count.
    await stay({ landlordId: w.landlordId, unitId: w.unit2Id, from: 60, to: 100, email: e, status: 'confirmed' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 1, left: 0 })
  })

  it('a stay sold as a month still counts after an early departure', async () => {
    const w = await world()
    const e = email('left-early')
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -300, to: -286, email: e })
    // Sold 35 nights, gone on night 9.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: 10, to: 19, soldTo: 45, email: e, status: 'confirmed' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 1, left: 0 })
  })

  it('a derived returning guest is still not refused once the allowance is gone — only counted', async () => {
    const w = await world()
    const first = email('seasonal-a')
    const second = email('seasonal-b')
    for (const e of [first, second]) {
      await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -300, to: -286, email: e })
    }
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: 10, to: 45, email: first, status: 'confirmed' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 1, left: 0 })

    // GAM's own record says the second guest stayed here. There is nothing to
    // disbelieve, so they keep the waiver — and the count goes over, which is
    // what the admin desk watches.
    await stay({ landlordId: w.landlordId, unitId: w.unit2Id, from: 10, to: 45, email: second, status: 'confirmed' })
    expect(await needs(w, { email: second, from: 10, to: 45 }))
      .toMatchObject({ screening: 'returning', returningBasis: 'history' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 2, allowance: 1, left: 0 })
  })

  it('a stay outside the rolling year is not counted any more', async () => {
    const w = await world()
    const e = email('last-winter')
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -800, to: -786, email: e })
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -400, to: -360, email: e, status: 'checked_out' })
    expect(await returningResidentAllowance(w.propertyId)).toMatchObject({ used: 0, left: 1 })
  })
})

// ── D4: THE LANDLORD'S WORD, FOR SOMEBODY GAM HAS NEVER SEEN ─────────────────

describe('the attestation path', () => {
  it('is still offered, and still what waives the check, for a guest with no history here', async () => {
    const w = await world()
    const e = email('pre-gam')
    const asked = await needs(w, { email: e, from: 10, to: 35, offerReturning: true })
    expect(asked.screening).toBe('fee_due')
    expect(asked.returningOffer).toEqual({ available: true, free: false, message: null })

    const ticked = await needs(w, { email: e, from: 10, to: 35, returning: true, offerReturning: true })
    expect(ticked).toMatchObject({ screening: 'returning', returningBasis: 'attested', screeningFee: null })
    expect(ticked.returningAttestNow).toBe(true)   // the door records it on the stay
    expect(ticked.returningHistory).toBeNull()     // there was nothing to find
  })
})
