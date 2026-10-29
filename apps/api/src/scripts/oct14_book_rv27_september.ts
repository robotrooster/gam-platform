/**
 * 10/14 (Nic) — Andres Razo's month at Mountain View RV 27 goes on the
 * schedule for September, when he was there.
 *
 *   "RV 27 / Andres Razo's month of site rent by pay link: book the stay for
 *    when he was actually there, September ('make sure its when we was
 *    actually here not when he finally paid. he was here september')."
 *
 * His pay link (made 9/18, paid by card online Oct 6: $752.17 + a $26.88 card
 * fee) sold "RV site — monthly" ($589.00, the register's month stay item) with
 * two electric lines, but no stay was ever put on the schedule, so RV 27 reads
 * Vacant and the $589 is register money with no stay. This books the stay the
 * money already paid for — one calendar month on RV 27 from September 1 (the
 * stay item buys one month: Sep 1 → Oct 1, 30 nights; --check-in=YYYY-MM-DD
 * moves the arrival) — and ties that money to it:
 *
 *   1. unit_bookings: RV 27, Andres Razo (his pay link's email; his resident
 *      record when exactly one has that email), checked out, a month stay
 *      ('month_to_month', no lease — stay_terms 'stay'), its price the $589.00
 *      the line charged, paid in full the moment his pay link was paid
 *      (deposit_amount, deposit_paid_at and balance_paid_at, as the register
 *      writes a stay paid whole), the sale it came from (pos_transaction_id).
 *      Written as already over, so nothing that runs before or on arrival
 *      (the site reveal, the arrival-day balance bill, a check-in screening
 *      wait) ever acts on it, and nothing is emailed to anyone.
 *   2. stay_payments: the sale's $589.00 toward that stay (as
 *      stayPayments.recordSaleTowardStay writes it, the card fee's share by
 *      saleShareFees), paid when the link was paid. NO new charge: the money is
 *      the money already taken, now said to be the stay's.
 *   3. GAM Books: the sale is marked for posting again (ledger_outbox), so its
 *      $589.00 is posted as a stay's money (Guest deposits, then earned as
 *      Stay income in the stay's month) instead of register sales — the
 *      $752.17 counted once, never twice (the stay's own posting is marked by
 *      the capture triggers on the two rows above).
 *
 * What it does NOT do, said out loud: no charge, no refund, no email, no change
 * to the sale or the pay link, no GAM platform fee. The platform fee the stay
 * would cause is REPORTED (see the dry run): by the bill's rule a month stay
 * with no lease is an occupied space in each month it overlaps
 * (services/billableUnits occupiedSpacesSql), so RV 27 becomes one more
 * occupied space in September; September's fee was billed on the 1st's run and
 * nothing re-bills a month that has passed (the nightly top-up bills only the
 * current month), so no new fee is charged — the report says what it would be.
 * And a side effect on the desk: a stay that checked out within 60 days on a
 * submetered site wants a closing read dated on or after its check-out
 * (services/utilityReadingRuns) — RV 27's last read is Sep 30, before an Oct 1
 * check-out — so the dry run says whether GAM will ask for one at RV 27 (a
 * turnover read: it bills nobody) and hold a new check-in there until it is in.
 *
 * Refuses, changing nothing, unless it finds exactly one paid pay link for him
 * at the property with exactly one month stay line, RV 27 free for those dates,
 * and no stay already tied to the sale (run twice, the second run finds it
 * done).
 *
 * DRY RUN BY DEFAULT — read-only (it reads production and writes nothing; it
 * can run with default_transaction_read_only on). --apply writes it all in one
 * transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct14_book_rv27_september.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct14_book_rv27_september.ts --apply
 *   (optional) --check-in=2026-09-01
 */
import type { PoolClient } from 'pg'
import { addCalendarMonths, stayNightsBetween } from '@gam/shared'
import { getClient } from '../db'
import { saleShareFees } from '../services/stayPayments'
import { occupiedSpacesSql } from '../services/billableUnits'
import { siteIsFree } from '../services/registerStay'

/** Who and where, as production has them (read 10/14). */
export const RV27 = {
  landlordId: '96ec7df3-362d-4777-b54c-e9604313820f',
  propertyId: 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01',
  unitNumber: 'RV 27',
  payer: 'Andres Razo',
  checkIn: '2026-09-01',
} as const
export type Rv27Target = { landlordId: string; propertyId: string; unitNumber: string; payer: string; checkIn: string }

export const RV27_NOTE = 'Booked 10/14 (Nic) from his pay link paid Oct 6: he was here in September.'

export interface Rv27Plan {
  refused: string | null
  /** The stay is already tied to the sale: nothing to do. */
  done: { bookingId: string } | null
  sale: {
    id: string; payLinkId: string; paidAt: string; paidOn: string; method: string; paymentIntentId: string | null
    total: string; surcharge: string | null; platformFee: string | null; stayLine: string; stayLineMoney: number
  } | null
  booking: {
    unitId: string; unitNumber: string; guestName: string; guestEmail: string | null; tenantId: string | null
    checkIn: string; checkOut: string; nights: number; total: number
  } | null
  stayPayment: { toward: number; cardFee: number; landlordCardFee: number } | null
  /** The GAM platform fee the stay would cause (reported, never charged here). */
  platformFee: {
    month: string; alreadyCounted: boolean; ratePerSpace: number
    billed: { spaces: number; amount: string; on: string } | null
    wouldAdd: number
    words: string
  } | null
  /** The desk side effect: a closing read GAM will ask for at the site. */
  closingRead: string | null
  /** The sale's own posting in GAM Books, when it has one. */
  ledger: { posted: boolean } | null
}

/** Read-only: what --apply would write. */
export async function planRv27September(client: Pick<PoolClient, 'query'>, t: Rv27Target = RV27): Promise<Rv27Plan> {
  const plan: Rv27Plan = { refused: null, done: null, sale: null, booking: null, stayPayment: null, platformFee: null, closingRead: null, ledger: null }
  const refuse = (why: string) => { plan.refused = why; return plan }
  const links = (await client.query<{
    link_id: string; customer_email: string | null; sale_id: string; method: string; pi: string | null; total: string
    surcharge: string | null; platform_fee: string | null; paid_at: Date; paid_on: string; status: string; tz: string
  }>(
    `SELECT pl.id AS link_id, pl.customer_email, t.id AS sale_id, t.payment_method AS method, t.stripe_payment_intent_id AS pi,
            t.total::text AS total, t.surcharge::text AS surcharge, t.platform_fee::text AS platform_fee, t.created_at AS paid_at,
            to_char((t.created_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS paid_on,
            t.status, COALESCE(p.timezone, 'America/Phoenix') AS tz
       FROM pos_pay_links pl
       JOIN pos_transactions t ON t.id = pl.pos_transaction_id
       JOIN properties p ON p.id = pl.property_id
      WHERE pl.property_id = $1 AND pl.landlord_id = $2 AND pl.status = 'paid'
        AND LOWER(TRIM(pl.customer_name)) = LOWER($3)
        AND EXISTS (SELECT 1 FROM pos_transaction_items i JOIN pos_items si ON si.id = i.item_id
                     WHERE i.transaction_id = t.id AND si.stay_unit IS NOT NULL)`,
    [t.propertyId, t.landlordId, t.payer])).rows
  if (links.length !== 1) return refuse(`expected exactly one paid pay link for ${t.payer} with a stay item at the property, found ${links.length}`)
  const l = links[0]
  if (l.status === 'voided') return refuse('the sale was voided')
  const lines = (await client.query<{ name: string; qty: string; subtotal: string; stay_unit: string }>(
    `SELECT i.item_name AS name, i.qty::text AS qty, i.subtotal::text AS subtotal, si.stay_unit
       FROM pos_transaction_items i JOIN pos_items si ON si.id = i.item_id
      WHERE i.transaction_id = $1 AND si.stay_unit IS NOT NULL`, [l.sale_id])).rows
  if (lines.length !== 1 || lines[0].stay_unit !== 'month' || !(Number(lines[0].qty) >= 1) || Number(lines[0].qty) % 1 !== 0) {
    return refuse(`expected one stay line of whole months on the sale, found ${lines.map(x => `${x.name} × ${x.qty} ${x.stay_unit}`).join('; ') || 'none'}`)
  }
  const line = lines[0]
  const money = Math.round(Number(line.subtotal) * 100) / 100
  plan.sale = {
    id: l.sale_id, payLinkId: l.link_id, paidAt: l.paid_at.toISOString(), paidOn: l.paid_on, method: l.method,
    paymentIntentId: l.pi, total: l.total, surcharge: l.surcharge, platformFee: l.platform_fee, stayLine: line.name, stayLineMoney: money,
  }
  const tied = (await client.query<{ booking_id: string }>(
    `SELECT booking_id FROM stay_payments WHERE pos_transaction_id = $1 ORDER BY paid_at, id LIMIT 1`, [l.sale_id])).rows[0]
  if (tied) { plan.done = { bookingId: tied.booking_id }; return plan }

  const unit = (await client.query<{ id: string; unit_number: string }>(
    `SELECT id, unit_number FROM units WHERE property_id = $1 AND unit_number = $2 AND retired_at IS NULL`,
    [t.propertyId, t.unitNumber])).rows
  if (unit.length !== 1) return refuse(`expected one space ${t.unitNumber} at the property, found ${unit.length}`)
  const checkIn = t.checkIn
  const checkOut = addCalendarMonths(checkIn, Number(line.qty))
  if (!await siteIsFree(client as PoolClient, unit[0].id, checkIn, checkOut)) {
    return refuse(`${t.unitNumber} is not free ${checkIn} → ${checkOut} (another stay, a lease, or out of order)`)
  }
  const people = (await client.query<{ id: string }>(
    `SELECT t.id FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE $1::text IS NOT NULL AND LOWER(u.email) = $1::text`, [l.customer_email?.trim().toLowerCase() || null])).rows
  plan.booking = {
    unitId: unit[0].id, unitNumber: unit[0].unit_number, guestName: t.payer, guestEmail: l.customer_email?.trim() || null,
    tenantId: people.length === 1 ? people[0].id : null,
    checkIn, checkOut, nights: stayNightsBetween(checkIn, checkOut), total: money,
  }
  plan.stayPayment = {
    toward: money,
    ...saleShareFees({ payment_method: l.method, stripe_payment_intent_id: l.pi, total: l.total, surcharge: l.surcharge, platform_fee: l.platform_fee }, money),
  }

  // The GAM platform fee it would cause: one more occupied space in each month
  // the stay overlaps, unless the space already counts there.
  const month = `${checkIn.slice(0, 7)}-01`
  const counted = (await client.query<{ yes: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM (${occupiedSpacesSql('$1::uuid', '$2::date', { ownerUseFromJournal: true })}) s WHERE s.unit_id = $3) AS yes`,
    [t.propertyId, month, unit[0].id])).rows[0]?.yes === true
  const rate = Number((await client.query<{ rate: string }>(
    `SELECT COALESCE(o.rate_per_unit, pfc.rate_per_unit)::text AS rate
       FROM platform_fee_config pfc
       LEFT JOIN landlord_platform_fee_overrides o ON o.landlord_id = $1 AND o.effective_until IS NULL
      WHERE pfc.effective_until IS NULL LIMIT 1`, [t.landlordId])).rows[0]?.rate ?? 2)
  const acc = (await client.query<{ spaces: number; amount: string; on: string }>(
    `SELECT total_billable AS spaces, total_amount::text AS amount, to_char(created_at, 'YYYY-MM-DD') AS on
       FROM platform_fee_accruals WHERE property_id = $1 AND landlord_id = $2 AND accrual_month = $3::date`,
    [t.propertyId, t.landlordId, month])).rows[0] ?? null
  const wouldAdd = counted ? 0 : rate
  const monthWord = new Date(`${month}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  plan.platformFee = {
    month, alreadyCounted: counted, ratePerSpace: rate, billed: acc, wouldAdd,
    words: counted
      ? `${t.unitNumber} already counts as occupied in ${monthWord}: the stay adds no GAM platform fee.`
      : `By the bill's rule the stay makes ${t.unitNumber} one more occupied space in ${monthWord}: $${rate.toFixed(2)} of GAM platform fee. `
        + (acc
          ? `${monthWord} was billed on ${acc.on} ($${acc.amount} for ${acc.spaces} spaces) and nothing re-bills a month that has passed (the nightly top-up bills only the current month), so NO new fee is charged — not by this script, not by any job.`
          : `${monthWord} has no fee billed yet: its monthly run would count it.`),
  }

  // A closing read GAM will ask for (utilityReadingRuns): within 60 days of
  // the check-out, a submeter with no read on or after it.
  const meters = (await client.query<{ label: string; last: string | null }>(
    `SELECT m.label, to_char(MAX(r.reading_date), 'YYYY-MM-DD') AS last
       FROM utility_meter_units mu
       JOIN utility_meters m ON m.id = mu.meter_id AND m.billing_method = 'submeter' AND m.out_of_service = false
       LEFT JOIN utility_meter_readings r ON r.meter_id = m.id
      WHERE mu.unit_id = $1
      GROUP BY m.id, m.label`, [unit[0].id])).rows
  const today = (await client.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [l.tz])).rows[0].d
  const within60 = stayNightsBetween(checkOut, today) <= 60
  const unread = meters.filter(m => !m.last || m.last < checkOut)
  plan.closingRead = within60 && unread.length
    ? `GAM will ask for a closing read at ${t.unitNumber} (${unread.map(m => `${m.label}, last read ${m.last ?? 'never'}`).join('; ')}) — a stay turnover read dated ${checkOut} or later, which bills nobody — and hold a new check-in at ${t.unitNumber} until it is entered. The next monthly read clears it.`
    : null
  plan.ledger = { posted: (await client.query(
    `SELECT 1 FROM ledger_postings WHERE source_type = 'pos_sale' AND source_id = $1 AND superseded_at IS NULL LIMIT 1`, [l.sale_id])).rows.length > 0 }
  return plan
}

/** Inside the caller's transaction: writes what the plan says. Returns the new booking's id. */
export async function applyRv27September(client: Pick<PoolClient, 'query'>, plan: Rv27Plan, t: Rv27Target = RV27): Promise<string> {
  if (plan.refused || plan.done || !plan.sale || !plan.booking || !plan.stayPayment) throw new Error('Nothing to apply')
  const b = plan.booking, s = plan.sale, sp = plan.stayPayment
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`unit-booking:${b.unitId}`])
  if (!await siteIsFree(client as PoolClient, b.unitId, b.checkIn, b.checkOut)) throw new Error(`${b.unitNumber} is no longer free`)
  const id = (await client.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, booked_check_out, nights, total_amount,
        status, lease_type, source, pos_transaction_id, deposit_amount, deposit_paid_at, balance_paid_at,
        stay_terms, tenant_id, screening_required, notes)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$6::date,$7,$8,
             'checked_out','month_to_month','register',$9,$8,$10::timestamptz,$10::timestamptz,
             'stay',$11,FALSE,$12)
     RETURNING id`,
    [b.unitId, t.landlordId, b.guestName, b.guestEmail, b.checkIn, b.checkOut, b.nights, b.total.toFixed(2),
     s.id, s.paidAt, b.tenantId, RV27_NOTE])).rows[0].id
  await client.query(
    `INSERT INTO stay_payments
       (booking_id, landlord_id, kind, pos_transaction_id, stripe_payment_intent_id, method, toward_stay, card_fee, landlord_card_fee, paid_at)
     VALUES ($1,$2,'pos_sale',$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
    [id, t.landlordId, s.id, s.paymentIntentId, s.method, sp.toward.toFixed(2), sp.cardFee.toFixed(2), sp.landlordCardFee.toFixed(2), s.paidAt])
  // GAM Books: the sale's posting is redone with its stay share as the stay's.
  await client.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('pos_sale', $1, $2::uuid)`, [s.id, t.landlordId])
  return id
}

function words(plan: Rv27Plan): string[] {
  const out: string[] = []
  if (plan.refused) return [`  Refused, nothing changed: ${plan.refused}`]
  if (plan.done) return [`  Already done: the sale is tied to stay ${plan.done.bookingId}. Nothing to change.`]
  const s = plan.sale!, b = plan.booking!, sp = plan.stayPayment!
  out.push(`  The money: pay link ${s.payLinkId}, sale ${s.id}, paid ${s.paidOn} by ${s.method} — $${s.total} in all (card fee on top $${s.surcharge ?? '0.00'}).`)
  out.push(`    Its stay line: "${s.stayLine}" $${s.stayLineMoney.toFixed(2)}.`)
  out.push(`  Would create the stay (unit_bookings): ${b.unitNumber} (${b.unitId}), ${b.guestName}${b.guestEmail ? ` <${b.guestEmail}>` : ''}`
    + `${b.tenantId ? `, resident ${b.tenantId} (the one with that email)` : ', no resident record matched'},`)
  out.push(`    ${b.checkIn} → ${b.checkOut} (${b.nights} nights), a month stay with no lease, checked out, price $${b.total.toFixed(2)},`)
  out.push(`    paid in full ${s.paidOn} (deposit_amount $${b.total.toFixed(2)}, deposit_paid_at = balance_paid_at = the sale), from sale ${s.id}.`)
  out.push(`  Would tie the money to it (stay_payments): $${sp.toward.toFixed(2)} toward the stay from sale ${s.id}, ${s.method}, card fee share $${sp.cardFee.toFixed(2)}, landlord card fee $${sp.landlordCardFee.toFixed(2)}, paid ${s.paidOn}.`)
  out.push('  New charges: none. Billed twice: nothing — the $589.00 is the money already paid, now said to be the stay\'s. Emails: none.')
  out.push(`  GAM Books: ${plan.ledger?.posted ? 'the sale is posted today as register sales; ' : ''}it is marked to post again so the $${sp.toward.toFixed(2)} is the stay's money (Guest deposits, earned as Stay income in its month) — counted once.`)
  out.push(`  GAM platform fee: ${plan.platformFee!.words}`)
  out.push(`  The desk: ${plan.closingRead ?? 'no closing read is asked for.'}`)
  return out
}

function checkInArg(): string {
  const a = process.argv.find(x => x.startsWith('--check-in='))
  const v = a ? a.slice('--check-in='.length) : RV27.checkIn
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--check-in must be YYYY-MM-DD, got ${v}`)
  return v
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const target = { ...RV27, checkIn: checkInArg() }
  const c = await getClient()
  try {
    if (!apply) {
      const plan = await planRv27September(c, target)
      console.log('DRY RUN (read-only)')
      for (const w of words(plan)) console.log(w)
      console.log('Nothing written. Re-run with --apply to write.')
      return
    }
    await c.query('BEGIN')
    const plan = await planRv27September(c, target)
    console.log('APPLY')
    for (const w of words(plan)) console.log(w)
    if (plan.refused || plan.done) { await c.query('ROLLBACK'); return }
    const id = await applyRv27September(c, plan, target)
    await c.query('COMMIT')
    console.log(`Committed: stay ${id}.`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
