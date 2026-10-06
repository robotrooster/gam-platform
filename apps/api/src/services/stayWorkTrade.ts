/**
 * 10/6 (Nic) — WORK TRADE ON A STAY.
 *
 *   "Can I mark somebody as work trade through the reservation flow? Hey,
 *    they're going to be staying for two months. Mark them as work trade. Boom."
 *
 * He chose: the trade covers EVERYTHING by default (untick any), and the hours
 * are "a per property setting with monitored or trusted setting for that user".
 *
 * A work trade made on a reservation is an ordinary work_trade_agreements row —
 * the same record the Work Trade page, the hours log and the month-close run
 * read — for the guest's account (their resident login by email from any
 * company, else a placeholder account: the same rule as a stay's utility
 * agreement, stayTerms planStayGuestAccount), on the stay's site, for the
 * stay's dates (start = check-in, end = check-out), tied to the stay by
 * booking_id. It is kept in step with the stay (syncStayWorkTrade): extended,
 * shortened, moved to another site (the agreement follows), checked out early
 * or cancelled (ended). A lease drafted from the stay takes it over: the tie to
 * the stay is cleared and it runs with the lease (no end date).
 *
 * What it covers is not billed:
 *   - rent: the stay's own site charge is $0 (routes/units prices it so), so no
 *     deposit link or register ticket is needed for it;
 *   - utilities: the stay's utility agreement (30+ nights, no lease) bills the
 *     covered ones as suspended lines, as the monthly run does for a lease
 *     (jobs/serviceAgreementInvoices).
 * The space still counts for GAM's platform fee: that is counted from the stay
 * on the schedule (services/billableUnits), never from what it costs.
 */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { WORK_TRADE_COVERABLE, DEFAULT_WORK_TRADE_HOURS_TARGET, longCalendarDate, type WorkTradeCoverable } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'
import { AppError } from '../middleware/errorHandler'
import { todayIn } from '../lib/timezone'
import { planStayGuestAccount, stayGuestTenant } from './stayTerms'

/**
 * The work-trade terms the landlord picks — the SAME rules an invite's work
 * trade takes (routes/landlords PATCH /me/pending-intents/:id/work-trade): what
 * it covers (WORK_TRADE_COVERABLE, at least one), whether hours are tracked,
 * the hours per month (the property's setting when left blank) and the duties.
 * A stay adds the person's standing: monitored (the landlord approves their
 * hours) or trusted (their own hours count as logged).
 */
export const workTradeTermsSchema = z.object({
  coveredCharges: z.array(z.enum(WORK_TRADE_COVERABLE)).min(1).nullable().optional(),
  tracksHours: z.boolean().optional(),
  hoursTarget: z.number().int().positive().max(400).nullable().optional(),
  duties: z.string().max(2000).nullable().optional(),
  trusted: z.boolean().optional(),
})
export type WorkTradeTermsInput = z.infer<typeof workTradeTermsSchema>

export interface StayWorkTradeTerms {
  /** Everything by default (Nic, 10/6): untick any. */
  coveredCharges: WorkTradeCoverable[]
  tracksHours: boolean
  /** null = the property's work-trade hours setting. */
  hoursTarget: number | null
  duties: string | null
  /** Monitored (false, the default) or trusted. */
  trusted: boolean
}

/**
 * A request body's `workTrade`: undefined = not sent (leave it as it is),
 * null / false = no work trade, an object = these terms (missing parts take
 * the defaults: everything covered, hours tracked, the property's hours,
 * monitored).
 */
export function stayWorkTradeIn(raw: unknown): StayWorkTradeTerms | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === false) return null
  const parsed = workTradeTermsSchema.safeParse(raw === true ? {} : raw)
  if (!parsed.success) {
    throw new AppError(400, 'Work trade needs at least one thing it covers, and hours per month between 1 and 400. Fix it, then save again.')
  }
  const t = parsed.data
  return {
    coveredCharges: (t.coveredCharges && t.coveredCharges.length ? t.coveredCharges : [...WORK_TRADE_COVERABLE]) as WorkTradeCoverable[],
    tracksHours: t.tracksHours !== false,
    hoursTarget: t.hoursTarget ?? null,
    duties: t.duties?.trim() || null,
    trusted: t.trusted === true,
  }
}

/** Does this work trade cover the stay's own site charge? */
export const coversRent = (t: { coveredCharges: readonly string[] } | null | undefined): boolean =>
  !!t && t.coveredCharges.includes('rent')

/**
 * The ONE insert of a work-trade agreement's terms (used by the Work Trade
 * page's POST /work-trade and by a stay): the hours default to the property's
 * work-trade setting (properties.work_trade_hours_target), then 80; covered
 * charges default to everything.
 */
export async function insertWorkTradeAgreement(run: Pick<PoolClient, 'query'>, a: {
  unitId: string; tenantId: string; landlordId: string
  startDate: string; endDate: string | null; renewalTerms?: string | null
  duties: string | null; hoursTarget: number | null; tracksHours: boolean
  coveredCharges: readonly string[] | null; trusted?: boolean; bookingId?: string | null
}): Promise<any> {
  const propDefault = (await run.query<{ work_trade_hours_target: number | null }>(
    `SELECT p.work_trade_hours_target FROM properties p
       JOIN units u ON u.property_id = p.id WHERE u.id = $1`, [a.unitId])).rows[0]
  return (await run.query<any>(
    `INSERT INTO work_trade_agreements
       (unit_id, tenant_id, landlord_id, duties, start_date, end_date, renewal_terms,
        monthly_hours_target, tracks_hours, covered_charges, trusted, booking_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             COALESCE($10::text[], ARRAY['rent','fees','water','sewer','electric','gas','trash','propane']),
             $11, $12)
     RETURNING *`,
    [a.unitId, a.tenantId, a.landlordId, a.duties, a.startDate, a.endDate, a.renewalTerms ?? null,
     a.hoursTarget ?? propDefault?.work_trade_hours_target ?? DEFAULT_WORK_TRADE_HOURS_TARGET,
     a.tracksHours, a.coveredCharges ? [...a.coveredCharges] : null, a.trusted === true, a.bookingId ?? null])).rows[0]
}

export interface StayWorkTradeRow {
  id: string; status: string; unit_id: string; tenant_id: string
  start_date: string; end_date: string | null
  covered_charges: string[]; trusted: boolean; tracks_hours: boolean; monthly_hours_target: number
  duties: string | null
}

/** The work trade made for this stay, if any (its tie to the stay still in place). */
export async function stayWorkTradeOf(bookingId: string): Promise<StayWorkTradeRow | null> {
  return queryOne<StayWorkTradeRow>(
    `SELECT id, status, unit_id, tenant_id, start_date::text AS start_date, end_date::text AS end_date,
            covered_charges, trusted, tracks_hours, monthly_hours_target, duties
       FROM work_trade_agreements WHERE booking_id = $1`, [bookingId])
}

/**
 * Does a live work trade for this stay cover its rent? Read by every place
 * that prices the stay's site (the schedule's edit, Add a month), so a
 * work-trade stay is never repriced to the site's rate.
 */
export async function stayRentCovered(bookingId: string): Promise<boolean> {
  const wt = await stayWorkTradeOf(bookingId)
  return !!wt && wt.status !== 'ended' && wt.covered_charges.includes('rent')
}

/** A placeholder account's set-up link, made with the work trade — sent after the commit (sendStayWorkTradeInvite). */
export interface StayWorkTradeInvite { token: string; to: string; firstName: string; tenantId: string }

export type StayWorkTradeResult =
  | { action: 'created'; agreementId: string; invite: StayWorkTradeInvite | null }
  | { action: 'updated' | 'ended' | 'carried_to_lease'; agreementId: string }
  | { action: 'none' }
  | { action: 'skipped'; reason: 'no_email' | 'not_a_resident_account' }

/** The refusal for a work trade on a stay whose guest can't hold one. */
export function stayWorkTradeSkippedWords(reason: 'no_email' | 'not_a_resident_account'): string {
  return reason === 'no_email'
    ? 'A work trade is made for the guest\'s own account, so it needs their email. Add their email, then save again.'
    : 'The email on this reservation belongs to an owner or staff login on GAM, not a resident\'s, so a work trade can\'t be made for it. '
      + 'Put the guest\'s own email on the reservation, then save again.'
}

/**
 * Keep a stay's work trade in step with the stay. Call after the stay is
 * written (made, re-dated, moved, checked out, cancelled, or a lease chosen).
 *   terms === undefined — follow the stay only;
 *   terms === null      — the work trade was taken off: it ends;
 *   terms               — make it (none yet) or change its terms.
 * Pass the caller's transaction client to write with the stay; without one it
 * runs on its own.
 */
export async function syncStayWorkTrade(bookingId: string, opts: {
  terms?: StayWorkTradeTerms | null; byUserId?: string | null; client?: PoolClient | null
} = {}): Promise<StayWorkTradeResult> {
  const run: Pick<PoolClient, 'query'> = opts.client ?? { query: (sql: string, p?: any[]) => query(sql, p ?? []).then(rows => ({ rows })) } as any
  const b = (await run.query<any>(
    `SELECT b.id, b.unit_id, b.landlord_id, b.status, b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.guest_name, b.guest_email, b.guest_phone, b.tenant_id, b.stay_terms, p.timezone
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])).rows[0]
  if (!b) return { action: 'none' }
  const existing = (await run.query<StayWorkTradeRow>(
    `SELECT id, status, unit_id, tenant_id, start_date::text AS start_date, end_date::text AS end_date,
            covered_charges, trusted, tracks_hours, monthly_hours_target, duties
       FROM work_trade_agreements WHERE booking_id = $1 FOR UPDATE`, [bookingId])).rows[0] ?? null
  const today = todayIn(b.timezone)

  // Ended now: checked out (the day they left), a no-show (never stayed: the
  // day it began), cancelled or taken off (from today, never before it began
  // nor after the stay's own end).
  const endIt = async (row: StayWorkTradeRow, why: string): Promise<StayWorkTradeResult> => {
    let end = b.status === 'checked_out' ? b.check_out
      : b.status === 'no_show' ? row.start_date
      : (today > row.start_date ? today : row.start_date)
    if (b.status !== 'checked_out' && row.end_date && end > row.end_date) end = row.end_date
    if (row.status === 'ended' && row.end_date === end) return { action: 'none' }
    await run.query(
      `UPDATE work_trade_agreements SET status = 'ended', end_date = $2::date, updated_at = NOW() WHERE id = $1`,
      [row.id, end])
    logger.info({ bookingId, agreementId: row.id, end, why }, '[stay-work-trade] work trade ended with the stay')
    if (row.status !== 'ended' && !opts.client) {
      // As the Work Trade page's End does: the jobs they had taken go back,
      // and unworked hours are settled. Best-effort — the stay's change stands.
      const agreementId = row.id
      await import('./workTradeJobs')
        .then(m => m.releaseJobsFor({ query: (sql: string, p: any[]) => query(sql, p) }, [agreementId]))
        .catch(err => logger.error({ err, agreementId }, '[stay-work-trade] could not hand back jobs'))
      await import('../jobs/workTradeSettlement')
        .then(m => m.settleAgreementOnEnd(agreementId))
        .catch(err => logger.error({ err, agreementId }, '[stay-work-trade] ending settlement failed'))
    }
    return { action: 'ended', agreementId: row.id }
  }

  if (opts.terms === null) {
    if (!existing) return { action: 'none' }
    const r = await endIt(existing, 'taken off')
    // Taken off, it no longer follows the stay (a stay brought back from a
    // cancellation must not bring back a trade the landlord took off). Ticked
    // again, a new one is made.
    await run.query(`UPDATE work_trade_agreements SET booking_id = NULL, updated_at = NOW() WHERE id = $1`, [existing.id])
    return r.action === 'none' ? { action: 'ended', agreementId: existing.id } : r
  }

  // A lease drafted from the stay carries the work trade into the lease: the
  // agreement stays, with no end date, and no longer follows the stay.
  const lease = (await run.query<{ id: string }>(
    `SELECT id FROM leases WHERE source_booking_id = $1 AND status IN ('pending', 'active') LIMIT 1`, [bookingId])).rows[0]
  if (existing && (lease || b.stay_terms === 'lease') && !['cancelled', 'no_show', 'checked_out'].includes(b.status)) {
    await run.query(
      `UPDATE work_trade_agreements
          SET booking_id = NULL, end_date = NULL, unit_id = $2,
              status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END, updated_at = NOW()
        WHERE id = $1`, [existing.id, b.unit_id])
    logger.info({ bookingId, agreementId: existing.id, leaseId: lease?.id ?? null },
      '[stay-work-trade] a lease was drafted from the stay — the work trade runs with the lease')
    return { action: 'carried_to_lease', agreementId: existing.id }
  }

  const over = ['cancelled', 'no_show', 'checked_out'].includes(b.status)
  if (existing) {
    if (over) return endIt(existing, b.status)
    const t = opts.terms
    // 10/6 (review): following the stay never brings back a trade the
    // landlord PAUSED on the Work Trade page — it keeps its pause. (One the
    // landlord ENDED there is untied from the stay — routes/workTrade — so it
    // is never found here.) An ended row here was ended by the stay itself
    // (cancelled, checked out) and comes back with the stay.
    await run.query(
      `UPDATE work_trade_agreements
          SET unit_id = $2, start_date = $3::date, end_date = $4::date,
              status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'active' END,
              covered_charges = COALESCE($5::text[], covered_charges),
              tracks_hours = COALESCE($6, tracks_hours),
              trusted = COALESCE($7, trusted),
              monthly_hours_target = COALESCE($8, monthly_hours_target),
              duties = CASE WHEN $9::boolean THEN $10 ELSE duties END,
              updated_at = NOW()
        WHERE id = $1`,
      [existing.id, b.unit_id, b.check_in, b.check_out,
       t ? [...t.coveredCharges] : null, t ? t.tracksHours : null, t ? t.trusted : null,
       t?.hoursTarget ?? null, !!t, t?.duties ?? null])
    return { action: 'updated', agreementId: existing.id }
  }
  if (!opts.terms || over) return { action: 'none' }

  const plan = await planStayGuestAccount(b)
  if (!plan.ok) return { action: 'skipped', reason: plan.reason }
  let invite: StayWorkTradeInvite | null = null
  const write = async (client: PoolClient): Promise<string> => {
    const guest = await stayGuestTenant(client, b, plan)
    invite = guest.invite ? { ...guest.invite, tenantId: guest.tenantId } : null
    const row = await insertWorkTradeAgreement(client, {
      unitId: b.unit_id, tenantId: guest.tenantId, landlordId: b.landlord_id,
      startDate: b.check_in, endDate: b.check_out,
      renewalTerms: `Work trade for a stay — ${longCalendarDate(b.check_in)} to ${longCalendarDate(b.check_out)}`,
      duties: opts.terms!.duties, hoursTarget: opts.terms!.hoursTarget, tracksHours: opts.terms!.tracksHours,
      coveredCharges: opts.terms!.coveredCharges, trusted: opts.terms!.trusted, bookingId,
    })
    return row.id
  }
  let agreementId: string
  if (opts.client) {
    agreementId = await write(opts.client)
  } else {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      agreementId = await write(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  }
  logger.info({ bookingId, agreementId, byUserId: opts.byUserId ?? null }, '[stay-work-trade] work trade made for a stay')
  // Written on its own: committed here, so its set-up link goes now. With the
  // caller's transaction, the caller sends it after its commit.
  if (!opts.client && invite) await sendStayWorkTradeInvite(bookingId, invite)
  return { action: 'created', agreementId, invite: opts.client ? invite : null }
}

/**
 * 10/6 (review): a work trade made for a guest with no GAM login makes them a
 * placeholder account — and its set-up link has to reach them, or they have no
 * way into their portal to see the trade or log their hours. Sent once the
 * stay is committed. Not sent when the stay's utility agreement was made in the
 * same save: that agreement's own email already carries the same link (one
 * email per thing). Best-effort — the stay and its work trade stand either way.
 * Never logs the link.
 */
export async function sendStayWorkTradeInvite(bookingId: string, invite: StayWorkTradeInvite | null | undefined): Promise<void> {
  if (!invite) return
  try {
    const sameSave = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM utility_service_agreements usa
         JOIN work_trade_agreements w ON w.booking_id = usa.booking_id
        WHERE usa.booking_id = $1 AND usa.created_at >= w.created_at LIMIT 1`, [bookingId])
    if (sameSave) return
    const b = await queryOne<{ landlord_id: string; property_id: string; property_name: string; unit_number: string; tracks_hours: boolean | null }>(
      `SELECT b.landlord_id, p.id AS property_id, p.name AS property_name, u.unit_number,
              (SELECT w.tracks_hours FROM work_trade_agreements w WHERE w.booking_id = b.id LIMIT 1) AS tracks_hours
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id JOIN properties p ON p.id = u.property_id
        WHERE b.id = $1`, [bookingId])
    if (!b) return
    const { emailStayWorkTradeInvite } = await import('./email')
    const { portalLink } = await import('../lib/portalUrls')
    const { replyToProperty } = await import('./replyRouting')
    await emailStayWorkTradeInvite({
      to: invite.to, firstName: invite.firstName, propertyName: b.property_name,
      siteLabel: `site ${b.unit_number}`, logsHours: b.tracks_hours !== false,
      activationUrl: portalLink('tenant', `accept-invite?token=${invite.token}`),
      ctx: { landlordId: b.landlord_id, tenantId: invite.tenantId, replyTo: replyToProperty(b.property_id) },
    })
  } catch (err) {
    logger.error({ err, bookingId }, '[stay-work-trade] the guest\'s account set-up email failed — the work trade stands')
  }
}

/** "Work trade — covers: Rent, Electric, …, trusted" — the reservation's details line. */
export function stayWorkTradeWords(row: Pick<StayWorkTradeRow, 'covered_charges' | 'trusted'>, labels: Record<string, string>): string {
  const all = WORK_TRADE_COVERABLE.every(k => row.covered_charges.includes(k))
  const covers = all ? 'everything' : row.covered_charges.map(k => labels[k] ?? k).join(', ')
  return `Work trade — covers: ${covers}, ${row.trusted ? 'trusted' : 'monitored'}`
}
