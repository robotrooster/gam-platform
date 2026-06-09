import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'

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
    SELECT reading_value
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
    const usage = Number(cycleReading.reading_value) - Number(priorReading.reading_value)
    if (usage < 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `negative usage (${usage}) — re-check readings before generating` }
    }
    for (const unit of units) {
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: usage,
        allocationMethod: 'submeter',
        allocationBasis: null,
        ratePerUnit: Number(meter.rate_per_unit || 0),
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: usage * Number(meter.rate_per_unit || 0) + Number(meter.base_fee || 0),
      })
      if (inserted) billsCreated++
      else unitsSkipped++
    }
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
    })
    if (inserted) billsCreated++
    else unitsSkipped++
  }

  return { meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped }
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
}

// Returns true if a bill was inserted, false if skipped (unit not occupied,
// tenant not responsible for this utility type, or bill already exists).
async function tryInsertBill(args: InsertBillArgs): Promise<boolean> {
  // Find the active lease + primary tenant on this unit at the cycle month.
  // Use v_lease_active_tenants for the primary.
  const lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
    SELECT vlat.lease_id, vlat.tenant_id
      FROM v_lease_active_tenants vlat
      JOIN leases l ON l.id = vlat.lease_id
     WHERE l.unit_id = $1 AND l.status = 'active' AND vlat.role = 'primary'
     LIMIT 1
  `, [args.unitId])
  if (!lt) return false  // no active primary tenant — landlord absorbs

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
         allocation_basis, rate_per_unit, base_fee_share, charge_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      args.meterId, args.unitId, lt.tenant_id, lt.lease_id, args.landlordId,
      args.cycleMonth, args.usageAmount, args.allocationMethod,
      args.allocationBasis, args.ratePerUnit, args.baseFeeShare, args.chargeAmount,
    ])
    return true
  } catch (e: any) {
    if (e?.code === '23505') return false  // already generated
    throw e
  }
}

function isoMonthStart(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
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
