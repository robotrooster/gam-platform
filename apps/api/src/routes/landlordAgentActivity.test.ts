/**
 * S480 — landlord-facing agent_interaction_logs reporting coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { landlordAgentActivityRouter } from './landlordAgentActivity'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlord/agent-activity', landlordAgentActivityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  // agent_interaction_logs isn't wiped by cleanupAllSchema. Wipe
  // here so each test runs against an empty log.
  await db.query(`DELETE FROM agent_interaction_logs`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s480'
})

interface Fixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedFixture(): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedInteraction(args: {
  landlordId:  string | null
  agentName?:   string
  audience?:    'tenant' | 'landlord' | 'prospect'
  outcome?:     string
  escalated?:   boolean
  toolNames?:   string[]
  latencyMs?:   number
  daysAgo?:     number
  // Verbatim content fields — populated to prove the VIEW omits them.
  userMessage?: string
  agentReply?:  string
}): Promise<string> {
  const createdAt = args.daysAgo
    ? new Date(Date.now() - args.daysAgo * 24 * 3600 * 1000)
    : new Date()
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO agent_interaction_logs
       (conversation_id, agent_type, audience, profile_id, agent_name,
        handled_by_tier, outcome, landlord_id,
        actor_role, actor_subject_id,
        escalated_to_human, escalation_count,
        tool_names, tool_invocation_count,
        latency_ms, grounded,
        user_message, agent_reply,
        created_at)
     VALUES ($1, 'customer_service', $2, $3, $4,
             'entry', $5, $6,
             $7, $8,
             $9, $10,
             $11, $12,
             $13, FALSE,
             $14, $15,
             $16)
     RETURNING id`,
    [
      randomUUID(),
      args.audience ?? 'tenant',
      'cs_tenant_entry',
      args.agentName ?? 'Ava',
      args.outcome ?? 'answered_entry',
      args.landlordId,
      args.audience === 'landlord' ? 'landlord' : 'tenant',
      randomUUID(),
      args.escalated ?? false,
      args.escalated ? 1 : 0,
      args.toolNames ?? [],
      (args.toolNames ?? []).length,
      args.latencyMs ?? null,
      args.userMessage ?? 'hi',
      args.agentReply ?? 'hello',
      createdAt,
    ],
  )
  return r.id
}

// ════════════════════════════════════════════════════════════════
//  GET / — summary KPIs
// ════════════════════════════════════════════════════════════════

describe('GET /api/landlord/agent-activity — summary', () => {
  it('non-landlord role → 403', async () => {
    const f = await seedFixture()
    const tenantToken = jwt.sign(
      { userId: randomUUID(), role: 'tenant', email: 't@test.dev', profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const res = await request(buildApp())
      .get('/api/landlord/agent-activity')
      .set('Authorization', `Bearer ${tenantToken}`)
    expect(res.status).toBe(403)
  })

  it('empty log → zeros + empty arrays', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/landlord/agent-activity')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.total).toBe(0)
    expect(res.body.data.by_outcome).toEqual([])
    expect(res.body.data.by_agent).toEqual([])
    expect(res.body.data.by_tool).toEqual([])
  })

  it('returns correct counts grouped by outcome / agent / tool', async () => {
    const f = await seedFixture()
    await seedInteraction({ landlordId: f.landlordId, agentName: 'Ava', outcome: 'answered_entry' })
    await seedInteraction({ landlordId: f.landlordId, agentName: 'Ava', outcome: 'answered_entry', toolNames: ['get_my_lease'] })
    await seedInteraction({ landlordId: f.landlordId, agentName: 'Samantha', outcome: 'escalated_to_human', escalated: true })
    await seedInteraction({ landlordId: f.landlordId, agentName: 'David', audience: 'landlord', outcome: 'answered_entry', toolNames: ['get_landlord_portfolio'] })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.total).toBe(4)
    expect(res.body.data.totals.tenant_count).toBe(3)
    expect(res.body.data.totals.landlord_count).toBe(1)
    expect(res.body.data.totals.escalated_count).toBe(1)

    const byOutcome = Object.fromEntries(
      res.body.data.by_outcome.map((r: any) => [r.outcome, r.count]))
    expect(byOutcome.answered_entry).toBe(3)
    expect(byOutcome.escalated_to_human).toBe(1)

    const byAgent = Object.fromEntries(
      res.body.data.by_agent.map((r: any) => [r.agent_name, r.count]))
    expect(byAgent.Ava).toBe(2)
    expect(byAgent.Samantha).toBe(1)
    expect(byAgent.David).toBe(1)

    const byTool = Object.fromEntries(
      res.body.data.by_tool.map((r: any) => [r.tool, r.count]))
    expect(byTool.get_my_lease).toBe(1)
    expect(byTool.get_landlord_portfolio).toBe(1)
  })

  it('cross-landlord rows excluded', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await seedInteraction({ landlordId: a.landlordId })
    await seedInteraction({ landlordId: a.landlordId })
    await seedInteraction({ landlordId: b.landlordId })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.body.data.totals.total).toBe(2)
  })

  it('respects days window (rows outside the window excluded)', async () => {
    const f = await seedFixture()
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 5 })
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 45 })  // outside 30d default

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.body.data.totals.total).toBe(1)
  })

  it('configurable days (90d) returns both rows', async () => {
    const f = await seedFixture()
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 5 })
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 45 })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity?days=90')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.body.data.totals.total).toBe(2)
    expect(res.body.data.days).toBe(90)
  })
})

// ════════════════════════════════════════════════════════════════
//  GET /recent — last N rows
// ════════════════════════════════════════════════════════════════

describe('GET /api/landlord/agent-activity/recent', () => {
  it('returns metadata only — VIEW omits user_message + agent_reply', async () => {
    const f = await seedFixture()
    await seedInteraction({
      landlordId: f.landlordId,
      userMessage: 'TENANT_VERBATIM_PRIVATE',
      agentReply: 'AGENT_VERBATIM_PRIVATE',
    })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity/recent')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    // VIEW + route SELECT strip these.
    expect(JSON.stringify(res.body.data)).not.toContain('TENANT_VERBATIM_PRIVATE')
    expect(JSON.stringify(res.body.data)).not.toContain('AGENT_VERBATIM_PRIVATE')
    expect('user_message' in res.body.data[0]).toBe(false)
    expect('agent_reply' in res.body.data[0]).toBe(false)
    // Metadata still present.
    expect(res.body.data[0].agent_name).toBe('Ava')
  })

  it('limit + ordering: newest first', async () => {
    const f = await seedFixture()
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 3, agentName: 'Older' })
    await seedInteraction({ landlordId: f.landlordId, daysAgo: 1, agentName: 'Newer' })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity/recent?limit=10')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data[0].agent_name).toBe('Newer')
    expect(res.body.data[1].agent_name).toBe('Older')
  })

  it('outcome filter: only matching rows', async () => {
    const f = await seedFixture()
    await seedInteraction({ landlordId: f.landlordId, outcome: 'answered_entry' })
    await seedInteraction({ landlordId: f.landlordId, outcome: 'escalated_to_human', escalated: true })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity/recent?outcome=escalated_to_human')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].outcome).toBe('escalated_to_human')
  })

  it('cross-landlord rows excluded from recent', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await seedInteraction({ landlordId: a.landlordId })
    await seedInteraction({ landlordId: b.landlordId })

    const res = await request(buildApp())
      .get('/api/landlord/agent-activity/recent')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.body.data.length).toBe(1)
  })
})
