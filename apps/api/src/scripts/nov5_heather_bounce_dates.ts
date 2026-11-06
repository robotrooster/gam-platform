/**
 * 11/5 (Nic) — HEATHER MILLER'S TWO RETURN FEES GET THE DAY THEY BELONG TO.
 *
 *   "For now, just separate the line items by putting the bounce date on
 *    there."
 *
 * payments.returned_on is written by the webhook from now on, but her two rows
 * predate it: one was written by hand on 11/4 before the automatic path
 * existed, the other by the webhook on 11/5. Neither day is the day the bank
 * refused anything, so the dates are taken from STRIPE and not from the rows.
 *
 * ── WHAT STRIPE SAYS (read 11/5 against her Stripe customer) ────────────────
 *
 *   11/1  8:57pm  pi_3UXCMzDNEru9AEpK18VXnJVM  $106  declined_by_network,
 *                                                    insufficient_funds
 *   11/3  7:11pm  pi_3UXtfxDNEru9AEpK2OrNFyXf        declined_by_network,
 *                                                    insufficient_funds
 *   11/5  4:17pm  pi_3UYZu9DNEru9AEpK1Dyez3ny  $114  approved, in flight
 *
 * Two refusals, which is what Nic said and what I had wrong: on 11/4 I told him
 * the second $4 looked like a duplicate, and he went into Stripe himself to
 * show me it was not. There are exactly two, so there are exactly two fees.
 *
 * ── WHICH FEE BELONGS TO WHICH ──────────────────────────────────────────────
 *
 * The 11/5 row names pi_3UXtfx in its own note, so it is the 11/3 refusal —
 * certain, not inferred. The 11/4 row is therefore the 11/1 one, because those
 * are the only two refusals that exist.
 *
 * AND ITS NOTE IS WRONG. The hand-written row reads "refused by the bank 11/3"
 * — my error on 11/4, when I believed there had been one bounce and reached for
 * the most recent date. Corrected here with the rest, because leaving a false
 * day in the note while putting the true one in the label would leave the two
 * disagreeing on the same row.
 *
 * Idempotent: it writes only where the date is missing or different, and prints
 * what it did either way. Safe to run twice.
 */
import '../db'
import { query } from '../db'

/** The fee row (by the intent in its note, or by hand) → the day of the refusal. */
const BOUNCES: { find: string; on: string; why: string }[] = [
  { find: 'pi_3UXtfxDNEru9AEpK2OrNFyXf', on: '2026-11-03',
    why: 'Stripe: pi_3UXtfx refused 11/3 7:11pm, insufficient funds' },
  { find: 'trailer payment refused by the bank', on: '2026-11-01',
    why: 'Stripe: pi_3UXCMz refused 11/1 8:57pm, insufficient funds — the only other refusal' },
]

async function main() {
  const fees = await query<{ id: string; notes: string; returned_on: string | null; who: string | null }>(
    `SELECT p.id, COALESCE(p.notes, '') AS notes,
            to_char(p.returned_on, 'YYYY-MM-DD') AS returned_on,
            (SELECT u.first_name || ' ' || u.last_name FROM tenants t
               JOIN users u ON u.id = t.user_id WHERE t.id = p.tenant_id) AS who
       FROM payments p
      WHERE p.entry_description = 'RETURNFEE' AND p.voided_at IS NULL
      ORDER BY p.created_at`)

  for (const f of fees) {
    const hit = BOUNCES.find(b => f.notes.includes(b.find))
    if (!hit) {
      console.log(`– ${f.id} (${f.who}) matches no known refusal — left alone`)
      continue
    }
    if (f.returned_on === hit.on) {
      console.log(`= ${f.id} (${f.who}) already reads ${hit.on}`)
      continue
    }
    // The note's own wrong day goes with it, so the row does not say two things.
    const fixedNote = f.notes.replace('refused by the bank 11/3', 'refused by the bank 11/1')
    await query(
      `UPDATE payments
          SET returned_on = $2::date,
              notes = $3
        WHERE id = $1`,
      [f.id, hit.on, fixedNote])
    console.log(`✓ ${f.id} (${f.who}) → ${hit.on}  [${hit.why}]`
      + (fixedNote !== f.notes ? '\n    note corrected: 11/3 → 11/1' : ''))
  }

  console.log('\nHow the two lines read on her bill now:')
  const after = await query<{ amount: string; label_date: string | null }>(
    `SELECT amount::text AS amount, to_char(returned_on, 'Mon FMDD') AS label_date
       FROM payments
      WHERE entry_description = 'RETURNFEE' AND voided_at IS NULL
      ORDER BY returned_on`)
  for (const r of after) {
    console.log(`  Returned-payment fee${r.label_date ? ` — ${r.label_date}` : ''}   $${Number(r.amount).toFixed(2)}`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
