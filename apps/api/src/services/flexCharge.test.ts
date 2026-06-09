/**
 * S425 services-audit slice 2: flexCharge.ts.
 *
 * Covers the account/customer CRUD basics + critical enrollment
 * gating per the locked product rules (per-property enabled,
 * tenant must be on active lease, FlexDeposit installment plan
 * blocks FlexCharge enrollment). The statement-generation +
 * billing + reconciliation paths are deferred to a follow-on
 * slice — they're large enough to warrant their own session.
 *
 * Public surface covered (8 of 20+ exports):
 *   - isFlexChargeVisible
 *   - createPosCustomer / listPosCustomers / archivePosCustomer
 *   - createFlexChargeAccount (with gating)
 *   - listFlexChargeAccounts
 *   - updateFlexChargeAccount
 *   - getFlexChargeAccountsForTenant
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  isFlexChargeVisible,
  createPosCustomer,
  listPosCustomers,
  archivePosCustomer,
  createFlexChargeAccount,
  listFlexChargeAccounts,
  updateFlexChargeAccount,
  getFlexChargeAccountsForTenant,
} from './flexCharge'

beforeEach(async () => {
  // Pre-clean — cleanupAllSchema doesn't know about these tables;
  // FK chains otherwise block landlord/property deletion.
  await db.query(`DELETE FROM flex_charge_transactions`)
  await db.query(`DELETE FROM flex_charge_statements`)
  await db.query(`DELETE FROM flex_charge_accounts`)
  await db.query(`DELETE FROM pos_customers`)
  await cleanupAllSchema()
})

interface Ctx {
  landlordId: string
  propertyId: string
  unitId:     string
  tenantId:   string
}

async function seedCtx(opts: { flexChargeEnabled?: boolean } = {}): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    if (opts.flexChargeEnabled) {
      await c.query(
        `UPDATE properties SET flexcharge_enabled=TRUE WHERE id=$1`, [propertyId])
    }
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return { landlordId, propertyId, unitId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ─── isFlexChargeVisible ──────────────────────────────────────

describe('isFlexChargeVisible', () => {
  it('returns false when the flexcharge_rollout_visible feature flag is off', async () => {
    // Default — no system_features row → off.
    expect(await isFlexChargeVisible()).toBe(false)
  })

  it('returns true when the feature flag is enabled', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexcharge_rollout_visible', TRUE, 'S425 test')
       ON CONFLICT (key) DO UPDATE SET enabled=TRUE`)
    expect(await isFlexChargeVisible()).toBe(true)
  })
})

// ─── pos_customers CRUD ──────────────────────────────────────

describe('pos_customers CRUD', () => {
  it('createPosCustomer: lowercases email + trims names + returns row', async () => {
    const ctx = await seedCtx()
    const row = await createPosCustomer({
      landlordId: ctx.landlordId,
      firstName: '  Jane  ',
      lastName: '  Doe  ',
      email: 'JANE.DOE@TEST.DEV',
    })
    expect(row.first_name).toBe('Jane')
    expect(row.last_name).toBe('Doe')
    expect(row.email).toBe('jane.doe@test.dev')
    expect(row.landlord_id).toBe(ctx.landlordId)
    expect(row.archived_at).toBeNull()
  })

  it('createPosCustomer: missing @ → 400', async () => {
    const ctx = await seedCtx()
    await expect(createPosCustomer({
      landlordId: ctx.landlordId,
      firstName: 'A', lastName: 'B', email: 'not-an-email',
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('createPosCustomer: duplicate email per landlord → 409', async () => {
    const ctx = await seedCtx()
    await createPosCustomer({
      landlordId: ctx.landlordId,
      firstName: 'A', lastName: 'B', email: 'dup@test.dev',
    })
    await expect(createPosCustomer({
      landlordId: ctx.landlordId,
      firstName: 'C', lastName: 'D', email: 'dup@test.dev',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('listPosCustomers: returns only this landlord\'s non-archived rows sorted by last/first name', async () => {
    const ctx = await seedCtx()
    await createPosCustomer({ landlordId: ctx.landlordId, firstName: 'Zoe', lastName: 'Adams', email: 'z@t.dev' })
    await createPosCustomer({ landlordId: ctx.landlordId, firstName: 'Ann', lastName: 'Brown', email: 'a@t.dev' })
    const archived = await createPosCustomer({ landlordId: ctx.landlordId, firstName: 'Old', lastName: 'Customer', email: 'old@t.dev' })
    await archivePosCustomer({ landlordId: ctx.landlordId, customerId: archived.id })
    const list = await listPosCustomers(ctx.landlordId)
    expect(list).toHaveLength(2)
    expect(list[0].last_name).toBe('Adams')
    expect(list[1].last_name).toBe('Brown')
  })

  it('archivePosCustomer: cross-landlord attempt → 404; row NOT touched', async () => {
    const a = await seedCtx()
    const c = await db.connect()
    let bLandlordId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      bLandlordId = landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const cust = await createPosCustomer({
      landlordId: a.landlordId,
      firstName: 'X', lastName: 'Y', email: 'x@t.dev',
    })
    await expect(archivePosCustomer({
      landlordId: bLandlordId, customerId: cust.id,
    })).rejects.toMatchObject({ statusCode: 404 })
    // Row still active.
    const { rows: [check] } = await db.query<any>(
      `SELECT archived_at FROM pos_customers WHERE id=$1`, [cust.id])
    expect(check.archived_at).toBeNull()
  })

  it('archivePosCustomer: already archived → 404 (idempotent-safe)', async () => {
    const ctx = await seedCtx()
    const cust = await createPosCustomer({
      landlordId: ctx.landlordId,
      firstName: 'X', lastName: 'Y', email: 'x@t.dev',
    })
    await archivePosCustomer({ landlordId: ctx.landlordId, customerId: cust.id })
    await expect(archivePosCustomer({
      landlordId: ctx.landlordId, customerId: cust.id,
    })).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ─── createFlexChargeAccount — enrollment gating ─────────────

describe('createFlexChargeAccount — enrollment gating', () => {
  it('XOR: neither tenantId nor posCustomerId → 400', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('XOR: both tenantId and posCustomerId → 400', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const cust = await createPosCustomer({
      landlordId: ctx.landlordId, firstName: 'A', lastName: 'B', email: 'a@t.dev',
    })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, posCustomerId: cust.id,
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('property not found → 404', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: '00000000-0000-0000-0000-000000000000',
      tenantId: ctx.tenantId,
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('cross-landlord property → 403', async () => {
    const a = await seedCtx({ flexChargeEnabled: true })
    const c = await db.connect()
    let bLandlordId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      bLandlordId = landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(createFlexChargeAccount({
      landlordId: bLandlordId,
      propertyId: a.propertyId,
      tenantId:   a.tenantId,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('S309 gate: property has flexcharge_enabled=FALSE → 403', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: false })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('tenant not on active lease with landlord → 403', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    // Terminate the lease — tenant no longer "active" for this landlord.
    await db.query(`UPDATE leases SET status='terminated' WHERE landlord_id=$1`, [ctx.landlordId])
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('S261 gate: tenant has active FlexDeposit installment plan → 409', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    // Seed a security_deposit with flex_deposit_enabled=TRUE + plan_status='active'.
    await db.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount,
          flex_deposit_plan_status, flex_deposit_enabled, held_by)
       SELECT id, (SELECT id FROM leases WHERE unit_id=$1 LIMIT 1), $2,
              1000, 0, 'active', TRUE, 'gam_escrow'
         FROM units WHERE id=$1`,
      [ctx.unitId, ctx.tenantId])
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId,
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('happy: tenant on active lease, no FlexDeposit plan, property enabled → row created', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const row = await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    expect(row.tenant_id).toBe(ctx.tenantId)
    expect(row.pos_customer_id).toBeNull()
    expect(Number(row.credit_limit)).toBe(500)
    expect(row.status).toBe('active')
  })

  it('pos_customer path: archived customer → 404', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const cust = await createPosCustomer({
      landlordId: ctx.landlordId, firstName: 'X', lastName: 'Y', email: 'x@t.dev',
    })
    await archivePosCustomer({ landlordId: ctx.landlordId, customerId: cust.id })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      posCustomerId: cust.id,
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('duplicate (customer, property) → 409 (UNIQUE constraint)', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 1000,
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('negative credit limit → 400', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    await expect(createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: -1,
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ─── listFlexChargeAccounts ──────────────────────────────────

describe('listFlexChargeAccounts', () => {
  it('returns landlord-scoped rows with customer_name + balance', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const row = await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    const list = await listFlexChargeAccounts({ landlordId: ctx.landlordId })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(row.id)
    expect(list[0].balance).toBe(0)
    expect(list[0].customer_name).toMatch(/Test Tenant/)
  })

  it('propertyId filter narrows results', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    // Second property on same landlord — reuse the landlord's user_id
    // from landlords so the managed_by FK resolves.
    const c = await db.connect()
    let prop2 = ''
    try {
      await c.query('BEGIN')
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM landlords WHERE id=$1`, [ctx.landlordId])
      prop2 = await seedProperty(c, {
        landlordId: ctx.landlordId, ownerUserId: user_id, managedByUserId: user_id,
      })
      await c.query(`UPDATE properties SET flexcharge_enabled=TRUE WHERE id=$1`, [prop2])
      await c.query('COMMIT')
    } finally { c.release() }
    const cust = await createPosCustomer({
      landlordId: ctx.landlordId, firstName: 'POS', lastName: 'Cust', email: 'pc@t.dev',
    })
    await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: prop2,
      posCustomerId: cust.id, creditLimit: 250,
    })
    const filtered = await listFlexChargeAccounts({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].property_id).toBe(ctx.propertyId)
  })

  it('cross-landlord rows not returned', async () => {
    const a = await seedCtx({ flexChargeEnabled: true })
    await createFlexChargeAccount({
      landlordId: a.landlordId, propertyId: a.propertyId,
      tenantId: a.tenantId, creditLimit: 500,
    })
    const c = await db.connect()
    let bLandlordId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      bLandlordId = landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    const list = await listFlexChargeAccounts({ landlordId: bLandlordId })
    expect(list).toEqual([])
  })
})

// ─── updateFlexChargeAccount ─────────────────────────────────

describe('updateFlexChargeAccount', () => {
  it('updates credit_limit + notes; cross-landlord → 404', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const acc = await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    const updated = await updateFlexChargeAccount({
      landlordId: ctx.landlordId, accountId: acc.id,
      creditLimit: 1000, notes: 'bumped',
    })
    expect(Number(updated.credit_limit)).toBe(1000)
    expect(updated.notes).toBe('bumped')
    // cross-landlord
    const c = await db.connect()
    let bLandlordId = ''
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      bLandlordId = landlordId
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(updateFlexChargeAccount({
      landlordId: bLandlordId, accountId: acc.id, creditLimit: 999,
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses status="disqualified" (engine-only)', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const acc = await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    await expect(updateFlexChargeAccount({
      landlordId: ctx.landlordId, accountId: acc.id,
      status: 'disqualified' as any,
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('empty patch → 400 "Nothing to update"', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    const acc = await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    await expect(updateFlexChargeAccount({
      landlordId: ctx.landlordId, accountId: acc.id,
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ─── getFlexChargeAccountsForTenant ──────────────────────────

describe('getFlexChargeAccountsForTenant', () => {
  it('empty list when tenant has no accounts', async () => {
    const ctx = await seedCtx()
    const list = await getFlexChargeAccountsForTenant(ctx.tenantId)
    expect(list).toEqual([])
  })

  it('returns account with property name + 0 balance + empty transactions', async () => {
    const ctx = await seedCtx({ flexChargeEnabled: true })
    await createFlexChargeAccount({
      landlordId: ctx.landlordId, propertyId: ctx.propertyId,
      tenantId: ctx.tenantId, creditLimit: 500,
    })
    const list = await getFlexChargeAccountsForTenant(ctx.tenantId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      property_id: ctx.propertyId,
      status: 'active',
      transactions: [],
    })
    expect(list[0].property_name).toBeTruthy()
    expect(Number(list[0].balance)).toBe(0)
  })

  it('cross-tenant isolation: another tenant\'s accounts not returned', async () => {
    const a = await seedCtx({ flexChargeEnabled: true })
    await createFlexChargeAccount({
      landlordId: a.landlordId, propertyId: a.propertyId,
      tenantId: a.tenantId, creditLimit: 500,
    })
    const c = await db.connect()
    let otherTenant = ''
    try {
      await c.query('BEGIN')
      otherTenant = await seedTenant(c)
      await c.query('COMMIT')
    } finally { c.release() }
    const list = await getFlexChargeAccountsForTenant(otherTenant)
    expect(list).toEqual([])
  })
})
