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

// S648: a period's identity is its START date. With the 1st as the due day
// that is the month label itself, so nothing changes for calendar tenants; a
// tenant due on the 15th can have two periods labelled with one month (the
// move-in stub and the first full period), and the start tells them apart.
async function loadOpenPeriods(
  client: PoolClient, agreementId: string, throughMonth: string,
  throughStart: string | null = null,
): Promise<Array<SettlementPeriod & { id: string; invoiceId: string | null; label: string }>> {
  const { rows } = await client.query(
    `SELECT id, invoice_id, to_char(period_start,'YYYY-MM-DD') AS period_month,
            to_char(period_month,'YYYY-MM-DD') AS label,
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
        AND ($3::date IS NULL OR period_start <= $3::date)
      ORDER BY period_start`,
    [agreementId, throughMonth, throughStart])
  return rows.map((r: any) => ({
    id: r.id, invoiceId: r.invoice_id, label: r.label,
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

  // ── S634: THE MONTH IS OVER, SO THE SUSPENSION ENDS ────────────────────────
  //
  // Nic (DIRECTIVE): "Have the work trade exist, but be suspended... and it
  // creates only at the month close. They work, and at the end of the month, if
  // they don't hit their hours, the rent for that month is prorated to cover any
  // lapse."
  //
  // A suspended line was never in `total_amount` (see jobs/moveInBundle.ts), so
  // subtracting the credit from the total would take money off a total that
  // never had it — the invoice would go negative-by-omission and the lapse would
  // vanish. Instead the flag is cleared and the total is REBUILT from the lines
  // that are actually owed after the credit landed above: zero when the hours
  // were met, the lapse when they were not.
  const unsuspended = await client.query(
    `UPDATE payments SET work_trade_suspended_at = NULL
      WHERE invoice_id = $1 AND work_trade_suspended_at IS NOT NULL
      RETURNING id`, [invoiceId])

  if (unsuspended.rows.length > 0) {
    // This invoice carried a suspended line, so its total never included it.
    // Rebuild from what is actually owed now the credit has landed: zero when
    // the hours were met, the lapse when they were not. Subtracting the credit
    // instead would take money off a total that never had it.
    await client.query(
      `UPDATE invoices i
          SET total_amount = COALESCE((
                SELECT SUM(p.amount) FROM payments p
                 WHERE p.invoice_id = i.id
                   AND p.work_trade_suspended_at IS NULL
                   AND p.status <> 'failed'
              ), 0),
              work_trade_credit_amount = i.work_trade_credit_amount + $2,
              work_trade_credit_hours  = i.work_trade_credit_hours + $3,
              updated_at = NOW()
        WHERE i.id = $1`,
      [invoiceId, round2(credit - remaining).toFixed(2), round2h(hours).toFixed(2)])
  } else {
    // Pre-S634 shape (and any invoice whose rent was never suspended): the total
    // DID include the charge, so the credit comes off it.
    await client.query(
      `UPDATE invoices
          SET total_amount = GREATEST(0, total_amount - $2),
              work_trade_credit_amount = work_trade_credit_amount + $2,
              work_trade_credit_hours  = work_trade_credit_hours + $3,
              updated_at = NOW()
        WHERE id = $1`,
      [invoiceId, round2(credit - remaining).toFixed(2), round2h(hours).toFixed(2)])
  }
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

    // S643 — AN UNTRACKED TRADE STILL HAS TO ZERO THE BILL.
    //
    // Two of the live agreements (MH 02, MH 10) have tracks_hours = false: the
    // landlord does not log hours, the trade simply covers the rent. Those open
    // with target_hours = 0, so `hoursAppliedNow` is 0 forever — and this gate
    // was on HOURS, which meant creditInvoice never ran for them. The period
    // would have closed as `settled` with the full $460 recorded as credited
    // while the rent row stayed `pending`, suspended, at $460, with the invoice
    // total at $0. The books and the bill would have disagreed permanently, and
    // that row is exactly the kind of never-clearing "pending" Nic does not want
    // a landlord looking at.
    //
    // periodCredit already answers this correctly — no target means the whole
    // basis is covered — so gate on the MONEY it produced, not on hours. A
    // re-run cannot double-credit: the period leaves `open` and loadOpenPeriods
    // never picks it up again.
    const creditNow = row.targetHours > 0
      ? round2(out.hoursAppliedNow * row.hourRate)
      : out.creditTotal
    if (creditNow > 0 && row.invoiceId) {
      await creditInvoice(client, row.invoiceId, creditNow, out.hoursAppliedNow)
    }

    await client.query(
      `UPDATE work_trade_settlements
          -- S648: only the period being closed learns its hours. A carried-over
          -- older period keeps the hours it was closed with — this used to
          -- overwrite them with 0 on every later close (and on ending).
          SET hours_worked   = COALESCE($2, hours_worked),
              hours_applied  = $3,
              credit_applied = $4,
              status         = $5,
              settled_at     = CASE WHEN $5 = 'settled' THEN NOW() ELSE settled_at END,
              updated_at     = NOW()
        WHERE id = $1`,
      [row.id,
       hoursWorkedByMonth.has(out.periodMonth)
         ? round2h(hoursWorkedByMonth.get(out.periodMonth) ?? 0).toFixed(2) : null,
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
                         AND ws.period_month <= $1::date)
          -- S648: calendar-month agreements only (rent due on the 1st). A
          -- tenant due on another day is closed by runDueWorkTradeSettlements.
          AND NOT EXISTS (SELECT 1 FROM work_trade_settlements ws2
                           WHERE ws2.agreement_id = wta.id AND ws2.period_start <> ws2.period_month)`,
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
        const closingIdx = periods.findIndex(p => p.label === periodMonth)
        const ordered = closingIdx >= 0
          ? [...periods.filter((_, i) => i !== closingIdx), periods[closingIdx]]
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
        await client.query(
          `UPDATE work_trade_settlements SET close_run_at = COALESCE(close_run_at, NOW())
            WHERE agreement_id = $1 AND period_month = $2::date`, [a.id, periodMonth])
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
 * S648 (Nic): "work trade settlement for anniversary tenants should count from
 * each tenant's own due date."
 *
 * Closes every period that runs due-date to due-date (not a calendar month)
 * and ended before `todayIso`, exactly once. Hours logged between the period's
 * own start and end pay for it; everything after that — the bank, older
 * deficits carried forward, billing one that outlived the landlord's window —
 * is the same settleMonth arithmetic the calendar close uses.
 */
export async function runDueWorkTradeSettlements(todayIso: string): Promise<SettlementRunResult> {
  const run: SettlementRunResult = {
    agreementsProcessed: 0, periodsSettled: 0, periodsBilled: 0,
    agreementsEnded: 0, errors: [],
  }
  const client = await getClient()
  try {
    const { rows: closing } = await client.query(
      `SELECT ws.id, ws.agreement_id,
              to_char(ws.period_start,'YYYY-MM-DD') AS period_start,
              to_char(ws.period_end,'YYYY-MM-DD') AS period_end,
              to_char(ws.period_month,'YYYY-MM-DD') AS period_month
         FROM work_trade_settlements ws
         JOIN work_trade_agreements wta ON wta.id = ws.agreement_id AND wta.status = 'active'
        WHERE ws.close_run_at IS NULL
          AND ws.period_start <> ws.period_month
          AND ws.period_end < $1::date
        ORDER BY ws.agreement_id, ws.period_start`, [todayIso])

    for (const c of closing) {
      try {
        await client.query('BEGIN')
        const { rows } = await client.query(
          `SELECT wta.id, wta.landlord_id, wta.unit_id, wta.tenant_id,
                  wta.banked_hours::float AS banked_hours, wta.carry_forward_months,
                  (SELECT l.id FROM leases l
                     JOIN lease_tenants lt ON lt.lease_id = l.id
                    WHERE l.unit_id = wta.unit_id AND lt.tenant_id = wta.tenant_id
                      AND lt.status = 'active'
                    ORDER BY l.start_date DESC LIMIT 1) AS lease_id
             FROM work_trade_agreements wta WHERE wta.id = $1 AND wta.status = 'active'`,
          [c.agreement_id])
        const a = rows[0]
        const periods = a ? await loadOpenPeriods(client, a.id, c.period_month, c.period_start) : []
        const closingIdx = periods.findIndex(p => p.id === c.id)
        if (!a || closingIdx < 0) {
          // Already settled or billed by an earlier pass — just record the close.
          await client.query(`UPDATE work_trade_settlements SET close_run_at = NOW() WHERE id = $1`, [c.id])
          await client.query('COMMIT')
          continue
        }
        const ordered = [...periods.filter((_, i) => i !== closingIdx), periods[closingIdx]]
        const { rows: hrs } = await client.query(
          `SELECT COALESCE(SUM(hours), 0)::float AS h FROM work_trade_logs
            WHERE agreement_id = $1 AND status = 'approved'
              AND work_date BETWEEN $2::date AND $3::date`,
          [a.id, c.period_start, c.period_end])
        const worked = Number(hrs[0]?.h ?? 0)
        const result = settleMonth({
          periods: ordered,
          hoursWorked: worked,
          bankedHours: Number(a.banked_hours),
          carryForwardMonths: Number(a.carry_forward_months),
        })
        await persist(client, a, ordered, new Map([[c.period_start, worked]]), result, run)
        await client.query(`UPDATE work_trade_settlements SET close_run_at = NOW() WHERE id = $1`, [c.id])
        await client.query('COMMIT')
        run.agreementsProcessed++
      } catch (e: unknown) {
        await client.query('ROLLBACK').catch(() => {})
        const error = e instanceof Error ? e.message : String(e)
        run.errors.push({ agreement_id: c.agreement_id, error })
        logger.error({ err: e, agreement_id: c.agreement_id }, '[WorkTradeSettlement] due-date close failed')
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
