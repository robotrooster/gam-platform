/**
 * S654 (Nic): "when it reloads, it doesn't keep people on the same page they
 * were on… if I was on the units or the history within the master schedule
 * and it reloaded, it would push me back out to the default tab."
 *
 * A page's sub-tab lived in component state, so a reload — the version banner,
 * a refresh, a bookmark — always landed on the first tab. The chosen tab now
 * rides the address (?tab=history) the way the property page has done since
 * S5xx (PropertyDetailPage.goTab), so the page comes back where it was.
 *
 * replaceState, not pushState: switching tabs is not a navigation the back
 * button should unwind one click at a time. The default tab writes no
 * parameter, so plain links stay plain. A value that is not one of the
 * allowed tabs falls back to the default rather than rendering nothing.
 */
import { useCallback, useState } from 'react'

export function useUrlTab<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
): [T, (t: T) => void] {
  const [tab, setTabState] = useState<T>(() => {
    const v = new URLSearchParams(window.location.search).get(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : initial
  })
  const setTab = useCallback((t: T) => {
    setTabState(t)
    const u = new URL(window.location.href)
    if (t === initial) u.searchParams.delete(key)
    else u.searchParams.set(key, t)
    window.history.replaceState(window.history.state, '', u)
  }, [key, initial])
  return [tab, setTab]
}
