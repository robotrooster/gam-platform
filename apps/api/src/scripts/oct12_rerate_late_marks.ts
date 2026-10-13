/**
 * 10/12 (Nic) — every tenant's payment history rebuilt as ONE MARK PER BILL.
 *
 *   "the payment history should be a health percentage. one mark per invoice."
 *
 * Before this each rent and utility row carried its own mark (rent on time,
 * electric late, water within grace), and the credit screens' "on-time %"
 * counted lines while the Rent Roll's payment health counted bills. Now every
 * bill (invoice — the household's bill) is judged by the payment-health rule
 * (services/creditBillMarks: on time / paid late by its days past grace /
 * partly paid past grace / unpaid past grace; work trade = on time; $0 lines
 * and late fees never decide it; the onboarding month is good news only;
 * voided lines and bills left out) and carries ONE mark, and the % the
 * tenant's record and the landlord's screening page show is that payment
 * health: bills on time ÷ bills judged.
 *
 * Through the ledger's correction mechanism only — never an edit or delete of
 * an event, the hash chain untouched:
 *   - a bill's per-line marks are replaced by its one bill mark (appended;
 *     each old mark superseded 'replaced_by_bill_mark', named in the new
 *     mark's replaces_event_ids);
 *   - a bill that earns no mark (judged not yet, the onboarding month paid
 *     late with no late fee, a voided bill, only $0 lines) has its marks
 *     withdrawn (each points at itself, 'attestation_invalidated');
 *   - a bill unpaid or partly paid past its grace period gets its mark;
 *   - a per-line mark no bill stands behind (its row is gone, or on no
 *     invoice) is withdrawn.
 * A bill an admin corrected after a dispute is left alone; a bill with money
 * still clearing waits for it to settle (the nightly run marks it then).
 *
 * This replaces the earlier 10/12 re-rate of per-line marks (the first late
 * day, $0 lines, bills written late, the onboarding month): the bill rule
 * carries all four.
 *
 * Every tenant whose history changes is printed: their history before and
 * after, and each bill — its marks before, its mark after, and whether that is
 * better or worse for them. Run twice, the second run finds nothing. Scores
 * and stats of the tenants whose marks changed are recomputed after the
 * commit.
 *
 * DRY RUN BY DEFAULT — the dry run only reads (one READ ONLY transaction), so
 * it can be pointed at production. --apply writes, in one transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct12_rerate_late_marks.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct12_rerate_late_marks.ts --apply
 */
import type { PoolClient } from 'pg'
import type { CreditEventType } from '@gam/shared'
import { getClient } from '../db'
import {
  planBillMarks, applyBillMarkPlan, orphanLineMarks, everyBill, PAYMENT_MARK_TYPES, BILL_MARK_BASIS, ROW_BILL_PREFIX,
  type BillMarkPlan, type BillMarkChange, type OrphanLineMark,
} from '../services/creditBillMarks'
import { recomputeScoresAfterCorrection } from '../services/creditLedgerEmitters'
import { refreshSubjectStats } from '../services/creditStats'
import { getOrCreateSubject, supersedeEvent } from '../services/creditLedger'
import { logger } from '../lib/logger'

type Q = Pick<PoolClient, 'query'>

/** Better or worse for the tenant. */
export const MARK_CHANGE_DIRECTIONS = ['better', 'worse', 'same'] as const
export type MarkChangeDirection = typeof MARK_CHANGE_DIRECTIONS[number]

/** The payment marks in words (the credit screens' own wording). */
const MARK_WORDS: Partial<Record<CreditEventType, string>> = {
  payment_received_on_time: 'on time',
  payment_received_late_grace: 'within grace',
  payment_received_late_minor: 'late, 1–3 days past grace',
  payment_received_late_major: 'late, 4–15 days past grace',
  payment_received_late_severe: 'late, 16+ days past grace',
  payment_partial: 'partly paid past grace',
  payment_skipped: 'unpaid past grace',
  payment_failed_nsf: 'payment failed',
}
export const markWords = (t: CreditEventType | null): string => t === null ? 'no mark' : (MARK_WORDS[t] ?? t)

/** How bad a mark is for the tenant: 0 on time (within grace is on time under the rule), higher is worse. */
function severity(t: CreditEventType): number {
  switch (t) {
    case 'payment_received_on_time':
    case 'payment_received_late_grace': return 0
    case 'payment_received_late_minor': return 1
    case 'payment_received_late_major': return 2
    case 'payment_partial': return 2
    case 'payment_received_late_severe': return 3
    case 'payment_failed_nsf': return 3
    case 'payment_skipped': return 4
    default: return 2
  }
}

/**
 * Better or worse: the worst of the marks before against the mark after. A
 * bad mark taken away is better, a good one taken away is worse; a new bad
 * mark is worse, a new good one better; the same standing in fewer marks
 * (three on-time lines → one on-time bill) is the same.
 */
export function direction(before: readonly CreditEventType[], after: CreditEventType | null): MarkChangeDirection {
  const worst = before.length ? Math.max(...before.map(severity)) : null
  if (after === null) {
    if (worst === null) return 'same'
    return worst > 0 ? 'better' : 'worse'
  }
  const now = severity(after)
  if (worst === null) return now > 0 ? 'worse' : 'better'
  return now < worst ? 'better' : now > worst ? 'worse' : 'same'
}

export interface RebuildPlan {
  /** Every bill judged (unchanged ones included). */
  bills: BillMarkPlan[]
  /** Per-line marks with no bill behind them (withdrawn). */
  orphans: OrphanLineMark[]
}

/** The rebuild's plan: pure reads (the dry run). */
export async function planRebuild(q: Q, opts: { asOf?: string | null } = {}): Promise<RebuildPlan> {
  const ids = await everyBill(q)
  const bills = await planBillMarks(q, ids, { asOf: opts.asOf ?? null })
  return { bills, orphans: await orphanLineMarks(q) }
}

/** The bills a plan changes. */
export const changing = (plan: RebuildPlan): BillMarkPlan[] =>
  plan.bills.filter(p => p.action === 'write' || p.action === 'correct' || p.action === 'withdraw')

export interface RebuildResult {
  changes: BillMarkChange[]
  orphansWithdrawn: OrphanLineMark[]
  /** Credit subjects whose chain changed (scores and stats refreshed after the commit). */
  subjects: string[]
}

/**
 * Apply the rebuild inside the caller's transaction: every bill whose marks
 * are not what the rule gives them is brought there (each household's
 * subject locked first, the bill judged again under the lock), and every
 * per-line mark with no bill is withdrawn.
 */
export async function applyRebuild(client: PoolClient, opts: { asOf?: string | null } = {}): Promise<RebuildResult> {
  const plan = await planRebuild(client, opts)
  const subjects = new Set<string>()
  const households = [...new Set(changing(plan).map(p => p.bill.householdId).filter((x): x is string => !!x))].sort()
  for (const hh of households) {
    const subjectId = await getOrCreateSubject(client, 'tenant', hh)
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`credit_subject:${subjectId}`])
  }
  // Judged again now the households are locked: a settle that landed between
  // the first read and the locks is counted.
  const fresh = await planBillMarks(client, changing(plan).map(p => p.bill.billKey), { asOf: opts.asOf ?? null })
  const changes: BillMarkChange[] = []
  for (const p of fresh) {
    if (p.action !== 'write' && p.action !== 'correct' && p.action !== 'withdraw') continue
    const c = await applyBillMarkPlan(client, p)
    changes.push(c)
    c.subjectIds.forEach(s => subjects.add(s))
  }
  for (const o of plan.orphans) {
    await supersedeEvent(client, o.id, o.id, 'attestation_invalidated')
    subjects.add(o.subjectId)
  }
  return { changes, orphansWithdrawn: plan.orphans, subjects: [...subjects] }
}

// ─── The report ──────────────────────────────────────────────────────────────

export interface TenantHistoryChange {
  tenantId: string
  name: string
  before: { marks: number; onTime: number; percent: number | null }
  after: { bills: number; onTime: number; percent: number | null }
  bills: Array<{
    /** The invoice's id, or "row:<payment id>" for a charge on no invoice. */
    billKey: string; label: string; before: string; after: string
    direction: MarkChangeDirection
  }>
  orphans: Array<{ eventId: string; mark: string; direction: MarkChangeDirection; why: string }>
}

/** Every tenant whose history the plan changes, in words: their history before and after, and each bill. */
export async function describeRebuild(q: Q, plan: RebuildPlan): Promise<TenantHistoryChange[]> {
  const moving = changing(plan)
  const tenants = new Set<string>([
    ...moving.flatMap(p => [p.bill.householdId, p.current?.tenantId, ...p.lines.map(l => l.tenantId), ...p.extra.map(l => l.tenantId)])
      .filter((x): x is string => !!x),
    ...plan.orphans.map(o => o.tenantId),
  ])
  if (tenants.size === 0) return []
  const ids = [...tenants]
  const names = new Map<string, string>()
  for (const r of (await q.query<{ id: string; name: string }>(
    `SELECT t.id::text AS id, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name
       FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[])`, [ids])).rows) names.set(r.id, r.name)
  const where = new Map<string, string>()
  const invoiceIds = moving.map(p => p.bill.invoiceId).filter((x): x is string => !!x)
  const loneRows = moving.filter(p => !p.bill.invoiceId).map(p => p.bill.billKey.slice(ROW_BILL_PREFIX.length))
  for (const r of (await q.query<{ key: string; label: string }>(
    `SELECT inv.id::text AS key,
            COALESCE(pr.name, '—') || ' ' || COALESCE(u.unit_number, '—') AS label
       FROM invoices inv LEFT JOIN units u ON u.id = inv.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE inv.id = ANY($1::uuid[])
     UNION ALL
     SELECT '${ROW_BILL_PREFIX}' || p.id::text,
            COALESCE(pr.name, '—') || ' ' || COALESCE(u.unit_number, '—') || ' · ' || p.type || ' on no invoice'
       FROM payments p LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE p.id = ANY($2::uuid[])`, [invoiceIds, loneRows])).rows) where.set(r.key, r.label)

  // Before: every live payment mark the tenant carries (as the screens counted
  // them: on time ÷ all payment marks).
  const beforeMarks = new Map<string, CreditEventType[]>()
  for (const r of (await q.query<{ tenant_id: string; event_type: CreditEventType }>(
    `SELECT s.subject_ref_id::text AS tenant_id, e.event_type
       FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id AND s.subject_type = 'tenant'
      WHERE e.superseded_by IS NULL AND e.event_type = ANY($1::text[]) AND s.subject_ref_id = ANY($2::uuid[])`,
    [PAYMENT_MARK_TYPES, ids])).rows) beforeMarks.set(r.tenant_id, [...(beforeMarks.get(r.tenant_id) ?? []), r.event_type])

  // After: one mark per bill the rule marks (a bill left alone keeps its mark).
  const afterMarks = new Map<string, CreditEventType[]>()
  for (const p of plan.bills) {
    const mark = p.action === 'clearing' || p.action === 'disputed' ? (p.current?.eventType ?? null) : p.bill.mark
    const who = p.action === 'clearing' || p.action === 'disputed' ? (p.current?.tenantId ?? null) : p.bill.householdId
    if (!mark || !who || !tenants.has(who)) continue
    afterMarks.set(who, [...(afterMarks.get(who) ?? []), mark])
  }

  const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const onTime = (ts: readonly CreditEventType[]) => ts.filter(t => t === 'payment_received_on_time').length
  const pct = (n: number, d: number) => d ? Math.round((n / d) * 100) : null
  const out: TenantHistoryChange[] = ids.map(id => {
    const b = beforeMarks.get(id) ?? []
    const a = afterMarks.get(id) ?? []
    return {
      tenantId: id, name: names.get(id) || id,
      before: { marks: b.length, onTime: onTime(b), percent: pct(onTime(b), b.length) },
      after: { bills: a.length, onTime: a.filter(t => t === 'payment_received_on_time' || t === 'payment_received_late_grace').length,
        percent: pct(a.filter(t => t === 'payment_received_on_time' || t === 'payment_received_late_grace').length, a.length) },
      bills: [], orphans: [],
    }
  })
  const byId = new Map(out.map(t => [t.tenantId, t]))
  for (const p of moving) {
    const prior: Array<{ type: CreditEventType; what: string }> = [
      ...(p.current ? [{ type: p.current.eventType, what: 'bill' }] : []),
      ...p.extra.map(m => ({ type: m.eventType, what: 'bill' })),
      ...p.lines.map(m => ({ type: m.eventType, what: String(m.eventData.payment_type ?? 'line') })),
    ]
    const now = p.action === 'withdraw' ? null : p.bill.mark
    const after = now === null ? 'no mark'
      : `${markWords(now)}${p.bill.stamp === 'paid_late' ? ` (${p.bill.days} day${p.bill.days === 1 ? '' : 's'} past grace)` : ''}`
    const entry = {
      billKey: p.bill.billKey,
      label: `${p.bill.invoiceNumber ?? 'Charge'} · ${where.get(p.bill.billKey) ?? '—'} · ${monthName(p.bill.month)} bill`,
      before: prior.length ? prior.map(x => `${x.what}: ${markWords(x.type)}`).join('; ') : 'no mark',
      after,
      direction: direction(prior.map(x => x.type), now),
    }
    const who = p.bill.householdId ?? p.current?.tenantId ?? p.lines[0]?.tenantId
    if (who) byId.get(who)?.bills.push(entry)
  }
  for (const o of plan.orphans) {
    byId.get(o.tenantId)?.orphans.push({
      eventId: o.id, mark: markWords(o.eventType), direction: direction([o.eventType], null),
      why: 'its payment row no longer exists',
    })
  }
  return out.filter(t => t.bills.length || t.orphans.length).sort((a, z) => a.name.localeCompare(z.name))
}

/** The report as printed. */
export function formatRebuild(changes: readonly TenantHistoryChange[], header: string): string {
  const lines: string[] = [header]
  const all = changes.flatMap(t => [...t.bills.map(b => b.direction), ...t.orphans.map(o => o.direction)])
  const n = (d: MarkChangeDirection) => all.filter(x => x === d).length
  lines.push(`${changes.length} tenant(s) whose history changes · ${all.length} bill(s) or mark(s): ${n('better')} better, ${n('worse')} worse, ${n('same')} the same`)
  const p = (x: number | null) => x === null ? '—' : `${x}%`
  for (const t of changes) {
    lines.push('')
    lines.push(`${t.name} — before: ${t.before.marks} mark(s), ${t.before.onTime} on time (${p(t.before.percent)}) → after: ${t.after.bills} bill(s), ${t.after.onTime} on time (${p(t.after.percent)})`)
    for (const b of t.bills) lines.push(`   ${b.label}: ${b.before} → ${b.after} · ${b.direction.toUpperCase()}`)
    for (const o of t.orphans) lines.push(`   mark ${o.eventId} (${o.mark}) withdrawn — ${o.why} · ${o.direction.toUpperCase()}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  let subjects: string[] = []
  try {
    if (!apply) {
      // Reads only: the database refuses any write in this transaction.
      await c.query('BEGIN TRANSACTION READ ONLY')
      const plan = await planRebuild(c)
      console.log(formatRebuild(await describeRebuild(c, plan), 'DRY RUN — nothing written (re-run with --apply to write).'))
      const left = plan.bills.filter(b => b.action === 'clearing' || b.action === 'disputed')
      if (left.length) console.log(`\n${left.length} bill(s) left as they are: ${left.map(b => `${b.bill.invoiceNumber ?? b.bill.billKey} (${b.action === 'clearing' ? 'money still clearing' : 'an admin corrected it after a dispute'})`).join(', ')}`)
      await c.query('ROLLBACK')
      return
    }
    await c.query('BEGIN')
    const plan = await planRebuild(c)
    const report = await describeRebuild(c, plan)
    const done = await applyRebuild(c)
    console.log(formatRebuild(report, `APPLY — ${done.changes.length} bill(s) changed, ${done.orphansWithdrawn.length} mark(s) with no bill withdrawn.`))
    await c.query('COMMIT')
    subjects = done.subjects
    console.log('Committed.')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  await recomputeScoresAfterCorrection(subjects)
  for (const s of subjects) {
    try { await refreshSubjectStats(s) } catch (err) { logger.error({ err, subjectId: s }, '[oct12-rebuild] stats refresh failed; the nightly run will pick it up') }
  }
}

/** Marks written by the rebuild carry this basis (re-exported for the tests). */
export { BILL_MARK_BASIS }

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
