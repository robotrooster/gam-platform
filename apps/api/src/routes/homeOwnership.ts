// Home-ownership records (S568, Nic): who owns a tenant-owned home/RV on a unit
// (the economic sublessor). Landlord assigns/transfers; investor portfolios query
// by owner. History retained.
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord, requirePerm } from '../middleware/auth'
import { canManageLandlordResource, canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { HOME_OWNERSHIP_ACQUIRED_VIA } from '@gam/shared'
import { getActiveHomeOwner, getOwnedHomes, assignHomeOwnerByContact } from '../services/homeOwnership'

export const homeOwnershipRouter = Router()
homeOwnershipRouter.use(requireAuth)

async function unitOwnedByCaller(req: any, unitId: string) {
  const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [unitId])
  if (!unit) throw new AppError(404, 'Unit not found')
  if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
  return unit
}

// GET /api/home-ownerships/unit/:unitId — active owner (+ ownership history).
homeOwnershipRouter.get('/unit/:unitId', async (req: any, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT id, landlord_id FROM units WHERE id=$1', [req.params.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canAccessLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')
    const owner = await getActiveHomeOwner(req.params.unitId)
    const history = await query<any>(
      `SELECT ho.id, ho.status, ho.acquired_via, ho.acquired_at, ho.released_at,
              u.first_name, u.last_name, u.email
         FROM home_ownerships ho JOIN users u ON u.id = ho.owner_user_id
        WHERE ho.unit_id = $1 ORDER BY ho.acquired_at DESC`, [req.params.unitId])
    res.json({ success: true, data: { owner, history } })
  } catch (e) { next(e) }
})

// PUT /api/home-ownerships/unit/:unitId — assign / transfer the home owner.
// Owner by existing account (ownerUserId) OR by name+email (mints a 'contact'
// account — external investors welcome). Any prior owner is retained as history.
homeOwnershipRouter.put('/unit/:unitId', requireLandlord, requirePerm('units.edit'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = z.object({
      ownerUserId:    z.string().uuid().nullable().optional(),
      ownerName:      z.string().trim().min(1).nullable().optional(),
      ownerEmail:     z.string().email().nullable().optional(),
      acquiredVia:    z.enum(HOME_OWNERSHIP_ACQUIRED_VIA as unknown as [string, ...string[]]).optional(),
      saleDocumentId: z.string().uuid().nullable().optional(),
      notes:          z.string().max(500).nullable().optional(),
    }).parse(req.body)
    await unitOwnedByCaller(req, req.params.unitId)

    await client.query('BEGIN')
    const result = await assignHomeOwnerByContact(client as any, {
      unitId: req.params.unitId,
      ownerUserId: body.ownerUserId ?? null,
      ownerName: body.ownerName ?? null,
      ownerEmail: body.ownerEmail ?? null,
      acquiredVia: body.acquiredVia,
      saleDocumentId: body.saleDocumentId ?? null,
      notes: body.notes ?? null,
    })
    await client.query('COMMIT')
    res.json({ success: true, data: result })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// GET /api/home-ownerships/portfolio/:ownerUserId — every home a user owns
// across all parks. Landlord/staff see it scoped to homes on their own units;
// admins see all. (The investor's cross-park view.)
homeOwnershipRouter.get('/portfolio/:ownerUserId', async (req: any, res, next) => {
  try {
    const homes = await getOwnedHomes(req.params.ownerUserId)
    const role = req.user.role
    if (role === 'admin' || role === 'super_admin') {
      return res.json({ success: true, data: homes })
    }
    // Landlord/staff: only homes on units they manage.
    const landlordId = role === 'landlord' ? req.user.profileId : req.user.landlordId
    const scoped = []
    for (const h of homes) {
      const unit = await queryOne<any>('SELECT landlord_id FROM units WHERE id=$1', [h.unit_id])
      if (unit && canAccessLandlordResource(req.user, unit.landlord_id)) scoped.push(h)
    }
    void landlordId
    res.json({ success: true, data: scoped })
  } catch (e) { next(e) }
})
