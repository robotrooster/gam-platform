/**
 * The one "who owes what" behind the Outstanding list, the 7am overdue digest,
 * the balance reminder, the tenant page and the agents.
 *
 * S654: Oak Park's digest said $2,860 (rent rows only) while $4,519.33 was open.
 * S655 (money plan, Step 11): the figure is every open CHARGE (late fees and
 * charges on no invoice included, as the portal counts them), the FULL balance,
 * with the credit that could pay it shown beside it — never taken off it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { addDaysTo, todayIn } from '../lib/timezone'
import {
  listOpenTenantBalances, creditBeside, openBalanceSql, openAmountSql, outstandingTotals, seesGrandTotals,
  daysLate, OUTSTANDING_ROW_STATUS_LABEL, showCreditOncePerHousehold,
} from './openBalances'

beforeEach(async () => { await cleanupAllSchema() })

const daysAgo = (n: number) => addDaysTo(todayIn(null), -n)
let invoiceSeq = 0
const ENTRY: Record<string, string> = { late_fee: 'LATEFEE', home_payment: 'HOMEPMT', fee: 'OTHERFEE' }

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

/** An open bill: one payments row per line, invoice total = the lines. Returns the invoice and row ids. */
async function bill(p: { landlordId: string }, tenantId: string, s: { unitId: string; leaseId: string },
                    dueDate: string, lines: Array<[string, number]>, total?: number) {
  const sum = total ?? lines.reduce((a, [, amt]) => a + amt, 0)
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [p.landlordId, tenantId, s.leaseId, s.unitId, `INV-OB-${++invoiceSeq}`, dueDate, sum])
  const rows: string[] = []
  for (const [type, amt] of lines) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING id`,
      [inv.rows[0].id, s.unitId, s.leaseId, tenantId, p.landlordId, type, amt, dueDate,
       ENTRY[type] ?? type.toUpperCase()])
    rows.push(r.rows[0].id)
  }
  return { invoiceId: inv.rows[0].id, rows }
}

async function generalCredit(p: { landlordId: string; userId: string }, tenantId: string, amount: number, leaseId: string | null = null) {
  await db.query(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
     VALUES ($1,$2,$3,$4,$4,'goodwill','test','active',$5)`, [p.landlordId, tenantId, leaseId, amount, p.userId])
}

describe('S654 listOpenTenantBalances', () => {
  it('counts utilities, not just rent — every open charge', async () => {
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
    expect(rows[0].unit_number!.split(', ').sort()).toEqual(['RV 34', 'RV 35'])
    expect(rows[0].balance).toBe('902.29')
    expect(rows[0].spaces).toHaveLength(2)
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
    const { invoiceId } = await bill(p, t, s, daysAgo(30), [['rent', 440]], 0)
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE invoice_id = $1`, [invoiceId])
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

describe('S655 the full balance, with credit beside it', () => {
  it('Outstanding shows the full balance with usable credit beside it', async () => {
    const p = await park()
    const t = await resident('Josh Roby')
    const a = await space(p, 'MH 03')
    const b = await space(p, 'RV 27')
    await bill(p, t, a, daysAgo(30), [['rent', 500]])
    await bill(p, t, b, daysAgo(30), [['rent', 300]])
    await generalCredit(p, t, 100)
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    // Nothing is taken off: $800 is owed until they choose to use the credit.
    expect(rows[0].balance).toBe('800.00')
    expect(rows[0].credit_available).toBe(100)
    expect(rows[0].credit_on_account).toBe(100)
    // The credit is counted once, on one space (oldest bill first), never on both.
    expect(rows[0].spaces.reduce((s, x) => s + x.credit_available, 0)).toBe(100)
    expect(rows[0].spaces.reduce((s, x) => s + x.balance, 0)).toBe(800)
  })

  it('usable credit stops at a monthly draw cap; all of it is still on the account', async () => {
    const p = await park()
    const t = await resident('Kelly Draw')
    const s = await space(p, 'RV 40')
    await bill(p, t, s, daysAgo(2), [['rent', 589]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,2000,2000,'landlord')`, [s.leaseId, t])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id = $1`, [s.leaseId])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.balance).toBe('589.00')
    expect(row.credit_available).toBe(200)
    expect(row.credit_on_account).toBe(2000)
  })

  it('a withdrawn paid-ahead credit is neither available nor on the account', async () => {
    const p = await park()
    const t = await resident('Vic Voided')
    const s = await space(p, 'RV 41')
    await bill(p, t, s, daysAgo(2), [['rent', 400]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, voided_at, void_reason)
                    VALUES ($1,$2,50,50,'landlord',NOW(),'undone bank deposit')`, [s.leaseId, t])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.credit_available).toBe(0)
    expect(row.credit_on_account).toBe(0)
  })

  it('credit never pays a home payment, so it is on the account but not available for one', async () => {
    const p = await park()
    const t = await resident('Shane Rueff')
    const s = await space(p, 'MH 11')
    await bill(p, t, s, daysAgo(2), [['home_payment', 200]])
    await generalCredit(p, t, 50)
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.balance).toBe('200.00')
    expect(row.credit_available).toBe(0)
    expect(row.credit_on_account).toBe(50)
  })

  it('a lease whose charges sit on two spaces (a move mid-lease) has its credit counted once', async () => {
    const p = await park()
    const t = await resident('Moe Ved')
    const a = await space(p, 'RV 50')
    const otherUnit = await inTx(c => seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId }))
    await db.query(`UPDATE units SET unit_number = 'RV 51' WHERE id = $1`, [otherUnit])
    await bill(p, t, a, daysAgo(40), [['rent', 300]])
    // The same lease, billed at the space they moved to.
    await bill(p, t, { unitId: otherUnit, leaseId: a.leaseId }, daysAgo(10), [['rent', 300]])
    await generalCredit(p, t, 50, a.leaseId)
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.spaces).toHaveLength(2)
    expect(row.spaces.every(x => x.lease_id === a.leaseId)).toBe(true)
    expect(row.credit_available).toBe(50)
    expect(row.spaces.reduce((sum, x) => sum + x.credit_available, 0)).toBe(50)
    expect(row.balance).toBe('600.00')
  })

  it('a shared lease billed to two of its people shows its credit once across the whole list, and is one household', async () => {
    const p = await park()
    const primary = await resident('Pat Primary')
    const co = await resident('Cory Cotenant')
    const s = await space(p, 'RV 60')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: primary, role: 'primary' })
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: co, role: 'co_tenant' })
    })
    // Rent billed to the primary, a fee billed to the co-tenant: two lines, one lease.
    await bill(p, primary, s, daysAgo(20), [['rent', 500]])
    await bill(p, co, s, daysAgo(10), [['fee', 40]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,100,100,'landlord')`, [s.leaseId, primary])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.balance).sort()).toEqual(['40.00', '500.00'])
    // $100 of paid-ahead money, shown once — beside the oldest bill (the primary's rent).
    expect(rows.reduce((sum, r) => sum + r.credit_available, 0)).toBe(100)
    expect(rows.find(r => r.tenant_id === primary)!.credit_available).toBe(100)
    expect(rows.find(r => r.tenant_id === co)!.credit_available).toBe(0)
    expect(rows.flatMap(r => r.spaces).reduce((sum, x) => sum + x.credit_available, 0)).toBe(100)
    // Every dollar owed counted once, and one household, not two.
    const totals = outstandingTotals(rows)
    expect(totals.owed).toBe(540)
    expect(totals.households).toBe(1)
  })

  /** Pat (rent $500, older) and Cory (a $40 fee) on one lease, $100 paid ahead on it. */
  async function sharedLease() {
    const p = await park()
    const pat = await resident('Pat Primary')
    const cory = await resident('Cory Cotenant')
    const s = await space(p, 'RV 63')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: pat, role: 'primary' })
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: cory, role: 'co_tenant' })
    })
    await bill(p, pat, s, daysAgo(20), [['rent', 500]])
    await bill(p, cory, s, daysAgo(10), [['fee', 40]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,100,100,'landlord')`, [s.leaseId, pat])
    return { p, pat, cory, s }
  }

  it('the co-tenant whose shared credit sits on the other line never reads "none of it can pay"', async () => {
    const { p, pat, cory } = await sharedLease()
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    const patRow = rows.find(r => r.tenant_id === pat)!
    const coryRow = rows.find(r => r.tenant_id === cory)!
    expect(patRow.credit_available).toBe(100)
    expect(patRow.credit_on_account).toBe(100)
    // The lease's $100 is on Pat's line, available and on file alike — not on Cory's.
    expect(coryRow.credit_available).toBe(0)
    expect(coryRow.credit_on_account).toBe(0)
    for (const r of rows) expect(r.credit_available <= 0 && r.credit_on_account > 0).toBe(false)
    expect(rows.reduce((sum, r) => sum + r.credit_on_account, 0)).toBe(100)
  })

  // decisions #48.8 (renamed from "two co-tenants who each have their own
  // general credit each show it beside their own line"): one household, one
  // balance — its credit shows once, as household credit, on one line.
  it("co-tenants' own general credits show once, together with the lease's, as household credit on one line", async () => {
    const { p, pat, cory } = await sharedLease()
    await generalCredit(p, pat, 30)
    await generalCredit(p, cory, 60)
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    const patRow = rows.find(r => r.tenant_id === pat)!
    const coryRow = rows.find(r => r.tenant_id === cory)!
    // The lease's $100 + Pat's $30 + Cory's $60, all on Pat's line (it already
    // carried the most); the household owes $540, so all $190 is available.
    expect(patRow.credit_available).toBe(190)
    expect(patRow.credit_on_account).toBe(190)
    expect(patRow.household_credit).toBe(true)
    expect(coryRow.credit_available).toBe(0)
    expect(coryRow.credit_on_account).toBe(0)
    expect(coryRow.household_credit_on).toBe(pat)
    expect(rows.reduce((sum, r) => sum + r.credit_available, 0)).toBe(190)
    expect(rows.flatMap(r => r.spaces).reduce((sum, x) => sum + x.credit_available, 0)).toBe(190)
    // Each person's own quote is unchanged (the reminder, the desk window).
    const patOwn = await creditBeside({ tenantId: pat, landlordIds: [p.landlordId] })
    expect(patOwn.usable).toBe(130)
  })

  it("household credit never reads more than the household owes: $100 paid ahead + Pat's $50 + Cory's $50 against $140 owed", async () => {
    // The step11-3 probe: it showed 140 on Pat's line and 40 on Cory's — $180
    // "available" against $140 owed.
    const p = await park()
    const pat = await resident('Pat Probe')
    const cory = await resident('Cory Probe')
    const s = await space(p, 'RV 70')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: pat, role: 'primary' })
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: cory, role: 'co_tenant' })
    })
    await bill(p, pat, s, daysAgo(20), [['rent', 100]])
    await bill(p, cory, s, daysAgo(10), [['fee', 40]])
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
                    VALUES ($1,$2,100,100,'landlord')`, [s.leaseId, pat])
    await generalCredit(p, pat, 50)
    await generalCredit(p, cory, 50)
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows.map(r => r.balance).sort()).toEqual(['100.00', '40.00'])
    // Once, as household credit, capped at the $140 owed.
    expect(rows.reduce((sum, r) => sum + r.credit_available, 0)).toBe(140)
    const home = rows.find(r => r.household_credit)!
    expect(home.credit_available).toBe(140)
    expect(home.spaces.reduce((sum, x) => sum + x.credit_available, 0)).toBe(140)
    // On the account: every dollar once — $100 + $50 + $50.
    expect(home.credit_on_account).toBe(200)
    const other = rows.find(r => r !== home)!
    expect(other).toMatchObject({ credit_available: 0, credit_on_account: 0, household_credit: false, household_credit_on: home.tenant_id })
    expect(outstandingTotals(rows).households).toBe(1)
  })

  it('household credit moved onto a line goes first to its spaces that still owe, so no space reads credit with room elsewhere', () => {
    // Pat (the home line) has $70 of credit beside RV 1, which owes $20, and
    // owes $100 on RV 2; Cory's $40 joins the household's credit on Pat's line.
    const sp = (lease: string, unit: string, balance: number, credit: number) => ({
      landlord_id: 'll', lease_id: lease, unit_number: unit, property_id: 'pr', property_name: 'Park',
      balance, credit_available: credit, open_invoices: 1, open_charges: 0, oldest_due_date: '2026-09-01',
      months: [], days_late: 0, clearing: 0,
    })
    const line = (tenant: string, spaces: any[], balance: number, credit: number) => ({
      tenant_id: tenant, first_name: tenant, last_name: null, phone: null, email: null, unit_number: null,
      property_id: 'pr', property_ids: ['pr'], property_name: 'Park', balance: balance.toFixed(2),
      credit_available: credit, credit_on_account: credit, open_invoices: 1, open_charges: 0,
      oldest_due_date: '2026-09-01', months: [], days_late: 0, clearing: 0, work_trade: false, status: 'owes',
      status_label: 'Owes', record_with: [], spaces, household_credit: false, household_credit_on: null,
    }) as any
    const pat = line('t-pat', [sp('L1', 'RV 1', 20, 70), sp('L2', 'RV 2', 100, 0)], 120, 70)
    const cory = line('t-cory', [sp('L1', 'RV 1', 50, 40)], 50, 40)
    showCreditOncePerHousehold([pat, cory])
    expect(pat.household_credit).toBe(true)
    expect(pat.credit_available).toBe(110)
    expect(pat.spaces.map((x: any) => x.credit_available)).toEqual([70, 40])
    expect(cory).toMatchObject({ credit_available: 0, household_credit_on: 't-pat' })
  })

  it('a lease credit nothing on the list can pay is still on file once', async () => {
    const p = await park()
    const pat = await resident('Hal Home')
    const cory = await resident('Cat Home')
    const s = await space(p, 'MH 64')
    await inTx(async c => {
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: pat, role: 'primary' })
      await seedLeaseTenant(c, { leaseId: s.leaseId, tenantId: cory, role: 'co_tenant' })
    })
    // Credit never pays a home payment: the lease's credit can pay nothing here.
    await bill(p, pat, s, daysAgo(20), [['home_payment', 300]])
    await bill(p, cory, s, daysAgo(10), [['home_payment', 200]])
    await generalCredit(p, pat, 25, s.leaseId)
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows.reduce((sum, r) => sum + r.credit_available, 0)).toBe(0)
    expect(rows.reduce((sum, r) => sum + r.credit_on_account, 0)).toBe(25)
  })

  it('two people on two different leases are still two households', async () => {
    const p = await park()
    const a = await resident('Ann Apart')
    const b = await resident('Ben Apart')
    const sa = await space(p, 'RV 61')
    const sb = await space(p, 'RV 62')
    await bill(p, a, sa, daysAgo(10), [['rent', 300]])
    await bill(p, b, sb, daysAgo(10), [['rent', 300]])
    expect(outstandingTotals(await listOpenTenantBalances({ landlordIds: [p.landlordId] })).households).toBe(2)
  })

  it('a property-locked worker sees only the credit of the leases at their properties', async () => {
    const p = await park()
    const t = await resident('Two Parks')
    const a = await space(p, 'RV 5')
    const otherProp = await inTx(c => seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }))
    const b = await space({ ...p, propertyId: otherProp }, 'RV 6')
    await bill(p, t, a, daysAgo(10), [['rent', 300]])
    await bill(p, t, b, daysAgo(10), [['rent', 300]])
    await generalCredit(p, t, 75, b.leaseId)             // tied to the space at the other park
    const scoped = await listOpenTenantBalances({ landlordIds: [p.landlordId], propertyIds: [p.propertyId] })
    expect(scoped[0].balance).toBe('300.00')
    expect(scoped[0].credit_available).toBe(0)
    expect(scoped[0].credit_on_account).toBe(0)
    const all = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(all[0].credit_available).toBe(75)
  })
})

describe('S655 every open charge, as the portal counts it', () => {
  it('a row with no invoice is still outstanding', async () => {
    const p = await park()
    const t = await resident('Andres Counter')
    const s = await space(p, 'RV 30')
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, notes)
       VALUES ($1,$2,$3,'fee',35,'pending',$4,'OTHERFEE','Dump station')`, [s.unitId, t, p.landlordId, daysAgo(3)])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows).toHaveLength(1)
    expect(rows[0].balance).toBe('35.00')
    expect(rows[0].open_invoices).toBe(1)
  })

  it('a late fee is owed here exactly as it is in the portal', async () => {
    const p = await park()
    const t = await resident('Lucy Late')
    const s = await space(p, 'RV 12')
    // The invoice's own total never carried its late fees.
    const { invoiceId } = await bill(p, t, s, daysAgo(10), [['rent', 440]])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',15,'pending',$6,'LATEFEE')`,
      [invoiceId, s.unitId, s.leaseId, t, p.landlordId, daysAgo(4)])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.balance).toBe('455.00')
    expect(row.open_invoices).toBe(1)
    expect(row.open_charges).toBe(2)
    // The digest counts it with its bill (due ten days ago), not on its own day.
    const [late] = await listOpenTenantBalances({ landlordIds: [p.landlordId], overdueDays: 5 })
    expect(late.balance).toBe('455.00')
  })

  it('money in flight, a bounced original and the FlexPay pull are never owed; the reopened row is', async () => {
    const p = await park()
    const t = await resident('Frank Flight')
    const s = await space(p, 'RV 14')
    const { rows } = await bill(p, t, s, daysAgo(10), [['rent', 400], ['utility', 50]])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_flight' WHERE id = $1`, [rows[0]])
    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_started' WHERE id = $1`, [rows[1]])
    // Last month's $300 bounced: the original is 'returned', a fresh row carries it.
    const { rows: [sept] } = await bill(p, t, s, daysAgo(40), [['rent', 300]])
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [sept])
    const rv = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'ach_return',300,'evt_ob_1','{}') RETURNING id`, [sept, p.landlordId, t, s.leaseId])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, reversal_id)
       VALUES ($1,$2,$3,$4,'rent',300,'pending',$5,'RENT',$6)`, [s.unitId, s.leaseId, t, p.landlordId, daysAgo(40), rv.rows[0].id])
    // GAM's FlexPay pull is never part of a tenant balance.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'fee',25,'pending',$5,'FLEXPAY','gam')`, [s.unitId, s.leaseId, t, p.landlordId, daysAgo(1)])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.balance).toBe('300.00')
  })

  it('a \'returned\' original is never owed by itself: owed means payable, and the bounce is owed on the row its reversal reopens', async () => {
    // The money plan's two-row model (§1.1, §3): paymentReversal marks the
    // original 'returned' AND writes the reopened row that carries the debt.
    // A 'returned' row alone is not something the portal, autopay or the desk
    // can take, so it is not chased here either; the path that wrote it without
    // a reopened row is what has to change.
    const p = await park()
    const t = await resident('Bare Return')
    const s = await space(p, 'RV 44')
    const { rows: [rent] } = await bill(p, t, s, daysAgo(20), [['rent', 500]])
    await db.query(`UPDATE payments SET status = 'returned', return_code = 'R01', settled_at = NOW() - INTERVAL '15 days' WHERE id = $1`, [rent])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })).toEqual([])
    const owed = await db.query(`SELECT 1 FROM payments p WHERE p.id = $1 AND ${openBalanceSql('p')}`, [rent])
    expect(owed.rows).toHaveLength(0)
  })

  it('a row credit has already part-paid owes only the rest', async () => {
    const p = await park()
    const t = await resident('Part Paid')
    const s = await space(p, 'RV 15')
    const { rows } = await bill(p, t, s, daysAgo(3), [['rent', 460]])
    const c = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,60,60,'goodwill','test','active',$4) RETURNING id`, [p.landlordId, t, s.leaseId, p.userId])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,60,date_trunc('month', CURRENT_DATE)::date,'desk','applied',NOW())`, [c.rows[0].id, rows[0], s.leaseId])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.balance).toBe('400.00')
    const one = await db.query<{ open: boolean; amt: string }>(
      `SELECT ${openBalanceSql('p')} AS open, ${openAmountSql('p')}::text AS amt FROM payments p WHERE p.id = $1`, [rows[0]])
    expect(one.rows[0]).toEqual({ open: true, amt: '400.00' })
  })
})

describe('S655 creditBeside', () => {
  it('reads each company the person has credit with, once', async () => {
    const p = await park()
    const other = await park()
    const t = await resident('Cora Credit')
    const s = await space(p, 'RV 1')
    const s2 = await space(other, 'RV 2')
    await bill(p, t, s, daysAgo(3), [['rent', 100]])
    await bill(other, t, s2, daysAgo(3), [['rent', 100]])
    await generalCredit(p, t, 40)
    await generalCredit(other, t, 30)
    const both = await creditBeside({ tenantId: t, landlordIds: [p.landlordId, other.landlordId] })
    expect(both.usable).toBe(70)
    expect(both.onFile).toBe(70)
    expect(both.fromLandlord).toBe(70)
    const one = await creditBeside({ tenantId: t, landlordIds: [p.landlordId] })
    expect(one.usable).toBe(40)
  })
})


// decisions #29 (Nic, 10/3): "a household stays on it, with every unpaid month
// shown ('$X from August'), until it is paid ... A bank payment still clearing
// shows 'Payment clearing' on the row, not owed and not late; if it bounces the
// amount is owed again. Work trade: charges covered by work trade are never
// owed and never shown as an amount — the household shows 'Work trade' for
// them and is never late; anything they owe beyond the coverage shows normally."
describe('decisions #29 the Outstanding row', () => {
  it('every unpaid month is on the row, oldest first, and they add up to the balance', async () => {
    const p = await park()
    const t = await resident('Aug Sept')
    const s = await space(p, 'RV 20')
    await bill(p, t, s, '2026-08-01', [['rent', 440], ['utility', 20.5]])
    await bill(p, t, s, '2026-09-01', [['rent', 440]])
    await bill(p, t, s, '2026-10-01', [['rent', 440], ['late_fee', 15]])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.months).toEqual([
      { month: '2026-08', amount: 460.5 },
      { month: '2026-09', amount: 440 },
      { month: '2026-10', amount: 455 },
    ])
    expect(row.balance).toBe('1355.50')
    expect(row.spaces[0].months).toEqual(row.months)
    expect(row.status).toBe('owes')
    expect(row.status_label).toBe(OUTSTANDING_ROW_STATUS_LABEL.owes)
  })

  it('a household stays on the list with an old month until that month is paid', async () => {
    const p = await park()
    const t = await resident('Old Month')
    const s = await space(p, 'RV 21')
    const aug = await bill(p, t, s, daysAgo(60), [['rent', 300]])
    await bill(p, t, s, daysAgo(30), [['rent', 300]])
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE invoice_id <> $1`, [aug.invoiceId])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(row.months).toEqual([{ month: daysAgo(60).slice(0, 7), amount: 300 }])
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE invoice_id = $1`, [aug.invoiceId])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId] })).toHaveLength(0)
  })

  it('days late honors the grace period: inside it 0, past it counted from the due date', async () => {
    const p = await park()
    const inside = await resident('Inside Grace')
    const past = await resident('Past Grace')
    const a = await space(p, 'RV 22')
    const b = await space(p, 'RV 23')
    await bill(p, inside, a, daysAgo(5), [['rent', 300]])      // the last grace day (5) is today
    await bill(p, past, b, daysAgo(9), [['rent', 300]])
    const rows = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(rows.find(r => r.tenant_id === inside)!.days_late).toBe(0)
    expect(rows.find(r => r.tenant_id === past)!.days_late).toBe(9)
    // The lease's own grace wins over the property's.
    await db.query(`UPDATE leases SET late_fee_grace_days = 10 WHERE id = $1`, [b.leaseId])
    const again = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(again.find(r => r.tenant_id === past)!.days_late).toBe(0)
  })

  it('a bank payment still clearing shows "Payment clearing" — not owed, not late — and is owed again if it bounces', async () => {
    const p = await park()
    const t = await resident('Clara Clearing')
    const s = await space(p, 'RV 24')
    const { rows } = await bill(p, t, s, daysAgo(20), [['rent', 500]])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_clear_1' WHERE id = $1`, [rows[0]])
    // Who OWES (the digest, the agents): nobody.
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId] })).toHaveLength(0)
    // The Outstanding list: on the row as clearing, $0 owed, not late.
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    expect(row.status).toBe('clearing')
    expect(row.status_label).toBe('Payment clearing')
    expect(row.balance).toBe('0.00')
    expect(row.clearing).toBe(500)
    expect(row.days_late).toBe(0)
    expect(row.months).toEqual([])
    expect(row.record_with).toEqual([])
    // It bounced: owed again, and late again.
    await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [rows[0]])
    const [back] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    expect(back.status).toBe('owes')
    expect(back.balance).toBe('500.00')
    expect(back.clearing).toBe(0)
    expect(back.days_late).toBe(20)
  })

  it('a household that owes and has a payment clearing shows both, and only what is owed counts as late', async () => {
    const p = await park()
    const t = await resident('Both Ways')
    const s = await space(p, 'RV 25')
    const sept = await bill(p, t, s, daysAgo(40), [['rent', 400]])
    await bill(p, t, s, daysAgo(2), [['rent', 400]])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_clear_2' WHERE id = $1`, [sept.rows[0]])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    expect(row.status).toBe('owes')
    expect(row.balance).toBe('400.00')
    expect(row.clearing).toBe(400)
    expect(row.days_late).toBe(0)
    expect(row.oldest_due_date).toBe(daysAgo(2))
  })

  it('credit set aside on a clearing payment is not money clearing', async () => {
    const p = await park()
    const t = await resident('Held Credit')
    const s = await space(p, 'RV 26')
    const { rows } = await bill(p, t, s, daysAgo(3), [['rent', 460]])
    const c = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status, created_by)
       VALUES ($1,$2,$3,60,60,'goodwill','test','active',$4) RETURNING id`, [p.landlordId, t, s.leaseId, p.userId])
    const r = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method)
       VALUES ($1,$2,$3,400,400,'processing','ach') RETURNING id`, [t, s.leaseId, p.landlordId])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,60,date_trunc('month', CURRENT_DATE)::date,'portal','held')`, [c.rows[0].id, rows[0], r.rows[0].id, s.leaseId])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_clear_3' WHERE id = $1`, [rows[0]])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    expect(row.clearing).toBe(400)
  })

  it('work trade is a mark, never an amount, never late; what is owed beyond it shows normally', async () => {
    const p = await park()
    const t = await resident('Walt Worktrade')
    const s = await space(p, 'RV 27')
    const { rows } = await bill(p, t, s, daysAgo(20), [['rent', 589], ['utility', 42]])
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [rows[0]])
    const [owner] = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeWorkTrade: true })
    expect(owner.work_trade).toBe(true)
    expect(owner.balance).toBe('42.00')                     // the utility the trade does not cover
    expect(owner.months).toEqual([{ month: daysAgo(20).slice(0, 7), amount: 42 }])
    expect(owner.days_late).toBe(20)                       // late on the utility, not the rent
    // The covered rent is never an amount. Ids and the email are random and may
    // carry the digits 589 by chance, so they are left out of the scan.
    const figures = JSON.stringify(owner, (k, v) => (/(^id$|_id$|_ids$|email)/.test(k) ? undefined : v))
    expect(figures).not.toMatch(/(^|[^0-9])589(\.0+)?([^0-9]|$)/)
    // A viewer who may not see work trade gets no mark (S641).
    const [desk] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(desk.work_trade).toBe(false)
    expect(desk.balance).toBe('42.00')
    // Covered in full: nothing owed, not on the list, never late.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [rows[1]])
    expect(await listOpenTenantBalances({ landlordIds: [p.landlordId], includeWorkTrade: true, includeClearing: true })).toHaveLength(0)
  })

  it('Record payment opens on the oldest charge the desk may take, one per company', async () => {
    const p = await park()
    const t = await resident('Rex Record')
    const s = await space(p, 'RV 28')
    const late = await bill(p, t, s, daysAgo(40), [['utility', 30], ['rent', 400]])
    await bill(p, t, s, daysAgo(10), [['rent', 400]])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    // Same due date: rent sorts before utility (the one allocation order).
    expect(row.record_with).toEqual([{ landlord_id: p.landlordId, payment_id: late.rows[1] }])
  })

  it('a FlexDeposit installment is never listed as one the landlord may take: Record payment does not open on it', async () => {
    // GAM's custody collection, paid online to GAM (moneyPredicates.bankPayableRowSql).
    const p = await park()
    const t = await resident('Fay Flex')
    const s = await space(p, 'RV 29')
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status, flex_deposit_enabled)
       VALUES ($1,$2,$3,600,0,'gam_escrow','pending',TRUE)`, [s.unitId, s.leaseId, t])
    await bill(p, t, s, daysAgo(10), [['deposit', 150]])
    const [only] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(only.balance).toBe('150.00')          // owed — to GAM, online
    expect(only.record_with).toEqual([])
    // With rent beside it, Record payment opens on the rent, never on the installment.
    const rent = await bill(p, t, s, daysAgo(5), [['rent', 400]])
    const [both] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(both.record_with).toEqual([{ landlord_id: p.landlordId, payment_id: rent.rows[0] }])
  })

  it('no Record payment where the desk cannot take it: only GAM charges, or a space paused for an eviction', async () => {
    const p = await park()
    const t = await resident('Gam Only')
    const s = await space(p, 'RV 29')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,'fee',4,'pending',$5,'RETURNFEE','gam')`, [s.unitId, s.leaseId, t, p.landlordId, daysAgo(3)])
    const [gamOnly] = await listOpenTenantBalances({ landlordIds: [p.landlordId] })
    expect(gamOnly.balance).toBe('4.00')
    expect(gamOnly.record_with).toEqual([])

    const t2 = await resident('Evic Paused')
    const s2 = await space(p, 'RV 30')
    await bill(p, t2, s2, daysAgo(3), [['rent', 300]])
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [s2.unitId])
    const paused = (await listOpenTenantBalances({ landlordIds: [p.landlordId] })).find(r => r.tenant_id === t2)!
    expect(paused.balance).toBe('300.00')
    expect(paused.record_with).toEqual([])
  })

  it('a property-locked worker gets Record payment only on a charge at their property', async () => {
    const p = await park()
    const t = await resident('Two Places')
    const a = await space(p, 'RV 31')
    const otherProp = await inTx(c => seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }))
    const b = await space({ ...p, propertyId: otherProp }, 'RV 32')
    await bill(p, t, b, daysAgo(30), [['rent', 300]])     // older, at the other park
    const here = await bill(p, t, a, daysAgo(10), [['rent', 300]])
    const [row] = await listOpenTenantBalances({ landlordIds: [p.landlordId], propertyIds: [p.propertyId] })
    expect(row.record_with).toEqual([{ landlord_id: p.landlordId, payment_id: here.rows[0] }])
    expect(row.months).toEqual([{ month: daysAgo(10).slice(0, 7), amount: 300 }])
  })
})

describe('decisions #25 the grand total', () => {
  it('only account owners and property managers see a grand total', () => {
    expect(seesGrandTotals({ role: 'landlord' })).toBe(true)
    expect(seesGrandTotals({ role: 'property_manager' })).toBe(true)
    expect(seesGrandTotals({ role: 'super_admin' })).toBe(true)
    expect(seesGrandTotals({ role: 'onsite_manager' })).toBe(false)
    expect(seesGrandTotals({ role: 'maintenance' })).toBe(false)
    expect(seesGrandTotals({ role: 'bookkeeper' })).toBe(false)
    expect(seesGrandTotals({ role: 'tenant' })).toBe(false)
    expect(seesGrandTotals(undefined)).toBe(false)
  })

  it('outstandingTotals sums every row once, per property too', async () => {
    const p = await park()
    const t = await resident('Tot One')
    const t2 = await resident('Tot Two')
    const a = await space(p, 'RV 33')
    const otherProp = await inTx(c => seedProperty(c, { landlordId: p.landlordId, ownerUserId: p.userId, managedByUserId: p.userId }))
    const b = await space({ ...p, propertyId: otherProp }, 'RV 34')
    await bill(p, t, a, daysAgo(10), [['rent', 300]])
    await bill(p, t, b, daysAgo(10), [['rent', 200.5]])
    const a2 = await space(p, 'RV 35')
    const { rows } = await bill(p, t2, a2, daysAgo(10), [['rent', 100]])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_tot' WHERE id = $1`, [rows[0]])
    const list = await listOpenTenantBalances({ landlordIds: [p.landlordId], includeClearing: true })
    // An open pay link (no person), and a register ticket that names a resident
    // already on the list: money owed, but not another household.
    const totals = outstandingTotals([...list,
      { tenant_id: null, balance: '25.00', property_id: p.propertyId, property_name: 'x' },
      { tenant_id: t, balance: '10.00', property_id: p.propertyId, property_name: 'x' }])
    expect(totals.owed).toBe(535.5)
    expect(totals.households).toBe(1)
    expect(totals.clearing).toBe(100)
    const here = totals.by_property.find(x => x.property_id === p.propertyId)!
    const there = totals.by_property.find(x => x.property_id === otherProp)!
    expect(here.owed).toBe(335)
    expect(here.clearing).toBe(100)
    expect(there.owed).toBe(200.5)
  })
})

describe('daysLate', () => {
  it('is 0 through the last grace day, then counts from the due date', () => {
    expect(daysLate('2026-10-01', '2026-10-01', 5)).toBe(0)
    expect(daysLate('2026-10-01', '2026-10-06', 5)).toBe(0)
    expect(daysLate('2026-10-01', '2026-10-07', 5)).toBe(6)
    expect(daysLate('2026-10-01', '2026-11-01', 0)).toBe(31)
    expect(daysLate('2026-10-01', '2026-09-28', 5)).toBe(0)
  })
})
