/**
 * 11/5 (Nic) — A BANK THAT BOUNCED FOR GOOD COMES OFF THE ACCOUNT.
 *
 *   "If that retry bounces too, GAM needs to fully de-link their bank account
 *    and they have to go through the micro deposits again and verify a new
 *    bank. For people that are costing us money, I want to make it as
 *    inconvenient as possible. That way maybe they'll just pay with a debit
 *    card instead."
 *
 * Every refused bank debit costs GAM $4 Stripe does not give back. A resident
 * whose account bounces, bounces again on the retry, and then keeps the same
 * account on file is a standing bill to GAM for nothing. Taking it off means
 * the next attempt cannot come from it at all: they re-link and wait out
 * micro-deposits, or they reach for a card.
 *
 * These assert the STATE a resident is left in, because that is the whole
 * behaviour — "not verified, nothing on file, bank payments stopped" is what
 * makes the next pull impossible and the micro-deposit walk unavoidable.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const detachFn = vi.fn(async (_id: string) => ({ id: _id }))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ paymentMethods: { detach: detachFn } }),
}))

import { dropBankAfterRepeatReturn } from './tenantBankMethods'

beforeEach(async () => { await cleanupAllSchema(); detachFn.mockClear() })

/** A resident with a verified bank on file and autopay pinned to it. */
async function tenantWithBank(opts: { autopay?: boolean } = {}): Promise<string> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    await client.query(
      `UPDATE tenants
          SET ach_verified = TRUE, bank_last4 = '6789', bank_routing_last4 = '4321',
              bank_pending_since = NULL, ach_suspended_at = NULL,
              stripe_customer_id = 'cus_test'
        WHERE id = $1`, [tenantId])
    if (opts.autopay !== false) {
      // Autopay belongs to a lease or a home-sale contract, never neither
      // (tenant_autopay_one_owner), so the fixture gives it a real one.
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId })
      const leaseId = await seedLease(client, { unitId, landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId })
      await client.query(
        `INSERT INTO tenant_autopay (tenant_id, lease_id, payment_method_id)
         VALUES ($1, $2, 'pm_tenant_bank')`, [tenantId, leaseId])
    }
    return tenantId
  } finally { client.release() }
}

const bankState = async (tenantId: string) => (await db.query<{
  verified: boolean; last4: string | null; routing: string | null
  pending: boolean; stopped: boolean
}>(
  `SELECT ach_verified AS verified, bank_last4 AS last4, bank_routing_last4 AS routing,
          (bank_pending_since IS NOT NULL) AS pending,
          (ach_suspended_at IS NOT NULL) AS stopped
     FROM tenants WHERE id = $1`, [tenantId])).rows[0]

describe('the bank comes off after a refused debit with no retry left', () => {
  it('leaves them exactly where somebody who never linked a bank stands', async () => {
    const tenantId = await tenantWithBank()
    expect(await bankState(tenantId)).toMatchObject({ verified: true, last4: '6789', stopped: false })

    const r = await dropBankAfterRepeatReturn({
      tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'bounced twice' })

    expect(r).toMatchObject({ dropped: true, detached: true, last4: '6789' })
    expect(await bankState(tenantId)).toEqual({
      verified: false,      // they must verify again
      last4: null,          // nothing on file to pull from
      routing: null,
      pending: false,       // not "waiting on micro-deposits" either — they have not started
      stopped: true,        // and bank payments are refused meanwhile
    })
    expect(detachFn).toHaveBeenCalledWith('pm_tenant_bank')
  })

  it('unpins autopay, so it cannot keep failing against a method that is gone', async () => {
    // Autopay left pointing at a dead method retries every cycle, and every
    // one of those costs GAM another $4 — the exact leak this closes.
    const tenantId = await tenantWithBank()
    await dropBankAfterRepeatReturn({ tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'bounced twice' })

    const pinned = (await db.query<{ pm: string | null }>(
      `SELECT payment_method_id AS pm FROM tenant_autopay WHERE tenant_id = $1`, [tenantId])).rows
    expect(pinned).toEqual([{ pm: null }])
  })

  it('runs twice without telling them twice', async () => {
    // Both lines of one pull raise their own failure, and Stripe re-delivers
    // events. The second pass has nothing to take off and says so.
    const tenantId = await tenantWithBank()
    const first = await dropBankAfterRepeatReturn({ tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'x' })
    const again = await dropBankAfterRepeatReturn({ tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'x' })

    expect(first.dropped).toBe(true)
    expect(again.dropped).toBe(false)
    expect(await bankState(tenantId)).toMatchObject({ verified: false, last4: null, stopped: true })
  })

  it('still takes the bank off when Stripe will not detach the method', async () => {
    // The account state is the part that stops the next pull. Stripe being
    // down must not leave a dead bank attached and usable.
    const tenantId = await tenantWithBank()
    detachFn.mockRejectedValueOnce(new Error('Stripe is down'))

    const r = await dropBankAfterRepeatReturn({
      tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'bounced twice' })

    expect(r).toMatchObject({ dropped: true, detached: false })
    expect(await bankState(tenantId)).toMatchObject({ verified: false, last4: null, stopped: true })
  })

  it('keeps an existing stop date rather than pushing it forward', async () => {
    // ach_suspended_at is also set by the NACHA zero-tolerance path. A later
    // drop must not reset the clock on a block that started earlier.
    const tenantId = await tenantWithBank()
    await db.query(
      `UPDATE tenants SET ach_suspended_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [tenantId])
    const was = (await db.query<{ at: string }>(
      `SELECT ach_suspended_at::text AS at FROM tenants WHERE id = $1`, [tenantId])).rows[0].at

    await dropBankAfterRepeatReturn({ tenantId, paymentMethodId: 'pm_tenant_bank', reason: 'x' })

    const now = (await db.query<{ at: string }>(
      `SELECT ach_suspended_at::text AS at FROM tenants WHERE id = $1`, [tenantId])).rows[0].at
    expect(now).toBe(was)
  })

  it('does nothing for a tenant who has no bank on file', async () => {
    const client = await getClient()
    let tenantId = ''
    try { tenantId = await seedTenant(client) } finally { client.release() }

    const r = await dropBankAfterRepeatReturn({ tenantId, paymentMethodId: null, reason: 'x' })
    expect(r.dropped).toBe(false)
    expect(detachFn).not.toHaveBeenCalled()
  })
})
