/**
 * 10/3 (decisions #15) — a reservation that becomes a lease is never billed
 * twice for its deposit.
 *
 * "The counter takes only what is due now (the deposit), and the lease bills the
 * rest; never both." The register (or the booking site) takes a long stay's
 * deposit and stamps it on the reservation (unit_bookings.deposit_amount,
 * deposit_paid_at). The lease drafted from that reservation used to bill its
 * arrival rent in full anyway. Now the first bill takes what was paid off its
 * rent, says so, and keeps anything the arrival rent did not use as credit on
 * the lease (already the landlord's, already counted: 'reclassified').
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { generateMoveInInvoice, STAY_DEPOSIT_CREDIT_NOTE } from './moveInBundle'
import { draftLeaseFromStay } from '../services/stayTerms'

beforeEach(async () => { await cleanupAllSchema() })

const END = '2027-01-28'
const RENT = 950

async function stay(o: { start: string; deposit?: number | null; depositPaid?: boolean; balancePaid?: boolean; bookingSourced?: boolean }) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: RENT, startDate: o.start })
    await seedLeaseTenant(c, { leaseId, tenantId })
    let bookingId: string | null = null
    if (o.bookingSourced !== false) {
      bookingId = (await c.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source,
            total_amount, deposit_amount, deposit_paid_at, balance_billed_at, balance_paid_at)
         VALUES ($1,$2,'month_to_month',$3,$4,150,'Long Stay','confirmed','direct',4000,$5,
                 CASE WHEN $6::boolean THEN '2026-08-01 10:00:00-07'::timestamptz END,
                 CASE WHEN $7::boolean THEN '2026-08-01 10:00:00-07'::timestamptz END,
                 CASE WHEN $7::boolean THEN '2026-08-01 10:00:00-07'::timestamptz END)
         RETURNING id`,
        [unitId, landlordId, o.start, END, o.deposit ?? null, o.depositPaid ?? false, o.balancePaid ?? false])).rows[0].id
      await c.query(
        `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date=$3, needs_review=false WHERE id=$1`,
        [leaseId, bookingId, END])
    } else {
      await c.query(`UPDATE leases SET end_date=$2, needs_review=false WHERE id=$1`, [leaseId, END])
    }
    await c.query('COMMIT')
    return { landlordId, tenantId, unitId, leaseId, bookingId, start: o.start }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Stay = Awaited<ReturnType<typeof stay>>

const bill = (s: Stay) => generateMoveInInvoice({
  lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
  landlord_id: s.landlordId, rent_amount: RENT, start_date: s.start,
})
const rentRows = (s: Stay) => db.query<any>(
  `SELECT amount::float AS amount, notes FROM payments WHERE lease_id = $1 AND type = 'rent'`, [s.leaseId]).then(r => r.rows)
const invoice = (id: string) => db.query<any>(
  `SELECT subtotal_rent::float AS rent, total_amount::float AS total, notes FROM invoices WHERE id = $1`, [id]).then(r => r.rows[0])
const credits = (s: Stay) => db.query<any>(
  `SELECT amount_original::float AS amount, amount_remaining::float AS remaining, funded_by, note,
          received_at, tenant_id FROM lease_prepaid_credits WHERE lease_id = $1`, [s.leaseId]).then(r => r.rows)

describe("a long stay's deposit on the lease's first bill", () => {
  it('comes off the arrival rent, and the bill says so', async () => {
    // Aug 10 arrival: 22 nights × $950 / 31 = $674.19 arrival rent.
    const s = await stay({ start: '2026-08-10', deposit: 150, depositPaid: true })
    const r = await bill(s)
    expect(r.invoiceCreated).toBe(true)
    expect(r.rentAmount).toBe(524.19)
    expect(r.stayDepositCredited).toBe(150)
    expect(r.stayDepositLeftover).toBe(0)
    const rows = await rentRows(s)
    expect(rows).toEqual([{ amount: 524.19, notes: 'Rent $674.19 less the $150.00 reservation deposit already paid' }])
    expect(await invoice(r.invoiceId!)).toMatchObject({
      rent: 524.19, total: 524.19,
      notes: "The $150.00 already paid toward the reservation covers $150.00 of this bill's rent.",
    })
    expect(await credits(s)).toHaveLength(0)
  })

  it('a deposit bigger than the arrival rent covers it and keeps the rest as credit for the next bill — once', async () => {
    // Aug 29 arrival: 3 nights × $950 / 31 = $91.94.
    const s = await stay({ start: '2026-08-29', deposit: 150, depositPaid: true })
    const r = await bill(s)
    expect(r.rentAmount).toBe(0)
    expect(r.stayDepositCredited).toBe(91.94)
    expect(r.stayDepositLeftover).toBe(58.06)
    // No $0 rent line on the bill.
    expect(await rentRows(s)).toHaveLength(0)
    expect((await invoice(r.invoiceId!)).notes).toBe(
      "The $150.00 already paid toward the reservation covers $91.94 of this bill's rent; the other $58.06 is kept as credit toward the next bill.")
    const c = await credits(s)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ amount: 58.06, remaining: 58.06, funded_by: 'reclassified', note: STAY_DEPOSIT_CREDIT_NOTE, tenant_id: s.tenantId })
    expect(new Date(c[0].received_at).toISOString()).toBe(new Date('2026-08-01T17:00:00Z').toISOString())
    // A lease unwound and signed again finds its credit already there.
    await db.query(`DELETE FROM payments WHERE lease_id = $1`, [s.leaseId])
    await db.query(`DELETE FROM invoices WHERE lease_id = $1`, [s.leaseId])
    const again = await bill(s)
    expect(again.invoiceCreated).toBe(true)
    expect(await credits(s)).toHaveLength(1)
  })

  it('a stay paid whole: the whole price comes off, and what the first bill does not use is kept as credit', async () => {
    const s = await stay({ start: '2026-08-10', deposit: 150, depositPaid: true, balancePaid: true })
    const r = await bill(s)
    expect(r.rentAmount).toBe(0)
    expect(r.stayDepositCredited).toBe(674.19)
    expect(r.stayDepositLeftover).toBe(3325.81)
    expect((await invoice(r.invoiceId!)).notes).toBe(
      "The $4000.00 already paid toward the reservation covers $674.19 of this bill's rent; the other $3325.81 is kept as credit toward the next bill.")
    expect((await credits(s))[0]).toMatchObject({ amount: 3325.81, funded_by: 'reclassified', note: STAY_DEPOSIT_CREDIT_NOTE })
  })

  it('a payment stamped on the reservation with no separate deposit amount is the whole stay', async () => {
    const s = await stay({ start: '2026-08-10', deposit: null, depositPaid: true })
    const r = await bill(s)
    expect(r.stayDepositCredited).toBe(674.19)
    expect(r.stayDepositLeftover).toBe(3325.81)
    expect(r.rentAmount).toBe(0)
  })

  it('a deposit asked for but not paid takes nothing off', async () => {
    const s = await stay({ start: '2026-08-10', deposit: 150, depositPaid: false })
    const r = await bill(s)
    expect(r.rentAmount).toBe(674.19)
    expect(r.stayDepositCredited).toBe(0)
    expect((await rentRows(s))[0]).toMatchObject({ amount: 674.19, notes: null })
    expect((await invoice(r.invoiceId!)).notes).toBeNull()
  })

  it('a lease that did not come from a reservation is billed as before', async () => {
    const s = await stay({ start: '2026-08-10', bookingSourced: false })
    const r = await bill(s)
    expect(r.rentAmount).toBe(674.19)
    expect(r.stayDepositCredited).toBe(0)
  })
})

// 10/5 (Nic, R3/R4): a lease is drafted from a stay only when lease was chosen.
describe('the lease chosen for a stay tells the landlord about the deposit', () => {
  async function longStay(paid: 'deposit' | 'none' | 'whole' | 'stamped') {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const b = (await c.query<{ id: string }>(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, status, source,
            total_amount, deposit_amount, deposit_paid_at, balance_paid_at)
         VALUES ($1,$2,'month_to_month','2027-03-01','2027-04-15',45,'Long Stay','confirmed','direct',1400,
                 CASE WHEN $3 = 'stamped' THEN NULL ELSE 150 END,
                 CASE WHEN $3 IN ('deposit','whole','stamped') THEN now() END,
                 CASE WHEN $3 = 'whole' THEN now() END)
         RETURNING id`, [unitId, landlordId, paid])).rows[0].id
      await c.query('COMMIT')
      return b
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const body = () => db.query<{ body: string }>(
    `SELECT body FROM notifications WHERE type = 'lease_drafted_from_booking'`).then(r => r.rows[0].body)

  it('a paid deposit: names the amount and says it comes off the first bill', async () => {
    const r = await draftLeaseFromStay(await longStay('deposit'))
    expect(r.drafted).toBe(true)
    expect(await body()).toContain("The $150.00 deposit already paid on the reservation comes off the lease's first bill. "
      + "Anything more than that bill's rent is kept as credit toward the next one.")
  })

  it('no deposit paid yet: says what the code does — one paid before the lease is signed comes off its first bill', async () => {
    const r = await draftLeaseFromStay(await longStay('none'))
    expect(r.drafted).toBe(true)
    expect(await body()).toContain('A deposit paid on the reservation before the lease is signed comes off its first bill.')
  })

  it('a stay paid whole: names the whole amount', async () => {
    const r = await draftLeaseFromStay(await longStay('whole'))
    expect(r.drafted).toBe(true)
    expect(await body()).toContain("The $1400.00 already paid for the whole stay comes off the lease's first bill.")
  })

  it('a payment stamped with no separate deposit amount is the whole stay, as the first bill counts it', async () => {
    const r = await draftLeaseFromStay(await longStay('stamped'))
    expect(r.drafted).toBe(true)
    expect(await body()).toContain("The $1400.00 already paid for the whole stay comes off the lease's first bill.")
  })
})
