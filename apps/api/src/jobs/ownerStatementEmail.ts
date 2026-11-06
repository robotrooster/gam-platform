/**
 * PM readiness 4 — THE OWNER STATEMENT, EMAILED EARLY EACH MONTH.
 *
 * services/ownerStatement has computed a complete statement since S644 and
 * /pm/my-statements has served it since S645. Nothing ever SENT one. An owner
 * whose park a manager runs on GAM received nothing at all: the statement was
 * computed when somebody asked for it and evaporated when they closed the tab,
 * and an owner is the one person on this platform who does not log in.
 *
 * WHAT GOES OUT: one email per owner entity per manager per month, with the
 * statement as a PDF (services/ownerStatementPdf). Its own email, never a
 * section added to the monthly property report (memory
 * gam-one-email-per-thing): a different document, a different audience, and a
 * reply that has to reach the MANAGER rather than GAM.
 *
 * WHEN: the 3rd, from 8 am on the manager's own clock for that owner's
 * properties (the zone most of them keep) — a day after the monthly property
 * report, so a person who is both a landlord here and an owner elsewhere is
 * not handed two money emails in one morning, and well after the 1st's
 * month-end runs (invoices, late fees, the flat and per-unit manager fees in
 * jobs/monthlyFeeAccrual, which the statement reads) have closed the month.
 * The job runs hourly on the first days of the month (Phoenix calendar, wide
 * enough for every US zone) and sends whatever is due and not sent; a server
 * that was down on the 3rd makes the month up through the 6th, never later — a
 * statement for last month arriving mid-month is noise.
 *
 * ONCE PER OWNER, MANAGER AND MONTH: each send is claimed first
 * (owner_statement_sends, unique per owner entity, manager, month and address;
 * INSERT ... ON CONFLICT DO NOTHING) and only the run that claimed it builds
 * or sends anything. Two API processes, a re-run by hand, a catch-up run — one
 * email. A send the mail service did not accept is tried again on a later run,
 * at most three tries, and only where mail actually leaves this machine
 * (production, or EMAIL_SEND_LIVE=1 — services/email's own rule); a claim
 * never confirmed ('sending', the process stopped mid-send) is never sent
 * again, because the mail service may have accepted it before the process
 * died and one missing statement is better than two. It is not silent either:
 * a claim still 'sending' after OWNER_STATEMENT_STUCK_AFTER_MINUTES raises an
 * admin notice, once per send, so a person checks the mail log.
 *
 * AN OWNER WITH NOTHING TO REPORT ON gets no email: no properties under that
 * manager means there is no statement, and a page of zeros would read as
 * though the manager collected nothing. The claim is still written, marked
 * not sent with that reason, so nobody wonders where it went. An owner WITH
 * properties and a quiet month does get one — "$0 collected" is the answer to
 * a question they would otherwise have to ask.
 */
import cron from 'node-cron'
import { DateTime } from 'luxon'
import { FALLBACK_TIMEZONE } from '@gam/shared'
import { query } from '../db'
import { logger } from '../lib/logger'
import { monthWords } from '../services/incomeBasis'
import { createAdminNotification } from '../services/adminNotifications'
import { emailOwnerStatement } from '../services/email'
import type { ReplyTo } from '../services/replyRouting'
import { ownerStatement } from '../services/ownerStatement'
import { renderOwnerStatementPdf, ownerStatementFilename } from '../services/ownerStatementPdf'
import { ownerStatementsDue, type OwnerStatementDue } from '../services/ownerStatementDelivery'

/** The day of the month the statement goes out, and the earliest local hour. */
export const OWNER_STATEMENT_SEND_DAY = 3
export const OWNER_STATEMENT_SEND_HOUR = 8
/** The last day a missed send is still made up (the server was down on the 3rd). */
export const OWNER_STATEMENT_LAST_CATCH_UP_DAY = 6
/** How many times a send the mail service refused is tried in all. */
export const OWNER_STATEMENT_MAX_ATTEMPTS = 3
/** How long a claimed send may sit at 'sending' before it is called stuck. */
export const OWNER_STATEMENT_STUCK_AFTER_MINUTES = 90
/** admin_notifications.category of the stuck-send notice (one per send: context.send_id). */
export const OWNER_STATEMENT_STUCK_CATEGORY = 'owner_statement_send_stuck'

/** Does mail leave this machine? services/email's own rule (production, or EMAIL_SEND_LIVE=1). */
function mailIsLive(): boolean {
  return (process.env.NODE_ENV || 'development') === 'production' || process.env.EMAIL_SEND_LIVE === '1'
}

/**
 * The month whose statement is due at `now` on a manager's clock, or null:
 * from 8 am on the 3rd through the 6th, last month.
 */
export function statementMonthDue(now: Date, timezone: string | null): string | null {
  const local = DateTime.fromJSDate(now).setZone(timezone || FALLBACK_TIMEZONE)
  const t = local.isValid ? local : DateTime.fromJSDate(now).setZone(FALLBACK_TIMEZONE)
  if (t.day < OWNER_STATEMENT_SEND_DAY || t.day > OWNER_STATEMENT_LAST_CATCH_UP_DAY) return null
  if (t.day === OWNER_STATEMENT_SEND_DAY && t.hour < OWNER_STATEMENT_SEND_HOUR) return null
  return t.minus({ months: 1 }).toFormat('yyyy-MM')
}

/**
 * Take the send for this statement and address, or a retry of one the mail
 * service refused. Null: not ours to send.
 */
async function claim(d: OwnerStatementDue, month: string): Promise<string | null> {
  const key = (d.email || '').trim().toLowerCase()
  const first = await query<{ id: string }>(`
    INSERT INTO owner_statement_sends
      (landlord_id, pm_company_id, period_month, recipient_key, email, user_id)
    VALUES ($1, $2, $3::date, $4, $5, $6)
    ON CONFLICT (landlord_id, pm_company_id, period_month, recipient_key) DO NOTHING
    RETURNING id`,
    [d.landlordId, d.pmCompanyId, `${month}-01`, key, d.email, d.ownerUserId])
  if (first[0]) return first[0].id
  if (!mailIsLive()) return null
  const retry = await query<{ id: string }>(`
    UPDATE owner_statement_sends
       SET status = 'sending', attempts = attempts + 1, updated_at = now()
     WHERE landlord_id = $1 AND pm_company_id = $2 AND period_month = $3::date AND recipient_key = $4
       AND status = 'not_sent' AND attempts < $5
    RETURNING id`,
    [d.landlordId, d.pmCompanyId, `${month}-01`, key, OWNER_STATEMENT_MAX_ATTEMPTS])
  return retry[0]?.id ?? null
}

export interface OwnerStatementRun {
  /** Owner-and-manager pairs considered. */
  statements: number
  /** Of those, due on their own clock. */
  due: number
  sent: number
  notSent: number
  skipped: number
  stuck: number
}

/**
 * A send a dead process left at 'sending' raises an admin notice rather than
 * going silently missing. It is still never sent again by itself: the mail
 * service may have accepted it before the process died. One notice per send,
 * ever — a send already noticed (in admin_notifications or its archive) is
 * passed over. Only this job calls it, so reading then writing is safe.
 */
export async function noticeStuckOwnerStatements(
  now: Date = new Date(), only: readonly string[] | null = null,
): Promise<number> {
  const stuck = await query<{
    id: string; landlord_id: string; month: string; email: string; attempts: number
    claimed_at: string; entity: string | null; pm_name: string
  }>(`
    SELECT s.id, s.landlord_id, to_char(s.period_month, 'YYYY-MM') AS month, s.email, s.attempts,
           s.updated_at AS claimed_at, NULLIF(btrim(l.business_name), '') AS entity, c.name AS pm_name
      FROM owner_statement_sends s
      JOIN landlords l    ON l.id = s.landlord_id
      JOIN pm_companies c ON c.id = s.pm_company_id
     WHERE s.status = 'sending'
       AND s.updated_at < $1::timestamptz - make_interval(mins => $2::int)
       AND NOT EXISTS (SELECT 1 FROM admin_notifications n
                        WHERE n.category = $3 AND n.context->>'send_id' = s.id::text)
       AND NOT EXISTS (SELECT 1 FROM admin_notifications_archive n
                        WHERE n.category = $3 AND n.context->>'send_id' = s.id::text)
       AND ($4::uuid[] IS NULL OR s.landlord_id = ANY($4::uuid[]))
     ORDER BY s.updated_at, s.id`,
    [now.toISOString(), OWNER_STATEMENT_STUCK_AFTER_MINUTES, OWNER_STATEMENT_STUCK_CATEGORY,
     only ? [...only] : null])
  let raised = 0
  for (const r of stuck) {
    const who = r.entity || 'An owner'
    const when = monthWords(r.month)
    await createAdminNotification({
      severity: 'warn',
      category: OWNER_STATEMENT_STUCK_CATEGORY,
      title: `${who}'s ${when} owner statement may not have been emailed`,
      body: `The ${when} owner statement from ${r.pm_name} to ${r.email} was started but never finished — the `
        + 'server stopped before the mail service answered. GAM will not send it again by itself, in case it did '
        + 'go out. Check the mail log for this address; if it is not there, send the statement by hand.',
      context: {
        send_id: r.id, landlord_id: r.landlord_id, period_month: r.month, email: r.email,
        attempts: r.attempts, claimed_at: new Date(r.claimed_at).toISOString(),
      },
    })
    raised++
    logger.error({ sendId: r.id, landlordId: r.landlord_id, month: r.month },
      '[owner-statement] a send is stuck at sending')
  }
  return raised
}

/**
 * Send one owner's statement for one month from one manager, if it has not
 * gone. Exported for a re-run by hand and for the tests; the cron calls
 * runOwnerStatementEmails.
 */
export async function sendOwnerStatement(
  d: OwnerStatementDue, month: string,
): Promise<{ sent: number; notSent: number; skipped: number }> {
  const sendId = await claim(d, month)
  if (!sendId) return { sent: 0, notSent: 0, skipped: 1 }

  let messageId: string | null = null
  let error: string | null = null
  let covered: string[] = []
  try {
    const statement = await ownerStatement({
      landlordId: d.landlordId, periodMonth: month, pmCompanyId: d.pmCompanyId,
    })
    covered = statement.properties.map(p => p.propertyId)
    if (!statement.properties.length) {
      // Nothing of theirs under this manager: no statement to send, recorded
      // as such. A page of zeros would read as a manager who collected nothing.
      error = `No properties under ${d.pmCompanyName} for this month.`
    } else {
      const meta = {
        entityName: d.entityName,
        ownerName: d.ownerName,
        pmCompanyName: d.pmCompanyName,
        monthLabel: monthWords(month),
        generatedAt: new Date().toISOString(),
      }
      const pdf = await renderOwnerStatementPdf(statement, meta)
      const T = statement.totals
      messageId = await emailOwnerStatement({
        to: d.email,
        recipientName: d.ownerName,
        entityName: d.entityName,
        pmCompanyName: d.pmCompanyName,
        monthLabel: meta.monthLabel,
        totals: {
          collected: T.grossCollected, ownerShare: T.ownerShare,
          managementFee: T.managementFee, expenses: T.expenses, net: T.net,
        },
        rows: statement.properties.map(p => ({
          name: p.propertyName, collected: p.grossCollected, ownerShare: p.ownerShare,
          managementFee: p.managementFee, expenses: p.expenses, net: p.net,
        })),
        pdf,
        filename: ownerStatementFilename(meta, month),
        // No link: nothing in any portal renders /pm/my-statements yet, and a
        // button to a page that does not exist is worse than no button. One
        // line to turn on when the owner's statements page ships.
        statementUrl: null,
        landlordId: d.landlordId,
        sendId,
        // A reply reaches the manager, not GAM: they are the one who can
        // answer anything on it (services/replyRouting). No owner-role staff
        // on the company falls back to GAM support.
        replyTo: d.replyToUserId ? ({ kind: 'person', userId: d.replyToUserId } as ReplyTo) : undefined,
      })
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    logger.error({ err: e, landlordId: d.landlordId, pmCompanyId: d.pmCompanyId, month },
      '[owner-statement] could not build or send')
  }
  await query(`
    UPDATE owner_statement_sends
       SET status = $2, provider_message_id = $3, last_error = $4, updated_at = now(),
           sent_at = CASE WHEN $2 = 'sent' THEN now() END, property_ids = $5::uuid[]
     WHERE id = $1`,
    [sendId, messageId ? 'sent' : 'not_sent', messageId,
     messageId ? null : (error ?? 'The mail service did not accept it.'), covered])
  return messageId ? { sent: 1, notSent: 0, skipped: 0 } : { sent: 0, notSent: 1, skipped: 0 }
}

/** One pass: every owner statement due on its manager's own clock. `now` and `only` are for tests. */
export async function runOwnerStatementEmails(
  opts: { now?: Date; only?: readonly string[] } = {},
): Promise<OwnerStatementRun> {
  const now = opts.now ?? new Date()
  const run: OwnerStatementRun = { statements: 0, due: 0, sent: 0, notSent: 0, skipped: 0, stuck: 0 }
  try {
    run.stuck = await noticeStuckOwnerStatements(now, opts.only ?? null)
  } catch (e) {
    logger.error({ err: e }, '[owner-statement] could not check for stuck sends')
  }
  for (const d of await ownerStatementsDue(opts.only ?? null)) {
    run.statements++
    const month = statementMonthDue(now, d.timezone)
    if (!month) continue
    run.due++
    try {
      const r = await sendOwnerStatement(d, month)
      run.sent += r.sent; run.notSent += r.notSent; run.skipped += r.skipped
    } catch (e) {
      // One owner's failure never stops the others; an unclaimed send goes on the next run.
      logger.error({ err: e, landlordId: d.landlordId, pmCompanyId: d.pmCompanyId, month },
        '[owner-statement] statement failed')
    }
  }
  return run
}

/**
 * The scheduler's hook (jobs/scheduler.ts): hourly at :45 on the 1st through
 * the 8th by the Phoenix calendar, which covers the 3rd-6th on every US clock
 * — and the 8th, when nothing is due anywhere any more (statementMonthDue), so
 * a send a process left stuck in the 6th's last runs is noticed that day
 * rather than a month later.
 *
 * The 8th, not the 7th, because Hawaii runs two hours behind Phoenix: the
 * 7th's first Phoenix runs are still the 6th in Honolulu, which is inside the
 * catch-up window, so the 7th is a sending day there and not a quiet one.
 * (The monthly property report stops at the 7th for the same arithmetic, one
 * day earlier — its catch-up window ends on the 5th.)
 *
 * :45 keeps it off the :25 slot the monthly property report runs in, so the
 * two never render PDFs for the same company at once.
 */
export function registerOwnerStatementEmail(): void {
  cron.schedule('45 * 1-8 * *', async () => {
    try {
      const r = await runOwnerStatementEmails()
      if (r.due > 0 || r.stuck > 0) logger.info(r, '[owner-statement]')
    } catch (e) {
      logger.error({ err: e }, '[owner-statement] fatal')
    }
  }, { timezone: 'America/Phoenix' })
}
