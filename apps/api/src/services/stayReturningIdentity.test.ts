/**
 * 10/20 (adversarial pass) — WHO THE DERIVED WAIVER BELONGS TO, AND WHERE IT
 * HAS TO REACH.
 *
 * The derived returning guest (stayReturningHistory.test.ts) waives a $34.99
 * check plus GAM's margin and lets somebody onto a site for months without one.
 * Three holes were found in it, and all three are about the same thing: the
 * rule in the comment was not the rule in the code.
 *
 *   I1  A stay the guest is PHYSICALLY SITTING ON read as prior history. The
 *       file's own documentation says "'checked_in', dates passed"; the SQL
 *       only ever asked whether the stay ended before the new one began, which
 *       a stay running right now does when the new stay is months out. A guest
 *       who has never finished a stay anywhere came out 'returning'.
 *
 *   I2  A bare email match waived a stranger's check. Dale and Donna Carter
 *       share one mailbox, as couples do; Dale's ten nights last winter made
 *       Donna's forty-five read as returning. No fee, no check, and the gate
 *       does not stop a 'returning' guest either.
 *
 *   I3  The waiver did not reach the gate. GAM itself decided no check was
 *       needed, then the booking site marked the stay as waiting on one and
 *       check-in refused it 409 "No background check is on file for them yet."
 *       Nic's winter visitor stood at the gate, paid, with no button on the
 *       screen that could let them in.
 *
 * Run (the six written-not-applied migrations included):
 *   TEST_DB_NAME=gam_fix7_test DB_NAME=gam_fix7_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run services/stayReturningIdentity.test
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

// The booking site builds its own Stripe checkout so the background check can
// ride as its own line (services/propertyBooking createSiteCheckoutSession).
// Mocked: this file is about whether that line is there at all.
const { sessionsCreate } = vi.hoisted(() => {
  let n = 0
  return {
    sessionsCreate: vi.fn(async (_p: any) => ({ id: `cs_test_${++n}`, url: 'https://checkout.stripe.test/session' })),
  }
})
vi.mock('../lib/stripe', async (orig) => {
  const actual = await (orig() as any)
  return { ...actual, getStripe: () => ({ checkout: { sessions: { create: sessionsCreate } } }) }
})
vi.mock('./email', async (orig) => {
  const actual = await (orig() as any)
  return {
    ...actual,
    sendNotificationEmail: vi.fn(async () => 'msg_test'),
    emailGuestStayLink: vi.fn(async () => 'msg_test'),
    emailBackgroundCheckScreeningRequest: vi.fn(async () => 'msg_test'),
    emailUtilityServiceInvite: vi.fn(async () => 'msg_test'),
  }
})

import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { stayNeeds, priorCompletedStay, checkInBlock, samePersonName } from './stayTerms'
import { bookStay } from './propertyBooking'

beforeEach(async () => { await cleanupAllSchema(); sessionsCreate.mockClear() })

interface World {
  userId: string; landlordId: string; propertyId: string; unitId: string; unit2Id: string
}

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

const email = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}@test.dev`

/** A reservation row, dated in days from today. `status` defaults to a finished stay. */
async function stay(o: {
  landlordId: string; unitId: string; from: number; to: number
  email?: string | null; tenantId?: string | null; status?: string; name?: string
  screeningRequired?: boolean
}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, tenant_id, guest_name, guest_email, check_in, check_out, booked_check_out,
        status, lease_type, total_amount, screening_required)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + $6::int, CURRENT_DATE + $7::int, CURRENT_DATE + $7::int,
             $8, 'month_to_month', 900, $9)
     RETURNING id`,
    [o.unitId, o.landlordId, o.tenantId ?? null, o.name ?? 'Pat Ruiz', o.email ?? null, o.from, o.to,
     o.status ?? 'checked_out', o.screeningRequired === true])
  return b.id
}

const days = (from: number, to: number) => db.query<{ a: string; b: string }>(
  `SELECT (CURRENT_DATE + $1::int)::text AS a, (CURRENT_DATE + $2::int)::text AS b`, [from, to])
  .then(r => ({ checkIn: r.rows[0].a, checkOut: r.rows[0].b }))

const needs = (w: World, o: {
  email?: string | null; tenantId?: string | null; guestName?: string | null
  from: number; to: number; bookingId?: string | null
}) => days(o.from, o.to).then(d => stayNeeds({
  landlordId: w.landlordId, propertyId: w.propertyId,
  bookingId: o.bookingId ?? null, tenantId: o.tenantId ?? null, email: o.email ?? null,
  guestName: o.guestName ?? null, ...d,
}))

// ── I1: A STAY THEY ARE STILL ON IS NOT A STAY THEY TOOK ─────────────────────

describe('a stay that has not ended yet', () => {
  it('is not prior history — Dale is sitting on his first ever site and still owes a check', async () => {
    const w = await world()
    const e = email('dale')
    // His FIRST ever stay, and he is on it right now: the desk let him in on
    // the 10th and nobody has closed anything.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -10, to: 41, email: e, status: 'checked_in' })

    // He books the winter, starting after that stay's last night.
    const winter = await stay({
      landlordId: w.landlordId, unitId: w.unit2Id, from: 56, to: 118, email: e, status: 'confirmed',
      name: 'Dale Carter',
    })
    const n = await needs(w, { email: e, guestName: 'Dale Carter', from: 56, to: 118, bookingId: winter })
    expect(n.nights).toBe(62)
    expect(n.screening).toBe('fee_due')
    expect(n.returningBasis).toBeNull()
    expect(n.returningHistory).toBeNull()
    expect(n.screeningFee!.amount).toBeGreaterThan(0)
  })

  it('counts once it is over — the desk let them in and never closed it', async () => {
    const w = await world()
    const e = email('never-closed')
    const past = await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -46, email: e, status: 'checked_in',
      name: 'Dale Carter',
    })
    expect(await needs(w, { email: e, guestName: 'Dale Carter', from: 56, to: 118 }))
      .toMatchObject({ screening: 'returning', returningBasis: 'history', returningHistory: { bookingId: past } })
  })

  it('a stay closed with its last night still ahead is not history either', async () => {
    const w = await world()
    const e = email('closed-early-future')
    // A check-out stamped on a stay that has not happened yet: still not proof
    // anybody was ever here.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: 5, to: 20, email: e, status: 'checked_out',
                 name: 'Dale Carter' })
    const d = await days(56, 118)
    expect(await priorCompletedStay({
      landlordId: w.landlordId, email: e, name: 'Dale Carter', before: d.checkIn,
    })).toBeNull()
  })
})

// ── I2: A MAILBOX IS HOW YOU REACH A PERSON, NOT HOW YOU ARE ONE ─────────────

describe('a shared inbox', () => {
  it('does not waive Donna\'s check off Dale\'s stay', async () => {
    const w = await world()
    const shared = email('carters')
    await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: -300, to: -290, email: shared, name: 'Dale Carter',
    })

    // Donna books a month and a half at the front desk, in her own name, on
    // the address the park has written down for the two of them.
    const n = await needs(w, { email: shared, guestName: 'Donna Carter', from: 10, to: 55 })
    expect(n.nights).toBe(45)
    expect(n.screening).toBe('fee_due')
    expect(n.returningHistory).toBeNull()

    // Dale himself still walks straight through.
    expect(await needs(w, { email: shared, guestName: 'Dale Carter', from: 10, to: 55 }))
      .toMatchObject({ screening: 'returning', returningBasis: 'history' })
  })

  it('does not waive it off the ACCOUNT holder\'s own address either', async () => {
    const w = await world()
    const shared = email('carters-account')
    const c = await getClient()
    // Donna holds the GAM login on the mailbox (one address, one account); Dale
    // is the one with the stay.
    let donna: string
    try {
      donna = await seedTenant(c, { email: shared })
      await c.query(`UPDATE users SET first_name = 'Donna', last_name = 'Carter' WHERE email = $1`, [shared])
    } finally { c.release() }
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -300, to: -290, email: shared, name: 'Dale Carter' })

    expect((await needs(w, { tenantId: donna, from: 10, to: 55 })).screening).toBe('fee_due')
  })

  it('still joins one person written two ways', () => {
    expect(samePersonName('Dale Carter', 'dale  carter')).toBe(true)
    expect(samePersonName('Carter, Dale', 'Dale Carter')).toBe(true)
    expect(samePersonName('Dale A. Carter', 'Dale Carter')).toBe(true)
    expect(samePersonName('Dale Carter Jr', 'Dale Carter')).toBe(true)
    expect(samePersonName('Dale Carter', 'Donna Carter')).toBe(false)
    expect(samePersonName('D Carter', 'Dale Carter')).toBe(false)
    expect(samePersonName('Dale', 'Dale Carter')).toBe(false)
    expect(samePersonName('Dale Carter', null)).toBe(false)
    expect(samePersonName('   ', 'Dale Carter')).toBe(false)
  })

  it('a resident account is the same person whatever name is typed on the stay', async () => {
    const w = await world()
    const e = email('account-holder')
    const c = await getClient()
    let tenantId: string
    try { tenantId = await seedTenant(c, { email: e }) } finally { c.release() }
    // Booked to their account; the desk typed a nickname on the row.
    const prior = await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: -60, to: -50, tenantId, name: 'Bud',
    })
    expect(await needs(w, { tenantId, from: 10, to: 55 }))
      .toMatchObject({ screening: 'returning', returningHistory: { bookingId: prior } })
  })
})

// ── I3: THE WAIVER HAS TO REACH THE GATE ─────────────────────────────────────

describe('a derived returning guest at the gate', () => {
  async function bookingSite(): Promise<World> {
    const w = await world()
    const c = await getClient()
    try {
      await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_test' WHERE id = $1`, [w.userId])
      await c.query(
        `UPDATE properties SET public_booking_enabled = TRUE, booking_slug = $2, booking_deposit_pct = 20 WHERE id = $1`,
        [w.propertyId, `park-${randomUUID().slice(0, 6)}`])
      for (const id of [w.unitId, w.unit2Id]) {
        await c.query(
          `UPDATE units SET is_bookable = TRUE, lease_types_allowed = ARRAY['nightly','weekly','month_to_month'],
                  nightly_rate = 45, weekly_rate = 260, monthly_rate = 650 WHERE id = $1`, [id])
      }
    } finally { c.release() }
    return w
  }

  it('is never marked as waiting on a check, and check-in lets them in', async () => {
    const w = await bookingSite()
    const e = email('winter-visitor')
    // Fourteen nights last January, closed by the desk.
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -280, to: -266, email: e, name: 'Sam Field' })

    const { booking_slug: slug } = (await db.query<{ booking_slug: string }>(
      `SELECT booking_slug FROM properties WHERE id = $1`, [w.propertyId])).rows[0]
    const d = await days(42, 133)                       // Dec 1 → Mar 1, 91 nights
    const booked = await bookStay({
      slug, unitId: w.unit2Id, guestName: 'Sam Field', guestEmail: e,
      checkIn: d.checkIn, checkOut: d.checkOut, stayTerms: 'stay',
    })

    // GAM decided no check was needed, so nothing was charged for one...
    expect(booked.screeningFee).toBe(0)
    // ...and the stay is not marked as one whose check-in waits on a check.
    const row = (await db.query<{ screening_required: boolean }>(
      `SELECT screening_required FROM unit_bookings WHERE id = $1`, [booked.bookingId])).rows[0]
    expect(row.screening_required).toBe(false)

    // They paid, December came, and the desk pressed Check in.
    await db.query(`UPDATE unit_bookings SET status = 'confirmed', deposit_paid_at = NOW() WHERE id = $1`,
      [booked.bookingId])
    expect(await checkInBlock(booked.bookingId)).toBeNull()
  })

  it('is let in even on a stay already marked as waiting — the flag cannot answer it', async () => {
    const w = await world()
    const e = email('already-marked')
    await stay({ landlordId: w.landlordId, unitId: w.unitId, from: -280, to: -266, email: e, name: 'Sam Field' })
    // Every stay sold before this was fixed carries the mark, and there is no
    // attestation on the row to clear it.
    const arriving = await stay({
      landlordId: w.landlordId, unitId: w.unit2Id, from: 0, to: 91, email: e, name: 'Sam Field',
      status: 'confirmed', screeningRequired: true,
    })
    expect(await checkInBlock(arriving)).toBeNull()
  })

  it('still stops a first-timer at the gate', async () => {
    const w = await world()
    const arriving = await stay({
      landlordId: w.landlordId, unitId: w.unitId, from: 0, to: 91, email: email('stranger'), name: 'Nobody Known',
      status: 'confirmed', screeningRequired: true,
    })
    expect(await checkInBlock(arriving)).toMatchObject({ code: 'screening_pending', waitingOn: 'no_check' })
  })
})
