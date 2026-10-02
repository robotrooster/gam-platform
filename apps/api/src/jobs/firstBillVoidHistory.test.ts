/**
 * S654 — a VOIDED history invoice is not a prior bill.
 *
 * The onboarding waiver (S639/S648) covers an existing resident's FIRST bill on
 * the platform. Both the late-fee job and the nightly generator decided "first"
 * by counting earlier invoices on the lease — including voided ones. Country
 * Acres' "billed before GAM" rows were voided history, and counting them
 * defeated the waiver for ten of twelve residents. The fix (status <> 'void' in
 * lateFees.ts and invoiceGeneration.ts) is held here; a real earlier bill still
 * ends the waiver.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
} from '../test/dbHelpers'
import { generateLateFeesForTimezone } from './lateFees'
import { backfillInvoices } from './invoiceGeneration'

const TZ = 'America/Phoenix'
beforeEach(async () => { await cleanupAllSchema() })

type PriorStatus = 'void' | 'settled'

/**
 * An existing resident at a property whose landlord waived first-bill late
 * fees, $5/day after a 3-day grace.
 */
async function seedExistingResident(opts: { startDate?: string } = {}) {
  const rent = 460
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(
      `UPDATE properties SET timezone=$2, late_fee_enabled=TRUE, onboarding_late_fee_waiver=TRUE WHERE id=$1`,
      [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent, startDate: opts.startDate })
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(
      `UPDATE leases SET late_fee_enabled=TRUE, late_fee_grace_days=3,
         late_fee_initial_amount=0, late_fee_initial_type='flat',
         late_fee_accrual_amount=5, late_fee_accrual_type='flat',
         late_fee_accrual_period='daily', late_fee_accrual_from='due_date',
         rent_due_day=1, needs_review=FALSE, is_existing_tenancy=TRUE
        WHERE id=$1`, [leaseId])
    await c.query('COMMIT')
    return { landlordId: ll.landlordId, tenantId, unitId, leaseId, rent }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

type Resident = Awaited<ReturnType<typeof seedExistingResident>>

/** An earlier invoice on the lease — voided history, or a bill they paid. */
async function priorInvoice(r: Resident, status: PriorStatus, dueDateSql: string, params: unknown[] = []) {
  await db.query(
    `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date,
                           subtotal_rent, total_amount, status)
     VALUES ($1,$2,$3,$4,${dueDateSql},$5,$5,$6)`,
    [r.landlordId, r.leaseId, r.unitId, `INV-${Math.random().toString(36).slice(2, 10)}`, r.rent, status, ...params])
}

describe('late-fee job: a voided earlier invoice is not a prior bill', () => {
  /** A pending rent invoice 10 days past due, well beyond the 3-day grace. */
  async function overdueBill(r: Resident): Promise<string> {
    const { rows: [inv] } = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,(NOW() AT TIME ZONE $5)::date - 10,$6,$6,'pending')
       RETURNING id`,
      [r.landlordId, r.leaseId, r.unitId, `INV-${Math.random().toString(36).slice(2, 10)}`, TZ, r.rent])
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status,
                             entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date - 10,$6)`,
      [r.landlordId, r.unitId, r.leaseId, r.rent, TZ, inv.id])
    return inv.id
  }

  const lateFeeRows = async (invoiceId: string) => Number((await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM payments WHERE invoice_id=$1 AND type='late_fee'`, [invoiceId])).rows[0].n)

  const fortyDaysAgo = `(NOW() AT TIME ZONE $7)::date - 40`

  it('waives the first real bill when the only earlier invoice is void', async () => {
    const r = await seedExistingResident()
    await priorInvoice(r, 'void', fortyDaysAgo, [TZ])
    const invoiceId = await overdueBill(r)
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeRows(invoiceId)).toBe(0)
  })

  it('charges when the earlier invoice was a real (settled) bill', async () => {
    const r = await seedExistingResident()
    await priorInvoice(r, 'settled', fortyDaysAgo, [TZ])
    const invoiceId = await overdueBill(r)
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeRows(invoiceId)).toBeGreaterThan(0)
  })
})

describe('generator: a voided earlier invoice is not a prior bill', () => {
  const stampOn = async (r: Resident, dueDate: string) => (await db.query<{ late_fee_exempt: boolean }>(
    `SELECT late_fee_exempt FROM invoices WHERE lease_id=$1 AND due_date=$2::date`, [r.leaseId, dueDate])).rows[0]

  it('stamps the first real bill late-fee exempt when the only earlier invoice is void', async () => {
    const r = await seedExistingResident({ startDate: '2026-05-01' })
    await priorInvoice(r, 'void', `'2026-06-01'::date`)
    await backfillInvoices({ from: '2026-07-01', to: '2026-07-01', leaseId: r.leaseId })
    expect(await stampOn(r, '2026-07-01')).toEqual({ late_fee_exempt: true })
  })

  it('does not stamp it when the earlier invoice was a real (settled) bill', async () => {
    const r = await seedExistingResident({ startDate: '2026-05-01' })
    await priorInvoice(r, 'settled', `'2026-06-01'::date`)
    await backfillInvoices({ from: '2026-07-01', to: '2026-07-01', leaseId: r.leaseId })
    expect(await stampOn(r, '2026-07-01')).toEqual({ late_fee_exempt: false })
  })
})
