/**
 * Leftovers (charges5): the landlord assistant never records cash for a
 * FlexDeposit installment.
 *
 * A FlexDeposit installment is GAM's custody collection, paid online to GAM
 * (CLAUDE.md, FlexDeposit custody model). Only the bank-deposit match used to
 * leave it out; record_cash_payment found it through bankPayableRowSql and
 * would have let the landlord take cash for GAM's custody money. The rule now
 * lives in moneyPredicates.bankPayableRowSql, so the tool, the desk and the
 * bank match all leave it out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../adminNotifications', () => ({ createAdminNotification: vi.fn(async () => undefined) }))

import { db } from '../../../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'
import { recordCashPayment } from './recordCashPayment'
import type { AgentActor } from './types'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function fixture(o: { rentToo: boolean }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET first_name = 'Faye', last_name = 'Custody'
        WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status, flex_deposit_enabled)
       VALUES ($1,$2,$3,600,0,'gam_escrow','pending',TRUE)`, [unitId, leaseId, tenantId])
    const installment = (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'deposit',150,'pending','DEPOSIT',DATE '2026-10-01') RETURNING id`,
      [ll.landlordId, unitId, leaseId, tenantId])).rows[0].id
    const rent = o.rentToo ? (await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',DATE '2026-10-01') RETURNING id`,
      [ll.landlordId, unitId, leaseId, tenantId])).rows[0].id : null
    await c.query('COMMIT')
    const actor: AgentActor = { userId: ll.userId, role: 'landlord', profileId: '', landlordIds: [ll.landlordId] } as AgentActor
    return { installment, rent, actor }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const status = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status

describe('record_cash_payment and FlexDeposit', () => {
  it('finds nothing to record when the only open charge is a FlexDeposit installment', async () => {
    const f = await fixture({ rentToo: false })
    const r: any = await recordCashPayment.execute({ tenant: 'Faye Custody', method: 'cash', amount: 150 }, f.actor)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Nothing open to record/)
    expect(await status(f.installment)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('records the rent and leaves the FlexDeposit installment for GAM to collect online', async () => {
    const f = await fixture({ rentToo: true })
    const r: any = await recordCashPayment.execute({ tenant: 'Faye Custody', method: 'cash', amount: 460 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true })
    expect(await status(f.rent!)).toBe('settled')
    expect(await status(f.installment)).toBe('pending')
  })
})
