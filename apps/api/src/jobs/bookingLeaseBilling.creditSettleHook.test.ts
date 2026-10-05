/**
 * S655 review (round 3) — the shortened-stay settle hook on Step 2's own settle
 * paths. bookingLeaseBilling.bankShortenedStaysAfterSettle banks rent that was
 * unpaid or still clearing when a stay was shortened, once it is paid; it had
 * no caller on any production settle path. The credit-only settle ("Pay with
 * credit") and the whole-bill settle (creditUse.settleRowsFromCredit) now run
 * it. The webhook, desk, posted payment, bank match and FlexPay cover are
 * other steps' (see the step report).
 *
 * Its own file: bookingLeaseBilling.test.ts has another writer this round.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { syncLeaseWithBookingDates } from '../services/bookingLeaseBilling'
import { createPaidAhead, settleFromCredit, settleWholeBillIfCovered } from '../services/creditUse'

vi.mock('../services/paymentReceipt', () => ({ sendPaymentReceipt: vi.fn(async () => 'msg_test') }))

beforeEach(async () => { await cleanupAllSchema() })

// Aug 10 2026 → Jan 28 2027 (exclusive) at $950/mo, shortened to Sep 20:
// the stay then owes $1,275.86 (Aug 10→Sep 1 $696.67 + Sep 1→20 $579.19).
async function shortenedWithSeptemberClearing() {
  const client = await getClient()
  let s: { landlordId: string; tenantId: string; leaseId: string; unitId: string; bookingId: string }
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 950, startDate: '2026-08-10' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    const bookingId = (await client.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
       VALUES ($1, $2, 'month_to_month', '2026-08-10', '2027-01-28', 171, 'Sched Guest', 'sched-guest@test.dev', 'confirmed', 'public')
       RETURNING id`, [unitId, landlordId])).rows[0].id
    await client.query(
      `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date='2027-01-28', needs_review=false WHERE id=$1`,
      [leaseId, bookingId])
    await client.query('COMMIT')
    s = { landlordId, tenantId, leaseId, unitId, bookingId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

  // Arrival paid; September's bank pull is still clearing when the stay is shortened.
  const rows = (await db.query<{ id: string; d: string }>(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10',NULL),
            ($1,$2,$3,$4,'rent',950,'processing','RENT','2026-09-01','pi_clearing')
     RETURNING id, due_date::text AS d`,
    [s.unitId, s.tenantId, s.landlordId, s.leaseId])).rows
  await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
  await syncLeaseWithBookingDates(s.bookingId)
  // Nothing has arrived past what the stay owes yet.
  expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rowCount).toBe(0)
  const sep = rows.find(r => r.d === '2026-09-01')!.id
  // The pull fails for good. September is owed again at the amount it carried,
  // and the tenant has money paid ahead (cash at the desk) that covers it.
  await db.query(`UPDATE payments SET status='failed', next_retry_at=NULL WHERE id=$1`, [sep])
  const c2 = await getClient()
  try {
    await c2.query('BEGIN')
    await createPaidAhead(c2, { leaseId: s.leaseId, tenantId: s.tenantId, amount: 950, fundedBy: 'landlord', receivedAt: '2026-09-25T12:00:00Z' })
    await c2.query('COMMIT')
  } finally { c2.release() }
  return { ...s, sep }
}

const banked = async (leaseId: string) => (await db.query<any>(
  `SELECT amount_original::float AS a, funded_by, source_payment_id FROM lease_prepaid_credits
    WHERE lease_id = $1 AND funded_by = 'reclassified'`, [leaseId])).rows

describe('the credit settles run the shortened-stay hook', () => {
  it('the whole-bill settle banks rent paid past a shortened stay when credit pays it', async () => {
    const s = await shortenedWithSeptemberClearing()
    const c = await getClient()
    let r: Awaited<ReturnType<typeof settleWholeBillIfCovered>>
    try {
      await c.query('BEGIN')
      r = await settleWholeBillIfCovered(c, { tenantId: s.tenantId, landlordId: s.landlordId, receipt: false })
      await c.query('COMMIT')
    } finally { c.release() }
    await r!.afterCommit()
    expect(r!.settledIds).toEqual([s.sep])
    // $696.67 + $950 paid − $1,275.86 owed = $370.81, banked once as stay-shortened money.
    expect(await banked(s.leaseId)).toEqual([{ a: 370.81, funded_by: 'reclassified', source_payment_id: s.sep }])
  })

  it('"Pay with credit" banks it too, and only once', async () => {
    const s = await shortenedWithSeptemberClearing()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const r = await settleFromCredit(c, { leaseId: s.leaseId, tenantId: s.tenantId, source: 'portal', receipt: false })
      await c.query('COMMIT')
      await r.afterCommit()
      expect(r.settledIds).toEqual([s.sep])
    } finally { c.release() }
    expect(await banked(s.leaseId)).toEqual([{ a: 370.81, funded_by: 'reclassified', source_payment_id: s.sep }])
  })
})
