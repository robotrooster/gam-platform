/**
 * 10/20 (Nic) — CALL IT A WASH, FROM THE CHECK-OUT WINDOW.
 *
 *   "So what we do when people leave early is we'll usually call it a wash. We
 *    don't refund the money, but we also don't bill them a final electric
 *    bill. ... I would like to keep track of money that wasn't refunded versus
 *    electric that should have been billed that wasn't charged to see how close
 *    we actually get to evening out."
 *
 * services/earlyDepartureWash holds the rule and the book. THIS is the desk:
 * what the clerk is told, and what the answer they give writes down. The shapes
 * are the two live departures that prompted the feature — RV 10 and RV 11 at
 * Mountain View, $589 paid for the month, pulled out at 14 nights (worth $538
 * on the two-week rate), neither refunded, so $51 each stayed with the park.
 *
 * Run (the wash migrations are applied now; 20261022090000+ are not):
 *   DB_NAME=gam_wash_tax_test TEST_DB_NAME=gam_wash_tax_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/services/earlyCheckOutWash.test.ts
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, query, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUtilityMeter } from '../test/dbHelpers'
import {
  decideEarlyCheckOut, quoteEarlyCheckOut, onCheckOutUndone, poolQ,
} from './earlyCheckOut'
import { moneyKeptForDeparture, settleFinalStubForDeparture, washPairing, washVerdict } from './earlyDepartureWash'
import { recordSaleTowardStay } from './stayPayments'

// Phoenix, mid-afternoon on the day they drove away.
const NOW = new Date('2026-10-18T20:00:00Z')
const LEFT = '2026-10-18'
const ARRIVED = '2026-10-04'
const BOOKED_THROUGH = '2026-11-04'

beforeEach(async () => {
  await cleanupAllSchema()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

interface Park {
  userId: string; landlordId: string; propertyId: string; unitId: string; meterId: string | null
}

/**
 * A park, a site and (unless `meter: false`) the site's own electric submeter —
 * which is what makes the desk's wash sentence true, and so what decides
 * whether it is said at all.
 */
async function park(o: { refunds?: boolean; meter?: boolean; taxRate?: number } = {}): Promise<Park> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties SET name = 'Mountain View RV Ranch', timezone = 'America/Phoenix',
              timezone_source = 'manual', short_term_tax_rate = $3,
              early_departure_refunds = $2 WHERE id = $1`,
      [propertyId, o.refunds !== false, o.taxRate ?? 0])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(
      `UPDATE units SET unit_number = 'RV 10', is_bookable = TRUE,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589 WHERE id = $1`, [unitId])
    let meterId: string | null = null
    if (o.meter !== false) {
      meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    }
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, meterId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/**
 * The reservation: a month at $589, still checked in.
 *
 * `stayTaxRate` stamps the rate the stay was PRICED at, the way a real booking
 * carries it — the two live Mountain View departures read 6.35% while the
 * property's own short-term rate is 6.60% today. Left out, the stamping trigger
 * takes the property's rate, which is what an ordinary booking does.
 */
async function stay(p: Park, o: {
  bookedThrough?: string; total?: number; guest?: string; stayTaxRate?: number
} = {}): Promise<string> {
  const through = o.bookedThrough ?? BOOKED_THROUGH
  return (await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
        total_amount, platform_fee, status, source, booked_check_out, stay_tax_rate)
     VALUES ($1,$2,$3,'month_to_month',$4::date,$5::date,($5::date - $4::date),$6,0,'checked_in','direct',$5::date,$7)
     RETURNING id`,
    [p.landlordId, p.unitId, o.guest ?? 'Victor Cardoza', ARRIVED, through, o.total ?? 589,
     o.stayTaxRate ?? null]))[0].id
}

/** They paid at the counter, in cash — so there is real money that CAN go back. */
async function paidCash(p: Park, bookingId: string, amount: number): Promise<void> {
  const sale = (await query<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, platform_fee)
     VALUES ($1,$2,$3,'cash',$4,0,0,$4,0) RETURNING id`,
    [p.landlordId, p.propertyId, p.userId, amount]))[0].id
  const c = await getClient()
  try { await recordSaleTowardStay(c, { bookingId, saleId: sale, toward: amount }) } finally { c.release() }
  await query(
    `UPDATE unit_bookings SET deposit_amount = $2, deposit_paid_at = NOW(),
            balance_paid_at = CASE WHEN $2 >= total_amount THEN NOW() ELSE balance_paid_at END
      WHERE id = $1`, [bookingId, amount])
}

/** Check them out and answer the money question, the way the window does. */
async function decide(p: Park, bookingId: string, choice: string | null, o: {
  refundAmount?: number; canRefund?: boolean; firstTime?: boolean
} = {}) {
  const first = o.firstTime !== false
  const q = await quoteEarlyCheckOut(poolQ, bookingId, {
    leftOn: first ? LEFT : null, canRefund: o.canRefund !== false, canCheckOut: true })
  return decideEarlyCheckOut({
    bookingId,
    actor: { userId: p.userId, canCheckOut: true, canRefund: o.canRefund !== false },
    leftOn: first ? LEFT : null,
    choice: choice as any,
    refundAmount: o.refundAmount ?? null,
    quoteToken: q.quoteToken,
    idempotencyKey: randomUUID(),
  })
}

const washes = async (landlordId: string) => (await db.query<any>(
  `SELECT amount_kept::float AS kept, refund_given, refund_amount::float AS refunded,
          to_char(departed_on, 'YYYY-MM-DD') AS departed_on,
          to_char(paid_through, 'YYYY-MM-DD') AS paid_through,
          unwound_at IS NOT NULL AS unwound, unwound_reason,
          checkout_decision_id IS NOT NULL AS has_decision, notes
     FROM early_departure_washes WHERE landlord_id = $1 ORDER BY created_at`, [landlordId])).rows

const absorbed = async (landlordId: string) => (await db.query<any>(
  `SELECT reason, charge_amount::float AS charge, usage_amount::float AS usage
     FROM utility_absorbed_charges WHERE landlord_id = $1 ORDER BY created_at`, [landlordId])).rows

const stub = (p: Park, bookingId: string) => ({
  landlordId: p.landlordId, meterId: p.meterId!, unitId: p.unitId,
  utilityType: 'electric', cycleMonth: '2026-10-01',
  chargeAmount: 81.27, baseFeeShare: 0, taxAmount: 0, taxRatePct: 0,
  usageAmount: 387, allocationMethod: 'submeter', allocationBasis: null,
  ratePerUnit: 0.21, readingStart: 1000, readingEnd: 1387,
  readingStartDate: '2026-10-01', readingEndDate: LEFT,
  ref: { bookingId },
})

// ─── What the answer writes down ─────────────────────────────────────────────

describe('"No refund" records the money that stayed here', () => {
  it('the RV 10 shape: $589 paid, 14 nights worth $538, nothing back — $51 recorded against the departure', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    const out = await decide(p, b, 'no_refund')
    expect(out.checkedOut).toBe(true)
    expect(out.decision).toMatchObject({ status: 'decided', choice: 'no_refund', refundTotal: 0 })

    // The money side, keyed to the departure and linked to the answer that made it.
    expect(await washes(p.landlordId)).toEqual([{
      kept: 51, refund_given: false, refunded: 0,
      departed_on: LEFT, paid_through: BOOKED_THROUGH,
      unwound: false, unwound_reason: null, has_decision: true, notes: null,
    }])
    const verdict = await washVerdict({ bookingId: b }, p.landlordId)
    expect(verdict.verdict).toBe('wash')
    expect(verdict.amountKept).toBe(51)
    expect(verdict.why).toContain('$51.00 stayed with the landlord')
  })

  it('and the closing read that lands afterwards bills nobody — nothing on the guest\'s account', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)
    await decide(p, b, 'no_refund')

    const settled = await settleFinalStubForDeparture(stub(p, b))
    expect(settled.outcome).toBe('absorbed')
    expect(await absorbed(p.landlordId)).toEqual([{ reason: 'early_departure_wash', charge: 81.27, usage: 387 }])

    // "it doesn't need to get attached to anything": no bill, no invoice, no debt.
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE landlord_id = $1`, [p.landlordId])).rowCount).toBe(0)
    expect((await db.query(
      `SELECT 1 FROM payments WHERE landlord_id = $1 AND type = 'utility'`, [p.landlordId])).rowCount).toBe(0)

    // The two halves, side by side, which is the whole point.
    expect(await washPairing(p.landlordId)).toMatchObject([
      { unitNumber: 'RV 10', who: 'Victor Cardoza', moneyKept: 51, utilityAbsorbed: 81.27, evenedOutBy: -30.27 },
    ])
  })

  it('two guests off one site in one month are two departures, not one', async () => {
    const p = await park()
    const first = await stay(p, { guest: 'Victor Cardoza' })
    await paidCash(p, first, 589)
    await decide(p, first, 'no_refund')
    await settleFinalStubForDeparture(stub(p, first))

    const second = await stay(p, { guest: 'Nemesio Rivera' })
    await paidCash(p, second, 589)
    await decide(p, second, 'no_refund')
    await settleFinalStubForDeparture(stub(p, second))

    expect((await washes(p.landlordId)).map((w) => w.kept)).toEqual([51, 51])
    expect(await absorbed(p.landlordId)).toHaveLength(2)
  })

  it('a guest who still owed records nothing — the wash is money kept, not money never collected', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 200)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.question).toBe('owes')
    await decide(p, b, 'keep_price')
    expect(await washes(p.landlordId)).toEqual([])
    expect((await washVerdict({ bookingId: b }, p.landlordId)).verdict).toBe('bill')
  })

  it('a guest who left on the day they booked through records nothing', async () => {
    const p = await park()
    // Booked through the day they actually left: 14 nights, $538, paid in full.
    const b = await stay(p, { bookedThrough: LEFT, total: 538 })
    await paidCash(p, b, 538)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q).toMatchObject({ early: false, question: 'none' })
    await decide(p, b, null)
    expect(await washes(p.landlordId)).toEqual([])
  })
})

// ─── The lodging tax comes off once, not twice ───────────────────────────────

/**
 * 10/20 (Nic) — "it's $269 each at 2 weeks, but it's also plus the short-term
 * lodging tax ... that's tax we would have to pay if we refunded the difference
 * and relog it as a 2 week stay."
 *
 * Mountain View as it really is: the park's short-term rate is 6.60% today and
 * the two live bookings were stamped at 6.35% when they were sold. Every test
 * above runs the park at 0%, where a pre-tax figure and a tax-in figure are the
 * same number — which is exactly why the double subtraction got through.
 *
 * Worked by hand: $589.00 paid, 14 nights = 2 weeks at $269 = $538.00, the
 * lodging tax re-logging that owes is $35.51, so the landlord is REALLY ahead
 * $15.49. The till is up $51.00 and that is what the row stamps; the tax comes
 * off when the report is read, once.
 */
describe('a taxed park: what the till is up is stamped before tax', () => {
  const taxed = () => park({ taxRate: 6.6 })
  const soldAt635 = (p: Park, o: { guest?: string } = {}) => stay(p, { ...o, stayTaxRate: 0.0635 })

  it('the RV 10 shape with real tax: $51.00 stamped, $35.51 priced on the way out, $15.49 really ahead', async () => {
    const p = await taxed()
    const b = await soldAt635(p)
    await paidCash(p, b, 589)

    // The desk's own figure is priced TAX IN, at the rate this stay was sold
    // at — $572.16, not $538.00. That is correct for the window and it is not
    // what the wash row holds.
    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.stayed.worth).toBe(572.16)
    expect(q.unused).toBe(16.84)

    await decide(p, b, 'no_refund')

    // What the till is up, before any tax: $589.00 − $538.00.
    expect(await washes(p.landlordId)).toMatchObject([{ kept: 51, refund_given: false, refunded: 0 }])

    // And the figure the check-out stamped is the same one the OTHER writer
    // would have passed, so the row no longer depends on which of the two got
    // there first (the final-stub fallback reads this).
    const read = await moneyKeptForDeparture({ bookingId: b }, p.landlordId)
    expect(read).toMatchObject({ amountKept: 51, lodgingTaxOwed: 35.51, amountKeptNet: 15.49 })

    // The landlord's card: $51.00 in the till, $35.51 of tax he would remit out
    // of pocket, $15.49 really ahead — and no closing read in yet, so the power
    // side is still zero rather than the shortfall being understated by $30.98.
    expect(await washPairing(p.landlordId)).toMatchObject([{
      unitNumber: 'RV 10', who: 'Victor Cardoza',
      moneyKeptBeforeTax: 51, lodgingTaxOwed: 35.51, moneyKept: 15.49,
      utilityAbsorbed: 0, closingReadsIn: false, evenedOutBy: 15.49,
    }])
  })

  it('and when the closing read lands, the shortfall is measured against $15.49', async () => {
    const p = await taxed()
    const b = await soldAt635(p)
    await paidCash(p, b, 589)
    await decide(p, b, 'no_refund')
    expect((await settleFinalStubForDeparture(stub(p, b))).outcome).toBe('absorbed')

    expect(await washPairing(p.landlordId)).toMatchObject([{
      moneyKept: 15.49, utilityAbsorbed: 81.27, closingReadsIn: true, evenedOutBy: -65.78,
    }])
  })

  it('the park that asks nobody stamps the same $51.00, not the tax-in difference', async () => {
    const p = await park({ refunds: false, taxRate: 6.6 })
    const b = await soldAt635(p)
    await paidCash(p, b, 589)

    await decide(p, b, null)
    expect(await washes(p.landlordId)).toMatchObject([{ kept: 51, has_decision: false }])
    expect((await washVerdict({ bookingId: b }, p.landlordId)).amountKept).toBe(51)
  })

  it('two of them: $102.00 in the till, $71.02 of tax, $30.98 really ahead', async () => {
    const p = await taxed()
    const victor = await soldAt635(p, { guest: 'Victor Cardoza' })
    await paidCash(p, victor, 589)
    await decide(p, victor, 'no_refund')
    const nemesio = await soldAt635(p, { guest: 'Nemesio Rivera' })
    await paidCash(p, nemesio, 589)
    await decide(p, nemesio, 'no_refund')

    const rows = await washPairing(p.landlordId)
    expect(rows.map((r) => r.moneyKeptBeforeTax)).toEqual([51, 51])
    expect(rows.reduce((t, r) => t + r.moneyKeptBeforeTax, 0)).toBe(102)
    expect(rows.reduce((t, r) => t + r.lodgingTaxOwed, 0)).toBe(71.02)
    expect(rows.reduce((t, r) => t + r.moneyKept, 0)).toBe(30.98)
  })
})

// ─── A refund is not a wash ──────────────────────────────────────────────────

describe('any refund at all means the power bills normally', () => {
  it('refunding the unused nights records no wash', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    const out = await decide(p, b, 'refund_unused')
    expect(out.decision?.refundTotal).toBe(51)
    expect(await washes(p.landlordId)).toEqual([])

    const settled = await settleFinalStubForDeparture(stub(p, b))
    expect(settled.outcome).toBe('bill_normally')
    expect(await absorbed(p.landlordId)).toEqual([])
  })

  it('a PART refund is a refund: splitting the difference in cash does not also eat the power', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    await decide(p, b, 'refund_other', { refundAmount: 25 })
    expect(await washes(p.landlordId)).toEqual([])
    expect((await settleFinalStubForDeparture(stub(p, b))).outcome).toBe('bill_normally')
  })

  it('a stub parked while the question waited is released by the refund, with everything needed to bill it', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    // The desk clerk cannot refund, so the question waits — and the closing
    // read lands FIRST. Nobody is billed for something that may be a wash.
    await decide(p, b, null, { canRefund: false })
    const held = await settleFinalStubForDeparture(stub(p, b))
    expect(held.outcome).toBe('held')
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE landlord_id = $1`, [p.landlordId])).rowCount).toBe(0)

    // Then the owner refunds, so it goes back to ordinary billing.
    const out = await decide(p, b, 'refund_unused', { firstTime: false })
    expect(out.decision?.refundTotal).toBe(51)
    expect(out.decision?.choice).toBe('refund_unused')
    const back = (await db.query<any>(
      `SELECT released_at IS NOT NULL AS released, released_reason, absorbed_at
         FROM utility_wash_holds WHERE landlord_id = $1`, [p.landlordId])).rows
    expect(back).toMatchObject([{ released: true, absorbed_at: null }])
    expect(await absorbed(p.landlordId)).toEqual([])
  })

  it('a stub parked while the question waited is absorbed by "No refund"', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    await decide(p, b, null, { canRefund: false })
    expect((await settleFinalStubForDeparture(stub(p, b))).outcome).toBe('held')

    await decide(p, b, 'no_refund', { firstTime: false })
    expect(await absorbed(p.landlordId)).toEqual([{ reason: 'early_departure_wash', charge: 81.27, usage: 387 }])
    expect((await db.query<any>(
      `SELECT absorbed_at IS NOT NULL AS absorbed FROM utility_wash_holds WHERE landlord_id = $1`,
      [p.landlordId])).rows).toMatchObject([{ absorbed: true }])
  })

  it('a refund given LATER unwinds a wash already on the book, and the power is owed again', async () => {
    // The park's answer said it gives nothing back, so nobody was asked and the
    // wash was recorded with the check-out. The owner then corrects the setting
    // and makes it right with the guest — which is a refund against a departure
    // already recorded as a wash.
    const p = await park({ refunds: false })
    const b = await stay(p)
    await paidCash(p, b, 589)
    await decide(p, b, null)
    await settleFinalStubForDeparture(stub(p, b))
    expect(await washes(p.landlordId)).toMatchObject([{ kept: 51, unwound: false }])
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    await query(`UPDATE properties SET early_departure_refunds = TRUE WHERE id = $1`, [p.propertyId])
    const out = await decide(p, b, 'refund_unused', { firstTime: false })
    expect(out.decision?.refundTotal).toBe(51)

    // The wash is kept and stamped (GAM never erases) but stops counting, and
    // the absorbed line comes off the book: that power is billable again.
    expect(await washes(p.landlordId)).toMatchObject([{ unwound: true, refund_given: true, refunded: 51 }])
    expect(await absorbed(p.landlordId)).toEqual([])
    expect((await washVerdict({ bookingId: b }, p.landlordId)).verdict).toBe('bill')
  })
})

// ─── Nobody asked, and the money still stayed here ───────────────────────────

describe('a park that gives nothing back records the wash with nobody asked', () => {
  it('no question is put to the desk, and the money kept is recorded with the check-out', async () => {
    const p = await park({ refunds: false })
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.question).toBe('none')
    expect(q.choices).toEqual([])

    await decide(p, b, null)
    expect(await washes(p.landlordId)).toMatchObject([{
      kept: 51, refund_given: false, departed_on: LEFT, paid_through: BOOKED_THROUGH, has_decision: false,
    }])
    expect((await settleFinalStubForDeparture(stub(p, b))).outcome).toBe('absorbed')
  })
})

// ─── The undo ────────────────────────────────────────────────────────────────

describe('putting the booked day back takes the wash with it', () => {
  it('an undone check-out unwinds the wash and the absorbed power becomes billable again', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)
    await decide(p, b, 'no_refund')
    await settleFinalStubForDeparture(stub(p, b))
    expect(await absorbed(p.landlordId)).toHaveLength(1)

    const c = await getClient()
    try {
      await c.query('BEGIN')
      await onCheckOutUndone(c, b, { change: 'undo', guest: 'Victor Cardoza' })
      await c.query('COMMIT')
    } finally { c.release() }

    expect(await washes(p.landlordId)).toMatchObject([{ unwound: true, unwound_reason: 'The check-out was undone' }])
    expect(await absorbed(p.landlordId)).toEqual([])
    expect((await washVerdict({ bookingId: b }, p.landlordId)).verdict).toBe('bill')
    expect(await washPairing(p.landlordId)).toEqual([])
  })

  it('an undo unwinds a wash that never had a decision row — the park that asks nobody', async () => {
    const p = await park({ refunds: false })
    const b = await stay(p)
    await paidCash(p, b, 589)
    await decide(p, b, null)
    await settleFinalStubForDeparture(stub(p, b))
    expect((await db.query(
      `SELECT 1 FROM stay_checkout_decisions WHERE booking_id = $1`, [b])).rowCount).toBe(0)

    const c = await getClient()
    try {
      await c.query('BEGIN')
      await onCheckOutUndone(c, b, { change: 'undo', guest: 'Victor Cardoza' })
      await c.query('COMMIT')
    } finally { c.release() }

    expect(await washes(p.landlordId)).toMatchObject([{ unwound: true }])
    expect(await absorbed(p.landlordId)).toEqual([])
  })

  it('an undo releases a stub that was only parked, so it bills normally again', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)
    await decide(p, b, null, { canRefund: false })
    expect((await settleFinalStubForDeparture(stub(p, b))).outcome).toBe('held')

    const c = await getClient()
    try {
      await c.query('BEGIN')
      await onCheckOutUndone(c, b, { change: 'undo', guest: 'Victor Cardoza' })
      await c.query('COMMIT')
    } finally { c.release() }

    expect((await db.query<any>(
      `SELECT released_at IS NOT NULL AS released, released_reason
         FROM utility_wash_holds WHERE landlord_id = $1`, [p.landlordId])).rows)
      .toMatchObject([{ released: true, released_reason: 'The check-out was undone' }])
  })
})

// ─── The words at the desk ───────────────────────────────────────────────────

describe('the desk is told the whole trade in one breath', () => {
  it('a park that keeps the money says so, and says the final electric does not follow them', async () => {
    const p = await park({ refunds: false })
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.noRefunds).toBe(
      'Victor Cardoza paid $51.00 more than the nights they stayed are worth, but this property does not give '
      + 'money back when a guest leaves early — so nothing goes back and the price as booked, $589.00, stands. '
      + 'Check them out and the stay closes. Because that money stayed here, their final electric bill is a '
      + 'wash: the closing read is still taken to close the space out, but nothing is billed to them for it. '
      + 'The property\'s settings are where that changes.')
    // No refund is promised that is not coming.
    expect(q.noRefunds).not.toContain('refunded')
  })

  it('"No refund" says what it costs the landlord as well as what it keeps', async () => {
    const p = await park()
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    const no = q.choices.find((c) => c.choice === 'no_refund')!
    expect(no.result).toBe(
      'Nothing goes back. Their final electric bill is a wash — nothing is billed to them for it.')
    // The refund choices promise no such thing: a refund bills the power.
    expect(q.choices.find((c) => c.choice === 'refund_unused')!.result).not.toContain('wash')
  })

  it('names every submetered utility on the site, never the raw column value', async () => {
    const p = await park({ refunds: false })
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const water = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'water', billingMethod: 'submeter' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [water, p.unitId])
      await c.query('COMMIT')
    } finally { c.release() }
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.noRefunds).toContain('their final electric and water bill is a wash')
  })

  it('says nothing about a utility bill on a site with no meter of its own', async () => {
    const p = await park({ refunds: false, meter: false })
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.noRefunds).toContain('does not give money back')
    expect(q.noRefunds).not.toContain('wash')

    const refunding = await park({ meter: false })
    const b2 = await stay(refunding)
    await paidCash(refunding, b2, 589)
    const q2 = await quoteEarlyCheckOut(poolQ, b2, { leftOn: LEFT, canRefund: true })
    expect(q2.choices.find((c) => c.choice === 'no_refund')!.result).toBe('Nothing goes back')
  })

  it('a trash can and a pooled master are not a closing read, so neither is promised', async () => {
    const p = await park({ refunds: false, meter: false })
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const trash = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'trash', billingMethod: 'flat_rate' })
      const pooled = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'water', billingMethod: 'rubs' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2), ($3, $2)`,
        [trash, p.unitId, pooled])
      await c.query('COMMIT')
    } finally { c.release() }
    const b = await stay(p)
    await paidCash(p, b, 589)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q.noRefunds).not.toContain('wash')
  })

  it('a guest who left on their booked day is told nothing about a wash', async () => {
    const p = await park({ refunds: false })
    const b = await stay(p, { bookedThrough: LEFT, total: 538 })
    await paidCash(p, b, 538)

    const q = await quoteEarlyCheckOut(poolQ, b, { leftOn: LEFT, canRefund: true })
    expect(q).toMatchObject({ early: false, noRefunds: null })
  })
})
