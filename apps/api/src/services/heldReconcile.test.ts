/**
 * S648 — the daily check that every charge GAM holds is recorded against
 * someone, and that no payee owes GAM back unseen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { pis } = vi.hoisted(() => ({ pis: { list: [] as any[] } }))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      list: () => ({
        autoPagingEach: async (fn: (pi: any) => Promise<void>) => { for (const pi of pis.list) await fn(pi) },
      }),
    },
  }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { findUnrecordedCharges, findFloatedBalances } from './heldReconcile'
import { recordHeldItem } from './heldPayouts'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM admin_notifications WHERE category IN ('held_charge_unrecorded', 'held_balance_negative')`)
  pis.list = []
})

const now = new Date('2026-09-16T12:00:00Z')
const hoursAgo = (h: number) => Math.floor(now.getTime() / 1000) - h * 3600

describe('charges GAM holds with nothing recorded', () => {
  it('flags a captured register charge with no sale, once', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, stripe_payment_intent_id)
       VALUES ($1, $2, 'card', 10, 10.9, 'pi_recorded')`, [landlordId, userId])
    pis.list = [
      { id: 'pi_recorded', status: 'succeeded', amount: 1090, created: hoursAgo(5), metadata: { gam_purpose: 'pos_terminal' } },
      { id: 'pi_orphan', status: 'succeeded', amount: 2000, created: hoursAgo(5), metadata: { gam_purpose: 'pos_terminal' } },
      { id: 'pi_fresh', status: 'succeeded', amount: 500, created: hoursAgo(0), metadata: { gam_purpose: 'booking_deposit' } },
      { id: 'pi_rent', status: 'succeeded', amount: 50000, created: hoursAgo(5), metadata: {} },
      { id: 'pi_uncaptured', status: 'requires_capture', amount: 700, created: hoursAgo(5), metadata: { gam_purpose: 'business_pos_terminal' } },
    ]
    expect(await findUnrecordedCharges(now)).toEqual(['pi_orphan'])
    await findUnrecordedCharges(now)
    const { rows } = await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'held_charge_unrecorded'`)
    expect(rows).toHaveLength(1)
  })
})

describe('payees who owe GAM back', () => {
  it('flags a balance that has stayed negative for two weeks, and not a fresh one', async () => {
    const c = await db.connect()
    let oldL = '', newL = ''
    try {
      oldL = (await seedLandlord(c)).landlordId
      newL = (await seedLandlord(c)).landlordId
    } finally { c.release() }
    await recordHeldItem({ landlordId: oldL, sourceType: 'dispute', sourceId: 'dp_old', amount: -40 })
    await db.query(`UPDATE held_payout_items SET created_at = NOW() - INTERVAL '20 days' WHERE source_id = 'dp_old'`)
    await recordHeldItem({ landlordId: oldL, sourceType: 'pos_sale', sourceId: 'tx_small', amount: 10 })
    await recordHeldItem({ landlordId: newL, sourceType: 'dispute', sourceId: 'dp_new', amount: -40 })
    const out = await findFloatedBalances()
    expect(out).toEqual([{ landlordId: oldL, businessId: null, owedBack: 30 }])
    await findFloatedBalances()
    const { rows } = await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'held_balance_negative'`)
    expect(rows).toHaveLength(1)
  })
})
