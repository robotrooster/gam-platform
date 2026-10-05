/**
 * S655 money plan, Step 3 — fix round 4 (review of 10/3): reservation money
 * that moves to credit is still reservation money.
 *
 *   R6/R7: a reservation deposit's leftover pays part of a rent bill, then the
 *     guest leaves early and the stay is shortened. The money banked off that
 *     bill is partly the leftover's. It was read as all rent: the PM owner
 *     statement's October block read −$287.42, and at move-out the rent card
 *     handed back −$827.42 (the stay kept its $600). It now follows the money:
 *     the leftover's part of the take-back is the reservation's share.
 *   A2: a shortened stay's credit that paid a bill a second shortening took
 *     back keeps its reservation share (one share per lease, solved without
 *     going around in circles).
 *   R5: a reservation paid in two months had all of its money moved to credit
 *     taken off the later payment (September −$405). It now comes off the
 *     reservation's own payments, newest first, each in its own month.
 *
 * R5–R7 drive the real move-in, bill run and shortening paths.
 *
 * Fix pass of 10/4: two shortenings of one stay, on the same real paths — each
 *   credit comes off its own month, and the second never rewrites the first.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { incomeTotals, categoryTotals, incomeEvents } from './incomeBasis'
import {
  STAY_SHORTENED_CREDIT_NOTE, bankShortenedStayOverpayment, syncLeaseWithBookingDates,
} from './bookingLeaseBilling'
import { STAY_DEPOSIT_CREDIT_NOTE, generateMoveInInvoice } from '../jobs/moveInBundle'
import { backfillInvoices } from '../jobs/invoiceGeneration'
import { lockHousehold } from './moneyPredicates'
import { collectedRentMtd } from '../lib/rentCollected'
import { ownerStatement } from './ownerStatement'

// The shortening cancels any open Stripe checkout for the booking.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<any>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))

beforeEach(cleanupAllSchema)
const RATE_NOTE = 'incomeBasisReservationMoney test rate'
afterAll(async () => { await db.query(`DELETE FROM platform_processing_rates WHERE notes = $1`, [RATE_NOTE]) })

const cents = (n: number) => Math.round(n * 100) / 100
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10)

async function atDate<T>(ymd: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${ymd}T18:00:00Z`))
  try { return await fn() } finally { vi.useRealTimers() }
}

interface R {
  userId: string; landlordId: string; tenantId: string; propertyId: string; unitId: string
  leaseId: string; bookingId: string; rent: number; start: string
}

/** A lease drafted from a reservation whose deposit was paid on the booking site. */
async function reservationLease(o: {
  start: string; end: string; rent: number; deposit: number; depositPaidAt: string; total: number
}): Promise<R> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    await c.query(
      `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent,
                                              stripe_cost_flat, stripe_cost_percent, notes)
       SELECT 'ach', 6, 0, 0, 0.5, $1
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach' AND effective_until IS NULL)`,
      [RATE_NOTE])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: o.rent })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: o.rent, startDate: o.start })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const bookingId = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, booked_check_out, guest_name,
                                  guest_email, status, source, deposit_amount, deposit_paid_at, total_amount)
       VALUES ($1,$2,'month_to_month',$3,$4,$4,'Pat Guest','pat@guest.test','confirmed','public',$5,$6::timestamptz,$7)
       RETURNING id`,
      [unitId, landlordId, o.start, o.end, o.deposit, o.depositPaidAt, o.total])).rows[0].id
    await c.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1,'booking_deposit',$2,$3,'Stay deposit',$4::timestamptz)`, [landlordId, bookingId, o.deposit, o.depositPaidAt])
    await c.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, end_date = $3, needs_review = false
        WHERE id = $1`, [leaseId, bookingId, o.end])
    await c.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId, rent: o.rent, start: o.start }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function moveIn(r: R): Promise<void> {
  await generateMoveInInvoice({
    lease_id: r.leaseId, unit_id: r.unitId, tenant_id: r.tenantId, landlord_id: r.landlordId,
    rent_amount: r.rent, start_date: r.start,
  } as any)
}

async function rentRows(r: R): Promise<Array<{ id: string; due: string; amount: number }>> {
  return (await db.query<any>(
    `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due, amount::float AS amount FROM payments
      WHERE lease_id = $1 AND type = 'rent' ORDER BY due_date`, [r.leaseId])).rows
}

async function settleCash(id: string, at: string): Promise<void> {
  await db.query(`UPDATE payments SET status = 'settled', settled_at = $2::timestamptz, manual_method = 'cash' WHERE id = $1`, [id, at])
}

/** Paid-ahead money spent on a bill (the whole-bill or desk path's record). */
async function spend(o: { prepaid: string; paymentId: string; leaseId: string; amount: number; at: string }): Promise<void> {
  await db.query(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
     VALUES ($1,$2,$3,$4, date_trunc('month', $5::timestamptz AT TIME ZONE 'America/Phoenix')::date,
             'whole_bill', 'applied', $5::timestamptz, $5::timestamptz)`,
    [o.prepaid, o.paymentId, o.leaseId, o.amount, o.at])
}

/** The guest's stay is moved to end earlier on the schedule; the sync banks what they paid past it. */
async function leaveEarly(r: R, checkOut: string, today: string): Promise<void> {
  await db.query(`UPDATE unit_bookings SET check_out = $2, booked_check_out = $2 WHERE id = $1`, [r.bookingId, checkOut])
  await atDate(today, () => syncLeaseWithBookingDates(r.bookingId))
}

/** A finalized move-out: a $400 deposit the manager held, $100 of cleaning kept, and paid-ahead money handed back. */
async function moveOut(r: R, o: { at: string; handBack: Array<{ credit: string; amount: number }> }): Promise<void> {
  await db.query(
    `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
     VALUES ($1,$2,$3,400,400,'funded','landlord')`, [r.unitId, r.leaseId, r.tenantId])
  const dr = (await db.query<{ id: string }>(
    `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                  other_deductions, unpaid_balance_amount, total_deductions, gap_amount, status, finalized_at)
     VALUES ($1,$2,$3,400,100,'[]','[]',0,100,0,'sent_refund',$4::timestamptz) RETURNING id`,
    [r.leaseId, r.tenantId, r.landlordId, o.at])).rows[0].id
  for (const h of o.handBack) {
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,$4, date_trunc('month', $5::timestamptz AT TIME ZONE 'America/Phoenix')::date,
               'move_out','applied',$5::timestamptz,$5::timestamptz)`,
      [h.credit, dr, r.leaseId, h.amount, o.at])
  }
}

const tot = (r: { landlordId: string }, basis: 'received' | 'billed', start: string, end: string) =>
  incomeTotals({ landlordIds: [r.landlordId], start, end, basis })
const cat = async (r: { landlordId: string }, basis: 'received' | 'billed', start: string, end: string, c: string) =>
  (await categoryTotals({ landlordIds: [r.landlordId], start, end, basis })).categories.find(x => x.category === c)!
const rentCard = (r: { landlordId: string }, basis: 'received' | 'billed', month: string) =>
  collectedRentMtd([r.landlordId], null, { scope: 'rent', basis, month: `${month}-15` })
const stmt = (r: { landlordId: string }, month: string) => ownerStatement({ landlordId: r.landlordId, periodMonth: month })

/**
 * Review of 10/3 (R6): a $600 site deposit Aug 20; the lease arrives Sep 25,
 * the arrival rent ($190) comes out of the deposit and $410 is kept as credit.
 * October's $950: $410 from that credit and $540 in cash. The guest leaves
 * Oct 5: the sync banks $827.42, anchored to October's bill — $540 of the cash
 * and $287.42 of the leftover.
 */
async function leftoverPaysOctoberThenGuestLeaves(): Promise<R & { leftover: string; shortened: string }> {
  const r = await reservationLease({
    start: '2026-09-25', end: '2027-01-25', rent: 950, deposit: 600, depositPaidAt: '2026-08-20T10:00:00-07:00', total: 4000,
  })
  await moveIn(r)
  const leftover = (await db.query<{ id: string; amount: number; note: string }>(
    `SELECT id, amount_original::float AS amount, note FROM lease_prepaid_credits WHERE lease_id = $1`, [r.leaseId])).rows
  expect(leftover.map(c => ({ amount: c.amount, note: c.note }))).toEqual([{ amount: 410, note: STAY_DEPOSIT_CREDIT_NOTE }])
  await backfillInvoices({ from: '2026-10-01', to: '2026-10-01', leaseId: r.leaseId })
  const oct = (await rentRows(r)).find(p => p.due === '2026-10-01')!
  expect(oct.amount).toBe(950)
  await spend({ prepaid: leftover[0].id, paymentId: oct.id, leaseId: r.leaseId, amount: 410, at: '2026-10-01T10:00:00-07:00' })
  await settleCash(oct.id, '2026-10-01T10:00:00-07:00')
  await leaveEarly(r, '2026-10-05', '2026-10-05')
  const shortened = (await db.query<{ id: string; amount: number; source_payment_id: string }>(
    `SELECT id, amount_original::float AS amount, source_payment_id FROM lease_prepaid_credits
      WHERE lease_id = $1 AND note = $2 AND voided_at IS NULL`, [r.leaseId, STAY_SHORTENED_CREDIT_NOTE])).rows
  expect(shortened.map(c => ({ amount: c.amount, anchor: c.source_payment_id }))).toEqual([{ amount: 827.42, anchor: oct.id }])
  return { ...r, leftover: leftover[0].id, shortened: shortened[0].id }
}

describe('reservation money that came back through a rent bill is still the reservation’s', () => {
  it('the owner statement’s October block reads billed $0 and collected $0 against $540 gross; the landlord’s Money billed is unchanged', async () => {
    const r = await leftoverPaysOctoberThenGuestLeaves()

    const oct = await stmt(r, '2026-10')
    expect(oct.totals.grossCollected).toBe(540)
    expect(oct.totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
    for (const m of ['2026-08', '2026-09', '2026-11']) {
      expect((await stmt(r, m)).totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
    }

    // The landlord's Money billed: the stay nets to the arrival rent in August,
    // October's rent to the four nights stayed — as before.
    const aug = await tot(r, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.lines.registerAndStays).toBe(600)
    expect(aug.lines.movedToCredit).toBe(-410)
    expect(aug.total).toBe(190)
    const bOct = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    expect(bOct.lines.rent).toBe(950)
    expect(bOct.lines.stayShortened).toBe(-827.42)
    expect(bOct.total).toBe(122.58)
    expect(bOct.parts).toMatchObject({ paid: 0, coveredByPaidAhead: 122.58 })
    expect(bOct.beside.collectedSoFar).toBe(122.58)
    expect((await rentCard(r, 'billed', '2026-10')).billed).toEqual({ amount: 122.58, collected: 122.58, clearing: 0, stillOwed: 0 })
    const ev = (await incomeEvents({ landlordIds: [r.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened').map(e => ({ part: e.part, amount: e.amount }))
    expect(ev.sort((x, y) => x.amount - y.amount)).toEqual([
      { part: 'paid', amount: -540 }, { part: 'coveredByPaidAhead', amount: -287.42 },
    ])
  })

  it('handed back at a Nov 3 move-out: the rent card reads −$540 in November (lifetime $0), the stays keep $312.58, the statement’s November gross is −$440 (lifetime +$100), and the totals do not change', async () => {
    const r = await leftoverPaysOctoberThenGuestLeaves()
    await moveOut(r, { at: '2026-11-03T10:00:00-07:00', handBack: [{ credit: r.shortened, amount: 827.42 }] })

    // Money received: the $287.42 of the leftover goes back off the stay, the $540 of cash off rent.
    const nov = await tot(r, 'received', '2026-11-01', '2026-11-30')
    expect(nov.lines.paidAheadRefunded).toBe(-827.42)
    expect(nov.lines.depositDeductions).toBe(100)
    expect((await rentCard(r, 'received', '2026-10')).collected).toBe(540)
    expect((await rentCard(r, 'received', '2026-11')).collected).toBe(-540)
    const novEv = (await incomeEvents({ landlordIds: [r.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'received' }))
      .filter(e => e.line === 'paidAheadRefunded').map(e => ({ category: e.category, amount: e.amount }))
    expect(novEv.sort((x, y) => x.amount - y.amount)).toEqual([
      { category: null, amount: -540 }, { category: 'stays_and_pay_links', amount: -287.42 },
    ])
    const life = await categoryTotals({ landlordIds: [r.landlordId], start: '2026-07-01', end: '2026-12-31', basis: 'received' })
    expect(life.categories.find(c => c.category === 'stays_and_pay_links')!.collected).toBe(312.58)
    expect(life.categories.find(c => c.category === 'space_rent')!.collected).toBe(540)
    expect(life.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 'paidAheadRefunded', amount: -540 }),
      expect.objectContaining({ line: 'depositDeductions', amount: 100 }),
    ]))
    let rentLife = 0
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) rentLife += (await rentCard(r, 'received', m)).collected
    expect(cents(rentLife)).toBe(0)

    // The totals: $600 + $540 paid, $827.42 handed back, $100 kept — both ways.
    expect(life.total).toBe(412.58)
    expect((await tot(r, 'received', '2026-07-01', '2026-12-31')).total).toBe(412.58)
    expect((await tot(r, 'billed', '2026-07-01', '2026-12-31')).total).toBe(412.58)

    // The PM owner statement never counted the reservation: November hands back
    // only the $540 of rent it counted, less the $100 kept.
    const sNov = await stmt(r, '2026-11')
    expect(sNov.totals.grossCollected).toBe(-440)
    expect(sNov.totals.collectedDirectly).toBe(-440)
    let gross = 0
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) gross += (await stmt(r, m)).totals.grossCollected
    expect(cents(gross)).toBe(100)
  })
})

describe('a shortened stay’s credit that paid a bill a second shortening took back keeps its reservation share', () => {
  /**
   * A $500 site deposit Oct 20; the reservation covered the arrival ($103.87)
   * and $396.13 was kept as credit. November's $460: $396.13 of it and $63.87
   * cash. The stay is shortened: $200 banked off November ($63.87 of cash and
   * $136.13 of the leftover). The stay is lengthened again and December's $460
   * is billed: that $200 credit and $260 cash pay it. Shortened again to end
   * Nov 30: all $460 of December is banked. Of the $460, $200 is the first
   * credit's money — and $136.13 of that was the reservation's.
   */
  it('at move-out $136.13 comes back off the stay and $323.87 off rent; rent nets to $0, the stays to $363.87, and the statement to the $100 kept', async () => {
    const r = await reservationLease({
      start: '2026-10-25', end: '2027-02-25', rent: 460, deposit: 500, depositPaidAt: '2026-10-20T10:00:00-07:00', total: 2000,
    })
    const ins = async (amount: number, at: string, createdAt: string, note: string, source: string | null) =>
      (await db.query<{ id: string }>(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                            received_at, created_at, source_payment_id, note)
         VALUES ($1,$2,$3,$3,'reclassified',$4::timestamptz,$5::timestamptz,$6,$7) RETURNING id`,
        [r.leaseId, r.tenantId, amount, at, createdAt, source, note])).rows[0].id
    const bill = async (due: string, amount: number) => (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,'landlord') RETURNING id`,
      [r.unitId, r.leaseId, r.tenantId, r.landlordId, amount, due])).rows[0].id

    const leftover = await ins(396.13, '2026-10-20T10:00:00-07:00', '2026-10-25T10:00:00-07:00', STAY_DEPOSIT_CREDIT_NOTE, null)
    const nov = await bill('2026-11-01', 460)
    await spend({ prepaid: leftover, paymentId: nov, leaseId: r.leaseId, amount: 396.13, at: '2026-11-01T10:00:00-07:00' })
    await settleCash(nov, '2026-11-01T10:00:00-07:00')
    const first = await ins(200, '2026-11-01T10:00:00-07:00', '2026-11-10T10:00:00-07:00', STAY_SHORTENED_CREDIT_NOTE, nov)
    const dec = await bill('2026-12-01', 460)
    await spend({ prepaid: first, paymentId: dec, leaseId: r.leaseId, amount: 200, at: '2026-12-01T10:00:00-07:00' })
    await settleCash(dec, '2026-12-01T10:00:00-07:00')
    const second = await ins(460, '2026-12-01T10:00:00-07:00', '2026-12-05T10:00:00-07:00', STAY_SHORTENED_CREDIT_NOTE, dec)
    await moveOut(r, { at: '2026-12-08T10:00:00-07:00', handBack: [{ credit: second, amount: 460 }] })

    const dEv = (await incomeEvents({ landlordIds: [r.landlordId], start: '2026-12-01', end: '2026-12-31', basis: 'received' }))
      .filter(e => e.line === 'paidAheadRefunded').map(e => ({ category: e.category, amount: e.amount }))
    expect(dEv.sort((x, y) => x.amount - y.amount)).toEqual([
      { category: null, amount: -323.87 }, { category: 'stays_and_pay_links', amount: -136.13 },
    ])
    let rentLife = 0
    for (const m of ['2026-10', '2026-11', '2026-12']) rentLife += (await rentCard(r, 'received', m)).collected
    expect(cents(rentLife)).toBe(0)
    expect((await cat(r, 'received', '2026-10-01', '2026-12-31', 'stays_and_pay_links')).collected).toBe(363.87)

    // Money billed is as before: the stay nets to the arrival, November to its kept nights, December to $0.
    expect((await tot(r, 'billed', '2026-10-01', '2026-10-31')).total).toBe(103.87)
    expect((await tot(r, 'billed', '2026-11-01', '2026-11-30')).total).toBe(260)
    expect((await tot(r, 'billed', '2026-12-01', '2026-12-31')).total).toBe(100)
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(r, basis, '2026-10-01', '2026-12-31')).total).toBe(463.87)
    }

    // The statement: no reservation money in any block, and the year nets to the $100 kept.
    expect((await stmt(r, '2026-11')).totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
    expect((await stmt(r, '2026-12')).totals.billed).toEqual({ billed: 100, collectedSoFar: 100, clearing: 0, stillOwed: 0 })
    let gross = 0
    for (const m of ['2026-10', '2026-11', '2026-12']) gross += (await stmt(r, m)).totals.grossCollected
    expect(cents(gross)).toBe(100)
  })
})

describe('reservation money moved to credit comes off the reservation’s own payments, newest first', () => {
  /** A $40 link toward the reservation, sent `sentAt`, paid `paidAt` (what settleLinkBooking records). */
  async function linkTowardReservation(r: R, o: { amount: number; sentAt: string; paidAt: string; depositNow: number }): Promise<void> {
    const link = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                  tax_amount, total, customer_email, status, booking_id, created_at)
       VALUES ('tok-'||md5(random()::text), $1, $2, $3, 'one_time', 'Reservation', '[]', $4, 0, 0, $4, 'pat@guest.test', 'paid', $5,
               $6::timestamptz) RETURNING id`,
      [r.landlordId, r.propertyId, r.userId, o.amount, r.bookingId, o.sentAt])).rows[0].id
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, discount_amount, tax_amount,
                                     surcharge, total, status, property_id, created_at, pay_link_id)
       VALUES ($1,$2,'card',$3,0,0,0,$3,'completed',$4,$5::timestamptz,$6) RETURNING id`,
      [r.landlordId, r.userId, o.amount, r.propertyId, o.paidAt, link])).rows[0].id
    await db.query(`UPDATE unit_bookings SET deposit_amount = $2, pos_transaction_id = $3 WHERE id = $1`,
      [r.bookingId, o.depositNow, sale])
  }

  it('a $500 site deposit in August and a $40 link in September: the $445 left over comes off September’s $40 and then August’s deposit — September $0, August $95, no month below $0', async () => {
    const r = await reservationLease({
      start: '2026-09-28', end: '2027-01-28', rent: 950, deposit: 500, depositPaidAt: '2026-08-20T10:00:00-07:00', total: 4000,
    })
    await linkTowardReservation(r, { amount: 40, sentAt: '2026-09-05T10:00:00-07:00', paidAt: '2026-09-06T10:00:00-07:00', depositNow: 540 })
    await moveIn(r)
    const credits = (await db.query<{ amount: number }>(
      `SELECT amount_original::float AS amount FROM lease_prepaid_credits WHERE lease_id = $1`, [r.leaseId])).rows
    expect(credits).toEqual([{ amount: 445 }])

    const aug = await tot(r, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.lines.registerAndStays).toBe(500)
    expect(aug.lines.movedToCredit).toBe(-405)
    expect(aug.total).toBe(95)
    const sep = await tot(r, 'billed', '2026-09-01', '2026-09-30')
    expect(sep.lines.registerAndStays).toBe(40)
    expect(sep.lines.movedToCredit).toBe(-40)
    expect(sep.total).toBe(0)
    expect(sep.beside.collectedSoFar).toBe(0)
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      const s = await cat(r, 'billed', `${m}-01`, lastDay(m), 'stays_and_pay_links')
      expect(s.billed).toBeGreaterThanOrEqual(0)
      expect(s.collected).toBeGreaterThanOrEqual(0)
    }
    // The total is unchanged: $540 paid toward the reservation less the $445 moved to credit.
    expect((await tot(r, 'billed', '2026-08-01', '2026-09-30')).total).toBe(95)
  })

  it('a shortened stay’s reservation part comes off the same way: the $100 link sent in August first, the rest off July’s site deposit', async () => {
    // A $500 site deposit Jul 20 and a $100 link sent Aug 1 (paid Aug 2). The
    // arrival rent (Aug 10–31, $674.19) less the $600 is $74.19, paid in cash.
    // The guest leaves Aug 12 (two nights, $61.29): $612.90 is banked — $74.19
    // of rent and $538.71 of the reservation.
    const r = await reservationLease({
      start: '2026-08-10', end: '2027-01-28', rent: 950, deposit: 500, depositPaidAt: '2026-07-20T10:00:00-07:00', total: 5000,
    })
    await linkTowardReservation(r, { amount: 100, sentAt: '2026-08-01T10:00:00-07:00', paidAt: '2026-08-02T10:00:00-07:00', depositNow: 600 })
    const arrival = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             settled_at, manual_method, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',74.19,'settled','RENT','2026-08-10','2026-08-10T10:00:00-07:00','cash','landlord') RETURNING id`,
      [r.unitId, r.leaseId, r.tenantId, r.landlordId])).rows[0].id
    const c = await getClient()
    let banked = 0
    try {
      await c.query('BEGIN')
      await lockHousehold(c, r.tenantId, r.landlordId)
      await c.query(`UPDATE leases SET end_date = '2026-08-12' WHERE id = $1`, [r.leaseId])
      banked = await bankShortenedStayOverpayment(c, r.leaseId)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect(banked).toBe(612.9)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE source_payment_id = $1`, [arrival])).rowCount).toBe(1)

    const jul = await tot(r, 'billed', '2026-07-01', '2026-07-31')
    expect(jul.lines.registerAndStays).toBe(500)
    expect(jul.lines.movedToCredit).toBe(-438.71)
    expect(jul.total).toBe(61.29)
    const aug = await tot(r, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.lines.registerAndStays).toBe(100)
    expect(aug.lines.movedToCredit).toBe(-100)
    expect(aug.lines.stayShortened).toBe(-74.19)
    expect(aug.total).toBe(0)
    expect((await tot(r, 'billed', '2026-07-01', '2026-08-31')).total).toBe(61.29)
    expect((await cat(r, 'billed', '2026-07-01', '2026-08-31', 'stays_and_pay_links')).billed).toBe(61.29)
  })
})

/**
 * Review of 10/4: two shortenings of one stay, on the real paths. A $930/month
 * lease drafted from a reservation; October paid in cash. The guest leaves
 * Oct 16: $480 banked against October (credit A), and the final $50 water bill
 * is paid from it. The guest comes back (the stay runs to Jan 1 again): A is in
 * use, so the rest of October ($480) is billed instead of withdrawing it; that
 * row and November are paid in cash. The guest leaves Nov 10: $651 banked
 * against November (credit B). A's take-back stays on October and B's comes
 * off November — the credits were pooled and taken off the newest anchor first,
 * which read October $1,259 and November $0, and rewrote October when B was made.
 */
describe('two shortenings of one stay each come off their own month', () => {
  it('shorten, pay the final water bill from the credit, lengthen, pay, shorten again: October reads $980 and November $279, and October is not rewritten', async () => {
    const c = await getClient()
    let r!: R
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 930 })
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 930, startDate: '2026-10-01' })
      await seedLeaseTenant(c, { leaseId, tenantId })
      const bookingId = (await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, booked_check_out, guest_name,
                                    guest_email, status, source, total_amount)
         VALUES ($1,$2,'month_to_month','2026-10-01','2027-01-01','2027-01-01','Pat Guest','pat@guest.test','confirmed','admin',2790)
         RETURNING id`, [unitId, landlordId])).rows[0].id
      await c.query(
        `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, end_date = '2027-01-01', needs_review = false
          WHERE id = $1`, [leaseId, bookingId])
      await c.query('COMMIT')
      r = { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId, rent: 930, start: '2026-10-01' }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    await moveIn(r)
    const octRow = (await rentRows(r)).find(p => p.due === '2026-10-01')!
    expect(octRow.amount).toBe(930)
    await settleCash(octRow.id, '2026-10-01T10:00:00-07:00')
    const credits = async () => (await db.query<{ id: string; amount: number; anchor: string | null }>(
      `SELECT id, amount_original::float AS amount, source_payment_id AS anchor FROM lease_prepaid_credits
        WHERE lease_id = $1 AND voided_at IS NULL ORDER BY created_at, id`, [r.leaseId])).rows

    // Oct 16: the guest leaves; October's 16 nights paid past the new end are banked.
    await leaveEarly(r, '2026-10-16', '2026-10-16')
    const [a] = await credits()
    expect(a).toMatchObject({ amount: 480, anchor: octRow.id })
    // The final water bill, paid from that credit.
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, revenue_owner)
       VALUES ($1,$2,$3,$4,'utility',50,'pending','UTILITY','2026-10-16','landlord') RETURNING id`,
      [r.unitId, r.leaseId, r.tenantId, r.landlordId])).rows[0].id
    await spend({ prepaid: a.id, paymentId: water, leaseId: r.leaseId, amount: 50, at: '2026-10-17T10:00:00-07:00' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-17T10:00:00-07:00' WHERE id = $1`, [water])

    // Oct 25: the guest comes back; the stay runs to Jan 1 again. The credit is
    // in use, so the rest of October is billed; November is billed by the run.
    await db.query(`UPDATE unit_bookings SET check_out = '2027-01-01', booked_check_out = '2027-01-01' WHERE id = $1`, [r.bookingId])
    await atDate('2026-10-25', () => syncLeaseWithBookingDates(r.bookingId))
    await atDate('2026-11-01', () => backfillInvoices({ from: '2026-11-01', to: '2026-11-01', leaseId: r.leaseId }))
    const rows = await rentRows(r)
    expect(rows.map(p => ({ due: p.due, amount: p.amount }))).toEqual([
      { due: '2026-10-01', amount: 930 }, { due: '2026-10-01', amount: 480 }, { due: '2026-11-01', amount: 930 },
    ])
    for (const p of rows.filter(p => p.id !== octRow.id)) await settleCash(p.id, `${p.due}T10:00:00-07:00`)
    const novRow = rows.find(p => p.due === '2026-11-01')!
    const octBefore = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    expect(octBefore.total).toBe(980)

    // Nov 10: the guest leaves again; 21 of November's 30 nights are banked.
    await leaveEarly(r, '2026-11-10', '2026-11-10')
    const live = await credits()
    expect(live.map(x => ({ amount: x.amount, anchor: x.anchor }))).toEqual([
      { amount: 480, anchor: octRow.id }, { amount: 651, anchor: novRow.id },
    ])

    // October: $930 + $480 rent + $50 water, less A's $480. November: $930 less B's $651 (9 nights).
    const oct = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    const nov = await tot(r, 'billed', '2026-11-01', '2026-11-30')
    expect(oct.total).toBe(980)
    expect(oct.lines.stayShortened).toBe(-480)
    expect(oct.total).toBe(octBefore.total)
    expect(nov.total).toBe(279)
    expect(nov.lines.stayShortened).toBe(-651)
    for (const t of [oct, nov]) {
      expect(cents(Object.values(t.parts).reduce((s, v) => s + v, 0))).toBe(t.total)
      expect(t.beside.collectedSoFar).toBe(t.total)
    }
    const ev = (await incomeEvents({ landlordIds: [r.landlordId], start: '2026-10-01', end: '2026-12-31', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened').map(e => ({ paymentId: e.paymentId, day: e.day, amount: e.amount }))
      .sort((x, y) => x.day.localeCompare(y.day))
    expect(ev).toEqual([
      { paymentId: octRow.id, day: '2026-10-01', amount: -480 },
      { paymentId: novRow.id, day: '2026-11-01', amount: -651 },
    ])
    // The rent card: October's two rent rows less A, November less B.
    expect((await rentCard(r, 'billed', '2026-10')).billed).toEqual({ amount: 930, collected: 930, clearing: 0, stillOwed: 0 })
    expect((await rentCard(r, 'billed', '2026-11')).billed).toEqual({ amount: 279, collected: 279, clearing: 0, stillOwed: 0 })

    // The totals are what they were: Money billed's months add up to the same
    // $1,259 (the $1,081 of credit not used yet is paid ahead), and Money
    // received counts the $2,340 of cash on the days it arrived.
    expect((await tot(r, 'billed', '2026-09-01', '2026-12-31')).total).toBe(1259)
    expect(cents(oct.total + nov.total)).toBe(1259)
    const rx = await tot(r, 'received', '2026-09-01', '2026-12-31')
    expect(rx.total).toBe(2340)
    expect(rx.lines.stayShortened ?? 0).toBe(0)
  })
})

/**
 * Fix pass 1 of 10/4 (review cont-verify:reports-2), on the real paths. A $930
 * stay: October paid; Oct 16 shortened ($480, A, on October); Oct 20 the guest
 * comes back (A unused: withdrawn, nothing re-made); November billed and paid;
 * Nov 10 shortened ($651, B, on November); Nov 12 the end corrected to Nov 5
 * ($155, C, no anchor: November is taken by B). C took A's October anchor, so
 * October read $775 and November $279 — a November event rewrote October.
 */
/** A $930 month-to-month lease drafted from an admin booking (no reservation money), on the real paths. */
async function bookingLease(o: { start: string; end: string; total: number }): Promise<R> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 930 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 930, startDate: o.start })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const bookingId = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, booked_check_out, guest_name,
                                  guest_email, status, source, total_amount)
       VALUES ($1,$2,'month_to_month',$3,$4,$4,'Pat Guest','pat@guest.test','confirmed','admin',$5)
       RETURNING id`, [unitId, landlordId, o.start, o.end, o.total])).rows[0].id
    await c.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, end_date = $3, needs_review = false
        WHERE id = $1`, [leaseId, bookingId, o.end])
    await c.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId, rent: 930, start: o.start }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const leaseCredits = async (r: R) => (await db.query<{ amount: number; anchor: string | null; voided: boolean }>(
  `SELECT amount_original::float AS amount, source_payment_id AS anchor, voided_at IS NOT NULL AS voided
     FROM lease_prepaid_credits WHERE lease_id = $1 ORDER BY created_at, id`, [r.leaseId])).rows

// Production settle times carry microseconds (settled_at = NOW()); a credit's
// received_at is copied from its bill's settled_at through a JS Date, which
// keeps whole milliseconds only. Each real-path test runs both ways, so a
// whole-second fixture can never hide that.
const SETTLE_TIMES = [
  { label: 'whole seconds', oct: '2026-10-01T10:00:00-07:00', nov: '2026-11-01T10:00:00-07:00' },
  { label: 'microseconds', oct: '2026-10-01T10:00:00.123456-07:00', nov: '2026-11-01T10:00:00.654321-07:00' },
]

describe('a later shortening’s credit with no anchor never takes the month of a credit withdrawn earlier', () => {
  it.each(SETTLE_TIMES.map(t => [t.label, t] as const))('shorten, come back, pay November, shorten, correct the end earlier: October reads $930 and November $124, and October is not rewritten (rent settled to the %s)', async (_label, at) => {
    const r = await bookingLease({ start: '2026-10-01', end: '2027-01-01', total: 2790 })

    await moveIn(r)
    const octRow = (await rentRows(r)).find(p => p.due === '2026-10-01')!
    await settleCash(octRow.id, at.oct)
    const credits = () => leaseCredits(r)

    await leaveEarly(r, '2026-10-16', '2026-10-16')
    // Oct 20: the guest comes back; the unused credit is withdrawn and nothing is re-made.
    await leaveEarly(r, '2027-01-01', '2026-10-20')
    expect(await credits()).toEqual([{ amount: 480, anchor: octRow.id, voided: true }])
    await atDate('2026-11-01', () => backfillInvoices({ from: '2026-11-01', to: '2026-11-01', leaseId: r.leaseId }))
    const novRow = (await rentRows(r)).find(p => p.due === '2026-11-01')!
    await settleCash(novRow.id, at.nov)
    await leaveEarly(r, '2026-11-10', '2026-11-10')
    const octBefore = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    expect(octBefore.total).toBe(930)

    // Nov 12: the end corrected to Nov 5; 5 more of November's nights banked with no anchor.
    await leaveEarly(r, '2026-11-05', '2026-11-12')
    expect((await credits()).filter(x => !x.voided)).toEqual([
      { amount: 651, anchor: novRow.id, voided: false }, { amount: 155, anchor: null, voided: false },
    ])

    const oct = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    const nov = await tot(r, 'billed', '2026-11-01', '2026-11-30')
    expect(oct.total).toBe(930)
    expect(oct.total).toBe(octBefore.total)
    expect(nov.total).toBe(124)
    expect(nov.lines.stayShortened).toBe(-806)
    expect((await rentCard(r, 'billed', '2026-10')).billed.amount).toBe(930)
    expect((await rentCard(r, 'billed', '2026-11')).billed.amount).toBe(124)
    // The lifetime is what it was: billed $1,054, received the $1,860 of cash.
    expect((await tot(r, 'billed', '2026-09-01', '2026-12-31')).total).toBe(1054)
    expect((await tot(r, 'received', '2026-09-01', '2026-12-31')).total).toBe(1860)
  })
})

/**
 * Fix pass 2 of 10/4: a $930 stay from Nov 1 with no reservation; November paid.
 * Nov 20 shortened to end Nov 20 ($341, on November). Nov 22 the end corrected
 * to Nov 15 ($155 more, no anchor: November anchors the first). With rent
 * settled to the microsecond, the second credit's received_at (copied through
 * a JS Date, whole milliseconds) fell a fraction of a millisecond before the
 * bill it came from, so it found no bill and was read as reservation money on
 * a lease with no reservation: November, the rent card and the owner
 * statement read $589 for $434.
 */
describe('a credit with no anchor finds the bill its money came from when rent settled to the microsecond', () => {
  it.each(SETTLE_TIMES.map(t => [t.label, t] as const))('pay November, shorten, correct the end earlier: Money billed, the rent card and the owner statement all read $434 for November (rent settled to the %s)', async (_label, at) => {
    const r = await bookingLease({ start: '2026-11-01', end: '2027-01-01', total: 1860 })
    await moveIn(r)
    const novRow = (await rentRows(r)).find(p => p.due === '2026-11-01')!
    expect(novRow.amount).toBe(930)
    await settleCash(novRow.id, at.nov)

    await leaveEarly(r, '2026-11-20', '2026-11-20')
    await leaveEarly(r, '2026-11-15', '2026-11-22')
    expect((await leaseCredits(r)).filter(x => !x.voided)).toEqual([
      { amount: 341, anchor: novRow.id, voided: false }, { amount: 155, anchor: null, voided: false },
    ])

    const nov = await tot(r, 'billed', '2026-11-01', '2026-11-30')
    expect(nov.total).toBe(434)
    expect(nov.lines.stayShortened).toBe(-496)
    expect(nov.lines.movedToCredit ?? 0).toBe(0)
    expect((await rentCard(r, 'billed', '2026-11')).billed.amount).toBe(434)
    expect((await stmt(r, '2026-11')).totals.billed.billed).toBe(434)
    // Nothing lands in October, a month the lease never billed.
    expect((await tot(r, 'billed', '2026-10-01', '2026-10-31')).total).toBe(0)
  })
})

/**
 * Fix pass 1 of 10/4: a reservation lease ($600 site deposit, $356.13 left over
 * after the arrival rent moved to credit). November's card rent paid Nov 1 is
 * disputed in full Nov 10 (reopened, owed again). On Nov 12 $44.87 more of the
 * reservation is banked with no anchor (no settled rent to anchor to). It was
 * bounded by the disputed November bill, so November read "Stay shortened"
 * −$44.87 and the rent card $415.13 for $460, and October "Moved to credit"
 * −$356.13 for −$401.
 */
describe('a credit with no anchor whose only rent bill was disputed', () => {
  it('a credit with no anchor whose only rent bill was disputed is the reservation’s money: the rent card keeps the reopened bill in full', async () => {
    const r = await reservationLease({
      start: '2026-10-25', end: '2026-12-20', rent: 460, deposit: 600, depositPaidAt: '2026-10-20T10:00:00-07:00', total: 600,
    })
    const nov = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             revenue_owner, settled_at, stripe_charge_id)
       VALUES ($1,$2,$3,$4,'rent',460,'settled','RENT','2026-11-01','landlord','2026-11-01T10:00:00-07:00','ch_s2')
       RETURNING id`, [r.unitId, r.leaseId, r.tenantId, r.landlordId])).rows[0].id
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',460,'evt_'||md5(random()::text),'{}'::jsonb,'2026-11-10T10:00:00-07:00') RETURNING id`,
      [nov, r.landlordId, r.tenantId, r.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned', return_code = 'card_dispute' WHERE id = $1`, [nov])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             notes, reversal_id, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT','2026-11-01','Reopened after payment reversal',$5,'landlord')`,
      [r.unitId, r.leaseId, r.tenantId, r.landlordId, rev])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at, note)
       VALUES ($1,$2,356.13,356.13,'reclassified','2026-10-20T10:00:00-07:00','2026-10-25T10:00:00-07:00',$3)`,
      [r.leaseId, r.tenantId, STAY_DEPOSIT_CREDIT_NOTE])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at, note)
       VALUES ($1,$2,44.87,44.87,'reclassified','2026-11-12T10:00:00-07:00','2026-11-12T10:00:00-07:00',$3)`,
      [r.leaseId, r.tenantId, STAY_SHORTENED_CREDIT_NOTE])

    const nov2 = await tot(r, 'billed', '2026-11-01', '2026-11-30')
    const oct = await tot(r, 'billed', '2026-10-01', '2026-10-31')
    expect(nov2.lines.stayShortened ?? 0).toBe(0)
    expect(nov2.parts.stillOwed).toBe(460)
    expect(oct.lines.movedToCredit).toBe(-401)
    expect((await rentCard(r, 'billed', '2026-11')).billed.amount).toBe(460)
  })
})
