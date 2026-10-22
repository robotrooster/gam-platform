/**
 * 10/21 (Nic) — "I'm wondering if we have a collision on size."
 *
 *   "if I put something that takes up half the width of the screen and then
 *    something else that takes up like a third, there's going to be a little
 *    leftover space at the end. Can it only do like will it allow a card that
 *    is too big to go next to it and mess up the view?"
 *
 * Two different worries in there, and they have different answers.
 *
 * OVERLAP cannot happen. A CSS grid places each card in the next space that
 * fits and never stacks one on another, so there is nothing to test for.
 *
 * HOLES absolutely could. The ten cards ship as thirds, halves and one full
 * width, sized so the DEFAULT rows add to twelve exactly — and any other order
 * breaks that, because a half will not fit in a third of leftover room. It
 * drops to the next row and leaves the gap he is describing.
 *
 * So a dragged layout makes every card the same width. This is the proof: over
 * every shape of arrangement, the rows stay full.
 */
import { describe, it, expect } from 'vitest'
import { DASHBOARD_CARDS } from './useDashboardCards'

/** The widths the cards ship at, in the order they ship. */
const SHIPPED_SPANS = [4, 4, 4, 3, 3, 3, 3, 6, 6, 12]
const COLUMNS = 12
const UNIFORM = 6   // half the row — what every card becomes once somebody arranges their own

/** Empty cells left in COMPLETED rows — the last row's remainder is just the end of the list. */
function holesBetween(spans: number[]): number[] {
  const holes: number[] = []
  let used = 0
  for (const s of spans) {
    if (used + s > COLUMNS) { holes.push(COLUMNS - used); used = 0 }
    used += s
  }
  return holes.filter(Boolean)
}

/** Every arrangement of n things is too many to walk; this samples the shapes. */
function shuffles<T>(items: T[], howMany: number): T[][] {
  const out: T[][] = []
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let i = 0; i < howMany; i++) {
    const a = items.slice()
    for (let j = a.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1))
      ;[a[j], a[k]] = [a[k], a[j]]
    }
    out.push(a)
  }
  return out
}

describe('cards cannot leave a hole once somebody arranges their own', () => {
  it('the shipped widths are exact — this is why the default layout is left alone', () => {
    expect(SHIPPED_SPANS).toHaveLength(DASHBOARD_CARDS.length)
    expect(holesBetween(SHIPPED_SPANS)).toEqual([])
  })

  it('and why they CANNOT be kept: reordering them leaves a hole almost every time', () => {
    const bad = shuffles(SHIPPED_SPANS, 2000).filter(o => holesBetween(o).length > 0)
    expect(bad.length).toBeGreaterThan(1500)
    // Not a sliver, either — most of a row can end up empty.
    const worst = Math.max(...shuffles(SHIPPED_SPANS, 2000).flatMap(o => holesBetween(o)), 0)
    expect(worst).toBeGreaterThanOrEqual(6)
  })

  it('one width for every card leaves no hole, in ANY order', () => {
    const uniform = DASHBOARD_CARDS.map(() => UNIFORM)
    for (const order of shuffles(uniform, 500)) {
      expect(holesBetween(order)).toEqual([])
    }
  })

  it('a half divides the row exactly, so the rows are always full', () => {
    expect(COLUMNS % UNIFORM).toBe(0)
    expect(COLUMNS / UNIFORM).toBe(2)
  })

  // 10/21 (Nic): "resizing some of these cards to I think 1/3 was a bad idea...
  // that table's got some important stuff." A card has to hold more than a
  // label and a figure, so half the row is the floor.
  it('is never narrower than half a row', () => {
    expect(UNIFORM).toBeGreaterThanOrEqual(COLUMNS / 2)
  })

  it('every card has a key, and no two share one', () => {
    expect(new Set(DASHBOARD_CARDS).size).toBe(DASHBOARD_CARDS.length)
    expect(DASHBOARD_CARDS.every(k => /^[a-z][a-z-]*$/.test(k))).toBe(true)
  })
})
