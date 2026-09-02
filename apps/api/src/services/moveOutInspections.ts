// ============================================================
// S548 — move-out walkthrough scheduling (Nic).
//
// Dwellings + storage require a FINALIZED, IN-PERSON move-out inspection
// before the deposit return can begin (routes/leases.ts gate). This
// service creates the inspection the day the lease ends, deadlined at
// THREE BUSINESS DAYS after the end date, linked to the move-in
// inspection for side-by-side comparison, and prompts the landlord +
// the property's assigned staff. The tenant-guided (agent) flow is for
// periodic inspections — move-out is conducted in person by whoever is
// assigned to the property.
//
// rv_spot is exempt by design: its walkthrough is the pull-out meter
// read + same-day settlement (see promptMoveOutMeterReads).
// ============================================================
import { MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'
import { insertInspectionWithChecklist } from './inspections'
import { US_FEDERAL_HOLIDAYS } from '../jobs/autoPayouts'

/** date + n business days (skips weekends + US federal holidays). */
export function addBusinessDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T12:00:00Z')
  let added = 0
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    const iso = d.toISOString().slice(0, 10)
    if (dow === 0 || dow === 6 || US_FEDERAL_HOLIDAYS.has(iso)) continue
    added++
  }
  return d.toISOString().slice(0, 10)
}

/** date − n business days (skips weekends + US federal holidays). */
export function subtractBusinessDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T12:00:00Z')
  let subbed = 0
  while (subbed < n) {
    d.setUTCDate(d.getUTCDate() - 1)
    const dow = d.getUTCDay()
    const iso = d.toISOString().slice(0, 10)
    if (dow === 0 || dow === 6 || US_FEDERAL_HOLIDAYS.has(iso)) continue
    subbed++
  }
  return d.toISOString().slice(0, 10)
}

/**
 * Daily (morning cron). The walkthrough happens WHILE the tenant moves out
 * (Nic): the window opens 3 business days BEFORE the lease end and the
 * inspection is due BY the end date. When a gated-unit-type lease enters
 * that window without a move_out inspection, create one (deadline =
 * end_date) and prompt the people who can do it. A short catchup also
 * covers leases that slipped past their end (short-notice terminations) —
 * those arrive already overdue. Idempotent per lease.
 */
export async function scheduleMoveOutInspections(): Promise<{ scheduled: number }> {
  const candidates = await query<any>(`
    SELECT l.id AS lease_id, l.unit_id, l.landlord_id,
           to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
           u.unit_number, u.unit_type, u.bedrooms, u.bathrooms, u.dwelling_ownership, u.is_multi_level, u.is_ada_accessible, u.living_areas, u.features, u.property_id,
           p.name AS property_name,
           (SELECT lt.tenant_id FROM lease_tenants lt
             WHERE lt.lease_id = l.id AND lt.role = 'primary' LIMIT 1) AS tenant_id
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
     WHERE l.end_date BETWEEN CURRENT_DATE - 2 AND CURRENT_DATE + 7
       AND l.status IN ('active', 'expired', 'terminated')
       AND u.unit_type = ANY($1)
       AND NOT EXISTS (
         SELECT 1 FROM unit_inspections i
          WHERE i.lease_id = l.id AND i.inspection_type = 'move_out'
            AND i.status <> 'cancelled')
     ORDER BY l.end_date`,
    [[...MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES]])

  // Coarse SQL window, precise business-day filter here: schedule once
  // today >= (end_date − 3 business days).
  //
  // S634 — "TODAY" MUST BE THE SAME DAY THE SQL MEANT.
  //
  // This read `new Date().toISOString()`, which is the UTC date, while the
  // window above is Postgres `CURRENT_DATE` — the server's local date. In
  // Phoenix (UTC−7) those disagree from 5pm every evening, so for seven hours a
  // night this filter believed it was tomorrow and scheduled move-out
  // inspections a day early, with a deadline computed off the wrong "today".
  // It surfaced as a suite that passed in the afternoon and failed after 5pm.
  //
  // Asking the database keeps the two halves of the same decision on one clock.
  const today = (await queryOne<{ d: string }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`))!.d
  const due = candidates.filter((l: any) => subtractBusinessDays(l.end_date, 3) <= today)

  let scheduled = 0
  for (const l of due) {
    const deadline = l.end_date
    // Link the move-in inspection so latch/carpet/wall comparisons are
    // side-by-side for the inspector and, later, the approving landlord.
    const moveIn = await queryOne<{ id: string }>(
      `SELECT id FROM unit_inspections
        WHERE lease_id = $1 AND inspection_type = 'move_in' AND status = 'finalized'
        ORDER BY finalized_at DESC LIMIT 1`, [l.lease_id])
    // S550: seed the standard checklist too (same shared path as every other
    // creation route) — the S548 raw INSERT left the inspector an empty list.
    const client = await getClient()
    let inspId: string
    try {
      await client.query('BEGIN')
      const { id } = await insertInspectionWithChecklist(client, {
        unitId: l.unit_id,
        landlordId: l.landlord_id,
        unitType: l.unit_type,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
        dwellingOwnership: l.dwelling_ownership,
        isMultiLevel: l.is_multi_level,
        isAdaAccessible: l.is_ada_accessible,
        livingAreas: l.living_areas,
        features: l.features,
        leaseId: l.lease_id,
        tenantId: l.tenant_id,
        inspectionType: 'move_out',
        comparisonInspectionId: moveIn?.id ?? null,
        scheduledFor: deadline,
        notes: 'In-person move-out walkthrough — required before the deposit return can begin.',
      })
      await client.query('COMMIT')
      inspId = id
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    const insp = { id: inspId }
    scheduled++

    // Landlord + property-assigned staff who can conduct inspections.
    const landlord = await queryOne<{ user_id: string; email: string }>(
      `SELECT lo.user_id, us.email FROM landlords lo JOIN users us ON us.id = lo.user_id
        WHERE lo.id = $1`, [l.landlord_id])
    const staff = await query<{ user_id: string; email: string }>(
      `SELECT DISTINCT u2.id AS user_id, u2.email FROM (
          SELECT user_id FROM property_manager_scopes
           WHERE landlord_id = $1 AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
          UNION
          SELECT user_id FROM onsite_manager_scopes
           WHERE landlord_id = $1 AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
        ) s JOIN users u2 ON u2.id = s.user_id`,
      [l.landlord_id, l.property_id])
    const recipients = [
      ...(landlord ? [landlord] : []),
      ...staff.filter(s => s.user_id !== landlord?.user_id),
    ]
    const overdue = l.end_date < today
    const body = overdue
      ? `Unit ${l.unit_number} at ${l.property_name} — the lease ended ${l.end_date} and the in-person ` +
        `move-out walkthrough is OVERDUE. Complete it with photos now; the deposit return cannot start until it's finalized.`
      : `Unit ${l.unit_number} at ${l.property_name} — tenant moves out by ${l.end_date}. ` +
        `Do the in-person walkthrough (with photos) WHILE they move out — due by ${deadline}. ` +
        `The deposit return cannot start until it's finalized.`
    for (const r of recipients) {
      await createNotification({
        userId: r.user_id, landlordId: l.landlord_id,
        type: 'moveout_inspection_due',
        title: `Move-out walkthrough due — unit ${l.unit_number}`,
        body,
        data: { inspectionId: insp!.id, leaseId: l.lease_id, unitId: l.unit_id, deadline },
        actionUrl: `/inspections/${insp!.id}`,
        sendEmail: true, emailTo: r.email,
        emailSubject: `Move-out walkthrough due by ${deadline} — unit ${l.unit_number}`,
        emailHtml: body,
      }).catch(err => logger.error({ err }, '[moveout-inspection] notify failed'))
    }
    logger.info({ leaseId: l.lease_id, inspectionId: insp!.id, deadline },
      '[moveout-inspection] scheduled with 3-business-day deadline')
  }
  return { scheduled }
}
