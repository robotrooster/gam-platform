/**
 * S654 (2026-10-01) — Country Acres: Blu bills the three lots with no water
 * read this month at one unit.
 *
 * Nic: "Blu wants to bill the three broken meters for Country Acres so that
 * they get a $16.50 charge… a one unit deal." On Blu's sheet one unit is 1,000
 * gallons; at this property's $0.0165/gal that is $16.50. Lots 22 and 24 are
 * out of service (same read three months running); lot 18's 9/30 read was its
 * first real one, so it had nothing to bill against. Curtis is fixing the
 * meters next; the next real read bills real gallons.
 *
 * Writes one September water bill per lot (estimated, no readings — the meter
 * history is untouched), puts the line on the lot's open October invoice, and
 * raises the invoice total. Field shape cloned from a real September bill at
 * the same property so nothing is invented.
 *
 * DRY=1 prints the plan and rolls back. Run from apps/api:
 *   DRY=1 node -r ts-node/register src/scripts/oct1_country_acres_water_estimates.ts
 */
import { getClient } from '../db'

const GALLONS = 1000
const NOTE_BILL = "Estimated at the landlord's direction — meter not reading; 1,000 gal (one unit) at $0.0165/gal"
const NOTE_LINE = 'Water — Sep 2026 · 1,000 gal estimated (meter not reading)'
const LOTS = ['MH 18', 'MH 22', 'MH 24']

;(async () => {
  const dry = process.env.DRY === '1'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    for (const lot of LOTS) {
      const { rows } = await c.query<any>(
        `SELECT u.id AS unit_id, us.last_name, m.id AS meter_id, m.rate_per_unit, l.id AS lease_id, t.id AS tenant_id,
                p.landlord_id, i.id AS invoice_id, i.invoice_number, i.total_amount, i.subtotal_utilities,
                (SELECT count(*) FROM utility_bills b WHERE b.unit_id = u.id AND b.billing_cycle_month = '2026-09-01'
                    AND b.utility_type = 'water' AND b.status <> 'void') AS existing
           FROM units u JOIN properties p ON p.id = u.property_id
           JOIN utility_meter_units mu ON mu.unit_id = u.id
           JOIN utility_meters m ON m.id = mu.meter_id AND m.utility_type = 'water'
           JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
           JOIN v_lease_active_tenants v ON v.lease_id = l.id AND v.role = 'primary'
           JOIN tenants t ON t.id = v.tenant_id JOIN users us ON us.id = t.user_id
           JOIN invoices i ON i.lease_id = l.id AND i.due_date = '2026-10-01' AND i.status IN ('pending','partial')
          WHERE p.name ILIKE 'Country Acres%' AND u.unit_number = $1`, [lot])
      if (rows.length !== 1) { console.log(`${lot}: expected one lease/meter/invoice, found ${rows.length} — skipped`); continue }
      const r = rows[0]
      if (Number(r.existing) > 0) { console.log(`${lot}: already has a September water bill — skipped`); continue }
      const charge = Math.round(GALLONS * Number(r.rate_per_unit) * 100) / 100
      const bill = await c.query<{ id: string }>(
        `INSERT INTO utility_bills
           (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, usage_amount,
            allocation_method, allocation_basis, rate_per_unit, base_fee_share, charge_amount,
            tax_rate_pct, tax_amount, status, utility_type, notes, billed_at)
         SELECT $1, $2, $3, $4, $5, '2026-09-01', $6,
                tpl.allocation_method, tpl.allocation_basis, $7, tpl.base_fee_share, $8,
                tpl.tax_rate_pct, 0, 'billed', 'water', $9, NOW()
           FROM utility_bills tpl
           JOIN units tu ON tu.id = tpl.unit_id
          WHERE tu.unit_number = 'MH 30' AND tpl.billing_cycle_month = '2026-09-01' AND tpl.utility_type = 'water'
            AND tu.property_id = (SELECT property_id FROM units WHERE id = $2)
          LIMIT 1
         RETURNING id`,
        [r.meter_id, r.unit_id, r.tenant_id, r.lease_id, r.landlord_id, GALLONS, r.rate_per_unit, charge.toFixed(2), NOTE_BILL])
      if (!bill.rows.length) { console.log(`${lot}: no template bill to clone — skipped`); continue }
      const pay = await c.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               due_date, entry_description, notes)
         VALUES ($1, $2, $3, $4, $5, 'utility', $6, 'pending', '2026-10-01', 'UTILITY', $7) RETURNING id`,
        [r.invoice_id, r.unit_id, r.lease_id, r.tenant_id, r.landlord_id, charge.toFixed(2), NOTE_LINE])
      await c.query(`UPDATE utility_bills SET payment_id = $1 WHERE id = $2`, [pay.rows[0].id, bill.rows[0].id])
      await c.query(
        `UPDATE invoices SET subtotal_utilities = subtotal_utilities + $2, total_amount = total_amount + $2, updated_at = NOW()
          WHERE id = $1`, [r.invoice_id, charge.toFixed(2)])
      console.log(`${lot} ${r.last_name}: water ${GALLONS} gal → $${charge.toFixed(2)} on ${r.invoice_number}: $${r.total_amount} → $${(Number(r.total_amount) + charge).toFixed(2)}`)
    }
    if (dry) { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back') }
    else { await c.query('COMMIT'); console.log('COMMITTED') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error(e)
    process.exit(1)
  } finally {
    c.release()
    process.exit(0)
  }
})()
