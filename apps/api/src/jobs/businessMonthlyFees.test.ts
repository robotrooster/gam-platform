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

/**
 * S654 — the accrual on the 1st failed at parse time ("column amount is of
 * type numeric but expression is of type text": SELECT DISTINCT typed the bare
 * parameters as text), so no business was ever billed for invoicing. And the
 * rule is a month accrues when an invoice is SENT in it, so the window is on
 * sent_at, in Phoenix time.
 */
describe('business invoicing fee accrual on the 1st', () => {
  // 11:00 in Phoenix on October 1 — accrual day for September.
  const oct1 = new Date('2026-10-01T18:00:00Z')

  /** A business that cannot be collected from yet, so accruals stay pending. */
  async function seedBusiness(name: string): Promise<{ businessId: string; customerId: string }> {
    const c = await db.connect()
    try {
      const { userId } = await seedLandlord(c)
      const { rows: [b] } = await c.query<{ id: string }>(
        `INSERT INTO businesses (owner_user_id, name, business_type, email)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, name, BUSINESS_TYPES[0], `${name.replace(/\W/g, '').toLowerCase()}@example.com`])
      const { rows: [cu] } = await c.query<{ id: string }>(
        `INSERT INTO business_customers (business_id, customer_type, first_name, last_name)
         VALUES ($1, 'individual', 'Pat', 'Customer') RETURNING id`, [b.id])
      return { businessId: b.id, customerId: cu.id }
    } finally { c.release() }
  }

  async function seedInvoice(b: { businessId: string; customerId: string }, opts: {
    createdAt: string; sentAt: string | null
  }): Promise<void> {
    await db.query(
      `INSERT INTO business_invoices (business_id, customer_id, invoice_number, status,
                                      issue_date, due_date, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz::date, $5::timestamptz::date + 30, $6, $5)`,
      [b.businessId, b.customerId, `INV-${Math.random().toString(36).slice(2, 10)}`,
       opts.sentAt ? 'sent' : 'draft', opts.createdAt, opts.sentAt])
  }

  const accruals = async () => (await db.query<{ business_id: string; month: string; amount: string; status: string }>(
    `SELECT business_id, month, amount::text AS amount, status FROM business_platform_fee_accruals
      ORDER BY created_at`)).rows

  it('accrues the month an invoice was SENT in, once', async () => {
    const b = await seedBusiness('Sent In September')
    // Drafted in August, sent in September: September is the month that pays.
    await seedInvoice(b, { createdAt: '2026-08-28T17:00:00Z', sentAt: '2026-09-15T17:00:00Z' })

    const r = await processBusinessMonthlyFees(oct1)
    expect(r.accrued).toBe(1)
    expect(await accruals()).toEqual([
      { business_id: b.businessId, month: '2026-09', amount: '10.00', status: 'pending' },
    ])

    // The cron fires again the same day: the unique (business, month) holds.
    const again = await processBusinessMonthlyFees(oct1)
    expect(again.accrued).toBe(0)
    expect(await accruals()).toHaveLength(1)
  })

  it('ignores drafts and reads the month in Phoenix time', async () => {
    const draft = await seedBusiness('Only A Draft')
    await seedInvoice(draft, { createdAt: '2026-09-10T17:00:00Z', sentAt: null })
    // 22:00 on August 31 in Phoenix — an August send, not September.
    const august = await seedBusiness('Sent Late August')
    await seedInvoice(august, { createdAt: '2026-08-31T20:00:00Z', sentAt: '2026-09-01T05:00:00Z' })
    // 20:00 on September 30 in Phoenix — still September.
    const lateSept = await seedBusiness('Sent Late September')
    await seedInvoice(lateSept, { createdAt: '2026-09-30T20:00:00Z', sentAt: '2026-10-01T03:00:00Z' })

    const r = await processBusinessMonthlyFees(oct1)
    expect(r.accrued).toBe(1)
    expect(await accruals()).toEqual([
      { business_id: lateSept.businessId, month: '2026-09', amount: '10.00', status: 'pending' },
    ])
  })
})
