import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import { query, queryOne } from '../db'
import { LEASE_TYPES, AUTO_RENEW_MODES, LEASE_STATUSES } from '@gam/shared'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'
import { logger } from '../lib/logger'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'

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
// GET /api/leases/:id/pdf — the lease agreement rendered as a PDF.
// Generated on-demand from the structured lease terms (services/leasePdf)
// so EVERY lease — e-signed, manually created, or imported — is viewable
// in the in-browser pdf.js viewer on both the tenant and landlord sides.
// Auth: tenant on the lease, or landlord/team with access to the lease.
// ─────────────────────────────────────────────────────────────
leasesRouter.get('/:id/pdf', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      'SELECT id, landlord_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    const u = req.user!
    const allowed = u.role === 'tenant'
      ? (u.profileId ? await isTenantOnLease(lease.id, u.profileId) : false)
      : canAccessLandlordResource(u, lease.landlord_id)
    if (!allowed) throw new AppError(403, 'Forbidden')

    const { generateLeasePdfBytes } = await import('../services/leasePdf')
    const bytes = await generateLeasePdfBytes(lease.id)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="lease-agreement.pdf"')
    res.send(Buffer.from(bytes))
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// GET /api/leases/:id/move-in-photos — S512 #15 follow-up.
// Surfaces the photos captured on the unit's move-in inspection so
// the read-only lease detail can show move-in condition pics. A
// lease points at one unit; the move-in inspection is found by lease
// first (the inspection carries lease_id once one is created), then
// falls back to the unit's most recent move_in inspection for leases
// whose inspection predates the lease_id link. Returns [] when none
// exists (the section then renders nothing). Auth mirrors /pdf:
// tenant on the lease, or landlord/team with access.
// photoUrl is the existing /api/inspections/photo-files/<name> path;
// the client fetches each file with its bearer token (the file route
// is auth-gated, so a plain <img src> would 401).
// ─────────────────────────────────────────────────────────────
leasesRouter.get('/:id/move-in-photos', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string; unit_id: string }>(
      'SELECT id, landlord_id, unit_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    const u = req.user!
    const allowed = u.role === 'tenant'
      ? (u.profileId ? await isTenantOnLease(lease.id, u.profileId) : false)
      : canAccessLandlordResource(u, lease.landlord_id)
    if (!allowed) throw new AppError(403, 'Forbidden')

    const insp = await queryOne<{ id: string; status: string; conducted_at: string | null }>(
      `SELECT id, status, conducted_at
         FROM unit_inspections
        WHERE inspection_type = 'move_in'
          AND status <> 'cancelled'
          AND (lease_id = $1 OR (lease_id IS NULL AND unit_id = $2))
        ORDER BY (lease_id = $1) DESC,
                 finalized_at DESC NULLS LAST,
                 conducted_at DESC NULLS LAST,
                 created_at DESC
        LIMIT 1`,
      [lease.id, lease.unit_id])

    if (!insp) {
      res.json({ success: true, data: { inspectionId: null, status: null, photos: [] } })
      return
    }

    const photos = await query<{ id: string; photo_url: string; caption: string | null; uploaded_at: string }>(
      `SELECT id, photo_url, caption, uploaded_at
         FROM unit_inspection_photos
        WHERE inspection_id = $1
        ORDER BY uploaded_at`,
      [insp.id])

    res.json({
      success: true,
      data: {
        inspectionId: insp.id,
        status: insp.status,
        conductedAt: insp.conducted_at,
        photos: photos.map(p => ({
          id: p.id,
          photoUrl: p.photo_url,
          caption: p.caption,
          uploadedAt: p.uploaded_at,
        })),
      },
    })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// LIST LEASES
// Landlords see their own; tenants see leases they're active on.
// ─────────────────────────────────────────────────────────────
leasesRouter.get('/', async (req, res, next) => {
  try {
    let rows: any[]
    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isTeamRole = role === 'property_manager' || role === 'onsite_manager' || role === 'maintenance'
    if (role === 'landlord') {
      rows = await query<any>(`
        SELECT l.*,
          (SELECT amount FROM lease_fees lf
            WHERE lf.lease_id = l.id
              AND lf.fee_type = 'security_deposit'
              AND lf.due_timing = 'move_in'
            LIMIT 1) AS security_deposit,
          u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        WHERE l.landlord_id = $1
        ORDER BY l.start_date DESC`, [req.user!.profileId])
    } else if (isTeamRole && req.user!.landlordId) {
      // Team members see leases under the landlord they're scoped to.
      rows = await query<any>(`
        SELECT l.*,
          (SELECT amount FROM lease_fees lf
            WHERE lf.lease_id = l.id
              AND lf.fee_type = 'security_deposit'
              AND lf.due_timing = 'move_in'
            LIMIT 1) AS security_deposit,
          u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        WHERE l.landlord_id = $1
        ORDER BY l.start_date DESC`, [req.user!.landlordId])
    } else if (role === 'tenant') {
      rows = await query<any>(`
        SELECT DISTINCT l.*, u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        JOIN lease_tenants lt ON lt.lease_id = l.id
        WHERE lt.tenant_id = $1
          AND lt.status IN ('active','pending_add','pending_remove','removed')
        ORDER BY l.start_date DESC`, [req.user!.profileId])
    } else if (isAdmin) {
      rows = await query<any>(`
        SELECT l.*,
          (SELECT amount FROM lease_fees lf
            WHERE lf.lease_id = l.id
              AND lf.fee_type = 'security_deposit'
              AND lf.due_timing = 'move_in'
            LIMIT 1) AS security_deposit,
          u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        ORDER BY l.start_date DESC`)
    } else {
      // Unknown role with no landlord scope — return empty rather than leak.
      rows = []
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
      SELECT l.*,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit,
        u.unit_number, p.name AS property_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    if (req.user!.role === 'tenant') {
      const onLease = await isTenantOnLease(lease.id, req.user!.profileId)
      if (!onLease) throw new AppError(403, 'Forbidden')
    } else if (!canAccessLandlordResource(req.user, lease.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    lease.tenants = await fetchLeaseTenants(lease.id)
    lease.fees = await query<any>(
      `SELECT id, fee_type, amount, is_refundable, due_timing, is_override, override_reason, description
         FROM lease_fees
        WHERE lease_id = $1
        ORDER BY due_timing, fee_type`,
      [lease.id],
    )
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// GET /api/leases/:id/addendums
// ─────────────────────────────────────────────────────────────
// S211 (parity with S210 tenant-side): landlord-scoped read of the
// addendum events recorded against this lease. The S202 emit creates
// one credit_event per active tenant per recorded change set; we
// dedupe at SQL level by grouping on the changes shape + minute-
// truncated occurred_at so a 2-tenant lease with one addendum
// renders as one row, not two. Tenant subjects that received the
// event are returned in `tenant_ids` for attribution.
leasesRouter.get('/:id/addendums', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      'SELECT id, landlord_id FROM leases WHERE id = $1', [req.params.id]
    )
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canAccessLandlordResource(req.user, lease.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }

    const rows = await query<{
      id: string
      occurred_at: string
      changes: Array<{ field: string; from: string; to: string }>
      tenant_ids: string[]
      recorded_by_user_id: string | null
      pdf_filename: string | null
    }>(`
      SELECT MIN(ev.id::text)                          AS id,
             MIN(ev.occurred_at)                       AS occurred_at,
             ev.event_data->'changes'                  AS changes,
             array_agg(DISTINCT cs.subject_ref_id)     AS tenant_ids,
             MIN(ev.event_data->>'recorded_by_user_id') AS recorded_by_user_id,
             MIN(ev.event_data->>'pdf_filename')        AS pdf_filename
        FROM credit_events ev
        JOIN credit_subjects cs ON cs.id = ev.subject_id
       WHERE cs.subject_type = 'tenant'
         AND ev.event_type = 'lease_addendum_recorded'
         AND ev.event_data->>'lease_id' = $1
         AND ev.superseded_by IS NULL
       GROUP BY ev.event_data->'changes',
                date_trunc('minute', ev.occurred_at)
       ORDER BY MIN(ev.occurred_at) DESC`,
      [lease.id]
    )

    // S214: resolve recorded_by_user_id → name + role label, and
    // tenant_ids → tenant_names. Landlords need role attribution
    // (owner / PM / GAM admin) to know who on their team recorded
    // each addendum.
    const { resolveAddendumActor, addendumActorRoleLabel, resolveTenantNames } = await import('../services/addendumActor')
    const resolved = await Promise.all(rows.map(async (r) => {
      const actor       = await resolveAddendumActor(r.recorded_by_user_id, lease.landlord_id)
      const tenantNames = await resolveTenantNames(r.tenant_ids ?? [])
      return {
        id:                     r.id,
        occurred_at:            r.occurred_at,
        changes:                r.changes,
        tenant_ids:             r.tenant_ids,
        tenant_names:           tenantNames,
        pdf_filename:           r.pdf_filename,
        recorded_by_user_id:    r.recorded_by_user_id,
        recorded_by_name:       actor.name,
        recorded_by_role:       actor.role,
        recorded_by_role_label: addendumActorRoleLabel(actor.role),
      }
    }))

    res.json({ success: true, data: resolved })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// GET /api/leases/:id/addendum-pdf/:filename
// ─────────────────────────────────────────────────────────────
// S213: serve an addendum PDF generated by services/addendumPdf.
// Auth model differs from /api/esign/files/:filename (which requires
// a lease_documents row association — addendum PDFs are audit-only,
// no document row). Authorization here:
//   - Landlord-side: canAccessLandlordResource on the lease's landlord_id
//   - Tenant-side: tenant currently or historically on the lease
// Filename is validated against credit_events.event_data->>'pdf_filename'
// for this lease so a leaked filename can't be used to fish other
// PDFs from the uploads directory. Path traversal blocked by
// resolveUploadPath.
const ADDENDUM_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'leases')
leasesRouter.get('/:id/addendum-pdf/:filename', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      'SELECT id, landlord_id FROM leases WHERE id = $1', [req.params.id]
    )
    if (!lease) throw new AppError(404, 'Lease not found')

    let authorized = false
    if (canAccessLandlordResource(req.user, lease.landlord_id)) {
      authorized = true
    } else if (req.user!.role === 'tenant' && req.user!.profileId) {
      const onLease = await queryOne<{ tenant_id: string }>(
        `SELECT tenant_id FROM lease_tenants
          WHERE lease_id = $1 AND tenant_id = $2`,
        [lease.id, req.user!.profileId]
      )
      if (onLease) authorized = true
    }
    if (!authorized) throw new AppError(403, 'Forbidden')

    // Filename must belong to a recorded addendum on THIS lease.
    const eventMatch = await queryOne<{ id: string }>(`
      SELECT ev.id
        FROM credit_events ev
        JOIN credit_subjects cs ON cs.id = ev.subject_id
       WHERE cs.subject_type = 'tenant'
         AND ev.event_type = 'lease_addendum_recorded'
         AND ev.event_data->>'lease_id' = $1
         AND ev.event_data->>'pdf_filename' = $2
       LIMIT 1`,
      [lease.id, req.params.filename]
    )
    if (!eventMatch) throw new AppError(404, 'Addendum PDF not found for this lease')

    const filePath = resolveUploadPath(ADDENDUM_UPLOAD_DIR, req.params.filename)
    if (!filePath) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(filePath)) throw new AppError(404, 'File not on disk')

    res.sendFile(filePath)
  } catch (e) { next(e) }
})

// PATCH /api/leases/:id/fees/:feeId — landlord adds an override reason
// to a flagged lease_fees row. Only updates override_reason; amount /
// timing / refundable stay frozen (they're contractual).
const overrideReasonSchema = z.object({ override_reason: z.string().min(1).max(2000) })
leasesRouter.patch('/:id/fees/:feeId', requirePerm('leases.create'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const body = overrideReasonSchema.parse(req.body)
    const updated = await queryOne<any>(
      `UPDATE lease_fees
          SET override_reason = $1, updated_at = NOW()
        WHERE id = $2 AND lease_id = $3
        RETURNING id, fee_type, amount, is_refundable, due_timing, is_override, override_reason`,
      [body.override_reason, req.params.feeId, req.params.id],
    )
    if (!updated) throw new AppError(404, 'Fee not found')
    res.json({ success: true, data: updated })
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
//   - units.status → 'vacant' (units.tenant_id no longer exists; occupancy
//     derives from v_unit_occupancy)
// ─────────────────────────────────────────────────────────────
leasesRouter.patch('/:id', requirePerm('leases.create', 'leases.terminate'), async (req, res, next) => {
  try {
    const body = z.object({
      status: z.enum(LEASE_STATUSES).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
      rentAmount: z.number().positive().optional(),
      securityDeposit: z.number().min(0).optional(),
      leaseType: z.enum(LEASE_TYPES).optional(),
      autoRenew: z.boolean().optional(),
      autoRenewMode: z.enum(AUTO_RENEW_MODES).nullable().optional(),
      noticeDaysRequired: z.number().int().min(0).optional(),
      expirationNoticeDays: z.number().int().min(0).optional(),
      needsReview: z.boolean().optional(),
      lateFeeGraceDays: z.number().int().min(0).optional(),
      lateFeeInitialAmount: z.number().min(0).optional(),
      lateFeeInitialType: z.enum(['flat', 'percent_of_rent']).optional(),
      lateFeeEnabled: z.boolean().optional(),
      // S226: accrual + cap. All five fields are nullable on leases —
      // null on accrual_* triple = no accrual; null on cap_* pair = no cap.
      // Toggling off in the UI sends null for the whole group.
      lateFeeAccrualAmount: z.number().min(0).nullable().optional(),
      lateFeeAccrualType: z.enum(['flat', 'percent_of_rent']).nullable().optional(),
      lateFeeAccrualPeriod: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
      lateFeeCapAmount: z.number().min(0).nullable().optional(),
      lateFeeCapType: z.enum(['flat', 'percent_of_rent']).nullable().optional(),
      terminationReason: z.string().optional(),
      // S201: explicit confirm flag. When the change is non-material
      // and the lease is active/signed, the PATCH initially returns
      // 409 with a change summary; client retries with this flag set
      // to acknowledge the addendum trigger.
      confirmAddendum: z.boolean().optional(),
    }).strict().parse(req.body)

    const lease = await queryOne<any>('SELECT * FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    // S81: PMs with leases.create or leases.terminate may also edit. The
    // requirePerm middleware admitted them; canManageLandlordResource still
    // enforces landlord scope (PM must be scoped to this landlord).
    if (!canManageLandlordResource(req.user, lease.landlord_id, ['property_manager'])) {
      throw new AppError(403, 'Forbidden')
    }

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

    // ── S201: material-change gate per CLAUDE.md S177 ────────────────
    //
    // Material changes (rent, term) on an active/signed lease require
    // a NEW lease + new signatures, not an in-place edit. Non-material
    // changes (late fee, notice days, security deposit) require an
    // explicit `confirm_addendum: true` acknowledgement so the
    // landlord knows the change becomes an addendum on the tenant's
    // record.
    //
    // Status / termination_reason / needs_review are workflow ops
    // (status=expired, marking lease for review, etc.) — not lease-
    // term edits, no gate.
    //
    // Pending-status leases (not yet signed) bypass both gates —
    // landlord is finishing the lease draft, edits are free.
    // S202: declared at outer scope so the post-UPDATE addendum-event
    // emission can read the diff list.
    type ChangeRow = { field: string; from: string; to: string }
    const nonMaterialChangesApplied: ChangeRow[] = []

    if (lease.status === 'active' || lease.status === 'pending_signature') {
      const num = (v: any) => v == null ? null : Number(v)
      const dateStr = (v: any) => v == null ? null : String(v).slice(0, 10)

      const materialChanges: ChangeRow[] = []
      const nonMaterialChanges: ChangeRow[] = []

      // Material: rent + term
      if (body.rentAmount !== undefined && Number(body.rentAmount) !== num(lease.rent_amount)) {
        materialChanges.push({ field: 'rent_amount', from: String(num(lease.rent_amount) ?? ''), to: String(body.rentAmount) })
      }
      if (body.startDate !== undefined && body.startDate !== dateStr(lease.start_date)) {
        materialChanges.push({ field: 'start_date', from: dateStr(lease.start_date) ?? '—', to: body.startDate })
      }
      if (body.endDate !== undefined && body.endDate !== dateStr(lease.end_date)) {
        materialChanges.push({ field: 'end_date', from: dateStr(lease.end_date) ?? '—', to: body.endDate ?? '—' })
      }
      if (body.leaseType !== undefined && body.leaseType !== lease.lease_type) {
        materialChanges.push({ field: 'lease_type', from: lease.lease_type, to: body.leaseType })
      }
      if (body.autoRenew !== undefined && body.autoRenew !== lease.auto_renew) {
        materialChanges.push({ field: 'auto_renew', from: String(lease.auto_renew), to: String(body.autoRenew) })
      }
      if (body.autoRenewMode !== undefined && body.autoRenewMode !== lease.auto_renew_mode) {
        materialChanges.push({ field: 'auto_renew_mode', from: lease.auto_renew_mode ?? '—', to: body.autoRenewMode ?? '—' })
      }

      // Non-material: late fee, notice days, security deposit
      if (body.lateFeeGraceDays !== undefined && body.lateFeeGraceDays !== lease.late_fee_grace_days) {
        nonMaterialChanges.push({ field: 'late_fee_grace_days', from: String(lease.late_fee_grace_days ?? ''), to: String(body.lateFeeGraceDays) })
      }
      if (body.lateFeeInitialAmount !== undefined && Number(body.lateFeeInitialAmount) !== num(lease.late_fee_initial_amount)) {
        nonMaterialChanges.push({ field: 'late_fee_initial_amount', from: String(num(lease.late_fee_initial_amount) ?? ''), to: String(body.lateFeeInitialAmount) })
      }
      if (body.lateFeeInitialType !== undefined && body.lateFeeInitialType !== lease.late_fee_initial_type) {
        nonMaterialChanges.push({ field: 'late_fee_initial_type', from: lease.late_fee_initial_type ?? '', to: body.lateFeeInitialType })
      }
      if (body.lateFeeEnabled !== undefined && body.lateFeeEnabled !== lease.late_fee_enabled) {
        nonMaterialChanges.push({ field: 'late_fee_enabled', from: String(lease.late_fee_enabled), to: String(body.lateFeeEnabled) })
      }
      // S226: accrual + cap diffs. Use String(... ?? '') so null↔value
      // transitions render as "—" → "5", reusing the formatter pattern.
      if (body.lateFeeAccrualAmount !== undefined && num(body.lateFeeAccrualAmount) !== num(lease.late_fee_accrual_amount)) {
        nonMaterialChanges.push({ field: 'late_fee_accrual_amount', from: String(num(lease.late_fee_accrual_amount) ?? ''), to: String(num(body.lateFeeAccrualAmount) ?? '') })
      }
      if (body.lateFeeAccrualType !== undefined && (body.lateFeeAccrualType ?? null) !== (lease.late_fee_accrual_type ?? null)) {
        nonMaterialChanges.push({ field: 'late_fee_accrual_type', from: lease.late_fee_accrual_type ?? '', to: body.lateFeeAccrualType ?? '' })
      }
      if (body.lateFeeAccrualPeriod !== undefined && (body.lateFeeAccrualPeriod ?? null) !== (lease.late_fee_accrual_period ?? null)) {
        nonMaterialChanges.push({ field: 'late_fee_accrual_period', from: lease.late_fee_accrual_period ?? '', to: body.lateFeeAccrualPeriod ?? '' })
      }
      if (body.lateFeeCapAmount !== undefined && num(body.lateFeeCapAmount) !== num(lease.late_fee_cap_amount)) {
        nonMaterialChanges.push({ field: 'late_fee_cap_amount', from: String(num(lease.late_fee_cap_amount) ?? ''), to: String(num(body.lateFeeCapAmount) ?? '') })
      }
      if (body.lateFeeCapType !== undefined && (body.lateFeeCapType ?? null) !== (lease.late_fee_cap_type ?? null)) {
        nonMaterialChanges.push({ field: 'late_fee_cap_type', from: lease.late_fee_cap_type ?? '', to: body.lateFeeCapType ?? '' })
      }
      if (body.noticeDaysRequired !== undefined && body.noticeDaysRequired !== lease.notice_days_required) {
        nonMaterialChanges.push({ field: 'notice_days_required', from: String(lease.notice_days_required ?? ''), to: String(body.noticeDaysRequired) })
      }
      if (body.expirationNoticeDays !== undefined && body.expirationNoticeDays !== lease.expiration_notice_days) {
        nonMaterialChanges.push({ field: 'expiration_notice_days', from: String(lease.expiration_notice_days ?? ''), to: String(body.expirationNoticeDays) })
      }
      if (body.securityDeposit !== undefined) {
        // Compare against the live lease_fees row (S196 — column dropped).
        const sd = await queryOne<{ amount: string }>(
          `SELECT amount FROM lease_fees
            WHERE lease_id = $1 AND fee_type = 'security_deposit' AND due_timing = 'move_in'
            LIMIT 1`,
          [req.params.id],
        )
        const currentDeposit = sd ? Number(sd.amount) : 0
        if (Number(body.securityDeposit) !== currentDeposit) {
          nonMaterialChanges.push({ field: 'security_deposit', from: String(currentDeposit), to: String(body.securityDeposit) })
        }
      }

      // Material changes block at this status — must build a new lease.
      if (materialChanges.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'material_change_requires_new_lease',
          message:
            'Rent and term changes require a new lease with new signatures, not an in-place edit. ' +
            'Use Tenant Onboarding to draft a replacement lease that supersedes this one.',
          changes: materialChanges,
        })
      }

      // Non-material changes need explicit acknowledgment that an
      // addendum will be the audit record on the tenant's history.
      if (nonMaterialChanges.length > 0 && !body.confirmAddendum) {
        return res.status(409).json({
          success: false,
          error: 'addendum_confirmation_required',
          message:
            'These changes update the lease in place and create an addendum record on the tenant\'s history. ' +
            'Re-submit with confirmAddendum: true to apply.',
          changes: nonMaterialChanges,
        })
      }
      // S202: confirmed → carry the diff out of the gate so the
      // post-UPDATE block can emit the addendum credit-ledger event.
      nonMaterialChangesApplied.push(...nonMaterialChanges)
    }
    // End S201 gate. Below this point: changes are either workflow,
    // pending-status free edits, or confirmed non-material with
    // `confirm_addendum: true`.

    // Build update set. S196: security_deposit removed from leases
    // columns; the syncSecurityDepositLeaseFee call below handles it.
    const fields: Record<string, any> = {
      status: body.status,
      start_date: body.startDate,
      end_date: body.endDate === undefined ? undefined : body.endDate,
      rent_amount: body.rentAmount,
      lease_type: body.leaseType,
      auto_renew: body.autoRenew,
      auto_renew_mode: body.autoRenewMode === undefined ? undefined : finalAutoRenewMode,
      notice_days_required: body.noticeDaysRequired,
      expiration_notice_days: body.expirationNoticeDays,
      needs_review: body.needsReview,
      late_fee_grace_days: body.lateFeeGraceDays,
      late_fee_initial_amount: body.lateFeeInitialAmount,
      late_fee_initial_type: body.lateFeeInitialType,
      late_fee_enabled: body.lateFeeEnabled,
      late_fee_accrual_amount: body.lateFeeAccrualAmount,
      late_fee_accrual_type: body.lateFeeAccrualType,
      late_fee_accrual_period: body.lateFeeAccrualPeriod,
      late_fee_cap_amount: body.lateFeeCapAmount,
      late_fee_cap_type: body.lateFeeCapType,
      termination_reason: body.terminationReason,
    }

    // S226: cross-field validation for accrual + cap groups. Compute
    // the final state after applying the patch (undefined → existing
    // value; null → explicit clear). The accrual triple must be all-set
    // or all-null; the cap pair must be all-set or all-null. Otherwise
    // the lateFees engine sees a half-configured rule and silently
    // skips accrual (lateFees.ts:188-192 returns when any of the three
    // is null), which is exactly the silent-misconfig bug we want to
    // block at the boundary.
    const finalAccrualAmount = body.lateFeeAccrualAmount === undefined ? lease.late_fee_accrual_amount : body.lateFeeAccrualAmount
    const finalAccrualType   = body.lateFeeAccrualType   === undefined ? lease.late_fee_accrual_type   : body.lateFeeAccrualType
    const finalAccrualPeriod = body.lateFeeAccrualPeriod === undefined ? lease.late_fee_accrual_period : body.lateFeeAccrualPeriod
    const accrualSetCount = [finalAccrualAmount, finalAccrualType, finalAccrualPeriod].filter(v => v !== null && v !== undefined).length
    if (accrualSetCount !== 0 && accrualSetCount !== 3) {
      throw new AppError(400, 'late-fee accrual requires all of amount, type, and period — or none')
    }
    const finalCapAmount = body.lateFeeCapAmount === undefined ? lease.late_fee_cap_amount : body.lateFeeCapAmount
    const finalCapType   = body.lateFeeCapType   === undefined ? lease.late_fee_cap_type   : body.lateFeeCapType
    const capSetCount = [finalCapAmount, finalCapType].filter(v => v !== null && v !== undefined).length
    if (capSetCount !== 0 && capSetCount !== 2) {
      throw new AppError(400, 'late-fee cap requires both amount and type — or neither')
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

    // S195 dual-write: when securityDeposit is in the PATCH body,
    // mirror to lease_fees. Phase 2 will drop the legacy column and
    // make lease_fees the sole source of truth.
    if (body.securityDeposit !== undefined) {
      const { syncSecurityDepositLeaseFee } = await import('../services/leaseFeesSync')
      await syncSecurityDepositLeaseFee(req.params.id, Number(body.securityDeposit ?? 0))
    }

    // S202 + S213: when non-material changes applied:
    //   1. Generate the addendum PDF (audit artifact — option 1
    //      per Nic S213 product call: addendums are one-way landlord
    //      notices, not bilateral amendments. PDF is supplementary
    //      to the credit-ledger event, not a signature-gated doc.)
    //   2. Emit lease_addendum_recorded credit-ledger event per
    //      active tenant. event_data carries pdf_filename so the
    //      S210 / S211 read surfaces can link to the PDF.
    // Both are best-effort: PDF or event emission failure logs
    // but doesn't roll back the lease update.
    if (nonMaterialChangesApplied.length > 0) {
      let pdfFilename: string | null = null
      try {
        const { generateAddendumPdf } = await import('../services/addendumPdf')
        const pdf = await generateAddendumPdf({
          leaseId:          req.params.id,
          changes:          nonMaterialChangesApplied,
          recordedByUserId: req.user!.userId,
          recordedAt:       new Date(),
        })
        pdfFilename = pdf.filename
      } catch (e) {
        logger.error({ err: e }, '[ADDENDUM_PDF] generation failed:')
      }

      try {
        const tenants = await query<{ tenant_id: string }>(
          `SELECT tenant_id FROM lease_tenants
            WHERE lease_id = $1 AND status = 'active'`,
          [req.params.id],
        )
        const { appendEvent } = await import('../services/creditLedger')
        for (const t of tenants) {
          await appendEvent({
            subjectType: 'tenant',
            subjectRefId: t.tenant_id,
            eventType: 'lease_addendum_recorded',
            eventData: {
              lease_id: req.params.id,
              changes: nonMaterialChangesApplied,
              recorded_by_user_id: req.user!.userId,
              pdf_filename: pdfFilename,
            },
            occurredAt: new Date(),
            attestationSource: 'gam_workflow_auto',
            attestationEvidence: { lease_id: req.params.id, pdf_filename: pdfFilename },
            dimensionTags: ['tenancy_stability'],
            networkVisibility: 'visible_to_current_landlord',
          })
        }
      } catch (e) {
        logger.error({ err: e }, '[CREDIT] lease_addendum_recorded:')
      }
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
        `UPDATE units SET status='vacant', updated_at=NOW() WHERE id=$1`,
        [lease.unit_id]
      )
      await query(
        'UPDATE leases SET terminated_at=NOW() WHERE id=$1 AND terminated_at IS NULL',
        [lease.id]
      )
    }

    // S196: include security_deposit from lease_fees in the response
    // shape so the frontend's existingLease.securityDeposit field
    // continues to render after the column drop.
    const updated = await queryOne<any>(`
      SELECT l.*,
        (SELECT amount FROM lease_fees lf
          WHERE lf.lease_id = l.id
            AND lf.fee_type = 'security_deposit'
            AND lf.due_timing = 'move_in'
          LIMIT 1) AS security_deposit
      FROM leases l
      WHERE l.id = $1`, [req.params.id])
    if (updated) {
      updated.tenants = await fetchLeaseTenants(updated.id)
    }

    // S476 + S483: state-law mismatches against the property state.
    // Only fields TOUCHED in this PATCH get checked — landlord sees a
    // hedged factual notice when they ACT, not on every read. Returns
    // empty array when within range, uncatalogued, or non-directional.
    // Shared helper with tenant GET /lease (S483) so both surfaces
    // render identical warnings.
    let stateLawWarnings: LawFlag[] = []
    try {
      const propState = await queryOne<{ state: string | null }>(
        `SELECT p.state FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
        [lease.unit_id])
      stateLawWarnings = await checkLeaseAgainstStateLaw({
        stateCode:             propState?.state,
        rentAmount:            body.rentAmount ?? Number(lease.rent_amount),
        securityDepositAmount: body.securityDeposit,
        lateFeeInitialAmount:  body.lateFeeInitialAmount,
        lateFeeInitialType:    body.lateFeeInitialType,
        lateFeeGraceDays:      body.lateFeeGraceDays,
      })
    } catch (e) {
      logger.error({ err: e, lease_id: lease.id }, '[stateLaw] lease PATCH checks failed')
    }

    // S476: attach state-law warnings ONTO data — apiPatch on the
    // landlord portal unwraps `r.data.data`, so a top-level field
    // would be silently dropped on the client.
    res.json({
      success: true,
      data: { ...updated, state_law_warnings: stateLawWarnings },
    })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// DEPOSIT RETURN
// Move-out workflow: calculate, draft, edit deductions, finalize.
// Cleaning_fee (lease_fees with due_timing='move_out') is auto-pulled
// as a starting deduction. Landlord adds damage lines, finalizes.
// Refund creates a payments row owed by landlord; gap creates a
// payments row owed by tenant + attempts auto-charge.
// ─────────────────────────────────────────────────────────────
const damageLineSchema = z.object({
  description: z.string().min(1),
  amount: z.number(),
})

leasesRouter.get('/:id/deposit-return', async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canAccessLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const { calculateDepositReturn, fetchUnpaidBalanceLines } = await import('../services/depositReturn')
    const existing = await queryOne<any>('SELECT * FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (existing) {
      // S182 / A1 frontend: attach a live re-pull of the auto-sweep
      // lines so the page can render them line-by-line. The row only
      // stores the dollar total; line statuses can drift between
      // draft create and finalize.
      const unpaid_balance_lines = await fetchUnpaidBalanceLines(req.params.id)
      // S188: pull live interest_accrued from security_deposits so the
      // page can show the statutory interest line. The deposit_returns
      // row doesn't snapshot interest (the monthly cron may have
      // advanced it since the draft was created).
      const sd = await queryOne<{ interest_accrued: string }>(
        `SELECT interest_accrued FROM security_deposits WHERE lease_id = $1 LIMIT 1`,
        [req.params.id],
      )
      const interest_accrued = Number(sd?.interest_accrued ?? 0)
      return res.json({ success: true, data: { ...existing, unpaid_balance_lines, interest_accrued } })
    }
    // No row yet — return calculation preview
    const calc = await calculateDepositReturn(req.params.id)
    if (!calc) throw new AppError(404, 'Lease not found')
    res.json({ success: true, data: { preview: true, ...calc } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/bill-fee — S180 / A2.
//
// Landlord-triggered one-off charge against the tenant on this lease.
// Use cases: early termination fees, miscellaneous lease violations,
// negotiated charges, anything outside the standard rent / monthly-fee
// / move-in-bundle billing paths. Per the S177 product walkthrough
// ("Platform provides capability not execution"), this just creates
// the payments row — landlord initiates the action explicitly.
//
// Body: { feeType, amount, description?, dueDate? }.
// feeType maps to NACHA entry_description: 'early_termination_fee'
// and 'other_fee' both → 'SUBSCRIP'. amount is dollars. dueDate
// defaults to today; landlord can pre-date / future-date as needed.
//
// The created row is type='fee', status='pending'. Tenant pays it via
// the standard /payments page Pay Now flow against this payment_id.
// If the tenant doesn't pay before move-out, the deposit-return
// auto-sweep (A1) will pull it into the deposit deduction.
//
// Auth: requirePerm('properties.edit') is the financial-control gate
// matching other landlord billing surfaces. canManageLandlordResource
// confirms the calling user controls this lease's landlord.
const billFeeSchema = z.object({
  feeType:     z.enum(['early_termination_fee', 'other_fee']),
  amount:      z.number().positive().max(1_000_000),
  description: z.string().max(500).optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

leasesRouter.post('/:id/bill-fee', requirePerm('properties.edit'), async (req, res, next) => {
  try {
    const lease = await queryOne<{
      id: string
      landlord_id: string
      unit_id: string
      tenant_id: string | null
    }>(
      `SELECT l.id, l.landlord_id, l.unit_id,
              (SELECT vlat.tenant_id
                 FROM v_lease_active_tenants vlat
                WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
                LIMIT 1) AS tenant_id
         FROM leases l
        WHERE l.id = $1`,
      [req.params.id],
    )
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) {
      throw new AppError(403, 'Forbidden')
    }
    if (!lease.tenant_id) {
      throw new AppError(409, 'Lease has no active primary tenant — cannot bill')
    }

    const body = billFeeSchema.parse(req.body)
    const { createLeaseFeePayment } = await import('../services/leaseFees')
    const result = await createLeaseFeePayment({
      landlordId:  lease.landlord_id,
      tenantId:    lease.tenant_id,
      leaseId:     lease.id,
      unitId:      lease.unit_id,
      feeType:     body.feeType,
      amount:      body.amount,
      description: body.description,
      dueDate:     body.dueDate,
      source:      'admin',
    })
    res.status(201).json({
      success: true,
      data: {
        payment_id:  result.paymentId,
        fee_type:    body.feeType,
        amount:      body.amount,
        due_date:    result.dueDate,
        description: result.description,
      },
    })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const { createOrFetchDraft } = await import('../services/depositReturn')
    const row = await createOrFetchDraft(req.params.id)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const patchSchema = z.object({
  damageLines: z.array(damageLineSchema).optional(),
  otherDeductions: z.array(damageLineSchema).optional(),
  notes: z.string().optional(),
})

leasesRouter.patch('/:id/deposit-return', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const body = patchSchema.parse(req.body)
    const draft = await queryOne<any>('SELECT id FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')

    const { applyDeductionsToDraft } = await import('../services/depositReturn')
    const updated = await applyDeductionsToDraft(draft.id, {
      damageLines: body.damageLines,
      otherDeductions: body.otherDeductions,
      notes: body.notes,
    })
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return/finalize', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const draft = await queryOne<any>('SELECT id, status FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')
    if (draft.status !== 'draft') throw new AppError(409, `Already finalized: ${draft.status}`)

    const { finalizeDepositReturn } = await import('../services/depositReturn')
    const finalized = await finalizeDepositReturn(draft.id, req.user!.userId)
    res.json({ success: true, data: finalized })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// EARLY TERMINATION
// Tenant requests, fee auto-charges, lease flips to terminated.
// Landlord can waive in good faith.
// ─────────────────────────────────────────────────────────────

// GET /api/leases/:id/termination-quote — preview the fee
leasesRouter.get('/:id/termination-quote', async (req, res, next) => {
  try {
    const lease = await queryOne<any>(
      `SELECT l.id, l.landlord_id, l.status, lt.tenant_id
         FROM leases l
         LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
        WHERE l.id = $1`,
      [req.params.id],
    )
    if (!lease) throw new AppError(404, 'Lease not found')

    // Tenant on this lease, OR landlord-side viewer
    const u = req.user!
    const isTenant = u.role === 'tenant' && u.profileId === lease.tenant_id
    const isLandlordSide = canAccessLandlordResource(u, lease.landlord_id)
    if (!isTenant && !isLandlordSide) throw new AppError(403, 'Forbidden')

    const { quoteFee, getActiveOrLatestRequest } = await import('../services/leaseTermination')
    const quote = await quoteFee(req.params.id)
    const existingRequest = await getActiveOrLatestRequest(req.params.id)
    res.json({ success: true, data: { ...quote, existing_request: existingRequest } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/terminate-early — tenant initiates
const reasonSchema = z.object({ reason: z.string().max(2000).optional() })
leasesRouter.post('/:id/terminate-early', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Only the tenant can initiate early termination')
    const body = reasonSchema.parse(req.body)

    const lease = await queryOne<any>(
      `SELECT l.id, l.landlord_id, lt.tenant_id
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
        WHERE l.id = $1`,
      [req.params.id],
    )
    if (!lease) throw new AppError(404, 'Lease not found')
    if (lease.tenant_id !== u.profileId) throw new AppError(403, 'Not your lease')

    const { requestEarlyTermination } = await import('../services/leaseTermination')
    const result = await requestEarlyTermination({
      leaseId: req.params.id,
      tenantId: u.profileId,
      requestedByUserId: u.userId,
      reason: body.reason,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/waive-early-termination — landlord-only
const waiveSchema = z.object({ reason: z.string().max(2000).optional() })
leasesRouter.post('/:id/waive-early-termination', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const body = waiveSchema.parse(req.body)
    const { getActiveOrLatestRequest, waiveFeeAndTerminate } = await import('../services/leaseTermination')
    const existing = await getActiveOrLatestRequest(req.params.id)
    if (!existing || (existing.status !== 'requested' && existing.status !== 'failed')) {
      throw new AppError(409, 'No waive-able termination request on this lease')
    }
    const updated = await waiveFeeAndTerminate({
      requestId: existing.id,
      waivedByUserId: req.user!.userId,
      reason: body.reason,
    })
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/terminate-early/cancel — tenant cancels
leasesRouter.post('/:id/terminate-early/cancel', async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Only the tenant can cancel their request')

    const { getActiveOrLatestRequest, cancelRequest } = await import('../services/leaseTermination')
    const existing = await getActiveOrLatestRequest(req.params.id)
    if (!existing) throw new AppError(404, 'No request to cancel')
    if (existing.tenant_id !== u.profileId) throw new AppError(403, 'Not your request')
    const updated = await cancelRequest(existing.id)
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
