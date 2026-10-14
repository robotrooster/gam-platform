/**
 * jobs/creditNightly — the 03:00 credit nightly runs the chain check (10/13,
 * Nic: "ADD the nightly chain check (break flagged in the morning admin
 * email)"): after tonight's marks, before the scores and stats. 10/13 evening
 * (Nic): "Broken credit chain: fold into the 8:05 MORNING admin email (not its
 * own 3 am email)" — nobody is emailed at 3 am; what the check found is
 * written down (credit_chain_check_runs) for the morning email
 * (services/creditChainCheck.test.ts covers that email), and a failing check
 * never stops the scores and stats — it is written down as failed. The marks,
 * score and stats passes are stubbed here (their own suites cover them); the
 * chain check and its record run for real.
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
}))

vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendNotificationEmail: async () => 'msg_mock',
}))
vi.mock('../services/adminNotifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/adminNotifications')>()
  h.adminNote.mockImplementation((o: any) => real.createAdminNotification(o))
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
    recordCreditChainCheck: async (...a: Parameters<typeof real.recordCreditChainCheck>) => {
      h.order.push('chains')
      if (h.chainCheckFails) throw new Error('chain check down')
      return real.recordCreditChainCheck(...a)
    },
  }
})

import { processCreditNightly } from './creditNightly'

beforeEach(async () => {
  await cleanupAllSchema()
  h.order = []
  h.chainCheckFails = false
  h.adminNote.mockClear()
})

async function onRecord() {
  return (await db.query<{ severity: string; category: string; title: string }>(
    `SELECT severity, category, title FROM admin_notifications ORDER BY created_at, id`)).rows
}

/** The nightly runs on record (10/13 evening), oldest first. */
async function runs() {
  return (await db.query<{ outcome: string; subjects: number | null; whole: number | null; broken: number | null; error: string | null }>(
    `SELECT outcome, subjects, whole, broken, error FROM credit_chain_check_runs ORDER BY started_at, id`)).rows
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

describe('processCreditNightly — the chain check (10/13; written down for the 8:05 morning email, 10/13 evening)', () => {
  it('a broken chain: checked after tonight\'s marks, written down for the morning — nobody emailed at 3 am — and scores and stats still run', async () => {
    await forkedChain()
    await appendEvent(ev(randomUUID(), 1))   // a whole one beside it
    const r = await processCreditNightly()
    expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
    expect(r.chains).toEqual({ subjects: 2, whole: 1, broken: 1, recorded: true, errors: 0 })
    expect(h.adminNote).not.toHaveBeenCalled()
    expect(await onRecord()).toEqual([])
    expect(await runs()).toEqual([{ outcome: 'broken', subjects: 2, whole: 1, broken: 1, error: null }])
  })

  it('a run that cannot be written down: an error in the log line, scores and stats still run', async () => {
    await forkedChain()
    await db.query(`ALTER TABLE credit_chain_check_runs ADD CONSTRAINT test_refuse CHECK (false) NOT VALID`)
    try {
      const r = await processCreditNightly()
      expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
      expect(r.chains).toEqual({ subjects: 1, whole: 0, broken: 1, recorded: false, errors: 1 })
    } finally { await db.query(`ALTER TABLE credit_chain_check_runs DROP CONSTRAINT test_refuse`) }
    expect(await runs()).toEqual([])
    expect(await onRecord()).toEqual([])
  })

  it('every chain whole: written down, nothing sent', async () => {
    await appendEvent(ev(randomUUID(), 1))
    const r = await processCreditNightly()
    expect(r.chains).toEqual({ subjects: 1, whole: 1, broken: 0, recorded: true, errors: 0 })
    expect(h.adminNote).not.toHaveBeenCalled()
    expect(await onRecord()).toEqual([])
    expect(await runs()).toEqual([{ outcome: 'whole', subjects: 1, whole: 1, broken: 0, error: null }])
  })

  it('the check failing never stops the scores and stats, and it is written down as failed for the morning email', async () => {
    h.chainCheckFails = true
    const r = await processCreditNightly()
    expect(h.order).toEqual(['marks', 'chains', 'scores', 'stats'])
    expect(r.chains).toEqual({ subjects: 0, whole: 0, broken: 0, recorded: true, errors: 1 })
    expect(r.scores).toEqual({ processed: 0, errors: 0 })
    expect(r.stats).toEqual({ processed: 0, errors: 0 })
    expect(h.adminNote).not.toHaveBeenCalled()
    expect(await runs()).toEqual([{ outcome: 'failed', subjects: null, whole: null, broken: null, error: 'chain check down' }])
  })
})
