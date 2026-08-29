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
//       rented_spaces  — 1/N across the units actually LEASED
//       fixture_count  — units.water_fixture_count
//       unit_type_weight / hybrid — see rubs_weights
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
 *  cycle − prior, with odometer-rollover handling when the wrap was stamped.
 *
 *  S613 (Nic): the difference is in FACE TURNS; the multiplier converts it to
 *  billing units. A water face that counts per hundred gallons reads 413 → 415
 *  for 200 gallons, and billing at a penny a gallon has to see 200, not 2.
 *  Rollover uses the FACE modulus, so the wrap is computed before the multiply —
 *  a 7-digit face wraps at 10^7 turns whatever each turn is worth. */
function cycleUsageFromReadings(
  cycleVal: number, priorVal: number, isRollover: boolean, digits: number,
  multiplier = 1,
): number {
  let usage = cycleVal - priorVal
  if (usage < 0 && isRollover) usage = (meterReadingModulus(digits) - priorVal) + cycleVal
  return usage * (multiplier > 0 ? multiplier : 1)
}

/** S558/S605: a linked submeter's usage for the cycle, for RUBS pool exclusion.
 *
 *  S605 (Nic, DIRECTIVE): this NEVER blocks. It used to return { blocked } for
 *  an unread, flagged, baseline-less or negative submeter, and the caller then
 *  refused to bill the WHOLE master — so one meter nobody could read stopped
 *  the entire property's water bill. Nic: "if one water meter is broken or not
 *  spinning, or somebody was on vacation and it gets a read that shows no
 *  usage... it still needs to bill the water out."
 *
 *  Unresolvable now falls back to the SAME estimate a broken meter already
 *  used since S559 — the lowest usage among comparable units at the property
 *  that cycle. The estimate is deliberately the LOWEST rather than an average:
 *  it is the figure that can be defended to the excluded tenant without
 *  argument, and it keeps the exclusion conservative.
 *
 *  `estimated` tells the caller the number was inferred, so the cycle can be
 *  surfaced for a read-and-correct instead of passing silently. */
async function submeterCycleUsageForExclusion(
  meterId: string, cycleIso: string,
): Promise<{ usage: number; estimated?: string }> {
  const m = await queryOne<{ digits: number; label: string; out_of_service: boolean; utility_type: string; property_id: string; reading_multiplier: string }>(
    `SELECT digits, label, out_of_service, utility_type, property_id, reading_multiplier
       FROM utility_meters WHERE id = $1`, [meterId])
  if (!m) return { usage: 0, estimated: 'linked submeter not found' }
  // Broken submeter (S559): no real read, but it must NOT block the RUBS
  // pool. Its excluded amount is what it actually bills — the lowest
  // comparable usage (0 when there's no comparable to draw from).
  if (m.out_of_service) {
    const est = await estimateForUnresolvedSubmeter(m, meterId, cycleIso, `"${m.label}" is out of service`)
    return { usage: est.usage }   // long-standing, expected state — not flagged as an anomaly
  }
  const cur = await queryOne<any>(
    `SELECT reading_value, is_rollover, needs_review, reading_date, created_at FROM utility_meter_readings
      WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle' ORDER BY reading_date DESC LIMIT 1`,
    [meterId, cycleIso])
  if (!cur) return estimateForUnresolvedSubmeter(m, meterId, cycleIso, `"${m.label}" had no reading this cycle`)
  // A flagged read is a number nobody has confirmed yet. Estimating rather than
  // using it keeps an obviously-wrong read (stuck meter, transposed digits) out
  // of the pool math, and the double-check queue still gets it either way.
  if (cur.needs_review) return estimateForUnresolvedSubmeter(m, meterId, cycleIso, `"${m.label}" is awaiting a double-check`)
  // Point-in-time prior (S559) — see generateBillsForMeter.
  const prior = await queryOne<any>(
    `SELECT reading_value FROM utility_meter_readings
      WHERE meter_id = $1 AND (reading_date, created_at) < ($2, $3)
      ORDER BY reading_date DESC, created_at DESC LIMIT 1`, [meterId, cur.reading_date, cur.created_at])
  if (!prior) return estimateForUnresolvedSubmeter(m, meterId, cycleIso, `"${m.label}" has no opening read`)
  const usage = cycleUsageFromReadings(
    Number(cur.reading_value), Number(prior.reading_value), !!cur.is_rollover, m.digits,
    Number(m.reading_multiplier ?? 1))
  if (usage < 0) return estimateForUnresolvedSubmeter(m, meterId, cycleIso, `"${m.label}" read lower than the previous read`)
  return { usage }
}

/** S605: the shared fallback — what a submeter is assumed to have used when its
 *  real usage can't be established this cycle. Mirrors the S559 broken-meter
 *  rule exactly, so a meter that is unread and a meter that is out of service
 *  are excluded on the same basis. 0 when the property has no comparable to
 *  draw from: we never invent a number with no evidence behind it. */
async function estimateForUnresolvedSubmeter(
  m: { utility_type: string; property_id: string },
  meterId: string, cycleIso: string, why: string,
): Promise<{ usage: number; estimated: string }> {
  const u = await queryOne<{ unit_type: string | null; rv_amp_service: string | null }>(
    `SELECT cu.unit_type, cu.rv_amp_service FROM utility_meter_units mu
       JOIN units cu ON cu.id = mu.unit_id WHERE mu.meter_id = $1 LIMIT 1`, [meterId])
  const comp = await lowestComparableUsage({
    brokenMeterId: meterId, propertyId: m.property_id, utilityType: m.utility_type,
    unitType: u?.unit_type ?? null, rvAmpService: u?.rv_amp_service ?? null, cycleIso,
  })
  return { usage: comp ?? 0, estimated: why }
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
    -- S613: comparable usage is in BILLING UNITS, not face turns. Each meter
    -- carries its own multiplier, so a park mixing per-gallon and per-hundred
    -- faces still compares like with like — without this, a broken meter on a
    -- per-hundred face would be estimated at a hundredth of the real usage.
    SELECT (cyc.reading_value - pri.reading_value) * cm.reading_multiplier AS usage
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


/** S607: the blended per-unit rate a `bill_amount` master prices its whole line
 *  at for one cycle — the provider's actual dollar charge divided by the total
 *  usage that charge covered.
 *
 *  Returned for a UNIT, because the submeter branch needs it too: a submetered
 *  unit sitting under a bill_amount master bills its MEASURED usage at this
 *  same rate, which is what makes the line recover exactly the bill and no more.
 *  Everyone on the line pays the park's true cost per gallon.
 *
 *  The provider's service charge and taxes are already inside the dollar figure,
 *  so they ride within the rate — Nic: "if they see it nickel and dimed as
 *  separate charges, here's the water rate, here's the fee for the water,
 *  they're not gonna like it... that just needs to have a blended rate on the
 *  back end to include any fee." One line item on the tenant's bill.
 *
 *  null whenever the unit is not on such a master, the dollar bill has not been
 *  entered, or the cycle recorded no usage to divide by — every one of which
 *  falls back to the ordinary rate path rather than blocking. */
async function blendedRateForUnit(
  unitId: string, utilityType: string, cycleIso: string,
): Promise<{ rate: number; masterLabel: string } | null> {
  const row = await queryOne<{ label: string; bill_amount: string; reading_value: string }>(`
    SELECT m.label, rd.bill_amount, rd.reading_value
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id
                           AND m.billing_method = 'rubs'
                           AND m.rubs_basis = 'bill_amount'
                           AND m.utility_type = $2
      JOIN utility_meter_readings rd ON rd.meter_id = m.id
                                    AND rd.billing_cycle_month = $3
                                    AND rd.reason = 'monthly_cycle'
     WHERE mu.unit_id = $1
       AND m.rubs_submeter_rate = 'blended'
       AND rd.bill_amount IS NOT NULL
       AND rd.needs_review = FALSE
       AND rd.reading_value > 0
     LIMIT 1`, [unitId, utilityType, cycleIso])
  if (!row) return null
  return { rate: Number(row.bill_amount) / Number(row.reading_value), masterLabel: row.label }
}

/** S607: the rate a submetered unit on a master's line actually bills its
 *  consumption at — the same number the submeter branch will use, so the pool
 *  can subtract the DOLLARS that unit was charged instead of assuming a rate.
 *
 *  'blended' follows the master (dollars ÷ usage): everyone on the line pays an
 *  identical cost per unit and the pool carries no variance.
 *  'property_rate' (default) uses the rate the landlord published — Nic's penny
 *  a gallon for the mobile homes: the same number every month, checkable at the
 *  door, with the variance landing on the pool instead of the metered tenant.
 *
 *  Deliberately NOT capped by the prevailing-residential ceiling. Where that
 *  ceiling reduces a submetered tenant's bill, the shortfall is the landlord's
 *  to absorb — subtracting the uncapped amount keeps it off the neighbouring
 *  units, who did not cause it and cannot see it. */
async function submeterConsumptionRate(
  submeterId: string, blendedRate: number | null, mode: string,
): Promise<number> {
  if (mode === 'blended' && blendedRate != null) return blendedRate
  const sm = await queryOne<{ rate_per_unit: string | null; property_id: string; utility_type: string }>(
    `SELECT rate_per_unit, property_id, utility_type FROM utility_meters WHERE id = $1`, [submeterId])
  if (!sm) return 0
  const pr = await queryOne<{ rate_per_unit: string | null }>(
    `SELECT rate_per_unit FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`, [sm.property_id, sm.utility_type])
  return Number((pr?.rate_per_unit ?? sm.rate_per_unit) || 0)
}

/** S607: the statutory ceiling on what a SUBMETERED tenant may be charged per
 *  unit of usage — A.R.S. § 33-1413.01(B) for mobile home parks and
 *  § 33-2107(B)(3) for RV spaces both cap the landlord at "the prevailing basic
 *  service single family residential rate charged by the serving utility".
 *
 *  It bites specifically in blended mode: a park master usually sits on a bigger
 *  meter with a bigger service charge than a house, so dollars ÷ gallons can
 *  land above what a single-family customer pays for the same water.
 *
 *  NULL (not looked up yet) means no cap — this must never block a bill. Where
 *  it does apply the LANDLORD absorbs the difference; see the caller in the RUBS
 *  branch, which subtracts the uncapped amount from the pool so the shortfall is
 *  never quietly pushed onto the neighbouring spaces. */
async function prevailingRateCap(propertyId: string, utilityType: string): Promise<number | null> {
  const r = await queryOne<{ prevailing_residential_rate: string | null }>(
    `SELECT prevailing_residential_rate FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`, [propertyId, utilityType])
  const v = r?.prevailing_residential_rate
  return v == null ? null : Number(v)
}

/** S605: overlay the property's utility pricing onto a meter row, in place.
 *
 *  Mutates the row the billing math reads rather than threading a second rate
 *  through every branch — submeter, RUBS, flat-rate and the exclusion path all
 *  read `meter.rate_per_unit` / `base_fee` / `sewer_rate_per_unit`, and a policy
 *  that only reached some of them would be worse than none.
 *
 *  A property row with a NULL rate is treated as "not set for this utility" and
 *  leaves the meter's own value alone — configuring water must not silently zero
 *  out electric. */
async function applyPropertyRates(meter: any): Promise<void> {
  const pr = await queryOne<any>(
    `SELECT rate_per_unit, base_fee, sewer_rate_per_unit
       FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`,
    [meter.property_id, meter.utility_type])
  if (!pr) return
  if (pr.rate_per_unit != null) meter.rate_per_unit = pr.rate_per_unit
  if (pr.base_fee != null) meter.base_fee = pr.base_fee
  if (pr.sewer_rate_per_unit != null) meter.sewer_rate_per_unit = pr.sewer_rate_per_unit
}

/** S607: per-unit allocation basis for every supported RUBS split.
 *
 *  Returns one basis per unit; the caller divides each by their sum. A unit
 *  whose basis is 0 never bills and is counted as skipped, which is what keeps
 *  a vacancy (or a unit missing the data a basis needs) from silently absorbing
 *  someone else's share.
 *
 *  The menu is deliberately wider than any one state requires — Nic: "we need a
 *  wider window scope for available options, and we narrow it on our property
 *  setup." Nothing here decides what a landlord may use; it decides what they
 *  CAN use.
 *
 *  Config for the bases that need it lives on utility_meters.rubs_weights. */
async function allocationBases(
  method: string, weights: any, rubsUnits: any[], cycleIso: string,
): Promise<Array<{ unitId: string; basis: number }>> {
  const w = weights || {}

  /**
   * Headcount on a unit: active-lease tenants, or — when there is no lease yet
   * — the people INVITED to it.
   *
   * S629 (Nic): mid-onboarding a resident has been invited and has not signed,
   * so there is no lease, so an occupant_count split scored the unit zero and
   * dropped it from the pool. With 6 of 30 signed, those 6 split the water for
   * all 30. The people are living there and using the water; the paperwork is
   * what is outstanding, and the divisor should reflect the former.
   *
   * The invite roster gives the real number — this is not an assumed occupancy.
   * Their share is HELD rather than billed (see suspended_utility_charges) and
   * released onto their first invoice when they sign.
   */
  const occupants = async (unitId: string): Promise<number> => {
    const c = await queryOne<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM v_lease_active_tenants
       WHERE EXISTS (
         SELECT 1 FROM leases l
          WHERE l.id = v_lease_active_tenants.lease_id
            AND l.unit_id = $1 AND l.status = 'active')`, [unitId])
    const signed = Number(c?.count || 0)
    if (signed > 0) return signed
    const pending = await queryOne<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM pending_tenant_intents pti
       WHERE pti.unit_id = $1
         AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL`, [unitId])
    return Number(pending?.count || 0)
  }

  /** Is this space rented for the cycle? Measured the same way tryInsertBill
   *  attributes a bill — the lease covering the START of the cycle month — so a
   *  space that turned over mid-month counts once, not twice. */
  const isRented = async (unitId: string): Promise<boolean> => {
    const r = await queryOne<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM leases l
       WHERE l.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND l.start_date <= $2::date
         AND COALESCE(l.end_date, '9999-12-31'::date) > $2::date`, [unitId, cycleIso])
    return Number(r?.n || 0) > 0
  }

  const out: Array<{ unitId: string; basis: number }> = []
  for (const u of rubsUnits) {
    let basis = 0
    switch (method) {
      // An equal share per RENTED space — the only equal-split the platform
      // offers, because the naive version (every unit on the meter) hands a
      // VACANT space a full share that then finds no tenant and is never
      // billed, leaving the landlord to eat it. Also the basis the Arizona RV
      // statute names, which is why it exists in this shape.
      case 'rented_spaces':
        // S609: an owner-occupied space has no lease, so isRented() is false —
        // but unlike a VACANT space it is lived in and drawing water. It takes
        // a full share, which the landlord then absorbs rather than bills.
        //
        // S615: a UTILITY-SERVICE space is the same shape and was missed. It
        // has no lease either, so it scored 0 — and its consumption was then
        // divided among the paying tenants, who would have quietly covered the
        // neighbour's water. Unlike an owner-occupied space this one BILLS:
        // there is a payer on the agreement, so it takes its share and is
        // charged for it rather than absorbed.
        basis = (u.status === 'owner_use' || u.status === 'utility_service'
          || await isRented(u.unit_id)) ? 1 : 0
        break
      case 'sqft':
        basis = Number(u.sqft || 0)
        break
      case 'bedrooms':
        basis = Number(u.bedrooms || 0)
        break
      // S609: an owner-occupied unit has NO LEASE, so there are no tenants to
      // count — it would score 0 and its usage would land on the paying
      // tenants instead. The landlord states the household size; it is a real
      // occupied home and never counts as nobody.
      // S615: a serviced space has no lease tenants to count either, for the
      // same structural reason. Both read the landlord-stated household size —
      // the column is named for the case that introduced it, but what it holds
      // is "how many people live in a space with no lease to count from",
      // which is exactly as true next door as it is for an owner.
      case 'occupant_count':
        basis = (u.status === 'owner_use' || u.status === 'utility_service')
          ? Math.max(1, Number(u.owner_household_size || 1))
          : await occupants(u.unit_id)
        break
      // Per plumbing fixture — an old and still widespread water basis, on the
      // theory that fixtures proxy draw better than floor area. A unit with no
      // count recorded contributes 0 and is reported as skipped rather than
      // quietly taking a share it has no basis for.
      case 'fixture_count':
        basis = Number(u.water_fixture_count || 0)
        break
      // Landlord-set weight per unit type, so a park can say a mobile home draws
      // 1.5× an RV spot without inventing square footage for either.
      case 'unit_type_weight':
        // S615: same omission as rented_spaces above — a lease-less but
        // occupied space scored 0 and pushed its draw onto the tenants.
        basis = (u.status === 'owner_use' || u.status === 'utility_service'
          || await isRented(u.unit_id)) ? Number(w[u.unit_type] || 0) : 0
        break
      default:
        basis = 0
    }
    out.push({ unitId: u.unit_id, basis })
  }

  // A percentage blend of two other bases (50% sq ft + 50% occupancy is the
  // common third-party RUBS split). Each side is normalised to shares FIRST, so
  // the blend is of proportions rather than of raw numbers — otherwise square
  // footage, being in the hundreds, would swamp a headcount in the ones.
  // The result already sums to 1, which the caller's divide handles unchanged.
  if (method === 'hybrid') {
    const primary   = String(w.primary || 'sqft')
    const secondary = String(w.secondary || 'occupant_count')
    const pct = Math.min(100, Math.max(0, w.primaryPct != null ? Number(w.primaryPct) : 50)) / 100
    // Guard against a config that points at itself — that would recurse forever.
    if (primary === 'hybrid' || secondary === 'hybrid') return out
    const a = await allocationBases(primary, w, rubsUnits, cycleIso)
    const b = await allocationBases(secondary, w, rubsUnits, cycleIso)
    const sumA = a.reduce((s, x) => s + x.basis, 0)
    const sumB = b.reduce((s, x) => s + x.basis, 0)
    return a.map((x, i) => ({
      unitId: x.unitId,
      basis: (sumA > 0 ? pct * (x.basis / sumA) : 0)
           + (sumB > 0 ? (1 - pct) * (b[i].basis / sumB) : 0),
    }))
  }

  return out
}

export async function generateBillsForMeter(
  meterId: string,
  cycleMonth: Date,  // 1st of month
): Promise<GenerateBillsResult> {
  const cycleIso = isoMonthStart(cycleMonth)

  const meter = await queryOne<any>(
    `SELECT * FROM utility_meters WHERE id = $1`, [meterId])
  if (!meter) throw new AppError(404, 'Meter not found')

  // S605 (Nic, DIRECTIVE): "make utility rates set at the property level. adding
  // each unit is redundant and possible discrimination."
  //
  // Pricing is PROPERTY POLICY. Where the property sets a rate for this utility
  // it overrides whatever the meter carries, so every tenant at the property is
  // billed the same price for the same utility no matter who typed their unit
  // in. Same choke point as the S535 property-level late fees, for the same
  // reason.
  //
  // The meter columns remain the fallback for properties not yet configured, and
  // each utility_bills row still snapshots the rate it was charged at — so an
  // issued bill never changes because policy changed later.
  await applyPropertyRates(meter)

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
           u.unit_type, u.rv_amp_service, u.water_fixture_count,
           -- S613: how many of this service the unit takes (2 trash cans).
           -- Multiplies a FLAT charge only; usage already carries it elsewhere.
           mu.quantity,
           -- S609: an owner-occupied unit takes a real share of the pool that
           -- the LANDLORD absorbs, so the basis needs to know which units those
           -- are and how many people live in them.
           u.status, u.owner_household_size
      FROM utility_meter_units mu
      JOIN units u ON u.id = mu.unit_id
     WHERE mu.meter_id = $1
  `, [meterId])

  if (units.length === 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: 0,
      reason: 'meter not assigned to any units' }
  }

  /** S613 (Nic): "Say owner occupied has a trash can. Are we logging that?"
   *
   *  The owner-use absorption ledger existed only inside the RUBS split, so an
   *  owner-occupied unit on a FLAT charge or with its own SUBMETER produced
   *  nothing at all: tryInsertBill needs a tenant and a lease, an owner-occupied
   *  unit has neither, so the charge was dropped and counted as skipped. The
   *  landlord is still paying for that service — the can is still emptied, the
   *  meter still turns — and the audit answer ("billed out plus kept back equals
   *  what the property consumed") only reconciles if every method records it. */
  const recordOwnerUseAbsorption = async (args: {
    unitId: string; utilityType: string; chargeAmount: number
    allocationMethod: string; allocationBasis: number | null; baseFeeShare?: number; notes: string
  }) => {
    await query(`
      INSERT INTO utility_owner_use_absorptions
        (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
         allocation_method, allocation_basis, charge_amount, base_fee_share, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (meter_id, unit_id, billing_cycle_month) DO UPDATE
        SET charge_amount = EXCLUDED.charge_amount,
            allocation_basis = EXCLUDED.allocation_basis,
            base_fee_share = EXCLUDED.base_fee_share,
            updated_at = NOW()
    `, [meterId, args.unitId, landlordId, args.utilityType, cycleIso,
        args.allocationMethod, args.allocationBasis,
        args.chargeAmount.toFixed(2), (args.baseFeeShare ?? 0).toFixed(2), args.notes])
  }

  if (meter.billing_method === 'flat_rate') {
    // S558 (Nic): fixed per-unit charge with NO meter reading (e.g. a flat trash
    // buildback). Each served unit bills the flat amount as its own line item so
    // the tenant sees exactly what they pay for, instead of it being folded into
    // rent. Utility-neutral. tryInsertBill still gates on the per-unit
    // tenant_responsible flag.
    //
    // S609 (Nic, DIRECTIVE): THE AMOUNT COMES FROM THE PROPERTY, NOT THE METER.
    //
    //   "It's a discrimination thing. If you're billing a flat rate per unit, it
    //    needs to not be editable. It needs to be set at the property level the
    //    same way late fees are... anybody that's opted into it automatically
    //    gets the flat twenty five dollars."
    //
    // He is right, and this is the same rule that already governs processing
    // fees: a per-PROPERTY setting, never a per-unit one. A flat charge that
    // could be edited per meter is a mechanism for billing two identical units
    // two different amounts for the same service, which is exactly the shape of
    // a discrimination claim. Reading it from property_utility_rates makes
    // "everyone on this pays the same" structural rather than a matter of care.
    //
    // What stays per-unit is WHETHER the unit is on the meter at all — a
    // resident hauling their own trash is simply not assigned.
    const propertyRate = await queryOne<{ rate_per_unit: string }>(
      `SELECT rate_per_unit FROM property_utility_rates
        WHERE property_id = $1 AND utility_type = $2`,
      [meter.property_id, meter.utility_type])
    const flatAmount = Number(propertyRate?.rate_per_unit || 0)
    if (flatAmount <= 0) {
      return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
        reason: `no ${meter.utility_type} rate set for this property — set it on the Utilities page (Rates) and every unit on this meter bills that amount` }
    }
    let created = 0, skipped = 0
    for (const unit of units) {
      // S613: an owner-occupied unit on a flat charge — the landlord's own
      // household still has the trash can, and the service is still paid for.
      // Recorded, billed to nobody.
      // S613: everyone pays the same price per can; a unit with two cans pays
      // for two. The quantity rides the bill as its allocation basis so the
      // invoice line, and anyone auditing it later, can see WHY the amount is a
      // multiple of the property rate.
      const qty = Math.max(1, Number(unit.quantity ?? 1))
      const unitCharge = round2(flatAmount * qty)
      if (unit.status === 'owner_use') {
        await recordOwnerUseAbsorption({
          unitId: unit.unit_id, utilityType: meter.utility_type,
          chargeAmount: unitCharge, allocationMethod: 'flat_rate', allocationBasis: qty,
          baseFeeShare: unitCharge,
          notes: 'Owner-occupied unit — the flat charge for this service, absorbed by the landlord and billed to nobody.',
        })
        skipped++
        continue
      }
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: null,
        allocationMethod: 'flat_rate',
        allocationBasis: qty,
        ratePerUnit: flatAmount,
        baseFeeShare: unitCharge,
        chargeAmount: unitCharge,
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
    SELECT reading_value, is_rollover, needs_review, reading_date, created_at, bill_amount
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
      SELECT reading_value, reading_date
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
      !!cycleReading.is_rollover, meter.digits, Number(meter.reading_multiplier ?? 1))
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
      // S607: a submetered unit sitting under a `bill_amount` master bills its
      // MEASURED usage at that master's blended rate — the same cost per gallon
      // the pooled spaces on the same line pay. That is what makes the line
      // recover exactly the provider's bill: measured units take their true
      // share, the pool takes the rest.
      //
      // Blended mode substitutes the RATE and nothing else. Everything the
      // landlord layered on — base fee, sewer rate, tax rate — still applies on
      // top, because in this mode the provider's own charges are already inside
      // the dollar figure, so anything configured here is by definition the
      // LANDLORD'S OWN addition (the admin/margin lever every RUBS biller
      // charges). Zeroing them out, as this first did, silently removed that
      // lever from every landlord on the platform. GAM does not decide what a
      // landlord may charge — it bills what they configure. Nic: "we are not
      // enforcing legality... we offer the flexibility for all the different
      // options to be billed in all the ways that are common use."
      //
      // With those fields left at 0/unset — the common case, and Oak Park's —
      // the line recovers exactly the provider's bill and no more.
      //
      // The prevailing-residential cap applies only when the landlord has
      // recorded one. Unset = uncapped: an opt-in tool, never a gate.
      const blended = await blendedRateForUnit(unit.unit_id, meter.utility_type, cycleIso)
      const cap = blended ? await prevailingRateCap(meter.property_id, meter.utility_type) : null
      const effRate = blended
        ? (cap != null ? Math.min(blended.rate, cap) : blended.rate)
        : Number(meter.rate_per_unit || 0)
      const baseCharge = usage * effRate + Number(meter.base_fee || 0)
      const sewerCharge = usage * sewerRate
      const taxAmount = Math.round(baseCharge * taxRatePct + sewerCharge * sewerTaxRatePct) / 100
      const inserted = await tryInsertBill({
        meterId, unitId: unit.unit_id, landlordId,
        utilityType: meter.utility_type,
        cycleMonth: cycleIso,
        usageAmount: usage,
        allocationMethod: 'submeter',
        allocationBasis: null,
        ratePerUnit: effRate,
        baseFeeShare: Number(meter.base_fee || 0),
        chargeAmount: baseCharge + sewerCharge,
        taxRatePct,
        taxAmount,
        sewerRatePerUnit: sewerRate > 0 ? sewerRate : null,
        readingStart: Number(priorReading.reading_value),
        readingEnd: Number(cycleReading.reading_value),
        readingStartDate: priorReading.reading_date ?? null,
        readingEndDate: cycleReading.reading_date ?? null,
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
  // S607: a master total the entry guard doubts (an implausible jump against
  // the master's own history) must not price the pool. A submeter is held by
  // the same rule, but this one number bills EVERY unit the master feeds, and
  // the flagged-readings card is the only second look it ever gets — masters
  // are not in the blind verification walk. Holding here is also what keeps
  // the correction path working: bills generated off a suspect total would
  // survive the landlord's correction, because the per-cycle UNIQUE turns the
  // regenerate into a no-op. Resolving the flag re-runs this meter.
  if (cycleReading.needs_review) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'master usage total awaiting double-check — no bills until resolved' }
  }

  // S613: everything below is the RUBS path, and it used to be reached by
  // FALLING OFF the end of the submeter branch — "not master, not flat, not
  // submeter" was treated as RUBS. That is fine for the four methods that exist
  // and a trap for the fifth: any method added to the enum without its own
  // branch would silently start splitting a pool across units. Say it out loud
  // instead, so an unhandled method reports itself rather than billing.
  if (meter.billing_method !== 'rubs') {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `unsupported billing method "${meter.billing_method}" — nothing billed` }
  }

  const masterUsage = Number(cycleReading.reading_value)
  // S607 (Nic, DIRECTIVE): `bill_amount` masters divide the provider's ACTUAL
  // dollar charge instead of pricing usage at a rate we chose. Nic: "you're
  // allowed to take the total dollar value of the bill and divide it out, not
  // just the gallons usage — that way you're recouping the full cost of the
  // bill. On a bill with low gallon usage and then your base fee, you're not
  // recouping that." Resolved before the exclusion loop because the loop needs
  // the blended rate to price a submeter set to follow it.
  //
  // usage_rate masters (the default, and every existing master) fall through
  // completely unchanged.
  const billAmount = meter.rubs_basis === 'bill_amount' && cycleReading.bill_amount != null
    ? Number(cycleReading.bill_amount) : null
  const blendedRate = billAmount != null && masterUsage > 0 ? billAmount / masterUsage : null
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
  // S605 (Nic, DIRECTIVE): "we need to block the behavior that stops the bill
  // from going out for the master bill." One unread or flagged submeter used to
  // abort the ENTIRE property's water bill — the landlord simply didn't get
  // paid for water that month because somebody was on vacation. The exclusion
  // now always resolves to a number (estimated where it must be), so the master
  // always bills. Anything inferred is collected and reported so the landlord
  // knows which meters to chase, rather than the whole bill silently vanishing.
  const estimatedNotes: string[] = []
  // S607 (Nic, DIRECTIVE): the pool subtracts DOLLARS, not usage. Nic: "we set
  // the utility rate at a penny per gallon for submeter usage for water. We bill
  // the entire rate, and then we need to subtract not the usage from the pool
  // for the RUBS, but the remaining dollar amount. That way it still zeros out."
  //
  // Subtracting usage × the master's blended rate only closes when the submeters
  // are billed at that same blended rate. The moment they are billed at a
  // published rate instead — a predictable penny a gallon the tenant can check —
  // the arithmetic stops closing and the pool silently runs short or over.
  // Subtracting what those units were ACTUALLY charged for consumption always
  // closes, whatever rate each one paid.
  let excludedDollars = 0
  for (const s of subOnUnit) {
    const r = await submeterCycleUsageForExclusion(s.submeter_id, cycleIso)
    if (r.estimated) estimatedNotes.push(r.estimated)
    excludedUsage += r.usage
    excludedDollars += r.usage * await submeterConsumptionRate(
      s.submeter_id, blendedRate, meter.rubs_submeter_rate)
  }
  // S605: exclusions exceeding the master reading means a bad read somewhere,
  // but aborting is still the wrong response — it was the abort that lost the
  // landlord the whole bill. Clamp the pool at zero (the RUBS units are charged
  // nothing rather than a negative), bill the base fee, and report it loudly.
  if (excludedUsage > masterUsage) {
    estimatedNotes.push(
      `submetered usage (${excludedUsage}) exceeded the master reading (${masterUsage}) — check the readings`)
    excludedUsage = masterUsage
  }
  if (billAmount != null && excludedDollars > billAmount) {
    estimatedNotes.push(
      `submetered charges ($${excludedDollars.toFixed(2)}) exceeded the bill ($${billAmount.toFixed(2)}) — check the readings and the rate`)
    excludedDollars = billAmount
  }
  // Only the units WITHOUT their own submeter split the remaining pool.
  const rubsUnits = units.filter((u: any) => !excludedUnitIds.has(u.unit_id))
  const totalUsage = masterUsage - excludedUsage
  if (meter.rubs_basis === 'bill_amount' && billAmount == null) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: 'this master bills from the utility bill total, which has not been entered for this cycle' }
  }
  // S607 (Nic): "we need the entire bill to be able to input as a total dollar
  // amount." Usage is NOT required to divide a bill — an electric bill with peak
  // and off-peak tiers, demand charges and riders has no single usage×rate to
  // reconstruct, and forcing a usage figure to make the arithmetic work would be
  // asking the landlord to invent one.
  //
  // The one case that genuinely needs it: when submetered units sit on this line,
  // their share has to be carved out of the pool, and that carve-out is measured
  // in usage. With no submeters there is nothing to carve — the whole bill simply
  // divides across the units.
  if (billAmount != null && masterUsage <= 0 && subOnUnit.length > 0) {
    return { meterId, cycleMonth: cycleIso, billsCreated: 0, unitsSkipped: units.length,
      reason: `total usage is needed on this master — ${subOnUnit.length} submetered `
        + `unit${subOnUnit.length === 1 ? '' : 's'} on this line must be subtracted from the pool` }
  }
  // Blended mode substitutes the RATE only. A base fee configured here is the
  // LANDLORD'S own addition on top of the provider's bill — the admin/margin
  // lever RUBS billers normally charge — so it still applies. Left at 0 (the
  // common case, and Oak Park's) the pool recovers exactly the bill.
  const totalBaseFee = Number(meter.base_fee || 0)
  const ratePerUnit = blendedRate ?? Number(meter.rate_per_unit || 0)
  // S607: sewer rides the water MASTER exactly as it rides a water submeter
  // (S533) — there is no sewer meter in the field and the tenant sees one line
  // item. Without this, a park that submeters its mobile homes and RUBS-splits
  // its spots billed sewer on the mobile homes and silently dropped it on the
  // spots, off the same property water policy. Inert until a sewer rate is set.
  //
  // Both stay live in blended mode too. Anything configured here is the
  // landlord's own layer on top of the provider's bill, and GAM does not decide
  // which layers a landlord is allowed — it bills what they set up. Unset, as at
  // Oak Park, they contribute nothing and the pool is exactly the bill.
  //
  // Either way the tenant sees ONE line: every component collapses into a single
  // charge_amount. Nic: "that just needs to have a blended rate on the back end
  // to include any fee... that way it's not a separate line item."
  const sewerRate = meter.utility_type === 'water' ? Number(meter.sewer_rate_per_unit || 0) : 0
  const effTaxRatePct = taxRatePct
  const sewerTaxRatePct = sewerRate > 0
    ? Number((await queryOne<{ tax_rate_pct: string }>(`
        SELECT tax_rate_pct FROM property_utility_tax_rates
         WHERE property_id = $1 AND utility_type = 'sewer'
      `, [meter.property_id]))?.tax_rate_pct || 0)
    : 0
  // In blended mode the pool is DOLLARS: the whole bill, less what the submetered
  // units on this line bill at the same blended rate. When no usage was recorded
  // (bill-total-only, above) there is nothing to subtract and the pool is simply
  // the bill.
  // S607 (Nic, DIRECTIVE): the carve-out is the landlord's CHOICE.
  //   'usage'   — take the submetered units' measured usage off the top and
  //               price what is left. The long-standing behaviour, and the
  //               default, so no master changes shape without being told to.
  //   'dollars' — take off what those units were actually invoiced. Closes at
  //               any submeter rate, because it subtracts the invoices rather
  //               than re-deriving them from a rate they may not have used.
  // Identical whenever the submeters bill at the master's blended rate; they
  // diverge exactly when the landlord publishes a separate submeter rate.
  const totalWaterCharge = billAmount != null
    ? (blendedRate == null
        // Bill-total-only (no usage figure recorded). There is nothing to carve
        // out — the guard above refuses this shape when submetered units are on
        // the line — so the bill divides whole, whichever carve-out is selected.
        ? billAmount
        : meter.rubs_exclusion_mode === 'dollars'
          ? (billAmount - excludedDollars)
          : totalUsage * ratePerUnit) + totalBaseFee
    : totalUsage * ratePerUnit + totalBaseFee
  const totalSewerCharge = totalUsage * sewerRate
  const totalCharge = totalWaterCharge + totalSewerCharge

  // Compute per-unit basis, then divide.
  const unitBases = await allocationBases(
    meter.rubs_allocation_method, meter.rubs_weights, rubsUnits, cycleIso)

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
    const waterShare = round2(totalWaterCharge * share)
    const sewerShare = round2(totalSewerCharge * share)
    return {
      unitId:       ub.unitId,
      basis:        ub.basis,
      baseFeeShare: round2(totalBaseFee * share),
      chargeAmount: round2(waterShare + sewerShare),
      waterShare,
      sewerShare,
    }
  })
  let ownerUseWithheld = 0
  const residual = round2(totalCharge - alloc.reduce((s, a) => s + a.chargeAmount, 0))
  if (residual !== 0 && alloc.length > 0) {
    let lo = alloc[0]
    for (const a of alloc) if (a.chargeAmount < lo.chargeAmount) lo = a
    lo.chargeAmount = round2(lo.chargeAmount + residual)
  }
  // S609 (Nic, DIRECTIVE): the OWNER'S OWN SHARE IS WITHHELD, NOT BILLED.
  //
  // An owner-occupied unit now scores a real basis above, so it takes a genuine
  // slice of the pool — which is the point: the tenants' shares no longer add up
  // to the whole bill, so they stop paying for the owner's water. That slice is
  // simply not charged to anyone. The landlord already paid the utility company;
  // this is the part they don't get back.
  //
  // It is RECORDED rather than quietly dropped. Nic: "We need that as a line
  // item on a specific utility cost that's owner use that is not passed through.
  // That way, if there's ever an audit, the landlord can provide, hey, these
  // utilities were not factored into being billed back to people."
  //
  // A bill row with status 'owner_use' and no tenant or lease is exactly that
  // record: it sits in the same ledger as every other bill for the cycle, so
  // "the master's pool, less what was billed out" reconciles to it. It carries
  // no payment and is never invoiced — nothing collects a bill that has no
  // tenant on it.
  const ownerUnitIds = new Set(
    rubsUnits.filter((u: any) => u.status === 'owner_use').map((u: any) => u.unit_id))
  for (const a of alloc) {
    if (ownerUnitIds.has(a.unitId)) {
      // Recorded in its own ledger rather than as a bill: utility_bills requires
      // a tenant and a lease (every bill has a payer, which is an invariant
      // worth keeping), and an owner-occupied unit has neither. Re-runnable —
      // the unique index makes a repeated cycle a no-op, same as tryInsertBill.
      await query(`
        INSERT INTO utility_owner_use_absorptions
          (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
           allocation_method, allocation_basis, charge_amount, base_fee_share, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (meter_id, unit_id, billing_cycle_month) DO UPDATE
          SET charge_amount   = EXCLUDED.charge_amount,
              allocation_basis = EXCLUDED.allocation_basis,
              base_fee_share  = EXCLUDED.base_fee_share,
              updated_at      = NOW()
      `, [
        meterId, a.unitId, landlordId, meter.utility_type, cycleIso,
        meter.rubs_allocation_method, a.basis,
        a.chargeAmount.toFixed(2), a.baseFeeShare.toFixed(2),
        'Owner-occupied unit — its share of the pool, absorbed by the landlord and billed to nobody.',
      ])
      ownerUseWithheld = round2(ownerUseWithheld + a.chargeAmount)
      continue
    }
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
      taxRatePct: effTaxRatePct,
      // Each portion taxed at its own type's landlord rate, as on a submeter
      // bill. With no sewer rate configured this is left undefined so
      // tryInsertBill keeps computing tax off the final (post-residual)
      // charge exactly as before — no sewer, no behaviour change.
      ...(sewerRate > 0
        ? { taxAmount: Math.round(a.waterShare * effTaxRatePct + a.sewerShare * sewerTaxRatePct) / 100,
            sewerRatePerUnit: sewerRate }
        : {}),
      // The dates both statutes require alongside the readings. A pooled space
      // has no meter of its own; the master's cycle read dates the period.
      readingEndDate: cycleReading.reading_date ?? null,
    })
    if (inserted) billsCreated++
    else unitsSkipped++
  }

  if (billsCreated > 0) await invoiceEndedLeaseBills(meterId, cycleIso)
  // S605: the bill went out either way — say plainly what had to be inferred so
  // the landlord can read those meters and correct next cycle. Silence here was
  // the old failure in a new costume.
  return {
    meterId, cycleMonth: cycleIso, billsCreated, unitsSkipped,
    ...(estimatedNotes.length
      ? { reason: `Billed with estimated submeter usage — ${estimatedNotes.join('; ')}. Read these meters and correct next cycle.` }
      : {}),
  }
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
  // S605: a move-out bill is priced by the same property policy as every other
  // bill — a departing tenant must not be charged a different rate than the one
  // moving in behind them.
  await applyPropertyRates(meter)
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
  const usage = cycleUsageFromReadings(cur, priorVal, isRollover, digits,
    Number(meter.reading_multiplier ?? 1))

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

/**
 * Does the tenant owe this utility?
 *
 * S629 DIRECTIVE (Nic): "the lease can't be the only source of charges in the
 * system... bill it off of the fact that we set our different submeters and
 * utilities per unit. And when there's an active lease on that unit, you bill
 * at the rate from that unit or from that property."
 *
 * The unit's utility configuration governs, because the printed lease goes
 * stale and the physical arrangement does not. Oak Park's apartment lease §10
 * still reads "Landlord shall pay for water and sewer and for trash pickup",
 * written when trash was a shared RUBS dumpster; people from around town began
 * dumping furniture in it, so the park moved to per-can billing and the
 * apartment now pays for water and trash. The meter setup is current, the
 * clause is not.
 *
 * A tagged utility field on a lease still wins where one exists, because that
 * is somebody deliberately saying otherwise about that specific lease. No Oak
 * Park template tags one, so configuration decides there — which is the point.
 * Before this, the absent row was read as "landlord pays" and silently zeroed
 * out utility billing for the entire property.
 */
async function tenantOwesUtility(
  leaseId: string | null, utilityType: string, meterId: string,
): Promise<boolean> {
  if (leaseId) {
    const resp = await queryOne<{ tenant_responsible: boolean }>(`
      SELECT tenant_responsible FROM lease_utility_responsibilities
       WHERE lease_id = $1 AND utility_type = $2`, [leaseId, utilityType])
    if (resp) return !!resp.tenant_responsible   // the lease spoke
  }
  const m = await queryOne<{ billing_method: string }>(
    `SELECT billing_method FROM utility_meters WHERE id = $1`, [meterId])
  return !!m && m.billing_method !== 'master_bill_to_landlord'
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
  /** S607: the DATES of those reads. Not decoration — A.R.S. § 33-1413.01(A)
   *  and § 33-1314.01(E)(1) both require each utility bill to show the opening
   *  and closing readings *and the dates they were taken*. We snapshotted the
   *  readings and dropped the dates, so no bill we produced was compliant on
   *  its face. A pooled RUBS space has no reads of its own but still carries the
   *  master's closing date, which is what dates its billing period. */
  readingStartDate?: string | Date | null
  readingEndDate?: string | Date | null
}

// Returns true if a bill was inserted, false if skipped (unit not occupied,
// tenant not responsible for this utility type, or bill already exists).

/**
 * S629: hold a utility share for a unit whose residents are invited but have
 * not signed. Returns true when the share was held, false when the unit is
 * genuinely unoccupied and the landlord absorbs it as before.
 *
 * Idempotent through the partial unique index — the billing engine is
 * re-runnable by design, so a second run for the same cycle must not hold the
 * same share twice.
 */
async function holdChargeForPendingUnit(args: InsertBillArgs): Promise<boolean> {
  const pending = await queryOne<{ n: string; landlord_id: string }>(`
    SELECT COUNT(pti.id)::text AS n, u.landlord_id
      FROM units u
      LEFT JOIN pending_tenant_intents pti
        ON pti.unit_id = u.id AND pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
     WHERE u.id = $1
     GROUP BY u.landlord_id`, [args.unitId])
  if (!pending || Number(pending.n) === 0) return false

  try {
    await query(`
      INSERT INTO suspended_utility_charges
        (meter_id, unit_id, landlord_id, billing_cycle_month, utility_type,
         usage_amount, allocation_method, allocation_basis, rate_per_unit,
         base_fee_share, charge_amount, tax_rate_pct, tax_amount,
         sewer_rate_per_unit, reading_start, reading_end,
         reading_start_date, reading_end_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT DO NOTHING`,
      [args.meterId, args.unitId, pending.landlord_id, args.cycleMonth, args.utilityType,
       args.usageAmount ?? null, args.allocationMethod ?? null, args.allocationBasis ?? null,
       args.ratePerUnit ?? null, args.baseFeeShare ?? 0, args.chargeAmount,
       args.taxRatePct ?? null, args.taxAmount ?? null, args.sewerRatePerUnit ?? null,
       args.readingStart ?? null, args.readingEnd ?? null,
       args.readingStartDate ?? null, args.readingEndDate ?? null,
       'Held: invited, lease not signed yet. Bills with their first invoice.'])
    logger.info({ unitId: args.unitId, meterId: args.meterId, cycle: args.cycleMonth,
                  amount: args.chargeAmount },
      'utility billing: share held for a unit whose residents have not signed yet')
    return true
  } catch (e) {
    logger.error({ err: e, unitId: args.unitId }, 'utility billing: could not hold pending share')
    return false
  }
}

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
  // S629 ORDER HAZARD (Nic, launch): the residents signed BEFORE this cycle was
  // billed. Their lease starts next month, so nothing above covers the cycle,
  // and their invite is resolved, so there is no longer an invite to hold
  // against — the share would be silently absorbed by the landlord.
  //
  // They were living there and using it. `occupants` already counted them into
  // the divisor on the strength of the invite, so their neighbours were split
  // correctly against a share that has to land somewhere; this is where it
  // lands. The invite is the evidence of residence, which is why the same
  // "invited before the cycle ended" test used by `occupants` gates it here —
  // it will not reach back and bill a genuinely new arrival for a month they
  // had nothing to do with.
  if (!lt) {
    lt = await queryOne<{ lease_id: string; tenant_id: string }>(`
      SELECT l.id AS lease_id, lt2.tenant_id
        FROM leases l
        JOIN lease_tenants lt2 ON lt2.lease_id = l.id AND lt2.role = 'primary'
       WHERE l.unit_id = $1
         AND l.status IN ('active', 'expired', 'terminated')
         AND l.start_date >= ($2::date + interval '1 month')::date
         AND EXISTS (
           SELECT 1 FROM pending_tenant_intents pti
            WHERE pti.unit_id = l.unit_id
              AND pti.cancelled_at IS NULL
              AND pti.created_at < ($2::date + interval '1 month')::date)
       ORDER BY l.start_date ASC
       LIMIT 1
    `, [args.unitId, args.cycleMonth])
  }

  // S614 (Nic, LAUNCH): a space this landlord SERVICES but does not lease — the
  // apartment and the three trash cans next door. No lease will ever exist for
  // it, so the payer comes from a utility service agreement instead.
  //
  // There is no lease-responsibility gate here, and there cannot be: that gate
  // asks "does the signed lease pass this utility through", and the whole point
  // of a service agreement is that utilities are the ONLY thing owed. Agreeing
  // to the service IS the responsibility.
  let serviceAgreementId: string | null = null
  if (!lt) {
    const sa = await queryOne<{ id: string; tenant_id: string }>(`
      SELECT id, tenant_id FROM utility_service_agreements
       WHERE unit_id = $1 AND status = 'active'
         AND start_date <= ($2::date + interval '1 month' - interval '1 day')
         AND (end_date IS NULL OR end_date >= $2::date)
       LIMIT 1`, [args.unitId, args.cycleMonth])
    if (!sa) {
      // S629: no lease and no service agreement. If the unit has people INVITED
      // to it, this is onboarding rather than a vacancy — they are living there
      // and using the utility, and their share was counted into the split by
      // `occupants`. Hold it; the release runs when their lease is signed.
      //
      // Held rather than billed because there is no invoice to carry it: no due
      // date, no late fee, and no debt recorded against somebody who has not
      // signed anything. Anything genuinely vacant still falls through to the
      // landlord absorbing it, exactly as before.
      // Held, then reported as NOT billed: the caller counts a `true` as a bill
      // created, and a held share is precisely the absence of one. It shows up
      // in unitsSkipped, which is accurate — the unit was skipped for billing
      // and its share is waiting on a signature.
      await holdChargeForPendingUnit(args)
      return false
    }
    serviceAgreementId = sa.id
    lt = { lease_id: null as any, tenant_id: sa.tenant_id }
  } else {
    // Tenant responsibility gate — leases only. See the S610 handoff §1a.
    if (!await tenantOwesUtility(lt.lease_id, args.utilityType, args.meterId)) return false
  }

  try {
    await query(`
      INSERT INTO utility_bills
        (meter_id, unit_id, tenant_id, lease_id, landlord_id,
         billing_cycle_month, usage_amount, allocation_method,
         allocation_basis, rate_per_unit, base_fee_share, charge_amount,
         tax_rate_pct, tax_amount, utility_type, sewer_rate_per_unit,
         reading_start, reading_end, reading_start_date, reading_end_date,
         service_agreement_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
      args.readingStartDate ?? null,
      args.readingEndDate ?? null,
      serviceAgreementId,
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

  // S607 (Nic): FLAT-RATE meters bill here too, and did not before.
  //
  // Nic: "did we ever add trash as an item? We just do that at a flat rate per
  // household because they have individual cans."
  //
  // Trash exists as a utility type and flat_rate is exactly that fixed
  // per-household charge — but this function, which is the PRIMARY billing path
  // since S534, selected only submeter/rubs meters AND required a
  // utility_meter_readings row. A flat-rate meter has neither: no reading, by
  // design. So trash only billed when a reading RUN completed
  // (generateBillsForProperty sweeps every meter), which produced two failures:
  //
  //   1. A property with ONLY a flat-rate meter never opens a reading run at all
  //      (openReadingRun requires a readable meter), so its trash NEVER billed.
  //   2. At a property like Oak Park, one unread water meter left the run open
  //      and took the trash charge down with it — even though trash needs no
  //      reading whatsoever. That is precisely the coupling S534 exists to
  //      prevent: "one unread meter elsewhere never holds a unit's charges."
  //
  // Cycle is the invoice's own month; there is no reading to date it from.
  const flat = await query<{ meter_id: string; cycle: string }>(`
    SELECT m.id AS meter_id, to_char(date_trunc('month', $2::date), 'YYYY-MM-DD') AS cycle
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id AND m.billing_method = 'flat_rate'
     WHERE mu.unit_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM utility_bills ub
          WHERE ub.meter_id = m.id
            AND ub.unit_id = mu.unit_id
            AND ub.billing_cycle_month = date_trunc('month', $2::date)::date)
  `, [unitId, throughDate])

  let created = 0
  for (const p of [...pending, ...flat]) {
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


/** YYYY-MM for a cycle, whether it arrives as a Date or a string. */
function cycleLabel(cycle: unknown): string {
  if (cycle instanceof Date) return cycle.toISOString().slice(0, 7)
  return String(cycle).slice(0, 7)
}

/**
 * S629: release every held utility share for a unit onto the tenant who has
 * just signed.
 *
 * The counterpart to holdChargeForPendingUnit. Their share was counted into the
 * RUBS split at the time — so the other residents were charged correctly — and
 * parked with no invoice behind it. Signing is what gives it somewhere to go.
 *
 * Called after a lease is created from a signed document. Best-effort and
 * idempotent: a held row becomes exactly one bill, and a row that fails stays
 * held rather than vanishing, so nothing is silently written off.
 */
export async function releaseSuspendedChargesForLease(args: {
  unitId: string; leaseId: string; tenantId: string; landlordId: string
}): Promise<{ released: number; amount: number }> {
  const held = await query<any>(`
    SELECT * FROM suspended_utility_charges
     WHERE unit_id = $1 AND released_at IS NULL AND cancelled_at IS NULL
     ORDER BY billing_cycle_month`, [args.unitId])
  let released = 0
  let amount = 0
  for (const h of held) {
    try {
      // Lease is law. The share was held before there was a lease to consult,
      // so this is the first moment the terms can be applied — and if the
      // signed lease does not pass this utility through, the tenant never owed
      // it. Cancel the hold (kept, with a reason) instead of billing it.
      if (!await tenantOwesUtility(args.leaseId, h.utility_type, h.meter_id)) {
        await query(`
          UPDATE suspended_utility_charges
             SET cancelled_at = now(), updated_at = now(),
                 notes = COALESCE(notes,'') ||
                   ' — not billed: neither the lease nor the meter makes the tenant responsible for '
                   || $2
           WHERE id = $1`, [h.id, h.utility_type])
        logger.info({ suspendedId: h.id, unitId: args.unitId, utility: h.utility_type },
          'utility billing: held share dropped — this utility is not passed through to the tenant')
        continue
      }
      const bill = await queryOne<{ id: string }>(`
        INSERT INTO utility_bills
          (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
           usage_amount, allocation_method, allocation_basis, rate_per_unit,
           base_fee_share, charge_amount, tax_rate_pct, tax_amount, utility_type,
           sewer_rate_per_unit, reading_start, reading_end,
           reading_start_date, reading_end_date, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [h.meter_id, h.unit_id, args.tenantId, args.leaseId, args.landlordId,
         h.billing_cycle_month, h.usage_amount, h.allocation_method, h.allocation_basis,
         h.rate_per_unit, h.base_fee_share, h.charge_amount,
         // utility_bills requires both tax columns; a held row may carry
         // neither (an untaxed utility), and 0 is the honest value for "no tax
         // was charged" — NULL would fail the constraint and strand the share.
         h.tax_rate_pct ?? 0, h.tax_amount ?? 0,
         h.utility_type, h.sewer_rate_per_unit, h.reading_start, h.reading_end,
         h.reading_start_date, h.reading_end_date,
         `Utility used before the lease was signed (${cycleLabel(h.billing_cycle_month)}).`])
      // A conflict means the cycle already has a bill for this unit — the share
      // is accounted for, so stop holding it rather than leaving it to re-run.
      await query(
        `UPDATE suspended_utility_charges
            SET released_at = now(), released_bill_id = $2, updated_at = now()
          WHERE id = $1`, [h.id, bill?.id ?? null])
      if (bill?.id) { released++; amount += Number(h.charge_amount) }
    } catch (e) {
      logger.error({ err: e, suspendedId: h.id, unitId: args.unitId },
        'utility billing: could not release a held share — left held')
    }
  }
  if (released > 0) {
    logger.info({ unitId: args.unitId, leaseId: args.leaseId, released, amount },
      'utility billing: held shares released onto the new lease')
  }
  return { released, amount }
}
