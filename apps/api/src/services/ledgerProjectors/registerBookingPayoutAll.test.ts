/**
 * 10/12 (Nic) — GAM Books ledger, phase P5 as a whole: a rebuild comes out the
 * same, and the nightly check finds nothing wrong (gam-ledger-design-2026-10-12
 * §8, §17 "Engine" and "Nightly checks") — across a register sale, a 30+
 * night stay with its booking-site deposit, GAM's charges, the weekly batch
 * and the payout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../db'
import { cleanupAllSchema } from '../../test/dbHelpers'
import { ledgerCompany } from '../../test/ledgerFixtures'
import { registerP5, unregisterAll, sale, booking, siteDeposit } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../ledgerEngine'
import { rebuildOwner } from '../ledgerRebuild'
import { checkOwner, registerLedgerCheck, unregisterLedgerCheck } from '../ledgerCheck'
import { P5_LEDGER_PROJECTORS, P5_LEDGER_CHECKS } from './registerBookingPayoutAll'

beforeEach(async () => {
  await cleanupAllSchema()
  registerP5()
  for (const c of P5_LEDGER_CHECKS) registerLedgerCheck(c)
})
afterEach(() => {
  unregisterAll()
  for (const c of P5_LEDGER_CHECKS) unregisterLedgerCheck(c.name)
})

describe('phase P5 end to end', () => {
  // 10/13 (Nic): design Q11 answered — "each $87.50 → SUPPLIES, in the month
  // GAM COLLECTED it": the reader order is registered so its marks drain, and posts nothing.
  it('registers one projector per source type; the reader order posts nothing (its pieces post when collected)', async () => {
    const types = P5_LEDGER_PROJECTORS.map(p => p.sourceType)
    expect(new Set(types).size).toBe(types.length)
    const order = P5_LEDGER_PROJECTORS.find(p => p.sourceType === 'reader_order')!
    expect(order).toBeTruthy()
    const c = await db.connect()
    try {
      expect(await order.project(c, '00000000-0000-0000-0000-000000000000')).toEqual([])
    } finally { c.release() }
  })

  it('a rebuild from scratch posts the same lines, and the nightly check (with the P5 tie-outs) finds no drift', async () => {
    const co = await ledgerCompany()
    await sale(co, { subtotal: 66, tax: 4.36, taxBreakdown: [{ name: 'Transaction privilege tax', rate: 0.066, amount: 4.36 }],
      screening: 30, at: '2026-09-15 18:00:00+00' })
    await db.query(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at)
       VALUES ($1, $2, 'screening_fee', 30, 'screening_prepayment', '2026-09-15 18:00:00+00'),
              ($1, $2, 'subscription', 20, 'test', '2026-09-01 18:00:00+00')`, [co.landlordId, co.propertyId])
    const b = await booking(co, { checkIn: '2026-10-04', checkOut: '2026-11-18' })
    await siteDeposit(co, b, { toward: 450, lodgingTax: 0, held: 450, at: '2026-09-20 18:00:00+00' })
    await sale(co, { method: 'card', subtotal: 450, platformFee: 16.3, held: 433.7, stay: { bookingId: b, toward: 450 }, at: '2026-10-04 18:00:00+00' })
    const intent = (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed,
                                              netted_amount, status, stripe_transfer_id, transferred_at)
       VALUES ($1, $2, 'acct_1', 430, 450, 0, 'transferred', 'tr_9', '2026-09-22 16:00:00+00') RETURNING id`,
      [co.landlordId, co.ownerUserId])).rows[0].id
    await db.query(`UPDATE held_payout_items SET payout_intent_id = $1 WHERE source_type = 'booking_deposit' AND source_id = $2`, [intent, b])
    const sub = (await db.query<{ id: string }>(`SELECT id FROM landlord_gam_charges WHERE kind = 'subscription' AND landlord_id = $1`, [co.landlordId])).rows[0].id
    await db.query(`INSERT INTO landlord_gam_charge_collections (charge_id, platform_transfer_intent_id, amount) VALUES ($1, $2, 20)`, [sub, intent])
    const payout = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, trigger_type)
       VALUES ($1, 430, 'settled', '2026-09-25 18:00:00+00', 'auto_friday') RETURNING id`, [co.landlordId])).rows[0].id
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [payout, intent])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })

    const fingerprints = async () => (await db.query<{ k: string }>(
      `SELECT source_type || ':' || source_id || ':' || posting_kind || ':' || fingerprint AS k FROM ledger_postings
        WHERE landlord_id = $1 AND role = 'post' AND superseded_at IS NULL ORDER BY 1`, [co.landlordId])).rows.map(r => r.k)
    const before = await fingerprints()
    expect(before.length).toBeGreaterThan(6)

    const dry = await rebuildOwner(co.owner, { mode: 'dry_run' })
    expect(dry).toMatchObject({ status: 'done', counts: { drift: 0, failed: 0 } })
    const scratch = await rebuildOwner(co.owner, { mode: 'from_scratch' })
    expect(scratch).toMatchObject({ status: 'done', counts: { failed: 0 } })
    expect(await fingerprints()).toEqual(before)

    const check = await checkOwner(co.owner)
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  })
})
