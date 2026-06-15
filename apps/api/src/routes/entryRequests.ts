import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import {
  emitEntryRequestResponseEvents,
  emitEntryRecordedEvents,
} from '../services/creditLedgerEmitters'
import {
  notifyEntryRequestNew,
  notifyEntryRequestResponded,
  notifyEntryRecorded,
} from '../services/notifications'
import { logger } from '../lib/logger'
import { checkAgainstStatute, type LawFlag } from '../services/stateLaw'

/**
 * S478: shared warning compute used by POST (at create time) and GET
 * (at read time, recomputed against the persisted row). Single source
 * of truth so the tenant and landlord see the same hedged factual
 * notices. Best-effort; returns safe defaults on any DB or engine
 * failure. NEVER throws.
 */
async function computeEntryRequestWarnings(args: {
  unitId: string
  startIso: string
  noticeWindowHours: number
}): Promise<{
  outsideTypicalHours: boolean
  typicalHoursWarning: string | null
  stateLawWarnings: LawFlag[]
}> {
  const fallback = {
    outsideTypicalHours: false,
    typicalHoursWarning: null,
    stateLawWarnings: [],
  }
  try {
    const tzRow = await queryOne<{ local_hour: number; timezone: string; state: string | null }>(
      `SELECT
         COALESCE(p.timezone, 'America/Phoenix') AS timezone,
         EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE
           COALESCE(p.timezone, 'America/Phoenix')))::int AS local_hour,
         p.state
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.id = $2`,
      [args.startIso, args.unitId])
    if (!tzRow) return fallback
    const localHour = tzRow.local_hour
    const outsideTypicalHours = localHour < 8 || localHour >= 20
    const typicalHoursWarning = outsideTypicalHours
      ? 'Outside typical daytime hours (8 AM–8 PM). Entry laws commonly require "reasonable times" — check your local law.'
      : null
    const stateLawWarnings: LawFlag[] = []
    if (tzRow.state) {
      try {
        const flag = await checkAgainstStatute(tzRow.state, 'entry_notice_hours', args.noticeWindowHours)
        if (flag) stateLawWarnings.push(flag)
      } catch (e) {
        logger.error({ err: e, state: tzRow.state }, '[stateLaw] entry_notice_hours check failed')
      }
    }
    return { outsideTypicalHours, typicalHoursWarning, stateLawWarnings }
  } catch (e) {
    logger.error({ err: e, unit_id: args.unitId }, '[entry-request-warnings] compute failed')
    return fallback
  }
}

// ============================================================
// /api/entry-requests — landlord-initiated unit entry workflow.
//
// Lifecycle:
//   1. POST /                  landlord creates request with reason +
//                              proposed entry window. Notice window
//                              is the gap between notice_given_at and
//                              proposed_entry_window_start; if it's
//                              less than landlord.default_entry_notice_hours,
//                              the request is created in 'pending' but
//                              the eventual record-entry will mark a
//                              breach unless circumstances change
//                              ('emergency' reason_category bypasses
//                              the notice window).
//
//   2. POST /:id/respond       tenant grants or denies. Granted before
//                              the proposed window starts → tenant
//                              scores entry_request_granted_within_window;
//                              denied is informational.
//
//   3. POST /:id/record-entry  landlord posts the actual entry moment
//                              (after the fact). Within window AND
//                              granted → proper_entry_notice_given
//                              landlord credit. Otherwise →
//                              entry_compliance_breach.
//
// Cancellation: landlord can POST /:id/cancel before record-entry.
// ============================================================

export const entryRequestsRouter = Router()
entryRequestsRouter.use(requireAuth)

const createSchema = z.object({
  unitId: z.string().uuid(),
  leaseId: z.string().uuid().optional(),
  tenantId: z.string().uuid(),
  reason: z.string().min(3),
  reasonCategory: z.enum(['maintenance', 'inspection', 'showing', 'emergency', 'other']),
  proposedEntryWindowStart: z.string(),
  proposedEntryWindowEnd: z.string(),
})

entryRequestsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const unit = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM units WHERE id=$1`,
      [body.unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    // S351: validate tenantId exists before the INSERT. Pre-S351 a
    // random/stale uuid produced a 500 with a raw postgres FK
    // violation message (unit_entry_requests_tenant_id_fkey). Surface
    // as a clean 404 so the landlord UI can show "tenant not found"
    // instead of "Internal Server Error".
    const tenantExists = await queryOne<{ id: string }>(
      `SELECT id FROM tenants WHERE id=$1`, [body.tenantId])
    if (!tenantExists) throw new AppError(404, 'Tenant not found')

    const noticeHoursRow = await queryOne<{ default_entry_notice_hours: number }>(
      `SELECT default_entry_notice_hours FROM landlords WHERE id=$1`,
      [unit.landlord_id],
    )
    const defaultNoticeHours = noticeHoursRow?.default_entry_notice_hours ?? 24

    const start = new Date(body.proposedEntryWindowStart)
    const end = new Date(body.proposedEntryWindowEnd)
    if (!(start.getTime() < end.getTime())) {
      throw new AppError(400, 'window end must be after window start')
    }
    const noticeWindowHours = Math.round((start.getTime() - Date.now()) / 3_600_000)

    // S475 + S476: outside-hours flag + state-law mismatch, all computed
    // by the shared helper so POST and GET return identical shapes.
    const warnings = await computeEntryRequestWarnings({
      unitId:            body.unitId,
      startIso:          start.toISOString(),
      noticeWindowHours,
    })

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO unit_entry_requests (
         unit_id, lease_id, tenant_id, landlord_id,
         requested_by_user_id, reason, reason_category,
         proposed_entry_window_start, proposed_entry_window_end,
         notice_window_hours
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        body.unitId,
        body.leaseId ?? null,
        body.tenantId,
        unit.landlord_id,
        req.user!.userId,
        body.reason,
        body.reasonCategory,
        start,
        end,
        noticeWindowHours,
      ],
    )

    // Notify tenant of the new request (best-effort).
    try {
      const t = await queryOne<any>(
        `SELECT u.id AS user_id, u.email, u.phone, un.unit_number
           FROM tenants t JOIN users u ON u.id = t.user_id
           LEFT JOIN units un ON un.id = $2
          WHERE t.id = $1`,
        [body.tenantId, body.unitId],
      )
      if (t?.user_id && t?.email) {
        await notifyEntryRequestNew({
          tenantUserId:       t.user_id,
          tenantEmail:        t.email,
          tenantPhone:        t.phone ?? undefined,
          requestId:          inserted!.id,
          reason:             body.reason,
          reasonCategory:     body.reasonCategory,
          windowStart:        start.toISOString(),
          windowEnd:          end.toISOString(),
          noticeWindowHours,
          unitNumber:         t.unit_number,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] entry-request create:')
    }

    res.json({
      success: true,
      data: {
        id: inserted!.id,
        notice_window_hours: noticeWindowHours,
        notice_window_meets_default: noticeWindowHours >= defaultNoticeHours,
        outside_typical_hours: warnings.outsideTypicalHours,
        typical_hours_warning: warnings.typicalHoursWarning,
        state_law_warnings: warnings.stateLawWarnings,
      },
    })
  } catch (e) {
    next(e)
  }
})

entryRequestsRouter.get('/:id', async (req, res, next) => {
  try {
    const r = await loadRequest(req.params.id, req)
    const resp = await queryOne<any>(
      `SELECT id, decision, responded_at, reason, evidence
         FROM unit_entry_request_responses
        WHERE request_id = $1`,
      [r.id],
    )
    // S478: recompute warnings against the persisted row so the tenant
    // (and any future re-read by the landlord) sees the same hedged
    // factual notices that were returned at create time. Persisting
    // the warnings would freeze them at create-time; recomputing keeps
    // them current as the law catalog refreshes.
    const warnings = await computeEntryRequestWarnings({
      unitId:            r.unit_id,
      startIso:          new Date(r.proposed_entry_window_start).toISOString(),
      noticeWindowHours: r.notice_window_hours,
    })
    res.json({
      success: true,
      data: {
        ...r,
        response: resp ?? null,
        outside_typical_hours: warnings.outsideTypicalHours,
        typical_hours_warning: warnings.typicalHoursWarning,
        state_law_warnings: warnings.stateLawWarnings,
      },
    })
  } catch (e) {
    next(e)
  }
})

entryRequestsRouter.get('/', async (req, res, next) => {
  try {
    const params: any[] = []
    let where = '1=1'
    if (req.query.unitId) {
      params.push(req.query.unitId)
      where += ` AND unit_id = $${params.length}`
    }
    if (req.query.tenantId) {
      params.push(req.query.tenantId)
      where += ` AND tenant_id = $${params.length}`
    }
    const rows = await query<any>(
      `SELECT id, unit_id, lease_id, tenant_id, landlord_id,
              reason, reason_category, status,
              notice_given_at, proposed_entry_window_start,
              proposed_entry_window_end, entry_actual_at, notice_window_hours,
              created_at
         FROM unit_entry_requests
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 200`,
      params,
    )
    const filtered = rows.filter((r) =>
      req.user!.role === 'tenant'
        ? r.tenant_id === req.user!.profileId
        : canAccessLandlordResource(req.user, r.landlord_id),
    )
    res.json({ success: true, data: filtered })
  } catch (e) {
    next(e)
  }
})

const respondSchema = z.object({
  decision: z.enum(['granted', 'denied']),
  reason: z.string().optional(),
})

entryRequestsRouter.post('/:id/respond', async (req, res, next) => {
  try {
    const body = respondSchema.parse(req.body)
    const r = await loadRequest(req.params.id, req)
    if (req.user!.role !== 'tenant' || req.user!.profileId !== r.tenant_id) {
      throw new AppError(403, 'Only the tenant can respond')
    }
    if (r.status !== 'pending') {
      throw new AppError(409, `cannot respond to request in status ${r.status}`)
    }

    const respondedAt = new Date()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO unit_entry_request_responses (
           request_id, responder_user_id, decision, reason
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id) DO UPDATE
           SET decision = EXCLUDED.decision,
               responded_at = NOW(),
               reason = EXCLUDED.reason`,
        [r.id, req.user!.userId, body.decision, body.reason ?? null],
      )
      const newStatus = body.decision === 'granted' ? 'granted' : 'denied'
      await client.query(
        `UPDATE unit_entry_requests SET status=$1, updated_at=NOW() WHERE id=$2`,
        [newStatus, r.id],
      )
      await emitEntryRequestResponseEvents(client, {
        tenantId: r.tenant_id,
        requestId: r.id,
        decision: body.decision,
        respondedAt,
        proposedWindowStart: new Date(r.proposed_entry_window_start),
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // Notify the responsible party of the tenant's response.
    // S186: routed through resolver — entry requests are day-to-day
    // tenant interactions, not owner-financial.
    try {
      const ctx = await queryOne<{
        property_id: string
        first_name: string | null
        last_name: string | null
        unit_number: string | null
      }>(
        `SELECT un.property_id,
                tu.first_name,
                tu.last_name,
                un.unit_number
           FROM units    un
           JOIN tenants  t  ON t.id = $1
           JOIN users    tu ON tu.id = t.user_id
          WHERE un.id = $2`,
        [r.tenant_id, r.unit_id],
      )
      if (ctx) {
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(ctx.property_id)
        if (targets) {
          for (const recipient of targets.primaries) {
            await notifyEntryRequestResponded({
              landlordUserId: recipient.user_id,
              landlordId:     r.landlord_id,
              landlordEmail:  recipient.email,
              requestId:      r.id,
              decision:       body.decision,
              tenantName:     ctx.first_name || ctx.last_name
                ? `${ctx.first_name ?? ''} ${ctx.last_name ?? ''}`.trim()
                : undefined,
              unitNumber:     ctx.unit_number ?? undefined,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] entry-request respond:')
    }

    res.json({ success: true, data: { decision: body.decision } })
  } catch (e) {
    next(e)
  }
})

const recordSchema = z.object({
  enteredAt: z.string(),
  notes: z.string().optional(),
})

entryRequestsRouter.post('/:id/record-entry', async (req, res, next) => {
  try {
    const body = recordSchema.parse(req.body)
    const r = await loadRequest(req.params.id, req)
    if (!canManageLandlordResource(req.user, r.landlord_id)) {
      throw new AppError(403, 'Only landlord can record entry')
    }
    if (r.status === 'completed' || r.status === 'breached' || r.status === 'cancelled') {
      throw new AppError(409, `entry already recorded (status ${r.status})`)
    }

    const enteredAt = new Date(body.enteredAt)
    const decision: 'granted' | 'denied' | null =
      r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : null

    const client = await getClient()
    let outcome: 'compliant' | 'breach' = 'breach'
    try {
      await client.query('BEGIN')
      const emitResult = await emitEntryRecordedEvents(client, {
        landlordId: r.landlord_id,
        requestId: r.id,
        enteredAt,
        proposedWindowStart: new Date(r.proposed_entry_window_start),
        proposedWindowEnd: new Date(r.proposed_entry_window_end),
        grantedDecision: decision,
      })
      outcome = emitResult.outcome
      const newStatus = outcome === 'compliant' ? 'completed' : 'breached'
      await client.query(
        `UPDATE unit_entry_requests
            SET status=$1, entry_actual_at=$2, notes=COALESCE($3, notes), updated_at=NOW()
          WHERE id=$4`,
        [newStatus, enteredAt, body.notes ?? null, r.id],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // Notify tenant the entry was recorded.
    try {
      const t = await queryOne<any>(
        `SELECT u.id AS user_id, u.email, un.unit_number
           FROM tenants t JOIN users u ON u.id = t.user_id
           LEFT JOIN units un ON un.id = $2
          WHERE t.id = $1`,
        [r.tenant_id, r.unit_id],
      )
      if (t?.user_id && t?.email) {
        await notifyEntryRecorded({
          tenantUserId: t.user_id,
          tenantEmail:  t.email,
          requestId:    r.id,
          outcome,
          enteredAt:    enteredAt.toISOString(),
          unitNumber:   t.unit_number,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] entry recorded:')
    }

    res.json({ success: true, data: { outcome } })
  } catch (e) {
    next(e)
  }
})

entryRequestsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const r = await loadRequest(req.params.id, req)
    if (!canManageLandlordResource(req.user, r.landlord_id)) {
      throw new AppError(403, 'Only landlord can cancel')
    }
    if (r.status === 'completed' || r.status === 'breached') {
      throw new AppError(409, 'request already finalized')
    }
    await query(
      `UPDATE unit_entry_requests SET status='cancelled', updated_at=NOW() WHERE id=$1`,
      [r.id],
    )
    res.json({ success: true })
  } catch (e) {
    next(e)
  }
})

interface EntryRequestRow {
  id: string
  unit_id: string
  lease_id: string | null
  tenant_id: string
  landlord_id: string
  reason: string
  reason_category: string
  status: string
  notice_given_at: string
  proposed_entry_window_start: string
  proposed_entry_window_end: string
  entry_actual_at: string | null
  notice_window_hours: number
  notes: string | null
  created_at: string
}

async function loadRequest(
  id: string,
  req: import('express').Request,
): Promise<EntryRequestRow> {
  const r = await queryOne<EntryRequestRow>(
    `SELECT id, unit_id, lease_id, tenant_id, landlord_id,
            reason, reason_category, status,
            notice_given_at, proposed_entry_window_start,
            proposed_entry_window_end, entry_actual_at,
            notice_window_hours, notes, created_at
       FROM unit_entry_requests
      WHERE id = $1`,
    [id],
  )
  if (!r) throw new AppError(404, 'Entry request not found')
  const u = req.user!
  if (u.role === 'tenant') {
    if (r.tenant_id !== u.profileId) throw new AppError(403, 'Not your entry request')
  } else if (
    u.role === 'landlord' ||
    u.role === 'property_manager' ||
    u.role === 'onsite_manager' ||
    u.role === 'maintenance'
  ) {
    if (!canAccessLandlordResource(u, r.landlord_id)) throw new AppError(403, 'Forbidden')
  } else if (u.role !== 'admin' && u.role !== 'super_admin') {
    throw new AppError(403, 'Forbidden')
  }
  return r
}
