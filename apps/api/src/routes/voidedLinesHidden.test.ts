/**
 * 10/12 (Nic, G9): a VOIDED line (a charge taken off, owed by nobody, kept as
 * a record) is hidden in the tenant's payments list, on the Balances page's
 * bill lines, and in the two assistant "recent payments" answers. It stays on
 * file and in the full history.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { tenantsRouter } from './tenants'
import { balancesRouter } from './balances'
import { getMyPayments } from '../services/agents/tools/getMyPayments'
import { lookupTenantPaymentStatus } from '../services/agents/tools/lookupTenantPaymentStatus'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_voided_lines'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/tenants', tenantsRouter)
  a.use('/api/balances', balancesRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => { await cleanupAllSchema() })

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET unit_number = 'RV 9' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Vera', last_name = 'Voidtest' WHERE id = $1`, [tenantUserId])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const inv = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_fees, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-V-1','2026-10-01',500,0,500,'pending') RETURNING id`, [landlordId, tenantId, leaseId, unitId])).rows[0].id
    const rent = (await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',500,'pending','2026-10-01','RENT') RETURNING id`,
      [inv, unitId, leaseId, tenantId, landlordId])).rows[0].id
    const fee = (await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'fee',35,'pending','2026-10-01','OTHERFEE') RETURNING id`,
      [inv, unitId, leaseId, tenantId, landlordId])).rows[0].id
    await c.query(
      `UPDATE payments SET status = 'voided', voided_at = now(), void_reason = 'Test: taken off' WHERE id = $1`, [fee])
    await c.query('COMMIT')
    const tenantToken = jwt.sign({ userId: tenantUserId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const landlordToken = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, tenantId, tenantUserId, rent, fee, tenantToken, landlordToken }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('a voided line is hidden where people read their payments', () => {
  it('the tenant\'s payments list', async () => {
    const f = await seed()
    const r = await request(app()).get('/api/tenants/payments').set('Authorization', `Bearer ${f.tenantToken}`)
    expect(r.status).toBe(200)
    expect(r.body.data.map((p: any) => p.id)).toEqual([f.rent])
  })

  it('the Balances page\'s bill lines', async () => {
    const f = await seed()
    const r = await request(app()).get(`/api/balances/${f.tenantId}/invoices`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r.status).toBe(200)
    const ids = JSON.stringify(r.body.data)
    expect(ids).toContain(f.rent)
    expect(ids).not.toContain(f.fee)
  })

  it('the assistant\'s recent payments — the tenant\'s own and the landlord\'s lookup', async () => {
    const f = await seed()
    const mine: any = await getMyPayments.execute({}, { userId: f.tenantUserId, role: 'tenant', profileId: f.tenantId } as any)
    const listed = JSON.stringify(mine)
    expect(listed).toContain('rent')
    expect(listed).not.toMatch(/voided/)
    const theirs: any = await lookupTenantPaymentStatus.execute({ tenant: 'Voidtest' },
      { userId: f.userId, role: 'landlord', profileId: '', landlordIds: [f.landlordId] } as any)
    const recent = theirs.recentPayments ?? theirs.tenants?.[0]?.recentPayments ?? theirs.matches?.[0]?.recentPayments
    expect(recent).toBeTruthy()
    expect(recent.map((p: any) => p.status)).toEqual(['pending'])
  })

  it('the voided line stays on file', async () => {
    const f = await seed()
    const row = (await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [f.fee])).rows[0]
    expect(row).toEqual({ status: 'voided', amount: 35 })
  })
})
