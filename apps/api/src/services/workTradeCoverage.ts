/**
 * 10/12 (Nic, Curtis Clabough) — CHANGING WHAT A WORK TRADE COVERS REACHES THE
 * BILLS ALREADY OUT, NOT ONLY THE NEXT ONE.
 *
 *   "for some reason you're billing him water or it's set up to bill him water.
 *    His utilities should be fully covered as well."
 *
 * covered_charges is read when a bill is WRITTEN (the monthly run, the move-in
 * bill, a stay's utility bill): a covered charge goes on the bill suspended —
 * worked off, not owed — and the month close settles it from the hours. So a
 * landlord who ticked Water on the 12th changed November's bill and nothing
 * else: October's water sat on Curtis's balance as money owed.
 *
 * ADDING a type: every still-open charge of that type (pending, not on its way
 * to being paid, amount > 0, never a late fee or a fee GAM keeps) on this
 * agreement's bills is brought under the trade, the same way the monthly run
 * writes a covered charge:
 *   - a bill whose month has not been credited yet (its own close has not run,
 *     or ran with nothing to credit): the charge is PARKED — suspended, with the
 *     monthly run's note — and the month's covered basis is rebuilt from the
 *     lines parked on its bill, so the close that settles the month covers it
 *     too. (Parking without the basis was the bug in the hand repair: the close
 *     credits only the basis and then lifts every suspension, so the charge came
 *     straight back as owed.) A month a put-back left asking no hours gets the
 *     agreement's hours back.
 *     The same step brings a covered utility share released onto a bill already
 *     out under its month (services/utilityBilling attachBillToOpenInvoice —
 *     bringLinesUnderTrade).
 *   - a bill whose month was already credited (settled, or carrying a
 *     shortfall): the month is re-priced over the wider basis and the hours
 *     already applied are credited at the new price, onto the newly covered
 *     charges — what the close would have done had the coverage been there.
 *     A settled month covers them in full.
 *   - a month already BILLED in cash (the agreement ended over a lapse) is left
 *     alone, and a bill with no work-trade month at all is not parked: nothing
 *     would ever settle it. Both are counted in the result.
 *
 * REMOVING a type is the landlord's choice at that moment (Nic, 10/12):
 *   - keep_covered (the default): the open charges already parked stay parked
 *     and the month close settles them as it would have;
 *   - put_back: the still-open parked charges of that type go back on the
 *     tenant's balance — the suspension is lifted, and a month nothing has been
 *     credited against is re-priced over the lines still parked on its bill —
 *     and the bill totals are rebuilt. Charges already paid, or settled at a
 *     month close, are never touched.
 *
 * 10/12: a month nothing has been credited against takes its basis from the
 * lines parked on its bill, never basis ± the lines changed. A line parked
 * without the basis growing (a share attached before bringLinesUnderTrade, the
 * 10/12 hand script before its resync) was never in the basis, so taking it
 * back out shrank the month below the charges it still covers: put back $100
 * of water on a $450-rent month that never counted the water and the hour fell
 * from $18 to $14, the 25 hours bought $350 and $100 of RENT came back owed —
 * a removal that created debt.
 *
 * Totals are rebuilt with the S634 rule (oct1_billing_repair step 3): what is
 * owed on a bill is the sum of its lines that are not suspended. Late fees are
 * left out — they live in invoices.subtotal_late_fees, not total_amount — and
 * so are voided lines.
 */
import type { PoolClient } from 'pg'
import { WORK_TRADE_COVERABLE, type WorkTradeCoverageRemovalChoice } from '@gam/shared'
import { round2 } from './workTradeCredit'
import { hourRateFor, periodCredit } from './workTradeSettlement'
import { syncBillMarksAfterSettle } from './creditLedgerEmitters'

type Q = Pick<PoolClient, 'query'>

/** The monthly run's note on a covered line (jobs/invoiceGeneration). */
export const WT_SUSPENDED_NOTE = 'Work trade — suspended while the hours are worked; settled at month close'
/** The month close's note on a line the hours paid (jobs/workTradeSettlement). */
const WT_CREDITED_NOTE = 'Covered by work-trade credit'
/** A parked line put back on the tenant's balance. */
const PUT_BACK_NOTE = 'No longer covered by the work trade — owed'

const UTILITIES = ['water', 'sewer', 'electric', 'gas', 'trash'] as const

/**
 * The S634 bill total, for `UPDATE invoices i SET total_amount = ...`: the lines
 * actually owed — not suspended, not a late fee (subtotal_late_fees holds
 * those), not failed or voided.
 */
export const BILL_TOTAL_SQL = `COALESCE((
  SELECT SUM(p.amount) FROM payments p
   WHERE p.invoice_id = i.id
     AND p.work_trade_suspended_at IS NULL
     AND p.type <> 'late_fee'
     AND p.status NOT IN ('failed', 'voided')), 0)`

/**
 * What a bill line is, in WORK_TRADE_COVERABLE terms (needs `p`, `i` and the
 * lateral `ub`). NULL = never covered: a one-off charge, a deposit, a home
 * payment. A utility on a LEASE bill that belongs to another landlord's service
 * agreement (converged, S616) is never covered; on the service agreement's own
 * bill (a stay) it is the stay's utility. A utility line with no meter bill
 * behind it is 'all_utilities' — covered only when every utility is, the rule
 * oct1_billing_repair used.
 */
const KIND_SQL = `CASE
  WHEN p.type = 'rent' THEN 'rent'
  WHEN p.type = 'fee' AND p.entry_description = 'SUBSCRIP' THEN 'fees'
  WHEN p.type = 'utility' AND p.entry_description = 'PROPANE' THEN 'propane'
  WHEN p.type = 'utility' AND ub.id IS NOT NULL
       AND (ub.service_agreement_id IS NULL OR i.service_agreement_id IS NOT NULL) THEN ub.utility_type
  WHEN p.type = 'utility' AND p.entry_description = 'UTILITY' AND ub.id IS NULL THEN 'all_utilities'
END`

const UB_JOIN = `LEFT JOIN LATERAL (
    SELECT u.id, u.utility_type, u.service_agreement_id
      FROM utility_bills u WHERE u.payment_id = p.id LIMIT 1) ub ON TRUE`

/** This agreement's bills (not void): the ones it is stamped on, and any its months are opened against. */
const BILLS_SQL = `SELECT i.id FROM invoices i
                    WHERE i.work_trade_agreement_id = $1 AND i.status <> 'void'
                   UNION
                   SELECT s.invoice_id FROM work_trade_settlements s
                     JOIN invoices i ON i.id = s.invoice_id
                    WHERE s.agreement_id = $1 AND i.status <> 'void' AND s.status <> 'voided'`

/** A line is a creditable, landlord-owed, not-a-fine line (jobs/workTradeSettlement CREDITABLE_ROW). */
const CREDITABLE = `p.type IN ('rent','utility','fee')
     AND p.type <> 'late_fee'
     AND COALESCE(p.entry_description,'') <> 'LATEFEE'
     AND p.revenue_owner = 'landlord'`

/** Which kinds of line a change of coverage reaches, in KIND_SQL's terms. */
function kindsChanged(from: readonly string[], to: readonly string[]): string[] {
  const changed: string[] = WORK_TRADE_COVERABLE.filter(k => from.includes(k) !== to.includes(k))
  const allUtil = (xs: readonly string[]) => UTILITIES.every(u => xs.includes(u))
  if (allUtil(from) !== allUtil(to)) changed.push('all_utilities')
  return changed
}

/** Normalize a stored coverage list: empty means everything (the billing runs' reading). */
function effective(covered: readonly string[] | null | undefined): string[] {
  return covered && covered.length ? [...covered] : [...WORK_TRADE_COVERABLE]
}

export interface CoverageChangeResult {
  /** Lines parked under the trade, to be settled at their month's close. */
  parked: number
  parkedAmount: number
  /** Lines on an already-credited month, covered now by the hours already applied. */
  covered: number
  coveredAmount: number
  /** Parked lines put back on the tenant's balance (removal, put_back). */
  putBack: number
  putBackAmount: number
  /** Open lines of a newly covered type the trade cannot reach (no work-trade month, or a month billed in cash). */
  notReached: number
  notReachedAmount: number
}

/** A bill line a coverage change reaches (due_date 'YYYY-MM-DD'). */
export interface TradeLine {
  id: string; invoice_id: string; amount: number; type: string
  tenant_id: string | null; due_date: string | null
}
type Line = TradeLine

/** What the agreement asks of a month, read once per change. */
interface AgreementHours { monthly_hours_target: number; tracks_hours: boolean }

async function agreementHours(run: Q, agreementId: string): Promise<AgreementHours> {
  const r = (await run.query<AgreementHours>(
    `SELECT monthly_hours_target::float AS monthly_hours_target, tracks_hours
       FROM work_trade_agreements WHERE id = $1`, [agreementId])).rows[0]
  return r ?? { monthly_hours_target: 0, tracks_hours: false }
}

/**
 * A month nothing has been credited against, priced over the lines parked on
 * its bill — the creditable lines still pending and suspended (the rule
 * scripts/oct12_work_trade_basis_resync used). Its basis is what the close
 * will credit before it lifts every suspension on the bill, so it must be
 * exactly what is parked there.
 */
async function parkedBasis(run: Q, invoiceId: string): Promise<number> {
  const r = (await run.query<{ basis: number }>(
    `SELECT COALESCE(SUM(p.amount), 0)::float AS basis FROM payments p
      WHERE p.invoice_id = $1 AND p.status = 'pending'
        AND p.work_trade_suspended_at IS NOT NULL
        AND ${CREDITABLE}`, [invoiceId])).rows[0]
  return round2(Number(r?.basis ?? 0))
}

interface Period {
  id: string; status: string; target_hours: number; hours_applied: number
  basis_amount: number; hour_rate: number; credit_applied: number
}

async function periodFor(run: Q, agreementId: string, invoiceId: string): Promise<Period | null> {
  return (await run.query<Period>(
    `SELECT id, status, target_hours::float AS target_hours, hours_applied::float AS hours_applied,
            basis_amount::float AS basis_amount, hour_rate::float AS hour_rate,
            credit_applied::float AS credit_applied
       FROM work_trade_settlements
      WHERE agreement_id = $1 AND invoice_id = $2
        -- 10/12 (G8): a voided period is a record and credits nothing.
        AND status <> 'voided'
      ORDER BY period_start DESC LIMIT 1
      FOR UPDATE`, [agreementId, invoiceId])).rows[0] ?? null
}

function byInvoice(lines: Line[]): Map<string, Line[]> {
  const m = new Map<string, Line[]>()
  for (const l of lines) m.set(l.invoice_id, [...(m.get(l.invoice_id) ?? []), l])
  return m
}

const sum = (xs: Line[]) => round2(xs.reduce((s, l) => s + Number(l.amount), 0))

export type BringUnderOutcome = 'parked' | 'covered' | 'not_reached'

/**
 * Bring open, unsuspended lines on ONE of the agreement's bills under the
 * trade — the step a coverage change takes for each bill (applyCoverageChange)
 * and a covered utility share released onto a bill already out takes for its
 * own line (services/utilityBilling attachBillToOpenInvoice). Lines must be
 * pending, amount > 0 and not suspended; the caller rebuilds the bill total.
 *   parked      — the month has not been credited: the lines are suspended and
 *                 the month is re-priced over everything parked on the bill.
 *                 `amount` = the lines.
 *   covered     — the month was credited already: priced over the wider basis,
 *                 the hours already applied pay the lines down; what they
 *                 cannot cover stays owed. `amount` = the credit applied.
 *   not_reached — no work-trade month on the bill, or one billed in cash:
 *                 nothing would ever settle a parked line, so it stays owed.
 */
export async function bringLinesUnderTrade(
  run: Q, agreementId: string, invoiceId: string, rows: TradeLine[], hours?: AgreementHours,
): Promise<{ outcome: BringUnderOutcome; amount: number }> {
  const w = sum(rows)
  const period = await periodFor(run, agreementId, invoiceId)
  if (!period || period.status === 'billed') return { outcome: 'not_reached', amount: w }
  const uncredited = period.status === 'open' && period.hours_applied === 0 && period.credit_applied === 0

  if (uncredited) {
    // Parked exactly as the monthly run writes a covered line.
    await run.query(
      `UPDATE payments
          SET work_trade_suspended_at = NOW(),
              notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || ' — ' || $2 END
        WHERE id = ANY($1::uuid[])`,
      [rows.map(r => r.id), WT_SUSPENDED_NOTE])
    // 10/12: a month a put-back left asking no hours (nothing was covered on
    // it) asks the agreement's hours again now that something is. Left at 0,
    // periodCredit read it as "covered outright": the month was waived with no
    // hours worked, and in pay mode every hour of it was paid as extra. An
    // agreement that does not count hours asks none, as when it was billed.
    const h = hours ?? await agreementHours(run, agreementId)
    const target = period.target_hours === 0 && h.tracks_hours && h.monthly_hours_target > 0
      ? Number(h.monthly_hours_target) : period.target_hours
    const basis = await parkedBasis(run, invoiceId)
    await run.query(
      `UPDATE work_trade_settlements
          SET basis_amount = $2, hour_rate = $3, target_hours = $4, updated_at = NOW()
        WHERE id = $1`,
      [period.id, basis.toFixed(2), hourRateFor(basis, target).toFixed(4), target.toFixed(2)])
    return { outcome: 'parked', amount: w }
  }

  // The month was credited already: price it over the wider basis and credit
  // the hours it already has at that price. A carried hour keeps its month's
  // value against a RENT change (S624); this is different — the landlord
  // widened what the month's hours pay for.
  const basis = round2(period.basis_amount + w)
  const target = period.target_hours
  const rate = target > 0 ? hourRateFor(basis, target) : 0
  const credit = periodCredit(basis, target, period.hours_applied, rate)
  let delta = round2(Math.min(w, Math.max(0, credit - period.credit_applied)))
  const applied = delta
  for (const r of rows) {
    if (delta <= 0) break
    const take = Math.min(delta, Number(r.amount))
    const net = round2(Number(r.amount) - take)
    delta = round2(delta - take)
    if (net === 0) {
      // 10/12 (Nic, ledger P1): the credit is stored on the row as it lowers
      // the amount (work_trade_credit) — the same fact the month close writes.
      await run.query(
        `UPDATE payments
            SET amount = 0, status = 'settled', settled_at = NOW(),
                work_trade_credit = work_trade_credit + $3::numeric,
                notes = COALESCE(notes || ' — ', '') || $2
          WHERE id = $1`, [r.id, WT_CREDITED_NOTE, take.toFixed(2)])
      // S652 (Nic): "let's count work trade as on time" — as the close does:
      // the bill's one mark is judged once, below, after the credit is on the
      // invoice (10/12, review: judged here, per line, it read the bill before
      // work_trade_credit_amount moved and withdrew a good mark only to write
      // it again).
    } else {
      await run.query(
        `UPDATE payments SET amount = $2, work_trade_credit = work_trade_credit + $3::numeric WHERE id = $1`,
        [r.id, net.toFixed(2), take.toFixed(2)])
    }
  }
  await run.query(
    `UPDATE work_trade_settlements
        SET basis_amount = $2, hour_rate = $3, credit_applied = $4, updated_at = NOW()
      WHERE id = $1`,
    [period.id, basis.toFixed(2), rate.toFixed(4), round2(period.credit_applied + applied).toFixed(2)])
  if (applied > 0) {
    await run.query(
      `UPDATE invoices SET work_trade_credit_amount = work_trade_credit_amount + $2, updated_at = NOW()
        WHERE id = $1`, [invoiceId, applied.toFixed(2)])
    // 10/12 (Nic): "one mark per invoice." The bill's payment-history mark,
    // judged now the period's credit is applied and on the invoice.
    await syncBillMarksAfterSettle(run as PoolClient, rows.map(r => r.id))
  }
  // What the hours already applied could not cover is part of the month's
  // lapse — owed on its bill like the rest of it, and paid down by catch-up
  // hours at the month's new price.
  return { outcome: 'covered', amount: applied }
}

/**
 * Apply a change of covered_charges to the agreement's bills already out.
 * Call inside the transaction that writes the new covered_charges.
 */
export async function applyCoverageChange(run: Q, args: {
  agreementId: string
  from: readonly string[] | null | undefined
  to: readonly string[] | null | undefined
  /** What to do with open parked charges of a type taken off. Default keep_covered. */
  removal?: WorkTradeCoverageRemovalChoice
}): Promise<CoverageChangeResult> {
  const out: CoverageChangeResult = {
    parked: 0, parkedAmount: 0, covered: 0, coveredAmount: 0,
    putBack: 0, putBackAmount: 0, notReached: 0, notReachedAmount: 0,
  }
  const from = effective(args.from)
  const to = effective(args.to)
  const changed = kindsChanged(from, to)
  if (changed.length === 0) return out
  const nowCovers = (k: string) => k === 'all_utilities' ? UTILITIES.every(u => to.includes(u)) : to.includes(k)
  const added = changed.filter(nowCovers)
  const removed = changed.filter(k => !nowCovers(k))
  const touched = new Set<string>()
  const hours = await agreementHours(run, args.agreementId)

  // ── ADDED: bring the still-open lines of these kinds under the trade ──────
  if (added.length) {
    const lines = (await run.query<Line>(
      `SELECT p.id, p.invoice_id, p.amount::float AS amount, p.type, p.tenant_id,
              to_char(p.due_date, 'YYYY-MM-DD') AS due_date
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         ${UB_JOIN}
        WHERE p.invoice_id IN (${BILLS_SQL})
          AND p.status = 'pending' AND p.amount > 0
          -- A payment already on its way is not an open charge to re-decide.
          AND p.stripe_payment_intent_id IS NULL
          AND p.work_trade_suspended_at IS NULL
          AND ${CREDITABLE}
          AND (${KIND_SQL}) = ANY($2::text[])
        ORDER BY CASE p.type WHEN 'rent' THEN 0 WHEN 'utility' THEN 1 WHEN 'fee' THEN 2 ELSE 3 END,
                 p.created_at
        FOR UPDATE OF p`,
      [args.agreementId, added])).rows

    for (const [invoiceId, rows] of byInvoice(lines)) {
      const r = await bringLinesUnderTrade(run, args.agreementId, invoiceId, rows, hours)
      if (r.outcome === 'not_reached') {
        out.notReached += rows.length
        out.notReachedAmount = round2(out.notReachedAmount + r.amount)
        continue
      }
      if (r.outcome === 'parked') {
        out.parked += rows.length
        out.parkedAmount = round2(out.parkedAmount + r.amount)
      } else {
        out.covered += rows.length
        out.coveredAmount = round2(out.coveredAmount + r.amount)
      }
      touched.add(invoiceId)
    }
  }

  // ── REMOVED, put back: lift the suspension on the still-open lines ────────
  if (removed.length && args.removal === 'put_back') {
    const lines = (await run.query<Line>(
      `SELECT p.id, p.invoice_id, p.amount::float AS amount, p.type, p.tenant_id,
              to_char(p.due_date, 'YYYY-MM-DD') AS due_date
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         ${UB_JOIN}
        WHERE p.invoice_id IN (${BILLS_SQL})
          AND p.status = 'pending'
          AND p.work_trade_suspended_at IS NOT NULL
          AND ${CREDITABLE}
          AND (${KIND_SQL}) = ANY($2::text[])
        FOR UPDATE OF p`,
      [args.agreementId, removed])).rows

    for (const [invoiceId, rows] of byInvoice(lines)) {
      const w = sum(rows)
      await run.query(
        `UPDATE payments
            SET work_trade_suspended_at = NULL,
                notes = CONCAT_WS(' — ',
                  NULLIF(regexp_replace(COALESCE(notes, ''),
                    '( — )?(Work trade — suspended while the hours are worked; settled at month close|work trade, suspended until month close|Covered by work trade)$', ''), ''),
                  $2::text)
          WHERE id = ANY($1::uuid[])`,
        [rows.map(r => r.id), PUT_BACK_NOTE])
      const period = await periodFor(run, args.agreementId, invoiceId)
      if (period && period.status === 'open') {
        const uncredited = period.hours_applied === 0 && period.credit_applied === 0
        // Nothing credited yet: priced over what is still parked on the bill
        // (see the header) — never the old basis less these lines, which may
        // never have been in it. A credited month keeps the money its hours
        // already bought.
        const basis = uncredited
          ? await parkedBasis(run, invoiceId)
          : round2(Math.max(period.credit_applied, period.basis_amount - w))
        if (uncredited && basis <= 0) {
          // Nothing on this month is covered any more, so it asks for no hours
          // — a month that asks hours against a $0 basis could only ever be
          // "billed" $0 and end the agreement over nothing.
          await run.query(
            `UPDATE work_trade_settlements
                SET basis_amount = 0, hour_rate = 0, target_hours = 0, updated_at = NOW()
              WHERE id = $1`, [period.id])
        } else if (uncredited) {
          await run.query(
            `UPDATE work_trade_settlements SET basis_amount = $2, hour_rate = $3, updated_at = NOW() WHERE id = $1`,
            [period.id, basis.toFixed(2),
             (period.target_hours > 0 ? hourRateFor(basis, period.target_hours) : 0).toFixed(4)])
        } else {
          await run.query(
            `UPDATE work_trade_settlements SET basis_amount = $2, updated_at = NOW() WHERE id = $1`,
            [period.id, basis.toFixed(2)])
        }
      }
      out.putBack += rows.length
      out.putBackAmount = round2(out.putBackAmount + w)
      touched.add(invoiceId)
    }
  }

  if (touched.size) {
    await run.query(
      `UPDATE invoices i SET total_amount = ${BILL_TOTAL_SQL}, updated_at = NOW()
        WHERE i.id = ANY($1::uuid[])`, [[...touched]])
  }
  return out
}

/**
 * Open charges parked under this agreement right now, by kind — what the
 * landlord is asked about when unticking a type ("Keep the open Water charges
 * covered" / "Put them back on the tenant's balance"). A utility line with no
 * meter bill behind it is counted under every utility, since taking any one off
 * takes it off.
 */
export async function openCoveredByKind(run: Q, agreementId: string): Promise<Record<string, { count: number; amount: number }>> {
  const rows = (await run.query<{ kind: string; count: number; amount: number }>(
    `SELECT k.kind, COUNT(*)::int AS count, COALESCE(SUM(k.amount), 0)::float AS amount
       FROM (SELECT (${KIND_SQL}) AS kind, p.amount
               FROM payments p
               JOIN invoices i ON i.id = p.invoice_id
               ${UB_JOIN}
              WHERE p.invoice_id IN (${BILLS_SQL})
                AND p.status = 'pending'
                AND p.work_trade_suspended_at IS NOT NULL
                AND ${CREDITABLE}) k
      WHERE k.kind IS NOT NULL
      GROUP BY k.kind`, [agreementId])).rows
  const out: Record<string, { count: number; amount: number }> = {}
  const add = (k: string, c: number, a: number) => {
    const cur = out[k] ?? { count: 0, amount: 0 }
    out[k] = { count: cur.count + c, amount: round2(cur.amount + a) }
  }
  for (const r of rows) {
    if (r.kind === 'all_utilities') for (const u of UTILITIES) add(u, Number(r.count), Number(r.amount))
    else add(r.kind, Number(r.count), Number(r.amount))
  }
  return out
}
