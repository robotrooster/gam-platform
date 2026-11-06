/**
 * The contractor marketplace — HTTP surface. 10/31, Nic's dictated vision.
 *
 * Two audiences on one board, and they see very different things:
 *
 *   LANDLORD  /api/marketplace/jobs…          post a job, read the bids on it,
 *                                             award one, mark it finished
 *   CONTRACTOR /api/marketplace/board…        browse open jobs, bid, withdraw,
 *                                             see the jobs they won
 *
 * A contractor route NEVER returns another contractor's bid, a bid count, or a
 * price range. A landlord route never returns anything about a job that is not
 * theirs. Those two sentences are the whole authorization model, and each has
 * a test that tries to break it.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { z } from 'zod'
import {
  CONTRACTOR_CREDENTIAL_KINDS,
  CONTRACTOR_TRADES,
  MARKETPLACE_JOB_STATUSES,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope, getScopedPropertyIds } from '../middleware/auth'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import {
  awardBid, browseOpenJobs, cancelJob, completeJob, contractorForUser,
  credentialsInForce, getJobInScope, getOpenJobForContractor,
  listAwardedJobsForContractor, listBidsForContractor, listBidsInScope,
  listJobsInScope, placeBid, postJob, requireMarketplaceCutPercent,
  startWork, withdrawBid, type LandlordScope,
} from '../services/marketplace'
import {
  areaForPlace, placementSchedule, quotePlacement, searchAreas,
} from '../services/marketplacePlacement'

export const marketplaceRouter = Router()
marketplaceRouter.use(requireAuth)

// ── Who is asking ─────────────────────────────────────────────

/**
 * Which parks this caller may act for.
 *
 * NOT a single landlord id, for two reasons that both bite: a landlord session
 * names no `landlords` row (an account is not an entity, and one account may
 * own several), and a worker may be narrowed to some of a company's properties.
 * There is no default company and no first-company-wins — a caller with no
 * landlord scope gets a refusal, never somebody else's park.
 */
async function scopeOf(req: { user?: unknown }): Promise<LandlordScope> {
  const user = (req as { user?: Parameters<typeof landlordScopeIds>[0] }).user
  if (!user) throw new AppError(401, 'Unauthenticated')
  const landlordIds = landlordScopeIds(user)
  if (landlordIds.length === 0) {
    throw new AppError(403,
      'This sign-in is not attached to a company, so it has no jobs of its own.')
  }
  return { landlordIds, propertyIds: await getScopedPropertyIds(user) }
}

/** The contractor profile behind this login, or a refusal naming what to do. */
async function requireContractor(userId: string) {
  const c = await contractorForUser(userId)
  if (!c) {
    throw new AppError(403,
      'This sign-in has no contractor profile yet. Create one to start bidding on jobs.')
  }
  if (c.suspended_at) {
    throw new AppError(403,
      'This contractor profile is suspended, so it cannot bid on jobs right now.')
  }
  return c
}

// ── The rate, so a screen can state it ───────────────────────

marketplaceRouter.get('/rate', async (_req, res, next) => {
  try {
    res.json({ success: true, data: { percent: await requireMarketplaceCutPercent() } })
  } catch (e) { next(e) }
})

// ── The paid top spot: where, and what it costs there ────────
//
// 10/31 (Nic): "Paid spot per trade per area code should be based on cost of
// living in the area. LA/NY prices don't touch Wyoming or Oklahoma."
//
// Read-only for now. BUYING a spot is the next piece and needs a way to charge
// a contractor who may have won nothing yet to net it against.

/** Areas to choose from, for a picker. */
marketplaceRouter.get('/areas', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    res.json({ success: true, data: await searchAreas(q, 25) })
  } catch (e) { next(e) }
})

/**
 * The whole schedule — GAM staff only.
 *
 * A contractor is shown THEIR price and not the grid, the same posture as every
 * other GAM price card: a tier table invites haggling over which tier you are
 * in, and the answer is a published figure rather than a negotiation.
 *
 * Declared BEFORE /placement/:areaId, or 'schedule' would be read as an id.
 */
marketplaceRouter.get('/placement/schedule', async (req, res, next) => {
  try {
    const role = req.user!.role
    if (role !== 'admin' && role !== 'super_admin') {
      throw new AppError(403, 'The rate schedule is GAM staff only.')
    }
    res.json({ success: true, data: await placementSchedule() })
  } catch (e) { next(e) }
})

/**
 * What a top spot costs where THIS contractor works.
 *
 * Read off their own profile — their metro if they are in one, otherwise the
 * rest of their state. A contractor who has not said where they are gets a
 * null area rather than a guess, and the screen asks them.
 */
marketplaceRouter.get('/placement/mine', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const area = await areaForPlace({ city: c.city, state: c.state })
    if (!area) {
      res.json({ success: true, data: null })
      return
    }
    res.json({ success: true, data: await quotePlacement(area.id) })
  } catch (e) { next(e) }
})

/** What it costs in an area they picked. */
marketplaceRouter.get('/placement/:areaId', async (req, res, next) => {
  try {
    res.json({ success: true, data: await quotePlacement(req.params.areaId) })
  } catch (e) { next(e) }
})

// ── LANDLORD: jobs ───────────────────────────────────────────

const postJobSchema = z.object({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid().nullable().optional(),
  maintenanceRequestId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  trades: z.array(z.enum(CONTRACTOR_TRADES as unknown as [string, ...string[]])).min(1),
  photos: z.array(z.string()).max(20).optional(),
  requiresInsured: z.boolean(),
  requiresBonded: z.boolean(),
  bidsCloseAt: z.string().datetime().nullable().optional(),
})

marketplaceRouter.post('/jobs', requirePerm('marketplace.post'), async (req, res, next) => {
  try {
    const body = postJobSchema.parse(req.body)
    // The narrower question, asked where the property is known: may this
    // caller post for THIS property, under the permission THIS property's
    // company granted them?
    await assertPropertyInScope(req.user, body.propertyId, { perm: 'marketplace.post' })
    const job = await postJob({
      // assertPropertyInScope above answers a MANAGER's grant; it does not
      // refuse a landlord who is a stranger to this property's company. The
      // scope does that, inside postJob.
      scope: await scopeOf(req),
      propertyId: body.propertyId,
      unitId: body.unitId ?? null,
      maintenanceRequestId: body.maintenanceRequestId ?? null,
      title: body.title,
      description: body.description,
      trades: body.trades as never,
      photos: body.photos ?? [],
      requiresInsured: body.requiresInsured,
      requiresBonded: body.requiresBonded,
      bidsCloseAt: body.bidsCloseAt ?? null,
      createdByUserId: req.user!.userId,
    })
    res.status(201).json({ success: true, data: job })
  } catch (e) { next(e) }
})

marketplaceRouter.get('/jobs', requirePerm('marketplace.view'), async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status && !(MARKETPLACE_JOB_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, 'That is not a job status.')
    }
    res.json({ success: true,
      data: await listJobsInScope(await scopeOf(req), { status: status as never }) })
  } catch (e) { next(e) }
})

marketplaceRouter.get('/jobs/:id', requirePerm('marketplace.view'), async (req, res, next) => {
  try {
    const job = await getJobInScope(req.params.id, await scopeOf(req))
    if (!job) throw new AppError(404, 'That job is not one of yours.')
    res.json({ success: true, data: job })
  } catch (e) { next(e) }
})

/** The bids on one of my jobs. The only place bid numbers are ever returned. */
marketplaceRouter.get('/jobs/:id/bids', requirePerm('marketplace.view'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await listBidsInScope(req.params.id, await scopeOf(req)) })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/jobs/:id/award', requirePerm('marketplace.award'), async (req, res, next) => {
  try {
    const { bidId } = z.object({ bidId: z.string().uuid() }).parse(req.body)
    res.json({ success: true,
      data: await awardBid({ jobId: req.params.id, bidId, scope: await scopeOf(req) }) })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/jobs/:id/complete', requirePerm('marketplace.award'), async (req, res, next) => {
  try {
    const { finalAmount } = z.object({
      finalAmount: z.number().nonnegative().nullable().optional(),
    }).parse(req.body ?? {})
    res.json({ success: true,
      data: await completeJob({
        jobId: req.params.id, scope: await scopeOf(req), finalAmount: finalAmount ?? null }) })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/jobs/:id/cancel', requirePerm('marketplace.post'), async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().max(500).nullable().optional() })
      .parse(req.body ?? {})
    res.json({ success: true,
      data: await cancelJob({ jobId: req.params.id, scope: await scopeOf(req), reason: reason ?? null }) })
  } catch (e) { next(e) }
})

// ── CONTRACTOR: the board ────────────────────────────────────

marketplaceRouter.get('/board', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const tradesQ = typeof req.query.trades === 'string' && req.query.trades.length
      ? req.query.trades.split(',').filter(t => (CONTRACTOR_TRADES as readonly string[]).includes(t))
      : undefined
    const jobs = await browseOpenJobs({
      contractorId: c.id,
      trades: tradesQ as never,
      state: typeof req.query.state === 'string' ? req.query.state : null,
      search: typeof req.query.search === 'string' ? req.query.search : null,
    })
    // What this contractor can and cannot meet, computed once, so the board can
    // say "needs insurance on file" beside a job instead of just hiding it.
    const inForce = credentialsInForce(c)
    res.json({ success: true, data: { jobs, me: inForce } })
  } catch (e) { next(e) }
})

marketplaceRouter.get('/board/:id', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const job = await getOpenJobForContractor(req.params.id, c.id)
    if (!job) throw new AppError(404, 'That job is not open for bids.')
    res.json({ success: true, data: { job, me: credentialsInForce(c) } })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/board/:id/bid', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const body = z.object({
      amount: z.number().nonnegative(),
      notes: z.string().max(2000).nullable().optional(),
      daysToComplete: z.number().int().positive().max(3650).nullable().optional(),
    }).parse(req.body)
    const bid = await placeBid({
      jobId: req.params.id,
      contractorId: c.id,
      amount: body.amount,
      notes: body.notes ?? null,
      daysToComplete: body.daysToComplete ?? null,
      createdByUserId: req.user!.userId,
    })
    res.status(201).json({ success: true, data: bid })
  } catch (e) { next(e) }
})

marketplaceRouter.get('/my-bids', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    res.json({ success: true, data: await listBidsForContractor(c.id) })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/my-bids/:id/withdraw', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    await withdrawBid({ bidId: req.params.id, contractorId: c.id })
    res.json({ success: true, data: { withdrawn: true } })
  } catch (e) { next(e) }
})

marketplaceRouter.get('/my-jobs', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    res.json({ success: true, data: await listAwardedJobsForContractor(c.id) })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/my-jobs/:id/start', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    await startWork({ jobId: req.params.id, contractorId: c.id })
    res.json({ success: true, data: { started: true } })
  } catch (e) { next(e) }
})

// ── CONTRACTOR: profile and credentials ──────────────────────

const profileSchema = z.object({
  name: z.string().trim().min(2).max(200),
  businessName: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(2).nullable().optional(),
  zip: z.string().max(12).nullable().optional(),
  serviceRadiusMiles: z.number().int().positive().max(3000).nullable().optional(),
  trades: z.array(z.enum(CONTRACTOR_TRADES as unknown as [string, ...string[]])).min(1),
})

marketplaceRouter.get('/me', async (req, res, next) => {
  try {
    const row = await queryOne(
      `SELECT id, name, business_name, phone, email, bio, city, state, zip,
              service_radius_miles, trades, status, rating, completed_jobs,
              insurance_verified, insurance_expiry, bond_verified, bond_expiry,
              connect_payouts_enabled, accepted_terms_at, created_at
         FROM contractors WHERE user_id = $1`, [req.user!.userId])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

/** Create or update my own contractor profile. Free — there is no listing fee. */
marketplaceRouter.put('/me', async (req, res, next) => {
  try {
    const b = profileSchema.parse(req.body)
    const existing = await contractorForUser(req.user!.userId)
    if (existing) {
      await query(
        `UPDATE contractors
            SET name = $2, business_name = $3, phone = $4, email = $5, bio = $6,
                city = $7, state = $8, zip = $9, service_radius_miles = $10,
                trades = $11, updated_at = NOW()
          WHERE id = $1`,
        [existing.id, b.name, b.businessName ?? null, b.phone ?? null, b.email ?? null,
         b.bio ?? null, b.city ?? null, b.state ?? null, b.zip ?? null,
         b.serviceRadiusMiles ?? null, b.trades])
    } else {
      await query(
        `INSERT INTO contractors
           (user_id, name, business_name, phone, email, bio, city, state, zip,
            service_radius_miles, trades, active, accepted_terms_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NOW())`,
        [req.user!.userId, b.name, b.businessName ?? null, b.phone ?? null, b.email ?? null,
         b.bio ?? null, b.city ?? null, b.state ?? null, b.zip ?? null,
         b.serviceRadiusMiles ?? null, b.trades])
    }
    const row = await queryOne(
      `SELECT id, name, business_name, trades, status FROM contractors WHERE user_id = $1`,
      [req.user!.userId])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// Credential files: bytes on disk, uuid-renamed, never served statically and
// never reachable without a login. Same shape as business attachments.
const CRED_ROOT = path.join(process.cwd(), 'uploads', 'contractor-credentials')
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
])
const credUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true)
    else cb(new Error(`MIME type ${file.mimetype} not allowed`))
  },
})

marketplaceRouter.get('/me/credentials', async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const rows = await query(
      `SELECT id, kind, number, issuer, state, issued_on, expires_on,
              file_name, mime_type, file_size_bytes, verified_at, note, created_at
         FROM contractor_credentials WHERE contractor_id = $1 ORDER BY created_at DESC`,
      [c.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

marketplaceRouter.post('/me/credentials', credUpload.single('file'), async (req, res, next) => {
  try {
    const c = await requireContractor(req.user!.userId)
    const b = z.object({
      kind: z.enum(CONTRACTOR_CREDENTIAL_KINDS as unknown as [string, ...string[]]),
      number: z.string().max(120).optional(),
      issuer: z.string().max(200).optional(),
      state: z.string().max(2).optional(),
      issuedOn: z.string().optional(),
      expiresOn: z.string().optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body)

    let storedFilename: string | null = null
    const file = req.file
    if (file) {
      const dir = path.join(CRED_ROOT, c.id)
      fs.mkdirSync(dir, { recursive: true })
      const ext = path.extname(file.originalname).slice(0, 8)
      storedFilename = `${crypto.randomUUID()}${ext}`
      fs.writeFileSync(path.join(dir, storedFilename), file.buffer)
    }

    const row = await queryOne<{ id: string }>(
      `INSERT INTO contractor_credentials
         (contractor_id, kind, number, issuer, state, issued_on, expires_on,
          file_name, stored_filename, mime_type, file_size_bytes, note, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [c.id, b.kind, b.number ?? null, b.issuer ?? null, b.state ?? null,
       b.issuedOn || null, b.expiresOn || null,
       file ? file.originalname : null, storedFilename,
       file ? file.mimetype : null, file ? file.size : null,
       b.note ?? null, req.user!.userId])
    res.status(201).json({ success: true, data: { id: row!.id } })
  } catch (e) { next(e) }
})

/**
 * Serve a credential file.
 *
 * Per-row authorization, which is the recurring bug class in this codebase:
 * the file comes back only to the contractor who owns it, to GAM, or to a
 * landlord on whose job that contractor has bid. A landlord deciding whether
 * to let someone onto their park has a reason to read the paper; a landlord
 * browsing other people's contractors does not.
 */
marketplaceRouter.get('/credentials/:id/file', async (req, res, next) => {
  try {
    const row = await queryOne<{
      contractor_id: string; stored_filename: string | null
      file_name: string | null; mime_type: string | null
    }>(
      `SELECT contractor_id, stored_filename, file_name, mime_type
         FROM contractor_credentials WHERE id = $1`, [req.params.id])
    if (!row || !row.stored_filename) {
      throw new AppError(404, 'There is no file on that credential.')
    }

    const user = req.user!
    let allowed = false
    if (user.role === 'admin' || user.role === 'super_admin') {
      allowed = true
    } else {
      const mine = await contractorForUser(user.userId)
      if (mine && mine.id === row.contractor_id) {
        allowed = true
      } else {
        const landlordIds = landlordScopeIds(user)
        if (landlordIds.length > 0) {
          const bid = await queryOne<{ id: string }>(
            `SELECT b.id
               FROM marketplace_bids b
               JOIN marketplace_jobs j ON j.id = b.job_id
              WHERE b.contractor_id = $1 AND j.landlord_id = ANY($2::uuid[])
                AND b.status <> 'withdrawn'
              LIMIT 1`,
            [row.contractor_id, landlordIds])
          allowed = !!bid
        }
      }
    }
    if (!allowed) throw new AppError(403, 'Forbidden')

    const abs = path.join(CRED_ROOT, row.contractor_id, row.stored_filename)
    if (!fs.existsSync(abs)) throw new AppError(404, 'That file is no longer on disk.')
    if (row.mime_type) res.type(row.mime_type)
    res.sendFile(abs)
  } catch (e) { next(e) }
})
