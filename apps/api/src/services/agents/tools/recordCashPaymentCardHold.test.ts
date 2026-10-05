/**
 * decisions.md #48.4 — the landlord assistant's cash tool never reads a card
 * hold that has run out.
 *
 * A card the tenant pay screen is confirming with its bank (3-D Secure) holds
 * the bill for 30 minutes at most. Past that, the bill is open again. The tool
 * finds the household by name among the bills it can take, so it releases this
 * company's expired holds first — otherwise a bill whose hold ran out reads as
 * "nothing open" and the cash is turned away.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../adminNotifications', () => ({ createAdminNotification: vi.fn(async () => undefined) }))
const stripe = vi.hoisted(() => ({
  status: new Map<string, string>(),
  cancel: vi.fn(),
}))
vi.mock('../../../lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      // A pay-screen card charge (services/rentCharge stamps it): the only
      // kind #48.4 holds and releases (paymentReconcile.confirmedOnScreen).
      retrieve: async (id: string) => ({ id, status: stripe.status.get(id) ?? 'requires_action', metadata: { gam_confirm_on_screen: 'true' } }),
      cancel: async (id: string) => { stripe.cancel(id); stripe.status.set(id, 'canceled'); return { id, status: 'canceled' } },
    },
  }),
}))

import { db } from '../../../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'
import { recordCashPayment } from './recordCashPayment'
import type { AgentActor } from './types'

beforeEach(async () => {
  await cleanupAllSchema()
  stripe.status.clear()
  stripe.cancel.mockClear()
})

/** Frank Moreno's $460 rent, held by a pay-screen card charge made `minutesAgo` ago. */
async function heldBill(pi: string, minutesAgo: number, name = 'Frank') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE users SET first_name = $2, last_name = 'Moreno' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, name])
    await seedLeaseTenant(c, { leaseId, tenantId })
    const rentId = (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date,
                             platform_held, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',460,'processing','RENT',DATE '2026-10-01',TRUE,$5) RETURNING id`,
      [ll.landlordId, unitId, leaseId, tenantId, pi])).rows[0].id
    await c.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,460,460,0,'card',476.65,16.65,$4, now() - ($5 || ' minutes')::interval)`,
      [tenantId, leaseId, ll.landlordId, pi, String(minutesAgo)])
    await c.query('COMMIT')
    const actor = { userId: ll.userId, role: 'landlord', profileId: '', landlordIds: [ll.landlordId] } as AgentActor
    return { rentId, actor }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
const statusOf = async (id: string) => (await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status

describe('record_cash_payment and a card hold that ran out (decisions.md #48.4)', () => {
  it('a hold past its 30 minutes is released first, and the cash pays the bill', async () => {
    const f = await heldBill('pi_hold_old', 31)
    const r: any = await recordCashPayment.execute({ tenant: 'Frank', method: 'cash', amount: 460 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true })
    expect(stripe.cancel).toHaveBeenCalledWith('pi_hold_old')
    expect(await statusOf(f.rentId)).toBe('settled')
  })

  it('a hold still inside its 30 minutes stays: nothing open to record, and nothing canceled', async () => {
    const f = await heldBill('pi_hold_new', 5)
    const r: any = await recordCashPayment.execute({ tenant: 'Frank', method: 'cash', amount: 460 }, f.actor)
    expect(r.ok).toBe(false)
    expect(stripe.cancel).not.toHaveBeenCalled()
    expect(await statusOf(f.rentId)).toBe('processing')
  })

  it('another company\'s expired hold is not this landlord\'s to release', async () => {
    const mine = await heldBill('pi_hold_mine', 31)
    const theirs = await heldBill('pi_hold_theirs', 31, 'Greta')
    await recordCashPayment.execute({ tenant: 'Frank', method: 'cash', amount: 460 }, mine.actor)
    expect(stripe.cancel).toHaveBeenCalledTimes(1)
    expect(stripe.cancel).toHaveBeenCalledWith('pi_hold_mine')
    expect(await statusOf(theirs.rentId)).toBe('processing')
  })
})
