/**
 * 10/12 (Nic, G3): a move-out's share of a deposit GAM held is sent to the
 * landlord on its own (platform_transfer_intents purpose 'deposit_settlement').
 * The payout that carries it to their bank names it — "Deposit returned at
 * move-out" — on its own line, never "Part of a transfer GAM could not
 * itemize". The lines still add up to the payout.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { payoutComposition } from './payoutComposition'

beforeEach(async () => { await cleanupAllSchema() })

const ACCOUNT = 'acct_move_out'

describe('a payout that carried a move-out deposit transfer', () => {
  it('lists it as "Deposit returned at move-out" with its property and space, beside the weekly batch', async () => {
    const c = await db.connect()
    let f: { userId: string; landlordId: string; unitId: string; tenantId: string; leaseId: string; drId: string }
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET name = 'Sunset Palms' WHERE id = $1`, [propertyId])
      const unitId = await seedUnit(c, { propertyId, landlordId })
      await c.query(`UPDATE units SET unit_number = 'RV 07' WHERE id = $1`, [unitId])
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'terminated' })
      const drId = (await c.query<{ id: string }>(
        `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, status)
         VALUES ($1, $2, $3, 500, 175, 'sent_zero') RETURNING id`, [leaseId, tenantId, landlordId])).rows[0].id
      f = { userId, landlordId, unitId, tenantId, leaseId, drId }
    } finally { c.release() }

    const disb = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, created_at)
       VALUES ($1, $2, 'auto_friday', 275, 'settled', 'po_move_out', '2026-10-09T18:00:00Z', '2026-10-09T18:00:00Z') RETURNING id`,
      [f.userId, f.landlordId])).rows[0].id
    // The weekly batch: $100, untraced here (no owner shares on it).
    await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at, disbursement_id)
       VALUES ($1, $2, $3, 100, 100, 'transferred', 'tr_batch', '2026-10-08T18:00:00Z', $4)`,
      [f.landlordId, f.userId, ACCOUNT, disb])
    // The move-out's deposit share, sent on its own.
    await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, netted_amount, status,
          stripe_transfer_id, transferred_at, disbursement_id, purpose, deposit_return_id, stripe_idempotency_key, stripe_request)
       VALUES ($1, $2, $3, 175, 175, 0, 'transferred', 'tr_deposit', '2026-10-07T18:00:00Z', $4,
               'deposit_settlement', $5, $6, '{"description":"x","metadata":{}}'::jsonb)`,
      [f.landlordId, f.userId, ACCOUNT, disb, f.drId, `deposit_disb_${f.drId}`])

    const comp = await payoutComposition(disb)
    expect(comp).not.toBeNull()
    expect(comp!.directTransfers).toEqual([
      expect.objectContaining({ purpose: 'deposit_settlement', label: 'Deposit returned at move-out · Sunset Palms · RV 07', amount: 175 }),
    ])
    // The deposit share is not "could not itemize"; only the untraced batch is.
    const unitemized = comp!.adjustments.find(a => a.kind === 'unitemized')
    expect(unitemized?.amount).toBe(100)
    // payments + held + direct + adjustments = the payout.
    const sum = comp!.payments.reduce((s, p) => s + p.amount, 0) + comp!.heldItems.reduce((s, h) => s + h.amount, 0)
      + comp!.directTransfers.reduce((s, x) => s + x.amount, 0) + comp!.adjustments.reduce((s, a) => s + a.amount, 0)
    expect(Math.round(sum * 100)).toBe(27500)
    expect(comp!.summary).toContain('Deposit returned at move-out · Sunset Palms · RV 07 $175.00')
  })
})
