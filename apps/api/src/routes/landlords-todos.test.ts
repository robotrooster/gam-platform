/**
 * landlords.ts /me/todos route slice — S357 (landlords slice 2 of N).
 *
 * Single-route slice for the dashboard to-do rollup. The route runs
 * 5 separate queries (bank readiness / leases / unverified ACH /
 * failed payments / maintenance awaiting_approval) and returns a
 * categorized list.
 *
 * Coverage focus:
 *   - Bank-not-ready triggers 'landlord-bank' todo
 *   - Lease needs_review triggers 'needs_review' todo
 *   - Lease expiring within expiration_notice_days window triggers
 *     'expiring_soon'; outside window stays silent
 *   - **S183 PM-delegation filter:** lease/ACH/payment todos for
 *     properties with pm_company_id set OR managed_by_user_id ≠
 *     caller are filtered out (these are delegated; owner shouldn't
 *     see the day-to-day items)
 *   - Maintenance awaiting_approval ALWAYS shows (always owner
 *     concern regardless of delegation — pre-S183 invariant)
 *   - Failed payment within 30 days triggers 'recent_failure'
 *   - Empty state: all arrays empty, counts.total = 0
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUserBankAccount, seedRentPayment,
} from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_todos'
})

interface TFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
  propertyId:     string
  unitId:         string
  tenantId:       string
}

async function seedTFixture(): Promise<TFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // Set unit active so ACH-not-verified branch can fire (it filters on
    // u.status='active'). Schema default is 'vacant'.
    await client.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
    const tenantId = await seedTenant(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken, propertyId, unitId, tenantId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function getTodos(token: string) {
  return request(buildApp())
    .get('/api/landlords/me/todos')
    .set('Authorization', `Bearer ${token}`)
}

describe('GET /api/landlords/me/todos', () => {
  it('empty fixture (no bank, no leases, no payments, no maintenance) → only landlord-bank todo', async () => {
    const f = await seedTFixture()
    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.leases).toEqual([])
    // No tenant ACH because no v_unit_occupancy primary tenant link yet
    // (seedTenant alone doesn't link to a unit via lease_tenants)
    //
    // S609: a second todo joined this list — 'landlord-bank-feed', connecting
    // the operating bank. That is deliberate (the bank feed belongs in
    // onboarding), so the test is updated rather than the code. Asserted by ID
    // rather than by count, so the next addition names itself instead of just
    // moving a number.
    expect(res.body.data.ach.map((t: any) => t.id).sort())
      .toEqual(['landlord-bank', 'landlord-bank-feed'])
    expect(res.body.data.maintenance).toEqual([])
    expect(res.body.data.counts.total).toBe(2)
  })

  it('bank account active → no landlord-bank todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try { await seedUserBankAccount(client, { userId: f.landlordUserId }) }
    finally { client.release() }
    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    const bankTodos = res.body.data.ach.filter((a: any) => a.id === 'landlord-bank')
    expect(bankTodos.length).toBe(0)
  })

  it('lease needs_review → leases[] has needs_review item', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    let leaseId = ''
    try {
      await client.query('BEGIN')
      leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await client.query(`UPDATE leases SET needs_review=true WHERE id=$1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.leases.length).toBe(1)
    expect(res.body.data.leases[0].type).toBe('needs_review')
    expect(res.body.data.leases[0].id).toBe(leaseId)
    expect(res.body.data.leases[0].title).toMatch(/Lease needs review/)
  })

  it('lease expiring within expiration_notice_days window → expiring_soon todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      // end_date 30 days out; expiration_notice_days=60 (default) → in window
      await client.query(
        `UPDATE leases SET end_date=CURRENT_DATE + INTERVAL '30 days',
                            expiration_notice_days=60
          WHERE id=$1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.leases.length).toBe(1)
    expect(res.body.data.leases[0].type).toBe('expiring_soon')
    expect(res.body.data.leases[0].subtitle).toMatch(/days remaining/)
  })

  it('lease expiring OUTSIDE expiration_notice_days window → no todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      // end_date 200 days out; expiration_notice_days=60 → far outside window
      await client.query(
        `UPDATE leases SET end_date=CURRENT_DATE + INTERVAL '200 days',
                            expiration_notice_days=60
          WHERE id=$1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.leases).toEqual([])
  })

  it('S183 fix: PM-delegated property (pm_company_id set) → leases NOT in todos', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Force the property into PM-delegated state. Direct DB write skips
      // the assignment route's validation (we just need the flag set).
      const co = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, status) VALUES ('PM Co', 'active') RETURNING id`)
      await client.query(
        `UPDATE properties SET pm_company_id=$1 WHERE id=$2`,
        [co.rows[0].id, f.propertyId])
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await client.query(`UPDATE leases SET needs_review=true WHERE id=$1`, [leaseId])
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    // Lease todo filtered out — owner doesn't see day-to-day items on
    // delegated properties.
    expect(res.body.data.leases).toEqual([])
  })

  it('maintenance awaiting_approval ALWAYS shows, even on PM-delegated property', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Delegate the property to a PM company.
      const co = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, status) VALUES ('PM Co', 'active') RETURNING id`)
      await client.query(
        `UPDATE properties SET pm_company_id=$1 WHERE id=$2`,
        [co.rows[0].id, f.propertyId])
      // Seed a maintenance request in 'awaiting_approval' status.
      await client.query(
        `INSERT INTO maintenance_requests
           (unit_id, landlord_id, title, description, status, estimated_cost)
         VALUES ($1, $2, 'Roof leak', 'Water in attic', 'awaiting_approval', 1500)`,
        [f.unitId, f.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.maintenance.length).toBe(1)
    expect(res.body.data.maintenance[0].type).toBe('awaiting_approval')
    expect(res.body.data.maintenance[0].title).toMatch(/Roof leak/)
    expect(res.body.data.maintenance[0].subtitle).toMatch(/\$1,500/)
  })

  it('tenant ACH not verified on active unit → tenant_ach todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // v_unit_occupancy reads from active leases + lease_tenants, so we
      // need a primary lease_tenant linking the tenant to the unit's lease.
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      // Tenant default ach_verified is null/false → triggers the todo.
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    const tenantAchTodos = res.body.data.ach.filter((a: any) => a.type === 'tenant_ach')
    expect(tenantAchTodos.length).toBe(1)
    expect(tenantAchTodos[0].title).toMatch(/ACH not verified/)
  })

  it('failed rent pull in last 30 days → recent_failure todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await seedRentPayment(client, {
        unitId: f.unitId, tenantId: f.tenantId, landlordId: f.landlordId,
        amount: 1500, status: 'failed',
      })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    const failureTodos = res.body.data.ach.filter((a: any) => a.type === 'recent_failure')
    expect(failureTodos.length).toBe(1)
    expect(failureTodos[0].title).toMatch(/Failed rent pull/)
  })

  it('failed rent pull OLDER than 30 days → no todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      const paymentId = await seedRentPayment(client, {
        unitId: f.unitId, tenantId: f.tenantId, landlordId: f.landlordId,
        amount: 1500, status: 'failed',
      })
      // Backdate the due_date past the 30-day window.
      await client.query(
        `UPDATE payments SET due_date = CURRENT_DATE - INTERVAL '60 days' WHERE id=$1`,
        [paymentId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    const failureTodos = res.body.data.ach.filter((a: any) => a.type === 'recent_failure')
    expect(failureTodos.length).toBe(0)
  })

  // S576 (B-8): a work-trade agreement paused (by the lease-end processor)
  // whose tenant now has NO active lease on the unit → surfaces a "renew to
  // resume" todo. A paused agreement WHERE the tenant still has an active lease
  // (a deliberate seasonal/manual pause) does NOT surface — tested below.
  it('paused work-trade + no active lease → work_trade_paused todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status)
         VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '90 days', 'paused')`,
        [f.unitId, f.tenantId, f.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.workTrade.length).toBe(1)
    expect(res.body.data.workTrade[0].type).toBe('work_trade_paused')
    expect(res.body.data.counts.workTrade).toBe(1)
  })

  it('paused work-trade but tenant HAS an active lease (seasonal pause) → no todo', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      await client.query(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status)
         VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '90 days', 'paused')`,
        [f.unitId, f.tenantId, f.landlordId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await getTodos(f.landlordToken)
    expect(res.status).toBe(200)
    expect(res.body.data.workTrade.length).toBe(0)
  })
})

// S582: the onboarding control tower — every landlord-blocked onboarding stage
// surfaces as a to-do so a multi-unit onboard never loses a tenant silently.
describe('GET /api/landlords/me/todos — onboarding control tower', () => {
  const types = (res: any) => res.body.data.onboarding.map((o: any) => o.type)

  it('parsed upload → parser_review item + counted', async () => {
    const f = await seedTFixture()
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1,$2,'parsed')`,
      [f.landlordId, f.tenantId])
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('parser_review')
    expect(res.body.data.counts.onboarding).toBe(1)
    expect(res.body.data.counts.total).toBeGreaterThanOrEqual(1)
  })

  it('accepted but no draft → lease_not_drafted item', async () => {
    const f = await seedTFixture()
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
       VALUES ($1,$2,'not_uploaded',$3, NOW())`,
      [f.landlordId, f.tenantId, f.unitId])
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('lease_not_drafted')
  })

  // A whole_unit lease is one document for the whole roster, so leaseOnboarding
  // holds the draft until everyone accepts. The dashboard used to read that as a
  // failed auto-draft and tell the landlord to draft it — which would have
  // produced a lease missing the co-tenant.
  it('whole_unit, one of two accepted → awaiting_co_tenants, NOT lease_not_drafted', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    let coTenantId: string
    try { coTenantId = await seedTenant(client) } finally { client.release() }
    await db.query(`UPDATE units SET occupancy_mode='whole_unit' WHERE id=$1`, [f.unitId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
       VALUES ($1,$2,'not_uploaded',$3, NOW())`,
      [f.landlordId, f.tenantId, f.unitId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
       VALUES ($1,$2,'not_uploaded',$3, NULL)`,
      [f.landlordId, coTenantId!, f.unitId])
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('awaiting_co_tenants')
    expect(types(res)).not.toContain('lease_not_drafted')
    // one row for the unit, not one per person who already accepted
    expect(types(res).filter((t: string) => t === 'awaiting_co_tenants')).toHaveLength(1)
    const row = res.body.data.onboarding.find((o: any) => o.type === 'awaiting_co_tenants')
    expect(row.title).toContain('1 of 2')
  })

  it('whole_unit, BOTH accepted, no draft → still lease_not_drafted', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    let coTenantId: string
    try { coTenantId = await seedTenant(client) } finally { client.release() }
    await db.query(`UPDATE units SET occupancy_mode='whole_unit' WHERE id=$1`, [f.unitId])
    for (const t of [f.tenantId, coTenantId!]) {
      await db.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
         VALUES ($1,$2,'not_uploaded',$3, NOW())`,
        [f.landlordId, t, f.unitId])
    }
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('lease_not_drafted')
    expect(types(res)).not.toContain('awaiting_co_tenants')
  })

  // by_room means each person gets their OWN lease, so one person not having
  // accepted must not hold up the person who did.
  it('by_room, one of two accepted → lease_not_drafted for the one who accepted', async () => {
    const f = await seedTFixture()
    const client = await db.connect()
    let coTenantId: string
    try { coTenantId = await seedTenant(client) } finally { client.release() }
    await db.query(`UPDATE units SET occupancy_mode='by_room' WHERE id=$1`, [f.unitId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
       VALUES ($1,$2,'not_uploaded',$3, NOW())`,
      [f.landlordId, f.tenantId, f.unitId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at)
       VALUES ($1,$2,'not_uploaded',$3, NULL)`,
      [f.landlordId, coTenantId!, f.unitId])
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('lease_not_drafted')
    expect(types(res)).not.toContain('awaiting_co_tenants')
  })

  it('invite lapsed unaccepted → invite_expired item', async () => {
    const f = await seedTFixture()
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1,$2,'not_uploaded',$3)`,
      [f.landlordId, f.tenantId, f.unitId])
    // expire the tenant's invite
    await db.query(
      `UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day'
        WHERE id = (SELECT user_id FROM tenants WHERE id=$1)`, [f.tenantId])
    const res = await getTodos(f.landlordToken)
    expect(types(res)).toContain('invite_expired')
  })

  it('a still-pending (accepted, not expired) invite is NOT an action item', async () => {
    const f = await seedTFixture()
    // accepted, draft already exists → nothing for the landlord to do
    const doc = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'D','original_lease','pending') RETURNING id`, [f.landlordId, f.unitId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at, draft_document_id)
       VALUES ($1,$2,'not_uploaded',$3, NOW(), $4)`,
      [f.landlordId, f.tenantId, f.unitId, doc.rows[0].id])
    const res = await getTodos(f.landlordToken)
    expect(res.body.data.onboarding).toEqual([])
  })

  it('lease drafted + sent, landlord not signed → awaiting_landlord_signature item', async () => {
    const f = await seedTFixture()
    const doc = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Lease','original_lease','sent') RETURNING id`, [f.landlordId, f.unitId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent')`,
      [doc.rows[0].id, f.landlordUserId, 'tok-' + doc.rows[0].id])
    const res = await getTodos(f.landlordToken)
    const item = res.body.data.onboarding.find((o: any) => o.type === 'awaiting_landlord_signature')
    expect(item).toBeTruthy()
    expect(item.href).toBe('/sign/' + doc.rows[0].id)
  })
})

// ── S620: a co-owner must not be nagged about the empty entity that
//          registering created ────────────────────────────────────────────
//
// Nic's partner accepted a co-owner invite to Oak Park and was told to set up a
// bank account and Stripe KYC, with no way to dismiss it. The task was not
// stale — it was a TRUE statement about the wrong entity. Accepting an invite
// requires registering first, and registering always creates an entity, so
// every co-owner carries an empty one. The to-dos scoped to that entity while
// the dashboard beside them already spanned both.
describe('to-dos for a co-owner of somebody else’s entity', () => {
  async function seedCoOwner() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // The funded entity — a real property, payouts switched on.
      const owner = await seedLandlord(client)
      const propertyId = await seedProperty(client, {
        landlordId: owner.landlordId,
        ownerUserId: owner.userId,
        managedByUserId: owner.userId,
      })
      await client.query(
        `UPDATE landlords SET connect_payouts_enabled = TRUE WHERE id = $1`,
        [owner.landlordId])

      // The partner: their OWN empty entity, plus membership of the funded one.
      const partner = await seedLandlord(client)
      await client.query(
        `INSERT INTO landlord_members (landlord_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($3, $2, 'owner')
         ON CONFLICT (landlord_id, user_id) DO NOTHING`,
        [owner.landlordId, partner.userId, partner.landlordId])
      await client.query('COMMIT')

      // The JWT carries BOTH entities, exactly as login builds it from
      // landlord_members — profileId stays their own empty one, because that is
      // the entity they are the registered owner of.
      const token = jwt.sign(
        { userId: partner.userId, role: 'landlord', email: 'partner@test.dev',
          profileId: partner.landlordId,
          landlordIds: [partner.landlordId, owner.landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { token, propertyId, ownerLandlordId: owner.landlordId }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }

  it('does not demand a bank account when a co-owned entity can already be paid', async () => {
    const f = await seedCoOwner()
    const res = await getTodos(f.token)
    expect(res.status).toBe(200)
    // The bank todos live in the `ach` bucket, by id. An earlier version of
    // this test looked in `onboarding`, found nothing, and passed for the
    // wrong reason — the guard test below is what exposed that.
    const ids = (res.body.data.ach as any[]).map((t) => t.id)
    expect(
      ids,
      'a co-owner of a funded entity was told to set up a bank account for their empty one'
    ).not.toContain('landlord-bank')
  })

  it('still demands one when NO entity in scope can be paid', async () => {
    // The gate has to keep working — this is the case where it is right.
    const client = await db.connect()
    let token: string
    try {
      const solo = await seedLandlord(client)
      token = jwt.sign(
        { userId: solo.userId, role: 'landlord', email: 'solo@test.dev',
          profileId: solo.landlordId, landlordIds: [solo.landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { client.release() }
    const res = await getTodos(token)
    expect(res.status).toBe(200)
    expect((res.body.data.ach as any[]).map((t) => t.id)).toContain('landlord-bank')
  })
})
