/**
 * S652 — card readers on a plan: the request, the desk, the monthly pieces.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { installmentSplit, SUPPORTED_CARD_READER } from '@gam/shared'

vi.mock('./posTerminal', () => ({ getOrCreatePropertyLocation: vi.fn(async () => 'tml_test') }))
// 10/5: what Stripe says is at a property's location. Default: nothing.
const stripeReaders = vi.fn(async (_q: any): Promise<any> => ({ data: [] }))
vi.mock('../lib/stripe', () => ({ getStripe: () => ({ terminal: { readers: { list: (q: any) => stripeReaders(q) } } }) }))
const adminNote = vi.fn(async (_o: any) => {})
vi.mock('./adminNotifications', () => ({ createAdminNotification: (o: any) => adminNote(o) }))
import { requestReader, cancelReaderRequest, adminUpdateReaderOrder, raiseDueInstallments, listReaderOrders, chaseReaderOrders, syncReadersFromStripe,
  recordReaderOrderCost, adminListReaderOrders, readerBookFacts, bookReaderBook } from './readerOrders'
import { readFileSync } from 'fs'
import { join } from 'path'
import { READER_ORDER_COST_SOURCES } from '@gam/shared'

beforeEach(async () => {
  await cleanupAllSchema(); adminNote.mockClear()
  stripeReaders.mockReset(); stripeReaders.mockImplementation(async () => ({ data: [] }))
})

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query('COMMIT')
    return { ...ll, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
const shipTo = { name: 'Lisa S', line1: '2843 East Frontage Road', city: 'Amado', state: 'AZ', zip: '85645' }

describe('installmentSplit', () => {
  it('splits to the cent with the remainder on the last piece', () => {
    expect(installmentSplit(350, 4)).toEqual([87.5, 87.5, 87.5, 87.5])
    expect(installmentSplit(331.73, 4)).toEqual([82.93, 82.93, 82.93, 82.94])
    expect(installmentSplit(10, 3).reduce((a, b) => a + b, 0)).toBeCloseTo(10, 2)
  })
})

describe('a landlord asks for the one reader we support', () => {
  it('records the request with the plan, and refuses a second one for the same property', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    expect(o.model).toBe(SUPPORTED_CARD_READER.model)
    expect(Number(o.price)).toBe(350); expect(o.installments).toBe(4); expect(Number(o.installment_amount)).toBe(87.5)
    await expect(requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId }))
      .rejects.toThrow(/already on its way/)
    const mine = await listReaderOrders(w.landlordId, w.propertyId)
    expect(mine).toHaveLength(1)
    await cancelReaderRequest(w.landlordId, o.id)
    const again = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    expect(again.id).not.toBe(o.id)
  })

  // 10/5 (Nic): "It's the first of each month following shipment." Shipped in
  // September → October, November, December, January. Nothing in the ship month.
  it('nothing is owed in the month it ships; one piece on the 1st of each month after, each its own line', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_123' })
    await adminUpdateReaderOrder(o.id, { status: 'shipped', serial: 'WSC123', trackingUrl: 'https://ups.example/1' })
    let charges = await db.query(`SELECT * FROM landlord_gam_charges WHERE landlord_id=$1`, [w.landlordId])
    expect(charges.rows).toHaveLength(0)     // the ship month owes nothing
    // Ship it on September 29th: October 1st is piece 1.
    await db.query(`UPDATE pos_reader_orders SET shipped_at = '2026-09-29T15:00:00Z' WHERE id=$1`, [o.id])
    expect(await raiseDueInstallments(new Date('2026-09-30T12:00:00Z'))).toBe(0)
    expect(await raiseDueInstallments(new Date('2026-10-01T12:00:00Z'))).toBe(1)
    charges = await db.query(`SELECT kind, amount, notes FROM landlord_gam_charges WHERE landlord_id=$1 ORDER BY created_at`, [w.landlordId])
    expect(charges.rows).toHaveLength(1)
    expect(charges.rows[0].kind).toBe('device_installment')
    expect(Number(charges.rows[0].amount)).toBe(87.5)
    expect(charges.rows[0].notes).toMatch(/payment 1 of 4/)
    expect(await raiseDueInstallments(new Date('2026-10-20T12:00:00Z'))).toBe(0)   // same month: nothing more
    expect(await raiseDueInstallments(new Date('2026-11-01T12:00:00Z'))).toBe(1)   // November
    expect(await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))).toBe(2)   // December + January
    expect(await raiseDueInstallments(new Date('2027-06-01T12:00:00Z'))).toBe(0)   // done
    charges = await db.query(`SELECT amount FROM landlord_gam_charges WHERE landlord_id=$1`, [w.landlordId])
    expect(charges.rows).toHaveLength(4)
    expect(charges.rows.reduce((a: number, r: any) => a + Number(r.amount), 0)).toBe(350)
  })

  // 10/12 (Nic, ledger P0): each piece names its order and its number, so the
  // books can clear the reader piece by piece — and a piece can never be
  // raised twice.
  it('each piece names its order and which piece it is, once', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered' })
    await adminUpdateReaderOrder(o.id, { status: 'shipped' })
    await db.query(`UPDATE pos_reader_orders SET shipped_at = '2026-09-29T15:00:00Z' WHERE id=$1`, [o.id])
    expect(await raiseDueInstallments(new Date('2026-11-02T12:00:00Z'))).toBe(2)
    const { rows } = await db.query(
      `SELECT reader_order_id, installment_number, source_type, source_id
         FROM landlord_gam_charges WHERE landlord_id = $1 ORDER BY installment_number`, [w.landlordId])
    expect(rows).toEqual([
      { reader_order_id: o.id, installment_number: 1, source_type: 'reader_order_installment', source_id: null },
      { reader_order_id: o.id, installment_number: 2, source_type: 'reader_order_installment', source_id: null },
    ])
    // The same piece again is refused by the database, whatever the counter says.
    await expect(db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, reader_order_id, installment_number)
       VALUES ($1, $2, 'device_installment', 87.5, 'reader_order_installment', $3, 2)`,
      [w.landlordId, w.propertyId, o.id])).rejects.toThrow()
  })
})

// S652 (Nic): "I don't want to have to manually look somewhere and say, oh, I
// missed this notification." The request reaches GAM the moment it is made,
// and the morning chase keeps coming until the row is handled.
describe('a request cannot sit unseen', () => {
  it('alerts GAM at once with what the Stripe shop needs', async () => {
    const w = await world()
    await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    expect(adminNote).toHaveBeenCalledTimes(1)
    const n = adminNote.mock.calls[0][0]
    expect(n.category).toBe('reader_order_requested')
    expect(n.emailSuperAdmins).toBe(true)
    expect(n.body).toMatch(/Stripe Reader S710/)
    expect(n.body).toMatch(/2843 East Frontage Road/)
    expect(n.body).toMatch(/standard shipping/i)
  })

  it('chases every morning while it waits — one digest — and goes quiet once handled', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    adminNote.mockClear()
    const day2 = new Date(Date.now() + 2 * 86400000)
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 1, sent: true })
    expect(adminNote).toHaveBeenCalledTimes(1)
    expect(adminNote.mock.calls[0][0].body).toMatch(/NOT ORDERED/)
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)   // the receipt, typed (10/13)
    adminNote.mockClear()
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 0, sent: false })   // ordered, within 3 days
    const day6 = new Date(Date.now() + 6 * 86400000)
    const r = await chaseReaderOrders(day6)
    expect(r.sent).toBe(true)
    expect(adminNote.mock.calls[0][0].body).toMatch(/CHECK STRIPE/)
    await adminUpdateReaderOrder(o.id, { status: 'registered', serial: 'WSC1' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(day6)).toEqual({ waiting: 0, sent: false })
  })

  // 10/13 (Nic): "flag missing cost in the morning admin email."
  it('a reader GAM bought with no cost entered is flagged every morning — registered or not — until the cost is typed', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    adminNote.mockClear()
    const day2 = new Date(Date.now() + 2 * 86400000)
    // A request nobody has ordered: GAM has bought nothing yet — only NOT ORDERED.
    await chaseReaderOrders(day2)
    expect(adminNote.mock.calls[0][0].body).not.toMatch(/NO COST ENTERED/)
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 1, sent: true })
    const n = adminNote.mock.calls[0][0]
    expect(n.emailSuperAdmins).toBe(true)
    expect(n.body).toMatch(/^NO COST ENTERED — .*: ordered [12] day\(s\) ago .*Stripe shop receipt/)
    // Registered and in use: still flagged, its pieces keep billing.
    await adminUpdateReaderOrder(o.id, { status: 'registered', serial: 'WSC1' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 1, sent: true })
    expect(adminNote.mock.calls[0][0].body).toMatch(/NO COST ENTERED/)
    // The receipt typed: quiet.
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    adminNote.mockClear()
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 0, sent: false })
    expect(adminNote).not.toHaveBeenCalled()
  })

  it('a request cancelled before anyone ordered it is not flagged for its cost', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'cancelled' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(new Date(Date.now() + 2 * 86400000))).toEqual({ waiting: 0, sent: false })
  })

  // 10/13 (review): GAM paid the shop when it ordered — cancelling afterwards does not unbuy it.
  it('a reader cancelled after GAM ordered it is still flagged until its cost is typed', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    await adminUpdateReaderOrder(o.id, { status: 'cancelled' })
    adminNote.mockClear()
    const day2 = new Date(Date.now() + 2 * 86400000)
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 1, sent: true })
    expect(adminNote.mock.calls[0][0].body).toMatch(/^NO COST ENTERED — .*: ordered [12] day\(s\) ago \(cancelled since\) and what the reader cost GAM/)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    adminNote.mockClear()
    expect(await chaseReaderOrders(day2)).toEqual({ waiting: 0, sent: false })
  })

  // 10/13 (review): the title counts orders, not lines.
  it('one order on two lines (not in use, and no cost) is one order waiting', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    await adminUpdateReaderOrder(o.id, { status: 'shipped' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(new Date(Date.now() + 12 * 86400000))).toEqual({ waiting: 1, sent: true })
    const n = adminNote.mock.calls[0][0]
    expect(n.body.split('\n').map((l: string) => l.split(' — ')[0])).toEqual(['NOT IN USE', 'NO COST ENTERED'])
    expect(n.title).toBe('1 card reader order waiting on GAM')
    expect(n.context).toEqual({ count: 1 })
  })
})

// 10/5 (Nic): "the card reader arrived on Friday and it's been set up and used
// for several days now... the system should be detecting that it's already
// active and in use." Mountain View's order sat at Ordered with no serial while
// its reader took card sales, and the morning email asked for the serial daily.
describe('the order finds its reader — nobody types a serial', () => {
  async function placed(w: any) {
    await db.query(`UPDATE properties SET stripe_terminal_location_id = 'tml_mv' WHERE id = $1`, [w.propertyId])
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_mv' })
    // 10/13: GAM types the receipt when it orders (a reader with no cost is its own line in the email).
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    adminNote.mockClear()
    return o
  }
  const orderRow = async (id: string) => (await db.query(
    `SELECT status, serial, stripe_reader_id, shipped_at, registered_at, installments_raised FROM pos_reader_orders WHERE id = $1`, [id])).rows[0]
  const day = (n: number) => new Date(Date.now() + n * 86400000)

  it('a reader that turns up at the property after the order ships the order, with Stripe\u2019s serial', async () => {
    const w = await world(); const o = await placed(w)
    stripeReaders.mockImplementation(async () => ({ data: [{ id: 'tmr_mv', serial_number: 'STR71Z1H614000756', label: null, status: null, last_seen_at: null }] }))
    await syncReadersFromStripe(w.landlordId, w.propertyId)
    const r = await orderRow(o.id)
    expect(r).toMatchObject({ status: 'shipped', serial: 'STR71Z1H614000756', stripe_reader_id: 'tmr_mv' })
    expect(r.shipped_at).not.toBeNull()
    // shipped → nothing in the ship month; the plan's first piece next month
    expect(await raiseDueInstallments(new Date())).toBe(0)
    const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 2)
    expect(await raiseDueInstallments(next)).toBe(1)
  })

  it('an order matched after its ship month charges the piece already due at once — not two on the next 1st', async () => {
    const w = await world(); const o = await placed(w)
    // Ordered and shipped last month; the reader is first matched now.
    await db.query(`UPDATE pos_reader_orders SET ordered_at = date_trunc('month', NOW()) - interval '20 days',
                                                created_at = date_trunc('month', NOW()) - interval '20 days' WHERE id = $1`, [o.id])
    await db.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, created_at)
                    VALUES ($1,$2,'tmr_mv','Desk', date_trunc('month', NOW()) - interval '15 days')`, [w.landlordId, w.propertyId])
    stripeReaders.mockImplementation(async () => ({ data: [{ id: 'tmr_mv', serial_number: 'S1', label: null, status: null, last_seen_at: null }] }))
    await syncReadersFromStripe(w.landlordId, w.propertyId)
    expect((await orderRow(o.id)).installments_raised).toBe(1)
    const { rows } = await db.query(`SELECT amount::text AS amount FROM landlord_gam_charges WHERE landlord_id = $1 AND kind = 'device_installment'`, [w.landlordId])
    expect(rows.map((r: any) => r.amount)).toEqual(['87.50'])
  })

  it('once Stripe has seen it switched on, the order is done and the morning email stays quiet', async () => {
    const w = await world(); const o = await placed(w)
    stripeReaders.mockImplementation(async () => ({ data: [{ id: 'tmr_mv', serial_number: 'S1', label: 'Front desk', status: 'online', last_seen_at: Date.now() }] }))
    const r = await chaseReaderOrders(day(7))
    expect(r).toEqual({ waiting: 0, sent: false })
    expect(adminNote).not.toHaveBeenCalled()
    expect(await orderRow(o.id)).toMatchObject({ status: 'registered', stripe_reader_id: 'tmr_mv', serial: 'S1' })
  })

  it('with Stripe unreachable, a reader already on file after the order still ships it — no "has it shipped?"', async () => {
    const w = await world(); const o = await placed(w)
    await db.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname) VALUES ($1,$2,'tmr_local','Desk')`,
      [w.landlordId, w.propertyId])
    stripeReaders.mockImplementation(async () => { throw new Error('stripe down') })
    await chaseReaderOrders(day(5))
    expect(await orderRow(o.id)).toMatchObject({ status: 'shipped', stripe_reader_id: 'tmr_local' })
    const lines = adminNote.mock.calls.map(c => c[0].body).join('\n')
    expect(lines).not.toMatch(/CHECK STRIPE/)
  })

  it('a reader the property already had before the order is never taken for the new one', async () => {
    const w = await world()
    await db.query(`UPDATE properties SET stripe_terminal_location_id = 'tml_mv' WHERE id = $1`, [w.propertyId])
    await db.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, created_at)
                    VALUES ($1,$2,'tmr_old','Old', NOW() - interval '30 days')`, [w.landlordId, w.propertyId])
    const o = await placed(w)
    await syncReadersFromStripe(w.landlordId, w.propertyId)
    expect(await orderRow(o.id)).toMatchObject({ status: 'ordered', stripe_reader_id: null })
    const r = await chaseReaderOrders(day(5))
    expect(r.sent).toBe(true)
    expect(adminNote.mock.calls[0][0].body).toMatch(/CHECK STRIPE/)
  })

  it('shipped but never switched on after ten days still asks whether it arrived', async () => {
    const w = await world(); const o = await placed(w)
    stripeReaders.mockImplementation(async () => ({ data: [{ id: 'tmr_mv', serial_number: 'S2', label: null, status: null, last_seen_at: null }] }))
    await syncReadersFromStripe(w.landlordId, w.propertyId)
    expect((await orderRow(o.id)).status).toBe('shipped')
    const r = await chaseReaderOrders(day(12))
    expect(r.sent).toBe(true)
    expect(adminNote.mock.calls[0][0].body).toMatch(/NOT IN USE/)
  })
})

// 10/12 (Nic): "331.73 after tax and shipping. 299 base. those orders are going
// to need to be tracked because shipping will vary." And (Q-g) "COST FIRST —
// pieces repay GAM's cost first; the markup lands in the last piece(s)."
// Mountain View: 4 × $87.50 against $331.73 → pieces 1-3 all cost, piece 4
// $69.23 cost + $18.27 markup. Only the markup is GAM's earnings.
describe("GAM's cost of each reader, and the markup it earns", () => {
  async function shippedOrder(w: any, shippedAt = '2026-09-29T15:00:00Z') {
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    return { o, ship: async () => {
      await db.query(`UPDATE pos_reader_orders SET status = 'shipped', shipped_at = $2 WHERE id = $1`, [o.id, shippedAt])
    } }
  }
  const markupRows = async (landlordId: string) => (await db.query(
    `SELECT r.amount::text AS amount, r.reference_type, g.installment_number AS n, r.created_at, g.created_at AS billed_at
       FROM platform_revenue_ledger r JOIN landlord_gam_charges g ON g.id = r.reference_id
      WHERE r.type = 'device_markup' AND g.landlord_id = $1 ORDER BY g.installment_number`, [landlordId])).rows

  it('the desk records base, tax and shipping; shows charged, cost and markup; and keeps every entry', async () => {
    const w = await world()
    const { o } = await shippedOrder(w)
    let row = (await adminListReaderOrders(o.id))[0]
    expect(row).toMatchObject({ charged: 350, cost_total: null, markup: null, loss: null, cost_booked: false })
    await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 15.95, note: 'first guess' }, w.userId)
    row = await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 10.95 }, w.userId)
    expect(row).toMatchObject({
      cost_base_price: 299, cost_tax: 21.78, cost_shipping: 10.95, cost_tax_and_shipping: null,
      cost_total: 331.73, charged: 350, markup: 18.27,
    })
    // Every entry kept, newest first, with who typed it.
    expect(row.cost_history.map((h: any) => Number(h.total))).toEqual([331.73, 336.73])
    expect(row.cost_history[1]).toMatchObject({ note: 'first guess', source: 'desk' })
    expect(row.cost_history[0].entered_by_email).toMatch(/@test\.dev$/)
    // 10/13: both dated — the first the day GAM ordered it, the typo fixed the same day (on or after it: allowed).
    expect(row.cost_history.map((h: any) => h.effective_on)).toEqual([row.cost_effective_on, row.cost_effective_on])
    // The plan, cost first.
    expect(row.pieces.map((p: any) => [p.n, p.cost, p.markup, p.billed])).toEqual([
      [1, 87.5, 0, false], [2, 87.5, 0, false], [3, 87.5, 0, false], [4, 69.23, 18.27, false],
    ])
    // An entry is never edited, never deleted, and its order is never deleted out from under it (10/12 review).
    await expect(db.query(`UPDATE pos_reader_order_costs SET base_price = 1 WHERE reader_order_id = $1`, [o.id])).rejects.toThrow(/never edited/)
    await expect(db.query(`DELETE FROM pos_reader_order_costs WHERE reader_order_id = $1`, [o.id])).rejects.toThrow(/never deleted/)
    await expect(db.query(`DELETE FROM pos_reader_orders WHERE id = $1`, [o.id])).rejects.toThrow(/foreign key/)
    expect((await adminListReaderOrders(o.id))[0].cost_history).toHaveLength(2)
  })

  it('refuses tax and shipping both split and combined', async () => {
    const w = await world()
    const { o } = await shippedOrder(w)
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, tax: 1, taxAndShipping: 32.73 }, w.userId)).rejects.toThrow(/not both/)
    await expect(recordReaderOrderCost(o.id, { basePrice: -1 }, w.userId)).rejects.toThrow(/zero or more/)
  })

  // 10/13 (Nic): "allow dated cost corrections" — a receipt that changes after shipping (a refund,
  // extra shipping): the old number is kept on record, the new one applies from its date. This
  // replaces 10/12's "fixed once markup is booked".
  async function pastOrder(w: any) {
    // Asked for May 10th, bought from Stripe May 11th, shipped May 20th; pieces June 1st – September 1st.
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await db.query(`UPDATE pos_reader_orders SET status = 'shipped', created_at = '2026-05-10T17:00:00Z',
                           ordered_at = '2026-05-11T17:00:00Z', shipped_at = '2026-05-20T17:00:00Z' WHERE id = $1`, [o.id])
    expect(await raiseDueInstallments(new Date('2026-09-02T12:00:00Z'))).toBe(4)
    await db.query(`UPDATE landlord_gam_charges SET created_at = make_timestamptz(2026, 5 + installment_number, 1, 15, 0, 0, 'UTC')
                     WHERE reader_order_id = $1`, [o.id])
    return o
  }
  const bookRows = async (orderId: string) => (await db.query(
    `SELECT r.type, r.amount::text AS amount, r.reference_type, to_char(r.created_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD') AS day, r.notes
       FROM platform_revenue_ledger r
      WHERE r.reference_id IN (SELECT id FROM landlord_gam_charges WHERE reader_order_id = $1
                               UNION ALL SELECT id FROM pos_reader_order_costs WHERE reader_order_id = $1)
      ORDER BY r.created_at, (r.type = 'device_markup'), r.id`, [orderId])).rows

  // 10/13 (Nic, afternoon): FULL PURCHASE — "Book the $331.73 as an expense the day we buy it, and
  // each $87.50 payment as paying it back (lowers 'earned all time' until repaid)."
  const kinds = (rows: any[]) => rows.map((r: any) =>
    [r.type === 'device_markup' ? 'markup' : r.reference_type === 'reader_purchase' ? 'purchase' : 'cost_repaid', r.amount, r.day])

  it("the purchase is GAM's expense the day GAM bought it, each piece pays it back as billed, and the markup lands once it is repaid", async () => {
    const w = await world()
    const o = await pastOrder(w)
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(kinds(await bookRows(o.id))).toEqual([
      ['purchase', '-331.73', '2026-05-11'],
      ['cost_repaid', '87.50', '2026-06-01'], ['cost_repaid', '87.50', '2026-07-01'], ['cost_repaid', '87.50', '2026-08-01'],
      ['cost_repaid', '69.23', '2026-09-01'], ['markup', '18.27', '2026-09-01'],
    ])
    // The purchase is dated the moment GAM ordered it from Stripe (May 11th, 10 am Arizona).
    const [purchase] = (await db.query(`SELECT r.created_at, r.notes FROM platform_revenue_ledger r
                                          WHERE r.type = 'adjustment' AND r.reference_type = 'reader_purchase'`)).rows
    expect(new Date(purchase.created_at).toISOString()).toBe('2026-05-11T17:00:00.000Z')
    expect(purchase.notes).toMatch(/Card reader bought — .*: GAM's cost \$331\.73 \(base \$299\.00, tax and shipping \$32\.73\)/)
    expect(row).toMatchObject({
      cost_booked: true, purchase_booked: -331.73, cost_repaid_booked: 331.73, markup_booked: 18.27,
      booked_total: 18.27, still_to_repay: 0, not_booked: 0,
    })
    expect(row.book.map((b: any) => [b.kind, b.amount, b.n])).toEqual([
      ['purchase', -331.73, null], ['cost_repaid', 87.5, 1], ['cost_repaid', 87.5, 2], ['cost_repaid', 87.5, 3],
      ['cost_repaid', 69.23, 4], ['markup', 18.27, 4],
    ])
    expect(row.pieces.map((p: any) => [p.n, p.cost_repaid_booked, p.markup_booked])).toEqual([[1, 87.5, 0], [2, 87.5, 0], [3, 87.5, 0], [4, 69.23, 18.27]])
    // Again: nothing doubles.
    await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))
    await chaseReaderOrders(new Date('2027-02-01T15:00:00Z'))
    expect(await bookRows(o.id)).toHaveLength(6)
  })

  it('a dated correction books the difference on its own date; the figure before it and every booked row stay', async () => {
    const w = await world()
    const o = await pastOrder(w)
    let row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(row).toMatchObject({ cost_total: 331.73, cost_effective_on: '2026-05-11', markup: 18.27, loss: 0, booked_total: 18.27, not_booked: 0, cost_booked: true })
    // October 1st: $5.00 more shipping turns up — $5.00 more expense on October 1st. September's
    // pieces stay as booked.
    row = await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 15.95, effectiveOn: '2026-10-01', note: 'extra shipping' }, w.userId)
    expect(row).toMatchObject({ cost_total: 336.73, cost_effective_on: '2026-10-01', markup: 13.27, booked_total: 13.27, not_booked: 0, still_to_repay: 5 })
    expect(row.cost_history.map((h: any) => [Number(h.total), h.effective_on])).toEqual([[336.73, '2026-10-01'], [331.73, '2026-05-11']])
    const after = await bookRows(o.id)
    expect(kinds(after).filter(k => k[0] === 'purchase')).toEqual([['purchase', '-331.73', '2026-05-11'], ['purchase', '-5.00', '2026-10-01']])
    expect(after.find((r: any) => r.amount === '-5.00').notes)
      .toMatch(/Card reader cost corrected — .*: \$331\.73 → \$336\.73 \(base \$299\.00, tax \$21\.78, shipping \$15\.95\) from 2026-10-01 \(extra shipping\) — \$5\.00 more/)
    expect(kinds(after).filter(k => k[0] !== 'purchase')).toEqual([
      ['cost_repaid', '87.50', '2026-06-01'], ['cost_repaid', '87.50', '2026-07-01'], ['cost_repaid', '87.50', '2026-08-01'],
      ['cost_repaid', '69.23', '2026-09-01'], ['markup', '18.27', '2026-09-01'],
    ])
    // Never reaching back before the figure it corrects — on the desk, and at the table.
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 30, effectiveOn: '2026-09-30' }, w.userId))
      .rejects.toThrow(/on or after 2026-10-01/)
    await expect(db.query(`INSERT INTO pos_reader_order_costs (reader_order_id, base_price, effective_on) VALUES ($1, 250, '2026-09-30')`, [o.id]))
      .rejects.toThrow(/applies from its own date/)
    // A refund of $10.00 today: $10.00 back to GAM, today.
    row = await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 5.95 }, w.userId)
    expect(row).toMatchObject({ cost_total: 326.73, markup: 23.27, purchase_booked: -326.73, booked_total: 23.27, not_booked: 0, still_to_repay: 0 })
    expect((await bookRows(o.id)).filter((r: any) => r.reference_type === 'reader_purchase').map((r: any) => r.amount))
      .toEqual(['-331.73', '-5.00', '10.00'])
    // The same figure again changes nothing; the monthly run changes nothing.
    await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 5.95 }, w.userId)
    await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))
    expect(await bookRows(o.id)).toHaveLength(8)
    // GAM's records for the bridge: what GAM paid now, and the pieces billed.
    expect(await readerBookFacts()).toEqual({ bought: 326.73, billed: 350, collected: 0, costRepaidCollected: 0, markupCollected: 0 })
  })

  it('a typo fixed with the date of the figure it fixes: the book comes to what the reader earns, and no piece is booked twice', async () => {
    const w = await world()
    const o = await pastOrder(w)
    // The typo ($361.20, a loss): every piece is cost repaid, $11.20 short.
    let row = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(row).toMatchObject({ booked_total: -11.2, markup_booked: 0, still_to_repay: 11.2 })
    // Fixed with the typo's own date (May 11th): $29.47 back on May 11th; the pieces stay as booked.
    row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73, effectiveOn: '2026-05-11' }, w.userId)
    expect(row).toMatchObject({ markup: 18.27, loss: 0, booked_total: 18.27, purchase_booked: -331.73, cost_repaid_booked: 350, not_booked: 0, still_to_repay: 0 })
    expect(kinds(await bookRows(o.id))).toEqual([
      ['purchase', '-361.20', '2026-05-11'], ['purchase', '29.47', '2026-05-11'],
      ['cost_repaid', '87.50', '2026-06-01'], ['cost_repaid', '87.50', '2026-07-01'], ['cost_repaid', '87.50', '2026-08-01'],
      ['cost_repaid', '87.50', '2026-09-01'],
    ])
  })

  it('a correction before the markup piece is billed: the piece is split under the new figure the day it is billed', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await ship()
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))).toBe(3)   // pieces 1-3: all cost
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 37.73 }, w.userId)
    expect((await bookRows(o.id)).filter((r: any) => r.type === 'device_markup')).toEqual([])
    expect(await raiseDueInstallments(new Date('2027-01-01T12:00:00Z'))).toBe(1)
    const rows = await bookRows(o.id)
    expect(rows.filter((r: any) => r.reference_type === 'reader_purchase').map((r: any) => r.amount)).toEqual(['-331.73', '-5.00'])
    expect(rows.filter((r: any) => r.reference_type !== 'reader_purchase').map((r: any) => [r.type, r.amount])).toEqual([
      ['adjustment', '87.50'], ['adjustment', '87.50'], ['adjustment', '87.50'], ['adjustment', '74.23'], ['device_markup', '13.27'],
    ])
  })

  it("the date: the day GAM ordered it unless typed; never a day to come, never before the landlord asked", async () => {
    const w = await world()
    const o = await pastOrder(w)
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, effectiveOn: '2099-01-01' }, w.userId)).rejects.toThrow(/not a day still to come/)
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, effectiveOn: '2026-05-09' }, w.userId)).rejects.toThrow(/before the landlord asked for it \(2026-05-10\)/)
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, effectiveOn: '2026-02-30' }, w.userId)).rejects.toThrow(/YYYY-MM-DD/)
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73, effectiveOn: '2026-05-12' }, w.userId)
    expect(row.cost_effective_on).toBe('2026-05-12')
  })

  it("Mountain View's plan: pieces 1-3 pay the cost back; piece 4 carries the $18.27 markup, once, the day it is billed", async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    expect(await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))).toBe(3)
    expect(await markupRows(w.landlordId)).toEqual([])
    // "lowers 'earned all time' until repaid": −$331.73 + 3 × $87.50.
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ booked_total: -69.23, cost_repaid_booked: 262.5, still_to_repay: 69.23 })
    expect(await raiseDueInstallments(new Date('2027-01-01T12:00:00Z'))).toBe(1)
    const rows = await markupRows(w.landlordId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: '18.27', reference_type: 'reader_order_installment', n: 4 })
    expect(new Date(rows[0].created_at).getTime()).toBe(new Date(rows[0].billed_at).getTime())
    // Again: nothing doubles.
    await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toHaveLength(1)
    const row = (await adminListReaderOrders(o.id))[0]
    expect(row).toMatchObject({ billed: 350, markup_billed: 18.27, markup_booked: 18.27, markup_not_collected: 18.27, cost_recovered: 0,
      purchase_booked: -331.73, cost_repaid_booked: 331.73, booked_total: 18.27, still_to_repay: 0 })
  })

  it('a reader that shipped before its cost was typed: the first entry is taken, and the markup already billed is booked at once', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await ship()
    expect(await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))).toBe(4)
    expect(await bookRows(o.id)).toEqual([])      // no cost known: nothing of the reader is in GAM's book
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect((await markupRows(w.landlordId)).map((r: any) => [r.n, r.amount])).toEqual([[4, '18.27']])
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ purchase_booked: -331.73, cost_repaid_booked: 331.73, booked_total: 18.27 })
  })

  it('a reader that cost GAM more than it charges earns nothing', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    const row0 = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(row0.markup).toBe(-11.2)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toEqual([])
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ booked_total: -11.2, still_to_repay: 11.2 })
  })

  // 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge)" — (afternoon) the
  // purchase is the expense; a loss is the part of it the payments never repay.
  it("a reader that cost GAM more than it charges: GAM's book stays $11.20 below zero after the last payment; a later refund comes back on its own date", async () => {
    const w = await world()
    const o = await pastOrder(w)
    let row = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(row).toMatchObject({ cost_total: 361.2, markup: -11.2, loss: 11.2, booked_total: -11.2, markup_booked: 0, not_booked: 0, still_to_repay: 11.2, cost_effective_on: '2026-05-11' })
    expect(kinds(await bookRows(o.id))).toEqual([
      ['purchase', '-361.20', '2026-05-11'],
      ['cost_repaid', '87.50', '2026-06-01'], ['cost_repaid', '87.50', '2026-07-01'], ['cost_repaid', '87.50', '2026-08-01'],
      ['cost_repaid', '87.50', '2026-09-01'],
    ])
    // Another monthly run books nothing more.
    await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))
    expect(await bookRows(o.id)).toHaveLength(5)
    // October 1st: a $20.00 refund — cost $341.20, under the $350.00: $20.00 back to GAM on October 1st.
    row = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 4, shipping: 7.2, effectiveOn: '2026-10-01', note: 'refund' }, w.userId)
    expect(row).toMatchObject({ markup: 8.8, loss: 0, booked_total: 8.8, not_booked: 0, still_to_repay: 0 })
    expect(kinds(await bookRows(o.id)).filter(k => k[0] === 'purchase')).toEqual([['purchase', '-361.20', '2026-05-11'], ['purchase', '20.00', '2026-10-01']])
  })

  it('a correction that pushes a reader over its price: the rows already booked stay, the $28.27 more is GAM\'s expense today, and the book comes to the $10.00 loss', async () => {
    const w = await world()
    const o = await pastOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 61 }, w.userId)   // $360.00
    expect(row).toMatchObject({ markup: -10, loss: 10, markup_booked: 18.27, booked_total: -10, not_booked: 0 })
    expect((await bookRows(o.id)).filter((r: any) => r.reference_type === 'reader_purchase').map((r: any) => r.amount)).toEqual(['-331.73', '-28.27'])
  })

  // 10/13 (review): what the desk says GAM's book holds is what the book holds — a voided
  // piece's markup row stays in the ledger (voids are the ledger's P0 work), so it counts.
  it("a voided piece's markup is still in GAM's book, and the desk says so", async () => {
    const w = await world()
    const o = await pastOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await db.query(`UPDATE landlord_gam_charges SET voided_at = NOW(), void_reason = 'bank_debit_not_made' WHERE reader_order_id = $1 AND installment_number = 4`, [o.id])
    const row = (await adminListReaderOrders(o.id))[0]
    expect(row).toMatchObject({ booked_total: 18.27, markup_billed: 0, not_booked: 0 })
    expect(row.book.filter((b: any) => b.n === 4).map((b: any) => [b.kind, b.amount, b.voided])).toEqual([['cost_repaid', 69.23, true], ['markup', 18.27, true]])
    expect(row.book.filter((b: any) => b.voided)).toHaveLength(2)
  })

  it("a demo account's reader is never GAM earnings", async () => {
    const w = await world()
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [w.landlordId])
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toEqual([])
    // Not its purchase, not its pieces, not a correction: none of it is GAM's money.
    expect(await bookRows(o.id)).toEqual([])
    expect(await readerBookFacts()).toEqual({ bought: 0, billed: 0, collected: 0, costRepaidCollected: 0, markupCollected: 0 })
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 61 }, w.userId)
    expect(await bookRows(o.id)).toEqual([])
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ in_gams_book: false, booked_total: 0, not_booked: 0 })
  })

  it('the bridge facts: what GAM paid, the pieces billed, and cost first how much was collected', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await readerBookFacts()).toEqual({ bought: 331.73, billed: 350, collected: 0, costRepaidCollected: 0, markupCollected: 0 })
    // Pieces 1-3 and $70 of piece 4 collected: $331.73 of cost back first, then $0.77 of markup.
    await db.query(`UPDATE landlord_gam_charges SET collected_amount = CASE WHEN installment_number = 4 THEN 70 ELSE amount END
                     WHERE reader_order_id = $1`, [o.id])
    expect(await readerBookFacts()).toEqual({ bought: 331.73, billed: 350, collected: 332.5, costRepaidCollected: 331.73, markupCollected: 0.77 })
  })

  // 10/13 (review): "the day we buy it" (Nic) is the purchase's date. A cost typed on a request
  // nobody had ordered dated the purchase the day it was typed — typed 9/30, ordered 10/2: an expense
  // in September, before GAM bought anything. The cost is the shop receipt: it waits for the order.
  it('a cost waits for the order: refused on a request nobody ordered (or cancelled before anyone did); once ordered, the purchase is dated the day GAM bought it', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await db.query(`UPDATE pos_reader_orders SET created_at = '2026-05-10T17:00:00Z' WHERE id = $1`, [o.id])
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not been ordered from Stripe yet\. Mark it Ordered first/) })
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73, effectiveOn: '2026-05-11' }, w.userId)).rejects.toMatchObject({ statusCode: 409 })
    expect((await db.query(`SELECT 1 FROM pos_reader_order_costs WHERE reader_order_id = $1`, [o.id])).rows).toEqual([])
    expect(await bookRows(o.id)).toEqual([])
    // Bought from Stripe's shop and marked Ordered on May 12th; the receipt typed later, its date left as offered.
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_9' })
    await db.query(`UPDATE pos_reader_orders SET ordered_at = '2026-05-12T17:30:00Z' WHERE id = $1`, [o.id])
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ bought: true, bought_at: new Date('2026-05-12T17:30:00Z') })
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(row).toMatchObject({ bought: true, cost_effective_on: '2026-05-12', still_to_repay: 331.73, booked_total: -331.73, not_booked: 0 })
    const purchase = (await db.query(`SELECT created_at FROM platform_revenue_ledger WHERE type = 'adjustment' AND reference_type = 'reader_purchase'`)).rows
    expect(purchase.map((r: any) => new Date(r.created_at).toISOString())).toEqual(['2026-05-12T17:30:00.000Z'])
    // A request cancelled before anyone ordered it: GAM paid nothing — there is no cost to enter.
    const w2 = await world()
    const o2 = await requestReader({ landlordId: w2.landlordId, propertyId: w2.propertyId, shipTo, requestedByUserId: w2.userId })
    await adminUpdateReaderOrder(o2.id, { status: 'cancelled' })
    await expect(recordReaderOrderCost(o2.id, { basePrice: 299 }, w2.userId))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cancelled before anyone ordered it/) })
  })

  it('a desk that skipped Ordered (Requested straight to Shipped): the purchase is dated the day it shipped', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await db.query(`UPDATE pos_reader_orders SET created_at = '2026-05-10T17:00:00Z' WHERE id = $1`, [o.id])
    await adminUpdateReaderOrder(o.id, { status: 'shipped' })
    await db.query(`UPDATE pos_reader_orders SET shipped_at = '2026-05-20T17:00:00Z' WHERE id = $1`, [o.id])
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(row).toMatchObject({ ordered_at: null, cost_effective_on: '2026-05-20' })
    const purchase = (await db.query(`SELECT created_at FROM platform_revenue_ledger WHERE type = 'adjustment' AND reference_type = 'reader_purchase'`)).rows
    expect(purchase.map((r: any) => new Date(r.created_at).toISOString())).toEqual(['2026-05-20T17:00:00.000Z'])
  })

  // 10/13 (review): a purchase in GAM's book is never rewritten, so an order with its cost entered
  // that went back to Requested left the purchase there — and the desk read it as a row "missing".
  it('back to Requested only while nothing is recorded on the order — and then it is not bought, and its dates go', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    // Marked Ordered by mistake, nothing typed: back to a request, its dates gone with it.
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_1' })
    const back = await adminUpdateReaderOrder(o.id, { status: 'requested' })
    expect(back).toMatchObject({ status: 'requested', ordered_at: null, shipped_at: null, cancelled_at: null })
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ bought: false, bought_at: null })
    // Cancelled now, it is a request nobody ordered: no cost asked for in the morning.
    await adminUpdateReaderOrder(o.id, { status: 'cancelled' })
    adminNote.mockClear()
    expect(await chaseReaderOrders(new Date(Date.now() + 2 * 86400000))).toEqual({ waiting: 0, sent: false })
    // Re-opened and really ordered, its receipt typed: the purchase is in GAM's book, and the order cannot go back.
    await adminUpdateReaderOrder(o.id, { status: 'requested' })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_2' })
    let row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await expect(adminUpdateReaderOrder(o.id, { status: 'requested' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cost is entered on this order, so it cannot go back to a request/) })
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ status: 'ordered', bought: true, booked_total: -331.73, not_booked: 0 })
    // Marked by mistake after all, GAM paid nothing: a $0.00 correction dated the day of the figure it
    // fixes gives the purchase back on that day; then it is cancelled. The book holds nothing for it.
    row = await recordReaderOrderCost(o.id, { basePrice: 0, effectiveOn: row.cost_effective_on, note: 'never bought' }, w.userId)
    await adminUpdateReaderOrder(o.id, { status: 'cancelled' })
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({
      status: 'cancelled', purchase_booked: 0, booked_total: 0, not_booked: 0, still_to_repay: 0, loss: 0,
    })
    expect((await bookRows(o.id)).map((r: any) => r.amount)).toEqual(['-331.73', '331.73'])
    // A shipped order with a payment billed (no cost typed yet) cannot go back either.
    const w2 = await world()
    const { o: o2, ship } = await shippedOrder(w2)
    await ship()
    expect(await raiseDueInstallments(new Date('2026-10-02T12:00:00Z'))).toBe(1)
    await expect(adminUpdateReaderOrder(o2.id, { status: 'requested' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Payments have been billed/) })
    expect((await adminListReaderOrders(o2.id))[0]).toMatchObject({ status: 'shipped', bought: true })
  })

  // 10/13 (review): a plan cancelled after GAM bought the reader bills nothing more
  // (raiseDueInstallments) — the desk said "still to be repaid" of a cost no payment will repay.
  it('a plan cancelled after GAM bought the reader: what its payments did not repay is the loss, not "still to be repaid"; a refund typed as a correction gives some back', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    expect(await raiseDueInstallments(new Date('2026-10-02T12:00:00Z'))).toBe(1)
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ still_to_repay: 244.23, loss: 0, booked_total: -244.23 })
    await adminUpdateReaderOrder(o.id, { status: 'cancelled' })
    expect(await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))).toBe(0)
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({
      status: 'cancelled', bought: true, billed: 87.5, still_to_repay: 0, loss: 244.23, booked_total: -244.23, not_booked: 0,
    })
    // The reader sent back, $100.00 refunded: the cost is $231.73 from today, $100.00 back to GAM, and the loss is $144.23.
    const row = await recordReaderOrderCost(o.id, { basePrice: 199, taxAndShipping: 32.73, note: 'returned — $100 refunded' }, w.userId)
    expect(row).toMatchObject({ cost_total: 231.73, still_to_repay: 0, loss: 144.23, booked_total: -144.23, not_booked: 0 })
  })

  it("the morning run puts a reader in GAM's book that nothing else did, and a piece whose markup the 10/12 code booked gets only the rest of it as cost repaid", async () => {
    const w = await world()
    const o = await pastOrder(w)
    // The cost and the 10/12 code's markup row on piece 4, written straight to the tables.
    await db.query(`INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount, effective_on) VALUES ($1, 299, 32.73, '2026-05-11')`, [o.id])
    const p4 = (await db.query(`SELECT id, created_at FROM landlord_gam_charges WHERE reader_order_id = $1 AND installment_number = 4`, [o.id])).rows[0]
    await db.query(`INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, property_id, created_at)
                    VALUES ('device_markup', 18.27, 18.27, $1, 'reader_order_installment', $2, $3)`, [p4.id, w.propertyId, p4.created_at])
    await chaseReaderOrders(new Date('2026-10-13T15:00:00Z'))
    // Piece 4's two rows share a moment: compared in a fixed order.
    const sorted = (xs: any[][]) => xs.map(x => JSON.stringify(x)).sort()
    expect(sorted(kinds(await bookRows(o.id)))).toEqual(sorted([
      ['purchase', '-331.73', '2026-05-11'],
      ['cost_repaid', '87.50', '2026-06-01'], ['cost_repaid', '87.50', '2026-07-01'], ['cost_repaid', '87.50', '2026-08-01'],
      ['markup', '18.27', '2026-09-01'], ['cost_repaid', '69.23', '2026-09-01'],
    ]))
    const c = await db.connect()
    try { await c.query('BEGIN'); expect(await bookReaderBook(c)).toBe(0); await c.query('COMMIT') } finally { c.release() }
    expect((await adminListReaderOrders(o.id))[0]).toMatchObject({ booked_total: 18.27, not_booked: 0 })
  })

  it("Mountain View's backfill: $299.00 base + $32.73 tax and shipping = $331.73, once", async () => {
    const w = await world()
    await db.query(`UPDATE properties SET name = 'Mountain View RV Ranch' WHERE id = $1`, [w.propertyId])
    await db.query(
      `INSERT INTO pos_reader_orders (id, landlord_id, property_id, status, model, price, installments, installment_amount,
                                      installments_raised, ship_name, ship_line1, ship_city, ship_state, ship_zip, shipped_at,
                                      created_at, ordered_at)
       VALUES ('288cc5df-5153-4b1c-b5d4-71f15c5c43d9', $1, $2, 'registered', 'stripe_reader_s710', 350, 4, 87.5, 1,
               'Lisa S', '2843 East Frontage Road', 'Amado', 'AZ', '85645', '2026-09-29T22:04:28Z',
               '2026-09-28T19:00:00Z', '2026-09-28T21:36:53Z')`,
      [w.landlordId, w.propertyId])
    const sql = readFileSync(join(__dirname, '..', 'db', 'migrations', '20261013160100_reader_order_costs.sql'), 'utf8')
    const backfill = sql.slice(sql.indexOf('INSERT INTO pos_reader_order_costs (reader_order_id, base_price, tax_and_shipping_amount'))
    await db.query(backfill); await db.query(backfill)
    const row = (await adminListReaderOrders('288cc5df-5153-4b1c-b5d4-71f15c5c43d9'))[0]
    expect(row).toMatchObject({
      // Piece 1 is all cost, so nothing is booked from it yet: still correctable (10/12 review).
      cost_base_price: 299, cost_tax_and_shipping: 32.73, cost_total: 331.73, charged: 350, markup: 18.27, cost_booked: false,
    })
    expect(row.cost_history).toHaveLength(1)
    expect(row.cost_history[0].source).toBe('backfill')
    // 10/13: the backfill of 20261015120000 dates it the day GAM bought the reader — September 28th
    // (ordered 2:36 pm Arizona) — not the day the 10/12 migration wrote it.
    const dated = readFileSync(join(__dirname, '..', 'db', 'migrations', '20261015120000_reader_order_cost_dated.sql'), 'utf8')
    const update = dated.slice(dated.indexOf('UPDATE pos_reader_order_costs c'), dated.indexOf('ALTER TABLE pos_reader_order_costs ENABLE TRIGGER'))
    await db.query('ALTER TABLE pos_reader_order_costs DISABLE TRIGGER pos_reader_order_costs_no_edit')
    try { await db.query(update) } finally { await db.query('ALTER TABLE pos_reader_order_costs ENABLE TRIGGER pos_reader_order_costs_no_edit') }
    expect((await adminListReaderOrders('288cc5df-5153-4b1c-b5d4-71f15c5c43d9'))[0].cost_effective_on).toBe('2026-09-28')
    // A correction typed now (October) applies from its date; the September figure stays.
    const fixed = await recordReaderOrderCost('288cc5df-5153-4b1c-b5d4-71f15c5c43d9', { basePrice: 299, tax: 21.78, shipping: 10.95 }, w.userId)
    expect(fixed.cost_history.map((h: any) => h.effective_on)).toEqual([fixed.cost_effective_on, '2026-09-28'])
  })

  // 10/12 (review): migrations reach production before the code. A piece the code before 10/12
  // raises in between names no order; the next run links it, so the desk and the bridge count it.
  it('a piece raised by the code before 10/12 (no order named) is linked to its order the next morning', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    expect(await raiseDueInstallments(new Date('2026-10-01T12:00:00Z'))).toBe(1)
    // November 1st, the old code: piece 2, no order named.
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, source_id, notes)
       VALUES ($1, $2, 'device_installment', 87.50, 'reader_order_installment', NULL, 'Card reader (Stripe Reader S710) — payment 2 of 4')`,
      [w.landlordId, w.propertyId])
    await db.query(`UPDATE pos_reader_orders SET installments_raised = 2 WHERE id = $1`, [o.id])
    expect((await adminListReaderOrders(o.id))[0].billed).toBe(87.5)
    await chaseReaderOrders(new Date('2026-11-02T15:00:00Z'))
    const row = (await adminListReaderOrders(o.id))[0]
    expect(row.billed).toBe(175)
    expect(row.pieces.filter((p: any) => p.billed).map((p: any) => p.n)).toEqual([1, 2])
    // Linked once; a later run changes nothing and raises nothing twice.
    expect(await raiseDueInstallments(new Date('2026-11-15T12:00:00Z'))).toBe(0)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM landlord_gam_charges WHERE reader_order_id = $1`, [o.id])).rows[0].n).toBe(2)
  })

  it("the cost entry's source list is the database's", async () => {
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conrelid = 'pos_reader_order_costs'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%source%'`)
    expect(rows).toHaveLength(1)
    const inDb = [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(inDb).toEqual([...READER_ORDER_COST_SOURCES].sort())
  })
})
