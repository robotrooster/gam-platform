/**
 * ── READING A DRIVER'S LICENCE, SCANNED OR TYPED (Nic, 10/29) ───────────────
 *
 *   "A lot of parks will take a copy of the driver's license... we need a way
 *    in real time, somebody just paying for a night. The system has to know
 *    this person has the same name, and it either is or isn't the actual same
 *    person that owes this other debt somewhere else."
 *
 * And on how it gets in: "scan or type. we want flexibility."
 *
 * Both arrive in the SAME box. Every US and Canadian licence carries a PDF417
 * barcode on the back holding the name, birthday, licence number, address and
 * expiry as plain text, and the ordinary desk scanner for them is a USB reader
 * that behaves as a keyboard — it types the whole payload into whatever field
 * has focus and presses Enter. So the desk either scans into the box and every
 * field fills itself, or types the fields by hand. No camera, no hardware
 * integration, no reading software.
 *
 * The payload is the AAMVA standard: a header, then `subfile` records of a
 * three-letter element id followed by its value, one per line. Only the
 * elements that identify a person are read here; the rest are ignored rather
 * than rejected, because versions differ by state and year and a licence that
 * carries something unexpected must still scan.
 *
 * NOTHING HERE IS TRUSTED TO BE A LICENCE. A person can type anything into the
 * box, and a scan from a damaged barcode arrives truncated. `parseIdScan`
 * returns null when it cannot see an AAMVA header, and every field is optional
 * on the way out, so a partial read fills what it found and leaves the desk to
 * type the rest.
 */

/** What a licence tells us about the person holding it. */
export interface ScannedId {
  firstName?: string
  lastName?: string
  middleName?: string
  /** YYYY-MM-DD. */
  dateOfBirth?: string
  /** The licence or state-ID number, as printed. */
  idNumber?: string
  /** Two-letter issuing state or province. */
  issuingState?: string
  /** 'US' or 'CA'. */
  issuingCountry?: string
  /** YYYY-MM-DD. */
  expiryDate?: string
  street?: string
  city?: string
  postalCode?: string
}

/** The AAMVA element ids this reads. Everything else on the card is ignored. */
const ELEMENTS = {
  DAQ: 'idNumber',
  DCS: 'lastName',
  DAC: 'firstName',
  DAD: 'middleName',
  DBB: 'dateOfBirth',
  DBA: 'expiryDate',
  DAG: 'street',
  DAI: 'city',
  DAJ: 'issuingState',
  DAK: 'postalCode',
  DCG: 'issuingCountry',
} as const

/** Day `d` exists in month `m` of year `y` — leap years included. */
export function isRealDay(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (m < 1 || m > 12 || d < 1) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * AAMVA dates are MMDDYYYY in the US and YYYYMMDD in Canada, and the standard
 * does not say which you are holding — the country element does, and it is not
 * always present. Read it by shape instead: a leading value over 1900 can only
 * be a year, because no month is 1901.
 */
function aamvaDate(raw: string): string | undefined {
  const d = raw.replace(/[^0-9]/g, '')
  if (d.length !== 8) return undefined
  const lead = Number(d.slice(0, 4))
  const [y, m, day] = lead > 1900 && lead < 2200
    ? [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)]     // Canada: YYYYMMDD
    : [d.slice(4, 8), d.slice(0, 2), d.slice(2, 4)]     // US:     MMDDYYYY
  const mm = Number(m), dd = Number(day), yy = Number(y)
  if (!(mm >= 1 && mm <= 12) || !(yy >= 1900 && yy <= 2200)) return undefined
  // 10/29 (review): a REAL day of that month, not merely 1-31. A misread that
  // gave 02/31 passed this check and then raised "date/time field value out of
  // range" on the ::date cast downstream — which, inside an open transaction,
  // aborted the whole capture it was meant to improve.
  if (!isRealDay(yy, mm, dd)) return undefined
  return `${y}-${m}-${day}`
}

/** Values arrive padded and sometimes carry a trailing separator. */
const clean = (v: string): string | undefined => {
  const t = v.replace(/[\r\n\u001e\u001c]/g, '').trim()
  return t && t !== 'NONE' && t !== 'UNAVL' ? t : undefined
}

/**
 * Read a scanned licence. Returns null when the text is not an AAMVA payload
 * at all — which is what a person typing their name into the box looks like,
 * and is how the desk form knows to treat it as typing rather than a scan.
 */
export function parseIdScan(raw: string): ScannedId | null {
  const text = String(raw ?? '')
  // The header every AAMVA payload carries. Some readers drop the leading
  // control characters, so the ANSI/AAMVA marker is what is actually required.
  if (!/\b(ANSI|AAMVA)\s*\d{6}/i.test(text)) return null

  const out: ScannedId = {}
  // Elements are a three-letter id then the value, to the end of the line.
  //
  // Only the ids this reads are matched, and a value runs until the NEXT such
  // id or a line break — never "any three capitals", which was the first cut
  // and was wrong twice over. The header carries runs like `...0015DLDAQD12345`
  // where a loose pattern matches the `DLD` straddling the subfile designator
  // and the real `DAQ`, swallowing the licence number into a field that does
  // not exist. Stopping at known ids also means a payload whose line breaks
  // the reader stripped still parses.
  const ids = Object.keys(ELEMENTS).join('|')
  const re = new RegExp(`(${ids})((?:(?!${ids})[^\\r\\n\\u001e\\u001c])*)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const key = (ELEMENTS as Record<string, string | undefined>)[m[1]]
    if (!key) continue
    const value = clean(m[2])
    if (!value) continue
    if (key === 'dateOfBirth' || key === 'expiryDate') {
      const d = aamvaDate(value)
      if (d) (out as any)[key] = d
    } else if (key === 'issuingState') {
      (out as any)[key] = value.slice(0, 2).toUpperCase()
    } else if (key === 'issuingCountry') {
      (out as any)[key] = value.toUpperCase().startsWith('CA') ? 'CA' : 'US'
    } else {
      (out as any)[key] = value
    }
  }
  // A payload with a header and nothing identifying in it is a failed read,
  // not an empty person.
  return out.idNumber || out.lastName || out.dateOfBirth ? out : null
}

/**
 * The form a licence number takes for comparison: case and punctuation vary by
 * who typed it and by state formatting, and two records of one licence must
 * meet. Never shown to anybody — only compared.
 */
export function normalizedIdNumber(v: string | null | undefined): string | null {
  const t = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return t.length >= 4 ? t : null
}
