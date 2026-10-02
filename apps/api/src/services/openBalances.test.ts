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
    expect(rows[0].prepaid_held).toBe(0)
  })

  // S654: credit_on_account is what the desk says was "taken off". With a $100
  // monthly draw on $1,000 held, $100 was — the rest is reported as still held.
  it('a monthly draw: $100 taken off, $900 still held, reported apart', async () => {
    const p = await park()
    const t = await resident('Glenda Greek')
    const s = await space(p, 'RV 12')
    await bill(p, t, s, daysAgo(30), [['rent', 460]])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [s.leaseId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1,$2,1000,1000)`, [s.leaseId, t])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('360.00')
    expect(rows[0].credit_on_account).toBe(100)
    expect(rows[0].prepaid_held).toBe(900)
  })

  // S654: every open bill takes its share, oldest first — the same plan the
  // charge settles, so this list, the portal and what settles agree.
  it('two open bills: paid-ahead covers September, then $10 of October', async () => {
    const p = await park()
    const t = await resident('Mark Rensberger')
    const s = await space(p, 'RV 41')
    await bill(p, t, s, daysAgo(55), [['rent', 460]])
    await bill(p, t, s, daysAgo(10), [['rent', 460]])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1,$2,470,470)`, [s.leaseId, t])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('450.00')
    expect(rows[0].credit_on_account).toBe(470)
    expect(rows[0].prepaid_held).toBe(0)
    // The overdue digest reads only the older bill: paid-ahead covers it whole.
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId], overdueDays: 20 })).toEqual([])
  })

  it('two open bills under a $100 monthly draw: $100 off each', async () => {
    const p = await park()
    const t = await resident('Todd Niemeyer')
    const s = await space(p, 'RV 42')
    await bill(p, t, s, daysAgo(55), [['rent', 460]])
    await bill(p, t, s, daysAgo(10), [['rent', 460]])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 100 WHERE id = $1`, [s.leaseId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1,$2,1000,1000)`, [s.leaseId, t])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('720.00')
    expect(rows[0].credit_on_account).toBe(200)
    expect(rows[0].prepaid_held).toBe(800)
  })

  // S654: the landlord's credit clears only this lease's own charges — the
  // same cap the charge uses — never a neighbor's utility billed alongside.
  it('a neighbor’s utility on the bill is not taken off by this landlord’s credit', async () => {
    const p = await park()
    const nb = await park()
    const t = await resident('Ruth Neighbor')
    const s = await space(p, 'RV 7')
    const inv = await bill(p, t, s, daysAgo(30), [['rent', 460]], 500)
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,NULL,$3,$4,'utility',40,'pending',$5,'UTILITY')`, [inv, s.unitId, t, nb.landlordId, daysAgo(30)])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,480,480,'goodwill')`, [p.landlordId, t, s.leaseId])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows[0].balance).toBe('40.00')
    expect(rows[0].spaces[0].credit_applied).toBe(460)
  })

  // S654: an account with two companies — a general credit from one is never
  // taken off the other's bill, even when that bill is older.
  it('one company’s general credit never comes off another company’s bill', async () => {
    const a = await park()
    const b = await park()
    const t = await resident('Kim Twocos')
    const sa = await space(a, 'A 1')
    const sb = await space(b, 'B 1')
    await bill(a, t, sa, daysAgo(10), [['rent', 300]])
    await bill(b, t, sb, daysAgo(30), [['rent', 500]])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,100,100,'goodwill')`, [a.landlordId, t])
    const rows = await listOpenTenantBalances({ landlordIds: [a.landlordId, b.landlordId] })
    expect(rows[0].balance).toBe('700.00')
    const byLease = new Map(rows[0].spaces.map(x => [x.lease_id, x.credit_applied]))
    expect(byLease.get(sa.leaseId)).toBe(100)
    expect(byLease.get(sb.leaseId)).toBe(0)
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
