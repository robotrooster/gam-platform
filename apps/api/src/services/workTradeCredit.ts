import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'

// ============================================================
// S517 / Walkthrough Landlord #29 — work-trade credit math.
//
// Locked model (Nic 2026-06-26): rent is traded as a PERCENT of hours
// worked. Each verified hour is worth 1/target of the TOTAL monthly invoice
// (rent + utilities + fees + propane).
//
// S609 (Nic): PROPANE COUNTS. It was excluded as a "fixed contractual split
// amount", which meant a full trade month still left a propane bill:
//
//   "We need to find a way to include propane in there too, because at a
//    different property I own we do dispense propane, and we give our seasonal
//    help free propane in the winter. We don't actually invoice them anything.
//    I just need a way to track it — what's being given out, the total value of
//    what's been given, for what work has been done."
//
// Running it through the credit is what makes that visible rather than
// informal: the fill is billed at its real value, the credit cancels it, and the
// invoice records both. The value given and the hours worked end up on the same
// document instead of in someone's head. The target is PER AGREEMENT (W-56, Nic:
// different rents and different work don't translate equally — the
// property value is only the default for new agreements). A full
// target month covers 100% of the invoice; fewer hours cover a proportional
// slice; excess hours are capped at 100% (a trade, not paid labor).
//
// The credit is computed at invoice generation from APPROVED work_trade_logs
// in the calendar month immediately preceding the invoice's due date — i.e.
// you work in June, it reduces the rent that comes due in July. Only verified
// (approved) hours count.
// ============================================================

/** Round a dollar value to cents (half-up). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Fraction of the invoice covered by verified hours, clamped to [0, 1].
 * 40 verified hours against an 80 target → 0.5 (50% of the invoice).
 */
export function workTradeFraction(verifiedHours: number, target: number): number {
  if (!(target > 0) || !(verifiedHours > 0)) return 0
  return Math.min(1, verifiedHours / target)
}

export interface CreditDistribution {
  rentNet: number
  utilityNets: number[]
  feeNets: number[]
  /** S609: propane installment nets, in the order supplied. */
  propaneNets: number[]
  creditApplied: number   // exact dollars removed = sum(gross) − sum(nets)
}

/**
 * Apply a dollar credit across the billable rows in priority order:
 * rent first, then utilities, then fees. The credit basis is the TOTAL
 * invoice (the caller computes creditAmount off rent+utilities+fees), but the
 * dollars land on rent first and only spill into utilities/fees when a near-
 * full target month is worked — so "rent traded for labor" reads naturally
 * while still being able to cover more than base rent (per the locked spec).
 *
 * creditAmount is expected to be ≤ the gross billable total; any residual that
 * can't be absorbed is ignored (it can't exceed 100% because the fraction is
 * clamped upstream).
 */
export function distributeWorkTradeCredit(
  rent: number,
  utilities: number[],
  fees: number[],
  creditAmount: number,
  propane: number[] = [],
  /**
   * S613 (Nic): which rows this agreement actually covers. A row that is NOT
   * covered is billed in FULL — it never takes credit here, and the caller must
   * also leave it out of the basis the credit was computed from, or the tenant's
   * labour would buy dollars off a bill they are supposed to pay whole.
   * Omitted = everything covered, which is what every agreement did before this.
   */
  covered: {
    rent?: boolean
    utilities?: boolean[]
    fees?: boolean[]
    propane?: boolean
  } = {},
): CreditDistribution {
  let remaining = round2(Math.max(0, creditAmount))
  const take = (gross: number): number => {
    const used = Math.min(remaining, gross)
    remaining = round2(remaining - used)
    return round2(gross - used)
  }
  /** A row outside the agreement passes through untouched. */
  const takeIf = (gross: number, isCovered: boolean): number =>
    isCovered ? take(gross) : round2(gross)

  const rentNet = takeIf(rent, covered.rent !== false)
  const utilityNets = utilities.map((u, i) => takeIf(u, covered.utilities?.[i] !== false))
  const feeNets = fees.map((f, i) => takeIf(f, covered.fees?.[i] !== false))
  // S609: propane is taken LAST, so a partial month covers the recurring cost of
  // living here before it touches a one-off fill. Only a near-full month reaches
  // it — which matches how it is actually used (Nic gives seasonal help their
  // winter propane outright, and they are working a full trade).
  const propaneNets = propane.map(p => takeIf(p, covered.propane !== false))
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
  const grossSum = round2(rent + sum(utilities) + sum(fees) + sum(propane))
  const netSum = round2(rentNet + sum(utilityNets) + sum(feeNets) + sum(propaneNets))
  return { rentNet, utilityNets, feeNets, propaneNets, creditApplied: round2(grossSum - netSum) }
}

export interface WorkTradeCreditContext {
  agreementId: string
  target: number
  verifiedHours: number
  /** S613: what this agreement trades for. See the migration. */
  coveredCharges: string[]
}

/** S613: is this charge inside the agreement? Utilities match on their own
 *  type, so "electric included, propane excluded" is expressible per row. */
export function isCovered(coveredCharges: string[], kind: string): boolean {
  return coveredCharges.includes(kind)
}

/**
 * Resolve the active work-trade agreement for (unit, tenant) covering the
 * given due date, plus the property's hours target and the sum of APPROVED
 * log hours in the calendar month before the due date. Returns null when the
 * unit/tenant has no active agreement for that cycle.
 *
 * Reads on the caller-provided client so it sees in-flight writes inside the
 * invoice-generation transaction.
 */
export async function loadWorkTradeCreditContext(
  client: PoolClient,
  opts: { unitId: string; tenantId: string; dueDate: string },
): Promise<WorkTradeCreditContext | null> {
  const due = DateTime.fromISO(opts.dueDate)
  const prior = due.minus({ months: 1 })
  const pmStart = prior.startOf('month').toISODate()!
  const pmEnd = prior.endOf('month').toISODate()!

  const r = await client.query<{ agreement_id: string; target: number; verified_hours: string }>(
    `SELECT wta.id AS agreement_id,
            wta.monthly_hours_target AS target,
            wta.covered_charges,
            COALESCE((
              SELECT SUM(l.hours)
                FROM work_trade_logs l
               WHERE l.agreement_id = wta.id
                 AND l.status = 'approved'
                 AND l.work_date >= $3::date
                 AND l.work_date <= $4::date
            ), 0) AS verified_hours
       FROM work_trade_agreements wta
       JOIN units u ON u.id = wta.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE wta.unit_id = $1
        AND wta.tenant_id = $2
        AND wta.status = 'active'
        AND wta.start_date <= $5::date
        AND (wta.end_date IS NULL OR wta.end_date >= $5::date)
      LIMIT 1`,
    [opts.unitId, opts.tenantId, pmStart, pmEnd, opts.dueDate],
  )
  if (r.rows.length === 0) return null
  return {
    agreementId: r.rows[0].agreement_id,
    target: Number(r.rows[0].target),
    verifiedHours: Number(r.rows[0].verified_hours),
    coveredCharges: (r.rows[0] as any).covered_charges ?? [],
  }
}
