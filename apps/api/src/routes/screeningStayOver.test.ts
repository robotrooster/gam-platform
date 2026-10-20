/**
 * 10/19 (Nic) — A SCREENING FOR A STAY THAT IS OVER STOPS ASKING FOR A SPACE.
 *
 *   "I just want the background checks because they were approved and I had the
 *    people here for a month. I want them off of the list of doing something
 *    with them. I don't want to click not moving in for now because they did
 *    move in and then they left. So what the hell is the right situation for
 *    that?"
 *
 * The right state is not a button — a check that found its stay is already
 * filed as done (cleared_for_stay → the 'past' list). The match simply could
 * not find a stay that had finished: 'checked_out' was off the status list, and
 * a walk-up check naming no site had to be OLDER than the booking, which is the
 * opposite of how the counter works (screen first, write the stay minutes
 * later). Measured on Victor Cardoza (RV 10) and Nemesio Rivera (RV 11) at
 * Mountain View: both checked out on 10-18 after 14 nights, both approved
 * checks still demanding a space for them.
 *
 * What must NOT change: a stay that never happened ('cancelled', 'no_show')
 * clears nothing, and a stay is only ever matched to the person who stayed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'

const SECRET = 'test_jwt_secret_screening_stay_over'
/**
 * The real API wraps every response in camelCaseKeys on the way out (see
 * apps/api/src/index.ts), so what the screening page actually receives is
 * `stayBookingId`, `clearedForStay`, `landlordId`. A suite that mounts the
 * router bare asserts the database's own spelling instead and would go green on
 * a field no page can ever read — rename a column here and both ends stay
 * green while the company filter quietly matches nothing. So the transform is
 * mounted here too, and every expectation below is the name the page reads.
 */
const app = () => {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body: any) => json(camelCaseKeys(body))
    next()
  })
  a.use('/api/background', backgroundRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = SECRET
})

interface World {
  landlordId: string; landlordUserId: string; propertyId: string
  rv10: string; rv11: string
  guestUserId: string; guestTenantId: string; guestEmail: string
  token: string
}

async function world(): Promise<World> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    const rv10 = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const rv11 = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const guestEmail = `walkup-${randomUUID().slice(0, 8)}@test.dev`
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Victor','Cardoza',TRUE) RETURNING id`, [guestEmail])
    const t = await c.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    await c.query('COMMIT')
    return {
      landlordId, landlordUserId, propertyId, rv10, rv11,
      guestUserId: u.rows[0].id, guestTenantId: t.rows[0].id, guestEmail,
      token: jwt.sign(
        { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', landlordIds: [landlordId], permissions: {} },
        SECRET, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * The walk-up's approved screening: no site picked (that is what screening at
 * the counter means), the park it was taken at, ordered 16 days ago.
 */
async function approvedWalkUpCheck(w: World, o: { unitId?: string | null; propertyId?: string | null; daysAgo?: number } = {}) {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO background_checks
       (landlord_id, user_id, tenant_id, unit_id, property_id, status, first_name, last_name, decided_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', 'Victor', 'Cardoza', NOW(), NOW() - ($6 || ' days')::interval)
     RETURNING id`,
    [w.landlordId, w.guestUserId, w.guestTenantId,
     o.unitId === undefined ? null : o.unitId,
     o.propertyId === undefined ? w.propertyId : o.propertyId,
     String(o.daysAgo ?? 16)])
  return r.id
}

/**
 * A stay on a site that needed screening. Written AFTER the check, as the
 * counter writes it. `checkInDays` / `checkOutDays` are day offsets from today
 * (negative = in the past) — interpolated, since CURRENT_DATE arithmetic is SQL
 * and not something a bind parameter can carry.
 */
async function stay(w: World, o: {
  unitId?: string; status?: string; checkInDays?: number; checkOutDays?: number
  email?: string | null; tenantId?: string | null; createdDaysAgo?: number; screeningRequired?: boolean
  landlordId?: string
} = {}) {
  const day = (n: number) => `CURRENT_DATE + ${Number(n)}`
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, tenant_id, guest_name, guest_email, check_in, check_out, status,
        lease_type, total_amount, stay_terms, screening_required, created_at)
     VALUES ($1, $2, $3, 'Victor Cardoza', $4, ${day(o.checkInDays ?? -14)}, ${day(o.checkOutDays ?? -1)}, $5,
             'month_to_month', 900, 'stay', $6, NOW() - ($7 || ' days')::interval)
     RETURNING id`,
    [o.unitId ?? w.rv10, o.landlordId ?? w.landlordId, o.tenantId ?? null,
     o.email === undefined ? w.guestEmail : o.email,
     o.status ?? 'checked_out', o.screeningRequired ?? true, String(o.createdDaysAgo ?? 14)])
  return b.id
}

/**
 * The lease action the screening page offers an approved applicant. A check
 * whose stay was found refuses it on purpose (the stay has its own lease flow);
 * a check that is still waiting on a space must keep it, so every case below
 * that must NOT match a stay checks the button too — the list row and the
 * button read the same match, and a silent 409 here is the whole failure.
 */
const draftLease = (w: World, checkId: string, unitId?: string) =>
  request(app()).post(`/api/background/${checkId}/draft-lease`)
    .set('Authorization', `Bearer ${w.token}`).send(unitId ? { unitId } : {})
const leaseButtonStillWorks = async (w: World, checkId: string) => {
  const res = await draftLease(w, checkId, w.rv10)
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).not.toBe(409)
}

/** Another company of the SAME account: a second landlords row for one owner. */
async function siblingCompany(w: World): Promise<{ landlordId: string; unitId: string }> {
  const c = await getClient()
  try {
    const { rows: [ll] } = await c.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`,
      [w.landlordUserId])
    const propertyId = await seedProperty(c, { landlordId: ll.id, ownerUserId: w.landlordUserId, managedByUserId: w.landlordUserId })
    return { landlordId: ll.id, unitId: await seedUnit(c, { propertyId, landlordId: ll.id }) }
  } finally { c.release() }
}

const listRow = async (w: World, checkId: string) => {
  const res = await request(app()).get('/api/background').set('Authorization', `Bearer ${w.token}`)
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
  return res.body.data.find((r: any) => r.id === checkId)
}

describe('a screening whose stay has ended', () => {
  it('recognizes the finished stay and files itself as past — nothing to click', async () => {
    const w = await world()
    const checkId = await approvedWalkUpCheck(w)
    const bookingId = await stay(w)                       // checked out yesterday, written 2 days after the check
    expect(await listRow(w, checkId)).toMatchObject({
      stayBookingId: bookingId, clearedForStay: true, stayOver: true, bucket: 'past',
    })
  })

  it('matches by tenant_id as well as by email', async () => {
    const w = await world()
    const checkId = await approvedWalkUpCheck(w)
    const bookingId = await stay(w, { email: null, tenantId: w.guestTenantId })
    expect(await listRow(w, checkId)).toMatchObject({ stayBookingId: bookingId, bucket: 'past' })
  })

  it('finds a stay written AFTER the screening — the counter screens first and books minutes later', async () => {
    const w = await world()
    // A live stay this time, so this proves the created_at ordering alone, with
    // no help from the status list: ordered 1 day ago, booked today.
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 1 })
    const bookingId = await stay(w, {
      status: 'confirmed', checkInDays: 0, checkOutDays: 30, createdDaysAgo: 0,
    })
    expect(await listRow(w, checkId)).toMatchObject({
      stayBookingId: bookingId, clearedForStay: true, stayOver: false, bucket: 'past',
    })
  })
})

describe('what still must not clear a screening', () => {
  it('a stay that never happened — canceled or a no-show — leaves the check needing a space', async () => {
    for (const status of ['cancelled', 'no_show']) {
      const w = await world()
      const checkId = await approvedWalkUpCheck(w)
      await stay(w, { status })
      const row = await listRow(w, checkId)
      expect(row.stayBookingId, status).toBeNull()
      expect(row.clearedForStay, status).toBe(false)
      expect(row.bucket, status).toBe('attention')
    }
  })

  it("somebody else's stay is never this applicant's", async () => {
    const w = await world()
    const checkId = await approvedWalkUpCheck(w)
    await stay(w, { email: `someone-else-${randomUUID().slice(0, 8)}@test.dev`, unitId: w.rv11 })
    const row = await listRow(w, checkId)
    expect(row.stayBookingId).toBeNull()
    expect(row.bucket).toBe('attention')
  })

  it('a stay at another park is not the stay of a check that names this one', async () => {
    const w = await world()
    const c = await getClient()
    let elsewhere: string
    try {
      const other = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.landlordUserId, managedByUserId: w.landlordUserId })
      elsewhere = await seedUnit(c, { propertyId: other, landlordId: w.landlordId })
    } finally { c.release() }
    const checkId = await approvedWalkUpCheck(w)
    await stay(w, { unitId: elsewhere! })
    expect((await listRow(w, checkId)).bucket).toBe('attention')
  })

  it('an old stay that was already over when they screened again does not clear the new check', async () => {
    const w = await world()
    // They stayed two years ago; they are back now wanting a lease, so the new
    // screening still needs a space picked and a lease drafted.
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
    await stay(w, { checkInDays: -745, checkOutDays: -730, createdDaysAgo: 746 })
    const row = await listRow(w, checkId)
    expect(row.stayBookingId).toBeNull()
    expect(row.bucket).toBe('attention')
  })

  it('a stay that needed no screening clears nothing', async () => {
    const w = await world()
    const checkId = await approvedWalkUpCheck(w)
    await stay(w, { screeningRequired: false })
    expect((await listRow(w, checkId)).bucket).toBe('attention')
  })

  it('a LIVE stay at another park is not the stay of a check that names this one', async () => {
    const w = await world()
    const c = await getClient()
    let elsewhere: string
    try {
      const other = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.landlordUserId, managedByUserId: w.landlordUserId })
      elsewhere = await seedUnit(c, { propertyId: other, landlordId: w.landlordId })
    } finally { c.release() }
    // Running right now and confirmed, so nothing but the park can exclude it.
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
    await stay(w, { unitId: elsewhere!, status: 'checked_in', checkInDays: 0, checkOutDays: 30, createdDaysAgo: 0 })
    expect((await listRow(w, checkId)).stayBookingId).toBeNull()
    await leaseButtonStillWorks(w, checkId)
  })

  it('a check that names neither a space nor a park is cleared by no stay at all', async () => {
    // The counter can key a screening with no scan, no invite and no prior
    // application behind it — then nothing on the check says where it was
    // taken. "Any stay of this person" would be every stay on the account.
    const w = await world()
    const checkId = await approvedWalkUpCheck(w, { propertyId: null, daysAgo: 0 })
    await stay(w, { status: 'checked_in', checkInDays: 0, checkOutDays: 30, createdDaysAgo: 0 })
    const row = await listRow(w, checkId)
    expect(row.stayBookingId).toBeNull()
    expect(row.bucket).toBe('attention')
    await leaseButtonStillWorks(w, checkId)
  })

  it("a check with no park is not cleared by their stay at another company of the account", async () => {
    // The account owns Mountain View and Oak Park. A screening with no park on
    // it must not be filed as done by a stay at the OTHER company.
    const w = await world()
    const other = await siblingCompany(w)
    const checkId = await approvedWalkUpCheck(w, { propertyId: null, daysAgo: 0 })
    await stay(w, {
      landlordId: other.landlordId, unitId: other.unitId,
      status: 'checked_in', checkInDays: -5, checkOutDays: 25, createdDaysAgo: 0,
    })
    expect((await listRow(w, checkId)).stayBookingId).toBeNull()
    await leaseButtonStillWorks(w, checkId)
  })
})

/**
 * 10/19 — THE EDGES OF THE TWO DATE TESTS.
 *
 * Both of them are a single day wide at the boundary, and each one is the only
 * thing standing between a screening and the wrong stay, so each is measured ON
 * the boundary rather than a year away from it.
 */
describe('the day they screened against the days of the stay', () => {
  it('the day they check OUT is no longer a day that stay can be screened for', async () => {
    // They leave this morning and screen this afternoon, which is somebody
    // starting something new — a lease, usually. check_out is the departure
    // day, not a night, so that stay is behind them.
    const w = await world()
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
    await stay(w, { status: 'checked_out', checkInDays: -14, checkOutDays: 0, createdDaysAgo: 14 })
    const row = await listRow(w, checkId)
    expect(row.stayBookingId).toBeNull()
    expect(row.clearedForStay).toBe(false)
    expect(row.bucket).toBe('attention')
    await leaseButtonStillWorks(w, checkId)
  })

  it('a stay with one night left when they screened is still theirs', async () => {
    const w = await world()
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
    const bookingId = await stay(w, { status: 'checked_in', checkInDays: -14, checkOutDays: 1, createdDaysAgo: 14 })
    expect(await listRow(w, checkId)).toMatchObject({
      stayBookingId: bookingId, clearedForStay: true, stayOver: false, bucket: 'past',
    })
  })

  it('a stay beginning a week out is what they screened for; later is not', async () => {
    for (const [checkInDays, matches] of [[7, true], [8, false]] as const) {
      const w = await world()
      const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
      const bookingId = await stay(w, {
        status: 'confirmed', checkInDays, checkOutDays: checkInDays + 30, createdDaysAgo: 0,
      })
      const row = await listRow(w, checkId)
      expect(row.stayBookingId, `check_in +${checkInDays}`).toBe(matches ? bookingId : null)
      expect(row.bucket, `check_in +${checkInDays}`).toBe(matches ? 'past' : 'attention')
    }
  })

  it('a month on a site does not swallow a screening taken to get a lease', async () => {
    // Anastacio Erreguin: approved 09-04 at Mountain View, no space yet, still
    // on the attention list. Put him on a site for a month while the lease
    // paperwork runs and his screening must not file itself as done — that is
    // the one lease button he has.
    const w = await world()
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 45 })
    await stay(w, { status: 'confirmed', checkInDays: 1, checkOutDays: 31, createdDaysAgo: 0 })
    const row = await listRow(w, checkId)
    expect(row.stayBookingId).toBeNull()
    expect(row.bucket).toBe('attention')
    await leaseButtonStillWorks(w, checkId)
  })

  it('a stay booked months ahead is matched by its receipt, not by the dates', async () => {
    // Which is why the window above can be short: a stay booked that far out
    // carried the screening fee on the sale, and the check it paid for points
    // straight at the booking.
    const w = await world()
    const checkId = await approvedWalkUpCheck(w, { daysAgo: 0 })
    const bookingId = await stay(w, { status: 'confirmed', checkInDays: 60, checkOutDays: 90, createdDaysAgo: 0 })
    await db.query(
      `INSERT INTO screening_prepayments
         (landlord_id, property_id, booking_id, email, amount, source, status, used_by_check_id, used_at)
       VALUES ($1, $2, $3, $4, 42.94, 'booking_site', 'used', $5, NOW())`,
      [w.landlordId, w.propertyId, bookingId, w.guestEmail, checkId])
    expect(await listRow(w, checkId)).toMatchObject({ stayBookingId: bookingId, bucket: 'past' })
  })
})

/**
 * 10/19 (Nic): "I can't choose my property on the background check page. I
 * can't go to the Oak Park ones, I guess." The page can only narrow by company
 * and park if the list says which company and which park each screening is on.
 */
describe('what the list carries for the company and property filters', () => {
  it('names the company and the park on every row', async () => {
    const w = await world()
    const walkUp = await approvedWalkUpCheck(w)                      // park from the scan, no site
    const onASite = await approvedWalkUpCheck(w, { unitId: w.rv10, propertyId: null })
    const res = await request(app()).get('/api/background').set('Authorization', `Bearer ${w.token}`)
    const by = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]))
    expect(by[walkUp]).toMatchObject({ landlordId: w.landlordId, propertyId: w.propertyId })
    // A check that named a site resolves its park through the site.
    expect(by[onASite]).toMatchObject({ landlordId: w.landlordId, propertyId: w.propertyId })
    expect(by[onASite].propertyName).toBeTruthy()
  })

  it("never carries another account's screening, whatever the page asks for", async () => {
    const w = await world()
    const mine = await approvedWalkUpCheck(w)
    const c = await getClient()
    let theirs: string
    try {
      const other = await seedLandlord(c)
      const otherProperty = await seedProperty(c, { landlordId: other.landlordId, ownerUserId: other.userId, managedByUserId: other.userId })
      const r = await c.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, property_id, status, first_name, last_name)
         VALUES ($1,$2,$3,'approved','Someone','Else') RETURNING id`,
        [other.landlordId, w.guestUserId, otherProperty])
      theirs = r.rows[0].id
    } finally { c.release() }
    const res = await request(app()).get('/api/background')
      // the filters are the page narrowing its own rows; the route takes no
      // company or property from the caller, so asking for one changes nothing
      .query({ landlordId: 'any', propertyId: 'any' })
      .set('Authorization', `Bearer ${w.token}`)
    expect(res.body.data.map((r: any) => r.id)).toEqual([mine])
    expect(res.body.data.find((r: any) => r.id === theirs!)).toBeUndefined()
  })
})
