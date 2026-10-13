/**
 * 10/12 (Nic, G5): a processing fee the landlord covers that is bigger than
 * the money GAM holds from that payment. Nic's example: the landlord covers
 * the $6 bank fee on a $4 payment — $4 is withheld, $2 is not covered. The
 * uncovered part is BILLED TO THE LANDLORD as a GAM charge, collected from the
 * next payout or bank pull like every other GAM charge — never absorbed by GAM.
 *
 * Its own file: allocation.test.ts has other writers.
 */
import { describe, it, expect } from 'vitest'
import { executeRentAllocation } from './allocation'
import { withRollback, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule } from '../test/dbHelpers'

async function fx(client: any, feePayer: 'tenant' | 'landlord') {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  const tenantId = await seedTenant(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
  await seedAllocationRule(client, { propertyId, achFeePayer: feePayer, cardFeePayer: 'tenant' })
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
  const leaseId = (await client.query(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
     VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, landlordId])).rows[0].id
  await client.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
  return { landlordId, propertyId, unitId, tenantId, leaseId }
}

/** Bank: the flat $6 to the customer (cost 0.5%, cap $3). */
async function rates(client: any) {
  await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE effective_until IS NULL`)
  await client.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
        stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
     VALUES ('card', 0.30, 3.25, NULL, 0.30, 2.9, NULL),
            ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
}

async function bankPayment(client: any, f: any, amount: number, pi: string): Promise<string> {
  const id = (await client.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner,
                           settled_at, stripe_payment_intent_id, stripe_charge_id)
     VALUES ($1, $2, $3, $4, 'utility', $5, 'settled', '2026-10-01', 'UTILITY', 'landlord', now(), $6, 'ch_' || $6) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount, pi])).rows[0].id
  // The landlord covers the fee: nothing on top of the tenant's payment.
  await client.query(
    `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method,
                                     stripe_payment_intent_id, gross_amount, processing_fee_amount)
     VALUES ($1, $2, $3, $4, $4, 0, 'settled', 'ach', $5, $4, 0)`, [f.tenantId, f.landlordId, f.leaseId, amount, pi])
  return id
}

describe('a landlord-covered fee bigger than what GAM holds from the payment', () => {
  it('withholds what GAM holds and bills the rest to the landlord as a GAM charge, once', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, 'landlord')
      const pay = await bankPayment(client, f, 4, 'pi_four_dollars')

      await executeRentAllocation(client, pay, 'ach')

      const split = (await client.query(
        `SELECT landlord_fee_withheld::text AS withheld, landlord_fee_uncovered::text AS uncovered, owner_share::text AS owner
           FROM allocation_splits WHERE payment_id = $1`, [pay])).rows[0]
      expect(split).toEqual({ withheld: '4.00', uncovered: '2.00', owner: '0.00' })
      const charges = (await client.query(
        `SELECT kind, amount::text AS amount, property_id, source_type, source_id, collected_amount::text AS collected
           FROM landlord_gam_charges WHERE landlord_id = $1`, [f.landlordId])).rows
      expect(charges).toEqual([{
        kind: 'uncovered_processing_fee', amount: '2.00', property_id: f.propertyId,
        source_type: 'allocation_uncovered_fee', source_id: pay, collected: '0.00',
      }])
      // GAM's side is unchanged: the whole $6 fee is booked once.
      const spread = (await client.query(
        `SELECT customer_fee_charged::text AS fee FROM platform_revenue_ledger WHERE reference_id = $1 AND type = 'banking_spread'`,
        [pay])).rows
      expect(spread).toEqual([{ fee: '6.00' }])
      // Billed, so no admin is asked to collect it by hand.
      const alerts = await client.query(
        `SELECT 1 FROM admin_notifications WHERE context->>'payment_id' = $1`, [pay])
      expect(alerts.rowCount).toBe(0)

      // Allocated again (the idempotency short-circuit): nothing billed twice.
      await executeRentAllocation(client, pay, 'ach')
      const again = await client.query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1`, [f.landlordId])
      expect(again.rowCount).toBe(1)
    })
  })

  it('a payment that covers the fee bills nothing extra; a tenant-paid fee never does', async () => {
    await withRollback(async (client) => {
      await rates(client)
      const f = await fx(client, 'landlord')
      const pay = await bankPayment(client, f, 460, 'pi_covers_it')
      await executeRentAllocation(client, pay, 'ach')
      expect((await client.query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1`, [f.landlordId])).rowCount).toBe(0)
      const split = (await client.query(
        `SELECT landlord_fee_withheld::text AS withheld, landlord_fee_uncovered::text AS uncovered FROM allocation_splits WHERE payment_id = $1`,
        [pay])).rows[0]
      expect(split).toEqual({ withheld: '6.00', uncovered: '0.00' })

      const g = await fx(client, 'tenant')
      const small = await bankPayment(client, g, 4, 'pi_tenant_pays')
      await executeRentAllocation(client, small, 'ach')
      expect((await client.query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1`, [g.landlordId])).rowCount).toBe(0)
    })
  })
})
