/**
 * 10/12 (Nic): "NO 'Money received / Money billed' toggle anywhere — show
 * Charged, Received and Owed side by side as columns, with a short line
 * showing how they tie."
 *
 * The three columns are built from the two kinds of facts every report reads
 * (services/incomeBasis): each column adds up its own facts, every line and
 * category is a grouping of them, and the tie splits each column into parts
 * that add back to it exactly. Plus the monthly P&L's one line per day, and
 * the new tables' CHECKs matching the shared lists.
 */
import { describe, it, expect } from 'vitest'
import { MONTHLY_REPORT_RECIPIENT_KINDS, MONTHLY_REPORT_SEND_STATUSES } from '@gam/shared'
import { db } from '../db'
import { moneyViewFrom, moneyTieText, sayDollars, monthWords, type IncomeEvent } from './incomeBasis'
import { dailyLines } from '../routes/reports'

const ev = (o: Partial<IncomeEvent> & Pick<IncomeEvent, 'line' | 'amount' | 'day'>): IncomeEvent => ({
  landlordId: 'l', propertyId: 'p', unitId: null, leaseId: null, paymentId: null, dueDate: null,
  category: null, part: null, inTotal: true, moveOutId: null, ...o,
})
const SEPT = { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' }
const r2 = (n: number) => Math.round(n * 100) / 100

describe('Charged / Received / Owed from the two kinds of facts', () => {
  // September: two rent bills ($460 paid, $460 still owed), a $25 late fee
  // owed, $30 of electric paid with money still clearing, a credit you gave of
  // $10 on the paid bill (its line and the negative "Credits given").
  const billed = [
    ev({ line: 'rent', category: 'space_rent', amount: 450, part: 'paid', day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'rent', category: 'space_rent', amount: 10, part: null, day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'creditsGiven', category: 'space_rent', amount: -10, day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'rent', category: 'space_rent', amount: 460, part: 'stillOwed', day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'lateFees', category: 'late_fees', amount: 25, part: 'stillOwed', day: '2026-09-07', dueDate: '2026-09-07' }),
    ev({ line: 'utilities', category: 'electric', amount: 30, part: 'clearing', day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'workTrade', category: 'space_rent', amount: 200, inTotal: false, day: '2026-09-01', dueDate: '2026-09-01' }),
  ]
  // Received in September: this month's paid rent ($450), August's late rent
  // ($460, Sep 4), $920 paid ahead (Todd), $40 at the register, a dispute
  // taking $100 of an August payment back; and beside it the work trade, a
  // $500 deposit held, $30 still clearing, and $10 of credit used.
  const received = [
    ev({ line: 'rent', category: 'space_rent', amount: 450, day: '2026-09-03', dueDate: '2026-09-01' }),
    ev({ line: 'rent', category: 'space_rent', amount: 460, day: '2026-09-04', dueDate: '2026-08-01' }),
    ev({ line: 'paidAhead', amount: 920, day: '2026-09-20' }),
    ev({ line: 'registerAndStays', category: 'register_sales', amount: 40, day: '2026-09-21' }),
    ev({ line: 'returned', category: 'space_rent', amount: -100, day: '2026-09-25', dueDate: '2026-08-01' }),
    ev({ line: 'workTrade', category: 'space_rent', amount: 200, inTotal: false, day: '2026-09-01', dueDate: '2026-09-01' }),
    ev({ line: 'depositsHeld', amount: 500, inTotal: false, day: '2026-09-02' }),
    ev({ line: 'clearing', amount: 30, inTotal: false, day: '2026-09-29' }),
    ev({ line: 'creditsYouGave', amount: 10, inTotal: false, day: '2026-09-03' }),
  ]
  const v = moneyViewFrom(billed, received, SEPT, 460)

  it('each column adds up its own facts', () => {
    expect([v.charged, v.received, v.owed]).toEqual([965, 1770, 485])
    expect(v.collected).toBe(450)
    expect(v.clearing).toBe(30)
  })

  it('the lines and the categories are groupings of the same facts: they add up to each column', () => {
    for (const k of ['charged', 'received', 'owed'] as const) {
      expect(r2(v.lines.reduce((s, l) => s + l[k], 0))).toBe(v[k])
      expect(r2([...v.categories, ...v.uncategorized].reduce((s, l) => s + l[k], 0))).toBe(v[k])
    }
    expect(v.categories.find(c => c.category === 'space_rent')).toEqual({ category: 'space_rent', label: 'Lot/space rent', charged: 910, received: 810, owed: 460 })
    expect(v.uncategorized).toEqual([{ line: 'paidAhead', label: 'Paid ahead for later bills', charged: 0, received: 920, owed: 0 }])
  })

  it('the tie splits each column into parts that add back to it', () => {
    expect(v.tie.charged).toEqual({ collected: 450, clearing: 30, owed: 485, other: 0 })
    expect(v.tie.received).toEqual({ forPeriodBills: 450, forEarlierBills: 360, paidAhead: 920, noBill: 40 })
    expect(v.tie.stillClearing).toBe(30)
    // 10/12 (Nic, L2): Received leads.
    expect(v.tieText).toEqual([
      'Of $1,770.00 received, $450.00 was for bills due in September 2026, $360.00 for bills due earlier, $920.00 was paid ahead for later bills and $40.00 had no bill behind it (register sales, stays, other income).',
      'Of $965.00 charged, $450.00 is collected, $30.00 is still clearing and $485.00 is still owed.',
      '$30.00 more was paid and is still clearing; it counts in Received the day it arrives.',
    ])
  })

  it('beside the columns, in none of them: work trade, deposits held, paid ahead not used yet — never clearing or credits (they are in the tie and in Charged)', () => {
    expect(v.beside.map(b => [b.key, b.amount])).toEqual([['workTrade', 200], ['depositsHeld', 500], ['paidAheadUnused', 460]])
  })

  it('a fact on a line outside the report\'s list still counts in its column\'s total (as the totals always have)', () => {
    const w = moneyViewFrom([], [ev({ line: 'someNewLine' as any, category: 'other_fees', amount: 12, day: '2026-09-02' })], SEPT)
    expect(w.received).toBe(12)
    expect(w.categories).toEqual([{ category: 'other_fees', label: 'Other fees', charged: 0, received: 12, owed: 0 }])
  })

  it('a quiet month says so in plain words, every part still shown once', () => {
    const q = moneyViewFrom([], [], SEPT)
    expect([q.charged, q.received, q.owed]).toEqual([0, 0, 0])
    expect(moneyTieText(q, 'September 2026')).toEqual([
      'Of $0.00 received, $0.00 was for bills due in September 2026.',
      'Of $0.00 charged, $0.00 is collected and $0.00 is still owed.',
    ])
    expect(sayDollars(-12.5)).toBe('−$12.50')
    expect(monthWords('2026-09')).toBe('September 2026')
  })
})

describe('the monthly P&L: one line per day, with the expenses logged that day (10/12, Nic)', () => {
  const events = [
    ev({ line: 'rent', category: 'space_rent', amount: 460, day: '2026-09-03', paymentId: 'p1' }),
    ev({ line: 'utilities', category: 'electric', amount: 30, day: '2026-09-03', paymentId: 'p1' }),
    ev({ line: 'paidAhead', amount: 920, day: '2026-09-03' }),
    ev({ line: 'rent', category: 'space_rent', amount: 500, day: '2026-09-05', paymentId: 'p2' }),
    ev({ line: 'depositsHeld', amount: 500, day: '2026-09-05', inTotal: false }),
  ]
  const rows = [
    { id: 'p1', key: 'p1:2026-09-03', day: '2026-09-03', amount: 490 },
    { id: 'p2', key: 'p2:2026-09-05', day: '2026-09-05', amount: 500 },
  ]
  const expenses = new Map([['2026-09-05', { amount: 2000, count: 1 }], ['2026-09-12', { amount: 75.5, count: 2 }]])
  const days = dailyLines(events, rows, expenses)

  it('newest first, one line per day with its total, expenses under it — a day with only expenses too', () => {
    expect(days.map(d => [d.day, d.received, d.expensesLogged])).toEqual([
      ['2026-09-12', 0, 75.5], ['2026-09-05', 500, 2000], ['2026-09-03', 1410, 0],
    ])
  })

  it('a day opens to its payments; money with no single charge (paid ahead) is the rest of the day', () => {
    const sep3 = days.find(d => d.day === '2026-09-03')!
    expect(sep3).toMatchObject({ chargesTotal: 490, noCharge: 920, paymentCount: 1, paymentKeys: ['p1:2026-09-03'] })
  })

  it('the days add up to the month\'s Received (deposits held are never in it)', () => {
    expect(r2(days.reduce((s, d) => s + d.received, 0))).toBe(1910)
  })
})

describe('the new tables\' CHECKs are the shared lists (one definition)', () => {
  const values = async (constraint: string): Promise<string[]> => {
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [constraint])
    return [...(r.rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
  }
  it('monthly_report_recipients.kind', async () => {
    expect((await values('monthly_report_recipients_kind_check')).sort()).toEqual([...MONTHLY_REPORT_RECIPIENT_KINDS].sort())
  })
  it('monthly_report_sends.status', async () => {
    expect((await values('monthly_report_sends_status_check')).sort()).toEqual([...MONTHLY_REPORT_SEND_STATUSES].sort())
  })
})
