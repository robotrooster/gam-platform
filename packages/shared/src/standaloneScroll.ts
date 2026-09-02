/**
 * S633 — the scroll lock on a signing page opened outside the app shell.
 *
 * Nic: "Other tenant on mobile is having the same issue that you previously
 * fixed for me... so why the fuck did you fix it only for my phone? Whatever you
 * did was just a one off fix instead of fixing it the right way."
 *
 * He is right. This was fixed in apps/landlord's SignPage in S629 and nowhere
 * else, while apps/tenant has its own SignPage with the identical bug — the
 * tenant a lease is actually sent to could not scroll far enough to confirm a
 * signature font. Fixing the file in front of me instead of asking where else
 * that page exists is what produced a one-off.
 *
 * THE BUG. Both portals lock the document deliberately, because the app shell is
 * the scrolling region:
 *   landlord   .page-content   (Layout)
 *   tenant     .shell          { height:100vh; overflow:hidden }
 * plus `body { height:100%; overflow:hidden }` in the tenant's global CSS.
 *
 * A signing page reached from an emailed link renders OUTSIDE that shell. It
 * inherits a body that cannot scroll and provides no scrolling ancestor of its
 * own, so anything below the fold is unreachable. Desktop hides it — everything
 * fits — so it only ever appears on a phone.
 *
 * This lives in shared so the next portal that grows a public page inherits the
 * answer instead of the bug. Plain DOM rather than a React hook, so shared does
 * not take a React dependency for it.
 */

/** Every marker that means "this page is inside an app shell that scrolls". */
export const APP_SHELL_SELECTORS = ['.page-content', '.shell'] as const

/**
 * Is this page rendering inside a portal shell?
 *
 * Asked of the DOM rather than inferred from the URL. S629 inferred it from the
 * address — unlocking only when the link carried a signer token — so a reminder
 * email built the link a different way and stayed locked. Every entry path gets
 * the same answer this way.
 */
export function isInsideAppShell(doc?: any): boolean {
  const d = doc ?? (typeof document !== 'undefined' ? document : null)
  if (!d) return true          // no DOM (SSR/test): change nothing
  return APP_SHELL_SELECTORS.some(sel => !!d.querySelector(sel))
}

/**
 * Let the document scroll, and return the undo.
 *
 * Restores the exact previous values rather than clearing them, so a page that
 * mounts inside the shell by some other route leaves the portal's own scrolling
 * untouched on the way out.
 */
export function unlockDocumentScroll(doc?: any): () => void {
  const d = doc ?? (typeof document !== 'undefined' ? document : null)
  if (!d?.body) return () => {}
  const b = d.body.style
  const prev = { overflow: b.overflow, height: b.height, overscrollBehavior: b.overscrollBehavior }
  b.overflow = 'auto'
  b.height = 'auto'
  b.overscrollBehavior = 'auto'
  return () => {
    b.overflow = prev.overflow
    b.height = prev.height
    b.overscrollBehavior = prev.overscrollBehavior
  }
}

/** The whole thing: unlock when standalone, no-op inside the shell. */
export function unlockScrollIfStandalone(doc?: any): () => void {
  if (isInsideAppShell(doc)) return () => {}
  return unlockDocumentScroll(doc)
}
