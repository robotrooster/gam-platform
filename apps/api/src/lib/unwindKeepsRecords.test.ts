/**
 * 10/12 (Nic, G8) — keep everything: the last hard deletes in voiding a lease
 * before the tenant signed (lib/unwindIssuedLease) and in a new lease that
 * will never start (services/renewalSuccessor) are now VOIDS, kept forever:
 *   - a utility bill (its usage goes back on hold) is voided OUT OF ITS CYCLE
 *     SLOT, so whoever the space is billed to next can be billed that month;
 *   - an empty pending deposit record is voided (status 'voided');
 *   - an open work-trade period on a bill that will never be owed is voided.
 * And every reader of what the tenant has leaves them out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
  seedUtilityMeter,
} from '../test/dbHelpers'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => null) }
})

import { unwindIssuedLease, UTILITY_BILL_LEASE_VOIDED_VOID, DEPOSIT_LEASE_VOIDED_VOID, WORK_TRADE_PERIOD_LEASE_VOIDED_VOID } from './unwindIssuedLease'
import { clearNeverOwedOnHeldNewLease, WORK_TRADE_PERIOD_NEVER_STARTS_VOID } from '../services/renewalSuccessor'

beforeEach(async () => { await cleanupAllSchema() })

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
const q = (c: PoolClient) => (text: string, params?: any[]) => c.query(text, params)

async function fixture(start = '2026-10-01') {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460, startDate: start })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId }
  })
}
type Fx = Awaited<ReturnType<typeof fixture>>

async function billOn(f: Fx, leaseId: string, due: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_utilities, total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,460,30,490) RETURNING id`,
    [f.landlordId, f.tenantId, leaseId, f.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, due])).rows[0].id
}

async function utilityOn(f: Fx, leaseId: string, invoiceId: string, due: string): Promise<{ bill: string; pay: string }> {
  const pay = (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, invoice_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$5,'utility',30,'pending',$6,'UTILITY') RETURNING id`,
    [f.unitId, leaseId, invoiceId, f.tenantId, f.landlordId, due])).rows[0].id
  const bill = (await db.query<{ id: string }>(
    `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount,
                                status, payment_id, utility_type, billed_at)
     VALUES ($1,$2,$3,$4,$5,'2026-09-01',30,'billed',$6,'water',now()) RETURNING id`,
    [f.meterId, f.unitId, f.tenantId, leaseId, f.landlordId, pay])).rows[0].id
  return { bill, pay }
}

async function openPeriod(f: Fx, leaseId: string, invoiceId: string, month: string): Promise<string> {
  const agreement = (await db.query<{ id: string }>(
    `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`, [f.unitId, f.tenantId, f.landlordId, month])).rows[0].id
  return (await db.query<{ id: string }>(
    `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
     VALUES ($1,$2,$3,20,23,460) RETURNING id`, [agreement, invoiceId, month])).rows[0].id
}

describe('a lease voided before the tenant signed', () => {
  it('keeps its utility bill (voided, out of its slot), its empty deposit record and its open work-trade period as voided records', async () => {
    const f = await fixture()
    const inv = await billOn(f, f.leaseId, '2026-10-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, invoice_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','2026-10-01','RENT')`, [f.unitId, f.leaseId, inv, f.tenantId, f.landlordId])
    const { bill } = await utilityOn(f, f.leaseId, inv, '2026-10-01')
    const dep = (await db.query<{ id: string }>(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,500,0,'pending','landlord') RETURNING id`, [f.unitId, f.leaseId, f.tenantId])).rows[0].id
    const period = await openPeriod(f, f.leaseId, inv, '2026-10-01')

    const out = await tx(c => unwindIssuedLease(q(c),
      { id: '00000000-0000-0000-0000-0000000000b1', lease_id: f.leaseId, issued_at: new Date(), unit_id: f.unitId }))
    expect(out.unwound).toBe(true)

    const b = (await db.query<any>(
      `SELECT status, payment_id, voided_at IS NOT NULL AS voided, void_reason, charge_amount::float AS amount FROM utility_bills WHERE id = $1`, [bill])).rows[0]
    expect(b).toEqual({ status: 'void', payment_id: null, voided: true, void_reason: UTILITY_BILL_LEASE_VOIDED_VOID, amount: 30 })
    // The usage went back on hold for whoever the space is billed to next…
    expect((await db.query(`SELECT 1 FROM suspended_utility_charges WHERE meter_id = $1 AND unit_id = $2`, [f.meterId, f.unitId])).rowCount).toBe(1)
    // …and that next bill can take the month's slot (the voided one left it).
    const next = await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount, status, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',30,'unbilled','water') ON CONFLICT DO NOTHING RETURNING id`,
      [f.meterId, f.unitId, f.tenantId, f.leaseId, f.landlordId])
    expect(next.rowCount).toBe(1)

    expect((await db.query<any>(`SELECT status, void_reason FROM security_deposits WHERE id = $1`, [dep])).rows[0])
      .toEqual({ status: 'voided', void_reason: DEPOSIT_LEASE_VOIDED_VOID })
    expect((await db.query<any>(`SELECT status, void_reason FROM work_trade_settlements WHERE id = $1`, [period])).rows[0])
      .toEqual({ status: 'voided', void_reason: WORK_TRADE_PERIOD_LEASE_VOIDED_VOID })
    // A voided record is a record: it does not change again.
    await expect(db.query(`UPDATE security_deposits SET total_amount = 600 WHERE id = $1`, [dep])).rejects.toThrow(/voided/)
    await expect(db.query(`UPDATE work_trade_settlements SET hours_worked = 5 WHERE id = $1`, [period])).rejects.toThrow(/voided/)
  })

  it('a voided deposit record is no deposit: the tenant\'s deposit card shows none', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by, voided_at, void_reason)
       VALUES ($1,$2,$3,500,0,'voided','landlord', now(), 'test')`, [f.unitId, f.leaseId, f.tenantId])
    const { getMyDeposit } = await import('../services/agents/tools/getMyDeposit')
    const out = await (getMyDeposit as any).execute({}, { profileId: f.tenantId, role: 'tenant', userId: f.userId })
    expect(out).toMatchObject({ ok: true, hasDeposit: false })
  })
})

describe('a new lease that will never start', () => {
  it('voids the open work-trade period on its voided bill instead of deleting it', async () => {
    const f = await fixture('2025-10-01')
    const newLeaseId = await tx(async c => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, supersedes_lease_id, lease_source)
         VALUES ($1,$2,480,'month_to_month','pending','2026-11-01',$3,'esigned') RETURNING id`,
        [f.unitId, f.landlordId, f.leaseId])).rows[0].id
      await seedLeaseTenant(c, { leaseId: id, tenantId: f.tenantId, role: 'primary' })
      return id
    })
    const inv = await billOn(f, newLeaseId, '2026-11-01')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, invoice_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',480,'pending','2026-11-01','RENT')`, [f.unitId, newLeaseId, inv, f.tenantId, f.landlordId])
    const period = await openPeriod(f, newLeaseId, inv, '2026-11-01')

    const out = await tx(c => clearNeverOwedOnHeldNewLease(q(c), newLeaseId, f.leaseId))
    expect(out.bills).toBe(1)
    expect((await db.query<any>(`SELECT status, void_reason FROM work_trade_settlements WHERE id = $1`, [period])).rows[0])
      .toEqual({ status: 'voided', void_reason: WORK_TRADE_PERIOD_NEVER_STARTS_VOID })
    // Run again: nothing changes, nothing throws on the voided period.
    await tx(c => clearNeverOwedOnHeldNewLease(q(c), newLeaseId, f.leaseId))
  })
})
