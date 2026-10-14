/**
 * 10/13 (Nic) — the birthdays typed on signed leases ("Birthdate 1/2/3"),
 * copied onto the people they belong to: matched to the name beside each box
 * and to the person by that name on that lease, never guessed, never
 * overwriting a birthday already on file, and safe to run again.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  copyLeaseBirthdates, planLeaseBirthdates, readTypedDate, believableBirthday, normalizeName, normalizeNameSql,
  BIRTHDATE_SKIP_REASONS, BIRTHDATE_SKIP_REASON_LABEL,
} from './leaseBirthdates'
import { formatRun } from '../scripts/oct13_lease_birthdates_backfill'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const dob = async (table: 'tenants' | 'lease_occupants', id: string) =>
  (await db.query(`SELECT date_of_birth::text AS d FROM ${table} WHERE id = $1`, [id])).rows[0].d as string | null

/** A landlord, and a way to make leases with people and signed documents on them. */
async function world() {
  return tx(async c => {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    return { landlordId, propertyId }
  })
}

async function person(first: string, last: string, birthday: string | null = null) {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'tenant', $2, $3, TRUE) RETURNING id`, [`t-${randomUUID()}@test.dev`, first, last])
  const t = await db.query<{ id: string }>(
    `INSERT INTO tenants (user_id, date_of_birth) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, birthday])
  return { userId: u.rows[0].id, tenantId: t.rows[0].id, name: `${first} ${last}` }
}

async function lease(w: { landlordId: string; propertyId: string }, people: Array<{ tenantId: string }>) {
  return tx(async c => {
    const unitId = await seedUnit(c, { propertyId: w.propertyId, landlordId: w.landlordId })
    const l = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-06-01') RETURNING id`, [unitId, w.landlordId])).rows[0].id
    for (const [i, p] of people.entries()) {
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, $3)`,
        [l, p.tenantId, i === 0 ? 'primary' : 'co_tenant'])
    }
    return { leaseId: l, unitId }
  })
}

/**
 * A lease document with the people table filled in: `boxes` is label → value
 * ("Tenant name 1" → "Pat Rivera", "Birthdate 1" → "3/29/1960"). `signers`
 * signs it under the given names.
 */
async function signedDoc(
  w: { landlordId: string }, leaseId: string, boxes: Record<string, string>,
  o: { status?: string; signers?: Array<{ userId: string; name: string }>; signedOn?: string } = {},
) {
  return tx(async c => {
    const d = (await c.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, lease_id, title, status, completed_at)
       VALUES ($1, $2, 'Lease', $3, $4) RETURNING id`,
      [w.landlordId, leaseId, o.status ?? 'completed', `${o.signedOn ?? '2026-06-01'} 12:00:00-07`])).rows[0].id
    for (const [label, value] of Object.entries(boxes)) {
      const n = /(\d+)$/.exec(label)?.[1]
      const column = /^tenant name/i.test(label) ? (n === '1' || !n ? 'tenant_name' : `tenant_${n}_name`) : null
      await c.query(
        `INSERT INTO lease_document_fields (document_id, field_type, label, lease_column, value, page, signed_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [d, /birth/i.test(label) ? 'date' : 'text', label, column, value, `${o.signedOn ?? '2026-06-01'} 12:00:00-07`])
    }
    for (const s of o.signers ?? []) {
      await c.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, token, status, signed_at)
         VALUES ($1, $2, 'primary', $3, $4, $5, 'signed', NOW())`,
        [d, s.userId, s.name, `s-${randomUUID()}@test.dev`, randomUUID()])
    }
    return d
  })
}

describe('reading what was typed', () => {
  it('reads the form\'s M/D/YYYY, and ISO; a two-digit year or an impossible day does not read', () => {
    expect(readTypedDate('3/29/1960')).toBe('1960-03-29')
    expect(readTypedDate(' 11/3/1998 ')).toBe('1998-11-03')
    expect(readTypedDate('1980-09-20')).toBe('1980-09-20')
    expect(readTypedDate('02-12-2004')).toBe('2004-02-12')
    expect(readTypedDate('1/2/63')).toBeNull()
    expect(readTypedDate('13/45/1980')).toBeNull()
    expect(readTypedDate('2/30/1980')).toBeNull()
    expect(readTypedDate('')).toBeNull()
  })

  it('a birthday is before the signing, and not more than 120 years before it', () => {
    expect(believableBirthday('1960-03-29', '2026-06-01')).toBe(true)
    expect(believableBirthday('2026-06-01', '2026-06-01')).toBe(false) // the signing date typed in the box
    expect(believableBirthday('2030-01-01', '2026-06-01')).toBe(false)
    expect(believableBirthday('1900-01-01', '2026-06-01')).toBe(false)
  })

  it('compares names the way people type them, in code and in SQL alike', async () => {
    expect(normalizeName('  Little  Joe  Martinez. ')).toBe('little joe martinez')
    expect(normalizeName("O'Neil-Smith, Jr.")).toBe('oneil smith jr')
    const r = await db.query(`SELECT ${normalizeNameSql('$1::text')} AS n`, ["  O'Neil-Smith,  Jr. "])
    expect(r.rows[0].n).toBe(normalizeName("  O'Neil-Smith,  Jr. "))
  })

  it('every reason it can leave one alone has words', () => {
    for (const r of BIRTHDATE_SKIP_REASONS) expect(BIRTHDATE_SKIP_REASON_LABEL[r]).toMatch(/\w/)
  })
})

describe('copyLeaseBirthdates', () => {
  it('copies each typed birthdate onto the person named beside it — tenants and occupants', async () => {
    const w = await world()
    const pat = await person('Pat', 'Rivera')
    const lee = await person('Lee', 'Rivera')
    const { leaseId } = await lease(w, [pat, lee])
    const mia = (await db.query<{ id: string }>(
      `INSERT INTO lease_occupants (lease_id, full_name) VALUES ($1, 'Mia Rivera') RETURNING id`, [leaseId])).rows[0].id
    await signedDoc(w, leaseId, {
      'Tenant name 1': 'Pat Rivera', 'Tenant name 2': 'Lee Rivera', 'Tenant name 3': 'mia rivera',
      // The boxes are not in the order of the people on the lease: the name beside each decides.
      'Birthdate 2': '5/1/1990', 'Birthdate 1': '3/29/1960', 'Birthdate 3': '1/1/2015',
    })

    const dry = await copyLeaseBirthdates({ apply: false })
    expect(dry.tenantsWritten).toBe(2)
    expect(dry.occupantsWritten).toBe(1)
    expect(dry.lines.every(l => l.outcome === 'write')).toBe(true)
    expect(await dob('tenants', pat.tenantId)).toBeNull() // a dry run writes nothing

    const run = await copyLeaseBirthdates({ apply: true })
    expect(run.tenantsWritten).toBe(2)
    expect(run.occupantsWritten).toBe(1)
    expect(await dob('tenants', pat.tenantId)).toBe('1960-03-29')
    expect(await dob('tenants', lee.tenantId)).toBe('1990-05-01')
    expect(await dob('lease_occupants', mia)).toBe('2015-01-01')

    // Again: nothing new, nothing changed.
    const again = await copyLeaseBirthdates({ apply: true })
    expect(again.tenantsWritten + again.occupantsWritten).toBe(0)
    expect(again.lines.every(l => l.outcome === 'already_on_file')).toBe(true)
  })

  it('matches the name a tenant signed under, and one tenant on two leases with the same birthday is written once', async () => {
    const w = await world()
    const joe = await person('Joe', 'Martinez')
    const a = await lease(w, [joe])
    const b = await lease(w, [joe])
    await signedDoc(w, a.leaseId, { 'Tenant name 1': 'Little Joe Martinez', 'Birthdate 1': '5/19/1987' },
      { signers: [{ userId: joe.userId, name: 'Little Joe Martinez' }] })
    await signedDoc(w, b.leaseId, { 'Tenant name 1': 'Joe Martinez', 'Birthdate 1': '5/19/1987' })
    const run = await copyLeaseBirthdates({ apply: true })
    expect(run.lines.map(l => l.outcome)).toEqual(['write', 'write'])
    expect(run.tenantsWritten).toBe(1)
    expect(await dob('tenants', joe.tenantId)).toBe('1987-05-19')
  })

  it('never guesses: each one it cannot place is reported with its reason and not written', async () => {
    const w = await world()
    const sam = await person('Sam', 'Ortiz')
    const kim = await person('Kim', 'Lane')
    const ray = await person('Ray', 'Diaz', '2000-01-15')
    const twin1 = await person('Alex', 'Kay')
    const twin2 = await person('Alex', 'Kay')
    const vic = await person('Vic', 'Ng')

    const l1 = await lease(w, [sam])
    await signedDoc(w, l1.leaseId, { 'Tenant name 1': 'Sam Ortiz', 'Birthdate 1': '13/45/1980' })
    const l2 = await lease(w, [kim])
    await signedDoc(w, l2.leaseId, { 'Tenant name 1': 'Nobody Here', 'Birthdate 1': '1/1/1970' })
    await signedDoc(w, l2.leaseId, { 'Birthdate 1': '2/2/1972' }) // no name beside it
    const l3 = await lease(w, [ray])
    await signedDoc(w, l3.leaseId, { 'Tenant name 1': 'Ray Diaz', 'Birthdate 1': '1/16/2000' })
    const l4 = await lease(w, [twin1, twin2])
    await signedDoc(w, l4.leaseId, { 'Tenant name 1': 'Alex Kay', 'Birthdate 1': '7/7/1977' })
    const l5 = await lease(w, [vic])
    const l6 = await lease(w, [vic])
    await signedDoc(w, l5.leaseId, { 'Tenant name 1': 'Vic Ng', 'Birthdate 1': '3/3/1983' })
    await signedDoc(w, l6.leaseId, { 'Tenant name 1': 'Vic Ng', 'Birthdate 1': '3/4/1983' })
    // The signing day typed into the box.
    const l7 = await lease(w, [sam])
    await signedDoc(w, l7.leaseId, { 'Tenant name 1': 'Sam Ortiz', 'Birthdate 1': '6/1/2026' })
    // Not signed yet: not read at all.
    await signedDoc(w, l1.leaseId, { 'Tenant name 1': 'Sam Ortiz', 'Birthdate 1': '9/20/1980' }, { status: 'sent' })

    const run = await copyLeaseBirthdates({ apply: true })
    const reasons = run.lines.map(l => l.reason).sort()
    expect(reasons).toEqual([
      'has_a_different_birthday',
      'no_name_beside',
      'nobody_by_that_name',
      'several_people_by_that_name',
      'two_different_birthdays', 'two_different_birthdays',
      'unreadable_date', 'unreadable_date',
    ].sort())
    expect(run.tenantsWritten).toBe(0)
    for (const p of [sam, kim, twin1, twin2, vic]) expect(await dob('tenants', p.tenantId)).toBeNull()
    expect(await dob('tenants', ray.tenantId)).toBe('2000-01-15') // never overwritten

    // The script says each one in words.
    const text = formatRun(run)
    expect(text).toContain('Left alone: 8')
    expect(text).toContain(BIRTHDATE_SKIP_REASON_LABEL.has_a_different_birthday)
    expect(text).not.toMatch(/several_people_by_that_name|nobody_by_that_name/)
  })

  it('a name box of another label still places it when every box of that number agrees', async () => {
    const w = await world()
    const pat = await person('Pat', 'Rivera')
    const { leaseId } = await lease(w, [pat])
    const d = await tx(async c => {
      const doc = (await c.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, lease_id, title, status, completed_at)
         VALUES ($1, $2, 'Lease', 'completed', '2026-06-01 12:00:00-07') RETURNING id`, [w.landlordId, leaseId])).rows[0].id
      for (const [label, column, value] of [
        ['Resident', 'tenant_name', 'Pat Rivera'], ['Tenant name', 'tenant_name', 'PAT RIVERA'],
        ['Birthdate', null, '3/29/1960'],
      ]) {
        await c.query(`INSERT INTO lease_document_fields (document_id, field_type, label, lease_column, value)
                       VALUES ($1, 'text', $2, $3, $4)`, [doc, label, column, value])
      }
      return doc
    })
    const lines = await planLeaseBirthdates((sql, p) => db.query(sql, p), { documentId: d })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ outcome: 'write', nameBeside: 'Pat Rivera', birthday: '1960-03-29' })
  })

  it('one signed document (the signing hook) writes only that document\'s people', async () => {
    const w = await world()
    const pat = await person('Pat', 'Rivera')
    const sam = await person('Sam', 'Ortiz')
    const a = await lease(w, [pat])
    const b = await lease(w, [sam])
    const docA = await signedDoc(w, a.leaseId, { 'Tenant name 1': 'Pat Rivera', 'Birthdate 1': '3/29/1960' })
    await signedDoc(w, b.leaseId, { 'Tenant name 1': 'Sam Ortiz', 'Birthdate 1': '9/20/1980' })
    const run = await copyLeaseBirthdates({ documentId: docA, apply: true })
    expect(run.lines).toHaveLength(1)
    expect(await dob('tenants', pat.tenantId)).toBe('1960-03-29')
    expect(await dob('tenants', sam.tenantId)).toBeNull()
  })
})
