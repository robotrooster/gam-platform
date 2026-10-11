/**
 * S648 (Nic, DIRECTIVE): page 8 IS the move-in invoice.
 *
 * A new tenant is billed the first month's rent and proration page 8 says —
 * specials included — and a month page 8 already collected is never billed
 * again by the monthly run. An onboarding resident keeps the full-month rule.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices as backfill } from './invoiceGeneration'
import { generateMoveInInvoice as genMoveIn } from './moveInBundle'

beforeEach(async () => { await cleanupAllSchema() })

async function seedStack(opts: { startDate: string; first: number | null; proration: number | null; existing?: boolean }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 500, startDate: opts.startDate })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query(
      `UPDATE leases SET rent_due_day=1, needs_review=false, move_in_first_month_rent=$2,
              move_in_proration=$3, is_existing_tenancy=$4 WHERE id=$1`,
      [leaseId, opts.first, opts.proration, opts.existing ?? false])
    await client.query('COMMIT')
    await genMoveIn({ lease_id: leaseId, unit_id: unitId, tenant_id: tenantId,
      landlord_id: landlordId, rent_amount: 500, start_date: opts.startDate } as any)
    return { leaseId }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
}

const rents = async (leaseId: string) => (await db.query<{ d: string; a: number }>(
  `SELECT to_char(due_date,'YYYY-MM-DD') AS d, amount::float AS a FROM payments
    WHERE lease_id=$1 AND type='rent' ORDER BY due_date`, [leaseId])).rows

describe('page 8 billing', () => {
  it('proration only: October bills on the 1st as usual', async () => {
    const s = await seedStack({ startDate: '2026-09-16', first: 0, proration: 250 })
    await backfill({ from: '2026-09-01', to: '2026-11-01', leaseId: s.leaseId })
    expect(await rents(s.leaseId)).toEqual([
      { d: '2026-09-16', a: 250 }, { d: '2026-10-01', a: 500 }, { d: '2026-11-01', a: 500 },
    ])
  })

  it('proration + first month: October was paid at move-in and is not billed again', async () => {
    const s = await seedStack({ startDate: '2026-09-16', first: 500, proration: 250 })
    await backfill({ from: '2026-09-01', to: '2026-11-01', leaseId: s.leaseId })
    expect(await rents(s.leaseId)).toEqual([
      { d: '2026-09-16', a: 750 }, { d: '2026-11-01', a: 500 },
    ])
  })

  it('a move-in special on page 8 is what bills', async () => {
    const s = await seedStack({ startDate: '2026-09-16', first: 0, proration: 100 })
    expect((await rents(s.leaseId))[0]).toEqual({ d: '2026-09-16', a: 100 })
  })

  it('an older lease with nothing on page 8 keeps the original rule', async () => {
    const s = await seedStack({ startDate: '2026-09-16', first: null, proration: null })
    expect((await rents(s.leaseId))[0]).toEqual({ d: '2026-09-16', a: 250 })
  })
})
