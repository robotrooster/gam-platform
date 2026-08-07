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
//     S558: metered exclusion (UNIT-DRIVEN) — a served unit that has its own
//     same-utility submeter is billed on that submeter and its cycle usage is
//     SUBTRACTED from the master pool before the split; only the un-submetered
//     units share the remainder. Derived from shared unit membership (no manual
//     meter link). Utility-neutral (water/gas/electric).
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

/** Pure usage math shared by the submeter branch and the S558 RUBS exclusion:
 *  cycle − prior, with odometer-rollover handling when the wrap was stamped. */
function cycleUsageFromReadings(cycleVal: number, priorVal: number, isRollover: boolean, digits: number): number {
  let usage = cycleVal - priorVal
  if (usage < 0 && isRollover) usage = (meterReadingModulus(digits) - priorVal) + cycleVal
  return usage
}

/** S558: a linked submeter's usage for the cycle, for RUBS pool exclusion.
 *  Returns { blocked } when the submeter can't be resolved — the RUBS pool must
 *  NOT bill until every linked submeter is read + resolved, or the RUBS units
 *  would carry gallons that were actually the submetered units'. */
async function submeterCycleUsageForExclusion(
  meterId: string, cycleIso: string,
): Promise<{ usage: number } | { blocked: string }> {
  const m = await queryOne<{ digits: number; label: string; out_of_service: boolean; utility_type: string; property_id: string }>(
    `SELECT digits, label, out_of_service, utility_type, property_id FROM utility_meters WHERE id = $1`, [meterId])
  if (!m) return { blocked: 'linked submeter not found' }
  // Broken submeter (S559): no real read, but it must NOT block the RUBS
  // pool. Its excluded amount is what it actually bills — the lowest
  // comparable usage (0 when there's no comparable to draw from).
  if (m.out_of_service) {
    const u = await queryOne<{ unit_type: string | null; rv_amp_service: string | null }>(
      `SELECT cu.unit_type, cu.rv_amp_service FROM utility_meter_units mu
         JOIN units cu ON cu.id = mu.unit_id WHERE mu.meter_id = $1 LIMIT 1`, [meterId])
    const comp = await lowestComparableUsage({
      brokenMeterId: meterId, propertyId: m.property_id, utilityType: m.utility_type,
      unitType: u?.unit_type ?? null, rvAmpService: u?.rv_amp_service ?? null, cycleIso,
    })
    return { usage: comp ?? 0 }
  }
  const cur = await queryOne<any>(
    `SELECT reading_value, is_rollover, needs_review, reading_date, created_at FROM utility_meter_readings
      WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle' ORDER BY reading_date DESC LIMIT 1`,
    [meterId, cycleIso])
  if (!cur) return { blocked: `submeter "${m.label}" has no reading this cycle` }
  if (cur.needs_review) return { blocked: `submeter "${m.label}" awaiting double-check` }
  // Point-in-time prior (S559) — see generateBillsForMeter.
  const prior = await queryOne<any>(
    `SELECT reading_value FROM utility_meter_readings
      WHERE meter_id = $1 AND (reading_date, created_at) < ($2, $3)
      ORDER BY reading_date DESC, created_at DESC LIMIT 1`, [meterId, cur.reading_date, cur.created_at])
  if (!prior) return { blocked: `submeter "${m.label}" has no prior reading (needs a baseline cycle)` }
  const usage = cycleUsageFromReadings(
    Number(cur.reading_value), Number(prior.reading_value), !!cur.is_rollover, m.digits)
  if (usage < 0) return { blocked: `submeter "${m.label}" has negative usage — awaiting double-check` }
  return { usage }
}

/** S559: lowest comparable submeter usage for a BROKEN meter's cycle.
 *  A meter marked out of service has no valid read, so it bills the LOWEST
 *  usage among comparable units — same property, same unit_type (+ RV amp
 *  service) — for the same utility that cycle, rounded DOWN. Billed as a
 *  normal charge (NEVER labeled "estimated"): the tenant provably pays at or
 *  below every comparable neighbor, so there's nothing to dispute. Fallback:
 *  same property, any unit type. null when no comparable has real usage — we
 *  never invent a number with no basis. Rollover-negative comparables are
 *  excluded (usage >= 0 filter). */
async function lowestComparableUsage(args: {
  brokenMeterId: string; propertyId: string; utilityType: string;
  unitType: string | null; rvAmpService: string | null; cycleIso: string;
}): Promise<number | null> {
  const run = (matchType: boolean) => query<{ usage: string }>(`
    SELECT (cyc.reading_value - pri.reading_value) AS usage
      FROM utility_meters cm
      JOIN utility_meter_units cmu ON cmu.meter_id = cm.id
      JOIN units cu ON cu.id = cmu.unit_id
      JOIN LATERAL (
        SELECT reading_value, reading_date, created_at
          FROM utility_meter_readings
         WHERE meter_id = cm.id AND billing_cycle_month = $2
           AND reason = 'monthly_cycle' AND needs_review = false
         ORDER BY reading_date DESC LIMIT 1) cyc ON TRUE
      LEFT JOIN LATERAL (
        SELECT reading_value FROM utility_meter_readings
         WHERE meter_id = cm.id
           AND (reading_date, created_at) < (cyc.reading_date, cyc.created_at)
         ORDER BY reading_date DESC, created_at DESC LIMIT 1) pri ON TRUE
     WHERE cm.property_id = $1 AND cm.utility_type = $3
       AND cm.billing_method = 'submeter' AND cm.out_of_service = false
       AND cm.id <> $4
       AND pri.reading_value IS NOT NULL
       AND (cyc.reading_value - pri.reading_value) >= 0
       ${matchType
         ? `AND cu.unit_type IS NOT DISTINCT FROM $5
            AND cu.rv_amp_service IS NOT DISTINCT FROM $6`
         : ''}
  `, matchType
       ? [args.propertyId, args.cycleIso, args.utilityType, args.brokenMeterId, args.unitType, args.rvAmpService]
       : [args.propertyId, args.cycleIso, args.utilityType, args.brokenMeterId])

  let rows = await run(true)                       // same unit_type + amp
  if (rows.length === 0) rows = await run(false)   // fallback: same property
  const usages = rows.map(r => Number(r.usage)).filter(u => u >= 0)
  if (usages.length === 0) return null
  return Math.floor(Math.min(...usages))
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
    SELECT u.id AS unit_id, u.unit_number, u.sqft, u.bedrooms,
           u.unit_type, u.rv_amp_service
      FROM utility_meter_units mu
      JOIN units u ON u.id = mu.unit_id
     WHERE mu.meter_id = $1
  `, [meterId])

  if (units.length === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'meter not assigned to any units' }
  }

  if (meter.billing_method === 'flat_rate') {
    // S558 (Nic): fixed per-unit charge with NO meter reading (e.g. a flat trash
    // buildback). Each served unit bills the flat amount (base_fee) as its own
    // line item so the tenant sees exactly what they pay for, instead of it
    // being folded into rent. Utility-neutral. tryInsertBill still gates on the
    // per-unit tenant_responsible flag.
    const flatAmount = Number(meter.base_fee || 0)
    if (flatAmount <= 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'flat_rate meter has no amount set (base fee = 0)' }
    }
    let created = 0, skipped = 0
    for (const unit of units) {
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: null,
        allocationMethod: 'flat_rate',
        allocationBasis: null,
        ratePerUnit: 0,
        baseFeeShare: flatAmount,
        chargeAmount: flatAmount,
        taxRatePct,
      })
      if (inserted) created++; else skipped++
    }
    if (created > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated: created, unitsSkipped: skipped }
  }

  // Broken meter (S559): out of service → bill the LOWEST comparable usage
  // (same property + unit_type/amp) that cycle, rounded down, as a NORMAL
  // charge. No read needed, never labeled "estimated", never blocks the
  // end-of-month flow. Only individual submeters bill this way — RUBS pools
  // / flat / master have no per-unit odometer to substitute. Placed BEFORE
  // the cycle-reading fetch so a stuck/absent read never holds billing.
  if (meter.billing_method === 'submeter' && meter.out_of_service) {
    const brokenUnit = units[0]
    const compUsage = await lowestComparableUsage({
      brokenMeterId: meterId, propertyId: meter.property_id,
      utilityType: meter.utility_type,
      unitType: brokenUnit?.unit_type ?? null,
      rvAmpService: brokenUnit?.rv_amp_service ?? null,
      cycleIso,
    })
    if (compUsage == null) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'broken meter — no comparable unit usage to bill from (flag for landlord)' }
    }
    const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
    const sewerTaxRatePct = sewerRate > 0
      ? Number((await queryOne<{ tax_rate_pct: string }>(`
          SELECT tax_rate_pct FROM property_utility_tax_rates
           WHERE property_id = $1 AND utility_type = 'sewer'
        `, [meter.property_id]))?.tax_rate_pct || 0)
      : 0
    let created = 0, skipped = 0
    for (const unit of units) {
      const baseCharge = compUsage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0)
      const sewerCharge = compUsage * sewerRate
      const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: compUsage,
        allocationMethod: 'comparable_low',
        allocationBasis: null,
        ratePerUnit: Number(meter.rate_per_unit || 0),
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: baseCharge + sewerCharge,
        taxRatePct,
        taxAmount,
        sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
        readingStart: null,
        readingEnd: null,
      })
      if (inserted) created++; else skipped++
    }
    if (created > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
    return { meterId, cycleMonth: cycleIso, billsCreated: created, unitsSkipped: skipped }
  }

  // Get the cycle reading. Both submeter and RUBS need this.
  const cycleReading = await queryOne<any>(`
    SELECT reading_value, is_rollover, needs_review, reading_date, created_at
      FROM utility_meter_readings
     WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'
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
    // Point-in-time baseline (S559): usage is measured from the read
    // IMMEDIATELY BEFORE this cycle read by time — which may be a mid-month
    // turnover/reference read that reset the baseline, not last month's
    // cycle read. That's what keeps a departed short-term guest's usage off
    // the next occupant's bill.
    const priorReading = await queryOne<any>(`
      SELECT reading_value
        FROM utility_meter_readings
       WHERE meter_id = $1
         AND (reading_date, created_at) < ($2, $3)
       ORDER BY reading_date DESC, created_at DESC LIMIT 1
    `, [meterId, cycleReading.reading_date, cycleReading.created_at])
    if (!priorReading) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: 'no prior reading — first cycle baseline, no bill produced' }
    }
    // Odometer rollover (S533, automatic): usage wraps past the meter's digit
    // capacity = (10^digits − prior) + current, e.g. a 6-digit 999822 → 000138
    // = 316. is_rollover is stamped at entry when the wrap is plausible (< half
    // the meter's range) or by the landlord's double-check confirmation.
    const usage = cycleUsageFromReadings(
      Number(cycleReading.reading_value), Number(priorReading.reading_value),
      !!cycleReading.is_rollover, meter.digits)
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

  // RUBS: split the master reading across the units it serves — but a served
  // unit that has its OWN submeter of this utility is billed on that submeter
  // and its usage is SUBTRACTED from the pool; only the un-submetered units
  // split the remainder. S558 (Nic): the exclusion is derived from UNIT
  // MEMBERSHIP — assign every unit the master feeds, and the ones with a
  // same-utility submeter fall out automatically (no manual linking). If any
  // such submeter can't be resolved this cycle, the pool is unknowable — do NOT
  // bill (would over-charge the RUBS units the submetered units' usage).
  const masterUsage = Number(cycleReading.reading_value)
  const subOnUnit = await query<{ unit_id: string; submeter_id: string }>(
    `SELECT smu.unit_id, sm.id AS submeter_id
       FROM utility_meter_units smu
       JOIN utility_meters sm ON sm.id = smu.meter_id
      WHERE sm.billing_method = 'submeter'
        AND sm.utility_type = $2
        AND smu.unit_id = ANY($1::uuid[])`,
    [units.map((u: any) => u.unit_id), meter.utility_type])
  const excludedUnitIds = new Set(subOnUnit.map(r => r.unit_id))
  let excludedUsage = 0
  for (const s of subOnUnit) {
    const r = await submeterCycleUsageForExclusion(s.submeter_id, cycleIso)
    if ('blocked' in r) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `RUBS pool can't be computed — ${r.blocked}. Read/resolve every submeter on this master's units, then re-run.` }
    }
    excludedUsage += r.usage
  }
  if (excludedUsage > masterUsage) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `Submetered usage (${excludedUsage}) exceeds the master reading (${masterUsage}) — check the readings.` }
  }
  // Only the units WITHOUT their own submeter split the remaining pool.
  const rubsUnits = units.filter((u: any) => !excludedUnitIds.has(u.unit_id))
  const totalUsage = masterUsage - excludedUsage
  const totalBaseFee = Number(meter.base_fee || 0)
  const ratePerUnit = Number(meter.rate_per_unit || 0)
  const totalCharge = totalUsage * ratePerUnit + totalBaseFee

  // Compute per-unit basis, then divide.
  const unitBases: Array<{ unitId: string; basis: number }> = []
  for (const u of rubsUnits) {
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

  // S587 (Nic): reconcile rounding so the per-unit bills sum EXACTLY to the pool
  // charge. Rounding each share to the cent otherwise drops a penny or two per
  // cycle (e.g. $100 across 3 units = $33.33×3 = $99.99). The leftover (±) is
  // placed on the LOWEST bill. Fully deterministic — a re-run recomputes the
  // identical split — so it stays safe with the engine's re-runnable design.
  // basis-0 units (e.g. a vacant occupant_count unit) never bill; counted as
  // skipped and excluded from the split.
  const billable = unitBases.filter(ub => ub.basis > 0)
  unitsSkipped += unitBases.length - billable.length
  const alloc = billable.map(ub => {
    const share = ub.basis / totalBasis
    return {
      unitId:       ub.unitId,
      basis:        ub.basis,
      baseFeeShare: round2(totalBaseFee * share),
      chargeAmount: round2(totalCharge * share),
    }
  })
  const residual = round2(totalCharge - alloc.reduce((s, a) => s + a.chargeAmount, 0))
  if (residual !== 0 && alloc.length > 0) {
    let lo = alloc[0]
    for (const a of alloc) if (a.chargeAmount < lo.chargeAmount) lo = a
    lo.chargeAmount = round2(lo.chargeAmount + residual)
  }
  for (const a of alloc) {
    const inserted = await tryInsertBill({
      meterId, unitId: a.unitId, landlordId,
      utilityType: meter.utility_type,
      cycleMonth: cycleIso,
      usageAmount: null,
      allocationMethod: meter.rubs_allocation_method,
      allocationBasis: a.basis,
      ratePerUnit,
      baseFeeShare: a.baseFeeShare,
      chargeAmount: a.chargeAmount,
      taxRatePct,
    })
    if (inserted) billsCreated++
    else unitsSkipped++
  }

  if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
  return { meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped }
}

/** S559: bill a MOVE-OUT final read on a submeter — the departing responsible
 *  tenant's usage from the previous read up to this read, for the read's cycle
 *  month. Reuses the responsibility-gated insert + immediate ended-lease
 *  invoicing. Reference reads (turnover/replaced/other) never call this.
 *  Known limitation: the per-(meter,unit,cycle,utility) bill uniqueness lets
 *  only ONE billed tenant per unit per cycle — fine when the arrival is a
 *  utilities-included short-term stay (the common RV turnover), a follow-up
 *  otherwise. */
export async function billMoveOutRead(meterId: string, readingId: string): Promise<{ billed: boolean; reason?: string }> {
  const meter = await queryOne<any>(`SELECT * FROM utility_meters WHERE id = $1`, [meterId])
  if (!meter || meter.billing_method !== 'submeter') return { billed: false, reason: 'not a submeter' }
  const property = await queryOne<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id = $1`, [meter.property_id])
  if (!property) return { billed: false, reason: 'property not found' }
  // S560: format billing_cycle_month to 'YYYY-MM-DD' in SQL — pg returns a
  // `date` column as a JS Date, and String(date).slice(0,10) yields "Wed Jul 01"
  // (invalid), which crashed tryInsertBill's insert. to_char keeps it a string.
  const read = await queryOne<any>(`SELECT reading_value, reading_date, created_at, to_char(billing_cycle_month, 'YYYY-MM-DD') AS billing_cycle_month FROM utility_meter_readings WHERE id = $1`, [readingId])
  if (!read) return { billed: false, reason: 'reading not found' }
  const prior = await queryOne<any>(`
    SELECT reading_value FROM utility_meter_readings
     WHERE meter_id = $1 AND (reading_date, created_at) < ($2, $3)
     ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
    [meterId, read.reading_date, read.created_at])
  if (!prior) return { billed: false, reason: 'no prior read — baseline only, nothing to bill' }
  // S560 (Nic): a below-previous move-out read is an odometer ROLLOVER — bill the
  // wrapped usage automatically. A physical meter swap is recorded separately as
  // its own 'meter_replaced' read (fresh baseline, no charge), so it never
  // arrives here as an ambiguous wrap — no landlord flag needed. (Short-term
  // stays don't bill at all; that path never calls billMoveOutRead.)
  const cur = Number(read.reading_value)
  const priorVal = Number(prior.reading_value)
  // S561 (Nic): auto-detect an odometer rollover (cur < prior) and bill the wrap
  // — but only when it's PHYSICALLY plausible. A meter can only wrap if the prior
  // read was near its ceiling; if prior is well below the top, a below-prior read
  // is almost certainly a mis-entered (typo) reading, not a real wrap. Billing the
  // "wrap" there would over-charge the departing tenant a huge phantom amount, so
  // we refuse and surface it (the person entering the move-out read sees the
  // reason immediately and re-checks the number) rather than auto-bill a monster.
  const digits = Number(meter.digits)
  const isRollover = cur < priorVal
  if (isRollover && priorVal < meterReadingModulus(digits) * 0.9) {
    return { billed: false, reason: 'move-out read is below the previous read but the meter was not near its ceiling — likely a mis-entered reading, not a rollover; please re-check the number' }
  }
  const usage = cycleUsageFromReadings(cur, priorVal, isRollover, digits)

  const units = await query<any>(`SELECT u.id AS unit_id FROM utility_meter_units mu JOIN units u ON u.id = mu.unit_id WHERE mu.meter_id = $1`, [meterId])
  const cycleIso = String(read.billing_cycle_month).slice(0, 10)
  const taxRatePct = Number((await queryOne<{ tax_rate_pct: string }>(`SELECT tax_rate_pct FROM property_utility_tax_rates WHERE property_id = $1 AND utility_type = $2`, [meter.property_id, meter.utility_type]))?.tax_rate_pct || 0)
  const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
  const sewerTaxRatePct = sewerRate > 0
    ? Number((await queryOne<{ tax_rate_pct: string }>(`SELECT tax_rate_pct FROM property_utility_tax_rates WHERE property_id = $1 AND utility_type = 'sewer'`, [meter.property_id]))?.tax_rate_pct || 0)
    : 0
  let billed = false
  for (const unit of units) {
    const baseCharge = usage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0)
    const sewerCharge = usage * sewerRate
    const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
    const inserted = await tryInsertBill({
      meterId, unitId: unit.unit_id, landlordId: property.landlord_id,
      utilityType: meter.utility_type, cycleMonth: cycleIso,
      usageAmount: usage, allocationMethod: 'submeter', allocationBasis: null,
      ratePerUnit: Number(meter.rate_per_unit || 0), baseFeeShare: Number(meter.base_fee || 0),
      chargeAmount: baseCharge + sewerCharge, taxRatePct, taxAmount,
      sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
      readingStart: Number(prior.reading_value), readingEnd: Number(read.reading_value),
    })
    if (inserted) billed = true
  }
  if (billed) await invoiceEndedLeaseBills(meterId, cycleIso)
  return { billed }
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
export async function tryInsertBill(args: InsertBillArgs): Promise<boolean> {
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
