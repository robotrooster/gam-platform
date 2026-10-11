/**
 * 10/6 (Nic) — late fees ZEROED by a reversal since 10/5, put into the new
 * form: the fee as charged, with a credit against it, and the bill's payment
 * marked late.
 *
 *   "Late fees are not automatically on time because of the onboarding month.
 *    That's the landlord's discretion. ... So the late fee is only available to
 *    be completely deleted during the onboarding month. Other than that, they
 *    get a credit against their bill and the late payment still shows on their
 *    payment history." Of a tenant who reported their deposit first: "No
 *    exceptions".
 *
 * Between 10/5 and this change, a late fee a bank deposit's date showed was
 * never owed had its amount set to $0 (note "Reversed: rent was paid …"), and
 * the bill's payment counted from the deposit's date (or, on the onboarding
 * bill, got no late mark at all). For each such fee still there — a fee the
 * landlord deleted on an onboarding bill is gone already and stays gone:
 *   1. its amount comes back to what was charged (the row's own change
 *      history, audit_row_changes, holds it; else the bank match's undo
 *      record), owed again for an instant inside the transaction;
 *   2. a late-fee credit is applied to it (services/lateFeeCredit.creditLateFee)
 *      so the bill still nets to zero;
 *   3. a bank match's undo record that listed it as zeroed lists it as
 *      credited instead, so Undo takes the credit back exactly;
 *   4. each rent and utility row on its bill that was paid while the fee was
 *      on it (recorded in GAM at or after the fee was charged) gets the mark
 *      the rule gives (creditLedgerEmitters.correctMarkForLateFeeOnBill:
 *      LATE, counted from the day the payment was recorded — the day the fee
 *      was zeroed — the old mark superseded, never edited). A row paid before
 *      the fee was charged keeps its mark, as it would live.
 * Every change is printed. Run twice, the second run finds nothing (the fees
 * are no longer at $0).
 *
 * 10/6 (Nic, "Yes, build it") — the confirmed table: when a BANK LINE was
 * matched to the bill, the bank's date decides — a late fee charged after it
 * is ZEROED and the payment counts from that day, on time if on time. "If it
 * was deposited on the 3rd, and the landlord chose to log it on the 5th or
 * the 6th, we're not going to just waive the late fee and still show that
 * they paid late. It's determined by the matching transaction from the bank
 * log." So:
 *   A. Only fees zeroed by a deposit LOGGED BY HAND are put into the credited
 *      form above. A fee a bank match zeroed (listed in a matched bank line's
 *      undo record, or on a bill a bank line is tied to through
 *      bank_deposit_allocations) is the bank's decision and stays at $0.00
 *      (skipped, with why).
 *   B. correctBankMatchedCreditedFees — for the case this ran before that
 *      rule, and for bank matches made while 0763a6b was live (they credited
 *      the fee and marked the payment late): each fee a bank match CREDITED
 *      as never owed (a matched bank line's undo record lists it under
 *      lateFeesCredited, it carries no other credit) has its late-fee credit
 *      withdrawn and is zeroed with the bank's note
 *      (lateFeeCredit.BANK_SHOWS_LATE_FEE_NOTE), the undo record lists it as
 *      zeroed (Undo puts it back as it was before the match), and the marks of
 *      the rows that bank line paid are re-rated from the bank-validated day
 *      (bank_deposit_allocations.effective_paid_date) through the correction
 *      chain (creditLedgerEmitters.reRateMarksFromBankDate). A bank line tied
 *      to a deposit logged by hand (kind 'recorded_deposit') is never touched:
 *      the fees it credited could not be zeroed. Run twice, the second run
 *      finds nothing.
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back.
 * --apply commits. Scores of the tenants whose marks changed are recomputed
 * after the commit.
 *   cd apps/api && npx ts-node -T src/scripts/oct6_fix_reversed_late_fees.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct6_fix_reversed_late_fees.ts --apply
 */
import type { PoolClient } from 'pg'
import { lockHousehold } from '../services/moneyPredicates'
import { creditLateFee, withdrawLateFeeCredit, BANK_SHOWS_LATE_FEE_NOTE, type CreditedLateFee } from '../services/lateFeeCredit'
import {
  correctMarkForLateFeeOnBill, reRateMarksFromBankDate, type LateFeeMarkCorrection, type BankDateMarkCorrection,
} from '../services/creditLedgerEmitters'
import { REVERSED_LATE_FEE_NOTE } from '../services/lateFeeDelete'

export const FIX_SINCE = '2026-10-05'

export interface FixedLateFee {
  paymentId: string
  invoiceId: string | null
  tenantId: string
  amount: number
  paidOn: string
  creditId: string
  undoRecordUpdated: string | null
  marks: LateFeeMarkCorrection[]
}

export interface FixReport {
  fixed: FixedLateFee[]
  /** Zeroed fees that could not be put into the new form, and why (left exactly as they were). */
  skipped: Array<{ paymentId: string; why: string }>
  /** Credit subjects whose marks changed (scores to recompute after the commit). */
  subjects: string[]
}

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)

/** The zeroed fee as it was before the reversal, from its own change history, else a bank match's undo record. */
async function priorOf(
  client: PoolClient, paymentId: string,
): Promise<{ amount: number; status: string; notes: string | null; zeroedAt: Date | null; undoTxnId: string | null } | null> {
  const a = (await client.query<{ amount: string; status: string; notes: string | null; changed_at: Date }>(
    `SELECT old_row->>'amount' AS amount, old_row->>'status' AS status, old_row->>'notes' AS notes, changed_at
       FROM audit_row_changes
      WHERE table_name = 'payments' AND row_id = $1 AND op = 'UPDATE'
        AND (old_row->>'amount')::numeric > 0 AND (new_row->>'amount')::numeric = 0
        AND new_row->>'notes' LIKE '%' || $2 || '%'
      ORDER BY changed_at DESC, id DESC
      LIMIT 1`, [paymentId, REVERSED_LATE_FEE_NOTE])).rows[0]
  const u = (await client.query<{ id: string; z: { priorAmount: number; priorStatus: string; priorNotes: string | null } }>(
    `SELECT bt.id, z AS z
       FROM bank_transactions bt
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(bt.auto_settle_undo->'lateFeesZeroed', '[]'::jsonb)) z
      WHERE bt.status = 'matched' AND z->>'paymentId' = $1
      LIMIT 1`, [paymentId])).rows[0]
  if (a) return { amount: Number(a.amount), status: a.status, notes: a.notes, zeroedAt: a.changed_at, undoTxnId: u?.id ?? null }
  if (u) return { amount: Number(u.z.priorAmount), status: u.z.priorStatus, notes: u.z.priorNotes, zeroedAt: null, undoTxnId: u.id }
  return null
}

/**
 * Put every late fee zeroed by a reversal since FIX_SINCE into the new form,
 * inside the caller's transaction. See the header.
 */
export async function fixReversedLateFees(client: PoolClient, since: string = FIX_SINCE): Promise<FixReport> {
  const fees = (await client.query<{
    id: string; invoice_id: string | null; tenant_id: string | null; landlord_id: string; notes: string; settled_at: Date | null
    created_at: Date | null
  }>(
    `SELECT p.id, p.invoice_id, p.tenant_id, p.landlord_id, p.notes, p.settled_at, p.created_at
       FROM payments p
      WHERE p.type = 'late_fee' AND p.amount = 0 AND p.status = 'settled'
        AND p.notes LIKE '%' || $1 || '%'
        AND p.settled_at >= $2::date
      ORDER BY p.settled_at, p.id`, [REVERSED_LATE_FEE_NOTE, since])).rows
  const report: FixReport = { fixed: [], skipped: [], subjects: [] }
  const subjects = new Set<string>()
  for (const f of fees) {
    if (!f.tenant_id) { report.skipped.push({ paymentId: f.id, why: 'no resident on it' }); continue }
    const paidOn = /Reversed: rent was paid (\d{4}-\d{2}-\d{2})/.exec(f.notes)?.[1]
    if (!paidOn) { report.skipped.push({ paymentId: f.id, why: 'its note does not say when the rent was paid' }); continue }
    await client.query('SAVEPOINT fix_fee')
    try {
      await lockHousehold(client, f.tenant_id, f.landlord_id)
      const prior = await priorOf(client, f.id)
      // A. A bank match zeroed it: the bank's date decided, and it stays at $0.00.
      const bankTied = prior?.undoTxnId ? true : f.invoice_id ? ((await client.query(
        `SELECT 1 FROM bank_deposit_allocations bda JOIN payments p ON p.id = bda.payment_id
          WHERE p.invoice_id = $1 AND bda.reversed_at IS NULL LIMIT 1`, [f.invoice_id])).rowCount ?? 0) > 0 : false
      if (bankTied) {
        await client.query('ROLLBACK TO SAVEPOINT fix_fee')
        report.skipped.push({ paymentId: f.id, why: 'a bank line matched to its bill zeroed it — the bank\'s date decides, so it stays at $0.00' })
        continue
      }
      if (!prior || !(toCents(prior.amount) > 0)) {
        await client.query('ROLLBACK TO SAVEPOINT fix_fee')
        report.skipped.push({ paymentId: f.id, why: 'what it was charged before it was zeroed is not on record' })
        continue
      }
      // 1. Charged again, as it was — owed for this instant only.
      const back = await client.query(
        `UPDATE payments SET amount = $2, status = 'pending', settled_at = NULL, notes = $3
          WHERE id = $1 AND amount = 0 AND status = 'settled'`,
        [f.id, (toCents(prior.amount) / 100).toFixed(2), prior.notes])
      if ((back.rowCount ?? 0) !== 1) throw new Error('changed while it was being fixed')
      // 2. The credit against it.
      const c = await creditLateFee(client, f.id, { paidOn, tenantId: f.tenant_id, createdBy: null })
      if (!c) throw new Error('could not be credited (not on a lease and a space)')
      // 3. A bank match's undo record lists it as credited now.
      if (prior.undoTxnId) {
        await client.query(
          `UPDATE bank_transactions
              SET auto_settle_undo = jsonb_set(
                    jsonb_set(auto_settle_undo, '{lateFeesZeroed}',
                      COALESCE((SELECT jsonb_agg(z) FROM jsonb_array_elements(auto_settle_undo->'lateFeesZeroed') z
                                 WHERE z->>'paymentId' <> $2), '[]'::jsonb)),
                    '{lateFeesCredited}',
                    COALESCE(auto_settle_undo->'lateFeesCredited', '[]'::jsonb) || jsonb_build_array($3::jsonb)),
                  updated_at = NOW()
            WHERE id = $1`,
          [prior.undoTxnId, f.id, JSON.stringify({
            paymentId: f.id, amount: c.amount, priorStatus: prior.status === 'settled' ? 'pending' : prior.status,
            priorNotes: prior.notes, priorIssued: c.priorIssued ?? 0, creditId: c.creditId, useId: c.useId,
          })])
      }
      // 4. The bill's rent and utility that were PAID WHILE THE FEE WAS ON
      // THE BILL: late, from the day it was recorded — what settleHooks does
      // live (a row is marked late only when it settles with a late fee on
      // its bill). A row paid and marked before the fee was charged (a
      // utility paid on time on the 1st, the fee posting on the 6th because
      // rent was still open) keeps its mark. When GAM recorded a row's
      // payment: the last time its status became settled (its own change
      // history), else its first payment mark, else its settled_at.
      const recordedAt = prior.zeroedAt ?? (f.settled_at ? new Date(f.settled_at) : new Date())
      const rows = f.invoice_id ? (await client.query<{ id: string }>(
        `SELECT p.id FROM payments p
          WHERE p.invoice_id = $1 AND p.type IN ('rent', 'utility') AND p.status = 'settled'
            AND COALESCE(
                  (SELECT MAX(a.changed_at) FROM audit_row_changes a
                    WHERE a.table_name = 'payments' AND a.row_id = p.id AND a.op = 'UPDATE'
                      AND a.new_row->>'status' = 'settled'
                      AND a.old_row->>'status' IS DISTINCT FROM 'settled'),
                  (SELECT MIN(e.recorded_at) FROM credit_events e
                    WHERE e.event_type LIKE 'payment_received_%' AND e.event_data->>'payment_id' = p.id::text),
                  p.settled_at
                ) >= $2::timestamptz
          ORDER BY p.id`,
        [f.invoice_id, f.created_at ?? new Date(0)])).rows : []
      const marks: LateFeeMarkCorrection[] = []
      for (const r of rows) {
        const m = await correctMarkForLateFeeOnBill(client, { paymentId: r.id, recordedAt })
        marks.push(m)
        if (m.subjectId && (m.action === 'corrected' || m.action === 'written')) subjects.add(m.subjectId)
      }
      await client.query('RELEASE SAVEPOINT fix_fee')
      report.fixed.push({
        paymentId: f.id, invoiceId: f.invoice_id, tenantId: f.tenant_id, amount: c.amount, paidOn,
        creditId: c.creditId, undoRecordUpdated: prior.undoTxnId, marks,
      })
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT fix_fee')
      report.skipped.push({ paymentId: f.id, why: e instanceof Error ? e.message : String(e) })
    }
  }
  report.subjects = [...subjects]
  return report
}

/** One late fee a bank match had credited, zeroed now (part B). */
export interface ZeroedBankFee {
  paymentId: string
  bankTransactionId: string
  tenantId: string
  amount: number
  /** The bank-validated day the fee was judged by. */
  paidOn: string
  creditsWithdrawn: string[]
  marks: BankDateMarkCorrection[]
}

export interface BankCorrectionReport {
  zeroed: ZeroedBankFee[]
  skipped: Array<{ paymentId: string; bankTransactionId: string; why: string }>
  subjects: string[]
}

/**
 * Part B (see the header): every late fee a bank match CREDITED as never owed
 * is zeroed instead, the match's undo record rewritten, and the marks of the
 * rows that bank line paid re-rated from the bank-validated day. Inside the
 * caller's transaction; each bank line in its own savepoint.
 */
export async function correctBankMatchedCreditedFees(client: PoolClient): Promise<BankCorrectionReport> {
  const txns = (await client.query<{ id: string; landlord_id: string; undo: any }>(
    `SELECT id, landlord_id, auto_settle_undo AS undo FROM bank_transactions
      WHERE status = 'matched'
        AND jsonb_typeof(auto_settle_undo->'lateFeesCredited') = 'array'
        AND jsonb_array_length(auto_settle_undo->'lateFeesCredited') > 0
        AND auto_settle_undo->>'kind' IS DISTINCT FROM 'recorded_deposit'
        AND jsonb_typeof(auto_settle_undo->'rows') = 'array'
      ORDER BY id`)).rows
  const report: BankCorrectionReport = { zeroed: [], skipped: [], subjects: [] }
  const subjects = new Set<string>()
  for (const t of txns) {
    const credited: CreditedLateFee[] = t.undo.lateFeesCredited ?? []
    const rowIds: string[] = (t.undo.rows ?? []).map((r: { paymentId: string }) => r.paymentId)
    await client.query('SAVEPOINT fix_bank')
    try {
      const day = (await client.query<{ d: string | null }>(
        `SELECT to_char(MIN(effective_paid_date), 'YYYY-MM-DD') AS d FROM bank_deposit_allocations
          WHERE bank_transaction_id = $1 AND reversed_at IS NULL`, [t.id])).rows[0]?.d ?? null
      const tenantId = (await client.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM tenant_remittances WHERE id = $1`, [t.undo.receiptId ?? null])).rows[0]?.tenant_id ?? null
      if (!day || !tenantId) {
        await client.query('ROLLBACK TO SAVEPOINT fix_bank')
        for (const c of credited) {
          report.skipped.push({ paymentId: c.paymentId, bankTransactionId: t.id,
            why: !day ? 'the bank line\'s day is not on record (no live bank allocation)' : 'the match\'s receipt has no resident' })
        }
        continue
      }
      await lockHousehold(client, tenantId, t.landlord_id)
      const zeroedHere: Array<{ c: CreditedLateFee; amount: number; withdrawn: string[] }> = []
      const keep: CreditedLateFee[] = []
      for (const c of credited) {
        const f = (await client.query<{ amount: string; status: string; type: string; credited: boolean; other: boolean }>(
          `SELECT p.amount::text AS amount, p.status, p.type,
                  EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.source = 'late_fee_credit'
                             AND u.status = 'applied') AS credited,
                  EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id AND u.status IN ('held','applied')
                             AND u.source IS DISTINCT FROM 'late_fee_credit') AS other
             FROM payments p WHERE p.id = $1 FOR UPDATE`, [c.paymentId])).rows[0]
        const why = !f ? 'it is no longer there'
          : f.type !== 'late_fee' || f.status !== 'settled' || !(toCents(f.amount) > 0) ? 'it is no longer a credited late fee'
          : !f.credited ? 'its late-fee credit was taken back since'
          : f.other ? 'other credit is on it, so it cannot go to $0.00 (it stays credited)'
          : null
        if (why) { keep.push(c); report.skipped.push({ paymentId: c.paymentId, bankTransactionId: t.id, why }); continue }
        const w = await withdrawLateFeeCredit(client, c.paymentId)
        const z = await client.query(
          `UPDATE payments
              SET amount = 0, next_retry_at = NULL,
                  notes = COALESCE(notes || ' — ', '') || $2 || $3::text || ', before this fee was charged'
            WHERE id = $1 AND status = 'settled' AND issued_credit_amount = 0`,
          [c.paymentId, BANK_SHOWS_LATE_FEE_NOTE, day])
        if ((z.rowCount ?? 0) !== 1) throw new Error(`late fee ${c.paymentId} changed while it was being zeroed`)
        zeroedHere.push({ c, amount: Number(f!.amount), withdrawn: w.creditIds })
      }
      if (zeroedHere.length === 0) { await client.query('RELEASE SAVEPOINT fix_bank'); continue }
      // The undo record: each zeroed fee listed as zeroed — Undo puts it back
      // as it was before the match (owed, its notes as they were).
      const undo = {
        ...t.undo,
        lateFeesCredited: keep,
        lateFeesZeroed: [
          ...(t.undo.lateFeesZeroed ?? []),
          ...zeroedHere.map(x => ({
            paymentId: x.c.paymentId, priorAmount: x.amount,
            priorStatus: x.c.priorStatus === 'settled' ? 'pending' : x.c.priorStatus, priorNotes: x.c.priorNotes,
          })),
        ],
      }
      await client.query(`UPDATE bank_transactions SET auto_settle_undo = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [t.id, JSON.stringify(undo)])
      // The marks: from the bank-validated day, through the correction chain
      // (the match's Undo follows the chain to the newest mark and withdraws it).
      const marks = await reRateMarksFromBankDate(client, { paymentIds: rowIds, paidOn: day })
      for (const m of marks) subjects.add(m.subjectId)
      await client.query('RELEASE SAVEPOINT fix_bank')
      for (const x of zeroedHere) {
        report.zeroed.push({
          paymentId: x.c.paymentId, bankTransactionId: t.id, tenantId, amount: x.amount, paidOn: day,
          creditsWithdrawn: x.withdrawn, marks: marks,
        })
      }
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT fix_bank')
      for (const c of credited) {
        report.skipped.push({ paymentId: c.paymentId, bankTransactionId: t.id, why: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  report.subjects = [...subjects]
  return report
}

export function printBankCorrectionReport(r: BankCorrectionReport, log: (s: string) => void = console.log): void {
  log(`${r.zeroed.length} late fee(s) a bank match had credited are zeroed — the bank's date decides; ${r.skipped.length} left as they were.`)
  for (const z of r.zeroed) {
    log(`  late fee ${z.paymentId} (bank line ${z.bankTransactionId}, tenant ${z.tenantId}): $${z.amount.toFixed(2)} zeroed — ` +
      `the bank shows the deposit on ${z.paidOn}; credit(s) withdrawn: ${z.creditsWithdrawn.join(', ') || 'none'}`)
    for (const m of z.marks) log(`      payment ${m.paymentId}: mark ${m.was ?? 'none'} → ${m.now}`)
  }
  for (const s of r.skipped) log(`  SKIPPED ${s.paymentId} (bank line ${s.bankTransactionId}): ${s.why}`)
}

export function printFixReport(r: FixReport, log: (s: string) => void = console.log): void {
  log(`${r.fixed.length} zeroed late fee(s) put back and credited; ${r.skipped.length} left as they were.`)
  for (const f of r.fixed) {
    log(`  late fee ${f.paymentId} (bill ${f.invoiceId ?? '-'}, tenant ${f.tenantId}): $${f.amount.toFixed(2)} charged again, ` +
      `credited (credit ${f.creditId}) — rent was paid ${f.paidOn}` +
      (f.undoRecordUpdated ? `; bank match ${f.undoRecordUpdated} undo record now lists it as credited` : ''))
    for (const m of f.marks) {
      log(`      payment ${m.paymentId}: mark ${m.action}${m.was || m.now ? ` (${m.was ?? 'none'} → ${m.now ?? 'none'})` : ''}`)
    }
  }
  for (const s of r.skipped) log(`  SKIPPED ${s.paymentId}: ${s.why}`)
}

if (require.main === module) {
  ;(async () => {
    const apply = process.argv.includes('--apply')
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    let subjects: string[] = []
    try {
      await c.query('BEGIN')
      const r = await fixReversedLateFees(c)
      printFixReport(r)
      const b = await correctBankMatchedCreditedFees(c)
      printBankCorrectionReport(b)
      if (apply) { await c.query('COMMIT'); subjects = [...new Set([...r.subjects, ...b.subjects])]; console.log('COMMITTED') }
      else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. --apply to commit.') }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      console.error(e instanceof Error ? e.message : e)
      code = 1
    } finally {
      c.release()
    }
    if (subjects.length > 0) {
      const { recomputeAndSnapshot } = await import('../services/creditScore')
      for (const s of subjects) {
        await recomputeAndSnapshot(s).catch(err => console.error(`score recompute failed for ${s} (the nightly run picks it up):`, err))
      }
    }
    process.exit(code)
  })()
}
