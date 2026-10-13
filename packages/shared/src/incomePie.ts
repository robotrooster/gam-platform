/**
 * 10/13 (Nic, full purchase) — the admin income pies, worked out here so they
 * can be tested (the admin portal draws what these return).
 *
 * "Book the $331.73 as an expense the day we buy it, and each $87.50 payment
 * as paying it back (lowers 'earned all time' until repaid)." A card reader
 * GAM bought is a slice BELOW zero ("Card Readers Bought"), and a ring cannot
 * draw one. So:
 *   - the ring is drawn from the slices above zero, each against their own
 *     total. Against the net (what the window comes to) the arcs ran past the
 *     circle: production's all-time pie has $635.40 of slices above zero on a
 *     $303.67 net once Mountain View's reader is in GAM's book.
 *   - a slice below zero is named under its pie ("incl. … −$X"), and is never
 *     a color in the legend. S652: a name in the legend with no slice on the
 *     ring is the page disagreeing with itself.
 *   - a share (%) is of what came in, the slices above zero. A slice below
 *     zero has none.
 */

export interface IncomeSlice { key: string; label: string; amount: number; recurring?: boolean }
/** One arc of a ring: its length and where it starts, in the units of the circumference given. */
export interface IncomeArc { key: string; len: number; off: number }

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100)

/**
 * One pie's ring: an arc for each slice above zero, against their own total
 * (`inTotal`, dollars); the slices below zero (`below`), to be named under
 * the pie. A slice at $0.00 is neither.
 */
export function incomeRing(sources: ReadonlyArray<IncomeSlice> | null | undefined, circumference: number): {
  arcs: IncomeArc[]; below: IncomeSlice[]; inTotal: number
} {
  const all = sources ?? []
  const above = all.filter(s => cents(s.amount) > 0)
  const inTotalC = above.reduce((a, s) => a + cents(s.amount), 0)
  let acc = 0
  const arcs = above.map(s => {
    const len = inTotalC > 0 ? (cents(s.amount) / inTotalC) * circumference : 0
    const arc = { key: s.key, len, off: acc }
    acc += len
    return arc
  })
  return { arcs, below: all.filter(s => cents(s.amount) < 0), inTotal: inTotalC / 100 }
}

/**
 * The legend over every pie: one entry per slice drawn on at least one ring
 * (above zero in some window), in the order the windows first name them. A
 * slice that is never above zero is left out; its pies name it under them.
 */
export function incomeLegend(periods: ReadonlyArray<{ sources?: ReadonlyArray<IncomeSlice> | null }> | null | undefined): Array<{ key: string; label: string; recurring: boolean }> {
  const seen = new Map<string, { key: string; label: string; recurring: boolean }>()
  for (const p of periods ?? []) {
    for (const s of p.sources ?? []) {
      if (cents(s.amount) > 0 && !seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, recurring: !!s.recurring })
    }
  }
  return [...seen.values()]
}

/**
 * A slice's share of what came in (the slices above zero), as a percentage.
 * null for a slice at or below zero, or when nothing came in.
 */
export function incomeShare(amount: number, sources: ReadonlyArray<{ amount: number }> | null | undefined): number | null {
  const inC = (sources ?? []).reduce((a, s) => a + Math.max(0, cents(s.amount)), 0)
  const c = cents(amount)
  return c > 0 && inC > 0 ? (c / inC) * 100 : null
}
