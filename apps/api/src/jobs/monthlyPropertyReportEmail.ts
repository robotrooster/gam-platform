/**
 * 10/12 (Nic) — THE MONTHLY PROPERTY REPORT, EMAILED AT MONTH CLOSE.
 *
 *   "EMAILED at month close (1st or 2nd of the following month) WITH A PDF
 *    attachment so they can put it to their books" — to the recipients the
 *   OWNER picks (services/monthlyPropertyReport recipientsOf; default: the
 *   owner only).
 *
 * WHEN: the 2nd, from 8 am on the company's own clock (MONTHLY_REPORT_SEND_DAY
 * / _HOUR) — after the 1st's month-end runs (invoices, late fees, work-trade
 * month close, fee accruals) have settled the month. The company's clock is
 * the time zone most of its properties keep. The job runs hourly on the first
 * days of the month (Phoenix calendar, wide enough for every US zone) and
 * sends whatever is due and not sent; a server that was down on the 2nd makes
 * the month up through the 5th (MONTHLY_REPORT_LAST_CATCH_UP_DAY), never later
 * — a report for last month arriving mid-month is noise.
 *
 * ONCE PER ADDRESS PER MONTH: each send is claimed first
 * (monthly_report_sends, unique per company, month and address; INSERT ... ON
 * CONFLICT DO NOTHING) and only the run that claimed it sends. Two API
 * processes, a re-run, a catch-up run — one email. A send the mail service did
 * not accept is tried again on a later run, at most three tries, and only
 * where mail actually leaves this machine (production, or EMAIL_SEND_LIVE=1 —
 * services/email's own rule); a claim never confirmed ('sending', the process
 * stopped mid-send) is never sent again: one missing email is better than two.
 * 10/12 (Nic): it is never silent either — a send still 'sending' after
 * MONTHLY_REPORT_STUCK_AFTER_MINUTES raises an admin notice (noticeStuckSends),
 * once per send, so a person checks the mail log and sends it by hand if it
 * did not go.
 *
 * WHAT EACH ADDRESS GETS: the properties its recipient may see — a team
 * member's own scope, read fresh (a manager of one park never receives the
 * other park's money); every property for an address the owner typed in. One
 * PDF per distinct set of properties.
 */
import cron from 'node-cron'
import { DateTime } from 'luxon'
import {
  MONTHLY_REPORT_SEND_DAY, MONTHLY_REPORT_SEND_HOUR, MONTHLY_REPORT_LAST_CATCH_UP_DAY, FALLBACK_TIMEZONE,
} from '@gam/shared'
import { query, getClient } from '../db'
import { logger } from '../lib/logger'
import { monthWords } from '../services/incomeBasis'
import { portalLink } from '../lib/portalUrls'
import { emailMonthlyPropertyReport } from '../services/email'
import type { ReplyTo } from '../services/replyRouting'
import {
  buildMonthlyPropertyReport, recipientsOf, MONTHLY_REPORT_STUCK_AFTER_MINUTES, MONTHLY_REPORT_STUCK_CATEGORY,
  type MonthlyPropertyReport, type ReportRecipient,
} from '../services/monthlyPropertyReport'
import { renderMonthlyReportPdf, monthlyReportFilename } from '../services/monthlyReportPdf'

/** How many times a send the mail service refused is tried in all. */
export const MONTHLY_REPORT_MAX_ATTEMPTS = 3

/** Does mail leave this machine? services/email's own rule (production, or EMAIL_SEND_LIVE=1). */
function mailIsLive(): boolean {
  return (process.env.NODE_ENV || 'development') === 'production' || process.env.EMAIL_SEND_LIVE === '1'
}

/**
 * The month whose report is due at `now` on a company's clock, or null: from
 * 8 am on the 2nd through the 5th, last month.
 */
export function reportMonthDue(now: Date, timezone: string | null): string | null {
  const local = DateTime.fromJSDate(now).setZone(timezone || FALLBACK_TIMEZONE)
  const t = local.isValid ? local : DateTime.fromJSDate(now).setZone(FALLBACK_TIMEZONE)
  if (t.day < MONTHLY_REPORT_SEND_DAY || t.day > MONTHLY_REPORT_LAST_CATCH_UP_DAY) return null
  if (t.day === MONTHLY_REPORT_SEND_DAY && t.hour < MONTHLY_REPORT_SEND_HOUR) return null
  return t.minus({ months: 1 }).toFormat('yyyy-MM')
}

/**
 * Companies with properties (demo accounts never, GAM's own system companies
 * never), and the time zone most of their properties keep.
 *
 * 10/12 review: GAM's own company ("GAM Renter Pool", landlords.is_system)
 * owns a property and its owner is an internal address (@gam.internal) the
 * mail service refuses; sending there would bounce up to three times a month
 * and hurt the sending domain (the S536/S553/S605 warnings) — the same reason
 * jobs/platformFeeAccrual skips is_system companies.
 */
async function companies(only: readonly string[] | null) {
  return query<{ id: string; timezone: string | null }>(`
    SELECT l.id,
           (SELECT p.timezone FROM properties p WHERE p.landlord_id = l.id AND p.timezone IS NOT NULL
             GROUP BY p.timezone ORDER BY COUNT(*) DESC, p.timezone LIMIT 1) AS timezone
      FROM landlords l
     WHERE l.is_demo = FALSE
       AND l.is_system = FALSE
       AND EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id)
       AND ($1::uuid[] IS NULL OR l.id = ANY($1::uuid[]))
     ORDER BY l.id`, [only ? [...only] : null])
}

/** Take the send for this address and month, or a retry of one the mail service refused. Null: not ours to send. */
async function claim(landlordId: string, month: string, r: ReportRecipient): Promise<string | null> {
  const first = await query<{ id: string }>(`
    INSERT INTO monthly_report_sends (landlord_id, report_month, recipient_key, email, user_id, property_ids)
    VALUES ($1, $2::date, $3, $3, $4, $5::uuid[])
    ON CONFLICT (landlord_id, report_month, recipient_key) DO NOTHING
    RETURNING id`, [landlordId, `${month}-01`, r.email, r.userId, r.propertyIds ?? []])
  if (first[0]) return first[0].id
  if (!mailIsLive()) return null
  const retry = await query<{ id: string }>(`
    UPDATE monthly_report_sends SET status = 'sending', attempts = attempts + 1, updated_at = now(),
           property_ids = $4::uuid[]
     WHERE landlord_id = $1 AND report_month = $2::date AND recipient_key = $3
       AND status = 'not_sent' AND attempts < $5
    RETURNING id`, [landlordId, `${month}-01`, r.email, r.propertyIds ?? [], MONTHLY_REPORT_MAX_ATTEMPTS])
  return retry[0]?.id ?? null
}

export interface MonthlyReportRun { companies: number; due: number; sent: number; notSent: number; skipped: number; stuck: number }

/**
 * How long a claimed send may sit at 'sending' before it is called stuck —
 * one figure, with the owner's recipient list (services/monthlyPropertyReport,
 * which says "Not sent — stuck, GAM was alerted" from then on).
 */
export { MONTHLY_REPORT_STUCK_AFTER_MINUTES }
/**
 * admin_notifications.category of the stuck-send notice (one per send:
 * context.send_id). Defined beside the recipient list's label, which reads
 * whether the notice is on record (services/monthlyPropertyReport lastSends).
 */
export { MONTHLY_REPORT_STUCK_CATEGORY }

/**
 * 10/12 (Nic): a monthly-report email stuck at 'sending' — the process died
 * between taking the claim and hearing back from the mail service — raises an
 * admin notice instead of silently never sending. It is still never sent again
 * by itself: the mail service may have accepted it before the process died,
 * and one missing email is better than two. The notice names the company, the
 * month and the address, so a person checks the mail log and sends it by hand
 * if it did not go. One notice per send, ever (a send already noticed — in
 * admin_notifications or its archive — is passed over), whatever month it is
 * for. Returns how many it raised.
 *
 * 10/12 (Nic, review): ONE NOTICE PER SEND, EVEN WHEN TWO CALLERS RACE. Every
 * read of the owner's recipient list calls this too (routes/reports
 * recipientsReply), alongside the hourly job, and a check-then-insert let two
 * overlapping calls each raise the same notice. Each send is now raised under
 * its own transaction lock (pg_advisory_xact_lock on the send id): the second
 * caller waits, then finds the first one's notice and passes over it. The
 * notice is written on that same connection and an error is not swallowed
 * (createAdminNotification swallows its insert errors) — a notice that failed
 * to write is not counted, and the recipient list, which says "GAM was
 * alerted" only where the notice is on record, says "Not sent — stuck" until
 * a later call raises it.
 */
export async function noticeStuckSends(now: Date = new Date(), only: readonly string[] | null = null): Promise<number> {
  const stuck = await query<{
    id: string; landlord_id: string; month: string; email: string; attempts: number; claimed_at: string
    company: string | null; first_name: string | null; last_name: string | null
  }>(`
    SELECT s.id, s.landlord_id, to_char(s.report_month, 'YYYY-MM') AS month, s.email, s.attempts,
           s.updated_at AS claimed_at, NULLIF(btrim(l.business_name), '') AS company, u.first_name, u.last_name
      FROM monthly_report_sends s
      JOIN landlords l ON l.id = s.landlord_id
      LEFT JOIN users u ON u.id = l.user_id
     WHERE s.status = 'sending'
       AND s.updated_at < $1::timestamptz - make_interval(mins => $2::int)
       AND NOT EXISTS (SELECT 1 FROM admin_notifications n
                        WHERE n.category = $3 AND n.context->>'send_id' = s.id::text)
       AND NOT EXISTS (SELECT 1 FROM admin_notifications_archive n
                        WHERE n.category = $3 AND n.context->>'send_id' = s.id::text)
       AND ($4::uuid[] IS NULL OR s.landlord_id = ANY($4::uuid[]))
     ORDER BY s.updated_at, s.id`,
    [now.toISOString(), MONTHLY_REPORT_STUCK_AFTER_MINUTES, MONTHLY_REPORT_STUCK_CATEGORY, only ? [...only] : null])
  let raised = 0
  for (const r of stuck) {
    const company = r.company || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'A company'
    const when = monthWords(r.month)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`monthly_report_stuck:${r.id}`])
      // Read again under the lock: another caller may have raised it (or the
      // send may have finished) while this one waited.
      const still = await client.query(
        `SELECT 1 FROM monthly_report_sends s
          WHERE s.id = $1 AND s.status = 'sending'
            AND s.updated_at < $2::timestamptz - make_interval(mins => $3::int)
            AND NOT EXISTS (SELECT 1 FROM admin_notifications n
                             WHERE n.category = $4 AND n.context->>'send_id' = s.id::text)
            AND NOT EXISTS (SELECT 1 FROM admin_notifications_archive n
                             WHERE n.category = $4 AND n.context->>'send_id' = s.id::text)`,
        [r.id, now.toISOString(), MONTHLY_REPORT_STUCK_AFTER_MINUTES, MONTHLY_REPORT_STUCK_CATEGORY])
      if (still.rows.length) {
        await client.query(
          `INSERT INTO admin_notifications (severity, category, title, body, context) VALUES ('warn', $1, $2, $3, $4)`,
          [MONTHLY_REPORT_STUCK_CATEGORY,
           `${company}'s ${when} monthly report may not have been emailed`,
           `The monthly property report for ${when} to ${r.email} was started but never finished — the server stopped `
             + 'before the mail service answered. GAM will not send it again by itself, in case it did go out. Check the mail '
             + 'log for this address; if it is not there, send the report by hand.',
           JSON.stringify({
             send_id: r.id, landlord_id: r.landlord_id, report_month: r.month, email: r.email, attempts: r.attempts,
             claimed_at: new Date(r.claimed_at).toISOString(),
           })])
      }
      await client.query('COMMIT')
      if (still.rows.length) {
        raised++
        logger.error({ sendId: r.id, landlordId: r.landlord_id, month: r.month }, '[monthly-report] a send is stuck at sending')
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      // One send's notice failing never stops the others; the next call tries it again.
      logger.error({ err: e, sendId: r.id, landlordId: r.landlord_id }, '[monthly-report] could not raise the stuck-send notice')
    } finally {
      client.release()
    }
  }
  return raised
}

/**
 * Send one company's report for one month to every recipient not yet sent
 * it. Exported for the report page's tests and a hand re-run; the cron calls
 * runMonthlyPropertyReportEmails.
 */
export async function sendCompanyMonthlyReport(landlordId: string, month: string): Promise<Omit<MonthlyReportRun, 'companies' | 'due' | 'stuck'>> {
  const out = { sent: 0, notSent: 0, skipped: 0 }
  const { recipients } = await recipientsOf(landlordId)
  // 10/5 (Nic) reply routing: mail to an outside person about the company's
  // business answers to whoever runs it — an address the owner typed in (a
  // CPA, a partner) replies to the account owner, never to GAM support. A
  // team member's copy keeps GAM's default (they reach the owner in the portal).
  const owner = await query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  const ownerReply: ReplyTo | undefined = owner[0]?.user_id ? { kind: 'person', userId: owner[0].user_id } : undefined
  const reports = new Map<string, Promise<{ report: MonthlyPropertyReport; pdf: Buffer }>>()
  const reportFor = (ids: string[] | null) => {
    const key = ids === null ? '*' : [...ids].sort().join(',')
    let p = reports.get(key)
    if (!p) {
      p = buildMonthlyPropertyReport({ landlordId, month, propertyIds: ids })
        .then(async report => ({ report, pdf: await renderMonthlyReportPdf(report) }))
      reports.set(key, p)
    }
    return p
  }
  for (const r of recipients) {
    // A team member who keeps no property here has no report to receive.
    if (r.propertyIds && r.propertyIds.length === 0) { out.skipped++; continue }
    const sendId = await claim(landlordId, month, r)
    if (!sendId) { out.skipped++; continue }
    let messageId: string | null = null
    let error: string | null = null
    let covered: string[] = r.propertyIds ?? []
    try {
      const { report, pdf } = await reportFor(r.propertyIds)
      covered = report.properties.map(p => p.property.id)
      if (!report.properties.length) {
        // Nothing of theirs to report (every property left the company): no email, recorded as such.
        error = 'No properties to report on.'
      } else {
        messageId = await emailMonthlyPropertyReport({
          to: r.email,
          recipientName: r.name,
          companyName: report.company.name,
          monthLabel: report.monthLabel,
          rows: report.properties.map(p => ({
            name: p.property.name, charged: p.money.view.charged, received: p.money.view.received,
            owed: p.money.view.owed, lateHouseholds: p.payments.late.length,
          })),
          pdf,
          filename: monthlyReportFilename(report),
          // A link only for someone who signs in to the landlord portal.
          reportUrl: r.kind === 'team_member' && r.role !== 'bookkeeper'
            ? portalLink('landlord', `/reports?tab=monthly&month=${month}`) : null,
          landlordId,
          sendId,
          replyTo: r.kind === 'email' ? ownerReply : undefined,
        })
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      logger.error({ err: e, landlordId, month }, '[monthly-report] could not build or send')
    }
    await query(
      `UPDATE monthly_report_sends
          SET status = $2, provider_message_id = $3, last_error = $4, updated_at = now(),
              sent_at = CASE WHEN $2 = 'sent' THEN now() END, property_ids = $5::uuid[]
        WHERE id = $1`,
      [sendId, messageId ? 'sent' : 'not_sent', messageId, messageId ? null : (error ?? 'The mail service did not accept it.'), covered])
    if (messageId) out.sent++; else out.notSent++
  }
  return out
}

/** One pass: every company whose report is due on its own clock. `now` and `only` are for tests. */
export async function runMonthlyPropertyReportEmails(opts: { now?: Date; only?: readonly string[] } = {}): Promise<MonthlyReportRun> {
  const now = opts.now ?? new Date()
  const run: MonthlyReportRun = { companies: 0, due: 0, sent: 0, notSent: 0, skipped: 0, stuck: 0 }
  // 10/12 (Nic): a send a dead process left at 'sending' is never silent.
  try {
    run.stuck = await noticeStuckSends(now, opts.only ?? null)
  } catch (e) {
    logger.error({ err: e }, '[monthly-report] could not check for stuck sends')
  }
  for (const c of await companies(opts.only ?? null)) {
    run.companies++
    const month = reportMonthDue(now, c.timezone)
    if (!month) continue
    run.due++
    try {
      const r = await sendCompanyMonthlyReport(c.id, month)
      run.sent += r.sent; run.notSent += r.notSent; run.skipped += r.skipped
    } catch (e) {
      // One company's failure never stops the others; its unclaimed sends go on the next run.
      logger.error({ err: e, landlordId: c.id, month }, '[monthly-report] company failed')
    }
  }
  return run
}

/**
 * The scheduler's hook (jobs/scheduler.ts): hourly at :25 on the 1st through
 * the 6th by the Phoenix calendar, which covers the 2nd-5th on every US clock
 * — and the 7th, when nothing is due anywhere (reportMonthDue), so a send a
 * process left stuck in the 6th's last runs is noticed that day, not a month
 * later (noticeStuckSends).
 */
export function registerMonthlyPropertyReportEmail(): void {
  cron.schedule('25 * 1-7 * *', async () => {
    try {
      const r = await runMonthlyPropertyReportEmails()
      if (r.due > 0 || r.stuck > 0) logger.info(r, '[monthly-report]')
    } catch (e) {
      logger.error({ err: e }, '[monthly-report] fatal')
    }
  }, { timezone: 'America/Phoenix' })
}
