/**
 * S622 — background-check fees stated in a lease are DELIBERATELY not billed.
 *
 * Nic: "people are gonna be doing background checks through our Checkr
 * partnership, we need to ignore that lease fee and also prevent the landlord
 * from charging an extra fee for a background check when the tenant already has
 * paid for it through us... for migration, uploading existing PDF parses, it's
 * gonna show that as also non-billable because it would have already been paid
 * at move-in time. But we wanna identify them just to make sure that we're
 * purposely ignoring them, not accidentally ignoring them."
 *
 * Both sides of that matter. A new applicant pays GAM directly for screening, so
 * billing the lease's own fee charges them twice for one report. A migrated
 * tenant paid theirs before the lease was ever uploaded, so it is historical.
 * Either way the amount is real, printed, and must never become a charge.
 *
 * The point of naming them rather than silently dropping them: a fee that
 * vanishes without explanation is indistinguishable from one we failed to find.
 * These are surfaced as their own category, labelled as intentionally excluded.
 *
 * Deliberately NOT matched: "pet screening", and "processing"/"admin" fees,
 * which are ordinary move-in charges that happen to sit near application
 * language. When in doubt this returns false — wrongly billing nothing is worse
 * than wrongly flagging, because a missed charge is invisible and a flagged one
 * is on screen.
 */

const SCREENING_RE =
  /\b(background\s*(check|screening|report)|credit\s*(check|report|screening)|criminal\s*(background|history|check|screening)|consumer\s*report|tenant\s*screening|screening\s*(fee|report)|eviction\s*(history|check|search))\b/i

// "Application fee" only counts when the clause ties it to screening — a bare
// application fee can be a legitimate administrative charge.
const APPLICATION_RE = /\bapplication\s*(fee|charge)\b/i

// Never treat these as screening even if the words above appear nearby.
const NOT_SCREENING_RE = /\bpet\s*(screening|application)\b/i

/**
 * Does this clause describe a fee for screening the applicant?
 * `text` is the lease clause verbatim.
 */
export function isScreeningFeeText(text: string | null | undefined): boolean {
  const t = String(text ?? '')
  if (!t.trim()) return false
  if (NOT_SCREENING_RE.test(t)) return false
  if (SCREENING_RE.test(t)) return true
  // An application fee counts only when screening language shares the clause.
  return APPLICATION_RE.test(t) && SCREENING_RE.test(t)
}

/** Why a screening fee is excluded — shown to the landlord, not inferred. */
export const SCREENING_FEE_EXCLUSION_REASON =
  'Applicants pay GAM directly for screening, so this is never billed through the lease.'
