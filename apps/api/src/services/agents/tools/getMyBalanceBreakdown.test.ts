/**
 * S654 — the tenant agent counts a bounced payment once.
 *
 * A settled payment that bounces is reopened by paymentReversal as two rows:
 * the original flips to 'returned' and a fresh 'pending' row carries the debt.
 * The tool summed both, so a $300 bounce was quoted as $600 owed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../jobs/lateFees', () => ({
  generateLateFeesForInvoice: vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })),
}))
vi.mock('../../notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), notifyRentReversed: vi.fn(async () => undefined),
}))
vi.mock('../../adminNotifications', () => ({ createAdminNotification: vi.fn(async () => undefined) }))
vi.mock('../../reversalRecovery', () => ({ decideReversalRecovery: vi.fn(async () => null) }))
vi.mock('../../responsibleParty', () => ({ getPropertyResponsibleParty: vi.fn(async () => null) }))

import { db, getClient } from '../../../db'
import { getMyBalanceBreakdown, LISTED_CHARGES } from './getMyBalanceBreakdown'
import { handlePaymentReversal } from '../../paymentReversal'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'

beforeEach(cleanupAllSchema)

async function seed() {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    // October: open.
    await client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-10-01','RENT')`,
      [unitId, leaseId, tenantId, landlordId])
    // September: paid by bank, settled.
    const { rows: [inv] } = await client.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-S654-BOUNCE','2026-09-01',300,'settled') RETURNING id`,
      [landlordId, tenantId, leaseId, unitId])
    const { rows: [sept] } = await client.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,$4,$5,'rent',300,'settled','2026-09-01','RENT','pi_s654_sept',NOW()) RETURNING id`,
      [inv.id, unitId, leaseId, tenantId, landlordId])
    return {
      landlordId, tenantId, unitId, leaseId, septPaymentId: sept.id,
      actor: { userId, role: 'tenant' as const, profileId: tenantId, landlordIds: [] },
    }
  } finally { client.release() }
}

describe('get_my_balance_breakdown — a bounced payment is owed once', () => {
  it('the returned row and the row the reversal reopened are not both counted', async () => {
    const s = await seed()
    const r = await handlePaymentReversal({
      paymentId: s.septPaymentId, reversalType: 'ach_return', reversedAmount: 300, reversalFee: 4,
      stripeEventId: 'evt_s654_bounce', rawEvent: {},
    })
    expect(r.handled).toBe(true)

    const out: any = await getMyBalanceBreakdown.execute({}, s.actor)
    // October $460 + September reopened $300 + the $4 return fee.
    expect(out.totalOwed).toBe(764)
    expect(out.openChargesOldestFirst.filter((c: any) => c.status === 'returned')).toHaveLength(0)
    expect(out.openChargesOldestFirst.filter((c: any) => c.type === 'rent' && c.due_date === '2026-09-01'))
      .toEqual([expect.objectContaining({ amount: 300, status: 'pending' })])
  })

  // S655 (money plan, Step 11): one rule for "owed" (openBalances.openBalanceSql).
  // A bounce is owed on the row the reversal reopened (paymentReversal always
  // writes one); a bare 'returned' original is never counted again.
  it('a returned original is never counted; only the reopened row is owed', async () => {
    const s = await seed()
    await db.query(`UPDATE payments SET status = 'returned', return_code = 'R01' WHERE id = $1`, [s.septPaymentId])
    const out: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(out.totalOwed).toBe(460)
    expect(out.openChargesOldestFirst.filter((c: any) => c.status === 'returned')).toHaveLength(0)
  })
})

describe('get_my_balance_breakdown — the full balance, credit beside it (S655)', () => {
  it('a payment still clearing is not owed; the credit is reported, not taken off', async () => {
    const s = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'utility',40,'processing','2026-09-20','UTILITY','pi_clearing')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
       VALUES ($1,$2,NULL,25,25,'goodwill','test','active')`, [s.landlordId, s.tenantId])
    const out: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(out.totalOwed).toBe(460)
    expect(out.creditAvailable).toBe(25)
    expect(out.creditOnAccount).toBe(25)
    expect(out.openChargesOldestFirst.map((c: any) => c.label)).toEqual(['Rent'])
  })
})

describe('get_my_balance_breakdown — work trade is not owed (S637)', () => {
  it('a work-trade-covered line is left out of what the tenant is told they owe', async () => {
    const s = await seed()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'utility',35,'pending','2026-10-01','UTILITY',NOW())`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    const out: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(out.totalOwed).toBe(460)
  })
})

describe('get_my_balance_breakdown — the total is every open charge, however many are listed', () => {
  it('totalOwed counts every open charge, not only the oldest ones it lists', async () => {
    const s = await seed()
    // October rent $460 is open already; add 45 small charges going back in time.
    for (let i = 0; i < 45; i++) {
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'fee',10,'pending',DATE '2026-01-01' + $5::int,'OTHERFEE')`,
        [s.unitId, s.leaseId, s.tenantId, s.landlordId, i])
    }
    const out: any = await getMyBalanceBreakdown.execute({}, s.actor)
    expect(out.openChargesOldestFirst).toHaveLength(LISTED_CHARGES)
    expect(out.totalOwed).toBe(910)
    expect(out.openChargeCount).toBe(46)
    expect(out.moreChargesNotListed).toBe(46 - LISTED_CHARGES)
  })
})
