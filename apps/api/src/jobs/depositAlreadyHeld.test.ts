/**
 * S604 (Nic): a landlord migrating EXISTING tenants onto GAM has them e-sign a
 * new lease. buildLeaseFromDocument calls generateMoveInInvoice
 * unconditionally, which bills every move_in lease_fee — including the security
 * deposit. Oak Park would have invoiced 19 sitting tenants $350 each for money
 * the landlord has held for years.
 *
 * The fix marks the custody row 'carried_forward' BEFORE the invoice runs,
 * reusing the S516 double-charge guard. These lock in the money behaviour:
 * the lease still STATES the deposit (so the signed document and the move-out
 * sweep are correct) but no deposit payment row is ever created.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { generateMoveInInvoice } from './moveInBundle'

beforeEach(async () => { await cleanupAllSchema() })

async function seedStack(opts: { alreadyHeld: boolean; deposit?: number }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000, startDate: '2026-09-01' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    const dep = opts.deposit ?? 350
    // The deposit IS stated on the lease either way — that is the point.
    await client.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
       VALUES ($1, 'security_deposit', $2, TRUE, 'move_in')`, [leaseId, dep])
    if (opts.alreadyHeld) {
      await client.query(
        `INSERT INTO security_deposits
           (unit_id, lease_id, tenant_id, total_amount, collected_amount,
            status, held_by, portability_status)
         VALUES ($1,$2,$3,$4,$4,'funded','landlord','carried_forward')`,
        [unitId, leaseId, tenantId, dep])
    }
    await client.query('COMMIT')
    return { landlordId, tenantId, unitId, leaseId, dep }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const runMoveIn = (s: any) => generateMoveInInvoice({
  lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
  landlord_id: s.landlordId, rent_amount: 1000, start_date: '2026-09-01',
})

const depositPayments = async (leaseId: string) => (await db.query(
  `SELECT amount::text FROM payments WHERE lease_id=$1 AND type='deposit'`, [leaseId])).rows

describe('S604 deposit already in custody', () => {
  it('does NOT bill the deposit when it is already held', async () => {
    const s = await seedStack({ alreadyHeld: true })
    const res = await runMoveIn(s)
    expect(res.depositInserted).toBe(false)
    expect(await depositPayments(s.leaseId)).toHaveLength(0)
  })

  it('the lease still STATES the deposit — only the billing is suppressed', async () => {
    const s = await seedStack({ alreadyHeld: true })
    await runMoveIn(s)
    // The lease_fees row survives, so the signed document and the move-out
    // deposit sweep both still see a $350 deposit.
    const { rows } = await db.query(
      `SELECT amount::text FROM lease_fees WHERE lease_id=$1 AND fee_type='security_deposit'`,
      [s.leaseId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(350)
    // And custody shows it funded, held by the landlord.
    const { rows: dep } = await db.query(
      `SELECT collected_amount::text, status, held_by FROM security_deposits WHERE lease_id=$1`,
      [s.leaseId])
    expect(Number(dep[0].collected_amount)).toBe(350)
    expect(dep[0].status).toBe('funded')
    expect(dep[0].held_by).toBe('landlord')
  })

  it('a genuinely NEW tenant is still billed normally', async () => {
    // The guard must not leak into the default path.
    const s = await seedStack({ alreadyHeld: false })
    const res = await runMoveIn(s)
    expect(res.depositInserted).toBe(true)
    const pays = await depositPayments(s.leaseId)
    expect(pays).toHaveLength(1)
    expect(Number(pays[0].amount)).toBe(350)
  })
})
