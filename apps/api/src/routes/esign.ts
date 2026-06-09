import { Router } from 'express'
import { extractUploadFilename, resolveUploadPath } from '../lib/uploadPaths'
import { cascadeLeaseTenantsOnVoid } from '../lib/leaseDocCascade'
import {
  LeaseDocumentType,
  UnitType,
  LeaseColumn,
  LeaseColumnVals,
  LEASE_COLUMN_CATEGORY,
  LEASE_COLUMN_LABEL,
  WRITABLE_LEASE_COLUMN_SPECS,
  FEE_ROW_SPECS,
  UTILITY_ROW_SPECS,
  validateLeaseDocumentForSend,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { generateMoveInInvoice } from '../jobs/moveInBundle'
import { requireAuth, requirePerm } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { stampPdf } from '../services/pdfStamp'
import { createAdminNotification } from '../services/adminNotifications'
import { emailSigningRequest, emailSigningCompleted } from '../services/email'
import { createNotification } from '../services/notifications'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { logger } from '../lib/logger'

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
  const newUnit = await queryOne<any>('SELECT unit_type FROM units WHERE id=$1', [newUnitId])
  if (!newUnit) return { ok: false, reason: 'Unit not found' }
  const newBucket = bucketFor(newUnit.unit_type)

  for (const tenantId of tenantIds) {
    const actives = await query<any>(`
      SELECT l.id, l.start_date, l.end_date, u.unit_type, u.unit_number,
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
async function createDocumentRecord(client: any, opts: {
  landlordId: string,
  templateId: string | null,
  unitId: string | null,
  leaseId: string | null,
  title: string,
  basePdfUrl: string | null,
  documentType: LeaseDocumentType,
  targetLeaseTenantId: string | null,
  promoteLeaseTenantId: string | null,
  signers: Array<{ userId: string, role: string, name: string, email: string, phone?: string | null, orderIndex?: number }>
}): Promise<any> {
  // INSERT lease_documents — includes document_type and addendum-specific FKs
  const doc = await client.query(`
    INSERT INTO lease_documents (
      template_id, landlord_id, unit_id, lease_id,
      title, base_pdf_url,
      document_type, target_lease_tenant_id, promote_lease_tenant_id
    ) VALUES ($1,$2,$3,$4, $5,$6, $7,$8,$9)
    RETURNING *`,
    [
      opts.templateId, opts.landlordId, opts.unitId, opts.leaseId,
      opts.title, opts.basePdfUrl,
      opts.documentType, opts.targetLeaseTenantId, opts.promoteLeaseTenantId
    ]).then((r: any) => r.rows[0])

  // INSERT signers
  for (const s of opts.signers) {
    const token = crypto.randomBytes(32).toString('hex')
    await client.query(`
      INSERT INTO lease_document_signers
        (document_id, user_id, role, name, email, phone, order_index, token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, s.userId, s.role, s.name, s.email, s.phone || null, s.orderIndex || 1, token])
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
           page, x, y, width, height, required, font_css, value)
        VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14,$15)`,
        [doc.id, f.id, signer?.id || null, f.field_type, f.signer_role, f.label, f.lease_column,
         f.page, f.x, f.y, f.width, f.height, f.required, f.font_css, prefill])
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

async function buildLeaseFromDocument(documentId: string): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const doc = await client.query(
      `SELECT d.*, u.unit_type
       FROM lease_documents d LEFT JOIN units u ON u.id = d.unit_id
       WHERE d.id=$1`, [documentId]).then(r => r.rows[0])
    if (!doc) throw new AppError(404, 'Document not found')

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

    await client.query('COMMIT')
    return result
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
  for (const f of fields) {
    const col = f.lease_column as LeaseColumn | null
    if (!col) continue
    if (!(col in LEASE_COLUMN_CATEGORY)) continue
    const cat = LEASE_COLUMN_CATEGORY[col]
    if (cat === 'identity' || cat === 'signature') continue
    if (f.value == null) continue
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

esignRouter.get('/templates', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const templates = await query<any>(`
      SELECT t.*, COUNT(f.id)::int as field_count
      FROM lease_templates t
      LEFT JOIN lease_template_fields f ON f.template_id = t.id
      WHERE t.landlord_id = $1 AND t.is_active = TRUE
      GROUP BY t.id ORDER BY t.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: templates })
  } catch (e) { next(e) }
})

esignRouter.post('/templates', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount } = req.body
    if (!name) throw new AppError(400, 'Template name required')
    const t = await queryOne<any>(`
      INSERT INTO lease_templates (landlord_id, name, description, base_pdf_url, page_count)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.profileId, name, description||null, basePdfUrl||null, pageCount||1])
    res.status(201).json({ success: true, data: t })
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

esignRouter.patch('/templates/:id', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { name, description, basePdfUrl, pageCount, isActive } = req.body
    const t = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!t) throw new AppError(404, 'Template not found')
    const updated = await queryOne<any>(`
      UPDATE lease_templates SET name=$1, description=$2, base_pdf_url=$3, page_count=$4, is_active=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *`,
      [name??t.name, description??t.description, basePdfUrl??t.base_pdf_url, pageCount??t.page_count, isActive??t.is_active, t.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    await query('UPDATE lease_templates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

esignRouter.put('/templates/:id/fields', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
  try {
    const { fields } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')

    for (const f of (fields || [])) {
      if (f.leaseColumn && !(f.leaseColumn in LEASE_COLUMN_CATEGORY)) {
        throw new AppError(400, `Invalid lease_column: ${f.leaseColumn}`)
      }
      if (f.signerRole && !(f.signerRole === 'landlord' || f.signerRole === 'witness' || isTenantRole(f.signerRole))) {
        throw new AppError(400, `Invalid signer_role: ${f.signerRole}`)
      }
    }

    await query('DELETE FROM lease_template_fields WHERE template_id=$1', [template.id])
    for (const f of (fields || [])) {
      await query(`INSERT INTO lease_template_fields
        (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, sort_order, font_css)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [template.id, f.fieldType, f.signerRole, f.label||null, f.leaseColumn||null,
         f.page||1, f.x, f.y, f.width||200, f.height||50, f.required??true, f.sortOrder||0, f.fontCss||null])
    }
    const updated = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order', [template.id])
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

esignRouter.delete('/templates/:id/fields/:fieldId', requireAuth, requirePerm('leases.create'), async (req, res, next) => {
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
    const { templateId, unitId, title, signers, basePdfUrl, prefillValues } = req.body
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
    if (templateId) {
      const tmpl = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [templateId, req.user!.profileId])
      if (!tmpl) throw new AppError(404, 'Template not found')
      pdfUrl = pdfUrl || tmpl.base_pdf_url
    }

    // Unit resolver — if the template binds unit_number and the landlord filled
    // it in the Document Values form, match against this landlord's units. On
    // success, override any unitId that came from the tenant-lookup fallback.
    const resolvedUnitId = await resolveUnitFromPrefill(req.user!.profileId, prefillValues || {})
    const finalUnitId = resolvedUnitId || unitId || null

    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: finalUnitId,
      leaseId: null,
      title,
      basePdfUrl: pdfUrl || null,
      documentType: 'original_lease',
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers,
      prefillValues: prefillValues || {}
    } as any)

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
    const { leaseId, templateId, title, signers, basePdfUrl } = req.body
    if (!leaseId) throw new AppError(400, 'leaseId required for addendum_terms')
    if (!title || !signers?.length) throw new AppError(400, 'title and signers required')

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

    // 2. Current active roster — every active tenant must sign a terms change
    const currentRoster = await query<any>(`
      SELECT lt.id as lt_id, lt.tenant_id, t.user_id
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      WHERE lt.lease_id=$1 AND lt.status='active'`,
      [leaseId])
    const rosterRows = currentRoster as any[]
    if (rosterRows.length === 0) {
      throw new AppError(500, 'Lease has no active tenants — data integrity issue')
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
    if (tenantSigners.length === 0) throw new AppError(400, 'At least one tenant signer required')

    // 5. Signer composition — all current active tenants must sign, no outsiders
    const signerUserIds = new Set(tenantSigners.map(t => t.userId))
    for (const r of rosterRows) {
      if (!signerUserIds.has(r.user_id)) {
        throw new AppError(400, `Current tenant (user ${r.user_id}) must sign terms addendum — all active tenants sign rule changes`)
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

    await client.query('COMMIT')
    res.status(201).json({ success: true, data: doc })
  } catch (e) {
    await client.query('ROLLBACK')
    next(e)
  } finally {
    client.release()
  }
})

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

esignRouter.post('/documents/:id/send', requireAuth, requirePerm('leases.sign'), async (req, res, next) => {
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
        const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startVal, endVal || null)
        if (!ov.ok) throw new AppError(409, `Cannot send: ${ov.reason}`)
      }
    }

    const signers = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index', [doc.id])

    // ────────────────────────────────────────────────────────────────────────
    // S28: Landlord-first signer check.
    // Landlord fills the writable/fee/utility values during template completion
    // and signs first to lock the inputs. Tenants then sign accepting those
    // values. If a tenant signed first, they would either sign blank fields
    // or the landlord could alter values after acceptance — both unacceptable.
    // ────────────────────────────────────────────────────────────────────────
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

    // ────────────────────────────────────────────────────────────────────────
    // S28: Every tagged value-bearing field must be filled before send.
    // Categories writable / fee_row / utility_row carry contractual data
    // entered by the landlord. Identity fills from system data at render
    // time; signature fills at sign time — both exempt.
    // ────────────────────────────────────────────────────────────────────────
    const fieldRows = await query<{ lease_column: LeaseColumn | null; value: string | null }>(
      'SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1',
      [doc.id]
    )
    const violations = validateLeaseDocumentForSend(fieldRows as any)
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
    const signingUrl = (firstSignerUser && !firstSignerUser.email_verified && firstSignerUser.tenant_invite_token)
      ? `${TENANT_APP_URL}/accept-invite?token=${firstSignerUser.tenant_invite_token}&next=${encodeURIComponent('/sign/' + doc.id)}`
      : `${TENANT_APP_URL}/sign/${doc.id}`

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

esignRouter.post('/documents/:id/void', requireAuth, requirePerm('leases.terminate'), async (req, res, next) => {
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

    // S29 item 6: Allow voiding sent-but-unsigned docs (typo recall, mistakes
    // before any party has signed). Lock voiding once ANY signer has signed —
    // at that point the legally clean path is to create a superseding document.
    // This also unblocks voiding execution_failed docs so landlords can clear
    // them from their dashboard while admin investigates.
    const anySigned = await queryOne<any>(
      "SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND signed_at IS NOT NULL LIMIT 1",
      [doc.id])
    if (anySigned) throw new AppError(409, 'Cannot void after signing has begun — create a superseding document instead')

    // Cascade lease_tenants state by document_type
    await cascadeLeaseTenantsOnVoid(client.query.bind(client), doc)

    await client.query(
      "UPDATE lease_documents SET status='voided', voided_at=NOW(), void_reason=$1, updated_at=NOW() WHERE id=$2",
      [reason || null, doc.id])

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

    res.json({ success: true, data: { signer, document: doc, fields, deposit_interest_context, readOnly } })
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
        const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startVal, endVal || null)
        if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')
      }
    }

    // S29 item 3: Server-side required-field validation. Frontend gates on this
    // but malicious clients can bypass the gate. Verify every required field
    // assigned to this signer's role will have a non-empty value after this
    // submission completes (either submitted now or already in the DB).
    const requiredFieldsRes = await client.query(`
      SELECT id, label, field_type, value
      FROM lease_document_fields
      WHERE document_id=$1 AND signer_role=$2 AND required=TRUE`,
      [doc.id, signer.role])
    const requiredFields = requiredFieldsRes.rows
    const submittedById = new Map<string, string>()
    for (const fv of (fieldValues || [])) {
      if (fv.value != null && String(fv.value).trim() !== '') {
        submittedById.set(fv.fieldId, String(fv.value))
      }
    }
    const missingRequired: string[] = []
    for (const f of (requiredFields as any[])) {
      const submitted = submittedById.get(f.id)
      const existing = (f.value != null && String(f.value).trim() !== '') ? f.value : null
      if (!submitted && !existing) {
        missingRequired.push(f.label || `${f.field_type} field`)
      }
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
      let leaseResult: { leaseId: string; status: string; primaryTenantId: string } | null = null
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

      // S119 post-commit: fire Stripe Transfer for any PM company leasing
      // fee that landed on the ledger as a ghost. Only fires when the
      // property is contracted to a PM company with leasing_fee_amount > 0.
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

      await query("UPDATE lease_documents SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])

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
        const signingUrl = `${TENANT_APP_URL}/sign/${doc.id}`
        // S410 (S377): read tenant_invite_token (was email_verify_token).
        const nextSignerUser = await queryOne<any>('SELECT email_verified, tenant_invite_token FROM users WHERE id=$1', [nextSigner.user_id])
        const nextSigningUrl = (nextSignerUser && !nextSignerUser.email_verified && nextSignerUser.tenant_invite_token)
          ? `${TENANT_APP_URL}/accept-invite?token=${nextSignerUser.tenant_invite_token}&next=${encodeURIComponent('/sign/' + doc.id)}`
          : signingUrl
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
    res.json({ success: true, data: { url: fileUrl, filename: req.file.originalname, size: req.file.size, pageCount } })
  } catch (e) { next(e) }
})

esignRouter.get('/files/:filename', requireAuth, async (req: any, res: any, next: any) => {
  try {
    const filePath = resolveUploadPath(uploadDir, req.params.filename)
    if (!filePath) throw new AppError(400, 'Invalid filename')
    if (!fs.existsSync(filePath)) throw new AppError(404, 'File not found')

    // Authorization: caller must be the landlord on the document OR a signer.
    // Match the requested filename against either base_pdf_url or executed_pdf_url
    // (URLs are stored as '/api/esign/files/<filename>' so we match on suffix).
    const userId = req.user!.userId
    const profileId = req.user!.profileId
    const role = req.user!.role
    const filename = req.params.filename
    const urlSuffix = '/api/esign/files/' + filename

    const doc = await queryOne<any>(`
      SELECT id, landlord_id
      FROM lease_documents
      WHERE base_pdf_url = $1 OR executed_pdf_url = $1
      LIMIT 1`, [urlSuffix])

    if (!doc) throw new AppError(404, 'File not found')

    let authorized = false
    if (role === 'landlord' && profileId && doc.landlord_id === profileId) {
      authorized = true
    }
    if (!authorized) {
      const signer = await queryOne<any>(
        'SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND user_id=$2 LIMIT 1',
        [doc.id, userId])
      if (signer) authorized = true
    }
    if (!authorized) throw new AppError(403, 'Not authorized to view this file')

    res.sendFile(filePath)
  } catch (e) { next(e) }
})
