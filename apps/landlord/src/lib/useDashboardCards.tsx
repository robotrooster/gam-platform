import { useState } from 'react'
import { useUiLayout, applyOrder, moved } from './useUiLayout'

/**
 * 10/21 (Nic) — "rearranging the dashboard widgets."
 *
 * The dashboard's cards are hand-written grid items, each one a different
 * shape with its own figures and its own click. Turning them into a list of
 * components to sort would have meant rewriting the whole page — and a page
 * about money is not one to rewrite for a drag handle.
 *
 * So nothing about the cards moves. CSS grid already lets an item say where it
 * goes with `order`, so each card keeps its own markup exactly and gains two
 * things: a number saying where it sits, and the handlers to drag it. The page
 * reads the same whether somebody has arranged it or not.
 *
 * The keys below are the cards in the order they ship. A card added later just
 * joins the end of this list; somebody's saved arrangement does not need to
 * know about it (applyOrder leaves unknown-to-it cards where they were), and a
 * card retired later disappears from both without stranding anything.
 */
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
] as const

export type DashboardCardKey = typeof DASHBOARD_CARDS[number]

export function useDashboardCards() {
  const layout = useUiLayout('landlord_dashboard')
  const [from, setFrom] = useState<DashboardCardKey | null>(null)
  const [over, setOver] = useState<DashboardCardKey | null>(null)

  const arranged = applyOrder([...DASHBOARD_CARDS], layout.order, k => k) as DashboardCardKey[]
  const rankOf = (key: DashboardCardKey) => {
    const i = arranged.indexOf(key)
    return i < 0 ? DASHBOARD_CARDS.length : i
  }

  /**
   * Everything a card needs, spread onto its existing div.
   *
   * 10/21 (Nic): "I'm wondering if we have a collision on size... if I put
   * something that takes up half the width of the screen and then something
   * else that takes up like a third, there's going to be a little leftover
   * space at the end."
   *
   * He was right, and it was worse than it sounds. The ten cards ship as
   * thirds, halves and one full-width, and those widths were chosen so the
   * DEFAULT rows add up to twelve exactly. Any other order breaks that: a
   * half cannot squeeze into a third of leftover room, so it drops to the next
   * row and leaves a hole. Simulated over thousands of arrangements, a dragged
   * order leaves a hole in about nine of every ten, and the worst leaves three
   * quarters of a row empty. (They can never OVERLAP — a grid will not stack
   * two cards on each other — so the damage was only ever ugly, not broken.)
   *
   * Letting the grid backfill (`grid-auto-flow: dense`) was no good either: it
   * still left holes in nine of ten, and it fills them by pulling a later card
   * forward, so a card lands somewhere other than where it was dropped. A
   * dashboard that moves things you did not move is worse than a gap.
   *
   * So: arrange it yourself and every card becomes the same width. Half the
   * row, two to a row, no holes between them ever, and the order on screen is
   * exactly the order dragged. Until somebody drags anything, the designed
   * layout is untouched.
   *
   * 10/21 (Nic), on the first try at this, which made them thirds:
   *
   *   "resizing some of these cards to I think 1/3 was a bad idea. We should
   *    do it to 1/2. Because like the property health bar, if I drag that to
   *    the very top and it shrinks to a 1/3, it's going to compress a lot of
   *    that information and that table's got some important stuff."
   *
   * A half divides the twelve-column row exactly, the same as a third did, so
   * it costs nothing in tidiness and leaves room for a card that is more than
   * a label and a figure.
   */
  const bind = (key: DashboardCardKey, gridColumn: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setFrom(key); e.dataTransfer.effectAllowed = 'move' },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(key) },
    onDragLeave: () => setOver(o => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()   // a card's own click must not fire from a drop
      if (from && from !== key) {
        layout.save(moved(arranged, arranged.indexOf(from), arranged.indexOf(key)))
      }
      setFrom(null); setOver(null)
    },
    onDragEnd: () => { setFrom(null); setOver(null) },
    style: {
      gridColumn: layout.customized ? 'span 6' : gridColumn,
      cursor: 'pointer',
      order: rankOf(key),
      opacity: from === key ? 0.4 : undefined,
      outline: over === key && from && from !== key ? '2px solid var(--gold)' : undefined,
    } as React.CSSProperties,
  })

  return { bind, customized: layout.customized, reset: layout.reset, ready: layout.ready }
}
