/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family B: tenant money in posts
 * itself (gam-ledger-design-2026-10-12 §6 B1-B10; §17 "Projectors").
 *
 *   Nic 10/12: "payments when received (always)"; money GAM collected but not
 *   yet paid out is held by GAM until the payout lands; paid-ahead money GAM
 *   holds is not on the landlord's balance sheet until it pays a bill (L13).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../../test/dbHelpers'
import { inTx } from '../../test/ledgerFixtures'
import {
  tenantCo, bill, receipt, drain, bal, received, activeLines, triples, bankConnection,
} from '../../test/ledgerTenantFixtures'
import { cleanupTenantLedger } from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

describe('B1: a card or bank payment through GAM', () => {
  it('posts on the day it settled: Due from GAM / receivables, counted as received under each row\'s category', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 1000, due: '2026-09-01' })
    const late = await bill(co, { type: 'late_fee', amount: 25, due: '2026-09-06' })
    const gamFee = await bill(co, { type: 'fee', entry: 'DECLINEFEE', amount: 15, due: '2026-09-06', revenueOwner: 'gam' })
    const { remittanceId } = await receipt(co, {
      method: 'ach', settledAt: '2026-09-08T18:00:00Z',
      apps: [{ paymentId: rent, amount: 1000 }, { paymentId: late, amount: 25 }, { paymentId: gamFee, amount: 15 }],
    })
    await drain()
    const lines = await activeLines('remittance', remittanceId)
    expect(lines.every(l => l.day === '2026-09-08' && l.kind === 'main')).toBe(true)
    expect(triples(lines)).toEqual([['ar_tenants', 0, 100000], ['ar_tenants', 0, 2500], ['due_from_gam', 102500, 0]])
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30', 'space_rent')).toBe(100000)
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30', 'late_fees')).toBe(2500)
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30')).toBe(102500)   // GAM's own fee never on the landlord's book
  })

  it('a receipt that paid two companies\' rows posts once per company, each with its own rows', async () => {
    const co = await tenantCo()
    const other = await inTx(async c => {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: co.tenantId })
      await c.query(`UPDATE landlords SET books_start_date = '2026-01-01' WHERE id = $1`, [landlordId])
      return { landlordId, unitId, leaseId, propertyId }
    })
    await db.query(`DELETE FROM ledger_outbox WHERE owner_id = $1`, [other.landlordId])
    const mine = await bill(co, { amount: 500, due: '2026-09-01' })
    const theirs = await bill(co, { type: 'utility', amount: 40, due: '2026-09-01', landlordId: other.landlordId,
      unitId: other.unitId, leaseId: other.leaseId })
    const { remittanceId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
      apps: [{ paymentId: mine, amount: 500 }, { paymentId: theirs, amount: 40 }] })
    await drain()
    expect(triples(await activeLines('remittance', remittanceId, co.landlordId))).toEqual([['ar_tenants', 0, 50000], ['due_from_gam', 50000, 0]])
    expect(triples(await activeLines('remittance', remittanceId, other.landlordId))).toEqual([['ar_tenants', 0, 4000], ['due_from_gam', 4000, 0]])
    expect(await bal(other.landlordId, 'ar_tenants')).toBe(0)
  })

  it('L13: a card surplus kept as paid-ahead money is GAM\'s to hold and books nothing; it books when it pays a bill', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 500, due: '2026-09-01' })
    const { remittanceId, creditId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
      apps: [{ paymentId: rent, amount: 500 }], surplus: 120 })
    await drain()
    expect(triples(await activeLines('remittance', remittanceId))).toEqual([['ar_tenants', 0, 50000], ['due_from_gam', 50000, 0]])
    expect(await activeLines('prepaid_credit', creditId!)).toEqual([])
    expect(await bal(co.landlordId, 'tenant_prepayments')).toBe(0)
    expect(await bal(co.landlordId, 'due_from_gam_tenant_money')).toBe(0)
  })

  it('a deposit row paid online is held by GAM (1070); an old destination charge put it in the landlord\'s bank', async () => {
    const co = await tenantCo()
    const dep = await bill(co, { type: 'deposit', amount: 800, due: '2026-09-01', depositCollectedBy: 'gam' })
    const old = await bill(co, { type: 'deposit', amount: 100, due: '2026-09-01', depositCollectedBy: 'landlord' })
    const { remittanceId } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
      apps: [{ paymentId: dep, amount: 800 }, { paymentId: old, amount: 100 }] })
    await drain()
    const lines = await activeLines('remittance', remittanceId)
    expect(triples(lines).sort()).toEqual([
      ['ar_tenants', 0, 10000], ['ar_tenants', 0, 80000], ['bank_checking', 10000, 0], ['deposits_gam_holds', 80000, 0]])
    expect(lines.find(l => l.role === 'deposits_gam_holds')?.leaseId).toBe(co.leaseId)
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30', 'deposits')).toBe(90000)
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(-90000)
  })
})

describe('B3 / B4: money taken at the desk', () => {
  it('cash lands in undeposited funds; the extra kept as paid-ahead money is the landlord\'s liability (2050), received now', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 400, due: '2026-09-01' })
    const { remittanceId, creditId } = await receipt(co, { method: 'cash', settledAt: '2026-09-05T17:00:00Z',
      apps: [{ paymentId: rent, amount: 400 }], surplus: 400 })
    await drain()
    expect(triples(await activeLines('remittance', remittanceId))).toEqual([
      ['ar_tenants', 0, 40000], ['tenant_prepayments', 0, 40000], ['undeposited_funds', 80000, 0],
    ])
    expect(await activeLines('prepaid_credit', creditId!)).toEqual([])   // its receipt booked it
    expect(await received(co.landlordId, '2026-09-01', '2026-09-30', 'paid_ahead')).toBe(40000)
  })

  it('money posted ahead with nothing owed is all paid-ahead money; a voided credit is a correction', async () => {
    const co = await tenantCo()
    const { remittanceId, creditId } = await receipt(co, { method: 'check', settledAt: '2026-09-20T17:00:00Z', apps: [], surplus: 1000 })
    await drain()
    expect(triples(await activeLines('remittance', remittanceId))).toEqual([['tenant_prepayments', 0, 100000], ['undeposited_funds', 100000, 0]])
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = now(), void_reason = 'entered twice' WHERE id = $1`, [creditId])
    await drain()
    expect(await activeLines('remittance', remittanceId)).toEqual([])
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(0)
  })

  it('an undone receipt is taken back (a correction on its own day)', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 300, due: '2026-09-01' })
    const { remittanceId } = await receipt(co, { method: 'bank_deposit', settledAt: '2026-09-04T17:00:00Z',
      apps: [{ paymentId: rent, amount: 300 }] })
    await drain()
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(30000)
    await db.query(`UPDATE tenant_remittances SET status = 'failed', undone_at = now() WHERE id = $1`, [remittanceId])
    await db.query(`UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL WHERE id = $1`, [rent])
    await drain()
    expect(await activeLines('remittance', remittanceId)).toEqual([])
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(30000)
  })
})

describe('B5 / B6 / B8: money reaching the bank', () => {
  it('a bank-deposit receipt sits in deposits in transit until its bank line is matched, then moves to that bank on the posted day', async () => {
    const co = await tenantCo()
    const conn = await bankConnection(co)
    const rent = await bill(co, { amount: 650, due: '2026-09-01' })
    const { remittanceId } = await receipt(co, { method: 'bank_deposit', settledAt: '2026-09-03T17:00:00Z',
      apps: [{ paymentId: rent, amount: 650 }] })
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, matched_payment_id, auto_settle_undo)
       VALUES ($1, $2, $3, '2026-09-05', 650, 'matched', $4, jsonb_build_object('receiptId', $5::text)) RETURNING id`,
      [conn, co.landlordId, `ext_${randomUUID()}`, rent, remittanceId])).rows[0].id
    await drain()
    const leg = await activeLines('bank_match', line)
    expect(leg.every(l => l.day === '2026-09-05')).toBe(true)
    expect(triples(leg)).toEqual([['bank_checking', 65000, 0], ['deposits_in_transit', 0, 65000]])
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(0)
    expect(await bal(co.landlordId, 'bank_checking')).toBe(65000)
    // Un-matched: a correction — the money is in transit again.
    await db.query(`UPDATE bank_transactions SET status = 'needs_review', auto_settle_undo = NULL WHERE id = $1`, [line])
    await drain()
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(65000)
  })

  it('B8 a deposit slip matched to a bank line moves the desk cash (and the slip\'s other money) to the bank', async () => {
    const co = await tenantCo()
    const conn = await bankConnection(co)
    const rent = await bill(co, { amount: 200, due: '2026-09-01' })
    const { remittanceId } = await receipt(co, { method: 'cash', settledAt: '2026-09-02T17:00:00Z', apps: [{ paymentId: rent, amount: 200 }] })
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       VALUES ($1, $2, $3, '2026-09-04', 225, 'matched') RETURNING id`, [conn, co.landlordId, `ext_${randomUUID()}`])).rows[0].id
    const slip = await inTx(async c => {
      const s = (await c.query<{ id: string }>(
        `INSERT INTO bank_deposit_slips (landlord_id, property_id, deposit_date, total, other_amount, other_note, source, status,
                                         bank_transaction_id, matched_at, created_by)
         VALUES ($1, $2, '2026-09-03', 225, 25, 'vending', 'staff', 'matched', $3, now(), $4) RETURNING id`,
        [co.landlordId, co.propertyId, line, co.ownerUserId])).rows[0].id
      await c.query(`INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1, $2, 200)`, [s, remittanceId])
      return s
    })
    await drain()
    expect(triples(await activeLines('deposit_slip', slip))).toEqual([['bank_checking', 22500, 0], ['undeposited_funds', 0, 22500]])
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(-2500)   // the other money's income is filed by phase P6
  })
})

describe('B7 / B9 / B10: settled with no receipt; the register drawer', () => {
  it('B7 a prior arrangement books to "paid before GAM, to confirm", received on the day it settled', async () => {
    const co = await tenantCo()
    const id = await bill(co, { amount: 182.5, due: '2026-09-01', status: 'settled', manualMethod: 'prior_arrangement',
      settledAt: '2026-09-18T18:00:00Z' })
    await drain()
    const lines = await activeLines('payment', id)
    expect(triples(lines, 'prior_arrangement')).toEqual([['suspense', 18250, 0], ['ar_tenants', 0, 18250]])
    expect(lines.find(l => l.kind === 'prior_arrangement')?.day).toBe('2026-09-18')
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
  })

  it('B10 a bill GAM covered is Due from GAM, received — memo "Paid on time", never the product', async () => {
    const co = await tenantCo()
    const advance = (await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day)
       VALUES ('2026-09-01', $1, $2, $3, $4, 900, 25, 15) RETURNING id`, [co.tenantId, co.landlordId, co.unitId, co.leaseId])).rows[0].id
    const id = await bill(co, { amount: 900, due: '2026-09-01', status: 'settled', flexpayAdvanceId: advance,
      settledAt: '2026-09-06T18:00:00Z' })
    await drain()
    expect(triples(await activeLines('payment', id), 'gam_cover')).toEqual([['due_from_gam', 90000, 0], ['ar_tenants', 0, 90000]])
    const memos = (await db.query<{ memo: string }>(
      `SELECT DISTINCT l.memo FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
        WHERE p.source_id = $1 AND p.posting_kind = 'gam_cover'`, [id])).rows.map(r => r.memo ?? '')
    expect(memos.join(' ')).not.toMatch(/flex/i)
  })

  it('B9 a register drawer short or over posts to cash over and short', async () => {
    const co = await tenantCo()
    const eod = (await db.query<{ id: string }>(
      `INSERT INTO pos_eod_settlements (landlord_id, property_id, business_day, opening_float, cash_sales, cash_refunds, cash_drawer_actual, status)
       VALUES ($1, $2, '2026-09-10', 100, 0, 0, 95, 'manually_closed') RETURNING id`, [co.landlordId, co.propertyId])).rows[0].id
    await drain()
    expect(triples(await activeLines('pos_eod', eod))).toEqual([['undeposited_funds', 0, 500], ['cash_over_short', 500, 0]])
    await db.query(`UPDATE pos_eod_settlements SET status = 'reopened' WHERE id = $1`, [eod])
    await drain()
    expect(await activeLines('pos_eod', eod)).toEqual([])
  })
})
