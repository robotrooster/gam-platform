import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { assertPropertyInScope } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { mayScheduleAndTakePayments, SCHEDULE_AND_PAYMENT_LABELS } from '../lib/stayShortenedVoid'
import { loadConfirmationBooking, sendBookingConfirmation } from '../services/bookingConfirmation'
import {
  OFF_PLATFORM_DEPOSIT_METHODS, parseReservationCsv, recordReservationImportAttempt,
  runReservationImport, type ReservationImportRowInput,
} from '../services/reservationImport'
import { buildReservationTemplateCsv, parseMoney, reservationColumnsAccepted } from '../lib/reservationImportColumns'

// ============================================================
// Portfolio-wide bookings list. Companion to /api/units/:id/bookings
// (per-unit), this provides a flat queryable view with filters
// for the BookingsPage.
//
// Visibility: landlord/PM-scoped via canAccessLandlordResource.
// Owner roles see everything in their portfolio; team-roles see
// what their scope row allows.
// ============================================================

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth)

bookingsRouter.get('/', requirePerm('bookings.view'), async (req, res, next) => {
  try {
    const u = req.user!
    const role = u.role
    const filters: string[] = []
    const params: any[] = []

    // Landlord-scope. Owners read their own; admins read all.
    if (role !== 'admin' && role !== 'super_admin') {
      // S620: own + co-owned entities.
      const scope = role === 'landlord' ? landlordScopeIds(u) : (u.landlordId ? [u.landlordId] : [])
      if (!scope.length) throw new AppError(403, 'No landlord scope')
      params.push(scope)
      filters.push(`b.landlord_id = ANY($${params.length})`)
    }

    // Property-scope: a property-locked worker only sees reservations at
    // their assigned properties. NULL = unrestricted (owners/all_properties).
    const scopedIds = await getScopedPropertyIds(u)
    if (scopedIds !== null) {
      params.push(scopedIds)
      filters.push(`u.property_id = ANY($${params.length}::uuid[])`)
    }

    if (req.query.status) {
      params.push(req.query.status)
      filters.push(`b.status = $${params.length}`)
    }
    if (req.query.source) {
      params.push(req.query.source)
      filters.push(`b.source = $${params.length}`)
    }
    if (req.query.unitId) {
      params.push(req.query.unitId)
      filters.push(`b.unit_id = $${params.length}`)
    }
    if (req.query.from) {
      params.push(req.query.from)
      filters.push(`b.check_out >= $${params.length}`)
    }
    if (req.query.to) {
      params.push(req.query.to)
      filters.push(`b.check_in <= $${params.length}`)
    }
    if (req.query.q) {
      params.push(`%${(req.query.q as string).toLowerCase()}%`)
      filters.push(`(LOWER(b.guest_name) LIKE $${params.length} OR LOWER(b.guest_email) LIKE $${params.length})`)
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

    const rows = await query<any>(
      `SELECT b.id,
              b.unit_id,
              u.unit_number,
              u.unit_type,
              p.name AS property_name,
              p.requires_booking_acknowledgment,
              b.landlord_id,
              b.guest_name,
              b.guest_email,
              b.guest_phone,
              b.lease_type,
              b.check_in,
              b.check_out,
              b.nights,
              b.nightly_rate,
              b.weekly_rate,
              b.total_amount,
              b.platform_fee,
              b.status,
              b.source,
              b.notes,
              b.acknowledgment_signed_at,
              b.created_at
         FROM unit_bookings b
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
        ${where}
        ORDER BY b.check_in DESC
        LIMIT 500`,
      params,
    )

    // Defense-in-depth: drop any row whose landlord the requester
    // doesn't have scope to read (only matters for team roles
    // whose `landlord_id` claim may not match every booking).
    const filtered = rows.filter(r => canAccessLandlordResource(u, r.landlord_id))

    res.json({ success: true, data: filtered })
  } catch (e) {
    next(e)
  }
})

// ============================================================
// 10/20 (Nic) — SEND THIS GUEST THEIR CONFIRMATION.
//
//   "the confirmation actually says that they have a reservation on these
//    dates ... Have it display that as available to pay now. But I also want it
//    to not be required"
//
// THE ONE AND ONLY THING THAT SENDS A CONFIRMATION. There is no hook on
// booking creation, no job that sweeps for unsent confirmations, and there must
// never be one: reservations arrive here off an import from the old system and
// out of Nic's text threads (both of which deliberately send NOTHING), and a
// great many of those guests have already been told they are confirmed and may
// already have paid a deposit off-platform. A sweep would email every one of
// them. With real customers mid-migration an accidental blast is the worst
// outcome of this whole build, so the only trigger is a person pressing send,
// one guest at a time.
//
// WHO MAY PRESS IT: the same pair the schedule's "Ask for the deposit" button
// asks for (10/14, Nic: "anyone who can schedule reservations and take
// payments") — a reservation permission AND a way to take payments — because
// this email puts a payable deposit in front of a guest. One rule, read from
// lib/stayShortenedVoid, so a change to who counts as an owner reaches both.
// Asked here rather than behind a permission gate so that everybody short of
// the pair hears WHICH boxes they are missing instead of "Insufficient
// permissions".
//
// PRESSING IT TWICE DOES NOT EMAIL THE GUEST TWICE. A confirmation sent within
// the last hour is refused — that is a double click, or a second clerk on the
// same phone call. After the hour it goes again, because a guest who lost the
// email is a real thing and the figures are rebuilt from the reservation as it
// stands today, not from what was sent before.
const CONFIRMATION_REFUSAL =
  `Sending a guest their confirmation needs "${SCHEDULE_AND_PAYMENT_LABELS.create}" `
  + `or "${SCHEDULE_AND_PAYMENT_LABELS.edit}", together with `
  + `"${SCHEDULE_AND_PAYMENT_LABELS.record}" or "${SCHEDULE_AND_PAYMENT_LABELS.ring}" `
  + '— it offers the guest their deposit to pay. Ask someone who has both. Nothing was sent.'

const CONFIRMATION_PACE_MINUTES = 60

bookingsRouter.post('/:id/confirmation', async (req, res, next) => {
  try {
    const booking = await loadConfirmationBooking(req.params.id)
    if (!booking) throw new AppError(404, 'Reservation not found')
    if (!canManageLandlordResource(req.user, booking.landlord_id)) throw new AppError(403, 'Forbidden')
    await assertPropertyInScope(req.user, booking.property_id)
    if (!mayScheduleAndTakePayments(req.user)) throw new AppError(403, CONFIRMATION_REFUSAL)

    const guest = booking.guest_name || 'This guest'
    if (booking.confirmation_sent_at) {
      const minutesAgo = (Date.now() - new Date(booking.confirmation_sent_at).getTime()) / 60_000
      if (minutesAgo < CONFIRMATION_PACE_MINUTES) {
        throw new AppError(429,
          `${guest} was emailed their confirmation a few minutes ago. Give them a little time — `
          + 'you can send it again in an hour if they say it never arrived. Nothing was sent.')
      }
    }

    // ── 10/20 (Nic) — THEY HAVE ALREADY BEEN TOLD ───────────────────────────
    //
    //   "you have other people that I don't want to put any new people in the
    //    old system... they may have already paid a deposit. They may have
    //    already gotten a confirmation on a space number."
    //
    // A reservation brought in from the old system or off a text thread arrives
    // already confirmed — by Nic, personally, before GAM existed for that guest.
    // GAM confirming them a second time is a stranger emailing somebody about a
    // reservation they made in March, and on a 150-row season file it is 150 of
    // those. So the default for a migrated reservation is SKIP, and sending one
    // anyway is a deliberate second ask (`sendAnyway`) — which is a real thing:
    // a guest who has lost the old email and wants their dates in writing.
    const told = await queryOne<{ told_outside_gam: boolean }>(
      `SELECT told_outside_gam FROM unit_bookings WHERE id = $1`, [req.params.id])
    if (told?.told_outside_gam && req.body?.sendAnyway !== true) {
      throw new AppError(409,
        `${guest} was already told about this reservation outside GAM — in the old system, or by text — so GAM has `
        + 'not emailed them again. Send it anyway if they have asked for their dates in writing. Nothing was sent.')
    }

    const sent = await sendBookingConfirmation(booking, req.user!.userId)
    res.json({ success: true, data: sent })
  } catch (e) {
    next(e)
  }
})

// ============================================================
// Booking change requests (guest-agent track, S501).
// A booking guest's stay-change ask (late checkout / early check-in /
// extra night / other) is recorded by the request_booking_change agent
// tool into booking_change_requests as a draft — the agent never mutates
// the booking. This is the host's review surface: list the requests and
// approve/decline them. Approving is an acknowledgment, not an automatic
// booking edit (pricing/date changes stay a deliberate host action on the
// booking itself) — same draft-with-approval posture as the agent tool.
// ============================================================

// GET /api/bookings/change-requests — the host's review queue.
// Defaults to open ('requested') items; ?status=approved|declined|cancelled
// or ?status=all returns history.
bookingsRouter.get('/change-requests', requirePerm('bookings.change_requests', 'bookings.resolve_change_request'), async (req, res, next) => {
  try {
    const u = req.user!
    const role = u.role
    const filters: string[] = []
    const params: any[] = []

    if (role !== 'admin' && role !== 'super_admin') {
      // S620: own + co-owned entities.
      const scope = role === 'landlord' ? landlordScopeIds(u) : (u.landlordId ? [u.landlordId] : [])
      if (!scope.length) throw new AppError(403, 'No landlord scope')
      params.push(scope)
      filters.push(`cr.landlord_id = ANY($${params.length})`)
    }

    // Property-scope (see GET / above).
    const scopedIds = await getScopedPropertyIds(u)
    if (scopedIds !== null) {
      params.push(scopedIds)
      filters.push(`u.property_id = ANY($${params.length}::uuid[])`)
    }

    const status = typeof req.query.status === 'string' ? req.query.status : 'requested'
    if (status !== 'all') {
      params.push(status)
      filters.push(`cr.status = $${params.length}`)
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

    const rows = await query<any>(
      `SELECT cr.id,
              cr.booking_id,
              cr.landlord_id,
              cr.request_type,
              cr.details,
              cr.status,
              cr.resolved_at,
              cr.resolved_by_user_id,
              cr.created_at,
              COALESCE(NULLIF(TRIM(resolver.first_name || ' ' || resolver.last_name), ''), resolver.email) AS resolved_by_name,
              b.unit_id,
              b.guest_name,
              b.guest_email,
              b.check_in,
              b.check_out,
              b.status AS booking_status,
              u.unit_number,
              p.name AS property_name
         FROM booking_change_requests cr
         JOIN unit_bookings b ON b.id = cr.booking_id
         JOIN units u ON u.id = b.unit_id
         JOIN properties p ON p.id = u.property_id
    LEFT JOIN users resolver ON resolver.id = cr.resolved_by_user_id
        ${where}
        ORDER BY (cr.status = 'requested') DESC, cr.created_at DESC
        LIMIT 500`,
      params,
    )

    // Defense-in-depth: drop any row the requester can't read (team roles).
    const filtered = rows.filter(r => canAccessLandlordResource(u, r.landlord_id))

    res.json({ success: true, data: filtered })
  } catch (e) {
    next(e)
  }
})

// PATCH /api/bookings/change-requests/:id — approve or decline an open
// request. Only an open ('requested') row transitions; resolving twice is a
// no-op error. Stamps resolver + time. The guest has no account, so there's
// no guest notification — the host follows up with the guest directly (as the
// agent already told them it would).
bookingsRouter.patch('/change-requests/:id', requirePerm('bookings.resolve_change_request'), async (req, res, next) => {
  try {
    const u = req.user!
    const body = z.object({ status: z.enum(['approved', 'declined']) }).parse(req.body ?? {})

    const cr = await queryOne<{ id: string; landlord_id: string; status: string }>(
      `SELECT id, landlord_id, status FROM booking_change_requests WHERE id = $1`,
      [req.params.id],
    )
    if (!cr) throw new AppError(404, 'Change request not found')
    if (!canManageLandlordResource(u, cr.landlord_id)) throw new AppError(403, 'Forbidden')
    if (cr.status !== 'requested') {
      throw new AppError(409, `This request is already ${cr.status}.`)
    }

    const updated = await queryOne<any>(
      `UPDATE booking_change_requests
          SET status = $1, resolved_at = now(), resolved_by_user_id = $2
        WHERE id = $3 AND status = 'requested'
      RETURNING id, status, resolved_at, resolved_by_user_id`,
      [body.status, u.userId, req.params.id],
    )
    if (!updated) throw new AppError(409, 'This request was just resolved by someone else.')

    res.json({ success: true, data: updated })
  } catch (e) {
    next(e)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// 10/20 (Nic) — BRINGING IN THE RESERVATIONS THAT ALREADY EXIST
//
//   "I said import because I'm importing a fucking schedule for people that are
//    coming. I have other reservations that are texted to me. It's two
//    things... I do want a file importer. I do... The file importer gets all my
//    other reservations in there that were booked first. That's what I said.
//    The old system has all the ones that have already booked. The people that
//    have been texting me are the newer reservations. They don't get a spot if
//    there's no spot to put them. That's why the importer happens first, and
//    then the typed by hand ones come after."
//
// TWO DOORS, ONE PATH THROUGH THE SERVER.
//
//   door 'file' — the old system's export, dropped in whole. These booked
//                 first, so they go in first and take their spaces first.
//   door 'hand' — the newer ones out of Nic's text threads, typed in
//                 afterwards, into whatever is left.
//
// Hand-entry is deliberately NOT the ordinary reservation form (POST
// /api/units/:id/bookings). That form does all the right things for a
// reservation being taken now — it emails the guest their stay link, it asks
// lease-or-stay at 30 nights, it starts a background check at 22, it routes a
// deposit to a pay link — and every one of those is WRONG for a reservation
// that was made months ago somewhere else: the guest has already been told,
// may already have paid, and is not being screened today for a stay that was
// agreed in March. So both doors run through the import, which writes the row
// and does nothing else. That also means "the import sends nothing" is true of
// hand-entry by construction rather than by remembering.
//
// WHY VALIDATE AND COMMIT, AND NOT ONE BUTTON. Same contract as the three
// importers already here (properties, tenants, payment history): validate
// shows every row with its blockers and warnings, a person fixes what needs
// fixing, and the commit refuses while any blocker is left. A reservation
// collision is the one thing in this build that cannot be guessed at — two
// claims on one space is two rigs on one pad — so it is put in front of Nic as
// a row he has to look at.
// ════════════════════════════════════════════════════════════════════════════

/** A row, as the preview screen hands it back after a person has edited it. */
const importRowSchema = z.object({
  guestName:      z.string().max(200).optional().nullable(),
  email:          z.string().max(200).optional().nullable(),
  phone:          z.string().max(60).optional().nullable(),
  propertyName:   z.string().max(200).optional().nullable(),
  unitNumber:     z.string().max(60).optional().nullable(),
  checkIn:        z.string().max(40).optional().nullable(),
  checkOut:       z.string().max(40).optional().nullable(),
  nights:         z.union([z.string().max(10), z.number()]).optional().nullable(),
  totalAmount:    z.union([z.string().max(20), z.number()]).optional().nullable(),
  depositPaid:    z.union([z.string().max(20), z.number()]).optional().nullable(),
  depositMethod:  z.enum(OFF_PLATFORM_DEPOSIT_METHODS).optional().nullable(),
  depositRef:     z.string().max(120).optional().nullable(),
  externalRef:    z.string().max(120).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
  toldOutsideGam: z.boolean().optional().nullable(),
  // Columns the file carried that GAM has no field for. Kept, never acted on.
  extra:          z.record(z.any()).optional().nullable(),
})

const importBodySchema = z.object({
  propertyId: z.string().uuid(),
  door:       z.enum(['file', 'hand']),
  // The app's body parser (express.json, index.ts) takes 100 KB, so a bigger
  // file is refused before it reaches here — the screen says so and splits it.
  csv:        z.string().max(1_000_000).optional(),
  rows:       z.array(importRowSchema).max(1000).optional(),
  /** What software the file came out of, for the review queue. */
  claimedPlatformName: z.string().max(120).optional().nullable(),
})

/**
 * Writing down a deposit that was paid somewhere GAM was not is recording
 * money, so it takes the same pair the desk's own cash window takes — a
 * reservation permission AND a way to take payments (lib/stayShortenedVoid, the
 * one rule). Asked by name rather than behind a permission gate so somebody
 * short of it hears which boxes they are missing.
 */
const DEPOSIT_RECORDING_REFUSAL =
  `Writing down a deposit that was paid outside GAM needs "${SCHEDULE_AND_PAYMENT_LABELS.create}" `
  + `or "${SCHEDULE_AND_PAYMENT_LABELS.edit}", together with "${SCHEDULE_AND_PAYMENT_LABELS.record}" or `
  + `"${SCHEDULE_AND_PAYMENT_LABELS.ring}" — it is money changing hands. Bring the reservations in without the `
  + 'deposits, or ask someone who has both. Nothing was brought in.'

async function importInput(req: any): Promise<{
  landlordId: string
  propertyId: string
  door: 'file' | 'hand'
  rows: ReservationImportRowInput[]
  fileShape: { headers: string[]; sampleRows: Record<string, any>[] } | null
  claimedPlatformName: string | null
}> {
  const body = importBodySchema.parse(req.body ?? {})
  if (!body.csv && !body.rows?.length) {
    throw new AppError(400, 'Send either a file or some reservations.')
  }
  // S633: these rows land in ONE named company — the one that owns the park
  // they are going to, DERIVED from the property rather than from whichever
  // company the session happens to be sitting on. That is the mistake S633
  // exists to stop: filing Mountain View's arrivals into Oak Park's books on a
  // single wrong click.
  //
  // Authorized the way the schedule beside it is, not the way the other three
  // importers are: those read lib/landlordScope landlordForRequest, which
  // allows the OWNER only, and hand-entry is a front-desk act. A worker who may
  // create reservations at this park may type in the ones that came by text.
  const owner = await queryOne<{ landlord_id: string }>(
    `SELECT landlord_id FROM properties WHERE id = $1`, [body.propertyId])
  if (!owner) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(req.user, owner.landlord_id)) {
    throw new AppError(403, 'That park is not yours to act on.')
  }
  await assertPropertyInScope(req.user, body.propertyId)
  const landlordId = owner.landlord_id

  const parsed = body.csv ? parseReservationCsv(body.csv) : null
  const rows: ReservationImportRowInput[] = parsed
    ? parsed.rows
    : (body.rows ?? []) as ReservationImportRowInput[]
  const fileShape = parsed ? { headers: parsed.headers, sampleRows: parsed.raw } : null

  // The money check is on the ROWS, not the request: a file with no deposits in
  // it is not a payment, and a front-desk worker who may schedule should be able
  // to bring the schedule in.
  if (rows.some(r => (parseMoney(r.depositPaid) ?? 0) > 0) && !mayScheduleAndTakePayments(req.user)) {
    throw new AppError(403, DEPOSIT_RECORDING_REFUSAL)
  }

  return {
    landlordId, propertyId: body.propertyId, door: body.door, rows, fileShape,
    claimedPlatformName: body.claimedPlatformName?.trim() || null,
  }
}

// GET /api/bookings/import/template — GAM's own header row, plus every column
// name the importer recognises, for a landlord whose export calls things
// something we have not thought of.
bookingsRouter.get('/import/template', requirePerm('schedule.create_reservation'), (_req, res) => {
  res.json({
    success: true,
    data: { csv: buildReservationTemplateCsv(), columns: reservationColumnsAccepted() },
  })
})

// POST /api/bookings/import/validate — the preview. Writes nothing and sends
// nothing: the whole import runs inside a transaction that is rolled back, so
// the spaces it says it will put people on are the spaces it really picked,
// with the rows above them already on the board.
bookingsRouter.post('/import/validate', requirePerm('schedule.create_reservation'), async (req, res, next) => {
  try {
    const input = await importInput(req)
    const assessment = await runReservationImport({ ...input, byUserId: req.user!.userId, commit: false })
    if (input.fileShape) {
      await recordReservationImportAttempt({
        landlordId: input.landlordId,
        headers: input.fileShape.headers,
        sampleRows: input.fileShape.sampleRows,
        rowCount: assessment.summary.total,
        blockers: assessment.summary.blockers,
        warnings: assessment.summary.warnings,
        committed: false,
        claimedPlatformName: input.claimedPlatformName,
      })
    }
    res.json({ success: true, data: assessment })
  } catch (e) {
    next(e)
  }
})

// POST /api/bookings/import/commit — put them on the board. One transaction:
// either the whole batch lands or none of it does, because an import somebody
// believes is finished and is actually half-applied is worse than one that
// refused. Refuses while any row still carries a blocker.
bookingsRouter.post('/import/commit', requirePerm('schedule.create_reservation'), async (req, res, next) => {
  try {
    const input = await importInput(req)
    const assessment = await runReservationImport({ ...input, byUserId: req.user!.userId, commit: true })
    if (input.fileShape) {
      await recordReservationImportAttempt({
        landlordId: input.landlordId,
        headers: input.fileShape.headers,
        sampleRows: input.fileShape.sampleRows,
        rowCount: assessment.summary.total,
        blockers: 0,
        warnings: assessment.summary.warnings,
        committed: true,
        claimedPlatformName: input.claimedPlatformName,
      })
    }
    res.json({ success: true, data: assessment })
  } catch (e) {
    next(e)
  }
})
