/**
 * S640 — the one place a provider's verdict lands on a check.
 *
 * This was the body of the webhook route. It is lifted out so the poller
 * (services/backgroundCheckSync.ts) applies a status change exactly the way a
 * webhook does — same summary fetch, same archive rows, same pool handoff.
 * Two code paths that advance the same row in almost the same way is how they
 * quietly stop matching.
 */
import type { BackgroundProvider, BackgroundProviderWebhookUpdate } from './backgroundProvider'
import { query, queryOne } from '../db'
import { archiveProviderPayload } from './backgroundReportArchive'
import { isPoolIntakeLandlord } from './poolIntake'
import { logger } from '../lib/logger'

export async function applyProviderUpdate(args: {
  provider: BackgroundProvider
  check: any
  update: BackgroundProviderWebhookUpdate
  /** 'webhook' when they told us, 'poll' when we asked. */
  source: 'webhook' | 'poll'
  /** The raw webhook body, archived verbatim. Absent on a poll — nobody sent one. */
  rawWebhookBody?: unknown
  eventType?: string | null
}): Promise<void> {
  const { provider, check, update, source } = args

  // Providers whose events carry only a report pointer (Checkr Tenant) get the
  // real per-product results pulled here, before the row update, so status and
  // summary land together. A failed fetch still applies the status — the
  // summary is backfilled on the next event or the next poll.
  // S640: skip when the caller already has it — the webhook route fetches the
  // report to resolve the order id, and pulling it twice costs an API call and
  // risks two different answers landing on one row.
  if (update.reportRef && provider.fetchReport && !update.reportSummary) {
    try {
      update.reportSummary = (await provider.fetchReport(update.reportRef)) ?? update.reportSummary ?? null
    } catch (e) {
      logger.error({ err: e, report_ref: update.reportRef }, '[bgc] report fetch failed')
    }
  }

  const expiresClause = update.status === 'complete'
    ? ", expires_at = NOW() + INTERVAL '6 months'"
    : ''
  // COALESCE keeps an existing summary when this event carries none — Checkr
  // Tenant sends summary-less progress events (applicant.visited,
  // product.completed) that must not null a previously stored report.
  await query(`
    UPDATE background_checks
    SET status=$1, report_summary=COALESCE($2::jsonb, report_summary),
        failure_reason=$3, webhook_received_at=NOW()${expiresClause}
    WHERE id=$4`,
    [update.status, update.reportSummary ? JSON.stringify(update.reportSummary) : null,
     update.failureReason || null, check.id])

  // Two payloads worth keeping, answering different questions: the raw REPORT
  // is what the provider found, the raw WEBHOOK is what they told us and when.
  // Append-only; neither can fail the screening.
  const rawReport = (provider as any).rawReport
  if (rawReport) {
    await archiveProviderPayload({
      backgroundCheckId: check.id, landlordId: check.landlord_id,
      provider: provider.name, reportRef: update.reportRef ?? null,
      // 'fetch' either way, which is the truth: the report was pulled from the
      // provider's API. What differs is what prompted it, and that is the
      // webhook row's presence or absence beside it.
      source: 'fetch', payload: rawReport,
    })
  }
  if (args.rawWebhookBody) {
    await archiveProviderPayload({
      backgroundCheckId: check.id, landlordId: check.landlord_id,
      provider: provider.name, reportRef: update.reportRef ?? null,
      source: 'webhook', eventType: args.eventType ?? null,
      payload: args.rawWebhookBody,
    })
  }

  // Speculative path: complete → pool (if eligible). No landlord decision step.
  if (update.status === 'complete' && (!check.landlord_id || await isPoolIntakeLandlord(check.landlord_id))) {
    const fresh = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1', [check.id])
    if (fresh) {
      const { isPoolEligible, upsertPoolEntry } = await import('./applicationPool')
      if (isPoolEligible(fresh)) {
        try { await upsertPoolEntry(fresh) } catch (e) { logger.error({ err: e }, '[POOL CREATE]') }
      }
    }
  }
}
