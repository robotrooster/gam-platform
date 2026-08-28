import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import { query, queryOne, getClient } from '../db'
import { LEASE_TYPES, AUTO_RENEW_MODES, LEASE_STATUSES, MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES,
         RENT_COMPONENT_KINDS } from '@gam/shared'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'
import { logger } from '../lib/logger'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'

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
// GET /api/leases/:id/pdf — the lease agreement as a PDF.
// S534 (Nic): THE LEASE IS THE DOCUMENT — clicking a lease shows the
// real thing when it exists, in priority order:
//   1. the executed e-sign PDF (the actual signed document)
//   2. the imported original PDF (parser-onboarded leases)
//   3. fallback: rendered on-demand from the structured terms
//      (services/leasePdf) so every lease is still viewable.
// Auth: tenant on the lease, or landlord/team with access to the lease.
// ─────────────────────────────────────────────────────────────
const LEASE_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'leases')

// S534 (Nic): the lease view is the CURRENT contract — the signed lease
// followed by every recorded addendum, one continuous PDF. Addendum
// files live in uploads/leases with filenames recorded on the
// lease_addendum_recorded credit events.
async function appendLeaseAddendums(leaseId: string, mainBytes: Uint8Array): Promise<Uint8Array> {
  const rows = await query<{ filename: string | null }>(`
    SELECT ev.event_data->>'pdf_filename' AS filename
      FROM credit_events ev
      JOIN credit_subjects cs ON cs.id = ev.subject_id
     WHERE cs.subject_type = 'tenant'
       AND ev.event_type = 'lease_addendum_recorded'
       AND ev.event_data->>'lease_id' = $1
     ORDER BY ev.occurred_at ASC`, [leaseId])
  const files = rows.map(r => r.filename).filter(Boolean) as string[]
  if (files.length === 0) return mainBytes

  const { PDFDocument } = await import('pdf-lib')
  const merged = await PDFDocument.load(mainBytes)
  for (const fn of files) {
    const fp = resolveUploadPath(LEASE_UPLOAD_DIR, fn)
    if (!fp || !fs.existsSync(fp)) continue
    try {
      const addendum = await PDFDocument.load(fs.readFileSync(fp))
      const pages = await merged.copyPages(addendum, addendum.getPageIndices())
      pages.forEach(p => merged.addPage(p))
    } catch (e) {
      logger.warn({ leaseId, filename: fn, err: e }, '[leases] addendum merge skipped — unreadable PDF')
    }
  }
  return merged.save()
}

leasesRouter.get('/:id/pdf', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string; imported_pdf_url: string | null }>(
      'SELECT id, landlord_id, imported_pdf_url FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    const u = req.user!
    const allowed = u.role === 'tenant'
      ? (u.profileId ? await isTenantOnLease(lease.id, u.profileId) : false)
      : canAccessLandlordResource(u, lease.landlord_id)
    if (!allowed) throw new AppError(403, 'Forbidden')

    // Resolve the base document:
    // 1. Executed e-sign document ('/api/esign/files/<filename>' with the
    //    file in the same uploads/leases dir the addendums use).
    let baseBytes: Uint8Array | null = null
    const executed = await queryOne<{ executed_pdf_url: string }>(`
      SELECT executed_pdf_url FROM lease_documents
       WHERE lease_id = $1 AND status = 'completed' AND executed_pdf_url IS NOT NULL
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT 1`, [lease.id])
    const executedFilename = executed?.executed_pdf_url?.split('/').pop()
    if (executedFilename) {
      const filePath = resolveUploadPath(LEASE_UPLOAD_DIR, executedFilename)
      if (filePath && fs.existsSync(filePath)) baseBytes = fs.readFileSync(filePath)
    }

    // 2. Imported original (S395: stores the bare multer filename).
    if (!baseBytes && lease.imported_pdf_url) {
      const importedFilename = lease.imported_pdf_url.split('/').pop()!
      const filePath = resolveUploadPath(LEASE_UPLOAD_DIR, importedFilename)
      if (filePath && fs.existsSync(filePath)) baseBytes = fs.readFileSync(filePath)
    }

    // 3. Generated terms rendering.
    if (!baseBytes) {
      const { generateLeasePdfBytes } = await import('../services/leasePdf')
      baseBytes = await generateLeasePdfBytes(lease.id)
    }

    const bytes = await appendLeaseAddendums(lease.id, baseBytes)
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
          u.unit_number, u.unit_type, p.id AS property_id, p.name AS property_name,
          -- S609 autopay VISIBILITY (Nic, DIRECTIVE). The landlord sees THAT a
          -- payment is scheduled and on which day, so a quiet lease does not
          -- read as a tenant who stopped paying. They can never CHANGE it — a
          -- landlord able to move the date could manufacture late fees, which
          -- is why the setting lives on its own tenant-owned table and no
          -- landlord route writes to it. Do not add one.
          ap.enabled AS autopay_enabled,
          ap.pull_day AS autopay_pull_day
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        LEFT JOIN tenant_autopay ap ON ap.lease_id = l.id
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
          u.unit_number, u.unit_type, p.id AS property_id, p.name AS property_name,
          -- S609 autopay VISIBILITY (Nic, DIRECTIVE). The landlord sees THAT a
          -- payment is scheduled and on which day, so a quiet lease does not
          -- read as a tenant who stopped paying. They can never CHANGE it — a
          -- landlord able to move the date could manufacture late fees, which
          -- is why the setting lives on its own tenant-owned table and no
          -- landlord route writes to it. Do not add one.
          ap.enabled AS autopay_enabled,
          ap.pull_day AS autopay_pull_day
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        LEFT JOIN tenant_autopay ap ON ap.lease_id = l.id
        WHERE l.landlord_id = $1
        ORDER BY l.start_date DESC`, [req.user!.landlordId])
    } else if (role === 'tenant') {
      rows = await query<any>(`
        SELECT DISTINCT l.*, u.unit_number, u.unit_type, p.id AS property_id, p.name AS property_name
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
          u.unit_number, u.unit_type, p.id AS property_id, p.name AS property_name
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
    // S568: itemized rent breakdown (space rent + trailer rent + other). Empty
    // when the landlord hasn't split this lease — the UI then shows one Rent line.
    lease.rentComponents = await query<any>(
      `SELECT id, kind, label, amount, sort_order
         FROM lease_rent_components
        WHERE lease_id = $1
        ORDER BY sort_order, created_at`,
      [lease.id],
    )
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// PUT /api/leases/:id/rent-components  — S568 (Nic)
// ─────────────────────────────────────────────────────────────
// Replace the itemized rent breakdown for a lease (space rent + trailer rent +
// other). The components must SUM to the lease's rent_amount — they itemize the
// existing single rent obligation, they don't change it. An empty array clears
// the split (back to one "Rent" line). Billing is unaffected (still one rent
// payment/cycle); this is the display + metrics breakdown.
const rentComponentsSchema = z.object({
  components: z.array(z.object({
    kind:  z.enum(RENT_COMPONENT_KINDS as unknown as [string, ...string[]]),
    label: z.string().trim().min(1).max(60),
    amount: z.number().nonnegative(),
  })).max(12),
})
leasesRouter.put('/:id/rent-components', requirePerm('leases.edit'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { components } = rentComponentsSchema.parse(req.body)
    const lease = await queryOne<any>('SELECT id, landlord_id, rent_amount::float AS rent_amount FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    // Components itemize the rent — they must reconcile to the lease total. Skip
    // the check only when clearing the split entirely (empty array).
    if (components.length > 0) {
      const sum = Math.round(components.reduce((s, c) => s + c.amount, 0) * 100) / 100
      if (Math.abs(sum - lease.rent_amount) > 0.01) {
        throw new AppError(400, `Rent components must add up to the lease rent ($${lease.rent_amount.toFixed(2)}). They currently total $${sum.toFixed(2)}.`)
      }
    }

    await client.query('BEGIN')
    await client.query('DELETE FROM lease_rent_components WHERE lease_id=$1', [lease.id])
    for (let i = 0; i < components.length; i++) {
      const c = components[i]
      await client.query(
        `INSERT INTO lease_rent_components (lease_id, kind, label, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [lease.id, c.kind, c.label, c.amount.toFixed(2), i])
    }
    await client.query('COMMIT')

    const saved = await query<any>(
      `SELECT id, kind, label, amount, sort_order FROM lease_rent_components
        WHERE lease_id=$1 ORDER BY sort_order, created_at`, [lease.id])
    res.json({ success: true, data: saved })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
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
leasesRouter.patch('/:id/fees/:feeId', requirePerm('leases.edit'), async (req, res, next) => {
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
leasesRouter.patch('/:id', requirePerm('leases.edit'), async (req, res, next) => {
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
// W-31 (S529, Nic decision): free-form deductions are DOCUMENTED DAMAGES
// ONLY — description + at least one evidence document (photo/receipt) per
// line. Everything else reaches the deposit through the lease's own fee
// rows or the automatic unpaid-balance sweep.
const damageLineSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  evidenceDocumentIds: z.array(z.string().uuid()).min(1,
    'Each damage deduction needs at least one photo or receipt attached'),
})

leasesRouter.get('/:id/deposit-return', async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canAccessLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const { calculateDepositReturn, fetchUnpaidBalanceLines } = await import('../services/depositReturn')
    // S548: the page needs the approval context — the landlord's threshold
    // and whether the viewer is owner-level — to render the staff finalize
    // button correctly (send-for-approval vs. locked "landlord reviewing").
    // S548: move-out walkthrough state rides along — the page gates "Begin
    // Move-Out" on it (per unit type) and links the photo evidence for the
    // landlord's approval review.
    const unitTypeRow = await queryOne<{ unit_type: string | null }>(
      `SELECT u.unit_type FROM units u JOIN leases l ON l.unit_id = u.id WHERE l.id = $1`,
      [req.params.id])
    const moveOutRequired = (MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES as readonly string[])
      .includes(unitTypeRow?.unit_type ?? '')
    const moveOutInspection = moveOutRequired ? await queryOne<any>(
      `SELECT i.id, i.status, i.scheduled_for, i.finalized_at,
              (SELECT COUNT(*) FROM unit_inspection_items it
                 JOIN unit_inspection_photos ph ON ph.item_id = it.id
                WHERE it.inspection_id = i.id)::int AS photo_count
         FROM unit_inspections i
        WHERE i.lease_id = $1 AND i.inspection_type = 'move_out' AND i.status <> 'cancelled'
        ORDER BY (i.status = 'finalized') DESC, i.created_at DESC LIMIT 1`,
      [req.params.id]) : null
    const approvalMeta = {
      approval_threshold: Number((await queryOne<{ t: string }>(
        `SELECT deposit_return_approval_threshold::text AS t FROM landlords WHERE id=$1`,
        [lease.landlord_id]))?.t ?? 500),
      viewer_is_owner: ['landlord', 'admin', 'super_admin'].includes(req.user!.role),
      move_out_inspection_required: moveOutRequired,
      move_out_inspection: moveOutInspection,
    }
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
      return res.json({ success: true, data: { ...existing, unpaid_balance_lines, interest_accrued, ...approvalMeta } })
    }
    // No row yet — return calculation preview
    const calc = await calculateDepositReturn(req.params.id)
    if (!calc) throw new AppError(404, 'Lease not found')
    res.json({ success: true, data: { preview: true, ...calc, ...approvalMeta } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/request-background-check — S547 (Nic): the long-stay
// screening DECISION. A 30+ night booking drafts a lease and pings the
// landlord; the landlord — never the system — chooses to screen. This arm
// emails the guest a screening request pointing at the tenant-portal
// background flow. The other arm is simply reviewing + sending the lease.
leasesRouter.post('/:id/request-background-check', requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(`
      SELECT l.id, l.landlord_id, l.lease_source, b.guest_email, b.guest_name, p.name AS property_name
        FROM leases l
        JOIN unit_bookings b ON b.id = l.source_booking_id
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'No reservation-drafted lease found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!lease.guest_email) throw new AppError(400, 'The reservation has no guest email on file')
    const { emailBackgroundCheckScreeningRequest } = await import('../services/email')
    await emailBackgroundCheckScreeningRequest(
      lease.guest_email, lease.guest_name, lease.property_name,
      undefined, { landlordId: lease.landlord_id })
    logger.info({ leaseId: lease.id }, '[leases] screening request emailed to long-stay guest')
    res.json({ success: true, data: { sentTo: lease.guest_email } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/non-renewal — W-7 (S531): the "don't renew" arm of
// the renewal decision form. Arms the natural lease-end path: auto_renew
// off, so processLeaseEnds expires + vacates at end_date, and every active
// tenant gets a non-renewal notice now (generic copy — notice-period law
// varies by state; the landlord owns compliance per the no-state-legal
// rule). Any open tenant renewal request is declined.
leasesRouter.post('/:id/non-renewal', requirePerm('leases.edit'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(`
      SELECT l.*, u.unit_number, u.unit_type, p.id AS property_id, p.name AS property_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.id=$1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (lease.status !== 'active') throw new AppError(409, `Lease is ${lease.status}, not active`)
    if (!lease.end_date) throw new AppError(400, 'Lease has no end date — terminate it instead of non-renewing')

    await query(
      `UPDATE leases SET auto_renew=FALSE, auto_renew_mode=NULL, updated_at=NOW() WHERE id=$1`,
      [lease.id])
    await query(
      `UPDATE lease_renewal_requests SET status='declined', resolved_at=NOW(), updated_at=NOW()
       WHERE lease_id=$1 AND status='requested'`, [lease.id])

    // Notify every active tenant on the lease.
    const roster = await query<any>(`
      SELECT u.id AS user_id, u.email, u.first_name
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id=$1 AND lt.status='active'`, [lease.id])
    const endStr = new Date(lease.end_date).toLocaleDateString()
    const { createNotification } = await import('../services/notifications')
    for (const r of roster as any[]) {
      await createNotification({
        userId: r.user_id,
        landlordId: lease.landlord_id,
        type: 'lease_non_renewal',
        title: `Lease Non-Renewal Notice — Unit ${lease.unit_number}`,
        body: `Your lease at ${lease.property_name} ends ${endStr} and will not be renewed. Please plan your move-out by that date.`,
        data: { leaseId: lease.id, endDate: lease.end_date },
        actionUrl: '/lease',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Lease Non-Renewal Notice — Unit ${lease.unit_number}`,
      })
    }

    res.json({ success: true, data: { leaseId: lease.id, endDate: lease.end_date, notified: (roster as any[]).length } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/offer-renewal — S562 (Nic): LANDLORD-FIRST renewal.
// The landlord decides first whether they're even willing to renew (they may be
// remodeling, re-letting, or have someone lined up). Only their offer RELEASES
// the "do you want to renew?" survey to the tenant — there's no reason to ask
// the tenant if the landlord doesn't plan to renew. After the tenant responds
// yes, the landlord drafts the renewal lease via the existing e-sign flow.
// Idempotent: re-offering just refreshes the timestamp.
// S576 Snowbird Phase 1: hibernate / resume a seasonal lease. Hibernate flips
// the lease dormant for the off-season — invoiceGeneration + platformFeeAccrual
// gate on is_hibernating, so NO rent/utility invoices generate and NO platform
// fee accrues; the deposit stays held; the tenancy record persists; and the ACH
// mandate is UNTOUCHED (rent is invoice-driven, so no invoice = no pull → the
// snowbird is never charged in the off-season). Any active work-trade agreement
// for the unit+tenant pauses in lockstep. Resume clears the flag, reactivates
// the work-trade, and billing restarts on the next cron.
// Phase 1 FOLLOW-ON (not yet wired): settle the final arrears utility (final
// read → bill → pull) BEFORE hibernating so nothing bills into the dead season;
// and a precise paused_by_hibernation marker so resume only reactivates what
// hibernation paused. See ~/gam/SNOWBIRD_SEASONAL_SPEC.md.
leasesRouter.post('/:id/hibernate', requirePerm('leases.edit'), async (req, res, next) => {
  const client = await getClient()
  try {
    const lease = await queryOne<any>(
      `SELECT l.*, u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=$1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (lease.status !== 'active') throw new AppError(409, `Lease is ${lease.status}, not active — only an active lease can hibernate`)
    if (lease.is_hibernating) throw new AppError(409, 'Lease is already hibernating')

    await client.query('BEGIN')
    await client.query(`UPDATE leases SET is_hibernating=TRUE, hibernated_at=NOW(), updated_at=NOW() WHERE id=$1`, [lease.id])
    const paused = await client.query(
      `UPDATE work_trade_agreements SET status='paused', paused_by_hibernation=TRUE, updated_at=NOW()
        WHERE unit_id=$1 AND status='active'
          AND tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id=$2 AND status='active')
        RETURNING id`, [lease.unit_id, lease.id])
    await client.query('COMMIT')
    logger.info(`[hibernate] lease ${lease.id} (unit ${lease.unit_number}) → dormant; paused ${paused.rowCount} work-trade agreement(s)`)
    res.json({ success: true, data: { id: lease.id, isHibernating: true, workTradePaused: paused.rowCount } })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

leasesRouter.post('/:id/resume', requirePerm('leases.edit'), async (req, res, next) => {
  const client = await getClient()
  try {
    const lease = await queryOne<any>(
      `SELECT l.*, u.unit_number FROM leases l JOIN units u ON u.id=l.unit_id WHERE l.id=$1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!lease.is_hibernating) throw new AppError(409, 'Lease is not hibernating')

    await client.query('BEGIN')
    await client.query(`UPDATE leases SET is_hibernating=FALSE, hibernated_at=NULL, updated_at=NOW() WHERE id=$1`, [lease.id])
    const resumed = await client.query(
      `UPDATE work_trade_agreements SET status='active', paused_by_hibernation=FALSE, updated_at=NOW()
        WHERE unit_id=$1 AND status='paused' AND paused_by_hibernation=TRUE
          AND tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id=$2 AND status='active')
        RETURNING id`, [lease.unit_id, lease.id])
    await client.query('COMMIT')
    logger.info(`[resume] lease ${lease.id} (unit ${lease.unit_number}) → active; reactivated ${resumed.rowCount} work-trade agreement(s)`)
    res.json({ success: true, data: { id: lease.id, isHibernating: false, workTradeResumed: resumed.rowCount } })
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); next(e) } finally { client.release() }
})

// S602 Snowbird Phase 2b: seasonal-tenancy config. The landlord sets/reads a
// lease's recurring season window (month/day) + the priority marker. The yearly
// generation job (still to build) materializes the spot-locked recurring
// reservation from this row. One config per lease (upsert). See SNOWBIRD_SEASONAL_SPEC.md.
const seasonalConfigSchema = z.object({
  seasonStartMonth: z.number().int().min(1).max(12),
  seasonStartDay:   z.number().int().min(1).max(31),
  seasonEndMonth:   z.number().int().min(1).max(12),
  seasonEndDay:     z.number().int().min(1).max(31),
  isPriority:       z.boolean().optional(),
})

leasesRouter.put('/:id/seasonal', requirePerm('leases.edit'), async (req, res, next) => {
  try {
    const body = seasonalConfigSchema.parse(req.body)
    const lease = await queryOne<{ id: string; landlord_id: string; unit_id: string; tenant_id: string | null }>(
      `SELECT l.id, l.landlord_id, l.unit_id,
              (SELECT lt.tenant_id FROM lease_tenants lt
                WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active' LIMIT 1) AS tenant_id
         FROM leases l WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const row = await queryOne<any>(
      `INSERT INTO seasonal_tenancies
         (lease_id, unit_id, tenant_id, season_start_month, season_start_day,
          season_end_month, season_end_day, is_priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (lease_id) DO UPDATE SET
         unit_id = EXCLUDED.unit_id, tenant_id = EXCLUDED.tenant_id,
         season_start_month = EXCLUDED.season_start_month, season_start_day = EXCLUDED.season_start_day,
         season_end_month = EXCLUDED.season_end_month, season_end_day = EXCLUDED.season_end_day,
         is_priority = EXCLUDED.is_priority, active = TRUE, updated_at = NOW()
       RETURNING *`,
      [lease.id, lease.unit_id, lease.tenant_id,
       body.seasonStartMonth, body.seasonStartDay, body.seasonEndMonth, body.seasonEndDay,
       body.isPriority ?? false])
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

leasesRouter.get('/:id/seasonal', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM leases WHERE id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    const row = await queryOne<any>(`SELECT * FROM seasonal_tenancies WHERE lease_id = $1`, [req.params.id])
    res.json({ success: true, data: row ?? null })
  } catch (e) { next(e) }
})

leasesRouter.delete('/:id/seasonal', requirePerm('leases.edit'), async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM leases WHERE id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    await query(`DELETE FROM seasonal_tenancies WHERE lease_id = $1`, [req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/offer-renewal', requirePerm('leases.edit'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(`
      SELECT l.id, l.landlord_id, l.status, l.end_date, u.unit_number, p.name AS property_name
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (lease.status !== 'active') throw new AppError(409, `Lease is ${lease.status}, not active`)

    await query(
      `UPDATE leases SET landlord_renewal_offered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [lease.id])

    // Release the survey to the tenant(s) — notify them their landlord is willing
    // to renew and would like to know their plans.
    const roster = await query<any>(`
      SELECT u.id AS user_id, u.email FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id = $1 AND lt.status = 'active'`, [lease.id])
    const { createNotification } = await import('../services/notifications')
    for (const r of roster as any[]) {
      await createNotification({
        userId: r.user_id,
        landlordId: lease.landlord_id,
        type: 'lease_renewal_offered',
        title: `Renewal offered — Unit ${lease.unit_number}`,
        body: `Your landlord at ${lease.property_name} is willing to renew your lease. Open your Lease page to let them know whether you'd like to renew.`,
        data: { leaseId: lease.id },
        actionUrl: '/lease',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Your landlord is offering to renew — Unit ${lease.unit_number}`,
      })
    }
    res.json({ success: true, data: { leaseId: lease.id, offeredAt: new Date().toISOString(), notified: (roster as any[]).length } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/renewal-intent — S556: the TENANT's answer to the
// "do you plan to renew?" survey shown near lease expiry. Records the intent on
// the lease (so the survey hides), opens a renewal request when they want to
// renew, and notifies the landlord. Tenant-facing (mirrors terminate-early auth).
// S628 (Nic): TENANT-FIRST. S562 gated the survey on landlord_renewal_offered_at,
// so a bare 'yes' here always followed an offer. It no longer does — the tenant
// is asked at 60 days by jobs/renewalPing.ts, before any offer exists, and a
// 'yes' now means "I want to stay", not "I accept your terms". Nothing here
// quotes or agrees a rent for the new term; the landlord still makes the offer.
leasesRouter.post('/:id/renewal-intent', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!
    if (u.role !== 'tenant') throw new AppError(403, 'Only the tenant can submit renewal intent')
    const intent = String(req.body?.intent || '')
    if (!['yes', 'no', 'unsure'].includes(intent)) throw new AppError(400, "intent must be 'yes', 'no', or 'unsure'")
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : null

    // Verify the caller is an active tenant on this lease.
    const lease = await queryOne<any>(`
      SELECT l.id, l.landlord_id, l.status, u.unit_number, p.name AS property_name, lt.tenant_id
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE l.id = $1 AND t.user_id = $2`, [req.params.id, u.userId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (lease.status !== 'active') throw new AppError(409, `Lease is ${lease.status}, not active`)

    await query(
      `UPDATE leases SET tenant_renewal_intent=$1, tenant_renewal_intent_at=NOW(),
                         tenant_renewal_notes=$2, updated_at=NOW() WHERE id=$3`,
      [intent, notes, lease.id])

    // "Yes" opens a renewal request for the landlord's workflow (no duplicate
    // open one). "No"/"unsure" are recorded on the lease above for visibility.
    if (intent === 'yes') {
      const open = await queryOne<any>(
        `SELECT id FROM lease_renewal_requests WHERE lease_id=$1 AND status IN ('requested','approved')`,
        [lease.id])
      if (!open) {
        await query(
          `INSERT INTO lease_renewal_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, notes, status)
           VALUES ($1, $2, $3, $4, $5, 'requested')`,
          [lease.id, lease.tenant_id, lease.landlord_id, u.userId, notes])
      }
    }

    // Notify the landlord.
    const landlord = await queryOne<any>(
      `SELECT u.id AS user_id, u.email FROM landlords la JOIN users u ON u.id = la.user_id WHERE la.id=$1`,
      [lease.landlord_id])
    if (landlord) {
      // S562: "no" is BINDING written notice of non-renewal — auto-renew is
      // retired system-wide, so the lease WILL expire at its end_date. Frame it
      // as the formal notice it is (not a soft "response").
      const label = intent === 'yes'
        ? 'plans to renew'
        : intent === 'no'
          ? 'has given written notice they will NOT renew — the lease ends on its end date'
          : 'is unsure about renewing'
      const { createNotification } = await import('../services/notifications')
      await createNotification({
        userId: landlord.user_id,
        landlordId: lease.landlord_id,
        type: 'tenant_renewal_intent',
        title: intent === 'no' ? `Non-Renewal Notice — Unit ${lease.unit_number}` : `Renewal response — Unit ${lease.unit_number}`,
        body: `Your tenant at ${lease.property_name} (Unit ${lease.unit_number}) ${label}.${notes ? ` Note: "${notes}"` : ''}`,
        data: { leaseId: lease.id, intent },
        actionUrl: '/leases',
        sendEmail: true,
        emailTo: landlord.email,
        emailSubject: `Tenant renewal response — Unit ${lease.unit_number}`,
      })
    }

    res.json({ success: true, data: { leaseId: lease.id, intent } })
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
// W-30 (S529, lease-is-law): the fee to bill IS a lease_fees row on this
// lease — client sends the row id, the AMOUNT comes from the signed lease,
// never the request. Only due_timing='other' rows are landlord-billable here
// (move_in → move-in bundle, monthly_ongoing → invoice cron, move_out →
// deposit sweep — all automatic paths).
const billFeeSchema = z.object({
  leaseFeeId:  z.string().uuid(),
  description: z.string().max(500).optional(),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

leasesRouter.post('/:id/bill-fee', requirePerm('leases.bill_fee'), async (req, res, next) => {
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
    const fee = await queryOne<{ id: string; fee_type: string; amount: string; due_timing: string; description: string | null }>(
      `SELECT id, fee_type, amount, due_timing, description
         FROM lease_fees WHERE id = $1 AND lease_id = $2`,
      [body.leaseFeeId, lease.id],
    )
    if (!fee) throw new AppError(404, 'That fee is not part of this lease')
    if (fee.due_timing !== 'other') {
      throw new AppError(409, 'That fee bills automatically — only lease fees marked for landlord-initiated billing can be billed here')
    }
    const { createLeaseFeePayment } = await import('../services/leaseFees')
    const result = await createLeaseFeePayment({
      landlordId:  lease.landlord_id,
      tenantId:    lease.tenant_id,
      leaseId:     lease.id,
      unitId:      lease.unit_id,
      feeType:     fee.fee_type,
      amount:      Number(fee.amount),
      description: body.description ?? fee.description ?? undefined,
      dueDate:     body.dueDate,
      source:      'admin',
    })
    res.status(201).json({
      success: true,
      data: {
        payment_id:  result.paymentId,
        fee_type:    fee.fee_type,
        amount:      Number(fee.amount),
        due_date:    result.dueDate,
        description: result.description,
      },
    })
  } catch (e) { next(e) }
})

// S607 (Nic, DIRECTIVE): a genuine ONE-OFF charge — amount and description, no
// lease fee defined in advance.
//
// Nic: "the landlord's always gonna have some random thing, a rule change, or
// whatever, addendum that people get a notice for parking violation. All that
// little stuff is not gonna be added into the lease... people aren't gonna sign
// addendums every time. People operate in the real world."
//
// /bill-fee could not do this: it requires a lease_fees row to already exist on
// the lease, so charging for a broken gate arm meant first defining "broken gate
// arm" as a recurring fee type. This posts the charge directly.
//
// Deliberately NOT a late fee: it sits outside late-fee reporting and does not
// count against the lease's late-fee cap (Nic: "that's fine"). A landlord with
// late fees switched off at the property can still charge the occasional tenant
// without turning the whole policy on.
//
// The DESCRIPTION is required, not optional — an unexplained charge on a
// tenant's balance is the thing that generates the phone call, and the tenant
// sees this text on their bill.
const oneOffChargeSchema = z.object({
  amount:      z.number().positive().max(100000),
  description: z.string().trim().min(3).max(200),
  dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

leasesRouter.post('/:id/charge', requirePerm('leases.bill_fee'), async (req, res, next) => {
  try {
    const body = oneOffChargeSchema.parse(req.body)
    const lease = await queryOne<{
      id: string; landlord_id: string; unit_id: string; tenant_id: string | null
    }>(
      `SELECT l.id, l.landlord_id, l.unit_id,
              (SELECT vlat.tenant_id FROM v_lease_active_tenants vlat
                WHERE vlat.lease_id = l.id AND vlat.role = 'primary' LIMIT 1) AS tenant_id
         FROM leases l WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!lease.tenant_id) throw new AppError(400, 'This lease has no active tenant to charge')

    const { createLeaseFeePayment } = await import('../services/leaseFees')
    const result = await createLeaseFeePayment({
      landlordId:  lease.landlord_id,
      tenantId:    lease.tenant_id,
      leaseId:     lease.id,
      unitId:      lease.unit_id,
      feeType:     'one_off',
      amount:      Math.round(body.amount * 100) / 100,
      description: body.description,
      dueDate:     body.dueDate,
      source:      'admin',
    })
    res.status(201).json({
      success: true,
      data: {
        paymentId:   result.paymentId,
        amount:      Math.round(body.amount * 100) / 100,
        dueDate:     result.dueDate,
        description: result.description,
      },
    })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(
      `SELECT l.id, l.landlord_id, u.unit_type
         FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id=$1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    // S548 (Nic): dwellings and storage require a FINALIZED in-person
    // move-out walkthrough before the deposit return can begin — the
    // landlord approves refunds looking at the pictures, not on faith.
    // rv_spot is exempt (its walkthrough IS the pull-out meter read).
    if ((MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES as readonly string[]).includes(lease.unit_type ?? '')) {
      const insp = await queryOne<{ id: string }>(
        `SELECT id FROM unit_inspections
          WHERE lease_id = $1 AND inspection_type = 'move_out' AND status = 'finalized'
          ORDER BY finalized_at DESC LIMIT 1`, [req.params.id])
      if (!insp) {
        throw new AppError(409,
          'A finalized move-out walkthrough is required before starting this deposit return. Complete the in-person inspection (with photos) first.')
      }
    }

    const { createOrFetchDraft } = await import('../services/depositReturn')
    const row = await createOrFetchDraft(req.params.id)
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const patchSchema = z.object({
  damageLines: z.array(damageLineSchema).optional(),
  notes: z.string().optional(),
})

leasesRouter.patch('/:id/deposit-return', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const body = patchSchema.parse(req.body)
    const draft = await queryOne<any>('SELECT id FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')

    // Evidence documents must exist and belong to this landlord.
    if (body.damageLines?.length) {
      const ids = body.damageLines.flatMap(l => l.evidenceDocumentIds)
      const owned = await query<{ id: string }>(
        'SELECT id FROM documents WHERE id = ANY($1) AND landlord_id = $2',
        [ids, lease.landlord_id])
      if (owned.length !== new Set(ids).size) {
        throw new AppError(400, 'Every damage deduction needs its photo/receipt uploaded first')
      }
    }
    const { applyDeductionsToDraft } = await import('../services/depositReturn')
    const updated = await applyDeductionsToDraft(draft.id, {
      damageLines: body.damageLines,
      notes: body.notes,
    })
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return/finalize', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>('SELECT id, landlord_id FROM leases WHERE id=$1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const draft = await queryOne<any>(
      'SELECT id, status, damage_lines, other_deductions FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')
    if (!['draft', 'awaiting_approval'].includes(draft.status)) throw new AppError(409, `Already finalized: ${draft.status}`)

    // S548 (Nic): staff can run deposit returns without wasting the
    // landlord's time — up to the landlord's threshold. A refund above it
    // parks awaiting_approval; the landlord (or admin) finalizes from
    // there. Gap-only or zero returns move no money out, so staff always
    // may finalize those.
    const isOwnerLevel = ['landlord', 'admin', 'super_admin'].includes(req.user!.role)
    if (!isOwnerLevel) {
      const threshold = Number((await queryOne<{ t: string }>(
        `SELECT deposit_return_approval_threshold::text AS t FROM landlords WHERE id=$1`,
        [lease.landlord_id]))?.t ?? 500)
      const { calculateDepositReturn } = await import('../services/depositReturn')
      const calc = await calculateDepositReturn(
        req.params.id, draft.damage_lines ?? [], draft.other_deductions ?? [])
      const refund = calc?.refund_amount ?? 0
      if (refund > threshold) {
        if (draft.status === 'draft') {
          await query(`UPDATE deposit_returns SET status='awaiting_approval', updated_at=NOW() WHERE id=$1`, [draft.id])
          const owner = await queryOne<{ user_id: string }>(
            `SELECT user_id FROM landlords WHERE id=$1`, [lease.landlord_id])
          if (owner) {
            const { createNotification } = await import('../services/notifications')
            await createNotification({
              userId: owner.user_id,
              landlordId: lease.landlord_id,
              type: 'deposit_return_approval',
              title: 'Deposit return needs your approval',
              body: `A team member prepared a deposit return with a $${refund.toFixed(2)} refund — above your $${threshold.toFixed(2)} approval threshold. Review and finalize it.`,
              data: { leaseId: lease.id, depositReturnId: draft.id, refund, threshold },
              actionUrl: `/leases/${lease.id}/deposit-return`,
            }).catch(() => {})
          }
        }
        return res.status(202).json({
          success: true,
          data: { status: 'awaiting_approval', refund_amount: refund, threshold },
        })
      }
    }

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

// ── S605 (Nic): CARRIED BALANCE — arrears from the landlord's prior system ───
//
// "No way to carry a tenant's OUTSTANDING BALANCE onto the platform." Every
// charge in GAM is engine-generated from a lease, so a tenant who already owed
// money when their landlord migrated had that debt stranded off-platform —
// which breaks the reconciliation the bank feed exists to give them.
//
// Cut as a real invoice so it is payable through the normal path and shows up
// in the tenant's portal like anything else. Late fees are OFF by default: the
// nightly engine walks unpaid invoices, so an un-exempted $2,000 carried
// balance would begin compounding the day it was entered. Nic: a tenant on a
// catch-up plan shouldn't be fined for arrears from the old system.
// Same permission as the landlord-initiated one-off charge (bill-fee): both are
// a landlord adding a charge to a tenant's ledger. 'payments.record' does not
// exist in the catalog — an invented name here would have gated the route on a
// permission nobody can hold.
leasesRouter.post('/:id/carried-balance', requirePerm('leases.bill_fee'), async (req, res, next) => {
  try {
    const body = z.object({
      amount:      z.number().positive().max(1_000_000),
      description: z.string().max(300).optional(),
      dueDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Opt a specific debt back IN — for arrears that were already accruing
      // fees before the move. Deliberately not the default.
      accruesLateFees: z.boolean().default(false),
    }).parse(req.body)

    const lease = await queryOne<any>(
      `SELECT l.id, l.landlord_id, l.unit_id, lt.tenant_id
         FROM leases l
         LEFT JOIN LATERAL (
           SELECT tenant_id FROM lease_tenants WHERE lease_id = l.id ORDER BY created_at LIMIT 1
         ) lt ON TRUE
        WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    if (!lease.tenant_id) throw new AppError(409, 'This lease has no tenant to bill')

    // One carried balance per lease. A second would almost always be a
    // double-entry of the same debt, and the amount is editable until paid.
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM invoices WHERE lease_id = $1 AND is_opening_balance = TRUE`, [req.params.id])
    if (existing) {
      throw new AppError(409, 'This lease already has a carried balance. Edit or void the existing one instead.')
    }

    const due = body.dueDate ?? new Date().toISOString().slice(0, 10)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const invoiceNumber = await allocateInvoiceNumber(client, lease.landlord_id, new Date().getFullYear())
      const inv = await client.query<{ id: string }>(
        `INSERT INTO invoices (
           landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
           subtotal_rent, subtotal_fees, subtotal_utilities, total_amount,
           is_opening_balance, late_fee_exempt
         ) VALUES ($1,$2,$3,$4,$5,$6, 0, 0, 0, $7, TRUE, $8)
         RETURNING id`,
        [lease.landlord_id, lease.tenant_id, lease.id, lease.unit_id,
         invoiceNumber, due, body.amount.toFixed(2), !body.accruesLateFees])
      const invoiceId = inv.rows[0].id
      await client.query(
        `INSERT INTO payments (
           invoice_id, unit_id, lease_id, tenant_id, landlord_id,
           type, amount, status, due_date, entry_description, notes
         ) VALUES ($1,$2,$3,$4,$5,'carried_balance',$6,'pending',$7,'BALANCE',$8)`,
        [invoiceId, lease.unit_id, lease.id, lease.tenant_id, lease.landlord_id,
         body.amount.toFixed(2), due,
         body.description ?? 'Balance carried over from previous management'])
      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { invoiceId, invoiceNumber } })
    } catch (e) {
      await client.query('ROLLBACK'); throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})

// Read it back so the lease page can show what was carried and whether it is
// accruing — a landlord must be able to see the fee decision after the fact.
leasesRouter.get('/:id/carried-balance', async (req, res, next) => {
  try {
    const row = await queryOne<any>(
      `SELECT i.id, i.invoice_number, i.due_date, i.total_amount, i.status,
              i.late_fee_exempt, l.landlord_id
         FROM invoices i JOIN leases l ON l.id = i.lease_id
        WHERE i.lease_id = $1 AND i.is_opening_balance = TRUE`, [req.params.id])
    if (!row) return res.json({ success: true, data: null })
    if (!canAccessLandlordResource(req.user, row.landlord_id)) throw new AppError(403, 'Forbidden')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})
