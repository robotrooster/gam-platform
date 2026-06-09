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
  let lateFeeGraceDays: ParserExtractedField<number> | null = null
  const graceMatch = text.match(/by\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)\s+day/i)
  if (graceMatch) {
    const n = parseInt(graceMatch[1], 10)
    if (n >= 0 && n <= 31) lateFeeGraceDays = { value: n, confidence: 0.80, rawText: graceMatch[0] }
  }
  return { lateFeeAmount, lateFeeGraceDays }
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
