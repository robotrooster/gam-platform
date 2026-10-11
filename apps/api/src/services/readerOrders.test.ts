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
import { requestReader, cancelReaderRequest, adminUpdateReaderOrder, raiseDueInstallments, listReaderOrders, chaseReaderOrders, syncReadersFromStripe } from './readerOrders'

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
