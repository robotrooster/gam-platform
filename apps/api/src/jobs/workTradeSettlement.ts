// S624 — the month-close settlement run.
//
// Rent is paid forward, so the work that pays for a month happens during it.
// The invoice issued GROSS on the 1st and sat `late_fee_exempt` while the tenant
// worked (S623). This job is the other half: once the month is over, its own
// approved hours credit its own invoice, a shortfall carries forward in HOURS,
// and a deficit that outlives the landlord's leniency is billed in cash and ends
// the agreement.
//
// All of the arithmetic lives in services/workTradeSettlement.ts and is tested
// there against Nic's own worked examples. This file is the database around it:
// read the periods, call settleMonth, write what it says.

import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { logger } from '../lib/logger'
import {
  settleMonth, settleOnEnd, round2h,
  type SettlementPeriod, type SettlementResult,
} from '../services/workTradeSettlement'
import { round2 } from '../services/workTradeCredit'

export interface SettlementRunResult {
  agreementsProcessed: number
  periodsSettled: number
  periodsBilled: number
  agreementsEnded: number
  errors: Array<{ agreement_id: string; error: string }>
}

/** Rows the credit lands on, in the order it lands on them (S609/S613 order). */
const ROW_PRIORITY = `CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1
                                  WHEN 'fee'  THEN 2 ELSE 3 END`

async function loadOpenPeriods(
  client: PoolClient, agreementId: string, throughMonth: string,
): Promise<Array<SettlementPeriod & { id: string; invoiceId: string | null }>> {
  const { rows } = await client.query(
    `SELECT id, invoice_id, to_char(period_month,'YYYY-MM-DD') AS period_month,
            target_hours::float  AS target_hours,
            hours_applied::float AS hours_applied,
            basis_amount::float  AS basis_amount,
            hour_rate::float     AS hour_rate,
            -- How many closes this period has already survived. Derived from the
            -- calendar rather than stored as a counter, so a missed or re-run
            -- job cannot drift it.
            GREATEST(0, (DATE_PART('year',  $2::date) - DATE_PART('year',  period_month)) * 12
                      + (DATE_PART('month', $2::date) - DATE_PART('month', period_month)) - 1
            )::int AS aged_closes
       FROM work_trade_settlements
      WHERE agreement_id = $1 AND status = 'open' AND period_month <= $2::date
      ORDER BY period_month`,
    [agreementId, throughMonth])
  return rows.map((r: any) => ({
    id: r.id, invoiceId: r.invoice_id,
    periodMonth: r.period_month,
    targetHours: Number(r.target_hours),
    hoursApplied: Number(r.hours_applied),
    basisAmount: Number(r.basis_amount),
    hourRate: Number(r.hour_rate),
    agedCloses: Number(r.aged_closes),
  }))
}

/**
 * Apply `credit` dollars to an invoice's still-open rows, rent first.
 *
 * A row the credit fully covers is marked settled and noted as covered by
 * labour rather than cash — the same record the old generation-time credit
 * wrote, just produced a month later. A row it partly covers is reduced.
 */
async function creditInvoice(
  client: PoolClient, invoiceId: string, credit: number, hours: number,
): Promise<void> {
  let remaining = round2(credit)
  const { rows } = await client.query(
    `SELECT p.id, p.amount::float AS amount
       FROM payments p
      WHERE p.invoice_id = $1 AND p.status = 'pending'
        -- Late fees and one-off charges are never work-trade creditable: a fine
        -- is not a cost of living somewhere, and the agreement did not price it.
        AND p.type IN ('rent','utility','fee')
        AND COALESCE(p.entry_description,'') <> 'LATEFEE'
      ORDER BY ${ROW_PRIORITY}, p.created_at`,
    [invoiceId])

  for (const r of rows) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Number(r.amount))
    const net = round2(Number(r.amount) - take)
    remaining = round2(remaining - take)
    if (net === 0) {
      await client.query(
        `UPDATE payments
            SET amount = 0, status = 'settled', settled_at = NOW(),
                notes = COALESCE(notes || ' — ', '') || 'Covered by work-trade credit'
          WHERE id = $1`, [r.id])
    } else {
      await client.query(`UPDATE payments SET amount = $2 WHERE id = $1`,
        [r.id, net.toFixed(2)])
    }
  }

  await client.query(
    `UPDATE invoices
        SET total_amount = GREATEST(0, total_amount - $2),
            work_trade_credit_amount = work_trade_credit_amount + $2,
            work_trade_credit_hours  = work_trade_credit_hours + $3,
            updated_at = NOW()
      WHERE id = $1`,
    [invoiceId, round2(credit - remaining).toFixed(2), round2h(hours).toFixed(2)])
}

/**
 * Bill a deficit that outlived its window, as an ordinary tenant charge.
 *
 * Nic (S624): "at some point a landlord's gonna know that somebody's never gonna
 * be able to physically catch up... they are just charged the difference and the
 * work trade agreement ends."
 *
 * `late_fee_exempt` on the invoice already covers it, and per Nic's S624 answer
 * this remainder is never fined — someone short on hours is short on labour, not
 * refusing to pay. It joins the carried-balance track, which is outside FIFO and
 * payable in part (S622).
 */
async function billDeficit(
  client: PoolClient, period: { id: string; invoiceId: string | null },
  agreement: { id: string; landlord_id: string; unit_id: string; tenant_id: string; lease_id: string | null },
  amount: number, periodMonth: string,
): Promise<void> {
  if (amount <= 0) return
  await client.query(
    `INSERT INTO payments
       (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, notes)
     VALUES ($1, $2, $3, $4, 'carried_balance', $5, 'pending', 'BALANCE',
             CURRENT_DATE, $6)`,
    [agreement.unit_id, agreement.lease_id, agreement.tenant_id, agreement.landlord_id,
     amount.toFixed(2),
     `Work-trade hours not completed for ${DateTime.fromISO(periodMonth).toFormat('LLLL yyyy')} — billed when the agreement ended`])
  await client.query(
    `UPDATE work_trade_settlements
        SET status='billed', billed_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [period.id])
}

async function persist(
  client: PoolClient,
  agreement: any,
  periods: Array<SettlementPeriod & { id: string; invoiceId: string | null }>,
  hoursWorkedByMonth: Map<string, number>,
  result: SettlementResult,
  run: SettlementRunResult,
): Promise<void> {
  const byMonth = new Map(periods.map(p => [p.periodMonth, p]))

  for (const out of result.periods) {
    const row = byMonth.get(out.periodMonth)
    if (!row) continue

    if (out.hoursAppliedNow > 0 && row.invoiceId) {
      await creditInvoice(client, row.invoiceId,
        round2(out.hoursAppliedNow * row.hourRate), out.hoursAppliedNow)
    }

    await client.query(
      `UPDATE work_trade_settlements
          SET hours_worked   = $2,
              hours_applied  = $3,
              credit_applied = $4,
              status         = $5,
              settled_at     = CASE WHEN $5 = 'settled' THEN NOW() ELSE settled_at END,
              updated_at     = NOW()
        WHERE id = $1`,
      [row.id,
       round2h(hoursWorkedByMonth.get(out.periodMonth) ?? 0).toFixed(2),
       out.hoursAppliedTotal.toFixed(2),
       out.creditTotal.toFixed(2),
       out.status === 'billed' ? 'open' : out.status])

    if (out.status === 'settled') run.periodsSettled++
    if (out.status === 'billed') {
      await billDeficit(client, row, agreement, out.uncoveredAmount, out.periodMonth)
      run.periodsBilled++
    }
  }

  await client.query(
    `UPDATE work_trade_agreements SET banked_hours = $2, updated_at = NOW() WHERE id = $1`,
    [agreement.id, result.bankedHours.toFixed(2)])

  if (result.endsAgreement) {
    await client.query(
      `UPDATE work_trade_agreements
          SET status = 'ended', end_date = COALESCE(end_date, CURRENT_DATE), updated_at = NOW()
        WHERE id = $1`, [agreement.id])
    run.agreementsEnded++
  }
}

/**
 * Close out `periodMonth` (an ISO first-of-month) for every active agreement.
 *
 * Idempotent: a period already `settled` or `billed` is not reloaded, and a
 * re-run over the same month applies no further hours because `hours_applied`
 * is already at target.
 */
export async function runWorkTradeSettlement(periodMonth: string): Promise<SettlementRunResult> {
  const run: SettlementRunResult = {
    agreementsProcessed: 0, periodsSettled: 0, periodsBilled: 0,
    agreementsEnded: 0, errors: [],
  }
  const client = await getClient()
  try {
    const { rows: agreements } = await client.query(
      `SELECT wta.id, wta.landlord_id, wta.unit_id, wta.tenant_id,
              wta.banked_hours::float AS banked_hours,
              wta.carry_forward_months,
              -- A lease has no tenant_id: tenancy lives in lease_tenants, which
              -- is what makes co-tenants and mid-term changes expressible. The
              -- agreement's tenant must be an ACTIVE party to the lease for it
              -- to be theirs to be billed on.
              (SELECT l.id FROM leases l
                 JOIN lease_tenants lt ON lt.lease_id = l.id
                WHERE l.unit_id = wta.unit_id
                  AND lt.tenant_id = wta.tenant_id
                  AND lt.status = 'active'
                ORDER BY l.start_date DESC LIMIT 1) AS lease_id
         FROM work_trade_agreements wta
        WHERE wta.status = 'active'
          AND EXISTS (SELECT 1 FROM work_trade_settlements ws
                       WHERE ws.agreement_id = wta.id AND ws.status = 'open'
                         AND ws.period_month <= $1::date)`,
      [periodMonth])

    for (const a of agreements) {
      try {
        await client.query('BEGIN')
        const periods = await loadOpenPeriods(client, a.id, periodMonth)
        if (periods.length === 0) { await client.query('ROLLBACK'); continue }

        // The closing month must be LAST — settleMonth identifies it by position
        // so it never has to reason about calendars. If the month being closed
        // has no period (no invoice that month), the newest open period stands in
        // as the closing one, which is correct: it is the month whose hours we
        // are about to count.
        const closingIdx = periods.findIndex(p => p.periodMonth === periodMonth)
        const ordered = closingIdx >= 0
          ? [...periods.filter(p => p.periodMonth !== periodMonth), periods[closingIdx]]
          : periods

        const { rows: hrs } = await client.query(
          `SELECT to_char(date_trunc('month', work_date),'YYYY-MM-DD') AS m,
                  SUM(hours)::float AS h
             FROM work_trade_logs
            WHERE agreement_id = $1 AND status = 'approved'
              AND date_trunc('month', work_date) = $2::date
            GROUP BY 1`,
          [a.id, periodMonth])
        const hoursWorkedByMonth = new Map<string, number>(
          hrs.map((r: any) => [r.m, Number(r.h)]))

        const result = settleMonth({
          periods: ordered,
          hoursWorked: hoursWorkedByMonth.get(periodMonth) ?? 0,
          bankedHours: Number(a.banked_hours),
          carryForwardMonths: Number(a.carry_forward_months),
        })

        await persist(client, a, ordered, hoursWorkedByMonth, result, run)
        await client.query('COMMIT')
        run.agreementsProcessed++
      } catch (e: unknown) {
        await client.query('ROLLBACK').catch(() => {})
        const error = e instanceof Error ? e.message : String(e)
        run.errors.push({ agreement_id: a.id, error })
        logger.error({ err: e, agreement_id: a.id }, '[WorkTradeSettlement] agreement failed')
      }
    }
  } finally {
    client.release()
  }
  return run
}

/**
 * The landlord ended the agreement by hand. Nic (S624): "when the landlord marks
 * the work trade agreement as over, any percentage of hours unpaid or
 * uncompleted is billed immediately." Leniency does not apply — the window
 * existed to give someone time to catch up, and there is no more time.
 */
export async function settleAgreementOnEnd(agreementId: string): Promise<SettlementRunResult> {
  const run: SettlementRunResult = {
    agreementsProcessed: 0, periodsSettled: 0, periodsBilled: 0,
    agreementsEnded: 0, errors: [],
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT wta.id, wta.landlord_id, wta.unit_id, wta.tenant_id,
              wta.banked_hours::float AS banked_hours,
              -- A lease has no tenant_id: tenancy lives in lease_tenants, which
              -- is what makes co-tenants and mid-term changes expressible. The
              -- agreement's tenant must be an ACTIVE party to the lease for it
              -- to be theirs to be billed on.
              (SELECT l.id FROM leases l
                 JOIN lease_tenants lt ON lt.lease_id = l.id
                WHERE l.unit_id = wta.unit_id
                  AND lt.tenant_id = wta.tenant_id
                  AND lt.status = 'active'
                ORDER BY l.start_date DESC LIMIT 1) AS lease_id
         FROM work_trade_agreements wta WHERE wta.id = $1`, [agreementId])
    const a = rows[0]
    if (!a) { await client.query('ROLLBACK'); return run }

    const periods = await loadOpenPeriods(client, agreementId, '9999-12-01')
    const result = settleOnEnd(periods, Number(a.banked_hours))
    await persist(client, a, periods, new Map(), result, run)
    await client.query('COMMIT')
    run.agreementsProcessed++
  } catch (e: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    run.errors.push({ agreement_id: agreementId, error: e instanceof Error ? e.message : String(e) })
  } finally {
    client.release()
  }
  return run
}
