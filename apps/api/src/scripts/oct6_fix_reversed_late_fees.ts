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
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back.
 * --apply commits. Scores of the tenants whose marks changed are recomputed
 * after the commit.
 *   cd apps/api && npx ts-node -T src/scripts/oct6_fix_reversed_late_fees.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct6_fix_reversed_late_fees.ts --apply
 */
import type { PoolClient } from 'pg'
import { lockHousehold } from '../services/moneyPredicates'
import { creditLateFee } from '../services/lateFeeCredit'
import { correctMarkForLateFeeOnBill, type LateFeeMarkCorrection } from '../services/creditLedgerEmitters'
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
      if (apply) { await c.query('COMMIT'); subjects = r.subjects; console.log('COMMITTED') }
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
