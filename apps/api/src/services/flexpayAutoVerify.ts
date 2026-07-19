/**
 * S546: automated FlexPay proof verification + pre-qualification (Nic:
 * "take the manual process out").
 *
 * PROOF CHECK — runs on every proof upload:
 *   1. Extract text from the PDF (lib/pdfText — the same stack the
 *      lease parser uses). Non-PDF uploads (phone photos) are not
 *      machine-readable yet → silent 'unreadable' hold.
 *   2. NAME GATE: the document must contain the name of at least one
 *      ACTIVE lease holder (case-insensitive; first and last name
 *      both present in the text). No match → silent 'no_match' hold.
 *   3. Benefit-language scan: SSA / SSI / SSDI phrases recorded as a
 *      signal for the reviewer (informational, not a gate).
 * Results land in flexpay_inquiries.auto_verification. A MATCH clears
 * any hold this service previously placed (re-upload heals itself);
 * birthdate holds (flexpayVerification.ts) are never touched.
 * Approval (routes/admin.ts) requires nameMatch 'matched' or
 * 'manual_ok' — no human checkboxes in the normal flow. 'manual_ok'
 * is set by releasing a hold: the release IS the manual override.
 *
 * PRE-QUALIFICATION — nightly sweep, BACKEND-ONLY (never shown to
 * tenants): computes readiness from structured data so the file is
 * warm before interest ever arrives.
 */
import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

const AUTO_HOLD_PREFIX = '[auto-verify]'

const BENEFIT_PATTERNS = [
  /supplemental\s+security\s+income/i,
  /social\s+security\s+disability/i,
  /social\s+security\s+administration/i,
  /\bssdi\b/i,
  /\bssi\b/i,
  /benefit\s+verification/i,
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')
}

export interface AutoVerification {
  nameMatch: 'matched' | 'no_match' | 'unreadable' | 'manual_ok'
  matchedName?: string
  benefitKeywords?: boolean
  checkedAt: string
}

/** Extract flat text from a proof PDF; null = not machine-readable. */
async function extractProofText(filePath: string): Promise<string | null> {
  if (!filePath.endsWith('.pdf')) return null
  try {
    const buf = fs.readFileSync(filePath)
    const { extractPositionedText } = await import('../lib/pdfText')
    const doc = await extractPositionedText(buf)
    const text = doc.pages.map(p => p.items.map(i => i.text).join(' ')).join('\n')
    return text.trim().length > 0 ? text : null
  } catch (e) {
    logger.warn({ err: e, filePath }, '[flexpay-auto-verify] pdf extraction failed')
    return null
  }
}

/**
 * Verify the uploaded proof for an inquiry. Never throws. Places /
 * clears silent holds (S545c mechanism) owned by this service.
 */
export async function verifyProofDocument(inquiryId: string): Promise<AutoVerification | null> {
  try {
    const inq = await queryOne<{
      id: string; tenant_id: string; proof_file_path: string | null
      held_at: string | null; hold_reason: string | null
    }>(
      `SELECT id, tenant_id, proof_file_path, held_at, hold_reason
         FROM flexpay_inquiries WHERE id = $1`, [inquiryId])
    if (!inq?.proof_file_path) return null

    const holders = await query<{ first_name: string; last_name: string }>(
      `SELECT u2.first_name, u2.last_name
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
         JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.status = 'active'
         JOIN tenants t2 ON t2.id = lt2.tenant_id
         JOIN users u2 ON u2.id = t2.user_id
        WHERE lt.tenant_id = $1 AND lt.status = 'active'
          AND l.status IN ('active', 'pending')`,
      [inq.tenant_id])

    const fp = path.join(process.cwd(), 'uploads', 'flexpay-proofs', path.basename(inq.proof_file_path))
    const raw = await extractProofText(fp)

    let result: AutoVerification
    if (raw === null) {
      result = { nameMatch: 'unreadable', checkedAt: new Date().toISOString() }
    } else {
      const text = normalize(raw)
      const hit = holders.find(h =>
        text.includes(normalize(h.first_name)) && text.includes(normalize(h.last_name)))
      result = {
        nameMatch: hit ? 'matched' : 'no_match',
        matchedName: hit ? `${hit.first_name} ${hit.last_name}` : undefined,
        benefitKeywords: BENEFIT_PATTERNS.some(p => p.test(raw)),
        checkedAt: new Date().toISOString(),
      }
    }

    await query(
      `UPDATE flexpay_inquiries SET auto_verification = $2, updated_at = NOW() WHERE id = $1`,
      [inq.id, JSON.stringify(result)])

    const hasOwnHold = !!inq.held_at && (inq.hold_reason ?? '').startsWith(AUTO_HOLD_PREFIX)
    if (result.nameMatch === 'matched') {
      // Re-upload heals: clear a hold WE placed (never a birthdate/manual one).
      if (hasOwnHold) {
        await query(
          `UPDATE flexpay_inquiries SET held_at = NULL, hold_reason = NULL, updated_at = NOW()
            WHERE id = $1`, [inq.id])
        logger.info({ inquiryId: inq.id }, '[flexpay-auto-verify] hold cleared by matching re-upload')
      }
    } else if (!inq.held_at) {
      const reason = result.nameMatch === 'unreadable'
        ? `${AUTO_HOLD_PREFIX} Proof is not machine-readable (photo or image-only scan). Verify the document by hand, then release — or ask the tenant for the PDF award letter.`
        : `${AUTO_HOLD_PREFIX} Document doesn't contain any lease holder's name (${holders.map(h => `${h.first_name} ${h.last_name}`).join(', ') || 'none on lease'}). Verify identity before releasing.`
      await query(
        `UPDATE flexpay_inquiries SET held_at = NOW(), hold_reason = $2, updated_at = NOW()
          WHERE id = $1 AND held_at IS NULL`, [inq.id, reason])
      logger.info({ inquiryId: inq.id, nameMatch: result.nameMatch }, '[flexpay-auto-verify] silent hold placed')
    }
    return result
  } catch (e) {
    logger.error({ err: e, inquiryId }, '[flexpay-auto-verify] failed (non-fatal)')
    return null
  }
}

/**
 * Nightly pre-qualification sweep — BACKEND-ONLY. Computes FlexPay
 * readiness for every tenant with an active lease from structured
 * data; stored on tenants.flexpay_prequal. Never surfaces to tenants.
 */
export async function sweepFlexpayPrequal(): Promise<number> {
  const rows = await query<any>(
    `SELECT t.id, t.ssi_ssdi, t.ach_verified,
            (t.date_of_birth IS NOT NULL) AS has_dob,
            (t.flexpay_disqualified_until IS NOT NULL AND t.flexpay_disqualified_until > NOW()) AS suspended
       FROM tenants t
      WHERE EXISTS (
        SELECT 1 FROM lease_tenants lt
          JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = t.id AND lt.status = 'active'
           AND l.status IN ('active', 'pending'))`)
  let updated = 0
  for (const r of rows) {
    const reasons: string[] = []
    if (!r.ssi_ssdi) reasons.push('no_ssi_ssdi_flag')
    if (!r.ach_verified) reasons.push('ach_unverified')
    if (!r.has_dob) reasons.push('no_dob_on_file')
    if (r.suspended) reasons.push('nsf_suspended')
    const status = reasons.length === 0 ? 'prequalified'
      : (r.ssi_ssdi && !r.suspended) ? 'near' : 'not'
    await query(
      `UPDATE tenants SET flexpay_prequal = $2 WHERE id = $1`,
      [r.id, JSON.stringify({ status, reasons, computedAt: new Date().toISOString() })])
    updated++
  }
  logger.info({ updated }, '[flexpay-prequal] sweep complete')
  return updated
}
