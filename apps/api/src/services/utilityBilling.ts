import { meterReadingModulus } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

// S90: utility bill generation engine.
//
// Three billing methods, all driven by utility_meters.billing_method:
//
//   submeter — meter serves a single unit. Usage = (current cycle reading
//     − prior cycle reading). Charge = usage × rate_per_unit + base_fee.
//     Requires two readings to compute usage; the first reading produces
//     no bill (no baseline).
//
//   rubs — Ratio Utility Billing System. One master meter serves multiple
//     units. The master cycle reading is allocated across units by the
//     configured rubs_allocation_method:
//       occupant_count — number of active lease tenants per unit
//       sqft           — units.sqft
//       bedrooms       — units.bedrooms
//       equal_split    — 1/N where N is unit count served by the meter
//     Each unit's share of the base_fee is allocated by the same ratio.
//
//   master_bill_to_landlord — landlord absorbs. No tenant bills generated.
//
// Per-unit, the lease_utility_responsibilities row gates whether the
// tenant or the landlord pays for that utility type at all. Bill is
// generated only when tenant_responsible = TRUE.
//
// Idempotency: utility_bills_one_per_meter_unit_cycle UNIQUE catches
// double-generates. The engine catches 23505 and skips silently — re-
// running a cycle is safe.

export interface GenerateBillsResult {
  meterId: string
  cycleMonth: string
  billsCreated: number
  unitsSkipped: number
  reason?: string
}

export async function generateBillsForMeter(
  meterId: string,
  cycleMonth: Date,  // 1st of month
): Promise<GenerateBillsResult> {
  const cycleIso = isoMonthStart(cycleMonth)

  const meter = await queryOne<any>(
    `SELECT * FROM utility_meters WHERE id = $1`, [meterId])
  if (!meter) throw new AppError(404, 'Meter not found')

  // Get the property's landlord — utility_meters carry property_id, not
  // landlord_id directly. Snapshot at generation time.
  const property = await queryOne<{ landlord_id: string }>(
    `SELECT landlord_id FROM properties WHERE id = $1`, [meter.property_id])
  if (!property) throw new AppError(404, 'Property not found for meter')
  const landlordId = property.landlord_id

  if (meter.billing_method === 'master_bill_to_landlord') {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'master_bill_to_landlord — landlord absorbs, no tenant bills' }
  }

  // S533: landlord-configured tax rate for this utility at this property
  // (no row = 0). Snapshotted per bill; shown as a separate amount.
  const taxRow = await queryOne<{ tax_rate_pct: string }>(`
    SELECT tax_rate_pct FROM property_utility_tax_rates
     WHERE property_id = $1 AND utility_type = $2
  `, [meter.property_id, meter.utility_type])
  const taxRatePct = Number(taxRow?.tax_rate_pct || 0)

  // Resolve which units this meter serves.
  // submeter: utility_meter_units row(s) — usually one. RUBS: many.
  const units = await query<any>(`
    SELECT u.id AS unit_id, u.unit_number, u.sqft, u.bedrooms
      FROM utility_meter_units mu
      JOIN units u ON u.id = mu.unit_id
     WHERE mu.meter_id = $1
  `, [meterId])

  if (units.length === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'meter not assigned to any units' }
  }

  // Get the cycle reading. Both submeter and RUBS need this.
  const cycleReading = await queryOne<any>(`
    SELECT reading_value, is_rollover, needs_review
      FROM utility_meter_readings
     WHERE meter_id = $1 AND billing_cycle_month = $2
     ORDER BY reading_date DESC LIMIT 1
  `, [meterId, cycleIso])

  if (!cycleReading) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'no reading recorded for this cycle' }
  }

  let billsCreated = 0
  let unitsSkipped = 0

  if (meter.billing_method === 'submeter') {
    // A reading flagged for the landlord double-check (below-previous
    // outlier or suspicious-high usage, S533) never bills until the
    // review resolves it — resolve-review re-runs this meter's cycle.
    if (cycleReading.needs_review) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'reading awaiting double-check — no bill until resolved' }
    }
    // Single unit per submeter (by convention). Usage = cycle - prior cycle.
    const priorReading = await queryOne<any>(`
      SELECT reading_value
        FROM utility_meter_readings
       WHERE meter_id = $1 AND billing_cycle_month < $2
       ORDER BY billing_cycle_month DESC, reading_date DESC LIMIT 1
    `, [meterId, cycleIso])
    if (!priorReading) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'no prior reading — first cycle baseline, no bill produced' }
    }
    let usage = Number(cycleReading.reading_value) - Number(priorReading.reading_value)
    if (usage < 0 && cycleReading.is_rollover) {
      // Odometer rollover (S533, automatic): usage wraps past the meter's
      // digit capacity = (10^digits − prior) + current, e.g. a 6-digit
      // 999822 → 000138 = 316. is_rollover is stamped at entry time when
      // the wrap is plausible (< half the meter's range) or by the
      // landlord's double-check confirmation for the flagged outliers.
      usage = (meterReadingModulus(meter.digits) - Number(priorReading.reading_value)) + Number(cycleReading.reading_value)
    }
    if (usage < 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `negative usage (${usage}) — awaiting reading double-check` }
    }
    // S533: sewer rides the water meter — there is no sewer meter in
    // the field, and the tenant sees ONE line item. A water submeter
    // with sewer_rate_per_unit bills usage × (water rate + sewer rate)
    // + base fee on a single bill; the tax amount sums each portion ×
    // its own per-type landlord tax rate. Both rates snapshot on the
    // bill for the audit trail.
    const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
    const sewerTaxRatePct = sewerRate > 0
      ? Number((await queryOne<{ tax_rate_pct: string }>(`
          SELECT tax_rate_pct FROM property_utility_tax_rates
           WHERE property_id = $1 AND utility_type = 'sewer'
        `, [meter.property_id]))?.tax_rate_pct || 0)
      : 0
    for (const unit of units) {
      const baseCharge = usage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0)
      const sewerCharge = usage * sewerRate
      const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: usage,
        allocationMethod: 'submeter',
        allocationBasis: null,
        ratePerUnit: Number(meter.rate_per_unit || 0),
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: baseCharge + sewerCharge,
        taxRatePct,
        taxAmount,
        sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
        readingStart: Number(priorReading.reading_value),
        readingEnd: Number(cycleReading.reading_value),
      })
      if (inserted) billsCreated++
      else unitsSkipped++
    }
    if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped }
  }

  // RUBS: split the cycle reading across all units served.
  const totalUsage = Number(cycleReading.reading_value)
  const totalBaseFee = Number(meter.base_fee || 0)
  const ratePerUnit = Number(meter.rate_per_unit || 0)
  const totalCharge = totalUsage * ratePerUnit + totalBaseFee

  // Compute per-unit basis, then divide.
  const unitBases: Array<{ unitId: string; basis: number }> = []
  for (const u of units) {
    let basis = 0
    if (meter.rubs_allocation_method === 'equal_split') {
      basis = 1
    } else if (meter.rubs_allocation_method === 'sqft') {
      basis = Number(u.sqft || 0)
    } else if (meter.rubs_allocation_method === 'bedrooms') {
      basis = Number(u.bedrooms || 0)
    } else if (meter.rubs_allocation_method === 'occupant_count') {
      const c = await queryOne<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM v_lease_active_tenants
         WHERE EXISTS (
           SELECT 1 FROM leases l
            WHERE l.id = v_lease_active_tenants.lease_id
              AND l.unit_id = $1 AND l.status = 'active')
      `, [u.unit_id])
      basis = Number(c?.count || 0)
    }
    unitBases.push({ unitId: u.unit_id, basis })
  }

  const totalBasis = unitBases.reduce((s, u) => s + u.basis, 0)
  if (totalBasis === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `RUBS basis sums to zero (allocation_method=${meter.rubs_allocation_method}) — no bills generated` }
  }

  for (const ub of unitBases) {
    if (ub.basis === 0) { unitsSkipped++; continue }
    const share = ub.basis / totalBasis
    const inserted = await tryInsertBill({
      meterId, unitId: ub.unitId, landlordId,
      utilityType: meter.utility_type,
      cycleMonth: cycleIso,
      usageAmount: null,
      allocationMethod: meter.rubs_allocation_method,
      allocationBasis: ub.basis,
      ratePerUnit,
      baseFeeShare: round2(totalBaseFee * share),
      chargeAmount: round2(totalCharge * share),
      taxRatePct,
    })
    if (inserted) billsCreated++
    else unitsSkipped++
  }

  if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
  return { meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped }
}

// S548 (Nic — immediate move-out settlement): a bill that just landed on an
// ENDED lease has no next cycle to ride — invoice it NOW so the landlord's
// receivable and the departing tenant's deposit surplus square up the day
// of pull-out. Best-effort: a failure here never unwinds bill generation
// (the deposit-return sweep remains the backstop). Dynamic import because
// invoiceGeneration imports this module (ensureBillsForUnit).
async function invoiceEndedLeaseBills(meterId: string, cycleIso: string): Promise<void> {
  try {
    const ended = await query<{ lease_id: string }>(`
      SELECT DISTINCT ub.lease_id
        FROM utility_bills ub
        JOIN leases l ON l.id = ub.lease_id
       WHERE ub.meter_id = $1 AND ub.billing_cycle_month = $2
         AND ub.payment_id IS NULL AND ub.status IN ('unbilled', 'billed')
         AND (l.status IN ('expired', 'terminated')
              OR (l.end_date IS NOT NULL AND l.end_date <= CURRENT_DATE))
    `, [meterId, cycleIso])
    if (ended.length === 0) return
    const { generateFinalUtilityInvoice } = await import('../jobs/invoiceGeneration')
    for (const r of ended) {
      await generateFinalUtilityInvoice(r.lease_id)
    }
  } catch (err) {
    // Bills stay swept-able via the deposit-return backstop.
    logger.error({ err, meterId, cycleIso }, '[utility-billing] immediate move-out invoicing failed')
  }
}

interface InsertBillArgs {
  meterId: string
  unitId: string
  landlordId: string
  utilityType: string
  cycleMonth: string
  usageAmount: number | null
  allocationMethod: string
  allocationBasis: number | null
  ratePerUnit: number
  baseFeeShare: number
  chargeAmount: number
  taxRatePct: number
  /** Pre-computed tax (e.g. water+sewer portions at their own rates).
      Falls back to chargeAmount × taxRatePct when omitted. */
  taxAmount?: number
  /** Snapshot of the water meter's sewer rate folded into the charge. */
  sewerRatePerUnit?: number | null
  /** Begin/end odometer reads for tenant-invoice transparency (submeter only). */
  readingStart?: number | null
  readingEnd?: number | null
}

// Returns true if a bill was inserted, false if skipped (unit not occupied,
// tenant not responsible for this utility type, or bill already exists).
async function tryInsertBill(args: InsertBillArgs): Promise<boolean> {
  // S548 (Nic — fast turnover): the cycle's usage belongs to the lease that
  // covered the START of the cycle month, NOT whoever is active when the
  // read gets entered. RV spots turn over same-day — the departing guest's
  // Jan 1–10 electric must never land on the arrival whose lease went
  // active on the 10th. Works for ended leases too (the final read usually
  // lands after the lease-end processor expired the lease). Read the meter
  // AT turnover — a late final read folds the gap days into the departing
  // tenant's bill.
  let lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
    SELECT l.id AS lease_id, lt2.tenant_id
      FROM leases l
      JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
     WHERE l.unit_id = $1
       AND l.status IN ('active', 'expired', 'terminated')
       AND l.start_date <= $2::date
       AND COALESCE(l.end_date, '9999-12-31'::date) > $2::date
     ORDER BY l.start_date DESC
     LIMIT 1
  `, [args.unitId, args.cycleMonth])
  if (!lt) {
    // Nobody covered the 1st (mid-month first arrival): the cycle falls to
    // the newest lease overlapping the month — same outcome as the old
    // active-lease rule for that case.
    lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
      SELECT l.id AS lease_id, lt2.tenant_id
        FROM leases l
        JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
       WHERE l.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND l.start_date < ($2::date + interval '1 month')::date
         AND COALESCE(l.end_date, '9999-12-31'::date) >= $2::date
       ORDER BY l.start_date DESC
       LIMIT 1
    `, [args.unitId, args.cycleMonth])
  }
  if (!lt) return false  // no attributable tenant — landlord absorbs

  // Tenant responsibility gate.
  const resp = await queryOne<{ tenant_responsible: boolean }>(`
    SELECT tenant_responsible FROM lease_utility_responsibilities
     WHERE lease_id = $1 AND utility_type = $2
  `, [lt.lease_id, args.utilityType])
  if (!resp || !resp.tenant_responsible) return false

  try {
    await query(`
      INSERT INTO utility_bills
        (meter_id, unit_id, tenant_id, lease_id, landlord_id,
         billing_cycle_month, usage_amount, allocation_method,
         allocation_basis, rate_per_unit, base_fee_share, charge_amount,
         tax_rate_pct, tax_amount, utility_type, sewer_rate_per_unit,
         reading_start, reading_end)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [
      args.meterId, args.unitId, lt.tenant_id, lt.lease_id, args.landlordId,
      args.cycleMonth, args.usageAmount, args.allocationMethod,
      args.allocationBasis, args.ratePerUnit, args.baseFeeShare, args.chargeAmount,
      args.taxRatePct,
      (args.taxAmount ?? Math.round(args.chargeAmount * args.taxRatePct) / 100).toFixed(2),
      args.utilityType,
      args.sewerRatePerUnit ?? null,
      args.readingStart ?? null,
      args.readingEnd ?? null,
    ])
    return true
  } catch (e: any) {
    if (e?.code === '23505') return false  // already generated
    throw e
  }
}

function isoMonthStart(d: Date): string {
  // W-36 fix-it-right (S531): the route builds this Date from
  // 'YYYY-MM-01T00:00:00Z' — reading it with LOCAL getters in any
  // negative-UTC-offset timezone rolls back to the last day of the PRIOR
  // month, so every generate call silently billed the wrong cycle
  // ("generate July" billed June). UTC getters match the UTC construction.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Helper: generate bills for every meter on a property for a given cycle.
// Used by the landlord-triggered POST /utility/generate-bills route.
export async function generateBillsForProperty(
  propertyId: string,
  cycleMonth: Date,
): Promise<GenerateBillsResult[]> {
  const meters = await query<{ id: string }>(
    `SELECT id FROM utility_meters WHERE property_id = $1`, [propertyId])
  const results: GenerateBillsResult[] = []
  for (const m of meters) {
    results.push(await generateBillsForMeter(m.id, cycleMonth))
  }
  return results
}

// S534 (Nic): billing is per-UNIT, not batched to run completion. As
// soon as a unit's meters have their cycle readings, the unit is clear
// to bill on its lease's invoice date — the invoice cron calls this
// right before pulling utility bills, so one unread meter elsewhere on
// the property (or an unfinished verification walk) never holds a
// unit's charges. Generates any missing bills for every (meter, cycle)
// pair serving the unit with a recorded reading on/before the invoice
// cycle, looking back two cycles for late readings. Idempotent — the
// UNIQUE bill constraint and generateBillsForMeter's own gates
// (needs_review, first-cycle baseline, tenant responsibility) all
// still apply; a flagged reading's bill simply rides the next invoice
// once verification/resolution clears it.
export async function ensureBillsForUnit(
  unitId: string,
  throughDate: string,  // ISO date; cycles ≤ its month are considered
): Promise<number> {
  const pending = await query<{ meter_id: string; cycle: string }>(`
    SELECT DISTINCT rd.meter_id, to_char(rd.billing_cycle_month, 'YYYY-MM-DD') AS cycle
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id
                           AND m.billing_method IN ('submeter','rubs')
      JOIN utility_meter_readings rd ON rd.meter_id = mu.meter_id
     WHERE mu.unit_id = $1
       AND rd.billing_cycle_month <= date_trunc('month', $2::date)::date
       AND rd.billing_cycle_month >= (date_trunc('month', $2::date) - interval '2 months')::date
       AND NOT rd.needs_review
       AND NOT EXISTS (
         SELECT 1 FROM utility_bills ub
          WHERE ub.meter_id = rd.meter_id
            AND ub.unit_id = mu.unit_id
            AND ub.billing_cycle_month = rd.billing_cycle_month)
  `, [unitId, throughDate])

  let created = 0
  for (const p of pending) {
    const r = await generateBillsForMeter(p.meter_id, new Date(p.cycle + 'T00:00:00Z'))
    created += r.billsCreated
  }
  return created
}

// Helper: every meter for every property under a landlord. Used by an
// eventual monthly cron once payment integration lands.
export async function generateBillsForLandlord(
  landlordId: string,
  cycleMonth: Date,
): Promise<GenerateBillsResult[]> {
  const meters = await query<{ id: string }>(`
    SELECT m.id FROM utility_meters m
      JOIN properties p ON p.id = m.property_id
     WHERE p.landlord_id = $1
  `, [landlordId])
  const results: GenerateBillsResult[] = []
  for (const m of meters) {
    results.push(await generateBillsForMeter(m.id, cycleMonth))
  }
  return results
}
