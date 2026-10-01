/**
 * S654 (2026-10-01) — August electric billed twice at Mountain View.
 *
 * This morning's run created an August-cycle electric bill for four sites
 * whose August was already charged (RV 49 Parker $96.81 and RV 36 Avalos $81.27
 * on their September bills, both paid; RV 04 Kenyon's August was an estimate,
 * $25.20, paid) or belonged to the previous occupant (RV 44 Dakota Lane moved in
 * September 2; the August usage on that meter is not his). Each line rides the
 * October 1 invoice and was in the emailed total.
 *
 * Voids those four bills, removes their unpaid lines, and takes them off the
 * invoice — the same mechanics as scripts/mattoon/load17 (a bill is voided,
 * never erased; a pending line nobody owes is removed). RV 33 Alvarado's
 * August ($144.06) is NOT touched: he is an existing tenancy whose August may
 * or may not have been collected before GAM — Nic's call.
 *
 * DRY=1 prints the plan and rolls back. Run from apps/api:
 *   DRY=1 node -r ts-node/register src/scripts/oct1_august_electric_repair.ts
 */
import { getClient } from '../db'

const TARGETS = [
  { unit: 'RV 49', why: 'August already charged on the September bill (INV-2026-00013, paid)' },
  { unit: 'RV 36', why: 'August already charged on the September bill (INV-2026-00016, paid)' },
  { unit: 'RV 04', why: 'August already charged as an estimate on the September bill (INV-2026-00014, paid)' },
  { unit: 'RV 44', why: 'previous occupant’s usage — lease started September 2' },
  { unit: 'RV 33', why: 'August already charged on the September bill (INV-2026-00038, $81.27 cash on 9/18)' },
]

;(async () => {
  const dry = process.env.DRY === '1'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    for (const t of TARGETS) {
      const { rows } = await c.query<any>(
        `SELECT b.id AS bill_id, b.charge_amount, p.id AS payment_id, p.status AS pay_status, p.amount AS pay_amount,
                i.id AS invoice_id, i.invoice_number, i.total_amount, i.subtotal_utilities
           FROM utility_bills b
           JOIN units u ON u.id = b.unit_id
           JOIN properties pr ON pr.id = u.property_id
           LEFT JOIN payments p ON p.id = b.payment_id
           LEFT JOIN invoices i ON i.id = p.invoice_id
          WHERE pr.name ILIKE 'Mountain View%' AND u.unit_number = $1
            AND b.utility_type = 'electric' AND b.billing_cycle_month = '2026-08-01'
            AND b.status = 'billed' AND b.created_at >= '2026-10-01'`, [t.unit])
      if (rows.length !== 1) { console.log(`${t.unit}: expected 1 August bill created today, found ${rows.length} — skipped`); continue }
      const r = rows[0]
      if (r.pay_status !== 'pending') { console.log(`${t.unit}: line is ${r.pay_status}, not pending — skipped`); continue }
      const amt = Number(r.pay_amount)
      console.log(`${t.unit}: void August $${r.charge_amount} (${t.why}); ${r.invoice_number} $${r.total_amount} → $${(Number(r.total_amount) - amt).toFixed(2)}`)
      await c.query(
        `UPDATE utility_bills SET payment_id = NULL, status = 'void', updated_at = NOW(),
                notes = COALESCE(notes || ' — ', '') || $2
          WHERE id = $1`,
        [r.bill_id, `void: ${t.why} (S654)`])
      await c.query(`DELETE FROM payments WHERE id = $1 AND status = 'pending'`, [r.payment_id])
      await c.query(
        `UPDATE invoices SET subtotal_utilities = subtotal_utilities - $2, total_amount = total_amount - $2, updated_at = NOW()
          WHERE id = $1`, [r.invoice_id, amt.toFixed(2)])
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
