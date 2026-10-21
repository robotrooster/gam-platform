/**
 * 10/20 (Nic) — READING ANOTHER PARK SYSTEM'S SCHEDULE EXPORT.
 *
 *   "The file importer gets all my other reservations in there that were booked
 *    first. That's what I said. The old system has all the ones that have
 *    already booked."
 *
 * This is the column half of that: turn whatever the old system called its
 * columns into the handful of things GAM needs to put a reservation on the
 * board. It is the same shape as the three importers already here
 * (lib/csvImportMappings): per-field alias lists, a case- and
 * whitespace-insensitive match, and every column we do NOT recognize kept under
 * `_extra` rather than silently dropped.
 *
 * BE GENEROUS, AND SAY WHAT YOU COULD NOT READ. This file is not a GAM
 * template — it is an export out of somebody else's park-management software,
 * and Nic has a season of arrivals in it. Refusing the file because a column is
 * called "Arrive" instead of "Check In" would leave him typing 150 rows by
 * hand. So: read everything that can be read, and report the rest on the
 * preview screen where he can look at it.
 *
 * A PARK EXPORT IS NOT A SPREADSHEET OF ONE SHAPE. Dates come out as
 * 03/06/2027, 2027-03-06, "Mar 6, 2027", 3/6/27, and — when somebody has opened
 * the file in Excel and saved it again — as 46457. All of those are read here,
 * in one place, so the preview and the commit can never disagree about what day
 * a guest arrives.
 */

/** The fields GAM can put on a reservation. Everything else rides in `_extra`. */
export const RESERVATION_CANONICAL_HEADERS = [
  'guest_name', 'first_name', 'last_name', 'email', 'phone',
  'property_name', 'unit_number',
  'check_in', 'check_out', 'nights',
  'total_amount', 'deposit_paid', 'external_ref', 'notes',
] as const

export type ReservationCanonicalHeader = typeof RESERVATION_CANONICAL_HEADERS[number]

/**
 * What each field may be called in the file. Lower-cased and trimmed before
 * matching, so "CHECK-IN" and "Check-In " both land.
 *
 * The site/space column has the longest list on purpose: it is the one that
 * decides whether a guest keeps the space they were promised, and every park
 * system in the world has its own word for it (site, space, lot, pad, slip).
 */
const ALIASES: Record<ReservationCanonicalHeader, readonly string[]> = {
  // One combined name is the NATIVE shape here — unit_bookings carries a single
  // guest_name — so it is listed first and split names are the fallback.
  guest_name: [
    'guest_name', 'guest', 'guest name', 'guests', 'guest(s)', 'name', 'full name',
    'customer', 'customer name', 'client', 'client name', 'occupant', 'tenant',
    'tenant name', 'primary guest', 'reservation name', 'party', 'party name',
    'registered to', 'reserved for', 'last, first',
  ],
  // 10/21: 'first names' PLURAL is Campground Master's own header — it holds
  // "John & Colleen" — and without it every row in Nic's file imported as a
  // surname with no first name.
  first_name: [
    'first_name', 'first name', 'first names', 'first name(s)', 'firstname',
    'first', 'given name', 'given names',
  ],
  last_name:  ['last_name', 'last name', 'last names', 'lastname', 'last', 'surname', 'family name'],
  email: [
    'email', 'e-mail', 'email address', 'e-mail address', 'guest email',
    'customer email', 'emails', 'primary email', 'contact email',
  ],
  phone: [
    'phone', 'phone number', 'phone #', 'telephone', 'mobile', 'mobile phone',
    'cell', 'cell phone', 'cellular', 'primary phone', 'guest phone',
    'contact phone', 'home phone', 'phone numbers',
    // 10/21: Campground Master numbers its phone columns. They are listed in
    // order, and the first column with something in it wins (see
    // applyReservationMapping), so a customer with only a second number keeps
    // it instead of coming in with none.
    'phone 1', 'phone1', 'phone #1', 'phone # 1',
    'phone 2', 'phone2', 'phone #2', 'phone # 2',
    'phone 3', 'phone3', 'phone #3', 'phone # 3',
  ],
  property_name: [
    'property_name', 'property', 'property name', 'park', 'park name', 'resort',
    'resort name', 'campground', 'community', 'location', 'site location',
  ],
  unit_number: [
    'unit_number', 'unit', 'unit #', 'unit number', 'unit no', 'site', 'site #',
    'site no', 'site number', 'site name', 'site id', 'space', 'space #',
    'space no', 'space number', 'lot', 'lot #', 'lot no', 'lot number', 'pad',
    'pad #', 'slip', 'slip #', 'stall', 'stall #', 'spot', 'spot #',
    'assigned site', 'site assigned', 'assigned space', 'assigned unit',
  ],
  check_in: [
    'check_in', 'check in', 'check-in', 'checkin', 'check in date',
    'check-in date', 'arrival', 'arrive', 'arrival date', 'arriving',
    'date in', 'in', 'start', 'start date', 'from', 'from date', 'begin',
    'begin date', 'first night',
  ],
  check_out: [
    'check_out', 'check out', 'check-out', 'checkout', 'check out date',
    'check-out date', 'departure', 'depart', 'departure date', 'departing',
    'date out', 'out', 'end', 'end date', 'to', 'to date', 'thru', 'through',
    // 10/21: INCLUSIVE — see INCLUSIVE_CHECK_OUT below. Campground Master
    // writes "Last Night", the last night slept; check-out is the morning after.
    'last night', 'last night of stay', 'final night', 'last nite',
  ],
  nights: [
    'nights', '# nights', '#nights', 'no of nights', 'number of nights',
    'night count', 'length of stay', 'los', 'days',
  ],
  // DELIBERATELY NOT "balance due" / "amount due" / "balance": in most exports
  // those are what is LEFT after a deposit, and reading one of them as the stay
  // total would understate every prepaid reservation in the file — and the
  // arrival ticket is raised off this figure.
  total_amount: [
    'total_amount', 'total', 'total amount', 'grand total', 'stay total',
    'reservation total', 'total charges', 'total rent', 'rate total',
    'amount', 'charges', 'price', 'total price',
  ],
  deposit_paid: [
    'deposit_paid', 'deposit', 'deposit paid', 'deposit amount',
    'deposit received', 'deposits', 'paid', 'amount paid', 'paid to date',
    'payments', 'prepaid', 'prepayment', 'received',
  ],
  external_ref: [
    'external_ref', 'reservation #', 'reservation no', 'reservation number',
    'reservation id', 'res #', 'res no', 'res id', 'confirmation #',
    'confirmation no', 'confirmation number', 'confirmation code', 'booking #',
    'booking no', 'booking number', 'booking id', 'id', 'ref', 'reference',
    'reference #',
    // 10/21: Campground Master's own, with the period. This is what lets a row
    // be matched back to the old system and a re-run know it has seen it.
    'confirm. #', 'confirm #', 'confirm. no', 'confirm no', 'conf #', 'conf. #',
    'confirmation', 'confirm', 'confirmation code #',
  ],
  notes: [
    'notes', 'note', 'comment', 'comments', 'memo', 'remarks', 'special requests',
    'requests', 'details',
  ],
}

/** Columns we know are noise in a reservation export, dropped without a word. */
const NOISE: readonly string[] = [
  'status', 'reservation status', 'booking status', 'created', 'created on',
  'created date', 'date created', 'booked on', 'booked date', 'modified',
  'last modified', 'updated', 'source', 'channel', 'balance', 'balance due',
  'amount due', 'due', 'outstanding',
]

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

const ALIAS_TO_CANONICAL: Map<string, ReservationCanonicalHeader> = (() => {
  const m = new Map<string, ReservationCanonicalHeader>()
  for (const canonical of RESERVATION_CANONICAL_HEADERS) {
    for (const alias of ALIASES[canonical]) {
      const key = norm(alias)
      if (!m.has(key)) m.set(key, canonical)
    }
  }
  return m
})()

const NOISE_SET = new Set(NOISE.map(norm))

/** Every column name this importer recognizes, for the "what we read" panel. */
export function reservationColumnsAccepted(): { field: ReservationCanonicalHeader; names: readonly string[] }[] {
  return RESERVATION_CANONICAL_HEADERS.map(field => ({ field, names: ALIASES[field] }))
}

/**
 * Rewrite one file's rows to GAM's field names. Unrecognized columns are kept
 * verbatim (original-case header) under `_extra`, which the commit writes to
 * unit_bookings.import_extra_data — the same bargain the other three importers
 * strike, so a column we did not understand is still in the row somebody can
 * look at afterwards.
 */
/**
 * 10/21 — COLUMNS THAT NAME THE LAST NIGHT, NOT THE DAY THEY LEAVE.
 *
 * Campground Master's export is "First Night" and "LAST NIGHT". The last night
 * is the last one slept on the site; the guest leaves the MORNING AFTER, and
 * check-out in GAM is the day they go (a stay Oct 17 → Oct 24 is seven nights,
 * 17th through 23rd). Read straight across, every reservation in Nic's season
 * would come in a night short — and a 30-night month would read as 29, which
 * also flips the kind of stay it is (leaseTypeForNights), what rate has to
 * exist for it, and what the arrival ticket asks for.
 *
 * So a check-out that came out of one of THESE columns is moved on a day.
 * Only labels that unambiguously name a NIGHT are in here: "thru" and
 * "through" are left alone, because half the park systems in the world mean
 * the departure day by them and the other half mean the last night, and
 * guessing on an ambiguous label is worse than reading it as written.
 */
const INCLUSIVE_CHECK_OUT = new Set(['last night', 'last night of stay', 'final night', 'last nite'])

export function applyReservationMapping(records: Record<string, any>[]): Record<string, any>[] {
  return records.map(rec => {
    const out: Record<string, any> = {}
    const extra: Record<string, any> = {}
    let checkOutWasInclusive = false
    for (const [key, val] of Object.entries(rec)) {
      const canonical = ALIAS_TO_CANONICAL.get(norm(key))
      if (canonical) {
        // First recognized column wins: an export with both "Site" and
        // "Assigned Site" keeps the one that came first in the file.
        if (out[canonical] === undefined || out[canonical] === '') {
          out[canonical] = val
          if (canonical === 'check_out') checkOutWasInclusive = INCLUSIVE_CHECK_OUT.has(norm(key))
        }
      } else if (!NOISE_SET.has(norm(key))) {
        extra[key] = val
      }
    }
    // The day after the last night is the day they leave. Done here, on the
    // mapped value, so the preview and the commit can never disagree about it.
    if (checkOutWasInclusive) {
      const night = parseStayDate(out.check_out)
      if (night) out.check_out = addDay(night)
    }
    if (Object.keys(extra).length > 0) out._extra = extra
    return out
  })
}

/** One day on from 'YYYY-MM-DD'. */
function addDay(ymd: string): string {
  const at = new Date(`${ymd}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + 1)
  return at.toISOString().slice(0, 10)
}

// ── DATES ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

const pad = (n: number) => String(n).padStart(2, '0')

function realDate(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
  const at = new Date(Date.UTC(y, m - 1, d))
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/** 27 → 2027, 98 → 1998. The pivot every spreadsheet uses. */
const fullYear = (raw: number) => raw >= 100 ? raw : raw < 70 ? 2000 + raw : 1900 + raw

/**
 * One date out of a file, as YYYY-MM-DD, or null when it cannot be read.
 *
 * AMBIGUOUS SLASH DATES ARE READ AMERICAN. 03/06/2027 is March 6th, because
 * these are American parks and every system Nic could be exporting from writes
 * them that way. The preview says so on the screen rather than leaving it to be
 * discovered by a guest arriving three months early.
 */
export function parseStayDate(raw: unknown): string | null {
  if (raw == null) return null
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null
      : realDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate())
  }
  const s = String(raw).trim()
  if (!s) return null

  // ISO, with or without a time on the end: 2027-03-06, 2027/03/06, 2027-03-06T00:00:00Z
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/)
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  // American: 3/6/2027, 03-06-27, 3.6.2027, with an optional time.
  const us = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ].*)?$/)
  if (us) return realDate(fullYear(Number(us[3])), Number(us[1]), Number(us[2]))

  // Month by name: "Mar 6, 2027", "March 6 2027", "6 Mar 2027", "Mar 6" is refused
  // (a year we had to guess is a year we got wrong).
  const mdy = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/)
  if (mdy) {
    const m = MONTHS[mdy[1].toLowerCase()]
    if (m) return realDate(fullYear(Number(mdy[3])), m, Number(mdy[2]))
  }
  const dmy = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/)
  if (dmy) {
    const m = MONTHS[dmy[2].toLowerCase()]
    if (m) return realDate(fullYear(Number(dmy[3])), m, Number(dmy[1]))
  }

  // An Excel serial. A file that has been opened and re-saved in Excel loses its
  // date formatting and comes out as a day count from 1899-12-30. Bounded to
  // 1990-2090 so a reservation number or a dollar figure can never be read as a
  // date by accident.
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s)
    if (serial >= 32874 && serial <= 69400) {
      const at = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      return realDate(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate())
    }
  }
  return null
}

/** True when a date could be read two ways and we chose the American one. */
export function dateIsAmbiguous(raw: unknown): boolean {
  const s = String(raw ?? '').trim()
  const us = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ].*)?$/)
  if (!us) return false
  const a = Number(us[1]), b = Number(us[2])
  return a >= 1 && a <= 12 && b >= 1 && b <= 12 && a !== b
}

// ── MONEY, NIGHTS, NAMES ─────────────────────────────────────────────────────

/**
 * A dollar figure out of a file: "$1,234.50", "1234.5", "(45.00)" (negative, as
 * accounting exports write it), "" → null. `NaN`-shaped input returns undefined
 * so a caller can tell "the cell was empty" from "the cell said something we
 * could not read" — the difference between a warning and a blocker when the
 * cell is a deposit somebody actually paid.
 */
export function parseMoney(raw: unknown): number | null | undefined {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s || s === '-' || s === '—') return null
  const negative = /^\(.*\)$/.test(s)
  const cleaned = s.replace(/[()$,\s]/g, '').replace(/^USD/i, '')
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return undefined
  const n = Number(cleaned) * (negative ? -1 : 1)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * 100) / 100
}

/** Words that mean "yes, a deposit was paid" without saying how much. */
const AFFIRMATIVE = new Set(['y', 'yes', 'true', 't', 'paid', 'x', 'deposit paid', 'paid in full'])

export function meansPaidWithoutAnAmount(raw: unknown): boolean {
  return AFFIRMATIVE.has(String(raw ?? '').trim().toLowerCase())
}

export function parseNights(raw: unknown): number | null | undefined {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  if (!/^\d{1,4}$/.test(s)) return undefined
  const n = Number(s)
  return n > 0 ? n : undefined
}

/**
 * The guest's name as one string, from whichever columns the file had.
 * "Carter, Dale" is turned round — an export sorted by surname writes it that
 * way and a guest called "Carter, Dale" on the board is a guest nobody can find.
 */
export function guestNameFrom(row: { guest_name?: any; first_name?: any; last_name?: any }): string {
  const combined = String(row.guest_name ?? '').trim()
  if (combined) {
    const m = combined.match(/^([^,]+),\s*(.+)$/)
    return m ? `${m[2].trim()} ${m[1].trim()}`.replace(/\s+/g, ' ') : combined.replace(/\s+/g, ' ')
  }
  return `${String(row.first_name ?? '').trim()} ${String(row.last_name ?? '').trim()}`.trim().replace(/\s+/g, ' ')
}

/**
 * THE IDENTITY OF A ROW IN ITS SOURCE — the one definition, used by the preview
 * (to say "already brought in") and by the commit (ON CONFLICT DO NOTHING).
 *
 * The old system's own reservation number when the file carries one: that is
 * what it means by "this reservation". Otherwise the guest and their dates at
 * that park, because the same guest cannot have two different reservations for
 * the same nights at the same park — that is one reservation, written down
 * twice.
 *
 * Scoped to the property, always: two parks exported out of the same software
 * can hand out the same reservation numbers, and site 14 at Mountain View is
 * nothing to do with site 14 at Oak Park.
 */
export function migrationKey(args: {
  propertyId: string
  externalRef?: string | null
  guestName: string
  checkIn: string
  checkOut: string
}): string {
  const ref = String(args.externalRef ?? '').trim()
  if (ref) return `${args.propertyId}:ref:${ref.toLowerCase()}`
  const name = args.guestName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  return `${args.propertyId}:stay:${name}:${args.checkIn}:${args.checkOut}`
}

/**
 * GAM's own template, for a landlord with nothing to export — the header row
 * plus one filled-in example, the same as the other importers' templates.
 */
export function buildReservationTemplateCsv(): string {
  const header = [
    'guest_name', 'email', 'phone', 'unit_number', 'check_in', 'check_out',
    'total_amount', 'deposit_paid', 'external_ref', 'notes',
  ]
  const example = [
    'Dale Carter', 'dale@example.com', '520-555-0110', 'RV 14', '2027-03-06',
    '2027-03-13', '286.75', '28.68', 'RES-10421', 'Promised site 14 on the phone',
  ]
  return `${header.join(',')}\n${example.join(',')}\n`
}
