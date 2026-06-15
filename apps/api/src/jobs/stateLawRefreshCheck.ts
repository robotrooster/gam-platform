/**
 * S479 / state-law KB refresh discipline.
 *
 * Background: every state_law_provisions row carries a `source_date`
 * stamped from the day the official statute site was read. The KB's
 * accuracy depends on quarterly re-reads — legislatures pass changes
 * mid-year that take effect at year-start. There is NO automated
 * re-scraping path (the statute sites' formats are unstable; a human
 * runs the workflow per project_state_law_kb memory). This cron's
 * job is to *surface the operational burden* — an admin notification
 * when the catalog has rows whose source_date is older than the
 * threshold.
 *
 * Idempotency: if there's an unacknowledged `state_law_refresh_needed`
 * notification already on file, don't create another. The admin
 * acknowledges → next stale check fires → fresh notification. This
 * keeps the inbox from filling with weekly dupes while the refresh
 * burden hasn't been touched.
 *
 * Threshold: 90 days. Tighter than calendar-quarter (which would be
 * ~91 days) — gives the admin a clear "started > 1 quarter ago" gate.
 *
 * Pre-launch posture: state_law_provisions today is loaded from
 * migrations stamped 2026-06-09, so as of any run this year the
 * notification will be expected. Once a refresh happens, the rows
 * get NEW effective_year inserts (per the never-UPDATE rule); the
 * old rows stay but the cron pulls the LATEST per (state, topic) via
 * the engine's getLatestProvision-equivalent logic in SQL.
 */

import { query, queryOne } from '../db'
import { createAdminNotification } from '../services/adminNotifications'

const REFRESH_THRESHOLD_DAYS = 90

export interface StateLawRefreshResult {
  stale_provision_count: number
  stale_state_count:     number
  notification_created:  boolean
  // Set when notification_created=false because an unacknowledged
  // prior notification was found. Helps log-reading.
  suppressed_due_to_existing_unack: boolean
}

interface StaleRow {
  state_code:  string
  oldest_date: string
  count:       number
}

export async function processStateLawRefreshCheck(
  thresholdDays: number = REFRESH_THRESHOLD_DAYS,
): Promise<StateLawRefreshResult> {
  // Group stale LATEST provisions by state. The catalog stores
  // historical (effective_year) rows so the LATEST per (state, topic)
  // is what's actually consulted by the engine. A state where every
  // topic has a recent re-read passes; a state with even one stale
  // latest provision counts.
  const stale = await query<StaleRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (state_code, topic)
              state_code, topic, source_date
         FROM state_law_provisions
        ORDER BY state_code, topic, effective_year DESC, source_date DESC
     )
     SELECT state_code,
            MIN(source_date)::text AS oldest_date,
            COUNT(*)::int AS count
       FROM latest
      WHERE source_date < CURRENT_DATE - ($1::int || ' days')::interval
      GROUP BY state_code
      ORDER BY MIN(source_date) ASC`,
    [thresholdDays],
  )

  const staleProvisionCount = stale.reduce((acc, s) => acc + s.count, 0)
  const staleStateCount     = stale.length

  if (staleProvisionCount === 0) {
    return {
      stale_provision_count: 0,
      stale_state_count: 0,
      notification_created: false,
      suppressed_due_to_existing_unack: false,
    }
  }

  // Idempotency: skip when an unacknowledged refresh-needed
  // notification already exists. Admin acks → next run creates.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM admin_notifications
      WHERE category = 'state_law_refresh_needed'
        AND acknowledged_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
  )

  if (existing) {
    return {
      stale_provision_count: staleProvisionCount,
      stale_state_count:     staleStateCount,
      notification_created:  false,
      suppressed_due_to_existing_unack: true,
    }
  }

  const oldestSummary = stale
    .slice(0, 10)  // cap the inline list — fully list lives in context
    .map(s => `${s.state_code} (${s.count} provision${s.count === 1 ? '' : 's'}, oldest ${s.oldest_date})`)
    .join(', ')

  await createAdminNotification({
    severity: 'warn',
    category: 'state_law_refresh_needed',
    title:    `State-law KB refresh needed — ${staleProvisionCount} provision(s) across ${staleStateCount} state(s)`,
    body:
      `${staleProvisionCount} provision(s) across ${staleStateCount} state(s) ` +
      `have source_date older than ${thresholdDays} days. The catalog powers ` +
      `hedged factual warnings on lease and entry-request write paths; stale ` +
      `figures risk surfacing outdated statute values.\n\n` +
      `Top stale states: ${oldestSummary}${stale.length > 10 ? `, +${stale.length - 10} more` : ''}.\n\n` +
      `Refresh process: see project_state_law_kb memory — re-run the ` +
      `state-law-research-batch workflow per state, generate a seed ` +
      `migration via genStateLawSeed.ts, apply via npm run db:migrate. ` +
      `Never UPDATE existing rows; INSERT new effective_year rows so the ` +
      `dated history is preserved.`,
    context: {
      threshold_days: thresholdDays,
      stale_provision_count: staleProvisionCount,
      stale_state_count: staleStateCount,
      states: stale,
    },
  })

  return {
    stale_provision_count: staleProvisionCount,
    stale_state_count:     staleStateCount,
    notification_created:  true,
    suppressed_due_to_existing_unack: false,
  }
}
