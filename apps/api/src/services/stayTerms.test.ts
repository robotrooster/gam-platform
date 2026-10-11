/**
 * 10/5 (Nic) — PREPAID STAYS: the rules every door calls (services/stayTerms).
 *
 *   22+ continuous nights → a background check, its fee on the payment.
 *   30+ continuous nights → lease or stay; the landlord is told either way.
 *   No lease is drafted unless lease was chosen. Check-in waits on screening.
 *   A 30+ night stay with no lease pays its site's utilities.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'

const { screeningMock, utilityInviteMock } = vi.hoisted(() => ({
  screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  utilityInviteMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
}))
vi.mock('./email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: screeningMock,
  emailUtilityServiceInvite: utilityInviteMock,
}))

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { generateBillsForMeter, billMoveOutRead } from './utilityBilling'
import { getReadsDue } from './utilityReadingRuns'
import { generateServiceAgreementInvoices } from '../jobs/serviceAgreementInvoices'
import {
  continuousStayNights, screeningOnFile, stayNeeds, recordScreeningPrepayment, voidScreeningPrepayment,
  draftLeaseFromStay, notifyLongStay, chooseStayTerms, syncStayUtilityAgreement, checkInBlock,
  emailPrepaidScreeningLink, restorePrepaidScreening, screeningCollectedBy, isLandlordCollectedTender,
  screeningPaidForStay,
} from './stayTerms'
import { guestScreeningContext } from './bookingLeaseDraft'
import { screeningIntakeFee } from '../routes/background'

beforeEach(async () => {
  await cleanupAllSchema()
  screeningMock.mockClear()
  utilityInviteMock.mockClear()
})

interface World { landlordId: string; userId: string; propertyId: string; unitId: string; unit2Id: string }

async function world(opts: { rentDueMode?: 'fixed_day' | 'move_in_day'; rentDueDay?: number } = {}): Promise<World> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET rent_due_mode = $2, rent_due_day = $3 WHERE id = $1`,
      [propertyId, opts.rentDueMode ?? 'fixed_day', opts.rentDueDay ?? 1])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    const unit2Id = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    await c.query('COMMIT')
    return { landlordId, userId, propertyId, unitId, unit2Id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const day = async (offset: number): Promise<string> =>
  (await db.query<{ d: string }>(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [offset])).rows[0].d

async function booking(w: Pick<World, 'landlordId'>, unitId: string, o: {
  from: number; to: number; email?: string | null; tenantId?: string | null
  status?: string; terms?: 'lease' | 'stay' | null; name?: string; createdDaysAgo?: number
  /** A7: marked by the door that sold it as needing screening before check-in. */
  screening?: boolean
}): Promise<string> {
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, tenant_id, guest_name, guest_email, check_in, check_out, status,
        lease_type, total_amount, stay_terms, created_at, screening_required)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + $6::int, CURRENT_DATE + $7::int, $8,
             'month_to_month', 900, $9, NOW() - ($10::int * INTERVAL '1 day'), $11)
     RETURNING id`,
    [unitId, w.landlordId, o.tenantId ?? null, o.name ?? 'Long Stayer', o.email ?? null, o.from, o.to,
     o.status ?? 'confirmed', o.terms ?? null, o.createdDaysAgo ?? 0, !!o.screening])
  return b.id
}

async function tenantWithEmail(email: string): Promise<{ tenantId: string; userId: string }> {
  const c = await getClient()
  try {
    const tenantId = await seedTenant(c, { email })
    const { rows: [t] } = await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    return { tenantId, userId: t.user_id }
  } finally { c.release() }
}

async function check(landlordId: string, person: { tenantId: string; userId: string }, o: {
  status: string; decidedDaysAgo?: number; createdDaysAgo?: number; summary?: boolean
}): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, decided_at, created_at, report_summary)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() - ($5::int * INTERVAL '1 day') END,
             NOW() - ($6::int * INTERVAL '1 day'),
             CASE WHEN $7::boolean THEN '{"result":"clear"}'::jsonb ELSE NULL END)
     RETURNING id`,
    [landlordId, person.userId, person.tenantId, o.status, o.decidedDaysAgo ?? null, o.createdDaysAgo ?? 0, !!o.summary])
  return r.id
}

const email = (tag: string) => `${tag}-${randomUUID().slice(0, 6)}@test.dev`

// ── R7 ──────────────────────────────────────────────────────────────────────
describe('continuousStayNights (R7) — back-to-back stays at one property add up', () => {
  it('chains stays that meet check-out to check-in across sites, by email in any letter case', async () => {
    const w = await world()
    const e = email('chain')
    const a = await booking(w, w.unitId, { from: -14, to: 0, email: e, status: 'checked_in' })
    const b = await booking(w, w.unit2Id, { from: 0, to: 10, email: e.toUpperCase() })
    const r = await continuousStayNights({ propertyId: w.propertyId, email: e, checkIn: await day(10), checkOut: await day(15) })
    // the stay being priced (not saved yet) + the two saved ones
    expect(r.nights).toBe(29)
    expect(r.bookingIds.sort()).toEqual([a, b].sort())
    expect(r.checkIn).toBe(await day(-14))
    expect(r.checkOut).toBe(await day(15))
  })

  it('a gap of one night breaks the chain; cancelled stays and other properties never count', async () => {
    const w = await world()
    const other = await world()
    const e = email('gap')
    await booking(w, w.unitId, { from: -20, to: -1, email: e, status: 'checked_out' })       // gap: ends the day before
    await booking(w, w.unitId, { from: 5, to: 15, email: e, status: 'cancelled' })
    await booking(other, other.unitId, { from: 5, to: 30, email: e })
    const r = await continuousStayNights({ propertyId: w.propertyId, email: e, checkIn: await day(0), checkOut: await day(5) })
    expect(r.nights).toBe(5)
    expect(r.bookingIds).toEqual([])
  })

  it('an extension is priced on its new dates, not the saved row; overlapping stays count their nights once', async () => {
    const w = await world()
    const e = email('ext')
    const self = await booking(w, w.unitId, { from: 0, to: 10, email: e })
    await booking(w, w.unit2Id, { from: 5, to: 12, email: e })      // second site, overlapping
    const r = await continuousStayNights({ propertyId: w.propertyId, bookingId: self, email: e, checkIn: await day(0), checkOut: await day(40) })
    expect(r.nights).toBe(40)
    expect(r.bookingIds).toHaveLength(2)
  })

  it('an email match never joins a stay booked to a different tenant', async () => {
    const w = await world()
    const e = email('two')
    const t1 = await tenantWithEmail(e)
    const t2 = await tenantWithEmail(email('other'))
    await booking(w, w.unitId, { from: -10, to: 0, email: e, tenantId: t2.tenantId })
    await booking(w, w.unit2Id, { from: 10, to: 20, tenantId: t1.tenantId })     // no email on it — tenant match
    const r = await continuousStayNights({ propertyId: w.propertyId, tenantId: t1.tenantId, checkIn: await day(0), checkOut: await day(10) })
    expect(r.nights).toBe(20)
  })
})

// ── R8: on file ─────────────────────────────────────────────────────────────
describe('screeningOnFile (R8)', () => {
  it('nothing on file for a new guest', async () => {
    const w = await world()
    expect(await screeningOnFile({ landlordId: w.landlordId, email: email('new') })).toEqual({ onFile: false })
  })

  it('an approved check with continuous STAYS since counts — a long-term stay guest is not re-screened', async () => {
    const w = await world()
    const e = email('stays')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'approved', decidedDaysAgo: 100, createdDaysAgo: 101 })
    await booking(w, w.unitId, { from: -95, to: -40, email: e, status: 'checked_out' })
    await booking(w, w.unitId, { from: -40, to: 5, email: e, status: 'checked_in' })
    const r = await screeningOnFile({ landlordId: w.landlordId, propertyId: w.propertyId, email: e })
    expect(r).toMatchObject({ onFile: true, kind: 'approved' })
    const ctx = await guestScreeningContext(e, w.landlordId, null)
    expect(ctx.continuousTenancySince).toBe(true)
  })

  it('an approved check with a long gap since is not on file', async () => {
    const w = await world()
    const e = email('old')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'approved', decidedDaysAgo: 200, createdDaysAgo: 201 })
    await booking(w, w.unitId, { from: -190, to: -150, email: e, status: 'checked_out' })
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e })).toEqual({ onFile: false })
  })

  it('a check still running for this account is on file; another company’s is not', async () => {
    const w = await world()
    const other = await world()
    const e = email('run')
    const p = await tenantWithEmail(e)
    await check(other.landlordId, p, { status: 'submitted' })
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e })).toEqual({ onFile: false })
    const id = await check(w.landlordId, p, { status: 'processing' })
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e })).toEqual({ onFile: true, kind: 'in_progress', checkId: id })
  })

  it('an unused prepayment for the person counts', async () => {
    const w = await world()
    const e = email('pre')
    const rec = await recordScreeningPrepayment(null, {
      landlordId: w.landlordId, propertyId: w.propertyId, bookingId: null, email: e, amount: 42.94, source: 'register', collectedBy: 'gam',
    })
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e.toUpperCase() }))
      .toEqual({ onFile: true, kind: 'prepaid', prepaymentId: rec.prepaymentId })
  })

  it('the check run for this stay counts on an extension — approved a month before arrival, or denied', async () => {
    const w = await world()
    const e = email('own')
    const p = await tenantWithEmail(e)
    const b = await booking(w, w.unitId, { from: -25, to: 5, email: e, status: 'checked_in', createdDaysAgo: 80 })
    const id = await check(w.landlordId, p, { status: 'denied', decidedDaysAgo: 60, createdDaysAgo: 70, summary: true })
    const chain = await continuousStayNights({ propertyId: w.propertyId, bookingId: b, checkIn: await day(-25), checkOut: await day(35) })
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e, stay: chain }))
      .toEqual({ onFile: true, kind: 'stay_check', checkId: id })
    // Without the stay, a denied check is not on file.
    expect(await screeningOnFile({ landlordId: w.landlordId, email: e })).toEqual({ onFile: false })
  })
})

// ── the one question ────────────────────────────────────────────────────────
describe('stayNeeds — the one function every door calls', () => {
  it('under 22 nights: nothing to ask', async () => {
    const w = await world()
    const r = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, email: email('short'), checkIn: await day(0), checkOut: await day(21) })
    expect(r).toMatchObject({ nights: 21, screening: 'not_needed', leaseChoice: 'not_asked', screeningFee: null })
  })

  it('22 nights with nothing on file: the intake price, before its own card processing', async () => {
    const w = await world()
    const r = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, email: email('fee'), checkIn: await day(0), checkOut: await day(22) })
    const intake = await screeningIntakeFee('AZ')
    expect(r.screening).toBe('fee_due')
    expect(r.leaseChoice).toBe('not_asked')
    expect(r.screeningFee).toEqual({
      amount: Math.round((intake.screening + intake.gamFee + intake.tax) * 100) / 100,
      screening: intake.screening, gamFee: intake.gamFee, tax: intake.tax, intakeTotal: intake.total,
    })
  })

  it('30+ nights asks lease or stay; the answer given wins; a check on file means no fee', async () => {
    const w = await world()
    const e = email('thirty')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'submitted' })
    const asked = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, email: e, checkIn: await day(0), checkOut: await day(30) })
    expect(asked).toMatchObject({ screening: 'on_file', leaseChoice: 'needed', screeningFee: null })
    const answered = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, email: e, checkIn: await day(0), checkOut: await day(30), stayTerms: 'stay' })
    expect(answered.leaseChoice).toBe('stay')
  })

  it('two back-to-back 15-night stays reach the lease choice; the stay’s own answer stands on an extension', async () => {
    const w = await world()
    const e = email('b2b')
    await booking(w, w.unitId, { from: -15, to: 0, email: e, status: 'checked_in' })
    const r = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, email: e, checkIn: await day(0), checkOut: await day(15) })
    expect(r.nights).toBe(30)
    expect(r.leaseChoice).toBe('needed')
    const own = await booking(w, w.unit2Id, { from: 0, to: 15, email: e, terms: 'stay' })
    const ext = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, bookingId: own, checkIn: await day(0), checkOut: await day(45) })
    expect(ext.leaseChoice).toBe('stay')
    // the fee for this stay was already paid — no second one on the extension
    await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: own, email: e, amount: 42.94, source: 'pay_link', collectedBy: 'gam' })
    const again = await stayNeeds({ landlordId: w.landlordId, propertyId: w.propertyId, bookingId: own, checkIn: await day(0), checkOut: await day(75) })
    expect(again.screening).toBe('on_file')
  })
})

// ── R8: the prepayment ──────────────────────────────────────────────────────
describe('recordScreeningPrepayment / voidScreeningPrepayment (R8)', () => {
  it('A5: tells which tenders the landlord holds the money for', () => {
    for (const t of ['cash', 'check', 'money_order', 'charge', 'CASH']) {
      expect(isLandlordCollectedTender(t)).toBe(true)
      expect(screeningCollectedBy(t)).toBe('landlord')
    }
    for (const t of ['card', 'card_on_file', 'terminal', '', null, undefined]) {
      expect(isLandlordCollectedTender(t)).toBe(false)
      expect(screeningCollectedBy(t)).toBe('gam')
    }
  })

  it('A5: paid by card the fee is already GAM’s — recorded, but no charge to the landlord', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: email('card') })
    const rec = await recordScreeningPrepayment(null, {
      landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, amount: 42.94, source: 'pay_link', collectedBy: 'gam',
    })
    expect(rec).toMatchObject({ created: true, landlordChargeId: null })
    const { rows: [sp] } = await db.query(`SELECT status, landlord_charge_id FROM screening_prepayments WHERE id = $1`, [rec.prepaymentId])
    expect(sp).toEqual({ status: 'unused', landlord_charge_id: null })
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE kind = 'screening_fee'`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT screening_required FROM unit_bookings WHERE id = $1`, [b])).rows[0].screening_required).toBe(true)
    // idempotent for the stay: a second sale records nothing new
    const again = await recordScreeningPrepayment(null, {
      landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, amount: 42.94, source: 'register', collectedBy: 'landlord',
    })
    expect(again).toMatchObject({ created: false, prepaymentId: rec.prepaymentId, landlordChargeId: null })
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE kind = 'screening_fee'`)).rows).toHaveLength(0)
    // a void with nothing to take back from the landlord
    expect(await voidScreeningPrepayment(null, { bookingId: b })).toEqual({ voided: true })
  })

  it('A5: paid in cash the landlord holds it — records the screening, charges the landlord GAM’s fee, marks the stay, and emails the paid link after commit', async () => {
    const w = await world()
    const e = email('paid')
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e })
    const c = await getClient()
    let rec
    try {
      await c.query('BEGIN')
      rec = await recordScreeningPrepayment(c, {
        landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, email: e, amount: 42.94, source: 'register', sourceId: randomUUID(),
        collectedBy: 'landlord',
      })
      expect(screeningMock).not.toHaveBeenCalled()   // never before the sale commits
      await c.query('COMMIT')
    } finally { c.release() }
    await rec.afterCommit()

    expect(rec.created).toBe(true)
    const { rows: [sp] } = await db.query(`SELECT * FROM screening_prepayments WHERE id = $1`, [rec.prepaymentId])
    expect(sp).toMatchObject({ status: 'unused', amount: '42.94', source: 'register', booking_id: b, email: e })
    const { rows: [ch] } = await db.query(`SELECT * FROM landlord_gam_charges WHERE id = $1`, [sp.landlord_charge_id])
    expect(ch).toMatchObject({ kind: 'screening_fee', amount: '42.94', source_type: 'screening_prepayment', source_id: rec.prepaymentId })
    const { rows: [bk] } = await db.query(`SELECT screening_required FROM unit_bookings WHERE id = $1`, [b])
    expect(bk.screening_required).toBe(true)

    expect(screeningMock).toHaveBeenCalledTimes(1)
    const [to, , , link, ctx] = screeningMock.mock.calls[0]
    expect(to).toBe(e)
    expect(ctx).toMatchObject({ landlordId: w.landlordId, prepaid: true, replyTo: { kind: 'property', propertyId: w.propertyId } })
    const url = new URL(String(link))
    expect(url.pathname).toBe('/background-check')
    expect(url.searchParams.get('landlordId')).toBe(w.landlordId)
    expect(url.searchParams.get('propertyId')).toBe(w.propertyId)
    expect(url.searchParams.get('unitId')).toBe(w.unitId)
  })

  it('is idempotent per stay: a second sale charges nothing and sends nothing', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: email('twice') })
    const first = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, amount: 42.94, source: 'schedule', collectedBy: 'landlord' })
    const second = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, amount: 42.94, source: 'schedule', collectedBy: 'landlord' })
    expect(second).toMatchObject({ created: false, prepaymentId: first.prepaymentId })
    const { rows } = await db.query(`SELECT 1 FROM landlord_gam_charges WHERE kind = 'screening_fee'`)
    expect(rows).toHaveLength(1)
    expect(screeningMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a zero fee', async () => {
    const w = await world()
    await expect(recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: null, bookingId: null, amount: 0, source: 'register', collectedBy: 'gam' }))
      .rejects.toThrow(/more than zero/)
  })

  it('a used prepayment sends no link', async () => {
    const w = await world()
    const rec = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: null, email: email('used'), amount: 42.94, source: 'register', collectedBy: 'gam' })
    await db.query(`UPDATE screening_prepayments SET status = 'used', used_at = NOW() WHERE id = $1`, [rec.prepaymentId])
    screeningMock.mockClear()
    expect(await emailPrepaidScreeningLink(rec.prepaymentId)).toEqual({ sentTo: null })
    expect(screeningMock).not.toHaveBeenCalled()
  })

  it('void: an uncollected fee is not charged; a collected or used one stands', async () => {
    const w = await world()
    const b1 = await booking(w, w.unitId, { from: 0, to: 25, email: email('v1') })
    const r1 = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b1, amount: 42.94, source: 'booking_site', collectedBy: 'landlord' })
    expect(await voidScreeningPrepayment(null, { bookingId: b1 })).toEqual({ voided: true })
    const { rows: [sp] } = await db.query(`SELECT status, voided_at, landlord_charge_id FROM screening_prepayments WHERE id = $1`, [r1.prepaymentId])
    expect(sp.status).toBe('void')
    expect(sp.voided_at).toBeTruthy()
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE id = $1`, [sp.landlord_charge_id])).rows).toHaveLength(0)
    // a voided stay can be sold again
    const again = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b1, amount: 42.94, source: 'booking_site', collectedBy: 'landlord' })
    expect(again.created).toBe(true)

    const b2 = await booking(w, w.unit2Id, { from: 0, to: 25, email: email('v2') })
    const r2 = await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b2, amount: 42.94, source: 'register', collectedBy: 'landlord' })
    await db.query(`UPDATE landlord_gam_charges SET collected_amount = 10 WHERE id = $1`, [r2.landlordChargeId])
    expect(await voidScreeningPrepayment(null, { prepaymentId: r2.prepaymentId })).toEqual({ voided: false, reason: 'collected' })

    await db.query(`UPDATE screening_prepayments SET status = 'used' WHERE id = $1`, [again.prepaymentId])
    expect(await voidScreeningPrepayment(null, { bookingId: b1 })).toEqual({ voided: false, reason: 'used' })
    expect(await voidScreeningPrepayment(null, { bookingId: randomUUID() })).toEqual({ voided: false, reason: 'none' })
  })
})

// ── R2/R3/R4 ────────────────────────────────────────────────────────────────
describe('lease or stay (R2, R3, R4)', () => {
  it('lease chosen: month-to-month, no end date, due on the property’s fixed day; idempotent; the landlord is told', async () => {
    const w = await world({ rentDueMode: 'fixed_day', rentDueDay: 5 })
    const b = await booking(w, w.unitId, { from: 0, to: 35, email: email('lease'), name: 'Pat Long' })
    const r = await draftLeaseFromStay(b, { byUserId: w.userId })
    expect(r.drafted).toBe(true)
    const { rows: [l] } = await db.query(`SELECT * FROM leases WHERE id = $1`, [r.leaseId])
    expect(l).toMatchObject({
      lease_type: 'month_to_month', status: 'pending', end_date: null, needs_review: true,
      lease_source: 'booking_draft', source_booking_id: b, rent_amount: '900.00', rent_due_day: 5,
    })
    expect((await db.query(`SELECT stay_terms FROM unit_bookings WHERE id = $1`, [b])).rows[0].stay_terms).toBe('lease')
    const again = await draftLeaseFromStay(b)
    expect(again).toEqual({ drafted: false, leaseId: r.leaseId })
    const { rows: notes } = await db.query(`SELECT title, body, action_url FROM notifications WHERE type = 'lease_drafted_from_booking'`)
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Long stay — lease chosen, draft ready')
    expect(notes[0].body).toMatch(/Pat Long chose a lease for their 35-night stay/)
    expect(notes[0].action_url).toBe(`/leases?open=${r.leaseId}`)
  })

  it('a move-in-day property bills the lease on its own day (no proration); fallback rent is the monthly rate', async () => {
    const w = await world({ rentDueMode: 'move_in_day' })
    await db.query(`UPDATE units SET rent_amount = 0, monthly_rate = 750 WHERE id = $1`, [w.unitId])
    const b = await booking(w, w.unitId, { from: 0, to: 40, email: email('mid') })
    const r = await draftLeaseFromStay(b)
    const { rows: [l] } = await db.query(`SELECT rent_amount, rent_due_day, start_date::text AS s FROM leases WHERE id = $1`, [r.leaseId])
    const d = Number(l.s.slice(8, 10))
    expect(l.rent_due_day).toBe(d > 28 ? 1 : d)
    expect(l.rent_amount).toBe('750.00')
  })

  it('M4: a lease chosen partway through the stay starts today, and only what was paid for the nights from today on comes off it', async () => {
    const w = await world({ rentDueMode: 'fixed_day', rentDueDay: 1 })
    // 60 nights, 20 already stayed, $1,800 paid in full for the whole stay
    const b = await booking(w, w.unitId, { from: -20, to: 40, email: email('mid'), status: 'checked_in', name: 'Mia Mid' })
    await db.query(`UPDATE unit_bookings SET total_amount = 1800, balance_paid_at = NOW() WHERE id = $1`, [b])
    const r = await draftLeaseFromStay(b)
    const { rows: [l] } = await db.query(`SELECT start_date::text AS s FROM leases WHERE id = $1`, [r.leaseId])
    expect(l.s).toBe(await day(0))
    const { RESERVATION_PAID_SQL } = await import('./bookingLeaseDraft')
    const { rows: [paid] } = await db.query(`SELECT ${RESERVATION_PAID_SQL}::text AS p FROM unit_bookings b WHERE b.id = $1`, [b])
    // 40 of the 60 nights paid for are the lease's: $1,200, credited once
    expect(Number(paid.p)).toBe(1200)
    const { rows: [n] } = await db.query(`SELECT body FROM notifications WHERE type = 'lease_drafted_from_booking'`)
    expect(n.body).toMatch(/partway through the stay/)
    expect(n.body).toContain('$1200.00 already paid for the nights from then on')
  })

  it('a lease chosen before the stay begins starts at check-in and takes everything paid', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 5, to: 40, email: email('ahead') })
    await db.query(`UPDATE unit_bookings SET deposit_amount = 300, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const r = await draftLeaseFromStay(b)
    expect((await db.query(`SELECT start_date::text AS s FROM leases WHERE id = $1`, [r.leaseId])).rows[0].s).toBe(await day(5))
    const { RESERVATION_PAID_SQL } = await import('./bookingLeaseDraft')
    expect(Number((await db.query(`SELECT ${RESERVATION_PAID_SQL}::text AS p FROM unit_bookings b WHERE b.id = $1`, [b])).rows[0].p)).toBe(300)
  })

  it('no lease for a stay that is over', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: -40, to: -1, email: email('over'), status: 'checked_out' })
    expect(await draftLeaseFromStay(b)).toEqual({ drafted: false })
  })

  it('stay chosen: the landlord is told the site is held only through the paid date — once', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 31, email: email('stay'), name: 'Sam Stay' })
    await chooseStayTerms(b, 'stay')
    expect((await db.query(`SELECT stay_terms FROM unit_bookings WHERE id = $1`, [b])).rows[0].stay_terms).toBe('stay')
    expect(await notifyLongStay(b, 'stay')).toEqual({ notified: false })
    const { rows } = await db.query(`SELECT title, body, action_url FROM notifications WHERE type = 'long_stay_no_lease'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Long stay — no lease')
    expect(rows[0].body).toMatch(/Sam Stay is staying 31 nights on site .* without a lease/)
    const out = await day(31)
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    expect(rows[0].body).toContain(`held through ${months[Number(out.slice(5, 7)) - 1]} ${Number(out.slice(8, 10))}, ${out.slice(0, 4)}`)
    expect(rows[0].body).toMatch(/needs a background check before check-in/)
    expect((await db.query(`SELECT 1 FROM leases`)).rows).toHaveLength(0)
  })
})

// ── R11 ─────────────────────────────────────────────────────────────────────
describe('syncStayUtilityAgreement (R11)', () => {
  it('a 30+ night stay with no lease gets a utility agreement for the guest on that site, kept in step to check-out', async () => {
    const w = await world()
    const e = email('util')
    const b = await booking(w, w.unitId, { from: 0, to: 31, email: e, terms: 'stay', name: 'Una Util' })
    const r = await syncStayUtilityAgreement(b, { byUserId: w.userId })
    expect(r.action).toBe('created')
    const { rows: [sa] } = await db.query(
      `SELECT sa.*, sa.start_date::text AS s, sa.end_date::text AS e, u.email, u.password_hash, u.first_name, u.last_name
         FROM utility_service_agreements sa JOIN tenants t ON t.id = sa.tenant_id JOIN users u ON u.id = t.user_id
        WHERE sa.booking_id = $1`, [b])
    expect(sa).toMatchObject({ unit_id: w.unitId, status: 'active', email: e, first_name: 'Una', last_name: 'Util',
      password_hash: '$2b$10$placeholder_invite_pending', payer_attested_by: w.userId })
    expect(sa.payer_attested_at).toBeTruthy()
    expect(sa.s).toBe(await day(0))
    expect(sa.e).toBe(await day(31))
    expect(utilityInviteMock).toHaveBeenCalledTimes(1)

    // extended a month: the end moves with it
    await db.query(`UPDATE unit_bookings SET check_out = CURRENT_DATE + 61 WHERE id = $1`, [b])
    expect((await syncStayUtilityAgreement(b)).action).toBe('updated')
    expect((await db.query(`SELECT end_date::text AS e FROM utility_service_agreements WHERE booking_id = $1`, [b])).rows[0].e).toBe(await day(61))

    // checked out: ended on the day they left
    await db.query(`UPDATE unit_bookings SET status = 'checked_out', check_out = CURRENT_DATE + 40 WHERE id = $1`, [b])
    expect((await syncStayUtilityAgreement(b)).action).toBe('ended')
    const { rows: [ended] } = await db.query(`SELECT status, end_date::text AS e FROM utility_service_agreements WHERE booking_id = $1`, [b])
    expect(ended).toEqual({ status: 'ended', e: await day(40) })
  })

  it('a lease chosen later ends it — the lease pays the utilities', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 31, email: email('later'), terms: 'stay' })
    expect((await syncStayUtilityAgreement(b)).action).toBe('created')
    await draftLeaseFromStay(b)
    expect((await db.query(`SELECT status FROM utility_service_agreements WHERE booking_id = $1`, [b])).rows[0].status).toBe('ended')
  })

  it('shorter stays and undecided stays have utilities included', async () => {
    const w = await world()
    const short = await booking(w, w.unitId, { from: 0, to: 20, email: email('short'), terms: 'stay' })
    const undecided = await booking(w, w.unit2Id, { from: 0, to: 35, email: email('und') })
    expect(await syncStayUtilityAgreement(short)).toEqual({ action: 'none' })
    expect(await syncStayUtilityAgreement(undecided)).toEqual({ action: 'none' })
  })

  it('A4: bills the resident login the guest’s email already has, from any company — no new account, no password link', async () => {
    const w = await world()
    const other = await world()
    const e = email('held')
    const p = await tenantWithEmail(e)     // has its own password
    // a resident elsewhere on GAM
    const c = await getClient()
    try {
      const lu = await seedUnit(c, { propertyId: other.propertyId, landlordId: other.landlordId })
      const leaseId = await seedLease(c, { unitId: lu, landlordId: other.landlordId, rentAmount: 900, startDate: await day(-90), status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: p.tenantId })
    } finally { c.release() }
    const b = await booking(w, w.unitId, { from: 0, to: 31, email: e.toUpperCase(), terms: 'stay' })
    expect((await syncStayUtilityAgreement(b)).action).toBe('created')
    expect((await db.query(`SELECT tenant_id FROM utility_service_agreements WHERE booking_id = $1`, [b])).rows[0].tenant_id).toBe(p.tenantId)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = $1`, [e])).rows[0].n).toBe(1)
    expect(utilityInviteMock).not.toHaveBeenCalled()
  })

  it('A4: an email with no login gets a placeholder account; an owner or staff login is skipped and the landlord told', async () => {
    const w = await world()
    const noEmail = await booking(w, w.unit2Id, { from: 0, to: 31, terms: 'stay' })
    expect(await syncStayUtilityAgreement(noEmail)).toEqual({ action: 'skipped', reason: 'no_email' })

    const staffEmail = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [w.userId])).rows[0].email
    const b = await booking(w, w.unitId, { from: 0, to: 31, email: staffEmail, terms: 'stay', name: 'Owen Owner' })
    expect(await syncStayUtilityAgreement(b)).toEqual({ action: 'skipped', reason: 'not_a_resident_account' })
    expect(await syncStayUtilityAgreement(b)).toEqual({ action: 'skipped', reason: 'not_a_resident_account' })
    const { rows } = await db.query(`SELECT title, body FROM notifications WHERE type = 'stay_utilities_not_billed'`)
    expect(rows).toHaveLength(1)    // told once
    expect(rows[0].body).toMatch(/belongs to an owner or staff login/)
    expect(rows[0].body).toMatch(/Put the guest's own email on the reservation/)
  })

  it('a back-to-back stay on the same site takes over from the one ending the day it arrives', async () => {
    const w = await world()
    const first = await booking(w, w.unitId, { from: -10, to: 25, email: email('first'), terms: 'stay', status: 'checked_in' })
    expect((await syncStayUtilityAgreement(first)).action).toBe('created')
    const next = await booking(w, w.unitId, { from: 25, to: 60, email: email('next'), terms: 'stay' })
    expect((await syncStayUtilityAgreement(next)).action).toBe('created')
    const { rows } = await db.query(
      `SELECT booking_id, status, end_date::text AS e FROM utility_service_agreements WHERE unit_id = $1 ORDER BY start_date`, [w.unitId])
    expect(rows).toEqual([
      { booking_id: first, status: 'ended', e: await day(25) },
      { booking_id: next, status: 'active', e: await day(60) },
    ])
    // a stay still running into the next one is not cut short
    const overlap = await booking(w, w.unit2Id, { from: -5, to: 40, email: email('o1'), terms: 'stay', status: 'checked_in' })
    expect((await syncStayUtilityAgreement(overlap)).action).toBe('created')
    const into = await booking(w, w.unit2Id, { from: 35, to: 70, email: email('o2'), terms: 'stay' })
    expect(await syncStayUtilityAgreement(into)).toEqual({ action: 'skipped', reason: 'site_has_agreement' })
  })

  it('an early departure recorded after the agreement ended moves its end to the real day', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: -20, to: 31, email: email('early'), terms: 'stay', status: 'checked_in' })
    expect((await syncStayUtilityAgreement(b)).action).toBe('created')
    await db.query(`UPDATE unit_bookings SET status = 'checked_out', check_out = CURRENT_DATE WHERE id = $1`, [b])
    expect((await syncStayUtilityAgreement(b)).action).toBe('ended')
    expect(await syncStayUtilityAgreement(b)).toEqual({ action: 'none' })
    await db.query(`UPDATE unit_bookings SET check_out = CURRENT_DATE - 2 WHERE id = $1`, [b])
    expect((await syncStayUtilityAgreement(b)).action).toBe('ended')
    expect((await db.query(`SELECT end_date::text AS e FROM utility_service_agreements WHERE booking_id = $1`, [b])).rows[0].e).toBe(await day(-2))
  })

  it('uses the stay’s own tenant when it has one', async () => {
    const w = await world()
    const p = await tenantWithEmail(email('own'))
    const b = await booking(w, w.unitId, { from: 0, to: 31, tenantId: p.tenantId, terms: 'stay' })
    expect((await syncStayUtilityAgreement(b)).action).toBe('created')
    expect((await db.query(`SELECT tenant_id FROM utility_service_agreements WHERE booking_id = $1`, [b])).rows[0].tenant_id).toBe(p.tenantId)
    expect(utilityInviteMock).not.toHaveBeenCalled()
  })
})

// ── R9 ──────────────────────────────────────────────────────────────────────
describe('checkInBlock (R9) — check-in waits for results and a decision', () => {
  it('a stay under 22 nights is never blocked', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 21, email: email('ok') })
    expect(await checkInBlock(b)).toBeNull()
  })

  it('A7: a long stay booked before this change (never marked as needing screening) is never blocked', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 60, email: email('before') })
    expect(await checkInBlock(b)).toBeNull()
  })

  it('no check yet: blocked, naming the paid link', async () => {
    const w = await world()
    const e = email('none')
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e, screening: true })
    expect(await checkInBlock(b)).toMatchObject({ code: 'screening_pending', waitingOn: 'no_check', message: expect.stringMatching(/No background check is on file/) })
    await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, email: e, amount: 42.94, source: 'register', collectedBy: 'gam' })
    const r = await checkInBlock(b)
    expect(r?.message).toContain(`emailed to ${e}`)
  })

  it('walks the check through: started → results pending → awaiting decision → decided clears it (denied too)', async () => {
    const w = await world()
    const e = email('walk')
    const p = await tenantWithEmail(e)
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e, createdDaysAgo: 3, screening: true })
    const id = await check(w.landlordId, p, { status: 'awaiting_applicant', createdDaysAgo: 1 })
    expect(await checkInBlock(b)).toMatchObject({ waitingOn: 'guest', checkId: id })
    await db.query(`UPDATE background_checks SET status = 'processing' WHERE id = $1`, [id])
    expect(await checkInBlock(b)).toMatchObject({ waitingOn: 'results' })
    await db.query(`UPDATE background_checks SET status = 'complete', report_summary = '{"r":1}' WHERE id = $1`, [id])
    expect(await checkInBlock(b)).toMatchObject({ waitingOn: 'decision' })
    await db.query(`UPDATE background_checks SET status = 'denied', decided_at = NOW() WHERE id = $1`, [id])
    expect(await checkInBlock(b)).toBeNull()
  })

  it('A6: a decided check clears check-in — a decision is only ever taken once results are back', async () => {
    const w = await world()
    const e = email('decided')
    const p = await tenantWithEmail(e)
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e, createdDaysAgo: 3, screening: true })
    // an older approval with no report on the row (decided before A6) is not held up forever
    await check(w.landlordId, p, { status: 'approved', decidedDaysAgo: 0, createdDaysAgo: 1 })
    expect(await checkInBlock(b)).toBeNull()
  })

  it('an approved check from before the stay, with continuous stays since, needs no new one', async () => {
    const w = await world()
    const e = email('cleared')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'approved', decidedDaysAgo: 60, createdDaysAgo: 61 })
    await booking(w, w.unit2Id, { from: -58, to: 0, email: e, status: 'checked_in', createdDaysAgo: 59 })
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e, screening: true })
    expect(await checkInBlock(b)).toBeNull()
  })

  it('a stay marked when it was longer, then shortened below 22 nights, no longer waits (R1)', async () => {
    const w = await world()
    const b = await booking(w, w.unitId, { from: 0, to: 10, email: email('flag') })
    await db.query(`UPDATE unit_bookings SET screening_required = true WHERE id = $1`, [b])
    expect(await checkInBlock(b)).toBeNull()
  })

  it('a check already under way when the stay was booked is the one check-in waits on', async () => {
    const w = await world()
    const e = email('running')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'processing', createdDaysAgo: 5 })
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e, screening: true, createdDaysAgo: 1 })
    expect(await checkInBlock(b)).toMatchObject({ waitingOn: 'results' })
  })

  it('a short first leg waits when the back-to-back leg that made the stay 22+ was marked', async () => {
    const w = await world()
    const e = email('legs')
    const first = await booking(w, w.unitId, { from: 0, to: 15, email: e })
    await booking(w, w.unitId, { from: 15, to: 25, email: e, screening: true })
    expect(await checkInBlock(first)).toMatchObject({ waitingOn: 'no_check' })
  })
})

// S655 stays in force through the stays extension: another company's leases
// and stays never make a guest "continuous" here.
describe('guestScreeningContext keeps to this account', () => {
  it('stays at another company do not count toward continuity', async () => {
    const w = await world()
    const other = await world()
    const e = email('acct')
    const p = await tenantWithEmail(e)
    await check(w.landlordId, p, { status: 'approved', decidedDaysAgo: 100, createdDaysAgo: 101 })
    await booking(other, other.unitId, { from: -95, to: 10, email: e, status: 'checked_in' })
    const c = await getClient()
    try {
      const lu = await seedUnit(c, { propertyId: other.propertyId, landlordId: other.landlordId })
      const leaseId = await seedLease(c, { unitId: lu, landlordId: other.landlordId, rentAmount: 900, startDate: await day(-90), status: 'active' })
      await seedLeaseTenant(c, { leaseId, tenantId: p.tenantId })
    } finally { c.release() }
    const ctx = await guestScreeningContext(e, w.landlordId, null)
    expect(ctx.approvedCheckAt).toBeTruthy()
    expect(ctx.continuousTenancySince).toBe(false)
  })
})

// M9/F12: a prepaid check cancelled before a report
describe('restorePrepaidScreening — the paid check waits for the guest again', () => {
  it('puts the prepayment back and takes the check’s booked margin back off GAM’s book, once', async () => {
    const w = await world()
    const e = email('cancel')
    const p = await tenantWithEmail(e)
    const b = await booking(w, w.unitId, { from: 0, to: 25, email: e })
    const rec = await recordScreeningPrepayment(null, {
      landlordId: w.landlordId, propertyId: w.propertyId, bookingId: b, email: e, amount: 42.94, source: 'register', collectedBy: 'gam',
    })
    const id = await check(w.landlordId, p, { status: 'awaiting_applicant' })
    await db.query(`UPDATE screening_prepayments SET status = 'used', used_by_check_id = $2, used_at = NOW() WHERE id = $1`, [rec.prepaymentId, id])
    const { recordScreeningEarnings } = await import('./platformRevenue')
    await recordScreeningEarnings({ backgroundCheckId: id, gamMarginUsd: 5, processingChargedUsd: 0, totalChargedUsd: 42.94 })

    expect(await restorePrepaidScreening(id)).toEqual({ restored: true, prepaymentId: rec.prepaymentId })
    expect((await db.query(`SELECT status, used_by_check_id FROM screening_prepayments WHERE id = $1`, [rec.prepaymentId])).rows[0])
      .toEqual({ status: 'unused', used_by_check_id: null })
    const book = async () => Number((await db.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM platform_revenue_ledger WHERE reference_id = $1`, [id])).rows[0].s)
    expect(await book()).toBe(0)
    expect((await db.query(`SELECT type, amount::text, reference_type FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'adjustment'`, [id])).rows)
      .toEqual([{ type: 'adjustment', amount: '-5.00', reference_type: 'screening_margin_reversal' }])
    // nothing more to restore, nothing taken back twice
    expect(await restorePrepaidScreening(id)).toEqual({ restored: false })
    expect(await book()).toBe(0)
  })

  it('a check not paid with a stay is left to its own refund', async () => {
    const w = await world()
    const p = await tenantWithEmail(email('own-pay'))
    const id = await check(w.landlordId, p, { status: 'awaiting_applicant' })
    expect(await restorePrepaidScreening(id)).toEqual({ restored: false })
  })
})

// M7: a stay's utilities are billed the way a lease that starts or ends
// mid-cycle is — only usage inside its own dates, and its last stretch even
// after it has ended.
describe('stay utilities bill only inside the stay, and its last stretch after it ends (M7)', () => {
  async function meterOn(w: World): Promise<string> {
    const c = await getClient()
    let id = ''
    try { await c.query('BEGIN'); id = await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'electric' }); await c.query('COMMIT') }
    finally { c.release() }
    await db.query(`UPDATE utility_meters SET rate_per_unit = 0.10, base_fee = 0 WHERE id = $1`, [id])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [id, w.unitId])
    return id
  }
  const read = async (w: World, meterId: string, dayIso: string, value: number, reason = 'monthly_cycle'): Promise<string> =>
    (await db.query<{ id: string }>(
      `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, $2, $3, date_trunc('month', $2::date)::date, $4, $5) RETURNING id`,
      [meterId, dayIso, value, w.userId, reason])).rows[0].id
  const stayOn = async (w: World, from: string, to: string, o: { status?: string; terms?: 'stay' | null; email?: string } = {}) =>
    (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount, stay_terms)
       VALUES ($1, $2, 'Guest', $3, $4, $5, $6, 'month_to_month', 900, $7) RETURNING id`,
      [w.unitId, w.landlordId, o.email ?? email('g'), from, to, o.status ?? 'confirmed', o.terms ?? null])).rows[0].id
  const billsOf = async (agreementId: string) => (await db.query(
    `SELECT to_char(billing_cycle_month, 'YYYY-MM') AS cycle, usage_amount::float AS usage, charge_amount::text AS charge
       FROM utility_bills WHERE service_agreement_id = $1 ORDER BY billing_cycle_month`, [agreementId])).rows

  it('bills the stay from its arrival read, then its check-out read bills the last stretch, and the final bill goes out', async () => {
    const w = await world()
    const meterId = await meterOn(w)
    await read(w, meterId, '2026-02-28', 1000)
    // another guest before them, read out on the day they left
    await stayOn(w, '2026-03-01', '2026-03-10', { status: 'checked_out' })
    await read(w, meterId, '2026-03-10', 1100, 'stay_turnover')
    const s1 = await stayOn(w, '2026-03-10', '2026-04-20', { terms: 'stay' })
    const made = await syncStayUtilityAgreement(s1)
    expect(made.action).toBe('created')
    const agreementId = (made as any).agreementId as string

    // March: only the stay's own usage (from the turnover read on the day it arrived)
    await read(w, meterId, '2026-03-31', 1300)
    expect((await generateBillsForMeter(meterId, new Date(Date.UTC(2026, 2, 1)))).billsCreated).toBe(1)
    expect(await billsOf(agreementId)).toEqual([{ cycle: '2026-03', usage: 200, charge: '20.00' }])

    // they leave on 4/20; the agreement ends that day and the read due is a move-out read
    await db.query(`UPDATE unit_bookings SET status = 'checked_out' WHERE id = $1`, [s1])
    expect((await syncStayUtilityAgreement(s1)).action).toBe('ended')
    expect((await db.query(`SELECT status, end_date::text AS e FROM utility_service_agreements WHERE id = $1`, [agreementId])).rows[0])
      .toEqual({ status: 'ended', e: '2026-04-20' })
    const moveOut = await read(w, meterId, '2026-04-20', 1450, 'move_out_final')
    expect(await billMoveOutRead(meterId, moveOut)).toEqual({ billed: true })
    expect(await billsOf(agreementId)).toEqual([
      { cycle: '2026-03', usage: 200, charge: '20.00' },
      { cycle: '2026-04', usage: 150, charge: '15.00' },
    ])

    // the ended agreement's charges go out: nothing left unbilled
    const r = await generateServiceAgreementInvoices(new Date('2026-04-25T17:00:00Z'))
    expect(r.utilitiesInserted).toBe(2)
    const { rows: open } = await db.query(
      `SELECT 1 FROM utility_bills WHERE service_agreement_id = $1 AND payment_id IS NULL`, [agreementId])
    expect(open).toHaveLength(0)
    const { rows: inv } = await db.query(
      `SELECT SUM(total_amount)::text AS t FROM invoices WHERE service_agreement_id = $1`, [agreementId])
    expect(inv[0].t).toBe('35.00')
  })

  it('a month read with no check-out read in between still bills the stay that ended inside it', async () => {
    const w = await world()
    const meterId = await meterOn(w)
    await read(w, meterId, '2026-03-31', 1000)
    const s1 = await stayOn(w, '2026-03-31', '2026-05-02', { terms: 'stay' })
    const agreementId = ((await syncStayUtilityAgreement(s1)) as any).agreementId as string
    await db.query(`UPDATE unit_bookings SET status = 'checked_out', check_out = '2026-04-18' WHERE id = $1`, [s1])
    expect((await syncStayUtilityAgreement(s1)).action).toBe('ended')
    await read(w, meterId, '2026-04-30', 1080)
    expect((await generateBillsForMeter(meterId, new Date(Date.UTC(2026, 3, 1)))).billsCreated).toBe(1)
    expect(await billsOf(agreementId)).toEqual([{ cycle: '2026-04', usage: 80, charge: '8.00' }])
  })

  it('never bills the stay usage that holds another guest’s nights (no read between them)', async () => {
    const w = await world()
    const meterId = await meterOn(w)
    await read(w, meterId, '2026-02-28', 1000)
    await stayOn(w, '2026-03-01', '2026-03-10', { status: 'checked_out' })
    const s1 = await stayOn(w, '2026-03-10', '2026-04-20', { terms: 'stay' })
    const agreementId = ((await syncStayUtilityAgreement(s1)) as any).agreementId as string
    await read(w, meterId, '2026-03-31', 1300)
    await generateBillsForMeter(meterId, new Date(Date.UTC(2026, 2, 1)))
    expect(await billsOf(agreementId)).toEqual([])
  })

  it('the reads-due list asks for a move-out read when a stay that pays its utilities leaves', async () => {
    const w = await world()
    await meterOn(w)
    const paying = await booking(w, w.unitId, { from: -35, to: -2, email: email('pays'), terms: 'stay', status: 'checked_in' })
    expect((await syncStayUtilityAgreement(paying)).action).toBe('created')
    await db.query(`UPDATE unit_bookings SET status = 'checked_out' WHERE id = $1`, [paying])
    await syncStayUtilityAgreement(paying)
    await booking(w, w.unit2Id, { from: -5, to: -1, email: email('short'), status: 'checked_out' })
    const c = await getClient()
    try {
      const m2 = await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'electric' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [m2, w.unit2Id])
    } finally { c.release() }
    const due = await getReadsDue(w.propertyId)
    const reasonFor = (unitId: string) => due.find((r: any) => r.unit_id === unitId)?.reason
    expect(reasonFor(w.unitId)).toBe('move_out_final')
    expect(reasonFor(w.unit2Id)).toBe('stay_turnover')
  })
})

// 10/5 (M3): one background-check fee per continuous stay, never one per leg.
describe('screeningPaidForStay — one fee per continuous stay', () => {
  it('a check paid on one leg counts for the back-to-back leg too', async () => {
    const w = await world()
    const e = email('oneFee')
    const first = await booking(w, w.unitId, { from: 0, to: 15, email: e })
    const second = await booking(w, w.unit2Id, { from: 15, to: 25, email: e })
    expect(await screeningPaidForStay(second)).toBe(false)
    await recordScreeningPrepayment(null, { landlordId: w.landlordId, propertyId: w.propertyId, bookingId: first, email: e, amount: 42.94, source: 'pay_link', collectedBy: 'gam' })
    expect(await screeningPaidForStay(second)).toBe(true)
    // someone else's stay is not
    const other = await booking(w, w.unitId, { from: 25, to: 30, email: email('other') })
    expect(await screeningPaidForStay(other)).toBe(false)
  })
})
