/**
 * 10/25 (Nic) — CLEAR WHAT THE WRONG RULE LEFT ON PATRICK NEUMAN'S FINISHED STAY.
 *
 *   "Meter read due for Patrick, that's showing in the meter readings tab.
 *    Reading to double check for Patrick, which is showing needs review in the
 *    meter readings tab. Neither of those should be there according with what I
 *    want. The system is not operating correctly if those are there. Full stop."
 *
 * He asked on 10/24 that a read within a digit or two of the last one — even a
 * lower one — "go straight into marking it as potentially broken". I read "it"
 * as the READ and held the figure for his double-check. He meant the METER.
 *
 * The code now does that (registerFinalUtility: the read stands and bills, the
 * meter carries looks_broken_at). This clears the one stay it already caught:
 *   - RV 06's closing read of 39999 on 10/23 stops needing review, so the
 *     "closing reads still due" notice stops firing and the read leaves the
 *     Readings-to-double-check list;
 *   - RV 06's electric meter is flagged as possibly broken instead, which is
 *     what he asked for in the first place;
 *   - the unread notices already sent about it are marked read, because they
 *     were asking for something that was already done.
 *
 * Scoped to ONE landlord, named on the command line — GAM holds more than one
 * operator's parks and a reading is live data (10/24, the Country Acres lease).
 *
 * DRY RUN BY DEFAULT.
 *   cd apps/api && npx ts-node -T src/scripts/oct25_settle_patrick_rollback.ts --landlord=<uuid>
 *   cd apps/api && npx ts-node -T src/scripts/oct25_settle_patrick_rollback.ts --landlord=<uuid> --apply
 */
import { query, getClient } from '../db'

;(async () => {
  const apply = process.argv.includes('--apply')
  const landlordId = process.argv.find(a => a.startsWith('--landlord='))?.split('=')[1]
  if (!landlordId || !/^[0-9a-f-]{36}$/i.test(landlordId)) {
    console.error('Name the company with --landlord=<uuid>. This edits live meter readings.')
    process.exit(1)
  }

  // Every held read taken at a move-out whose figure only "barely moved" — the
  // rule that should never have held it. Read back with its prior figure so the
  // output shows exactly why each one was caught.
  const held = await query<any>(
    `SELECT r.id, r.reading_value, to_char(r.reading_date,'YYYY-MM-DD') AS day,
            m.id AS meter_id, m.utility_type, u.unit_number, p.name AS property_name,
            prior.reading_value AS prior_value
       FROM utility_meter_readings r
       JOIN utility_meters m ON m.id = r.meter_id
       JOIN properties p ON p.id = m.property_id
       LEFT JOIN utility_meter_units mu ON mu.meter_id = m.id
       LEFT JOIN units u ON u.id = mu.unit_id
       LEFT JOIN LATERAL (
         SELECT reading_value FROM utility_meter_readings q
          WHERE q.meter_id = r.meter_id
            AND (q.reading_date, q.created_at) < (r.reading_date, r.created_at)
          ORDER BY q.reading_date DESC, q.created_at DESC LIMIT 1) prior ON TRUE
      WHERE p.landlord_id = $1
        AND r.needs_review
        AND r.reason = 'move_out_final'
        AND prior.reading_value IS NOT NULL
        AND r.reading_value <= prior.reading_value
        AND prior.reading_value - r.reading_value <= 2
      ORDER BY r.reading_date`, [landlordId])

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${held.length} held rollback read(s)\n`)
  for (const h of held) {
    console.log(`${h.unit_number ?? '(no unit)'} · ${h.property_name} · ${h.utility_type}`)
    console.log(`  read ${h.reading_value} on ${h.day}, previous ${h.prior_value} — ${h.prior_value - h.reading_value} under`)
    console.log(`  ${apply ? 'settling the read; flagging' : 'would settle the read and flag'} the meter as possibly broken`)
    if (!apply) continue
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE utility_meter_readings
            SET needs_review = FALSE,
                review_note = btrim(COALESCE(review_note || ' — ', '') ||
                  '10/25: settled, not held. A rollback flags the meter, not the read.')
          WHERE id = $1 AND needs_review`, [h.id])
      await client.query(
        `UPDATE utility_meters
            SET looks_broken_at = COALESCE(looks_broken_at, NOW()),
                looks_broken_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [h.meter_id, `Read ${h.reading_value} on ${h.day} against ${h.prior_value} before it — `
                   + `the dial barely moved, or went backwards. The read stands; the meter may be stuck or swapped.`])
      // The notices that were chasing it were asking for something already done.
      await client.query(
        `UPDATE notifications
            SET read_at = NOW()
          WHERE type = 'moveout_meter_reads_due' AND read_at IS NULL
            AND landlord_id = $1`, [landlordId])
      await client.query('COMMIT')
      console.log('  ✓ done\n')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  if (!apply) console.log('Nothing written. Re-run with --apply.')
  process.exit(0)
})().catch(e => { console.error(e?.message || e); process.exit(1) })
