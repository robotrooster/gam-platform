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
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
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
