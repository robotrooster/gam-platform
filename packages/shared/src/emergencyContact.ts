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
 * gets dialled.
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
  // Somebody wrote 911. It is not a contact and must never be dialled as one.
  '911', '999', '112',
])

/**
 * Relationship words that turn up ALONE in the box. They tell us something —
 * keep them — but they are not a person we can reach.
 */
const RELATIONSHIP_ONLY = new Set([
  'wife', 'husband', 'spouse', 'partner', 'mother', 'mom', 'father', 'dad',
  'son', 'daughter', 'sister', 'brother', 'friend', 'neighbor', 'neighbour',
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

/** Display form for a stored 10-digit number. */
export function formatPhone(digits: string | null | undefined): string | null {
  const d = (digits ?? '').replace(/\D/g, '')
  if (d.length !== 10) return digits ?? null
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/**
 * Are these two names plausibly the same person? Used to offer a phone number
 * from somebody already in the system — Coreen Covarrubias wrote "Irma Fuentes"
 * and Irma is a tenant here with a number on file.
 *
 * Deliberately strict: first AND last must both match, case and accents
 * normalised. A suggestion is shown to staff for confirmation and never
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
