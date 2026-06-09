import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { requireLendingService } from '../middleware/requireLendingService'
import { AppError } from '../middleware/errorHandler'
import {
  appendEvent,
  findSubjectId,
  getSubjectChain,
  verifyChain,
} from '../services/creditLedger'
import { recomputeAndSnapshot, getLatestScore } from '../services/creditScore'
import { refreshSubjectStats, getLatestStats } from '../services/creditStats'
import {
  openDispute,
  submitDisputeEvidence,
  resolveDispute,
} from '../services/creditDispute'
import {
  CREDIT_DISPUTE_REASONS,
  CREDIT_HARDSHIP_CATEGORIES,
  CREDIT_SUBJECT_TYPES,
  CREDIT_NETWORK_VISIBILITY,
} from '@gam/shared'
import { createAdminNotification } from '../services/adminNotifications'
import { notifyDisputeResolved } from '../services/notifications'
import { logger } from '../lib/logger'

// ============================================================
// /api/credit/* — visibility-gated public surface for the credit
// ledger.
//
// Visibility rules per locked design:
//   - Subject's own complete record:           subject themselves
//   - Other subjects' visible events:          requester's relationship
//                                              determines what they see
//   - Stats panel:                             visibility-gated
//   - Score (raw composite):                   internal lending only
//   - Dispute open / evidence:                 the disputing subject
//   - Dispute resolve:                         admin-only
//   - Hardship-context add:                    tenant-only on own subject
//   - Integrity (Merkle anchors / verifyChain):read-only public-ish
//                                              (cryptographic proofs;
//                                              expose them so tampering
//                                              is detectable by anyone)
//
// canViewSubject() implements the v1 visibility filter. It walks the
// requester's relationship to the subject and decides which
// network_visibility tiers they can read.
// ============================================================

export const creditRouter = Router()

creditRouter.use(requireAuth)

// ---------- helpers ----------

interface SubjectSelector {
  subject_type: 'tenant' | 'landlord' | 'manager' | 'property'
  subject_ref_id: string
}

async function loadSubjectSelector(subjectId: string): Promise<SubjectSelector | null> {
  return queryOne<SubjectSelector>(
    `SELECT subject_type, subject_ref_id FROM credit_subjects WHERE id = $1`,
    [subjectId],
  )
}

/**
 * Determine which network_visibility tiers the requester can see for
 * the given subject. Returns a list of tiers the requester is
 * authorized to read.
 *
 * Rules (v1):
 *   - Admin / super_admin: everything
 *   - Subject themselves (tenant viewing their tenant subject; landlord
 *     viewing their landlord subject): everything (private + visible*)
 *   - Current landlord of the subject (active tenancy relationship for
 *     tenant subjects): visible_to_current_landlord +
 *     visible_to_gam_network (NOT private)
 *   - Other GAM-network landlord (no current relationship):
 *     visible_to_gam_network only
 *   - Tenant viewing a landlord subject (active tenancy): same as
 *     current-landlord tier — they have a relationship
 *   - Anyone else: no visibility (return empty list)
 */
async function canViewSubject(
  req: import('express').Request,
  selector: SubjectSelector,
): Promise<string[]> {
  const u = req.user
  if (!u) return []
  if (u.role === 'admin' || u.role === 'super_admin') {
    return ['private_to_subject', 'visible_to_current_landlord', 'visible_to_gam_network']
  }

  // Subject viewing their own record.
  if (selector.subject_type === 'tenant' && u.role === 'tenant' && u.profileId === selector.subject_ref_id) {
    return ['private_to_subject', 'visible_to_current_landlord', 'visible_to_gam_network']
  }
  if (selector.subject_type === 'landlord' && u.role === 'landlord' && u.profileId === selector.subject_ref_id) {
    return ['private_to_subject', 'visible_to_current_landlord', 'visible_to_gam_network']
  }

  // Active relationship between landlord requester and tenant subject.
  if (selector.subject_type === 'tenant' && (u.role === 'landlord' || u.role === 'property_manager' || u.role === 'onsite_manager')) {
    const landlordId = u.role === 'landlord' ? u.profileId : u.landlordId
    if (!landlordId) return []
    const rel = await queryOne(
      `SELECT 1
         FROM lease_tenants lt
         JOIN leases l   ON l.id = lt.lease_id
        WHERE lt.tenant_id = $1
          AND l.landlord_id = $2
          AND lt.status = 'active'
          AND l.status IN ('active','pending')
        LIMIT 1`,
      [selector.subject_ref_id, landlordId],
    )
    if (rel) {
      return ['visible_to_current_landlord', 'visible_to_gam_network']
    }
    // Network-only visibility for landlords with no current relationship.
    return ['visible_to_gam_network']
  }

  // Tenant viewing a landlord subject — only when there's an active
  // tenancy relationship.
  if (selector.subject_type === 'landlord' && u.role === 'tenant') {
    const rel = await queryOne(
      `SELECT 1
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
        WHERE lt.tenant_id = $1
          AND l.landlord_id = $2
          AND lt.status = 'active'
          AND l.status IN ('active','pending')
        LIMIT 1`,
      [u.profileId, selector.subject_ref_id],
    )
    if (rel) return ['visible_to_current_landlord', 'visible_to_gam_network']
    return ['visible_to_gam_network']
  }

  return []
}

// ---------- GET own record ----------

creditRouter.get('/subject/own', async (req, res, next) => {
  try {
    const u = req.user!
    const subjectType =
      u.role === 'tenant'
        ? 'tenant'
        : u.role === 'landlord'
          ? 'landlord'
          : null
    if (!subjectType) {
      throw new AppError(400, 'No subject mapping for this role; query by /subject/:id instead')
    }
    const sid = await findSubjectId(subjectType, u.profileId)
    if (!sid) return res.json({ success: true, data: { subject_id: null, events: [] } })
    const events = await getSubjectChain(sid)
    res.json({
      success: true,
      data: {
        subject_id: sid,
        subject_type: subjectType,
        subject_ref_id: u.profileId,
        events: events.map(redactEvent),
      },
    })
  } catch (e) {
    next(e)
  }
})

// ---------- GET subject events (visibility-gated) ----------

creditRouter.get('/subject/:subjectId', async (req, res, next) => {
  try {
    const selector = await loadSubjectSelector(req.params.subjectId)
    if (!selector) throw new AppError(404, 'Subject not found')

    const allowed = await canViewSubject(req, selector)
    if (allowed.length === 0) throw new AppError(403, 'No visibility for this subject')

    const events = await getSubjectChain(req.params.subjectId)
    const filtered = events.filter((e) => allowed.includes(e.network_visibility))
    res.json({
      success: true,
      data: {
        subject_id: req.params.subjectId,
        subject_type: selector.subject_type,
        events: filtered.map(redactEvent),
      },
    })
  } catch (e) {
    next(e)
  }
})

function redactEvent(ev: any) {
  return {
    id: ev.id,
    event_type: ev.event_type,
    occurred_at: ev.occurred_at,
    recorded_at: ev.recorded_at,
    attestation_source: ev.attestation_source,
    dimension_tags: ev.dimension_tags,
    network_visibility: ev.network_visibility,
    superseded: ev.superseded_by !== null,
    this_hash: Buffer.isBuffer(ev.this_hash) ? ev.this_hash.toString('hex') : null,
  }
}

// ---------- GET screening view by tenant_id (convenience) ----------
// Landlord-side screening surface. Takes a tenants.id, resolves to the
// underlying credit_subjects.id, and returns the visibility-filtered
// event chain + stats panel in one round-trip. Visibility rules in
// canViewSubject() apply — landlord with active relationship sees
// current+network tiers, no relationship sees network only, no role
// is the empty list.

creditRouter.get('/screening-by-tenant/:tenantId', async (req, res, next) => {
  try {
    const subjectId = await findSubjectId('tenant', req.params.tenantId)
    if (!subjectId) {
      // No ledger activity yet — still allow lookup, return empty payload.
      return res.json({
        success: true,
        data: {
          subject_id: null,
          subject_type: 'tenant',
          subject_ref_id: req.params.tenantId,
          events: [],
          stats: null,
        },
      })
    }

    const selector: SubjectSelector = {
      subject_type: 'tenant',
      subject_ref_id: req.params.tenantId,
    }
    const allowed = await canViewSubject(req, selector)
    if (allowed.length === 0) throw new AppError(403, 'No visibility for this tenant')

    const events = await getSubjectChain(subjectId)
    const filtered = events.filter((e) => allowed.includes(e.network_visibility))

    const stats = await getLatestStats(subjectId)

    res.json({
      success: true,
      data: {
        subject_id: subjectId,
        subject_type: 'tenant',
        subject_ref_id: req.params.tenantId,
        events: filtered.map(redactEvent),
        stats,
      },
    })
  } catch (e) {
    next(e)
  }
})

// ---------- GET stats panel (visibility-gated) ----------

creditRouter.get('/stats/:subjectId', async (req, res, next) => {
  try {
    const selector = await loadSubjectSelector(req.params.subjectId)
    if (!selector) throw new AppError(404, 'Subject not found')

    const allowed = await canViewSubject(req, selector)
    if (allowed.length === 0) throw new AppError(403, 'No visibility for this subject')

    const stats = await getLatestStats(req.params.subjectId)
    res.json({ success: true, data: stats })
  } catch (e) {
    next(e)
  }
})

// ---------- GET score (lending-services-only) ----------

creditRouter.get('/score/:subjectId', requireLendingService, async (req, res, next) => {
  try {
    const score = await getLatestScore(req.params.subjectId)
    res.json({ success: true, data: score })
  } catch (e) {
    next(e)
  }
})

// ---------- POST recompute (admin or lending) — on-demand snapshot ----------

creditRouter.post('/score/:subjectId/recompute', requireLendingService, async (req, res, next) => {
  try {
    const selector = await loadSubjectSelector(req.params.subjectId)
    if (!selector) throw new AppError(404, 'Subject not found')
    const result = await recomputeAndSnapshot(req.params.subjectId)
    await refreshSubjectStats(req.params.subjectId)
    res.json({ success: true, data: result })
  } catch (e) {
    next(e)
  }
})

// ---------- Landlord: attest adverse event ----------
// Landlord-self-attested events for eviction lifecycle + conduct
// (noise, lease violation, property damage, nuisance). Per the locked
// design these are landlord-attested in v1; downstream a dispute path
// exists for the tenant. The route enforces:
//   - landlord/property_manager only
//   - landlord must have an active relationship to the tenant subject
//   - event_type is restricted to the LANDLORD_ATTESTABLE_TYPES set
//   - attestation_source forced to landlord_self_reported_with_evidence
//   - network_visibility defaulted to visible_to_gam_network (adverse)
//     unless the type is a positive cure event
const LANDLORD_ATTESTABLE_TYPES = new Set([
  'eviction_notice_filed',
  'eviction_hearing_scheduled',
  'eviction_hearing_continued',
  'eviction_hearing_dismissed',
  'eviction_hearing_judgment_issued',
  'eviction_settled',
  'eviction_withdrawn',
  'noise_complaint_logged',
  'lease_violation_notice_issued',
  'lease_violation_cured',
  'property_damage_event_documented',
  'nuisance_event_documented',
])
const LANDLORD_POSITIVE_CURES = new Set(['lease_violation_cured', 'eviction_hearing_dismissed', 'eviction_withdrawn'])

const attestSchema = z.object({
  tenantId:      z.string().uuid(),
  eventType:     z.string(),
  occurredAt:    z.string(),
  evidence:      z.record(z.unknown()).default({}),
  notes:         z.string().max(2000).optional(),
  violationType: z.string().optional(),
})

creditRouter.post('/attest', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'landlord' && u.role !== 'property_manager') {
      throw new AppError(403, 'Only landlords and property managers can attest events')
    }
    const body = attestSchema.parse(req.body)
    if (!LANDLORD_ATTESTABLE_TYPES.has(body.eventType)) {
      throw new AppError(400, `event_type ${body.eventType} is not landlord-attestable`)
    }

    // Confirm active relationship
    const landlordId = u.role === 'landlord' ? u.profileId : u.landlordId
    if (!landlordId) throw new AppError(403, 'No landlord relationship')
    const rel = await queryOne(
      `SELECT 1
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id
        WHERE lt.tenant_id = $1
          AND l.landlord_id = $2
          AND lt.status IN ('active','removed')
          AND l.status IN ('active','pending','expired')
        LIMIT 1`,
      [body.tenantId, landlordId],
    )
    if (!rel) throw new AppError(403, 'No tenancy relationship between you and this tenant')

    const isPositive = LANDLORD_POSITIVE_CURES.has(body.eventType)
    const visibility = isPositive ? 'visible_to_current_landlord' : 'visible_to_gam_network'

    const dimensionTags: string[] =
      body.eventType.startsWith('eviction_') || body.eventType === 'lease_violation_notice_issued' || body.eventType === 'lease_violation_cured'
        ? ['tenancy_stability']
        : ['property_care', 'community_fit']

    const result = await appendEvent({
      subjectType: 'tenant',
      subjectRefId: body.tenantId,
      eventType: body.eventType as any,
      eventData: {
        // S325: event_data JSONB content keys stay snake_case — the
        // credit ledger persists these as DB column-style keys for the
        // stats / score computation downstream. camelize interceptor
        // treats event_data as passthrough.
        attested_by_user_id: u.userId,
        attested_by_landlord_id: landlordId,
        notes: body.notes ?? null,
        violation_type: body.violationType ?? null,
        ...body.evidence,
      },
      occurredAt: new Date(body.occurredAt),
      attestationSource: 'landlord_self_reported_with_evidence',
      attestationEvidence: body.evidence,
      dimensionTags: dimensionTags as any,
      networkVisibility: visibility as any,
    })

    res.json({ success: true, data: { event_id: result.eventId, subject_id: result.subjectId } })
  } catch (e) {
    next(e)
  }
})

// ---------- Tenant: my disputes ----------
// The disputing user gets the same shape as the admin list, filtered to
// disputes they themselves opened. No event-data redaction needed since
// the tenant is the owner of these events.
creditRouter.get('/disputes/mine', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant' && u.role !== 'landlord') {
      throw new AppError(403, 'Only tenants and landlords have disputes in v1')
    }
    const subjectType = u.role === 'tenant' ? 'tenant' : 'landlord'
    const subjectId = await findSubjectId(subjectType, u.profileId)
    if (!subjectId) return res.json({ success: true, data: [] })

    const rows = await query<any>(
      `SELECT d.id, d.status, d.reason, d.notes, d.created_at, d.resolved_at,
              d.disputed_event_id, d.dispute_open_event_id, d.resolution_event_id,
              de.event_type    AS disputed_event_type,
              de.event_data    AS disputed_event_data,
              de.occurred_at   AS disputed_event_occurred_at,
              de.attestation_source AS disputed_event_attestation_source,
              de.network_visibility AS disputed_event_network_visibility,
              de.superseded_by      AS disputed_event_superseded_by
         FROM credit_disputes d
         JOIN credit_events  de ON de.id = d.disputed_event_id
        WHERE d.disputing_subject_id = $1
        ORDER BY d.created_at DESC`,
      [subjectId],
    )
    res.json({ success: true, data: rows })
  } catch (e) {
    next(e)
  }
})

// ---------- Admin: single dispute detail (with evidence events) ----------
creditRouter.get('/disputes/:id', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'admin' && u.role !== 'super_admin') {
      throw new AppError(403, 'Admin only')
    }
    const dispute = await queryOne<any>(
      `SELECT d.id, d.status, d.reason, d.notes, d.created_at, d.resolved_at,
              d.disputed_event_id, d.dispute_open_event_id, d.resolution_event_id,
              s.subject_type   AS disputing_subject_type,
              s.subject_ref_id AS disputing_subject_ref_id,
              de.event_type    AS disputed_event_type,
              de.event_data    AS disputed_event_data,
              de.occurred_at   AS disputed_event_occurred_at,
              de.attestation_source AS disputed_event_attestation_source,
              de.dimension_tags     AS disputed_event_dimension_tags,
              de.network_visibility AS disputed_event_network_visibility,
              de.superseded_by      AS disputed_event_superseded_by
         FROM credit_disputes d
         JOIN credit_subjects s ON s.id = d.disputing_subject_id
         JOIN credit_events  de ON de.id = d.disputed_event_id
        WHERE d.id = $1`,
      [req.params.id],
    )
    if (!dispute) throw new AppError(404, 'Dispute not found')

    // Pull the dispute_opened event by its explicit pointer (its
    // event_data doesn't carry dispute_id — the id is generated by
    // the INSERT after the event lands) plus any
    // dispute_evidence_submitted events tagged with dispute_id.
    const evidenceEvents = await query<any>(
      `SELECT id, event_type, event_data, occurred_at, recorded_at, attestation_source
         FROM credit_events
        WHERE id = $2
           OR (event_type = 'dispute_evidence_submitted'
               AND event_data ->> 'dispute_id' = $1)
        ORDER BY recorded_at ASC`,
      [req.params.id, dispute.dispute_open_event_id],
    )

    res.json({ success: true, data: { ...dispute, evidence: evidenceEvents } })
  } catch (e) {
    next(e)
  }
})

// ---------- Admin: list disputes ----------
// Admin-only. Returns each dispute joined with the disputed event and
// the disputing subject's type+ref so the resolution UI doesn't need
// to do per-row drill-downs.
creditRouter.get('/disputes', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'admin' && u.role !== 'super_admin') {
      throw new AppError(403, 'Admin only')
    }
    const status = (req.query.status as string | undefined) ?? null
    const params: any[] = []
    let where = '1=1'
    if (status) {
      params.push(status)
      where += ` AND d.status = $${params.length}`
    }
    const rows = await query<any>(
      `SELECT d.id,
              d.status,
              d.reason,
              d.notes,
              d.created_at,
              d.resolved_at,
              d.disputed_event_id,
              d.dispute_open_event_id,
              s.subject_type   AS disputing_subject_type,
              s.subject_ref_id AS disputing_subject_ref_id,
              de.event_type    AS disputed_event_type,
              de.event_data    AS disputed_event_data,
              de.occurred_at   AS disputed_event_occurred_at,
              de.attestation_source AS disputed_event_attestation_source,
              de.dimension_tags     AS disputed_event_dimension_tags,
              de.network_visibility AS disputed_event_network_visibility,
              de.superseded_by      AS disputed_event_superseded_by,
              (SELECT COUNT(*)::int
                 FROM credit_events ev
                WHERE ev.event_type = 'dispute_evidence_submitted'
                  AND ev.event_data ->> 'dispute_id' = d.id::text) AS evidence_count
         FROM credit_disputes d
         JOIN credit_subjects s ON s.id = d.disputing_subject_id
         JOIN credit_events  de ON de.id = d.disputed_event_id
        WHERE ${where}
        ORDER BY d.created_at DESC
        LIMIT 200`,
      params,
    )
    res.json({ success: true, data: rows })
  } catch (e) {
    next(e)
  }
})

// ---------- Dispute lifecycle ----------

const disputeOpenSchema = z.object({
  disputedEventId: z.string().uuid(),
  reason: z.enum([
    'factual_inaccuracy',
    'attestation_invalid',
    'identity_mismatch',
    'other',
  ] as [(typeof CREDIT_DISPUTE_REASONS)[number], ...(typeof CREDIT_DISPUTE_REASONS)[number][]]),
  notes: z.string().max(2000).optional(),
})

creditRouter.post('/dispute', async (req, res, next) => {
  try {
    const body = disputeOpenSchema.parse(req.body)
    const u = req.user!
    if (u.role !== 'tenant' && u.role !== 'landlord') {
      throw new AppError(403, 'Only tenants and landlords can open disputes in v1')
    }
    const subjectType = u.role === 'tenant' ? 'tenant' : 'landlord'
    const subjectId = await findSubjectId(subjectType, u.profileId)
    if (!subjectId) throw new AppError(400, 'No credit subject for this user yet')

    const result = await openDispute({
      disputingSubjectId: subjectId,
      disputingSubjectType: subjectType,
      disputingSubjectRefId: u.profileId,
      disputedEventId: body.disputedEventId,
      reason: body.reason,
      notes: body.notes,
    })

    // Admin alert: a dispute was opened and needs review. Best-effort.
    try {
      await createAdminNotification({
        severity: 'warn',
        category: 'credit_dispute_opened',
        title: `Credit dispute opened by ${subjectType}`,
        body: `Dispute ${result.disputeId} on event ${body.disputedEventId} (reason: ${body.reason}). ${body.notes ?? ''}`,
        context: {
          dispute_id: result.disputeId,
          subject_type: subjectType,
          subject_ref_id: u.profileId,
          disputed_event_id: body.disputedEventId,
          reason: body.reason,
        },
      })
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] dispute_opened admin alert:')
    }

    res.json({ success: true, data: result })
  } catch (e) {
    next(e)
  }
})

const evidenceSchema = z.object({
  evidence: z.record(z.unknown()),
})

creditRouter.post('/dispute/:id/evidence', async (req, res, next) => {
  try {
    const body = evidenceSchema.parse(req.body)
    const u = req.user!
    if (u.role !== 'tenant' && u.role !== 'landlord') {
      throw new AppError(403, 'Only tenants and landlords can submit dispute evidence in v1')
    }
    const subjectType = u.role === 'tenant' ? 'tenant' : 'landlord'

    const result = await submitDisputeEvidence({
      disputeId: req.params.id,
      disputingSubjectType: subjectType,
      disputingSubjectRefId: u.profileId,
      evidence: body.evidence,
    })
    res.json({ success: true, data: result })
  } catch (e) {
    next(e)
  }
})

const resolveSchema = z.object({
  outcome: z.enum(['upheld', 'corrected', 'no_change']),
  resolverNotes: z.string().max(2000).optional(),
  correctedEvent: z
    .object({
      subjectType: z.enum(CREDIT_SUBJECT_TYPES as unknown as [string, ...string[]]),
      subjectRefId: z.string().uuid(),
      eventType: z.string(),
      eventData: z.record(z.unknown()).default({}),
      occurredAt: z.string(),
      attestationSource: z.string(),
      attestationEvidence: z.record(z.unknown()).default({}),
      dimensionTags: z.array(z.string()).default([]),
      networkVisibility: z.enum(
        CREDIT_NETWORK_VISIBILITY as unknown as [string, ...string[]],
      ),
    })
    .optional(),
  supersedeReason: z
    .enum(['correction_after_dispute', 'data_entry_error_corrected', 'attestation_invalidated'])
    .optional(),
})

creditRouter.post('/dispute/:id/resolve', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'admin' && u.role !== 'super_admin') {
      throw new AppError(403, 'Dispute resolution is admin-only')
    }
    const body = resolveSchema.parse(req.body)

    const result = await resolveDispute({
      disputeId: req.params.id,
      outcome: body.outcome,
      resolverNotes: body.resolverNotes,
      resolvedByUserId: u.userId,
      correctedEvent: body.correctedEvent
        ? {
            subjectType: body.correctedEvent.subjectType as
              | 'tenant'
              | 'landlord'
              | 'manager'
              | 'property',
            subjectRefId: body.correctedEvent.subjectRefId,
            eventType: body.correctedEvent.eventType as any,
            eventData: body.correctedEvent.eventData,
            occurredAt: new Date(body.correctedEvent.occurredAt),
            attestationSource: body.correctedEvent.attestationSource as any,
            attestationEvidence: body.correctedEvent.attestationEvidence,
            dimensionTags: body.correctedEvent.dimensionTags as any,
            networkVisibility: body.correctedEvent.networkVisibility as any,
          }
        : undefined,
      supersedeReason: body.supersedeReason,
    })

    // Notify the disputing user of the outcome.
    try {
      const owner = await queryOne<{
        user_id: string
        email: string
      }>(
        `SELECT
            CASE
              WHEN s.subject_type = 'tenant' THEN tu.id
              WHEN s.subject_type = 'landlord' THEN lu.id
              ELSE NULL
            END AS user_id,
            CASE
              WHEN s.subject_type = 'tenant' THEN tu.email
              WHEN s.subject_type = 'landlord' THEN lu.email
              ELSE NULL
            END AS email
           FROM credit_disputes d
           JOIN credit_subjects s ON s.id = d.disputing_subject_id
           LEFT JOIN tenants t ON t.id = s.subject_ref_id AND s.subject_type = 'tenant'
           LEFT JOIN users tu ON tu.id = t.user_id
           LEFT JOIN landlords l ON l.id = s.subject_ref_id AND s.subject_type = 'landlord'
           LEFT JOIN users lu ON lu.id = l.user_id
          WHERE d.id = $1`,
        [req.params.id],
      )
      if (owner?.user_id && owner?.email) {
        await notifyDisputeResolved({
          disputingUserId: owner.user_id,
          disputingEmail:  owner.email,
          disputeId:       req.params.id,
          outcome:         body.outcome,
          resolverNotes:   body.resolverNotes,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] dispute_resolved:')
    }

    res.json({ success: true, data: result })
  } catch (e) {
    next(e)
  }
})

// ---------- Hardship context ----------

const hardshipSchema = z.object({
  category: z.enum(
    CREDIT_HARDSHIP_CATEGORIES as unknown as [string, ...string[]],
  ),
  startDate: z.string(),
  endDate:   z.string().optional(),
  note:      z.string().max(2000).optional(),
})

creditRouter.post('/hardship-context', async (req, res, next) => {
  try {
    const body = hardshipSchema.parse(req.body)
    const u = req.user!
    if (u.role !== 'tenant') {
      throw new AppError(403, 'Hardship context is tenant-only')
    }
    const subjectId = await findSubjectId('tenant', u.profileId)
    if (!subjectId) throw new AppError(400, 'No credit subject yet — submit any ledger event first')

    const event = await appendEvent({
      subjectType: 'tenant',
      subjectRefId: u.profileId,
      eventType: 'hardship_context_added',
      eventData: {
        // event_data JSONB content keys stay snake_case (passthrough).
        category: body.category,
        start_date: body.startDate,
        end_date: body.endDate ?? null,
        note: body.note ?? null,
      },
      occurredAt: new Date(),
      attestationSource: 'tenant_self_reported',
      attestationEvidence: {
        category: body.category,
        note: body.note ?? null,
      },
      dimensionTags: [],
      networkVisibility: 'private_to_subject',
    })

    const inserted = await query<{ id: string }>(
      `INSERT INTO credit_hardship_contexts (
         subject_id, category, start_date, end_date, note, event_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        subjectId,
        body.category,
        body.startDate,
        body.endDate ?? null,
        body.note ?? null,
        event.eventId,
      ],
    )
    res.json({
      success: true,
      data: { hardship_id: inserted[0].id, event_id: event.eventId },
    })
  } catch (e) {
    next(e)
  }
})

// ---------- Integrity ----------

creditRouter.get('/integrity/anchors', async (_req, res, next) => {
  try {
    const rows = await query<{
      id: string
      anchored_at: Date
      event_count_at_anchor: string
      merkle_root: Buffer
    }>(
      `SELECT id, anchored_at, event_count_at_anchor, merkle_root
         FROM credit_merkle_anchors
        ORDER BY anchored_at DESC
        LIMIT 100`,
    )
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        anchored_at: r.anchored_at,
        event_count: parseInt(r.event_count_at_anchor, 10),
        merkle_root: r.merkle_root.toString('hex'),
      })),
    })
  } catch (e) {
    next(e)
  }
})

creditRouter.get('/integrity/verify/:subjectId', async (req, res, next) => {
  try {
    const selector = await loadSubjectSelector(req.params.subjectId)
    if (!selector) throw new AppError(404, 'Subject not found')

    const allowed = await canViewSubject(req, selector)
    if (allowed.length === 0) throw new AppError(403, 'No visibility for this subject')

    const result = await verifyChain(req.params.subjectId)
    res.json({ success: true, data: result })
  } catch (e) {
    next(e)
  }
})
