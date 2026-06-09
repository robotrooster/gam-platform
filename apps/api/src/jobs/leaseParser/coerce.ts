// apps/api/src/jobs/leaseParser/coerce.ts
//
// Type coercion for parser-extracted strings. Each function takes the
// raw extracted string and returns a typed value (or null if the input
// can't be coerced cleanly). Coerce failures drive confidence scoring
// downward, and the field is omitted from ParserOutput rather than
// emitted as a junk value.

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03',     april:    '04',
  may:      '05', june:     '06', july:  '07',     august:   '08',
  september:'09', october:  '10', november: '11',  december: '12',
  jan: '01', feb: '02', mar: '03', apr:  '04',
  jun: '06', jul: '07', aug: '08', sep:  '09',
  sept:'09', oct: '10', nov: '11', dec:  '12',
}

/**
 * Strip non-digits, accept 10 or 11 digits. Returns 10-digit string or null.
 */
export function coercePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return null
}

/**
 * "MM/DD/YYYY" or "M/D/YYYY" -> "YYYY-MM-DD" ISO date.
 * Returns null for invalid month/day or out-of-range years.
 */
export function coerceDateMDY(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const mo = parseInt(m[1], 10)
  const d  = parseInt(m[2], 10)
  const y  = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/**
 * "1st May 2024" / "May 1, 2024" / "May 1st, 2024" -> ISO date.
 * Falls through to coerceDateMDY for slash-separated input.
 */
export function coerceDateFromText(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/(\d+)(?:st|nd|rd|th)/g, '$1')
  // Day Month Year: "1 may 2024"
  const m1 = t.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/)
  if (m1) {
    const mo = MONTHS[m1[2]]
    if (mo) return `${m1[3]}-${mo}-${m1[1].padStart(2, '0')}`
  }
  // Month Day Year: "may 1 2024" or "may 1, 2024"
  const m2 = t.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m2) {
    const mo = MONTHS[m2[1]]
    if (mo) return `${m2[3]}-${mo}-${m2[2].padStart(2, '0')}`
  }
  return coerceDateMDY(raw)
}

/**
 * "$1,234.56" / "1234.56" / "350.00" -> numeric. "N/A" -> null.
 * Rejects negative or implausibly-large amounts.
 */
export function coerceCurrency(raw: string): number | null {
  const t = raw.trim()
  if (/^N\/A$/i.test(t)) return null
  const cleaned = t.replace(/[$,\s]/g, '')
  const n = parseFloat(cleaned)
  if (isNaN(n) || n < 0 || n > 1_000_000) return null
  return Math.round(n * 100) / 100
}

/**
 * Integer-only. "N/A" returns null. Negative returns null.
 */
export function coerceInt(raw: string): number | null {
  const t = raw.trim()
  if (/^N\/A$/i.test(t)) return null
  if (!/^\d+$/.test(t)) return null
  const n = parseInt(t, 10)
  return n >= 0 ? n : null
}

/**
 * "1 Year" -> 12, "6 Months" -> 6, "2 yrs" -> 24. Used for lease term.
 */
export function coerceTermInMonths(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*(years?|yrs?|months?|mos?)\b/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return /year|yr/.test(m[2]) ? n * 12 : n
}

/**
 * Split "First Middle Last" into firstName + lastName.
 * Single-word names go into firstName with empty lastName.
 */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName:  parts[parts.length - 1],
  }
}

/**
 * "Kevin Black 303-949-2683" -> { name, phone }.
 * Phone is the trailing run that coerces to 10 digits; everything else is name.
 */
export function splitNameAndPhone(raw: string): { name: string; phone: string | null } {
  const t = raw.trim()
  // Find a phone-shaped trailing token
  const m = t.match(/^(.*?)\s*([\d\s\-().]{10,})\s*$/)
  if (m) {
    const phone = coercePhone(m[2])
    if (phone) return { name: m[1].trim(), phone }
  }
  return { name: t, phone: null }
}

/**
 * Pass-through trim. For free-text fields where any non-empty value is acceptable.
 */
export function coerceText(raw: string): string | null {
  const t = raw.trim()
  return t.length > 0 ? t : null
}

/**
 * "N/A" -> null, otherwise pass-through trim. Used for fields where
 * "N/A" is a legitimate landlord-supplied "no value" answer (e.g.
 * insurance carrier on a no-insurance lease).
 */
export function coerceTextOrNA(raw: string): string | null {
  const t = raw.trim()
  if (/^N\/A$/i.test(t)) return null
  return t.length > 0 ? t : null
}
