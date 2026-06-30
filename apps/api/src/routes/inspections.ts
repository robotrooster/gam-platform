import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { query, queryOne, getClient } from '../db'
import { requireAuth } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emitInspectionFinalizedEvents } from '../services/creditLedgerEmitters'
import {
  notifyInspectionReadyForTenant,
  notifyInspectionTenantSigned,
  notifyInspectionFinalized,
} from '../services/notifications'
import { logger } from '../lib/logger'
import { insertInspectionWithChecklist } from '../services/inspections'
import { INSPECTION_TYPES, INSPECTION_ITEM_CONDITIONS } from '@gam/shared'

// ============================================================
// /api/inspections — move-in / move-out / periodic inspection
// workflow.
//
// Sign-off model: tenant signs the items (their attestation that
// what they're seeing is what's documented), landlord signs to
// finalize. When BOTH have signed, status flips to 'finalized' and
// the credit-ledger emitters fire.
//
// Move-out compares against a designated move-in inspection
// (comparison_inspection_id). Damage = any item whose move-out
// condition is worse than its move-in condition for the same
// (area, item_label) pair. Items present at move-out but not at
// move-in count as new and don't affect the comparison.
//
// "Worse than" condition ordering:
//   good < fair < damaged < missing
// 'na' is excluded from the comparison.
// ============================================================

export const inspectionsRouter = Router()
inspectionsRouter.use(requireAuth)

// ── photo upload setup (mirror avatar pattern) ─────────────────
const inspectionPhotoDir = path.join(process.cwd(), 'uploads', 'inspections')
if (!fs.existsSync(inspectionPhotoDir)) fs.mkdirSync(inspectionPhotoDir, { recursive: true })

const photoStorage = multer.diskStorage({
  destination: inspectionPhotoDir,
  filename: (_req: any, file: any, cb: any) =>
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
})
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.mimetype)) cb(null, true)
    else cb(new Error('JPEG PNG WEBP HEIC only'))
  },
})

// ── walkthrough video upload (GAM in-house storage) ────────────
const inspectionVideoDir = path.join(process.cwd(), 'uploads', 'inspection-videos')
if (!fs.existsSync(inspectionVideoDir)) fs.mkdirSync(inspectionVideoDir, { recursive: true })

const videoStorage = multer.diskStorage({
  destination: inspectionVideoDir,
  filename: (_req: any, file: any, cb: any) =>
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
})
const videoUpload = multer({
  storage: videoStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — phone walkthrough clips
  fileFilter: (_req: any, file: any, cb: any) => {
    if (['video/mp4', 'video/quicktime', 'video/webm'].includes(file.mimetype)) cb(null, true)
    else cb(new Error('MP4 MOV WEBM only'))
  },
})

// ── POST /api/inspections — create ──────────────────────────────
// S318: wire-format convention — camelCase request bodies. DB column
// names remain snake_case.
const createSchema = z.object({
  unitId: z.string().uuid(),
  leaseId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  inspectionType: z.enum(INSPECTION_TYPES),
  comparisonInspectionId: z.string().uuid().optional(),
  scheduledFor: z.string().optional(),
  notes: z.string().optional(),
})

inspectionsRouter.post('/', async (req, res, next) => {
  const client = await getClient()
  try {
    const body = createSchema.parse(req.body)
    // unit_type + bedrooms drive the standard walkthrough checklist (single
    // source: buildInspectionChecklist) seeded below.
    const unit = await queryOne<{ id: string; landlord_id: string; bedrooms: number | null; unit_type: string | null }>(
      `SELECT id, landlord_id, bedrooms, unit_type FROM units WHERE id=$1`,
      [body.unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    await client.query('BEGIN')
    const { id, seededItems } = await insertInspectionWithChecklist(client, {
      unitId: body.unitId,
      landlordId: unit.landlord_id,
      unitType: unit.unit_type,
      bedrooms: unit.bedrooms,
      leaseId: body.leaseId ?? null,
      tenantId: body.tenantId ?? null,
      inspectionType: body.inspectionType,
      comparisonInspectionId: body.comparisonInspectionId ?? null,
      scheduledFor: body.scheduledFor ?? null,
      notes: body.notes ?? null,
    })
    await client.query('COMMIT')
    res.json({ success: true, data: { id, seededItems } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// ── GET /api/inspections/:id — full detail ─────────────────────
inspectionsRouter.get('/:id', async (req, res, next) => {
  try {
    const { row, items, photos, signatures } = await loadInspection(req.params.id, req)
    res.json({ success: true, data: { ...row, items, photos, signatures } })
  } catch (e) {
    next(e)
  }
})

// ── GET /api/inspections?unitId=...&tenantId=... — list ───────
inspectionsRouter.get('/', async (req, res, next) => {
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
    if (req.query.leaseId) {
      params.push(req.query.leaseId)
      where += ` AND lease_id = $${params.length}`
    }
    const rows = await query<any>(
      `SELECT id, unit_id, lease_id, tenant_id, landlord_id,
              inspection_type, status, comparison_inspection_id,
              scheduled_for, conducted_at, finalized_at,
              created_at, updated_at
         FROM unit_inspections
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

// ── PATCH /api/inspections/:id — reschedule / update notes ────
const patchSchema = z.object({
  scheduledFor: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

inspectionsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body)
    const insp = await loadInspectionRow(req.params.id, req)
    if (!canManageLandlordResource(req.user, insp.landlord_id)) {
      throw new AppError(403, 'Only landlord can edit')
    }
    if (insp.status === 'finalized' || insp.status === 'cancelled') {
      throw new AppError(409, `cannot edit in status ${insp.status}`)
    }

    const sets: string[] = []
    const params: any[] = []
    let scheduledChanged = false
    if (body.scheduledFor !== undefined) {
      params.push(body.scheduledFor ? new Date(body.scheduledFor) : null)
      sets.push(`scheduled_for = $${params.length}`)
      // Clear reminder_sent_at when scheduled_for changes — the original
      // reminder is no longer aligned with the new window.
      if (body.scheduledFor !== insp.scheduled_for) {
        sets.push(`reminder_sent_at = NULL`)
        scheduledChanged = true
      }
    }
    if (body.notes !== undefined) {
      params.push(body.notes)
      sets.push(`notes = $${params.length}`)
    }
    if (sets.length === 0) {
      return res.json({ success: true, data: { id: insp.id } })
    }
    sets.push(`updated_at = NOW()`)
    params.push(req.params.id)
    await query(
      `UPDATE unit_inspections SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    )
    res.json({ success: true, data: { id: insp.id, rescheduled: scheduledChanged } })
  } catch (e) {
    next(e)
  }
})

// ── POST /api/inspections/:id/items — add or update item ──────
const itemSchema = z.object({
  area: z.string().min(1),
  itemLabel: z.string().min(1),
  condition: z.enum(INSPECTION_ITEM_CONDITIONS),
  notes: z.string().optional(),
  estimatedRepairCost: z.number().optional(),
})

inspectionsRouter.post('/:id/items', async (req, res, next) => {
  try {
    const body = itemSchema.parse(req.body)
    const insp = await loadInspectionRow(req.params.id, req)
    if (insp.status !== 'draft') throw new AppError(409, `cannot edit items in status ${insp.status}`)

    const r = await queryOne<{ id: string }>(
      `INSERT INTO unit_inspection_items (
         inspection_id, area, item_label, condition, notes, estimated_repair_cost
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (inspection_id, area, item_label) DO UPDATE
         SET condition = EXCLUDED.condition,
             notes = EXCLUDED.notes,
             estimated_repair_cost = EXCLUDED.estimated_repair_cost,
             updated_at = NOW()
       RETURNING id`,
      [
        req.params.id,
        body.area,
        body.itemLabel,
        body.condition,
        body.notes ?? null,
        body.estimatedRepairCost ?? null,
      ],
    )
    res.json({ success: true, data: { id: r!.id } })
  } catch (e) {
    next(e)
  }
})

// ── POST /api/inspections/:id/photos — multipart upload ───────
inspectionsRouter.post('/:id/photos', photoUpload.single('file'), async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file')
    const insp = await loadInspectionRow(req.params.id, req)
    if (insp.status === 'finalized' || insp.status === 'cancelled') {
      throw new AppError(409, `cannot add photos in status ${insp.status}`)
    }
    const photoUrl = '/api/inspections/photo-files/' + req.file.filename
    const r = await queryOne<{ id: string }>(
      `INSERT INTO unit_inspection_photos (
         inspection_id, item_id, photo_url, caption, captured_live, uploaded_by
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        req.params.id,
        req.body.itemId || null,
        photoUrl,
        req.body.caption || null,
        req.body.capturedLive === 'true' || req.body.capturedLive === true,
        req.user!.userId,
      ],
    )
    res.json({ success: true, data: { id: r!.id, url: photoUrl } })
  } catch (e) {
    next(e)
  }
})

inspectionsRouter.get('/photo-files/:filename', async (req, res, next) => {
  try {
    const fp = path.join(inspectionPhotoDir, req.params.filename)
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch (e) {
    next(e)
  }
})

// ── Walkthrough videos (GAM in-house "mini-YouTube") ────────────────────
// Visibility model (Nic 2026-06-18):
//  - Landlords see ALL video of THEIR units (per-inspection list + the
//    per-unit lifecycle). These reject the tenant role (denyTenant).
//  - Tenants may UPLOAD on their own inspection, and see ONLY the videos
//    THEY uploaded, across every unit, over the years (GET /videos/mine).
//  - Video files are served with per-row authorization (landlord of the
//    unit OR the uploader), never blanket-open.
// Videos are immutable — there is intentionally NO delete route (the DB
// also hard-blocks deletion; see migration 20260618140000).
function denyTenant(req: import('express').Request) {
  if (req.user!.role === 'tenant') throw new AppError(403, 'Forbidden')
}

// POST /api/inspections/:id/videos — multipart upload of one walkthrough clip.
// Tenant may upload on THEIR OWN inspection (loadInspectionRow scopes it).
inspectionsRouter.post('/:id/videos', videoUpload.single('file'), async (req: any, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file')
    const insp = await loadInspectionRow(req.params.id, req)
    if (insp.status === 'finalized' || insp.status === 'cancelled') {
      throw new AppError(409, `cannot add videos in status ${insp.status}`)
    }
    const videoUrl = '/api/inspections/video-files/' + req.file.filename
    const durationRaw = Number(req.body.durationSeconds)
    const r = await queryOne<{ id: string }>(
      `INSERT INTO unit_inspection_videos (
         inspection_id, title, video_url, duration_seconds, file_size, mime_type, captured_live, uploaded_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        req.params.id,
        req.body.title || null,
        videoUrl,
        Number.isFinite(durationRaw) ? Math.trunc(durationRaw) : null,
        req.file.size ?? null,
        req.file.mimetype ?? null,
        req.body.capturedLive === 'true' || req.body.capturedLive === true,
        req.user!.userId,
      ],
    )
    res.json({ success: true, data: { id: r!.id, url: videoUrl } })
  } catch (e) {
    next(e)
  }
})

// GET /api/inspections/:id/videos — list this inspection's videos
inspectionsRouter.get('/:id/videos', async (req, res, next) => {
  try {
    denyTenant(req)
    await loadInspectionRow(req.params.id, req) // scope check
    const videos = await query<any>(
      `SELECT id, title, video_url, thumbnail_url, duration_seconds, mime_type,
              captured_live, uploaded_by, uploaded_at
         FROM unit_inspection_videos WHERE inspection_id = $1
        ORDER BY uploaded_at ASC`,
      [req.params.id],
    )
    res.json({ success: true, data: videos })
  } catch (e) {
    next(e)
  }
})

// GET /api/inspections/videos/mine — every video the caller uploaded, across
// all units, over the years, with unit/inspection context. Self-scoped by
// uploaded_by, so it's safe for tenants (their own contributions only).
// (2-segment path — no collision with GET /:id.)
inspectionsRouter.get('/videos/mine', async (req, res, next) => {
  try {
    const videos = await query<any>(
      `SELECT v.id, v.title, v.video_url, v.thumbnail_url, v.duration_seconds,
              v.captured_live, v.uploaded_at,
              i.id AS inspection_id, i.inspection_type,
              u.id AS unit_id, u.unit_number, p.name AS property_name
         FROM unit_inspection_videos v
         JOIN unit_inspections i ON i.id = v.inspection_id
         JOIN units u ON u.id = i.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE v.uploaded_by = $1
        ORDER BY v.uploaded_at DESC`,
      [req.user!.userId],
    )
    res.json({ success: true, data: videos })
  } catch (e) {
    next(e)
  }
})

// GET /api/inspections/video-files/:filename — stream a video. Authorized
// per-row: admin, the landlord of the unit, or the original uploader.
inspectionsRouter.get('/video-files/:filename', async (req, res, next) => {
  try {
    const videoUrl = '/api/inspections/video-files/' + req.params.filename
    const v = await queryOne<{ uploaded_by: string; landlord_id: string }>(
      `SELECT v.uploaded_by, i.landlord_id
         FROM unit_inspection_videos v
         JOIN unit_inspections i ON i.id = v.inspection_id
        WHERE v.video_url = $1`,
      [videoUrl],
    )
    if (!v) throw new AppError(404, 'Not found')
    const u = req.user!
    const allowed =
      u.role === 'admin' ||
      u.role === 'super_admin' ||
      v.uploaded_by === u.userId ||
      canAccessLandlordResource(u, v.landlord_id)
    if (!allowed) throw new AppError(403, 'Forbidden')

    const fp = path.join(inspectionVideoDir, req.params.filename)
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch (e) {
    next(e)
  }
})

// GET /api/inspections/unit/:unitId/lifecycle — the unit's video story:
// every inspection for the unit, oldest first, each with its videos.
// (3-segment path — no collision with GET /:id.)
inspectionsRouter.get('/unit/:unitId/lifecycle', async (req, res, next) => {
  try {
    denyTenant(req)
    const unit = await queryOne<{ id: string; landlord_id: string; unit_number: string | null }>(
      `SELECT id, landlord_id, unit_number FROM units WHERE id = $1`,
      [req.params.unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const stages = await query<any>(
      `SELECT i.id, i.inspection_type, i.status, i.scheduled_for, i.conducted_at,
              i.finalized_at, i.created_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', v.id, 'title', v.title, 'url', v.video_url,
                    'thumbnailUrl', v.thumbnail_url, 'durationSeconds', v.duration_seconds,
                    'capturedLive', v.captured_live, 'uploadedAt', v.uploaded_at
                  ) ORDER BY v.uploaded_at
                ) FILTER (WHERE v.id IS NOT NULL), '[]'
              ) AS videos
         FROM unit_inspections i
         LEFT JOIN unit_inspection_videos v ON v.inspection_id = i.id
        WHERE i.unit_id = $1
        GROUP BY i.id
        ORDER BY COALESCE(i.conducted_at, i.scheduled_for, i.created_at) ASC`,
      [req.params.unitId],
    )
    res.json({ success: true, data: { unit: { id: unit.id, unitNumber: unit.unit_number }, stages } })
  } catch (e) {
    next(e)
  }
})

// ── POST /api/inspections/:id/sign — record sign-off ──────────
inspectionsRouter.post('/:id/sign', async (req, res, next) => {
  try {
    const insp = await loadInspectionRow(req.params.id, req)
    if (insp.status === 'finalized' || insp.status === 'cancelled') {
      throw new AppError(409, `cannot sign in status ${insp.status}`)
    }
    const role = req.user!.role
    let signerRole: 'tenant' | 'landlord' | 'inspector'
    if (role === 'tenant') {
      if (insp.tenant_id !== req.user!.profileId) throw new AppError(403, 'Not your inspection')
      signerRole = 'tenant'
    } else if (role === 'landlord' || role === 'property_manager' || role === 'onsite_manager') {
      if (!canManageLandlordResource(req.user, insp.landlord_id)) throw new AppError(403, 'Forbidden')
      signerRole = role === 'landlord' ? 'landlord' : 'inspector'
    } else if (role === 'admin' || role === 'super_admin') {
      signerRole = 'inspector'
    } else {
      throw new AppError(403, 'Forbidden')
    }

    const evidence = {
      ip: (req.ip || '').toString(),
      user_agent: (req.get('user-agent') || '').toString(),
    }

    await query(
      `INSERT INTO unit_inspection_signatures (
         inspection_id, signer_user_id, signer_role, signature_evidence
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (inspection_id, signer_user_id, signer_role)
       DO UPDATE SET signed_at = NOW(), signature_evidence = EXCLUDED.signature_evidence`,
      [req.params.id, req.user!.userId, signerRole, JSON.stringify(evidence)],
    )

    // Update status flag (if both sides have signed, status flips to
    // landlord_signed and the finalize endpoint completes the
    // workflow).
    const sigs = await query<{ signer_role: string }>(
      `SELECT signer_role FROM unit_inspection_signatures WHERE inspection_id=$1`,
      [req.params.id],
    )
    const hasTenant = sigs.some((s) => s.signer_role === 'tenant')
    const hasLandlord = sigs.some((s) => s.signer_role === 'landlord' || s.signer_role === 'inspector')
    // A tenant-less inspection (landlord-initiated periodic / turnover with no
    // tenant_id) has no second party to sign, so the landlord's signature
    // alone must be enough to reach landlord_signed — otherwise it could never
    // be finalized. When a tenant IS on the inspection, both signatures are
    // still required before finalize.
    const tenantRequired = insp.tenant_id != null
    let newStatus = insp.status
    if (hasLandlord && (hasTenant || !tenantRequired)) newStatus = 'landlord_signed'
    else if (hasTenant) newStatus = 'tenant_signed'
    if (newStatus !== insp.status) {
      await query(
        `UPDATE unit_inspections SET status=$1, updated_at=NOW() WHERE id=$2`,
        [newStatus, req.params.id],
      )
    }

    // Notify the other side post-sign. Best-effort; failures don't
    // break the route.
    try {
      if (signerRole === 'tenant') {
        // S186: routed through resolver — inspection workflow is
        // day-to-day manager work, not owner-financial.
        const ctx = await queryOne<{ property_id: string; unit_number: string | null }>(
          `SELECT property_id, unit_number FROM units WHERE id = $1`,
          [insp.unit_id],
        )
        const tenant = insp.tenant_id
          ? await queryOne<{ first_name: string | null; last_name: string | null }>(
              `SELECT u.first_name, u.last_name
                 FROM tenants t JOIN users u ON u.id = t.user_id
                WHERE t.id = $1`,
              [insp.tenant_id],
            )
          : null
        if (ctx) {
          const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
          const targets = await getPropertyResponsibleParty(ctx.property_id)
          if (targets) {
            for (const recipient of targets.primaries) {
              await notifyInspectionTenantSigned({
                landlordUserId: recipient.user_id,
                landlordId:     insp.landlord_id,
                landlordEmail:  recipient.email,
                inspectionId:   insp.id,
                inspectionType: insp.inspection_type,
                unitNumber:     ctx.unit_number ?? undefined,
                tenantName:     tenant
                  ? `${tenant.first_name ?? ''} ${tenant.last_name ?? ''}`.trim() || undefined
                  : undefined,
              })
            }
          }
        }
      } else {
        // Landlord/inspector signed → ping tenant if there is one.
        if (insp.tenant_id) {
          const t = await queryOne<any>(
            `SELECT u.id AS user_id, u.email, u.phone, un.unit_number
               FROM tenants t JOIN users u ON u.id = t.user_id
               LEFT JOIN units un ON un.id = $2
              WHERE t.id = $1`,
            [insp.tenant_id, insp.unit_id],
          )
          if (t?.user_id && t?.email) {
            await notifyInspectionReadyForTenant({
              tenantUserId:    t.user_id,
              tenantEmail:     t.email,
              tenantPhone:     t.phone ?? undefined,
              inspectionId:    insp.id,
              inspectionType:  insp.inspection_type,
              unitNumber:      t.unit_number,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] inspection sign:')
    }

    res.json({ success: true, data: { signed: signerRole, status: newStatus } })
  } catch (e) {
    next(e)
  }
})

// ── POST /api/inspections/:id/finalize ─────────────────────────
// Landlord-only. Requires both tenant + landlord signatures present.
// Emits credit-ledger events transactionally.
inspectionsRouter.post('/:id/finalize', async (req, res, next) => {
  try {
    const insp = await loadInspectionRow(req.params.id, req)
    if (!canManageLandlordResource(req.user, insp.landlord_id)) {
      throw new AppError(403, 'Only landlord can finalize')
    }
    if (insp.status === 'finalized') throw new AppError(409, 'Already finalized')
    if (insp.status !== 'landlord_signed') {
      throw new AppError(409, `cannot finalize from status ${insp.status} (need both signatures)`)
    }

    // Compute move-out condition comparison (no-op for non-move-out).
    let matchesMoveIn = false
    let damageDocumented = false
    if (insp.inspection_type === 'move_out' && insp.comparison_inspection_id) {
      const comparisonResult = await compareMoveOutToMoveIn(
        req.params.id,
        insp.comparison_inspection_id,
      )
      matchesMoveIn = comparisonResult.matches
      damageDocumented = !comparisonResult.matches
    }

    // Photo count for move_*_photos_submitted event emission decision.
    const photoRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM unit_inspection_photos WHERE inspection_id=$1`,
      [req.params.id],
    )
    const photoCount = parseInt(photoRow?.n ?? '0', 10)

    // Resolve lease.start_date for move-in if applicable.
    let leaseStartDate: Date | null = null
    if (insp.inspection_type === 'move_in' && insp.lease_id) {
      const lease = await queryOne<{ start_date: string }>(
        `SELECT start_date FROM leases WHERE id=$1`,
        [insp.lease_id],
      )
      if (lease?.start_date) leaseStartDate = new Date(lease.start_date)
    }

    const finalizedAt = new Date()

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE unit_inspections
            SET status='finalized', finalized_at=NOW(), updated_at=NOW()
          WHERE id=$1`,
        [req.params.id],
      )
      await emitInspectionFinalizedEvents(client, {
        inspectionType: insp.inspection_type,
        tenantId: insp.tenant_id,
        landlordId: insp.landlord_id,
        inspectionId: req.params.id,
        finalizedAt,
        photoCount,
        leaseStartDate,
        matchesMoveIn,
        damageDocumented,
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // Best-effort post-finalize notification. Pings tenant + responsible
    // party with the credit-ledger outcome. S186: landlord side routed
    // through resolver — inspection finalization is operational.
    try {
      const unitCtx = await queryOne<{ property_id: string; unit_number: string | null }>(
        `SELECT property_id, unit_number FROM units WHERE id = $1`,
        [insp.unit_id],
      )
      let tenantPing: { user_id: string; email: string } | null = null
      if (insp.tenant_id) {
        const t = await queryOne<{ user_id: string; email: string }>(
          `SELECT u.id AS user_id, u.email
             FROM tenants t JOIN users u ON u.id = t.user_id
            WHERE t.id = $1`,
          [insp.tenant_id],
        )
        if (t?.user_id && t?.email) tenantPing = { user_id: t.user_id, email: t.email }
      }
      if (unitCtx) {
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(unitCtx.property_id)
        if (targets) {
          for (const recipient of targets.primaries) {
            await notifyInspectionFinalized({
              tenantUserId:    tenantPing?.user_id,
              tenantEmail:     tenantPing?.email,
              landlordUserId:  recipient.user_id,
              landlordId:      insp.landlord_id,
              landlordEmail:   recipient.email,
              inspectionId:    insp.id,
              inspectionType:  insp.inspection_type,
              unitNumber:      unitCtx.unit_number ?? undefined,
              matchesMoveIn,
              damageDocumented,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] inspection finalize:')
    }

    res.json({
      success: true,
      data: {
        status: 'finalized',
        matches_move_in: matchesMoveIn,
        damage_documented: damageDocumented,
        photo_count: photoCount,
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── helpers ────────────────────────────────────────────────────

interface InspectionRow {
  id: string
  unit_id: string
  lease_id: string | null
  tenant_id: string | null
  landlord_id: string
  inspection_type: 'move_in' | 'move_out' | 'periodic'
  status: string
  comparison_inspection_id: string | null
  scheduled_for: string | null
  conducted_at: string | null
  finalized_at: string | null
  notes: string | null
}

async function loadInspectionRow(
  id: string,
  req: import('express').Request,
): Promise<InspectionRow> {
  const r = await queryOne<InspectionRow>(
    `SELECT id, unit_id, lease_id, tenant_id, landlord_id,
            inspection_type, status, comparison_inspection_id,
            scheduled_for, conducted_at, finalized_at, notes
       FROM unit_inspections
      WHERE id = $1`,
    [id],
  )
  if (!r) throw new AppError(404, 'Inspection not found')
  // Tenant may read own; landlord-side can read theirs; admin always.
  const u = req.user!
  if (u.role === 'tenant') {
    if (r.tenant_id !== u.profileId) throw new AppError(403, 'Not your inspection')
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

async function loadInspection(
  id: string,
  req: import('express').Request,
): Promise<{
  row: InspectionRow
  items: any[]
  photos: any[]
  signatures: any[]
}> {
  const row = await loadInspectionRow(id, req)
  const items = await query<any>(
    `SELECT id, area, item_label, condition, notes, estimated_repair_cost, created_at, updated_at
       FROM unit_inspection_items
      WHERE inspection_id = $1
      ORDER BY area, item_label`,
    [id],
  )
  const photos = await query<any>(
    `SELECT id, item_id, photo_url, caption, captured_live, uploaded_by, uploaded_at
       FROM unit_inspection_photos
      WHERE inspection_id = $1
      ORDER BY uploaded_at`,
    [id],
  )
  const signatures = await query<any>(
    `SELECT signer_user_id, signer_role, signed_at, signature_evidence
       FROM unit_inspection_signatures
      WHERE inspection_id = $1
      ORDER BY signed_at`,
    [id],
  )
  return { row, items, photos, signatures }
}

const CONDITION_RANK: Record<string, number> = {
  good: 0,
  fair: 1,
  damaged: 2,
  missing: 3,
}

async function compareMoveOutToMoveIn(
  moveOutId: string,
  moveInId: string,
): Promise<{ matches: boolean; mismatches: string[] }> {
  const moveInItems = await query<{ area: string; item_label: string; condition: string }>(
    `SELECT area, item_label, condition FROM unit_inspection_items WHERE inspection_id = $1`,
    [moveInId],
  )
  const moveOutItems = await query<{ area: string; item_label: string; condition: string }>(
    `SELECT area, item_label, condition FROM unit_inspection_items WHERE inspection_id = $1`,
    [moveOutId],
  )
  const inMap = new Map<string, string>()
  for (const it of moveInItems) {
    inMap.set(`${it.area}|${it.item_label}`, it.condition)
  }
  const mismatches: string[] = []
  for (const out of moveOutItems) {
    if (out.condition === 'na') continue
    const inCond = inMap.get(`${out.area}|${out.item_label}`)
    if (!inCond) continue // new item, not in comparison set
    if (inCond === 'na') continue
    if ((CONDITION_RANK[out.condition] ?? 0) > (CONDITION_RANK[inCond] ?? 0)) {
      mismatches.push(`${out.area}|${out.item_label}`)
    }
  }
  return { matches: mismatches.length === 0, mismatches }
}
