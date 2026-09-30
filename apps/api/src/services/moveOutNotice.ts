// S653 (Nic): "They're going to come in and say, hey, I'm pulling out Saturday
// with like maybe three or four days notice, if that. We need the front desk to
// be able to mark it as, hey, they're leaving then. When we get the final meter
// read, we can initiate the final bill cycle."
//
// The mark IS the lease's end_date. Nothing else was needed, because every
// consumer already honors an end date: the master schedule bar stops there, a
// reservation can be placed behind it (findStayConflict), the reads-due list
// asks for the final read that morning, the 2am lease-end job expires the lease
// and vacates the space, the final read cuts the closing utility invoice at
// once (billMoveOutRead → invoiceEndedLeaseBills), and the deposit-return draft
// is created. What the columns add is that it was a NOTICE — when, by whom,
// what they said, and what the end date was before — so a resident who changes
// their mind can be put back exactly as they were.
//
// It never touches a signed document. Nic: "I don't want it physically on the
// document. Nobody's going to know when they sign the document when they're
// leaving." And it records what the resident said, nothing more — there is no
// notice-period enforcement here (the lease and local law own that).
import { DateTime } from 'luxon'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export interface MoveOutNoticeLease {
  id: string
  landlord_id: string
  unit_id: string
  status: string
  start_date: string
  end_date: string | null
  move_out_notice_at: string | null
  move_out_notice_by: string | null
  move_out_notice_note: string | null
  move_out_notice_prev_end_date: string | null
  unit_number: string
  property_id: string
  property_name: string
  property_tz: string
}

export async function loadLeaseForNotice(leaseId: string): Promise<MoveOutNoticeLease | null> {
  return queryOne<MoveOutNoticeLease>(`
    SELECT l.id, l.landlord_id, l.unit_id, l.status,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
           l.move_out_notice_at, l.move_out_notice_by, l.move_out_notice_note,
           to_char(l.move_out_notice_prev_end_date, 'YYYY-MM-DD') AS move_out_notice_prev_end_date,
           COALESCE(u.display_label, u.unit_number) AS unit_number,
           p.id AS property_id, p.name AS property_name,
           COALESCE(p.timezone, 'America/Phoenix') AS property_tz
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
     WHERE l.id = $1`, [leaseId])
}

async function activeRoster(leaseId: string) {
  return query<{ user_id: string; email: string; first_name: string | null }>(`
    SELECT u.id AS user_id, u.email, u.first_name
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
     WHERE lt.lease_id = $1 AND lt.status = 'active'`, [leaseId])
}

function sayDate(iso: string, tz: string): string {
  return DateTime.fromISO(iso, { zone: tz }).toFormat('cccc, LLLL d')
}

/**
 * Record that the resident said they are leaving on `on`. The day is the
 * departure day (the space is theirs through the night before — same exclusive
 * convention as a reservation's check-out), so a same-day turnover works.
 */
export async function recordMoveOutNotice(opts: {
  leaseId: string
  on: string            // YYYY-MM-DD
  note?: string | null
  byUserId: string
}): Promise<MoveOutNoticeLease> {
  const lease = await loadLeaseForNotice(opts.leaseId)
  if (!lease) throw new AppError(404, 'Lease not found')
  if (lease.status !== 'active') throw new AppError(409, `That lease is ${lease.status}, not active`)

  const today = DateTime.now().setZone(lease.property_tz).toISODate()!
  if (opts.on < today) throw new AppError(400, 'The leaving date cannot be in the past — if they have already gone, record it as today so the final read is asked for now')
  if (opts.on <= lease.start_date) throw new AppError(400, 'The leaving date has to be after the day they moved in')
  // A date PAST the signed end would extend the term with no document behind
  // it. Nic decided extensions are not automatic: "I'll just invite them if
  // that flow happens." A month-to-month lease (no end date) can be marked
  // for any day.
  const signedEnd = lease.move_out_notice_at ? lease.move_out_notice_prev_end_date : lease.end_date
  if (signedEnd && opts.on > signedEnd) {
    throw new AppError(409, `Their lease already ends ${sayDate(signedEnd, lease.property_tz)}. To stay past that, invite them to a new lease from the Tenants page.`)
  }

  // Re-marking keeps the ORIGINAL prior end date, so calling it off later
  // still restores what the lease said before anyone touched it.
  const prevEnd = lease.move_out_notice_at ? lease.move_out_notice_prev_end_date : lease.end_date
  const updated = await queryOne<any>(`
    UPDATE leases
       SET end_date = $2,
           auto_renew = FALSE, auto_renew_mode = NULL,
           move_out_notice_at = NOW(),
           move_out_notice_by = $3,
           move_out_notice_note = $4,
           move_out_notice_prev_end_date = $5,
           updated_at = NOW()
     WHERE id = $1 AND status = 'active'
     RETURNING id`, [lease.id, opts.on, opts.byUserId, opts.note?.trim() || null, prevEnd])
  if (!updated) throw new AppError(409, 'That lease changed while you were typing — reload and try again')

  logger.info({ leaseId: lease.id, on: opts.on, by: opts.byUserId, prevEnd },
    '[move-out-notice] recorded')

  // Tell the resident what the desk wrote down, so a misheard day is caught
  // by the one person who knows the real one.
  try {
    const { createNotification } = await import('./notifications')
    const when = sayDate(opts.on, lease.property_tz)
    for (const r of await activeRoster(lease.id)) {
      await createNotification({
        userId: r.user_id,
        landlordId: lease.landlord_id,
        type: 'lease_move_out_notice',
        title: `Move-out on ${when} — ${lease.unit_number}`,
        body: `We have you down as leaving ${lease.property_name} (${lease.unit_number}) on ${when}. ` +
              `Your meters will be read that morning and any final utility charge sent right after; your deposit return follows. ` +
              `If that day is wrong, tell the office.`,
        data: { leaseId: lease.id, endDate: opts.on },
        actionUrl: '/lease',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Move-out on ${when} — ${lease.property_name}`,
      })
    }
  } catch (err) {
    logger.error({ err, leaseId: lease.id }, '[move-out-notice] resident notice failed')
  }

  return (await loadLeaseForNotice(lease.id))!
}

/**
 * They changed their mind. Put the lease back to the end date it had before
 * the notice — unless somebody has already been booked into the gap.
 */
export async function cancelMoveOutNotice(opts: { leaseId: string; byUserId: string }): Promise<MoveOutNoticeLease> {
  const lease = await loadLeaseForNotice(opts.leaseId)
  if (!lease) throw new AppError(404, 'Lease not found')
  if (!lease.move_out_notice_at) throw new AppError(409, 'There is no leaving date on this lease to call off')
  if (lease.status !== 'active') throw new AppError(409, `That lease is ${lease.status} — the move-out already happened`)

  const restoreTo = lease.move_out_notice_prev_end_date  // null = month-to-month again
  const { findStayConflict } = await import('./unitAvailability')
  // The lease's own row cannot collide: its end_date equals the window's
  // check-in, and the rule is exclusive on the departure day.
  const conflict = await findStayConflict(lease.unit_id, { checkIn: lease.end_date!, checkOut: restoreTo })
  if (conflict) {
    const from = sayDate(lease.end_date!, lease.property_tz)
    const why = conflict === 'booking' ? `Somebody is already booked on ${lease.unit_number} from ${from}. Move that reservation first, or move this household to another space.`
      : conflict === 'pending_tenant' ? `A new resident is already being onboarded onto ${lease.unit_number}. Cancel that invite first, or move this household to another space.`
      : conflict === 'out_of_order' ? `${lease.unit_number} is scheduled out of order from ${from}. Clear that first, or move this household to another space.`
      : `${lease.unit_number} is not free from ${from}.`
    throw new AppError(409, why)
  }

  await query(`
    UPDATE leases
       SET end_date = $2,
           move_out_notice_at = NULL,
           move_out_notice_by = NULL,
           move_out_notice_note = NULL,
           move_out_notice_prev_end_date = NULL,
           updated_at = NOW()
     WHERE id = $1`, [lease.id, restoreTo])
  logger.info({ leaseId: lease.id, restoreTo, by: opts.byUserId }, '[move-out-notice] called off')

  try {
    const { createNotification } = await import('./notifications')
    for (const r of await activeRoster(lease.id)) {
      await createNotification({
        userId: r.user_id,
        landlordId: lease.landlord_id,
        type: 'lease_move_out_notice_cancelled',
        title: `Staying on — ${lease.unit_number}`,
        body: `Your move-out on ${sayDate(lease.end_date!, lease.property_tz)} has been called off. ` +
              (restoreTo ? `Your lease runs to ${sayDate(restoreTo, lease.property_tz)} as before.` : `You are month to month as before.`),
        data: { leaseId: lease.id },
        actionUrl: '/lease',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Staying on — ${lease.property_name}`,
      })
    }
  } catch (err) {
    logger.error({ err, leaseId: lease.id }, '[move-out-notice] cancel notice failed')
  }

  return (await loadLeaseForNotice(lease.id))!
}

/**
 * The desk's list: every household currently on a space at the properties this
 * person works, with any leaving date already on file. `q` narrows by name,
 * email, phone or space.
 */
export async function listResidentsForDesk(opts: {
  landlordIds: string[]
  propertyIds: string[] | null   // null = every property of those landlords
  q?: string
}) {
  const q = (opts.q ?? '').trim().toLowerCase()
  if (opts.landlordIds.length === 0) return []
  return query<any>(`
    SELECT l.id AS lease_id,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date,
           l.move_out_notice_at,
           l.move_out_notice_note,
           to_char(l.move_out_notice_prev_end_date, 'YYYY-MM-DD') AS move_out_notice_prev_end_date,
           COALESCE(u.display_label, u.unit_number) AS unit_number,
           p.id AS property_id, p.name AS property_name,
           (SELECT string_agg(trim(concat(tu.first_name, ' ', tu.last_name)), ', ' ORDER BY lt.role)
              FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
             WHERE lt.lease_id = l.id AND lt.status = 'active') AS names,
           (SELECT tu.email FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
             WHERE lt.lease_id = l.id AND lt.status = 'active' ORDER BY lt.role LIMIT 1) AS email,
           (SELECT tu.phone FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
             WHERE lt.lease_id = l.id AND lt.status = 'active' ORDER BY lt.role LIMIT 1) AS phone,
           (SELECT u2.first_name || ' ' || u2.last_name FROM users u2 WHERE u2.id = l.move_out_notice_by) AS marked_by
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
     WHERE l.status = 'active'
       AND l.landlord_id = ANY($1::uuid[])
       AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
       AND ($3 = '' OR EXISTS (
             SELECT 1 FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users tu ON tu.id = t.user_id
              WHERE lt.lease_id = l.id AND lt.status = 'active'
                AND (lower(concat(tu.first_name, ' ', tu.last_name)) LIKE '%' || $3 || '%'
                     OR lower(tu.email) LIKE '%' || $3 || '%'
                     OR COALESCE(tu.phone, '') LIKE '%' || $3 || '%'))
            OR lower(COALESCE(u.display_label, u.unit_number)) LIKE '%' || $3 || '%')
     ORDER BY (l.move_out_notice_at IS NOT NULL) DESC, l.end_date NULLS LAST, p.name, u.unit_number`,
    [opts.landlordIds, opts.propertyIds, q])
}
