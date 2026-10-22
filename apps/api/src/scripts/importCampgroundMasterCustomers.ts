/**
 * 10/21 (Nic) — THE PEOPLE MOUNTAIN VIEW ALREADY KNEW.
 *
 *   "I don't need the reservation history. I just need the customer data."
 *   "there's a lot of throwaway customers that are not obviously real."
 *   "I want the history of GAM, the calendar, to start where we started using
 *    GAM."
 *
 * Campground Master ran the park before GAM did, and its customer list is seven
 * hundred and sixty-nine rows of people who have actually stayed there. The
 * RESERVATIONS in that file are deliberately left behind — the schedule starts
 * where GAM started. This is only the address book.
 *
 * WHAT IT REFUSES TO DO
 *
 *   It does not merge anybody. Nineteen groups share a name exactly and nine
 *   share a phone number, and at a campground that is as likely to be a husband
 *   and wife, or a father and son, as it is a duplicate. Merging the wrong two
 *   people silently welds two strangers' histories together, and no screen
 *   afterwards would show you that it happened. So every row comes in as
 *   itself and the pairs are PRINTED for somebody who knows these people to
 *   look at. (gam-merge-accounts-by-moving-the-address is how a real merge is
 *   done, by hand, on purpose.)
 *
 *   It does not invent contact details. Only a hundred and eleven of these
 *   people have an email and five hundred and seventy-three have a phone. The
 *   rest come in as a name, which is what the old system knew about them, and
 *   the counter can fill the rest in when they next turn up.
 *
 *   It does not run twice. Every row carries a stable `elsewhere_ref` built
 *   from the source file, and the unique index on (landlord_id,
 *   elsewhere_ref) means a second run updates rather than duplicates.
 *
 * WHAT IT DROPS: rows whose name is not a name — a letter or two, punctuation
 * only, a repeated character, or a word like "test". Each one is printed with
 * the reason, so nothing disappears quietly.
 *
 * THE FILE LIVES OUTSIDE THE REPOSITORY. ~/gam is public; customer names and
 * phone numbers are not. Pass the path in.
 *
 * DRY RUN BY DEFAULT — reads production, writes nothing.
 *   cd apps/api && npx ts-node -T src/scripts/importCampgroundMasterCustomers.ts ~/gam-imports/campground-master/"Customer List CampMaster.csv"
 *   cd apps/api && npx ts-node -T src/scripts/importCampgroundMasterCustomers.ts <file> --apply
 */
import fs from 'fs'
import type { PoolClient } from 'pg'
import { getClient } from '../db'

/** Mountain View RV Ranch — the park Campground Master was running. */
export const MOUNTAIN_VIEW_LANDLORD = '96ec7df3-362d-4777-b54c-e9604313820f'

type Q = Pick<PoolClient, 'query'>

export interface SourceRow { [column: string]: string }

export interface Person {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  notes: string | null
  elsewhereRef: string
}

export interface Dropped { row: number; name: string; why: string }
export interface SamePerson { why: string; names: string[] }

export interface ImportPlan {
  people: Person[]
  dropped: Dropped[]
  /** Printed for a human to judge — NEVER merged by this script. */
  lookAlike: SamePerson[]
}

/**
 * A comma-separated file as the old system writes it: quoted fields, doubled
 * quotes inside them, and newlines inside a quoted note.
 */
export function parseCsv(text: string): SourceRow[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [header, ...rest] = rows
  if (!header) return []
  return rest
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()
const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

/** Ten digits, the shape the rest of GAM stores (users.phone). */
export function tidyPhone(raw: string): string | null {
  const d = (raw || '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? ten : null
}

export function tidyEmail(raw: string): string | null {
  const e = (raw || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

/**
 * Why a row is not a person. Null when it is one.
 *
 * `hasContact` is the benefit of the doubt: a thin name with a phone number
 * attached to it is somebody the desk met and recorded badly — "RJ" is a real
 * person if there is a number to ring. A thin name with nothing attached is a
 * placeholder somebody typed to get a reservation saved. A name with no letters
 * in it at all ("719" — a site number) is never a person either way, because
 * nobody will ever find them by it.
 */
export function notAName(first: string, last: string, hasContact = false): string | null {
  const whole = squeeze(`${first} ${last}`)
  if (!whole) return 'no name at all'
  const bare = whole.replace(/\s/g, '')
  if (!/[a-z]/i.test(bare)) return 'no letters in it'
  if (bare.replace(/[^a-z]/gi, '').length <= 2 && !hasContact) return 'a letter or two, and nothing to reach them by'
  if (/^(.)\1+$/i.test(bare.replace(/[^a-z]/gi, ''))) return 'the same letter over and over'
  if (/\b(test|testing|xxx+|aaa+|zzz+|unknown|n\/?a|none|delete|do ?not ?use|dummy|sample)\b/i.test(whole)) {
    return 'a placeholder, not a person'
  }
  return null
}

/** Read-only: everything --apply would write. */
export function planFromCsv(text: string): ImportPlan {
  const rows = parseCsv(text)
  const people: Person[] = []
  const dropped: Dropped[] = []
  const usedRef = new Map<string, number>()

  rows.forEach((r, i) => {
    const first = squeeze(r['First Names'] || '')
    const last = squeeze(r['Last Name'] || '')
    const phone = tidyPhone(r['Phone 1'] || '') ?? tidyPhone(r['Phone 2'] || '') ?? tidyPhone(r['Phone 3'] || '')
    const email = tidyEmail(r['Email'] || '')
    const why = notAName(first, last, !!(phone || email))
    if (why) { dropped.push({ row: i + 2, name: squeeze(`${first} ${last}`) || '(blank)', why }); return }
    // The old system's own note, kept as it was written. Nothing is invented
    // and nothing of theirs is thrown away (gam-data-retention-keep-everything).
    const notes = squeeze(r['Notes'] || '') || null

    // Stable across runs, and unique even when two rows really are the same
    // name — the ordinal keeps them apart without claiming they are different
    // people, which is the judgement this script refuses to make.
    const base = `cgm:${lettersOnly(last)}:${lettersOnly(first)}`
    const n = (usedRef.get(base) ?? 0) + 1
    usedRef.set(base, n)

    people.push({
      firstName: first || last,
      lastName: first ? last : '',
      email,
      phone,
      notes,
      elsewhereRef: n === 1 ? base : `${base}:${n}`,
    })
  })

  return { people, dropped, lookAlike: lookAlikes(people) }
}

/** Pairs worth a human's eye. Printed, never acted on. */
export function lookAlikes(people: Person[]): SamePerson[] {
  const out: SamePerson[] = []
  const name = (p: Person) => squeeze(`${p.firstName} ${p.lastName}`)

  const byName = new Map<string, Person[]>()
  const byPhone = new Map<string, Person[]>()
  for (const p of people) {
    const k = `${lettersOnly(p.lastName)}|${lettersOnly(p.firstName)}`
    byName.set(k, [...(byName.get(k) ?? []), p])
    if (p.phone) byPhone.set(p.phone, [...(byPhone.get(p.phone) ?? []), p])
  }
  for (const group of byName.values()) {
    if (group.length > 1) out.push({ why: 'the same name', names: group.map(name) })
  }
  for (const group of byPhone.values()) {
    if (group.length > 1) out.push({ why: 'the same phone number', names: group.map(name) })
  }
  // 10/21 (Nic's own test case): "Val" and "Valerie" Sutherland. One first name
  // being the start of another under the same surname is the shape a nickname
  // takes — and also the shape a mother and daughter take, which is why this
  // only ever prints.
  const bySurname = new Map<string, Person[]>()
  for (const p of people) {
    const s = lettersOnly(p.lastName)
    if (s) bySurname.set(s, [...(bySurname.get(s) ?? []), p])
  }
  for (const group of bySurname.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const fa = lettersOnly(group[a].firstName)
        const fb = lettersOnly(group[b].firstName)
        if (fa && fb && fa !== fb && (fa.startsWith(fb) || fb.startsWith(fa))) {
          out.push({ why: 'one first name is the start of the other', names: [name(group[a]), name(group[b])] })
        }
      }
    }
  }
  return out
}

export interface Written { added: number; updated: number }

/**
 * Idempotent on (landlord_id, elsewhere_ref). A second run fills in contact
 * details that were blank before and leaves anything already there alone —
 * a number somebody typed at the counter beats one out of an old file.
 */
export async function writePeople(q: Q, landlordId: string, people: Person[]): Promise<Written> {
  let added = 0, updated = 0
  for (const p of people) {
    const res = await q.query<{ inserted: boolean }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, notes, created_from, elsewhere_ref)
       VALUES ($1,$2,$3,$4,$5,$6,'import',$7)
       ON CONFLICT (landlord_id, elsewhere_ref) WHERE archived_at IS NULL AND elsewhere_ref IS NOT NULL
       DO UPDATE SET
         email = COALESCE(pos_customers.email, EXCLUDED.email),
         phone = COALESCE(pos_customers.phone, EXCLUDED.phone),
         notes = COALESCE(pos_customers.notes, EXCLUDED.notes),
         updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [landlordId, p.firstName, p.lastName, p.email, p.phone, p.notes, p.elsewhereRef])
    if (res.rows[0]?.inserted) added++; else updated++
  }
  return { added, updated }
}

async function main() {
  const file = process.argv[2]
  const apply = process.argv.includes('--apply')
  if (!file || file.startsWith('--')) {
    console.error('Give it the customer file: importCampgroundMasterCustomers.ts <file.csv> [--apply]')
    process.exit(1)
  }
  const plan = planFromCsv(fs.readFileSync(file, 'utf8'))

  console.log(`\n  ${plan.people.length} people to bring over.`)
  console.log(`    with an email: ${plan.people.filter(p => p.email).length}`)
  console.log(`    with a phone:  ${plan.people.filter(p => p.phone).length}`)
  console.log(`    name only:     ${plan.people.filter(p => !p.email && !p.phone).length}`)

  if (plan.dropped.length) {
    console.log(`\n  ${plan.dropped.length} row(s) left behind — not names:`)
    for (const d of plan.dropped) console.log(`    line ${d.row}: "${d.name}" — ${d.why}`)
  }
  if (plan.lookAlike.length) {
    console.log(`\n  ${plan.lookAlike.length} pair(s) that MIGHT be one person. Nothing is merged — have a look:`)
    for (const s of plan.lookAlike) console.log(`    ${s.why}: ${s.names.join('  ·  ')}`)
  }

  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const w = await writePeople(client, MOUNTAIN_VIEW_LANDLORD, plan.people)
    await client.query('COMMIT')
    console.log(`\n  Added ${w.added}, updated ${w.updated}.\n`)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
