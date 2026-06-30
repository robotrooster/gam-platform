/**
 * S517 / Walkthrough Landlord #29 — work-trade percent-of-invoice credit.
 *
 * Pure math (workTradeFraction + distributeWorkTradeCredit) plus the
 * integration through generateInvoices: verified prior-month hours buy a
 * percent of the monthly invoice total against the property's hours target,
 * applied rent-first, with the invoice keeping gross subtotals.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant, seedLeaseFee,
} from '../test/dbHelpers'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { workTradeFraction, distributeWorkTradeCredit } from './workTradeCredit'

beforeEach(async () => {
  await cleanupAllSchema()
})

// ── PURE MATH ────────────────────────────────────────────────

describe('workTradeFraction', () => {
  it('proportional below target', () => {
    expect(workTradeFraction(40, 80)).toBe(0.5)
    expect(workTradeFraction(20, 80)).toBe(0.25)
  })
  it('caps at 1.0 (a trade, not paid labor)', () => {
    expect(workTradeFraction(80, 80)).toBe(1)
    expect(workTradeFraction(160, 80)).toBe(1)
  })
  it('zero hours or bad target → 0', () => {
    expect(workTradeFraction(0, 80)).toBe(0)
    expect(workTradeFraction(40, 0)).toBe(0)
  })
})

describe('distributeWorkTradeCredit', () => {
  it('rent-only: credit comes off rent', () => {
    const d = distributeWorkTradeCredit(1000, [], [], 500)
    expect(d.rentNet).toBe(500)
    expect(d.creditApplied).toBe(500)
  })
  it('credit ≤ rent leaves utilities + fees untouched (rent-first priority)', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 650)
    expect(d.rentNet).toBe(350)
    expect(d.utilityNets).toEqual([200])
    expect(d.feeNets).toEqual([100])
    expect(d.creditApplied).toBe(650)
  })
  it('credit > rent spills into utilities then fees', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 1100)
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([100])
    expect(d.feeNets).toEqual([100])
    expect(d.creditApplied).toBe(1100)
  })
  it('100% credit zeroes everything', () => {
    const d = distributeWorkTradeCredit(1000, [200], [100], 1300)
    expect(d.rentNet).toBe(0)
    expect(d.utilityNets).toEqual([0])
    expect(d.feeNets).toEqual([0])
    expect(d.creditApplied).toBe(1300)
  })
})

// ── INTEGRATION through generateInvoices ─────────────────────

// Builds an active lease whose property + work-trade agreement are set up so
// that running generateInvoices for 2026-05-05 produces the 2026-05-01
// invoice, crediting APPROVED hours logged in April 2026 (the prior month).
async function seedWorkTradeStack(opts: {
  rentAmount?: number
  target?: number
  approvedHours?: number
  pendingHours?: number
  hoursMonth?: string          // 'YYYY-MM', defaults to prior month 2026-04
  agreement?: boolean          // false → no agreement at all
  monthlyFees?: Array<{ type: string; amount: number }>
}): Promise<{ landlordId: string; tenantId: string; unitId: string; leaseId: string; agreementId: string | null }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.target !== undefined) {
      await client.query('UPDATE properties SET work_trade_hours_target=$1 WHERE id=$2', [opts.target, propertyId])
    }
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: opts.rentAmount ?? 1000 })
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: opts.rentAmount ?? 1000, status: 'active', startDate: '2026-04-01',
    })
    await client.query('UPDATE leases SET rent_due_day=1 WHERE id=$1', [leaseId])
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    for (const f of opts.monthlyFees ?? []) {
      await seedLeaseFee(client, { leaseId, feeType: f.type, amount: f.amount, dueTiming: 'monthly_ongoing' })
    }

    let agreementId: string | null = null
    if (opts.agreement !== false) {
      const a = await client.query<{ id: string }>(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date)
         VALUES ($1,$2,$3,'2026-01-01') RETURNING id`,
        [unitId, tenantId, landlordId])
      agreementId = a.rows[0].id
      const month = opts.hoursMonth ?? '2026-04'
      if (opts.approvedHours) {
        await client.query(
          `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
           VALUES ($1,$2,$3,$4,$5,'grounds','approved')`,
          [agreementId, tenantId, userId, `${month}-10`, opts.approvedHours])
      }
      if (opts.pendingHours) {
        await client.query(
          `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
           VALUES ($1,$2,$3,$4,$5,'grounds','pending')`,
          [agreementId, tenantId, userId, `${month}-12`, opts.pendingHours])
      }
    }
    await client.query('COMMIT')
    return { landlordId, tenantId, unitId, leaseId, agreementId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const NOW = new Date('2026-05-05T12:00:00Z')

async function invoiceFor(leaseId: string) {
  const inv = await db.query<any>('SELECT * FROM invoices WHERE lease_id=$1', [leaseId])
  expect(inv.rows).toHaveLength(1)
  const pays = await db.query<any>('SELECT type, amount, status, notes FROM payments WHERE invoice_id=$1', [inv.rows[0].id])
  return { invoice: inv.rows[0], payments: pays.rows }
}

describe('generateInvoices — work-trade credit', () => {
  it('50% of target → half the rent invoice is credited; rent row reduced, pending', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 40 }) // target default 80
    await generateInvoices(NOW)
    const { invoice, payments } = await invoiceFor(s.leaseId)
    expect(invoice.subtotal_rent).toBe('1000.00')          // gross preserved
    expect(invoice.work_trade_credit_amount).toBe('500.00')
    expect(invoice.work_trade_credit_hours).toBe('40.00')
    expect(invoice.work_trade_agreement_id).toBe(s.agreementId)
    expect(invoice.total_amount).toBe('500.00')            // net
    const rent = payments.find(p => p.type === 'rent')
    expect(rent.amount).toBe('500.00')
    expect(rent.status).toBe('pending')
  })

  it('100% of target → rent fully covered; $0 rent row recorded settled', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 80 })
    await generateInvoices(NOW)
    const { invoice, payments } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('1000.00')
    expect(invoice.total_amount).toBe('0.00')
    const rent = payments.find(p => p.type === 'rent')
    expect(rent.amount).toBe('0.00')
    expect(rent.status).toBe('settled')
    expect(rent.notes).toMatch(/work-trade/i)
  })

  it('credit basis includes monthly fees; lands on rent first', async () => {
    const s = await seedWorkTradeStack({
      rentAmount: 1000, approvedHours: 40, monthlyFees: [{ type: 'pet_rent', amount: 200 }],
    })
    await generateInvoices(NOW)
    const { invoice, payments } = await invoiceFor(s.leaseId)
    // billable 1200 × 0.5 = 600 credit, taken off rent first
    expect(invoice.work_trade_credit_amount).toBe('600.00')
    expect(invoice.total_amount).toBe('600.00')
    expect(payments.find(p => p.type === 'rent').amount).toBe('400.00')
    expect(payments.find(p => p.type === 'fee').amount).toBe('200.00')
  })

  it('only APPROVED hours count — pending hours give no credit', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, pendingHours: 60 })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.total_amount).toBe('1000.00')
  })

  it('hours in the wrong month do not credit this invoice', async () => {
    // Logged in May (the invoice month), not April (the prior/earned month).
    const s = await seedWorkTradeStack({ rentAmount: 1000, approvedHours: 80, hoursMonth: '2026-05' })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.total_amount).toBe('1000.00')
  })

  it('no agreement → no credit, gross invoice unchanged', async () => {
    const s = await seedWorkTradeStack({ rentAmount: 1000, agreement: false })
    await generateInvoices(NOW)
    const { invoice } = await invoiceFor(s.leaseId)
    expect(invoice.work_trade_credit_amount).toBe('0.00')
    expect(invoice.work_trade_agreement_id).toBeNull()
    expect(invoice.total_amount).toBe('1000.00')
  })
})
