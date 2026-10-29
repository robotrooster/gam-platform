/**
 * 10/20 (Nic) — THE SAME PERSON, TWICE, AND ONLY THE LANDLORD MAY SAY SO.
 *
 *   "for merging two people, bring it up to the landlord. Say, hey, this looks
 *    like the same person. They have the same name. Same email, or maybe the
 *    email's different, but the phone number's the same. Or maybe the phone
 *    number is off by like 1. Maybe it's a typo. There's a lot of ways to kind
 *    of clarify that. But have it be always have the landlord check that the
 *    customer is the same."
 *
 * WHY NOW. The old system's schedule has just come in from a file and the
 * texted reservations are being typed in behind it (services/reservationImport),
 * so the same guest lands on the board twice inside a week: once as the file
 * spelled him, once as Nic typed him off a phone screen with a digit wrong. Two
 * halves of one man read as two strangers — two balances, two stay chains, and
 * a background check run on somebody who has wintered here for six years.
 *
 * ── IT PROPOSES. IT NEVER MERGES. ───────────────────────────────────────────
 *
 * Nothing in this file decides anybody is the same person. scanForDuplicates()
 * writes questions; mergePeople() runs only when a person has answered one, and
 * it is called from nowhere but the route a landlord clicks. There is no job, no
 * confidence threshold that acts on its own, no "strong matches auto-merge".
 * Being wrong here puts two people's rent history in one pile with no honest
 * way back out, and Nic asked for the opposite of clever: "always have the
 * landlord check".
 *
 * ── A NAME IS NEVER ENOUGH ──────────────────────────────────────────────────
 *
 * Every rule in verdictFor() REQUIRES a name signal and none of them rests on
 * one. Two Smiths at an RV park are two people, and a list that says otherwise
 * is a list Nic stops opening after the third Friday.
 *
 * ── WHAT A MERGE DOES, AND WHAT IT REFUSES TO DO ────────────────────────────
 *
 * GAM joins duplicate accounts by MOVING THE SIGN-IN ADDRESS, not by migrating
 * a lease. tenants(id) is referenced by 56 tables and
 * lease_document_signers.user_id binds an executed lease to the person who
 * signed it — move the lease to another user id and a signed legal document is
 * detached from its signer. Move the address instead and the person sees the
 * identical outcome: one account, the address they use, their lease intact.
 *
 * So the side holding the lease is always the side that survives, both rows
 * stay, and the folded one keeps answering to a name nobody can mail
 * (duplicate-<id>@invalid, RFC 2606) while staying findable by name and phone.
 * When BOTH sides hold a lease the merge is refused in a sentence rather than
 * guessed at: retiring the sign-in of somebody with a live lease locks them out
 * of their own portal.
 *
 * ── AND IT STOPS AT THE EDGE OF THE BOOK THAT ASKED ─────────────────────────
 *
 * users and tenants carry NO landlord column: one person, one sign-in, the
 * whole platform. The same man can be wintering at Nic's park while he is
 * mid-signing a lease with a landlord Nic has never heard of. So every count
 * this file reads and every row it writes is bounded by the asking account:
 *
 *   - "holds a lease or a signature" is read INSIDE this account only. Another
 *     company's paperwork is not Nic's to see and not a merge's to act on.
 *   - the reservations, the balance and the stay chain of THIS account are
 *     joined onto the surviving person.
 *   - THIS account's screening comes across with him, so a check the guest
 *     paid for and passed is not asked for a second time at the gate.
 *   - the folded SIGN-IN is retired, or its address moved, ONLY when this
 *     account's book holds everything that sign-in has. Otherwise both
 *     sign-ins stand untouched and the screen says so.
 *   - nobody is ever suspended. tenants.platform_status is platform-wide:
 *     setting it here told a man signing a lease with a different landlord
 *     that his GAM account was suspended, and shut him out of the portal he
 *     pays his rent in.
 *
 * ── THE GUEST WITH NO ACCOUNT, WHICH IS MOST OF THEM ────────────────────────
 *
 * A reservation brought in from the old system has a name, maybe an email,
 * maybe a phone, and no account at all. There is no person row to point two of
 * them at. What there IS, already: services/stayTerms chains a guest's stays on
 * `tenant_id OR LOWER(guest_email)` — so two reservations sharing an address
 * are already one guest to GAM, and two that do not are not.
 *
 * That is the whole mechanism, so the merge uses it and nothing else:
 *   - guest + account   → the reservations point at the surviving person
 *                         (tenant_id). guest_name/email/phone are left exactly
 *                         as booked; that is what the guest was told.
 *   - guest + guest, one side with an address → the address is written onto the
 *                         reservations that have NONE. Nothing is overwritten,
 *                         the change journal holds the before-image, and the
 *                         chain now reads one guest.
 *   - guest + guest, both with their own address → REFUSED, in a sentence.
 *     Picking one would silently change where a guest's confirmation goes, and
 *     that is a product decision for Nic, not a thing to decide inside a merge.
 *   - guest + guest, neither with an address → REFUSED. There is nothing to
 *     join them on; one of them needs an account first.
 */
import type { PoolClient } from 'pg'
import {
  DUPLICATE_SIGNAL_LABEL, PERSON_SIDE_KIND_LABEL,
  type DuplicateConfidence, type DuplicateSignal, type PersonSideKind,
} from '@gam/shared'
import { getClient, query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
// What counts as a renter-pool check, from the one place that defines it:
// consent_pool plus GAM's own pool account, never another company's check with
// the share box ticked (services/onboardingWindow, S655).
import { pooledCheckSql } from './onboardingWindow'

// ── NORMALIZING A PERSON ─────────────────────────────────────────────────────

/** Accents off, so "Núñez" and "Nunez" are one surname. */
const deaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Suffixes dropped off the END of a name, and only while two tokens remain.
 * "Robert Jenkins Jr" and "Robert Jenkins" are one man in a park office; "John
 * V" on its own is a name with an initial and keeps both tokens.
 */
const NAME_SUFFIXES = new Set(['jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv', 'md', 'dds', 'dvm', 'phd', 'esq'])

export interface NormalizedName {
  /** First token. '' when the name is a single word ("Smith"). */
  first: string
  /** Last token — the surname every rule below agrees on first. */
  last: string
  /** Every token joined by a space, which is the guest identity's group key. */
  whole: string
}

/**
 * A park export's name column is not one shape. "JENKINS, ROBERT", "Robert
 * Jenkins Jr.", "Bob & Jane Jenkins", "O'Brien, R." all arrive, and all of them
 * have to reduce to the same handful of tokens before anything can be compared.
 *
 * A comma means "Last, First" and is swapped — unless the name also carries an
 * "&" or an "and", where the comma is separating PEOPLE ("Smith, Bob and Jane")
 * and swapping it would invent a person called Bob-and-Jane Smith.
 */
export function normalizeName(raw: string | null | undefined): NormalizedName | null {
  if (!raw) return null
  let s = deaccent(String(raw)).toLowerCase()
  const party = /&|\band\b|\+/.test(s)
  if (s.includes(',') && !party) {
    const [lastPart, ...rest] = s.split(',')
    s = `${rest.join(' ')} ${lastPart}`
  }
  // Punctuation INSIDE a name closes up — "o'brien" is "obrien", "smith-jones"
  // is one surname, "r." is "r". Everything else that is not a letter, a digit
  // or a space becomes a gap, because the only reason it is there is to
  // separate ("Smith & Jones", "Bob / Jane").
  let tokens = s.replace(/['’`.\-]+/g, '').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean)
  while (tokens.length > 2 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  if (!tokens.length) return null
  const last = tokens[tokens.length - 1]
  const first = tokens.length > 1 ? tokens[0] : ''
  return { first, last, whole: tokens.join(' ') }
}

/**
 * Phone down to the digits that identify it.
 *
 * A leading 1 on eleven digits is the country code. More than ten digits after
 * that is a cell carrying two numbers in one column ("5551234567 / 5559998888"),
 * which every park export does somewhere: the FIRST is the one the guest gave,
 * so it is the one kept. Under seven digits is not a phone number — a room
 * extension, a fragment — and matching on it would pair strangers.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = String(raw).replace(/\D+/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length > 10) digits = digits.slice(0, 10)
  if (digits.length < 7) return null
  return digits
}

/**
 * Email down to the address that reaches the person.
 *
 * Plus-addressing is stripped everywhere — bob+rv@x.com and bob@x.com are one
 * inbox at every provider that implements it, and park software is exactly
 * where a guest uses one. Dots are stripped ONLY at Gmail, because Gmail
 * ignores them and nobody else does: at most providers bob.smith@ and bobsmith@
 * are two different people.
 */
const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at <= 0 || at === s.length - 1) return null
  let local = s.slice(0, at)
  let domain = s.slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, '')
  if (!local) return null
  return `${local}@${domain}`
}

/**
 * "Off by like 1. Maybe it's a typo." — one substitution, one dropped digit,
 * one extra digit, or two digits swapped. Bounded at one edit on purpose:
 * Damerau-Levenshtein of 2 on a ten-digit number pairs numbers that have
 * nothing to do with each other.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diff: number[] = []
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff.push(i); if (diff.length > 2) return false }
    if (diff.length === 1) return true
    // Two differences are only a typo when they are adjacent and swapped.
    return diff.length === 2 && diff[1] === diff[0] + 1
      && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]
  }
  const long = a.length > b.length ? a : b
  const short = a.length > b.length ? b : a
  let i = 0, j = 0, skipped = false
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true
    i++
  }
  return true
}

// ── WHAT A PERSON LOOKS LIKE TO THE MATCHER ──────────────────────────────────

export interface PersonIdentity {
  /** 'u:<user uuid>' for an account, 'g:<earliest booking uuid>' for a guest. */
  key: string
  kind: PersonSideKind
  userId: string | null
  tenantId: string | null
  /** The guest's earliest reservation — the handle that does not move. */
  bookingId: string | null
  /** Every reservation this guest identity is written on. */
  bookingIds: string[]
  landlordId: string
  displayName: string
  rawEmail: string | null
  rawPhone: string | null
  email: string | null
  phone: string | null
  name: NormalizedName | null
  reservations: number
  leases: number
  signedDocuments: number
  firstSeenAt: string | null
}

/**
 * A name holds a lease or a signature IN THIS ACCOUNT'S BOOK: the side that
 * must survive a merge. Both numbers are gathered scoped to the companies that
 * asked (gatherPeople), so this answers "has business with you", never "has
 * business with somebody on GAM" — which is neither Nic's to know nor a thing
 * his merge may be refused on.
 */
export const holdsTenancy = (p: PersonIdentity): boolean =>
  p.kind === 'account' && (p.leases > 0 || p.signedDocuments > 0)

export interface MatchVerdict {
  signals: DuplicateSignal[]
  confidence: DuplicateConfidence
  score: number
}

type NameMatch = 'exact' | 'weak' | 'none'

/**
 * How close two names are, and nothing more than that.
 *
 * NO NICKNAME TABLE. "Bob" is not a prefix of "Robert" and never will be, and a
 * table that says they are the same man also says Rick is Richard and Peggy is
 * Margaret — right often enough to be trusted and wrong often enough to merge
 * two people. What IS safe is what a text thread actually produces: an initial
 * ("R Jenkins" for Robert Jenkins) and a shortened first name that is still a
 * real prefix ("Rob" for "Robert", three letters or more). Both come back
 * 'weak', which on its own proposes nothing.
 */
export function nameMatch(a: NormalizedName | null, b: NormalizedName | null): NameMatch {
  if (!a || !b) return 'none'
  if (a.last !== b.last) return 'none'
  if (a.first && b.first && a.first === b.first) return 'exact'
  // One side is a surname with nobody in front of it ("Smith"): the most we can
  // say is that the surnames agree.
  if (!a.first || !b.first) return 'weak'
  const [short, long] = a.first.length <= b.first.length ? [a.first, b.first] : [b.first, a.first]
  if (!long.startsWith(short)) return 'none'
  // An initial, or a shortening long enough to mean something. Two letters
  // ("Jo" for Joanne, for John) is a coin toss.
  if (short.length === 1 || short.length >= 3) return 'weak'
  return 'none'
}

/**
 * Nic's three signals, scored, plus the two weak-name shapes a text thread
 * produces. Returns null when there is no question worth asking — which
 * includes every pair whose only agreement is the name.
 */
export function verdictFor(a: PersonIdentity, b: PersonIdentity): MatchVerdict | null {
  const name = nameMatch(a.name, b.name)
  if (name === 'none') return null

  const emailExact = !!a.email && !!b.email && a.email === b.email
  let phone: 'exact' | 'typo' | 'none' = 'none'
  if (a.phone && b.phone) {
    if (a.phone === b.phone) phone = 'exact'
    else if (withinOneEdit(a.phone, b.phone)) phone = 'typo'
  }

  const nameSignal: DuplicateSignal = name === 'exact' ? 'name_exact' : 'name_weak'

  if (name === 'exact' && emailExact && phone === 'exact') {
    return { signals: [nameSignal, 'email_exact', 'phone_exact'], confidence: 'strong', score: 100 }
  }
  if (name === 'exact' && emailExact) {
    return { signals: [nameSignal, 'email_exact'], confidence: 'strong', score: 90 }
  }
  if (name === 'exact' && phone === 'exact') {
    return { signals: [nameSignal, 'phone_exact'], confidence: 'strong', score: 85 }
  }
  if (name === 'exact' && phone === 'typo') {
    return { signals: [nameSignal, 'phone_typo'], confidence: 'likely', score: 65 }
  }
  if (name === 'weak' && emailExact) {
    return { signals: [nameSignal, 'email_exact'], confidence: 'possible', score: 50 }
  }
  if (name === 'weak' && phone === 'exact') {
    return { signals: [nameSignal, 'phone_exact'], confidence: 'possible', score: 45 }
  }
  // Everything left over is a guess: a name on its own, or a near-name beside a
  // near-phone. Neither is worth a landlord's Friday.
  return null
}

// ── GATHERING THE ACCOUNT'S OWN PEOPLE ───────────────────────────────────────

/**
 * Every person in this account's book, from the two kinds of record that hold
 * one. Scoped to the companies passed in and nothing else — one landlord is
 * never shown another's guests, and a merge may only touch rows inside the
 * account that asked for it.
 *
 * A person already folded into somebody else is left out: they are not a
 * separate person any more, and asking about them again is the noise that
 * kills the list. Account losers drop out by user id (which never changes);
 * reservation losers drop out by the stamp the merge left on the booking
 * (unit_bookings.folded_into_person_merge_id), because a guest identity's own
 * shape CHANGES when a merge fills in their address, and a handle derived from
 * that shape would quietly come back as somebody new.
 */
export async function gatherPeople(
  landlordIds: string[],
  q: <T>(sql: string, params: unknown[]) => Promise<T[]> = query,
): Promise<PersonIdentity[]> {
  if (!landlordIds.length) return []
  const home = [...landlordIds].sort()[0]

  const accounts = await q<{
    user_id: string; tenant_id: string; first_name: string; last_name: string
    email: string | null; phone: string | null
    leases: string; reservations: string; signed_documents: string; created_at: Date | null
  }>(
    `WITH mine AS (
        SELECT lt.tenant_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
         WHERE l.landlord_id = ANY($1::uuid[])
        UNION
        SELECT pti.tenant_id FROM pending_tenant_intents pti
         WHERE pti.landlord_id = ANY($1::uuid[]) AND pti.cancelled_at IS NULL
        UNION
        SELECT b.tenant_id FROM unit_bookings b
         WHERE b.landlord_id = ANY($1::uuid[]) AND b.tenant_id IS NOT NULL
     )
     SELECT u.id AS user_id, t.id AS tenant_id, u.first_name, u.last_name, u.email, u.phone,
            u.created_at,
            (SELECT count(*) FROM lease_tenants lt2 JOIN leases l2 ON l2.id = lt2.lease_id
              WHERE lt2.tenant_id = t.id AND l2.landlord_id = ANY($1::uuid[])) AS leases,
            (SELECT count(*) FROM unit_bookings b2
              WHERE b2.tenant_id = t.id AND b2.landlord_id = ANY($1::uuid[])) AS reservations,
            -- 10/20 — THIS ACCOUNT'S PAPERWORK, like the lease count above it.
            -- lease_document_signers has no landlord column, so this counted
            -- every signature the person had ever put on a GAM lease anywhere.
            -- It printed on Nic's screen as "1 signed document" beside "0
            -- leases", which told him a guest of his is somebody else's
            -- resident; and because holdsTenancy() reads it, another company's
            -- paperwork decided which of Nic's merges were allowed. Scoped
            -- through lease_documents, which does carry the company.
            (SELECT count(*) FROM lease_document_signers s
              JOIN lease_documents ld ON ld.id = s.document_id
              WHERE s.user_id = u.id AND s.signed_at IS NOT NULL
                AND ld.landlord_id = ANY($1::uuid[])) AS signed_documents
       FROM tenants t
       JOIN users u ON u.id = t.user_id
      WHERE t.id IN (SELECT tenant_id FROM mine WHERE tenant_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM person_merges pm
                         WHERE pm.landlord_id = ANY($1::uuid[]) AND pm.loser_user_id = u.id)`,
    [landlordIds])

  const people: PersonIdentity[] = accounts.map(r => ({
    key: `u:${r.user_id}`,
    kind: 'account' as const,
    userId: r.user_id,
    tenantId: r.tenant_id,
    bookingId: null,
    bookingIds: [],
    landlordId: home,
    displayName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    rawEmail: r.email,
    rawPhone: r.phone,
    email: normalizeEmail(r.email),
    phone: normalizePhone(r.phone),
    name: normalizeName(`${r.first_name ?? ''} ${r.last_name ?? ''}`),
    reservations: Number(r.reservations ?? 0),
    leases: Number(r.leases ?? 0),
    signedDocuments: Number(r.signed_documents ?? 0),
    firstSeenAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }))

  // A reservation with nobody's account on it. Cancelled and no-show stays are
  // left out: a guest whose only reservation was called off is not a duplicate
  // worth a decision, and the board is long enough already.
  const guests = await q<{
    id: string; landlord_id: string; guest_name: string | null
    guest_email: string | null; guest_phone: string | null; created_at: Date
  }>(
    `SELECT b.id, b.landlord_id, b.guest_name, b.guest_email, b.guest_phone, b.created_at
       FROM unit_bookings b
      WHERE b.landlord_id = ANY($1::uuid[])
        AND b.tenant_id IS NULL
        AND b.folded_into_person_merge_id IS NULL
        AND COALESCE(btrim(b.guest_name), '') <> ''
        AND b.status NOT IN ('cancelled', 'no_show')
      ORDER BY b.created_at, b.id`,
    [landlordIds])

  // One guest identity per (name, address, phone) as written. Two reservations
  // that differ in any of the three are two identities on purpose — that
  // difference IS the duplicate being surfaced.
  const byTuple = new Map<string, PersonIdentity>()
  for (const g of guests) {
    const name = normalizeName(g.guest_name)
    if (!name) continue
    const email = normalizeEmail(g.guest_email)
    const phone = normalizePhone(g.guest_phone)
    const tuple = `${name.whole}|${email ?? ''}|${phone ?? ''}`
    const seen = byTuple.get(tuple)
    if (seen) {
      seen.bookingIds.push(g.id)
      seen.reservations += 1
      continue
    }
    byTuple.set(tuple, {
      key: `g:${g.id}`,
      kind: 'guest',
      userId: null,
      tenantId: null,
      bookingId: g.id,
      bookingIds: [g.id],
      landlordId: g.landlord_id,
      displayName: String(g.guest_name).trim(),
      rawEmail: g.guest_email,
      rawPhone: g.guest_phone,
      email,
      phone,
      name,
      reservations: 1,
      leases: 0,
      signedDocuments: 0,
      firstSeenAt: new Date(g.created_at).toISOString(),
    })
  }
  return people.concat([...byTuple.values()])
}

// ── THE SCAN ─────────────────────────────────────────────────────────────────

export interface ProposedPair {
  landlordId: string
  pairKey: string
  a: PersonIdentity
  b: PersonIdentity
  verdict: MatchVerdict
}

/**
 * The most people GAM will compare inside one surname before it stops and says
 * so. Every rule requires the surnames to agree, so bucketing by surname loses
 * no pair — it only keeps an 11,000-unit PM's "Smith" bucket from turning one
 * page load into a million string comparisons.
 */
export const SURNAME_BUCKET_LIMIT = 500

/** Pairs worth asking about, worst first. Pure — reads nothing, writes nothing. */
export function proposePairs(people: PersonIdentity[]): { pairs: ProposedPair[]; skippedSurnames: string[] } {
  const buckets = new Map<string, PersonIdentity[]>()
  for (const p of people) {
    if (!p.name) continue
    const b = buckets.get(p.name.last)
    if (b) b.push(p)
    else buckets.set(p.name.last, [p])
  }
  const pairs: ProposedPair[] = []
  const skippedSurnames: string[] = []
  for (const [surname, bucket] of buckets) {
    if (bucket.length < 2) continue
    if (bucket.length > SURNAME_BUCKET_LIMIT) { skippedSurnames.push(surname); continue }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const verdict = verdictFor(bucket[i], bucket[j])
        if (!verdict) continue
        // Sorted, so A-and-B and B-and-A are one question with one answer.
        const [a, b] = bucket[i].key < bucket[j].key ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]]
        pairs.push({ landlordId: a.landlordId, pairKey: `${a.key}+${b.key}`, a, b, verdict })
      }
    }
  }
  pairs.sort((x, y) => y.verdict.score - x.verdict.score || x.pairKey.localeCompare(y.pairKey))
  return { pairs, skippedSurnames }
}

const sideSnapshot = (p: PersonIdentity) => ({
  key: p.key,
  kind: p.kind,
  kindLabel: PERSON_SIDE_KIND_LABEL[p.kind],
  name: p.displayName,
  email: p.rawEmail,
  phone: p.rawPhone,
  reservations: p.reservations,
  leases: p.leases,
  signedDocuments: p.signedDocuments,
  firstSeenAt: p.firstSeenAt,
  userId: p.userId,
  tenantId: p.tenantId,
  bookingId: p.bookingId,
})

/**
 * Look for duplicates and write down what was found.
 *
 * UPSERT, AND THE UPSERT NEVER TOUCHES `status`. That one line is what makes a
 * dismissal stick: the pair Nic answered last week is FOUND rather than asked
 * again, its signals and snapshot refresh so the record stays accurate, and its
 * answer stands. Nothing in GAM reopens a decided proposal.
 */
export async function scanForDuplicates(opts: {
  landlordIds: string[]
}): Promise<{ open: number; raised: number; skippedSurnames: string[] }> {
  const { landlordIds } = opts
  if (!landlordIds.length) return { open: 0, raised: 0, skippedSurnames: [] }
  const people = await gatherPeople(landlordIds)
  const { pairs, skippedSurnames } = proposePairs(people)
  if (skippedSurnames.length) {
    logger.warn({ ctx: skippedSurnames.join(',') },
      '[duplicate-people] surname bucket over the comparison limit — not compared')
  }

  let raised = 0
  for (const p of pairs) {
    const rows = await query<{ raised: boolean }>(
      `INSERT INTO duplicate_person_proposals
         (landlord_id, pair_key,
          side_a_kind, side_a_user_id, side_a_booking_id,
          side_b_kind, side_b_user_id, side_b_booking_id,
          signals, confidence, score, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12::jsonb)
       ON CONFLICT (landlord_id, pair_key) DO UPDATE
          SET last_seen_at = now(),
              signals      = EXCLUDED.signals,
              confidence   = EXCLUDED.confidence,
              score        = EXCLUDED.score,
              snapshot     = EXCLUDED.snapshot
       RETURNING (xmax = 0) AS raised`,
      [
        p.landlordId, p.pairKey,
        p.a.kind, p.a.userId, p.a.bookingId,
        p.b.kind, p.b.userId, p.b.bookingId,
        p.verdict.signals, p.verdict.confidence, p.verdict.score,
        JSON.stringify({ a: sideSnapshot(p.a), b: sideSnapshot(p.b) }),
      ])
    if (rows[0]?.raised) raised += 1
  }

  const openRows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM duplicate_person_proposals
      WHERE landlord_id = ANY($1::uuid[]) AND status = 'open'`, [landlordIds])
  return { open: Number(openRows[0]?.n ?? 0), raised, skippedSurnames }
}

/** The questions still waiting on a person, worst first. */
export async function openProposals(landlordIds: string[]): Promise<any[]> {
  if (!landlordIds.length) return []
  return query<any>(
    `SELECT id, pair_key, side_a_kind, side_a_user_id, side_a_booking_id,
            side_b_kind, side_b_user_id, side_b_booking_id,
            signals, confidence, score, snapshot, first_seen_at, last_seen_at
       FROM duplicate_person_proposals
      WHERE landlord_id = ANY($1::uuid[]) AND status = 'open'
      ORDER BY score DESC, first_seen_at`, [landlordIds])
}

/** What has already been answered, newest first — so an answer can be looked up. */
export async function decidedProposals(landlordIds: string[], limit = 50): Promise<any[]> {
  if (!landlordIds.length) return []
  return query<any>(
    `SELECT id, status, signals, confidence, snapshot, keeper_side, merge_outcome,
            decided_at, decided_by
       FROM duplicate_person_proposals
      WHERE landlord_id = ANY($1::uuid[]) AND status <> 'open'
      ORDER BY decided_at DESC
      LIMIT $2`, [landlordIds, limit])
}

/** The signals in the landlord's words. Nothing stored is ever printed raw. */
export const signalSentences = (signals: string[]): string[] =>
  signals.map(s => DUPLICATE_SIGNAL_LABEL[s as DuplicateSignal]).filter(Boolean)

// ── THE ANSWER: DIFFERENT PEOPLE ─────────────────────────────────────────────

/**
 * "Different people", and it stays said. The row keeps both snapshots so the
 * decision can be read back, and no scan will raise this pair again.
 */
export async function dismissProposal(opts: {
  proposalId: string; landlordIds: string[]; byUserId: string
}): Promise<{ dismissed: true }> {
  const rows = await query<{ id: string }>(
    `UPDATE duplicate_person_proposals
        SET status = 'not_duplicate', decided_at = now(), decided_by = $3
      WHERE id = $1 AND landlord_id = ANY($2::uuid[]) AND status = 'open'
      RETURNING id`,
    [opts.proposalId, opts.landlordIds, opts.byUserId])
  if (!rows.length) throw new AppError(404, 'That question is not one of yours, or it has already been answered.')
  return { dismissed: true }
}

// ── THE ANSWER: SAME PERSON ──────────────────────────────────────────────────

export interface MergeOutcome {
  keeper: ReturnType<typeof sideSnapshot>
  folded: ReturnType<typeof sideSnapshot>
  emailMoved: string | null
  emailRetiredTo: string | null
  reservationsRepointed: number
  emailsFilled: number
  /**
   * Checks that now read on the surviving person: this account's own, plus a
   * renter-pool check when the folded sign-in is this account's alone.
   */
  screeningMoved: number
  /** Screenings already paid for here that now read on the surviving person. */
  screeningPrepaymentsMoved: number
  /** True when both sign-ins were left exactly as they were. */
  signInLeftAlone: boolean
  /** What happened, in sentences the landlord can read on the screen. */
  summary: string[]
}

/**
 * 10/20 — WHAT THIS ACCOUNT'S BOOK DOES NOT HOLD.
 *
 * True when the folded sign-in has business with a company outside the account
 * that asked: a lease, a document it was put on the signer list for (signed or
 * still waiting), a reservation, an import intent, a screening another company
 * ran — or a GAM landlord account of its own.
 *
 * Nothing about the ANSWER is shown to the landlord and nothing names the other
 * company. It decides one thing: whether the folded sign-in is this account's
 * to retire. A person mid-signing a lease elsewhere reads 0 leases and 0 signed
 * documents here, so nothing else in a merge can tell that the address it is
 * about to retire is somebody's way into the home they pay rent on.
 *
 * A renter-pool check is deliberately NOT counted. The person put that in the
 * pool themselves and every landlord reads it; it says nothing about whose
 * resident they are.
 */
export async function signInBeyondThisAccount(
  p: PersonIdentity, landlordIds: string[], client: PoolClient,
): Promise<boolean> {
  if (p.kind !== 'account' || !p.userId) return false
  const rows = (await client.query<{ beyond: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
         WHERE lt.tenant_id = $2::uuid AND NOT (l.landlord_id = ANY($3::uuid[]))
        UNION ALL
        SELECT 1 FROM lease_document_signers s
          JOIN lease_documents ld ON ld.id = s.document_id
         WHERE s.user_id = $1::uuid AND NOT (ld.landlord_id = ANY($3::uuid[]))
        UNION ALL
        SELECT 1 FROM unit_bookings b
         WHERE b.tenant_id = $2::uuid AND NOT (b.landlord_id = ANY($3::uuid[]))
        UNION ALL
        SELECT 1 FROM pending_tenant_intents pti
         WHERE pti.tenant_id = $2::uuid AND pti.cancelled_at IS NULL
           AND NOT (pti.landlord_id = ANY($3::uuid[]))
        UNION ALL
        SELECT 1 FROM background_checks bc
         WHERE (bc.user_id = $1::uuid OR bc.tenant_id = $2::uuid)
           AND NOT (bc.landlord_id = ANY($3::uuid[]))
           AND NOT ${pooledCheckSql('bc')}
        UNION ALL
        SELECT 1 FROM landlords ll
         WHERE ll.user_id = $1::uuid AND NOT (ll.id = ANY($3::uuid[]))
     ) AS beyond`,
    [p.userId, p.tenantId, landlordIds])).rows
  return !!rows[0]?.beyond
}

/** The refusals, each one a sentence about the landlord's problem. */
export const MERGE_BOTH_HAVE_TENANCY =
  'Both of these have a lease or a signed document under their own sign-in. Joining them would retire one of those sign-ins, '
  + 'and the person behind it would stop being able to open their own lease. Close out the one that has ended first, then join them.'
export const MERGE_ACCOUNT_MUST_KEEP =
  'The one with the GAM account has to be the one that stays. A reservation has nowhere to keep a lease, a payment or a signature, '
  + 'so folding the account into the reservation would strand all three.'
export const MERGE_TENANCY_MUST_KEEP =
  'The side holding the lease has to be the one that stays. GAM joins two people by moving the sign-in address, never the lease — '
  + 'moving a lease would detach a signed document from the person who signed it.'
export const MERGE_TWO_ADDRESSES =
  'These are two reservations with two different email addresses and no GAM account between them. GAM will not pick one address over '
  + 'the other on its own: that would quietly change where a guest\'s confirmation goes. Give one of them a GAM account and this will join cleanly.'
/**
 * Not a refusal — the join happened. It is what the landlord is told when the
 * sign-ins were left alone, and it says nothing about why.
 */
export const MERGE_SIGN_IN_KEPT =
  'Both sign-ins are kept exactly as they were: GAM retired neither one and no address moved. A sign-in belongs to the person for the whole '
  + 'of GAM, so joining two of them is only ever a change to your own book — which is where the reservations, the balance and the stay history now sit.'
export const MERGE_NO_ADDRESS =
  'Neither of these has an email address or a GAM account, so there is nothing to join them on. Add the address you have for them to '
  + 'one of the reservations, or give them a GAM account, and this will join cleanly.'

/**
 * The landlord said: same person. Do the least that makes it true.
 *
 * `keeperSide` is the landlord's pick of who stays, and `signInAddress` their
 * pick of which address the surviving account signs in with — defaulting to the
 * one it already has, because changing somebody's sign-in address is not a
 * side effect, it is a decision.
 *
 * SENDS NOTHING. No confirmation, no notice, no "your accounts were merged".
 * Both halves of this person have already been talked to by Nic himself and
 * neither of them asked for this; the merge is bookkeeping on GAM's side.
 */
export async function mergePeople(opts: {
  proposalId: string
  landlordIds: string[]
  keeperSide: 'a' | 'b'
  signInAddress?: 'keeper' | 'folded'
  byUserId: string
}): Promise<MergeOutcome> {
  const { proposalId, landlordIds, keeperSide, byUserId } = opts
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // One merge at a time per account: two people answering two questions about
    // the same person would each read a book the other is rewriting.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`person_merge:${[...landlordIds].sort().join(',')}`])

    const proposal = (await client.query<{
      id: string; landlord_id: string; pair_key: string; status: string
      side_a_kind: string; side_b_kind: string
    }>(
      `SELECT id, landlord_id, pair_key, status, side_a_kind, side_b_kind
         FROM duplicate_person_proposals
        WHERE id = $1 AND landlord_id = ANY($2::uuid[])
        FOR UPDATE`, [proposalId, landlordIds])).rows[0]
    if (!proposal) throw new AppError(404, 'That question is not one of yours.')
    if (proposal.status !== 'open') {
      throw new AppError(409, 'That question has already been answered.')
    }

    // Re-derive both people as they are RIGHT NOW. The snapshot on the row is
    // for reading back later; acting on it would act on last week's book.
    const people = await gatherPeople(landlordIds, async (sql, params) => (await client.query(sql, params)).rows as any)
    const byKey = new Map(people.map(p => [p.key, p]))
    const [keyA, keyB] = proposal.pair_key.split('+')
    const a = byKey.get(keyA)
    const b = byKey.get(keyB)
    if (!a || !b) {
      throw new AppError(409,
        'One of these two is not in your book any more — it may already have been joined to somebody. '
        + 'Close this question and look again.')
    }
    let keeper = keeperSide === 'a' ? a : b
    let folded = keeperSide === 'a' ? b : a

    // ── WHO HAS TO SURVIVE ──
    if (holdsTenancy(keeper) && holdsTenancy(folded)) throw new AppError(409, MERGE_BOTH_HAVE_TENANCY)
    if (keeper.kind === 'guest' && folded.kind === 'account') throw new AppError(409, MERGE_ACCOUNT_MUST_KEEP)
    if (holdsTenancy(folded) && !holdsTenancy(keeper)) throw new AppError(409, MERGE_TENANCY_MUST_KEEP)

    const summary: string[] = []
    let emailMoved: string | null = null
    let emailRetiredTo: string | null = null
    let reservationsRepointed = 0
    let emailsFilled = 0
    let screeningMoved = 0
    let screeningPrepaymentsMoved = 0
    let signInLeftAlone = false

    if (folded.kind === 'account') {
      // ── TWO SIGN-INS, ONE PERSON ──
      //
      // 10/20 — AND THE SIGN-IN IS ONLY OURS TO TOUCH IF THIS BOOK HOLDS IT ALL.
      //
      // This retired the folded address and set tenants.platform_status to
      // 'suspended' every time. tenants has no landlord column — one row per
      // person for the whole platform — so a man holding a reservation here
      // and mid-signing a lease with a different GAM landlord came out of it
      // unable to sign in anywhere: esign told him his GAM account was
      // suspended, he could not sign that other lease, and had it already been
      // live he could not have reached his own portal to pay rent. Nothing in
      // the merge could see it coming either, because a signer row that is not
      // signed yet reads as 0 leases and 0 signed documents in Nic's book.
      //
      // So: nobody is ever suspended, and the sign-in is only retired or moved
      // when this account's book holds everything that sign-in has. When it
      // does not, both sign-ins stand and the landlord is told in one sentence
      // that names nothing outside his own book.
      const beyond = await signInBeyondThisAccount(folded, landlordIds, client)
      if (beyond) {
        signInLeftAlone = true
        summary.push(MERGE_SIGN_IN_KEPT)
      } else if (opts.signInAddress === 'folded' && folded.rawEmail) {
        // The address moves; the lease never does. The folded row stays exactly
        // where it is, under a name that can never receive mail (RFC 2606), and
        // stays findable by name and phone.
        await client.query(
          `UPDATE users SET email = $2, email_verified = FALSE, email_verify_token = NULL,
                            email_verify_token_expires_at = NULL, pending_email = NULL,
                            pending_email_token = NULL, pending_email_expires_at = NULL,
                            updated_at = now()
            WHERE id = $1`,
          [folded.userId, `duplicate-${String(folded.userId).slice(0, 8)}@invalid`])
        emailRetiredTo = `duplicate-${String(folded.userId).slice(0, 8)}@invalid`
        await client.query(
          `UPDATE users SET email = $2, updated_at = now() WHERE id = $1`,
          [keeper.userId, folded.rawEmail])
        emailMoved = folded.rawEmail
        summary.push(`${keeper.displayName} now signs in as ${folded.rawEmail}.`)
      } else {
        await client.query(
          `UPDATE users SET email = $2, email_verified = FALSE, email_verify_token = NULL,
                            email_verify_token_expires_at = NULL, pending_email = NULL,
                            pending_email_token = NULL, pending_email_expires_at = NULL,
                            updated_at = now()
            WHERE id = $1`,
          [folded.userId, `duplicate-${String(folded.userId).slice(0, 8)}@invalid`])
        emailRetiredTo = `duplicate-${String(folded.userId).slice(0, 8)}@invalid`
        summary.push(`${keeper.displayName} keeps signing in as ${keeper.rawEmail ?? 'the address they already use'}.`)
      }
      if (!signInLeftAlone) {
        // A duplicate account usually exists BECAUSE they could not get into
        // the first one. Clearing the counter stops the survivor sitting one
        // wrong guess from a lockout. Only on the path where the sign-in
        // actually changed — otherwise this is a write on a person's account
        // for a merge that did not touch their sign-in at all.
        await client.query(
          `UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
          [keeper.userId])
      }
      // Their reservations come across. Only inside this account's companies:
      // another landlord's board is not ours to rewrite.
      const moved = await client.query(
        `UPDATE unit_bookings
            SET tenant_id = $1, updated_at = now()
          WHERE tenant_id = $2 AND landlord_id = ANY($3::uuid[])`,
        [keeper.tenantId, folded.tenantId, landlordIds])
      reservationsRepointed = moved.rowCount ?? 0

      // ── AND THE SCREENING COMES WITH HIM ──
      //
      // 10/20 — a man who PAID for a check and PASSED it was turned away at
      // the gate because his records had been tidied up. The reservations move
      // to the surviving sign-in, so check-in resolves him to it
      // (services/stayTerms resolvePerson), and both reads that look for an
      // approved check look under the person they resolved
      // (`bc.user_id = ... OR bc.tenant_id = ...`, services/bookingLeaseDraft
      // and services/stayTerms). His approval was still sitting on the folded
      // sign-in, so a 60-night stay read screening_required and the arrival was
      // refused: $34.99 to Checkr plus GAM's margin, already charged to him,
      // and an unscreened-looking guest at the gate.
      //
      // THIS ACCOUNT'S CHECKS, and — when the folded sign-in is this account's
      // alone — a renter-pool check, which is the person's own. A check another
      // company ran is that company's decision (S655): never moved, never read
      // here. A pool check is read by every landlord under the user id it sits
      // on, so moving one while the person still has business elsewhere would
      // take that landlord's copy away.
      const checks = await client.query(
        `UPDATE background_checks bc
            SET user_id = $1, tenant_id = $2, updated_at = now()
          WHERE (bc.user_id = $3 OR bc.tenant_id = $4)
            AND (bc.landlord_id = ANY($5::uuid[])
                 OR ($6::boolean AND ${pooledCheckSql('bc')}))`,
        [keeper.userId, keeper.tenantId, folded.userId, folded.tenantId, landlordIds, !beyond])
      screeningMoved = checks.rowCount ?? 0
      // A screening already paid for here and not used yet is $39.99 of his
      // money; stayTerms reads it by tenant id, so it moves with him too.
      const prepaid = await client.query(
        `UPDATE screening_prepayments
            SET tenant_id = $1
          WHERE tenant_id = $2 AND status = 'unused' AND landlord_id = ANY($3::uuid[])`,
        [keeper.tenantId, folded.tenantId, landlordIds])
      screeningPrepaymentsMoved = prepaid.rowCount ?? 0
      if (screeningMoved) {
        // The person's one platform-wide screening line follows the newest
        // check that moved — but never over the top of a screening the
        // surviving account already has of its own, and only to a value this
        // column is allowed to hold (tenants_background_check_status_check).
        await client.query(
          `UPDATE tenants t
              SET background_check_id = c.id, background_check_status = c.status,
                  updated_at = now()
             FROM (SELECT bc.id, bc.status FROM background_checks bc
                    WHERE bc.user_id = $1 AND bc.landlord_id = ANY($3::uuid[])
                      AND bc.status IN
                          ('approved', 'denied', 'expired', 'cancelled', 'submitted')
                    ORDER BY bc.created_at DESC LIMIT 1) c
            WHERE t.id = $2 AND t.background_check_id IS NULL
              AND t.background_check_status = 'not_started'`,
          [keeper.userId, keeper.tenantId, landlordIds])
        summary.push(
          `${screeningMoved === 1 ? 'The background check on file' : `The ${screeningMoved} background checks on file`} for them`
          + ` ${screeningMoved === 1 ? 'now reads' : 'now read'} on ${keeper.displayName}, so a check they already paid for is not asked for twice at the gate.`)
      }
      if (screeningPrepaymentsMoved) {
        summary.push(
          `${screeningPrepaymentsMoved === 1 ? 'A screening already paid for here' : `${screeningPrepaymentsMoved} screenings already paid for here`}`
          + ` ${screeningPrepaymentsMoved === 1 ? 'is' : 'are'} now ${keeper.displayName}'s to use.`)
      }
      summary.push(
        signInLeftAlone
          ? 'Both rows are kept. Their leases, payments and signatures stay where they are — GAM never moves a signed document to another name.'
          : `The folded sign-in is kept, retired to ${emailRetiredTo}, and still findable by name and phone. `
            + 'Its leases, payments and signatures stay on it — GAM never moves a signed document to another name.')
    } else if (keeper.kind === 'account') {
      // ── A RESERVATION GUEST AND THE ACCOUNT THAT IS THEM ──
      // The reservations point at the person. What is WRITTEN on them —
      // name, address, phone — is left alone: that is what the guest was told.
      const moved = await client.query(
        `UPDATE unit_bookings
            SET tenant_id = $1, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND landlord_id = ANY($3::uuid[])`,
        [keeper.tenantId, folded.bookingIds, landlordIds])
      reservationsRepointed = moved.rowCount ?? 0
      summary.push(
        `${reservationsRepointed === 1 ? 'That reservation' : `Those ${reservationsRepointed} reservations`}`
        + ` now belong to ${keeper.displayName}'s GAM account.`)
      summary.push('What is written on the reservation — the name, email and phone it was booked under — is left exactly as it was.')
    } else {
      // ── TWO RESERVATION GUESTS, NO ACCOUNT EITHER SIDE ──
      // The stay chain matches on tenant_id OR guest_email, so an address is
      // the only thing that can join them. Fill a blank; never overwrite.
      if (keeper.email && folded.email) throw new AppError(409, MERGE_TWO_ADDRESSES)
      if (!keeper.email && !folded.email) throw new AppError(409, MERGE_NO_ADDRESS)
      if (!keeper.email && folded.email) {
        // The address is on the side the landlord folded. Keep the person who
        // has one — there is nothing else to choose between two reservations.
        const swap = keeper; keeper = folded; folded = swap
      }
      const filled = await client.query(
        `UPDATE unit_bookings
            SET guest_email = $1, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND landlord_id = ANY($3::uuid[])
            AND COALESCE(btrim(guest_email), '') = ''`,
        [keeper.rawEmail, folded.bookingIds, landlordIds])
      emailsFilled = filled.rowCount ?? 0
      summary.push(
        `${emailsFilled === 1 ? 'The reservation that had no email address now carries' : `${emailsFilled} reservations that had no email address now carry`}`
        + ` ${keeper.rawEmail}, so GAM reads both halves as one guest.`)
      summary.push('Nothing was overwritten and nothing was deleted — every reservation is still on the board under the name it was booked in.')
    }

    const merge = (await client.query<{ id: string }>(
      `INSERT INTO person_merges
         (landlord_id, proposal_id,
          keeper_key, keeper_kind, keeper_user_id, keeper_booking_id,
          loser_key, loser_kind, loser_user_id, loser_booking_id,
          email_moved, email_retired_to, reservations_repointed, emails_filled,
          merged_by, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       RETURNING id`,
      [
        proposal.landlord_id, proposal.id,
        keeper.key, keeper.kind, keeper.userId, keeper.bookingId,
        folded.key, folded.kind, folded.userId, folded.bookingId,
        emailMoved, emailRetiredTo, reservationsRepointed, emailsFilled, byUserId,
        JSON.stringify({
          keeper: sideSnapshot(keeper), folded: sideSnapshot(folded),
          foldedBookingIds: folded.bookingIds, summary,
          // No column for these two: person_merges.detail is where a merge
          // writes down what it did that the fixed columns do not cover.
          screeningMoved, screeningPrepaymentsMoved, signInLeftAlone,
        }),
      ])).rows[0]

    // The stamp that keeps a folded reservation out of the next scan. A guest
    // identity's shape CHANGES when a merge fills in their address, so a handle
    // derived from that shape would come back looking like somebody new.
    if (folded.bookingIds.length) {
      await client.query(
        `UPDATE unit_bookings SET folded_into_person_merge_id = $1, updated_at = now()
          WHERE id = ANY($2::uuid[]) AND landlord_id = ANY($3::uuid[])`,
        [merge.id, folded.bookingIds, landlordIds])
    }

    const outcome: MergeOutcome = {
      keeper: sideSnapshot(keeper),
      folded: sideSnapshot(folded),
      emailMoved, emailRetiredTo, reservationsRepointed, emailsFilled,
      screeningMoved, screeningPrepaymentsMoved, signInLeftAlone, summary,
    }
    await client.query(
      `UPDATE duplicate_person_proposals
          SET status = 'merged', decided_at = now(), decided_by = $2,
              keeper_side = $3, merge_outcome = $4::jsonb
        WHERE id = $1`,
      [proposal.id, byUserId, keeper.key === keyA ? 'a' : 'b', JSON.stringify(outcome)])

    await client.query('COMMIT')
    return outcome
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
