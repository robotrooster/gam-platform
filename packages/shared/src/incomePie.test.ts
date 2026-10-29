/**
 * 10/13 (Nic, full purchase) — the admin income pies with a card reader GAM
 * bought in them: a slice below zero is named under its pie, never drawn and
 * never a color in the legend; the ring and the shares are of what came in.
 */
import { describe, it, expect } from 'vitest'
import { incomeRing, incomeLegend, incomeShare } from './incomePie'

const C = 2 * Math.PI * 40

// Production's all-time pie the day Mountain View's reader goes into GAM's book.
const allTime = [
  { key: 'platform_unit', label: 'Platform Fees', amount: 296, recurring: true },
  { key: 'processing', label: 'Processing / ACH', amount: 216.57 },
  { key: 'background_checks', label: 'Background Checks', amount: 25 },
  { key: 'card_reader_purchases', label: 'Card Readers Bought', amount: -331.73 },
  { key: 'card_reader_repaid', label: 'Card Reader Cost Repaid', amount: 87.5 },
  { key: 'card_reader_markup', label: 'Card Reader Markup', amount: 0 },
  { key: 'adjustments', label: 'Adjustments', amount: 10.33 },
]

describe('incomeRing', () => {
  it('draws the slices above zero once around, against their own total — not against the net', () => {
    const r = incomeRing(allTime, C)
    expect(r.inTotal).toBe(635.4)
    expect(r.arcs.map(a => a.key)).toEqual(['platform_unit', 'processing', 'background_checks', 'card_reader_repaid', 'adjustments'])
    const drawn = r.arcs.reduce((a, s) => a + s.len, 0)
    expect(drawn).toBeCloseTo(C, 9)
    // Each arc starts where the one before it ends.
    r.arcs.forEach((a, i) => expect(a.off).toBeCloseTo(i === 0 ? 0 : r.arcs[i - 1].off + r.arcs[i - 1].len, 9))
    expect(r.arcs[0].len).toBeCloseTo((296 / 635.4) * C, 9)
  })

  it('names what is below zero apart; a slice at $0.00 is neither drawn nor named', () => {
    const r = incomeRing(allTime, C)
    expect(r.below.map(s => [s.key, s.amount])).toEqual([['card_reader_purchases', -331.73]])
    expect(r.arcs.find(a => a.key === 'card_reader_markup')).toBeUndefined()
  })

  it('a window with only the purchase in it: nothing drawn, the purchase named', () => {
    const r = incomeRing([{ key: 'card_reader_purchases', label: 'Card Readers Bought', amount: -331.73 }], C)
    expect(r).toEqual({ arcs: [], below: [{ key: 'card_reader_purchases', label: 'Card Readers Bought', amount: -331.73 }], inTotal: 0 })
    expect(incomeRing(null, C)).toEqual({ arcs: [], below: [], inTotal: 0 })
  })
})

describe('incomeLegend', () => {
  it('names every slice drawn on some ring, in the order the windows first name them — and never one only ever below zero', () => {
    const month = [
      { key: 'platform_unit', label: 'Platform Fees', amount: 166, recurring: true },
      { key: 'card_reader_repaid', label: 'Card Reader Cost Repaid', amount: 87.5 },
    ]
    expect(incomeLegend([{ sources: month }, { sources: allTime }])).toEqual([
      { key: 'platform_unit', label: 'Platform Fees', recurring: true },
      { key: 'card_reader_repaid', label: 'Card Reader Cost Repaid', recurring: false },
      { key: 'processing', label: 'Processing / ACH', recurring: false },
      { key: 'background_checks', label: 'Background Checks', recurring: false },
      { key: 'adjustments', label: 'Adjustments', recurring: false },
    ])
  })

  it('a slice above zero in one window and below it in another (a refund on a reader bought earlier) is in the legend — it is drawn there', () => {
    const refundMonth = [{ key: 'card_reader_purchases', label: 'Card Readers Bought', amount: 29.47 }]
    expect(incomeLegend([{ sources: allTime }, { sources: refundMonth }]).map(s => s.key)).toContain('card_reader_purchases')
    expect(incomeLegend([{ sources: allTime }]).map(s => s.key)).not.toContain('card_reader_purchases')
    expect(incomeLegend(undefined)).toEqual([])
  })
})

describe('incomeShare', () => {
  it('a share of what came in; none for a slice at or below zero', () => {
    expect(incomeShare(296, allTime)).toBeCloseTo((296 / 635.4) * 100, 9)
    expect(incomeShare(-331.73, allTime)).toBeNull()
    expect(incomeShare(0, allTime)).toBeNull()
    expect(incomeShare(5, [])).toBeNull()
    // The shares above zero come to 100%.
    const sum = allTime.reduce((a, s) => a + (incomeShare(s.amount, allTime) ?? 0), 0)
    expect(sum).toBeCloseTo(100, 9)
  })
})
