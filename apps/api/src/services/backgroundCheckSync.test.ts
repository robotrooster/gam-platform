/**
 * S640 — a screening must not depend on a webhook arriving.
 *
 * Checkr finished Anastacio Erreguin's report at 15:19 Phoenix on Sep 9. GAM
 * never heard: not one request has reached /api/background/webhook in the whole
 * log window. His screening sat at `processing` for twenty-two hours until Nic
 * opened it and decided it by hand — on a report the page could not show him,
 * because the summary had never been pulled either.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const fetchStatusMock = vi.hoisted(() => vi.fn())
const fetchReportMock = vi.hoisted(() => vi.fn())

vi.mock('./backgroundProvider', async (orig) => {
  const actual = await orig() as any
  return {
    ...actual,
    getProvider: () => ({
      name: 'checkr',
      fetchStatus: fetchStatusMock,
      fetchReport: fetchReportMock,
      rawReport: null,
      initiate: vi.fn(), verifyWebhook: vi.fn(), parseWebhook: vi.fn(),
      craDisclosure: () => ({ name: 'Checkr', address: '', phone: '' }),
    }),
  }
})

import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { syncPendingBackgroundChecks } from './backgroundCheckSync'

beforeEach(async () => {
  await cleanupAllSchema()
  fetchStatusMock.mockReset()
  fetchReportMock.mockReset()
})

async function seedCheck(opts: { status: string; provider?: string; ageDays?: number; ref?: string | null }) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { landlordId } = await seedLandlord(c)
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('bgc-' || gen_random_uuid() || '@t.dev','x','tenant','A','B',TRUE) RETURNING id`)
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, status, provider_name, provider_ref,
                                      first_name, last_name, created_at)
       VALUES ($1,$2,$3,$4,$5,'A','B', NOW() - ($6 || ' days')::interval) RETURNING id`,
      [landlordId, u.rows[0].id, opts.status, opts.provider ?? 'checkr',
       opts.ref === undefined ? 'ord_test' : opts.ref, String(opts.ageDays ?? 1)])
    await c.query('COMMIT')
    return { checkId: bc.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const statusOf = async (id: string) =>
  (await db.query<any>('SELECT status, report_summary, expires_at FROM background_checks WHERE id=$1', [id])).rows[0]

describe('S640 background-check status sync', () => {
  it('advances a check the provider finished while nobody was listening', async () => {
    const { checkId } = await seedCheck({ status: 'processing' })
    fetchStatusMock.mockResolvedValue({ status: 'complete', reportRef: 'rp_1' })
    fetchReportMock.mockResolvedValue({ result: 'consider', products: { credit_report: 'consider' } })

    const r = await syncPendingBackgroundChecks()
    expect(r.advanced).toBe(1)
    const row = await statusOf(checkId)
    expect(row.status).toBe('complete')
    // The summary lands with the status — a landlord opening it sees the report,
    // not an empty page with a verdict on it.
    expect(row.report_summary?.result).toBe('consider')
    // Completing starts the six-month clock, same as the webhook path.
    expect(row.expires_at).not.toBeNull()
  })

  it('leaves a check alone when the provider says nothing has changed', async () => {
    const { checkId } = await seedCheck({ status: 'processing' })
    fetchStatusMock.mockResolvedValue({ status: 'processing', reportRef: null })
    const r = await syncPendingBackgroundChecks()
    expect(r.advanced).toBe(0)
    expect(r.unchanged).toBe(1)
    expect((await statusOf(checkId)).status).toBe('processing')
  })

  // A landlord's decision is theirs. The poller reports what the screener says
  // and must never walk back a verdict somebody already recorded.
  it('never touches a check that has already been decided', async () => {
    await seedCheck({ status: 'approved' })
    await seedCheck({ status: 'denied' })
    const r = await syncPendingBackgroundChecks()
    expect(r.scanned).toBe(0)
    expect(fetchStatusMock).not.toHaveBeenCalled()
  })

  it('does not chase an order nobody finished two months ago', async () => {
    await seedCheck({ status: 'awaiting_applicant', ageDays: 90 })
    const r = await syncPendingBackgroundChecks()
    expect(r.scanned).toBe(0)
  })

  it('skips the mock provider and rows with no provider reference', async () => {
    await seedCheck({ status: 'processing', provider: 'mock' })
    await seedCheck({ status: 'processing', ref: null })
    const r = await syncPendingBackgroundChecks()
    expect(r.scanned).toBe(0)
  })

  // Checkr being down is a retry, not an outage of GAM's screening product.
  it('counts a provider failure and carries on', async () => {
    const { checkId } = await seedCheck({ status: 'processing' })
    fetchStatusMock.mockRejectedValue(new Error('checkr down'))
    const r = await syncPendingBackgroundChecks()
    expect(r.errors).toBe(1)
    expect((await statusOf(checkId)).status).toBe('processing')
  })

  // The status is the point; the summary is a bonus. A report fetch that fails
  // must not strand the applicant at "under review" for another ten minutes.
  it('still advances the status when the report fetch fails', async () => {
    const { checkId } = await seedCheck({ status: 'processing' })
    fetchStatusMock.mockResolvedValue({ status: 'complete', reportRef: 'rp_2' })
    fetchReportMock.mockRejectedValue(new Error('report 500'))
    const r = await syncPendingBackgroundChecks()
    expect(r.advanced).toBe(1)
    expect((await statusOf(checkId)).status).toBe('complete')
  })
})

// ── S642: THE SCREENER NAMES THE ACCOUNT ─────────────────────────────────────
//
// Nic: "They never have a spot to type in their name. We're gonna generate
// accounts off a legal name."
//
// An applicant account is created from email + password alone. The only name it
// carries is the provisional one typed to open the Checkr order, because Checkr
// will not create an order without one. When the report lands, the matched legal
// name replaces it.
describe('S642 the matched legal name becomes the account name', () => {
  async function seedApplicant(first: string, last: string) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ('applicant-' || gen_random_uuid() || '@t.dev','x','tenant',$1,$2,FALSE) RETURNING id`,
        [first, last])
      const bc = await c.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, status, provider_name, provider_ref,
                                        first_name, last_name, created_at)
         VALUES ($1,$2,'processing','checkr','ord_name',$3,$4, NOW()) RETURNING id`,
        [landlordId, u.rows[0].id, first, last])
      await c.query('COMMIT')
      return { userId: u.rows[0].id, checkId: bc.rows[0].id }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const nameOf = async (userId: string) =>
    (await db.query<any>('SELECT first_name, last_name FROM users WHERE id=$1', [userId])).rows[0]

  it('replaces the provisional name with the one the screener matched', async () => {
    const { userId } = await seedApplicant('cal', 'curtis')
    fetchStatusMock.mockResolvedValue({ status: 'complete', reportRef: 'rp_name' })
    fetchReportMock.mockResolvedValue({
      result: 'clear', products: { credit_report: 'clear' },
      matched_first_name: 'Calvin', matched_last_name: 'Curtis',
    })
    await syncPendingBackgroundChecks()
    expect(await nameOf(userId)).toMatchObject({ first_name: 'Calvin', last_name: 'Curtis' })
  })

  it('leaves the name alone when the report carries none', async () => {
    // trg_normalize_user_name title-cases on write, so the seed is asserted in
    // the form the trigger stores, not the form it was typed in.
    const { userId } = await seedApplicant('Cal', 'Curtis')
    fetchStatusMock.mockResolvedValue({ status: 'complete', reportRef: 'rp_noname' })
    fetchReportMock.mockResolvedValue({ result: 'clear', products: { credit_report: 'clear' } })
    await syncPendingBackgroundChecks()
    expect(await nameOf(userId)).toMatchObject({ first_name: 'Cal', last_name: 'Curtis' })
  })

  it('never renames somebody who already holds a lease', async () => {
    // A tenancy is held in a legal name that appears on signed documents.
    // Quietly rewriting it under a sitting resident is worse than a misspelling.
    const { userId } = await seedApplicant('Bob', 'Tenant')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const t = await c.query<{ id: string }>(
        `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
      const { landlordId, userId: ownerUserId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
      await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`,
        [leaseId, t.rows[0].id])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    fetchStatusMock.mockResolvedValue({ status: 'complete', reportRef: 'rp_lease' })
    fetchReportMock.mockResolvedValue({
      result: 'clear', products: { credit_report: 'clear' },
      matched_first_name: 'Robert', matched_last_name: 'Tenant',
    })
    await syncPendingBackgroundChecks()
    expect(await nameOf(userId)).toMatchObject({ first_name: 'Bob', last_name: 'Tenant' })
  })
})
