/**
 * entryRequests route slice — S351.
 *
 * Landlord-initiated unit-entry workflow per CLAUDE.md credit-ledger
 * spec. Lifecycle: create → tenant responds (grant/deny) → landlord
 * records actual entry → outcome (compliant or breach) emits to
 * credit_events. Or: landlord cancels before record-entry.
 *
 * Coverage focus:
 *   - create: happy / forbidden cross-landlord / invalid window
 *   - respond: tenant grants / wrong tenant 403 / re-respond on
 *     non-pending 409
 *   - record-entry: within-window+granted = compliant /
 *     outside-window = breach / cannot record on terminal status
 *   - cancel: landlord cancels pending
 *   - loadRequest scope: tenant can only see own / landlord can
 *     only see own landlord's
 *
 * Credit-ledger emitters and notify* helpers mocked — credit_events
 * mechanics are covered by their own suite; this slice tests the
 * route contract.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
} from '../test/dbHelpers'

const {
  emitEntryRequestResponseEventsMock,
  emitEntryRecordedEventsMock,
  notifyEntryRequestNewMock,
  notifyEntryRequestRespondedMock,
  notifyEntryRecordedMock,
  getPropertyResponsiblePartyMock,
} = vi.hoisted(() => ({
  emitEntryRequestResponseEventsMock: vi.fn(async (..._args: any[]) => undefined),
  // Default outcome — tests can override per case
  emitEntryRecordedEventsMock:        vi.fn(async (..._args: any[]) => ({ outcome: 'compliant' as 'compliant' | 'breach' })),
  notifyEntryRequestNewMock:          vi.fn(async (..._args: any[]) => undefined),
  notifyEntryRequestRespondedMock:    vi.fn(async (..._args: any[]) => undefined),
  notifyEntryRecordedMock:            vi.fn(async (..._args: any[]) => undefined),
  getPropertyResponsiblePartyMock:    vi.fn(async (..._args: any[]) => null),
}))
vi.mock('../services/creditLedgerEmitters', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    emitEntryRequestResponseEvents: emitEntryRequestResponseEventsMock,
    emitEntryRecordedEvents:        emitEntryRecordedEventsMock,
  }
})
vi.mock('../services/notifications', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    notifyEntryRequestNew:       notifyEntryRequestNewMock,
    notifyEntryRequestResponded: notifyEntryRequestRespondedMock,
    notifyEntryRecorded:         notifyEntryRecordedMock,
  }
})
vi.mock('../services/responsibleParty', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getPropertyResponsibleParty: getPropertyResponsiblePartyMock }
})

import { entryRequestsRouter } from './entryRequests'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/entry-requests', entryRequestsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emitEntryRequestResponseEventsMock.mockClear()
  emitEntryRecordedEventsMock.mockClear()
  emitEntryRecordedEventsMock.mockResolvedValue({ outcome: 'compliant' })
  notifyEntryRequestNewMock.mockClear()
  notifyEntryRequestRespondedMock.mockClear()
  notifyEntryRecordedMock.mockClear()
  getPropertyResponsiblePartyMock.mockClear()
  getPropertyResponsiblePartyMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_er'
})

interface ERFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  tenantId:       string
  tenantUserId:   string
  landlordToken:  string
  tenantToken:    string
}

async function seedERFixture(): Promise<ERFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    const tenantUserId = tu.rows[0].user_id
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const tenantToken = jwt.sign(
      { userId: tenantUserId, role: 'tenant', email: 'tn@test.dev', profileId: tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, unitId, tenantId, tenantUserId, landlordToken, tenantToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

interface CreateOpts {
  unitId?:        string
  tenantId?:      string
  reasonCategory?: 'maintenance' | 'inspection' | 'showing' | 'emergency' | 'other'
  windowStartIso?: string
  windowEndIso?:  string
}

async function createRequest(
  f: ERFixture, token: string, opts: CreateOpts = {},
) {
  return request(buildApp())
    .post('/api/entry-requests')
    .set('Authorization', `Bearer ${token}`)
    .send({
      unitId:                   opts.unitId   ?? f.unitId,
      tenantId:                 opts.tenantId ?? f.tenantId,
      reason:                   'Filter inspection',
      reasonCategory:           opts.reasonCategory ?? 'inspection',
      proposedEntryWindowStart: opts.windowStartIso ?? '2026-07-01T14:00:00Z',
      proposedEntryWindowEnd:   opts.windowEndIso   ?? '2026-07-01T16:00:00Z',
    })
}

describe('POST /api/entry-requests — create', () => {
  it('happy path: inserts pending row, returns id + notice_window math', async () => {
    const f = await seedERFixture()
    // Default notice window = 24h, so any future window >> 24h returns
    // notice_window_meets_default=true. Use a window ~36h out.
    const futureStart = new Date(Date.now() + 36 * 3_600_000).toISOString()
    const futureEnd   = new Date(Date.now() + 38 * 3_600_000).toISOString()
    const res = await createRequest(f, f.landlordToken,
      { windowStartIso: futureStart, windowEndIso: futureEnd })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.data.notice_window_meets_default).toBe(true)
    expect(res.body.data.notice_window_hours).toBeGreaterThanOrEqual(35)

    const row = await db.query<{ status: string; reason_category: string }>(
      `SELECT status, reason_category FROM unit_entry_requests WHERE id=$1`,
      [res.body.data.id])
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].reason_category).toBe('inspection')

    expect(notifyEntryRequestNewMock).toHaveBeenCalledTimes(1)
  })

  it('cross-landlord unit → 403 (forbidden)', async () => {
    const a = await seedERFixture()
    const b = await seedERFixture()
    // a's landlord token attempts to create against b's unit
    const res = await createRequest(a, a.landlordToken, { unitId: b.unitId, tenantId: b.tenantId })
    expect(res.status).toBe(403)
    const rows = await db.query(`SELECT id FROM unit_entry_requests`)
    expect(rows.rows.length).toBe(0)
  })

  it('S351 F1: random tenantId UUID → 404 "Tenant not found" (post-S351 fix)', async () => {
    // Pre-S351: 500 with raw postgres FK violation
    // (unit_entry_requests_tenant_id_fkey). Post-S351 the route
    // pre-checks tenant existence and returns 404 with a clean error.
    const f = await seedERFixture()
    const res = await createRequest(f, f.landlordToken, { tenantId: randomUUID() })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Tenant not found/)
    const rows = await db.query(`SELECT id FROM unit_entry_requests`)
    expect(rows.rows.length).toBe(0)
  })

  it('window end before window start → 400', async () => {
    const f = await seedERFixture()
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-01T16:00:00Z',
      windowEndIso:   '2026-07-01T14:00:00Z',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/window end must be after/)
  })

  // ───────────────────────────────────────────────────────────────
  //  S475: outside-typical-hours flag (no state-specific advice)
  // ───────────────────────────────────────────────────────────────

  it('S475: normal-hours start (10am Phoenix) → outside_typical_hours=false', async () => {
    const f = await seedERFixture()
    // seedProperty defaults timezone to America/Phoenix (no DST), so
    // 17:00 UTC = 10:00 Phoenix.
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-01T17:00:00Z',
      windowEndIso:   '2026-07-01T18:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(false)
    expect(res.body.data.typical_hours_warning).toBeNull()
  })

  it('S475: pre-8am start (5am Phoenix) → outside_typical_hours=true + hedged warning', async () => {
    const f = await seedERFixture()
    // 12:00 UTC = 05:00 Phoenix (UTC-7, no DST).
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-01T12:00:00Z',
      windowEndIso:   '2026-07-01T13:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(true)
    expect(res.body.data.typical_hours_warning).toMatch(/typical daytime/i)
    expect(res.body.data.typical_hours_warning).toMatch(/check your local law/i)
  })

  it('S475: post-8pm start (9pm Phoenix) → outside_typical_hours=true', async () => {
    const f = await seedERFixture()
    // 04:00 UTC next day = 21:00 Phoenix prior day.
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-02T04:00:00Z',
      windowEndIso:   '2026-07-02T05:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(true)
  })

  it('S475: exact-8am edge → false (>= 8 only flips at < 8)', async () => {
    const f = await seedERFixture()
    // 15:00 UTC = 08:00 Phoenix.
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-01T15:00:00Z',
      windowEndIso:   '2026-07-01T16:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(false)
  })

  it('S475: exact-8pm edge → true (>= 20)', async () => {
    const f = await seedERFixture()
    // 03:00 UTC next day = 20:00 Phoenix prior day.
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-02T03:00:00Z',
      windowEndIso:   '2026-07-02T04:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────
  //  S476: state-law mismatch flag (entry_notice_hours)
  // ───────────────────────────────────────────────────────────────

  // schema.sql is schema-only — the state_law seed migrations
  // INSERT data, not picked up by the snapshot. Seed inline.
  async function seedAzEntryNoticeStatute(): Promise<void> {
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO state_landlord_tenant_acts
         (state_code, act_key, act_name, unit_types, source_date, effective_year)
       VALUES ('AZ', 'residential', 'AZ Residential Landlord-Tenant Act',
               ARRAY['apartment','single_family']::text[], '2026-06-09', 2026)
       ON CONFLICT DO NOTHING
       RETURNING id`)
    const actId = a?.id ?? (await db.query<{ id: string }>(
      `SELECT id FROM state_landlord_tenant_acts WHERE state_code='AZ' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
    await db.query(
      `INSERT INTO state_law_provisions
         (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
          summary, statute_citation, source_url, source_date, effective_year)
       VALUES ($1, 'AZ', 'entry_notice_hours', 'min', 48, 'hours',
               'Landlord must give at least two days notice before entry',
               'A.R.S. § 33-1343', 'https://www.azleg.gov/ars/33/01343.htm',
               '2026-06-09', 2026)
       ON CONFLICT DO NOTHING`, [actId])
  }

  it('S476: AZ residential 30h notice (below 48h statute) → state_law_warnings nonempty', async () => {
    const f = await seedERFixture()
    await seedAzEntryNoticeStatute()
    // 30h notice = below AZ § 33-1343's 48h minimum.
    const futureStart = new Date(Date.now() + 30 * 3_600_000).toISOString()
    const futureEnd   = new Date(Date.now() + 31 * 3_600_000).toISOString()
    const res = await createRequest(f, f.landlordToken,
      { windowStartIso: futureStart, windowEndIso: futureEnd })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.state_law_warnings)).toBe(true)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    const flag = res.body.data.state_law_warnings[0]
    expect(flag.topic).toBe('entry_notice_hours')
    expect(flag.message).toMatch(/below the 48/)
    expect(flag.message).toMatch(/AZ/)
    expect(flag.disclaimer).toMatch(/may be out of date/i)
  })

  it('S476: AZ residential 60h notice (above 48h statute) → state_law_warnings empty', async () => {
    const f = await seedERFixture()
    await seedAzEntryNoticeStatute()
    const futureStart = new Date(Date.now() + 60 * 3_600_000).toISOString()
    const futureEnd   = new Date(Date.now() + 61 * 3_600_000).toISOString()
    const res = await createRequest(f, f.landlordToken,
      { windowStartIso: futureStart, windowEndIso: futureEnd })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S476: uncatalogued state → state_law_warnings empty (no false alarm)', async () => {
    const f = await seedERFixture()
    // Move the property to a fake state with no provisions seeded.
    await db.query(`UPDATE properties SET state = 'XX' WHERE id = $1`, [f.propertyId])
    const futureStart = new Date(Date.now() + 30 * 3_600_000).toISOString()
    const futureEnd   = new Date(Date.now() + 31 * 3_600_000).toISOString()
    const res = await createRequest(f, f.landlordToken,
      { windowStartIso: futureStart, windowEndIso: futureEnd })
    expect(res.status).toBe(200)
    expect(res.body.data.state_law_warnings).toEqual([])
  })

  it('S475: property timezone respected (Eastern 9pm = same UTC as Pacific 6pm)', async () => {
    const f = await seedERFixture()
    // Move the property to America/New_York. 01:00 UTC = 21:00 ET
    // (during EDT) — outside hours. Same UTC time in America/Los_Angeles
    // would be 18:00 PT — inside hours.
    await db.query(
      `UPDATE properties SET timezone = 'America/New_York' WHERE id = $1`,
      [f.propertyId])
    const res = await createRequest(f, f.landlordToken, {
      windowStartIso: '2026-07-02T01:00:00Z',
      windowEndIso:   '2026-07-02T02:00:00Z',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(true)
  })
})

describe('POST /api/entry-requests/:id/respond', () => {
  it('tenant grants happy path: status→granted, response row inserted, emitter called', async () => {
    const f = await seedERFixture()
    const futureStart = new Date(Date.now() + 36 * 3_600_000).toISOString()
    const futureEnd   = new Date(Date.now() + 38 * 3_600_000).toISOString()
    const c = await createRequest(f, f.landlordToken,
      { windowStartIso: futureStart, windowEndIso: futureEnd })
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ decision: 'granted', reason: 'sure' })
    expect(res.status).toBe(200)
    expect(res.body.data.decision).toBe('granted')

    const row = await db.query<{ status: string }>(
      `SELECT status FROM unit_entry_requests WHERE id=$1`, [reqId])
    expect(row.rows[0].status).toBe('granted')
    const respRow = await db.query<{ decision: string; reason: string }>(
      `SELECT decision, reason FROM unit_entry_request_responses WHERE request_id=$1`,
      [reqId])
    expect(respRow.rows.length).toBe(1)
    expect(respRow.rows[0].decision).toBe('granted')
    expect(respRow.rows[0].reason).toBe('sure')

    expect(emitEntryRequestResponseEventsMock).toHaveBeenCalledTimes(1)
    const call = emitEntryRequestResponseEventsMock.mock.calls[0]![1] as any
    expect(call.tenantId).toBe(f.tenantId)
    expect(call.decision).toBe('granted')
  })

  it('wrong tenant attempting to respond → 403', async () => {
    const a = await seedERFixture()
    const b = await seedERFixture()
    const c = await createRequest(a, a.landlordToken)
    const reqId = c.body.data.id

    // b's tenant tries to respond to a's request
    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${b.tenantToken}`)
      .send({ decision: 'granted' })
    expect(res.status).toBe(403)
    expect(emitEntryRequestResponseEventsMock).not.toHaveBeenCalled()

    const row = await db.query<{ status: string }>(
      `SELECT status FROM unit_entry_requests WHERE id=$1`, [reqId])
    expect(row.rows[0].status).toBe('pending')
  })

  it('responding to a non-pending request → 409', async () => {
    const f = await seedERFixture()
    const c = await createRequest(f, f.landlordToken)
    const reqId = c.body.data.id

    // First response → granted
    const r1 = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ decision: 'granted' })
    expect(r1.status).toBe(200)

    // Second attempt → 409 because status is now 'granted'
    const r2 = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ decision: 'denied' })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toMatch(/cannot respond to request in status granted/)
  })
})

describe('POST /api/entry-requests/:id/record-entry', () => {
  it('within-window + granted → outcome=compliant, status=completed', async () => {
    const f = await seedERFixture()
    const c = await createRequest(f, f.landlordToken)
    const reqId = c.body.data.id

    // Tenant grants first
    await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ decision: 'granted' })

    emitEntryRecordedEventsMock.mockResolvedValueOnce({ outcome: 'compliant' })
    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/record-entry`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ enteredAt: '2026-07-01T14:30:00Z', notes: 'all good' })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('compliant')

    const row = await db.query<{ status: string; notes: string }>(
      `SELECT status, notes FROM unit_entry_requests WHERE id=$1`, [reqId])
    expect(row.rows[0].status).toBe('completed')
    expect(row.rows[0].notes).toBe('all good')

    // Emitter received grantedDecision='granted'
    const emitArgs = emitEntryRecordedEventsMock.mock.calls[0]![1] as any
    expect(emitArgs.grantedDecision).toBe('granted')
  })

  it('outside-window or denied → outcome=breach, status=breached', async () => {
    const f = await seedERFixture()
    const c = await createRequest(f, f.landlordToken)
    const reqId = c.body.data.id

    // Tenant denies
    await request(buildApp())
      .post(`/api/entry-requests/${reqId}/respond`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
      .send({ decision: 'denied' })

    emitEntryRecordedEventsMock.mockResolvedValueOnce({ outcome: 'breach' })
    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/record-entry`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ enteredAt: '2026-07-01T14:30:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.data.outcome).toBe('breach')

    const row = await db.query<{ status: string }>(
      `SELECT status FROM unit_entry_requests WHERE id=$1`, [reqId])
    expect(row.rows[0].status).toBe('breached')

    const emitArgs = emitEntryRecordedEventsMock.mock.calls[0]![1] as any
    expect(emitArgs.grantedDecision).toBe('denied')
  })

  it('cannot record entry on a cancelled request → 409', async () => {
    const f = await seedERFixture()
    const c = await createRequest(f, f.landlordToken)
    const reqId = c.body.data.id

    // Cancel first
    await request(buildApp())
      .post(`/api/entry-requests/${reqId}/cancel`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})

    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/record-entry`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ enteredAt: '2026-07-01T14:30:00Z' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/entry already recorded \(status cancelled\)/)
    expect(emitEntryRecordedEventsMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/entry-requests/:id/cancel', () => {
  it('landlord cancels pending → status=cancelled', async () => {
    const f = await seedERFixture()
    const c = await createRequest(f, f.landlordToken)
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .post(`/api/entry-requests/${reqId}/cancel`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    const row = await db.query<{ status: string }>(
      `SELECT status FROM unit_entry_requests WHERE id=$1`, [reqId])
    expect(row.rows[0].status).toBe('cancelled')
  })
})

describe('loadRequest scope guard (via GET /:id)', () => {
  it('tenant fetching another tenant\'s request → 403', async () => {
    const a = await seedERFixture()
    const b = await seedERFixture()
    const c = await createRequest(a, a.landlordToken)
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .get(`/api/entry-requests/${reqId}`)
      .set('Authorization', `Bearer ${b.tenantToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Not your entry request/)
  })

  it('landlord fetching another landlord\'s request → 403', async () => {
    const a = await seedERFixture()
    const b = await seedERFixture()
    const c = await createRequest(a, a.landlordToken)
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .get(`/api/entry-requests/${reqId}`)
      .set('Authorization', `Bearer ${b.landlordToken}`)
    expect(res.status).toBe(403)
  })

  // ─────────────────────────────────────────────────────────────
  //  S478: GET /:id recomputes warnings against the persisted row
  // ─────────────────────────────────────────────────────────────

  // Reuse the seed pattern from POST tests so the GET path has
  // catalogued AZ statute data to compare against.
  async function seedAzEntryNoticeStatute(): Promise<void> {
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO state_landlord_tenant_acts
         (state_code, act_key, act_name, unit_types, source_date, effective_year)
       VALUES ('AZ', 'residential', 'AZ Residential Landlord-Tenant Act',
               ARRAY['apartment','single_family']::text[], '2026-06-09', 2026)
       ON CONFLICT DO NOTHING
       RETURNING id`)
    const actId = a?.id ?? (await db.query<{ id: string }>(
      `SELECT id FROM state_landlord_tenant_acts WHERE state_code='AZ' AND act_key='residential' AND effective_year=2026 LIMIT 1`)).rows[0].id
    await db.query(
      `INSERT INTO state_law_provisions
         (act_id, state_code, topic, rule_kind, threshold_numeric, threshold_unit,
          summary, statute_citation, source_url, source_date, effective_year)
       VALUES ($1, 'AZ', 'entry_notice_hours', 'min', 48, 'hours',
               'Landlord must give at least two days notice before entry',
               'A.R.S. § 33-1343', 'https://www.azleg.gov/ars/33/01343.htm',
               '2026-06-09', 2026)
       ON CONFLICT DO NOTHING`, [actId])
  }

  it('S478: tenant GETs own request → sees outside_typical_hours + state_law_warnings', async () => {
    const f = await seedERFixture()
    await seedAzEntryNoticeStatute()
    // 30h notice + 5 AM Phoenix = both flags fire.
    // 12:00 UTC = 05:00 Phoenix.
    const futureStart = new Date(Date.now() + 30 * 3_600_000)
    futureStart.setUTCHours(12, 0, 0, 0)
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000)
    const c = await createRequest(f, f.landlordToken, {
      windowStartIso: futureStart.toISOString(),
      windowEndIso:   futureEnd.toISOString(),
    })
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .get(`/api/entry-requests/${reqId}`)
      .set('Authorization', `Bearer ${f.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(true)
    expect(res.body.data.typical_hours_warning).toMatch(/typical daytime/i)
    expect(res.body.data.state_law_warnings.length).toBe(1)
    expect(res.body.data.state_law_warnings[0].topic).toBe('entry_notice_hours')
  })

  it('S478: GET on a within-range request → outside_typical_hours=false + empty state_law_warnings', async () => {
    const f = await seedERFixture()
    await seedAzEntryNoticeStatute()
    // 60h notice + 10am Phoenix (17:00 UTC) — both checks pass.
    const futureStart = new Date(Date.now() + 60 * 3_600_000)
    futureStart.setUTCHours(17, 0, 0, 0)
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000)
    const c = await createRequest(f, f.landlordToken, {
      windowStartIso: futureStart.toISOString(),
      windowEndIso:   futureEnd.toISOString(),
    })
    const reqId = c.body.data.id

    const res = await request(buildApp())
      .get(`/api/entry-requests/${reqId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.outside_typical_hours).toBe(false)
    expect(res.body.data.state_law_warnings).toEqual([])
  })
})
