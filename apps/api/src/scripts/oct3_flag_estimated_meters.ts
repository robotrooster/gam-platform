/**
 * 10/3 final sweep — run once at the deploy that ships "an estimated meter is
 * still a broken meter" (services/utilityBilling).
 *
 * At a property that estimates a meter that is not reading, the estimate used
 * to be the whole answer: the meter was never marked broken and nobody was
 * asked to fix it. Mountain View RV 07, 08, 40 and 48 were billed the $22.47
 * estimate for September that way. From the deploy on, the bill run marks such
 * a meter broken the moment it estimates it; this does the same for the meters
 * already being estimated, so they show for repair now instead of after
 * October's reads.
 *
 * Picks: a submeter, not marked broken, whose newest bill is an estimate
 * (comparable_low), on a space with a current lease that is NOT paused (a hibernating
 * household explains a meter that did not move — RV 50/51 are left alone).
 * Never Oak Park MH 09 (decisions #18). Marks each broken and tells the
 * landlord once, with what is billed in its place (flagBrokenMeter). Changes
 * no bill.
 *
 * DRY=1 (the default) prints what would be marked and changes nothing:
 *   DRY=1 node -r ts-node/register src/scripts/oct3_flag_estimated_meters.ts
 *   DRY=0 node -r ts-node/register src/scripts/oct3_flag_estimated_meters.ts
 */
import { query } from '../db'
import { flagBrokenMeter } from '../services/utilityBilling'
import { UTILITY_UNIT_LABEL, type UtilityType } from '@gam/shared'

async function main() {
  const dryRun = process.env.DRY !== '0'
  const meters = await query<{
    meter_id: string; property: string; unit_number: string; utility_type: string; usage: string; cycle: string
    allocation_method: string
  }>(
    `SELECT DISTINCT ON (m.id) m.id AS meter_id, p.name AS property, u.unit_number, m.utility_type,
            ub.usage_amount::text AS usage, to_char(ub.billing_cycle_month, 'YYYY-MM') AS cycle,
            ub.allocation_method
       FROM utility_meters m
       JOIN properties p ON p.id = m.property_id
       JOIN utility_meter_units mu ON mu.meter_id = m.id
       JOIN units u ON u.id = mu.unit_id
       -- Every bill, voided ones too: the newest decides (Mountain View RV 34's
       -- August estimate was followed by a voided September read — the
       -- household moved to RV 33 — so it is not marked).
       JOIN utility_bills ub ON ub.meter_id = m.id AND ub.unit_id = u.id
      WHERE m.billing_method = 'submeter' AND m.out_of_service = FALSE
        AND p.estimates_stuck_meters = TRUE
        AND NOT (p.name ILIKE 'Oak Park%' AND u.unit_number = 'MH 09')
        -- Somebody lives there now, and is not away.
        AND EXISTS (SELECT 1 FROM leases l
                     WHERE l.unit_id = u.id AND l.status IN ('active', 'delinquent', 'suspended'))
        AND NOT EXISTS (SELECT 1 FROM leases l
                         WHERE l.unit_id = u.id AND COALESCE(l.is_hibernating, FALSE)
                           AND l.status IN ('active', 'delinquent', 'suspended'))
      ORDER BY m.id, ub.billing_cycle_month DESC, ub.created_at DESC`)
  // The NEWEST bill per meter decides: one estimated last month but read since is working again.
  const estimated = meters.filter(m => m.allocation_method === 'comparable_low')
  for (const m of estimated) {
    console.log(`${dryRun ? 'WOULD MARK BROKEN' : 'MARKED BROKEN'} ${m.property} ${m.unit_number} ${m.utility_type} `
      + `(${m.cycle} billed as an estimate of ${Number(m.usage)}) — meter ${m.meter_id}`)
    if (!dryRun) {
      await flagBrokenMeter(m.meter_id, { estimate: {
        usage: Number(m.usage), unitLabel: UTILITY_UNIT_LABEL[m.utility_type as UtilityType] ?? '' } })
    }
  }
  console.log(`${dryRun ? 'DRY RUN — nothing changed.' : 'Done.'} ${estimated.length} meter(s).`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
