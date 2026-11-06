/**
 * 10/31 (Nic) — counting the cash drawer down. The arithmetic, the refusals, and
 * the leads on where a short drawer's money went.
 *
 * Every number here is cents on purpose: counting a drawer by denomination is
 * integer work, and a float would eventually argue with the cashier over a penny.
 *
 * Seeds inside beforeEach rather than beforeAll, which is the house pattern
 * (routes/pos.test.ts). Files share one database and any of them may wipe it, so
 * data seeded once for a whole file does not survive a parallel run — these
 * tests passed alone and failed in the suite until they were rewritten this way.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { openShift, closeShift, shiftMoney, varianceLeads } from './posDrawer'

let landlordId = ''
let userId = ''
let propertyId = ''

beforeEach(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    landlordId = l.landlordId; userId = l.userId
    propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
  finally { c.release() }
})

afterAll(async () => { await cleanupAllSchema() })

const register = async (opts: { startingCents?: number | null; threshold?: number | null; name?: string } = {}) => {
  const confirmed = opts.startingCents != null
  const r = await queryOne<{ id: string }>(
    `INSERT INTO pos_registers
       (landlord_id, property_id, name, starting_cash_cents, starting_cash_confirmed_at,
        starting_cash_confirmed_by_user_id, variance_reason_over_cents)
     VALUES ($1,$2,$3,$4, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() END,
             CASE WHEN $4::int IS NULL THEN NULL ELSE $5::uuid END, $6)
     RETURNING id`,
    [landlordId, propertyId, opts.name ?? `Register ${Math.random().toString(36).slice(2, 7)}`,
     opts.startingCents ?? null, userId, opts.threshold ?? null])
  return r!.id
}

/**
 * A second person. One person can only hold ONE drawer now
 * (ux_pos_register_shifts_one_per_person, 10/31), so any test needing two
 * drawers open at once needs two people — which is the real situation anyway:
 * an employee on the main register and a manager covering a break.
 */
const another = async () => {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    await c.query('COMMIT')
    return l.userId
  } finally { c.release() }
}

/**
 * Pin a row's timestamp to the shift's own opening instant.
 *
 * These tests open a shift, write a row and close the shift inside the SAME
 * millisecond, so at the microsecond precision Postgres actually stores, a row
 * stamped NOW() can land a hair AFTER closed_at and fall outside the window the
 * lead finder searches. A real register never does that; the test should not
 * depend on it. Equal to opened_at is inside the window by definition.
 */
const insideShift = (table: string, column: string, rowId: string, shiftId: string) => query(
  `UPDATE ${table} SET ${column} = (SELECT opened_at FROM pos_register_shifts WHERE id = $2)
    WHERE id = $1`, [rowId, shiftId])

/** A ticket needs somebody on it (pos_open_tickets_one_customer). */
const posCustomer = async () => {
  const r = await queryOne<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name)
     VALUES ($1,'Walk','Up') RETURNING id`, [landlordId])
  return r!.id
}

/** A cash sale rung into a shift. Dollars on the table, cents in the drawer. */
const cashSale = (shiftId: string, dollars: number, status = 'completed') => query(
  `INSERT INTO pos_transactions
     (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status, register_shift_id)
   VALUES ($1,$2,$3,'cash',$4,0,$4,$5,$6)`,
  [landlordId, propertyId, userId, dollars, status, shiftId])

const cashRefund = async (shiftId: string, dollars: number) => {
  const tx = await queryOne<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status, register_shift_id)
     VALUES ($1,$2,$3,'cash',$4,0,$4,'refunded',$5) RETURNING id`,
    [landlordId, propertyId, userId, dollars, shiftId])
  await query(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, register_shift_id)
     VALUES ($1,$2,$3,'cash',$4)`, [tx!.id, landlordId, dollars, shiftId])
}

describe('opening a shift', () => {
  it('refuses when nobody has said what stays in the drawer', async () => {
    const id = await register({ startingCents: null, name: 'No Starting Cash' })
    await expect(openShift({ registerId: id, userId })).rejects.toThrow(/starting cash/i)
  })

  it('snapshots the starting cash, so editing the register later cannot move a past shift', async () => {
    const id = await register({ startingCents: 20000 })
    const shift = await openShift({ registerId: id, userId })
    expect(shift.openingCents).toBe(20000)
    // The operator changes the register's standing amount afterwards.
    await query(`UPDATE pos_registers SET starting_cash_cents = 5000 WHERE id = $1`, [id])
    expect((await shiftMoney(shift.id)).openingCents).toBe(20000)
  })

  it('refuses a second shift on the same drawer, by name', async () => {
    const id = await register({ startingCents: 10000, name: 'Front Desk' })
    await openShift({ registerId: id, userId })
    await expect(openShift({ registerId: id, userId })).rejects.toThrow(/Front Desk/)
  })

  it('refuses a retired register', async () => {
    const id = await register({ startingCents: 10000, name: 'Old Till' })
    await query(`UPDATE pos_registers SET status = 'retired' WHERE id = $1`, [id])
    await expect(openShift({ registerId: id, userId })).rejects.toThrow(/retired/i)
  })
})

describe('what the drawer should hold', () => {
  it('starting cash, plus cash in, less cash back out', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)       // $40 in
    await cashSale(s.id, 11.61)    // $11.61 in
    // A refunded sale went IN and then came back OUT: the helper rings the $5
    // sale too, so it shows on both sides and nets to nothing in the drawer.
    await cashRefund(s.id, 5)
    const m = await shiftMoney(s.id)
    expect(m.cashSalesCents).toBe(5661)               // 40 + 11.61 + 5
    expect(m.cashRefundsCents).toBe(500)
    expect(m.expectedCents).toBe(10000 + 5661 - 500)  // $151.61
  })

  it('a voided sale never went in the drawer', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)
    await cashSale(s.id, 25, 'voided')
    expect((await shiftMoney(s.id)).expectedCents).toBe(14000)
  })

  it('a card sale is not drawer cash', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await query(
      `INSERT INTO pos_transactions
         (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status, register_shift_id)
       VALUES ($1,$2,$3,'card',75,0,75,'completed',$4)`,
      [landlordId, propertyId, userId, s.id])
    expect((await shiftMoney(s.id)).expectedCents).toBe(10000)
  })

  it("another register's sales are not in this drawer", async () => {
    const a = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    const b = await openShift({ registerId: await register({ startingCents: 4000 }), userId: await another() })
    await cashSale(a.id, 100)
    await cashSale(b.id, 7)
    expect((await shiftMoney(a.id)).expectedCents).toBe(20000)
    expect((await shiftMoney(b.id)).expectedCents).toBe(4700)
  })
})

describe('counting it down', () => {
  it('records the variance and the drop, and leaves the starting cash behind', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)
    // Counted exactly right: $140 in the drawer.
    const closed = await closeShift({ shiftId: s.id, userId, countedCents: 14000 })
    expect(closed.expectedCents).toBe(14000)
    expect(closed.varianceCents).toBe(0)
    expect(closed.dropCents).toBe(4000)      // the $100 stays for the next shift
  })

  it('short is negative, over is positive', async () => {
    const short = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    await cashSale(short.id, 40)
    expect((await closeShift({ shiftId: short.id, userId, countedCents: 13500,
      varianceReason: 'came up short' })).varianceCents).toBe(-500)

    const over = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    await cashSale(over.id, 40)
    expect((await closeShift({ shiftId: over.id, userId, countedCents: 14300,
      varianceReason: 'found a five' })).varianceCents).toBe(300)
  })

  // 10/31 (Nic): "The cashier can always finish their shift." A small miss just
  // records; over the register's threshold it asks what happened first.
  it('a small difference closes with no questions', async () => {
    const id = await register({ startingCents: 10000, threshold: 500 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)
    const closed = await closeShift({ shiftId: s.id, userId, countedCents: 13997 })
    expect(closed.varianceCents).toBe(-3)
  })

  it('a big difference asks what happened, then closes', async () => {
    const id = await register({ startingCents: 10000, threshold: 500 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)
    await expect(closeShift({ shiftId: s.id, userId, countedCents: 12000 }))
      .rejects.toThrow(/\$20\.00 short/)
    // Still open — nothing was written.
    expect((await queryOne<any>(`SELECT status FROM pos_register_shifts WHERE id = $1`, [s.id]))!.status)
      .toBe('open')
    const closed = await closeShift({ shiftId: s.id, userId, countedCents: 12000,
      varianceReason: 'took a $20 for the propane guy, receipt in the drawer' })
    expect(closed.varianceCents).toBe(-2000)
    expect((await queryOne<any>(`SELECT variance_reason FROM pos_register_shifts WHERE id = $1`, [s.id]))!
      .variance_reason).toMatch(/propane/)
  })

  it('a register with no threshold never asks', async () => {
    const id = await register({ startingCents: 10000, threshold: null })
    const s = await openShift({ registerId: id, userId })
    expect((await closeShift({ shiftId: s.id, userId, countedCents: 1 })).varianceCents).toBe(-9999)
  })

  it('refuses when the bills and coins disagree with the total', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await expect(closeShift({ shiftId: s.id, userId, countedCents: 14000,
      countedBreakdown: { '10000': 1, '2000': 1 } }))     // $120, not $140
      .rejects.toThrow(/add up to \$120\.00/)
  })

  it('accepts a breakdown that does add up', async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await cashSale(s.id, 40)
    // five 5s and 75 1s plus a 20 and two quarters = $140.50... counted exactly.
    const closed = await closeShift({ shiftId: s.id, userId, countedCents: 14000,
      countedBreakdown: { '2000': 2, '500': 5, '100': 75 } })
    expect(closed.varianceCents).toBe(0)
  })

  it('cannot be counted twice', async () => {
    const id = await register({ startingCents: 10000, name: 'Store' })
    const s = await openShift({ registerId: id, userId })
    await closeShift({ shiftId: s.id, userId, countedCents: 10000 })
    await expect(closeShift({ shiftId: s.id, userId, countedCents: 10000 }))
      .rejects.toThrow(/already been counted/)
  })
})

// 10/31: the ring-sale endpoint must refuse a shift that is not open and at this
// property, rather than let the sale land in nobody's drawer and make somebody's
// count wrong at the end of their shift.
describe('a sale will not be rung into the wrong drawer', () => {
  it('refuses a closed shift and an unknown one', async () => {
    const id = await register({ startingCents: 10000, name: 'Counter' })
    const s = await openShift({ registerId: id, userId })
    await closeShift({ shiftId: s.id, userId, countedCents: 10000 })

    // The endpoint's own check, run directly against the same data.
    const closed = await queryOne<any>(
      `SELECT s.status, r.name FROM pos_register_shifts s JOIN pos_registers r ON r.id = s.register_id
        WHERE s.id = $1`, [s.id])
    expect(closed.status).toBe('closed')

    // And a sale already stamped to it is not counted again by a later shift.
    await cashSale(s.id, 25)
    const next = await openShift({ registerId: id, userId })
    expect((await shiftMoney(next.id)).expectedCents).toBe(10000)
  })

  it("a sale stamped to no shift is in nobody's drawer", async () => {
    const id = await register({ startingCents: 10000 })
    const s = await openShift({ registerId: id, userId })
    await query(
      `INSERT INTO pos_transactions
         (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status)
       VALUES ($1,$2,$3,'cash',60,0,60,'completed')`,
      [landlordId, propertyId, userId])
    expect((await shiftMoney(s.id)).expectedCents).toBe(10000)
  })
})

describe('the day settlement gets its drawer figures from the shifts', () => {
  it('sums the day\'s counted shifts, and only the closed ones', async () => {
    const ownProperty = propertyId
    const day = (await queryOne<{ d: string }>(
      `SELECT to_char((NOW() AT TIME ZONE COALESCE(timezone,'America/Phoenix'))::date,'YYYY-MM-DD') AS d
         FROM properties WHERE id = $1`, [ownProperty]))!.d
    await query(
      `INSERT INTO pos_eod_settlements (landlord_id, property_id, business_day, cash_sales, cash_refunds, status)
       VALUES ($1,$2,$3::date,0,0,'auto_closed')
       ON CONFLICT (landlord_id, property_id, business_day) DO NOTHING`,
      [landlordId, ownProperty, day])

    const mk = async (cents: number) => {
      const r = await queryOne<{ id: string }>(
        `INSERT INTO pos_registers
           (landlord_id, property_id, name, starting_cash_cents, starting_cash_confirmed_at,
            starting_cash_confirmed_by_user_id)
         VALUES ($1,$2,$3,$4,NOW(),$5) RETURNING id`,
        [landlordId, ownProperty, `R${cents}`, cents, userId])
      return r!.id
    }
    const one = await openShift({ registerId: await mk(10000), userId })
    const two = await openShift({ registerId: await mk(4000), userId: await another() })
    await closeShift({ shiftId: one.id, userId, countedCents: 15000 })
    // `two` stays open: an uncounted drawer must not be added in.
    let s = await queryOne<any>(
      `SELECT opening_float::float AS f, cash_drawer_actual::float AS a FROM pos_eod_settlements
        WHERE property_id = $1 AND business_day = $2::date`, [ownProperty, day])
    expect(s.f).toBe(100)
    expect(s.a).toBe(150)

    await closeShift({ shiftId: two.id, userId, countedCents: 4500 })
    s = await queryOne<any>(
      `SELECT opening_float::float AS f, cash_drawer_actual::float AS a FROM pos_eod_settlements
        WHERE property_id = $1 AND business_day = $2::date`, [ownProperty, day])
    expect(s.f).toBe(140)      // 100 + 40
    expect(s.a).toBe(195)      // 150 + 45
  })
})

// ── 10/31 (Nic): WHERE DID THE MONEY GO ──────────────────────────────────────
//
//   "There should be some sort of reconciliation built in to auto detect...
//    maybe a ticket stayed open, or kind of generate a lead on where that money
//    could possibly be... The bosses are going to want to know where that money
//    went, not just that it's gone."
// ── 10/31 (Nic): ONE PERSON, ONE DRAWER ──────────────────────────────────────
//
//   "We should have it where I can't ring sales on this register and the second
//    register. If I'm on the first register, that's it for the shift... Unless
//    you go through the countdown process and you close it out back to default
//    and then count in on a new register."
describe('one drawer per person', () => {
  it('refuses a second drawer while one is open, and names the one they are on', async () => {
    const first = await register({ startingCents: 10000, name: 'Register 1' })
    const second = await register({ startingCents: 4000, name: 'Register 2' })
    await openShift({ registerId: first, userId })
    await expect(openShift({ registerId: second, userId })).rejects.toThrow(/already on Register 1/)
  })

  it('lets them move after counting the first one down', async () => {
    const first = await register({ startingCents: 10000, name: 'Register 1' })
    const second = await register({ startingCents: 4000, name: 'Register 2' })
    const a = await openShift({ registerId: first, userId })
    await closeShift({ shiftId: a.id, userId, countedCents: 10000 })
    const b = await openShift({ registerId: second, userId })
    expect(b.openingCents).toBe(4000)
  })

  // His own case for why this is per person and not per property: a manager
  // covering a break opens their own drawer while the employee still holds theirs.
  it('two people can hold two drawers at once', async () => {
    const c = await db.connect()
    let other = ''
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      other = l.userId
      await c.query('COMMIT')
    } finally { c.release() }
    const employee = await register({ startingCents: 10000, name: 'Main' })
    const cover = await register({ startingCents: 4000, name: 'Break Cover' })
    await openShift({ registerId: employee, userId })
    const managers = await openShift({ registerId: cover, userId: other })
    expect(managers.openingCents).toBe(4000)
  })
})

describe('leads on a short drawer', () => {
  // These tests open a shift, write a row and close the shift inside one
  // millisecond, so a row stamped NOW() can land microseconds AFTER closed_at
  // and fall outside the window the lead finder searches. Every row is pinned
  // to the shift's own opening instant, which is inside by definition. A real
  // register never closes in the same microsecond as a sale.

  it('finds a cash sale that went into another drawer, and says which', async () => {
    const short = await openShift({ registerId: await register({ startingCents: 10000, name: 'Front' }), userId })
    const other = await openShift({ registerId: await register({ startingCents: 10000, name: 'Back Counter' }),
                                    userId: await another() })
    const stray0 = await queryOne<any>(
      `INSERT INTO pos_transactions
         (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status, register_shift_id)
       VALUES ($1,$2,$3,'cash',17.38,0,17.38,'completed',$4) RETURNING id`,
      [landlordId, propertyId, userId, other.id])
    await closeShift({ shiftId: short.id, userId, countedCents: 10000 - 1738, varianceReason: 'short' })
    await insideShift('pos_transactions', 'created_at', stray0.id, short.id)

    const leads = await varianceLeads(short.id)
    const stray = leads.find(l => l.kind === 'other_drawer' && l.amountCents === 1738)
    expect(stray).toBeTruthy()
    expect(stray!.explainsItExactly).toBe(true)
    expect(stray!.what).toMatch(/Back Counter/)
    expect(leads[0].explainsItExactly).toBe(true)      // exact matches lead
  })

  it('finds a ticket left open for the missing amount', async () => {
    const s = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    const t = await queryOne<any>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, pos_customer_id, items, status, note)
       VALUES ($1,$2,$3,$4,$5::jsonb,'open','Site 12 - ice and firewood') RETURNING id`,
      [landlordId, propertyId, userId, await posCustomer(), JSON.stringify([{ price: 12.5, qty: 2 }])])
    await closeShift({ shiftId: s.id, userId, countedCents: 10000 - 2500, varianceReason: 'short' })
    await insideShift('pos_open_tickets', 'created_at', t.id, s.id)

    const leads = await varianceLeads(s.id)
    const lead = leads.find(l => l.kind === 'open_ticket')
    expect(lead).toBeTruthy()
    expect(lead!.amountCents).toBe(2500)
    expect(lead!.explainsItExactly).toBe(true)
    expect(lead!.what).toMatch(/still open/)
    expect(lead!.what).toMatch(/firewood/)
  })

  it('finds a voided cash sale and does not accuse anybody', async () => {
    const s = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    const v0 = await queryOne<any>(
      `INSERT INTO pos_transactions
         (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total, status,
          void_reason, register_shift_id)
       VALUES ($1,$2,$3,'cash',30,0,30,'voided','rang it twice',$4) RETURNING id`,
      [landlordId, propertyId, userId, s.id])
    await closeShift({ shiftId: s.id, userId, countedCents: 13000, varianceReason: 'over' })
    await insideShift('pos_transactions', 'created_at', v0.id, s.id)

    const leads = await varianceLeads(s.id)
    const v = leads.find(l => l.kind === 'voided_sale')
    expect(v).toBeTruthy()
    expect(v!.amountCents).toBe(3000)
    expect(v!.what).toMatch(/rang it twice/)
    // Nic: it reports where the money could be, never who took it.
    expect(leads.some(l => /theft|stole|steal|took it/i.test(l.what))).toBe(false)
  })

  it('finds more change given than the sale was worth', async () => {
    const s = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    await query(
      `INSERT INTO pos_transactions
         (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, total,
          change_given, status, register_shift_id)
       VALUES ($1,$2,$3,'cash',4,0,4,40,'completed',$4)`,
      [landlordId, propertyId, userId, s.id])
    await closeShift({ shiftId: s.id, userId, countedCents: 10400 - 3600, varianceReason: 'short' })

    // This one needs no pinning: it is found by the shift stamp, not a window.
    const leads = await varianceLeads(s.id)
    const c = leads.find(l => l.kind === 'change_over_sale')
    expect(c).toBeTruthy()
    expect(c!.amountCents).toBe(3600)
    expect(c!.what).toMatch(/more than the sale/)
  })

  it('a drawer that balanced still lists what happened, with nothing called exact', async () => {
    const s = await openShift({ registerId: await register({ startingCents: 10000 }), userId })
    const t = await queryOne<any>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, pos_customer_id, items, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'open') RETURNING id`,
      [landlordId, propertyId, userId, await posCustomer(), JSON.stringify([{ price: 9, qty: 1 }])])
    await closeShift({ shiftId: s.id, userId, countedCents: 10000 })
    await insideShift('pos_open_tickets', 'created_at', t.id, s.id)

    const leads = await varianceLeads(s.id)
    expect(leads.length).toBeGreaterThan(0)
    expect(leads.every(l => l.explainsItExactly === false)).toBe(true)
  })
})
