/**
 * 11/1 (Nic) — COUNTRY ACRES' BOOKS START 2026-09-01.
 *
 *   "set country acres to September 1st ... that's where we imported invoices
 *    coming from, or not invoices, but recorded payments."
 *
 * The data agrees: TruBlu's earliest money on GAM is September 2026 — 15
 * records, $6,999.20 — which is the import. 59 postings have been parked on the
 * missing date through ~1,795 attempts, and the blocked-on-the-owner case
 * raises no alert, so nothing ever said so.
 *
 * Set through bankFeed.setBooksStartDate, NOT a raw UPDATE: the start date is
 * also the bank feed's cutoff, so the setter moves that review queue with it
 * (ignoring what falls before, restoring what no longer does) and the
 * ledger_capture_books_start trigger re-sorts every source the move crosses.
 *
 * NOTE this supersedes L16 ("TruBlu picks its own start date, no default set by
 * GAM") for this one company, on Nic's instruction as the operator. The broader
 * change he asked for in the same breath — a DEFAULT of the first transaction's
 * month when nobody has chosen — is a separate piece of work.
 */
import { getClient } from '../db'

const COMPANY = 'TruBlu Management LLC'
const START = '2026-09-01'

async function main() {
  const dry = process.argv.includes('--dry-run')
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const l = await client.query<{ id: string; cur: string | null }>(
      `SELECT id, books_start_date::text AS cur FROM landlords WHERE business_name = $1 FOR UPDATE`, [COMPANY])
    if (l.rowCount !== 1) throw new Error(`expected 1 company named ${COMPANY}, found ${l.rowCount}`)
    const { id, cur } = l.rows[0]
    console.log(`books start was: ${cur ?? '(not set)'}`)

    // The earliest money must not predate the date we are about to set, or
    // records would fall outside the books with nothing saying so.
    const first = await client.query<{ d: string | null }>(
      `SELECT min(due_date)::text AS d FROM payments WHERE landlord_id = $1`, [id])
    console.log(`earliest money record: ${first.rows[0].d ?? '(none)'}`)
    if (first.rows[0].d && first.rows[0].d < START) {
      throw new Error(`money exists on ${first.rows[0].d}, before ${START} — that money would sit outside the books`)
    }

    const { setBooksStartDate } = await import('../services/bankFeed')
    const moved = await setBooksStartDate(id, START, client)
    console.log(`bank review queue: ${moved.ignored} moved out of review, ${moved.restored} brought back`)

    const after = await client.query<{ d: string }>(
      `SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [id])
    console.log(`books start now: ${after.rows[0].d}`)

    await client.query(dry ? 'ROLLBACK' : 'COMMIT')
    console.log(dry ? '\n(dry run — nothing kept)' : '\napplied')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1) })
