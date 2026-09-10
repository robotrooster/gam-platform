// ── S639 (Nic): "We need a way to save all that data that is coming through.
// Start collecting it for future use." ───────────────────────────────────────
//
// One place that writes a provider payload down, used by both routes it can
// arrive through — the report fetch and the webhook. Two copies of this would
// drift, and the value of an archive is that it is complete.
//
// Never throws. An archive that can fail a screening is worse than no archive:
// the decision path must not depend on the record-keeping path.
import { query } from '../db'
import { logger } from '../lib/logger'

export interface ArchiveInput {
  backgroundCheckId: string
  landlordId?: string | null
  provider: string
  reportRef?: string | null
  source: 'fetch' | 'webhook'
  eventType?: string | null
  payload: unknown
}

export async function archiveProviderPayload(input: ArchiveInput): Promise<void> {
  if (!input.payload) return
  try {
    await query(
      `INSERT INTO background_check_reports
         (background_check_id, landlord_id, provider, report_ref, source, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [input.backgroundCheckId, input.landlordId ?? null, input.provider,
       input.reportRef ?? null, input.source, input.eventType ?? null,
       JSON.stringify(input.payload)],
    )
  } catch (err) {
    logger.error({ err, backgroundCheckId: input.backgroundCheckId, source: input.source },
      '[bg-archive] could not store provider payload — the screening itself is unaffected')
  }
}
