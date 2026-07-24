// Service interruptions / utility outage broadcasts.
//
// Landlord posts a notice that a utility is (or will be) down; it fans out
// to affected residents with an expected-restore time. This is the OUTBOUND
// counterpart to maintenance "emergency" priority (which is inbound: a
// tenant reporting a problem pages operators). Tenants get a live-notice
// feed for an at-a-glance banner.
import { Router } from 'express'
import { z } from 'zod'
import { SERVICE_INTERRUPTION_TYPES } from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { createServiceInterruption, resolveServiceInterruption } from '../services/serviceInterruptions'

export const serviceInterruptionsRouter = Router()
serviceInterruptionsRouter.use(requireAuth)

const createSchema = z.object({
  propertyId: z.string().uuid(),
  unitIds: z.array(z.string().uuid()).optional(),
  utilityType: z.enum(SERVICE_INTERRUPTION_TYPES as unknown as [string, ...string[]]),
  title: z.string().trim().max(160).optional(),
  message: z.string().trim().max(2000).optional(),
  isEmergency: z.boolean().optional(),
  startsAt: z.string().datetime().optional(),       // defaults to now (emergency)
  expectedRestoreAt: z.string().datetime().nullable().optional(),
})

// ── Landlord: post a notice ───────────────────────────────────────────
serviceInterruptionsRouter.post('/', async (req, res, next) => {
  try {
    const u = req.user!
    const b = createSchema.parse(req.body)
    const prop = await queryOne<any>(`SELECT landlord_id FROM properties WHERE id = $1`, [b.propertyId])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canManageLandlordResource(u, prop.landlord_id)) throw new AppError(403, 'Forbidden')

    const unitIds = b.unitIds ?? []
    if (unitIds.length) {
      // every targeted unit must belong to this property
      const ok = await queryOne<{ n: number }>(
        `SELECT count(*)::int n FROM units WHERE id = ANY($1::uuid[]) AND property_id = $2`,
        [unitIds, b.propertyId])
      if ((ok?.n ?? 0) !== unitIds.length) throw new AppError(400, 'Some units are not in this property')
    }

    const { row, residentsNotified } = await createServiceInterruption({
      propertyId: b.propertyId, landlordId: prop.landlord_id, unitIds,
      utilityType: b.utilityType, title: b.title ?? null, message: b.message ?? null,
      isEmergency: b.isEmergency ?? false, startsAt: b.startsAt ?? null,
      expectedRestoreAt: b.expectedRestoreAt ?? null, createdByUserId: u.userId,
    })
    res.status(201).json({ success: true, data: { ...row, notified: residentsNotified } })
  } catch (e) { next(e) }
})

// ── Landlord: list notices for a property ─────────────────────────────
serviceInterruptionsRouter.get('/', async (req, res, next) => {
  try {
    const u = req.user!
    const propertyId = req.query.propertyId as string | undefined
    if (!propertyId) throw new AppError(400, 'propertyId required')
    const prop = await queryOne<any>(`SELECT landlord_id FROM properties WHERE id = $1`, [propertyId])
    if (!prop) throw new AppError(404, 'Property not found')
    if (!canAccessLandlordResource(u, prop.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query(
      `SELECT * FROM service_interruptions WHERE property_id = $1 ORDER BY starts_at DESC`, [propertyId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── Landlord: mark resolved (optional all-clear) ──────────────────────
serviceInterruptionsRouter.post('/:id/resolve', async (req, res, next) => {
  try {
    const u = req.user!
    const b = z.object({ sendAllClear: z.boolean().optional() }).parse(req.body)
    const si = await queryOne<any>(`SELECT * FROM service_interruptions WHERE id = $1`, [req.params.id])
    if (!si) throw new AppError(404, 'Notice not found')
    if (!canManageLandlordResource(u, si.landlord_id)) throw new AppError(403, 'Forbidden')
    const row = await resolveServiceInterruption(si, b.sendAllClear ?? false)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ── Landlord: cancel a (mistaken / called-off) notice ─────────────────
serviceInterruptionsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const u = req.user!
    const si = await queryOne<any>(`SELECT * FROM service_interruptions WHERE id = $1`, [req.params.id])
    if (!si) throw new AppError(404, 'Notice not found')
    if (!canManageLandlordResource(u, si.landlord_id)) throw new AppError(403, 'Forbidden')
    if (si.status === 'resolved' || si.status === 'cancelled')
      throw new AppError(400, `Notice is already ${si.status}`)
    await query(`UPDATE service_interruptions SET status='cancelled', updated_at=now() WHERE id=$1`, [si.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── Tenant: live notices affecting me (banner feed) ───────────────────
serviceInterruptionsRouter.get('/mine', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Tenant only')
    // notices for the tenant's property where the notice is property-wide
    // (empty unit set) OR targets one of the tenant's active-lease units
    const rows = await query(
      `SELECT DISTINCT si.id, si.utility_type, si.title, si.message, si.is_emergency,
              si.starts_at, si.expected_restore_at, si.status, p.name AS property_name
         FROM service_interruptions si
         JOIN properties p ON p.id = si.property_id
         JOIN units u ON u.property_id = si.property_id
         JOIN leases l ON l.unit_id = u.id
         JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
        WHERE vlat.tenant_id = $1
          AND si.status IN ('scheduled', 'active')
          AND (cardinality(si.unit_ids) = 0 OR u.id = ANY(si.unit_ids))
        ORDER BY si.starts_at`, [u.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
