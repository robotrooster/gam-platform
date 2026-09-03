/**
 * S600 — no-double-bill onboarding grace: landlord billing activation.
 *
 * A new landlord isn't charged the per-occupied-unit platform fee until they GO
 * LIVE. (The other end of the grace, the cap for landlords who never take a
 * rent payment, is handled by applyBillingGraceCaps in
 * jobs/platformFeeAccrual.ts.)
 *
 * ── S637 (Nic, DIRECTIVE): OCCUPANCY IS WHAT GOES LIVE ─────────────────
 *
 * "You need to count manual logged transactions as well. It's not only money
 * flowing through the system. It's money logged in the system. It's a
 * combination of active leases on a spot... Doesn't matter if they pay rent to
 * the landlord or not. When they are in the system as an occupied spot, we are
 * billing the landlord for that occupancy."
 *
 * "Live" used to mean the first rent settled THROUGH STRIPE, because
 * activateBillingForSettledRent was called from exactly one place: the Stripe
 * webhook. A landlord collecting cash never triggered it, so Oak Park — three
 * signed leases, Russ Fuller's rent settled in cash — sat in grace with
 * billing_starts_at NULL and would never have been billed at all.
 *
 * Paying by cash is not a lesser tenancy. The fee is for an occupied spot, so
 * activation now follows OCCUPANCY: the arrears accrual activates any landlord
 * still in grace who actually had billable units in the month that just
 * closed (activateBillingForOccupancy). The settled-rent path below is kept
 * because it fires EARLIER — mid-month, the moment money moves — and it now
 * runs for manual payments too.
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


/**
 * S637: end the grace for a landlord who HAD OCCUPANCY in a closed month.
 *
 * Called by the arrears accrual before its per-property gate, so the month
 * being billed is the month that proves they went live. Sets
 * billing_starts_at to that month, which is exactly the month about to be
 * accrued — so the first bill covers the first month they actually had
 * somebody in a spot, and nothing earlier.
 *
 * Idempotent: only touches landlords still in grace.
 */
export async function activateBillingForOccupancy(
  client: PoolClient,
  monthIso: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE landlords l
        SET billing_starts_at = $1::date, updated_at = now()
      WHERE l.billing_starts_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM leases le
            JOIN units u ON u.id = le.unit_id
           WHERE u.landlord_id = l.id
             AND le.status = 'active'
             AND le.start_date <= ($1::date + INTERVAL '1 month' - INTERVAL '1 day')
             AND (le.end_date IS NULL OR le.end_date >= $1::date))`,
    [monthIso],
  )
  return res.rowCount ?? 0
}
