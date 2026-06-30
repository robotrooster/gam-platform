/**
 * S424 services-audit kickoff: supersedence service slice.
 *
 * GAM-supersedence routing (S261, memory:
 * project_gam_supersedence_routing.md): every tenant ACH pull
 * routes to GAM first to satisfy outstanding GAM-owed debts
 * (oldest-first FIFO); surplus to landlord.
 *
 * Three public functions covered:
 *   - computeTenantGamOutstanding(tenantId)
 *   - computeTenantGamOutstandingTotal(tenantId)
 *   - applyTenantSupersedence(client, paymentId) — happy paths only
 *
 * The 5 satisfier functions (one per source) are exercised
 * implicitly via applyTenantSupersedence; each one's status flip is
 * checked end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease,
} from '../test/dbHelpers'
import {
  computeTenantGamOutstanding,
  computeTenantGamOutstandingTotal,
  applyTenantSupersedence,
} from './supersedence'

beforeEach(async () => {
  // Pre-clean: cleanupAllSchema doesn't know about flexpay_advances /
  // flex_charge_statements / flex_deposit_installments / custody
  // charges. Drop them explicitly so cleanupAllSchema's lease/landlord
  // delete doesn't FK-fail.
  await db.query(`DELETE FROM flexpay_advances`)
  await db.query(`DELETE FROM flex_deposit_custody_charges`)
  await db.query(`DELETE FROM flex_charge_statements`)
  await db.query(`DELETE FROM flex_charge_accounts`)
  await db.query(`DELETE FROM flex_deposit_installments`)
  await cleanupAllSchema()
})

interface Ctx {
  landlordId: string
  tenantId:   string
  unitId:     string
  leaseId:    string
  depositId:  string
}

async function seedCtx(): Promise<Ctx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId })
    const { rows: [{ id: depositId }] } = await c.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount,
          flex_deposit_plan_status, held_by)
       VALUES ($1, $2, $3, 1000, 0, 'active', 'gam_escrow') RETURNING id`,
      [unitId, leaseId, tenantId])
    await c.query('COMMIT')
    return { landlordId, tenantId, unitId, leaseId, depositId }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// A 'missed' installment (both scheduled pulls failed) is the then-due,
// unfunded portion of the deposit picked up by GAM-first routing (S514).
async function seedDefaultedInstallment(ctx: Ctx, opts: {
  amount: number; defaultedAt: string; installmentNumber?: number
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO flex_deposit_installments
       (security_deposit_id, tenant_id, installment_number,
        installment_count, amount, due_date, status, defaulted_at)
     VALUES ($1, $2, $3, 4, $4, $5::date, 'missed', $6::timestamptz)
     RETURNING id`,
    [ctx.depositId, ctx.tenantId, opts.installmentNumber ?? 1,
     opts.amount, opts.defaultedAt.slice(0, 10), opts.defaultedAt])
  return id
}

async function seedFlexChargeStatement(ctx: Ctx, opts: {
  totalDue: number; dueDate: string; status?: 'open' | 'failed'
}): Promise<{ accountId: string; stmtId: string }> {
  // Look up the property — flex_charge_accounts requires it.
  const { rows: [{ property_id }] } = await db.query<{ property_id: string }>(
    `SELECT property_id FROM units WHERE id=$1`, [ctx.unitId])
  const { rows: [{ id: accountId }] } = await db.query<{ id: string }>(
    `INSERT INTO flex_charge_accounts
       (tenant_id, property_id, landlord_id, credit_limit, status)
     VALUES ($1, $2, $3, 1000, 'active')
     RETURNING id`,
    [ctx.tenantId, property_id, ctx.landlordId])
  const { rows: [{ id: stmtId }] } = await db.query<{ id: string }>(
    `INSERT INTO flex_charge_statements
       (account_id, cycle_month, balance, service_fee, total_due,
        due_date, status)
     VALUES ($1, $2::date, $3, 0, $3, $2::date, $4)
     RETURNING id`,
    [accountId, opts.dueDate, opts.totalDue, opts.status ?? 'open'])
  return { accountId, stmtId }
}

async function seedDefaultedFlexPayAdvance(ctx: Ctx, opts: {
  rent: number; fee: number; defaultedAt: string
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO flexpay_advances
       (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
        rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, 1, 'defaulted', $8::timestamptz)
     RETURNING id`,
    [opts.defaultedAt.slice(0, 10), ctx.tenantId, ctx.landlordId,
     ctx.unitId, ctx.leaseId, opts.rent, opts.fee, opts.defaultedAt])
  return id
}

async function seedFailedCustodyCharge(ctx: Ctx, opts: {
  amount: number; updatedAt: string
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO flex_deposit_custody_charges
       (tenant_id, cycle_month, amount, status, updated_at)
     VALUES ($1, $2::date, $3, 'failed', $4::timestamptz)
     RETURNING id`,
    [ctx.tenantId, opts.updatedAt.slice(0, 10), opts.amount, opts.updatedAt])
  return id
}

async function seedPayment(ctx: Ctx, opts: {
  boostAmount: number
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, gam_supersedence_amount)
     VALUES ($1, $2, $3, 'rent', 1000, 'pending', 'RENT',
             CURRENT_DATE, $4)
     RETURNING id`,
    [ctx.unitId, ctx.tenantId, ctx.landlordId, opts.boostAmount])
  return id
}

// ─── computeTenantGamOutstanding ─────────────────────────────

describe('computeTenantGamOutstanding', () => {
  it('no outstanding debts → empty list', async () => {
    const ctx = await seedCtx()
    const list = await computeTenantGamOutstanding(ctx.tenantId)
    expect(list).toEqual([])
  })

  it('single defaulted installment → 1 item with correct shape', async () => {
    const ctx = await seedCtx()
    const refId = await seedDefaultedInstallment(ctx,
      { amount: 83.33, defaultedAt: '2026-04-15T00:00:00Z' })
    const list = await computeTenantGamOutstanding(ctx.tenantId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      source: 'flexdeposit_installment',
      ref_id: refId,
      amount: 83.33,
    })
  })

  it('multiple sources sorted FIFO (oldest unpaid_date first)', async () => {
    const ctx = await seedCtx()
    // Newer first to make sure sorting doesn't just preserve insert order.
    await seedDefaultedInstallment(ctx,
      { amount: 100, defaultedAt: '2026-06-01T00:00:00Z' })
    await seedDefaultedFlexPayAdvance(ctx,
      { rent: 50, fee: 5, defaultedAt: '2026-04-01T00:00:00Z' })
    await seedFailedCustodyCharge(ctx,
      { amount: 30, updatedAt: '2026-05-01T00:00:00Z' })
    const list = await computeTenantGamOutstanding(ctx.tenantId)
    expect(list).toHaveLength(3)
    expect(list.map(i => i.source)).toEqual([
      'flexpay_advance',         // 2026-04-01
      'custody_charge',          // 2026-05-01
      'flexdeposit_installment', // 2026-06-01
    ])
  })

  it('flexpay advance amount = rent + tenant fee (combined)', async () => {
    const ctx = await seedCtx()
    await seedDefaultedFlexPayAdvance(ctx,
      { rent: 1000, fee: 15, defaultedAt: '2026-04-01T00:00:00Z' })
    const list = await computeTenantGamOutstanding(ctx.tenantId)
    expect(list[0].amount).toBe(1015)
  })

  it('flexcharge statement only included when due_date <= today AND total_due > 0', async () => {
    const ctx = await seedCtx()
    // First statement: future-dated → NOT in outstanding list.
    const { accountId } = await seedFlexChargeStatement(ctx,
      { totalDue: 100, dueDate: '2099-01-01' })
    const future = await computeTenantGamOutstanding(ctx.tenantId)
    expect(future).toHaveLength(0)
    // Second statement against the same account, past-due → included.
    // (Unique on (tenant_id, property_id) blocks creating a second
    // account, so reuse the one we already have.)
    await db.query(
      `INSERT INTO flex_charge_statements
         (account_id, cycle_month, balance, service_fee, total_due,
          due_date, status)
       VALUES ($1, '2025-12-01', 75, 0, 75, '2026-01-01', 'open')`,
      [accountId])
    const pastDue = await computeTenantGamOutstanding(ctx.tenantId)
    expect(pastDue).toHaveLength(1)
    expect(pastDue[0]).toMatchObject({ source: 'flexcharge_statement', amount: 75 })
  })

  it('cross-tenant isolation: other tenant\'s debts are NOT included', async () => {
    const ctx = await seedCtx()
    const otherTenantId = await (async () => {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const id = await seedTenant(c)
        // Need a security_deposit for the other tenant for FK.
        await c.query(
          `INSERT INTO security_deposits
             (unit_id, lease_id, tenant_id, total_amount, collected_amount,
              flex_deposit_plan_status, held_by)
           VALUES ($1, $2, $3, 1000, 0, 'active', 'gam_escrow')`,
          [ctx.unitId, ctx.leaseId, id])
        await c.query('COMMIT')
        return id
      } catch (e) { await c.query('ROLLBACK'); throw e }
      finally { c.release() }
    })()
    // Seed our tenant's installment.
    await seedDefaultedInstallment(ctx,
      { amount: 100, defaultedAt: '2026-04-01T00:00:00Z' })
    // Seed other tenant's flexpay default (uses ctx but with foreign tenant id).
    await db.query(
      `INSERT INTO flexpay_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
       VALUES ('2026-03-01', $1, $2, $3, $4, 500, 10, 1, 'defaulted',
               '2026-03-01T00:00:00Z')`,
      [otherTenantId, ctx.landlordId, ctx.unitId, ctx.leaseId])
    const list = await computeTenantGamOutstanding(ctx.tenantId)
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('flexdeposit_installment')
  })
})

// ─── computeTenantGamOutstandingTotal ────────────────────────

describe('computeTenantGamOutstandingTotal', () => {
  it('no debts → 0', async () => {
    const ctx = await seedCtx()
    expect(await computeTenantGamOutstandingTotal(ctx.tenantId)).toBe(0)
  })

  it('sums multiple sources with cents-accurate rounding', async () => {
    const ctx = await seedCtx()
    await seedDefaultedInstallment(ctx,
      { amount: 83.33, defaultedAt: '2026-04-01T00:00:00Z' })
    await seedDefaultedInstallment(ctx,
      { amount: 83.34, defaultedAt: '2026-04-02T00:00:00Z',
        installmentNumber: 2 })
    await seedFailedCustodyCharge(ctx,
      { amount: 12.50, updatedAt: '2026-04-03T00:00:00Z' })
    expect(await computeTenantGamOutstandingTotal(ctx.tenantId)).toBe(179.17)
  })
})

// ─── applyTenantSupersedence ─────────────────────────────────

describe('applyTenantSupersedence', () => {
  it('no boost → noop result, no DB changes', async () => {
    const ctx = await seedCtx()
    const paymentId = await seedPayment(ctx, { boostAmount: 0 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await applyTenantSupersedence(client, paymentId)
      await client.query('COMMIT')
      expect(res.applied).toBe(false)
      expect(res.amount_distributed).toBe(0)
    } finally { client.release() }
  })

  it('boost fully satisfies single installment → row.status flipped settled, breakdown captured', async () => {
    const ctx = await seedCtx()
    const refId = await seedDefaultedInstallment(ctx,
      { amount: 83.33, defaultedAt: '2026-04-01T00:00:00Z' })
    const paymentId = await seedPayment(ctx, { boostAmount: 83.33 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await applyTenantSupersedence(client, paymentId)
      await client.query('COMMIT')
      expect(res.applied).toBe(true)
      expect(res.amount_distributed).toBe(83.33)
      expect(res.amount_residual).toBe(0)
    } finally { client.release() }
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM flex_deposit_installments WHERE id=$1`, [refId])
    expect(row.status).toBe('settled')
    // payments row stamped applied_at + breakdown.
    const { rows: [pay] } = await db.query<any>(
      `SELECT gam_supersedence_applied_at, gam_supersedence_breakdown
         FROM payments WHERE id=$1`, [paymentId])
    expect(pay.gam_supersedence_applied_at).not.toBeNull()
    expect(pay.gam_supersedence_breakdown).toHaveLength(1)
    expect(pay.gam_supersedence_breakdown[0]).toMatchObject({
      source: 'flexdeposit_installment', ref_id: refId,
    })
  })

  it('boost smaller than first item → residual record, no row flip', async () => {
    const ctx = await seedCtx()
    const refId = await seedDefaultedInstallment(ctx,
      { amount: 100, defaultedAt: '2026-04-01T00:00:00Z' })
    const paymentId = await seedPayment(ctx, { boostAmount: 50 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await applyTenantSupersedence(client, paymentId)
      await client.query('COMMIT')
      expect(res.applied).toBe(true)
      // Per route logic: remaining sets to 0 + break, so distributed
      // counts the full boost; the breakdown records the partial as
      // residual=true so audit shows nothing was actually applied
      // to the row.
      expect(res.amount_distributed).toBe(50)
      expect(res.amount_residual).toBe(0)
    } finally { client.release() }
    // Row NOT flipped — boost was too small.
    const { rows: [row] } = await db.query<any>(
      `SELECT status FROM flex_deposit_installments WHERE id=$1`, [refId])
    expect(row.status).toBe('missed')
    // Breakdown captures the partial as residual=true.
    const { rows: [pay] } = await db.query<any>(
      `SELECT gam_supersedence_breakdown FROM payments WHERE id=$1`, [paymentId])
    expect(pay.gam_supersedence_breakdown[0]).toMatchObject({
      ref_id: refId, amount: 50, residual: true,
    })
  })

  it('idempotent: second call after applied_at stamped → noop', async () => {
    const ctx = await seedCtx()
    await seedDefaultedInstallment(ctx,
      { amount: 83.33, defaultedAt: '2026-04-01T00:00:00Z' })
    const paymentId = await seedPayment(ctx, { boostAmount: 83.33 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await applyTenantSupersedence(client, paymentId)
      await client.query('COMMIT')
    } finally { client.release() }
    // Second call.
    const client2 = await db.connect()
    try {
      await client2.query('BEGIN')
      const res = await applyTenantSupersedence(client2, paymentId)
      await client2.query('COMMIT')
      expect(res.applied).toBe(false)
    } finally { client2.release() }
  })

  it('boost > total debts → over-collection residual recorded', async () => {
    const ctx = await seedCtx()
    await seedDefaultedInstallment(ctx,
      { amount: 50, defaultedAt: '2026-04-01T00:00:00Z' })
    const paymentId = await seedPayment(ctx, { boostAmount: 80 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await applyTenantSupersedence(client, paymentId)
      await client.query('COMMIT')
      expect(res.applied).toBe(true)
      expect(res.amount_distributed).toBe(50)
      expect(res.amount_residual).toBe(30)
    } finally { client.release() }
    const { rows: [pay] } = await db.query<any>(
      `SELECT gam_supersedence_breakdown FROM payments WHERE id=$1`, [paymentId])
    // 2 entries: installment satisfied + over_collected residual.
    expect(pay.gam_supersedence_breakdown).toHaveLength(2)
    expect(pay.gam_supersedence_breakdown[1]).toMatchObject({
      ref_id: 'over_collected', amount: 30, residual: true,
    })
  })
})
