/**
 * 10/24 (Nic, DIRECTIVE) — A RENTED SPACE IS NEVER FREED BY A DATE.
 *
 *   "I thought the leases were supposed to block the spot indefinitely because
 *    they don't know how long they're going to be here. And paying ahead is the
 *    only other way to lock the spot out. February is one of our busiest times,
 *    and if he's a person that decides he's going to stay longer, like, we can't
 *    have that reservation messing up on us."
 *
 *   "When the tenant owns the unit and they're just renting the space, like in
 *    an RV, that doesn't matter. It can be month to month. It can auto renew."
 *
 * The split these tests hold in place:
 *   - the resident owns their dwelling (RV, a tenant-owned mobile home) and
 *     rents the ground → the end date LAPSES, the lease carries on month to
 *     month, the space stays held;
 *   - the landlord owns the dwelling (apartment, a park-owned home) → S562
 *     stands, the lease expires and the unit is vacated, because renewal there
 *     is a conscious decision by both parties and nobody should be trapped.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { processLeaseEnds } from './scheduler'

beforeEach(async () => { await cleanupAllSchema() })

async function leaseEndingYesterday(opts: { ownership: 'tenant' | 'landlord'; unitType: string }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 589 })
    await client.query(
      `UPDATE units SET dwelling_ownership = $2, unit_type = $3, status = 'active' WHERE id = $1`,
      [unitId, opts.ownership, opts.unitType])
    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, end_date, rent_amount,
                           signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'active', 'fixed_term', CURRENT_DATE - 90, CURRENT_DATE - 1, 589, TRUE, TRUE)
       RETURNING id`, [unitId, landlordId])
    await client.query('COMMIT')
    return { unitId, leaseId: lease.rows[0].id, landlordId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const leaseNow = async (id: string) => (await db.query<any>(
  `SELECT status, lease_type, end_date FROM leases WHERE id = $1`, [id])).rows[0]
const unitNow = async (id: string) => (await db.query<any>(
  `SELECT status FROM units WHERE id = $1`, [id])).rows[0]

describe('a lease whose end date has passed', () => {
  it('on a space the resident rents under their OWN rig: lapses to month-to-month, space still held', async () => {
    const f = await leaseEndingYesterday({ ownership: 'tenant', unitType: 'rv_spot' })
    await processLeaseEnds()
    const l = await leaseNow(f.leaseId)
    expect(l.status).toBe('active')              // not expired
    expect(l.lease_type).toBe('month_to_month')
    expect(l.end_date).toBeNull()                // the date is gone, not honoured
    expect((await unitNow(f.unitId)).status).toBe('active')    // still occupied, never freed
    // Run again tomorrow and there is nothing left to act on.
    await processLeaseEnds()
    expect((await leaseNow(f.leaseId)).status).toBe('active')
  })

  it('also lapses for a mobile home the RESIDENT owns — it is the dwelling, not the unit type', async () => {
    const f = await leaseEndingYesterday({ ownership: 'tenant', unitType: 'mobile_home' })
    await processLeaseEnds()
    expect((await leaseNow(f.leaseId)).status).toBe('active')
    expect((await leaseNow(f.leaseId)).end_date).toBeNull()
    expect((await unitNow(f.unitId)).status).toBe('active')
  })

  it('on a home the LANDLORD owns: expires and vacates, exactly as S562 decided', async () => {
    const f = await leaseEndingYesterday({ ownership: 'landlord', unitType: 'mobile_home' })
    await processLeaseEnds()
    const l = await leaseNow(f.leaseId)
    expect(l.status).toBe('expired')
    expect(l.end_date).not.toBeNull()            // the agreed end stands
    expect((await unitNow(f.unitId)).status).toBe('vacant')
  })
})
