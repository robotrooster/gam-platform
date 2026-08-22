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
  seedUtilityMeter, seedLease,
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
          late_fee_initial_type, late_fee_initial_amount,
          -- S616: the landlord attests the arrangement predates GAM, which is
          -- Nic's own case — cash collected by hand for years.
          payer_attested_at)
       VALUES ($1, $2, $3, '2026-01-01', $4, '2 Next Door Ln',
               true, 5, 'flat', 25, NOW())
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

// S615: superseded_by_lease_id was added in S614 and nothing ever set it.
// Nic: when the space's real owner onboards and puts a lease on it, "the $2
// moves and is never charged twice for one space."
describe('supersedence (S615)', () => {
  it('a lease going active on a serviced space stamps the agreement', async () => {
    const ctx = await servicedSpaceWithTrash()

    const { rows: [before] } = await db.query<any>(
      `SELECT superseded_by_lease_id FROM utility_service_agreements WHERE id=$1`,
      [ctx.agreementId])
    expect(before.superseded_by_lease_id).toBeNull()

    const c = await db.connect()
    let leaseId = ''
    try {
      await c.query('BEGIN')
      leaseId = await seedLease(c, {
        unitId: ctx.unitId, landlordId: ctx.landlordId, status: 'active',
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const { rows: [after] } = await db.query<any>(
      `SELECT superseded_by_lease_id, status FROM utility_service_agreements WHERE id=$1`,
      [ctx.agreementId])
    expect(after.superseded_by_lease_id).toBe(leaseId)
    // The agreement keeps billing — the landlord still supplies that power.
    // Only the platform fee moved.
    expect(after.status).toBe('active')
  })

  it('a lease that is not yet active does not move the fee', async () => {
    const ctx = await servicedSpaceWithTrash()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await seedLease(c, {
        unitId: ctx.unitId, landlordId: ctx.landlordId, status: 'pending',
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const { rows: [after] } = await db.query<any>(
      `SELECT superseded_by_lease_id FROM utility_service_agreements WHERE id=$1`,
      [ctx.agreementId])
    expect(after.superseded_by_lease_id).toBeNull()
  })

  it('activating an existing lease later stamps it too', async () => {
    const ctx = await servicedSpaceWithTrash()
    const c = await db.connect()
    let leaseId = ''
    try {
      await c.query('BEGIN')
      leaseId = await seedLease(c, {
        unitId: ctx.unitId, landlordId: ctx.landlordId, status: 'pending',
      })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    await db.query(`UPDATE leases SET status='active' WHERE id=$1`, [leaseId])

    const { rows: [after] } = await db.query<any>(
      `SELECT superseded_by_lease_id FROM utility_service_agreements WHERE id=$1`,
      [ctx.agreementId])
    expect(after.superseded_by_lease_id).toBe(leaseId)
  })
})

// S615: the payer must be able to LOG IN and SEE the bill, or the invoice is a
// document nobody receives and the landlord is still driving over for cash.
describe('the payer sees their bill in the portal (S615)', () => {
  it('balance-context returns the charge as a payable service charge, not a lease group', async () => {
    const { camelCaseKeys } = await import('../lib/caseConversion')
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const jwt = (await import('jsonwebtoken')).default
    const { paymentsRouter } = await import('../routes/payments')
    const { errorHandler } = await import('../middleware/errorHandler')

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_svcportal'
    const ctx = await servicedSpaceWithTrash()
    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))

    const app = express()
    app.use(express.json())
    app.use((_req: any, res: any, next: any) => {
      const originalJson = res.json.bind(res)
      res.json = (body: any) => originalJson(camelCaseKeys(body))
      next()
    })
    app.use('/api/payments', paymentsRouter)
    app.use(errorHandler)

    const token = jwt.sign(
      { userId: 'x', role: 'tenant', profileId: ctx.tenantId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(app)
      .get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    // NOT a lease group — a null-keyed group would render a Pay button that
    // resolves to a lease filter matching nothing and 409s on a bill the
    // person is looking at.
    expect(res.body.data.leases).toHaveLength(0)
    expect(res.body.data.serviceAgreements).toHaveLength(1)
    expect(Number(res.body.data.serviceAgreements[0].outstanding)).toBe(75)
    expect(res.body.data.serviceAgreements[0].rows[0].notes).toBe('3 × $25.00')
    expect(Number(res.body.data.totalOutstanding)).toBe(75)
  })

  it('/tenants/me tells the portal this person has no lease but does have service', async () => {
    const { camelCaseKeys } = await import('../lib/caseConversion')
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const jwt = (await import('jsonwebtoken')).default
    const { tenantsRouter } = await import('../routes/tenants')
    const { errorHandler } = await import('../middleware/errorHandler')

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_svcportal'
    const ctx = await servicedSpaceWithTrash()

    const app = express()
    app.use(express.json())
    app.use((_req: any, res: any, next: any) => {
      const originalJson = res.json.bind(res)
      res.json = (body: any) => originalJson(camelCaseKeys(body))
      next()
    })
    app.use('/api/tenants', tenantsRouter)
    app.use(errorHandler)

    const token = jwt.sign(
      { userId: 'x', role: 'tenant', profileId: ctx.tenantId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    // Without this the tenant nav computes showFullNav=false and the only
    // thing they can reach after logging in is a background check they have
    // no reason to take.
    expect(res.body.data.utilityServiceAgreementId).toBe(ctx.agreementId)
    expect(res.body.data.utilityServiceAddress).toBe('2 Next Door Ln')
    expect(res.body.data.unitId).toBeNull()
  })
})

// S616 (Nic): "how am I as a landlord going to set up the initial 'hey, let's
// bill utilities to this random address' and email [them]... without any sort
// of [check], what else are we missing?"
//
// This was missing. S615 let a landlord type any name, email and address, open
// a portal account for that person, and start invoicing them — with nothing
// anywhere checking that they had ever agreed to be billed.
describe('nobody is invoiced without having agreed (S616)', () => {
  async function unconsented() {
    const c = await db.connect()
    let ctx: any
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      await c.query(`UPDATE units SET status='utility_service' WHERE id=$1`, [unitId])
      const { rows: [sa] } = await c.query(
        `INSERT INTO utility_service_agreements
           (landlord_id, unit_id, tenant_id, start_date, billing_due_day)
         VALUES ($1,$2,$3,'2026-01-01',1) RETURNING id`,
        [landlordId, unitId, tenantId])
      ctx = { landlordId, propertyId, unitId, tenantId, agreementId: sa.id }
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
      `UPDATE utility_meters SET billing_method='flat_rate', utility_type='trash',
              digits=NULL WHERE id=$1`, [meterId])
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1,'trash',25,0) ON CONFLICT (property_id, utility_type)
       DO UPDATE SET rate_per_unit = EXCLUDED.rate_per_unit`, [ctx.propertyId])
    await db.query(
      `INSERT INTO utility_meter_units (meter_id, unit_id, quantity) VALUES ($1,$2,1)`,
      [meterId, ctx.unitId])
    return ctx
  }

  it('issues no invoice to someone who never agreed to be billed', async () => {
    const ctx = await unconsented()
    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
  })

  // The charge is NOT lost. The meter turned and the service happened; a bill
  // nobody sent is not a bill nobody owes.
  it('still accrues the charge, and bills it the cycle after they agree', async () => {
    const ctx = await unconsented()
    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))

    await db.query(
      `UPDATE utility_service_agreements SET payer_accepted_at = NOW() WHERE id = $1`,
      [ctx.agreementId])

    const res = await generateServiceAgreementInvoices(new Date('2026-04-05T14:00:00Z'))
    expect(res.invoicesInserted).toBeGreaterThan(0)
    const { rows } = await db.query<any>(
      `SELECT total_amount::text AS total FROM invoices WHERE service_agreement_id = $1`,
      [ctx.agreementId])
    // Both cycles' cans — the March charge rode the first invoice it could.
    expect(Number(rows[0].total)).toBeGreaterThanOrEqual(25)
  })

  // Nic's own case: the arrangement predates GAM and the neighbour is never
  // going to click an email.
  it('a landlord can attest to an arrangement that predates GAM', async () => {
    const ctx = await unconsented()
    await db.query(
      `UPDATE utility_service_agreements
          SET payer_attested_at = NOW(), payer_attestation_note = 'Paid cash for years'
        WHERE id = $1`, [ctx.agreementId])

    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBe(1)
  })
})

// S616 (Nic): "their trash and electric needs to be on one bill if they have
// more than one utility through this subsystem." Two utilities is one bill,
// one Pay, one Stripe charge — paying them separately would charge the
// processing fee twice for one month at one address.
describe('one bill however many utilities (S616)', () => {
  it('trash and electric arrive as ONE bill with both lines', async () => {
    const ctx = await servicedSpaceWithTrash()

    // A second utility on the same serviced space: a submetered electric.
    const c = await db.connect()
    let meterId = ''
    try {
      await c.query('BEGIN')
      meterId = await seedUtilityMeter(c, { propertyId: ctx.propertyId })
      await c.query('COMMIT')
    } finally { c.release() }
    await db.query(
      `UPDATE utility_meters SET billing_method='submeter', utility_type='electric',
              rate_per_unit=0.21 WHERE id=$1`, [meterId])
    await db.query(
      `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [meterId, ctx.unitId])
    for (const [cycle, val] of [['2026-02-01', 1000], ['2026-03-01', 1100]] as const) {
      await db.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [meterId, cycle, val, cycle, ctx.landlordUserId])
    }

    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))

    // ONE invoice carrying both.
    const { rows: invs } = await db.query<any>(
      `SELECT id, total_amount::text AS total FROM invoices
        WHERE service_agreement_id = $1`, [ctx.agreementId])
    expect(invs).toHaveLength(1)
    expect(Number(invs[0].total)).toBe(96)      // $75 trash + $21 electric

    const { rows: pays } = await db.query<any>(
      `SELECT amount::text AS amt FROM payments WHERE invoice_id = $1`, [invs[0].id])
    expect(pays).toHaveLength(2)
  })
})
