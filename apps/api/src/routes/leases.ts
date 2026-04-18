import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const leasesRouter = Router()
leasesRouter.use(requireAuth)

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * For a given lease, return the currently-active tenants as an array.
 * Used to populate the `tenants` field on every lease response.
 */
async function fetchLeaseTenants(leaseId: string): Promise<any[]> {
  return await query<any>(`
    SELECT
      lt.id as lease_tenant_id,
      lt.tenant_id,
      lt.role,
      lt.status,
      lt.added_at,
      lt.removed_at,
      lt.financial_responsibility,
      lt.responsibility_pct,
      tu.first_name,
      tu.last_name,
      tu.email,
      tu.phone
    FROM lease_tenants lt
    JOIN tenants t ON t.id = lt.tenant_id
    JOIN users tu ON tu.id = t.user_id
    WHERE lt.lease_id = $1 AND lt.status IN ('active', 'pending_add', 'pending_remove')
    ORDER BY
      CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END,
      lt.added_at ASC NULLS LAST,
      lt.created_at ASC`, [leaseId])
}

/**
 * Check if a given tenant profile is an active member of a lease.
 * Used for tenant-role permission checks.
 */
async function isTenantOnLease(leaseId: string, tenantProfileId: string): Promise<boolean> {
  const row = await queryOne<any>(`
    SELECT 1 FROM lease_tenants
    WHERE lease_id=$1 AND tenant_id=$2 AND status IN ('active','pending_add','pending_remove')`,
    [leaseId, tenantProfileId])
  return !!row
}

// ─────────────────────────────────────────────────────────────
// LIST LEASES
// Landlords see their own; tenants see leases they're active on.
// ─────────────────────────────────────────────────────────────
leasesRouter.get('/', async (req, res, next) => {
  try {
    let rows: any[]
    if (req.user!.role === 'landlord') {
      rows = await query<any>(`
        SELECT l.*, u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        WHERE l.landlord_id = $1
        ORDER BY l.start_date DESC`, [req.user!.profileId])
    } else if (req.user!.role === 'tenant') {
      rows = await query<any>(`
        SELECT DISTINCT l.*, u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        JOIN lease_tenants lt ON lt.lease_id = l.id
        WHERE lt.tenant_id = $1
          AND lt.status IN ('active','pending_add','pending_remove','removed')
        ORDER BY l.start_date DESC`, [req.user!.profileId])
    } else {
      rows = await query<any>(`
        SELECT l.*, u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        ORDER BY l.start_date DESC`)
    }

    // Attach tenants array to each lease
    for (const lease of rows) {
      lease.tenants = await fetchLeaseTenants(lease.id)
    }
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// GET ONE LEASE
// ─────────────────────────────────────────────────────────────
leasesRouter.get('/:id', async (req, res, next) => {
  try {
    const lease = await queryOne<any>(`
      SELECT l.*, u.unit_number, p.name AS property_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    if (req.user!.role === 'landlord' && lease.landlord_id !== req.user!.profileId) {
      throw new AppError(403, 'Forbidden')
    }
    if (req.user!.role === 'tenant') {
      const onLease = await isTenantOnLease(lease.id, req.user!.profileId)
      if (!onLease) throw new AppError(403, 'Forbidden')
    }

    lease.tenants = await fetchLeaseTenants(lease.id)
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// UPDATE LEASE
// Landlord edits financial/term fields on an existing lease.
// Tenant membership changes are NOT allowed here — must go through
// the addendum e-sign flow (S22+). This endpoint deliberately rejects
// any attempt to change unit_id, landlord_id, or tenant composition.
//
// Status transitions to 'expired' or 'terminated' will cascade:
//   - all active lease_tenants rows → status='removed', removed_reason='lease_ended'
//   - units.tenant_id → NULL, status='vacant'
// ─────────────────────────────────────────────────────────────
leasesRouter.patch('/:id', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      status: z.enum(['pending', 'active', 'expired', 'terminated']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
      rentAmount: z.number().positive().optional(),
      securityDeposit: z.number().min(0).optional(),
      leaseType: z.enum(['month_to_month', 'fixed_term', 'nightly', 'weekly', 'nnn_commercial']).optional(),
      autoRenew: z.boolean().optional(),
      autoRenewMode: z.enum(['extend_same_term', 'convert_to_month_to_month']).nullable().optional(),
      noticeDaysRequired: z.number().int().min(0).optional(),
      expirationNoticeDays: z.number().int().min(0).optional(),
      needsReview: z.boolean().optional(),
      lateFeeGraceDays: z.number().int().min(0).optional(),
      lateFeeAmount: z.number().min(0).optional(),
      terminationReason: z.string().optional(),
    }).strict().parse(req.body)

    const lease = await queryOne<any>('SELECT * FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (lease.landlord_id !== req.user!.profileId) throw new AppError(403, 'Forbidden')

    // Validate lease_type + end_date + auto_renew combinations against final values
    const finalLeaseType = body.leaseType ?? lease.lease_type
    const finalEndDate = body.endDate === undefined ? lease.end_date : body.endDate
    const finalAutoRenew = body.autoRenew ?? lease.auto_renew
    let finalAutoRenewMode: string | null =
      body.autoRenewMode !== undefined ? body.autoRenewMode : lease.auto_renew_mode

    if (finalLeaseType === 'month_to_month' && finalEndDate) {
      throw new AppError(400, 'Month-to-month leases cannot have an end date')
    }
    if (finalLeaseType !== 'month_to_month' && !finalEndDate) {
      throw new AppError(400, finalLeaseType + ' leases require an end date')
    }
    if (finalAutoRenew && !finalAutoRenewMode) {
      throw new AppError(400, 'auto_renew_mode is required when auto_renew is true')
    }
    if (!finalAutoRenew) finalAutoRenewMode = null

    // Build update set
    const fields: Record<string, any> = {
      status: body.status,
      start_date: body.startDate,
      end_date: body.endDate === undefined ? undefined : body.endDate,
      rent_amount: body.rentAmount,
      security_deposit: body.securityDeposit,
      lease_type: body.leaseType,
      auto_renew: body.autoRenew,
      auto_renew_mode: body.autoRenewMode === undefined ? undefined : finalAutoRenewMode,
      notice_days_required: body.noticeDaysRequired,
      expiration_notice_days: body.expirationNoticeDays,
      needs_review: body.needsReview,
      late_fee_grace_days: body.lateFeeGraceDays,
      late_fee_amount: body.lateFeeAmount,
      termination_reason: body.terminationReason,
    }

    const setParts: string[] = []
    const values: any[] = []
    let i = 1
    for (const [col, val] of Object.entries(fields)) {
      if (val === undefined) continue
      setParts.push(col + '=$' + i)
      values.push(val)
      i++
    }
    if (body.autoRenew === false && body.autoRenewMode === undefined && lease.auto_renew_mode !== null) {
      setParts.push('auto_renew_mode=$' + i)
      values.push(null)
      i++
    }

    if (setParts.length > 0) {
      values.push(req.params.id)
      await query('UPDATE leases SET ' + setParts.join(', ') + ' WHERE id=$' + i, values)
    }

    // Cascade for terminal statuses
    if (body.status === 'expired' || body.status === 'terminated') {
      await query(
        `UPDATE lease_tenants
         SET status='removed',
             removed_at=NOW(),
             removed_reason='lease_ended'
         WHERE lease_id=$1 AND status IN ('active','pending_add','pending_remove')`,
        [lease.id]
      )
      await query(
        `UPDATE units SET status='vacant', tenant_id=NULL, updated_at=NOW() WHERE id=$1`,
        [lease.unit_id]
      )
      await query(
        'UPDATE leases SET terminated_at=NOW() WHERE id=$1 AND terminated_at IS NULL',
        [lease.id]
      )
    }

    const updated = await queryOne<any>('SELECT * FROM leases WHERE id=$1', [req.params.id])
    if (updated) {
      updated.tenants = await fetchLeaseTenants(updated.id)
    }
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
