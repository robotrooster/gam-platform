/**
 * 10/5 (Nic) — the landlord assistant and part payments.
 *
 * record_cash_payment goes through the same settle as the desk window, so at a
 * property with "Accept partial payments" on it records money short of the bill
 * as a part payment. The landlord must be told what stays owed and that late
 * fees still apply; and a bank deposit is never described as cash they hold.
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

async function fixture(acceptPartial: boolean) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET accept_partial_payments = $2 WHERE id = $1`, [propertyId, acceptPartial])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 600 })
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET first_name = 'Dana', last_name = 'Whitfield'
        WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    await seedLeaseTenant(c, { leaseId, tenantId })
    const rent = await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',600,'pending','RENT',DATE '2026-10-01') RETURNING id`,
      [ll.landlordId, unitId, leaseId, tenantId])
    await c.query('COMMIT')
    const actor: AgentActor = { userId: ll.userId, role: 'landlord', profileId: '', landlordIds: [ll.landlordId] } as AgentActor
    return { ...ll, tenantId, leaseId, rentId: rent.rows[0].id, actor }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('record_cash_payment and part payments', () => {
  it('refuses a short payment where the property takes payment in full only (nothing recorded)', async () => {
    const f = await fixture(false)
    const r: any = await recordCashPayment.execute(
      { tenant: 'Dana Whitfield', method: 'bank_deposit', amount: 500, reference: 'BR-77' }, f.actor)
    expect(r).toMatchObject({ ok: false, nothingRecorded: true })
    expect(r.error).toMatch(/That is \$100\.00 short — \$500\.00 against \$600\.00 owed\. Rent is paid in full\./)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('records a part payment and tells the landlord what stays owed and that late fees still apply', async () => {
    const f = await fixture(true)
    const r: any = await recordCashPayment.execute(
      { tenant: 'Dana Whitfield', method: 'bank_deposit', amount: 500, reference: 'BR-77' }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, paidOnBill: 500, stillOwed: 100 })
    expect(r.stillOwedRows).toEqual([{ bill: 'rent', dueDate: '2026-10-01', amount: 100 }])
    expect(r.note).toMatch(/This was a part payment: \$100\.00 stays owed \(\$100\.00 on the rent due 2026-10-01\) — late fees still apply\./)
    // A bank deposit is already in their bank — never "they are holding it".
    expect(r.note).toMatch(/the money is already in their bank/)
    expect(r.note).not.toMatch(/holding it/)
  })

  it('a cash payment in full still says they are holding it, with no part-payment line', async () => {
    const f = await fixture(true)
    const r: any = await recordCashPayment.execute(
      { tenant: 'Dana Whitfield', method: 'cash', amount: 600 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, stillOwed: 0, stillOwedRows: [] })
    expect(r.note).toMatch(/since they are holding it/)
    expect(r.note).not.toMatch(/part payment/)
  })
})
