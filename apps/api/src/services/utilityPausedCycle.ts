/**
 * 10/3 (final sweep) — THE RECORD OF A PAUSED CYCLE.
 *
 * Its own module (not services/utilityBilling) so the read-correction check in
 * services/utilityReview can use it without loading the billing engine — and so
 * a test that stands the engine in with a mock still gets the real record.
 */

/**
 * The note on the $0.00 void bill that writes down a cycle
 * whose lease was paused (hibernating) while the meter did not move. It is the
 * cycle's record that nothing was used — and how a later run (the household
 * back, the lease awake, hibernated_at cleared) knows not to read the same flat
 * meter as broken. Matched together with status 'void', $0, never billed and
 * never paid (PAUSED_CYCLE_MARKER_SQL).
 */
export const PAUSED_CYCLE_NOTE =
  'Not billed: the lease was paused (hibernating) and the meter did not move, so nothing was used.'

/**
 * The paused-cycle record, as a condition on a utility_bills row aliased `ub`.
 * Not an issued bill: nobody was charged, nothing was sent. services/utilityReview
 * (correcting a read) treats it as unissued.
 */
export const PAUSED_CYCLE_MARKER_SQL =
  `(ub.status = 'void' AND ub.charge_amount = 0 AND ub.tax_amount = 0
    AND ub.billed_at IS NULL AND ub.payment_id IS NULL
    AND ub.notes IS NOT DISTINCT FROM '${PAUSED_CYCLE_NOTE.replace(/'/g, "''")}')`
