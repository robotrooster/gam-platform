/**
 * 10/12 (Nic) — GAM Books ledger, phase P5: the payout chain and GAM's charges
 * post themselves (gam-ledger-design-2026-10-12 §6 G1-G4, E2, F4, H; Nic's
 * 10/12 answers L18, G1, G5). Real tables, real capture triggers, the real
 * engine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { cleanupAllSchema, seedTenant, seedRentPayment } from '../../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../../test/ledgerFixtures'
import { registerP5, unregisterAll, sale, active, balance, received, waiting } from '../../test/ledgerP5Fixtures'
import { drainLedgerOutbox } from '../ledgerEngine'
import { stripeInTransitCheck, dueToGamCheck } from './payoutChecks'

beforeEach(async () => {
  await cleanupAllSchema()
  registerP5()
})
afterEach(() => unregisterAll())

const brief = (ls: Awaited<ReturnType<typeof active>>) => ls.map(l => [l.role, l.dr, l.cr])
const byProp = (ls: Awaited<ReturnType<typeof active>>, co: LedgerCompany) =>
  ls.map(l => [l.role, l.property === co.propertyId ? 'p1' : l.property === co.propertyId2 ? 'p2' : null, l.dr, l.cr])

async function held(co: LedgerCompany, sourceType: string, sourceId: string, amount: number, o: { property?: string | null; intent?: string | null; at?: string } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, property_id, payout_intent_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now())) RETURNING id`,
    [co.landlordId, sourceType, sourceId, amount, o.property === undefined ? co.propertyId : o.property, o.intent ?? null, o.at ?? null])).rows[0].id
}

async function charge(co: LedgerCompany, kind: string, amount: number, o: { property?: string | null; at?: string; voided?: boolean } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at, voided_at, void_reason)
     VALUES ($1, $2, $3, $4, 'test', COALESCE($5::timestamptz, now()),
             CASE WHEN $6::boolean THEN now() END, CASE WHEN $6::boolean THEN 'bank_debit_not_made' END) RETURNING id`,
    [co.landlordId, o.property === undefined ? co.propertyId : o.property, kind, amount, o.at ?? null, !!o.voided])).rows[0].id
}

describe('G1: how a payment GAM held was split', () => {
  async function split(co: LedgerCompany, s: Record<string, number>): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, landlord_fee_withheld, supersedence,
                                      pm_fee_due, pm_paid, manager_fee_due, manager_paid, short_by, owner_share, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '2026-09-10 18:00:00+00') RETURNING id`,
      [randomUUID(), co.landlordId, co.propertyId, s.gross ?? 0, s.fee ?? 0, s.sup ?? 0, s.pmDue ?? 0, s.pmPaid ?? 0,
       s.mgrDue ?? 0, s.mgrPaid ?? 0, s.short ?? 0, s.owner ?? 0])).rows[0].id
  }

  it('the covered processing fee and the cuts paid leave Due from GAM; the cut GAM held too little to pay is a bill the landlord owes (Nic L18)', async () => {
    const co = await ledgerCompany()
    // $20 held: $6 fee, manager fee $15 due — $14 paid, $1 short; owner $0.
    const id = await split(co, { gross: 20, fee: 6, mgrDue: 15, mgrPaid: 14, short: 1, owner: 0 })
    await drainLedgerOutbox()
    const ls = await active('allocation', id)
    expect(ls[0].day).toBe('2026-09-10')
    expect(brief(ls)).toEqual([
      ['processing_fees', 6, 0], ['management_fees', 14, 0], ['due_from_gam', 0, 20],
      ['management_fees', 1, 0], ['accounts_payable', 0, 1],
    ])
  })

  it('a split carrying GAM-supersedence waits for its rule (design G1)', async () => {
    const co = await ledgerCompany()
    const id = await split(co, { gross: 100, sup: 25, owner: 75 })
    await drainLedgerOutbox()
    expect((await waiting('allocation', id))?.reason_code).toBe('projector_error')
  })
})

describe('G4: each held line posts only what no other source does', () => {
  it('deposit releases, the covered fee, Stripe\'s dispute fee; paid-ahead releases (L13), sales, stay deposits and a rent dispute\'s share lines post nothing here', async () => {
    const co = await ledgerCompany()
    const draw = await held(co, 'prepaid_draw', randomUUID(), 50)
    const kept = await held(co, 'deposit_settlement', `kept:${randomUUID()}`, 30)
    const gamLines = await held(co, 'deposit_settlement', `gam_lines:${randomUUID()}`, -20)
    const fee = await held(co, 'platform_fee', 'processing_fee:pi_1', -6)
    const disputeFee = await held(co, 'dispute', `stripe_fee_kept:pi_2:${co.landlordId}`, -15)
    const feeBack = await held(co, 'dispute', `stripe_fee_kept:pi_2:${co.landlordId}:returned_on_win`, 15)
    const share = await held(co, 'dispute', `owner_share_withheld:${randomUUID()}`, -100)
    const posSale = await held(co, 'pos_sale', randomUUID(), 40)
    await drainLedgerOutbox()
    // Nic L13: paid-ahead money GAM holds is off the landlord's books until spent; its spend posts the release (P4).
    expect(await active('held_item', draw)).toEqual([])
    expect(brief(await active('held_item', kept))).toEqual([['due_from_gam', 30, 0], ['deposits_gam_holds', 0, 30]])
    expect(brief(await active('held_item', gamLines))).toEqual([['security_deposits_payable', 20, 0], ['due_from_gam', 0, 20]])
    expect(brief(await active('held_item', fee))).toEqual([['processing_fees', 6, 0], ['due_from_gam', 0, 6]])
    expect(brief(await active('held_item', disputeFee))).toEqual([['chargeback_fees', 15, 0], ['due_from_gam', 0, 15]])
    expect(brief(await active('held_item', feeBack))).toEqual([['chargeback_fees', 0, 15], ['due_from_gam', 15, 0]])
    expect(await active('held_item', share)).toEqual([])
    expect(await active('held_item', posSale)).toEqual([])
  })

  it('F4: a chargeback on a register card sale takes the sale and its tax back that day, the rest is chargeback fees; a win gives it back', async () => {
    const co = await ledgerCompany()
    const s = await sale(co, { method: 'card', subtotal: 100, tax: 6.6, taxBreakdown: [{ name: 'Transaction privilege tax', rate: 0.066, amount: 6.6 }],
      surcharge: 4.29, platformFee: 4.29, held: 106.6 })
    const pi = (await db.query<{ pi: string }>(`SELECT stripe_payment_intent_id AS pi FROM pos_transactions WHERE id = $1`, [s])).rows[0].pi
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, landlord_id, amount, status)
       VALUES ('dp_1', 'ch_1', $1, $2, 110.89, 'needs_response')`, [pi, co.landlordId])
    const cb = await held(co, 'dispute', 'dp_1', -125.89, { at: '2026-09-25 18:00:00+00' })
    const won = await held(co, 'dispute', 'dp_1:returned_on_win', 125.89, { at: '2026-10-20 18:00:00+00' })
    await drainLedgerOutbox()
    const ls = await active('held_item', cb)
    expect(ls[0].day).toBe('2026-09-25')
    expect(ls.map(l => [l.role, l.dr, l.cr, l.cash, l.cat])).toEqual([
      ['sales_returns', 100, 0, 'in', 'refunds'],
      ['sales_tax_payable', 6.6, 0, 'in', 'tax_collected'],
      ['due_from_gam', 0, 125.89, null, null],
      ['chargeback_fees', 19.29, 0, null, null],
    ])
    expect(brief(await active('held_item', won))).toEqual([
      ['sales_returns', 0, 100], ['sales_tax_payable', 0, 6.6], ['due_from_gam', 125.89, 0], ['chargeback_fees', 0, 19.29],
    ])
    expect(await received(co.landlordId, '2026-09-25', '2026-09-25')).toBe(-106.6)
  })

  it('a chargeback whose charge GAM cannot find waits for the fact', async () => {
    const co = await ledgerCompany()
    const cb = await held(co, 'dispute', 'dp_unknown', -50)
    await drainLedgerOutbox()
    expect((await waiting('held_item', cb))?.reason_code).toBe('missing_fact')
  })
})

describe('G2 / H6: the weekly batch, and G3: the payout to the bank', () => {
  /** A transferred batch: $200 of owner shares at p1, a $100 held line at p2, a $40 reversal netted (p1), a $30 GAM charge kept (p1). */
  async function batch(co: LedgerCompany): Promise<{ intentId: string; chargeId: string }> {
    const tenantId = await inTx(c => seedTenant(c))
    const paymentId = await inTx(c => seedRentPayment(c, { unitId: co.unitId, tenantId, landlordId: co.landlordId, amount: 40 }))
    const createdAt = '2026-09-22 15:00:00.123456+00'
    const intentId = (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed,
                                              netted_amount, status, stripe_transfer_id, transferred_at, created_at)
       VALUES ($1, $2, 'acct_1', 230, 300, 40, 'transferred', 'tr_1', '2026-09-22 16:00:00+00', $3) RETURNING id`,
      [co.landlordId, co.ownerUserId, createdAt])).rows[0].id
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, property_id, stripe_transfer_id)
       VALUES ($1, 'allocation_owner_share', 200, 0, $2, 'payment', $3, 'tr_1')`, [co.ownerUserId, randomUUID(), co.propertyId])
    await held(co, 'pos_sale', randomUUID(), 100, { property: co.propertyId2, intent: intentId })
    await db.query(
      `INSERT INTO payment_reversals (payment_id, landlord_id, reversal_type, reversed_amount, recovered_amount, raw_event, stripe_event_id,
                                      outcome, recovery_status, status, recovered_at)
       VALUES ($1, $2, 'card_dispute', 40, 40, '{}'::jsonb, 'evt_1', 'landlord_clawback', 'recovered', 'resolved', $3)`,
      [paymentId, co.landlordId, createdAt])
    const chargeId = await charge(co, 'subscription', 30, { at: '2026-09-01 18:00:00+00' })
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, platform_transfer_intent_id, amount) VALUES ($1, $2, 30)`, [chargeId, intentId])
    return { intentId, chargeId }
  }

  it('the batch takes what it claimed out of Due from GAM, closes the netted reversal, pays the kept GAM charge, and sends the rest to Stripe', async () => {
    const co = await ledgerCompany()
    const { intentId } = await batch(co)
    await drainLedgerOutbox()
    const ls = await active('transfer_intent', intentId)
    expect(ls[0].day).toBe('2026-09-22')
    expect(byProp(ls, co).map(x => JSON.stringify(x)).sort()).toEqual([
      ['due_from_gam', 'p1', 0, 200], ['due_from_gam', 'p2', 0, 100],
      ['due_from_gam', 'p1', 40, 0],
      ['due_to_gam', 'p1', 30, 0],
      ['stripe_in_transit', 'p1', 130, 0], ['stripe_in_transit', 'p2', 100, 0],
    ].map(x => JSON.stringify(x)).sort())
    expect(await balance(co.landlordId, 'due_to_gam')).toBe(0)
  })

  it('the payout settles to the linked bank\'s own sub-account at the properties the money left; 1060 ties out to zero', async () => {
    const co = await ledgerCompany()
    const { intentId } = await batch(co)
    const bank = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, account_last4, status) VALUES ($1, '6789', 'active') RETURNING id`, [co.landlordId])).rows[0].id
    const payout = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, bank_last4, trigger_type)
       VALUES ($1, 230, 'settled', '2026-09-25 18:00:00+00', '6789', 'auto_friday') RETURNING id`, [co.landlordId])).rows[0].id
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [payout, intentId])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('disbursement', payout)
    expect(ls[0].day).toBe('2026-09-25')
    expect(byProp(ls, co).map(x => JSON.stringify(x)).sort()).toEqual([
      ['bank_checking', 'p1', 130, 0], ['stripe_in_transit', 'p1', 0, 130],
      ['bank_checking', 'p2', 100, 0], ['stripe_in_transit', 'p2', 0, 100],
    ].map(x => JSON.stringify(x)).sort())
    const acct = await db.query<{ bank_connection_id: string | null }>(
      `SELECT a.bank_connection_id FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE l.landlord_id = $1 AND l.account_role = 'bank_checking' LIMIT 1`, [co.landlordId])
    expect(acct.rows[0].bank_connection_id).toBe(bank)
    expect(await balance(co.landlordId, 'stripe_in_transit')).toBe(0)
    const c = await db.connect()
    try {
      expect(await stripeInTransitCheck.run(c, co.owner)).toEqual([])
    } finally { c.release() }
  })

  // 10/12 (Nic, ledger review): the payout's bank comes from stored facts, never
  // from which connections happen to be on file today.
  it('the payout\'s bank: the connection its matched bank line names; else the one linked on or before it settled — a reconnect never moves it', async () => {
    const co = await ledgerCompany()
    const old = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, account_last4, status, created_at) VALUES ($1, '6789', 'disconnected', '2026-08-17 18:00:00+00') RETURNING id`,
      [co.landlordId])).rows[0].id
    const payout = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at, bank_last4, trigger_type)
       VALUES ($1, 50, 'settled', '2026-09-25 18:00:00+00', '6789', 'auto_friday') RETURNING id`, [co.landlordId])).rows[0].id
    const bankOf = async () => (await db.query<{ c: string | null }>(
      `SELECT a.bank_connection_id AS c FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id JOIN books_accounts a ON a.id = l.account_id
        WHERE p.source_type = 'disbursement' AND p.source_id = $1 AND p.role = 'post' AND p.superseded_at IS NULL
          AND l.account_role = 'bank_checking'`, [payout])).rows.map(r => r.c)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await bankOf()).toEqual([old])
    // Reconnected later: the old payout stays where it was.
    const fresh = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, account_last4, status, created_at) VALUES ($1, '6789', 'active', '2026-09-26 16:00:00+00') RETURNING id`,
      [co.landlordId])).rows[0].id
    const { rebuildOwner } = await import('../ledgerRebuild')
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
    // The bank feed matches the payout's line on the new connection: that fact wins (the match re-posts the payout).
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, matched_disbursement_id)
       VALUES ($1, $2, 'payout-line', '2026-09-26', 50, 'matched', $3)`, [fresh, co.landlordId, payout])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await bankOf()).toEqual([fresh])
  })

  it('a payout on a shared Stripe account names no company: with no transfer on record it waits; an instant margin is GAM\'s fee from the Stripe balance', async () => {
    const co = await ledgerCompany()
    // 10/12 (Nic, review; L7): GAM's fee on a payout is a company-level cost —
    // placed as the owner chose (here, a Company column of its own).
    await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
    const payout = (await db.query<{ id: string }>(
      `INSERT INTO disbursements (landlord_id, amount, status, settled_at) VALUES (NULL, 50, 'settled', now()) RETURNING id`)).rows[0].id
    const margin = (await db.query<{ id: string }>(
      `INSERT INTO landlord_instant_margins (landlord_id, connect_account_id, amount, status, collected_at)
       VALUES ($1, 'acct_1', 2.5, 'collected', '2026-09-26 18:00:00+00') RETURNING id`, [co.landlordId])).rows[0].id
    await drainLedgerOutbox()
    expect((await waiting('disbursement', payout))?.reason_code).toBe('missing_fact')
    expect(brief(await active('instant_margin', margin))).toEqual([['gam_platform_fees', 2.5, 0], ['stripe_in_transit', 0, 2.5]])
  })
})

describe('H: GAM\'s charges and the bank pull that pays them', () => {
  // 10/13 (Nic): "Readers on the LANDLORD's books: each $87.50 → SUPPLIES, in
  // the month GAM COLLECTED it" — the piece's charge posts nothing of its own.
  it('each kind posts to its own cost; GAM\'s background check is the cash sale\'s; a reader piece posts when collected, not when charged; a voided charge posts nothing', async () => {
    const co = await ledgerCompany()
    const sub = await charge(co, 'subscription', 10)
    const cost = await charge(co, 'bank_debit_cost', 6)
    const failed = await charge(co, 'bank_debit_failed_cost', 0.27)
    const uncovered = await charge(co, 'uncovered_processing_fee', 2)
    const screening = await charge(co, 'screening_fee', 30)
    const piece = await charge(co, 'device_installment', 87.5)
    const voided = await charge(co, 'subscription', 10, { voided: true })
    await drainLedgerOutbox()
    expect(brief(await active('gam_charge', sub))).toEqual([['gam_platform_fees', 10, 0], ['due_to_gam', 0, 10]])
    expect(brief(await active('gam_charge', cost))).toEqual([['bank_fees', 6, 0], ['due_to_gam', 0, 6]])
    expect(brief(await active('gam_charge', failed))).toEqual([['chargeback_fees', 0.27, 0], ['due_to_gam', 0, 0.27]])
    expect(brief(await active('gam_charge', uncovered))).toEqual([['processing_fees', 2, 0], ['due_to_gam', 0, 2]])
    expect(await active('gam_charge', screening)).toEqual([])
    expect(await active('gam_charge', voided)).toEqual([])
    expect(await active('gam_charge', piece)).toEqual([])
    expect(await waiting('gam_charge', piece)).toBeNull()
    expect(await balance(co.landlordId, 'supplies')).toBe(0)
  })

  it('a bank pull that succeeded pays the charges it collected and is an outstanding debit until the bank line matches it', async () => {
    const co = await ledgerCompany()
    // 10/12 (Nic, review; L7): the bank cost of the pull belongs to no property —
    // a company-level cost, placed as the owner chose (a Company column here).
    await db.query(`UPDATE landlords SET books_company_costs_method = 'company_bucket' WHERE id = $1`, [co.landlordId])
    const sub = await charge(co, 'subscription', 10, { property: co.propertyId2 })
    const cost = await charge(co, 'bank_debit_cost', 6, { property: null })
    const debit = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids, settled_at)
       VALUES ($1, 10, 6, 16, 'succeeded', $2::uuid[], '2026-09-30 18:00:00+00') RETURNING id`, [co.landlordId, [sub, cost]])).rows[0].id
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, landlord_gam_debit_id, amount) VALUES ($1, $3, 10), ($2, $3, 6)`, [sub, cost, debit])
    await drainLedgerOutbox()
    const ls = await active('gam_debit', debit)
    expect(ls[0].day).toBe('2026-09-30')
    expect(byProp(ls, co)).toEqual([
      ['due_to_gam', null, 6, 0], ['outstanding_checks', null, 0, 6],
      ['due_to_gam', 'p2', 10, 0], ['outstanding_checks', 'p2', 0, 10],
    ])
    expect(await balance(co.landlordId, 'due_to_gam')).toBe(0)
    const c = await db.connect()
    try {
      expect(await dueToGamCheck.run(c, co.owner)).toEqual([])
    } finally { c.release() }
  })

  // 10/13 (Nic): "Readers on the LANDLORD's books: each $87.50 → SUPPLIES, in
  // the month GAM COLLECTED it" — the batch that kept the piece posts it as
  // Supplies on its own day; nothing about the piece is owed to GAM.
  it('a reader piece a batch collected is a Supplies expense on the batch\'s day; 2080 ties with nothing pending', async () => {
    const co = await ledgerCompany()
    const sub = await charge(co, 'subscription', 10)
    const piece = await charge(co, 'device_installment', 87.5)
    const intent = (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed,
                                              netted_amount, status, stripe_transfer_id, transferred_at)
       VALUES ($1, $2, 'acct_1', 2.5, 100, 0, 'transferred', 'tr_piece', '2026-09-22 16:00:00+00') RETURNING id`,
      [co.landlordId, co.ownerUserId])).rows[0].id
    await held(co, 'pos_sale', randomUUID(), 100, { intent })
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, platform_transfer_intent_id, amount) VALUES ($1, $3, 10), ($2, $3, 87.5)`,
      [sub, piece, intent])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('transfer_intent', intent)
    expect(ls[0].day).toBe('2026-09-22')
    expect(byProp(ls, co).map(x => JSON.stringify(x)).sort()).toEqual([
      ['due_from_gam', 'p1', 0, 100], ['due_to_gam', 'p1', 10, 0], ['supplies', 'p1', 87.5, 0], ['stripe_in_transit', 'p1', 2.5, 0],
    ].map(x => JSON.stringify(x)).sort())
    expect(await active('gam_charge', piece)).toEqual([])
    expect(await balance(co.landlordId, 'due_to_gam')).toBe(0)
    expect(await balance(co.landlordId, 'supplies')).toBe(87.5)
    const c = await db.connect()
    try {
      expect(await dueToGamCheck.run(c, co.owner)).toEqual([])
    } finally { c.release() }
  })

  it('a reader piece a bank pull collected is Supplies on the pull\'s day; a dispute takes it back; one on no property is a company-level cost', async () => {
    const co = await ledgerCompany()
    const sub = await charge(co, 'subscription', 10)
    const piece = await charge(co, 'device_installment', 87.5)
    const companyPiece = await charge(co, 'device_installment', 87.5, { property: null })
    const debit = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids, settled_at)
       VALUES ($1, 185, 0, 185, 'succeeded', $2::uuid[], '2026-09-30 18:00:00+00') RETURNING id`, [co.landlordId, [sub, piece, companyPiece]])).rows[0].id
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, landlord_gam_debit_id, amount) VALUES ($1, $4, 10), ($2, $4, 87.5), ($3, $4, 87.5)`,
      [sub, piece, companyPiece, debit])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    const ls = await active('gam_debit', debit)
    expect(ls.every(l => l.day === '2026-09-30')).toBe(true)
    // The company's piece: the Company column (no choice made — 10/13 (Nic) default).
    expect(byProp(ls, co)).toEqual([
      ['supplies', null, 87.5, 0], ['outstanding_checks', null, 0, 87.5],
      ['due_to_gam', 'p1', 10, 0], ['outstanding_checks', 'p1', 0, 10],
      ['supplies', 'p1', 87.5, 0], ['outstanding_checks', 'p1', 0, 87.5],
    ])
    expect(await balance(co.landlordId, 'supplies')).toBe(175)
    expect(await balance(co.landlordId, 'due_to_gam')).toBe(0)
    // The landlord's bank disputes the pull: the money comes back, so the pieces were not collected after all.
    await db.query(`UPDATE landlord_gam_debits SET disputed_at = '2026-10-05 18:00:00+00', stripe_dispute_id = 'dp_pull',
                                                 dispute_reopened_amount = 185 WHERE id = $1`, [debit])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await balance(co.landlordId, 'supplies')).toBe(0)
    expect(await balance(co.landlordId, 'outstanding_checks')).toBe(0)
    const c = await db.connect()
    try {
      expect(await dueToGamCheck.run(c, co.owner)).toEqual([])
    } finally { c.release() }
  })

  it('the 2080 tie-out counts a cash sale\'s background check against its GAM charge, and finds a charge the ledger is missing', async () => {
    const co = await ledgerCompany()
    await sale(co, { subtotal: 130, screening: 30 })
    await charge(co, 'screening_fee', 30)
    await drainLedgerOutbox()
    const c = await db.connect()
    try {
      expect(await dueToGamCheck.run(c, co.owner)).toEqual([])
      unregisterAll()
      await charge(co, 'subscription', 12)
      const f = await dueToGamCheck.run(c, co.owner)
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ check: 'p5_due_to_gam', severity: 'drift', detail: { difference: -12 } })
    } finally { c.release() }
  })
})
