/**
 * 10/12 (Nic) — GAM Books ledger, the integrate step: the projectors and
 * tie-outs production runs with (services/ledgerProjectors) — P4 tenant money
 * and P5 the register, bookings and payout chain — post one company's money
 * end to end, a rebuild from scratch comes out the same, and every nightly
 * tie-out (tenant money, the payout chain, and Due from GAM, 1050) finds
 * nothing wrong (gam-ledger-design-2026-10-12 §8, §17 "Engine" and "Nightly
 * checks").
 *
 *   Nic 10/12: money GAM collected but not yet paid out is "held by GAM"
 *   until the payout lands.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { tenantCo, bill, receipt, drain, bal, cleanupTenantLedger, paidAhead, activeLines, triples, type TenantCo } from '../test/ledgerTenantFixtures'
import { sale } from '../test/ledgerP5Fixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector, drainLedgerOutbox, type LedgerProjector } from './ledgerEngine'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'
import {
  registerProductionLedgerProjectors, unregisterProductionLedgerProjectors, productionLedgerProjectors, composeLedgerProjector,
} from './ledgerProjectors'
import { dueFromGamExpectedCents } from './ledgerDueFromGamCheck'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { booksSettingsRouter } from '../routes/booksSettings'
import { errorHandler } from '../middleware/errorHandler'

const settingsApp = express()
settingsApp.use(express.json())
settingsApp.use('/api/books/setup', booksSettingsRouter)
settingsApp.use(errorHandler)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_ledger_production_set'
const ownerPass = (co: TenantCo) => jwt.sign(
  { userId: co.ownerUserId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [co.landlordId], permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => {
  unregisterProductionLedgerProjectors()
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})
afterAll(async () => {
  await cleanupTenantLedger()
})

/** A card rent payment GAM holds: the bill, the card receipt, the split and the owner share (as allocation writes them). */
async function heldRent(co: TenantCo, o: { amount: number; fee?: number; due: string; settledAt: string }): Promise<string> {
  const paymentId = await bill(co, { amount: o.amount, due: o.due })
  await receipt(co, { method: 'card', settledAt: o.settledAt, apps: [{ paymentId, amount: o.amount }] })
  const fee = o.fee ?? 0
  await db.query(
    `INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, landlord_fee_withheld, supersedence,
                                    pm_fee_due, pm_paid, manager_fee_due, manager_paid, short_by, owner_share, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, 0, 0, $6, $7)`,
    [paymentId, co.landlordId, co.propertyId, o.amount, fee, o.amount - fee, o.settledAt])
  await db.query(
    `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, property_id, created_at)
     VALUES ($1, 'allocation_owner_share', $2, 0, $3, 'payment', $4, $5)`,
    [co.ownerUserId, o.amount - fee, paymentId, co.propertyId, o.settledAt])
  return paymentId
}

/** A weekly batch carrying the owner share of `paymentIds` and the held lines `heldIds`. */
async function batch(co: TenantCo, o: {
  paymentIds: string[]; heldIds: string[]; status: 'pending' | 'transferred'; at: string
}): Promise<{ intentId: string; amount: number }> {
  const shares = (await db.query<{ s: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS s FROM user_balance_ledger
      WHERE type = 'allocation_owner_share' AND reference_id = ANY($1::uuid[])`, [o.paymentIds])).rows[0].s
  const held = (await db.query<{ s: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS s FROM held_payout_items WHERE id = ANY($1::uuid[])`, [o.heldIds])).rows[0].s
  const amount = Math.round((Number(shares) + Number(held)) * 100) / 100
  const transferId = `tr_${randomUUID().slice(0, 8)}`
  const intentId = (await db.query<{ id: string }>(
    `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed,
                                            netted_amount, status, stripe_transfer_id, transferred_at, created_at)
     VALUES ($1, $2, 'acct_1', $3, $3, 0, $4, $5, CASE WHEN $4 = 'transferred' THEN $6::timestamptz END, $6::timestamptz) RETURNING id`,
    [co.landlordId, co.ownerUserId, amount, o.status, o.status === 'transferred' ? transferId : null, o.at])).rows[0].id
  await db.query(
    `UPDATE user_balance_ledger SET stripe_transfer_id = $2
      WHERE type = 'allocation_owner_share' AND reference_id = ANY($1::uuid[])`,
    [o.paymentIds, o.status === 'transferred' ? transferId : `intent:${intentId}`])
  await db.query(`UPDATE held_payout_items SET payout_intent_id = $2 WHERE id = ANY($1::uuid[])`, [o.heldIds, intentId])
  return { intentId, amount }
}

async function heldLineOf(saleId: string): Promise<string> {
  return (await db.query<{ id: string }>(`SELECT id FROM held_payout_items WHERE source_type = 'pos_sale' AND source_id = $1`, [saleId])).rows[0].id
}

async function nonPending(landlordId: string) {
  const r = await checkOwner({ landlordId }, { repair: false })
  return r.findings.filter(f => f.severity !== 'info')
}

describe('the production set', () => {
  it('one projector per source type; bank_match is the merged parts', () => {
    const all = productionLedgerProjectors()
    const types = all.map(p => p.sourceType)
    expect(new Set(types).size).toBe(types.length)
    expect(types).toContain('bank_match')
    // 10/13 (Nic): design Q11 answered — the reader order drains and posts nothing.
    expect(types).toContain('reader_order')
  })

  it('a merged source type posts every part and lists the union of their sources (earliest day wins)', async () => {
    const owner = { landlordId: randomUUID() }
    const part = (memo: string, refs: { id: string; day: string }[]): LedgerProjector => ({
      sourceType: 'bank_match', ruleVersion: memo === 'a' ? 1 : 3,
      project: async () => [{ owner, intendedDate: '2026-10-01', postingKind: memo === 'a' ? 'main' : 'charge', memo, lines: [] }],
      listSources: async () => refs,
    })
    const merged = composeLedgerProjector('bank_match', [
      part('a', [{ id: 'x', day: '2026-10-02' }, { id: 'y', day: '2026-10-05' }]),
      part('b', [{ id: 'x', day: '2026-10-01' }, { id: 'z', day: '2026-10-03' }]),
    ])
    expect(merged.ruleVersion).toBe(3)
    const client = await db.connect()
    try {
      expect((await merged.project(client, 'x')).map(p => p.memo)).toEqual(['a', 'b'])
      const refs = await merged.listSources(client, owner, {})
      expect(refs.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'x', day: '2026-10-01' }, { id: 'y', day: '2026-10-05' }, { id: 'z', day: '2026-10-03' },
      ])
    } finally {
      client.release()
    }
    expect(() => composeLedgerProjector('bank_match', [{ ...part('a', []), sourceType: 'payment' }])).toThrow()
  })
})

describe('Due from GAM (1050) ties to the payout records, end to end', () => {
  it('rent GAM holds and a register card sale sit in 1050 until a batch is transferred; a pending batch keeps them; a rebuild and every tie-out agree', async () => {
    const co = await tenantCo({ booksStart: '2026-09-01' })
    // $1,000 rent by card on 9/3, the landlord covering a $6 fee: $994 is owed to them.
    const rent = await heldRent(co, { amount: 1000, fee: 6, due: '2026-09-01', settledAt: '2026-09-03 18:00:00+00' })
    // A $100 card sale at the register: GAM holds $96.20 for the landlord after its $3.80 card fee.
    const saleId = await sale(co, { method: 'card', subtotal: 100, platformFee: 3.8, held: 96.2, at: '2026-09-04 18:00:00+00' })
    const line = await heldLineOf(saleId)
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(99400 + 9620)   // cents
    expect(await nonPending(co.landlordId)).toEqual([])

    // A batch that is reserved but not yet sent keeps the money in 1050.
    const pending = await batch(co, { paymentIds: [rent], heldIds: [line], status: 'pending', at: '2026-09-08 16:00:00+00' })
    expect(await drain()).toMatchObject({ failed: 0 })
    const c1 = await db.connect()
    try {
      expect((await dueFromGamExpectedCents(c1, co.landlordId)).total).toBe(109020)
    } finally {
      c1.release()
    }
    expect(await nonPending(co.landlordId)).toEqual([])

    // Sent: 1050 is empty, the money is on its way to the landlord's bank (1060).
    await db.query(`UPDATE platform_transfer_intents SET status = 'transferred', stripe_transfer_id = 'tr_sent', transferred_at = '2026-09-08 16:00:00+00' WHERE id = $1`, [pending.intentId])
    await db.query(`UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_sent' WHERE stripe_transfer_id = $1`, [`intent:${pending.intentId}`])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(0)
    expect(await bal(co.landlordId, 'stripe_in_transit')).toBe(109020)
    expect(await nonPending(co.landlordId)).toEqual([])

    // A payout landing at the bank empties 1060.
    const payout = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, trigger_type)
       VALUES ($1, 1090.20, 'settled', '2026-09-11 18:00:00+00', 'auto_friday') RETURNING id`, [co.landlordId])).rows[0].id
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [payout, pending.intentId])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(co.landlordId, 'stripe_in_transit')).toBe(0)

    // The trial balance balances, a rebuild from scratch posts the same, and nothing drifts.
    const tb = (await db.query<{ d: string; c: string }>(
      `SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM ledger_posting_lines WHERE landlord_id = $1`, [co.landlordId])).rows[0]
    expect(Number(tb.d)).toBe(Number(tb.c))
    const before = (await db.query<{ k: string }>(
      `SELECT source_type || ':' || source_id || ':' || posting_kind || ':' || fingerprint AS k FROM ledger_postings
        WHERE landlord_id = $1 AND role = 'post' AND superseded_at IS NULL ORDER BY 1`, [co.landlordId])).rows.map(r => r.k)
    const rb = await rebuildOwner({ landlordId: co.landlordId }, { mode: 'from_scratch' })
    expect(rb.status).toBe('done')
    expect(rb.counts.failed).toBe(0)
    const after = (await db.query<{ k: string }>(
      `SELECT source_type || ':' || source_id || ':' || posting_kind || ':' || fingerprint AS k FROM ledger_postings
        WHERE landlord_id = $1 AND role = 'post' AND superseded_at IS NULL ORDER BY 1`, [co.landlordId])).rows.map(r => r.k)
    expect(after).toEqual(before)
    expect(await nonPending(co.landlordId)).toEqual([])
  })

  it('a difference between 1050 and the payout records is drift, with the parts named', async () => {
    const co = await tenantCo({ booksStart: '2026-09-01' })
    const rent = await heldRent(co, { amount: 500, due: '2026-09-01', settledAt: '2026-09-03 18:00:00+00' })
    expect(await drain()).toMatchObject({ failed: 0 })
    // The owner share is marked paid by a transfer the books never saw (no batch record).
    await db.query(`UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_unrecorded' WHERE reference_id = $1`, [rent])
    const f = (await nonPending(co.landlordId)).filter(x => x.check === 'due_from_gam')
    expect(f).toEqual([{ check: 'due_from_gam', severity: 'drift', detail: expect.objectContaining({
      ledgerCents: 50000, expectedCents: 0, differenceCents: 50000, ownerSharesNotPaidOut: 0,
    }) }])
  })
})

// The P4 / P5 seam at move-out (design D3 + G2b): the move-out posts only its
// liability and income side, so the escrow settlement GAM sends the landlord
// leaves the books from where they hold it.
describe('a move-out\'s escrow settlement sent to the landlord (G2b)', () => {
  it('the paid-ahead money GAM held that the move-out used leaves Due from GAM; the rest leaves Deposits GAM holds — and while the transfer is pending, 1050 expects only the paid-ahead part', async () => {
    const co = await tenantCo({ booksStart: '2026-09-01' })
    // A $60 deposit paid by card (GAM holds it, 1070) and $40 paid ahead through GAM (off the books, L13).
    const dep = await bill(co, { type: 'deposit', amount: 60, due: '2026-09-01', depositCollectedBy: 'gam' })
    await receipt(co, { method: 'card', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 60 }] })
    const credit = await paidAhead(co, { amount: 40, fundedBy: 'gam', receivedAt: '2026-09-02T17:00:00Z' })
    // Move-out: $100 of cleaning — the deposit pays $60, the paid-ahead money $40. GAM sends the landlord $100.
    const ret = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, total_deductions, refund_amount,
                                    status, finalized_at)
       VALUES ($1, $2, $3, 60, 100, 100, 0, 'sent_zero', '2026-10-05T18:00:00Z') RETURNING id`,
      [co.leaseId, co.tenantId, co.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, lease_id, deposit_return_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 40, '2026-10-01', 'move_out', 'applied', '2026-10-05T18:00:00Z')`, [credit, co.leaseId, ret])
    const intent = (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed,
                                              netted_amount, status, purpose, deposit_return_id, stripe_idempotency_key, stripe_request)
       VALUES ($1, $2, 'acct_1', 100, 100, 0, 'pending', 'deposit_settlement', $3, $4, '{}'::jsonb) RETURNING id`,
      [co.landlordId, co.ownerUserId, ret, `settle-${ret}`])).rows[0].id
    expect(await drain()).toMatchObject({ failed: 0 })
    // Not sent yet: the $40 sits in 1050, the $60 in 1070 — and the 1050 check expects exactly the $40.
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(4000)
    expect(await bal(co.landlordId, 'deposits_gam_holds')).toBe(6000)
    const c1 = await db.connect()
    try {
      expect(await dueFromGamExpectedCents(c1, co.landlordId)).toMatchObject({ escrow: 4000, total: 4000 })
    } finally {
      c1.release()
    }
    expect((await nonPending(co.landlordId)).filter(f => f.check === 'due_from_gam')).toEqual([])
    // A failed transfer leaves the same: GAM still owes it.
    await db.query(`UPDATE platform_transfer_intents SET status = 'failed' WHERE id = $1`, [intent])
    expect((await nonPending(co.landlordId)).filter(f => f.check === 'due_from_gam')).toEqual([])
    // Sent: both empty.
    await db.query(`UPDATE platform_transfer_intents SET status = 'transferred', stripe_transfer_id = 'tr_settle', transferred_at = '2026-10-05T19:00:00Z' WHERE id = $1`, [intent])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(triples(await activeLines('transfer_intent', intent))).toEqual([
      ['stripe_in_transit', 10000, 0], ['due_from_gam', 0, 4000], ['deposits_gam_holds', 0, 6000],
    ])
    expect(await bal(co.landlordId, 'due_from_gam')).toBe(0)
    expect(await bal(co.landlordId, 'deposits_gam_holds')).toBe(0)
    expect(await bal(co.landlordId, 'security_deposits_payable')).toBe(0)
    expect((await nonPending(co.landlordId)).filter(f => f.check === 'due_from_gam')).toEqual([])
  })
})

// 10/12 (Nic, L17): "sold property, tenant later pays the OLD owner's unpaid
// bill: HOLD FOR REVIEW (admin decides each time)" — design G6.
describe('a tenant pays the former owner\'s bill after the property was sold', () => {
  it('held for review in both companies\' suspense; each company\'s 1050 ties to its own payouts', async () => {
    const seller = await tenantCo({ booksStart: '2026-09-01' })
    const buyer = await tenantCo({ booksStart: '2026-09-01' })
    await db.query(
      `INSERT INTO property_transfers (property_id, from_landlord_id, to_landlord_id, transferred_at, moved)
       VALUES ($1, $2, $3, '2026-09-10T18:00:00Z', '{"units": 1, "leases": 0, "security_deposits": 0}'::jsonb)`,
      [seller.propertyId, seller.landlordId, buyer.landlordId])
    await db.query(`UPDATE properties SET landlord_id = $2, owner_user_id = $3 WHERE id = $1`, [seller.propertyId, buyer.landlordId, buyer.ownerUserId])
    // The seller's September rent, paid by card after the sale; the owner share went to the buyer.
    const rent = await bill(seller, { amount: 500, due: '2026-09-01' })
    await receipt(seller, { method: 'card', settledAt: '2026-09-12T18:00:00Z', apps: [{ paymentId: rent, amount: 500 }] })
    await db.query(
      `INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, landlord_fee_withheld, supersedence,
                                      pm_fee_due, pm_paid, manager_fee_due, manager_paid, short_by, owner_share, created_at)
       VALUES ($1, $2, $3, 500, 0, 0, 0, 0, 0, 0, 0, 500, '2026-09-12T18:00:00Z')`, [rent, seller.landlordId, seller.propertyId])
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, property_id, created_at)
       VALUES ($1, 'allocation_owner_share', 500, 0, $2, 'payment', $3, '2026-09-12T18:00:00Z')`,
      [buyer.ownerUserId, rent, seller.propertyId])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(seller.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(seller.landlordId, 'due_from_gam')).toBe(0)
    expect(await bal(seller.landlordId, 'suspense')).toBe(50000)
    expect(await bal(buyer.landlordId, 'due_from_gam')).toBe(50000)
    expect(await bal(buyer.landlordId, 'suspense')).toBe(-50000)
    for (const co of [seller, buyer]) {
      const r = await checkOwner({ landlordId: co.landlordId }, { repair: false })
      expect(r.findings.filter(f => f.check === 'due_from_gam')).toEqual([])
      expect(r.findings.filter(f => f.check === 'sold_property_receipts')).toEqual([
        { check: 'sold_property_receipts', severity: 'info', detail: expect.objectContaining({
          paymentId: rent, sellerId: seller.landlordId, buyerId: buyer.landlordId }) }])
    }
    // The buyer's weekly batch carries the share: the buyer's 1050 empties.
    await db.query(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, netted_amount,
                                              status, stripe_transfer_id, transferred_at)
       VALUES ($1, $2, 'acct_b', 500, 500, 0, 'transferred', 'tr_buyer', '2026-09-15T16:00:00Z')`, [buyer.landlordId, buyer.ownerUserId])
    await db.query(`UPDATE user_balance_ledger SET stripe_transfer_id = 'tr_buyer' WHERE reference_id = $1`, [rent])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(buyer.landlordId, 'due_from_gam')).toBe(0)
    expect((await nonPending(buyer.landlordId)).filter(f => f.check === 'due_from_gam')).toEqual([])
  })

  it('a sale that moved leases or deposits waits, named: the amounts handed over are not recorded with it (design G5)', async () => {
    const seller = await tenantCo({ booksStart: '2026-09-01' })
    const buyer = await tenantCo({ booksStart: '2026-09-01' })
    const t = (await db.query<{ id: string }>(
      `INSERT INTO property_transfers (property_id, from_landlord_id, to_landlord_id, transferred_at, moved)
       VALUES ($1, $2, $3, '2026-09-10T18:00:00Z', '{"units": 1, "leases": 1, "security_deposits": 1}'::jsonb) RETURNING id`,
      [seller.propertyId, seller.landlordId, buyer.landlordId])).rows[0].id
    const empty = (await db.query<{ id: string }>(
      `INSERT INTO property_transfers (property_id, from_landlord_id, to_landlord_id, transferred_at, moved)
       VALUES ($1, $2, $3, '2026-09-11T18:00:00Z', '{"units": 0, "leases": 0, "security_deposits": 0}'::jsonb) RETURNING id`,
      [seller.propertyId2, seller.landlordId, buyer.landlordId])).rows[0].id
    await drain()
    expect(await activeLines('property_transfer', empty)).toEqual([])
    expect((await db.query(`SELECT 1 FROM ledger_source_errors WHERE source_id = $1`, [empty])).rows).toEqual([])
    expect((await db.query<{ reason_code: string }>(`SELECT reason_code FROM ledger_source_errors WHERE source_id = $1`, [t])).rows)
      .toEqual([{ reason_code: 'missing_fact' }])
  })
})

// Design §8: a source a rebuild could not post is left in the outbox, so it
// posts within the minute once what it waited on arrives (the owner's choice
// on the Books settings page), not only at the next nightly repair.
describe('a rebuild leaves what it could not post in the outbox', () => {
  it('a bill waiting on the owner\'s work-trade choice posts at the next drain once the owner chooses', async () => {
    const co = await tenantCo({ booksStart: '2026-09-01' })
    const id = await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-09-30T18:00:00Z', workTradeCredit: 460 })
    await db.query(`DELETE FROM ledger_outbox`)   // as if it was captured long before the books went live
    const rb = await rebuildOwner({ landlordId: co.landlordId }, { mode: 'from_scratch' })
    expect(rb.counts.failed).toBe(1)
    expect(rb.drift[0]).toMatchObject({ sourceType: 'payment', sourceId: id, status: 'failed' })
    expect((await db.query(`SELECT count(*)::int AS n FROM ledger_outbox WHERE source_type = 'payment' AND source_id = $1`, [id])).rows[0].n).toBe(1)
    // The owner chooses on the Books settings page (the real path: the route
    // saves it and lifts the back-off of everything waiting on it), and the
    // ordinary drain — no ignoring the back-off — posts the bill.
    const r = await request(settingsApp).patch('/api/books/setup/settings')
      .set({ Authorization: `Bearer ${ownerPass(co)}`, 'X-Client-Id': co.landlordId }).send({ workTradeMethod: 'rent_and_labor' })
    expect(r.status).toBe(200)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(triples(await activeLines('payment', id), 'work_trade')).toEqual([['work_trade_labor', 46000, 0], ['ar_tenants', 0, 46000]])
    expect((await db.query(`SELECT count(*)::int AS n FROM ledger_outbox WHERE source_id = $1`, [id])).rows[0].n).toBe(0)
  })
})
