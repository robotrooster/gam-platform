/**
 * S655 money plan, Step 3 — fix round 1 (review of 10/3).
 *
 * Edge cases the first build got wrong, each pinned against a real database:
 *   - Money billed: a stay shortened, or a reservation deposit's leftover moved
 *     to credit, took money back off the bill with no part, so the parts
 *     stopped adding up to the total and "Collected so far" ran past what was
 *     billed (the rent card, the income card, the category breakdown).
 *   - A utility charge with no utility bill linked to it (Mountain View's three
 *     August electric charges paid in cash on the September bills) read as
 *     "Other utilities" instead of Electric.
 *   - A row the legacy admin return marked 'returned' (no reversal record)
 *     dropped out of the month it settled in under Money received and read as
 *     "still owed" under Money billed, though nothing can pay it.
 *
 * Fix round 2 (review of 10/3):
 *   - A shortened stay whose anchor rent was then disputed kept taking its
 *     money back off "paid", so the month read "Collected so far −$300" until
 *     the reopened bill was paid. The take-back now follows what became of the
 *     bill (still owed first).
 *   - The credit a lengthened stay re-makes with no anchor (and a second
 *     shortening) read as an uncategorized "Moved to credit": the rent card
 *     counted that rent a second time when the credit paid a later rent bill.
 *
 * Fix round 3 (review of 10/3):
 *   - A shortened stay's credit holds everything the guest paid past the
 *     shorter stay — rent bills AND the reservation paid before the lease —
 *     but came back off its one anchor bill, so a reservation lease whose guest
 *     left two days in read Lot/space rent −$538.71. It now comes off where it
 *     came from: the anchor, the lease's earlier rent bills, then the
 *     reservation (under the stay, never rent).
 *   - A credit re-made after a lengthening is dated on the bill its withdrawn
 *     credit was anchored to, never as a negative later month.
 *   - A reservation's money moved to credit comes off in the month the
 *     reservation counted, never as a negative move-in month.
 *   - An early check-out never re-taxes (so never rewrites) a stay deposit
 *     counted in a past month (decisions #33).
 *   - A booking-site deposit counts its own amount once, on its own day, even
 *     after a pay link paid more toward the same reservation.
 *
 * Its own file: incomeBasis.test.ts is being written by another step's round
 * at the same time (money plan §4: each extra writer gets its own test file).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { incomeTotals, categoryTotals, incomeEvents } from './incomeBasis'
import { STAY_SHORTENED_CREDIT_NOTE, bankShortenedStayOverpayment } from './bookingLeaseBilling'
import { STAY_DEPOSIT_CREDIT_NOTE } from '../jobs/moveInBundle'
import { lockHousehold } from './moneyPredicates'
import { collectedRentMtd, incomeCardMtd } from '../lib/rentCollected'
import { ownerStatement } from './ownerStatement'
import { reportsRouter } from '../routes/reports'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(cleanupAllSchema)

interface W {
  userId: string; landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string
}

async function world(): Promise<W> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 460 })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId }
  } finally { c.release() }
}

const ENTRY: Record<string, string> = { rent: 'RENT', utility: 'UTILITY', fee: 'OTHERFEE' }

async function charge(w: W, o: {
  type?: string; amount: number; due: string; status?: string; settledAt?: string
  manual?: string | null; stripeCharge?: string | null; notes?: string | null
}): Promise<string> {
  const type = o.type ?? 'rent'
  const status = o.status ?? (o.settledAt ? 'settled' : 'pending')
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, settled_at, manual_method, revenue_owner, stripe_charge_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::timestamptz,$11,'landlord',$12,$13) RETURNING id`,
    [w.unitId, w.leaseId, w.tenantId, w.landlordId, type, o.amount, status, ENTRY[type] ?? 'OTHERFEE',
     o.due, o.settledAt ?? null, o.manual ?? null, o.stripeCharge ?? null, o.notes ?? null])
  return r.rows[0].id
}

async function settle(id: string, at: string): Promise<void> {
  await db.query(`UPDATE payments SET status = 'settled', settled_at = $2::timestamptz WHERE id = $1`, [id, at])
}

async function reclassified(w: W, o: {
  amount: number; at: string; sourcePaymentId?: string; note?: string | null; createdAt?: string
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                        received_at, created_at, source_payment_id, note)
     VALUES ($1,$2,$3,$3,'reclassified',$4::timestamptz,$5::timestamptz,$6,$7) RETURNING id`,
    [w.leaseId, w.tenantId, o.amount, o.at, o.createdAt ?? o.at, o.sourcePaymentId ?? null, o.note ?? null])
  return r.rows[0].id
}

/**
 * What a card dispute writes (services/paymentReversal): the reversal record,
 * the original row 'returned', and a fresh pending row for the money taken
 * back, on the ORIGINAL due date, pointing at the reversal.
 */
async function dispute(w: W, o: { paymentId: string; amount: number; at: string; due: string }): Promise<string> {
  const rev = await db.query<{ id: string }>(
    `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                    stripe_event_id, raw_event, created_at)
     VALUES ($1,$2,$3,$4,'card_dispute',$5,'evt_'||md5(random()::text),'{}'::jsonb,$6::timestamptz) RETURNING id`,
    [o.paymentId, w.landlordId, w.tenantId, w.leaseId, o.amount, o.at])
  await db.query(`UPDATE payments SET status = 'returned', return_code = 'card_dispute' WHERE id = $1`, [o.paymentId])
  const reopened = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                           due_date, notes, reversal_id)
     VALUES ($1,$2,$3,$4,'rent',$5,'pending','RENT',$6::date,'Reopened after payment reversal',$7) RETURNING id`,
    [w.unitId, w.leaseId, w.tenantId, w.landlordId, o.amount, o.due, rev.rows[0].id])
  return reopened.rows[0].id
}

async function spend(w: W, o: { prepaid: string; paymentId: string; amount: number; at: string }): Promise<void> {
  await db.query(
    `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status,
                              held_at, applied_at)
     VALUES ($1,$2,$3,$4, date_trunc('month', $5::timestamptz AT TIME ZONE 'America/Phoenix')::date,
             'whole_bill', 'applied', $5::timestamptz, $5::timestamptz)`,
    [o.prepaid, o.paymentId, w.leaseId, o.amount, o.at])
}

const tot = (w: W, basis: 'received' | 'billed', start: string, end: string) =>
  incomeTotals({ landlordIds: [w.landlordId], start, end, basis })
const cents = (n: number) => Math.round(n * 100) / 100
const sumParts = (p: Record<string, number>) => cents(Object.values(p).reduce((s, v) => s + v, 0))

describe('Money billed: the parts add up to the bill when money is moved to credit', () => {
  it('a stay shortened by the whole month: the parts add up to the $0 billed and nothing reads as collected', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 460, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(0)
    expect(sumParts(b.parts)).toBe(b.total)
    expect(b.parts.paid).toBe(0)
    expect(b.beside.collectedSoFar).toBe(0)
    expect(b.beside.stillOwed).toBe(0)
  })

  it('a stay shortened by $300: the parts add up to the $160 billed, and the bill the credit later pays is covered by money paid ahead', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    const credit = await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.lines.stayShortened).toBe(-300)
    expect(sumParts(b.parts)).toBe(160)
    expect(b.parts.paid).toBe(160)
    expect(b.beside.collectedSoFar).toBe(160)

    // December's rent, paid by $300 of the credit and $160 of new cash.
    const dec = await charge(w, { amount: 460, due: '2026-12-01' })
    await spend(w, { prepaid: credit, paymentId: dec, amount: 300, at: '2026-12-01T07:00:00-07:00' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-12-01T09:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [dec])
    const bDec = await tot(w, 'billed', '2026-12-01', '2026-12-31')
    expect(bDec.total).toBe(460)
    expect(bDec.parts.coveredByPaidAhead).toBe(300)
    expect(bDec.parts.paid).toBe(160)
    expect(sumParts(bDec.parts)).toBe(460)
    // Money received: the $300 arrived on Oct 25 inside the rent; it is never new money again.
    expect((await tot(w, 'received', '2026-12-01', '2026-12-31')).total).toBe(160)
  })

  it('a stay shortened by $300: the rent card’s collected + clearing + still owed equals its billed amount', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })

    for (const scope of ['rent', 'all'] as const) {
      const card = await collectedRentMtd([w.landlordId], null, { scope, basis: 'billed', month: '2026-11-15' })
      expect(card.billed.amount).toBe(160)
      expect(card.billed.collected).toBe(160)
      expect(cents(card.billed.collected + card.billed.clearing + card.billed.stillOwed)).toBe(card.billed.amount)
    }
    const income = await incomeCardMtd([w.landlordId], null, 'billed', '2026-11-15')
    expect(cents(income.billed.collected + income.billed.clearing + income.billed.stillOwed)).toBe(income.billed.amount)
  })

  it('a stay shortened by $300: lot/space rent collected + clearing + still owed equals what was billed in the category breakdown', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })

    for (const basis of ['billed', 'received'] as const) {
      const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis })
      const rent = cats.categories.find(c => c.category === 'space_rent')!
      expect(rent.billed).toBe(160)
      if (basis === 'billed') {
        expect(rent.collected).toBe(160)
        expect(cents(rent.collected + rent.clearing + rent.stillOwed)).toBe(rent.billed)
      }
    }
  })

  it('a stay shortened on rent paid from the deposit takes the money back off "kept from deposit"', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', status: 'paid_via_deposit', settledAt: '2026-10-25T10:00:00-07:00' })
    await reclassified(w, { amount: 200, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(260)
    expect(b.parts.keptFromDeposit).toBe(260)
    expect(b.parts.paid).toBe(0)
    expect(sumParts(b.parts)).toBe(260)
  })

  it('a reservation deposit’s leftover moved to credit: the parts add up to the total, and the bill it pays is covered by money paid ahead', async () => {
    const w = await world()
    // moveInBundle keeps the leftover as reclassified credit with no anchor bill.
    const credit = await reclassified(w, { amount: 58.06, at: '2026-09-14T10:00:00-07:00' })
    const sep = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(sep.lines.movedToCredit).toBe(-58.06)
    expect(sep.total).toBe(-58.06)
    expect(sumParts(sep.parts)).toBe(-58.06)
    expect(sep.parts.paid).toBe(-58.06)

    const fee = await charge(w, { type: 'fee', amount: 58.06, due: '2026-09-20' })
    await spend(w, { prepaid: credit, paymentId: fee, amount: 58.06, at: '2026-09-20T07:00:00-07:00' })
    await settle(fee, '2026-09-20T07:00:00-07:00')
    const after = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(after.total).toBe(0)
    expect(after.parts.coveredByPaidAhead).toBe(58.06)
    expect(sumParts(after.parts)).toBe(0)
    expect(after.beside.collectedSoFar).toBe(0)
  })
})

describe('Money billed: a shortened stay takes its money back off what became of the bill', () => {
  async function paidAhead(w: W, amount: number, at: string): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,$3,$3,'landlord',$4::timestamptz,$4::timestamptz) RETURNING id`,
      [w.leaseId, w.tenantId, amount, at])).rows[0].id
  }

  it('rent paid partly with money paid ahead: the $300 comes off paid first, and paid ahead keeps its part', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01' })
    await spend(w, { prepaid: await paidAhead(w, 100, '2026-10-01T10:00:00-07:00'), paymentId: nov, amount: 100, at: '2026-10-25T10:00:00-07:00' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-25T10:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [nov])
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.parts.paid).toBe(60)
    expect(b.parts.coveredByPaidAhead).toBe(100)
    expect(sumParts(b.parts)).toBe(160)
  })

  it('rent paid wholly with money paid ahead: the $300 comes off covered by money paid ahead, never leaving paid below zero', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01' })
    await spend(w, { prepaid: await paidAhead(w, 460, '2026-10-01T10:00:00-07:00'), paymentId: nov, amount: 460, at: '2026-10-25T10:00:00-07:00' })
    await settle(nov, '2026-10-25T10:00:00-07:00')
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.parts.paid).toBe(0)
    expect(b.parts.coveredByPaidAhead).toBe(160)
    expect(b.beside.collectedSoFar).toBe(160)
  })
})

describe('Money billed: a shortened stay whose rent was then disputed', () => {
  it('a $300 shortening of card rent disputed in full comes off still owed: collected so far stays at $0 and the parts add up; once the reopened bill is paid it reads $160 paid', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', stripeCharge: 'ch_nov' })
    const credit = await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    const reopened = await dispute(w, { paymentId: nov, amount: 460, at: '2026-11-10T10:00:00-07:00', due: '2026-11-01' })

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.lines.stayShortened).toBe(-300)
    expect(sumParts(b.parts)).toBe(160)
    expect(b.parts.stillOwed).toBe(160)
    expect(b.parts.paid).toBe(0)
    expect(b.beside.collectedSoFar).toBe(0)
    expect(b.beside.stillOwed).toBe(160)
    // The rent card, the income card and the category breakdown say the same.
    for (const scope of ['rent', 'all'] as const) {
      const card = await collectedRentMtd([w.landlordId], null, { scope, basis: 'billed', month: '2026-11-15' })
      expect(card.billed).toEqual({ amount: 160, collected: 0, clearing: 0, stillOwed: 160 })
    }
    const rent = (await categoryTotals({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'billed' }))
      .categories.find(c => c.category === 'space_rent')!
    expect(rent).toMatchObject({ billed: 160, collected: 0, clearing: 0, stillOwed: 160 })

    // Credit never pays a reopened row (the credit_uses trigger refuses it).
    await expect(spend(w, { prepaid: credit, paymentId: reopened, amount: 300, at: '2026-11-12T10:00:00-07:00' }))
      .rejects.toMatchObject({ code: '23514' })
    // November 12: the tenant pays the reopened $460 in cash; the $300 credit stays for a later bill.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-11-12T10:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [reopened])
    const paid = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(paid.total).toBe(160)
    expect(paid.parts.paid).toBe(160)
    expect(paid.parts.stillOwed).toBe(0)
    expect(sumParts(paid.parts)).toBe(160)
    expect(paid.beside.collectedSoFar).toBe(160)
    // Money received over the two months: $460 in, $460 back, $460 in.
    expect((await tot(w, 'received', '2026-10-01', '2026-11-30')).total).toBe(460)

    // December's rent: the $300 credit and $160 cash. Billed and received agree over Oct–Dec: $620.
    const dec = await charge(w, { amount: 460, due: '2026-12-01' })
    await spend(w, { prepaid: credit, paymentId: dec, amount: 300, at: '2026-12-01T07:00:00-07:00' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-12-01T09:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [dec])
    const billedNovDec = await tot(w, 'billed', '2026-11-01', '2026-12-31')
    expect(billedNovDec.total).toBe(620)
    expect(billedNovDec.beside.collectedSoFar).toBe(620)
    expect((await tot(w, 'received', '2026-10-01', '2026-12-31')).total).toBe(620)
  })

  it('a partial dispute: what the reopened bill asks again comes off still owed first, the rest off paid', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', stripeCharge: 'ch_nov' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    await dispute(w, { paymentId: nov, amount: 200, at: '2026-11-10T10:00:00-07:00', due: '2026-11-01' })

    // $260 of the card money stayed; the $300 credit covers the $200 asked again.
    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.parts.stillOwed).toBe(0)
    expect(b.parts.paid).toBe(160)
    expect(sumParts(b.parts)).toBe(160)
    expect(b.beside.collectedSoFar).toBe(160)
  })

  it('while a card payment for the reopened bill is clearing, the take-back comes off clearing only after everything else', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', stripeCharge: 'ch_nov' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    const reopened = await dispute(w, { paymentId: nov, amount: 460, at: '2026-11-10T10:00:00-07:00', due: '2026-11-01' })
    await db.query(`UPDATE payments SET status = 'processing', processed_at = '2026-11-12T10:00:00-07:00' WHERE id = $1`, [reopened])

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(160)
    expect(b.parts.clearing).toBe(160)
    expect(b.parts.paid).toBe(0)
    expect(sumParts(b.parts)).toBe(160)
    expect(b.beside.collectedSoFar).toBe(0)
  })
})

describe('Money billed: rent a shortened stay moved to credit with no anchor bill is still rent', () => {
  it('shortened, then lengthened again: the credit re-made with no anchor is "Stay shortened" under Lot/space rent, so the rent card and the category equal the billed total and the rent it later pays is not counted twice', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    // Oct 28: the stay is shortened; $300 of November's rent is banked against it.
    const first = await reclassified(w, {
      amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    // Nov 5: lengthened again so only $200 is over. billLongerStay withdraws the
    // credit and re-makes the rest with no anchor (the withdrawn one keeps it).
    await db.query(
      `UPDATE lease_prepaid_credits SET voided_at = '2026-11-05T10:00:00-07:00', void_reason = 'The stay now ends later'
        WHERE id = $1`, [first])
    const rest = await reclassified(w, {
      amount: 200, at: '2026-10-28T10:00:00-07:00', createdAt: '2026-11-05T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE,
    })
    // The anchor cannot move to the re-made credit: one credit per row, withdrawn or not.
    await expect(db.query(`UPDATE lease_prepaid_credits SET source_payment_id = $2 WHERE id = $1`, [rest, nov]))
      .rejects.toMatchObject({ code: '23505' })

    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(260)
    expect(b.lines.stayShortened).toBe(-200)
    expect(b.lines.movedToCredit).toBe(0)
    expect(b.parts.paid).toBe(260)
    expect(sumParts(b.parts)).toBe(260)
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'billed' })
    const rent = cats.categories.find(c => c.category === 'space_rent')!
    expect(rent).toMatchObject({ billed: 260, collected: 260, stillOwed: 0 })
    expect(cats.lines).toEqual([])
    expect(cats.total).toBe(260)
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-11-15' })
    expect(card.billed).toEqual({ amount: 260, collected: 260, clearing: 0, stillOwed: 0 })

    // December's rent: the $200 credit and $260 cash.
    const dec = await charge(w, { amount: 460, due: '2026-12-01' })
    await spend(w, { prepaid: rest, paymentId: dec, amount: 200, at: '2026-12-01T07:00:00-07:00' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-12-01T09:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [dec])
    const decCard = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-12-15' })
    expect(decCard.billed.amount).toBe(460)
    // Two months of rent on the rent card = the rent money that came in ($460 + $260), never $920.
    expect(card.billed.amount + decCard.billed.amount).toBe(720)
    const rxOct = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'received', month: '2026-10-15' })
    const rxNov = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'received', month: '2026-11-15' })
    const rxDec = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'received', month: '2026-12-15' })
    expect(rxOct.collected + rxNov.collected + rxDec.collected).toBe(720)
  })

  it('a second shortening against a row that already anchors one is "Stay shortened" under Lot/space rent, taken off that row', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE })
    await reclassified(w, {
      amount: 100, at: '2026-10-25T10:00:00-07:00', createdAt: '2026-11-03T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE,
    })
    const b = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(b.total).toBe(60)
    expect(b.lines.stayShortened).toBe(-400)
    expect(b.lines.movedToCredit).toBe(0)
    expect(sumParts(b.parts)).toBe(60)
    const rent = (await categoryTotals({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'billed' }))
      .categories.find(c => c.category === 'space_rent')!
    expect(rent.billed).toBe(60)
    expect(rent.collected).toBe(60)
    // A reservation deposit's leftover (no anchor, no stay-shortened note) is still "Moved to credit".
    await reclassified(w, { amount: 58.06, at: '2026-11-04T10:00:00-07:00' })
    const after = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(after.lines.movedToCredit).toBe(-58.06)
    expect(after.lines.stayShortened).toBe(-400)
  })
})

describe('the charges behind a Money billed total net a shortened stay from its bill', () => {
  it('the monthly statement lists the November rent shortened by $300 at $160 billed and $160 collected, and collected never runs past income', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reports'
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 300, at: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov })
    const app = express()
    app.use(express.json())
    app.use('/api/reports', reportsRouter)
    app.use(errorHandler)
    const token = jwt.sign({ userId: w.userId, role: 'landlord', email: 'l@t.dev', profileId: null,
                             landlordIds: [w.landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })

    const res = await request(app)
      .get('/api/reports/monthly-statement?year=2026&month=11&basis=billed')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.summary.totalIncome).toBe(160)
    expect(d.summary.totalCollected).toBe(160)
    expect(d.rowsTotal).toBe(160)
    expect(d.payments).toHaveLength(1)
    expect(d.payments[0].amount).toBe(160)
    expect(d.payments[0].parts).toEqual({ paid: 160 })
    expect(d.payments[0].category).toBe('space_rent')
  })
})

describe('a utility charge with no utility bill linked to it', () => {
  const ELECTRIC_NOTE = 'Electric — Aug 2026 (461 kWh @ $0.2100, used before the lease was signed) — Recorded as manual cash payment'

  it('an unlinked "Electric — …" charge counts under Electric, not Other utilities, under both bases', async () => {
    const w = await world()
    // Mountain View, production: the August electric typed onto the September
    // bill and paid in cash; the August bill written later was voided as a
    // duplicate and unlinked (payment_id NULL).
    const pay = await charge(w, {
      type: 'utility', amount: 96.81, due: '2026-09-01', settledAt: '2026-09-18T16:12:52-07:00', manual: 'cash',
      notes: ELECTRIC_NOTE,
    })
    const c = await db.connect()
    try {
      const meter = await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'electric' })
      await seedUtilityBill(c, {
        meterId: meter, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId, landlordId: w.landlordId,
        chargeAmount: 96.81, paymentId: null, billingCycleMonth: '2026-08-01', status: 'void', utilityType: 'electric',
      })
    } finally { c.release() }
    expect(pay).toBeTruthy()

    for (const basis of ['received', 'billed'] as const) {
      const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis })
      const electric = cats.categories.find(x => x.category === 'electric')!
      const other = cats.categories.find(x => x.category === 'utility_other')!
      expect(electric.billed).toBe(96.81)
      expect(electric.collected).toBe(96.81)
      expect(other.billed).toBe(0)
      expect(other.collected).toBe(0)
    }
  })

  it('the note names water, sewer, natural gas or trash the same way; a note naming no utility stays Other utilities', async () => {
    const w = await world()
    const at = '2026-09-10T10:00:00-07:00'
    await charge(w, { type: 'utility', amount: 20, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'Water — Aug 2026 (3,000 gal)' })
    await charge(w, { type: 'utility', amount: 7, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'sewer - August' })
    await charge(w, { type: 'utility', amount: 9, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'Natural gas — Aug' })
    await charge(w, { type: 'utility', amount: 25, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'Trash — September' })
    await charge(w, { type: 'utility', amount: 5, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'Recorded as manual cash payment' })
    // A word that only starts like a utility is not one.
    await charge(w, { type: 'utility', amount: 3, due: '2026-09-01', settledAt: at, manual: 'cash', notes: 'Watercraft slip power' })

    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'billed' })
    const by = (k: string) => cats.categories.find(x => x.category === k)!.billed
    expect(by('water')).toBe(20)
    expect(by('sewer')).toBe(7)
    expect(by('gas')).toBe(9)
    expect(by('trash')).toBe(25)
    expect(by('utility_other')).toBe(8)
  })

  it('a linked utility bill wins over what the note says', async () => {
    const w = await world()
    const pay = await charge(w, {
      type: 'utility', amount: 40, due: '2026-09-01', settledAt: '2026-09-10T10:00:00-07:00', manual: 'cash',
      notes: 'Electric — typed by mistake',
    })
    const c = await db.connect()
    try {
      const meter = await seedUtilityMeter(c, { propertyId: w.propertyId, utilityType: 'water' })
      await seedUtilityBill(c, {
        meterId: meter, unitId: w.unitId, tenantId: w.tenantId, leaseId: w.leaseId, landlordId: w.landlordId,
        chargeAmount: 40, paymentId: pay, billingCycleMonth: '2026-08-01', status: 'paid', utilityType: 'water',
      })
    } finally { c.release() }
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'received' })
    expect(cats.categories.find(x => x.category === 'water')!.collected).toBe(40)
    expect(cats.categories.find(x => x.category === 'electric')!.collected).toBe(0)
  })
})

describe('a row the legacy admin return marked returned, with no reversal record', () => {
  /** What POST /payments/:id/handle-return writes: the status and the code, nothing else. */
  async function legacyReturn(id: string): Promise<void> {
    await db.query(
      `UPDATE payments SET status = 'returned', return_code = 'R01', return_reason = 'Insufficient funds',
                           zero_tolerance_flag = FALSE
        WHERE id = $1`, [id])
  }

  it('stays in the month it settled under Money received, counts paid under Money billed, and never reads as still owed', async () => {
    const w = await world()
    const sep = await charge(w, { amount: 460, due: '2026-09-01', settledAt: '2026-09-05T10:00:00-07:00', stripeCharge: 'ch_legacy' })
    const before = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(before.total).toBe(460)

    await legacyReturn(sep)

    // A past month is never rewritten.
    const r = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(r.total).toBe(460)
    expect(r.lines.rent).toBe(460)
    expect(r.lines.returned).toBe(0)   // no reversal record, so nothing comes off yet
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.total).toBe(460)
    expect(b.parts.paid).toBe(460)
    expect(b.parts.stillOwed).toBe(0)
    expect(sumParts(b.parts)).toBe(460)

    // The PM owner statement keeps it in its month too (through GAM: a card payment).
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-09' })
    expect(stmt.totals.grossCollected).toBe(460)
    expect(stmt.totals.collectedThroughGam).toBe(460)
    expect(stmt.totals.returnedOrDisputed).toBe(0)
  })

  it('a row marked returned before it ever settled is not money received, and stays still owed under Money billed', async () => {
    const w = await world()
    const id = await charge(w, { amount: 460, due: '2026-09-01', status: 'processing' })
    await db.query(`UPDATE payments SET processed_at = '2026-09-02T10:00:00-07:00' WHERE id = $1`, [id])
    await legacyReturn(id)

    const r = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(r.total).toBe(0)
    expect(r.beside.clearing).toBe(0)
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.total).toBe(460)
    expect(b.parts.stillOwed).toBe(460)
    expect(b.parts.paid).toBe(0)
  })
})

// ─── Fix round 3 ──────────────────────────────────────────────────────────────

/**
 * A lease drafted from a reservation booked on the booking site: the booking
 * (its deposit paid there, with the held item GAM keeps for the landlord), the
 * lease drafted from it (lease_source 'booking_draft', its source booking), and
 * the lease's own world. Nothing is billed yet.
 */
async function reservationLease(o: {
  rent: number; start: string; end: string; checkIn: string; checkOut: string
  deposit: number; depositPaidAt: string; total: number
}): Promise<W & { bookingId: string }> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: o.rent })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: o.rent, startDate: o.start })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const bookingId = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, booked_check_out, guest_name,
                                  guest_email, status, source, deposit_amount, deposit_paid_at, total_amount)
       VALUES ($1,$2,'month_to_month',$3,$4,$4,'Pat Guest','pat@guest.test','confirmed','public',$5,$6::timestamptz,$7)
       RETURNING id`,
      [unitId, landlordId, o.checkIn, o.checkOut, o.deposit, o.depositPaidAt, o.total])).rows[0].id
    await c.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1,'booking_deposit',$2,$3,'Stay deposit',$4::timestamptz)`, [landlordId, bookingId, o.deposit, o.depositPaidAt])
    await c.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, end_date = $3, needs_review = false
        WHERE id = $1`, [leaseId, bookingId, o.end])
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, bookingId }
  } finally { c.release() }
}

/** The landlord moves the lease's end (the guest left): the sync banks what the guest paid past it. */
async function shortenLease(w: W, end: string): Promise<number> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await lockHousehold(c, w.tenantId, w.landlordId)
    await c.query(`UPDATE leases SET end_date = $2 WHERE id = $1`, [w.leaseId, end])
    const banked = await bankShortenedStayOverpayment(c, w.leaseId)
    await c.query('COMMIT')
    return banked
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * Review of 10/3 (V5): a reservation lease; the $600 deposit paid Jul 20 on the
 * booking site counted as a stay; the arrival rent (Aug 10–31, $674.19) less
 * the $600 is $74.19, paid in cash Aug 10. The guest leaves Aug 12: the stay is
 * two nights ($61.29), so $612.90 is banked — $74.19 of rent and $538.71 of the
 * reservation.
 */
async function guestLeavesTwoDaysIn(): Promise<W & { bookingId: string; arrival: string; banked: number }> {
  const w = await reservationLease({
    rent: 950, start: '2026-08-10', end: '2027-01-28', checkIn: '2026-08-10', checkOut: '2027-01-28',
    deposit: 600, depositPaidAt: '2026-07-20T10:00:00-07:00', total: 5000,
  })
  const arrival = await charge(w, { amount: 74.19, due: '2026-08-10', settledAt: '2026-08-10T10:00:00-07:00', manual: 'cash' })
  const banked = await shortenLease(w, '2026-08-12')
  return { ...w, arrival, banked }
}

describe('Money billed: a shortened stay’s credit comes back off where the money came from', () => {
  it('a guest who leaves two days into a reservation lease: the reservation money moved to credit comes off the stay, never off Lot/space rent', async () => {
    const w = await guestLeavesTwoDaysIn()
    expect(w.banked).toBe(612.9)
    const credit = (await db.query<any>(
      `SELECT amount_original::float AS amount, source_payment_id FROM lease_prepaid_credits WHERE lease_id = $1`, [w.leaseId])).rows
    expect(credit).toEqual([{ amount: 612.9, source_payment_id: w.arrival }])

    // August: the arrival rent's $74.19 comes off the rent bill it came from — and no more.
    const aug = await tot(w, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.lines.rent).toBe(74.19)
    expect(aug.lines.stayShortened).toBe(-74.19)
    expect(aug.total).toBe(0)
    expect(sumParts(aug.parts)).toBe(0)
    expect(aug.beside.collectedSoFar).toBe(0)
    const augRent = (await categoryTotals({ landlordIds: [w.landlordId], start: '2026-08-01', end: '2026-08-31', basis: 'billed' }))
      .categories.find(c => c.category === 'space_rent')!
    expect(augRent).toMatchObject({ billed: 0, collected: 0, clearing: 0, stillOwed: 0 })
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-08-15' })
    expect(card.billed).toEqual({ amount: 0, collected: 0, clearing: 0, stillOwed: 0 })

    // July: the $538.71 of the reservation comes off the stay, the day the deposit counted.
    const jul = await tot(w, 'billed', '2026-07-01', '2026-07-31')
    expect(jul.lines.registerAndStays).toBe(600)
    expect(jul.lines.movedToCredit).toBe(-538.71)
    expect(jul.total).toBe(61.29)
    expect(jul.beside.collectedSoFar).toBe(61.29)
    // The stay nets to what it was worth: two nights.
    const stays = (await categoryTotals({ landlordIds: [w.landlordId], start: '2026-07-01', end: '2026-08-31', basis: 'billed' }))
      .categories.find(c => c.category === 'stays_and_pay_links')!
    expect(stays).toMatchObject({ billed: 61.29, collected: 61.29 })
    // The total over both months is unchanged: $674.19 paid less $612.90 moved to credit.
    expect((await tot(w, 'billed', '2026-07-01', '2026-08-31')).total).toBe(61.29)

    // The PM owner statement counts no stays: August's block reads $0 against the $74.19 the manager took.
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-08' })
    expect(stmt.totals.grossCollected).toBe(74.19)
    expect(stmt.totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })

    // Money received is untouched: the money arrived when it arrived.
    const rx = await tot(w, 'received', '2026-07-01', '2026-08-31')
    expect(rx.total).toBe(674.19)
    expect(rx.lines.rent).toBe(74.19)
    expect(rx.lines.registerAndStays).toBe(600)
  })

  it('a take-back larger than its anchor bill comes off the lease’s earlier rent bills, newest first, each in its own month', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-28T10:00:00-07:00', manual: 'cash' })
    // Oct 29: shortened to end Oct 29 — Oct 29–31 ($29.68) and November ($460) are over, anchored to November.
    await reclassified(w, {
      amount: 489.68, at: '2026-10-28T10:00:00-07:00', createdAt: '2026-10-29T10:00:00-07:00',
      sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })

    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bNov.lines.stayShortened).toBe(-460)
    expect(bNov.total).toBe(0)
    expect(sumParts(bNov.parts)).toBe(0)
    expect(bNov.beside.collectedSoFar).toBe(0)
    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(bOct.lines.stayShortened).toBe(-29.68)
    expect(bOct.total).toBe(430.32)
    expect(bOct.parts.paid).toBe(430.32)
    expect(sumParts(bOct.parts)).toBe(430.32)
    for (const [month, amount] of [['2026-10-15', 430.32], ['2026-11-15', 0]] as const) {
      const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month })
      expect(card.billed).toEqual({ amount, collected: amount, clearing: 0, stillOwed: 0 })
    }
  })

  it('a stay-shortened credit with no anchor and no rent paid on its lease is the reservation’s money: Lot/space rent, the rent card and the owner statement’s billed block stay at $0', async () => {
    // The $600 deposit covered the whole arrival bill, so no rent row was
    // billed and $356.13 was left over as credit; the stay was then shortened
    // and $44.87 more of the reservation was banked, with nothing to anchor to.
    const w = await reservationLease({
      rent: 460, start: '2026-10-25', end: '2026-11-20', checkIn: '2026-10-25', checkOut: '2026-11-20',
      deposit: 600, depositPaidAt: '2026-10-20T10:00:00-07:00', total: 600,
    })
    await reclassified(w, { amount: 356.13, at: '2026-10-20T10:00:00-07:00', createdAt: '2026-10-25T10:00:00-07:00', note: STAY_DEPOSIT_CREDIT_NOTE })
    await reclassified(w, { amount: 44.87, at: '2026-10-20T10:00:00-07:00', createdAt: '2026-10-28T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })

    const oct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(oct.lines.stayShortened).toBe(0)
    expect(oct.lines.movedToCredit).toBe(-401)
    expect(oct.lines.registerAndStays).toBe(600)
    expect(oct.total).toBe(199)
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-10-31', basis: 'billed' })
    expect(cats.categories.find(c => c.category === 'space_rent')).toMatchObject({ billed: 0, collected: 0 })
    expect(cats.categories.find(c => c.category === 'stays_and_pay_links')).toMatchObject({ billed: 199, collected: 199 })
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-10-15' })
    expect(card.billed).toEqual({ amount: 0, collected: 0, clearing: 0, stillOwed: 0 })
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-10' })
    expect(stmt.totals.grossCollected).toBe(0)
    expect(stmt.totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
  })

  it('what neither a rent bill nor a linked reservation explains is never taken off Lot/space rent', async () => {
    // The lease names no reservation, yet a note-only credit was banked: it is
    // "Moved to credit", so the total is unchanged and rent never reads below zero.
    const w = await world()
    await reclassified(w, { amount: 44.87, at: '2026-10-28T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })
    const oct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(oct.total).toBe(-44.87)
    expect(oct.lines.stayShortened).toBe(0)
    expect(oct.lines.movedToCredit).toBe(-44.87)
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-10-15' })
    expect(card.billed.amount).toBe(0)
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-10' })
    expect(stmt.totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
  })

  it('a credit re-made after the stay was lengthened again is taken off the bill its withdrawn credit was anchored to: November reads $260 and December has no negative bill', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', manual: 'cash' })
    // Nov 10: shortened, $300 of November banked against it.
    const first = await reclassified(w, {
      amount: 300, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-10T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    // Dec 3: lengthened again; billLongerStay withdraws it and re-makes the $200 still over, with no anchor.
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = '2026-12-03T10:00:00-07:00', void_reason = 'The stay now ends later' WHERE id = $1`, [first])
    await reclassified(w, { amount: 200, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-12-03T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })

    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bNov.total).toBe(260)
    expect(bNov.lines.stayShortened).toBe(-200)
    expect(bNov.parts.paid).toBe(260)
    expect(bNov.beside.collectedSoFar).toBe(260)
    const bDec = await tot(w, 'billed', '2026-12-01', '2026-12-31')
    expect(bDec.total).toBe(0)
    expect(bDec.beside.collectedSoFar).toBe(0)
    // It names the November bill, so the charges behind November's total net it there.
    const ev = (await incomeEvents({ landlordIds: [w.landlordId], start: '2026-11-01', end: '2026-11-30', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened')
    expect(ev.map(e => ({ paymentId: e.paymentId, day: e.day, amount: e.amount })))
      .toEqual([{ paymentId: nov, day: '2026-11-01', amount: -200 }])
  })
})

// ─── Fix pass of 10/4 ─────────────────────────────────────────────────────────

/**
 * Review of 10/4: a lease's shortened-stay credits were added into one total
 * and taken off the bills newest anchor first, so a second credit on November
 * pulled an earlier credit's take-back onto November and rewrote October, a
 * past month (money plan §2: the negative is dated on the due date of ITS
 * anchor row; §0.0: a past month is never rewritten). Each credit now comes off
 * its own bill first; only what its bill cannot take goes further, and never
 * onto a bill due after the credit's own.
 */
describe('Money billed: each shortened-stay credit comes off its own bill, and a later credit never rewrites an earlier month', () => {
  it('two shortened-stay credits on different anchors each come off their own bill: October $360 and November $260, and October still reads $360 after November’s credit is made', async () => {
    const w = await world()
    const oct = await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, {
      amount: 100, at: '2026-10-01T10:00:00-07:00', createdAt: '2026-10-20T10:00:00-07:00',
      sourcePaymentId: oct, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    const octBefore = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(octBefore.total).toBe(360)
    expect(octBefore.lines.stayShortened).toBe(-100)

    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, {
      amount: 200, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-10T10:00:00-07:00',
      sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    const octAfter = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const novAfter = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(octAfter.total).toBe(360)
    expect(octAfter).toEqual(octBefore)
    expect(novAfter.total).toBe(260)
    expect(novAfter.lines.stayShortened).toBe(-200)
    for (const [t, amount] of [[octAfter, 360], [novAfter, 260]] as const) {
      expect(t.parts.paid).toBe(amount)
      expect(sumParts(t.parts)).toBe(amount)
      expect(t.beside.collectedSoFar).toBe(amount)
    }
    const ev = (await incomeEvents({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-11-30', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened')
      .map(e => ({ paymentId: e.paymentId, day: e.day, amount: e.amount }))
      .sort((x, y) => x.day.localeCompare(y.day))
    expect(ev).toEqual([
      { paymentId: oct, day: '2026-10-01', amount: -100 },
      { paymentId: nov, day: '2026-11-01', amount: -200 },
    ])
    // The rent card and the owner statement's billed block read the same split.
    for (const [month, amount] of [['2026-10', 360], ['2026-11', 260]] as const) {
      const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: `${month}-15` })
      expect(card.billed).toEqual({ amount, collected: amount, clearing: 0, stillOwed: 0 })
      const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: month })
      expect(stmt.totals.billed).toEqual({ billed: amount, collectedSoFar: amount, clearing: 0, stillOwed: 0 })
    }
    // The totals do not move: $920 arrived; $300 of it is now paid ahead.
    expect((await tot(w, 'billed', '2026-10-01', '2026-11-30')).total).toBe(620)
    expect((await tot(w, 'received', '2026-10-01', '2026-11-30')).total).toBe(920)
  })

  it('an earlier credit’s take-back past its own bill stays on the bills due before it when a newer credit is made: September and October are not rewritten', async () => {
    const w = await world()
    const bill = (due: string) => charge(w, { amount: 460, due, settledAt: `${due}T10:00:00-07:00`, manual: 'cash' })
    await bill('2026-09-01')
    const oct = await bill('2026-10-01')
    await bill('2026-11-01')
    // Oct 5: $600 banked against October — all of October and $140 of September.
    await reclassified(w, {
      amount: 600, at: '2026-10-01T10:00:00-07:00', createdAt: '2026-10-05T10:00:00-07:00',
      sourcePaymentId: oct, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    const month = async (m: string, end: string) => (await tot(w, 'billed', `${m}-01`, end)).total
    expect(await month('2026-09', '2026-09-30')).toBe(320)
    expect(await month('2026-10', '2026-10-31')).toBe(0)
    expect(await month('2026-11', '2026-11-30')).toBe(460)

    // Dec 10: a later stay change banks $100 against December, which has $360 to spare.
    const dec = await bill('2026-12-01')
    await reclassified(w, {
      amount: 100, at: '2026-12-01T10:00:00-07:00', createdAt: '2026-12-10T10:00:00-07:00',
      sourcePaymentId: dec, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    expect(await month('2026-09', '2026-09-30')).toBe(320)
    expect(await month('2026-10', '2026-10-31')).toBe(0)
    expect(await month('2026-11', '2026-11-30')).toBe(460)
    expect(await month('2026-12', '2026-12-31')).toBe(360)
    expect((await tot(w, 'billed', '2026-09-01', '2026-12-31')).total).toBe(1140)
  })

  it('a second shortening’s credit with no anchor stays on the bill it was made against when a later bill anchors a newer credit', async () => {
    const w = await world()
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-10-25T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 300, at: '2026-10-25T10:00:00-07:00', createdAt: '2026-10-28T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE })
    // Nov 3: shortened again; November already anchors a credit, so this one has none.
    await reclassified(w, { amount: 100, at: '2026-10-25T10:00:00-07:00', createdAt: '2026-11-03T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })
    expect((await tot(w, 'billed', '2026-11-01', '2026-11-30')).total).toBe(60)

    const dec = await charge(w, { amount: 460, due: '2026-12-01', settledAt: '2026-12-01T10:00:00-07:00', manual: 'cash' })
    await reclassified(w, { amount: 50, at: '2026-12-01T10:00:00-07:00', createdAt: '2026-12-10T10:00:00-07:00', sourcePaymentId: dec, note: STAY_SHORTENED_CREDIT_NOTE })
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bNov.total).toBe(60)
    expect(bNov.lines.stayShortened).toBe(-400)
    const bDec = await tot(w, 'billed', '2026-12-01', '2026-12-31')
    expect(bDec.total).toBe(410)
    expect(bDec.lines.stayShortened).toBe(-50)
  })

  it('a shortened stay’s credit made before any rent was paid stays the reservation’s money after rent is paid later: October is not rewritten', async () => {
    const w = await reservationLease({
      rent: 460, start: '2026-10-25', end: '2026-11-20', checkIn: '2026-10-25', checkOut: '2026-11-20',
      deposit: 600, depositPaidAt: '2026-10-20T10:00:00-07:00', total: 600,
    })
    await reclassified(w, { amount: 356.13, at: '2026-10-20T10:00:00-07:00', createdAt: '2026-10-25T10:00:00-07:00', note: STAY_DEPOSIT_CREDIT_NOTE })
    await reclassified(w, { amount: 44.87, at: '2026-10-20T10:00:00-07:00', createdAt: '2026-10-28T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })
    const octBefore = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(octBefore.lines.movedToCredit).toBe(-401)
    expect(octBefore.total).toBe(199)

    // November's rent (Nov 1–19) is billed and paid in cash afterwards.
    await charge(w, { amount: 291.33, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', manual: 'cash' })
    expect(await tot(w, 'billed', '2026-10-01', '2026-10-31')).toEqual(octBefore)
    const nov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(nov.lines.rent).toBe(291.33)
    expect(nov.lines.stayShortened).toBe(0)
    expect(nov.total).toBe(291.33)
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-11-15' })
    expect(card.billed).toEqual({ amount: 291.33, collected: 291.33, clearing: 0, stillOwed: 0 })
  })
})

describe('Money billed: reservation money moved to credit comes off in the month the reservation counted', () => {
  it('deposit paid Aug 20, leftover made Sep 14, rent due Oct 1: September reads $0 and August the deposit less the leftover', async () => {
    const w = await reservationLease({
      rent: 1000, start: '2026-09-14', end: '2027-03-14', checkIn: '2026-09-14', checkOut: '2027-03-14',
      deposit: 600, depositPaidAt: '2026-08-20T10:00:00-07:00', total: 6000,
    })
    // moveInBundle keeps what the arrival rent did not use, received the day the reservation was paid.
    await reclassified(w, { amount: 58.06, at: '2026-08-20T10:00:00-07:00', createdAt: '2026-09-14T10:00:00-07:00', note: STAY_DEPOSIT_CREDIT_NOTE })
    await charge(w, { amount: 1000, due: '2026-10-01' })

    const sep = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(sep.total).toBe(0)
    expect(sep.lines.movedToCredit).toBe(0)
    const aug = await tot(w, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.lines.registerAndStays).toBe(600)
    expect(aug.lines.movedToCredit).toBe(-58.06)
    expect(aug.total).toBe(541.94)
    expect(aug.beside.collectedSoFar).toBe(541.94)
    expect((await categoryTotals({ landlordIds: [w.landlordId], start: '2026-08-01', end: '2026-08-31', basis: 'billed' }))
      .categories.find(c => c.category === 'stays_and_pay_links')).toMatchObject({ billed: 541.94, collected: 541.94 })
  })

  it('a reservation paid through a pay link: its leftover comes off on the day the link was sent, where the stay was billed', async () => {
    const w = await reservationLease({
      rent: 1000, start: '2026-08-10', end: '2027-02-10', checkIn: '2026-08-10', checkOut: '2027-02-10',
      deposit: 600, depositPaidAt: '2026-08-02T10:00:00-07:00', total: 6000,
    })
    // The deposit was paid on a one-time link sent Jul 30 and paid Aug 2 (no booking-site held item).
    await db.query(`DELETE FROM held_payout_items WHERE source_id = $1`, [w.bookingId])
    const link = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                  tax_amount, total, customer_email, status, booking_id, created_at)
       VALUES ('tok-res', $1, $2, $3, 'one_time', 'Reservation deposit', '[]', 600, 0, 0, 600, 'pat@guest.test', 'paid', $4,
               '2026-07-30T10:00:00-07:00') RETURNING id`,
      [w.landlordId, w.propertyId, w.userId, w.bookingId])).rows[0].id
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, discount_amount, tax_amount,
                                     surcharge, total, status, property_id, created_at, pay_link_id)
       VALUES ($1,$2,'card',600,0,0,21.55,621.55,'completed',$3,'2026-08-02T10:00:00-07:00',$4) RETURNING id`,
      [w.landlordId, w.userId, w.propertyId, link])).rows[0].id
    await db.query(`UPDATE unit_bookings SET pos_transaction_id = $2 WHERE id = $1`, [w.bookingId, sale])
    await reclassified(w, { amount: 58.06, at: '2026-08-02T10:00:00-07:00', createdAt: '2026-08-10T10:00:00-07:00', note: STAY_DEPOSIT_CREDIT_NOTE })

    const jul = await tot(w, 'billed', '2026-07-01', '2026-07-31')
    expect(jul.lines.registerAndStays).toBe(600)
    expect(jul.lines.movedToCredit).toBe(-58.06)
    expect(jul.total).toBe(541.94)
    expect((await tot(w, 'billed', '2026-08-01', '2026-08-31')).total).toBe(0)
  })
})

describe('Money received: a shortened stay’s credit that goes into a move-out settlement', () => {
  it('the reservation’s share comes off the stay and the rent’s share off rent, so the rent card and the stays each net to what they kept', async () => {
    const w = await guestLeavesTwoDaysIn()
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,400,400,'funded','landlord')`, [w.unitId, w.leaseId, w.tenantId])
    // Aug 14: move-out with $100 of cleaning. The pool ($400 + the $612.90 credit) keeps $100.
    const fin = '2026-08-14T10:00:00-07:00'
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',0,100,0,'sent_refund',$4) RETURNING id`,
      [w.leaseId, w.tenantId, w.landlordId, fin])).rows[0].id
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE lease_id = $1`, [w.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,612.90,'2026-08-01','move_out','applied',$4::timestamptz,$4::timestamptz)`, [credit, dr, w.leaseId, fin])

    const rx = await tot(w, 'received', '2026-08-01', '2026-08-31')
    expect(rx.lines.paidAheadRefunded).toBe(-612.9)
    expect(rx.lines.depositDeductions).toBe(100)
    // August received: $74.19 rent + $100 kept − $612.90 handed back.
    expect(rx.total).toBe(-438.71)
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'received', month: '2026-08-15' })
    expect(card.collected).toBe(0)
    const cats = await categoryTotals({ landlordIds: [w.landlordId], start: '2026-07-01', end: '2026-08-31', basis: 'received' })
    expect(cats.categories.find(c => c.category === 'stays_and_pay_links')!.collected).toBe(61.29)
    expect(cats.categories.find(c => c.category === 'space_rent')!.collected).toBe(74.19)

    // The PM owner statement never counted the reservation: the pool's $100 counts, less the $74.19 of rent it handed back.
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-08' })
    expect(stmt.totals.grossCollected).toBe(100)
    expect(stmt.totals.collectedDirectly).toBe(100)
  })
})

describe('the owner statement’s billed block leaves out what the reservation’s money paid', () => {
  it('a shortened stay’s credit pays the final utility bill: the block counts only the rent’s share of it', async () => {
    const w = await guestLeavesTwoDaysIn()
    const credit = (await db.query<{ id: string }>(`SELECT id FROM lease_prepaid_credits WHERE lease_id = $1`, [w.leaseId])).rows[0].id
    const water = await charge(w, { type: 'utility', amount: 100, due: '2026-08-31' })
    await spend(w, { prepaid: credit, paymentId: water, amount: 100, at: '2026-08-31T07:00:00-07:00' })
    await settle(water, '2026-08-31T07:00:00-07:00')

    // The landlord's report: the water bill is covered by money paid ahead.
    const aug = await tot(w, 'billed', '2026-08-01', '2026-08-31')
    expect(aug.parts.coveredByPaidAhead).toBe(100)
    // The statement: $87.90 of it was the reservation's money (538.71 of 612.90), which gross never counted.
    const stmt = await ownerStatement({ landlordId: w.landlordId, periodMonth: '2026-08' })
    expect(stmt.totals.grossCollected).toBe(74.19)
    expect(stmt.totals.billed).toEqual({ billed: 12.1, collectedSoFar: 12.1, clearing: 0, stillOwed: 0 })
    expect(stmt.totals.billed.collectedSoFar).toBeLessThanOrEqual(stmt.totals.grossCollected)
  })
})

describe('a stay deposit counted in a past month is never rewritten', () => {
  it('an early check-out keeps the tax the stay was sold with: a 61-night untaxed stay’s $500 deposit paid Aug 20 still counts $500 in August after checking out Oct 2', async () => {
    const w = await world()
    await db.query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [w.propertyId])
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                  deposit_amount, deposit_paid_at)
       VALUES ($1,$2,'2026-09-10','2026-11-10','2026-11-10','month_to_month','checked_in',500,'2026-08-20T10:00:00-07:00')
       RETURNING id`, [w.unitId, w.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description)
       VALUES ($1,'booking_deposit',$2,500,'Stay deposit')`, [w.landlordId, booking])
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(w, basis, '2026-08-01', '2026-08-31')).lines.registerAndStays).toBe(500)
    }
    // Oct 2: the guest checks out early. The stay is now 22 nights on the
    // schedule, but it was sold for 61: untaxed, as booked.
    await db.query(`UPDATE unit_bookings SET check_out = '2026-10-02', status = 'checked_out' WHERE id = $1`, [booking])
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(w, basis, '2026-08-01', '2026-08-31')).lines.registerAndStays).toBe(500)
    }
  })
})

describe('a booking-site deposit counts once, on the day it arrived', () => {
  /** A 5-night stay ($330 with 10% lodging tax): $110 deposit on the booking site Aug 14, the $220 balance on a pay link. */
  async function depositThenLink(w: W): Promise<{ bookingId: string }> {
    await db.query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [w.propertyId])
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                  deposit_amount, deposit_paid_at, total_amount, stripe_payment_intent_id)
       VALUES ($1,$2,'2026-09-20','2026-09-25','2026-09-25','nightly','confirmed',110,'2026-08-14T10:00:00-07:00',330,'pi_site')
       RETURNING id`, [w.unitId, w.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1,'booking_deposit',$2,110,'Stay deposit','2026-08-14T10:00:00-07:00')`, [w.landlordId, bookingId])
    // Sep 16: a link for the balance is sent; Sep 18 it is paid ($200 stay + $20 tax).
    const link = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                  tax_amount, total, customer_email, status, booking_id, created_at)
       VALUES ('tok-bal', $1, $2, $3, 'one_time', 'Stay balance', '[]', 220, 0, 0, 220, 'g@t.dev', 'paid', $4,
               '2026-09-16T10:00:00-07:00') RETURNING id`,
      [w.landlordId, w.propertyId, w.userId, bookingId])).rows[0].id
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, discount_amount, tax_amount,
                                     surcharge, total, status, property_id, created_at, pay_link_id)
       VALUES ($1,$2,'card',200,0,20,8.25,228.25,'completed',$3,'2026-09-18T10:00:00-07:00',$4) RETURNING id`,
      [w.landlordId, w.userId, w.propertyId, link])).rows[0].id
    // settleLinkBooking: what was paid toward it is now $330 in all, paid in full.
    await db.query(
      `UPDATE unit_bookings SET deposit_amount = 330, pos_transaction_id = $2,
                                balance_billed_at = '2026-09-18T10:00:00-07:00', balance_paid_at = '2026-09-18T10:00:00-07:00'
        WHERE id = $1`, [bookingId, sale])
    return { bookingId }
  }

  it('a pay link paid toward the reservation after its booking-site deposit: the deposit in August, the link in September, never the deposit twice', async () => {
    const w = await world()
    await depositThenLink(w)
    for (const basis of ['received', 'billed'] as const) {
      expect((await tot(w, basis, '2026-08-01', '2026-08-31')).lines.registerAndStays).toBe(100)
      expect((await tot(w, basis, '2026-09-01', '2026-09-30')).lines.registerAndStays).toBe(200)
      expect((await tot(w, basis, '2026-08-01', '2026-09-30')).lines.registerAndStays).toBe(300)
    }
  })

  it('a chargeback on that booking-site deposit takes off only the deposit’s own pre-tax share', async () => {
    const w = await world()
    await depositThenLink(w)
    // The guest disputes the $110 deposit charge (with its $4.40 card fee); Stripe's $15 fee on top.
    await db.query(
      `INSERT INTO connect_disputes (stripe_dispute_id, stripe_charge_id, stripe_payment_intent_id, amount, status)
       VALUES ('dp_site', 'ch_site', 'pi_site', 114.40, 'needs_response')`)
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, created_at)
       VALUES ($1, 'dispute', 'dp_site', -129.40, 'Chargeback on a stay deposit', '2026-10-04T10:00:00-07:00')`, [w.landlordId])
    for (const basis of ['received', 'billed'] as const) {
      const oct = await tot(w, basis, '2026-10-01', '2026-10-31')
      expect(oct.lines.registerAndStays).toBe(-100)
      expect(oct.beside.chargebackFees).toBe(19.4)   // Stripe's $15 + the $4.40 card fee
    }
  })
})

// ─── Fix pass 1 of 10/4 (review cont-verify:reports-2) ────────────────────────

/**
 * A credit with no anchor took the anchor of the newest credit withdrawn on or
 * before it was made, and step 1 gives an anchor first claim, so a November
 * correction's credit landed on October, the month of a credit withdrawn back
 * in October, and rewrote it. Only the credit billLongerStay re-made from a
 * withdrawn one carries its anchor (withdrawn in the same transaction, same
 * received day). And a credit with no anchor is bounded by the rent that was
 * still there when it was banked, never by rent a dispute had already taken.
 */
describe('a credit with no anchor comes off the bill its own money came from', () => {
  it('a later shortening’s credit with no anchor comes off the month its money came from, not the month of a credit withdrawn earlier', async () => {
    const w = await world()
    const oct = await charge(w, { amount: 930, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    // Oct 16: shortened, $480 of October banked (A). Oct 20: the guest comes back; A is withdrawn, nothing re-made.
    const a = await reclassified(w, {
      amount: 480, at: '2026-10-01T10:00:00-07:00', createdAt: '2026-10-16T10:00:00-07:00', sourcePaymentId: oct, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = '2026-10-20T10:00:00-07:00', void_reason = 'The stay now ends later' WHERE id = $1`, [a])
    const nov = await charge(w, { amount: 930, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', manual: 'cash' })
    // Nov 10: shortened, $651 of November banked (B, anchored to November).
    await reclassified(w, {
      amount: 651, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-10T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    const octBefore = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    expect(octBefore.total).toBe(930)
    // Nov 12: the end is corrected to Nov 5; 5 more of November's nights ($155) banked
    // with no anchor (November already anchors B), dated by November's settle day.
    await reclassified(w, { amount: 155, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-12T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })

    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bOct.total).toBe(930)
    expect(bOct.total).toBe(octBefore.total)
    expect(bOct.lines.stayShortened ?? 0).toBe(0)
    expect(bNov.total).toBe(124)
    expect(bNov.lines.stayShortened).toBe(-806)
    for (const t of [bOct, bNov]) expect(sumParts(t.parts)).toBe(t.total)
    const card = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-10-15' })
    expect(card.billed.amount).toBe(930)
    const cardNov = await collectedRentMtd([w.landlordId], null, { scope: 'rent', basis: 'billed', month: '2026-11-15' })
    expect(cardNov.billed.amount).toBe(124)
  })

  it('a credit re-made twice after two lengthenings still comes off the bill the first credit was anchored to', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', manual: 'cash' })
    // Nov 10: shortened, $300 of November banked against it.
    const first = await reclassified(w, {
      amount: 300, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-10T10:00:00-07:00', sourcePaymentId: nov, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    // Nov 20: lengthened a little; billLongerStay withdraws it and re-makes $200 in the same transaction.
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = '2026-11-20T10:00:00-07:00', void_reason = 'The stay now ends later' WHERE id = $1`, [first])
    const second = await reclassified(w, { amount: 200, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-20T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })
    // Nov 25: lengthened again; the re-made credit is withdrawn and $80 re-made.
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = '2026-11-25T10:00:00-07:00', void_reason = 'The stay now ends later' WHERE id = $1`, [second])
    await reclassified(w, { amount: 80, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-25T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })

    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bOct.total).toBe(460)
    expect(bNov.total).toBe(380)
    expect(bNov.lines.stayShortened).toBe(-80)
    const ev = (await incomeEvents({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-11-30', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened')
    expect(ev.map(e => ({ paymentId: e.paymentId, amount: e.amount }))).toEqual([{ paymentId: nov, amount: -80 }])
  })

  it('a credit re-made from a withdrawn credit that had no received day still comes off the withdrawn credit’s bill, though the re-made one’s received day kept whole milliseconds only', async () => {
    const w = await world()
    const oct = await charge(w, { amount: 930, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    // November's rent paid early, on Oct 10.
    await charge(w, { amount: 930, due: '2026-11-01', settledAt: '2026-10-10T10:00:00-07:00', manual: 'cash' })
    // Oct 16: $480 of October banked against it, with no received day (an older row).
    const first = await reclassified(w, {
      amount: 480, at: '2026-10-16T10:00:00.654321-07:00', createdAt: '2026-10-16T10:00:00.654321-07:00',
      sourcePaymentId: oct, note: STAY_SHORTENED_CREDIT_NOTE,
    })
    await db.query(`UPDATE lease_prepaid_credits SET received_at = NULL WHERE id = $1`, [first])
    // Oct 20: lengthened a little; billLongerStay withdraws it and re-makes $200
    // in the same transaction, received on the withdrawn one's created_at as a
    // JS Date carries it (whole milliseconds).
    await db.query(`UPDATE lease_prepaid_credits SET voided_at = '2026-10-20T10:00:00-07:00', void_reason = 'The stay now ends later' WHERE id = $1`, [first])
    await reclassified(w, {
      amount: 200, at: '2026-10-16T10:00:00.654-07:00', createdAt: '2026-10-20T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE,
    })

    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bOct.total).toBe(730)
    expect(bOct.lines.stayShortened).toBe(-200)
    expect(bNov.total).toBe(930)
    expect(bNov.lines.stayShortened ?? 0).toBe(0)
    const ev = (await incomeEvents({ landlordIds: [w.landlordId], start: '2026-10-01', end: '2026-11-30', basis: 'billed' }))
      .filter(e => e.line === 'stayShortened')
    expect(ev.map(e => ({ paymentId: e.paymentId, amount: e.amount }))).toEqual([{ paymentId: oct, amount: -200 }])
  })

  it('rent disputed after the credit was banked still held the credit’s money: the credit comes off that bill, and the month before is not touched', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-10-01', settledAt: '2026-10-01T10:00:00-07:00', manual: 'cash' })
    const nov = await charge(w, { amount: 460, due: '2026-11-01', settledAt: '2026-11-01T10:00:00-07:00', stripeCharge: 'ch_after' })
    // Nov 12: $100 of November banked with no anchor, dated by November's settle day.
    await reclassified(w, { amount: 100, at: '2026-11-01T10:00:00-07:00', createdAt: '2026-11-12T10:00:00-07:00', note: STAY_SHORTENED_CREDIT_NOTE })
    // Nov 20: November's card payment disputed in full; the reopened row is owed again.
    await dispute(w, { paymentId: nov, amount: 460, at: '2026-11-20T10:00:00-07:00', due: '2026-11-01' })

    const bOct = await tot(w, 'billed', '2026-10-01', '2026-10-31')
    const bNov = await tot(w, 'billed', '2026-11-01', '2026-11-30')
    expect(bOct.total).toBe(460)
    expect(bOct.lines.stayShortened ?? 0).toBe(0)
    expect(bNov.total).toBe(360)
    expect(bNov.lines.stayShortened).toBe(-100)
    expect(bNov.parts.stillOwed).toBe(360)
    expect(sumParts(bNov.parts)).toBe(360)
  })
})

// ─── Choice46d: decisions #48.5 — a voided charge ────────────────────────────

describe('decisions #48.5: a voided charge (nobody owes it; kept as a record) is left out of every figure', () => {
  it('a voided reservation fee is never billed, never still owed and never collected — under both bases, and no fact of it is listed', async () => {
    const w = await world()
    await charge(w, { amount: 460, due: '2026-09-01', settledAt: '2026-09-02T10:00:00-07:00' })
    const fee = await charge(w, { type: 'fee', amount: 75, due: '2026-09-10', notes: 'Clubhouse reservation fee' })
    const before = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(before.parts.stillOwed).toBe(75)
    await db.query(`UPDATE payments SET status = 'voided', voided_at = NOW(), void_reason = 'The reservation it was for was canceled' WHERE id = $1`, [fee])
    const b = await tot(w, 'billed', '2026-09-01', '2026-09-30')
    expect(b.total).toBe(460)
    expect(b.parts.stillOwed).toBe(0)
    expect(sumParts(b.parts)).toBe(460)
    const r = await tot(w, 'received', '2026-09-01', '2026-09-30')
    expect(r.total).toBe(460)
    const events = await incomeEvents({ landlordIds: [w.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'billed' })
    expect(events.filter((e) => e.paymentId === fee)).toEqual([])
  })
})
