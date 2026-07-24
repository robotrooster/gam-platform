import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import crypto from 'crypto'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canManageLandlordResource } from '../middleware/scope'
import { resolveUploadPath } from '../lib/uploadPaths'

// ============================================================
// S517 / Walkthrough #11 — landlord-facing booking-site config + waitlist
// view. The public site itself is in routes/publicPropertyBooking.ts.
// S547: + property-website content (site photos, FAQs) for the full
// per-subdomain property site.
// ============================================================

export const propertyBookingAdminRouter = Router()
// requireAuth is applied PER ROUTE below, not router-wide: this router is
// mounted at the broad `/api` path, and a router-level `.use(requireAuth)`
// would 401 every tokenless request that merely falls through it — including
// the public, unauthenticated /api/sales and /api/guest agent endpoints
// mounted after it. Per-route auth lets non-matching paths pass through.

// S550 (Nic): suggested public web address — property names repeat in the
// wild ("Oak Park" travels), so the DEFAULT slug is name + CITY
// ("oak-park-yarnell"). Two same-named parks in the same city is where the
// street NUMBER steps in ("oak-park-22658" — no two properties on one
// street share a number). Last-resort: name-city-number. Landlord can still
// type anything unique; this only prefills the blank field.
function slugify(v: string): string {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-')
}
export async function suggestBookingSlug(prop: { id: string; name: string; city: string | null; street1: string | null }): Promise<string | null> {
  const name = slugify(prop.name)
  if (!name) return null
  const streetNum = String(prop.street1 ?? '').match(/\d{1,6}/)?.[0] ?? null
  const candidates = [
    slugify(`${prop.name} ${prop.city ?? ''}`),
    streetNum ? slugify(`${prop.name} ${streetNum}`) : null,
    streetNum ? slugify(`${prop.name} ${prop.city ?? ''} ${streetNum}`) : null,
    name,
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    const taken = await queryOne<{ id: string }>(
      `SELECT id FROM properties WHERE booking_slug = $1 AND id <> $2 LIMIT 1`, [c, prop.id])
    if (!taken) return c
  }
  return null
}

async function getOwnedProperty(propertyId: string, user: any) {
  const prop = await queryOne<any>('SELECT * FROM properties WHERE id=$1', [propertyId])
  if (!prop) throw new AppError(404, 'Property not found')
  if (!canManageLandlordResource(user, prop.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  return prop
}

// ── GET /api/properties/:id/booking-config ──
propertyBookingAdminRouter.get('/properties/:id/booking-config', requireAuth, async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    res.json({
      success: true,
      data: {
        enabled: prop.public_booking_enabled,
        slug: prop.booking_slug,
        suggestedSlug: prop.booking_slug ?? await suggestBookingSlug(prop),
        intro: prop.booking_intro,
        depositPct: Number(prop.booking_deposit_pct),
        monthlyDeposit: prop.booking_monthly_deposit != null ? Number(prop.booking_monthly_deposit) : null,
        utilitiesBilled: prop.booking_utilities_billed,
        officePhone: prop.office_phone,
        officeEmail: prop.office_email,
        officeHours: prop.office_hours,
        nightlyRate: prop.nightly_rate != null ? Number(prop.nightly_rate) : null,
        weeklyRate:  prop.weekly_rate  != null ? Number(prop.weekly_rate)  : null,
        monthlyRate: prop.monthly_rate != null ? Number(prop.monthly_rate) : null,
        shortTermTaxRate: Number(prop.short_term_tax_rate),
      },
    })
  } catch (e) { next(e) }
})

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/

// ── PATCH /api/properties/:id/booking-config ──
propertyBookingAdminRouter.patch('/properties/:id/booking-config', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      enabled:    z.boolean().optional(),
      slug:       z.string().nullable().optional(),
      intro:      z.string().nullable().optional(),
      depositPct: z.number().min(0).max(100).optional(),
      // Flat deposit for 30+ night stays (null = platform default). The quote
      // layer additionally hard-caps it at one month's rent per site type.
      monthlyDeposit: z.number().min(0).nullable().optional(),
      // "plus utilities" note on monthly-stay quotes (utilities billed back).
      utilitiesBilled: z.boolean().optional(),
      // S547 contact page: office phone / email / free-form hours text.
      officePhone: z.string().max(40).nullable().optional(),
      officeEmail: z.string().email().max(200).nullable().optional(),
      officeHours: z.string().max(2000).nullable().optional(),
      nightlyRate: z.number().min(0).nullable().optional(),
      weeklyRate:  z.number().min(0).nullable().optional(),
      monthlyRate: z.number().min(0).nullable().optional(),
      shortTermTaxRate: z.number().min(0).max(100).optional(),
    }).parse(req.body)

    const prop = await getOwnedProperty(req.params.id, req.user)

    // Validate + uniqueness-check the slug before the write so the guest URL
    // is well-formed and globally unique.
    let slug = prop.booking_slug as string | null
    if (body.slug !== undefined) {
      slug = body.slug
      if (slug != null) {
        if (!SLUG_RE.test(slug) || slug.includes('--')) {
          throw new AppError(400, 'Slug must be lowercase letters/numbers/hyphens (2–61 chars), no leading or doubled hyphens')
        }
        const taken = await queryOne<{ id: string }>(
          'SELECT id FROM properties WHERE booking_slug=$1 AND id<>$2', [slug, prop.id])
        if (taken) throw new AppError(409, 'That booking address is already taken')
      }
    }

    const enabled = body.enabled !== undefined ? body.enabled : prop.public_booking_enabled
    if (enabled && !slug) throw new AppError(400, 'Set a booking address (slug) before enabling the site')

    // Rates: a key present in the body sets it (null clears); absent = keep.
    const setNum = (v: number | null | undefined) => v === undefined ? undefined : v
    const updated = await queryOne<any>(
      `UPDATE properties
          SET public_booking_enabled=$1,
              booking_slug=$2,
              booking_intro=COALESCE($3, booking_intro),
              booking_deposit_pct=COALESCE($4, booking_deposit_pct),
              nightly_rate = CASE WHEN $6::boolean THEN $7 ELSE nightly_rate END,
              weekly_rate  = CASE WHEN $8::boolean THEN $9 ELSE weekly_rate END,
              monthly_rate = CASE WHEN $10::boolean THEN $11 ELSE monthly_rate END,
              short_term_tax_rate = COALESCE($12, short_term_tax_rate),
              booking_monthly_deposit = CASE WHEN $13::boolean THEN $14 ELSE booking_monthly_deposit END,
              booking_utilities_billed = COALESCE($15, booking_utilities_billed),
              office_phone = CASE WHEN $16::boolean THEN $17 ELSE office_phone END,
              office_email = CASE WHEN $18::boolean THEN $19 ELSE office_email END,
              office_hours = CASE WHEN $20::boolean THEN $21 ELSE office_hours END,
              updated_at=now()
        WHERE id=$5 RETURNING *`,
      [enabled, slug,
       body.intro === undefined ? null : body.intro,
       body.depositPct === undefined ? null : body.depositPct,
       prop.id,
       body.nightlyRate !== undefined, setNum(body.nightlyRate) ?? null,
       body.weeklyRate  !== undefined, setNum(body.weeklyRate)  ?? null,
       body.monthlyRate !== undefined, setNum(body.monthlyRate) ?? null,
       body.shortTermTaxRate === undefined ? null : body.shortTermTaxRate,
       body.monthlyDeposit !== undefined, body.monthlyDeposit ?? null,
       body.utilitiesBilled === undefined ? null : body.utilitiesBilled,
       body.officePhone !== undefined, body.officePhone ?? null,
       body.officeEmail !== undefined, body.officeEmail ?? null,
       body.officeHours !== undefined, body.officeHours ?? null])

    res.json({
      success: true,
      data: {
        enabled: updated.public_booking_enabled,
        slug: updated.booking_slug,
        intro: updated.booking_intro,
        depositPct: Number(updated.booking_deposit_pct),
        monthlyDeposit: updated.booking_monthly_deposit != null ? Number(updated.booking_monthly_deposit) : null,
        utilitiesBilled: updated.booking_utilities_billed,
        officePhone: updated.office_phone,
        officeEmail: updated.office_email,
        officeHours: updated.office_hours,
        nightlyRate: updated.nightly_rate != null ? Number(updated.nightly_rate) : null,
        weeklyRate:  updated.weekly_rate  != null ? Number(updated.weekly_rate)  : null,
        monthlyRate: updated.monthly_rate != null ? Number(updated.monthly_rate) : null,
        shortTermTaxRate: Number(updated.short_term_tax_rate),
      },
    })
  } catch (e) { next(e) }
})

// ── S547: property-website photos ──
// Public-site gallery shots — separate from unit_photos (internal listing
// media) so the public serving route can never reach internal photos.
const sitePhotoDir = path.join(process.cwd(), 'uploads', 'property-site-photos')
if (!fs.existsSync(sitePhotoDir)) fs.mkdirSync(sitePhotoDir, { recursive: true })
const sitePhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, sitePhotoDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true)
    else cb(new AppError(400, 'Photos must be JPEG, PNG, WebP, or GIF'))
  },
})

// GET /api/properties/:id/site-photos
propertyBookingAdminRouter.get('/properties/:id/site-photos', requireAuth, async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const rows = await query<any>(
      `SELECT id, caption, sort_order, created_at FROM property_site_photos
        WHERE property_id=$1 ORDER BY sort_order ASC, created_at ASC`, [prop.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/:id/site-photos — upload up to 20 at a time
propertyBookingAdminRouter.post('/properties/:id/site-photos', requireAuth, requirePerm('booking_sites.edit'), sitePhotoUpload.array('photos', 20), async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const files = req.files as Express.Multer.File[] | undefined
    if (!files?.length) throw new AppError(400, 'No files uploaded')
    const base = await queryOne<{ mx: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) AS mx FROM property_site_photos WHERE property_id=$1`, [prop.id])
    const out = []
    for (let i = 0; i < files.length; i++) {
      const row = await queryOne<any>(
        `INSERT INTO property_site_photos (property_id, landlord_id, filename, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id, caption, sort_order, created_at`,
        [prop.id, prop.landlord_id, files[i].filename, Number(base?.mx ?? -1) + 1 + i])
      out.push(row)
    }
    res.status(201).json({ success: true, data: out })
  } catch (e) { next(e) }
})

// GET /api/properties/:id/site-photos/:photoId/file — authed thumbnail for
// the landlord editor (the public route only serves PUBLISHED sites; this
// works while drafting). S535 posture: pinned MIME, no static mount.
const SITE_PHOTO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}
propertyBookingAdminRouter.get('/properties/:id/site-photos/:photoId/file', requireAuth, async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<{ filename: string }>(
      `SELECT filename FROM property_site_photos WHERE id=$1 AND property_id=$2`,
      [req.params.photoId, prop.id])
    if (!row) throw new AppError(404, 'Photo not found')
    const fp = resolveUploadPath(sitePhotoDir, row.filename)
    if (!fp || !fs.existsSync(fp)) throw new AppError(404, 'Photo not found')
    res.setHeader('Content-Type', SITE_PHOTO_MIME[path.extname(fp).toLowerCase()] ?? 'image/jpeg')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/site-photos/:photoId — caption / order
propertyBookingAdminRouter.patch('/properties/:id/site-photos/:photoId', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      caption:   z.string().max(300).nullable().optional(),
      sortOrder: z.number().int().min(0).optional(),
    }).parse(req.body)
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<any>(
      `UPDATE property_site_photos
          SET caption=CASE WHEN $3::boolean THEN $4 ELSE caption END,
              sort_order=COALESCE($5, sort_order)
        WHERE id=$1 AND property_id=$2
        RETURNING id, caption, sort_order`,
      [req.params.photoId, prop.id,
       body.caption !== undefined, body.caption ?? null,
       body.sortOrder ?? null])
    if (!row) throw new AppError(404, 'Photo not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// DELETE /api/properties/:id/site-photos/:photoId
propertyBookingAdminRouter.delete('/properties/:id/site-photos/:photoId', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<{ filename: string }>(
      `DELETE FROM property_site_photos WHERE id=$1 AND property_id=$2 RETURNING filename`,
      [req.params.photoId, prop.id])
    if (!row) throw new AppError(404, 'Photo not found')
    fs.promises.unlink(path.join(sitePhotoDir, path.basename(row.filename))).catch(() => {})
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── S547: property-website FAQs ──

// GET /api/properties/:id/faqs
propertyBookingAdminRouter.get('/properties/:id/faqs', requireAuth, async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const rows = await query<any>(
      `SELECT id, question, answer, sort_order FROM property_faqs
        WHERE property_id=$1 ORDER BY sort_order ASC, created_at ASC`, [prop.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/:id/faqs
propertyBookingAdminRouter.post('/properties/:id/faqs', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      question: z.string().min(1).max(500),
      answer:   z.string().min(1).max(5000),
    }).parse(req.body)
    const prop = await getOwnedProperty(req.params.id, req.user)
    const base = await queryOne<{ mx: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) AS mx FROM property_faqs WHERE property_id=$1`, [prop.id])
    const row = await queryOne<any>(
      `INSERT INTO property_faqs (property_id, landlord_id, question, answer, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, question, answer, sort_order`,
      [prop.id, prop.landlord_id, body.question, body.answer, Number(base?.mx ?? -1) + 1])
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id/faqs/:faqId
propertyBookingAdminRouter.patch('/properties/:id/faqs/:faqId', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const body = z.object({
      question:  z.string().min(1).max(500).optional(),
      answer:    z.string().min(1).max(5000).optional(),
      sortOrder: z.number().int().min(0).optional(),
    }).parse(req.body)
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<any>(
      `UPDATE property_faqs
          SET question=COALESCE($3, question), answer=COALESCE($4, answer),
              sort_order=COALESCE($5, sort_order), updated_at=now()
        WHERE id=$1 AND property_id=$2
        RETURNING id, question, answer, sort_order`,
      [req.params.faqId, prop.id, body.question ?? null, body.answer ?? null, body.sortOrder ?? null])
    if (!row) throw new AppError(404, 'FAQ not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// DELETE /api/properties/:id/faqs/:faqId
propertyBookingAdminRouter.delete('/properties/:id/faqs/:faqId', requireAuth, requirePerm('booking_sites.edit'), async (req, res, next) => {
  try {
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<{ id: string }>(
      `DELETE FROM property_faqs WHERE id=$1 AND property_id=$2 RETURNING id`,
      [req.params.faqId, prop.id])
    if (!row) throw new AppError(404, 'FAQ not found')
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── POST /api/properties/:id/waitlist — staff adds a guest to a property-wide
// waitlist (any unit). Used when every unit is full for the requested dates. ──
propertyBookingAdminRouter.post('/properties/:id/waitlist', requireAuth, requirePerm('schedule.create_reservation'), async (req, res, next) => {
  try {
    const body = z.object({
      guestName:  z.string().min(1),
      // Required — it's how the promoted guest gets their 1-hour claim link.
      guestEmail: z.string().email(),
      guestPhone: z.string().nullish(),
      checkIn:    z.string(),
      checkOut:   z.string(),
    }).parse(req.body)
    const prop = await getOwnedProperty(req.params.id, req.user)
    const row = await queryOne<{ id: string }>(
      `INSERT INTO unit_booking_waitlists
         (unit_id, property_id, landlord_id, guest_name, guest_email, guest_phone, check_in, check_out)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [prop.id, prop.landlord_id, body.guestName, body.guestEmail, body.guestPhone ?? null, body.checkIn, body.checkOut])
    res.status(201).json({ success: true, data: { waitlistId: row!.id } })
  } catch (e) { next(e) }
})

// ── GET /api/units/:id/waitlist — the queue for a unit ──
propertyBookingAdminRouter.get('/units/:id/waitlist', requireAuth, async (req, res, next) => {
  try {
    const unit = await queryOne<{ landlord_id: string }>('SELECT landlord_id FROM units WHERE id=$1', [req.params.id])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }
    const rows = await query<any>(
      `SELECT id, guest_name, guest_email, guest_phone, check_in, check_out, status,
              notified_at, claim_expires_at, created_at
         FROM unit_booking_waitlists
        WHERE unit_id=$1 AND status IN ('waiting','notified')
        ORDER BY created_at ASC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
