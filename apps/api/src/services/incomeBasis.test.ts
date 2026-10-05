/**
 * S655 money plan, Step 3: "Money received" and "Money billed".
 *
 * Nic (10/2, binding): "Money received" is strictly the day money ARRIVED.
 * Paid-ahead money counts in full the day it arrives, on its own line, and $0
 * again when it pays a later bill. A credit the landlord gives is never income.
 * "Money billed" counts every bill in the month it was due, with what became
 * of it inside the total.
 *
 * The production cases (Todd, Kim, Russ, Glenda) are rebuilt here with the
 * amounts and days they have in production.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedLeaseFee,
} from '../test/dbHelpers'
import {
  parseIncomeBasis, incomeTotals, incomeEvents, categoryTotals, paidAheadUnusedAt, summarize,
} from './incomeBasis'
import { computeLandlordPL } from './landlordPL'
import { incomeCardMtd } from '../lib/rentCollected'
import { runWorkTradeSettlement } from '../jobs/workTradeSettlement'
import { hourRateFor } from './workTradeSettlement'
import { wonChargebackReturnSourceId } from './stripeCosts'

beforeEach(cleanupAllSchema)

interface W {
  userId: string; landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string
}

async function world(opts: { tz?: string; rent?: number } = {}): Promise<W> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.tz) await c.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, opts.tz])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: opts.rent ?? 460 })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: opts.rent ?? 460 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId }
  } finally { c.release() }
}

const ENTRY: Record<string, string> = {
  rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE', fee: 'OTHERFEE', home_payment: 'HOMEPMT',
  carried_balance: 'BALANCE', deposit: 'DEPOSIT',
}

/** A charge on the world's lease. Settled when `settledAt` is given. */
async function charge(w: W, o: {
  type?: string; amount: number; due: string; status?: string; settledAt?: string
  entry?: string; owner?: string; manual?: string | null; leaseFeeId?: string | null
  stripeCharge?: string | null; flexpayAdvanceId?: string | null; workTrade?: boolean
}): Promise<string> {
  const type = o.type ?? 'rent'
  const status = o.status ?? (o.settledAt ? 'settled' : 'pending')
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, manual_method, revenue_owner, lease_fee_id, stripe_charge_id,
                           flexpay_advance_id, work_trade_suspended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::timestamptz,$11,$12,$13,$14,$15,
             CASE WHEN $16::boolean THEN now() END)
     RETURNING id`,
    [w.unitId, w.leaseId, w.tenantId, w.landlordId, type, o.amount, status, o.entry ?? ENTRY[type] ?? 'OTHERFEE',
     o.due, o.settledAt ?? null, o.manual ?? null, o.owner ?? 'landlord', o.leaseFeeId ?? null,
     o.stripeCharge ?? null, o.flexpayAdvanceId ?? null, o.workTrade === true])
  return r.rows[0].id
}

async function settle(id: string, at: string, manual: string | null = null): Promise<void> {
  await db.query(`UPDATE payments SET status = 'settled', settled_at = $2::timestamptz, manual_method = $3 WHERE id = $1`,
    [id, at, manual])
}

/** Paid-ahead money that arrived on `receivedAt`. */
async function paidAhead(w: W, o: {
  amount: number; receivedAt: string; fundedBy?: 'landlord' | 'gam' | 'reclassified'; sourcePaymentId?: string
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                        received_at, created_at, source_payment_id)
     VALUES ($1,$2,$3,$3,$4,$5::timestamptz,$5::timestamptz,$6) RETURNING id`,
    [w.leaseId, w.tenantId, o.amount, o.fundedBy ?? 'landlord', o.receivedAt, o.sourcePaymentId ?? null])
  return r.rows[0].id
}

/** A credit the landlord issued (or GAM-funded deposit interest). */
async function issuedCredit(w: W, amount: number, category = 'other'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
     VALUES ($1,$2,$3,$4,$4,$5,'test') RETURNING id`,
    [w.landlordId, w.tenantId, w.leaseId, amount, category])
  return r.rows[0].id
}

/** Spend a credit on a charge that is still open (the ledger trigger checks it). */
async function use(w: W, o: {
  prepaid?: string; issued?: string; paymentId?: string; depositReturnId?: string
  amount: number; at: string; source?: string
}): Promise<void> {
  await db.query(
    `INSERT INTO credit_uses (prepaid_credit_id, tenant_credit_id, payment_id, deposit_return_id, lease_id, amount,
                              billing_month, source, status, held_at, applied_at)
     VALUES ($1,$2,$3,$4,$5,$6, date_trunc('month', $7::timestamptz AT TIME ZONE 'America/Phoenix')::date,
             $8, 'applied', $7::timestamptz, $7::timestamptz)`,
    [o.prepaid ?? null, o.issued ?? null, o.paymentId ?? null, o.depositReturnId ?? null, w.leaseId, o.amount, o.at,
     o.source ?? (o.depositReturnId ? 'move_out' : 'whole_bill')])
}

const tot = (w: W, basis: 'received' | 'billed', start: string, end: string) =>
  incomeTotals({ landlordIds: [w.landlordId], start, end, basis })

describe('the basis switch', () => {
  it('defaults to Money received and refuses anything else with a 400', () => {
    expect(parseIncomeBasis(undefined)).toBe('received')
    expect(parseIncomeBasis('')).toBe('received')
    expect(parseIncomeBasis('Billed')).toBe('billed')
    expect(() => parseIncomeBasis('cash')).toThrow(/basis must be one of/)
    try { parseIncomeBasis('accrual') } catch (e: any) { expect(e.statusCode).toBe(400) }
  })
})

describe('the production cases', () => {
  it('Todd: $920 check Sep 18 → received Sep $920 ($460 rent + $460 paid ahead) / Oct $0; billed Oct $460 covered by money paid ahead', async () => {
    const w = await world()
    const sep = await charge(w, { amount: 460, due: '2026-09-01' })
    await settle(sep, '2026-09-18T13:04:41-07:00', 'check')
    const credit = await paidAhead(w, { amount: 460, receivedAt: '2026-09-18T13:04:41-07:00' })
    const oct = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { prepaid: credit, paymentId: oct, amount: 460, at: '2026-10-01T07:00:00-07:00' })
    await settle(oct, '2026-10-01T07:00:00-07:00')

    const rSep = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(rSep.total).toBe(920)
    expect(rSep.lines.rent).toBe(460)
    expect(rSep.lines.paidAhead).toBe(460)
    const rOct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(rOct.total).toBe(0)
    expect(rOct.lines.rent).toBe(0)

    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(bOct.total).toBe(460)
    expect(bOct.parts.coveredByPaidAhead).toBe(460)
    expect(bOct.parts.paid).toBe(0)
    const bSep = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(bSep.total).toBe(460)
    expect(bSep.parts.paid).toBe(460)
    // The paid-ahead money is not billed income on arrival.
    expect(bSep.lines.paidAhead).toBe(0)
  })

  it('Kim: $935.45 of bills, a $450 move-in special and a $485.45 money order typed as $486 → received $486 while the $0.55 stood as paid ahead, $485.45 once it is withdrawn; billed $935.45 − $450 credits given', async () => {
    // Production: the money order paid $485.45 of her bills, and the desk
    // banked a $0.55 "surplus" as paid-ahead money (4cd989a7) the same second.
    // Nic, 10/3: the money order was $485.45, typed in as $486.00 — nothing was
    // paid ahead; P2 withdraws the $0.55 (voided_at + reason).
    const w = await world({ rent: 900 })
    const at = '2026-09-09T11:27:54-07:00'
    const rent = await charge(w, { amount: 900, due: '2026-09-01' })
    const water = await charge(w, { type: 'utility', amount: 10.45, due: '2026-09-01' })
    const fee = await charge(w, { type: 'fee', amount: 25, due: '2026-09-01' })
    const special = await issuedCredit(w, 450)
    await use(w, { issued: special, paymentId: rent, amount: 450, at, source: 'desk' })
    for (const id of [rent, water, fee]) await settle(id, at, 'money_order')
    const roundUp = await paidAhead(w, { amount: 0.55, receivedAt: at, fundedBy: 'landlord' })

    // As recorded: Money received is the day money ARRIVED, so the $0.55
    // counts in September on its own line.
    const asRecorded = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(asRecorded.total).toBe(486)
    expect(asRecorded.lines.rent).toBe(450)
    expect(asRecorded.lines.utilities).toBe(10.45)
    expect(asRecorded.lines.fees).toBe(25)
    expect(asRecorded.lines.paidAhead).toBe(0.55)
    expect(asRecorded.beside.creditsYouGave).toBe(450)

    // Withdrawn (Nic, 10/3): it never arrived, so it never counts.
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = $2::timestamptz, void_reason = 'typed round-up' WHERE id = $1`,
      [roundUp, '2026-10-03T12:00:00-07:00'])
    const r = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(r.total).toBe(485.45)
    expect(r.lines.rent).toBe(450)
    expect(r.lines.paidAhead).toBe(0)
    expect(r.paidAheadUnused).toBe(0)
    expect(r.beside.creditsYouGave).toBe(450)

    // Money billed is the same either way: the bills, less the credit she was given.
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.total).toBe(485.45)
    expect(b.lines.rent).toBe(900)
    expect(b.lines.creditsGiven).toBe(-450)
    expect(b.lines.rent + b.lines.utilities + b.lines.fees).toBe(935.45)
    expect(b.parts.paid).toBe(485.45)
  })

  it('Russ: $37.60 paid ahead Aug 12 counts on Aug 12 and $0 when it pays the Oct 1 bills; only his new cash counts in October', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 37.60, receivedAt: '2026-08-12T10:00:00-07:00' })
    const water = await charge(w, { type: 'utility', amount: 5.22, due: '2026-10-01' })
    const trash = await charge(w, { type: 'fee', amount: 25, due: '2026-10-01' })
    const rent = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { prepaid: credit, paymentId: water, amount: 5.22, at: '2026-10-01T07:00:01-07:00' })
    await use(w, { prepaid: credit, paymentId: trash, amount: 25, at: '2026-10-01T07:00:01-07:00' })
    await settle(water, '2026-10-01T07:00:01-07:00')
    await settle(trash, '2026-10-01T07:00:01-07:00')
    await use(w, { prepaid: credit, paymentId: rent, amount: 7.38, at: '2026-10-01T17:03:42-07:00', source: 'desk' })
    await settle(rent, '2026-10-01T17:03:42-07:00', 'cash')
    // The desk banked $0.88 of his cash as paid ahead at the same moment.
    await paidAhead(w, { amount: 0.88, receivedAt: '2026-10-01T17:03:42-07:00' })

    const aug = await tot(w, 'received', '2026-08-01', '2026-08-31')
    expect(aug.total).toBe(37.60)
    expect(aug.lines.paidAhead).toBe(37.60)
    const oct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    // $452.62 of cash on the rent + $0.88 banked = the $453.50 he handed over.
    expect(oct.lines.rent).toBe(452.62)
    expect(oct.lines.utilities).toBe(0)
    expect(oct.lines.fees).toBe(0)
    expect(oct.lines.paidAhead).toBe(0.88)
    expect(oct.total).toBe(453.50)
  })

  it('Glenda: a posted check counts on Sep 22 when it arrived and $0 when it pays October', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 460, receivedAt: '2026-09-22T13:50:13-07:00' })
    const oct = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { prepaid: credit, paymentId: oct, amount: 460, at: '2026-10-01T07:00:00-07:00' })
    await settle(oct, '2026-10-01T07:00:00-07:00')
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).total).toBe(460)
    expect((await tot(w, 'received', '2026-10-01', '2026-10-31')).total).toBe(0)
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.total).toBe(460)
    expect(b.parts.coveredByPaidAhead).toBe(460)
  })
})

describe('Money received', () => {
  it('card pay-ahead held by GAM counts the day it arrives and $0 when it pays a bill', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 100, receivedAt: '2026-09-20T10:00:00-07:00', fundedBy: 'gam' })
    const oct = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { prepaid: credit, paymentId: oct, amount: 100, at: '2026-10-03T10:00:00-07:00', source: 'desk' })
    await db.query(`UPDATE payments SET stripe_charge_id = 'ch_x' WHERE id = $1`, [oct])
    await settle(oct, '2026-10-03T10:00:00-07:00')
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).lines.paidAhead).toBe(100)
    const o = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(o.lines.rent).toBe(360)
    expect(o.total).toBe(360)
  })

  it('deposit interest counts when used', async () => {
    const w = await world()
    const interest = await issuedCredit(w, 12.5, 'deposit_interest')
    const oct = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { issued: interest, paymentId: oct, amount: 12.5, at: '2026-10-02T10:00:00-07:00', source: 'desk' })
    await settle(oct, '2026-10-02T10:00:00-07:00', 'cash')
    const r = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r.total).toBe(460)          // $447.50 cash + $12.50 GAM-funded interest
    expect(r.beside.creditsYouGave).toBe(0)
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.parts.coveredByDepositInterest).toBe(12.5)
    expect(b.parts.paid).toBe(447.5)
    expect(b.lines.creditsGiven).toBe(0)
  })

  it('a non-refundable pet-deposit fee is fee income; a move-out refund row is never income', async () => {
    const w = await world()
    const c = await db.connect()
    let petFee: string
    try { petFee = await seedLeaseFee(c, { leaseId: w.leaseId, feeType: 'pet_deposit', amount: 300, dueTiming: 'move_in' }) }
    finally { c.release() }
    await charge(w, { type: 'fee', entry: 'DEPOSIT', leaseFeeId: petFee!, amount: 300, due: '2026-09-01',
                      settledAt: '2026-09-02T10:00:00-07:00' })
    await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: -250, due: '2026-09-15',
                      settledAt: '2026-09-16T10:00:00-07:00' })
    for (const basis of ['received', 'billed'] as const) {
      const t = await tot(w, basis, '2026-09-01', '2026-09-30')
      expect(t.lines.fees).toBe(300)
      expect(t.total).toBe(300)
    }
    const pl = await computeLandlordPL(w.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'])
    expect(pl.gross.fees).toBe(300)
  })

  it('a GAM fee row is never landlord income', async () => {
    const w = await world()
    await charge(w, { type: 'fee', entry: 'DECLINEFEE', owner: 'gam', amount: 6, due: '2026-09-05',
                      settledAt: '2026-09-05T10:00:00-07:00' })
    await charge(w, { type: 'platform_fee', entry: 'SUBSCRIP', owner: 'gam', amount: 10, due: '2026-09-01',
                      settledAt: '2026-09-02T10:00:00-07:00' })
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(w, basis, '2026-09-01', '2026-09-30')).total).toBe(0)
    }
  })

  it('a Chicago property is dated by its own day', async () => {
    const w = await world({ tz: 'America/Chicago' })
    // 00:30 on Oct 1 in Chicago is still Sept 30 in Phoenix.
    await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-01T00:30:00-05:00' })
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).total).toBe(0)
    expect((await tot(w, 'received', '2026-10-01', '2026-10-31')).total).toBe(460)
  })

  it('money still clearing is beside the total, never inside it', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-10-01', status: 'processing' })
    await db.query(`UPDATE payments SET processed_at = '2026-10-02T10:00:00-07:00'`)
    const r = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r.total).toBe(0)
    expect(r.beside.clearing).toBe(460)
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.total).toBe(460)
    expect(b.parts.clearing).toBe(460)
  })

  it('paid ahead, not used yet at the period end counts what arrived by then less what was spent by then', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 920, receivedAt: '2026-12-20T10:00:00-07:00' })
    const jan = await charge(w, { amount: 460, due: '2027-01-01' })
    await use(w, { prepaid: credit, paymentId: jan, amount: 460, at: '2027-01-01T07:00:00-07:00' })
    await settle(jan, '2027-01-01T07:00:00-07:00')
    expect(await paidAheadUnusedAt({ landlordIds: [w.landlordId], end: '2026-12-31' })).toBe(920)
    expect(await paidAheadUnusedAt({ landlordIds: [w.landlordId], end: '2027-01-31' })).toBe(460)
    expect(await paidAheadUnusedAt({ landlordIds: [w.landlordId], end: '2026-12-19' })).toBe(0)
  })
})

describe('stays, disputes, deposits', () => {
  it('shortened stay: no line under received (the money arrived once), negative on the anchor bill’s due date under billed; its later use counts $0; paid-ahead money returned at move-out is negative that day', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    // Oct 28: the stay is shortened to end Oct 31; November's rent becomes credit.
    const credit = await paidAhead(w, { amount: 460, receivedAt: '2026-10-28T10:00:00-07:00', fundedBy: 'reclassified', sourcePaymentId: nov })

    const rOct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(rOct.total).toBe(460)               // the rent money that arrived Oct 25
    expect(rOct.lines.stayShortened).toBe(0)
    expect(rOct.lines.paidAhead).toBe(0)       // reclassified rent is not new money
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bNov.lines.stayShortened).toBe(-460)
    expect(bNov.total).toBe(0)                 // the November bill and its reclassification

    // A later bill the credit pays counts $0 received, covered-by-paid-ahead billed.
    const fee = await charge(w, { type: 'fee', amount: 60, due: '2026-11-05' })
    await use(w, { prepaid: credit, paymentId: fee, amount: 60, at: '2026-11-05T10:00:00-07:00' })
    await settle(fee, '2026-11-05T10:00:00-07:00')
    expect((await tot(w, 'received', '2026-11-01', '2026-11-30')).total).toBe(0)
    expect((await tot(w, 'billed', '2026-11-01', '2026-11-30')).parts.coveredByPaidAhead).toBe(60)

    // Move-out Nov 20: the remaining $400 joins the settlement and goes back.
    const dr = await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount,
                                    status, finalized_at)
       VALUES ($1,$2,$3,0,0,400,'sent_refund','2026-11-20T10:00:00-07:00') RETURNING id`,
      [w.leaseId, w.tenantId, w.landlordId])
    await use(w, { prepaid: credit, depositReturnId: dr.rows[0].id, amount: 400, at: '2026-11-20T10:00:00-07:00' })
    const rNov = await tot(w, 'received', '2026-11-01', '2026-11-30')
    expect(rNov.lines.paidAheadRefunded).toBe(-400)
    expect(rNov.total).toBe(-400)
  })

  it('a dispute after month close leaves the old month alone, posts a negative of the money part in the dispute month, and billed counts the original minus that plus the reopened row', async () => {
    const w = await world()
    const sep = await charge(w, { amount: 460, due: '2026-09-01', stripeCharge: 'ch_1' })
    await settle(sep, '2026-09-03T10:00:00-07:00')
    const septBefore = await tot(w, 'received', '2026-09-01', '2026-09-30')
    // Oct 10: the card is disputed. One reversal record; the row goes 'returned'
    // and a fresh pending row at what it lost is opened on the same due date.
    const rev = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',460,'evt_dispute_1','{}','2026-10-10T10:00:00-07:00') RETURNING id`,
      [sep, w.landlordId, w.tenantId, w.leaseId])
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [sep])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','RENT','2026-09-01',$5)`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, rev.rows[0].id])

    const septAfter = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(septAfter.total).toBe(septBefore.total)
    expect(septAfter.total).toBe(460)
    const oct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(oct.lines.returned).toBe(-460)
    const billed = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(billed.total).toBe(460)           // 460 − 460 on the original + 460 reopened
    expect(billed.parts.stillOwed).toBe(460)
    expect(billed.parts.paid).toBe(0)
  })

  it('a credit-assisted row disputed: the issued part stays a credit given; net received equals the paid-ahead part', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 60, receivedAt: '2026-08-20T10:00:00-07:00' })
    const goodwill = await issuedCredit(w, 100, 'goodwill')
    const sep = await charge(w, { amount: 460, due: '2026-09-01' })
    await use(w, { prepaid: credit, paymentId: sep, amount: 60, at: '2026-09-03T10:00:00-07:00', source: 'desk' })
    await use(w, { issued: goodwill, paymentId: sep, amount: 100, at: '2026-09-03T10:00:00-07:00', source: 'desk' })
    await db.query(`UPDATE payments SET stripe_charge_id = 'ch_2' WHERE id = $1`, [sep])
    await settle(sep, '2026-09-03T10:00:00-07:00')
    const rev = await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, reversal_type, reversed_amount, stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,'card_dispute',300,'evt_dispute_2','{}','2026-10-05T10:00:00-07:00') RETURNING id`,
      [sep, w.landlordId])
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [sep])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
       VALUES ($1,$2,$3,$4,'rent',300,'pending','RENT','2026-09-01',$5)`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, rev.rows[0].id])

    const allTime = await tot(w, 'received', '2026-08-01', '2026-10-31')
    expect(allTime.total).toBe(60)                  // +60 Aug, +300 Sep, −300 Oct
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.lines.creditsGiven).toBe(-100)
    expect(b.total).toBe(360)                       // 460 − 100 credit given
    expect(b.parts.coveredByPaidAhead).toBe(60)
    expect(b.parts.stillOwed).toBe(300)
  })

  it('deposit return: received kept = deductions − shortfall; billed deductions in full; gap row excluded; refund row never', async () => {
    const w = await world()
    const swept = await charge(w, { amount: 200, due: '2026-10-01', status: 'paid_via_deposit', settledAt: '2026-10-15T10:00:00-07:00' })
    expect(swept).toBeTruthy()
    const gap = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: 50, due: '2026-10-15' })
    const refund = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: -20, due: '2026-10-15', settledAt: '2026-10-15T11:00:00-07:00' })
    expect(refund).toBeTruthy()
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, total_deductions, gap_amount, gap_payment_id, status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[{"description":"Hole","amount":150}]','[]',450,50,$4,'sent_gap','2026-10-15T10:00:00-07:00')`,
      [w.leaseId, w.tenantId, w.landlordId, gap])

    const r = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r.lines.keptFromDeposits).toBe(200)
    expect(r.lines.depositDeductions).toBe(200)       // 250 − 50 shortfall still owed
    expect(r.lines.depositShortfall).toBe(0)
    expect(r.lines.fees).toBe(0)                       // neither move-out row is a fee
    expect(r.total).toBe(400)
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.lines.depositDeductions).toBe(250)
    expect(b.lines.rent).toBe(200)
    expect(b.parts.keptFromDeposit).toBe(400)          // the swept rent + 200 of deductions
    expect(b.parts.stillOwed).toBe(50)
    expect(b.total).toBe(450)

    await settle(gap, '2026-10-20T10:00:00-07:00')
    const r2 = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r2.lines.depositShortfall).toBe(50)
    expect(r2.total).toBe(450)
    const b2 = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b2.total).toBe(450)
    expect(b2.parts.stillOwed).toBe(0)
    expect(b2.parts.paid).toBe(50)
  })

  it('a move-out gap from unpaid rent shows the whole gap as still owed and kept-from-deposit equals the deposit pool', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of rent never paid, swept to the $400 deposit at move-out.
    for (const [due, amt] of [['2026-08-01', 200], ['2026-09-01', 250], ['2026-10-01', 250]] as const) {
      await charge(w, { amount: amt, due, status: 'paid_via_deposit', settledAt: fin })
    }
    // Deductions $100 cleaning + $700 swept = $800 against a $400 pool: the gap
    // is $400 — larger than the $100 of cleaning.
    const gap = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: 400, due: '2026-10-15' })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5)`,
      [w.leaseId, w.tenantId, w.landlordId, gap, fin])

    const r = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r.lines.keptFromDeposits).toBe(400)        // what the pool held — never more
    expect(r.lines.depositDeductions).toBe(0)
    expect(r.total).toBe(400)
    const b = await tot(w, 'billed', '2026-08-01', '2026-10-31')
    expect(b.total).toBe(800)                          // every bill, in full
    expect(b.lines.depositDeductions).toBe(100)
    expect(b.parts.keptFromDeposit).toBe(400)          // the deposit pool
    expect(b.parts.stillOwed).toBe(400)                // the whole gap
    expect(b.beside.collectedSoFar).toBe(400)

    // The property breakdown agrees: the shortfall goes to the cleaning first
    // ($100), the rest to the rent it swept ($300), so lot rent is $400 kept
    // and $300 still owed — not $700 collected.
    const rentRow = (bd: Awaited<ReturnType<typeof categoryTotals>>) => bd.categories.find(c => c.category === 'space_rent')!
    const rc = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'received' })
    expect(rentRow(rc).collected).toBe(400)
    expect(rc.total).toBe(400)
    const bc = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-08-01', end: '2026-10-31', basis: 'billed' })
    expect(rentRow(bc)).toMatchObject({ billed: 700, collected: 400, stillOwed: 300 })
    expect(bc.total).toBe(800)

    // The tenant pays the gap: it counts the day it arrives, and nothing is owed.
    await settle(gap, '2026-10-20T10:00:00-07:00')
    const r2 = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r2.lines.depositShortfall).toBe(400)
    expect(r2.total).toBe(800)
    const b2 = await tot(w, 'billed', '2026-08-01', '2026-10-31')
    expect(b2.parts.stillOwed).toBe(0)
    expect(b2.parts.paid).toBe(400)
    expect(b2.parts.keptFromDeposit).toBe(400)

    // ... and the two bases agree on what the rent collected: the $300 of the
    // gap that was the swept rent's is lot rent under Money received too; only
    // the cleaning's $100 stays an uncategorized "Deposit shortfall collected".
    const rc2 = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'received' })
    expect(rentRow(rc2).collected).toBe(700)
    expect(rc2.lines).toEqual([{ line: 'depositShortfall', label: 'Deposit shortfall collected', amount: 100 }])
    expect(rc2.total).toBe(800)
    const bc2 = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-08-01', end: '2026-10-31', basis: 'billed' })
    expect(rentRow(bc2)).toMatchObject({ billed: 700, collected: 700, stillOwed: 0 })
  })

  it('a paid shortfall is shared by the bills it swept, by category, to the cent', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // Three $100 bills swept to a $200 deposit, nothing else deducted: the
    // $100 gap is all theirs, a third each (33.33 / 33.33 / 33.34).
    const rents: string[] = []
    for (const due of ['2026-08-01', '2026-09-01']) rents.push(await charge(w, { amount: 100, due, status: 'paid_via_deposit', settledAt: fin }))
    const propane = await charge(w, { type: 'utility', entry: 'PROPANE', amount: 100, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    const gap = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: 100, due: '2026-10-15' })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,200,0,'[]','[]',300,300,100,$4,'sent_gap',$5)`,
      [w.leaseId, w.tenantId, w.landlordId, gap, fin])
    await settle(gap, '2026-10-20T10:00:00-07:00')

    const rx = await incomeEvents({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'received' })
    const paid = rx.filter(e => e.line === 'depositShortfall')
    expect(paid.every(e => e.paymentId === gap && e.inTotal)).toBe(true)
    expect(paid.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(100, 10)
    const byCat = (cat: string | null) => Math.round(paid.filter(e => e.category === cat).reduce((s, e) => s + e.amount, 0) * 100) / 100
    // Each bill's share is the same figure that came off it at move-out.
    const kept = (id: string) => rx.filter(e => e.paymentId === id).reduce((s, e) => s + e.amount, 0)
    for (const id of [...rents, propane]) expect([66.66, 66.67]).toContain(kept(id))
    expect(byCat('space_rent')).toBe(Math.round((200 - kept(rents[0]) - kept(rents[1])) * 100) / 100)
    expect(byCat('propane')).toBe(Math.round((100 - kept(propane)) * 100) / 100)
    expect(byCat(null)).toBe(0)
    expect(Math.round((byCat('space_rent') + byCat('propane')) * 100) / 100).toBe(100)
    // Every bill is whole again under Money received, as under Money billed.
    const r = summarize(rx, 'received')
    expect(r.total).toBe(300)
    const b = await tot(w, 'billed', '2026-08-01', '2026-10-31')
    expect(b.total).toBe(300)
    expect(b.parts.stillOwed).toBe(0)
  })

  it('a paid shortfall later disputed stays in its month; the dispute takes it back on its day, split the same way; the reopened row counts when paid', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of rent swept to a $400 deposit; $100 of cleaning; the $400 gap is paid by card on Oct 20.
    await charge(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    const gap = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: 400, due: '2026-10-15', stripeCharge: 'ch_gap' })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5)`,
      [w.leaseId, w.tenantId, w.landlordId, gap, fin])
    await settle(gap, '2026-10-20T10:00:00-07:00')
    const octBefore = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(octBefore.total).toBe(800)

    // Nov 5: the card is disputed in full; the gap row goes 'returned' and a
    // fresh $400 row is reopened.
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',400,'evt_gap','{}','2026-11-05T10:00:00-07:00') RETURNING id`,
      [gap, w.landlordId, w.tenantId, w.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [gap])
    const reopened = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
       VALUES ($1,$2,$3,$4,'fee',400,'pending','DEPOSIT','2026-10-15',$5) RETURNING id`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, rev])).rows[0].id

    // October is never rewritten.
    const octAfter = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(octAfter.total).toBe(800)
    expect(octAfter.lines.depositShortfall).toBe(400)
    // November: the $400 comes off — $300 of it the rent's, $100 the cleaning's.
    const novEv = await incomeEvents({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'received' })
    const nov = summarize(novEv, 'received')
    expect(nov.lines.returned).toBe(-400)
    expect(nov.total).toBe(-400)
    const novRent = novEv.filter(e => e.category === 'space_rent').reduce((s, e) => s + e.amount, 0)
    expect(novRent).toBe(-300)
    // Money billed: the shortfall is owed again.
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.total).toBe(800)
    expect(b.parts.stillOwed).toBe(400)
    expect(b.parts.paid).toBe(0)

    // Dec 3: the tenant pays the reopened row. It is new money that day, and nothing is owed.
    await settle(reopened, '2026-12-03T10:00:00-07:00', 'cash')
    const dec = await tot(w, 'received', '2026-12-01', '2026-12-31')
    expect(dec.lines.depositShortfall).toBe(400)
    expect(dec.total).toBe(400)
    const b2 = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b2.total).toBe(800)
    expect(b2.parts.stillOwed).toBe(0)
    expect(b2.parts.paid).toBe(400)
  })

  it('a renewal-chain move-out: the shortfall past the deductions comes off the bills it swept from the PREVIOUS lease, by category, to the cent', async () => {
    const w = await world()
    // The household renewed: the deposit and the move-out sit on the new lease;
    // the unpaid rent and utility sit on the previous one (the sweep reaches the chain).
    const c = await db.connect()
    let next = ''
    try {
      next = await seedLease(c, { unitId: w.unitId, landlordId: w.landlordId, rentAmount: 460 })
      await seedLeaseTenant(c, { leaseId: next, tenantId: w.tenantId })
    } finally { c.release() }
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [w.leaseId])
    await db.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [next, w.leaseId])
    const fin = '2026-10-15T10:00:00-07:00'
    const rent = await charge(w, { amount: 500, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    const utility = await charge(w, { type: 'utility', amount: 100, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    // $600 swept + $50 cleaning against a $400 pool: the gap is $250, $200 past the cleaning.
    const gap = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'fee',250,'pending','DEPOSIT','2026-10-15') RETURNING id`,
      [w.unitId, next, w.tenantId, w.landlordId])).rows[0].id
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,50,'[]','[]',600,650,250,$4,'sent_gap',$5) RETURNING id`,
      [next, w.tenantId, w.landlordId, gap, fin])).rows[0].id

    const q = { landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31' }
    const rx = await incomeEvents({ ...q, basis: 'received' })
    const kept = (id: string) => rx.filter(e => e.paymentId === id).reduce((s, e) => s + e.amount, 0)
    // The $200 is shared 500:100 — the rent carries $166.67, the utility $33.33.
    expect(kept(rent)).toBe(333.33)
    expect(kept(utility)).toBe(66.67)
    // Every fact of the move-out names it, whichever lease it sits on.
    expect(rx.filter(e => e.line === 'keptFromDeposits' || e.line === 'depositDeductions')
      .every(e => e.moveOutId === dr)).toBe(true)
    const r = summarize(rx, 'received')
    expect(r.lines.keptFromDeposits).toBe(400)         // what the pool held
    expect(r.lines.depositDeductions).toBe(0)
    expect(r.total).toBe(400)

    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.total).toBe(650)                           // every bill and the cleaning, in full
    expect(b.parts.keptFromDeposit).toBe(400)
    expect(b.parts.stillOwed).toBe(250)                 // the whole gap: $50 cleaning, $200 of the swept bills
    expect(b.lines.depositDeductions).toBe(50)
    expect(b.lines.keptFromDeposits).toBe(0)            // no uncategorized correction is left on the move-out
  })

  it('a dispute of a charge that created paid-ahead money: the spent part and the drained rest both come off on the dispute day; billed reopens only the reversed use', async () => {
    const w = await world()
    // Sep 3: one $660 card charge — September's $460 rent and $200 paid ahead (GAM holds it).
    const sep = await charge(w, { amount: 460, due: '2026-09-01', stripeCharge: 'ch_660' })
    await settle(sep, '2026-09-03T10:00:00-07:00')
    const credit = await paidAhead(w, { amount: 200, receivedAt: '2026-09-03T10:00:00-07:00', fundedBy: 'gam' })
    // October: $120 of it pays October's rent beside $340 of new card money.
    const oct = await charge(w, { amount: 460, due: '2026-10-01', stripeCharge: 'ch_340' })
    await use(w, { prepaid: credit, paymentId: oct, amount: 120, at: '2026-10-01T07:00:00-07:00', source: 'desk' })
    await settle(oct, '2026-10-03T10:00:00-07:00')

    // Nov 5: the $660 charge is disputed. The records Step 10 writes, one per
    // row (event + row). (One Stripe event; this test database still carries
    // the one-per-event key C0 drops, so each record gets its own event id.)
    const at = '2026-11-05T10:00:00-07:00'
    const reverse = async (paymentId: string, amount: number, eventId: string, due: string) => {
      const rev = await db.query<{ id: string }>(
        `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                        stripe_event_id, raw_event, created_at)
         VALUES ($1,$2,$3,$4,'card_dispute',$5,$6,'{}',$7) RETURNING id`,
        [paymentId, w.landlordId, w.tenantId, w.leaseId, amount, eventId, at])
      await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [paymentId])
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,$7)`,
        [w.unitId, w.leaseId, w.tenantId, w.landlordId, amount, due, rev.rows[0].id])
      return rev.rows[0].id
    }
    //   the row the charge paid loses its money part;
    const sepRev = await reverse(sep, 460, 'evt_dispute_660:sep', '2026-09-01')
    //   the spend of its paid-ahead money is undone (the ledger gives it back
    //   to the credit) and October's row reopens for that spend;
    await db.query(
      `UPDATE credit_uses SET status = 'reversed', released_at = $2::timestamptz, release_reason = 'funding_reversed'
        WHERE payment_id = $1`, [oct, at])
    await reverse(oct, 120, 'evt_dispute_660:oct', '2026-10-01')
    //   and the clawback drains the credit whole: the $80 never spent plus the $120 given back.
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_reversal_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,200,'2026-11-01','reversal','applied',$4::timestamptz,$4::timestamptz)`,
      [credit, sepRev, w.leaseId, at])
    const left = await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM lease_prepaid_credits WHERE id = $1`, [credit])
    expect(Number(left.rows[0].r)).toBe(0)

    // Money received: every month as it was, and the whole $660 off on Nov 5.
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).total).toBe(660)
    expect((await tot(w, 'received', '2026-10-01', '2026-10-31')).total).toBe(340)
    const nov = await tot(w, 'received', '2026-11-01', '2026-11-30')
    expect(nov.lines.returned).toBe(-660)
    expect(nov.total).toBe(-660)
    expect((await tot(w, 'received', '2026-08-01', '2026-12-31')).total).toBe(340)   // only the $340 that stayed
    // Money billed: September is owed again; October keeps its $340 and owes only the $120 spend.
    const bSep = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(bSep.total).toBe(460)
    expect(bSep.parts.stillOwed).toBe(460)
    expect(bSep.parts.paid).toBe(0)
    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(bOct.total).toBe(460)
    expect(bOct.parts.paid).toBe(340)
    expect(bOct.parts.coveredByPaidAhead).toBe(0)
    expect(bOct.parts.stillOwed).toBe(120)
    // Paid ahead, not used yet: $80 at the end of October, nothing once it is clawed back.
    expect(await paidAheadUnusedAt({ landlordIds: [w.landlordId], end: '2026-10-31' })).toBe(80)
    expect(await paidAheadUnusedAt({ landlordIds: [w.landlordId], end: '2026-11-30' })).toBe(0)
  })

  it('a reservation deposit left over after the arrival rent is "Moved to credit" under Money billed, never "Stay shortened"', async () => {
    const w = await world()
    // moveInBundle keeps the leftover as reclassified credit with no anchor row.
    await paidAhead(w, { amount: 58.06, receivedAt: '2026-09-14T10:00:00-07:00', fundedBy: 'reclassified' })
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.lines.movedToCredit).toBe(-58.06)
    expect(b.lines.stayShortened).toBe(0)
    const pl = await computeLandlordPL(w.landlordId, '2026-09-01', '2026-09-30', ['2026-09-01'], 'billed')
    expect(pl.lineItems).toEqual([{ line: 'movedToCredit', label: 'Moved to credit', amount: -58.06 }])
    // Money received adds no line: the deposit counted the day it was paid.
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).total).toBe(0)
  })
})

describe('register, stays and pay links', () => {
  async function sale(w: W, o: { subtotal: number; discount?: number; tax?: number; surcharge?: number; status?: string; method?: string; at: string; payLinkId?: string }) {
    const total = o.subtotal - (o.discount ?? 0) + (o.tax ?? 0) + (o.surcharge ?? 0)
    const r = await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, discount_amount, tax_amount,
                                     surcharge, total, status, property_id, created_at, pay_link_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12) RETURNING id`,
      [w.landlordId, w.userId, o.method ?? 'card', o.subtotal, o.discount ?? 0, o.tax ?? 0, o.surcharge ?? 0, total,
       o.status ?? 'completed', w.propertyId, o.at, o.payLinkId ?? null])
    return r.rows[0].id
  }

  it('register sale counts net of tax and card fee; refund negative at the pre-tax share; voided excluded', async () => {
    const w = await world()
    const tx = await sale(w, { subtotal: 100, discount: 10, tax: 7.2, surcharge: 3.71, at: '2026-09-10T10:00:00-07:00' })
    await sale(w, { subtotal: 50, tax: 4, status: 'voided', at: '2026-09-11T10:00:00-07:00' })
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, created_at)
       VALUES ($1,$2,48.60,'cash','2026-10-02T10:00:00-07:00')`, [tx, w.landlordId])
    for (const basis of ['received', 'billed'] as const) {
      const sep = await tot(w, basis, '2026-09-01', '2026-09-30')
      expect(sep.lines.registerAndStays).toBe(90)
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.lines.registerAndStays).toBe(-45)
    }
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'received' })
    expect(cats.categories.find(c => c.category === 'register_sales')!.amount).toBe(90)
  })

  it('a store charge (FlexCharge) is not money until its paydown settles', async () => {
    const w = await world()
    await sale(w, { subtotal: 80, method: 'charge', at: '2026-09-10T10:00:00-07:00' })
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).lines.registerAndStays).toBe(0)
  })

  it('an open one-time pay link is still owed under billed only', async () => {
    const w = await world()
    await db.query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                  tax_amount, total, customer_email, status, created_at)
       VALUES ('tok-open', $1, $2, $3, 'one_time', 'Propane', '[]', 40, 0, 3, 43, 'g@t.dev', 'open', '2026-09-12T10:00:00-07:00')`,
      [w.landlordId, w.propertyId, w.userId])
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.lines.registerAndStays).toBe(40)
    expect(b.parts.stillOwed).toBe(40)
    expect((await tot(w, 'received', '2026-09-01', '2026-09-30')).total).toBe(0)
  })

  it('a public stay deposit counts once', async () => {
    const w = await world()
    const b = await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, deposit_amount, deposit_paid_at)
       VALUES ($1,$2,'2026-09-20','2026-09-25','nightly','confirmed',150,'2026-09-14T10:00:00-07:00') RETURNING id`,
      [w.unitId, w.landlordId])
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1,'booking_deposit',$2,150,'Stay deposit')`, [w.landlordId, b.rows[0].id])
    // A stay paid at the register is its sale, not a second deposit.
    const tx = await sale(w, { subtotal: 200, at: '2026-09-15T10:00:00-07:00' })
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, deposit_amount,
                                  deposit_paid_at, pos_transaction_id)
       VALUES ($1,$2,'2026-09-26','2026-09-28','nightly','confirmed',200,'2026-09-15T10:00:00-07:00',$3)`,
      [w.unitId, w.landlordId, tx])
    const r = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(r.lines.registerAndStays).toBe(350)
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'received' })
    expect(cats.categories.find(c => c.category === 'stays_and_pay_links')!.amount).toBe(350)
    expect(cats.categories.find(c => c.category === 'register_sales')!.amount).toBe(0)
  })

  it('a register chargeback takes off only the sale’s pre-tax share, at its property; Stripe’s fee and the card fee sit beside the total', async () => {
    const w = await world()
    const tx = await sale(w, { subtotal: 100, tax: 8, surcharge: 3.83, at: '2026-09-10T10:00:00-07:00' })
    await db.query(`UPDATE pos_transactions SET stripe_payment_intent_id = 'pi_sale' WHERE id = $1`, [tx])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('dp_sale', 'ch_sale', 'pi_sale', 111.83, 'needs_response')`)
    // recordChargeback: the whole $111.83 charge plus Stripe's $15 fee, netted from the next payout.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1, 'dispute', 'dp_sale', -126.83, 'Chargeback on a register sale', '2026-10-04T10:00:00-07:00')`,
      [w.landlordId])
    for (const basis of ['received', 'billed'] as const) {
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.lines.registerAndStays).toBe(-100)    // what the sale added, no more
      expect(oct.total).toBe(-100)
      expect(oct.beside.chargebackFees).toBe(18.83)   // Stripe's $15 + the buyer's $3.83 card fee
      const atProperty = await incomeTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-10-31', basis,
                                              propertyIds: [w.propertyId] })
      expect(atProperty.lines.registerAndStays).toBe(0) // the sale and its chargeback, both at the property
    }
  })

  it('a won register chargeback\'s return line adds back only the sale\'s pre-tax share on its own day; the fees come off chargeback fees', async () => {
    const w = await world()
    const tx = await sale(w, { subtotal: 100, tax: 8, surcharge: 3.83, at: '2026-09-10T10:00:00-07:00' })
    await db.query(`UPDATE pos_transactions SET stripe_payment_intent_id = 'pi_sale_won' WHERE id = $1`, [tx])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('dp_sale_won', 'ch_sale_won', 'pi_sale_won', 111.83, 'won')`)
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1, 'dispute', 'dp_sale_won', -126.83, 'Chargeback on a register sale', '2026-10-04T10:00:00-07:00')`,
      [w.landlordId])
    // Won in November, and Stripe gave its $15 back too: the payee gets $126.83 back.
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1, 'dispute', $2, 126.83, 'Chargeback won', '2026-11-05T10:00:00-07:00')`,
      [w.landlordId, wonChargebackReturnSourceId('dp_sale_won')])
    for (const basis of ['received', 'billed'] as const) {
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.lines.registerAndStays).toBe(-100)     // the chargeback's month never changes
      expect(oct.beside.chargebackFees).toBe(18.83)
      const nov = await tot(w, basis, '2026-11-01', '2026-11-30')
      expect(nov.lines.registerAndStays).toBe(100)      // the sale's pre-tax share, never the whole $126.83
      expect(nov.total).toBe(100)
      expect(nov.beside.chargebackFees).toBe(-18.83)    // Stripe's $15 and the card fee, back
      const atProperty = await incomeTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-11-30', basis,
                                              propertyIds: [w.propertyId] })
      expect(atProperty.lines.registerAndStays).toBe(100) // the sale stands, at its property
      expect(atProperty.beside.chargebackFees).toBe(0)
    }
  })

  it('a won register chargeback whose $15 Stripe kept: the return line gives back the sale and the card fee, and Stripe\'s $15 stays a chargeback fee', async () => {
    const w = await world()
    const tx = await sale(w, { subtotal: 100, tax: 8, surcharge: 3.83, at: '2026-09-10T10:00:00-07:00' })
    await db.query(`UPDATE pos_transactions SET stripe_payment_intent_id = 'pi_sale_kept' WHERE id = $1`, [tx])
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('dp_sale_kept', 'ch_sale_kept', 'pi_sale_kept', 111.83, 'won')`)
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1, 'dispute', 'dp_sale_kept', -126.83, 'Chargeback on a register sale', '2026-10-04T10:00:00-07:00'),
              ($1, 'dispute', $2, 111.83, 'Chargeback won', '2026-10-20T10:00:00-07:00')`,
      [w.landlordId, wonChargebackReturnSourceId('dp_sale_kept')])
    const oct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(oct.lines.registerAndStays).toBe(0)
    expect(oct.beside.chargebackFees).toBe(15)
  })

  it('a public stay deposit counts at its pre-tax share, as a register stay does', async () => {
    const w = await world()
    await db.query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [w.propertyId])
    const book = async (checkIn: string, checkOut: string, deposit: number, paidAt: string) => {
      const b = await db.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status, deposit_amount, deposit_paid_at)
         VALUES ($1,$2,$3::date,$4::date,'nightly','confirmed',$5,$6::timestamptz) RETURNING id`,
        [w.unitId, w.landlordId, checkIn, checkOut, deposit, paidAt])
      await db.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
         VALUES ($1,'booking_deposit',$2,$3,'Stay deposit')`, [w.landlordId, b.rows[0].id, deposit])
    }
    // 5 nights, taxed at 10%: a $110 deposit is $100 of stay and $10 of its tax.
    await book('2026-09-20', '2026-09-25', 110, '2026-09-14T10:00:00-07:00')
    // 35 nights: a long stay is not taxed, so its whole deposit is the stay's.
    await book('2026-10-01', '2026-11-05', 500, '2026-09-15T10:00:00-07:00')
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(w, basis, '2026-09-01', '2026-09-30')).lines.registerAndStays).toBe(600)
    }
  })

  it('two open links on one reservation are billed once, and a link past its expiry not at all', async () => {
    const w = await world()
    const booking = await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, lease_type, status)
       VALUES ($1,$2,'2026-09-20','2026-09-25','nightly','tentative') RETURNING id`, [w.unitId, w.landlordId])
    const link = (token: string, subtotal: number, createdAt: string, o: { bookingId?: string; expiresAt?: string } = {}) =>
      db.query(
        `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                    tax_amount, total, customer_email, status, booking_id, expires_at, created_at)
         VALUES ($1,$2,$3,$4,'one_time','Stay','[]',$5,0,0,$5,'g@t.dev','open',$6,$7::timestamptz,$8::timestamptz)`,
        [token, w.landlordId, w.propertyId, w.userId, subtotal, o.bookingId ?? null, o.expiresAt ?? null, createdAt])
    await link('tok-a', 200, '2026-09-10T10:00:00-07:00', { bookingId: booking.rows[0].id })
    await link('tok-b', 180, '2026-09-12T10:00:00-07:00', { bookingId: booking.rows[0].id })   // the newest one counts
    await link('tok-c', 75, '2026-09-13T10:00:00-07:00', { expiresAt: '2026-09-20T10:00:00-07:00' })   // expired
    await link('tok-d', 40, '2026-09-14T10:00:00-07:00')
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.lines.registerAndStays).toBe(220)
    expect(b.parts.stillOwed).toBe(220)
  })
})

describe('the payout lines a rent dispute writes', () => {
  /**
   * October rent of $1,000 paid by bank on Oct 2 (one remittance, pi_rent),
   * then disputed: paymentReversal moves the landlord's own share between
   * payouts on 'owner_share_…' lines and nets the $6 bank fee on a
   * 'stripe_fee_kept:<charge>:<landlord>' line (all source 'dispute').
   */
  async function disputedRent(w: W): Promise<void> {
    const rent = await charge(w, { amount: 1000, due: '2026-10-01', settledAt: '2026-10-02T10:00:00-07:00' })
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,1000,1000,0,'settled','ach',1006,6,'pi_rent','2026-10-02T10:00:00-07:00')`,
      [w.tenantId, w.leaseId, w.landlordId])
    const rev = '00000000-0000-4000-8000-000000000001'
    for (const [source, amount] of [
      [`owner_share_untouched:${rev}`, 300],
      [`owner_share_withheld:${rev}`, -700],
      [`owner_share_returned:${rev}`, 700],
      [`stripe_fee_kept:pi_rent:${w.landlordId}`, -6],
    ] as const) {
      await db.query(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
         VALUES ($1, 'dispute', $2, $3, 'test', '2026-10-05T10:00:00-07:00')`,
        [w.landlordId, source, amount])
    }
    expect(rent).toBeTruthy()
  }

  it("a rent dispute's owner-share lines are never a register sale under either basis", async () => {
    const w = await world()
    await disputedRent(w)
    for (const basis of ['received', 'billed'] as const) {
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.lines.registerAndStays).toBe(0)
      expect(oct.lines.rent).toBe(1000)
      expect(oct.total).toBe(1000)
    }
  })

  it("a rent dispute's kept fee shows as a chargeback fee beside the total, at the rent's property", async () => {
    const w = await world()
    await disputedRent(w)
    for (const basis of ['received', 'billed'] as const) {
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.beside.chargebackFees).toBe(6)
      expect(oct.total).toBe(1000)
      const atProperty = await incomeTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis,
                                              propertyIds: [w.propertyId] })
      expect(atProperty.beside.chargebackFees).toBe(6)
      expect(atProperty.lines.registerAndStays).toBe(0)
    }
  })

  /** A rent dispute's kept-fee payout line, on its day. */
  const feeLine = (w: W, pi: string, amount: number, at: string) => db.query(
    `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
     VALUES ($1, 'dispute', $2, $3, 'test', $4::timestamptz)`,
    [w.landlordId, `stripe_fee_kept:${pi}:${w.landlordId}`, -amount, at])

  it("a rent dispute's fee on a charge with no remittance is found at the rent's property through the row that carries the charge", async () => {
    const w = await world()
    const rent = await charge(w, { amount: 1000, due: '2026-10-01', settledAt: '2026-10-02T10:00:00-07:00' })
    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_direct' WHERE id = $1`, [rent])
    await feeLine(w, 'pi_direct', 6, '2026-10-05T10:00:00-07:00')
    for (const basis of ['received', 'billed'] as const) {
      const atProperty = await incomeTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis,
                                              propertyIds: [w.propertyId] })
      expect(atProperty.beside.chargebackFees).toBe(6)
      expect(atProperty.lines.registerAndStays).toBe(0)
    }
  })

  it("a rent dispute's fee is found at the property of this landlord's row when the household's payment was recorded under another landlord", async () => {
    const w = await world()
    const other = await world()
    const rent = await charge(w, { amount: 500, due: '2026-10-01', settledAt: '2026-10-02T10:00:00-07:00' })
    // One household payment, its remittance under the other landlord, paying this landlord's row too.
    const r = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,1000,1000,0,'settled','ach',1006,6,'pi_split','2026-10-02T10:00:00-07:00') RETURNING id`,
      [other.tenantId, other.leaseId, other.landlordId])
    await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 500)`,
      [r.rows[0].id, rent])
    await feeLine(w, 'pi_split', 3, '2026-10-05T10:00:00-07:00')
    const atProperty = await incomeTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31',
                                            basis: 'received', propertyIds: [w.propertyId] })
    expect(atProperty.beside.chargebackFees).toBe(3)
  })

  it("a rent dispute's fee on a charge that paid this landlord's rows at two properties always files under the property with the larger share", async () => {
    const w = await world()
    // A second property of the same landlord, with its own space and lease for the same tenant.
    const c = await db.connect()
    let w2: W
    try {
      const propertyId = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: w.landlordId, rentAmount: 700 })
      const leaseId = await seedLease(c, { unitId, landlordId: w.landlordId, rentAmount: 700 })
      await seedLeaseTenant(c, { leaseId, tenantId: w.tenantId })
      w2 = { ...w, propertyId, unitId, leaseId }
    } finally { c.release() }
    // The smaller row first, so insertion order would pick the wrong property.
    const small = await charge(w, { amount: 300, due: '2026-10-01', settledAt: '2026-10-02T10:00:00-07:00' })
    const large = await charge(w2, { amount: 700, due: '2026-10-01', settledAt: '2026-10-02T10:00:00-07:00' })
    // One household payment with no lease on its remittance, applied to both rows.
    const r = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, settled_at)
       VALUES ($1,NULL,$2,1000,1000,0,'settled','ach',1006,6,'pi_two','2026-10-02T10:00:00-07:00') RETURNING id`,
      [w.tenantId, w.landlordId])
    for (const [id, amt] of [[small, 300], [large, 700]] as const) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`,
        [r.rows[0].id, id, amt])
    }
    await feeLine(w, 'pi_two', 6, '2026-10-05T10:00:00-07:00')
    for (let i = 0; i < 3; i++) {
      for (const basis of ['received', 'billed'] as const) {
        const at = (propertyId: string) => incomeTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31',
                                                          basis, propertyIds: [propertyId] })
        expect((await at(w2.propertyId)).beside.chargebackFees).toBe(6)
        expect((await at(w.propertyId)).beside.chargebackFees).toBe(0)
        expect((await tot(w, basis, '2026-10-01', '2026-10-31')).beside.chargebackFees).toBe(6)
      }
    }
  })

  it("a rent dispute's fee counts on the day at the rent property's own time zone: a New York fee at Oct 31 10:30pm Phoenix time is November's", async () => {
    const w = await world({ tz: 'America/New_York' })
    await disputedRent(w)
    await db.query(`DELETE FROM held_payout_items WHERE source_id LIKE 'stripe\\_fee\\_kept:%'`)
    await feeLine(w, 'pi_rent', 6, '2026-10-31T22:30:00-07:00')   // Nov 1, 1:30am in New York
    const oct = await tot(w, 'received', '2026-10-01', '2026-10-31')
    const nov = await tot(w, 'received', '2026-11-01', '2026-11-30')
    expect(oct.beside.chargebackFees).toBe(0)
    expect(nov.beside.chargebackFees).toBe(6)
  })

  it('the dashboard income card shows no phantom register sale from a rent dispute', async () => {
    const w = await world()
    await disputedRent(w)
    for (const basis of ['received', 'billed'] as const) {
      const card = await incomeCardMtd([w.landlordId], null, basis, '2026-10-15')
      expect(card.received.amount).toBe(1000)
      expect(card.billed.amount).toBe(1000)
    }
  })
})

describe('what is never income', () => {
  it('a FlexPay-covered month counts rent once and the pull never', async () => {
    const w = await world()
    const adv = await db.query<{ id: string }>(
      `INSERT INTO flexpay_advances (cycle_month, tenant_id, landlord_id, unit_id, lease_id, rent_amount, tenant_fee_amount, pull_day, status)
       VALUES ('2026-10-01',$1,$2,$3,$4,460,25,10,'fronted') RETURNING id`,
      [w.tenantId, w.landlordId, w.unitId, w.leaseId])
    await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-05T23:00:00-07:00', flexpayAdvanceId: adv.rows[0].id })
    await charge(w, { type: 'fee', entry: 'FLEXPAY', owner: 'gam', amount: 485, due: '2026-10-10',
                      settledAt: '2026-10-14T10:00:00-07:00', flexpayAdvanceId: adv.rows[0].id })
    for (const basis of ['received', 'billed'] as const) {
      const t = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(t.total).toBe(460)
      expect(t.lines.rent).toBe(460)
    }
  })

  it('work trade in neither total', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-10-01', workTrade: true })
    await charge(w, { type: 'utility', amount: 30, due: '2026-10-01', settledAt: '2026-10-03T10:00:00-07:00' })
    for (const basis of ['received', 'billed'] as const) {
      const t = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(t.total).toBe(30)
      expect(t.beside.workTrade).toBe(460)
    }
  })

  it('a closed work-trade month still says what work trade covered, and its totals do not move', async () => {
    const w = await world()
    // Nic's shape (S634): September's $460 rent sits suspended on its invoice
    // while the month is open; the month close settles it from the hours.
    const ag = await db.query<{ id: string }>(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target,
                                          carry_forward_months, tracks_hours)
       VALUES ($1,$2,$3,'2026-08-01','active',80,1,TRUE) RETURNING id`, [w.unitId, w.tenantId, w.landlordId])
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent,
                             total_amount, work_trade_agreement_id, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',460,0,$6,TRUE) RETURNING id`,
      [w.landlordId, w.tenantId, w.leaseId, w.unitId, `WT-${w.leaseId.slice(0, 8)}`, ag.rows[0].id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','2026-09-01','RENT',NOW())`,
      [inv.rows[0].id, w.unitId, w.leaseId, w.tenantId, w.landlordId])
    await db.query(
      `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
       VALUES ($1,$2,'2026-09-01',80,$3,460)`, [ag.rows[0].id, inv.rows[0].id, hourRateFor(460, 80).toFixed(4)])
    // A $30 utility paid in cash the same month.
    await charge(w, { type: 'utility', amount: 30, due: '2026-09-01', settledAt: '2026-09-03T10:00:00-07:00' })

    const open = { received: await tot(w, 'received', '2026-09-01', '2026-09-30'), billed: await tot(w, 'billed', '2026-09-01', '2026-09-30') }
    expect(open.received.beside.workTrade).toBe(460)
    expect(open.billed.beside.workTrade).toBe(460)

    // The hours are worked and the month closes (the real job).
    await db.query(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
       VALUES ($1,$2,$3,'2026-09-15',80,'work','approved')`, [ag.rows[0].id, w.tenantId, w.userId])
    const run = await runWorkTradeSettlement('2026-09-01')
    expect(run.errors).toEqual([])
    const row = (await db.query<{ amount: string; suspended: boolean }>(
      `SELECT amount::text, work_trade_suspended_at IS NOT NULL AS suspended FROM payments WHERE invoice_id = $1`,
      [inv.rows[0].id])).rows[0]
    expect(Number(row.amount)).toBe(0)
    expect(row.suspended).toBe(false)

    for (const basis of ['received', 'billed'] as const) {
      const closed = await tot(w, basis, '2026-09-01', '2026-09-30')
      expect(closed.beside.workTrade).toBe(460)          // was $0 once the month closed
      expect(closed.total).toBe(open[basis].total)       // 30 — work trade in neither total
      expect(closed.total).toBe(30)
      expect(closed.lines).toEqual(open[basis].lines)
    }
  })

  it('a security deposit is held beside the total, never inside it', async () => {
    const w = await world()
    await charge(w, { type: 'deposit', entry: 'DEPOSIT', owner: 'held', amount: 500, due: '2026-09-01',
                      settledAt: '2026-09-02T10:00:00-07:00' })
    const t = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(t.total).toBe(0)
    expect(t.beside.depositsHeld).toBe(500)
  })
})

describe('still clearing is one figure under both bases', () => {
  it('credit set aside by a payment still clearing is not counted as clearing under Money billed', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 100, receivedAt: '2026-09-20T10:00:00-07:00', fundedBy: 'landlord' })
    const oct = await charge(w, { amount: 460, due: '2026-10-01', status: 'processing' })
    await db.query(`UPDATE payments SET stripe_payment_intent_id = 'pi_oct', processed_at = '2026-10-02T10:00:00-07:00' WHERE id = $1`, [oct])
    const rem = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1,$2,$3,360,360,'processing','ach','pi_oct') RETURNING id`, [w.tenantId, w.leaseId, w.landlordId])
    // The portal set $100 of the paid-ahead money aside on the charge (a held use).
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status, held_at)
       VALUES ($1,$2,$3,$4,100,'2026-10-01','portal','held','2026-10-02T10:00:00-07:00')`,
      [credit, oct, rem.rows[0].id, w.leaseId])
    const r = await tot(w, 'received', '2026-10-01', '2026-10-31')
    expect(r.beside.clearing).toBe(360)
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(b.parts.clearing).toBe(360)
    expect(b.beside.clearing).toBe(r.beside.clearing)
    expect(b.parts.coveredByPaidAhead).toBe(100)
    expect(b.total).toBe(460)
  })

  it('a shortfall payment still clearing shows the same clearing under both bases', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of rent swept to a $400 deposit; $100 of cleaning; the $400 gap is
    // paid by bank on Oct 20 and is still clearing.
    await charge(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    const gap = await charge(w, { type: 'fee', entry: 'DEPOSIT', amount: 400, due: '2026-10-15' })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',700,800,400,$4,'sent_gap',$5)`,
      [w.leaseId, w.tenantId, w.landlordId, gap, fin])
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_gap',
                           processed_at = '2026-10-20T10:00:00-07:00' WHERE id = $1`, [gap])

    const q = { landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31' }
    const r = await tot(w, 'received', q.start, q.end)
    expect(r.beside.clearing).toBe(400)                // was 0: the shortfall row is not a bill
    expect(r.total).toBe(400)                          // beside the total, never inside it
    const b = await tot(w, 'billed', q.start, q.end)
    expect(b.parts.clearing).toBe(400)
    expect(b.beside.clearing).toBe(r.beside.clearing)
    // ... and each share agrees: the rent's $300 of it is rent still clearing,
    // the cleaning's $100 has no category.
    const rx = await incomeEvents({ ...q, basis: 'received' })
    const bx = await incomeEvents({ ...q, basis: 'billed' })
    const clearing = (evs: Awaited<ReturnType<typeof incomeEvents>>, cat: string | null) =>
      Math.round(evs.filter(e => (e.line === 'clearing' || e.part === 'clearing') && e.category === cat)
        .reduce((s, e) => s + e.amount, 0) * 100) / 100
    expect(clearing(rx, 'space_rent')).toBe(300)
    expect(clearing(bx, 'space_rent')).toBe(300)
    expect(clearing(rx, null)).toBe(100)
    expect(clearing(bx, null)).toBe(100)
    expect(rx.filter(e => e.line === 'clearing').every(e => e.paymentId === gap && !e.inTotal)).toBe(true)

    // When it lands it moves inside the total, and nothing is clearing either way.
    await settle(gap, '2026-10-24T10:00:00-07:00')
    const r2 = await tot(w, 'received', q.start, q.end)
    expect(r2.beside.clearing).toBe(0)
    expect(r2.lines.depositShortfall).toBe(400)
    expect(r2.total).toBe(800)
    const b2 = await tot(w, 'billed', q.start, q.end)
    expect(b2.parts.clearing).toBe(0)
    expect(b2.parts.paid).toBe(400)
    expect(b2.total).toBe(800)
  })
})

describe('the two groupings agree', () => {
  it('Money billed parts add up to the total, and categories plus lines add up to the P&L lines', async () => {
    const w = await world()
    const credit = await paidAhead(w, { amount: 100, receivedAt: '2026-09-25T10:00:00-07:00' })
    const rent = await charge(w, { amount: 460, due: '2026-10-01' })
    await use(w, { prepaid: credit, paymentId: rent, amount: 100, at: '2026-10-02T10:00:00-07:00', source: 'desk' })
    await settle(rent, '2026-10-02T10:00:00-07:00', 'cash')
    await charge(w, { type: 'utility', amount: 45, due: '2026-10-01', status: 'processing' })
    await charge(w, { type: 'late_fee', amount: 25, due: '2026-10-06' })
    const b = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const partsSum = Math.round(Object.values(b.parts).reduce((s, v) => s + v, 0) * 100) / 100
    expect(partsSum).toBe(b.total)
    expect(b.total).toBe(530)
    for (const basis of ['received', 'billed'] as const) {
      const t = await tot(w, basis, '2026-10-01', '2026-10-31')
      const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis })
      expect(cats.total).toBe(t.total)
      const evs = await incomeEvents({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis })
      expect(summarize(evs, basis).total).toBe(t.total)
    }
  })
})
