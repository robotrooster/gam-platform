/**
 * 10/13 (Nic) — "restart the chain from today for each, with a recorded note
 * explaining the break (old entries untouched)": oct13_restart_forked_credit_chains
 * run as its dry run (a READ ONLY transaction: nothing changes), then applied
 * (and run again: nothing left to do), on chains forked the way production's
 * were before 10/12.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import { appendEvent, computeEventHash, verifyChain, type ChainSplit } from '../services/creditLedger'
import {
  FORKED_ON_10_13, planRestarts, applyRestarts, formatPlan, restartNote, type RestartPlan,
} from './oct13_restart_forked_credit_chains'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query(commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
const readOnly = <T>(fn: (c: PoolClient) => Promise<T>) => tx(async c => { await c.query('SET TRANSACTION READ ONLY'); return fn(c) }, false)

const mark = (tenantId: string, i: number) => appendEvent({
  subjectType: 'tenant', subjectRefId: tenantId,
  eventType: 'payment_received_late_grace', eventData: { i },
  occurredAt: new Date('2026-09-22T12:00:00Z'),
  attestationSource: 'landlord_self_reported_with_evidence',
  networkVisibility: 'visible_to_current_landlord',
})

/** Re-link a mark to follow another, its hash recomputed so only the link is wrong. Returns its new hash. */
async function relink(id: string, prevHash: Buffer): Promise<Buffer> {
  const row = (await db.query<any>(`SELECT event_data, occurred_at, attestation_source, attestation_evidence FROM credit_events WHERE id = $1`, [id])).rows[0]
  const forged = computeEventHash({ prevHash, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
    attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })
  await db.query(`UPDATE credit_events SET prev_hash = $1, this_hash = $2 WHERE id = $3`, [prevHash, forged, id])
  return forged
}

const newTenant = async (): Promise<string> => {
  const c = await db.connect()
  try { return await seedTenant(c) } finally { c.release() }
}

/** A tenant's chain forked as before 10/12: the third mark also follows the first. Returns the first bad event and the split. */
async function forkedTenant(): Promise<{ tenantId: string; subjectId: string; firstBad: string; split: ChainSplit }> {
  const tenantId = await newTenant()
  const a = await mark(tenantId, 1)
  const second = await mark(tenantId, 2)
  const third = await mark(tenantId, 3)
  await relink(third.eventId, a.thisHash)
  return { tenantId, subjectId: a.subjectId, firstBad: third.eventId, split: { eventId: a.eventId, followedBy: [second.eventId, third.eventId] } }
}

const events = async () => (await db.query(`SELECT id, prev_hash, this_hash, event_data, superseded_by FROM credit_events ORDER BY recorded_at, id`)).rows

describe('oct13_restart_forked_credit_chains', () => {
  const NOW = new Date('2026-10-13T17:00:00Z')

  it('names the 12 chains the 10/13 check found forked', () => {
    expect(FORKED_ON_10_13).toHaveLength(12)
    expect(new Set(FORKED_ON_10_13).size).toBe(12)
  })

  it('the dry run only reads; --apply restarts each named fork from today with its note; a second run finds nothing; other chains are left as they are', async () => {
    const named = await forkedTenant()
    const other = await forkedTenant()   // broken, but not named on 10/13
    const c = await db.connect()
    let wholeTenant = ''
    try { wholeTenant = await seedTenant(c) } finally { c.release() }
    await mark(wholeTenant, 1)
    const before = await events()

    // The dry run: a READ ONLY transaction — it could not write if it tried.
    const plan = await readOnly(c => planRestarts(c, [named.firstBad]))
    expect(await events()).toEqual(before)
    expect(plan.chains).toMatchObject({ subjects: 3, ok: 1, okAfterRestart: 0 })
    expect(plan.named).toEqual([{
      namedEventId: named.firstBad, subjectId: named.subjectId, subjectType: 'tenant', subjectRefId: named.tenantId,
      name: 'Test Tenant', eventCount: 3, action: 'restart', firstBadEventId: named.firstBad,
      reason: expect.stringMatching(/a fork/), splits: [named.split], why: null, restartEventId: null,
    }])
    expect(plan.others.map(o => [o.subjectId, o.firstBadEventId])).toEqual([[other.subjectId, other.firstBad]])
    const printed = formatPlan(plan, 'DRY RUN')
    expect(printed).toContain('1 forked chain(s) named on 10/13: 1 to restart, 0 already restarted, 0 left alone')
    expect(printed).toContain(`RESTART · subject ${named.subjectId} · tenant Test Tenant (${named.tenantId}) · 3 entries · first bad ${named.firstBad}`)
    expect(printed).toContain(`split at ${named.split.eventId} (2 entries attach)`)
    expect(printed).toContain('Credit chains: 3 subject(s) · 1 whole · 0 whole since a restart · 2 broken')
    expect(printed).toContain(`subject ${other.subjectId} · first bad ${other.firstBad}`)

    const done = await tx(c => applyRestarts(c, { named: [named.firstBad], now: NOW }), true)
    expect(done.restarted).toHaveLength(1)
    // --apply prints the counts before and after: the plan's own are from before anything was written.
    expect(done.plan.chains).toMatchObject({ ok: 1, okAfterRestart: 0, bad: [{}, {}] })
    expect(done.after).toMatchObject({ subjects: 3, ok: 1, okAfterRestart: 1, bad: [{ subjectId: other.subjectId }] })
    const applied = formatPlan(done.plan, 'APPLY', done.after)
    expect(applied).toContain('Credit chains before: 3 subject(s) · 1 whole · 0 whole since a restart · 2 broken')
    expect(applied).toContain('Credit chains after:  3 subject(s) · 1 whole · 1 whole since a restart · 1 broken')
    expect(applied).not.toContain('Credit chains: ')
    expect(applied).toContain('1 forked chain(s) named on 10/13: 1 restarted now, 0 already restarted, 0 left alone')
    const v = await verifyChain(named.subjectId)
    expect(v).toMatchObject({ ok: true, eventCount: 4 })
    expect(v.restarts).toEqual([expect.objectContaining({
      eventId: done.restarted[0].restartEventId, sealedEventCount: 3, brokenEventId: named.firstBad, splits: [named.split],
    })])
    expect(restartNote([named.split], NOW)).toBe(`Restarted 10/13/2026: this record's chain split at entry ${named.split.eventId}: `
      + '2 entries attach to it, where only one should. '
      + 'Before the 10/12 fix, entries written in the same moment could attach to the same earlier entry instead of one after another (a fork). '
      + 'Every entry before this point is kept exactly as it was; the chain continues from here.')
    const restart = (await db.query(`SELECT occurred_at, attestation_evidence, event_data FROM credit_events WHERE id = $1`, [done.restarted[0].restartEventId])).rows[0]
    expect(restart.event_data.note).toBe(restartNote([named.split], NOW))
    expect(new Date(restart.occurred_at).toISOString()).toBe(NOW.toISOString())
    expect(restart.attestation_evidence).toEqual({ recorded_by: 'scripts/oct13_restart_forked_credit_chains', decided: 'Nic, 10/13' })

    // Old entries untouched; the chain not named still broken, untouched.
    const after = await events()
    expect(after.filter(e => e.id !== done.restarted[0].restartEventId)).toEqual(before)
    expect(await verifyChain(other.subjectId)).toMatchObject({ ok: false, firstBadEventId: other.firstBad, break: 'fork' })

    // Run again: nothing to restart.
    const again: RestartPlan = await readOnly(c => planRestarts(c, [named.firstBad]))
    expect(again.named[0]).toMatchObject({ action: 'already_restarted', firstBadEventId: named.firstBad, splits: [named.split], restartEventId: done.restarted[0].restartEventId })
    expect(again.chains).toMatchObject({ subjects: 3, ok: 1, okAfterRestart: 1 })
    expect((await tx(c => applyRestarts(c, { named: [named.firstBad], now: NOW }), true)).restarted).toEqual([])
    expect(await events()).toHaveLength(after.length)
  })

  it('left alone: a named event not on the ledger, and a named chain that breaks elsewhere', async () => {
    const f = await forkedTenant()
    const elsewhere = (await db.query<{ id: string }>(
      `SELECT id FROM credit_events WHERE subject_id = $1 AND id <> $2 ORDER BY recorded_at, id LIMIT 1`, [f.subjectId, f.firstBad])).rows[0].id
    const missing = randomUUID()
    const plan = await readOnly(c => planRestarts(c, [missing, elsewhere]))
    expect(plan.named.map(c => [c.namedEventId, c.action, c.why])).toEqual([
      [missing, 'left_alone', 'the event is not on the ledger'],
      [elsewhere, 'left_alone', `it breaks at ${f.firstBad}, not ${elsewhere}`],
    ])
    expect((await tx(c => applyRestarts(c, { named: [missing, elsewhere], now: NOW }), true)).restarted).toEqual([])
    expect(await verifyChain(f.subjectId)).toMatchObject({ ok: false, firstBadEventId: f.firstBad })
  })

  // 10/13 review: on production 5 of the 12 split more than two ways (3, 5 and
  // 7 branches) and Jonathan Covey's split at two entries. The note is hashed
  // with the restart and can never be corrected: it names every split.
  it('a chain split three ways and again further on: planned, noted and sealed with every split', async () => {
    const tenantId = await newTenant()
    const a = await mark(tenantId, 1)
    const b = await mark(tenantId, 2)
    const c = await mark(tenantId, 3)
    await relink(c.eventId, a.thisHash)               // a: b, c
    const d = await mark(tenantId, 4)
    const dHash = await relink(d.eventId, a.thisHash) // a: b, c, d
    const e = await mark(tenantId, 5)                 // after d
    const g = await mark(tenantId, 6)
    await relink(g.eventId, dHash)                    // d: e, g
    const splits: ChainSplit[] = [
      { eventId: a.eventId, followedBy: [b.eventId, c.eventId, d.eventId] },
      { eventId: d.eventId, followedBy: [e.eventId, g.eventId] },
    ]

    const plan = await readOnly(q => planRestarts(q, [c.eventId]))
    expect(plan.named[0]).toMatchObject({ action: 'restart', firstBadEventId: c.eventId, eventCount: 6, splits })
    expect(formatPlan(plan, 'DRY RUN')).toContain(
      `first bad ${c.eventId} (prev_hash does not match prior event this_hash (two events follow the same event: a fork))`
      + ` · split at ${a.eventId} (3 entries attach), ${d.eventId} (2 entries attach)`)

    const note = restartNote(splits, NOW)
    expect(note).toBe(`Restarted 10/13/2026: this record's chain split at 2 points: `
      + `3 entries attach to entry ${a.eventId} and 2 entries attach to entry ${d.eventId}, where only one should attach to each. `
      + 'Before the 10/12 fix, entries written in the same moment could attach to the same earlier entry instead of one after another (a fork). '
      + 'Every entry before this point is kept exactly as it was; the chain continues from here.')
    expect(restartNote([...splits, { eventId: 'x', followedBy: ['y', 'z'] }], NOW))
      .toContain(`split at 3 points: 3 entries attach to entry ${a.eventId}, 2 entries attach to entry ${d.eventId}, and 2 entries attach to entry x, where`)
    expect(() => restartNote([], NOW)).toThrow(/no split given/)

    const done = await tx(q => applyRestarts(q, { named: [c.eventId], now: NOW }), true)
    expect(done.restarted).toHaveLength(1)
    const restart = (await db.query(`SELECT event_data FROM credit_events WHERE id = $1`, [done.restarted[0].restartEventId])).rows[0]
    expect(restart.event_data).toMatchObject({
      note, sealed_event_count: 6, broken_event_id: c.eventId,
      splits: [
        { event_id: a.eventId, followed_by: [b.eventId, c.eventId, d.eventId] },
        { event_id: d.eventId, followed_by: [e.eventId, g.eventId] },
      ],
    })
    expect(await verifyChain(a.subjectId)).toMatchObject({ ok: true, eventCount: 7, restarts: [{ brokenEventId: c.eventId, splits }] })
    expect((await readOnly(q => planRestarts(q, [c.eventId]))).named[0]).toMatchObject({ action: 'already_restarted', splits })
  })
})
