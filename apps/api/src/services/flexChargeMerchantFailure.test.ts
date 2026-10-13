/**
 * 10/12 (Nic, G4): a FlexCharge merchant transfer that fails in AUTOMATIC
 * RECOVERY (RECOVER's retry of a record left pending) raises an admin notice,
 * the way every other merchant-transfer failure does — it used to be logged
 * only, so money owed to a merchant could sit on GAM's balance unseen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const directTransferMock = vi.hoisted(() => vi.fn(async (..._a: any[]): Promise<any> => ({ id: 'tr_ok' })))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ transfers: { create: directTransferMock }, balance: { retrieve: async () => ({ available: [] }) } }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant } from '../test/dbHelpers'
import { recoverPendingPlatformTransfers } from './landlordPassthrough'
import { flexChargeMerchantTransferFailed, FLEXCHARGE_MERCHANT_TRANSFER_FAILED } from './flexCharge'

beforeEach(async () => {
  await cleanupAllSchema()
  directTransferMock.mockReset()
})

async function statement(): Promise<{ landlordId: string; userId: string; statementId: string }> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const tenantId = await seedTenant(c)
    const acct = (await c.query<{ id: string }>(
      `INSERT INTO flex_charge_accounts (tenant_id, property_id, landlord_id, credit_limit, status)
       VALUES ($1, $2, $3, 500, 'active') RETURNING id`, [tenantId, propertyId, landlordId])).rows[0].id
    const statementId = (await c.query<{ id: string }>(
      `INSERT INTO flex_charge_statements (account_id, cycle_month, balance, service_fee, total_due, due_date)
       VALUES ($1, '2026-10-01', 100, 1.25, 101.25, '2026-10-20') RETURNING id`, [acct])).rows[0].id
    return { landlordId, userId, statementId }
  } finally { c.release() }
}

const notices = async () => (await db.query<any>(
  `SELECT category, context FROM admin_notifications WHERE category = $1`, [FLEXCHARGE_MERCHANT_TRANSFER_FAILED])).rows

describe('a FlexCharge merchant transfer that fails', () => {
  it('in automatic recovery: RECOVER\'s retry is refused, and an admin is told', async () => {
    const f = await statement()
    // A merchant share recorded, never confirmed (the process stopped before Stripe answered).
    await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, netted_amount, status,
          purpose, flexcharge_statement_id, stripe_idempotency_key, stripe_request, created_at)
       VALUES ($1, $2, 'acct_merchant', 98.75, 98.75, 0, 'pending', 'flexcharge_merchant', $3,
               $4, '{"description":"FlexCharge merchant payout","metadata":{}}'::jsonb,
               NOW() - INTERVAL '1 hour')`, [f.landlordId, f.userId, f.statementId, `flexcharge_payout_${f.statementId}`])
    directTransferMock.mockRejectedValueOnce(Object.assign(new Error('destination account closed'),
      { type: 'StripeInvalidRequestError', statusCode: 400 }))

    await recoverPendingPlatformTransfers(0)

    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].context).toMatchObject({ statement_id: f.statementId, landlord_id: f.landlordId, when: 'recovery' })
    const [i] = (await db.query<any>(`SELECT status FROM platform_transfer_intents WHERE flexcharge_statement_id = $1`, [f.statementId])).rows
    expect(i.status).toBe('failed')
  })

  it('the notice helper never throws and says which send failed', async () => {
    const f = await statement()
    await flexChargeMerchantTransferFailed(f.statementId, f.landlordId, new Error('no balance'), 'paydown', { payment_id: 'x' })
    const n = await notices()
    expect(n).toHaveLength(1)
    expect(n[0].context).toMatchObject({ when: 'paydown', payment_id: 'x' })
  })
})
