/**
 * 10/20 (Nic) — THE FINAL UTILITY BILL, RAISED AT THE REGISTER.
 *
 *   "I don't want it to generate a bill."
 *
 *   "desk picks the customer and gam should know the site from the reservation.
 *    no reason for the front counter to pick a space too"
 *
 * Somebody is standing at the counter settling up on their way out. The desk
 * reads their meter off the pole, types the figure, and the power goes on the
 * same ticket as the propane and the ice. That is all this file does.
 *
 * ── WHY IT IS NOT JUST THE EXISTING MOVE-OUT READ ───────────────────────────
 *
 * A move-out read entered anywhere else in GAM bills, INVOICES and EMAILS the
 * departing payer in one breath — "pay it from your portal, or it settles from
 * your deposit" (jobs/invoiceGeneration generateFinalUtilityInvoice). That is
 * exactly right for a read taken on a walk-round at month end. It is exactly
 * wrong with the payer in front of you: it creates a second place to pay one
 * bill, and the second place is the one with nobody standing at it.
 *
 * So the counter raises the bill and stops. The ticket IS the bill; paying it
 * closes the bill out. If it is not paid — they walk off, or the desk clears the
 * cart — the bill stays OWED and falls back to the ordinary route (their
 * invoice, or an emailed link), because the power was genuinely used and nothing
 * in GAM is written off by not being collected at a counter. Either way the
 * READING stands: it is the next arrival's starting point.
 *
 * ── WHAT THIS FILE DOES NOT DECIDE ──────────────────────────────────────────
 *
 * Almost everything. The hard questions were answered months ago and are asked
 * here rather than re-answered:
 *
 *   WHOSE usage is this — the same-day turnover, the guest who moved sites, the
 *     read entered a day late, the space move, the 30+ night stay paying through
 *     its utility service agreement: services/utilityBilling tryInsertBill.
 *   IS IT A WASH — they left early and the park kept their unused money, so
 *     their final utility is absorbed and billed to nobody:
 *     services/earlyDepartureWash, reached through the same tryInsertBill.
 *   IS THE FIGURE PLAUSIBLE — usage over its utility type's threshold, or a
 *     figure below the previous read on a meter nowhere near its ceiling:
 *     usageNeedsDoubleCheck and the same stored flag the monthly run sets.
 *   WHAT THE LINE LOOKS LIKE ON THE TICKET — services/utilityPayLink wrote it
 *     yesterday for the emailed version and this reuses it to the letter: no
 *     catalog item, the bill's own charge at the bill's own tax rate, naming its
 *     bill. Deviating would double-count the kilowatts in the recovery report.
 *
 * The one thing it genuinely decides is the arithmetic between a typed figure
 * and a dollar amount — and it decides it ONCE, in usageAndCharge below, used by
 * both the quote the desk confirms and the bill that is written. The figure on
 * the screen and the figure on the ticket cannot disagree, because they are the
 * same call.
 *
 * ── BLIND STAFF ENTRY, WITH ONE DELIBERATE WINDOW ───────────────────────────
 *
 * Staff field-entry shows no prior values and no error giveaways (S559). Asked
 * directly, Nic kept that here and opened one window in it: the USAGE and the
 * DOLLAR AMOUNT are shown for the desk to confirm before anything goes on the
 * ticket. They have to read the total out to a person who is about to pay it.
 *
 * Everything else stays shut. The quote never returns the previous read, and a
 * figure that has to be held gets the SAME sentence whether it came in too high
 * or too low (HELD_FOR_DOUBLE_CHECK) — anything that tells those apart is the
 * previous read, a guess at a time.
 */
import type { PoolClient } from 'pg'
import {
  UTILITY_TYPE_LABEL, UTILITY_UNIT_LABEL, UTILITY_USAGE_NOUN,
  meterReadingModulus, type UtilityType,
} from '@gam/shared'

import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { digitsOf } from './posPeople'
import {
  tryInsertBill, usageNeedsDoubleCheck, HELD_FOR_DOUBLE_CHECK,
  readingBarelyMoved, BARELY_MOVED_REVIEW_NOTE,
} from './utilityBilling'
import {
  payLinkLineNameForBill, billLineTaxRate, billTaxFitsItsCharge, billTaxDoesNotFitWords,
} from './utilityPayLink'
// 10/21 (Nic): what the stay itself still owes, by the reservation's own rule —
// the same figure its ticket and its pay link ask for, never a second opinion.
import { reservationDue } from './registerStay'
import { voidUnowedCharges } from './chargeVoids'
import { lockHousehold, moneyTakenOrMovingRowSql } from './moneyPredicates'

type Q = Pick<PoolClient, 'query'>

const round2 = (n: number) => Math.round(n * 100) / 100
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)
const money = (n: number) => `$${round2(n).toFixed(2)}`

/** Why the charge on somebody's invoice was voided when the desk collected it. */
export const COLLECTED_AT_THE_COUNTER =
  'Collected at the register — they settled it at the counter on their way out'

/** The note left on a bill the desk raised and nobody paid for. */
export const COUNTER_BILL_NOT_COLLECTED =
  'Raised at the register and not paid there — owed as usual'

// ─── D3: WHOSE SITE IS IT ────────────────────────────────────────────────────

/**
 * How the desk is told GAM has nobody. Named plainly, because a clerk who is
 * told "no match" starts typing variations of a name, and a name match is the
 * one thing a money decision in this codebase may not be made on.
 */
export const NOBODY_AT_THIS_PROPERTY =
  'GAM has nobody at this property with that email address or phone number, so there is no final bill to raise. '
  + 'Check the address or the number on their account, or ring the power up as its own sale.'

/** Said when the person is ours and has nothing here to close out. */
export const NOTHING_TO_CLOSE_OUT =
  'They have no reservation and no lease at this property, so there is no final bill to raise.'

/**
 * What the counter matched them on. Never a name — exact email, then exact
 * phone, and nothing else, because a fuzzy name match is how a money decision
 * lands on the wrong household.
 *
 * The words a person reads live beside the screen that renders them
 * (CLOSING_MATCH_LABEL in POSPage), the way ABSORBED_CHARGE_REASONS' labels do:
 * the day a second surface renders one of these, both move into
 * packages/shared and neither types the strings again.
 */
export const COUNTER_MATCHES = ['email', 'phone'] as const
export type CounterMatch = typeof COUNTER_MATCHES[number]

/** One submeter on the site, as the counter needs it to take a read. */
export interface CounterMeter {
  meterId: string
  utilityType: UtilityType
  /** What the landlord calls this meter on the Utilities page. */
  label: string
  /** How many digits are on the face, so the form can refuse an impossible figure. */
  digits: number | null
  /** 'kWh', 'gallons' — what the usage is counted in, for the confirm line. */
  usageUnit: string
  /** 'power', 'water' — for the sentence a short stay gets. */
  usageNoun: string
  /** TRUE when this meter has never been read, so there is nothing to measure from. */
  noBaseline: boolean
}

/**
 * One thing this person has at this property that a final read can close out: a
 * stay or a lease. NEVER a list of spaces — the space comes from the stay or the
 * lease, which is the whole of Nic's instruction. Two rigs means two of these
 * and the desk confirms which; it does not pick a space.
 */
export interface CounterClosing {
  kind: 'stay' | 'lease'
  /** The booking or the lease. */
  id: string
  unitId: string
  /** What the park calls the space — display_label prints, unit_number is the back-end name (S652). */
  spaceLabel: string
  /** The dates, so the desk can tell two of this person's stays apart. */
  from: string | null
  to: string | null
  /** Plain words for the row: "Stay — RV 27, Sep 3 to Oct 2". Never a raw enum. */
  what: string
  /**
   * 10/21 (Nic), the Checkout tab: who it is, for the list of people due out
   * (the desk has not picked anybody yet there). Null when the booking carries
   * no name.
   */
  who: string | null
  /**
   * 10/21 (Nic): "I want the determination of checking out to automatically
   * know all of the things to bill for, not just targeted electric." What is
   * STILL OWED on the stay itself — the reservation's own rule (registerStay
   * reservationDue), the same figure its ticket and its pay link ask for — so
   * the desk settling somebody up is told about it rather than finding out
   * after they have driven off. 0 when nothing is owed; null on a lease, whose
   * rent is its household's invoice and is never a register line.
   */
  owed: number | null
  /**
   * The payer behind it, structurally:
   *   'lease'              — a lease, billed per its meter setup.
   *   'service_agreement'  — a 30+ night stay with no lease, paying its own
   *                          utilities through its agreement.
   *   'in_the_rate'        — a nightly or weekly guest. Their power is in the
   *                          rate and is billed to NOBODY (D6).
   */
  payer: 'lease' | 'service_agreement' | 'in_the_rate'
  meters: CounterMeter[]
}

export interface CounterLookup {
  matchedBy: CounterMatch | null
  closings: CounterClosing[]
  /** The plain sentence to show when there is nothing to raise. */
  note: string | null
}

/**
 * The email and phone a picked person goes by, FROM THEIR OWN RECORD.
 *
 * Not from a box the clerk retyped: typing an address into this door is how a
 * final bill lands on a stranger with a similar name, and a name is the one
 * thing a money decision in GAM is never made on.
 *
 * Scoped to the company whose register this is — somebody the company has never
 * dealt with reads as nobody, and the honest answer upstream is the plain "GAM
 * has nobody at this property" sentence rather than a refusal. That costs
 * nothing even for Nic's own two LLCs: a person at the other park has no stay
 * and no lease at THIS property, so their list of things to close out here is
 * empty whichever way they were read.
 */
export async function counterPersonContact(
  q: Q, landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown },
): Promise<{ email: string | null; phone: string | null } | null> {
  if (isUuid(ids.tenantId)) {
    const r = (await q.query<{ email: string | null; phone: string | null }>(
      `SELECT LOWER(u.email) AS email, NULLIF(u.phone, '') AS phone
         FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1
          AND (EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                        WHERE lt.tenant_id = t.id AND l.landlord_id = $2)
            OR EXISTS (SELECT 1 FROM unit_bookings b WHERE b.tenant_id = t.id AND b.landlord_id = $2)
            OR EXISTS (SELECT 1 FROM pos_customers c WHERE c.tenant_id = t.id AND c.landlord_id = $2)
            OR EXISTS (SELECT 1 FROM utility_service_agreements sa WHERE sa.tenant_id = t.id AND sa.landlord_id = $2))`,
      [ids.tenantId, landlordId])).rows[0]
    return r ?? null
  }
  if (isUuid(ids.posCustomerId)) {
    const r = (await q.query<{ email: string | null; phone: string | null }>(
      `SELECT LOWER(COALESCE(u.email, c.email)) AS email,
              COALESCE(NULLIF(u.phone, ''), NULLIF(c.phone, '')) AS phone
         FROM pos_customers c
         LEFT JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN users u ON u.id = t.user_id
        WHERE c.id = $1 AND c.landlord_id = $2`, [ids.posCustomerId, landlordId])).rows[0]
    return r ?? null
  }
  return null
}

const SPACE_LABEL = `COALESCE(NULLIF(un.display_label, ''), un.unit_number, '')`

/**
 * IS ANYBODY THE PAYER FOR THIS STAY'S UTILITIES? — one fragment, both doors.
 *
 * 10/20 (review). This was a bare `SELECT sa.id WHERE sa.booking_id = b.id`,
 * written twice, on the reasoning that "a stay of 30+ nights with no lease HAS
 * an agreement and a shorter one never does, so the row itself says whether
 * anybody is the payer". The row does not say that. It says an agreement was
 * made for this booking ONCE — and a stay gets re-dated. A guest who booked 35
 * nights and was moved down to 10 on the schedule left the row behind, and the
 * counter read it back as "they pay their own" over a week-long guest whose
 * power is inside the rate they already paid.
 *
 * So the test is the one the BILLING ENGINE asks, not a row's existence: is
 * there an agreement that can bill this site at all — in force or ended with a
 * closing date, covering a real stretch of days rather than a zero-length stub,
 * and on the space the stay is on now. Those are the same three conditions
 * utilityBilling's tryInsertBill applies when it looks for the payer, which is
 * what makes the figure the desk reads out the figure that gets written. The
 * nights themselves are counted in ONE place — services/stayTerms
 * syncStayUtilityAgreement, on every save of the reservation — and this door
 * reads the answer instead of re-deriving it.
 *
 * Expects the booking aliased `b`.
 */
const STAY_PAYS_ITS_OWN = `
  (SELECT sa.id FROM utility_service_agreements sa
    WHERE sa.booking_id = b.id
      AND sa.unit_id = b.unit_id
      AND (sa.status = 'active' OR (sa.status = 'ended' AND sa.end_date IS NOT NULL))
      AND (sa.end_date IS NULL OR sa.end_date > sa.start_date))`

/** 'Sep 3' for a date, however the driver hands it over. */
function dayWords(d: unknown): string | null {
  if (!d) return null
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const isoDay = (d: unknown): string | null => {
  if (!d) return null
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/**
 * Today as the DATABASE will stamp it. A read is written with CURRENT_DATE, so
 * the same-day test that keeps a retake from being read as a stuck meter has to
 * use the same day Postgres will. Built from LOCAL getters on purpose:
 * toISOString() is UTC, and after 5pm in Arizona that is already tomorrow — the
 * evening date skew that has bitten this repo before. Same reasoning as
 * earlyDepartureWash's asDay.
 */
const todayIso = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The submeters on a site, with whether each has anything to measure from. */
async function metersOnUnit(q: Q, unitId: string): Promise<CounterMeter[]> {
  // D4 (Nic): EVERY submeter this site has gets a box — usually electric,
  // sometimes electric and water — billed as one set of lines on the one
  // ticket. A RUBS master or a flat charge is not a read anybody takes at a
  // counter, and a meter out of service has no valid figure to type.
  const rows = (await q.query<any>(
    `SELECT m.id, m.utility_type, m.label, m.digits,
            NOT EXISTS (SELECT 1 FROM utility_meter_readings r
                         WHERE r.meter_id = m.id AND r.needs_review = false) AS no_baseline
       FROM utility_meter_units mu
       JOIN utility_meters m ON m.id = mu.meter_id
      WHERE mu.unit_id = $1 AND m.billing_method = 'submeter' AND m.out_of_service = false
        -- No face, no read. A trash submeter carries no odometer at all (the
        -- schema's own CHECK forbids one), so there is nothing for the desk to
        -- type and offering a box for it would invite a made-up figure.
        AND m.digits IS NOT NULL
      ORDER BY m.utility_type, m.label`, [unitId])).rows
  return rows.map((m: any) => ({
    meterId: m.id,
    utilityType: m.utility_type as UtilityType,
    label: m.label,
    digits: m.digits == null ? null : Number(m.digits),
    usageUnit: UTILITY_UNIT_LABEL[m.utility_type as UtilityType] ?? 'units',
    usageNoun: UTILITY_USAGE_NOUN[m.utility_type as UtilityType] ?? 'power',
    noBaseline: !!m.no_baseline,
  }))
}

/**
 * D3 — GAM FINDS THE SITE FROM THE RESERVATION. Exact email, then exact phone.
 *
 * Exact, both of them. A fuzzy name match is how a money decision lands on the
 * wrong household, and this door's whole output is a dollar figure somebody is
 * asked for; the codebase has banned it everywhere else in the money path and it
 * is not coming in through the register.
 *
 * What comes back is this person's OWN stays and leases at this property, so the
 * desk confirms WHICH one they are closing out. Two rigs, the desk confirms
 * which. It is never a list of spaces: "no reason for the front counter to pick
 * a space too".
 */
/**
 * HOW LONG A COUNTER'S ASK CAN BE OPEN, AND WHY THERE IS A LIMIT AT ALL.
 *
 * An open ask is "the desk is collecting this right now". It is let go the
 * moment the ticket is paid, cleared, or the read is taken off it — three
 * presses the register makes itself. The one case none of them covers is the
 * browser dying mid-ticket, and an ask left open forever would WEDGE the bill:
 * off the Pay Links list because a collection is already out for it, and
 * un-collectable there because the thing holding it is a cart that no longer
 * exists. That is the exact wedge the emailed door was corrected for on 10/20
 * and it is not worth repeating in a new place.
 *
 * Nobody holds a cart at a front desk overnight, so an ask this old is a dead
 * one. Letting it go is D2's answer and costs nothing: the bill stays owed, on
 * their invoice or as an emailed link, and the reading stands.
 */
export const COUNTER_ASK_HOURS = 12

/** The note left on an ask nobody ever came back to. */
export const COUNTER_ASK_WENT_COLD =
  'The ticket it was raised on was never settled — owed as usual'

/**
 * Dead asks at this property, let go. Called by the counter's own doors rather
 * than by a nightly job: the register is used every day at a park, so the first
 * closing read of the next morning clears the night before. A new background
 * job for this would be a new moving part to earn its keep, and this needs none.
 */
export async function releaseStaleCounterAsks(
  q: Q, args: { landlordId: string; propertyId: string },
): Promise<number> {
  const r = await q.query<{ id: string }>(
    `UPDATE utility_pay_link_settlements s
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
            notes = CASE WHEN COALESCE(s.notes, '') = '' THEN $3
                         ELSE s.notes || ' — ' || $3 END
      WHERE s.landlord_id = $1 AND s.property_id = $2
        AND s.status = 'open' AND s.raised_at_counter
        AND s.created_at < NOW() - ($4 || ' hours')::interval
      RETURNING s.id`,
    [args.landlordId, args.propertyId, COUNTER_ASK_WENT_COLD, String(COUNTER_ASK_HOURS)])
  if (r.rows.length) {
    logger.info({ propertyId: args.propertyId, released: r.rows.length },
      '[register-final-utility] closing reads raised on tickets nobody settled — the bills are owed the ordinary way')
  }
  return r.rows.length
}

/**
 * ONE STAY, AS A CLOSING. Built in one place because the Checkout tab reaches
 * the same stays two ways — the person the desk picked, and the list of people
 * due out — and the two must never describe a stay differently.
 */
async function stayClosing(q: Q, s: {
  id: string; unit_id: string; space_label: unknown; check_in: unknown; check_out: unknown
  agreement_id: unknown; guest?: unknown
}): Promise<CounterClosing> {
  const label = String(s.space_label ?? '')
  const span = [dayWords(s.check_in), dayWords(s.check_out)].filter(Boolean).join(' to ')
  const due = await reservationDue(q as Pick<PoolClient, 'query'>, s.id)
  return {
    kind: 'stay', id: s.id, unitId: s.unit_id, spaceLabel: label,
    from: isoDay(s.check_in), to: isoDay(s.check_out),
    what: `Stay — ${label || 'their site'}${span ? `, ${span}` : ''}`,
    who: (typeof s.guest === 'string' && s.guest.trim()) || null,
    // A cancelled or no-show stay is closed: it asks for nothing (`closed`),
    // and reading its owed as money due would invent a bill at the counter.
    owed: due && !due.closed ? Math.max(0, Math.round(due.owed * 100) / 100) : 0,
    // Whether an agreement can bill this site, not whether one was ever made
    // for the booking — see STAY_PAYS_ITS_OWN. No night count here: the nights
    // are counted on every save of the reservation, in the one place that is
    // allowed to count them.
    payer: s.agreement_id ? 'service_agreement' : 'in_the_rate',
    meters: await metersOnUnit(q, s.unit_id),
  }
}

/** The columns stayClosing reads, on a unit_bookings alias `b`. */
const STAY_CLOSING_COLUMNS = `b.id, b.unit_id, b.status, b.stay_terms,
              to_char(b.check_in, 'YYYY-MM-DD') AS check_in,
              to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
              COALESCE(NULLIF(TRIM(b.guest_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', gu.first_name, gu.last_name)), '')) AS guest,
              ${SPACE_LABEL} AS space_label,
              ${STAY_PAYS_ITS_OWN} AS agreement_id`

/** The joins STAY_CLOSING_COLUMNS needs beside `units un`. */
const STAY_CLOSING_JOINS = `LEFT JOIN tenants gt ON gt.id = b.tenant_id
         LEFT JOIN users gu ON gu.id = gt.user_id`

/**
 * 10/21 (Nic) — WHO IS DUE OUT, for the Checkout tab's own list.
 *
 *   "when somebody's checking out, the point of sale should communicate with
 *    the unit and any submeters applicable to that unit."
 *
 * The desk opening Checkout has usually not typed anything yet: the person is
 * standing there because their time is up. So the tab opens on the stays whose
 * last day has come or gone and whose guest is still checked in — the
 * schedule's own answer, not a status anybody typed — and picking one reaches
 * the SAME closing the person search reaches (stayClosing). A guest who is not
 * on this list is found by name, as always.
 *
 * `today` is the property's day ('YYYY-MM-DD').
 */
export async function counterDueOut(
  q: Q, args: { landlordId: string; propertyId: string; today: string },
): Promise<CounterClosing[]> {
  const rows = (await q.query<any>(
    `SELECT ${STAY_CLOSING_COLUMNS}
       FROM unit_bookings b
       JOIN units un ON un.id = b.unit_id
       ${STAY_CLOSING_JOINS}
      WHERE un.property_id = $1 AND b.landlord_id = $2
        AND b.status = 'checked_in'
        AND b.check_out <= $3::date
        AND b.stay_terms IS DISTINCT FROM 'lease'
        AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id AND l.status IN ('pending', 'active'))
      ORDER BY b.check_out, space_label
      LIMIT 40`, [args.propertyId, args.landlordId, args.today])).rows
  const out: CounterClosing[] = []
  for (const r of rows) out.push(await stayClosing(q, r))
  return out
}

export async function counterClosings(
  q: Q, args: { landlordId: string; propertyId: string; email?: string | null; phone?: string | null },
): Promise<CounterLookup> {
  // The first thing the desk does at this park today lets go of anything a dead
  // ticket is still holding from yesterday (see releaseStaleCounterAsks).
  await releaseStaleCounterAsks(q, { landlordId: args.landlordId, propertyId: args.propertyId })
  const email = String(args.email ?? '').trim().toLowerCase() || null
  const phone = digitsOf(args.phone).slice(-10)
  const phone10 = phone.length === 10 ? phone : null

  // Email first, then phone — two passes, never one OR'd query, because WHICH
  // one matched is on the screen and a combined query could not say.
  for (const by of (['email', 'phone'] as const)) {
    if (by === 'email' && !email) continue
    if (by === 'phone' && !phone10) continue
    const onEmail = by === 'email'

    const stays = (await q.query<any>(
      `SELECT ${STAY_CLOSING_COLUMNS}
         FROM unit_bookings b
         JOIN units un ON un.id = b.unit_id
         ${STAY_CLOSING_JOINS}
        WHERE un.property_id = $1 AND b.landlord_id = $2
          AND b.status IN ('confirmed', 'checked_in', 'checked_out')
          AND b.stay_terms IS DISTINCT FROM 'lease'
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id AND l.status IN ('pending', 'active'))
          AND (
            ($3::boolean AND LOWER(b.guest_email) = $4)
            OR (NOT $3::boolean AND RIGHT(regexp_replace(COALESCE(b.guest_phone, ''), '\\D', '', 'g'), 10) = $5)
            -- Their own tenancy record is them too: a guest who has a GAM login
            -- is matched by the account the stay is tied to, not only by the
            -- address typed on the booking form.
            OR EXISTS (SELECT 1 FROM tenants t JOIN users u ON u.id = t.user_id
                        WHERE t.id = b.tenant_id
                          AND (($3::boolean AND LOWER(u.email) = $4)
                            OR (NOT $3::boolean AND RIGHT(regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = $5)))
          )
        ORDER BY b.check_out DESC, space_label
        LIMIT 10`, [args.propertyId, args.landlordId, onEmail, email, phone10])).rows

    const leases = (await q.query<any>(
      `SELECT DISTINCT l.id, l.unit_id, l.status,
              to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
              ${SPACE_LABEL} AS space_label
         FROM leases l
         JOIN units un ON un.id = l.unit_id
         JOIN lease_tenants lt ON lt.lease_id = l.id
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE un.property_id = $1 AND l.landlord_id = $2
          AND l.status IN ('active', 'expired', 'terminated')
          AND (($3::boolean AND LOWER(u.email) = $4)
            OR (NOT $3::boolean AND RIGHT(regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = $5))
        ORDER BY l.id, start_date DESC
        LIMIT 10`, [args.propertyId, args.landlordId, onEmail, email, phone10])).rows

    if (!stays.length && !leases.length) continue

    const closings: CounterClosing[] = []
    for (const s of stays) closings.push(await stayClosing(q, s))
    for (const l of leases) {
      const label = String(l.space_label ?? '')
      const span = [dayWords(l.start_date), dayWords(l.end_date) ?? 'open'].filter(Boolean).join(' to ')
      closings.push({
        kind: 'lease', id: l.id, unitId: l.unit_id, spaceLabel: label,
        from: isoDay(l.start_date), to: isoDay(l.end_date),
        what: `Lease — ${label || 'their space'}${span ? `, ${span}` : ''}`,
        who: null,
        // A lease's rent is its household's invoice, settled on the Payments
        // page — never a line on a register ticket (10/21).
        owed: null,
        payer: 'lease',
        meters: await metersOnUnit(q, l.unit_id),
      })
    }
    return { matchedBy: by, closings, note: closings.length ? null : NOTHING_TO_CLOSE_OUT }
  }
  return { matchedBy: null, closings: [], note: NOBODY_AT_THIS_PROPERTY }
}

/**
 * ONE NAMED STAY OR LEASE, CHECKED RATHER THAN TRUSTED.
 *
 * The desk confirms which closing it is and the register sends back its id. An
 * id that arrives in a request body is somebody's claim, and this one decides
 * whose meter is read and whose bill is written — so it is re-read here against
 * this company and this property, and the payer behind it is derived from the
 * row rather than taken from the browser. A browser that said 'lease' about a
 * nightly guest would turn power that is inside the rate into a bill.
 */
export async function counterClosingById(
  q: Q, args: { landlordId: string; propertyId: string; kind: 'stay' | 'lease'; id: string },
): Promise<CounterClosing> {
  const GONE = 'That stay or lease is not at this property any more — open the customer up again and pick it from the list.'
  if (args.kind === 'stay') {
    const b = (await q.query<any>(
      `SELECT ${STAY_CLOSING_COLUMNS}
         FROM unit_bookings b
         JOIN units un ON un.id = b.unit_id
         ${STAY_CLOSING_JOINS}
        WHERE b.id = $1 AND b.landlord_id = $2 AND un.property_id = $3
          AND b.status IN ('confirmed', 'checked_in', 'checked_out')
          AND b.stay_terms IS DISTINCT FROM 'lease'`,
      [args.id, args.landlordId, args.propertyId])).rows[0]
    if (!b) throw new AppError(404, GONE)
    return await stayClosing(q, b)
  }
  const l = (await q.query<any>(
    `SELECT l.id, l.unit_id,
            to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
            ${SPACE_LABEL} AS space_label
       FROM leases l JOIN units un ON un.id = l.unit_id
      WHERE l.id = $1 AND l.landlord_id = $2 AND un.property_id = $3
        AND l.status IN ('active', 'expired', 'terminated')`,
    [args.id, args.landlordId, args.propertyId])).rows[0]
  if (!l) throw new AppError(404, GONE)
  const label = String(l.space_label ?? '')
  const span = [dayWords(l.start_date), dayWords(l.end_date) ?? 'open'].filter(Boolean).join(' to ')
  return {
    kind: 'lease', id: l.id, unitId: l.unit_id, spaceLabel: label,
    from: isoDay(l.start_date), to: isoDay(l.end_date),
    what: `Lease — ${label || 'their space'}${span ? `, ${span}` : ''}`,
    who: null,
    owed: null,
    payer: 'lease',
    meters: await metersOnUnit(q, l.unit_id),
  }
}

// ─── D5: THE FIGURE, THE USAGE AND THE DOLLARS ───────────────────────────────

/** A meter as the arithmetic needs it: its rates, its face and its last read. */
interface MeterForRead {
  id: string
  propertyId: string
  landlordId: string
  utilityType: UtilityType
  label: string
  digits: number
  multiplier: number
  ratePerUnit: number
  baseFee: number
  sewerRate: number
  taxRatePct: number
  sewerTaxRatePct: number
  priorValue: number | null
  priorDay: string | null
  cycleMonth: string
  usageUnit: string
  usageNoun: string
}

/**
 * The meter, PRICED THE WAY EVERY OTHER BILL ON THIS PROPERTY IS PRICED.
 *
 * The property's own rate wins over the meter's where it is set — a departing
 * payer must never be charged a different rate than the one moving in behind
 * them (S605). That is the same four lines utilityBilling's applyPropertyRates
 * runs before the monthly engine and before the move-out read; it is not
 * exported, and the alternative is this door quietly pricing off a stale
 * per-meter rate.
 *
 * ── AND IT IS THE CLOSING'S OWN SPACE'S METER, RE-READ HERE (10/20 review) ──
 *
 * The meter id arrives in a request body, which makes it somebody's claim, and
 * the ONE relationship that decides whose power this is — utility_meter_units,
 * the meter against the space — has to be re-read here with everything else. It
 * was not, and that was the whole fault: the closing was re-read, the meter's
 * PROPERTY was re-read, and a cashier at Mountain View could name the guest on
 * RV 27 and RV 05's submeter in the same request. Two things went wrong at once
 * and both are money:
 *
 *   RV 05'S KILOWATTS WENT ON THE RV 27 GUEST'S TICKET. utility_bills' unique
 *     slot is (meter, SPACE, cycle, utility), so the cross-wired bill does not
 *     collide with RV 05's own — it inserts cleanly and reads as that guest's.
 *   AND RV 05'S READING OF RECORD WAS OVERWRITTEN. A 'move_out_final' read with
 *     needs_review false, dated today, is exactly the row the prior-read query
 *     below selects — so RV 05's own occupant's next bill would be measured
 *     from a figure that was never theirs.
 *
 * So the space is a JOIN, not a check after the fact: a meter that is not on
 * this closing's space is not a meter this door can find at all. Nic's own
 * instruction is the shape of the fix — "gam should know the site from the
 * reservation" — and the site knows which meters are its own.
 *
 * ONE SENTENCE FOR BOTH MISSES, deliberately, the way HELD_FOR_DOUBLE_CHECK is
 * one sentence for a figure too high and one too low: a meter at the park next
 * door and a meter on the space next door get the same answer, so nothing a
 * clerk types at this door can tell them apart. Blind staff entry (S559) is
 * about what the screen gives away, and a label is a giveaway.
 */
async function meterForRead(
  q: Q, args: { landlordId: string; propertyId: string; unitId: string; meterId: string },
): Promise<MeterForRead> {
  const { landlordId, propertyId, meterId } = args
  const m = (await q.query<any>(
    `SELECT m.*, p.landlord_id
       FROM utility_meters m
       JOIN properties p ON p.id = m.property_id
       -- The space decides whose power it is. Re-read here, not taken from the
       -- list the browser was handed (10/20 review).
       JOIN utility_meter_units mu ON mu.meter_id = m.id AND mu.unit_id = $3
      WHERE m.id = $1 AND m.property_id = $2`, [meterId, propertyId, args.unitId])).rows[0]
  if (!m || m.landlord_id !== landlordId) {
    throw new AppError(404, 'That meter is not on the space being closed out — open the customer up again and take the read from the list.')
  }
  if (m.billing_method !== 'submeter') {
    throw new AppError(400, `${m.label} is not a submeter, so there is no closing read to take on it here.`)
  }
  if (m.out_of_service) {
    throw new AppError(409, `${m.label} is marked out of service — nothing was recorded. Take it off out-of-service on the Utilities page first.`)
  }
  if (m.digits == null) {
    throw new AppError(400, `${m.label} has no odometer to read, so there is no closing read to take on it.`)
  }
  const rate = (await q.query<any>(
    `SELECT rate_per_unit, base_fee, sewer_rate_per_unit FROM property_utility_rates
      WHERE property_id = $1 AND utility_type = $2`, [propertyId, m.utility_type])).rows[0]
  const tax = async (t: string) => Number((await q.query<any>(
    `SELECT tax_rate_pct FROM property_utility_tax_rates WHERE property_id = $1 AND utility_type = $2`,
    [propertyId, t])).rows[0]?.tax_rate_pct ?? 0)

  const sewerRate = m.utility_type === 'water'
    ? Number(rate?.sewer_rate_per_unit ?? m.sewer_rate_per_unit ?? 0) : 0
  // The reading of record is the last figure a person either took cleanly or
  // looked at and settled — never one still waiting on the landlord's
  // double-check. The same rule the move-out path keeps, for the same reason: a
  // dropped digit at a pull-out must not become the next occupant's baseline.
  const prior = (await q.query<any>(
    `SELECT reading_value, to_char(reading_date, 'YYYY-MM-DD') AS reading_day
       FROM utility_meter_readings
      WHERE meter_id = $1 AND needs_review = false
      ORDER BY reading_date DESC, created_at DESC LIMIT 1`, [meterId])).rows[0]

  // The cycle the read and the bill both belong to, read off the DATABASE'S own
  // today — the same CURRENT_DATE the reading insert below stamps. Taken from
  // the process clock instead, a confirm that lands either side of midnight UTC
  // would write a read into one month and a bill into another, and the bill
  // would be measured against a read it never came from.
  const today = String((await q.query<{ cycle: string }>(
    `SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS cycle`)).rows[0].cycle)

  return {
    id: m.id, propertyId, landlordId,
    utilityType: m.utility_type as UtilityType, label: m.label,
    digits: Number(m.digits),
    multiplier: Number(m.reading_multiplier ?? 1) > 0 ? Number(m.reading_multiplier ?? 1) : 1,
    ratePerUnit: Number(rate?.rate_per_unit ?? m.rate_per_unit ?? 0),
    baseFee: Number(rate?.base_fee ?? m.base_fee ?? 0),
    sewerRate,
    taxRatePct: await tax(m.utility_type),
    sewerTaxRatePct: sewerRate > 0 ? await tax('sewer') : 0,
    priorValue: prior ? Number(prior.reading_value) : null,
    priorDay: prior?.reading_day ?? null,
    cycleMonth: today,
    usageUnit: UTILITY_UNIT_LABEL[m.utility_type as UtilityType] ?? 'units',
    usageNoun: UTILITY_USAGE_NOUN[m.utility_type as UtilityType] ?? 'power',
  }
}

/**
 * 10/21 — A RETAKE MEASURES FROM WHERE THE MONTH STARTED, NOT FROM THE READ IT
 * IS REPLACING.
 *
 * meterForRead takes the newest reading that is not held — and by the time
 * anybody retakes a closing read, THE FIRST ONE IS THAT READING. So the second
 * pass through this door measured 48,500 − 48,387 and offered the desk 113 kWh
 * of a month that had used 500; and the ordinary retake, where the card page
 * refused and the desk reads the same face again, came out at 0 kWh and $0.00
 * while the payer still owed $87.77.
 *
 * The bill already in the slot knows where its span starts, because that is the
 * figure the month was measured from. Taken from the bill rather than
 * recomputed.
 *
 * BOTH DOORS GO THROUGH HERE. The quote and the confirm each read the meter for
 * themselves — deliberately, so that no figure from a browser is ever trusted —
 * and that is exactly why the alignment cannot live in one of them: the first cut
 * put it only in the quote, and the confirm went on pricing the retake at $0.00
 * one function away.
 */
async function meterForClosingRead(
  q: Q,
  at: { landlordId: string; propertyId: string; unitId: string; meterId: string },
  closing: Pick<CounterClosing, 'kind' | 'id' | 'unitId'>,
): Promise<MeterForRead> {
  const m = await meterForRead(q, at)
  const already = await counterBillInTheSlot(q, m, closing, false)
  if (already.kind === 'raise' && already.bill.readingStart != null) {
    m.priorValue = already.bill.readingStart
    m.priorDay = already.bill.readingStartDay
  }
  return m
}

/** Why a typed figure is not billable as it stands. */
export type CounterReadBlock =
  | 'no_baseline'        // nothing to measure from
  | 'over_capacity'      // more digits than the face has
  | 'double_check'       // held for the landlord: too high, or below the last read
  | 'in_the_rate'        // a nightly or weekly guest — their power is in the rate

export interface CounterReadQuote {
  meterId: string
  utilityType: UtilityType
  meterLabel: string
  /** The usage the figure comes to, in billing units. Shown to the desk (D5). */
  usage: number | null
  usageUnit: string
  charge: number
  tax: number
  /** What goes on the ticket. Shown to the desk and read out to the payer (D5). */
  amount: number
  /** Null when this read bills; otherwise why not, in plain words. */
  block: CounterReadBlock | null
  /** The sentence the screen shows. Never a figure when the read is held. */
  note: string | null
}

/**
 * THE ONE PIECE OF ARITHMETIC IN THIS FILE, and both doors go through it.
 *
 * The quote the desk confirms and the bill that is written are the same call, so
 * the figure read out to the payer is the figure charged. Keeping them apart is
 * how the 10/20 pay-link fault happened in the first place: one door summed the
 * bill's own money and the other re-derived it, and they disagreed by 96¢.
 *
 * Usage is in BILLING UNITS — the face's turns times the multiplier (S613: a
 * water face counting per hundred gallons reads 413 → 415 for 200 gallons, and
 * a penny a gallon has to see 200, not 2). Rollover uses the FACE modulus, so
 * the wrap is computed before the multiply.
 */
export function usageAndCharge(m: MeterForRead, value: number): {
  usage: number; charge: number; tax: number; amount: number; isRollover: boolean
} {
  const prior = m.priorValue ?? 0
  // 10/24 (Nic): level with the last read, or one or two under it, is a stuck
  // face or a rounded figure — never an odometer that went all the way round.
  // Called out as its own answer so the wrap below cannot claim it, and so the
  // figure the desk is quoted is 0 rather than very nearly a full meter.
  const barelyMoved = readingBarelyMoved(m.priorValue, value, m.priorDay, todayIso())
  const isRollover = !barelyMoved && value < prior
  let turns = value - prior
  if (barelyMoved) turns = Math.max(0, turns)
  else if (turns < 0 && isRollover) turns = (meterReadingModulus(m.digits) - prior) + value
  const usage = turns * m.multiplier
  const base = usage * m.ratePerUnit + m.baseFee
  const sewer = usage * m.sewerRate
  // Each portion taxed at its own type's property rate, as every other bill on
  // this property is: sewer rides the water meter and there is no sewer meter in
  // the field (S533), so one tax figure can hold two rates.
  const tax = Math.round(base * m.taxRatePct + sewer * m.sewerTaxRatePct) / 100
  const charge = round2(base + sewer)
  return { usage, charge, tax: round2(tax), amount: round2(charge + round2(tax)), isRollover }
}

/**
 * D5 — TYPING THE NUMBER WRITES NOTHING. It shows the usage and the amount.
 *
 * Nothing in here writes: no reading, no bill, no flag. A typo is retyped, never
 * voided, because there is nothing yet to void. Confirming is what writes
 * (recordCounterReads), and it recomputes from this same function rather than
 * trusting a figure that came back from a browser.
 */
export async function quoteCounterReads(
  q: Q, args: {
    landlordId: string; propertyId: string
    /**
     * The SPACE comes with the closing, and it is what scopes the meter — a
     * read is priced against the site it belongs to or it is not priced here at
     * all (meterForRead). The quote has to carry it for the same reason the
     * confirm does: the desk sees the figure the ticket will charge, and the
     * two doors must refuse the same requests.
     */
    closing: Pick<CounterClosing, 'payer' | 'unitId' | 'kind' | 'id'>
    reads: ReadonlyArray<{ meterId: string; value: number }>
  },
): Promise<CounterReadQuote[]> {
  // ONE BOX PER POLE (10/20 review). Two boxes for one meter is not a read
  // anybody takes, and left to run the second figure would be priced off the
  // FIRST typed figure the moment the first read landed — so the amount read
  // out to the payer and the amount written to the ticket would be different
  // numbers, which is the one thing this door exists to make impossible.
  // Refused here, before either door has read a meter or written a row, and
  // with no figure in the sentence: blind staff entry (S559) holds at a
  // refusal too.
  const seen = new Set<string>()
  for (const r of args.reads) {
    const pole = String(r.meterId ?? '').toLowerCase()
    if (seen.has(pole)) {
      throw new AppError(400, 'That meter has more than one box on this screen, and a pole is read once. '
        + 'Take the extra box off, then press Check the read again.')
    }
    seen.add(pole)
  }
  const out: CounterReadQuote[] = []
  for (const r of args.reads) {
    const m = await meterForClosingRead(q, {
      landlordId: args.landlordId, propertyId: args.propertyId,
      unitId: args.closing.unitId, meterId: r.meterId,
    }, args.closing)
    const label = m.label
    const shell = {
      meterId: m.id, utilityType: m.utilityType, meterLabel: label,
      usageUnit: m.usageUnit, usage: null, charge: 0, tax: 0, amount: 0,
    }
    if (!Number.isFinite(r.value) || r.value < 0 || !Number.isInteger(r.value)) {
      throw new AppError(400, `Type the whole number off the face of ${label}, then press Check the read again.`)
    }
    if (m.digits && r.value >= meterReadingModulus(m.digits)) {
      // The one refusal that names a figure, and it names the FACE, not the
      // previous read: a six-digit meter cannot show a seven-digit number and
      // saying so tells the reader nothing about anybody's usage.
      out.push({ ...shell, block: 'over_capacity',
        note: `That is more digits than ${label} has — read the face again and type what is on it.` })
      continue
    }
    if (m.priorValue == null) {
      out.push({ ...shell, block: 'no_baseline',
        note: `${label} has no earlier read, so there is no usage to bill from it yet — the figure is recorded as its starting point.` })
      continue
    }
    const { usage, charge, tax, amount, isRollover } = usageAndCharge(m, r.value)
    // Held for the landlord's double-check: a figure below the last read on a
    // meter nowhere near its ceiling (a dropped digit, or a genuine wrap), or
    // usage over its utility type's threshold (a slipped digit upward). The
    // SAME sentence for both on purpose — see the header.
    // 10/24 (Nic): and a read that barely moved holds as well. Without this it
    // would have quoted $0.00 and billed nobody in silence, which is the dead
    // meter nobody notices — the thing the rule exists to catch.
    // ── 10/25 (Nic) — A ROLLBACK NO LONGER HOLDS THE READ ──────────────────
    //
    //   "A meter rolling back is not a rule that I asked for. If it's 40,000 and
    //    it rolls back 39999, that just needs to flag in the system that the
    //    meter may be broken. I don't want to have to double check a read."
    //
    // readingBarelyMoved USED to be in this condition, which is how Patrick
    // Neuman's finished stay ended up with a "closing read still due" AND a
    // "reading to double-check" sitting on it: "Neither of those should be
    // there... The system is not operating correctly if those are there."
    //
    // The figure still bills nothing extra — the usage math above already reads
    // a rollback as no usage rather than a full wrap round the dial — and the
    // METER gets flagged instead (flagMeterLooksBroken, at the confirm). A
    // genuinely suspicious USAGE (a slipped digit upward) still holds, because
    // that one would overbill a guest who is standing at the counter.
    const held = (isRollover && m.priorValue < meterReadingModulus(m.digits) * 0.9)
      || usageNeedsDoubleCheck(m.utilityType, usage)
    if (held) {
      // 10/24 — THE DESK HEARS ABOUT THE MONEY FIRST, THEN ABOUT THE FIGURE.
      //
      // Lisa checked Patrick Neuman out of RV 06 on 10/23, typed 39999 against
      // a previous read of 40000, and got back only "this one waits on the
      // landlord's double-check". She read that as money pending and went
      // looking for a ticket to open. Nic: "I don't want there to be a hang up
      // when people are checking out at the front counter. The front desk
      // person needs to be able to finalize things... I don't really want the
      // front desk making judgment calls. I want the computer to do it for
      // them."
      //
      // Two things were true and only one of them was said. He was a work
      // camper on a stay with no cash due, so his power was in the rate he had
      // already paid and there was never anything to collect from him WHATEVER
      // the figure turned out to be. That is the half the counter needed.
      //
      // The figure itself still goes to the landlord, and that part is right: a
      // read below the last one is also the next guest's starting point, so
      // whether it is a slipped digit or a swapped meter is the landlord's to
      // settle and not the counter's to guess at. The hold is unchanged — no
      // bill is written and the read is flagged exactly as before.
      //
      // So only the sentence changes, and it leads with the answer: nothing to
      // collect, and nothing for you to do. The usage is deliberately left out
      // of it — a wrapped read prints as very nearly a full meter of
      // kilowatts, and reading 99,999 kWh out to a guest who is standing there
      // is worse than saying nothing at all.
      const nobodyToBill = args.closing.payer === 'in_the_rate'
      out.push({ ...shell, block: 'double_check',
        note: nobodyToBill
          ? `${label}: nothing to collect — a nightly or weekly guest's ${m.usageNoun} is in the rate they `
            + 'already paid. The figure needs a second look before it stands as the next read\'s starting '
            + 'point, so the landlord has it. Nothing to put on the ticket, and nothing for you to do here.'
          : `${label}: ${HELD_FOR_DOUBLE_CHECK}.` })
      continue
    }
    if (args.closing.payer === 'in_the_rate') {
      // D6 — a nightly or weekly guest's power is in the rate they already paid.
      // The usage is still shown, because the desk asked for a read and a blank
      // answer looks like a broken screen; what is shown is that there is
      // nothing to collect.
      out.push({ ...shell, usage, charge: 0, tax: 0, amount: 0, block: 'in_the_rate',
        note: `${usage.toLocaleString()} ${m.usageUnit} — nothing to collect: a nightly or weekly guest's ${m.usageNoun} is in the rate they already paid.` })
      continue
    }
    out.push({ ...shell, usage, charge, tax, amount, block: null,
      note: `${usage.toLocaleString()} ${m.usageUnit} — ${money(amount)}${tax > 0 ? ` (${money(charge)} plus ${money(tax)} tax)` : ''}` })
  }
  return out
}

// ─── D5 / D1: CONFIRMING WRITES THE READING AND THE BILL TOGETHER ────────────

/** A bill the counter raised, as the ticket carries it. */
export interface CounterBillLine {
  utilityBillId: string
  /** The line exactly as the emailed version writes it (payLinkLineForBill). */
  id: null
  name: string
  qty: 1
  price: number
  tax: number
  /** What the desk and the payer see on the ticket. */
  amount: number
}

export interface CounterReadRecorded {
  /** The reads that landed on a meter — all of them, billed or not. */
  readings: Array<{ meterId: string; readingId: string; held: boolean }>
  /** The bills raised, as lines for the ticket. */
  lines: CounterBillLine[]
  /** What the screen says about everything that did NOT go on the ticket. */
  notes: string[]
}

// ─── 10/21: THE SECOND TIME THE DESK TAKES THE SAME CLOSING READ ─────────────

/** The bill already sitting in this meter/space/month slot, as the counter needs it. */
interface SlotBill {
  id: string
  utilityType: UtilityType
  cycle: string
  spaceLabel: string
  charge: number
  tax: number
  /** A ticket is holding it right now, so no second ask is raised against it. */
  onATicket: boolean
  /**
   * WHERE THE BILL'S SPAN STARTS — the figure the month was measured from, which
   * is what a retake has to measure from too. See the span note in
   * quoteCounterReads: the meter's newest clean read is, by then, the closing
   * read being retaken.
   */
  readingStart: number | null
  readingStartDay: string | null
}

/**
 * What the slot says: nothing in it, a bill the desk may ask for again, or a
 * plain sentence saying why it may not.
 */
type SlotVerdict =
  | { kind: 'empty' }
  | { kind: 'raise'; bill: SlotBill }
  | { kind: 'refused'; why: string }

/**
 * 10/21 — THE BILL ALREADY IN THE SLOT, AND WHETHER THE DESK MAY ASK FOR IT.
 *
 * One bill per meter, space, month and utility (utility_bills_one_per_meter_unit
 * _cycle), so a SECOND closing read in the same month on the same space writes
 * no bill: the insert hits that index and tryInsertBill answers false. That much
 * is right — the same kilowatts must never end up on two bills.
 *
 * What was wrong is what came next. D2 leaves a counter-raised bill nobody paid
 * 'unbilled' and OWED on purpose, so the most ordinary thing that happens at a
 * front desk — the card page refuses and the desk takes the read again with the
 * payer still standing there — landed on the one path that could not put the
 * bill back on a ticket. It told the desk the monthly run had billed it, which
 * it had not, and the money was then reachable only by emailing a pay link: the
 * second place to pay that D1 exists to prevent, and the one with nobody
 * standing at it. The closing-read door was a one-shot per meter and month.
 *
 * So the slot's own bill is read, and RE-RAISED when it is still genuinely owed.
 * Re-raised, not re-billed: the same bill, a fresh ask, one record of the money.
 * It is refused for exactly the reasons the till refuses it at Charge, in the
 * same words, so the desk is never handed a line that gets thrown out a moment
 * later with the payer watching.
 *
 * Taken FOR UPDATE on the write path because two registers on one read have to
 * queue here: the second must find the first's open ask and be told so plainly,
 * rather than colliding with upls_one_open_link_per_bill and handing the desk a
 * raw unique-index error.
 */
async function counterBillInTheSlot(
  q: Q, m: MeterForRead, closing: Pick<CounterClosing, 'kind' | 'id' | 'unitId'>, lock: boolean,
): Promise<SlotVerdict> {
  const unitId = closing.unitId
  const r = (await q.query<any>(
    `SELECT ub.id, ub.status, ub.utility_type, ub.payment_id, ub.lease_id,
            ub.reading_start,
            to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
            to_char(ub.reading_start_date, 'YYYY-MM-DD') AS reading_start_day,
            -- WHOSE BILL IS IN THE SLOT. A lease bill names its lease; a stay's
            -- names the utility service agreement behind the booking, so the
            -- booking is read back through it.
            (SELECT sa.booking_id FROM utility_service_agreements sa
              WHERE sa.id = ub.service_agreement_id) AS sa_booking,
            ub.charge_amount::text AS charge, ub.tax_amount::text AS tax,
            COALESCE(NULLIF(un.display_label, ''), un.unit_number, '') AS space_label,
            -- WHETHER IT IS STILL OWED IS THE CHARGE'S ANSWER, NOT THE BILL'S
            -- STATUS ON ITS OWN — the same correction both the emailed door and
            -- the till were given on 10/20: an ACH in flight, a charge taken
            -- from the deposit and one suspended under work trade all leave a
            -- bill reading 'billed' while its money is already answered for.
            (ub.payment_id IS NOT NULL AND ${moneyTakenOrMovingRowSql('p')}) AS charge_answered,
            (SELECT s.id FROM utility_pay_link_settlements s
              WHERE s.utility_bill_id = ub.id AND s.status = 'open' AND s.raised_at_counter) AS counter_ask,
            EXISTS (SELECT 1 FROM utility_pay_link_settlements s
                     WHERE s.utility_bill_id = ub.id AND s.status = 'open' AND NOT s.raised_at_counter) AS link_is_out,
            EXISTS (SELECT 1 FROM utility_pay_link_settlements s
                     WHERE s.utility_bill_id = ub.id AND s.status = 'settled') AS already_collected
       FROM utility_bills ub
       JOIN units un ON un.id = ub.unit_id
       LEFT JOIN payments p ON p.id = ub.payment_id
      -- The slot is the unique index's own four columns, over bills not voided
      -- out of it (voided_at IS NULL). Asking 'status <> void' instead reads a
      -- DIFFERENT set of rows than the index the insert actually hit, which is
      -- how a bill could block the insert and then not be found by the code
      -- explaining why.
      WHERE ub.meter_id = $1 AND ub.unit_id = $2 AND ub.billing_cycle_month = $3::date
        AND ub.utility_type = $4 AND ub.voided_at IS NULL
      ORDER BY ub.created_at DESC
      LIMIT 1${lock ? '\n      FOR UPDATE OF ub' : ''}`,
    [m.id, unitId, m.cycleMonth, m.utilityType])).rows[0]
  if (!r) return { kind: 'empty' }

  const was = `${m.label}: nothing to collect — this month's bill on this space`
  const read = 'The read is recorded.'

  // WHOSE BILL IS IT — ASKED FIRST, AND ASKED EXACTLY.
  //
  // A space turns over inside a month, and the slot's one bill belongs to
  // whichever household was billed for it. tryInsertBill already refuses to
  // write a second one (spanAnotherHouseholdHeld — "the spot changed hands
  // inside this read span"), and before this gate the re-raise would have taken
  // that refusal as its cue to put the PREVIOUS household's bill on the ticket
  // of the person standing at the counter. That is the one mistake this whole
  // door is built to make impossible: a money decision landing on the wrong
  // household.
  //
  // Asked before "already paid" and before "already answered for" on purpose —
  // telling this payer their bill is paid, about a bill that was never theirs,
  // would be worse than telling them nothing. It names no household, no figure
  // and no dates: that a space had somebody else on it this month is not a
  // prior VALUE, and blind staff entry (S559) is about figures.
  const theirs = closing.kind === 'lease'
    ? r.lease_id === closing.id
    : !!r.sa_booking && r.sa_booking === closing.id
  if (!theirs) {
    return { kind: 'refused', why: `${was} is billed to the household that had it, and that is not the one being `
      + `closed out here. ${read} The landlord has it.` }
  }
  if (r.status === 'paid' || r.already_collected) {
    return { kind: 'refused', why: `${was} was already paid. ${read}` }
  }
  if (r.status === 'void') {
    return { kind: 'refused', why: `${was} was voided, so nobody owes it. ${read}` }
  }
  if (r.status === 'disputed') {
    return { kind: 'refused', why: `${was} is under dispute, so settle that first. ${read}` }
  }
  if (r.charge_answered) {
    return { kind: 'refused', why: `${was} is already answered for on their own bill — a payment of theirs `
      + `is clearing for it, it was taken from their deposit, or it is being worked off. ${read}` }
  }
  if (r.link_is_out) {
    // ONE PLACE TO PAY, and right now that place is the link. Closing somebody
    // else's open collection from here would be this door deciding that the
    // counter outranks a link already in the payer's hand; the desk is told
    // where it is instead, and can close the link on the Pay Links page.
    return { kind: 'refused', why: `${m.label}: a pay link is already out for this month's bill on this space, `
      + `so it is being collected there — one place to pay. Close that link on the Pay Links page to take it at `
      + `the counter instead. ${read}` }
  }
  return {
    kind: 'raise',
    bill: {
      id: r.id, utilityType: r.utility_type as UtilityType, cycle: r.cycle,
      spaceLabel: String(r.space_label ?? ''),
      charge: round2(Number(r.charge) || 0), tax: round2(Number(r.tax) || 0),
      onATicket: !!r.counter_ask,
      readingStart: r.reading_start == null ? null : Number(r.reading_start),
      readingStartDay: r.reading_start_day ?? null,
    },
  }
}

/**
 * THE SAME BILL, BACK ON THE TICKET.
 *
 * No new bill, no second figure, AND NO NEW FIGURE ON THE OLD BILL: the row that
 * is already there is the record of this money, and all this adds is the open ask
 * that says the desk is collecting it now.
 *
 * ── WHY THIS DOES NOT RE-PRICE THE BILL (10/21, and I got this wrong once) ──
 *
 * The first cut of this re-priced the bill off the retake, on the reasoning that
 * the desk had just read the meter again so the newer figure must be the truer
 * one. The first test run put $23.73 over Curtis's $81.27.
 *
 * Because by the time anybody retakes a closing read, THE FIRST ONE IS ALREADY
 * THE METER'S NEWEST CLEAN READ (meterForRead takes the newest reading that is
 * not held), so the retake measures from the read it is replacing rather than
 * from where the month started: 48,500 − 48,387 = 113 kWh, when the month had
 * used 500. Re-pricing therefore did not correct the bill, it SHRANK it — and a
 * counter retake that can quietly reduce what somebody owes is a worse fault
 * than the one this change set out to fix.
 *
 * So the bill's own figure is the figure, exactly as the till already insists at
 * Charge ("a bill is collected in full or it is not collected" —
 * counterBillLineIsTheBillWords). The retake's job is to put the ask back, not
 * to re-decide the money. quoteCounterReads measures the retake from the bill's
 * own span so the screen and the ticket agree; if they still differ — a genuinely
 * later read — the desk is handed the bill's number to read out rather than left
 * reading the quote.
 */
async function putExistingBillBackOnTheTicket(
  client: PoolClient, args: {
    landlordId: string; propertyId: string; userId: string; unitId: string
    m: MeterForRead; bill: SlotBill; readingId: string
    read: { value: number; day: string; usage: number; charge: number; tax: number }
  },
): Promise<{ line: CounterBillLine; note: string | null }> {
  const { m, bill } = args
  const charge = bill.charge
  const tax = bill.tax

  const line = counterLineForBill({
    billId: bill.id, utilityType: bill.utilityType, billingCycleMonth: bill.cycle,
    spaceLabel: bill.spaceLabel, charge, tax,
  })
  if (!bill.onATicket) {
    await client.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, raised_at_counter, meter_reading_id, landlord_id, property_id,
          utility_bill_id, unit_id, meter_id, billing_cycle_month, utility_type,
          charge_amount, tax_amount, status, created_by, notes)
       VALUES (NULL, TRUE, $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, 'open', $11, $12)`,
      [args.readingId, args.landlordId, args.propertyId, bill.id, args.unitId, m.id,
       bill.cycle, bill.utilityType, line.price.toFixed(2), round2(tax).toFixed(2),
       args.userId, line.name])
  }
  logger.info({ billId: bill.id, meterId: m.id, unitId: args.unitId, cycle: m.cycleMonth,
                alreadyOnATicket: bill.onATicket },
    '[register-final-utility] the closing read was taken again — the bill it already raised is back on the ticket')

  // Only when the desk would otherwise read out a number the ticket does not
  // carry. When the figures agree — the ordinary retry, the same face seconds
  // later — the line IS the answer and a note would be noise.
  const note = Math.abs(round2(charge + tax) - round2(args.read.charge + args.read.tax)) > 0.005
    ? `${m.label}: this month's bill on this space stands at ${money(charge + tax)}, and that is the figure on `
      + 'the ticket — a bill is collected at its own figure. The read is recorded.'
    : null
  return { line, note }
}

/** Why a read that landed billed nothing. One of these, never a bare silence. */
async function whyNothingWasBilled(
  q: Q, m: MeterForRead, closing: CounterClosing,
): Promise<string> {
  const unitId = closing.unitId
  // THE WASH IS CALLED, NOT RE-DECIDED. tryInsertBill already asked
  // earlyDepartureWash whether this payer's final stub is one the landlord eats
  // (they left early at a property that kept their unused money), and if it is,
  // the absorbed row is already written against this meter and cycle. All this
  // does is read the answer back so the desk is told the truth rather than a
  // shrug.
  const a = (await q.query<{ id: string }>(
    `SELECT id FROM utility_absorbed_charges
      WHERE meter_id = $1 AND unit_id = $2 AND billing_cycle_month = $3::date
        AND reason = 'early_departure_wash'
      ORDER BY updated_at DESC LIMIT 1`, [m.id, unitId, m.cycleMonth])).rows[0]
  if (a) {
    return `${m.label}: nothing to collect — they left early and the park kept their unused money, so this is a wash and their ${m.usageNoun} is recorded as absorbed.`
  }
  // 10/21 — AND IF THERE IS A BILL IN THE SLOT, IT SAYS WHICH BILL AND WHY.
  //
  // This used to answer "this month was already billed on this space (the
  // monthly run read it)", which was a guess dressed as a fact: the commonest
  // bill in that slot is the one THIS DOOR raised minutes ago and nobody paid,
  // and telling the desk the monthly run had taken the money while the payer
  // stood at the counter was both untrue and a dead end. The slot is read for
  // the real answer, by the same rules the till applies at Charge.
  const slot = await counterBillInTheSlot(q, m, closing, false)
  if (slot.kind === 'refused') return slot.why
  if (slot.kind === 'raise') {
    // Reachable only from the read-back failure above: the bill stands and is
    // owed, and it could not be put on the ticket. Never "somebody else billed
    // it" — nothing was collected and nothing was written off.
    return `${m.label}: this month's bill on this space stands and is still owed, but it could not be put on the `
      + 'ticket. It is owed the ordinary way — their invoice, or an emailed link. The read is recorded.'
  }
  return `${m.label}: nothing to collect — GAM has nobody to bill this ${m.usageNoun} to, or this payer does not owe it. The read is recorded, and the landlord has it.`
}

/**
 * D6 — WHERE "POWER INSIDE A NIGHTLY OR WEEKLY RATE" FINALLY GETS WRITTEN DOWN.
 *
 * The utilities report has had a column for it since 10/20 and it reads $0.00 at
 * every property, because nothing has ever written the row. A nightly guest's
 * read simply billed nobody and the kilowatts fell out of the world: not
 * recovered, not absorbed, not anywhere — which puts them in the GAP, as though
 * the park had failed to collect money it had in fact already collected inside
 * the rate.
 *
 * So the read records it on the one book for utility billed to nobody, with the
 * in-the-rate reason, and the report counts it as recovered. Already collected
 * by definition: the stay was paid for at its rate.
 *
 * One row per meter, space and month (ux_utility_absorbed_charge_per_cycle), and
 * it ADDS rather than replaces — two guests through the same site in one month
 * is two lots of power in the rate, and the first one must not be overwritten by
 * the second.
 */
async function recordInTheRate(
  q: Q, m: MeterForRead, c: { unitId: string; id: string; to: string | null },
  read: { value: number; day: string; usage: number; charge: number; tax: number },
): Promise<void> {
  await q.query(
    `INSERT INTO utility_absorbed_charges AS a
       (meter_id, unit_id, landlord_id, utility_type, billing_cycle_month,
        allocation_method, charge_amount, base_fee_share, tax_amount,
        rate_per_unit, usage_amount, reading_start, reading_end,
        reading_start_date, reading_end_date, reason, booking_id, departed_on, notes)
     VALUES ($1,$2,$3,$4,$5::date,'submeter',$6,0,$7,$8,$9,$10,$11,$12::date,$13::date,
             'short_stay_in_rate',$14,$15::date,$16)
     ON CONFLICT (meter_id, unit_id, billing_cycle_month, reason) WHERE wash_id IS NULL DO UPDATE
       SET charge_amount = a.charge_amount + EXCLUDED.charge_amount,
           tax_amount = a.tax_amount + EXCLUDED.tax_amount,
           usage_amount = COALESCE(a.usage_amount, 0) + COALESCE(EXCLUDED.usage_amount, 0),
           reading_start = LEAST(a.reading_start, EXCLUDED.reading_start),
           reading_end = GREATEST(a.reading_end, EXCLUDED.reading_end),
           reading_start_date = LEAST(a.reading_start_date, EXCLUDED.reading_start_date),
           reading_end_date = GREATEST(a.reading_end_date, EXCLUDED.reading_end_date),
           booking_id = COALESCE(a.booking_id, EXCLUDED.booking_id),
           updated_at = now()`,
    [m.id, c.unitId, m.landlordId, m.utilityType, m.cycleMonth,
     round2(read.charge).toFixed(2), round2(read.tax).toFixed(2),
     m.ratePerUnit, read.usage, m.priorValue, read.value,
     m.priorDay, read.day, c.id, c.to,
     "A nightly or weekly guest's usage — inside the rate they already paid, so it is billed to nobody."])
}

/**
 * D5 — CONFIRMING WRITES THE READING AND THE BILL TOGETHER.
 * D1 — AND SENDS NOTHING, AND PUTS IT ON NO INVOICE.
 *
 * The reading is written FIRST and in every case, held or billed or in the rate:
 * the read always stands, because it is the next arrival's starting point and
 * because GAM never erases. Then the bill, through the engine's own insert
 * (utilityBilling tryInsertBill) so that whose usage it is, whether the payer
 * owes this utility, whether the spot changed hands inside the span and whether
 * the whole thing is a wash are all answered exactly as they are for every other
 * bill in GAM.
 *
 * What is deliberately NOT called is invoiceEndedLeaseBills, which is the move-
 * out path's own last act: it cuts a same-day invoice and emails "your final
 * utility bill is ready — pay it from your portal, or it settles from your
 * deposit". With the payer at the counter that is a second place to pay one bill.
 * The ticket is the place.
 *
 * Held reads are NOT billed and carry the household forward on the read itself,
 * so the landlord's double-check settles it onto the same people the desk named.
 */
export async function recordCounterReads(
  client: PoolClient, args: {
    landlordId: string; propertyId: string; userId: string
    closing: CounterClosing
    reads: ReadonlyArray<{ meterId: string; value: number }>
  },
): Promise<CounterReadRecorded> {
  const out: CounterReadRecorded = { readings: [], lines: [], notes: [] }

  // EVERY FIGURE IS CHECKED BEFORE ANY OF THEM IS WRITTEN. A site with two
  // meters gets two boxes on one screen and is confirmed once; a slip in the
  // second box must not leave the first one's read and bill standing. A figure
  // the face cannot show is not a read at all — it is a typing slip, and D5 says
  // a typo is retyped.
  const quotes = await quoteCounterReads(client, {
    landlordId: args.landlordId, propertyId: args.propertyId,
    closing: args.closing, reads: args.reads,
  })
  const slip = quotes.find(q => q.block === 'over_capacity')
  if (slip) throw new AppError(400, slip.note!)

  for (const [i, r] of args.reads.entries()) {
    const m = await meterForClosingRead(client, {
      landlordId: args.landlordId, propertyId: args.propertyId,
      unitId: args.closing.unitId, meterId: r.meterId,
    }, args.closing)
    const quote = quotes[i]

    // THE READ LANDS ON THE METER. Held or not, billed or not.
    const held = quote.block === 'double_check'
    // The household the desk named, carried on the read so the landlord's
    // double-check bills the same people and never one that left earlier. Only
    // on a HELD read: that column exists to survive the gap between a read being
    // taken and a human settling it, and a read that billed on the spot has no
    // gap to survive (migration 20261022160000).
    const carried = held && args.closing.kind === 'lease' ? args.closing.id : null
    // 10/21 — D5 SAYS A TYPO IS RETYPED, AND THE SAME IS TRUE OF A WHOLE READ.
    //
    // The desk pressing Confirm a second time on the same figure is one read
    // taken once, not two: the card page refused, or the browser double-fired,
    // and the same number off the same face on the same day is the same fact.
    // Before this, every press wrote another 'move_out_final' row, so a card
    // that failed twice left three readings of one meter reading — and the
    // landlord's Utilities page shows readings, so that is three closing reads
    // of a space somebody read once.
    //
    // Nothing is erased to make this true: the row already there is used. A
    // DIFFERENT figure today still writes its own row, because that is a
    // correction and GAM keeps both.
    const sameReadToday = (await client.query<{ id: string; day: string }>(
      `SELECT id, to_char(reading_date, 'YYYY-MM-DD') AS day
         FROM utility_meter_readings
        WHERE meter_id = $1 AND reading_date = CURRENT_DATE AND reading_value = $2
          AND reason = 'move_out_final' AND needs_review = $3
          AND move_out_lease_id IS NOT DISTINCT FROM $4::uuid
        ORDER BY created_at DESC LIMIT 1`,
      [m.id, r.value, held, carried])).rows[0]
    const reading = sameReadToday ?? (await client.query<{ id: string; day: string }>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id,
          reason, reason_note, needs_review, review_note, move_out_lease_id)
       VALUES ($1, CURRENT_DATE, $2, date_trunc('month', CURRENT_DATE)::date, $3,
               'move_out_final', $4, $5, $6, $7)
       RETURNING id, to_char(reading_date, 'YYYY-MM-DD') AS day`,
      [m.id, r.value, args.userId,
       `Closing read taken at the register — ${args.closing.what}`,
       // 10/25: a rollback no longer holds, so a hold is now only ever a figure
       // GAM will not bill as it stands — one sentence, no branch.
       held, !held ? null
         : 'A closing read taken at the register that GAM will not bill as it stands — read the face again: a slipped digit, or a genuine figure to confirm',
       carried])).rows[0]
    out.readings.push({ meterId: m.id, readingId: reading.id, held })

    // ── 10/25 (Nic): THE METER CARRIES THE SUSPICION, NOT THE LANDLORD ───────
    //
    // "That just needs to flag in the system that the meter may be broken. I
    // don't want to have to double check a read." So the read above stands and
    // bills; this says somebody should go and look at the dial. Deliberately not
    // out_of_service — that stops it being billed at all, and billing never
    // blocks on a flag.
    if (readingBarelyMoved(m.priorValue, r.value, m.priorDay, todayIso())) {
      await client.query(
        `UPDATE utility_meters
            SET looks_broken_at = COALESCE(looks_broken_at, NOW()),
                looks_broken_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [m.id, `Read ${r.value.toLocaleString()} on ${reading.day} against `
             + `${(m.priorValue ?? 0).toLocaleString()} before it — the dial barely moved, or went backwards. `
             + `The read was taken and billed as no usage; the meter may be stuck or swapped.`])
    }

    if (quote.block === 'double_check' || quote.block === 'no_baseline') {
      out.notes.push(quote.note!)
      continue
    }

    const priced = usageAndCharge(m, r.value)

    if (quote.block === 'in_the_rate') {
      // The absorbed book ADDS, because two guests through one site in a month
      // is two lots of power inside two rates. So a RE-PRESS of the same read
      // must not add the same kilowatts a second time — that would overstate
      // what the park recovered inside its nightly rate, on the one column this
      // door exists to start filling.
      if (!sameReadToday) {
        await recordInTheRate(client, m, args.closing,
          { value: r.value, day: reading.day, usage: priced.usage, charge: priced.charge, tax: priced.tax })
      }
      out.notes.push(quote.note!)
      continue
    }

    // THE BILL. The engine's own insert, with moveOut so it bills the household
    // this read closes out (and, for a stay, the utility service agreement
    // behind it). A FALSE here is an answer, not a failure — read it back and
    // say which one it was.
    const inserted = await tryInsertBill({
      meterId: m.id, unitId: args.closing.unitId, landlordId: args.landlordId,
      utilityType: m.utilityType, cycleMonth: m.cycleMonth,
      usageAmount: priced.usage, allocationMethod: 'submeter', allocationBasis: null,
      ratePerUnit: m.ratePerUnit, baseFeeShare: m.baseFee,
      chargeAmount: priced.charge, taxRatePct: m.taxRatePct, taxAmount: priced.tax,
      sewerRatePerUnit: m.sewerRate > 0 ? m.sewerRate : null,
      readingStart: m.priorValue, readingEnd: r.value,
      readingStartDate: m.priorDay, readingEndDate: reading.day,
      moveOut: true, moveOutLeaseId: args.closing.kind === 'lease' ? args.closing.id : null,
    })
    if (!inserted) {
      // 10/21 — A FALSE HERE IS NOT ALWAYS "NOTHING TO COLLECT".
      //
      // The commonest false at a front desk is the slot already holding the bill
      // THIS door raised and nobody paid for (D2 leaves it owed on purpose), so
      // before explaining anything, the slot is read: if that bill is still
      // genuinely owed it goes back on the ticket, which is the whole of D1 —
      // the ticket is the place, and there is no second place to pay.
      const slot = await counterBillInTheSlot(client, m, args.closing, true)
      if (slot.kind === 'raise') {
        const back = await putExistingBillBackOnTheTicket(client, {
          landlordId: args.landlordId, propertyId: args.propertyId, userId: args.userId,
          unitId: args.closing.unitId, m, bill: slot.bill, readingId: reading.id,
          read: { value: r.value, day: reading.day, usage: priced.usage,
                  charge: priced.charge, tax: priced.tax },
        })
        out.lines.push(back.line)
        if (back.note) out.notes.push(back.note)
        continue
      }
      out.notes.push(slot.kind === 'refused'
        ? slot.why
        : await whyNothingWasBilled(client, m, args.closing))
      continue
    }

    const bill = (await client.query<any>(
      `SELECT ub.id, ub.utility_type, ub.charge_amount::text AS charge, ub.tax_amount::text AS tax,
              to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
              COALESCE(NULLIF(un.display_label, ''), un.unit_number, '') AS space_label
         FROM utility_bills ub JOIN units un ON un.id = ub.unit_id
        WHERE ub.meter_id = $1 AND ub.unit_id = $2 AND ub.billing_cycle_month = $3::date
          AND ub.status = 'unbilled'
        ORDER BY ub.created_at DESC LIMIT 1`,
      [m.id, args.closing.unitId, m.cycleMonth])).rows[0]
    if (!bill) {
      // tryInsertBill said it wrote one and it is not there: say so out loud
      // rather than hand the till a line pointing at nothing.
      logger.error({ meterId: m.id, unitId: args.closing.unitId, cycle: m.cycleMonth },
        '[register-final-utility] a bill was inserted and could not be read back — nothing put on the ticket')
      out.notes.push(await whyNothingWasBilled(client, m, args.closing))
      continue
    }
    const line = counterLineForBill({
      billId: bill.id, utilityType: bill.utility_type as UtilityType,
      billingCycleMonth: bill.cycle, spaceLabel: String(bill.space_label ?? ''),
      charge: round2(Number(bill.charge) || 0), tax: round2(Number(bill.tax) || 0),
    })
    // The open ask, in the SAME book the emailed version writes to. It is what
    // keeps the bill off the Pay Links sendable list while the ticket is open
    // (one place to pay), and the unique index on it is what makes a second
    // collection of the bill impossible rather than unlikely.
    await client.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, raised_at_counter, meter_reading_id, landlord_id, property_id,
          utility_bill_id, unit_id, meter_id, billing_cycle_month, utility_type,
          charge_amount, tax_amount, status, created_by, notes)
       VALUES (NULL, TRUE, $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, 'open', $11, $12)`,
      [reading.id, args.landlordId, args.propertyId, bill.id, args.closing.unitId, m.id,
       bill.cycle, bill.utility_type, line.price.toFixed(2), round2(Number(bill.tax) || 0).toFixed(2),
       args.userId, line.name])
    out.lines.push(line)
  }

  logger.info({ propertyId: args.propertyId, landlordId: args.landlordId,
                closing: `${args.closing.kind}:${args.closing.id}`,
                reads: out.readings.length, billed: out.lines.length, notes: out.notes.length },
    '[register-final-utility] closing read taken at the register')
  return out
}

/**
 * The line a counter-raised bill goes on the ticket as — the SAME shape the
 * emailed version uses (services/utilityPayLink payLinkLineForBill), to the
 * letter, because the recovery report is built around that shape:
 *
 *   NO CATALOG ITEM, so posSale stamps recovers_utility NULL on the sale line
 *     and the report's register sweep cannot count the kilowatts a second time
 *     on top of the bill itself.
 *   NO `cat`, because a bill being collected is not a catalog sale and has no
 *     merchandising category to give.
 *   THE CHARGE BEFORE TAX with a RATE on the line, so the sale records the
 *     utility tax AS TAX instead of folding it into revenue the landlord does
 *     not keep.
 *   THE BILL'S OWN TWO FIGURES DIVIDED as that rate — never the percentage the
 *     bill snapshotted, which is one utility's rate and a bill is not always one
 *     utility (sewer rides the water meter). The 96¢ that door was corrected for
 *     on 10/20 is the same 96¢ here.
 *   ITS BILL NUMBER, so the match is CARRIED and nothing downstream ever pairs a
 *     dollar figure with the words "Electric (per kWh)" and hopes.
 */
export function counterLineForBill(b: {
  billId: string; utilityType: UtilityType; billingCycleMonth: unknown
  spaceLabel: string; charge: number; tax: number
}): CounterBillLine {
  const name = payLinkLineNameForBill(b)
  if (!billTaxFitsItsCharge(b)) {
    throw new AppError(409, billTaxDoesNotFitWords({ lineName: name, charge: b.charge, tax: b.tax }, 'Confirm the read'))
  }
  return {
    utilityBillId: b.billId, id: null, name, qty: 1,
    price: round2(b.charge), tax: billLineTaxRate(b), amount: round2(b.charge + b.tax),
  }
}

// ─── D2 / D1: SETTLING THE TICKET, AND LETTING GO OF IT ──────────────────────

/** The bill ids a cart's lines name — a counter-raised bill's line carries its own. */
export function counterBillIdsInCart(items: unknown): string[] {
  const lines = Array.isArray(items) ? items : []
  return [...new Set(lines
    .filter((l: any) => !l?.id && isUuid(l?.utilityBillId))
    .map((l: any) => String(l.utilityBillId).toLowerCase()))]
}

/** What anybody is told who retyped a counter-raised bill's line or lifted it out. */
export const counterBillLineIsTheBillWords = (name: string, charge: number): string =>
  `That ${name} line is their bill ($${charge.toFixed(2)}) — settling the ticket closes the bill out at the bill's own `
  + `figure, so the line stays as it is. Put it back the way it was, then press Charge again; to stop asking for it `
  + `now, take the closing read off the ticket.`

/** What anybody is told who tried to take a discount off one. */
export const counterBillNoDiscountWords = (name: string): string =>
  `That ${name} line is their bill — a bill is collected in full or it is not collected, so no discount comes off it. `
  + `Take the discount off, then press Charge again (ring anything you are discounting as its own sale).`

export interface CounterBillsOnCart {
  billId: string
  utilityType: UtilityType
  name: string
  charge: number
  tax: number
  taxRate: number
  unitId: string
  /** The charge row on their invoice, if the ordinary route reached it first. */
  paymentId: string | null
  invoiceId: string | null
  tenantId: string | null
}

/**
 * 10/20 — AT THE TILL, A COUNTER-RAISED BILL'S LINE IS STILL THE BILL.
 *
 * Read under the bills' own locks, before the sale is written and before a card
 * is captured. Everything the emailed door refuses here, this one refuses too,
 * for the same reasons and in nearly the same words:
 *
 *   THE BILL ID IS CHECKED, NEVER TRUSTED. It arrives on a line from a browser.
 *     It has to be this company's, at this property, still owed, and HELD BY AN
 *     OPEN COUNTER ASK that this register raised — not a bill id somebody put in
 *     a request to void a stranger's charge off their invoice.
 *   THE LINE CANNOT BEND. Retyped at $10, rung at half the quantity, stripped of
 *     its tax or lifted out of the cart, the sale would take one amount and mark
 *     another collected.
 *   NOR CAN THE SALE BE DISCOUNTED. The discount never touches a line, so it
 *     walks straight past a line check — which is how $75.25 came off an $81.27
 *     bill on the other door.
 *
 * The cart that comes back is the one that gets charged, carrying the BILL'S own
 * price and rate rather than the register's near-enough copies: the match is made
 * to the cent and to four decimals of rate so a line survives the round trip at
 * all, and a tolerance is not a figure.
 */
export async function counterBillsOnCart(
  client: Q, args: {
    landlordId: string; propertyId: string | null; items: unknown; discount: unknown
    /**
     * TRUE inside the sale's own transaction: take the household locks and read
     * the bills FOR UPDATE, so a second register settling the same read waits
     * here and then loses rather than closing the bill out twice. FALSE for the
     * pass that prices the cart before the transaction opens — an advisory lock
     * taken outside a transaction is released at once and would only look like
     * protection.
     */
    lock: boolean
  },
): Promise<{ bills: CounterBillsOnCart[]; items: any[] }> {
  const cart = Array.isArray(args.items) ? args.items : []
  const ids = counterBillIdsInCart(cart)
  if (!ids.length) return { bills: [], items: cart }
  if (!args.propertyId) {
    throw new AppError(400, 'A property must be selected — pick it at the top of the register; a closing read belongs to one park.')
  }

  // Household lock first, then the bill rows — the platform's order
  // (services/moneyPredicates), and chargeVoids requires its callers to hold it.
  if (args.lock) {
    const whose = (await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT ub.tenant_id FROM utility_bills ub
        WHERE ub.id = ANY($1::uuid[]) AND ub.tenant_id IS NOT NULL ORDER BY ub.tenant_id`, [ids])).rows
    for (const w of whose) await lockHousehold(client as PoolClient, w.tenant_id, args.landlordId)
  }

  const rows = (await client.query<any>(
    `SELECT ub.id, ub.status, ub.unit_id, ub.tenant_id, ub.utility_type,
            to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle,
            ub.charge_amount::text AS charge, ub.tax_amount::text AS tax,
            ub.payment_id, p.invoice_id, p.status AS charge_status,
            -- 10/20 — WHETHER A BILL IS STILL OWED IS THE CHARGE'S ANSWER, NOT
            -- THE BILL'S STATUS ON ITS OWN. utility_bills.status is moved by one
            -- trigger and only when a charge reaches 'settled', so three
            -- reachable states leave a bill reading 'billed' while its money is
            -- already answered for: an ACH payment in flight on their invoice,
            -- a charge taken from their deposit at move-out, and one suspended
            -- under work trade. The emailed door was corrected for exactly this
            -- on 10/20 and the counter is the same money twice.
            (ub.payment_id IS NOT NULL AND ${moneyTakenOrMovingRowSql('p')}) AS charge_answered,
            un.property_id, ub.landlord_id,
            COALESCE(NULLIF(un.display_label, ''), un.unit_number, '') AS space_label,
            (SELECT s.id FROM utility_pay_link_settlements s
              WHERE s.utility_bill_id = ub.id AND s.status = 'open' AND s.raised_at_counter) AS counter_ask
       FROM utility_bills ub
       JOIN units un ON un.id = ub.unit_id
       LEFT JOIN payments p ON p.id = ub.payment_id
      WHERE ub.id = ANY($1::uuid[])
      ORDER BY ub.id
      ${args.lock ? 'FOR UPDATE OF ub' : ''}`, [ids])).rows

  const GONE = 'That closing read is no longer on the ticket — nothing was charged. Press Clear, then take the read again.'
  if (rows.length !== ids.length) throw new AppError(409, GONE)

  const bills: CounterBillsOnCart[] = []
  for (const r of rows) {
    if (r.landlord_id !== args.landlordId || r.property_id !== args.propertyId) throw new AppError(409, GONE)
    const charge = round2(Number(r.charge) || 0)
    const tax = round2(Number(r.tax) || 0)
    const name = payLinkLineNameForBill({
      utilityType: r.utility_type as UtilityType, billingCycleMonth: r.cycle,
      spaceLabel: String(r.space_label ?? ''),
    })
    if (r.status === 'paid') {
      throw new AppError(409, `The ${name} bill was already paid some other way — nothing was charged here. `
        + 'Press Clear; it is no longer owed.')
    }
    // Nothing holds it any more: the read was taken off the ticket, the ticket
    // went cold overnight, or another register settled it. Said after "already
    // paid", because the money being in is the more useful answer of the two.
    if (!r.counter_ask) throw new AppError(409, GONE)
    if (r.charge_answered) {
      throw new AppError(409, `The ${name} bill is already answered for on their own bill — a payment of theirs is `
        + 'clearing for it, it was taken from their deposit, or it is being worked off. Nothing was charged here. '
        + 'Press Clear, and take the closing read off the ticket.')
    }
    if (r.status === 'void' || r.status === 'disputed') {
      throw new AppError(409, r.status === 'void'
        ? `The ${name} bill was voided — nobody owes it, so nothing was charged.`
        : `The ${name} bill is under dispute — settle the dispute first. Nothing was charged.`)
    }
    if (!billTaxFitsItsCharge({ charge, tax })) {
      throw new AppError(409, billTaxDoesNotFitWords({ lineName: name, charge, tax }, 'Charge'))
    }
    bills.push({ billId: r.id, utilityType: r.utility_type as UtilityType, name, charge, tax,
                 taxRate: billLineTaxRate({ charge, tax }),
                 unitId: r.unit_id, paymentId: r.payment_id ?? null, invoiceId: r.invoice_id ?? null,
                 tenantId: r.tenant_id ?? null })
  }

  // The line is the bill: same name, same price, same quantity, same tax.
  const key = (name: string, price: number, tax: number) =>
    `${name}|${price.toFixed(2)}|${tax.toFixed(4)}`
  const want = new Map<string, { qty: number; b: CounterBillsOnCart }>()
  for (const b of bills) want.set(key(b.name, b.charge, b.taxRate), { qty: 1, b })
  const have = new Map<string, number>()
  for (const it of cart) {
    if ((it as any)?.id) continue
    const k = key(String((it as any)?.name ?? ''), Number((it as any)?.price) || 0, Number((it as any)?.tax) || 0)
    have.set(k, (have.get(k) ?? 0) + (Number((it as any)?.qty) || 0))
  }
  for (const [k, e] of want) {
    if (Math.abs((have.get(k) ?? 0) - e.qty) > 1e-9) {
      throw new AppError(400, counterBillLineIsTheBillWords(e.b.name, e.b.charge))
    }
  }
  if (Number(args.discount) > 0.005) throw new AppError(400, counterBillNoDiscountWords(bills[0].name))

  // Charged at the bill's own figures, not the register's copy of them.
  const items = cart.map((it: any) => {
    if (it?.id) return it
    const e = want.get(key(String(it?.name ?? ''), Number(it?.price) || 0, Number(it?.tax) || 0))
    return e ? { ...it, price: round2(e.b.charge), tax: e.b.taxRate } : it
  })
  return { bills, items }
}

export interface CounterSettlement {
  bills: Array<{ billId: string; utilityType: UtilityType; amount: number }>
  chargesVoided: string[]
  chargesHeld: string[]
}

/**
 * THE SETTLE. Called in the sale's own transaction, right after the sale is
 * recorded: each bill the ticket carried is closed out and its open counter ask
 * becomes the settlement.
 *
 * The bill is the record of money billed back AND of money collected: it reads
 * 'billed' while it is owed and 'paid' once the ticket is paid, exactly as it
 * would have if they had paid it on their portal. The settlement row adds no
 * second figure — it only says how it was collected. That is why the recovery
 * report counts these kilowatts once and once only.
 *
 * The charge on their invoice is normally absent here (D1: a counter-raised bill
 * goes on no invoice), but it is voided if the ordinary route reached it first —
 * a bill raised at the register, left unpaid, invoiced overnight by the monthly
 * run, and settled at the counter the next morning is an ordinary week at a
 * park. Voided and not settled, because GAM Books records income when a charge is
 * BILLED and a settled charge would accrue the utility income a second time on
 * top of the sale. One income, one cash.
 */
export async function settleCounterBills(
  client: PoolClient, args: { bills: readonly CounterBillsOnCart[]; saleId: string },
): Promise<CounterSettlement> {
  const out: CounterSettlement = { bills: [], chargesVoided: [], chargesHeld: [] }
  for (const b of args.bills) {
    let voidedId: string | null = null
    if (b.paymentId) {
      const v = await voidUnowedCharges((t, pa) => client.query(t, pa), [b.paymentId], COLLECTED_AT_THE_COUNTER)
      if (v.voided.length) { voidedId = v.voided[0].id; out.chargesVoided.push(v.voided[0].id) }
      if (v.held.length) out.chargesHeld.push(...v.held)
    }
    await client.query(
      `UPDATE utility_bills SET status = 'paid', paid_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status IN ('unbilled', 'billed')`, [b.billId])
    const claimed = (await client.query<{ id: string }>(
      `UPDATE utility_pay_link_settlements
          SET status = 'settled', settled_at = NOW(), pos_transaction_id = $2,
              payment_id = COALESCE($3, payment_id), updated_at = NOW()
        WHERE utility_bill_id = $1 AND status = 'open' AND raised_at_counter
        RETURNING id`, [b.billId, args.saleId, voidedId])).rows[0]
    if (!claimed) {
      // The open ask is read and locked above, so this cannot happen; said out
      // loud rather than leaving money collected against no record of it.
      logger.error({ billId: b.billId, saleId: args.saleId },
        '[register-final-utility] the counter ask for this bill was gone when the sale settled — the money is recorded, the ask is not')
    }
    // The bill came off their invoice: its totals follow what is left on it.
    if (b.invoiceId && voidedId) await retotalInvoiceAfterVoid(client, b.invoiceId)
    out.bills.push({ billId: b.billId, utilityType: b.utilityType, amount: round2(b.charge + b.tax) })
  }
  if (out.bills.length) {
    logger.info({ saleId: args.saleId, bills: out.bills.length,
                  chargesVoided: out.chargesVoided.length, chargesHeld: out.chargesHeld.length },
      '[register-final-utility] closing read collected at the register')
  }
  return out
}

/** The same rollup the emailed door runs when a charge comes off an invoice. */
async function retotalInvoiceAfterVoid(q: Q, invoiceId: string): Promise<void> {
  await q.query(
    `WITH lines AS (
       SELECT p.type, p.amount, p.lease_fee_id, p.work_trade_suspended_at
         FROM payments p
        WHERE p.invoice_id = $1
          AND p.status IN ('pending', 'processing', 'settled', 'paid_via_deposit')),
     t AS (
       SELECT COALESCE(SUM(amount) FILTER (WHERE work_trade_suspended_at IS NULL AND type <> 'late_fee'), 0) AS total,
              COALESCE(SUM(amount) FILTER (WHERE type = 'rent'), 0) AS rent,
              COALESCE(SUM(amount) FILTER (WHERE type = 'fee'
                                           OR (type = 'deposit' AND lease_fee_id IS NOT NULL)), 0) AS fees,
              COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND lease_fee_id IS NULL), 0) AS deposits,
              COALESCE(SUM(amount) FILTER (WHERE type = 'utility'), 0) AS utilities,
              COALESCE(SUM(amount) FILTER (WHERE type = 'home_payment'), 0) AS home
         FROM lines)
     UPDATE invoices i
        SET total_amount = t.total, subtotal_rent = t.rent, subtotal_fees = t.fees,
            subtotal_deposits = t.deposits, subtotal_utilities = t.utilities,
            subtotal_home_payments = t.home, updated_at = NOW()
       FROM t
      WHERE i.id = $1 AND i.status <> 'void'
        AND (i.total_amount, i.subtotal_rent, i.subtotal_fees, i.subtotal_deposits,
             i.subtotal_utilities, i.subtotal_home_payments)
            IS DISTINCT FROM (t.total, t.rent, t.fees, t.deposits, t.utilities, t.home)`,
    [invoiceId])
  await q.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [invoiceId])
}

/**
 * D2 — IT WAS NOT PAID, SO THE BILL FALLS BACK TO THE ORDINARY ROUTE.
 *
 * They walked off, or the desk cleared the cart. The power was genuinely used,
 * so NOTHING is written off: the counter's ask is let go ('cancelled', kept
 * forever like every other row in GAM), and the bill is left exactly as the
 * ordinary route expects to find it — 'unbilled', owed, on nobody's invoice yet.
 * From there the routes that have always handled a final bill pick it up: the
 * next monthly run invoices it, the deposit-return sweep lists it, and the Pay
 * Links list offers it to be emailed as a link the moment the ask is gone.
 *
 * The READING stands. It was the real closing read before anybody reached for a
 * card and it is the real closing read now.
 */
export async function releaseCounterBills(
  q: Q, args: { landlordId: string; propertyId: string; billIds: readonly string[] },
): Promise<{ released: number }> {
  const ids = [...new Set(args.billIds.map(s => String(s).toLowerCase()).filter(isUuid))]
  if (!ids.length) return { released: 0 }
  const r = await q.query<{ id: string }>(
    `UPDATE utility_pay_link_settlements s
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
            notes = CASE WHEN COALESCE(s.notes, '') = '' THEN $4
                         ELSE s.notes || ' — ' || $4 END
      WHERE s.utility_bill_id = ANY($1::uuid[]) AND s.status = 'open' AND s.raised_at_counter
        AND s.landlord_id = $2 AND s.property_id = $3
      RETURNING s.id`, [ids, args.landlordId, args.propertyId, COUNTER_BILL_NOT_COLLECTED])
  if (r.rows.length) {
    logger.info({ propertyId: args.propertyId, released: r.rows.length },
      '[register-final-utility] closing read not paid at the counter — the bill is owed the ordinary way')
  }
  return { released: r.rows.length }
}

/**
 * ── 10/24 (Nic) — THE CHECKOUT BOX SEARCHES WHO IS *HERE*, NOT ALL OF GAM ────
 *
 *   "When I go to the checkout list and go to check somebody out, typing a name
 *    in that flow is pulling up every customer in GAM right now. Like, it should
 *    only pull up people that are actually specific to a lease or stay at that
 *    property."
 *
 * The tab was reusing the register's people picker, which is right for a SALE —
 * a stranger can walk up and buy propane, and the platform-wide search is how
 * the counter finds them (services/posPeople searchElsewhere). It is wrong for a
 * CHECK-OUT: you cannot check out somebody who was never here, so every name it
 * offered beyond this property was noise at best and somebody else's customer at
 * worst.
 *
 * So this searches exactly the population the close-out can act on: people with
 * a stay or a lease ON THIS PROPERTY. Nothing crosses a company or a park, and
 * there is no elsewhere leg to disable, because there is no elsewhere.
 *
 * Deliberately generous on WHICH stays and leases: a stay that ended last week
 * still has a final read and a balance to settle, and somebody who moved out
 * yesterday can still be the person at the counter. Cancelled and no-show stays
 * are excluded — there was never anybody on the site to check out.
 */
export interface CheckoutPersonHit {
  name: string
  hint: string
  tenantId: string | null
  posCustomerId: string | null
  email: string | null
  phone: string | null
}

export async function checkoutPeopleHere(
  q: Q, args: { landlordId: string; propertyId: string; typed: string },
): Promise<CheckoutPersonHit[]> {
  const typed = String(args.typed ?? '').trim()
  if (typed.length < 2 || typed.length > 120) return []
  const like = `%${typed.replace(/[\\%_]/g, (c) => '\\' + c)}%`
  const digits = digitsOf(typed)
  // Three or more digits typed is a phone search; fewer is just part of a name.
  const phoneLike = digits.length >= 3 ? `%${digits}%` : null

  const rows = await q.query<any>(
    `WITH here AS (
       -- Everybody on a STAY at this property. A guest with no GAM account is
       -- named on the booking itself, which is why the booking's own columns
       -- are read and not only the tenant's.
       SELECT b.tenant_id,
              COALESCE(NULLIF(TRIM(b.guest_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', gu.first_name, gu.last_name)), '')) AS name,
              COALESCE(NULLIF(TRIM(b.guest_email), ''), gu.email) AS email,
              COALESCE(NULLIF(TRIM(b.guest_phone), ''), gu.phone) AS phone,
              un.unit_number,
              'stay'::text AS what,
              b.check_in AS since
         FROM unit_bookings b
         JOIN units un ON un.id = b.unit_id
         LEFT JOIN tenants gt ON gt.id = b.tenant_id
         LEFT JOIN users gu ON gu.id = gt.user_id
        WHERE un.property_id = $2 AND b.landlord_id = $1
          AND b.status NOT IN ('cancelled', 'no_show')
       UNION ALL
       -- Everybody on a LEASE at this property, including one that just ended:
       -- a move-out still has a final read and a balance to settle.
       SELECT t.id AS tenant_id,
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name,
              u.email, u.phone, un.unit_number,
              'lease'::text AS what,
              l.start_date AS since
         FROM leases l
         JOIN units un ON un.id = l.unit_id
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status <> 'void'
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE un.property_id = $2 AND l.landlord_id = $1
          AND l.status IN ('active', 'pending', 'expired', 'terminated')
     )
     SELECT DISTINCT ON (COALESCE(here.tenant_id::text, lower(here.email), here.name))
            here.name, here.email, here.phone, here.unit_number, here.what, here.tenant_id
       FROM here
      WHERE here.name IS NOT NULL
        AND (here.name ILIKE $3
             OR here.email ILIKE $3
             OR ($4::text IS NOT NULL
                 AND regexp_replace(COALESCE(here.phone, ''), '\\D', '', 'g') LIKE $4))
      ORDER BY COALESCE(here.tenant_id::text, lower(here.email), here.name), here.since DESC
      LIMIT 20`,
    [args.landlordId, args.propertyId, like, phoneLike])

  // A register record for the same person, so picking them hands the close-out
  // the id it already understood (it looks them up by tenant or customer).
  const out: CheckoutPersonHit[] = []
  for (const r of rows.rows) {
    let posCustomerId: string | null = null
    if (!r.tenant_id) {
      const rec = await q.query<{ id: string }>(
        `SELECT id FROM pos_customers
          WHERE landlord_id = $1 AND archived_at IS NULL
            AND (($2::text IS NOT NULL AND lower(email) = lower($2))
              OR ($3::text <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $3))
          ORDER BY created_at LIMIT 1`,
        [args.landlordId, r.email ?? null, digitsOf(r.phone).slice(-10)])
      posCustomerId = rec.rows[0]?.id ?? null
    }
    out.push({
      name: r.name,
      hint: `${r.what === 'lease' ? 'lease' : 'stay'} · ${r.unit_number}`,
      tenantId: r.tenant_id ?? null,
      posCustomerId,
      email: r.email ?? null,
      phone: r.phone ?? null,
    })
  }
  return out
}
