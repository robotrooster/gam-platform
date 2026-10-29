/**
 * 10/24 (Nic) — DONALD HAMP'S PROPANE WAS PAID BY CHECK, NOT CASH.
 *
 *   "one propane sale got marked as cash when the person dropped off a check.
 *    $49.25 under Donald Hamp. So we need to correctly re-record that to be a
 *    check and not cash."
 *
 *   "I want you to re-record Donald Hamp as paid with check. I don't want to
 *    void the sale and redo it. I don't like voiding sales. It's just like it
 *    makes it look like it was there when it wasn't. And it's just extra data
 *    in the system that doesn't need to remain."
 *
 *   "I have the number. It's check number 167 actually."
 *
 * Two corrections to ONE sale, which happened and was for the right money: the
 * tender, and who it was for (it was rung with nobody on it). Both are the same
 * writes PATCH /api/pos/transactions/:id/tender and .../customer make, done here
 * because this is one sale on one day rather than something the desk is doing.
 *
 * audit_pos_transactions journals both, so what the row said before — cash, no
 * number, nobody — is kept in the change journal for good. Nothing is voided and
 * no second sale is written.
 */
import { query, queryOne } from '../db'

const SALE = '200c4976-f76c-479a-b985-c3b244d516ad'
const HAMP = '00139fa0-6e46-4047-a790-ac6d6bf215e6'
const CHECK = '167'
const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'

;(async () => {
  const apply = process.argv.includes('--apply')
  const before = await queryOne<any>(
    `SELECT t.id, t.payment_method, t.payment_reference, t.total::text AS total, t.pos_customer_id,
            t.voided_at, t.refunded_at, t.created_at::date AS day, p.accepts_checks
       FROM pos_transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.id = $1 AND t.landlord_id = $2`, [SALE, MOUNTAIN_VIEW])
  if (!before) throw new Error('That sale is not on Mountain View\'s books.')
  if (before.voided_at || before.refunded_at) throw new Error('That sale was voided or refunded — leave it alone.')
  if (before.payment_method !== 'cash' && before.payment_method !== 'check') {
    throw new Error(`That sale is ${before.payment_method}, which is not a cash/check record to re-label.`)
  }
  if (!before.accepts_checks) throw new Error('Mountain View is set to not take checks.')
  const hamp = await queryOne<any>(
    `SELECT id, first_name, last_name FROM pos_customers WHERE id = $1 AND landlord_id = $2`, [HAMP, MOUNTAIN_VIEW])
  if (!hamp) throw new Error('Donald Hamp is not a Mountain View customer.')

  console.log(`\n  ${apply ? 'CORRECTING' : 'DRY RUN'} — $${before.total} propane, ${before.day}`)
  console.log(`    tender   : ${before.payment_method}${before.payment_reference ? ` #${before.payment_reference}` : ''}  ->  check #${CHECK}`)
  console.log(`    for whom : ${before.pos_customer_id ?? 'nobody'}  ->  ${hamp.first_name} ${hamp.last_name}`)
  if (!apply) { console.log('\n  Nothing written. Re-run with --apply\n'); process.exit(0) }

  await query(
    `UPDATE pos_transactions SET payment_method = 'check', payment_reference = $2, pos_customer_id = $3
      WHERE id = $1`, [SALE, CHECK, HAMP])
  const after = await queryOne<any>(
    `SELECT t.payment_method, t.payment_reference, t.voided_at, t.total::text AS total,
            c.first_name || ' ' || c.last_name AS who
       FROM pos_transactions t LEFT JOIN pos_customers c ON c.id = t.pos_customer_id
      WHERE t.id = $1`, [SALE])
  const journal = await queryOne<any>(
    `SELECT op, old_row->>'payment_method' AS was, old_row->>'pos_customer_id' AS was_who
       FROM audit_row_changes WHERE table_name = 'pos_transactions' AND row_id = $1
      ORDER BY changed_at DESC LIMIT 1`, [SALE])
  console.log(`\n  now: $${after.total} ${after.payment_method} #${after.payment_reference} — ${after.who}`)
  console.log(`  not voided: ${after.voided_at === null}`)
  console.log(`  change journal kept the old values: ${journal?.op} was ${journal?.was}, for ${journal?.was_who ?? 'nobody'}\n`)
  process.exit(0)
})().catch(e => { console.error(`\n  ${e?.message || e}\n`); process.exit(1) })
