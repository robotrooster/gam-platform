/**
 * 10/14 (Nic) — the voided documents of his two companies that the 10/14
 * answers now erase, erased. One-time; idempotent (a second run finds nothing).
 *
 *   #8 "Mountain View RV 09 (voided 9/18, $0.00 bills): delete it."
 *
 * REVIEW 10/14 — THE QUESTION HAD A WRONG FACT. RV 09's move-in bill DID bill
 * the household $495.42 on 9/16 (rent $495.00 + electric $0.42, both
 * pending); the 9/18 void deleted those two lines and zeroed the bill's total
 * (a void before 10/12 did that), so only "$0.00" was left to read. Nothing
 * was ever paid, credited or settled on it. Under Nic's 10/13 rule ("a lease
 * the landlord signed that billed someone stays on record") it stays, and
 * this script KEEPS it by default, printing what it billed. Only once Nic
 * confirms with that fact is it erased:
 *   --erase-voided-unpaid=8d49f673-7a13-496c-8731-2926e0885bf5
 * which judges THAT document alone by MoneyRule 'paid' (a bill voided
 * unpaid is no money; anything paid, credited or settled still keeps it).
 *
 * Going forward the app erases these itself (lib/voidDocument.endDocument, the
 * automatic ends in jobs/scheduler, the test in lib/eraseUnfinishedDocument).
 * This clears what was voided before that, for Oak Park and Mountain View only
 * (scripts/oct13_erase_unfinished_documents NIC_COMPANIES):
 *   - RV 09's lease (8d49f673…), with --erase-voided-unpaid only: Nic's
 *     signature issued it on 9/16 and it was voided 9/18. Its bills: the
 *     move-in bill (void; its subtotals still show the $495.42 it billed, and
 *     the change journal shows the two lines the void deleted) and a final
 *     electric bill ($0.00 — meter 362 → 362 — marked "paid" in cash for
 *     $0.00 on 10/3). The proof printed below shows, row by row, what was
 *     billed and that nothing was ever paid, credited or settled: no card or
 *     bank attempt, no receipt, no credit, no deposit, no books posting.
 *   - Any other VOIDED document of the two companies the 10/14 test now lets
 *     go (an open invite waited on it, one co-tenant signed, a sublease
 *     request that never started, a lease issued with nothing billed) — every
 *     one voided since yesterday's run (10/13) included. Each is printed with
 *     the day it was voided.
 *
 * WHAT IT NEVER TOUCHES: a voided document money touched (printed, with the
 * reason, and left voided); any document not voided (still out for signature
 * — the nightly 30-day step and the buttons handle those); Arturo's MH 15
 * lease (PROTECTED_DOCUMENTS), alone or in a packet; completed documents;
 * any other company.
 *
 * DRY RUN BY DEFAULT — one READ ONLY transaction, so it can be pointed at
 * production: prints every voided document of the two companies (erased or
 * kept, and why), the proof for each lease it erases, EVERY ROW --apply would
 * delete or change (by table, with ids), and the files only the erased
 * documents use. --apply erases them in one transaction (each re-judged
 * under the erase's own locks), then removes those files from this machine's
 * uploads folder (run it from apps/api on the machine that serves the files).
 *   cd apps/api && npx ts-node -T src/scripts/oct14_erase_documents.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct14_erase_documents.ts --apply
 *   (either, plus --erase-voided-unpaid=<document id>[,<id>] once Nic confirms)
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import {
  planErase, eraseUnfinishedDocument, removeOrphanedDocumentFiles, leaseMoneyTouchedSql,
  creditMarksOfLeaseSql, billKeysOf, type EraseOptions, type MoneyRule,
} from '../lib/eraseUnfinishedDocument'
import { paymentTriedSql } from '../lib/unwindIssuedLease'
import { NIC_COMPANIES, PROTECTED_DOCUMENTS } from './oct13_erase_unfinished_documents'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

/** Mountain View RV 09's lease document (voided 9/18) and the lease it issued. */
export const RV09_DOCUMENT = '8d49f673-7a13-496c-8731-2926e0885bf5'
export const RV09_LEASE = '665d48cb-f93a-4ce4-871f-af45c977d75e'

/** Yesterday's run (scripts/oct13_erase_unfinished_documents): documents voided since are flagged. */
export const YESTERDAYS_RUN = '2026-10-13'

export interface ChargeProof {
  id: string; kind: string; amount: string; status: string; note: string | null
  /** Each money fact on the row, in words; empty = no money. */
  money: string[]
}

export interface LeaseProof {
  leaseId: string
  /** leaseMoneyTouchedSql on the lease, as the erase reads it (under `rule`). */
  moneyTouched: boolean
  rule: MoneyRule
  /** `billed`: what the bill's subtotals say it charged (a void before 10/12 zeroed only the total). */
  bills: Array<{ id: string; total: string; billed: string; status: string }>
  charges: ChargeProof[]
  /** Charge rows of the lease that are gone, from the change journal: what they billed and when they went. */
  deletedCharges: Array<{ id: string; kind: string; amount: string; status: string; deletedOn: string }>
}

/** Every row --apply would delete or change for one erased line, by table. */
export interface RowChange { table: string; change: string; ids: string[] }

export interface Oct14Line {
  id: string; company: string; title: string; unit: string | null; voidedOn: string | null
  sinceYesterday: boolean
  verdict: 'erase' | 'kept' | 'protected'
  why: string
  goesWith: string[]
  leaseId: string | null
  documentType: string
  proof: LeaseProof | null
  /** The rows --apply changes (erase lines only). */
  rows: RowChange[]
}

export interface Oct14Plan { lines: Oct14Line[]; files: string[] }

/**
 * Row by row, why a lease's bills are no money — or what money is on them.
 * The same facts leaseMoneyTouchedSql reads, named.
 */
export async function proveLease(q: Q, leaseId: string, rule: MoneyRule = 'billed'): Promise<LeaseProof> {
  const moneyTouched = (await q(`SELECT ${leaseMoneyTouchedSql('$1', rule)} AS t`, [leaseId])).rows[0]?.t === true
  const bills = (await q(
    `SELECT id, total_amount::text AS total, status,
            (subtotal_rent + subtotal_fees + subtotal_utilities + subtotal_deposits
             + subtotal_late_fees + subtotal_home_payments)::text AS billed
       FROM invoices WHERE lease_id = $1 ORDER BY created_at, id`,
    [leaseId])).rows
  const deletedCharges = (await q(
    `SELECT a.row_id::text AS id, a.old_row->>'type' AS kind, a.old_row->>'amount' AS amount,
            a.old_row->>'status' AS status, to_char(a.changed_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD') AS deleted_on
       FROM audit_row_changes a
      WHERE a.table_name = 'payments' AND a.op = 'DELETE'
        AND (a.old_row->>'lease_id' = $1::text
             OR a.old_row->>'invoice_id' IN (SELECT id::text FROM invoices WHERE lease_id::text = $1::text))
      ORDER BY a.changed_at, a.row_id`, [leaseId])).rows
    .map((r: any) => ({ id: r.id, kind: r.kind, amount: r.amount, status: r.status, deletedOn: r.deleted_on }))
  const rows = (await q(
    `SELECT p.id, p.type, p.amount::text AS amount, p.status, p.manual_method, p.notes,
            p.amount <> 0 AS nonzero,
            p.status IN ('processing', 'paid_via_deposit', 'returned') AS moving,
            ${paymentTriedSql('p')} AS tried,
            COALESCE(p.issued_credit_amount, 0) <> 0 AS credit_issued,
            COALESCE(p.work_trade_credit, 0) <> 0 AS work_trade,
            p.released_by_deposit_return_id IS NOT NULL AS from_deposit,
            EXISTS (SELECT 1 FROM bank_transactions x WHERE x.matched_payment_id = p.id) AS bank_matched,
            EXISTS (SELECT 1 FROM bank_deposit_allocations x WHERE x.payment_id = p.id) AS on_deposit_slip,
            EXISTS (SELECT 1 FROM ledger_posting_lines x
                     WHERE x.payment_id = p.id AND (x.debit <> 0 OR x.credit <> 0)) AS in_books
       FROM payments p
      WHERE p.lease_id = $1
         OR p.invoice_id IN (SELECT id FROM invoices WHERE lease_id = $1)
         OR p.id IN (SELECT payment_id FROM utility_bills WHERE lease_id = $1 AND payment_id IS NOT NULL)
      ORDER BY p.created_at, p.id`, [leaseId])).rows
  const charges: ChargeProof[] = rows.map((r: any) => ({
    id: r.id, kind: r.type, amount: r.amount, status: r.status,
    note: [r.manual_method ? `recorded as ${r.manual_method}` : null, r.notes].filter(Boolean).join(' — ') || null,
    money: [
      r.nonzero && `billed $${r.amount}`,
      r.moving && `status ${r.status}`,
      r.tried && 'a payment was tried on it (card/bank attempt, receipt, credit or bank-return log)',
      r.credit_issued && 'an overpayment credit came of it',
      r.work_trade && 'work trade was credited on it',
      r.from_deposit && 'settled from a deposit return',
      r.bank_matched && 'a bank line was matched to it',
      r.on_deposit_slip && 'it is on a deposit slip',
      r.in_books && 'the books posted a non-zero line for it',
    ].filter(Boolean) as string[],
  }))
  return { leaseId, moneyTouched, rule, bills, charges, deletedCharges }
}

/**
 * Every row --apply would delete or change for an erase of `docIds` (and the
 * lease it issued), read before anything is written — what
 * lib/eraseUnfinishedDocument does, table by table, ids printed. The
 * one-time cleanup only erases VOIDED documents, so nothing is taken back
 * (unwindIssuedLease) here.
 */
export async function previewRows(q: Q, docIds: string[], leaseId: string | null): Promise<RowChange[]> {
  const out: RowChange[] = []
  const add = async (table: string, change: string, sql: string, params: any[]) => {
    const ids = (await q(sql, params)).rows.map((r: any) => String(r.id))
    if (ids.length) out.push({ table, change, ids })
    return ids
  }
  const D = docIds
  await add('lease_documents', 'deleted', `SELECT id FROM lease_documents WHERE id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('lease_document_signers', 'deleted (with the document)', `SELECT id FROM lease_document_signers WHERE document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('lease_document_fields', 'deleted (with the document)', `SELECT id FROM lease_document_fields WHERE document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('lease_tenants', 'deleted (never joined)', `SELECT id FROM lease_tenants WHERE add_document_id = ANY($1::uuid[]) AND status IN ('pending_add','void') ORDER BY id`, [D])
  await add('lease_tenants', 'let go of the document (stays)', `SELECT id FROM lease_tenants WHERE remove_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('scheduled_lease_changes', 'deleted', `SELECT id FROM scheduled_lease_changes WHERE source_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('home_sale_contracts', 'deleted (never started)', `SELECT id FROM home_sale_contracts WHERE purchase_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  const canceled = await add('pending_tenant_intents', 'invite canceled (#1)',
    `SELECT id FROM pending_tenant_intents WHERE draft_document_id = ANY($1::uuid[]) AND resolved_at IS NULL AND cancelled_at IS NULL ORDER BY id`, [D])
  if (canceled.length) {
    await add('pending_tenant_intents', 'screening-waiver row beside it canceled',
      `SELECT w.id FROM pending_tenant_intents w JOIN pending_tenant_intents src ON src.id = ANY($1::uuid[])
        WHERE w.tenant_id = src.tenant_id AND w.landlord_id = src.landlord_id AND w.unit_id IS NULL AND w.screening_waived
          AND w.resolved_at IS NULL AND w.cancelled_at IS NULL ORDER BY w.id`, [canceled])
  }
  await add('pending_tenant_intents', 'lets go of the document (draft_document_id cleared)',
    `SELECT id FROM pending_tenant_intents WHERE draft_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  await add('pending_lease_drafts', 'lets go of the document (resolved_document_id cleared)',
    `SELECT id FROM pending_lease_drafts WHERE resolved_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  const subs = await add('subleases', 'deleted (never started, #3)', `SELECT id FROM subleases WHERE sublease_document_id = ANY($1::uuid[]) ORDER BY id`, [D])
  if (subs.length) {
    await add('sublessee_invitations', 'canceled, kept', `SELECT i.id FROM sublessee_invitations i
       WHERE i.sublease_id = ANY($1::uuid[]) OR i.id IN (SELECT sublessee_invitation_id FROM subleases WHERE id = ANY($1::uuid[])) ORDER BY i.id`, [subs])
  }
  await add('notifications', 'deleted (point at the document)',
    `SELECT id FROM notifications WHERE data->>'documentId' = ANY($1::text[]) OR data->>'document_id' = ANY($1::text[]) ORDER BY id`, [D])
  if (!leaseId) return out
  const L = [leaseId]
  const bills = await add('utility_bills', 'deleted', `SELECT id FROM utility_bills WHERE lease_id = $1 ORDER BY id`, L)
  if (bills.length) {
    await add('suspended_utility_charges', 'held again', `SELECT id FROM suspended_utility_charges WHERE released_bill_id = ANY($1::uuid[]) ORDER BY id`, [bills])
  }
  const invoices = (await q(`SELECT id FROM invoices WHERE lease_id = $1 ORDER BY id`, L)).rows.map((r: any) => r.id as string)
  const charges = await add('payments', 'deleted ($0.00 lines)',
    `SELECT id FROM payments WHERE lease_id = $1 OR invoice_id = ANY($2::uuid[])
        OR id IN (SELECT payment_id FROM utility_bills WHERE lease_id = $1 AND payment_id IS NOT NULL) ORDER BY id`, [leaseId, invoices])
  if (invoices.length) {
    out.push({ table: 'invoices', change: 'deleted', ids: invoices })
    await add('work_trade_settlements', 'deleted', `SELECT id FROM work_trade_settlements WHERE invoice_id = ANY($1::uuid[]) AND status IN ('open','voided') ORDER BY id`, [invoices])
  }
  await add('security_deposits', 'deleted (never held a dollar)', `SELECT id FROM security_deposits WHERE lease_id = $1 ORDER BY id`, L)
  await add('notifications', 'deleted (point at the lease)',
    `SELECT id FROM notifications WHERE data->>'leaseId' = $1::text OR data->>'lease_id' = $1::text ORDER BY id`, L)
  await add('credit_events', "withdrawn ('withdrawn_no_lease'), kept", creditMarksOfLeaseSql('SELECT'),
    [leaseId, charges, billKeysOf(invoices, charges)])
  await add('leases', 'deleted', `SELECT id FROM leases WHERE id = $1`, L)
  for (const t of ['lease_fees', 'lease_notices', 'lease_occupants', 'lease_pets', 'lease_renewal_requests',
    'lease_rent_components', 'lease_tenants', 'lease_unit_history', 'lease_utility_assignments',
    'lease_utility_responsibilities', 'lease_vehicles', 'liability_insurance_policies', 'scheduled_lease_changes',
    'seasonal_tenancies', 'security_deposit_interest_accruals', 'tenant_autopay', 'tenant_declared_deposits']) {
    // Two tables are keyed by the lease and a second column: that column names the row.
    const key = t === 'lease_utility_assignments' ? `'meter ' || meter_id`
      : t === 'lease_utility_responsibilities' ? `'utility ' || utility_type` : 'id'
    await add(t, 'deleted with the lease (ON DELETE CASCADE)', `SELECT ${key} AS id FROM ${t} WHERE lease_id = $1 ORDER BY 1`, L)
  }
  for (const [t, c] of [['home_sale_contracts', 'lease_id'], ['lease_documents', 'lease_id'], ['lease_documents', 'renews_lease_id'],
    ['pending_tenant_intents', 'resolved_lease_id'], ['stay_checkout_decisions', 'lease_id'], ['tenant_complaints', 'lease_id'],
    ['tenant_credits', 'lease_id']]) {
    if (t === 'lease_documents') {
      await add(t, `lets go of the lease (${c} cleared)`,
        `SELECT id FROM lease_documents WHERE ${c} = $1 AND id <> ALL($2::uuid[]) ORDER BY id`, [leaseId, D])
    } else {
      await add(t, `lets go of the lease (${c} cleared)`, `SELECT id FROM ${t} WHERE ${c} = $1 ORDER BY id`, L)
    }
  }
  return out
}

/** The cleanup's erase options: voided only, Arturo's lease protected, and the documents Nic confirmed (--erase-voided-unpaid). */
function cleanupOptions(voidedUnpaidIds: readonly string[]): EraseOptions {
  return { onlyVoided: true, protectedIds: PROTECTED_DOCUMENTS, voidedUnpaidIds }
}

export async function planOct14(q: Q, voidedUnpaidIds: readonly string[] = []): Promise<Oct14Plan> {
  const ids = Object.keys(NIC_COMPANIES)
  const docs = (await q(
    `SELECT d.id, d.landlord_id, d.title, d.document_type, d.lease_id,
            to_char(d.voided_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'), 'YYYY-MM-DD') AS voided_on,
            COALESCE(u.display_label, u.unit_number) AS unit
       FROM lease_documents d
       LEFT JOIN units u ON u.id = d.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE d.landlord_id = ANY($1::uuid[]) AND d.status = 'voided'
      ORDER BY d.landlord_id, (d.document_type = 'original_lease') DESC, d.created_at, d.id`, [ids])).rows
  const lines: Oct14Line[] = []
  const covered = new Set<string>()
  const eraseIds: string[] = []
  const urls: string[] = []
  for (const d of docs) {
    const base = {
      id: d.id, company: NIC_COMPANIES[d.landlord_id] ?? d.landlord_id, title: d.title, unit: d.unit ?? null,
      voidedOn: d.voided_on ?? null, sinceYesterday: !!d.voided_on && d.voided_on >= YESTERDAYS_RUN,
      goesWith: [] as string[], leaseId: d.lease_id ?? null, documentType: d.document_type, proof: null,
      rows: [] as RowChange[],
    }
    const rule: MoneyRule = voidedUnpaidIds.includes(d.id) ? 'paid' : 'billed'
    if (covered.has(d.id)) continue   // erased with its packet lease, listed there
    if (PROTECTED_DOCUMENTS.includes(d.id)) {
      lines.push({ ...base, verdict: 'protected', why: 'Arturo\'s MH 15 lease — never touched by this cleanup.' })
      continue
    }
    const p = await planErase(q, d.id, cleanupOptions(voidedUnpaidIds))
    if (!p.erased) {
      lines.push({ ...base, verdict: 'kept', why: `${p.words} It stays on record as voided.`,
        proof: d.lease_id && d.document_type === 'original_lease' ? await proveLease(q, d.lease_id, rule) : null })
      continue
    }
    const others = p.documents.filter(x => x.id !== d.id)
    for (const o of others) covered.add(o.id)
    lines.push({
      ...base, verdict: 'erase', goesWith: others.map(o => o.id), leaseId: p.leaseId,
      why: 'Voided, never completed, and no money touched it' +
           (p.leaseId ? (rule === 'paid'
             ? '; the lease it issued goes too — Nic confirmed it knowing what it billed (--erase-voided-unpaid): billed, voided unpaid, nothing paid, credited or settled'
             : '; the lease it issued goes too (nothing on it was billed, paid, credited or settled)') : '') +
           (others.length ? `; ${others.length} other document${others.length === 1 ? '' : 's'} of its packet go with it` : '') + '.',
      proof: p.leaseId ? await proveLease(q, p.leaseId, rule) : null,
      rows: await previewRows(q, p.documents.map(x => x.id), p.leaseId),
    })
    for (const x of p.documents) if (!eraseIds.includes(x.id)) eraseIds.push(x.id)
    urls.push(...p.files)
  }
  const files: string[] = []
  for (const url of [...new Set(urls)]) {
    const used = (await q(
      `SELECT 1 FROM lease_documents WHERE (base_pdf_url = $1 OR executed_pdf_url = $1) AND id <> ALL($2::uuid[])
       UNION ALL SELECT 1 FROM lease_templates WHERE base_pdf_url = $1
       UNION ALL SELECT 1 FROM disclosure_library_documents WHERE base_pdf_url = $1
       LIMIT 1`, [url, eraseIds])).rows[0]
    if (!used) files.push(url)
  }
  return { lines, files }
}

export async function applyOct14(
  q: Q, plan: Oct14Plan, voidedUnpaidIds: readonly string[] = [],
): Promise<{ erased: string[]; leases: string[]; files: string[]; refused: Oct14Line[] }> {
  const erased: string[] = []
  const leases: string[] = []
  const files: string[] = []
  const refused: Oct14Line[] = []
  for (const l of plan.lines) {
    if (l.verdict !== 'erase' || erased.includes(l.id)) continue
    // Judged again under the erase's own locks: anything that changed since
    // the plan was read keeps its document.
    const out = await eraseUnfinishedDocument(q, { id: l.id, lease_id: l.leaseId, document_type: l.documentType },
      cleanupOptions(voidedUnpaidIds))
    if (!out.erased) { refused.push({ ...l, verdict: 'kept', why: `${out.words} It stays on record as voided.` }); continue }
    erased.push(...out.documents.map(d => d.id))
    if (out.leaseId) leases.push(out.leaseId)
    files.push(...out.files)
  }
  return { erased, leases, files, refused }
}

function formatProof(p: LeaseProof): string[] {
  const out = [`      Lease ${p.leaseId} — money touched it: ${p.moneyTouched ? 'YES (kept)' : 'no'}` +
    (p.rule === 'paid' ? ' (judged by --erase-voided-unpaid: a bill voided unpaid is not money)' : '')]
  for (const b of p.bills) {
    out.push(`        bill ${b.id}: $${b.total} now, ${b.status}` +
      (Number(b.billed) !== Number(b.total) ? ` — it BILLED $${b.billed} (its subtotals; the void zeroed the total)` : ''))
  }
  for (const c of p.deletedCharges) {
    out.push(`        line ${c.id} (gone — deleted ${c.deletedOn}): ${c.kind} $${c.amount}, was ${c.status}`)
  }
  for (const c of p.charges) {
    out.push(`        line ${c.id}: ${c.kind} $${c.amount}, ${c.status}${c.note ? ` (${c.note})` : ''} — ` +
      (c.money.length ? `MONEY: ${c.money.join('; ')}` : 'no money: no dollar on it, and nothing paid, credited or settled with money'))
  }
  if (!p.bills.length && !p.charges.length) out.push('        no bills and no lines')
  return out
}

export function formatOct14(plan: Oct14Plan, heading: string): string {
  const out: string[] = [heading, '']
  const groups: Array<[Oct14Line['verdict'], string]> = [
    ['erase', 'ERASED — voided, never completed, no money touched'],
    ['kept', 'KEPT — voided, but stays on record'],
    ['protected', 'NOT TOUCHED — protected'],
  ]
  for (const [v, title] of groups) {
    const ls = plan.lines.filter(l => l.verdict === v)
    out.push(`${title}: ${ls.length}`)
    for (const l of ls) {
      out.push(`  ${l.company} | ${l.unit ? `Unit ${l.unit} | ` : ''}${l.title} | voided ${l.voidedOn ?? '(no date)'}` +
        `${l.sinceYesterday ? ' (since yesterday\'s run)' : ''} | ${l.id}`)
      out.push(`      ${l.why}`)
      if (l.proof) out.push(...formatProof(l.proof))
      if (l.rows.length) {
        out.push('      Rows --apply changes:')
        for (const r of l.rows) out.push(`        ${r.table} — ${r.change}: ${r.ids.length} — ${r.ids.join(', ')}`)
      }
    }
    out.push('')
  }
  const rv09 = plan.lines.find(l => l.id === RV09_DOCUMENT)
  out.push(`Mountain View RV 09 (${RV09_DOCUMENT}): ` +
    (!rv09 ? 'not found voided — already erased, or never voided.'
      : rv09.verdict === 'erase' ? `ERASED, with its lease ${rv09.leaseId ?? RV09_LEASE}.`
      : `${rv09.verdict.toUpperCase()} — ${rv09.why} Nic's #8 was asked as "$0.00 bills"; its move-in bill billed ` +
        'money before the 9/18 void zeroed it (the proof above). Once he confirms with that, re-run with ' +
        `--erase-voided-unpaid=${RV09_DOCUMENT}.`))
  out.push(`Files only the erased documents use: ${plan.files.length ? plan.files.join(', ') : 'none'}`)
  return out.join('\n')
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  // Documents Nic confirmed knowing what they billed (see the header).
  const voidedUnpaidIds = (process.argv.find(a => a.startsWith('--erase-voided-unpaid='))?.split('=')[1] ?? '')
    .split(',').map(x => x.trim()).filter(Boolean)
  const c: PoolClient = await getClient()
  const q: Q = c.query.bind(c) as any
  let files: string[] = []
  try {
    if (!apply) {
      // Reads only: the database refuses any write in this transaction.
      await c.query('BEGIN TRANSACTION READ ONLY')
      console.log(formatOct14(await planOct14(q, voidedUnpaidIds), 'DRY RUN — nothing written (re-run with --apply to erase).'))
      await c.query('ROLLBACK')
      return
    }
    await c.query('BEGIN')
    const plan = await planOct14(q, voidedUnpaidIds)
    const done = await applyOct14(q, plan, voidedUnpaidIds)
    await c.query('COMMIT')
    // Said only once it is true: nothing is "erased" until the COMMIT is in.
    console.log(formatOct14(plan,
      `APPLY — committed: ${done.erased.length} document(s) and ${done.leases.length} lease(s) erased.`))
    for (const r of done.refused) console.log(`  Kept after all (changed since the plan): ${r.title} — ${r.why}`)
    files = done.files
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  if (files.length) {
    const c2 = await getClient()
    try {
      const r = await removeOrphanedDocumentFiles(c2.query.bind(c2) as any, files)
      console.log(`Files removed: ${r.removed.length ? r.removed.join(', ') : 'none here'}` +
        (r.left.length ? `; could not remove: ${r.left.join(', ')}` : ''))
    } finally { c2.release() }
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
