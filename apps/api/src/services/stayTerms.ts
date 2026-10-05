/**
 * 10/5 (Nic) — PREPAID STAYS. The one place the long-stay rules live.
 *
 *   "Any stays over thirty days ... does this person get a lease or just a
 *    stay? ... A lease guarantees your spot indefinitely and the stay only
 *    guarantees it for the time that you've paid ahead of time. ... At the
 *    point of sale, same thing, except it's the front counter person that's
 *    clicking lease or no lease. And either way, it goes to me."
 *
 * Every door that sells, books or extends a stay — the register, a pay link,
 * the booking site, the schedule — asks stayNeeds() and does what it says.
 * Nothing here is decided twice:
 *
 *   R1  22+ continuous nights → a background check is required.
 *   R2  30+ continuous nights → lease or stay. The landlord is told either way.
 *   R3  No lease is ever drafted automatically (draftLeaseFromStay only runs
 *       when lease was chosen).
 *   R7  Back-to-back stays of the same person at the same property add up.
 *   R8  The check's fee rides on the payment when nothing is on file, is GAM's
 *       money, and waits for the guest. A5: by card GAM keeps it on its own
 *       balance; in cash, check or on a charge account the landlord holds it
 *       and GAM nets it from their next payout.
 *   R9  Check-in waits for the results and the landlord's decision.
 *   R11 A 30+ night stay with no lease pays its site's utilities through a
 *       utility service agreement tied to the stay.
 */
import type { PoolClient } from 'pg'
import crypto from 'crypto'
import {
  STAY_SCREENING_NIGHTS, STAY_LEASE_CHOICE_NIGHTS, leaseDueDay, longCalendarDate,
  type StayTerms,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { portalLink } from '../lib/portalUrls'
import { createNotification } from './notifications'
import { chargeLandlord } from './landlordGamAccount'
import { replyToProperty } from './replyRouting'
import {
  guestScreeningContext, screeningHistorySentence, RESERVATION_PAID_SQL,
} from './bookingLeaseDraft'

/** Stays that hold or held a site. A cancelled or no-show stay never adds nights. */
const LIVE_STAY_STATUSES = ['tentative', 'confirmed', 'checked_in', 'checked_out']
/** A check still on its way: paid for, not yet decided (or the provider still working). */
const CHECK_IN_PROGRESS = ['pending', 'awaiting_applicant', 'submitted', 'processing', 'complete']
/** Same marker the service-agreement door and the tenant invite use for "not set up yet". */
const PLACEHOLDER_HASH = '$2b$10$placeholder_invite_pending'

export type ScreeningPrepaymentSource = 'register' | 'pay_link' | 'booking_site' | 'schedule'

/**
 * 10/5 (Nic, A5): who is holding the background-check money the stay's payment
 * carried. 'gam' — a card or online payment (register card, pay link, booking
 * site): it lands on GAM's balance and GAM keeps it there. 'landlord' — cash,
 * check, money order or a charge account at the counter: the landlord has it,
 * so GAM takes it from their next payout. Never both.
 */
export type ScreeningCollectedBy = 'gam' | 'landlord'

/**
 * The tenders where the LANDLORD holds the money (A5): cash, check, money
 * order, and a charge account (FlexCharge — the landlord extends it and is paid
 * on it). Every other tender (card, card on file, a card reader, an online
 * page) is taken through Stripe onto GAM's balance.
 */
export const LANDLORD_COLLECTED_TENDERS = ['cash', 'check', 'money_order', 'charge'] as const

/** Is this tender one the landlord holds the money for (A5)? */
export function isLandlordCollectedTender(method: string | null | undefined): boolean {
  return (LANDLORD_COLLECTED_TENDERS as readonly string[]).includes(String(method ?? '').trim().toLowerCase())
}

/** Who collected the background-check money for a payment made with `method` (A5). */
export function screeningCollectedBy(method: string | null | undefined): ScreeningCollectedBy {
  return isLandlordCollectedTender(method) ? 'landlord' : 'gam'
}

type Runner = <T extends Record<string, any>>(sql: string, params: any[]) => Promise<T[]>
const runnerFor = (client: PoolClient | null): Runner =>
  <T extends Record<string, any>>(sql: string, params: any[]) =>
    client ? client.query<any>(sql, params).then(r => r.rows as T[]) : query<T>(sql, params)

const normEmail = (e: string | null | undefined): string | null =>
  (e ?? '').trim().toLowerCase() || null

const daysBetween = (fromYmd: string, toYmd: string): number =>
  Math.round((Date.parse(toYmd.slice(0, 10) + 'T00:00:00Z') - Date.parse(fromYmd.slice(0, 10) + 'T00:00:00Z')) / 86400000)

/** The tenant id and email for a person known by either. */
async function resolvePerson(tenantId?: string | null, email?: string | null): Promise<{
  tenantId: string | null; userId: string | null; email: string | null
}> {
  if (tenantId) {
    const r = await queryOne<{ user_id: string; email: string | null }>(
      `SELECT u.id AS user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
    return { tenantId, userId: r?.user_id ?? null, email: normEmail(email) ?? normEmail(r?.email) }
  }
  const e = normEmail(email)
  if (!e) return { tenantId: null, userId: null, email: null }
  const r = await queryOne<{ user_id: string; tenant_id: string | null }>(
    `SELECT u.id AS user_id, t.id AS tenant_id
       FROM users u LEFT JOIN tenants t ON t.user_id = u.id
      WHERE LOWER(u.email) = $1 ORDER BY t.created_at NULLS LAST LIMIT 1`, [e])
  return { tenantId: r?.tenant_id ?? null, userId: r?.user_id ?? null, email: e }
}

// ── R7: CONTINUOUS NIGHTS ────────────────────────────────────────────────────

export interface StayChain {
  /** Continuous nights, the stay being priced included. */
  nights: number
  /** First night and last check-out of the whole continuous stay. */
  checkIn: string
  checkOut: string
  /** The saved stays in the chain — the one being priced (when saved) included. */
  bookingIds: string[]
  /** Their lease/stay answers, so a later stay in the chain inherits the decision. */
  terms: Array<StayTerms | null>
  /** When the earliest saved stay of the chain was made: a check run after it was run for this stay. */
  earliestCreatedAt: string | null
  /** The person the chain was walked for (from the saved stay when the caller passed nobody). */
  tenantId: string | null
  email: string | null
}

/**
 * 10/5 (Nic, R7): back-to-back = the next stay's check-in is the previous
 * stay's check-out, any site at the SAME property, same person. Continuous
 * nights add up. Person = tenant_id if known, else the guest's email
 * (lowercased). The stay being priced counts even before it is saved — its
 * dates are the ones passed in, which override the saved row's (an extension
 * is priced on its new check-out).
 *
 * Two stays of the same person that OVERLAP (two sites at once) join the chain
 * too, and their nights are counted once: the chain is the person's days on the
 * property, not the sum of rows.
 */
export async function continuousStayNights(args: {
  propertyId: string
  bookingId?: string | null
  tenantId?: string | null
  email?: string | null
  checkIn: string
  checkOut: string
}): Promise<StayChain> {
  const checkIn = String(args.checkIn).slice(0, 10)
  const checkOut = String(args.checkOut).slice(0, 10)
  let tenantId = args.tenantId ?? null
  let email = normEmail(args.email)
  // A saved stay is the same person whatever the caller passed.
  let selfCreatedAt: string | null = null
  let selfTerms: StayTerms | null = null
  if (args.bookingId) {
    const self = await queryOne<{ tenant_id: string | null; guest_email: string | null; created_at: Date; stay_terms: StayTerms | null }>(
      `SELECT tenant_id, guest_email, created_at, stay_terms FROM unit_bookings WHERE id = $1`, [args.bookingId])
    if (self) {
      tenantId = tenantId ?? self.tenant_id
      email = email ?? normEmail(self.guest_email)
      selfCreatedAt = new Date(self.created_at).toISOString()
      selfTerms = self.stay_terms
    }
  }
  if (tenantId && !email) email = (await resolvePerson(tenantId, null)).email
  // The account behind the email, so a stay booked to that tenant with no
  // email on it still joins.
  if (!tenantId && email) tenantId = (await resolvePerson(null, email)).tenantId

  const out: StayChain = {
    nights: Math.max(0, daysBetween(checkIn, checkOut)), checkIn, checkOut,
    bookingIds: args.bookingId ? [args.bookingId] : [],
    terms: args.bookingId ? [selfTerms] : [],
    earliestCreatedAt: selfCreatedAt,
    tenantId, email,
  }
  if (!tenantId && !email) return out

  const others = await query<{ id: string; check_in: string; check_out: string; created_at: Date; stay_terms: StayTerms | null }>(
    `SELECT b.id, b.check_in::text AS check_in, b.check_out::text AS check_out, b.created_at, b.stay_terms
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
      WHERE u.property_id = $1
        AND b.status = ANY($2::text[])
        AND ($3::uuid IS NULL OR b.id <> $3::uuid)
        AND ((b.tenant_id IS NOT NULL AND b.tenant_id = $4::uuid)
             OR ($5::text IS NOT NULL AND LOWER(b.guest_email) = $5::text
                 -- an email match never joins a stay booked to a DIFFERENT tenant
                 AND (b.tenant_id IS NULL OR $4::uuid IS NULL OR b.tenant_id = $4::uuid)))`,
    [args.propertyId, LIVE_STAY_STATUSES, args.bookingId ?? null, tenantId, email])

  // Grow the chain both ways until nothing else touches it.
  let start = checkIn, end = checkOut
  const left = [...others]
  let grew = true
  while (grew) {
    grew = false
    for (let i = left.length - 1; i >= 0; i--) {
      const o = left[i]
      if (o.check_in <= end && o.check_out >= start) {
        if (o.check_in < start) start = o.check_in
        if (o.check_out > end) end = o.check_out
        out.bookingIds.push(o.id)
        out.terms.push(o.stay_terms)
        const created = new Date(o.created_at).toISOString()
        if (!out.earliestCreatedAt || created < out.earliestCreatedAt) out.earliestCreatedAt = created
        left.splice(i, 1)
        grew = true
      }
    }
  }
  out.checkIn = start
  out.checkOut = end
  out.nights = Math.max(0, daysBetween(start, end))
  return out
}

// ── R8: A CHECK ON FILE ──────────────────────────────────────────────────────

export type ScreeningOnFile =
  | { onFile: false }
  | {
      onFile: true
      /**
       * approved    — an approved check this account may rely on, with continuous
       *               tenancy or stays since (guestScreeningContext)
       * stay_check  — the check run for THIS stay: approved, denied or in progress
       * in_progress — a check submitted for this account that is not decided yet
       * prepaid     — a screening already paid for and not used yet
       */
      kind: 'approved' | 'stay_check' | 'in_progress' | 'prepaid'
      checkId?: string
      prepaymentId?: string
    }

/**
 * 10/5 (Nic, R8): does this person already have "a check on file", so no fee
 * is added to the payment? Yes for an approved check this account may rely on
 * with continuous tenancy or stays since, a check already submitted or in
 * progress for this account, or an unused screening prepayment.
 *
 * `stay` (from continuousStayNights) adds the check run for this very stay:
 * once the guest's check for the stay is done — approved OR denied — adding a
 * month to the same continuous stay never charges for a second one. Without
 * it, a guest approved a month before arriving would read as "not continuous
 * since" and be charged again on their first extension.
 */
export async function screeningOnFile(args: {
  landlordId: string
  propertyId?: string | null
  tenantId?: string | null
  email?: string | null
  stay?: Pick<StayChain, 'bookingIds' | 'earliestCreatedAt'> | null
}): Promise<ScreeningOnFile> {
  const person = await resolvePerson(args.tenantId, args.email)
  const prop = args.propertyId
    ? await queryOne<{ timezone: string | null }>(`SELECT timezone FROM properties WHERE id = $1`, [args.propertyId])
    : null

  // 1. Approved, and continuous since.
  const ctx = person.tenantId || person.email
    ? await guestScreeningContext(person.email, args.landlordId, prop?.timezone ?? null, person.tenantId)
    : null
  if (ctx?.approvedCheckAt && ctx.continuousTenancySince) {
    return { onFile: true, kind: 'approved', checkId: ctx.approvedCheckId ?? undefined }
  }

  if (person.userId || person.tenantId) {
    // 2. The check for this stay, decided either way or still running.
    const stayIds = args.stay?.bookingIds ?? []
    if (stayIds.length || args.stay?.earliestCreatedAt) {
      const own = await queryOne<{ id: string }>(
        `SELECT bc.id FROM background_checks bc
          WHERE (bc.user_id = $1 OR bc.tenant_id = $2)
            AND bc.landlord_id IN (SELECT public.account_companies($3))
            AND bc.status = ANY($4::text[])
            AND (bc.id IN (SELECT sp.used_by_check_id FROM screening_prepayments sp
                            WHERE sp.booking_id = ANY($5::uuid[]) AND sp.used_by_check_id IS NOT NULL)
                 OR ($6::timestamptz IS NOT NULL AND bc.created_at >= $6::timestamptz)
                 -- or the one already under way when the stay was booked (step 3 then)
                 OR ($6::timestamptz IS NOT NULL AND bc.created_at < $6::timestamptz
                     AND (bc.decided_at IS NULL OR bc.decided_at >= $6::timestamptz)))
          ORDER BY bc.created_at DESC LIMIT 1`,
        [person.userId, person.tenantId, args.landlordId,
         [...CHECK_IN_PROGRESS, 'approved', 'denied'], stayIds, args.stay?.earliestCreatedAt ?? null])
      if (own) return { onFile: true, kind: 'stay_check', checkId: own.id }
    }

    // 3. Any check for this account still on its way.
    const running = await queryOne<{ id: string }>(
      `SELECT bc.id FROM background_checks bc
        WHERE (bc.user_id = $1 OR bc.tenant_id = $2)
          AND bc.landlord_id IN (SELECT public.account_companies($3))
          AND bc.status = ANY($4::text[]) AND bc.refunded_at IS NULL
        ORDER BY bc.created_at DESC LIMIT 1`,
      [person.userId, person.tenantId, args.landlordId, CHECK_IN_PROGRESS])
    if (running) return { onFile: true, kind: 'in_progress', checkId: running.id }
  }

  // 4. A screening already paid for and not used yet — this person's at this
  //    account, or one paid on a stay of this chain.
  const prepaid = await queryOne<{ id: string }>(
    `SELECT sp.id FROM screening_prepayments sp
      WHERE sp.landlord_id IN (SELECT public.account_companies($1))
        AND ((sp.status = 'unused'
              AND ((sp.tenant_id IS NOT NULL AND sp.tenant_id = $2::uuid)
                   OR ($3::text IS NOT NULL AND LOWER(sp.email) = $3::text)))
             OR (sp.status <> 'void' AND sp.booking_id = ANY($4::uuid[])))
      ORDER BY sp.created_at ASC LIMIT 1`,
    [args.landlordId, person.tenantId, person.email, args.stay?.bookingIds ?? []])
  if (prepaid) return { onFile: true, kind: 'prepaid', prepaymentId: prepaid.id }

  return { onFile: false }
}

// ── THE ONE QUESTION EVERY DOOR ASKS ─────────────────────────────────────────

export interface ScreeningFee {
  /**
   * What the payment carries for the check: the screening, GAM's fee and any
   * state tax — the applicant's intake price before its card processing. The
   * payment that carries it adds its OWN card fee on the whole total (or none
   * for cash), so a card-paying guest pays what they would have at intake and
   * the card fee is never charged twice on this part.
   */
  amount: number
  screening: number
  gamFee: number
  tax: number
  /** What a guest paying for the check on its own, by card, would be charged (intake). */
  intakeTotal: number
}

export interface StayNeeds {
  nights: number
  screening: 'not_needed' | 'on_file' | 'fee_due'
  leaseChoice: 'not_asked' | 'needed' | 'lease' | 'stay'
  screeningFee: ScreeningFee | null
  /** Why screening reads 'on_file' (for the counter's wording). */
  onFile: ScreeningOnFile | null
  chain: StayChain
}

/**
 * The ONE function every door calls before it sells, books or extends a stay
 * (register, pay link, booking site, schedule). `stayTerms` is the answer the
 * guest or the counter just gave, when they gave one.
 */
export async function stayNeeds(args: {
  landlordId: string
  propertyId: string
  bookingId?: string | null
  tenantId?: string | null
  email?: string | null
  checkIn: string
  checkOut: string
  stayTerms?: StayTerms | null
}): Promise<StayNeeds> {
  const chain = await continuousStayNights(args)
  const nights = chain.nights

  let screening: StayNeeds['screening'] = 'not_needed'
  let onFile: ScreeningOnFile | null = null
  let screeningFee: ScreeningFee | null = null
  if (nights >= STAY_SCREENING_NIGHTS) {
    onFile = await screeningOnFile({
      landlordId: args.landlordId, propertyId: args.propertyId,
      tenantId: chain.tenantId, email: chain.email, stay: chain,
    })
    screening = onFile.onFile ? 'on_file' : 'fee_due'
    if (screening === 'fee_due') {
      const prop = await queryOne<{ state: string | null }>(`SELECT state FROM properties WHERE id = $1`, [args.propertyId])
      // The applicant intake price for the property's state — the same
      // calculation background checks are sold at, never a copy of it.
      const { screeningIntakeFee } = await import('../routes/background')
      const fee = await screeningIntakeFee(prop?.state ?? null)
      screeningFee = {
        amount: Math.round((fee.screening + fee.gamFee + fee.tax) * 100) / 100,
        screening: fee.screening, gamFee: fee.gamFee, tax: fee.tax, intakeTotal: fee.total,
      }
    }
  }

  let leaseChoice: StayNeeds['leaseChoice'] = 'not_asked'
  if (nights >= STAY_LEASE_CHOICE_NIGHTS) {
    // The answer just given wins; then this stay's own; then any earlier stay
    // of the same continuous stay (a lease chosen anywhere in it stands).
    const inherited = chain.terms.includes('lease') ? 'lease' : chain.terms.includes('stay') ? 'stay' : null
    const own = args.bookingId ? chain.terms[0] : null
    leaseChoice = args.stayTerms ?? own ?? inherited ?? 'needed'
  }

  return { nights, screening, leaseChoice, screeningFee, onFile, chain }
}

/** Mark a stay as one whose check-in waits on a background check (R9). */
export async function markScreeningRequired(client: PoolClient | null, bookingId: string): Promise<void> {
  await runnerFor(client)(
    `UPDATE unit_bookings SET screening_required = true, updated_at = NOW()
      WHERE id = $1 AND screening_required = false`, [bookingId])
}

// ── R8: THE PREPAID SCREENING ────────────────────────────────────────────────

export interface RecordedPrepayment {
  prepaymentId: string
  /** false when this stay already had one — nothing new was charged. */
  created: boolean
  landlordChargeId: string | null
  /** Emails the guest their (already paid) screening link. Call after COMMIT. */
  afterCommit: () => Promise<void>
}

/**
 * 10/5 (Nic, R8): the background-check fee was taken with a stay's payment.
 * Records it as a screening waiting for the guest. The fee is GAM's screening
 * money, never the landlord's sale revenue — and A5 (Nic, 10/5, after the first
 * build) says where it sits:
 *   - collectedBy 'gam' (card, pay link, booking site): it is already on GAM's
 *     balance. The door keeps it out of the landlord's held/payout share, and
 *     nothing is charged to the landlord here.
 *   - collectedBy 'landlord' (cash, check, money order, charge account): the
 *     landlord holds it, so GAM takes it from their next payout as a
 *     'screening_fee' charge line.
 * Never both (screeningCollectedBy() tells a door which from its tender).
 *
 * Idempotent per stay: a second call for the same booking returns the first
 * prepayment and charges nothing. Pass the caller's transaction client so the
 * record commits or rolls back with the sale; then call afterCommit() to email
 * the guest. With no client it runs and emails on its own.
 *
 * `amount` is stayNeeds().screeningFee.amount — the server's own figure.
 */
export async function recordScreeningPrepayment(client: PoolClient | null, p: {
  landlordId: string
  propertyId: string | null
  bookingId: string | null
  tenantId?: string | null
  email?: string | null
  amount: number
  source: ScreeningPrepaymentSource
  /** Who holds the money (A5) — screeningCollectedBy(tender). */
  collectedBy: ScreeningCollectedBy
  /** The sale, pay link or deposit that carried the fee. */
  sourceId?: string | null
}): Promise<RecordedPrepayment> {
  if (p.collectedBy !== 'gam' && p.collectedBy !== 'landlord') {
    throw new AppError(500, 'A background-check fee was recorded without saying who collected it.')
  }
  if (!(p.amount > 0)) throw new AppError(400, 'A background-check fee must be more than zero.')
  if (!client) {
    const own = await getClient()
    let rec: RecordedPrepayment
    try {
      await own.query('BEGIN')
      rec = await recordScreeningPrepayment(own, p)
      await own.query('COMMIT')
    } catch (e) {
      await own.query('ROLLBACK').catch(() => {})
      throw e
    } finally { own.release() }
    await rec.afterCommit()
    return { ...rec, afterCommit: async () => {} }
  }

  const noop = async () => {}
  if (p.bookingId) {
    const existing = await client.query<{ id: string; landlord_charge_id: string | null }>(
      `SELECT id, landlord_charge_id FROM screening_prepayments
        WHERE booking_id = $1 AND status <> 'void' FOR UPDATE`, [p.bookingId])
    if (existing.rows[0]) {
      return { prepaymentId: existing.rows[0].id, created: false,
               landlordChargeId: existing.rows[0].landlord_charge_id, afterCommit: noop }
    }
  }

  const amount = Math.round(p.amount * 100) / 100
  const ins = await client.query<{ id: string }>(
    `INSERT INTO screening_prepayments
       (landlord_id, property_id, booking_id, tenant_id, email, amount, source, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (booking_id) WHERE booking_id IS NOT NULL AND status <> 'void' DO NOTHING
     RETURNING id`,
    [p.landlordId, p.propertyId, p.bookingId, p.tenantId ?? null, normEmail(p.email),
     amount.toFixed(2), p.source, p.sourceId ?? null])
  if (!ins.rows[0]) {
    // Another sale for the same stay won the race; its record stands.
    const won = await client.query<{ id: string; landlord_charge_id: string | null }>(
      `SELECT id, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1 AND status <> 'void'`,
      [p.bookingId])
    return { prepaymentId: won.rows[0].id, created: false,
             landlordChargeId: won.rows[0].landlord_charge_id, afterCommit: noop }
  }
  const prepaymentId = ins.rows[0].id

  // A5: only money the landlord is holding is taken back from their payout.
  // Money GAM already has (a card) is not charged to anyone a second time.
  let landlordChargeId: string | null = null
  if (p.collectedBy === 'landlord') {
    landlordChargeId = await chargeLandlord(client, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'screening_fee', amount,
      sourceType: 'screening_prepayment', sourceId: prepaymentId,
      notes: 'Background check paid with a stay in cash, check or on account — GAM\'s screening fee',
    })
    await client.query(
      `UPDATE screening_prepayments SET landlord_charge_id = $2 WHERE id = $1`, [prepaymentId, landlordChargeId])
  }
  if (p.bookingId) await markScreeningRequired(client, p.bookingId)

  logger.info({ prepaymentId, bookingId: p.bookingId, amount, source: p.source, collectedBy: p.collectedBy },
    '[stay-terms] screening fee taken with a stay — waiting for the guest')
  return {
    prepaymentId, created: true, landlordChargeId,
    afterCommit: async () => {
      await emailPrepaidScreeningLink(prepaymentId).catch(err => {
        logger.error({ err, prepaymentId }, '[stay-terms] prepaid screening link email failed')
      })
    },
  }
}

/**
 * Email the guest the screening link for a paid, unused screening. The link
 * names this landlord, park and site (10/4) — without them the tenant page has
 * nobody in scope and runs the guest through the renter-pool check. Replies
 * reach the people who run the property (10/5, services/replyRouting).
 */
export async function emailPrepaidScreeningLink(prepaymentId: string): Promise<{ sentTo: string | null }> {
  const row = await queryOne<{
    landlord_id: string; property_id: string | null; status: string; email: string | null
    tenant_email: string | null; guest_email: string | null; guest_name: string | null
    unit_id: string | null; property_name: string | null; booking_property_id: string | null
  }>(
    `SELECT sp.landlord_id, sp.property_id, sp.status, sp.email,
            tu.email AS tenant_email, b.guest_email, b.guest_name, b.unit_id,
            COALESCE(p.name, bp.name) AS property_name, bu.property_id AS booking_property_id
       FROM screening_prepayments sp
       LEFT JOIN tenants t ON t.id = sp.tenant_id
       LEFT JOIN users tu ON tu.id = t.user_id
       LEFT JOIN unit_bookings b ON b.id = sp.booking_id
       LEFT JOIN units bu ON bu.id = b.unit_id
       LEFT JOIN properties bp ON bp.id = bu.property_id
       LEFT JOIN properties p ON p.id = sp.property_id
      WHERE sp.id = $1`, [prepaymentId])
  if (!row || row.status !== 'unused') return { sentTo: null }
  const to = row.email || normEmail(row.tenant_email) || normEmail(row.guest_email)
  if (!to) {
    logger.warn({ prepaymentId }, '[stay-terms] prepaid screening has no email to send the link to')
    return { sentTo: null }
  }
  const propertyId = row.property_id ?? row.booking_property_id
  const qs = new URLSearchParams({ landlordId: row.landlord_id })
  if (propertyId) qs.set('propertyId', propertyId)
  if (row.unit_id) qs.set('unitId', row.unit_id)
  const { emailBackgroundCheckScreeningRequest } = await import('./email')
  await emailBackgroundCheckScreeningRequest(
    to, row.guest_name, row.property_name || 'the property',
    portalLink('tenant', `background-check?${qs.toString()}`),
    { landlordId: row.landlord_id, replyTo: replyToProperty(propertyId), prepaid: true })
  return { sentTo: to }
}

/**
 * The payment that carried a screening was taken back (a chargeback on the
 * card charge — services/heldPayouts): the screening was never really paid, so
 * it is voided and, if the landlord held it, their uncollected charge line is
 * removed (as landlordGamDebit does for a pull that never happened). A
 * screening the guest already used, or whose charge GAM has already taken from
 * a payout, is left as it is.
 *
 * 10/5 (Nic): never on a cancel or a no-show — "a paid screening fee is not
 * refunded on denial or no-show"; the paid check keeps waiting for the guest.
 */
export async function voidScreeningPrepayment(client: PoolClient | null, by: { bookingId?: string; prepaymentId?: string }): Promise<{
  voided: boolean; reason?: 'none' | 'used' | 'collected'
}> {
  if (!by.bookingId && !by.prepaymentId) return { voided: false, reason: 'none' }
  const run = runnerFor(client)
  const [sp] = await run<{ id: string; status: string; landlord_charge_id: string | null }>(
    `SELECT id, status, landlord_charge_id FROM screening_prepayments
      WHERE ${by.prepaymentId ? 'id = $1' : 'booking_id = $1'} AND status <> 'void'
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [by.prepaymentId ?? by.bookingId])
  if (!sp) return { voided: false, reason: 'none' }
  if (sp.status !== 'unused') return { voided: false, reason: 'used' }
  if (sp.landlord_charge_id) {
    const [charge] = await run<{ collected: string }>(
      `SELECT collected_amount::text AS collected FROM landlord_gam_charges WHERE id = $1 FOR UPDATE`,
      [sp.landlord_charge_id])
    if (charge && Number(charge.collected) > 0) {
      logger.error({ prepaymentId: sp.id, chargeId: sp.landlord_charge_id },
        '[stay-terms] screening fee already netted from a payout — prepayment left in place')
      return { voided: false, reason: 'collected' }
    }
    await run(`DELETE FROM landlord_gam_charges WHERE id = $1 AND collected_amount = 0`, [sp.landlord_charge_id])
  }
  await run(
    `UPDATE screening_prepayments SET status = 'void', voided_at = NOW() WHERE id = $1`, [sp.id])
  logger.info({ prepaymentId: sp.id }, '[stay-terms] prepaid screening voided — the stay\'s payment never counted')
  return { voided: true }
}

/**
 * The bookings of a stay's continuous stay (R7: back to back, same person, same
 * property), itself included. One fee per continuous stay, never one per leg.
 */
export async function stayChainBookingIds(bookingId: string): Promise<string[]> {
  const b = await bookingFacts(bookingId)
  if (!b) return [bookingId]
  const chain = await continuousStayNights({
    propertyId: b.property_id, bookingId, tenantId: b.tenant_id, email: b.guest_email,
    checkIn: b.check_in, checkOut: b.check_out,
  })
  return chain.bookingIds.includes(bookingId) ? chain.bookingIds : [bookingId, ...chain.bookingIds]
}

/**
 * Is a background check already paid (not void) for any stay of this
 * continuous stay? Then its fee is not asked for, or taken, a second time.
 */
export async function screeningPaidForStay(bookingId: string): Promise<boolean> {
  const ids = await stayChainBookingIds(bookingId)
  return !!(await queryOne(
    `SELECT 1 FROM screening_prepayments WHERE booking_id = ANY($1::uuid[]) AND status <> 'void' LIMIT 1`, [ids]))
}

/**
 * 10/5 (Nic, R8 — M9/F12): a check paid with a stay was cancelled before any
 * report (the guest cancelled it, or the 30-day sweep closed one they never
 * finished). It has no payment of its own to refund — "the paid check waits for
 * them" — so the screening they paid for goes back to waiting, and starting
 * again charges nothing.
 *
 * The $5 margin GAM booked when that check was submitted (recordScreeningEarnings,
 * keyed to the check) is taken back off the book, so the same payment never
 * books it twice when the guest starts again. Returns whether a prepayment was
 * restored; a check not paid with a stay is left to the caller's refund path.
 */
export async function restorePrepaidScreening(checkId: string): Promise<{ restored: boolean; prepaymentId?: string }> {
  const restored = await query<{ id: string }>(
    `UPDATE screening_prepayments
        SET status = 'unused', used_by_check_id = NULL, used_at = NULL
      WHERE used_by_check_id = $1 AND status = 'used'
      RETURNING id`, [checkId])
  if (!restored.length) return { restored: false }
  try {
    const booked = await queryOne<{ amount: string | null }>(
      `SELECT SUM(amount)::text AS amount FROM platform_revenue_ledger
        WHERE type = 'screening_margin' AND reference_type = 'background_check' AND reference_id = $1`, [checkId])
    const margin = Math.round(Number(booked?.amount ?? 0) * 100) / 100
    if (margin > 0) {
      const { recordPlatformRevenue } = await import('./platformRevenue')
      await recordPlatformRevenue({
        type: 'adjustment', amount: -margin,
        referenceId: checkId, referenceType: 'screening_margin_reversal',
        notes: 'Screening margin taken back: the check paid with a stay was cancelled before a report, and its payment waits for the guest again',
      })
    }
    await query(`UPDATE background_checks SET platform_net = 0 WHERE id = $1 AND platform_net IS DISTINCT FROM 0`, [checkId])
  } catch (err) {
    logger.error({ err, checkId }, '[stay-terms] could not take back the margin of a cancelled prepaid check')
  }
  logger.info({ checkId, prepaymentId: restored[0].id }, '[stay-terms] cancelled prepaid check — the paid screening waits for the guest again')
  return { restored: true, prepaymentId: restored[0].id }
}

// ── R2 / R4: LEASE OR STAY ───────────────────────────────────────────────────

interface BookingFacts {
  id: string; unit_id: string; landlord_id: string; status: string
  check_in: string; check_out: string; guest_name: string | null; guest_email: string | null
  guest_phone: string | null; tenant_id: string | null; stay_terms: StayTerms | null
  screening_required: boolean
  unit_number: string; rent_amount: string | null; monthly_rate: string | null
  property_id: string; property_name: string; timezone: string | null
  rent_due_mode: string | null; rent_due_day: number | null
}

async function bookingFacts(bookingId: string): Promise<BookingFacts | null> {
  return queryOne<BookingFacts>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.guest_name, b.guest_email, b.guest_phone, b.tenant_id, b.stay_terms, b.screening_required,
            COALESCE(NULLIF(u.display_label, ''), u.unit_number) AS unit_number,
            u.rent_amount::text AS rent_amount, u.monthly_rate::text AS monthly_rate,
            p.id AS property_id, p.name AS property_name, p.timezone, p.rent_due_mode, p.rent_due_day
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])
}

/**
 * 10/5 (Nic, R4): the guest (online) or the counter chose a LEASE. Drafts it
 * for the landlord: month-to-month, no end date — it holds the site for as
 * long as they stay — rent = the unit's monthly rent (fallback: its monthly
 * stay rate), due per the PROPERTY's rent-due setting (fixed day → the first
 * bill is prorated; move-in day → anniversary, no proration). It starts at
 * check-in for a stay not yet begun, and TODAY for one already under way (M4).
 * Money already paid on the reservation for the lease's nights comes off its
 * first bill, once (jobs/moveInBundle, RESERVATION_PAID_SQL). Pending and needs_review: the landlord attaches the
 * tenant, checks the terms and sends it for signature.
 *
 * Idempotent per stay (the unique source_booking_id index). Also how a later
 * explicit "Offer a lease" on a stay drafts one.
 */
export async function draftLeaseFromStay(bookingId: string, opts: { byUserId?: string | null } = {}): Promise<{
  drafted: boolean; leaseId?: string
}> {
  const b = await bookingFacts(bookingId)
  if (!b) return { drafted: false }
  if (['cancelled', 'no_show', 'checked_out'].includes(b.status)) return { drafted: false }

  const rent = Number(b.rent_amount) > 0 ? Number(b.rent_amount)
    : Number(b.monthly_rate) > 0 ? Number(b.monthly_rate) : 0
  // 10/5 (Nic, M4): a lease chosen after the stay began (Offer a lease, a month
  // added with lease chosen, a counter answer mid-stay) starts on the day it is
  // drafted — never back-dated to check-in. The nights already stayed were the
  // stay's, paid as the stay; only what was paid for the nights from today on
  // comes off the lease's first bill, once (RESERVATION_PAID_SQL).
  const today = todayIn(b.timezone)
  const leaseStart = b.check_in > today ? b.check_in : today
  const dueDay = leaseDueDay({
    mode: b.rent_due_mode ?? 'fixed_day', propertyDay: b.rent_due_day ?? 1, startIso: leaseStart,
  })

  const client = await getClient()
  let leaseId: string | undefined
  let drafted = false
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE unit_bookings SET stay_terms = 'lease', updated_at = NOW() WHERE id = $1`, [bookingId])
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM leases WHERE source_booking_id = $1`, [bookingId])
    if (existing.rows[0]) {
      leaseId = existing.rows[0].id
    } else {
      const rows = await client.query<{ id: string }>(
        `INSERT INTO leases
           (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
            rent_due_day, needs_review, lease_source, source_booking_id)
         VALUES ($1, $2, $3, 'month_to_month', 'pending', $4, NULL, $5, TRUE, 'booking_draft', $6)
         ON CONFLICT (source_booking_id) WHERE source_booking_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [b.unit_id, b.landlord_id, rent, leaseStart, dueDay, bookingId])
      leaseId = rows.rows[0]?.id
      drafted = !!leaseId
      if (!leaseId) {
        leaseId = (await client.query<{ id: string }>(
          `SELECT id FROM leases WHERE source_booking_id = $1`, [bookingId])).rows[0]?.id
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  if (drafted) {
    logger.info({ bookingId, leaseId, byUserId: opts.byUserId ?? null },
      '[stay-terms] lease chosen for a stay — draft lease created')
  }
  // R11: the lease pays the site's utilities from here, so a stay's utility
  // agreement (if one was made while it was a stay) ends.
  await syncStayUtilityAgreement(bookingId, { byUserId: opts.byUserId }).catch(err =>
    logger.error({ err, bookingId }, '[stay-terms] could not end the stay utility agreement'))
  if (leaseId) {
    await notifyLongStay(bookingId, 'lease', { leaseId }).catch(err =>
      logger.error({ err, bookingId, leaseId }, '[stay-terms] lease-chosen notification failed'))
  }
  return { drafted, leaseId }
}

/**
 * Record the 30+ night answer and do what it means: lease → draft it (which
 * tells the landlord); stay → the site's utilities are billed for the stay and
 * the landlord is told. Call after the sale or booking has committed.
 */
export async function chooseStayTerms(bookingId: string, terms: StayTerms, opts: { byUserId?: string | null } = {}): Promise<{
  terms: StayTerms; leaseId?: string
}> {
  if (terms === 'lease') {
    const r = await draftLeaseFromStay(bookingId, opts)
    return { terms, leaseId: r.leaseId }
  }
  await query(`UPDATE unit_bookings SET stay_terms = 'stay', updated_at = NOW() WHERE id = $1 AND stay_terms IS DISTINCT FROM 'lease'`, [bookingId])
  await syncStayUtilityAgreement(bookingId, opts).catch(err =>
    logger.error({ err, bookingId }, '[stay-terms] stay utility agreement failed'))
  await notifyLongStay(bookingId, 'stay').catch(err =>
    logger.error({ err, bookingId }, '[stay-terms] long-stay notification failed'))
  return { terms }
}

/**
 * 10/5 (Nic, R2): "either way, it goes to me." The landlord is told about
 * every 30+ night stay — a lease chosen (the draft is waiting on the Leases
 * page) or a stay with no lease (held only through what is paid). One notice
 * per stay per answer: an extension of the same stay does not repeat it.
 */
export async function notifyLongStay(bookingId: string, terms: StayTerms, opts: { leaseId?: string } = {}): Promise<{ notified: boolean }> {
  const b = await bookingFacts(bookingId)
  if (!b) return { notified: false }
  const type = terms === 'lease' ? 'lease_drafted_from_booking' : 'long_stay_no_lease'
  const already = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM notifications WHERE type = $1 AND data->>'bookingId' = $2 LIMIT 1`, [type, bookingId])
  if (already) return { notified: false }
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [b.landlord_id])
  if (!owner) return { notified: false }

  const chain = await continuousStayNights({
    propertyId: b.property_id, bookingId, tenantId: b.tenant_id, email: b.guest_email,
    checkIn: b.check_in, checkOut: b.check_out,
  })
  const ctx = await guestScreeningContext(b.guest_email, b.landlord_id, b.timezone, b.tenant_id)
  const guest = b.guest_name || 'A guest'
  const prepaid = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM screening_prepayments WHERE booking_id = $1 AND status <> 'void' LIMIT 1`, [bookingId])
  const screeningLine = prepaid
    ? ' Their background check was paid with the stay and the link was emailed to them; check-in waits for the results and your decision.'
    : b.screening_required || chain.nights >= STAY_SCREENING_NIGHTS
    ? ' A stay this long needs a background check before check-in.'
    : ''

  let title: string, body: string, actionUrl: string
  if (terms === 'lease') {
    const paid = await queryOne<{ paid: string | null; paid_whole: boolean; lease_start: string | null }>(
      `SELECT ${RESERVATION_PAID_SQL}::text AS paid,
              (b.balance_paid_at IS NOT NULL OR (b.deposit_paid_at IS NOT NULL AND b.deposit_amount IS NULL)) AS paid_whole,
              (SELECT sl.start_date::text FROM leases sl
                WHERE sl.source_booking_id = b.id AND sl.start_date > b.check_in LIMIT 1) AS lease_start
         FROM unit_bookings b WHERE b.id = $1`, [bookingId])
    // 10/3 (decisions #15): what was paid toward the reservation comes off the
    // lease's first bill (jobs/moveInBundle), so the landlord is told it will
    // not be billed twice. M4: a lease that starts mid-stay takes only what was
    // paid for its own nights.
    const paidToward = Number(paid?.paid ?? 0)
    const depositLine = paid?.lease_start
      ? ` The lease starts ${longCalendarDate(paid.lease_start)}, partway through the stay.`
        + (paidToward > 0
            ? ` The $${paidToward.toFixed(2)} already paid for the nights from then on comes off its first bill.`
              + ' Anything more than that bill\'s rent is kept as credit toward the next one.'
            : '')
      : paidToward > 0
      ? (paid?.paid_whole
          ? ` The $${paidToward.toFixed(2)} already paid for the whole stay comes off the lease's first bill.`
          : ` The $${paidToward.toFixed(2)} deposit already paid on the reservation comes off the lease's first bill.`)
        + ' Anything more than that bill\'s rent is kept as credit toward the next one.'
      : ' A deposit paid on the reservation before the lease is signed comes off its first bill.'
    title = 'Long stay — lease chosen, draft ready'
    body = `${guest} chose a lease for their ${chain.nights}-night stay on site ${b.unit_number}. `
      + 'A month-to-month draft lease is ready on your Leases page — review it and send it for signature.'
      + screeningHistorySentence(ctx) + screeningLine + depositLine
    actionUrl = opts.leaseId ? `/leases?open=${opts.leaseId}` : '/leases'
  } else {
    title = 'Long stay — no lease'
    body = `${guest} is staying ${chain.nights} nights on site ${b.unit_number} without a lease. `
      + `Their site is held through ${longCalendarDate(chain.checkOut)}; after that it can be booked by someone else.`
      + screeningHistorySentence(ctx) + screeningLine
    actionUrl = `/schedule?booking=${bookingId}&unit=${b.unit_id}`
  }

  await createNotification({
    userId: owner.user_id, landlordId: b.landlord_id, type, title, body,
    data: {
      bookingId, terms, leaseId: opts.leaseId ?? null, nights: chain.nights,
      priorStays: ctx.priorStays, approvedCheckAt: ctx.approvedCheckAt,
      continuousTenancySince: ctx.continuousTenancySince,
    },
    actionUrl,
  })
  return { notified: true }
}

// ── R11: UTILITIES ON A STAY WITH NO LEASE ───────────────────────────────────

export type StayUtilityResult =
  | { action: 'created' | 'updated' | 'ended'; agreementId: string }
  | { action: 'none' }
  | { action: 'skipped'; reason: 'no_email' | 'not_a_resident_account' | 'site_has_agreement' }

/**
 * 10/5 (Nic, R11): a stay of 30+ nights with no lease is invoiced for its
 * site's utilities. The mechanism is the one the landlord already uses for a
 * space with no lease: a utility service agreement, here for the stay guest on
 * that site — start = check-in, end = the paid-through check-out, the guest's
 * agreement recorded at the sale (attested), booking_id tying it to the stay.
 *
 * Kept in step: call after every sale, extension, date change, check-out
 * (stayCheckOut, earlyCheckOut), cancellation or lease choice. An extension
 * moves its end date; check-out, cancellation or no-show ends it on the day
 * they left; a lease chosen later ends it (the lease pays the utilities from
 * then). Shorter stays have utilities included.
 *
 * An ENDED agreement still bills what was used inside its own dates
 * (services/utilityBilling): its check-out read is a move-out read that bills
 * the last stretch, and the invoice job sends that final bill.
 *
 * Who pays (A4, Nic 10/5): "if a customer at Oak Park moved here for a few
 * months without a lease they could pay utilities through their email." The
 * stay's own tenant when it has one; otherwise the GAM login the guest's email
 * already has — a resident's login from ANY company. Only when the email has no
 * login is a placeholder account made (an invite they set up from the email).
 * An email that belongs to a landlord's or staff member's login is not a
 * resident and is skipped — and the landlord is told in plain words.
 */
export async function syncStayUtilityAgreement(bookingId: string, opts: { byUserId?: string | null } = {}): Promise<StayUtilityResult> {
  const b = await bookingFacts(bookingId)
  if (!b) return { action: 'none' }
  const existing = await queryOne<{ id: string; status: string; unit_id: string; start_date: string; end_date: string | null }>(
    `SELECT id, status, unit_id, start_date::text AS start_date, end_date::text AS end_date
       FROM utility_service_agreements WHERE booking_id = $1`, [bookingId])
  const lease = await queryOne<{ id: string }>(
    `SELECT id FROM leases WHERE source_booking_id = $1 AND status IN ('pending', 'active') LIMIT 1`, [bookingId])
  const today = todayIn(b.timezone)

  const over = ['cancelled', 'no_show', 'checked_out'].includes(b.status)
  const leaseTakesOver = b.stay_terms === 'lease' || !!lease
  if (over || leaseTakesOver) {
    if (!existing) return { action: 'none' }
    if (existing.status !== 'active') {
      // Already ended. Its dates are what it bills (services/utilityBilling),
      // so a checked-out stay whose day of leaving was corrected afterwards
      // follows the real day — unless a lease took over from it.
      if (b.status !== 'checked_out' || leaseTakesOver || existing.end_date === b.check_out) return { action: 'none' }
      await query(
        `UPDATE utility_service_agreements SET end_date = $2, updated_at = NOW() WHERE id = $1`,
        [existing.id, b.check_out])
      return { action: 'ended', agreementId: existing.id }
    }
    // Checked out: the day they left. A no-show never stayed: it ends the day
    // it began, a zero-length agreement that bills nothing (services/utilityBilling).
    // Cancelled or a lease chosen: from today (never before it started, never
    // after the stay's own end) — a stay cancelled before arrival ends the day
    // it would have begun.
    let end = b.status === 'checked_out' ? b.check_out
      : b.status === 'no_show' ? existing.start_date
      : (today > existing.start_date ? today : existing.start_date)
    if (b.status !== 'checked_out' && existing.end_date && end > existing.end_date) end = existing.end_date
    await query(
      `UPDATE utility_service_agreements SET status = 'ended', end_date = $2, updated_at = NOW() WHERE id = $1`,
      [existing.id, end])
    logger.info({ bookingId, agreementId: existing.id, end, why: over ? b.status : 'lease' },
      '[stay-terms] stay utility agreement ended')
    return { action: 'ended', agreementId: existing.id }
  }

  if (existing) {
    // In step with the stay: its dates and its site. A stay that came back
    // (a check-out undone) is billed again.
    try {
      await query(
        `UPDATE utility_service_agreements
            SET end_date = $2::date, unit_id = $3, status = 'active',
                start_date = CASE WHEN NOT EXISTS (SELECT 1 FROM invoices i WHERE i.service_agreement_id = utility_service_agreements.id)
                                  THEN $4::date ELSE start_date END,
                updated_at = NOW()
          WHERE id = $1`,
        [existing.id, b.check_out, b.unit_id, b.check_in])
    } catch (err: any) {
      if (err?.code !== '23505') throw err
      logger.warn({ bookingId, agreementId: existing.id }, '[stay-terms] the site already bills another agreement — stay agreement left as it was')
      return { action: 'skipped', reason: 'site_has_agreement' }
    }
    return { action: 'updated', agreementId: existing.id }
  }

  if (b.stay_terms !== 'stay') return { action: 'none' }
  const chain = await continuousStayNights({
    propertyId: b.property_id, bookingId, tenantId: b.tenant_id, email: b.guest_email,
    checkIn: b.check_in, checkOut: b.check_out,
  })
  if (chain.nights < STAY_LEASE_CHOICE_NIGHTS) return { action: 'none' }

  return createStayAgreement(b, opts.byUserId ?? null)
}

/**
 * A5/R11: tell the landlord, once per stay, that its utilities are not being
 * billed because the guest's email is a landlord's or staff member's login.
 */
async function noticeStayUtilitiesNotBilled(b: BookingFacts): Promise<void> {
  try {
    const type = 'stay_utilities_not_billed'
    const already = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM notifications WHERE type = $1 AND data->>'bookingId' = $2 LIMIT 1`, [type, b.id])
    if (already) return
    const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [b.landlord_id])
    if (!owner) return
    const guest = b.guest_name || 'This guest'
    await createNotification({
      userId: owner.user_id, landlordId: b.landlord_id, type,
      title: `Utilities not billed — site ${b.unit_number}`,
      body: `${guest} is staying 30 nights or more on site ${b.unit_number} without a lease, so the site's utilities are billed to them. `
        + `But the email on the reservation belongs to an owner or staff login on GAM, not a resident's, so their utilities can't be billed to it. `
        + 'Put the guest\'s own email on the reservation and their utilities will be billed to them from then on.',
      data: { bookingId: b.id, unitId: b.unit_id },
      actionUrl: `/schedule?booking=${b.id}&unit=${b.unit_id}`,
    })
  } catch (err) {
    logger.error({ err, bookingId: b.id }, '[stay-terms] could not tell the landlord a stay\'s utilities are not billed')
  }
}

async function createStayAgreement(b: BookingFacts, byUserId: string | null): Promise<StayUtilityResult> {
  const emailNorm = normEmail(b.guest_email)
  const property = await queryOne<any>(
    `SELECT late_fee_enabled, late_fee_grace_days,
            late_fee_initial_amount, late_fee_initial_type,
            late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period,
            late_fee_cap_amount, late_fee_cap_type
       FROM properties WHERE id = $1`, [b.property_id])

  // Which account pays (A4). The stay's own tenant when it has one; otherwise
  // the login the guest's email already has, from any company; otherwise a
  // placeholder account made here.
  let existingUser: { id: string; tenant_id: string | null; role: string; email: string; needs_setup: boolean } | null = null
  let sendInvite = false
  if (!b.tenant_id) {
    if (!emailNorm) return { action: 'skipped', reason: 'no_email' }
    existingUser = await queryOne(
      `SELECT u.id, t.id AS tenant_id, u.role, u.email,
              (u.password_hash = $2 AND u.tenant_invite_accepted_at IS NULL) AS needs_setup
         FROM users u LEFT JOIN tenants t ON t.user_id = u.id
        WHERE lower(u.email) = $1
        ORDER BY t.created_at NULLS LAST LIMIT 1`, [emailNorm, PLACEHOLDER_HASH])
    if (existingUser && existingUser.role !== 'tenant') {
      logger.warn({ bookingId: b.id }, '[stay-terms] the guest\'s email is a landlord or staff login — stay utilities not billed')
      await noticeStayUtilitiesNotBilled(b)
      return { action: 'skipped', reason: 'not_a_resident_account' }
    }
    if (!existingUser) {
      sendInvite = true
    } else if (existingUser.needs_setup) {
      // S654: a password link only for an account still to be set up that no
      // other company has. Anyone else already has their way in.
      const { accountTiedElsewhere } = await import('../jobs/leaseParser/resolveIntent')
      const own = await query<{ id: string }>(`SELECT public.account_companies($1) AS id`, [b.landlord_id])
      sendInvite = !(await accountTiedElsewhere(existingUser.id, [b.landlord_id, ...own.map(r => r.id)]))
    }
  }

  const insertAgreement = async (client: PoolClient, tenantId: string) => (await client.query<{ id: string }>(
    `INSERT INTO utility_service_agreements (
       landlord_id, unit_id, tenant_id, service_address, note, booking_id,
       billing_due_day, start_date, end_date, created_by,
       late_fee_enabled, late_fee_grace_days,
       late_fee_initial_amount, late_fee_initial_type,
       late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period,
       late_fee_cap_amount, late_fee_cap_type,
       payer_attested_at, payer_attested_by, payer_attestation_note
     ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),$9,$19)
     RETURNING id`,
    [b.landlord_id, b.unit_id, tenantId, `${b.property_name}, site ${b.unit_number}`,
     'Utilities for a stay of 30+ nights with no lease', b.id,
     b.check_in, b.check_out, byUserId,
     property?.late_fee_enabled ?? true, property?.late_fee_grace_days ?? null,
     property?.late_fee_initial_amount ?? null, property?.late_fee_initial_type ?? 'flat',
     property?.late_fee_accrual_amount ?? null, property?.late_fee_accrual_type ?? null,
     property?.late_fee_accrual_period ?? null,
     property?.late_fee_cap_amount ?? null, property?.late_fee_cap_type ?? null,
     'Agreed when the stay was sold: a stay of 30+ nights with no lease pays its site\'s utilities.'])).rows[0].id

  const client = await getClient()
  let agreementId: string
  let tenantId: string
  let invite: { token: string; to: string; firstName: string } | null = null
  try {
    await client.query('BEGIN')
    if (b.tenant_id) {
      tenantId = b.tenant_id
    } else {
      const [first, ...rest] = String(b.guest_name || 'Guest').trim().split(/\s+/)
      let userId: string
      if (existingUser) {
        userId = existingUser.id
      } else {
        const u = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, $5, 'tenant', $2, $3, $4) RETURNING id`,
          [emailNorm, first || 'Guest', rest.join(' '), b.guest_phone, PLACEHOLDER_HASH])
        userId = u.rows[0].id
      }
      if (sendInvite) {
        // S654: a live token is kept, not replaced — another email may already
        // carry it. Only an account still to be set up gets one.
        const stored = await client.query<{ tenant_invite_token: string }>(
          `UPDATE users
              SET tenant_invite_token = CASE
                    WHEN tenant_invite_token IS NOT NULL AND tenant_invite_expires_at > NOW()
                    THEN tenant_invite_token ELSE $1 END,
                  tenant_invite_expires_at = CASE
                    WHEN tenant_invite_token IS NOT NULL AND tenant_invite_expires_at > NOW()
                    THEN tenant_invite_expires_at ELSE NOW() + INTERVAL '7 days' END,
                  updated_at = NOW()
            WHERE id = $2 AND password_hash = $3 AND tenant_invite_accepted_at IS NULL
            RETURNING tenant_invite_token`, [crypto.randomBytes(32).toString('hex'), userId, PLACEHOLDER_HASH])
        if (stored.rows.length) {
          invite = { token: stored.rows[0].tenant_invite_token, to: existingUser?.email ?? emailNorm!, firstName: first || 'there' }
        }
      }
      const t = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE user_id = $1`, [userId])
      tenantId = t.rows[0]?.id ?? (await client.query<{ id: string }>(
        `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`, [userId])).rows[0].id
    }

    // The property's late-fee policy is STAMPED on, as on every agreement
    // (S558: the instrument is the charge).
    await client.query('SAVEPOINT stay_agreement')
    try {
      agreementId = await insertAgreement(client, tenantId)
    } catch (err: any) {
      if (err?.code !== '23505') throw err
      await client.query('ROLLBACK TO SAVEPOINT stay_agreement')
      // The site's live agreement is an EARLIER stay's that ends on or before
      // this one arrives (back-to-back on the same site, sold while the first
      // guest is still there). Its billing runs on its own dates whether it
      // reads active or ended, so it is ended at its own check-out and this
      // stay's is made. Anything else on the site (a serviced space, a stay
      // still running into this one) stands, and this stay is not billed.
      const ended = await client.query(
        `UPDATE utility_service_agreements
            SET status = 'ended', updated_at = NOW()
          WHERE unit_id = $1 AND status = 'active' AND booking_id IS NOT NULL
            AND end_date IS NOT NULL AND end_date <= $2::date
          RETURNING id`, [b.unit_id, b.check_in])
      if (!ended.rowCount) throw err
      agreementId = await insertAgreement(client, tenantId)
    }
    await client.query('COMMIT')
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {})
    if (err?.code === '23505') {
      logger.warn({ bookingId: b.id }, '[stay-terms] the site already bills another agreement — no stay agreement made')
      return { action: 'skipped', reason: 'site_has_agreement' }
    }
    throw err
  } finally { client.release() }

  logger.info({ bookingId: b.id, agreementId, tenantId }, '[stay-terms] stay utility agreement created')
  if (invite) {
    // Post-commit — a mail failure never undoes the agreement. Never log the link.
    try {
      const landlord = await queryOne<{ first_name: string | null; last_name: string | null }>(
        `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [b.landlord_id])
      const providerName = landlord ? `${landlord.first_name ?? ''} ${landlord.last_name ?? ''}`.trim() || b.property_name : b.property_name
      const { emailUtilityServiceInvite } = await import('./email')
      await emailUtilityServiceInvite(
        invite.to, invite.firstName, providerName, `${b.property_name}, site ${b.unit_number}`,
        portalLink('tenant', `accept-invite?token=${invite.token}`),
        { landlordId: b.landlord_id, tenantId, replyTo: replyToProperty(b.property_id) })
    } catch (err) {
      logger.error({ err, bookingId: b.id }, '[stay-terms] utility invite email failed — agreement created')
    }
  }
  return { action: 'created', agreementId }
}

// ── R9: CHECK-IN WAITS ON SCREENING ──────────────────────────────────────────

export interface CheckInBlock {
  code: 'screening_pending'
  /** What check-in is waiting on. */
  waitingOn: 'no_check' | 'guest' | 'results' | 'decision'
  message: string
  checkId?: string
}

/**
 * 10/5 (Nic, R9): a stay that needs screening checks in only once the check's
 * results are back AND the landlord has decided. Approved or denied both clear
 * it — after a denial the landlord may still check them in (Nic). No other
 * override. A guest with an approved check on file and continuous stays or
 * tenancy since needs no new one.
 *
 * A6 (Nic, 10/5): a decision counts only once results are back — and the
 * decision route refuses one before then (routes/background), while a provider
 * update never overwrites a decision (backgroundApplyUpdate). So a decided
 * check IS one whose results came back.
 *
 * A7 (Nic, 10/5): only a stay marked screening_required waits. Every door that
 * sells, books or extends a stay of 22+ nights marks it; stays booked before
 * this change were never marked and are never blocked (R15).
 */
export async function checkInBlock(bookingId: string): Promise<CheckInBlock | null> {
  const b = await bookingFacts(bookingId)
  if (!b) return null
  const chain = await continuousStayNights({
    propertyId: b.property_id, bookingId, tenantId: b.tenant_id, email: b.guest_email,
    checkIn: b.check_in, checkOut: b.check_out,
  })
  // A continuous stay shortened (or a back-to-back leg cancelled) below 22
  // nights needs no check any more (R1), whatever was marked when it was longer.
  if (chain.nights < STAY_SCREENING_NIGHTS) return null
  // A7: only a stay marked when it was sold (screening_required) waits — this
  // one, or another leg of the same continuous stay, so a first leg booked
  // short is not checked in unscreened only for the guest to be stopped when
  // the leg that made the stay 22+ begins. Stays from before 10/5 are never marked.
  if (!b.screening_required) {
    const marked = await queryOne<{ x: number }>(
      `SELECT 1 AS x FROM unit_bookings
        WHERE id = ANY($1::uuid[]) AND screening_required AND status NOT IN ('cancelled', 'no_show') LIMIT 1`,
      [chain.bookingIds])
    if (!marked) return null
  }

  const person = await resolvePerson(b.tenant_id, b.guest_email)
  const ctx = await guestScreeningContext(person.email, b.landlord_id, b.timezone, person.tenantId)

  // The check run for this stay, newest first.
  const stayCheck = person.userId || person.tenantId
    ? await queryOne<{ id: string; status: string }>(
        `SELECT bc.id, bc.status
           FROM background_checks bc
          WHERE (bc.user_id = $1 OR bc.tenant_id = $2)
            AND bc.landlord_id IN (SELECT public.account_companies($3))
            AND bc.status NOT IN ('cancelled', 'failed', 'expired')
            AND (bc.id IN (SELECT sp.used_by_check_id FROM screening_prepayments sp
                            WHERE sp.booking_id = ANY($4::uuid[]) AND sp.used_by_check_id IS NOT NULL)
                 OR ($5::timestamptz IS NOT NULL AND bc.created_at >= $5::timestamptz)
                 -- the check already under way when the stay was booked: it is
                 -- what waived the fee (screeningOnFile), so it is the one
                 -- check-in waits on.
                 OR ($5::timestamptz IS NOT NULL AND bc.created_at < $5::timestamptz
                     AND (bc.decided_at IS NULL OR bc.decided_at >= $5::timestamptz)))
          ORDER BY bc.created_at DESC LIMIT 1`,
        [person.userId, person.tenantId, b.landlord_id, chain.bookingIds, chain.earliestCreatedAt])
    : null

  // An approved check from before this stay, with continuity since: on file.
  if (ctx.approvedCheckAt && ctx.continuousTenancySince && ctx.approvedCheckId !== stayCheck?.id) return null

  if (stayCheck) {
    if (stayCheck.status === 'approved' || stayCheck.status === 'denied') return null
    if (['submitted', 'processing'].includes(stayCheck.status)) {
      return {
        code: 'screening_pending', waitingOn: 'results', checkId: stayCheck.id,
        message: 'This guest is staying more than three weeks, so check-in waits for their background check. '
          + 'The results aren\'t back yet.',
      }
    }
    if (stayCheck.status === 'complete') {
      return {
        code: 'screening_pending', waitingOn: 'decision', checkId: stayCheck.id,
        message: 'This guest\'s background check results are back. Approve or deny it on the Background Checks page, then check them in.',
      }
    }
    return {
      code: 'screening_pending', waitingOn: 'guest', checkId: stayCheck.id,
      message: 'This guest is staying more than three weeks, so check-in waits for their background check. '
        + 'They have started it but haven\'t finished it yet.',
    }
  }

  const prepaid = await queryOne<{ id: string }>(
    `SELECT id FROM screening_prepayments
      WHERE booking_id = ANY($1::uuid[]) AND status = 'unused' LIMIT 1`, [chain.bookingIds])
  return {
    code: 'screening_pending', waitingOn: 'no_check',
    message: 'This guest is staying more than three weeks, so check-in waits for their background check. '
      + (prepaid
          ? `It's paid for and the link was emailed to ${person.email ?? 'them'} — they haven't filled it out yet.`
          : 'No background check is on file for them yet.'),
  }
}
