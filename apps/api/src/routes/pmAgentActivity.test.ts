/**
 * S484 — PM-company agent-activity reporting coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { pmAgentActivityRouter } from './pmAgentActivity'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pm/:pmCompanyId/agent-activity', pmAgentActivityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM agent_interaction_logs`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s484'
})

interface Fixture {
  staffUserId: string
  staffToken:  string
  pmCompanyId: string
  landlordId:  string
}

async function seedPmFixture(opts: {
  staffRole?: 'owner' | 'manager' | 'staff'
  pmStatus?: 'active' | 'suspended'
} = {}): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // Landlord
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    // PM company
    const ownerHash = await bcrypt.hash('test-pw-12345!', 12)
    const ownerEmail = `pm-owner-${randomUUID()}@test.dev`
    const { rows: [ownerUser] } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'landlord', 'PM', 'Owner', TRUE) RETURNING id`,
      [ownerEmail, ownerHash])
    const { rows: [pm] } = await client.query<{ id: string }>(
      `INSERT INTO pm_companies (name, business_email, status)
       VALUES ($1, $2, $3) RETURNING id`,
      [`PM ${randomUUID().slice(0, 6)}`, ownerEmail, opts.pmStatus ?? 'active'])
    // Staff member
    const staffHash = await bcrypt.hash('test-pw-12345!', 12)
    const staffEmail = `pm-staff-${randomUUID()}@test.dev`
    const { rows: [staffUser] } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'landlord', 'Staff', 'Member', TRUE) RETURNING id`,
      [staffEmail, staffHash])
    await client.query(
      `INSERT INTO pm_staff (pm_company_id, user_id, role, status)
       VALUES ($1, $2, $3, 'active')`,
      [pm.id, staffUser.id, opts.staffRole ?? 'manager'])
    // Property assigned to PM company
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    await client.query(
      `UPDATE properties SET pm_company_id = $1 WHERE id = $2`,
      [pm.id, propertyId])
    await client.query('COMMIT')
    const staffToken = jwt.sign(
      { userId: staffUser.id, role: 'landlord', email: staffEmail,
        profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      staffUserId: staffUser.id,
      staffToken,
      pmCompanyId: pm.id,
      landlordId,
    }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedInteraction(args: {
  landlordId: string
  audience?:  'tenant' | 'landlord' | 'prospect'
  outcome?:   string
  escalated?: boolean
  toolNames?: string[]
}): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO agent_interaction_logs
       (conversation_id, agent_type, audience, profile_id, agent_name,
        handled_by_tier, outcome, landlord_id,
        actor_role, actor_subject_id,
        escalated_to_human, escalation_count,
        tool_names, tool_invocation_count,
        user_message, agent_reply)
     VALUES ($1, 'customer_service', $2, 'cs_tenant_entry', $3,
             'entry', $4, $5,
             $6, $7,
             $8, $9,
             $10, $11,
             'hi', 'hello')
     RETURNING id`,
    [
      randomUUID(),
      args.audience ?? 'tenant',
      'Ava',
      args.outcome ?? 'answered_entry',
      args.landlordId,
      args.audience === 'landlord' ? 'landlord' : 'tenant',
      randomUUID(),
      args.escalated ?? false,
      args.escalated ? 1 : 0,
      args.toolNames ?? [],
      (args.toolNames ?? []).length,
    ])
  return r.id
}

describe('GET /api/pm/:pmCompanyId/agent-activity — summary', () => {
  it('non-staff user → 403', async () => {
    const f = await seedPmFixture()
    const randomToken = jwt.sign(
      { userId: randomUUID(), role: 'landlord', email: 'rando@test.dev',
        profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity`)
      .set('Authorization', `Bearer ${randomToken}`)
    expect(res.status).toBe(403)
  })

  it('suspended PM company → staff member 403', async () => {
    const f = await seedPmFixture({ pmStatus: 'suspended' })
    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity`)
      .set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/suspended/i)
  })

  it('member can view: empty log → zeros', async () => {
    const f = await seedPmFixture()
    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity`)
      .set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.total).toBe(0)
  })

  it('scopes to landlords managed by THIS PM company', async () => {
    const f = await seedPmFixture()
    // 2 rows for the PM-managed landlord
    await seedInteraction({ landlordId: f.landlordId })
    await seedInteraction({ landlordId: f.landlordId, outcome: 'escalated_to_human', escalated: true })
    // 1 row for a different landlord (NOT under this PM company)
    const otherLandlord = await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id) SELECT id FROM users LIMIT 1 RETURNING id`)
    await seedInteraction({ landlordId: otherLandlord.rows[0].id })

    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity`)
      .set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.totals.total).toBe(2)
    expect(res.body.data.totals.escalated_count).toBe(1)
  })

  it('cross-pm-company isolation: company A staff cannot see company B rows', async () => {
    const a = await seedPmFixture()
    const b = await seedPmFixture()
    await seedInteraction({ landlordId: b.landlordId })

    const res = await request(buildApp())
      .get(`/api/pm/${a.pmCompanyId}/agent-activity`)
      .set('Authorization', `Bearer ${a.staffToken}`)
    expect(res.body.data.totals.total).toBe(0)
  })

  it('VIEW omits verbatim user_message + agent_reply via /recent endpoint', async () => {
    const f = await seedPmFixture()
    await db.query(
      `INSERT INTO agent_interaction_logs
         (conversation_id, agent_type, audience, profile_id, agent_name,
          handled_by_tier, outcome, landlord_id,
          actor_role, actor_subject_id,
          user_message, agent_reply)
       VALUES ($1, 'customer_service', 'tenant', 'cs_tenant_entry', 'Ava',
               'entry', 'answered_entry', $2,
               'tenant', $3,
               'TENANT_PRIVATE_S484', 'AGENT_PRIVATE_S484')`,
      [randomUUID(), f.landlordId, randomUUID()])

    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity/recent`)
      .set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(JSON.stringify(res.body.data)).not.toContain('TENANT_PRIVATE_S484')
    expect(JSON.stringify(res.body.data)).not.toContain('AGENT_PRIVATE_S484')
    expect('user_message' in res.body.data[0]).toBe(false)
    expect('agent_reply' in res.body.data[0]).toBe(false)
  })

  it('outcome filter on /recent', async () => {
    const f = await seedPmFixture()
    await seedInteraction({ landlordId: f.landlordId, outcome: 'answered_entry' })
    await seedInteraction({ landlordId: f.landlordId, outcome: 'escalated_to_human', escalated: true })

    const res = await request(buildApp())
      .get(`/api/pm/${f.pmCompanyId}/agent-activity/recent?outcome=escalated_to_human`)
      .set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].outcome).toBe('escalated_to_human')
  })
})
