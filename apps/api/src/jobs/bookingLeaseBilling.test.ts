/**
 * S548 — calendar-aligned billing for booking-sourced leases.
 *
 * The guest's quote (computeMonthlyStaySchedule) IS the invoice plan:
 * prorated arrival month via the move-in invoice, flat monthly on the
 * 1st, prorated final month, and Master Schedule date changes flow into
 * the lease (dates follow, no-longer-owed pending rent drops, overpaid
 * rent banks as a lease_prepaid_credit).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices } from './invoiceGeneration'
import { generateMoveInInvoice } from './moveInBundle'
import { bookingRentForDueDate, syncLeaseWithBookingDates } from '../services/bookingLeaseBilling'
import { generateBillsForMeter } from '../services/utilityBilling'
import { seedUtilityMeter } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })

// Stay used throughout: Aug 10 2026 → Jan 28 2027 (exclusive), $950/mo.
// Schedule: Aug 10→Sep 1 22n $696.67 · Sep/Oct/Nov/Dec flat $950 · Jan 1→28 27n $855.
const START = '2026-08-10'
const END   = '2027-01-28'
const RENT  = 950

async function seedStack(opts: { bookingSourced?: boolean } = {}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: RENT, startDate: START })
    await seedLeaseTenant(client, { leaseId, tenantId })
    let bookingId: string | null = null
    if (opts.bookingSourced !== false) {
      const b = await client.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
         VALUES ($1, $2, 'month_to_month', $3, $4, 171, 'Sched Guest', 'sched-guest@test.dev', 'confirmed', 'public')
         RETURNING id`,
        [unitId, landlordId, START, END])
      bookingId = b.rows[0].id
      await client.query(
        `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date=$3, needs_review=false WHERE id=$1`,
        [leaseId, bookingId, END])
    } else {
      await client.query(`UPDATE leases SET end_date=$2, needs_review=false WHERE id=$1`, [leaseId, END])
    }
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function rentByDueDate(leaseId: string): Promise<Record<string, number>> {
  const rows = await db.query<any>(
    `SELECT to_char(due_date, 'YYYY-MM-DD') AS d, amount::numeric AS a
       FROM payments WHERE lease_id=$1 AND type='rent' ORDER BY due_date`, [leaseId])
  const out: Record<string, number> = {}
  for (const r of rows.rows) out[r.d] = Number(r.a)
  return out
}

describe('bookingRentForDueDate', () => {
  it('segments: prorated arrival, flat months, prorated final, null off-boundary', () => {
    expect(bookingRentForDueDate(START, END, RENT, '2026-08-10')).toBe(696.67)  // 22n × 950/30
    expect(bookingRentForDueDate(START, END, RENT, '2026-09-01')).toBe(950)
    expect(bookingRentForDueDate(START, END, RENT, '2026-10-01')).toBe(950)    // 31-day month still flat
    expect(bookingRentForDueDate(START, END, RENT, '2027-01-01')).toBe(855)    // 27n × 950/30
    expect(bookingRentForDueDate(START, END, RENT, '2026-09-15')).toBeNull()
  })
})

describe('invoice generation (calendar schedule)', () => {
  it('booking-sourced lease bills flat months + prorated final month', async () => {
    const s = await seedStack()
    const res = await backfillInvoices({ from: '2026-08-01', to: '2027-02-28', leaseId: s.leaseId })
    expect(res.invoicesInserted).toBe(5)   // Sep–Dec 1sts + Jan 1 (arrival rides move-in, not the cron)
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2026-09-01']).toBe(950)
    expect(rents['2026-10-01']).toBe(950)
    expect(rents['2026-11-01']).toBe(950)
    expect(rents['2026-12-01']).toBe(950)
    expect(rents['2027-01-01']).toBe(855)  // Jan 1→28 prorated — the departure month
  })

  it('regular lease keeps full-rent behavior (no proration)', async () => {
    const s = await seedStack({ bookingSourced: false })
    await backfillInvoices({ from: '2026-08-01', to: '2027-02-28', leaseId: s.leaseId })
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2027-01-01']).toBe(950)  // unchanged: full rent even in the final month
  })
})

describe('move-in invoice (arrival month)', () => {
  it('booking-sourced lease prorates arrival at monthly/30', async () => {
    const s = await seedStack()
    const r = await generateMoveInInvoice({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: RENT, start_date: START,
    } as any)
    expect(r.rentAmount).toBe(696.67)      // 22 nights × 950/30 — matches the quote
  })

  it('regular lease keeps days-in-month proration', async () => {
    const s = await seedStack({ bookingSourced: false })
    const r = await generateMoveInInvoice({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: RENT, start_date: START,
    } as any)
    expect(r.rentAmount).toBe(674.19)      // 950 × 22/31 — long-standing behavior
  })
})

describe('Master Schedule → lease sync', () => {
  it('pending draft simply follows the booking dates', async () => {
    const s = await seedStack()
    await db.query(`UPDATE leases SET status='pending' WHERE id=$1`, [s.leaseId])
    await db.query(`UPDATE unit_bookings SET check_in='2026-08-12', check_out='2026-12-15' WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)
    const l = await db.query<any>(
      `SELECT to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0]).toEqual({ s: '2026-08-12', e: '2026-12-15' })
  })

  it('active lease shortened: end moves, dropped pending rent, overpayment → prepaid credit', async () => {
    const s = await seedStack()
    // Guest has PAID arrival (696.67) + September (950) = 1646.67 settled;
    // October's 950 is still pending on an invoice.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01'),
              ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-10-01')`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId])

    // Working-class reality (Nic): they paid the month, then find out
    // they're leaving at week 3 — Sep 20 instead of Jan 28.
    await db.query(`UPDATE unit_bookings SET check_out='2026-09-20', nights=41 WHERE id=$1`, [s.bookingId])
    await syncLeaseWithBookingDates(s.bookingId!)

    const l = await db.query<any>(`SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [s.leaseId])
    expect(l.rows[0].e).toBe('2026-09-20')

    // October's pending rent is gone; settled rows untouched.
    const rents = await rentByDueDate(s.leaseId)
    expect(rents['2026-10-01']).toBeUndefined()
    expect(rents['2026-09-01']).toBe(950)

    // Owed now: 696.67 (arrival) + 19n × 950/30 = 601.67 → 1298.34.
    // Settled 1646.67 → credit 348.33, banked for the final bill.
    const credit = await db.query<any>(
      `SELECT amount_original::numeric AS a, amount_remaining::numeric AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(credit.rows).toHaveLength(1)
    expect(Number(credit.rows[0].a)).toBe(348.33)
    expect(Number(credit.rows[0].r)).toBe(348.33)
  })

  it('credit is consumed by the next generated invoice (existing netting rail)', async () => {
    const s = await seedStack()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 300, 300)`, [s.leaseId, s.tenantId])
    await backfillInvoices({ from: '2026-09-01', to: '2026-09-30', leaseId: s.leaseId })
    const pay = await db.query<any>(
      `SELECT amount::numeric AS a, status, notes FROM payments
        WHERE lease_id=$1 AND type='rent' ORDER BY amount DESC`, [s.leaseId])
    // 950 rent: 300 settled by credit, 650 remainder pending.
    const settled = pay.rows.find((p: any) => p.status === 'settled')
    expect(settled).toBeTruthy()
    expect(settled.notes).toContain('prepaid credit')
    const credit = await db.query<any>(
      `SELECT amount_remaining::numeric AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])
    expect(Number(credit.rows[0].r)).toBe(0)
  })
})

describe('S548 end-of-stay: final read after lease expiry', () => {
  it('bill generated post-expiry attaches to the departed tenant\'s lease', async () => {
    const s = await seedStack()
    // The 2am processor already expired the lease when the final read lands.
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [s.leaseId])

    const client = await getClient()
    let meterId: string
    try {
      await client.query('BEGIN')
      meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(
        `UPDATE utility_meters SET rate_per_unit=0.15, base_fee=5, digits=6 WHERE id=$1`, [meterId])
      await client.query(
        `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'electric', TRUE)`, [s.leaseId])
      // Prior cycle baseline + the FINAL read for the departure month.
      await client.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, '2026-12-28', 10000, '2026-12-01', $2),
                ($1, '2027-01-28', 10400, '2027-01-01', $2)`, [meterId, s.userId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const r = await generateBillsForMeter(meterId!, new Date('2027-01-01T00:00:00Z'))
    expect(r.billsCreated).toBe(1)
    const bill = await db.query<any>(
      `SELECT lease_id, tenant_id, charge_amount::numeric AS c, payment_id, status FROM utility_bills WHERE meter_id=$1`, [meterId!])
    expect(bill.rows[0].lease_id).toBe(s.leaseId)   // NOT landlord-absorbed
    expect(bill.rows[0].tenant_id).toBe(s.tenantId)
    expect(Number(bill.rows[0].c)).toBe(65)          // 400 kWh × 0.15 + $5 base

    // S548 immediate settlement: the ended lease's stub was invoiced ON THE
    // SPOT — invoice dated today, due today, utility payment pending.
    expect(bill.rows[0].payment_id).not.toBeNull()
    expect(bill.rows[0].status).toBe('billed')
    const inv = await db.query<any>(
      `SELECT i.due_date::text AS due, i.subtotal_utilities::numeric AS u, i.total_amount::numeric AS t, p.status
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.id = $1`, [bill.rows[0].payment_id])
    const today = new Date().toISOString().slice(0, 10)
    expect(inv.rows[0].due.slice(0, 10)).toBe(today)
    expect(Number(inv.rows[0].u)).toBe(65)
    expect(Number(inv.rows[0].t)).toBe(65)
    expect(inv.rows[0].status).toBe('pending')       // payable NOW; deposit sweep is the backstop
  })

  it('same-day turnover: the departing lease owns the cycle, not the new arrival', async () => {
    const s = await seedStack()
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [s.leaseId])
    // New guest pulls in the day the old one pulls out — ACTIVE lease from Jan 28.
    const client = await getClient()
    let meterId: string
    try {
      await client.query('BEGIN')
      const newTenantId = await seedTenant(client)
      const newLeaseId = await seedLease(client, {
        unitId: s.unitId, landlordId: s.landlordId, rentAmount: RENT, startDate: '2027-01-28', status: 'active',
      })
      await seedLeaseTenant(client, { leaseId: newLeaseId, tenantId: newTenantId })
      await client.query(`UPDATE leases SET needs_review=false WHERE id=$1`, [newLeaseId])
      meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(`UPDATE utility_meters SET rate_per_unit=0.15, base_fee=5, digits=6 WHERE id=$1`, [meterId])
      await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1, 'electric', TRUE), ($2, 'electric', TRUE)`, [s.leaseId, newLeaseId])
      await client.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1, '2026-12-28', 10000, '2026-12-01', $2),
                ($1, '2027-01-28', 10400, '2027-01-01', $2)`, [meterId, s.userId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    await generateBillsForMeter(meterId!, new Date('2027-01-01T00:00:00Z'))
    const bill = await db.query<any>(
      `SELECT lease_id, tenant_id FROM utility_bills WHERE meter_id=$1`, [meterId!])
    // The DEPARTING lease covered Jan 1 — it owns the January usage.
    expect(bill.rows[0].lease_id).toBe(s.leaseId)
    expect(bill.rows[0].tenant_id).toBe(s.tenantId)
  })
})

describe('S548 pull-out meter read prompt', () => {
  it('prompts the landlord for submetered sites departing today, once per day', async () => {
    const { promptMoveOutMeterReads } = await import('../services/utilityReadingRuns')
    const s = await seedStack()
    // Lease ends TODAY on a submetered site.
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE WHERE id=$1`, [s.leaseId])
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const meterId = await seedUtilityMeter(client, { propertyId: s.propertyId, utilityType: 'electric' })
      await client.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, s.unitId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const first = await promptMoveOutMeterReads()
    expect(first.prompted).toBe(1)
    const n = await db.query<any>(
      `SELECT title, body FROM notifications WHERE type='moveout_meter_reads_due' AND landlord_id=$1`, [s.landlordId])
    expect(n.rows).toHaveLength(1)
    expect(n.rows[0].title).toContain('Pull-out meter reads due today')
    expect(n.rows[0].body).toContain('pulling out today')

    // Same morning, second cron tick → no duplicate.
    const second = await promptMoveOutMeterReads()
    expect(second.prompted).toBe(0)
  })

  it('no submeter on the departing site → no prompt', async () => {
    const { promptMoveOutMeterReads } = await import('../services/utilityReadingRuns')
    const s = await seedStack()
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE WHERE id=$1`, [s.leaseId])
    const r = await promptMoveOutMeterReads()
    expect(r.prompted).toBe(0)
  })
})

describe('S548 move-out walkthrough scheduling', () => {
  it('lease inside the 3-business-day pre-end window → inspection due BY the end date, staff prompted, idempotent', async () => {
    const { scheduleMoveOutInspections } = await import('../services/moveOutInspections')
    const s = await seedStack()   // seedUnit defaults to 'apartment' — gated
    // Tenant moves out in 2 days — we're inside the window; inspect DURING move-out.
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE + 2, status='active' WHERE id=$1`, [s.leaseId])

    const first = await scheduleMoveOutInspections()
    expect(first.scheduled).toBe(1)
    const insp = await db.query<any>(
      `SELECT inspection_type, status, to_char(scheduled_for,'YYYY-MM-DD') AS due,
              to_char(CURRENT_DATE + 2,'YYYY-MM-DD') AS end_d
         FROM unit_inspections WHERE lease_id=$1`, [s.leaseId])
    expect(insp.rows).toHaveLength(1)
    expect(insp.rows[0].inspection_type).toBe('move_out')
    expect(insp.rows[0].due).toBe(insp.rows[0].end_d)   // deadline = lease end, not after
    const n = await db.query<any>(
      `SELECT body FROM notifications WHERE type='moveout_inspection_due' AND landlord_id=$1`, [s.landlordId])
    expect(n.rows.length).toBeGreaterThanOrEqual(1)
    expect(n.rows[0].body).toContain('WHILE they move out')

    const second = await scheduleMoveOutInspections()
    expect(second.scheduled).toBe(0)
  })

  it('lease ending far outside the window → not scheduled yet', async () => {
    const { scheduleMoveOutInspections } = await import('../services/moveOutInspections')
    const s = await seedStack()
    await db.query(`UPDATE leases SET end_date=CURRENT_DATE + 7, status='active' WHERE id=$1`, [s.leaseId])
    const r = await scheduleMoveOutInspections()
    expect(r.scheduled).toBe(0)
  })

  it('business-day helpers skip weekends and federal holidays', async () => {
    const { addBusinessDays, subtractBusinessDays } = await import('../services/moveOutInspections')
    expect(addBusinessDays('2026-08-14', 3)).toBe('2026-08-19')        // Fri +3 → Wed
    expect(addBusinessDays('2026-11-25', 3)).toBe('2026-12-01')        // Wed before Thanksgiving +3 → Tue
    expect(subtractBusinessDays('2026-08-19', 3)).toBe('2026-08-14')   // Wed −3 → Fri
    expect(subtractBusinessDays('2026-12-01', 3)).toBe('2026-11-25')   // Tue −3 → Wed (skips Thanksgiving)
  })
})
