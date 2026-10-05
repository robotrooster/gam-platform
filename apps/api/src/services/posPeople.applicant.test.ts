/**
 * 10/5 (Nic): everyone who runs a background check for a company is a customer
 * at its register — approved or not — with their name and email ready.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { applicantRegisterRecord } from './posPeople'

beforeEach(async () => { await cleanupAllSchema() })

async function applicant(email = `applicant-${randomUUID().slice(0, 6)}@park.dev`) {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name) VALUES ($1,'x','tenant','','') RETURNING id`, [email])).rows[0].id
  const tenantId = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])).rows[0].id
  return { email, tenantId }
}
const company = async () => {
  const c = await db.connect()
  try { return (await seedLandlord(c)).landlordId } finally { c.release() }
}
const record = async (id: string) => (await db.query(
  `SELECT first_name, last_name, email, tenant_id FROM pos_customers WHERE id = $1`, [id])).rows[0]

describe('an applicant on the register', () => {
  it('gets one record with the legal name from the application and their email', async () => {
    const landlordId = await company(); const a = await applicant('Robert.H@Park.dev')
    const id = await applicantRegisterRecord(db, landlordId, a.tenantId, { firstName: ' Robert ', lastName: 'Housley ' })
    expect(await record(id)).toEqual({ first_name: 'Robert', last_name: 'Housley', email: 'robert.h@park.dev', tenant_id: a.tenantId })
    // A second screening for the same company: the same record, nothing doubled.
    expect(await applicantRegisterRecord(db, landlordId, a.tenantId, { firstName: 'Bob', lastName: 'H' })).toBe(id)
    expect((await record(id)).first_name).toBe('Robert')
    expect((await db.query(`SELECT count(*)::int AS n FROM pos_customers WHERE landlord_id = $1`, [landlordId])).rows[0].n).toBe(1)
  })

  it('an email another record here already holds is left off — one record per address', async () => {
    const landlordId = await company(); const a = await applicant('shared@park.dev')
    await db.query(`INSERT INTO pos_customers (landlord_id, first_name, last_name, email) VALUES ($1,'Front','Desk','shared@park.dev')`, [landlordId])
    const id = await applicantRegisterRecord(db, landlordId, a.tenantId, { firstName: 'A', lastName: 'B' })
    expect((await record(id)).email).toBeNull()
  })

  it('each company keeps its own record', async () => {
    const one = await company(); const two = await company(); const a = await applicant()
    const x = await applicantRegisterRecord(db, one, a.tenantId, { firstName: 'A', lastName: 'B' })
    const y = await applicantRegisterRecord(db, two, a.tenantId, { firstName: 'A', lastName: 'B' })
    expect(x).not.toBe(y)
  })
})
