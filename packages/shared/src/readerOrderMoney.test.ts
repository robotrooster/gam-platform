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

describe('READER_ORDER_COST_SOURCES', () => {
  it('every source has words for the desk', () => {
    for (const s of READER_ORDER_COST_SOURCES) expect(READER_ORDER_COST_SOURCE_LABEL[s]).toBeTruthy()
  })
})
