/**
 * 10/13 (Nic) — the credit records whose chain forked, each restarted from today.
 *
 *   "restart the chain from today for each, with a recorded note explaining
 *    the break (old entries untouched)."
 *
 * Before 10/12, the marks one transaction wrote for a tenant shared one
 * recorded_at, and the next mark could attach to an earlier one instead of the
 * newest: the chain split (services/creditLedger appendEvent) — on production
 * 7 of the 12 into two branches, the others three, five or seven ways, and one
 * chain at two entries. 10/12
 * stopped new forks; the 12 chains production already carried (the 10/13
 * deploy's check, ~/gam-backups/deploy-1013/chains_before.json: 114 subjects,
 * 102 whole, 12 not) stayed broken, because a ledger event is never edited or
 * deleted.
 *
 * For each of those 12, named below by the event each breaks at, this appends
 * a restart (services/creditLedger restartChain): the first event of a new
 * chain, carrying a note that explains the break and the seal of the old chain
 * (its entries, its ends, where it broke, every point it split — the note names
 * each split too: hashed with the restart, it can never be corrected, 10/13
 * review). Every entry before it stays exactly
 * as it was; the marks after it link from it; verifyChain then reads the chain
 * as whole since the restart and reports the old break as explained history.
 * Only a fork breaking at the named event is restarted. A chain broken any
 * other way or anywhere else is printed and left alone, and so is any other
 * broken chain — the 10/13 answer covers these 12.
 *
 * Every chain is printed with its first bad event and every split. Run twice,
 * the second run finds nothing to restart. --apply prints the chain counts
 * before and after the restarts. Scores and stats do not move: a restart is
 * not a mark (getSubjectChain leaves it out).
 *
 * Order: run it before the credit rebuild (oct12_rerate_late_marks --apply), so
 * the rebuild's marks land on the restarted chains; the other order works too.
 *
 * DRY RUN BY DEFAULT — reads only (one READ ONLY transaction), so it can be
 * pointed at production. --apply writes, in one transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct13_restart_forked_credit_chains.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct13_restart_forked_credit_chains.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import {
  readChain, checkRestart, verifyEvents, verifyAllChains, verifyChain, restartChain,
  type ChainsReport, type ChainSplit,
} from '../services/creditLedger'

type Q = Pick<PoolClient, 'query'>

/**
 * The first bad event of each forked chain on 10/13 (the deploy's check,
 * chains_before.json `firstBad`): the breaks Nic's answer covers.
 */
export const FORKED_ON_10_13: readonly string[] = [
  '19971cd1-f1e4-40b9-a622-6c6793579f72',
  '3710cea8-6076-43d4-81ad-92ea5152e264',
  '38028213-7679-4158-880c-93b158bbbd84',
  '3a2cad57-aecb-4a69-8493-b0d0ce154fc3',
  '40f8e168-ee16-4347-9629-edecdf158627',
  '45307873-dea3-43cf-aef0-254fd77a8ebc',
  '77f22324-443d-4aae-8cbf-b9e8cf050081',
  'a1f91074-42db-46aa-8d27-aca4a7285e24',
  'bc360aa7-4de4-46ba-8a5a-4c5e9317e284',
  'd0e371ab-4992-4f9d-84be-21501085a738',
  'd3c8956f-13b5-49f2-90e9-6afc3ced233a',
  'f8457f84-5283-466d-ba34-768993b88ed2',
]

/** What the run does with a named chain. */
export const CHAIN_RESTART_ACTIONS = ['restart', 'already_restarted', 'left_alone'] as const
export type ChainRestartAction = typeof CHAIN_RESTART_ACTIONS[number]

const ACTION_WORDS: Record<ChainRestartAction, string> = {
  restart: 'RESTART',
  already_restarted: 'ALREADY RESTARTED',
  left_alone: 'LEFT ALONE',
}

export interface ForkedChain {
  /** The event the 10/13 check found the chain broken at. */
  namedEventId: string
  subjectId: string | null
  subjectType: string | null
  subjectRefId: string | null
  /** The tenant's name (null: not a tenant, or the tenant record is gone). */
  name: string | null
  /** Every entry of the chain, restarts included. */
  eventCount: number
  action: ChainRestartAction
  /** The chain's first bad event: now (restart, left alone), or the one its restart explains. */
  firstBadEventId: string | null
  reason: string | null
  /** Every point the chain splits (restart), or split (already restarted); empty when left alone. */
  splits: ChainSplit[]
  /** Why it is left alone. */
  why: string | null
  /** The restart (already restarted, or written by --apply). */
  restartEventId: string | null
}

export interface RestartPlan {
  /** Every subject's chain, checked before anything is written. */
  chains: ChainsReport
  named: ForkedChain[]
  /** Broken chains the 10/13 answer does not name: left as they are. */
  others: ChainsReport['bad']
}

/** The plan: pure reads (the dry run). */
export async function planRestarts(q: Q, named: readonly string[] = FORKED_ON_10_13): Promise<RestartPlan> {
  const chains = await verifyAllChains(q)
  const out: ForkedChain[] = []
  for (const id of named) {
    const s = (await q.query<{ subject_id: string; subject_type: string; subject_ref_id: string; name: string | null }>(
      `SELECT e.subject_id::text, s.subject_type, s.subject_ref_id::text,
              (SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')
                 FROM tenants t JOIN users u ON u.id = t.user_id
                WHERE s.subject_type = 'tenant' AND t.id = s.subject_ref_id) AS name
         FROM credit_events e JOIN credit_subjects s ON s.id = e.subject_id
        WHERE e.id = $1::uuid`, [id])).rows[0]
    const base: ForkedChain = {
      namedEventId: id, subjectId: s?.subject_id ?? null, subjectType: s?.subject_type ?? null,
      subjectRefId: s?.subject_ref_id ?? null, name: s?.name ?? null, eventCount: 0, action: 'left_alone',
      firstBadEventId: null, reason: null, splits: [], why: null, restartEventId: null,
    }
    if (!s) { out.push({ ...base, why: 'the event is not on the ledger' }); continue }
    const events = await readChain(q, s.subject_id)
    base.eventCount = events.length
    const check = checkRestart(events, id)
    if (check.ok) {
      out.push({ ...base, action: 'restart', firstBadEventId: check.brokenEventId ?? null, reason: check.brokenReason ?? null, splits: check.splits ?? [] })
      continue
    }
    const v = verifyEvents(events)
    const done = v.ok ? v.restarts?.find(r => r.brokenEventId === id) : undefined
    if (done) {
      out.push({ ...base, action: 'already_restarted', firstBadEventId: done.brokenEventId, reason: done.brokenReason, splits: done.splits, restartEventId: done.eventId })
      continue
    }
    out.push({ ...base, firstBadEventId: check.brokenEventId ?? v.firstBadEventId ?? null, reason: check.brokenReason ?? v.reason ?? null, why: check.why ?? null })
  }
  const namedSubjects = new Set(out.map(c => c.subjectId).filter((x): x is string => !!x))
  return { chains, named: out, others: chains.bad.filter(b => !namedSubjects.has(b.subjectId)) }
}

const andList = (xs: readonly string[]): string =>
  xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`

/**
 * The note recorded on a restart: the break, in words — every point the chain
 * split and how many entries attach there. 10/13 review: 5 of the 12 split
 * more than two ways and one at two entries, and the note is hashed with the
 * restart, so it can never be corrected: it is written from the same splits
 * the restart seals (restartChain refuses when they differ).
 */
export function restartNote(splits: readonly ChainSplit[], on: Date): string {
  if (splits.length === 0) throw new Error('a restart note explains a fork: no split given')
  const day = on.toLocaleDateString('en-US', { timeZone: 'America/Phoenix' })
  const where = splits.length === 1
    ? `split at entry ${splits[0].eventId}: ${splits[0].followedBy.length} entries attach to it, where only one should`
    : `split at ${splits.length} points: ${andList(splits.map(s => `${s.followedBy.length} entries attach to entry ${s.eventId}`))}, where only one should attach to each`
  return `Restarted ${day}: this record's chain ${where}. `
    + 'Before the 10/12 fix, entries written in the same moment could attach to the same earlier entry instead of one after another (a fork). '
    + 'Every entry before this point is kept exactly as it was; the chain continues from here.'
}

/**
 * Restart every named chain the plan restarts, inside the caller's transaction
 * (each re-checked under its lock), then every chain checked again: `after` is
 * what the transaction now holds.
 */
export async function applyRestarts(
  client: PoolClient,
  opts: { named?: readonly string[]; now?: Date } = {},
): Promise<{ plan: RestartPlan; restarted: ForkedChain[]; after: ChainsReport }> {
  const plan = await planRestarts(client, opts.named ?? FORKED_ON_10_13)
  const now = opts.now ?? new Date()
  const restarted: ForkedChain[] = []
  for (const c of plan.named) {
    if (c.action !== 'restart' || !c.subjectId || !c.firstBadEventId) continue
    const r = await restartChain({
      subjectId: c.subjectId,
      note: restartNote(c.splits, now),
      expectBrokenEventId: c.namedEventId,
      expectSplits: c.splits,
      occurredAt: now,
      attestationEvidence: { recorded_by: 'scripts/oct13_restart_forked_credit_chains', decided: 'Nic, 10/13' },
    }, client)
    restarted.push({ ...c, restartEventId: r.eventId })
  }
  return { plan, restarted, after: await verifyAllChains(client) }
}

const chainCounts = (r: ChainsReport): string =>
  `${r.subjects} subject(s) · ${r.ok} whole · ${r.okAfterRestart} whole since a restart · ${r.bad.length} broken`

/**
 * The plan as printed: every named chain with its first bad event and every
 * split. With `after` (--apply), the chain counts before AND after the
 * restarts — the plan's own counts are from before anything was written.
 */
export function formatPlan(plan: RestartPlan, header: string, after?: ChainsReport): string {
  const { chains, named, others } = plan
  const n = (a: ChainRestartAction) => named.filter(c => c.action === a).length
  const lines: string[] = [header]
  if (after) {
    lines.push(`Credit chains before: ${chainCounts(chains)}`)
    lines.push(`Credit chains after:  ${chainCounts(after)}`)
  } else {
    lines.push(`Credit chains: ${chainCounts(chains)}`)
  }
  lines.push(`${named.length} forked chain(s) named on 10/13: ${n('restart')} ${after ? 'restarted now' : 'to restart'}, ${n('already_restarted')} already restarted, ${n('left_alone')} left alone`)
  lines.push('')
  for (const c of named) {
    const who = c.subjectType === 'tenant'
      ? `tenant ${c.name ?? '(tenant record gone)'} (${c.subjectRefId})`
      : c.subjectType ? `${c.subjectType} ${c.subjectRefId}` : 'no subject'
    const splits = c.splits.length
      ? ` · split at ${c.splits.map(s => `${s.eventId} (${s.followedBy.length} entries attach)`).join(', ')}`
      : ''
    lines.push(`${ACTION_WORDS[c.action]} · subject ${c.subjectId ?? '—'} · ${who} · ${c.eventCount} entr${c.eventCount === 1 ? 'y' : 'ies'}`
      + ` · first bad ${c.firstBadEventId ?? c.namedEventId}${c.reason ? ` (${c.reason})` : ''}${splits}`
      + `${c.restartEventId ? ` · restart ${c.restartEventId}` : ''}${c.why ? ` · ${c.why}` : ''}`)
  }
  if (others.length) {
    lines.push('')
    lines.push(`${others.length} other broken chain(s), not named in the 10/13 answer — left as they are:`)
    for (const b of others) lines.push(`   subject ${b.subjectId} · first bad ${b.firstBadEventId} (${b.reason})`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  let restarted: ForkedChain[] = []
  try {
    if (!apply) {
      // Reads only: the database refuses any write in this transaction.
      await c.query('BEGIN TRANSACTION READ ONLY')
      console.log(formatPlan(await planRestarts(c), 'DRY RUN — nothing written (re-run with --apply to write).'))
      await c.query('ROLLBACK')
      return
    }
    await c.query('BEGIN')
    const done = await applyRestarts(c)
    restarted = done.restarted
    console.log(formatPlan({ ...done.plan, named: done.plan.named.map(x => restarted.find(r => r.namedEventId === x.namedEventId) ?? x) },
      `APPLY — ${restarted.length} chain(s) restarted.`, done.after))
    await c.query('COMMIT')
    console.log('Committed.')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  // After the commit: each restarted chain verified again.
  for (const r of restarted) {
    const v = await verifyChain(r.subjectId!)
    console.log(`subject ${r.subjectId}: ${v.ok ? 'whole since its restart' : `STILL BROKEN at ${v.firstBadEventId} (${v.reason})`}`)
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
