/**
 * 10/13 (Nic) — "If it never completed, it doesn't exist": the one-time
 * cleanup for his two companies, run as its dry run (a READ ONLY transaction:
 * nothing changes), then applied (and run again: nothing left to erase).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import crypto from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  NIC_COMPANIES, PROTECTED_DOCUMENTS, planCleanup, applyCleanup, formatPlan,
} from './oct13_erase_unfinished_documents'

const [OAK_PARK, MOUNTAIN_VIEW] = Object.keys(NIC_COMPANIES)

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (q: any) => Promise<T>, opts: { readOnly?: boolean; commit?: boolean } = {}): Promise<T> {
  const c: PoolClient = await db.connect()
  try {
    await c.query(opts.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN')
    const r = await fn(c.query.bind(c))
    await c.query(opts.commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** A company with a given id (Nic's are fixed), a property and a unit. */
async function company(id: string | null): Promise<{ landlordId: string; unitId: string; userId: string; tenantUserId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const userId = (await c.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','Nic','R',TRUE) RETURNING id`, [`ll-${crypto.randomUUID()}@test.dev`])).rows[0].id
    const landlordId = (await c.query(
      `INSERT INTO landlords (id, user_id, billing_starts_at) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, DATE '2000-01-01') RETURNING id`,
      [id, userId])).rows[0].id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return { landlordId, unitId, userId, tenantUserId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function doc(co: Awaited<ReturnType<typeof company>>, o: {
  id?: string; status: string; title: string; issued?: boolean; type?: string; packet?: string
}): Promise<string> {
  const id = (await query<{ id: string }>(
    `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, issued_at, voided_at, package_group_id)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
             CASE WHEN $7 THEN NOW() END, CASE WHEN $6 = 'voided' THEN NOW() END, $8) RETURNING id`,
    [o.id ?? null, co.landlordId, co.unitId, o.title, o.type ?? 'original_lease', o.status, o.issued === true, o.packet ?? null]))[0].id
  await query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','L','l@test.dev',1,$3,'sent'), ($1,$4,'primary','T','t@test.dev',2,$5,'pending')`,
    [id, co.userId, crypto.randomBytes(16).toString('hex'), co.tenantUserId, crypto.randomBytes(16).toString('hex')])
  await query(`INSERT INTO lease_document_fields (document_id, field_type, page) VALUES ($1,'signature',1)`, [id])
  return id
}

const ids = async () => (await query<{ id: string }>(`SELECT id FROM lease_documents ORDER BY id`)).map(r => r.id)

describe('oct13_erase_unfinished_documents', () => {
  it('the dry run only reads; --apply erases the voided documents nothing touched at Nic\'s two companies, and nothing else; a second run finds nothing', async () => {
    const oak = await company(OAK_PARK)
    const mv = await company(MOUNTAIN_VIEW)
    const other = await company(null)
    const packet = crypto.randomUUID()

    const redraft = await doc(mv, { status: 'voided', title: 'Lease — Unit RV 25' })
    const form1 = await doc(mv, { status: 'voided', title: 'Lead paint', type: 'addendum_terms', packet })
    const form2 = await doc(mv, { status: 'voided', title: 'Bed bugs', type: 'addendum_terms', packet })
    const oakVoided = await doc(oak, { status: 'voided', title: 'Lease — Unit RV 3' })
    const billed = await doc(mv, { status: 'voided', title: 'Lease — Unit RV 09', issued: true })
    const outForSignature = await doc(mv, { status: 'sent', title: 'Lease — Unit MH 08' })
    // Arturo's lease is never touched, whatever state it is in.
    const arturo = await doc(mv, { id: PROTECTED_DOCUMENTS[0], status: 'voided', title: 'Lease — Unit MH 15', packet })
    const otherCompany = await doc(other, { status: 'voided', title: 'Somebody else\'s lease' })
    const done = await doc(oak, { status: 'completed', title: 'Signed lease' })

    const before = await ids()
    const plan = await tx(q => planCleanup(q), { readOnly: true })
    expect(await ids()).toEqual(before)

    const verdict = Object.fromEntries(plan.lines.map(l => [l.id, l.verdict]))
    expect(verdict).toEqual({
      [redraft]: 'erase', [form1]: 'erase', [form2]: 'erase', [oakVoided]: 'erase',
      [billed]: 'kept', [outForSignature]: 'in_progress', [arturo]: 'protected',
    })
    expect(plan.completed).toBe(1)
    const text = formatPlan(plan, 'DRY RUN')
    expect(text).toContain('It issued a lease and billed the household. It stays on record as voided.')
    expect(text).toContain('Arturo\'s MH 15 lease — never touched by this cleanup.')

    const applied = await tx(async q => applyCleanup(q, await planCleanup(q)), { commit: true })
    expect(applied.erased.sort()).toEqual([redraft, form1, form2, oakVoided].sort())
    expect(applied.refused).toEqual([])
    expect((await ids()).sort()).toEqual([billed, outForSignature, arturo, otherCompany, done].sort())
    expect(await query(`SELECT 1 FROM lease_document_signers WHERE document_id = ANY($1::uuid[])`,
      [[redraft, form1, form2, oakVoided]])).toHaveLength(0)

    const again = await tx(q => planCleanup(q), { readOnly: true })
    expect(again.lines.filter(l => l.verdict === 'erase')).toEqual([])
  })

  it('a protected document is never taken along with another: a voided packet lease whose packet holds it stays, and so does it', async () => {
    const mv = await company(MOUNTAIN_VIEW)
    const packet = crypto.randomUUID()
    const packetLease = await doc(mv, { status: 'voided', title: 'Lease — Unit MH 15 (old draft)', packet })
    const guarded = await doc(mv, { id: PROTECTED_DOCUMENTS[0], status: 'voided', title: 'Lead paint', type: 'addendum_terms', packet })

    const plan = await tx(q => planCleanup(q), { readOnly: true })
    const by = Object.fromEntries(plan.lines.map(l => [l.id, l]))
    expect(by[guarded].verdict).toBe('protected')
    expect(by[packetLease].verdict).toBe('kept')
    expect(by[packetLease].why).toContain('is on the list this cleanup never touches')

    const applied = await tx(async q => applyCleanup(q, await planCleanup(q)), { commit: true })
    expect(applied.erased).toEqual([])
    expect((await ids()).sort()).toEqual([packetLease, guarded].sort())
  })
})
