// Service interruptions / utility outage broadcasts.
//
// Landlord posts a notice that a utility is (or will be) down; it fans out
// to affected residents with an expected-restore time. This is the OUTBOUND
// counterpart to maintenance "emergency" priority (which is inbound: a
// tenant reporting a problem pages operators). Tenants get a live-notice
// feed for an at-a-glance banner.
import { Router } from 'express'
import { z } from 'zod'
import {
  SERVICE_INTERRUPTION_TYPES, SERVICE_INTERRUPTION_TYPE_LABELS,
  type ServiceInterruptionType,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { notifyServiceInterruption, notifyServiceRestored } from '../services/notifications'

export const serviceInterruptionsRouter = Router()
serviceInterruptionsRouter.use(requireAuth)

const label = (t: string) => SERVICE_INTERRUPTION_TYPE_LABELS[t as ServiceInterruptionType] ?? t

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

    const startsAt = b.startsAt ?? new Date().toISOString()
    if (b.expectedRestoreAt && new Date(b.expectedRestoreAt) < new Date(startsAt))
      throw new AppError(400, 'Expected-restore time cannot be before the start')
    const status = new Date(startsAt) <= new Date() ? 'active' : 'scheduled'

    const row = await queryOne<any>(
      `INSERT INTO service_interruptions
         (property_id, landlord_id, unit_ids, utility_type, title, message,
          is_emergency, starts_at, expected_restore_at, status, created_by_user_id, residents_notified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) RETURNING *`,
      [b.propertyId, prop.landlord_id, unitIds, b.utilityType, b.title ?? null, b.message ?? null,
       b.isEmergency ?? false, startsAt, b.expectedRestoreAt ?? null, status, u.userId])

    const notified = await notifyServiceInterruption({
      propertyId: b.propertyId, landlordId: prop.landlord_id, unitIds,
      utilityLabel: label(b.utilityType), title: b.title ?? null, message: b.message ?? null,
      isEmergency: b.isEmergency ?? false, startsAt, expectedRestoreAt: b.expectedRestoreAt ?? null,
    })
    res.status(201).json({ success: true, data: { ...row, notified } })
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
    if (si.status === 'resolved' || si.status === 'cancelled')
      throw new AppError(400, `Notice is already ${si.status}`)

    let restoreNotified: string | null = si.restore_notified_at
    if (b.sendAllClear) {
      await notifyServiceRestored({
        propertyId: si.property_id, landlordId: si.landlord_id,
        unitIds: si.unit_ids ?? [], utilityLabel: label(si.utility_type),
      })
      restoreNotified = new Date().toISOString()
    }
    const row = await queryOne(
      `UPDATE service_interruptions
          SET status='resolved', resolved_at=now(), restore_notified_at=$2, updated_at=now()
        WHERE id=$1 RETURNING *`, [si.id, restoreNotified])
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
