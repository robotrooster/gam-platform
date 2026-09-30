// S652 one-off: the Alvarados were entered on RV 34 but live on RV 33. Their
// September electric is RV 33's; bill it so it rides the October 1 invoice.
import { query, queryOne } from '../../db'
import { generateBillsForMeter } from '../../services/utilityBilling'
async function main() {
  const m = await queryOne<any>(`SELECT m.id FROM utility_meters m JOIN utility_meter_units mu ON mu.meter_id=m.id WHERE mu.unit_id='9f24b490-1cf9-4305-a6d4-2bdb860ee8d1' AND m.billing_method='submeter'`)
  const r = await generateBillsForMeter(m.id, new Date('2026-09-01T00:00:00Z'))
  console.log('engine:', JSON.stringify(r))
  await query(`UPDATE utility_bills SET status='billed', billed_at=NOW(), updated_at=NOW() WHERE meter_id=$1 AND billing_cycle_month='2026-09-01' AND status='unbilled'`, [m.id])
  const rows = await query<any>(`SELECT u.unit_number, ub.usage_amount, ub.charge_amount, ub.status, ub.reading_start, ub.reading_end, us.last_name FROM utility_bills ub JOIN units u ON u.id=ub.unit_id JOIN tenants t ON t.id=ub.tenant_id JOIN users us ON us.id=t.user_id WHERE ub.meter_id=$1 AND ub.billing_cycle_month='2026-09-01'`, [m.id])
  console.log(rows)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
