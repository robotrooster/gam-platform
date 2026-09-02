/**
 * S620: a tenant who has paid must never appear on the landlord's
 * "who owes me money" list, even while the bank payment is still clearing.
 *
 * Nic found his own $2 on that list and the landlord agent read it back to
 * him. A bank payment sits in 'processing' for days AFTER the tenant's
 * account was debited; counting that as owed makes the platform tell a
 * landlord to chase someone who already paid.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { query, getClient } from '../../../db'
import { seedLandlord, seedTenant } from '../../../test/dbHelpers'
import { getDelinquentTenants } from './getDelinquentTenants'

let landlordId: string
let tenantId: string

async function seedOverdue(status: string) {
  await query(
    `INSERT INTO payments (landlord_id, tenant_id, type, amount, status,
                           entry_description, due_date)
     VALUES ($1, $2, 'rent', 750.00, $3, 'RENT', CURRENT_DATE - 10)`,
    [landlordId, tenantId, status])
}

// S634: a landlord actor's scope is landlordIds — profileId is empty.
const run = () => getDelinquentTenants.execute(
  {}, { userId: 'u1', role: 'landlord', profileId: '', landlordIds: [landlordId] } as any) as Promise<any>

describe('getDelinquentTenants — who is actually behind', () => {
  beforeAll(async () => {
    const client = await getClient()
    try {
      ;({ landlordId } = await seedLandlord(client))
      tenantId = await seedTenant(client)
    } finally { client.release() }
  })
  beforeEach(async () => {
    await query(`DELETE FROM payments WHERE landlord_id = $1`, [landlordId])
  })

  it('does NOT list a tenant whose bank payment is still clearing', async () => {
    // THE bug. The tenant has paid; the money is in flight. Every other
    // surface on the platform already treats this as paid.
    await seedOverdue('processing')
    const res: any = await run()
    expect(res.count).toBe(0)
    // S626: the shape changed — "who's outstanding" is now two groups, because
    // never-tried and tried-and-returned are different problems. Neither may
    // contain somebody whose money is already moving.
    expect(res.noPaymentAttempted).toHaveLength(0)
    expect(res.paymentReturned).toHaveLength(0)
    // And the money must be REPORTED, not merely omitted. Nic: "money was
    // already out of my bank account, and the agent still told the landlord
    // that person hadn't paid yet." Silence was the other half of that bug.
    expect(res.moneyInFlight.amount).toBeGreaterThan(0)
    expect(res.note).toMatch(/still clearing|NOT overdue/i)
  })

  it('still lists a tenant who has not paid at all', async () => {
    await seedOverdue('pending')
    const res = await run()
    expect(res.count).toBe(1)
  })

  it('still lists a tenant whose payment failed', async () => {
    await seedOverdue('failed')
    expect((await run()).count).toBe(1)
  })

  it('still lists a tenant whose payment was returned by the bank', async () => {
    // A returned payment came BACK. That money really is owed again.
    await seedOverdue('returned')
    expect((await run()).count).toBe(1)
  })

  it('does not list a tenant who has settled', async () => {
    await seedOverdue('settled')
    expect((await run()).count).toBe(0)
  })
})
