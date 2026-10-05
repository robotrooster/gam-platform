/**
 * S548 — calendar-aligned billing for booking-sourced leases.
 *
 * The guest's quote (computeMonthlyStaySchedule) IS the invoice plan:
 * prorated arrival month via the move-in invoice, flat monthly on the
 * 1st, prorated final month, and Master Schedule date changes flow into
 * the lease (dates follow, no-longer-owed pending rent drops, overpaid
 * rent banks as a lease_prepaid_credit).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { backfillInvoices } from './invoiceGeneration'
import { generateMoveInInvoice } from './moveInBundle'
import {
  bookingRentForDueDate, syncLeaseWithBookingDates, bankShortenedStayOverpayment, bankShortenedStaysAfterSettle,
  STAY_SHORTENED_CREDIT_NOTE,
} from '../services/bookingLeaseBilling'
import { applyCredit, applyHeldForRemittance, holdCredit, householdQuote, settleWholeBillIfCovered } from '../services/creditUse'
import { incomeTotals } from '../services/incomeBasis'
import { consumePrepaidCreditForInvoice } from '../services/prepaidRelease'

// S655: a superseded bank retry is canceled at Stripe after the shortening commits.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))
import { generateBillsForMeter } from '../services/utilityBilling'
import { seedUtilityMeter } from '../test/dbHelpers'
import { todayIn } from '../lib/timezone'

beforeEach(async () => { await cleanupAllSchema(); stripeCancel.mockClear() })

// The ACH rate seedStack adds when none is active; removed when the file ends.
const SUITE_RATE_NOTE = 'bookingLeaseBilling.test suite rate'
afterAll(async () => {
  await db.query(`DELETE FROM platform_processing_rates WHERE notes = $1`, [SUITE_RATE_NOTE])
})

// Stay used throughout: Aug 10 2026 → Jan 28 2027 (exclusive), $950/mo.
// Schedule: Aug 10→Sep 1 22n $696.67 · Sep/Oct/Nov/Dec flat $950 · Jan 1→28 27n $855.
const START = '2026-08-10'
const END   = '2027-01-28'
const RENT  = 950

async function seedStack(opts: { bookingSourced?: boolean } = {}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // S609: prepaid credit is only consumed if the landlord's share of it can
    // actually be booked — the release refuses to settle a tenant's bill with
    // money it cannot hand over. So the property needs a payout configuration.
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    // Rates are reference data cleanupAllSchema leaves alone. Seed one only
    // when no ACH rate is active, tagged, and removed in afterAll: left behind,
    // this flat $6 row became the active ACH rate for every suite after this
    // one (webhooks.test seeds its 1% rate with ON CONFLICT DO NOTHING), and
    // their fee expectations passed or failed by file order.
    await client.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent, notes)
       SELECT 'ach', 6, 0, 0, 0.5, $1
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates
                           WHERE payment_method = 'ach' AND effective_until IS NULL)`,
      [SUITE_RATE_NOTE])
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: RENT, startDate: START })
    await seedLeaseTenant(client, { leaseId, tenantId })
    let bookingId: string | null = null
    if (opts.bookingSourced !== false) {
      const b = await client.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
         VALUES ($1, $2, 'month_to_month', $3, $4, 171, 'Sched Guest', 'sched-guest@test.dev', 'confirmed', 'public')
         RETURNING id`,
        [unitId, landlordId, START, END])
      bookingId = b.rows[0].id
      await client.query(
        `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date=$3, needs_review=false WHERE id=$1`,
        [leaseId, bookingId, END])
    } else {
      await client.query(`UPDATE leases SET end_date=$2, needs_review=false WHERE id=$1`, [leaseId, END])
    }
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/**
 * Runs `fn` on a given day: what "today" is decides which months the bill run
 * will still write (its catch-up window). Only Date is faked — timers and the
 * database clock are real.
 */
async function atDate<T>(ymd: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${ymd}T18:00:00Z`))
  try { return await fn() } finally { vi.useRealTimers() }
}

async function rentByDueDate(leaseId: string): Promise<Record<string, number>> {
  const rows = await db.query<any>(
    `SELECT to_char(due_date, 'YYYY-MM-DD') AS d, amount::numeric AS a
       FROM payments WHERE lease_id=$1 AND type='rent' ORDER BY due_date`, [leaseId])
  const out: Record<string, number> = {}
  for (const r of rows.rows) out[r.d] = Number(r.a)
  return out
}

describe('bookingRentForDueDate', () => {
  it('segments: prorated arrival, flat months, prorated final, null off-boundary', () => {
    expect(bookingRentForDueDate(START, END, RENT, '2026-08-10')).toBe(674.19)  // 22n × 950/31 — August has 31 days (S649)
    expect(bookingRentForDueDate(START, END, RENT, '2026-09-01')).toBe(950)
    expect(bookingRentForDueDate(START, END, RENT, '2026-10-01')).toBe(950)    // 31-day month still flat
    expect(bookingRentForDueDate(START, END, RENT, '2027-01-01')).toBe(827.42)  // 27n × 950/31 — January has 31 days
    expect(bookingRentForDueDate(START, END, RENT, '2026-09-15')).toBeNull()
  })
})

describe('invoice generation (calendar schedule)', () => {
  it('booking-sourced lease bills flat months + prorated final month', async () => {
    const s = await seedStack()
    const res = await backfillInvoices({ from: '2026-08-01', to: '2027-02-28', leaseId: s.leaseId })
    expect(res.invoicesInserted).toBe(5)   // Sep–Dec 1sts + Jan 1 (arrival rides move-in, not the cron)
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2026-09-01']).toBe(950)
    expect(rents['2026-10-01']).toBe(950)
    expect(rents['2026-11-01']).toBe(950)
    expect(rents['2026-12-01']).toBe(950)
    expect(rents['2027-01-01']).toBe(827.42)  // Jan 1→28 prorated by January's 31 days
  })

  it('regular lease keeps full-rent behavior (no proration)', async () => {
    const s = await seedStack({ bookingSourced: false })
    await backfillInvoices({ from: '2026-08-01', to: '2027-02-28', leaseId: s.leaseId })
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2027-01-01']).toBe(950)  // unchanged: full rent even in the final month
  })
})

describe('move-in invoice (arrival month)', () => {
  it('booking-sourced lease prorates arrival by the days in the month', async () => {
    const s = await seedStack()
    const r = await generateMoveInInvoice({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: RENT, start_date: START,
    } as any)
    expect(r.rentAmount).toBe(674.19)      // 22 nights × 950/31 — matches the quote
  })

  it('regular lease keeps days-in-month proration', async () => {
    const s = await seedStack({ bookingSourced: false })
    const r = await generateMoveInInvoice({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: RENT, start_date: START,
    } as any)
    expect(r.rentAmount).toBe(674.19)      // 950 × 22/31 — long-standing behavior
  })
})

describe('Master Schedule → lease sync', () => {
  it('pending draft simply follows the booking dates', async () => {
    const s = await seedStack()
    await db.query(`UPDATE leases SET status='pending' WHERE id=$1`, [s.leaseId])
    await db.query(`UPDATE unit_bookings SET check_in='2026-08-12', check_out='2026-12-15' WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    const l = await db.query<any>(
      `SELECT to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0]).toEqual({ s: '2026-08-12', e: '2026-12-15' })
  })

  it('active lease shortened: end moves, dropped pending rent, overpayment → prepaid credit', async () => {
    const s = await seedStack()
    // Guest has PAID arrival (696.67) + September (950) = 1646.67 settled;
    // October's 950 is still pending on an invoice.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01'),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-10-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])

    // Working-class reality (Nic): they paid the month, then find out
    // they're leaving at week 3 — Sep 20 instead of Jan 28.
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    const l = await db.query<any>(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0].e).toBe('2026-09-20')

    // October's pending rent is gone; settled rows untouched.
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2026-10-01']).toBeUndefined()
    expect(rents['2026-09-01']).toBe(950)

    // Owed now: 674.19 (arrival, 22n × 950/31) + 19n × 950/30 (September) = 601.67 → 1275.86.
    // Settled 1646.67 → credit 370.81, banked for the final bill.
    const credit = await db.query<any>(
      `SELECT amount_original::numeric AS a, amount_remaining::numeric AS r, funded_by, source_payment_id, note
         FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toHaveLength(1)
    expect(Number(credit.rows[0].a)).toBe(370.81)
    expect(Number(credit.rows[0].r)).toBe(370.81)
    // S655: rent already paid and already counted — never paid out again — and
    // anchored to the row it reclassifies (the latest settled rent).
    expect(credit.rows[0].funded_by).toBe('reclassified')
    const sep = await db.query<any>(`SELECT id FROM payments WHERE lease_id=$1 AND due_date='2026-09-01'`, [s.leaseId])
    expect(credit.rows[0].source_payment_id).toBe(sep.rows[0].id)
    expect(credit.rows[0].note).toMatch(/Stay shortened/)
  })

  it('a shortened stay banks reclassified money from settled rent only, net of issued credit', async () => {
    const s = await seedStack()
    const ids = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-09-01')
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
    const sepId = ids.find(r => r.d === '2026-09-01')!.id
    // The landlord's $100 move-in special paid part of September; the guest paid the rest.
    const tc = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await applyCredit(c, [{ creditKind: 'issued', creditId: tc.rows[0].id, paymentId: sepId, leaseId: s.leaseId, amount: 100, billingMonth: '2026-09-01' }], { source: 'desk' })
      await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [sepId])
      await c.query('COMMIT')
    } finally { c.release() }

    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Money received: 696.67 + (950 − 100 issued) = 1546.67. Owed now 1275.86. Over: 270.81.
    const credit = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 270.81, funded_by: 'reclassified' }])
  })

  // Landlord credit that paid a month the stay still has paid that month: the
  // guest's money owes only the rest of it. Counting the credit as unpaid while
  // still asking the month's whole rent took $100 of the guest's own money.
  it('landlord credit spent on a month still in the stay never comes out of the money banked for a month the stay lost', async () => {
    const s = await seedStack()
    const ids = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-09-01', NULL),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now()),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-11-01', NULL)
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
    const sepId = ids.find(r => r.d === '2026-09-01')!.id
    // The landlord's $100 credit paid part of September; the guest paid $850 cash.
    const tc = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await applyCredit(c, [{ creditKind: 'issued', creditId: tc.rows[0].id, paymentId: sepId, leaseId: s.leaseId, amount: 100, billingMonth: '2026-09-01' }], { source: 'desk' })
      await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [sepId])
      await c.query('COMMIT')
    } finally { c.release() }

    // Now ends October 1: the stay keeps August and all of September and loses October.
    await db.query(`UPDATE unit_bookings SET check_out='2026-10-01', nights=52 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Owed now 674.19 + 950 = 1624.19, $100 of it paid by the landlord's credit.
    // Money: 674.19 + 850 + 950 = 2474.19 for $1,524.19 still the guest's: October's $950 is over.
    const credit = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 950, funded_by: 'reclassified' }])
    // The credit stays spent on September; nothing of it comes back here.
    expect(Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [tc.rows[0].id])).rows[0].amount_remaining)).toBe(0)
    expect((await rentByDueDate(s.leaseId))['2026-11-01']).toBeUndefined()
  })

  it('landlord credit on a month still in the stay that is not paid yet counts as paid when the money is banked, and again when the rest settles', async () => {
    const s = await seedStack()
    const ids = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-09-01', NULL),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
    const sepId = ids.find(r => r.d === '2026-09-01')!.id
    const tc = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])
    const c = await getClient()
    try {
      await c.query('BEGIN')
      // $100 of September is paid by the landlord's credit; $850 is still open.
      await applyCredit(c, [{ creditKind: 'issued', creditId: tc.rows[0].id, paymentId: sepId, leaseId: s.leaseId, amount: 100, billingMonth: '2026-09-01' }], { source: 'desk' })
      await c.query('COMMIT')
    } finally { c.release() }

    await db.query(`UPDATE unit_bookings SET check_out='2026-10-01', nights=52 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Money 674.19 + 950 = 1624.19 against $1,524.19 the guest still owes the
    // stay (September's $850 open is netted, as unpaid rent always is): $100 over.
    const credits = async () => (await db.query<any>(
      `SELECT amount_original::float AS a FROM lease_prepaid_credits WHERE lease_id=$1 AND voided_at IS NULL ORDER BY created_at, id`, [s.leaseId])).rows.map(r => r.a)
    expect(await credits()).toEqual([100])

    // The guest pays September's $850: the rest of October's money is banked then.
    const k = await getClient()
    try {
      await k.query('BEGIN')
      await k.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [sepId])
      expect(await bankShortenedStaysAfterSettle(k, [sepId])).toEqual([
        { leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, amount: 850 },
      ])
      await k.query('COMMIT')
    } finally { k.release() }
    // October's whole $950 came back to the guest; none of it went to pay the landlord's own credit.
    expect(await credits()).toEqual([100, 850])
  })

  // The month the new end cuts: landlord credit on it counts against the cut
  // nights first (the rule the test above this pair pins), and a longer stay
  // must count it the same way, or $100 of the landlord's credit turns into the
  // guest's money paid ahead.
  it('lengthening a cut month part way back counts landlord credit on it the way the shortening did', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      const ids = (await db.query<{ id: string; d: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
                ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-09-01')
         RETURNING id, due_date::text AS d`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
      const sepId = ids.find(r => r.d === '2026-09-01')!.id
      const tc = await db.query<{ id: string }>(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
         VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])
      const c = await getClient()
      try {
        await c.query('BEGIN')
        await applyCredit(c, [{ creditKind: 'issued', creditId: tc.rows[0].id, paymentId: sepId, leaseId: s.leaseId, amount: 100, billingMonth: '2026-09-01' }], { source: 'desk' })
        await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [sepId])
        await c.query('COMMIT')
      } finally { c.release() }
      const credits = async () => (await db.query<any>(
        `SELECT amount_original::float AS a, (voided_at IS NOT NULL) AS voided FROM lease_prepaid_credits WHERE lease_id=$1 ORDER BY created_at, id`, [s.leaseId])).rows

      await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect(await credits()).toEqual([{ a: 270.81, voided: false }])
      // The cut nights took all of the $100 credit: it went back to the guest (decisions #30).
      const issuedLeft = async () => Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [tc.rows[0].id])).rows[0].amount_remaining)
      expect(await issuedLeft()).toBe(100)

      // To September 25: September now owes 24 × 950/30 = $760. Money over:
      // 22.48 on the arrival bill + (850 − 760) on September = $112.48.
      await db.query(`UPDATE unit_bookings SET check_out='2026-09-25', nights=46 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect(await credits()).toEqual([{ a: 270.81, voided: true }, { a: 112.48, voided: false }])
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$158.33 of money paid ahead from when the stay was shortened was taken back')
      // Nothing more is billed: September's own money still pays the longer September.
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(2)
      expect(await issuedLeft()).toBe(100)
    })
  })

  it('rent still clearing at shortening is banked when it settles (the settle-path hook)', async () => {
    const s = await seedStack()
    const rows = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10',NULL),
              ($1,$2,$3,$4,'rent',950,'processing','RENT','2026-09-01','pi_clearing')
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Only money that arrived counts: $696.67 is under the $1,275.86 owed, so nothing yet.
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
    // September stays (money in flight is never deleted).
    expect((await rentByDueDate(s.leaseId))['2026-09-01']).toBe(950)

    // The bank pull clears. The settle path that settled the rows runs the hook
    // with them (here by hand, as the webhook will — Step 10; the credit-only
    // and whole-bill settles already do, see the next test); it banks what is
    // now over, once. settleHooks.afterRowsSettled does NOT run it yet.
    const sep = rows.find(r => r.d === '2026-09-01')!.id
    const arrival = rows.find(r => r.d === '2026-08-10')!.id
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [sep])
      expect(await bankShortenedStaysAfterSettle(c, [sep])).toEqual([
        { leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, amount: 370.81 },
      ])
      expect(await bankShortenedStaysAfterSettle(c, [sep, arrival])).toEqual([])     // once
      expect(await bankShortenedStayOverpayment(c, s.leaseId)).toBe(0)
      await c.query('COMMIT')
    } finally { c.release() }
    const credit = await db.query<any>(`SELECT amount_original::float AS a, source_payment_id FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 370.81, source_payment_id: sep }])
  })

  // Money plan Step 2 named this "deleting a pending row with a scheduled retry
  // releases its credit first". S655 review: a row a bank pull bounced on is
  // never deleted — production always has the receipt applied to it
  // (remittance_applications, written the moment the portal or autopay charge
  // covers it), that foreign key has no ON DELETE action, and the delete took
  // the whole edit down: end date unmoved, nothing banked, nobody told. Now the
  // row keeps its history, its retry is still superseded (credit back first,
  // the pull canceled), and the shortening goes through.
  it('a past-end rent row a bank pull bounced on keeps its history: the retry gives its credit back first and is canceled, the end date still moves, and the landlord and GAM are told', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    // October was paid by bank with $50 of credit set aside; the pull bounced and a retry is scheduled.
    const tc = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,50,50,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,900,900,0,'failed','ach','pi_oct_bounced') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    // What rentCharge writes for every row a portal or autopay charge covers.
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 900)`, [rem, oct])
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId: tc, paymentId: oct, leaseId: s.leaseId, amount: 50, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'portal' })
      await c.query(
        `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_oct_bounced', next_retry_at=now() + interval '3 days' WHERE id=$1`, [oct])
      await c.query('COMMIT')
    } finally { c.release() }

    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    // The shortening went through: the end moved and the overpayment was banked.
    const l = await db.query<any>(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0].e).toBe('2026-09-20')
    const credit = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 370.81, funded_by: 'reclassified' }])
    // October keeps its history: still there, failed, no retry scheduled.
    const row = (await db.query<any>(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [oct])).rows[0]
    expect(row).toEqual({ status: 'failed', next_retry_at: null })
    expect((await db.query(`SELECT 1 FROM remittance_applications WHERE payment_id=$1`, [oct])).rowCount).toBe(1)
    // Its credit came back first, and the retry was canceled.
    const use = (await db.query<any>(`SELECT status, release_reason, payment_id FROM credit_uses`)).rows
    expect(use).toEqual([{ status: 'released', release_reason: 'superseded', payment_id: oct }])
    expect(Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [tc])).rows[0].amount_remaining)).toBe(50)
    expect(stripeCancel).toHaveBeenCalledWith('pi_oct_bounced')
    // Both sides are told, by name.
    const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll).toHaveLength(1)
    expect(ll[0].body).toContain('lease end moved to 2026-09-20')
    expect(ll[0].body).toContain('$370.81 of rent already paid past the new end')
    expect(ll[0].body).toContain('$950.00 of unpaid rent due after the new end (October 2026) stays on their account')
    const admin = (await db.query<any>(`SELECT title, body FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].title).toContain('Sched Guest on unit')
    expect(admin[0].body).toContain('October 2026 $950.00 (a card or bank payment on it failed)')
  })

  it('the end date moves and the overpayment is banked even when a past-end row cannot be deleted', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const [oct, nov] = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-10-01'),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-11-01')
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows.sort((a, b) => a.d.localeCompare(b.d)).map(r => r.id)
    // A record the history list does not know points at October (an
    // early-termination request whose fee it was): the database refuses the
    // delete. That row alone stays; nothing else is undone.
    await db.query(
      `INSERT INTO lease_termination_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, fee_amount, fee_basis, fee_payment_id)
       VALUES ($1, $2, $3, $4, 950, 'no_policy', $5)`,
      [s.leaseId, s.tenantId, s.landlordId, s.userId, oct])

    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    const l = await db.query<any>(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0].e).toBe('2026-09-20')
    expect(await rentByDueDate(s.leaseId)).toMatchObject({ '2026-10-01': 950 })
    expect((await rentByDueDate(s.leaseId))['2026-11-01']).toBeUndefined()      // the plain one went
    expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [nov])).rowCount).toBe(0)
    const credit = await db.query<any>(`SELECT amount_original::float AS a FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 370.81 }])
    const admin = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].body).toContain('the delete was refused')
  })

  // S655 review (round 2): the kept row and the banked credit worked against
  // each other. December's bounced bank pull had to stay (it carries history),
  // and the whole-bill check right after the shortening spent the guest's
  // $1,493.45 stay-shortened credit on it — rent for a month they are not
  // staying, while both notices said GAM would clear it with the landlord. The
  // 07:00 bill run and the check before each late fee would have done the same.
  it('a kept past-end rent row is never paid from the banked credit — not after the shortening, not at the bill run', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-11-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    // December's $950 bank pull bounced; a retry is scheduled and the receipt is applied to it.
    const dec = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, next_retry_at)
       VALUES ($1,$2,$3,$4,'rent',950,'failed','RENT','2026-12-01','pi_dec_bounced', now() + interval '3 days') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,950,950,0,'failed','ach','pi_dec_bounced') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 950)`, [rem, dec])

    // The guest leaves October 15.
    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    // Paid $3,546.67; owed now $674.19 + $950 + 14 nights × 950/31 = $2,053.22. Banked: $1,493.45.
    const creditNow = async () => (await db.query<any>(
      `SELECT amount_original::float AS a, amount_remaining::float AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows
    expect(await creditNow()).toEqual([{ a: 1493.45, r: 1493.45 }])
    // December was kept (it carries history) — and NOT paid from that credit.
    const decRow = async () => (await db.query<any>(`SELECT status, next_retry_at, notes FROM payments WHERE id=$1`, [dec])).rows[0]
    expect(await decRow()).toEqual({ status: 'failed', next_retry_at: null, notes: null })
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)

    // The 07:00 bill run, then the check before a late fee: still nothing.
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const run = await consumePrepaidCreditForInvoice(c, { leaseId: s.leaseId, invoiceId: '00000000-0000-4000-8000-000000000000' })
      expect(run).toEqual({ consumed: 0, rowsCovered: 0, releasedToLandlord: 0 })
      const late = await settleWholeBillIfCovered(c, { tenantId: s.tenantId, landlordId: s.landlordId, receipt: false })
      expect(late.settledIds).toEqual([])
      // Nobody is asked for it either: not the portal or autopay (required), not the desk (bank-payable), not credit.
      const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
      const lq = q.leases.find(l => l.leaseId === s.leaseId)!
      expect(lq.requiredIds).toEqual([])
      expect(lq.bankPayableTotal).toBe(0)
      expect(lq.usableCredit).toBe(0)
      expect(lq.pastStayEndRentIds).toEqual([dec])
      expect(lq.pastStayEndRentTotal).toBe(950)
      expect(q.plan).toEqual([])
      await c.query('COMMIT')
    } finally { c.release() }
    expect(await decRow()).toEqual({ status: 'failed', next_retry_at: null, notes: null })
    expect(await creditNow()).toEqual([{ a: 1493.45, r: 1493.45 }])
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)

    // GAM was told once, at the shortening — the whole-bill check did not add a second notice.
    const admin = (await db.query<any>(
      `SELECT category, body FROM admin_notifications WHERE category IN ('stay_shortened_rent_kept','whole_bill_past_stay_end_rent')`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].category).toBe('stay_shortened_rent_kept')
    expect(admin[0].body).toContain('Their account credit is not used on it')
    const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll[0].body).toContain('their account credit is not used on it')
  })

  // S655 review (round 2): one bank pull can carry a month still inside the
  // stay beside one past the new end. Canceling the pull (so nobody pulls rent
  // for a month the guest is not staying) canceled the in-stay month's retry
  // too, and nobody told the tenant their bounce email's retry would not come.
  it('a bank pull carrying a month inside the stay and one past the new end: both retries go, and the tenant is told what is still owed with Pay now', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    // October and November rode one bank pull; it bounced and a retry is scheduled.
    const [oct, nov] = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, next_retry_at)
       VALUES ($1,$2,$3,$4,'rent',950,'failed','RENT','2026-10-01','pi_oct_nov', now() + interval '3 days'),
              ($1,$2,$3,$4,'rent',950,'failed','RENT','2026-11-01','pi_oct_nov', now() + interval '3 days')
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows.sort((a, b) => a.d.localeCompare(b.d)).map(r => r.id)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,1900,1900,0,'failed','ach','pi_oct_nov') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 950), ($1, $3, 950)`, [rem, oct, nov])

    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    // The pull is canceled; neither month will be pulled again.
    expect(stripeCancel).toHaveBeenCalledWith('pi_oct_nov')
    const rows = (await db.query<any>(`SELECT id, status, next_retry_at FROM payments WHERE id = ANY($1::uuid[]) ORDER BY due_date`, [[oct, nov]])).rows
    expect(rows).toEqual([
      { id: oct, status: 'failed', next_retry_at: null },
      { id: nov, status: 'failed', next_retry_at: null },
    ])
    // October is still owed (inside the stay) — only the 14 days of it the
    // guest stays — and payable now; November is kept and asked of nobody.
    expect(Number((await db.query<any>(`SELECT amount FROM payments WHERE id=$1`, [oct])).rows[0].amount)).toBe(429.03)
    const q = await (async () => {
      const c = await getClient()
      try { return await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId }) } finally { c.release() }
    })()
    const lq = q.leases.find(l => l.leaseId === s.leaseId)!
    expect(lq.requiredIds).toEqual([oct])
    expect(lq.requiredTotal).toBe(429.03)
    expect(lq.pastStayEndRentIds).toEqual([nov])

    // The tenant hears why, what is still owed, and gets the Pay now button.
    const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
    const tn = (await db.query<any>(`SELECT title, body, action_url, data FROM notifications WHERE user_id=$1 AND type='stay_shortened_retry_canceled'`, [userId])).rows
    expect(tn).toHaveLength(1)
    expect(tn[0].title).toContain("won't be tried again")
    expect(tn[0].body).toContain('now ends October 15, 2026')
    expect(tn[0].body).toContain('part of it was rent for after your stay ends')
    expect(tn[0].body).toContain("$429.03 is still owed for your stay: Rent, October 2026: $429.03 (was $950.00, changed to match your stay's new dates)")
    expect(tn[0].action_url).toBe('/payments')
    expect(tn[0].data).toMatchObject({ leaseId: s.leaseId, amount: 429.03, paymentIds: [oct] })
    // The landlord's notice names it; so does GAM's.
    const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll).toHaveLength(1)
    expect(ll[0].body).toContain('unpaid rent changed to match the new dates (October 2026 $950.00 → $429.03)')
    expect(ll[0].body).toContain('also carried $429.03 they still owe for the stay (Rent, October 2026 $429.03)')
    expect(ll[0].body).toContain('that retry was canceled with the rest of the pull because the stay changed')
    const admin = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].body).toContain('November 2026 $950.00')
    expect(admin[0].body).toContain('that bank pull also carried $429.03 still owed inside the stay (Rent, October 2026 $429.03)')
  })

  // Wave A review: a stay shortened in the middle of a month nobody has paid
  // yet kept that month's full $950 bill. The guest was asked $950 for 14 days,
  // and once they paid it nothing banked the $520.97 over (decisions #19: an
  // unpaid bill is adjusted).
  async function invoiceFor(s: { landlordId: string; tenantId: string; leaseId: string; unitId: string }, due: string, rent: number, utility: number) {
    return (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7::numeric + $8::numeric) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${due}-${Math.random().toString(36).slice(2, 8)}`, due, rent, utility])).rows[0].id
  }
  const invoiceTotals = async (id: string) => (await db.query<any>(
    `SELECT subtotal_rent::float AS rent, subtotal_utilities::float AS utilities, total_amount::float AS total FROM invoices WHERE id=$1`, [id])).rows[0]

  it("a stay shortened mid-month while that month is unpaid asks only the stay's share of that month", async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    // October's bill (rent + September's water) is open; so is November's
    // (rent + October's water, the final meter read riding it).
    const octInv = await invoiceFor(s, '2026-10-01', 950, 40)
    const novInv = await invoiceFor(s, '2026-11-01', 950, 35)
    const [oct, nov] = (await db.query<{ id: string; d: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',950,'pending','RENT','2026-10-01'),
              ($1,$2,$3,$4,$6,'rent',950,'pending','RENT','2026-11-01')
       RETURNING id, due_date::text AS d`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv, novInv])).rows.sort((a, b) => a.d.localeCompare(b.d)).map(r => r.id)
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'utility',40,'pending','UTILITY','2026-10-01'),
              ($1,$2,$3,$4,$6,'utility',35,'pending','UTILITY','2026-11-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv, novInv])

    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    // October: 14 nights × 950/31 = $429.03, said on the bill. November's rent is gone.
    const octRow = (await db.query<any>(`SELECT amount::float AS a, status, notes FROM payments WHERE id=$1`, [oct])).rows[0]
    expect(octRow.a).toBe(429.03)
    expect(octRow.status).toBe('pending')
    expect(octRow.notes).toBe('Stay now ends October 15, 2026: rent for this date changed from $950.00 to $429.03')
    expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [nov])).rowCount).toBe(0)
    // Both bills follow their rent; each keeps its water.
    expect(await invoiceTotals(octInv)).toEqual({ rent: 429.03, utilities: 40, total: 469.03 })
    expect(await invoiceTotals(novInv)).toEqual({ rent: 0, utilities: 35, total: 35 })

    // The portal, autopay and the desk ask for $429.03 of October, not $950.
    const c = await getClient()
    try {
      const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
      const lq = q.leases.find(l => l.leaseId === s.leaseId)!
      expect(lq.requiredTotal).toBe(504.03)                    // October rent + both waters
      expect(lq.rows.find(r => r.id === oct)?.amount).toBe(429.03)
      expect(lq.pastStayEndRentIds).toEqual([])
    } finally { c.release() }
    // Nothing over was paid, so nothing is banked; nobody was told rent is kept.
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category IN ('stay_shortened_rent_kept','stay_shortened_rent_not_repriced')`)).rowCount).toBe(0)
    // The landlord is told what changed, by month and amount.
    const ll = (await db.query<any>(`SELECT body, data FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll).toHaveLength(1)
    expect(ll[0].body).toContain('unpaid rent changed to match the new dates (October 2026 $950.00 → $429.03); they are asked only for the new amount')
    expect(ll[0].data.repricedRent).toEqual([{ paymentId: oct, dueDate: '2026-10-01', from: 950, to: 429.03 }])

    // Paid in full later: the stay is square, so the settle-path hook banks nothing.
    const c2 = await getClient()
    try {
      await c2.query('BEGIN')
      await c2.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [oct])
      expect(await bankShortenedStaysAfterSettle(c2, [oct])).toEqual([])
      await c2.query('COMMIT')
    } finally { c2.release() }
  })

  it('a re-priced month with a scheduled bank retry: the retry gives its credit back and is canceled, and the tenant is asked for the new amount', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    // October alone rode a bank pull with $50 of credit set aside; it bounced and a retry is scheduled.
    const tc = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,50,50,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,900,900,0,'failed','ach','pi_oct_only') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 900)`, [rem, oct])
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId: tc, paymentId: oct, leaseId: s.leaseId, amount: 50, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'portal' })
      await c.query(
        `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_oct_only', next_retry_at=now() + interval '3 days' WHERE id=$1`, [oct])
      await c.query('COMMIT')
    } finally { c.release() }

    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    // The retry would have pulled $900 for a $429.03 month: it is canceled, its credit back first.
    expect(stripeCancel).toHaveBeenCalledWith('pi_oct_only')
    expect((await db.query<any>(`SELECT amount::float AS a, status, next_retry_at FROM payments WHERE id=$1`, [oct])).rows[0])
      .toEqual({ a: 429.03, status: 'failed', next_retry_at: null })
    expect((await db.query<any>(`SELECT status, release_reason FROM credit_uses`)).rows)
      .toEqual([{ status: 'released', release_reason: 'superseded' }])
    expect(Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [tc])).rows[0].amount_remaining)).toBe(50)
    // The tenant: why, the new amount, and Pay now.
    const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
    const tn = (await db.query<any>(`SELECT body, data FROM notifications WHERE user_id=$1 AND type='stay_shortened_retry_canceled'`, [userId])).rows
    expect(tn).toHaveLength(1)
    expect(tn[0].body).toContain('now ends October 15, 2026, so the rent on the bank payment we were going to try again changed, and that payment was canceled')
    expect(tn[0].body).not.toContain('after your stay ends')
    expect(tn[0].body).toContain("$429.03 is still owed for your stay: Rent, October 2026: $429.03 (was $950.00, changed to match your stay's new dates)")
    expect(tn[0].data).toMatchObject({ amount: 429.03, paymentIds: [oct] })
    // The landlord: the re-price and the canceled retry. GAM: nothing to clear.
    const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll[0].body).toContain('unpaid rent changed to match the new dates (October 2026 $950.00 → $429.03)')
    expect(ll[0].body).toContain('the bank payment GAM was going to try again for that rent was canceled, because it would have pulled the old amount; they have been asked to pay $429.03 now (Rent, October 2026 $429.03)')
    expect(ll[0].body).not.toContain('also carried')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rowCount).toBe(0)
  })

  it('a lengthened stay re-prices an unpaid final month up to the schedule', async () => {
    const s = await seedStack()
    // The stay first ran Aug 10 → Oct 15; October's bill was written for its 14 days.
    await db.query(`UPDATE leases SET end_date='2026-10-15' WHERE id=$1`, [s.leaseId])
    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const octInv = await invoiceFor(s, '2026-10-01', 429.03, 0)
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',429.03,'pending','RENT','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv])).rows[0].id
    // The guest stays on through January 28: October is a whole month again.
    await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
    await syncLeaseWithBookingDates(s.bookingId!)
    expect((await db.query<any>(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])).rows[0].e).toBe(END)
    expect((await db.query<any>(`SELECT amount::float AS a, notes FROM payments WHERE id=$1`, [oct])).rows[0])
      .toEqual({ a: 950, notes: 'Stay now ends January 28, 2027: rent for this date changed from $429.03 to $950.00' })
    expect(await invoiceTotals(octInv)).toEqual({ rent: 950, utilities: 0, total: 950 })
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
  })

  // Wave A cleanup: a stay lengthened after its prorated final month was paid
  // (or while that pull was in flight) billed the added days of that month
  // nowhere. October stayed $429.03 and the bill run only writes November on,
  // so the landlord collected $520.97 less than the lease says.
  it.each([
    ['paid', 'settled', null],
    ['still clearing', 'processing', 'pi_oct_clearing'],
  ])('a stay lengthened after its prorated final month was paid bills the rest of that month (%s)', async (_label, octStatus, octIntent) => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(`UPDATE leases SET end_date='2026-10-15' WHERE id=$1`, [s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now(), NULL),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now(), NULL),
                ($1,$2,$3,$4,'rent',429.03,$5,'RENT','2026-10-01', CASE WHEN $5 = 'settled' THEN now() END, $6)`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId, octStatus, octIntent])

      // The guest stays on through January 28: October is a whole month again.
      await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)

      // The rest of October ($950 − $429.03) is billed on its own line for October.
      const rest = (await db.query<any>(
        `SELECT id, amount::float AS a, status, is_remainder, invoice_id, notes FROM payments
          WHERE lease_id=$1 AND due_date='2026-10-01' AND amount <> 429.03`, [s.leaseId])).rows
      expect(rest).toHaveLength(1)
      expect(rest[0]).toMatchObject({
        a: 520.97, status: 'pending', is_remainder: true, invoice_id: null,
        notes: 'Stay now ends January 28, 2027: the rest of October 2026',
      })
      // November on is the bill run's: nothing else was written, nothing banked.
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1 AND due_date > '2026-10-01'`, [s.leaseId])).rowCount).toBe(0)
      expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
      // The guest is asked for it.
      const c = await getClient()
      try {
        const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
        const lq = q.leases.find(l => l.leaseId === s.leaseId)!
        expect(lq.requiredIds).toEqual([rest[0].id])
        expect(lq.requiredTotal).toBe(520.97)
      } finally { c.release() }
      // Both sides are told.
      const ll = (await db.query<any>(`SELECT body, data FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
      expect(ll).toHaveLength(1)
      expect(ll[0].body).toContain('$520.97 more rent is billed for the longer stay (the rest of October 2026 $520.97) and they have been asked to pay it')
      expect(ll[0].data.longerStayRent).toEqual([{ paymentId: rest[0].id, dueDate: '2026-10-01', amount: 520.97, kind: 'rest_of_month' }])
      const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
      const tn = (await db.query<any>(`SELECT title, body, action_url, data FROM notifications WHERE user_id=$1 AND type='stay_lengthened_rent_billed'`, [userId])).rows
      expect(tn).toHaveLength(1)
      expect(tn[0].body).toContain('now ends January 28, 2027')
      expect(tn[0].body).toContain('$520.97 more rent is owed for your stay: Rent, the rest of October 2026: $520.97')
      expect(tn[0].action_url).toBe('/payments')
      expect(tn[0].data).toMatchObject({ amount: 520.97, paymentIds: [rest[0].id] })

      // November is billed whole by the run; once the rest of October is paid,
      // the stay is square and nothing is banked.
      const c2 = await getClient()
      try {
        await c2.query('BEGIN')
        await c2.query(`UPDATE payments SET status='settled', settled_at=now() WHERE lease_id=$1 AND due_date='2026-10-01'`, [s.leaseId])
        expect(await bankShortenedStaysAfterSettle(c2, [rest[0].id])).toEqual([])
        await c2.query('COMMIT')
      } finally { c2.release() }
    })
  })

  // Wave A cleanup: a stay shortened and then lengthened back kept its "Stay
  // shortened" credit, while the months it came from were owed again — the
  // guest would have had it off later bills the lease says they owe.
  it('shortened then lengthened back: the stay-shortened credit is withdrawn and nothing is owed twice', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      // October paid $950 for 14 nights ($429.03): $520.97 banked.
      const credit = async () => (await db.query<any>(
        `SELECT amount_original::float AS a, amount_remaining::float AS r, (voided_at IS NOT NULL) AS voided, void_reason, source_payment_id
           FROM lease_prepaid_credits WHERE lease_id=$1 ORDER BY created_at, id`, [s.leaseId])).rows
      expect((await credit()).map(c => [c.a, c.voided])).toEqual([[520.97, false]])

      await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)

      // Withdrawn through the ledger: voided with the reason, what was left untouched.
      const after = await credit()
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ a: 520.97, r: 520.97, voided: true })
      expect(after[0].void_reason).toContain('part of the stay again')
      // Nothing is billed twice: October was paid in full; the rest is the run's.
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(3)
      const c = await getClient()
      try {
        const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
        const lq = q.leases.find(l => l.leaseId === s.leaseId)!
        expect(lq.requiredTotal).toBe(0)
        expect(lq.usableCredit).toBe(0)
      } finally { c.release() }
      // The landlord and the guest hear it; GAM has nothing to settle.
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$520.97 of money paid ahead from when the stay was shortened was taken back, because those days are part of the stay again')
      const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
      const tn = (await db.query<any>(`SELECT title, body FROM notifications WHERE user_id=$1 AND type='stay_lengthened_rent_billed'`, [userId])).rows
      expect(tn).toHaveLength(1)
      expect(tn[0].body).toContain('The $520.97 credit you were given when your stay was shortened was taken back')
      expect(tn[0].body).not.toContain('more rent is owed')
      expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category LIKE 'stay_lengthened%'`)).rowCount).toBe(0)

      // Shortened again: banked again, once (the withdrawn credit is not counted).
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await credit()).filter(c => !c.voided).map(c => c.a)).toEqual([520.97])
    })
  })

  it('lengthened part of the way back: only the days owed again come off the stay-shortened credit', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      // Then to October 20: 19 nights × 950/31 = $582.26 owed for October, so
      // $367.74 of the $950 is still over.
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-20', nights=71 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      const credits = (await db.query<any>(
        `SELECT amount_original::float AS a, amount_remaining::float AS r, (voided_at IS NOT NULL) AS voided, funded_by, note
           FROM lease_prepaid_credits WHERE lease_id=$1 ORDER BY created_at, id`, [s.leaseId])).rows
      expect(credits.map(c => [c.a, c.r, c.voided])).toEqual([[520.97, 520.97, true], [367.74, 367.74, false]])
      expect(credits[1]).toMatchObject({ funded_by: 'reclassified', note: STAY_SHORTENED_CREDIT_NOTE })
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(3)
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$153.23 of money paid ahead from when the stay was shortened was taken back')
    })
  })

  it('stay-shortened credit already used when the stay gets longer: the used part is billed, GAM is told, the rest stays to pay with', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      // The September water bill is open; the credit the shortening banks pays it at once.
      const water = (await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,'utility',40,'pending','UTILITY','2026-10-01') RETURNING id`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [water])).rows[0].status).toBe('settled')

      await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)

      // The credit cannot be withdrawn (part of it paid the water): it stays,
      // and the $520.97 it should have given back is billed as October rent.
      const credit = (await db.query<any>(
        `SELECT amount_original::float AS a, amount_remaining::float AS r, voided_at FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows
      expect(credit).toEqual([{ a: 520.97, r: 480.97, voided_at: null }])
      const rest = (await db.query<any>(
        `SELECT id, amount::float AS a, status, is_remainder, notes FROM payments
          WHERE lease_id=$1 AND type='rent' AND due_date='2026-10-01' AND is_remainder`, [s.leaseId])).rows
      expect(rest).toHaveLength(1)
      expect(rest[0]).toMatchObject({ a: 520.97, status: 'pending', notes: 'Stay now ends January 28, 2027: the rest of October 2026' })
      // Net, the guest owes the $40 the water took: $520.97 billed, $480.97 of credit to pay it with.
      const c = await getClient()
      try {
        const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
        const lq = q.leases.find(l => l.leaseId === s.leaseId)!
        expect(lq.requiredTotal).toBe(520.97)
        expect(lq.usableCredit).toBe(480.97)
      } finally { c.release() }
      // GAM is told what could not be taken back.
      const admin = (await db.query<any>(`SELECT title, body FROM admin_notifications WHERE category='stay_lengthened_credit_in_use'`)).rows
      expect(admin).toHaveLength(1)
      expect(admin[0].title).toContain('Sched Guest on unit')
      expect(admin[0].body).toContain('$40.00 of it was already used or is set aside by a payment still clearing, and $480.97 is unused')
      expect(admin[0].body).toContain('So $520.97 was billed to the guest as rent instead (the rest of October 2026 $520.97)')
      const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
      const tn = (await db.query<any>(`SELECT body FROM notifications WHERE user_id=$1 AND type='stay_lengthened_rent_billed'`, [userId])).rows
      expect(tn[0].body).toContain('$520.97 of it is the credit from when your stay was shortened: part of that credit was already used, so it could not simply be taken back. The $480.97 of it you still have can go toward this bill.')
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$520.97 of that is stay-shortened credit that could not be taken back because part of it was already used; they keep the $480.97 still unused to pay with, and GAM has been told')
    })
  })

  // Wave A cleanup: a kept past-end bill (a bank pull bounced on it) that a
  // lengthening brings back inside the stay kept its old amount — $950 asked
  // for 19 nights of November.
  it('a kept past-end month a lengthening brings back is asked at the new schedule amount', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      const nov = (await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',950,'failed','RENT','2026-11-01','pi_nov_bounced') RETURNING id`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
      // The guest says they leave November 1 (October is a whole month): November is kept.
      await db.query(`UPDATE unit_bookings SET check_out='2026-11-01', nights=83 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await db.query<any>(`SELECT amount::float AS a, status FROM payments WHERE id=$1`, [nov])).rows[0]).toEqual({ a: 950, status: 'failed' })

      // To November 20: 19 nights × 950/30 = $601.67.
      await db.query(`UPDATE unit_bookings SET check_out='2026-11-20', nights=102 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await db.query<any>(`SELECT amount::float AS a, status, notes FROM payments WHERE id=$1`, [nov])).rows[0]).toEqual({
        a: 601.67, status: 'failed', notes: 'Stay now ends November 20, 2026: rent for this date changed from $950.00 to $601.67',
      })
      const c = await getClient()
      try {
        const q = await householdQuote(c, { tenantId: s.tenantId, landlordId: s.landlordId })
        const lq = q.leases.find(l => l.leaseId === s.leaseId)!
        expect(lq.pastStayEndRentIds).toEqual([])
        expect(lq.requiredIds).toEqual([nov])
        expect(lq.requiredTotal).toBe(601.67)
      } finally { c.release() }
      // Nothing else billed, nothing banked.
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(4)
      expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
    })
  })

  // A month whose rent the shortening removed while its bill kept other lines:
  // the bill run never writes rent onto a bill that already exists, so the
  // longer stay bills that month itself.
  it('a month whose bill already went out without rent is billed when the stay gets longer again', async () => {
    await atDate('2026-11-05', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      const novInv = await invoiceFor(s, '2026-11-01', 950, 35)
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,$5,'rent',950,'pending','RENT','2026-11-01'),
                ($1,$2,$3,$4,$5,'utility',35,'pending','UTILITY','2026-11-01')`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId, novInv])
      // Shortened to November 1 by mistake: November's rent goes, its bill keeps the water.
      await db.query(`UPDATE unit_bookings SET check_out='2026-11-01', nights=83 WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await rentByDueDate(s.leaseId))['2026-11-01']).toBeUndefined()
      expect(await invoiceTotals(novInv)).toEqual({ rent: 0, utilities: 35, total: 35 })

      // Put back to January 28: November is billed whole now; December on is the run's.
      await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)
      const nov = (await db.query<any>(
        `SELECT amount::float AS a, status, is_remainder, notes FROM payments WHERE lease_id=$1 AND type='rent' AND due_date='2026-11-01'`, [s.leaseId])).rows
      expect(nov).toEqual([{ a: 950, status: 'pending', is_remainder: false, notes: 'Stay now ends January 28, 2027: rent for November 2026' }])
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1 AND due_date > '2026-11-01'`, [s.leaseId])).rowCount).toBe(0)
      expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$950.00 more rent is billed for the longer stay (November 2026 $950.00)')
    })
  })

  // Wave A cleanup (wac23): the longer stay billed a whole month for ANY month
  // of the stay with no rent row once its bill had gone out or it was past the
  // run's catch-up window — months INSIDE the old stay that the bill run chose
  // not to write included. A snowbird lengthened on Dec 5 was billed October
  // and November, the off-season hibernation never charges; a property whose
  // first billing cycle is October was billed September.
  it('a lengthening never bills a month inside the old stay that the bill run did not write (hibernated months, months before the first billing cycle)', async () => {
    const restOfMonthOnly = async (s: { leaseId: string; landlordId: string }, month: string, label: string) => {
      const rows = (await db.query<any>(
        `SELECT to_char(due_date,'YYYY-MM-DD') AS d, amount::float AS a, status, is_remainder, notes
           FROM payments WHERE lease_id=$1 AND type='rent' AND notes LIKE 'Stay now ends%'`, [s.leaseId])).rows
      expect(rows).toEqual([{ d: month, a: 520.97, status: 'pending', is_remainder: true, notes: `Stay now ends January 28, 2027: the rest of ${label}` }])
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain(`$520.97 more rent is billed for the longer stay (the rest of ${label} $520.97)`)
      expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category LIKE 'stay_lengthened%'`)).rowCount).toBe(0)
    }

    // A snowbird: September paid, October and November hibernated (the run
    // writes nothing for a hibernating lease), resumed for December, which was
    // billed and paid at the 14-night amount. On December 5 they stay on to
    // January 28.
    await atDate('2026-12-05', async () => {
      const s = await seedStack()
      await db.query(`UPDATE leases SET end_date='2026-12-15' WHERE id=$1`, [s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-12-15' WHERE id=$1`, [s.bookingId])
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',429.03,'settled','RENT','2026-12-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out=$2 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)
      // Only the rest of December. October and November are never billed; January is the run's.
      expect(Object.keys(await rentByDueDate(s.leaseId))).toEqual(['2026-08-10', '2026-09-01', '2026-12-01'])
      await restOfMonthOnly(s, '2026-12-01', 'December 2026')
    })

    // The property's books start October 1: the September run wrote nothing for
    // September. October was billed and paid for 14 nights; on October 10 the
    // guest stays on.
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(`UPDATE properties SET first_billing_cycle='2026-10-01' WHERE id=$1`, [s.propertyId])
      await db.query(`UPDATE leases SET end_date='2026-10-15' WHERE id=$1`, [s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15' WHERE id=$1`, [s.bookingId])
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',429.03,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out=$2 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)
      // Only the rest of October. September is never billed.
      expect(Object.keys(await rentByDueDate(s.leaseId))).toEqual(['2026-08-10', '2026-10-01'])
      await restOfMonthOnly(s, '2026-10-01', 'October 2026')
    })
  })

  // The other side of the same rule: a month the lengthening ADDED (past the
  // old end) that is already outside the run's catch-up window is billed whole
  // — but only when the run itself would bill that date.
  it.each([
    ['billed whole: the run would bill it and never will', null, true],
    ['not while the lease is hibernating', `UPDATE leases SET is_hibernating=true, hibernated_at=now() WHERE id=$1`, false],
    ['not while the lease is held for review', `UPDATE leases SET needs_review=true WHERE id=$1`, false],
    ['not before the first billing cycle', `UPDATE properties SET first_billing_cycle='2026-12-01' WHERE id=(SELECT u.property_id FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=$1)`, false],
  ])('a month the lengthening added, past the run\'s catch-up window: %s', async (_label, setup, novBilled) => {
    await atDate('2026-12-05', async () => {
      const s = await seedStack()
      await db.query(`UPDATE leases SET end_date='2026-10-15' WHERE id=$1`, [s.leaseId])
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15' WHERE id=$1`, [s.bookingId])
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',429.03,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      if (setup) await db.query(setup, [s.leaseId])
      // On December 5 the stay is recorded as running on to January 28.
      await db.query(`UPDATE unit_bookings SET check_out=$2 WHERE id=$1`, [s.bookingId, END])
      await syncLeaseWithBookingDates(s.bookingId!)
      const billed = (await db.query<any>(
        `SELECT to_char(due_date,'YYYY-MM-DD') AS d, amount::float AS a, is_remainder, notes
           FROM payments WHERE lease_id=$1 AND type='rent' AND notes LIKE 'Stay now ends%' ORDER BY due_date`, [s.leaseId])).rows
      // The rest of October either way (it was billed and paid at 14 nights).
      // November is past the 30-day window (the run will never write it);
      // December and January are still the run's.
      expect(billed).toEqual([
        { d: '2026-10-01', a: 520.97, is_remainder: true, notes: 'Stay now ends January 28, 2027: the rest of October 2026' },
        ...(novBilled ? [{ d: '2026-11-01', a: 950, is_remainder: false, notes: 'Stay now ends January 28, 2027: rent for November 2026' }] : []),
      ])
    })
  })

  // Wave A cleanup (wac23): the longer stay counted rent paid past the new end
  // from rows with no reversal only, so a month re-paid after a dispute counted
  // as not paid there: it took back $1,103.23 of credit and bankOverpayment
  // banked $950 again. The money netted out, but the landlord and the guest
  // were told the wrong figures.
  it('a re-paid disputed month past the end: lengthening part way back takes back only the days owed again', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now())`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])
      // November was paid ahead by card, disputed, and paid again (the reopened row).
      const orig = (await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,'rent',950,'returned','RENT','2026-11-01', now(), 'pi_nov_disputed') RETURNING id`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
      const rev = (await db.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event, recovery_status)
         VALUES ($1,$2,$3,$4,'card_dispute',950,'evt_nov_disputed','{}'::jsonb,'recovered') RETURNING id`,
        [orig, s.landlordId, s.tenantId, s.leaseId])).rows[0].id
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at, reversal_id)
         VALUES ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-11-01', now(), $5)`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId, rev])
      const credit = async () => (await db.query<any>(
        `SELECT amount_original::float AS a, amount_remaining::float AS r, (voided_at IS NOT NULL) AS voided
           FROM lease_prepaid_credits WHERE lease_id=$1 ORDER BY created_at, id`, [s.leaseId])).rows

      // Shortened to October 15: $674.19 + $950 + $950 + $950 re-paid = $3,524.19
      // received, $2,053.22 owed — $1,470.97 over.
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15' WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await credit()).map(c => [c.a, c.voided])).toEqual([[1470.97, false]])

      // Then to October 20: $2,206.45 owed, so only $153.23 comes back and
      // $1,317.74 is still over — in ONE credit, nothing banked again.
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-20' WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect((await credit()).map(c => [c.a, c.r, c.voided])).toEqual([[1470.97, 1470.97, true], [1317.74, 1317.74, false]])
      expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1 AND notes LIKE 'Stay now ends%'`, [s.leaseId])).rowCount).toBe(0)

      const ll = (await db.query<any>(`SELECT body, data FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$153.23 of money paid ahead from when the stay was shortened was taken back, because those days are part of the stay again')
      expect(ll[0].body).not.toContain('of rent already paid past the new end is now money paid ahead')
      expect(ll[0].data).toMatchObject({ creditAmount: 0, creditTakenBack: 153.23 })
      const userId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [s.tenantId])).rows[0].user_id
      const tn = (await db.query<any>(`SELECT body FROM notifications WHERE user_id=$1 AND type='stay_lengthened_rent_billed'`, [userId])).rows
      expect(tn).toHaveLength(1)
      expect(tn[0].body).toContain('The $153.23 credit you were given when your stay was shortened was taken back')
    })
  })

  // Same figure, other cause: rent past the end paid partly with credit the
  // landlord issued. bankOverpayment counts it net of that credit (nobody paid
  // that part); the longer stay counted it whole and left $100 too much credit.
  it('rent paid past the end partly with landlord credit: lengthening part way back takes back only the days owed again', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      const ids = (await db.query<{ id: string; d: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now()),
                ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01', now()),
                ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-11-01', NULL)
         RETURNING id, due_date::text AS d`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
      const nov = ids.find(r => r.d === '2026-11-01')!.id
      // The landlord's $100 credit paid part of November; the guest paid $850 at the desk.
      const tc = await db.query<{ id: string }>(
        `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
         VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])
      const c = await getClient()
      try {
        await c.query('BEGIN')
        await applyCredit(c, [{ creditKind: 'issued', creditId: tc.rows[0].id, paymentId: nov, leaseId: s.leaseId, amount: 100, billingMonth: '2026-11-01' }], { source: 'desk' })
        await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [nov])
        await c.query('COMMIT')
      } finally { c.release() }
      const credit = async () => (await db.query<any>(
        `SELECT amount_original::float AS a, (voided_at IS NOT NULL) AS voided
           FROM lease_prepaid_credits WHERE lease_id=$1 ORDER BY created_at, id`, [s.leaseId])).rows

      // Shortened to October 15: $3,424.19 of money for $2,053.22 owed.
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-15' WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect(await credit()).toEqual([{ a: 1370.97, voided: false }])
      // To October 20: $153.23 more owed; $1,217.74 of money still over.
      await db.query(`UPDATE unit_bookings SET check_out='2026-10-20' WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)
      expect(await credit()).toEqual([{ a: 1370.97, voided: true }, { a: 1217.74, voided: false }])
      const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.landlordId])).rows
      expect(ll[0].body).toContain('$153.23 of money paid ahead from when the stay was shortened was taken back')
    })
  })

  // Wave A cleanup: the whole-bill check after a shortening ran only when money
  // was banked. A shortening that only re-prices an open final bill below
  // credit the guest already holds left that bill open: a stay that is ending
  // has no next bill run to settle it, and a late fee could land meanwhile.
  it('a re-price that lets existing credit cover the final bill settles it right away', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const octInv = await invoiceFor(s, '2026-10-01', 950, 0)
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',950,'pending','RENT','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv])).rows[0].id
    // $500 the guest paid ahead by check at the desk — not enough for $950.
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 500, 500, 'landlord', now())`, [s.leaseId, s.tenantId])
    await db.query(`UPDATE unit_bookings SET check_out='2026-10-15', nights=66 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // October is now $429.03, which the $500 covers: settled at once.
    expect((await db.query<any>(`SELECT amount::float AS a, status FROM payments WHERE id=$1`, [oct])).rows[0]).toEqual({ a: 429.03, status: 'settled' })
    expect((await db.query<any>(`SELECT source, status, amount::float AS a FROM credit_uses`)).rows)
      .toEqual([{ source: 'whole_bill', status: 'applied', a: 429.03 }])
    expect(Number((await db.query<any>(`SELECT amount_remaining FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows[0].amount_remaining)).toBe(70.97)
  })

  it("re-pricing the arrival bill keeps the reservation's deposit off it", async () => {
    const s = await seedStack()
    // decisions #15: the $300 deposit came off the arrival rent ($674.19 → $374.19 billed), not paid yet.
    await db.query(`UPDATE unit_bookings SET deposit_amount=300, deposit_paid_at='2026-08-01T17:00:00Z', total_amount=4700 WHERE id=$1`, [s.bookingId])
    const arrival = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',374.19,'pending','RENT','2026-08-10') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    // The guest leaves August 25: 15 nights × 950/31 = $459.68, less the $300 already paid.
    await db.query(`UPDATE unit_bookings SET check_out='2026-08-25', nights=15 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    expect(Number((await db.query<any>(`SELECT amount FROM payments WHERE id=$1`, [arrival])).rows[0].amount)).toBe(159.68)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
  })

  it('when the reservation deposit now covers the whole shorter stay, the arrival bill goes and the rest is banked', async () => {
    const s = await seedStack()
    // A $500 deposit: the arrival bill is $174.19, not paid yet.
    await db.query(`UPDATE unit_bookings SET deposit_amount=500, deposit_paid_at='2026-08-01T17:00:00Z', total_amount=4700 WHERE id=$1`, [s.bookingId])
    const inv = await invoiceFor(s, '2026-08-10', 174.19, 0)
    const arrival = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',174.19,'pending','RENT','2026-08-10') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, inv])).rows[0].id
    // The guest leaves August 15: 5 nights × 950/31 = $153.23 — the deposit covers it.
    await db.query(`UPDATE unit_bookings SET check_out='2026-08-15', nights=5 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [arrival])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM invoices WHERE id=$1`, [inv])).rowCount).toBe(0)     // an empty shell goes too
    // $500 paid − $153.23 owed = $346.77, banked as money paid ahead.
    const credit = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 346.77, funded_by: 'reclassified' }])
    const ll = (await db.query<any>(`SELECT body FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [s.landlordId])).rows
    expect(ll[0].body).toContain('unpaid rent changed to match the new dates (August 2026 $174.19 → nothing owed)')
  })

  it('a stay drafted from a reservation banks the deposit too when shortened', async () => {
    const s = await seedStack()
    // decisions #15: the $300 reservation deposit came off the arrival rent, so
    // that row is billed net ($396.67), and September was paid in full.
    await db.query(`UPDATE unit_bookings SET deposit_amount=300, deposit_paid_at='2026-08-01T17:00:00Z', total_amount=4700 WHERE id=$1`, [s.bookingId])
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',396.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Paid: $300 deposit + $396.67 + $950 = $1,646.67. Owed now $1,275.86. Over: $370.81 (not $70.81).
    const credit = await db.query<any>(`SELECT amount_original::float AS a, funded_by FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 370.81, funded_by: 'reclassified' }])
  })

  it("a reservation deposit bigger than the arrival rent: its leftover credit is counted once, not banked again", async () => {
    const s = await seedStack()
    // A $1,000 deposit: the arrival rent took $696.67 of it (billed $0) and the
    // other $303.33 was kept as credit, which then paid part of September.
    await db.query(`UPDATE unit_bookings SET deposit_amount=1000, deposit_paid_at='2026-08-01T17:00:00Z', total_amount=4700 WHERE id=$1`, [s.bookingId])
    const sep = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-09-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { createPaidAhead } = await import('../services/creditUse')
      const { STAY_DEPOSIT_CREDIT_NOTE } = await import('./moveInBundle')
      const leftover = await createPaidAhead(c, {
        leaseId: s.leaseId, tenantId: s.tenantId, amount: 303.33, fundedBy: 'reclassified',
        receivedAt: '2026-08-01T17:00:00Z', note: STAY_DEPOSIT_CREDIT_NOTE,
      })
      await applyCredit(c, [{ creditKind: 'paid_ahead', creditId: leftover, paymentId: sep, leaseId: s.leaseId, amount: 303.33, billingMonth: '2026-09-01' }], { source: 'desk' })
      await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [sep])
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Money that arrived: $1,000 deposit + $646.67 cash = $1,646.67; owed $1,275.86 → $370.81.
    const credit = await db.query<any>(
      `SELECT amount_original::float AS a FROM lease_prepaid_credits WHERE lease_id=$1 AND note LIKE 'Stay shortened%'`, [s.leaseId])
    expect(credit.rows).toEqual([{ a: 370.81 }])
  })

  it('a final bill the banked credit covers settles right away', async () => {
    const s = await seedStack()
    // Arrival, September and October all paid (October ahead of time); the
    // final September water bill is open.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-10-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'utility',40,'pending','UTILITY','2026-09-20') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    // Banked $2,596.67 − $1,275.86 = $1,320.81; the $40 water settles from it at once.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [water])).rows[0].status).toBe('settled')
    const credit = (await db.query<any>(
      `SELECT amount_original::float AS a, amount_remaining::float AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows
    expect(credit).toEqual([{ a: 1320.81, r: 1280.81 }])
    expect((await db.query<any>(`SELECT source, status, amount::float AS a FROM credit_uses`)).rows)
      .toEqual([{ source: 'whole_bill', status: 'applied', a: 40 }])
  })

  it('S637: a credit too small for the rent leaves the charge whole', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 300, 300)`, [s.leaseId, s.tenantId])
    await backfillInvoices({ from: '2026-09-01', to: '2026-09-30', leaseId: s.leaseId })
    const pay = await db.query<any>(
      `SELECT amount::numeric AS a, status, notes FROM payments
        WHERE lease_id=$1 AND type='rent' ORDER BY amount DESC`, [s.leaseId])
    // S637 (Nic, DIRECTIVE): "Credits do not fucking split charges... We don't
    // do partial payments." This used to assert 950 rent becoming a 300
    // settled slice plus a 650 remainder — a partial payment, banned
    // platform-wide, and a settled row no money arrived for.
    //
    // A $300 credit cannot clear $950, so the charge is left whole and the
    // credit keeps waiting for one it can cover.
    expect(pay.rows.find((p: any) => p.status === 'settled')).toBeFalsy()
    const credit = await db.query<any>(
      `SELECT amount_remaining::numeric AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(Number(credit.rows[0].r)).toBe(300)
  })
})

// Decisions #30 / #35.3 (Nic, 10/3): credit the landlord gave that paid rent for
// nights no longer in the stay comes back to the guest as SAVED credit; the
// guest's own money for those nights is banked as money paid ahead (the
// landlord decides on any refund); every dollar is counted once.
describe('landlord credit on nights a shortened stay no longer has', () => {
  type Stack = Awaited<ReturnType<typeof seedStack>>
  async function landlordCredit(s: Stack, amount: number): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,$4,$4,'goodwill') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId, amount])).rows[0].id
  }
  /** The desk spends `amount` of the credit on the row; with `cash`, the rest is paid in cash then. */
  async function spendAtDesk(s: Stack, creditId: string, paymentId: string, amount: number, month: string, cash: boolean) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await applyCredit(c, [{ creditKind: 'issued', creditId, paymentId, leaseId: s.leaseId, amount, billingMonth: month }], { source: 'desk' })
      if (cash) await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [paymentId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  async function invoice(s: Stack, due: string, rent: number, utility: number): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7::numeric + $8::numeric) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-${due}-${Math.random().toString(36).slice(2, 8)}`, due, rent, utility])).rows[0].id
  }
  /** Arrival and September paid; October's $950 rent on its own bill, not paid yet. */
  async function stayWithOctober(s: Stack, utility = 0) {
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const octInv = await invoice(s, '2026-10-01', 950, utility)
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',950,'pending','RENT','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv])).rows[0].id
    return { octInv, oct }
  }
  const remainingOn = async (creditId: string) =>
    Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [creditId])).rows[0].amount_remaining)
  const paidAhead = async (leaseId: string) => (await db.query<any>(
    `SELECT amount_original::float AS a, (voided_at IS NOT NULL) AS voided FROM lease_prepaid_credits
      WHERE lease_id=$1 ORDER BY created_at, id`, [leaseId])).rows
  const rowOf = async (id: string) => (await db.query<any>(
    `SELECT amount::float AS amount, issued_credit_amount::float AS issued, status, notes FROM payments WHERE id=$1`, [id])).rows[0]
  const invoiceTotals = async (id: string) => (await db.query<any>(
    `SELECT subtotal_rent::float AS rent, total_amount::float AS total FROM invoices WHERE id=$1`, [id])).rows[0]
  const uses = async () => (await db.query<any>(
    `SELECT status, release_reason, payment_id, amount::float AS amount, source, (applied_at IS NOT NULL) AS spent_on_record
       FROM credit_uses ORDER BY held_at, id`)).rows
  const landlordNotice = async (s: Stack) => (await db.query<any>(
    `SELECT body, data FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [s.landlordId])).rows[0]
  const shortenTo = async (s: Stack, checkOut: string) => {
    await db.query(`UPDATE unit_bookings SET check_out=$2 WHERE id=$1`, [s.bookingId, checkOut])
    await syncLeaseWithBookingDates(s.bookingId!)
  }

  it('credit the landlord gave that paid a month the stay lost comes back to the guest as credit; only the guest\'s own money is banked', async () => {
    const s = await seedStack()
    const { octInv, oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    // October: $100 of the landlord's credit and $850 cash.
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)

    await shortenTo(s, '2026-10-01')

    // The $100 is the guest's again, to use on a later bill.
    expect(await remainingOn(tc)).toBe(100)
    expect(await uses()).toEqual([
      { status: 'released', release_reason: 'stay_shortened', payment_id: oct, amount: 100, source: 'desk', spent_on_record: true },
    ])
    // October now asks only what the guest's money paid; that money never moved.
    const row = await rowOf(oct)
    expect(row).toMatchObject({ amount: 850, issued: 0, status: 'settled' })
    expect(row.notes).toContain('$100.00 of credit the landlord gave, spent on this rent, went back to the guest as credit')
    expect(await invoiceTotals(octInv)).toEqual({ rent: 850, total: 850 })
    // Only the guest's money for October is banked: $850, never the $100 credit.
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: false }])
    const n = await landlordNotice(s)
    expect(n.body).toContain('$850.00 of rent already paid past the new end is now money paid ahead')
    expect(n.body).toContain('$100.00 of credit you gave them had paid rent for nights no longer in the stay (October 2026); it went back to them as credit they can use on a later bill, and that rent bill came down by the same amount')
    expect(n.data).toMatchObject({ creditAmount: 850, creditGivenBack: 100 })

    // Saving the dates again changes nothing: nothing is given back or banked twice.
    await syncLeaseWithBookingDates(s.bookingId!)
    expect(await remainingOn(tc)).toBe(100)
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: false }])
    expect((await rowOf(oct)).amount).toBe(850)
  })

  it('Money billed counts the landlord\'s credit once: never on the month the stay lost, once on the bill it later pays', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)
    await shortenTo(s, '2026-10-01')

    const billed = () => incomeTotals({ landlordIds: [s.landlordId], start: '2026-08-01', end: '2026-10-31', basis: 'billed' })
    const before = await billed()
    // The stay owes $674.19 + $950; the guest's money paid that and $850 more,
    // which is "Stay shortened" (moved to money paid ahead). No credit was used.
    expect(before.total).toBe(1624.19)
    expect(before.lines.stayShortened).toBe(-850)
    expect(before.lines.creditsGiven).toBe(0)

    // The guest uses the credit on a $100 fee.
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'fee',100,'pending','OTHERFEE','2026-09-15') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    await spendAtDesk(s, tc, fee, 100, '2026-09-01', true)
    const after = await billed()
    expect(after.lines.creditsGiven).toBe(-100)
    expect(after.total).toBe(1624.19)
    expect(await remainingOn(tc)).toBe(0)
  })

  it('credit on an unpaid month the stay lost comes back, and that rent goes; the final bill the credit now covers is paid from it', async () => {
    const s = await seedStack()
    const { octInv, oct } = await stayWithOctober(s, 40)
    // September's water rides October's bill.
    const water = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'utility',40,'pending','UTILITY','2026-10-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, octInv])).rows[0].id
    const tc = await landlordCredit(s, 100)
    // $100 of October was paid by the landlord's credit; $850 is still open.
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', false)

    await shortenTo(s, '2026-10-01')

    // October's rent is not owed any more: the credit came back and the bill went.
    expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [oct])).rowCount).toBe(0)
    expect((await uses())[0]).toEqual(
      { status: 'released', release_reason: 'stay_shortened', payment_id: null, amount: 100, source: 'desk', spent_on_record: true })
    expect(await invoiceTotals(octInv)).toEqual({ rent: 0, total: 40 })
    // Nothing stuck on the account, nothing for GAM to clear, nothing banked.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rowCount).toBe(0)
    expect(await paidAhead(s.leaseId)).toEqual([])
    const n = await landlordNotice(s)
    expect(n.body).toContain('$100.00 of credit you gave them had paid rent for nights no longer in the stay (October 2026)')
    expect(n.body).not.toContain('stays on their account')
    // The $40 water is now the whole bill and the credit covers it: paid at once.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [water])).rows[0].status).toBe('settled')
    expect((await uses())[1]).toMatchObject({ status: 'applied', payment_id: water, amount: 40, source: 'whole_bill' })
    expect(await remainingOn(tc)).toBe(60)
  })

  it('a month the new end cuts part way: only the credit on the cut nights comes back, and the rest keeps paying the nights still in the stay', async () => {
    const s = await seedStack()
    const { octInv, oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 300)
    // October: $300 of the landlord's credit and $650 cash.
    await spendAtDesk(s, tc, oct, 300, '2026-10-01', true)

    // Now ends October 25: October owes 24 nights × 950/31 = $735.48, so
    // $214.52 of October's nights are gone — all of them paid by the credit.
    await shortenTo(s, '2026-10-25')

    expect(await remainingOn(tc)).toBe(214.52)
    expect((await rowOf(oct))).toMatchObject({ amount: 650, issued: 0, status: 'settled' })
    // The $85.48 of the credit still on October's nights is on a row of its own.
    const rest = (await db.query<any>(
      `SELECT id, amount::float AS amount, issued_credit_amount::float AS issued, status, is_remainder, notes, invoice_id
         FROM payments WHERE lease_id=$1 AND due_date='2026-10-01' AND id <> $2`, [s.leaseId, oct])).rows
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ amount: 85.48, issued: 85.48, status: 'settled', is_remainder: true, invoice_id: octInv })
    expect(rest[0].notes).toContain('rent for October 2026 still paid by credit the landlord gave')
    expect(await uses()).toEqual([
      { status: 'released', release_reason: 'stay_shortened', payment_id: oct, amount: 300, source: 'desk', spent_on_record: true },
      { status: 'applied', release_reason: null, payment_id: rest[0].id, amount: 85.48, source: 'desk', spent_on_record: true },
    ])
    // October's bill is what the stay owes for it; the guest's money paid none of the cut nights, so nothing is banked.
    expect(await invoiceTotals(octInv)).toEqual({ rent: 735.48, total: 735.48 })
    expect(await paidAhead(s.leaseId)).toEqual([])
    expect((await landlordNotice(s)).body).toContain('$214.52 of credit you gave them had paid rent for nights no longer in the stay (October 2026)')
  })

  it('lengthened again after the credit came back: the rest of the month is billed and the guest\'s restored credit pays it', async () => {
    await atDate('2026-10-10', async () => {
      const s = await seedStack()
      const { oct } = await stayWithOctober(s)
      const tc = await landlordCredit(s, 100)
      await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)
      await shortenTo(s, '2026-10-01')
      expect(await remainingOn(tc)).toBe(100)

      // Back to November 1: October is whole again.
      await db.query(`UPDATE unit_bookings SET check_out='2026-11-01' WHERE id=$1`, [s.bookingId])
      await syncLeaseWithBookingDates(s.bookingId!)

      // The money banked for October is withdrawn, and the $100 its own money
      // did not pay is billed as the rest of October — which the credit covers.
      expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: true }])
      const restRows = (await db.query<any>(
        `SELECT amount::float AS amount, issued_credit_amount::float AS issued, status, notes FROM payments
          WHERE lease_id=$1 AND due_date='2026-10-01' AND id <> $2`, [s.leaseId, oct])).rows
      expect(restRows).toEqual([expect.objectContaining({ amount: 100, issued: 100, status: 'settled' })])
      expect(restRows[0].notes).toContain('the rest of October 2026')
      expect(await remainingOn(tc)).toBe(0)
      // Counted once: October billed $950 again, $100 of it the landlord's credit.
      const b = await incomeTotals({ landlordIds: [s.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'billed' })
      expect(b.lines.creditsGiven).toBe(-100)
      expect(b.lines.stayShortened).toBe(0)
      expect(b.total).toBe(850)
    })
  })

  it('credit a card payment set aside on a month the stay lost comes back when that payment clears', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',950,'processing','RENT','2026-10-01','pi_oct_card') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    const tc = await landlordCredit(s, 100)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,850,850,0,'card','pi_oct_card') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    const c0 = await getClient()
    try {
      await c0.query('BEGIN')
      await holdCredit(c0, [{ creditKind: 'issued', creditId: tc, paymentId: oct, leaseId: s.leaseId, amount: 100, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'portal' })
      await c0.query('COMMIT')
    } finally { c0.release() }

    await shortenTo(s, '2026-10-01')
    // The card payment is still clearing: its credit stays set aside, nothing is banked yet.
    expect(await remainingOn(tc)).toBe(0)
    expect(await paidAhead(s.leaseId)).toEqual([])

    // The payment clears (as the webhook does: credit spent, row settled, the settle-path hook).
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await applyHeldForRemittance(c, rem)
      await c.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [oct])
      expect(await bankShortenedStaysAfterSettle(c, [oct])).toEqual([
        { leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, amount: 850 },
      ])
      await c.query('COMMIT')
    } finally { c.release() }
    expect(await remainingOn(tc)).toBe(100)
    expect((await rowOf(oct))).toMatchObject({ amount: 850, issued: 0, status: 'settled' })
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: false }])
  })

  it('a kept past-end month names only what is still unpaid on it, and the credit on it comes back', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    // $100 of October was paid by the landlord's credit; the bank pull for the
    // other $850 bounced (no retry left), so the row carries history and stays.
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', false)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,850,850,0,'failed','ach','pi_oct_850') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 850)`, [rem, oct])
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_oct_850' WHERE id=$1`, [oct])

    await shortenTo(s, '2026-10-01')

    expect(await remainingOn(tc)).toBe(100)
    expect(await rowOf(oct)).toMatchObject({ amount: 850, issued: 0, status: 'failed' })
    const admin = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category='stay_shortened_rent_kept'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].body).toContain('$850.00 of unpaid rent due after that (October 2026)')
    expect(admin[0].body).toContain('October 2026 $850.00 (a card or bank payment on it failed)')
    const n = await landlordNotice(s)
    expect(n.body).toContain('$850.00 of unpaid rent due after the new end (October 2026) stays on their account')
    expect(n.data).toMatchObject({ keptRent: 850, creditGivenBack: 100 })
  })

  it('a kept past-end month names what is unpaid on it, not money paid ahead already spent on it', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    // $200 the guest paid ahead at the desk went on October; the bank pull for
    // the other $750 bounced (no retry left), so the row stays.
    const money = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 200, 200, 'landlord', now()) RETURNING id`, [s.leaseId, s.tenantId])).rows[0].id
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await applyCredit(c, [{ creditKind: 'paid_ahead', creditId: money, paymentId: oct, leaseId: s.leaseId, amount: 200, billingMonth: '2026-10-01' }], { source: 'desk' })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_oct_750' WHERE id=$1`, [oct])

    await shortenTo(s, '2026-10-01')

    // Money paid ahead is the guest's money, not the landlord's credit: it is not given back here.
    expect(await rowOf(oct)).toMatchObject({ amount: 950, status: 'failed' })
    const n = await landlordNotice(s)
    expect(n.body).toContain('$750.00 of unpaid rent due after the new end (October 2026) stays on their account')
    expect(n.data).toMatchObject({ keptRent: 750, creditGivenBack: 0 })
  })

  it('an unpaid month carrying more of the landlord\'s credit than its new amount is left for GAM, never asked of the guest at more than the nights', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 500)
    // $500 of October was paid by the landlord's credit; $450 is still open.
    await spendAtDesk(s, tc, oct, 500, '2026-10-01', false)

    // Now ends October 15: October owes $429.03, less than the credit on it.
    await shortenTo(s, '2026-10-15')

    // Left as it was, and GAM is told: giving the credit back would leave the
    // guest asked $450 for nights worth $429.03.
    expect(await rowOf(oct)).toMatchObject({ amount: 950, issued: 500, status: 'pending' })
    expect(await remainingOn(tc)).toBe(0)
    const admin = (await db.query<any>(`SELECT body FROM admin_notifications WHERE category='stay_shortened_rent_not_repriced'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].body).toContain('October 2026 $429.03 (the bill says $950.00)')
    expect((await landlordNotice(s)).data).toMatchObject({ creditGivenBack: 0 })
  })

  it('credit on a month still in the stay stays spent there', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)
    // Now ends November 1: October is still wholly in the stay.
    await shortenTo(s, '2026-11-01')
    expect(await remainingOn(tc)).toBe(0)
    expect((await rowOf(oct))).toMatchObject({ amount: 950, issued: 100 })
    expect(await uses()).toEqual([expect.objectContaining({ status: 'applied', payment_id: oct })])
  })

  /** Rows settle the way every payment path ends: inside one transaction, then the settle-path hook. */
  async function settleThenHook(ids: string[], settle?: string) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      if (settle) await c.query(`UPDATE payments SET status='settled', settled_at=now(), manual_method='cash' WHERE id=$1`, [settle])
      const r = await bankShortenedStaysAfterSettle(c, ids)
      await c.query('COMMIT')
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const septemberOf = async (s: Stack) => (await db.query<{ id: string }>(
    `SELECT id FROM payments WHERE lease_id=$1 AND due_date='2026-09-01' AND type='rent'`, [s.leaseId])).rows[0].id
  /** Makes the give-back fail at the database, as an outage or a bug would; always undone. */
  async function withGiveBackRefused<T>(fn: () => Promise<T>): Promise<T> {
    await db.query(
      `CREATE OR REPLACE FUNCTION test_refuse_stay_shortened() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.release_reason = 'stay_shortened' THEN RAISE EXCEPTION 'test: give-back refused'; END IF;
         RETURN NEW;
       END $$`)
    await db.query(
      `CREATE TRIGGER test_refuse_stay_shortened BEFORE UPDATE ON credit_uses
         FOR EACH ROW EXECUTE FUNCTION test_refuse_stay_shortened()`)
    try { return await fn() } finally {
      await db.query(`DROP TRIGGER IF EXISTS test_refuse_stay_shortened ON credit_uses`)
      await db.query(`DROP FUNCTION IF EXISTS test_refuse_stay_shortened()`)
    }
  }

  it('a rent lowered by a signed addendum mid-stay gives no credit back and rewrites no bill', async () => {
    const s = await seedStack()
    const { octInv, oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    // October: $100 of the landlord's credit and $850 cash, at $950.
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)
    // A signed addendum lowers the rent to $900 (scheduledLeaseChanges writes
    // leases.rent_amount); the stay itself never changes.
    await db.query(`UPDATE leases SET rent_amount = 900 WHERE id = $1`, [s.leaseId])
    const nov = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',900,'pending','RENT','2026-11-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id

    // November is paid; the settle-path hook runs on the stay.
    expect(await settleThenHook([nov], nov)).toEqual([])

    // October was a whole month of the stay: its bill and its credit stand as written.
    const row = await rowOf(oct)
    expect(row).toMatchObject({ amount: 950, issued: 100, status: 'settled' })
    expect(row.notes ?? '').not.toContain('went back to the guest')
    expect(await invoiceTotals(octInv)).toEqual({ rent: 950, total: 950 })
    expect(await remainingOn(tc)).toBe(0)
    expect(await uses()).toEqual([expect.objectContaining({ status: 'applied', release_reason: null, payment_id: oct, amount: 100 })])
    expect((await db.query(`SELECT 1 FROM payments WHERE lease_id=$1 AND due_date='2026-10-01' AND id <> $2`, [s.leaseId, oct])).rowCount).toBe(0)
    expect(await paidAhead(s.leaseId)).toEqual([])
  })

  it('a later settle leaves a month GAM was told about as it was, and the credit on its lost nights comes back once that month is paid', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const sep = await septemberOf(s)
    const tc = await landlordCredit(s, 500)
    // $500 of October was paid by the landlord's credit; $450 is still open.
    await spendAtDesk(s, tc, oct, 500, '2026-10-01', false)
    // Now ends October 15 ($429.03 owed): October could not be re-priced, GAM was told.
    await shortenTo(s, '2026-10-15')
    const told = async () => (await db.query<any>(
      `SELECT body FROM admin_notifications WHERE category='stay_shortened_rent_not_repriced'`)).rows
    expect(await told()).toHaveLength(1)

    // Other rent on the stay settles later (any payment path runs the hook).
    expect(await settleThenHook([sep])).toEqual([])
    // October is as GAM was told: the bill, its credit and what the guest is asked.
    expect(await rowOf(oct)).toMatchObject({ amount: 950, issued: 500, status: 'pending' })
    expect(await remainingOn(tc)).toBe(0)
    expect(await uses()).toEqual([expect.objectContaining({ status: 'applied', payment_id: oct, amount: 500 })])
    const t = await told()
    expect(t).toHaveLength(1)
    expect(t[0].body).toContain('October 2026 $429.03 (the bill says $950.00)')

    // October is paid ($450 cash). Its lost nights were worth $520.97: the $500
    // of credit on them comes back, and the $20.97 of money over is banked.
    expect(await settleThenHook([oct], oct)).toEqual([
      { leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, amount: 20.97 },
    ])
    expect(await remainingOn(tc)).toBe(500)
    expect(await rowOf(oct)).toMatchObject({ amount: 450, issued: 0, status: 'settled' })
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 20.97, voided: false }])
  })

  it('a second, shorter end takes back the credit left on its own row, and that row says nothing is owed or paid on it any more', async () => {
    const s = await seedStack()
    const { octInv, oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 300)
    await spendAtDesk(s, tc, oct, 300, '2026-10-01', true)
    // Ends October 25: $85.48 of the credit stays on October's nights, on its own row.
    await shortenTo(s, '2026-10-25')
    const rest = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE lease_id=$1 AND due_date='2026-10-01' AND id <> $2`, [s.leaseId, oct])).rows[0].id
    expect(await remainingOn(tc)).toBe(214.52)

    // Now ends October 10: October owes 9 nights, $275.81. The credit left on
    // its nights comes back too; the guest's $650 paid $374.19 more than that.
    await shortenTo(s, '2026-10-10')
    expect(await remainingOn(tc)).toBe(300)
    const r = await rowOf(rest)
    expect(r).toMatchObject({ amount: 0, issued: 0, status: 'settled' })
    expect(r.notes).toContain('$85.48 of credit the landlord gave, spent on this rent, went back to the guest as credit; nothing is owed or paid on this line any more')
    expect(await rowOf(oct)).toMatchObject({ amount: 650, issued: 0, status: 'settled' })
    expect(await invoiceTotals(octInv)).toEqual({ rent: 650, total: 650 })
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 374.19, voided: false }])
    expect((await landlordNotice(s)).body).toContain('$85.48 of credit you gave them had paid rent for nights no longer in the stay (October 2026)')
  })

  it('a give-back that fails while rent settles tells GAM; the settle goes through, only money is banked, and the next settle gives the credit back', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',674.19,'settled','RENT','2026-08-10', now()),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01', now())`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',950,'processing','RENT','2026-10-01','pi_oct_card_fail') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows[0].id
    const tc = await landlordCredit(s, 100)
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,850,850,0,'card','pi_oct_card_fail') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    const c0 = await getClient()
    try {
      await c0.query('BEGIN')
      await holdCredit(c0, [{ creditKind: 'issued', creditId: tc, paymentId: oct, leaseId: s.leaseId, amount: 100, billingMonth: '2026-10-01' }], { remittanceId: rem, source: 'portal' })
      await c0.query('COMMIT')
    } finally { c0.release() }
    await shortenTo(s, '2026-10-01')

    // The card payment clears while the give-back cannot run.
    const cleared = await withGiveBackRefused(async () => {
      const c = await getClient()
      try {
        await c.query('BEGIN')
        await applyHeldForRemittance(c, rem)
        await c.query(`UPDATE payments SET status='settled', settled_at=now() WHERE id=$1`, [oct])
        const r = await bankShortenedStaysAfterSettle(c, [oct])
        await c.query('COMMIT')
        return r
      } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    })
    // Only the guest's money is banked; the credit stays spent for now.
    expect(cleared).toEqual([{ leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, amount: 850 }])
    expect(await rowOf(oct)).toMatchObject({ amount: 950, issued: 100, status: 'settled' })
    expect(await remainingOn(tc)).toBe(0)
    const alert = (await db.query<any>(
      `SELECT title, body, context FROM admin_notifications WHERE category='stay_shortened_credit_not_given_back'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].title).toContain('Credit on nights no longer in a stay was not given back — Sched Guest on unit')
    expect(alert[0].body).toContain('Rent on this stay was paid. The stay ends 2026-10-01.')
    expect(alert[0].body).toContain('It is tried again each time rent on this stay is paid')
    expect(alert[0].context).toMatchObject({ lease_id: s.leaseId, landlord_id: s.landlordId })

    // The next rent settle on the stay gives it back; nothing is banked twice.
    expect(await settleThenHook([oct])).toEqual([])
    expect(await remainingOn(tc)).toBe(100)
    expect(await rowOf(oct)).toMatchObject({ amount: 850, issued: 0, status: 'settled' })
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: false }])
  })

  it('a give-back that fails when the dates change tells GAM how it will be tried again; only money is banked', async () => {
    const s = await seedStack()
    const { oct } = await stayWithOctober(s)
    const tc = await landlordCredit(s, 100)
    await spendAtDesk(s, tc, oct, 100, '2026-10-01', true)

    await withGiveBackRefused(() => shortenTo(s, '2026-10-01'))

    expect(await rowOf(oct)).toMatchObject({ amount: 950, issued: 100, status: 'settled' })
    expect(await remainingOn(tc)).toBe(0)
    expect(await paidAhead(s.leaseId)).toEqual([{ a: 850, voided: false }])
    const alert = (await db.query<any>(
      `SELECT title, body FROM admin_notifications WHERE category='stay_shortened_credit_not_given_back'`)).rows
    expect(alert).toHaveLength(1)
    expect(alert[0].title).toContain('Sched Guest on unit')
    expect(alert[0].body).toContain('The stay now ends 2026-10-01.')
    expect(alert[0].body).toContain('It is tried again each time rent on this stay is paid')
    expect(alert[0].body).not.toContain('Save the reservation')
  })
})

// Rent a longer stay bills carries its month's own due date but is written the
// day the stay grows. A guest who pays it that day is on time on the credit
// record GAM's network sees (creditLedgerEmitters counts lateness from the
// later of the due date and the day the bill was written).
describe('the credit record for rent a longer stay bills', () => {
  /** The stay ran Aug 10 → `oldEnd` with every month paid; then it grows to January 28 on `today`. */
  async function lengthened(today: string, oldEnd: string, paid: Array<[string, number]>) {
    const s = await seedStack()
    await db.query(`UPDATE leases SET end_date=$2, late_fee_grace_days=5 WHERE id=$1`, [s.leaseId, oldEnd])
    await db.query(`UPDATE unit_bookings SET check_out=$2 WHERE id=$1`, [s.bookingId, oldEnd])
    for (const [due, amount] of paid) {
      await db.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description,
                               due_date, settled_at, created_at)
         VALUES ($1,$2,$3,$4,'rent',$5,'settled','RENT',$6::date,$6::date + 1,$6::date - 7)`,
        [s.unitId, s.tenantId, s.landlordId, s.leaseId, amount, due])
    }
    await db.query(`UPDATE unit_bookings SET check_out=$2, nights=171 WHERE id=$1`, [s.bookingId, END])
    await atDate(today, () => syncLeaseWithBookingDates(s.bookingId!))
    const billed = (await db.query<{ id: string; due: string; amount: number; is_remainder: boolean }>(
      `SELECT id, to_char(due_date,'YYYY-MM-DD') AS due, amount::float AS amount, is_remainder FROM payments
        WHERE lease_id=$1 AND status='pending' AND notes LIKE 'Stay now ends%' ORDER BY due_date`, [s.leaseId])).rows
    // The database clock is the real one; the bill was written on `today`.
    await db.query(`UPDATE payments SET created_at=$2::timestamptz WHERE id = ANY($1::uuid[])`,
      [billed.map(b => b.id), `${today}T17:00:00Z`])
    return { s, billed }
  }
  /** Cash at the desk for everything open, at `at`. */
  async function payAtDesk(s: Awaited<ReturnType<typeof seedStack>>, row: { id: string; due: string; amount: number }, at: string) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { settleManualRentPayment } = await import('../services/manualPaymentSettle')
      await settleManualRentPayment(c, {
        payment: { id: row.id, landlord_id: s.landlordId, tenant_id: s.tenantId, unit_id: s.unitId, lease_id: s.leaseId, due_date: row.due },
        method: 'cash', settledAt: new Date(at), settleHousehold: true, amountTendered: row.amount,
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const markFor = async (paymentId: string) => (await db.query<any>(
    `SELECT event_type, network_visibility, event_data FROM credit_events WHERE event_data->>'payment_id' = $1`,
    [paymentId])).rows

  it('a longer-stay bill paid the day it is billed is on time on the credit record (the rest of the month)', async () => {
    // October was paid at its 14-day amount; on Oct 10 the stay grows and the
    // rest of October ($520.97, due Oct 1) is billed. Paid that afternoon.
    const { s, billed } = await lengthened('2026-10-10', '2026-10-15',
      [['2026-08-10', 674.19], ['2026-09-01', 950], ['2026-10-01', 429.03]])
    expect(billed).toMatchObject([{ due: '2026-10-01', amount: 520.97, is_remainder: true }])
    await payAtDesk(s, billed[0], '2026-10-10T22:00:00Z')
    const marks = await markFor(billed[0].id)
    expect(marks).toHaveLength(1)
    expect(marks[0].event_type).toBe('payment_received_on_time')
    expect(marks[0].network_visibility).toBe('visible_to_current_landlord')
    expect(marks[0].event_data).toMatchObject({ due_date: '2026-10-01', billed_on: '2026-10-10' })
  })

  it('a longer-stay bill paid the day it is billed is on time on the credit record (a whole month written after the catch-up window)', async () => {
    // The stay ended Nov 1 with every month paid; on Dec 10 it grows to
    // January 28. November is past the bill run's 30-day catch-up window, so
    // the lengthening bills it whole ($950, due Nov 1). Paid that afternoon.
    const { s, billed } = await lengthened('2026-12-10', '2026-11-01',
      [['2026-08-10', 674.19], ['2026-09-01', 950], ['2026-10-01', 950]])
    expect(billed).toMatchObject([{ due: '2026-11-01', amount: 950, is_remainder: false }])
    await payAtDesk(s, billed[0], '2026-12-10T22:00:00Z')
    const marks = await markFor(billed[0].id)
    expect(marks).toHaveLength(1)
    expect(marks[0].event_type).toBe('payment_received_on_time')
    expect(marks[0].event_data).toMatchObject({ due_date: '2026-11-01', billed_on: '2026-12-10' })
  })

  it('a longer-stay bill paid long after it was billed is still late', async () => {
    const { s, billed } = await lengthened('2026-10-10', '2026-10-15',
      [['2026-08-10', 674.19], ['2026-09-01', 950], ['2026-10-01', 429.03]])
    // Grace runs to Oct 15 (5 days from the day it was billed); Oct 25 is 10 days past.
    await payAtDesk(s, billed[0], '2026-10-25T22:00:00Z')
    const marks = await markFor(billed[0].id)
    expect(marks).toHaveLength(1)
    expect(marks[0].event_type).toBe('payment_received_late_major')
    expect(marks[0].network_visibility).toBe('visible_to_gam_network')
  })
})

describe('S548 end-of-stay: final read after lease expiry', () => {
  it('bill generated post-expiry attaches to the departed tenant\'s lease', async () => {
    const s = await seedStack()
    // The 2am processor already expired the lease when the final read lands.
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [s.leaseId])

    const client = await getClient()
    let meterId: string
    try {
      await client.query('BEGIN')
      meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(
        `UPDATE utility_meters SET rate_per_unit=0.15, base_fee=5, digits=6 WHERE id=$1`, [meterId])
      await client.query(
        `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'electric', TRUE)`, [s.leaseId])
      // Prior cycle baseline + the FINAL read for the departure month.
      await client.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, '2026-12-28', 10000, '2026-12-01', $2),
                ($1, '2027-01-28', 10400, '2027-01-01', $2)`, [meterId, s.userId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const r = await generateBillsForMeter(meterId!, new Date('2027-01-01T00:00:00Z'))
    expect(r.billsCreated).toBe(1)
    const bill = await db.query<any>(
      `SELECT lease_id, tenant_id, charge_amount::numeric AS c, payment_id, status FROM utility_bills WHERE meter_id=$1`, [meterId!])
    expect(bill.rows[0].lease_id).toBe(s.leaseId)   // NOT landlord-absorbed
    expect(bill.rows[0].tenant_id).toBe(s.tenantId)
    expect(Number(bill.rows[0].c)).toBe(65)          // 400 kWh × 0.15 + $5 base

    // S548 immediate settlement: the ended lease's stub was invoiced ON THE
    // SPOT — invoice dated today, due today, utility payment pending.
    expect(bill.rows[0].payment_id).not.toBeNull()
    expect(bill.rows[0].status).toBe('billed')
    const inv = await db.query<any>(
      `SELECT i.due_date::text AS due, i.subtotal_utilities::numeric AS u, i.total_amount::numeric AS t, p.status
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.id = $1`, [bill.rows[0].payment_id])
    // S654: the property's today — what generateFinalUtilityInvoice stamps —
    // not UTC's, which is already tomorrow after 5 pm in Phoenix.
    const tz = await db.query<{ timezone: string }>(`SELECT timezone FROM properties WHERE id=$1`, [s.propertyId])
    const today = todayIn(tz.rows[0].timezone)
    expect(inv.rows[0].due.slice(0, 10)).toBe(today)
    expect(Number(inv.rows[0].u)).toBe(65)
    expect(Number(inv.rows[0].t)).toBe(65)
    expect(inv.rows[0].status).toBe('pending')       // payable NOW; deposit sweep is the backstop
  })

  it('same-day turnover: the departing lease owns the cycle, not the new arrival', async () => {
    const s = await seedStack()
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [s.leaseId])
    // New guest pulls in the day the old one pulls out — ACTIVE lease from Jan 28.
    const client = await getClient()
    let meterId: string
    try {
      await client.query('BEGIN')
      const newTenantId = await seedTenant(client)
      const newLeaseId = await seedLease(client, {
        unitId: s.unitId, landlordId: s.landlordId, rentAmount: RENT, startDate: '2027-01-28', status: 'active',
      })
      await seedLeaseTenant(client, { leaseId: newLeaseId, tenantId: newTenantId })
      await client.query(`UPDATE leases SET needs_review=false WHERE id=$1`, [newLeaseId])
      meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(`UPDATE utility_meters SET rate_per_unit=0.15, base_fee=5, digits=6 WHERE id=$1`, [meterId])
      await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'electric', TRUE), ($2, 'electric', TRUE)`, [s.leaseId, newLeaseId])
      await client.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, '2026-12-28', 10000, '2026-12-01', $2),
                ($1, '2027-01-28', 10400, '2027-01-01', $2)`, [meterId, s.userId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    await generateBillsForMeter(meterId!, new Date('2027-01-01T00:00:00Z'))
    const bill = await db.query<any>(
      `SELECT lease_id, tenant_id FROM utility_bills WHERE meter_id=$1`, [meterId!])
    // The DEPARTING lease covered Jan 1 — it owns the January usage.
    expect(bill.rows[0].lease_id).toBe(s.leaseId)
    expect(bill.rows[0].tenant_id).toBe(s.tenantId)
  })
})

describe('S548 pull-out meter read prompt', () => {
  it('prompts the landlord for submetered sites departing today, once per day', async () => {
    const { promptMoveOutMeterReads } = await import('../services/utilityReadingRuns')
    const s = await seedStack()
    // Lease ends TODAY on a submetered site.
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE WHERE id=$1`, [s.leaseId])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const first = await promptMoveOutMeterReads()
    expect(first.prompted).toBe(1)
    const n = await db.query<any>(
      `SELECT title, body FROM notifications WHERE type='moveout_meter_reads_due' AND landlord_id=$1`, [s.landlordId])
    expect(n.rows).toHaveLength(1)
    expect(n.rows[0].title).toContain('Pull-out meter reads due today')
    expect(n.rows[0].body).toContain('pulling out today')

    // Same morning, second cron tick → no duplicate.
    const second = await promptMoveOutMeterReads()
    expect(second.prompted).toBe(0)
  })

  it('no submeter on the departing site → no prompt', async () => {
    const { promptMoveOutMeterReads } = await import('../services/utilityReadingRuns')
    const s = await seedStack()
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE WHERE id=$1`, [s.leaseId])
    const r = await promptMoveOutMeterReads()
    expect(r.prompted).toBe(0)
  })
})

describe('S548 move-out walkthrough scheduling', () => {
  it('lease inside the 3-business-day pre-end window → inspection due BY the end date, staff prompted, idempotent', async () => {
    const { scheduleMoveOutInspections } = await import('../services/moveOutInspections')
    const s = await seedStack()   // seedUnit defaults to 'apartment' — gated
    // Tenant moves out in 2 days — we're inside the window; inspect DURING move-out.
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE + 2, status='active' WHERE id=$1`, [s.leaseId])

    const first = await scheduleMoveOutInspections()
    expect(first.scheduled).toBe(1)
    const insp = await db.query<any>(
      `SELECT inspection_type, status, to_char(scheduled_for,'YYYY-MM-DD') AS due,
              to_char(CURRENT_DATE + 2,'YYYY-MM-DD') AS end_d
         FROM unit_inspections WHERE lease_id=$1`, [s.leaseId])
    expect(insp.rows).toHaveLength(1)
    expect(insp.rows[0].inspection_type).toBe('move_out')
    expect(insp.rows[0].due).toBe(insp.rows[0].end_d)   // deadline = lease end, not after
    const n = await db.query<any>(
      `SELECT body FROM notifications WHERE type='moveout_inspection_due' AND landlord_id=$1`, [s.landlordId])
    expect(n.rows.length).toBeGreaterThanOrEqual(1)
    expect(n.rows[0].body).toContain('WHILE they move out')

    const second = await scheduleMoveOutInspections()
    expect(second.scheduled).toBe(0)
  })

  it('lease ending far outside the window → not scheduled yet', async () => {
    const { scheduleMoveOutInspections } = await import('../services/moveOutInspections')
    const s = await seedStack()
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE + 7, status='active' WHERE id=$1`, [s.leaseId])
    const r = await scheduleMoveOutInspections()
    expect(r.scheduled).toBe(0)
  })

  it('business-day helpers skip weekends and federal holidays', async () => {
    const { addBusinessDays, subtractBusinessDays } = await import('../services/moveOutInspections')
    expect(addBusinessDays('2026-08-14', 3)).toBe('2026-08-19')        // Fri +3 → Wed
    expect(addBusinessDays('2026-11-25', 3)).toBe('2026-12-01')        // Wed before Thanksgiving +3 → Tue
    expect(subtractBusinessDays('2026-08-19', 3)).toBe('2026-08-14')   // Wed −3 → Fri
    expect(subtractBusinessDays('2026-12-01', 3)).toBe('2026-11-25')   // Tue −3 → Wed (skips Thanksgiving)
  })
})
