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

import { METER_DOUBLE_CHECK_MIN, METER_DOUBLE_CHECK_TOLERANCE, METER_USAGE_ALERT_THRESHOLDS, meterReadingModulus } from '@gam/shared'
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
  return query<any>(
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
            (t.tenant_id IS NOT NULL) AS will_bill
       FROM utility_reading_runs r
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
}

// ── Double-check verification phase (S533) ───────────────────────────
// The reader finishes the whole walk uninterrupted; back at the office
// the system generates a blind re-read list: every suspicious submeter
// plus RANDOM clean ones so the list always has METER_DOUBLE_CHECK_MIN
// entries and the reader can't tell which are the suspects. Billing
// does NOT wait for this phase (S534) — clean original reads bill on
// each lease's invoice date regardless; the re-read corrects the stored
// value only while its bill hasn't reached an invoice.

/** Flip a fully-read run into its verification phase and build the list. */
export async function startDoubleCheckPhase(runId: string) {
  const run = await queryOne<any>(
    `SELECT * FROM utility_reading_runs WHERE id = $1`, [runId])
  if (!run || run.status !== 'open') return run

  const suspects = await query<{ meter_id: string; reading_value: string }>(
    `SELECT rd.meter_id, rd.reading_value
       FROM utility_meter_readings rd
       JOIN utility_meters m ON m.id = rd.meter_id
      WHERE m.property_id = $1 AND m.billing_method = 'submeter'
        AND rd.billing_cycle_month = $2 AND rd.reason = 'monthly_cycle' AND rd.needs_review
        AND ($3::text IS NULL OR m.utility_type = $3)`,
    [run.property_id, run.billing_cycle_month, run.utility_type])
  const pads = await query<{ meter_id: string; reading_value: string }>(
    `SELECT rd.meter_id, rd.reading_value
       FROM utility_meter_readings rd
       JOIN utility_meters m ON m.id = rd.meter_id
      WHERE m.property_id = $1 AND m.billing_method = 'submeter'
        AND rd.billing_cycle_month = $2 AND rd.reason = 'monthly_cycle' AND NOT rd.needs_review
        AND ($4::text IS NULL OR m.utility_type = $4)
      ORDER BY random()
      LIMIT $3`,
    [run.property_id, run.billing_cycle_month,
     Math.max(0, METER_DOUBLE_CHECK_MIN - suspects.length), run.utility_type])

  for (const row of [...suspects.map(s => ({ ...s, sus: true })), ...pads.map(p => ({ ...p, sus: false }))]) {
    await query(
      `INSERT INTO utility_reading_double_checks (run_id, meter_id, first_value, is_suspicious)
       VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, meter_id) DO NOTHING`,
      [runId, row.meter_id, row.reading_value, row.sus])
  }
  return queryOne<any>(
    `UPDATE utility_reading_runs SET status = 'double_check' WHERE id = $1 RETURNING *`,
    [runId])
}

/**
 * Blind verification payload — the same shape the main walk consumes.
 * Deliberately NO first values and NO suspicion markers: the re-reader
 * must not know which entries the system doubts.
 */
export async function getDoubleChecks(runId: string) {
  return query<any>(
    `SELECT dc.meter_id, m.label, m.utility_type, m.billing_method, m.digits,
            u.id AS unit_id, u.unit_number,
            (dc.second_value IS NOT NULL) AS is_read
       FROM utility_reading_double_checks dc
       JOIN utility_meters m ON m.id = dc.meter_id
       LEFT JOIN utility_meter_units mu ON mu.meter_id = m.id
       LEFT JOIN units u ON u.id = mu.unit_id
      WHERE dc.run_id = $1
      ORDER BY u.unit_number NULLS LAST, m.utility_type, m.label`,
    [runId])
}

/**
 * Record a re-read and reconcile automatically:
 *   - within METER_DOUBLE_CHECK_TOLERANCE of the first read → the meter
 *     just moved between reads; the FIRST read stands for billing and
 *     the drift bills next cycle ('verified').
 *   - bigger difference → the deliberate re-read replaces the original
 *     ('replaced'), and a high usage it confirms simply bills — the
 *     re-read IS the verification.
 *   - the one unresolvable case: the effective value sits below the
 *     previous reading with an implausible wrap — rollover vs meter
 *     swap is a money decision, so it stays flagged for the landlord
 *     ('escalated') and that meter doesn't bill until resolved.
 * Completes the run (bills generate + finalize) after the last entry.
 */
export async function enterDoubleCheck(runId: string, meterId: string, secondValue: number, userId: string) {
  const dc = await queryOne<any>(
    `SELECT dc.*, m.digits, m.utility_type
       FROM utility_reading_double_checks dc
       JOIN utility_meters m ON m.id = dc.meter_id
      WHERE dc.run_id = $1 AND dc.meter_id = $2`, [runId, meterId])
  if (!dc) return null
  const run = await queryOne<any>(
    `SELECT * FROM utility_reading_runs WHERE id = $1`, [runId])

  // S534: bills can now exist BEFORE verification finishes — the invoice
  // cron bills per-unit straight from original reads (Nic: an unfinished
  // verification walk never holds billing). Once this cycle's bill is on
  // an invoice (payment_id set) the reading is immutable: the FIRST read
  // stands no matter the re-read, and any drift self-corrects next cycle
  // because usage is always computed against the stored value. A bill
  // not yet on an invoice is deleted when the re-read replaces the
  // value, then regenerates from the corrected reading (run completion /
  // invoice-time ensure both re-run the idempotent engine).
  const bill = await queryOne<{ id: string; payment_id: string | null }>(
    `SELECT id, payment_id FROM utility_bills
      WHERE meter_id = $1 AND billing_cycle_month = $2
      LIMIT 1`, [meterId, run.billing_cycle_month])
  const billLocked = !!bill?.payment_id

  const first = Number(dc.first_value)
  const withinTol = billLocked || Math.abs(secondValue - first) <= METER_DOUBLE_CHECK_TOLERANCE
  const effective = withinTol ? first : secondValue

  // Point-in-time prior (S559): the read immediately before THIS cycle's
  // read by time (excluding the cycle read itself), which may be a mid-month
  // turnover/reference read that reset the baseline.
  const prior = await queryOne<{ reading_value: string }>(
    `SELECT reading_value FROM utility_meter_readings
      WHERE meter_id = $1
        AND NOT (billing_cycle_month = $2 AND reason = 'monthly_cycle')
      ORDER BY reading_date DESC, created_at DESC LIMIT 1`,
    [meterId, run.billing_cycle_month])

  let isRollover = false
  let needsReview = false
  if (prior && effective < Number(prior.reading_value)) {
    const modulus = meterReadingModulus(dc.digits)
    const wrap = (modulus - Number(prior.reading_value)) + effective
    if (wrap < modulus / 2) isRollover = true
    else needsReview = true
  }
  const outcome = needsReview ? 'escalated' : (withinTol ? 'verified' : 'replaced')

  if (!billLocked) {
    await query(
      `UPDATE utility_meter_readings
          SET reading_value = $3, needs_review = $4, is_rollover = $5, review_note = $6
        WHERE meter_id = $1 AND billing_cycle_month = $2 AND reason = 'monthly_cycle'`,
      [meterId, run.billing_cycle_month, effective, needsReview, isRollover,
       needsReview ? 'Re-read confirmed a value below the previous reading — rollover or meter swap?' : null])
    // An un-invoiced bill built on the superseded value is stale — drop
    // it so the engine regenerates from the corrected reading.
    if (bill && effective !== first) {
      await query(
        `DELETE FROM utility_bills WHERE id = $1 AND payment_id IS NULL`, [bill.id])
    }
  }
  const updated = await queryOne<any>(
    `UPDATE utility_reading_double_checks
        SET second_value = $2, outcome = $3, entered_by_user_id = $4, entered_at = NOW()
      WHERE id = $1 RETURNING *`,
    [dc.id, secondValue, outcome, userId])

  const remaining = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM utility_reading_double_checks
      WHERE run_id = $1 AND second_value IS NULL`, [runId])
  let finishedRun = null
  if (remaining && remaining.n === 0) {
    finishedRun = await completeReadingRun(runId, userId)
  }
  return { doubleCheck: updated, run: finishedRun ?? run }
}

/** Escalations left on a run's cycle — surfaced in the completion summary. */
export async function countEscalations(runId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM utility_reading_double_checks
      WHERE run_id = $1 AND outcome = 'escalated'`, [runId])
  return row?.n ?? 0
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
export async function completeReadingRun(runId: string, userId: string) {
  const run = await queryOne<any>(
    `SELECT * FROM utility_reading_runs WHERE id = $1`, [runId])
  if (!run || run.status === 'completed') return run

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
// The final read MUST happen on the pull-out date: it closes the departing
// guest's bill (same-day settlement) AND sets the baseline that protects
// the NEXT arrival from inheriting usage — RV sites turn over same-day in
// season. Every morning this finds today's departures on submetered sites
// and prompts the landlord + reading-capable staff, one notification per
// property, idempotent per day.
export async function promptMoveOutMeterReads(): Promise<{ prompted: number }> {
  const departures = await query<{
    property_id: string; property_name: string; landlord_id: string
    unit_number: string; who: string | null
  }>(`
    SELECT DISTINCT p.id AS property_id, p.name AS property_name, p.landlord_id,
           u.unit_number, x.who
      FROM (
        SELECT l.unit_id,
               (SELECT us.first_name || ' ' || us.last_name
                  FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
                  JOIN users us ON us.id = t.user_id
                 WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1) AS who
          FROM leases l
         WHERE l.status = 'active' AND l.end_date = CURRENT_DATE
        UNION
        SELECT b.unit_id, b.guest_name AS who
          FROM unit_bookings b
         WHERE b.status IN ('confirmed', 'checked_in') AND b.check_out = CURRENT_DATE
      ) x
      JOIN units u ON u.id = x.unit_id
      JOIN properties p ON p.id = u.property_id
     WHERE EXISTS (
        SELECT 1 FROM utility_meter_units mu
          JOIN utility_meters m ON m.id = mu.meter_id AND m.billing_method = 'submeter'
         WHERE mu.unit_id = u.id)
     ORDER BY p.id, u.unit_number`)
  if (departures.length === 0) return { prompted: 0 }

  // Group by property.
  const byProperty = new Map<string, typeof departures>()
  for (const d of departures) {
    const arr = byProperty.get(d.property_id) ?? []
    arr.push(d)
    byProperty.set(d.property_id, arr)
  }

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
    const siteList = rows.map(r => `${r.unit_number}${r.who ? ` (${r.who})` : ''}`).join(', ')
    const body =
      `${rows.length} site${rows.length === 1 ? ' is' : 's are'} pulling out today: ${siteList}. ` +
      `Read each meter AT checkout — the final bill lands on the departing guest and settles the same day, ` +
      `and the read is the baseline that keeps their usage off the next arrival's bill.`

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
        title: `Pull-out meter reads due today — ${prop.property_name}`,
        body,
        data: { propertyId, unitNumbers: rows.map(x => x.unit_number) },
        actionUrl: `/utilities?propertyId=${propertyId}`,
        sendEmail: true, emailTo: r.email,
        emailSubject: `Pull-out meter reads due today — ${prop.property_name}`,
        emailHtml: body,
      })
    }
    prompted++
  }
  return { prompted }
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
// read, extending the stay, or cancelling all drop the row on the next fetch.
export async function getReadsDue(propertyId: string) {
  return query<any>(`
    WITH departures AS (
      SELECT l.unit_id, l.end_date AS departed_on, l.id AS lease_id,
             (SELECT us.first_name || ' ' || us.last_name
                FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
                JOIN users us ON us.id = t.user_id
               WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1) AS who
        FROM leases l JOIN units u ON u.id = l.unit_id
       WHERE u.property_id = $1 AND l.end_date IS NOT NULL
         AND l.end_date <= CURRENT_DATE AND l.end_date >= CURRENT_DATE - INTERVAL '60 days'
         AND l.status IN ('active','ended','expired')
      UNION ALL
      SELECT b.unit_id, b.check_out AS departed_on, NULL::uuid AS lease_id, b.guest_name AS who
        FROM unit_bookings b JOIN units u ON u.id = b.unit_id
       WHERE u.property_id = $1
         AND b.check_out >= CURRENT_DATE - INTERVAL '60 days'
         AND (b.status = 'checked_out'
              OR (b.status IN ('confirmed','checked_in') AND b.check_out <= CURRENT_DATE))
    )
    SELECT d.unit_id, u.unit_number, d.departed_on, d.lease_id, d.who,
           m.id AS meter_id, m.label AS meter_label, m.utility_type,
           CASE WHEN d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)
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
         WHERE r.meter_id = m.id AND r.reading_date >= d.departed_on)
     ORDER BY d.departed_on, u.unit_number, m.label`, [propertyId])
}

// S559: pending closing reads for ONE unit — the same "departure with no
// post-departure read" logic scoped to a single spot, used to BLOCK checking
// a new guest into a spot whose previous occupant's meter hasn't been read
// yet (same-day turnover). Broken meters are excluded — they bill from
// comparables and need no read. Empty array = clear to check in.
export async function unitPendingReads(unitId: string) {
  return query<any>(`
    WITH departures AS (
      SELECT l.end_date AS departed_on, l.id AS lease_id
        FROM leases l
       WHERE l.unit_id = $1 AND l.end_date IS NOT NULL
         AND l.end_date <= CURRENT_DATE AND l.end_date >= CURRENT_DATE - INTERVAL '60 days'
         AND l.status IN ('active','ended','expired')
      UNION ALL
      SELECT b.check_out AS departed_on, NULL::uuid AS lease_id
        FROM unit_bookings b
       WHERE b.unit_id = $1
         AND b.check_out >= CURRENT_DATE - INTERVAL '60 days'
         AND (b.status = 'checked_out'
              OR (b.status IN ('confirmed','checked_in') AND b.check_out <= CURRENT_DATE))
    )
    SELECT DISTINCT m.id AS meter_id, m.label AS meter_label, m.utility_type,
           CASE WHEN d.lease_id IS NOT NULL AND COALESCE(lur.tenant_responsible, false)
                THEN 'move_out_final' ELSE 'stay_turnover' END AS reason
      FROM departures d
      JOIN utility_meter_units mu ON mu.unit_id = $1
      JOIN utility_meters m ON m.id = mu.meter_id
           AND m.billing_method = 'submeter' AND m.out_of_service = false
      LEFT JOIN lease_utility_responsibilities lur
             ON lur.lease_id = d.lease_id AND lur.utility_type = m.utility_type
     WHERE NOT EXISTS (
        SELECT 1 FROM utility_meter_readings r
         WHERE r.meter_id = m.id AND r.reading_date >= d.departed_on)`,
    [unitId])
}
