/**
 * S655 (money plan Step 8, bug 2) — the landlord assistant never spends a
 * tenant's credit on its own.
 *
 * Nic (10/2): credit applies by itself only when it covers the whole bill;
 * otherwise whoever is taking the money is asked "use it or save it". The
 * desk window asks with two buttons. The assistant recording cash
 * (record_cash_payment) used to net every dollar of credit off the bill
 * silently — the landlord was told they had collected less than they were
 * handed, and the tenant's saved credit was gone. Now the tool stops and asks,
 * and records only once the landlord has answered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../adminNotifications', () => ({ createAdminNotification: vi.fn(async () => undefined) }))

import { db } from '../../../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'
import { recordCashPayment } from './recordCashPayment'
import { createIssuedCredit } from '../../creditUse'
import type { AgentActor } from './types'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function fixture() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
    const tenantId = await seedTenant(c)
    await c.query(
      `UPDATE users SET first_name = 'Frank', last_name = 'Moreno'
        WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    await seedLeaseTenant(c, { leaseId, tenantId })
    const rent = await c.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT',DATE '2026-10-01') RETURNING id`,
      [ll.landlordId, unitId, leaseId, tenantId])
    // A $100 goodwill credit the landlord gave on this lease.
    const credit = await c.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [ll.landlordId, tenantId, leaseId])
    await c.query('COMMIT')
    const actor: AgentActor = { userId: ll.userId, role: 'landlord', profileId: '', landlordIds: [ll.landlordId] } as AgentActor
    return { ...ll, tenantId, leaseId, rentId: rent.rows[0].id, creditId: credit.rows[0].id, actor }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const rentStatus = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status
const creditLeft = async (id: string) =>
  Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [id])).rows[0].r)

describe('record_cash_payment and account credit', () => {
  it('bug 2: the landlord agent never spends credit without saying use or save', async () => {
    const f = await fixture()
    const asked: any = await recordCashPayment.execute({ tenant: 'Frank Moreno', method: 'cash', amount: 360 }, f.actor)
    expect(asked).toMatchObject({
      ok: false, needsCreditChoice: true, creditAvailable: 100, owedIfUsed: 360, owedIfSaved: 460,
    })
    expect(asked.tellThem).toMatch(/use the \$100\.00 credit \(they owe \$360\.00\) or save it \(they owe \$460\.00\)/)
    // Nothing moved while the question was open.
    expect(await rentStatus(f.rentId)).toBe('pending')
    expect(await creditLeft(f.creditId)).toBe(100)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('"save" records the whole bill from the cash and keeps the credit', async () => {
    const f = await fixture()
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 460, credit: 'save', creditAvailable: 100 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, creditUsed: 0, paidOnBill: 460 })
    expect(await rentStatus(f.rentId)).toBe('settled')
    expect(await creditLeft(f.creditId)).toBe(100)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
  })

  it('"use" spends the credit on the bill and the cash pays the rest', async () => {
    const f = await fixture()
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 360, credit: 'use', creditAvailable: 100 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, creditUsed: 100, paidOnBill: 360 })
    expect(await rentStatus(f.rentId)).toBe('settled')
    expect(await creditLeft(f.creditId)).toBe(0)
    const uses = await db.query<any>(`SELECT status, source FROM credit_uses`)
    expect(uses.rows).toEqual([{ status: 'applied', source: 'landlord_agent' }])
    const rem = await db.query<any>(`SELECT amount::float AS amount, payment_method FROM tenant_remittances`)
    expect(rem.rows).toEqual([{ amount: 360, payment_method: 'cash' }])
  })

  // Fix round 1 (shelved 8): the landlord's answer counts only for the
  // figure they were told.
  it('a credit that moved since the landlord was told is asked again, and nothing is recorded', async () => {
    const f = await fixture()
    // The credit on file drops from $100 to $60 after the landlord was told $100 —
    // the way the product does it (a credit's balance moves only through
    // credit_uses once C0 is on): the $100 is withdrawn and a whole $60 issued.
    const c = await db.connect()
    let nowCreditId: string
    try {
      await c.query(`UPDATE tenant_credits SET status = 'void' WHERE id = $1`, [f.creditId])
      nowCreditId = await createIssuedCredit(c, { landlordId: f.landlordId, tenantId: f.tenantId, leaseId: f.leaseId, amount: 60, category: 'goodwill' })
    } finally { c.release() }
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 360, credit: 'use', creditAvailable: 100 }, f.actor)
    expect(r).toMatchObject({ ok: false, needsCreditChoice: true, creditAvailable: 60, owedIfUsed: 400, owedIfSaved: 460 })
    expect(r.error).toMatch(/The credit changed — it is now \$60\.00\. Nothing was recorded\./)
    expect(await rentStatus(f.rentId)).toBe('pending')
    expect(await creditLeft(nowCreditId)).toBe(60)
    expect(await creditLeft(f.creditId)).toBe(100)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('an answer sent without the figure it answered is asked again, and nothing is recorded', async () => {
    const f = await fixture()
    for (const credit of ['use', 'save']) {
      const r: any = await recordCashPayment.execute({ tenant: 'Frank', method: 'cash', amount: 460, credit }, f.actor)
      expect(r).toMatchObject({ ok: false, needsCreditChoice: true, creditAvailable: 100 })
      expect(r.error).toMatch(/creditAvailable/)
    }
    expect(await rentStatus(f.rentId)).toBe('pending')
    expect(await creditLeft(f.creditId)).toBe(100)
  })

  it('"use" when the credit is gone records nothing and says what is owed', async () => {
    const f = await fixture()
    await db.query(`UPDATE tenant_credits SET status = 'void' WHERE id = $1`, [f.creditId])
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 460, credit: 'use', creditAvailable: 100 }, f.actor)
    expect(r).toMatchObject({ ok: false, creditChanged: true, creditAvailable: 0, owed: 460 })
    expect(await rentStatus(f.rentId)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  it('an answer that is not "use" or "save" records nothing', async () => {
    const f = await fixture()
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 360, credit: 'yes' }, f.actor)
    expect(r.ok).toBe(false)
    expect(await rentStatus(f.rentId)).toBe('pending')
    expect(await creditLeft(f.creditId)).toBe(100)
  })

  // Fix round 2 (decisions.md: carried arrears are paid last, from whatever
  // is over the current bill): cash the landlord kept pays the old balance
  // before any of it becomes credit — the assistant takes the desk's path.
  it('cash kept as credit with an old balance open pays the old balance first', async () => {
    const f = await fixture()
    const { rows: [old] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       SELECT landlord_id, unit_id, lease_id, tenant_id, 'carried_balance', 1000, 'pending', 'BALANCE', DATE '2026-02-01'
         FROM payments WHERE id = $1 RETURNING id`, [f.rentId])
    const r: any = await recordCashPayment.execute(
      { tenant: 'Frank', method: 'cash', amount: 500, credit: 'save', creditAvailable: 100, surplus: 'credit' }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, creditUsed: 0, towardOldBalance: 40, keptAsCredit: 0, changeGiven: 0 })
    expect(await rentStatus(f.rentId)).toBe('settled')
    const parts = await db.query<any>(
      `SELECT amount::text AS amount, status FROM payments WHERE type = 'carried_balance' ORDER BY is_remainder, amount`)
    expect(parts.rows).toEqual([{ amount: '40.00', status: 'settled' }, { amount: '960.00', status: 'pending' }])
    expect(old).toBeTruthy()
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits`)).rowCount).toBe(0)
    expect(await creditLeft(f.creditId)).toBe(100)
  })

  it('with no usable credit it records without asking', async () => {
    const f = await fixture()
    await db.query(`UPDATE tenant_credits SET status = 'void' WHERE id = $1`, [f.creditId])
    const r: any = await recordCashPayment.execute({ tenant: 'Frank', method: 'cash', amount: 460 }, f.actor)
    expect(r).toMatchObject({ ok: true, recorded: true, creditUsed: 0 })
    expect(await rentStatus(f.rentId)).toBe('settled')
  })
})
