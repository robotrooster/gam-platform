/**
 * S622: what the editor tells a landlord about the auto-place wait.
 *
 * Nic's call, and it overrides the per-page estimate this started as: "just say
 * this could take a couple of minutes roughly, but shouldn't take more than
 * five minutes. Five minutes is still gonna be faster than placing boxes by
 * hand." A landlord does not act on the difference between 90 and 104 seconds,
 * so quoting it is a distinction that costs attention and buys nothing — and a
 * computed figure invites being wrong in a way a stated ceiling does not.
 *
 * The live progress counter carries the detail ("Analyzing page 4 of 8"), so
 * the copy only has to set the expectation and the ceiling.
 *
 * NOTE the ceiling is a normal-document promise, not a guarantee for every
 * input: placement costs ~13s/page (measured over three real 8-page runs at
 * 102s / 96s / 91s), so a document past roughly 20 pages can exceed five
 * minutes. Those are the runs where the per-page counter earns its keep.
 */

/** Measured placement cost per page. Sizes the client timeout — NOT user copy. */
export const AUTO_PLACE_SECONDS_PER_PAGE = 13

/** The whole message. Deliberately fixed: same words for every document. */
export const AUTO_PLACE_ESTIMATE =
  'usually a couple of minutes, and rarely more than five'

/**
 * Client-side safety cap for the placement poller, in ms. Scales with the
 * document so a long lease is never killed on a timer while it is still
 * making progress — a flat cap once discarded a finished 8-page result.
 * Generous on purpose: this exists to stop an infinite spinner, not to enforce
 * the estimate above.
 */
export function autoPlaceTimeoutMs(pageCount: number | null | undefined): number {
  const pages = Number(pageCount) || 8
  return Math.max(300_000, pages * 60_000 + 60_000)
}
