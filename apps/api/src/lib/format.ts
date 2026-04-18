// Backend formatters for landlord-entered text.
// Save-quietly philosophy: fix user input before storage, no UX complaint.
// Separate concern from normalizeAddress (which produces match keys).

const US_STATES: Record<string,string> = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',
  connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',
  hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',
  louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',
  mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',
  ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',
  washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY',
  'puerto rico':'PR','virgin islands':'VI',guam:'GU','american samoa':'AS','northern mariana islands':'MP',
}

const DIRECTIONS_UPPER = new Set(['n','s','e','w','ne','nw','se','sw','nne','ene','ese','sse','ssw','wsw','wnw','nnw'])
const STREET_TYPES = new Set(['st','ave','rd','dr','blvd','ln','ct','pl','ter','pkwy','hwy','cir','way','trl','sq','loop','row','walk','plaza','alley','bend','crossing','expressway','freeway','grove','harbor','heights','hollow','island','junction','key','landing','park','pass','path','pike','point','ridge','run','spring','summit','valley','view','vista'])
const SMALL_WORDS = new Set(['of','the','and','at','for','in','on','to','a','an'])

// Acronyms that stay UPPERCASE anywhere they appear (unit numbers, property names, etc.)
const ACRONYMS = new Set(['rv','mh','stg','hoa','adu','str','ltr','mfr','sfr','sro','hvac','adus','eps','esa','pud','adr','ada','fha','usda','llc','po','us','usa','dba'])

// Title-case a single word, with Mc/Mac/O' handling.
function titleWord(w: string, isFirst: boolean, isLast: boolean): string {
  if (!w) return w

  // Hyphenated compound (e.g. "Mixed-Use", "Mini-Warehouses") — recurse on each part
  if (w.includes('-')) {
    return w.split('-').map((part, i, arr) => titleWord(part, isFirst && i === 0, isLast && i === arr.length - 1)).join('-')
  }

  const lower = w.toLowerCase()

  // Acronyms stay uppercase (RV, STR, SFR, LLC, HOA, etc.)
  if (ACRONYMS.has(lower)) return w.toUpperCase()

  // Preserve small words (but not first or last)
  if (!isFirst && !isLast && SMALL_WORDS.has(lower)) return lower

  // All-digit token — leave untouched
  if (/^\d+$/.test(w)) return w

  // Mixed alphanumeric like "4B" or "101A" — uppercase the letters
  if (/^[0-9]+[a-z]+$/i.test(w)) return w.toUpperCase()
  if (/^[a-z]+[0-9]+$/i.test(w)) {
    const m = w.match(/^([a-z]+)([0-9]+)$/i)!
    return cap(m[1]) + m[2]
  }

  // Ordinals: 1st, 2nd, 42nd, 101st
  if (/^\d+(st|nd|rd|th)$/i.test(w)) return w.toLowerCase()

  // Roman numerals (II, III, IV, …) — ALL UPPER
  if (/^(i{1,3}|iv|v|vi{0,3}|ix|x{1,3})$/i.test(w)) return w.toUpperCase()

  // O'Brien, D'Angelo
  if (/^[a-z]'[a-z]/i.test(w)) {
    const [a,b] = w.split("'")
    return cap(a) + "'" + cap(b)
  }

  // Mc — McDonald, McKinley
  if (/^mc[a-z]{2,}/i.test(w)) return 'Mc' + cap(w.slice(2))

  // Mac — MacArthur, MacDonald. Require len ≥ 6 to avoid macon, macey.
  if (w.length >= 6 && /^mac[bcdfghjklmnpqrstvwxz]/i.test(w)) return 'Mac' + cap(w.slice(3))

  return cap(w)
}

function cap(w: string): string {
  if (!w) return w
  return w[0].toUpperCase() + w.slice(1).toLowerCase()
}

// Title-case a phrase (person name, property name, city, street).
// Applies Mc/Mac/O' and small-word rules. Directions/street-types NOT forced here.
function titlePhrase(phrase: string): string {
  if (!phrase) return phrase
  const words = phrase.trim().replace(/\s+/g,' ').split(' ')
  return words.map((w, i) => titleWord(w, i === 0, i === words.length - 1)).join(' ')
}

export function formatName(s: string): string {
  return titlePhrase(s || '')
}

export function formatCity(s: string): string {
  return titlePhrase(s || '')
}

export function formatState(s: string): string {
  if (!s) return s
  const t = s.trim()
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  const lookup = US_STATES[t.toLowerCase()]
  return lookup || t.toUpperCase()
}

export function formatZip(s: string): string {
  if (!s) return s
  const digits = s.replace(/[^0-9]/g,'')
  if (digits.length === 9) return `${digits.slice(0,5)}-${digits.slice(5)}`
  return digits.slice(0,5)
}

// Street address: title-case words, but force directions uppercase and street types to canonical abbrev.
export function formatStreet(s: string): string {
  if (!s) return s
  const cleaned = s.trim().replace(/\s+/g,' ').replace(/\./g,'')
  const words = cleaned.split(' ')
  return words.map((w, i) => {
    const lower = w.toLowerCase()
    if (DIRECTIONS_UPPER.has(lower)) return lower.toUpperCase()
    if (STREET_TYPES.has(lower))     return cap(lower) // "St", "Blvd"
    return titleWord(w, i === 0, i === words.length - 1)
  }).join(' ')
}

// Suite / Unit / Lot line — title case, keep short abbreviations uppercase
export function formatStreet2(s: string): string {
  if (!s) return s
  const cleaned = s.trim().replace(/\s+/g,' ')
  if (!cleaned) return ''
  return cleaned.split(' ').map((w, i, arr) => {
    const lower = w.toLowerCase()
    // "Apt", "Ste", "Unit", "Bldg", "Fl", "Lot" — cap
    if (['apt','ste','suite','unit','bldg','fl','lot','rm','room','floor'].includes(lower)) return cap(lower)
    return titleWord(w, i === 0, i === arr.length - 1)
  }).join(' ')
}

// Unit number: split trailing letter-run from trailing digit-run for searchability.
// Rules:
//   "storage1"   -> "Storage 01"   (alphabet followed by digits: split + zero-pad digits to min 2)
//   "storage15"  -> "Storage 15"
//   "storage150" -> "Storage 150"
//   "1"          -> "01"           (bare digits: pad to 2)
//   "15"         -> "15"
//   "150"        -> "150"
//   "1a"         -> "1A"           (digits first then letters: keep tight, uppercase letters)
//   "a101"       -> "A 101"        (letters then digits: split; 3+ digits don't pad)
//   "apt 4b"     -> "Apt 4B"       (spaces preserved, letters capitalized)
//   "studio"     -> "Studio"
export function formatUnitNumber(s: string): string {
  if (!s) return s
  const raw = s.trim().replace(/\s+/g,' ')
  if (!raw) return ''

  // If contains spaces already, format each token then rejoin
  if (raw.includes(' ')) {
    return raw.split(' ').map(tok => formatUnitNumber(tok)).join(' ')
  }

  // Pure digits — zero-pad to 2
  if (/^\d+$/.test(raw)) {
    return raw.length < 2 ? raw.padStart(2, '0') : raw
  }

  // Pure letters — title case
  if (/^[a-zA-Z]+$/.test(raw)) {
    return cap(raw)
  }

  // Digits followed by letters (e.g. "1a") — keep tight, uppercase letters
  if (/^\d+[a-zA-Z]+$/.test(raw)) {
    return raw.toUpperCase().replace(/^(\d+)([A-Z]+)$/, (_m, d, l) => d + l)
  }

  // Letters followed by digits (e.g. "storage1", "a101", "rv1") — split with space, pad digits
  const m = raw.match(/^([a-zA-Z]+)(\d+)$/)
  if (m) {
    const [, letters, digits] = m
    const padded = digits.length < 2 ? digits.padStart(2,'0') : digits
    const pfx = ACRONYMS.has(letters.toLowerCase()) ? letters.toUpperCase() : cap(letters)
    return pfx + ' ' + padded
  }

  // Letters-hyphen-digits style (e.g. "RV-01", "APT-12", "1A-05") — convert to space, pad digits
  const h = raw.match(/^([a-zA-Z0-9]+)-(\d+)$/)
  if (h) {
    const [, pfx, digits] = h
    const padded = digits.length < 2 ? digits.padStart(2,'0') : digits
    let cleanPfx: string
    if (/^[a-zA-Z]+$/.test(pfx)) {
      cleanPfx = ACRONYMS.has(pfx.toLowerCase()) ? pfx.toUpperCase() : cap(pfx)
    } else {
      cleanPfx = pfx.toUpperCase()  // alphanumeric like "1A" — uppercase
    }
    return cleanPfx + ' ' + padded
  }

  // Mixed with hyphens, slashes, etc — best-effort uppercase
  return raw.toUpperCase()
}

// Bundle helpers — format a full property payload
export function formatPropertyInput(p: {
  name?: string
  street1?: string
  street2?: string | null
  city?: string
  state?: string
  zip?: string
}): typeof p {
  return {
    ...p,
    ...(p.name    !== undefined ? { name: formatName(p.name) } : {}),
    ...(p.street1 !== undefined ? { street1: formatStreet(p.street1) } : {}),
    ...(p.street2 !== undefined && p.street2 !== null ? { street2: formatStreet2(p.street2) } : {}),
    ...(p.city    !== undefined ? { city: formatCity(p.city) } : {}),
    ...(p.state   !== undefined ? { state: formatState(p.state) } : {}),
    ...(p.zip     !== undefined ? { zip: formatZip(p.zip) } : {}),
  }
}
