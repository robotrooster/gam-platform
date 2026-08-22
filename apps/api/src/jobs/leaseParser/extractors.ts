// apps/api/src/jobs/leaseParser/extractors.ts
//
// Per-field extractors. Each one wraps findFieldByLabel + a coercion
// function + confidence scoring, returning a ParserExtractedField<T>
// (or null when extraction fails).
//
// Confidence model:
//   base 0.95 for ideal extraction (right-side match, close to label,
//   strict shape filter passed). Penalties accumulate from there:
//     - 'below' match instead of 'right'        : -0.05
//     - distance from label-end > 50pt          : -0.05
//     - distance from label-end > 100pt         : another -0.05
//     - shape filter is loose (anti-noise only) : -0.10
//     - shape filter absent                     : -0.20
//   Floor 0.30 (anything that extracts at all is at least slightly
//   trusted), ceiling 0.99 (we never claim certainty -- landlord
//   confirms every field).

import type {
  ParserExtractedField,
  ParserExtractedTenant,
  ParserExtractedUnit,
  ParserExtractedLease,
  ParserExtractedMobileHome,
  ParserExtractedEmergencyContact,
  ParserExtractedIdentification,
  ParserExtractedLiabilityInsurance,
  ParserExtractedOccupant,
} from '@gam/shared'
import type { Page } from '../../lib/pdfText'
import { findFieldByLabel } from './anchors'
import {
  coercePhone, coerceDateMDY, coerceDateFromText, coerceCurrency,
  coerceInt, coerceText, coerceTextOrNA, coerceTermInMonths,
  splitName, splitNameAndPhone,
} from './coerce'

type ShapeStrength = 'strict' | 'loose' | 'none'

function scoreConfidence(opts: {
  matchKind: 'right' | 'below'
  distanceFromLabelEnd: number
  shape: ShapeStrength
}): number {
  let conf = 0.95
  if (opts.matchKind === 'below') conf -= 0.05
  const dist = Math.abs(opts.distanceFromLabelEnd)
  if (dist > 50)  conf -= 0.05
  if (dist > 100) conf -= 0.05
  if (opts.shape === 'loose') conf -= 0.10
  if (opts.shape === 'none')  conf -= 0.20
  return Math.max(0.30, Math.min(0.99, conf))
}

/**
 * Generic extractor wrapper: search for label, coerce result, score
 * confidence, return ParserExtractedField (or null).
 */
function extractField<T>(
  page: Page,
  opts: {
    labelPattern: RegExp
    valueShape?: RegExp
    shapeStrength?: ShapeStrength
    valuePosition?: 'right_same_line' | 'below_same_x' | 'right_then_below'
    coerce: (raw: string) => T | null
  }
): ParserExtractedField<NonNullable<T>> | null {
  const hit = findFieldByLabel(page, {
    labelPattern: opts.labelPattern,
    valueShape:   opts.valueShape,
    valuePosition: opts.valuePosition,
  })
  if (!hit) return null
  const raw = hit.value.text.trim()
  const coerced = opts.coerce(raw)
  if (coerced === null || coerced === undefined) return null
  const shape = opts.shapeStrength ?? (opts.valueShape ? 'strict' : 'none')
  return {
    value:      coerced as NonNullable<T>,
    confidence: scoreConfidence({
      matchKind: hit.matchKind,
      distanceFromLabelEnd: hit.distanceFromLabelEnd,
      shape,
    }),
    rawText: raw,
  }
}

// ---------------------------------------------------------------------
// Tenant identity (page 1, body)
// ---------------------------------------------------------------------

export function extractTenantNameSplit(page: Page): {
  firstName: ParserExtractedField<string> | null
  lastName:  ParserExtractedField<string> | null
} {
  const hit = extractField(page, {
    labelPattern:  /TENANT\(S\):/i,
    valueShape:    /^[A-Za-z][A-Za-z\s'\-.]*[A-Za-z]$/,
    coerce:        coerceText,
  })
  if (!hit) return { firstName: null, lastName: null }
  const split = splitName(hit.value)
  return {
    firstName: { value: split.firstName, confidence: hit.confidence, rawText: hit.rawText },
    lastName:  { value: split.lastName,  confidence: hit.confidence, rawText: hit.rawText },
  }
}

export function extractTenantPhone(page: Page) {
  return extractField(page, {
    labelPattern:  /Telephone Number\(s\):/i,
    valueShape:    /^[\d\-().\s+]+$/,
    coerce:        coercePhone,
  })
}

export function extractTenantDateOfBirth(page: Page) {
  return extractField(page, {
    labelPattern:  /Birthdate\(s\):|Date of Birth:|DOB:/i,
    valueShape:    /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    coerce:        coerceDateMDY,
  })
}

export function extractTenantMailingAddress(page: Page) {
  return extractField(page, {
    labelPattern:  /Mailing Address:|Address:/i,
    valueShape:    /[A-Za-z]/,           // loose: anything with a letter
    shapeStrength: 'loose',
    coerce:        coerceText,
  })
}

// ---------------------------------------------------------------------
// Identifications (page 1)
// ---------------------------------------------------------------------

export function extractDriversLicense(page: Page): ParserExtractedIdentification | null {
  const number = extractField(page, {
    labelPattern:  /Driver.?s License No\(s\)\.:/i,
    valueShape:    /^[A-Z]?\d{4,}[A-Z\d]*$/i,
    coerce:        coerceTextOrNA,
  })
  if (!number) return null
  return {
    idType:   { value: 'drivers_license', confidence: number.confidence, rawText: 'Driver\'s License field' },
    idNumber: number,
  }
}

// ---------------------------------------------------------------------
// Emergency contacts (page 1)
// ---------------------------------------------------------------------

export function extractEmergencyContact(page: Page): ParserExtractedEmergencyContact | null {
  const hit = extractField(page, {
    labelPattern:  /Emergency Contact:/i,
    valueShape:    /[A-Za-z]/,
    shapeStrength: 'loose',
    coerce:        coerceText,
  })
  if (!hit) return null
  const split = splitNameAndPhone(hit.value)
  return {
    name:  { value: split.name,  confidence: hit.confidence, rawText: hit.rawText },
    phone: split.phone
      ? { value: split.phone, confidence: hit.confidence, rawText: hit.rawText }
      : undefined,
  }
}

// ---------------------------------------------------------------------
// Liability insurance (page 1)
// ---------------------------------------------------------------------

export function extractLiabilityInsurance(page: Page): ParserExtractedLiabilityInsurance | null {
  const carrier = extractField(page, {
    labelPattern:  /Carrier:/i,
    valueShape:    /[A-Za-z]/,
    shapeStrength: 'loose',
    coerce:        coerceTextOrNA,
  })
  const policy = extractField(page, {
    labelPattern:  /Policy No\.:|Policy Number:/i,
    valueShape:    /[A-Za-z0-9]/,
    shapeStrength: 'loose',
    coerce:        coerceTextOrNA,
  })
  // Only emit if at least one field extracted (even if it's a nominal value)
  if (!carrier && !policy) return null
  return {
    carrierName:  carrier  ?? undefined,
    policyNumber: policy   ?? undefined,
  }
}

// ---------------------------------------------------------------------
// Mobile home (page 1, multi-value line: Year/Make/Model/Serial)
// ---------------------------------------------------------------------

export function extractMobileHome(page: Page): ParserExtractedMobileHome | null {
  const year = extractField(page, {
    labelPattern:  /Year:/i,
    valueShape:    /^(19|20)\d{2}$/,
    coerce:        coerceInt,
  })
  const makeModelHit = findFieldByLabel(page, {
    labelPattern:  /Make\/Model:/i,
    valueShape:    /[A-Za-z]/,
  })
  const serial = extractField(page, {
    labelPattern:  /Serial Number:/i,
    valueShape:    /^[A-Z0-9\-]+$/i,
    coerce:        coerceText,
  })
  if (!year && !makeModelHit && !serial) return null

  // makeModel is "Columbia UNK" -- split into make + model when possible.
  // Heuristic: first whitespace-separated word is make, remainder is model.
  let make:  ParserExtractedField<string> | undefined
  let model: ParserExtractedField<string> | undefined
  if (makeModelHit) {
    const parts = makeModelHit.value.text.trim().split(/\s+/)
    const conf = scoreConfidence({
      matchKind: makeModelHit.matchKind,
      distanceFromLabelEnd: makeModelHit.distanceFromLabelEnd,
      shape: 'loose',
    })
    if (parts.length >= 1) {
      make = { value: parts[0], confidence: conf, rawText: makeModelHit.value.text }
      if (parts.length > 1) {
        model = { value: parts.slice(1).join(' '), confidence: conf, rawText: makeModelHit.value.text }
      }
    }
  }

  return {
    year:          year   ?? undefined,
    make:          make,
    model:         model,
    serialNumber:  serial ?? undefined,
  }
}

// ---------------------------------------------------------------------
// Unit (page 1, Space No. is inline-prose)
// ---------------------------------------------------------------------

export function extractUnitNumber(page: Page) {
  // "the following Space No. _____" -- inline prose label
  return extractField(page, {
    labelPattern:  /Space\s*No\.?\s+/i,
    valueShape:    /^\d+$/,
    coerce:        coerceText,
  })
}

export function detectUnitType(pages: Page[]): { value: string; confidence: number } {
  // Heuristic: count occurrences of unit-type keywords across all body text.
  // Highest count wins. Defaults to 'apartment' if nothing matches.
  const allText = pages.flatMap(p => p.items).map(i => i.text.toLowerCase()).join(' ')
  const counts: Array<[string, number]> = [
    ['mobile_home',   (allText.match(/\bmobile home\b/g) || []).length],
    ['rv_spot',       (allText.match(/\brv\b|\brecreational vehicle\b/g) || []).length],
    ['storage',       (allText.match(/\bstorage (?:unit|space|facility)\b/g) || []).length],
    ['commercial',    (allText.match(/\bcommercial (?:lease|space|premises)\b/g) || []).length],
    ['single_family', (allText.match(/\bsingle.?family\b/g) || []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  const [type, count] = counts[0]
  if (count === 0) return { value: 'apartment', confidence: 0.40 }  // weak default
  // Confidence rises with mention count, capped
  const conf = Math.min(0.95, 0.55 + count * 0.05)
  return { value: type, confidence: conf }
}

// ---------------------------------------------------------------------
// Lease terms (page 2)
// ---------------------------------------------------------------------

export function extractFixedTerm(page: Page) {
  // "Fixed Term of 1 Year" -- value is to the right
  return extractField(page, {
    labelPattern:  /Fixed Term of/i,
    valueShape:    /^\d+\s*(years?|yrs?|months?|mos?)$/i,
    coerce:        coerceTermInMonths,
  })
}

export function extractLeaseStart(page: Page) {
  return extractField(page, {
    labelPattern:  /beginning on/i,
    valueShape:    /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    coerce:        coerceDateMDY,
  })
}

export function extractLeaseEnd(page: Page) {
  return extractField(page, {
    labelPattern:  /and ending on/i,
    valueShape:    /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    coerce:        coerceDateMDY,
  })
}

export function extractMonthlyRent(page: Page) {
  return extractField(page, {
    labelPattern:  /monthly installments of \$/i,
    valueShape:    /^[\d,]+(\.\d+)?$/,
    coerce:        coerceCurrency,
  })
}

export function extractSecurityDeposit(page: Page) {
  return extractField(page, {
    labelPattern:  /Security Deposit:\s*One/i,
    valueShape:    /^([\d,]+(\.\d+)?|N\/A)$/i,
    coerce:        coerceCurrency,  // returns null for N/A, which is correct
  })
}

// ---------------------------------------------------------------------
// Lease behavior detection (auto-renew, notice days, late fees)
// from body text patterns rather than labeled fields.
// ---------------------------------------------------------------------

export function detectAutoRenew(pages: Page[]): {
  autoRenew: ParserExtractedField<boolean>
  autoRenewMode: ParserExtractedField<string> | null
} {
  const text = pages.flatMap(p => p.items).map(i => i.text).join(' ')
  // "shall continue on a month-to-month basis" -> auto-renew TO m2m
  if (/continue on a month.to.month basis/i.test(text)) {
    return {
      autoRenew:     { value: true,  confidence: 0.90, rawText: 'continue on a month-to-month basis' },
      autoRenewMode: { value: 'convert_to_month_to_month', confidence: 0.90, rawText: 'continue on a month-to-month basis' },
    }
  }
  // "shall automatically renew for an additional [term]" -> extend same term
  if (/automatically renew for (?:an additional|another)/i.test(text)) {
    return {
      autoRenew:     { value: true,  confidence: 0.85, rawText: 'automatically renew for an additional' },
      autoRenewMode: { value: 'extend_same_term', confidence: 0.85, rawText: 'automatically renew' },
    }
  }
  return {
    autoRenew:     { value: false, confidence: 0.50, rawText: '(no auto-renew language detected)' },
    autoRenewMode: null,
  }
}

export function detectNoticeDays(pages: Page[]): ParserExtractedField<number> | null {
  const text = pages.flatMap(p => p.items).map(i => i.text).join(' ')
  // pdfjs splits multi-digit numbers across font subsets: "(30)" can come
  // through as "(3 0)". Tolerate whitespace inside the digit run, then
  // strip whitespace before parseInt. Form 1: "at least thirty (3 0) days
  // before the expiration"; Form 2: "at least 30 days before".
  const m1 = text.match(/at least\s+(?:[a-z]+\s+\(\s*)?(\d(?:\s*\d){0,2})\s*\)?\s+days?\s+before\s+the\s+(?:expiration|termination)/i)
  if (m1) {
    const n = parseInt(m1[1].replace(/\s+/g, ''), 10)
    if (n >= 1 && n <= 365) return { value: n, confidence: 0.85, rawText: m1[0] }
  }
  // Spelled-out fallback for documents where digit run won't reassemble
  // (e.g. only "thirty" present). Limited to common notice-period values.
  const WORD_NUMS: Record<string, number> = {
    ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
  }
  const m2 = text.match(/at least\s+(ten|fifteen|twenty|thirty|sixty|ninety)\s+days?\s+before\s+the\s+(?:expiration|termination)/i)
  if (m2) {
    const n = WORD_NUMS[m2[1].toLowerCase()]
    return { value: n, confidence: 0.80, rawText: m2[0] }
  }
  return null
}

export function detectLateFees(pages: Page[]): {
  lateFeeAmount:    ParserExtractedField<number> | null
  lateFeeGraceDays: ParserExtractedField<number> | null
} {
  const text = pages.flatMap(p => p.items).map(i => i.text).join(' ')
  // "late charge of Five dollars ($5.00) per day" / "late fee of $50".
  // pdfjs-split currency: "$ 5 .00" — tolerate whitespace inside the
  // amount, then strip before coerce.
  let lateFeeAmount: ParserExtractedField<number> | null = null
  const amountMatch = text.match(/late\s+(?:charge|fee)\s+of(?:[^$]+)\$\s*([\d,]+(?:\s*\.\s*\d+)?)/i)
  if (amountMatch) {
    const cleaned = amountMatch[1].replace(/\s+/g, '')
    const n = coerceCurrency(cleaned)
    if (n !== null) lateFeeAmount = { value: n, confidence: 0.80, rawText: amountMatch[0] }
  }
  // "if not remitted by the 5th day" / "after the 5 th day".
  // pdfjs splits words AND ordinal suffixes inconsistently:
  //   "remitted" -> "re mitted"
  //   "5th"      -> "5 th"
  // Anchor on the ordinal-day pattern instead of "remitted by", which is
  // robust to upstream word splits. Form: <digit><opt-ws><ordinal><ws>day.
  const lateFeeGraceDays = extractGraceDays(text)
  return { lateFeeAmount, lateFeeGraceDays }
}


/**
 * S616 (Nic) — find the grace period however the lease phrases it.
 *
 *   "We need to add a thing that searches for the word grace in all of those
 *    phrases, for any lease formats. It should only ignore the word grace when
 *    it's the name of a person on the lease, which should be rare, but not
 *    never."
 *
 * The old extractor matched exactly one phrasing — "by the 5th day" — and every
 * other way a lease says this fell through to a silent default of 5. That
 * default then drove what the tenant was told about their autopay date, so a
 * lease with a ten-day grace could have had someone warned off a day that was
 * actually free, or worse, reassured about one that was not.
 *
 * WHY "GRACE" IS THE ANCHOR: it is the word that survives reformatting. Leases
 * are written by a thousand different offices and no two agree on sentence
 * shape, but the ones that grant a grace period almost always name it.
 *
 * THE PERSON PROBLEM. Grace is also a name, and a lease is full of names. A
 * tenant called Grace Whitfield must not donate her name to the billing engine.
 * Two guards, because either alone is wrong:
 *   · a capitalised "Grace" followed by another capitalised word, or preceded
 *     by one, is a person — "Grace Whitfield", "Mary Grace".
 *   · no digit anywhere near it means there is no period to read regardless.
 * A name adjacent to an unrelated number is still refused, because the number
 * has to sit in a grace-shaped phrase to count.
 */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30,
}

/** "five (5)" → 5, "5" → 5, "five" → 5. Leases write numbers all three ways,
 *  often in one sentence. */
function readCount(raw: string): number | null {
  const paren = raw.match(/\((\d{1,2})\)/)
  if (paren) return parseInt(paren[1], 10)
  const digits = raw.match(/\d{1,2}/)
  if (digits) return parseInt(digits[0], 10)
  const word = raw.toLowerCase().match(/[a-z]+/)
  if (word && NUMBER_WORDS[word[0]] !== undefined) return NUMBER_WORDS[word[0]]
  return null
}

/** Is this occurrence of "grace" somebody's name rather than a period? */
export function graceLooksLikeAName(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index)
  const after = text.slice(index + 5, index + 45)
  // "Grace Whitfield" — capitalised Grace followed by another capitalised word
  // that is not a word leases use for periods.
  if (/^\s+[A-Z][a-z]{1,20}/.test(after)
      && !/^\s+(Period|Days?|Day)\b/i.test(after)
      && text[index] === 'G') return true
  // "Mary Grace", "to Grace," — preceded by a capitalised name or an address
  // of a person.
  if (/[A-Z][a-z]{1,20}\s+$/.test(before) && text[index] === 'G'
      && !/(a|the|day|days|of|no|any)\s+$/i.test(before)) return true
  return false
}

export function extractGraceDays(text: string): ParserExtractedField<number> | null {
  // Every phrasing that anchors on the word itself. Ordered strongest first;
  // the first that yields a plausible count wins.
  const AROUND_GRACE: RegExp[] = [
    // "grace period of five (5) days", "grace period: 5 days"
    /grace\s*period\s*(?:of|is|shall\s+be|=|:)?\s*([a-z]*\s*\(?\d{0,2}\)?)\s*(?:calendar\s+|business\s+)?days?/i,
    // "five (5) day grace period", "a 10-day grace period"
    /([a-z]*\s*\(?\d{0,2}\)?)[\s-]*(?:calendar\s+|business\s+)?day[\s-]*grace\s*period/i,
    // "grace of 5 days"
    /grace\s+of\s+([a-z]*\s*\(?\d{0,2}\)?)\s*(?:calendar\s+|business\s+)?days?/i,
  ]
  for (const re of AROUND_GRACE) {
    const m = text.match(re)
    if (!m) continue
    const at = m.index ?? 0
    const graceAt = text.toLowerCase().indexOf('grace', at)
    if (graceAt >= 0 && graceLooksLikeAName(text, graceAt)) continue
    const n = readCount(m[1] ?? '')
    if (n !== null && n >= 0 && n <= 31) {
      return { value: n, confidence: 0.85, rawText: m[0].trim() }
    }
  }

  // Leases that describe the same thing without naming it. Lower confidence:
  // these read a DAY OF MONTH rather than a count of days, which is the same
  // number only because rent is due on the 1st platform-wide.
  const IMPLIED: RegExp[] = [
    /by\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)\s+day/i,          // "by the 5th day"
    /(?:on\s+or\s+)?before\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)/i, // "before the 5th"
    /within\s+([a-z]*\s*\(?\d{0,2}\)?)\s*(?:calendar\s+|business\s+)?days?\s+(?:of|after|from)\s+the\s+due\s+date/i,
  ]
  for (const re of IMPLIED) {
    const m = text.match(re)
    if (!m) continue
    const n = readCount(m[1] ?? '')
    if (n !== null && n >= 0 && n <= 31) {
      return { value: n, confidence: 0.80, rawText: m[0].trim() }
    }
  }
  return null
}

export function detectSubleasingPolicy(pages: Page[]): ParserExtractedField<string> | null {
  const text = pages.flatMap(p => p.items).map(i => i.text).join(' ')
  if (/may\s+sublet[,\s]+upon written agreement/i.test(text)) {
    return { value: 'with_consent', confidence: 0.85, rawText: 'may sublet, upon written agreement' }
  }
  if (/shall not (?:sublet|sublease)/i.test(text)) {
    return { value: 'prohibited', confidence: 0.85, rawText: 'shall not sublet' }
  }
  if (/may freely sublet|sublet (?:is|are) permitted/i.test(text)) {
    return { value: 'allowed', confidence: 0.80, rawText: 'subletting permitted' }
  }
  return null
}

// ---------------------------------------------------------------------
// Property name and address (top of page 1)
// ---------------------------------------------------------------------

export function extractPropertyNameAndAddress(pages: Page[]): {
  propertyName?:    ParserExtractedField<string>
  propertyAddress?: ParserExtractedField<string>
} {
  const text = pages.flatMap(p => p.items).map(i => i.text).join(' ')
  // "this park, Oak Park Motel and RV, 22658 Highway 89 Yarnell AZ 85362 ("Premises")"
  // Real PDFs use curly quotes (\u201C \u201D) and have arbitrary whitespace
  // between address and the "Premises" delimiter. Tolerate both.
  const m = text.match(/(?:this|the)\s+(?:park|community|premises|property)\s*,\s*([^,]+?)\s*,\s*([^,(\u201C\u201D"]+?)\s*[(\u201C\u201D"]+\s*Premises/i)
  if (m) {
    return {
      propertyName:    { value: m[1].trim(), confidence: 0.80, rawText: m[0].slice(0, 100) },
      propertyAddress: { value: m[2].trim(), confidence: 0.80, rawText: m[0].slice(0, 100) },
    }
  }
  return {}
}

// ---------------------------------------------------------------------
// Names of all persons / additional occupants (page 1)
// ---------------------------------------------------------------------

export function extractAdditionalOccupants(
  page: Page,
  primaryTenantFullName: string
): ParserExtractedOccupant[] {
  const hit = extractField(page, {
    labelPattern:  /Names of All Persons staying/i,
    valueShape:    /[A-Za-z]/,
    shapeStrength: 'loose',
    coerce:        coerceText,
  })
  if (!hit) return []
  // "Marci Neeld" only -- excludes the primary tenant
  const names = hit.value.split(/[,\n;]/).map(s => s.trim()).filter(Boolean)
  const primaryNorm = primaryTenantFullName.toLowerCase().replace(/\s+/g, ' ').trim()
  const occupants: ParserExtractedOccupant[] = []
  for (const name of names) {
    const norm = name.toLowerCase().replace(/\s+/g, ' ').trim()
    if (norm === primaryNorm) continue  // primary tenant is not an "additional" occupant
    occupants.push({
      fullName: { value: name, confidence: hit.confidence, rawText: hit.rawText },
    })
  }
  return occupants
}

// ---------------------------------------------------------------------
// S550: conditional fees + the every-dollar audit.
//
// Conditional fee = "if you don't do X (or do X), then $Y" — carpet
// cleaning at move-out is the canonical case. Detection is sentence-
// scoped: split the joined body text into clause-sized chunks, then
// match chunks that contain BOTH a dollar amount AND conditional/
// obligation language. The matched chunk (trimmed) becomes
// condition_text verbatim — lease-is-law, the clause IS the authority.
//
// The audit (auditUnattributedAmounts) is the safety net for "the
// parser must handle every financial liability": every $ amount in the
// document that is not attributable to a known extraction (rent,
// deposit, late fee, a detected conditional fee, …) surfaces as a
// confirm-severity flag with the surrounding clause, so nothing
// financial slips through silently.
// ---------------------------------------------------------------------

import type { ParserExtractedConditionalFee } from '@gam/shared'

/** Joined body text of all pages (audit-trail pages excluded by caller). */
function joinedText(pages: Page[]): string {
  return pages.flatMap(p => p.items).map(i => i.text).join(' ')
}

/** Split prose into clause-sized chunks. PDF text has no layout left, so
 * split on sentence enders; cap chunk length so a run-on paragraph can't
 * swallow the whole page. */
function clauseChunks(text: string): string[] {
  const rough = text.split(/(?<=[.;])\s+(?=[A-Z(])/)
  const out: string[] = []
  for (const r of rough) {
    if (r.length <= 400) { out.push(r); continue }
    // Over-long run-on: sub-split on commas near the cap.
    let rest = r
    while (rest.length > 400) {
      const cut = rest.lastIndexOf(',', 400)
      out.push(rest.slice(0, cut > 100 ? cut : 400))
      rest = rest.slice(cut > 100 ? cut + 1 : 400)
    }
    if (rest.trim()) out.push(rest)
  }
  return out.map(c => c.trim()).filter(Boolean)
}

/** All dollar amounts in a chunk, pdfjs-split tolerated ("$ 1 50 .00"). */
function dollarAmounts(chunk: string): Array<{ amount: number; raw: string }> {
  const out: Array<{ amount: number; raw: string }> = []
  const re = /\$\s*((?:\d\s*){1,7}(?:,\s*(?:\d\s*){3})*(?:\.\s*(?:\d\s*){1,2})?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chunk)) !== null) {
    const n = coerceCurrency(m[1].replace(/\s+/g, ''))
    if (n !== null && n > 0) out.push({ amount: n, raw: m[0] })
  }
  return out
}

// Obligation/conditional language that turns "$Y in a clause" into a
// conditional fee. Kept broad on purpose; the landlord confirms at review.
const CONDITIONAL_LANGUAGE = [
  /failure to/i,
  /if\s+(?:the\s+)?tenants?\s+(?:do(?:es)?\s+not|fails?\s+to|neglects?\s+to)/i,
  /unless\s+(?:the\s+)?tenants?/i,
  /(?:will|shall|may)\s+(?:be\s+)?(?:charged|assessed|deducted|forfeit(?:ed)?|withheld)/i,
  /(?:charge|fee|penalty)\s+(?:of\s+\$|\s*will|\s*shall|\s*applies)/i,
  /required\s+(?:to|within|before|at)\b[^.]*(?:or|otherwise|else)\b/i,
]

// Chunks that are already handled by dedicated extractors — never
// double-report them as conditional fees or unattributed amounts.
const KNOWN_CHARGE_LANGUAGE = [
  /late\s+(?:charge|fee)/i,
  // Only the labeled DEFINITION ("Security Deposit: …") — conditional
  // clauses legitimately mention "deducted from the security deposit".
  /security\s+deposit\s*:/i,
  /monthly\s+installments/i,
  /per\s+month\s+rent|monthly\s+rent/i,
]

/** Short human label for a conditional clause. */
function conditionLabel(chunk: string): string {
  const c = chunk.toLowerCase()
  if (/carpet/.test(c))                return 'Carpet cleaning'
  if (/smok/.test(c))                  return 'Smoking violation'
  if (/pet|animal/.test(c))            return 'Pet violation'
  if (/key|lock|remote|fob/.test(c))   return 'Keys / locks'
  if (/clean/.test(c))                 return 'Cleaning'
  if (/trash|garbage|debris/.test(c))  return 'Trash removal'
  if (/paint|wall|nail|hole/.test(c))  return 'Wall / paint repair'
  if (/lawn|yard|landscap/.test(c))    return 'Yard upkeep'
  if (/utilit/.test(c))                return 'Utility obligation'
  if (/insur/.test(c))                 return 'Insurance requirement'
  if (/park/.test(c))                  return 'Parking violation'
  return 'Lease condition fee'
}

export function detectConditionalFees(pages: Page[]): ParserExtractedConditionalFee[] {
  const chunks = clauseChunks(joinedText(pages))
  const fees: ParserExtractedConditionalFee[] = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    if (KNOWN_CHARGE_LANGUAGE.some(re => re.test(chunk))) continue
    const amounts = dollarAmounts(chunk)
    if (amounts.length === 0) continue
    const conditional = CONDITIONAL_LANGUAGE.some(re => re.test(chunk))
    if (!conditional) continue
    // The obligation often spans two sentences ("Tenant shall have the
    // carpets professionally cleaned… . Failure to do so will result in a
    // charge of $150.") — pull the PRECEDING clause in for labeling and
    // condition_text when the matched one leans on it ("do so", "such",
    // "the foregoing", or no topical keyword of its own).
    const prev = ci > 0 && !KNOWN_CHARGE_LANGUAGE.some(re => re.test(chunks[ci - 1]))
      ? chunks[ci - 1] : ''
    const needsContext =
      /(?:do so|to do so|such|the foregoing|this requirement|compliance)/i.test(chunk) ||
      conditionLabel(chunk) === 'Lease condition fee'
    const clause = needsContext && prev ? `${prev.slice(-300)} ${chunk}` : chunk
    // One fee per distinct amount in the clause (a clause listing two
    // amounts is two obligations; the landlord prunes at review).
    const seen = new Set<number>()
    for (const a of amounts) {
      if (seen.has(a.amount)) continue
      seen.add(a.amount)
      // Confidence: strong obligation verbs + short clause read best.
      let confidence = 0.75
      if (/failure to|fails? to|do(?:es)? not/i.test(chunk)) confidence += 0.10
      if (chunk.length > 300) confidence -= 0.10
      if (amounts.length > 1) confidence -= 0.10
      fees.push({
        label: conditionLabel(clause),
        amount: a.amount,
        conditionText: clause.slice(0, 500),
        confidence: Math.max(0.40, Math.min(0.90, confidence)),
        rawText: a.raw,
      })
    }
  }
  return fees
}

/**
 * The every-dollar audit: every $ amount in the body that is NOT in the
 * attributed set (rent, deposit, late fee, detected conditional fees, and
 * anything else the caller extracted) comes back with its clause so the
 * parser run can flag it for landlord review.
 */
export function auditUnattributedAmounts(
  pages: Page[],
  attributedAmounts: number[],
): Array<{ amount: number; context: string }> {
  const attributed = new Set(attributedAmounts.map(a => Math.round(a * 100)))
  const chunks = clauseChunks(joinedText(pages))
  const out: Array<{ amount: number; context: string }> = []
  const reported = new Set<number>()
  for (const chunk of chunks) {
    if (KNOWN_CHARGE_LANGUAGE.some(re => re.test(chunk))) continue
    for (const a of dollarAmounts(chunk)) {
      const cents = Math.round(a.amount * 100)
      if (attributed.has(cents) || reported.has(cents)) continue
      reported.add(cents)
      out.push({ amount: a.amount, context: chunk.slice(0, 220) })
    }
  }
  return out
}
