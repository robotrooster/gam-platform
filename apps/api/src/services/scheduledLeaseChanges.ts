/**
 * S581 (Nic): scheduled money changes carried by a signed terms addendum.
 *
 * A terms addendum can now carry money that reaches billing on a landlord-set
 * date (Nic — auto-apply on the date):
 *   - 'recurring_fee'  — a NEW monthly charge the tenant opted into (parking spot,
 *                        garage, storage). Base rent unchanged. Applied by creating
 *                        the monthly_ongoing lease_fees row on the effective date.
 *   - 'rent'           — a base-rent change (e.g. AZ mobile-home space rent, raised
 *                        with a landlord-set notice window; the addendum is the
 *                        notice). Applied by updating leases.rent_amount on the date.
 *
 * Lifecycle: createDraft (at addendum draft) -> activate (both signers complete,
 * from executeAddendumTerms) -> applyDue (nightly job, once effective_date arrives)
 * -> applied. A voided addendum cancels its still-pending changes.
 *
 * Existing billing needs NO change: it reads leases.rent_amount + monthly_ongoing
 * lease_fees, so once the job writes those, the next invoice cycle picks them up.
 */
import type { PoolClient } from 'pg'
import { query, getClient } from '../db'
import { logger } from '../lib/logger'

export type ScheduledChangeType = 'rent' | 'recurring_fee'

export interface DraftScheduledChange {
  changeType:     ScheduledChangeType
  effectiveDate:  string            // 'YYYY-MM-DD' — landlord-set
  newRentAmount?: number            // change_type='rent'
  feeType?:       string            // change_type='recurring_fee'
  feeAmount?:     number
  feeDescription?: string | null
}

/**
 * Insert a DRAFT scheduled change tied to an addendum document (created while the
 * addendum is being drafted; activated when both parties sign). Runs on the
 * caller's transaction so it lands atomically with the document + its fields.
 */
export async function createDraftScheduledChange(
  client: PoolClient,
  leaseId: string,
  sourceDocumentId: string,
  c: DraftScheduledChange,
): Promise<string> {
  if (c.changeType === 'rent') {
    if (c.newRentAmount == null || !(c.newRentAmount >= 0)) {
      throw new Error('rent change requires a non-negative newRentAmount')
    }
  } else {
    if (c.feeAmount == null || !(c.feeAmount >= 0) || !c.feeType) {
      throw new Error('recurring_fee change requires feeType + a non-negative feeAmount')
    }
  }
  const r = await client.query<{ id: string }>(
    `INSERT INTO scheduled_lease_changes
       (lease_id, source_document_id, change_type, effective_date,
        new_rent_amount, fee_type, fee_amount, fee_description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
     RETURNING id`,
    [
      leaseId, sourceDocumentId, c.changeType, c.effectiveDate,
      c.changeType === 'rent' ? c.newRentAmount : null,
      c.changeType === 'recurring_fee' ? c.feeType : null,
      c.changeType === 'recurring_fee' ? c.feeAmount : null,
      c.changeType === 'recurring_fee' ? (c.feeDescription ?? null) : null,
    ],
  )
  return r.rows[0].id
}

/**
 * Both parties signed the addendum — promote its draft changes to 'scheduled' so
 * the nightly job will apply them on/after the effective date. Runs on the
 * completion transaction (executeAddendumTerms).
 */
export async function activateScheduledChangesForDocument(
  client: PoolClient,
  documentId: string,
): Promise<number> {
  const r = await client.query(
    `UPDATE scheduled_lease_changes
        SET status = 'scheduled', updated_at = NOW()
      WHERE source_document_id = $1 AND status = 'draft'`,
    [documentId],
  )
  return r.rowCount ?? 0
}

/**
 * The addendum was voided (or never completes) — cancel its still-pending changes
 * so the job never applies a change the parties didn't finish agreeing to. Safe to
 * call on any document. Applied changes are left alone (already in billing).
 */
export async function cancelScheduledChangesForDocument(documentId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE scheduled_lease_changes
        SET status = 'cancelled', updated_at = NOW()
      WHERE source_document_id = $1 AND status IN ('draft', 'scheduled')
      RETURNING id`,
    [documentId],
  )
  return rows.length
}

// Tenant-facing labels for a recurring fee (no raw enums in tenant copy).
const RECURRING_FEE_LABEL: Record<string, string> = {
  pet_rent: 'pet rent', parking_rent: 'parking', storage_rent: 'storage',
  amenity_fee_monthly: 'amenity', trash_fee: 'trash', pest_control_fee: 'pest control',
  technology_fee: 'technology', other_fee: 'monthly charge',
}

/**
 * S581: a NOTICE addendum has no tenant signature — instead each active tenant
 * gets a blocking portal notice to view + acknowledge (proof of notice). Builds
 * one per active tenant from the money change(s) this addendum carries. Runs on
 * the completion transaction, after the changes were activated to 'scheduled'.
 */
export async function createLeaseNoticesForDocument(
  client: PoolClient,
  documentId: string,
  leaseId: string,
): Promise<number> {
  const doc = await client.query<{ title: string }>(
    `SELECT title FROM lease_documents WHERE id = $1`, [documentId],
  ).then(r => r.rows[0])
  const changes = await client.query<any>(
    `SELECT change_type, effective_date::text AS effective_date,
            new_rent_amount::text AS new_rent_amount,
            fee_type, fee_amount::text AS fee_amount, fee_description
       FROM scheduled_lease_changes
      WHERE source_document_id = $1 AND status IN ('scheduled', 'applied')
      ORDER BY effective_date ASC`, [documentId],
  ).then(r => r.rows)

  const lines = changes.map((c: any) => c.change_type === 'rent'
    ? `Your rent will change to $${Number(c.new_rent_amount).toFixed(2)} effective ${c.effective_date}.`
    : `A new monthly charge of $${Number(c.fee_amount).toFixed(2)} for ${c.fee_description || RECURRING_FEE_LABEL[c.fee_type] || 'a lease charge'} begins ${c.effective_date}.`)
  const body = lines.length
    ? lines.join(' ')
    : `${doc?.title ?? 'Your landlord has issued a notice regarding your lease.'}`
  const effectiveDate = changes.length ? changes[0].effective_date : null
  const title = doc?.title || 'Lease notice'

  const tenants = await client.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM lease_tenants WHERE lease_id = $1 AND status = 'active'`,
    [leaseId],
  ).then(r => r.rows)

  let n = 0
  for (const t of tenants) {
    await client.query(
      `INSERT INTO lease_notices (lease_id, tenant_id, source_document_id, title, body, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [leaseId, t.tenant_id, documentId, title, body, effectiveDate],
    )
    n++
  }
  return n
}

export interface ApplyResult {
  applied:   number
  cancelled: number
}

/**
 * Nightly job: apply every scheduled change whose effective_date has arrived.
 *   - rent          -> leases.rent_amount := new_rent_amount
 *   - recurring_fee -> INSERT a monthly_ongoing lease_fees row
 * Each change is claimed + applied in its own transaction (FOR UPDATE + status
 * re-check), so re-runs and overlapping ticks never double-apply. A change whose
 * lease ended before its date is cancelled (moot). Existing billing then bills the
 * new figure from the next cycle — nothing else to touch.
 */
export async function applyDueScheduledChanges(nowUtc: Date = new Date()): Promise<ApplyResult> {
  const today = nowUtc.toISOString().slice(0, 10)
  const due = await query<{ id: string }>(
    `SELECT id FROM scheduled_lease_changes
      WHERE status = 'scheduled' AND effective_date <= $1
      ORDER BY effective_date ASC, created_at ASC`,
    [today],
  )
  let applied = 0
  let cancelled = 0

  for (const { id } of due) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const row = await client.query<any>(
        `SELECT * FROM scheduled_lease_changes WHERE id = $1 AND status = 'scheduled' FOR UPDATE`,
        [id],
      ).then(r => r.rows[0])
      if (!row) { await client.query('ROLLBACK'); continue }   // already claimed by another tick

      const lease = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM leases WHERE id = $1`, [row.lease_id],
      ).then(r => r.rows[0])
      // Lease ended before the change took effect → the change is moot; cancel it.
      if (!lease || lease.status === 'terminated' || lease.status === 'expired') {
        await client.query(
          `UPDATE scheduled_lease_changes SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [id])
        await client.query('COMMIT')
        cancelled++
        continue
      }

      if (row.change_type === 'rent') {
        await client.query(
          `UPDATE leases SET rent_amount = $2, updated_at = NOW() WHERE id = $1`,
          [row.lease_id, row.new_rent_amount])
        await client.query(
          `UPDATE scheduled_lease_changes SET status = 'applied', applied_at = NOW(), updated_at = NOW() WHERE id = $1`, [id])
      } else {
        const fee = await client.query<{ id: string }>(
          `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, description)
           VALUES ($1, $2, $3, 'monthly_ongoing', FALSE, $4) RETURNING id`,
          [row.lease_id, row.fee_type, row.fee_amount, row.fee_description ?? null])
        await client.query(
          `UPDATE scheduled_lease_changes
              SET status = 'applied', applied_at = NOW(), applied_lease_fee_id = $2, updated_at = NOW()
            WHERE id = $1`, [id, fee.rows[0].id])
      }
      await client.query('COMMIT')
      applied++
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      logger.error({ err: e, scheduledChangeId: id }, '[scheduled-lease-change] apply failed')
    } finally {
      client.release()
    }
  }

  if (applied > 0 || cancelled > 0) {
    logger.info({ applied, cancelled }, '[scheduled-lease-change] daily apply complete')
  }
  return { applied, cancelled }
}
