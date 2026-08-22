/**
 * S615 — the invoice for a space with no lease.
 *
 * S614 could attribute and price a bill for a serviced space next door and
 * then had nowhere to put it: invoiceGeneration iterates ACTIVE LEASES, so
 * those bills were written to utility_bills and never reached a document or a
 * payment. Nic was still collecting that $75 in cash.
 *
 * These cover the driver that closes it — that the money lands on an invoice
 * the payer can see, that re-running never double-bills, and the two ways this
 * could go quietly wrong: a $0 document for an unread meter, and the late-fee
 * engine skipping these invoices entirely.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedUtilityMeter,
} from '../test/dbHelpers'
import { generateServiceAgreementInvoices } from './serviceAgreementInvoices'
import { generateLateFeesForInvoice } from './lateFees'

beforeEach(async () => {
  await cleanupAllSchema()
})

interface Ctx {
  landlordUserId: string
  landlordId: string
  propertyId: string
  unitId: string
  tenantId: string
  agreementId: string
}

/** A property with three trash cans next door on a flat $25 rate — Oak Park's
 *  actual case, and the number Nic named. */
async function servicedSpaceWithTrash(
  opts: { cans?: number; dueDay?: number } = {},
): Promise<Ctx> {
  const c = await db.connect()
  let ctx: Ctx
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE units SET status = 'utility_service' WHERE id = $1`, [unitId])
    const { rows: [sa] } = await c.query(
      `INSERT INTO utility_service_agreements
         (landlord_id, unit_id, tenant_id, start_date, billing_due_day,
          service_address, late_fee_enabled, late_fee_grace_days,
          late_fee_initial_type, late_fee_initial_amount)
       VALUES ($1, $2, $3, '2026-01-01', $4, '2 Next Door Ln',
               true, 5, 'flat', 25)
       RETURNING id`,
      [landlordId, unitId, tenantId, opts.dueDay ?? 1])
    ctx = { landlordUserId, landlordId, propertyId, unitId, tenantId, agreementId: sa.id }
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  const c2 = await db.connect()
  let meterId = ''
  try {
    await c2.query('BEGIN')
    meterId = await seedUtilityMeter(c2, { propertyId: ctx.propertyId })
    await c2.query('COMMIT')
  } finally { c2.release() }
  await db.query(
    `UPDATE utility_meters SET billing_method='flat_rate', utility_type='trash', digits=NULL
      WHERE id=$1`, [meterId])
  await db.query(
    `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
     VALUES ($1,'trash',25,0)
     ON CONFLICT (property_id, utility_type) DO UPDATE SET rate_per_unit = EXCLUDED.rate_per_unit`,
    [ctx.propertyId])
  await db.query(
    `INSERT INTO utility_meter_units (meter_id, unit_id, quantity) VALUES ($1,$2,$3)`,
    [meterId, ctx.unitId, opts.cans ?? 3])
  return ctx
}

describe('utility-service invoices (S615)', () => {
  it('puts the $75 next door on an invoice the payer can pay', async () => {
    const ctx = await servicedSpaceWithTrash()

    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBeGreaterThan(0)

    const { rows: invs } = await db.query<any>(
      `SELECT id, lease_id, service_agreement_id, tenant_id, unit_id,
              subtotal_rent::text  AS rent,
              subtotal_utilities::text AS utils,
              total_amount::text   AS total
         FROM invoices WHERE service_agreement_id = $1 ORDER BY due_date`,
      [ctx.agreementId])
    expect(invs.length).toBeGreaterThan(0)
    const inv = invs[invs.length - 1]

    expect(inv.lease_id).toBeNull()                 // no tenancy behind it
    expect(inv.tenant_id).toBe(ctx.tenantId)        // but a real payer
    expect(Number(inv.rent)).toBe(0)                // and no rent, ever
    expect(Number(inv.utils)).toBe(75)
    expect(Number(inv.total)).toBe(75)

    // The charge is a real payable row, not just a subtotal.
    const { rows: pay } = await db.query<any>(
      `SELECT type, amount::text, status, lease_id, notes
         FROM payments WHERE invoice_id = $1`, [inv.id])
    expect(pay).toHaveLength(1)
    expect(pay[0].type).toBe('utility')
    expect(Number(pay[0].amount)).toBe(75)
    expect(pay[0].status).toBe('pending')
    expect(pay[0].lease_id).toBeNull()
    // S613 line format: honest quantity at the property's one price.
    expect(pay[0].notes).toBe('3 × $25.00')
  })

  it('re-running never bills the same cycle twice', async () => {
    const ctx = await servicedSpaceWithTrash()
    const when = new Date('2026-03-05T14:00:00Z')

    await generateServiceAgreementInvoices(when)
    const first = await db.query(
      `SELECT id FROM invoices WHERE service_agreement_id = $1`, [ctx.agreementId])

    const again = await generateServiceAgreementInvoices(when)
    expect(again.invoicesInserted).toBe(0)

    const second = await db.query(
      `SELECT id FROM invoices WHERE service_agreement_id = $1`, [ctx.agreementId])
    expect(second.rows.length).toBe(first.rows.length)

    // And the bill is still attached exactly once.
    const { rows: bills } = await db.query<any>(
      `SELECT payment_id, status FROM utility_bills WHERE service_agreement_id = $1`,
      [ctx.agreementId])
    for (const b of bills) {
      expect(b.payment_id).not.toBeNull()
      expect(b.status).toBe('billed')
    }
  })

  // A $0 invoice would be a document that says nothing AND would burn the
  // cycle's idempotency key, so the real charge could never land on it once
  // the meter is finally read.
  it('issues nothing at all when there is nothing to bill', async () => {
    const c = await db.connect()
    let agreementId = ''
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      await c.query(`UPDATE units SET status='utility_service' WHERE id=$1`, [unitId])
      const { rows: [sa] } = await c.query(
        `INSERT INTO utility_service_agreements (landlord_id, unit_id, tenant_id, start_date)
         VALUES ($1,$2,$3,'2026-01-01') RETURNING id`, [landlordId, unitId, tenantId])
      agreementId = sa.id
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
    const { rows } = await db.query(
      `SELECT id FROM invoices WHERE service_agreement_id = $1`, [agreementId])
    expect(rows).toHaveLength(0)
  })

  it('an ended agreement stops invoicing', async () => {
    const ctx = await servicedSpaceWithTrash()
    await db.query(
      `UPDATE utility_service_agreements SET status='ended', end_date='2026-02-01' WHERE id=$1`,
      [ctx.agreementId])
    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
  })

  // The late-fee engine INNER JOINed leases, which silently excluded every one
  // of these invoices. Nic asked for the same late fee rent gets.
  it('accrues the same late fee an unpaid rent invoice would', async () => {
    const ctx = await servicedSpaceWithTrash()
    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))

    const { rows: [inv] } = await db.query<any>(
      `SELECT id FROM invoices WHERE service_agreement_id = $1
        ORDER BY due_date DESC LIMIT 1`, [ctx.agreementId])
    // Push the due date well past the 5-day grace.
    await db.query(
      `UPDATE invoices SET due_date = (NOW() - INTERVAL '20 days')::date WHERE id = $1`, [inv.id])
    await db.query(
      `UPDATE payments SET due_date = (NOW() - INTERVAL '20 days')::date WHERE invoice_id = $1`, [inv.id])

    const res = await generateLateFeesForInvoice(inv.id)
    expect(res.invoicesScanned).toBe(1)

    const { rows: fees } = await db.query<any>(
      `SELECT amount::text, lease_id FROM payments
        WHERE invoice_id = $1 AND type = 'late_fee'`, [inv.id])
    expect(fees.length).toBeGreaterThan(0)
    expect(Number(fees[0].amount)).toBe(25)
    expect(fees[0].lease_id).toBeNull()
  })

  // percent_of_rent on an agreement that structurally has no rent must base on
  // the utilities — otherwise every such fee computes as exactly $0 while
  // looking configured.
  it('bases a percentage fee on the utilities when there is no rent', async () => {
    const ctx = await servicedSpaceWithTrash()
    await db.query(
      `UPDATE utility_service_agreements
          SET late_fee_initial_type = 'percent_of_rent', late_fee_initial_amount = 10
        WHERE id = $1`, [ctx.agreementId])
    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))

    const { rows: [inv] } = await db.query<any>(
      `SELECT id FROM invoices WHERE service_agreement_id = $1
        ORDER BY due_date DESC LIMIT 1`, [ctx.agreementId])
    await db.query(
      `UPDATE invoices SET due_date = (NOW() - INTERVAL '20 days')::date WHERE id = $1`, [inv.id])
    await db.query(
      `UPDATE payments SET due_date = (NOW() - INTERVAL '20 days')::date WHERE invoice_id = $1`, [inv.id])

    await generateLateFeesForInvoice(inv.id)
    const { rows: fees } = await db.query<any>(
      `SELECT amount::text FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [inv.id])
    expect(fees.length).toBeGreaterThan(0)
    expect(Number(fees[0].amount)).toBe(7.5)   // 10% of $75, not 10% of no rent
  })
})
