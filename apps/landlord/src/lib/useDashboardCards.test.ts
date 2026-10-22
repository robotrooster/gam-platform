/**
 * 10/22 (Nic) — FIXED PLACES, MOVING CARDS.
 *
 *   "I'm wondering if we should have those sizes of slots locked. And if I drag
 *    something from a one size slot to another size, it's moved to that view.
 *    Like there are places to fill with items that the size of the place is
 *    locked, as opposed to making everything half and half after you move just
 *    one single item."
 *
 * The first attempt (10/21) let the cards carry their own widths and made them
 * all half-width the moment anything moved — the only way to avoid gaps, and it
 * flattened a page that had a deliberate shape. Fixed places solve it properly:
 * the rows always add up because the places never change.
 */
import { describe, it, expect } from 'vitest'
import { DASHBOARD_SLOTS, DASHBOARD_CARDS, arrange, swap } from './useDashboardCards'

const COLUMNS = 12
const spanOf = (s: { span: string }) => Number(s.span.replace('span ', ''))

describe('the shape of the page', () => {
  it('has a place for every card and a card for every place', () => {
    expect(DASHBOARD_SLOTS).toHaveLength(DASHBOARD_CARDS.length)
  })

  it('every row adds up to a full twelve — which is why nothing can leave a gap', () => {
    let row = 0
    const rows: number[] = []
    for (const slot of DASHBOARD_SLOTS) {
      const span = spanOf(slot)
      expect(span).toBeGreaterThan(0)
      expect(span).toBeLessThanOrEqual(COLUMNS)
      if (row + span > COLUMNS) { rows.push(row); row = 0 }
      row += span
    }
    rows.push(row)
    // Nic's pyramid: three across, then four, then two, then full width, then
    // the band for the big panels.
    expect(rows).toEqual([12, 12, 12, 12, 12, 12])
  })

  it('keeps the three big panels at half a row or wider — they hold tables and charts', () => {
    const panels = DASHBOARD_SLOTS.filter(s => s.band === 'panel')
    expect(panels).toHaveLength(3)
    for (const p of panels) expect(spanOf(p)).toBeGreaterThanOrEqual(COLUMNS / 2)
  })

  it('names every card once', () => {
    expect(new Set(DASHBOARD_CARDS).size).toBe(DASHBOARD_CARDS.length)
  })
})

describe('a saved arrangement', () => {
  it('with nothing saved, the page is exactly as it ships', () => {
    expect(arrange([])).toEqual([...DASHBOARD_CARDS])
  })

  it('always fills every place, however odd the save is', () => {
    for (const saved of [[], ['todo'], ['nope'], ['todo', 'todo', 'todo'], [...DASHBOARD_CARDS].reverse()]) {
      const out = arrange(saved)
      expect(out).toHaveLength(DASHBOARD_SLOTS.length)
      expect(new Set(out).size).toBe(DASHBOARD_SLOTS.length)
    }
  })

  it('a card that no longer exists is dropped, and one added since takes the first free place', () => {
    const out = arrange(['retired-card', 'todo'])
    expect(out).not.toContain('retired-card')
    expect(out[0]).toBe('todo')
    expect(out).toHaveLength(DASHBOARD_SLOTS.length)
  })
})

describe('dropping a card', () => {
  it('SWAPS the two and moves nothing else — the rest of the page stays put', () => {
    const before = arrange([])
    const after = swap(before, 'todo', 'expected-rent')
    expect(after[0]).toBe('todo')
    expect(after[before.indexOf('todo')]).toBe('expected-rent')
    // Every other card is exactly where it was.
    for (let i = 0; i < before.length; i++) {
      if (i === 0 || i === before.indexOf('todo')) continue
      expect(after[i]).toBe(before[i])
    }
  })

  it('a card dropped on itself, or on something not on the board, changes nothing', () => {
    const before = arrange([])
    expect(swap(before, 'todo', 'todo')).toBe(before)
    expect(swap(before, 'todo', 'not-a-card')).toBe(before)
  })

  it('a card takes the width of the place it lands in — that is the whole idea', () => {
    const before = arrange([])
    // The to-do list ships in the full-width place at the bottom.
    expect(spanOf(DASHBOARD_SLOTS[before.indexOf('todo')])).toBe(12)
    const after = swap(before, 'todo', 'occupancy-rate')
    // Dragged onto a quarter-row place, it becomes a quarter-row card...
    expect(spanOf(DASHBOARD_SLOTS[after.indexOf('todo')])).toBe(3)
    // ...and the card it displaced takes the full width it left behind.
    expect(spanOf(DASHBOARD_SLOTS[after.indexOf('occupancy-rate')])).toBe(12)
  })

  it('no arrangement can ever leave a gap, because the places never move', () => {
    const shuffled = [...DASHBOARD_CARDS].reverse()
    const out = arrange(shuffled)
    // Whatever sits where, the row widths are the same twelve every time.
    expect(out).toHaveLength(DASHBOARD_SLOTS.length)
    let row = 0, rows: number[] = []
    for (const slot of DASHBOARD_SLOTS) {
      const span = spanOf(slot)
      if (row + span > COLUMNS) { rows.push(row); row = 0 }
      row += span
    }
    rows.push(row)
    expect(rows.every(r => r === COLUMNS)).toBe(true)
  })
})
