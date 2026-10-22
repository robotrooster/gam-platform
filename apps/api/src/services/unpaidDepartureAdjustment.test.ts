/**
 * 10/22 (Nic) — THE BILL ADJUSTMENT, for somebody who never paid the month they
 * left in.
 *
 *   "somebody doesn't pay on the first of the month, because they think they're
 *    going to be leaving in a week... It racks up late fees. They go to check
 *    out on the seventh... let's say they check out on the ninth. We want to
 *    adjust the bill so that there's no late fees but also get them prorated."
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease } from '../test/dbHelpers'
import { adjustUnpaidDepartureBill, repriceDeparture } from './departureReprice'

const RENT = 589

beforeEach(async () => { await cleanupAllSchema() })

async function park() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET rent_due_day = 1, timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A lease that ended on a given day, with its month BILLED and unpaid. */
async function leftOwingTheMonth(p: any, o: {
  endedOn?: string; startedOn?: string; lateFees?: number; rent?: number
} = {}) {
  const c = await getClient()
  let leaseId: string
  try {
    await c.query('BEGIN')
    leaseId = await seedLease(c, {
      unitId: p.unitId, landlordId: p.landlordId, rentAmount: o.rent ?? RENT,
      leaseType: 'month_to_month', status: 'terminated', startDate: o.startedOn ?? '2026-04-01',
    })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  await db.query(`UPDATE leases SET end_date = $2, rent_due_day = 1 WHERE id = $1`,
    [leaseId, o.endedOn ?? '2026-10-09'])

  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, total_amount, due_date, status, invoice_number)
     VALUES ($1,$2,$3,$4,$5,'2026-10-01','pending',$6) RETURNING id`,
    [p.landlordId, leaseId, p.tenantId, p.unitId, o.rent ?? RENT, `INV-${randomUUID().slice(0, 8)}`])).rows[0]
  await db.query(
    `INSERT INTO payments (lease_id, unit_id, tenant_id, landlord_id, invoice_id, type, amount, status, entry_description, due_date)
     VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending','RENT','2026-10-01')`,
    [leaseId, p.unitId, p.tenantId, p.landlordId, inv.id, o.rent ?? RENT])
  for (let i = 0; i < (o.lateFees ?? 0); i++) {
    await db.query(
      `INSERT INTO payments (lease_id, unit_id, tenant_id, landlord_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'late_fee',5,'pending','LATEFEE',$6::date)`,
      [leaseId, p.unitId, p.tenantId, p.landlordId, inv.id, `2026-10-0${i + 2}`])
  }
  return { leaseId, invoiceId: inv.id }
}

const billOn = async (leaseId: string) => (await db.query<{ amount: string; notes: string | null }>(
  `SELECT amount, notes FROM payments WHERE lease_id = $1 AND type = 'rent'`, [leaseId])).rows
const feesOn = async (invoiceId: string) => Number((await db.query<{ n: string }>(
  `SELECT COUNT(*)::text AS n FROM payments WHERE invoice_id = $1 AND type = 'late_fee' AND status IN ('pending','failed')`,
  [invoiceId])).rows[0].n)

describe('they left on the 9th and never paid October', () => {
  it('the bill becomes the days they used, and the late fees come off', async () => {
    const p = await park()
    const { leaseId, invoiceId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09', lateFees: 5 })
    expect(await feesOn(invoiceId)).toBe(5)

    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: p.landlordId, byUserId: p.userId })
    expect(out.applied).toBe(true)
    // Eight nights of October used (the leaving day is not charged) at
    // $589 ÷ 31 = $19.00 a night.
    expect(out).toMatchObject({ nightsUsed: 8, daysInPeriod: 31, rentWas: 589, rentNow: 152, lateFeeRows: 5 })
    expect(out.lateFeesOff).toBe(25)

    const [bill] = await billOn(leaseId)
    expect(Number(bill.amount)).toBe(152)
    expect(bill.notes).toMatch(/Re-priced when they left part way through the month/)
    expect(await feesOn(invoiceId)).toBe(0)
    expect(out.why).toMatch(/late fees came off/)
  })

  it('a resident owes no lodging tax on the re-price', async () => {
    const p = await park()
    await db.query(`UPDATE properties SET short_term_tax_rate = 6.6 WHERE id = $1`, [p.propertyId])
    const { leaseId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09' })
    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: p.landlordId, byUserId: p.userId })
    expect(out).toMatchObject({ applied: true, lodgingTax: 0, rentNow: 152 })
  })
})

describe('when it refuses, and says why', () => {
  it('they used half the month or more — the month stands', async () => {
    const p = await park()
    const { leaseId, invoiceId } = await leftOwingTheMonth(p, { endedOn: '2026-10-20', lateFees: 3 })
    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: p.landlordId, byUserId: p.userId })
    expect(out.applied).toBe(false)
    expect(out.why).toMatch(/half the month or more/)
    // Nothing moved: the bill stands and so do the late fees.
    expect(Number((await billOn(leaseId))[0].amount)).toBe(589)
    expect(await feesOn(invoiceId)).toBe(3)
  })

  it('the month was actually paid — that is a refund or a wash, not an adjustment', async () => {
    const p = await park()
    const { leaseId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09' })
    await db.query(`UPDATE payments SET status = 'settled' WHERE lease_id = $1 AND type = 'rent'`, [leaseId])
    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: p.landlordId, byUserId: p.userId })
    expect(out.applied).toBe(false)
    expect(out.why).toMatch(/refund or a wash/)
  })

  it('more than one unpaid rent charge on the month is left alone', async () => {
    const p = await park()
    const { leaseId, invoiceId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09' })
    await db.query(
      `INSERT INTO payments (lease_id, unit_id, tenant_id, landlord_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',100,'pending','RENT','2026-10-05')`,
      [leaseId, p.unitId, p.tenantId, p.landlordId, invoiceId])
    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: p.landlordId, byUserId: p.userId })
    expect(out.applied).toBe(false)
    expect(out.why).toMatch(/2 unpaid rent charges/)
    expect(Number((await billOn(leaseId))[0].amount)).toBe(589)
  })

  it('another landlord cannot adjust it', async () => {
    const p = await park()
    const other = await park()
    const { leaseId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09' })
    const out = await adjustUnpaidDepartureBill({ leaseId, landlordId: other.landlordId, byUserId: other.userId })
    expect(out.applied).toBe(false)
    expect(Number((await billOn(leaseId))[0].amount)).toBe(589)
  })
})

describe('the day they left is read as given', () => {
  it('a Sunday departure settled on Monday prices the Sunday', async () => {
    const p = await park()
    const { leaseId } = await leftOwingTheMonth(p, { endedOn: '2026-10-20' })   // on file: the 20th
    // The desk says they actually drove out on the 9th.
    const out = await adjustUnpaidDepartureBill({
      leaseId, landlordId: p.landlordId, leftOn: '2026-10-09', byUserId: p.userId })
    expect(out).toMatchObject({ applied: true, nightsUsed: 8, rentNow: 152 })
  })

  it('and quoting it changes nothing until it is applied', async () => {
    const p = await park()
    const { leaseId, invoiceId } = await leftOwingTheMonth(p, { endedOn: '2026-10-09', lateFees: 2 })
    const quote = await repriceDeparture({ leaseId, landlordId: p.landlordId })
    expect(quote).toMatchObject({ which: 'prorate', billBecomes: 152 })
    expect(Number((await billOn(leaseId))[0].amount)).toBe(589)
    expect(await feesOn(invoiceId)).toBe(2)
  })
})
