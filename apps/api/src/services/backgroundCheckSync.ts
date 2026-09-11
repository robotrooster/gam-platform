/**
 * S640 — ask the screener where a check stands, instead of waiting to be told.
 *
 * Nic: "We do really need to fix whatever you were talking about with the
 * background check. I have sent the link to a couple more people through text
 * message today."
 *
 * Checkr finished Anastacio Erreguin's report at 15:19 Phoenix on September 9.
 * GAM never heard: no webhook has ever reached /api/background/webhook in the
 * whole log window. His screening sat at `processing` for twenty-two hours
 * until Nic opened it and decided it by hand — on a report he could not see,
 * because the summary had not been pulled either.
 *
 * Why this rather than fixing the webhook: the webhook should be fixed too, and
 * only Nic can see whether one is registered in the Checkr dashboard. But a
 * $44.99 report that gates somebody's tenancy must not depend on a single HTTP
 * request arriving. A webhook is an optimisation — it makes the answer arrive
 * in seconds instead of minutes. This is what makes the answer arrive at all.
 *
 * Deliberately narrow: it advances a check the provider says has moved, using
 * the same applyProviderUpdate the webhook uses so the two cannot drift. It
 * never decides anything, never notifies anyone the webhook would not have, and
 * a provider being down is a logged no-op rather than a failure.
 */
import { query, queryOne } from '../db'
import { getProvider } from './backgroundProvider'
import { applyProviderUpdate } from './backgroundApplyUpdate'
import { logger } from '../lib/logger'

/** Statuses a provider can still move away from. Terminal ones are left alone. */
const IN_FLIGHT = ['pending', 'awaiting_applicant', 'submitted', 'processing'] as const

export interface SyncResult {
  scanned: number
  advanced: number
  unchanged: number
  errors: number
}

export async function syncPendingBackgroundChecks(
  opts: { maxAgeDays?: number } = {},
): Promise<SyncResult> {
  const out: SyncResult = { scanned: 0, advanced: 0, unchanged: 0, errors: 0 }

  // Old orders are not chased forever — a check nobody finished in two months
  // is abandoned, and Checkr expires its own apply links long before that.
  const rows = await query<{ id: string; provider_name: string; provider_ref: string; status: string }>(
    `SELECT id, provider_name, provider_ref, status
       FROM background_checks
      WHERE status = ANY($1::text[])
        AND provider_ref IS NOT NULL
        AND provider_name <> 'mock'
        AND created_at > NOW() - ($2 || ' days')::interval
      ORDER BY created_at ASC`,
    [IN_FLIGHT as unknown as string[], String(opts.maxAgeDays ?? 60)],
  )
  out.scanned = rows.length

  for (const row of rows) {
    try {
      const provider = getProvider(row.provider_name)
      if (!provider.fetchStatus) { out.unchanged++; continue }

      const remote = await provider.fetchStatus(row.provider_ref)
      if (!remote || remote.status === row.status) { out.unchanged++; continue }

      const check = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1', [row.id])
      if (!check) { out.unchanged++; continue }

      await applyProviderUpdate({
        provider,
        check,
        update: {
          providerRef: row.provider_ref,
          status: remote.status,
          reportRef: remote.reportRef,
          receivedAt: new Date(),
        },
        source: 'poll',
      })
      out.advanced++
      logger.info({ checkId: row.id, from: row.status, to: remote.status },
        '[bgc-sync] provider had moved on without telling us')
    } catch (e) {
      out.errors++
      logger.error({ err: e, checkId: row.id }, '[bgc-sync] status check failed (will retry)')
    }
  }
  return out
}
