/**
 * jobs/creditNightly — the 03:00 credit nightly runs the chain check (10/13,
 * Nic: "ADD the nightly chain check (break flagged in the morning admin
 * email)"): after tonight's marks, before the scores and stats; a broken chain
 * sends the admin email, all whole sends nothing, and a failing check never
 * stops the scores and stats — it sends the "did not run" email instead (10/13,
 * review). The marks, score and stats passes are stubbed here (their own suites
 * cover them); the chain check and the admin notification's row run for real
 * (only the mail call is stubbed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { appendEvent, computeEventHash } from '../services/creditLedger'

const h = vi.hoisted(() => ({
  order: [] as string[],
  adminNote: vi.fn(),
  chainCheckFails: false,
  writeFails: false,
}))

vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendNotificationEmail: async () => 'msg_mock',
}))
vi.mock('../services/adminNotifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/adminNotifications')>()
  // A severity outside the table's CHECK makes the real insert fail; the real
  // helper logs it and returns as if nothing happened.
  h.adminNote.mockImplementation((o: any) => real.createAdminNotification(h.writeFails ? { ...o, severity: 'not-a-severity' } : o))
  return { ...real, createAdminNotification: (o: any) => h.adminNote(o) }
})
vi.mock('../services/creditBillMarks', () => ({
  syncBillMarksNightly: vi.fn(async () => { h.order.push('marks'); return { reviewed: 0, changed: 0, errors: 0 } }),
}))
vi.mock('../services/creditScore', () => ({
  recomputeAllSubjects: vi.fn(async () => { h.order.push('scores'); return { processed: 0, errors: [] } }),
}))
vi.mock('../services/creditStats', () => ({
  refreshAllSubjectStats: vi.fn(async () => { h.order.push('stats'); return { processed: 0, errors: [] } }),
}))
vi.mock('../services/creditChainCheck', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/creditChainCheck')>()
  return {
    ...real,
    flagBrokenCreditChains: async (...a: Parameters<typeof real.flagBrokenCreditChains>) => {
      h.order.push('chains')
      if (h.chainCheckFails) throw new Error('chain check down')
      return real.flagBrokenCreditChains(...a)
    },
  }
})

import { processCreditNightly } from './creditNightly'

beforeEach(async () => {
  await cleanupAllSchema()
  h.order = []
  h.chainCheckFails = false
  h.writeFails = false
  h.adminNote.mockClear()
})

async function onRecord() {
  return (await db.query<{ severity: string; category: string; title: string }>(
    `SELECT severity, category, title FROM admin_notifications ORDER BY created_at, id`)).rows
}

const ev = (refId: string, i: number) => ({
  subjectType: 'tenant' as const, subjectRefId: refId,
  eventType: 'payment_received_on_time' as const, eventData: { i },
  occurredAt: new Date('2026-10-12T12:00:00Z'),
  attestationSource: 'gam_workflow_auto' as const,
  networkVisibility: 'visible_to_current_landlord' as const,
})

/** a → b, and c also after a: a forked chain. */
async function forkedChain() {
  const refId = randomUUID()
  const a = await appendEvent(ev(refId, 1))
  await appendEvent(ev(refId, 2))
  const c = await appendEvent(ev(refId, 3))
  const row = (await db.query<any>(`SELECT event_data, occurred_at, attestation_source, attestation_evidence FROM credit_events WHERE id = $1`, [c.eventId])).rows[0]
  const forged = computeEventHash({ prevHash: a.thisHash, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
    attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })
  await db.query(`UPDATE credit_events SET prev_hash = $1, this_hash = $2 WHERE id = $3`, [a.thisHash, forged, c.eventId])
  return { subjectId: a.subjectId, firstBad: c.eventId }
}

describe('processCreditNightly — the chain check (10/13)', () => {
  it('a broken chain: checked after tonight\'s marks, one admin email, scores and stats still run', async () => {
    const f = await forkedChain()
    await appendEvent(ev(randomUUID(), 1))   // a whole one beside it
    const r = await processCreditNightly()
    expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
    expect(r.chains).toEqual({ subjects: 2, whole: 1, broken: 1, sent: true, errors: 0 })
    expect(h.adminNote).toHaveBeenCalledTimes(1)
    const n = h.adminNote.mock.calls[0][0]
    expect(n).toMatchObject({ category: 'credit_chain_broken', emailSuperAdmins: true, title: '1 credit history chain broken' })
    expect(n.body).toContain(`(entry ${f.firstBad})`)
    expect(n.body).toContain(`Credit record ${f.subjectId}`)
    expect(await onRecord()).toEqual([{ severity: 'critical', category: 'credit_chain_broken', title: '1 credit history chain broken' }])
  })

  it('a broken chain whose email is not on record: not sent, an error in the log line, scores and stats still run', async () => {
    await forkedChain()
    h.writeFails = true
    const r = await processCreditNightly()
    expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
    expect(r.chains).toEqual({ subjects: 1, whole: 0, broken: 1, sent: false, errors: 1 })
    expect(await onRecord()).toEqual([])
  })

  it('every chain whole: nothing sent', async () => {
    await appendEvent(ev(randomUUID(), 1))
    const r = await processCreditNightly()
    expect(r.chains).toEqual({ subjects: 1, whole: 1, broken: 0, sent: false, errors: 0 })
    expect(h.adminNote).not.toHaveBeenCalled()
    expect(await onRecord()).toEqual([])
  })

  it('the check failing never stops the scores and stats, and the admins hear it did not run', async () => {
    h.chainCheckFails = true
    const r = await processCreditNightly()
    expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
    expect(r.chains).toEqual({ subjects: 0, whole: 0, broken: 0, sent: true, errors: 1 })
    expect(r.scores).toEqual({ processed: 0, errors: 0 })
    expect(r.stats).toEqual({ processed: 0, errors: 0 })
    expect(h.adminNote).toHaveBeenCalledTimes(1)
    expect(h.adminNote.mock.calls[0][0]).toMatchObject({ emailSuperAdmins: true, body: expect.stringContaining('chain check down') })
    expect(await onRecord()).toEqual([{ severity: 'warn', category: 'credit_chain_check_failed', title: 'The credit chain check did not run tonight' }])
  })
})
