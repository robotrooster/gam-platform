/**
 * S605 — stale-shell self-heal.
 *
 * WHY THIS EXISTS
 * Nic could not sign in to the real Oak Park landlord account. The page showed
 * the login form, but submitting it produced NO request at the API at all —
 * nothing in the log. A hard refresh (⌘⇧R) fixed it instantly and he signed in
 * first try. His words: "We can't be locking landlords out of their access, or
 * that's gonna turn over customers way fast."
 *
 * We never proved the exact cause of that dead page — old asset bundles still
 * resolve (checked), there is no service worker (checked), and CORS passes
 * (checked). What we know for certain is the SHAPE of the failure: a page that
 * has stopped talking to the server, curable only by a manual hard refresh that
 * no real landlord would ever think to perform.
 *
 * So this fixes the class rather than one cause. There was no periodic refresh
 * of any kind before this — TelemetryPing only fires on route change, and the
 * only window.location.reload() calls in the codebase are manual buttons inside
 * error boundaries.
 *
 * HOW IT WORKS
 * index.html is served with `max-age=0, must-revalidate`, so re-fetching it
 * with `cache: 'no-store'` always gives the CURRENTLY DEPLOYED shell. The
 * hashed module-script filename inside it (`/assets/index-<hash>.js`) is a
 * perfect build fingerprint, with no build-config change required — nothing to
 * keep in sync, nothing to forget to bump.
 *
 * WHEN IT ACTS — and the deliberate asymmetry:
 *
 *   • bfcache restore (`pageshow` with `persisted`) → RELOAD IMMEDIATELY.
 *     This is the Safari back/forward-cache path, the closest match to what
 *     locked Nic out. A restored page can hold dead sockets and stale closures;
 *     it is not a page worth preserving, and nobody is mid-typing on a page
 *     that was just restored.
 *
 *   • interval / tab refocus → NOTIFY, never yank.
 *     A landlord mid-way through adding 19 units must not have the page pulled
 *     from under them. The caller renders its own banner and the human chooses.
 *
 * Reload loops are impossible: each auto-reload records the version it reloaded
 * FOR in sessionStorage, so a given build can only ever trigger one automatic
 * reload per tab.
 */

const SEEN_KEY = 'gam_reloaded_for_build'

export interface VersionWatchOptions {
  /** How often to poll for a newer deployed build. Default 5 minutes. */
  intervalMs?: number
  /** Called when a newer build is live and the user should be offered a reload. */
  onUpdateAvailable?: () => void
}

/** The build fingerprint of the shell THIS page is running. */
function currentBuildId(): string | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null
  const src = el?.getAttribute('src') || ''
  return src.match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
}

/** The build fingerprint currently DEPLOYED, read fresh past every cache. */
async function deployedBuildId(): Promise<string | null> {
  try {
    // Cache-busting query on top of no-store: Safari has been observed serving
    // a restored/stale shell even with must-revalidate, which is the whole
    // reason this module exists — don't trust the cache headers alone.
    const res = await fetch(`/index.html?v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const html = await res.text()
    return html.match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
  } catch {
    // Offline or the deploy host is unreachable — say nothing. A failed check
    // must never reload the page or nag; the user may simply be on a bad
    // connection, and a reload would lose their work for no reason.
    return null
  }
}

/**
 * Start watching. Returns a cleanup function.
 * Safe to call in a browser only; no-ops server-side.
 */
export function startVersionWatch(opts: VersionWatchOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const intervalMs = opts.intervalMs ?? 5 * 60_000
  const mine = currentBuildId()
  // No fingerprint (dev server, no hashed bundle) → nothing meaningful to compare.
  if (!mine) return () => {}

  let stopped = false

  const reloadOnce = (reason: string) => {
    try {
      // One automatic reload per build, per tab — never a loop.
      if (sessionStorage.getItem(SEEN_KEY) === mine) return
      sessionStorage.setItem(SEEN_KEY, mine)
    } catch { /* private mode — proceed; the guard is best-effort */ }
    console.info(`[version-watch] reloading (${reason})`)
    window.location.reload()
  }

  const check = async ({ autoReload, reason }: { autoReload: boolean; reason: string }) => {
    if (stopped) return
    const live = await deployedBuildId()
    if (!live || live === mine) return
    if (autoReload) reloadOnce(reason)
    else opts.onUpdateAvailable?.()
  }

  // 1. Restored from bfcache → the dead-page case. Reload without asking.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) void check({ autoReload: true, reason: 'bfcache restore' })
  }
  // 2. Tab refocused after a while → offer, don't force.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void check({ autoReload: false, reason: 'refocus' })
  }

  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisibility)
  const timer = window.setInterval(() => void check({ autoReload: false, reason: 'interval' }), intervalMs)

  return () => {
    stopped = true
    window.clearInterval(timer)
    window.removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
