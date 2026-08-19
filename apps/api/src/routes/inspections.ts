import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { emitInspectionFinalizedEvents } from '../services/creditLedgerEmitters'
import {
  notifyInspectionReadyForTenant,
  notifyInspectionTenantSigned,
  notifyInspectionFinalized,
  createNotification,
} from '../services/notifications'
import { addBusinessDays } from '../services/moveOutInspections'
import { logger } from '../lib/logger'
import { resolveUploadPath } from '../lib/uploadPaths'
import { insertInspectionWithChecklist } from '../services/inspections'
import { generateInspectionReportPdf } from '../services/inspectionReport'
import { INSPECTION_TYPES, INSPECTION_ITEM_CONDITIONS, INSPECTION_CONDITION_RANK, buildInspectionChecklist } from '@gam/shared'

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

inspectionsRouter.post('/', requirePerm('inspections.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const body = createSchema.parse(req.body)
    // unit_type + bedrooms drive the standard walkthrough checklist (single
    // source: buildInspectionChecklist) seeded below.
    const unit = await queryOne<{ id: string; landlord_id: string; bedrooms: number | null; bathrooms: number | null; unit_type: string | null; dwelling_ownership: string | null; is_multi_level: boolean | null; is_ada_accessible: boolean | null; living_areas: number | null; features: Record<string, unknown> | null; property_id: string }>(
      `SELECT id, landlord_id, bedrooms, bathrooms, unit_type, dwelling_ownership, is_multi_level, is_ada_accessible, living_areas, features, property_id FROM units WHERE id=$1`,
      [body.unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    // S550 property lock: team members only touch inspections on their
    // assigned properties (owner roles resolve to null = unrestricted).
    const scopedCreate = await getScopedPropertyIds(req.user)
    if (scopedCreate && !scopedCreate.includes(unit.property_id)) {
      throw new AppError(403, 'Property not in your assigned scope')
    }

    await client.query('BEGIN')
    const { id, seededItems } = await insertInspectionWithChecklist(client, {
      unitId: body.unitId,
      landlordId: unit.landlord_id,
      unitType: unit.unit_type,
      bedrooms: unit.bedrooms,
      bathrooms: unit.bathrooms,
      dwellingOwnership: unit.dwelling_ownership,
      isMultiLevel: unit.is_multi_level,
      isAdaAccessible: unit.is_ada_accessible,
      livingAreas: unit.living_areas,
      features: unit.features,
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

// ── GET /api/inspections/preview?unitId=…&inspectionType=… ─────
// S573: the pre-inspection review. Resolves the master template against the
// unit's CURRENT attributes WITHOUT creating anything — the landlord sees
// exactly what will be inspected and can catch a mis-set unit (missing second
// story, wrong ownership) and fix the UNIT first, then the checklist re-filters.
// Registered before '/:id' so 'preview' isn't captured as an inspection id.
inspectionsRouter.get('/preview', async (req, res, next) => {
  try {
    const unitId = String(req.query.unitId || '')
    if (!unitId) throw new AppError(400, 'unitId required')
    const inspectionType = req.query.inspectionType ? String(req.query.inspectionType) : null
    if (inspectionType && !(INSPECTION_TYPES as readonly string[]).includes(inspectionType)) {
      throw new AppError(400, `Invalid inspectionType '${inspectionType}'`)
    }
    const unit = await queryOne<{
      id: string; landlord_id: string; property_id: string; unit_number: string | null
      unit_type: string | null; bedrooms: number | null; bathrooms: number | null
      dwelling_ownership: string | null; is_multi_level: boolean | null; is_ada_accessible: boolean | null; living_areas: number | null; features: Record<string, unknown> | null
      property_name: string | null
    }>(
      `SELECT u.id, u.landlord_id, u.property_id, u.unit_number, u.unit_type, u.bedrooms, u.bathrooms,
              u.dwelling_ownership, u.is_multi_level, u.is_ada_accessible, u.living_areas, u.features, p.name AS property_name
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`,
      [unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const scoped = await getScopedPropertyIds(req.user)
    if (scoped && !scoped.includes(unit.property_id)) throw new AppError(403, 'Property not in your assigned scope')

    const checklist = buildInspectionChecklist({
      unitType: unit.unit_type,
      bedrooms: unit.bedrooms,
      bathrooms: unit.bathrooms,
      dwellingOwnership: unit.dwelling_ownership,
      isMultiLevel: unit.is_multi_level,
      isAdaAccessible: unit.is_ada_accessible,
      livingAreas: unit.living_areas,
      features: unit.features,
    })
    const itemCount = checklist.reduce((n, a) => n + a.items.length, 0)
    res.json({
      success: true,
      data: {
        unit: {
          id: unit.id, unitNumber: unit.unit_number, propertyName: unit.property_name,
          unitType: unit.unit_type, bedrooms: unit.bedrooms, bathrooms: unit.bathrooms,
          dwellingOwnership: unit.dwelling_ownership,
          isMultiLevel: !!unit.is_multi_level, isAdaAccessible: !!unit.is_ada_accessible,
        },
        inspectionType,
        checklist,
        areaCount: checklist.length,
        itemCount,
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── GET /api/inspections/:id/completeness (S573) ───────────────
// What still blocks submit/sign/finalize — items missing a condition, areas
// missing a photo, fair/damaged items missing a note. Drives the conduct UI.
inspectionsRouter.get('/:id/completeness', async (req, res, next) => {
  try {
    await loadInspectionRow(req.params.id, req) // authorizes access
    const c = await getInspectionCompleteness(req.params.id)
    res.json({ success: true, data: c })
  } catch (e) {
    next(e)
  }
})

// ── GET /api/inspections/:id — full detail ─────────────────────
inspectionsRouter.get('/:id', async (req, res, next) => {
  try {
    const { row, items, photos, signatures } = await loadInspection(req.params.id, req)
    // S549: the suspicious-flag reason and flagger are landlord-side only —
    // the tenant sees neutral copy (a scheduled in-person inspection), never
    // "your photos were flagged suspicious because …".
    const out: any = { ...row, items, photos, signatures }
    if (req.user!.role === 'tenant') {
      delete out.flag_reason
      delete out.flagged_by_user_id
      delete out.flagged_suspicious_at
      delete out.followup_inspection_id
    }
    res.json({ success: true, data: out })
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
      where += ` AND i.unit_id = $${params.length}`
    }
    if (req.query.tenantId) {
      params.push(req.query.tenantId)
      where += ` AND i.tenant_id = $${params.length}`
    }
    if (req.query.leaseId) {
      params.push(req.query.leaseId)
      where += ` AND i.lease_id = $${params.length}`
    }
    // S527 W-43: join unit number, property, and tenant name — the list used
    // to return bare ids and the page rendered UUID fragments as "Unit"/"Tenant".
    const rows = await query<any>(
      `SELECT i.id, i.unit_id, i.lease_id, i.tenant_id, i.landlord_id,
              i.inspection_type, i.status, i.comparison_inspection_id,
              i.scheduled_for, i.conducted_at, i.finalized_at,
              i.created_at, i.updated_at,
              i.flagged_suspicious_at, i.followup_inspection_id,
              u.unit_number, u.property_id, p.name AS property_name,
              tu.first_name AS tenant_first_name, tu.last_name AS tenant_last_name
         FROM unit_inspections i
         JOIN units u ON u.id = i.unit_id
         JOIN properties p ON p.id = u.property_id
         LEFT JOIN tenants t ON t.id = i.tenant_id
         LEFT JOIN users tu ON tu.id = t.user_id
        WHERE ${where}
        ORDER BY i.created_at DESC
        LIMIT 200`,
      params,
    )
    let filtered = rows.filter((r) =>
      req.user!.role === 'tenant'
        ? r.tenant_id === req.user!.profileId
        : canAccessLandlordResource(req.user, r.landlord_id),
    )
    // S550 property lock (Nic): the landlord sees everything; team members
    // see only inspections on their assigned properties.
    if (req.user!.role !== 'tenant') {
      const scoped = await getScopedPropertyIds(req.user)
      if (scoped) filtered = filtered.filter((r) => scoped.includes(r.property_id))
    }
    // S549: flag metadata is landlord-side only (see GET /:id).
    const out = req.user!.role === 'tenant'
      ? filtered.map(({ flagged_suspicious_at, followup_inspection_id, ...rest }) => rest)
      : filtered
    res.json({ success: true, data: out })
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
    // S585: per-row authorization (mirrors report-files / video-files). Photos
    // live in the SAME dir as the report PDFs, and this route previously served
    // any file in it to ANY authenticated user by filename — which (a) exposed
    // one tenant's inspection photos to another and (b) let a report PDF be
    // pulled through /photo-files/, bypassing report-files' own auth. Look up the
    // photo's inspection and scope the caller: the inspection's tenant, or the
    // landlord/scoped staff of the unit. A non-photo filename (e.g. a report)
    // matches no photo row → 404, which also closes the report bypass.
    const photoUrl = '/api/inspections/photo-files/' + req.params.filename
    const p = await queryOne<{ landlord_id: string; tenant_id: string | null; property_id: string }>(
      `SELECT i.landlord_id, i.tenant_id, un.property_id
         FROM unit_inspection_photos ph
         JOIN unit_inspections i ON i.id = ph.inspection_id
         JOIN units un ON un.id = i.unit_id
        WHERE ph.photo_url = $1`,
      [photoUrl],
    )
    if (!p) throw new AppError(404, 'Not found')
    const u = req.user!
    if (u.role === 'tenant') {
      if (p.tenant_id !== u.profileId) throw new AppError(403, 'Forbidden')
    } else {
      if (!canAccessLandlordResource(u, p.landlord_id)) throw new AppError(403, 'Forbidden')
      const scoped = await getScopedPropertyIds(u)
      if (scoped && !scoped.includes(p.property_id)) throw new AppError(403, 'Forbidden')
    }
    // S535: resolveUploadPath, not a raw path.join — an encoded slash
    // (%2F) decodes into the route param, so '..%2F..%2F...' would
    // traverse out of the photos dir. Same class as the S380 avatar
    // finding; the other file routes already use it.
    const fp = resolveUploadPath(inspectionPhotoDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
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
    const v = await queryOne<{ uploaded_by: string; landlord_id: string; property_id: string }>(
      `SELECT v.uploaded_by, i.landlord_id, un.property_id
         FROM unit_inspection_videos v
         JOIN unit_inspections i ON i.id = v.inspection_id
         JOIN units un ON un.id = i.unit_id
        WHERE v.video_url = $1`,
      [videoUrl],
    )
    if (!v) throw new AppError(404, 'Not found')
    const u = req.user!
    let allowed =
      u.role === 'admin' ||
      u.role === 'super_admin' ||
      v.uploaded_by === u.userId ||
      canAccessLandlordResource(u, v.landlord_id)
    // S550 property lock: landlord-side access to someone else's upload is
    // additionally bounded by the caller's property scope.
    if (allowed && v.uploaded_by !== u.userId &&
        u.role !== 'admin' && u.role !== 'super_admin') {
      const scoped = await getScopedPropertyIds(u)
      if (scoped && !scoped.includes(v.property_id)) allowed = false
    }
    if (!allowed) throw new AppError(403, 'Forbidden')

    const fp = resolveUploadPath(inspectionVideoDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch (e) {
    next(e)
  }
})

// GET /api/inspections/report-files/:filename (S573) — serve a finalized
// inspection's summary PDF. Authorized per-row: the inspection's tenant (their
// own report), or the landlord/scoped staff of the unit.
inspectionsRouter.get('/report-files/:filename', async (req, res, next) => {
  try {
    const reportUrl = '/api/inspections/report-files/' + req.params.filename
    const r = await queryOne<{ landlord_id: string; tenant_id: string | null; property_id: string }>(
      `SELECT i.landlord_id, i.tenant_id, un.property_id
         FROM unit_inspections i JOIN units un ON un.id = i.unit_id
        WHERE i.report_url = $1`,
      [reportUrl],
    )
    if (!r) throw new AppError(404, 'Not found')
    const u = req.user!
    if (u.role === 'tenant') {
      if (r.tenant_id !== u.profileId) throw new AppError(403, 'Forbidden')
    } else {
      if (!canAccessLandlordResource(u, r.landlord_id)) throw new AppError(403, 'Forbidden')
      const scoped = await getScopedPropertyIds(u)
      if (scoped && !scoped.includes(r.property_id)) throw new AppError(403, 'Forbidden')
    }
    const fp = resolveUploadPath(inspectionPhotoDir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.setHeader('Content-Type', 'application/pdf')
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
    const unit = await queryOne<{ id: string; landlord_id: string; unit_number: string | null; property_id: string }>(
      `SELECT id, landlord_id, unit_number, property_id FROM units WHERE id = $1`,
      [req.params.unitId],
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const scopedLc = await getScopedPropertyIds(req.user)
    if (scopedLc && !scopedLc.includes(unit.property_id)) {
      throw new AppError(403, 'Property not in your assigned scope')
    }

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
      // S550 (Nic): the tenant signs the MOVE-IN inspection only — their
      // certification of the photos and documented conditions. Everywhere
      // else, being logged into their own portal IS the attestation
      // (periodic uses POST /:id/submit; move-out is staff-conducted).
      if (insp.inspection_type !== 'move_in') {
        throw new AppError(409, 'Tenant signature only applies to move-in inspections')
      }
      // S573: the tenant certifies a COMPLETE walk — condition + photo per area
      // + note on any fair/damaged item — before they can sign.
      const signComplete = await getInspectionCompleteness(req.params.id)
      if (!signComplete.complete) throw new AppError(409, completenessMessage(signComplete))
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
    // Tenant signature is a MOVE-IN-ONLY requirement (Nic, S550): at move-in
    // the tenant certifies their photos and documented conditions. Periodic
    // and move-out inspections are staff-conducted under the legally required
    // entry notice — the tenant gets notice, not a veto, so the landlord/
    // inspector signature alone reaches landlord_signed. A tenant on the
    // inspection may still sign (extra attestation), it just isn't gating.
    // Tenant-less inspections likewise finalize on the landlord signature.
    const tenantRequired = insp.tenant_id != null && insp.inspection_type === 'move_in'
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

// ── POST /api/inspections/:id/submit ───────────────────────────
// S550 (Nic): the tenant does NOT sign a periodic inspection — they took
// the photos while authenticated in their own portal, and that IS their
// attestation. This is the signature-less "I'm done, review it" action for
// the self-directed periodic flow: it flips the record to tenant_signed
// (the same status the front-desk verdict queue reads — displayed as
// "Submitted for review") without writing any signature row, stamps
// conducted_at, and pings the property's responsible party.
inspectionsRouter.post('/:id/submit', async (req, res, next) => {
  try {
    const insp = await loadInspectionRow(req.params.id, req)
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenant submission only')
    if (insp.tenant_id !== req.user!.profileId) throw new AppError(403, 'Not your inspection')
    if (insp.inspection_type !== 'periodic') {
      throw new AppError(409, 'Only periodic inspections are tenant-submitted')
    }
    if (insp.status !== 'draft') throw new AppError(409, `cannot submit in status ${insp.status}`)
    // S573: a tenant's periodic self-walk is PHOTO documentation — require a
    // photo per area (+ a note on anything they flagged damaged), but not a
    // condition rating on every item (staff assess conditions on review).
    const submitC = await getInspectionCompleteness(req.params.id)
    if (submitC.areasMissingPhoto.length > 0 || submitC.itemsMissingNote > 0) {
      const parts: string[] = []
      if (submitC.areasMissingPhoto.length) parts.push(`${submitC.areasMissingPhoto.length} area(s) still need a photo (${submitC.areasMissingPhoto.slice(0, 4).join(', ')}${submitC.areasMissingPhoto.length > 4 ? '…' : ''})`)
      if (submitC.itemsMissingNote) parts.push(`${submitC.itemsMissingNote} flagged item(s) need a note`)
      throw new AppError(409, 'Not ready to submit — ' + parts.join('; ') + '.')
    }

    await query(
      `UPDATE unit_inspections
          SET status = 'tenant_signed', conducted_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [req.params.id],
    )

    // Best-effort: tell the front desk there's a submission to review.
    try {
      const ctx = await queryOne<{ property_id: string; unit_number: string | null }>(
        `SELECT property_id, unit_number FROM units WHERE id = $1`,
        [insp.unit_id],
      )
      const tenant = await queryOne<{ first_name: string | null; last_name: string | null }>(
        `SELECT u.first_name, u.last_name
           FROM tenants t JOIN users u ON u.id = t.user_id
          WHERE t.id = $1`,
        [insp.tenant_id],
      )
      if (ctx) {
        const { getPropertyResponsibleParty } = await import('../services/responsibleParty')
        const targets = await getPropertyResponsibleParty(ctx.property_id)
        if (targets) {
          const tenantName =
            `${tenant?.first_name ?? ''} ${tenant?.last_name ?? ''}`.trim() || 'The tenant'
          const body =
            `${tenantName} completed their periodic inspection walkthrough for unit ` +
            `${ctx.unit_number ?? insp.unit_id.slice(0, 8)} — review the photos and pass or flag it.`
          for (const recipient of targets.primaries) {
            await createNotification({
              userId: recipient.user_id, landlordId: insp.landlord_id,
              type: 'inspection_submitted',
              title: `Periodic inspection submitted — unit ${ctx.unit_number ?? ''}`.trim(),
              body,
              data: { inspectionId: insp.id, unitId: insp.unit_id },
              actionUrl: `/inspections/${insp.id}`,
              sendEmail: true, emailTo: recipient.email,
              emailSubject: `Periodic inspection submitted — unit ${ctx.unit_number ?? ''}`.trim(),
              emailHtml: body,
            })
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] inspection submit:')
    }

    res.json({ success: true, data: { status: 'tenant_signed' } })
  } catch (e) {
    next(e)
  }
})

// ── POST /api/inspections/:id/finalize ─────────────────────────
// Landlord-only. Requires both tenant + landlord signatures present.
// Emits credit-ledger events transactionally.
inspectionsRouter.post('/:id/finalize', requirePerm('inspections.manage'), async (req, res, next) => {
  try {
    const insp = await loadInspectionRow(req.params.id, req)
    if (!canManageLandlordResource(req.user, insp.landlord_id)) {
      throw new AppError(403, 'Only landlord can finalize')
    }
    if (insp.status === 'finalized') throw new AppError(409, 'Already finalized')
    if (insp.status !== 'landlord_signed') {
      throw new AppError(409, `cannot finalize from status ${insp.status} (need both signatures)`)
    }
    // S573: authoritative completeness gate — condition on every item, a photo
    // per area, a note on every fair/damaged item.
    const finalizeComplete = await getInspectionCompleteness(req.params.id)
    if (!finalizeComplete.complete) throw new AppError(409, completenessMessage(finalizeComplete))

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
      // S550: assess the lease's conditional fees from their linked
      // 'Lease conditions' items — good/fair = condition met (no charge),
      // damaged/missing = failed (the fee joins the S180 deposit sweep).
      // 'na' stays unassessed (never charges). Same transaction as the
      // status flip so the deposit sweep can trust condition_result.
      await client.query(
        `UPDATE lease_fees lf
            SET condition_result = CASE
                  WHEN i.condition IN ('excellent', 'good', 'fair') THEN 'met'
                  WHEN i.condition = 'damaged_missing' THEN 'failed'
                END,
                condition_assessed_at = NOW(),
                condition_assessed_by = $2,
                updated_at = NOW()
           FROM unit_inspection_items i
          WHERE i.inspection_id = $1
            AND i.lease_fee_id = lf.id
            AND i.condition IN ('excellent', 'good', 'fair', 'damaged_missing')
            AND lf.condition_result IS NULL`,
        [req.params.id, req.user!.userId],
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

    // S573: generate + file the summary report. Best-effort — a report failure
    // must NEVER unwind a finalized inspection. report_url = landlord reporting;
    // a documents row (tenant_id set) surfaces it in the tenant's Documents tab.
    try {
      const report = await generateInspectionReportPdf(req.params.id)
      const docType = insp.inspection_type === 'move_in' ? 'move_in_checklist'
        : insp.inspection_type === 'move_out' ? 'move_out_checklist' : 'other'
      const TYPE_LABEL: Record<string, string> = { move_in: 'Move-in', move_out: 'Move-out', periodic: 'Periodic', turnover: 'Turnover' }
      const un = await queryOne<{ unit_number: string | null }>(`SELECT unit_number FROM units WHERE id=$1`, [insp.unit_id])
      const name = `${TYPE_LABEL[insp.inspection_type] ?? 'Inspection'} inspection — Unit ${un?.unit_number ?? ''} — ${finalizedAt.toLocaleDateString('en-US')}`.trim()
      await query(`UPDATE unit_inspections SET report_url=$1, report_generated_at=NOW() WHERE id=$2`, [report.fileUrl, req.params.id])
      await query(
        `INSERT INTO documents (landlord_id, unit_id, tenant_id, lease_id, type, name, url, file_size, mime_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf')`,
        [insp.landlord_id, insp.unit_id, insp.tenant_id ?? null, insp.lease_id ?? null, docType, name.slice(0, 200), report.fileUrl, report.fileSize],
      )
    } catch (e) {
      logger.error({ err: e, inspectionId: req.params.id }, 'inspection summary report generation failed')
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

// ── POST /api/inspections/:id/flag-suspicious ──────────────────
// S549 verdict loop: the front desk reviews a tenant-self-directed periodic
// inspection (agent-guided photos) and either PASSES it — the normal sign +
// finalize path above — or flags it here. Flagging closes the tenant-
// submitted record (status -> cancelled; photos preserved read-only, no
// credit events) and auto-schedules an IN-PERSON physical inspection three
// business days out, linked back via comparison_inspection_id so the
// inspector has the tenant's photos side-by-side.
//
// The follow-up carries NO tenant_id on purpose: it is staff-conducted, so
// the landlord/inspector signature alone reaches landlord_signed — a tenant
// who won't sign can't stall the loop. The tenant is notified with neutral
// copy only; the flag reason never leaves the landlord side.
const flagSchema = z.object({ reason: z.string().trim().min(3) })

inspectionsRouter.post('/:id/flag-suspicious', requirePerm('inspections.manage'), async (req, res, next) => {
  const client = await getClient()
  try {
    const body = flagSchema.parse(req.body)
    const insp = await loadInspectionRow(req.params.id, req)
    if (!canManageLandlordResource(req.user, insp.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (insp.inspection_type !== 'periodic') {
      throw new AppError(409, 'Only periodic inspections can be flagged')
    }
    if (!insp.tenant_id) {
      throw new AppError(409, 'Only tenant-submitted inspections can be flagged')
    }
    if (insp.status === 'finalized' || insp.status === 'cancelled') {
      throw new AppError(409, `cannot flag in status ${insp.status}`)
    }
    if (insp.flagged_suspicious_at) throw new AppError(409, 'Already flagged')

    const unit = await queryOne<{
      bedrooms: number | null; bathrooms: number | null; unit_type: string | null; dwelling_ownership: string | null; is_multi_level: boolean | null; is_ada_accessible: boolean | null; living_areas: number | null; features: Record<string, unknown> | null
      unit_number: string | null; property_id: string; property_name: string
    }>(
      `SELECT u.bedrooms, u.bathrooms, u.unit_type, u.dwelling_ownership, u.is_multi_level, u.is_ada_accessible, u.living_areas, u.features, u.unit_number, u.property_id,
              p.name AS property_name
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`,
      [insp.unit_id],
    )
    if (!unit) throw new AppError(404, 'Unit not found')

    const scheduledFor = addBusinessDays(new Date().toISOString().slice(0, 10), 3)

    await client.query('BEGIN')
    const { id: followupId } = await insertInspectionWithChecklist(client, {
      unitId: insp.unit_id,
      landlordId: insp.landlord_id,
      unitType: unit.unit_type,
      bedrooms: unit.bedrooms,
      bathrooms: unit.bathrooms,
      dwellingOwnership: unit.dwelling_ownership,
      isMultiLevel: unit.is_multi_level,
      isAdaAccessible: unit.is_ada_accessible,
      livingAreas: unit.living_areas,
      features: unit.features,
      leaseId: insp.lease_id,
      tenantId: null,
      inspectionType: 'periodic',
      comparisonInspectionId: insp.id,
      scheduledFor,
      notes: 'In-person follow-up — tenant-submitted periodic inspection flagged for physical verification.',
    })
    await client.query(
      `UPDATE unit_inspections
          SET status = 'cancelled', flagged_suspicious_at = NOW(),
              flagged_by_user_id = $1, flag_reason = $2,
              followup_inspection_id = $3, updated_at = NOW()
        WHERE id = $4`,
      [req.user!.userId, body.reason, followupId, insp.id],
    )
    await client.query('COMMIT')

    // Best-effort notifications after commit.
    try {
      // Landlord + property-assigned staff who can conduct the follow-up
      // (same recipient shape as scheduleMoveOutInspections).
      const landlord = await queryOne<{ user_id: string; email: string }>(
        `SELECT lo.user_id, us.email FROM landlords lo JOIN users us ON us.id = lo.user_id
          WHERE lo.id = $1`,
        [insp.landlord_id],
      )
      const staff = await query<{ user_id: string; email: string }>(
        `SELECT DISTINCT u2.id AS user_id, u2.email FROM (
            SELECT user_id FROM property_manager_scopes
             WHERE landlord_id = $1 AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
            UNION
            SELECT user_id FROM onsite_manager_scopes
             WHERE landlord_id = $1 AND (all_properties = TRUE OR $2::uuid = ANY(property_ids))
          ) s JOIN users u2 ON u2.id = s.user_id`,
        [insp.landlord_id, unit.property_id],
      )
      const recipients = [
        ...(landlord ? [landlord] : []),
        ...staff.filter((s) => s.user_id !== landlord?.user_id),
      ]
      const staffBody =
        `Unit ${unit.unit_number} at ${unit.property_name} — a tenant-submitted periodic ` +
        `inspection was flagged as suspicious: "${body.reason}". An in-person inspection ` +
        `is scheduled for ${scheduledFor}.`
      for (const r of recipients) {
        if (r.user_id === req.user!.userId) continue // the flagger already knows
        await createNotification({
          userId: r.user_id, landlordId: insp.landlord_id,
          type: 'inspection_flagged_suspicious',
          title: `In-person inspection needed — unit ${unit.unit_number}`,
          body: staffBody,
          data: { inspectionId: followupId, flaggedInspectionId: insp.id, unitId: insp.unit_id, scheduledFor },
          actionUrl: `/inspections/${followupId}`,
          sendEmail: true, emailTo: r.email,
          emailSubject: `In-person inspection scheduled for ${scheduledFor} — unit ${unit.unit_number}`,
          emailHtml: staffBody,
        })
      }
      // Tenant — neutral copy only (never "suspicious", never the reason).
      const t = await queryOne<{ user_id: string; email: string }>(
        `SELECT u.id AS user_id, u.email
           FROM tenants tn JOIN users u ON u.id = tn.user_id
          WHERE tn.id = $1`,
        [insp.tenant_id],
      )
      if (t) {
        const tenantBody =
          `A routine in-person inspection of your unit is scheduled for ${scheduledFor}. ` +
          `A member of the property staff will conduct it.`
        await createNotification({
          userId: t.user_id, landlordId: insp.landlord_id,
          type: 'inspection_scheduled',
          title: 'In-person inspection scheduled',
          body: tenantBody,
          data: { scheduledFor },
          actionUrl: '/inspections',
          sendEmail: true, emailTo: t.email,
          emailSubject: `In-person inspection scheduled for ${scheduledFor}`,
          emailHtml: tenantBody,
        })
      }
    } catch (e) {
      logger.error({ err: e }, '[NOTIFY] inspection flag-suspicious:')
    }

    res.json({ success: true, data: { followupInspectionId: followupId, scheduledFor } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
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
  flagged_suspicious_at: string | null
  flagged_by_user_id: string | null
  flag_reason: string | null
  followup_inspection_id: string | null
  property_id: string
}

async function loadInspectionRow(
  id: string,
  req: import('express').Request,
): Promise<InspectionRow> {
  const r = await queryOne<InspectionRow>(
    `SELECT i.id, i.unit_id, i.lease_id, i.tenant_id, i.landlord_id,
            i.inspection_type, i.status, i.comparison_inspection_id,
            i.scheduled_for, i.conducted_at, i.finalized_at, i.notes,
            i.flagged_suspicious_at, i.flagged_by_user_id, i.flag_reason,
            i.followup_inspection_id, i.report_url, i.report_generated_at,
            un.property_id, un.unit_number, un.unit_type, p.name AS property_name,
            tu.first_name AS tenant_first_name, tu.last_name AS tenant_last_name
       FROM unit_inspections i
       JOIN units un ON un.id = i.unit_id
       JOIN properties p ON p.id = un.property_id
       LEFT JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN users tu ON tu.id = t.user_id
      WHERE i.id = $1`,
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
    // S550 property lock: team members only reach inspections on their
    // assigned properties (null = owner/all-properties, unrestricted).
    const scoped = await getScopedPropertyIds(u)
    if (scoped && !scoped.includes(r.property_id)) {
      throw new AppError(403, 'Property not in your assigned scope')
    }
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

// S573 (Nic): an inspection is COMPLETE (ready to submit / sign-off / finalize)
// when every seeded item has a condition, every AREA has ≥1 photo, and every
// Fair / Damaged-or-Missing item carries a note (the "what's wrong" context).
// Photo is mandatory per area; the note rides the photo and is required only on
// a non-good condition. Same standard for staff-in-person and tenant-remote.
interface InspectionCompleteness {
  complete: boolean
  itemsMissingCondition: number
  itemsMissingNote: number
  areasMissingPhoto: string[]
  totalAreas: number
}
async function getInspectionCompleteness(inspectionId: string): Promise<InspectionCompleteness> {
  const items = await query<{ area: string; condition: string | null; notes: string | null }>(
    `SELECT area, condition, notes FROM unit_inspection_items WHERE inspection_id = $1`, [inspectionId])
  const photoAreas = await query<{ area: string }>(
    `SELECT DISTINCT i.area FROM unit_inspection_items i
       JOIN unit_inspection_photos p ON p.item_id = i.id
      WHERE i.inspection_id = $1`, [inspectionId])
  const areasWithPhoto = new Set(photoAreas.map(r => r.area))
  const allAreas = Array.from(new Set(items.map(i => i.area)))
  const itemsMissingCondition = items.filter(i => !i.condition).length
  const itemsMissingNote = items.filter(i =>
    (i.condition === 'fair' || i.condition === 'damaged_missing') && !(i.notes && i.notes.trim())).length
  const areasMissingPhoto = allAreas.filter(a => !areasWithPhoto.has(a))
  return {
    complete: itemsMissingCondition === 0 && itemsMissingNote === 0 && areasMissingPhoto.length === 0,
    itemsMissingCondition, itemsMissingNote, areasMissingPhoto, totalAreas: allAreas.length,
  }
}
function completenessMessage(c: InspectionCompleteness): string {
  const parts: string[] = []
  if (c.itemsMissingCondition) parts.push(`${c.itemsMissingCondition} item(s) still need a condition`)
  if (c.areasMissingPhoto.length) parts.push(`${c.areasMissingPhoto.length} area(s) need a photo (${c.areasMissingPhoto.slice(0, 4).join(', ')}${c.areasMissingPhoto.length > 4 ? '…' : ''})`)
  if (c.itemsMissingNote) parts.push(`${c.itemsMissingNote} fair/damaged item(s) need a note`)
  return 'Inspection not complete — ' + parts.join('; ') + '.'
}

async function compareMoveOutToMoveIn(
  moveOutId: string,
  moveInId: string,
): Promise<{ matches: boolean; mismatches: string[] }> {
  const moveInItems = await query<{ area: string; item_label: string; condition: string | null }>(
    `SELECT area, item_label, condition FROM unit_inspection_items WHERE inspection_id = $1`,
    [moveInId],
  )
  const moveOutItems = await query<{ area: string; item_label: string; condition: string | null }>(
    `SELECT area, item_label, condition FROM unit_inspection_items WHERE inspection_id = $1`,
    [moveOutId],
  )
  const inMap = new Map<string, string>()
  for (const it of moveInItems) {
    if (it.condition) inMap.set(`${it.area}|${it.item_label}`, it.condition)
  }
  const mismatches: string[] = []
  for (const out of moveOutItems) {
    if (!out.condition) continue // not inspected — nothing to compare
    const inCond = inMap.get(`${out.area}|${out.item_label}`)
    if (!inCond) continue // new / not-inspected at move-in
    if (out.condition === 'na' || inCond === 'na') continue // N/A excluded from the comparison
    if ((INSPECTION_CONDITION_RANK[out.condition] ?? 0) > (INSPECTION_CONDITION_RANK[inCond] ?? 0)) {
      mismatches.push(`${out.area}|${out.item_label}`)
    }
  }
  return { matches: mismatches.length === 0, mismatches }
}
