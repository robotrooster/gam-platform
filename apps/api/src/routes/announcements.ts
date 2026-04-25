import { Router } from 'express'
import { db } from '../db'
import { requireAuth } from '../middleware/auth'

export const announcementsRouter = Router()
announcementsRouter.use(requireAuth)

announcementsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, title, body, priority, created_at
      FROM platform_announcements
      WHERE active = true
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY priority DESC, created_at DESC
      LIMIT 5
    `)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
