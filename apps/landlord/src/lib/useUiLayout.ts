import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPut } from './api'

/**
 * 10/21 (Nic) — A SCREEN ARRANGED THE WAY ONE PERSON WORKS.
 *
 *   "Did you ever build my idea for people being able to drag the left
 *    navigation bar into an order of their choosing... I feel like there's a
 *    lot of stuff that I brought up that got skipped, and unless I remember it
 *    again, it just doesn't get built."
 *
 * Saved per person on the server, not in this browser, so the arrangement
 * follows them from the office machine to the tablet at the counter.
 *
 * TWO RULES MAKE IT SAFE TO SAVE A LIST OF KEYS.
 *
 *   An order NEVER decides what somebody may see. `apply` below starts from
 *   the list the screen was going to draw anyway and only reorders it — a
 *   saved key for a page this person cannot open matches nothing and falls out.
 *   Nobody can drag themselves a page they do not have.
 *
 *   A saved order never goes stale. Anything the order does not mention keeps
 *   its own place at the end, so a page added next month appears instead of
 *   vanishing, and a page retired last month is simply not found.
 *
 * Until it has loaded, `ready` is false and screens draw their default order —
 * so nothing jumps around while a request is in flight.
 */
export function useUiLayout(surface: 'landlord_nav' | 'landlord_dashboard') {
  const [order, setOrder] = useState<string[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    apiGet(`/ui-layout/${surface}`)
      .then((r: any) => { if (alive) setOrder(Array.isArray(r?.layout) ? r.layout : []) })
      // A layout that cannot be read is not worth a message: the screen draws
      // the way it always did.
      .catch(() => { if (alive) setOrder([]) })
      .finally(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [surface])

  /** Save a new order (optimistic — the screen has already moved). */
  const save = useCallback((next: string[]) => {
    setOrder(next)
    apiPut(`/ui-layout/${surface}`, { layout: next }).catch(() => { /* it will be re-saved on the next drag */ })
  }, [surface])

  /** Back to how it came. Keeps the row; an empty list IS the default. */
  const reset = useCallback(() => save([]), [save])

  return { order, ready, save, reset, customized: order.length > 0 }
}

/**
 * Put `items` in the saved order: the ones the order names first, in that
 * order, then everything else in the order the screen already had them.
 */
export function applyOrder<T>(items: T[], order: string[], keyOf: (item: T) => string): T[] {
  if (!order.length) return items
  const rank = new Map(order.map((k, i) => [k, i]))
  const named: T[] = []
  const rest: T[] = []
  for (const item of items) (rank.has(keyOf(item)) ? named : rest).push(item)
  named.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
  return [...named, ...rest]
}

/** Move the item at `from` to `to`, as a drag does. */
export function moved<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = items.slice()
  const [one] = next.splice(from, 1)
  next.splice(to, 0, one)
  return next
}
