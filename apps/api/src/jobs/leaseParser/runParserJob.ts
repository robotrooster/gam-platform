// =====================================================================
// runParserJob — orchestration layer between parseLease() and the intent.
//
// Replaces schedulePendingParserStub from S29c-2-A. Reads the intent's
// stored PDF, calls parseLease(), compares the parser-extracted tenant
// identity against the landlord-typed identity (from intent.tenant_id ->
// tenants -> users), generates identity_mismatch flags if they disagree,
// and writes parser_output / parser_status / parser_flags back to the
// intent.
//
// CRITICAL: This is parser-only. It NEVER creates leases. Every limbo
// intent passes through landlord click via POST /resolve before the
// resolveIntent flow fires. parser_status='parsed' means "form is mostly
// green, landlord still confirms"; never auto-build.
//
// The "schedule" is in-process setTimeout, mirroring the stub. Real
// queue infra is later — once we move beyond MVP volumes.
// =====================================================================

import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../../db'
import { parseLease } from './index'
import { extractUploadFilename } from '../../lib/uploadPaths'
import type {
  ParserOutput, ParserStatus, ParserFlag,
} from '@gam/shared'
import { logger } from '../../lib/logger'

const pendingPdfDir = path.join(process.cwd(), 'uploads', 'lease-pdfs-pending')

interface IntentRow {
  id: string
  landlord_id: string
  tenant_id: string
  imported_pdf_url: string | null
  parser_status: ParserStatus
}

interface LandlordTypedIdentity {
  firstName: string
  lastName: string
  email: string
}

/**
 * Schedule parser to run async. Mirrors schedulePendingParserStub's
 * setTimeout pattern so the upload handler returns immediately and the
 * landlord polls /me/pending-tenants for status transitions.
 *
 * Errors inside the async work are caught and written to the intent as
 * parser_status='error' with parser_error populated. They are never
 * surfaced to the upload-handler caller (which has long since responded).
 */
export function scheduleParserJob(intentId: string): void {
  setTimeout(() => {
    runParserJob(intentId).catch(err => {
      logger.error({ err: err, ctx: intentId }, '[PARSER JOB] Unhandled error for intent')
    })
  }, 0)
}

/**
 * Run the parser end-to-end on a pending intent. Idempotent against
 * parser_status — only proceeds when status='parsing' (the upload handler
 * sets this immediately before scheduling). If status has moved on (e.g.
 * a second upload ran), this no-ops.
 */
export async function runParserJob(intentId: string): Promise<void> {
  // 1. Load intent + verify state. Bail if landlord re-uploaded between
  //    schedule and execution — the second upload's job will run instead.
  const intent = await queryOne<IntentRow>(
    `SELECT id, landlord_id, tenant_id, imported_pdf_url, parser_status
     FROM pending_tenant_intents
     WHERE id = $1`,
    [intentId]
  )
  if (!intent) {
    logger.error({ err: intentId }, '[PARSER JOB] Intent vanished before parse')
    return
  }
  if (intent.parser_status !== 'parsing') {
    // Already moved on (re-upload, manual reset, resolved, etc). Skip.
    return
  }
  if (!intent.imported_pdf_url) {
    await markError(intentId, 'No PDF on intent at parse time')
    return
  }

  // 2. Load PDF from disk. Same filename derivation the GET handler uses.
  const filename = extractUploadFilename(intent.imported_pdf_url)
  if (!filename) {
    await markError(intentId, 'Stored document path is malformed')
    return
  }
  const filePath = path.join(pendingPdfDir, filename)
  if (!fs.existsSync(filePath)) {
    await markError(intentId, 'PDF file missing on disk at parse time')
    return
  }
  let buf: Buffer
  try {
    buf = fs.readFileSync(filePath)
  } catch (e: any) {
    await markError(intentId, `Failed to read PDF: ${e?.message || String(e)}`)
    return
  }

  // 3. Load landlord-typed identity from the tenant row. The /onboard-tenant-pending
  //    flow stored these fields when the limbo intent was created -- this is
  //    what the landlord typed into the form before uploading the PDF.
  let typed: LandlordTypedIdentity | null
  try {
    typed = await loadLandlordTypedIdentity(intent.tenant_id)
  } catch (e: any) {
    await markError(intentId, `Failed to load tenant identity: ${e?.message || String(e)}`)
    return
  }

  // 4. Run the parser. parseLease is pure — buffer in, ParseResult out.
  let parseResult: Awaited<ReturnType<typeof parseLease>>
  try {
    parseResult = await parseLease(buf)
  } catch (e: any) {
    logger.error({ err: e, ctx: intentId }, '[PARSER JOB] parseLease threw for intent')
    await markError(intentId, `Parser failed: ${e?.message || String(e)}`)
    return
  }

  // 5. Identity comparison. If landlord typed John Smith but PDF says
  //    Marci Neeld, flag it block-severity. Each mismatched field is
  //    its own flag so the landlord sees field-level diffs in the UI.
  const identityFlags = typed
    ? buildIdentityMismatchFlags(typed, parseResult.output)
    : []
  const allFlags: ParserFlag[] = [...parseResult.flags, ...identityFlags]

  // Identity mismatches are block-severity by definition: wrong tenant on
  // wrong unit is a real money / wrong-person-getting-keys problem. If any
  // landed, force status to 'mismatch' regardless of what parseLease said.
  const finalStatus: ParserStatus =
    identityFlags.length > 0
      ? 'mismatch'
      : parseResult.status

  // 6. Persist. Single UPDATE; the upload handler's UPDATE set parser_status
  //    to 'parsing'; this transitions to the terminal-for-now state.
  await query(
    `UPDATE pending_tenant_intents
     SET parser_status     = $1,
         parser_output     = $2::jsonb,
         parser_flags      = $3::jsonb,
         parser_error      = NULL,
         parser_finished_at = NOW(),
         updated_at        = NOW()
     WHERE id = $4 AND parser_status = 'parsing'`,
    [finalStatus, JSON.stringify(parseResult.output), JSON.stringify(allFlags), intentId]
  )
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Read landlord-typed identity from tenants -> users. This is what the
 * landlord typed when creating the limbo intent (before the PDF arrived).
 *
 * Returns null if the tenant has no user yet. That happens when the
 * intent was created via a path that doesn't pre-populate user fields
 * -- in which case there's nothing for the parser output to disagree
 * with, and identity comparison is skipped.
 */
async function loadLandlordTypedIdentity(tenantId: string): Promise<LandlordTypedIdentity | null> {
  const row = await queryOne<{ first_name: string | null; last_name: string | null; email: string | null }>(
    `SELECT u.first_name, u.last_name, u.email
     FROM tenants t
     JOIN users u ON u.id = t.user_id
     WHERE t.id = $1`,
    [tenantId]
  )
  if (!row) return null
  if (!row.first_name || !row.last_name || !row.email) return null
  return {
    firstName: row.first_name,
    lastName:  row.last_name,
    email:     row.email,
  }
}

/**
 * Compare landlord-typed identity against parser-extracted identity.
 * Per-field mismatches generate per-field flags. Case-insensitive
 * compare on names and email. Whitespace normalized.
 *
 * Identity-mismatch flags are ALWAYS block severity. The landlord must
 * pick a side (typed wrong, or PDF is the wrong PDF) before /resolve.
 *
 * Note: missing parser-extracted fields are NOT flagged here. Those are
 * already captured by parseLease as field_missing flags. This function
 * only flags actual disagreements.
 */
function buildIdentityMismatchFlags(
  typed: LandlordTypedIdentity,
  out: ParserOutput,
): ParserFlag[] {
  const flags: ParserFlag[] = []
  const t0 = out.tenants[0]
  if (!t0) return flags

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

  if (t0.firstName && norm(t0.firstName.value) !== norm(typed.firstName)) {
    flags.push({
      category: 'identity_mismatch',
      severity: 'block',
      field:    'tenants.0.firstName',
      message:  `First name in PDF does not match what landlord typed`,
      expected: typed.firstName,
      found:    t0.firstName.value,
    })
  }
  if (t0.lastName && norm(t0.lastName.value) !== norm(typed.lastName)) {
    flags.push({
      category: 'identity_mismatch',
      severity: 'block',
      field:    'tenants.0.lastName',
      message:  `Last name in PDF does not match what landlord typed`,
      expected: typed.lastName,
      found:    t0.lastName.value,
    })
  }
  if (t0.email && norm(t0.email.value) !== norm(typed.email)) {
    flags.push({
      category: 'identity_mismatch',
      severity: 'block',
      field:    'tenants.0.email',
      message:  `Email in PDF does not match what landlord typed`,
      expected: typed.email,
      found:    t0.email.value,
    })
  }
  return flags
}

/**
 * Mark an intent errored. Used when the parser couldn't even start
 * (PDF missing, identity load failed, parseLease threw). Distinct from
 * 'mismatch' status which means parsing succeeded but flagged blockers.
 */
async function markError(intentId: string, message: string): Promise<void> {
  try {
    await query(
      `UPDATE pending_tenant_intents
       SET parser_status='error',
           parser_error=$1,
           parser_finished_at=NOW(),
           updated_at=NOW()
       WHERE id=$2 AND parser_status='parsing'`,
      [message, intentId]
    )
  } catch (e) {
    logger.error({ err: e, ctx: intentId }, '[PARSER JOB] Failed to mark error for intent')
  }
}
