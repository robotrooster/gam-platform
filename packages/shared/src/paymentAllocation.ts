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

// ─── A part payment, placed (10/5–10/6, Nic) ─────────────────────────────────

/**
 * 10/5 (Nic): the kinds of charge money handed over may leave partly paid.
 * Rent only: its rest row is exempt from the one-rent-row-a-month indexes
 * (payments.is_remainder), and its late fees are based on the month's whole
 * rent however it is split. A late fee or a lease fee cannot be split (their
 * one-row-per-day indexes), a utility bill follows its one payment row, a home
 * payment its one installment, and a security deposit raises its deposit record
 * from the row.
 */
export const PART_PAYABLE_TYPES: readonly string[] = ['rent']

export interface PartPaymentPlacement<T> {
  /** Rows the money pays, each with the cents it pays (in full, or the paid slice of a split row). */
  paid: Array<{ row: T; cents: number }>
  /** Rent rows paid in part: what the money takes, and what the row owed. */
  partSplits: Array<{ row: T; take: number; owedOnRow: number }>
  /** Rows the money does not reach (or passes by): they stay owed whole. */
  notReached: T[]
  /** Cents the money could not place on anything (only when no rent row can take it). */
  left: number
}

function walkPart<T extends { id: string; type: string }>(
  order: readonly T[], owedOn: (r: T) => number, tendered: number,
): PartPaymentPlacement<T> {
  let left = tendered
  const paid: PartPaymentPlacement<T>['paid'] = []
  const partSplits: PartPaymentPlacement<T>['partSplits'] = []
  const notReached: T[] = []
  for (const r of order) {
    const m = owedOn(r)
    if (m <= 0) continue
    if (left >= m) {
      paid.push({ row: r, cents: m })
      left -= m
    } else if (left > 0 && PART_PAYABLE_TYPES.includes(r.type)) {
      paid.push({ row: r, cents: left })
      partSplits.push({ row: r, take: left, owedOnRow: m })
      left = 0
    } else {
      notReached.push(r)
    }
  }
  return { paid, partSplits, notReached, left }
}

/**
 * HOW A PART PAYMENT IS PLACED — the desk settle (apps/api
 * services/manualPaymentSettle) and the Record payment window
 * (apps/landlord lib/creditDesk) both call this, so the window says exactly
 * what the record will do. `rows` are in the one allocation order; `owedOn`
 * is what money owes on each (cents); `tendered` is the money (cents, less
 * than the total owed).
 *
 * Oldest bill first, each line in full. A rent line the money cannot cover in
 * full is paid in PART (the rest stays owed on its own row) and the money
 * stops there. Any other line it cannot cover is passed by and stays owed.
 *
 * 10/6 (Nic, the Bowmans' $500 against $639.60): "why is it talking about
 * credit when they didn't even make a full payment to begin with?" Money that
 * would be left over after passing a line it cannot pay in part — a home
 * payment, a late fee — on the SAME bill as a rent line the money paid in
 * full is not left over: that rent is paid LAST instead, so the bill's other
 * lines are paid and the rent takes what is left, in part. What stays owed
 * then sits on that rent (late fees still apply). Only rent on the bill the
 * passed-by line is on ever moves, and only to the end of that same bill
 * (review fix), so an older bill is never left owing while a newer one is
 * paid: oldest bill first. Only when no such rent can take it
 * is anything left (`left`): it is kept as money paid ahead, which goes on the
 * rest of the balance by itself (creditUse.drawPaidAheadOnBalance).
 */
export function placePartPayment<T extends { id: string; type: string; invoiceId?: string | null }>(
  rows: readonly T[], owedOn: (r: T) => number, tendered: number,
): PartPaymentPlacement<T> {
  let res = walkPart(rows, owedOn, tendered)
  const moved: T[] = []
  while (res.left > 0 && res.notReached.length > 0) {
    // Bills holding a line the money passed by.
    const blockedBills = new Set(res.notReached.map(r => r.invoiceId).filter((x): x is string => !!x))
    const fullRent = res.paid
      .filter(p => PART_PAYABLE_TYPES.includes(p.row.type) && !moved.includes(p.row)
        && !!p.row.invoiceId && blockedBills.has(p.row.invoiceId)
        && !res.partSplits.some(s => s.row === p.row) && p.cents === owedOn(p.row))
      .map(p => p.row)
    const last = fullRent[fullRent.length - 1]
    if (!last) break
    moved.push(last)
    res = walkPart(rentLastOnItsBill(rows, moved), owedOn, tendered)
  }
  return res
}

/**
 * `rows` with each moved rent placed right after the last other line of ITS
 * OWN bill — never after a newer bill's lines — so the money finishes the
 * older bill (rent last, in part) before it reaches a newer one.
 */
function rentLastOnItsBill<T extends { invoiceId?: string | null }>(rows: readonly T[], moved: readonly T[]): T[] {
  const lastOther = new Map<string, number>()
  rows.forEach((r, i) => { if (!moved.includes(r) && r.invoiceId) lastOther.set(r.invoiceId, i) })
  const out: T[] = []
  rows.forEach((r, i) => {
    if (moved.includes(r)) {
      // Only rent on a bill with another line is ever moved; anything else stays put.
      if (!r.invoiceId || !lastOther.has(r.invoiceId)) out.push(r)
      return
    }
    out.push(r)
    if (r.invoiceId && lastOther.get(r.invoiceId) === i) {
      out.push(...rows.filter(m => moved.includes(m) && m.invoiceId === r.invoiceId))
    }
  })
  return out
}

/**
 * 10/6 (Nic): the open lines money paid ahead goes on by itself
 * (creditUse.drawPaidAheadOnBalance; the types creditEligibleRowSql allows) —
 * never a home payment or a FlexPay line. Used to say where money a part
 * payment could not place goes: on the rest of what they owe when such a line
 * is left, otherwise kept toward their next bill.
 */
export function paidAheadGoesOn(r: { type: string; entryDescription?: string | null }): boolean {
  return ['rent', 'utility', 'late_fee', 'fee'].includes(r.type)
    && !['HOMEPMT', 'FLEXPAY'].includes(r.entryDescription ?? '')
}
