/**
 * S652 — the landlord-tenant act for a tenant's home, in their portal.
 *
 * Nic: "the applicable Landlord Tenant Act shows up in the tenant's portal...
 * accessible automatically to all tenants based on how the unit type is set up."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_q, res, next) => { const j = res.json.bind(res); res.json = (b: any) => j(camelCaseKeys(b)); next() })
  a.use('/api/tenants', tenantsRouter)
  a.use(errorHandler)
  return a
}

let tok: string
async function tenantIn(state: string, unitType: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const p = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, state })
    const u = await seedUnit(c, { propertyId: p, landlordId: ll.landlordId, unitType })
    const t = await seedTenant(c)
    const l = await seedLease(c, { unitId: u, landlordId: ll.landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: l, tenantId: t })
    const tu = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [t])
    await c.query('COMMIT')
    tok = jwt.sign({ userId: tu.rows[0].user_id, role: 'tenant', email: 't@test.dev', profileId: t, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
async function shelve(jurisdiction: string, type: string, name: string, units: string[] | null) {
  await query(
    `INSERT INTO disclosure_library_documents (disclosure_type, jurisdiction, applies_to, unit_types, name, source_name, source_url, base_pdf_url, publication_ref)
     VALUES ($1,$2,'any',$3,$4,'State Agency','https://x.gov','/api/esign/files/x.pdf','2024 edition')`, [type, jurisdiction, units, name])
}

beforeEach(async () => {
  await cleanupAllSchema()
  await query(`DELETE FROM disclosure_library_fields`); await query(`DELETE FROM disclosure_library_documents`)
  await shelve('AZ', 'landlord_tenant_act', 'Arizona: Mobile Home Parks Act', ['mobile_home'])
  await shelve('AZ', 'landlord_tenant_act', 'Arizona: Residential Act', ['apartment', 'mobile_home'])
  await shelve('AZ', 'tenant_rights_guide', 'Arizona: Tenant Guide', null)
  await shelve('AZ', 'bed_bugs', 'Arizona: Bed Bugs', null)                 // not a law — never listed
  await shelve('IL', 'landlord_tenant_act', 'Illinois: Mobile Home Act', ['mobile_home'])
})

describe('GET /api/tenants/me/laws', () => {
  it('gives a mobile home tenant their state\'s acts for that kind of home, law first, with the edition', async () => {
    await tenantIn('AZ', 'mobile_home')
    const homes = (await request(app()).get('/api/tenants/me/laws').set('Authorization', `Bearer ${tok}`).expect(200)).body.data
    expect(homes).toHaveLength(1)
    expect(homes[0].documents.map((d: any) => [d.name, d.kind])).toEqual([
      ['Arizona: Mobile Home Parks Act', 'act'],
      ['Arizona: Residential Act', 'act'],
      ['Arizona: Tenant Guide', 'guide'],
    ])
    expect(homes[0].documents[0].edition).toBe('2024 edition')
  })

  it('an apartment tenant does not get the mobile home act; another state\'s never appears', async () => {
    await tenantIn('AZ', 'apartment')
    const names = (await request(app()).get('/api/tenants/me/laws').set('Authorization', `Bearer ${tok}`).expect(200))
      .body.data[0].documents.map((d: any) => d.name)
    expect(names).toEqual(['Arizona: Residential Act', 'Arizona: Tenant Guide'])
  })
})
