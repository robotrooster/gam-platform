/**
 * S581 (Nic): scheduled money changes carried by a signed terms addendum reach
 * billing on the landlord-set effective date.
 *   - rent          → leases.rent_amount updated on the date
 *   - recurring_fee → a monthly_ongoing lease_fees row created on the date
 * Guarantees under test: applies only on/after the effective date, only 'scheduled'
 * rows, once (idempotent), and never onto a lease that ended first.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  applyDueScheduledChanges, activateScheduledChangesForDocument, createLeaseNoticesForDocument,
} from './scheduledLeaseChanges'

beforeEach(async () => { await cleanupAllSchema() })

async function seedLeaseCtx(rent = 1000): Promise<{ leaseId: string; unitId: string }> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: rent, status: 'active' })
    await c.query('COMMIT')
    return { leaseId, unitId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function insertChange(leaseId: string, o: {
  changeType: 'rent' | 'recurring_fee'
  effectiveDate: string
  status?: string
  newRentAmount?: number
  feeType?: string
  feeAmount?: number
  feeDescription?: string
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO scheduled_lease_changes
       (lease_id, change_type, effective_date, status,
        new_rent_amount, fee_type, fee_amount, fee_description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [leaseId, o.changeType, o.effectiveDate, o.status ?? 'scheduled',
     o.newRentAmount ?? null, o.feeType ?? null, o.feeAmount ?? null, o.feeDescription ?? null])
  return r.rows[0].id
}

const NOW = new Date('2026-06-15T12:00:00Z')   // "today" = 2026-06-15

describe('applyDueScheduledChanges', () => {
  it('rent change effective today → updates lease rent, marks applied', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    const id = await insertChange(leaseId, { changeType: 'rent', effectiveDate: '2026-06-15', newRentAmount: 1250 })

    const res = await applyDueScheduledChanges(NOW)
    expect(res.applied).toBe(1)

    const lease = await db.query<{ rent_amount: string }>(`SELECT rent_amount FROM leases WHERE id=$1`, [leaseId])
    expect(Number(lease.rows[0].rent_amount)).toBe(1250)
    const ch = await db.query<{ status: string }>(`SELECT status FROM scheduled_lease_changes WHERE id=$1`, [id])
    expect(ch.rows[0].status).toBe('applied')
  })

  it('recurring fee effective today → creates a monthly_ongoing lease_fee, links it', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    const id = await insertChange(leaseId, {
      changeType: 'recurring_fee', effectiveDate: '2026-06-15',
      feeType: 'parking_rent', feeAmount: 50, feeDescription: 'Reserved spot #12',
    })

    const res = await applyDueScheduledChanges(NOW)
    expect(res.applied).toBe(1)

    const fee = await db.query<any>(
      `SELECT fee_type, amount, due_timing FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(fee.rows).toHaveLength(1)
    expect(fee.rows[0].fee_type).toBe('parking_rent')
    expect(Number(fee.rows[0].amount)).toBe(50)
    expect(fee.rows[0].due_timing).toBe('monthly_ongoing')
    // base rent untouched
    const lease = await db.query<{ rent_amount: string }>(`SELECT rent_amount FROM leases WHERE id=$1`, [leaseId])
    expect(Number(lease.rows[0].rent_amount)).toBe(1000)
    const feeId = (await db.query<{ id: string }>(`SELECT id FROM lease_fees WHERE lease_id=$1`, [leaseId])).rows[0].id
    const ch = await db.query<{ status: string; applied_lease_fee_id: string | null }>(
      `SELECT status, applied_lease_fee_id FROM scheduled_lease_changes WHERE id=$1`, [id])
    expect(ch.rows[0].status).toBe('applied')
    expect(ch.rows[0].applied_lease_fee_id).toBe(feeId)
  })

  it('effective date in the future → NOT applied yet', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    await insertChange(leaseId, { changeType: 'rent', effectiveDate: '2026-07-01', newRentAmount: 1250 })

    const res = await applyDueScheduledChanges(NOW)
    expect(res.applied).toBe(0)
    const lease = await db.query<{ rent_amount: string }>(`SELECT rent_amount FROM leases WHERE id=$1`, [leaseId])
    expect(Number(lease.rows[0].rent_amount)).toBe(1000)   // unchanged
  })

  it('only status=scheduled applies — a draft is ignored', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    await insertChange(leaseId, { changeType: 'rent', effectiveDate: '2026-06-15', newRentAmount: 1250, status: 'draft' })

    const res = await applyDueScheduledChanges(NOW)
    expect(res.applied).toBe(0)
    const lease = await db.query<{ rent_amount: string }>(`SELECT rent_amount FROM leases WHERE id=$1`, [leaseId])
    expect(Number(lease.rows[0].rent_amount)).toBe(1000)
  })

  it('idempotent: running twice applies the change exactly once', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    await insertChange(leaseId, {
      changeType: 'recurring_fee', effectiveDate: '2026-06-15', feeType: 'parking_rent', feeAmount: 50 })

    await applyDueScheduledChanges(NOW)
    const res2 = await applyDueScheduledChanges(NOW)
    expect(res2.applied).toBe(0)   // already applied on the first pass
    const fee = await db.query(`SELECT id FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(fee.rows).toHaveLength(1)   // not duplicated
  })

  it('lease ended before the effective date → change is cancelled, not applied', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    await db.query(`UPDATE leases SET status='terminated' WHERE id=$1`, [leaseId])
    const id = await insertChange(leaseId, { changeType: 'rent', effectiveDate: '2026-06-15', newRentAmount: 1250 })

    const res = await applyDueScheduledChanges(NOW)
    expect(res.applied).toBe(0)
    expect(res.cancelled).toBe(1)
    const ch = await db.query<{ status: string }>(`SELECT status FROM scheduled_lease_changes WHERE id=$1`, [id])
    expect(ch.rows[0].status).toBe('cancelled')
  })
})

describe('activateScheduledChangesForDocument', () => {
  it('flips a document’s draft changes to scheduled (both parties signed)', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    // A doc-less draft won't be matched; use a fake document id via a real column.
    // Insert a draft tied to a synthetic source_document_id.
    const docId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, title, document_type, status)
       SELECT landlord_id, 'Addendum', 'addendum_terms', 'in_progress' FROM leases WHERE id=$1
       RETURNING id`, [leaseId])).rows[0].id
    await db.query(
      `INSERT INTO scheduled_lease_changes (lease_id, source_document_id, change_type, effective_date, new_rent_amount, status)
       VALUES ($1,$2,'rent','2026-07-01',1250,'draft')`, [leaseId, docId])

    const client = await getClient()
    try {
      const n = await activateScheduledChangesForDocument(client, docId)
      expect(n).toBe(1)
    } finally { client.release() }

    const ch = await db.query<{ status: string }>(
      `SELECT status FROM scheduled_lease_changes WHERE source_document_id=$1`, [docId])
    expect(ch.rows[0].status).toBe('scheduled')
  })
})

describe('createLeaseNoticesForDocument (NOTICE mode)', () => {
  it('creates one blocking pending notice per active tenant with a plain-language body', async () => {
    const { leaseId } = await seedLeaseCtx(1000)
    const client = await getClient()
    let docId = ''
    try {
      const tenantId = await seedTenant(client)
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      docId = (await client.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, title, document_type, status, delivery_mode)
         SELECT landlord_id, 'Space Rent Increase Notice', 'addendum_terms', 'in_progress', 'notice'
           FROM leases WHERE id=$1 RETURNING id`, [leaseId])).rows[0].id
      await client.query(
        `INSERT INTO scheduled_lease_changes
           (lease_id, source_document_id, change_type, effective_date, new_rent_amount, status)
         VALUES ($1,$2,'rent','2026-09-01',1300,'scheduled')`, [leaseId, docId])

      const n = await createLeaseNoticesForDocument(client, docId, leaseId)
      expect(n).toBe(1)
    } finally { client.release() }

    const notices = await db.query<any>(
      `SELECT title, body, status, viewed_at, acknowledged_at,
              to_char(effective_date,'YYYY-MM-DD') AS eff
         FROM lease_notices WHERE lease_id=$1`, [leaseId])
    expect(notices.rows).toHaveLength(1)
    expect(notices.rows[0].status).toBe('pending')
    expect(notices.rows[0].viewed_at).toBeNull()
    expect(notices.rows[0].acknowledged_at).toBeNull()
    expect(notices.rows[0].body).toMatch(/rent will change to \$1300\.00 effective 2026-09-01/i)
    expect(notices.rows[0].eff).toBe('2026-09-01')
  })
})
