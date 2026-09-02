/**
 * S624 — rent already paid that is still clearing.
 *
 * Nic, correcting me: "the actual ACH payment was not delinquency... the agent
 * telling it that it was outstanding was, in fact, wrong."
 *
 * Removing 'processing' from the delinquency list (S620) stopped the wrong
 * answer. It did not produce the right one — the money just became invisible,
 * and a landlord looking at a gap in their rent roll cannot tell a debt from a
 * bank delay. Those need opposite reactions.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../../../db'
import { getMoneyInFlight } from './getMoneyInFlight'
import { getDelinquentTenants } from './getDelinquentTenants'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../../../test/dbHelpers'

beforeEach(cleanupAllSchema)

async function stack() {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 850 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 850 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    return { landlordId, tenantId, unitId, leaseId, actor: { userId, role: 'landlord' as const, profileId: '', landlordIds: [landlordId] } }
  } finally { client.release() }
}

async function charge(s: any, amount: number, status: string, daysAgo = 0) {
  await db.query(
    `INSERT INTO payments
       (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
        due_date, entry_description, stripe_payment_intent_id, created_at)
     VALUES ($1,$2,$3,$4,'rent',$5,$6, CURRENT_DATE - 5, 'RENT', $7,
             NOW() - ($8::int || ' days')::interval)`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, amount.toFixed(2), status,
     status === 'processing' ? `pi_${randomUUID().slice(0, 12)}` : null, daysAgo])
}

describe('money the landlord has been paid but has not received', () => {
  it('reports it, with who and how long it has been clearing', async () => {
    const s = await stack()
    await charge(s, 850, 'processing', 6)
    const r: any = await getMoneyInFlight.execute({}, s.actor)
    expect(r.count).toBe(1)
    expect(r.total).toBe(850)
    expect(r.oldestDaysClearing).toBe(6)
    expect(r.payments[0].daysClearing).toBe(6)
    // The framing matters as much as the number.
    expect(r.note).toMatch(/already paid/i)
    expect(r.note).toMatch(/NOT overdue/i)
  })

  // THE CORRECTION. The same payment must be in flight and NOT delinquent.
  it('is not counted as owing — the two tools must never both claim it', async () => {
    const s = await stack()
    await charge(s, 850, 'processing', 6)

    const flight: any = await getMoneyInFlight.execute({}, s.actor)
    const behind: any = await getDelinquentTenants.execute({}, s.actor)

    expect(flight.count).toBe(1)
    expect(behind.count).toBe(0)
  })

  it('a genuinely unpaid charge is delinquent and NOT in flight', async () => {
    const s = await stack()
    await charge(s, 850, 'pending', 0)

    const flight: any = await getMoneyInFlight.execute({}, s.actor)
    const behind: any = await getDelinquentTenants.execute({}, s.actor)

    expect(flight.count).toBe(0)
    expect(behind.count).toBe(1)
  })

  // A failed payment is money that really is still owed.
  it('a failed payment is owed, not in flight', async () => {
    const s = await stack()
    await charge(s, 850, 'failed', 2)
    const flight: any = await getMoneyInFlight.execute({}, s.actor)
    const behind: any = await getDelinquentTenants.execute({}, s.actor)
    expect(flight.count).toBe(0)
    expect(behind.count).toBe(1)
  })

  it('says so plainly when nothing is moving', async () => {
    const s = await stack()
    const r: any = await getMoneyInFlight.execute({}, s.actor)
    expect(r.count).toBe(0)
    expect(r.total).toBe(0)
    expect(r.note).toMatch(/already cleared/i)
  })

  it('never reaches another landlord’s money', async () => {
    const a = await stack()
    const b = await stack()
    await charge(b, 850, 'processing', 3)
    const r: any = await getMoneyInFlight.execute({}, a.actor)
    expect(r.count).toBe(0)
  })
})
