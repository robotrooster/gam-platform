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
import { runWorkTradeSettlement, settleAgreementOnEnd, runDueWorkTradeSettlements } from './workTradeSettlement'
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
  periodMonth?: string; suspended?: boolean; tracksHours?: boolean
  /** S648: a due-date period instead of the calendar month. */
  periodStart?: string; periodEnd?: string
} = {}): Promise<Stack> {
  // S643: `target` is what the PERIOD asks for. The agreement's own
  // monthly_hours_target must stay positive (DB check) even when the landlord
  // does not clock the trade — tracks_hours is the switch that zeroes the
  // period, exactly as moveInBundle/loadWorkTradeCreditContext do it.
  const target = opts.target ?? 80
  const agreementTarget = opts.target && opts.target > 0 ? opts.target : 80
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
          monthly_hours_target, carry_forward_months, tracks_hours)
       VALUES ($1,$2,$3,'2026-08-01','active',$4,$5,$6) RETURNING id`,
      [unitId, tenantId, landlordId, agreementTarget, opts.carryForwardMonths ?? 1,
       opts.tracksHours !== false])
    const agreementId = ag.rows[0].id

    const inv = await client.query(
      `INSERT INTO invoices
         (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
          subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,$8,TRUE) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `WT-${randomUUID().slice(0, 8)}`, periodMonth,
       basis.toFixed(2), agreementId])
    const invoiceId = inv.rows[0].id
    // A `suspended` stack is the S634 shape: the line is excluded from
    // total_amount until the month closes, so the total starts at zero.
    if (opts.suspended) {
      await client.query(`UPDATE invoices SET total_amount = 0 WHERE id = $1`, [invoiceId])
    }

    await client.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending',$7::date,'RENT',
               CASE WHEN $8::boolean THEN NOW() ELSE NULL END)`,
      [invoiceId, unitId, leaseId, tenantId, landlordId, basis.toFixed(2), periodMonth,
       opts.suspended === true])

    await client.query(
      `INSERT INTO work_trade_settlements
         (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount,
          period_start, period_end)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7::date,$8::date)`,
      [agreementId, invoiceId, periodMonth, target.toFixed(2),
       hourRateFor(basis, target).toFixed(4), basis.toFixed(2),
       opts.periodStart ?? null, opts.periodEnd ?? null])

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
    // S652 (Nic): "let's count work trade as on time" — the credit history says so.
    const ev = (await db.query(
      `SELECT ce.event_type, ce.attestation_source FROM credit_events ce
        WHERE ce.event_data->>'payment_id' = (SELECT id::text FROM payments WHERE invoice_id=$1 AND type='rent')`, [s.invoiceId])).rows
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('payment_received_on_time')
    expect(ev[0].attestation_source).toBe('gam_workflow_auto')
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

// S643 — Nic runs two agreements (MH 02, MH 10) with tracks_hours = false: the
// landlord does not log hours, the trade just covers the rent. Those open with
// target_hours = 0, and the job used to gate crediting on HOURS WORKED, which
// those can never have. The period closed as `settled` with the whole basis
// recorded as credited while the rent row sat `pending` at full price with the
// suspension still on it — a charge that would never clear and never be paid.
describe('a trade the landlord does not clock', () => {
  it('zeroes the bill even though nobody logged an hour', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)

    const rent = (await db.query(
      `SELECT status, amount::float AS amount, work_trade_suspended_at
         FROM payments WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])).rows[0]
    expect(rent.status).toBe('settled')
    expect(rent.amount).toBe(0)
    expect(rent.work_trade_suspended_at).toBeNull()

    const inv = await invoiceOf(s.invoiceId)
    expect(inv.total).toBe(0)
    expect(inv.credit).toBe(460)

    // What the books say and what the tenant owes have to be the same number.
    const st = (await db.query(
      `SELECT status, credit_applied::float AS credit
         FROM work_trade_settlements WHERE agreement_id=$1`, [s.agreementId])).rows[0]
    expect(st.status).toBe('settled')
    expect(st.credit).toBe(460)
  })

  it('does not pay for the month twice when the job re-runs', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await runWorkTradeSettlement('2026-09-01')
    await runWorkTradeSettlement('2026-09-01')

    const inv = await invoiceOf(s.invoiceId)
    expect(inv.total).toBe(0)
    expect(inv.credit).toBe(460)
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


// ── S648 (Nic): "work trade settlement for anniversary tenants should count
// from each tenant's own due date." A tenant due on the 15th works the 15th to
// the 14th; that period closes the day after it ends, once.
describe('S648 due-date periods', () => {
  const due15 = { periodMonth: '2026-09-01', periodStart: '2026-09-15', periodEnd: '2026-10-14' }

  it('counts only hours inside the period and closes the day after it ends', async () => {
    const s = await buildStack(due15)
    await logHours(s, '2026-09-10', 30)   // before the period — not this one's
    await logHours(s, '2026-09-20', 50)
    await logHours(s, '2026-10-14', 30)
    await logHours(s, '2026-10-15', 40)   // the next period's

    const early = await runDueWorkTradeSettlements('2026-10-14')
    expect(early.agreementsProcessed).toBe(0)   // not over yet

    const r = await runDueWorkTradeSettlements('2026-10-15')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)
    const st = (await db.query(
      `SELECT status, hours_worked::float AS worked FROM work_trade_settlements WHERE agreement_id=$1`,
      [s.agreementId])).rows[0]
    expect(st.status).toBe('settled')
    expect(st.worked).toBe(80)
    expect((await invoiceOf(s.invoiceId)).total).toBe(0)
  })

  it('a short period stays open to catch up but is never counted twice', async () => {
    const s = await buildStack(due15)
    await logHours(s, '2026-09-20', 60)
    await runDueWorkTradeSettlements('2026-10-15')
    await runDueWorkTradeSettlements('2026-10-16')
    await runDueWorkTradeSettlements('2026-11-20')
    const inv = await invoiceOf(s.invoiceId)
    expect(inv.credit).toBe(375)       // 60 × $6.25, once
    expect(inv.total).toBe(125)
  })

  it('the calendar close leaves a due-date tenant alone, and the due-date close leaves calendar tenants alone', async () => {
    const dated = await buildStack(due15)
    const calendar = await buildStack()
    await logHours(dated, '2026-09-20', 80)
    await logHours(calendar, '2026-09-20', 80)

    await runWorkTradeSettlement('2026-09-01')
    expect((await invoiceOf(dated.invoiceId)).credit).toBe(0)
    expect((await invoiceOf(calendar.invoiceId)).credit).toBe(500)

    await runDueWorkTradeSettlements('2026-10-15')
    expect((await invoiceOf(dated.invoiceId)).credit).toBe(500)
    expect((await invoiceOf(calendar.invoiceId)).credit).toBe(500)
  })
})

// S648: an older period carried into a later close keeps the hours it was
// closed with. They used to be overwritten with 0.
describe('carried periods keep their hours', () => {
  it('a later close does not zero an earlier month\'s hours worked', async () => {
    const s = await buildStack({ carryForwardMonths: 3 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await runWorkTradeSettlement('2026-10-01')
    const st = (await db.query(
      `SELECT hours_worked::float AS worked FROM work_trade_settlements
        WHERE agreement_id=$1 AND period_month='2026-09-01'`, [s.agreementId])).rows[0]
    expect(st.worked).toBe(60)
  })
})
