/**
 * 11/1 — NOVEMBER AT COUNTRY ACRES GOES BACK TO ONE BILL PER LOT.
 *
 * Nic: "Blue wants Country Acres as one bill each month." and "let's also merge
 * November's bills into one by hand so that we are not getting any more
 * confused tenants. If it happened for one person, it's going to happen for all
 * of them."
 *
 * HOW IT CAME APART, because it was not a regression. On 10/1 Nic said
 * "$450 + $200 = $650 — the home payment belongs on the rent bill", and the
 * October repair attached six installments to October's invoices BY HAND. On
 * 10/25 he said "let landlords choose how it gets bundled", so a per-property
 * switch was built: properties.home_payments_own_bill. It was never turned off
 * for Country Acres, so November's run did what the switch said and wrote two
 * bills per lot. The switch is now FALSE, which fixes December onward. This
 * fixes November, which is already out.
 *
 * NOTHING ABOUT WHAT IS OWED CHANGES. The lot's balance already counted both
 * invoices — MH 01 was 512.70 + 200.00 = 712.70 before this runs and 712.70
 * after. This moves the installment onto the rent bill and retires the empty
 * one, so a resident sees a single bill with rent, water and the trailer
 * payment on it. The $6 was only ever charged once either way.
 *
 * MH 18 has no live installment left (she moved out 10/31 and it was voided
 * with her agreement), so her second invoice is simply retired at $0.
 *
 * Run with DRY=1 to print what it would do and change nothing.
 */
import { getClient } from '../db'

const DRY = process.env.DRY === '1'
const PARK = 'Country Acres - Mattoon'
const MONTH = '2026-11'

async function main() {
  const c = await getClient()
  const say = (s: string) => console.log(s)
  try {
    await c.query('BEGIN')

    // Every November invoice at this park that carries ONLY the trailer
    // payment — the ones the 04:20 home-sale run wrote on its own.
    const standalone = (await c.query<{
      id: string; unit_id: string; unit_number: string; invoice_number: string
    }>(`
      SELECT i.id, i.unit_id, u.unit_number, i.invoice_number
        FROM invoices i
        JOIN units u ON u.id = i.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE p.name = $1 AND to_char(i.due_date, 'YYYY-MM') = $2
         AND i.status <> 'void' AND i.lease_id IS NULL
       ORDER BY u.unit_number`, [PARK, MONTH])).rows

    for (const s of standalone) {
      // The lot's real November bill — the one on a lease.
      const target = (await c.query<{ id: string; invoice_number: string; total: string }>(`
        SELECT id, invoice_number, total_amount::text AS total
          FROM invoices
         WHERE unit_id = $1 AND to_char(due_date, 'YYYY-MM') = $2
           AND status <> 'void' AND lease_id IS NOT NULL
         ORDER BY created_at LIMIT 1`, [s.unit_id, MONTH])).rows[0]

      const live = (await c.query<{ id: string; amount: string; type: string }>(`
        SELECT id, amount::text AS amount, type FROM payments
         WHERE invoice_id = $1 AND status <> 'voided'`, [s.id])).rows

      if (live.length === 0) {
        say(`${s.unit_number}: ${s.invoice_number} has nothing live on it — retiring it at $0`)
        if (!DRY) {
          await c.query(
            `UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW(),
                    notes = LEFT(CONCAT_WS(E'\n', NULLIF(notes,''),
                      'Retired: its only line was voided when the resident left.'), 2000)
              WHERE id = $1`, [s.id])
        }
        continue
      }

      if (!target) {
        say(`${s.unit_number}: ${s.invoice_number} has $${live[0].amount} but there is NO rent bill to merge into — left alone`)
        continue
      }

      const moved = live.reduce((t, r) => t + Number(r.amount), 0)
      say(`${s.unit_number}: moving $${moved.toFixed(2)} from ${s.invoice_number} onto ${target.invoice_number}`
        + `  (${Number(target.total).toFixed(2)} → ${(Number(target.total) + moved).toFixed(2)})`)
      if (DRY) continue

      await c.query(
        `UPDATE payments SET invoice_id = $2 WHERE id = ANY($1::uuid[])`,
        [live.map(r => r.id), target.id])
      await c.query(
        `UPDATE invoices
            SET subtotal_home_payments = COALESCE(subtotal_home_payments,0) + $2,
                total_amount = total_amount + $2, updated_at = NOW()
          WHERE id = $1`, [target.id, moved.toFixed(2)])
      await c.query(
        `UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW(),
                notes = LEFT(CONCAT_WS(E'\n', NULLIF(notes,''),
                  'Merged into ' || $2 || ' — Country Acres bills as one invoice a month.'), 2000)
          WHERE id = $1`, [s.id, target.invoice_number])
    }

    if (DRY) { await c.query('ROLLBACK'); say('\nDRY RUN — nothing written.') }
    else { await c.query('COMMIT'); say('\nApplied.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
