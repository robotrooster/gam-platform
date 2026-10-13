/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family E: money taken back after
 * it settled (gam-ledger-design-2026-10-12 §6 E1; §17 "E1 with the share
 * unpaid", "a reversed credit use", "a returned row keeping its receipt").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import {
  cleanupTenantLedger, tenantCo, bill, receipt, spend, drain, bal, received, activeLines, triples, type TenantCo,
} from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

/** What services/paymentReversal leaves: the record, the original row returned, a fresh row for what is owed again. */
async function dispute(co: TenantCo, paymentId: string, o: { lost: number; owedAgain: number; at: string; type?: string; due?: string }): Promise<{ reversalId: string; freshId: string | null }> {
  const reversalId = (await db.query<{ id: string }>(
    `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event,
                                    recovery_status, status, created_at)
     VALUES ($1, $2, $3, $4, 'card_dispute', $5, $6, '{}'::jsonb, 'pending', 'open', $7) RETURNING id`,
    [paymentId, co.landlordId, co.tenantId, co.leaseId, o.lost, `evt_${randomUUID()}`, o.at])).rows[0].id
  await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [paymentId])
  const freshId = o.owedAgain > 0
    ? await bill(co, { type: o.type ?? 'rent', amount: o.owedAgain, due: o.due ?? '2026-09-01', reversalId })
    : null
  if (freshId) await db.query(`UPDATE payments SET is_remainder = TRUE WHERE id = $1`, [freshId])
  return { reversalId, freshId }
}

describe('E1: a payment taken back', () => {
  it('the original receipt stays; the reversal reopens what is owed (Received goes negative that day) and takes it back from Due from GAM', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 1000, due: '2026-09-01' })
    const { remittanceId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z', apps: [{ paymentId: rent, amount: 1000 }] })
    await drain()
    const { reversalId, freshId } = await dispute(co, rent, { lost: 1000, owedAgain: 1000, at: '2026-09-20T18:00:00Z' })
    await drain()
    expect(await activeLines('remittance', remittanceId)).toHaveLength(2)   // the returned row keeps its receipt
    expect(triples(await activeLines('payment', rent))).toEqual([['ar_tenants', 100000, 0], ['space_rent', 0, 100000]])
    expect(await activeLines('payment', freshId!)).toEqual([])            // its charge is the reversal's
    const lines = await activeLines('payment_reversal', reversalId)
    expect(lines.every(l => l.day === '2026-09-20')).toBe(true)
    expect(triples(lines)).toEqual([['ar_tenants', 100000, 0], ['due_from_gam', 0, 100000]])
    expect(lines.find(l => l.role === 'ar_tenants')?.paymentId).toBe(freshId)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(100000)
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(0)
    expect(await received(co.landlordId, '2026-09-20', '2026-09-20')).toBe(-100000)
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30')).toBe(0)
    // The tenant pays again: an ordinary receipt closes it.
    await receipt(co, { method: 'ach', settledAt: '2026-09-25T18:00:00Z', apps: [{ paymentId: freshId!, amount: 1000 }] })
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(co.landlordId, 'space_rent')).toBe(-100000)   // charged once
  })

  it('a row whose loss was all GAM-first money gets no fresh row and posts nothing', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 200, due: '2026-09-01' })
    await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z', apps: [{ paymentId: rent, amount: 200 }] })
    const { reversalId } = await dispute(co, rent, { lost: 50, owedAgain: 0, at: '2026-09-20T18:00:00Z' })
    await drain()
    expect(await activeLines('payment_reversal', reversalId)).toEqual([])
  })

  it('a deposit GAM still holds is taken back from 1070', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 600, due: '2026-09-01', depositCollectedBy: 'gam' })
    await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z', apps: [{ paymentId: dep, amount: 600 }] })
    const { reversalId } = await dispute(co, dep, { lost: 600, owedAgain: 600, at: '2026-09-21T18:00:00Z', type: 'deposit' })
    await drain()
    expect(triples(await activeLines('payment_reversal', reversalId))).toEqual([['ar_tenants', 60000, 0], ['deposits_gam_holds', 0, 60000]])
    expect(await bal(co.landlordId, 'deposits_gam_holds')).toBe(0)
  })

  it('a bill paid by disputed paid-ahead money (the credit_spend shape): the spend stays, the bill reopens once', async () => {
    const co = await tenantCo()
    const sept = await bill(co, { amount: 300, due: '2026-09-01' })
    const { creditId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
      apps: [{ paymentId: sept, amount: 300 }], surplus: 300 })
    const oct = await bill(co, { amount: 300, due: '2026-10-01' })
    const use = await spend(co, { paymentId: oct, prepaidCreditId: creditId!, amount: 300, appliedAt: '2026-10-01T15:00:00Z' })
    await drain()
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(60000)
    // The card that funded the paid-ahead money is disputed: the spend is undone and October reopens.
    await db.query(`UPDATE credit_uses SET status = 'reversed', released_at = '2026-10-10T18:00:00Z', release_reason = 'funding_reversed' WHERE id = $1`, [use])
    const { reversalId, freshId } = await dispute(co, oct, { lost: 300, owedAgain: 300, at: '2026-10-10T18:00:00Z', due: '2026-10-01' })
    await drain()
    expect(triples(await activeLines('credit_use', use))).toEqual([['due_from_gam', 30000, 0], ['ar_tenants', 0, 30000]])
    expect(triples(await activeLines('payment_reversal', reversalId))).toEqual([['ar_tenants', 30000, 0], ['due_from_gam', 0, 30000]])
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(30000)
    expect((await activeLines('payment_reversal', reversalId)).find(l => l.role === 'ar_tenants')?.paymentId).toBe(freshId)
    expect(await received(co.landlordId, '2026-10-01', '2026-10-31')).toBe(0)
  })
})
