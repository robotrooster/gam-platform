/**
 * 10/12 (Nic): "for some reason you're billing him water or it's set up to bill
 * him water. His utilities should be fully covered as well."
 *
 * Curtis Clabough's work trade covered rent only, so the October run billed his
 * water ($110.55) as money owed. This widens his agreement to every utility and
 * parks his still-open utility charges under the work trade the same way the
 * monthly run parks a covered charge (work_trade_suspended_at + the note), then
 * rebuilds the bill total the way scripts/oct1_billing_repair.ts does.
 *
 * Dry run by default (one transaction, rolled back). --apply commits.
 */
import { getClient } from '../db'

const AGREEMENT_ID = '9f96f897-a4d5-40f8-b3f1-bc4f30ff79fe'
const TENANT_ID = 'd1fd06e5-8346-4bbf-ba3e-28d5fdef0caf'
const COVERS = ['rent', 'electric', 'water', 'sewer', 'gas', 'trash', 'propane']
const NOTE = 'Covered by work trade'

async function main() {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const before = (await c.query(
      `SELECT covered_charges, status, start_date FROM work_trade_agreements WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [AGREEMENT_ID, TENANT_ID])).rows[0]
    if (!before || before.status !== 'active') throw new Error('agreement not found or not active')
    console.log(`agreement covered: {${before.covered_charges.join(', ')}} → {${COVERS.join(', ')}}`)
    await c.query(
      `UPDATE work_trade_agreements SET covered_charges = $2::text[], updated_at = NOW() WHERE id = $1`,
      [AGREEMENT_ID, COVERS])

    // Open utility lines on or after the agreement's start, not a late fee,
    // not already parked, on a bill that is not void.
    const parked = await c.query(
      `UPDATE payments p
          SET work_trade_suspended_at = NOW(),
              notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN $3 ELSE p.notes || ' — ' || $3 END
         FROM invoices i
        WHERE i.id = p.invoice_id AND i.status <> 'void'
          AND p.tenant_id = $1 AND p.type = 'utility' AND p.status = 'pending'
          AND p.work_trade_suspended_at IS NULL AND p.amount > 0
          AND COALESCE(p.entry_description, '') <> 'LATEFEE'
          AND p.due_date >= $2::date
        RETURNING i.invoice_number, p.amount, p.due_date, p.invoice_id`,
      [TENANT_ID, before.start_date, NOTE])
    for (const r of parked.rows) console.log(`parked ${r.invoice_number} utility $${r.amount} due ${String(r.due_date).slice(0, 10)}`)

    const ids = Array.from(new Set(parked.rows.map((r: any) => r.invoice_id)))
    if (ids.length) {
      const totals = await c.query(
        `UPDATE invoices i
            SET total_amount = COALESCE((SELECT SUM(p.amount) FROM payments p
                                          WHERE p.invoice_id = i.id AND p.work_trade_suspended_at IS NULL
                                            AND p.status <> 'failed'), 0),
                updated_at = NOW()
          WHERE i.id = ANY($1::uuid[])
          RETURNING invoice_number, total_amount`, [ids])
      for (const r of totals.rows) console.log(`bill ${r.invoice_number} total now $${r.total_amount}`)
    }

    if (apply) { await c.query('COMMIT'); console.log('APPLIED') }
    else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. --apply to commit.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
