import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'

export const utilityRouter = Router()
utilityRouter.use(requireAuth)

utilityRouter.get('/bills', async (req, res, next) => {
  try {
    const filter = req.user!.role === 'tenant' ? `WHERE ub.tenant_id='${req.user!.profileId}'` : ''
    const bills = await query<any>(`
      SELECT ub.*, u.unit_number, p.name AS property_name
      FROM utility_bills ub
      JOIN units u ON u.id = ub.unit_id
      JOIN properties p ON p.id = u.property_id
      ${filter} ORDER BY ub.billed_at DESC`)
    res.json({ success: true, data: bills })
  } catch (e) { next(e) }
})
