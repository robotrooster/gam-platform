/**
 * S654 — the one "who owes what" behind the Outstanding list and the 7am
 * overdue digest. Oak Park's digest said $2,860 (rent rows only) while
 * $4,519.33 was open; these pin the shape that fixes it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant } from '../test/dbHelpers'
import { addDaysTo, todayIn } from '../lib/timezone'
import { listOpenTenantBalances } from './openBalances'

beforeEach(async () => { await cleanupAllSchema() })

const daysAgo = (n: number) => addDaysTo(todayIn(null), -n)
let invoiceSeq = 0

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A landlord with one property; spaces and bills are added per test. */
async function park() {
  return inTx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
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

async function space(p: { landlordId: string; propertyId: string }, unitNumber: string) {
  return inTx(async c => {
    const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId })
    await c.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [unitId, unitNumber])
    const leaseId = await seedLease(c, { unitId, landlordId: p.landlordId })
    return { unitId, leaseId }
  })
}

/** An open bill: one payments row per line, invoice total = the lines. */
async function bill(p: { landlordId: string }, tenantId: string, s: { unitId: string; leaseId: string },
                    dueDate: string, lines: Array<[string, number]>, total?: number) {
  const sum = total ?? lines.reduce((a, [, amt]) => a + amt, 0)
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [p.landlordId, tenantId, s.leaseId, s.unitId, `INV-OB-${++invoiceSeq}`, dueDate, sum])
  for (const [type, amt] of lines) {
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
      [inv.rows[0].id, s.unitId, s.leaseId, tenantId, p.landlordId, type, amt, dueDate, type.toUpperCase()])
  }
  return inv.rows[0].id
}

describe('S654 listOpenTenantBalances', () => {
  it('counts utilities, not just rent — the open invoice total', async () => {
    const p = await park()
    const t = await resident('Rashawn Bump')
    const s = await space(p, 'RV 10')
    await bill(p, t, s, daysAgo(30), [['rent', 440], ['utility', 997], ['utility', 25]])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe('1462.00')
  })

  it('two spaces are one line for one person', async () => {
    const p = await park()
    const t = await resident('Billy Miranda')
    const a = await space(p, 'RV 34')
    const b = await space(p, 'RV 35')
    await bill(p, t, a, daysAgo(30), [['rent', 440], ['utility', 17.07]])
    await bill(p, t, b, daysAgo(30), [['rent', 440], ['utility', 5.22]])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows).toHaveLength(1)
    expect(rows[0].unit_number).toBe('RV 34, RV 35')
    expect(rows[0].balance).toBe('902.29')
    expect(rows[0].spaces).toHaveLength(2)
  })

  it('a general credit is spent once across both spaces', async () => {
    const p = await park()
    const t = await resident('Josh Roby')
    const a = await space(p, 'MH 03')
    const b = await space(p, 'RV 27')
    await bill(p, t, a, daysAgo(30), [['rent', 500]])
    await bill(p, t, b, daysAgo(30), [['rent', 300]])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,NULL,100,100,'goodwill','test','active',$3)`, [p.landlordId, t, p.userId])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('700.00')
    expect(rows[0].spaces.reduce((s, x) => s + x.credit_applied, 0)).toBe(100)
  })

  it('overdueDays keeps only bills five or more days late', async () => {
    const p = await park()
    const t = await resident('Jay Jones')
    const s = await space(p, 'RV 25')
    await bill(p, t, s, daysAgo(6), [['rent', 440]])
    await bill(p, t, s, daysAgo(2), [['rent', 440]])    // not late enough yet
    const all = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(all[0].balance).toBe('880.00')
    const late = await listOpenTenantBalances({ landlordIds: [p.landlordId], overdueDays: 5 })
    expect(late[0].balance).toBe('440.00')
    expect(late[0].oldest_due_date).toBe(daysAgo(6))
    // Exactly five days counts.
    await db.query(`UPDATE invoices SET due_date = $1 WHERE due_date = $2`, [daysAgo(5), daysAgo(2)])
    const five = await listOpenTenantBalances({ landlordIds: [p.landlordId], overdueDays: 5 })
    expect(five[0].balance).toBe('880.00')
  })

  it('a work-trade month billed at $0 drops out', async () => {
    const p = await park()
    const t = await resident('Tyler Rhoades')
    const s = await space(p, 'RV 03')
    const inv = await bill(p, t, s, daysAgo(30), [['rent', 440]], 0)
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE invoice_id = $1`, [inv])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId] })).toEqual([])
  })

  it('eviction-mode units are left out only when asked', async () => {
    const p = await park()
    const t = await resident('Lena Christian')
    const s = await space(p, 'MH 09')
    await bill(p, t, s, daysAgo(30), [['rent', 440]])
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [s.unitId])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId] })).toHaveLength(1)
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId], excludePaymentBlocked: true })).toEqual([])
  })

  it('paid-ahead credit comes off first, lease-bound', async () => {
    const p = await park()
    const t = await resident('Dakota Lane')
    const s = await space(p, 'MH 25')
    await bill(p, t, s, daysAgo(30), [['rent', 460]])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1,$2,10,10)`, [s.leaseId, t])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('450.00')
    expect(rows[0].credit_on_account).toBe(10)
  })

  it('reads only the companies and properties it is given', async () => {
    const p = await park()
    const other = await park()
    const t = await resident('Pat Resident')
    await bill(p, t, await space(p, 'RV 1'), daysAgo(30), [['rent', 100]])
    await bill(other, t, await space(other, 'RV 2'), daysAgo(30), [['rent', 200]])
    const mine = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(mine.map(r => r.balance)).toEqual(['100.00'])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId], propertyIds: [other.propertyId] })).toEqual([])
    expect(await listOpenTenantBalances({ landlordIds: [] })).toEqual([])
  })
})
