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
} from './creditLedger'

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
