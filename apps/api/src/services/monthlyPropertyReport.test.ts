/**
 * 10/12 (Nic) — THE MONTHLY PROPERTY REPORT: the numbers, against fixtures.
 *
 *   All four groups — tenants & leases (started, ended, renewed, move-ins and
 *   move-outs, occupancy), payments (households per stamp, who is late and by
 *   how many days past grace), money (Charged / Received / Owed by category,
 *   expenses by category, net, work trade, deposits received and returned),
 *   operations (utility billed back vs the utility's own bill, maintenance,
 *   stays and nights) — for each property, and the properties added up.
 *
 * Every dollar counted once: a property's money is its own facts, the totals
 * are the same facts added up, and the expenses are the P&L's
 * (landlordPLExpenses) for the same properties. Also: who it goes to (the
 * owner by default; the owner's list; a team member's own property scope).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  buildMonthlyPropertyReport, monthBounds, previousMonth, expenseReportLines, isLateMonth,
  companyTeam, recipientsOf, saveRecipients, REPORT_STAMPS_COMPLETE, UNWOUND_LEASE_REASONS,
} from './monthlyPropertyReport'
import { landlordPLExpenses } from './landlordPL'
import { NEVER_MOVED_IN_REASON } from '../lib/unwindIssuedLease'

const TZ = 'America/Phoenix'
const AS_OF = '2026-10-12'
const MONTH = '2026-09'

beforeEach(cleanupAllSchema)

interface Park {
  landlordId: string; ownerUserId: string
  propA: string; propB: string
  unitA1: string; unitA2: string; unitA3: string; unitB1: string; unitB2: string
  leaseA1: string; leaseA2: string; leaseA0: string; leaseB1: string; leaseB2old: string; leaseB2new: string
  ann: string; bob: string; cal: string; dee: string; eve: string
}

async function named(c: any, first: string, last: string): Promise<string> {
  const t = await seedTenant(c)
  await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [t, first, last])
  return t
}

/** Two parks, September 2026. */
async function park(): Promise<Park> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c, { firstName: 'Olive', lastName: 'Owner' })
    await c.query(`UPDATE landlords SET business_name = 'Owner Parks LLC' WHERE id = $1`, [ll.landlordId])
    const prop = async (name: string) => {
      const id = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await c.query(`UPDATE properties SET name = $2, timezone = $3, late_fee_grace_days = 5 WHERE id = $1`, [id, name, TZ])
      return id
    }
    const propA = await prop('Alpha Park')
    const propB = await prop('Bravo Park')
    const unit = async (propertyId: string, number: string, status = 'active') => {
      const id = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      // On GAM since 2025: a month-end snapshot counts the spaces that stood on its day.
      await c.query(`UPDATE units SET unit_number = $2, status = $3, created_at = '2025-01-01T12:00:00Z' WHERE id = $1`, [id, number, status])
      return id
    }
    const unitA1 = await unit(propA, 'A1'), unitA2 = await unit(propA, 'A2'), unitA3 = await unit(propA, 'A3', 'vacant')
    const unitB1 = await unit(propB, 'B1'), unitB2 = await unit(propB, 'B2')
    const lease = async (unitId: string, start: string, status: 'active' | 'expired' = 'active', end: string | null = null) => {
      const id = await seedLease(c, { unitId, landlordId: ll.landlordId, startDate: start, status, leaseType: 'month_to_month' })
      if (end) await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [id, end])
      return id
    }
    const ann = await named(c, 'Ann', 'Able'), bob = await named(c, 'Bob', 'Baker'), cal = await named(c, 'Cal', 'Cole')
    const dee = await named(c, 'Dee', 'Dunn'), eve = await named(c, 'Eve', 'Ellis')
    const leaseA1 = await lease(unitA1, '2025-01-01')
    const leaseA2 = await lease(unitA2, '2026-09-01')                              // a move-in
    const leaseA0 = await lease(unitA3, '2025-03-01', 'expired', '2026-09-15')     // a move-out
    const leaseB1 = await lease(unitB1, '2025-01-01')
    const leaseB2old = await lease(unitB2, '2025-09-01', 'expired', '2026-08-31')
    const leaseB2new = await lease(unitB2, '2026-09-01')                           // a renewal
    await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [leaseB2new, leaseB2old])
    for (const [l, t] of [[leaseA1, ann], [leaseA2, bob], [leaseA0, dee], [leaseB1, cal], [leaseB2old, eve], [leaseB2new, eve]]) {
      await seedLeaseTenant(c, { leaseId: l, tenantId: t, role: 'primary' })
    }
    await c.query('COMMIT')
    return {
      landlordId: ll.landlordId, ownerUserId: ll.userId, propA, propB, unitA1, unitA2, unitA3, unitB1, unitB2,
      leaseA1, leaseA2, leaseA0, leaseB1, leaseB2old, leaseB2new, ann, bob, cal, dee, eve,
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** A bill line, written on Aug 25 (before it was due — the late clock runs from the due date). */
async function charge(p: Park, o: {
  unitId: string; leaseId: string; tenantId: string; type: 'rent' | 'late_fee' | 'deposit'; amount: number
  due: string; paidAt?: string; entry?: string
}): Promise<string> {
  const settled = !!o.paidAt
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           created_at, settled_at, manual_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,('2026-08-25 09:00'::timestamp AT TIME ZONE $10),
             CASE WHEN $11::text IS NULL THEN NULL ELSE ($11::timestamp AT TIME ZONE $10) END, $12)
     RETURNING id`,
    [o.unitId, o.leaseId, o.tenantId, p.landlordId, o.type, o.amount, settled ? 'settled' : 'pending', o.due,
     o.entry ?? (o.type === 'rent' ? 'RENT' : o.type === 'late_fee' ? 'LATEFEE' : 'DEPOSIT'), TZ,
     o.paidAt ?? null, settled ? 'cash' : null])).rows[0].id
}

async function september(p: Park): Promise<void> {
  // Alpha: Ann pays on time; Bob (moved in Sep 1) pays on Sep 12 — 7 days past
  // a 5-day grace — and owes a $25 late fee; his $500 deposit arrives Sep 1.
  await charge(p, { unitId: p.unitA1, leaseId: p.leaseA1, tenantId: p.ann, type: 'rent', amount: 500, due: '2026-09-01', paidAt: '2026-09-03 10:00' })
  await charge(p, { unitId: p.unitA2, leaseId: p.leaseA2, tenantId: p.bob, type: 'rent', amount: 600, due: '2026-09-01', paidAt: '2026-09-12 10:00' })
  await charge(p, { unitId: p.unitA2, leaseId: p.leaseA2, tenantId: p.bob, type: 'late_fee', amount: 25, due: '2026-09-07' })
  await charge(p, { unitId: p.unitA2, leaseId: p.leaseA2, tenantId: p.bob, type: 'deposit', amount: 500, due: '2026-09-01', paidAt: '2026-09-01 09:00' })
  // Bravo: Cal has paid nothing.
  await charge(p, { unitId: p.unitB1, leaseId: p.leaseB1, tenantId: p.cal, type: 'rent', amount: 700, due: '2026-09-01' })

  // Expenses: Alpha's water bill logged as an expense, Bravo's insurance, and a company-wide one (no property).
  await db.query(
    `INSERT INTO landlord_expenses (landlord_id, property_id, category, amount, expense_date, description) VALUES
       ($1,$2,'utilities',80,'2026-09-20','Water'), ($1,$3,'insurance',120,'2026-09-10','Policy'),
       ($1,NULL,'professional',50,'2026-09-05','CPA')`, [p.landlordId, p.propA, p.propB])
  // Maintenance at Alpha: one opened Sep 2 and closed Sep 10 for $75; one opened Sep 25, still open.
  await db.query(
    `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, category, priority, status, actual_cost, created_at, completed_at) VALUES
       ($1,$2,'Leak','Leak','plumbing','normal','completed',75,('2026-09-02 09:00'::timestamp AT TIME ZONE $3),('2026-09-10 15:00'::timestamp AT TIME ZONE $3)),
       ($1,$2,'Fan','Fan','hvac','normal','open',NULL,('2026-09-25 09:00'::timestamp AT TIME ZONE $3),NULL)`,
    [p.unitA1, p.landlordId, TZ])
  // Utilities at Alpha, the September cycle: a RUBS water master whose bill was $200, billed back $90 + $95.
  const meter = (await db.query<{ id: string }>(
    `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, rubs_allocation_method, digits)
     VALUES ($1,'water','Master','rubs','occupant_count',6) RETURNING id`, [p.propA])).rows[0].id
  const reader = p.ownerUserId
  await db.query(
    `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason, bill_amount)
     VALUES ($1,'2026-09-30',1000,'2026-09-01',$2,'monthly_cycle',200)`, [meter, reader])
  for (const [unitId, leaseId, tenantId, amt] of [[p.unitA1, p.leaseA1, p.ann, 90], [p.unitA2, p.leaseA2, p.bob, 95]] as const) {
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount, status, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',$6,'billed','water')`, [meter, unitId, tenantId, leaseId, p.landlordId, amt])
  }
  // A nightly stay on Alpha's empty space: Sep 28 → Oct 3 (3 nights in September), booked Sep 20.
  await db.query(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, lease_type, status, created_at)
     VALUES ($1,$2,'Guest','2026-09-28','2026-10-03','nightly','confirmed',('2026-09-20 12:00'::timestamp AT TIME ZONE $3))`,
    [p.unitA3, p.landlordId, TZ])
  // Dee moved out of A3: her deposit return finalized Sep 16, $300 back to her.
  await db.query(
    `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status, finalized_at)
     VALUES ($1,$2,$3,400,100,300,'sent_refund',('2026-09-16 10:00'::timestamp AT TIME ZONE $4))`,
    [p.leaseA0, p.dee, p.landlordId, TZ])
}

const build = (p: Park, propertyIds: string[] | null = null) =>
  buildMonthlyPropertyReport({ landlordId: p.landlordId, month: MONTH, propertyIds, asOf: AS_OF })

describe('the month and its days', () => {
  it('a month is its first and last day; the default month is the one before', () => {
    expect(monthBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(monthBounds('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(previousMonth('2026-10-02')).toBe('2026-09')
    expect(previousMonth('2027-01-02')).toBe('2026-12')
    expect(() => monthBounds('2026-13')).toThrow()
    expect(REPORT_STAMPS_COMPLETE).toBe(true)
  })
})

describe('the monthly property report: all four groups, against the fixtures', () => {
  it('tenants & leases: started, renewed, ended, move-ins, move-outs, and occupancy (today when no month-end count)', async () => {
    const p = await park()
    await september(p)
    const r = await build(p)
    expect(r.company.name).toBe('Owner Parks LLC')
    expect(r.monthLabel).toBe('September 2026')
    expect(r.properties.map(x => x.property.name)).toEqual(['Alpha Park', 'Bravo Park'])
    const [a, b] = r.properties
    expect(a.tenants).toMatchObject({ leasesStarted: 1, leasesRenewed: 0, existingOnboarded: 0, moveIns: 1, leasesEnded: 1, moveOuts: 1 })
    expect(b.tenants).toMatchObject({ leasesStarted: 1, leasesRenewed: 1, moveIns: 0, leasesEnded: 0, moveOuts: 0 })
    // No snapshot for September: the spaces counted today. 10/12 (Nic, A5
    // "match billing"): occupied is what GAM bills for September — Dee's lease
    // held A3 until the 15th, so A3 is billed (and occupied) for September.
    expect(a.tenants).toMatchObject({ spaces: 3, occupied: 3, vacant: 0, occupancyPercent: 100, occupancyFrom: 'today' })
    expect(r.totals.tenants).toMatchObject({ leasesStarted: 2, leasesRenewed: 1, moveIns: 1, moveOuts: 1, spaces: 5, occupied: 5, vacant: 0 })
  })

  it('occupancy at month end: the spaces of the property\'s growth snapshot day, occupied as GAM bills the month', async () => {
    const p = await park()
    await db.query(
      `INSERT INTO property_growth_snapshots (snapshot_date, property_id, landlord_id, units, occupied_units, vacant_units)
       VALUES ('2026-09-30',$1,$2,3,1,2), ('2026-09-15',$1,$2,3,3,0)`, [p.propA, p.landlordId])
    const [a] = (await build(p, [p.propA])).properties
    // The day is the month-end snapshot's; its own occupied/vacant figures are
    // not the bill's, so they are not read (10/12, Nic, A5: "match billing").
    expect(a.tenants).toMatchObject({ spaces: 3, occupied: 3, vacant: 0, occupancyPercent: 100, occupancyFrom: 'month_end_snapshot', occupancyAsOf: '2026-09-30' })
  })

  // 10/12 (Nic, A5): "MATCH BILLING (occupied = billable evidence; vacant =
  // rest; retired excluded)" — the report's Vacant is the spaces GAM does not
  // bill for the month, so occupied + vacant = spaces.
  it('occupied is what GAM bills for the month and vacant is the rest — never a unit status', async () => {
    const p = await park()
    const c = await db.connect()
    const extra: Record<string, string> = {}
    try {
      for (const [n, status] of [['A4', 'active'], ['A5', 'owner_use'], ['A6', 'vacant'], ['A7', 'vacant'],
                                  ['A8', 'owner_use'], ['A9', 'vacant']] as const) {
        const id = await seedUnit(c, { propertyId: p.propA, landlordId: p.landlordId })
        await c.query(`UPDATE units SET unit_number = $2, status = $3, created_at = '2025-01-01T12:00:00Z' WHERE id = $1`, [id, n, status])
        // The setup is the unit as it stood since 2025 (the change journal dates it then).
        await c.query(`UPDATE audit_row_changes SET changed_at = '2025-01-01T12:00:00Z' WHERE table_name = 'units' AND row_id = $1`, [id])
        extra[n] = id
      }
      // 10/12 (Nic) review: owner use is read for the month from the change
      // journal, never today's status backdated. A8 was the owner's from the
      // start of September and went back to vacant on September 30th (held in
      // September, so billed for it); A9 became the owner's only in October.
      for (const [n, status, at] of [['A8', 'vacant', '2026-09-30T20:00:00Z'], ['A9', 'owner_use', '2026-10-02T18:00:00Z']] as const) {
        await c.query(`UPDATE units SET status = $2 WHERE id = $1`, [extra[n], status])
        await c.query(
          `UPDATE audit_row_changes SET changed_at = $2
            WHERE id = (SELECT MAX(id) FROM audit_row_changes WHERE table_name = 'units' AND row_id = $1)`, [extra[n], at])
      }
      // A6: a month stay with no lease (a space, billed up front like a lease).
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, lease_type, status, created_at)
         VALUES ($1,$2,'Mona Month','2026-09-01','2026-10-01','month_to_month','confirmed','2026-08-20T12:00:00Z')`,
        [extra.A6, p.landlordId])
      // A7: only a nightly stay — billed by its nights after the month, never as a space.
      await c.query(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, lease_type, status, created_at)
         VALUES ($1,$2,'Ned Nightly','2026-09-10','2026-09-14','nightly','confirmed','2026-09-01T12:00:00Z')`,
        [extra.A7, p.landlordId])
    } finally { c.release() }
    const [a] = (await build(p, [p.propA])).properties
    // A1, A2 (leases), A3 (Dee's lease held it to the 15th), A5 (owner use),
    // A6 (month stay) and A8 (the owner's in September) are billed; A4 (marked
    // active, nobody in it), A7 (nightly only) and A9 (the owner's only from
    // October) are vacant.
    expect(a.tenants).toMatchObject({ spaces: 9, occupied: 6, vacant: 3, occupancyPercent: 67 })
    expect(a.tenants.occupied + a.tenants.vacant).toBe(a.tenants.spaces)
    // October, still running: Dee's lease ended in September and the month
    // stay left on October 1st, so only A1, A2 and the owner's A5 and A9 are billed.
    const oct = (await buildMonthlyPropertyReport({ landlordId: p.landlordId, month: '2026-10', propertyIds: [p.propA], asOf: AS_OF })).properties[0]
    expect(oct.tenants).toMatchObject({ spaces: 9, occupied: 4, vacant: 5, occupancyFrom: 'today' })
  })

  it('payments: households per stamp for the month\'s bills, and who is late by how many days past grace', async () => {
    const p = await park()
    await september(p)
    const r = await build(p)
    const [a, b] = r.properties
    const count = (x: typeof a, stamp: string) => x.payments.counts.find(c => c.stamp === stamp)!.households
    expect(count(a, 'paid_on_time')).toBe(1)   // Ann
    expect(count(a, 'paid_late')).toBe(1)      // Bob — the $25 late fee never decides the stamp
    expect(count(b, 'outstanding')).toBe(1)    // Cal
    // Sep 1 + 5 grace days: the 6th is the first late day. Paid Sep 12 = 7 days past grace;
    // Cal, still owing on Oct 12 = 37.
    expect(a.payments.late).toEqual([expect.objectContaining({ name: 'Bob Baker', stamp: 'paid_late', daysPastGrace: 7, owed: 25, units: ['A2'] })])
    expect(b.payments.late).toEqual([expect.objectContaining({ name: 'Cal Cole', stamp: 'outstanding', daysPastGrace: 37, owed: 700, units: ['B1'] })])
    expect(r.totals.payments).toMatchObject({ households: 3, late: 2 })
    expect(isLateMonth({ stamp: 'partial', days_past_grace: 0 } as any)).toBe(false)
    expect(isLateMonth({ stamp: 'partial', days_past_grace: 2 } as any)).toBe(true)
  })

  it('money: Charged / Received / Owed by category, each property its own facts, the totals the same facts added up', async () => {
    const p = await park()
    await september(p)
    const r = await build(p)
    const [a, b] = r.properties
    expect(a.money.view).toMatchObject({ charged: 1125, received: 1100, owed: 25 })
    expect(a.money.view.categories).toEqual([
      { category: 'space_rent', label: 'Lot/space rent', charged: 1100, received: 1100, owed: 0 },
      { category: 'late_fees', label: 'Late fees', charged: 25, received: 0, owed: 25 },
    ])
    expect(b.money.view).toMatchObject({ charged: 700, received: 0, owed: 700 })
    expect(r.totals.money.view).toMatchObject({ charged: 1825, received: 1100, owed: 725 })
    // How the columns tie, and the deposits (held, never income).
    expect(a.money.view.tie.charged).toEqual({ collected: 1100, clearing: 0, owed: 25, other: 0 })
    expect(a.money.view.tie.received).toEqual({ forPeriodBills: 1100, forEarlierBills: 0, paidAhead: 0, noBill: 0 })
    expect(a.money.view.tieText[1]).toBe('Of $1,125.00 charged, $1,100.00 is collected and $25.00 is still owed.')
    expect(a.money.depositsReceived).toBe(500)
    expect(a.money.depositsReturned).toBe(300)
    expect(b.money.depositsReturned).toBe(0)
  })

  it('expenses are the P&L\'s for each property, by category, the processing-fee line always there, and the net on each column', async () => {
    const p = await park()
    await september(p)
    const r = await build(p)
    const [a, b] = r.properties
    for (const x of [a, b]) {
      const pl = await landlordPLExpenses(p.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], [x.property.id])
      expect(x.money.expenses.total).toBe(pl.total)
      expect(Math.round(x.money.expenses.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100).toBe(pl.total)
      expect(x.money.expenses.lines.map(l => l.key)).toContain('processingFees')
      expect(x.money.net).toEqual({
        received: Math.round((x.money.view.received - pl.total) * 100) / 100,
        charged: Math.round((x.money.view.charged - pl.total) * 100) / 100,
      })
    }
    expect(a.money.expenses.lines.find(l => l.key === 'maintenance')?.amount).toBe(75)
    expect(a.money.expenses.lines.find(l => l.key === 'expense:utilities')).toMatchObject({ label: 'Utilities', amount: 80 })
    expect(b.money.expenses.lines.find(l => l.key === 'expense:insurance')).toMatchObject({ label: 'Insurance', amount: 120 })
    // The company-wide $50 (no property) is in no property's report, and the totals are the properties' own.
    const both = await landlordPLExpenses(p.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], [p.propA, p.propB])
    expect(r.totals.money.expenses.total).toBe(both.total)
    expect(r.totals.money.net.received).toBe(Math.round((1100 - both.total) * 100) / 100)
  })

  it('operations: utility billed back vs the utility\'s own bill, maintenance opened / closed / cost, stays and nights', async () => {
    const p = await park()
    await september(p)
    const [a, b] = (await build(p)).properties
    expect(a.operations.utilities).toEqual([{ utility: 'water', label: 'Water', billedBack: 185, utilityBill: 200 }])
    expect(a.operations.utilityExpensesLogged).toBe(80)
    expect(a.operations.maintenance).toEqual({ opened: 2, closed: 1, cost: 75 })
    expect(a.operations.stays).toEqual({ stays: 1, nights: 3, bookedThisMonth: 1 })
    expect(b.operations).toMatchObject({ utilities: [], maintenance: { opened: 0, closed: 0, cost: 0 }, stays: { stays: 0, nights: 0, bookedThisMonth: 0 } })
  })

  it('a reader\'s properties only: a report for one park carries nothing of the other', async () => {
    const p = await park()
    await september(p)
    const r = await build(p, [p.propB])
    expect(r.properties.map(x => x.property.name)).toEqual(['Bravo Park'])
    expect(r.totals.money.view).toMatchObject({ charged: 700, received: 0, owed: 700 })
    expect(r.totals.payments.late).toBe(1)
    expect((await build(p, [])).properties).toEqual([])
  })

  it('expense lines: platform fee and processing fees always, every entered category added up, nothing dropped', () => {
    const lines = expenseReportLines(
      { platformFee: 10, maintenance: 0, lotRent: 0, enteredExpenses: 130, processingFees: 0, cardFeesRefunded: 0, total: 140 },
      [{ category: 'insurance', amount: 100 }, { category: 'retired_category', amount: 30 }])
    expect(lines.map(l => [l.key, l.amount])).toEqual([
      ['platformFee', 10], ['processingFees', 0], ['expense:insurance', 100], ['expense:other_unlisted', 30],
    ])
  })
})

describe('10/12 review: what the report counts', () => {
  it('a lease unwound as paperwork is never a lease started, a move-in, a lease ended or a move-out', async () => {
    const p = await park()
    const c = await db.connect()
    try {
      const unitB3 = await seedUnit(c, { propertyId: p.propB, landlordId: p.landlordId })
      for (const reason of UNWOUND_LEASE_REASONS) {
        const l = await seedLease(c, { unitId: unitB3, landlordId: p.landlordId, startDate: '2026-09-10', status: 'active', leaseType: 'month_to_month' })
        await c.query(
          `UPDATE leases SET status = 'terminated', termination_reason = $2,
                  terminated_at = ('2026-09-12 10:00'::timestamp AT TIME ZONE $3) WHERE id = $1`, [l, reason, TZ])
      }
    } finally { c.release() }
    // The reasons are the ones the unwind writes.
    expect(UNWOUND_LEASE_REASONS).toContain(NEVER_MOVED_IN_REASON)
    const [, b] = (await build(p)).properties
    expect(b.tenants).toMatchObject({ leasesStarted: 1, leasesRenewed: 1, moveIns: 0, leasesEnded: 0, moveOuts: 0 })
  })

  it('occupancy counts spaces: never a retired unit or a utility service point, live or from a month-end snapshot', async () => {
    const p = await park()
    const c = await db.connect()
    try {
      const retired = await seedUnit(c, { propertyId: p.propA, landlordId: p.landlordId })
      await c.query(`UPDATE units SET status = 'vacant', created_at = '2025-01-01T12:00:00Z', retired_at = '2026-08-01T12:00:00Z' WHERE id = $1`, [retired])
      const service = await seedUnit(c, { propertyId: p.propA, landlordId: p.landlordId })
      await c.query(`UPDATE units SET status = 'utility_service', created_at = '2025-01-01T12:00:00Z' WHERE id = $1`, [service])
    } finally { c.release() }
    // Live (no snapshot in September): A1, A2 and A3 (billed for September —
    // Dee's lease held it to the 15th) are the only spaces.
    const [live] = (await build(p, [p.propA])).properties
    expect(live.tenants).toMatchObject({ spaces: 3, occupied: 3, vacant: 0, occupancyPercent: 100, occupancyFrom: 'today' })
    // A snapshot taken before the fix counted every unit row (5, the retired one vacant):
    // its spaces are re-counted from the units as they stood that day.
    await db.query(
      `INSERT INTO property_growth_snapshots (snapshot_date, property_id, landlord_id, units, occupied_units, vacant_units)
       VALUES ('2026-09-30',$1,$2,5,2,2)`, [p.propA, p.landlordId])
    const [snap] = (await build(p, [p.propA])).properties
    expect(snap.tenants).toMatchObject({ spaces: 3, occupied: 3, vacant: 0, occupancyPercent: 100, occupancyFrom: 'month_end_snapshot' })
  })

  it('billed back counts only bills that went out; stays count only stays that are held (never a tentative hold)', async () => {
    const p = await park()
    await september(p)
    const meter = (await db.query<{ id: string }>(`SELECT id FROM utility_meters WHERE property_id = $1`, [p.propA])).rows[0].id
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount, status, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',40,'unbilled','water')`, [meter, p.unitA3, p.dee, p.leaseA0, p.landlordId])
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, check_in, check_out, lease_type, status, created_at)
       VALUES ($1,$2,'Maybe','2026-09-10','2026-09-14','nightly','tentative',('2026-09-05 12:00'::timestamp AT TIME ZONE $3))`,
      [p.unitA3, p.landlordId, TZ])
    const [a] = (await build(p)).properties
    expect(a.operations.utilities).toEqual([{ utility: 'water', label: 'Water', billedBack: 185, utilityBill: 200 }])
    expect(a.operations.stays).toEqual({ stays: 1, nights: 3, bookedThisMonth: 1 })
  })

  it('the totals count a household billed at two properties once; the whole company\'s report names what no property holds', async () => {
    const p = await park()
    await september(p)
    // Ann (Alpha) is also billed a $40 fee on a Bravo space with no lease of its own — still her household.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at, settled_at, manual_method)
       VALUES ($1,$2,$3,'fee',40,'settled','2026-09-01','OTHERFEE',('2026-08-25 09:00'::timestamp AT TIME ZONE $4),
               ('2026-09-02 09:00'::timestamp AT TIME ZONE $4),'cash')`, [p.unitB2, p.ann, p.landlordId, TZ])
    const r = await build(p)
    const [a, b] = r.properties
    expect(a.payments.households).toBe(2)   // Ann, Bob
    expect(b.payments.households).toBe(2)   // Cal, and Ann's fee
    expect(r.totals.payments.households).toBe(3)
    // The company-wide $50 (no property): beside the totals, so totals + it = the P&L.
    const whole = await landlordPLExpenses(p.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(r.notInTotals).toMatchObject({ received: 0, charged: 0 })
    expect(Math.round((r.totals.money.expenses.total + r.notInTotals!.expenses) * 100) / 100).toBe(whole.total)
    expect(r.notInTotals!.expenses).toBeGreaterThanOrEqual(50)
    // A report on some properties is about them only.
    expect((await build(p, [p.propA, p.propB])).notInTotals).toBeNull()
  })

  it('the net leads with Received (10/12, Nic)', async () => {
    const p = await park()
    await september(p)
    const r = await build(p)
    expect(Object.keys(r.totals.money.net)).toEqual(['received', 'charged'])
    expect(Object.keys(r.properties[0].money.net)).toEqual(['received', 'charged'])
  })
})

describe('who gets it: the owner picks (default: the owner only)', () => {
  async function pmOn(p: Park, propertyIds: string[] | null, email = 'pm@example.org'): Promise<string> {
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`, [email])).rows[0].id
    await db.query(`INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids) VALUES ($1,$2,$3,$4)`,
      [u, p.landlordId, propertyIds === null, propertyIds ?? []])
    return u
  }

  it('a company that never saved a list sends to its owner only, who sees every property', async () => {
    const p = await park()
    const list = await recipientsOf(p.landlordId)
    expect(list.isDefault).toBe(true)
    expect(list.recipients).toEqual([expect.objectContaining({ kind: 'team_member', userId: p.ownerUserId, role: 'owner', propertyIds: null })])
  })

  it('the team lists the owner first, then each member with their own property scope', async () => {
    const p = await park()
    const pm = await pmOn(p, [p.propA])
    const team = await companyTeam(p.landlordId)
    expect(team.map(m => [m.role, m.roleLabel])).toEqual([['owner', 'Owner'], ['property_manager', 'Property Manager']])
    expect(team.find(m => m.userId === pm)?.propertyIds).toEqual([p.propA])
  })

  it('10/12 review, SECURITY (BK3): a whole-company bookkeeper\'s report names the company\'s properties one by one — no line for money outside them', async () => {
    const p = await park()
    const bk = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('bea-books@example.org','x','bookkeeper','Bea','Books',TRUE) RETURNING id`)).rows[0].id
    await db.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, property_ids, company_wide, access_level)
       VALUES ($1,$2,$3,TRUE,'read_only')`, [bk, p.landlordId, [p.propA, p.propB]])
    const member = (await companyTeam(p.landlordId)).find(m => m.userId === bk)!
    // Every property the company owns today, named — never "every property" (null),
    // which builds the money-outside-the-properties line (a sold property's history).
    expect(member.propertyIds).toEqual([p.propA, p.propB])
    expect((await build(p, member.propertyIds)).notInTotals).toBeNull()
  })

  it('the owner\'s list: a manager gets the properties they manage, another address gets every property; keep everything', async () => {
    const p = await park()
    const pm = await pmOn(p, [p.propA])
    let list = await saveRecipients(p.landlordId, p.ownerUserId, [p.ownerUserId, pm], ['CPA@Example.org', ' cpa@example.org '])
    expect(list.isDefault).toBe(false)
    expect(list.recipients.map(r => [r.kind, r.email, r.propertyIds])).toEqual([
      ['team_member', expect.stringMatching(/@test\.dev$/), null],
      ['team_member', 'pm@example.org', [p.propA]],
      ['email', 'cpa@example.org', null],
    ])
    // Dropping the manager stamps their row removed — never deleted.
    list = await saveRecipients(p.landlordId, p.ownerUserId, [p.ownerUserId], ['cpa@example.org'])
    expect(list.recipients.map(r => r.email)).not.toContain('pm@example.org')
    const rows = (await db.query(`SELECT kind, user_id, email, removed_at IS NOT NULL AS removed FROM monthly_report_recipients WHERE landlord_id = $1 ORDER BY created_at`, [p.landlordId])).rows
    expect(rows.filter((x: any) => x.user_id === pm)).toEqual([expect.objectContaining({ removed: true })])
    expect(rows.filter((x: any) => !x.removed)).toHaveLength(2)
  })

  it('an empty list is the owner\'s choice: nobody gets it (never the default again)', async () => {
    const p = await park()
    const list = await saveRecipients(p.landlordId, p.ownerUserId, [], [])
    expect(list).toMatchObject({ isDefault: false, recipients: [] })
  })

  it('refuses someone not on the team, and anything that is not an email address', async () => {
    const p = await park()
    const stranger = await pmOn(await park(), null, 'other@example.org')
    await expect(saveRecipients(p.landlordId, p.ownerUserId, [stranger], [])).rejects.toMatchObject({ statusCode: 400 })
    await expect(saveRecipients(p.landlordId, p.ownerUserId, [], ['not an address'])).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a member who left the team gets nothing, and is named so the owner can tidy up', async () => {
    const p = await park()
    const pm = await pmOn(p, [p.propA])
    await saveRecipients(p.landlordId, p.ownerUserId, [pm], [])
    await db.query(`DELETE FROM property_manager_scopes WHERE user_id = $1`, [pm])
    const list = await recipientsOf(p.landlordId)
    expect(list.recipients).toEqual([])
    expect(list.leftTeam).toEqual([{ userId: pm, name: 'Pat Manager' }])
  })
})
