/**
 * creditLedger — hash-chained event log foundation.
 *
 * Surfaces under test:
 *   - canonicalJson         pure, deterministic key-sort
 *   - computeEventHash      pure, deterministic digest
 *   - getOrCreateSubject    lazy subject materialization (idempotent)
 *   - appendEvent           the load-bearing append: subject create →
 *                           advisory lock → prev_hash lookup → this_hash
 *                           compute → insert
 *   - getSubjectChain       chain readback (recorded_at ASC, id ASC)
 *   - verifyChain           replay determinism + tamper detection
 *   - restartChain          10/13: a forked chain restarted from today, the
 *                           break — every split — sealed and still reported
 *                           (verifyAllChains); the note to admins only;
 *                           the nightly score and stats skip a restart
 *   - computeMerkleRoot     weekly-anchor cron tree builder
 *   - supersedeEvent        dispute correction stamping
 *   - findSubjectId         convenience lookup
 *
 * Every other test in the suite mocks appendEvent — these direct
 * tests lock in the actual hash chain, advisory lock, and replay
 * verification that all those upstream emitters rely on.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  canonicalJson,
  computeEventHash,
  getOrCreateSubject,
  appendEvent,
  getSubjectChain,
  verifyChain,
  computeMerkleRoot,
  supersedeEvent,
  findSubjectId,
  restartChain,
  checkRestart,
  readChain,
  verifyAllChains,
  CHAIN_RESTART_EVENT,
} from './creditLedger'
import { refreshAllSubjectStats } from './creditStats'
import { recomputeAllSubjects } from './creditScore'

beforeEach(cleanupAllSchema)

// Pick a real tenant uuid to use as subject_ref_id (no FK enforcement
// on credit_subjects.subject_ref_id, but realistic values keep the
// tests readable).
function newRefId(): string { return randomUUID() }

// ─── canonicalJson ─────────────────────────────────────────────

describe('canonicalJson', () => {
  it('sorts top-level keys alphabetically', () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
  })

  it('recurses into nested objects', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } }))
      .toBe('{"outer":{"a":2,"z":1}}')
  })

  it('preserves array order (only keys are sorted, not array elements)', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}')
  })

  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson('hello')).toBe('"hello"')
    expect(canonicalJson(true)).toBe('true')
  })

  it('idempotent — same input produces same output across calls', () => {
    const a = canonicalJson({ z: 1, a: { y: 2, b: [3, 4] } })
    const b = canonicalJson({ z: 1, a: { y: 2, b: [3, 4] } })
    expect(a).toBe(b)
  })

  it('key reordering produces identical canonical form', () => {
    const a = canonicalJson({ rent_amount: 1500, lease_id: 'L1' })
    const b = canonicalJson({ lease_id: 'L1', rent_amount: 1500 })
    expect(a).toBe(b)
  })
})

// ─── computeEventHash ──────────────────────────────────────────

describe('computeEventHash', () => {
  const base = {
    prevHash:           null as Buffer | null,
    eventData:          { foo: 'bar' },
    occurredAt:         new Date('2026-05-20T12:00:00Z'),
    attestationSource:  'gam_workflow_auto',
    attestationEvidence: { ip: '1.1.1.1' },
  }

  it('is deterministic for the same input', () => {
    const a = computeEventHash(base)
    const b = computeEventHash(base)
    expect(a.equals(b)).toBe(true)
  })

  it('returns a 32-byte sha256 digest', () => {
    expect(computeEventHash(base).length).toBe(32)
  })

  it('different prev_hash → different output', () => {
    const a = computeEventHash(base)
    const otherPrev = createHash('sha256').update('different').digest()
    const b = computeEventHash({ ...base, prevHash: otherPrev })
    expect(a.equals(b)).toBe(false)
  })

  it('null vs zero-buffer prev_hash produces the SAME hash (null is normalized to ZERO_HASH internally)', () => {
    const a = computeEventHash({ ...base, prevHash: null })
    const b = computeEventHash({ ...base, prevHash: Buffer.alloc(32, 0) })
    expect(a.equals(b)).toBe(true)
  })

  it('different event_data → different hash', () => {
    const a = computeEventHash(base)
    const b = computeEventHash({ ...base, eventData: { foo: 'baz' } })
    expect(a.equals(b)).toBe(false)
  })

  it('different occurredAt → different hash', () => {
    const a = computeEventHash(base)
    const b = computeEventHash({ ...base, occurredAt: new Date('2026-05-21T12:00:00Z') })
    expect(a.equals(b)).toBe(false)
  })

  it('different attestationSource → different hash', () => {
    const a = computeEventHash(base)
    const b = computeEventHash({ ...base, attestationSource: 'tenant_self_attested' })
    expect(a.equals(b)).toBe(false)
  })

  it('key reordering in event_data does NOT change the hash (canonical JSON normalizes)', () => {
    const a = computeEventHash({ ...base, eventData: { rent_amount: 1500, lease_id: 'L1' } })
    const b = computeEventHash({ ...base, eventData: { lease_id: 'L1', rent_amount: 1500 } })
    expect(a.equals(b)).toBe(true)
  })
})

// ─── getOrCreateSubject ────────────────────────────────────────

describe('getOrCreateSubject', () => {
  it('first call creates a new credit_subjects row', async () => {
    const client = await db.connect()
    try {
      const refId = newRefId()
      const id = await getOrCreateSubject(client, 'tenant', refId)
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      const row = await client.query<{ id: string }>(
        `SELECT id FROM credit_subjects WHERE subject_type='tenant' AND subject_ref_id=$1`,
        [refId],
      )
      expect(row.rows[0].id).toBe(id)
    } finally { client.release() }
  })

  it('second call with same (type, ref_id) returns the SAME id', async () => {
    const client = await db.connect()
    try {
      const refId = newRefId()
      const a = await getOrCreateSubject(client, 'tenant', refId)
      const b = await getOrCreateSubject(client, 'tenant', refId)
      expect(b).toBe(a)
      const count = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM credit_subjects WHERE subject_ref_id=$1`,
        [refId],
      )
      expect(count.rows[0].n).toBe('1')
    } finally { client.release() }
  })

  it('different ref_id → different id', async () => {
    const client = await db.connect()
    try {
      const a = await getOrCreateSubject(client, 'tenant', newRefId())
      const b = await getOrCreateSubject(client, 'tenant', newRefId())
      expect(a).not.toBe(b)
    } finally { client.release() }
  })

  it('different subject_type with same ref_id → different id', async () => {
    const client = await db.connect()
    try {
      const refId = newRefId()
      const a = await getOrCreateSubject(client, 'tenant', refId)
      const b = await getOrCreateSubject(client, 'landlord', refId)
      expect(a).not.toBe(b)
    } finally { client.release() }
  })
})

// ─── appendEvent ───────────────────────────────────────────────

describe('appendEvent', () => {
  it('first event on a new subject: prev_hash=null, this_hash matches computeEventHash, subject is created lazily', async () => {
    const refId = newRefId()
    const occurredAt = new Date('2026-05-20T12:00:00Z')
    const res = await appendEvent({
      subjectType: 'tenant',
      subjectRefId: refId,
      eventType: 'payment_received_on_time',
      eventData: { amount: 1500 },
      occurredAt,
      attestationSource: 'gam_workflow_auto',
      attestationEvidence: { source: 'test' },
      networkVisibility: 'visible_to_current_landlord',
    })
    expect(res.prevHash).toBeNull()
    expect(res.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.subjectId).toMatch(/^[0-9a-f-]{36}$/)
    // this_hash matches the pure-function compute
    const expected = computeEventHash({
      prevHash:           null,
      eventData:          { amount: 1500 },
      occurredAt,
      attestationSource:  'gam_workflow_auto',
      attestationEvidence: { source: 'test' },
    })
    expect(res.thisHash.equals(expected)).toBe(true)
    // Subject materialized
    const sid = await findSubjectId('tenant', refId)
    expect(sid).toBe(res.subjectId)
  })

  it('second event: prev_hash equals the first event\'s this_hash', async () => {
    const refId = newRefId()
    const first = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 1 },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const second = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 2 },
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    expect(second.prevHash).not.toBeNull()
    expect(second.prevHash!.equals(first.thisHash)).toBe(true)
    expect(second.subjectId).toBe(first.subjectId)
  })

  it('three events on the same subject form a linked chain', async () => {
    const refId = newRefId()
    const baseTime = Date.UTC(2026, 4, 20, 12, 0, 0)
    const events = []
    for (let i = 0; i < 3; i++) {
      events.push(await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time', eventData: { i },
        occurredAt: new Date(baseTime + i * 1000),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      }))
    }
    expect(events[0].prevHash).toBeNull()
    expect(events[1].prevHash!.equals(events[0].thisHash)).toBe(true)
    expect(events[2].prevHash!.equals(events[1].thisHash)).toBe(true)
  })

  it('defaults eventData + attestationEvidence to empty objects when omitted', async () => {
    const refId = newRefId()
    const occurredAt = new Date('2026-05-20T12:00:00Z')
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt,
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    // Verify by recomputing with empty objects
    const expected = computeEventHash({
      prevHash:           null,
      eventData:          {},
      occurredAt,
      attestationSource:  'gam_workflow_auto',
      attestationEvidence: {},
    })
    expect(res.thisHash.equals(expected)).toBe(true)
  })

  it('honors a caller-owned transaction (rollback discards the event)', async () => {
    const refId = newRefId()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const res = await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time',
        occurredAt: new Date('2026-05-20T12:00:00Z'),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      }, client)
      expect(res.eventId).toBeTruthy()
      await client.query('ROLLBACK')
    } finally { client.release() }
    // Event should NOT have committed
    const count = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM credit_events`)
    expect(count.rows[0].n).toBe('0')
    const sid = await findSubjectId('tenant', refId)
    expect(sid).toBeNull()
  })

  it('honors a caller-owned transaction (commit persists the event)', async () => {
    const refId = newRefId()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time',
        occurredAt: new Date('2026-05-20T12:00:00Z'),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      }, client)
      await client.query('COMMIT')
    } finally { client.release() }
    const count = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM credit_events`)
    expect(count.rows[0].n).toBe('1')
  })

  it('stores eventData verbatim as JSONB', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      eventData: { rent_amount: 1500, lease_id: 'L1', nested: { foo: 'bar' } },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const row = await db.query<{ event_data: any }>(
      `SELECT event_data FROM credit_events WHERE id = $1`,
      [res.eventId],
    )
    expect(row.rows[0].event_data).toEqual({ rent_amount: 1500, lease_id: 'L1', nested: { foo: 'bar' } })
  })
})

// ─── getSubjectChain ───────────────────────────────────────────

describe('getSubjectChain', () => {
  it('returns events in recorded_at ASC + id ASC', async () => {
    const refId = newRefId()
    const ids = []
    for (let i = 0; i < 3; i++) {
      const res = await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time', eventData: { i },
        occurredAt: new Date(Date.UTC(2026, 4, 20, 12, 0, 0) + i * 1000),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      })
      ids.push(res.eventId)
    }
    const sid = (await findSubjectId('tenant', refId))!
    const chain = await getSubjectChain(sid)
    expect(chain.map(c => c.id)).toEqual(ids)
  })

  it('returns superseded events too (caller filters)', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const client = await db.connect()
    try {
      await supersedeEvent(client, a.eventId, b.eventId, 'correction_after_dispute')
    } finally { client.release() }
    const chain = await getSubjectChain(a.subjectId)
    expect(chain).toHaveLength(2)
    expect(chain[0].superseded_by).toBe(b.eventId)
  })
})

// ─── verifyChain ───────────────────────────────────────────────

describe('verifyChain', () => {
  it('empty chain → ok with eventCount 0', async () => {
    const client = await db.connect()
    let sid = ''
    try {
      sid = await getOrCreateSubject(client, 'tenant', newRefId())
    } finally { client.release() }
    const v = await verifyChain(sid)
    expect(v).toEqual({ ok: true, eventCount: 0 })
  })

  it('single valid event → ok', async () => {
    const refId = newRefId()
    await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const sid = (await findSubjectId('tenant', refId))!
    const v = await verifyChain(sid)
    expect(v.ok).toBe(true)
    expect(v.eventCount).toBe(1)
  })

  it('valid multi-event chain → ok', async () => {
    const refId = newRefId()
    for (let i = 0; i < 4; i++) {
      await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time', eventData: { i },
        occurredAt: new Date(Date.UTC(2026, 4, 20, 12, 0, 0) + i * 1000),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      })
    }
    const sid = (await findSubjectId('tenant', refId))!
    const v = await verifyChain(sid)
    expect(v.ok).toBe(true)
    expect(v.eventCount).toBe(4)
  })

  it('detects tampered this_hash', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const bogus = Buffer.alloc(32, 0xff)
    await db.query(`UPDATE credit_events SET this_hash = $1 WHERE id = $2`, [bogus, res.eventId])
    const v = await verifyChain(res.subjectId)
    expect(v.ok).toBe(false)
    expect(v.firstBadEventId).toBe(res.eventId)
    expect(v.reason).toMatch(/this_hash does not match/)
  })

  it('detects tampered event_data (re-hash diverges)', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      eventData: { amount: 1500 },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    await db.query(
      `UPDATE credit_events SET event_data = $1 WHERE id = $2`,
      [JSON.stringify({ amount: 9999 }), res.eventId],
    )
    const v = await verifyChain(res.subjectId)
    expect(v.ok).toBe(false)
    expect(v.firstBadEventId).toBe(res.eventId)
  })

  it('detects broken prev_hash linkage between consecutive events', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 1 },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 2 },
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    // Corrupt b.prev_hash so it no longer links back to a.this_hash
    await db.query(`UPDATE credit_events SET prev_hash = $1 WHERE id = $2`, [Buffer.alloc(32, 0x11), b.eventId])
    const v = await verifyChain(a.subjectId)
    expect(v.ok).toBe(false)
    expect(v.firstBadEventId).toBe(b.eventId)
    expect(v.reason).toMatch(/prev_hash does not match/)
  })

  it('detects first event with non-null prev_hash', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    // First event should have prev_hash=null; planting a non-null value
    // is the canonical tamper-detection scenario.
    await db.query(`UPDATE credit_events SET prev_hash = $1 WHERE id = $2`, [Buffer.alloc(32, 0x22), res.eventId])
    const v = await verifyChain(res.subjectId)
    expect(v.ok).toBe(false)
    expect(v.firstBadEventId).toBe(res.eventId)
    expect(v.reason).toMatch(/first event has non-null prev_hash/)
  })
})

// 10/12 (Nic: "one mark per invoice" — a correction appends a new mark and
// supersedes the old in ONE transaction, and the rebuild appends many): events
// one transaction appended for a subject used to share recorded_at (now(), the
// transaction's start), so the tip fell to the random id — a third append
// could fork the chain — and verifyChain, walking by (recorded_at, id), read a
// correct chain as tampered. Production carried both on 10/12.
describe('one transaction, many events: one path, in append order (10/12)', () => {
  const ev = (refId: string, i: number) => ({
    subjectType: 'tenant' as const, subjectRefId: refId,
    eventType: 'payment_received_on_time' as const, eventData: { i },
    occurredAt: new Date('2026-10-12T12:00:00Z'),
    attestationSource: 'gam_workflow_auto' as const,
    networkVisibility: 'visible_to_current_landlord' as const,
  })

  it('each event links to the one before it, recorded strictly later; the chain verifies', async () => {
    const refId = newRefId()
    const c = await db.connect()
    const ids: string[] = []
    try {
      await c.query('BEGIN')
      for (let i = 0; i < 6; i++) ids.push((await appendEvent(ev(refId, i), c)).eventId)
      await c.query('COMMIT')
    } finally { c.release() }
    const sid = (await findSubjectId('tenant', refId))!
    const chain = await getSubjectChain(sid)
    expect(chain.map(e => e.id)).toEqual(ids)
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].prev_hash!.equals(chain[i - 1].this_hash)).toBe(true)
      expect(new Date(chain[i].recorded_at).getTime()).toBeGreaterThanOrEqual(new Date(chain[i - 1].recorded_at).getTime())
    }
    expect(await verifyChain(sid)).toEqual({ ok: true, eventCount: 6 })
  })

  it('a tail of equal times written before 10/12: the next event links to the true end, and the links verify it', async () => {
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    const b = await appendEvent(ev(refId, 2))
    // As the old default wrote them: one recorded_at for both (id order now decides nothing).
    await db.query(`UPDATE credit_events SET recorded_at = '2026-10-01T12:00:00Z' WHERE id = ANY($1::uuid[])`, [[a.eventId, b.eventId]])
    const c = await appendEvent(ev(refId, 3))
    expect(c.prevHash!.equals(b.thisHash)).toBe(true)
    expect(await verifyChain(a.subjectId)).toEqual({ ok: true, eventCount: 3 })
  })

  it('a fork (two events after one) is reported, not read as a path', async () => {
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    const b = await appendEvent(ev(refId, 2))
    const c = await appendEvent(ev(refId, 3))
    // Plant the old bug's fork: c also follows a (its hash recomputed so only the link is wrong).
    const row = (await db.query<any>(`SELECT event_data, occurred_at, attestation_source, attestation_evidence FROM credit_events WHERE id = $1`, [c.eventId])).rows[0]
    const forged = computeEventHash({ prevHash: a.thisHash, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
      attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })
    await db.query(`UPDATE credit_events SET prev_hash = $1, this_hash = $2 WHERE id = $3`, [a.thisHash, forged, c.eventId])
    const v = await verifyChain(a.subjectId)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/prev_hash does not match prior event this_hash \(two events follow the same event: a fork\)/)
    expect([b.eventId, c.eventId]).toContain(v.firstBadEventId)
  })
})

// 10/13 (Nic, the 12 chains a pre-10/12 bug forked): "restart the chain from
// today for each, with a recorded note explaining the break (old entries
// untouched)". A restart is the first event of a new chain; it seals the old
// one, and verifyChain reads the chain as whole since the restart while
// reporting the old break as explained history.
describe('chain restart (10/13)', () => {
  const ev = (refId: string, i: number) => ({
    subjectType: 'tenant' as const, subjectRefId: refId,
    eventType: 'payment_received_on_time' as const, eventData: { i },
    occurredAt: new Date('2026-10-12T12:00:00Z'),
    attestationSource: 'gam_workflow_auto' as const,
    networkVisibility: 'visible_to_current_landlord' as const,
  })
  const NOTE = 'Restarted 10/13/2026: this record\'s chain split in two (a fork).'
  const TODAY = new Date('2026-10-13T16:00:00Z')

  /** Re-link an event to follow another, its hash recomputed so only the link is wrong. */
  async function relink(id: string, prevHash: Buffer) {
    const row = (await db.query<any>(`SELECT event_data, occurred_at, attestation_source, attestation_evidence FROM credit_events WHERE id = $1`, [id])).rows[0]
    const forged = computeEventHash({ prevHash, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
      attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })
    await db.query(`UPDATE credit_events SET prev_hash = $1, this_hash = $2 WHERE id = $3`, [prevHash, forged, id])
  }

  /** a → b, and c also after a: the old bug's fork; c is its first bad event. */
  async function forked() {
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    const b = await appendEvent(ev(refId, 2))
    const c = await appendEvent(ev(refId, 3))
    await relink(c.eventId, a.thisHash)
    return { refId, sid: a.subjectId, a, b, c }
  }

  const snapshot = async (sid: string) => (await db.query(
    `SELECT id, event_type, event_data, occurred_at, recorded_at, prev_hash, this_hash, superseded_by, superseded_reason
       FROM credit_events WHERE subject_id = $1 ORDER BY recorded_at, id`, [sid])).rows

  it('a forked chain restarted from today: one new first event with the note; every old entry untouched; whole since the restart, the fork reported', async () => {
    const f = await forked()
    expect(await verifyChain(f.sid)).toMatchObject({ ok: false, firstBadEventId: f.c.eventId, break: 'fork' })
    const before = await snapshot(f.sid)

    const r = await restartChain({ subjectId: f.sid, note: NOTE, occurredAt: TODAY })
    expect(r).toMatchObject({ subjectId: f.sid, prevHash: null, sealedEventCount: 3, brokenEventId: f.c.eventId })
    expect(r.splits).toEqual([{ eventId: f.a.eventId, followedBy: [f.b.eventId, f.c.eventId] }])
    expect(r.brokenReason).toMatch(/a fork/)

    // Old entries exactly as they were.
    const after = await snapshot(f.sid)
    expect(after.slice(0, 3)).toEqual(before)
    const restart = after[3]
    expect(restart).toMatchObject({ id: r.eventId, event_type: CHAIN_RESTART_EVENT, prev_hash: null, superseded_by: null })
    expect(new Date(restart.occurred_at).toISOString()).toBe(TODAY.toISOString())
    expect(restart.event_data).toEqual({
      note: NOTE,
      sealed_event_count: 3,
      sealed_end_hashes: [f.b.thisHash.toString('hex'), (before[2].this_hash as Buffer).toString('hex')].sort(),
      broken_event_id: f.c.eventId,
      broken_reason: r.brokenReason,
      splits: [{ event_id: f.a.eventId, followed_by: [f.b.eventId, f.c.eventId] }],
    })
    const meta = (await db.query(`SELECT attestation_source, network_visibility, dimension_tags FROM credit_events WHERE id = $1`, [r.eventId])).rows[0]
    expect(meta).toEqual({ attestation_source: 'system_derived', network_visibility: 'private_to_subject', dimension_tags: [] })

    const v = await verifyChain(f.sid, { readerRole: 'admin' })
    expect(v).toMatchObject({ ok: true, eventCount: 4 })
    expect(v.restarts).toHaveLength(1)
    expect(v.restarts![0]).toMatchObject({
      eventId: r.eventId, visibility: 'private_to_subject', note: NOTE, sealedEventCount: 3, brokenEventId: f.c.eventId,
      splits: [{ eventId: f.a.eventId, followedBy: [f.b.eventId, f.c.eventId] }],
    })
    expect(v.restarts![0].brokenReason).toMatch(/two events follow the same event: a fork/)
  })

  // 10/13 review: production's forks split up to seven ways at one entry, and
  // one chain (Jonathan Covey's) at two entries. The seal, the report and the
  // hashed note have to carry every split, not the first the walk meets.
  it('a chain split three ways, and again further on: the restart seals and reports every split', async () => {
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    const b = await appendEvent(ev(refId, 2))
    const c = await appendEvent(ev(refId, 3))
    await relink(c.eventId, a.thisHash)            // a: b, c
    const d = await appendEvent(ev(refId, 4))
    await relink(d.eventId, a.thisHash)            // a: b, c, d
    const dHash = (await readChain(db, a.subjectId)).find(x => x.id === d.eventId)!.this_hash
    const e = await appendEvent(ev(refId, 5))      // after d (the newest end)
    expect(e.prevHash!.equals(dHash)).toBe(true)
    const g = await appendEvent(ev(refId, 6))
    await relink(g.eventId, dHash)                 // d: e, g
    const splits = [
      { eventId: a.eventId, followedBy: [b.eventId, c.eventId, d.eventId] },
      { eventId: d.eventId, followedBy: [e.eventId, g.eventId] },
    ]
    // The walk stops at the first split; the restart check sees both.
    expect(await verifyChain(a.subjectId)).toMatchObject({ ok: false, firstBadEventId: c.eventId, break: 'fork' })
    expect(checkRestart(await readChain(db, a.subjectId))).toMatchObject({ ok: true, brokenEventId: c.eventId, liveEventCount: 6, splits })

    const r = await restartChain({ subjectId: a.subjectId, note: NOTE, expectBrokenEventId: c.eventId, expectSplits: splits })
    expect(r).toMatchObject({ sealedEventCount: 6, brokenEventId: c.eventId, splits })
    const data = (await db.query(`SELECT event_data FROM credit_events WHERE id = $1`, [r.eventId])).rows[0].event_data
    expect(data.splits).toEqual([
      { event_id: a.eventId, followed_by: [b.eventId, c.eventId, d.eventId] },
      { event_id: d.eventId, followed_by: [e.eventId, g.eventId] },
    ])
    expect(data.sealed_end_hashes).toHaveLength(4)   // b, c, e, g: one end per branch
    const v = await verifyChain(a.subjectId)
    expect(v).toMatchObject({ ok: true, eventCount: 7, restarts: [{ eventId: r.eventId, brokenEventId: c.eventId, splits }] })

    // A seal naming only the first split no longer matches what it sealed.
    await db.query(`UPDATE credit_events SET event_data = jsonb_set(event_data, '{splits}', $2::jsonb) WHERE id = $1`,
      [r.eventId, JSON.stringify(data.splits.slice(0, 1))])
    const row = (await readChain(db, a.subjectId)).find(x => x.id === r.eventId)!
    await db.query(`UPDATE credit_events SET this_hash = $2 WHERE id = $1`, [r.eventId, computeEventHash({
      prevHash: null, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
      attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })])
    expect(await verifyChain(a.subjectId)).toMatchObject({ ok: false, firstBadEventId: r.eventId, break: 'restart_mismatch' })
  })

  it('refused: splits other than the ones the note was written from — nothing written', async () => {
    const f = await forked()
    await expect(restartChain({ subjectId: f.sid, note: NOTE, expectSplits: [{ eventId: f.a.eventId, followedBy: [f.b.eventId] }] }))
      .rejects.toThrow(/does not split where expected/)
    expect(await snapshot(f.sid)).toHaveLength(3)
  })

  // 10/13 (Nic): "Restart note: ADMIN ONLY." The integrity route returns
  // verifyChain to every reader canViewSubject lets in — the subject itself,
  // its landlords, network landlords. The note goes to an admin or super_admin
  // alone (the restart's 'private_to_subject' tier is not enough); the proof
  // to anyone.
  it('the note is returned to an admin or super_admin only — never a tenant or a landlord, the subject included; the proof to anyone', async () => {
    const f = await forked()
    const r = await restartChain({ subjectId: f.sid, note: NOTE })
    const proof = { eventId: r.eventId, sealedEventCount: 3, brokenEventId: f.c.eventId, splits: r.splits }
    for (const readerRole of [undefined, null, '', 'tenant', 'landlord', 'property_manager', 'onsite_manager', 'bookkeeper', 'Admin']) {
      const v = await verifyChain(f.sid, readerRole === undefined ? {} : { readerRole })
      expect(v).toMatchObject({ ok: true, restarts: [proof] })
      expect(v.restarts![0]).not.toHaveProperty('note')
    }
    for (const readerRole of ['admin', 'super_admin']) {
      const v = await verifyChain(f.sid, { readerRole })
      expect(v.restarts![0]).toMatchObject({ ...proof, note: NOTE })
    }
  })

  it('later marks link from the restart; the restart is never part of the credit history', async () => {
    const f = await forked()
    const r = await restartChain({ subjectId: f.sid, note: NOTE })
    const d = await appendEvent(ev(f.refId, 4))
    const e = await appendEvent(ev(f.refId, 5))
    expect(d.prevHash!.equals(r.thisHash)).toBe(true)
    expect(e.prevHash!.equals(d.thisHash)).toBe(true)
    expect(await verifyChain(f.sid)).toMatchObject({ ok: true, eventCount: 6, restarts: [{ eventId: r.eventId }] })
    // History (the credit screens, the score, the stats): the marks, not the restart.
    expect((await getSubjectChain(f.sid)).map(x => x.id)).toEqual([f.a.eventId, f.b.eventId, f.c.eventId, d.eventId, e.eventId])
    // The chain itself: everything, in append order.
    expect((await readChain(db, f.sid)).map(x => x.id)).toEqual([f.a.eventId, f.b.eventId, f.c.eventId, r.eventId, d.eventId, e.eventId])
  })

  it('a whole chain is never restarted, and a restarted one is whole: a second run finds nothing to do', async () => {
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    await appendEvent(ev(refId, 2))
    await expect(restartChain({ subjectId: a.subjectId, note: NOTE })).rejects.toThrow(/whole: nothing to restart/)
    expect(await verifyChain(a.subjectId)).toEqual({ ok: true, eventCount: 2 })

    const f = await forked()
    await restartChain({ subjectId: f.sid, note: NOTE })
    expect(checkRestart(await readChain(db, f.sid))).toMatchObject({ ok: false, why: 'the chain is whole: nothing to restart', liveEventCount: 1 })
    await expect(restartChain({ subjectId: f.sid, note: NOTE })).rejects.toThrow(/whole: nothing to restart/)
    expect((await snapshot(f.sid))).toHaveLength(4)
  })

  it('refused: a note-less restart, a break other than a fork, altered contents, a break somewhere else than named — nothing written', async () => {
    const f = await forked()
    await expect(restartChain({ subjectId: f.sid, note: '   ' })).rejects.toThrow(/needs a note/)
    await expect(restartChain({ subjectId: f.sid, note: NOTE, expectBrokenEventId: f.b.eventId }))
      .rejects.toThrow(`breaks at ${f.c.eventId}, not ${f.b.eventId}`)

    // Altered contents on one branch: a restart would hide it.
    const g = await forked()
    await db.query(`UPDATE credit_events SET event_data = '{"i": 99}' WHERE id = $1`, [g.b.eventId])
    await expect(restartChain({ subjectId: g.sid, note: NOTE })).rejects.toThrow(`event ${g.b.eventId} no longer matches its hash`)

    // An entry that follows nothing (not a fork).
    const refId = newRefId()
    const a = await appendEvent(ev(refId, 1))
    const b = await appendEvent(ev(refId, 2))
    await relink(b.eventId, Buffer.alloc(32, 0x11))
    expect(await verifyChain(a.subjectId)).toMatchObject({ ok: false, break: 'unlinked' })
    await expect(restartChain({ subjectId: a.subjectId, note: NOTE })).rejects.toThrow(/broken by unlinked .* not a fork/)

    // A fork AND an entry that follows nothing (10/13 review): the walk meets
    // the fork first, but a restart would explain only the fork.
    const h = await forked()
    const stray = await appendEvent(ev(h.refId, 4))
    await relink(stray.eventId, Buffer.alloc(32, 0x22))
    expect(await verifyChain(h.sid)).toMatchObject({ ok: false, firstBadEventId: h.c.eventId, break: 'fork' })
    await expect(restartChain({ subjectId: h.sid, note: NOTE }))
      .rejects.toThrow(`event ${stray.eventId} attaches to no entry of the chain, not a fork`)

    for (const sid of [f.sid, g.sid]) expect(await snapshot(sid)).toHaveLength(3)
    expect(await snapshot(a.subjectId)).toHaveLength(2)
    expect(await snapshot(h.sid)).toHaveLength(4)
  })

  it('the old entries stay checked after a restart: altered contents, a removed entry, an edited note or a forged restart all read as broken', async () => {
    // Altered contents of an entry before the restart.
    const f1 = await forked()
    await restartChain({ subjectId: f1.sid, note: NOTE })
    await db.query(`UPDATE credit_events SET event_data = '{"i": 42}' WHERE id = $1`, [f1.a.eventId])
    expect(await verifyChain(f1.sid)).toMatchObject({ ok: false, firstBadEventId: f1.a.eventId, break: 'tampered' })

    // An entry before the restart removed: the restart no longer matches what it sealed.
    const f2 = await forked()
    const r2 = await restartChain({ subjectId: f2.sid, note: NOTE })
    await db.query(`DELETE FROM credit_events WHERE id = $1`, [f2.b.eventId])
    expect(await verifyChain(f2.sid)).toMatchObject({ ok: false, firstBadEventId: r2.eventId, break: 'restart_mismatch' })

    // The note edited after the fact: the restart's own hash no longer holds.
    const f3 = await forked()
    const r3 = await restartChain({ subjectId: f3.sid, note: NOTE })
    await db.query(`UPDATE credit_events SET event_data = jsonb_set(event_data, '{note}', '"something else"') WHERE id = $1`, [r3.eventId])
    expect(await verifyChain(f3.sid)).toMatchObject({ ok: false, firstBadEventId: r3.eventId, break: 'tampered' })

    // A restart written by hand that does not seal the chain before it.
    const f4 = await forked()
    const c = await db.connect()
    let forgedId = ''
    try {
      const data = { note: NOTE, sealed_event_count: 1, sealed_end_hashes: [], broken_event_id: null, broken_reason: null }
      const at = new Date('2026-10-13T16:00:00Z')
      const h = computeEventHash({ prevHash: null, eventData: data, occurredAt: at, attestationSource: 'system_derived', attestationEvidence: {} })
      forgedId = (await c.query(
        `INSERT INTO credit_events (subject_id, event_type, event_data, occurred_at, attestation_source, attestation_evidence,
                                    dimension_tags, network_visibility, prev_hash, this_hash, recorded_at)
         VALUES ($1, 'chain_restarted', $2, $3, 'system_derived', '{}', '{}', 'private_to_subject', NULL, $4, clock_timestamp() + interval '1 second')
         RETURNING id`, [f4.sid, JSON.stringify(data), at, h])).rows[0].id
    } finally { c.release() }
    expect(await verifyChain(f4.sid)).toMatchObject({ ok: false, firstBadEventId: forgedId, break: 'restart_mismatch' })

    // A restart written by hand whose seal matches a chain broken some other
    // way (an entry that follows nothing): a restart explains only a fork, so
    // the break before it stays a break.
    const refId = newRefId()
    const a5 = await appendEvent(ev(refId, 1))
    const b5 = await appendEvent(ev(refId, 2))
    await relink(b5.eventId, Buffer.alloc(32, 0x11))
    const sealed = await readChain(db, a5.subjectId)
    const c5 = await db.connect()
    try {
      const data = {
        note: NOTE, sealed_event_count: 2, sealed_end_hashes: sealed.map(x => x.this_hash.toString('hex')).sort(),
        broken_event_id: b5.eventId, broken_reason: 'prev_hash does not match prior event this_hash', splits: [],
      }
      const at = new Date('2026-10-13T16:00:00Z')
      const h = computeEventHash({ prevHash: null, eventData: data, occurredAt: at, attestationSource: 'system_derived', attestationEvidence: {} })
      await c5.query(
        `INSERT INTO credit_events (subject_id, event_type, event_data, occurred_at, attestation_source, attestation_evidence,
                                    dimension_tags, network_visibility, prev_hash, this_hash, recorded_at)
         VALUES ($1, 'chain_restarted', $2, $3, 'system_derived', '{}', '{}', 'private_to_subject', NULL, $4, clock_timestamp() + interval '1 second')`,
        [a5.subjectId, JSON.stringify(data), at, h])
    } finally { c5.release() }
    const v5 = await verifyChain(a5.subjectId)
    expect(v5).toMatchObject({ ok: false, firstBadEventId: b5.eventId, break: 'unlinked' })
    expect(v5.reason).toMatch(/the restart after it explains only a fork/)
  })

  it('the chain since the restart must be whole: a fork after it is a break, the earlier restart still listed', async () => {
    const f = await forked()
    const r = await restartChain({ subjectId: f.sid, note: NOTE })
    const d = await appendEvent(ev(f.refId, 4))
    const e = await appendEvent(ev(f.refId, 5))
    await relink(e.eventId, r.thisHash)
    const v = await verifyChain(f.sid)
    expect(v).toMatchObject({ ok: false, firstBadEventId: e.eventId, break: 'fork', restarts: [{ eventId: r.eventId }] })
    // ...and that fork is restarted in turn: two restarts, each explaining its own break.
    const r2 = await restartChain({ subjectId: f.sid, note: 'second', expectBrokenEventId: e.eventId })
    const w = await verifyChain(f.sid)
    expect(w).toMatchObject({ ok: true, eventCount: 7 })
    expect(w.restarts!.map(x => [x.eventId, x.sealedEventCount, x.brokenEventId])).toEqual([
      [r.eventId, 3, f.c.eventId],
      [r2.eventId, 3, e.eventId],
    ])
    expect(d.prevHash!.equals(r.thisHash)).toBe(true)
  })

  it('verifyAllChains tells whole, whole since a restart, and broken apart', async () => {
    const refId = newRefId()
    await appendEvent(ev(refId, 1))
    const restarted = await forked()
    const r = await restartChain({ subjectId: restarted.sid, note: NOTE })
    const broken = await forked()
    const all = await verifyAllChains()
    expect(all).toMatchObject({ subjects: 3, ok: 1, okAfterRestart: 1 })
    expect(all.bad).toEqual([{ subjectId: broken.sid, firstBadEventId: broken.c.eventId, reason: expect.stringMatching(/a fork/), break: 'fork' }])
    expect(all.restarted).toEqual([{ subjectId: restarted.sid, restarts: [expect.objectContaining({ eventId: r.eventId, note: NOTE })] }])
  })

  it('a subject whose only live entry is its restart is not counted by the nightly stats', async () => {
    const f = await forked()
    const c = await db.connect()
    try {
      for (const id of [f.a.eventId, f.b.eventId, f.c.eventId]) await supersedeEvent(c, id, id, 'withdrawn_no_bill')
    } finally { c.release() }
    await restartChain({ subjectId: f.sid, note: NOTE })
    expect((await refreshAllSubjectStats()).processed).toBe(0)
    expect(await verifyChain(f.sid)).toMatchObject({ ok: true, eventCount: 4 })
  })

  // creditScore.recomputeAllSubjects (the 03:00 nightly): a restart is not a
  // mark, so a subject whose only live event is its restart is never scored;
  // one with a live mark beside its restart still is.
  it('a subject whose only live entry is its restart is not scored by the nightly recompute', async () => {
    const VERSION = 'test-10.13-restart'
    await db.query(
      `INSERT INTO credit_score_formulas (version, definition, description, effective_from)
       VALUES ($1, $2, 'test formula', NOW() - interval '1 day')`,
      [VERSION, JSON.stringify({
        model: 'unbounded_multiplicative', starting_score: 100, floor: 0,
        positives: { payment_received_on_time: 1 }, negatives: {},
        attestation_weight: { gam_workflow_auto: 1 }, spam_caps: {},
      })])
    try {
      const onlyRestart = await forked()
      const c = await db.connect()
      try {
        for (const id of [onlyRestart.a.eventId, onlyRestart.b.eventId, onlyRestart.c.eventId]) {
          await supersedeEvent(c, id, id, 'withdrawn_no_bill')
        }
      } finally { c.release() }
      await restartChain({ subjectId: onlyRestart.sid, note: NOTE })
      const withMark = await forked()
      await restartChain({ subjectId: withMark.sid, note: NOTE })

      expect(await recomputeAllSubjects()).toEqual({ processed: 1, errors: [] })
      const scored = (await db.query<{ subject_id: string; event_count: number }>(
        `SELECT subject_id, event_count FROM credit_scores`)).rows
      expect(scored).toEqual([{ subject_id: withMark.sid, event_count: 3 }])
    } finally {
      await db.query(`DELETE FROM credit_scores WHERE formula_version = $1`, [VERSION])
      await db.query(`DELETE FROM credit_score_formulas WHERE version = $1`, [VERSION])
    }
  })
})

// ─── computeMerkleRoot ─────────────────────────────────────────

describe('computeMerkleRoot', () => {
  it('empty ledger → ZERO_HASH root, eventCount=0', async () => {
    const r = await computeMerkleRoot()
    expect(r.root.equals(Buffer.alloc(32, 0))).toBe(true)
    expect(r.eventCount).toBe(0)
    expect(r.earliestEventId).toBeNull()
    expect(r.latestEventId).toBeNull()
  })

  it('single event → root equals that event\'s this_hash', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const r = await computeMerkleRoot()
    expect(r.eventCount).toBe(1)
    expect(r.root.equals(res.thisHash)).toBe(true)
    expect(r.earliestEventId).toBe(res.eventId)
    expect(r.latestEventId).toBe(res.eventId)
  })

  it('two events → root = sha256(leaf1 || leaf2)', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 1 },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 2 },
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const r = await computeMerkleRoot()
    expect(r.eventCount).toBe(2)
    const expectedRoot = createHash('sha256').update(a.thisHash).update(b.thisHash).digest()
    expect(r.root.equals(expectedRoot)).toBe(true)
  })

  it('three events → odd-node duplication at last level', async () => {
    const refId = newRefId()
    const evts = []
    for (let i = 0; i < 3; i++) {
      evts.push(await appendEvent({
        subjectType: 'tenant', subjectRefId: refId,
        eventType: 'payment_received_on_time', eventData: { i },
        occurredAt: new Date(Date.UTC(2026, 4, 20, 12, 0, 0) + i * 1000),
        attestationSource: 'gam_workflow_auto',
        networkVisibility: 'visible_to_current_landlord',
      }))
    }
    const r = await computeMerkleRoot()
    expect(r.eventCount).toBe(3)
    // Level 0: leaf0, leaf1, leaf2
    // Level 1: hash(leaf0||leaf1), hash(leaf2||leaf2)   (odd duplicates)
    // Level 2: hash(l1[0]||l1[1])
    const l1a = createHash('sha256').update(evts[0].thisHash).update(evts[1].thisHash).digest()
    const l1b = createHash('sha256').update(evts[2].thisHash).update(evts[2].thisHash).digest()
    const root = createHash('sha256').update(l1a).update(l1b).digest()
    expect(r.root.equals(root)).toBe(true)
  })

  it('excludes superseded events from the root', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 1 },
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time', eventData: { i: 2 },
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    // Mark a as superseded by b
    const client = await db.connect()
    try {
      await supersedeEvent(client, a.eventId, b.eventId, 'correction_after_dispute')
    } finally { client.release() }
    const r = await computeMerkleRoot()
    // Only b is active — root should equal b.thisHash directly
    expect(r.eventCount).toBe(1)
    expect(r.root.equals(b.thisHash)).toBe(true)
    expect(r.earliestEventId).toBe(b.eventId)
  })
})

// ─── supersedeEvent + findSubjectId ────────────────────────────

describe('supersedeEvent', () => {
  it('marks the original event as superseded by the correction', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const client = await db.connect()
    try {
      await supersedeEvent(client, a.eventId, b.eventId, 'correction_after_dispute')
    } finally { client.release() }
    const row = await db.query<{ superseded_by: string; superseded_reason: string }>(
      `SELECT superseded_by, superseded_reason FROM credit_events WHERE id = $1`,
      [a.eventId],
    )
    expect(row.rows[0].superseded_by).toBe(b.eventId)
    expect(row.rows[0].superseded_reason).toBe('correction_after_dispute')
  })

  it('original event stays in the chain (append-only invariant)', async () => {
    const refId = newRefId()
    const a = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const b = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T13:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const client = await db.connect()
    try {
      await supersedeEvent(client, a.eventId, b.eventId, 'correction_after_dispute')
    } finally { client.release() }
    const chain = await getSubjectChain(a.subjectId)
    expect(chain.map(c => c.id)).toEqual([a.eventId, b.eventId])
    // Hash chain still verifies — superseded_by is metadata only
    const v = await verifyChain(a.subjectId)
    expect(v.ok).toBe(true)
  })
})

describe('findSubjectId', () => {
  it('returns null when subject does not exist', async () => {
    const id = await findSubjectId('tenant', newRefId())
    expect(id).toBeNull()
  })

  it('returns id after appendEvent materializes the subject', async () => {
    const refId = newRefId()
    const res = await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const id = await findSubjectId('tenant', refId)
    expect(id).toBe(res.subjectId)
  })

  it('returns null for the wrong subject_type', async () => {
    const refId = newRefId()
    await appendEvent({
      subjectType: 'tenant', subjectRefId: refId,
      eventType: 'payment_received_on_time',
      occurredAt: new Date('2026-05-20T12:00:00Z'),
      attestationSource: 'gam_workflow_auto',
      networkVisibility: 'visible_to_current_landlord',
    })
    const id = await findSubjectId('landlord', refId)
    expect(id).toBeNull()
  })
})
