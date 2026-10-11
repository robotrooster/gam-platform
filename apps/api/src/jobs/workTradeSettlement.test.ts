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
import { listOpenTenantBalances } from '../services/openBalances'
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
  it('leaves a trade the landlord does not clock exactly as before', async () => {
    const s = await buildStack({ target: 0, basis: 460, suspended: true, tracksHours: false })
    await logHours(s, '2026-09-10', 12)                 // logged anyway
    // The prod shape: the cron already stamped the close but left it open.
    await db.query(`UPDATE work_trade_settlements SET close_run_at = NOW() WHERE agreement_id=$1`,
      [s.agreementId])

    const r = await runWorkTradeSettlement('2026-09-01')
    expect(r.errors).toEqual([])
    expect(r.periodsSettled).toBe(1)
    expect(await periodOf(s, '2026-09-01')).toEqual(
      { status: 'settled', worked: 12, applied: 0, credit: 460 })
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
  it('leaves a trade the landlord does not clock exactly as before', async () => {
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
  it('leaves a trade the landlord does not clock exactly as before', async () => {
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
