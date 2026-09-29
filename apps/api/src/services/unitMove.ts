/**
 * S641 — move a resident to a different space without ending their tenancy.
 *
 * Nic: "Moving sites at an RV park is very common, especially when somebody
 * with a nice shade tree leaves and somebody else wants to take that spot. I
 * don't wanna have to terminate their lease, send them a new lease for the new
 * spot, etcetera. I want to just be able to move them in the system and say, as
 * of this date, they moved from this spot to this spot, have it coordinate
 * utilities for both."
 *
 * And the case the park forces: "maybe a site breaks, electricity goes down,
 * we're gonna have to dig it up and put a new pedestal in."
 *
 * The tenancy is untouched — same lease, same rent, same terms, same signatures.
 * What changes is which space it occupies, and from when. `lease_unit_history`
 * keeps the periods, so a bill can ask which meter was theirs on a given day
 * rather than assuming the space they are in today is the space they have
 * always been in.
 */
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { createNotification } from './notifications'

export interface MoveResult {
  leaseId: string
  fromUnitId: string
  toUnitId: string
  movedOn: string
  /** Meters closed on the old space, so its usage stops on the move date. */
  closingReadsNeeded: Array<{ meterId: string; label: string; utilityType: string }>
  /** Meters opened on the new space, so its usage starts on the move date. */
  openingReadsNeeded: Array<{ meterId: string; label: string; utilityType: string }>
}

/**
 * The meters that need a reading on the move date.
 *
 * A move is a departure from one space and an arrival at another on the same
 * day, so it needs exactly what a turnover needs — a closing number on the old
 * meter and an opening number on the new one. Without both, the month's usage
 * has no seam and the resident is billed one blended figure for two spaces.
 *
 * Broken meters are excluded: they bill from a comparable and there is nothing
 * to read.
 */
export async function metersFor(unitId: string) {
  // S652 (Nic): "there's no table anywhere to view a full history of the
  // reads… it'd be nice to have that pop up as a quick reference for both of
  // these spots. That way, if nobody was actually in the spot, I don't have to
  // walk out there." The newest reading on file rides along with each meter.
  return query<{ meter_id: string; label: string; utility_type: string; digits: number;
                 last_value: string | null; last_date: string | null; last_reason: string | null }>(`
    SELECT m.id AS meter_id, m.label, m.utility_type, m.digits,
           lr.reading_value::text AS last_value,
           to_char(lr.reading_date, 'YYYY-MM-DD') AS last_date,
           lr.reason AS last_reason
      FROM utility_meter_units mu
      JOIN utility_meters m ON m.id = mu.meter_id
      LEFT JOIN LATERAL (
        SELECT r.reading_value, r.reading_date, r.reason FROM utility_meter_readings r
         WHERE r.meter_id = m.id ORDER BY r.reading_date DESC, r.created_at DESC LIMIT 1) lr ON TRUE
     WHERE mu.unit_id = $1
       AND m.billing_method = 'submeter'
       AND COALESCE(m.out_of_service, FALSE) = FALSE
     ORDER BY m.utility_type`, [unitId])
}

export async function moveLeaseToUnit(params: {
  leaseId: string
  toUnitId: string
  movedOn: string          // YYYY-MM-DD
  reason?: string | null
  actorUserId?: string | null
  // S652 (Nic): "it needs to happen at the time of move." One reading per
  // submeter on the space they leave and the space they take, or no move.
  reads?: Array<{ meterId: string; value: number }>
}): Promise<MoveResult> {
  const lease = await queryOne<any>(
    `SELECT l.id, l.unit_id, l.landlord_id, l.status,
            to_char(l.start_date,'YYYY-MM-DD') AS start_date,
            to_char(l.end_date,'YYYY-MM-DD')   AS end_date
       FROM leases l WHERE l.id = $1`, [params.leaseId])
  if (!lease) throw new AppError(404, 'Lease not found')
  if (lease.unit_id === params.toUnitId) {
    throw new AppError(409, 'They are already in that space.')
  }
  if (!['active', 'pending'].includes(lease.status)) {
    throw new AppError(409, `This lease is ${lease.status} — only a live tenancy can be moved.`)
  }
  if (params.movedOn < lease.start_date) {
    throw new AppError(409, 'The move date is before the tenancy started.')
  }
  if (lease.end_date && params.movedOn > lease.end_date) {
    throw new AppError(409, 'The move date is after the tenancy ended.')
  }

  const dest = await queryOne<any>(
    `SELECT u.id, u.unit_number, u.status, u.landlord_id, u.property_id
       FROM units u WHERE u.id = $1`, [params.toUnitId])
  if (!dest) throw new AppError(404, 'That space does not exist.')
  if (dest.landlord_id !== lease.landlord_id) {
    throw new AppError(403, 'That space belongs to a different company.')
  }

  // The destination must actually be free on the move date. Somebody else's
  // tenancy overlapping it is the one mistake here that puts two households on
  // one space, and no amount of history repairs that.
  const clash = await queryOne<any>(`
    SELECT h.lease_id
      FROM lease_unit_history h
      JOIN leases l2 ON l2.id = h.lease_id
     WHERE h.unit_id = $1
       AND h.lease_id <> $2
       AND l2.status IN ('active','pending')
       AND (h.effective_to IS NULL OR h.effective_to > $3::date)
     LIMIT 1`, [params.toUnitId, params.leaseId, params.movedOn])
  if (clash) throw new AppError(409, `${dest.unit_number} is occupied on that date.`)

  const fromUnitId = lease.unit_id
  const closing = await metersFor(fromUnitId)
  const opening = await metersFor(params.toUnitId)

  // S652 (Nic): the readings are part of the move, not a chase afterwards.
  // Every submeter on either space needs its number before anything changes.
  const needed = [...closing.map(m => ({ ...m, kind: 'closing' as const })), ...opening.map(m => ({ ...m, kind: 'opening' as const }))]
  const given = new Map((params.reads ?? []).map(r => [r.meterId, r.value]))
  const missing = needed.filter(m => !given.has(m.meter_id))
  if (missing.length) {
    throw new AppError(409, `Enter the meter reading for ${missing.map(m => m.label).join(', ')} — a move records both spaces' meters as of the move date.`)
  }
  for (const m of needed) {
    const v = given.get(m.meter_id)!
    const digits = await queryOne<{ digits: number }>(`SELECT digits FROM utility_meters WHERE id = $1`, [m.meter_id])
    if (!Number.isInteger(v) || v < 0 || v >= 10 ** Number(digits?.digits ?? 6)) {
      throw new AppError(400, `${m.label}: reading exceeds this meter's ${digits?.digits ?? 6}-digit capacity`)
    }
  }

  // One statement so the trigger sees the move date and the unit change
  // together — a separate UPDATE would stamp today and silently misdate the
  // seam the whole feature exists to place.
  await query(
    `UPDATE leases SET unit_id = $2, unit_moved_on = $3::date, updated_at = now()
      WHERE id = $1`,
    [params.leaseId, params.toUnitId, params.movedOn])

  await query(
    `UPDATE lease_unit_history
        SET reason = $2, moved_by_user_id = $3
      WHERE lease_id = $1 AND effective_to IS NULL`,
    [params.leaseId, params.reason ?? null, params.actorUserId ?? null])

  // The old space is free again from the move date; the new one is taken.
  // Deliberately does NOT touch a space somebody else already occupies.
  await query(
    `UPDATE units SET status = 'vacant'
      WHERE id = $1 AND NOT EXISTS (
        SELECT 1 FROM leases l WHERE l.unit_id = $1 AND l.status IN ('active','pending'))`,
    [fromUnitId])
  await query(
    `UPDATE units SET status = 'active' WHERE id = $1 AND status IN ('vacant','available')`,
    [params.toUnitId])

  // S641 — CHASE THE READS, do not just list them.
  //
  // A list on a confirmation screen is gone the moment the screen closes, and
  // the reads are the difference between a bill with two honest lines and one
  // blended figure. So the move raises the same kind of prompt a pull-out does:
  // it reaches the landlord and anyone who can actually take a reading, it says
  // which meters and on what date, and it links to the meter screen.
  //
  // Fire-and-forget: a notification failing must never undo a move that already
  // happened, and the reads are still listed in the response either way.
  if (closing.length || opening.length) {
    void (async () => {
      try {
        const prop = await queryOne<{ property_id: string; property_name: string; landlord_id: string }>(
          `SELECT p.id AS property_id, p.name AS property_name, p.landlord_id
             FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
          [params.toUnitId])
        if (!prop) return

        const from = await queryOne<{ unit_number: string }>(
          `SELECT unit_number FROM units WHERE id = $1`, [fromUnitId])
        const who = await queryOne<{ name: string }>(
          `SELECT us.first_name || ' ' || us.last_name AS name
             FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
             JOIN users us ON us.id = t.user_id
            WHERE lt.lease_id = $1 AND lt.role = 'primary' LIMIT 1`, [params.leaseId])

        const body =
          `${who?.name ?? 'A resident'} moved from ${from?.unit_number ?? 'their space'} to `
          + `${dest.unit_number} on ${params.movedOn}. Read `
          + [
              closing.length ? `${closing.map(m => m.label).join(', ')} (closing)` : null,
              opening.length ? `${opening.map(m => m.label).join(', ')} (opening)` : null,
            ].filter(Boolean).join(' and ')
          + `. Both reads are dated the move — without them the month bills as one blended charge `
          + `instead of a line for each space.`

        const landlord = await queryOne<{ user_id: string; email: string }>(
          `SELECT l.user_id, u.email FROM landlords l JOIN users u ON u.id = l.user_id
            WHERE l.id = $1`, [prop.landlord_id])
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
          [prop.landlord_id, prop.property_id])

        const recipients = [
          ...(landlord ? [landlord] : []),
          ...staff.filter(s => s.user_id !== landlord?.user_id),
        ]
        for (const r of recipients) {
          await createNotification({
            userId: r.user_id, landlordId: prop.landlord_id,
            type: 'move_meter_reads_due',
            title: `Meter reads due — ${from?.unit_number ?? '?'} → ${dest.unit_number}`,
            body,
            data: {
              propertyId: prop.property_id,
              leaseId: params.leaseId,
              movedOn: params.movedOn,
              meters: [...closing, ...opening].map(m => m.label),
            },
            actionUrl: `/utilities?propertyId=${prop.property_id}`,
            sendEmail: true, emailTo: r.email,
            emailSubject: `Meter reads due — ${from?.unit_number ?? '?'} → ${dest.unit_number}`,
            emailHtml: body,
          })
        }
      } catch (e) {
        logger.error({ err: e, leaseId: params.leaseId }, '[unit-move] read prompt failed')
      }
    })()
  }

  // The readings, dated the move: the closing number seams the old space's
  // month, the opening number is the baseline the new space's next cycle
  // subtracts from.
  for (const m of needed) {
    await query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason, reason_note)
       VALUES ($1, $2, $3, date_trunc('month', $2::date)::date, $4, $5, $6)`,
      [m.meter_id, params.movedOn, given.get(m.meter_id), params.actorUserId ?? null,
       m.kind === 'opening' ? 'baseline' : 'other',
       m.kind === 'opening' ? `Opening read — resident moved in on ${params.movedOn}` : `Closing read — resident moved out on ${params.movedOn}`])
  }

  logger.info({
    leaseId: params.leaseId, fromUnitId, toUnitId: params.toUnitId,
    movedOn: params.movedOn, closing: closing.length, opening: opening.length, readsRecorded: needed.length,
  }, '[unit-move] resident moved spaces')

  return {
    leaseId: params.leaseId,
    fromUnitId,
    toUnitId: params.toUnitId,
    movedOn: params.movedOn,
    closingReadsNeeded: closing.map(m => ({ meterId: m.meter_id, label: m.label, utilityType: m.utility_type })),
    openingReadsNeeded: opening.map(m => ({ meterId: m.meter_id, label: m.label, utilityType: m.utility_type })),
  }
}

/**
 * Which spaces a lease occupied across a billing window, with the slice of the
 * window each one covers.
 *
 * A mid-month move returns TWO rows. That is what lets the bill read "Electric
 * — RV 12" and "Electric — RV 23" rather than one blended number nobody can
 * check. Nic: "I want them to see the electric from where they started and the
 * electric from where they went to."
 */
export async function leaseUnitsInWindow(leaseId: string, from: string, to: string) {
  return query<{ unit_id: string; from_date: string; to_date: string; unit_number: string }>(`
    SELECT w.unit_id,
           to_char(w.from_date,'YYYY-MM-DD') AS from_date,
           to_char(w.to_date,'YYYY-MM-DD')   AS to_date,
           -- the number the space carried during THAT slice, not today's
           COALESCE(unit_number_on(w.unit_id, w.from_date::timestamptz), u.unit_number) AS unit_number
      FROM lease_units_in_window($1, $2::date, $3::date) w
      JOIN units u ON u.id = w.unit_id
     ORDER BY w.from_date`, [leaseId, from, to])
}
