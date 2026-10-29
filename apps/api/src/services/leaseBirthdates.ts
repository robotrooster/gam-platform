/**
 * 10/13 (Nic): birthdays off the signed leases, onto each person.
 *
 * Nic: "we have birthdays from leases and stuff, right? Customer profiles
 * should mostly have birthdays." He wants the average tenant age, by property,
 * oldest and youngest, and "what age people are when they default" — and a
 * happy-birthday email (jobs/birthdayEmails reads tenants.date_of_birth).
 *
 * On 10/13 tenants.date_of_birth was empty for all 119 tenants, while 82
 * birthdates had been typed on signed leases: the lease form's people table
 * has a "Tenant name 1/2/3" column per person and, in the same column, a
 * "Birthdate 1/2/3" box the person fills in when they sign. This copies each
 * typed birthdate onto the person it belongs to:
 *
 *   - the name beside it: the "Tenant name N" box with the same number N (for
 *     a form labelled differently, the tenant-name box of that number — every
 *     one of them must say the same name);
 *   - the person on THAT lease with that name: a tenant on the lease (their
 *     account name, or the name they signed this document under), or an
 *     occupant listed on the lease (lease_occupants — an occupant's birthday
 *     is stored there).
 *
 * NEVER GUESSED. A birthdate is written only when exactly one person on the
 * lease has the name beside it, the date reads as a real day before the lease
 * was signed (and not more than 120 years before), and nothing else says
 * otherwise. Everything else is reported with its reason and not written:
 * no name beside it, nobody or two people by that name, a date that does not
 * read, a person whose profile already holds a different birthday (never
 * overwritten), or a person given two different birthdays on two leases.
 *
 * IDEMPOTENT. A write only fills an empty birthday (`date_of_birth IS NULL`),
 * so running it again — or the hook after the one-time backfill — writes
 * nothing twice and never changes a birthday already on file.
 *
 * Two callers:
 *   - scripts/oct13_lease_birthdates_backfill.ts — the one-time backfill over
 *     every signed lease (dry run by default, --apply to write);
 *   - routes/esign.ts — when a lease document finishes signing, its own
 *     birthdates (best-effort, after the signature is recorded).
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { logger } from '../lib/logger'

/** Why a typed birthdate was not written. Never shown raw — each has its words. */
export const BIRTHDATE_SKIP_REASONS = [
  'unreadable_date',
  'no_name_beside',
  'names_disagree',
  'nobody_by_that_name',
  'several_people_by_that_name',
  'has_a_different_birthday',
  'two_different_birthdays',
] as const
export type BirthdateSkipReason = typeof BIRTHDATE_SKIP_REASONS[number]
export const BIRTHDATE_SKIP_REASON_LABEL: Readonly<Record<BirthdateSkipReason, string>> = {
  unreadable_date: 'the date typed does not read as a real birthday before the lease was signed',
  no_name_beside: 'there is no name beside it on the lease',
  names_disagree: 'the name boxes of that number say different names',
  nobody_by_that_name: 'nobody on the lease has the name beside it',
  several_people_by_that_name: 'more than one person on the lease has the name beside it',
  has_a_different_birthday: 'their profile already holds a different birthday (left as it is)',
  two_different_birthdays: 'they were given two different birthdays on two leases',
}

export type BirthdateOutcome = 'write' | 'already_on_file' | 'skipped'

export interface BirthdateLine {
  documentId: string
  leaseId: string
  fieldId: string
  /** The box's label, e.g. "Birthdate 2". */
  label: string
  /** What was typed in it. */
  typed: string
  /** The name beside it, as typed (null when there is none). */
  nameBeside: string | null
  /** The typed date read as 'YYYY-MM-DD' (null when it does not read). */
  birthday: string | null
  /** Who it belongs to, when exactly one person matched. */
  person: { kind: 'tenant' | 'occupant'; id: string; name: string } | null
  outcome: BirthdateOutcome
  reason: BirthdateSkipReason | null
}

export interface BirthdateRun {
  applied: boolean
  lines: BirthdateLine[]
  /** People whose birthday was (or, on a dry run, would be) filled in. */
  tenantsWritten: number
  occupantsWritten: number
}

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>

/**
 * A name as people type it, for comparing: case, extra spaces and the
 * punctuation people put in or leave out ("Jr." / "Jr", "O'Neil" / "ONeil")
 * do not make two names different. Letters with accents are kept.
 */
export function normalizeName(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.,'"’`]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * normalizeName in SQL, over a text expression — the same comparison for code
 * that groups people by name in a query (services/platformMetrics counts an
 * occupant listed on two leases once).
 */
export function normalizeNameSql(expr: string): string {
  return `btrim(regexp_replace(regexp_replace(regexp_replace(lower(COALESCE(${expr}, '')),
            '[.,''"’\`]', '', 'g'), '[-_]+', ' ', 'g'), '\\s+', ' ', 'g'))`
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The typed date as 'YYYY-MM-DD', or null when it is not a real calendar
 * day. Reads M/D/YYYY (how the lease form's date box writes it), M-D-YYYY and
 * YYYY-MM-DD. A two-digit year is not read: 1/2/63 could be 1963 or 2063.
 */
export function readTypedDate(typed: string | null | undefined): string | null {
  const s = String(typed ?? '').trim()
  let y: number, m: number, d: number
  let hit = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (hit) { m = +hit[1]; d = +hit[2]; y = +hit[3] } else {
    hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
    if (!hit) return null
    y = +hit[1]; m = +hit[2]; d = +hit[3]
  }
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/** A birthday is a day before the lease was signed, and not more than 120 years before it. */
export function believableBirthday(birthday: string, signedOn: string): boolean {
  if (birthday >= signedOn) return false
  const oldest = `${Number(signedOn.slice(0, 4)) - 120}${signedOn.slice(4)}`
  return birthday >= oldest
}

/** The number on a box's label ("Birthdate 2" → 2); a birthdate box with no number is 1. */
const BIRTHDATE_LABEL = /^\s*(?:birth\s*date|date\s+of\s+birth|dob)\s*(\d+)?\s*$/i
const NAME_LABEL = /^\s*(?:tenant|resident|occupant)?\s*name\s*(\d+)\s*$/i

/** The tenant-name column a number's box fills (lease_document_fields lease_column). */
const nameColumn = (n: number) => (n === 1 ? 'tenant_name' : `tenant_${n}_name`)

/**
 * Every typed birthdate on signed lease documents (one document when
 * `documentId` is given), each with whose it is and what would happen to it.
 * Reads only.
 */
export async function planLeaseBirthdates(q: Q, opts: { documentId?: string | null } = {}): Promise<BirthdateLine[]> {
  const docId = opts.documentId ?? null
  // The birthdate boxes with something typed in them, on completed documents
  // that belong to a lease.
  const boxes = (await q(
    `SELECT f.id, f.document_id, f.label, f.value, d.lease_id,
            to_char(COALESCE(f.signed_at, d.completed_at, d.updated_at) AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD') AS signed_on
       FROM lease_document_fields f
       JOIN lease_documents d ON d.id = f.document_id
      WHERE d.status = 'completed' AND d.lease_id IS NOT NULL
        AND ($1::uuid IS NULL OR d.id = $1::uuid)
        AND f.label ~* '^\\s*(birth\\s*date|date\\s+of\\s+birth|dob)\\s*[0-9]*\\s*$'
        AND COALESCE(btrim(f.value), '') <> ''
      ORDER BY d.id, f.label, f.id`, [docId])).rows
  if (!boxes.length) return []

  const docIds = [...new Set(boxes.map(b => b.document_id as string))]
  const leaseIds = [...new Set(boxes.map(b => b.lease_id as string))]
  // One after another: they share the caller's transaction (one connection).
  const nameRows = await (
    // The name boxes on those documents (labelled "Tenant name N", or filling a tenant-name column).
    q(`SELECT f.document_id, f.label, f.lease_column, f.value
         FROM lease_document_fields f
        WHERE f.document_id = ANY($1::uuid[])
          AND (f.label ~* '^\\s*(tenant|resident|occupant)?\\s*name\\s*[0-9]+\\s*$'
               OR f.lease_column IN ('tenant_name', 'tenant_2_name', 'tenant_3_name', 'tenant_4_name'))
          AND COALESCE(btrim(f.value), '') <> ''`, [docIds]))
  // The tenants on those leases: their account name, and every name they
  // signed a document of the lease under.
  const tenantRows = await q(`SELECT lt.lease_id, t.id AS tenant_id, t.date_of_birth::text AS dob,
              btrim(u.first_name || ' ' || u.last_name) AS name,
              ARRAY(SELECT s.name FROM lease_document_signers s
                      JOIN lease_documents sd ON sd.id = s.document_id
                     WHERE sd.lease_id = lt.lease_id AND s.user_id = t.user_id) AS signed_as
         FROM lease_tenants lt
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE lt.lease_id = ANY($1::uuid[]) AND lt.status <> 'void'`, [leaseIds])
  const occupantRows = await q(
     `SELECT o.lease_id, o.id AS occupant_id, o.full_name AS name, o.date_of_birth::text AS dob
         FROM lease_occupants o
        WHERE o.lease_id = ANY($1::uuid[])`, [leaseIds])

  // People on each lease, by name as compared.
  type Person = { kind: 'tenant' | 'occupant'; id: string; name: string; dob: string | null }
  const people = new Map<string, Person[]>()
  const onLease = (leaseId: string) => people.get(leaseId) ?? people.set(leaseId, []).get(leaseId)!
  for (const t of tenantRows.rows) {
    const list = onLease(t.lease_id)
    if (!list.some(p => p.kind === 'tenant' && p.id === t.tenant_id)) {
      list.push({ kind: 'tenant', id: t.tenant_id, name: t.name, dob: t.dob ?? null })
    }
  }
  for (const o of occupantRows.rows) {
    onLease(o.lease_id).push({ kind: 'occupant', id: o.occupant_id, name: o.name, dob: o.dob ?? null })
  }
  const namesOf = new Map<string, Set<string>>() // `${kind}:${id}` on a lease → names it answers to
  for (const t of tenantRows.rows) {
    const key = `${t.lease_id}|tenant:${t.tenant_id}`
    const set = namesOf.get(key) ?? new Set<string>()
    set.add(normalizeName(t.name))
    for (const s of (t.signed_as ?? []) as string[]) if (normalizeName(s)) set.add(normalizeName(s))
    namesOf.set(key, set)
  }
  for (const o of occupantRows.rows) namesOf.set(`${o.lease_id}|occupant:${o.occupant_id}`, new Set([normalizeName(o.name)]))

  const lines: BirthdateLine[] = boxes.map(b => {
    const n = Number(BIRTHDATE_LABEL.exec(String(b.label))?.[1] ?? 1)
    const line: BirthdateLine = {
      documentId: b.document_id, leaseId: b.lease_id, fieldId: b.id, label: b.label, typed: String(b.value).trim(),
      nameBeside: null, birthday: null, person: null, outcome: 'skipped', reason: null,
    }
    // The name beside it: the "Tenant name N" box; failing that, the boxes
    // filling that number's tenant-name column, which must all agree.
    const docNames = nameRows.rows.filter(r => r.document_id === b.document_id)
    let beside = docNames.filter(r => Number(NAME_LABEL.exec(String(r.label ?? ''))?.[1] ?? NaN) === n)
    if (!beside.length) beside = docNames.filter(r => r.lease_column === nameColumn(n))
    const distinct = [...new Set(beside.map(r => normalizeName(r.value)).filter(Boolean))]
    if (distinct.length === 0) { line.reason = 'no_name_beside'; return line }
    if (distinct.length > 1) { line.reason = 'names_disagree'; return line }
    line.nameBeside = String(beside.find(r => normalizeName(r.value) === distinct[0])!.value).trim()

    const birthday = readTypedDate(line.typed)
    if (!birthday || !believableBirthday(birthday, b.signed_on)) { line.reason = 'unreadable_date'; return line }
    line.birthday = birthday

    const matches = (people.get(b.lease_id) ?? [])
      .filter(p => namesOf.get(`${b.lease_id}|${p.kind}:${p.id}`)?.has(distinct[0]))
    if (matches.length === 0) { line.reason = 'nobody_by_that_name'; return line }
    if (matches.length > 1) { line.reason = 'several_people_by_that_name'; return line }
    line.person = { kind: matches[0].kind, id: matches[0].id, name: matches[0].name }
    return line
  })

  // One person, one birthday: two different dates typed for the same person
  // (on two leases) are both left unwritten. A birthday already on file is
  // never changed.
  const datesFor = new Map<string, Set<string>>()
  for (const l of lines) {
    if (!l.person || !l.birthday) continue
    const k = `${l.person.kind}:${l.person.id}`
    datesFor.set(k, (datesFor.get(k) ?? new Set()).add(l.birthday))
  }
  const onFile = new Map<string, string | null>()
  for (const list of people.values()) for (const p of list) onFile.set(`${p.kind}:${p.id}`, p.dob)
  for (const l of lines) {
    if (!l.person || !l.birthday) continue
    const k = `${l.person.kind}:${l.person.id}`
    const current = onFile.get(k) ?? null
    if (current === l.birthday) { l.outcome = 'already_on_file'; continue }
    if (current) { l.reason = 'has_a_different_birthday'; continue }
    if ((datesFor.get(k)?.size ?? 0) > 1) { l.reason = 'two_different_birthdays'; continue }
    l.outcome = 'write'
  }
  return lines
}

/**
 * Plan, and with `apply` write, in one transaction. A dry run reads in a
 * READ ONLY transaction, so it can be pointed at production safely.
 */
export async function copyLeaseBirthdates(opts: { documentId?: string | null; apply: boolean; client?: PoolClient }): Promise<BirthdateRun> {
  const own = !opts.client
  const c = opts.client ?? await getClient()
  try {
    if (own) await c.query(opts.apply ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY')
    const q: Q = (sql, params) => c.query(sql, params)
    const lines = await planLeaseBirthdates(q, { documentId: opts.documentId })
    // Each person once, whatever number of their lines say the same date.
    const writes = new Map<string, { kind: 'tenant' | 'occupant'; id: string; birthday: string }>()
    for (const l of lines) {
      if (l.outcome === 'write' && l.person && l.birthday) {
        writes.set(`${l.person.kind}:${l.person.id}`, { kind: l.person.kind, id: l.person.id, birthday: l.birthday })
      }
    }
    let tenantsWritten = 0, occupantsWritten = 0
    for (const w of writes.values()) {
      if (!opts.apply) { if (w.kind === 'tenant') tenantsWritten++; else occupantsWritten++; continue }
      // Only ever fills an empty birthday.
      const r = w.kind === 'tenant'
        ? await c.query(`UPDATE tenants SET date_of_birth = $2::date, updated_at = NOW()
                          WHERE id = $1 AND date_of_birth IS NULL`, [w.id, w.birthday])
        : await c.query(`UPDATE lease_occupants SET date_of_birth = $2::date, updated_at = NOW()
                          WHERE id = $1 AND date_of_birth IS NULL`, [w.id, w.birthday])
      if (r.rowCount) { if (w.kind === 'tenant') tenantsWritten++; else occupantsWritten++ }
    }
    if (own) await c.query(opts.apply ? 'COMMIT' : 'ROLLBACK')
    // One document (a lease that just finished signing): say what was left
    // alone and why, so a birthday that did not land can be found.
    const skipped = lines.filter(l => l.outcome === 'skipped')
    if (opts.documentId && skipped.length) {
      logger.warn({ documentId: opts.documentId, skipped: skipped.map(l => ({ fieldId: l.fieldId, label: l.label, reason: l.reason })) },
        '[birthdates] some birthdates on the signed lease were not copied')
    }
    return { applied: opts.apply, lines, tenantsWritten, occupantsWritten }
  } catch (e) {
    if (own) await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (own) c.release()
  }
}
