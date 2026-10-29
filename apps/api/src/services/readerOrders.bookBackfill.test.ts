/**
 * 10/13 (Nic, afternoon) — migration 20261015160000: the card readers already
 * bought go into GAM's own book.
 *
 * "Book the $331.73 as an expense the day we buy it, and each $87.50 payment
 * as paying it back (lowers 'earned all time' until repaid)." Mountain View's
 * reader (order 288cc5df, the only one on production): bought from Stripe's
 * shop 9/28, $331.73, piece 1 of 4 billed 10/5 and collected. The migration
 * writes the purchase and the cost repaid exactly as the code does
 * (services/readerOrders bookReaderBook), once, with no double counting of a
 * markup row the 10/12 code already booked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { adminListReaderOrders, bookReaderBook } from './readerOrders'

const MV = '288cc5df-5153-4b1c-b5d4-71f15c5c43d9'
const MIGRATION = readFileSync(join(__dirname, '..', 'db', 'migrations', '20261015160000_reader_purchase_in_gams_book.sql'), 'utf8')

async function inTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
const migrate = () => inTx(c => c.query(MIGRATION))

beforeEach(async () => { await cleanupAllSchema() })

/** Mountain View as production has it on 10/13 — plus, if asked, the later pieces. */
async function mountainView(opts: { pieces?: number; demo?: boolean } = {}) {
  return inTx(async c => {
    const ll = await seedLandlord(c)
    if (opts.demo) await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [ll.landlordId])
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = 'Mountain View RV Ranch' WHERE id = $1`, [propertyId])
    await c.query(
      `INSERT INTO pos_reader_orders (id, landlord_id, property_id, status, model, price, installments, installment_amount,
                                      installments_raised, ship_name, ship_line1, ship_city, ship_state, ship_zip,
                                      created_at, ordered_at, shipped_at, registered_at)
       VALUES ($1, $2, $3, 'registered', 'stripe_reader_s710', 350, 4, 87.5, $4, 'Lisa S', '2843 East Frontage Road', 'Amado', 'AZ', '85645',
               '2026-09-28 14:36:53.497502-07', '2026-09-28 14:36:53.50696-07', '2026-09-29 15:04:28.196-07', '2026-10-05 17:29:13.038573-07')`,
      [MV, ll.landlordId, propertyId, opts.pieces ?? 1])
    await c.query(
      `INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount, note, source, created_at, effective_on)
       VALUES ($1, 299.00, 32.73, 'Nic 10/12: "331.73 after tax and shipping. 299 base."', 'backfill', '2026-10-13 05:24:53-07', '2026-09-28')`, [MV])
    const billed = ['2026-10-05 17:29:13.044058-07', '2026-11-01 01:30:00-07', '2026-12-01 01:30:00-07', '2027-01-01 01:30:00-07']
    const pieces: string[] = []
    for (let n = 1; n <= (opts.pieces ?? 1); n++) {
      pieces.push((await c.query(
        `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, collected_amount, collected_at, source_type,
                                           notes, created_at, reader_order_id, installment_number)
         VALUES ($1, $2, 'device_installment', 87.50, $3, $4, 'reader_order_installment', $5, $6, $7, $8) RETURNING id`,
        [ll.landlordId, propertyId, n === 1 ? 87.5 : 0, n === 1 ? '2026-10-05 18:00:02.926591-07' : null,
         `Card reader (Stripe Reader S710) — payment ${n} of 4`, billed[n - 1], MV, n])).rows[0].id)
    }
    // A platform fee booked on October 1st, before the reader rows are written for earlier days.
    await c.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_type, property_id, created_at)
       VALUES ('platform_fee_subscription', 82, 82, 'platform_fee_accrual', $1, '2026-10-01 01:30:00-07')`, [propertyId])
    return { ...ll, propertyId, pieces }
  })
}

const ledger = async () => (await db.query(
  `SELECT type, reference_type, reference_id, amount::text AS amount, balance_after::text AS balance_after, notes,
          to_char(created_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD HH24:MI:SS') AS at
     FROM platform_revenue_ledger ORDER BY created_at, (type = 'device_markup'), id`)).rows

describe('migration 20261015160000: the readers already bought, into GAM\'s own book', () => {
  it("Mountain View: −$331.73 the moment GAM bought it (9/28), +$87.50 the day piece 1 was billed (10/5), the running balance restated — once", async () => {
    await mountainView()
    await migrate()
    const rows = await ledger()
    expect(rows.map(r => [r.type, r.reference_type, r.amount, r.at, r.balance_after])).toEqual([
      ['adjustment', 'reader_purchase', '-331.73', '2026-09-28 14:36:53', '-331.73'],
      ['platform_fee_subscription', 'platform_fee_accrual', '82.00', '2026-10-01 01:30:00', '-249.73'],
      ['adjustment', 'reader_cost_repaid', '87.50', '2026-10-05 17:29:13', '-162.23'],
    ])
    expect(rows[0].notes).toBe("Card reader bought — Mountain View RV Ranch: GAM's cost $331.73 (base $299.00, tax and shipping $32.73)")
    expect(rows[2].notes).toBe("Card reader cost repaid — Mountain View RV Ranch, payment 1 of 4 ($87.50 of GAM's $331.73 cost)")
    // Run twice: nothing more. The code finds nothing to write either — the same rows it would have written.
    await migrate()
    expect(await ledger()).toEqual(rows)
    expect(await inTx(c => bookReaderBook(c))).toBe(0)
    expect((await adminListReaderOrders(MV))[0]).toMatchObject({
      purchase_booked: -331.73, cost_repaid_booked: 87.5, markup_booked: 0, booked_total: -244.23,
      still_to_repay: 244.23, not_booked: 0, cost_booked: true,
    })
  })

  it('the code books the rest from there: pieces 2-4, the markup in piece 4 — and nothing twice', async () => {
    const mv = await mountainView({ pieces: 4 })
    await migrate()
    expect((await ledger()).filter(r => r.type === 'device_markup')).toEqual([])   // the migration never writes markup
    expect(await inTx(c => bookReaderBook(c))).toBe(1)                              // the code: piece 4's $18.27
    const rows = await ledger()
    expect(rows.filter(r => r.reference_id === mv.pieces[3]).map(r => [r.type, r.amount])).toEqual([
      ['adjustment', '69.23'], ['device_markup', '18.27'],
    ])
    expect((await adminListReaderOrders(MV))[0]).toMatchObject({ booked_total: 18.27, still_to_repay: 0, not_booked: 0 })
  })

  it("a piece whose markup the 10/12 code already booked gets only the rest of it as cost repaid — no double counting", async () => {
    const mv = await mountainView({ pieces: 4 })
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, created_at)
       VALUES ('device_markup', 18.27, 100.27, $1, 'reader_order_installment', '2027-01-01 01:30:00-07')`, [mv.pieces[3]])
    await migrate()
    const rows = await ledger()
    expect(rows.filter(r => r.reference_id === mv.pieces[3]).map(r => [r.type, r.amount])).toEqual([
      ['adjustment', '69.23'], ['device_markup', '18.27'],
    ])
    expect(rows.filter(r => r.reference_type === 'reader_cost_repaid').map(r => r.amount)).toEqual(['87.50', '87.50', '87.50', '69.23'])
    // The running balance is a running balance again, from the earliest reader row on — in the
    // ledger's own order (created_at, id), the order every writer reads "the latest row" in.
    let run = 0
    const inOrder = (await db.query(`SELECT amount, balance_after FROM platform_revenue_ledger ORDER BY created_at, id`)).rows
    for (const r of inOrder) { run = Math.round((run + Number(r.amount)) * 100) / 100; expect(Number(r.balance_after)).toBe(run) }
    expect(await inTx(c => bookReaderBook(c))).toBe(0)
    expect((await adminListReaderOrders(MV))[0]).toMatchObject({ booked_total: 18.27, not_booked: 0 })
  })

  it("a demo account's reader is never written", async () => {
    await mountainView({ demo: true })
    await migrate()
    expect((await ledger()).filter(r => r.type !== 'platform_fee_subscription')).toEqual([])
  })

  // 10/13 (review): the correction branch — each later entry books the difference from the one
  // before it (LAG), on its own day, worded as the code words it.
  /** Two corrections after the 10/12 figure: $5.00 more shipping typed 10/10 (dated that day), a $10.00 refund typed 10/12 dated 10/11. */
  async function corrections() {
    await db.query(
      `INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_amount, shipping_amount, note, source, created_at, effective_on)
       VALUES ($1, 299.00, 21.78, 15.95, 'extra shipping', 'desk', '2026-10-10 15:00:00-07', '2026-10-10')`, [MV])
    await db.query(
      `INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount, source, created_at, effective_on)
       VALUES ($1, 299.00, 27.73, 'desk', '2026-10-12 09:00:00-07', '2026-10-11')`, [MV])
  }
  const asWritten = (rows: any[]) => rows.map(r => [r.type, r.reference_type, r.amount, r.at, r.notes])

  it('a cost corrected before the code ships: each correction is the difference on its own day, and the migration writes exactly what the code writes', async () => {
    await mountainView()
    await corrections()
    await migrate()
    const rows = (await ledger()).filter(r => r.reference_type === 'reader_purchase')
    expect(rows.map(r => [r.amount, r.at])).toEqual([
      ['-331.73', '2026-09-28 14:36:53'],   // the moment GAM bought it
      ['-5.00', '2026-10-10 15:00:00'],     // typed on its own day: the moment it was typed
      ['10.00', '2026-10-11 12:00:00'],     // typed the next day: noon on its day
    ])
    expect(rows[1].notes).toBe("Card reader cost corrected — Mountain View RV Ranch: $331.73 → $336.73 (base $299.00, tax $21.78, shipping $15.95) from 2026-10-10 (extra shipping) — $5.00 more")
    expect(rows[2].notes).toBe("Card reader cost corrected — Mountain View RV Ranch: $336.73 → $326.73 (base $299.00, tax and shipping $27.73) from 2026-10-11 — $10.00 back to GAM")
    // Piece 1 (billed 10/5) is split under the figure in force that day: $331.73, all of it cost.
    expect((await ledger()).filter(r => r.reference_type === 'reader_cost_repaid').map(r => r.amount)).toEqual(['87.50'])
    const byMigration = asWritten(await ledger())
    expect(await inTx(c => bookReaderBook(c))).toBe(0)
    expect((await adminListReaderOrders(MV))[0]).toMatchObject({ purchase_booked: -326.73, booked_total: -239.23, not_booked: 0 })
    // The same state, written by the code alone: the same rows, word for word.
    await cleanupAllSchema()
    await mountainView()
    await corrections()
    expect(await inTx(c => bookReaderBook(c))).toBe(4)
    expect(asWritten(await ledger()).filter(r => r[0] !== 'platform_fee_subscription'))
      .toEqual(byMigration.filter(r => r[0] !== 'platform_fee_subscription'))
  })

  it('an order GAM never bought is left out — a request with a cost typed (the 10/13-morning desk allowed it), and one cancelled before anyone ordered it', async () => {
    const mv = await mountainView()
    const other = async (status: string) => (await db.query(
      `INSERT INTO pos_reader_orders (landlord_id, property_id, status, model, price, installments, installment_amount,
                                      ship_name, ship_line1, ship_city, ship_state, ship_zip, created_at, cancelled_at)
       VALUES ($1, $2, $3, 'stripe_reader_s710', 350, 4, 87.5, 'Lisa S', '1 Road', 'Amado', 'AZ', '85645',
               '2026-10-01 09:00:00-07', CASE WHEN $3 = 'cancelled' THEN '2026-10-02 09:00:00-07'::timestamptz END) RETURNING id`,
      [mv.landlordId, mv.propertyId, status])).rows[0].id
    for (const id of [await other('requested'), await other('cancelled')]) {
      await db.query(
        `INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount, source, created_at, effective_on)
         VALUES ($1, 299.00, 32.73, 'desk', '2026-10-03 09:00:00-07', '2026-10-03')`, [id])
    }
    await migrate()
    // Only Mountain View's: its purchase and its piece.
    expect((await ledger()).filter(r => r.type !== 'platform_fee_subscription').map(r => [r.reference_type, r.amount])).toEqual([
      ['reader_purchase', '-331.73'], ['reader_cost_repaid', '87.50'],
    ])
    expect(await inTx(c => bookReaderBook(c))).toBe(0)
  })
})
