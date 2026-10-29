/**
 * 10/21 (Nic) — THE RESERVATIONS CAMPGROUND MASTER HAD AND GAM DID NOT.
 *
 * Read out of the old system's export beside GAM's own board (1,105 rows, 66 of
 * them still live) and settled one at a time with Nic. His rules:
 *
 *   "For reservations where there's an overlap, we're going to take what's
 *    already in GAM. For reservations where there's no overlap, we are going to
 *    take what's in Campground Master and there's going to be some discretion
 *    that we have to use."
 *
 *   "I don't need the reservation history of anything that's people that are
 *    already checked out and gone from Campground Master. I just need the
 *    customer data... I want the history of GAM, the calendar, to start where we
 *    started using GAM."
 *
 * So: no history, no checked-out rows, nothing GAM already has. Of the 66 live
 * rows, 45 are already leases in GAM and 10 are his own out-of-order blocks on
 * sites GAM already has marked out of order. These are the ones left that are
 * RESERVATIONS — a guest with an arrival and a departure.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
 *
 * Four of the remaining rows are not reservations at all, and importing them as
 * stays would be wrong in a way that costs somebody money:
 *
 *   Ray Artiaga (site 9), Bill Geisman's widow (MH 26), Brandon Valdez
 *   (MH 17), Rick Moran (site not yet settled) — all long-term, and three of
 *   them on work trade. A stay's money is taken up front at the counter; a
 *   resident's rent is billed every month against a lease. Imported as stays
 *   they would sit on their sites with no rent ever charged. Those four go
 *   through the lease / work-trade door, with Nic answering what each one pays
 *   (or works), not through here.
 *
 *   Kent & Kelly Nielsen (site 71) wait on a design answer Nic has flagged
 *   himself: how a site that is GUARANTEED to a snowbird couple all year — they
 *   decorated it, and they come and go on dates nobody can pin down — should
 *   read on the board. Site 71 is marked out of order today, which is how he has
 *   been holding it, and that is a lie the board tells about a working site.
 *
 *   AJ Rhoades (site 5) is not imported at all: "he is not there anymore."
 *   Upstairs and site 74 are not sites: 74 was Campground Master's shunting
 *   yard for shuffling the board, which GAM's own compression makes unnecessary.
 *
 * ── IT SENDS NOTHING ────────────────────────────────────────────────────────
 *
 * It goes through the same one door the file importer and hand-entry use
 * (services/reservationImport), which inserts rows and makes no call that could
 * send: no confirmation, no deposit link, no site reveal. These guests were
 * told months ago by Nic himself.
 *
 * A row that names a site is LOCKED to it (lock_reason 'promised_before_gam'),
 * because the guest was already promised that space and compression must not
 * move them.
 *
 * DRY RUN BY DEFAULT — writes nothing, prints the assessment row by row.
 *   cd apps/api && npx ts-node -T src/scripts/oct21_from_campground_master.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct21_from_campground_master.ts --apply
 */
import { queryOne } from '../db'
import { runReservationImport, type ReservationImportRowInput } from '../services/reservationImport'

export const MOUNTAIN_VIEW = {
  landlordId: '96ec7df3-362d-4777-b54c-e9604313820f',
  propertyId: 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01',
} as const

/**
 * Settled with Nic, 10/21. `checkOut` is the day they LEAVE (Campground Master
 * writes the last night, so each is that night plus one).
 */
export const ROWS: ReservationImportRowInput[] = [
  {
    // "Patrick Newman is here as a work camper. It's a temporary thing while he
    //  was buying a house, so he's actually about to leave tomorrow. So I
    //  wouldn't even really bother putting him in, except to flag that we need
    //  to actually put him in there. He did come the 25th of September, work
    //  trade. We are going to need the meter read for the fresh spot."
    //
    // He is on the board for one reason: the counter cannot take a closing read
    // on a site with nobody on it — Checkout finds the site from the
    // reservation. $0: his rent is hours, not money.
    guestName: 'Patrick Neuman', unitNumber: 'RV 06',
    checkIn: '2026-09-25', checkOut: '2026-10-22',
    totalAmount: 0, depositPaid: 0,
    notes: 'Work camper while buying a house. Rent covered by work trade — no cash due. '
      + 'Brought over from Campground Master 10/21 so his closing electric read can be taken at the counter.',
    externalRef: 'CGM-site6-neuman',
  },
  {
    // "Jerry Emerson is a seasonal work camper. He will be coming in. I don't
    //  know if it'll be exactly December 1st. They usually come within a few
    //  days of that each year. They do like Space 3."
    //
    // Locked to RV 03: they were promised it and come back to it every year.
    // The arrival is Campground Master's December 1 — a few days either way is a
    // date edit at the desk, and the lock means nothing gets packed onto the
    // site while they are on the road.
    guestName: 'Jerry Amerson', unitNumber: 'RV 03',
    checkIn: '2026-12-01', checkOut: '2027-04-21',
    totalAmount: 0, depositPaid: 0,
    notes: 'Seasonal work camper, comes back within a few days of Dec 1 each year and likes Space 3. '
      + 'Rent covered by work trade — no cash due. Brought over from Campground Master 10/21.',
    externalRef: 'CGM-site3-amerson',
  },
]

async function main(): Promise<void> {
  const commit = process.argv.includes('--apply')
  const prop = await queryOne<{ name: string }>(`SELECT name FROM properties WHERE id = $1`, [MOUNTAIN_VIEW.propertyId])
  const owner = await queryOne<{ user_id: string }>(
    `SELECT owner_user_id AS user_id FROM properties WHERE id = $1`, [MOUNTAIN_VIEW.propertyId])
  if (!prop || !owner?.user_id) throw new Error('Mountain View or its owner is not where it was')
  console.log(`${commit ? 'APPLY' : 'DRY RUN (nothing written)'} — ${prop.name}, ${ROWS.length} reservations`)
  const out = await runReservationImport({
    ...MOUNTAIN_VIEW, door: 'hand', rows: ROWS, byUserId: owner.user_id, commit,
  })
  for (const r of out.rows) {
    console.log(`\n  ${r.guestName || '(no name)'} — asked for ${r.unitNumber || 'no site'}, ${r.checkIn} → ${r.checkOut}`)
    console.log(`    lands on ${r.siteNumber ?? '(nowhere yet)'}`
      + ` · ${r.lockedToSite ? 'LOCKED to it (promised)' : r.placedByGam ? 'placed by GAM, movable' : 'not placed'}`
      + ` · ${r.nights ?? '?'} nights · total ${r.totalAmount ?? 0}`
      + (r.alreadyIn ? ' · ALREADY ON THE BOARD' : ''))
    for (const i of r.issues) console.log(`    [${i.severity}] ${i.message}`)
  }
  for (const n of out.notes) console.log(`\n  note: ${n}`)
  console.log(`\n  ${JSON.stringify(out.summary)}`)
  if (out.committed) console.log(`  committed: ${JSON.stringify(out.committed)}`)
  if (!commit) console.log('\nNothing written. Re-run with --apply to write.')
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1) })
}
