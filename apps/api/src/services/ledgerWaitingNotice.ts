/**
 * 11/1 (Nic) — TELL SOMEBODY A POSTING IS WAITING ON AN ANSWER.
 *
 * Country Acres had money on GAM from September and no books start date. Sixty-
 * seven postings parked behind it, roughly 1,795 retries each, for two months —
 * and nothing ever said so. Three separate silences stacked up:
 *
 *   1. `recordSourceError` skips its admin notice for the waiting-on-owner
 *      reasons by design (ledgerEngine LEDGER_WAITING_ON_OWNER_REASONS — "no
 *      admin notice for them", because they are not broken).
 *   2. `noticeStaleOutbox` excludes a company whose books start is NULL.
 *   3. `runLedgerParity` only selects companies WHERE books_start_date IS NOT
 *      NULL, so such a company is not even checked.
 *
 * Each is defensible alone: a question nobody has answered is not an error.
 * Together they mean a company can be invisible in every direction. Nic, on
 * finding it: "Nothing has ever told anyone ... That's worth closing regardless
 * of who picks the date."
 *
 * WHAT THIS IS NOT. It does not post anything, repair anything, or answer
 * anything on an owner's behalf. It says which question is unanswered, for
 * which company, how much is waiting and since when.
 *
 * ONE NOTICE PER COMPANY PER QUESTION — not per parked row (that would have
 * been 67 for Country Acres), and not every night forever (that is an email
 * faucet nobody reads, which is how the real alarms get ignored). The existing
 * `noticed_at` column is the guard; a question still unanswered is raised again
 * once a RENOTICE_DAYS have passed, so it stays visible without nagging.
 *
 * Grouping is by `ledger_source_errors.waiting_on`, not by the reason code or
 * the message: the reason code is two values covering six questions, and three
 * of the messages interpolate a landlord's own loan name or a books start date,
 * so grouping by text would split one question into a row per loan.
 */
import {
  LEDGER_WAITING_NOT_ACTIONABLE, LEDGER_WAITING_ON_LABEL, LEDGER_WAITING_ON_PAGE,
  type LedgerWaitingOnCause,
} from '@gam/shared'
import { ledgerQuery } from '../db/ledgerPool'
import { query } from '../db'
import { logger } from '../lib/logger'
import { createAdminNotification } from './adminNotifications'

/** A question still unanswered is raised again this many days after the last notice. */
export const RENOTICE_DAYS = 7

interface WaitingGroup {
  owner_id: string
  waiting_on: LedgerWaitingOnCause
  n: string
  oldest: string
  attempts: string
  last_noticed: string | null
}

export interface WaitingNoticeResult {
  groups: number
  raised: number
}

/**
 * Raise a notice for every company/question pair nobody has been told about,
 * or told about longer than RENOTICE_DAYS ago. Never throws: a notice failing
 * must not stop the nightly books work it runs beside.
 */
export async function noticeWaitingOnOwner(opts: { renoticeDays?: number } = {}): Promise<WaitingNoticeResult> {
  const renotice = opts.renoticeDays ?? RENOTICE_DAYS
  const out: WaitingNoticeResult = { groups: 0, raised: 0 }
  try {
    const groups = await ledgerQuery<WaitingGroup>(
      `SELECT e.owner_id,
              e.waiting_on,
              count(*)::text                 AS n,
              min(e.first_failed_at)::text   AS oldest,
              max(e.attempts)::text          AS attempts,
              max(e.noticed_at)::text        AS last_noticed
         FROM ledger_source_errors e
        WHERE e.owner_id IS NOT NULL
          AND e.waiting_on IS NOT NULL
          AND NOT (e.waiting_on = ANY($1::text[]))
        GROUP BY e.owner_id, e.waiting_on
        -- Told nobody yet, or told long enough ago that it is worth saying
        -- again. HAVING, because both are aggregates over the group.
       HAVING max(e.noticed_at) IS NULL
           OR max(e.noticed_at) < now() - make_interval(days => $2)
        ORDER BY e.owner_id, e.waiting_on`,
      [LEDGER_WAITING_NOT_ACTIONABLE as readonly string[], renotice])
    out.groups = groups.length
    if (groups.length === 0) return out

    // The company's own name, from the API's pool — admin_notifications lives
    // there and so does `landlords`.
    const names = new Map<string, string>()
    for (const r of await query<{ id: string; business_name: string | null }>(
      `SELECT id, business_name FROM landlords WHERE id = ANY($1::uuid[])`,
      [groups.map(g => g.owner_id)])) {
      names.set(r.id, r.business_name ?? 'A company')
    }

    for (const g of groups) {
      const cause = g.waiting_on
      const company = names.get(g.owner_id) ?? 'A company'
      const n = Number(g.n)
      const label = LEDGER_WAITING_ON_LABEL[cause] ?? cause
      const page = LEDGER_WAITING_ON_PAGE[cause] ?? 'Books settings'
      const since = (g.oldest ?? '').slice(0, 10)
      const again = g.last_noticed != null
      await createAdminNotification({
        severity: 'warn',
        category: 'books_waiting_on_owner',
        // The title names the QUESTION. The parity notice next to it names only
        // dollar amounts and no cause, which is what made this hard to read.
        title: `${company}: the books are waiting on ${label}`,
        body: `${n} money record${n === 1 ? '' : 's'} cannot post until this is answered`
            + `${since ? `, the oldest waiting since ${since}` : ''}. `
            + `Nothing is lost — they retry every 15 minutes and post themselves the moment it is `
            + `answered on the ${page} page. `
            + `${again ? `Still unanswered since the last notice ${renotice}+ days ago.` : ''}`,
        context: {
          landlordId: g.owner_id, company, waitingOn: cause, blocked: n,
          oldest: g.oldest, attempts: Number(g.attempts), renotice: again,
        },
      })
      // Stamp the whole group, so the next run says nothing until it is either
      // answered or RENOTICE_DAYS stale. Stamped AFTER the notice: if the notice
      // throws, the group stays unstamped and is tried again, rather than being
      // marked told when nobody was.
      await ledgerQuery(
        `UPDATE ledger_source_errors
            SET noticed_at = now()
          WHERE owner_id = $1 AND waiting_on = $2`, [g.owner_id, cause])
      out.raised++
    }
    logger.warn(out, '[ledger-waiting] companies waiting on an answer')
    return out
  } catch (e) {
    logger.error({ err: e }, '[ledger-waiting] could not raise the waiting-on-owner notices')
    return out
  }
}
