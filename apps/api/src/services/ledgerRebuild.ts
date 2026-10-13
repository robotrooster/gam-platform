/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: REBUILD FROM THE MONEY RECORDS
 *
 *   npm run ledger:rebuild -- --owner <landlord id> | --all
 *                             [--source-type X] [--since YYYY-MM-DD]
 *                             --mode dry_run | apply | from_scratch
 *
 * Every line in the ledger can be rebuilt from its source rows
 * (gam-ledger-design-2026-10-12 §8). A rebuild walks the union of the
 * company's current source rows and every source that has an active posting
 * (that is how a removed row gets reversed), in date order, and runs each
 * source through the same postSource the minute drain uses — one short
 * transaction per source, so a source that fails is recorded and skipped and
 * never stops the rest of its company.
 *
 *   dry_run       writes nothing to the ledger; lists every source whose
 *                 postings differ from what its projector wants (the drift)
 *   apply         re-posts only the sources that differ (fingerprints)
 *   from_scratch  re-posts every source, equal or not (a new rule version,
 *                 the first backfill). Refused once the company has closed a
 *                 month: closed months are never rewritten.
 *
 * Refused for a company with money and no books start date (design §6 J1:
 * every company with money has one before anything is rebuilt). Every run is
 * recorded in ledger_rebuild_runs with its counts and drift.
 *
 * Only registered source types are rebuilt (services/ledgerProjectors) —
 * production registers none until the projector phases ship. A rebuild runs
 * on the books' own pool (db/ledgerPool), and its re-posts restate in place:
 * GAM re-deriving the books is never a landlord's fix, so a company that shows
 * open-month fixes on the day made does not get its history re-dated to today
 * (ledgerEngine.postSource, 10/12 (Nic) review).
 */
import type { PoolClient } from 'pg'
import type { LedgerRunMode, LedgerSourceType } from '@gam/shared'
import { ledgerConnect as connect, ledgerQuery as query } from '../db/ledgerPool'
import { type LedgerOwner, ownerColOf, ownerIdOf, loadOwnerContext } from './ledgerOwner'
import {
  registeredLedgerSourceTypes, ledgerProjectorFor, postSource, diffSource,
  type SourceDiff, type LedgerSourceRef,
} from './ledgerEngine'

export interface RebuildOptions {
  owner: LedgerOwner | 'all'
  mode: Exclude<LedgerRunMode, 'check'>
  sourceType?: LedgerSourceType | null
  since?: string | null
  actorUserId?: string | null
}

export interface RebuildResult {
  runId: string
  ownerId: string | null
  status: 'done' | 'refused' | 'failed'
  reason?: string
  counts: { sources: number; posted: number; reversed: number; unchanged: number; failed: number; drift: number }
  drift: (SourceDiff | { sourceType: string; sourceId: string; status: 'failed'; message: string })[]
}

/** The sources a rebuild walks for one company, oldest first. */
export async function sourcesForOwner(
  client: PoolClient, owner: LedgerOwner, opts: { sourceType?: string | null; since?: string | null },
): Promise<{ type: string; id: string; day: string }[]> {
  const types = registeredLedgerSourceTypes().filter(t => !opts.sourceType || t === opts.sourceType)
  const seen = new Map<string, { type: string; id: string; day: string }>()
  for (const t of types) {
    const p = ledgerProjectorFor(t)!
    const refs: LedgerSourceRef[] = await p.listSources(client, owner, { since: opts.since ?? null })
    for (const r of refs) seen.set(`${t}:${r.id}`, { type: t, id: r.id, day: r.day ?? '0000-00-00' })
  }
  if (types.length) {
    const posted = await client.query<{ source_type: string; source_id: string; day: string }>(
      `SELECT source_type, source_id, min(intended_date)::text AS day
         FROM ledger_postings
        WHERE ${ownerColOf(owner)} = $1 AND role = 'post' AND superseded_at IS NULL
          AND source_type = ANY($2::text[])
          AND ($3::date IS NULL OR intended_date >= $3::date)
        GROUP BY source_type, source_id`, [ownerIdOf(owner), types, opts.since ?? null])
    for (const r of posted.rows) {
      const k = `${r.source_type}:${r.source_id}`
      if (!seen.has(k)) seen.set(k, { type: r.source_type, id: r.source_id, day: r.day })
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * 10/12 (Nic, ledger integrate): a source a rebuild or the nightly repair could
 * not post is LEFT IN THE OUTBOX (design §8: "a source that fails is recorded
 * … left in the outbox with last_error"). A rebuild walks sources that need
 * not be in the outbox at all; without this mark the minute drain never sees
 * them again — a record waiting on the owner's choice (a home-sale or
 * work-trade method) would post only at the next nightly repair after the
 * owner chose, not within the minute. Writers only ever insert into the
 * outbox; the drain's back-off still applies to a failing source.
 */
export async function keepInOutbox(sourceType: string, sourceId: string, ownerId: string | null): Promise<void> {
  await query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ($1, $2, $3::uuid)`,
    [sourceType, sourceId, ownerId])
}

async function finishRun(runId: string, status: string, counts: object, drift: unknown[], error?: string | null): Promise<void> {
  await query(
    `UPDATE ledger_rebuild_runs SET status = $2, finished_at = now(), counts = $3::jsonb, drift = $4::jsonb, error = $5
      WHERE id = $1`, [runId, status, JSON.stringify(counts), JSON.stringify(drift.slice(0, 2000)), error ?? null])
}

/** Rebuilds one company (see the header). */
export async function rebuildOwner(owner: LedgerOwner, opts: Omit<RebuildOptions, 'owner'>): Promise<RebuildResult> {
  const counts = { sources: 0, posted: 0, reversed: 0, unchanged: 0, failed: 0, drift: 0 }
  const drift: RebuildResult['drift'] = []
  const run = await query<{ id: string }>(
    `INSERT INTO ledger_rebuild_runs (${ownerColOf(owner)}, mode, scope, started_by)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
    [ownerIdOf(owner), opts.mode, JSON.stringify({ sourceType: opts.sourceType ?? null, since: opts.since ?? null }), opts.actorUserId ?? null])
  const runId = run[0].id
  const client = await connect()
  let sources: { type: string; id: string; day: string }[]
  let refusal: string | null = null
  try {
    const ctx = await loadOwnerContext(client, owner)
    sources = await sourcesForOwner(client, owner, { sourceType: opts.sourceType, since: opts.since })
    if (!ctx.exists) refusal = 'No such company.'
    else if (!ctx.booksStartDate && sources.length > 0) {
      refusal = 'This company has money and no books start date. Pick the books start date first.'
    } else if (opts.mode === 'from_scratch' && ctx.closedThrough) {
      refusal = `The books are closed through ${ctx.closedThrough}; a rebuild from scratch would rewrite closed months. Use apply.`
    }
  } finally {
    client.release()
  }
  if (refusal) {
    await finishRun(runId, 'refused', counts, [], refusal)
    return { runId, ownerId: ownerIdOf(owner), status: 'refused', reason: refusal, counts, drift }
  }

  // 10/12 (Nic, ledger review): the company's opening posting is one of the
  // sources walked here (dated the books start, so after everything dated
  // before it): a source before the start need not mark it for the drain
  // until the walk has passed it.
  const ownerId = ownerIdOf(owner)
  const opening = sources!.some(s => s.type === 'opening' && s.id === ownerId)
  let openingWalked = false
  try {
    for (const s of sources!) {
      counts.sources++
      if (opts.mode === 'dry_run') {
        const c = await connect()
        try {
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
          for (const d of await diffSource(c, s.type, s.id)) {
            if (d.status === 'equal') { counts.unchanged++; continue }
            counts.drift++
            drift.push(d)
          }
          await c.query('COMMIT')
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {})
          counts.failed++
          drift.push({ sourceType: s.type, sourceId: s.id, status: 'failed', message: e instanceof Error ? e.message : String(e) })
        } finally {
          c.release()
        }
        continue
      }
      const res = await postSource(s.type, s.id, {
        force: opts.mode === 'from_scratch' ? owner : false,
        rebuildRunId: runId, actorUserId: opts.actorUserId ?? null, ownerHint: ownerIdOf(owner),
        openingFollows: opening && !openingWalked,
      })
      if (s.type === 'opening' && s.id === ownerId) openingWalked = true
      if (res.error) {
        counts.failed++
        drift.push({ sourceType: s.type, sourceId: s.id, status: 'failed', message: `${res.error.reasonCode}: ${res.error.message}` })
        await keepInOutbox(s.type, s.id, ownerIdOf(owner))
        continue
      }
      if (res.busy) {
        // 10/12 (Nic) review: the books were busy for a moment (a month closing);
        // nothing was written. Counted so the run says to go again — and left
        // in the outbox, so the minute drain posts it if nobody does.
        await keepInOutbox(s.type, s.id, ownerIdOf(owner))
        counts.failed++
        drift.push({ sourceType: s.type, sourceId: s.id, status: 'failed', message: 'busy: the books were busy for a moment; run the rebuild again' })
        continue
      }
      counts.posted += res.posted
      counts.reversed += res.reversed
      counts.unchanged += res.unchanged
    }
    await finishRun(runId, 'done', counts, drift)
    return { runId, ownerId: ownerIdOf(owner), status: 'done', counts, drift }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finishRun(runId, 'failed', counts, drift, msg)
    return { runId, ownerId: ownerIdOf(owner), status: 'failed', reason: msg, counts, drift }
  }
}

/** Rebuilds one company or every landlord company (each on its own; one refusal never stops the rest). */
export async function rebuildLedger(opts: RebuildOptions): Promise<RebuildResult[]> {
  if (opts.owner !== 'all') return [await rebuildOwner(opts.owner, opts)]
  const owners = await query<{ id: string }>(`SELECT id FROM landlords ORDER BY created_at, id`)
  const out: RebuildResult[] = []
  for (const o of owners) {
    const owner: LedgerOwner = { landlordId: o.id }
    // A company with nothing to rebuild gets no run row.
    const c = await connect()
    let n = 0
    try { n = (await sourcesForOwner(c, owner, { sourceType: opts.sourceType, since: opts.since })).length } finally { c.release() }
    if (n === 0) continue
    out.push(await rebuildOwner(owner, opts))
  }
  return out
}
