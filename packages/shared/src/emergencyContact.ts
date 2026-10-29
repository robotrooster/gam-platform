/**
 * S640 — reading an emergency contact out of a line somebody wrote on a lease.
 *
 * Nic: "I want to do a build on an emergency contact table... one lady, Carine
 * Covarrubius, has her daughter, Irma, as an emergency contact. She didn't put
 * the phone number down. Irma is also a tenant."
 *
 * Thirty-one of these are sitting in signed leases at Mountain View and Oak
 * Park, in a single free-text box, in every shape a person writes one:
 *
 *   Leigh Fisher 520-903-8134      name then number
 *   502 330 3810 Joe Martínez      number then name
 *   Irma Fuentes                   name only — the case Nic described
 *   5208414602                     number only, nobody to ask for
 *   Wife                           a relationship and nothing else
 *   NA / Na / 911                  not a contact at all
 *
 * The job is to get a name and a number out where they exist and to be honest
 * where they do not, because the whole point of this record is that somebody
 * reaches for it on the worst day of a resident's life. A wrong number is worse
 * than a blank one: a blank prompts a question at the counter, a wrong number
 * gets dialed.
 */

export type EmergencyContactQuality = 'complete' | 'name_only' | 'phone_only' | 'unusable'

export interface ParsedEmergencyContact {
  name: string | null
  phone: string | null
  /** What the lease actually said, kept verbatim. Nothing is thrown away. */
  raw: string
  quality: EmergencyContactQuality
  /** Set when the line is only a relationship word ("Wife"), which names nobody. */
  relationship: string | null
}

/** Values people write to mean "I am not giving you one". */
const NOT_A_CONTACT = new Set([
  'na', 'n/a', 'n.a.', 'none', 'no', 'nobody', 'n/a.', '-', '--', 'x',
  'unknown', 'unk', 'tbd', 'same', 'self', 'me', 'n a',
  // Somebody wrote 911. It is not a contact and must never be dialed as one.
  '911', '999', '112',
])

/**
 * Relationship words that turn up ALONE in the box. They tell us something —
 * keep them — but they are not a person we can reach.
 */
const RELATIONSHIP_ONLY = new Set([
  'wife', 'husband', 'spouse', 'partner', 'mother', 'mom', 'father', 'dad',
  'son', 'daughter', 'sister', 'brother', 'friend', 'neighbor', 'neighbor',
  'aunt', 'uncle', 'cousin', 'grandmother', 'grandfather', 'boyfriend',
  'girlfriend', 'fiance', 'fiancee', 'parents', 'family',
])

/**
 * A US phone number as people write it: 10 digits, optionally with a leading 1,
 * in any grouping. Deliberately strict about the COUNT — "520-9002-009" is
 * ten digits oddly grouped and is a real number; "911" is not, and neither is
 * a ZIP or a unit number that happens to be nearby.
 */
function extractPhone(text: string): { phone: string | null; without: string } {
  // Longest digit-ish runs first, so a full number wins over a fragment of it.
  const candidates = [...text.matchAll(/[\d][\d\s().+-]{7,}[\d]/g)]
    .map(m => ({ text: m[0], index: m.index ?? 0 }))
    .sort((a, b) => b.text.length - a.text.length)

  for (const c of candidates) {
    let digits = c.text.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
    if (digits.length !== 10) continue
    // A US number never starts its area code or exchange with 0 or 1.
    if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3))) continue
    const without = (text.slice(0, c.index) + ' ' + text.slice(c.index + c.text.length))
    return { phone: digits, without }
  }
  return { phone: null, without: text }
}

/** Strip the punctuation people trail around a name, keeping letters and marks. */
function cleanName(text: string): string {
  return text
    .replace(/[(),;:|/\\]+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .replace(/^\s*-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseEmergencyContact(raw: string | null | undefined): ParsedEmergencyContact {
  const original = (raw ?? '').toString()
  const trimmed = original.trim()
  const empty: ParsedEmergencyContact = {
    name: null, phone: null, raw: original, quality: 'unusable', relationship: null,
  }
  if (!trimmed) return empty
  if (NOT_A_CONTACT.has(trimmed.toLowerCase().replace(/\s+/g, ' '))) return empty

  const { phone, without } = extractPhone(trimmed)
  const rest = cleanName(without)
  const restLower = rest.toLowerCase()

  // "Wife" on its own: a relationship, nobody to call.
  if (rest && RELATIONSHIP_ONLY.has(restLower)) {
    return {
      name: null, phone, raw: original, relationship: rest,
      quality: phone ? 'phone_only' : 'unusable',
    }
  }

  // A remainder with no letters in it is leftover punctuation or a stray number,
  // never a name.
  const name = /\p{L}/u.test(rest) ? rest : null

  let quality: EmergencyContactQuality
  if (name && phone) quality = 'complete'
  else if (name) quality = 'name_only'
  else if (phone) quality = 'phone_only'
  else quality = 'unusable'

  return { name, phone, raw: original, quality, relationship: null }
}

/**
 * Display form for a stored US number: (520) 903-8134.
 *
 * 10/24 (Nic): "I would also like the phone number field to be correctly
 * formatted for phone numbers. I don't want to have to type dashes or
 * parentheses on everything. Let's get it all uniform." This is the ONE
 * formatter — see typingPhone below for the as-you-type half of it.
 *
 * 10/24 fix: an eleven-digit number that leads with the US country code used to
 * fall straight through and display as 16025550199, because the length test
 * demanded exactly ten. Numbers reach GAM both ways — somebody types
 * +1 (602) 555-0199 into a form, an import carries a leading 1 — so the 1 comes
 * off first. Anything that is still not a US number is handed back untouched
 * rather than mangled into a shape it is not.
 */
export function formatPhone(digits: string | null | undefined): string | null {
  const d = usDigits(digits)
  if (!d) return digits ?? null
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** The ten digits of a US number, or null when it is not one. */
export function usDigits(value: string | null | undefined): string | null {
  const d = (value ?? '').replace(/\D/g, '')
  if (d.length === 10) return d
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return null
}

/**
 * Format a phone field WHILE somebody types it, and stop at the real length.
 *
 * Lifted out of OnboardingPage (S-era "I don't want to type in fifty freaking
 * numbers"), where it was a private copy, so the reservation form and every
 * other phone field get the identical behaviour instead of a third version of
 * it. Digits only: the parentheses, the space and the dash appear as the
 * landlord types, and an eleventh digit cannot be entered.
 */
export function typingPhone(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '').replace(/^1(?=\d{10})/, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/**
 * Are these two names plausibly the same person? Used to offer a phone number
 * from somebody already in the system — Coreen Covarrubias wrote "Irma Fuentes"
 * and Irma is a tenant here with a number on file.
 *
 * Deliberately strict: first AND last must both match, case and accents
 * normalized. A suggestion is shown to staff for confirmation and never
 * applied on its own, but a loose match would put a stranger's number in front
 * of somebody as though it were checked.
 */
export function namesLikelySamePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const pa = norm(a).split(' ').filter(Boolean)
  const pb = norm(b).split(' ').filter(Boolean)
  if (pa.length < 2 || pb.length < 2) return false
  return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1]
}
