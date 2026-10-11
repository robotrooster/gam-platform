/**
 * S655 — Mountain View's books start on 2026-09-01. ONE-TIME.
 *
 * Nic (10/2 decisions): "Mountain View books start 2026-09-01." Mountain View
 * RV Park Ranch LLC has no books start date, so every row its Wells Fargo
 * ••8739 link ever imported sits in the bank review list — on 10/2, 161 rows
 * from 3/9 to 8/31 ($52,983.24 out net): Square payouts, branch deposits,
 * interest and spending from before GAM ran the park. None of it is GAM's to
 * file, and it buries the 18 September/October rows that are.
 *
 * This sets the date the same way the landlord's own "Books start" save does
 * (services/bankFeed.setBooksStartDate), inside one transaction:
 *   • rows before 9/1 still waiting for review → hidden as "before your books
 *     start date" (kept on file, listed under Ignored with that reason, and
 *     brought back if the date is ever moved earlier);
 *   • nothing filed, matched, ignored by the landlord or hidden as a copy is
 *     touched, and nothing on or after 9/1 moves.
 * From then on the sync stores anything older than 9/1 the same way.
 *
 * RUN IT AFTER the migration 20261002172100_bank_txn_ignored_reason is applied
 * AND the code deploy (it needs the ignored_reason column, checked below, and
 * the running build files new pre-9/1 rows the old way).
 *
 * The script refuses to commit if the company's date is already set to
 * something else, if anything on or after 9/1 would move, or if any row it
 * hides was filed.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies (one transaction).
 *   cd apps/api && npx ts-node -T src/scripts/oct2_mountain_view_books_start.ts
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct2_mountain_view_books_start.ts
 */
import { getClient } from '../db'
import { setBooksStartDate } from '../services/bankFeed'

const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'   // Mountain View RV Park Ranch LLC
const BOOKS_START = '2026-09-01'

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const col = await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bank_transactions' AND column_name = 'ignored_reason'`)
    if (!col.rowCount) throw new Error('Migration 20261002172100_bank_txn_ignored_reason is not applied — run it first.')

    const ll = (await c.query(
      `SELECT id, business_name, books_start_date::text AS books_start
         FROM landlords WHERE id = $1 FOR UPDATE`, [MOUNTAIN_VIEW])).rows[0]
    if (!ll) throw new Error('Mountain View RV Park Ranch LLC not found.')
    if (!/mountain view/i.test(ll.business_name ?? '')) throw new Error(`Company ${MOUNTAIN_VIEW} is "${ll.business_name}", not Mountain View.`)
    console.log(`${ll.business_name}: books start now ${ll.books_start ?? '(not set)'} → ${BOOKS_START}`)
    if (ll.books_start && ll.books_start !== BOOKS_START) {
      throw new Error(`Its books start date is already ${ll.books_start}. Not changing a date someone set — nothing changed.`)
    }

    const tally = async () => (await c.query(
      `SELECT (posted_date < $2::date) AS before, status, COALESCE(ignored_reason, '') AS reason,
              count(*)::int AS n, COALESCE(sum(amount), 0)::numeric(12,2)::text AS total
         FROM bank_transactions WHERE landlord_id = $1
        GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`, [MOUNTAIN_VIEW, BOOKS_START])).rows
    const show = (rows: any[]) => rows.forEach(r =>
      console.log(`    ${r.before ? 'before 9/1' : '9/1 on    '}  ${r.status}${r.reason ? ` (${r.reason})` : ''}: ${r.n} row(s), $${r.total}`))
    console.log('  Bank rows now:')
    show(await tally())

    // Rows dated on/after the start, as they are now — none may move.
    const onAfter = async () => (await c.query(
      `SELECT id, status, ignored_reason FROM bank_transactions
        WHERE landlord_id = $1 AND posted_date >= $2::date ORDER BY id`, [MOUNTAIN_VIEW, BOOKS_START])).rows
    const before = JSON.stringify(await onAfter())

    const moved = await setBooksStartDate(MOUNTAIN_VIEW, BOOKS_START, c)
    console.log(`  → hidden as before the books start: ${moved.ignored}; brought back to review: ${moved.restored}`)
    console.log('  Bank rows after:')
    show(await tally())

    if (moved.restored !== 0) throw new Error('Rows would come back into review — not expected for this company. Rolled back.')
    if (JSON.stringify(await onAfter()) !== before) throw new Error('A row dated on or after 9/1 would change. Rolled back.')
    const filedHidden = (await c.query(
      `SELECT count(*)::int AS n FROM bank_transactions
        WHERE landlord_id = $1 AND ignored_reason = 'before_books'
          AND (expense_id IS NOT NULL OR landlord_other_income_id IS NOT NULL
               OR matched_disbursement_id IS NOT NULL OR matched_payment_id IS NOT NULL)`, [MOUNTAIN_VIEW])).rows[0].n
    if (filedHidden) throw new Error(`${filedHidden} filed row(s) would be hidden. Rolled back.`)
    const stillWaiting = (await c.query(
      `SELECT count(*)::int AS n FROM bank_transactions
        WHERE landlord_id = $1 AND posted_date < $2::date AND status = 'needs_review'`, [MOUNTAIN_VIEW, BOOKS_START])).rows[0].n
    if (stillWaiting) throw new Error(`${stillWaiting} row(s) before 9/1 would still be waiting for review. Rolled back.`)

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
