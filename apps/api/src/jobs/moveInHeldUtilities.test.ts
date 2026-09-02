/**
 * S636 — held utilities must reach the tenant's FIRST invoice.
 *
 * Nic, on RV 28 the day the Coveys signed: "the suspended utilities are
 * not showing on their invoice. Why is there no water or electricity on
 * there?"
 *
 * S634 taught generateMoveInInvoice to pick up unbilled utility_bills
 * for the lease. What it could not see is that the release CREATING
 * those rows ran post-commit — after the invoice was built. The invoice
 * queried a lease with no utility bills and wrote $0.
 *
 * It looked fixed because the lease that prompted S634 (RV 02) had its
 * utilities attached to its invoice BY HAND. The code shipped, was never
 * exercised by a real signing, and the next signing failed identically.
 * These tests drive the real sequence — release, then invoice, on ONE
 * client — so that cannot happen again unnoticed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { generateMoveInInvoice } from './moveInBundle'
import { releaseSuspendedChargesForLease, attachStrandedUtilityBill } from '../services/utilityBilling'

beforeEach(async () => { await cleanupAllSchema() })

async function seedStack(heldAmount = 185.01) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const meterId = await seedUtilityMeter(client, { propertyId, billingMethod: 'submeter' })
    await client.query(
      `UPDATE utility_meters SET utility_type='electric' WHERE id=$1`, [meterId])
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 500, startDate: '2026-09-02' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    // The share held while the unit was mid-onboarding: real usage the
    // neighbours were already charged around.
    await client.query(
      `INSERT INTO suspended_utility_charges
         (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
          usage_amount, charge_amount)
       VALUES ($1,$2,$3,'2026-08-01','electric',881,$4)`,
      [meterId, unitId, landlordId, heldAmount])
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, meterId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const invoiceFor = async (leaseId: string) =>
  (await db.query<any>(
    `SELECT subtotal_rent, subtotal_utilities, total_amount
       FROM invoices WHERE lease_id=$1`, [leaseId])).rows[0]

describe('held utilities on the move-in invoice', () => {
  it('reaches the invoice when released first on the SAME transaction', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The production order after S636: release, then build the invoice.
      await releaseSuspendedChargesForLease({
        unitId: s.unitId, leaseId: s.leaseId, tenantId: s.tenantId,
        landlordId: s.landlordId, client,
      })
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const inv = await invoiceFor(s.leaseId)
    expect(Number(inv.subtotal_utilities)).toBe(185.01)
    expect(Number(inv.total_amount)).toBeCloseTo(Number(inv.subtotal_rent) + 185.01, 2)
  })

  it('the released share becomes a utility line the tenant can see', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await releaseSuspendedChargesForLease({
        unitId: s.unitId, leaseId: s.leaseId, tenantId: s.tenantId,
        landlordId: s.landlordId, client,
      })
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const rows = await db.query<any>(
      `SELECT amount, notes FROM payments
        WHERE lease_id=$1 AND type='utility'`, [s.leaseId])
    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0].amount)).toBe(185.01)
    expect(rows.rows[0].notes).toContain('Electric')

    // And the hold is settled, so no later run can bill it twice.
    const held = await db.query<any>(
      `SELECT released_at FROM suspended_utility_charges WHERE unit_id=$1`, [s.unitId])
    expect(held.rows[0].released_at).not.toBeNull()
  })

  it('reaches the invoice even when released AFTER it was built — order no longer matters', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The pre-S636 order: invoice first, release after.
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    await releaseSuspendedChargesForLease({
      unitId: s.unitId, leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId,
    })

    // The Covey bug: pre-S636 this left the invoice at $0 and the charge
    // stranded until the next month's run. Now it attaches to the open
    // invoice, so the tenant sees it the moment they log back in.
    const inv = await invoiceFor(s.leaseId)
    expect(Number(inv.subtotal_utilities)).toBe(185.01)
    const rows = await db.query<any>(
      `SELECT status FROM utility_bills WHERE lease_id=$1`, [s.leaseId])
    expect(rows.rows[0].status).toBe('billed')
  })

  it('never grows an invoice that is already settled', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    await db.query(`UPDATE invoices SET status='settled' WHERE lease_id=$1`, [s.leaseId])

    await releaseSuspendedChargesForLease({
      unitId: s.unitId, leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId,
    })

    const inv = await invoiceFor(s.leaseId)
    expect(Number(inv.subtotal_utilities)).toBe(0)
    // Left unbilled on purpose — the next run bills it, rather than a
    // settled invoice silently growing a line after payment.
    const rows = await db.query<any>(
      `SELECT status FROM utility_bills WHERE lease_id=$1`, [s.leaseId])
    expect(rows.rows[0].status).toBe('unbilled')
  })
})

describe('attaching a bill stranded by the monthly run', () => {
  it('puts it on the open invoice and marks it billed', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    // A bill the monthly run created AFTER that invoice was cut.
    const bill = await db.query<{ id: string }>(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
          charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',25.20,0,0,'electric') RETURNING id`,
      [s.meterId, s.unitId, s.tenantId, s.leaseId, s.landlordId])

    expect(await attachStrandedUtilityBill(bill.rows[0].id)).toBe(true)
    const inv = await invoiceFor(s.leaseId)
    expect(Number(inv.subtotal_utilities)).toBe(25.20)
    const row = await db.query<any>(
      `SELECT status, payment_id FROM utility_bills WHERE id=$1`, [bill.rows[0].id])
    expect(row.rows[0].status).toBe('billed')
    expect(row.rows[0].payment_id).not.toBeNull()
  })

  it('is idempotent — a second call does not bill it twice', async () => {
    const s = await seedStack()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await generateMoveInInvoice({
        lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
        landlord_id: s.landlordId, rent_amount: 500, start_date: '2026-09-02',
      } as any, client)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    const bill = await db.query<{ id: string }>(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
          charge_amount, tax_rate_pct, tax_amount, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',25.20,0,0,'electric') RETURNING id`,
      [s.meterId, s.unitId, s.tenantId, s.leaseId, s.landlordId])

    await attachStrandedUtilityBill(bill.rows[0].id)
    expect(await attachStrandedUtilityBill(bill.rows[0].id)).toBe(false)
    const inv = await invoiceFor(s.leaseId)
    expect(Number(inv.subtotal_utilities)).toBe(25.20)
  })
})
