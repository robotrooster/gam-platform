/**
 * Utility reading runs — the end-of-month meter-reading workflow.
 *
 * Flow (Nic's design, post-S531 correction):
 *   1. A daily scheduler tick calls openDueReadingRuns(). On the last
 *      business day of the month (weekends + US federal holidays walked
 *      backward), a run opens for every property with readable meters
 *      (submeter / RUBS — master_bill_to_landlord produces no tenant
 *      bills so it never blocks a run).
 *   2. Opening a run notifies the landlord + every staff member whose
 *      scope covers the property AND whose permission toggles include
 *      properties.edit (the same key that gates reading entry).
 *   3. The manager walks meter-to-meter entering readings (run-scoped
 *      endpoint stamps the run's cycle). Progress is derived from
 *      utility_meter_readings — no per-meter run rows.
 *   4. When the last meter gets its reading (or the manager finishes
 *      early with skips), the run completes: bills generate through the
 *      S90 engine (usage = current − prior, × rate + base; lease-is-law
 *      gate on lease_utility_responsibilities) and flip straight to
 *      'billed'. The S178 invoice cron folds them into each tenant's
 *      next monthly invoice — nothing manual downstream.
 *
 * S534 (Nic): billing is NOT batched to run completion. Each unit is
 * clear to bill the moment its own meters have original reads — the
 * invoice cron (ensureBillsForUnit) bills per-unit on each lease's due
 * date, so one unread meter or an unfinished verification walk never
 * hangs the rest of the property. A unit's invoice is held (WHOLE
 * invoice, rent included — never a partial send) by exactly two
 * things: a missing ORIGINAL read on a tenant-responsible submeter,
 * or an UNRESOLVED FLAG (needs_review) on one — resolution via the
 * verification re-read or the landlord's review releases it. Run
 * completion remains the batch path (and the force-complete escape
 * hatch for unreadable meters — it does NOT clear flags); a bill
 * already on an invoice makes its reading immutable — re-read drift
 * bills next cycle.
 */

import { METER_USAGE_ALERT_THRESHOLDS, meterReadingModulus } from '@gam/shared'
import { query, queryOne } from '../db'
import { generateBillsForProperty } from './utilityBilling'
import { createNotification } from './notifications'
import { US_FEDERAL_HOLIDAYS } from '../jobs/autoPayouts'
import { logger } from '../lib/logger'

const TZ = 'America/Phoenix'

// ── Date math ────────────────────────────────────────────────────────

const isoDate = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/**
 * Last business day of a month: start at the last calendar day and walk
 * backward while the day is a weekend or a US federal holiday. Nic's
 * rule: "last business day of the month; if that day is a federal
 * holiday make it one day earlier; if the earlier day is a weekend go
 * back to the next business day" — i.e. keep walking until both checks
 * pass. month is 1-based.
 */
export function lastBusinessDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)) // day 0 of next month = last day of `month`
  for (;;) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6 && !US_FEDERAL_HOLIDAYS.has(isoDate(d))) return isoDate(d)
    d.setUTCDate(d.getUTCDate() - 1)
  }
}

/**
 * S648 (Nic): the last business day BEFORE a date — weekends and US federal
 * holidays skipped, the same walk as the month-end rule. "If their due date is
 * going to be Monday, read it on Friday. If their due date is going to be on
 * Friday, read it on Thursday... read it the last business day before the due
 * date, but also not a holiday. Same way we do everything else."
 */
export function lastBusinessDayBefore(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z')
  for (;;) {
    d.setUTCDate(d.getUTCDate() - 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6 && !US_FEDERAL_HOLIDAYS.has(isoDate(d))) return isoDate(d)
  }
}

/**
 * When a meter in cycle `cycleMonth` is read: the last business day before its
 * tenant's due date in the following month. Due on the 1st, that is the last
 * business day of the cycle month — the day the run opens, as it always was.
 */
export function meterReadBy(cycleMonth: string, dueDay: number): string {
  const y = Number(cycleMonth.slice(0, 4)), m = Number(cycleMonth.slice(5, 7))
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1
  const due = `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(Math.max(dueDay, 1), 28)).padStart(2, '0')}`
  return lastBusinessDayBefore(due)
}

export function todayInPhoenix(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

// ── Run opening ──────────────────────────────────────────────────────

/**
 * Open a reading run for one property + cycle. Idempotent (UNIQUE on
 * property + cycle → returns the existing run). `openedBy` marks a
 * manual early open from the utilities page; scheduler opens pass null.
 */
export async function openReadingRun(
  propertyId: string,
  cycleMonth: string,
  opts: { notify?: boolean; utilityType?: string | null } = {},
) {
  const property = await queryOne<{ id: string; name: string; landlord_id: string }>(
    `SELECT id, name, landlord_id FROM properties WHERE id = $1`, [propertyId])
  if (!property) return null

  // S631: a run may cover one utility or all of them. Counting the meters it
  // will actually contain is what stops an empty electric run being opened on a
  // water-only property.
  const utility = opts.utilityType ?? null
  const readable = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM utility_meters
      WHERE property_id = $1 AND billing_method IN ('submeter','rubs')
        AND ($2::text IS NULL OR utility_type = $2)`, [propertyId, utility])
  if (!readable || readable.n === 0) return null

  const findRun = () => queryOne<any>(
    `SELECT * FROM utility_reading_runs
      WHERE property_id = $1 AND billing_cycle_month = $2
        AND COALESCE(utility_type, 'all') = COALESCE($3::text, 'all')`,
    [propertyId, cycleMonth, utility])

  const existing = await findRun()
  if (existing) return existing

  const run = await queryOne<any>(
    `INSERT INTO utility_reading_runs
       (property_id, landlord_id, billing_cycle_month, opened_on, utility_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [propertyId, property.landlord_id, cycleMonth, todayInPhoenix(), utility])
  if (!run) {
    // Lost a concurrent-insert race — the other winner notifies.
    return findRun()
  }

  if (opts.notify !== false) {
    await notifyReadingRunOpened(run.id, property, readable.n, cycleMonth)
  }
  return run
}

/**
 * Daily scheduler entry point. Fires every morning; self-gates to the
 * last business day of the current month (Phoenix). Opens a run for the
 * current cycle on every property (any landlord) with readable meters.
 */
export async function openDueReadingRuns(): Promise<{ opened: number }> {
  const today = todayInPhoenix()
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  if (today !== lastBusinessDayOfMonth(y, m)) return { opened: 0 }

  const cycleMonth = `${today.slice(0, 7)}-01`
  // ONE run per property, covering every readable meter.
  //
  // S631 tried splitting this per utility so electric could finish without
  // waiting on a water bill in the post. Nic rejected it, correctly: his own
  // division runs down the middle of ONE utility — he holds the water MASTER
  // bills, somebody else walks the water SUBMETERS. "Splitting it by electric
  // and water doesn't work. It needs a better flow that would cover any
  // situation."
  //
  // The flow that covers any situation is the list itself. Readings save one
  // meter at a time, in any order, by anyone with the permission, and no meter
  // waits on another — so two people simply do parts of the same list. Cutting
  // it into runs adds a boundary that some real division will always straddle.
  // Scoped runs remain possible (openReadingRun takes a utilityType) but nothing
  // opens them automatically.
  const props = await query<{ property_id: string }>(
    `SELECT DISTINCT property_id FROM utility_meters
      WHERE billing_method IN ('submeter','rubs')`)

  let opened = 0
  for (const p of props) {
    try {
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM utility_reading_runs WHERE property_id = $1 AND billing_cycle_month = $2`,
        [p.property_id, cycleMonth])
      if (existing) continue
      const run = await openReadingRun(p.property_id, cycleMonth)
      if (run) opened++
    } catch (e) {
      logger.error({ err: e, propertyId: p.property_id }, '[reading-runs] open failed')
    }
  }
  return { opened }
}

async function notifyReadingRunOpened(
  runId: string,
  property: { id: string; name: string; landlord_id: string },
  meterCount: number,
  cycleMonth: string,
) {
  const monthLabel = new Date(cycleMonth + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  // Landlord always gets the prompt.
  const landlord = await queryOne<{ user_id: string; email: string; phone: string | null }>(
    `SELECT l.user_id, u.email, u.phone FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [property.landlord_id])

  // Staff whose scope covers this property AND whose permission toggles
  // include properties.edit — the key that gates reading entry, so we
  // only prompt people who can actually do the work.
  const staff = await query<{ user_id: string; email: string; phone: string | null }>(
    `SELECT DISTINCT u.id AS user_id, u.email, u.phone FROM (
        SELECT user_id FROM property_manager_scopes
         WHERE landlord_id = $1
           AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
           AND (permissions ->> 'properties.edit')::boolean IS TRUE
        UNION
        SELECT user_id FROM onsite_manager_scopes
         WHERE landlord_id = $1
           AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
           AND (permissions ->> 'properties.edit')::boolean IS TRUE
      ) s JOIN users u ON u.id = s.user_id`,
    [property.landlord_id, property.id])

  const recipients = [
    ...(landlord ? [landlord] : []),
    ...staff.filter(s => s.user_id !== landlord?.user_id),
  ]
  for (const r of recipients) {
    await createNotification({
      userId: r.user_id, landlordId: property.landlord_id,
      type: 'utility_reading_run_opened',
      title: `Meter readings due — ${property.name}`,
      body: `${monthLabel} reading run is open: ${meterCount} meter${meterCount === 1 ? '' : 's'} to read. Readings auto-calculate usage and bill leased units on their next invoice.`,
      data: { runId, propertyId: property.id, cycleMonth },
      actionUrl: `/utilities?propertyId=${property.id}`,
      sendEmail: true, emailTo: r.email,
      emailSubject: `Meter readings due — ${property.name} (${monthLabel})`,
      emailHtml: `The ${monthLabel} meter reading run for <b>${property.name}</b> is open. ${meterCount} meter${meterCount === 1 ? '' : 's'} to read. Open the Utilities page to start.`,
    })
  }
}

// ── Progress + completion ────────────────────────────────────────────

/**
 * Per-meter walk payload for a run: every readable meter on the
 * property with its assigned unit and whether it's been read this
 * cycle. Deliberately NO prior reading values — the reader must not
 * see the previous read (Nic: prevents biasing the entry). The
 * cycle_reading value itself is also withheld; only the fact that it
 * was read. will_bill mirrors utilityBilling.tryInsertBill's gate
 * (active lease, primary tenant, lease carries the utility).
 */
export async function getRunMeters(runId: string) {
  const rows = await query<any>(
    `SELECT m.id AS meter_id, m.label, m.utility_type, m.billing_method, m.digits,
            m.rubs_basis,
            -- S631: enough to render the list as a task list — what is done and
            -- when. Deliberately NOT who did it: Nic, "I don't wanna know who
            -- gets assigned to what... it's whoever jumps on and does what."
            cur.reading_date AS read_on,
            -- S607: does this master have submetered units on it? Decides
            -- whether the walk must insist on a usage total (needed to carve
            -- those units out of the pool) or can take the bill alone.
            EXISTS (SELECT 1 FROM utility_meter_units mmu
                      JOIN utility_meter_units smu ON smu.unit_id = mmu.unit_id
                      JOIN utility_meters sm ON sm.id = smu.meter_id
                                            AND sm.billing_method = 'submeter'
                                            AND sm.utility_type = m.utility_type
                     WHERE mmu.meter_id = m.id) AS has_submetered_units,
            u.id AS unit_id, u.unit_number,
            (cur.id IS NOT NULL) AS is_read,
            -- S652 (Nic): a photo of the meter face rides with the reading;
            -- the property decides whether its walk insists on one.
            (cur.photo_url IS NOT NULL) AS has_photo,
            p.meter_photo_required AS photo_required,
            (t.tenant_id IS NOT NULL) AS will_bill,
            to_char(r.billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
            -- S648: the tenant's due day decides when their meter is read.
            (SELECT l2.rent_due_day FROM leases l2
              WHERE l2.unit_id = u.id AND l2.status = 'active'
              ORDER BY l2.start_date DESC LIMIT 1) AS due_day
       FROM utility_reading_runs r
       JOIN properties p ON p.id = r.property_id
       JOIN utility_meters m ON m.property_id = r.property_id
                            AND m.billing_method IN ('submeter','rubs')
                            -- S631: the walk shows only what this run covers,
                            -- so the person reading electric is not handed a
                            -- water list they have no numbers for.
                            AND (r.utility_type IS NULL OR m.utility_type = r.utility_type)
       LEFT JOIN utility_meter_units mu ON mu.meter_id = m.id
       LEFT JOIN units u ON u.id = mu.unit_id
       LEFT JOIN utility_meter_readings cur
              ON cur.meter_id = m.id AND cur.billing_cycle_month = r.billing_cycle_month
             AND cur.reason = 'monthly_cycle'
       LEFT JOIN LATERAL (
              SELECT vlat.tenant_id
                FROM v_lease_active_tenants vlat
                JOIN leases l ON l.id = vlat.lease_id
                JOIN lease_utility_responsibilities lur
                  ON lur.lease_id = vlat.lease_id
                 AND lur.utility_type = m.utility_type
                 AND lur.tenant_responsible = TRUE
               WHERE l.unit_id = u.id AND l.status = 'active' AND vlat.role = 'primary'
               LIMIT 1
            ) t ON TRUE
      WHERE r.id = $1
      ORDER BY u.unit_number NULLS LAST, m.utility_type, m.label`,
    [runId])
  // S648 (Nic): a tenant billed on their own day has their meter read the last
  // business day before THAT day, so their usage lines up with their bill.
  // Submeters only — a RUBS master is read off the provider's bill.
  const today = todayInPhoenix()
  return rows.map(r => {
    const readBy = r.billing_method === 'submeter' && r.due_day && Number(r.due_day) !== 1
      ? meterReadBy(r.cycle_month, Number(r.due_day)) : null
    return { ...r, read_by: readBy, not_yet: !!readBy && !r.is_read && today < readBy }
  })
}

// ── Flagged reads (S652) ─────────────────────────────────────────────
//
// S533 built a blind VERIFICATION WALK here: every suspect plus random clean
// meters, re-read by staff so they couldn't tell which the system doubted.
// Nic, S652: "I don't know why there's two windows in the first place... get
// rid of the clean meters random blind reread. Just flag the ones that need
// flagging, with limited to one window."
//
// So: when the last meter is read, a run with nothing flagged completes on the
// spot. One with flagged reads waits — status 'double_check', kept for the
// history it already carries — for the landlord to settle them in the ONE
// window, "Readings to double-check". The last one settled completes the run.

/** Flagged reads still open on this run's cycle (submeters and masters alike). */
export async function countFlaggedOnRun(runId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM utility_reading_runs r
       JOIN utility_meters m ON m.property_id = r.property_id
                            AND m.billing_method IN ('submeter','rubs')
                            AND (r.utility_type IS NULL OR m.utility_type = r.utility_type)
       JOIN utility_meter_readings rd ON rd.meter_id = m.id
                                     AND rd.billing_cycle_month = r.billing_cycle_month
                                     AND rd.reason = 'monthly_cycle' AND rd.needs_review
      WHERE r.id = $1`, [runId])
  return row?.n ?? 0
}

/**
 * The last meter is read. Nothing flagged → the run completes now (or, for a
 * company that reviews its bills, the landlord is told they are ready).
 * Something flagged → the run waits on the review queue, and the landlord is
 * told what is waiting, once.
 */
export async function finishReadingPhase(runId: string, userId: string) {
  const run = await queryOne<any>(`SELECT * FROM utility_reading_runs WHERE id = $1`, [runId])
  if (!run || run.status !== 'open') return run
  const flagged = await countFlaggedOnRun(runId)
  if (flagged === 0) {
    const done = await completeReadingRun(runId, userId)
    if (!done || done.status !== 'completed') await tellLandlordBillsAreReady(runId)
    return done
  }
  const waiting = await queryOne<any>(
    `UPDATE utility_reading_runs SET status = 'double_check' WHERE id = $1 RETURNING *`, [runId])
  await tellLandlordReadsNeedReview(runId, flagged)
  return waiting
}

/**
 * A flagged read was settled from the review queue. If that was the last one
 * on a run that is waiting, the run completes — the same moment the walk's
 * last re-read used to bring.
 */
export async function settleFlaggedOnRun(propertyId: string, cycleMonth: string, userId: string) {
  const run = await queryOne<any>(
    `SELECT * FROM utility_reading_runs
      WHERE property_id = $1 AND billing_cycle_month = $2 AND status = 'double_check'`,
    [propertyId, cycleMonth])
  if (!run) return null
  if (await countFlaggedOnRun(run.id) > 0) return run
  const done = await completeReadingRun(run.id, userId)
  if (!done || done.status !== 'completed') await tellLandlordBillsAreReady(run.id)
  return done
}

async function tellLandlordReadsNeedReview(runId: string, flagged: number) {
  const r = await queryOne<any>(
    `SELECT r.id, r.property_id, r.billing_cycle_month, p.name, p.landlord_id, u.id AS user_id, u.email
       FROM utility_reading_runs r JOIN properties p ON p.id = r.property_id
       JOIN landlords l ON l.id = p.landlord_id JOIN users u ON u.id = l.user_id
      WHERE r.id = $1`, [runId])
  if (!r) return
  const month = new Date(String(r.billing_cycle_month).slice(0, 10) + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const body = `Every meter at ${r.name} is read for ${month}, and ${flagged} reading${flagged === 1 ? ' looks' : 's look'} off — ` +
    `below the last read, or unusually high. Check ${flagged === 1 ? 'it' : 'them'} under "Readings to double-check" and correct or confirm. ` +
    `The month's bills go out when the last one is settled; until then only those units' invoices wait.`
  await createNotification({
    userId: r.user_id, landlordId: r.landlord_id,
    type: 'utility_reads_need_review',
    title: `${flagged} meter reading${flagged === 1 ? '' : 's'} to double-check — ${r.name}`,
    body,
    data: { runId: r.id, propertyId: r.property_id, flagged },
    actionUrl: `/utilities?propertyId=${r.property_id}`,
    sendEmail: true, emailTo: r.email,
    emailSubject: `${flagged} meter reading${flagged === 1 ? '' : 's'} to double-check — ${r.name} (${month})`,
    emailHtml: body,
  }).catch(() => {})
}

/** S652: every read is in — the landlord approves before anything goes out. */
export async function tellLandlordBillsAreReady(runId: string) {
  const r = await queryOne<any>(
    `SELECT r.id, r.property_id, r.billing_cycle_month, p.name, p.landlord_id, u.id AS user_id, u.email
       FROM utility_reading_runs r JOIN properties p ON p.id = r.property_id
       JOIN landlords l ON l.id = p.landlord_id JOIN users u ON u.id = l.user_id
      WHERE r.id = $1 AND l.review_utility_bills`, [runId])
  if (!r) return
  const month = new Date(String(r.billing_cycle_month).slice(0, 10) + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  await createNotification({
    userId: r.user_id, landlordId: r.landlord_id,
    type: 'utility_bills_ready_to_review',
    title: `Utility bills ready to review — ${r.name}`,
    body: `${month}'s meter readings are all in. Look them over and approve, and the bills go out on each tenant's next invoice. Until then those invoices wait.`,
    data: { runId: r.id, propertyId: r.property_id },
    actionUrl: `/utilities?propertyId=${r.property_id}`,
    sendEmail: true, emailTo: r.email,
    emailSubject: `Utility bills ready to review — ${r.name} (${month})`,
    emailHtml: `${month}'s meter readings for <b>${r.name}</b> are all in. Open the Utilities page, review the bills, and approve them to send.`,
  }).catch(() => {})
}

/**
 * Complete a run: generate bills for the property + cycle through the
 * S90 engine, flip the fresh bills straight to 'billed' (the S178
 * invoice cron then folds them into each tenant's next invoice), stamp
 * the summary onto the run. Idempotent on the bill layer (UNIQUE meter
 * + unit + cycle) and guarded on run status. Reachable from 'open'
 * (escape hatch — e.g. a physically unreadable meter) or from
 * 'double_check' (the normal path once verification finishes).
 */
export async function completeReadingRun(runId: string, userId: string, opts: { approve?: boolean } = {}) {
  const run = await queryOne<any>(
    `SELECT r.*, l.review_utility_bills FROM utility_reading_runs r
       JOIN landlords l ON l.id = r.landlord_id WHERE r.id = $1`, [runId])
  if (!run || run.status === 'completed') return run
  // S652 (Nic): a company that chose to review its utility bills issues them
  // only on the landlord's approval. The walk finishing is not that — it
  // leaves the run waiting, and the landlord is told the bills are ready.
  // Everyone else's bills go through on their own, as they always did.
  if (run.review_utility_bills && !run.approved_at && !opts.approve) return run
  if (opts.approve && !run.approved_at) {
    await query(`UPDATE utility_reading_runs SET approved_at = NOW(), approved_by_user_id = $2 WHERE id = $1`, [runId, userId])
  }

  // pg returns date columns as local-midnight Date objects — normalize to
  // the day string before rebuilding a UTC date (string-concat on a Date
  // yields Invalid Date; the S531 walkthrough hit this same class).
  const cycleDay = run.billing_cycle_month instanceof Date
    ? `${run.billing_cycle_month.getFullYear()}-${String(run.billing_cycle_month.getMonth() + 1).padStart(2, '0')}-${String(run.billing_cycle_month.getDate()).padStart(2, '0')}`
    : String(run.billing_cycle_month).slice(0, 10)
  const results = await generateBillsForProperty(run.property_id, new Date(cycleDay + 'T00:00:00Z'))

  // Finalize what this cycle generated — the run IS the issuing act.
  const billed = await query<{ id: string; charge_amount: string }>(
    `UPDATE utility_bills ub
        SET status = 'billed', billed_at = NOW(), updated_at = NOW()
       FROM utility_meters m
      WHERE ub.meter_id = m.id
        AND m.property_id = $1
        AND ub.billing_cycle_month = $2
        AND ub.status = 'unbilled'
        -- S631: this run issues ITS utility's bills. A water run completing
        -- later must not sweep up electric bills it never verified.
        AND ($3::text IS NULL OR m.utility_type = $3)
      RETURNING ub.id, ub.charge_amount`,
    [run.property_id, run.billing_cycle_month, run.utility_type])

  const billsCreated = results.reduce((s, r) => s + (r.billsCreated || 0), 0)
  const billedTotal = billed.reduce((s, b) => s + Number(b.charge_amount), 0)

  return queryOne<any>(
    `UPDATE utility_reading_runs
        SET status = 'completed', completed_at = NOW(), completed_by_user_id = $2,
            bills_created = $3, billed_total = $4
      WHERE id = $1 RETURNING *`,
    [runId, userId, billsCreated, billedTotal])
}

/** True when every readable meter on the run's property has a reading for the run's cycle. */
export async function isRunFullyRead(runId: string): Promise<boolean> {
  const row = await queryOne<{ unread: number }>(
    `SELECT COUNT(*)::int AS unread
       FROM utility_reading_runs r
       JOIN utility_meters m ON m.property_id = r.property_id
                            AND m.billing_method IN ('submeter','rubs')
                            -- S631: a utility-scoped run is finished when ITS
                            -- meters are read. An outstanding water bill must
                            -- not hold back a completed electric walk.
                            AND (r.utility_type IS NULL OR m.utility_type = r.utility_type)
       LEFT JOIN utility_meter_readings rd
              ON rd.meter_id = m.id AND rd.billing_cycle_month = r.billing_cycle_month
             AND rd.reason = 'monthly_cycle'
      WHERE r.id = $1 AND rd.id IS NULL`,
    [runId])
  return !!row && row.unread === 0
}

// ── S548: pull-out meter reads (Nic) ─────────────────────────────────
//
// The final read MUST happen at the pull-out: it closes the departing guest's
// bill (same-day settlement) AND sets the baseline that protects the NEXT
// arrival from inheriting usage — RV sites turn over same-day in season. Every
// morning this finds the departures on submetered spots whose closing read is
// still missing and prompts the landlord + reading-capable staff, one
// notification per property, idempotent per day.
//
// 10/18 (Nic): "if there was a final bill and somebody moved out, the system
// did not alert us to do a meter read. Um, speaking of that, my RV spaces 10
// and 11, Victor Cardoza and Nemesio Rivera, they paid for a month. They both
// left early, so I need to get those meter reads."
//
// This used to ask who is leaving TODAY — a lease whose end date is today, a
// stay whose booked check-out is today and that has not checked out yet. Leave
// early and you fall out of that question twice over: the stay is already
// checked out, and its check-out date has moved back to the day the person
// actually drove off. So the read was never asked for on the one day it was
// asked for, and never asked for again. Victor and Nemesio left early, and
// nobody at Mountain View was ever told to read RV 10 or RV 11.
//
// It now asks what the front desk's own reads-due list asks — which departures
// still have no closing read — so the prompt comes back every morning until
// somebody reads the meter, whether they left on their booked day or a week
// early.

/**
 * The ONE definition of a departure whose closing read is still outstanding:
 * a lease whose last day has passed, or a stay that has checked out (or has
 * sat past its check-out), inside the ~60-day window this product works in.
 * The morning prompt, the front-desk reads-due list (getReadsDue) and the
 * check-in block (unitPendingReads) all build on this, so a departure one of
 * them sees can never be a departure another one misses.
 *
 * A household's last day is the earlier of the day the lease says it ends and
 * the day the lease was actually ended — the same rule the utility bills
 * themselves run on (utilityBilling.ts: leaseInForceOn,
 * LEASE_LAST_DAY_ON_SPACE_SQL). Both exits have to land here, because they
 * leave different marks: writing down a leaving day moves the end date and the
 * lease stays active (moveOutNotice.ts), while buying out of the lease stamps
 * the day it was ended and leaves the end date alone (leaseTermination.ts).
 * Reading only the end date meant a household that paid to leave in October
 * was invisible until the following August — the next rig pulls onto the spot
 * on an unread meter and their power lands on the new arrival's bill, which is
 * the exact loss this read exists to prevent. A lease that was ended before
 * anybody ever lived under it is void, not a departure — Mountain View RV 01,
 * a draft thrown away with no ending day stamped at all, and RV 09, ended
 * before its start day. Nobody was ever on the spot, so there is nothing to
 * read and nothing to ask the front desk for every morning.
 *
 * confirmed_gone separates "they are gone" from "the desk has not checked them
 * out yet". A rig still showing as checked in a day past its check-out is
 * routine at an RV park, so the notice must never tell the landlord somebody
 * left when they are still parked out front.
 *
 * stay_bills carries 10/5 (Nic): a stay of 30+ nights with no lease pays its
 * own spot's utilities, so its check-out read bills it the way a departing
 * lease's does. The two scope clauses narrow the sweep — one property, one
 * spot, or every property for the morning prompt — and leave the caller's own
 * placeholder numbering alone.
 */
function departuresCte(leaseScope: string, bookingScope: string): string {
  return `departures AS (
      SELECT * FROM (
        SELECT l.unit_id,
               -- The earlier of what the lease says and what actually happened.
               -- A month-to-month lease with no end date and no ending day is
               -- still running, and 'infinity' drops it at the window below.
               LEAST(COALESCE(l.end_date, 'infinity'::date),
                     COALESCE(timezone(p.timezone, l.terminated_at)::date, 'infinity'::date)) AS departed_on,
               l.id AS lease_id, FALSE AS stay_bills, TRUE AS confirmed_gone,
               (SELECT us.first_name || ' ' || us.last_name
                  FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
                  JOIN users us ON us.id = t.user_id
                 WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1) AS who
          FROM leases l JOIN units u ON u.id = l.unit_id
                        JOIN properties p ON p.id = u.property_id
         WHERE ${leaseScope}
           AND l.status IN ('active','expired','terminated')
           -- Ended before it ever started, or ended with no day stamped at
           -- all: a draft nobody ever lived under. NULL fails this test, which
           -- is what drops it.
           AND (l.status <> 'terminated'
                OR timezone(p.timezone, l.terminated_at)::date >= l.start_date)
      ) ld
       WHERE ld.departed_on <= CURRENT_DATE
         AND ld.departed_on >= CURRENT_DATE - INTERVAL '60 days'
      UNION ALL
      SELECT b.unit_id, b.check_out AS departed_on, NULL::uuid AS lease_id,
             EXISTS (SELECT 1 FROM utility_service_agreements sa WHERE sa.booking_id = b.id) AS stay_bills,
             b.status = 'checked_out' AS confirmed_gone,
             b.guest_name AS who
        FROM unit_bookings b JOIN units u ON u.id = b.unit_id
       WHERE ${bookingScope}
         AND b.check_out >= CURRENT_DATE - INTERVAL '60 days'
         AND (b.status = 'checked_out'
              OR (b.status IN ('confirmed','checked_in') AND b.check_out <= CURRENT_DATE))
    )`
}

type ClosingReadDue = {
  property_id: string; property_name: string; landlord_id: string
  unit_number: string; who: string | null
  departed_on: string; left_today: boolean; confirmed_gone: boolean
  /** A read WAS taken since they left and is held for the landlord to settle. */
  read_held: boolean
}

export async function promptMoveOutMeterReads(): Promise<{ prompted: number }> {
  const departures = await query<ClosingReadDue>(`
    WITH ${departuresCte('TRUE', 'TRUE')},
    outstanding AS (
      -- One row per spot: a lease ending and a stay checking out on the same
      -- spot are the same walk to the same meter. Somebody leaving TODAY takes
      -- the row — that read has to happen at the pull-out, and the notice has
      -- to name the guest driving off now, not one from two weeks ago. An
      -- older unread departure on the same spot used to win the row and talk
      -- the notice out of its own urgency. Past that, oldest first, so the
      -- notice names the one that has been waiting longest.
      SELECT DISTINCT ON (u.id)
             p.id AS property_id, p.name AS property_name, p.landlord_id,
             u.unit_number, d.who, d.departed_on, d.confirmed_gone,
             -- 10/25 (Nic): A READ WAS TAKEN AND IS WAITING ON HIM.
             --
             -- "That flow of checking people out at the front desk, when we
             --  input his meter read, it did not transfer it to the meter reads
             --  on the meter reading tab... I'm getting two notifications for
             --  the same spot that's already done and over with."
             --
             -- It DID transfer (Patrick Neuman, RV 06, 39999 on 10/23,
             -- move_out_final) — and then the rollback rule he asked for held it,
             -- because 40000 → 39999 is within a digit. The read stays
             -- outstanding on purpose (see the 10/20 note below: a dropped digit
             -- must not make the walk look done). But the notice then told him
             -- there was "no closing read", which is not true, reads as nobody
             -- having taken one, and is why he thought the register had lost it.
             --
             -- So the notice needs to know the difference. This says a read
             -- exists and is held; the bucket it feeds says what to actually do.
             EXISTS (
               SELECT 1 FROM utility_meter_readings rh
                WHERE rh.meter_id = m.id AND rh.reading_date >= d.departed_on
                  AND rh.needs_review) AS read_held
        FROM departures d
        JOIN units u ON u.id = d.unit_id
        JOIN properties p ON p.id = u.property_id
        JOIN utility_meter_units mu ON mu.unit_id = d.unit_id
        JOIN utility_meters m ON m.id = mu.meter_id
             AND m.billing_method = 'submeter' AND m.out_of_service = false
       WHERE NOT EXISTS (
          SELECT 1 FROM utility_meter_readings r
           WHERE r.meter_id = m.id AND r.reading_date >= d.departed_on
             -- 10/20: a read HELD for the landlord's double-check closed nothing
             -- out. A digit dropped at a pull-out used to make this to-do vanish as
             -- though the walk were done, so nobody went back to the meter and the
             -- departing guest's power was billed to nobody at all. It stays on the
             -- list until the number is settled (see billMoveOutRead).
             AND r.needs_review = false)
       ORDER BY u.id, (d.departed_on = CURRENT_DATE) DESC, d.departed_on
    )
    SELECT property_id, property_name, landlord_id, unit_number, who, confirmed_gone, read_held,
           to_char(departed_on, 'YYYY-MM-DD') AS departed_on,
           departed_on = CURRENT_DATE AS left_today
      FROM outstanding
     ORDER BY property_id, unit_number`)
  if (departures.length === 0) return { prompted: 0 }

  // Group by property.
  const byProperty = new Map<string, ClosingReadDue[]>()
  for (const d of departures) {
    const arr = byProperty.get(d.property_id) ?? []
    arr.push(d)
    byProperty.set(d.property_id, arr)
  }

  const spot = (r: ClosingReadDue) => `${r.unit_number}${r.who ? ` (${r.who})` : ''}`
  const short = (iso: string) => new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  let prompted = 0
  for (const [propertyId, rows] of byProperty) {
    // One prompt per property per day.
    const already = await queryOne<{ id: string }>(
      `SELECT id FROM notifications
        WHERE type = 'moveout_meter_reads_due'
          AND data ->> 'propertyId' = $1
          AND created_at::date = CURRENT_DATE
        LIMIT 1`, [propertyId])
    if (already) continue

    const prop = rows[0]
    // 10/25 (Nic): a spot whose read is HELD is not a spot with no read, and
    // saying so was the whole complaint. It comes out of the other three
    // buckets entirely and gets its own sentence, because the action is
    // different: confirm a figure, not walk to a meter.
    const held = rows.filter(r => r.read_held)
    const unread = rows.filter(r => !r.read_held)
    const todayRows = unread.filter(r => r.left_today)
    const gone = unread.filter(r => !r.left_today && r.confirmed_gone)
    // Past their check-out and NOT checked out: the rig is very likely still
    // sitting there. Saying they left would be a plain untruth in an email to
    // the landlord and every staffer on the property, so it says what the desk
    // actually has on the books.
    const stillOn = unread.filter(r => !r.left_today && !r.confirmed_gone)
    const parts: string[] = []
    if (todayRows.length) {
      parts.push(
        `${todayRows.length} site${todayRows.length === 1 ? ' is' : 's are'} pulling out today: ` +
        `${todayRows.map(spot).join(', ')}. ` +
        `Read each meter AT checkout — the final bill lands on the departing guest and settles the same day, ` +
        `and the read is the baseline that keeps their usage off the next arrival's bill.`)
    }
    if (gone.length) {
      parts.push(
        `${gone.length} site${gone.length === 1 ? ' has' : 's have'} already left with no closing read: ` +
        `${gone.map(r => `${spot(r)} — left ${short(r.departed_on)}`).join('; ')}. ` +
        `Read ${gone.length === 1 ? 'that meter' : 'those meters'} now: the read closes their final bill, ` +
        `and until it is taken their usage rolls onto whoever pulls in next.`)
    }
    if (stillOn.length) {
      parts.push(
        `${stillOn.length} site${stillOn.length === 1 ? ' is' : 's are'} past checkout and not checked out yet, ` +
        `with no closing read: ` +
        `${stillOn.map(r => `${spot(r)} — due out ${short(r.departed_on)}`).join('; ')}. ` +
        `Read ${stillOn.length === 1 ? 'that meter' : 'those meters'} and check ` +
        `${stillOn.length === 1 ? 'the stay' : 'the stays'} out: until the read is taken their usage rolls onto ` +
        `whoever pulls in next.`)
    }
    if (held.length) {
      parts.push(
        `${held.length} closing read${held.length === 1 ? ' was' : 's were'} taken and ${held.length === 1 ? 'is' : 'are'} waiting on you: ` +
        `${held.map(r => `${spot(r)} — left ${short(r.departed_on)}`).join('; ')}. ` +
        `The figure did not sit right with the one before it, so GAM is holding it rather than billing it. ` +
        `Settle ${held.length === 1 ? 'it' : 'them'} under Readings to double-check — confirm the number or save a corrected one, ` +
        `and the final bill goes out. Nobody needs to walk back to ${held.length === 1 ? 'that meter' : 'those meters'} unless you want a second look.`)
    }
    const body = parts.join(' ')
    // 10/25 (Nic): the title said reads were "due" for a spot whose read was
    // taken, which is what made him think the register had lost it. When the
    // only thing left is a figure to confirm, the title says that instead.
    const title = todayRows.length
      ? `Pull-out meter reads due today — ${prop.property_name}`
      : unread.length === 0 && held.length
        ? `Closing meter read${held.length === 1 ? '' : 's'} waiting on you — ${prop.property_name}`
        : `Closing meter reads still due — ${prop.property_name}`

    const landlord = await queryOne<{ user_id: string; email: string }>(
      `SELECT l.user_id, u.email FROM landlords l JOIN users u ON u.id = l.user_id
        WHERE l.id = $1`, [prop.landlord_id])
    // S559: notify whoever can actually take the read — landlord-tier
    // (properties.edit) AND front desk (utility.read_meters).
    const staff = await query<{ user_id: string; email: string }>(
      `SELECT DISTINCT u.id AS user_id, u.email FROM (
          SELECT user_id FROM property_manager_scopes
           WHERE landlord_id = $1
             AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
             AND ((permissions ->> 'properties.edit')::boolean IS TRUE
                  OR (permissions ->> 'utility.read_meters')::boolean IS TRUE)
          UNION
          SELECT user_id FROM onsite_manager_scopes
           WHERE landlord_id = $1
             AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
             AND ((permissions ->> 'properties.edit')::boolean IS TRUE
                  OR (permissions ->> 'utility.read_meters')::boolean IS TRUE)
        ) s JOIN users u ON u.id = s.user_id`,
      [prop.landlord_id, propertyId])

    const recipients = [
      ...(landlord ? [landlord] : []),
      ...staff.filter(s => s.user_id !== landlord?.user_id),
    ]
    for (const r of recipients) {
      await createNotification({
        userId: r.user_id, landlordId: prop.landlord_id,
        type: 'moveout_meter_reads_due',
        title,
        body,
        data: { propertyId, unitNumbers: rows.map(x => x.unit_number) },
        actionUrl: `/utilities?propertyId=${propertyId}`,
        sendEmail: true, emailTo: r.email,
        emailSubject: title,
        emailHtml: body,
      })
    }
    prompted++
  }
  return { prompted }
}

// ── S652: reads that fall on a tenant's own date (Nic) ───────────────
//
// "No reminder on the read day... let's fix that gap too."
//
// A round opens at month end and says so once. A tenant due on the 15th is read
// on the 14th, a tenant due on the 23rd on the 22nd — and nothing said so on
// those days. Miss one and that tenant's whole invoice, rent included, sits
// held until somebody notices.
//
// Every morning: the meters whose read day is TODAY, and the ones whose day has
// passed and are still unread. One notice per property per day, to whoever can
// take the read — the landlord, staff with the permission, and work traders
// whose agreement includes meter reading. Tenants due on the 1st are not
// listed: they are the month-end round, which has its own notice.
export async function promptTenantDateMeterReads(
  today: string = todayInPhoenix(),
): Promise<{ prompted: number; meters: number }> {
  const runs = await query<{ id: string; property_id: string; landlord_id: string; property_name: string }>(
    `SELECT r.id, r.property_id, r.landlord_id, p.name AS property_name
       FROM utility_reading_runs r JOIN properties p ON p.id = r.property_id
      WHERE r.status = 'open'
      ORDER BY r.billing_cycle_month`)
  type Due = { unit: string; readBy: string }
  const byProperty = new Map<string, { landlordId: string; name: string; due: Due[] }>()
  for (const run of runs) {
    const rows = await getRunMeters(run.id)
    for (const m of rows as any[]) {
      if (!m.read_by || m.is_read || !m.will_bill || m.read_by > today) continue
      const entry = byProperty.get(run.property_id)
        ?? { landlordId: run.landlord_id, name: run.property_name, due: [] as Due[] }
      entry.due.push({ unit: m.unit_number || m.label, readBy: m.read_by })
      byProperty.set(run.property_id, entry)
    }
  }

  let prompted = 0, meters = 0
  const short = (iso: string) => new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  for (const [propertyId, p] of byProperty) {
    const already = await queryOne<{ id: string }>(
      `SELECT id FROM notifications
        WHERE type = 'tenant_date_meter_reads_due'
          AND data ->> 'propertyId' = $1 AND data ->> 'day' = $2
        LIMIT 1`, [propertyId, today])
    if (already) continue

    const dueToday = p.due.filter(d => d.readBy === today)
    const overdue = p.due.filter(d => d.readBy < today)
    const parts: string[] = []
    if (dueToday.length) {
      parts.push(`${dueToday.length} meter${dueToday.length === 1 ? '' : 's'} to read today: ` +
        `${dueToday.map(d => d.unit).join(', ')}. Their rent is due next, and the reading goes on that bill.`)
    }
    if (overdue.length) {
      parts.push(`${overdue.length} overdue: ` +
        `${overdue.map(d => `${d.unit} (was due ${short(d.readBy)})`).join(', ')}. ` +
        `${overdue.length === 1 ? "That tenant's bill is" : "Those tenants' bills are"} on hold, rent included, until the meter is read.`)
    }
    const body = parts.join(' ')
    const title = overdue.length && !dueToday.length
      ? `Overdue meter reads — ${p.name}`
      : `Meter reads due today — ${p.name}`

    const landlord = await queryOne<{ user_id: string; email: string }>(
      `SELECT l.user_id, u.email FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
      [p.landlordId])
    const staff = await query<{ user_id: string; email: string }>(
      `SELECT DISTINCT u.id AS user_id, u.email FROM (
          SELECT user_id FROM property_manager_scopes
           WHERE landlord_id = $1
             AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
             AND ((permissions ->> 'properties.edit')::boolean IS TRUE
                  OR (permissions ->> 'utility.read_meters')::boolean IS TRUE)
          UNION
          SELECT user_id FROM onsite_manager_scopes
           WHERE landlord_id = $1
             AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
             AND ((permissions ->> 'properties.edit')::boolean IS TRUE
                  OR (permissions ->> 'utility.read_meters')::boolean IS TRUE)
        ) s JOIN users u ON u.id = s.user_id`,
      [p.landlordId, propertyId])
    // Work traders whose agreement includes reading meters read them from the
    // tenant portal, so their notice opens there.
    const traders = await query<{ user_id: string; email: string }>(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM work_trade_agreements a
         JOIN tenants t ON t.id = a.tenant_id
         JOIN users u ON u.id = t.user_id
         JOIN units un ON un.id = a.unit_id
        WHERE un.property_id = $1 AND a.status = 'active'
          AND 'read_meters' = ANY(a.field_permissions)`, [propertyId])

    const seen = new Set<string>()
    const recipients = [
      ...(landlord ? [{ ...landlord, url: `/utilities?propertyId=${propertyId}` }] : []),
      ...staff.map(x => ({ ...x, url: `/utilities?propertyId=${propertyId}` })),
      ...traders.map(x => ({ ...x, url: '/meter-readings' })),
    ].filter(r => (seen.has(r.user_id) ? false : (seen.add(r.user_id), true)))
    for (const r of recipients) {
      await createNotification({
        userId: r.user_id, landlordId: p.landlordId,
        type: 'tenant_date_meter_reads_due',
        title, body,
        data: { propertyId, day: today, dueToday: dueToday.map(d => d.unit), overdue: overdue.map(d => d.unit) },
        actionUrl: r.url,
        sendEmail: true, emailTo: r.email,
        emailSubject: title,
        emailHtml: body,
      })
    }
    prompted++
    meters += p.due.length
  }
  return { prompted, meters }
}

// S559: LIVE front-desk "reads due" list — derived from the CURRENT calendar
// every call, never a stored snapshot, so guest extensions / early checkouts
// / cancellations self-correct with zero special handling. A spot is "due"
// when it has a submeter and a departure (lease ended, or booking checked out
// / past checkout) within the last ~60 days that has NO read on or after the
// departure date yet. Reason is CLASSIFIED from the stay so the read is
// stamped without the reader choosing it: a departing lease whose tenant is
// responsible for that utility → move_out_final (bills); everything else
// (short-term / utilities-included) → stay_turnover (reference). Taking the
// read, extending the stay, or canceling all drop the row on the next fetch.
export async function getReadsDue(propertyId: string) {
  return query<any>(`
    WITH ${departuresCte('u.property_id = $1', 'u.property_id = $1')}
    SELECT d.unit_id, u.unit_number, d.departed_on, d.lease_id, d.who,
           m.id AS meter_id, m.label AS meter_label, m.utility_type,
           CASE WHEN (d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)) OR d.stay_bills
                THEN 'move_out_final' ELSE 'stay_turnover' END AS reason
      FROM departures d
      JOIN units u ON u.id = d.unit_id
      JOIN utility_meter_units mu ON mu.unit_id = d.unit_id
      JOIN utility_meters m ON m.id = mu.meter_id AND m.billing_method = 'submeter'
           AND m.out_of_service = false
      LEFT JOIN lease_utility_responsibilities lur
             ON lur.lease_id = d.lease_id AND lur.utility_type = m.utility_type
     WHERE NOT EXISTS (
        SELECT 1 FROM utility_meter_readings r
         WHERE r.meter_id = m.id AND r.reading_date >= d.departed_on
           -- 10/20: a read HELD for the landlord's double-check closed nothing
           -- out. A digit dropped at a pull-out used to make this to-do vanish as
           -- though the walk were done, so nobody went back to the meter and the
           -- departing guest's power was billed to nobody at all. It stays on the
           -- list until the number is settled (see billMoveOutRead).
           AND r.needs_review = false)
     ORDER BY d.departed_on, u.unit_number, m.label`, [propertyId])
}

// S559: pending closing reads for ONE unit — the same "departure with no
// post-departure read" logic scoped to a single spot, used to BLOCK checking
// a new guest into a spot whose previous occupant's meter hasn't been read
// yet (same-day turnover). Broken meters are excluded — they bill from
// comparables and need no read. Empty array = clear to check in.
export async function unitPendingReads(unitId: string) {
  return query<any>(`
    WITH ${departuresCte('l.unit_id = $1', 'b.unit_id = $1')}
    -- 10/3: one row per meter (two departures used to ask for the same meter
    -- twice). A billing move-out wins over a turnover; its lease rides along
    -- so the read bills that household.
    SELECT DISTINCT ON (m.id) m.id AS meter_id, m.label AS meter_label, m.utility_type,
           CASE WHEN (d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)) OR d.stay_bills
                THEN 'move_out_final' ELSE 'stay_turnover' END AS reason,
           CASE WHEN d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)
                THEN d.lease_id END AS lease_id
      FROM departures d
      JOIN utility_meter_units mu ON mu.unit_id = $1
      JOIN utility_meters m ON m.id = mu.meter_id
           AND m.billing_method = 'submeter' AND m.out_of_service = false
      LEFT JOIN lease_utility_responsibilities lur
             ON lur.lease_id = d.lease_id AND lur.utility_type = m.utility_type
     WHERE NOT EXISTS (
        SELECT 1 FROM utility_meter_readings r
         WHERE r.meter_id = m.id AND r.reading_date >= d.departed_on
           -- 10/20: a read HELD for the landlord's double-check closed nothing
           -- out. A digit dropped at a pull-out used to make this to-do vanish as
           -- though the walk were done, so nobody went back to the meter and the
           -- departing guest's power was billed to nobody at all. It stays on the
           -- list until the number is settled (see billMoveOutRead).
           AND r.needs_review = false)
     ORDER BY m.id,
              ((d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)) OR d.stay_bills) DESC,
              d.departed_on DESC`,
    [unitId])
}
