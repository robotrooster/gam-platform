// S295: csv_import_attempts persistence + position counter.
//
// Validate and commit handlers in apps/api/src/routes/landlords.ts call
// recordValidateAttempt() / recordCommitAttempt() to append a row to
// the review queue. Commit handlers also call getPlatformPosition() to
// decide whether to surface the firstFive banner in the success
// response.
//
// All operations are best-effort: if the insert fails (DB error, etc.)
// the import itself must not fail — we log and continue. The review
// queue is observational, not load-bearing.

import { PoolClient } from 'pg'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'
import type { CsvImportPlatform } from '../lib/csvImportMappings'
import { createAdminNotification } from './adminNotifications'

export type ImportType = 'tenant' | 'property' | 'payment'

interface RecordValidateInput {
  landlordId:   string
  importType:   ImportType
  platformKey:  CsvImportPlatform | string
  /** Original-case headers from the raw parsed CSV, source order. */
  columnHeaders: string[]
  /** First 5 raw rows (pre-applyMapping), original-case keys. */
  sampleRows:    Record<string, any>[]
  rowCount:      number
  blockers:      number
  warnings:      number
  /** Free-text platform name on generic uploads (S297-ready). */
  claimedPlatformName?: string | null
}

interface RecordCommitInput {
  landlordId:   string
  importType:   ImportType
  platformKey:  CsvImportPlatform | string
  columnHeaders: string[]
  sampleRows:    Record<string, any>[]
  rowCount:      number
  claimedPlatformName?: string | null
}

/**
 * Persist a validate attempt. Returns the inserted row id (or null on
 * failure — caller must not depend on this). Never throws — failure
 * is logged and swallowed.
 */
export async function recordValidateAttempt(
  input: RecordValidateInput,
  client?: PoolClient,
): Promise<string | null> {
  const sql = `INSERT INTO csv_import_attempts (
         landlord_id, import_type, platform_key, claimed_platform_name,
         column_headers, sample_rows, row_count, blockers, warnings,
         status
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, 'validated')
       RETURNING id`
  const params = [
    input.landlordId, input.importType, input.platformKey,
    input.claimedPlatformName ?? null,
    JSON.stringify(input.columnHeaders),
    JSON.stringify(input.sampleRows),
    input.rowCount, input.blockers, input.warnings,
  ]
  try {
    if (client) {
      const res = await client.query<{ id: string }>(sql, params)
      return res.rows[0]?.id ?? null
    }
    const rows = await query<{ id: string }>(sql, params)
    return rows[0]?.id ?? null
  } catch (err) {
    logger.error({ err, ctx: input.platformKey }, '[csv_import_attempts] validate insert failed')
    return null
  }
}

/**
 * Persist a commit attempt. Returns the inserted row id (or null on
 * failure). Never throws.
 */
export async function recordCommitAttempt(
  input: RecordCommitInput,
  client?: PoolClient,
): Promise<string | null> {
  const sql = `INSERT INTO csv_import_attempts (
         landlord_id, import_type, platform_key, claimed_platform_name,
         column_headers, sample_rows, row_count, blockers, warnings,
         status
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 0, 0, 'committed')
       RETURNING id`
  const params = [
    input.landlordId, input.importType, input.platformKey,
    input.claimedPlatformName ?? null,
    JSON.stringify(input.columnHeaders),
    JSON.stringify(input.sampleRows),
    input.rowCount,
  ]
  try {
    if (client) {
      const res = await client.query<{ id: string }>(sql, params)
      return res.rows[0]?.id ?? null
    }
    const rows = await query<{ id: string }>(sql, params)
    return rows[0]?.id ?? null
  } catch (err) {
    logger.error({ err, ctx: input.platformKey }, '[csv_import_attempts] commit insert failed')
    return null
  }
}

/**
 * Returns the verification status for the (platform, import_type)
 * slot. Falls back to 'unverified' if no row exists in
 * platform_review_status (the lazy-populated table). Powers two
 * downstream signals:
 *   - escalateToSuperAdmin — when unverified, every upload is
 *     surfaced in the super admin review queue.
 *   - landlord-facing banner — when unverified, the success page
 *     shows the "we'll review your migration" notice.
 *
 * S296: replaces the S295 getPlatformPosition() count-based gate.
 * The verification flag is the truthful signal; first-5 was a
 * proxy that broke down past the review SLA.
 */
export async function getPlatformReviewStatus(
  platformKey: CsvImportPlatform | string,
  importType:  ImportType,
): Promise<{ mappingStatus: 'unverified' | 'verified'; escalateToSuperAdmin: boolean }> {
  try {
    const rows = await query<{ mapping_status: string }>(
      `SELECT mapping_status FROM platform_review_status
        WHERE platform_key = $1 AND import_type = $2`,
      [platformKey, importType],
    )
    const status = (rows[0]?.mapping_status === 'verified' ? 'verified' : 'unverified') as
      'unverified' | 'verified'
    return { mappingStatus: status, escalateToSuperAdmin: status === 'unverified' }
  } catch (err) {
    logger.error({ err, ctx: platformKey }, '[platform_review_status] lookup failed')
    return { mappingStatus: 'unverified', escalateToSuperAdmin: true }
  }
}

/**
 * Pull first-5 rows + column headers from a freshly-parsed records
 * array. Both validate and commit handlers call this to build the
 * payload for record*Attempt(). Source-order preservation: column
 * order comes from the first record's key order (csv-parse emits
 * objects with keys in source-column order).
 */
export function extractAttemptShape(
  records: Record<string, any>[],
): { columnHeaders: string[]; sampleRows: Record<string, any>[] } {
  if (records.length === 0) {
    return { columnHeaders: [], sampleRows: [] }
  }
  const columnHeaders = Object.keys(records[0])
  const sampleRows = records.slice(0, 5)
  return { columnHeaders, sampleRows }
}

/**
 * S298: super_admin push notification on new CSV import attempts
 * from unverified platforms. Without this, the review queue is
 * pull-only — super admin would need to remember to check.
 *
 * Throttle: at most one notification per (platform_key, import_type)
 * per 24 hours. A burst of uploads from the same slot doesn't spam;
 * the queue still captures every attempt for review.
 *
 * Skipped entirely for platform_key='generic' — generic uploads
 * route through the S297 claim-aggregation flow, which has its own
 * surfacing mechanism. Notifying on every generic upload would be
 * noise.
 *
 * Best-effort: caller-side failure logs but never throws — the
 * primary CSV-import flow must not break because the alert system
 * did.
 */
export async function notifyCsvReviewPendingIfNeeded(opts: {
  landlordId:  string
  importType:  ImportType
  platformKey: CsvImportPlatform | string
  source:      'validate' | 'commit'
  claimedPlatformName?: string | null
}): Promise<void> {
  try {
    if (opts.platformKey === 'generic') return

    const status = await getPlatformReviewStatus(opts.platformKey, opts.importType)
    if (status.mappingStatus === 'verified') return

    // Dedupe: skip if we already sent a notification for this
    // (platform_key, import_type) slot in the last 24 hours.
    const recent = await query<{ id: string }>(
      `SELECT id FROM admin_notifications
        WHERE category = 'csv_import_review'
          AND context->>'platform_key' = $1
          AND context->>'import_type'  = $2
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [opts.platformKey, opts.importType],
    )
    if (recent.length > 0) return

    // Best-effort landlord-email lookup for the body copy. Fallback
    // shows landlord_id if the lookup fails.
    const landlord = await queryOne<{ email: string; first_name: string; last_name: string }>(
      `SELECT u.email, u.first_name, u.last_name
         FROM landlords l JOIN users u ON u.id = l.user_id
        WHERE l.id = $1`,
      [opts.landlordId],
    ).catch(() => null)
    const landlordLabel = landlord
      ? `${landlord.first_name} ${landlord.last_name} (${landlord.email})`.trim()
      : opts.landlordId

    // S316: deep link into the admin CSV imports queue. ADMIN_APP_URL
    // defaults to the dev port 3003; production sets this in env.
    const adminBase = process.env.ADMIN_APP_URL || 'http://localhost:3003'
    await createAdminNotification({
      severity: 'info',
      category: 'csv_import_review',
      title:    `${opts.platformKey} / ${opts.importType} CSV imported — needs review`,
      body:     `${landlordLabel} just ${opts.source}d a CSV from ${opts.platformKey} (${opts.importType}). The platform is currently unverified — review the column mapping in the CSV Imports queue. This is the only notification for this slot today; subsequent uploads will surface in the queue without re-notifying.`,
      context:  {
        platform_key:  opts.platformKey,
        import_type:   opts.importType,
        landlord_id:   opts.landlordId,
        source:        opts.source,
        claimed_platform_name: opts.claimedPlatformName ?? null,
      },
      emailSuperAdmins: true,
      action: { label: 'Open CSV Imports queue', url: `${adminBase}/csv-imports` },
    })
  } catch (err) {
    logger.error({ err, ctx: opts.platformKey }, '[csv_import_attempts] review-pending notification failed')
  }
}

/**
 * Normalize a claimed-platform name for aggregation matching.
 *
 *   "DoorLoop" / "doorloop" / "Door Loop" / "door-loop" / "Door_Loop"
 *     → "doorloop"
 *
 * Lowercase + strip everything that isn't a-z 0-9. Empty string
 * returned for null/undefined/whitespace-only input. Used by the
 * admin candidates query to group claim variants, and by the
 * existing-platform soft-warning check on the frontend (mirrored
 * client-side).
 */
export function normalizeClaimName(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
