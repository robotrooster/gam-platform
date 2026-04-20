import { Router } from 'express'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { stampPdf } from '../services/pdfStamp'
import { emailSigningRequest, emailSigningCompleted } from '../services/email'
import { createNotification } from '../services/notifications'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

export const esignRouter = Router()

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const LANDLORD_APP_URL = process.env.LANDLORD_APP_URL || 'http://localhost:3001'
const TENANT_APP_URL   = process.env.TENANT_APP_URL   || 'http://localhost:3002'

const LEASE_COLUMNS = [
  'tenant_name','tenant_email','landlord_name',
  'rent_amount','start_date','end_date',
  'security_deposit','rent_due_day',
  'late_fee_grace_days','late_fee_amount',
  'lease_type','auto_renew','auto_renew_mode',
  'notice_days_required','expiration_notice_days',
  'tenant_signature','landlord_signature',
  'tenant_initial','landlord_initial',
  'date_signed','custom_text'
]

// Signer roles: exactly one 'primary', zero-or-more 'co_tenant_N', at least one
// 'landlord', optional 'witness'. Template slots that aren't filled at document
// creation time get their fields pruned (see POST /documents).
const TENANT_ROLE_PATTERN = /^(primary|co_tenant_\d+)$/
function isTenantRole(role: string): boolean { return TENANT_ROLE_PATTERN.test(role) }

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

type Bucket = 'residential' | 'storage' | 'commercial'
function bucketFor(unitType: string): Bucket {
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
  documentType: 'original_lease' | 'addendum_add' | 'addendum_remove' | 'addendum_terms',
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
 * Execute an original_lease document: INSERT a new leases row + lease_tenants
 * rows for every tenant signer. Sets unit status to active if lease starts
 * today/past. Receives the already-open client — caller owns transaction.
 */
async function executeOriginalLease(client: any, doc: any): Promise<{ leaseId: string; status: string; primaryTenantId: string }> {
  if (!doc.unit_id) throw new AppError(400, 'Document has no unit — cannot build lease')

  // Read all field values mapped to lease columns
  const fields = await client.query(
    `SELECT lease_column, value, signer_role FROM lease_document_fields
     WHERE document_id=$1 AND lease_column IS NOT NULL`, [doc.id]).then(r => r.rows)
  const vals: Record<string, string | null> = {}
  for (const f of fields) {
    if (!f.lease_column) continue
    if (['tenant_signature','landlord_signature','tenant_initial','landlord_initial','date_signed','custom_text'].includes(f.lease_column)) continue
    vals[f.lease_column] = f.value
  }

  // Gather all tenant signers
  const tenantRows = await client.query(
    `SELECT s.id, s.user_id, s.role, s.name, s.email, s.order_index, t.id as tenant_id
     FROM lease_document_signers s
     JOIN users u ON u.id=s.user_id
     LEFT JOIN tenants t ON t.user_id=s.user_id
     WHERE s.document_id=$1
     ORDER BY s.order_index`, [doc.id]).then(r => r.rows)

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

  const leaseType = vals.lease_type || 'fixed_term'
  const autoRenew = vals.auto_renew === 'true' || vals.auto_renew === 'yes'
  const autoRenewMode = autoRenew ? (vals.auto_renew_mode || 'convert_to_month_to_month') : null

  // INSERT lease
  const lease = await client.query(`
    INSERT INTO leases (
      unit_id, landlord_id, status,
      start_date, end_date, rent_amount, rent_due_day,
      security_deposit, late_fee_grace_days, late_fee_amount,
      lease_type, auto_renew, auto_renew_mode,
      notice_days_required, expiration_notice_days,
      signed_by_landlord, signed_by_tenant, signed_at,
      needs_review
    ) VALUES (
      $1,$2,$3,
      $4,$5,$6,$7,
      $8,$9,$10,
      $11,$12,$13,
      $14,$15,
      TRUE, TRUE, NOW(),
      FALSE
    ) RETURNING id, status`,
    [
      doc.unit_id, doc.landlord_id, leaseStatus,
      startDate, vals.end_date || null, rentAmount, parseInt(vals.rent_due_day || '1'),
      vals.security_deposit || 0, parseInt(vals.late_fee_grace_days || '5'), vals.late_fee_amount || 15,
      leaseType, autoRenew, autoRenewMode,
      parseInt(vals.notice_days_required || '30'), parseInt(vals.expiration_notice_days || '60')
    ]).then(r => r.rows[0])

  // INSERT lease_tenants rows — one per signer, with per-tenant supersedes chain
  for (const t of tenantSigners) {
    const priorLt = await client.query(`
      SELECT id FROM lease_tenants
      WHERE tenant_id=$1 AND status='removed'
      ORDER BY removed_at DESC NULLS LAST, created_at DESC
      LIMIT 1`, [t.tenant_id]).then(r => r.rows[0])

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

  // If activating now, set unit status
  if (leaseStatus === 'active') {
    await client.query(
      `UPDATE units SET status='active', updated_at=NOW() WHERE id=$1`,
      [doc.unit_id])
  }

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
  if (lease.status === 'expired' || lease.status === 'terminated' || lease.status === 'voided') {
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

esignRouter.get('/templates', requireAuth, requireLandlord, async (req, res, next) => {
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

esignRouter.post('/templates', requireAuth, requireLandlord, async (req, res, next) => {
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

esignRouter.get('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')
    const fields = await query<any>('SELECT * FROM lease_template_fields WHERE template_id=$1 ORDER BY page, sort_order, y', [template.id])
    res.json({ success: true, data: { ...template, fields } })
  } catch (e) { next(e) }
})

esignRouter.patch('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
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

esignRouter.delete('/templates/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    await query('UPDATE lease_templates SET is_active=FALSE WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

esignRouter.put('/templates/:id/fields', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { fields } = req.body
    const template = await queryOne<any>('SELECT * FROM lease_templates WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!template) throw new AppError(404, 'Template not found')

    for (const f of (fields || [])) {
      if (f.leaseColumn && !LEASE_COLUMNS.includes(f.leaseColumn)) {
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

esignRouter.delete('/templates/:id/fields/:fieldId', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    await query('DELETE FROM lease_template_fields WHERE id=$1 AND template_id=$2', [req.params.fieldId, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────

esignRouter.get('/documents', requireAuth, requireLandlord, async (req, res, next) => {
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
esignRouter.get('/batches', requireAuth, requireLandlord, async (req, res, next) => {
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

esignRouter.post('/documents', requireAuth, requireLandlord, async (req, res, next) => {
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

    await client.query('BEGIN')

    const doc = await createDocumentRecord(client, {
      landlordId: req.user!.profileId,
      templateId: templateId || null,
      unitId: unitId || null,
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

esignRouter.post('/documents/addendum-add', requireAuth, requireLandlord, async (req, res, next) => {
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
    if (lease.landlord_id !== req.user!.profileId) throw new AppError(403, 'Not your lease')
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

esignRouter.post('/documents/addendum-remove', requireAuth, requireLandlord, async (req, res, next) => {
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
    if (lease.landlord_id !== req.user!.profileId) throw new AppError(403, 'Not your lease')
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

esignRouter.post('/documents/addendum-terms/batch', requireAuth, requireLandlord, async (req, res, next) => {
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

esignRouter.post('/documents/addendum-terms', requireAuth, requireLandlord, async (req, res, next) => {
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
    if (lease.landlord_id !== req.user!.profileId) throw new AppError(403, 'Not your lease')
    if (lease.status === 'expired' || lease.status === 'terminated' || lease.status === 'voided') {
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

esignRouter.post('/documents/:id/send', requireAuth, requireLandlord, async (req, res, next) => {
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
    const firstSigner = (signers as any[]).find(s => s.order_index === 1) || (signers as any[])[0]
    if (!firstSigner) throw new AppError(400, 'No signers configured')

    const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : (doc.title || 'GAM Document')

    // Branch signing URL: unactivated tenants land on /accept-invite first, then get redirected to /sign
    const firstSignerUser = await queryOne<any>('SELECT email_verified, email_verify_token FROM users WHERE id=$1', [firstSigner.user_id])
    const signingUrl = (firstSignerUser && !firstSignerUser.email_verified && firstSignerUser.email_verify_token)
      ? `${TENANT_APP_URL}/accept-invite?token=${firstSignerUser.email_verify_token}&next=${encodeURIComponent('/sign/' + doc.id)}`
      : `${TENANT_APP_URL}/sign/${doc.id}`

    await emailSigningRequest(firstSigner.email, firstSigner.name, doc.title, unitLabel, doc.landlord_name, signingUrl)
    await createNotification({
      userId: firstSigner.user_id,
      type: 'esign_request',
      title: 'Document ready to sign',
      body: `${doc.landlord_name} sent you "${doc.title}" for ${unitLabel}.`,
      data: { documentId: doc.id },
      sendEmail: false
    })

    await query("UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])
    await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE WHERE id=$1", [firstSigner.id])

    res.json({ success: true, data: { sentTo: firstSigner.email } })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// VOID
// ─────────────────────────────────────────────────────────────

esignRouter.post('/documents/:id/void', requireAuth, requireLandlord, async (req, res, next) => {
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
    if (doc.sent_at) throw new AppError(409, 'Cannot void a sent document — create a superseding document instead')

    // Cascade lease_tenants state by document_type
    switch (doc.document_type) {
      case 'addendum_add': {
        // The pending_add row (if any) becomes 'void' — preserves audit trail
        // that this tenant tried to join but the addendum was cancelled.
        // Leave add_document_id populated intentionally for auditability.
        await client.query(
          `UPDATE lease_tenants
             SET status='void', updated_at=NOW()
           WHERE add_document_id=$1 AND status='pending_add'`,
          [doc.id])
        break
      }
      case 'addendum_remove': {
        // The pending_remove row reverts to active. Null out remove_document_id
        // because the row returns to normal and should not carry a stale pointer.
        await client.query(
          `UPDATE lease_tenants
             SET status='active',
                 remove_document_id=NULL,
                 updated_at=NOW()
           WHERE remove_document_id=$1 AND status='pending_remove'`,
          [doc.id])
        break
      }
      case 'addendum_terms':
      case 'original_lease':
      default: {
        // No cascade needed. addendum_terms has no lease_tenants side effects.
        // original_lease creates lease_tenants only on execution (post-completion),
        // so voiding before completion means no rows exist to cascade.
        break
      }
    }

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
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, p.name as property_name, lu.first_name || ' ' || lu.last_name as landlord_name
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'voided') throw new AppError(400, 'Document has been voided')
    if (doc.status === 'completed') throw new AppError(400, 'Document fully executed')

    const fields = await query<any>(`
      SELECT * FROM lease_document_fields
      WHERE document_id=$1 AND signer_role=$2
      ORDER BY page, y`, [doc.id, signer.role])

    if (signer.status === 'sent') {
      await query("UPDATE lease_document_signers SET status='viewed', viewed_at=NOW() WHERE id=$1", [signer.id])
    }

    res.json({ success: true, data: { signer, document: doc, fields } })
  } catch (e) { next(e) }
})

esignRouter.post('/sign/:documentId', requireAuth, async (req, res, next) => {
  try {
    const { fieldValues } = req.body

    const signer = await queryOne<any>(`
      SELECT * FROM lease_document_signers
      WHERE document_id=$1 AND user_id=$2`,
      [req.params.documentId, req.user!.userId])
    if (!signer) throw new AppError(403, 'You are not a signer on this document')
    if (signer.status === 'signed') throw new AppError(400, 'Already signed')

    // Platform block check on tenant roles
    if (isTenantRole(signer.role)) {
      const blk = await checkPlatformBlock(req.user!.userId)
      if (!blk.ok) throw new AppError(403, blk.reason || 'Account blocked from signing')
    }

    const doc = await queryOne<any>(`
      SELECT d.*, u.unit_number, u.unit_type, p.name as property_name,
        lu.first_name || ' ' || lu.last_name as landlord_name, lu.email as landlord_email
      FROM lease_documents d
      LEFT JOIN units u ON u.id=d.unit_id LEFT JOIN properties p ON p.id=u.property_id
      JOIN landlords la ON la.id=d.landlord_id JOIN users lu ON lu.id=la.user_id
      WHERE d.id=$1`, [signer.document_id])
    if (!doc) throw new AppError(404, 'Document not found')
    if (doc.status === 'voided') throw new AppError(400, 'Document has been voided')

    // Re-check overlap on EVERY signing (another roommate may have taken a conflicting lease
    // between send time and now)
    const { primary, coTenants } = await getDocumentTenantSigners(doc.id)
    if (primary && doc.unit_id) {
      const vals = await query<any>(`
        SELECT lease_column, value FROM lease_document_fields
        WHERE document_id=$1 AND lease_column IN ('start_date','end_date') AND value IS NOT NULL`, [doc.id])
      const startVal = (vals as any[]).find(v => v.lease_column === 'start_date')?.value
      const endVal   = (vals as any[]).find(v => v.lease_column === 'end_date')?.value
      if (startVal) {
        const allTenantIds = [primary.tenantId, ...coTenants.map(c => c.tenantId)]
        const ov = await canTenantsSignNewLease(allTenantIds, doc.unit_id, startVal, endVal || null)
        if (!ov.ok) throw new AppError(409, ov.reason || 'Lease overlap detected')
      }
    }

    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress
    const ua = req.headers['user-agent']

    for (const fv of (fieldValues || [])) {
      await query(`
        UPDATE lease_document_fields
        SET value=$1, signed_at=NOW(), signer_id=$2
        WHERE id=$3 AND document_id=$4`,
        [fv.value, signer.id, fv.fieldId, doc.id])
    }

    await query(`
      UPDATE lease_document_signers
      SET status='signed', signed_at=NOW(), ip_address=$1, user_agent=$2
      WHERE id=$3`,
      [ip, ua, signer.id])

    await query("UPDATE lease_documents SET status='in_progress', updated_at=NOW() WHERE id=$1", [doc.id])

    const remaining = await queryOne<any>(
      "SELECT COUNT(*)::int as count FROM lease_document_signers WHERE document_id=$1 AND status != 'signed'",
      [doc.id])

    if (remaining?.count === 0) {
      await query("UPDATE lease_documents SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1", [doc.id])

      let leaseResult: { leaseId: string; status: string; primaryTenantId: string } | null = null
      try {
        leaseResult = await buildLeaseFromDocument(doc.id)
      } catch (e: any) {
        console.error('[ESIGN] buildLeaseFromDocument failed:', e.message)
        await query("UPDATE lease_documents SET void_reason=$1 WHERE id=$2",
          [`Lease build failed: ${e.message}`, doc.id])
      }

      // Stamp PDF
      let executedUrl: string | null = null
      try {
        if (doc.base_pdf_url) {
          const allFields = await query<any>('SELECT * FROM lease_document_fields WHERE document_id=$1', [doc.id])
          const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
          const sourcePdfPath = doc.base_pdf_url.split('/').pop()
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
      } catch(e) { console.error('[ESIGN] PDF stamp failed:', e) }

      const allSigners = await query<any>('SELECT * FROM lease_document_signers WHERE document_id=$1', [doc.id])
      const unitLabel = doc.unit_number ? `Unit ${doc.unit_number} — ${doc.property_name}` : doc.title
      for (const s of allSigners as any[]) {
        await emailSigningCompleted(s.email, s.name, doc.title, unitLabel, executedUrl || undefined)
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
        const nextSignerUser = await queryOne<any>('SELECT email_verified, email_verify_token FROM users WHERE id=$1', [nextSigner.user_id])
        const nextSigningUrl = (nextSignerUser && !nextSignerUser.email_verified && nextSignerUser.email_verify_token)
          ? `${TENANT_APP_URL}/accept-invite?token=${nextSignerUser.email_verify_token}&next=${encodeURIComponent('/sign/' + doc.id)}`
          : signingUrl
        await emailSigningRequest(nextSigner.email, nextSigner.name, doc.title, unitLabel, doc.landlord_name, nextSigningUrl)
        await createNotification({
          userId: nextSigner.user_id,
          type: 'esign_request',
          title: 'Document ready to sign',
          body: `"${doc.title}" is awaiting your signature.`,
          data: { documentId: doc.id },
          sendEmail: false
        })
        await query("UPDATE lease_document_signers SET status='sent', invite_sent=TRUE WHERE id=$1", [nextSigner.id])
      }
      res.json({ success: true, data: { completed: false, nextSigner: nextSigner?.email } })
    }
  } catch (e) { next(e) }
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

esignRouter.get('/landlord-pending', requireAuth, requireLandlord, async (req, res, next) => {
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
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2)
    cb(null, unique + path.extname(file.originalname))
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

esignRouter.post('/upload', requireAuth, requireLandlord, upload.single('file'), async (req: any, res: any, next: any) => {
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

esignRouter.get('/files/:filename', async (req: any, res: any, next: any) => {
  try {
    const filePath = path.join(uploadDir, req.params.filename)
    if (!fs.existsSync(filePath)) throw new AppError(404, 'File not found')
    res.sendFile(filePath)
  } catch (e) { next(e) }
})
