/**
 * S652 — card readers on a plan: the request, the desk, the monthly pieces.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { installmentSplit, SUPPORTED_CARD_READER } from '@gam/shared'

vi.mock('./posTerminal', () => ({ getOrCreatePropertyLocation: vi.fn(async () => 'tml_test') }))
import { requestReader, cancelReaderRequest, adminUpdateReaderOrder, raiseDueInstallments, listReaderOrders } from './readerOrders'

beforeEach(async () => { await cleanupAllSchema() })

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

  it('the first piece is owed when it ships, the next one the following month, each its own line', async () => {
    const w = await world()
    const o = await requestReader({ landlordId: w.landlordId, propertyId: w.propertyId, shipTo, requestedByUserId: w.userId })
    await adminUpdateReaderOrder(o.id, { status: 'ordered', stripeHardwareOrderId: 'thor_123' })
    let charges = await db.query(`SELECT * FROM landlord_gam_charges WHERE landlord_id=$1`, [w.landlordId])
    expect(charges.rows).toHaveLength(0)     // nothing owed until it ships
    await adminUpdateReaderOrder(o.id, { status: 'shipped', serial: 'WSC123', trackingUrl: 'https://ups.example/1' })
    charges = await db.query(`SELECT kind, amount, notes FROM landlord_gam_charges WHERE landlord_id=$1 ORDER BY created_at`, [w.landlordId])
    expect(charges.rows).toHaveLength(1)
    expect(charges.rows[0].kind).toBe('device_installment')
    expect(Number(charges.rows[0].amount)).toBe(87.5)
    expect(charges.rows[0].notes).toMatch(/payment 1 of 4/)
    // same month again: nothing more
    expect(await raiseDueInstallments(new Date())).toBe(0)
    // next month: piece 2; three months on: pieces 3 and 4, then it stops
    const shipped = (await db.query(`SELECT shipped_at FROM pos_reader_orders WHERE id=$1`, [o.id])).rows[0].shipped_at as Date
    const plus = (m: number) => new Date(Date.UTC(shipped.getUTCFullYear(), shipped.getUTCMonth() + m, 2))
    expect(await raiseDueInstallments(plus(1))).toBe(1)
    expect(await raiseDueInstallments(plus(3))).toBe(2)
    expect(await raiseDueInstallments(plus(9))).toBe(0)
    charges = await db.query(`SELECT amount FROM landlord_gam_charges WHERE landlord_id=$1`, [w.landlordId])
    expect(charges.rows).toHaveLength(4)
    expect(charges.rows.reduce((a: number, r: any) => a + Number(r.amount), 0)).toBe(350)
  })
})
