/**
 * 10/20 (Nic) — THE MORNING-OF SITE REVEAL, AND WHO IT IS ALLOWED TO REACH.
 *
 *   "The import does not send the emails because one, you're going to be
 *    sending emails to people that don't need them... They may have already
 *    gotten a confirmation on a space number. Our system with compression and
 *    expansion is going to kind of screw that up if they think they're locked
 *    to a specific site already. So I don't want the import to do anything."
 *
 * The importer sends nothing, and there is a test on that (routes/
 * reservationImport.test.ts). But the import writes a row shaped EXACTLY like
 * the one the 15-minute site-reveal cron looks for — status 'confirmed', a
 * guest email, no reveal stamp — so bringing the season file in at 2pm emailed
 * a site number to every guest arriving that day within fifteen minutes, with
 * nobody pressing anything. The import sending nothing is worth nothing if a
 * cron sends it an hour later, which is what this file is here to stop.
 *
 * The rule it holds (jobs/scheduler revealTodaysSites): GAM reveals a site only
 * to a guest it has told about this reservation itself — the reservation was
 * taken here, or a person deliberately sent the confirmation. The two "does
 * send" cases below matter as much as the two "does not": a fix that quietly
 * turned the reveal off for everybody would leave arriving guests with no idea
 * where to park, and these catch that.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

let revealTodaysSites: (now?: Date) => Promise<void>
beforeEach(async () => {
  await cleanupAllSchema()
  ;({ revealTodaysSites } = await import('./scheduler'))
})

/** 3:00pm at Mountain View on 2027-03-06 — well past the 6:30am reveal hour. */
const AFTERNOON = new Date('2027-03-06T22:00:00Z')
/** 5:00am the same day — before the reveal hour, when nothing goes out. */
const BEFORE_DAWN = new Date('2027-03-06T12:00:00Z')
const ARRIVES = '2027-03-06'
const LEAVES = '2027-03-13'

/** Mountain View RV Park, Phoenix time, two sites. */
async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties SET name = 'Mountain View RV Park', timezone = 'America/Phoenix' WHERE id = $1`,
      [propertyId])
    const sites: Record<string, string> = {}
    for (const number of ['RV 12', 'RV 14']) {
      const u = await c.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, weekly_rate, monthly_rate, is_bookable, lease_types_allowed,
                            check_in_time)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',49,269,589,TRUE,ARRAY['nightly','weekly','month_to_month'],'2:00 PM')
         RETURNING id`, [propertyId, landlordId, number])
      sites[number] = u.rows[0].id
    }
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, sites }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A confirmed week arriving today. `migrated` writes the row the importer
 * writes — same columns, same values — so this test breaks if the import's
 * shape ever stops matching what the cron is being asked to ignore.
 */
async function reservation(f: any, o: {
  site: string
  email: string
  migrated?: { door: 'file' | 'hand'; toldOutsideGam: boolean }
  confirmationSentAt?: Date
}): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email,
        lease_type, check_in, check_out, booked_check_out, nights,
        total_amount, platform_fee, status, source,
        migrated_at, migrated_by, migrated_door, told_outside_gam,
        confirmation_sent_at, confirmation_sent_by)
     VALUES ($1,$2,$3,$4,
             'weekly',$5,$6,$6,7,
             286.75,0,'confirmed','direct',
             CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() END,
             CASE WHEN $7::text IS NULL THEN NULL ELSE $8::uuid END,
             $7,COALESCE($9::boolean, FALSE),
             $10,CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE $8::uuid END)
     RETURNING id`,
    [f.sites[o.site], f.landlordId, 'Dale Carter', o.email,
     ARRIVES, LEAVES,
     o.migrated?.door ?? null, f.userId, o.migrated?.toldOutsideGam ?? null,
     o.confirmationSentAt ?? null])
  return r[0].id
}

const revealsSent = () => query<any>(
  `SELECT to_email FROM email_send_log WHERE category = 'booking_site_reveal' ORDER BY to_email`)

const revealStamp = async (id: string) => (await query<any>(
  `SELECT site_reveal_sent_at FROM unit_bookings WHERE id = $1`, [id]))[0].site_reveal_sent_at

// ════════════════════════════════════════════════════════════════════════════

describe('a guest GAM has not spoken to', () => {
  it('a reservation brought in from the old system is NOT emailed its site on arrival morning', async () => {
    const f = await seed()
    // The row the file importer writes: already told by Nic, in the old system,
    // and arriving today — the exact row that was being emailed.
    const id = await reservation(f, {
      site: 'RV 14', email: 'dale@test.dev', migrated: { door: 'file', toldOutsideGam: true },
    })

    await revealTodaysSites(AFTERNOON)

    expect(await revealsSent()).toEqual([])
    // And the movement fence is NOT set, so the packer can still place them —
    // a stamp written without an email would pin a guest to a site nobody told
    // them about.
    expect(await revealStamp(id)).toBeNull()
  })

  it('a hand-typed one off a text thread is not emailed either, told or not', async () => {
    const f = await seed()
    // 'Already told' unticked: nobody has said anything to this guest, which is
    // not a reason for GAM to be the first thing they hear from, by robot, on
    // the morning they drive in.
    await reservation(f, {
      site: 'RV 12', email: 'marie@test.dev', migrated: { door: 'hand', toldOutsideGam: false },
    })

    await revealTodaysSites(AFTERNOON)

    expect(await revealsSent()).toEqual([])
  })
})

describe('a guest GAM has told', () => {
  it('a reservation taken here IS emailed its site — the reveal still works', async () => {
    const f = await seed()
    const id = await reservation(f, { site: 'RV 14', email: 'tom@test.dev' })

    await revealTodaysSites(AFTERNOON)

    expect(await revealsSent()).toEqual([{ to_email: 'tom@test.dev' }])
    expect(await revealStamp(id)).not.toBeNull()
  })

  it('a brought-in reservation whose confirmation a person sent IS emailed its site', async () => {
    const f = await seed()
    // Somebody pressed send on the confirmation (routes/bookings, which refuses
    // this one without a deliberate second ask). GAM is in the conversation
    // now, so the site follows on arrival morning like anybody else's.
    await reservation(f, {
      site: 'RV 12', email: 'june@test.dev', migrated: { door: 'file', toldOutsideGam: true },
      confirmationSentAt: new Date('2027-02-01T18:00:00Z'),
    })

    await revealTodaysSites(AFTERNOON)

    expect(await revealsSent()).toEqual([{ to_email: 'june@test.dev' }])
  })

  it('still waits for 6:30am local — the hour is not what changed', async () => {
    const f = await seed()
    await reservation(f, { site: 'RV 14', email: 'tom@test.dev' })

    await revealTodaysSites(BEFORE_DAWN)
    expect(await revealsSent()).toEqual([])

    await revealTodaysSites(AFTERNOON)
    expect(await revealsSent()).toEqual([{ to_email: 'tom@test.dev' }])
  })
})
