import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import { query, queryOne, getClient } from '../db'
import type { PoolClient } from 'pg'
import { LEASE_TYPES, AUTO_RENEW_MODES, LEASE_STATUSES, MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES,
         RENT_COMPONENT_KINDS } from '@gam/shared'
import { requireAuth, requirePerm, userHasPerm } from '../middleware/auth'
import { canAccessLandlordResource, canManageLandlordResource } from '../middleware/scope'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'
import { logger } from '../lib/logger'
import { todayIn, monthStartOf } from '../lib/timezone'
import { checkLeaseAgainstStateLaw, type LawFlag } from '../services/stateLaw'
import { allocateInvoiceNumber } from '../services/invoiceNumbers'
import { replyToProperty } from '../services/replyRouting'

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

/**
 * GET /api/leases/:id/documents — S652 (Nic): "when I click on somebody's
 * name... what I want to see is the whole package of all the documents." The
 * packet behind a lease: the lease document and every sibling drafted with it
 * (same package group), each with who has signed and who has not, and the file
 * to open — the executed copy once complete, the drafted copy until then.
 */
leasesRouter.get('/:id/documents', async (req, res, next) => {
  try {
    const lease = await queryOne<{ id: string; landlord_id: string }>(
      'SELECT id, landlord_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    const u = req.user!
    const allowed = u.role === 'tenant'
      ? (u.profileId ? await isTenantOnLease(lease.id, u.profileId) : false)
      : canAccessLandlordResource(u, lease.landlord_id)
    if (!allowed) throw new AppError(403, 'Forbidden')

    const docs = await query<any>(`
      SELECT d.id, d.title, d.document_type, d.status, d.package_sort_order, d.completed_at, d.sent_at,
             d.executed_pdf_url, d.base_pdf_url,
             (SELECT json_agg(json_build_object('role', s.role, 'name', s.name, 'status', s.status, 'signedAt', s.signed_at)
                              ORDER BY s.order_index)
                FROM lease_document_signers s WHERE s.document_id = d.id) AS signers
        FROM lease_documents d
       WHERE d.status <> 'voided'
         AND (d.lease_id = $1
              OR (d.package_group_id IS NOT NULL AND d.package_group_id IN (
                    SELECT package_group_id FROM lease_documents WHERE lease_id = $1 AND package_group_id IS NOT NULL)))
       ORDER BY d.package_sort_order NULLS LAST, d.created_at`, [lease.id])
    res.json({
      success: true,
      data: docs.map((d: any) => ({
        id: d.id, title: d.title, documentType: d.document_type, status: d.status,
        completedAt: d.completed_at, sentAt: d.sent_at, signers: d.signers ?? [],
        // What to open: the signed copy when there is one, the draft until then.
        fileUrl: d.status === 'completed' && d.executed_pdf_url ? d.executed_pdf_url : d.base_pdf_url,
        executed: !!(d.status === 'completed' && d.executed_pdf_url),
      })),
    })
  } catch (e) { next(e) }
})

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
    if (role === 'landlord' || isTeamRole) {
      // S637 (Nic): "why the fuck is it only showing the Oak Park leases...
      // it's not showing any of the Mountain View ones."
      //
      // This branch filtered on `l.landlord_id = req.user.profileId` — the
      // pre-S633 "the session IS one company" assumption. An account that owns
      // two companies saw exactly one of them, and a post-S633 landlord (whose
      // profileId is now NULL by design) would see none at all. Reads span
      // every entity the account owns; landlordScopeIds() is that set, and it
      // is refreshed from landlord_members on every request so an entity added
      // after login still resolves. Team roles keep their single scope through
      // the same helper.
      const scope = landlordScopeIds(req.user!)
      const { followsLeaseEndedEarlyUnsigned } = await import('../services/renewalSuccessor')
      const { usablePaidAheadSql, disputeClaimJoinSql } = await import('../services/creditUse')
      const { keptThroughNeverMovedInSql, moveInInvoiceIdSql } = await import('../lib/unwindIssuedLease')
      rows = scope.length === 0 ? [] : await query<any>(`
        SELECT l.*,
          (SELECT amount FROM lease_fees lf
            WHERE lf.lease_id = l.id
              AND lf.fee_type = 'security_deposit'
              AND lf.due_timing = 'move_in'
            LIMIT 1) AS security_deposit,
          u.unit_number, unit_number_on(l.unit_id, l.start_date) AS unit_number_then, u.unit_type, p.id AS property_id, p.name AS property_name,
          -- S655: a household's new lease whose lease before it ENDED EARLY,
          -- with nobody in the household signed: it never starts and is being
          -- canceled. The Leases page says so, instead of "it takes over on its
          -- start date whether or not they have signed".
          (l.supersedes_lease_id IS NOT NULL AND ${followsLeaseEndedEarlyUnsigned('l')}) AS new_lease_wont_start,
          -- Fix pass 2: the one "who signed" test Discard uses (leaseSignedBySql),
          -- so the page offers Discard, "They never moved in — end the lease"
          -- or "Void on the GoldSign page" exactly as the server will treat it.
          ${leaseSignedBySql('l', 'tenant')} AS tenant_signed_any,
          ${leaseSignedBySql('l', 'anyone')} AS anyone_signed,
          -- Step 9 final fix (fix pass 1): a lease that ended (canceled with its
          -- reservation before the close ran there, or a hold that lapsed)
          -- with a bill still owed that nothing was ever paid on, no move-out
          -- and no new lease after it — the page offers "They never moved in —
          -- zero the bill" (the close decides, fresh, whether it applies).
          (l.status IN ('terminated', 'expired')
            AND NOT EXISTS (SELECT 1 FROM deposit_returns edr WHERE edr.lease_id = l.id AND edr.finalized_at IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM leases enx WHERE enx.supersedes_lease_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM payments esp
                             WHERE esp.lease_id = l.id AND esp.amount > 0 AND esp.revenue_owner IS DISTINCT FROM 'gam'
                               AND esp.status IN ('settled', 'paid_via_deposit', 'processing', 'returned'))
            -- Final fix (fix pass 1, decisions #53): the close zeroes ONLY the
            -- move-in bill, so the offer stands only while THAT bill is open
            -- (a later bill stays owed and is never offered as zeroable).
            AND EXISTS (SELECT 1 FROM payments eop
                         WHERE eop.status IN ('pending', 'failed') AND eop.amount > 0
                           AND eop.invoice_id = ${moveInInvoiceIdSql('l')}
                           AND ${keptThroughNeverMovedInSql('eop')} IS NULL)) AS ended_bill_open,
          -- S609 autopay VISIBILITY (Nic, DIRECTIVE). The landlord sees THAT a
          -- payment is scheduled and on which day, so a quiet lease does not
          -- read as a tenant who stopped paying. They can never CHANGE it — a
          -- landlord able to move the date could manufacture late fees, which
          -- is why the setting lives on its own tenant-owned table and no
          -- landlord route writes to it. Do not add one.
          ap.enabled AS autopay_enabled,
          ap.pull_day AS autopay_pull_day,
          -- S653: money the resident paid ahead, for the monthly-draw control.
          -- S655: a withdrawn credit (voidPaidAhead, an undone bank-deposit
          -- settle, a stay shortened back) keeps its amount_remaining as
          -- history; it is out of every balance, so never shown as paid ahead.
          -- Nor is money a dispute or bank return of the credit's own funding
          -- still claims (creditUse.usablePaidAheadSql, the one rule): the
          -- control shows the same "paid ahead" the tenant page shows.
          COALESCE((SELECT SUM(${usablePaidAheadSql('c', 'dc')}) FROM lease_prepaid_credits c
                      ${disputeClaimJoinSql('c', 'dc')}
                     WHERE c.lease_id = l.id AND c.amount_remaining > 0 AND c.voided_at IS NULL), 0) AS prepaid_credit_remaining
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        LEFT JOIN tenant_autopay ap ON ap.lease_id = l.id
        WHERE l.landlord_id = ANY($1::uuid[])
        ORDER BY l.start_date DESC`, [scope])
    } else if (role === 'tenant') {
      rows = await query<any>(`
        SELECT DISTINCT l.*, u.unit_number, unit_number_on(l.unit_id, l.start_date) AS unit_number_then, u.unit_type, p.id AS property_id, p.name AS property_name
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
          u.unit_number, unit_number_on(l.unit_id, l.start_date) AS unit_number_then, u.unit_type, p.id AS property_id, p.name AS property_name
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

// S653 (Nic): leaving-on mark — the keys that may write it (see the routes further down).
const LEAVING_PERMS = ['front_desk.mark_leaving', 'leases.edit'] as const
// S653: registered ABOVE '/:id' — Express matches in order, and 'desk' is not an id.
/** GET /api/leases/desk/residents?q= — who is on a space right now, for the desk. */
leasesRouter.get('/desk/residents', requirePerm(...LEAVING_PERMS), async (req: any, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : ''
    const { getScopedPropertyIds } = await import('../middleware/auth')
    const { listResidentsForDesk } = await import('../services/moveOutNotice')
    const rows = await listResidentsForDesk({
      landlordIds: landlordScopeIds(req.user!),
      propertyIds: await getScopedPropertyIds(req.user),
      q,
    })
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
        u.unit_number, unit_number_on(l.unit_id, l.start_date) AS unit_number_then, p.name AS property_name
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')

    if (req.user!.role === 'tenant') {
      const onLease = await isTenantOnLease(lease.id, req.user!.profileId!)
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
//     (an unsigned 'pending_add' spot → 'void'; it never joined the lease)
//   - units.status → 'vacant' (units.tenant_id no longer exists; occupancy
//     derives from v_unit_occupancy) — unless another lease is in force or
//     waiting on the space (the lease that replaced it)
// A lease that has ALREADY ended is not ended again: switching it between
// 'expired' and 'terminated' is refused, and the same status again is no change.
// Nor is it brought back to 'active' / 'pending' — the household gets a new lease.
// ─────────────────────────────────────────────────────────────
/**
 * What ending a lease does to the household and the space — one copy, inside
 * the caller's transaction, after the lease's own status is written: the
 * people on it are taken off it, the space empties (when no other lease is in
 * force or waiting on it) and the end is stamped. Used by every door that ends
 * a lease here (PATCH status, "They never moved in — end the lease", Discard).
 */
// Step 9 final fix (fix pass 1): the cascade lives in lib/unwindIssuedLease
// (cascadeLeaseEnd) — one copy for every door that ends a lease, the
// Schedule's Cancel reservation included.
async function cascadeLeaseEnd(c: PoolClient, leaseId: string, unitId: string): Promise<void> {
  const { cascadeLeaseEnd: cascade } = await import('../lib/unwindIssuedLease')
  await cascade(c, leaseId, unitId)
}

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

    // S655: ending a lease here ('terminated' / 'expired' — the cascade below
    // removes the household and empties the space) while the household's new
    // lease waits is the same contradiction every other early-end door refuses
    // (the tenant's "End lease early", the landlord's fee waiver, the front
    // desk's leaving date): leaving, and staying on a new lease, cannot both be
    // true. Nor can a waiting new lease itself be ended before it starts — the
    // household still lives there on the lease before it. Refused first, before
    // anything is written, in the waiver's own words
    // (renewalSuccessor.newLeaseBlocksEarlyEnd).
    //
    // Final sweep (10/3): only a lease that is still running. A lease that has
    // ALREADY ended is not ended again — switching it between 'terminated' and
    // 'expired' is refused in plain words. Asked of a lease whose new lease was
    // held, the check below sent the landlord to cancel that new lease first, a
    // Cancel then refused because money was paid on it — a dead end — and the
    // relabel itself would change what the jobs read: a new lease after a lease
    // that went from 'terminated' to 'expired' is no longer "after an early end"
    // (renewalSuccessor.followsLeaseEndedEarlyUnsigned), so it would start.
    //
    // Nor is an ended lease brought back ('active' / 'pending'). Its household
    // was taken off it and its space emptied when it ended, and nothing here puts
    // them back — it read 'active' with nobody on it. And a held new lease after
    // it (money paid on a new lease nobody in the household signed) would no
    // longer be "after an early end", so it would start on its date for a
    // household that left. A household that is staying gets a new lease.
    const endsIt = body.status === 'terminated' || body.status === 'expired'
    const alreadyEnded = lease.status === 'terminated' || lease.status === 'expired'
    if (alreadyEnded && body.status !== undefined && body.status !== lease.status) {
      throw new AppError(409, endsIt
        ? 'This lease has already ended, so it can\'t be ended again. Nothing else to do.'
        : 'This lease has already ended, so it can\'t be made active again. If the household is staying, ' +
          'give them a new lease: Tenants → Invite Tenant.')
    }
    if (endsIt && !alreadyEnded) {
      const { newLeaseBlocksEarlyEnd } = await import('../services/renewalSuccessor')
      const blocked = await newLeaseBlocksEarlyEnd(
        async (sql, params) => ({ rows: await query<any>(sql, params) }), lease.id, 'landlord')
      if (blocked) throw new AppError(409, blocked)
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
    // explicit `confirm_addendum: true` acknowledgment so the
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
      // S654: pg hands a DATE back as a Date at local midnight, and String() of
      // that reads "Thu Oct 01" — never equal to the 'YYYY-MM-DD' the client
      // sends, so an unchanged start date was flagged as a term change. Read
      // the Date back with the same local parts pg built it from.
      const dateStr = (v: any) => {
        if (v == null) return null
        if (v instanceof Date) {
          return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        }
        return String(v).slice(0, 10)
      }

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

    // Cascade for terminal statuses — only when this PATCH is what ends the lease
    // (an already-ended lease's household and space were settled when it ended;
    // running it again emptied a space the lease that replaced it now holds).
    //
    // Step 9 review (fix pass 2): ending a lease is ONE transaction — the
    // never-moved-in close (below), the status change and the cascade. Before
    // this the status was written on its own first; when the close then failed
    // (a lock timeout), the landlord saw an error but the lease stayed ended
    // with its bill open, and every later PATCH read it as already ended, so
    // the close never ran again.
    let closedMoveInBill: { invoiceId: string | null; amount: number } | null = null
    if (endsIt && !alreadyEnded) {
      const { closeNeverMovedInBill } = await import('../lib/unwindIssuedLease')
      const { cancelSupersededIntents } = await import('../services/creditUse')
      const c = await getClient()
      let stop: string[] = []
      try {
        await c.query('BEGIN')
        // 10/4 (decisions #46.4, Nic, FINAL): a signed lease whose tenant never
        // paid the move-in bill and never moved in — ending it zeroes that bill
        // (lib/unwindIssuedLease.closeNeverMovedInBill decides when it applies:
        // a lease that never came into force, GAM issued, not a renewal, one
        // bill, nothing ever paid). Any other lease end leaves what is owed
        // owed. First — it reads the status the lease had, and the household
        // before it is taken off the lease, so its lock finds them.
        const r = await closeNeverMovedInBill(c, lease.id)
        stop = r.cancelAfterCommit
        if (r.closed) closedMoveInBill = { invoiceId: r.invoiceId, amount: r.closedAmount }
        if (setParts.length > 0) {
          await c.query('UPDATE leases SET ' + setParts.join(', ') + ' WHERE id=$' + i, [...values, req.params.id])
        }
        await cascadeLeaseEnd(c, lease.id, lease.unit_id)
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally { c.release() }
      await cancelSupersededIntents(stop)
    } else if (setParts.length > 0) {
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
    // empty array when within range, uncataloged, or non-directional.
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
      // closed_move_in_bill (decisions #46.4): the move-in bill this end zeroed
      // because the tenant never paid it or moved in (null when none was).
      data: { ...updated, state_law_warnings: stateLawWarnings, closed_move_in_bill: closedMoveInBill },
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

type DepositReturnCalc = NonNullable<Awaited<ReturnType<
  typeof import('../services/depositReturn').calculateDepositReturn>>>

// Step 9 (final fix): the money figures the deposit-return page shows, exactly
// as the one move-out calculation worked them out. The page never adds them up
// itself — refund_amount / gap_amount are what finalize pays, and the approval
// threshold is judged on refund_amount.
//   interest_accrued          deposit interest still owed (not yet credited —
//                             unpaidDepositInterest; a month the annual payout
//                             already credited is never counted again)
//   deposit_interest_credited interest the annual payout credited and the
//                             tenant never spent (refunded with the deposit)
//   prepaid_credit_used       the part of the tenant's paid-ahead money the
//                             deductions take (which part is the move-out
//                             calculation's rule, never the page's)
//   prepaid_credit_left       paid-ahead money left over — stays the tenant's
//                             paid-ahead money on the lease, not refunded here;
//                             it waits for the landlord's choice on the
//                             landlord page /leases/:id/paid-ahead-choice
//   refund_from_gam           (decisions #46.3) the part of the refund GAM
//   refund_from_landlord      sends, and the part the landlord hands back
//                             themselves — whoever holds each deposit
//   closed_at_move_out_lines  (decisions #46.4) unpaid deposits and up-front
//                             rent paid ahead finalize closes as no longer
//                             owed (never deducted)
function depositReturnFigures(calc: DepositReturnCalc) {
  return {
    total_deposit:             calc.total_deposit,
    interest_accrued:          calc.interest_accrued,
    deposit_interest_credited: calc.deposit_interest_credited,
    prepaid_credit_used:       calc.prepaid_credit_used,
    prepaid_credit_left:       calc.prepaid_credit_left,
    cleaning_fee_amount:       calc.cleaning_fee_amount,
    final_utility_lines:       calc.final_utility_lines,
    final_utility_total:       calc.final_utility_total,
    damage_lines_total:        calc.damage_lines_total,
    other_deductions_total:    calc.other_deductions_total,
    unpaid_balance_lines:      calc.unpaid_balance_lines,
    unpaid_balance_amount:     calc.unpaid_balance_total,
    total_deductions:          calc.total_deductions,
    refund_amount:             calc.refund_amount,
    gap_amount:                calc.gap_amount,
    refund_from_gam:           calc.refund_from_gam,
    refund_from_landlord:      calc.refund_from_landlord,
    closed_at_move_out_lines:  calc.closed_at_move_out_lines,
    closed_at_move_out_total:  calc.closed_at_move_out_total,
  }
}

/** The household and the space a deposit return is for, by name. */
async function depositReturnHousehold(leaseId: string): Promise<{
  tenant_names: string[]; unit_number: string | null; property_name: string | null
}> {
  const space = await queryOne<{ unit_number: string | null; property_name: string | null }>(
    `SELECT u.unit_number, p.name AS property_name
       FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
      WHERE l.id = $1`, [leaseId])
  const people = await query<{ name: string }>(
    `SELECT btrim(COALESCE(tu.first_name, '') || ' ' || COALESCE(tu.last_name, '')) AS name
       FROM lease_tenants lt
       JOIN tenants t ON t.id = lt.tenant_id
       JOIN users tu ON tu.id = t.user_id
      WHERE lt.lease_id = $1
        AND (lt.status IN ('active', 'pending_remove')
             OR (lt.status = 'removed' AND lt.removed_reason = 'lease_ended'))
      ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END, lt.added_at ASC NULLS LAST, lt.created_at ASC`,
    [leaseId])
  return {
    tenant_names: people.map((x) => x.name).filter((n) => n.length > 0),
    unit_number: space?.unit_number ?? null,
    property_name: space?.property_name ?? null,
  }
}

/** The plain-words refusal for a team member locked to other properties. */
export const DEPOSIT_RETURN_SCOPE_WORDS = 'You are not assigned to this property, so you can\'t work on its move-outs. ' +
  'Ask the landlord to add this property to your access.'

/**
 * Step 9 review (fix pass 3): the lease a deposit-return route works on, with
 * the caller's right to it — the landlord account (read or manage) AND, for a
 * team member locked to some properties (onsite manager, property manager,
 * maintenance), that this lease's property is one of theirs. Before this a
 * property-locked staffer with "Deposit return / move-out" could open, begin,
 * edit and finalize a move-out refund at any property on the account. A read
 * uses the read-side scope (getScopedPropertyIds — a role with no property
 * scope reads as before); a write uses the write guard (assertPropertyInScope),
 * as the paid-ahead choice page does.
 */
async function depositReturnLease(req: any, mode: 'read' | 'write'): Promise<{
  id: string; landlord_id: string; property_id: string; unit_type: string | null
}> {
  const lease = await queryOne<{ id: string; landlord_id: string; property_id: string; unit_type: string | null }>(
    `SELECT l.id, l.landlord_id, u.property_id, u.unit_type
       FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [req.params.id])
  if (!lease) throw new AppError(404, 'Lease not found')
  const allowed = mode === 'read'
    ? canAccessLandlordResource(req.user, lease.landlord_id)
    : canManageLandlordResource(req.user, lease.landlord_id)
  if (!allowed) throw new AppError(403, 'Forbidden')
  const { getScopedPropertyIds, assertPropertyInScope } = await import('../middleware/auth')
  if (mode === 'read') {
    const scoped = await getScopedPropertyIds(req.user)
    if (scoped !== null && !scoped.includes(lease.property_id)) throw new AppError(403, DEPOSIT_RETURN_SCOPE_WORDS)
  } else {
    try { await assertPropertyInScope(req.user, lease.property_id) }
    catch (e) {
      if (e instanceof AppError && e.statusCode === 403) throw new AppError(403, DEPOSIT_RETURN_SCOPE_WORDS)
      throw e
    }
  }
  return lease
}

/** Whether this viewer may run this move-out: "Deposit return / move-out" and the property in their write scope. */
async function canRunMoveOutHere(req: any, propertyId: string): Promise<boolean> {
  if (!userHasPerm(req.user, 'leases.deposit_return')) return false
  const { assertPropertyInScope } = await import('../middleware/auth')
  try { await assertPropertyInScope(req.user, propertyId); return true } catch { return false }
}

/** The latest paid-ahead choice on this lease (services/paidAheadChoice writes them), by name — or null. */
async function latestPaidAheadChoice(leaseId: string): Promise<null | {
  refund_choice: string; refund_total: number; rest_choice: string | null; rest_amount: number
  decided_at: string; decided_by_name: string | null
}> {
  const c = await queryOne<any>(
    `SELECT pc.refund_choice, pc.refund_total::float AS refund_total, pc.rest_choice, pc.rest_amount::float AS rest_amount,
            to_char(pc.decided_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'), 'YYYY-MM-DD') AS decided_at,
            NULLIF(btrim(CONCAT(u.first_name, ' ', u.last_name)), '') AS decided_by_name
       FROM paid_ahead_choices pc
       JOIN leases l ON l.id = pc.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
       LEFT JOIN users u ON u.id = pc.decided_by
      WHERE pc.lease_id = $1
      ORDER BY pc.decided_at DESC, pc.id DESC LIMIT 1`, [leaseId])
  return c ?? null
}

/** Whether this viewer passes the paid-ahead choice page's own gate ("Issue refunds" and the property in scope). */
async function canDecidePaidAheadHere(req: any, propertyId: string): Promise<boolean> {
  if (!userHasPerm(req.user, 'pos.refund')) return false
  const { assertPropertyInScope } = await import('../middleware/auth')
  try { await assertPropertyInScope(req.user, propertyId); return true } catch { return false }
}

leasesRouter.get('/:id/deposit-return', async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'read')

    const { calculateDepositReturn } = await import('../services/depositReturn')
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
    const existing = await queryOne<any>('SELECT * FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    // Fix pass 1 (final fix): each damage line's photo or receipt by its name
    // (the page showed "Evidence 1" after a reload), only this landlord's.
    const evidenceIds = [...new Set(((existing?.damage_lines ?? []) as Array<{ evidenceDocumentIds?: unknown }>)
      .flatMap((l) => Array.isArray(l.evidenceDocumentIds) ? l.evidenceDocumentIds.map(String) : []))]
    const damageEvidence = evidenceIds.length === 0 ? [] : await query<{ id: string; name: string }>(
      `SELECT id, COALESCE(NULLIF(btrim(name), ''), 'Evidence') AS name FROM documents
        WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [evidenceIds, lease.landlord_id])
    const approvalMeta = {
      damage_evidence: damageEvidence,
      approval_threshold: Number((await queryOne<{ t: string }>(
        `SELECT deposit_return_approval_threshold::text AS t FROM landlords WHERE id=$1`,
        [lease.landlord_id]))?.t ?? 500),
      viewer_is_owner: ['landlord', 'admin', 'super_admin'].includes(req.user!.role),
      // Fix pass 3: whose payout and who hands the landlord's part back, in
      // the page's words — "your" only to the landlord themselves; GAM staff
      // (admin) and team members read "the landlord's". viewer_is_owner stays
      // the approval rule.
      viewer_is_landlord: req.user!.role === 'landlord',
      move_out_inspection_required: moveOutRequired,
      move_out_inspection: moveOutInspection,
      // Fix pass 2 (decisions #47c, Nic): who holds the deposit is never shown
      // to tenants or landlords — the page says how each part of a refund
      // comes back instead (refund_from_gam / refund_from_landlord), so the
      // holder is no longer sent.
      // Deposit-page review: who this is, by name — the household and the
      // space — so whoever finalizes a refund can tell it is the right one
      // (the page named the lease only by an id fragment). The people still on
      // the lease, or the ones its end took off it.
      household: await depositReturnHousehold(req.params.id),
      // Whether this viewer may make the landlord's paid-ahead choice — the
      // choice page's own gate: "Issue refunds" (pos.refund) AND this property
      // in their scope (fix pass 3) — so the page offers the button only to
      // someone it lets through.
      viewer_can_decide_paid_ahead: await canDecidePaidAheadHere(req, lease.property_id),
      // Fix pass 1 (final fix): whether this viewer may run this move-out at
      // all (Begin, save, finalize) — "Deposit return / move-out" AND the
      // property in their write scope, the gate those routes use — so the page
      // offers those buttons only to someone they let through.
      viewer_can_run_move_out: await canRunMoveOutHere(req, lease.property_id),
      // Fix pass 1 (final fix): the landlord's paid-ahead choice once it is
      // made (decisions #46.1 / #46.1a) — who decided, when and what — so the
      // page says "Left as their credit on <date> by <name>" instead of asking
      // again. null before any choice.
      paid_ahead_choice: await latestPaidAheadChoice(req.params.id),
      // Step 9 final fix (fix pass 1 — decisions #48.6): a payment on the
      // tenancy still clearing holds up finalize; the page says so, with the
      // day it should clear, before anyone presses Finalize (finalize checks
      // again, fresh, under its locks). null once finalized or when nothing
      // is clearing.
      //
      // Fix pass 2 (review): a payment stuck past a week never clears or
      // fails on its own — the page says GAM has been told, and this read
      // tells GAM (once per payment attempt; the page no longer presses
      // Finalize while anything is clearing, so finalize alone never did).
      payments_clearing: existing?.finalized_at ? null : await (async () => {
        const dr = await import('../services/depositReturn')
        const clearing = await dr.tenancyPaymentsClearing(
          async (t, v) => ({ rows: await query<any>(t, v) }), req.params.id)
        if (clearing && clearing.stuck.length > 0) {
          await dr.noteStuckTenancyPayments(existing?.id ?? null, req.params.id, clearing.stuck)
        }
        return clearing?.words ?? null
      })(),
    }

    if (existing && (existing.status === 'draft' || existing.status === 'awaiting_approval')) {
      // Step 9 (final fix): a draft not yet finalized shows the figures
      // finalize will pay, worked out NOW by the one move-out calculation
      // (depositReturn.calculateDepositReturn → moveOutMath) with the draft's
      // saved damage lines — never the page's own sum. Paid-ahead money left
      // over is not refunded; the interest is only what is still owed. Before
      // this the page worked out deposit + interest − deductions itself, so
      // the landlord could confirm one refund while finalize paid another. The
      // saved row's own refund/gap are a snapshot of the last save; these
      // replace them in the answer.
      const calc = await calculateDepositReturn(
        req.params.id, existing.damage_lines ?? [], existing.other_deductions ?? [])
      if (!calc) throw new AppError(404, 'Lease not found')
      return res.json({ success: true, data: { ...existing, ...depositReturnFigures(calc), ...approvalMeta } })
    }
    if (existing) {
      // A finalized return: the figures it paid, as recorded — the refund and
      // shortfall on the row, the paid-ahead money and credited interest it
      // spent (its 'move_out' credit uses), and the interest not yet credited
      // it paid (its deposit_interest_paid event). The swept lines were settled
      // from the deposit, so none is listed as unpaid; unpaid_balance_amount is
      // the total it settled.
      const spent = await queryOne<{ paid_ahead: string; interest_credited: string }>(
        `SELECT COALESCE(SUM(u.amount) FILTER (WHERE u.prepaid_credit_id IS NOT NULL), 0)::text AS paid_ahead,
                COALESCE(SUM(u.amount) FILTER (WHERE u.tenant_credit_id IS NOT NULL), 0)::text AS interest_credited
           FROM credit_uses u
          WHERE u.deposit_return_id = $1 AND u.source = 'move_out' AND u.status = 'applied'`,
        [existing.id])
      const interestPaid = await queryOne<{ amount: string | null }>(
        `SELECT (e.event_data->>'interest_accrued_total') AS amount
           FROM credit_events e
          WHERE e.event_type = 'deposit_interest_paid'
            AND e.event_data->>'deposit_return_id' = $1
            AND e.superseded_by IS NULL
          ORDER BY e.recorded_at DESC LIMIT 1`,
        [existing.id])
      // Paid-ahead money still on this lease after the move-out (the part the
      // deductions did not take stays the tenant's — it is never refunded with
      // the deposit), through the credit ledger's one rule (usablePaidAheadSql).
      const { usablePaidAheadSql, disputeClaimJoinSql } = await import('../services/creditUse')
      const left = await queryOne<{ left: string }>(
        `SELECT COALESCE(SUM(${usablePaidAheadSql('c', 'dc')}), 0)::text AS left
           FROM lease_prepaid_credits c
           ${disputeClaimJoinSql('c', 'dc')}
          WHERE c.lease_id = $1 AND c.amount_remaining > 0 AND c.voided_at IS NULL
            -- Fix pass 1 (final fix): money a choice already left as the
            -- tenant's credit is decided (decisions #46.1a) — never offered
            -- again (the rule services/paidAheadChoice reads by).
            AND c.left_by_choice_id IS NULL`,
        [req.params.id])
      // 10/4 (decisions #47a): how the refund is going back — each part GAM
      // sends (back the way the deposit was paid, or to give back in cash at
      // the office when that payment cannot take it) and the landlord's own
      // part with its "Mark handed back" day. Read fresh: a part left sending
      // after a crash is sent again, and the share of one whose payment was
      // disputed since is stopped, before it is shown — only when the viewer
      // may run this move-out (fix pass 2: opening the page read-only never
      // moves money; the refund row alone is brought up to date).
      const refundSend = await import('../services/depositRefundSend')
      await refundSend.resumeDepositRefund(existing.id, { act: await canRunMoveOutHere(req, lease.property_id) })
      const refundProgress = existing.status === 'sent_refund' ? await refundSend.depositRefundView(existing.id) : null
      const closedRecorded = ((existing.closed_at_move_out_lines ?? []) as Array<Record<string, unknown>>).map((l) => ({
        payment_id: String(l.payment_id), kind: l.kind === 'prepaid' ? 'prepaid' as const : 'deposit' as const,
        label: String(l.label ?? ''), amount: Number(l.amount) || 0,
      }))
      return res.json({ success: true, data: {
        ...existing,
        total_deposit:             Number(existing.total_deposit),
        total_deductions:          Number(existing.total_deductions),
        refund_amount:             Number(existing.refund_amount),
        gap_amount:                Number(existing.gap_amount),
        // decisions #46.3: who paid which part, as finalize recorded it (null
        // on a return finalized before it was recorded).
        refund_from_gam:           existing.refund_from_gam == null ? null : Number(existing.refund_from_gam),
        refund_from_landlord:      existing.refund_from_landlord == null ? null : Number(existing.refund_from_landlord),
        // decisions #46.4 (fix pass 3): the lines finalize closed as no longer
        // owed, as it recorded them (none recorded on an older return).
        closed_at_move_out_lines:  closedRecorded,
        closed_at_move_out_total:  Math.round(closedRecorded.reduce((t, l) => t + Math.round(l.amount * 100), 0)) / 100,
        unpaid_balance_amount:     Number(existing.unpaid_balance_amount ?? 0),
        unpaid_balance_lines:      [],
        damage_lines_total:        Math.round(((existing.damage_lines ?? []) as Array<{ amount: unknown }>)
                                     .reduce((t, l) => t + (Number(l.amount) || 0), 0) * 100) / 100,
        other_deductions_total:    Math.round(((existing.other_deductions ?? []) as Array<{ amount: unknown }>)
                                     .reduce((t, l) => t + (Number(l.amount) || 0), 0) * 100) / 100,
        final_utility_lines:       [],
        interest_accrued:          Number(interestPaid?.amount ?? 0),
        deposit_interest_credited: Number(spent?.interest_credited ?? 0),
        prepaid_credit_used:       Number(spent?.paid_ahead ?? 0),
        prepaid_credit_left:       Number(left?.left ?? 0),
        refund_progress:           refundProgress,
        ...approvalMeta,
      } })
    }
    // No row yet — return calculation preview
    const calc = await calculateDepositReturn(req.params.id)
    if (!calc) throw new AppError(404, 'Lease not found')
    res.json({ success: true, data: { preview: true, ...calc, ...depositReturnFigures(calc), ...approvalMeta } })
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
      SELECT l.id, l.landlord_id, l.lease_source, b.guest_email, b.guest_name, u.property_id, p.name AS property_name
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
      // 10/5: replies reach the people who run this property (services/replyRouting).
      undefined, { landlordId: lease.landlord_id, replyTo: replyToProperty(lease.property_id) })
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
      SELECT l.*, u.unit_number, unit_number_on(l.unit_id, l.start_date) AS unit_number_then, u.unit_type, p.id AS property_id, p.name AS property_name
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
        // 10/5: replies reach the people who run this property (services/replyRouting).
        replyTo: replyToProperty(lease.property_id),
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
    // S652: jobs they had taken go back on the board for the season.
    const { releaseJobsFor } = await import('../services/workTradeJobs')
    await releaseJobsFor(client, paused.rows.map((r: any) => r.id))
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
      SELECT l.id, l.landlord_id, l.status, l.end_date, u.unit_number, u.property_id, p.name AS property_name
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
        // 10/5: replies reach the people who run this property (services/replyRouting).
        replyTo: replyToProperty(lease.property_id),
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
      timezone: string
    }>(
      `SELECT l.id, l.landlord_id, l.unit_id,
              (SELECT vlat.tenant_id
                 FROM v_lease_active_tenants vlat
                WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
                LIMIT 1) AS tenant_id,
              p.timezone
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
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
      timezone:    lease.timezone,
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
      id: string; landlord_id: string; unit_id: string; tenant_id: string | null; timezone: string
    }>(
      `SELECT l.id, l.landlord_id, l.unit_id,
              (SELECT vlat.tenant_id FROM v_lease_active_tenants vlat
                WHERE vlat.lease_id = l.id AND vlat.role = 'primary' LIMIT 1) AS tenant_id,
              p.timezone
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE l.id = $1`, [req.params.id])
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
      timezone:    lease.timezone,
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
    const lease = await depositReturnLease(req, 'write')

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
    const lease = await depositReturnLease(req, 'write')

    const body = patchSchema.parse(req.body)
    const draft = await queryOne<any>('SELECT id, status FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')
    // Step 9 (final fix): only a draft is edited (applyDeductionsToDraft
    // refuses anything else with a bare error, which reached the page as a
    // server failure). Said in plain words, with what to do.
    if (draft.status === 'awaiting_approval') {
      // Fix pass 1 (final fix): said to the person reading it, with their next step.
      throw new AppError(409, ['landlord', 'admin', 'super_admin'].includes(req.user!.role)
        ? 'This deposit return is waiting for your approval, so its deductions can\'t be changed as it is. ' +
          'You can approve it as it is, or press Send back to draft to change it.'
        : 'This deposit return is waiting for the landlord\'s approval, so its deductions can\'t be changed now. ' +
          'The landlord can approve it as it is, or send it back to draft to change it.')
    }
    if (draft.status !== 'draft') {
      throw new AppError(409, 'This deposit return is already finalized, so it can\'t be changed. The page now shows what it paid.')
    }

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

// POST /api/leases/:id/deposit-return/send-back — fix pass 1 (final fix): a
// return a team member sent for approval goes back to a draft, so the owner
// can change it (a damage line they disagree with) instead of only approving
// it as it is. Owner-level only — the approval is theirs. Nothing is paid and
// nothing else changes; staff can then save and send it again.
leasesRouter.post('/:id/deposit-return/send-back', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    await depositReturnLease(req, 'write')
    if (!['landlord', 'admin', 'super_admin'].includes(req.user!.role)) {
      throw new AppError(403, 'Only the landlord can send a deposit return waiting for approval back to draft.')
    }
    const sent = await queryOne<any>(
      `UPDATE deposit_returns SET status = 'draft', updated_at = NOW()
        WHERE lease_id = $1 AND status = 'awaiting_approval' RETURNING *`, [req.params.id])
    if (!sent) {
      const cur = await queryOne<{ status: string }>(`SELECT status FROM deposit_returns WHERE lease_id = $1`, [req.params.id])
      throw new AppError(409, !cur ? 'There is no deposit return on this lease yet.'
        : cur.status === 'draft' ? 'This deposit return is already a draft. The page now shows it.'
        : 'This deposit return is already finalized, so it can\'t be sent back. The page now shows what it paid.')
    }
    res.json({ success: true, data: sent })
  } catch (e) { next(e) }
})

// The figures the page's confirm showed (each optional — one not sent is not
// checked). Fix pass 3: who refunds which part and the paid-ahead money used
// are checked too — they can move while the refund and shortfall stay put.
const finalizeSchema = z.object({
  expectedRefund:             z.number().nonnegative().optional(),
  expectedGap:                z.number().nonnegative().optional(),
  expectedRefundFromGam:      z.number().nonnegative().optional(),
  expectedRefundFromLandlord: z.number().nonnegative().optional(),
  expectedPaidAheadUsed:      z.number().nonnegative().optional(),
})

leasesRouter.post('/:id/deposit-return/finalize', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'write')

    const draft = await queryOne<any>(
      'SELECT id, status, damage_lines, other_deductions FROM deposit_returns WHERE lease_id=$1', [req.params.id])
    if (!draft) throw new AppError(404, 'No draft. POST first to create.')
    // Step 9 (final fix): in plain words — the page refetches on a 409 and
    // shows what the finished return paid.
    if (!['draft', 'awaiting_approval'].includes(draft.status)) {
      throw new AppError(409, 'This deposit return is already finalized. The page now shows what it paid.')
    }

    // S548 (Nic): staff can run deposit returns without wasting the
    // landlord's time — up to the landlord's threshold. A refund above it
    // parks awaiting_approval; the landlord (or admin) finalizes from
    // there. Gap-only or zero returns move no money out, so staff always
    // may finalize those.
    const isOwnerLevel = ['landlord', 'admin', 'super_admin'].includes(req.user!.role)
    const body = finalizeSchema.parse(req.body ?? {})
    const checkFigures = Object.values(body).some((v) => v !== undefined)
    const { calculateDepositReturn, FIGURES_CHANGED_MESSAGE } = await import('../services/depositReturn')
    const calc = checkFigures
      ? await calculateDepositReturn(req.params.id, draft.damage_lines ?? [], draft.other_deductions ?? [])
      : null
    // Step 9 (fix pass 2): fresh figures at the moment of action. The page
    // sends the refund and shortfall its confirm showed; if a swept payment
    // settled or failed, or a final meter bill landed, since then, nothing is
    // paid and the page reads the new figures in place. This is the early
    // answer; finalizeDepositReturn checks them again under its locks (a
    // change between this read and the locks rolls everything back the same way).
    if (checkFigures) {
      const cents = (n: number | undefined) => Math.round((n ?? 0) * 100)
      const refundNow = calc?.refund_amount ?? 0
      const gapNow = calc?.gap_amount ?? 0
      const differs = (sent: number | undefined, now: number | undefined) => sent !== undefined && cents(sent) !== cents(now)
      if (differs(body.expectedRefund, refundNow) || differs(body.expectedGap, gapNow)
        || differs(body.expectedRefundFromGam, calc?.refund_from_gam)
        || differs(body.expectedRefundFromLandlord, calc?.refund_from_landlord)
        || differs(body.expectedPaidAheadUsed, calc?.prepaid_credit_used)) {
        throw new AppError(409, FIGURES_CHANGED_MESSAGE)
      }
    }
    // S548 + fix pass 1 (final fix): a team member's refund above the
    // landlord's approval limit is parked for the landlord — judged by
    // finalize itself, under its locks, on the refund it would pay now
    // (before this it was judged here, on figures read before the locks, so a
    // caller sending no figures could be paid more than the limit allows).
    const threshold = isOwnerLevel ? undefined : Number((await queryOne<{ t: string }>(
      `SELECT deposit_return_approval_threshold::text AS t FROM landlords WHERE id=$1`,
      [lease.landlord_id]))?.t ?? 500)
    const { finalizeDepositReturn } = await import('../services/depositReturn')
    const finalized = await finalizeDepositReturn(draft.id, req.user!.userId, body, { approvalThreshold: threshold })
    if (finalized.parked) {
      const refund = Number(finalized.refund_amount)
      if (finalized.parked === 'now') {
        const owner = await queryOne<{ user_id: string }>(
          `SELECT user_id FROM landlords WHERE id=$1`, [lease.landlord_id])
        if (owner) {
          const { createNotification } = await import('../services/notifications')
          await createNotification({
            userId: owner.user_id,
            landlordId: lease.landlord_id,
            type: 'deposit_return_approval',
            title: 'Deposit return needs your approval',
            body: `A team member prepared a deposit return with a $${refund.toFixed(2)} refund — above your $${threshold!.toFixed(2)} approval threshold. Review and finalize it.`,
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
    res.json({ success: true, data: finalized })
  } catch (e) { next(e) }
})

// ── The finalized refund going back — 10/4 (decisions #47a, Nic, FINAL) ──
//
// The part GAM holds goes back by itself at finalize (services/depositRefundSend).
// A part the original payment could not take is on the move-out page and the
// owner's to-do list with the way out: Try again (when trying again can work),
// or "Give it back in cash instead" (the office hands it over; GAM pays the
// landlord what it held for it). The landlord's own part gets "Mark handed
// back" with the day. Each answers in plain words; a 409 means the page reads
// the move-out again in place.
const refundPartParams = z.object({ partId: z.string().uuid() })
const cashPartSchema = z.object({ expectedAmount: z.number().finite().optional() }).strict()
const handedBackSchema = z.object({
  handedBackOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the day it was handed back.'),
  expectedAmount: z.number().finite().optional(),
}).strict()

leasesRouter.post('/:id/deposit-return/refund-parts/:partId/try-again', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'write')
    const { partId } = refundPartParams.parse({ partId: req.params.partId })
    const { retryDepositRefundPart } = await import('../services/depositRefundSend')
    res.json({ success: true, data: await retryDepositRefundPart(lease.id, partId) })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return/refund-parts/:partId/cash', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'write')
    const { partId } = refundPartParams.parse({ partId: req.params.partId })
    const body = cashPartSchema.parse(req.body ?? {})
    const { giveDepositPartBackInCash } = await import('../services/depositRefundSend')
    res.json({ success: true, data: await giveDepositPartBackInCash(lease.id, partId, req.user!.userId, {
      expectedAmount: body.expectedAmount,
      // Fix pass 3: "your next payout" only to the landlord themselves — GAM
      // staff (admin) and team members are told "the landlord's next payout".
      viewerIsOwner: req.user!.role === 'landlord',
    }) })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return/landlord-part/handed-back', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'write')
    const body = handedBackSchema.parse(req.body ?? {})
    const { markLandlordPartHandedBack } = await import('../services/depositRefundSend')
    res.json({ success: true, data: await markLandlordPartHandedBack(lease.id, {
      handedBackOn: body.handedBackOn, expectedAmount: body.expectedAmount, actorUserId: req.user!.userId,
    }) })
  } catch (e) { next(e) }
})

leasesRouter.post('/:id/deposit-return/landlord-part/undo', requirePerm('leases.deposit_return'), async (req, res, next) => {
  try {
    const lease = await depositReturnLease(req, 'write')
    const { undoLandlordPartHandedBack } = await import('../services/depositRefundSend')
    res.json({ success: true, data: await undoLandlordPartHandedBack(lease.id) })
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
// ── "They never moved in — end the lease" — 10/4 (decisions #46.4, Nic, FINAL) ──
//
//   "If they never pay the deposit or never move in, you would just zero it out
//    and end the lease."
//
// Step 9 (final fix, fix pass 1): before this the never-moved-in close ran
// only inside PATCH /leases/:id when a status change ended the lease, and no
// screen sends that; the button staff had — Discard — refused a lease the
// tenant had signed ("void the document instead"), and the void refused it too
// ("Cannot void after a tenant has signed"): two errors in a row, no next
// step, and the bill stayed owed. And a lease the scheduler had already made
// active on its start date was never closed at all — the usual case (the day
// came and the tenant never showed).
//
// Now staff say it in so many words: GET reads, fresh, exactly what would be
// zeroed (the confirm lists it); POST does the ONE close — the unpaid MOVE-IN
// bill zeroed with a plain note and voided (decisions #53: only that bill — a
// later month's bill stays owed, and the confirm lists it as "stays owed"),
// the lease ended, the household
// taken off it, the space emptied — in one transaction, checking the total the
// confirm showed under the locks (a change since answers 409 in plain words and
// the window reads it again in place). Staff saying "they never moved in" is
// what lets it close a lease that already went active on its start date
// (lib/unwindIssuedLease.assessNeverMovedIn, attested). When it does not
// apply — money was paid, a payment is on its way, GAM's records say they
// moved in, a renewal, an imported tenancy — it refuses in plain words that
// name the real next step, and nothing changes.

/** The plain-words 409 when what the lease owes changed since the confirm opened (lib/unwindIssuedLease, one copy). */
export { NEVER_MOVED_IN_CHANGED_WORDS } from '../lib/unwindIssuedLease'

const neverMovedInSchema = z.object({ expectedTotal: z.number().finite().optional() }).strict()

/**
 * Fix pass 2: SQL — whether anyone signed a document of lease `a`: the
 * tenant side (anyone but the landlord or a witness — a primary, a tenant, a
 * co-tenant), or anyone at all. ONE test for the Leases page (which button a
 * waiting lease shows) and for Discard (what it does), so the page never
 * offers "discard the unsigned draft" on a lease the server reads as signed.
 * (leases.signed_by_tenant is set only once EVERYONE has signed.)
 */
export function leaseSignedBySql(a: string, who: 'tenant' | 'anyone'): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`leaseSignedBySql: "${a}" is not a table alias`)
  return `EXISTS (SELECT 1 FROM lease_document_signers lss
                   JOIN lease_documents lsd ON lsd.id = lss.document_id
                  WHERE lsd.lease_id = ${a}.id AND lss.signed_at IS NOT NULL
                    ${who === 'tenant' ? `AND lss.role NOT IN ('landlord', 'witness')` : ''})`
}

/** The plain-words 409 when Discard is pressed on a lease a tenant signed without the confirm that lists what is zeroed. */
export const DISCARD_TENANT_SIGNED_WORDS = 'A tenant signed this lease, so it isn’t an unsigned draft. ' +
  'Use “They never moved in — end the lease” — it shows exactly what would be zeroed first.'

/** Who is reading a never-moved-in refusal, so its next step is one they can take. */
function neverMovedInReader(req: any): { canMarkLeaving: boolean; canMoveOut: boolean } {
  return {
    canMarkLeaving: userHasPerm(req.user, 'leases.edit', 'front_desk.mark_leaving'),
    canMoveOut: userHasPerm(req.user, 'leases.deposit_return'),
  }
}

/** The lease, with the caller's right to end it (the landlord account AND the property in their scope). */
async function neverMovedInLease(req: any, mode: 'read' | 'write'): Promise<{
  id: string; landlord_id: string; unit_id: string; property_id: string
}> {
  const lease = await queryOne<{ id: string; landlord_id: string; unit_id: string; property_id: string }>(
    `SELECT l.id, l.landlord_id, l.unit_id, u.property_id
       FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [req.params.id])
  if (!lease) throw new AppError(404, 'This lease is no longer on the account.')
  const allowed = mode === 'read'
    ? canAccessLandlordResource(req.user, lease.landlord_id)
    : canManageLandlordResource(req.user, lease.landlord_id)
  if (!allowed) throw new AppError(403, 'This lease isn’t on your account.')
  const { getScopedPropertyIds, assertPropertyInScope } = await import('../middleware/auth')
  const WORDS = 'You are not assigned to this property, so you can’t end its leases. Ask the landlord to add this property to your access.'
  if (mode === 'read') {
    const scoped = await getScopedPropertyIds(req.user)
    if (scoped !== null && !scoped.includes(lease.property_id)) throw new AppError(403, WORDS)
  } else {
    try { await assertPropertyInScope(req.user, lease.property_id) }
    catch (e) {
      if (e instanceof AppError && e.statusCode === 403) throw new AppError(403, WORDS)
      throw e
    }
  }
  return lease
}

/**
 * The one close for a lease the tenant never moved into (decisions #46.4):
 * zero the unpaid move-in bill and void it (decisions #53 — later bills stay
 * owed), end the lease and take the household
 * off it, cancel the stay it was drafted from — one transaction
 * (lib/unwindIssuedLease.endLeaseNeverMovedIn, the copy the Schedule's Cancel
 * reservation runs too). Refuses (409, nothing changed) in the assessment's
 * plain words when it does not apply, and when `expectedTotal` (what the
 * confirm showed) is not what it would zero now.
 */
async function endLeaseNeverMovedIn(
  lease: { id: string; unit_id: string }, userId: string, expectedTotal: number | undefined,
  reader: { canMarkLeaving: boolean; canMoveOut: boolean },
): Promise<{
  lines: Array<{ payment_id: string; label: string; amount: number }>; total: number; reservationCanceled: boolean
  kept: Array<{ payment_id: string; label: string; amount: number; why: string; due_date: string | null }>; keptTotal: number; keptWords: string | null
}> {
  const { endLeaseNeverMovedIn: endIt } = await import('../lib/unwindIssuedLease')
  const { cancelSupersededIntents } = await import('../services/creditUse')
  // A household's new lease waiting after this one is refused inside the
  // assessment (fix pass 2), so the confirm shows the same refusal.
  const c = await getClient()
  let closed: Awaited<ReturnType<typeof endIt>>
  try {
    await c.query('BEGIN')
    closed = await endIt(c, lease, { reader, expectedTotal, actorUserId: userId })
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
  await cancelSupersededIntents(closed.cancelAfterCommit)
  // The canceled reservation frees its dates: the next waitlister is offered
  // them, as the Schedule's Cancel reservation does (best-effort).
  if (closed.canceledBooking) {
    const { promoteNextWaitlister } = await import('../services/propertyBooking')
    promoteNextWaitlister(closed.canceledBooking.unitId).catch((err) =>
      logger.error({ err, bookingId: closed.canceledBooking?.bookingId }, '[lease] waitlist promote after never-moved-in cancel failed'))
  }
  logger.info({ leaseId: lease.id, by: userId, zeroed: closed.closedAmount, lines: closed.closedPaymentIds.length,
    voidedDocuments: closed.voidedDocumentIds.length, canceledBooking: closed.canceledBooking?.bookingId ?? null },
    '[lease] ended — the tenant never moved in')
  return {
    lines: closed.assessment.lines.map((l) => ({ payment_id: l.paymentId, label: l.label, amount: l.amount })),
    total: closed.closedAmount,
    reservationCanceled: closed.canceledBooking != null,
    // Fix pass 3 (review): what stays owed, as the close read it under its
    // locks — the page's toast is built from this, never from the preview
    // the window opened with (a GAM fee added in between is named too).
    kept: closed.assessment.kept.map((k) => ({ payment_id: k.paymentId, label: k.label, amount: k.amount, why: k.why, due_date: k.dueDate })),
    keptTotal: closed.assessment.keptTotal,
    keptWords: closed.assessment.keptWords,
  }
}

// GET /api/leases/:id/never-moved-in — what "They never moved in — end the
// lease" would zero, read fresh (the confirm lists it), or why it does not apply.
leasesRouter.get('/:id/never-moved-in', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const lease = await neverMovedInLease(req, 'read')
    const { assessNeverMovedIn, reservationCanceledWords, leaseHouseholdNames } = await import('../lib/unwindIssuedLease')
    const a = await assessNeverMovedIn(
      async (sql, params) => ({ rows: await query<any>(sql, params) }), lease.id,
      { attested: true, lock: false, reader: neverMovedInReader(req) })
    res.json({ success: true, data: {
      applies: a.applies,
      words: a.words,
      status: a.status,
      start_date: a.startDate,
      lines: a.lines.map((l) => ({ payment_id: l.paymentId, label: l.label, amount: l.amount, due_date: l.dueDate, utility: l.utility })),
      total: a.total,
      // Step 9 final fix (fix pass 1): what stays owed (GAM's own fees,
      // charges billed on purpose), in plain words; the reservation canceled
      // with the lease; and whether the lease had already ended.
      // Fix pass 2 (review): a later month's rent says the days it covers.
      kept: a.kept.map((k) => ({ payment_id: k.paymentId, label: k.label, amount: k.amount, why: k.why, due_date: k.dueDate,
                                 period_start: k.periodStart ?? null, period_end: k.periodEnd ?? null })),
      kept_total: a.keptTotal,
      kept_words: a.keptWords,
      reservation_words: a.applies && a.reservation ? reservationCanceledWords(a.reservation) : null,
      already_ended: a.alreadyEnded,
      // Fix pass 3 (review): the people by the SAME helper the Schedule's
      // Cancel reservation confirm uses (lib/unwindIssuedLease
      // leaseHouseholdNames — an unsigned add-a-roommate included), so the
      // two confirms that are one close name the same people.
      household: await (async () => {
        const h = await leaseHouseholdNames(async (sql, params) => ({ rows: await query<any>(sql, params) }), lease.id)
        return { tenant_names: h.tenantNames, unit_number: h.unitNumber, property_name: h.propertyName }
      })(),
    } })
  } catch (e) { next(e) }
})

// POST /api/leases/:id/never-moved-in — the close (body: the total the confirm showed).
leasesRouter.post('/:id/never-moved-in', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const body = neverMovedInSchema.parse(req.body ?? {})
    if (body.expectedTotal === undefined) {
      throw new AppError(400, 'Open “They never moved in — end the lease” again: it shows what would be zeroed before you confirm.')
    }
    const lease = await neverMovedInLease(req, 'write')
    const r = await endLeaseNeverMovedIn(lease, req.user!.userId, body.expectedTotal, neverMovedInReader(req))
    const now = await queryOne<{ status: string }>(`SELECT status FROM leases WHERE id = $1`, [lease.id])
    res.json({ success: true, data: {
      id: lease.id, status: now?.status ?? 'terminated', zeroed_lines: r.lines, zeroed_total: r.total,
      reservation_canceled: r.reservationCanceled,
      kept: r.kept, kept_total: r.keptTotal, kept_words: r.keptWords,
    } })
  } catch (e) { next(e) }
})

// ── POST /api/leases/:id/discard — S640 (Nic) ───────────────────────────────
//
//   "The one lease in review, that's the one that was supposed to delete when I
//    deleted it from the master schedule. So why is that still there? There's
//    no way to delete it either. So it's just useless filler... just delete it
//    for now. I've got other things to do."
//
// It survived because the reservation was cancelled about three hours before
// the code that takes the draft with it went live. Fine — but the deeper
// problem is that there was no way out. A draft nobody can execute, delete or
// complete sits on the dashboard as a permanent action item, and the only
// button on it opens a PDF that does not exist.
//
// So: a way to discard one. It is a SOFT close, not a delete (GAM keeps
// everything) — the row stays, marked terminated, with who did it and when.
// A lease that reached 'active' is an agreement between two people, and no
// Discard ends a tenancy (one whose tenant never came ends through "They never
// moved in — end the lease").
//
// Step 9 (final fix, fix pass 1 — decisions #46.4): a pending lease the TENANT
// signed is no longer refused. Nobody can void it (a tenant signed), so Discard
// runs the same single close as "They never moved in — end the lease": the
// unpaid move-in bill zeroed, the lease ended — or a refusal in plain words
// naming the real next step when money was paid. A lease only the landlord
// signed is voided on the GoldSign page (that takes its bill back and tells the
// tenant).
//
// Fix pass 2: "a tenant signed" is ONE test (leaseSignedBySql — any signer but
// the landlord or a witness), shared with the Leases list, so the page offers
// Discard only where the server treats the lease as an unsigned draft. On a
// tenant-signed lease the confirm's total (expectedTotal) is required: without
// it Discard answers 409 'tenant_signed' and changes nothing, and the page
// opens "They never moved in — end the lease", which shows what is zeroed.
// The close also voids the lease's paperwork still waiting for signatures
// (lib/unwindIssuedLease.closeNeverMovedInBill), so a later signature can't
// issue a lease that already ended.
//
// Fix pass 3: every Discard path checks the property scope first (a team
// member locked to other properties is refused in plain words, nothing
// changes) — before only the tenant-signed path did. A lease only the
// landlord signed answers 409 'landlord_signed' (the page reads the list
// again, so the row shows "Void on the GoldSign page"). And discarding an
// unsigned draft cancels its own paperwork still out for signature, in the
// same transaction, under a lock that checks again that nobody has signed —
// a signing link already sent no longer works (before, a tenant could sign
// after the Discard and a later landlord signature issued an ended lease).
leasesRouter.post('/:id/discard', requirePerm('leases.terminate'), async (req, res, next) => {
  try {
    const body = neverMovedInSchema.parse(req.body ?? {})
    // The account AND the property in this person's scope, in plain words.
    await neverMovedInLease(req, 'write')
    const lease = await queryOne<any>(
      `SELECT id, landlord_id, status, lease_source, unit_id FROM leases WHERE id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'This lease is no longer on the account.')
    if (!['pending', 'draft'].includes(lease.status)) {
      throw new AppError(400, lease.status === 'active'
        ? 'This lease is in force, so it can’t be discarded. If the tenant never moved in, use Change → “They never moved in — end the lease”. ' +
          'If they live there and are leaving, use Change → “They’re leaving on…”.'
        // Step 9 final fix (fix pass 1): never "Nothing else to do" — an ended
        // lease may still carry a bill (its Change menu offers "They never
        // moved in — zero the bill" when it does).
        : 'This lease has already ended, so there is nothing to discard.')
    }
    const signed = await queryOne<{ tenant: boolean; anyone: boolean }>(
      `SELECT ${leaseSignedBySql('l', 'tenant')} AS tenant, ${leaseSignedBySql('l', 'anyone')} AS anyone
         FROM leases l WHERE l.id = $1`, [req.params.id])
    if (signed?.tenant === true) {
      // Fix pass 2: the confirm that lists what is zeroed is required. A
      // Discard pressed from a stale list ("the unsigned draft … nothing is
      // sent") must never zero a bill nobody was shown: 409, and the Leases
      // page opens "They never moved in — end the lease" in its place.
      if (body.expectedTotal === undefined) {
        return res.status(409).json({ success: false, error: DISCARD_TENANT_SIGNED_WORDS, code: 'tenant_signed' })
      }
      const r = await endLeaseNeverMovedIn(lease, req.user!.userId, body.expectedTotal, neverMovedInReader(req))
      return res.json({ success: true, data: {
        id: req.params.id, status: 'terminated', zeroed_lines: r.lines, zeroed_total: r.total, reservation_canceled: r.reservationCanceled,
        kept: r.kept, kept_total: r.keptTotal, kept_words: r.keptWords,
      } })
    }
    // Only the landlord signed: the void takes the lease and its bill back and
    // tells the tenant (lib/unwindIssuedLease.unwindIssuedLease). 409 with a
    // code: the list read before the landlord signed is stale, and the page
    // reads it again so the row shows "Void on the GoldSign page".
    if (signed?.anyone === true) {
      return res.status(409).json({ success: false, error: DISCARD_LANDLORD_SIGNED_WORDS, code: 'landlord_signed' })
    }

    const voided = await discardUnsignedDraft(req.params.id)
    if (voided.refused) {
      return res.status(409).json({ success: false, error: voided.refused.words, code: voided.refused.code })
    }
    logger.info({ leaseId: req.params.id, by: req.user!.userId, source: lease.lease_source, voidedDocuments: voided.documentIds.length },
      '[lease] unsigned draft discarded')
    res.json({ success: true, data: { id: req.params.id, status: 'terminated' } })
  } catch (e) { next(e) }
})

/** The plain-words 409 when Discard is pressed on a lease only the landlord signed. */
export const DISCARD_LANDLORD_SIGNED_WORDS = 'You signed this lease and the tenant hasn’t yet. Void its document on the GoldSign page instead — ' +
  'that takes the lease and its bill back and tells the tenant.'

/** The void reason on an unsigned draft's paperwork canceled by Discard. */
export const DISCARD_VOID_REASON = 'The lease ended: the unsigned draft was discarded'

/**
 * Fix pass 3: discard an unsigned draft — ONE transaction. The lease and its
 * own paperwork are locked, the "nobody signed" test runs again under the
 * locks (a signature since the page read it is refused in plain words, nothing
 * changed), its documents still out for signature are voided (they can't be
 * signed afterwards; a home-sale document is not the lease's and is left
 * alone), their scheduled money changes canceled (as every void does), and the
 * lease ends. Soft: every row stays.
 */
async function discardUnsignedDraft(leaseId: string): Promise<{
  documentIds: string[]; refused: { code: 'tenant_signed' | 'landlord_signed' | 'not_a_draft'; words: string } | null
}> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const l = (await c.query<{ status: string }>(`SELECT status FROM leases WHERE id = $1 FOR UPDATE`, [leaseId])).rows[0]
    await c.query(`SELECT id FROM lease_documents WHERE lease_id = $1 ORDER BY id FOR UPDATE`, [leaseId])
    const now = (await c.query<{ tenant: boolean; anyone: boolean }>(
      `SELECT ${leaseSignedBySql('l', 'tenant')} AS tenant, ${leaseSignedBySql('l', 'anyone')} AS anyone
         FROM leases l WHERE l.id = $1`, [leaseId])).rows[0]
    const refused = !l || !['pending', 'draft'].includes(l.status)
      ? { code: 'not_a_draft' as const, words: 'This lease is no longer a draft, so nothing was discarded. The list now shows it as it is.' }
      : now?.tenant === true ? { code: 'tenant_signed' as const, words: DISCARD_TENANT_SIGNED_WORDS }
      : now?.anyone === true ? { code: 'landlord_signed' as const, words: DISCARD_LANDLORD_SIGNED_WORDS }
      : null
    if (refused) {
      await c.query('ROLLBACK')
      return { documentIds: [], refused }
    }
    const documentIds = (await c.query<{ id: string }>(
      `UPDATE lease_documents
          SET status = 'voided', voided_at = NOW(), updated_at = NOW(), void_reason = $2
        WHERE lease_id = $1
          AND status IN ('pending', 'sent', 'in_progress')
          AND document_type IN ('original_lease', 'addendum_add', 'addendum_remove', 'addendum_terms',
                                'work_trade_addendum', 'sublease_agreement')
        RETURNING id`, [leaseId, DISCARD_VOID_REASON])).rows.map((r) => r.id)
    if (documentIds.length > 0) {
      await c.query(
        `UPDATE scheduled_lease_changes SET status = 'cancelled', updated_at = NOW()
          WHERE source_document_id = ANY($1::uuid[]) AND status IN ('draft', 'scheduled')`, [documentIds])
    }
    await c.query(
      `UPDATE leases
          SET status = 'terminated', needs_review = FALSE, updated_at = NOW()
        WHERE id = $1`, [leaseId])
    await c.query('COMMIT')
    return { documentIds, refused: null }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

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
      tenantId: u.profileId!,
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
      `SELECT l.id, l.landlord_id, l.unit_id, lt.tenant_id, p.timezone
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
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

    // S654: "today" is the park's day — a UTC date runs a day ahead every
    // evening in Phoenix, and the invoice would be dated tomorrow.
    const today = todayIn(lease.timezone)
    const due = body.dueDate ?? today
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const invoiceNumber = await allocateInvoiceNumber(client, lease.landlord_id, Number(today.slice(0, 4)))
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


/**
 * POST /api/leases/:id/move — the resident changes spaces, the tenancy does not.
 *
 * Nic: "I don't wanna have to terminate their lease, send them a new lease for
 * the new spot, etcetera. I want to just be able to move them in the system and
 * say, as of this date, they moved from this spot to this spot."
 *
 * Returns the meters that need a reading on the move date — closing numbers on
 * the space they left, opening numbers on the space they took. Without both
 * there is no seam in the month's usage, and the bill blends two spaces into
 * one figure nobody can check.
 */
leasesRouter.post('/:id/move', requirePerm('leases.edit'), async (req: any, res, next) => {
  try {
    const body = z.object({
      toUnitId: z.string().uuid(),
      movedOn:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason:   z.string().max(500).nullable().optional(),
      // S652: one reading per submeter on both spaces, taken at the time of the move.
      reads:    z.array(z.object({ meterId: z.string().uuid(), value: z.number().int().min(0) })).max(40).optional(),
    }).parse(req.body)

    const lease = await queryOne<{ landlord_id: string }>(
      'SELECT landlord_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')

    const { moveLeaseToUnit } = await import('../services/unitMove')
    const result = await moveLeaseToUnit({
      leaseId: req.params.id,
      toUnitId: body.toUnitId,
      movedOn: body.movedOn,
      reason: body.reason ?? null,
      actorUserId: req.user?.userId ?? null,
      reads: body.reads,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ── S653 (Nic): "THEY'RE LEAVING ON…" — a front-desk mark, not a document ──
//
// "They're going to come in and say, hey, I'm pulling out Saturday with like
// maybe three or four days notice, if that. We need the front desk to be able
// to mark it as, hey, they're leaving then. When we get the final meter read,
// we can initiate the final bill cycle." And: "I don't want it physically on
// the document."
//
// The mark sets the lease's end date (see services/moveOutNotice.ts for what
// that sets in motion). Gated on its own key so the desk can hold it without
// being handed lease editing; a landlord and anyone with leases.edit hold it
// too. A team member is further held to the parks they work at.

async function leaseInScope(req: any, leaseId: string) {
  const { loadLeaseForNotice } = await import('../services/moveOutNotice')
  const lease = await loadLeaseForNotice(leaseId)
  if (!lease) throw new AppError(404, 'Lease not found')
  if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
  const { getScopedPropertyIds } = await import('../middleware/auth')
  const scoped = await getScopedPropertyIds(req.user)
  if (scoped && !scoped.includes(lease.property_id)) throw new AppError(403, 'That resident is at a property you do not work at')
  return lease
}

// ── S653 (Nic): A MONTHLY DRAW ON PAID-AHEAD CREDIT ────────────────────────
//
//   "she prepays ahead of time with her tax return but she likes part of the
//    tax return to be credited on her bill each month so she still pays a
//    little bit out of pocket each month... use only a dedicated amount of the
//    credit each month."
//
// One number on the lease: the most paid-ahead money a billing month may use.
// Null clears it. Read by the bill run, the tenant's Pay Now and the desk alike
// (creditUse.householdQuote caps the plan with it).
//
// S655 (Nic, 10/2): credit pays a bill by itself only when it covers the WHOLE
// bill. Raising or clearing the cap can make the paid-ahead money cover this
// month's whole bill, so the whole-bill check runs for the household right
// after the change (its own transaction; it never undoes the change) — the same
// check the bill run and the late-fee run make. The answer says what the credit
// covers now, and whether it just paid the bill.
//
// Because the change can spend the tenant's money, a team member is held to
// the parks they work at, as for the leaving mark beside it (leaseInScope): a
// desk locked to one park cannot lift the monthly limit on a lease at another.
leasesRouter.patch('/:id/prepaid-draw', requirePerm('leases.edit', 'take_payment', 'front_desk.mark_leaving'), async (req: any, res, next) => {
  try {
    const body = z.object({ monthlyDraw: z.number().positive().max(100000).nullable() }).parse(req.body)
    await leaseInScope(req, req.params.id)
    const lease = await queryOne<{ id: string; landlord_id: string; status: string; timezone: string; cap: string | null }>(
      `SELECT l.id, l.landlord_id, l.status, p.timezone, l.prepaid_monthly_draw::text AS cap
         FROM leases l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE l.id = $1`, [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    await query(`UPDATE leases SET prepaid_monthly_draw = $2, updated_at = NOW() WHERE id = $1`,
      [lease.id, body.monthlyDraw == null ? null : body.monthlyDraw.toFixed(2)])

    // The household: everyone on the lease now (their bills share its paid-ahead money).
    const members = (await query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM lease_tenants
        WHERE lease_id = $1 AND status IN ('active','pending_add','pending_remove')
        ORDER BY tenant_id`, [lease.id])).map(m => m.tenant_id)

    // More room than before (raised or cleared): the money may now cover the
    // whole bill. A lower cap never makes a bill payable from credit.
    const before = lease.cap == null ? null : Number(lease.cap)
    const raised = body.monthlyDraw == null ? before != null : (before != null && body.monthlyDraw > before)
    let paidByCredit: string[] = []
    if (raised) {
      const { runWholeBillCheckAfterCommit } = await import('../services/creditUse')
      for (const tenantId of members) {
        const r = await runWholeBillCheckAfterCommit({ tenantId, landlordId: lease.landlord_id, onlyLeaseIds: [lease.id] })
        paidByCredit = paidByCredit.concat(r?.settledIds ?? [])
      }
    }

    const { prepaidDrawAvailable } = await import('../services/prepaidRelease')
    const { db } = await import('../db')
    // S654: the billing month is the park's month — on the last evening of a
    // month UTC has already turned the page.
    const month = monthStartOf(todayIn(lease.timezone))
    const draw = await prepaidDrawAvailable(db as any, lease.id, month).catch(() => null)
    // What credit (of any kind) would pay of this lease's open bill right now —
    // the "credit available" the desk and the tenant see (openBalances.creditBeside).
    const { creditBeside } = await import('../services/openBalances')
    const creditAvailable = members.length
      ? (await creditBeside({ tenantId: members[0], landlordIds: [lease.landlord_id], leaseIds: [lease.id] }))
          .usableByLease.get(lease.id) ?? 0
      : 0
    logger.info({ leaseId: lease.id, monthlyDraw: body.monthlyDraw, paidByCredit: paidByCredit.length, by: req.user!.userId }, '[lease] prepaid monthly draw set')
    res.json({ success: true, data: {
      leaseId: lease.id, monthlyDraw: body.monthlyDraw, credit: draw,
      creditAvailable,
      // The charges the credit paid just now because the new limit lets it cover the whole bill.
      paidByCredit: paidByCredit.length,
    } })
  } catch (e) { next(e) }
})

/** POST /api/leases/:id/leaving { on, note? } — record the day they said. */
leasesRouter.post('/:id/leaving', requirePerm(...LEAVING_PERMS), async (req: any, res, next) => {
  try {
    const body = z.object({
      on:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().max(500).nullable().optional(),
    }).parse(req.body)
    await leaseInScope(req, req.params.id)
    const { recordMoveOutNotice } = await import('../services/moveOutNotice')
    const lease = await recordMoveOutNotice({
      leaseId: req.params.id, on: body.on, note: body.note ?? null, byUserId: req.user!.userId,
    })
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

/** DELETE /api/leases/:id/leaving — they changed their mind; back to the lease as it was. */
leasesRouter.delete('/:id/leaving', requirePerm(...LEAVING_PERMS), async (req: any, res, next) => {
  try {
    await leaseInScope(req, req.params.id)
    const { cancelMoveOutNotice } = await import('../services/moveOutNotice')
    const lease = await cancelMoveOutNotice({ leaseId: req.params.id, byUserId: req.user!.userId })
    res.json({ success: true, data: lease })
  } catch (e) { next(e) }
})

/**
 * GET /api/leases/:id/move-reads?toUnitId= — the meters a move to that space
 * will need read, so the move screen can ask for the numbers BEFORE moving.
 */
leasesRouter.get('/:id/move-reads', requirePerm('leases.edit'), async (req: any, res, next) => {
  try {
    const toUnitId = z.string().uuid().parse(req.query.toUnitId)
    const lease = await queryOne<{ landlord_id: string; unit_id: string }>(
      'SELECT landlord_id, unit_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    const { metersFor } = await import('../services/unitMove')
    const [closing, opening] = await Promise.all([metersFor(lease.unit_id), metersFor(toUnitId)])
    const shape = (rows: any[], kind: string) => rows.map(m => ({
      meterId: m.meter_id, label: m.label, utilityType: m.utility_type, kind, digits: Number(m.digits) || 6,
      lastValue: m.last_value != null ? Math.trunc(Number(m.last_value)) : null, lastDate: m.last_date, lastReason: m.last_reason,
    }))
    res.json({ success: true, data: [...shape(closing, 'closing'), ...shape(opening, 'opening')] })
  } catch (e) { next(e) }
})

/** GET /api/leases/:id/units — every space this tenancy has occupied, newest first. */
leasesRouter.get('/:id/units', requirePerm('leases.view'), async (req: any, res, next) => {
  try {
    const lease = await queryOne<{ landlord_id: string }>(
      'SELECT landlord_id FROM leases WHERE id = $1', [req.params.id])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Forbidden')
    const rows = await query<any>(`
      SELECT h.unit_id,
             COALESCE(unit_number_on(h.unit_id, h.effective_from::timestamptz), u.unit_number) AS unit_number,
             u.unit_number AS unit_number_now,
             to_char(h.effective_from,'YYYY-MM-DD') AS effective_from,
             to_char(h.effective_to,'YYYY-MM-DD')   AS effective_to,
             h.reason
        FROM lease_unit_history h
        JOIN units u ON u.id = h.unit_id
       WHERE h.lease_id = $1
       ORDER BY h.effective_from DESC`, [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})
