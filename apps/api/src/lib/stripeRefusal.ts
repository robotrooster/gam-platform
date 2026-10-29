/**
 * 10/12 (Nic, ledger P0 review) — DID STRIPE SAY NO, OR DO WE NOT KNOW?
 *
 * A money call to Stripe that throws has one of two meanings, and treating
 * the second as the first is how a record ends up saying "failed" while the
 * money moved:
 *
 *   - Stripe answered and REFUSED the request: an invalid request (a bad
 *     destination, an amount it will not move), a permission it does not
 *     grant, or a declined payment method. Nothing was made. Safe to mark the
 *     record failed and say so.
 *   - The answer is UNKNOWN: a dropped connection or timeout, Stripe's own
 *     error (5xx), a rate limit, the 409 Stripe returns to a second caller
 *     while the first request under the same idempotency key is still in
 *     flight, or an error of unknown origin. Stripe may well have made it.
 *     The record must stay open, so the same key can be asked again (Stripe
 *     returns what it made, or makes it once) — never marked failed.
 *
 * Used by every writer that records a Stripe money movement before asking for
 * it (services/landlordPassthrough sendDirectTransfer, services/landlordGamDebit).
 */
export function isDefiniteStripeRefusal(e: unknown): boolean {
  const err = e as { type?: unknown; rawType?: unknown; statusCode?: unknown; raw?: { statusCode?: unknown } } | null
  const status = Number(err?.statusCode ?? err?.raw?.statusCode)
  // A conflict (the same key in flight) or Stripe's own failure: not an answer.
  if (status === 409 || status === 429 || status >= 500) return false
  const type = String(err?.type ?? '')
  const raw = String(err?.rawType ?? '')
  return type === 'StripeInvalidRequestError' || type === 'StripePermissionError' || type === 'StripeCardError'
    || raw === 'invalid_request_error' || raw === 'card_error'
}
