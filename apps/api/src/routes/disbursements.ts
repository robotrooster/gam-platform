import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'

export const disbursementsRouter = Router()
disbursementsRouter.use(requireAuth)

disbursementsRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const filter = isAdmin ? '' : `WHERE d.landlord_id='${req.user!.profileId}'`
    const disbs = await query<any>(`
      SELECT d.*, u.first_name, u.last_name
      FROM disbursements d
      JOIN landlords l ON l.id = d.landlord_id
      JOIN users u ON u.id = l.user_id
      ${filter} ORDER BY d.target_date DESC LIMIT 24`)
    res.json({ success: true, data: disbs })
  } catch (e) { next(e) }
})
