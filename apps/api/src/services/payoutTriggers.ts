import { addBusinessDays } from '@gam/shared'
import { query, queryOne } from '../db'

// ============================================================
// S616 (Nic) — when has enough rent come in to be worth sending?
//
//   "Most people pay on time, and you don't wanna be stuck on the outliers. So
//    let's fire a disbursement when it's fifty percent of occupied units paid...
//    and then we do another one at ninety percent... you don't want the landlord
//    being held up by a bunch of rent money for one or two late people."
//
// Three firings per Connect account per rent cycle, capped by a unique index
// rather than by this code. The cap is the point: $0.75 a month against a $10
// per-property floor, known in advance and unable to run away.
// ============================================================

/** Percent of occupied units paid that earns a firing. */
export const THRESHOLD_50 = 50
export const THRESHOLD_90 = 90

/**
 * BUSINESS days between a threshold tripping and the payout firing.
 *
 * Nic: trigger on PAID, not settled. A tenant counts the moment their bank is
 * debited, because an ACH sits in 'processing' for days afterwards and counting
 * only settled money would make every roll look empty during the exact week
 * rent arrives. The lead time is what covers that wait.
 *
 * S617 (Nic): "threshold trigger plus four business days. That's the simpler
 * way to do it." These were CALENDAR days, and Stripe releases an ACH four
 * BUSINESS days out — the two only agree in a week with no weekend in it.
 * Measured on a real charge: an ACH created Wed 2026-08-19 had available_on
 * Tue 2026-08-25. Four calendar days said the 23rd, so the payout fired two
 * days before the money existed, read an empty balance, and the trigger was
 * retired anyway (see the comment in autoPayouts) — one of the landlord's
 * three monthly payouts spent on nothing, and his rent pushed to the 90%
 * trigger or the late-month sweep.
 *
 * Deliberately NOT Stripe's per-payment available_on. Nic: "we're not gonna
 * read every payment." One roll-wide count, not a lookup per tenant.
 */
export const SETTLE_LEAD_DAYS = 4

export interface RollProgress {
  unitsTotal: number
  unitsPaid: number
  percentPaid: number
}

/**
 * How much of this landlord's rent roll has come in for the cycle.
 *
 * PAID means the tenant has sent it — settled, in flight, or taken from a
 * deposit. An ACH sits in 'processing' for days AFTER the tenant's bank was
 * debited, so counting only settled money would make every landlord's roll look
 * empty during the exact week rent arrives.
 *
 * The denominator is units that actually OWE this cycle — a unit with no rent
 * charge (owner-occupied, a utility-service space, a lease that has not started)
 * is not an outstanding tenant, and counting it would hold the threshold down
 * forever on a roll that is genuinely complete.
 */
export async function rollProgressForLandlordUser(
  userId: string, cycleMonth: string,
): Promise<RollProgress> {
  const row = await queryOne<{ total: string; paid: string }>(
    `SELECT COUNT(DISTINCT p.unit_id)::text AS total,
            COUNT(DISTINCT p.unit_id) FILTER (
              WHERE p.status IN ('settled','processing','paid_via_deposit'))::text AS paid
       FROM payments p
       JOIN landlords l ON l.id = p.landlord_id
      WHERE l.user_id = $1
        AND p.type = 'rent'
        AND date_trunc('month', p.due_date) = date_trunc('month', $2::date)`,
    [userId, cycleMonth])
  const unitsTotal = Number(row?.total ?? 0)
  const unitsPaid = Number(row?.paid ?? 0)
  return {
    unitsTotal,
    unitsPaid,
    // A roll with nothing due is not 100% paid, it is empty. Reporting it as
    // complete would trip both thresholds on a landlord who billed nobody.
    percentPaid: unitsTotal > 0 ? (unitsPaid / unitsTotal) * 100 : 0,
  }
}

export interface ClaimResult {
  claimed: boolean
  triggerKind?: string
  scheduledFor?: string
}

/**
 * Claim a threshold for this cycle, if the roll has reached it and it has not
 * been claimed already.
 *
 * The unique index is what enforces "once per cycle" — this returns false on a
 * conflict rather than checking first, so two runs racing cannot both claim.
 */
export async function claimThresholdIfReached(
  entityKind: 'user', entityId: string, cycleMonth: string, today: string,
  progress: RollProgress,
): Promise<ClaimResult> {
  // Highest first: a roll that jumps straight past 90% claims the 90 and leaves
  // the 50 unclaimed rather than burning two firings on one moment.
  const kind = progress.percentPaid >= THRESHOLD_90 ? 'threshold_90'
    : progress.percentPaid >= THRESHOLD_50 ? 'threshold_50'
    : null
  if (!kind) return { claimed: false }

  const scheduledFor = addBusinessDays(today, SETTLE_LEAD_DAYS)
  const res = await query<{ id: string }>(
    `INSERT INTO payout_triggers
       (entity_kind, entity_id, cycle_month, trigger_kind,
        units_total, units_paid, scheduled_for)
     VALUES ($1, $2, date_trunc('month', $3::date), $4, $5, $6, $7)
     ON CONFLICT (entity_kind, entity_id, cycle_month, trigger_kind) DO NOTHING
     RETURNING id`,
    [entityKind, entityId, cycleMonth, kind,
     progress.unitsTotal, progress.unitsPaid, scheduledFor])
  return res.length > 0
    ? { claimed: true, triggerKind: kind, scheduledFor }
    : { claimed: false }
}

/**
 * Claim the guaranteed late-month sweep.
 *
 * Not a percentage, deliberately. Nic: "anyone that hasn't paid by the 90
 * percent sweep is long enough past due that the landlord is probably filing
 * eviction" — and he is right on GAM's own numbers, since a unit is marked
 * delinquent at due date + 5 days. Waiting on those tenants to reach 100% would
 * mean one person who never pays holds the tail forever.
 *
 * It also covers the month where neither threshold trips: a landlord whose
 * tenants mostly did not pay still gets what did come in.
 */
export async function claimMonthlySweep(
  entityKind: 'user' | 'pm_company' | 'business', entityId: string,
  cycleMonth: string, today: string,
): Promise<ClaimResult> {
  const res = await query<{ id: string }>(
    `INSERT INTO payout_triggers
       (entity_kind, entity_id, cycle_month, trigger_kind, scheduled_for)
     VALUES ($1, $2, date_trunc('month', $3::date), 'monthly_sweep', $4)
     ON CONFLICT (entity_kind, entity_id, cycle_month, trigger_kind) DO NOTHING
     RETURNING id`,
    [entityKind, entityId, cycleMonth, today])
  return res.length > 0
    ? { claimed: true, triggerKind: 'monthly_sweep', scheduledFor: today }
    : { claimed: false }
}

/** Triggers due to fire on or before `today` that have not fired yet. */
export async function dueTriggers(today: string) {
  return query<{
    id: string; entity_kind: string; entity_id: string; trigger_kind: string
  }>(
    `SELECT id, entity_kind, entity_id, trigger_kind
       FROM payout_triggers
      WHERE fired_at IS NULL AND scheduled_for <= $1::date
      ORDER BY scheduled_for ASC`,
    [today])
}

/**
 * How many times a trigger may fire into an empty balance before it gives up.
 *
 * S617: a zero-balance firing never calls Stripe — processOneCandidate returns
 * before creating the payout — so it costs nothing and must not spend one of
 * the landlord's three payouts for the month. It is pushed to the next business
 * day instead. Bounded so a landlord who genuinely has no money to send does
 * not defer forever; after this many tries the trigger retires and the next
 * threshold (or the late-month sweep) carries the money.
 */
export const MAX_DEFERRALS = 3

/**
 * Push a trigger to the next business day instead of retiring it.
 *
 * Returns false when it has already been deferred MAX_DEFERRALS times, which
 * tells the caller to retire it normally.
 */
export async function deferTrigger(id: string, from: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `UPDATE payout_triggers
        SET scheduled_for = $2::date,
            defer_count   = defer_count + 1,
            updated_at    = NOW()
      WHERE id = $1
        AND fired_at IS NULL
        AND defer_count < $3
      RETURNING id`,
    [id, addBusinessDays(from, 1), MAX_DEFERRALS])
  return res.length > 0
}

export async function markTriggerFired(id: string, skippedReason?: string): Promise<void> {
  await query(
    `UPDATE payout_triggers
        SET fired_at = NOW(), skipped_reason = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, skippedReason ?? null])
}

/**
 * S616 (Nic) — "leases follow 3 batch plan we made. short term stays follow
 * weekly plan."
 *
 * Two revenue streams with different shapes, so two cadences. A rent roll is a
 * fixed denominator that fills up over the first week of the month, which is
 * what makes a percentage trigger meaningful. Nightly stays have no denominator
 * at all: money arrives whenever somebody books, all month, and there is no
 * "90% of bookings paid" to wait for. A percentage would either never trip or
 * trip constantly.
 *
 * So a landlord with short-term activity keeps the weekly Tuesday for that
 * money, AND — if they also have long-term tenants — the rent thresholds fire
 * for the rent. Oak Park is exactly this landlord: 29 of its 30 units allow
 * nightly stays and it will also hold long-term leases.
 *
 * The two coalesce naturally rather than double-paying: it is ONE Connect
 * balance, so whichever fires first sweeps everything available, and the second
 * finds nothing and is skipped for free.
 *
 * Bookings live in unit_bookings and produce no payments rows, which is why the
 * rent-roll query above cannot see them and why this one is needed at all.
 */
export async function hasShortTermActivity(
  userId: string, cycleMonth: string,
): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM unit_bookings b
       JOIN units u     ON u.id = b.unit_id
       JOIN landlords l ON l.id = u.landlord_id
      WHERE l.user_id = $1
        AND b.lease_type IN ('nightly','weekly')
        AND b.status NOT IN ('cancelled','no_show')
        AND b.check_in  < (date_trunc('month', $2::date) + INTERVAL '1 month')
        AND b.check_out > date_trunc('month', $2::date)`,
    [userId, cycleMonth])
  return Number(row?.n ?? 0) > 0
}
