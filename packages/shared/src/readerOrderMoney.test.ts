/**
 * 10/12 (Nic) — a card reader's price, split into GAM's cost and markup.
 *
 * "331.73 after tax and shipping. 299 base." and (Q-g) "COST FIRST — pieces
 * repay GAM's cost first; the markup lands in the last piece(s)."
 */
import { describe, it, expect } from 'vitest'
import {
  readerCostTotal, readerPieceSplit, readerOrderMoney,
  READER_ORDER_COST_SOURCES, READER_ORDER_COST_SOURCE_LABEL,
  readerBookRows, readerBookTotals, READER_BOOK_ROW_KINDS, READER_BOOK_ROW_KIND_LABEL, READER_BOOK_REFERENCE,
} from './index'

describe('readerCostTotal', () => {
  it('adds base, tax and shipping — or the combined figure — to the cent', () => {
    expect(readerCostTotal({ basePrice: 299, taxAndShipping: 32.73 })).toBe(331.73)
    expect(readerCostTotal({ basePrice: 299, tax: 21.78, shipping: 10.95 })).toBe(331.73)
    expect(readerCostTotal({ basePrice: 0.1, tax: 0.2 })).toBe(0.3)
  })
})

describe('readerPieceSplit — cost first', () => {
  it("Mountain View: pieces 1-3 are all cost; piece 4 is $69.23 cost + $18.27 markup", () => {
    expect(readerPieceSplit(350, 4, 331.73)).toEqual([
      { n: 1, amount: 87.5, cost: 87.5, markup: 0 },
      { n: 2, amount: 87.5, cost: 87.5, markup: 0 },
      { n: 3, amount: 87.5, cost: 87.5, markup: 0 },
      { n: 4, amount: 87.5, cost: 69.23, markup: 18.27 },
    ])
  })

  it('a cheaper reader puts markup in the last two pieces', () => {
    const s = readerPieceSplit(350, 4, 200)
    expect(s.map(p => [p.cost, p.markup])).toEqual([[87.5, 0], [87.5, 0], [25, 62.5], [0, 87.5]])
  })

  it('cost not entered: every dollar is cost, nothing is earnings', () => {
    expect(readerPieceSplit(350, 4, null).every(p => p.markup === 0 && p.cost === p.amount)).toBe(true)
  })

  it('a reader that cost more than it is charged: no markup anywhere', () => {
    expect(readerPieceSplit(350, 4, 361.2).reduce((a, p) => a + p.markup, 0)).toBe(0)
  })
})

describe('readerOrderMoney', () => {
  const mv = (pieces: Array<[number, number]>, totalCost: number | null = 331.73) => readerOrderMoney({
    price: 350, installments: 4, totalCost,
    pieces: pieces.map(([n, collected]) => ({ n, amount: 87.5, collected })),
  })

  it('charged, cost and markup per order', () => {
    expect(mv([])).toMatchObject({ charged: 350, totalCost: 331.73, markup: 18.27, billed: 0, markupBilled: 0 })
    expect(mv([], null)).toMatchObject({ totalCost: null, markup: null })
  })

  it('three pieces in: all of it is cost coming back', () => {
    expect(mv([[1, 87.5], [2, 87.5], [3, 87.5]])).toMatchObject({
      billed: 262.5, collected: 262.5, markupBilled: 0, markupCollected: 0, costRecovered: 262.5, markupNotCollected: 0,
    })
  })

  it('the last piece billed, not collected: its markup is owed', () => {
    expect(mv([[1, 87.5], [2, 87.5], [3, 87.5], [4, 0]])).toMatchObject({
      billed: 350, markupBilled: 18.27, markupCollected: 0, costRecovered: 262.5, markupNotCollected: 18.27,
    })
  })

  it('part of the last piece collected: the cost is covered before any of it is markup', () => {
    expect(mv([[1, 87.5], [2, 87.5], [3, 87.5], [4, 70]])).toMatchObject({
      collected: 332.5, markupCollected: 0.77, costRecovered: 331.73, markupNotCollected: 17.5,
    })
  })

  it('paid off: $331.73 cost back, $18.27 markup', () => {
    expect(mv([[1, 87.5], [2, 87.5], [3, 87.5], [4, 87.5]])).toMatchObject({
      collected: 350, costRecovered: 331.73, markupCollected: 18.27, markupNotCollected: 0,
    })
  })

  it('cost first holds across the order: the last piece paid before the others is still cost', () => {
    expect(mv([[1, 0], [2, 0], [3, 0], [4, 87.5]])).toMatchObject({ markupBilled: 18.27, markupCollected: 0, costRecovered: 87.5 })
  })

  it('a voided piece is billed to nobody', () => {
    const m = readerOrderMoney({ price: 350, installments: 4, totalCost: 331.73,
      pieces: [{ n: 4, amount: 87.5, collected: 0, voided: true }] })
    expect(m).toMatchObject({ billed: 0, markupBilled: 0, markupNotCollected: 0 })
  })
})

// 10/13 (Nic): "record each reader as a GAM expense (loss if cost > charge)".
describe('a reader that cost GAM more than it charges is a loss', () => {
  it('readerOrderMoney names the loss; none when it earns markup; unknown with no cost', () => {
    const at = (totalCost: number | null) => readerOrderMoney({ price: 350, installments: 4, totalCost, pieces: [] })
    expect(at(331.73)).toMatchObject({ markup: 18.27, loss: 0 })
    expect(at(361.2)).toMatchObject({ markup: -11.2, loss: 11.2 })
    expect(at(350)).toMatchObject({ markup: 0, loss: 0 })
    expect(at(null)).toMatchObject({ markup: null, loss: null })
  })

  it('a loss carries no markup in any piece, billed or not', () => {
    const m = readerOrderMoney({ price: 350, installments: 4, totalCost: 361.2,
      pieces: [1, 2, 3, 4].map(n => ({ n, amount: 87.5, collected: 87.5 })) })
    expect(m).toMatchObject({ markupBilled: 0, markupCollected: 0, costRecovered: 350, loss: 11.2 })
  })
})

describe('READER_ORDER_COST_SOURCES', () => {
  it('every source has words for the desk', () => {
    for (const s of READER_ORDER_COST_SOURCES) expect(READER_ORDER_COST_SOURCE_LABEL[s]).toBeTruthy()
  })
})

// 10/13 (Nic, afternoon): FULL PURCHASE — "Book the $331.73 as an expense the day we buy it, and
// each $87.50 payment as paying it back (lowers 'earned all time' until repaid)."
describe('readerBookRows — a reader in GAM\'s own book', () => {
  const piece = (n: number, billedOn: string, voided = false) => ({ id: `g${n}`, n, amount: 87.5, billedOn, voided })
  const mv = { price: 350, installments: 4, bought: true, entries: [{ id: 'c1', total: 331.73, effectiveOn: '2026-09-28' }] }

  it("Mountain View: −$331.73 the day GAM bought it, then +$87.50 of cost repaid a month, and piece 4 is $69.23 repaid + $18.27 markup", () => {
    expect(readerBookRows({ ...mv, pieces: [] })).toEqual([
      { kind: 'purchase', ref: 'c1', amount: -331.73, on: '2026-09-28', cost: 331.73 },
    ])
    const rows = readerBookRows({ ...mv, pieces: [piece(1, '2026-10-05'), piece(2, '2026-11-01'), piece(3, '2026-12-01'), piece(4, '2027-01-01')] })
    expect(rows.map(r => [r.kind, r.ref, r.n ?? null, r.amount, r.on])).toEqual([
      ['purchase', 'c1', null, -331.73, '2026-09-28'],
      ['cost_repaid', 'g1', 1, 87.5, '2026-10-05'],
      ['cost_repaid', 'g2', 2, 87.5, '2026-11-01'],
      ['cost_repaid', 'g3', 3, 87.5, '2026-12-01'],
      ['cost_repaid', 'g4', 4, 69.23, '2027-01-01'],
      ['markup', 'g4', 4, 18.27, '2027-01-01'],
    ])
    // Paid off: the book holds the markup, and nothing of the cost.
    expect(readerBookTotals(rows)).toEqual({ purchase: -331.73, costRepaid: 331.73, markup: 18.27, net: 18.27 })
    // One piece in: it lowers "earned all time" until repaid.
    expect(readerBookTotals(readerBookRows({ ...mv, pieces: [piece(1, '2026-10-05')] })).net).toBe(-244.23)
  })

  it('nothing until the cost is entered; no purchase for a reader GAM never bought', () => {
    expect(readerBookRows({ ...mv, entries: [], pieces: [piece(1, '2026-10-05')] })).toEqual([])
    expect(readerBookRows({ ...mv, bought: false, pieces: [] })).toEqual([])
  })

  it('a dated correction books the difference on its own date; the figure before it stays', () => {
    const rows = readerBookRows({ ...mv, entries: [
      { id: 'c1', total: 331.73, effectiveOn: '2026-09-28' },
      { id: 'c2', total: 336.73, effectiveOn: '2026-10-01' },   // extra shipping
      { id: 'c3', total: 336.73, effectiveOn: '2026-10-02' },   // the same total, split differently
      { id: 'c4', total: 326.73, effectiveOn: '2026-10-09' },   // a $10.00 refund
    ], pieces: [] })
    expect(rows).toEqual([
      { kind: 'purchase', ref: 'c1', amount: -331.73, on: '2026-09-28', cost: 331.73 },
      { kind: 'purchase', ref: 'c2', amount: -5, on: '2026-10-01', cost: 336.73, previousCost: 331.73 },
      { kind: 'purchase', ref: 'c4', amount: 10, on: '2026-10-09', cost: 326.73, previousCost: 336.73 },
    ])
    expect(readerBookTotals(rows).purchase).toBe(-326.73)
  })

  it('each piece is split under the cost in force the day it was billed; the first entry covers the days before it', () => {
    const rows = readerBookRows({ price: 350, installments: 4, bought: true, entries: [
      { id: 'c1', total: 331.73, effectiveOn: '2026-12-15' },   // typed late
      { id: 'c2', total: 250, effectiveOn: '2026-12-20' },      // a refund before piece 4
    ], pieces: [piece(3, '2026-12-01'), piece(4, '2027-01-01')] })
    expect(rows.filter(r => r.kind !== 'purchase' && !r.resplit).map(r => [r.kind, r.n, r.amount, r.cost])).toEqual([
      ['cost_repaid', 3, 87.5, 331.73],
      ['markup', 4, 87.5, 250],
    ])
    // 10/13 evening (Nic: "Redo the split"): piece 3, billed before the refund, is split again under
    // it on the refund's day — $75.00 of cost and $12.50 of markup under $250.00.
    expect(rows.filter(r => r.resplit).map(r => [r.kind, r.n, r.amount, r.on, r.cost, r.previousCost, r.resplitUnder])).toEqual([
      ['cost_repaid', 3, -12.5, '2026-12-20', 250, 331.73, 'c2'],
      ['markup', 3, 12.5, '2026-12-20', 250, 331.73, 'c2'],
    ])
  })

  // 10/13 evening (Nic): "Redo the split" — a cost correction after pieces are booked redoes the
  // split, as a dated correction, so the markup is only what is beyond the cost.
  describe('a correction after pieces are booked redoes their split, dated the correction\'s day', () => {
    const paid = [piece(1, '2026-10-05'), piece(2, '2026-11-01'), piece(3, '2026-12-01'), piece(4, '2027-01-01')]

    it('$5.00 more shipping from 2/1: piece 4 moves $5.00 from markup to cost repaid on 2/1; its own rows stay dated the day billed', () => {
      const rows = readerBookRows({ ...mv, entries: [...mv.entries, { id: 'c2', total: 336.73, effectiveOn: '2027-02-01' }], pieces: paid })
      expect(rows.map(r => [r.kind, r.n ?? null, r.amount, r.on])).toEqual([
        ['purchase', null, -331.73, '2026-09-28'],
        ['purchase', null, -5, '2027-02-01'],
        ['cost_repaid', 1, 87.5, '2026-10-05'],
        ['cost_repaid', 2, 87.5, '2026-11-01'],
        ['cost_repaid', 3, 87.5, '2026-12-01'],
        ['cost_repaid', 4, 69.23, '2027-01-01'],
        ['markup', 4, 18.27, '2027-01-01'],
        ['cost_repaid', 4, 5, '2027-02-01'],
        ['markup', 4, -5, '2027-02-01'],
      ])
      expect(rows.filter(r => r.resplit).every(r => r.resplitUnder === 'c2' && r.cost === 336.73 && r.previousCost === 331.73)).toBe(true)
      // The slices: the cost repaid is the whole cost, the markup only what is beyond it.
      expect(readerBookTotals(rows)).toEqual({ purchase: -336.73, costRepaid: 336.73, markup: 13.27, net: 13.27 })
    })

    it('a refund moves cost repaid to markup; each later correction redoes it again from the split before it', () => {
      const rows = readerBookRows({ ...mv, pieces: paid, entries: [
        ...mv.entries,
        { id: 'c2', total: 300, effectiveOn: '2027-02-01' },      // a $31.73 refund
        { id: 'c3', total: 340, effectiveOn: '2027-03-01' },      // and then $40.00 more after all
      ] })
      expect(rows.filter(r => r.resplit).map(r => [r.kind, r.n, r.amount, r.on, r.resplitUnder])).toEqual([
        ['cost_repaid', 4, -31.73, '2027-02-01', 'c2'], ['markup', 4, 31.73, '2027-02-01', 'c2'],
        ['cost_repaid', 4, 40, '2027-03-01', 'c3'], ['markup', 4, -40, '2027-03-01', 'c3'],
      ])
      expect(readerBookTotals(rows)).toEqual({ purchase: -340, costRepaid: 340, markup: 10, net: 10 })
    })

    it('a correction that pushes the cost past the price: the markup booked goes back, and the book holds the loss', () => {
      const rows = readerBookRows({ ...mv, pieces: paid, entries: [...mv.entries, { id: 'c2', total: 360, effectiveOn: '2027-02-01' }] })
      expect(rows.filter(r => r.resplit).map(r => [r.kind, r.n, r.amount])).toEqual([['cost_repaid', 4, 18.27], ['markup', 4, -18.27]])
      expect(readerBookTotals(rows)).toEqual({ purchase: -360, costRepaid: 350, markup: 0, net: -10 })
    })

    it('a piece billed on or after the correction is split under it once — nothing to redo; one that never moves between cost and markup gets no row', () => {
      const rows = readerBookRows({ ...mv, entries: [...mv.entries, { id: 'c2', total: 336.73, effectiveOn: '2026-12-01' }], pieces: paid })
      // Pieces 1-2 stay all cost under either figure; 3 and 4 are billed under the correction.
      expect(rows.filter(r => r.resplit)).toEqual([])
      expect(rows.filter(r => r.n === 4).map(r => [r.kind, r.amount, r.cost])).toEqual([['cost_repaid', 74.23, 336.73], ['markup', 13.27, 336.73]])
    })

    it('a voided piece is never redone', () => {
      const rows = readerBookRows({ ...mv, entries: [...mv.entries, { id: 'c2', total: 250, effectiveOn: '2027-02-01' }],
        pieces: [...paid.slice(0, 3), piece(4, '2027-01-01', true)] })
      expect(rows.filter(r => r.resplit).map(r => [r.kind, r.n, r.amount])).toEqual([['cost_repaid', 3, -12.5], ['markup', 3, 12.5]])
    })
  })

  it('a reader that cost GAM more than it charges: every piece is cost repaid, and the loss stays below zero', () => {
    const rows = readerBookRows({ price: 350, installments: 4, bought: true,
      entries: [{ id: 'c1', total: 361.2, effectiveOn: '2026-05-11' }],
      pieces: [1, 2, 3, 4].map(n => piece(n, '2026-09-01')) })
    expect(rows.filter(r => r.kind === 'markup')).toEqual([])
    expect(readerBookTotals(rows)).toEqual({ purchase: -361.2, costRepaid: 350, markup: 0, net: -11.2 })
  })

  it('a voided piece is not booked', () => {
    const rows = readerBookRows({ ...mv, pieces: [piece(1, '2026-10-05', true)] })
    expect(rows.map(r => r.kind)).toEqual(['purchase'])
  })

  it('every kind has words for the desk, and the references are distinct', () => {
    for (const k of READER_BOOK_ROW_KINDS) expect(READER_BOOK_ROW_KIND_LABEL[k]).toBeTruthy()
    expect(new Set(Object.values(READER_BOOK_REFERENCE)).size).toBe(Object.keys(READER_BOOK_REFERENCE).length)
  })
})
