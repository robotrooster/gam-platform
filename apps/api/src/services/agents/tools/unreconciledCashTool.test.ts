/**
 * S655 (money plan Step 12): get_unreconciled_cash — "did the office bank what
 * it collected?" — now answers in the two groups the landlord's screen shows:
 * cash put on a deposit slip (in the bag, waiting for the bank) and cash on no
 * slip at all, plus slips the bank has not shown in 5 business days. Per
 * company, and the "is a bank linked" answer is that company's own.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../../../db'
import { getUnreconciledCash } from './getUnreconciledCash'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'

beforeEach(cleanupAllSchema)

async function company(name: string, userId?: string) {
  const c = await getClient()
  try {
    let uid = userId
    let landlordId: string
    if (!uid) {
      const s = await seedLandlord(c)
      uid = s.userId; landlordId = s.landlordId
    } else {
      landlordId = (await c.query(`INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [uid])).rows[0].id
    }
    await c.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [landlordId, name])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: uid, managedByUserId: uid })
    return { landlordId, propertyId, userId: uid }
  } finally { c.release() }
}

async function receipt(co: { landlordId: string; propertyId: string; userId: string }, amount: number, daysAgo: number, unit: string) {
  const c = await getClient()
  try {
    const tenantId = await seedTenant(c)
    const unitId = await seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, rentAmount: amount })
    await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unit])
    const leaseId = await seedLease(c, { unitId, landlordId: co.landlordId, rentAmount: amount })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    return (await c.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method, settled_at)
       VALUES ($1,$2,$3,$4,$4,'settled','cash', NOW() - ($5::int || ' days')::interval) RETURNING id`,
      [tenantId, leaseId, co.landlordId, amount.toFixed(2), daysAgo])).rows[0].id as string
  } finally { c.release() }
}

const linkBank = (landlordId: string) => db.query(
  `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active')`, [landlordId])

describe('get_unreconciled_cash', () => {
  it('reports cash on a deposit slip and cash on no slip separately, with names, and flags a slip the bank never showed', async () => {
    const co = await company('Mountain View')
    await linkBank(co.landlordId)
    const slipped = await receipt(co, 200, 9, 'RV 4')
    await receipt(co, 75, 6, 'RV 9')
    const slip = (await db.query(
      `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total, status, created_by)
       VALUES ($1, CURRENT_DATE - 20, 200, 'open', $2) RETURNING id`, [co.landlordId, co.userId])).rows[0].id
    await db.query(`INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,200)`, [slip, slipped])

    const r: any = await getUnreconciledCash.execute({}, { userId: co.userId, role: 'landlord', profileId: '', landlordIds: [co.landlordId] } as any)
    expect(r.ok).toBe(true)
    expect(r.company).toBe('Mountain View')
    expect(r.collectedNotBanked.total).toBe(275)
    expect(r.collectedNotBanked.onADepositSlip).toMatchObject({ count: 1, total: 200 })
    expect(r.collectedNotBanked.onADepositSlip.items[0]).toMatchObject({ who: 'Test Tenant', unit: 'RV 4', amount: 200 })
    expect(r.collectedNotBanked.notOnAnySlip).toMatchObject({ count: 1, total: 75 })
    expect(r.collectedNotBanked.notOnAnySlip.items[0]).toMatchObject({ unit: 'RV 9', daysOutstanding: 6 })
    expect(r.collectedNotBanked.slipsNotSeenAtTheBank).toBe(1)
    expect(r.caveat).toMatch(/5 business days/)
  })

  it('says no bank is linked for the company asked about, even when another of the owner’s companies has one', async () => {
    const oak = await company('Oak Park')
    const mv = await company('Mountain View', oak.userId)
    await linkBank(oak.landlordId)
    const actor = { userId: oak.userId, role: 'landlord', profileId: '', landlordIds: [oak.landlordId, mv.landlordId] } as any
    const r: any = await getUnreconciledCash.execute({ company: 'Mountain View' }, actor)
    expect(r.ok).toBe(true)
    expect(r.bankConnected).toBe(false)
    const asked: any = await getUnreconciledCash.execute({}, actor)
    expect(asked.ok).toBe(false)
    expect(asked.error).toMatch(/Which company\?/)
  })

  it('never reports another landlord’s cash', async () => {
    const mine = await company('Mine')
    const theirs = await company('Theirs')
    await linkBank(mine.landlordId)
    await linkBank(theirs.landlordId)
    await receipt(theirs, 500, 10, 'Lot 9')
    const r: any = await getUnreconciledCash.execute({}, { userId: mine.userId, role: 'landlord', profileId: '', landlordIds: [mine.landlordId] } as any)
    expect(r.collectedNotBanked.count).toBe(0)
    expect(JSON.stringify(r)).not.toContain('Lot 9')
  })
})
