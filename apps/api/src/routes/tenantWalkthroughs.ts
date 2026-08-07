/**
 * Standalone tenant walkthroughs (S571).
 *
 * Tenant-initiated documentation of their own unit — photos/video they take
 * whenever they want, independent of any inspection or maintenance request.
 * Backs the "My Walkthroughs" page's manual capture. Immutable: no delete path
 * (the landlord can view but never erase a tenant's record).
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'

export const tenantWalkthroughsRouter = Router()
tenantWalkthroughsRouter.use(requireAuth)

const dir = path.join(process.cwd(), 'uploads', 'tenant-walkthroughs')
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm']
const upload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (_req: any, file: any, cb: any) =>
      cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if ([...IMAGE_MIMES, ...VIDEO_MIMES].includes(file.mimetype)) cb(null, true)
    else cb(new Error('JPEG PNG WEBP HEIC or MP4 MOV WEBM only'))
  },
})

// The tenant's current unit (from their active lease), or null.
async function currentUnitId(tenantId: string): Promise<string | null> {
  const row = await queryOne<{ unit_id: string }>(
    `SELECT l.unit_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
      WHERE vlat.tenant_id = $1
      LIMIT 1`,
    [tenantId])
  return row?.unit_id ?? null
}

// POST /api/tenant-walkthroughs/media — tenant uploads one photo/video.
tenantWalkthroughsRouter.post('/media', upload.single('file'), async (req: any, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const tenantId = req.user!.profileId
    const unitId = await currentUnitId(tenantId)
    const mediaType = VIDEO_MIMES.includes(req.file.mimetype) ? 'video' : 'photo'
    const fileUrl = '/api/tenant-walkthroughs/media-files/' + req.file.filename
    const capturedLive = req.body.capturedLive === 'false' ? false : true
    const row = await queryOne<any>(
      `INSERT INTO tenant_walkthrough_media (tenant_id, unit_id, uploaded_by_user_id, media_type, file_url, caption, captured_live)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, media_type, file_url, caption, captured_live, created_at`,
      [tenantId, unitId, req.user!.userId, mediaType, fileUrl, (req.body.caption || '').slice(0, 500) || null, capturedLive])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/tenant-walkthroughs/mine — the tenant's own walkthrough media.
tenantWalkthroughsRouter.get('/mine', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const rows = await query<any>(
      `SELECT twm.id, twm.media_type, twm.file_url, twm.caption, twm.captured_live, twm.created_at,
              u.unit_number
         FROM tenant_walkthrough_media twm
         LEFT JOIN units u ON u.id = twm.unit_id
        WHERE twm.tenant_id = $1
        ORDER BY twm.created_at DESC`,
      [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/tenant-walkthroughs/media-files/:filename — stream a file.
tenantWalkthroughsRouter.get('/media-files/:filename', async (req, res, next) => {
  try {
    // S587: per-row authorization. This previously served ANY walkthrough file
    // by filename behind only the router-level requireAuth — any authed user
    // could pull another tenant's walkthrough photos/videos of their unit (same
    // class as the S586 inspection gap). The owning tenant, or the landlord/
    // scoped staff of the unit, may view it.
    const fileUrl = '/api/tenant-walkthroughs/media-files/' + req.params.filename
    const m = await queryOne<{ tenant_id: string; landlord_id: string | null }>(
      `SELECT twm.tenant_id, u.landlord_id
         FROM tenant_walkthrough_media twm
         LEFT JOIN units u ON u.id = twm.unit_id
        WHERE twm.file_url = $1`, [fileUrl])
    if (!m) throw new AppError(404, 'Not found')
    const allowed = req.user!.role === 'tenant'
      ? m.tenant_id === req.user!.profileId
      : (m.landlord_id != null && canAccessLandlordResource(req.user, m.landlord_id))
    if (!allowed) throw new AppError(403, 'Forbidden')
    const fp = resolveUploadPath(dir, req.params.filename)
    if (!fp) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(fp)) throw new AppError(404, 'Not found')
    res.sendFile(fp)
  } catch (e) { next(e) }
})
