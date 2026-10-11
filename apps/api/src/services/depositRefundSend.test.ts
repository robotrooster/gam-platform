/**
 * 10/4 (decisions #47a, Nic, FINAL): "land it on a to do list if original
 * payment cant complete. especially if theres a split such as landlord keeping
 * half. we need to verify both parts of that flow."
 *
 * When a move-out is finalized, the part of the deposit refund GAM holds goes
 * back by itself the way the deposit was paid (services/depositRefundSend,
 * through the early check-out's refund parts); a part the original payment
 * cannot take lands on the owner's to-do list; the landlord's own part gets
 * "Mark handed back" with a date. Both halves of a split are checked end to
 * end, plus two original payments, a refund that comes back after it was sent,
 * a dispute of the original payment after the refund (#51), and GAM's own book.
 *
 * Stripe is mocked: nothing reaches it.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeMocks = vi.hoisted(() => ({
  n: { refunds: 0 },
  refundsCreate: vi.fn(async (params: any, _opts?: any): Promise<any> =>
    ({ id: `re_${params.payment_intent}_${params.amount}`, status: 'succeeded', metadata: params.metadata })),
  refundsList: vi.fn(async (_params: any): Promise<any> => ({ data: [] })),
  paymentIntentsRetrieve: vi.fn(async (id: string): Promise<any> => ({ id, status: 'succeeded' })),
  transfersCreate: vi.fn(async (..._args: any[]) => ({ id: 'tr_test' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getStripe: () => ({
      refunds: { create: stripeMocks.refundsCreate, list: stripeMocks.refundsList },
      paymentIntents: { retrieve: stripeMocks.paymentIntentsRetrieve },
      transfers: { create: stripeMocks.transfersCreate },
    }),
  }
})
// The webhook builds its own client from the 'stripe' package: a small fake
// (the signature check reads the body as the event).
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent: (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) }
    this.balanceTransactions = { retrieve: async () => ({ fee: 0 }) }
    this.charges = { retrieve: async (id: string) => ({ id }) }
    this.paymentIntents = { retrieve: stripeMocks.paymentIntentsRetrieve }
    this.refunds = { create: stripeMocks.refundsCreate, list: stripeMocks.refundsList }
    this.transfers = { create: stripeMocks.transfersCreate }
  }
  return { default: FakeStripe }
})

import { db, getClient } from '../db'
import { finalizeDepositReturn } from './depositReturn'
import {
  depositRefundTodos, depositRefundView, giveDepositPartBackInCash, markLandlordPartHandedBack,
  undoLandlordPartHandedBack, retryDepositRefundPart, refundReachWords, DEPOSIT_PART_NO_PAYMENT, DEPOSIT_PART_TAKEN_BACK,
} from './depositRefundSend'
import { DEPOSIT_PART_TOO_OLD } from './earlyCheckOut'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
  seedSecurityDeposit, seedDepositReturnDraft,
} from '../test/dbHelpers'
import { todayIn, addDaysTo } from '../lib/timezone'

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  // Each refund Stripe makes has its own id (the first one is re_<intent>_<cents>).
  stripeMocks.n.refunds = 0
  stripeMocks.refundsCreate.mockImplementation(async (params: any) =>
    ({ id: `re_${params.payment_intent}_${params.amount}${stripeMocks.n.refunds++ ? `_${stripeMocks.n.refunds}` : ''}`,
       status: 'succeeded', metadata: params.metadata }))
  stripeMocks.refundsList.mockImplementation(async () => ({ data: [] }))
})

interface Stack { ownerUserId: string; landlordId: string; tenantId: string; tenantUserId: string; unitId: string; leaseId: string; depositId: string }

async function stack(o: { deposit: number; heldBy: 'gam_escrow' | 'landlord' }): Promise<Stack> {
  const c = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name='Jane', last_name='Doe' WHERE id=$1`, [tenantUserId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    await c.query(`UPDATE units SET unit_number='RV 22' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const depositId = await seedSecurityDeposit(c, { unitId, leaseId, tenantId, totalAmount: o.deposit, heldBy: o.heldBy })
    // The landlord can be paid (the kept part of a deposit GAM holds goes to them by transfer).
    await c.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [landlordId])
    return { ownerUserId, landlordId, tenantId, tenantUserId, unitId, leaseId, depositId }
  } finally { c.release() }
}

/** A settled security-deposit payment: by card or bank through GAM (on GAM's balance), or at the desk. */
async function depositPaid(s: Stack, o: { amount: number; via: 'card' | 'bank' | 'desk'; daysAgo?: number }): Promise<{ id: string; intent: string | null }> {
  const tag = randomUUID().slice(0, 8)
  const online = o.via !== 'desk'
  const intent = online ? `pi_dep_${tag}` : null
  const id = (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           revenue_owner, settled_at, platform_held, manual_method, stripe_payment_intent_id, stripe_charge_id)
     VALUES ($1,$2,$3,$4,'deposit',$5,'settled',CURRENT_DATE - $8::int,'DEPOSIT','landlord',NOW() - make_interval(days => $8::int),
             $6,$7,$9,$10) RETURNING id`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, o.amount.toFixed(2), online, online ? null : 'cash',
     o.daysAgo ?? 30, intent, online ? `ch_${tag}` : null])).rows[0].id
  if (online) {
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,$4,$4,$5,$6,'settled')`,
      [s.tenantId, s.leaseId, s.landlordId, o.amount.toFixed(2), o.via === 'bank' ? 'ach' : 'card', intent])
  }
  return { id, intent }
}

async function finalizeWithDamage(s: Stack, deposit: number, damage: number) {
  const c = await getClient()
  let draftId: string
  try {
    draftId = await seedDepositReturnDraft(c, {
      leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, securityDepositId: s.depositId,
      totalDeposit: deposit, damageLines: damage > 0 ? [{ description: 'Broken window', amount: damage }] : [],
    })
  } finally { c.release() }
  return finalizeDepositReturn(draftId, s.ownerUserId)
}

const parts = async (draftId: string) => (await db.query(
  `SELECT seq, kind, status, toward_amount::float AS amount, card_fee_back::float AS fee, payout_drop::float AS drop,
          deposit_payment_id, stripe_payment_intent_id AS intent, failure, reversed_at IS NOT NULL AS reversed
     FROM stay_refund_parts WHERE deposit_return_id=$1 ORDER BY created_at, seq`, [draftId])).rows
const heldItems = async () => (await db.query(
  `SELECT source_type, source_id, amount::float AS amount FROM held_payout_items ORDER BY source_id`)).rows
const refundRow = async (id: string) => (await db.query(
  `SELECT status, amount::float AS amount, settled_at IS NOT NULL AS settled FROM payments WHERE id=$1`, [id])).rows[0]
const adminNotes = async (category: string) => (await db.query(
  `SELECT title, body, context FROM admin_notifications WHERE category=$1 ORDER BY created_at`, [category])).rows
const ownerNotes = async (userId: string, type: string) => (await db.query(
  `SELECT title, body, action_url FROM notifications WHERE user_id=$1 AND type=$2 ORDER BY created_at`, [userId, type])).rows
const book = async () => {
  const { loadPlatformBalanceBook } = await import('./stripeCosts')
  const b = await loadPlatformBalanceBook()
  return { depositsInTrust: b.depositsInTrust, heldItemsOwed: b.heldItemsOwed }
}

async function postEvent(type: string, object: Record<string, unknown>) {
  const express = (await import('express')).default
  const request = (await import('supertest')).default
  const { webhooksRouter } = await import('../routes/webhooks')
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  const body = JSON.stringify({ id: `evt_${type}_${randomUUID().slice(0, 8)}`, type, data: { object } })
  return request(app).post('/webhooks/stripe').set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(body)
}

describe('refundReachWords: how each part reaches the tenant, never who holds it (#47c)', () => {
  it('names each way the money comes back, and nothing about who holds it', () => {
    expect(refundReachWords({ card: 250, bank: 0, office: 50 })).toBe('$250.00 back to your card; $50.00 returned to you at the office.')
    expect(refundReachWords({ card: 0, bank: 100, office: 0 })).toBe('$100.00 back to your bank.')
    expect(refundReachWords({ card: 0, bank: 0, office: 0 })).toBe('')
  })

  it('said to the owner or a team member in the staff voice — never "your card" or "returned to you" — and says how the money reaches them, never that it was already handed back', () => {
    expect(refundReachWords({ card: 250, bank: 100, office: 50 }, { voice: 'staff' }))
      .toBe('$250.00 back to the card they paid with; $100.00 back to the bank they paid from; $50.00 back to them in cash at the office.')
    expect(refundReachWords({ card: 0, bank: 0, office: 250 }, { voice: 'staff' })).not.toMatch(/handed back|given back/)
    expect(refundReachWords({ card: 250, bank: 100, office: 50 }, { voice: 'staff' })).not.toMatch(/your|to you/)
  })
})

describe('#47a split: a $500 deposit paid by card through GAM, the landlord keeps $250 for damage', () => {
  it('the $250 kept is released to the landlord exactly once, and the other $250 goes back to the card it was paid with', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(final.status).toBe('sent_refund')
    expect(Number(final.refund_amount)).toBe(250)
    expect(Number(final.refund_from_gam)).toBe(250)
    expect(Number(final.refund_from_landlord)).toBe(0)

    // The kept half: paid to the landlord once (GAM's escrow settlement, one
    // transfer under its own key) — never a payout line on top.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.transfersCreate.mock.calls[0][0]).toMatchObject({ amount: 25000, destination: 'acct_landlord_test' })
    expect(stripeMocks.transfersCreate.mock.calls[0][1]).toEqual({ idempotencyKey: `deposit_disb_${final.id}` })
    expect(await heldItems()).toEqual([])

    // The refund half: one part, back to that card, only what GAM holds — no card fee on top, nothing off the landlord's payout.
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    const [params] = stripeMocks.refundsCreate.mock.calls[0]
    expect(params).toMatchObject({ payment_intent: pay.intent, amount: 25000 })
    expect(params.metadata).toMatchObject({ gam_purpose: 'stay_early_checkout_refund', gam_deposit_return_id: final.id })
    expect(await parts(final.id)).toMatchObject([
      { seq: 1, kind: 'card', status: 'refunded', amount: 250, fee: 0, drop: 0, deposit_payment_id: pay.id, intent: pay.intent },
    ])
    // Once every part GAM sends has gone back, the refund row is settled.
    expect(await refundRow(final.refund_payment_id!)).toEqual({ status: 'settled', amount: -250, settled: true })
    // Nothing on the to-do list; the page says it went back.
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    const view = await depositRefundView(final.id)
    expect(view.parts.map((p) => p.done)).toEqual([true])
    expect(view.parts[0].words).toMatch(/^\$250\.00 sent back to the card they paid with/)
    expect(view.landlord_part).toBeNull()
    // The tenant's statement says how it reaches them — never who held it.
    const told = (await db.query(`SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement'`, [s.tenantUserId])).rows
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/\$250\.00 back to your card\./)
    expect(told[0].body).not.toMatch(/GAM|landlord|hold/i)

    // Opening the page again sends nothing more and releases nothing more.
    await depositRefundView(final.id)
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id)
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    await expect(finalizeDepositReturn(final.id, s.ownerUserId)).rejects.toThrow(/Already finalized/)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect(await heldItems()).toEqual([])
  })

  it('a security deposit the landlord holds ($300 at the desk) and a $200 pet deposit paid by card through GAM, $350 of damage: the landlord keeps their $300, GAM releases the $50 of its money the damage took as one payout line, once, and sends the other $150 back to the card', async () => {
    const s = await stack({ deposit: 300, heldBy: 'landlord' })
    // GAM may hold deposits in this state (the custody gate).
    await db.query(`UPDATE properties p SET state='QB' FROM units u WHERE u.property_id = p.id AND u.id=$1`, [s.unitId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('QB', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported', allows_treasury_bills=true`)
    try {
      await depositPaid(s, { amount: 300, via: 'desk' })
      const feeId = (await db.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
         VALUES ($1,'pet_deposit',200,'move_in',TRUE,'deposit') RETURNING id`, [s.leaseId])).rows[0].id
      const pet = await depositPaid(s, { amount: 200, via: 'card' })
      await db.query(`UPDATE payments SET lease_fee_id=$2 WHERE id=$1`, [pet.id, feeId])
      const final = await finalizeWithDamage(s, 500, 350)
      expect(Number(final.refund_amount)).toBe(150)
      expect(Number(final.refund_from_gam)).toBe(150)
      expect(Number(final.refund_from_landlord)).toBe(0)
      // The kept part of GAM's money: one payout line, released once.
      expect(await heldItems()).toEqual([{ source_type: 'deposit_settlement', source_id: `kept:${final.id}`, amount: 50 }])
      expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
      // The refund part: back to the card.
      expect(stripeMocks.refundsCreate.mock.calls.map((c) => [c[0].payment_intent, c[0].amount])).toEqual([[pet.intent, 15000]])
      expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'refunded', amount: 150, deposit_payment_id: pet.id }])
      // Opening the move-out again releases and sends nothing more.
      const { resumeDepositRefund } = await import('./depositRefundSend')
      await resumeDepositRefund(final.id)
      await depositRefundView(final.id)
      expect(await heldItems()).toEqual([{ source_type: 'deposit_settlement', source_id: `kept:${final.id}`, amount: 50 }])
      expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    } finally {
      await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QB'`)
    }
  })

  it('when the card can no longer take the refund (too old for the processor), the $250 lands on the owner’s to-do list in plain words; given back in cash at the office, GAM pays the landlord the $250 it held — the kept $250 still released once', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => {
      const e: any = new Error('This charge is too old to be refunded.')
      e.type = 'StripeInvalidRequestError'; e.code = 'charge_expired_for_refund'
      throw e
    })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card', daysAgo: 400 })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'failed', amount: 250, failure: DEPOSIT_PART_TOO_OLD }])
    // Still owed to the tenant: the refund row stays pending.
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')

    // The owner's to-do, the owner's notice (opens the move-out), and GAM's notice — once each.
    const todos = await depositRefundTodos([s.landlordId])
    expect(todos).toEqual([expect.objectContaining({
      type: 'deposit_refund_not_sent', href: `/leases/${s.leaseId}/deposit-return`,
      title: 'Give back Jane Doe\'s deposit refund (RV 22)',
    })])
    // Fix pass 2: Try again cannot help here, so the to-do names only the cash way out — and the press comes first.
    expect(todos[0].subtitle).toBe('Test Property · $250.00 cannot go back the way it was paid — open the move-out and press "Give it back in cash instead"')
    const owner = await ownerNotes(s.ownerUserId, 'deposit_refund_failed')
    expect(owner).toHaveLength(1)
    expect(owner[0].action_url).toBe(`/leases/${s.leaseId}/deposit-return`)
    expect(owner[0].body).toMatch(/too old for a refund\. Open the move-out and press "Give it back in cash instead" — it tells you when to hand over the cash, and \$250\.00 is added to your next payout\./)
    // #47c: never who held the money.
    expect(owner[0].body).not.toMatch(/GAM held|held for it|GAM adds/)
    expect(await adminNotes('deposit_refund_part_failed')).toHaveLength(1)
    // Try again cannot help: refused in plain words, nothing sent.
    const view = await depositRefundView(final.id)
    expect(view.parts[0]).toMatchObject({ can_try_again: false, can_give_in_cash: true, done: false })
    await expect(retryDepositRefundPart(s.leaseId, view.parts[0].id)).rejects.toThrow(/Trying again cannot send this one back/)

    // The office gives it back in cash: recorded, and the $250 GAM held is the landlord's (next payout) — once.
    const out = await giveDepositPartBackInCash(s.leaseId, view.parts[0].id, s.ownerUserId)
    expect(out.handBack).toBe(true)
    expect(out.words[0]).toBe('Hand back $250.00 in cash now.')
    const items = await heldItems()
    expect(items).toEqual([expect.objectContaining({ source_type: 'deposit_settlement', amount: 250 })])
    expect(items[0].source_id).toMatch(/^cash-part:/)
    // The kept $250 went to the landlord once, by its own transfer.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.transfersCreate.mock.calls[0][0]).toMatchObject({ amount: 25000 })
    // Pressing again hands nothing back and pays nothing twice.
    const again = await giveDepositPartBackInCash(s.leaseId, view.parts[0].id, s.ownerUserId)
    expect(again.handBack).toBe(false)
    expect(await heldItems()).toHaveLength(1)
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    expect(await refundRow(final.refund_payment_id!)).toMatchObject({ status: 'settled', settled: true })
    const after = await depositRefundView(final.id)
    expect(after.parts.map((p) => p.status)).toEqual(['handed_back'])
    expect(after.parts[0].words).toMatch(/^\$250\.00 given back in cash at the office on /)
  })

  it('money with no card or bank payment behind it (a deposit record with no Stripe payment) is on the to-do list from the start — never sent nowhere, never kept by GAM', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(stripeMocks.refundsCreate).not.toHaveBeenCalled()
    expect(await parts(final.id)).toMatchObject([{ kind: 'cash', status: 'failed', amount: 250, failure: DEPOSIT_PART_NO_PAYMENT }])
    expect(await depositRefundTodos([s.landlordId])).toHaveLength(1)
    expect(await ownerNotes(s.ownerUserId, 'deposit_refund_failed')).toHaveLength(1)
    const note = (await db.query(`SELECT notes FROM payments WHERE id=$1`, [final.refund_payment_id])).rows[0].notes
    expect(note).toMatch(/\$250\.00 returned to you at the office\./)
    const [p] = (await depositRefundView(final.id)).parts
    const out = await giveDepositPartBackInCash(s.leaseId, p.id, s.ownerUserId)
    expect(out).toMatchObject({ handBack: true })
    expect((await heldItems()).filter((i) => i.source_id.startsWith('cash-part:'))).toEqual([
      { source_type: 'deposit_settlement', source_id: `cash-part:${p.id}`, amount: 250 }])
  })
})

describe('#47a split, the landlord’s half: a deposit paid at the desk is the landlord’s to hand back', () => {
  it('GAM holds $300 paid by card, the landlord holds $200 paid at the desk, $100 of damage: the card gets $300 back and the landlord marks their $100 handed back with its date', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const card = await depositPaid(s, { amount: 300, via: 'card' })
    await depositPaid(s, { amount: 200, via: 'desk' })
    const final = await finalizeWithDamage(s, 500, 100)
    // The deductions come out of what the landlord already holds first: nothing of GAM's is kept.
    expect(Number(final.refund_from_gam)).toBe(300)
    expect(Number(final.refund_from_landlord)).toBe(100)
    expect(await heldItems()).toEqual([])
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    expect(stripeMocks.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: card.intent, amount: 30000 })
    // GAM's part is done; the landlord's waits on their to-do list.
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    const todos = await depositRefundTodos([s.landlordId])
    expect(todos).toEqual([expect.objectContaining({ type: 'deposit_refund_hand_back', title: 'Hand back $100.00 of Jane Doe\'s deposit (RV 22)' })])
    const told = (await db.query(`SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement'`, [s.tenantUserId])).rows
    expect(told[0].body).toMatch(/\$300\.00 back to your card; \$100\.00 returned to you at the office\./)

    const view = await depositRefundView(final.id)
    expect(view.landlord_part).toEqual({ amount: 100, handed_back_on: null, handed_back_by_name: null })
    const tz = (await db.query(`SELECT p.timezone FROM properties p JOIN units u ON u.property_id = p.id WHERE u.id=$1`, [s.unitId])).rows[0].timezone
    const today = todayIn(tz)
    // Never a day that has not come, never an amount the page did not show.
    await expect(markLandlordPartHandedBack(s.leaseId, { handedBackOn: addDaysTo(today, 1), expectedAmount: 100, actorUserId: s.ownerUserId }))
      .rejects.toThrow(/has not come yet/)
    await expect(markLandlordPartHandedBack(s.leaseId, { handedBackOn: today, expectedAmount: 90, actorUserId: s.ownerUserId }))
      .rejects.toThrow(/amount to hand back changed/)
    const marked = await markLandlordPartHandedBack(s.leaseId, { handedBackOn: today, expectedAmount: 100, actorUserId: s.ownerUserId })
    expect(marked.words[0]).toMatch(/^Marked handed back: \$100\.00 on /)
    expect((await depositRefundView(final.id)).landlord_part).toEqual({ amount: 100, handed_back_on: today, handed_back_by_name: 'Test Landlord' })
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    await expect(markLandlordPartHandedBack(s.leaseId, { handedBackOn: today, expectedAmount: 100, actorUserId: s.ownerUserId }))
      .rejects.toThrow(/already marked handed back/)
    // A mistake is undone with one press (no money moves either way).
    await undoLandlordPartHandedBack(s.leaseId)
    expect((await depositRefundView(final.id)).landlord_part?.handed_back_on).toBeNull()
    expect(await depositRefundTodos([s.landlordId])).toHaveLength(1)
  })
})

describe('#47a two original payments: the refund goes back most recent first', () => {
  it('a $300 security deposit (card, 60 days ago) and a $200 later deposit payment (bank, 10 days ago), $100 kept: $200 back to the bank first, then $200 to the card', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const older = await depositPaid(s, { amount: 300, via: 'card', daysAgo: 60 })
    const newer = await depositPaid(s, { amount: 200, via: 'bank', daysAgo: 10 })
    const final = await finalizeWithDamage(s, 500, 100)
    expect(Number(final.refund_from_gam)).toBe(400)
    expect(await parts(final.id)).toMatchObject([
      { seq: 1, kind: 'bank', amount: 200, deposit_payment_id: newer.id, status: 'refunded' },
      { seq: 2, kind: 'card', amount: 200, deposit_payment_id: older.id, status: 'refunded' },
    ])
    expect(stripeMocks.refundsCreate.mock.calls.map((c) => [c[0].payment_intent, c[0].amount]))
      .toEqual([[newer.intent, 20000], [older.intent, 20000]])
    const told = (await db.query(`SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement'`, [s.tenantUserId])).rows
    expect(told[0].body).toMatch(/\$200\.00 back to your card; \$200\.00 back to your bank\./)
  })
})

describe('#47a a refund that fails after it was sent (refund.updated)', () => {
  it('lands on the to-do list once: the part is reversed on its day, a replacement waits for Try again or cash, the refund row is pending again, and a redelivery changes nothing', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [sent] = await parts(final.id)
    expect(sent.status).toBe('refunded')
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    const refundId = `re_${pay.intent}_25000`
    const failed = { id: refundId, object: 'refund', status: 'failed', payment_intent: pay.intent,
      metadata: { gam_purpose: 'stay_early_checkout_refund', gam_deposit_return_id: final.id } }
    expect((await postEvent('refund.updated', failed)).status).toBe(200)
    const after = await parts(final.id)
    expect(after).toMatchObject([
      { status: 'refunded', reversed: true },
      { kind: 'card', status: 'failed', amount: 250, reversed: false },
    ])
    expect(after[1].failure).toMatch(/^The card company sent this refund back/)
    // Fix pass 3: a deposit part says the press comes first — never "hand it back in cash and press".
    expect(after[1].failure).toBe('The card company sent this refund back — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.')
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')
    expect(await depositRefundTodos([s.landlordId])).toHaveLength(1)
    expect(await ownerNotes(s.ownerUserId, 'deposit_refund_failed')).toHaveLength(1)
    expect((await ownerNotes(s.ownerUserId, 'deposit_refund_failed'))[0].title).toBe('A deposit refund to Jane Doe came back')
    expect(await adminNotes('deposit_refund_part_failed')).toHaveLength(1)
    // Stripe sends it again: told once, one replacement.
    expect((await postEvent('refund.updated', failed)).status).toBe(200)
    expect(await parts(final.id)).toHaveLength(2)
    expect(await ownerNotes(s.ownerUserId, 'deposit_refund_failed')).toHaveLength(1)
    expect(await adminNotes('deposit_refund_part_failed')).toHaveLength(1)
    // Try again sends it once more and the refund row settles.
    const view = await depositRefundView(final.id)
    const replacement = view.parts.find((p) => !p.done)!
    expect(replacement).toMatchObject({ can_try_again: true, can_give_in_cash: true })
    const r = await retryDepositRefundPart(s.leaseId, replacement.id)
    expect(r.words[0]).toBe('$250.00 was sent back to their card.')
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    // The kept half was never touched by any of it: one transfer, nothing netted.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
    expect(await heldItems()).toEqual([])
  })
})

describe('#51 a chargeback on the original deposit payment after the move-out refund', () => {
  const dispute = (intent: string, amountCents: number) => ({
    id: `dp_${intent}`, charge: `ch_${intent}`, payment_intent: intent, amount: amountCents, currency: 'usd',
    reason: 'fraudulent', status: 'needs_response', balance_transactions: [{ fee: 1500 }],
  })

  it('after the refund went out: the refund stays sent, the tenant owes the refunded part again on the reopened deposit charge, and GAM is alerted', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect((await parts(final.id))[0].status).toBe('refunded')
    expect((await postEvent('charge.dispute.created', dispute(pay.intent!, 50000))).status).toBe(200)
    // The deposit charge is reopened on the tenant's balance (normal returned-payment recovery).
    const reopened = (await db.query(
      `SELECT q.status, q.amount::float AS amount, q.type FROM payments q JOIN payment_reversals pr ON pr.id = q.reversal_id
        WHERE pr.payment_id=$1`, [pay.id])).rows
    expect(reopened).toEqual([{ status: 'pending', amount: 500, type: 'deposit' }])
    expect(reopened[0].amount).toBeGreaterThanOrEqual(250)   // the refunded part is owed again
    // The refund itself is not undone.
    expect(await parts(final.id)).toMatchObject([{ status: 'refunded', reversed: false }])
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toMatch(/already sent \$250\.00 of this deposit payment back to the tenant at move-out/)
    expect(alert[0].body).toMatch(/The tenant now owes \$500\.00 again on the reopened deposit charge/)
    // The alert is about the deposit payment — never "the move-out balance charge".
    expect(alert[0].body).not.toMatch(/move-out balance charge/)
    // Opening the move-out again alerts nobody twice.
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id)
    expect(await adminNotes('deposit_refund_then_returned')).toHaveLength(1)
  })

  it('before the refund went out: the waiting part is stopped (the dispute gave that money back), the reopened charge is lowered by it, and it leaves the to-do list', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => {
      const e: any = new Error('This charge is too old to be refunded.'); e.code = 'charge_expired_for_refund'; throw e
    })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(await depositRefundTodos([s.landlordId])).toHaveLength(1)
    expect((await postEvent('charge.dispute.created', dispute(pay.intent!, 50000))).status).toBe(200)
    expect(await parts(final.id)).toMatchObject([{ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK }])
    const reopened = (await db.query(
      `SELECT q.status, q.amount::float AS amount FROM payments q JOIN payment_reversals pr ON pr.id = q.reversal_id
        WHERE pr.payment_id=$1`, [pay.id])).rows
    // The tenant owes only the $250 the landlord kept — never the $250 they were never refunded.
    expect(reopened).toEqual([{ status: 'pending', amount: 250 }])
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    const view = await depositRefundView(final.id)
    expect(view.parts[0]).toMatchObject({ done: true, can_try_again: false, can_give_in_cash: false })
    await expect(giveDepositPartBackInCash(s.leaseId, view.parts[0].id, s.ownerUserId)).rejects.toThrow(/Hand nothing back/)
    expect(await adminNotes('deposit_refund_then_returned')).toHaveLength(1)
  })
})

describe('GAM’s book: the deposit money GAM holds stays counted until the refund is actually sent', () => {
  it('counted as deposits GAM owes while the refund waits, gone once it is sent; the kept half leaves by its transfer', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => {
      const e: any = new Error('Stripe is down'); throw e
    })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    expect(await book()).toEqual({ depositsInTrust: 500, heldItemsOwed: 0 })
    const final = await finalizeWithDamage(s, 500, 250)
    // Not sent (Stripe was down): still the tenant's money GAM holds.
    expect((await parts(final.id))[0]).toMatchObject({ status: 'failed' })
    expect(await book()).toEqual({ depositsInTrust: 250, heldItemsOwed: 0 })
    // Sent on Try again: no longer counted.
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.amount}`, status: 'succeeded' }))
    const [p] = (await depositRefundView(final.id)).parts
    await retryDepositRefundPart(s.leaseId, p.id)
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
  })

  it('a refund given back in cash at the office instead: no longer counted as the tenant’s deposit — it is the landlord’s payout line', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const final = await finalizeWithDamage(s, 500, 250)   // no card payment behind the record
    expect(await book()).toEqual({ depositsInTrust: 250, heldItemsOwed: 0 })
    const [p] = (await depositRefundView(final.id)).parts
    await giveDepositPartBackInCash(s.leaseId, p.id, s.ownerUserId)
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 250 })
  })
})

// ── Fix pass 2 ────────────────────────────────────────────────────────────────

const disputeOf = (intent: string, amountCents: number) => ({
  id: `dp_${intent}_${amountCents}`, charge: `ch_${intent}`, payment_intent: intent, amount: amountCents, currency: 'usd',
  reason: 'fraudulent', status: 'needs_response', balance_transactions: [{ fee: 1500 }],
})
const reopenedOf = async (paymentId: string) => (await db.query(
  `SELECT q.status, q.amount::float AS amount FROM payments q JOIN payment_reversals pr ON pr.id = q.reversal_id
    WHERE pr.payment_id=$1 ORDER BY q.created_at`, [paymentId])).rows
const openPartsTotal = async (draftId: string) => {
  const { openPartSql } = await import('./depositRefundSend')
  return Number((await db.query(
    `SELECT COALESCE(SUM(p.toward_amount), 0)::float AS n FROM stay_refund_parts p
      WHERE p.deposit_return_id=$1 AND ${openPartSql('p')}`, [draftId])).rows[0].n)
}

describe('#51 a PARTIAL dispute before the refund went out: only the share the dispute took is stopped', () => {
  it('$500 by card, $250 kept, the $250 refund failed (Stripe down), then a $100 dispute: $100 is stopped, $150 is still owed to the tenant (to-do, Try again), the reopened $100 is voided, and nothing stays GAM’s', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'failed', amount: 250 }])

    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 10000))).status).toBe(200)
    const after = await parts(final.id)
    // Split: the rest stays the live part; the $100 the dispute gave back is its own, stopped.
    expect(after).toHaveLength(2)
    expect(after.find((p) => p.failure === DEPOSIT_PART_TAKEN_BACK)).toMatchObject({ kind: 'card', amount: 100, deposit_payment_id: pay.id })
    expect(after.find((p) => p.failure !== DEPOSIT_PART_TAKEN_BACK)).toMatchObject({ kind: 'card', status: 'failed', amount: 150 })
    // The tenant never owes the $100 the dispute already gave back: the reopened row is voided.
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'voided', amount: 100 }])
    // $150 is still the tenant's: the refund row stays pending, it is on the to-do list,
    // and it is the open amount GAM's book must count (the stripeCosts input — see notDone).
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')
    expect(await openPartsTotal(final.id)).toBe(150)
    const todos = await depositRefundTodos([s.landlordId])
    expect(todos).toHaveLength(1)
    expect(todos[0].subtitle).toMatch(/^Test Property · \$150\.00 could not go back the way it was paid — open the move-out and press Try again, or "Give it back in cash instead"$/)
    const view = await depositRefundView(final.id)
    expect(view.open_amount).toBe(150)
    expect(view.parts.find((p) => !p.done)).toMatchObject({ amount: 150, can_try_again: true, can_give_in_cash: true })
    // The admin alert states the real amounts.
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toMatch(/took back \$100\.00 of this deposit payment/)
    expect(alert[0].body).toMatch(/\$100\.00 of the move-out refund had not gone out yet, so that much is no longer sent/)
    expect(alert[0].body).toMatch(/\$150\.00 of the refund is still owed to the tenant/)
    expect(alert[0].body).not.toMatch(/move-out balance charge/)
    // Opening the page again stops nothing more and alerts nobody twice.
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id)
    expect(await parts(final.id)).toHaveLength(2)
    expect(await adminNotes('deposit_refund_then_returned')).toHaveLength(1)

    // Try again: the $150 goes back to the card, and the refund is done.
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_ok_${params.amount}`, status: 'succeeded' }))
    const live = view.parts.find((p) => !p.done)!
    const r = await retryDepositRefundPart(s.leaseId, live.id)
    expect(r.words).toEqual(['$150.00 was sent back to their card.'])
    expect(stripeMocks.refundsCreate.mock.calls.at(-1)![0]).toMatchObject({ payment_intent: pay.intent, amount: 15000 })
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    // The kept $250 was released to the landlord once.
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
  })

  it('while the dispute is open the card company takes no refund on it: Try again says so (cash only), and given back in cash the tenant is told it comes at the office instead of to their card', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 10000))).status).toBe(200)
    stripeMocks.refundsCreate.mockImplementation(async () => {
      const e: any = new Error('This charge has been disputed.'); e.code = 'charge_disputed'; throw e
    })
    const live = (await depositRefundView(final.id)).parts.find((p) => !p.done)!
    const tried = await retryDepositRefundPart(s.leaseId, live.id)
    expect(tried.words).toEqual(['Tried again — it did not go out. The refund below says why and what to do next.'])
    const { DEPOSIT_PART_DISPUTED } = await import('./earlyCheckOut')
    const now = (await depositRefundView(final.id)).parts.find((p) => !p.done)!
    expect(now).toMatchObject({ amount: 150, can_try_again: false, can_give_in_cash: true })
    expect(now.words).toContain(DEPOSIT_PART_DISPUTED)
    expect((await depositRefundTodos([s.landlordId]))[0].subtitle).toMatch(/\$150\.00 cannot go back the way it was paid — open the move-out and press "Give it back in cash instead"$/)
    // A press with an amount the page no longer shows is refused; with the right one it hands back $150.
    await expect(giveDepositPartBackInCash(s.leaseId, now.id, s.ownerUserId, { expectedAmount: 250 })).rejects.toThrow(/amount to give back changed/)
    const out = await giveDepositPartBackInCash(s.leaseId, now.id, s.ownerUserId, { expectedAmount: 150, viewerIsOwner: false })
    expect(out).toEqual({ handBack: true, words: ['Hand back $150.00 in cash now.',
      'It is recorded as given back — nothing goes to the card, and $150.00 is added to the landlord\'s next payout.'] })
    expect((await heldItems()).filter((i) => i.source_id.startsWith('cash-part:')).map((i) => i.amount)).toEqual([150])
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    // The tenant's statement said "back to your card"; they are told it comes at the office instead — once.
    const told = (await db.query(
      `SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement' ORDER BY created_at`, [s.tenantUserId])).rows
    expect(told).toHaveLength(2)
    expect(told[0].body).toMatch(/\$250\.00 back to your card\./)
    expect(told[1].body).toBe('$150.00 of your deposit refund could not go back to your card, so it was returned to you at the office instead (Test Property).')
    expect(told[1].body).not.toMatch(/GAM|landlord|hold/i)
  })

  it('a press after a dispute the webhook could not apply (the part was busy) applies it first and refuses, so nothing is handed back on the old amount', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    // Another request holds the part while the dispute arrives.
    const busy = await getClient()
    try {
      await busy.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`])
      expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
      expect(await parts(final.id)).toMatchObject([{ status: 'failed', amount: 250 }])
    } finally {
      await busy.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`]).catch(() => {})
      busy.release()
    }
    await expect(giveDepositPartBackInCash(s.leaseId, p.id, s.ownerUserId, { expectedAmount: 250 }))
      .rejects.toThrow(/disputed the payment this refund came from/)
    expect(await parts(final.id)).toMatchObject([{ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK, amount: 250 }])
    expect((await heldItems()).filter((i) => i.source_id.startsWith('cash-part:'))).toEqual([])
    // The tenant owes only the $250 the landlord kept.
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 250 }])
  })

  it('a part whose earlier try did reach the card (its record was lost) is recorded as sent, never stopped, when the dispute arrives — the tenant owes the reopened charge in full', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    // As if the try reached Stripe but GAM could not record it.
    await db.query(`UPDATE stay_refund_parts SET failure = 'The refund went to the card, but GAM could not finish recording it — press Try again.' WHERE id=$1`, [p.id])
    const todo = (await depositRefundTodos([s.landlordId]))[0]
    expect(todo.title).toBe('Finish Jane Doe\'s deposit refund (RV 22)')
    expect(todo.subtitle).toBe('Test Property · $250.00 already went back the way it was paid — open the move-out and press Try again to finish recording it; hand nothing back')
    stripeMocks.refundsList.mockImplementation(async () => ({ data: [
      { id: 're_lost', status: 'succeeded', metadata: { gam_stay_refund_part_id: p.id } }] }))
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    expect(await parts(final.id)).toMatchObject([{ status: 'refunded', amount: 250 }])
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 500 }])
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toMatch(/already sent \$250\.00 of this deposit payment back/)
    expect(alert[0].body).not.toMatch(/no longer sent/)
  })
})

describe('Fix pass 2: opening the move-out read-only never moves money', () => {
  it('a viewer who may only read gets the refund row brought up to date, but no disputed part stopped and nothing resent', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    // A dispute recorded but not yet applied to the part (as if its webhook could not take the part).
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [pay.id])
    await db.query(`UPDATE stay_refund_parts SET status='pending', failure=NULL, created_at = NOW() - interval '1 hour' WHERE deposit_return_id=$1`, [final.id])
    const calls = stripeMocks.refundsCreate.mock.calls.length
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id, { act: false })
    expect(stripeMocks.refundsCreate.mock.calls.length).toBe(calls)
    expect(await parts(final.id)).toMatchObject([{ status: 'pending', failure: null }])
  })
})

describe('Fix pass 2: a deposit payment with no receipt saying how it was paid', () => {
  it('asks the charge before sending: a bank payment goes back as a bank part, and the tenant is told "back to your bank", never "back to your card"', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'bank' })
    await db.query(`DELETE FROM tenant_remittances WHERE stripe_payment_intent_id=$1`, [pay.intent])
    stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) => ({ id, status: 'succeeded', payment_method_types: ['us_bank_account'] }))
    try {
      const final = await finalizeWithDamage(s, 500, 250)
      expect(await parts(final.id)).toMatchObject([{ kind: 'bank', status: 'refunded', amount: 250 }])
      const view = await depositRefundView(final.id)
      expect(view.parts[0].label).toMatch(/^Bank payment · /)
      expect(view.parts[0].words).toMatch(/sent back to their bank/)
      const told = (await db.query(`SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement'`, [s.tenantUserId])).rows
      expect(told[0].body).toMatch(/\$250\.00 back to your bank\./)
      expect(told[0].body).not.toMatch(/card/)
      // The refund row's note (the tenant's payments tab) says the same.
      const note = (await db.query(`SELECT notes FROM payments WHERE id=$1`, [final.refund_payment_id])).rows[0].notes
      expect(note).toMatch(/deducted\. \$250\.00 back to your bank\.$/)
    } finally {
      stripeMocks.paymentIntentsRetrieve.mockImplementation(async (id: string) => ({ id, status: 'succeeded' }))
    }
  })
})

// ── Fix pass 3 ────────────────────────────────────────────────────────────────

describe('Fix pass 3: a share a dispute took is stopped only as far as the reopened charge can still come down', () => {
  it('the dispute pass is put off (the part was busy), the tenant pays the reopened $500 in full, then the pass runs: the $250 refund stays live and still owed to them — nothing stays GAM\'s — and the alert says why', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    const busy = await getClient()
    try {
      await busy.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`])
      expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    } finally {
      await busy.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`]).catch(() => {})
      busy.release()
    }
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 500 }])
    // The tenant pays the reopened $500 (autopay or the portal) before anyone opens the move-out.
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = NOW(), stripe_payment_intent_id = 'pi_repaid'
        WHERE reversal_id IN (SELECT id FROM payment_reversals WHERE payment_id = $1)`, [pay.id])
    const { noteDepositRefundOfReturnedPayment, resumeDepositRefund } = await import('./depositRefundSend')
    expect(await noteDepositRefundOfReturnedPayment(pay.id)).toBe(true)
    // Nothing stopped: the tenant paid $500, got $500 back from the dispute and paid it again — the $250 refund is still theirs.
    expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'failed', amount: 250 }])
    expect((await parts(final.id))[0].failure).not.toBe(DEPOSIT_PART_TAKEN_BACK)
    expect(await openPartsTotal(final.id)).toBe(250)
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'settled', amount: 500 }])
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')
    expect(await depositRefundTodos([s.landlordId])).toEqual([expect.objectContaining({ type: 'deposit_refund_not_sent' })])
    // The webhook's own pass alerted once (the dispute); this pass says the real figure once more.
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert).toHaveLength(2)
    expect(alert[1].body).toMatch(/\$250\.00 of the move-out refund was NOT stopped: the tenant has already paid the reopened deposit charge/)
    expect(alert[1].body).toMatch(/\$250\.00 of the refund is still owed to the tenant/)
    expect(alert[1].body).not.toMatch(/no longer sent|now owes/)
    expect(alert[1].context).toMatchObject({ stopped_cents: 0, not_stopped_paid_cents: 25000, owed_again_cents: 0 })
    // Opening the move-out again stops nothing and alerts nobody twice.
    await resumeDepositRefund(final.id)
    expect(await openPartsTotal(final.id)).toBe(250)
    expect(await adminNotes('deposit_refund_then_returned')).toHaveLength(2)
    // Try again: the $250 goes back to the card — the tenant ends up out exactly the $250 the landlord kept.
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_ok_${params.amount}`, status: 'succeeded' }))
    expect((await retryDepositRefundPart(s.leaseId, p.id)).words).toEqual(['$250.00 was sent back to their card.'])
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
  })

  it('a reopened charge with a payment on its way (charge started, not cleared): nothing is stopped — the refund stays owed to the tenant', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    const busy = await getClient()
    try {
      await busy.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`])
      expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    } finally {
      await busy.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${p.id}`]).catch(() => {})
      busy.release()
    }
    await db.query(
      `UPDATE payments SET stripe_payment_intent_id = 'pi_on_its_way'
        WHERE reversal_id IN (SELECT id FROM payment_reversals WHERE payment_id = $1)`, [pay.id])
    const { noteDepositRefundOfReturnedPayment } = await import('./depositRefundSend')
    await noteDepositRefundOfReturnedPayment(pay.id)
    expect(await openPartsTotal(final.id)).toBe(250)
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 500 }])
  })
})

describe('Fix pass 3: a share a dispute stopped can never be sent or brought back to life', () => {
  it('a send queued before the dispute pass stopped the part sends nothing (no Stripe refund), and the part stays stopped', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    const [p] = await parts(final.id)
    expect(p).toMatchObject({ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK })
    const id = (await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id])).rows[0].id
    stripeMocks.refundsCreate.mockClear()
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.amount}`, status: 'succeeded' }))
    const { runCardPart } = await import('./earlyCheckOut')
    expect(await runCardPart(id)).toBe(true)
    expect(stripeMocks.refundsCreate).not.toHaveBeenCalled()
    expect(await parts(final.id)).toMatchObject([{ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK, amount: 250 }])
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
  })

  it('a stop that lands while a send is out (Stripe then refuses: charge disputed) is never overwritten into a live cash-only part', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const id = (await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id])).rows[0].id
    stripeMocks.refundsCreate.mockImplementation(async () => {
      await db.query(`UPDATE stay_refund_parts SET failure = $2 WHERE id = $1`, [id, DEPOSIT_PART_TAKEN_BACK])
      const e: any = new Error('This charge has been disputed.'); e.code = 'charge_disputed'; throw e
    })
    const { runCardPart } = await import('./earlyCheckOut')
    await runCardPart(id)
    expect(await parts(final.id)).toMatchObject([{ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK }])
    const view = await depositRefundView(final.id)
    expect(view.parts[0]).toMatchObject({ done: true, can_try_again: false, can_give_in_cash: false })
  })
})

describe('Fix pass 3: the desk is told to press first, then hand over the cash', () => {
  it('a deposit part Stripe could not send says "press … Give it back in cash instead — it tells you when to hand over the cash", never "hand it back in cash and press"', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect((await parts(final.id))[0].failure)
      .toBe('Stripe could not send this refund just now — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash.')
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_${params.amount}`, status: 'failed' }))
    const [p] = (await depositRefundView(final.id)).parts
    await retryDepositRefundPart(s.leaseId, p.id)
    const view = await depositRefundView(final.id)
    expect(view.parts[0].words).toMatch(/The card company turned this refund down — press Try again, or press "Give it back in cash instead" — it tells you when to hand over the cash\.$/)
    for (const v of view.parts) expect(v.words).not.toMatch(/hand it back in cash and press/)
    expect((await ownerNotes(s.ownerUserId, 'deposit_refund_failed')).every((n) => !/hand it back in cash and press/.test(n.body))).toBe(true)
  })

  it('the move-out page speaks to the owner in the staff voice: "back to the card they paid with", never "your card"', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const view = await depositRefundView(final.id)
    expect(view.reach_words).toBe('$250.00 back to the card they paid with.')
    // The tenant's own statement keeps their voice.
    const told = (await db.query(
      `SELECT body FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement'`, [s.tenantUserId])).rows
    expect(told[0].body).toMatch(/\$250\.00 back to your card\./)
  })
})

describe('Fix pass 4: a share a dispute stopped is never given back in cash too', () => {
  it('givePartBackInCash on a part a dispute already stopped hands nothing back, writes no payout line, and the part stays stopped', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const id = (await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id])).rows[0].id
    await db.query(`UPDATE stay_refund_parts SET failure = $2 WHERE id = $1`, [id, DEPOSIT_PART_TAKEN_BACK])
    const before = (await heldItems()).length
    const { givePartBackInCash } = await import('./earlyCheckOut')
    const out = await givePartBackInCash(id, null, s.ownerUserId)
    expect(out.words.some((w) => /^Hand back /.test(w))).toBe(false)
    expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK, amount: 250 }])
    expect((await heldItems()).filter((i) => i.source_id.startsWith('cash-part:'))).toEqual([])
    expect((await heldItems()).length).toBe(before)
  })

  it('a dispute that stops the part while the cash press is checking Stripe: the press is refused once, nothing is handed back or paid to the landlord, and the stop stays', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    expect(p).toMatchObject({ status: 'failed', can_give_in_cash: true })
    // The press passed its first checks; while it asks Stripe whether an earlier
    // try went out, the dispute pass stops the part (it was not locked yet).
    stripeMocks.refundsList.mockImplementation(async () => {
      await db.query(`UPDATE stay_refund_parts SET failure = $2 WHERE id = $1`, [p.id, DEPOSIT_PART_TAKEN_BACK])
      return { data: [] }
    })
    await expect(giveDepositPartBackInCash(s.leaseId, p.id, s.ownerUserId, { expectedAmount: 250 }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Hand nothing back — the page now shows the latest\.$/) })
    expect(await parts(final.id)).toMatchObject([{ kind: 'card', status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK }])
    expect((await heldItems()).filter((i) => i.source_id.startsWith('cash-part:'))).toEqual([])
    const told = (await db.query(
      `SELECT 1 FROM notifications WHERE user_id=$1 AND type='deposit_refund_statement' AND data ? 'nowInCash'`, [s.tenantUserId])).rows
    expect(told).toHaveLength(0)
  })
})

describe('Fix pass 4: the tenant\'s refund notices open their Payments page', () => {
  it('the move-out statement and the "now at the office" notice both carry a link to /payments', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    expect((await giveDepositPartBackInCash(s.leaseId, p.id, s.ownerUserId)).handBack).toBe(true)
    const told = (await db.query(
      `SELECT action_url, data ? 'nowInCash' AS now_in_cash FROM notifications
        WHERE user_id=$1 AND type='deposit_refund_statement' ORDER BY created_at`, [s.tenantUserId])).rows
    expect(told).toEqual([{ action_url: '/payments', now_in_cash: false }, { action_url: '/payments', now_in_cash: true }])
  })
})

describe('Fix pass 5: GAM’s book counts only the move-out refund parts still open (depositRefundsOwedSql)', () => {
  const owed = async () => {
    const { depositRefundsOwedSql } = await import('./depositRefundSend')
    return Number((await db.query(depositRefundsOwedSql())).rows[0].amt)
  }

  it('a split refund — $300 back to the bank, $200 to the card failed — counts $200 still owed, not $500; $0 once Try again sends it', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const older = await depositPaid(s, { amount: 200, via: 'card', daysAgo: 60 })
    const newer = await depositPaid(s, { amount: 300, via: 'bank', daysAgo: 10 })
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => {
      if (params.payment_intent === older.intent) throw new Error('Stripe is down')
      return { id: `re_${params.payment_intent}`, status: 'succeeded', metadata: params.metadata }
    })
    const final = await finalizeWithDamage(s, 500, 0)
    expect(Number(final.refund_from_gam)).toBe(500)
    expect(await parts(final.id)).toMatchObject([
      { seq: 1, kind: 'bank', amount: 300, deposit_payment_id: newer.id, status: 'refunded' },
      { seq: 2, kind: 'card', amount: 200, deposit_payment_id: older.id, status: 'failed' },
    ])
    // The refund row waits for the open part, but only the $200 is still GAM's to send.
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')
    expect(await owed()).toBe(200)

    stripeMocks.refundsCreate.mockImplementation(async (params: any) =>
      ({ id: `re_${params.payment_intent}_again`, status: 'succeeded', metadata: params.metadata }))
    const failed = (await depositRefundView(final.id)).parts.find((p) => p.status === 'failed')!
    await retryDepositRefundPart(s.leaseId, failed.id)
    expect(await owed()).toBe(0)
  })

  it('a part whose refund already reached the card (only its record is missing) is not counted — the money already left; a part a dispute took back is not counted either', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 0)
    expect(await owed()).toBe(500)
    const id = (await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_payment_id = $1`, [pay.id])).rows[0].id
    await db.query(`UPDATE stay_refund_parts SET failure = $2 WHERE id = $1`,
      [id, 'The refund went to the card they paid with, but GAM could not finish recording it — press Try again.'])
    expect(await owed()).toBe(0)
    await db.query(`UPDATE stay_refund_parts SET failure = $2 WHERE id = $1`, [id, DEPOSIT_PART_TAKEN_BACK])
    expect(await owed()).toBe(0)
    expect(final.refund_payment_id).toBeTruthy()
  })

  it('a move-out finalized before refund parts existed (no part) still counts its refund while its refund row is pending, and not once it is settled', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const final = await finalizeWithDamage(s, 500, 250)   // no card payment: one cash part on the to-do list
    expect(await owed()).toBe(250)
    await db.query(`DELETE FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id])
    await db.query(`UPDATE payments SET status = 'pending', settled_at = NULL WHERE id = $1`, [final.refund_payment_id])
    expect(await owed()).toBe(250)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [final.refund_payment_id])
    expect(await owed()).toBe(0)
  })
})

// ── Step 9 final fix (decisions #54) ─────────────────────────────────────────
// A GAM-held deposit payment disputed or bank-returned AFTER the move-out was
// finalized: the share the deductions kept, already paid to the landlord, is
// asked back of them on their next payout; the refund share not sent yet is
// stopped; the tenant's repayment of the reopened deposit charge refills GAM
// and is never released to the landlord a second time.

const keptBackLines = async () => (await db.query(
  `SELECT source_id, amount::float AS amount FROM held_payout_items
    WHERE source_type = 'dispute' AND source_id LIKE 'owner\\_share\\_%' ORDER BY created_at, source_id`)).rows
const recordOf = async (paymentId: string) => (await db.query(
  `SELECT id, recovery_status, recovered_amount::float AS recovered, reversed_amount::float AS reversed, outcome, status
     FROM payment_reversals WHERE payment_id = $1 ORDER BY created_at`, [paymentId])).rows
/** The tenant pays the reopened deposit charge again (card or bank, through GAM): the settle paths' own resolve. */
async function tenantRepays(paymentId: string): Promise<void> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const rows = (await c.query<{ reversal_id: string }>(
      `UPDATE payments SET status = 'settled', settled_at = NOW(), platform_held = TRUE,
              stripe_payment_intent_id = 'pi_repaid_' || left(id::text, 8)
        WHERE reversal_id IN (SELECT id FROM payment_reversals WHERE payment_id = $1) AND status = 'pending'
        RETURNING reversal_id`, [paymentId])).rows
    const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
    for (const r of rows) await resolveReversalOnTenantPayment(c, r.reversal_id)
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}
async function resolveAgain(paymentId: string): Promise<void> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
    for (const r of await recordOf(paymentId)) await resolveReversalOnTenantPayment(c, r.id)
    await c.query('COMMIT')
  } finally { c.release() }
}

describe('#54 a dispute of the deposit payment after the move-out: the kept share comes back from the landlord', () => {
  it('after the refund went out, a full chargeback: the $250 the deductions kept comes back off the landlord\'s next payout (one line, counted recovered), and the tenant owes the $500 again', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)   // the kept $250 went to the landlord
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)

    const [rec] = await recordOf(pay.id)
    expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}`, amount: -250 }])
    expect(rec).toMatchObject({ recovery_status: 'recovered', recovered: 250, reversed: 500 })
    // The payout line says what it is in plain words — the space and the tenant, never who held the money.
    const line = (await db.query(`SELECT description FROM held_payout_items WHERE source_id = $1`, [`owner_share_withheld:${rec.id}`])).rows[0]
    expect(line.description).toBe('Move-out at RV 22: deposit money kept for the deductions was taken back by Jane Doe\'s card dispute or bank return — it comes out of this payout')
    expect(line.description).not.toMatch(/GAM|held by|hold/i)
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 500 }])
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toMatch(/\$250\.00 the move-out paid the landlord for the deductions comes back off their next payout/)
    // GAM's book: nothing left as a deposit it holds; the landlord owes the $250 back on their payout.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -250 })
    // Opening the move-out again asks nothing more of the landlord.
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id)
    expect(await keptBackLines()).toHaveLength(1)
  })

  it('the tenant pays the reopened $500 again: it refills GAM — never a deposit GAM holds, never released to the landlord a second time — and the landlord is paid back the $250 they gave back, once', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    await tenantRepays(pay.id)

    const [rec] = await recordOf(pay.id)
    expect(rec).toMatchObject({ outcome: 'tenant_paid', status: 'resolved' })
    expect(await keptBackLines()).toEqual([
      { source_id: `owner_share_withheld:${rec.id}`, amount: -250 },
      { source_id: `owner_share_returned:${rec.id}`, amount: 250 },
    ])
    // The repayment is stamped with the move-out and off the trust count: no later
    // move-out, payout or pass-through can release it again.
    const repaid = (await db.query(
      `SELECT platform_held, released_by_deposit_return_id FROM payments WHERE reversal_id = $1`, [rec.id])).rows
    expect(repaid).toEqual([{ platform_held: false, released_by_deposit_return_id: final.id }])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
    // A second settle of the same record (a redelivery) pays the landlord nothing more.
    await resolveAgain(pay.id)
    expect(await keptBackLines()).toHaveLength(2)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)
  })

  it('before the refund went out (too old for the card), a full chargeback: the $250 not sent is stopped, the landlord gives back the $250 kept, and the tenant owes only that $250', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => {
      const e: any = new Error('This charge is too old to be refunded.'); e.code = 'charge_expired_for_refund'; throw e
    })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}`, amount: -250 }])
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 250 }])
    // GAM: −$500 to the card company, $250 never sent, $250 back from the landlord — whole.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -250 })
    // The landlord is told what the tenant really owes again — $250, never the $500 first reopened.
    const told = await ownerNotes(s.ownerUserId, 'rent_reversed')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/now owe \$250\.00/)
  })

  it('a $100 dispute no bigger than the refund not sent yet asks nothing of the landlord: the dispute already gave that money back', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 10000))).status).toBe(200)
    expect(await keptBackLines()).toEqual([])
    expect((await recordOf(pay.id))[0]).toMatchObject({ recovery_status: 'not_needed', recovered: 0 })
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'voided', amount: 100 }])
    // Nothing is owed again and nothing is asked of the landlord: no "payment reversed" notice to them.
    expect(await ownerNotes(s.ownerUserId, 'rent_reversed')).toEqual([])
  })

  it('a deposit the landlord\'s record holds plus a $200 pet deposit paid by card, $50 of it kept on the payout line and $150 refunded: a chargeback of the $200 asks the landlord for the $50 they were paid, never $200', async () => {
    const s = await stack({ deposit: 300, heldBy: 'landlord' })
    await db.query(`UPDATE properties p SET state='QB' FROM units u WHERE u.property_id = p.id AND u.id=$1`, [s.unitId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('QB', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported', allows_treasury_bills=true`)
    try {
      await depositPaid(s, { amount: 300, via: 'desk' })
      const feeId = (await db.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
         VALUES ($1,'pet_deposit',200,'move_in',TRUE,'deposit') RETURNING id`, [s.leaseId])).rows[0].id
      const pet = await depositPaid(s, { amount: 200, via: 'card' })
      await db.query(`UPDATE payments SET lease_fee_id=$2 WHERE id=$1`, [pet.id, feeId])
      const final = await finalizeWithDamage(s, 500, 350)
      expect(await heldItems()).toEqual([{ source_type: 'deposit_settlement', source_id: `kept:${final.id}`, amount: 50 }])
      expect((await postEvent('charge.dispute.created', disputeOf(pet.intent!, 20000))).status).toBe(200)
      const [rec] = await recordOf(pet.id)
      expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}`, amount: -50 }])
      expect(await reopenedOf(pet.id)).toEqual([{ status: 'pending', amount: 200 }])
    } finally {
      await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QB'`)
    }
  })

  it('a deposit paid by card through GAM on a record the landlord holds (released to them whole at move-out, $100 kept, $400 for them to hand back): a chargeback asks the landlord for the whole $500 they were paid, and the tenant owes it again', async () => {
    const s = await stack({ deposit: 500, heldBy: 'landlord' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 100)
    expect(Number(final.refund_from_landlord)).toBe(400)
    expect(await heldItems()).toEqual([{ source_type: 'deposit_settlement', source_id: pay.id, amount: 500 }])
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}`, amount: -500 }])
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 500 }])
    // Paid again by the tenant: the $500 goes back to the landlord once, and the repayment is no deposit GAM holds.
    await tenantRepays(pay.id)
    expect((await keptBackLines()).map((l) => l.amount)).toEqual([-500, 500])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 500 })
  })

  it('a bank return handled without the dispute webhook (the return route) also stops the refund not sent yet, so the owner\'s to-do never asks to send it', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'bank' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(await depositRefundTodos([s.landlordId])).toHaveLength(1)
    const { handlePaymentReversal } = await import('./paymentReversal')
    const r = await handlePaymentReversal({
      paymentId: pay.id, reversalType: 'ach_return', reversedAmount: 500, reversalFee: 4,
      stripeEventId: `evt_return_${randomUUID().slice(0, 8)}`, rawEvent: {},
    })
    expect(r.handled).toBe(true)
    expect(await parts(final.id)).toMatchObject([{ status: 'failed', failure: DEPOSIT_PART_TAKEN_BACK }])
    expect(await depositRefundTodos([s.landlordId])).toEqual([])
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 250 }])
    expect((await keptBackLines()).map((l) => l.amount)).toEqual([-250])
  })
})

describe('GAM’s book reads only the refund parts still open (stripeCosts uses depositRefundsOwedSql)', () => {
  it('$300 back to the bank and $200 to the card failed: $200 counts as deposit money GAM holds, not $500; $0 once it is sent', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const older = await depositPaid(s, { amount: 200, via: 'card', daysAgo: 60 })
    await depositPaid(s, { amount: 300, via: 'bank', daysAgo: 10 })
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => {
      if (params.payment_intent === older.intent) throw new Error('Stripe is down')
      return { id: `re_${params.payment_intent}`, status: 'succeeded', metadata: params.metadata }
    })
    const final = await finalizeWithDamage(s, 500, 0)
    expect((await refundRow(final.refund_payment_id!)).status).toBe('pending')
    expect(await book()).toEqual({ depositsInTrust: 200, heldItemsOwed: 0 })
    stripeMocks.refundsCreate.mockImplementation(async (params: any) =>
      ({ id: `re_${params.payment_intent}_again`, status: 'succeeded', metadata: params.metadata }))
    const failed = (await depositRefundView(final.id)).parts.find((p) => p.status === 'failed')!
    await retryDepositRefundPart(s.leaseId, failed.id)
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
  })
})

describe('The stale-refund sweep (resumeStaleDepositRefunds)', () => {
  it('sends a card part left "sending" for more than 10 minutes, once, and leaves a newer one alone', async () => {
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id]).then((r) => r.rows)
    // Left "sending" 5 minutes ago (a crash between finalize and Stripe): too soon to touch.
    await db.query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - interval '5 minutes' WHERE id = $1`, [p.id])
    stripeMocks.refundsCreate.mockClear()
    stripeMocks.refundsCreate.mockImplementation(async (params: any) => ({ id: `re_sweep_${params.amount}`, status: 'succeeded', metadata: params.metadata }))
    const { resumeStaleDepositRefunds } = await import('./depositRefundSend')
    expect(await resumeStaleDepositRefunds()).toBe(0)
    expect(stripeMocks.refundsCreate).not.toHaveBeenCalled()
    await db.query(`UPDATE stay_refund_parts SET created_at = NOW() - interval '11 minutes' WHERE id = $1`, [p.id])
    expect(await resumeStaleDepositRefunds()).toBe(1)
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
    expect((await parts(final.id))[0]).toMatchObject({ status: 'refunded' })
    expect((await refundRow(final.refund_payment_id!)).status).toBe('settled')
    expect(await resumeStaleDepositRefunds()).toBe(0)
    expect(stripeMocks.refundsCreate).toHaveBeenCalledTimes(1)
  })
})

// ── Step 9 fix pass 2 (review of decisions #54) ─────────────────────────────
const repaymentOf = async (paymentId: string) => (await db.query<{ id: string; intent: string }>(
  `SELECT q.id, q.stripe_payment_intent_id AS intent FROM payments q JOIN payment_reversals pr ON pr.id = q.reversal_id
    WHERE pr.payment_id = $1 AND q.status = 'settled'`, [paymentId])).rows[0]

describe('#54 fix pass 2: a dispute of the tenant\'s REPAYMENT of a reopened deposit charge asks back only what the repayment paid the landlord', () => {
  it('escrow, $500 by card, $250 kept, refund sent: full chargeback, the tenant repays $500 (the landlord is paid their $250 back), then the $500 repayment is disputed — the landlord gives back $250, never $500', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    await tenantRepays(pay.id)
    const repaid = await repaymentOf(pay.id)
    expect((await keptBackLines()).map((l) => l.amount)).toEqual([-250, 250])

    expect((await postEvent('charge.dispute.created', disputeOf(repaid.intent, 50000))).status).toBe(200)
    const [rec2] = await recordOf(repaid.id)
    expect(rec2).toMatchObject({ recovery_status: 'recovered', recovered: 250, reversed: 500 })
    expect((await keptBackLines()).find((l) => l.source_id === `owner_share_withheld:${rec2.id}`)).toEqual(
      { source_id: `owner_share_withheld:${rec2.id}`, amount: -250 })
    expect(await reopenedOf(repaid.id)).toEqual([{ status: 'pending', amount: 500 }])
    // The landlord holds $250 net again before this line: they end at $0 of it until the tenant pays again.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -250 })
    // Paid again: the $250 is the landlord's once more, and only once.
    await tenantRepays(repaid.id)
    expect((await keptBackLines()).map((l) => l.amount)).toEqual([-250, 250, -250, 250])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
  })

  it('a record the landlord holds plus a $200 card pet deposit ($50 kept on their payout line): a dispute of the $200 repayment asks back the $50 the repayment paid them — never nothing', async () => {
    const s = await stack({ deposit: 300, heldBy: 'landlord' })
    await db.query(`UPDATE properties p SET state='QB' FROM units u WHERE u.property_id = p.id AND u.id=$1`, [s.unitId])
    await db.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ('QB', 'supported', true, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status='supported', allows_treasury_bills=true`)
    try {
      await depositPaid(s, { amount: 300, via: 'desk' })
      const feeId = (await db.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
         VALUES ($1,'pet_deposit',200,'move_in',TRUE,'deposit') RETURNING id`, [s.leaseId])).rows[0].id
      const pet = await depositPaid(s, { amount: 200, via: 'card' })
      await db.query(`UPDATE payments SET lease_fee_id=$2 WHERE id=$1`, [pet.id, feeId])
      await finalizeWithDamage(s, 500, 350)
      expect((await postEvent('charge.dispute.created', disputeOf(pet.intent!, 20000))).status).toBe(200)
      await tenantRepays(pet.id)
      expect((await keptBackLines()).map((l) => l.amount)).toEqual([-50, 50])
      const repaid = await repaymentOf(pet.id)
      expect((await postEvent('charge.dispute.created', disputeOf(repaid.intent, 20000))).status).toBe(200)
      const [rec2] = await recordOf(repaid.id)
      expect(rec2).toMatchObject({ recovery_status: 'recovered', recovered: 50 })
      expect((await keptBackLines()).map((l) => l.amount)).toEqual([-50, 50, -50])
      expect(await reopenedOf(repaid.id)).toEqual([{ status: 'pending', amount: 200 }])
    } finally {
      await db.query(`DELETE FROM state_deposit_custody_rules WHERE state_code = 'QB'`)
    }
  })

  it('a repayment that paid the landlord nothing (nothing was kept: the whole $500 went back to the card) asks nothing when it is disputed', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    await finalizeWithDamage(s, 500, 0)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    expect(await keptBackLines()).toEqual([])
    await tenantRepays(pay.id)
    const repaid = await repaymentOf(pay.id)
    expect((await postEvent('charge.dispute.created', disputeOf(repaid.intent, 50000))).status).toBe(200)
    expect(await keptBackLines()).toEqual([])
    expect((await recordOf(repaid.id))[0]).toMatchObject({ recovery_status: 'not_needed', recovered: 0 })
    expect(await reopenedOf(repaid.id)).toEqual([{ status: 'pending', amount: 500 }])
  })
})

describe('#54 fix pass 2: a refund part counted as not sent that turns out sent', () => {
  it('a $250 dispute over a part whose refund already went to the card ("The refund went to …"): the take lands on the kept share — the landlord gives back $250 at once, and the tenant owes $250 again', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    await db.query(`UPDATE stay_refund_parts SET failure = 'The refund went to the card, but GAM could not finish recording it — press Try again.' WHERE id=$1`, [p.id])
    stripeMocks.refundsList.mockImplementation(async () => ({ data: [
      { id: 're_lost', status: 'succeeded', metadata: { gam_stay_refund_part_id: p.id } }] }))
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 25000))).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}`, amount: -250 }])
    expect(rec).toMatchObject({ recovery_status: 'recovered', recovered: 250 })
    expect(await parts(final.id)).toMatchObject([{ status: 'refunded', amount: 250 }])
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 250 }])
  })

  it('a $250 dispute over a part whose try failed (counted not sent at the reversal) that Stripe then shows was sent: the landlord\'s $250 is asked on a further line once, and a repayment pays it all back to them once', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    expect((await db.query(`SELECT attempts FROM stay_refund_parts WHERE id=$1`, [p.id])).rows[0].attempts).toBeGreaterThan(0)
    stripeMocks.refundsList.mockImplementation(async () => ({ data: [
      { id: 're_lost', status: 'succeeded', metadata: { gam_stay_refund_part_id: p.id } }] }))
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 25000))).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    expect(await parts(final.id)).toMatchObject([{ status: 'refunded', amount: 250 }])
    expect(await keptBackLines()).toEqual([{ source_id: `owner_share_withheld:${rec.id}:more:25000`, amount: -250 }])
    expect((await recordOf(pay.id))[0]).toMatchObject({ recovery_status: 'recovered', recovered: 250 })
    expect(await reopenedOf(pay.id)).toEqual([{ status: 'pending', amount: 250 }])
    const alert = await adminNotes('deposit_refund_then_returned')
    expect(alert.at(-1).body).toMatch(/\$250\.00 the move-out paid the landlord for the deductions comes back off their next payout/)
    // Opening the move-out again asks nothing more.
    const { resumeDepositRefund } = await import('./depositRefundSend')
    await resumeDepositRefund(final.id)
    expect(await keptBackLines()).toHaveLength(1)
    await tenantRepays(pay.id)
    expect((await keptBackLines()).map((l) => l.amount)).toEqual([-250, 250])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
  })

  it('no top-up once the tenant has paid the reopened charge again: that repayment already refilled what the dispute took', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    const final = await finalizeWithDamage(s, 500, 250)
    const [p] = (await depositRefundView(final.id)).parts
    // Stripe cannot be reached while the dispute arrives: the part stays unsure (not stopped, not sent).
    stripeMocks.refundsList.mockImplementation(async () => { throw new Error('Stripe is down') })
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 25000))).status).toBe(200)
    expect(await keptBackLines()).toEqual([])
    await tenantRepays(pay.id)
    stripeMocks.refundsList.mockImplementation(async () => ({ data: [
      { id: 're_lost', status: 'succeeded', metadata: { gam_stay_refund_part_id: p.id } }] }))
    const { noteDepositRefundOfReturnedPayment } = await import('./depositRefundSend')
    await noteDepositRefundOfReturnedPayment(pay.id)
    expect(await parts(final.id)).toMatchObject([{ status: 'refunded' }])
    expect(await keptBackLines()).toEqual([])
  })
})

describe('#54 fix pass 2: an escrow move-out whose transfer to the landlord never went out', () => {
  it('a chargeback asks nothing of the landlord\'s payout (they were never paid the kept $250) and tells the admin to pay them that much less by hand', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    await db.query(`UPDATE landlords SET stripe_connect_account_id = NULL WHERE id=$1`, [s.landlordId])
    await db.query(`UPDATE users u SET stripe_connect_account_id = NULL FROM landlords l WHERE l.user_id = u.id AND l.id=$1`, [s.landlordId])
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    const final = await finalizeWithDamage(s, 500, 250)
    expect(stripeMocks.transfersCreate).not.toHaveBeenCalled()
    expect(await adminNotes('deposit_disbursement_pending_no_connect')).toHaveLength(1)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    expect(await keptBackLines()).toEqual([])
    expect((await recordOf(pay.id))[0]).toMatchObject({ recovery_status: 'not_needed', recovered: 0 })
    const alert = await adminNotes('deposit_kept_share_not_paid_out')
    expect(alert).toHaveLength(1)
    expect(alert[0].body).toMatch(/pay them \$250\.00 less/)
    expect(alert[0].context).toMatchObject({ deposit_return_id: final.id, payment_id: pay.id, not_paid_out_cents: 25000 })
  })
})

describe('#54 fix pass 2: the tenant repays a reopened move-out deposit charge in cash to the landlord', () => {
  it('the landlord keeps the $250 kept share once out of the $500 cash, and the $250 refunded at move-out comes off their payout — GAM ends whole', async () => {
    const s = await stack({ deposit: 500, heldBy: 'gam_escrow' })
    const pay = await depositPaid(s, { amount: 500, via: 'card' })
    await finalizeWithDamage(s, 500, 250)
    expect((await postEvent('charge.dispute.created', disputeOf(pay.intent!, 50000))).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    const c = await getClient()
    let paidLandlordAgain: boolean
    try {
      await c.query('BEGIN')
      await c.query(
        `UPDATE payments SET status = 'settled', settled_at = NOW(), platform_held = FALSE, manual_method = 'cash'
          WHERE reversal_id = $1 AND status = 'pending'`, [rec.id])
      const { resolveReversalOnTenantPayment } = await import('./paymentReversal')
      paidLandlordAgain = await resolveReversalOnTenantPayment(c, rec.id, { landlordHoldsCash: true })
      await c.query('COMMIT')
    } finally { c.release() }
    expect(paidLandlordAgain).toBe(false)
    expect(await keptBackLines()).toEqual([
      { source_id: `owner_share_withheld:${rec.id}`, amount: -250 },
      { source_id: `owner_share_refill:${rec.id}`, amount: -250 },
    ])
    const refill = (await db.query(`SELECT description FROM held_payout_items WHERE source_id = $1`, [`owner_share_refill:${rec.id}`])).rows[0]
    expect(refill.description).not.toMatch(/GAM|held by|hold/i)
    expect((await recordOf(pay.id))[0]).toMatchObject({ outcome: 'tenant_paid', status: 'resolved' })
    // The landlord holds the $500 cash and owes back $500 on their payout: $250 kept share net, GAM whole.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -500 })
    // A redelivery adds nothing.
    await resolveAgain(pay.id)
    expect(await keptBackLines()).toHaveLength(2)
  })
})
