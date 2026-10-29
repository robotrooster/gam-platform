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
 *
 * 10/19 (review): `always` exists for a page that OPENS somewhere other than
 * the tab it was left on. The Bank page sends a landlord with unfinished setup
 * to Bank setup, and defers to an explicit ?tab= as "they asked for this one" —
 * but dropping the parameter for the default tab erased exactly that evidence,
 * so picking Bank feed and refreshing threw them back to Bank setup. With
 * `always` the chosen tab is in the address whichever one it is.
 */
import { useCallback, useState } from 'react'

export function useUrlTab<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
  opts?: { always?: boolean },
): [T, (t: T) => void] {
  const always = !!opts?.always
  const [tab, setTabState] = useState<T>(() => {
    const v = new URLSearchParams(window.location.search).get(key)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : initial
  })
  const setTab = useCallback((t: T) => {
    setTabState(t)
    const u = new URL(window.location.href)
    if (t === initial && !always) u.searchParams.delete(key)
    else u.searchParams.set(key, t)
    window.history.replaceState(window.history.state, '', u)
  }, [key, initial, always])
  return [tab, setTab]
}
