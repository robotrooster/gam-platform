import type { PoolClient } from 'pg'
import { db } from '../db'
import { humanize } from '@gam/shared'
import { dateIn } from '../lib/timezone'
import { logger } from '../lib/logger'
import { verifyAllChains, CHAIN_BREAK_LABEL, type ChainBreak } from './creditLedger'
import { createAdminNotification, type CreateAdminNotificationOpts } from './adminNotifications'

// ============================================================
// The nightly credit chain check (10/13, Nic: "ADD the nightly chain check
// (break flagged in the morning admin email)").
//
// Every credit record's chain is verified each night (verifyAllChains, in the
// 03:00 credit nightly, after tonight's marks are written). A chain whole —
// never restarted, or whole since a restart that explains its old break — is
// not news. Any chain broken is listed in ONE admin email to the super admins
// (one email per thing): whose record it is (the tenant's name; a company's
// record by its company name), and the first bad entry (what it is, its day,
// its id) with the break in plain words. When every chain is whole, nothing is
// sent. A broken chain is flagged every night it stays broken: nothing here
// repairs one (a restart is a decision, 10/13), so it keeps showing until it
// is dealt with.
//
// 10/13 (review): a quiet morning has to mean every chain is whole. A night
// the check could not finish sends its own admin email ("did not run"), and
// "sent" is read back from admin_notifications, never assumed: the
// notification helper swallows a failed write (it only logs it), so a flag
// that is not on record is counted as an error in the nightly's log line.
// ============================================================

type Q = Pick<PoolClient, 'query'>

/** The admin notification category for broken chains (one email a night, any number of chains). */
export const CHAIN_BROKEN_CATEGORY = 'credit_chain_broken'
/** The admin notification category for a night the check could not finish. */
export const CHAIN_CHECK_FAILED_CATEGORY = 'credit_chain_check_failed'

/** One broken chain, as the admin email names it. */
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

/** The admin email for broken chains: its title and one line per chain. */
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
 * The email's context block, one entry per broken chain. 10/13 (review): the
 * admin email prints its body as one paragraph (the line breaks between the
 * chains do not show), and the context under it line by line, so each chain is
 * repeated there in words — whose record, the first bad entry, the break — with
 * its ids and verifyChain's reason, word for word, for whoever repairs it.
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
 * Raise an admin notification and say whether it is ON RECORD (10/13, review).
 * createAdminNotification never throws — a failed write is only logged — so
 * the row is looked for: one of this category written since just before the
 * call. Its email to the super admins goes out with the row (the helper logs
 * any address it could not reach). Never throws.
 */
async function raiseNotice(opts: CreateAdminNotificationOpts): Promise<boolean> {
  try {
    const { rows: [{ since }] } = await db.query<{ since: string }>(`SELECT now()::text AS since`)
    await createAdminNotification(opts)
    const { rows } = await db.query(
      `SELECT 1 FROM admin_notifications WHERE category = $1 AND created_at >= $2::timestamptz LIMIT 1`,
      [opts.category, since])
    return rows.length > 0
  } catch (err) {
    logger.error({ err, category: opts.category }, '[credit-chains] the admin notice could not be raised')
    return false
  }
}

/**
 * The nightly flag: chains checked, whole and broken. `sent`: tonight's admin
 * email (broken chains, or the check not running) is on record. `errors`: the
 * check did not finish, or its broken-chain email is not on record.
 */
export interface ChainFlagResult {
  subjects: number
  whole: number
  broken: number
  sent: boolean
  errors: number
}

/**
 * 10/13 (review): the admin email for a night the check could not finish.
 * Without it, a morning with no broken-chain email would read as "every chain
 * whole" when no chain was checked. Returns whether it is on record; never throws.
 */
export async function flagChainCheckFailed(err: unknown): Promise<boolean> {
  const why = err instanceof Error ? err.message : String(err)
  return raiseNotice({
    severity: 'warn',
    category: CHAIN_CHECK_FAILED_CATEGORY,
    emailSuperAdmins: true,
    title: 'The credit chain check did not run tonight',
    body: `Tonight's check of every credit history chain stopped before it finished: ${why}. No chain was checked, `
      + 'so a morning without a broken-chain email does not mean every chain is whole. The check runs again tomorrow night.',
    context: { error: why },
  })
}

/**
 * The nightly check and its email: checks every chain, and when any is broken
 * sends one admin email (super admins) naming each. Nothing when all are whole.
 * A check that cannot finish sends the "did not run" email instead. Never throws.
 */
export async function flagBrokenCreditChains(q: Q = db): Promise<ChainFlagResult> {
  let r: ChainCheckResult
  try {
    r = await checkCreditChains(q)
  } catch (err) {
    // Checked again tomorrow night; tonight the admins hear it did not run.
    logger.error({ err }, '[credit-chains] the check did not finish')
    return { subjects: 0, whole: 0, broken: 0, sent: await flagChainCheckFailed(err), errors: 1 }
  }
  const out: ChainFlagResult = { subjects: r.subjects, whole: r.whole, broken: r.broken.length, sent: false, errors: 0 }
  if (!r.broken.length) return out
  const mail = brokenChainsEmail(r.broken)
  const sent = await raiseNotice({
    severity: 'critical',
    category: CHAIN_BROKEN_CATEGORY,
    emailSuperAdmins: true,
    title: mail.title,
    body: mail.body,
    context: brokenChainsContext(r),
  })
  // Not on record: nobody was told tonight. The chains are still broken
  // tomorrow night, so the next run flags them again.
  if (!sent) logger.error({ broken: r.broken.length }, '[credit-chains] the broken-chain email is not on record')
  return { ...out, sent, errors: sent ? 0 : 1 }
}
