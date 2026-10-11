/**
 * S655 money plan P8 (Step 12) — Mountain View's Square payouts are income GAM
 * never handled. ONE-TIME.
 *
 * Nic (10/2 decisions): "Square at Mountain View: propane and a few overnight
 * stays taken before the card reader arrived (10/1). Everything goes through
 * GAM now. Square payouts = money GAM never handled → filed as income, not
 * missing rent."
 *
 * This files Mountain View RV Park Ranch LLC's Square deposits since its books
 * start (9/1) as other income — payer "Square", "Square card sales before the
 * GAM card reader (propane, overnight stays)", at the park, on each deposit's
 * own day — exactly as the landlord's own "File as income" would, and writes
 * the Square payer rule with last_direction 'in' and auto_file_income on, so a
 * later Square deposit files itself (labeled, with Undo) under K-D.
 *
 * Expected on 10/3 (money plan §5 P8): 5 deposits, $457.43 —
 *   Sep $409.04: 9/10 $72.13, 9/21 $251.05, 9/23 $24.13, 9/29 $61.73
 *   Oct  $48.39: 10/1 $48.39
 * Anything else found (a sixth deposit, a different amount, one already filed)
 * stops the run with the list printed — a person looks first.
 *
 * DoorLoop at Oak Park is never touched (a rent channel; RENT_CHANNEL_PAYERS).
 *
 * RUN AFTER: the Step 12 deploy (M10 applied, the new normalizer live),
 * oct2_mountain_view_books_start.ts (P6) and oct3_renormalize_merchants.ts (P7).
 *
 * DRY RUN BY DEFAULT. DRY=0 applies (one transaction).
 *   cd apps/api && npx ts-node -T src/scripts/oct3_square_payouts_mountain_view.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct3_square_payouts_mountain_view.ts
 */
import { getClient } from '../db'
import { normalizeMerchant } from '../services/bankFeed'

const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'   // Mountain View RV Park Ranch LLC
const SINCE = '2026-09-01'
const PAYER_KEY = 'SQUARE INC'
const DESCRIPTION = 'Square card sales before the GAM card reader (propane, overnight stays)'
const EXPECTED: Array<[string, string]> = [
  ['2026-09-10', '72.13'], ['2026-09-21', '251.05'], ['2026-09-23', '24.13'], ['2026-09-29', '61.73'], ['2026-10-01', '48.39'],
]

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'landlord_merchant_rules' AND column_name = 'auto_file_income'`)
    if (!col.rowCount) throw new Error('Migration 20261003100900_bank_income_auto_file is not applied — run it first.')

    const ll = (await c.query(
      `SELECT id, business_name, books_start_date::text AS books_start FROM landlords WHERE id = $1 FOR UPDATE`, [MOUNTAIN_VIEW])).rows[0]
    if (!ll || !/mountain view/i.test(ll.business_name ?? '')) throw new Error(`Company ${MOUNTAIN_VIEW} is not Mountain View.`)
    const props = (await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM properties WHERE landlord_id = $1 ORDER BY created_at`, [MOUNTAIN_VIEW])).rows
    if (props.length !== 1) throw new Error(`Mountain View has ${props.length} properties; this script files to its one park. Nothing changed.`)
    const park = props[0]
    console.log(`${ll.business_name} (books start ${ll.books_start ?? 'not set'}) — park: ${park.name}`)

    const rows = (await c.query<any>(
      `SELECT id, to_char(posted_date, 'YYYY-MM-DD') AS posted, amount::text AS amount, description, status,
              ignored_reason, bank_status, landlord_other_income_id, expense_id, matched_payment_id, matched_disbursement_id
         FROM bank_transactions
        WHERE landlord_id = $1 AND amount > 0 AND posted_date >= $2::date
          AND ignored_reason IS DISTINCT FROM 'duplicate' AND COALESCE(bank_status, 'posted') <> 'void'
        ORDER BY posted_date, id FOR UPDATE`, [MOUNTAIN_VIEW, SINCE])).rows
      .filter((r: any) => normalizeMerchant(r.description) === PAYER_KEY)
    console.log(`  Square deposits since ${SINCE}: ${rows.length}`)
    for (const r of rows) console.log(`    ${r.posted}  $${r.amount}  ${r.status}${r.ignored_reason ? ` (${r.ignored_reason})` : ''}  ${r.description}`)

    const found = rows.map((r: any) => `${r.posted} ${Number(r.amount).toFixed(2)}`).sort()
    const want = EXPECTED.map(([d, a]) => `${d} ${a}`).sort()
    if (JSON.stringify(found) !== JSON.stringify(want)) {
      throw new Error(`Not the 5 deposits counted on 10/3 (${want.join(', ')}). Look at the list above first. Nothing changed.`)
    }
    const notOpen = rows.filter((r: any) => r.status !== 'needs_review' || r.landlord_other_income_id || r.expense_id
      || r.matched_payment_id || r.matched_disbursement_id)
    if (notOpen.length) throw new Error(`${notOpen.length} of them are already filed, matched or hidden. Nothing changed.`)

    let total = 0
    for (const r of rows) {
      const inc = (await c.query<{ id: string }>(
        `INSERT INTO landlord_other_income
           (landlord_id, property_id, unit_id, category, amount, description, payer, income_date, is_common)
         VALUES ($1, $2, NULL, 'other', $3, $4, 'Square', $5::date, TRUE) RETURNING id`,
        [MOUNTAIN_VIEW, park.id, r.amount, DESCRIPTION, r.posted])).rows[0].id
      await c.query(
        `UPDATE bank_transactions
            SET status = 'categorized', ignored_reason = NULL, landlord_other_income_id = $2,
                normalized_merchant = $3, categorized_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'needs_review'`, [r.id, inc, PAYER_KEY])
      total += Math.round(Number(r.amount) * 100)
    }
    await c.query(
      `INSERT INTO landlord_merchant_rules
         (landlord_id, normalized_merchant, category, scope_kind, property_id, unit_id, last_direction, auto_file_income, hit_count)
       VALUES ($1, $2, 'other', 'property_common', $3, NULL, 'in', TRUE, $4)
       ON CONFLICT (landlord_id, normalized_merchant) DO UPDATE
         SET category = 'other', scope_kind = 'property_common', property_id = EXCLUDED.property_id, unit_id = NULL,
             last_direction = 'in', auto_file_income = TRUE, last_used_at = now(), updated_at = now()`,
      [MOUNTAIN_VIEW, PAYER_KEY, park.id, rows.length])
    console.log(`  → filed ${rows.length} deposit(s), $${(total / 100).toFixed(2)}, as other income; Square payer rule set to file itself.`)

    if (apply) { await c.query('COMMIT'); console.log('APPLIED') }
    else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. DRY=0 to apply.') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  } finally {
    c.release()
    process.exit()
  }
})()
