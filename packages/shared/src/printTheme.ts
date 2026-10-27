/**
 * 10/26 (Nic) — A PRINTED PAGE IS ALWAYS LIGHT.
 *
 *   "We tried to print out the summary of the page and it printed the whole
 *    page black with just some white text because it was on dark mode. Pages
 *    should always print regular, no matter what the layout or theme of the
 *    screen happens to look like. That wasted so much ink on a brand new
 *    cartridge."
 *
 * He hit this printing a balance summary for two evictions at Oak Park.
 *
 * Every portal already ships a complete light palette under
 * `:root[data-theme="light"]`, including the per-component overrides (gold as
 * text becomes --gold-ink, alert copy flips to dark-on-tint, and so on). So
 * rather than restate that palette inside an `@media print` block — which
 * would drift the moment the light theme changes — this flips the document to
 * the light theme for the duration of the print and puts the viewer's own
 * choice back afterwards. Every light rule then applies, with nothing
 * duplicated.
 *
 * `beforeprint` covers Ctrl/Cmd-P, the browser's Print menu and Save-as-PDF.
 * The matchMedia('print') listener is the fallback for engines that fire that
 * instead. Both paths are idempotent, and the restore only ever writes back
 * what was there before the first one fired, so the two cannot fight.
 *
 * A CSS backstop lives beside this in each portal's stylesheet, forcing a
 * white page and dark body text, for the case where this script never ran
 * (a print triggered before hydration, or JS disabled). Belt and braces: the
 * failure being guarded is a wasted ink cartridge, not a cosmetic one.
 */

const ATTR = 'data-theme'
/** What the viewer had before printing: a theme name, or null for the default. */
let restoreTo: string | null = null
let printing = false

function toLight(): void {
  if (printing) return
  printing = true
  const root = document.documentElement
  restoreTo = root.getAttribute(ATTR)
  if (restoreTo !== 'light') root.setAttribute(ATTR, 'light')
}

function restore(): void {
  if (!printing) return
  printing = false
  const root = document.documentElement
  if (restoreTo === null) root.removeAttribute(ATTR)
  else root.setAttribute(ATTR, restoreTo)
  restoreTo = null
}

/**
 * Make printing use the light theme in this document. Safe to call more than
 * once (the second call does nothing) and safe where there is no DOM.
 * Returns a teardown for tests; app code calls it once at startup.
 */
export function installPrintLightTheme(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const w = window as Window & { __gamPrintLightTheme?: boolean }
  if (w.__gamPrintLightTheme) return () => {}
  w.__gamPrintLightTheme = true

  window.addEventListener('beforeprint', toLight)
  window.addEventListener('afterprint', restore)

  // Fallback for engines that report the print medium instead of firing the
  // events. matchMedia is absent in some test environments.
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null
  const onMedia = (e: MediaQueryListEvent | MediaQueryList) => { e.matches ? toLight() : restore() }
  if (mql?.addEventListener) mql.addEventListener('change', onMedia as (e: MediaQueryListEvent) => void)

  return () => {
    window.removeEventListener('beforeprint', toLight)
    window.removeEventListener('afterprint', restore)
    if (mql?.removeEventListener) mql.removeEventListener('change', onMedia as (e: MediaQueryListEvent) => void)
    restore()
    w.__gamPrintLightTheme = false
  }
}

/** Test seam: whether a print is currently in progress. */
export function printLightThemeActive(): boolean { return printing }
