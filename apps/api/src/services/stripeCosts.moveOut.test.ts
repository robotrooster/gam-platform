/**
 * Leftovers fix — GAM's own bill lines a move-out pays from the deposit.
 *
 * A returned-payment fee (RETURNFEE, revenue_owner 'gam') still open at
 * move-out is swept to 'paid_via_deposit' by depositReturn's finalize. Before
 * this, GAM's revenue figures counted only lines Stripe collected, so the
 * deposit-paid fee was counted nowhere: the Processing Margin card and its
 * true-up under-read, and GAM's Own Money read it as a gap.
 *
 * Each such line is counted once, in the part GAM actually has:
 *   - paid from deposit money GAM holds: at the finalize;
 *   - paid from deposit money the landlord holds (a negative
 *     'gam_lines:<move-out>' payout line): when a payout nets that line.
 * These run the real finalize and the real weekly payout, with the Stripe
 * balance kept beside them the way Stripe would move it.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent: (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_' + Math.random().toString(36).slice(2, 10) })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id })) }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
    this.balance = { retrieve: vi.fn(async () => ({ available: [{ currency: 'usd', amount: 100_000_00 }], pending: [] })) }
  }
  return { default: FakeStripe }
})

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant, seedSecurityDeposit,
} from '../test/dbHelpers'
import { createOrFetchDraft, finalizeDepositReturn } from './depositReturn'
import { loadPlatformBalanceBook, marginForMonth, splitPlatformBalance, type PlatformStripeLive } from './stripeCosts'
import { trueUpProcessingMargin } from './platformRevenue'
import { reconcilePlatformHeldPayments } from './landlordPassthrough'

const c2 = (n: number) => Math.round(n * 100)
/** The Stripe balance, moved the way Stripe moves it, in cents. */
let onBalance = 0
const liveNow = (): PlatformStripeLive => ({
  available: onBalance / 100, pending: 0, clearingOnBalance: {}, paidOutToGamBank: 0, costsNotYetRecorded: 0,
})
const check = async () => splitPlatformBalance(await loadPlatformBalanceBook(), liveNow())
const thisMonth = async () => (await db.query<{ m: string }>(`SELECT to_char(NOW(), 'YYYY-MM') AS m`)).rows[0].m
/** The processing margin the revenue book says for `month` (per-payment rows, corrections, the true-up). */
const bookMargin = async (month: string) => Number((await db.query<{ amt: string }>(
  `SELECT COALESCE(SUM(amount), 0)::text AS amt FROM platform_revenue_ledger
    WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = $1`, [month])).rows[0].amt)
const billedFeesPaid = async (month: string) =>
  (await marginForMonth(month)).feesBack.byKind.filter(k => k.kind === 'billed_fee_paid').map(k => [k.amount, k.count])

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM stripe_processing_costs`)
  await db.query(`DELETE FROM platform_revenue_ledger`)
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  onBalance = 0
})

interface S {
  ownerUserId: string; landlordId: string; tenantId: string; propertyId: string; unitId: string; leaseId: string
}

async function moveOutStack(heldBy: 'gam_escrow' | 'landlord'): Promise<S> {
  const c = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await seedSecurityDeposit(c, { unitId, leaseId, tenantId, totalAmount: 500, collectedAmount: 500, heldBy })
    // GAM may hold deposits in this state (the custody gate).
    await c.query(`UPDATE properties SET state = 'XZ' WHERE id = $1`, [propertyId])
    await c.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('XZ', 'supported', TRUE, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status = 'supported', allows_treasury_bills = TRUE`)
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_moveout' WHERE id = $1`, [landlordId])
    await c.query(`UPDATE users SET stripe_connect_account_id = 'acct_moveout' WHERE id = $1`, [ownerUserId])
    return { ownerUserId, landlordId, tenantId, propertyId, unitId, leaseId }
  } finally { c.release() }
}

/** GAM's $4 returned-payment fee, still open at move-out. */
const returnFee = (s: S) => db.query<{ id: string }>(
  `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
   VALUES ($1,$2,$3,$4,'fee',4,'pending',CURRENT_DATE - 5,'RETURNFEE','gam') RETURNING id`,
  [s.unitId, s.leaseId, s.tenantId, s.landlordId]).then(r => r.rows[0].id)

describe('GAM\'s own lines a move-out pays from the deposit are GAM\'s revenue, counted once', () => {
  it('the deposit GAM holds pays GAM\'s $4 returned-payment fee: $4 once in GAM\'s bill lines and once in the month\'s window, the true-up adds it once, and the check ties', async () => {
    const s = await moveOutStack('gam_escrow')
    // The $500 security deposit, paid through GAM: on GAM's balance, held in trust.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             revenue_owner, settled_at, platform_held, stripe_payment_intent_id, stripe_charge_id)
       VALUES ($1,$2,$3,$4,'deposit',500,'settled',CURRENT_DATE - 30,'DEPOSIT','landlord',NOW() - interval '30 days',
               TRUE,'pi_dep_moveout','ch_dep_moveout')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    onBalance += c2(500)
    const fee = await returnFee(s)
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    const draft = await createOrFetchDraft(s.leaseId)
    const final = await finalizeDepositReturn(draft.id, s.ownerUserId)
    expect(Number(final.refund_amount)).toBe(496)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('paid_via_deposit')

    const book = await loadPlatformBalanceBook()
    expect(book.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(book.collected.gamOwnedBillLines).toBe(4)
    const after = splitPlatformBalance(book, liveNow())
    expect(after.reconciliation).toMatchObject({ gap: 0 })
    expect(after.gamsOwn).toBe(4)                       // GAM held $500, owes back $496, keeps its own $4

    const month = await thisMonth()
    expect(await billedFeesPaid(month)).toEqual([[4, 1]])
    const card = await marginForMonth(month)
    expect(card.feesBack.items!.find(i => i.kind === 'billed_fee_paid')!.who).toMatch(/paid from the deposit at move-out/)
    // The true-up books the card's figure; run twice, the $4 is still on the book once.
    await trueUpProcessingMargin(month)
    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(card.margin)
    expect(card.feesBack.total).toBe(4)
  })

  it('the deposit the landlord holds pays GAM\'s $4 fee: nothing counts until the landlord\'s next payout nets it, then $4 once, and the check ties at both steps', async () => {
    const s = await moveOutStack('landlord')
    // $100 of the landlord's on GAM's balance, waiting for their next payout.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'pos_sale', 'sale_moveout', 100, 'register sale')`, [s.landlordId])
    onBalance += c2(100)
    await returnFee(s)

    const draft = await createOrFetchDraft(s.leaseId)
    const final = await finalizeDepositReturn(draft.id, s.ownerUserId)
    expect(Number(final.refund_amount)).toBe(496)
    const line = (await db.query(`SELECT amount::float AS amount, payout_intent_id FROM held_payout_items
                                   WHERE source_id = $1`, [`gam_lines:${draft.id}`])).rows[0]
    expect(line).toEqual({ amount: -4, payout_intent_id: null })

    // Not GAM's yet: the landlord still holds it.
    const month = await thisMonth()
    const before = await loadPlatformBalanceBook()
    expect(before.gamOwnedBillLinesByKind).toEqual([])
    expect(before.heldItemsOwed).toBe(100)
    expect(splitPlatformBalance(before, liveNow()).reconciliation).toMatchObject({ gap: 0 })
    expect(await billedFeesPaid(month)).toEqual([])

    // The weekly payout nets it: the landlord is sent $96, GAM keeps $4.
    const sent = await reconcilePlatformHeldPayments(s.ownerUserId)
    expect(sent.amount).toBe(96)
    onBalance -= c2(sent.amount)
    const netted = await loadPlatformBalanceBook()
    expect(netted.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(netted.heldItemsOwed).toBe(0)
    const split = splitPlatformBalance(netted, liveNow())
    expect(split.reconciliation).toMatchObject({ gap: 0 })
    expect(split.gamsOwn).toBe(4)

    expect(await billedFeesPaid(month)).toEqual([[4, 1]])
    const card = await marginForMonth(month)
    expect(card.feesBack.items!.find(i => i.kind === 'billed_fee_paid')!.who).toMatch(/off the landlord's payout/)
    await trueUpProcessingMargin(month)
    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(card.margin)
    expect(card.feesBack.total).toBe(4)
  })

  it('a GAM-held deposit record whose money the tenant paid the landlord in cash pays GAM\'s $4 fee: the negative escrow settlement counts $4 once at the move-out, the check ties at the move-out and after the payout nets it, and the true-up adds it once', async () => {
    const s = await moveOutStack('gam_escrow')
    // The $500 security deposit was handed to the landlord in cash: the landlord holds it.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             revenue_owner, settled_at, platform_held, manual_method)
       VALUES ($1,$2,$3,$4,'deposit',500,'settled',CURRENT_DATE - 30,'DEPOSIT','landlord',NOW() - interval '30 days',
               FALSE,'cash')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    // $100 of the landlord's on GAM's balance, waiting for their next payout.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'pos_sale', 'sale_escrow_cash', 100, 'register sale')`, [s.landlordId])
    onBalance += c2(100)
    const fee = await returnFee(s)
    expect((await check()).reconciliation).toMatchObject({ gap: 0 })

    const draft = await createOrFetchDraft(s.leaseId)
    const final = await finalizeDepositReturn(draft.id, s.ownerUserId)
    expect(Number(final.refund_amount)).toBe(496)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [fee])).rows[0].status).toBe('paid_via_deposit')
    // GAM's $4 came out of money the landlord holds: one negative escrow
    // settlement on the move-out itself (never a 'gam_lines:' line).
    const items = (await db.query(`SELECT source_id, amount::float AS amount, payout_intent_id FROM held_payout_items
                                    WHERE source_type = 'deposit_settlement'`)).rows
    expect(items).toEqual([{ source_id: draft.id, amount: -4, payout_intent_id: null }])

    // Counted at the move-out: the negative item already lowers what GAM owes the landlord.
    const month = await thisMonth()
    const before = await loadPlatformBalanceBook()
    expect(before.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(before.heldItemsOwed).toBe(96)
    const beforeSplit = splitPlatformBalance(before, liveNow())
    expect(beforeSplit.reconciliation).toMatchObject({ gap: 0 })
    expect(beforeSplit.gamsOwn).toBe(4)
    expect(await billedFeesPaid(month)).toEqual([[4, 1]])

    // The weekly payout nets it: the landlord is sent $96, GAM keeps $4 — still once.
    const sent = await reconcilePlatformHeldPayments(s.ownerUserId)
    expect(sent.amount).toBe(96)
    onBalance -= c2(sent.amount)
    const netted = await loadPlatformBalanceBook()
    expect(netted.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    expect(netted.heldItemsOwed).toBe(0)
    const split = splitPlatformBalance(netted, liveNow())
    expect(split.reconciliation).toMatchObject({ gap: 0 })
    expect(split.gamsOwn).toBe(4)
    expect(await billedFeesPaid(month)).toEqual([[4, 1]])

    const card = await marginForMonth(month)
    await trueUpProcessingMargin(month)
    await trueUpProcessingMargin(month)
    expect(await bookMargin(month)).toBe(card.margin)
    expect(card.feesBack.total).toBe(4)
  })

  it('GAM\'s $4 fee paid $3 from a pet deposit GAM holds and $1 from money the landlord holds: $3 counts at the move-out, the $1 once the payout nets it, $4 in all', async () => {
    const s = await moveOutStack('landlord')
    // A $3 pet deposit paid through GAM (GAM holds it) beside the landlord's $500 security deposit.
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind, description)
       VALUES ($1, 'pet_deposit', 3, 'move_in', TRUE, 'deposit', 'Pet deposit') RETURNING id`, [s.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             lease_fee_id, revenue_owner, settled_at, platform_held, stripe_payment_intent_id, stripe_charge_id)
       VALUES ($1,$2,$3,$4,'deposit',3,'settled',CURRENT_DATE - 30,'DEPOSIT',$5,'landlord',NOW() - interval '30 days',
               TRUE,'pi_pet_moveout','ch_pet_moveout')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId, fee])
    onBalance += c2(3)
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'pos_sale', 'sale_split', 100, 'register sale')`, [s.landlordId])
    onBalance += c2(100)
    await returnFee(s)
    // A $500 cleaning charge uses up the security deposit; the $4 fee is paid
    // $3 from the pet deposit GAM holds and $1 from money the landlord holds.
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
       VALUES ($1, 'cleaning_fee', 500, 'move_out', FALSE, 'fee')`, [s.leaseId])
    const draft = await createOrFetchDraft(s.leaseId)
    await finalizeDepositReturn(draft.id, s.ownerUserId)
    const items = (await db.query(`SELECT source_id, amount::float AS amount FROM held_payout_items
                                    WHERE source_type = 'deposit_settlement' ORDER BY source_id`)).rows
    expect(items).toEqual([{ source_id: `gam_lines:${draft.id}`, amount: -1 }])

    // $3 is GAM's at the move-out (the pet deposit it held); the $1 the landlord holds is not yet.
    const before = await loadPlatformBalanceBook()
    expect(before.collected.gamOwnedBillLines).toBe(3)
    expect(before.heldItemsOwed).toBe(100)
    expect(splitPlatformBalance(before, liveNow()).reconciliation).toMatchObject({ gap: 0 })
    expect(await billedFeesPaid(await thisMonth())).toEqual([[3, 1]])

    const sent = await reconcilePlatformHeldPayments(s.ownerUserId)
    expect(sent.amount).toBe(99)
    onBalance -= c2(sent.amount)
    const netted = await loadPlatformBalanceBook()
    expect(netted.collected.gamOwnedBillLines).toBe(4)
    expect(splitPlatformBalance(netted, liveNow()).reconciliation).toMatchObject({ gap: 0 })
    expect(await billedFeesPaid(await thisMonth())).toEqual([[4, 2]])
  })
})
