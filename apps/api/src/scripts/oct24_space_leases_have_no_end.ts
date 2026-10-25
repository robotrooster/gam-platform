/**
 * 10/24 (Nic) — THE TWO SPACE RENTALS CARRYING AN END DATE THEY SHOULD NOT HAVE.
 *
 *   "I thought the leases were supposed to block the spot indefinitely because
 *    they don't know how long they're going to be here... February is one of our
 *    busiest times, and if he's a person that decides he's going to stay longer,
 *    like, we can't have that reservation messing up on us."
 *
 *   "When the tenant owns the unit and they're just renting the space, like in
 *    an RV, that doesn't matter. It can be month to month. It can auto renew."
 *
 * processLeaseEnds now lapses a space rental's end date instead of freeing the
 * space — but it only runs WHEN the date arrives. James Fenton's says 2027-01-31
 * and Mike Boyd's says 2027-03-01, so until those days come the leases still
 * carry an end, and every availability check reads an end date as "free after
 * that": RV 15 is bookable for February TODAY. Which is the thing Nic is afraid
 * of, nine months early.
 *
 * Both dates came from the applicant's own "how long do you want to stay" answer
 * on a screening form (background_checks.desired_term_months — Fenton said 3),
 * handed to the lease drafter as a contract term. That door is now shut in both
 * places that opened it; this clears what came through it.
 *
 * WHAT THIS DOES NOT DO. It does not touch the signed document — the PDF still
 * says what both parties signed. The outcome is identical to letting the date
 * arrive and lapse, moved forward so the calendar stops lying in the meantime.
 * It is LANDLORD-OWNED dwellings that keep their end dates (S562: renewal is a
 * conscious decision, nobody trapped), so those are refused by name here.
 *
 * ── 10/24: SCOPED TO ONE COMPANY, AND WHY ────────────────────────────────────
 *
 * The first version of this read EVERY lease in the database. GAM is a platform:
 * Country Acres - Mattoon is another operator's park, and MH 15 exists at BOTH
 * Mountain View and Country Acres. So it cleared a Country Acres lease's end
 * date along with Nic's, which was not Nic's to change and was reverted by hand.
 *
 *   Nic: "That has nothing to do with me. I'm talking about operating Mountain
 *   View, Oak Park, my properties. Stop crossing the line."
 *
 * An operational script that edits leases now REQUIRES the company it is acting
 * for and can reach nothing outside it. The rule in processLeaseEnds is
 * platform-wide — that is a product behaviour every operator gets. Reaching into
 * a specific operator's live rows is not, and never happens without being named.
 *
 * DRY RUN BY DEFAULT. The landlord id is required, not optional.
 *   cd apps/api && npx ts-node -T src/scripts/oct24_space_leases_have_no_end.ts --landlord=<uuid>
 *   cd apps/api && npx ts-node -T src/scripts/oct24_space_leases_have_no_end.ts --landlord=<uuid> --apply
 */
import { query, getClient } from '../db'

;(async () => {
  const apply = process.argv.includes('--apply')
  const landlordArg = process.argv.find(a => a.startsWith('--landlord='))?.split('=')[1]
  if (!landlordArg || !/^[0-9a-f-]{36}$/i.test(landlordArg)) {
    console.error('Refusing to run: name the company with --landlord=<uuid>.\n' +
      'This script edits live leases, and GAM holds more than one operator\'s parks.')
    process.exit(1)
  }
  const company = await query<any>(
    `SELECT l.id, l.business_name, array_agg(p.name ORDER BY p.name) AS properties
       FROM landlords l LEFT JOIN properties p ON p.landlord_id = l.id
      WHERE l.id = $1 GROUP BY l.id, l.business_name`, [landlordArg])
  if (!company.length) { console.error(`No company with id ${landlordArg}.`); process.exit(1) }
  console.log(`Company : ${company[0].business_name}`)
  console.log(`Parks   : ${(company[0].properties || []).filter(Boolean).join(', ') || '(none)'}\n`)

  const rows = await query<any>(`
    SELECT l.id, l.end_date, l.lease_type, u.unit_number, u.dwelling_ownership, u.unit_type,
           COALESCE(us.first_name || ' ' || us.last_name, '(no tenant on file)') AS tenant
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status NOT IN ('void','removed')
      LEFT JOIN tenants t ON t.id = lt.tenant_id
      LEFT JOIN users us ON us.id = t.user_id
     WHERE l.status IN ('active','pending') AND l.end_date IS NOT NULL
       AND l.landlord_id = $1
     ORDER BY u.dwelling_ownership, l.end_date`, [landlordArg])

  console.log(apply ? 'APPLYING\n' : 'DRY RUN — nothing is written\n')
  let touched = 0
  for (const r of rows) {
    const space = r.dwelling_ownership === 'tenant'
    const verb = space ? (apply ? 'CLEARING ' : 'WOULD CLEAR') : 'KEEPING   '
    console.log(`${verb} ${r.unit_number.padEnd(7)} ${r.tenant.padEnd(18)} ends ${r.end_date} ` +
      `· dwelling owned by ${r.dwelling_ownership} ` +
      `· ${space ? 'space rental — holds the space indefinitely' : 'S562: the agreed end stands'}`)
    if (!space || !apply) continue
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Guarded on the ownership again INSIDE the write, so this can never clear
      // a landlord-owned dwelling's end date even if the read above went stale.
      const done = await client.query(
        `UPDATE leases l
            SET end_date = NULL, lease_type = 'month_to_month', updated_at = NOW()
          WHERE l.id = $1 AND l.status IN ('active','pending')
            AND l.landlord_id = $2
            AND EXISTS (SELECT 1 FROM units u
                         WHERE u.id = l.unit_id AND u.dwelling_ownership = 'tenant')
          RETURNING id`, [r.id, landlordArg])
      await client.query('COMMIT')
      if (done.rowCount) { touched++; console.log('          ✓ now open-ended, month-to-month') }
      else console.log('          · skipped — it changed since this script read it')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  if (!apply) console.log('\nNothing written. Re-run with --apply.')
  else console.log(`\n${touched} space rental(s) now hold their space indefinitely.`)
  process.exit(0)
})().catch(e => { console.error(e?.message || e); process.exit(1) })
