/**
 * S649 (Nic): "if somebody pays a 10% deposit on a week long stay, the other
 * 90% needs to generate on the day they're due to arrive."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock } = vi.hoisted(() => ({ emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined) }))
vi.mock('./email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))

import { processingFeeFor } from '@gam/shared'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { billStayBalances } from './stayBalance'
import { finalizePayLink, payLinkCharge } from '../routes/posPayLinks'

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear()
})

const NOW = new Date('2026-10-05T15:00:00Z')  // Oct 5, 8am in Phoenix

async function seedStay(opts: { checkIn?: string; checkOut?: string; payer?: 'customer' | 'landlord'; lease?: boolean } = {}) {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_stay' WHERE id = $1`, [userId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix', booking_card_fee_payer = $2 WHERE id = $1`,
      [propertyId, opts.payer ?? 'customer'])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out,
                                  nights, total_amount, deposit_amount, deposit_paid_at, status, source)
       VALUES ($1, $2, 'Pat Guest', 'pat@guest.dev', 'weekly', $3, $4, 7, 700, 70, NOW(), 'confirmed', 'public')
       RETURNING id`,
      [unitId, landlordId, opts.checkIn ?? '2026-10-05', opts.checkOut ?? '2026-10-12'])
    return { landlordId, propertyId, unitId, bookingId: b.id }
  } finally { c.release() }
}

describe('the rest of a short stay, on arrival day', () => {
  it('emails the guest a link for the balance on arrival day, once', async () => {
    const s = await seedStay()
    expect((await billStayBalances(NOW)).billed).toBe(1)
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    const fee = processingFeeFor({ amount: 630, paymentMethod: 'card' })
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'pat@guest.dev', amount: 630, cardFee: fee })
    const { rows: [b] } = await db.query<any>(`SELECT balance_billed_at, balance_pay_link_id FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(b.balance_billed_at).not.toBeNull()
    expect(b.balance_pay_link_id).not.toBeNull()
  })

  it('does not bill before arrival day', async () => {
    await seedStay({ checkIn: '2026-10-06', checkOut: '2026-10-13' })
    expect((await billStayBalances(NOW)).billed).toBe(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('leaves longer stays to their lease', async () => {
    const s = await seedStay({ checkOut: '2026-11-20' })
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, end_date, rent_amount, lease_source, source_booking_id)
       VALUES ($1, $2, 'pending', 'month_to_month', '2026-10-05', '2026-11-20', 950, 'booking_draft', $3)`,
      [s.unitId, s.landlordId, s.bookingId])
    expect((await billStayBalances(NOW)).billed).toBe(0)
  })

  it('follows the property when it absorbs the card fee, and marks the balance paid', async () => {
    const s = await seedStay({ payer: 'landlord' })
    await billStayBalances(NOW)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 630, cardFee: 0 })
    const { rows: [b] } = await db.query<any>(`SELECT balance_pay_link_id FROM unit_bookings WHERE id = $1`, [s.bookingId])
    const r = await finalizePayLink({ id: 'cs_bal', amount_total: 63000, payment_intent: 'pi_bal',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: b.balance_pay_link_id } })
    expect(r.recorded).toBe(true)
    const { rows: [after] } = await db.query<any>(`SELECT balance_paid_at, status FROM unit_bookings WHERE id = $1`, [s.bookingId])
    expect(after.balance_paid_at).not.toBeNull()
    expect(after.status).toBe('confirmed')
    const { rows: [h] } = await db.query<any>(`SELECT amount FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])
    expect(Number(h.amount)).toBe(payLinkCharge(630, 'landlord').held)
  })
})
