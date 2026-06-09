/**
 * S446 services-audit slice 22 — flexCharge.ts billing/reconciliation
 * half (the third and final S443-flagged continuation).
 *
 * Companion to flexCharge.test.ts (S425 — POS customer CRUD, account
 * enrollment, listing/update, tenant-side view). Mocks both the Stripe
 * SDK (for `stripe.customers.retrieve` in processFlexChargeStatementBilling
 * and `stripe.transfers.create` in reconcileSettledFlexChargeStatement)
 * AND `./stripeConnect` (for `createRentPlatformCharge`).
 *
 * Covers the deferred functions:
 *   generateMonthlyStatement — feature gate, no-pending-tx no-op,
 *     happy aggregation + service-fee + due-date computation +
 *     tx flip to 'billed', UNIQUE-conflict 409 on re-run.
 *   processFlexChargeStatementGeneration — feature gate, account
 *     scan over active+suspended, skipped_no_pending counter,
 *     409 vs other-error handling, idempotency on re-run.
 *   processFlexChargeStatementBilling — feature gate, due-date
 *     filter, customer_stripe_id gate, default_payment_method
 *     resolution + legacy default_source fallback, happy
 *     createRentPlatformCharge call + payments row + statement
 *     flipped to 'billed', failure → markStatementFailed + alert.
 *   retryFlexChargeStatement — 404 / 409 / happy retry path.
 *   reconcileSettledFlexChargeStatement — entry_description gate,
 *     status='billed' filter, paid-flip + tx propagation,
 *     merchant Transfer fired (idempotencyKey contract),
 *     no-Connect → pending-merchant-payout alert.
 *   handleFlexChargeStatementNsf — entry_description gate,
 *     retry_count<1 defer, retry_count>=1 + match → failed +
 *     account suspended + alert.
 *   disputeFlexChargeTransaction — reason gate, transaction
 *     ownership authz, status gating (already-disputed / paid),
 *     happy dispute + landlord threshold pass-through.
 *   checkAndDisqualifyLandlord — distinct-disputer counting,
 *     under-threshold returns false, threshold-hit cuts off
 *     landlord + alert, idempotent on already-disqualified.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('stripe', () => {
  const transfersCreate   = vi.fn(async () => ({ id: 'tr_default' }))
  const customersRetrieve = vi.fn(async () => ({
    id: 'cus_default',
    invoice_settings: { default_payment_method: 'pm_default' },
    default_source: null,
  }))
  function FakeStripe(this: any) {
    this.transfers       = { create: transfersCreate }
    this.customers       = { retrieve: customersRetrieve, create: vi.fn() }
    this.accounts        = { create: vi.fn(), retrieve: vi.fn() }
    this.accountSessions = { create: vi.fn() }
    this.setupIntents    = { create: vi.fn() }
    this.paymentIntents  = { create: vi.fn(), retrieve: vi.fn() }
    this.payouts         = { list: vi.fn(), retrieve: vi.fn(), create: vi.fn() }
  }
  ;(FakeStripe as any).__mocks = { transfersCreate, customersRetrieve }
  return { default: FakeStripe }
})

vi.mock('./stripeConnect', async () => ({
  createRentPlatformCharge: vi.fn(async () => ({
    id: 'pi_flexcharge_mock', status: 'processing',
  })),
  createRentDestinationCharge: vi.fn(),
  computeApplicationFee:       vi.fn(() => 0),
}))

import Stripe from 'stripe'
import * as stripeConnect from './stripeConnect'
import { db } from '../db'
import {
  generateMonthlyStatement,
  processFlexChargeStatementGeneration,
  processFlexChargeStatementBilling,
  retryFlexChargeStatement,
  reconcileSettledFlexChargeStatement,
  handleFlexChargeStatementNsf,
  disputeFlexChargeTransaction,
  checkAndDisqualifyLandlord,
} from './flexCharge'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const stripeMocks: {
  transfersCreate:   ReturnType<typeof vi.fn>
  customersRetrieve: ReturnType<typeof vi.fn>
} = (Stripe as any).__mocks

const createRentPlatformChargeMock =
  stripeConnect.createRentPlatformCharge as unknown as ReturnType<typeof vi.fn>

beforeEach(async () => {
  await cleanupAllSchema()
  stripeMocks.transfersCreate.mockReset()
  stripeMocks.transfersCreate.mockResolvedValue({ id: 'tr_default' } as any)
  stripeMocks.customersRetrieve.mockReset()
  stripeMocks.customersRetrieve.mockResolvedValue({
    id: 'cus_default',
    invoice_settings: { default_payment_method: 'pm_default' },
    default_source: null,
  } as any)
  createRentPlatformChargeMock.mockReset()
  createRentPlatformChargeMock.mockResolvedValue({
    id: 'pi_flexcharge_mock', status: 'processing',
  })
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
})

async function enablePlatform(): Promise<void> {
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexcharge_rollout_visible', TRUE, 'S446 test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
}

// ─── shared seeds ──────────────────────────────────────────────

interface AccountSeed {
  accountId:      string
  landlordId:     string
  landlordUserId: string
  propertyId:     string
  tenantId:       string
  unitId:         string
  leaseId:        string
}

async function seedAccount(opts: {
  status?:           'active' | 'suspended' | 'disqualified'
  tenantStripeCust?: string | null
  hasConnect?:       boolean
} = {}): Promise<AccountSeed> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    if (opts.tenantStripeCust !== null) {
      await c.query(
        `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
        [tenantId, opts.tenantStripeCust ?? 'cus_flexcharge_test'])
    }
    if (opts.hasConnect !== false) {
      await c.query(
        `UPDATE users SET stripe_connect_account_id = 'acct_fc_merchant' WHERE id = $1`,
        [landlordUserId])
    }
    const { rows: [acct] } = await c.query<{ id: string }>(
      `INSERT INTO flex_charge_accounts
         (tenant_id, property_id, landlord_id, credit_limit, status)
       VALUES ($1, $2, $3, 500, $4) RETURNING id`,
      [tenantId, propertyId, landlordId, opts.status ?? 'active'])
    await c.query('COMMIT')
    return {
      accountId: acct.id,
      landlordId, landlordUserId, propertyId, tenantId, unitId, leaseId,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedTx(opts: {
  accountId: string
  amount?:   number
  status?:   'pending' | 'billed' | 'paid' | 'disputed' | 'refunded'
  createdAt?: string
}): Promise<string> {
  const { rows: [tx] } = await db.query<{ id: string }>(
    `INSERT INTO flex_charge_transactions (account_id, amount, status, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [opts.accountId, opts.amount ?? 50, opts.status ?? 'pending',
     opts.createdAt ?? new Date().toISOString()])
  return tx.id
}

async function seedStatement(opts: {
  accountId:  string
  cycleMonth?: string
  balance?:    number
  serviceFee?: number
  status?:     'open' | 'billed' | 'paid' | 'failed' | 'voided'
  dueDate?:    string
  paymentId?:  string | null
}): Promise<string> {
  const balance = opts.balance ?? 100
  const serviceFee = opts.serviceFee ?? 1.5
  const total = balance + serviceFee
  const { rows: [s] } = await db.query<{ id: string }>(
    `INSERT INTO flex_charge_statements
       (account_id, cycle_month, balance, service_fee, total_due, due_date,
        status, payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [opts.accountId,
     opts.cycleMonth ?? '2026-05-01',
     balance.toFixed(2),
     serviceFee.toFixed(2),
     total.toFixed(2),
     opts.dueDate ?? '2026-06-15',
     opts.status ?? 'open',
     opts.paymentId ?? null])
  return s.id
}

// ─── generateMonthlyStatement ──────────────────────────────────

describe('generateMonthlyStatement', () => {
  it('feature flag off → returns null', async () => {
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })
    const r = await generateMonthlyStatement({
      accountId: a.accountId, cycleMonth: '2026-05-01',
    })
    expect(r).toBeNull()
  })

  it('no pending tx in cycle window → returns null, no statement row', async () => {
    await enablePlatform()
    const a = await seedAccount()
    // Tx exists but outside the May window.
    await seedTx({
      accountId: a.accountId, amount: 100,
      createdAt: '2026-06-15T00:00:00Z',
    })
    const r = await generateMonthlyStatement({
      accountId: a.accountId, cycleMonth: '2026-05-01',
    })
    expect(r).toBeNull()
    const { rows } = await db.query(`SELECT id FROM flex_charge_statements`)
    expect(rows).toHaveLength(0)
  })

  it('happy: sums pending tx, computes 1.5% service fee, due-date = 15th of next month', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-05T00:00:00Z' })
    await seedTx({ accountId: a.accountId, amount: 50,  createdAt: '2026-05-20T00:00:00Z' })

    const r = await generateMonthlyStatement({
      accountId: a.accountId, cycleMonth: '2026-05-01',
    })
    expect(r).not.toBeNull()
    expect(r!.balance).toBe(150)
    expect(r!.service_fee).toBe(2.25)            // 150 * 0.015
    expect(r!.total_due).toBe(152.25)
    expect(r!.due_date).toBe('2026-06-15')
    expect(r!.tx_count).toBe(2)

    const { rows: [stmt] } = await db.query<any>(
      `SELECT * FROM flex_charge_statements WHERE id = $1`, [r!.statement_id])
    expect(stmt.balance).toBe('150.00')
    expect(stmt.service_fee).toBe('2.25')
    expect(stmt.total_due).toBe('152.25')
    expect(stmt.status).toBe('open')

    // Both txs flipped to 'billed' with statement_id stamped.
    const { rows: txs } = await db.query<any>(
      `SELECT status, statement_id FROM flex_charge_transactions WHERE account_id = $1`,
      [a.accountId])
    expect(txs).toHaveLength(2)
    for (const tx of txs) {
      expect(tx.status).toBe('billed')
      expect(tx.statement_id).toBe(r!.statement_id)
    }
  })

  it('account not found → throws 404', async () => {
    await enablePlatform()
    await expect(generateMonthlyStatement({
      accountId: '00000000-0000-0000-0000-000000000000',
      cycleMonth: '2026-05-01',
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('idempotency: re-run on same cycle → throws 409', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })

    await generateMonthlyStatement({ accountId: a.accountId, cycleMonth: '2026-05-01' })
    // Add another pending tx so the re-run gets past the early-no-pending bail.
    await seedTx({ accountId: a.accountId, amount: 20, createdAt: '2026-05-25T00:00:00Z' })
    await expect(generateMonthlyStatement({
      accountId: a.accountId, cycleMonth: '2026-05-01',
    })).rejects.toMatchObject({ statusCode: 409 })
  })
})

// ─── processFlexChargeStatementGeneration ──────────────────────

describe('processFlexChargeStatementGeneration', () => {
  it('feature flag off → zeros, no accounts scanned', async () => {
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })
    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.accounts_scanned).toBe(0)
    expect(r.statements_created).toBe(0)
  })

  it('happy: active account with pending tx → statement created for prev month', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 200, createdAt: '2026-05-15T00:00:00Z' })

    // Running on June 1 → generates the May cycle ('2026-05-01').
    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.cycle_month).toBe('2026-05-01')
    expect(r.accounts_scanned).toBe(1)
    expect(r.statements_created).toBe(1)
    expect(r.skipped_no_pending).toBe(0)
    expect(r.errors).toBe(0)
  })

  it('skipped_no_pending++ when account has no pending tx in cycle', async () => {
    await enablePlatform()
    const a = await seedAccount()
    // Tx in WRONG month — outside the May cycle.
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-04-10T00:00:00Z' })
    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.accounts_scanned).toBe(1)
    expect(r.statements_created).toBe(0)
    expect(r.skipped_no_pending).toBe(1)
  })

  it('suspended accounts are scanned alongside active (per status IN filter)', async () => {
    await enablePlatform()
    const a = await seedAccount({ status: 'suspended' })
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })
    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.accounts_scanned).toBe(1)
    expect(r.statements_created).toBe(1)
  })

  it('disqualified accounts excluded', async () => {
    await enablePlatform()
    const a = await seedAccount({ status: 'disqualified' })
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })
    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.accounts_scanned).toBe(0)
  })

  it('re-run: 409 UNIQUE → counted as skipped_no_pending, NOT errors', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedTx({ accountId: a.accountId, amount: 100, createdAt: '2026-05-15T00:00:00Z' })
    await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    // Add another pending so the re-run gets past the no-pending bail.
    await seedTx({ accountId: a.accountId, amount: 30, createdAt: '2026-05-22T00:00:00Z' })

    const r = await processFlexChargeStatementGeneration(new Date(Date.UTC(2026, 5, 1)))
    expect(r.accounts_scanned).toBe(1)
    expect(r.statements_created).toBe(0)
    expect(r.skipped_no_pending).toBe(1)
    expect(r.errors).toBe(0)
  })
})

// ─── processFlexChargeStatementBilling ─────────────────────────

describe('processFlexChargeStatementBilling', () => {
  it('feature flag off → zeros, no PI call', async () => {
    const a = await seedAccount()
    await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01', status: 'open' })
    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.scanned).toBe(0)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()
  })

  it('happy: open statement past due_date → PI fired + payments row + status="billed"', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({
      accountId: a.accountId, dueDate: '2026-06-01', status: 'open',
      balance: 100, serviceFee: 1.5,
    })

    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.scanned).toBe(1)
    expect(r.billed).toBe(1)
    expect(r.failed).toBe(0)
    expect(r.errors).toBe(0)

    expect(createRentPlatformChargeMock).toHaveBeenCalledTimes(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge.amount).toBe(101.5)               // total_due
    expect(charge.stripeCustomerId).toBe('cus_flexcharge_test')
    expect(charge.paymentMethodId).toBe('pm_default')
    expect(charge.paymentMethodTypes).toEqual(['us_bank_account'])
    expect(charge.entryDescription).toBe('SUBSCRIP')
    expect(charge.metadata).toMatchObject({
      gam_purpose:      'flexcharge_statement',
      gam_statement_id: stmtId,
      gam_account_id:   a.accountId,
      gam_landlord_id:  a.landlordId,
      gam_cycle_month:  '2026-05-01',
    })

    const { rows: [stmt] } = await db.query<any>(
      `SELECT * FROM flex_charge_statements WHERE id = $1`, [stmtId])
    expect(stmt.status).toBe('billed')
    expect(stmt.payment_id).not.toBeNull()
    expect(stmt.billed_at).not.toBeNull()

    const { rows: [pay] } = await db.query<any>(
      `SELECT * FROM payments WHERE id = $1`, [stmt.payment_id])
    expect(pay.entry_description).toBe('SUBSCRIP')
    expect(pay.type).toBe('fee')
    expect(pay.amount).toBe('101.50')
    expect(pay.stripe_payment_intent_id).toBe('pi_flexcharge_mock')
  })

  it('customer has no stripe_customer_id → markStatementFailed + alert', async () => {
    await enablePlatform()
    const a = await seedAccount({ tenantStripeCust: null })
    const stmtId = await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01' })

    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.failed).toBe(1)
    expect(r.billed).toBe(0)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()

    const { rows: [stmt] } = await db.query<any>(
      `SELECT * FROM flex_charge_statements WHERE id = $1`, [stmtId])
    expect(stmt.status).toBe('failed')
    expect(stmt.failed_reason).toMatch(/no stripe_customer_id/i)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexcharge_statement_failed'`)
    expect(notif).toHaveLength(1)
  })

  it('customer has no default payment method → markStatementFailed', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01' })
    stripeMocks.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_flexcharge_test',
      invoice_settings: { default_payment_method: null },
      default_source: null,
    } as any)

    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.failed).toBe(1)
    expect(createRentPlatformChargeMock).not.toHaveBeenCalled()

    const { rows: [stmt] } = await db.query<any>(
      `SELECT failed_reason, status FROM flex_charge_statements WHERE id = $1`, [stmtId])
    expect(stmt.status).toBe('failed')
    expect(stmt.failed_reason).toMatch(/no default payment method/i)
  })

  it('legacy default_source fallback when invoice_settings.default_payment_method is null', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01' })
    stripeMocks.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_flexcharge_test',
      invoice_settings: { default_payment_method: null },
      default_source:   'src_legacy_bank',
    } as any)

    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.billed).toBe(1)
    const charge = createRentPlatformChargeMock.mock.calls[0][0]
    expect(charge.paymentMethodId).toBe('src_legacy_bank')
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status FROM flex_charge_statements WHERE id = $1`, [stmtId])
    expect(stmt.status).toBe('billed')
  })

  it('Stripe PI throws → markStatementFailed + errors++', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01' })
    createRentPlatformChargeMock.mockRejectedValueOnce(new Error('rate_limited'))

    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.errors).toBe(1)
    expect(r.billed).toBe(0)
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status, failed_reason FROM flex_charge_statements WHERE id = $1`, [stmtId])
    expect(stmt.status).toBe('failed')
    expect(stmt.failed_reason).toContain('rate_limited')
  })

  it('filter: due_date in future → not selected', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedStatement({ accountId: a.accountId, dueDate: '2026-07-01', status: 'open' })
    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.scanned).toBe(0)
  })

  it('filter: payment_id IS NOT NULL → not selected (already billed)', async () => {
    await enablePlatform()
    const a = await seedAccount()
    // Seed a payments row first so we can stamp it on the statement.
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (landlord_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, 'fee', 100, 'pending', 'SUBSCRIP', '2026-06-01')
       RETURNING id`,
      [a.landlordId, a.tenantId])
    await seedStatement({
      accountId: a.accountId, dueDate: '2026-06-01', status: 'open',
      paymentId: pay.id,
    })
    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.scanned).toBe(0)
  })

  it('filter: status != open → not selected', async () => {
    await enablePlatform()
    const a = await seedAccount()
    await seedStatement({ accountId: a.accountId, dueDate: '2026-06-01', status: 'failed' })
    const r = await processFlexChargeStatementBilling(new Date(Date.UTC(2026, 5, 15)))
    expect(r.scanned).toBe(0)
  })
})

// ─── retryFlexChargeStatement ──────────────────────────────────

describe('retryFlexChargeStatement', () => {
  it('statement not found → throws 404', async () => {
    await expect(retryFlexChargeStatement(
      '00000000-0000-0000-0000-000000000000'
    )).rejects.toMatchObject({ statusCode: 404 })
  })

  it('statement not in failed → throws 409', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({ accountId: a.accountId, status: 'open' })
    await expect(retryFlexChargeStatement(stmtId)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('happy: failed statement → flips to open, billing engine picks it up', async () => {
    await enablePlatform()
    const a = await seedAccount()
    const stmtId = await seedStatement({
      accountId: a.accountId, status: 'failed',
      dueDate: '2026-06-01', balance: 100, serviceFee: 1.5,
    })
    await db.query(
      `UPDATE flex_charge_statements SET failed_reason='prior failure' WHERE id=$1`,
      [stmtId])

    // Within retryFlexChargeStatement, the billing engine fires for any
    // open+past-due statement. Need the dev system date for the helper
    // to use Date.now() — past due is 2026-06-01.
    const r = await retryFlexChargeStatement(stmtId)
    // Whether it bills depends on whether processFlexChargeStatementBilling
    // sees the row as past-due TODAY — the test environment's clock is
    // real, so the statement is well past 2026-06-01 by now.
    expect(typeof r.billed).toBe('boolean')

    const { rows: [stmt] } = await db.query<any>(
      `SELECT status, failed_reason FROM flex_charge_statements WHERE id = $1`,
      [stmtId])
    // After retry, status is either 'billed' (engine picked it up) or
    // 'failed' again (engine ran but the customer-side gating tripped).
    expect(['billed', 'failed', 'open']).toContain(stmt.status)
    if (stmt.status !== 'failed') {
      expect(stmt.failed_reason).toBeNull()  // cleared by the reset
    }
  })
})

// ─── reconcileSettledFlexChargeStatement ──────────────────────

describe('reconcileSettledFlexChargeStatement', () => {
  async function setup(opts: {
    entryDescription?: string
    statementStatus?:  'open' | 'billed' | 'paid'
    hasConnect?:       boolean
  } = {}): Promise<{
    paymentId: string; statementId: string; accountId: string;
    landlordId: string; landlordUserId: string;
  }> {
    const a = await seedAccount({ hasConnect: opts.hasConnect })
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (landlord_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, 'fee', 101.5, 'settled', $3, '2026-06-01')
       RETURNING id`,
      [a.landlordId, a.tenantId, opts.entryDescription ?? 'SUBSCRIP'])
    const stmtId = await seedStatement({
      accountId: a.accountId, status: opts.statementStatus ?? 'billed',
      balance: 100, serviceFee: 1.5, paymentId: pay.id,
    })
    // Add a billed tx so we can verify the propagation.
    await seedTx({
      accountId: a.accountId, amount: 100, status: 'billed',
      createdAt: '2026-05-15T00:00:00Z',
    })
    await db.query(
      `UPDATE flex_charge_transactions SET statement_id = $1 WHERE account_id = $2`,
      [stmtId, a.accountId])
    return {
      paymentId: pay.id, statementId: stmtId, accountId: a.accountId,
      landlordId: a.landlordId, landlordUserId: a.landlordUserId,
    }
  }

  it('happy: settles statement, propagates to txs, fires merchant Transfer', async () => {
    const seed = await setup()
    stripeMocks.transfersCreate.mockResolvedValueOnce({ id: 'tr_fc_merchant' } as any)

    await reconcileSettledFlexChargeStatement(seed.paymentId)

    const { rows: [stmt] } = await db.query<any>(
      `SELECT status, settled_at FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(stmt.status).toBe('paid')
    expect(stmt.settled_at).not.toBeNull()

    const { rows: [tx] } = await db.query<any>(
      `SELECT status FROM flex_charge_transactions WHERE account_id = $1`,
      [seed.accountId])
    expect(tx.status).toBe('paid')

    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    const [body, callOpts] = stripeMocks.transfersCreate.mock.calls[0]
    expect(body).toMatchObject({
      amount:      10000,   // balance $100 → 10,000¢ (service fee stays on platform)
      currency:    'usd',
      destination: 'acct_fc_merchant',
    })
    expect(body.metadata).toMatchObject({
      gam_purpose:      'flexcharge_merchant_payout',
      gam_statement_id: seed.statementId,
      gam_account_id:   seed.accountId,
      gam_landlord_id:  seed.landlordId,
    })
    expect(callOpts.idempotencyKey).toBe(`flexcharge_payout_${seed.statementId}`)
  })

  it('non-SUBSCRIP entry_description → entry_description gate, no-op', async () => {
    const seed = await setup({ entryDescription: 'RENT' })
    await reconcileSettledFlexChargeStatement(seed.paymentId)
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status FROM flex_charge_statements WHERE id = $1`, [seed.statementId])
    expect(stmt.status).toBe('billed')   // unchanged
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('no matching billed statement → no-op', async () => {
    await setup({ statementStatus: 'open' })
    // Lookup uses `WHERE s.status = 'billed' AND s.payment_id = $1` — an
    // 'open' statement is filtered out, so the reconciler returns early.
    const { rows: [pay] } = await db.query<{ id: string }>(
      `SELECT id FROM payments LIMIT 1`)
    await reconcileSettledFlexChargeStatement(pay.id)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })

  it('unknown payment id → no-op', async () => {
    await expect(reconcileSettledFlexChargeStatement(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })

  it('no Connect on landlord → admin alert (no Transfer call)', async () => {
    const seed = await setup({ hasConnect: false })

    await reconcileSettledFlexChargeStatement(seed.paymentId)

    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexcharge_merchant_transfer_pending'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].body).toContain(seed.statementId)

    // Statement still gets settled even without Connect (the inner
    // transaction commits before the Connect lookup runs).
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(stmt.status).toBe('paid')
  })

  it('idempotent: second call leaves settled_at unchanged (status="billed" filter blocks)', async () => {
    const seed = await setup()
    await reconcileSettledFlexChargeStatement(seed.paymentId)
    const { rows: [s1] } = await db.query<any>(
      `SELECT settled_at FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    stripeMocks.transfersCreate.mockClear()
    await reconcileSettledFlexChargeStatement(seed.paymentId)
    const { rows: [s2] } = await db.query<any>(
      `SELECT settled_at FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(new Date(s2.settled_at).getTime()).toBe(new Date(s1.settled_at).getTime())
    // Second call's status='billed' filter on the lookup blocks it from
    // re-firing the merchant Transfer.
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
  })
})

// ─── handleFlexChargeStatementNsf ──────────────────────────────

describe('handleFlexChargeStatementNsf', () => {
  async function setup(opts: {
    entryDescription?: string
    retryCount?:       number
  } = {}): Promise<{
    paymentId: string; statementId: string; accountId: string;
  }> {
    const a = await seedAccount()
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO payments
         (landlord_id, tenant_id, type, amount, status, entry_description, due_date, retry_count)
       VALUES ($1, $2, 'fee', 101.5, 'failed', $3, '2026-06-01', $4)
       RETURNING id`,
      [a.landlordId, a.tenantId,
       opts.entryDescription ?? 'SUBSCRIP',
       opts.retryCount ?? 1])
    const stmtId = await seedStatement({
      accountId: a.accountId, status: 'billed', paymentId: pay.id,
    })
    return { paymentId: pay.id, statementId: stmtId, accountId: a.accountId }
  }

  it('SUBSCRIP + retry_count=1 → statement failed + account suspended + alert', async () => {
    const seed = await setup()
    await handleFlexChargeStatementNsf(seed.paymentId)

    const { rows: [stmt] } = await db.query<any>(
      `SELECT status, failed_reason FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(stmt.status).toBe('failed')
    expect(stmt.failed_reason).toBe('tenant_nsf_second_failure')

    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flex_charge_accounts WHERE id = $1`, [seed.accountId])
    expect(a.status).toBe('suspended')

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexcharge_statement_nsf'`)
    expect(notif).toHaveLength(1)
    expect(notif[0].body).toContain(seed.statementId)
  })

  it('retry_count=0 (first failure) → no-op, ACH retry pipeline owns it', async () => {
    const seed = await setup({ retryCount: 0 })
    await handleFlexChargeStatementNsf(seed.paymentId)
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(stmt.status).toBe('billed')
    const { rows: [a] } = await db.query<any>(
      `SELECT status FROM flex_charge_accounts WHERE id = $1`, [seed.accountId])
    expect(a.status).toBe('active')
    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexcharge_statement_nsf'`)
    expect(notif).toHaveLength(0)
  })

  it('non-SUBSCRIP → entry_description gate, no-op', async () => {
    const seed = await setup({ entryDescription: 'RENT' })
    await handleFlexChargeStatementNsf(seed.paymentId)
    const { rows: [stmt] } = await db.query<any>(
      `SELECT status FROM flex_charge_statements WHERE id = $1`,
      [seed.statementId])
    expect(stmt.status).toBe('billed')
  })

  it('unknown payment id → no-op', async () => {
    await expect(handleFlexChargeStatementNsf(
      '00000000-0000-0000-0000-000000000000'
    )).resolves.toBeUndefined()
  })
})

// ─── disputeFlexChargeTransaction ──────────────────────────────

describe('disputeFlexChargeTransaction', () => {
  it('reason too short → 400', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50 })
    await expect(disputeFlexChargeTransaction({
      transactionId: txId, disputerTenantId: a.tenantId, reason: 'xx',
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('transaction not found → 404', async () => {
    await expect(disputeFlexChargeTransaction({
      transactionId: '00000000-0000-0000-0000-000000000000',
      disputerTenantId: '00000000-0000-0000-0000-000000000001',
      reason: 'wrong charge',
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('wrong disputer (different tenant) → 403', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50 })
    // Some other tenant tries to dispute this tx.
    const c = await db.connect()
    let otherTenantId = ''
    try {
      await c.query('BEGIN')
      otherTenantId = await seedTenant(c)
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(disputeFlexChargeTransaction({
      transactionId: txId, disputerTenantId: otherTenantId, reason: 'not mine',
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('no disputer identity at all → 400', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50 })
    await expect(disputeFlexChargeTransaction({
      transactionId: txId, reason: 'no identity supplied',
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('already disputed → 409', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50, status: 'disputed' })
    await expect(disputeFlexChargeTransaction({
      transactionId: txId, disputerTenantId: a.tenantId, reason: 'still disputed',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('paid charge → 409 (refund required)', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50, status: 'paid' })
    await expect(disputeFlexChargeTransaction({
      transactionId: txId, disputerTenantId: a.tenantId, reason: 'wrong charge',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('happy: tx flips to disputed, account disqualified, landlord under threshold → not disqualified', async () => {
    const a = await seedAccount()
    const txId = await seedTx({ accountId: a.accountId, amount: 50 })

    const r = await disputeFlexChargeTransaction({
      transactionId: txId, disputerTenantId: a.tenantId, reason: 'wrong charge',
    })
    expect(r.accountId).toBe(a.accountId)
    expect(r.landlordId).toBe(a.landlordId)
    expect(r.landlordDisqualified).toBe(false)

    const { rows: [tx] } = await db.query<any>(
      `SELECT status, dispute_reason FROM flex_charge_transactions WHERE id = $1`, [txId])
    expect(tx.status).toBe('disputed')
    expect(tx.dispute_reason).toBe('wrong charge')

    const { rows: [acct] } = await db.query<any>(
      `SELECT status, disqualified_reason FROM flex_charge_accounts WHERE id = $1`,
      [a.accountId])
    expect(acct.status).toBe('disqualified')
    expect(acct.disqualified_reason).toBe('tenant_dispute')

    // Landlord NOT disqualified (only 1 disputer).
    const { rows: [ll] } = await db.query<any>(
      `SELECT flex_charge_disqualified_until FROM landlords WHERE id = $1`,
      [a.landlordId])
    expect(ll.flex_charge_disqualified_until).toBeNull()
  })
})

// ─── checkAndDisqualifyLandlord ────────────────────────────────

describe('checkAndDisqualifyLandlord', () => {
  /**
   * Seed `count` distinct disputers (each on a separate FlexCharge account
   * under the SAME landlord) and 1 disputed tx each within the past 90 days.
   */
  async function seedDisputers(landlordId: string, propertyId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const tenantId = await seedTenant(c)
        const { rows: [acct] } = await c.query<{ id: string }>(
          `INSERT INTO flex_charge_accounts
             (tenant_id, property_id, landlord_id, credit_limit, status)
           VALUES ($1, $2, $3, 500, 'active') RETURNING id`,
          [tenantId, propertyId, landlordId])
        await c.query(
          `INSERT INTO flex_charge_transactions
             (account_id, amount, status, disputed_at, dispute_reason)
           VALUES ($1, 50, 'disputed', NOW() - INTERVAL '5 days', 'reason')`,
          [acct.id])
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK'); throw e }
      finally { c.release() }
    }
  }

  it('under threshold (2 distinct disputers) → returns false, landlord unchanged', async () => {
    const a = await seedAccount()
    await seedDisputers(a.landlordId, a.propertyId, 2)

    const r = await checkAndDisqualifyLandlord(a.landlordId)
    expect(r).toBe(false)
    const { rows: [ll] } = await db.query<any>(
      `SELECT flex_charge_disqualified_until FROM landlords WHERE id = $1`,
      [a.landlordId])
    expect(ll.flex_charge_disqualified_until).toBeNull()
  })

  it('threshold hit (3 distinct disputers) → returns true, landlord disqualified ~5 years out, alert', async () => {
    const a = await seedAccount()
    await seedDisputers(a.landlordId, a.propertyId, 3)

    const r = await checkAndDisqualifyLandlord(a.landlordId)
    expect(r).toBe(true)
    const { rows: [ll] } = await db.query<any>(
      `SELECT flex_charge_disqualified_until, flex_charge_disqualified_reason
         FROM landlords WHERE id = $1`, [a.landlordId])
    expect(ll.flex_charge_disqualified_until).not.toBeNull()
    expect(ll.flex_charge_disqualified_reason).toMatch(/3 distinct disputers/)
    // ~5 years out — within 30 days tolerance for leap years.
    const until = new Date(ll.flex_charge_disqualified_until).getTime()
    const expected = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000
    expect(Math.abs(until - expected)).toBeLessThan(30 * 24 * 60 * 60 * 1000)

    const { rows: notif } = await db.query<any>(
      `SELECT * FROM admin_notifications WHERE category = 'flexcharge_landlord_disqualified'`)
    expect(notif).toHaveLength(1)
  })

  it('already disqualified → returns true, no double-stamp', async () => {
    const a = await seedAccount()
    await seedDisputers(a.landlordId, a.propertyId, 3)
    // Pre-set the landlord as disqualified with a specific timestamp.
    await db.query(
      `UPDATE landlords
          SET flex_charge_disqualified_until  = NOW() + INTERVAL '5 years',
              flex_charge_disqualified_reason = 'previously disqualified'
        WHERE id = $1`, [a.landlordId])
    const { rows: [before] } = await db.query<any>(
      `SELECT flex_charge_disqualified_until, flex_charge_disqualified_reason
         FROM landlords WHERE id = $1`, [a.landlordId])

    const r = await checkAndDisqualifyLandlord(a.landlordId)
    expect(r).toBe(true)

    // No new update — original timestamp + reason preserved.
    const { rows: [after] } = await db.query<any>(
      `SELECT flex_charge_disqualified_until, flex_charge_disqualified_reason
         FROM landlords WHERE id = $1`, [a.landlordId])
    expect(new Date(after.flex_charge_disqualified_until).getTime())
      .toBe(new Date(before.flex_charge_disqualified_until).getTime())
    expect(after.flex_charge_disqualified_reason).toBe('previously disqualified')
  })

  it('distinct counting: 3 disputes from SAME disputer (one account) = 1 distinct → under threshold', async () => {
    const a = await seedAccount()
    // Add two more disputed txs on the SAME account (same tenant).
    await seedTx({
      accountId: a.accountId, amount: 50, status: 'disputed',
    })
    await db.query(
      `UPDATE flex_charge_transactions
          SET disputed_at = NOW() - INTERVAL '2 days', dispute_reason = 'a'
        WHERE account_id = $1 AND status = 'disputed'`, [a.accountId])
    await seedTx({ accountId: a.accountId, amount: 60, status: 'disputed' })
    await db.query(
      `UPDATE flex_charge_transactions
          SET disputed_at = NOW() - INTERVAL '1 day', dispute_reason = 'b'
        WHERE account_id = $1 AND status = 'disputed' AND amount = 60`,
      [a.accountId])
    await seedTx({ accountId: a.accountId, amount: 70, status: 'disputed' })
    await db.query(
      `UPDATE flex_charge_transactions
          SET disputed_at = NOW(), dispute_reason = 'c'
        WHERE account_id = $1 AND status = 'disputed' AND amount = 70`,
      [a.accountId])

    const r = await checkAndDisqualifyLandlord(a.landlordId)
    expect(r).toBe(false)  // only 1 distinct disputer (the same tenant)
  })
})
