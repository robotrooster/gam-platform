/**
 * S509 — file attachments for business-portal entities.
 *
 * Endpoints:
 *   POST   /api/business-attachments                — multipart upload
 *   GET    /api/business-attachments?entityType&entityId
 *                                                    — list for an entity
 *   GET    /api/business-attachments/:id/download   — stream the file
 *   DELETE /api/business-attachments/:id            — remove (DB + disk)
 *
 * Polymorphic — `entity_type` is one of work_order, customer, quote,
 * invoice, inventory_item. The route looks up the parent row to
 * verify cross-business isolation AND to gate the upload by the
 * correct permission for that entity type (e.g. attaching to a WO
 * requires work_orders.write).
 *
 * Files land under apps/api/uploads/business-attachments/<businessId>/
 * with a uuid-renamed filename. Stored mime type is whitelisted in
 * the multer fileFilter (images + PDFs in v1).
 */

import { Router, Request } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'
import { BusinessStaffPermission } from '@gam/shared'

export const businessAttachmentsRouter = Router()

// ── Storage config ────────────────────────────────────────────

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'business-attachments')
const MAX_FILE_SIZE = 20 * 1024 * 1024   // 20MB

// Allowed MIMEs — images + PDFs in v1. Word/Excel could come later but
// add risk surface; ask before adding.
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
])

const upload = multer({
  storage: multer.memoryStorage(),  // we route the bytes to disk ourselves
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true)
    else cb(new Error(`MIME type ${file.mimetype} not allowed`))
  },
})

// ── Entity type → permission + parent lookup ──────────────────

type EntityType = 'work_order' | 'customer' | 'quote' | 'invoice' | 'inventory_item'

const ENTITY_CONFIG: Record<EntityType, {
  permission: { read: BusinessStaffPermission; write: BusinessStaffPermission };
  feature?: string;
  table: string;
}> = {
  work_order:     { permission: { read: 'work_orders.read', write: 'work_orders.write' },
                    feature: 'work_orders', table: 'business_work_orders' },
  customer:       { permission: { read: 'customers.read',   write: 'customers.write' },
                    table: 'business_customers' },
  quote:          { permission: { read: 'quotes.read',      write: 'quotes.write' },
                    feature: 'quotes', table: 'business_quotes' },
  invoice:        { permission: { read: 'invoices.read',    write: 'invoices.write' },
                    feature: 'invoicing', table: 'business_invoices' },
  inventory_item: { permission: { read: 'inventory.read',   write: 'inventory.write' },
                    feature: 'inventory', table: 'business_inventory_items' },
}

async function verifyEntityBelongs(businessId: string, entityType: EntityType, entityId: string): Promise<void> {
  const cfg = ENTITY_CONFIG[entityType]
  const r = await queryOne<{ id: string }>(
    `SELECT id FROM ${cfg.table} WHERE id = $1 AND business_id = $2`,
    [entityId, businessId])
  if (!r) throw new AppError(404, `${entityType.replace('_', ' ')} not found`)
}

// ── POST / — upload ──────────────────────────────────────────

const uploadFieldsSchema = z.object({
  entityType:  z.enum(['work_order', 'customer', 'quote', 'invoice', 'inventory_item']),
  entityId:    z.string().uuid(),
  description: z.string().max(500).optional(),
  isInternal:  z.union([z.boolean(), z.string()]).optional(),
})

businessAttachmentsRouter.post('/', requireAuth, upload.single('file'),
  async (req: Request, res, next) => {
    try {
      const file = req.file
      if (!file) throw new AppError(400, 'file field required (multipart form-data)')
      const fields = uploadFieldsSchema.parse(req.body)
      const entityType = fields.entityType as EntityType
      const cfg = ENTITY_CONFIG[entityType]
      const access = await requireBusinessAccess(req, {
        permission: cfg.permission.write,
        feature: cfg.feature,
      })
      await verifyEntityBelongs(access.businessId, entityType, fields.entityId)

      // isInternal can arrive as string from multipart — normalize.
      const isInternal = fields.isInternal === true
        || fields.isInternal === 'true'
        || fields.isInternal === '1'

      // Write to disk: uploads/business-attachments/<businessId>/<uuid>.<ext>
      const ext = path.extname(file.originalname).slice(0, 8)  // cap pathological ext lengths
      const storedFilename = `${crypto.randomUUID()}${ext}`
      const bizDir = path.join(UPLOAD_ROOT, access.businessId)
      fs.mkdirSync(bizDir, { recursive: true })
      const finalPath = path.join(bizDir, storedFilename)
      fs.writeFileSync(finalPath, file.buffer)

      try {
        const row = await queryOne<any>(
          `INSERT INTO business_attachments
             (business_id, entity_type, entity_id,
              file_name, file_size_bytes, mime_type, stored_filename,
              description, is_internal, uploaded_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, entity_type, entity_id, file_name, file_size_bytes,
                     mime_type, description, is_internal, created_at`,
          [access.businessId, entityType, fields.entityId,
           file.originalname, file.size, file.mimetype, storedFilename,
           fields.description?.trim() || null, isInternal,
           access.staffUserRowId === null ? req.user!.userId : req.user!.userId])
        res.status(201).json({ success: true, data: row })
      } catch (e) {
        // DB insert failed — best-effort cleanup of the disk file so we
        // don't leak storage.
        fs.unlink(finalPath, () => {})
        throw e
      }
    } catch (e) { next(e) }
  })

// ── GET / — list for an entity ───────────────────────────────

const listSchema = z.object({
  entityType:  z.enum(['work_order', 'customer', 'quote', 'invoice', 'inventory_item']),
  entityId:    z.string().uuid(),
})

businessAttachmentsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = listSchema.parse(req.query)
    const cfg = ENTITY_CONFIG[q.entityType as EntityType]
    const access = await requireBusinessAccess(req, {
      permission: cfg.permission.read,
      feature: cfg.feature,
    })
    await verifyEntityBelongs(access.businessId, q.entityType as EntityType, q.entityId)
    const rows = await query<any>(
      `SELECT id, entity_type, entity_id,
              file_name, file_size_bytes, mime_type,
              description, is_internal,
              uploaded_by_user_id, created_at
         FROM business_attachments
        WHERE business_id = $1
          AND entity_type = $2
          AND entity_id   = $3
        ORDER BY created_at DESC`,
      [access.businessId, q.entityType, q.entityId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── GET /:id/download — stream the file ──────────────────────

businessAttachmentsRouter.get('/:id/download', requireAuth, async (req, res, next) => {
  try {
    // Load the row first (without permission check) to know which
    // entity it belongs to → load its parent → apply that parent's
    // read permission. This keeps the per-entity gating consistent.
    const att = await queryOne<{
      id: string; business_id: string; entity_type: EntityType;
      file_name: string; mime_type: string; stored_filename: string;
    }>(
      `SELECT id, business_id, entity_type, file_name, mime_type, stored_filename
         FROM business_attachments
        WHERE id = $1`, [req.params.id])
    if (!att) throw new AppError(404, 'Attachment not found')
    const cfg = ENTITY_CONFIG[att.entity_type]
    const access = await requireBusinessAccess(req, {
      permission: cfg.permission.read,
      feature: cfg.feature,
    })
    if (access.businessId !== att.business_id) {
      throw new AppError(404, 'Attachment not found')
    }
    const filePath = path.join(UPLOAD_ROOT, att.business_id, att.stored_filename)
    if (!fs.existsSync(filePath)) {
      throw new AppError(410, 'File no longer on disk')
    }
    res.setHeader('Content-Type', att.mime_type)
    res.setHeader('Content-Disposition', `inline; filename="${att.file_name.replace(/"/g, '')}"`)
    fs.createReadStream(filePath).pipe(res)
  } catch (e) { next(e) }
})

// ── DELETE /:id ───────────────────────────────────────────────

businessAttachmentsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const att = await queryOne<{
      id: string; business_id: string; entity_type: EntityType; stored_filename: string;
    }>(
      `SELECT id, business_id, entity_type, stored_filename
         FROM business_attachments
        WHERE id = $1`, [req.params.id])
    if (!att) throw new AppError(404, 'Attachment not found')
    const cfg = ENTITY_CONFIG[att.entity_type]
    const access = await requireBusinessAccess(req, {
      permission: cfg.permission.write,
      feature: cfg.feature,
    })
    if (access.businessId !== att.business_id) {
      throw new AppError(404, 'Attachment not found')
    }
    await db.query(`DELETE FROM business_attachments WHERE id = $1`, [att.id])
    // Best-effort disk cleanup.
    const filePath = path.join(UPLOAD_ROOT, att.business_id, att.stored_filename)
    fs.unlink(filePath, () => {})
    res.json({ success: true, data: { id: att.id } })
  } catch (e) { next(e) }
})
