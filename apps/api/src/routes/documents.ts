import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { z } from 'zod'
import { DOCUMENT_CATEGORIES } from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
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
  if (role === 'landlord') return { filter: 'AND d.landlord_id = $1', params: [user.profileId] }
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
    const docs = await query<any>(
      `SELECT d.*, d.type AS doc_type,
              u.unit_number, p.name AS property_name,
              tu.first_name || ' ' || tu.last_name AS tenant_name
         FROM documents d
         LEFT JOIN units u ON u.id = d.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         LEFT JOIN tenants t ON t.id = d.tenant_id
         LEFT JOIN users tu ON tu.id = t.user_id
        WHERE 1=1 ${scope.filter}
        ORDER BY d.created_at DESC`,
      scope.params,
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
})

documentsRouter.post('/', requirePerm('documents.upload'), docUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const meta = uploadMetaSchema.parse(req.body)
    const landlordId = req.user!.role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    if (!landlordId) throw new AppError(403, 'Forbidden')
    // A tagged unit must belong to the caller's landlord.
    if (meta.unitId) {
      const unit = await queryOne<any>('SELECT id FROM units WHERE id=$1 AND landlord_id=$2', [meta.unitId, landlordId])
      if (!unit) throw new AppError(404, 'Unit not found')
    }
    const doc = await queryOne<any>(
      `INSERT INTO documents (landlord_id, unit_id, tenant_id, lease_id, type, name, url, file_size, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [landlordId, meta.unitId ?? null, meta.tenantId ?? null, meta.leaseId ?? null, meta.type,
       meta.name || req.file.originalname, `/uploads/docs/${req.file.filename}`,
       req.file.size, req.file.mimetype],
    )
    res.status(201).json({ success: true, data: doc })
  } catch (e) { next(e) }
})
