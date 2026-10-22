import { useState } from 'react'
import { useUiLayout } from './useUiLayout'

/**
 * 10/22 (Nic) — THE SLOTS ARE FIXED; THE CARDS MOVE BETWEEN THEM.
 *
 *   "I'm wondering if we have a collision on size... if I put something that
 *    takes up half the width of the screen and then something else that takes
 *    up like a third, there's going to be a little leftover space at the end."
 *
 *   "I'm wondering if we should have those sizes of slots locked. And if I drag
 *    something from a one size slot to another size, it's moved to that view.
 *    Like there are places to fill with items that the size of the place is
 *    locked, as opposed to making everything half and half after you move just
 *    one single item."
 *
 * His idea, and it is better than what shipped 10/21. That first attempt made
 * every card half-width the moment anything moved, which was the only way to
 * guarantee no gaps when the cards themselves carried their widths — and it
 * flattened a dashboard that had a deliberate shape.
 *
 * Fixed slots solve it properly. The page is a pyramid of THIRTEEN places —
 * three across, then four, then two, then one full width, then a band
 * underneath for the three big panels. A card takes the size of the place it
 * lands in. The places never change, so the rows always add up and there is
 * nothing to collide with.
 *
 * DROPPING SWAPS, it does not insert. With places of different sizes, sliding
 * everything along would resize every card between here and there — you move
 * one thing and the whole page rearranges. Swapping changes exactly two.
 */
export interface DashboardSlot {
  /** The grid span this place occupies. Never changes. */
  span: string
  /** Roughly how tall what sits here is expected to be, for the empty-row feel. */
  band: 'kpi' | 'panel'
}

/**
 * The shape of the page, in reading order. Row 1 is the money trio across the
 * top; row 2 the four small counts; row 3 the two halves; row 4 the full-width
 * platform fee; then the big band for the panels that hold tables and charts.
 */
export const DASHBOARD_SLOTS: DashboardSlot[] = [
  { span: 'span 4',  band: 'kpi' }, { span: 'span 4',  band: 'kpi' }, { span: 'span 4', band: 'kpi' },
  { span: 'span 3',  band: 'kpi' }, { span: 'span 3',  band: 'kpi' },
  { span: 'span 3',  band: 'kpi' }, { span: 'span 3',  band: 'kpi' },
  { span: 'span 6',  band: 'kpi' }, { span: 'span 6',  band: 'kpi' },
  { span: 'span 12', band: 'kpi' },
  // 10/22 (Nic): "it's not letting me drag the property health card or the
  // recent disbursements card... it should be able to be anything on the page.
  // I could drag my to-do list to the top as well if I wanted."
  { span: 'span 6',  band: 'panel' }, { span: 'span 6', band: 'panel' },
  { span: 'span 12', band: 'panel' },
]

/** Which card sits in which place when nobody has moved anything. */
export const DASHBOARD_CARDS = [
  'expected-rent',
  'money-this-month',
  'outstanding',
  'occupancy-rate',
  'occupied-units',
  'leases-expiring',
  'maintenance',
  'applications',
  'disbursements',
  'platform-fee',
  'property-health',
  'recent-disbursements',
  'todo',
] as const

export type DashboardCardKey = typeof DASHBOARD_CARDS[number]

/**
 * The saved arrangement, made safe: anything the save does not know about keeps
 * its own place, anything it names that no longer exists is dropped, and the
 * result is always exactly as long as there are places.
 *
 * So a card added next month appears in the first free place instead of
 * vanishing, and a card retired last month does not leave a hole.
 */
export function arrange(saved: string[], all: readonly string[] = DASHBOARD_CARDS): string[] {
  const known = new Set(all)
  const seen = new Set<string>()
  const placed: string[] = []
  for (const k of saved) {
    // Each card holds exactly one place. A save naming the same card twice
    // (a half-written write, an old shape) would otherwise eat a place and
    // leave the board a card short.
    if (known.has(k) && !seen.has(k)) { seen.add(k); placed.push(k) }
  }
  return [...placed, ...all.filter(k => !seen.has(k))].slice(0, all.length)
}

/** Swap two cards between their places. Nothing else on the page moves. */
export function swap(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0 || i === j) return order
  const next = order.slice()
  next[i] = b
  next[j] = a
  return next
}

export function useDashboardCards() {
  const layout = useUiLayout('landlord_dashboard')
  const [from, setFrom] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // 10/22 (Nic): "if I click and hold, I want it to show that they can edit."
  // Shown on the press, before any movement.
  const [pressed, setPressed] = useState<string | null>(null)

  const order = arrange(layout.order)
  const slotOf = (key: string) => {
    const i = order.indexOf(key)
    return i < 0 ? DASHBOARD_SLOTS.length - 1 : i
  }

  /**
   * Everything a card needs, spread onto its own element. The card no longer
   * says how wide it is — the place it is sitting in does.
   */
  const bind = (key: DashboardCardKey) => {
    const slot = slotOf(key)
    const place = DASHBOARD_SLOTS[slot] ?? DASHBOARD_SLOTS[DASHBOARD_SLOTS.length - 1]
    const isTarget = over === key && !!from && from !== key
    return {
      draggable: true,
      onMouseDown: () => setPressed(key),
      onMouseUp: () => setPressed(null),
      onMouseLeave: () => setPressed(p => (p === key ? null : p)),
      onDragStart: (e: React.DragEvent) => { setFrom(key); e.dataTransfer.effectAllowed = 'move' },
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(key) },
      onDragLeave: () => setOver(o => (o === key ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()   // a card's own click must not fire from a drop
        if (from && from !== key) layout.save(swap(order, from, key))
        setFrom(null); setOver(null); setPressed(null)
      },
      onDragEnd: () => { setFrom(null); setOver(null); setPressed(null) },
      style: {
        gridColumn: place.span,
        order: slot,
        cursor: from === key ? 'grabbing' : 'grab',
        // The place lights up before you let go, so the size it will become is
        // visible while the card is still in the air.
        outline: isTarget ? '2px solid var(--gold)' : undefined,
        outlineOffset: isTarget ? 2 : undefined,
        opacity: from === key ? 0.4 : undefined,
        transform: pressed === key && !from ? 'scale(0.99)' : undefined,
        transition: 'transform .08s',
      } as React.CSSProperties,
    }
  }

  return { bind, customized: layout.customized, reset: layout.reset, ready: layout.ready }
}
