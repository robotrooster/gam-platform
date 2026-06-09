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
import { logger } from '../lib/logger'
import type { MaintenancePriority } from '@gam/shared'

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
  title: string
  description: string
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
  const { unitId, title, description, priority = 'normal', photos = [], actor } = input

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

  const request = await queryOne<any>(
    `INSERT INTO maintenance_requests
       (unit_id, tenant_id, landlord_id, title, description, priority, photos)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [unitId, tenantId || null, unit.landlord_id, title, description, priority, photos]
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
