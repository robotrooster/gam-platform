/**
 * S554 (button-sweep bug #7): POST /api/background/reapply.
 *
 * The applicant-facing "Reapply Now" button was wired to the admin-only,
 * non-prod /dev-reset → every applicant got a 403. This is the real route;
 * the 90-day post-denial cooldown is ENFORCED here, never trusted from the
 * client (which only decides whether to show the button).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { backgroundRouter } from './background'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/background', backgroundRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reapply'
})

const sign = (userId: string) => jwt.sign(
  { userId, role: 'tenant', email: 't@t.dev', profileId: userId, permissions: {} },
  process.env.JWT_SECRET!, { expiresIn: '1h' })

/** Seed a user + tenant + background_check with a given status/decided_at. */
async function seedApplicant(opts: {
  status: string | null           // background_checks.status + tenants.background_check_status
  decidedDaysAgo?: number | null  // null → decided_at NULL
}): Promise<{ userId: string; tenantId: string; checkId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { landlordId } = await seedLandlord(c)
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'tenant', 'Re', 'Apply', TRUE) RETURNING id`,
      [`reapply-${randomUUID()}@test.dev`])
    const userId = u.rows[0].id
    const decidedAt = opts.decidedDaysAgo == null
      ? null
      : new Date(Date.now() - opts.decidedDaysAgo * 24 * 60 * 60 * 1000)
    const bc = await c.query<{ id: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, status, decided_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [landlordId, userId, opts.status ?? 'pending', decidedAt])
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id, background_check_status, background_check_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, opts.status, bc.rows[0].id])
    await c.query('COMMIT')
    return { userId, tenantId: t.rows[0].id, checkId: bc.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

describe('POST /api/background/reapply', () => {
  it('denied + cooldown elapsed → resets to not_started', async () => {
    const { userId, tenantId } = await seedApplicant({ status: 'denied', decidedDaysAgo: 91 })
    const res = await request(buildApp())
      .post('/api/background/reapply')
      .set('Authorization', `Bearer ${sign(userId)}`)
    expect(res.status).toBe(200)
    const t = await db.query<{ background_check_status: string; background_check_id: string | null }>(
      `SELECT background_check_status, background_check_id FROM tenants WHERE id=$1`, [tenantId])
    expect(t.rows[0].background_check_status).toBe('not_started')
    expect(t.rows[0].background_check_id).toBeNull()
  })

  it('denied but still in cooldown → 403, status unchanged', async () => {
    const { userId, tenantId } = await seedApplicant({ status: 'denied', decidedDaysAgo: 10 })
    const res = await request(buildApp())
      .post('/api/background/reapply')
      .set('Authorization', `Bearer ${sign(userId)}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/cooldown|remaining/i)
    const t = await db.query<{ background_check_status: string }>(
      `SELECT background_check_status FROM tenants WHERE id=$1`, [tenantId])
    expect(t.rows[0].background_check_status).toBe('denied')  // untouched
  })

  it('not denied (approved) → 409', async () => {
    const { userId } = await seedApplicant({ status: 'approved', decidedDaysAgo: 200 })
    const res = await request(buildApp())
      .post('/api/background/reapply')
      .set('Authorization', `Bearer ${sign(userId)}`)
    expect(res.status).toBe(409)
  })

  it('denied but no decision timestamp → 409', async () => {
    const { userId } = await seedApplicant({ status: 'denied', decidedDaysAgo: null })
    const res = await request(buildApp())
      .post('/api/background/reapply')
      .set('Authorization', `Bearer ${sign(userId)}`)
    expect(res.status).toBe(409)
  })
})
