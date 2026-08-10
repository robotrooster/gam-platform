/**
 * S600 — no-double-bill onboarding grace: landlord billing activation.
 *
 * A new landlord isn't charged the per-occupied-unit platform fee until they GO
 * LIVE. "Live" = the first rent settled through GAM — the moment they operate on
 * GAM, their onboarding grace ends and the fee begins from the current cycle.
 * (The other end of the grace, the cap for landlords who never take a rent
 * payment, is handled by applyBillingGraceCaps in jobs/platformFeeAccrual.ts.)
 *
 * Called from the Stripe settlement path (routes/webhooks.ts) inside the same
 * transaction that flips payments to 'settled'.
 */
import type { PoolClient } from 'pg'

/**
 * Flip billing_starts_at to the current cycle for any landlord still in grace
 * (billing_starts_at IS NULL) who owns one of these settled RENT payments.
 * Idempotent — already-billing landlords are untouched. Returns the number of
 * landlords activated.
 */
export async function activateBillingForSettledRent(
  client: PoolClient,
  rentPaymentIds: string[]
): Promise<number> {
  if (rentPaymentIds.length === 0) return 0
  const res = await client.query(
    `UPDATE landlords
        SET billing_starts_at = date_trunc('month', now())::date, updated_at = now()
      WHERE billing_starts_at IS NULL
        AND id IN (SELECT DISTINCT landlord_id FROM payments
                    WHERE id = ANY($1::uuid[]) AND type = 'rent')`,
    [rentPaymentIds]
  )
  return res.rowCount ?? 0
}
