/**
 * 10/24 (Nic) — HEATHER BOWMAN'S BACKGROUND CHECK, COUNTRY ACRES, NO UNIT.
 *
 *   "I also need to send 4 Country Acres a link scoped to Country Acres for a
 *    background check for Heather Bowman... Do not scope it to a unit yet. I
 *    know we're still building stuff and there's going to be a little change of
 *    plans after we get to that point, but just send her the background check,
 *    non-scoped to a unit, just scoped to the property so that we can get her
 *    processed while we make our other fixes."
 *
 * This is the MH 28 takeover: Susie McCoy is leaving and Heather is taking the
 * spot and the home-installment sale. Everybody gets screened who is not an
 * onboarding-era or returning resident, and the screening is the thing that has
 * to pass before she is added to the lease — so it goes out now, ahead of the
 * build.
 *
 * It does exactly what POST /properties/:id/apply-link/send does, because that
 * route is the one door: the link carries the landlord and the PROPERTY and
 * nothing else, so no unit is implied and none has to be chosen yet.
 *
 * DRY RUN BY DEFAULT.
 *   cd apps/api && npx ts-node -T src/scripts/oct24_screen_heather_bowman.ts
 *   cd apps/api && EMAIL_SEND_LIVE=1 npx ts-node -T src/scripts/oct24_screen_heather_bowman.ts --apply
 */
import { queryOne } from '../db'

const COUNTRY_ACRES = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const TO = 'bowmanheather814@gmail.com'
const NAME = 'Heather Bowman'

;(async () => {
  const apply = process.argv.includes('--apply')
  const prop = await queryOne<any>(
    `SELECT id, name, landlord_id, booking_slug, state FROM properties WHERE id = $1`, [COUNTRY_ACRES])
  if (!prop) throw new Error('Country Acres not found')
  if (!prop.booking_slug) throw new Error(`${prop.name} has no booking address, so there is no application link.`)

  const { screeningIntakeFee } = await import('../routes/background')
  const { emailStartScreening } = await import('../services/email')
  const { portalLink } = await import('../lib/portalUrls')
  const fee = await screeningIntakeFee(prop.state ?? null)
  const qs = new URLSearchParams({ landlordId: prop.landlord_id, propertyId: prop.id })
  const url = portalLink('tenant', `background-check?${qs.toString()}`)

  console.log(`${apply ? 'SENDING' : 'DRY RUN'} — ${NAME} <${TO}>`)
  console.log(`  property : ${prop.name} (no unit)`)
  console.log(`  price    : $${fee.total.toFixed(2)}`)
  console.log(`  link     : ${url}`)
  if (!apply) { console.log('\nNothing sent. Re-run with EMAIL_SEND_LIVE=1 ... --apply'); process.exit(0) }

  await emailStartScreening(TO, { name: NAME, propertyName: prop.name, url, price: fee.total },
    { landlordId: prop.landlord_id })
  const log = await queryOne<any>(
    `SELECT status, to_address, subject FROM email_send_log WHERE lower(to_address) = $1
      ORDER BY created_at DESC LIMIT 1`, [TO])
  console.log(`\nemail_send_log: ${log ? `${log.status} — "${log.subject}"` : 'NO ROW'}`)
  process.exit(0)
})().catch(e => { console.error(e?.message || e); process.exit(1) })
