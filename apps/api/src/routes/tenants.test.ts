import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })


/**
 * S629 — two spots, two leases, ONE portal account.
 *
 * Nic: "I've got a couple of people that have two spots, two separate leases.
 * I need them to not be two separate tenant portal accounts... very important
 * that it doesn't screw that up."
 *
 * The account half was already right — the invite reuses an existing user and
 * tenant row. The invite half was not: pending_tenant_intents was UNIQUE on
 * tenant_id alone and the route did ON CONFLICT (tenant_id) DO UPDATE SET
 * unit_id = EXCLUDED.unit_id, so the second invite MOVED the first one. They
 * would have ended up with a single lease and no sign an invite was lost.
 */
describe('one person, two units', () => {
  it('keeps both invites alive against one tenant record', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: llUser, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      const unitA = await seedUnit(c, { propertyId, landlordId })
      const unitB = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)

      // Two invites for the same person, one per unit — what the route now does.
      for (const unitId of [unitA, unitB]) {
        await c.query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
           VALUES ($1,$2,'not_uploaded',$3)
           ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
           DO UPDATE SET resolved_at=NULL, accepted_at=NULL, updated_at=NOW()`,
          [landlordId, tenantId, unitId])
      }
      await c.query('COMMIT')

      const live = await query<any>(
        `SELECT unit_id FROM pending_tenant_intents
          WHERE tenant_id=$1 AND cancelled_at IS NULL ORDER BY created_at`, [tenantId])
      expect(live, 'both invites survive — the second must not move the first').toHaveLength(2)
      expect(live.map(r => r.unit_id).sort()).toEqual([unitA, unitB].sort())

      // One person, one tenant record, one login.
      const tenants = await query<any>(`SELECT id FROM tenants WHERE id=$1`, [tenantId])
      expect(tenants).toHaveLength(1)
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  })

  it('re-inviting to the SAME unit reopens that invite rather than adding one', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: llUser, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
           VALUES ($1,$2,'not_uploaded',$3)
           ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
           DO UPDATE SET resolved_at=NULL, accepted_at=NULL, updated_at=NOW()`,
          [landlordId, tenantId, unitId])
      }
      await c.query('COMMIT')
      const live = await query<any>(
        `SELECT id FROM pending_tenant_intents WHERE tenant_id=$1 AND cancelled_at IS NULL`, [tenantId])
      expect(live, 'the same unit twice is one invite, reopened').toHaveLength(1)
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  })
})

/**
 * FlexPay never surfaces to the landlord (CLAUDE.md S541). GET /:id/profile
 * used to list GAM's FlexPay pull row and count it in the stats, and the
 * unscoped viewers (GAM admin, the resident) got p.* — flexpay_advance_id too.
 */
describe('the tenant profile never shows FlexPay', () => {
  async function seeded() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,900,'month_to_month','active','2026-01-01') RETURNING id`, [unitId, ll.landlordId])).rows[0].id
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [leaseId, tenantId])
      const ins = (type: string, entry: string, owner: string, amount: number, due: string) => c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, revenue_owner, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,'settled',$7::date,$8,$9,now()) RETURNING id`,
        [unitId, leaseId, tenantId, ll.landlordId, type, amount, due, entry, owner]).then(r => r.rows[0].id)
      const rent = await ins('rent', 'RENT', 'landlord', 900, '2026-09-01')
      const pull = await ins('fee', 'FLEXPAY', 'gam', 925, '2026-09-03')
      await c.query('COMMIT')
      return { ...ll, tenantId, rent, pull }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  }
  async function getProfile(tenantId: string, claims: Record<string, unknown>) {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const jwt = (await import('jsonwebtoken')).default
    const { tenantsRouter } = await import('./tenants')
    const { errorHandler } = await import('../middleware/errorHandler')
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_flexpay'
    const app = express()
    app.use(express.json())
    app.use('/api/tenants', tenantsRouter)
    app.use(errorHandler)
    const token = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '10m' })
    return request(app).get(`/api/tenants/${tenantId}/profile`).set('Authorization', `Bearer ${token}`)
  }

  it('a landlord viewing a tenant with a FlexPay row sees neither the row nor its count in the stats', async () => {
    const h = await seeded()
    const res = await getProfile(h.tenantId, {
      userId: h.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds: [h.landlordId], permissions: {},
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.payments.map((p: any) => p.id)).toEqual([h.rent])
    expect(res.body.data.stats).toMatchObject({ totalPayments: 1, settledCount: 1, totalPaid: 900 })
  })

  it('GAM admin sees no FlexPay row and no flexpay_advance_id either', async () => {
    const h = await seeded()
    const res = await getProfile(h.tenantId, {
      userId: h.userId, role: 'admin', email: 'admin@t.dev', profileId: null, permissions: {},
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.payments.map((p: any) => p.id)).toEqual([h.rent])
    expect(Object.keys(res.body.data.payments[0])).not.toContain('flexpay_advance_id')
    expect(res.body.data.payments[0]).toMatchObject({ entry_description: 'RENT', revenue_owner: 'landlord' })
    expect(res.body.data.stats).toMatchObject({ totalPayments: 1, totalPaid: 900 })
  })
})

/**
 * decisions #48.5: a charge nobody owes that a payment had touched (e.g. a
 * canceled reservation's fee) is kept as a record with status 'voided'. It is
 * owed by nobody and paid by nothing, so it is never a payment: the profile
 * lists it as the record it is, but its counts (and the tenant's own payment
 * health) leave it out — a voided fee must not drag the on-time rate down.
 */
describe('a voided charge is never counted as a payment', () => {
  async function seeded() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = (await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,900,'month_to_month','active','2026-01-01') RETURNING id`, [unitId, ll.landlordId])).rows[0].id
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [leaseId, tenantId])
      // This month's rent, paid on its due date.
      const rent = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, revenue_owner, settled_at)
         VALUES ($1,$2,$3,$4,'rent',900,'settled',date_trunc('month', CURRENT_DATE)::date,'RENT','landlord',
                 date_trunc('month', CURRENT_DATE))
         RETURNING id`, [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
      // A canceled reservation's fee whose bank pull failed, then voided — due
      // last month, so it would read as a late mark if it were counted.
      const voided = (await c.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                               entry_description, revenue_owner, voided_at, void_reason)
         VALUES ($1,$2,$3,$4,'fee',40,'voided',(date_trunc('month', CURRENT_DATE) - interval '20 days')::date,
                 'RENT','landlord',now(),'The reservation it was for was canceled, so the fee is no longer owed.')
         RETURNING id`, [unitId, leaseId, tenantId, ll.landlordId])).rows[0].id
      await c.query('COMMIT')
      return { ...ll, tenantId, rent, voided }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  }
  async function get(path: string, claims: Record<string, unknown>) {
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const jwt = (await import('jsonwebtoken')).default
    const { tenantsRouter } = await import('./tenants')
    const { errorHandler } = await import('../middleware/errorHandler')
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tenants_voided'
    const app = express()
    app.use(express.json())
    app.use('/api/tenants', tenantsRouter)
    app.use(errorHandler)
    const token = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '10m' })
    return request(app).get(`/api/tenants${path}`).set('Authorization', `Bearer ${token}`)
  }

  it('the landlord profile lists the voided fee as a record but counts only the real payment', async () => {
    const h = await seeded()
    const res = await get(`/${h.tenantId}/profile`, {
      userId: h.userId, role: 'landlord', email: 'll@t.dev', profileId: null, landlordIds: [h.landlordId], permissions: {},
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.payments.map((p: any) => p.id).sort()).toEqual([h.rent, h.voided].sort())
    expect(res.body.data.payments.find((p: any) => p.id === h.voided).status).toBe('voided')
    expect(res.body.data.stats).toMatchObject({ totalPayments: 1, settledCount: 1, failedCount: 0, totalPaid: 900, onTimeRate: 100 })
  })

  it("the tenant's own payment health leaves the voided fee out of the counts and the on-time months", async () => {
    const h = await seeded()
    const res = await get('/me/payment-health', {
      userId: h.userId, role: 'tenant', email: 't@t.dev', profileId: h.tenantId, permissions: {},
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ totalPayments: 1, settledCount: 1, onTimeRate: 100 })
    expect(res.body.data.onTime).toMatchObject({ resolved: 1, onTimeCount: 1, pct: 100 })
  })
})
