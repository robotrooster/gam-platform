/**
 * 10/20 (Nic, his own catch) — MOVING A GUEST OFF THE SPACE THEY WERE PROMISED.
 *
 *   "The import does not send the emails because... when we have to think about
 *    this from people migrating where they may have already paid a deposit.
 *    They may have already gotten a confirmation on a space number. Our system
 *    with compression and expansion is going to kind of screw that up if they
 *    think they're locked to a specific site already."
 *
 * Dale Carter comes in from the old system promised RV 14, so his reservation
 * carries locked_to_unit with lock_reason 'promised_before_gam'. Every move GAM
 * makes itself honors that — compression, the extension relocations,
 * out-of-order repacking, an unpaid hold moved aside for a payer all refuse to
 * touch him.
 *
 * A PERSON is not one of those paths, and a landlord has real reasons the board
 * cannot know: the guest agreed to a different space on the phone, the site
 * flooded, the rig turned out too long. So the hand move is allowed. What is
 * tested here is everything it must not be:
 *
 *   - not SILENT. The first send is refused, in words that name the space the
 *     guest already has and say what GAM will do about it.
 *   - not a thing only the screen enforces. A stale page and a hand-made call
 *     get the same refusal, because the screen is not the guard.
 *   - not a LIE afterwards. The stay stays pinned, but it stops claiming the
 *     new space was promised — nobody promised it.
 *   - not something the guest finds out from a rig on their site. GAM tells
 *     them, with the email that exists for exactly this.
 *
 * Run (the six unapplied migrations are reached the usual way):
 *
 *   DB_NAME=<yours>_test TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *     npx vitest run routes/promisedSiteMove.test
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// The one email that exists for this news (S652), mocked so the suite can
// assert WHO was told WHAT without a single message leaving the process.
const h = vi.hoisted(() => ({ siteChanged: vi.fn(async () => {}) }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any), emailBookingSiteChanged: h.siteChanged,
}))

let unitsRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  h.siteChanged.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_promised_site'
  ;({ unitsRouter } = await import('./units'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

/** One park, sites numbered the way Nic numbers them. */
async function seed(numbers = ['RV 14', 'RV 09', 'RV 22']) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = 'Mountain View RV Park' WHERE id = $1`, [propertyId])
    const unitIds: string[] = []
    for (const n of numbers) {
      const u = await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, is_bookable, rv_site_layout, rv_amp_service, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,TRUE,'pull_through','50',ARRAY['nightly','weekly'])
         RETURNING id`, [propertyId, landlordId, n])
      unitIds.push(u.rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitIds, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A reservation that already existed somewhere GAM was not. lock_reason is
 * written straight in, the way services/reservationImport writes it on the way
 * through the file door.
 */
async function broughtIn(f: any, unitId: string, opts: { lockReason?: string | null; email?: string | null } = {}) {
  const rows = await query<any>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights,
        total_amount, status, locked_to_unit, lock_reason, migrated_at, migrated_door, told_outside_gam)
     VALUES ($1,$2,'Dale Carter',$3,'weekly','2027-03-06','2027-03-13',7,280,
             'confirmed', TRUE, $4, NOW(), 'file', TRUE)
     RETURNING id`,
    [unitId, f.landlordId, opts.email === undefined ? 'dale@t.dev' : opts.email,
     opts.lockReason === undefined ? 'promised_before_gam' : opts.lockReason])
  return rows[0].id
}

/** An ordinary reservation taken in GAM, movable like any other. */
async function takenHere(f: any, unitId: string) {
  const rows = await query<any>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights,
        total_amount, status)
     VALUES ($1,$2,'Marie Boudreaux','marie@t.dev','weekly','2027-03-06','2027-03-13',7,280,'confirmed')
     RETURNING id`, [unitId, f.landlordId])
  return rows[0].id
}

const patch = (f: any, unitId: string, bookingId: string, body: any) =>
  request(buildApp()).patch(`/api/units/${unitId}/bookings/${bookingId}`)
    .set('Authorization', `Bearer ${f.token}`).send(body)

const stay = async (id: string) => (await query<any>(
  `SELECT unit_id, locked_to_unit, lock_reason FROM unit_bookings WHERE id = $1`, [id]))[0]

const movedEvents = async (id: string) => await query<any>(
  `SELECT summary, detail FROM unit_booking_events
     WHERE booking_id = $1 AND event_type = 'moved' ORDER BY created_at`, [id])

describe('a stay promised its space is not moved quietly', () => {
  it('refuses the first send, names the space the guest already has, and changes nothing', async () => {
    const f = await seed()
    const id = await broughtIn(f, f.unitIds[0])          // promised RV 14

    const res = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1] })

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('locked_site')
    // The whole point of the sentence: which number is in the guest's hand,
    // where they are going, and what GAM will do about it.
    expect(res.body.error).toContain('Dale Carter was promised this space before GAM, in the old system')
    expect(res.body.error).toContain('RV 14 is the number they have')
    expect(res.body.error).toContain('Moving them to RV 09 means RV 14 is no longer theirs')
    expect(res.body.error).toContain('We will email them that their site is now RV 09')
    expect(res.body).toMatchObject({ fromUnitNumber: 'RV 14', unitNumber: 'RV 09', willEmailGuest: true })

    // Nothing moved, nothing was written, and nobody was emailed.
    expect(await stay(id)).toEqual({ unit_id: f.unitIds[0], locked_to_unit: true, lock_reason: 'promised_before_gam' })
    expect(h.siteChanged).not.toHaveBeenCalled()
  })

  it('moves on the confirmed send, stops calling the new space promised, and tells the guest', async () => {
    const f = await seed()
    const id = await broughtIn(f, f.unitIds[0])

    const res = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1], overrideLocked: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // Still pinned — the desk just chose this site by hand, so automatic
    // scheduling has even less business shuffling them off it. But the reason
    // no longer claims anybody promised RV 09.
    expect(await stay(id)).toEqual({
      unit_id: f.unitIds[1], locked_to_unit: true, lock_reason: 'moved_off_promised_site',
    })

    // The guest hears it from us, with the email that exists for this.
    expect(h.siteChanged).toHaveBeenCalledTimes(1)
    const [to, who, park, from, onto] = h.siteChanged.mock.calls[0] as any[]
    expect({ to, who, park, from, onto }).toEqual({
      to: 'dale@t.dev', who: 'Dale Carter', park: 'Mountain View RV Park', from: 'RV 14', onto: 'RV 09',
    })

    // And the save says what it did, so the desk is not guessing.
    expect(res.body.data.siteMoved).toContain('Dale Carter moved from RV 14 to RV 09')
    expect(res.body.data.siteMoved).toContain('We emailed dale@t.dev their new site')
    expect(res.body.data.siteMoved).toContain('RV 09 is not a space anybody promised them')

    // One history row, not two, and it names both spaces and the promise —
    // "moved to another unit" with two ids is no use to whoever is asked three
    // weeks later why Dale is not on 14.
    const events = await movedEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toContain('Dale Carter moved by hand from RV 14 to RV 09')
    expect(events[0].summary).toContain('RV 14 is the space they were promised')
    expect(events[0].detail).toMatchObject({
      from_unit_number: 'RV 14', to_unit_number: 'RV 09', moved_by_hand: true,
      lock_reason_before: 'promised_before_gam', lock_reason_after: 'moved_off_promised_site',
    })
  })

  // The reason the refusal exists is the guest's expectation, so GAM says
  // plainly when it cannot reach them rather than moving them and hoping.
  it('says a phone call is owed when there is no address to email', async () => {
    const f = await seed()
    const id = await broughtIn(f, f.unitIds[0], { email: null })

    const refused = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1] })
    expect(refused.status).toBe(409)
    expect(refused.body.willEmailGuest).toBe(false)
    expect(refused.body.error).toContain('somebody has to call them')

    const ok = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1], overrideLocked: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(h.siteChanged).not.toHaveBeenCalled()
    expect(ok.body.data.siteMoved).toContain('there is no address on this reservation')
    expect(ok.body.data.siteMoved).toContain('Dale Carter still has RV 14 — ring them')
  })

  // S547's snowbird lock: the landlord pinned them, nobody quoted a number.
  // The move still asks — the guest very likely expects their usual space —
  // but "pinned here by hand" stays true of wherever the desk puts them, so
  // nothing is rewritten and nothing is erased.
  it('asks about a stay pinned by hand, and leaves its reason alone', async () => {
    const f = await seed()
    const id = await broughtIn(f, f.unitIds[0], { lockReason: null })

    const refused = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1] })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('Dale Carter is pinned to this space by hand')

    const ok = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1], overrideLocked: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await stay(id)).toEqual({ unit_id: f.unitIds[1], locked_to_unit: true, lock_reason: null })
    expect(ok.body.data.siteMoved).toContain('The stay is still pinned to its site, now RV 09')
  })

  // The lock is about the SPACE, not the dates. A snowbird adding a week is
  // the most ordinary thing on the board and must not stop to ask.
  it('asks nothing when only the dates change on the space it is pinned to', async () => {
    const f = await seed()
    const id = await broughtIn(f, f.unitIds[0])

    const res = await patch(f, f.unitIds[0], id, { checkIn: '2027-03-06', checkOut: '2027-03-20' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await stay(id)).toEqual({ unit_id: f.unitIds[0], locked_to_unit: true, lock_reason: 'promised_before_gam' })
    expect(h.siteChanged).not.toHaveBeenCalled()
    expect(res.body.data.siteMoved).toBeUndefined()
  })

  // And an ordinary reservation is still dragged around the board freely.
  it('leaves an unpinned reservation to move with no question and no email', async () => {
    const f = await seed()
    const id = await takenHere(f, f.unitIds[0])

    const res = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await stay(id)).unit_id).toBe(f.unitIds[1])
    expect(h.siteChanged).not.toHaveBeenCalled()
    expect(res.body.data.siteMoved).toBeUndefined()
  })

  // The stay's own row decides all of this, not the request. Pinning a stay is
  // one UPDATE on one column and changes nothing the freshness check looks at,
  // so the read at the top of the handler can be stale by the time the write
  // runs — which is why the lock, the rewrite and the email are all read inside
  // the save with the row locked. A caller shouting overrideLocked at a stay
  // nobody pinned therefore changes nothing about it.
  it('rewrites nothing and emails nobody when the stay was never pinned', async () => {
    const f = await seed()
    const id = await takenHere(f, f.unitIds[0])

    const res = await patch(f, f.unitIds[0], id, { unitId: f.unitIds[1], overrideLocked: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await stay(id)).toEqual({ unit_id: f.unitIds[1], locked_to_unit: false, lock_reason: null })
    expect(h.siteChanged).not.toHaveBeenCalled()
    expect(res.body.data.siteMoved).toBeUndefined()
    // And the ordinary history diff still records the move, once.
    expect(await movedEvents(id)).toHaveLength(1)
  })
})
