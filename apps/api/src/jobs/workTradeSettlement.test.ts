/**
 * S624 — the work-trade month-close settlement, driven against a real database.
 *
 * The arithmetic is pinned in services/workTradeSettlement.test.ts. This file
 * exists because that is not the same thing as the job being right: it checks
 * that the invoice is actually credited, that the rows the credit lands on are
 * really settled, that a billed deficit becomes a charge the tenant can pay, and
 * that running the same month twice does not pay for it twice.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { runWorkTradeSettlement, settleAgreementOnEnd } from './workTradeSettlement'
import { hourRateFor } from '../services/workTradeSettlement'
import { loadWorkTradeStanding } from '../services/workTradeStanding'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Stack {
  landlordId: string; tenantId: string; unitId: string; leaseId: string
  agreementId: string; invoiceId: string; userId: string
}

/** One work-trade tenancy: 80-hour target, a $500 September invoice, gross. */
async function buildStack(opts: {
  target?: number; basis?: number; carryForwardMonths?: number
  periodMonth?: string
} = {}): Promise<Stack> {
  const target = opts.target ?? 80
  const basis = opts.basis ?? 500
  const periodMonth = opts.periodMonth ?? '2026-09-01'
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: basis })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: basis })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })

    const ag = await client.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status,
          monthly_hours_target, carry_forward_months)
       VALUES ($1,$2,$3,'2026-08-01','active',$4,$5) RETURNING id`,
      [unitId, tenantId, landlordId, target, opts.carryForwardMonths ?? 1])
    const agreementId = ag.rows[0].id

    const inv = await client.query(
      `INSERT INTO invoices
         (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
          subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,$8,TRUE) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `WT-${randomUUID().slice(0, 8)}`, periodMonth,
       basis.toFixed(2), agreementId])
    const invoiceId = inv.rows[0].id

    await client.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending',$7::date,'RENT')`,
      [invoiceId, unitId, leaseId, tenantId, landlordId, basis.toFixed(2), periodMonth])

    await client.query(
      `INSERT INTO work_trade_settlements
         (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
       VALUES ($1,$2,$3::date,$4,$5,$6)`,
      [agreementId, invoiceId, periodMonth, target.toFixed(2),
       hourRateFor(basis, target).toFixed(4), basis.toFixed(2)])

    return { landlordId, tenantId, unitId, leaseId, agreementId, invoiceId, userId }
  } finally { client.release() }
}

async function logHours(s: Stack, workDate: string, hours: number) {
  await db.query(
    `INSERT INTO work_trade_logs
       (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
     VALUES ($1,$2,$3,$4::date,$5,'work','approved')`,
    [s.agreementId, s.tenantId, s.userId, workDate, hours])
}

const invoiceOf = async (id: string) => (await db.query(
  `SELECT total_amount::float AS total, work_trade_credit_amount::float AS credit,
          work_trade_credit_hours::float AS hours FROM invoices WHERE id=$1`, [id])).rows[0]

describe('month close, against the database', () => {
  it('a full target month zeroes the invoice and settles the rent row', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-15', 80)

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)

    const inv = await invoiceOf(s.invoiceId)
    expect(inv.total).toBe(0)
    expect(inv.credit).toBe(500)
    expect(inv.hours).toBe(80)

    const rent = (await db.query(
      `SELECT status, amount::float AS amount, notes FROM payments
        WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])).rows[0]
    expect(rent.status).toBe('settled')
    expect(rent.amount).toBe(0)
    expect(rent.notes).toContain('work-trade')
  })

  // Nic's example: 80-hour agreement, 60 worked, 20 hours carry forward.
  it('a short month leaves the balance owing and the period open', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)

    await runWorkTradeSettlement('2026-09-01')

    const inv = await invoiceOf(s.invoiceId)
    expect(inv.credit).toBe(375)          // 60 × $6.25
    expect(inv.total).toBe(125)           // the 20 unworked hours
    const st = (await db.query(
      `SELECT status, hours_applied::float AS applied, hours_worked::float AS worked
         FROM work_trade_settlements WHERE agreement_id=$1`, [s.agreementId])).rows[0]
    expect(st.status).toBe('open')
    expect(st.applied).toBe(60)
    expect(st.worked).toBe(60)
  })

  // The guard that matters most on a money job: a re-run must not pay twice.
  it('is idempotent — a second run credits nothing further', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-15', 80)

    await runWorkTradeSettlement('2026-09-01')
    const first = await invoiceOf(s.invoiceId)
    await runWorkTradeSettlement('2026-09-01')
    const second = await invoiceOf(s.invoiceId)

    expect(second).toEqual(first)
  })

  it('an agreement with no logged hours credits nothing and stays open', async () => {
    const s = await buildStack()
    await runWorkTradeSettlement('2026-09-01')
    const inv = await invoiceOf(s.invoiceId)
    expect(inv.credit).toBe(0)
    expect(inv.total).toBe(500)
  })
})

describe('the landlord ends the agreement', () => {
  it('bills the uncompleted hours immediately as a payable carried balance', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(1)

    const charge = (await db.query(
      `SELECT type, amount::float AS amount, status, notes FROM payments
        WHERE lease_id=$1 AND type='carried_balance'`, [s.leaseId])).rows[0]
    expect(charge).toBeTruthy()
    expect(charge.amount).toBe(125)       // 20 hours at September's $6.25
    expect(charge.status).toBe('pending')
    expect(charge.notes).toContain('September 2026')

    const ag = (await db.query(
      `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0]
    expect(ag.status).toBe('ended')
  })

  it('spends banked hours before billing anything', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await db.query(`UPDATE work_trade_agreements SET banked_hours=20 WHERE id=$1`,
      [s.agreementId])

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.periodsBilled).toBe(0)
    const charge = await db.query(
      `SELECT 1 FROM payments WHERE lease_id=$1 AND type='carried_balance'`, [s.leaseId])
    expect(charge.rowCount).toBe(0)
    const inv = await invoiceOf(s.invoiceId)
    expect(inv.total).toBe(0)
  })
})

// The figures the tenant reads on their next invoice have to come out of the
// SAME ledger the settlement wrote, or the two will disagree in front of them.
describe('what the tenant is told next month', () => {
  it('states this month’s hours and the hours carried, from the real ledger', async () => {
    const s = await buildStack()                       // September, 80h target
    await logHours(s, '2026-09-10', 60)                // 20 short
    await runWorkTradeSettlement('2026-09-01')

    // October's invoice opens its own period.
    const client = await getClient()
    try {
      const inv = await client.query(
        `INSERT INTO invoices
           (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
            subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
         VALUES ($1,$2,$3,$4,$5,'2026-10-01',500,500,$6,TRUE) RETURNING id`,
        [s.landlordId, s.tenantId, s.leaseId, s.unitId, `WT-OCT-${randomUUID().slice(0, 6)}`,
         s.agreementId])
      await client.query(
        `INSERT INTO work_trade_settlements
           (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
         VALUES ($1,$2,'2026-10-01',80,$3,500)`,
        [s.agreementId, inv.rows[0].id, hourRateFor(500, 80).toFixed(4)])
    } finally { client.release() }

    const standing = await loadWorkTradeStanding(s.agreementId, '2026-10-01')
    expect(standing).toBeTruthy()
    expect(standing!.currentMonthHours).toBe(80)
    expect(standing!.carriedHours).toBe(20)
    expect(standing!.catchUpHours).toBe(100)      // Nic's example, end to end
    expect(standing!.carriedValue).toBe(125)
    expect(standing!.summary).toContain('100 hours in total')
  })

  it('reports a covered month as covered', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 80)
    await runWorkTradeSettlement('2026-09-01')
    const standing = await loadWorkTradeStanding(s.agreementId, '2026-09-01')
    // The period settled, so nothing is open and nothing is owed.
    expect(standing!.catchUpHours).toBe(0)
    expect(standing!.carriedHours).toBe(0)
  })
})
