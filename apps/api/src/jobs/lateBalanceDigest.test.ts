/**
 * S654 — the 7am overdue digest reads the Outstanding list.
 *
 * Oak Park's email said 7 lines / $2,860 (September rent rows) while $4,519.33
 * was open: utilities were invisible and two-space residents showed twice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'

const digestMock = vi.fn(async (_args: any) => undefined)
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendLatePaymentDigest: (a: any) => digestMock(a) }
})

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant } from '../test/dbHelpers'
import { addDaysTo, todayIn } from '../lib/timezone'
import { runLateBalanceDigest } from './lateBalanceDigest'

beforeEach(async () => {
  await cleanupAllSchema()
  digestMock.mockClear()
})

const daysAgo = (n: number) => addDaysTo(todayIn(null), -n)
let seq = 0

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function company(userId?: string) {
  return inTx(async c => {
    let ll: { userId: string; landlordId: string }
    if (userId) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01') RETURNING id`, [userId])
      ll = { userId, landlordId: r.rows[0].id }
    } else {
      ll = await seedLandlord(c)
    }
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, `Park ${++seq}`])
    return { ...ll, propertyId }
  })
}

async function resident(name: string) {
  return inTx(async c => {
    const tenantId = await seedTenant(c)
    const [first, last] = name.split(' ')
    await c.query(`UPDATE users SET first_name=$2, last_name=$3 WHERE id=(SELECT user_id FROM tenants WHERE id=$1)`,
      [tenantId, first, last])
    return tenantId
  })
}

async function owes(p: { landlordId: string; propertyId: string }, tenantId: string, unitNumber: string,
                    dueDate: string, lines: Array<[string, number]>) {
  const s = await inTx(async c => {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    await c.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId })
    return { unitId, leaseId }
  })
  const total = lines.reduce((a, [, amt]) => a + amt, 0)
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [p.landlordId, tenantId, s.leaseId, s.unitId, `INV-LD-${++seq}`, dueDate, total])
  for (const [type, amt] of lines) {
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
      [inv.rows[0].id, s.unitId, s.leaseId, tenantId, p.landlordId, type, amt, dueDate, type.toUpperCase()])
  }
  return s
}

describe('S654 runLateBalanceDigest', () => {
  it('the total is rent PLUS utilities, one line per person', async () => {
    const p = await company()
    const billy = await resident('Billy Miranda')
    const rashawn = await resident('Rashawn Bump')
    await owes(p, billy, 'RV 34', daysAgo(30), [['rent', 440], ['utility', 17.07]])
    await owes(p, billy, 'RV 35', daysAgo(30), [['rent', 440], ['utility', 5.22]])
    await owes(p, rashawn, 'RV 10', daysAgo(30), [['rent', 440], ['utility', 997], ['utility', 25]])

    const r = await runLateBalanceDigest()
    expect(r).toEqual({ accounts: 1, sent: 1, failed: 0 })
    expect(digestMock).toHaveBeenCalledTimes(1)
    const { items, ctx } = digestMock.mock.calls[0][0]
    expect(ctx.landlordId).toBe(p.landlordId)
    expect(items).toHaveLength(2)
    const billyLine = items.find((i: any) => i.tenantId === billy)
    expect(billyLine).toMatchObject({ tenantName: 'Billy Miranda', unitNumber: 'RV 34, RV 35', amount: 902.29, daysLate: 30 })
    expect(items.find((i: any) => i.tenantId === rashawn).amount).toBe(1462)
    expect(items.reduce((s: number, i: any) => s + i.amount, 0)).toBeCloseTo(2364.29, 2)
  })

  it('one email for an account with two companies', async () => {
    const a = await company()
    const b = await company(a.userId)
    await owes(a, await resident('Jay Jones'), 'RV 25', daysAgo(10), [['rent', 440]])
    await owes(b, await resident('Lena Christian'), 'MH 09', daysAgo(10), [['rent', 300], ['utility', 22.68]])

    await runLateBalanceDigest()
    expect(digestMock).toHaveBeenCalledTimes(1)
    const call = digestMock.mock.calls[0][0]
    expect(call.items.map((i: any) => i.amount).sort()).toEqual([322.68, 440])
    // Two companies: the greeting names the person, not one of the companies.
    expect(call.landlordName).toBe('Test Landlord')
  })

  it('different owners each get their own email; a resident is never merged across them', async () => {
    const a = await company()
    const b = await company()
    const t = await resident('Pat Resident')
    await owes(a, t, 'RV 1', daysAgo(10), [['rent', 100]])
    await owes(b, t, 'RV 2', daysAgo(10), [['rent', 200]])

    await runLateBalanceDigest()
    expect(digestMock).toHaveBeenCalledTimes(2)
    const amounts = digestMock.mock.calls.map((c: any) => c[0].items.map((i: any) => i.amount)).sort()
    expect(amounts).toEqual([[100], [200]])
  })

  it('nothing is sent when nothing is five days late', async () => {
    const p = await company()
    await owes(p, await resident('Josh Roby'), 'MH 03', daysAgo(2), [['rent', 440]])
    expect(await runLateBalanceDigest()).toEqual({ accounts: 0, sent: 0, failed: 0 })
    expect(digestMock).not.toHaveBeenCalled()
  })

  it('a unit in eviction mode is left out', async () => {
    const p = await company()
    const s = await owes(p, await resident('Josh Roby'), 'MH 03', daysAgo(10), [['rent', 440]])
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [s.unitId])
    await runLateBalanceDigest()
    expect(digestMock).not.toHaveBeenCalled()
  })
})
