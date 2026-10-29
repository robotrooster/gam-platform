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
import { loadWorkTradeStanding, hoursCountedFor } from '../services/workTradeStanding'
import { listOpenTenantBalances, workTradeOpenRowSql } from '../services/openBalances'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

// 10/12: the extra-hours columns/table, until they reach schema.sql.
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

/** S654: what the tenant is asked to pay on this lease — the portal's own filter. */
const openOnLease = async (leaseId: string) => Number((await db.query(
  `SELECT COALESCE(SUM(amount), 0)::float AS owed FROM payments
    WHERE lease_id = $1 AND work_trade_suspended_at IS NULL
      AND ((status = 'pending' AND stripe_payment_intent_id IS NULL) OR status = 'failed')`,
  [leaseId])).rows[0].owed)

/** S654: what the landlord's Balances page says this tenant owes. */
const balancesPageOwed = async (s: Stack) => {
  const rows = await listOpenTenantBalances({ landlordIds: [s.landlordId] })
  return Number(rows.find(r => r.tenant_id === s.tenantId)?.balance ?? 0)
}

const carriedRows = async (leaseId: string) => (await db.query(
  `SELECT amount::float AS amount FROM payments WHERE lease_id=$1 AND type='carried_balance'`,
  [leaseId])).rows

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
    // 10/12 (Nic): "one mark per invoice" — the bill's one mark, derived from its records.
    const ev = (await db.query(
      `SELECT ce.event_type, ce.attestation_source, ce.event_data FROM credit_events ce
        WHERE ce.event_data->>'mark_basis' = 'invoice' AND ce.event_data->>'bill_key' = $1::text
          AND ce.superseded_by IS NULL`, [s.invoiceId])).rows
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('payment_received_on_time')
    expect(ev[0].attestation_source).toBe('system_derived')
    expect(ev[0].event_data).toMatchObject({ work_trade: '500.00', stamp: 'paid_on_time' })
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

  // S654: the trade is between tenant and landlord; GAM's own fee is not its to cover.
  it('never lands the credit on a fee GAM keeps', async () => {
    const s = await buildStack()
    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW() WHERE invoice_id=$1 AND type='rent'`,
      [s.invoiceId])
    await db.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,$5,'fee',1,'pending','2026-09-01','DECLINEFEE','gam')`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])
    await logHours(s, '2026-09-15', 80)

    await runWorkTradeSettlement('2026-09-01')
    const fee = (await db.query(
      `SELECT amount::float AS amount, status FROM payments
        WHERE invoice_id=$1 AND entry_description='DECLINEFEE'`, [s.invoiceId])).rows[0]
    expect(fee).toEqual({ amount: 1, status: 'pending' })
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
  // S654: the September close already left the 20 missed hours ($125) on the
  // rent row. Ending used to add a $125 carried balance as well — $250 owed
  // for $125 of missed hours.
  for (const suspended of [false, true]) {
    it(`bills the uncompleted hours once, on the month's own bill${suspended ? ' (suspended line)' : ''}`, async () => {
      const s = await buildStack({ suspended })
      await logHours(s, '2026-09-10', 60)
      await runWorkTradeSettlement('2026-09-01')

      const r = await settleAgreementOnEnd(s.agreementId)
      expect(r.errors).toEqual([])
      expect(r.periodsBilled).toBe(1)

      // 20 hours at September's $6.25, owed exactly once, everywhere.
      expect(await openOnLease(s.leaseId)).toBe(125)
      expect(await balancesPageOwed(s)).toBe(125)
      expect(await carriedRows(s.leaseId)).toEqual([])
      expect((await invoiceOf(s.invoiceId)).total).toBe(125)

      const rent = (await db.query(
        `SELECT amount::float AS amount, status, notes FROM payments
          WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])).rows[0]
      expect(rent.amount).toBe(125)
      expect(rent.status).toBe('pending')
      expect(rent.notes).toContain('September 2026')

      const st = (await db.query(
        `SELECT status, billed_at FROM work_trade_settlements WHERE agreement_id=$1`,
        [s.agreementId])).rows[0]
      expect(st.status).toBe('billed')
      expect(st.billed_at).not.toBeNull()

      const ag = (await db.query(
        `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0]
      expect(ag.status).toBe('ended')
    })
  }

  it('a month that never closed has its lapse lifted onto its own bill, once', async () => {
    // Ended mid-month: the line is still suspended (outside the total), so
    // without lifting it the lapse would be owed nowhere.
    const s = await buildStack({ suspended: true })
    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(1)

    expect(await openOnLease(s.leaseId)).toBe(500)
    expect(await balancesPageOwed(s)).toBe(500)
    expect(await carriedRows(s.leaseId)).toEqual([])
    const rent = (await db.query(
      `SELECT work_trade_suspended_at FROM payments WHERE invoice_id=$1 AND type='rent'`,
      [s.invoiceId])).rows[0]
    expect(rent.work_trade_suspended_at).toBeNull()
  })

  it('a charge the trade does not cover stays owed beside the lapse, unexplained by it', async () => {
    // The live shape: rent covered and suspended, a utility not covered and owed.
    const s = await buildStack({ target: 25, basis: 450, suspended: true })
    await db.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'utility',110.55,'pending','2026-09-01','UTILITY')`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])
    await db.query(`UPDATE invoices SET total_amount=110.55 WHERE id=$1`, [s.invoiceId])
    await logHours(s, '2026-09-10', 20)
    await runWorkTradeSettlement('2026-09-01')     // 5 of 25 hours short: $90

    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(200.55)
    expect(await balancesPageOwed(s)).toBe(200.55)
    expect(await carriedRows(s.leaseId)).toEqual([])
    const rows = (await db.query(
      `SELECT type, amount::float AS amount, notes FROM payments
        WHERE invoice_id=$1 ORDER BY type`, [s.invoiceId])).rows
    expect(rows.find(r => r.type === 'rent')).toMatchObject({ amount: 90 })
    expect(rows.find(r => r.type === 'rent').notes).toContain('September 2026')
    expect(rows.find(r => r.type === 'utility').notes).toBeNull()
  })

  // S654: hours approved in the month being ended in were never counted.
  it('ended mid-month: the hours worked that month count, only the rest is billed', async () => {
    const s = await buildStack({ suspended: true })
    await logHours(s, '2026-09-10', 70)
    await settleAgreementOnEnd(s.agreementId)

    expect(await openOnLease(s.leaseId)).toBe(62.5)          // 10 hours short
    expect(await balancesPageOwed(s)).toBe(62.5)
    expect(await carriedRows(s.leaseId)).toEqual([])
    const st = (await db.query(
      `SELECT status, hours_worked::float AS worked, hours_applied::float AS applied
         FROM work_trade_settlements WHERE agreement_id=$1`, [s.agreementId])).rows[0]
    expect(st).toEqual({ status: 'billed', worked: 70, applied: 70 })
  })

  it('an approval that landed after the close counts once, at the end', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await logHours(s, '2026-09-28', 10)                       // approved late

    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(62.5)
    expect((await invoiceOf(s.invoiceId)).credit).toBe(437.5) // 70 hours, once
  })

  it('a shortfall the tenant already paid is not billed again', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW()
        WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])

    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  it('a period with no bill of its own is billed as a carried balance', async () => {
    // The one case the shortfall is not already on an invoice.
    const s = await buildStack()
    await db.query(`UPDATE work_trade_settlements SET invoice_id=NULL WHERE agreement_id=$1`, [s.agreementId])
    await db.query(`DELETE FROM payments WHERE invoice_id=$1`, [s.invoiceId])
    await db.query(`DELETE FROM invoices WHERE id=$1`, [s.invoiceId])
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')

    await settleAgreementOnEnd(s.agreementId)
    const carried = await carriedRows(s.leaseId)
    expect(carried).toEqual([{ amount: 125 }])
    expect(await openOnLease(s.leaseId)).toBe(125)
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

/** S654: open another month's bill and its period on an existing stack. */
async function addPeriod(
  s: Stack, periodMonth: string, basis = 500, target = 80,
  dates: { start: string; end: string } | null = null,
): Promise<string> {
  const client = await getClient()
  try {
    const inv = await client.query(
      `INSERT INTO invoices
         (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
          subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,$8,TRUE) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, `WT-${randomUUID().slice(0, 8)}`,
       periodMonth, basis.toFixed(2), s.agreementId])
    const invoiceId = inv.rows[0].id
    await client.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending',$7::date,'RENT')`,
      [invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId, basis.toFixed(2), periodMonth])
    await client.query(
      `INSERT INTO work_trade_settlements
         (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount,
          period_start, period_end)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7::date,$8::date)`,
      [s.agreementId, invoiceId, periodMonth, target.toFixed(2),
       hourRateFor(basis, target).toFixed(4), basis.toFixed(2),
       dates?.start ?? null, dates?.end ?? null])
    return invoiceId
  } finally { client.release() }
}

/**
 * Another month on the same agreement, written the way the monthly run writes a
 * covered one (S634): the line is suspended, so the bill total starts at zero.
 */
async function addSuspendedPeriod(
  s: Stack, periodMonth: string, basis = 500, target = 80,
): Promise<string> {
  const invoiceId = await addPeriod(s, periodMonth, basis, target)
  await db.query(
    `UPDATE payments SET work_trade_suspended_at = NOW() WHERE invoice_id = $1 AND type = 'rent'`,
    [invoiceId])
  await db.query(`UPDATE invoices SET total_amount = 0 WHERE id = $1`, [invoiceId])
  return invoiceId
}

const periodOf = async (s: Stack, periodMonth: string) => (await db.query(
  `SELECT status, hours_worked::float AS worked, hours_applied::float AS applied,
          credit_applied::float AS credit
     FROM work_trade_settlements WHERE agreement_id=$1 AND period_month=$2::date`,
  [s.agreementId, periodMonth])).rows[0]

// S654: the month close re-runs in practice (a manual run after the 2:15 cron).
// It used to recount the whole month against a period still open, so a short
// month was credited twice and the landlord under-billed.
describe('running the same month close again', () => {
  it('a short month closed twice counts its hours once', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)                 // 20 of 80 short

    await runWorkTradeSettlement('2026-09-01')
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(0)

    const inv = await invoiceOf(s.invoiceId)
    expect(inv).toEqual({ total: 125, credit: 375, hours: 60 })
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 60, applied: 60, credit: 375 })

    // Ending it bills the 20 missed hours, not $0.
    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(125)
    expect(await balancesPageOwed(s)).toBe(125)
  })

  it('an approval that lands between two closes counts once, at the second', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await logHours(s, '2026-09-28', 10)                 // approved after the first run

    await runWorkTradeSettlement('2026-09-01')
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 62.5, credit: 437.5, hours: 70 })
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 70, applied: 70, credit: 437.5 })

    await runWorkTradeSettlement('2026-09-01')          // and once more: nothing new
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 62.5, credit: 437.5, hours: 70 })

    // The end does not count those 10 hours a second time either.
    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(62.5)
    expect((await invoiceOf(s.invoiceId)).credit).toBe(437.5)
  })

  it('a month that already settled does not hand its surplus to an older month again', async () => {
    const s = await buildStack({ periodMonth: '2026-08-01', carryForwardMonths: 3 })
    await logHours(s, '2026-08-10', 40)                 // August 40 of 80
    await runWorkTradeSettlement('2026-08-01')
    await addPeriod(s, '2026-09-01')
    await logHours(s, '2026-09-10', 100)                // September 80, plus 20 for August

    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-08-01')).toMatchObject({ status: 'open', applied: 60 })
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', worked: 100 })

    // September is settled, so August stands in on a re-run — with no new hours.
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-08-01')).toMatchObject({ status: 'open', applied: 60, credit: 375 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 125, credit: 375, hours: 60 })

    // A late September approval is new surplus: it reaches August once.
    await logHours(s, '2026-09-29', 10)
    await runWorkTradeSettlement('2026-09-01')
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-08-01')).toMatchObject({ status: 'open', applied: 70, credit: 437.5 })
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', worked: 110 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 62.5, credit: 437.5, hours: 70 })
  })

  // S654 (Nic): his own trades are tracks_hours = false. A re-run is how a
  // September period the cron left open gets settled, so it must still work.
  it('an untracked trade: the re-run settles the month and counts none of its logged hours', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await logHours(s, '2026-09-10', 12)                 // logged anyway
    // The prod shape: the cron already stamped the close but left it open.
    await db.query(`UPDATE work_trade_settlements SET close_run_at = NOW() WHERE agreement_id=$1`,
      [s.agreementId])

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)
    // 10/18: `worked` is 0 where it used to be 12. A trade the landlord does
    // not clock counts no hours at all (countsHours), so the 12 are neither
    // recorded against the month nor banked — they used to BANK, which turned
    // hours on a trade that asks for none into credit toward future months.
    // Leaving them unrecorded also keeps them available: turning tracking back
    // on counts them fresh instead of finding them already spent.
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    expect(Number((await db.query(
      `SELECT banked_hours::float AS b FROM work_trade_agreements WHERE id=$1`,
      [s.agreementId])).rows[0].b)).toBe(0)
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 0, credit: 460, hours: 0 })
    expect(await openOnLease(s.leaseId)).toBe(0)

    const snapshot = async () => ({
      payments: (await db.query(
        `SELECT id, amount::float AS amount, status, notes, work_trade_suspended_at
           FROM payments WHERE lease_id=$1 ORDER BY id`, [s.leaseId])).rows,
      period: await periodOf(s, '2026-09-01'),
      invoice: await invoiceOf(s.invoiceId),
      banked: (await db.query(`SELECT banked_hours::float AS b FROM work_trade_agreements WHERE id=$1`,
        [s.agreementId])).rows[0].b,
    })
    const before = await snapshot()
    const again = await runWorkTradeSettlement('2026-09-01')
    expect(again.errors).toEqual([])
    expect(again.agreementsProcessed).toBe(0)
    expect(await snapshot()).toEqual(before)
  })
})

// ── S654: APPROVALS THAT LAND AFTER A MONTH HAS CLOSED ──────────────────────
//
// The cron closes a month at 2:15am on the 1st, so the last days' hours are
// approved after it nearly every month. Round 7, reproduced: carry 0, 60 of 80
// September hours, September closed; 20 hours dated Sept 30 approved, October
// worked in full. The October close billed September $125 and ended the
// agreement, with 80 September hours approved. Only a manual re-run of
// September, or the agreement's end, ever counted them.
describe('approvals that land after their month closed', () => {
  const banked = async (s: Stack) => Number((await db.query(
    `SELECT banked_hours::float AS b FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].b)
  const agreementStatus = async (s: Stack) => (await db.query(
    `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].status

  it("count at the next month's close: September's shortfall shrinks, once", async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    const oct = await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 10)                 // approved after September closed
    await logHours(s, '2026-10-10', 80)

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 70, applied: 70, credit: 437.5 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 62.5, credit: 437.5, hours: 70 })
    expect(await periodOf(s, '2026-10-01')).toMatchObject({ status: 'settled', worked: 80, applied: 80 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await banked(s)).toBe(0)

    // Nothing is counted twice: not by re-running either month, nor at the end.
    const snapshot = async () => ({
      sep: await periodOf(s, '2026-09-01'), oct: await periodOf(s, '2026-10-01'),
      sepInv: await invoiceOf(s.invoiceId), octInv: await invoiceOf(oct), bank: await banked(s),
    })
    const before = await snapshot()
    await runWorkTradeSettlement('2026-10-01')
    await runWorkTradeSettlement('2026-09-01')
    expect(await snapshot()).toEqual(before)

    await settleAgreementOnEnd(s.agreementId)
    expect(await openOnLease(s.leaseId)).toBe(62.5)     // the 10 hours still missing, once
    expect(await balancesPageOwed(s)).toBe(62.5)
    expect((await invoiceOf(s.invoiceId)).credit).toBe(437.5)
  })

  it('land before an aged-out month is billed: caught up, nothing billed, the trade goes on', async () => {
    const s = await buildStack({ carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 20)
    await logHours(s, '2026-10-10', 80)

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(r.agreementsEnded).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 80, applied: 80, credit: 500 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
    expect(await agreementStatus(s)).toBe('active')
  })

  it('more late hours than the month was short: its own period first, the rest to the bank', async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    const oct = await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 30)                 // 20 owed to September, 10 spare
    await logHours(s, '2026-10-10', 75)                 // October 5 short

    await runWorkTradeSettlement('2026-10-01')
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 90, applied: 80, credit: 500 })
    // The 10 spare hours banked; October drew the 5 it was short.
    expect(await periodOf(s, '2026-10-01')).toMatchObject({ status: 'settled', worked: 75, applied: 80 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await banked(s)).toBe(5)

    await runWorkTradeSettlement('2026-10-01')
    expect(await banked(s)).toBe(5)
  })

  it("a late approval for a month that was counted by a re-run is not counted again", async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await logHours(s, '2026-09-30', 10)
    await runWorkTradeSettlement('2026-09-01')          // the manual re-run counts it
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ worked: 70, applied: 70 })

    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-10-10', 80)
    await runWorkTradeSettlement('2026-10-01')
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 70, applied: 70, credit: 437.5 })
    expect(await banked(s)).toBe(0)
  })

  // S654 (Nic): his own trades are tracks_hours = false: no hours, every month
  // covered. Hours logged on one anyway never become banked time.
  it("an untracked trade: October's close settles September too and banks neither month's hours", async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await logHours(s, '2026-09-10', 12)
    // The prod shape: the cron stamped September's close and left it open.
    await db.query(`UPDATE work_trade_settlements SET close_run_at = NOW() WHERE agreement_id=$1`,
      [s.agreementId])
    const oct = await addPeriod(s, '2026-10-01', 460, 0)
    await logHours(s, '2026-09-29', 5)                  // "late", for a trade that asks for none

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    expect(await periodOf(s, '2026-10-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 0, credit: 460, hours: 0 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 460, hours: 0 })
    expect(await banked(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await agreementStatus(s)).toBe('active')
  })

  it('a due-date period: a late approval inside its dates reaches it at the next close', async () => {
    const s = await buildStack({ periodMonth: '2026-09-01', periodStart: '2026-09-15', periodEnd: '2026-10-14',
      carryForwardMonths: 1 })
    await logHours(s, '2026-09-20', 60)
    await runDueWorkTradeSettlements('2026-10-15')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'open', worked: 60, applied: 60 })

    const next = await addPeriod(s, '2026-10-01', 500, 80, { start: '2026-10-15', end: '2026-11-14' })
    await logHours(s, '2026-10-14', 10)                 // inside September's period, approved late
    await logHours(s, '2026-10-20', 80)

    const r = await runDueWorkTradeSettlements('2026-11-15')
    expect(r.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 70, applied: 70, credit: 437.5 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 62.5, credit: 437.5, hours: 70 })
    expect(await invoiceOf(next)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await banked(s)).toBe(0)
  })
})

// ── S654: APPROVALS THAT LAND AFTER A MONTH HAS SETTLED ─────────────────────
//
// Round 8, reproduced: the 2:15am close on the 1st covers a month (from the
// bank, or because it was already worked in full), the month settles, and the
// last days' hours are approved hours later. They were never counted: no
// close, re-run or ending looked at a settled month again. Bank 20, September
// 60 of 80 at its close, 20 more September hours approved, October 60 of 80:
// October owed $125 with 160 hours approved or banked against 160 asked.
describe('approvals that land after their month settled', () => {
  const banked = async (s: Stack) => Number((await db.query(
    `SELECT banked_hours::float AS b FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].b)
  const agreementStatus = async (s: Stack) => (await db.query(
    `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].status

  it('a month the bank covered: its late hours reach the bank at the next close', async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await db.query(`UPDATE work_trade_agreements SET banked_hours = 20 WHERE id=$1`, [s.agreementId])
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')          // the bank covers September's 20
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 60, applied: 80, credit: 500 })
    expect(await banked(s)).toBe(0)

    const oct = await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 20)                 // approved after September settled
    await logHours(s, '2026-10-10', 60)                 // October 20 short

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 80, applied: 80, credit: 500 })
    expect(await periodOf(s, '2026-10-01')).toEqual(
      { status: 'settled', worked: 60, applied: 80, credit: 500 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await banked(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)

    // Counted once: re-running either month and ending the trade change nothing.
    const snapshot = async () => ({
      sep: await periodOf(s, '2026-09-01'), oct: await periodOf(s, '2026-10-01'),
      sepInv: await invoiceOf(s.invoiceId), octInv: await invoiceOf(oct), bank: await banked(s),
    })
    const before = await snapshot()
    await runWorkTradeSettlement('2026-10-01')
    await runWorkTradeSettlement('2026-09-01')
    expect(await snapshot()).toEqual(before)
    const end = await settleAgreementOnEnd(s.agreementId)
    expect(end.periodsBilled).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  it('a month worked in full: hours approved past it bank once, and are spent once', async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await logHours(s, '2026-09-10', 80)
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', worked: 80 })

    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 10)                 // approved after September settled
    await logHours(s, '2026-10-10', 80)
    await runWorkTradeSettlement('2026-10-01')
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 90, applied: 80, credit: 500 })
    expect(await periodOf(s, '2026-10-01')).toMatchObject({ status: 'settled', worked: 80, applied: 80 })
    expect(await banked(s)).toBe(10)

    // November is 10 short: the bank covers it, and September adds nothing again.
    const nov = await addPeriod(s, '2026-11-01')
    await logHours(s, '2026-11-10', 70)
    await runWorkTradeSettlement('2026-11-01')
    expect(await periodOf(s, '2026-11-01')).toEqual(
      { status: 'settled', worked: 70, applied: 80, credit: 500 })
    expect(await invoiceOf(nov)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ worked: 90 })
    expect(await banked(s)).toBe(0)
  })

  it('a due-date period: late hours inside its dates bank at the next close', async () => {
    const s = await buildStack({ periodMonth: '2026-09-01', periodStart: '2026-09-15', periodEnd: '2026-10-14',
      carryForwardMonths: 1 })
    await logHours(s, '2026-09-20', 80)
    await runDueWorkTradeSettlements('2026-10-15')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', worked: 80 })

    const next = await addPeriod(s, '2026-10-01', 500, 80, { start: '2026-10-15', end: '2026-11-14' })
    await logHours(s, '2026-10-14', 10)                 // inside September's period, approved late
    await logHours(s, '2026-10-20', 70)

    const r = await runDueWorkTradeSettlements('2026-11-15')
    expect(r.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 90, applied: 80, credit: 500 })
    expect(await periodOf(s, '2026-10-01')).toEqual(
      { status: 'settled', worked: 70, applied: 80, credit: 500 })
    expect(await invoiceOf(next)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await banked(s)).toBe(0)
  })

  it('ending the trade counts them too, before anything is billed', async () => {
    const s = await buildStack({ carryForwardMonths: 1 })
    await logHours(s, '2026-09-10', 80)
    await runWorkTradeSettlement('2026-09-01')
    const oct = await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 20)                 // approved after September settled
    await logHours(s, '2026-10-10', 60)                 // ended mid-October, 20 short

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', worked: 100 })
    expect(await periodOf(s, '2026-10-01')).toEqual(
      { status: 'settled', worked: 60, applied: 80, credit: 500 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 500, hours: 80 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  // S654, round 8: a due-date period whose own close failed once has its hours
  // counted as late at the next period's close. Its retried close used to count
  // all of them again: 60 of 80 worked, bank 40, when the tenant is 20 short.
  it('a due-date close that failed once does not count its hours twice when retried', async () => {
    const s = await buildStack({ periodMonth: '2026-09-01', periodStart: '2026-09-15', periodEnd: '2026-10-14',
      carryForwardMonths: 1 })
    const sepId = (await db.query(
      `SELECT id FROM work_trade_settlements WHERE agreement_id=$1`, [s.agreementId])).rows[0].id
    const next = await addPeriod(s, '2026-10-01', 500, 80, { start: '2026-10-15', end: '2026-11-14' })
    await logHours(s, '2026-09-20', 60)
    await logHours(s, '2026-10-20', 80)

    // Test-only: September's close fails once, at its last write.
    await db.query(`
      CREATE OR REPLACE FUNCTION s654_fail_sep_close() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 's654 test: September close fails once'; END $$ LANGUAGE plpgsql`)
    await db.query(`
      CREATE TRIGGER s654_fail_sep_close BEFORE UPDATE ON work_trade_settlements
        FOR EACH ROW WHEN (OLD.id = '${sepId}'::uuid AND NEW.close_run_at IS NOT NULL)
        EXECUTE FUNCTION s654_fail_sep_close()`)
    let first
    try {
      first = await runDueWorkTradeSettlements('2026-11-15')
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS s654_fail_sep_close ON work_trade_settlements`)
      await db.query(`DROP FUNCTION IF EXISTS s654_fail_sep_close()`)
    }
    expect(first.errors).toHaveLength(1)
    // October's close counted September's 60 as late, on September.
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 60, applied: 60, credit: 375 })
    expect(await invoiceOf(next)).toEqual({ total: 0, credit: 500, hours: 80 })

    const retry = await runDueWorkTradeSettlements('2026-11-16')
    expect(retry.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'open', worked: 60, applied: 60, credit: 375 })
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 125, credit: 375, hours: 60 })
    expect(await banked(s)).toBe(0)
  })

  it('a billed month is left alone', async () => {
    // A billed month sits on an agreement that ended; the landlord can set it
    // active again. Its lapse was billed in cash, so late hours do not bank.
    const s = await buildStack({ carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    await settleAgreementOnEnd(s.agreementId)           // September billed $125
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'billed', worked: 60 })
    await db.query(`UPDATE work_trade_agreements SET status='active' WHERE id=$1`, [s.agreementId])

    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-09-30', 20)
    await logHours(s, '2026-10-10', 80)
    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'billed', worked: 60 })
    expect(await banked(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(125)      // September's lapse, unchanged
  })

  // S654 (Nic): his own trades are tracks_hours = false. A settled month that
  // asks for no hours never banks hours logged on it anyway.
  it('an untracked trade: hours approved after a settled month never reach the bank', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    const oct = await addPeriod(s, '2026-10-01', 460, 0)
    await logHours(s, '2026-09-29', 5)                  // "late", for a trade that asks for none

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    expect(await periodOf(s, '2026-10-01')).toEqual(
      { status: 'settled', worked: 0, applied: 0, credit: 460 })
    expect(await invoiceOf(oct)).toEqual({ total: 0, credit: 460, hours: 0 })
    expect(await banked(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await agreementStatus(s)).toBe('active')

    const end = await settleAgreementOnEnd(s.agreementId)
    expect(end.periodsBilled).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ worked: 0 })
    expect(await openOnLease(s.leaseId)).toBe(0)
  })
})

// S654: a deficit that outlives the landlord's window is billed by the month
// close itself, through the same path — and was doubled the same way.
describe('a deficit that ages out at a month close', () => {
  it('is owed once, on the month it belongs to', async () => {
    const s = await buildStack({ carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')

    // October's bill opens its own period; October is worked in full.
    const client = await getClient()
    let octInvoiceId: string
    try {
      const inv = await client.query(
        `INSERT INTO invoices
           (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
            subtotal_rent, total_amount, work_trade_agreement_id, late_fee_exempt)
         VALUES ($1,$2,$3,$4,$5,'2026-10-01',500,500,$6,TRUE) RETURNING id`,
        [s.landlordId, s.tenantId, s.leaseId, s.unitId, `WT-OCT-${randomUUID().slice(0, 6)}`,
         s.agreementId])
      octInvoiceId = inv.rows[0].id
      await client.query(
        `INSERT INTO payments
           (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
            status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',500,'pending','2026-10-01','RENT')`,
        [octInvoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])
      await client.query(
        `INSERT INTO work_trade_settlements
           (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount,
            period_start, period_end)
         VALUES ($1,$2,'2026-10-01',80,$3,500,'2026-10-01','2026-10-31')`,
        [s.agreementId, octInvoiceId, hourRateFor(500, 80).toFixed(4)])
    } finally { client.release() }
    await logHours(s, '2026-10-10', 80)

    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(1)
    expect(r.agreementsEnded).toBe(1)

    expect(await openOnLease(s.leaseId)).toBe(125)
    expect(await balancesPageOwed(s)).toBe(125)
    expect(await carriedRows(s.leaseId)).toEqual([])
    expect((await invoiceOf(octInvoiceId)).total).toBe(0)
  })
})

// S654 (Nic): his own people are auto-complete — tracks_hours = false, no hours,
// every month covered. Ending one of those must still bill nothing.
describe('ending a trade the landlord does not clock', () => {
  it('after the month closed: nothing owed, nothing added', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await runWorkTradeSettlement('2026-09-01')
    const before = (await db.query(
      `SELECT id, amount::float AS amount, status, notes, work_trade_suspended_at
         FROM payments WHERE lease_id=$1 ORDER BY id`, [s.leaseId])).rows

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)

    const after = (await db.query(
      `SELECT id, amount::float AS amount, status, notes, work_trade_suspended_at
         FROM payments WHERE lease_id=$1 ORDER BY id`, [s.leaseId])).rows
    expect(after).toEqual(before)
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await balancesPageOwed(s)).toBe(0)
    expect((await invoiceOf(s.invoiceId)).total).toBe(0)
  })

  it('before the month closed: the month is covered, nothing billed', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await logHours(s, '2026-09-10', 12)        // logged anyway; still counts for nothing

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(r.periodsBilled).toBe(0)
    expect(r.periodsSettled).toBe(1)

    const rent = (await db.query(
      `SELECT status, amount::float AS amount, work_trade_suspended_at
         FROM payments WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])).rows[0]
    expect(rent.status).toBe('settled')
    expect(rent.amount).toBe(0)
    expect(rent.work_trade_suspended_at).toBeNull()
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
    expect((await invoiceOf(s.invoiceId)).total).toBe(0)
    const st = (await db.query(
      `SELECT status, hours_worked::float AS worked, credit_applied::float AS credit
         FROM work_trade_settlements WHERE agreement_id=$1`, [s.agreementId])).rows[0]
    expect(st).toEqual({ status: 'settled', worked: 0, credit: 460 })
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

// ── 10/12 (Nic): extra hours — banked or paid, per agreement ─────────────────
async function setExtraHours(s: Stack, mode: 'bank' | 'pay', rate = 15, method = 'payroll_w2') {
  await db.query(
    `UPDATE work_trade_agreements
        SET extra_hours_mode = $2, extra_hours_rate = $3, extra_hours_pay_method = $4
      WHERE id = $1`, [s.agreementId, mode, rate, method])
}
const payablesOf = async (s: Stack) => (await db.query(
  `SELECT to_char(period_month,'YYYY-MM-DD') AS month, hours::float AS hours, rate::float AS rate,
          amount::float AS amount, pay_method, status
     FROM work_trade_extra_hours WHERE agreement_id = $1 ORDER BY period_start`, [s.agreementId])).rows
const bankedOn = async (s: Stack, periodMonth: string) => Number((await db.query(
  `SELECT extra_hours_banked::float AS h FROM work_trade_settlements
    WHERE agreement_id = $1 AND period_month = $2::date`, [s.agreementId, periodMonth])).rows[0]?.h ?? 0)
const bankOf = async (s: Stack) => Number((await db.query(
  `SELECT banked_hours::float AS h FROM work_trade_agreements WHERE id = $1`, [s.agreementId])).rows[0].h)

describe('extra hours at month close', () => {
  it('bank (the default): extra hours bank, and the close records them on the month', async () => {
    const s = await buildStack()
    await logHours(s, '2026-09-12', 86)
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(await bankOf(s)).toBe(6)
    expect(await bankedOn(s, '2026-09-01')).toBe(6)
    expect(await payablesOf(s)).toEqual([])
  })

  it('pay: extra hours become a payable record at the rate and pay method, and do not bank', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay', 15, 'contractor_1099')
    await logHours(s, '2026-09-12', 86)
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(await payablesOf(s)).toEqual([
      { month: '2026-09-01', hours: 6, rate: 15, amount: 90, pay_method: 'contractor_1099', status: 'unpaid' },
    ])
    expect(await bankOf(s)).toBe(0)
    expect(await bankedOn(s, '2026-09-01')).toBe(0)
    // The month itself is covered in full, as on any agreement.
    expect((await invoiceOf(s.invoiceId)).total).toBe(0)
  })

  it('pay, with a carried shortfall: the shortfall is worked off first, only the rest is paid', async () => {
    const s = await buildStack({ carryForwardMonths: 3 })
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-10', 70)                       // September 10 short
    await runWorkTradeSettlement('2026-09-01')
    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-10-10', 96)                       // 80 + 10 owed + 6 extra
    const r = await runWorkTradeSettlement('2026-10-01')
    expect(r.errors).toEqual([])
    expect((await periodOf(s, '2026-09-01')).status).toBe('settled')
    expect((await periodOf(s, '2026-10-01')).status).toBe('settled')
    const p = await payablesOf(s)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ month: '2026-10-01', hours: 6, amount: 90 })
  })

  it('bank, with a carried shortfall: the same hours bank instead', async () => {
    const s = await buildStack({ carryForwardMonths: 3 })
    await logHours(s, '2026-09-10', 70)
    await runWorkTradeSettlement('2026-09-01')
    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-10-10', 96)
    await runWorkTradeSettlement('2026-10-01')
    expect(await bankOf(s)).toBe(6)
    expect(await bankedOn(s, '2026-10-01')).toBe(6)
    expect(await payablesOf(s)).toEqual([])
  })

  it('a re-run of the same close writes no second record and no more hours', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 86)
    await runWorkTradeSettlement('2026-09-01')
    await runWorkTradeSettlement('2026-09-01')
    expect(await payablesOf(s)).toEqual([
      { month: '2026-09-01', hours: 6, rate: 15, amount: 90, pay_method: 'payroll_w2', status: 'unpaid' },
    ])
  })

  it('hours approved after a settled close are paid at the next close, counted once', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 86)
    await runWorkTradeSettlement('2026-09-01')
    await logHours(s, '2026-09-30', 4)                        // approved after September closed
    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-10-12', 80)
    await runWorkTradeSettlement('2026-10-01')
    await runWorkTradeSettlement('2026-10-01')                // a re-run adds nothing
    expect(await payablesOf(s)).toEqual([
      { month: '2026-09-01', hours: 6, rate: 15, amount: 90, pay_method: 'payroll_w2', status: 'unpaid' },
      { month: '2026-10-01', hours: 4, rate: 15, amount: 60, pay_method: 'payroll_w2', status: 'unpaid' },
    ])
  })

  it('pay: a month with no bill of its own banks its extra hours — a re-run never pays them as wages', async () => {
    // 10/12 review: nothing records what such a month counted, so a re-run
    // counts its approved hours again. Before pay mode that only double-banked;
    // in pay mode the recount became a second wage.
    const s = await buildStack({ carryForwardMonths: 3 })
    await setExtraHours(s, 'pay')
    await runWorkTradeSettlement('2026-09-01')                // September: 80 short
    await logHours(s, '2026-10-10', 50)                       // October: no bill, 50 hours
    await runWorkTradeSettlement('2026-10-01')
    await runWorkTradeSettlement('2026-10-01')                // a manual re-run
    expect(await payablesOf(s)).toEqual([])
  })

  it('a record already paid is never reopened', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 86)
    await runWorkTradeSettlement('2026-09-01')
    await db.query(`UPDATE work_trade_extra_hours SET status='paid', paid_at=NOW(), paid_on=CURRENT_DATE WHERE agreement_id=$1`,
      [s.agreementId])
    await logHours(s, '2026-09-30', 4)
    await addPeriod(s, '2026-10-01')
    await logHours(s, '2026-10-12', 80)
    await runWorkTradeSettlement('2026-10-01')
    const p = await payablesOf(s)
    expect(p.map((x: any) => [x.month, x.hours, x.status])).toEqual([['2026-09-01', 6, 'paid'], ['2026-10-01', 4, 'unpaid']])
  })

  it('an agreement that does not track hours never pays extra hours', async () => {
    const s = await buildStack({ target: 0, tracksHours: false })
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 10)
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(await payablesOf(s)).toEqual([])
  })

  it('ending an agreement that pays extra hours pays the month\'s extra hours', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 85)
    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(await payablesOf(s)).toEqual([
      { month: '2026-09-01', hours: 5, rate: 15, amount: 75, pay_method: 'payroll_w2', status: 'unpaid' },
    ])
  })

  it('the standing shows banked extra hours as hours, and paid ones with rate and amount', async () => {
    const s = await buildStack()
    await setExtraHours(s, 'pay')
    await logHours(s, '2026-09-12', 86)
    await runWorkTradeSettlement('2026-09-01')
    const tenant = await loadWorkTradeStanding(s.agreementId, '2026-10-01', 'tenant')
    expect(tenant!.extraHours).toMatchObject({
      mode: 'pay',
      recent: [{ periodMonth: '2026-09-01', hours: 6, how: 'paid', rate: 15, amount: 90, status: 'unpaid' }],
      summary: '6 extra hours in September × $15.00 = $90.00 — paid separately by your landlord',
    })

    const b = await buildStack()
    await logHours(b, '2026-09-12', 86)
    await runWorkTradeSettlement('2026-09-01')
    const banked = await loadWorkTradeStanding(b.agreementId, '2026-10-01', 'tenant')
    expect(banked!.extraHours!.recent).toEqual([
      { periodMonth: '2026-09-01', hours: 6, how: 'banked', rate: null, amount: null, status: null }])
    expect(banked!.extraHours!.summary).toBe('6 extra hours in September — banked toward future months')
    expect(banked!.extraHours!.summary).not.toMatch(/\$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10/18 (Nic) — A CLOSED MONTH'S WORK TRADE MUST SETTLE AND THEN BE GONE.
//
//   "Work trade is settled if the hours are met. It doesn't say, like, the
//    $7,998.87 of work trade bills need to be zeroed out, because you're
//    counting last month and this month, right? It can still kind of count for
//    the open month, but once we're on to the next month and the old month
//    settles out, like, it disappears. It's gone. It's forgotten. It's work
//    trade is work trade, and it's done and over."
//
// What went wrong in production: the 2:15am close on 10/01 left eight of nine
// September periods open with nothing credited, and their rent sat suspended
// and pending for the whole of October — $4,383.11 of September plus $3,615.76
// of October showing at once. The cause is below: the period froze an hour
// target, the landlord then turned hour-tracking OFF ("my people are auto
// complete work trade until I change it back"), and the close went on reading
// the frozen number instead of the agreement.
// ─────────────────────────────────────────────────────────────────────────────

/** Work-trade money still parked on this tenant, by the one production rule. */
const suspendedWorkTrade = async (s: Stack) => Number((await db.query(
  `SELECT COALESCE(SUM(p.amount), 0)::float AS held FROM payments p
    WHERE p.tenant_id = $1 AND ${workTradeOpenRowSql('p')}`, [s.tenantId])).rows[0].held)

describe('the landlord turns hour-tracking off after a period opened', () => {
  // The exact production shape: agreement says "no hours", the September
  // period still carries the 80 it was opened with.
  it('settles the month at close and leaves nothing pending', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)

    const st = await periodOf(s, '2026-09-01')
    expect(st.status).toBe('settled')
    expect(st.credit).toBe(460)

    const rent = (await db.query(
      `SELECT status, amount::float AS amount, work_trade_suspended_at,
              work_trade_credit::float AS wt
         FROM payments WHERE invoice_id=$1 AND type='rent'`, [s.invoiceId])).rows[0]
    expect(rent.status).toBe('settled')
    expect(rent.amount).toBe(0)
    expect(rent.work_trade_suspended_at).toBeNull()
    // The books read this column (ledgerProjectors/tenantCredits C5): with no
    // credit written, 'left_out' has nothing to debit back and September's
    // income stands uncovered.
    expect(rent.wt).toBe(460)

    const inv = await invoiceOf(s.invoiceId)
    expect(inv.total).toBe(0)
    expect(inv.credit).toBe(460)
  })

  it('is gone from every owed figure, and the open month is not', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })
    await addSuspendedPeriod(s, '2026-10-01', 460)

    // Before the close both months are parked — Nic's "counting last month and
    // this month".
    expect(await suspendedWorkTrade(s)).toBe(920)

    await runWorkTradeSettlement('2026-09-01')

    // September is forgotten; October is still the open month.
    expect(await suspendedWorkTrade(s)).toBe(460)
    expect(await balancesPageOwed(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)
  })

  it('does not credit the month twice when the close re-runs', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })
    await runWorkTradeSettlement('2026-09-01')
    const first = await invoiceOf(s.invoiceId)
    await runWorkTradeSettlement('2026-09-01')
    expect(await invoiceOf(s.invoiceId)).toEqual(first)
    expect((await periodOf(s, '2026-09-01')).credit).toBe(460)
  })

  // The half that must NOT change: an agreement that does count hours.
  it('still settles a tracked month only when the hours are met', async () => {
    const met = await buildStack({ basis: 500, suspended: true })
    await logHours(met, '2026-09-15', 80)
    await runWorkTradeSettlement('2026-09-01')
    expect((await periodOf(met, '2026-09-01')).status).toBe('settled')
    expect(await suspendedWorkTrade(met)).toBe(0)
    expect(await openOnLease(met.leaseId)).toBe(0)

    const short = await buildStack({ basis: 500, suspended: true })
    await logHours(short, '2026-09-10', 60)
    await runWorkTradeSettlement('2026-09-01')
    const st = await periodOf(short, '2026-09-01')
    expect(st.status).toBe('open')          // 20 hours carry forward
    expect(st.credit).toBe(375)
    expect(await openOnLease(short.leaseId)).toBe(125)   // the lapse, owed once
  })

  // A trade that asks no hours has no hours to bank or be paid for, whichever
  // way the period was opened — and the month is covered outright anyway.
  it('covers the month in full and banks nothing for hours logged on it', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })
    await logHours(s, '2026-09-12', 30)
    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    // THE MONEY, not just the bank: reading the period's frozen 80 hours
    // credited 30 x $5.75 = $172.50 and left $287.50 owed on a month the
    // agreement covers outright. Asserting only banked_hours could not tell the
    // two versions apart — 30 hours against an 80-hour target banks nothing
    // either way.
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 460 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await invoiceOf(s.invoiceId)).toEqual({ total: 0, credit: 460, hours: 0 })
    expect(Number((await db.query(
      `SELECT banked_hours::float AS b FROM work_trade_agreements WHERE id=$1`,
      [s.agreementId])).rows[0].b)).toBe(0)
  })

  // The other reader of the same snapshot: a covered utility share released
  // onto a bill already out (services/utilityBilling attachBillToOpenInvoice →
  // bringLinesUnderTrade). A settled month covers it in full, so the tenant
  // must be asked for nothing. Reading the period's frozen 80 hours instead
  // priced the month at a rate nobody owes work at, credited the water $0 and
  // left it on the tenant as money owed on a trade that covers water.
  it('a charge released onto an untracked month it already settled is covered, not owed', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 460 })

    const water = (await db.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'utility',50,'pending','2026-09-01','UTILITY')
       RETURNING id`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id

    const { bringLinesUnderTrade } = await import('../services/workTradeCoverage')
    const r = await bringLinesUnderTrade(db, s.agreementId, s.invoiceId, [{
      id: water, invoice_id: s.invoiceId, amount: 50, type: 'utility',
      tenant_id: s.tenantId, due_date: '2026-09-01',
    }])
    expect(r).toEqual({ outcome: 'covered', amount: 50 })

    const row = (await db.query(
      `SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [water])).rows[0]
    expect(row).toEqual({ status: 'settled', amount: 0 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ credit: 510 })
  })

  // Nic reads this on the tenant portal and the landlord reads the priced copy
  // of it; the close reads the agreement. All three have to say the same thing
  // about the same month, or the tenant is chasing hours nobody is asking for.
  it('tells the tenant and the landlord the month asks for no hours', async () => {
    const s = await buildStack({ basis: 460, suspended: true, tracksHours: false })
    await addSuspendedPeriod(s, '2026-10-01', 460)

    const tenant = await loadWorkTradeStanding(s.agreementId, '2026-10-01', 'tenant')
    expect(tenant).toMatchObject({ currentMonthHours: 0, carriedHours: 0, catchUpHours: 0 })
    expect(tenant!.summary).toBe("You're fully covered for this month.")

    const landlord = await loadWorkTradeStanding(s.agreementId, '2026-10-01', 'landlord')
    expect(landlord).toMatchObject({ carriedHours: 0, carriedValue: 0, nextBillingMonth: null })
    expect(landlord!.summary).not.toContain('$')
  })
})

// RV 50 and RV 51 at Mountain View: lease hibernation paused the agreement
// (work_trade_agreements.paused_by_hibernation, S594) while their September
// rent was already suspended under the trade. The close only ever looked at
// `active` agreements, so their month was never closed at all and $589 each sat
// parked with nothing on the calendar that would ever release it.
describe('a paused agreement', () => {
  it('settles a month its own terms already cover', async () => {
    const s = await buildStack({ basis: 589, suspended: true, tracksHours: false })
    await db.query(
      `UPDATE work_trade_agreements SET status='paused', paused_by_hibernation=true WHERE id=$1`,
      [s.agreementId])

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect((await periodOf(s, '2026-09-01')).status).toBe('settled')
    expect(await suspendedWorkTrade(s)).toBe(0)
    expect(await openOnLease(s.leaseId)).toBe(0)
    // Pausing is not ending: the agreement is still paused, not ended.
    expect((await db.query(
      `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].status)
      .toBe('paused')
  })

  // A short month on a paused trade: the shortfall never ages out into a cash
  // charge and never ends the trade, but the month still closes like any other
  // — so READ WHAT THE TENANT OWES. Asserting only the run counters is why the
  // $125 below went unnoticed: with the close looking at active agreements only
  // the paused one was never processed at all, so periodsBilled was 0 and the
  // carried rows were empty while the test did nothing.
  it('closes a short month without ever aging it into a cash bill', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await db.query(`UPDATE work_trade_agreements SET status='paused' WHERE id=$1`, [s.agreementId])

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    // carry_forward_months 0 would have billed an ACTIVE trade's lapse at this
    // close and ended it. Paused, the window never runs out.
    expect(r.periodsBilled).toBe(0)
    expect(r.agreementsEnded).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
    expect((await db.query(
      `SELECT status FROM work_trade_agreements WHERE id=$1`, [s.agreementId])).rows[0].status)
      .toBe('paused')
    // The month closed: 60 of 80 hours credited $375, and the 20 unworked hours
    // are the $125 lapse on September's own bill, exactly as an active trade's
    // would be. This is the figure in the OPEN QUESTION at CLOSE_STATUSES —
    // whether a dormant trade's lapse should sit owed or stay parked is Nic's
    // call, and this assertion is where that decision lands.
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'open', applied: 60, credit: 375 })
    expect(await openOnLease(s.leaseId)).toBe(125)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10/19 (Nic) — A PAUSED WORK TRADE: DOES THE CAMPER STILL OCCUPY THE SPACE?
//
// "A paused work trade that counts hours should continue to count hours. If, I
// mean, basically the landlord needs to have a way to set whether they occupy
// the spot or not. Because if somebody wants to work more hours in the winter
// but leave their camper occupying the space in the summer, that's one
// situation. If people take their camper home for the summer with them and it's
// not occupying the spot, then there would be no reason for it to continue to
// track hours. So that's another thing you're asking me about, which needs to
// be an individual landlord decision."
//
// These need migration 20261021150000, which is not on production yet:
//   DB_NAME=<yours>_test TEST_APPLY_MIGRATIONS_AFTER=20261020125959 npx vitest run
// (the package script's DB_NAME=gam_test builds from schema.sql alone).
describe('a paused work trade and whether the space is still being used', () => {
  const answer = (s: Stack, occupied: boolean | null) => db.query(
    `UPDATE work_trade_agreements SET paused_space_occupied = $2 WHERE id = $1`,
    [s.agreementId, occupied])
  const pause = (s: Stack) => db.query(
    `UPDATE work_trade_agreements SET status='paused' WHERE id=$1`, [s.agreementId])
  const resume = (s: Stack) => db.query(
    `UPDATE work_trade_agreements SET status='active' WHERE id=$1`, [s.agreementId])
  const occupancyOf = async (s: Stack) => (await db.query(
    `SELECT paused_space_occupied FROM work_trade_agreements WHERE id=$1`,
    [s.agreementId])).rows[0].paused_space_occupied

  // Nic's first situation: the camper stays on the spot over the summer while
  // they work more hours in the winter. Nothing about the month changes.
  it('occupied: hours keep counting and the month behaves exactly as before', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)                        // 20 of 80 short
    await pause(s)
    await answer(s, true)

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    // The same figures the pre-10/19 close produced for a paused short month:
    // 60 hours credited $375, the 20 unworked hours owed as $125 on September's
    // own bill, the period still open and carrying, nothing aged into cash.
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'open', applied: 60, credit: 375 })
    expect(await openOnLease(s.leaseId)).toBe(125)
    expect(r.periodsBilled).toBe(0)
    expect(r.agreementsEnded).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  // Nic's second situation: "if people take their camper home for the summer
  // with them and it's not occupying the spot, then there would be no reason for
  // it to continue to track hours."
  //
  // THE CHOICE, stated: the month ASKS NOTHING AND SETTLES, rather than never
  // opening. A month that never opens leaves its suspended rent line parked with
  // nothing on the calendar to release it — the exact $589 RV 50 and RV 51 were
  // stuck in before 10/18. Settling lets the landlord and the tenant read the
  // same true sentence, which is the test below this one.
  it('empty: the month asks for no hours, settles, and nobody owes anything new', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await pause(s)
    await answer(s, false)

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    // Covered outright, the way a trade that never counted hours covers a month.
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 500 })
    // Nothing invented and nothing left parked: no charge, no carried balance,
    // no suspended line sitting pending for ever.
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await suspendedWorkTrade(s)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
    expect(await balancesPageOwed(s)).toBe(0)
    expect(r.periodsBilled).toBe(0)
    expect(r.agreementsEnded).toBe(0)
    // Hours logged while nobody is counting are not banked — they were never
    // banked time (the tracks_hours rule). They are not thrown away either: the
    // period records no hours_worked, so they count fresh when counting resumes.
    expect(Number((await db.query(
      `SELECT banked_hours::float AS h FROM work_trade_agreements WHERE id=$1`,
      [s.agreementId])).rows[0].h)).toBe(0)
    expect((await periodOf(s, '2026-09-01')).worked).toBe(0)
  })

  // What the tenant is told has to match what the close actually did, in both
  // answers. A tenant seeing one number and the close doing another is the
  // argument this whole subsystem exists to prevent.
  it('says the same true thing to both sides, under both answers', async () => {
    const occ = await buildStack({ basis: 500, suspended: true })
    await logHours(occ, '2026-09-10', 60)
    await pause(occ)
    await answer(occ, true)
    await runWorkTradeSettlement('2026-09-01')
    // Still counting. The close credited 60 hours and left the other 20 owed as
    // $125 on September's own bill — and the sentence says the same 20 hours.
    // (Read after the close: the standing counts hours APPLIED to a period, and
    // a month's approved hours are applied when it closes.)
    expect(await openOnLease(occ.leaseId)).toBe(125)
    const told = await loadWorkTradeStanding(occ.agreementId, '2026-09-01', 'tenant')
    expect(told).toMatchObject({ currentMonthHours: 20, hoursNotCounted: false })
    expect(told!.summary).toContain('20 hours')
    // 10/19 (Nic, "Show it while paused") — AND IT SAYS IT IS PAUSED WHILE
    // SAYING THAT. The tenant portal shows a paused agreement now, and these
    // figures are word-for-word a running agreement's: without the sentence, a
    // snowbird reads the 20 hours as a target nobody is holding them to, and
    // then finds the $125 asserted above on September's bill.
    expect(told).toMatchObject({ paused: true, hoursCounted: true })
    expect(told!.summary).toContain('paused, but the space is still being used')
    expect(told!.summary).toContain('your hours keep counting')

    const gone = await buildStack({ basis: 500, suspended: true })
    await logHours(gone, '2026-09-10', 60)
    await pause(gone)
    await answer(gone, false)
    // Not counting: no target to fail, and the sentence says WHY rather than a
    // clean "you're fully covered" they could not tell from having worked it.
    const toldGone = await loadWorkTradeStanding(gone.agreementId, '2026-09-01', 'tenant')
    expect(toldGone).toMatchObject({ currentMonthHours: 0, catchUpHours: 0, hoursNotCounted: true })
    expect(toldGone!.summary).toContain('no hours are being counted')
    // 10/19 (review): the months ALREADY BILLED under the trade are covered at
    // the next close — which is what this stack has — and a month billed during
    // the pause is not. The earlier wording promised the second as well, and
    // the billing run does not do it (services/workTradeCredit asks for an
    // ACTIVE agreement).
    expect(toldGone!.summary).toContain('covered at the next month close')
    expect(toldGone!.summary).toContain('not covered by the trade')
    expect(toldGone!.summary).not.toContain('not billed while it is paused')
    // The two answers never blur into each other: this one must not also claim
    // hours are counting (10/19).
    expect(toldGone).toMatchObject({ paused: true, hoursCounted: false })
    expect(toldGone!.summary).not.toContain('keep counting')
    // The landlord reads the same sentence, and still gets no dollar figure
    // attached to trade hours (S643).
    const landlordSees = await loadWorkTradeStanding(gone.agreementId, '2026-09-01', 'landlord')
    expect(landlordSees!.summary).toBe(toldGone!.summary)
    expect(landlordSees!.summary).not.toContain('$')
    // And the close does what the sentence said.
    await runWorkTradeSettlement('2026-09-01')
    expect(await openOnLease(gone.leaseId)).toBe(0)
    expect((await periodOf(gone, '2026-09-01')).status).toBe('settled')
  })

  // 10/19 (Nic, "Show it while paused") — THE UNANSWERED PAUSE IS THE COMMON ONE.
  //
  // Lease hibernation and a lease expiring with no successor both pause an
  // agreement with no landlord in front of a screen, so an unanswered pause is
  // the normal state of a freshly paused trade — and it keeps counting hours.
  // That is the case where showing the tenant nothing was worst: their tab
  // disappeared while their hours went on counting.
  it('unanswered: the tenant is told hours keep counting, and why nobody has said otherwise', async () => {
    const s = await buildStack({ basis: 500, suspended: true })
    await logHours(s, '2026-09-10', 60)
    await pause(s)
    const told = await loadWorkTradeStanding(s.agreementId, '2026-09-01', 'tenant')
    expect(told).toMatchObject({ paused: true, hoursCounted: true })
    expect(told!.summary).toContain('your hours keep counting')
    expect(told!.summary).toContain('says whether the space is still being used')
    // And the close agrees: the month still asks for its hours.
    await runWorkTradeSettlement('2026-09-01')
    expect(await openOnLease(s.leaseId)).toBe(125)
  })

  // "A camper can leave later." The answer is read live at each close, never
  // frozen onto the period, so a change takes effect from then on.
  it('the answer can be changed while still paused, and takes effect from then on', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 3 })
    await logHours(s, '2026-09-10', 60)
    await pause(s)
    await answer(s, true)

    // September closes while the camper is still on the spot: 20 hours short.
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'open', applied: 60 })
    expect(await openOnLease(s.leaseId)).toBe(125)

    // The camper leaves. October opens its own month and bill.
    await answer(s, false)
    await addPeriod(s, '2026-10-01', 500)
    await runWorkTradeSettlement('2026-10-01')

    // October asked for nothing and settled. September's still-open month is
    // covered outright by the same rule — stopping the count covers every month
    // still open, exactly as turning hours off entirely does (the 10/18 rule),
    // so the $125 carried catch-up is cleared rather than left owed on a trade
    // nobody is counting. The work-trade window prices that for the landlord
    // before they answer.
    expect(await periodOf(s, '2026-10-01')).toMatchObject({ status: 'settled' })
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled' })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  // The two live paused agreements (RV 50 and RV 51 at Mountain View) are this
  // shape, which is why 10/19 moves no money today.
  it('a trade that never counted hours is unaffected by either answer', async () => {
    for (const occupied of [true, false, null]) {
      const s = await buildStack({ basis: 589, suspended: true, tracksHours: false })
      await pause(s)
      await answer(s, occupied)

      const r = await runWorkTradeSettlement('2026-09-01')
      expect(r.errors).toEqual([])
      expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 589 })
      expect(await openOnLease(s.leaseId)).toBe(0)
      expect(await suspendedWorkTrade(s)).toBe(0)
      const told = await loadWorkTradeStanding(s.agreementId, '2026-09-01', 'tenant')
      // It never counted hours, so it is not the trade that STOPPED counting —
      // it keeps its own words ("No hours are tracked on this agreement").
      expect(told).toMatchObject({ hoursNotCounted: false })
    }
  })

  // Pausing is not a one-way door, and the answer belongs to the pause it was
  // given during: the trigger in 20261021150000 forgets it on the way back.
  it('unpausing returns it to normal whichever answer was given', async () => {
    for (const occupied of [true, false]) {
      const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
      await logHours(s, '2026-09-10', 60)
      await pause(s)
      await answer(s, occupied)
      await resume(s)

      // The answer belonged to that pause, and the pause is over.
      expect(await occupancyOf(s)).toBeNull()
      const r = await runWorkTradeSettlement('2026-09-01')
      expect(r.errors).toEqual([])
      // Figure for figure the ordinary active short month at the top of this
      // file ('a short month leaves the balance owing and the period open'):
      // 60 of 80 credited $375, the 20 unworked hours owed as $125 on the
      // month's own bill, the period still open and carrying. Whichever answer
      // was given while it slept leaves no trace.
      expect(await periodOf(s, '2026-09-01')).toMatchObject({
        status: 'open', applied: 60, worked: 60, credit: 375 })
      expect(await openOnLease(s.leaseId)).toBe(125)
      const told = await loadWorkTradeStanding(s.agreementId, '2026-09-01', 'tenant')
      expect(told).toMatchObject({ currentMonthHours: 20, hoursNotCounted: false })
    }
  })

  // Ending by hand bills "any percentage of hours unpaid or uncompleted" — and
  // on a trade nobody was counting, none are uncompleted. The rule reads 'ended'
  // as well as 'paused' precisely because the route writes the status before it
  // settles, so reading 'paused' alone would bill the season on the way out.
  it('ending a dormant trade on an empty space bills nothing', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await pause(s)
    await answer(s, false)
    await db.query(`UPDATE work_trade_agreements SET status='ended', end_date=CURRENT_DATE WHERE id=$1`,
      [s.agreementId])

    const r = await settleAgreementOnEnd(s.agreementId)
    expect(r.errors).toEqual([])
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 500 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await carriedRows(s.leaseId)).toEqual([])
  })

  // ── 10/19 (review) — THE THIRD READER OF "ARE HOURS COUNTING" ───────────────
  //
  // A charge ticked onto a month the close has already covered goes through
  // services/workTradeCoverage, not through the close. That reader asked only
  // tracks_hours, so the two switches that both mean "no hours are counted"
  // gave OPPOSITE answers about the same $75 of water: a trade that never
  // counted hours covered it (the test above this block), and a paused trade on
  // an empty space priced the month at its frozen 80 hours, credited the water
  // $0, and left it owed on a September that was settled in full — while the
  // work-trade window told the tenant those charges "are not billed while it is
  // paused."
  it('a charge released onto a settled month of a dormant trade is covered, not owed', async () => {
    const s = await buildStack({ basis: 589, suspended: true })   // tracks_hours TRUE, 80 hours
    await pause(s)
    await answer(s, false)
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 589 })

    // The water bill lands a minute later (a share released onto a bill already
    // out, or the landlord ticking Water on the roster row).
    const water = (await db.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'utility',75,'pending','2026-09-01','UTILITY')
       RETURNING id`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id

    const { bringLinesUnderTrade } = await import('../services/workTradeCoverage')
    const r = await bringLinesUnderTrade(db, s.agreementId, s.invoiceId, [{
      id: water, invoice_id: s.invoiceId, amount: 75, type: 'utility',
      tenant_id: s.tenantId, due_date: '2026-09-01',
    }])
    expect(r).toEqual({ outcome: 'covered', amount: 75 })
    expect((await db.query(
      `SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [water])).rows[0])
      .toEqual({ status: 'settled', amount: 0 })
    expect(await openOnLease(s.leaseId)).toBe(0)
    expect(await balancesPageOwed(s)).toBe(0)
    // And the month is left whole: the wider basis and the credit on it agree,
    // so there is no $75 hole on a settled period that nothing would ever heal
    // (loadOpenPeriods only ever reopens an `open` month).
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'settled', credit: 664 })
    expect(Number((await db.query(
      `SELECT basis_amount::float AS b FROM work_trade_settlements WHERE agreement_id=$1`,
      [s.agreementId])).rows[0].b)).toBe(664)
  })

  // The same money whichever switch stopped the count. Nic set one rule — "no
  // hours are counted" — and a landlord cannot be expected to know that reaching
  // it two different ways charges the tenant two different amounts.
  it('bills the same whether hours stopped by the switch or by the empty space', async () => {
    const amounts: number[] = []
    for (const how of ['never counted', 'paused and empty'] as const) {
      const s = await buildStack({
        basis: 589, suspended: true, tracksHours: how === 'never counted' ? false : true })
      if (how === 'paused and empty') { await pause(s); await answer(s, false) }
      await runWorkTradeSettlement('2026-09-01')

      const extra = (await db.query(
        `INSERT INTO payments
           (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
            status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'utility',75,'pending','2026-09-01','UTILITY')
         RETURNING id`,
        [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id
      const { bringLinesUnderTrade } = await import('../services/workTradeCoverage')
      await bringLinesUnderTrade(db, s.agreementId, s.invoiceId, [{
        id: extra, invoice_id: s.invoiceId, amount: 75, type: 'utility',
        tenant_id: s.tenantId, due_date: '2026-09-01',
      }])
      amounts.push(await openOnLease(s.leaseId))
    }
    expect(amounts).toEqual([0, 0])
  })

  // 10/19 (review): the answer belongs to a pause, and the trigger in migration
  // 20261021150000 states that as "an ACTIVE agreement never carries one" rather
  // than as a rule about transitions. Written while the trade was already
  // running, an answer used to sit there unread until the next hibernation
  // paused the lease — and then stopped counting hours on a pause nobody had
  // been asked about, clearing every open month.
  it('an answer written onto a running trade is forgotten, not stored for the next pause', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await logHours(s, '2026-09-10', 60)
    await answer(s, false)                      // still ACTIVE: no pause to answer about
    expect(await occupancyOf(s)).toBeNull()

    // And the next pause therefore behaves as an unanswered one: hours keep
    // counting, which is what every paused agreement did before 10/19.
    await pause(s)
    expect(await occupancyOf(s)).toBeNull()
    await runWorkTradeSettlement('2026-09-01')
    expect(await periodOf(s, '2026-09-01')).toMatchObject({ status: 'open', applied: 60, credit: 375 })
    expect(await openOnLease(s.leaseId)).toBe(125)
  })

  // 10/19 (review): the standing's sentence is about a pause, so it is only said
  // on one. hoursCountedSql reads 'ended' as well (the end-by-hand path writes
  // the status before it settles) and the migration keeps the answer through
  // paused → ended by design — so an ended trade used to tell both sides it "is
  // paused and the space is empty" and that its charges "are not billed while it
  // is paused", about an agreement that will never bill or cover anything again.
  it('an ended trade is never described as paused, to either side', async () => {
    const s = await buildStack({ basis: 500, suspended: true, carryForwardMonths: 0 })
    await pause(s)
    await answer(s, false)
    await db.query(`UPDATE work_trade_agreements SET status='ended', end_date=CURRENT_DATE WHERE id=$1`,
      [s.agreementId])
    await settleAgreementOnEnd(s.agreementId)

    for (const audience of ['tenant', 'landlord'] as const) {
      const told = await loadWorkTradeStanding(s.agreementId, '2026-09-01', audience)
      expect(told).toMatchObject({ hoursNotCounted: false })
      expect(told!.summary).not.toContain('paused')
      expect(told!.summary).not.toContain('space is empty')
    }
    // 10/19 (review): and the landlord's ROSTER reads the same target the
    // window does for that agreement — hoursCountedFor says 0 on an ended trade
    // whose last pause said the space was empty, so the row must not print the
    // stored 80 against it (apps/landlord WorkTradePage countsHours).
    const onRoster = await db.query(
      `SELECT status, tracks_hours, paused_space_occupied, monthly_hours_target
         FROM work_trade_agreements WHERE id = $1`, [s.agreementId])
    expect(onRoster.rows[0]).toMatchObject({ status: 'ended', paused_space_occupied: false })
    expect(hoursCountedFor(onRoster.rows[0])).toBe(false)
    // The money the ending already did is untouched: nothing was billed on the
    // way out, which is the rule the kept answer exists for.
    expect(await openOnLease(s.leaseId)).toBe(0)
  })
})
