/**
 * S433 services-audit slice 10: subleaseAllocation.ts.
 *
 * Three public functions:
 *   - creditSublessorMarkupForPayment(paymentId) — webhook accrual hook
 *     that credits the sublessor when the sublessee pays rent.
 *   - getSublessorCredit(sublessorTenantId) — view assembly + 2dp rounding.
 *   - withdrawSublessorCredit({...}) — greedy drain across subleases +
 *     Stripe Transfer, with rollback on Stripe failure.
 *
 * Stripe is mocked at the module boundary; sublease + payment tables
 * are real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const transfersCreateMock = vi.fn(async () => ({ id: 'tr_mock' }))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ transfers: { create: transfersCreateMock } }),
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  creditSublessorMarkupForPayment,
  getSublessorCredit,
  withdrawSublessorCredit,
} from './subleaseAllocation'

beforeEach(async () => {
  await cleanupAllSchema()
  transfersCreateMock.mockReset()
  transfersCreateMock.mockResolvedValue({ id: 'tr_mock_default' } as any)
})

// ─── helpers ─────────────────────────────────────────────────

interface SubleaseCtx {
  landlordUserId:   string
  landlordId:       string
  unitId:           string
  masterLeaseId:    string
  sublessorTenantId:string
  sublessorUserId:  string
  sublesseeTenantId:string
  subleaseId:       string
}

async function seedSubleaseCtx(opts: {
  subAmount?:    number
  masterShare?:  number
  startDate?:    string
  endDate?:      string | null
  status?:       'pending_invite' | 'pending' | 'awaiting_signatures' | 'active' | 'terminated'
  enablePayouts?:boolean
  connectId?:    string | null
} = {}): Promise<SubleaseCtx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const sublessorTenantId = await seedTenant(c)
    const sublesseeTenantId = await seedTenant(c)
    const masterLeaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId: masterLeaseId, tenantId: sublessorTenantId, role: 'primary' })
    const { rows: [{ id: subleaseId }] } = await c.query<{ id: string }>(
      `INSERT INTO subleases
         (master_lease_id, sublessee_tenant_id, sublessor_tenant_id, status,
          start_date, end_date, sub_monthly_amount, master_share_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [masterLeaseId, sublesseeTenantId, sublessorTenantId,
       opts.status ?? 'active',
       opts.startDate ?? '2026-01-01',
       opts.endDate === undefined ? null : opts.endDate,
       opts.subAmount   ?? 1200,
       opts.masterShare ?? 1000])
    // Optionally configure the sublessor's Connect account.
    const { rows: [{ user_id: sublessorUserId }] } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [sublessorTenantId])
    if (opts.connectId !== undefined || opts.enablePayouts !== undefined) {
      await c.query(
        `UPDATE users SET stripe_connect_account_id=$2,
                          connect_payouts_enabled=$3 WHERE id=$1`,
        [sublessorUserId,
         opts.connectId === undefined ? 'acct_test_sublessor' : opts.connectId,
         opts.enablePayouts ?? false])
    }
    await c.query('COMMIT')
    return {
      landlordUserId, landlordId, unitId, masterLeaseId,
      sublessorTenantId, sublessorUserId, sublesseeTenantId, subleaseId,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedRentPaymentRaw(opts: {
  unitId:   string
  tenantId: string
  landlordId: string
  amount:   number
  dueDate:  string
  type?:    string
}): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date)
     VALUES ($1, $2, $3, $4, $5, 'settled', 'RENT', $6) RETURNING id`,
    [opts.unitId, opts.tenantId, opts.landlordId,
     opts.type ?? 'rent', opts.amount, opts.dueDate])
  return id
}

// ─── creditSublessorMarkupForPayment ─────────────────────────

describe('creditSublessorMarkupForPayment — short-circuit branches', () => {
  it('payment not found → silently returns', async () => {
    await expect(creditSublessorMarkupForPayment(
      '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined()
  })

  it('payment.type != "rent" → returns (no balance row)', async () => {
    const ctx = await seedSubleaseCtx()
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
      type: 'utility',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })

  it('no matching sublease (different unit) → returns', async () => {
    const ctx = await seedSubleaseCtx()
    // Pay against a DIFFERENT unit (no sublease there).
    const c = await db.connect()
    let otherUnit = ''
    try {
      await c.query('BEGIN')
      const propId = await seedProperty(c, {
        landlordId: ctx.landlordId, ownerUserId: ctx.landlordUserId,
        managedByUserId: ctx.landlordUserId,
      })
      otherUnit = await seedUnit(c, { propertyId: propId, landlordId: ctx.landlordId })
      await c.query('COMMIT')
    } finally { c.release() }
    const paymentId = await seedRentPaymentRaw({
      unitId: otherUnit, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })

  it('sublease status not "active" (terminated) → no match → returns', async () => {
    const ctx = await seedSubleaseCtx({ status: 'terminated' })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })

  it('payment due_date BEFORE sublease start_date → no match', async () => {
    const ctx = await seedSubleaseCtx({ startDate: '2026-03-01' })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })

  it('payment due_date AFTER sublease end_date → no match', async () => {
    const ctx = await seedSubleaseCtx({
      startDate: '2026-01-01', endDate: '2026-06-30',
    })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-07-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })

  it('markup ≤ 0 (full pass-through) → no credit accrued', async () => {
    // sub == master → markup 0
    const ctx = await seedSubleaseCtx({ subAmount: 1000, masterShare: 1000 })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1000, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM sublessor_credit_balances`)
    expect(rows[0].n).toBe(0)
  })
})

describe('creditSublessorMarkupForPayment — happy + idempotency', () => {
  it('credits markup; stamps sublease_credit_applied=TRUE', async () => {
    // sub 1200, master 1000 → markup 200
    const ctx = await seedSubleaseCtx({ subAmount: 1200, masterShare: 1000 })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const { rows: [bal] } = await db.query<any>(
      `SELECT balance, total_earned, total_withdrawn, sublease_id, sublessor_tenant_id
         FROM sublessor_credit_balances WHERE sublease_id=$1`, [ctx.subleaseId])
    expect(Number(bal.balance)).toBe(200)
    expect(Number(bal.total_earned)).toBe(200)
    expect(Number(bal.total_withdrawn)).toBe(0)
    expect(bal.sublessor_tenant_id).toBe(ctx.sublessorTenantId)
    const { rows: [p] } = await db.query<any>(
      `SELECT sublease_credit_applied FROM payments WHERE id=$1`, [paymentId])
    expect(p.sublease_credit_applied).toBe(true)
  })

  it('idempotent: same payment fired twice yields one accrual', async () => {
    const ctx = await seedSubleaseCtx({ subAmount: 1200, masterShare: 1000 })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    await creditSublessorMarkupForPayment(paymentId)
    const { rows: [bal] } = await db.query<any>(
      `SELECT balance, total_earned FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [ctx.subleaseId])
    expect(Number(bal.balance)).toBe(200)         // not 400
    expect(Number(bal.total_earned)).toBe(200)    // not 400
  })

  it('two distinct payments accumulate via ON CONFLICT upsert', async () => {
    const ctx = await seedSubleaseCtx({ subAmount: 1200, masterShare: 1000 })
    const p1 = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    const p2 = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-03-01',
    })
    await creditSublessorMarkupForPayment(p1)
    await creditSublessorMarkupForPayment(p2)
    const { rows: [bal] } = await db.query<any>(
      `SELECT balance, total_earned FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [ctx.subleaseId])
    expect(Number(bal.balance)).toBe(400)
    expect(Number(bal.total_earned)).toBe(400)
  })
})

// ─── getSublessorCredit ──────────────────────────────────────

describe('getSublessorCredit', () => {
  it('no balances → zeros + empty per_sublease', async () => {
    const view = await getSublessorCredit('00000000-0000-0000-0000-000000000000')
    expect(view.total_balance).toBe(0)
    expect(view.total_earned).toBe(0)
    expect(view.total_withdrawn).toBe(0)
    expect(view.per_sublease).toEqual([])
  })

  it('single balance → reflects fields + property/unit join', async () => {
    const ctx = await seedSubleaseCtx({ subAmount: 1200, masterShare: 1000 })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const view = await getSublessorCredit(ctx.sublessorTenantId)
    expect(view.total_balance).toBe(200)
    expect(view.total_earned).toBe(200)
    expect(view.total_withdrawn).toBe(0)
    expect(view.per_sublease).toHaveLength(1)
    expect(view.per_sublease[0].sublease_id).toBe(ctx.subleaseId)
    expect(view.per_sublease[0].property_name).not.toBeNull()
    expect(view.per_sublease[0].unit_number).not.toBeNull()
  })

  it('rounds totals to 2 dp', async () => {
    const ctx = await seedSubleaseCtx({ subAmount: 1200.33, masterShare: 1000 })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200.33, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    const view = await getSublessorCredit(ctx.sublessorTenantId)
    expect(view.total_balance).toBe(200.33)
  })
})

// ─── withdrawSublessorCredit ─────────────────────────────────

describe('withdrawSublessorCredit — input + connect gates', () => {
  it('amount = 0 → 400', async () => {
    await expect(withdrawSublessorCredit({
      sublessorTenantId: '00000000-0000-0000-0000-000000000000',
      amountDollars: 0,
    })).rejects.toThrow(/positive number/)
  })

  it('amount = NaN → 400', async () => {
    await expect(withdrawSublessorCredit({
      sublessorTenantId: '00000000-0000-0000-0000-000000000000',
      amountDollars: NaN,
    })).rejects.toThrow(/positive number/)
  })

  it('tenant not found → 404', async () => {
    await expect(withdrawSublessorCredit({
      sublessorTenantId: '00000000-0000-0000-0000-000000000000',
      amountDollars: 10,
    })).rejects.toThrow(/Tenant not found/)
  })

  it('no Connect account → 409 "Set up payouts first"', async () => {
    const ctx = await seedSubleaseCtx({ connectId: null })
    await expect(withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 10,
    })).rejects.toThrow(/Set up payouts first/)
  })

  it('Connect account but payouts NOT enabled → 409 "not yet enabled"', async () => {
    const ctx = await seedSubleaseCtx({
      connectId: 'acct_test', enablePayouts: false,
    })
    await expect(withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 10,
    })).rejects.toThrow(/not yet enabled/)
  })

  it('requested > total balance → 400', async () => {
    const ctx = await seedSubleaseCtx({
      subAmount: 1100, masterShare: 1000,  // markup 100
      connectId: 'acct_test', enablePayouts: true,
    })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1100, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    await expect(withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 500,
    })).rejects.toThrow(/exceeds available balance/)
  })
})

describe('withdrawSublessorCredit — happy + rollback', () => {
  it('drains single balance + fires Transfer + returns transferId', async () => {
    const ctx = await seedSubleaseCtx({
      subAmount: 1200, masterShare: 1000,  // markup 200
      connectId: 'acct_test_sub', enablePayouts: true,
    })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    transfersCreateMock.mockResolvedValueOnce({ id: 'tr_happy' } as any)
    const res = await withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 150,
    })
    expect(res.stripeTransferId).toBe('tr_happy')
    expect(res.withdrawnCents).toBe(15000)
    // Stripe called with USD cents + destination + metadata.
    expect(transfersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 15000, currency: 'usd', destination: 'acct_test_sub',
      metadata: expect.objectContaining({
        gam_purpose: 'sublessor_withdraw',
        gam_tenant_id: ctx.sublessorTenantId,
      }),
    }), expect.objectContaining({ idempotencyKey: expect.any(String) }))
    const { rows: [bal] } = await db.query<any>(
      `SELECT balance, total_withdrawn FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [ctx.subleaseId])
    expect(Number(bal.balance)).toBe(50)
    expect(Number(bal.total_withdrawn)).toBe(150)
  })

  it('greedy drain across multiple subleases (highest balance first)', async () => {
    const ctx = await seedSubleaseCtx({
      subAmount: 1500, masterShare: 1000,  // markup 500 — bigger
      connectId: 'acct_test', enablePayouts: true,
    })
    // Seed a SECOND sublease for the same sublessor on a different lease.
    const c = await db.connect()
    let secondSubleaseId = ''
    try {
      await c.query('BEGIN')
      const propId = await seedProperty(c, {
        landlordId: ctx.landlordId, ownerUserId: ctx.landlordUserId,
        managedByUserId: ctx.landlordUserId,
      })
      const otherUnit = await seedUnit(c, { propertyId: propId, landlordId: ctx.landlordId })
      const otherSublessee = await seedTenant(c)
      const masterLease2 = await seedLease(c, { unitId: otherUnit, landlordId: ctx.landlordId, status: 'active' })
      await seedLeaseTenant(c, { leaseId: masterLease2, tenantId: ctx.sublessorTenantId, role: 'primary' })
      const { rows: [{ id }] } = await c.query<{ id: string }>(
        `INSERT INTO subleases
           (master_lease_id, sublessee_tenant_id, sublessor_tenant_id, status,
            start_date, sub_monthly_amount, master_share_amount)
         VALUES ($1, $2, $3, 'active', '2026-01-01', 1100, 1000) RETURNING id`,
        [masterLease2, otherSublessee, ctx.sublessorTenantId])
      secondSubleaseId = id
      await c.query('COMMIT')
    } finally { c.release() }
    // Seed balances directly (skip the credit hook to keep amounts crisp).
    await db.query(
      `INSERT INTO sublessor_credit_balances
         (sublease_id, sublessor_tenant_id, balance, total_earned)
       VALUES ($1, $2, 500, 500)`, [ctx.subleaseId, ctx.sublessorTenantId])
    await db.query(
      `INSERT INTO sublessor_credit_balances
         (sublease_id, sublessor_tenant_id, balance, total_earned)
       VALUES ($1, $2, 100, 100)`, [secondSubleaseId, ctx.sublessorTenantId])
    transfersCreateMock.mockResolvedValueOnce({ id: 'tr_greedy' } as any)
    // Withdraw 550 → drains 500 from first (higher), 50 from second.
    await withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 550,
    })
    const { rows: [b1] } = await db.query<any>(
      `SELECT balance, total_withdrawn FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [ctx.subleaseId])
    const { rows: [b2] } = await db.query<any>(
      `SELECT balance, total_withdrawn FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [secondSubleaseId])
    expect(Number(b1.balance)).toBe(0)
    expect(Number(b1.total_withdrawn)).toBe(500)
    expect(Number(b2.balance)).toBe(50)
    expect(Number(b2.total_withdrawn)).toBe(50)
  })

  it('Stripe Transfer failure → rolls back balance decrements', async () => {
    const ctx = await seedSubleaseCtx({
      subAmount: 1200, masterShare: 1000,  // markup 200
      connectId: 'acct_test', enablePayouts: true,
    })
    const paymentId = await seedRentPaymentRaw({
      unitId: ctx.unitId, tenantId: ctx.sublesseeTenantId,
      landlordId: ctx.landlordId, amount: 1200, dueDate: '2026-02-01',
    })
    await creditSublessorMarkupForPayment(paymentId)
    transfersCreateMock.mockRejectedValueOnce(new Error('Stripe down'))
    await expect(withdrawSublessorCredit({
      sublessorTenantId: ctx.sublessorTenantId, amountDollars: 150,
    })).rejects.toThrow(/Stripe down/)
    // Balance untouched after rollback.
    const { rows: [bal] } = await db.query<any>(
      `SELECT balance, total_withdrawn FROM sublessor_credit_balances WHERE sublease_id=$1`,
      [ctx.subleaseId])
    expect(Number(bal.balance)).toBe(200)
    expect(Number(bal.total_withdrawn)).toBe(0)
  })
})
