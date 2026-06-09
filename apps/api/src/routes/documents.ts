import { Router } from 'express'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'

export const documentsRouter = Router()
documentsRouter.use(requireAuth)

documentsRouter.get('/', async (req, res, next) => {
  try {
    // S69: explicit per-role scoping. Pre-S69 only landlord and tenant
    // had filters; team roles (PM, onsite_manager, maintenance) AND
    // admin/super_admin all hit the empty `else` and saw every document
    // on the platform. Admin sees all by design; everyone else gets
    // landlord-scoped via JWT claim.
    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const params: any[] = []
    let filter = ''
    if (role === 'landlord') {
      filter = `AND d.landlord_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'tenant') {
      filter = `AND d.tenant_id = $${params.push(req.user!.profileId)}`
    } else if (role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance' || role === 'bookkeeper') {
      if (!req.user!.landlordId) return res.json({ success: true, data: [] })
      filter = `AND d.landlord_id = $${params.push(req.user!.landlordId)}`
    } else if (!isAdmin) {
      return res.json({ success: true, data: [] })
    }
    const docs = await query<any>(`SELECT d.* FROM documents d WHERE 1=1 ${filter} ORDER BY d.created_at DESC`, params)
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})
