import { Router } from 'express'
import { z } from 'zod'
import { extractUploadFilename, resolveUploadPath } from '../lib/uploadPaths'
import { cascadeLeaseTenantsOnVoid } from '../lib/leaseDocCascade'
import {
  LeaseDocumentType,
  UnitType,
  UNIT_TYPES,
  LeaseColumn,
  LeaseColumnVals,
  LEASE_COLUMN_CATEGORY,
  isScreeningFeeText,
  LEASE_COLUMN_LABEL,
  LEASE_COLUMN_VALUE_BEARING_CATEGORIES,
  WRITABLE_LEASE_COLUMN_SPECS,
  FEE_ROW_SPECS,
  UTILITY_ROW_SPECS,
  validateLeaseDocumentForSend,
  STANDALONE_DOCUMENT_TYPES,
  NO_LEASE_DOCUMENT_TYPES,
  LEASE_TEMPLATE_PURPOSES,
  isValidSignerRole,
  MIGRATION_WINDOW_DAYS,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { generateMoveInInvoice } from '../jobs/moveInBundle'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { stampPdf } from '../services/pdfStamp'
import { resolveLateFeePolicyForUnit, lateFeePolicyToPrefills } from '../services/lateFeePolicy'
import { suggestUnitPrefill } from '../services/leasePrefill'
import { detectPropertyFromPdf } from '../services/templatePropertyDetect'
import { createAdminNotification } from '../services/adminNotifications'
import { emailSigningRequest, emailSigningCompleted } from '../services/email'
import { createNotification } from '../services/notifications'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { logger } from '../lib/logger'
import { draftHouseholdLease, resolveHouseholdByEmail, draftPendingForUnitType } from '../services/householdLeaseDraft'
import { activateHomeSaleContract } from '../services/homeSale'
import { releaseSuspendedChargesForLease } from '../services/utilityBilling'

export const esignRouter = Router()

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const LANDLORD_APP_URL = process.env.LANDLORD_APP_URL || 'http://localhost:3001'
const TENANT_APP_URL   = process.env.TENANT_APP_URL   || 'http://localhost:3002'

// Signer roles: exactly one 'primary', zero-or-more 'co_tenant_N', at least one
// 'landlord', optional 'witness'. Template slots that aren't filled at document
// creation time get their fields pruned (see POST /documents).
const TENANT_ROLE_PATTERN = /^(primary|co_tenant_\d+)$/
function isTenantRole(role: string): boolean { return TENANT_ROLE_PATTERN.test(role) }

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

type Bucket = 'residential' | 'storage' | 'commercial'
function bucketFor(unitType: UnitType): Bucket {
  if (unitType === 'storage') return 'storage'
  if (unitType === 'commercial') return 'commercial'
  return 'residential'
}

/**
 * For a SET of tenants signing a new lease together, check each one's existing
 * active/pending leases for bucket-overlap. If ANY tenant conflicts, return
 * the conflict. Prevents double-booking roommates.
 */
async function canTenantsSignNewLease(
  tenantIds: string[],
  newUnitId: string,
  newStartDate: string,
  newEndDate: string | null,
  excludeLeaseId?: string
): Promise<{ ok: boolean; reason?: string; conflictingTenantId?: string; conflictingLeaseId?: string }> {
  if (!tenantIds.length) return { ok: false, reason: 'No tenants provided' }
  const newUnit = await queryOne<any>(
    `SELECT u.unit_type, p.landlord_id FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
    [newUnitId])
  if (!newUnit) return { ok: false, reason: 'Unit not found' }
  const newBucket = bucketFor(newUnit.unit_type)

  for (const tenantId of tenantIds) {
    const actives = await query<any>(`
      SELECT l.id, l.start_date, l.end_date, l.landlord_id, l.unit_id, u.unit_type, u.unit_number,
        tu.first_name || ' ' || tu.last_name as tenant_name
      FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
      JOIN units u ON u.id = l.unit_id
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users tu ON tu.id = t.user_id
      WHERE lt.tenant_id = $1
        AND lt.status IN ('active','pending_add')
        AND l.status IN ('active','pending')
        AND ($2::uuid IS NULL OR l.id != $2)`,
      [tenantId, excludeLeaseId || null])

    for (const l of actives as any[]) {
      if (bucketFor(l.unit_type) !== newBucket) continue
      // S553 (Nic, Oak Park): SAME-LANDLORD overlap on a DIFFERENT unit is
      // deliberate — a landlord drafting a second lease for their own
      // tenant (e.g. space rent on two mobile homes) is doing it on
      // purpose, and the tenant still signs the printed document. The
      // guard's real targets stay blocked: cross-landlord double-booking,
      // and two active leases on the SAME unit.
      if (l.landlord_id === newUnit.landlord_id && l.unit_id !== newUnitId) continue
      const aStart = new Date(l.start_date)
      const aEnd   = l.end_date ? new Date(l.end_date) : null
      const bStart = new Date(newStartDate)
      const bEnd   = newEndDate ? new Date(newEndDate) : null
      const overlaps =
        (aEnd === null || aEnd >= bStart) &&
        (bEnd === null || bEnd >= aStart)
      if (overlaps) {
        return {
          ok: false,
          reason: `Tenant ${l.tenant_name} has an overlapping ${newBucket} lease (Unit ${l.unit_number}).`,
          conflictingTenantId: tenantId,
          conflictingLeaseId: l.id
        }
      }
    }
  }
  return { ok: true }
}

async function checkPlatformBlock(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const tenant = await queryOne<any>(
    'SELECT platform_status FROM tenants WHERE user_id=$1', [userId])
  if (!tenant) return { ok: true } // not a tenant (landlord signer)
  if (tenant.platform_status === 'blocked') {
    return { ok: false, reason: 'Your GAM account has an outstanding balance. Contact support to resolve.' }
  }
  if (tenant.platform_status === 'suspended') {
    return { ok: false, reason: 'Your GAM account is suspended. Contact support.' }
  }
  return { ok: true }
}

/**
 * Resolve the primary tenant signer + all co-tenant signers from a document,
 * loading their tenant_id for each. Returns null if required tenants are missing.
 */
async function getDocumentTenantSigners(documentId: string): Promise<{
  primary: { signerId: string; userId: string; tenantId: string; name: string; email: string } | null,
  coTenants: Array<{ signerId: string; userId: string; tenantId: string; name: string; email: string; role: string }>
}> {
  const rows = await query<any>(`
    SELECT s.id as signer_id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
    FROM lease_document_signers s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN tenants t ON t.user_id = s.user_id
    WHERE s.document_id=$1
    ORDER BY s.order_index`, [documentId])

  let primary = null
  const coTenants: any[] = []
  for (const r of rows as any[]) {
    if (!isTenantRole(r.role)) continue
    const record = { signerId: r.signer_id, userId: r.user_id, tenantId: r.tenant_id, name: r.name, email: r.email, role: r.role }
    if (r.role === 'primary') primary = record
    else coTenants.push(record)
  }
  return { primary, coTenants }
}

/**
 * INSERT a lease_documents row + signers + template-derived fields atomically.
 * Pure data-layer helper — no business validation, no type-specific rules.
 * Caller must validate everything first (signer composition, overlap, platform
 * blocks, roster invariants) and must open the transaction. Helper only writes.
 *
 * Returns the created lease_documents row.
 */
export async function createDocumentRecord(client: any, opts: {
  landlordId: string,
  templateId: string | null,
  unitId: string | null,
  leaseId: string | null,
  title: string,
  basePdfUrl: string | null,
  documentType: LeaseDocumentType,
  targetLeaseTenantId: string | null,
  promoteLeaseTenantId: string | null,
  // W-7 (S531): set when this original_lease document renews an existing
  // lease — completion copies the predecessor's deposits + the lease-end
  // processor hands the unit off instead of vacating.
  renewsLeaseId?: string | null,
  // S604 (Nic): the landlord ALREADY holds this tenant's deposit — migration
  // onboarding. The lease still states the deposit; it just isn't billed.
  depositAlreadyHeld?: boolean,
  signers: Array<{ userId: string, role: string, name: string, email: string, phone?: string | null, orderIndex?: number }>,
  // S629: values stamped onto placed fields at draft time, keyed by
  // lease_column. It was always read (see the late-fee and renewal prefills
  // below, which write into it) but never declared, so a caller passing it —
  // the home-sale purchase agreement — was a type error while the mechanism
  // underneath worked perfectly well.
  prefillValues?: Record<string, string>,
}): Promise<any> {
  // INSERT lease_documents — includes document_type and addendum-specific FKs
  const doc = await client.query(`
    INSERT INTO lease_documents (
      template_id, landlord_id, unit_id, lease_id,
      title, base_pdf_url,
      document_type, target_lease_tenant_id, promote_lease_tenant_id,
      renews_lease_id, deposit_already_held
    ) VALUES ($1,$2,$3,$4, $5,$6, $7,$8,$9, $10,$11)
    RETURNING *`,
    [
      opts.templateId, opts.landlordId, opts.unitId, opts.leaseId,
      opts.title, opts.basePdfUrl,
      opts.documentType, opts.targetLeaseTenantId, opts.promoteLeaseTenantId,
      opts.renewsLeaseId || null,
      opts.depositAlreadyHeld === true
    ]).then((r: any) => r.rows[0])

  // S605 (Nic): "if a previous run drafted the lease, then it should know that
  // now that it's saving it." ANY original lease created for a unit — drafted
  // here, or sent by hand through e-sign — closes out that unit's waiting
  // invites. Without this, a manually-sent lease left its rows open forever and
  // every future template save retried and skipped the same unit.
  //
  // This choke point is the right home for it: every lease document in the
  // system is created through this function, so no path can leave stale rows.
  if (opts.unitId && opts.documentType === 'original_lease') {
    await client.query(
      `UPDATE pending_lease_drafts
          SET resolved_at = now(), resolved_document_id = $2
        WHERE unit_id = $1 AND resolved_at IS NULL`, [opts.unitId, doc.id])
  }

  // INSERT signers
  for (const s of opts.signers) {
    const token = crypto.randomBytes(32).toString('hex')
    await client.query(`
      INSERT INTO lease_document_signers
        (document_id, user_id, role, name, email, phone, order_index, token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, s.userId, s.role, s.name, s.email, s.phone || null, s.orderIndex || 1, token])
  }

  // S535 (Nic): PROPERTY-LEVEL late fees — anti-discrimination. When the
  // property has a late-fee policy, it OVERRIDES any caller-supplied
  // late-fee prefills so every document drafted at the property carries
  // identical late terms. The signed lease snapshot remains the billing
  // source (lease-is-law — you bill what the tenant signed); this choke
  // point is where uniformity is enforced going forward. The fields lock
  // in the signing UI — the landlord changes the POLICY on the property,
  // never the individual lease.
  if (opts.unitId) {
    // S535: late fees resolve per (property, UNIT TYPE) row ONLY — no
    // property-wide default, no per-lease values, no carry-over from a
    // predecessor. Every bound late-fee field is baselined to 'N/A'
    // (= this class has no late fee) and the resolved policy overlays
    // when one exists. The unit's type pulls the fee policy the same
    // way it pulls the template.
    const pv: Record<string, string> = (opts as any).prefillValues = (opts as any).prefillValues || {}
    for (const k of Object.keys(pv)) if (k.startsWith('late_fee_')) delete pv[k]
    for (const tag of ['late_fee_grace_days', 'late_fee_initial_flat', 'late_fee_initial_percent',
      'late_fee_accrual_flat_daily', 'late_fee_accrual_flat_weekly', 'late_fee_accrual_flat_monthly',
      'late_fee_accrual_percent_daily', 'late_fee_accrual_percent_weekly', 'late_fee_accrual_percent_monthly',
      'late_fee_cap_flat', 'late_fee_cap_percent']) {
      pv[tag] = 'N/A'
    }
    const plf = await resolveLateFeePolicyForUnit(opts.unitId, client)
    if (plf) {
      const policyPrefills = lateFeePolicyToPrefills(plf)
      // S535 (Nic): the late fee must appear IN the lease document —
      // court enforcement goes by the signed document, never by how
      // the software is configured. If the policy produces values the
      // chosen template can't display, drafting REFUSES rather than
      // silently producing an unenforceable (or fee-less) lease.
      if (opts.documentType === 'original_lease') {
        const policyTags = Object.keys(policyPrefills)
        const bound = opts.templateId
          ? await client.query(
              `SELECT lease_column FROM lease_template_fields
                WHERE template_id = $1 AND lease_column = ANY($2)`,
              [opts.templateId, policyTags]).then((r: any) => new Set(r.rows.map((x: any) => x.lease_column)))
          : new Set<string>()
        // S622: a template can satisfy this in PROSE. Most leases print the late
        // charge as a clause, never as a blank, so no field can exist to bind —
        // and refusing on that basis blocks drafting for a document that states
        // the policy perfectly well in words. The guard's purpose is that the
        // terms APPEAR in the signed document; a clause does that.
        const proseTerms = opts.templateId
          ? await client.query('SELECT late_fee_terms FROM lease_templates WHERE id=$1', [opts.templateId])
              .then((r: any) => r.rows[0]?.late_fee_terms ?? null)
          : null
        const missing = proseTerms ? [] : policyTags.filter(t => !bound.has(t))
        if (missing.length > 0) {
          const labels = missing.map(t => LEASE_COLUMN_LABEL[t as LeaseColumn] || t).join(', ')
          const typeLabel = plf.unit_type ? String(plf.unit_type).replace('_', ' ') : 'this unit type'
          throw new AppError(400,
            `The ${typeLabel} late-fee policy must appear IN the lease document — courts enforce the document, not software settings. ` +
            (opts.templateId
              ? `This template is missing: ${labels}. Add those fields in the template editor, or remove the late-fee policy for ${typeLabel}.`
              : `Use a template with late-fee fields (${labels}).`))
        }
      }
      Object.assign(pv, policyPrefills)
    }
  }

  // S556/S558 (Nic): auto-populate lease boxes from the assigned unit's data so
  // the landlord doesn't retype what the unit already knows — rent, derived
  // security deposit (unit rent × the template's stated deposit_months, S558),
  // unit number, property name/address. Only for ORIGINAL leases: renewals
  // prefill from the prior lease, and a rent increase surfaces a landlord-
  // confirmed deposit top-up, never a silent change. Caller-supplied values
  // always win (we only fill blanks), so the Document Values form can still
  // override anything.
  if (opts.unitId && opts.documentType === 'original_lease') {
    const pv: Record<string, string> = (opts as any).prefillValues = (opts as any).prefillValues || {}
    const suggested = await suggestUnitPrefill(opts.unitId, client, opts.templateId)
    for (const [col, val] of Object.entries(suggested)) {
      if (val && (pv[col] == null || pv[col] === '')) pv[col] = val // caller-supplied wins
    }
    // S582: rent due day is PLATFORM-LOCKED to the 1st — force the value so any
    // placed rent_due_day box renders "the 1st" in the signed lease (the landlord
    // never chooses it). Overrides any caller value on purpose.
    pv.rent_due_day = '1st'
  }

  // Copy template fields — match by signer_role, prune unused role slots
  if (opts.templateId) {
    const filledRoles = new Set(opts.signers.map(s => s.role))
    const tmplFields = await client.query(
      'SELECT * FROM lease_template_fields WHERE template_id=$1',
      [opts.templateId]).then((r: any) => r.rows)
    const docSigners = await client.query(
      'SELECT * FROM lease_document_signers WHERE document_id=$1',
      [doc.id]).then((r: any) => r.rows)

    const prefillValues: Record<string,string> = (opts as any).prefillValues || {}
    for (const f of tmplFields as any[]) {
      if (f.signer_role && !filledRoles.has(f.signer_role)) continue
      const signer = (docSigners as any[]).find((s: any) => s.role === f.signer_role)
      // If this field is bound to a lease_column and the send form supplied a value,
      // persist it now so it auto-renders for signers. Signature/initial/date_signed
      // are filled by signers themselves and are never prefilled here.
      const prefill = f.lease_column && prefillValues[f.lease_column] != null
        ? String(prefillValues[f.lease_column])
        : null
      await client.query(`
        INSERT INTO lease_document_fields
          (document_id, template_field_id, signer_id, field_type, signer_role, label, lease_column,
           page, x, y, width, height, required, font_css, value, options, parent_field_id, parent_option)
        VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [doc.id, f.id, signer?.id || null, f.field_type, f.signer_role, f.label, f.lease_column,
         f.page, f.x, f.y, f.width, f.height, f.required, f.font_css, prefill, f.options ?? null,
         // parent_field_id references the parent TEMPLATE field id; the sign UI
         // matches child.parent_field_id to the parent doc field's template_field_id.
         f.parent_field_id ?? null, f.parent_option ?? null])
    }
  }

  return doc
}

/**
 * Build lease_tenants rows (and possibly a new lease) from a completed document.
 * Dispatcher — opens the transaction, loads the doc, routes to the appropriate
 * execute function by document_type. Each execute function receives the open
 * client and must NOT manage transaction lifecycle.
 * Throws AppError on any failure, rolling back so we never leave half-built state.
 */
async function resolveScopeToUnitIds(
  client: any,
  landlordId: string,
  scopeType: 'units' | 'property' | 'landlord_all',
  scopeRef: any
): Promise<string[]> {
  if (scopeType === 'units') {
    const unitIds = scopeRef?.unit_ids;
    if (!Array.isArray(unitIds) || unitIds.length === 0) {
      throw new Error("scope_ref.unit_ids must be a non-empty array");
    }
    const deduped = [...new Set(unitIds)];
    const result = await client.query(
      "SELECT id FROM units WHERE id = ANY($1::uuid[]) AND landlord_id = $2",
      [deduped, landlordId]
    );
    if (result.rows.length !== deduped.length) {
      const found = new Set(result.rows.map((r: any) => r.id));
      const missing = deduped.filter((id) => !found.has(id));
      throw new Error(`Units not found or not owned by landlord: ${missing.join(', ')}`);
    }
    return deduped;
  }
  if (scopeType === 'property') {
    const propertyId = scopeRef?.property_id;
    if (!propertyId || typeof propertyId !== 'string') {
      throw new Error("scope_ref.property_id is required");
    }
    const prop = await client.query(
      "SELECT id FROM properties WHERE id = $1 AND landlord_id = $2",
      [propertyId, landlordId]
    );
    if (prop.rows.length === 0) {
      throw new Error("Property not found or not owned by landlord");
    }
    const units = await client.query(
      "SELECT id FROM units WHERE property_id = $1 AND landlord_id = $2",
      [propertyId, landlordId]
    );
    return units.rows.map((r: any) => r.id);
  }
  if (scopeType === 'landlord_all') {
    const units = await client.query(
      "SELECT id FROM units WHERE landlord_id = $1",
      [landlordId]
    );
    return units.rows.map((r: any) => r.id);
  }
  throw new Error(`Unknown scope_type: ${scopeType}`);
}

async function resolveUnitsToApplicableLeases(
  client: any,
  landlordId: string,
  unitIds: string[]
): Promise<Array<{ id: string; unit_id: string; status: string }>> {
  if (unitIds.length === 0) {
    return [];
  }
  const result = await client.query(
    `SELECT id, unit_id, status
     FROM leases
     WHERE unit_id = ANY($1::uuid[])
       AND landlord_id = $2
       AND status IN ('pending', 'active')
     ORDER BY created_at ASC`,
    [unitIds, landlordId]
  );
  return result.rows;
}

export async function buildLeaseFromDocument(documentId: string): Promise<{ leaseId: string; status: string; primaryTenantId: string; alreadyBuilt: boolean }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // S581 (sweep, Nic): serialize finalization of THIS document. Completion is
    // detected POST-commit with a check-then-act COUNT (see the sign route), so
    // a duplicate or racing final signature — a double-click, or two tied-order
    // co-tenants both submitting last — can have two requests each observe "all
    // signed" and both land here. The lease INSERT below has NO DB backstop
    // (there is no unique link document→lease, and no one-active-lease-per-unit
    // constraint), so the second build materialized a SECOND lease + a SECOND
    // move-in invoice: double deposit + double first-month rent + double PM
    // leasing fee. This xact advisory lock makes the second builder wait for the
    // first to COMMIT; the already-built short-circuit below then no-ops it.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`esign_finalize:${documentId}`])

    const doc = await client.query(
      `SELECT d.*, u.unit_type
       FROM lease_documents d LEFT JOIN units u ON u.id = d.unit_id
       WHERE d.id=$1`, [documentId]).then(r => r.rows[0])
    if (!doc) throw new AppError(404, 'Document not found')

    // Idempotent finalization for EVERY document_type. finalized_at is stamped
    // at the END of a successful build below, inside THIS txn — so it commits
    // before the advisory lock releases. A duplicate/concurrent finalization that
    // acquires the lock next sees it set and returns the already-built result
    // instead of applying the document a SECOND time: a second lease + move-in
    // invoice (original_lease), a re-added/removed tenant or re-applied term
    // change (addendums), or a re-activated sublease. The duplicate caller skips
    // all one-time side effects, so the returned ids only need to identify the
    // built artifact (lease for lease/addendum docs, subleases row for subleases).
    if (doc.finalized_at) {
      let leaseId = doc.lease_id ?? ''
      let status = 'active'
      let primaryTenantId = ''
      if (doc.document_type === 'sublease_agreement') {
        const sub = await client.query(
          `SELECT id, status, sublessor_tenant_id FROM subleases WHERE sublease_document_id = $1 LIMIT 1`,
          [documentId]).then((r: any) => r.rows[0])
        if (sub) { leaseId = sub.id; status = sub.status; primaryTenantId = sub.sublessor_tenant_id ?? '' }
      } else if (doc.lease_id) {
        const ex = await client.query(
          `SELECT l.status,
                  (SELECT lt.tenant_id FROM lease_tenants lt
                    WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status = 'active'
                    ORDER BY lt.added_at LIMIT 1) AS primary_tenant_id
             FROM leases l WHERE l.id = $1`, [doc.lease_id]).then((r: any) => r.rows[0])
        if (ex) { status = ex.status; primaryTenantId = ex.primary_tenant_id ?? '' }
      }
      await client.query('COMMIT')
      return { leaseId, status, primaryTenantId, alreadyBuilt: true }
    }

    let result: { leaseId: string; status: string; primaryTenantId: string }
    switch (doc.document_type) {
      case 'original_lease':
        result = await executeOriginalLease(client, doc)
        break
      case 'addendum_add':
        result = await executeAddendumAdd(client, doc)
        break
      case 'addendum_remove':
        result = await executeAddendumRemove(client, doc)
        break
      case 'addendum_terms':
        result = await executeAddendumTerms(client, doc)
        break
      case 'sublease_agreement': {
        // S251: sublease completion. Different shape from lease docs —
        // there's no lease build; we flip the linked subleases row to
        // 'active' and stamp the document URL. Return shape stays
        // lease-shaped (`leaseId`=sublease_id) so the dispatcher's
        // return signature doesn't need to change; downstream
        // consumers that key on it for sublease docs are aware.
        // S337: pass the open client so the sublease flip runs inside
        // buildLeaseFromDocument's BEGIN/COMMIT and rolls back atomically
        // if anything downstream fails.
        const { executeSubleaseAgreementCompletion } = await import('../services/subleaseDocuments')
        const sub = await executeSubleaseAgreementCompletion({ documentId: doc.id }, client)
        // Get the sublessor_tenant_id for the lease-shaped return.
        const subleaseRow = await client.query(
          'SELECT sublessor_tenant_id FROM subleases WHERE id=$1',
          [sub.subleaseId]).then((r: any) => r.rows[0])
        result = {
          leaseId:         sub.subleaseId,
          status:          sub.status,
          primaryTenantId: subleaseRow?.sublessor_tenant_id ?? '',
        }
        break
      }
      default:
        throw new AppError(400, `Unknown document_type: ${doc.document_type}`)
    }

    // S581: mark the document finalized so a duplicate/concurrent build no-ops
    // (checked under the advisory lock at the top). Same txn as the build.
    await client.query('UPDATE lease_documents SET finalized_at = NOW() WHERE id = $1', [documentId])
    await client.query('COMMIT')
    return { ...result, alreadyBuilt: false }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * S111: post a one-time leasing fee for the contracted PM company when
 * applicable. Reads properties.pm_company_id + pm_fee_plan_id via the unit;
 * checks the plan's leasing_fee_amount; posts allocation_pm_company_fee
 * ledger entry to the PM company's payout user. No-op for self-managed
 * properties or plans without a leasing fee.
 */
async function postLeasingFeeIfApplicable(client: any, leaseId: string, unitId: string): Promise<void> {
  const r = await client.query(`
    SELECT p.id AS property_id,
           p.pm_company_id, p.pm_fee_plan_id,
           c.bank_account_id AS pm_bank_account_id,
           ba.user_id AS pm_payout_user_id,
           fp.leasing_fee_amount
      FROM units u
      JOIN properties p ON p.id = u.property_id
 LEFT JOIN pm_companies c ON c.id = p.pm_company_id
 LEFT JOIN pm_fee_plans fp ON fp.id = p.pm_fee_plan_id
 LEFT JOIN user_bank_accounts ba ON ba.id = c.bank_account_id
     WHERE u.id = $1`, [unitId])
  if (r.rowCount === 0) return
  const row = r.rows[0]
  if (!row.pm_company_id || !row.pm_fee_plan_id) return
  if (row.leasing_fee_amount === null || parseFloat(row.leasing_fee_amount) <= 0) return
  if (!row.pm_payout_user_id) {
    throw new AppError(409,
      `PM company ${row.pm_company_id} has no bank routing — cannot post leasing fee.`)
  }

  const amount = round2Esign(parseFloat(row.leasing_fee_amount))

  // Per-user advisory lock — same key allocation.ts uses.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`user_balance:${row.pm_payout_user_id}`]
  )
  const prev = await client.query(
    `SELECT balance_after FROM user_balance_ledger
      WHERE user_id=$1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [row.pm_payout_user_id]
  )
  const prevBal = prev.rows[0] ? parseFloat(prev.rows[0].balance_after) : 0
  const newBal = round2Esign(prevBal + amount)

  await client.query(
    `INSERT INTO user_balance_ledger
       (user_id, type, amount, balance_after, reference_id, reference_type,
        property_id, bank_account_id, notes)
     VALUES ($1, 'allocation_pm_company_fee', $2, $3, $4, 'lease',
             $5, $6, $7)`,
    [row.pm_payout_user_id, amount, newBal, leaseId, row.property_id,
     row.pm_bank_account_id,
     `PM company leasing fee on lease ${leaseId} (plan ${row.pm_fee_plan_id})`]
  )
}

function round2Esign(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Execute an original_lease document: INSERT a new leases row + lease_tenants
 * rows for every tenant signer. Sets unit status to active if lease starts
 * today/past. Receives the already-open client — caller owns transaction.
 */
async function executeOriginalLease(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.unit_id) throw new AppError(400, 'Document has no unit — cannot build lease')

  // Read all field values mapped to lease columns
  const fields = await client.query(
    `SELECT lease_column, value, signer_role FROM lease_document_fields
     WHERE document_id=$1 AND lease_column IS NOT NULL`, [doc.id]).then((r: any) => r.rows)
  // Drop identity + signature tags; writable + fee_row + utility_row tags
  // all populate `vals`. WRITABLE_LEASE_COLUMN_SPECS / FEE_ROW_SPECS /
  // UTILITY_ROW_SPECS each only read their own per-tag key from vals, so
  // sharing the dict across all three downstream consumers is safe.
  // S334 fix-it-right: previously this filter kept only 'writable', which
  // silently zeroed out lease_fees + lease_utility_responsibilities at
  // every completion (S28 chain wired but never executed). No production
  // exposure because pre-launch.
  const vals: LeaseColumnVals = {}
  // S622: this loop used to be `vals[col] = f.value` — last row wins, on a query
  // with no ORDER BY. A template whose move-in table tagged four different
  // amounts as rent_amount ("First month's rent", "Rent pre-payment",
  // "Proration", "Total due") would therefore set the tenant's MONTHLY RENT from
  // whichever row Postgres returned last. The placer now allows only one owner
  // per money column, but a template can also be hand-edited, so refuse the
  // ambiguity here rather than resolve it arbitrarily: silently charging a
  // tenant the move-in total every month is far worse than failing to build.
  //
  // Duplicates that AGREE are harmless (the same figure restated on the lease).
  const seen: Record<string, string> = {}
  for (const f of fields) {
    const col = f.lease_column as LeaseColumn | null
    if (!col) continue
    if (!(col in LEASE_COLUMN_CATEGORY)) continue
    const cat = LEASE_COLUMN_CATEGORY[col]
    if (cat === 'identity' || cat === 'signature') continue
    if (f.value == null) continue
    const v = String(f.value).trim()
    if (col in seen && seen[col] !== v) {
      throw new AppError(400,
        `This lease has two different values tagged "${col}" (${seen[col]} and ${v}). ` +
        `Open the template, and leave that tag on only the field that states the lease's ${col} — ` +
        `the others can stay as plain text boxes.`)
    }
    seen[col] = v
    vals[col] = f.value
  }

  // Gather all tenant signers
  const tenantRows = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, s.order_index, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1
     ORDER BY s.order_index`, [doc.id]).then((r: any) => r.rows)

  const tenantSigners = tenantRows.filter((r:any) => isTenantRole(r.role))
  const primarySigner = tenantSigners.find((r:any) => r.role === 'primary')
  if (!primarySigner) throw new AppError(400, 'No primary tenant signer found')
  if (!primarySigner.tenant_id) throw new AppError(400, `Primary signer ${primarySigner.email} has no tenant profile`)
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
  }

  // Platform block check on every tenant
  for (const t of tenantSigners) {
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  // Required fields
  const startDate = vals.start_date
  const rentAmount = vals.rent_amount
  if (!startDate) throw new AppError(400, 'Template missing start_date field — cannot build lease')
  if (!rentAmount) throw new AppError(400, 'Template missing rent_amount field — cannot build lease')

  // Overlap check across EVERY tenant
  const allTenantIds = tenantSigners.map((t:any) => t.tenant_id)
  const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startDate, vals.end_date || null)
  if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')

  // Status: future start → pending, today/past → active
  const today = new Date(); today.setHours(0,0,0,0)
  const start = new Date(startDate)
  const leaseStatus = start > today ? 'pending' : 'active'

  // INSERT lease — writable-column portion dynamically assembled from the
  // shared spec registry. Adding a new writable value to WRITABLE_LEASE_COLUMN_SPECS
  // in @gam/shared automatically wires it into lease creation; no change here.
  // Object.entries preserves insertion order → column list and values align pairwise.
  const writableCols: string[] = []
  const writablePlaceholders: string[] = []
  const writableValues: (string | number | boolean | null)[] = []
  let paramIdx = 1
  for (const [, spec] of Object.entries(WRITABLE_LEASE_COLUMN_SPECS)) {
    const parsed = spec.parse(vals)
    for (const [col, val] of Object.entries(parsed)) {
      writableCols.push(col)
      writablePlaceholders.push('$' + paramIdx)
      writableValues.push(val)
      paramIdx++
    }
  }
  // Fixed-shape tail columns (not driven by lease_column fields)
  const tailCols = ['unit_id', 'landlord_id', 'status']
  const tailValues: (string | null)[] = [doc.unit_id, doc.landlord_id, leaseStatus]
  const tailPlaceholders = tailCols.map((_, i) => '$' + (paramIdx + i))

  const lease = await client.query(
    `INSERT INTO leases (
       ${writableCols.join(', ')},
       ${tailCols.join(', ')},
       signed_by_landlord, signed_by_tenant, signed_at,
       needs_review
     ) VALUES (
       ${writablePlaceholders.join(', ')},
       ${tailPlaceholders.join(', ')},
       TRUE, TRUE, NOW(),
       FALSE
     ) RETURNING id, status`,
    [...writableValues, ...tailValues]
  ).then((r: any) => r.rows[0])

  // S577: stamp late_fee_accrual_from onto the lease from the (property, unit_type)
  // policy. It's a computation QUALIFIER on the daily-accrual clause, not a
  // fillable box — so it rides directly from the policy rather than a template
  // field (keeping existing late-fee templates draftable / document-first intact).
  // The retroactive nature is rendered into the late-fee clause text the tenant
  // signs (services/leasePdf.ts). Resolved at sign-completion; policy rarely
  // changes between draft and sign, and existing signed leases keep 'grace_end'.
  {
    const plf = await resolveLateFeePolicyForUnit(doc.unit_id, client)
    if (plf && plf.late_fee_accrual_from && plf.late_fee_accrual_from !== 'grace_end') {
      await client.query('UPDATE leases SET late_fee_accrual_from=$1 WHERE id=$2',
        [plf.late_fee_accrual_from, lease.id])
    }
  }

  // S196: security_deposit is now part of FEE_ROW_SPECS, which the
  // loop below iterates and inserts into lease_fees automatically.
  // The S195 dual-write helper call has been removed here — FEE_ROW
  // pipeline is the canonical path.

  // INSERT lease_tenants rows — one per signer, with per-tenant supersedes chain
  for (const t of tenantSigners) {
    const priorLt = await client.query(`
      SELECT id FROM lease_tenants
      WHERE tenant_id=$1 AND status='removed'
      ORDER BY removed_at DESC NULLS LAST, created_at DESC
      LIMIT 1`, [t.tenant_id]).then((r: any) => r.rows[0])

    const role = t.role === 'primary' ? 'primary' : 'co_tenant'
    await client.query(`
      INSERT INTO lease_tenants (
        lease_id, tenant_id, role, status,
        added_at, added_reason, financial_responsibility,
        add_document_id, supersedes_lease_tenant_id
      ) VALUES ($1,$2,$3,'active', NOW(), 'original', 'joint_several', $4, $5)`,
      [lease.id, t.tenant_id, role, doc.id, priorLt?.id || null])
  }

  // Link document → lease
  await client.query('UPDATE lease_documents SET lease_id=$1 WHERE id=$2', [lease.id, doc.id])

  // ────────────────────────────────────────────────────────────────────────
  // S111: PM company leasing fee. If this property is contracted to a PM
  // company on a plan with leasing_fee_amount set, post a one-time
  // 'allocation_pm_company_fee' ledger entry. Fires regardless of the
  // plan's primary fee_type — composite plans (e.g. flat_monthly +
  // leasing_fee_amount) both fire monthly and on lease creation.
  // reference_id = lease.id, reference_type = 'lease' so it doesn't
  // collide with rent-payment or monthly-accrual ledger references.
  // Idempotent via the lease.id reference (lease can only be created
  // once; if buildLeaseFromDocument is retried after a partial failure,
  // the surrounding tx ROLLBACKs the whole chain).
  await postLeasingFeeIfApplicable(client, lease.id, doc.unit_id)

  // ────────────────────────────────────────────────────────────────────────
  // S28: write lease_fees rows from FEE_ROW_SPECS
  // Each spec returns null when the tag is not bound; non-null = INSERT.
  // S154: each row is compared against the property's fee schedule
  // (anti-discrimination policy). If amount/timing/refundable doesn't
  // match a corresponding schedule row, is_override is flagged TRUE so
  // landlord can document the rationale post-finalize.
  // ────────────────────────────────────────────────────────────────────────
  const propertyId: string | undefined = await client.query(
    `SELECT property_id FROM units WHERE id = $1`,
    [doc.unit_id],
  ).then((r: any) => r.rows[0]?.property_id)
  const scheduleRows: any[] = propertyId
    ? await client.query(
        `SELECT fee_type, slot_index, description, amount, is_refundable, due_timing
           FROM property_fee_schedules
          WHERE property_id = $1`,
        [propertyId],
      ).then((r: any) => r.rows)
    : []
  // Index by fee_type for single-instance types (slot_index=0).
  // other_fee comparison is best-effort: match the first slot since the
  // doc parser only produces one other_fee row per lease.
  const scheduleByType: Record<string, any> = {}
  for (const s of scheduleRows) {
    if (!scheduleByType[s.fee_type]) scheduleByType[s.fee_type] = s
  }

  for (const [, spec] of Object.entries(FEE_ROW_SPECS)) {
    const parsed = spec.parse(vals)
    if (!parsed) continue

    // S534: on a RENEWAL the deposit printed in the document is the
    // CARRIED deposit — the tenant already paid it on the predecessor
    // lease and the money never moves. NEVER re-bill the carried amount;
    // the renews_lease_id carry-forward INSERT (after invoice generation)
    // copies the predecessor's rows instead. The double-count guard:
    //   doc value == carried → nothing bills (pure carry)
    //   doc value >  carried → bill ONLY the difference as a tagged
    //     top-up row, and raise the custody target so the settlement
    //     helper records the pull (a 'funded' row flips to 'partial'
    //     until the top-up lands)
    //   doc value <  carried → no automatic refund; the landlord
    //     processes a partial return from the deposit tools (the sign
    //     flow's overlay says exactly this before they enter a number)
    if (doc.renews_lease_id && parsed.due_timing === 'move_in' && parsed.is_refundable) {
      const carried = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM lease_fees
          WHERE lease_id=$1 AND fee_type=$2 AND due_timing='move_in' AND is_refundable=TRUE`,
        [doc.renews_lease_id, parsed.fee_type],
      ).then((r: any) => Number(r.rows[0]?.total || 0))
      const delta = Math.round((Number(parsed.amount) - carried) * 100) / 100
      if (delta > 0) {
        await client.query(
          `INSERT INTO lease_fees (
             lease_id, fee_type, amount, is_refundable, due_timing, description, is_override
           ) VALUES ($1, $2, $3, TRUE, 'move_in', $4, FALSE)`,
          [lease.id, parsed.fee_type, delta.toFixed(2),
           `[deposit top-up on renewal] $${carried.toFixed(2)} carried + $${delta.toFixed(2)} newly billed`],
        )
        await client.query(
          `UPDATE security_deposits
              SET total_amount = total_amount + $2::numeric,
                  status = CASE WHEN status = 'funded' THEN 'partial' ELSE status END,
                  updated_at = NOW()
            WHERE lease_id = $1 AND flex_deposit_enabled = FALSE`,
          [doc.renews_lease_id, delta.toFixed(2)],
        )
      }
      continue
    }

    // Determine override flag: TRUE when no schedule row exists OR
    // amount / timing / refundable differs.
    const sched = scheduleByType[parsed.fee_type]
    let isOverride = true
    if (sched
        && Number(sched.amount) === Number(parsed.amount)
        && sched.is_refundable === parsed.is_refundable
        && sched.due_timing === parsed.due_timing) {
      isOverride = false
    }
    // If property has no schedule at all, treat as not-an-override
    // (no policy to deviate from). Only flag when a schedule exists
    // for this fee_type AND the lease row differs.
    if (!sched) isOverride = false

    await client.query(
      `INSERT INTO lease_fees (
         lease_id, fee_type, amount, is_refundable, due_timing, is_override
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [lease.id, parsed.fee_type, parsed.amount, parsed.is_refundable, parsed.due_timing, isOverride]
    )
  }

  // ────────────────────────────────────────────────────────────────────────
  // S622: conditional fees the template states in PROSE — no blank, so no
  // tagged field could ever carry them. The landlord confirmed these on the
  // template; every lease sent from it inherits them.
  //
  // Written in the SAME shape the import path uses (resolveIntent, S550):
  // other_fee / move_out / condition_text verbatim. That shape is what makes
  // the deposit-return sum skip them until a human assesses the condition as
  // failed at the move-out inspection — unassessed or met never charges.
  //
  // Nic's requirement, and the reason this is here and not only on import:
  // "some leases are gonna be imported, scanned PDFs, and other ones are gonna
  // be electronic signature. It needs to work both ways universally."
  // ────────────────────────────────────────────────────────────────────────
  // S622: LEASE IS LAW. When the template states its late-fee terms in prose,
  // those words are what the parties signed, so they are what GAM charges —
  // stamped onto the lease rather than left to the property policy, which may
  // say something else. Oak Park's clause reads "$5.00 per day … not received by
  // the due date" while the property policy carried a five-day grace; the
  // document wins.
  if (doc.template_id) {
    const lft = await client.query(
      'SELECT late_fee_terms FROM lease_templates WHERE id=$1', [doc.template_id]
    ).then((r: any) => r.rows[0]?.late_fee_terms ?? null)
    if (lft) {
      await client.query(
        `UPDATE leases SET
           late_fee_enabled        = TRUE,
           late_fee_grace_days     = COALESCE($2, late_fee_grace_days),
           late_fee_initial_amount = COALESCE($3, late_fee_initial_amount),
           late_fee_initial_type   = COALESCE($4, late_fee_initial_type),
           late_fee_accrual_amount = COALESCE($5, late_fee_accrual_amount),
           late_fee_accrual_type   = COALESCE($6, late_fee_accrual_type),
           late_fee_accrual_period = COALESCE($7, late_fee_accrual_period)
         WHERE id = $1`,
        [lease.id, lft.graceDays, lft.initialAmount, lft.initialType,
         lft.accrualAmount, lft.accrualType, lft.accrualPeriod])
    }
  }

  if (doc.template_id) {
    const tcf = await client.query(
      `SELECT label, amount, condition_text FROM lease_template_conditional_fees
        WHERE template_id = $1`, [doc.template_id]).then((r: any) => r.rows)
    for (const cf of tcf as any[]) {
      // S622 belt-and-braces: screening fees are already filtered out before a
      // landlord ever confirms one, but a row could be inserted by hand or
      // predate that filter. A background-check fee must never become a charge.
      if (isScreeningFeeText(cf.condition_text)) continue
      await client.query(
        `INSERT INTO lease_fees
           (lease_id, fee_type, amount, is_refundable, due_timing, description, condition_text)
         VALUES ($1, 'other_fee', $2, FALSE, 'move_out', $3, $4)`,
        [lease.id, cf.amount, String(cf.label).slice(0, 120), String(cf.condition_text).slice(0, 1000)])
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // S28: write lease_utility_responsibilities rows from UTILITY_ROW_SPECS
  // One row per tagged utility recording who is contractually responsible.
  // Meter pointer (lease_utility_assignments) is a separate operational
  // concern set by landlord later.
  // ────────────────────────────────────────────────────────────────────────
  for (const [, spec] of Object.entries(UTILITY_ROW_SPECS)) {
    const parsed = spec.parse(vals)
    if (!parsed) continue
    await client.query(
      `INSERT INTO lease_utility_responsibilities (
         lease_id, utility_type, tenant_responsible
       ) VALUES ($1, $2, $3)`,
      [lease.id, parsed.utility_type, parsed.tenant_responsible]
    )
  }

  // If activating now, set unit status
  if (leaseStatus === 'active') {
    await client.query(
      `UPDATE units SET status='active', updated_at=NOW() WHERE id=$1`,
      [doc.unit_id])
  }

  // ────────────────────────────────────────────────────────────────────────
  // S28: generate move-in invoice on the same transaction. Reads
  // lease_fees rows we just inserted via the same client (visible because
  // shared connection at READ COMMITTED). Throws on failure → outer
  // buildLeaseFromDocument catches → entire chain rolls back atomically.
  // ────────────────────────────────────────────────────────────────────────
  const rentAmountNum = Number(vals.rent_amount)
  if (!Number.isFinite(rentAmountNum) || rentAmountNum <= 0) {
    throw new AppError(400, `Invalid rent_amount: ${vals.rent_amount}`)
  }
  // ────────────────────────────────────────────────────────────────────────
  // S604 (Nic): DEPOSIT ALREADY IN CUSTODY — migration onboarding.
  //
  // A landlord moving EXISTING tenants onto GAM has them e-sign a new lease.
  // Without this, generateMoveInInvoice bills the security deposit to a tenant
  // whose deposit the landlord has held for years. Oak Park would have invoiced
  // 19 sitting tenants $350 each on day one.
  //
  // The lease still STATES the deposit (the lease_fees row above is written
  // normally) so the signed document is correct and the move-out sweep still
  // sees it — only the BILLING is suppressed.
  //
  // Implemented by pre-creating the custody row as already funded and marking it
  // 'carried_forward', which is the same signal the S516 double-charge guard in
  // generateMoveInInvoice already honours for a deposit carried between GAM
  // leases. Reusing that guard rather than adding a second suppression path
  // keeps one code path responsible for "never bill a deposit twice".
  if (doc.deposit_already_held) {
    const depFee = await client.query(
      `SELECT amount::text AS amount FROM lease_fees
        WHERE lease_id = $1 AND fee_type = 'security_deposit' AND due_timing = 'move_in'
        LIMIT 1`,
      [lease.id])
    const heldAmount = Number((depFee.rows[0] as any)?.amount ?? 0)
    if (heldAmount > 0 && primarySigner.tenant_id) {
      // held_by mirrors the S604 custody gate: GAM only takes custody where the
      // state permits its vehicle. A migrated deposit the landlord physically
      // holds stays with the landlord regardless, so this is landlord-held.
      // security_deposits has NO unique constraint on lease_id, so this is a
      // check-then-act rather than an upsert. Safe: buildLeaseFromDocument runs
      // inside one transaction holding an advisory lock on this document.
      const existingDep = await client.query(
        `SELECT id FROM security_deposits WHERE lease_id = $1 LIMIT 1`, [lease.id])
      if (existingDep.rows[0]) {
        await client.query(
          `UPDATE security_deposits
              SET total_amount = $2, collected_amount = $2, status = 'funded',
                  held_by = 'landlord', portability_status = 'carried_forward',
                  updated_at = NOW()
            WHERE id = $1`,
          [(existingDep.rows[0] as any).id, heldAmount.toFixed(2)])
      } else {
        await client.query(
          `INSERT INTO security_deposits
             (unit_id, lease_id, tenant_id, total_amount, collected_amount,
              status, held_by, portability_status)
           VALUES ($1, $2, $3, $4, $4, 'funded', 'landlord', 'carried_forward')`,
          [doc.unit_id, lease.id, primarySigner.tenant_id, heldAmount.toFixed(2)])
      }
    }
  }

  // S196: security_deposit no longer passed as a separate input — it
  // flows in via the lease_fees move_in iteration inside
  // generateMoveInInvoice.
  await generateMoveInInvoice(
    {
      lease_id: lease.id,
      unit_id: doc.unit_id,
      tenant_id: primarySigner.tenant_id,
      landlord_id: doc.landlord_id,
      rent_amount: rentAmountNum,
      start_date: startDate,
    },
    client
  )

  // W-7 (S531): renewal completion — the deposit carries forward. Copy the
  // predecessor's refundable move-in deposits onto the new lease AFTER
  // move-in invoice generation, so they exist for the final move-out
  // deposit sweep without being re-billed (the tenant already paid them on
  // the original lease). Also close the loop on the renewal request.
  if (doc.renews_lease_id) {
    // S534: a same-type "deposit top-up" row (delta billing when the
    // landlord raised the deposit in the renewal doc) must NOT block the
    // carry-forward copy — only a previously-carried row of the same
    // fee_type does (idempotency on retries).
    await client.query(`
      INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, description)
      SELECT $1, fee_type, amount, is_refundable, due_timing,
             COALESCE(description, '') || ' [carried forward from previous lease]'
      FROM lease_fees
      WHERE lease_id=$2 AND due_timing='move_in' AND is_refundable=TRUE
        AND fee_type NOT IN (
          SELECT fee_type FROM lease_fees
           WHERE lease_id=$1
             AND COALESCE(description, '') NOT LIKE '%[deposit top-up%')`,
      [lease.id, doc.renews_lease_id])
    // S534: REBIND the custody record to the successor lease. The
    // security_deposits row carries the money, the funded/partial
    // status, and the statutory interest accrual chain — deposit-return
    // and the monthly interest cron both look it up BY lease_id, so
    // leaving it on the expiring predecessor would (a) lose the
    // accrued interest + collected amount at the renewed lease's
    // move-out and (b) orphan the accrual clock. Rebinding the SAME row
    // keeps the interest clock continuous from original receipt — the
    // real-world standard (a renewal is a continuing tenancy; the
    // deposit is never returned/re-collected, so accrual never resets).
    // FlexDeposit custody rows are excluded — their lease linkage is
    // managed by the FlexDeposit forwarding flow.
    await client.query(`
      UPDATE security_deposits
         SET lease_id = $1, updated_at = NOW()
       WHERE lease_id = $2
         AND flex_deposit_enabled = FALSE
         AND status IN ('pending', 'partial', 'funded', 'claimed')`,
      [lease.id, doc.renews_lease_id])
    await client.query(
      `UPDATE lease_renewal_requests SET status='completed', resolved_at=NOW(), updated_at=NOW()
       WHERE lease_id=$1 AND status IN ('requested','approved')`, [doc.renews_lease_id])
    // The old lease should run out its clock, not auto-extend into the
    // successor's term.
    await client.query(
      `UPDATE leases SET auto_renew=FALSE, auto_renew_mode=NULL, updated_at=NOW()
       WHERE id=$1 AND status='active'`, [doc.renews_lease_id])
  }

  // Credit ledger: emit lease_signed for every tenant signer + a
  // single event for the landlord. Same transaction — if the ledger
  // writes fail, the whole lease materialization rolls back. Imported
  // lazily to keep esign.ts top-level imports tidy.
  const { emitLeaseSignedTenant, emitLeaseSignedLandlord } =
    await import('../services/creditLedgerEmitters')
  const signedAt = new Date()
  for (const t of tenantSigners) {
    await emitLeaseSignedTenant(client, {
      tenantId:    t.tenant_id,
      leaseId:     lease.id,
      documentId:  doc.id,
      signedAt,
    })
  }
  await emitLeaseSignedLandlord(client, {
    landlordId:   doc.landlord_id,
    leaseId:      lease.id,
    documentId:   doc.id,
    signedAt,
    tenantCount:  tenantSigners.length,
  })

  return { leaseId: lease.id, status: leaseStatus, primaryTenantId: primarySigner.tenant_id }
}

/**
 * Execute an addendum_add: flip the pre-created pending_add lease_tenants row
 * to active. Parent lease untouched. Caller owns transaction.
 *
 * Preconditions (validated at creation time but re-verified here):
 *  - doc.lease_id non-null
 *  - exactly one lease_tenants row exists with add_document_id=doc.id, status=pending_add
 *  - parent lease status='active'
 *  - every signer has a tenant profile, no platform blocks
 *  - new tenant has no bucket-overlapping active/pending lease elsewhere
 */
async function executeAddendumAdd(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')
  if (!doc.unit_id) throw new AppError(400, 'Addendum has no unit_id')

  // Parent lease must still be active
  const lease = await client.query(
    `SELECT id, status, start_date, end_date, unit_id FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')
  if (lease.status !== 'active') {
    throw new AppError(409, `Cannot add tenant: parent lease is ${lease.status}, not active`)
  }
  if (lease.unit_id !== doc.unit_id) {
    throw new AppError(500, 'Addendum unit_id does not match parent lease unit_id')
  }

  // Find the pending_add row keyed to this document
  const pendingRows = await client.query(
    `SELECT id, tenant_id FROM lease_tenants
     WHERE add_document_id=$1 AND status='pending_add'`,
    [doc.id]).then((r: any) => r.rows)
  if (pendingRows.length === 0) {
    throw new AppError(500, 'No pending_add row found for this addendum — creation logic failed')
  }
  if (pendingRows.length > 1) {
    throw new AppError(500, 'Multiple pending_add rows for this addendum — data corruption')
  }
  const pendingRow = pendingRows[0]

  // Gather all signers (new tenant + existing active tenants + landlord)
  const allSigners = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1
     ORDER BY s.order_index`, [doc.id]).then((r: any) => r.rows)

  const tenantSigners = allSigners.filter((r: any) => isTenantRole(r.role))
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
  }

  // Platform-block check every tenant signer (incl. new tenant) — safety belt
  for (const t of tenantSigners) {
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  // Sanity: the pending_add row's tenant_id must match one of the signers
  const newTenantMatch = tenantSigners.find((t: any) => t.tenant_id === pendingRow.tenant_id)
  if (!newTenantMatch) {
    throw new AppError(500, 'pending_add row tenant_id does not match any signer')
  }

  // Overlap re-check for the new tenant only (belt & suspenders vs creation-time check).
  // Excludes the current lease so it does not self-conflict via the pending_add row.
  const ov = await canTenantsSignNewLease(
    [pendingRow.tenant_id], doc.unit_id,
    lease.start_date, lease.end_date || null,
    lease.id
  )
  if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')

  // Flip pending_add → active
  await client.query(
    `UPDATE lease_tenants
     SET status='active', added_at=NOW()
     WHERE id=$1`,
    [pendingRow.id])

  // Current primary on the (now-expanded) lease
  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary after addendum_add')

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

/**
 * Execute an addendum_remove: flip the target lease_tenants row to removed,
 * optionally promote a new primary. Parent lease untouched. Caller owns transaction.
 *
 * Preconditions (validated at creation but re-verified here):
 *  - doc.lease_id non-null
 *  - doc.target_lease_tenant_id non-null (enforced by lease_documents CHECK constraint)
 *  - target row exists, status=pending_remove, belongs to doc.lease_id
 *  - parent lease status='active'
 *  - if target is current primary: doc.promote_lease_tenant_id non-null and valid
 *  - every signer has a tenant profile, no platform blocks
 */
async function executeAddendumRemove(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')
  if (!doc.target_lease_tenant_id) throw new AppError(400, 'addendum_remove has no target_lease_tenant_id')

  const lease = await client.query(
    `SELECT id, status FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')
  if (lease.status !== 'active') {
    throw new AppError(409, `Cannot remove tenant: parent lease is ${lease.status}, not active`)
  }

  const target = await client.query(
    `SELECT id, lease_id, tenant_id, role, status, remove_document_id
     FROM lease_tenants WHERE id=$1`,
    [doc.target_lease_tenant_id]).then((r: any) => r.rows[0])
  if (!target) throw new AppError(404, 'Target lease_tenants row not found')
  if (target.lease_id !== doc.lease_id) {
    throw new AppError(500, 'Target row does not belong to this lease')
  }
  if (target.status !== 'pending_remove') {
    throw new AppError(409, `Target tenant is ${target.status}, not pending_remove — addendum out of sync`)
  }
  if (target.remove_document_id !== doc.id) {
    throw new AppError(500, 'Target row remove_document_id does not match this addendum')
  }

  const allSigners = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1`, [doc.id]).then((r: any) => r.rows)
  const tenantSigners = allSigners.filter((r: any) => isTenantRole(r.role))
  for (const t of tenantSigners) {
    if (!t.tenant_id) throw new AppError(400, `Signer ${t.email} has no tenant profile`)
    const blk = await checkPlatformBlock(t.user_id)
    if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
  }

  if (target.role === 'primary') {
    if (!doc.promote_lease_tenant_id) {
      throw new AppError(400, 'Cannot remove primary tenant without promote_lease_tenant_id')
    }
    const promote = await client.query(
      `SELECT id, lease_id, role, status FROM lease_tenants WHERE id=$1`,
      [doc.promote_lease_tenant_id]).then((r: any) => r.rows[0])
    if (!promote) throw new AppError(404, 'Promote target row not found')
    if (promote.lease_id !== doc.lease_id) {
      throw new AppError(400, 'Promote target does not belong to this lease')
    }
    if (promote.status !== 'active') {
      throw new AppError(400, `Promote target status is ${promote.status}, must be active`)
    }
    if (promote.role !== 'co_tenant') {
      throw new AppError(400, `Promote target role is ${promote.role}, must be co_tenant`)
    }

    // Flip target to removed FIRST — clears the lease_tenants_primary_active
    // partial unique index, THEN promote co_tenant to primary.
    await client.query(
      `UPDATE lease_tenants
       SET status='removed', removed_at=NOW(), removed_reason='moved_out'
       WHERE id=$1`,
      [target.id])
    await client.query(
      `UPDATE lease_tenants SET role='primary' WHERE id=$1`,
      [promote.id])
  } else {
    if (doc.promote_lease_tenant_id) {
      throw new AppError(400, 'promote_lease_tenant_id set but target is not primary')
    }
    await client.query(
      `UPDATE lease_tenants
       SET status='removed', removed_at=NOW(), removed_reason='moved_out'
       WHERE id=$1`,
      [target.id])
  }

  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary after addendum_remove')

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

/**
 * Execute an addendum_terms document: no roster mutation, no lease mutation.
 * The signed PDF itself is the legal instrument — execution just confirms the
 * document completion and returns the parent lease's current state.
 * Caller owns transaction.
 */
async function executeAddendumTerms(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.lease_id) throw new AppError(400, 'Addendum has no parent lease_id')

  const lease = await client.query(
    `SELECT id, status FROM leases WHERE id=$1`,
    [doc.lease_id]).then((r: any) => r.rows[0])
  if (!lease) throw new AppError(404, 'Parent lease not found')

  // Terms addendum is valid on any lease status that accepts amendments.
  // Block terminal states in case lease transitioned between creation and signing.
  // S71: 'voided' branch dropped — leases_status_check only allows
  // pending/active/expired/terminated, so 'voided' was unreachable.
  if (lease.status === 'expired' || lease.status === 'terminated') {
    throw new AppError(409, `Cannot amend terms: lease is ${lease.status}`)
  }

  const primary = await client.query(
    `SELECT tenant_id FROM lease_tenants
     WHERE lease_id=$1 AND role='primary' AND status='active'
     LIMIT 1`,
    [lease.id]).then((r: any) => r.rows[0])
  if (!primary) throw new AppError(500, 'Lease has no active primary for addendum_terms completion')

  // S581 (Nic): a terms addendum can carry a MONEY change (an optional recurring
  // charge like parking, or a base-rent change like an AZ mobile-home space-rent
  // increase). Those were drafted as pending scheduled_lease_changes at creation;
  // now that both parties have signed, promote them to 'scheduled' so the nightly
  // job applies them to billing on the landlord-set effective date. No-op for a
  // non-money addendum.
  const { activateScheduledChangesForDocument, createLeaseNoticesForDocument } =
    await import('../services/scheduledLeaseChanges')
  await activateScheduledChangesForDocument(client, doc.id)

  // S581: a NOTICE addendum (landlord-issued, no tenant signature) gives each
  // active tenant a blocking portal notice to view + acknowledge — proof they were
  // noticed of a change they didn't have to agree to.
  if (doc.delivery_mode === 'notice') {
    await createLeaseNoticesForDocument(client, doc.id, lease.id)
  }

  return { leaseId: lease.id, status: lease.status, primaryTenantId: primary.tenant_id }
}

// ─────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────

// S235: witness signer provisioning. Witnesses are external parties
// (property staff, notaries, neighbors) who attest to a signing without
// being tenants, landlords, or platform staff. They need a `users` row
// to satisfy the lease_document_signers.user_id FK + the esign /documents
// userId-required validation, but NOT a `tenants` row (the existing
// /tenants/invite path was wrong for them — required unitId and bound
// the user as a tenant, with all the tenant-side implications). This
// endpoint creates the minimal user account, idempotent on email, with
// role='tenant' (the generic CHECK-allowed role) but no tenants row.
// The signing role on `lease_document_signers.role='witness'` is what
// drives field assignments — users.role is irrelevant for that path.
esignRouter.post('/witnesses/provision', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { email, firstName, lastName } = req.body
    if (!email || !firstName) {
      throw new AppError(400, 'email and firstName required')
    }
    const emailNorm = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      throw new AppError(400, 'Invalid email format')
    }

    // Reuse if a user already exists with this email (any role).
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1`,
      [emailNorm])
    if (existing) {
      return res.json({ success: true, data: { userId: existing.id, reused: true } })
    }

    const tempHash = '$2b$10$placeholder_invite_pending'
    const created = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'tenant', $3, $4)
       RETURNING id`,
      [emailNorm, tempHash, String(firstName).trim(), String(lastName || '').trim()])
    res.status(201).json({ success: true, data: { userId: created!.id, reused: false } })
  } catch (e) { next(e) }
})

// W-33 (S529): resolve SIGNERS from the lease, not from hand-typed emails.
// ?unitId=X → that unit's active lease + all its active tenants;
// ?propertyId=Y → one group per active lease at the property (the
// property-wide addendum send fans out one document per group).
esignRouter.get('/recipients', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { unitId, propertyId } = req.query as { unitId?: string; propertyId?: string }
    if (!unitId && !propertyId) throw new AppError(400, 'unitId or propertyId required')
    const landlordId = req.user!.role === 'landlord' ? req.user!.profileId : req.user!.landlordId
    if (!landlordId) throw new AppError(403, 'Forbidden')
    const params: any[] = [landlordId]
    const filter = unitId
      ? `AND l.unit_id = $${params.push(unitId)}`
      : `AND u.property_id = $${params.push(propertyId)}`
    const rows = await query<any>(`
      SELECT l.id AS lease_id, l.unit_id, u.unit_number, p.id AS property_id, p.name AS property_name,
             vlat.role, t.id AS tenant_id, t.user_id, us.first_name, us.last_name, us.email
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
        JOIN v_lease_active_tenants vlat ON vlat.lease_id = l.id
        JOIN tenants t ON t.id = vlat.tenant_id
        JOIN users us ON us.id = t.user_id
       WHERE l.landlord_id = $1 AND l.status = 'active' ${filter}
       ORDER BY u.unit_number, vlat.role`, params)
    // group by lease
    const groups = new Map<string, any>()
    for (const r of rows) {
      if (!groups.has(r.lease_id)) {
        groups.set(r.lease_id, { leaseId: r.lease_id, unitId: r.unit_id, unitNumber: r.unit_number,
          propertyId: r.property_id, propertyName: r.property_name, tenants: [] })
      }
      groups.get(r.lease_id).tenants.push({
        tenantId: r.tenant_id, userId: r.user_id, firstName: r.first_name,
        lastName: r.last_name, email: r.email, role: r.role,
      })
    }
    res.json({ success: true, data: Array.from(groups.values()) })
  } catch (e) { next(e) }
})

esignRouter.get('/templates', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    // S535: ?unitType=<type> narrows to templates COMPATIBLE with that
    // unit type (its own type + universal NULL templates).
    const unitTypeFilter = typeof req.query.unitType === 'string' && (UNIT_TYPES as readonly string[]).includes(req.query.unitType)
      ? req.query.unitType : null
    // S535: ?propertyId narrows to templates usable AT that property
    // (locked to it + unlocked NULL templates).
    const propertyFilter = typeof req.query.propertyId === 'string' && req.query.propertyId ? req.query.propertyId : null
    // S576 (B-8): ?purpose=lease|work_trade_addendum narrows by template kind so
    // the renewal picker shows only lease forms, and the addendum resolver finds
    // only work-trade forms. Omitted = all (the Templates management tab).
    const purposeFilter = typeof req.query.purpose === 'string' && (LEASE_TEMPLATE_PURPOSES as readonly string[]).includes(req.query.purpose)
      ? req.query.purpose : null
    const templates = await query<any>(`
      SELECT t.*, COUNT(f.id)::int as field_count, p.name AS property_name
      FROM lease_templates t
      LEFT JOIN lease_template_fields f ON f.template_id = t.id
      LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.landlord_id = $1 AND t.is_active = TRUE
        AND ($2::text IS NULL OR t.unit_type IS NULL OR t.unit_type = $2)
        AND ($3::uuid IS NULL OR t.property_id IS NULL OR t.property_id = $3)
        AND ($4::text IS NULL OR t.purpose = $4)
      GROUP BY t.id, p.name ORDER BY t.created_at DESC`, [req.user!.profileId, unitTypeFilter, propertyFilter, purposeFilter])
    // S622: the prose-stated conditional fees the landlord confirmed, so the
    // editor can show what is already tracked and not re-ask on every open.
    if (templates.length > 0) {
      const cfRows = await query<any>(
        `SELECT template_id, id, label, amount::text AS amount, condition_text
           FROM lease_template_conditional_fees WHERE template_id = ANY($1::uuid[])`,
        [templates.map((t: any) => t.id)])
      const byTemplate: Record<string, any[]> = {}
      for (const r of cfRows) {
        (byTemplate[r.template_id] ||= []).push({
          id: r.id, label: r.label, amount: Number(r.amount), conditionText: r.condition_text,
        })
      }
      for (const t of templates as any[]) t.conditional_fees = byTemplate[t.id] || []
    }
    res.json({ success: true, data: templates })
  } catch (e) { next(e) }
})

esignRouter.post('/templates', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount, unitType, propertyId, depositMonths, defaultTermMonths, purpose } = req.body
    if (!name) throw new AppError(400, 'Template name required')
    // S576 (B-8): 'lease' (default) or 'work_trade_addendum' — the landlord's
    // own work-trade addendum form, auto-attached to a renewal on lease expiry.
    const tmplPurpose = purpose || 'lease'
    if (!(LEASE_TEMPLATE_PURPOSES as readonly string[]).includes(tmplPurpose)) {
      throw new AppError(400, `purpose must be one of ${LEASE_TEMPLATE_PURPOSES.join(', ')}`)
    }
    // S558: the deposit multiplier ("N months' rent") is a lease term on the
    // template. Optional (NULL = landlord fills the deposit manually); 0..12.
    const depMonths = depositMonths === undefined || depositMonths === null || depositMonths === ''
      ? null : Number(depositMonths)
    if (depMonths != null && (!Number.isFinite(depMonths) || depMonths < 0 || depMonths > 12)) {
      throw new AppError(400, 'depositMonths must be a number between 0 and 12, or null')
    }
    // S558: default lease term carried on the template. NULL = month-to-month;
    // 1..120 = fixed N-month term. (Designate a template as its unit type's
    // default separately via POST /templates/:id/set-default.)
    const termMonths = defaultTermMonths === undefined || defaultTermMonths === null || defaultTermMonths === ''
      ? null : Number(defaultTermMonths)
    if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120)) {
      throw new AppError(400, 'defaultTermMonths must be an integer 1..120, or null for month-to-month')
    }
    // S535: templates are per unit TYPE (null = universal) — an RV spot
    // lease isn't an apartment lease. Drafting validates the pairing.
    if (unitType != null && !(UNIT_TYPES as readonly string[]).includes(unitType)) {
      throw new AppError(400, `unitType must be one of ${UNIT_TYPES.join(', ')} or null`)
    }
    // S535: optional PROPERTY lock (null = any property) — the form
    // carries a property's name/address, so it belongs to that property.
    if (propertyId) {
      const prop = await queryOne<any>(
        'SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [propertyId, req.user!.profileId])
      if (!prop) throw new AppError(404, 'Property not found')
    }
    const t = await queryOne<any>(`
      INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count, unit_type, property_id, deposit_months, default_term_months, purpose)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user!.profileId, name, description||null, basePdfUrl||null, pageCount||1, unitType||null, propertyId||null, depMonths, termMonths, tmplPurpose])

    // S629 (Nic): "when you add a template for a unit type and there is no
    // default, it should automatically become the default."
    //
    // He invited a household, they accepted, and the lease did not draft —
    // because a template existed for the unit type but nothing was marked
    // default. A lone template that is not the default is never what anyone
    // means: there is nothing for it to be second to. The FIRST one for a
    // (unit type, property) becomes the default on its own; a later one does
    // not steal the slot, which is the "ask if you want to supersede it" half
    // and belongs to the person, not to us.
    let autoDefaulted = false
    if (unitType) {
      const existingDefault = await queryOne<{ id: string }>(
        `SELECT id FROM lease_templates
          WHERE landlord_id=$1 AND unit_type=$2 AND property_id IS NOT DISTINCT FROM $3
            AND is_unit_type_default = TRUE AND is_active <> FALSE AND id <> $4
          LIMIT 1`,
        [req.user!.profileId, unitType, propertyId || null, t.id])
      if (!existingDefault) {
        await query(`UPDATE lease_templates SET is_unit_type_default=TRUE, updated_at=NOW() WHERE id=$1`, [t.id])
        t.is_unit_type_default = true
        autoDefaulted = true
        // And draft anything that was waiting on exactly this.
        await draftPendingForUnitType({
          landlordId: req.user!.profileId, unitType, propertyId: propertyId || null,
        }).catch(() => null)
      }
    }
    res.status(201).json({ success: true, data: { ...t, autoDefaulted } })
  } catch (e) { next(e) }
})

esignRouter.get('/templates/:id', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    const fields = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order, y', [template.id])
    res.json({ success: true, data: { ...template, fields } })
  } catch (e) { next(e) }
})

esignRouter.patch('/templates/:id', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount, isActive, unitType, depositMonths, defaultTermMonths } = req.body
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!t) throw new AppError(404, 'Template not found')
    if (unitType !== undefined && unitType !== null && !(UNIT_TYPES as readonly string[]).includes(unitType)) {
      throw new AppError(400, `unitType must be one of ${UNIT_TYPES.join(', ')} or null`)
    }
    // S558: deposit_months editable here. undefined = leave as-is; null/'' clears
    // it (landlord fills deposit manually); a number 0..12 sets the multiplier.
    let depMonths = t.deposit_months
    if (depositMonths !== undefined) {
      depMonths = depositMonths === null || depositMonths === '' ? null : Number(depositMonths)
      if (depMonths != null && (!Number.isFinite(depMonths) || depMonths < 0 || depMonths > 12)) {
        throw new AppError(400, 'depositMonths must be a number between 0 and 12, or null')
      }
    }
    // S558: default_term_months editable here. undefined = leave as-is; null/''
    // = month-to-month; 1..120 = fixed term.
    let termMonths = t.default_term_months
    if (defaultTermMonths !== undefined) {
      termMonths = defaultTermMonths === null || defaultTermMonths === '' ? null : Number(defaultTermMonths)
      if (termMonths != null && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120)) {
        throw new AppError(400, 'defaultTermMonths must be an integer 1..120, or null for month-to-month')
      }
    }
    const updated = await queryOne<any>(`
      UPDATE lease_templates SET name=$1, description=$2, base_pdf_url=$3, page_count=$4, is_active=$5,
             unit_type=$6, deposit_months=$7, default_term_months=$8, updated_at=NOW()
      WHERE id=$9 RETURNING *`,
      [name??t.name, description??t.description, basePdfUrl??t.base_pdf_url, pageCount??t.page_count, isActive??t.is_active,
       unitType===undefined ? t.unit_type : unitType, depMonths, termMonths, t.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// S558: designate this template as the DEFAULT for its unit type (the "primary
// <unit type> lease"). Radio behaviour: clears any other default for the same
// (landlord, unit_type, property_id) first, then sets this one — atomic. Pass
// { isDefault: false } to un-designate. A default requires a specific unit_type
// (a universal/null-unit_type template can't be a unit-type default).
esignRouter.post('/templates/:id/set-default', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  const client = await getClient()
  try {
    const makeDefault = req.body?.isDefault !== false // default true
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!t) throw new AppError(404, 'Template not found')
    if (makeDefault && !t.unit_type) {
      throw new AppError(400, 'Set the template’s unit type before making it a default — a default is per unit type.')
    }
    await client.query('BEGIN')
    if (makeDefault) {
      // Clear the current default for this (landlord, unit_type, property_id).
      // property_id compared with IS NOT DISTINCT FROM so NULL matches NULL.
      await client.query(
        `UPDATE lease_templates SET is_unit_type_default=false, updated_at=NOW()
          WHERE landlord_id=$1 AND unit_type=$2 AND property_id IS NOT DISTINCT FROM $3
            AND is_unit_type_default=true AND id<>$4`,
        [req.user!.profileId, t.unit_type, t.property_id, t.id])
    }
    const updated = await client.query(
      `UPDATE lease_templates SET is_unit_type_default=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [makeDefault, t.id])
    await client.query('COMMIT')

    // S605 (Nic): "if somebody does forget to add the template first... when
    // they add it, it refires." Every unit of this type with tenants invited but
    // no lease drafted gets drafted now. Outside the transaction and fully
    // best-effort — setting a default template must succeed even if drafting
    // hits a snag, and the retry is repeatable.
    let retried: { drafted: number; skipped: number } | null = null
    if (makeDefault && t.unit_type) {
      retried = await draftPendingForUnitType({
        landlordId: req.user!.profileId,
        unitType: t.unit_type,
        propertyId: t.property_id ?? null,
      }).catch(() => null)
    }
    res.json({ success: true, data: updated.rows[0], pendingDrafts: retried })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.delete('/templates/:id', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    await query('UPDATE lease_templates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

esignRouter.put('/templates/:id/fields', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { fields } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')

    for (const f of (fields || [])) {
      if (f.leaseColumn && !(f.leaseColumn in LEASE_COLUMN_CATEGORY)) {
        throw new AppError(400, `Invalid lease_column: ${f.leaseColumn}`)
      }
      // S568: accept lease roles (landlord/witness/tenant) AND generic roles
      // (seller/purchaser/party_N/custom) so one template engine serves both
      // leases and standalone contracts. isValidSignerRole allows sane labels.
      if (f.signerRole && !(f.signerRole === 'landlord' || isTenantRole(f.signerRole) || isValidSignerRole(f.signerRole))) {
        throw new AppError(400, `Invalid signer_role: ${f.signerRole}`)
      }
    }

    await query('DELETE FROM lease_template_fields WHERE template_id=$1', [template.id])
    // Two-pass so conditional (nested) fields can link to their parent: a full
    // replace regenerates DB ids, so children reference the parent by its
    // stable CLIENT key (clientId), which we map to the new DB id after insert.
    const clientToDbId = new Map<string, string>()
    const inserted: Array<{ f: any; dbId: string }> = []
    for (const f of (fields || [])) {
      const row = await queryOne<{ id: string }>(`INSERT INTO lease_template_fields
        (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order, font_css, options)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [template.id, f.fieldType, f.signerRole, f.label||null, f.leaseColumn||null,
         f.page||1, f.x, f.y, f.width||200, f.height||50, f.required??true, f.sortOrder||0, f.fontCss||null,
         f.options||null])
      if (f.clientId != null) clientToDbId.set(String(f.clientId), row!.id)
      inserted.push({ f, dbId: row!.id })
    }
    // Second pass: resolve parent links now that every field has a DB id.
    for (const { f, dbId } of inserted) {
      const parentKey = f.parentClientId != null ? String(f.parentClientId) : null
      if (parentKey && clientToDbId.has(parentKey)) {
        await query('UPDATE lease_template_fields SET parent_field_id=$1, parent_option=$2 WHERE id=$3',
          [clientToDbId.get(parentKey), f.parentOption || null, dbId])
      }
    }
    // S622: conditional fees the landlord kept from the prose scan. Full
    // replace, same as the fields above — the editor sends the surviving set, so
    // removing one in the UI removes it here. Omitting the key entirely leaves
    // the stored set alone (a caller that predates this field must not wipe it).
    // S622: the late-fee terms the template states in prose, saved with the
    // fields so drafting can rely on them.
    if (req.body.lateFeeTerms !== undefined) {
      await query('UPDATE lease_templates SET late_fee_terms=$2 WHERE id=$1',
        [template.id, req.body.lateFeeTerms ? JSON.stringify(req.body.lateFeeTerms) : null])
    }
    if (Array.isArray(req.body.conditionalFees)) {
      await query('DELETE FROM lease_template_conditional_fees WHERE template_id=$1', [template.id])
      for (const cf of req.body.conditionalFees) {
        const amount = Number(cf?.amount)
        const conditionText = String(cf?.conditionText ?? '').trim()
        if (!Number.isFinite(amount) || amount <= 0 || !conditionText) continue
        await query(
          `INSERT INTO lease_template_conditional_fees (template_id, label, amount, condition_text)
           VALUES ($1, $2, $3, $4)`,
          [template.id, String(cf?.label ?? 'Lease condition fee').slice(0, 120),
           amount, conditionText.slice(0, 1000)])
      }
    }

    const updated = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order', [template.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// S556: auto-place e-sign field boxes on the template's raw lease PDF. Reads
// the PDF, runs the deterministic detection + in-house model-tagging pass, and
// RETURNS proposed fields (does NOT save). The landlord loads them into the
// editor, adjusts, then the existing PUT /fields persists. Spec:
// ~/gam/AUTO_FIELD_PLACEMENT_SPEC.md.
// S582: ASYNC. Validate + enqueue a job, fire the model run WITHOUT awaiting, and
// return the jobId immediately. The editor polls the GET below until it leaves
// 'processing'. Decoupling the model work from the HTTP request means no request
// is ever held open long enough for Cloudflare's ~100s edge timeout to bite, and
// the model can take its natural time (better labels, never truncated).
esignRouter.post('/templates/:id/auto-fields', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    if (!template.base_pdf_url) throw new AppError(400, 'Template has no base PDF — upload one first')
    const filename = extractUploadFilename(template.base_pdf_url)
    if (!filename) throw new AppError(400, 'Template PDF path is not a local upload')
    if (!fs.existsSync(path.join(uploadDir, filename))) throw new AppError(404, 'Template PDF file not found on disk')

    const { createAutoFieldJob, runAutoFieldJob } = await import('../services/autoFieldJobs')
    const jobId = await createAutoFieldJob(template.id, req.user!.profileId)
    // Detached — runAutoFieldJob catches its own errors onto the job row.
    void runAutoFieldJob(jobId)
    res.status(202).json({ success: true, data: { jobId, status: 'processing' } })
  } catch (e) { next(e) }
})

// S582: poll the placement job. Returns { status, result?, error? }; the editor
// loads result.fields once status === 'done'.
esignRouter.get('/templates/:id/auto-fields/:jobId', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const { getAutoFieldJob } = await import('../services/autoFieldJobs')
    const job = await getAutoFieldJob(req.params.jobId, req.user!.profileId)
    if (!job || job.template_id !== req.params.id) throw new AppError(404, 'Job not found')
    // S622: pagesTotal/pagesDone let the editor show real progress instead of an
    // unlabelled spinner. pagesTotal is null until the PDF has been parsed.
    res.json({ success: true, data: {
      status: job.status, result: job.result, error: job.error,
      pagesTotal: job.pages_total ?? null, pagesDone: job.pages_done ?? 0,
    } })
  } catch (e) { next(e) }
})

// S556: suggested lease field values derived from a unit, so the send form can
// pre-fill rent / derived deposit / unit# / property before the landlord even
// types. Same computation the server seeds with at document creation.
esignRouter.get('/units/:unitId/prefill-suggestions', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const unit = await queryOne<{ id: string }>(
      'SELECT id FROM units WHERE id=$1 AND landlord_id=$2', [req.params.unitId, req.user!.profileId])
    if (!unit) throw new AppError(404, 'Unit not found')
    // S558: deposit derives from the selected template's deposit_months, so the
    // send form passes ?templateId when a template is chosen (deposit box fills
    // once both unit + template are picked; without a template it stays blank).
    const templateId = typeof req.query.templateId === 'string' ? req.query.templateId : null
    const suggestions = await suggestUnitPrefill(req.params.unitId, null, templateId)
    res.json({ success: true, data: suggestions })
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id/fields/:fieldId', requireAuth, requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    // S393 fix: verify template ownership before deleting a field.
    // Pre-fix, a caller knowing both a stranger template UUID and a
    // field UUID matching that template could DELETE the stranger's
    // field — the SQL only required (fieldId, templateId) match.
    // Same class as the S390 variants cross-tenant fix on
    // pos_item_variants.
    const template = await queryOne<{ id: string }>(
      'SELECT id FROM lease_templates WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    await query('DELETE FROM lease_template_fields WHERE id=$1 AND template_id=$2', [req.params.fieldId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────

esignRouter.get('/documents', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const docs = await query<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        COUNT(DISTINCT s.id)::int as signer_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status='signed')::int as signed_count
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_document_signers s ON s.document_id = d.id
      WHERE d.landlord_id = $1
      GROUP BY d.id, u.unit_number, p.name
      ORDER BY d.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: docs })
  } catch (e) { next(e) }
})

/**
 * Create a document from a template.
 * Signer validation:
 *   - Every signer must have a userId (GAM account required)
 *   - Exactly one role='primary'
 *   - At least one role='landlord'
 *   - co_tenant_N roles: zero or more, must match pattern co_tenant_1..N
 *   - Optional role='witness'
 * Template fields assigned to signer roles that aren't filled get pruned
 * (so a template with co_tenant_1..4 slots used on a 2-tenant document only
 *  copies fields for primary + co_tenant_1).
 */
esignRouter.get('/batches', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const batches = await query<any>(`
      SELECT
        b.id, b.title, b.template_id, b.scope_type, b.scope_ref,
        b.status, b.created_at, b.voided_at,
        COUNT(d.id)::int AS document_count,
        COUNT(d.id) FILTER (WHERE d.status = 'completed')::int AS completed_count,
        COUNT(d.id) FILTER (WHERE d.status IN ('pending','sent','in_progress'))::int AS pending_count,
        COUNT(d.id) FILTER (WHERE d.status = 'voided')::int AS voided_count
      FROM document_batches b
      LEFT JOIN lease_documents d ON d.batch_id = b.id
      WHERE b.landlord_id = $1
      GROUP BY b.id
      ORDER BY b.created_at DESC`,
      [req.user!.profileId])
    res.json({ success: true, data: batches })
  } catch (e) {
    next(e)
  }
})

/**
 * Resolve a unit_id from prefillValues at send time.
 * If prefillValues.unit_number is present, match against landlord's units.
 * - 0 matches → throws 400
 * - 1 match → returns that unitId
 * - >1 matches → requires prefillValues.property_address to disambiguate via
 *   case-insensitive partial match on composed street1+street2+city+state+zip.
 * Returns null when unit_number is not provided (caller falls back to the unitId
 * already on the request body from the tenant-lookup path).
 */
async function resolveUnitFromPrefill(
  landlordId: string,
  prefillValues: Record<string,string>
): Promise<string|null> {
  const unitNumber = (prefillValues?.unit_number || '').trim()
  if (!unitNumber) return null
  const matches = await query<any>(
    `SELECT u.id, u.unit_number, p.street1, p.street2, p.city, p.state, p.zip, p.name AS property_name
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = $1 AND u.unit_number = $2`,
    [landlordId, unitNumber]
  )
  if (matches.length === 0) {
    throw new AppError(400, `No unit matches unit number '${unitNumber}' for this landlord.`)
  }
  if (matches.length === 1) return matches[0].id
  // Ambiguous — require property_address disambiguator
  const addressHint = (prefillValues?.property_address || '').trim()
  if (!addressHint) {
    throw new AppError(400, `Ambiguous: ${matches.length} units match '${unitNumber}'. Specify the Property address in Document Values.`)
  }
  const hint = addressHint.toLowerCase()
  const filtered = matches.filter((m: any) => {
    const composed = [m.street1, m.street2, m.city, m.state, m.zip].filter(Boolean).join(' ').toLowerCase()
    return composed.includes(hint)
  })
  if (filtered.length === 0) {
    throw new AppError(400, `No unit '${unitNumber}' matches property address containing '${addressHint}'.`)
  }
  if (filtered.length > 1) {
    throw new AppError(400, `Still ambiguous: ${filtered.length} units match '${unitNumber}' at addresses containing '${addressHint}'. Be more specific.`)
  }
  return filtered[0].id
}

esignRouter.post('/documents', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { templateId, unitId, title, signers, basePdfUrl, prefillValues, depositAlreadyHeld } = req.body
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // Validate signer shape
    const primaryCount = signers.filter((s: any) => s.role === 'primary').length
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (primaryCount !== 1) throw new AppError(400, 'Exactly one primary tenant signer required')
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }

    // Resolve each tenant signer's tenant profile (validates they have one)
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
    }

    // Resolve PDF source — template default falls through if no explicit basePdfUrl
    let pdfUrl = basePdfUrl
    let tmplUnitType: string | null = null
    let tmplPropertyId: string | null = null
    let tmplPurpose = 'lease'
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [templateId, req.user!.profileId])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
      tmplUnitType = tmpl.unit_type || null
      tmplPropertyId = tmpl.property_id || null
      tmplPurpose = tmpl.purpose || 'lease'
    }

    // Unit resolver — if the template binds unit_number and the landlord filled
    // it in the Document Values form, match against this landlord's units. On
    // success, override any unitId that came from the tenant-lookup fallback.
    const resolvedUnitId = await resolveUnitFromPrefill(req.user!.profileId, prefillValues || {})
    const finalUnitId = resolvedUnitId || unitId || null

    // S535: templates are per unit type and may be property-locked —
    // refuse incompatible pairings (NULLs fit everything).
    if ((tmplUnitType || tmplPropertyId) && finalUnitId) {
      const u = await queryOne<{ unit_type: string | null; property_id: string }>(
        'SELECT unit_type, property_id FROM units WHERE id=$1', [finalUnitId])
      if (tmplUnitType && u?.unit_type && u.unit_type !== tmplUnitType) {
        throw new AppError(400,
          `This template is for ${tmplUnitType.replace('_', ' ')} units — the selected unit is ${u.unit_type.replace('_', ' ')}. Pick a matching or universal template.`)
      }
      if (tmplPropertyId && u && u.property_id !== tmplPropertyId) {
        throw new AppError(400,
          'This template is locked to a different property than the selected unit. Pick that property\'s template or an unlocked one.')
      }
    }

    // S576 (B-8): purpose-aware. A NON-lease template (a work-trade addendum
    // form) AMENDS the tenant's existing active lease — so the normal e-sign
    // send flow produces an addendum_terms document ON that lease, never a new
    // original_lease (Nic: "picking the addendum template should just work").
    // Falls back cleanly to a new lease for ordinary lease templates.
    let docType: LeaseDocumentType = 'original_lease'
    let docLeaseId: string | null = null
    let wtAgreementId: string | null = null
    if (tmplPurpose === 'work_trade_addendum') {
      const primarySigner = (signers as any[]).find(s => s.role === 'primary')
      if (!primarySigner?.userId) throw new AppError(400, 'An addendum needs the tenant on the existing lease as the primary signer.')
      if (!finalUnitId) throw new AppError(400, 'Could not resolve which unit this addendum is for.')
      const t = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE user_id=$1', [primarySigner.userId])
      if (!t) throw new AppError(400, 'Primary signer has no tenant profile.')
      const activeLease = await queryOne<{ id: string }>(`
        SELECT l.id FROM leases l JOIN lease_tenants lt ON lt.lease_id=l.id
         WHERE l.unit_id=$1 AND lt.tenant_id=$2 AND l.status='active' AND lt.status='active'
         ORDER BY l.start_date DESC LIMIT 1`, [finalUnitId, t.id])
      if (!activeLease) throw new AppError(409, 'No active lease for this tenant on this unit — an addendum amends an existing lease, so add or renew the lease first.')
      docType = 'addendum_terms'
      docLeaseId = activeLease.id
      // Link it to an active work-trade agreement if one exists (so the system
      // knows it's THE work-trade addendum) — same stamp the dedicated flow uses.
      const agr = await queryOne<{ id: string }>(
        `SELECT id FROM work_trade_agreements WHERE unit_id=$1 AND tenant_id=$2 AND status='active' LIMIT 1`,
        [finalUnitId, t.id])
      wtAgreementId = agr?.id || null
    }

    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: finalUnitId,
      leaseId: docLeaseId,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: docType,
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      // S604: migration onboarding — the landlord already holds this deposit,
      // so state it on the lease but never bill it. Only meaningful on an
      // original_lease; an addendum has no move-in invoice.
      depositAlreadyHeld: docType === 'original_lease' && depositAlreadyHeld === true,
      signers,
      prefillValues: prefillValues || {}
    } as any)
    if (wtAgreementId) {
      await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [wtAgreementId, doc.id])
    }

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────
// POST /api/esign/standalone-documents  — S568 (Nic): generic e-sign
// ─────────────────────────────────────────────────────────────
// Create a NON-lease document (purchase agreement, bill of sale, general
// contract) with ARBITRARY signers + roles — the generic e-sign engine. Binds
// to no lease/unit; reuses createDocumentRecord (its lease-only blocks are gated
// on unitId/original_lease, so they're skipped) and the existing generic
// /documents/:id/send + token signing flow. Enables financed-home purchase
// agreements (seller=landlord, purchaser=tenant) and resident-to-resident sales
// (landlord just facilitates). Signers must be existing GAM users for now
// (userId required — the same rule leases use before signing); external-party-
// by-email is the next increment.
esignRouter.post('/standalone-documents', requireAuth, requirePerm('esign.template_manage'), async (req: any, res, next) => {
  const client = await getClient()
  try {
    const body = z.object({
      title:        z.string().trim().min(1).max(160),
      documentType: z.enum(STANDALONE_DOCUMENT_TYPES as unknown as [string, ...string[]]),
      templateId:   z.string().uuid().nullable().optional(),
      basePdfUrl:   z.string().nullable().optional(),
      // A signer is identified by email + name + role. No userId needed — every
      // signer is resolved to (or minted as) a GAM account; raw emails never
      // receive a document (anti-spam / consent gate). userId may be supplied to
      // pin an existing account.
      signers: z.array(z.object({
        userId: z.string().uuid().optional(),
        role:   z.string().trim().min(1).max(40),
        name:   z.string().trim().min(1),
        email:  z.string().email(),
        phone:  z.string().max(40).nullable().optional(),
        orderIndex: z.number().int().positive().optional(),
      })).min(1).max(10),
    }).parse(req.body)

    const landlordId = req.user.role === 'landlord' ? req.user.profileId : req.user.landlordId
    if (!landlordId) throw new AppError(403, 'A landlord context is required to create a document.')

    for (const s of body.signers) {
      if (!isValidSignerRole(s.role)) throw new AppError(400, `Invalid signer role: ${s.role}`)
    }
    // Distinct roles — the engine matches template fields to signers by role.
    const roles = body.signers.map(s => s.role)
    if (new Set(roles).size !== roles.length) throw new AppError(400, 'Each signer must have a distinct role.')

    // If a template is supplied it must belong to this landlord.
    if (body.templateId) {
      const tmpl = await queryOne<any>('SELECT id FROM lease_templates WHERE id=$1 AND landlord_id=$2', [body.templateId, landlordId])
      if (!tmpl) throw new AppError(404, 'Template not found')
    }

    await client.query('BEGIN')
    // Resolve every signer to a GAM account — minting a free 'contact' (customer
    // pool) when the email is new. Track the newly-minted ones to invite them.
    const { resolveOrCreateSignerUser } = await import('../services/signerAccounts')
    const newContacts: Array<{ email: string; name: string; inviteToken: string }> = []
    const resolvedSigners = []
    for (let i = 0; i < body.signers.length; i++) {
      const s = body.signers[i]
      let userId = s.userId
      if (!userId) {
        const r = await resolveOrCreateSignerUser(client as any, { email: s.email, name: s.name, phone: s.phone ?? null })
        userId = r.userId
        if (r.created && r.inviteToken) newContacts.push({ email: r.email, name: r.name, inviteToken: r.inviteToken })
      }
      resolvedSigners.push({ userId: userId!, role: s.role, name: s.name, email: s.email, orderIndex: s.orderIndex ?? i + 1 })
    }

    const doc = await createDocumentRecord(client, {
      landlordId,
      templateId: body.templateId ?? null,
      unitId: null,
      leaseId: null,
      title: body.title,
      basePdfUrl: body.basePdfUrl ?? null,
      documentType: body.documentType as any,
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers: resolvedSigners,
    })
    await client.query('COMMIT')

    // The activation invite is NOT sent here — it fires when the landlord SENDS
    // the document (POST /documents/:id/send), which routes an unactivated signer
    // through /accept-invite (their tenant_invite_token) → set password → /sign.
    // So creating the doc just mints the pooled contact accounts; sending invites.
    res.json({ success: true, data: { ...doc, mintedContacts: newContacts.length } })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    next(e)
  } finally {
    client.release()
  }
})

// S534 (Nic): one-minute renewal support. One fetch gives the decision
// modal everything it needs: any OPEN renewal draft for the lease (so a
// second visit OPENS the draft instead of dead-ending on the duplicate-
// draft 409 — the "buried resolve" complaint), plus the template the
// current lease was executed from (preselected so renewing reuses the
// same template by default).
esignRouter.get('/documents/renewal-context/:leaseId', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const lease = await queryOne<any>(
      `SELECT id, landlord_id FROM leases WHERE id = $1`, [req.params.leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')

    const openDraft = await queryOne<any>(`
      SELECT d.id, d.status, d.title,
             (SELECT s.status FROM lease_document_signers s
               WHERE s.document_id = d.id AND s.role = 'landlord'
               ORDER BY s.order_index LIMIT 1) AS landlord_signer_status
        FROM lease_documents d
       WHERE d.renews_lease_id = $1 AND d.status NOT IN ('completed','voided')
       ORDER BY d.created_at DESC LIMIT 1`, [lease.id])
    const prior = await queryOne<any>(`
      SELECT d.template_id, t.name AS template_name
        FROM lease_documents d
        JOIN lease_templates t ON t.id = d.template_id
       WHERE d.lease_id = $1 AND d.status = 'completed' AND d.template_id IS NOT NULL
       ORDER BY d.completed_at DESC NULLS LAST, d.created_at DESC LIMIT 1`, [lease.id])

    res.json({ success: true, data: {
      openDraft: openDraft || null,
      priorTemplateId: prior?.template_id ?? null,
      priorTemplateName: prior?.template_name ?? null,
    }})
  } catch (e) { next(e) }
})

// W-7 (S531): renewal decision → drafted lease. Creates an original_lease
// document for the SAME unit + active roster with the renewal form's terms
// prefilled (per lease-is-law the new terms live in the drafted lease).
// Carry-over: identity fields, term settings, and the current lease's
// recurring / move-out lease_fees prefill from the predecessor; refundable
// move-in deposits are NOT prefilled (they'd re-bill at completion) — they
// copy forward at execution via renews_lease_id. The draft is left in
// 'draft' status: the landlord reviews + sends from the E-Sign page
// (landlord signs first per S28).
esignRouter.post('/documents/renewal', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    // GAM standard (Nic, S531): THE LEASE IS THE DOCUMENT. This endpoint
    // collects NO terms — no rent, no dates. It drafts the document with
    // identity + carry-over facts prefilled; the landlord types the new
    // rent/dates INTO the drafted lease during their landlord-first
    // signing pass (the sign flow's field inputs + required-field
    // validation are the only place terms are entered).
    const { leaseId, templateId } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required')
    if (!templateId) throw new AppError(400, 'templateId required — pick the lease template to draft from')

    const lease = await queryOne<any>(`
      SELECT l.*, u.unit_number, u.unit_type, u.property_id, p.name AS property_name,
             p.street1, p.city, p.state, p.zip
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE l.id=$1`, [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    if (lease.status !== 'active') throw new AppError(409, `Cannot renew: lease is ${lease.status}, not active`)

    // A second open renewal draft for the same lease is a mistake.
    const openDraft = await queryOne<any>(`
      SELECT id FROM lease_documents
      WHERE renews_lease_id=$1 AND status NOT IN ('completed','voided')`, [leaseId])
    if (openDraft) throw new AppError(409, 'A renewal draft already exists for this lease — void it first or send it')

    const tmpl = await queryOne<any>(
      'SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [templateId, lease.landlord_id])
    if (!tmpl) throw new AppError(404, 'Template not found')
    if (!tmpl.base_pdf_url) throw new AppError(400, 'Template has no base PDF')
    // S535: templates are per unit type — refuse an incompatible pairing
    // (universal NULL templates fit every unit).
    if (tmpl.unit_type && lease.unit_type && tmpl.unit_type !== lease.unit_type) {
      throw new AppError(400,
        `Template "${tmpl.name}" is for ${tmpl.unit_type.replace('_', ' ')} units — this unit is ${String(lease.unit_type).replace('_', ' ')}. Pick a matching or universal template.`)
    }
    // S535: property-locked templates only draft at THEIR property —
    // the form's own text names the property, so the wrong pairing is
    // always a mistake.
    if (tmpl.property_id && tmpl.property_id !== lease.property_id) {
      throw new AppError(400,
        `Template "${tmpl.name}" is locked to another property — this unit is at ${lease.property_name}. Pick that property's template or an unlocked one.`)
    }
    // The new terms are entered in the document, so the template must carry
    // the fields the completion chain requires.
    const requiredCols = await query<any>(
      `SELECT DISTINCT lease_column FROM lease_template_fields
       WHERE template_id=$1 AND lease_column IN ('rent_amount','start_date')`, [templateId])
    if ((requiredCols as any[]).length < 2) {
      throw new AppError(400, 'Template must include Rent Amount and Start Date fields — the new terms are set in the drafted lease itself')
    }

    // Signers = landlord + the current active roster, same roles.
    const landlordUser = await queryOne<any>(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [lease.landlord_id])
    if (!landlordUser) throw new AppError(500, 'Landlord user not found')
    const roster = await query<any>(`
      SELECT lt.role, u.id AS user_id, u.first_name, u.last_name, u.email, u.phone
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id=$1 AND lt.status='active'
      ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [leaseId])
    if ((roster as any[]).length === 0) throw new AppError(409, 'Lease has no active tenants to renew with')
    const signers = [
      { userId: landlordUser.id, role: 'landlord', name: `${landlordUser.first_name} ${landlordUser.last_name}`, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
      ...(roster as any[]).map((r: any, i: number) => ({
        userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`,
        email: r.email, phone: r.phone, orderIndex: i + 2,
      })),
    ]

    // Prefill: identity + carried-over settings ONLY. The new terms
    // (rent_amount / start_date / end_date / lease_type) stay blank —
    // the landlord fills them in the document.
    const primary = (roster as any[])[0]
    const prefillValues: Record<string, string> = {
      tenant_name:      `${primary.first_name} ${primary.last_name}`,
      tenant_email:     primary.email || '',
      landlord_name:    `${landlordUser.first_name} ${landlordUser.last_name}`,
      unit_number:      lease.unit_number,
      property_name:    lease.property_name || '',
      property_address: [lease.street1, lease.city, lease.state, lease.zip].filter(Boolean).join(', '),
      rent_due_day:     String(lease.rent_due_day ?? 1),
      auto_renew:       lease.auto_renew ? 'true' : 'false',
      notice_days_required:   String(lease.notice_days_required ?? 30),
      expiration_notice_days: String(lease.expiration_notice_days ?? 60),
    }
    if (lease.auto_renew && lease.auto_renew_mode) prefillValues.auto_renew_mode = lease.auto_renew_mode

    // S535 (Nic): CROSS-TEMPLATE renewal — the landlord may renew onto an
    // entirely different/updated template ("change in form"). Prefill
    // EVERY lease column derivable from the predecessor so a new form's
    // bound fields populate automatically; anything underivable (e.g.
    // custom_text, a fee the old lease never had) is typed by the
    // landlord during their signing pass — the tagged-field completeness
    // gate moved from /send to the landlord's sign submit.
    if (lease.lease_type) prefillValues.lease_type = lease.lease_type
    // S535: late fees deliberately NOT carried from the predecessor —
    // they stamp from the CURRENT (property, unit type) policy inside
    // createDocumentRecord ('N/A' when the class has no policy row).
    // Utility responsibilities → 'tenant' / 'landlord' (UTILITY_ROW_SPECS
    // treats 'tenant' as tenant_responsible=TRUE).
    const utilRows = await query<{ utility_type: string; tenant_responsible: boolean }>(
      `SELECT utility_type, tenant_responsible FROM lease_utility_responsibilities WHERE lease_id=$1`, [leaseId])
    const UTIL_TAG: Record<string, string> = {
      water: 'utility_water_responsibility', gas: 'utility_gas_responsibility',
      electric: 'utility_electric_responsibility', sewer: 'utility_sewer_responsibility',
      trash: 'utility_trash_responsibility',
    }
    for (const u of utilRows as any[]) {
      const tag = UTIL_TAG[u.utility_type]
      if (tag) prefillValues[tag] = u.tenant_responsible ? 'tenant' : 'landlord'
    }

    // S534 (Nic): the renewal defaults to the predecessor's terms — the
    // landlord quick-edits what changed in the doc and signs. Rent
    // defaults to the CURRENT rent (raise it in the doc if it changes);
    // this also satisfies the send route's all-tagged-fields-have-values
    // check so draft → auto-send → sign flows without a stop.
    prefillValues.rent_amount = Number(lease.rent_amount).toFixed(2)

    // Term mirrors the predecessor — new start = the day after the old
    // end, same duration (a 1-year lease renews as 1 year). Prefills are
    // defaults, not law: the landlord edits them in the doc like any
    // field. Month-to-month predecessors (no end date) get no date
    // defaults.
    if (lease.start_date && lease.end_date) {
      const oldStart = new Date(lease.start_date)
      const oldEnd   = new Date(lease.end_date)
      const newStart = new Date(oldEnd); newStart.setDate(newStart.getDate() + 1)
      const newEnd   = new Date(newStart.getTime() + (oldEnd.getTime() - oldStart.getTime()))
      prefillValues.start_date = newStart.toLocaleDateString('en-US')
      prefillValues.end_date   = newEnd.toLocaleDateString('en-US')
    } else if (!lease.end_date) {
      // S535 (Nic): month-to-month predecessor — '-' is the explicit
      // "no end date" entry (execution maps it to end_date NULL +
      // lease_type month_to_month).
      // S536 (Nic): the renewal takes effect at the end of NEXT month —
      // MTM changes need 30 days' notice, so one drafted today runs from
      // the first of the month after next (drafted Jul 10 → effective
      // Sep 1; signing deadline Aug 30 via the scheduler's 1-day-prior
      // rule). Default only — the landlord edits it in the doc.
      const mtmNow = new Date()
      const mtmEffect = new Date(mtmNow.getFullYear(), mtmNow.getMonth() + 2, 1)
      prefillValues.start_date = mtmEffect.toLocaleDateString('en-US')
      prefillValues.end_date = '-'
    }

    // S534/S535 (Nic): show the CARRIED deposits on the renewal document,
    // per fee_type (security_deposit, pet_deposit, key_deposit, …) so a
    // template binding any deposit field populates with its own carried
    // amount. Custody never moves on a renewal (the fee rows copy forward
    // at execution, tagged, AFTER the move-in invoice); the per-type
    // delta guard in buildLeaseFromDocument means these values can never
    // double-charge — only an INCREASE bills, and only the difference.
    const depositRows = await query<{ fee_type: string; total: string }>(`
      SELECT fee_type, SUM(amount)::text AS total FROM lease_fees
       WHERE lease_id=$1 AND due_timing='move_in' AND is_refundable=TRUE
       GROUP BY fee_type`, [leaseId])
    for (const d of depositRows as any[]) {
      const total = Number(d.total || 0)
      if (total > 0) prefillValues[d.fee_type] = total.toFixed(2).replace(/\.00$/, '')
    }
    if (!prefillValues.security_deposit) prefillValues.security_deposit = 'N/A'

    // Carry recurring + move-out/other lease_fees forward as prefills (they
    // bill on their own timing — nothing re-bills at completion). Move-in
    // fees are excluded: refundable deposits copy at execution instead, and
    // non-refundable move-in fees don't recur on a renewal.
    const feeRows = await query<any>(`
      SELECT fee_type, amount FROM lease_fees
      WHERE lease_id=$1 AND due_timing != 'move_in'`, [leaseId])
    for (const f of feeRows as any[]) {
      prefillValues[f.fee_type] = String(f.amount)
    }

    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id,
      templateId,
      unitId: lease.unit_id,
      leaseId: null,
      title: `Lease Renewal — Unit ${lease.unit_number}${lease.property_name ? ' — ' + lease.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url,
      documentType: 'original_lease',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      renewsLeaseId: leaseId,
      signers,
      prefillValues,
    } as any)
    // An open tenant-initiated renewal request is now being acted on.
    await client.query(
      `UPDATE lease_renewal_requests SET status='approved', resolved_at=NOW(), updated_at=NOW()
       WHERE lease_id=$1 AND status='requested'`, [leaseId])
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-add', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, templateId, title, signers, basePdfUrl } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_add')
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // 1. Lease exists, landlord owns it, status=active
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status, start_date, end_date FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    if (lease.status !== 'active') {
      throw new AppError(409, `Cannot add tenant: lease is ${lease.status}, not active`)
    }

    // 2. Current active roster (user_ids we expect to see in the signer list)
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, lt.role, t.user_id
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    if ((currentRoster as any[]).length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }
    const currentUserIds = new Set((currentRoster as any[]).map((r: any) => r.user_id))
    const currentTenantIds = new Set((currentRoster as any[]).map((r: any) => r.tenant_id))

    // 3. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }

    // 4. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')

    // 5. Every current active tenant must be a signer on this addendum
    const signerUserIds = new Set(tenantSigners.map(t => t.userId))
    for (const r of currentRoster as any[]) {
      if (!signerUserIds.has(r.user_id)) {
        throw new AppError(400, `Current tenant (user ${r.user_id}) must sign addendum — all roommates sign roster changes`)
      }
    }

    // 6. Exactly ONE tenant signer is not currently on the roster — that's the new tenant
    const newTenants = tenantSigners.filter(t => !currentTenantIds.has(t.tenantId))
    if (newTenants.length === 0) {
      throw new AppError(400, 'No new tenant in signer list — addendum_add requires exactly one new tenant')
    }
    if (newTenants.length > 1) {
      throw new AppError(400, `Multiple new tenants in signer list (${newTenants.length}) — addendum_add accepts exactly one`)
    }
    const newTenant = newTenants[0]

    // 7. New tenant not already in a pending/active state on this lease
    const existing = await queryOne<any>(`
      SELECT id, status FROM lease_tenants
      WHERE lease_id=$1 AND tenant_id=$2
        AND status IN ('pending_add','active','pending_remove')`,
      [leaseId, newTenant.tenantId])
    if (existing) {
      throw new AppError(409, `Tenant ${newTenant.email} is already on this lease (status: ${existing.status})`)
    }

    // 8. Overlap check for new tenant — excludes current lease to avoid self-conflict
    const ov = await canTenantsSignNewLease(
      [newTenant.tenantId], lease.unit_id,
      lease.start_date, lease.end_date || null,
      lease.id)
    if (!ov.ok) throw new AppError(409, ov.reason || 'New tenant has overlapping lease')

    // 9. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2',
        [templateId, req.user!.profileId])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // Transaction: create document + insert pending_add row atomically
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_add',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers
    })

    await client.query(`
      INSERT INTO lease_tenants (
        lease_id, tenant_id, role, status,
        added_reason, financial_responsibility,
        add_document_id
      ) VALUES ($1,$2,'co_tenant','pending_add', 'roommate_added', 'joint_several', $3)`,
      [lease.id, newTenant.tenantId, doc.id])

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-remove', requireAuth, requirePerm('leases.terminate'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, targetLeaseTenantId, promoteLeaseTenantId, templateId, title, signers, basePdfUrl } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_remove')
    if (!targetLeaseTenantId) throw new AppError(400, 'targetLeaseTenantId required for addendum_remove')
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

    // 1. Lease exists, landlord owns, status=active
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    if (lease.status !== 'active') {
      throw new AppError(409, `Cannot remove tenant: lease is ${lease.status}, not active`)
    }

    // 2. Current active roster
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, lt.role, t.user_id
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    const rosterRows = currentRoster as any[]
    if (rosterRows.length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }

    // 3. Minimum-2 rule — cannot remove if it would leave zero active tenants
    if (rosterRows.length < 2) {
      throw new AppError(400, 'Cannot remove the only tenant on this lease — use lease termination instead')
    }

    // 4. Target row validation: exists, on this lease, currently active (not already pending_remove)
    const target = rosterRows.find(r => r.lt_id === targetLeaseTenantId)
    if (!target) {
      // Possible: target exists but is pending_remove, or on a different lease, or doesn't exist at all
      const dbTarget = await queryOne<any>(
        'SELECT id, lease_id, status FROM lease_tenants WHERE id=$1',
        [targetLeaseTenantId])
      if (!dbTarget) throw new AppError(404, 'Target lease_tenant row not found')
      if (dbTarget.lease_id !== leaseId) throw new AppError(400, 'Target does not belong to this lease')
      throw new AppError(409, `Target tenant is ${dbTarget.status}, not active — cannot initiate removal`)
    }

    // 5. Primary-removal rule — if target is primary, promote required and must be active co_tenant on this lease
    if (target.role === 'primary') {
      if (!promoteLeaseTenantId) {
        throw new AppError(400, 'Removing the primary tenant requires promoteLeaseTenantId (successor primary)')
      }
      const promote = rosterRows.find(r => r.lt_id === promoteLeaseTenantId)
      if (!promote) {
        throw new AppError(400, 'Promote target must be an active tenant on this lease')
      }
      if (promote.role !== 'co_tenant') {
        throw new AppError(400, `Promote target role is ${promote.role}, must be co_tenant`)
      }
      if (promote.lt_id === target.lt_id) {
        throw new AppError(400, 'Promote target cannot be the same as the removal target')
      }
    } else {
      if (promoteLeaseTenantId) {
        throw new AppError(400, 'promoteLeaseTenantId set but target is not primary')
      }
    }

    // 6. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }

    // 7. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')

    // 8. Signer composition rule — all current active tenants (INCLUDING target) must sign,
    //    and no tenant signer can be someone not currently on the lease
    const signerUserIds = new Set(tenantSigners.map(t => t.userId))
    const signerTenantIds = new Set(tenantSigners.map(t => t.tenantId))
    for (const r of rosterRows) {
      if (!signerUserIds.has(r.user_id)) {
        throw new AppError(400, `Current tenant (user ${r.user_id}) must sign addendum — all active tenants (including the one being removed) sign`)
      }
    }
    for (const t of tenantSigners) {
      const onRoster = rosterRows.find((r: any) => r.tenant_id === t.tenantId)
      if (!onRoster) {
        throw new AppError(400, `Signer ${t.email} is not currently on this lease — only current tenants sign removal addendums`)
      }
    }

    // 9. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2',
        [templateId, req.user!.profileId])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // Transaction: create document + flip target to pending_remove atomically
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_remove',
      targetLeaseTenantId: target.lt_id,
      promoteLeaseTenantId: promoteLeaseTenantId || null,
      signers
    })

    await client.query(`
      UPDATE lease_tenants
      SET status='pending_remove', remove_document_id=$1
      WHERE id=$2 AND status='active'`,
      [doc.id, target.lt_id])

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-terms/batch', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { title, templateId, scopeType, scopeRef } = req.body

    // 1. Body shape validation
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new AppError(400, 'title is required')
    }
    if (!templateId || typeof templateId !== 'string') {
      throw new AppError(400, 'templateId is required')
    }
    if (!scopeType || !['units', 'property', 'landlord_all'].includes(scopeType)) {
      throw new AppError(400, 'scopeType must be one of: units, property, landlord_all')
    }

    const landlordId = req.user!.profileId
    const landlordUserId = req.user!.userId

    // 2. Template ownership
    const tmpl = await queryOne<any>(
      'SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2',
      [templateId, landlordId])
    if (!tmpl) throw new AppError(404, 'Template not found')

    // 3. Landlord user record for signer construction
    const landlordUser = await queryOne<any>(
      'SELECT id, first_name, last_name, email FROM users WHERE id=$1',
      [landlordUserId])
    if (!landlordUser) throw new AppError(500, 'Landlord user record not found')
    const landlordSigner = {
      userId: landlordUser.id,
      role: 'landlord',
      name: `${landlordUser.first_name} ${landlordUser.last_name}`,
      email: landlordUser.email,
      orderIndex: 1,
    }

    // 4. Resolve scope -> unit_ids
    let unitIds: string[]
    try {
      unitIds = await resolveScopeToUnitIds(client, landlordId, scopeType, scopeRef)
    } catch (e: any) {
      throw new AppError(409, e.message)
    }

    // 5. Resolve unit_ids -> applicable leases (pending/active only)
    const leases = await resolveUnitsToApplicableLeases(client, landlordId, unitIds)

    // 6. Refuse if empty scope
    if (leases.length === 0) {
      throw new AppError(409, 'No applicable leases in scope')
    }

    // 7. Load roster for every lease (single query, grouped in memory)
    const leaseIds = leases.map(l => l.id)
    const rosterRows = await query<any>(`
      SELECT lt.id AS lt_id, lt.lease_id, lt.tenant_id, lt.role AS lt_role,
             t.user_id, u.first_name, u.last_name, u.email
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id = ANY($1::uuid[]) AND lt.status = 'active'`,
      [leaseIds])

    // Group by lease_id
    const rostersByLease = new Map<string, any[]>()
    for (const r of rosterRows as any[]) {
      if (!rostersByLease.has(r.lease_id)) rostersByLease.set(r.lease_id, [])
      rostersByLease.get(r.lease_id)!.push(r)
    }

    // 8. Validation sweep — every lease has >=1 active tenant with full user data
    for (const lease of leases) {
      const roster = rostersByLease.get(lease.id) || []
      if (roster.length === 0) {
        throw new AppError(409, `Lease ${lease.id} has no active tenants — cannot batch terms addendum`)
      }
      for (const r of roster) {
        if (!r.user_id || !r.email || !r.first_name || !r.last_name) {
          throw new AppError(409, `Lease ${lease.id} tenant ${r.tenant_id} missing required user data — contact support`)
        }
      }
    }

    // 9. Platform-block check every unique tenant user across the batch
    const uniqueTenantUserIds = new Set<string>()
    for (const r of rosterRows as any[]) uniqueTenantUserIds.add(r.user_id)
    for (const uid of uniqueTenantUserIds) {
      const blk = await checkPlatformBlock(uid)
      if (!blk.ok) {
        const row = (rosterRows as any[]).find(r => r.user_id === uid)
        throw new AppError(403, `${row.first_name} ${row.last_name}: ${blk.reason}`)
      }
    }

    // 10. Transaction: one batch row + N doc rows atomically
    await client.query('BEGIN')

    const batchInsert = await client.query(`
      INSERT INTO document_batches (landlord_id, title, template_id, scope_type, scope_ref)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id`,
      [landlordId, title.trim(), templateId, scopeType, scopeRef ? JSON.stringify(scopeRef) : null])
    const batchId: string = batchInsert.rows[0].id

    const documentIds: string[] = []

    for (const lease of leases) {
      const roster = rostersByLease.get(lease.id)!
      const tenantSigners = roster.map((r, idx) => ({
        userId: r.user_id,
        role: idx === 0 ? 'primary' : `co_tenant_${idx}`,
        name: `${r.first_name} ${r.last_name}`,
        email: r.email,
        orderIndex: idx + 2,
      }))

      const signers = [landlordSigner, ...tenantSigners]

      const doc = await createDocumentRecord(client, {
        landlordId,
        templateId,
        unitId: lease.unit_id,
        leaseId: lease.id,
        title: title.trim(),
        basePdfUrl: tmpl.base_pdf_url || null,
        documentType: 'addendum_terms',
        targetLeaseTenantId: null,
        promoteLeaseTenantId: null,
        signers,
      })

      // Stamp batch_id on the just-created document
      await client.query(
        'UPDATE lease_documents SET batch_id=$1 WHERE id=$2',
        [batchId, doc.id])

      documentIds.push(doc.id)
    }

    await client.query('COMMIT')
    res.status(201).json({
      success: true,
      data: { batchId, documentCount: documentIds.length, documentIds }
    })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

esignRouter.post('/documents/addendum-terms', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { leaseId, templateId, title, basePdfUrl } = req.body
    // S581: signers may be OMITTED — the money-add-on flow lets the backend resolve
    // them from the lease (landlord + tenants), so the landlord screen just says
    // "leaseId + mode + changes". Explicit signers still supported (the send flow).
    let signers = req.body.signers as any[] | undefined
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_terms')
    if (!title) throw new AppError(400, 'title required')

    // S581: delivery mode determined up-front (drives auto-signer resolution).
    // 'agreement' = tenant opts in + signs; 'notice' = landlord issues, no tenant
    // signature. Landlord chooses per add-on, per their local law (never GAM by state).
    const mode: 'agreement' | 'notice' = req.body.mode === 'notice' ? 'notice' : 'agreement'

    // S581 (Nic): optional MONEY changes this addendum carries — an added recurring
    // charge (parking/garage) or a base-rent change (e.g. AZ mobile-home space rent).
    // Each has a landlord-set effective_date; on completion the nightly job applies
    // it to billing on that date (auto-apply). Validated + stored as pending
    // 'draft' rows below, activated when both parties sign.
    const scheduledChanges = (req.body.scheduledChanges ?? []) as any[]
    const changesSpec = z.array(z.discriminatedUnion('changeType', [
      z.object({
        changeType:    z.literal('rent'),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        newRentAmount: z.number().nonnegative(),
      }),
      z.object({
        changeType:     z.literal('recurring_fee'),
        effectiveDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        // Must be a RECURRING (monthly_ongoing) lease_fees fee_type — the value
        // the apply job writes into lease_fees, which is CHECK-constrained. Only
        // the recurring subset is valid here (deposits / one-time fees excluded).
        feeType:        z.enum([
          'pet_rent', 'parking_rent', 'storage_rent', 'amenity_fee_monthly',
          'trash_fee', 'pest_control_fee', 'technology_fee', 'other_fee',
        ]),
        feeAmount:      z.number().nonnegative(),
        feeDescription: z.string().max(200).optional(),
      }),
    ])).parse(scheduledChanges)

    // 1. Lease exists, landlord owns it. Status restriction intentionally omitted —
    //    terms amendments are valid on any lease status (pending/active alike).
    const lease = await queryOne<any>(
      'SELECT id, landlord_id, unit_id, status FROM leases WHERE id=$1',
      [leaseId])
    if (!lease) throw new AppError(404, 'Lease not found')
    if (!canManageLandlordResource(req.user, lease.landlord_id)) throw new AppError(403, 'Not your lease')
    // S71: 'voided' branch dropped — unreachable per leases_status_check.
    if (lease.status === 'expired' || lease.status === 'terminated') {
      throw new AppError(409, `Cannot amend terms: lease is ${lease.status}`)
    }

    // 2. Current active roster — every active tenant must sign a terms change.
    //    (name/email included so we can auto-assemble signers below.)
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, t.user_id,
             u.first_name, u.last_name, u.email
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    const rosterRows = currentRoster as any[]
    if (rosterRows.length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
    }

    // S581: auto-resolve signers when the caller omits them (money-add-on flow).
    // Landlord always signs. AGREEMENT also needs every active tenant to sign;
    // a NOTICE is landlord-only (no tenant signature). Roles: first tenant is
    // 'primary', the rest 'co_tenant' — matching the addendum signer contract.
    if (!signers?.length) {
      const ll = await queryOne<{ user_id: string; first_name: string; last_name: string; email: string }>(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.email
           FROM landlords la JOIN users u ON u.id = la.user_id WHERE la.id = $1`,
        [lease.landlord_id])
      if (!ll) throw new AppError(500, 'Landlord account not found')
      const built: any[] = [{
        userId: ll.user_id, role: 'landlord',
        name: `${ll.first_name ?? ''} ${ll.last_name ?? ''}`.trim() || ll.email, email: ll.email,
      }]
      if (mode === 'agreement') {
        // Signer roles MUST match TENANT_ROLE_PATTERN /^(primary|co_tenant_\d+)$/ —
        // the literal 'co_tenant' is NOT a valid signer role and would trip the
        // "Invalid signer role" guard below, so a 2+-tenant agreement addendum
        // would 400. First tenant = primary, the rest = co_tenant_1, co_tenant_2, …
        rosterRows.forEach((r: any, i: number) => built.push({
          userId: r.user_id, role: i === 0 ? 'primary' : `co_tenant_${i}`,
          name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email, email: r.email,
        }))
      }
      signers = built
    }

    // 3. Signer shape validation
    const landlordCount = signers.filter((s: any) => s.role === 'landlord').length
    if (landlordCount < 1) throw new AppError(400, 'At least one landlord signer required')
    for (const s of signers) {
      if (!s.userId) throw new AppError(400, `Signer ${s.email || s.name} must have a userId — GAM account required before signing`)
      if (!(s.role === 'landlord' || s.role === 'witness' || isTenantRole(s.role))) {
        throw new AppError(400, `Invalid signer role: ${s.role}`)
      }
    }

    // 4. Resolve each tenant signer's tenant profile
    const tenantSigners: Array<{ userId: string, tenantId: string, role: string, email: string, name: string }> = []
    for (const s of signers) {
      if (!isTenantRole(s.role)) continue
      const t = await queryOne<any>('SELECT id FROM tenants WHERE user_id=$1', [s.userId])
      if (!t) throw new AppError(400, `Signer ${s.email} has no tenant profile — cannot sign as tenant`)
      tenantSigners.push({ userId: s.userId, tenantId: t.id, role: s.role, email: s.email, name: s.name })
    }
    // S581: a NOTICE is landlord-issued and NOT optional, so it needs no tenant
    // signature. AGREEMENT mode keeps the "every active tenant must sign" rule
    // (a rule the tenant is agreeing to). For a notice the affected tenants are
    // still notified — a blocking portal notice is created on completion.
    if (mode === 'agreement') {
      if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')
      // 5. Signer composition — all current active tenants must sign, no outsiders
      const signerUserIds = new Set(tenantSigners.map(t => t.userId))
      for (const r of rosterRows) {
        if (!signerUserIds.has(r.user_id)) {
          throw new AppError(400, `Current tenant (user ${r.user_id}) must sign terms addendum — all active tenants sign rule changes`)
        }
      }
    }
    for (const t of tenantSigners) {
      const onRoster = rosterRows.find((r: any) => r.tenant_id === t.tenantId)
      if (!onRoster) {
        throw new AppError(400, `Signer ${t.email} is not currently on this lease — only current tenants sign terms addendums`)
      }
    }

    // 6. Platform-block check every tenant signer
    for (const t of tenantSigners) {
      const blk = await checkPlatformBlock(t.userId)
      if (!blk.ok) throw new AppError(403, `${t.name}: ${blk.reason}`)
    }

    // Resolve PDF
    let pdfUrl = basePdfUrl
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2',
        [templateId, req.user!.profileId])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // S582: document-first for money add-ons. When the addendum carries a money
    // change and the landlord supplied NO base PDF/template (the MoneyAddonModal
    // path), GENERATE an addendum PDF that PRINTS the exact change + effective
    // date + signature fields — so the tenant signs a document that states the
    // term (memory gam-document-first-enforcement: courts enforce the document,
    // not the software config). The field boxes come back to be persisted below.
    let generatedFields: import('../services/moneyAddonPdf').MoneyAddonFieldBox[] = []
    if (changesSpec.length > 0 && !pdfUrl) {
      const { generateMoneyAddonPdf } = await import('../services/moneyAddonPdf')
      const gen = await generateMoneyAddonPdf({
        leaseId: lease.id,
        title,
        mode,
        changes: changesSpec as any,
        signers: signers.map((s: any) => ({ role: s.role, name: s.name })),
      })
      pdfUrl = gen.fileUrl
      generatedFields = gen.fields
    }

    // Transaction: just create the document. No lease_tenants mutation for terms addendums.
    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: lease.unit_id,
      leaseId: lease.id,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'addendum_terms',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers
    })

    // S581: mark a landlord-issued NOTICE so completion creates the tenant
    // blocking-notice (and no tenant signature is expected). Agreement is default.
    if (mode === 'notice') {
      await client.query(`UPDATE lease_documents SET delivery_mode='notice' WHERE id=$1`, [doc.id])
    }

    // S582: persist the generated PDF's signature/date fields, bound to each
    // signer row (roles are 1:1 with signers here — landlord + primary +
    // co_tenant_N). Skips any field whose role isn't a signer on this document
    // (a notice generates only a landlord block, so nothing is skipped there).
    if (generatedFields.length > 0) {
      const signerRows = await client.query(
        'SELECT id, role FROM lease_document_signers WHERE document_id=$1', [doc.id],
      ).then((r: any) => r.rows as Array<{ id: string; role: string }>)
      const idByRole = new Map(signerRows.map(s => [s.role, s.id]))
      for (const f of generatedFields) {
        const signerId = idByRole.get(f.signerRole)
        if (!signerId) continue
        await client.query(`
          INSERT INTO lease_document_fields
            (document_id, signer_id, field_type, signer_role, label, lease_column,
             page, x, y, width, height, required)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [doc.id, signerId, f.fieldType, f.signerRole, f.label, f.leaseColumn,
           f.page, f.x, f.y, f.width, f.height, f.required])
      }
    }

    // S581: record the money changes as pending 'draft' rows tied to this
    // addendum. They activate to 'scheduled' when both parties sign (see
    // executeAddendumTerms) and apply on their effective date. Same txn as the doc.
    if (changesSpec.length > 0) {
      const { createDraftScheduledChange } = await import('../services/scheduledLeaseChanges')
      for (const ch of changesSpec) {
        await createDraftScheduledChange(client, lease.id, doc.id, ch as any)
      }
    }

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// S576 (B-8): send a WORK-TRADE ADDENDUM. Because a work-trade agreement
// requires an ACTIVE lease, the addendum is just a plain lease TERMS addendum on
// that lease — the proven addendum_terms path (no standalone-completion issues).
// Everything resolves server-side (lease + signers) so the landlord only picks
// their addendum form and clicks send. The document is stamped with
// work_trade_agreement_id so the system KNOWS it's this agreement's addendum
// (no name-guessing) — powering the "addendum on file" surface + renewal
// auto-carry. Create-only; the caller then POSTs /documents/:id/send.
esignRouter.post('/documents/work-trade-addendum', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { workTradeAgreementId, templateId } = req.body
    if (!workTradeAgreementId) throw new AppError(400, 'workTradeAgreementId required')
    if (!templateId) throw new AppError(400, 'templateId required — pick your work-trade addendum form')
    const landlordId = req.user!.profileId

    const agr = await queryOne<any>(`
      SELECT wta.id, wta.unit_id, wta.tenant_id, wta.landlord_id, wta.status,
             un.unit_number, p.name AS property_name
        FROM work_trade_agreements wta
        JOIN units un ON un.id = wta.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE wta.id=$1`, [workTradeAgreementId])
    if (!agr) throw new AppError(404, 'Work-trade agreement not found')
    if (!canManageLandlordResource(req.user, agr.landlord_id)) throw new AppError(403, 'Not your agreement')
    if (agr.status !== 'active') throw new AppError(409, `Agreement is ${agr.status} — resume or renew the lease before sending an addendum`)

    // The gate guarantees an active lease for this tenant on this unit.
    const lease = await queryOne<any>(`
      SELECT l.id, l.unit_id FROM leases l
       JOIN lease_tenants lt ON lt.lease_id = l.id
      WHERE l.unit_id=$1 AND lt.tenant_id=$2 AND l.status='active' AND lt.status='active'
      ORDER BY l.start_date DESC LIMIT 1`, [agr.unit_id, agr.tenant_id])
    if (!lease) throw new AppError(409, 'No active lease for this tenant on this unit — renew the lease first')

    const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [templateId, landlordId])
    if (!tmpl) throw new AppError(404, 'Template not found')
    if (tmpl.purpose !== 'work_trade_addendum') throw new AppError(400, 'Pick a Work-Trade Addendum form (set Form Type = Work-Trade Addendum on the template)')
    if (!tmpl.base_pdf_url) throw new AppError(400, 'That addendum form has no PDF — add one in the template editor')

    const landlordUser = await queryOne<any>(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone
        FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [landlordId])
    if (!landlordUser) throw new AppError(500, 'Landlord user not found')
    const roster = await query<any>(`
      SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, lt.role
        FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id JOIN users u ON u.id = t.user_id
       WHERE lt.lease_id=$1 AND lt.status='active'
       ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [lease.id])
    if ((roster as any[]).length === 0) throw new AppError(409, 'Lease has no active tenants to sign the addendum')
    const signers = [
      { userId: landlordUser.id, role: 'landlord', name: `${landlordUser.first_name} ${landlordUser.last_name}`, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
      ...(roster as any[]).map((r: any, i: number) => ({
        userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`,
        email: r.email, phone: r.phone, orderIndex: i + 2,
      })),
    ]

    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId, templateId, unitId: lease.unit_id, leaseId: lease.id,
      title: `Work-Trade Addendum — Unit ${agr.unit_number}${agr.property_name ? ' — ' + agr.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url, documentType: 'addendum_terms',
      targetLeaseTenantId: null, promoteLeaseTenantId: null, signers,
    })
    await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [workTradeAgreementId, doc.id])
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: { ...doc, work_trade_agreement_id: workTradeAgreementId } })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// S576 (B-8): after a RENEWAL completes, auto-DRAFT (never auto-send) a fresh
// work-trade addendum on the new lease when the tenant's work-trade agreement is
// still ACTIVE — the arrangement carries across the renewal, but the landlord
// eyeballs the draft and sends it, exactly like the renewal itself (Nic). Leaves
// it as an unsent `pending` document that the Work Trade page surfaces as
// "review & send" + a dashboard to-do. Best-effort: never throws into the e-sign
// completion flow. If the landlord has no work-trade addendum FORM, it drafts
// nothing (the manual "Add a form" surface covers that).
export async function autoDraftWorkTradeAddendumForRenewal(newLeaseId: string): Promise<void> {
  const lease = await queryOne<any>(`
    SELECT l.id, l.unit_id, l.landlord_id, u.unit_type, u.property_id, u.unit_number, p.name AS property_name
      FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=u.property_id
     WHERE l.id=$1`, [newLeaseId])
  if (!lease) return
  const agr = await queryOne<any>(`
    SELECT wta.id FROM work_trade_agreements wta
     WHERE wta.unit_id=$1 AND wta.status='active'
       AND wta.tenant_id IN (SELECT tenant_id FROM lease_tenants WHERE lease_id=$2 AND status='active')
     LIMIT 1`, [lease.unit_id, newLeaseId])
  if (!agr) return
  // Idempotent: don't re-draft if a live addendum already exists on this lease.
  const dupe = await queryOne<any>(
    `SELECT id FROM lease_documents WHERE work_trade_agreement_id=$1 AND lease_id=$2 AND status NOT IN ('voided') LIMIT 1`,
    [agr.id, newLeaseId])
  if (dupe) return
  // Resolve the landlord's work-trade addendum form — most specific first
  // (property match, then unit-type match, then universal), newest as tiebreak.
  const tmpl = await queryOne<any>(`
    SELECT * FROM lease_templates
     WHERE landlord_id=$1 AND is_active=TRUE AND purpose='work_trade_addendum'
       AND base_pdf_url IS NOT NULL
       AND (unit_type IS NULL OR unit_type=$2)
       AND (property_id IS NULL OR property_id=$3)
     ORDER BY (property_id=$3) DESC NULLS LAST, (unit_type=$2) DESC NULLS LAST, created_at DESC
     LIMIT 1`, [lease.landlord_id, lease.unit_type, lease.property_id])
  if (!tmpl) return
  const landlordUser = await queryOne<any>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [lease.landlord_id])
  if (!landlordUser) return
  const roster = await query<any>(`
    SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, lt.role
      FROM lease_tenants lt JOIN tenants t ON t.id=lt.tenant_id JOIN users u ON u.id=t.user_id
     WHERE lt.lease_id=$1 AND lt.status='active'
     ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END`, [newLeaseId])
  if ((roster as any[]).length === 0) return
  const signers = [
    { userId: landlordUser.id, role: 'landlord', name: `${landlordUser.first_name} ${landlordUser.last_name}`, email: landlordUser.email, phone: landlordUser.phone, orderIndex: 1 },
    ...(roster as any[]).map((r: any, i: number) => ({ userId: r.user_id, role: r.role, name: `${r.first_name} ${r.last_name}`, email: r.email, phone: r.phone, orderIndex: i + 2 })),
  ]
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId: lease.landlord_id, templateId: tmpl.id, unitId: lease.unit_id, leaseId: newLeaseId,
      title: `Work-Trade Addendum — Unit ${lease.unit_number}${lease.property_name ? ' — ' + lease.property_name : ''}`,
      basePdfUrl: tmpl.base_pdf_url, documentType: 'addendum_terms',
      targetLeaseTenantId: null, promoteLeaseTenantId: null, signers,
    } as any)
    await client.query('UPDATE lease_documents SET work_trade_agreement_id=$1 WHERE id=$2', [agr.id, doc.id])
    await client.query('COMMIT')
    logger.info(`[LeaseRenewal] Auto-drafted work-trade addendum ${doc.id} on renewed lease ${newLeaseId} (agreement ${agr.id}) — awaiting landlord review + send`)
  } catch (e) {
    await client.query('ROLLBACK')
    logger.error({ err: e }, '[LeaseRenewal][wt-addendum-autodraft]')
  } finally {
    client.release()
  }
}

esignRouter.get('/documents/:id', requireAuth, async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords la ON la.id = d.landlord_id
      JOIN users lu ON lu.id = la.user_id
      WHERE d.id = $1`, [req.params.id])
    if (!doc) throw new AppError(404, 'Document not found')

    const isOwner = doc.landlord_id === req.user!.profileId
    const isSigner = await queryOne<any>('SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND user_id=$2', [doc.id, req.user!.userId])
    if (!isOwner && !isSigner) throw new AppError(403, 'Not authorized for this document')

    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])
    const fields  = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1 ORDER BY page, y', [doc.id])
    res.json({ success: true, data: { ...doc, signers, fields } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// SEND DOCUMENT
// ─────────────────────────────────────────────────────────────

esignRouter.post('/documents/:id/send', requireAuth, requirePerm('esign.send'), async (req, res, next) => {
  try {
    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1 AND d.landlord_id=$2`, [req.params.id, req.user!.profileId])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(400, 'Document already completed')
    if (doc.status === 'voided')    throw new AppError(400, 'Document has been voided')
    if (doc.status === 'execution_failed') throw new AppError(400, 'Document execution failed - create a new document instead')

    // Fast-fail overlap pre-check before we start emailing anyone
    const { primary, coTenants } = await getDocumentTenantSigners(doc.id)
    if (primary && doc.unit_id) {
      // Try to infer proposed start/end from field defaults if available
      const vals = await query<any>(`
        SELECT lease_column, value FROM lease_document_fields
        WHERE document_id=$1 AND lease_column IN ('start_date','end_date') AND value IS NOT NULL`, [doc.id])
      const startVal = (vals as any[]).find(v => v.lease_column === 'start_date')?.value
      const endVal   = (vals as any[]).find(v => v.lease_column === 'end_date')?.value
      if (startVal) {
        const allTenantIds = [primary.tenantId, ...coTenants.map(c => c.tenantId)]
        // S535: '-' end date = month-to-month (no end date) — never cast it as a date.
        const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startVal, endVal && endVal.trim() !== '-' ? endVal : null)
        if (!ov.ok) throw new AppError(409, `Cannot send: ${ov.reason}`)

        // ────────────────────────────────────────────────────────────────────
        // S622: SCREENING GATE (Business Terms §9.2).
        //
        // Nic: "after the onboarding window is closed, all applicants must
        // complete the background check to actually have the lease going."
        //
        // Enforced at SEND, not at finalize, on purpose: refusing after every
        // party has signed strands a signed lease and helps nobody. Here the
        // landlord simply cannot invite an unscreened applicant yet.
        //
        // MIGRATED TENANTS ARE EXEMPT. A tenancy that began before the landlord
        // joined GAM was formed off-Platform, and we do not retroactively
        // condition it on a report. The window is each landlord's OWN onboarding
        // date, so it stays correct for everyone who joins later rather than
        // hanging off a global cutoff that ages badly.
        //
        // Renewals are exempt too — renews_lease_id means an existing tenant,
        // who was either screened already or is themselves a migrated tenancy.
        // Read the flag as opt-OUT, not opt-in. This is a platform rule stated in
        // the Business Terms; the row exists so that DISABLING it is a deliberate,
        // recorded act. isFeatureEnabled() returns false for a missing row, which
        // would mean an unrun migration silently switches the rule off — the
        // failure mode we least want on a compliance gate. Absent row = ON.
        const flag = await queryOne<{ enabled: boolean }>(
          `SELECT enabled FROM system_features WHERE key = 'screening_required_for_new_leases'`)
        const gateOn = flag ? flag.enabled === true : true
        if (gateOn && doc.document_type === 'original_lease' && !doc.renews_lease_id) {
          const ll = await queryOne<{ created_at: string; migration_window_ends_at: string | null }>(
            `SELECT created_at, migration_window_ends_at FROM landlords WHERE id = $1`, [doc.landlord_id])
          const leaseStart = new Date(startVal)
          const onboardedAt = ll ? new Date(ll.created_at) : null
          // S624: DERIVE the window when the column is null rather than treating
          // null as "open forever".
          //
          // That fail-open default is what let a signup bug become a compliance
          // hole: nothing set the column at signup, so every landlord created
          // after the S623 backfill was permanently inside their onboarding
          // window and never had to screen anybody. The gate looked correct and
          // caught nobody — the same failure mode the feature-flag default just
          // above this deliberately avoids ("absent row = ON").
          //
          // Deriving from created_at gives the identical answer the backfill
          // migration computed, so a missing column can never again mean a
          // missing rule.
          const windowEnds = ll?.migration_window_ends_at
            ? new Date(ll.migration_window_ends_at)
            : (onboardedAt
                ? new Date(onboardedAt.getTime() + MIGRATION_WINDOW_DAYS * 86400000)
                : null)

          // A tenancy counts as MIGRATED — and is exempt — on any of:
          //
          //  1. The onboarding window is still open. For a period after joining,
          //     a landlord is transcribing tenancies that already exist. This is
          //     the case the first cut got wrong: Oak Park onboarded 2026-08-14
          //     and is papering 30 sitting tenants with documents dated today.
          //     The tenancy is old even though the paperwork is new.
          //  2. The landlord marked that they already hold this tenant's deposit
          //     — an explicit assertion that the tenant was already living there,
          //     and it holds even after the window closes.
          //  3. The lease genuinely starts before the landlord joined GAM.
          const windowOpen = !windowEnds || new Date() < windowEnds
          const isMigrated =
            windowOpen ||
            doc.deposit_already_held === true ||
            (!!onboardedAt && leaseStart < onboardedAt)
          if (!isMigrated) {
            // LEFT JOIN, deliberately: a signer with no tenants row certainly has
            // no background check either. An inner join would have let exactly
            // the least-established applicants through — the gate would have
            // looked correct and caught nobody.
            const unscreened = await query<{ name: string }>(
              `SELECT s.name
                 FROM lease_document_signers s
                 LEFT JOIN tenants t ON t.user_id = s.user_id
                WHERE s.document_id = $1
                  AND s.role <> 'landlord' AND s.role <> 'witness'
                  AND NOT EXISTS (
                    SELECT 1 FROM background_checks bc
                     WHERE bc.tenant_id = t.id
                       AND bc.status IN ('approved', 'completed', 'clear')
                  )`, [doc.id])
            if (unscreened.length > 0) {
              const who = unscreened.map(u => u.name).join(', ')
              const closed = windowEnds ? windowEnds.toISOString().slice(0, 10) : 'your onboarding'
              throw new AppError(409,
                `Cannot send: ${who} ${unscreened.length === 1 ? 'has' : 'have'} not completed a background check. ` +
                `Your onboarding migration window closed on ${closed}, so new applicants must be screened before ` +
                `a lease is sent (Business Terms §9.2). If this tenant was already living in the unit, mark that ` +
                `you already hold their deposit on the send form and they are treated as an existing tenancy.`)
            }
          }
        }
      }
    }

    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])

    // ────────────────────────────────────────────────────────────────────────
    // S28: Landlord-first signer check — LEASE documents only.
    // Landlord fills the writable/fee/utility values during template completion
    // and signs first to lock the inputs. Tenants then sign accepting those
    // values. If a tenant signed first, they would either sign blank fields
    // or the landlord could alter values after acceptance — both unacceptable.
    // S568: standalone documents (purchase agreements, contracts) have no
    // landlord party + no lease-value fields, so this ordering rule does not
    // apply — they sign in whatever order the creator set.
    // ────────────────────────────────────────────────────────────────────────
    const isStandaloneDoc = (STANDALONE_DOCUMENT_TYPES as readonly string[]).includes(doc.document_type)
    if (!isStandaloneDoc) {
      const sortedSigners = [...(signers as any[])].sort(
        (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
      )
      const firstByOrder = sortedSigners[0]
      if (!firstByOrder) throw new AppError(400, 'No signers configured')
      if (firstByOrder.role !== 'landlord') {
        throw new AppError(
          400,
          'Landlord must be the first signer. Reorder signers so the landlord signs first.'
        )
      }
      // S535 (Nic): a tied order_index would let a tenant sign in parallel
      // with the landlord — the landlord's slot must be strictly first.
      const tenantAtOrBeforeLandlord = sortedSigners.some(
        (sg: any) => sg.role !== 'landlord' && (sg.order_index ?? 0) <= (firstByOrder.order_index ?? 0)
      )
      if (tenantAtOrBeforeLandlord) {
        throw new AppError(400, 'The landlord must sign before all other signers — no signer may share the landlord\'s signing position.')
      }
    } else if (signers.length === 0) {
      throw new AppError(400, 'No signers configured')
    }

    // ────────────────────────────────────────────────────────────────────────
    // S28 → S535: tagged value-bearing fields must be filled before the
    // TENANT sees the document — but the landlord signs FIRST and types
    // terms INTO the doc (lease-is-law), so landlord-role tagged fields
    // may legitimately be empty at send (e.g. a cross-template renewal
    // binding a field the predecessor can't derive). Those are enforced
    // at the landlord's sign submit instead (POST /sign). Non-landlord
    // tagged fields still must arrive filled here.
    // ────────────────────────────────────────────────────────────────────────
    const fieldRows = await query<{ lease_column: LeaseColumn | null; value: string | null; signer_role: string | null }>(
      'SELECT lease_column, value, signer_role FROM lease_document_fields WHERE document_id=$1',
      [doc.id]
    )
    const violations = validateLeaseDocumentForSend(
      (fieldRows as any[]).filter(r => r.signer_role !== 'landlord') as any)
    if (violations.length > 0) {
      const labels = violations.map(v => LEASE_COLUMN_LABEL[v.lease_column])
      throw new AppError(
        400,
        `Cannot send: ${violations.length} tagged field(s) need values: ${labels.join(', ')}`
      )
    }

    const firstSigner = (signers as any[]).find(s => s.order_index === 1) || (signers as any[])[0]
    if (!firstSigner) throw new AppError(400, 'No signers configured')

    const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : (doc.title || 'GAM Document')

    // Branch signing URL: unactivated tenants land on /accept-invite first, then get redirected to /sign
    // S410 (S377): read tenant_invite_token (was email_verify_token).
    const firstSignerUser = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [firstSigner.user_id])
    const signingUrl = signingUrlFor(firstSigner, doc.id, firstSignerUser)

    await emailSigningRequest(firstSigner.email, firstSigner.name, doc.title, unitLabel, doc.landlord_name, signingUrl, { landlordId: doc.landlord_id, documentId: doc.id })
    await createNotification({
      userId: firstSigner.user_id,
      type: 'esign_request',
      title: 'Document ready to sign',
      body: `${doc.landlord_name} sent you "${doc.title}" for ${unitLabel}.`,
      data: { documentId: doc.id },
      sendEmail: false
    })

    await query("UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])
    await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1", [firstSigner.id])

    res.json({ success: true, data: { sentTo: firstSigner.email } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// VOID
// ─────────────────────────────────────────────────────────────

esignRouter.post('/documents/:id/void', requireAuth, requirePerm('esign.void'), async (req, res, next) => {
  const client = await getClient()
  try {
    const { reason } = req.body

    await client.query('BEGIN')

    const doc = await client.query(
      'SELECT * FROM lease_documents WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId]
    ).then((r: any) => r.rows[0])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'completed') throw new AppError(400, 'Cannot void a completed document')
    if (doc.status === 'voided') throw new AppError(400, 'Document is already voided')

    // S29 item 6 / S558: allow voiding through a landlord-only signature. The
    // landlord always signs first (S28), and a lease is not an executed contract
    // until the counterparty signs — a landlord's signature on a draft no tenant
    // has signed binds no one, so it stays voidable (typo recall, roster changes
    // before tenants commit). Lock voiding only once a TENANT signs; from there
    // the legally clean path is a superseding document. (Blocking on the
    // landlord's own signature would make void useless for every mid-roster fix,
    // since the landlord-first flow means every fresh draft already carries it.)
    // This also unblocks voiding execution_failed docs so landlords can clear
    // them from their dashboard while admin investigates.
    const tenantSigned = await queryOne<any>(
      "SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL AND role NOT IN ('landlord','witness') LIMIT 1",
      [doc.id])
    if (tenantSigned) throw new AppError(409, 'Cannot void after a tenant has signed — create a superseding document instead')

    // Cascade lease_tenants state by document_type
    await cascadeLeaseTenantsOnVoid(client.query.bind(client), doc)

    await client.query(
      "UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2",
      [reason || null, doc.id])

    // S581: a voided addendum's pending money changes (scheduled rent / recurring
    // fee) must NEVER reach billing — cancel them atomically with the void.
    await client.query(
      `UPDATE scheduled_lease_changes SET status='cancelled', updated_at=NOW()
        WHERE source_document_id=$1 AND status IN ('draft','scheduled')`,
      [doc.id])

    await client.query('COMMIT')
    res.json({ success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────
// SIGNING
// ─────────────────────────────────────────────────────────────


/**
 * S629 (Nic): "I need to be able to sign from clicking a link in the email,
 * because that is how other people are gonna also sign. Nobody's gonna log in
 * and see 'oh, I've gotta sign my lease now.'"
 *
 * The signing link was hard-coded to the TENANT app for every signer — but the
 * first signer on a lease is the LANDLORD, so the landlord was emailed a link
 * into the tenant portal, which their account cannot sign in. LANDLORD_APP_URL
 * has existed all along and was never used here.
 *
 * A tenant who has not activated yet still lands on /accept-invite first and is
 * carried through to the document afterwards — signing is the reason they were
 * invited, so it should not dead-end at a password screen.
 */
export function signingUrlFor(signer: { role: string }, documentId: string,
                       user: { email_verified?: boolean; tenant_invite_token?: string | null } | null): string {
  if (signer.role === 'landlord' || signer.role === 'witness') {
    return `${LANDLORD_APP_URL}/sign/${documentId}`
  }
  if (user && !user.email_verified && user.tenant_invite_token) {
    return `${TENANT_APP_URL}/accept-invite?token=${user.tenant_invite_token}` +
           `&next=${encodeURIComponent('/sign/' + documentId)}`
  }
  return `${TENANT_APP_URL}/sign/${documentId}`
}

esignRouter.get('/sign/:documentId', requireAuth, async (req, res, next) => {
  try {
    const signer = await queryOne<any>(`
      SELECT * FROM lease_document_signers
      WHERE document_id=$1 AND user_id=$2`,
      [req.params.documentId, req.user!.userId])
    if (!signer) throw new AppError(403, 'You are not a signer on this document')

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, p.state as property_state,
             p.landlord_id as property_landlord_id,
             lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    if (!doc) throw new AppError(404, 'Document not found')

    // S235: read-only re-open. Pre-S235 the GET threw on terminal states
    // (signed / completed / voided / execution_failed), so a tenant who'd
    // signed could never re-open the doc to see what they'd agreed to.
    // Now the route serves a read-only payload for those states, with
    // all-roles fields (so the user sees the full executed state, not
    // just their own role's slots) and the executed_pdf_url when ready.
    const docTerminal =
      doc.status === 'completed' || doc.status === 'voided' || doc.status === 'execution_failed'
    const signerTerminal = signer.status === 'signed' || signer.status === 'declined'
    const readOnly = docTerminal || signerTerminal

    const fields = await query<any>(
      readOnly
        ? `SELECT * FROM lease_document_fields WHERE document_id=$1 ORDER BY page, y`
        : `SELECT * FROM lease_document_fields WHERE document_id=$1 AND signer_role=$2 ORDER BY page, y`,
      readOnly ? [doc.id] : [doc.id, signer.role])

    // S535: value-bearing tagged fields (writable / fee_row / utility_row)
    // are ALWAYS required for the landlord's pass — the sign submit
    // enforces completeness regardless of the template's required flag,
    // so the UI counter and Next Field must agree ("N/A" / "0" are valid
    // entries for fields that don't apply). Presentation-level only.
    if (!readOnly && signer.role === 'landlord') {
      for (const f of fields as any[]) {
        if (f.lease_column
            && LEASE_COLUMN_VALUE_BEARING_CATEGORIES.includes(LEASE_COLUMN_CATEGORY[f.lease_column as LeaseColumn])) {
          f.required = true
        }
      }
    }

    if (!readOnly && signer.status === 'sent') {
      await query("UPDATE lease_document_signers SET status='viewed', viewed_at=NOW() WHERE id=$1", [signer.id])
    }

    // S194: deposit-interest context for the signer. When this is an
    // original_lease or addendum_terms document at a property in a
    // state with a statutory rate (or per-landlord override), surface
    // the rate so the tenant knows up-front what interest their deposit
    // will accrue. Skipped for documents at properties without a rate
    // (most states have no statute) or document types where deposit
    // terms don't apply (addendum_add / addendum_remove are tenant-
    // roster changes, not term changes).
    let deposit_interest_context: any = null
    const showsDepositTerms = doc.document_type === 'original_lease' || doc.document_type === 'addendum_terms'
    if (showsDepositTerms && doc.property_state) {
      const currentYear = new Date().getUTCFullYear()
      const statutory = await queryOne<{
        annual_rate_pct:  string
        statute_citation: string
      }>(
        `SELECT annual_rate_pct::text AS annual_rate_pct, statute_citation
           FROM state_deposit_interest_rates
          WHERE state_code = $1 AND effective_year = $2
          LIMIT 1`,
        [doc.property_state, currentYear],
      )
      if (statutory) {
        deposit_interest_context = {
          source:           'statutory',
          state_code:       doc.property_state,
          effective_year:   currentYear,
          annual_rate_pct:  statutory.annual_rate_pct,
          statute_citation: statutory.statute_citation,
        }
      } else if (doc.property_landlord_id) {
        // Fall through to landlord override.
        const override = await queryOne<{
          annual_rate_pct: string
          source_notes:    string | null
        }>(
          `SELECT annual_rate_pct::text AS annual_rate_pct, source_notes
             FROM landlord_deposit_interest_rate_overrides
            WHERE landlord_id = $1 AND state_code = $2 AND effective_year = $3
            LIMIT 1`,
          [doc.property_landlord_id, doc.property_state, currentYear],
        )
        if (override) {
          deposit_interest_context = {
            source:           'landlord_override',
            state_code:       doc.property_state,
            effective_year:   currentYear,
            annual_rate_pct:  override.annual_rate_pct,
            statute_citation: null,
            source_notes:     override.source_notes,
          }
        }
      }
    }

    // S534: on a renewal doc, tell the signing UI what deposit is
    // already held so the deposit field shows the double-count overlay
    // (equal carries · higher bills only the difference · lower needs a
    // manual partial return).
    let carried_deposit: number | null = null
    let carried_rent: number | null = null
    if (doc.renews_lease_id) {
      // Scoped to the security_deposit fee_type — the overlay sits on
      // that field and the delta guard compares per type (S535).
      const cd = await queryOne<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM lease_fees
          WHERE lease_id=$1 AND fee_type='security_deposit'
            AND due_timing='move_in' AND is_refundable=TRUE`,
        [doc.renews_lease_id])
      carried_deposit = Number(cd?.total || 0)
      // S535: the predecessor's rent powers the increase presets
      // (+3/5/10%, flat $) on the rent field in the signing pass.
      const cr = await queryOne<{ rent_amount: string }>(
        `SELECT rent_amount::text AS rent_amount FROM leases WHERE id=$1`,
        [doc.renews_lease_id])
      carried_rent = Number(cr?.rent_amount || 0)
    }

    // S535: property late-fee POLICY for the signing UI — when set, the
    // doc's late-fee fields render locked (uniform terms per property,
    // fair-housing) and clicking one explains the policy + the exact
    // day the fee starts given this lease's due day and grace period.
    let property_late_fee: any = null
    if (doc.unit_id) {
      // S535: per-(property, unit type) resolution — no property default.
      // When no policy row exists for this class, return a none-marker so
      // the signing UI still locks the fields and explains the absence.
      property_late_fee = await resolveLateFeePolicyForUnit(doc.unit_id)
      if (!property_late_fee) {
        const u = await queryOne<any>(
          `SELECT u.unit_type, p.name AS property_name
             FROM units u JOIN properties p ON p.id = u.property_id
            WHERE u.id = $1`, [doc.unit_id])
        if (u) property_late_fee = { none: true, unit_type: u.unit_type, property_name: u.property_name }
      }
    }

    res.json({ success: true, data: { signer, document: doc, fields, deposit_interest_context, carried_deposit, carried_rent, property_late_fee, readOnly } })
  } catch (e) { next(e) }
})

esignRouter.post('/sign/:documentId', requireAuth, async (req, res, next) => {
  const client = await getClient()
  let txnDone = false
  try {
    const { fieldValues } = req.body

    await client.query('BEGIN')

    // Phase A: pre-validation reads (inside txn for read-your-writes consistency)
    const signerRes = await client.query(
      `SELECT * FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`,
      [req.params.documentId, req.user!.userId])
    const signer = signerRes.rows[0]
    if (!signer) throw new AppError(403, 'You are not a signer on this document')
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    // S535: hard turn enforcement. Order was previously enforced only by
    // the invite relay (next signer emailed after the previous one signs)
    // — the submit route itself never checked, so a signer who knew the
    // documentId could sign out of order via the API and (worst case) a
    // tenant could accept a lease whose landlord-typed terms weren't
    // locked in yet (the exact S28 landlord-first failure mode).
    const priorUnsigned = await client.query(
      `SELECT 1 FROM lease_document_signers
        WHERE document_id=$1 AND order_index < $2 AND status != 'signed'
        LIMIT 1`,
      [signer.document_id, signer.order_index])
    if (priorUnsigned.rows.length > 0) {
      throw new AppError(403, 'Not your turn to sign yet — an earlier signer has not completed')
    }

    // S535 (Nic): a tenant NEVER signs before the landlord — blanket rule
    // on top of the order_index turn check above, which a tied
    // order_index could slip past. Any unsigned landlord-role signer on
    // the document blocks every tenant-role signature. Sublease
    // agreements are naturally unaffected (no landlord signer row).
    if (isTenantRole(signer.role)) {
      const unsignedLandlord = await client.query(
        `SELECT 1 FROM lease_document_signers
          WHERE document_id=$1 AND role='landlord' AND status != 'signed'
          LIMIT 1`,
        [signer.document_id])
      if (unsignedLandlord.rows.length > 0) {
        throw new AppError(403, 'The landlord signs first — you will be notified when the document is ready for your signature')
      }
    }

    // Platform block check on tenant roles. checkPlatformBlock uses the
    // non-transactional query() — acceptable because tenant.platform_status
    // is set by separate flows and the read-after-write race is benign here.
    if (isTenantRole(signer.role)) {
      const blk = await checkPlatformBlock(req.user!.userId)
      if (!blk.ok) throw new AppError(403, blk.reason || 'Account blocked from signing')
    }

    const docRes = await client.query(`
      SELECT d.*, u.unit_number, u.unit_type, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name, lu.email as landlord_email
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    const doc = docRes.rows[0]
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'voided') throw new AppError(400, 'Document has been voided')
    if (doc.status === 'execution_failed') throw new AppError(400, 'Document execution failed - contact your landlord')

    // Re-check overlap on EVERY signing (another roommate may have taken a conflicting lease
    // between send time and now). Helpers below use non-transactional query() —
    // same pattern as platform block, acceptable race window.
    const { primary, coTenants } = await getDocumentTenantSigners(doc.id)
    if (primary && doc.unit_id) {
      const valsRes = await client.query(`
        SELECT lease_column, value FROM lease_document_fields
        WHERE document_id=$1 AND lease_column IN ('start_date','end_date') AND value IS NOT NULL`, [doc.id])
      const vals = valsRes.rows
      const startVal = (vals as any[]).find(v => v.lease_column === 'start_date')?.value
      const endVal   = (vals as any[]).find(v => v.lease_column === 'end_date')?.value
      if (startVal) {
        const allTenantIds = [primary.tenantId, ...coTenants.map(c => c.tenantId)]
        // S535: '-' end date = month-to-month (no end date) — never cast it as a date.
        const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startVal, endVal && endVal.trim() !== '-' ? endVal : null)
        if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')
      }
    }

    // S29 item 3: Server-side required-field validation. Frontend gates on this
    // but malicious clients can bypass the gate. Verify every required field
    // assigned to this signer's role will have a non-empty value after this
    // submission completes (either submitted now or already in the DB).
    // S556: a required CONDITIONAL child (nested radio) is only enforced when
    // its parent's effective selection == the child's trigger option — a hidden
    // child (e.g. auto_renew_mode when the lease is month-to-month) is skipped.
    const allFieldsRes = await client.query(`
      SELECT id, template_field_id, parent_field_id, parent_option, label, field_type, signer_role, required, value
      FROM lease_document_fields WHERE document_id=$1`, [doc.id])
    const allFields = allFieldsRes.rows as any[]
    const submittedById = new Map<string, string>()
    for (const fv of (fieldValues || [])) {
      if (fv.value != null && String(fv.value).trim() !== '') {
        submittedById.set(fv.fieldId, String(fv.value))
      }
    }
    const effVal = (f: any): string | null => {
      const s = submittedById.get(f.id)
      if (s != null && String(s).trim() !== '') return String(s)
      return (f.value != null && String(f.value).trim() !== '') ? String(f.value) : null
    }
    // child.parent_field_id references the parent's TEMPLATE field id
    const byTemplateFieldId = new Map<string, any>()
    for (const f of allFields) if (f.template_field_id) byTemplateFieldId.set(f.template_field_id, f)
    const isActive = (f: any): boolean => {
      if (!f.parent_field_id) return true
      const parent = byTemplateFieldId.get(f.parent_field_id)
      if (!parent) return true // parent pruned/missing → degrade to always-shown
      return effVal(parent) === f.parent_option
    }
    const missingRequired: string[] = []
    for (const f of allFields) {
      if (f.signer_role !== signer.role || !f.required) continue
      if (!isActive(f)) continue // hidden conditional child is not required
      if (effVal(f) == null) missingRequired.push(f.label || `${f.field_type} field`)
    }
    if (missingRequired.length > 0) {
      throw new AppError(400, `Missing required fields: ${missingRequired.join(', ')}`)
    }

    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress
    const ua = req.headers['user-agent']

    // Phase B: atomic writes — fields, signer status, document status.
    // S29 item 2: Field-value spoofing fix. The original UPDATE matched only
    // on field id + document id, which let a malicious signer overwrite ANY
    // field — including ones already signed by another party. Two extra
    // conditions on the WHERE:
    //   - signer_role match: you can only update fields assigned to your role
    //   - signed_at IS NULL OR signer_id=you: only touch unsigned fields, or
    //     fields you yourself previously signed.
    // Spoof attempts silently no-op (filtered out by the WHERE).
    for (const fv of (fieldValues || [])) {
      await client.query(`
        UPDATE lease_document_fields
        SET value=$1, signed_at=NOW(), signer_id=$2
        WHERE id=$3 AND document_id=$4
          AND signer_role=$5
          AND (signed_at IS NULL OR signer_id=$2)`,
        [fv.value, signer.id, fv.fieldId, doc.id, signer.role])
    }

    // S556: clear any conditional child whose parent is no longer at its
    // trigger option, so a stale/contradictory sub-answer never lands in the
    // signed lease (Nic: clear-on-parent-change). Uses the post-submission
    // effective values computed above.
    for (const f of allFields) {
      if (f.parent_field_id && !isActive(f) && effVal(f) != null) {
        await client.query('UPDATE lease_document_fields SET value=NULL WHERE id=$1 AND document_id=$2', [f.id, doc.id])
      }
    }

    // S535: the LANDLORD-first signing pass is where lease terms are
    // typed into the doc (send no longer requires landlord-role tagged
    // fields to be prefilled — cross-template renewals may bind fields
    // the predecessor can't derive). The lock-before-tenant invariant
    // (S28) is enforced HERE: after the landlord's values land, every
    // tagged value-bearing field must be filled or the sign rolls back.
    if (signer.role === 'landlord') {
      const taggedRows = await client.query(
        `SELECT template_field_id, parent_field_id, parent_option, lease_column, value FROM lease_document_fields WHERE document_id=$1`,
        [doc.id])
      // S556: exclude inactive conditional children — a hidden sub-radio (its
      // parent isn't at the trigger option) is not a required lease term.
      const rows = taggedRows.rows as any[]
      const byTfid = new Map<string, any>()
      for (const r of rows) if (r.template_field_id) byTfid.set(r.template_field_id, r)
      const activeRows = rows.filter((r) => {
        if (!r.parent_field_id) return true
        const p = byTfid.get(r.parent_field_id)
        if (!p) return true
        const pv = p.value != null && String(p.value).trim() !== '' ? String(p.value) : null
        return pv === r.parent_option
      })
      const unfilled = validateLeaseDocumentForSend(activeRows as any)
      if (unfilled.length > 0) {
        const labels = unfilled.map(v => LEASE_COLUMN_LABEL[v.lease_column])
        throw new AppError(400, `Fill these lease terms before signing: ${labels.join(', ')}`)
      }
    }

    await client.query(`
      UPDATE lease_document_signers
      SET status='signed', signed_at=NOW(), ip_address=$1, user_agent=$2
      WHERE id=$3`,
      [ip, ua, signer.id])

    await client.query("UPDATE lease_documents SET status='in_progress', updated_at=NOW() WHERE id=$1", [doc.id])

    await client.query('COMMIT')
    txnDone = true

    // Phase C: post-commit side effects (off-txn). The signature is durable
    // at this point; downstream failures (email, PDF stamp, lease build) get
    // their own handling without rolling back the signature.

    const remaining = await queryOne<any>(
      "SELECT COUNT(*)::int as count FROM lease_document_signers WHERE document_id=$1 AND status != 'signed'",
      [doc.id])

    if (remaining?.count === 0) {
      // S29 item 5: Build lease BEFORE marking document completed. If build
      // fails, park the doc in execution_failed state for admin investigation.
      // Signatures are real but no lease record exists, so 'completed' would
      // be a lie. Tenant frontend still gets completed:true (their work is
      // done); the failure is a landlord/admin-side issue surfaced in the
      // landlord dashboard via execution_failed status.
      // S576 (B-8): no-lease document types (standalone contracts +
      // work_trade_addendum) produce NO lease record — the signed PDF is the
      // legal instrument. buildLeaseFromDocument's switch has no case for them
      // and would throw 'Unknown document_type', dumping a fully-signed doc into
      // execution_failed. Skip the build entirely; these complete cleanly and
      // still get their PDF stamped below. leaseResult stays null (no lease id).
      const isNoLeaseDoc = (NO_LEASE_DOCUMENT_TYPES as readonly string[]).includes(doc.document_type)

      let leaseResult: { leaseId: string; status: string; primaryTenantId: string; alreadyBuilt: boolean } | null = null
      if (!isNoLeaseDoc) {
        try {
          leaseResult = await buildLeaseFromDocument(doc.id)
        } catch (e: any) {
          logger.error('[ESIGN] buildLeaseFromDocument failed for document', doc.id, '-', e.message)
          // S132: critical — signed document but no lease materialized.
          // Tenant signed a legal contract that didn't translate to an
          // active lease in the system. Manual remediation needed.
          await createAdminNotification({
            severity: 'critical',
            category: 'esign_lease_build_failed',
            title:    `Lease build failed for signed document ${doc.id}`,
            body:     e.message,
            context:  { document_id: doc.id },
          })
          await query(
            "UPDATE lease_documents SET status='execution_failed', execution_failed_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2",
            [`Lease build failed: ${e.message}`, doc.id])
          return res.json({ success: true, data: { completed: true, executionFailed: true, reason: e.message } })
        }

        // S581: a deduped (already-built) result means a concurrent final
        // signature won the finalization race — the winner already ran the
        // one-time side effects (PM transfer, PDF stamp, completion emails) and
        // marked the doc completed. Do NOT re-run them; just report done.
        if (leaseResult?.alreadyBuilt) {
          return res.json({ success: true, data: { completed: true, leaseId: leaseResult.leaseId, deduped: true } })
        }

        // S119 post-commit: fire Stripe Transfer for any PM company leasing
        // fee that landed on the ledger as a ghost. Only fires when the
        // property is contracted to a PM company with leasing_fee_amount > 0.
        // No-lease docs never reach here — there is no lease to attribute a
        // leasing fee to (leaseResult is null).
        try {
          const { firePmTransfersForReference } = await import('../services/stripeConnect')
          await firePmTransfersForReference('lease', leaseResult.leaseId)
        } catch (e) {
          logger.error({ err: e, ctx: leaseResult.leaseId }, '[pm_transfer] post-commit firing failed for lease')
          await createAdminNotification({
            severity: 'warn',
            category: 'pm_transfer_post_commit_failed',
            title:    `PM leasing fee transfer failed for lease ${leaseResult.leaseId}`,
            body:     e instanceof Error ? e.message : String(e),
            context:  { lease_id: leaseResult.leaseId, document_id: doc.id },
          })
        }
      }

      await query("UPDATE lease_documents SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])

      // S629 (Nic): "a pending unit should have the amount of water show as
      // temporary suspension back end and be billed with the first invoice as
      // soon as acceptance happens."
      //
      // While they were invited but unsigned, their utility share was counted
      // into the RUBS split — so their neighbours were charged correctly — and
      // held with no invoice behind it. Signing is what gives it somewhere to
      // go, so it lands on their first invoice now.
      //
      // Post-commit and best-effort, like the neighbours here: the signature is
      // recorded and must never be rolled back over a utility charge. A row
      // that fails stays HELD rather than vanishing, so nothing is silently
      // written off.
      if (leaseResult?.leaseId && doc.unit_id) {
        try {
          const lease = await queryOne<{ landlord_id: string }>(
            `SELECT landlord_id FROM leases WHERE id = $1`, [leaseResult.leaseId])
          const primary = await queryOne<{ tenant_id: string }>(
            `SELECT tenant_id FROM lease_tenants WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
            [leaseResult.leaseId])
          if (lease && primary) {
            await releaseSuspendedChargesForLease({
              unitId: doc.unit_id, leaseId: leaseResult.leaseId,
              tenantId: primary.tenant_id, landlordId: lease.landlord_id,
            })
          }
        } catch (e) {
          logger.error({ err: e, leaseId: leaseResult.leaseId },
            '[utility] releasing held shares failed — they stay held')
        }
      }

      // S629 (Nic): a signed PURCHASE AGREEMENT is what starts a financed home
      // sale billing. The contract has been sitting in pending_signature with
      // its terms and no schedule; this writes the installments and makes it
      // active, so what gets billed is what was signed.
      //
      // Best-effort and post-commit like the neighbours here: the signature is
      // already recorded and must not be rolled back if scheduling fails.
      // activateHomeSaleContract is idempotent, and a failure leaves the
      // contract pending — visible, and retryable — rather than half-billed.
      if (doc.document_type === 'purchase_agreement') {
        try {
          await activateHomeSaleContract(doc.id)
        } catch (e) {
          logger.error({ err: e, documentId: doc.id }, '[HomeSale][activate-on-signature]')
          await createAdminNotification({
            severity: 'warn',
            category: 'home_sale_activation_failed',
            title:    `Home-sale billing not started for signed agreement ${doc.id}`,
            body:     e instanceof Error ? e.message : String(e),
            context:  { document_id: doc.id },
          }).catch(() => {})
        }
      }

      // S576 (B-8): a completed RENEWAL means the new lease now exists — if the
      // tenant's work-trade agreement is still active, auto-draft a fresh
      // work-trade addendum on it for the landlord to review + send. Best-effort,
      // post-commit: never affects the renewal's own completion.
      if (doc.renews_lease_id && leaseResult?.leaseId) {
        try {
          await autoDraftWorkTradeAddendumForRenewal(leaseResult.leaseId)
        } catch (e) {
          logger.error({ err: e }, '[LeaseRenewal][wt-addendum-autodraft-call]')
        }
      }

      // Stamp PDF
      let executedUrl: string | null = null
      try {
        if (doc.base_pdf_url) {
          const allFields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1', [doc.id])
          const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
          const sourcePdfPath = extractUploadFilename(doc.base_pdf_url)
          if (sourcePdfPath) {
          const sourcePath = path.join(uploadDir, sourcePdfPath)
          if (fs.existsSync(sourcePath)) {
            const executedFilename = 'executed-' + doc.id + '.pdf'
            const outputPath = path.join(uploadDir, executedFilename)
            const signerInfo = (allSigners as any[]).map(s => ({ name:s.name, email:s.email, role:s.role, signed_at:s.signed_at }))
            await stampPdf(sourcePath, (allFields as any[]).map(f => ({
              page: parseInt(f.page)||1, x: parseFloat(f.x)||0, y: parseFloat(f.y)||0,
              width: parseFloat(f.width)||100, height: parseFloat(f.height)||30,
              field_type: f.field_type, value: f.value, font_css: f.font_css
            })), signerInfo, outputPath)
            executedUrl = '/api/esign/files/' + executedFilename
            await query('UPDATE lease_documents SET executed_pdf_url=$1 WHERE id=$2', [executedUrl, doc.id])
          }
          }
        }
      } catch(e) { logger.error({ err: e }, '[ESIGN] PDF stamp failed:') }

      const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
      const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
      for (const s of allSigners as any[]) {
        await emailSigningCompleted(s.email, s.name, doc.title, unitLabel, executedUrl || undefined, undefined, { landlordId: doc.landlord_id, documentId: doc.id })
        await createNotification({
          userId: s.user_id,
          type: 'esign_completed',
          title: 'Document fully executed',
          body: `"${doc.title}" has been signed by all parties.`,
          data: { documentId: doc.id, leaseId: leaseResult?.leaseId || null },
          sendEmail: false
        })
      }

      res.json({ success: true, data: { completed: true, leaseId: leaseResult?.leaseId, leaseStatus: leaseResult?.status } })
    } else {
      const nextSigner = await queryOne<any>(`
        SELECT * FROM lease_document_signers
        WHERE document_id=$1 AND status='pending'
        ORDER BY order_index LIMIT 1`, [doc.id])
      if (nextSigner) {
        const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
        // S410 (S377): read tenant_invite_token (was email_verify_token).
        const nextSignerUser = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [nextSigner.user_id])
        const nextSigningUrl = signingUrlFor(nextSigner, doc.id, nextSignerUser)
        await emailSigningRequest(nextSigner.email, nextSigner.name, doc.title, unitLabel, doc.landlord_name, nextSigningUrl, { landlordId: doc.landlord_id, documentId: doc.id })
        await createNotification({
          userId: nextSigner.user_id,
          type: 'esign_request',
          title: 'Document ready to sign',
          body: `"${doc.title}" is awaiting your signature.`,
          data: { documentId: doc.id },
          sendEmail: false
        })
        await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE, invite_sent_at=NOW() WHERE id=$1", [nextSigner.id])
      }
      res.json({ success: true, data: { completed: false, nextSigner: nextSigner?.email } })
    }
  } catch (e) {
    if (!txnDone) {
      try { await client.query('ROLLBACK') } catch {}
    }
    next(e)
  } finally {
    client.release()
  }
})

// S234: signer-side decline. The schema's signer status enum has
// included 'declined' since the original migration but no path ever
// flipped a row to that state. Here it is. Semantics:
//   - Decline by ANY signer voids the entire document (one decline =
//     no point continuing the chain — the doc is dead). Mirrors the
//     existing auto-void on expiry.
//   - Reason is captured if provided (optional, max 1000 chars).
//   - Landlord gets an email with the reason + an in-app notification.
//   - Idempotent: re-clicking decline on an already-declined signer
//     row returns the existing decline state without firing another
//     notification.
esignRouter.post('/sign/:documentId/decline', requireAuth, async (req, res, next) => {
  const client = await getClient()
  try {
    const reason = req.body?.reason != null ? String(req.body.reason).trim().slice(0, 1000) : null

    await client.query('BEGIN')

    const signerRes = await client.query(
      `SELECT * FROM lease_document_signers WHERE document_id=$1 AND user_id=$2 FOR UPDATE`,
      [req.params.documentId, req.user!.userId])
    const signer = signerRes.rows[0]
    if (!signer) throw new AppError(403, 'You are not a signer on this document')
    if (signer.status === 'signed') throw new AppError(400, 'You have already signed this document')

    // Idempotent: already declined → return existing state.
    if (signer.status === 'declined') {
      await client.query('COMMIT')
      return res.json({
        success: true,
        data: {
          status: 'declined',
          declined_at: signer.declined_at,
          decline_reason: signer.decline_reason,
          alreadyDeclined: true,
        },
      })
    }

    const docRes = await client.query(
      `SELECT d.*, u.unit_number, p.name AS property_name,
              lu.id AS landlord_user_id,
              lu.first_name AS landlord_first, lu.last_name AS landlord_last,
              lu.email AS landlord_email
         FROM lease_documents d
         LEFT JOIN units u ON u.id = d.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         JOIN landlords la ON la.id = d.landlord_id
         JOIN users lu ON lu.id = la.user_id
        WHERE d.id = $1`,
      [signer.document_id])
    const doc = docRes.rows[0]
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'voided' || doc.status === 'execution_failed') {
      throw new AppError(400, `Document is already ${doc.status} — nothing to decline`)
    }

    await client.query(
      `UPDATE lease_document_signers
          SET status = 'declined',
              declined_at = NOW(),
              decline_reason = $1
        WHERE id = $2`,
      [reason, signer.id])

    await client.query(
      `UPDATE lease_documents SET status = 'voided', updated_at = NOW() WHERE id = $1`,
      [doc.id])

    // S29c-2-A: any pending lease/tenant rows tied to this document
    // need to be cascade-voided so the limbo state doesn't strand
    // tenants in /pending. Same helper the auto-void cron uses.
    try {
      await cascadeLeaseTenantsOnVoid(client.query.bind(client), { id: doc.id, document_type: doc.document_type })
    } catch (e) {
      logger.error({ err: e }, '[esign-decline] cascadeLeaseTenantsOnVoid failed:')
    }

    await client.query('COMMIT')

    // Notify the landlord. Email + in-app notification, both fire-and-
    // forget — webhook caller already got their 200 back at this point.
    const unitLabel = [doc.property_name, doc.unit_number ? `Unit ${doc.unit_number}` : null]
      .filter(Boolean).join(' · ') || 'Document'
    const landlordName = `${doc.landlord_first || ''} ${doc.landlord_last || ''}`.trim() || 'there'
    const signerName  = signer.name || (req.user!.email ?? 'A signer')

    const { emailDocumentDeclined } = await import('../services/email')
    emailDocumentDeclined(
      doc.landlord_email, landlordName, signerName, signer.role,
      doc.title || 'Lease document', unitLabel, reason,
      { landlordId: doc.landlord_id, documentId: doc.id },
    ).catch(e => logger.error({ err: e }, '[EMAIL] esign decline:'))

    createNotification({
      userId: doc.landlord_user_id,
      landlordId: doc.landlord_id,
      type: 'esign_document_declined',
      title: `${signerName} declined to sign`,
      body: `${signerName} (${signer.role}) declined "${doc.title || 'lease document'}". ` +
            (reason ? `Reason: ${reason}` : 'No reason provided.'),
      data: { documentId: doc.id, signerId: signer.id, decline_reason: reason },
    }).catch(e => logger.error({ err: e }, '[NOTIFY] esign decline:'))

    res.json({
      success: true,
      data: {
        status: 'declined',
        declined_at: new Date().toISOString(),
        decline_reason: reason,
        documentVoided: true,
      },
    })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    next(e)
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────
// PENDING QUEUES
// ─────────────────────────────────────────────────────────────

esignRouter.get('/pending', requireAuth, async (req, res, next) => {
  try {
    const pending = await query<any>(`
      SELECT d.id as document_id, s.role, s.status, d.title, d.base_pdf_url,
        u.unit_number, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = d.landlord_id
      JOIN users lu ON lu.id = l.user_id
      WHERE s.user_id = $1
        AND s.status IN ('sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [req.user!.userId])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})

esignRouter.get('/landlord-pending', requireAuth, requirePerm('leases.sign'), async (req, res, next) => {
  try {
    const landlordUser = await queryOne<any>('SELECT user_id FROM landlords WHERE id=$1', [req.user!.profileId])
    const pending = await query<any>(`
      SELECT d.id as document_id, s.status, s.name, d.title, d.status as doc_status,
        u.unit_number, p.name as property_name, d.base_pdf_url,
        (SELECT name FROM lease_document_signers WHERE document_id=d.id AND role='primary' LIMIT 1) as primary_tenant_name,
        (SELECT status FROM lease_document_signers WHERE document_id=d.id AND role='primary' LIMIT 1) as primary_tenant_status
      FROM lease_document_signers s
      JOIN lease_documents d ON d.id = s.document_id
      LEFT JOIN units u ON u.id = d.unit_id
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE d.landlord_id = $1
        AND s.user_id = $2
        AND s.status IN ('sent','viewed')
        AND d.status NOT IN ('completed','voided')
      ORDER BY s.created_at DESC`, [req.user!.profileId, landlordUser?.user_id])
    res.json({ success: true, data: pending })
  } catch(e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────────────────────

const uploadDir = path.join(process.cwd(), 'uploads', 'leases')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req: any, file: any, cb: any) => {
    // S394 fix: force .pdf extension based on MIME, NOT from attacker-
    // controlled originalname. Pre-fix, a caller could upload a file
    // with mimetype=application/pdf (passes fileFilter) and
    // originalname=evil.html, and the saved filename would carry the
    // .html extension. GET /files/:filename serves via res.sendFile
    // which auto-detects Content-Type from extension → text/html →
    // XSS in the authorized viewer's browser (signer or landlord).
    // Same class as the S380 avatar-upload finding.
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
    cb(null, unique + '.pdf')
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    if (file.mimetype === 'application/pdf') cb(null, true)
    else cb(new Error('PDF only'))
  }
})

esignRouter.post('/upload', requireAuth, requirePerm('leases.create'), upload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded')
    const fileUrl = '/api/esign/files/' + req.file.filename
    let pageCount = 1
    try {
      const fileBuffer = fs.readFileSync(req.file.path).toString('binary')
      const matches = fileBuffer.match(/\/Type\s*\/Page[^s]/g)
      if (matches) pageCount = matches.length
    } catch(e) { /* fallback to 1 */ }
    // S535: read the PDF's text for the landlord's property name/address —
    // lease forms usually carry it, and a unique match auto-locks the
    // template to that property in the create modal. Best-effort.
    const detectedProperty = await detectPropertyFromPdf(
      req.user!.profileId, fs.readFileSync(req.file.path))
    res.json({ success: true, data: { url: fileUrl, filename: req.file.originalname, size: req.file.size, pageCount, detectedProperty } })
  } catch (e) { next(e) }
})

esignRouter.get('/files/:filename', requireAuth, async (req: any, res: any, next: any) => {
  try {
    // Files live in uploads/leases (uploads + executed PDFs) OR
    // uploads/subleases (generated sublease agreements — see
    // services/subleaseDocuments.ts, which stores fileUrl as
    // '/api/esign/files/<filename>' but writes the bytes to the
    // subleases dir). Pre-S535 the subleases lookup was missing, so
    // every generated sublease agreement 404'd here before the auth
    // check ever ran.
    let filePath = resolveUploadPath(uploadDir, req.params.filename)
    if (!filePath) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(filePath)) {
      const subleasePath = resolveUploadPath(
        path.join(process.cwd(), 'uploads', 'subleases'), req.params.filename)
      if (subleasePath && fs.existsSync(subleasePath)) filePath = subleasePath
      else throw new AppError(404, 'File not found')
    }

    // Authorization (S535 rework): the caller must be the owning landlord
    // (or their team member — staff carry req.user.landlordId), OR a
    // signer on a document using this file. Files are matched against
    // lease_documents base/executed URLs AND lease_templates.base_pdf_url
    // — template PDFs previously had no auth path at all, so the
    // template-gallery preview of an uploaded template could never
    // render. Also fixed here: the old LIMIT 1 lookup checked only the
    // FIRST document row sharing a base_pdf_url, so a legitimate signer
    // on the second+ document drafted from the same template 403'd.
    const userId = req.user!.userId
    const profileId = req.user!.profileId
    const role = req.user!.role
    const filename = req.params.filename
    const urlSuffix = '/api/esign/files/' + filename
    const scopeLandlordId =
      role === 'landlord' ? profileId : (req.user!.landlordId ?? null)

    const exists = await queryOne<any>(`
      SELECT 1 FROM lease_documents WHERE base_pdf_url = $1 OR executed_pdf_url = $1
      UNION ALL
      SELECT 1 FROM lease_templates WHERE base_pdf_url = $1
      LIMIT 1`, [urlSuffix])
    if (!exists) throw new AppError(404, 'File not found')

    const authorized = await queryOne<any>(`
      SELECT 1 FROM lease_documents d
       WHERE (d.base_pdf_url = $1 OR d.executed_pdf_url = $1)
         AND (($2::uuid IS NOT NULL AND d.landlord_id = $2)
              OR EXISTS (SELECT 1 FROM lease_document_signers s
                          WHERE s.document_id = d.id AND s.user_id = $3))
      UNION ALL
      SELECT 1 FROM lease_templates t
       WHERE t.base_pdf_url = $1 AND $2::uuid IS NOT NULL AND t.landlord_id = $2
      LIMIT 1`, [urlSuffix, scopeLandlordId, userId])
    if (!authorized) throw new AppError(403, 'Not authorized to view this file')

    res.sendFile(filePath)
  } catch (e) { next(e) }
})

// ── S605 (Nic): DRAFT A HOUSEHOLD LEASE FROM THE UNIT TYPE'S TEMPLATE ────────
//
// Closes the invite → lease gap. Nic wanted the chain to run itself after one
// click, and to be built GENERICALLY: "the chain needs to look for that unit
// type's default lease template. When nothing is set, it can't fire, but you can
// build the structure so that as soon as I add a template it would fire."
//
// So this never asks WHICH template — it resolves the default for the unit's
// type and reports plainly when a landlord hasn't configured one. Landlords with
// templates get drafts today; landlords without get a message naming what to set
// up, and the same call starts working the moment they set it.
//
// Returns 200 with drafted:false rather than an error when no template exists:
// the invites DID go out and the accounts ARE real, so this is information about
// an optional next step, not a failure of the thing the landlord just did.
esignRouter.post('/draft-household', requirePerm('leases.create'), async (req, res, next) => {
  try {
    const body = z.object({
      unitId: z.string().uuid(),
      // Household order — first email is the primary resident.
      emails: z.array(z.string().email()).min(1).max(8),
    }).parse(req.body)

    const unit = await queryOne<any>(
      `SELECT u.id, p.landlord_id FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.id = $1`, [body.unitId])
    if (!unit) throw new AppError(404, 'Unit not found')
    if (!canManageLandlordResource(req.user, unit.landlord_id)) throw new AppError(403, 'Forbidden')

    const residents = await resolveHouseholdByEmail(unit.landlord_id, body.emails)
    if (!residents.length) {
      return res.json({ success: true, data: { drafted: false,
        reason: 'None of those residents have tenant accounts under this landlord yet.' } })
    }
    const result = await draftHouseholdLease({
      landlordId: unit.landlord_id, unitId: body.unitId, residents,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})
