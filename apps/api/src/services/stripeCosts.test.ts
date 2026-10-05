/**
 * S642 — Nic: "Instead of showing $199 fees from Stripe I want to see our
 * margin on that too."
 *
 * GAM recorded what it charged the tenant and nothing about what Stripe charged
 * GAM, so the platform could show fee revenue and not profit. These pin the two
 * things that made the first cut of it wrong.
 */
import { describe, it, expect } from 'vitest'
import { categorize, parsePeriod, COST_LABELS, COST_CATEGORIES } from './stripeCosts'

describe('S642 categorizing what Stripe charged us', () => {
  it('reads Stripe’s own prose into our categories', () => {
    expect(categorize('Card payments (2026-09-06): Transaction network costs')).toBe('card_interchange')
    expect(categorize('Card payments (2026-09-06): Stripe volume fee')).toBe('stripe_volume_fee')
    expect(categorize('Card payments (2026-09-12): Stripe per-authorization fee')).toBe('per_authorization')
    expect(categorize('Authorization Boost (2026-09-06)')).toBe('authorization_boost')
    expect(categorize('Radar (2026-09-04): Standard')).toBe('radar')
    expect(categorize('Connections Balance Refresh (2026-08-01 - 2026-08-31)')).toBe('bank_linking')
    expect(categorize('Something Stripe has not invented yet')).toBe('other')
  })

  it('every category has a label a human would read', () => {
    for (const c of COST_CATEGORIES) {
      expect(COST_LABELS[c]).toBeTruthy()
      expect(COST_LABELS[c]).not.toBe(c)
    }
  })

  it('attributes a charge to the period it COVERS, not the day it posted', () => {
    // August's bank-linking bill posts on September 1. Billing it to September
    // would overstate that month's cost and understate August's — and at 00:00
    // UTC it is still August in Phoenix, so the posting date was wrong in a way
    // that depended on the server's timezone.
    expect(parsePeriod('Connections Balance Refresh (2026-08-01 - 2026-08-31)'))
      .toEqual({ start: '2026-08-01', end: '2026-08-31' })
  })

  it('a single-day charge is its own period', () => {
    expect(parsePeriod('Card payments (2026-09-06): Transaction network costs'))
      .toEqual({ start: '2026-09-06', end: '2026-09-06' })
  })

  it('no period named → attributed where it posted', () => {
    expect(parsePeriod('Bank debit fee on txn_123')).toEqual({ start: null, end: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 — Nic: "Is that actually accurate?" The math was right; the picture was
// incomplete mid-month. These pin the card's rules.
// ═══════════════════════════════════════════════════════════════════════════
import { beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'
import {
  costLineAmount, splitCents, computeMarginMonths, syncStripeCosts, marginForMonth, marginByMonth, screeningFeeInside,
  splitPlatformBalance, loadPlatformBalanceBook, type MarginInputs, type MarginPaymentInput, type PlatformBalanceBook,
} from './stripeCosts'
import { trueUpProcessingMargin } from './platformRevenue'

/** A book with no dispute in it. */
const NOTHING_TAKEN_BACK = { feesGivenBack: 0, feesChargedToLandlords: 0, chargebackFeesFromPayees: 0, rentNotRepaid: 0, gamLinesTakenBack: 0, feesOwedBackOnWins: 0, chargebacksOwedBackOnWins: 0 }

describe('what one Stripe cost line took off the balance', () => {
  it('a fee Stripe added sales tax to costs what left the balance — the tax included', () => {
    // Connections Balance Refresh, September: amount −12.90, tax 0.85, net −13.75.
    expect(costLineAmount({ amount: -1290, net: -1375 })).toBe(13.75)
    expect(costLineAmount({ amount: -540, net: -540 })).toBe(5.4)
  })
  it('a credit or a reversal is not a cost', () => {
    expect(costLineAmount({ amount: 125, net: 125 })).toBeNull()
    expect(costLineAmount({ amount: 0, net: 0 })).toBeNull()
  })
})

describe('splitting a day\'s card costs across its payments', () => {
  it('splits to the cent with nothing lost or invented', () => {
    const parts = splitCents(2078, [80000, 47665, 91])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(2078)
    expect(parts[0]).toBeGreaterThan(parts[1])
    expect(parts[2]).toBeLessThanOrEqual(2)
  })
  it('a day with only $0 payments still places every cent', () => {
    expect(splitCents(5, [0, 0]).reduce((a, b) => a + b, 0)).toBe(5)
  })
})

describe('the background-check fee inside what the applicant paid', () => {
  it('is 3.5% + $0.55 on what came before it — $2.05 on a $44.99 check', () => {
    expect(screeningFeeInside(44.99)).toBe(2.05)
  })
})

/**
 * One October, built to exercise every rule at once:
 *   - 10/01 (UTC) is posted: two card payments and a register sale share its
 *     costs by size; a September payment made on the Phoenix evening of 9/30
 *     (already 10/01 in UTC) takes its share too, and that share is September's;
 *   - a bank payment that cleared, with Stripe's own fee posted in September;
 *   - a bank payment still clearing, its fee already posted;
 *   - 10/02 is not posted yet (only its volume fee is in): its card payment is
 *     estimated at October's own observed rate, and the partial line is inside
 *     that estimate, never beside it;
 *   - the bank-feed subscription for October.
 */
function october(): MarginInputs {
  const pay = (p: Partial<MarginPaymentInput> & { id: string }): MarginPaymentInput => ({
    kind: 'rent_card', method: 'card', clearing: false, month: '2026-10', day: '2026-10-01',
    at: '2026-10-01T17:00:00Z', amount: 0, fee: 0, paymentIntentId: null, who: p.id, ...p,
  })
  return {
    payments: [
      pay({ id: 'A', amount: 800, fee: 28.55, paymentIntentId: 'pi_A' }),
      pay({ id: 'B', amount: 476.65, fee: 16.65, paymentIntentId: 'pi_B' }),
      pay({ id: 'C', kind: 'register_card', amount: 0.91, fee: 0.56, paymentIntentId: 'pi_C' }),
      pay({ id: 'H', month: '2026-09', at: '2026-10-01T03:44:00Z', amount: 558.42, fee: 19.42, paymentIntentId: 'pi_H' }),
      pay({ id: 'F', kind: 'rent_bank', method: 'bank', amount: 526.20, fee: 6, paymentIntentId: 'pi_F', day: '2026-09-07' }),
      pay({ id: 'E', kind: 'rent_bank', method: 'bank', clearing: true, amount: 466, fee: 6, paymentIntentId: 'pi_E' }),
      pay({ id: 'G', day: '2026-10-02', at: '2026-10-02T15:51:00Z', amount: 485.09, fee: 16.94, paymentIntentId: 'pi_G' }),
    ],
    costs: [
      { id: 'c1', category: 'card_interchange', amount: 18, month: '2026-10', day: '2026-10-01', paymentIntentId: null },
      { id: 'c2', category: 'stripe_volume_fee', amount: 12.84, month: '2026-10', day: '2026-10-01', paymentIntentId: null },
      { id: 'c3', category: 'per_authorization', amount: 1.04, month: '2026-10', day: '2026-10-01', paymentIntentId: null },
      { id: 'c4', category: 'stripe_volume_fee', amount: 3.42, month: '2026-10', day: '2026-10-02', paymentIntentId: null },
      { id: 'c5', category: 'bank_debit_fee', amount: 2.63, month: '2026-09', day: null, paymentIntentId: 'pi_F' },
      { id: 'c6', category: 'bank_debit_fee', amount: 2.33, month: '2026-10', day: null, paymentIntentId: 'pi_E' },
      { id: 'c7', category: 'bank_linking', amount: 13.75, month: '2026-10', day: null, paymentIntentId: null },
    ],
    bankCost: { pct: 0.5, flat: 0, cap: 3 },
    cardFallback: { pct: 0.029, flat: 0.26 },
  }
}

describe('the Processing Margin card, payment by payment (10/3)', () => {
  const [oct, sep] = computeMarginMonths(october(), ['2026-10', '2026-09'])
  const row = (id: string) => [...oct.payments!, ...sep.payments!].find(p => p.id === id)!

  it('a posted day\'s card costs are split across that day\'s card payments by size — the register sale included — to the cent', () => {
    const shares = ['A', 'B', 'C', 'H'].map(id => row(id).stripeCost)
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100)).toBe(3188)       // 18 + 12.84 + 1.04
    expect(row('A').costBasis).toBe('day_share')
    expect(row('C').costBasis).toBe('day_share')
    expect(row('A').stripeCost).toBeGreaterThan(row('B').stripeCost)
    expect(row('C').stripeCost).toBeLessThan(0.05)
    expect(row('C').kindLabel).toBe('Register card sale')
    // 10/3 (review): one payment's part of a day's total is an estimate, and is labeled one.
    expect(row('A').costBasisLabel).toMatch(/^Estimate: /)
  })

  it('a payment made on a Phoenix evening shares its UTC day\'s costs, and its share is its own month\'s', () => {
    expect(row('H').costBasis).toBe('day_share')
    expect(sep.feeRevenue).toBe(19.42)
    expect(sep.stripeCost).toBe(row('H').stripeCost)
  })

  it('a bank payment that cleared shows Stripe\'s own fee on it, in the month it cleared', () => {
    expect(row('F').costBasis).toBe('exact')
    expect(row('F').stripeCost).toBe(2.63)
    expect(row('F').gamKeeps).toBe(3.37)
  })

  it('a bank payment still clearing is not earned yet: its fee and its Stripe fee sit apart as "still clearing"', () => {
    expect(row('E').clearing).toBe(true)
    expect(oct.clearing).toEqual({ count: 1, amount: 466, fees: 6, stripeCost: 2.33 })
    // Not in the month's revenue, nor its cost.
    expect(oct.feeRevenue).toBe(68.70)                        // 28.55 + 16.65 + 0.56 + 6 + 16.94
    expect(oct.byCategory.find(c => c.category === 'bank_debit_fee')?.amount).toBe(2.63)
  })

  it('a card day Stripe has not posted is estimated at the month\'s own observed rate, labeled, and its partial line is not counted beside it', () => {
    const observed = ['A', 'B', 'C'].reduce((a, id) => a + row(id).stripeCost, 0) / (800 + 476.65 + 0.91)
    expect(row('G').costBasis).toBe('estimate_unposted')
    expect(row('G').costBasisLabel).toBe('Estimate until Stripe posts')
    expect(row('G').stripeCost).toBeCloseTo(485.09 * observed, 2)
    expect(oct.estimatedCost).toBe(row('G').stripeCost)
    expect(oct.estimateDays).toEqual(['2026-10-02'])
    expect(oct.byCategory.find(c => c.category === 'card_costs_not_posted')?.label).toBe('Card costs Stripe has not posted yet (estimate)')
    // The 10/02 volume fee that did arrive is inside the estimate: nowhere else.
    expect(oct.notTiedToAPayment.find(c => c.category === 'stripe_volume_fee')).toBeUndefined()
  })

  it('the bank-feed charges are a GAM cost on the card (Nic 10/3), not tied to one payment', () => {
    expect(oct.bankFeedCost).toBe(13.75)
    expect(oct.notTiedToAPayment).toEqual([{ category: 'bank_linking', label: 'Bank feeds (Financial Connections)', amount: 13.75 }])
  })

  it('the list adds up to the card: fees to fee revenue, Stripe costs plus the month\'s untied charges to "Stripe took"', () => {
    const cleared = oct.payments!.filter(p => !p.clearing)
    const fees = Math.round(cleared.reduce((a, p) => a + p.feeCharged, 0) * 100)
    const costs = Math.round(cleared.reduce((a, p) => a + p.stripeCost, 0) * 100) + Math.round(oct.notTiedTotal * 100)
    expect(fees).toBe(Math.round(oct.feeRevenue * 100))
    expect(costs).toBe(Math.round(oct.stripeCost * 100))
    expect(Math.round(oct.byCategory.reduce((a, c) => a + c.amount, 0) * 100)).toBe(Math.round(oct.stripeCost * 100))
    expect(oct.margin).toBe(Math.round((oct.feeRevenue - oct.stripeCost) * 100) / 100)
    // Every dollar of the posted day once, across both months.
    const allCosts = [...oct.payments!, ...sep.payments!].filter(p => !p.clearing).reduce((a, p) => a + p.stripeCost, 0)
    expect(Math.round((allCosts + oct.notTiedTotal + sep.notTiedTotal) * 100))
      .toBe(Math.round((31.88 + 2.63 + 13.75 + row('G').stripeCost) * 100))
  })

  it('each rail is named in words, never a raw value', () => {
    expect(oct.byRail.map(r => r.label)).toEqual(expect.arrayContaining(['Card payment', 'Register card sale', 'Bank payment']))
  })

  it('a bank payment made last month and still clearing shows on this month\'s card as clearing from earlier months', () => {
    const inp = october()
    inp.payments.push({ id: 'S', kind: 'rent_bank', method: 'bank', clearing: true, month: '2026-09', day: '2026-09-30',
      at: '2026-09-30T20:00:00Z', amount: 563.79, fee: 6, paymentIntentId: 'pi_S', who: 'S' })
    inp.costs.push({ id: 'cS', category: 'bank_debit_fee', amount: 2.82, month: '2026-09', day: null, paymentIntentId: 'pi_S' })
    const [o, sp] = computeMarginMonths(inp, ['2026-10', '2026-09'])
    expect(o.clearing).toEqual({ count: 1, amount: 466, fees: 6, stripeCost: 2.33 })
    expect(o.clearingEarlier).toEqual({ count: 1, amount: 563.79, fees: 6, stripeCost: 2.82 })
    // It is September's payment: in September's list, and in neither month's revenue or cost.
    expect(sp.clearing.count).toBe(1)
    expect(sp.payments!.find(p => p.id === 'S')!.clearing).toBe(true)
    expect(o.feeRevenue).toBe(68.70)
    expect(sp.byCategory.find(c => c.category === 'bank_debit_fee')).toBeUndefined()
  })

  it('a bank payment still clearing that Stripe has not posted a fee for is estimated at Stripe\'s bank price', () => {
    const inp = october()
    inp.costs = inp.costs.filter(c => c.id !== 'c6')
    const [m] = computeMarginMonths(inp, ['2026-10'])
    const e = m.payments!.find(p => p.id === 'E')!
    expect(e.costBasis).toBe('estimate_unposted')
    expect(e.stripeCost).toBe(2.33)                             // 0.5% of $466
    expect(m.clearing.stripeCost).toBe(2.33)
  })
})

describe('the Processing Margin card through disputes and returned payments (10/4 review, fix pass 1)', () => {
  // October's payment B ($16.65 fee on top) is disputed on Nov 3: the fee goes
  // back to the payer, the landlord repays it off their payout, and Stripe's
  // $15 dispute fee posts that day. The tenant pays the $15 billed to them on Nov 10.
  const inp = (): MarginInputs => {
    const m = october()
    m.costs.push({ id: 'du', category: 'other', amount: 15, month: '2026-11', day: null, paymentIntentId: null })
    m.feesBack = [
      { id: 'g', kind: 'fee_given_back', month: '2026-11', at: '2026-11-03T18:00:00Z', amount: -16.65, who: 'B', paymentIntentId: 'pi_B' },
      { id: 'l', kind: 'fee_charged_to_landlord', month: '2026-11', at: '2026-11-03T18:00:00Z', amount: 16.65, who: 'Off Oak\'s payout', paymentIntentId: 'pi_B' },
      { id: 'r', kind: 'billed_fee_paid', month: '2026-11', at: '2026-11-10T18:00:00Z', amount: 15, who: 'Returned-payment fee · B', paymentIntentId: null },
    ]
    return m
  }

  it('what came back for a dispute counts in the month it came back, inside the margin, so the $15 Stripe charged is not GAM\'s loss', () => {
    const [nov, oct] = computeMarginMonths(inp(), ['2026-11', '2026-10'])
    expect(nov.stripeCost).toBe(15)
    expect(nov.feesBack.total).toBe(15)
    expect(nov.feesBack.byKind.map(k => [k.kind, k.amount, k.count])).toEqual([
      ['fee_given_back', -16.65, 1], ['fee_charged_to_landlord', 16.65, 1], ['billed_fee_paid', 15, 1],
    ])
    expect(nov.feesBack.byKind[0].label).toBe('Fees on top that went back to payers in disputes')
    expect(nov.margin).toBe(0)
    // October's figures are what they were; nothing moved back into it.
    const plain = computeMarginMonths(october(), ['2026-10'])[0]
    expect(oct.margin).toBe(plain.margin)
    expect(oct.feesBack).toEqual({ total: 0, byKind: [], items: [] })
  })

  it('the disputed payment is marked on its own month\'s list with the fee that went back, its own figures unchanged', () => {
    const [, oct] = computeMarginMonths(inp(), ['2026-11', '2026-10'])
    const b = oct.payments!.find(p => p.id === 'B')!
    const plain = computeMarginMonths(october(), ['2026-10'])[0].payments!.find(p => p.id === 'B')!
    expect(b).toMatchObject({ disputed: true, feeGivenBack: 16.65, gamKeeps: plain.gamKeeps, feeCharged: 16.65 })
    expect(oct.payments!.find(p => p.id === 'A')).toMatchObject({ disputed: false, feeGivenBack: 0 })
  })

  it('the list adds up to the card with the disputes in it', () => {
    const [nov] = computeMarginMonths(inp(), ['2026-11'])
    const cleared = nov.payments!.filter(p => !p.clearing)
    const kept = cleared.reduce((a, p) => a + Math.round(p.gamKeeps * 100), 0) - Math.round(nov.notTiedTotal * 100)
      + (nov.feesBack.items ?? []).reduce((a, f) => a + Math.round(f.amount * 100), 0)
    expect(kept).toBe(Math.round(nov.margin * 100))
  })
})

describe('recording what Stripe charged GAM (10/3)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
  })

  const fakeStripe = (byType: Record<string, any[]>) => ({
    balanceTransactions: { list: async (p: any) => ({ data: byType[p.type] ?? [], has_more: false }) },
  }) as any

  it('stores a fee line at what left the balance, sales tax included, and corrects a line stored without it', async () => {
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, description, amount, posted_at, period_start, period_end)
       VALUES ('txn_tax', 'stripe_fee', 'bank_linking', 'Connections Balance Refresh (2026-09-01 - 2026-09-30)', 12.90, NOW(), '2026-09-01', '2026-09-30')`)
    const stripe = fakeStripe({
      stripe_fee: [
        { id: 'txn_tax', amount: -1290, fee: 85, net: -1375, created: 1790000000, description: 'Connections Balance Refresh (2026-09-01 - 2026-09-30)' },
        { id: 'txn_boost', amount: -293, fee: 19, net: -312, created: 1790000000, description: 'Authorization Boost (2026-10-01)' },
      ],
    })
    const r = await syncStripeCosts({ stripe })
    expect(r).toMatchObject({ stored: 1, updated: 1 })
    const rows = (await db.query<{ stripe_txn_id: string; amount: string }>(
      `SELECT stripe_txn_id, amount::text AS amount FROM stripe_processing_costs ORDER BY stripe_txn_id`)).rows
    expect(rows).toEqual([{ stripe_txn_id: 'txn_boost', amount: '3.12' }, { stripe_txn_id: 'txn_tax', amount: '13.75' }])
    // Running it again changes nothing.
    expect(await syncStripeCosts({ stripe })).toMatchObject({ stored: 0, updated: 0, skipped: 2 })
  })

  it('ties a bank payment\'s fee to the payment it came from', async () => {
    const stripe = fakeStripe({
      payment: [{ id: 'txn_ach', amount: 46600, fee: 233, net: 46367, created: 1790000000,
                  source: { id: 'py_1', object: 'charge', payment_intent: 'pi_fierro' } }],
    })
    await syncStripeCosts({ stripe })
    const [row] = (await db.query<any>(`SELECT stripe_txn_id, category, amount::text AS amount, stripe_payment_intent_id FROM stripe_processing_costs`)).rows
    expect(row).toEqual({ stripe_txn_id: 'txn_ach:fee', category: 'bank_debit_fee', amount: '2.33', stripe_payment_intent_id: 'pi_fierro' })
  })
})

describe('the month, read from GAM\'s records (10/3)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
  })

  it('lists rent, a register sale and a clearing bank payment, and the list adds up to the card', async () => {
    const c = await db.connect()
    let landlordId = '', userId = '', tenantId = ''
    try {
      ({ landlordId, userId } = await seedLandlord(c))
      tenantId = await seedTenant(c)
    } finally { c.release() }
    const remit = (status: string, method: string, amount: number, fee: number, pi: string, at: string) => db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, $3::numeric, $3::numeric, $4::text, $5, $3::numeric + $6::numeric, $6::numeric, $7, $8::timestamptz,
               CASE WHEN $4::text = 'settled' THEN $8::timestamptz END)`,
      [tenantId, landlordId, amount, status, method, fee, pi, at])
    await remit('settled', 'card', 460, 16.65, 'pi_card', '2026-10-01T22:43:00Z')
    await remit('processing', 'ach', 460, 6, 'pi_bank', '2026-10-01T14:56:00Z')
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 'card', 0.33, 0.02, 0.56, 0.91, 0.56, 'pi_reg', '2026-10-01T22:17:00Z')`, [landlordId, userId])
    // A cash sale is free and never on the card.
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, created_at)
       VALUES ($1, $2, 'cash', 20, 20, '2026-10-01T22:30:00Z')`, [landlordId, userId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end, stripe_payment_intent_id)
       VALUES ('n1', 'network_cost', 'card_interchange', 6.00, '2026-10-02T12:00:00Z', '2026-10-01', '2026-10-01', NULL),
              ('v1', 'stripe_fee', 'stripe_volume_fee', 3.23, '2026-10-02T05:00:00Z', '2026-10-01', '2026-10-01', NULL),
              ('b1:fee', 'payment', 'bank_debit_fee', 2.33, '2026-10-01T20:53:00Z', NULL, NULL, 'pi_bank')`)

    const m = await marginForMonth('2026-10')
    expect(m.feeRevenue).toBe(17.21)                     // card 16.65 + register 0.56; the bank fee is still clearing
    expect(m.stripeCost).toBe(9.23)                      // the posted day, split across both card payments
    expect(m.clearing).toEqual({ count: 1, amount: 466, fees: 6, stripeCost: 2.33 })
    const kinds = m.payments!.map(p => `${p.kindLabel}${p.clearing ? ' (clearing)' : ''}`).sort()
    expect(kinds).toEqual(['Bank payment (clearing)', 'Card payment', 'Register card sale'])
    const cleared = m.payments!.filter(p => !p.clearing)
    expect(Math.round(cleared.reduce((a, p) => a + p.stripeCost, 0) * 100) + Math.round(m.notTiedTotal * 100)).toBe(923)
    expect(m.payments!.find(p => p.kind === 'register_card')!.who).toContain('Register sale')
  })
})

describe('GAM\'s own money: the Stripe balance, split by whose it is (10/3)', () => {
  /**
   * Production on 10/3, 14:24: $4,210.52 on the balance. Of it, $2,873.97 was
   * owed to landlords, two bank payments still clearing had put $1,024.64 on
   * it ($1,017.79 of it the landlords', $6.85 GAM's fees after Stripe's
   * $5.15), and $75.88 was applicants' background-check money for Checkr.
   */
  const book = (): PlatformBalanceBook => ({
    ownerSharesOwed: 2869.72, heldItemsOwed: 4.25, payoutsReserved: 0, depositsInTrust: 0,
    managerPmCutsOwed: 0, paidAheadHeld: 0, checkrHeld: 75.88,
    clearing: [
      { kind: 'tenant_payment', id: 'fierro', paymentIntentId: 'pi_f', method: 'bank', createdAt: '2026-10-01T15:00:00Z', othersShare: 460, gamFee: 6, gross: 466, who: 'Mireya Fierro' },
      { kind: 'tenant_payment', id: 'cox', paymentIntentId: 'pi_c', method: 'bank', createdAt: '2026-10-01T15:00:00Z', othersShare: 557.79, gamFee: 6, gross: 563.79, who: 'Randall Cox' },
      { kind: 'tenant_payment', id: 'troy', paymentIntentId: 'pi_t', method: 'bank', createdAt: '2026-10-01T15:00:00Z', othersShare: 541.5, gamFee: 6, gross: 547.5, who: 'Troy Street' },
    ],
    heldPayLinkPayments: 0,
    collected: { processingFees: 341.51, registerCardFees: 2.83, screeningKept: 14.10, landlordChargesCollected: 136, flexpayKept: 0, sweptIn: 10.33, keptFeesRecovered: 0, gamOwnedBillLines: 0,
                 tenantPaidPlatformFees: 0, stayDepositFees: 0, businessPaymentFees: 0, businessInvoicingFees: 0 },
    gamOwnedBillLinesByKind: [], takenBack: NOTHING_TAKEN_BACK,
    stripeCostsRecorded: 267.53, flexpayFronted: 0, recordedTxnIds: [], owedByLandlordsUncollected: 160,
  })
  const live = () => ({
    available: 206.92, pending: 4003.60, paidOutToGamBank: 1.21, costsNotYetRecorded: 0,
    clearingOnBalance: { pi_f: { net: 463.67, fee: 2.33 }, pi_c: { net: 560.97, fee: 2.82 } },
  })

  it('names GAM\'s own as what is left after landlords, clearing payments and Checkr — $236.03 on 10/3, not $1,336.55', () => {
    const s = splitPlatformBalance(book(), live())
    expect(s.onBalance).toBe(4210.52)
    expect(s.gamsOwn).toBe(236.03)
    // The 10/3 reconciliation: $318.76 = GAM's own + the clearing fees' net + Checkr.
    expect(Math.round((s.gamsOwn! + (s.clearing.netOnBalance - s.clearing.landlordsOnBalance) + s.checkrHeld) * 100)).toBe(31876)
  })

  it('a clearing bank payment counts only once Stripe has put it on the balance; its fees are not GAM\'s yet', () => {
    const s = splitPlatformBalance(book(), live())
    expect(s.clearing.landlordsOnBalance).toBe(1017.79)
    expect(s.clearing.landlordsNotYetOnBalance).toBe(541.5)       // Troy: not on the balance, not subtracted
    expect(s.clearing.gamFees).toBe(18)
    expect(s.clearing.stripeTook).toBe(5.15)
    expect(s.clearing.netOnBalance).toBe(1024.64)
  })

  it('both cards read GAM\'s clearing money on one basis: $18.00 in all = $6.85 on the balance after Stripe\'s $5.15 + $6.00 not on it yet', () => {
    const s = splitPlatformBalance(book(), live())
    expect(s.clearing.gamTotal).toBe(18)
    expect(s.clearing.gamOnBalance).toBe(6.85)        // the figure both cards show
    expect(s.clearing.gamNotYetOnBalance).toBe(6)     // Troy: Stripe has not recorded it
    expect(Math.round((s.clearing.gamOnBalance + s.clearing.stripeTook + s.clearing.gamNotYetOnBalance) * 100))
      .toBe(Math.round(s.clearing.gamTotal * 100))
    // What the clearing payments put on the balance: the landlords' part and GAM's part, nothing else.
    expect(Math.round((s.clearing.landlordsOnBalance + s.clearing.gamOnBalance) * 100)).toBe(Math.round(s.clearing.netOnBalance * 100))
  })

  it('a GAM-fee debit still clearing is GAM\'s money all through, on the same basis as a tenant\'s fee', () => {
    const b = book()
    b.clearing.push({ kind: 'gam_fee_debit', id: 'oak', paymentIntentId: 'pi_d', method: 'bank', createdAt: '2026-10-01T15:00:00Z', othersShare: 0, gamFee: 6, gross: 88, who: 'GAM fees pulled from Oak Park' })
    const l = live()
    l.clearingOnBalance = { ...l.clearingOnBalance, pi_d: { net: 87.56, fee: 0.44 } } as any
    l.pending += 87.56
    const s = splitPlatformBalance(b, l)
    expect(s.clearing.gamOnBalance).toBe(94.41)       // 6.85 + all of the debit after Stripe's 0.44
    expect(s.clearing.gamTotal).toBe(106)
    expect(Math.round((s.clearing.gamOnBalance + s.clearing.stripeTook + s.clearing.gamNotYetOnBalance) * 100)).toBe(10600)
    expect(s.gamsOwn).toBe(236.03)                    // not counted until it clears
  })

  it('a returned-payment fee a tenant paid is GAM\'s on both sides of the check, so the check still ties', () => {
    // The tenant pays the $4 fee GAM charged for a bounced bank payment. It has
    // no landlord share, so it is GAM's on the balance; the records add it too.
    const paid = { ...book(), collected: { ...book().collected, gamOwnedBillLines: 4 },
                   gamOwnedBillLinesByKind: [{ kind: 'return_fee' as const, label: 'Returned bank payment fees', amount: 4 }] }
    const s = splitPlatformBalance(paid, { ...live(), pending: 4003.60 + 4 })
    expect(s.gamsOwn).toBe(240.03)
    expect(s.reconciliation).toMatchObject({ collected: 508.77, gap: 0 })
    expect(s.reconciliation!.gamOwnedBillLinesByKind).toEqual([{ kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 }])
    // Without it on the records side the same $4 read as a gap.
    const before = splitPlatformBalance(book(), { ...live(), pending: 4003.60 + 4 })
    expect(before.reconciliation!.gap).toBe(4)
  })

  it('background-check money is Checkr\'s, on its own line, never in the headline', () => {
    const s = splitPlatformBalance(book(), live())
    expect(s.checkrHeld).toBe(75.88)
    const withoutCheckr = splitPlatformBalance({ ...book(), checkrHeld: 0 }, live())
    expect(Math.round((withoutCheckr.gamsOwn! - s.gamsOwn!) * 100)).toBe(7588)
  })

  it('checks itself against GAM\'s records: collected less Stripe\'s costs less what went to GAM\'s bank, to the cent', () => {
    const s = splitPlatformBalance(book(), live())
    expect(s.reconciliation).toMatchObject({ collected: 504.77, book: 236.03, onBalance: 236.03, gap: 0 })
  })

  it('a gap shows with its amount — Stripe sales tax GAM never recorded reads as $2.46', () => {
    const s = splitPlatformBalance({ ...book(), stripeCostsRecorded: 267.53 - 2.46 }, live())
    expect(s.reconciliation!.gap).toBe(-2.46)
  })

  it('Stripe charges not recorded yet (GAM records them nightly) are on the book side, so they never read as a gap', () => {
    const s = splitPlatformBalance({ ...book(), stripeCostsRecorded: 267.53 - 5.40 }, { ...live(), costsNotYetRecorded: 5.40 })
    expect(s.reconciliation!.gap).toBe(0)
  })

  it('managers\' and PM companies\' unpaid cuts are not GAM\'s', () => {
    const s = splitPlatformBalance({ ...book(), managerPmCutsOwed: 40 }, live())
    expect(s.gamsOwn).toBe(196.03)
  })

  it('a pay-link payment GAM holds for the landlord to refund is not GAM\'s, and the check still ties', () => {
    // A $50 duplicate lands; Stripe's cost of the charge ($1.80) is in its day's card costs, recorded.
    const s = splitPlatformBalance(
      { ...book(), heldPayLinkPayments: 50, stripeCostsRecorded: 267.53 + 1.80 },
      { ...live(), pending: 4003.60 + 50 - 1.80 })
    expect(s.heldPayLinkPayments).toBe(50)
    expect(s.gamsOwn).toBe(234.23)                      // GAM is out Stripe's cost until the landlord's refund repays it
    expect(s.reconciliation!.gap).toBe(0)
  })

  it('after the landlord refunds it, Stripe\'s kept fee taken back from their payout is GAM\'s money back — still no gap', () => {
    const s = splitPlatformBalance(
      { ...book(), heldPayLinkPayments: 0, heldItemsOwed: 4.25 - 1.80, stripeCostsRecorded: 267.53 + 1.80,
        collected: { ...book().collected, keptFeesRecovered: 1.80 } },
      { ...live(), pending: 4003.60 + 50 - 1.80 - 50 })
    expect(s.gamsOwn).toBe(236.03)
    expect(s.reconciliation!.gap).toBe(0)
  })

  it('with Stripe unreachable there is no headline, never a guess', () => {
    const s = splitPlatformBalance(book(), null)
    expect(s.gamsOwn).toBeNull()
    expect(s.reconciliation).toBeNull()
    expect(s.checkrHeld).toBe(75.88)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (review): a cost tied to a payment rides with that payment, in the
// month the payment counts — never a second time as a month's charge "not tied
// to a payment". Bank payments here take 5-7 days to clear, so every month-end
// has some made in one month and cleared in the next.
// ═══════════════════════════════════════════════════════════════════════════
describe('a payment made late in one month and cleared in the next (10/3 review)', () => {
  let landlordId = '', tenantId = ''
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    const c = await db.connect()
    try {
      ({ landlordId } = await seedLandlord(c))
      tenantId = await seedTenant(c)
    } finally { c.release() }
    const remit = (status: string, method: string, amount: number, fee: number, pi: string, at: string, settled: string | null) => db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, $3::numeric, $3::numeric, $4::text, $5, $3::numeric + $6::numeric, $6::numeric, $7, $8::timestamptz, $9::timestamptz)`,
      [tenantId, landlordId, amount, status, method, fee, pi, at, settled])
    // September: one card payment, its day posted.
    await remit('settled', 'card', 460, 16.65, 'pi_sep_card', '2026-09-15T18:00:00Z', '2026-09-15T18:00:00Z')
    // Randall Cox: made Sep 28, cleared Oct 6. Stripe posted its $2.63 fee Sep 28.
    await remit('settled', 'ach', 520.20, 6, 'pi_cox', '2026-09-28T15:00:00Z', '2026-10-06T15:00:00Z')
    // GAM's own fees pulled from the landlord's bank: made Sep 29, cleared Oct 4.
    await db.query(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status,
                                        stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, 82, 6, 88, 'succeeded', 'pi_debit', '2026-09-29T15:00:00Z', '2026-10-04T15:00:00Z')`, [landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end, stripe_payment_intent_id)
       VALUES ('n_sep15', 'network_cost', 'card_interchange', 6.00, '2026-09-16T12:00:00Z', '2026-09-15', '2026-09-15', NULL),
              ('v_sep15', 'stripe_fee', 'stripe_volume_fee', 3.23, '2026-09-16T05:00:00Z', '2026-09-15', '2026-09-15', NULL),
              ('txn_cox:fee', 'payment', 'bank_debit_fee', 2.63, '2026-09-28T20:00:00Z', NULL, NULL, 'pi_cox'),
              ('txn_debit:fee', 'payment', 'bank_debit_fee', 0.44, '2026-09-29T20:00:00Z', NULL, NULL, 'pi_debit')`)
  })

  const tookOnList = (m: Awaited<ReturnType<typeof marginForMonth>>) =>
    Math.round(m.payments!.filter(p => !p.clearing).reduce((a, p) => a + p.stripeCost, 0) * 100 + m.notTiedTotal * 100) / 100

  it('September\'s list says what September\'s card says Stripe took', async () => {
    const sepList = await marginForMonth('2026-09')
    const sepCard = (await marginByMonth(2, { now: '2026-10' })).find(r => r.month === '2026-09')!
    expect(sepCard.stripeCost).toBe(9.23)
    expect(sepList.stripeCost).toBe(9.23)
    expect(tookOnList(sepList)).toBe(9.23)
    expect(sepList.notTiedToAPayment).toEqual([])
  })

  it('the bank fee — a tenant\'s or a GAM-fee debit\'s — counts only in October, tied to its payment', async () => {
    const oct = await marginForMonth('2026-10')
    const octCard = (await marginByMonth(2, { now: '2026-10' })).find(r => r.month === '2026-10')!
    const cox = oct.payments!.find(p => p.kind === 'rent_bank')!
    const debit = oct.payments!.find(p => p.kind === 'landlord_fee_debit')!
    expect(cox).toMatchObject({ stripeCost: 2.63, costBasis: 'exact', feeCharged: 6, gamKeeps: 3.37, clearing: false })
    expect(debit).toMatchObject({ stripeCost: 0.44, costBasis: 'exact', feeCharged: 6, clearing: false })
    expect(oct.stripeCost).toBe(3.07)
    expect(octCard.stripeCost).toBe(3.07)
    expect(oct.feeRevenue).toBe(12)
    expect(tookOnList(oct)).toBe(3.07)
  })

  it('September\'s and October\'s true-ups together take each Stripe fee off once', async () => {
    const sep = await trueUpProcessingMargin('2026-09-01')
    const oct = await trueUpProcessingMargin('2026-10-01')
    expect(sep.stripeCost).toBe(9.23)
    expect(oct.stripeCost).toBe(3.07)
    expect(Math.round((sep.stripeCost + oct.stripeCost) * 100)).toBe(Math.round((6 + 3.23 + 2.63 + 0.44) * 100))
  })

  it('a cost tied to a payment from another month (posted late) rides with that payment, not this month', async () => {
    // A fee Stripe posted on Sep 10 for an August payment: September never counts it.
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, 300, 300, 'settled', 'ach', 306, 6, 'pi_aug', '2026-08-20T15:00:00Z', '2026-08-26T15:00:00Z')`,
      [tenantId, landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_aug:fee', 'payment', 'bank_debit_fee', 1.50, '2026-09-10T20:00:00Z', 'pi_aug')`)
    const sep = await marginForMonth('2026-09')
    expect(sep.stripeCost).toBe(9.23)
    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.amount === 306)).toMatchObject({ stripeCost: 1.5, costBasis: 'exact' })
    const wide = await marginByMonth(3, { now: '2026-10' })
    expect(wide.find(r => r.month === '2026-09')!.stripeCost).toBe(9.23)
    expect(wide.find(r => r.month === '2026-08')!.stripeCost).toBe(1.5)
  })

  it('a card receipt that never went through Stripe is not a GAM processing payment', async () => {
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, 200, 200, 'settled', 'card', 200, 0, NULL, '2026-09-16T15:00:00Z', '2026-09-16T15:00:00Z')`,
      [tenantId, landlordId])
    const sep = await marginForMonth('2026-09')
    expect(sep.payments!.map(p => p.amount)).toEqual([476.65])
  })
})

describe('GAM\'s records of held pay-link payments (10/3 review)', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('reads what GAM holds for landlords to refund, and the kept fees taken back on refunded ones', async () => {
    const c = await db.connect()
    let landlordId = ''
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    await db.query(
      `INSERT INTO pos_held_payments (landlord_id, stripe_payment_intent_id, reason, amount, status, stripe_refund_id, refunded_at, stripe_fee_kept)
       VALUES ($1, 'pi_held', 'paid_twice', 50, 'held', NULL, NULL, NULL),
              ($1, 'pi_refunded', 'wrong_amount', 30, 'refunded', 're_1', NOW(), 1.17)`, [landlordId])
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1, 'refund', 're_1', -1.17, 'Stripe''s processing fee kept on a refunded pay-link payment'),
              ($1, 'refund', 're_other', -4.00, 'some other refund line')`, [landlordId])
    const book = await loadPlatformBalanceBook()
    expect(book.heldPayLinkPayments).toBe(50)
    expect(book.collected.keptFeesRecovered).toBe(1.17)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (review): lines on a tenant's bill that are GAM's own (a returned bank
// payment's fee, a GAM subscription) have no landlord share. The balance side
// always counted them as GAM's; the records side now adds them too.
// ═══════════════════════════════════════════════════════════════════════════
describe('GAM\'s own bill lines on the records side of the check (10/3 review)', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('counts what Stripe collected onto the balance, kind by kind — never a desk payment, never FlexPay\'s pull', async () => {
    const c = await db.connect()
    let landlordId = '', tenantId = ''
    try { ({ landlordId } = await seedLandlord(c)); tenantId = await seedTenant(c) } finally { c.release() }
    const pay = async (entry: string, type: string, amount: number, owner: string, extra: { status?: string; pi?: string | null; manual?: string | null } = {}) =>
      (await db.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, revenue_owner,
                               stripe_payment_intent_id, manual_method, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-10-01', $7, $8, $9, NOW()) RETURNING id`,
        [landlordId, tenantId, type, amount, extra.status ?? 'settled', entry, owner, extra.pi ?? null, extra.manual ?? null])).rows[0].id
    const remit = async (status: string, amount: number, fee: number, pi: string, lines: Array<[string, number]>) => {
      const { rows: [r] } = await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                         gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
         VALUES ($1, $2, $3::numeric, $3::numeric, $4::text, 'ach', $3::numeric + $5::numeric, $5::numeric, $6, NOW(),
                 CASE WHEN $4::text = 'settled' THEN NOW() END) RETURNING id`,
        [tenantId, landlordId, amount, status, fee, pi])
      for (const [paymentId, applied] of lines) {
        await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`, [r.id, paymentId, applied])
      }
    }
    // Rent and a $4 returned-payment fee, paid together by bank: the fee is GAM's.
    const rent = await pay('RENT', 'rent', 460, 'landlord')
    const returnFee = await pay('RETURNFEE', 'fee', 4, 'gam')
    await remit('settled', 464, 6, 'pi_rent_and_fee', [[rent, 460], [returnFee, 4]])
    // A FlexDeposit custody fee charged on its own.
    await pay('SUBSCRIP', 'fee', 3, 'gam', { pi: 'pi_custody' })
    // Paid at the desk: never on the balance.
    await pay('SUBSCRIP', 'fee', 3, 'gam', { manual: 'cash' })
    // FlexPay's pull: its $25 and its rent are on their own lines of the check.
    await pay('FLEXPAY', 'fee', 485, 'gam', { pi: 'pi_flexpay' })
    // Still clearing: rent and another returned-payment fee — the fee is GAM's, not the landlord's.
    const rent2 = await pay('RENT', 'rent', 500, 'landlord', { status: 'processing' })
    const returnFee2 = await pay('RETURNFEE', 'fee', 4, 'gam', { status: 'processing' })
    await remit('processing', 504, 6, 'pi_clearing', [[rent2, 500], [returnFee2, 4]])

    const book = await loadPlatformBalanceBook()
    expect(book.collected.gamOwnedBillLines).toBe(7)
    expect(book.gamOwnedBillLinesByKind).toEqual([
      { kind: 'return_fee', label: 'Returned bank payment fees', amount: 4 },
      { kind: 'subscription', label: 'GAM subscriptions tenants paid (FlexDeposit custody, FlexCredit)', amount: 3 },
    ])
    expect(book.clearing.find(i => i.paymentIntentId === 'pi_clearing')).toMatchObject({ othersShare: 500, gamFee: 10, gross: 510 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// S653 (Nic): "any demo money should not be billed. It should not exist in the
// system at all." 10/3 (review): the card counted a demo account's fees, and
// the true-up — the card's own figure — then put them on the book anyway.
// ═══════════════════════════════════════════════════════════════════════════
describe('demo and GAM-internal accounts on the Processing Margin card (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('a demo account\'s card sale and rent are on neither the card nor the true-up; a renter-pool background check is', async () => {
    const c = await db.connect()
    let real: { landlordId: string; userId: string }, demo: { landlordId: string; userId: string }, pool: { landlordId: string; userId: string }
    let tenantId = ''
    try {
      real = await seedLandlord(c); demo = await seedLandlord(c); pool = await seedLandlord(c)
      tenantId = await seedTenant(c)
    } finally { c.release() }
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [demo.landlordId])
    await db.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [pool.landlordId])
    const sale = (l: { landlordId: string; userId: string }, pi: string) => db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 'card', 3.30, 0.22, 0.67, 4.19, 0.67, $3, '2026-08-02T18:00:00Z')`, [l.landlordId, l.userId, pi])
    await sale(real!, 'pi_real_sale')
    await sale(demo!, 'pi_demo_sale')
    await sale(pool!, 'pi_system_sale')
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, 460, 460, 'settled', 'card', 476.65, 16.65, 'pi_demo_rent', '2026-08-02T18:00:00Z', '2026-08-02T18:00:00Z')`,
      [tenantId, demo!.landlordId])
    // An applicant paying through GAM's renter pool: anchored at GAM's own account, and real money.
    await db.query(
      `INSERT INTO background_checks (landlord_id, user_id, amount_charged, applicant_payment_intent_id, created_at)
       VALUES ($1, $2, 44.99, 'pi_pool_check', '2026-08-02T18:00:00Z')`, [pool!.landlordId, pool!.userId])

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.map(p => p.kind).sort()).toEqual(['background_check', 'register_card'])
    expect(aug.feeRevenue).toBe(2.72)                 // the real sale's 0.67 + the pool check's 2.05

    const r = await trueUpProcessingMargin('2026-08-01')
    expect(r.feesCharged).toBe(2.72)
    const booked = (await db.query<{ reference_type: string }>(
      `SELECT reference_type FROM platform_revenue_ledger WHERE type = 'banking_spread'`)).rows
    // Only the real sale's fee was booked by the true-up; the demo and system sales never were.
    expect(booked).toEqual([{ reference_type: 'pos_transaction' }])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// FIX PASS 2 (10/3 review) — every card or bank payment that lands on GAM's
// balance with a GAM fee in it is on both cards; nothing that is not GAM's is
// counted as GAM's; the card and its own list borrow the same rate.
// ═══════════════════════════════════════════════════════════════════════════
import { seedProperty, seedUnit } from '../test/dbHelpers'
import { readPlatformStripeLive, stayDepositFee, CARD_SALE_ON_BALANCE_STATUSES, type PlatformStripeLive } from './stripeCosts'

const liveOf = (available: number, extra: Partial<PlatformStripeLive> = {}): PlatformStripeLive => ({
  available, pending: 0, clearingOnBalance: {}, paidOutToGamBank: 0, costsNotYetRecorded: 0, ...extra,
})
const bookTotal = async () => Number((await db.query<{ t: string }>(`SELECT COALESCE(SUM(amount), 0)::text AS t FROM platform_revenue_ledger`)).rows[0].t)

describe('a card sale refunded at the register (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('a card sale on GAM\'s balance is one completed, partly refunded or refunded in full — never voided', () => {
    expect([...CARD_SALE_ON_BALANCE_STATUSES]).toEqual(['completed', 'partial_refund', 'refunded'])
  })

  it('refunded in full in cash, it keeps GAM\'s fee on the margin card, the true-up leaves the fee on the book, and the check has no gap', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
    const { rows: [sale] } = await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, created_at, status, refund_amount, refunded_at)
       VALUES ($1, $2, 'card', 50, 0, 2.17, 52.17, 2.17, 'pi_refunded', '2026-08-02T18:00:00Z', 'refunded', 52.17, '2026-08-03T18:00:00Z')
       RETURNING id`, [landlordId, userId])
    // The register paid it back from the drawer; nothing went back through Stripe.
    await db.query(`INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method) VALUES ($1, $2, 52.17, 'cash')`, [sale.id, landlordId])
    // The landlord is still paid for the sale; GAM booked its fee at the sale.
    await db.query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'pos_sale', $2, 50)`, [landlordId, sale.id])
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, customer_fee_charged, created_at)
       VALUES ('banking_spread', 2.17, 2.17, $1, 'pos_transaction', 2.17, '2026-08-02T18:00:00Z')`, [sale.id])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug2', 'network_cost', 'card_interchange', 1.00, '2026-08-03T12:00:00Z', '2026-08-02', '2026-08-02')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.id === sale.id)).toMatchObject({ kind: 'register_card', feeCharged: 2.17, stripeCost: 1, gamKeeps: 1.17 })
    expect(aug).toMatchObject({ feeRevenue: 2.17, stripeCost: 1, margin: 1.17 })

    const r = await trueUpProcessingMargin('2026-08-01')
    expect(r).toMatchObject({ feesCharged: 2.17, alreadyRecorded: 2.17, adjustment: -1 })
    expect(await bookTotal()).toBe(1.17)                     // the fee less what Stripe took — never the fee taken back

    const book = await loadPlatformBalanceBook()
    expect(book.collected.registerCardFees).toBe(2.17)
    const s = splitPlatformBalance(book, liveOf(52.17 - 1.00))
    expect(s.gamsOwn).toBe(1.17)
    expect(s.reconciliation).toMatchObject({ book: 1.17, gap: 0 })
  })
})

describe('stay deposits paid online and the business portal\'s payments (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('a paid stay deposit\'s card fee is on the margin card, the true-up books it, and the check still ties', async () => {
    const c = await db.connect()
    let landlordId = '', unitId = ''
    try {
      const l = await seedLandlord(c)
      landlordId = l.landlordId
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      unitId = await seedUnit(c, { propertyId, landlordId })
    } finally { c.release() }
    // A $100 deposit: the guest is charged $104.05, $100 is held for the landlord, GAM keeps its $4.05.
    expect(stayDepositFee(100)).toBe(4.05)
    const { rows: [b] } = await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, guest_name,
                                  deposit_amount, deposit_paid_at, stripe_payment_intent_id)
       VALUES ($1, $2, '2026-08-20', '2026-08-23', 'nightly', 'confirmed', 'Guest One', 100, '2026-08-05T18:00:00Z', 'pi_stay')
       RETURNING id`, [unitId, landlordId])
    await db.query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'booking_deposit', $2, 100)`, [landlordId, b.id])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug5', 'network_cost', 'card_interchange', 2.00, '2026-08-06T12:00:00Z', '2026-08-05', '2026-08-05')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.id === b.id)).toMatchObject({
      kind: 'stay_deposit', kindLabel: 'Stay deposit paid online', method: 'card',
      amount: 104.05, feeCharged: 4.05, stripeCost: 2, gamKeeps: 2.05, costBasis: 'day_share',
    })
    expect(aug).toMatchObject({ feeRevenue: 4.05, stripeCost: 2, margin: 2.05 })
    expect(aug.notTiedToAPayment).toEqual([])                // Stripe's cost of the charge is the deposit's, not spread elsewhere

    await trueUpProcessingMargin('2026-08-01')
    expect(await bookTotal()).toBe(2.05)

    const book = await loadPlatformBalanceBook()
    expect(book.collected.stayDepositFees).toBe(4.05)
    const s = splitPlatformBalance(book, liveOf(104.05 - 2.00))
    expect(s.owedToLandlords).toBe(100)
    expect(s.gamsOwn).toBe(2.05)
    expect(s.reconciliation).toMatchObject({ book: 2.05, gap: 0 })
  })

  it('a business invoice paid by card and a business register card sale are on the margin card with GAM\'s cut, and the check ties with the invoicing fee', async () => {
    const c = await db.connect()
    let ownerId = ''
    try { ({ userId: ownerId } = await seedLandlord(c)) } finally { c.release() }
    const { rows: [biz] } = await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email) VALUES ($1, 'Desert Haul', 'trash_hauling', 'haul@test.dev') RETURNING id`, [ownerId])
    const { rows: [cust] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers (business_id, customer_type, first_name, last_name) VALUES ($1, 'individual', 'Pat', 'Payer') RETURNING id`, [biz.id])
    const { rows: [inv] } = await db.query<{ id: string }>(
      `INSERT INTO business_invoices (business_id, customer_id, invoice_number, status, issue_date, due_date, total_amount, amount_paid, sent_at, paid_at)
       VALUES ($1, $2, 'INV-7', 'paid', '2026-08-01', '2026-08-15', 200, 200, '2026-08-01T18:00:00Z', '2026-08-06T18:00:00Z') RETURNING id`, [biz.id, cust.id])
    // $200 by card: GAM's cut 3.5% + $0.55 = $7.55; $192.45 held for the business.
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO business_invoice_payments (business_id, invoice_id, amount, kind, method, stripe_checkout_session_id, stripe_payment_intent_id, paid_at)
       VALUES ($1, $2, 200, 'full', 'card', 'cs_inv7', 'pi_inv7', '2026-08-06T18:00:00Z') RETURNING id`, [biz.id, inv.id])
    await db.query(`INSERT INTO held_payout_items (business_id, source_type, source_id, amount) VALUES ($1, 'business_invoice_payment', 'cs_inv7', 192.45)`, [biz.id])
    // A $50 register card sale, the business covering the fee: GAM's cut $2.30; $47.70 held.
    const { rows: [sale] } = await db.query<{ id: string }>(
      `INSERT INTO business_pos_transactions (business_id, receipt_number, status, subtotal, total_amount, payment_method,
                                              stripe_payment_intent_id, card_surcharge, created_at)
       VALUES ($1, 'R-1', 'completed', 50, 50, 'stripe_terminal', 'pi_bpos', 0, '2026-08-06T19:00:00Z') RETURNING id`, [biz.id])
    await db.query(`INSERT INTO held_payout_items (business_id, source_type, source_id, amount) VALUES ($1, 'business_pos_sale', $2, 47.70)`, [biz.id, sale.id])
    // The month's $10 invoicing fee, netted from what GAM holds for the business.
    const { rows: [acc] } = await db.query<{ id: string }>(
      `INSERT INTO business_platform_fee_accruals (business_id, month, amount, status, stripe_charge_id, collected_at)
       VALUES ($1, '2026-08', 10, 'collected', 'netted', NOW()) RETURNING id`, [biz.id])
    await db.query(`INSERT INTO held_payout_items (business_id, source_type, source_id, amount) VALUES ($1, 'platform_fee', $2, -10)`, [biz.id, `accrual:${acc.id}`])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug6', 'network_cost', 'card_interchange', 5.00, '2026-08-07T12:00:00Z', '2026-08-06', '2026-08-06')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.id === pay.id)).toMatchObject({ kind: 'business_invoice', kindLabel: 'Business invoice payment', feeCharged: 7.55, amount: 200 })
    expect(aug.payments!.find(p => p.id === sale.id)).toMatchObject({ kind: 'business_register_card', kindLabel: 'Business register card sale', feeCharged: 2.30, amount: 50 })
    expect(aug).toMatchObject({ feeRevenue: 9.85, stripeCost: 5, margin: 4.85 })
    expect(aug.payments!.find(p => p.id === pay.id)!.who).toContain('Desert Haul')

    const book = await loadPlatformBalanceBook()
    expect(book.collected).toMatchObject({ businessPaymentFees: 9.85, businessInvoicingFees: 10 })
    const s = splitPlatformBalance(book, liveOf(250 - 5))
    expect(s.owedToLandlords).toBe(230.15)                    // 192.45 + 47.70 − the $10 fee netted
    expect(s.gamsOwn).toBe(14.85)
    expect(s.reconciliation).toMatchObject({ book: 14.85, gap: 0 })
  })

  it('a business invoice paid by bank is the business\'s while it clears, and a bank payment GAM\'s records do not show is never GAM\'s', async () => {
    const book: PlatformBalanceBook = {
      ownerSharesOwed: 0, heldItemsOwed: 0, payoutsReserved: 0, depositsInTrust: 0, managerPmCutsOwed: 0,
      paidAheadHeld: 0, checkrHeld: 0, heldPayLinkPayments: 0, clearing: [],
      collected: { processingFees: 0, registerCardFees: 0, screeningKept: 0, landlordChargesCollected: 0, flexpayKept: 0,
                   sweptIn: 0, keptFeesRecovered: 0, gamOwnedBillLines: 0, tenantPaidPlatformFees: 0, stayDepositFees: 0,
                   businessPaymentFees: 0, businessInvoicingFees: 0 },
      gamOwnedBillLinesByKind: [], takenBack: NOTHING_TAKEN_BACK,
      // Stripe's $2.50 on the business invoice is already on record (nightly).
      stripeCostsRecorded: 2.50, flexpayFronted: 0, recordedTxnIds: ['txn_biz:fee'], owedByLandlordsUncollected: 0,
    }
    let intentsAskedFor: string[] = []
    const now = Math.floor(Date.now() / 1000)
    const stripe: any = {
      balance: { retrieve: async () => ({ available: [], pending: [{ amount: 49750 + 9950, currency: 'usd' }] }) },
      paymentIntents: { retrieve: async (id: string) => { intentsAskedFor.push(id); return { id, metadata: {} } } },
      payouts: { list: async () => ({ data: [], has_more: false }) },
      balanceTransactions: { list: async (p: any) => p.type !== 'payment' ? { data: [], has_more: false } : { has_more: false, data: [
        // A $500 invoice paid by bank, still clearing: GAM records it only when it clears.
        { id: 'txn_biz', type: 'payment', amount: 50000, fee: 250, net: 49750, created: now - 2 * 86400,
          source: { id: 'py_biz', status: 'pending', payment_intent: 'pi_biz', metadata: { gam_purpose: 'business_invoice' } } },
        // A $100 bank payment nobody at GAM recorded.
        { id: 'txn_x', type: 'payment', amount: 10000, fee: 50, net: 9950, created: now - 86400,
          source: { id: 'py_x', status: 'pending', payment_intent: 'pi_x', metadata: {} } },
      ] } },
    }
    const live = await readPlatformStripeLive(book, stripe)
    expect(intentsAskedFor).toEqual(['pi_x'])                  // only when the charge does not say what it is
    expect(live.clearingNotInRecords!.map(i => i.kind)).toEqual(['business_payment', 'unrecorded_payment'])
    expect(live.costsNotYetRecorded).toBe(0)                   // their fees sit with the clearing payments, never as costs
    const s = splitPlatformBalance(book, live)
    expect(s.onBalance).toBe(597)
    expect(s.gamsOwn).toBe(0)                                  // neither is GAM's while it clears
    expect(s.clearing.businessesOnBalance).toBe(494)           // $500 less GAM's $6 cut
    expect(s.clearing).toMatchObject({ gamTotal: 6, gamOnBalance: 3.5, stripeTook: 2.5 })
    expect(s.clearing.unrecorded).toEqual({ count: 1, netOnBalance: 99.5 })
    expect(s.reconciliation).toMatchObject({ stripeCosts: 0, book: 0, gap: 0 })
    expect(s.clearing.items.find(i => i.kind === 'unrecorded_payment')!.who).toBe('A bank payment GAM\'s records do not list as clearing')
  })

  it('one of GAM\'s own bill lines charged on its own and still clearing is GAM\'s money, not earned until it clears', async () => {
    const c = await db.connect()
    let landlordId = '', tenantId = ''
    try { ({ landlordId } = await seedLandlord(c)); tenantId = await seedTenant(c) } finally { c.release() }
    await db.query(
      `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, revenue_owner, stripe_payment_intent_id)
       VALUES ($1, $2, 'fee', 3, 'processing', 'SUBSCRIP', '2026-10-01', 'gam', 'pi_custody_clearing')`, [landlordId, tenantId])
    const book = await loadPlatformBalanceBook()
    expect(book.clearing).toEqual([expect.objectContaining({ kind: 'gam_bill_line', paymentIntentId: 'pi_custody_clearing', othersShare: 0, gamFee: 3, gross: 3 })])
    expect(book.collected.gamOwnedBillLines).toBe(0)
  })
})

describe('the first days of a month, before Stripe posts its first card day (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
    const c = await db.connect()
    let landlordId = '', tenantId = ''
    try { ({ landlordId } = await seedLandlord(c)); tenantId = await seedTenant(c) } finally { c.release() }
    const card = (gross: number, pi: string, at: string) => db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, $3::numeric - 35, $3::numeric - 35, 'settled', 'card', $3::numeric, 35, $4, $5::timestamptz, $5::timestamptz)`,
      [tenantId, landlordId, gross, pi, at])
    // September: Sep 10, and the UTC day Sep 29 — one of its payments made on
    // the Phoenix evening of Sep 28, which a load starting two days before
    // October never saw.
    await card(1000, 'pi_s1', '2026-09-10T18:00:00Z')
    await card(1000, 'pi_s2', '2026-09-29T03:00:00Z')
    await card(500, 'pi_s3', '2026-09-29T20:00:00Z')
    // October 2: Stripe has not posted October's first card day yet.
    await card(1000, 'pi_g', '2026-10-02T15:00:00Z')
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_sep10', 'network_cost', 'card_interchange', 10.00, '2026-09-11T12:00:00Z', '2026-09-10', '2026-09-10'),
              ('n_sep29', 'network_cost', 'card_interchange', 30.00, '2026-09-30T12:00:00Z', '2026-09-29', '2026-09-29')`)
  })

  it('the card, its payment list and the true-up all borrow September\'s whole rate', async () => {
    const card = (await marginByMonth(2, { now: '2026-10' })).find(r => r.month === '2026-10')!
    const list = await marginForMonth('2026-10')
    // September's observed rate: $40 of card costs on $2,500 of card payments = 1.6%.
    expect(list.payments!.find(p => p.amount === 1000 && p.at.startsWith('2026-10-02'))).toMatchObject({ stripeCost: 16, costBasis: 'estimate_unposted' })
    expect(card).toMatchObject({ stripeCost: 16, margin: 19, estimatedCost: 16 })
    expect(list).toMatchObject({ stripeCost: card.stripeCost, margin: card.margin, estimatedCost: card.estimatedCost })
    const cleared = list.payments!.filter(p => !p.clearing)
    expect(Math.round((cleared.reduce((a, p) => a + p.stripeCost, 0) + list.notTiedTotal) * 100)).toBe(Math.round(card.stripeCost * 100))
    const r = await trueUpProcessingMargin('2026-10-01')
    expect(r).toMatchObject({ stripeCost: 16, actualMargin: 19 })
  })
})

describe('a platform fee a property passes to its tenants (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('is not processing: off the margin card, its own line on the check, and booked as a platform fee once the payment clears', async () => {
    const c = await db.connect()
    let landlordId = '', userId = '', tenantId = '', propertyId = ''
    try {
      ({ landlordId, userId } = await seedLandlord(c))
      tenantId = await seedTenant(c)
      propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    } finally { c.release() }
    const rent = async () => (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, platform_held, settled_at)
       VALUES ($1, $2, 'rent', 460, 'settled', 'RENT', '2026-08-01', TRUE, '2026-08-03T18:00:00Z') RETURNING id`, [landlordId, tenantId])).rows[0].id
    const remit = async (status: string, fee: number, pi: string, at: string, paymentId: string) => {
      const { rows: [r] } = await db.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                         gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
         VALUES ($1, $2, 460, 460, $3::text, 'card', 460 + $4::numeric, $4::numeric, $5, $6::timestamptz,
                 CASE WHEN $3::text = 'settled' THEN $6::timestamptz + interval '1 minute' END) RETURNING id`,
        [tenantId, landlordId, status, fee, pi, at])
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 460)`, [r.id, paymentId])
      return r.id
    }
    const accrual = async (month: string, paymentId: string, linkedAt: string) => (await db.query<{ id: string }>(
      `INSERT INTO platform_fee_accruals (landlord_id, property_id, accrual_month, rate_per_unit, min_per_connect_account,
                                          total_amount, payer, tenant_charge_id, updated_at)
       VALUES ($1, $2, $3, 2, 10, 10, 'tenant', $4, $5::timestamptz) RETURNING id`, [landlordId, propertyId, month, paymentId, linkedAt])).rows[0].id
    // August's rent carried the $10 platform fee on top of its $16.65 card fee.
    const p1 = await rent()
    await remit('settled', 26.65, 'pi_with_fee', '2026-08-03T18:00:00Z', p1)
    const a1 = await accrual('2026-08-01', p1, '2026-08-03T18:00:00Z')
    // Another rent row: the charge that carried its platform fee failed; the
    // retry an hour later carried only the card fee.
    const p2 = await rent()
    await remit('failed', 26.65, 'pi_failed', '2026-08-04T18:00:00Z', p2)
    const a2 = await accrual('2026-07-01', p2, '2026-08-04T18:00:00Z')
    await remit('settled', 16.65, 'pi_retry', '2026-08-04T19:00:00Z', p2)
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
       VALUES ($1, 'allocation_owner_share', 460, 460, $2, 'payment'), ($1, 'allocation_owner_share', 460, 920, $3, 'payment')`,
      [userId, p1, p2])

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.map(p => p.feeCharged)).toEqual([16.65, 16.65])
    expect(aug.payments!.find(p => p.amount === 486.65)).toMatchObject({ feeCharged: 16.65 })   // paid 486.65: rent, the card fee, and the $10 platform fee
    expect(aug.feeRevenue).toBe(33.30)

    const book = await loadPlatformBalanceBook()
    expect(book.collected).toMatchObject({ processingFees: 33.30, tenantPaidPlatformFees: 10 })
    const s = splitPlatformBalance(book, liveOf(486.65 + 476.65))
    expect(s.gamsOwn).toBe(43.30)
    expect(s.reconciliation).toMatchObject({ book: 43.30, gap: 0 })

    const r = await trueUpProcessingMargin('2026-08-01')
    expect(r.feesCharged).toBe(33.30)
    const fees = (await db.query<{ reference_id: string; amount: string; created_at: Date }>(
      `SELECT reference_id, amount::text AS amount, created_at FROM platform_revenue_ledger
        WHERE type = 'platform_fee_subscription' AND reference_type = 'platform_fee_accrual'`)).rows
    expect(fees.map(f => [f.reference_id, f.amount])).toEqual([[a1, '10.00']])   // never a2: its charge failed
    expect(new Date(fees[0].created_at).toISOString()).toBe('2026-08-03T18:01:00.000Z') // the day the payment cleared
    expect(a2).toBeTruthy()
    // Run again: nothing is booked twice.
    await trueUpProcessingMargin('2026-08-01')
    expect((await db.query(`SELECT 1 FROM platform_revenue_ledger WHERE type = 'platform_fee_subscription'`)).rows.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 — fix pass after the cards' second review.
// ═══════════════════════════════════════════════════════════════════════════
import { seedAllocationRule, seedLease } from '../test/dbHelpers'
import {
  gamFeeOnRemittance, stayDepositFeeFromPayoutLine, ESTIMATE_RATE_LABEL, FEE_BEARING_TXN_TYPES,
} from './stripeCosts'

describe('a bank fee the landlord covers (10/3 review)', () => {
  let landlordId = '', userId = '', tenantId = '', leaseId = '', unitId = ''
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
    const c = await db.connect()
    try {
      ({ landlordId, userId } = await seedLandlord(c))
      tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
      await seedAllocationRule(c, { propertyId, achFeePayer: 'landlord' })
      leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500 })
    } finally { c.release() }
  })

  /** A $500 rent row paid by bank, nothing added on top: the landlord covers the $6. */
  const payByBank = async (status: 'settled' | 'processing', pi: string, at: string, settled: string | null) => {
    const { rows: [p] } = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, landlord_id, tenant_id, type, amount, status, entry_description, due_date,
                             platform_held, settled_at, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, 'rent', 500, $5, 'RENT', '2026-08-01', TRUE, $6::timestamptz, $7) RETURNING id`,
      [unitId, leaseId, landlordId, tenantId, status, settled, pi])
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, $3, 500, 500, $4, 'ach', 500, 0, $5, $6::timestamptz, $7::timestamptz) RETURNING id`,
      [tenantId, leaseId, landlordId, status, pi, at, settled])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 500)`, [r.id, p.id])
    return p.id
  }

  it('a landlord-covered bank payment shows GAM\'s $6 on the card, the true-up keeps $6 less Stripe\'s fee, and the check ties', async () => {
    const paymentId = await payByBank('settled', 'pi_cover', '2026-08-03T15:00:00Z', '2026-08-08T15:00:00Z')
    // What allocation booked when it settled: the $6 out of the landlord's
    // share, GAM's spread on it (allocation.ts).
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
       VALUES ($1, 'allocation_owner_share', 494, 494, $2, 'payment')`, [userId, paymentId])
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, customer_fee_charged, created_at)
       VALUES ('banking_spread', 3.50, 3.50, $1, 'payment', 6, '2026-08-08T15:00:00Z')`, [paymentId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_cover:fee', 'payment', 'bank_debit_fee', 2.50, '2026-08-03T20:00:00Z', 'pi_cover')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.kind === 'rent_bank')).toMatchObject({
      amount: 500, feeCharged: 6, stripeCost: 2.5, costBasis: 'exact', gamKeeps: 3.5, clearing: false,
    })
    expect(aug).toMatchObject({ feeRevenue: 6, stripeCost: 2.5, margin: 3.5 })

    const r = await trueUpProcessingMargin('2026-08-01')
    expect(r).toMatchObject({ feesCharged: 6, stripeCost: 2.5, actualMargin: 3.5, alreadyRecorded: 3.5, adjustment: 0 })
    expect(await bookTotal()).toBe(3.5)                      // never −$2.50: the $6 is GAM's

    const book = await loadPlatformBalanceBook()
    expect(book.collected.processingFees).toBe(6)
    const s = splitPlatformBalance(book, liveOf(500 - 2.50))
    expect(s.owedToLandlords).toBe(494)
    expect(s.gamsOwn).toBe(3.5)
    expect(s.reconciliation).toMatchObject({ book: 3.5, gap: 0 })
  })

  it('while it clears, the $6 the landlord covers is GAM\'s money still clearing, never the landlord\'s', async () => {
    await payByBank('processing', 'pi_cover_clearing', '2026-08-20T15:00:00Z', null)
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_cc:fee', 'payment', 'bank_debit_fee', 2.50, '2026-08-20T20:00:00Z', 'pi_cover_clearing')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.clearing).toEqual({ count: 1, amount: 500, fees: 6, stripeCost: 2.5 })
    expect(aug).toMatchObject({ feeRevenue: 0, stripeCost: 0 })

    const book = await loadPlatformBalanceBook()
    expect(book.clearing).toEqual([expect.objectContaining({ kind: 'tenant_payment', othersShare: 494, gamFee: 6, gross: 500 })])
    const s = splitPlatformBalance(book, liveOf(0, { pending: 497.5, clearingOnBalance: { pi_cover_clearing: { net: 497.5, fee: 2.5 } } }))
    expect(s.clearing).toMatchObject({ landlordsOnBalance: 494, gamTotal: 6, gamOnBalance: 3.5, stripeTook: 2.5 })
    expect(s.gamsOwn).toBe(0)
    expect(s.reconciliation).toMatchObject({ book: 0, gap: 0 })
  })

  it('reads the payer\'s fee first; the landlord\'s only when the payer paid none', () => {
    // The payer paid it on top: whatever allocation booked, that is the fee.
    expect(gamFeeOnRemittance({ tenantFee: 6, allocFee: 6, feePayer: 'tenant', amount: 500, method: 'ach' }))
      .toEqual({ tenantBorne: 6, landlordBorne: 0, total: 6 })
    // Settled and allocated: what allocation took from the landlord's share.
    expect(gamFeeOnRemittance({ tenantFee: 0, allocFee: 6, feePayer: 'landlord', amount: 500, method: 'ach' }))
      .toEqual({ tenantBorne: 0, landlordBorne: 6, total: 6 })
    // Still clearing: the property's fee for the method.
    expect(gamFeeOnRemittance({ tenantFee: 0, allocFee: null, feePayer: 'landlord', amount: 500, method: 'ach' }).landlordBorne).toBe(6)
    // A platform fee passed to tenants is not processing, and a property whose tenants pay owes nothing more.
    expect(gamFeeOnRemittance({ tenantFee: 0, allocFee: null, feePayer: 'tenant', amount: 500, method: 'ach' }).total).toBe(0)
  })
})

describe('a stay deposit followed by a paid balance link (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('an online deposit followed by a paid balance link keeps the deposit\'s fee at $3.00 on the card, in the true-up and in the check', async () => {
    const c = await db.connect()
    let landlordId = '', userId = '', unitId = '', propertyId = ''
    try {
      ({ landlordId, userId } = await seedLandlord(c))
      propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      unitId = await seedUnit(c, { propertyId, landlordId })
    } finally { c.release() }
    // A $700 week: $70 deposit online ($73.00 charged, $70 held for the
    // landlord, GAM's $3.00), then the $630 balance link — which moves
    // deposit_amount to everything paid toward the stay, $700.
    const { rows: [b] } = await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, guest_name, total_amount,
                                  deposit_amount, deposit_paid_at, stripe_payment_intent_id, balance_paid_at)
       VALUES ($1, $2, '2026-08-12', '2026-08-19', 'weekly', 'confirmed', 'Guest Two', 700,
               700, '2026-08-05T18:00:00Z', 'pi_dep70', '2026-08-12T18:00:00Z')
       RETURNING id`, [unitId, landlordId])
    await db.query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'booking_deposit', $2, 70)`, [landlordId, b.id])
    const { rows: [sale] } = await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, property_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, paid_online, created_at)
       VALUES ($1, $2, $3, 'card', 630, 0, 22.60, 652.60, 22.60, 'pi_bal630', TRUE, '2026-08-12T18:00:00Z') RETURNING id`,
      [landlordId, userId, propertyId])
    await db.query(`INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'pos_sale', $2, 630)`, [landlordId, sale.id])
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_id, reference_type, customer_fee_charged, created_at)
       VALUES ('banking_spread', 22.60, 22.60, $1, 'pos_transaction', 22.60, '2026-08-12T18:00:00Z')`, [sale.id])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug5b', 'network_cost', 'card_interchange', 1.00, '2026-08-06T12:00:00Z', '2026-08-05', '2026-08-05'),
              ('n_aug12', 'network_cost', 'card_interchange', 10.00, '2026-08-13T12:00:00Z', '2026-08-12', '2026-08-12')`)

    const aug = await marginForMonth('2026-08')
    expect(aug.payments!.find(p => p.id === b.id)).toMatchObject({ kind: 'stay_deposit', amount: 73, feeCharged: 3, stripeCost: 1, gamKeeps: 2 })
    expect(aug.payments!.find(p => p.id === sale.id)).toMatchObject({ kind: 'pay_link_card', feeCharged: 22.6 })
    expect(aug).toMatchObject({ feeRevenue: 25.6, stripeCost: 11, margin: 14.6 })

    const r = await trueUpProcessingMargin('2026-08-01')
    expect(r).toMatchObject({ feesCharged: 25.6, actualMargin: 14.6 })
    expect(await bookTotal()).toBe(14.6)

    const book = await loadPlatformBalanceBook()
    expect(book.collected).toMatchObject({ stayDepositFees: 3, registerCardFees: 22.6 })
    const s = splitPlatformBalance(book, liveOf(73 + 652.60 - 11))
    expect(s.owedToLandlords).toBe(700)
    expect(s.gamsOwn).toBe(14.6)
    expect(s.reconciliation).toMatchObject({ book: 14.6, gap: 0 })
  })

  it('reads the fee from the payout line — on top or covered by the property — whatever later payments did to the deposit on record', () => {
    // On top: the line is the deposit. Covered: the line is the deposit less the fee.
    expect(stayDepositFeeFromPayoutLine(70, 70, 'customer')).toBe(3)
    expect(stayDepositFeeFromPayoutLine(67, 70, 'customer')).toBe(3)      // the deposit on record says covered, whatever the setting says now
    expect(stayDepositFeeFromPayoutLine(100, 100, 'customer')).toBe(4.05)
    // After a $630 balance link moved the deposit on record to $700:
    expect(stayDepositFeeFromPayoutLine(70, 700, 'customer')).toBe(3)
    expect(stayDepositFeeFromPayoutLine(67, 700, 'landlord')).toBe(3)
  })
})

describe('the rate a month\'s card estimate used, named on the card (10/3 review)', () => {
  const pay = (p: Partial<MarginPaymentInput> & { id: string }): MarginPaymentInput => ({
    kind: 'rent_card', method: 'card', clearing: false, month: '2026-10', day: '2026-10-02',
    at: '2026-10-02T17:00:00Z', amount: 1000, fee: 35.55, paymentIntentId: null, who: p.id, ...p,
  })
  const base = (): MarginInputs => ({
    payments: [], costs: [], bankCost: { pct: 0.5, flat: 0, cap: 3 }, cardFallback: { pct: 0.029, flat: 0.26 },
  })

  it('this month\'s own rate once a card day of it has posted', () => {
    const inp = base()
    inp.payments = [pay({ id: 'A', day: '2026-10-01' }), pay({ id: 'B' })]
    inp.costs = [{ id: 'n1', category: 'card_interchange', amount: 20, month: '2026-10', day: '2026-10-01', paymentIntentId: null }]
    const [m] = computeMarginMonths(inp, ['2026-10'])
    expect(m).toMatchObject({ estimateRate: 'this_month', estimateRateLabel: ESTIMATE_RATE_LABEL.this_month, estimatedCost: 20 })
  })

  it('last month\'s rate before this month\'s first card day posts (the 1st-2nd of every month)', () => {
    const inp = base()
    inp.payments = [pay({ id: 'S', month: '2026-09', day: '2026-09-20', at: '2026-09-20T17:00:00Z' }), pay({ id: 'B' })]
    inp.costs = [{ id: 'n1', category: 'card_interchange', amount: 15, month: '2026-09', day: '2026-09-20', paymentIntentId: null }]
    const [m] = computeMarginMonths(inp, ['2026-10'])
    expect(m).toMatchObject({ estimateRate: 'month_before', estimatedCost: 15 })
    expect(m.estimateRateLabel).toContain('last month')
  })

  it('Stripe\'s list price when neither month has a posted card day, and nothing named when nothing was estimated', () => {
    const inp = base()
    inp.payments = [pay({ id: 'B' })]
    const [m] = computeMarginMonths(inp, ['2026-10'])
    expect(m).toMatchObject({ estimateRate: 'rate_card', estimatedCost: 29.26 })
    const [none] = computeMarginMonths(base(), ['2026-10'])
    expect(none).toMatchObject({ estimateRate: null, estimateRateLabel: null })
  })
})

describe('Stripe\'s fee on a bank payment the card does not list (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  it('a FlexPay pull still clearing keeps its Stripe fee out of every month until it clears, then counts it in the month it cleared — like GAM\'s Own Money', async () => {
    const c = await db.connect()
    let landlordId = '', tenantId = ''
    try { ({ landlordId } = await seedLandlord(c)); tenantId = await seedTenant(c) } finally { c.release() }
    const { rows: [pull] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, type, amount, status, entry_description, due_date, revenue_owner,
                             stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 'fee', 525, 'processing', 'FLEXPAY', '2026-10-01', 'gam', 'pi_flexpull', '2026-10-02T15:00:00Z') RETURNING id`,
      [landlordId, tenantId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_flexpull:fee', 'payment', 'bank_debit_fee', 2.63, '2026-10-02T20:00:00Z', 'pi_flexpull')`)

    const oct = await marginForMonth('2026-10')
    expect(oct).toMatchObject({ stripeCost: 0, notTiedTotal: 0, otherClearing: { count: 1, stripeCost: 2.63 } })
    const card = (await marginByMonth(2, { now: '2026-10' })).find(r => r.month === '2026-10')!
    expect(card.otherClearing).toEqual({ count: 1, stripeCost: 2.63 })
    expect((await loadPlatformBalanceBook()).stripeCostsRecorded).toBe(0)

    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-11-03T18:00:00Z' WHERE id = $1`, [pull.id])
    const octAfter = await marginForMonth('2026-10')
    expect(octAfter).toMatchObject({ stripeCost: 0, otherClearing: { count: 0, stripeCost: 0 } })
    const nov = await marginForMonth('2026-11')
    expect(nov.notTiedToAPayment).toEqual([{ category: 'bank_debit_fee', label: COST_LABELS.bank_debit_fee, amount: 2.63 }])
    expect(nov.stripeCost).toBe(2.63)
    expect((await loadPlatformBalanceBook()).stripeCostsRecorded).toBe(2.63)
  })
})

describe('fees Stripe takes on other kinds of balance transactions (10/3 review)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
  })

  const now = Math.floor(Date.now() / 1000)
  const lines: Record<string, any[]> = {
    // A returned bank payment's failure fee, and a dispute's fee.
    payment_failure_refund: [{ id: 'txn_fail', amount: -46600, fee: 400, net: -47000, created: now - 3600,
                               source: { id: 'pyr_1', object: 'refund', payment_intent: 'pi_returned' } }],
    adjustment: [{ id: 'txn_dispute', amount: -5000, fee: 1500, net: -6500, created: now - 3600, source: { id: 'du_1', object: 'dispute' } }],
    // A refund that took nothing is not a cost.
    refund: [{ id: 'txn_refund', amount: -2000, fee: 0, net: -2000, created: now - 3600, source: { id: 're_1', object: 'refund' } }],
  }
  const fakeStripe = () => ({
    balance: { retrieve: async () => ({ available: [{ amount: 0, currency: 'usd' }], pending: [] }) },
    payouts: { list: async () => ({ data: [], has_more: false }) },
    paymentIntents: { retrieve: async (id: string) => ({ id, metadata: {} }) },
    balanceTransactions: { list: async (p: any) => ({ data: lines[p.type] ?? [], has_more: false }) },
  }) as any

  it('records a returned bank payment\'s fee and a dispute\'s fee as what Stripe charged GAM', async () => {
    expect([...FEE_BEARING_TXN_TYPES]).toEqual(['payment', 'charge', 'payment_failure_refund', 'payment_refund', 'payment_reversal', 'refund', 'adjustment'])
    await syncStripeCosts({ stripe: fakeStripe() })
    const rows = (await db.query<any>(
      `SELECT stripe_txn_id, txn_type, category, amount::text AS amount, stripe_payment_intent_id FROM stripe_processing_costs ORDER BY stripe_txn_id`)).rows
    expect(rows).toEqual([
      { stripe_txn_id: 'txn_dispute:fee', txn_type: 'adjustment', category: 'other', amount: '15.00', stripe_payment_intent_id: null },
      // Pass 2: a return's fee is the month's it posted in — the payment is named in its words, never tied.
      { stripe_txn_id: 'txn_fail:fee', txn_type: 'payment_failure_refund', category: 'bank_debit_fee', amount: '4.00', stripe_payment_intent_id: null },
    ])
    const [fail] = (await db.query<{ description: string }>(`SELECT description FROM stripe_processing_costs WHERE stripe_txn_id = 'txn_fail:fee'`)).rows
    expect(fail.description).toBe('Returned bank payment fee on txn_fail (payment pi_returned)')
  })

  it('the live read counts one GAM has not recorded yet, so the check never shows it as a gap', async () => {
    const book: PlatformBalanceBook = {
      ownerSharesOwed: 0, heldItemsOwed: 0, payoutsReserved: 0, depositsInTrust: 0, managerPmCutsOwed: 0,
      paidAheadHeld: 0, checkrHeld: 0, heldPayLinkPayments: 0, clearing: [],
      collected: { processingFees: 0, registerCardFees: 0, screeningKept: 0, landlordChargesCollected: 0, flexpayKept: 0,
                   sweptIn: 0, keptFeesRecovered: 0, gamOwnedBillLines: 0, tenantPaidPlatformFees: 0, stayDepositFees: 0,
                   businessPaymentFees: 0, businessInvoicingFees: 0 },
      gamOwnedBillLinesByKind: [], takenBack: NOTHING_TAKEN_BACK,
      stripeCostsRecorded: 4, flexpayFronted: 0, recordedTxnIds: ['txn_fail:fee'], owedByLandlordsUncollected: 0,
    }
    const live = await readPlatformStripeLive(book, fakeStripe())
    expect(live.costsNotYetRecorded).toBe(15)                 // the dispute's fee; the failure fee is on record
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (review, pass 2) — a fee Stripe takes on a payment weeks or months
// later (a dispute's, a returned or reversed bank payment's) is Stripe charging
// GAM the day it posts. Tied to the payment, it rode back into the payment's
// month, never reached the current month's card, and — the nightly true-up
// running for this month and last only — was never booked.
// ═══════════════════════════════════════════════════════════════════════════
describe('a dispute fee posted months after its card payment (10/3 review, pass 2)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
    const c = await db.connect()
    let landlordId = '', tenantId = ''
    try { ({ landlordId } = await seedLandlord(c)); tenantId = await seedTenant(c) } finally { c.release() }
    // Aug 15: a $460 card payment, fee $16.65. Stripe's card costs that day: $6.00.
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at, settled_at)
       VALUES ($1, $2, 460, 460, 'settled', 'card', 476.65, 16.65, 'pi_disputed', '2026-08-15T18:00:00Z', '2026-08-15T18:00:00Z')`,
      [tenantId, landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug15', 'network_cost', 'card_interchange', 6.00, '2026-08-16T12:00:00Z', '2026-08-15', '2026-08-15')`)
  })

  // Oct 2: the payer disputes it. Stripe takes the $476.65 back (the landlord's
  // to cover) and its $15 dispute fee; the dispute names the payment.
  const fakeStripe = () => ({
    balanceTransactions: { list: async (p: any) => ({ has_more: false, data: p.type !== 'adjustment' ? [] : [
      { id: 'txn_dispute_oct', amount: -47665, fee: 1500, net: -49165, created: Date.parse('2026-10-02T18:00:00Z') / 1000,
        source: { id: 'du_1', object: 'dispute', payment_intent: 'pi_disputed' } },
    ] }) },
  }) as any

  const expectOctoberTakesIt = async () => {
    const oct = await marginForMonth('2026-10')
    expect(oct).toMatchObject({ feeRevenue: 0, stripeCost: 15, notTiedTotal: 15 })
    expect(oct.notTiedToAPayment).toEqual([{ category: 'other', label: COST_LABELS.other, amount: 15 }])
    const aug = await marginForMonth('2026-08')
    expect(aug.stripeCost).toBe(6)
    expect(aug.payments!.find(p => p.amount === 476.65)).toMatchObject({ stripeCost: 6, costBasis: 'day_share', gamKeeps: 10.65 })
    const card = await marginByMonth(3, { now: '2026-10' })
    expect(card.find(r => r.month === '2026-10')!.stripeCost).toBe(15)
    expect(card.find(r => r.month === '2026-08')!.stripeCost).toBe(6)
  }

  it('counts in the month Stripe took it — not the payment\'s — and that month\'s true-up takes it; the check counts it once', async () => {
    await syncStripeCosts({ stripe: fakeStripe() })
    const [row] = (await db.query<any>(
      `SELECT txn_type, category, amount::text AS amount, stripe_payment_intent_id, description FROM stripe_processing_costs WHERE stripe_txn_id = 'txn_dispute_oct:fee'`)).rows
    expect(row).toEqual({ txn_type: 'adjustment', category: 'other', amount: '15.00', stripe_payment_intent_id: null,
                          description: 'Adjustment (a dispute or a correction) fee on txn_dispute_oct (payment pi_disputed)' })
    await expectOctoberTakesIt()

    expect(await trueUpProcessingMargin('2026-10-01')).toMatchObject({ stripeCost: 15, adjustment: -15 })
    expect(await trueUpProcessingMargin('2026-08-01')).toMatchObject({ stripeCost: 6, feesCharged: 16.65 })

    // On the check's costs once: Stripe's August day costs and October's dispute fee.
    // (What the dispute does to the rest of the check — the fee given back, what
    // the landlord repays — runs through the real dispute handler in
    // stripeCosts.disputes.test.ts.)
    const book = await loadPlatformBalanceBook()
    expect(book.stripeCostsRecorded).toBe(21)
  })

  it('a fee row an earlier sync stored with the payment named is still read as the month\'s it posted in', async () => {
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, description, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_dispute_oct:fee', 'adjustment', 'other', 'Adjustment fee on txn_dispute_oct', 15.00, '2026-10-02T18:00:00Z', 'pi_disputed')`)
    await expectOctoberTakesIt()
    expect(await trueUpProcessingMargin('2026-10-01')).toMatchObject({ stripeCost: 15 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (review, pass 2) — a business invoice paid by bank is recorded only once
// it clears. Its Stripe fee, synced while it cleared, matched nothing in GAM's
// records and counted at once in the month it posted — while GAM's Own Money
// kept it out until the payment cleared. One rule now.
// ═══════════════════════════════════════════════════════════════════════════
describe('Stripe\'s fee on a business invoice paid by bank, while it clears (10/3 review, pass 2)', () => {
  beforeEach(async () => {
    await cleanupAllSchema()
    await db.query(`DELETE FROM stripe_processing_costs`)
    await db.query(`DELETE FROM platform_revenue_ledger`)
  })

  const monthOf = async (ago: string) =>
    (await db.query<{ m: string }>(`SELECT to_char(NOW() - $1::interval, 'YYYY-MM') AS m`, [ago])).rows[0].m

  it('is held out as still clearing, like GAM\'s Own Money; once it clears it rides with the payment in the month it cleared', async () => {
    // Made five days ago: Stripe's $2.50 fee is on record; GAM has no record of the payment yet.
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_bizbank:fee', 'payment', 'bank_debit_fee', 2.50, NOW() - interval '5 days', 'pi_bizbank')`)
    const postedMonth = await monthOf('5 days')
    const now = await monthOf('0 days')

    const posted = await marginForMonth(postedMonth)
    expect(posted).toMatchObject({ stripeCost: 0, notTiedTotal: 0, otherClearing: { count: 1, stripeCost: 2.5 } })
    const card = await marginByMonth(2, { now })
    expect(card.find(r => r.month === now)!.otherClearing).toEqual({ count: 1, stripeCost: 2.5 })
    expect(card.reduce((a, r) => a + r.stripeCost, 0)).toBe(0)
    // GAM's Own Money finds it pending on the balance and keeps its fee off the costs too.
    const book = await loadPlatformBalanceBook()
    const s = splitPlatformBalance(book, liveOf(0, { clearingNotInRecordsFeesRecorded: 2.5 }))
    expect(s.reconciliation!.stripeCosts).toBe(0)

    // It clears yesterday: the webhook records it, and the fee rides with it.
    const c = await db.connect()
    let ownerId = ''
    try { ({ userId: ownerId } = await seedLandlord(c)) } finally { c.release() }
    const { rows: [biz] } = await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email) VALUES ($1, 'Desert Haul', 'trash_hauling', 'haul@test.dev') RETURNING id`, [ownerId])
    const { rows: [cust] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers (business_id, customer_type, first_name, last_name) VALUES ($1, 'individual', 'Pat', 'Payer') RETURNING id`, [biz.id])
    const { rows: [inv] } = await db.query<{ id: string }>(
      `INSERT INTO business_invoices (business_id, customer_id, invoice_number, status, issue_date, due_date, total_amount, amount_paid, sent_at, paid_at)
       VALUES ($1, $2, 'INV-9', 'paid', CURRENT_DATE - 10, CURRENT_DATE + 5, 500, 500, NOW() - interval '9 days', NOW() - interval '1 day') RETURNING id`,
      [biz.id, cust.id])
    const { rows: [pay] } = await db.query<{ id: string }>(
      `INSERT INTO business_invoice_payments (business_id, invoice_id, amount, kind, method, stripe_checkout_session_id, stripe_payment_intent_id, paid_at)
       VALUES ($1, $2, 500, 'full', 'ach', 'cs_bizbank', 'pi_bizbank', NOW() - interval '1 day') RETURNING id`, [biz.id, inv.id])
    await db.query(`INSERT INTO held_payout_items (business_id, source_type, source_id, amount) VALUES ($1, 'business_invoice_payment', 'cs_bizbank', 494)`, [biz.id])
    const clearedMonth = await monthOf('1 day')
    const cleared = await marginForMonth(clearedMonth)
    expect(cleared.payments!.find(p => p.id === pay.id)).toMatchObject({
      kind: 'business_invoice', method: 'bank', feeCharged: 6, stripeCost: 2.5, costBasis: 'exact', gamKeeps: 3.5, clearing: false })
    expect(cleared).toMatchObject({ feeRevenue: 6, stripeCost: 2.5, otherClearing: { count: 0, stripeCost: 0 } })
    if (postedMonth !== clearedMonth) expect((await marginForMonth(postedMonth)).stripeCost).toBe(0)
  })

  it('one that never gets a record (it failed) counts, after that window, in the month Stripe took it', async () => {
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_gone:fee', 'payment', 'bank_debit_fee', 1.00, NOW() - interval '20 days', 'pi_gone')`)
    const month = await monthOf('20 days')
    const m = await marginForMonth(month)
    expect(m).toMatchObject({ stripeCost: 1, otherClearing: { count: 0, stripeCost: 0 } })
    expect(m.notTiedToAPayment).toEqual([{ category: 'bank_debit_fee', label: COST_LABELS.bank_debit_fee, amount: 1 }])
  })
})
