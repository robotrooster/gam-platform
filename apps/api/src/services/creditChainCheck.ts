import type { PoolClient } from 'pg'
import { db } from '../db'
import { humanize, type CreditChainCheckOutcome } from '@gam/shared'
import { dateIn } from '../lib/timezone'
import { logger } from '../lib/logger'
import { verifyAllChains, CHAIN_BREAK_LABEL, type ChainBreak } from './creditLedger'

// ============================================================
// The nightly credit chain check (10/13, Nic: "ADD the nightly chain check
// (break flagged in the morning admin email)").
//
// Every credit record's chain is verified each night (verifyAllChains, in the
// 03:00 credit nightly, after tonight's marks are written). A chain whole —
// never restarted, or whole since a restart that explains its old break — is
// not news. A chain broken is named in the morning admin email: whose record
// it is (the tenant's name; a company's record by its company name), and the
// first bad entry (what it is, its day, its id) with the break in plain words.
// A broken chain is named every morning it stays broken: nothing here repairs
// one (a restart is a decision, 10/13), so it keeps showing until it is dealt
// with.
//
// 10/13 evening (Nic): "Broken credit chain: fold into the 8:05 MORNING admin
// email (not its own 3 am email)." The 03:00 check no longer emails anybody:
// it writes down what it found (credit_chain_check_runs — recordCreditChainCheck),
// and the one 8:05 morning admin email (services/readerOrders chaseReaderOrders,
// which already goes out every morning anything waits on GAM) carries it
// (creditChainMorningSection).
//
// 10/13 (review), kept: a quiet morning has to mean every chain is whole. The
// morning email says the check did not run when last night's check could not
// finish, has still not finished, or is not on record at all since the morning
// before — so silence is never read as "every chain whole" when none was
// checked.
// ============================================================

type Q = Pick<PoolClient, 'query'>

/** One broken chain, as the morning email names it. */
export interface BrokenChain {
  subjectId: string
  /** tenant / landlord / manager / property (null: the subject row is gone). */
  subjectType: string | null
  /** The tenant's name, or a landlord record's company name; null when there is none. */
  name: string | null
  /** The first bad entry. */
  firstBadEventId: string
  firstBadEventType: string | null
  /** The day the first bad entry happened, Phoenix calendar (YYYY-MM-DD). */
  firstBadOn: string | null
  break: ChainBreak | null
  /** verifyChain's reason, word for word (for whoever repairs it). */
  reason: string
}

export interface ChainCheckResult {
  /** Every chain checked. */
  subjects: number
  /** Whole (never restarted, or whole since a restart). */
  whole: number
  broken: BrokenChain[]
}

/** Every credit chain verified, the broken ones named — reads only (q may be a READ ONLY transaction). */
export async function checkCreditChains(q: Q = db): Promise<ChainCheckResult> {
  const report = await verifyAllChains(q)
  if (!report.bad.length) return { subjects: report.subjects, whole: report.ok + report.okAfterRestart, broken: [] }
  const subjects = new Map((await q.query<{ id: string; subject_type: string; name: string | null }>(
    `SELECT s.id::text, s.subject_type,
            CASE s.subject_type
              WHEN 'tenant' THEN (
                SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')
                  FROM tenants t JOIN users u ON u.id = t.user_id
                 WHERE t.id = s.subject_ref_id)
              WHEN 'landlord' THEN (
                SELECT NULLIF(TRIM(l.business_name), '') FROM landlords l WHERE l.id = s.subject_ref_id)
            END AS name
       FROM credit_subjects s
      WHERE s.id = ANY($1::uuid[])`,
    [report.bad.map((b) => b.subjectId)])).rows.map((r) => [r.id, r]))
  const entries = new Map((await q.query<{ id: string; event_type: string; occurred_at: Date }>(
    `SELECT id::text, event_type, occurred_at FROM credit_events WHERE id = ANY($1::uuid[])`,
    [report.bad.map((b) => b.firstBadEventId)])).rows.map((r) => [r.id, r]))
  const broken = report.bad.map((b): BrokenChain => {
    const s = subjects.get(b.subjectId)
    const e = entries.get(b.firstBadEventId)
    return {
      subjectId: b.subjectId,
      subjectType: s?.subject_type ?? null,
      name: s?.name ?? null,
      firstBadEventId: b.firstBadEventId,
      firstBadEventType: e?.event_type ?? null,
      firstBadOn: e ? dateIn('America/Phoenix', new Date(e.occurred_at)) : null,
      break: b.break,
      reason: b.reason,
    }
  })
  return { subjects: report.subjects, whole: report.ok + report.okAfterRestart, broken }
}

const usDate = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}/${ymd.slice(0, 4)}`

/** Whose record a broken chain is, in words. */
function whose(b: BrokenChain): string {
  if (!b.subjectType) return 'A credit record'
  const kind = humanize(b.subjectType).toLowerCase()
  if (b.name) return `${b.name} (${kind})`
  return b.subjectType === 'tenant' ? 'A tenant with no name on file' : `A ${kind} record`
}

/** A broken chain in words: whose record, its first bad entry (what it is, its day), and the break. */
function inWords(b: BrokenChain): { record: string; firstBadEntry: string; problem: string } {
  return {
    record: whose(b),
    firstBadEntry: [b.firstBadEventType ? humanize(b.firstBadEventType) : 'an entry', b.firstBadOn ? usDate(b.firstBadOn) : null]
      .filter(Boolean).join(', '),
    problem: b.break ? CHAIN_BREAK_LABEL[b.break] : b.reason,
  }
}

/** The broken chains in the morning email: their part of its title, and one line per chain. */
export function brokenChainsEmail(broken: readonly BrokenChain[]): { title: string; body: string } {
  const n = broken.length
  const lines = broken.map((b) => {
    const w = inWords(b)
    return `BROKEN — ${w.record}: first bad entry ${w.firstBadEntry} (entry ${b.firstBadEventId}) — ${w.problem}. Credit record ${b.subjectId}.`
  })
  return {
    title: `${n} credit history chain${n === 1 ? '' : 's'} broken`,
    body: lines.join('\n'),
  }
}

/**
 * The email's context block for the broken chains, one entry per chain — whose
 * record, the first bad entry, the break — with its ids and verifyChain's
 * reason, word for word, for whoever repairs it.
 */
export function brokenChainsContext(r: ChainCheckResult): Record<string, unknown> {
  return {
    checked: r.subjects,
    whole: r.whole,
    broken: r.broken.map((b) => ({
      ...inWords(b), subjectId: b.subjectId, firstBadEventId: b.firstBadEventId, break: b.break, reason: b.reason,
    })),
  }
}

/**
 * The nightly record: chains checked, whole and broken. `recorded`: tonight's
 * run is written down for the morning email (credit_chain_check_runs).
 * `errors`: the check did not finish, or its run could not be written down.
 */
export interface ChainRecordResult {
  subjects: number
  whole: number
  broken: number
  recorded: boolean
  errors: number
}

/** Write down a night's run (a new row, or the one started for it). Returns whether it is on record; never throws. */
async function writeRun(id: string | null, run: {
  outcome: Exclude<CreditChainCheckOutcome, 'running'>; subjects?: number; whole?: number; broken?: BrokenChain[]; error?: string
}): Promise<boolean> {
  const vals = [run.outcome, run.subjects ?? null, run.whole ?? null, run.broken?.length ?? null,
    JSON.stringify(run.broken ?? []), run.error ?? null]
  try {
    const r = id
      ? await db.query(
        `UPDATE credit_chain_check_runs
            SET outcome = $2, finished_at = now(), subjects = $3, whole = $4, broken = $5, broken_chains = $6::jsonb, error = $7
          WHERE id = $1`, [id, ...vals])
      : await db.query(
        `INSERT INTO credit_chain_check_runs (outcome, finished_at, subjects, whole, broken, broken_chains, error)
         VALUES ($1, now(), $2, $3, $4, $5::jsonb, $6)`, vals)
    return (r.rowCount ?? 0) === 1
  } catch (err) {
    logger.error({ err, outcome: run.outcome }, "[credit-chains] tonight's check could not be written down for the morning email")
    return false
  }
}

/**
 * 10/13 evening (Nic): a night the check could not finish is written down as
 * 'failed', with why — the morning email says it did not run. Returns whether
 * it is on record; never throws.
 */
export async function recordChainCheckFailed(err: unknown, runId: string | null = null): Promise<boolean> {
  const why = err instanceof Error ? err.message : String(err)
  return writeRun(runId, { outcome: 'failed', error: why })
}

/**
 * The 03:00 check: every chain checked, and what it found written down for the
 * 8:05 morning admin email (credit_chain_check_runs) — the broken chains named,
 * or that every chain is whole. Nobody is emailed from here (10/13 evening, Nic).
 * The run is started before the check (a night that dies half way reads as
 * unfinished in the morning) and finished with its outcome; a check that
 * cannot finish is written down as 'failed'. `q` is what the check reads with;
 * the run is written on the pool. Never throws.
 */
export async function recordCreditChainCheck(q: Q = db): Promise<ChainRecordResult> {
  let runId: string | null = null
  try {
    runId = (await db.query<{ id: string }>(`INSERT INTO credit_chain_check_runs DEFAULT VALUES RETURNING id`)).rows[0]?.id ?? null
  } catch (err) {
    // Written whole at the end instead.
    logger.error({ err }, "[credit-chains] tonight's check could not be started on record")
  }
  let r: ChainCheckResult
  try {
    r = await checkCreditChains(q)
  } catch (err) {
    // Checked again tomorrow night; the morning email says it did not run.
    logger.error({ err }, '[credit-chains] the check did not finish')
    return { subjects: 0, whole: 0, broken: 0, recorded: await recordChainCheckFailed(err, runId), errors: 1 }
  }
  const recorded = await writeRun(runId, {
    outcome: r.broken.length ? 'broken' : 'whole', subjects: r.subjects, whole: r.whole, broken: r.broken,
  })
  // Not on record: the morning email says the check did not run, and the
  // chains are checked again tomorrow night.
  return { subjects: r.subjects, whole: r.whole, broken: r.broken.length, recorded, errors: recorded ? 0 : 1 }
}

/** What last night's check gives the morning admin email. */
export interface ChainMorningSection {
  /** 'whole': nothing to say. */
  outcome: 'whole' | 'broken' | 'did_not_run'
  /** Its part of the email's title (null when whole). */
  title: string | null
  /** Its lines of the email (none when whole). */
  lines: string[]
  /** Its part of the email's context block (null when whole). */
  context: Record<string, unknown> | null
}

/** How long before the morning email a night's run may have started and still be last night's. */
const LAST_NIGHT_HOURS = 24

const NOT_CHECKED_TAIL = 'No chain was checked, so this email does not mean every chain is whole. The check runs again tonight.'

/** "10/13/2026 3:00 AM" — a run's moment on GAM's (Arizona) calendar. */
function arizonaMoment(at: Date): string {
  return new Date(at).toLocaleString('en-US', {
    timeZone: 'America/Phoenix', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).replace(',', '')
}

/**
 * 10/13 evening (Nic): "Broken credit chain: fold into the 8:05 MORNING admin
 * email." Last night's check — the newest run that started within the last
 * LAST_NIGHT_HOURS (on the database's clock) — as the morning email says it:
 *   - whole: nothing;
 *   - broken: each broken chain named, one line each (brokenChainsEmail);
 *   - did not run: it could not finish (with why), it has still not finished,
 *     or no run is on record since the morning before (with the last one there
 *     is) — a quiet morning means every chain is whole.
 * Never throws: a run that cannot be read is said as not checked.
 */
export async function creditChainMorningSection(): Promise<ChainMorningSection> {
  const notRun = (line: string, context: Record<string, unknown>): ChainMorningSection => ({
    outcome: 'did_not_run', title: 'The credit chain check did not run last night', lines: [line], context,
  })
  try {
    const { rows: [last] } = await db.query<{
      started_at: Date; outcome: CreditChainCheckOutcome; subjects: number | null; whole: number | null
      broken_chains: BrokenChain[]; error: string | null; last_night: boolean
    }>(
      `SELECT started_at, outcome, subjects, whole, broken_chains, error,
              started_at > now() - make_interval(hours => $1) AS last_night
         FROM credit_chain_check_runs ORDER BY started_at DESC, id DESC LIMIT 1`, [LAST_NIGHT_HOURS])
    if (!last || !last.last_night) {
      return notRun(`CREDIT CHAINS NOT CHECKED — the credit chain check did not run last night (${last
        ? `the last check on record started ${arizonaMoment(last.started_at)}` : 'there is no check on record'}). ${NOT_CHECKED_TAIL}`,
      { creditChainCheck: 'did_not_run', lastStartedAt: last?.started_at ?? null })
    }
    if (last.outcome === 'failed') {
      return notRun(`CREDIT CHAINS NOT CHECKED — last night's credit chain check stopped before it finished: ${last.error ?? 'no reason on record'}. ${NOT_CHECKED_TAIL}`,
        { creditChainCheck: 'failed', startedAt: last.started_at, error: last.error })
    }
    if (last.outcome === 'running') {
      return notRun(`CREDIT CHAINS NOT CHECKED — last night's credit chain check started ${arizonaMoment(last.started_at)} and has not finished. ${NOT_CHECKED_TAIL}`,
        { creditChainCheck: 'unfinished', startedAt: last.started_at })
    }
    const broken = last.broken_chains ?? []
    if (last.outcome === 'whole' || !broken.length) return { outcome: 'whole', title: null, lines: [], context: null }
    const mail = brokenChainsEmail(broken)
    return {
      outcome: 'broken', title: mail.title, lines: mail.body.split('\n'),
      context: brokenChainsContext({ subjects: last.subjects ?? 0, whole: last.whole ?? 0, broken }),
    }
  } catch (err) {
    logger.error({ err }, "[credit-chains] last night's check could not be read for the morning email")
    const why = err instanceof Error ? err.message : String(err)
    return notRun(`CREDIT CHAINS NOT CHECKED — last night's credit chain check could not be read: ${why}. ${NOT_CHECKED_TAIL}`,
      { creditChainCheck: 'unreadable', error: why })
  }
}
