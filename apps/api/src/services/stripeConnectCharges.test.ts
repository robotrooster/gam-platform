/**
 * S435 services-audit slice 12 — second cut of stripeConnect.ts:
 * the destination-charge + transfer surface (4 functions).
 *
 *   - createRentDestinationCharge — PaymentIntent w/ transfer_data
 *     + application_fee_amount (the S113 destination-charge model)
 *   - createRentPlatformCharge   — PaymentIntent w/o transfer_data
 *     (S113-PhaseA platform-held safety valve)
 *   - createPmCompanyTransfer    — pure Stripe Transfer wrapper
 *   - firePmTransfersForReference — ledger-driven generic firing
 *     helper for `allocation_pm_company_fee` rows; idempotent on
 *     `stripe_transfer_id`
 *
 * Stripe is mocked at the lib/stripe module boundary; ledger / payment
 * rows are real. The S434 account-management slice lives in a separate
 * file (`stripeConnect.test.ts`); naming this file with a suffix keeps
 * vitest's file-level isolation and avoids stomping each other's mocks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  paymentIntentsCreateMock, transfersCreateMock, adminNotifyMock,
} = vi.hoisted(() => ({
  paymentIntentsCreateMock: vi.fn(async () => ({ id: 'pi_mock' } as any)),
  transfersCreateMock:      vi.fn(async () => ({ id: 'tr_mock' } as any)),
  adminNotifyMock:          vi.fn(async () => undefined),
}))

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: { create: paymentIntentsCreateMock },
    transfers:      { create: transfersCreateMock },
  }),
}))

vi.mock('./adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'
import {
  createRentDestinationCharge, createRentPlatformCharge,
  createPmCompanyTransfer, firePmTransfersForReference,
} from './stripeConnect'

beforeEach(async () => {
  await cleanupAllSchema()
  paymentIntentsCreateMock.mockReset()
  transfersCreateMock.mockReset()
  adminNotifyMock.mockReset()
  paymentIntentsCreateMock.mockResolvedValue({ id: 'pi_default' } as any)
  transfersCreateMock.mockResolvedValue({ id: 'tr_default' } as any)
})

// ─── createRentDestinationCharge ─────────────────────────────

describe('createRentDestinationCharge', () => {
  const baseOpts = {
    amount: 1000,
    stripeCustomerId: 'cus_test',
    paymentMethodId: 'pm_test',
    destinationConnectAccountId: 'acct_landlord',
    applicationFeeAmount: 10.50,
    entryDescription: 'RENT',
  }

  it('happy ACH: cents conversion + transfer_data + application_fee_amount + mandate_data + financial_connections', async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({ id: 'pi_ach' } as any)
    await createRentDestinationCharge({
      ...baseOpts, paymentMethodTypes: ['us_bank_account'],
    })
    expect(paymentIntentsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 100000,                    // dollars × 100
      currency: 'usd',
      customer: 'cus_test',
      payment_method: 'pm_test',
      payment_method_types: ['us_bank_account'],
      confirm: true,
      transfer_data: { destination: 'acct_landlord' },
      application_fee_amount: 1050,
      description: 'RENT - Gold Asset Management',
      metadata: expect.objectContaining({ entry_description: 'RENT' }),
      mandate_data: expect.objectContaining({
        customer_acceptance: expect.objectContaining({ type: 'online' }),
      }),
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ['payment_method'] },
        },
      },
    }))
  })

  it('happy card: NO mandate_data, NO payment_method_options', async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({ id: 'pi_card' } as any)
    await createRentDestinationCharge({
      ...baseOpts, paymentMethodTypes: ['card'],
    })
    const call = (paymentIntentsCreateMock.mock.calls[0] as any[])[0]
    expect(call.mandate_data).toBeUndefined()
    expect(call.payment_method_options).toBeUndefined()
    expect(call.transfer_data).toEqual({ destination: 'acct_landlord' })
  })

  it('merges caller metadata with entry_description', async () => {
    await createRentDestinationCharge({
      ...baseOpts, paymentMethodTypes: ['card'],
      metadata: { gam_payment_id: 'p_123', custom: 'value' },
    })
    expect(paymentIntentsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        entry_description: 'RENT',
        gam_payment_id:    'p_123',
        custom:            'value',
      },
    }))
  })

  it('cents rounding on fractional dollars ($33.33 + $1.234 fee → 3333 + 123)', async () => {
    await createRentDestinationCharge({
      ...baseOpts,
      amount: 33.33,
      applicationFeeAmount: 1.234,
      paymentMethodTypes: ['card'],
    })
    expect(paymentIntentsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 3333,
      application_fee_amount: 123,  // Math.round(1.234 * 100) = 123
    }))
  })
})

// ─── createRentPlatformCharge ────────────────────────────────

describe('createRentPlatformCharge', () => {
  const baseOpts = {
    amount: 1000,
    stripeCustomerId: 'cus_test',
    paymentMethodId: 'pm_test',
    entryDescription: 'RENT',
  }

  it('no transfer_data, no application_fee_amount', async () => {
    await createRentPlatformCharge({
      ...baseOpts, paymentMethodTypes: ['card'],
    })
    const call = (paymentIntentsCreateMock.mock.calls[0] as any[])[0]
    expect(call.transfer_data).toBeUndefined()
    expect(call.application_fee_amount).toBeUndefined()
    expect(call.amount).toBe(100000)
  })

  it('metadata stamps platform_held=true (downstream uses this to flip payments.platform_held)', async () => {
    await createRentPlatformCharge({
      ...baseOpts, paymentMethodTypes: ['card'],
    })
    expect(paymentIntentsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        platform_held: 'true',
        entry_description: 'RENT',
      }),
    }))
  })

  it('ACH path adds mandate_data + financial_connections', async () => {
    await createRentPlatformCharge({
      ...baseOpts, paymentMethodTypes: ['us_bank_account'],
    })
    const call = (paymentIntentsCreateMock.mock.calls[0] as any[])[0]
    expect(call.mandate_data).toBeDefined()
    expect(call.payment_method_options?.us_bank_account?.financial_connections)
      .toEqual({ permissions: ['payment_method'] })
  })
})

// ─── createPmCompanyTransfer ─────────────────────────────────

describe('createPmCompanyTransfer', () => {
  it('amount cents-converted; destination + metadata + default description', async () => {
    await createPmCompanyTransfer({
      amount: 12.34,
      destinationConnectAccountId: 'acct_pm',
      metadata: { gam_ledger_id: 'l_1' },
    })
    expect(transfersCreateMock).toHaveBeenCalledWith({
      amount: 1234,
      currency: 'usd',
      destination: 'acct_pm',
      description: 'PM company fee',
      metadata: { gam_ledger_id: 'l_1' },
    })
  })

  it('sourceTransactionId included when provided (S113-Phase2.5 charge sourcing)', async () => {
    await createPmCompanyTransfer({
      amount: 50,
      destinationConnectAccountId: 'acct_pm',
      sourceTransactionId: 'ch_source',
      metadata: {},
    })
    expect(transfersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      source_transaction: 'ch_source',
    }))
  })

  it('custom description overrides default', async () => {
    await createPmCompanyTransfer({
      amount: 50,
      destinationConnectAccountId: 'acct_pm',
      metadata: {},
      description: 'Custom fee description',
    })
    expect(transfersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Custom fee description',
    }))
  })
})

// ─── firePmTransfersForReference ─────────────────────────────

describe('firePmTransfersForReference', () => {
  interface PmCtx {
    pmUserId: string
    payerLandlordId: string
    unitId: string
    tenantId: string
    paymentId: string
  }

  async function seedPmCtx(opts: { pmConnect?: string | null; stripeChargeId?: string | null } = {}): Promise<PmCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      // Seed a separate PM-payee user.
      const { rows: [{ id: pmUserId }] } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name, role)
         VALUES ($1, 'hash', 'PM', 'Payee', 'admin') RETURNING id`,
        [`pm-${Date.now()}-${Math.random()}@example.com`])
      if (opts.pmConnect !== null) {
        await c.query(
          `UPDATE users SET stripe_connect_account_id=$2 WHERE id=$1`,
          [pmUserId, opts.pmConnect ?? 'acct_pm_default'])
      }
      const { rows: [{ id: paymentId }] } = await c.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, stripe_charge_id)
         VALUES ($1, $2, $3, 'rent', 1000, 'settled', 'RENT', CURRENT_DATE, $4)
         RETURNING id`,
        [unitId, tenantId, landlordId, opts.stripeChargeId ?? null])
      await c.query('COMMIT')
      return { pmUserId, payerLandlordId: landlordId, unitId, tenantId, paymentId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function seedPmFeeLedger(ctx: PmCtx, amount: number, alreadyFiredId?: string): Promise<string> {
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO user_balance_ledger
         (user_id, type, amount, balance_after, reference_id, reference_type, notes, stripe_transfer_id)
       VALUES ($1, 'allocation_pm_company_fee', $2, $2, $3, 'payment', 'PM fee S435', $4)
       RETURNING id`,
      [ctx.pmUserId, amount, ctx.paymentId, alreadyFiredId ?? null])
    return id
  }

  it('no unfired rows → fired:0 failed:0; no Stripe call', async () => {
    const ctx = await seedPmCtx()
    const res = await firePmTransfersForReference('payment', ctx.paymentId)
    expect(res).toEqual({ fired: 0, failed: 0 })
    expect(transfersCreateMock).not.toHaveBeenCalled()
  })

  it('happy: fires transfer + stamps stripe_transfer_id on ledger row', async () => {
    const ctx = await seedPmCtx({ pmConnect: 'acct_pm_target' })
    const ledgerId = await seedPmFeeLedger(ctx, 75)
    transfersCreateMock.mockResolvedValueOnce({ id: 'tr_happy' } as any)
    const res = await firePmTransfersForReference('payment', ctx.paymentId)
    expect(res).toEqual({ fired: 1, failed: 0 })
    expect(transfersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      amount: 7500,
      destination: 'acct_pm_target',
      metadata: expect.objectContaining({
        gam_ledger_id: ledgerId,
        gam_reference_id: ctx.paymentId,
        gam_reference_type: 'payment',
      }),
    }))
    const { rows: [l] } = await db.query<any>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`, [ledgerId])
    expect(l.stripe_transfer_id).toBe('tr_happy')
  })

  it('reference_type=payment + payments.stripe_charge_id NOT NULL → passes as source_transaction', async () => {
    const ctx = await seedPmCtx({ stripeChargeId: 'ch_source_test' })
    await seedPmFeeLedger(ctx, 50)
    await firePmTransfersForReference('payment', ctx.paymentId)
    expect(transfersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      source_transaction: 'ch_source_test',
    }))
  })

  it('reference_type=lease → no source_transaction lookup; transfer omits the field', async () => {
    const ctx = await seedPmCtx()
    // Seed a ledger row referenced by lease, not payment.
    const c = await db.connect()
    let leaseId = ''
    try {
      await c.query('BEGIN')
      const { rows: [{ id }] } = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1, $2, 1000, 'fixed_term', 'active', '2025-01-01') RETURNING id`,
        [ctx.unitId, ctx.payerLandlordId])
      leaseId = id
      await c.query(
        `INSERT INTO user_balance_ledger
           (user_id, type, amount, balance_after, reference_id, reference_type, notes)
         VALUES ($1, 'allocation_pm_company_fee', 100, 100, $2, 'lease', 'PM fee')`,
        [ctx.pmUserId, leaseId])
      await c.query('COMMIT')
    } finally { c.release() }
    await firePmTransfersForReference('lease', leaseId)
    const call = (transfersCreateMock.mock.calls[0] as any[])[0]
    expect(call.source_transaction).toBeUndefined()
  })

  it('PM user has no Connect account → failed++, no Stripe call for that row', async () => {
    const ctx = await seedPmCtx({ pmConnect: null })
    await seedPmFeeLedger(ctx, 75)
    const res = await firePmTransfersForReference('payment', ctx.paymentId)
    expect(res).toEqual({ fired: 0, failed: 1 })
    expect(transfersCreateMock).not.toHaveBeenCalled()
  })

  it('already-fired row (stripe_transfer_id NOT NULL) excluded from query', async () => {
    const ctx = await seedPmCtx()
    await seedPmFeeLedger(ctx, 75, 'tr_already')
    const res = await firePmTransfersForReference('payment', ctx.paymentId)
    expect(res).toEqual({ fired: 0, failed: 0 })
    expect(transfersCreateMock).not.toHaveBeenCalled()
  })

  it('Stripe error → failed++ + admin notification fired', async () => {
    const ctx = await seedPmCtx()
    const ledgerId = await seedPmFeeLedger(ctx, 75)
    transfersCreateMock.mockRejectedValueOnce(new Error('Stripe is down'))
    const res = await firePmTransfersForReference('payment', ctx.paymentId)
    expect(res).toEqual({ fired: 0, failed: 1 })
    expect(adminNotifyMock).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      category: 'pm_transfer_failed',
    }))
    // Ledger row left unstamped — reconcile will retry.
    const { rows: [l] } = await db.query<any>(
      `SELECT stripe_transfer_id FROM user_balance_ledger WHERE id=$1`, [ledgerId])
    expect(l.stripe_transfer_id).toBeNull()
  })

})
