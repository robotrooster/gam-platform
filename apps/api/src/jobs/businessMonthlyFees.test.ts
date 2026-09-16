/**
 * S648 — a business's monthly GAM fee comes out of money GAM already holds for
 * it; debiting the business's Stripe balance is only the fallback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { chargesCreate } = vi.hoisted(() => ({
  chargesCreate: vi.fn(async () => ({ id: 'py_debit' })),
}))
vi.mock('../lib/stripe', () => ({ getStripe: () => ({ charges: { create: chargesCreate } }) }))

import { BUSINESS_TYPES } from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { processBusinessMonthlyFees } from './businessMonthlyFees'
import { recordHeldItem } from '../services/heldPayouts'

beforeEach(async () => {
  await cleanupAllSchema()
  chargesCreate.mockClear()
})

async function seedBusinessWithFee(): Promise<{ businessId: string; accrualId: string }> {
  const c = await db.connect()
  try {
    const { userId } = await seedLandlord(c)
    const { rows: [b] } = await c.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email, stripe_connect_account_id,
                               connect_payouts_enabled, connect_details_submitted)
       VALUES ($1, 'Fee Co', $2, 'fee@example.com', 'acct_fee', TRUE, TRUE) RETURNING id`,
      [userId, BUSINESS_TYPES[0]])
    const { rows: [a] } = await c.query<{ id: string }>(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount)
       VALUES ($1, '2026-08', 10) RETURNING id`, [b.id])
    return { businessId: b.id, accrualId: a.id }
  } finally { c.release() }
}

// A mid-month date, so only collection runs (accrual runs on the 1st).
const midMonth = new Date('2026-09-16T18:00:00Z')

describe('business monthly fee collection', () => {
  it('nets the fee from held money instead of debiting the business', async () => {
    const { businessId, accrualId } = await seedBusinessWithFee()
    await recordHeldItem({ businessId, sourceType: 'business_pos_sale', sourceId: 'tx_fee', amount: 40 })
    const r = await processBusinessMonthlyFees(midMonth)
    expect(r.collected).toBe(1)
    expect(chargesCreate).not.toHaveBeenCalled()
    const { rows: items } = await db.query<any>(
      `SELECT amount, source_type FROM held_payout_items WHERE business_id = $1 ORDER BY amount`, [businessId])
    expect(items).toEqual([
      { amount: '-10.00', source_type: 'platform_fee' },
      { amount: '40.00', source_type: 'business_pos_sale' },
    ])
    const { rows: [a] } = await db.query<any>(`SELECT status, stripe_charge_id FROM business_platform_fee_accruals WHERE id = $1`, [accrualId])
    expect(a).toEqual({ status: 'collected', stripe_charge_id: 'netted' })
    // Running again takes nothing more.
    await processBusinessMonthlyFees(midMonth)
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE business_id = $1`, [businessId])).rows).toHaveLength(2)
  })

  it('falls back to a debit when GAM holds too little', async () => {
    const { businessId, accrualId } = await seedBusinessWithFee()
    await recordHeldItem({ businessId, sourceType: 'business_pos_sale', sourceId: 'tx_small', amount: 4 })
    await processBusinessMonthlyFees(midMonth)
    expect(chargesCreate).toHaveBeenCalledTimes(1)
    const { rows: [a] } = await db.query<any>(`SELECT status, stripe_charge_id FROM business_platform_fee_accruals WHERE id = $1`, [accrualId])
    expect(a).toEqual({ status: 'collected', stripe_charge_id: 'py_debit' })
  })
})
