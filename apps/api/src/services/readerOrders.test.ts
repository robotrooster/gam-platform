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
  recordReaderOrderCost, adminListReaderOrders, readerMarkupFacts } from './readerOrders'
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
      ORDER BY r.created_at, r.id`, [orderId])).rows

  it('a dated correction after the markup is booked: the old figure stays on record, the booked row stays, and the difference is shown as not in GAM\'s book', async () => {
    const w = await world()
    const o = await pastOrder(w)
    // The first figure is dated the day GAM bought it; piece 4 (billed September 1st) carries $18.27.
    let row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(row).toMatchObject({ cost_total: 331.73, cost_effective_on: '2026-05-11', markup: 18.27, loss: 0, booked_total: 18.27, not_booked: 0, cost_booked: true })
    expect(await bookRows(o.id)).toMatchObject([{ type: 'device_markup', amount: '18.27', day: '2026-09-01' }])
    // October 1st: $5.00 more shipping turns up. September's $18.27 stays as booked; the $5.00 it
    // changes in piece 4 is NOT booked (10/13: how a correction goes into GAM's book is Nic's call).
    row = await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 15.95, effectiveOn: '2026-10-01', note: 'extra shipping' }, w.userId)
    expect(row).toMatchObject({ cost_total: 336.73, cost_effective_on: '2026-10-01', markup: 13.27, booked_total: 18.27, not_booked: -5 })
    expect(row.cost_history.map((h: any) => [Number(h.total), h.effective_on])).toEqual([[336.73, '2026-10-01'], [331.73, '2026-05-11']])
    expect((await bookRows(o.id)).map((r: any) => [r.type, r.amount, r.day])).toEqual([['device_markup', '18.27', '2026-09-01']])
    expect(row.book.map((b: any) => [b.amount, b.n, b.voided])).toEqual([[18.27, 4, false]])
    // Never reaching back before the figure it corrects — on the desk, and at the table.
    await expect(recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 30, effectiveOn: '2026-09-30' }, w.userId))
      .rejects.toThrow(/on or after 2026-10-01/)
    await expect(db.query(`INSERT INTO pos_reader_order_costs (reader_order_id, base_price, effective_on) VALUES ($1, 250, '2026-09-30')`, [o.id]))
      .rejects.toThrow(/applies from its own date/)
    // A refund of $10.00 today: the book still holds September's $18.27; $5.00 more than it is not booked.
    row = await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 5.95 }, w.userId)
    expect(row).toMatchObject({ cost_total: 326.73, markup: 23.27, booked_total: 18.27, not_booked: 5 })
    // The same figure again changes nothing; the monthly run changes nothing.
    await recordReaderOrderCost(o.id, { basePrice: 299, tax: 21.78, shipping: 5.95 }, w.userId)
    await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))
    expect(await bookRows(o.id)).toHaveLength(1)
    // GAM's records under the current cost (the bridge names the $5.00 against the ledger).
    expect(await readerMarkupFacts()).toEqual({ markupBilled: 23.27, markupCollected: 0 })
  })

  it('a piece carries the markup under the figure in force the day it was billed: a typo fixed with the date of the figure it fixes books in full', async () => {
    const w = await world()
    const o = await pastOrder(w)
    // The typo ($361.20, a loss) books nothing; nothing of the loss is booked either.
    await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(await bookRows(o.id)).toEqual([])
    // Fixed with the typo's own date (May 11th): in force when piece 4 was billed (September 1st).
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73, effectiveOn: '2026-05-11' }, w.userId)
    expect(row).toMatchObject({ markup: 18.27, loss: 0, booked_total: 18.27, not_booked: 0 })
    expect((await bookRows(o.id)).map((r: any) => [r.type, r.amount, r.day])).toEqual([['device_markup', '18.27', '2026-09-01']])
  })

  it('a correction before the markup piece is billed books nothing; the piece books the new markup the day it is billed', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await ship()
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect(await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))).toBe(3)   // pieces 1-3: all cost
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 37.73 }, w.userId)
    expect(await bookRows(o.id)).toEqual([])
    expect(await raiseDueInstallments(new Date('2027-01-01T12:00:00Z'))).toBe(1)
    expect((await bookRows(o.id)).map((r: any) => [r.type, r.amount])).toEqual([['device_markup', '13.27']])
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

  it("Mountain View's plan: pieces 1-3 put nothing on the earnings ledger; piece 4 puts $18.27, once, the day it is billed", async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    expect(await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))).toBe(3)
    expect(await markupRows(w.landlordId)).toEqual([])
    expect(await raiseDueInstallments(new Date('2027-01-01T12:00:00Z'))).toBe(1)
    const rows = await markupRows(w.landlordId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: '18.27', reference_type: 'reader_order_installment', n: 4 })
    expect(new Date(rows[0].created_at).getTime()).toBe(new Date(rows[0].billed_at).getTime())
    // Again: nothing doubles.
    await raiseDueInstallments(new Date('2027-02-01T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toHaveLength(1)
    const row = (await adminListReaderOrders(o.id))[0]
    expect(row).toMatchObject({ billed: 350, markup_billed: 18.27, markup_booked: 18.27, markup_not_collected: 18.27, cost_recovered: 0 })
  })

  it('a reader that shipped before its cost was typed: the first entry is taken, and the markup already billed is booked at once', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await ship()
    expect(await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))).toBe(4)
    expect(await markupRows(w.landlordId)).toEqual([])      // no cost known: all of it counts as cost
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    expect((await markupRows(w.landlordId)).map((r: any) => [r.n, r.amount])).toEqual([[4, '18.27']])
  })

  it('a reader that cost GAM more than it charges earns nothing', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    const row0 = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(row0.markup).toBe(-11.2)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toEqual([])
  })

  // 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge)". The loss is on the
  // desk; how it goes into GAM's own book is an open question to Nic, so nothing of it is booked.
  it("a reader that cost GAM more than it charges shows a LOSS on the desk, not booked; a later refund's markup in a piece already billed is not booked either", async () => {
    const w = await world()
    const o = await pastOrder(w)
    let row = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 24, shipping: 7.2 }, w.userId)
    expect(row).toMatchObject({ cost_total: 361.2, markup: -11.2, loss: 11.2, booked_total: 0, not_booked: -11.2, cost_effective_on: '2026-05-11' })
    expect(await bookRows(o.id)).toEqual([])
    // Another monthly run books no markup and no loss.
    await raiseDueInstallments(new Date('2026-12-01T12:00:00Z'))
    expect(await bookRows(o.id)).toEqual([])
    // October 1st: a $20.00 refund — cost $341.20, under the $350.00. Piece 4 (billed September 1st,
    // under $361.20) carried no markup; the $8.80 the refund makes of it is shown, not booked.
    row = await recordReaderOrderCost(o.id, { basePrice: 330, tax: 4, shipping: 7.2, effectiveOn: '2026-10-01', note: 'refund' }, w.userId)
    expect(row).toMatchObject({ markup: 8.8, loss: 0, booked_total: 0, not_booked: 8.8 })
    expect(await bookRows(o.id)).toEqual([])
  })

  it('a correction that pushes a reader over its price: the markup already booked stays, the loss and the change are shown, not booked', async () => {
    const w = await world()
    const o = await pastOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    const row = await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 61 }, w.userId)   // $360.00
    expect(row).toMatchObject({ markup: -10, loss: 10, booked_total: 18.27, not_booked: -28.27 })
    expect((await bookRows(o.id)).map((r: any) => [r.type, r.amount])).toEqual([['device_markup', '18.27']])
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
    expect(row.book.map((b: any) => [b.amount, b.n, b.voided])).toEqual([[18.27, 4, true]])
  })

  it("a demo account's reader is never GAM earnings", async () => {
    const w = await world()
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [w.landlordId])
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await markupRows(w.landlordId)).toEqual([])
    expect(await readerMarkupFacts()).toEqual({ markupBilled: 0, markupCollected: 0 })
    // Nor a loss (10/13: nothing of a loss is booked for anyone).
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 61 }, w.userId)
    expect(await bookRows(o.id)).toEqual([])
  })

  it('the bridge facts: markup billed, and cost first how much of it was collected', async () => {
    const w = await world()
    const { o, ship } = await shippedOrder(w)
    await recordReaderOrderCost(o.id, { basePrice: 299, taxAndShipping: 32.73 }, w.userId)
    await ship()
    await raiseDueInstallments(new Date('2027-01-02T12:00:00Z'))
    expect(await readerMarkupFacts()).toEqual({ markupBilled: 18.27, markupCollected: 0 })
    // Pieces 1-3 and $70 of piece 4 collected: $331.73 of cost back first, then $0.77 of markup.
    await db.query(`UPDATE landlord_gam_charges SET collected_amount = CASE WHEN installment_number = 4 THEN 70 ELSE amount END
                     WHERE reader_order_id = $1`, [o.id])
    expect(await readerMarkupFacts()).toEqual({ markupBilled: 18.27, markupCollected: 0.77 })
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
