/**
 * 11/4 — COUNTRY ACRES' RENT DEPOSITS WERE FILED AS "OTHER INCOME", SO THE
 * PARK'S INCOME IS ON THE BOOKS TWICE.
 *
 * WHAT HAPPENED, in order:
 *   11/1  GAM recorded September at Country Acres as rent collected
 *         off-platform before the park was on GAM — eight settled rent rows
 *         (manual_method 'prior_arrangement'), which recognized $4,920.00 of
 *         SPACE RENT income, plus MH 29's arrears.
 *   11/4  TruBlu's bank (First Mid) was linked at 15:54. Between 16:06 and
 *         16:08 every deposit in the new feed was filed, one at a time, as
 *         OTHER INCOME against a space — $10,342.40 across 17 deposits. Not an
 *         auto-file rule: somebody clicked through the feed, which is the
 *         obvious thing to do with a screen full of uncategorized deposits.
 *   11/4  Nine of those same deposits were then recorded as rent receipts
 *         while reconciling against Blue's ledger.
 *
 * So every one of the 17 is money GAM had already recognized — as rent
 * collected off-platform, or as a receipt against a bill — and filing it again
 * as other income counted it a second time:
 *
 *     month      space rent   other income (duplicate)
 *     2026-09     4,920.00            5,021.35
 *     2026-10     5,400.00            3,658.05
 *     2026-11     4,950.00            1,663.00
 *                                    ─────────
 *                                    10,342.40
 *
 * Country Acres' income reads roughly double, and a management fee computed off
 * income would be too. Every dollar counted once.
 *
 * WHAT THIS DOES. Nothing bespoke — the two shipped paths, in order, per
 * deposit:
 *   1. bankFeed.undoFiling — takes the deposit off other income (the income row
 *      is voided, kept as a record) and puts the line back in the feed's review
 *      list, where a rent deposit belongs.
 *   2. recordedDepositMatch.matchRecordedDeposit — where GAM already holds the
 *      receipt for that deposit, ties the line to it, so the feed reads clean
 *      and the bank's own date decides lateness.
 * A deposit with no receipt yet (September's, behind the off-platform
 * settlements) is left in review after step 1 and NAMED at the end: giving
 * those settlements their receipts is the MH 29 fix over again, and it is its
 * own pass.
 *
 * Scoped to this one property's deposits and refuses anything else. Dry run
 * unless --apply.
 *
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_country_acres_unfile_rent_deposits.ts
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/nov4_country_acres_unfile_rent_deposits.ts --apply
 */
import { query, getClient } from '../db'
import { undoFiling } from '../services/bankFeed'
import { recordedDepositsFitting, matchRecordedDeposit } from '../services/recordedDepositMatch'

const PROPERTY_ID = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'   // Country Acres - Mattoon
const PROPERTY_NAME = 'Country Acres - Mattoon'
const BY_USER = 'aaeddccf-3778-4ca1-8772-ecc775f42554'        // Blu Haws
const APPLY = process.argv.includes('--apply')

interface Row {
  id: string; landlord_id: string; posted_date: string; amount: string
  description: string | null; unit_number: string | null; income_id: string
}

async function main() {
  const dbName = (await query<{ n: string }>('SELECT current_database() AS n'))[0].n
  console.log(`database: ${dbName}`)
  console.log(APPLY ? 'mode: APPLY' : 'mode: dry run (pass --apply to write)')

  const prop = (await query<{ landlord_id: string; name: string }>(
    `SELECT landlord_id, name FROM properties WHERE id = $1`, [PROPERTY_ID]))[0]
  if (!prop) throw new Error('that property does not exist here')
  if (prop.name !== PROPERTY_NAME) throw new Error(`refusing: expected ${PROPERTY_NAME}, found ${prop.name}`)

  // Only this property's money-in lines that were filed as other income.
  const rows = await query<Row>(
    `SELECT bt.id, bt.landlord_id, to_char(bt.posted_date,'YYYY-MM-DD') AS posted_date,
            bt.amount::text AS amount, bt.description, u.unit_number,
            bt.landlord_other_income_id AS income_id
       FROM bank_transactions bt
       JOIN landlord_other_income oi ON oi.id = bt.landlord_other_income_id
       JOIN units u ON u.id = oi.unit_id
      WHERE u.property_id = $1
        AND bt.status = 'categorized'
        AND bt.landlord_other_income_id IS NOT NULL
        AND bt.amount > 0
      ORDER BY bt.posted_date, bt.amount`, [PROPERTY_ID])

  if (rows.length === 0) { console.log('\nNothing filed as other income here — nothing to undo.'); return }
  const total = rows.reduce((s, r) => s + Number(r.amount), 0)
  console.log(`\n${rows.length} deposit(s) filed as other income, $${total.toFixed(2)} in all\n`)

  const noReceipt: Row[] = []
  let undone = 0
  let matched = 0

  for (const r of rows) {
    const client = await getClient()
    let fitId: string | null = null
    let fitWho = ''
    try {
      const fits = await recordedDepositsFitting(client, {
        id: r.id, landlord_id: r.landlord_id, amount: r.amount,
        posted_date: r.posted_date, description: r.description,
      })
      if (fits.length === 1) { fitId = fits[0].receiptId; fitWho = `${fits[0].tenantName} ${fits[0].unitNumber ?? ''}`.trim() }
      else if (fits.length > 1) fitWho = `${fits.length} receipts fit — a person has to pick`
    } finally { client.release() }

    const line = `  ${r.posted_date}  $${Number(r.amount).toFixed(2).padStart(8)}  ${(r.unit_number ?? '—').padEnd(6)}`
    if (!APPLY) {
      console.log(`${line} unfile` + (fitId ? `, then match → ${fitWho}` : fitWho ? `, then ${fitWho}` : ', then leave in review (no receipt yet)'))
      if (!fitId) noReceipt.push(r)
      continue
    }

    try {
      await undoFiling(r.landlord_id, r.id, { undoneBy: BY_USER })
      undone++
    } catch (e: any) {
      console.log(`${line} UNFILE FAILED: ${e?.message ?? e}`)
      continue
    }
    if (!fitId) { console.log(`${line} unfiled — in review (no receipt yet)`); noReceipt.push(r); continue }
    try {
      await matchRecordedDeposit({ bankTransactionId: r.id, receiptId: fitId, confirmedByUserId: BY_USER })
      matched++
      console.log(`${line} unfiled and matched → ${fitWho}`)
    } catch (e: any) {
      console.log(`${line} unfiled; MATCH FAILED: ${e?.message ?? e}`)
      noReceipt.push(r)
    }
  }

  if (APPLY) console.log(`\nunfiled ${undone}, matched ${matched}`)

  if (noReceipt.length > 0) {
    const sum = noReceipt.reduce((s, r) => s + Number(r.amount), 0)
    console.log(`\n${noReceipt.length} deposit(s), $${sum.toFixed(2)}, have no receipt behind them yet:`)
    for (const r of noReceipt) console.log(`  ${r.posted_date}  $${Number(r.amount).toFixed(2)}  ${r.unit_number ?? '—'}`)
    console.log('  These are the off-platform September settlements. Recording their receipts is')
    console.log('  the MH 29 fix again (nov4_nathan_sept_100_receipt) and is its own pass.')
  }

  // What the books say afterwards, by month — read, never asserted.
  const after = await query<{ month: string; category: string; income: string }>(
    `SELECT to_char(pl.accounting_date,'YYYY-MM') AS month,
            COALESCE(pl.report_category, '(none)') AS category,
            ROUND(SUM(pl.credit - pl.debit), 2)::text AS income
       FROM ledger_posting_lines pl
       JOIN units u ON u.id = pl.unit_id
      WHERE u.property_id = $1
        AND pl.account_role IN ('space_rent', 'other_income', 'utility_water', 'late_fees', 'home_sales')
      GROUP BY 1, 2 ORDER BY 1, 2`, [PROPERTY_ID])
  console.log('\nincome on the books now (the engine posts within the minute, so re-run to see it move):')
  for (const a of after) console.log(`  ${a.month}  ${a.category.padEnd(22)} $${a.income}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
