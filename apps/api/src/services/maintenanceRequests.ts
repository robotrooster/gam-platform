/**
 * Maintenance request creation — shared service.
 *
 * Extracted from the inline POST /api/maintenance handler so BOTH the
 * HTTP route and the customer-service agent's file_maintenance_request
 * tool create requests through ONE code path (no logic drift). Behavior
 * is identical to the prior route body: verify tenant access to the
 * unit, attribute the request to the right tenant, insert, add the
 * first comment, and route the landlord/manager notification.
 */

import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { routeMaintenanceNotification } from './notifications'
import { recommendMaintenancePriority } from './maintenancePriority'
import { logger } from '../lib/logger'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type MaintenanceCategory, type MaintenancePriority } from '@gam/shared'

export interface MaintenanceActor {
  /** users.id of the caller */
  userId: string
  /** caller role */
  role: string
  /** profile id: tenant uuid when role='tenant', else landlord id */
  profileId: string
}

export interface CreateMaintenanceRequestInput {
  unitId: string
  /** Optional now: tenants pick a `category` and the title is derived from it
   *  (S571). Landlord-filed requests may still pass an explicit title. */
  title?: string
  description: string
  category?: MaintenanceCategory
  /** When omitted (tenant path), the in-house agent recommends the priority. */
  priority?: MaintenancePriority
  photos?: string[]
  actor: MaintenanceActor
}

/**
 * Create a maintenance request. Throws AppError(404) if the unit does
 * not exist and AppError(403) if a tenant caller is not on an active
 * lease for the unit. Returns the inserted request row.
 */
export async function createMaintenanceRequest(
  input: CreateMaintenanceRequestInput
): Promise<any> {
  const { unitId, description, photos = [], actor } = input
  const category: MaintenanceCategory =
    input.category && MAINTENANCE_CATEGORIES.includes(input.category) ? input.category : 'general'
  // S571: tenants pick a category, not a title — derive a sensible title.
  const title = (input.title && input.title.trim()) || MAINTENANCE_CATEGORY_LABEL[category]

  const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1', [unitId])
  if (!unit) throw new AppError(404, 'Unit not found')

  // Tenant must be on an active lease for this unit (primary or co-tenant).
  if (actor.role === 'tenant') {
    const onUnit = await queryOne<any>(
      `SELECT 1 FROM v_lease_active_tenants vlat
         JOIN leases l ON l.id = vlat.lease_id AND l.status = 'active'
        WHERE l.unit_id = $1 AND vlat.tenant_id = $2 LIMIT 1`,
      [unitId, actor.profileId]
    )
    if (!onUnit) throw new AppError(403, 'You are not assigned to this unit')
  }

  // Attribution: tenant filing → themselves; non-tenant → primary tenant.
  let tenantId: string | null
  if (actor.role === 'tenant') {
    tenantId = actor.profileId
  } else {
    const occ = await queryOne<any>(
      `SELECT primary_tenant_id FROM v_unit_occupancy WHERE unit_id = $1`,
      [unitId]
    )
    tenantId = occ?.primary_tenant_id || null
  }

  // Priority: if the caller supplied one (landlord path), it stands and is
  // marked landlord-sourced. Otherwise (tenant path) the in-house agent
  // recommends it; the recommendation is stored alongside the effective value
  // so the landlord can see it and override later.
  let effectivePriority: MaintenancePriority
  let recommendedPriority: MaintenancePriority | null = null
  let prioritySource: 'agent' | 'heuristic' | 'landlord'
  if (input.priority) {
    effectivePriority = input.priority
    prioritySource = 'landlord'
  } else {
    const rec = await recommendMaintenancePriority({ category, title, description })
    effectivePriority = rec.priority
    recommendedPriority = rec.priority
    prioritySource = rec.source
  }

  const request = await queryOne<any>(
    `INSERT INTO maintenance_requests
       (unit_id, tenant_id, landlord_id, title, description, category, priority,
        recommended_priority, priority_source, photos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [unitId, tenantId || null, unit.landlord_id, title, description, category,
     effectivePriority, recommendedPriority, prioritySource, photos]
  )

  await query(
    `INSERT INTO maintenance_comments (request_id, user_id, role, message)
     VALUES ($1,$2,$3,$4)`,
    [request!.id, actor.userId, actor.role === 'tenant' ? 'tenant' : 'landlord', `Request submitted: ${description}`]
  )

  try {
    await routeMaintenanceNotification(request!.id)
  } catch (e) {
    logger.error({ err: e }, '[NOTIFY] maintenance submit:')
  }

  return request
}
