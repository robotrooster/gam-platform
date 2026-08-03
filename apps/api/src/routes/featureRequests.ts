/**
 * Feature requests (S571).
 *
 * Real capture for the "Have a feature idea?" surface that previously
 * dead-linked to a non-existent admin page. Any authenticated user submits;
 * the GAM team (super_admin) reviews and moves status. Never deleted.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireSuperAdmin } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const featureRequestsRouter = Router()
featureRequestsRouter.use(requireAuth)

const STATUSES = ['new', 'reviewing', 'planned', 'declined', 'shipped'] as const

// POST /api/feature-requests — submit an idea (any authenticated user)
featureRequestsRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      title:       z.string().min(3).max(140),
      description: z.string().min(5).max(4000),
    }).parse(req.body)

    const row = await queryOne<any>(
      `INSERT INTO feature_requests (submitted_by_user_id, submitter_role, title, description)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user!.userId, req.user!.role, body.title.trim(), body.description.trim()]
    )
    res.status(201).json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/feature-requests/mine — the caller's own submissions
featureRequestsRouter.get('/mine', async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT * FROM feature_requests WHERE submitted_by_user_id=$1 ORDER BY created_at DESC`,
      [req.user!.userId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/feature-requests — full list (GAM team only)
featureRequestsRouter.get('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT fr.*, u.first_name, u.last_name, u.email
         FROM feature_requests fr JOIN users u ON u.id = fr.submitted_by_user_id
        ORDER BY fr.created_at DESC`
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// PATCH /api/feature-requests/:id — triage (GAM team only)
featureRequestsRouter.patch('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      status:     z.enum(STATUSES).optional(),
      adminNotes: z.string().max(4000).optional(),
    }).parse(req.body)

    const row = await queryOne<any>(
      `UPDATE feature_requests
          SET status      = COALESCE($1, status),
              admin_notes = COALESCE($2, admin_notes),
              updated_at  = now()
        WHERE id=$3 RETURNING *`,
      [body.status ?? null, body.adminNotes ?? null, req.params.id]
    )
    if (!row) throw new AppError(404, 'Feature request not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})
