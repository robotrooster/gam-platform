// Oldest-first payment allocation. Pure function — no DB access.
// Consumers fetch payments rows, call this, then apply the returned plan.

export interface AllocatablePayment {
  id: string
  amount: number        // original charge
  amount_paid?: number  // already applied from prior partial payments (default 0)
  due_date: string      // ISO date, used for oldest-first sort
  /** S609: charge kind. Only used to keep a propane fill from being paid
   *  BEFORE the rent it is older than — see DEPRIORITIZED below. */
  type?: string
  /** S609: propane marker, since a fill is billed as type 'utility'. */
  entry_description?: string | null
  /** S655: creation time, the tie-break after due date and charge type. Pass
   *  it (payments.created_at): a row without it sorts after every row that has
   *  it, like NULLS LAST in the SQL twin. */
  created_at?: string | Date | null
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
 * A late fee fires on any unpaid line that is not itself a late fee
 * (jobs/lateFees), so protecting the current bill from being crowded out is
 * what actually keeps the clock from starting.
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

/**
 * S655 (money plan §1.4): on the same due date, the order charges are paid in.
 * Kim Harland's rent, water and trash were all due the same day and created in
 * the same second; her $450 move-in special belongs on the rent, and only a
 * fixed type order puts it there every time.
 */
export const ALLOCATION_TYPE_ORDER = ['rent', 'utility', 'late_fee', 'fee', 'home_payment'] as const
const typeRank = (p: AllocatablePayment): number => {
  const i = (ALLOCATION_TYPE_ORDER as readonly string[]).indexOf(p.type ?? '')
  return i === -1 ? ALLOCATION_TYPE_ORDER.length : i
}
const createdMs = (p: AllocatablePayment): number | null => {
  if (p.created_at == null) return null
  const ms = p.created_at instanceof Date ? p.created_at.getTime() : Date.parse(p.created_at)
  return Number.isFinite(ms) ? ms : null
}

/**
 * THE ONE ALLOCATION ORDER (S655, money plan §1.4). Every path that decides
 * which charge money or credit pays first uses this comparator, and the SQL
 * twin in apps/api/src/services/moneyPredicates.ts (allocationOrderSql):
 *
 *   1. bucket: ordinary charges, then propane, then carried balance (S609/S622)
 *   2. due date, oldest first
 *   3. type: rent, utility, late fee, fee, home payment, anything else
 *   4. creation time, oldest first; a row with no creation time after every
 *      row that has one (the SQL's NULLS LAST)
 *   5. id
 *
 * A total order: every pair of distinct rows compares the same way whatever
 * order they arrive in, so a sort never depends on how a query returned them.
 */
export function compareForAllocation(a: AllocatablePayment, b: AllocatablePayment): number {
  const pa = priority(a), pb = priority(b)
  if (pa !== pb) return pa - pb
  const byDue = a.due_date.localeCompare(b.due_date)
  if (byDue !== 0) return byDue
  const ta = typeRank(a), tb = typeRank(b)
  if (ta !== tb) return ta - tb
  const ca = createdMs(a), cb = createdMs(b)
  if (ca !== cb) {
    if (ca === null) return 1
    if (cb === null) return -1
    return ca - cb
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** A sorted copy, in the one allocation order. */
export function sortForAllocation<T extends AllocatablePayment>(rows: readonly T[]): T[] {
  return [...rows].sort(compareForAllocation)
}

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
  // Propane, then carried arrears, sink below everything regardless of age;
  // within a bucket oldest-first, then the S655 type and creation tie-breaks.
  const sorted = sortForAllocation(outstanding)
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
