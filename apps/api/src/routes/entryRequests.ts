import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
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
import { applyEntryRequestResponse } from '../services/entryRequestRespond'
import { humanize, MAINTENANCE_CATEGORY_LABEL } from '@gam/shared'
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

// S571: entry is anchored to exactly ONE of a maintenance call or a scheduled
// inspection. Unit / tenant / lease / reason all derive from that anchor — the
// landlord no longer types a free reason or picks the unit/tenant directly.
const createSchema = z.object({
  maintenanceRequestId: z.string().uuid().optional(),
  inspectionId:         z.string().uuid().optional(),
  proposedEntryWindowStart: z.string(),
  proposedEntryWindowEnd: z.string(),
}).refine(
  (b) => (!!b.maintenanceRequestId) !== (!!b.inspectionId),
  { message: 'Provide exactly one of a maintenance call or a scheduled inspection' },
)

entryRequestsRouter.post('/', requirePerm('entry_requests.create'), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)

    // Resolve the anchor → unit / tenant / lease / reason / category.
    let unitId: string, landlordId: string, reason: string
    let reasonCategory: 'maintenance' | 'inspection'
    let tenantId: string | null, leaseId: string | null = null
    let maintenanceRequestId: string | null = null, inspectionId: string | null = null

    if (body.maintenanceRequestId) {
      const mr = await queryOne<any>(
        `SELECT mr.id, mr.unit_id, mr.landlord_id, mr.tenant_id, mr.category, mr.title
           FROM maintenance_requests mr WHERE mr.id=$1`,
        [body.maintenanceRequestId])
      if (!mr) throw new AppError(404, 'Maintenance request not found')
      if (!canManageLandlordResource(req.user, mr.landlord_id)) throw new AppError(403, 'Forbidden')
      maintenanceRequestId = mr.id
      unitId = mr.unit_id; landlordId = mr.landlord_id; tenantId = mr.tenant_id ?? null
      reasonCategory = 'maintenance'
      reason = `Maintenance: ${(MAINTENANCE_CATEGORY_LABEL as any)[mr.category] || mr.title || 'repair'}`
    } else {
      const insp = await queryOne<any>(
        `SELECT id, unit_id, landlord_id, tenant_id, lease_id, inspection_type
           FROM unit_inspections WHERE id=$1`,
        [body.inspectionId])
      if (!insp) throw new AppError(404, 'Inspection not found')
      if (!canManageLandlordResource(req.user, insp.landlord_id)) throw new AppError(403, 'Forbidden')
      inspectionId = insp.id
      unitId = insp.unit_id; landlordId = insp.landlord_id
      tenantId = insp.tenant_id ?? null; leaseId = insp.lease_id ?? null
      reasonCategory = 'inspection'
      reason = `Inspection: ${humanize(insp.inspection_type)}`
    }

    // Fill any gaps from the unit's current occupancy / active lease.
    if (!tenantId || !leaseId) {
      const occ = await queryOne<any>(
        `SELECT l.id AS lease_id, vlat.tenant_id
           FROM leases l
           LEFT JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
          WHERE l.unit_id = $1 AND l.status = 'active'
          ORDER BY vlat.tenant_id NULLS LAST
          LIMIT 1`,
        [unitId])
      tenantId = tenantId ?? occ?.tenant_id ?? null
      leaseId = leaseId ?? occ?.lease_id ?? null
    }
    if (!tenantId) throw new AppError(400, 'No active tenant on this unit to notify of entry')

    const noticeHoursRow = await queryOne<{ default_entry_notice_hours: number }>(
      `SELECT default_entry_notice_hours FROM landlords WHERE id=$1`,
      [landlordId],
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
      unitId,
      startIso:          start.toISOString(),
      noticeWindowHours,
    })

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO unit_entry_requests (
         unit_id, lease_id, tenant_id, landlord_id,
         requested_by_user_id, reason, reason_category,
         proposed_entry_window_start, proposed_entry_window_end,
         notice_window_hours, maintenance_request_id, inspection_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        unitId,
        leaseId,
        tenantId,
        landlordId,
        req.user!.userId,
        reason,
        reasonCategory,
        start,
        end,
        noticeWindowHours,
        maintenanceRequestId,
        inspectionId,
      ],
    )

    // Notify tenant of the new request (best-effort).
    try {
      const t = await queryOne<any>(
        `SELECT u.id AS user_id, u.email, u.phone, un.unit_number
           FROM tenants t JOIN users u ON u.id = t.user_id
           LEFT JOIN units un ON un.id = $2
          WHERE t.id = $1`,
        [tenantId, unitId],
      )
      if (t?.user_id && t?.email) {
        await notifyEntryRequestNew({
          tenantUserId:       t.user_id,
          tenantEmail:        t.email,
          tenantPhone:        t.phone ?? undefined,
          requestId:          inserted!.id,
          reason,
          reasonCategory,
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
              maintenance_request_id, inspection_id,
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

    // S552: transactional core + notification extracted to
    // services/entryRequestRespond.ts, shared with the agent tool
    // respond_to_entry_request — identical semantics, one implementation.
    await applyEntryRequestResponse(r, req.user!.userId, body.decision, body.reason ?? null)

    res.json({ success: true, data: { decision: body.decision } })
  } catch (e) {
    next(e)
  }
})

const recordSchema = z.object({
  enteredAt: z.string(),
  notes: z.string().optional(),
})

entryRequestsRouter.post('/:id/record-entry', requirePerm('entry_requests.manage'), async (req, res, next) => {
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

entryRequestsRouter.post('/:id/cancel', requirePerm('entry_requests.manage'), async (req, res, next) => {
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
            notice_window_hours, notes, maintenance_request_id, inspection_id, created_at
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
