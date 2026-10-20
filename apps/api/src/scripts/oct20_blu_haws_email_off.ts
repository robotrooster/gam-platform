/**
 * 10/20 (Nic) — one-time: Blu Haws (TruBlu Management LLC) asked for the emails
 * to stop.
 *
 * He sat with Nic on a call on 10/19 at 11:48 and unchecked every box the
 * settings page showed him. Fifteen rows saved, timestamped. He kept getting
 * email, two ways:
 *
 *   1. TWENTY-TWO types GAM has actually sent him had no box anywhere, and a
 *      missing preference row means email-ON (services/notifications).
 *   2. Three of the fifteen he DID answer read email-on again by the end of the
 *      call (lease_expiring 11:49:41, maintenance_submitted 11:49:41,
 *      tenant_invite_accepted 11:50:33 — created off, updated on a minute
 *      later). The old page showed no sign a save was in flight, so a second
 *      click on a box that still looked ticked wrote TRUE back.
 *
 * Both roots are fixed in code (one notification catalog the page is derived
 * from, the compiler enforcing it on createNotification, and a box that is
 * disabled while its own save runs). This script fixes HIS DATA: every
 * non-critical type on his page goes email-off, in-app ON — Nic: "he told Nic he
 * would rather log in and see what needs attention."
 *
 * The five GAM always sends are left exactly as they are. They cannot be turned
 * off and the page says so on their own line.
 *
 *   npx ts-node -T src/scripts/oct20_blu_haws_email_off.ts           (dry run, writes nothing)
 *   npx ts-node -T src/scripts/oct20_blu_haws_email_off.ts --apply
 */
import { db } from '../db'
import {
  notificationCatalogFor, isCriticalNotificationType, notificationLabel,
} from '@gam/shared'

const APPLY = process.argv.includes('--apply')
const BLU_EMAIL = 'hawshomes.llc@gmail.com'

interface Row { type: string; email_enabled: boolean; in_app_enabled: boolean }

const show = (rows: Row[]) => rows.length === 0
  ? '    (no rows)'
  : rows.map(r => `    ${r.email_enabled ? 'EMAIL ON ' : 'email off'}  ${r.in_app_enabled ? 'in-app on ' : 'IN-APP OFF'}  ${notificationLabel(r.type)}  [${r.type}]`).join('\n')

async function main() {
  const who = await db.query<{ id: string; email: string; first_name: string; last_name: string; business_name: string | null }>(
    `SELECT u.id, u.email, u.first_name, u.last_name, l.business_name
       FROM users u LEFT JOIN landlords l ON l.user_id = u.id
      WHERE lower(u.email) = lower($1)`, [BLU_EMAIL])
  if (who.rows.length !== 1) throw new Error(`expected one account for ${BLU_EMAIL}, found ${who.rows.length}`)
  const user = who.rows[0]!
  console.log(`\n${user.first_name} ${user.last_name} — ${user.business_name ?? 'no company name'} <${user.email}>`)
  console.log(`user ${user.id}\n`)

  const before = (await db.query<Row>(
    `SELECT type, email_enabled, in_app_enabled FROM notification_preferences
      WHERE user_id = $1 ORDER BY type`, [user.id])).rows
  console.log(`BEFORE — ${before.length} rows, ${before.filter(r => r.email_enabled).length} of them still emailing:`)
  console.log(show(before))

  // Everything on HIS page (he is the account holder, so that includes the
  // birthday email) except the five GAM always sends.
  const targets = notificationCatalogFor('landlord', { isAccountHolder: true })
    .filter(e => !isCriticalNotificationType(e.type))
    .map(e => e.type)

  const had = new Map(before.map(r => [r.type, r]))
  const newRows = targets.filter(t => !had.has(t))
  const flipped = targets.filter(t => had.get(t)?.email_enabled === true)
  const inAppFixed = targets.filter(t => had.get(t)?.in_app_enabled === false)

  console.log(`\nWHAT THIS DOES — ${targets.length} non-critical types on his page:`)
  console.log(`  ${newRows.length} types he was never asked about (these are the ones still emailing him):`)
  for (const t of newRows) console.log(`    + ${notificationLabel(t)}  [${t}]`)
  console.log(`  ${flipped.length} he answered that read email-ON again:`)
  for (const t of flipped) console.log(`    ! ${notificationLabel(t)}  [${t}]`)
  console.log(`  ${inAppFixed.length} with in-app off, turned back on (he wants to see them when he signs in)`)
  const criticals = before.filter(r => isCriticalNotificationType(r.type))
  console.log(`  ${criticals.length} rows for the five GAM always sends: left exactly as they are`)
  /**
   * Rows he has that are NOT on his page, left alone. Two kinds, and both are
   * the same drift from the other direction:
   *
   *   'rent_failed', 'disbursement_sent' — nothing has ever sent these. The old
   *   page offered boxes for email that did not exist.
   *
   *   'ach_retry_scheduled', 'ach_retries_exhausted' — these are the RESIDENT's
   *   copies of those two notices. The old landlord page offered him the
   *   tenant's versions, so his "off" did nothing either way; the landlord's own
   *   copies are ach_retry_scheduled_info and ach_retries_exhausted_landlord,
   *   which had no box at all and are in the list above.
   *
   * Rewriting dead rows would only muddy the timestamps on what he answered.
   */
  const offPage = before.filter(r => !targets.includes(r.type) && !isCriticalNotificationType(r.type))
  console.log(`  ${offPage.length} rows that are not on his page at all — nothing sends them, or they are`)
  console.log(`      the resident's copy of a notice rather than the landlord's: left alone`)
  for (const r of offPage) console.log(`    · ${notificationLabel(r.type)}  [${r.type}]`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.\n')
    return
  }

  await db.query(`
    INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
    SELECT $1, t, FALSE, TRUE FROM unnest($2::text[]) AS s(t)
    ON CONFLICT (user_id, type)
    DO UPDATE SET email_enabled = FALSE, in_app_enabled = TRUE, updated_at = NOW()`,
    [user.id, targets])

  const after = (await db.query<Row>(
    `SELECT type, email_enabled, in_app_enabled FROM notification_preferences
      WHERE user_id = $1 ORDER BY type`, [user.id])).rows
  console.log(`\nAFTER — ${after.length} rows, ${after.filter(r => r.email_enabled).length} of them still emailing:`)
  console.log(show(after))

  const stillEmailing = after.filter(r => r.email_enabled)
  const unexpected = stillEmailing.filter(r => !isCriticalNotificationType(r.type))
  if (unexpected.length) throw new Error(`these still email and should not: ${unexpected.map(r => r.type).join(', ')}`)
  console.log(`\nDone. The only email GAM will send him now is the five it always sends.\n`)
}

main()
  .then(() => db.end())
  .catch(async (e) => { console.error(e); await db.end(); process.exit(1) })
