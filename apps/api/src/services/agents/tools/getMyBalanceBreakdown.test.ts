/**
 * S654 — the tenant agent quotes the figure the portal shows.
 *
 * MH 25: a $460 October bill with $10 paid ahead. The bill email and the portal
 * say $450; this tool summed the open rows and said $460. It now nets the same
 * way the portal does (one helper): paid-ahead first, then landlord credit.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../../../db'
import { getMyBalanceBreakdown } from './getMyBalanceBreakdown'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'

beforeEach(cleanupAllSchema)

async function mh25() {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const { rows: [inv] } = await client.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-S654-AGENT','2026-10-01',460,'pending') RETURNING id`,
      [landlordId, tenantId, leaseId, unitId])
    await client.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','2026-10-01','RENT')`,
      [inv.id, unitId, leaseId, tenantId, landlordId])
    await client.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1,$2,10,10)`, [leaseId, tenantId])
    return {
      landlordId, tenantId, unitId, leaseId,
      actor: { userId, role: 'tenant' as const, profileId: tenantId, landlordIds: [] },
    }
  } finally { client.release() }
}

describe('get_my_balance_breakdown — the figure the portal shows', () => {
  it('MH 25: $460 bill, $10 paid ahead → $450 owed', async () => {
    const s = await mh25()
    const r: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(r.totalOwed).toBe(450)
    expect(r.totalBeforeCredits).toBe(460)
    expect(r.paidAheadApplied).toBe(10)
    expect(r.accountCreditApplied).toBe(0)
    expect(r.openChargesOldestFirst).toHaveLength(1)
  })

  it('paid-ahead first, then the landlord credit on what is left', async () => {
    const s = await mh25()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,50,50,'goodwill')`, [s.landlordId, s.tenantId, s.leaseId])
    const r: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(r.totalOwed).toBe(400)
    expect(r.paidAheadApplied).toBe(10)
    expect(r.accountCreditApplied).toBe(50)
  })

  // A bounced payment reopens as a fresh pending row (paymentReversal). The
  // dollars are owed once — on that row — and the bounce is listed.
  it('a bounced payment is owed again, once', async () => {
    const s = await mh25()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',300,'returned','2026-09-01','RENT'),
              ($1,$2,$3,$4,'rent',300,'pending','2026-09-01','RENT')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    const r: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(r.totalBeforeCredits).toBe(760)
    expect(r.totalOwed).toBe(750)
    expect(r.bouncedPaymentsOwedAgain).toEqual([{ amount: 300, due_date: '2026-09-01', type: 'rent' }])
  })

  it('a work-trade line is never quoted as owed', async () => {
    const s = await mh25()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'utility',75,'pending','2026-10-01','UTILITY', NOW())`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    const r: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(r.totalOwed).toBe(450)
    expect(r.totalBeforeCredits).toBe(460)
  })
})
