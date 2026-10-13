/**
 * MARK A BROKEN METER REPAIRED — the one code path (10/12).
 *
 * The landlord's "Mark repaired" button (PATCH /api/utility/meters/:id with
 * outOfService: false) and the one-time repair of Gerald Logue's meter
 * (scripts/oct12_gerald_meter) both come through here, so a meter is never put
 * back in service two different ways.
 *
 * S648 (Nic): "for the meters marked broken and then marked as repaired, they
 * also need a new fresh meter read. If they bought a brand new meter, the
 * read's going to be zero. But if they bought a refurbished one somewhere, it
 * may have some number on it. And we need to set that as the starting point
 * for the next billing cycle." So the meter goes back in service (no longer
 * billed from comparable spots, S559) and the reading it shows now is recorded
 * as a replacement read: it starts the next measurement and bills nothing.
 *
 * 10/12 (Nic) — "mark his meter working (zero use then bills $0)". A meter
 * that was never broken, on a space whose household uses nothing, reads the
 * same number again next cycle; measured from the fresh read, that is zero use
 * on an occupied space, which the stuck-meter test (services/utilityBilling)
 * marks broken again — and, where the property estimates (Mountain View),
 * bills another estimate. `zeroUseConfirmed` records that somebody confirmed
 * the meter works and nobody uses it (utility_meters.zero_use_confirmed_at):
 * the stuck test then takes a flat read at its word ($0, no line) until the
 * meter moves, somebody marks it broken by hand, or the household leaves.
 * "Repaired" does not set it — a repaired meter that still does not move is
 * still flagged (S648: "That will encourage landlords to actually replace the
 * meter").
 *
 * 10/12 (Nic), M1: "ADD 'Works, tenant uses no power' choice next to
 * 'Repaired' (Gerald specifically is gone, not plugged in, paying for
 * occupancy)." That choice is markMeterWorksNoUse below: back in service and
 * the zero-use confirmation recorded, with NO new reading — the meter was never
 * broken, so the readings it already has are right and the next one is
 * measured from them. A billed cycle that shows use clears the confirmation
 * (services/utilityBilling clearZeroUseConfirmation) — decided from the reads
 * as they stand when the cycle is billed, so a read corrected before billing
 * is simply the read (10/12 review: a trigger that cleared it the moment a
 * differing read was saved lost it for good to a typo corrected minutes later).
 */
import type { PoolClient } from 'pg'
import { meterWorksNoUseLabel } from '@gam/shared'
import { getClient } from '../db'
import { logger } from '../lib/logger'
import { chargeHeldByRecordSql, voidUnowedCharges } from './chargeVoids'
import { lockHousehold } from './moneyPredicates'

export async function markMeterRepaired(client: PoolClient, a: {
  meterId: string
  /** What the meter reads right now (0 for a brand-new meter). */
  startingReading: number
  /** Who recorded it (the landlord or staff member). */
  userId: string
  /** The meter works and the household on it uses nothing: zero use bills $0 (10/12). */
  zeroUseConfirmed?: boolean
}): Promise<void> {
  const meter = (await client.query<{ property_id: string }>(
    `UPDATE utility_meters
        SET out_of_service = FALSE, out_of_service_since = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING property_id`, [a.meterId])).rows[0]
  if (!meter) throw new Error(`markMeterRepaired: meter ${a.meterId} not found`)
  // Written only when confirmed, so the "Repaired" path never touches the column.
  if (a.zeroUseConfirmed === true) await recordZeroUseConfirmation(client, a.meterId, a.userId)
  // The fresh starting point, dated today at the property.
  await client.query(`
    INSERT INTO utility_meter_readings
      (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
    SELECT $1, (NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, $2,
           date_trunc('month', NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date,
           'meter_replaced', $3
      FROM properties p WHERE p.id = $4`,
    [a.meterId, a.startingReading, a.userId, meter.property_id])
}

/**
 * "Works, tenant uses no power" (10/12, Nic, M1): the meter was flagged broken
 * because it read the same number twice on an occupied space, but it works —
 * the household on it uses nothing. Back in service with the zero-use
 * confirmation recorded, so a flat read bills $0 and is not flagged or
 * estimated again until the meter moves (or the household leaves, or somebody
 * marks it broken by hand). No reading is written: nothing was replaced.
 * On a meter already in service it only records the confirmation.
 */
export async function markMeterWorksNoUse(client: PoolClient, a: {
  meterId: string
  /** Who confirmed it (the landlord or staff member). */
  userId: string
}): Promise<void> {
  const meter = (await client.query(
    `UPDATE utility_meters
        SET out_of_service = FALSE, out_of_service_since = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING id`, [a.meterId])).rows[0]
  if (!meter) throw new Error(`markMeterWorksNoUse: meter ${a.meterId} not found`)
  await recordZeroUseConfirmation(client, a.meterId, a.userId)
}

/** The confirmation and who made it, written together (cleared together too). */
async function recordZeroUseConfirmation(client: PoolClient, meterId: string, userId: string): Promise<void> {
  await client.query(
    `UPDATE utility_meters
        SET zero_use_confirmed_at = NOW(), zero_use_confirmed_by_user_id = $2, updated_at = NOW()
      WHERE id = $1`, [meterId, userId])
}

// ── 10/12 (Nic), Q-f: THE ESTIMATES BILLED WHILE IT WAS FLAGGED ──────────────
//
//   "past estimates when picking 'Works': LANDLORD'S CHOICE at that moment
//    (void unpaid estimated charges from the flagged period, or leave them)."
//
// A meter flagged broken at a property that estimates (Mountain View) billed an
// estimate every cycle it stayed flagged — the low end of what occupied
// neighbors used (allocation_method 'comparable_low'). "Works, tenant uses no
// power" says the meter was right all along, so those estimates charged for
// power nobody used. Whether they come off is the landlord's choice, asked in
// the same window as the choice itself: "Also void the N unpaid estimated
// charges from while it was flagged ($X)?"
//
// THE FLAGGED PERIOD is the meter's current flag: every estimate on the meter
// written since it last came back into service (flaggedPeriodStart). 10/12
// (review): it used to start at the day of the current flag
// (utility_meters.out_of_service_since), on the belief that the automatic flag
// and its estimate are written in the same run. Production says otherwise:
// RV 08's and RV 48's $22.47 estimates were written 9/30 and the meters were
// only flagged on 10/05 (the oct3 flag script), so for every meter flagged
// that way the window asked nothing and "Yes, void them" voided nothing. An
// earlier flag that ended with "Repaired" (or "Works") said what it said; its
// estimates stand. A meter that is not flagged has no flagged period, so there
// is nothing to ask.
//
// UNPAID means nobody has paid any of it:
//   - a line on a tenant's bill still owed ('pending' or 'failed') that no
//     record points at (services/chargeVoids chargeHeldByRecordSql: account
//     credit set against it, a bank deposit or receipt matched to it, ...);
//   - an estimate written but not on a bill yet (utility_bills 'unbilled');
//   - an estimate held for a lease not signed yet (suspended_utility_charges).
// Never touched: a paid line, one with money moving on it ('processing'), one
// a record points at, and one covered by work trade (parked under the month's
// hours: the month is priced over it, and re-pricing a month is the work-trade
// close's job — services/workTradeCoverage).
//
// VOID = SOFT (decisions #48.5, services/chargeVoids): the line is kept,
// status 'voided' with when and why, owed by nobody; its reading row is marked
// 'void' beside it (kept, with why) and so keeps its cycle's slot — a re-run of
// that cycle never bills it again; the bill's total and utilities subtotal drop
// by the line, and its status follows what is left on it. A held share is
// closed out (cancelled, kept, with why), as every other held share that is
// not billed.

/** One estimate from the meter's flagged period that is still unpaid (above). */
export interface FlaggedEstimate {
  /** utility_bills id, or suspended_utility_charges id when held. */
  id: string
  /** on_bill: a line on a tenant's bill; not_yet_billed: waiting for the next bill; held: waiting for a lease to be signed. */
  state: 'on_bill' | 'not_yet_billed' | 'held'
  /** 'YYYY-MM-01': the cycle it estimated. */
  cycleMonth: string
  /** What the tenant is (or would be) billed for it. */
  amount: number
  paymentId: string | null
  invoiceId: string | null
  invoiceNumber: string | null
  tenantId: string | null
  landlordId: string
}

type Q = (text: string, params?: any[]) => Promise<{ rows: any[] }>

/**
 * The SQL behind both the question and the void, so the window can never show
 * one set and the void take off another. $1 the meter, $2 when its flagged
 * period started (flaggedPeriodStart: written after it); $3/$4 narrow it to
 * one household (NULL = every one).
 */
const FLAGGED_ESTIMATES_SQL = `
  SELECT ub.id, CASE WHEN ub.payment_id IS NULL THEN 'not_yet_billed' ELSE 'on_bill' END AS state,
         to_char(ub.billing_cycle_month, 'YYYY-MM-DD') AS cycle_month,
         COALESCE(p.amount, ub.charge_amount + ub.tax_amount)::text AS amount,
         ub.payment_id, p.invoice_id, inv.invoice_number,
         COALESCE(p.tenant_id, ub.tenant_id) AS tenant_id, ub.landlord_id
    FROM utility_bills ub
    LEFT JOIN payments p ON p.id = ub.payment_id
    LEFT JOIN invoices inv ON inv.id = p.invoice_id
   WHERE ub.meter_id = $1
     AND ub.allocation_method = 'comparable_low'
     AND ub.created_at > $2::timestamptz
     AND ($3::uuid IS NULL OR COALESCE(p.tenant_id, ub.tenant_id) = $3::uuid)
     AND ($4::uuid IS NULL OR ub.landlord_id = $4::uuid)
     AND ((ub.payment_id IS NULL AND ub.status = 'unbilled')
          OR (ub.status = 'billed' AND p.status IN ('pending', 'failed')
              AND p.work_trade_suspended_at IS NULL
              AND NOT ${chargeHeldByRecordSql('p')}))
     AND COALESCE(p.amount, ub.charge_amount + ub.tax_amount) > 0
  UNION ALL
  SELECT sc.id, 'held', to_char(sc.billing_cycle_month, 'YYYY-MM-DD'),
         (sc.charge_amount + COALESCE(sc.tax_amount, 0))::text,
         NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, sc.landlord_id
    FROM suspended_utility_charges sc
   WHERE sc.meter_id = $1
     AND sc.allocation_method = 'comparable_low'
     AND sc.created_at > $2::timestamptz
     AND $3::uuid IS NULL AND ($4::uuid IS NULL OR sc.landlord_id = $4::uuid)
     AND sc.released_at IS NULL AND sc.cancelled_at IS NULL
     AND sc.charge_amount + COALESCE(sc.tax_amount, 0) > 0
   ORDER BY 3, 1`

const toEstimate = (r: any): FlaggedEstimate => ({
  id: r.id, state: r.state, cycleMonth: r.cycle_month, amount: Number(r.amount),
  paymentId: r.payment_id ?? null, invoiceId: r.invoice_id ?? null, invoiceNumber: r.invoice_number ?? null,
  tenantId: r.tenant_id ?? null, landlordId: r.landlord_id,
})

/**
 * When the meter's flagged period started: the last time it came back into
 * service — put back by hand ("Repaired", "Works, tenant uses no power", or the
 * broken mark taken off: the change journal's out_of_service true → false), or
 * a replacement read written ('meter_replaced', the record a repair left
 * before the journal covered meters) — or the beginning of its history when
 * it never has. NULL: the meter is not flagged, so it has no flagged period.
 * Read BEFORE the meter is put back in service (that write is the next "came
 * back"). A timestamp as text ('-infinity' when it never came back), passed
 * back as $2 of FLAGGED_ESTIMATES_SQL.
 */
export async function flaggedPeriodStart(q: Q, meterId: string): Promise<string | null> {
  const m = (await q(
    `SELECT COALESCE(GREATEST(
              (SELECT MAX(a.changed_at) FROM audit_row_changes a
                WHERE a.table_name = 'utility_meters' AND a.row_id = m.id
                  AND COALESCE((a.old_row->>'out_of_service')::boolean, FALSE)
                  AND NOT COALESCE((a.new_row->>'out_of_service')::boolean, FALSE)),
              (SELECT MAX(r.created_at) FROM utility_meter_readings r
                WHERE r.meter_id = m.id AND r.reason = 'meter_replaced')),
            '-infinity'::timestamptz)::text AS since
       FROM utility_meters m
      WHERE m.id = $1 AND m.out_of_service = TRUE`, [meterId])).rows[0]
  return m?.since ?? null
}

/**
 * The unpaid estimates from the meter's flagged period (see above). `from` is
 * when that period started (flaggedPeriodStart, read before the meter went
 * back in service); left out, it is read now — none when the meter is not
 * flagged.
 */
export async function flaggedPeriodEstimates(q: Q, meterId: string, from?: string | null): Promise<FlaggedEstimate[]> {
  const start = from === undefined ? await flaggedPeriodStart(q, meterId) : from
  if (!start) return []
  return (await q(FLAGGED_ESTIMATES_SQL, [meterId, start, null, null])).rows.map(toEstimate)
}

/** A count and its dollars. */
export interface CountAmount { count: number; amount: number }

/** What voidFlaggedPeriodEstimates took off, and what it found it could not. */
export interface FlaggedEstimatesVoided {
  voided: CountAmount
  /** Shown in the window, not voided (all of the reasons below together). */
  kept: CountAmount
  /**
   * 10/12 (review): why each was kept, so the landlord is told the truth —
   *   paid          a payment reached it (paid, or money moving on it) in the meantime;
   *   heldByRecord  a record points at it (account credit, a bank match, a receipt...): it is never voided;
   *   failed        the void could not be saved (logged) — nothing about it changed; try again;
   *   changed       it is no longer an unpaid estimate for another reason (already taken off, moved onto a bill).
   */
  keptBy: { paid: CountAmount; heldByRecord: CountAmount; failed: CountAmount; changed: CountAmount }
}

const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => Math.round(c) / 100

/** A bill a void left with nothing live on it (10/12, review). */
const EMPTIED_BILL_NOTE =
  'Voided: its only charge was an estimate taken off after the landlord confirmed the meter was working while it was flagged broken'

/**
 * The landlord chose to void them (above). Runs after the meter is back in
 * service, each household in its own transaction under its lock (one household
 * per transaction — services/moneyPredicates lockHousehold), re-reading its
 * estimates under that lock, so a payment that landed in the meantime is never
 * voided. `from` is when the flagged period started, read before the meter was
 * put back in service.
 *
 * 10/12 (review): only what the window SHOWED is voided — `shownIds`, the ids
 * the landlord was asked about. The list is read again here, so without them an
 * estimate written between the question and the answer (the monthly run) was
 * voided without the landlord ever seeing it.
 */
export async function voidFlaggedPeriodEstimates(a: {
  meterId: string; from: string; utilityType: string; shownIds: readonly string[]
}): Promise<FlaggedEstimatesVoided> {
  const reason = `Estimate taken off: the landlord confirmed the meter was working while it was flagged broken `
    + `("${meterWorksNoUseLabel(a.utilityType)}")`
  const billNote = 'Voided: an estimate — the landlord confirmed the meter was working while it was flagged broken'
  const shown = new Set(a.shownIds)

  const now = await (async () => {
    const c = await getClient()
    try { return await flaggedPeriodEstimates((t, p) => c.query(t, p), a.meterId, a.from) } finally { c.release() }
  })()
  // What was shown and is still an unpaid estimate of the flagged period.
  const asked = now.filter(e => shown.has(e.id))
  const voidedIds = new Set<string>()
  const failedIds = new Set<string>()
  let voidedC = 0

  // Not in a household (held for a lease not signed yet; written for nobody,
  // not on a bill): closed out on their own, outside any household's lock.
  const loose = asked.filter(e => e.state === 'held' || (e.state === 'not_yet_billed' && !e.tenantId))
  if (loose.length) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const held = (await c.query(
        `UPDATE suspended_utility_charges
            SET cancelled_at = NOW(), cancelled_reason = $3, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND meter_id = $2
            AND released_at IS NULL AND cancelled_at IS NULL
          RETURNING id, (charge_amount + COALESCE(tax_amount, 0))::text AS amount`,
        [loose.filter(e => e.state === 'held').map(e => e.id), a.meterId, reason])).rows
      const unbilled = (await c.query(
        `UPDATE utility_bills SET status = 'void', notes = COALESCE(notes || ' — ', '') || $3, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND meter_id = $2 AND status = 'unbilled' AND payment_id IS NULL
          RETURNING id, (charge_amount + tax_amount)::text AS amount`,
        [loose.filter(e => e.state === 'not_yet_billed').map(e => e.id), a.meterId, billNote])).rows
      await c.query('COMMIT')
      for (const r of [...held, ...unbilled]) { voidedIds.add(r.id); voidedC += cents(Number(r.amount)) }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      loose.forEach(x => failedIds.add(x.id))
      logger.error({ err: e, meterId: a.meterId }, '[meter] could not close out estimates outside a household — kept')
    } finally { c.release() }
  }

  const households = new Map<string, { tenantId: string; landlordId: string }>()
  for (const e of asked) {
    if (loose.includes(e) || !e.tenantId) continue
    households.set(`${e.tenantId}:${e.landlordId}`, { tenantId: e.tenantId, landlordId: e.landlordId })
  }
  for (const h of households.values()) {
    const c = await getClient()
    const q: Q = (t, p) => c.query(t, p)
    const theirs = asked.filter(e => !loose.includes(e) && e.tenantId === h.tenantId && e.landlordId === h.landlordId)
    try {
      await c.query('BEGIN')
      await lockHousehold(c, h.tenantId, h.landlordId)
      // Re-read under the lock: only what is still unpaid now, and only what was shown.
      const mine = (await q(FLAGGED_ESTIMATES_SQL, [a.meterId, a.from, h.tenantId, h.landlordId])).rows
        .map(toEstimate).filter(e => shown.has(e.id))
      const lineOf = new Map(mine.filter(e => e.state === 'on_bill' && e.paymentId).map(e => [e.paymentId!, e.id]))
      // Lines on a bill: voided the one way the platform voids a charge.
      const { voided } = await voidUnowedCharges(q, [...lineOf.keys()], reason)
      const byInvoice = new Map<string, number>()
      const done: Array<{ id: string; c: number }> = []
      for (const v of voided) {
        await q(
          `UPDATE utility_bills SET status = 'void', notes = COALESCE(notes || ' — ', '') || $2, updated_at = NOW()
            WHERE payment_id = $1 AND meter_id = $3 AND status = 'billed'`, [v.id, billNote, a.meterId])
        if (v.invoiceId) byInvoice.set(v.invoiceId, (byInvoice.get(v.invoiceId) ?? 0) + cents(v.amount))
        const ubId = lineOf.get(v.id)
        if (ubId) done.push({ id: ubId, c: cents(v.amount) })
      }
      // The bill drops by what came off it, and its status follows what is left.
      for (const [invoiceId, offC] of byInvoice) {
        await q(
          `UPDATE invoices
              SET total_amount = GREATEST(0, total_amount - $2::numeric),
                  subtotal_utilities = GREATEST(0, subtotal_utilities - $2::numeric),
                  updated_at = NOW()
            WHERE id = $1`, [invoiceId, dollars(offC).toFixed(2)])
        await q(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [invoiceId])
        // 10/12 (review): a bill the estimate was the only live line of (a final
        // utility bill, a utility-only service-agreement bill) is left with
        // nothing on it — the rollup reads such a bill 'pending', so it sat on
        // the tenant's and the landlord's lists at $0. It is voided the way a
        // bill a shortened stay emptied is (services/bookingLeaseBilling
        // voidEmptyStayBill, keep-everything): status 'void', $0, the reason in
        // its notes, its voided line kept on it, and a lease bill gives the
        // lease's due date back (lease_id → voided_from_lease_id, migration
        // 20261013235115). A bill anything else still carries is left as it is.
        await q(
          `UPDATE invoices i
              SET status = 'void', total_amount = 0, updated_at = NOW(),
                  voided_from_lease_id = COALESCE(i.voided_from_lease_id, i.lease_id), lease_id = NULL,
                  notes = LEFT(CONCAT_WS(E'\n', NULLIF(i.notes, ''), $2::text), 2000)
            WHERE i.id = $1 AND i.status <> 'void'
              AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'voided')`,
          [invoiceId, EMPTIED_BILL_NOTE])
      }
      // Written but not on a bill yet: never reaches one.
      const notYet = mine.filter(e => e.state === 'not_yet_billed')
      const unbilled = notYet.length ? (await q(
        `UPDATE utility_bills SET status = 'void', notes = COALESCE(notes || ' — ', '') || $3, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND meter_id = $2 AND status = 'unbilled' AND payment_id IS NULL
          RETURNING id, (charge_amount + tax_amount)::text AS amount`,
        [notYet.map(e => e.id), a.meterId, billNote])).rows : []
      for (const r of unbilled) done.push({ id: r.id, c: cents(Number(r.amount)) })
      await c.query('COMMIT')
      for (const d of done) { voidedIds.add(d.id); voidedC += d.c }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      theirs.forEach(x => failedIds.add(x.id))
      logger.error({ err: e, meterId: a.meterId, tenantId: h.tenantId },
        '[meter] could not void the flagged-period estimates for a household — kept')
    } finally { c.release() }
  }

  // Everything shown that did not come off, and why (read now, after the voids).
  const keptBy = { paid: { c: 0, n: 0 }, heldByRecord: { c: 0, n: 0 }, failed: { c: 0, n: 0 }, changed: { c: 0, n: 0 } }
  const notVoided = [...shown].filter(id => !voidedIds.has(id))
  if (notVoided.length) {
    const c = await getClient()
    try {
      const rows = (await c.query(
        `SELECT ub.id::text AS id, COALESCE(p.amount, ub.charge_amount + ub.tax_amount)::text AS amount,
                CASE WHEN p.id IS NOT NULL AND p.status IN ('pending', 'failed') AND ${chargeHeldByRecordSql('p')} THEN 'heldByRecord'
                     WHEN p.id IS NOT NULL AND p.status NOT IN ('pending', 'failed', 'voided') THEN 'paid'
                     ELSE 'changed' END AS why
           FROM utility_bills ub LEFT JOIN payments p ON p.id = ub.payment_id
          WHERE ub.id = ANY($1::uuid[]) AND ub.meter_id = $2
         UNION ALL
         SELECT sc.id::text, (sc.charge_amount + COALESCE(sc.tax_amount, 0))::text, 'changed'
           FROM suspended_utility_charges sc
          WHERE sc.id = ANY($1::uuid[]) AND sc.meter_id = $2`,
        [notVoided, a.meterId])).rows as Array<{ id: string; amount: string; why: 'paid' | 'heldByRecord' | 'changed' }>
      for (const r of rows) {
        const k = failedIds.has(r.id) ? 'failed' : r.why
        keptBy[k].n++
        keptBy[k].c += cents(Number(r.amount))
      }
    } finally { c.release() }
  }
  const ca = (x: { c: number; n: number }): CountAmount => ({ count: x.n, amount: dollars(x.c) })
  const keptN = keptBy.paid.n + keptBy.heldByRecord.n + keptBy.failed.n + keptBy.changed.n
  const keptC = keptBy.paid.c + keptBy.heldByRecord.c + keptBy.failed.c + keptBy.changed.c
  return {
    voided: { count: voidedIds.size, amount: dollars(voidedC) },
    kept: { count: keptN, amount: dollars(keptC) },
    keptBy: { paid: ca(keptBy.paid), heldByRecord: ca(keptBy.heldByRecord), failed: ca(keptBy.failed), changed: ca(keptBy.changed) },
  }
}
