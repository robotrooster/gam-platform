import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'

export const documentsRouter = Router()
documentsRouter.use(requireAuth)

documentsRouter.get('/', async (req, res, next) => {
  try {
    const filter = req.user!.role === 'landlord' ? `AND d.landlord_id='${req.user!.profileId}'`
                 : req.user!.role === 'tenant'   ? `AND d.tenant_id='${req.user!.profileId}'` : ''
    const docs = await query<any>(`SELECT * FROM documents WHERE 1=1 ${filter} ORDER BY created_at DESC`)
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})
