/**
 * S652 — a park that bills each tenant on their own date.
 *
 * Nic: "they let their due date be whenever they come in. So they're doing some
 * meter reads at the end of the month for billing on the first. They're doing
 * some meter reads at the middle of the month. Maybe some around the 20th or
 * 23rd... do we have it set up where that property can operate according to
 * those people's due dates?"
 *
 * The pieces were built in S648. This is the dress rehearsal: one property,
 * tenants due on different days, walked through reads, invoices and the hold —
 * plus the three gaps the read-through found.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices as backfill } from './invoiceGeneration'
import { generateMoveInInvoice as genMoveIn, existingTenancyFirstDue } from './moveInBundle'
import { promptTenantDateMeterReads } from '../services/utilityReadingRuns'

beforeEach(async () => { await cleanupAllSchema() })

async function seedSite(opts: { startDate: string; rentDueDay: number; existing?: boolean; firstCycle?: string; propertyAdded?: string }) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 600, startDate: opts.startDate })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `UPDATE leases SET rent_due_day = $2, needs_review = false, is_existing_tenancy = $3 WHERE id = $1`,
      [leaseId, opts.rentDueDay, !!opts.existing])
    if (opts.firstCycle) await c.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = $1`, [propertyId, opts.firstCycle])
    // The day the property was added to GAM — the lease's start unless said.
    await c.query(`UPDATE properties SET onboarding_started_at = ($2::date || 'T12:00:00')::timestamptz WHERE id = $1`,
      [propertyId, opts.propertyAdded ?? opts.startDate])
    const { rows: [m] } = await c.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rate_per_unit, digits)
       VALUES ($1, 'electric', 'E', 'submeter', 0, 0.21, 5) RETURNING id`, [propertyId])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [m.id, unitId])
    await c.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'electric', true) ON CONFLICT DO NOTHING`, [leaseId])
    await c.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, meterId: m.id as string }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const openRun = (f: any, cycle: string, openedOn: string) => db.query(
  `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on)
   VALUES ($1, $2, $3, $4)`, [f.propertyId, f.landlordId, cycle, openedOn])
const read = (f: any, date: string, value: number, cycle: string, reason = 'monthly_cycle') => db.query(
  `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
   VALUES ($1, $2, $3, $4, $5, $6)`, [f.meterId, date, value, cycle, f.userId, reason])
const charges = async (leaseId: string) => (await db.query<{ d: string; type: string; a: number }>(
  `SELECT to_char(due_date, 'YYYY-MM-DD') AS d, type, amount::float AS a FROM payments
    WHERE lease_id = $1 ORDER BY due_date, type`, [leaseId])).rows

describe('a tenant billed on the 15th', () => {
  it('the invoice waits for the read taken the business day before, then carries rent and usage together', async () => {
    const f = await seedSite({ startDate: '2026-08-15', rentDueDay: 15 })
    await read(f, '2026-09-14', 1000, '2026-08-01')            // last month's closing read
    await openRun(f, '2026-09-01', '2026-09-30')               // September's round, opened at month end

    // Oct 15 arrives and nobody has read the meter: the whole invoice holds.
    await backfill({ from: '2026-10-15', to: '2026-10-15', leaseId: f.leaseId })
    expect(await charges(f.leaseId)).toEqual([])

    // The read lands (Oct 14, the business day before): rent and usage bill together.
    await read(f, '2026-10-14', 1400, '2026-09-01')
    await backfill({ from: '2026-10-15', to: '2026-10-15', leaseId: f.leaseId })
    expect(await charges(f.leaseId)).toEqual([
      { d: '2026-10-15', type: 'rent', a: 600 },
      { d: '2026-10-15', type: 'utility', a: 84 },              // 400 kWh × $0.21
    ])
  })
})

// Gap 3. February 2027 ends on a Sunday, so its last business day is Friday the
// 26th — the day February's reading round opens. A tenant due on the 27th needs
// JANUARY's round (read Feb 26) on that invoice; February's is for March 27.
// The hold counted any round of the invoice's own month, so February's round —
// open one day, unread by design until March 26 — held the February 27 invoice
// for a month.
describe('a tenant due late in the month', () => {
  it('is not held by the round that opened that same month', async () => {
    const f = await seedSite({ startDate: '2026-10-27', rentDueDay: 27 })
    await read(f, '2027-01-26', 1000, '2026-12-01')
    await openRun(f, '2027-01-01', '2027-01-29')
    await read(f, '2027-02-26', 1500, '2027-01-01')             // the read this invoice needs
    await openRun(f, '2027-02-01', '2027-02-26')                // February's round: open, not yet due for this tenant
    await backfill({ from: '2027-02-27', to: '2027-02-27', leaseId: f.leaseId })
    expect(await charges(f.leaseId)).toEqual([
      { d: '2027-02-27', type: 'rent', a: 600 },
      { d: '2027-02-27', type: 'utility', a: 105 },             // 500 kWh × $0.21
    ])
  })

  it('is still held when the round it DOES need has not been read', async () => {
    const f = await seedSite({ startDate: '2026-10-27', rentDueDay: 27 })
    await read(f, '2027-01-26', 1000, '2026-12-01')
    await openRun(f, '2027-01-01', '2027-01-29')                // January's round, unread
    await backfill({ from: '2027-02-27', to: '2027-02-27', leaseId: f.leaseId })
    expect(await charges(f.leaseId)).toEqual([])
  })

  it('a tenant on the 1st is unchanged: held by last month\'s unread round', async () => {
    const f = await seedSite({ startDate: '2026-08-01', rentDueDay: 1 })
    await read(f, '2026-08-31', 1000, '2026-08-01')
    await openRun(f, '2026-09-01', '2026-09-30')
    await backfill({ from: '2026-10-01', to: '2026-10-01', leaseId: f.leaseId })
    expect(await charges(f.leaseId)).toEqual([])
    await read(f, '2026-09-30', 1200, '2026-09-01')
    await backfill({ from: '2026-10-01', to: '2026-10-01', leaseId: f.leaseId })
    expect((await charges(f.leaseId)).map(c => c.type)).toEqual(['rent', 'utility'])
  })
})

// Gap 1. A resident who was already living there, and already due on the 15th.
describe('an onboarding resident with their own due day', () => {
  // Nic: "we're only going to bill going forward from the day the property was
  // added... if I onboard the 15th and choose October 1st as the first billing
  // cycle... somebody on the 20th would be billed before the 1st of the month."
  it('first bill is the first time their day comes round after the property was added', () => {
    // Nic's example: park added Sept 15, first cycle Oct 1, resident due the 20th → Sept 20
    expect(existingTenancyFirstDue('2026-09-15', '2026-10-01', 20, '2026-09-15')).toBe('2026-09-20')
    // signed later than the park was added: still the park's date that counts
    expect(existingTenancyFirstDue('2026-09-25', '2026-10-01', 20, '2026-09-15')).toBe('2026-09-20')
    // park added after their day this month → next month
    expect(existingTenancyFirstDue('2026-09-25', '2026-10-01', 20, '2026-09-22')).toBe('2026-10-20')
    expect(existingTenancyFirstDue('2026-10-12', '2026-10-01', 20, '2026-10-12')).toBe('2026-10-20')
    expect(existingTenancyFirstDue('2026-10-20', null, 20, '2026-10-20')).toBe('2026-10-20')    // added on the day
    // nothing known about the park's date → the signing date stands in
    expect(existingTenancyFirstDue('2026-10-25', null, 20)).toBe('2026-11-20')
    // the 1st is exactly what it always was: the first billing cycle
    expect(existingTenancyFirstDue('2026-09-15', '2026-10-01', 1, '2026-09-15')).toBe('2026-10-01')
    expect(existingTenancyFirstDue('2026-10-05', '2026-10-01', 1, '2026-09-15')).toBe('2026-10-01')
  })

  it("Nic's example end to end: added Sept 15, first cycle Oct 1, due the 20th → Sept 20, then monthly", async () => {
    const f = await seedSite({ startDate: '2026-09-15', rentDueDay: 20, existing: true, firstCycle: '2026-10-01', propertyAdded: '2026-09-15' })
    await backfill({ from: '2026-09-01', to: '2026-11-30', leaseId: f.leaseId })
    expect((await charges(f.leaseId)).filter(c => c.type === 'rent')).toEqual([
      { d: '2026-09-20', type: 'rent', a: 600 },
      { d: '2026-10-20', type: 'rent', a: 600 },
      { d: '2026-11-20', type: 'rent', a: 600 },
    ])
  })

  it('signed before their day: nothing at signing, the nightly run bills it on the day, then monthly', async () => {
    const f = await seedSite({ startDate: '2026-10-05', rentDueDay: 15, existing: true, firstCycle: '2026-10-01' })
    await backfill({ from: '2026-10-05', to: '2026-12-31', leaseId: f.leaseId })
    expect((await charges(f.leaseId)).filter(c => c.type === 'rent')).toEqual([
      { d: '2026-10-15', type: 'rent', a: 600 },
      { d: '2026-11-15', type: 'rent', a: 600 },
      { d: '2026-12-15', type: 'rent', a: 600 },
    ])
  })

  it('signed after their day: billed for the day that passed since the park was added, and never twice', async () => {
    // Park added the 10th two months ago; resident due the 15th signed on the
    // 20th → their first bill is that month's 15th (already past when they
    // signed, so signing makes it). Two months back so every date is in the
    // past whatever day this runs.
    const start = new Date(); start.setUTCDate(20); start.setUTCMonth(start.getUTCMonth() - 2)
    const startIso = start.toISOString().slice(0, 10)
    const firstIso = startIso.slice(0, 8) + '15'
    const f = await seedSite({ startDate: startIso, rentDueDay: 15, existing: true, firstCycle: startIso.slice(0, 8) + '01', propertyAdded: startIso.slice(0, 8) + '10' })
    const r = await genMoveIn({
      lease_id: f.leaseId, unit_id: f.unitId, tenant_id: f.tenantId,
      landlord_id: f.landlordId, rent_amount: 600, start_date: startIso,
    } as any)
    expect(r.invoiceCreated).toBe(true)
    const next = new Date(`${firstIso}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1)
    const nextIso = next.toISOString().slice(0, 10)
    await backfill({ from: startIso, to: nextIso, leaseId: f.leaseId })
    expect((await charges(f.leaseId)).filter(c => c.type === 'rent')).toEqual([
      { d: firstIso, type: 'rent', a: 600 },
      { d: nextIso, type: 'rent', a: 600 },
    ])
  })
})

// Gap 2. The month-end round announces itself once. A read that falls on the
// 14th or the 22nd was announced by nothing.
describe('the morning notice for reads on a tenant\'s own date', () => {
  const notices = async (f: any) => (await db.query<{ title: string; body: string }>(
    `SELECT title, body FROM notifications WHERE type = 'tenant_date_meter_reads_due'
        AND data ->> 'propertyId' = $1 ORDER BY created_at`, [f.propertyId])).rows

  it('says nothing early, names the meter on its day, once, and chases it while overdue', async () => {
    const f = await seedSite({ startDate: '2026-08-15', rentDueDay: 15 })
    await read(f, '2026-09-14', 1000, '2026-08-01')
    await openRun(f, '2026-09-01', '2026-09-30')

    expect(await promptTenantDateMeterReads('2026-10-13')).toEqual({ prompted: 0, meters: 0 })

    // Oct 15 2026 is a Thursday: the read day is Wednesday the 14th.
    expect(await promptTenantDateMeterReads('2026-10-14')).toEqual({ prompted: 1, meters: 1 })
    expect(await promptTenantDateMeterReads('2026-10-14')).toEqual({ prompted: 0, meters: 0 })   // once a day
    let n = await notices(f)
    expect(n).toHaveLength(1)
    expect(n[0].title).toMatch(/^Meter reads due today/)
    expect(n[0].body).toMatch(/1 meter to read today/)

    // Nobody read it. The next morning it is overdue, and the notice says what that costs.
    expect(await promptTenantDateMeterReads('2026-10-15')).toEqual({ prompted: 1, meters: 1 })
    n = await notices(f)
    expect(n[1].title).toMatch(/^Overdue meter reads/)
    expect(n[1].body).toMatch(/was due Oct 14/)
    expect(n[1].body).toMatch(/on hold, rent included/)

    // Read it, and the chasing stops.
    await read(f, '2026-10-15', 1400, '2026-09-01')
    expect(await promptTenantDateMeterReads('2026-10-16')).toEqual({ prompted: 0, meters: 0 })
  })

  it('leaves tenants on the 1st to the month-end round', async () => {
    const f = await seedSite({ startDate: '2026-08-01', rentDueDay: 1 })
    await openRun(f, '2026-09-01', '2026-09-30')
    expect(await promptTenantDateMeterReads('2026-09-30')).toEqual({ prompted: 0, meters: 0 })
    expect(await promptTenantDateMeterReads('2026-10-20')).toEqual({ prompted: 0, meters: 0 })
  })

  it('a read day that would land on a weekend is the Friday before', async () => {
    // Nov 15 2026 is a Sunday → read Friday Nov 13.
    const f = await seedSite({ startDate: '2026-08-15', rentDueDay: 15 })
    await openRun(f, '2026-10-01', '2026-10-30')
    expect(await promptTenantDateMeterReads('2026-11-12')).toEqual({ prompted: 0, meters: 0 })
    expect(await promptTenantDateMeterReads('2026-11-13')).toEqual({ prompted: 1, meters: 1 })
  })
})
