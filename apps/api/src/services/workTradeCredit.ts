import { DateTime } from 'luxon'
import type { PoolClient } from 'pg'

// ============================================================
// S517 / Walkthrough Landlord #29 — work-trade credit math.
//
// Locked model (Nic 2026-06-26): rent is traded as a PERCENT of hours
// worked. Each verified hour is worth 1/target of the TOTAL monthly invoice
// (rent + utilities + fees). The target is a per-property setting. A full
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
): CreditDistribution {
  let remaining = round2(Math.max(0, creditAmount))
  const take = (gross: number): number => {
    const used = Math.min(remaining, gross)
    remaining = round2(remaining - used)
    return round2(gross - used)
  }
  const rentNet = take(rent)
  const utilityNets = utilities.map(take)
  const feeNets = fees.map(take)
  const grossSum = round2(rent + utilities.reduce((s, u) => s + u, 0) + fees.reduce((s, f) => s + f, 0))
  const netSum = round2(rentNet + utilityNets.reduce((s, u) => s + u, 0) + feeNets.reduce((s, f) => s + f, 0))
  return { rentNet, utilityNets, feeNets, creditApplied: round2(grossSum - netSum) }
}

export interface WorkTradeCreditContext {
  agreementId: string
  target: number
  verifiedHours: number
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
            p.work_trade_hours_target AS target,
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
  }
}
