// Oldest-first payment allocation. Pure function — no DB access.
// Consumers fetch payments rows, call this, then apply the returned plan.

export interface AllocatablePayment {
  id: string
  amount: number        // original charge
  amount_paid?: number  // already applied from prior partial payments (default 0)
  due_date: string      // ISO date, used for oldest-first sort
  /** S609: charge kind. Only used to keep a propane fill from being paid
   *  BEFORE the rent it is older than — see DEPRIORITISED below. */
  type?: string
  /** S609: propane marker, since a fill is billed as type 'utility'. */
  entry_description?: string | null
}

/**
 * S609 (Nic): PROPANE IS PAID LAST, whatever its date.
 *
 *   "We also need to let it sit outside of the first in, first out charges on
 *    the ledger, because if it doesn't sit outside of that... it's gonna apply
 *    the payment to the oldest charge, which would supersede the rent, which
 *    would still end up letting the tenant acquire late fees if the tenant can't
 *    pay the whole thing."
 *
 * Exactly right, and it is the difference between a late fee and no late fee. A
 * tank filled on the 20th is OLDER than rent due the 1st of next month, so pure
 * oldest-first hands the tenant's money to the propane and leaves the rent
 * short. Rent short means a late fee and an eviction clock — over a propane
 * bill.
 *
 * Late fees are computed on RENT alone (jobs/lateFees), so protecting rent from
 * being crowded out is what actually keeps the clock from starting.
 *
 * Within each group the ordinary oldest-first rule still applies; this only says
 * which group gets paid first.
 */
const isPropane = (p: AllocatablePayment): boolean =>
  (p.entry_description ?? '').toUpperCase() === 'PROPANE'

/**
 * S622 (Nic): A CARRIED-FORWARD BALANCE IS PAID LAST, and it is the only charge
 * a tenant may pay PARTIALLY.
 *
 *   "If they are behind a thousand dollars and we're carrying forward, they need
 *    to be paying on the new lease and making payments towards the outstanding
 *    balance. Outstanding balance that is carried forward should be exempt from
 *    first in, first out, and that balance should allow partial payments. The
 *    invoiced portion of the lease shouldn't allow partial payments."
 *
 * Arrears imported from a landlord's old system are, by definition, the OLDEST
 * charge on the ledger — so pure oldest-first hands every dollar of rent to the
 * old debt and leaves the new lease short. The tenant then carries a late fee
 * and an eviction clock on a lease they have been paying in full, and can never
 * get current no matter what they pay. The debt is real and the tenant still
 * owes it; it simply must not stand in front of the rent.
 *
 * Same reasoning as propane above, and a harder case: propane is one tank, this
 * is a thousand dollars that would swallow rent for months. Paid after propane
 * too — a fill is a current bill that would otherwise age into the same trap,
 * whereas arrears are already on a catch-up footing.
 */
export const isCarriedBalance = (p: AllocatablePayment): boolean =>
  p.type === 'carried_balance'

/** Sort bucket: ordinary charges, then propane, then carried arrears. */
const priority = (p: AllocatablePayment): number =>
  isCarriedBalance(p) ? 2 : isPropane(p) ? 1 : 0

export interface AllocationLine {
  payment_id: string
  amount_applied: number
}

export interface AllocationResult {
  lines: AllocationLine[]
  unapplied: number  // leftover if incoming amount exceeds total outstanding
}

/**
 * Allocate an incoming payment amount across outstanding charges, oldest first.
 * Partial allocation supported — the last consumed row may be partially paid.
 * All math done in cents to avoid float drift; returns numbers in dollars.
 */
export function allocateOldestFirst(
  outstanding: AllocatablePayment[],
  incomingAmount: number
): AllocationResult {
  const sorted = [...outstanding].sort((a, b) => {
    // Propane, then carried arrears, sink below everything regardless of age;
    // within a bucket the long-standing oldest-first order still applies.
    const pa = priority(a), pb = priority(b)
    if (pa !== pb) return pa - pb
    return a.due_date.localeCompare(b.due_date)
  })
  let remainingCents = Math.round(incomingAmount * 100)
  const lines: AllocationLine[] = []

  for (const p of sorted) {
    if (remainingCents <= 0) break
    const chargeCents = Math.round(p.amount * 100)
    const paidCents = Math.round((p.amount_paid ?? 0) * 100)
    const outstandingCents = chargeCents - paidCents
    if (outstandingCents <= 0) continue
    const applyCents = Math.min(outstandingCents, remainingCents)
    lines.push({ payment_id: p.id, amount_applied: applyCents / 100 })
    remainingCents -= applyCents
  }

  return { lines, unapplied: remainingCents / 100 }
}
