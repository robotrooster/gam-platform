/**
 * S655 — Oak Park's PNC ••9677 history, imported twice. ONE-TIME CLEANUP.
 *
 * Approved by Nic. RUN IT WITH THE CODE DEPLOY, NOT BEFORE: the build running
 * today brings every ignored row on/after the books start back into review the
 * next time anyone saves the date, so hiding the copies before the new code is
 * live would only last until that save. Needs migration
 * 20261002172100_bank_txn_ignored_reason applied first (checked below).
 *
 * What happened: the old link (24d590b7…, made 8/17, retired 9/26) holds 133
 * rows; the relink of 9/26 (418f16f4…) imported the history again — 106 rows,
 * of which 104 are copies of old-link rows and 2 are new (9/26 CHECK 1140
 * −$4,000.00, 9/28 GAM FEES −$54.00). 91 of the copies have identical bank
 * text; 12 have the old link's short pending wording; 1 posted a day later.
 *
 * Pairing (verified read-only): same amount to the cent, posted within 3 days.
 * Each of the 104 has exactly one partner and no row has two — the script
 * refuses to touch anything unless that is still exactly true.
 *
 * What it does, in one transaction:
 *   1. the 104 old-link copies → ignored / duplicate, pointing at the new copy
 *      (the active link is the one the bank keeps updating — the same keep rule
 *      the sync now applies);
 *   2. the active link's 69 rows dated before the 8/1 books start →
 *      ignored / before_books.
 * Nothing is deleted. End state: Oak Park's review queue 141 → 37 (the 35 real
 * Aug–Sep transactions + the 2 new ones). The 29 Feb–Mar old-link rows stay
 * as before_books — they are the only record of that period.
 *
 * Nothing is attached to any of these rows (0 expenses, 0 other income, 0
 * deposit allocations, 0 tenant reports — checked again below), so no figure in
 * any report moves.
 *
 * DRY RUN BY DEFAULT. DRY=0 applies.
 *   cd apps/api && npx ts-node -T src/scripts/oct2_oak_park_pnc_duplicates.ts          # dry run
 *   cd apps/api && DRY=0 npx ts-node -T src/scripts/oct2_oak_park_pnc_duplicates.ts    # apply
 */
import { getClient } from '../db'

const OLD_LINK = '24d590b7-046f-4050-8ae9-0ada238048f6'
const NEW_LINK = '418f16f4-0a24-497e-b2ac-b4268b301313'
const BOOKS_START = '2026-08-01'
const EXPECTED_PAIRS = 104
const EXPECTED_BEFORE_BOOKS = 69

;(async () => {
  const apply = process.env.DRY === '0'
  const c = await getClient()
  try {
    await c.query('BEGIN')

    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'bank_transactions' AND column_name IN ('ignored_reason', 'duplicate_of_id')`)
    if (cols.rowCount !== 2) throw new Error('Migration 20261002172100_bank_txn_ignored_reason is not applied — run it first.')

    const links = (await c.query(
      `SELECT c.id, c.institution_name, c.account_last4, c.status, l.books_start_date::text AS books_start
         FROM bank_connections c JOIN landlords l ON l.id = c.landlord_id
        WHERE c.id = ANY($1::uuid[])`, [[OLD_LINK, NEW_LINK]])).rows
    if (links.length !== 2 || links.some((l: any) => l.account_last4 !== '9677')
        || new Set(links.map((l: any) => l.institution_name)).size !== 1) {
      throw new Error(`Expected the two PNC ••9677 links, found ${JSON.stringify(links)}`)
    }
    if (links.some((l: any) => l.books_start !== BOOKS_START)) {
      throw new Error(`Oak Park's books start is no longer ${BOOKS_START}: ${JSON.stringify(links)}`)
    }

    // Pair: same amount, within 3 days. Must be one-for-one, exactly as verified.
    const pairs = (await c.query(
      `SELECT o.id AS old_id, n.id AS new_id, o.posted_date::text AS old_date, n.posted_date::text AS new_date,
              o.amount::text AS amount, o.status AS old_status, o.ignored_reason AS old_reason,
              o.description AS old_text, n.description AS new_text
         FROM bank_transactions o
         JOIN bank_transactions n
           ON n.bank_connection_id = $2
          AND n.amount = o.amount
          AND abs(n.posted_date - o.posted_date) <= 3
        WHERE o.bank_connection_id = $1
        ORDER BY o.posted_date, o.amount`, [OLD_LINK, NEW_LINK])).rows
    const oldIds = new Set(pairs.map((p: any) => p.old_id))
    const newIds = new Set(pairs.map((p: any) => p.new_id))
    if (pairs.length !== EXPECTED_PAIRS || oldIds.size !== EXPECTED_PAIRS || newIds.size !== EXPECTED_PAIRS) {
      throw new Error(`Pairing is not the verified ${EXPECTED_PAIRS} one-to-one: ${pairs.length} pairs, ` +
        `${oldIds.size} old rows, ${newIds.size} new rows. Nothing changed.`)
    }

    const done = pairs.filter((p: any) => p.old_reason === 'duplicate').length
    if (done) throw new Error(`Already applied: ${done} of the old-link copies are already marked as duplicates. Nothing changed.`)

    // Nothing may be attached to either copy.
    const allIds = [...oldIds, ...newIds]
    const attached = (await c.query(
      `SELECT t.id FROM bank_transactions t
        WHERE t.id = ANY($1::uuid[])
          AND (t.status IN ('categorized', 'matched') OR t.expense_id IS NOT NULL
               OR t.landlord_other_income_id IS NOT NULL OR t.matched_payment_id IS NOT NULL
               OR t.matched_disbursement_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM bank_deposit_allocations a WHERE a.bank_transaction_id = t.id)
               OR EXISTS (SELECT 1 FROM tenant_declared_deposits d WHERE d.bank_transaction_id = t.id))`,
      [allIds])).rows
    if (attached.length) throw new Error(`${attached.length} of these rows have been filed since the check — stop and look: ${attached.map((r: any) => r.id).join(', ')}`)

    const textDiffers = pairs.filter((p: any) => p.old_text !== p.new_text)
    const dateDiffers = pairs.filter((p: any) => p.old_date !== p.new_date)
    console.log(`Pairs: ${pairs.length} (identical text ${pairs.length - textDiffers.length}, different text ${textDiffers.length}, different day ${dateDiffers.length})`)
    for (const p of textDiffers) {
      console.log(`  ${p.old_date}→${p.new_date}  $${p.amount}  "${p.old_text}"  ⇒  "${p.new_text}"`)
    }

    // 1. Old copies → duplicate of the new copy.
    const hid = await c.query(
      `UPDATE bank_transactions o
          SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of_id = p.new_id, updated_at = now()
         FROM (SELECT unnest($1::uuid[]) AS old_id, unnest($2::uuid[]) AS new_id) p
        WHERE o.id = p.old_id AND o.status IN ('needs_review', 'ignored')
          AND o.ignored_reason IS DISTINCT FROM 'duplicate'
        RETURNING o.id`,
      [pairs.map((p: any) => p.old_id), pairs.map((p: any) => p.new_id)])
    if (hid.rowCount !== EXPECTED_PAIRS) throw new Error(`Hid ${hid.rowCount} old copies, expected ${EXPECTED_PAIRS}. Rolled back.`)
    console.log(`1. Old-link copies hidden as duplicates: ${hid.rowCount}`)

    // 2. New link's pre-books rows → before_books.
    const pre = await c.query(
      `UPDATE bank_transactions
          SET status = 'ignored', ignored_reason = 'before_books', updated_at = now()
        WHERE bank_connection_id = $1 AND status = 'needs_review' AND posted_date < $2::date
        RETURNING id`, [NEW_LINK, BOOKS_START])
    if (pre.rowCount !== EXPECTED_BEFORE_BOOKS) throw new Error(`Hid ${pre.rowCount} pre-books rows on the active link, expected ${EXPECTED_BEFORE_BOOKS}. Rolled back.`)
    console.log(`2. Active-link rows before ${BOOKS_START} hidden: ${pre.rowCount}`)

    const after = (await c.query(
      `SELECT bank_connection_id, status, ignored_reason, count(*)::int AS n
         FROM bank_transactions WHERE bank_connection_id = ANY($1::uuid[])
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [[OLD_LINK, NEW_LINK]])).rows
    console.log('End state:')
    for (const r of after) {
      console.log(`  ${r.bank_connection_id === OLD_LINK ? 'old link   ' : 'active link'}  ${r.status}${r.ignored_reason ? ` / ${r.ignored_reason}` : ''}: ${r.n}`)
    }

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
