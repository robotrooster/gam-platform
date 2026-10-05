/**
 * S655 — a NEW LEASE for a household already living there.
 *
 * Nic (10/2): "they always get charged the new rent, whether or not they sign
 * it... the old one is expired... they've had plenty of notice." And: GAM never
 * gates on legality — there is no minimum-notice block.
 *
 * What that means in the data:
 *
 *   - The landlord's signature issues the new lease (S647), linked to the lease
 *     it follows by leases.supersedes_lease_id. It waits 'pending' until its
 *     start date.
 *   - On the start date the lease it follows ENDS THE DAY BEFORE — a
 *     month-to-month gets its first end date. Nothing is written on the old
 *     lease before then, so nothing anywhere says it is ending while the new
 *     one waits. (closePredecessorOfStartedRenewals)
 *   - A SIGNED FIXED TERM is never cut short this way: a start inside the
 *     term is refused (assertNewLeaseDates). Shortening a term the household
 *     signed, at a new rent, on the landlord's signature alone would override
 *     that lease (lease is law — Nic: "We can't have a landlord saying the
 *     tenant signed the lease for eight hundred dollars and trying to charge
 *     them nine hundred").
 *   - From the day after the term ends the same rule applies to a fixed term
 *     (decisions 10/2 #7): a landlord-signed new lease takes over on its start
 *     date, signed by the tenant or not. THERE IS NEVER A STRETCH WITH NO LEASE.
 *     A new lease that starts later than the day after the term ends leaves
 *     the household HOLDING OVER on the old lease, at the old rent, until the
 *     day before the new start: the night the term runs out, its end date
 *     becomes that day (holdOverUntilNewLeaseStarts), so it keeps billing and
 *     nothing reads it as a move-out. The end date the household SIGNED is
 *     kept beside it (leases.holdover_signed_end_date) — a held-over day is
 *     never called the end of the signed lease, and the next new lease's term
 *     is as long as the one they signed, not that plus the holdover. Worked
 *     through:
 *         term ends 9/30, new lease 10/1  → no holdover; 10/1 is the new rent.
 *         term ends 9/30, new lease 10/31 → the old lease runs to 10/30 and
 *                                           bills 10/1 at the old rent; the
 *                                           new rent starts 11/1.
 *         term ends 9/30, new lease 9/15  → refused (inside the signed term).
 *         held over to 10/30, that new lease canceled, another sent for 10/15
 *                                         → accepted: the signed term is over,
 *                                           and the old lease runs to 10/14.
 *   - The lease a new lease follows can END EARLY while it waits (the tenant's
 *     early termination, the landlord waiving its fee, a lease that replaced
 *     it). Nobody is staying on to take the new lease up. If nobody in the
 *     household signed it, it never takes over (scheduler.activatePendingLeases),
 *     nobody can sign it any more (POST /esign/sign; an old emailed link opens
 *     it read-only with the reason, GET /esign/sign), the tenant portal no
 *     longer shows it, and it is canceled (scheduler.processNewLeaseSignings) —
 *     unless money was already paid on it: then the deposit record goes back to
 *     the lease that ended, what it billed that was never owed comes off
 *     (clearNeverOwedOnHeldNewLease), the landlord side and GAM are told once,
 *     and it is canceled once that payment has been returned or moved. If someone did
 *     sign, it stands (S558, decisions 10/2 #8) and the leaving date goes on it
 *     once it starts. Ending a lease early while its new lease waits is refused
 *     up front, in the same words the front desk gets (newLeaseBlocksEarlyEnd),
 *     so today only a lease that REPLACED it gets here.
 *   - The lease-end job then hands the household over the night the new lease
 *     starts, exactly as it does at the end of a fixed term
 *     (scheduler.processLeaseEnds): the old lease's last bill first, then its
 *     open money moves, then the new lease comes into force — signed by the
 *     tenant or not. It never hands over to a new lease that has not started.
 *   - The tenant's signature stays open on the new lease; the landlord hears it
 *     is still unsigned 14 days out and on the start date (jobs/renewalPing).
 *
 * The checks a new lease's dates must pass live here too, so the send route and
 * the landlord's signature refuse the same things in the same words.
 */
import { AppError } from '../middleware/errorHandler'
import { nextDueDateAfter } from '@gam/shared'

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function sayDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Which leases are a household's NEW LEASE of `pl` (SQL, alias `s` follows `pl`). */
const FOLLOWS = `(s.supersedes_lease_id = pl.id
             -- a new lease drafted before the link existed is found by its document
             OR (s.supersedes_lease_id IS NULL AND EXISTS (
                   SELECT 1 FROM lease_documents d WHERE d.lease_id = s.id AND d.renews_lease_id = pl.id)))
        AND s.lease_source = 'esigned'
        AND s.status IN ('pending', 'active')
        AND s.signed_by_landlord = TRUE`

/**
 * SQL: somebody in the household has signed the new lease `alias` (the lease
 * row). A document a tenant has signed is never thrown away (S558 —
 * lib/voidDocument refuses it), so from then on the new lease stands.
 */
export function someoneSignedNewLease(alias: string): string {
  return `(COALESCE(${alias}.signed_by_tenant, FALSE) OR EXISTS (
            SELECT 1 FROM lease_documents ssd JOIN lease_document_signers sss ON sss.document_id = ssd.id
             WHERE ssd.lease_id = ${alias}.id AND sss.role NOT IN ('landlord', 'witness')
               AND sss.signed_at IS NOT NULL))`
}

/**
 * SQL: the new lease `alias` follows a lease that ENDED EARLY — 'terminated':
 * the tenant ended it early, the landlord waived the fee and ended it, or
 * another lease replaced it — and nobody in the household has signed the new
 * one. Nobody is staying on to take it up: it never takes over
 * (activatePendingLeases), it never hides the ended lease's move-out
 * walkthrough (moveOutInspections), nobody is told it "takes over whether or
 * not they sign" (renewalPing, the landlord's Leases page), the tenant is not
 * reminded about it, shown it, or let sign it (processNewLeaseSignings' 9am
 * reminders, GET /tenants/me, /lease and /leases, GET and POST /esign/sign), and
 * it is canceled (processNewLeaseSignings). ONE definition for all of them, so they
 * never disagree.
 */
export function followsLeaseEndedEarlyUnsigned(alias: string): string {
  return `(${alias}.lease_source = 'esigned'
           AND EXISTS (SELECT 1 FROM leases eel
                        WHERE eel.id = ${alias}.supersedes_lease_id AND eel.status = 'terminated')
           AND NOT ${someoneSignedNewLease(alias)})`
}

/**
 * Money that actually MOVED on a lease — settled, on its way (processing), or
 * paid from a deposit. Exactly the payments lib/unwindIssuedLease refuses to
 * void a lease over (undoing them is a refund, not a void), so a new lease's
 * Cancel button (esign newLeaseCancelRefusal) and the 15-minute cancel job
 * judge it the same way the void itself will. Null when nothing moved.
 */
export async function moneyPaidOnLease(q: Q, leaseId: string): Promise<{ count: number; total: number } | null> {
  const r = (await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS total
       FROM payments
      WHERE lease_id = $1 AND status IN ('settled', 'processing', 'paid_via_deposit')`, [leaseId])).rows[0]
  return Number(r?.n ?? 0) > 0 ? { count: Number(r.n), total: Number(r.total) } : null
}

/** "$1,050.00" */
export function sayMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/**
 * The household's deposit record goes back from the new lease to the lease it
 * followed, with any uncollected increase the new lease raised taken off its
 * target — the same move lib/unwindIssuedLease makes when a new lease is
 * canceled. Used where the cancel itself cannot go through yet (money was paid
 * on the new lease): the lease that ended still needs its deposit on record
 * for the return. Idempotent — once moved, nothing is left on the new lease.
 */
export async function returnDepositToEndedLease(q: Q, newLeaseId: string, endedLeaseId: string): Promise<number> {
  const increase = Number((await q(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM lease_fees
      WHERE lease_id = $1 AND due_timing = 'move_in' AND is_refundable = TRUE
        AND description LIKE '[deposit top-up on renewal]%'`, [newLeaseId])).rows[0]?.total ?? 0)
  const r = await q(
    `UPDATE security_deposits
        SET lease_id = $2,
            total_amount = GREATEST(total_amount - $3::numeric, COALESCE(collected_amount, 0)),
            status = CASE WHEN status = 'partial'
                           AND COALESCE(collected_amount, 0) >= total_amount - $3::numeric
                          THEN 'funded' ELSE status END,
            updated_at = NOW()
      WHERE lease_id = $1 AND flex_deposit_enabled = FALSE`,
    [newLeaseId, endedLeaseId, increase.toFixed(2)])
  return r.rowCount ?? 0
}

/**
 * The lease a new lease follows ends the day before the new one starts. Runs
 * for every landlord-signed new lease whose start date has come (`renewalLeaseId`
 * narrows it to one). Its last day is the day before the new start, whichever
 * way that moves it: a month-to-month gets its first end date, and a fixed term
 * held over past its printed end (holdOverUntilNewLeaseStarts — normally already
 * written) is closed on the right day. Returns the leases it closed.
 */
export async function closePredecessorOfStartedRenewals(
  q: Q, opts: { renewalLeaseId?: string; today?: string } = {},
): Promise<Array<{ predecessorId: string; renewalId: string; endDate: string }>> {
  const r = await q(
    `UPDATE leases pl
        SET end_date = s.start_date - 1,
            -- A signed term carried PAST its printed end (normally the holdover
            -- step already did this) keeps the end the household signed.
            holdover_signed_end_date = CASE
              WHEN pl.end_date IS NOT NULL AND pl.lease_type <> 'month_to_month'
                   AND pl.end_date < s.start_date - 1
                THEN COALESCE(pl.holdover_signed_end_date, pl.end_date)
              ELSE pl.holdover_signed_end_date END,
            auto_renew = FALSE, auto_renew_mode = NULL,
            updated_at = NOW()
       FROM leases s
      WHERE ${FOLLOWS}
        AND s.start_date <= COALESCE($2::date, CURRENT_DATE)
        AND ($1::uuid IS NULL OR s.id = $1::uuid)
        AND pl.status = 'active'
        AND (pl.end_date IS NULL OR pl.end_date <> s.start_date - 1)
      RETURNING pl.id AS predecessor_id, s.id AS renewal_id,
                to_char(pl.end_date, 'YYYY-MM-DD') AS end_date`,
    [opts.renewalLeaseId ?? null, opts.today ?? null])
  return r.rows.map((x: any) => ({ predecessorId: x.predecessor_id, renewalId: x.renewal_id, endDate: x.end_date }))
}

/**
 * HOLDOVER (decisions 10/2 #7): "there is never a stretch with no lease." A
 * signed fixed term whose end has passed while the household's landlord-signed
 * new lease has not started yet carries on — at the old rent, on the old terms —
 * until the day before the new lease starts. Written the night the term runs
 * out (before the lease-end job), so the bill run keeps billing it, the lease-end
 * job does not read it as a move-out, and if the landlord cancels the new lease
 * the household still has a lease through the day they were told.
 *
 * Only ever LENGTHENS a lease whose end has already passed; a term still running
 * is untouched (it might yet be canceled, and its printed end stands).
 *
 * The end the household SIGNED is kept in holdover_signed_end_date (the first
 * time only — a second holdover keeps the original), so nothing later calls a
 * held-over day the end of the signed lease.
 */
export async function holdOverUntilNewLeaseStarts(
  q: Q, opts: { today?: string } = {},
): Promise<Array<{ leaseId: string; renewalId: string; termEnded: string; holdsOverTo: string }>> {
  const r = await q(
    `WITH held AS (
       SELECT DISTINCT ON (pl.id) pl.id, s.id AS renewal_id,
              COALESCE(pl.holdover_signed_end_date, pl.end_date) AS term_ended, s.start_date - 1 AS holds_to
         FROM leases pl
         JOIN leases s ON ${FOLLOWS}
        WHERE pl.status = 'active'
          AND pl.end_date IS NOT NULL
          AND pl.end_date < COALESCE($1::date, CURRENT_DATE)
          AND pl.end_date < s.start_date - 1
          AND s.start_date > COALESCE($1::date, CURRENT_DATE)
        ORDER BY pl.id, s.start_date ASC)
     UPDATE leases pl
        SET end_date = held.holds_to,
            holdover_signed_end_date = CASE WHEN pl.lease_type <> 'month_to_month'
                                            THEN held.term_ended ELSE pl.holdover_signed_end_date END,
            auto_renew = FALSE, auto_renew_mode = NULL, updated_at = NOW()
       FROM held
      WHERE pl.id = held.id
      RETURNING pl.id AS lease_id, held.renewal_id,
                to_char(held.term_ended, 'YYYY-MM-DD') AS term_ended,
                to_char(held.holds_to, 'YYYY-MM-DD') AS holds_over_to`,
    [opts.today ?? null])
  return r.rows.map((x: any) => ({
    leaseId: x.lease_id, renewalId: x.renewal_id, termEnded: x.term_ended, holdsOverTo: x.holds_over_to,
  }))
}

/**
 * The dates a new lease for a sitting household must make sense against the
 * lease it follows. Refused, in plain words with the next step:
 *
 *   - the current lease is not in force any more (nothing to follow on from);
 *   - a start on or before the day the current lease began;
 *   - a leaving date is on file — they told the desk they are going;
 *   - a start inside a SIGNED FIXED TERM: the term runs to its end, so the new
 *     lease starts the day after it or later (a later start holds the household
 *     over at the old rent until then — see the header). The term is the one
 *     the household signed: a lease already holding over past it is not inside
 *     it, so a new lease may start on any day of the holdover;
 *   - a start on or before a date the current lease has ALREADY billed: that
 *     stretch would be billed twice.
 *
 * No notice-period rule. GAM never gates on legality (Nic).
 */
export async function assertNewLeaseDates(q: Q, opts: { renewsLeaseId: string; startIso: string }): Promise<void> {
  const old = (await q(
    `SELECT l.status, l.lease_type, to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date, 'YYYY-MM-DD') AS end_date, l.move_out_notice_at,
            to_char(COALESCE(l.holdover_signed_end_date, l.end_date), 'YYYY-MM-DD') AS signed_end_date,
            COALESCE(l.rent_due_day, 1) AS rent_due_day,
            COALESCE(u.display_label, u.unit_number) AS unit_label
       FROM leases l JOIN units u ON u.id = l.unit_id
      WHERE l.id = $1`, [opts.renewsLeaseId])).rows[0]
  if (!old) throw new AppError(404, 'The lease this new lease follows was not found.')
  if (old.status !== 'active') {
    throw new AppError(409,
      `The current lease on ${old.unit_label} is no longer in force, so a new lease has nothing to follow on from. ` +
      `Cancel this new lease and invite the household from the Tenants page instead.`)
  }
  if (old.move_out_notice_at) {
    throw new AppError(409,
      `${old.unit_label} is down as leaving on ${sayDate(old.end_date)}. If they are staying, call that off first ` +
      `(Leases → Change → Leaving date — change or call off), then send the new lease.`)
  }
  if (opts.startIso <= old.start_date) {
    throw new AppError(409,
      `The new lease has to start after ${sayDate(old.start_date)}, the day the current lease began. Change the start date.`)
  }
  // A later start is fine: the household holds over on this lease, at today's
  // rent, until the day before (holdOverUntilNewLeaseStarts) — never a gap.
  // Judged against the end they SIGNED, never a held-over day.
  if (old.signed_end_date && old.lease_type !== 'month_to_month' && opts.startIso <= old.signed_end_date) {
    throw new AppError(409,
      `${old.unit_label} is on a signed lease through ${sayDate(old.signed_end_date)}, so a new lease can start ` +
      `${sayDate(isoAddDays(old.signed_end_date, 1))} or later. Change the start date.`)
  }
  const billed = (await q(
    `SELECT to_char(MAX(due_date), 'YYYY-MM-DD') AS last
       FROM invoices
      WHERE lease_id = $1 AND status <> 'void' AND due_date >= $2::date`,
    [opts.renewsLeaseId, opts.startIso])).rows[0]?.last as string | null
  if (billed) {
    const day = Number(old.rent_due_day) >= 1 && Number(old.rent_due_day) <= 28 ? Number(old.rent_due_day) : 1
    throw new AppError(409,
      `The current lease on ${old.unit_label} has already billed ${sayDate(billed)}. ` +
      `Start the new lease on ${sayDate(nextDueDateAfter(billed, day))} or later, so that stretch is not billed twice.`)
  }
}

/**
 * The household's new lease waiting to start (or started and not yet signed by
 * them): the landlord-signed lease that follows `leaseId`. Null when there is
 * none — a canceled one is not 'pending' or 'active' any more.
 */
export async function newLeaseFollowing(q: Q, leaseId: string): Promise<{
  id: string; start_date: string; rent_amount: string; signed_by_tenant: boolean; status: string
} | null> {
  return (await q(
    `SELECT s.id, to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.rent_amount::text AS rent_amount,
            s.signed_by_tenant, s.status
       FROM leases s
      WHERE s.supersedes_lease_id = $1
        AND s.status IN ('pending', 'active')
        AND s.signed_by_landlord = TRUE
      ORDER BY s.start_date ASC LIMIT 1`, [leaseId])).rows[0] ?? null
}

/**
 * Ending a lease EARLY (services/leaseTermination — the tenant's "End lease
 * early", or the landlord waiving its fee and ending it; PATCH /leases/:id to
 * 'terminated' or 'expired', the API's and the agent's door) while the household's
 * new lease waits is the contradiction the front desk's leaving date already
 * refuses (moveOutNotice.recordMoveOutNotice): leaving, and staying on a new
 * lease, cannot both be true. Ended anyway, the new lease came into force on its
 * start date and billed a household that had gone, and the landlord could no
 * longer cancel it. So the same rule, in the same words:
 *
 *   - nobody in the household has signed the new lease: cancel it first;
 *   - somebody has: it stands (S558 — a signed lease is never thrown away;
 *     decisions 10/2 #8), and the leaving date goes on it once it starts.
 *
 * A waiting new lease cannot itself be ended before it starts either — ending it
 * would empty the space under a household still living there on the lease
 * before it.
 *
 * Null when nothing stands in the way. `who` picks whose words: the tenant's
 * request, or the landlord's waiver.
 */
export async function newLeaseBlocksEarlyEnd(
  q: Q, leaseId: string, who: 'tenant' | 'landlord',
): Promise<string | null> {
  const next = (await q(
    `SELECT to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
            ${someoneSignedNewLease('s')} AS someone_signed,
            COALESCE(u.display_label, u.unit_number) AS unit_label
       FROM leases s JOIN units u ON u.id = s.unit_id
      WHERE s.supersedes_lease_id = $1 AND s.lease_source = 'esigned'
        AND s.status IN ('pending', 'active') AND s.signed_by_landlord = TRUE
      ORDER BY s.start_date LIMIT 1`, [leaseId])).rows[0]
  if (next) {
    const when = sayDate(next.start_date)
    if (next.someone_signed) {
      return who === 'tenant'
        ? `Your household has signed the new lease for ${next.unit_label} that starts ${when}, so this lease can't be ended early — ` +
          'a signed lease stands. If you are moving out, tell the office the day you are leaving; it goes on the new lease once that starts.'
        : `${next.unit_label} has a new lease starting ${when} that the household has signed, so this lease can't be ended early — ` +
          'a signed lease stands. Write down the day they leave on the new lease once it starts (Leases → Change → They\'re leaving on…).'
    }
    return who === 'tenant'
      ? `There is a new lease for ${next.unit_label} starting ${when}. To end your lease early instead, ` +
        'ask the office to cancel that new lease first, then come back here.'
      : `${next.unit_label} has a new lease starting ${when}. If they are leaving instead, cancel it first: ` +
        'Leases → Change → New lease — view or cancel → Cancel the new lease. Then end this lease.'
  }
  const self = (await q(
    `SELECT to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
            ${someoneSignedNewLease('s')} AS someone_signed,
            COALESCE(u.display_label, u.unit_number) AS unit_label
       FROM leases s JOIN units u ON u.id = s.unit_id JOIN properties p ON p.id = u.property_id
      WHERE s.id = $1 AND s.supersedes_lease_id IS NOT NULL AND s.lease_source = 'esigned'
        AND s.status = 'pending' AND s.signed_by_landlord = TRUE
        AND s.start_date > GREATEST(CURRENT_DATE, (NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date)`,
    [leaseId])).rows[0]
  if (!self) return null
  const when = sayDate(self.start_date)
  if (who === 'tenant') {
    return `This new lease starts ${when}, so it can't be ended before it starts. ` +
      'If you are moving out, tell the office the day you are leaving.'
  }
  return self.someone_signed
    ? `This new lease for ${self.unit_label} starts ${when} and the household has signed it, so it stands. ` +
      'Write down the day they leave on it once it starts (Leases → Change → They\'re leaving on…).'
    : `This new lease for ${self.unit_label} has not started yet (it starts ${when}). To stop it, cancel it instead: ` +
      'Leases → Change → New lease — view or cancel → Cancel the new lease.'
}

/**
 * The new leases to cancel because the lease they follow ENDED EARLY and nobody
 * in the household signed them (followsLeaseEndedEarlyUnsigned) — each with its
 * document (the whole row, for lib/voidDocument, including
 * new_lease_cancel_held_at), what the landlord is told, and the money already
 * paid on it (moneyPaidOnLease's test: paid_count / paid_total), which holds the
 * cancel until it is returned or moved.
 * The job that cancels them is scheduler.processNewLeaseSignings.
 */
export async function newLeasesAfterEarlyEnd(q: Q): Promise<any[]> {
  return (await q(
    `SELECT d.*, s.id AS new_lease_id, ol.id AS ended_lease_id,
            (SELECT COUNT(*)::int FROM payments pm
              WHERE pm.lease_id = s.id AND pm.status IN ('settled', 'processing', 'paid_via_deposit')) AS paid_count,
            (SELECT COALESCE(SUM(pm.amount), 0)::text FROM payments pm
              WHERE pm.lease_id = s.id AND pm.status IN ('settled', 'processing', 'paid_via_deposit')) AS paid_total,
            to_char(s.start_date, 'YYYY-MM-DD') AS new_start_date,
            to_char((COALESCE(ol.terminated_at, ol.updated_at) AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date,
                    'YYYY-MM-DD') AS ended_on,
            COALESCE(u.display_label, u.unit_number) AS unit_label, p.name AS property_name
       FROM leases s
       JOIN leases ol ON ol.id = s.supersedes_lease_id
       JOIN lease_documents d ON d.lease_id = s.id AND d.renews_lease_id = ol.id
       JOIN units u ON u.id = s.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE s.status = 'pending' AND s.signed_by_landlord = TRUE
        AND d.status NOT IN ('completed', 'voided')
        AND ${followsLeaseEndedEarlyUnsigned('s')}
      ORDER BY p.name, COALESCE(u.display_label, u.unit_number)`)).rows
}

/**
 * What a signer is told when they open (GET /esign/sign) or try to sign (POST
 * /esign/sign) a new lease whose lease ENDED EARLY with nobody in the household
 * signed (followsLeaseEndedEarlyUnsigned): it can no longer be signed, it is
 * being canceled, and who to ask if they meant to stay. One set of words for
 * both, so the page never offers a Sign button the submit then refuses.
 */
export const NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN =
  'The lease this new lease was to follow has ended, so it can no longer be signed — it is being canceled. ' +
  'If you meant to stay, contact the office.'

/** A charge row on a held new lease that could not be taken off (see clearNeverOwedOnHeldNewLease). */
export interface KeptCharge {
  /** The charge row (payments.id); null for a utility bill that has no charge row yet. */
  paymentId: string | null
  /** The utility bill it belongs to, when it is a utility charge. */
  utilityBillId: string | null
  /** Plain words: "deposit", "utility", "late fee"… */
  kind: string
  amount: number
  /** YYYY-MM-DD, or null when it has none. */
  dueDate: string | null
}

/** What a charge row is, in plain words (payments.type → words; never the raw value). */
const CHARGE_KIND_WORDS: Record<string, string> = {
  rent: 'rent', fee: 'fee', deposit: 'deposit', utility: 'utility', late_fee: 'late fee',
  home_payment: 'home payment', carried_balance: 'carried-over balance',
  float_fee: 'FlexPay fee', platform_fee: 'platform fee',
}
function chargeKindWords(type: string | null | undefined): string {
  return CHARGE_KIND_WORDS[String(type ?? '')] ?? 'charge'
}

/**
 * The kept charges, named for GAM: "the $100.00 deposit charge due November 12,
 * 2026" — one, or a list joined in plain English.
 */
export function sayKeptCharges(kept: KeptCharge[]): string {
  const one = (k: KeptCharge) =>
    `the ${sayMoney(k.amount)} ${k.kind} charge` + (k.dueDate ? ` due ${sayDate(k.dueDate)}` : '')
  const named = kept.map(one)
  if (named.length <= 1) return named[0] ?? ''
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}

/**
 * A new lease that will never start (its lease ended early and nobody in the
 * household signed it) but cannot be canceled yet because money was paid on it
 * (scheduler.processNewLeaseSignings' held step). What it billed that was never
 * owed comes off NOW, so the household that left is not shown a deposit due on
 * a lease that will never start, asked to pay it, or charged a late fee on it
 * while the paid money is sorted out — every further payment would only be
 * more money to return before the cancel can finish.
 *
 * Exactly the never-owed rows lib/unwindIssuedLease removes when the cancel
 * does go through, and nothing else:
 *
 *   - a utility bill on it that nobody has paid goes back, unbilled, to the
 *     lease that ended (the usage is real and the household's), and its unpaid
 *     charge row goes;
 *   - its unpaid charge rows ('pending' / 'failed') are removed;
 *   - its open bills ('pending' / 'partial'), read BEFORE anything is removed:
 *       · a bill with no money left on it that moved is voided at $0, with any
 *         open work-trade settlement on it;
 *       · a bill that still carries money that MOVED (a line paid, or a payment
 *         on its way) is NOT voided — a void bill reads $0 with money on it, and
 *         a void bill never changes status again, so a payment still on its way
 *         would settle onto a dead $0 bill. Its total and subtotals are rebuilt
 *         from the lines still on it, and its status follows them (the invoice
 *         status rollup — 'settled' once everything left on it is paid, a line
 *         paid from the deposit included).
 *     Read before, because every removal re-rolls the bill's status: a bill
 *     whose only unpaid line went would already read 'settled' — still totaling
 *     the line that is gone — and be skipped.
 *
 * The rebuilt bill is totaled the way the move-in bundle built it: rent, fee and
 * deposit lines, utility (released onto it) and home-payment lines each in their
 * own subtotal (a deposit box tagged on the lease — a row with its lease_fee_id —
 * counts under fees, as it was billed; the security deposit's own line under
 * deposits); the total is every line still owed or paid that is not suspended
 * for work trade and is not a late fee (late fees ride a bill as their own lines
 * and are never in its total — jobs/lateFees). A 'failed' or 'returned' line is
 * neither.
 *
 * Money that MOVED (settled, processing, paid from a deposit) is never touched:
 * returning or moving it is what the hold waits on.
 *
 * Each removal is tried on its own (a savepoint), so one charge row that another
 * record still points at — a bank remittance applied to it, an ACH log entry —
 * stays where it is and is counted in `kept` (and named in `keptCharges`) for GAM
 * to take off by hand, instead of failing the whole step on every run. Run
 * INSIDE a transaction. Idempotent: run again it finds nothing new to do.
 *
 * Returns how many charge rows came off (`charges`), bills voided (`bills`),
 * bills rebuilt around money still on them (`retotaled`), utility bills sent
 * back (`utilityBills`), and what stayed (`kept` / `keptCharges`).
 */
export async function clearNeverOwedOnHeldNewLease(
  q: Q, newLeaseId: string, endedLeaseId: string,
): Promise<{
  charges: number; bills: number; retotaled: number; utilityBills: number; kept: number; keptCharges: KeptCharge[]
}> {
  const alone = async (step: () => Promise<unknown>): Promise<boolean> => {
    await q('SAVEPOINT never_owed_row')
    try {
      await step()
      await q('RELEASE SAVEPOINT never_owed_row')
      return true
    } catch {
      await q('ROLLBACK TO SAVEPOINT never_owed_row')
      await q('RELEASE SAVEPOINT never_owed_row')
      return false
    }
  }
  // The open bills, read before anything below re-rolls their status.
  const open = (await q(
    `SELECT id FROM invoices WHERE lease_id = $1 AND status IN ('pending', 'partial') ORDER BY due_date, id`,
    [newLeaseId])).rows.map((r: any) => r.id as string)
  /** Bills a line was taken off. */
  const touched = new Set<string>()
  const keptCharges: KeptCharge[] = []

  // Utility first: the bill points at its charge row.
  let utilityBills = 0
  const utility = (await q(
    `SELECT ub.id, ub.payment_id, ub.charge_amount::text AS charge_amount,
            pm.invoice_id, pm.amount::text AS amount, to_char(pm.due_date, 'YYYY-MM-DD') AS due_date
       FROM utility_bills ub
       LEFT JOIN payments pm ON pm.id = ub.payment_id
      WHERE ub.lease_id = $1
        AND (ub.payment_id IS NULL OR pm.status IN ('pending', 'failed'))
      ORDER BY ub.billing_cycle_month, ub.id`, [newLeaseId])).rows
  for (const b of utility) {
    const moved = await alone(async () => {
      await q(
        `UPDATE utility_bills
            SET lease_id = $2, payment_id = NULL,
                status = CASE WHEN status = 'billed' THEN 'unbilled' ELSE status END,
                updated_at = NOW()
          WHERE id = $1`, [b.id, endedLeaseId])
      if (b.payment_id) {
        await q(`DELETE FROM payments WHERE id = $1 AND status IN ('pending', 'failed')`, [b.payment_id])
      }
    })
    if (moved) {
      utilityBills++
      if (b.invoice_id) touched.add(b.invoice_id)
    } else {
      keptCharges.push({
        paymentId: b.payment_id ?? null, utilityBillId: b.id, kind: 'utility',
        amount: Number(b.amount ?? b.charge_amount ?? 0), dueDate: b.due_date ?? null,
      })
    }
  }
  let charges = 0
  const unpaid = (await q(
    `SELECT id, invoice_id, type, amount::text AS amount, to_char(due_date, 'YYYY-MM-DD') AS due_date
       FROM payments
      WHERE status IN ('pending', 'failed')
        AND (lease_id = $1 OR invoice_id IN (SELECT id FROM invoices WHERE lease_id = $1))
      ORDER BY due_date NULLS LAST, id`, [newLeaseId])).rows
  // A utility bill that could not go back keeps its charge row with it — already
  // counted above, once.
  const keptWithBill = new Set(keptCharges.map(k => k.paymentId).filter(Boolean))
  for (const r of unpaid) {
    if (keptWithBill.has(r.id)) continue
    if (await alone(() => q(`DELETE FROM payments WHERE id = $1`, [r.id]))) {
      charges++
      if (r.invoice_id) touched.add(r.invoice_id)
    } else {
      keptCharges.push({
        paymentId: r.id, utilityBillId: null, kind: chargeKindWords(r.type),
        amount: Number(r.amount), dueDate: r.due_date ?? null,
      })
    }
  }

  let bills = 0
  let retotaled = 0
  for (const invoiceId of open) {
    const movedLeft = (await q(
      `SELECT 1 FROM payments
        WHERE invoice_id = $1 AND status IN ('settled', 'processing', 'paid_via_deposit') LIMIT 1`,
      [invoiceId])).rows.length > 0
    if (!movedLeft) {
      await q(`DELETE FROM work_trade_settlements WHERE invoice_id = $1 AND status = 'open'`, [invoiceId])
      await q(
        `UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW()
          WHERE id = $1 AND status <> 'void'`, [invoiceId])
      bills++
      continue
    }
    // Money moved on it, and nothing was taken off it: it is left exactly as it is.
    if (!touched.has(invoiceId)) continue
    // Nothing on it is owed any more, so no hours are credited against it.
    await q(`DELETE FROM work_trade_settlements WHERE invoice_id = $1 AND status = 'open'`, [invoiceId])
    const changed = await q(
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
        WHERE i.id = $1
          AND (i.total_amount, i.subtotal_rent, i.subtotal_fees, i.subtotal_deposits,
               i.subtotal_utilities, i.subtotal_home_payments)
              IS DISTINCT FROM (t.total, t.rent, t.fees, t.deposits, t.utilities, t.home)
        RETURNING i.id`, [invoiceId])
    // Its status follows what is left on it (the same rollup the payments
    // trigger runs) — 'settled' once all of it is paid, 'pending' while a payment
    // is on its way.
    await q(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [invoiceId])
    // Final sweep (10/3): that rollup counts only 'settled' lines as paid, so a
    // bill whose money left is a line paid from the deposit read 'pending' — an
    // open-looking bill with nothing owed on it (it used to be voided). Paid is
    // paid: when every line left is paid (settled, or paid from the deposit) —
    // a returned line is not in its total, and its re-billed charge came off
    // above — the bill reads 'settled'. Done here, not in the shared rollup,
    // which every bill on the platform runs.
    await q(
      `UPDATE invoices i SET status = 'settled', updated_at = NOW()
        WHERE i.id = $1 AND i.status NOT IN ('settled', 'void')
          AND EXISTS (SELECT 1 FROM payments p
                       WHERE p.invoice_id = i.id AND p.status IN ('settled', 'paid_via_deposit'))
          AND NOT EXISTS (SELECT 1 FROM payments p
                           WHERE p.invoice_id = i.id
                             AND p.status NOT IN ('settled', 'paid_via_deposit', 'returned'))`, [invoiceId])
    if (changed.rows.length) retotaled++
  }
  return { charges, bills, retotaled, utilityBills, kept: keptCharges.length, keptCharges }
}
