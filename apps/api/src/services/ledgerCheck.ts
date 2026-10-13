/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE NIGHTLY TIE-OUT
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * Every night, per company (gam-ledger-design-2026-10-12 §8):
 *   1. drain that company's waiting outbox rows;
 *   2. run every check in ONE REPEATABLE READ, READ ONLY transaction, so every
 *      number is read at the same instant;
 *   3. record what was found in ledger_rebuild_runs (mode 'check');
 *   4. re-post real drift from its source — never plug it with a balancing
 *      entry — and tell an admin.
 *
 * The engine's own checks (this phase):
 *   unbalanced           a posting whose debits ≠ credits for some property
 *   too_few_lines        a posting with fewer than two lines
 *   line_mismatch        a line whose company or dates differ from its posting's
 *   chain_broken         a superseded posting without exactly one reversal, or a
 *                        reversal that is not the exact negation of what it reverses
 *   fingerprint_mismatch an active posting whose stored lines no longer match
 *                        its fingerprint
 *   closed_month_changed a closed month's balances differ from the snapshot the
 *                        close took (or, when a reopen left earlier months
 *                        closed, the snapshot that reopen took of them)
 *   source_drift         a source whose postings differ from what its projector
 *                        wants now (missing, stale or changed) — sources with an
 *                        outbox row still waiting are reported as 'pending',
 *                        never as drift
 *   waiting / failing    outbox rows older than 10 minutes; sources in
 *                        ledger_source_errors
 *
 * The money tie-outs (tenant receivables against the open bills, money GAM
 * holds against the owner shares not yet paid out, deposits, paid-ahead money,
 * Stripe in transit …, design §8's table) arrive with the projectors that post
 * those accounts, through registerLedgerCheck.
 */
import type { PoolClient } from 'pg'
import { ledgerConnect, ledgerQuery } from '../db/ledgerPool'
import { logger } from '../lib/logger'
import { createAdminNotification } from './adminNotifications'
import { type LedgerOwner, ownerColOf, ownerIdOf } from './ledgerOwner'
import { drainLedgerOutbox, diffSource, postSource, drainableLedgerOutboxTypes, lineTuple, fingerprintOf } from './ledgerEngine'
import { sourcesForOwner, keepInOutbox } from './ledgerRebuild'

export type LedgerFindingSeverity = 'integrity' | 'drift' | 'pending' | 'info'
export interface LedgerFinding {
  check: string
  severity: LedgerFindingSeverity
  detail: Record<string, unknown>
}

/** A money tie-out a projector phase adds (e.g. receivables = open bills). Runs inside the REPEATABLE READ snapshot. */
export interface LedgerCheck {
  name: string
  run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]>
}
const checks = new Map<string, LedgerCheck>()
export function registerLedgerCheck(c: LedgerCheck): void { checks.set(c.name, c) }
export function unregisterLedgerCheck(name: string): void { checks.delete(name) }

/** Runs every registered money tie-out on `client`'s snapshot; a check that throws is itself a finding. */
export async function runRegisteredChecks(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
  const out: LedgerFinding[] = []
  for (const c of checks.values()) {
    try {
      out.push(...await c.run(client, owner))
    } catch (e) {
      out.push({ check: c.name, severity: 'integrity', detail: { error: e instanceof Error ? e.message : String(e) } })
    }
  }
  return out
}

/** The engine's own integrity checks for one company, on `client`'s snapshot. */
export async function engineChecks(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
  const col = ownerColOf(owner)
  const id = ownerIdOf(owner)
  const out: LedgerFinding[] = []

  for (const r of (await client.query(
    `SELECT p.id, p.source_type, p.source_id, l.property_id, sum(l.debit)::text AS debits, sum(l.credit)::text AS credits
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.${col} = $1
      GROUP BY p.id, p.source_type, p.source_id, l.property_id
     HAVING sum(l.debit) <> sum(l.credit)`, [id])).rows) {
    out.push({ check: 'unbalanced', severity: 'integrity', detail: r })
  }
  for (const r of (await client.query(
    `SELECT p.id, p.source_type, p.source_id, count(l.id)::int AS lines
       FROM ledger_postings p LEFT JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.${col} = $1
      GROUP BY p.id HAVING count(l.id) < 2`, [id])).rows) {
    out.push({ check: 'too_few_lines', severity: 'integrity', detail: r })
  }
  for (const r of (await client.query(
    `SELECT l.id AS line_id, p.id AS posting_id
       FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
      WHERE p.${col} = $1
        AND (l.landlord_id IS DISTINCT FROM p.landlord_id OR l.business_id IS DISTINCT FROM p.business_id
             OR l.accounting_date <> p.accounting_date OR l.intended_date <> p.intended_date)`, [id])).rows) {
    out.push({ check: 'line_mismatch', severity: 'integrity', detail: r })
  }
  for (const r of (await client.query(
    `SELECT p.id, p.source_type, p.source_id,
            (SELECT count(*) FROM ledger_postings r WHERE r.reverses_posting_id = p.id)::int AS reversals
       FROM ledger_postings p
      WHERE p.${col} = $1 AND p.role = 'post'
        AND (SELECT count(*) FROM ledger_postings r WHERE r.reverses_posting_id = p.id)
            <> CASE WHEN p.superseded_at IS NULL THEN 0 ELSE 1 END`, [id])).rows) {
    out.push({ check: 'chain_broken', severity: 'integrity', detail: r })
  }
  for (const r of (await client.query(
    `SELECT r.id AS reversal_id, r.reverses_posting_id AS posting_id
       FROM ledger_postings r
      WHERE r.${col} = $1 AND r.role = 'reversal'
        AND EXISTS (
          (SELECT line_no, account_id, property_id, unit_id, lease_id, tenant_id, payment_id, cash_effect, debit, credit
             FROM ledger_posting_lines WHERE posting_id = r.id
           EXCEPT ALL
           SELECT line_no, account_id, property_id, unit_id, lease_id, tenant_id, payment_id, cash_effect, credit, debit
             FROM ledger_posting_lines WHERE posting_id = r.reverses_posting_id)
          UNION ALL
          (SELECT line_no, account_id, property_id, unit_id, lease_id, tenant_id, payment_id, cash_effect, credit, debit
             FROM ledger_posting_lines WHERE posting_id = r.reverses_posting_id
           EXCEPT ALL
           SELECT line_no, account_id, property_id, unit_id, lease_id, tenant_id, payment_id, cash_effect, debit, credit
             FROM ledger_posting_lines WHERE posting_id = r.id))`, [id])).rows) {
    out.push({ check: 'chain_broken', severity: 'integrity', detail: { ...r, why: 'reversal is not the exact negation' } })
  }

  // Active postings: stored lines still match the fingerprint.
  const lines = (await client.query<any>(
    `SELECT p.id AS posting_id, p.fingerprint, l.intended_date::text AS day, l.account_id, l.account_role, l.map_kind,
            l.map_value, l.property_id, l.unit_id, l.lease_id, l.tenant_id, l.vendor_id, l.payment_id, l.report_category,
            l.expense_kind, l.cash_effect, l.tax_name, l.system_line,
            round(l.debit * 100)::bigint AS dr, round(l.credit * 100)::bigint AS cr
       FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
      WHERE p.${col} = $1 AND p.role = 'post' AND p.superseded_at IS NULL`, [id])).rows
  const byPosting = new Map<string, { fp: string; tuples: string[] }>()
  for (const x of lines) {
    const e = byPosting.get(x.posting_id) ?? { fp: x.fingerprint as string, tuples: [] as string[] }
    e.tuples.push(lineTuple(x.day, {
      accountId: x.account_id, accountRole: x.account_role, mapKind: x.map_kind, mapValue: x.map_value,
      propertyId: x.property_id, unitId: x.unit_id, leaseId: x.lease_id, tenantId: x.tenant_id, vendorId: x.vendor_id,
      paymentId: x.payment_id, reportCategory: x.report_category, expenseKind: x.expense_kind, cashEffect: x.cash_effect,
      taxName: x.tax_name, systemLine: x.system_line, debitCents: Number(x.dr), creditCents: Number(x.cr),
    }))
    byPosting.set(x.posting_id, e)
  }
  for (const [postingId, e] of byPosting) {
    if (fingerprintOf(e.tuples) !== e.fp) out.push({ check: 'fingerprint_mismatch', severity: 'integrity', detail: { postingId } })
  }

  // The current lock: nothing entered or left the closed months since its
  // snapshot. 10/12 (Nic) review: the latest row, a close or a reopen that
  // left earlier months closed — each takes the snapshot of what it locks.
  const close = (await client.query<{ id: string; action: string; closed_through: string | null }>(
    `SELECT id::text AS id, action, closed_through::text AS closed_through FROM books_period_closes
      WHERE ${col} = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0]
  if (close?.closed_through) {
    for (const r of (await client.query(
      `WITH snap AS (SELECT account_id, property_id, debits, credits FROM ledger_close_balances WHERE close_id = $2),
            cur AS (SELECT account_id, property_id, sum(debit) AS debits, sum(credit) AS credits
                      FROM ledger_posting_lines WHERE ${col} = $1 AND accounting_date <= $3::date
                     GROUP BY account_id, property_id)
       SELECT COALESCE(s.account_id, c.account_id) AS account_id, COALESCE(s.property_id, c.property_id) AS property_id,
              COALESCE(s.debits, 0)::text AS snapshot_debits, COALESCE(c.debits, 0)::text AS debits,
              COALESCE(s.credits, 0)::text AS snapshot_credits, COALESCE(c.credits, 0)::text AS credits
         FROM snap s FULL OUTER JOIN cur c
           ON c.account_id = s.account_id AND c.property_id IS NOT DISTINCT FROM s.property_id
        WHERE COALESCE(s.debits, 0) <> COALESCE(c.debits, 0) OR COALESCE(s.credits, 0) <> COALESCE(c.credits, 0)`,
      [id, close.id, close.closed_through])).rows) {
      out.push({ check: 'closed_month_changed', severity: 'integrity', detail: { closedThrough: close.closed_through, ...r } })
    }
  }

  const types = drainableLedgerOutboxTypes()
  for (const r of (await client.query(
    `SELECT source_type, count(DISTINCT source_id)::int AS sources, min(at)::text AS oldest
       FROM ledger_outbox
      WHERE owner_id = $1 AND source_type = ANY($2::text[]) AND at < now() - interval '10 minutes'
      GROUP BY source_type`, [id, types])).rows) {
    out.push({ check: 'waiting', severity: 'pending', detail: r })
  }
  for (const r of (await client.query(
    `SELECT source_type, source_id, reason_code, attempts, last_error FROM ledger_source_errors WHERE owner_id = $1`, [id])).rows) {
    out.push({ check: 'failing', severity: 'pending', detail: r })
  }
  return out
}

/** Every registered source of the company: what its projector wants against what is posted. */
async function driftChecks(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
  const out: LedgerFinding[] = []
  const sources = await sourcesForOwner(client, owner, {})
  if (sources.length === 0) return out
  const pending = new Set((await client.query<{ k: string }>(
    `SELECT DISTINCT source_type || ':' || source_id AS k FROM ledger_outbox
      WHERE source_type = ANY($1::text[]) AND (owner_id = $2 OR owner_id IS NULL)`,
    [drainableLedgerOutboxTypes(), ownerIdOf(owner)])).rows.map(r => r.k))
  for (const s of sources) {
    const waiting = pending.has(`${s.type}:${s.id}`)
    for (const d of await diffSource(client, s.type, s.id)) {
      if (d.status === 'equal') continue
      if (d.ownerId && d.ownerId !== ownerIdOf(owner)) continue
      out.push({
        check: 'source_drift',
        // 10/12 (Nic, ledger P4): a source waiting on the owner's choice
        // (an accounting method not chosen yet) is pending, like no start date.
        severity: waiting || d.status === 'no_books_start' || d.status === 'waiting_on_owner' ? 'pending' : 'drift',
        detail: { ...d, waiting },
      })
    }
  }
  return out
}

export interface CheckResult {
  runId: string
  ownerId: string
  findings: LedgerFinding[]
  repaired: number
}

/** The nightly check for one company (see the header). */
export async function checkOwner(owner: LedgerOwner, opts: { repair?: boolean } = {}): Promise<CheckResult> {
  const repair = opts.repair !== false
  await drainLedgerOutbox({ ownerId: ownerIdOf(owner), maxMs: 120_000 })
  const run = await ledgerQuery<{ id: string }>(
    `INSERT INTO ledger_rebuild_runs (${ownerColOf(owner)}, mode) VALUES ($1, 'check') RETURNING id`, [ownerIdOf(owner)])
  const runId = run[0].id
  const findings: LedgerFinding[] = []
  const client = await ledgerConnect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    findings.push(...await engineChecks(client, owner))
    findings.push(...await driftChecks(client, owner))
    findings.push(...await runRegisteredChecks(client, owner))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    const msg = e instanceof Error ? e.message : String(e)
    await ledgerQuery(`UPDATE ledger_rebuild_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [runId, msg])
    throw e
  } finally {
    client.release()
  }

  // Real drift is re-posted from its source, never plugged.
  let repaired = 0
  if (repair) {
    const keys = new Set<string>()
    for (const f of findings) {
      if (f.check !== 'source_drift' || f.severity !== 'drift') continue
      const d = f.detail as { sourceType: string; sourceId: string }
      keys.add(`${d.sourceType}\u0000${d.sourceId}`)
    }
    for (const k of keys) {
      const [t, sid] = k.split('\u0000')
      const res = await postSource(t, sid, { ownerHint: ownerIdOf(owner) })
      if (!res.error && !res.busy) repaired++
      // 10/12 (Nic, ledger integrate): one that could not be re-posted stays
      // queued for the minute drain (design §8).
      else await keepInOutbox(t, sid, ownerIdOf(owner))
    }
  }

  const count = (s: LedgerFindingSeverity) => findings.filter(f => f.severity === s).length
  const counts = { integrity: count('integrity'), drift: count('drift'), pending: count('pending'), info: count('info'), repaired }
  await ledgerQuery(
    `UPDATE ledger_rebuild_runs SET status = 'done', finished_at = now(), counts = $2::jsonb, drift = $3::jsonb WHERE id = $1`,
    [runId, JSON.stringify(counts), JSON.stringify(findings.slice(0, 2000))])
  if (counts.integrity > 0 || counts.drift > 0) {
    await createAdminNotification({
      severity: counts.integrity > 0 ? 'critical' : 'warn',
      category: 'books_ledger',
      title: counts.integrity > 0 ? 'The books failed an integrity check' : 'The books drifted from the money records',
      body: `Company ${ownerIdOf(owner)}: ${counts.integrity} integrity finding(s), ${counts.drift} source(s) drifted (${repaired} re-posted from source).`,
      context: { runId, ownerId: ownerIdOf(owner), counts },
    })
  }
  return { runId, ownerId: ownerIdOf(owner), findings, repaired }
}

/**
 * The nightly job: every company that has ledger activity (postings, waiting
 * outbox rows or failing sources). Each company on its own; one failure is
 * logged and the rest still run.
 */
export async function runLedgerChecks(opts: { owner?: LedgerOwner | 'all'; repair?: boolean } = {}): Promise<CheckResult[]> {
  if (opts.owner && opts.owner !== 'all') return [await checkOwner(opts.owner, opts)]
  const owners = await ledgerQuery<{ id: string }>(
    `SELECT l.id FROM landlords l
      WHERE EXISTS (SELECT 1 FROM ledger_postings p WHERE p.landlord_id = l.id)
         OR EXISTS (SELECT 1 FROM ledger_outbox o WHERE o.owner_id = l.id AND o.source_type = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM ledger_source_errors e WHERE e.owner_id = l.id)
      ORDER BY l.created_at, l.id`, [drainableLedgerOutboxTypes()])
  const out: CheckResult[] = []
  for (const o of owners) {
    try {
      out.push(await checkOwner({ landlordId: o.id }, opts))
    } catch (e) {
      logger.error({ err: e, landlordId: o.id }, '[ledger:check] company check failed')
    }
  }
  return out
}
