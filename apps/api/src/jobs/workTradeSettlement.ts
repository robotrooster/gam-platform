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
import { emitPaymentSettledEvent } from '../services/creditLedgerEmitters'

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

/**
 * Rows a work-trade credit may land on — and so the rows a shortfall sits on.
 * Late fees and one-off charges are never creditable: a fine is not a cost of
 * living somewhere, and the agreement did not price it. S654: nor is a fee GAM
 * keeps (a declined-card fee rides the same invoice) — the trade is between the
 * tenant and the landlord.
 */
const CREDITABLE_ROW = `p.type IN ('rent','utility','fee')
        AND COALESCE(p.entry_description,'') <> 'LATEFEE'
        AND p.revenue_owner = 'landlord'`

// S648: a period's identity is its START date. With the 1st as the due day
// that is the month label itself, so nothing changes for calendar tenants; a
// tenant due on the 15th can have two periods labeled with one month (the
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

type LoadedPeriod = SettlementPeriod & { id: string; invoiceId: string | null; label: string }

/**
 * S654 — APPROVALS THAT LAND AFTER THEIR MONTH CLOSED.
 *
 * The cron closes a month at 2:15am on the 1st, so the last days' hours are
 * approved after it nearly every month. Only a manual re-run of that month, or
 * the agreement's end, used to count them; an older open period that aged out
 * at a later close was billed without them (carry 0, 60 of 80 September hours,
 * 20 more approved for Sept 30: the October close billed September $125 and
 * ended the agreement).
 *
 * At every close, before settleMonth, each OLDER open period gets the approved
 * hours inside its own dates that its close has not counted: approved minus
 * hours_worked, the rule settleAgreementOnEnd uses. They land on that period
 * first, at its own frozen rate; what it cannot use joins the bank. Its
 * hours_worked then records them, so no later close, re-run or ending counts
 * them again. As at a close, the record only rises: hours un-approved later
 * are not taken back. (A SETTLED period's late hours go straight to the bank:
 * bankSettledLateApprovals.)
 *
 * `closingId` is the period this run closes, whose own hours the caller counts.
 * A period that asks for no hours (tracks_hours = false) is skipped: it is
 * covered outright, and hours logged on it anyway were never banked time.
 *
 * Returns the periods with the late hours already applied, the hours applied
 * to each (by periodMonth, for the invoice credit), the hours_worked to record,
 * and the hours for the bank.
 */
async function countLateApprovals(
  client: PoolClient, agreementId: string, periods: LoadedPeriod[], closingId: string | null,
): Promise<{
  periods: LoadedPeriod[]
  appliedNow: Map<string, number>
  hoursWorked: Map<string, number>
  banked: number
}> {
  const appliedNow = new Map<string, number>()
  const hoursWorked = new Map<string, number>()
  const older = periods.filter(p => p.id !== closingId && p.targetHours > 0)
  if (older.length === 0) return { periods, appliedNow, hoursWorked, banked: 0 }

  const { rows } = await client.query(
    `SELECT ws.id, ws.hours_worked::float AS counted,
            COALESCE((SELECT SUM(l.hours) FROM work_trade_logs l
                       WHERE l.agreement_id = ws.agreement_id AND l.status = 'approved'
                         AND l.work_date BETWEEN ws.period_start AND ws.period_end), 0)::float AS approved
       FROM work_trade_settlements ws
      WHERE ws.agreement_id = $1 AND ws.id = ANY($2::uuid[])`,
    [agreementId, older.map(p => p.id)])
  const late = new Map<string, { approved: number; extra: number }>()
  for (const r of rows) {
    const extra = round2h(Number(r.approved) - Number(r.counted))
    if (extra > 0) late.set(r.id, { approved: round2h(Number(r.approved)), extra })
  }

  let banked = 0
  const out = periods.map(p => {
    const l = late.get(p.id)
    if (!l) return p
    const used = Math.min(l.extra, Math.max(0, round2h(p.targetHours - p.hoursApplied)))
    banked = round2h(banked + l.extra - used)
    appliedNow.set(p.periodMonth, used)
    hoursWorked.set(p.periodMonth, l.approved)
    return { ...p, hoursApplied: round2h(p.hoursApplied + used) }
  })
  return { periods: out, appliedNow, hoursWorked, banked }
}

/**
 * S654 — APPROVALS THAT LAND AFTER THEIR MONTH SETTLED.
 *
 * The 2:15am close on the 1st covers a month (from the bank, or because it was
 * already worked in full) and the month settles; the last days' hours are
 * approved a few hours later. They used to be dropped: no close, re-run or
 * ending looked at a settled month again. Bank 20, September 60 of 80 at its
 * close, 20 more September hours approved, October 60 of 80: October owed $125
 * with 160 hours approved or banked against the 160 asked.
 *
 * A settled month wants nothing more, so those hours are surplus and join the
 * bank, like any hour worked past a target: approved hours inside the period's
 * own dates minus its hours_worked, the same counted-once rule as
 * countLateApprovals. hours_worked then records the approved total, so no
 * later close, re-run or ending counts them again. The record only rises:
 * hours un-approved later are not taken back.
 *
 * Only `settled` periods that ask for hours. One that asks for none
 * (tracks_hours = false) was covered outright, and hours logged on it anyway
 * were never banked time. A `billed` period is left out: its lapse was already
 * billed in cash when its agreement ended.
 *
 * `skipId` is a period whose own hours the caller counts this run (the
 * calendar close's own month, when a re-run finds it already settled).
 *
 * Returns the hours for the bank.
 */
async function bankSettledLateApprovals(
  client: PoolClient, agreementId: string, skipId: string | null,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT ws.id, ws.hours_worked::float AS counted,
            COALESCE((SELECT SUM(l.hours) FROM work_trade_logs l
                       WHERE l.agreement_id = ws.agreement_id AND l.status = 'approved'
                         AND l.work_date BETWEEN ws.period_start AND ws.period_end), 0)::float AS approved
       FROM work_trade_settlements ws
      WHERE ws.agreement_id = $1 AND ws.status = 'settled' AND ws.target_hours > 0
        AND ($2::uuid IS NULL OR ws.id <> $2::uuid)
      ORDER BY ws.period_start`,
    [agreementId, skipId])
  let banked = 0
  for (const r of rows) {
    const approved = round2h(Number(r.approved))
    const extra = round2h(approved - Number(r.counted))
    if (extra <= 0) continue
    banked = round2h(banked + extra)
    await client.query(
      `UPDATE work_trade_settlements SET hours_worked = $2, updated_at = NOW() WHERE id = $1`,
      [r.id, approved.toFixed(2)])
  }
  return banked
}

/** S654: the late hours countLateApprovals applied count as credited by this run. */
function withLateHours(result: SettlementResult, appliedNow: Map<string, number>): SettlementResult {
  if (appliedNow.size === 0) return result
  return {
    ...result,
    periods: result.periods.map(o => appliedNow.has(o.periodMonth)
      ? { ...o, hoursAppliedNow: round2h(o.hoursAppliedNow + (appliedNow.get(o.periodMonth) ?? 0)) }
      : o),
  }
}

/**
 * Apply `credit` dollars to an invoice's still-open rows, rent first.
 *
 * A row the credit fully covers is marked settled and noted as covered by
 * labor rather than cash — the same record the old generation-time credit
 * wrote, just produced a month later. A row it partly covers is reduced.
 *
 * S654: a credit of 0 still lifts the suspension — a billed period's month is
 * over, and its lapse is owed on its own bill.
 */
async function creditInvoice(
  client: PoolClient, invoiceId: string, credit: number, hours: number,
): Promise<void> {
  let remaining = round2(credit)
  const { rows } = await client.query(
    `SELECT p.id, p.amount::float AS amount, p.tenant_id, p.type, p.due_date
       FROM payments p
      WHERE p.invoice_id = $1 AND p.status = 'pending'
        AND ${CREDITABLE_ROW}
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
      // S652 (Nic): "let's count work trade as on time." Hours worked paid this
      // line; the resident's credit history says so — settled on its due date,
      // whatever day the month actually closed.
      if (r.tenant_id && (r.type === 'rent' || r.type === 'utility') && r.due_date) {
        await emitPaymentSettledEvent(client, {
          tenantId: r.tenant_id, paymentId: r.id, paymentType: r.type, amount: take,
          dueDate: new Date(r.due_date), settledAt: new Date(r.due_date), graceDays: null,
          stripePaymentIntentId: null, attestationSource: 'gam_workflow_auto',
          attestationEvidence: { covered_by: 'work_trade_credit', hours, invoice_id: invoiceId },
        })
      }
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
  } else if (credit > 0) {
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
 * this remainder is never fined — someone short on hours is short on labor, not
 * refusing to pay.
 *
 * S654: THE LAPSE IS ALREADY ON THE MONTH'S OWN BILL. Each close credits the
 * period's rows down to what the hours did not cover, and persist() lifts any
 * suspension before this runs. This used to add a carried balance on top: 80
 * hours asked, 60 worked, $500 bill — rent $125 AND a $125 carried balance.
 * Now only what that bill does not hold is billed separately (in practice, a
 * period with no bill). Left on the bill, it is that month's rent when paid,
 * and the Balances page — which reads bills, so never saw a carried balance
 * written here — and the tenant portal both show it once.
 */
async function billDeficit(
  client: PoolClient, period: { id: string; invoiceId: string | null },
  agreement: { id: string; landlord_id: string; unit_id: string; tenant_id: string; lease_id: string | null },
  amount: number, periodMonth: string,
): Promise<void> {
  const note = `Work-trade hours not completed for ${DateTime.fromISO(periodMonth).toFormat('LLLL yyyy')} — billed when the agreement ended`
  let separate = round2(Math.max(0, amount))

  if (period.invoiceId && separate > 0) {
    // Every creditable row counts, whatever its status: a pending row is the
    // lapse still owed, a paid one is the lapse already paid.
    const { rows } = await client.query(
      `SELECT p.id, p.amount::float AS amount, p.status
         FROM payments p
        WHERE p.invoice_id = $1 AND ${CREDITABLE_ROW}
        ORDER BY ${ROW_PRIORITY}, p.created_at`,
      [period.invoiceId])
    const held = round2(rows.reduce((s: number, r: any) => s + Number(r.amount), 0))
    // Say why on the rows that carry it, in the order the credit fills them.
    let toExplain = round2(Math.min(separate, held))
    for (const r of rows) {
      if (toExplain <= 0) break
      if (Number(r.amount) <= 0) continue
      toExplain = round2(toExplain - Number(r.amount))
      if (r.status !== 'pending') continue
      await client.query(
        `UPDATE payments SET notes = COALESCE(notes || ' — ', '') || $2 WHERE id = $1`,
        [r.id, note])
    }
    separate = round2(Math.max(0, separate - held))
  }

  if (separate > 0) {
    // No bill holds it, so it joins the carried-balance track: outside FIFO and
    // payable in part (S622).
    await client.query(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, notes)
       VALUES ($1, $2, $3, $4, 'carried_balance', $5, 'pending', 'BALANCE',
               CURRENT_DATE, $6)`,
      [agreement.unit_id, agreement.lease_id, agreement.tenant_id, agreement.landlord_id,
       separate.toFixed(2), note])
  }
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
    // S654: a billed period runs through here even with nothing to credit, so
    // its suspension lifts and the lapse is owed on its own bill (billDeficit).
    if (row.invoiceId && (creditNow > 0 || out.status === 'billed')) {
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
 * Safe to run again for the same month (S654). The month's own period records
 * the approved hours its close counted (`hours_worked`), and a later run counts
 * only the approved hours above that: a re-run with nothing new adds nothing,
 * and an approval that landed after the first run counts once, at the next.
 * This used to recount the whole month against a period still open: 80 hours
 * asked, 60 worked, September closed twice — 120 hours credited, the tenant
 * owing $0 instead of $125. A period already `settled` or `billed` is not
 * reloaded, but its recorded hours still stand against a re-run.
 *
 * An approval for an OLDER month that is still open counts at the next close
 * of any month (countLateApprovals), the same way: once, against that month's
 * own hours_worked. S654: one for a month whose period already SETTLED joins
 * the bank at the next close, also once (bankSettledLateApprovals); the next
 * close is the first one this agreement has an open period for. One for a
 * month whose period was BILLED is not counted: that lapse was billed in cash.
 *
 * Not guarded: a month with no period of its own (no bill that month). Its
 * hours land on the newest open period as a stand-in, and nothing records that
 * they were counted, so a second run counts them again; and if that month's
 * period is created after its first close (a late bill), a re-run counts them
 * again on it.
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
              wta.carry_forward_months, wta.carry_forward_indefinite,
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
          `SELECT COALESCE(SUM(hours), 0)::float AS h
             FROM work_trade_logs
            WHERE agreement_id = $1 AND status = 'approved'
              AND date_trunc('month', work_date) = $2::date`,
          [a.id, periodMonth])
        const approved = round2h(Number(hrs[0]?.h ?? 0))

        // S654: COUNT EACH APPROVED HOUR ONCE. The month's own period (open or
        // not) recorded what its earlier close counted; only the approved hours
        // above that are new. Re-runs happen — a manual run after the 2:15 cron —
        // and recounting the whole month credited a short month twice. Hours
        // un-approved after a close are never taken back, so the record only
        // rises. A month with no period of its own has nothing to subtract: the
        // stand-in's hours_worked is its own month's, not this one's.
        const { rows: ownRows } = await client.query(
          `SELECT id, status, hours_worked::float AS counted
             FROM work_trade_settlements
            WHERE agreement_id = $1 AND period_month = $2::date`,
          [a.id, periodMonth])
        const own = ownRows[0] as { id: string; status: string; counted: number } | undefined
        const counted = own ? round2h(Number(own.counted)) : 0
        const uncounted = own ? Math.max(0, round2h(approved - counted)) : approved
        // What the month's own period has counted after this run.
        const countedNow = round2h(counted + uncounted)
        const hoursWorkedByMonth = new Map<string, number>([[periodMonth, countedNow]])

        // S654: older open months' late approvals first, on their own periods.
        const late = await countLateApprovals(
          client, a.id, ordered, closingIdx >= 0 ? periods[closingIdx].id : null)
        for (const [k, v] of late.hoursWorked) if (!hoursWorkedByMonth.has(k)) hoursWorkedByMonth.set(k, v)
        // S654: settled months' late approvals go to the bank. The month being
        // closed is skipped: its own new hours are `uncounted` above.
        const settledLate = await bankSettledLateApprovals(client, a.id, own ? own.id : null)

        const result = withLateHours(settleMonth({
          periods: late.periods,
          hoursWorked: uncounted,
          bankedHours: round2h(Number(a.banked_hours) + late.banked + settledLate),
          // S652: a landlord floating the shortfall indefinitely never has it billed.
          carryForwardMonths: a.carry_forward_indefinite ? Number.POSITIVE_INFINITY : Number(a.carry_forward_months),
        }), late.appliedNow)

        await persist(client, a, late.periods, hoursWorkedByMonth, result, run)
        // S654: a month whose own period already closed is not in `ordered`, so
        // persist does not record its late approvals; record them here, or the
        // next run would count them again.
        if (own && own.status !== 'open' && countedNow > counted) {
          await client.query(
            `UPDATE work_trade_settlements SET hours_worked = $2, updated_at = NOW() WHERE id = $1`,
            [own.id, countedNow.toFixed(2)])
        }
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
 * is the same settleMonth arithmetic the calendar close uses. Late approvals
 * for older periods count the same way too: an open one's on its own period
 * (countLateApprovals), a settled one's in the bank (bankSettledLateApprovals).
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
                  wta.banked_hours::float AS banked_hours, wta.carry_forward_months, wta.carry_forward_indefinite,
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
        const worked = round2h(Number(hrs[0]?.h ?? 0))
        // S654: COUNT EACH APPROVED HOUR ONCE, as the calendar close does. A
        // period whose own close failed once had its hours counted as late at
        // the next period's close (countLateApprovals wrote its hours_worked);
        // the retried close counts only the approved hours above that. It used
        // to count them all again: 60 of 80 worked, bank 40, 20 hours short.
        const { rows: ownRows } = await client.query(
          `SELECT hours_worked::float AS counted FROM work_trade_settlements WHERE id = $1`, [c.id])
        const counted = round2h(Number(ownRows[0]?.counted ?? 0))
        const uncounted = Math.max(0, round2h(worked - counted))
        // S654: older open periods' late approvals first, on their own periods.
        const late = await countLateApprovals(client, a.id, ordered, c.id)
        // The record only rises: hours un-approved after a close are not taken back.
        const hoursWorkedByMonth = new Map<string, number>([[c.period_start, round2h(counted + uncounted)]])
        for (const [k, v] of late.hoursWorked) if (!hoursWorkedByMonth.has(k)) hoursWorkedByMonth.set(k, v)
        // S654: settled periods' late approvals go to the bank.
        const settledLate = await bankSettledLateApprovals(client, a.id, c.id)
        const result = withLateHours(settleMonth({
          periods: late.periods,
          hoursWorked: uncounted,
          bankedHours: round2h(Number(a.banked_hours) + late.banked + settledLate),
          // S652: a landlord floating the shortfall indefinitely never has it billed.
          carryForwardMonths: a.carry_forward_indefinite ? Number.POSITIVE_INFINITY : Number(a.carry_forward_months),
        }), late.appliedNow)
        await persist(client, a, late.periods, hoursWorkedByMonth, result, run)
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
    // S654: approved hours no close has counted yet — the month being ended in,
    // or an approval that landed after its close. hours_worked is what each
    // period's own close counted (persist writes it only then).
    const { rows: hrs } = await client.query(
      `SELECT to_char(ws.period_start,'YYYY-MM-DD') AS period_start,
              ws.hours_worked::float AS counted,
              COALESCE((SELECT SUM(l.hours) FROM work_trade_logs l
                         WHERE l.agreement_id = ws.agreement_id AND l.status = 'approved'
                           AND l.work_date BETWEEN ws.period_start AND ws.period_end), 0)::float AS approved
         FROM work_trade_settlements ws
        WHERE ws.agreement_id = $1 AND ws.status = 'open'
          AND ws.target_hours > 0          -- an untracked trade asks for none`, [agreementId])
    const uncounted: Record<string, number> = {}
    const hoursWorked = new Map<string, number>()
    for (const h of hrs) {
      const extra = round2h(Number(h.approved) - Number(h.counted))
      if (extra > 0) {
        uncounted[h.period_start] = extra
        hoursWorked.set(h.period_start, Number(h.approved))
      }
    }
    // S654: a settled month's late approvals are banked hours too, so they are
    // spent before anything is billed.
    const settledLate = await bankSettledLateApprovals(client, agreementId, null)
    const result = settleOnEnd(periods, round2h(Number(a.banked_hours) + settledLate), uncounted)
    await persist(client, a, periods, hoursWorked, result, run)
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
