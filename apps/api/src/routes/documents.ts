import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { z } from 'zod'
import { DOCUMENT_CATEGORIES, REFERENCE_DOCUMENT_CATEGORIES } from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { landlordScopeIds, resolveLandlordTarget, landlordIdForUnit } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { streamStoredFile } from '../lib/fileServe'

export const documentsRouter = Router()
documentsRouter.use(requireAuth)

// W-45 (S529): upload directory for the catch-all Documents tab. Same
// disk-storage pattern as inspections/avatars.
const docsDir = path.join(process.cwd(), 'uploads', 'docs')
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true })
const docStorage = multer.diskStorage({
  destination: docsDir,
  filename: (_req: any, file: any, cb: any) =>
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
})
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (ok.includes(file.mimetype)) cb(null, true)
    else cb(new Error('PDF, image, or Word document only'))
  },
})

// Per-role landlord scoping (S69 posture). Returns { filter, params } to
// splice into a WHERE, or null when the caller sees nothing.
function scopeFor(user: any): { filter: string; params: any[] } | null {
  const role = user.role
  if (role === 'admin' || role === 'super_admin') return { filter: '', params: [] }
  // S620: own + co-owned entities, so a co-owner sees the same documents
  // the primary owner does.
  if (role === 'landlord') return { filter: 'AND d.landlord_id = ANY($1)', params: [landlordScopeIds(user)] }
  if (role === 'tenant') return { filter: 'AND d.tenant_id = $1', params: [user.profileId] }
  if (['property_manager', 'onsite_manager', 'maintenance', 'bookkeeper'].includes(role)) {
    if (!user.landlordId) return null
    return { filter: 'AND d.landlord_id = $1', params: [user.landlordId] }
  }
  return null
}

documentsRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req.user)
    if (!scope) return res.json({ success: true, data: [] })
    // W-45: join unit + tenant display fields — the page renders unitNumber /
    // tenantName / docType and previously fell back to "—" for all of them
    // (d.* alone never carried joins; same class as W-37/W-43).
    // S641: ?propertyId=<id> narrows to the filing cabinet for ONE park — the
    // documents pinned to it, plus anything unpinned, which is the "available
    // everywhere" default (a state disclosure, a lead-paint pamphlet).
    // Deliberately NOT a plain equality on property_id: the whole point of
    // pinning is that one parking-rules sheet serves two parks without being
    // uploaded twice.
    const propertyFilter = typeof req.query.propertyId === 'string' && req.query.propertyId
      ? req.query.propertyId : null
    const pi = scope.params.length + 1
    const propClause = propertyFilter
      ? `AND (
           d.property_id = $${pi}
           OR EXISTS (SELECT 1 FROM document_properties dp
                       WHERE dp.document_id = d.id AND dp.property_id = $${pi})
           OR (d.property_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM document_properties dp2 WHERE dp2.document_id = d.id))
         )`
      : ''
    const docs = await query<any>(
      `SELECT d.*, d.type AS doc_type,
              u.unit_number,
              COALESCE(dprop.name, p.name) AS property_name,
              tu.first_name || ' ' || tu.last_name AS tenant_name,
              COALESCE((SELECT array_agg(dp.property_id) FROM document_properties dp
                         WHERE dp.document_id = d.id), '{}') AS property_ids
         FROM documents d
         LEFT JOIN units u ON u.id = d.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         LEFT JOIN properties dprop ON dprop.id = d.property_id
         LEFT JOIN tenants t ON t.id = d.tenant_id
         LEFT JOIN users tu ON tu.id = t.user_id
        WHERE 1=1 ${scope.filter} ${propClause}
        ORDER BY d.is_reference DESC, d.created_at DESC`,
      propertyFilter ? [...scope.params, propertyFilter] : scope.params,
    )
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})

// W-45: authed same-tab file streaming for the /view route. Resolves the
// stored /uploads/... url to disk and streams it; a row whose file was never
// written 404s with a clear message instead of rendering a blank tab.
documentsRouter.get('/:id/file', async (req, res, next) => {
  try {
    const scope = scopeFor(req.user)
    if (!scope) throw new AppError(403, 'Forbidden')
    const doc = await queryOne<any>(
      `SELECT d.* FROM documents d WHERE d.id = $${scope.params.length + 1} ${scope.filter}`,
      [...scope.params, req.params.id],
    )
    if (!doc) throw new AppError(404, 'Document not found')
    // Authorized above (scopeFor); the helper owns path-safety + streaming.
    streamStoredFile(res, doc.url, doc.mime_type)
  } catch (e) { next(e) }
})

// W-45: the catch-all upload — one obvious place that takes any file, tagged
// with type/unit/tenant so filed docs still land in the right buckets.
const uploadMetaSchema = z.object({
  name:     z.string().min(1).max(200).optional(),
  type:     z.enum(DOCUMENT_CATEGORIES as unknown as [string, ...string[]]).default('other'),
  unitId:   z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  leaseId:  z.string().uuid().optional(),
  // S641: the filing cabinet. A reference document is about a PROPERTY, or
  // about several — "if I have parking rules at two of my properties and not a
  // third, I don't wanna have to upload it two times."
  propertyId:  z.string().uuid().optional(),
  propertyIds: z.union([
    z.array(z.string().uuid()).max(200),
    // multipart sends a repeated field or a JSON string
    z.string(),
  ]).optional(),
  isReference: z.union([z.boolean(), z.string()]).optional(),
})

/** multipart gives us a string, a repeated field, or nothing. */
function parsePropertyIds(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  const s = String(raw).trim()
  if (!s) return []
  if (s.startsWith('[')) { try { return JSON.parse(s).map(String) } catch { return [] } }
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

/**
 * S641 — which properties a document applies to.
 *
 * No rows means everywhere. Nic: "you never know what the next property you're
 * gonna buy is gonna have, and being able to reuse as many things as possible
 * for efficiency is the way to go." So a sheet is repinned as the portfolio
 * changes rather than re-uploaded.
 */
documentsRouter.get('/:id/properties', async (req, res, next) => {
  try {
    const scope = scopeFor(req.user)
    if (!scope) throw new AppError(403, 'Forbidden')
    const doc = await queryOne<{ id: string }>(
      `SELECT d.id FROM documents d WHERE d.id = $${scope.params.length + 1} ${scope.filter}`,
      [...scope.params, req.params.id])
    if (!doc) throw new AppError(404, 'Document not found')
    const rows = await query<{ property_id: string }>(
      `SELECT property_id FROM document_properties WHERE document_id = $1`, [req.params.id])
    res.json({ success: true, data: rows.map(r => r.property_id) })
  } catch (e) { next(e) }
})

documentsRouter.put('/:id/properties', requirePerm('documents.upload'), async (req, res, next) => {
  try {
    const body = z.object({ propertyIds: z.array(z.string().uuid()).max(200) }).parse(req.body)
    const doc = await queryOne<{ id: string }>(
      `SELECT id FROM documents WHERE id = $1 AND landlord_id = ANY($2::uuid[])`,
      [req.params.id, landlordScopeIds(req.user!)])
    if (!doc) throw new AppError(404, 'Document not found')

    // Ownership-checked before use — a pin must never reach a property this
    // account does not hold.
    const ids = [...new Set(body.propertyIds)]
    if (ids.length) {
      const owned = await query<{ id: string }>(
        `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])`,
        [ids, landlordScopeIds(req.user!)])
      if (owned.length !== ids.length) throw new AppError(403, 'One of those properties is not yours')
    }

    await query(`DELETE FROM document_properties WHERE document_id = $1`, [req.params.id])
    for (const pid of ids) {
      await query(`INSERT INTO document_properties (document_id, property_id)
                   VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, pid])
    }
    // Keep the single-property column agreeing with the pins, so a one-park
    // document still reads correctly anywhere that column is used.
    await query(`UPDATE documents SET property_id = $2 WHERE id = $1`,
      [req.params.id, ids.length === 1 ? ids[0] : null])
    res.json({ success: true, data: { propertyIds: ids } })
  } catch (e) { next(e) }
})

documentsRouter.post('/', requirePerm('documents.upload'), docUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const meta = uploadMetaSchema.parse(req.body)
    // S633: a document tagged to a unit belongs to the company that owns THAT
    // unit — derived, and authorised by the same lookup that used to be a
    // separate ownership check below. Untagged, the account names the company.
    // Previously this read the session's entity and then required the unit to
    // match it, so a document about the other company's unit was refused.
    const landlordId = meta.unitId
      ? await landlordIdForUnit(req.user!, meta.unitId, query)
      : resolveLandlordTarget(req.user!, req.body?.landlordId, 'document')
    // Body-supplied property ids are ownership-checked before use: a pin must
    // never reach a property this account does not hold.
    const pinIds = [...new Set([
      ...(meta.propertyId ? [meta.propertyId] : []),
      ...parsePropertyIds(meta.propertyIds),
    ])]
    if (pinIds.length) {
      const owned = await query<{ id: string }>(
        `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])`,
        [pinIds, landlordScopeIds(req.user!)])
      if (owned.length !== pinIds.length) throw new AppError(403, 'One of those properties is not yours')
    }

    const isReference = meta.isReference === true || String(meta.isReference) === 'true'
      || REFERENCE_DOCUMENT_CATEGORIES.includes(meta.type as any)

    const doc = await queryOne<any>(
      `INSERT INTO documents (landlord_id, unit_id, tenant_id, lease_id, property_id,
                              type, name, url, file_size, mime_type, is_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [landlordId, meta.unitId ?? null, meta.tenantId ?? null, meta.leaseId ?? null,
       pinIds.length === 1 ? pinIds[0] : (meta.propertyId ?? null),
       meta.type, meta.name || req.file.originalname, `/uploads/docs/${req.file.filename}`,
       req.file.size, req.file.mimetype, isReference],
    )
    for (const pid of pinIds) {
      await query(`INSERT INTO document_properties (document_id, property_id)
                   VALUES ($1,$2) ON CONFLICT DO NOTHING`, [doc.id, pid])
    }
    res.status(201).json({ success: true, data: { ...doc, propertyIds: pinIds } })
  } catch (e) { next(e) }
})
