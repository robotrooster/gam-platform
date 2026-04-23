// Oldest-first payment allocation. Pure function — no DB access.
// Consumers fetch payments rows, call this, then apply the returned plan.

export interface AllocatablePayment {
  id: string
  amount: number        // original charge
  amount_paid?: number  // already applied from prior partial payments (default 0)
  due_date: string      // ISO date, used for oldest-first sort
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
  const sorted = [...outstanding].sort((a, b) => a.due_date.localeCompare(b.due_date))
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
