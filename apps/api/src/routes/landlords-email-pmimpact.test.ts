/**
 * landlords.ts email-failures + pm-impact slice — S364 (landlords
 * slice 8 of N).
 *
 * Two small owner-only admin reads:
 *   - GET /me/email-failures: filtered read of email_send_log
 *   - GET /me/pm-impact: per-property PM cut breakdown (LEFT JOIN
 *     properties → pm_companies + pm_fee_plans + user_balance_ledger
 *     with date-window filter). F1-class probe target.
 *
 * Both gated by requireLandlord — owner financial views, not team-
 * worker surfaces.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_email_pm'
})

interface EFixture {
  landlordUserId: string
  landlordId:     string
  landlordToken:  string
}

async function seedEFixture(): Promise<EFixture> {
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

async function seedEmailLog(
  landlordId: string | null,
  opts: { status?: 'sent' | 'failed'; toEmail?: string; subject?: string; daysAgo?: number } = {},
): Promise<void> {
  const daysAgo = opts.daysAgo ?? 0
  await db.query(
    `INSERT INTO email_send_log (to_email, subject, category, status, landlord_id, created_at)
     VALUES ($1, $2, 'test', $3, $4, NOW() - ($5::int * INTERVAL '1 day'))`,
    [opts.toEmail ?? 'x@test.dev', opts.subject ?? 'subj',
     opts.status ?? 'failed', landlordId, daysAgo])
}

describe('GET /api/landlords/me/email-failures', () => {
  it('empty → []', async () => {
    const f = await seedEFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/email-failures')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows).toEqual([])
    expect(res.body.data.sinceDays).toBe(30)
    expect(res.body.data.limit).toBe(50)
  })

  it('returns own failed sends; cross-landlord excluded; sent rows excluded', async () => {
    const a = await seedEFixture()
    const b = await seedEFixture()
    await seedEmailLog(a.landlordId, { status: 'failed', subject: 'a-failed' })
    await seedEmailLog(a.landlordId, { status: 'sent',   subject: 'a-sent'   })  // wrong status
    await seedEmailLog(b.landlordId, { status: 'failed', subject: 'b-failed' })  // wrong landlord

    const res = await request(buildApp())
      .get('/api/landlords/me/email-failures')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].subject).toBe('a-failed')
  })

  it('sinceDays query param window: 30d default excludes 60d-old rows', async () => {
    const f = await seedEFixture()
    await seedEmailLog(f.landlordId, { status: 'failed', subject: 'recent', daysAgo: 5 })
    await seedEmailLog(f.landlordId, { status: 'failed', subject: 'old',    daysAgo: 60 })

    const res = await request(buildApp())
      .get('/api/landlords/me/email-failures')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].subject).toBe('recent')

    // ?since_days=90 brings the old row back in
    const wide = await request(buildApp())
      .get('/api/landlords/me/email-failures?since_days=90')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(wide.body.data.rows.length).toBe(2)
  })
})

describe('GET /api/landlords/me/pm-impact', () => {
  it('empty (no properties) → []', async () => {
    const f = await seedEFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/pm-impact')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows).toEqual([])
  })

  it('returns properties WITHOUT pm_company_id (LEFT JOIN ensures self-managed properties still appear)', async () => {
    const f = await seedEFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      await client.query(`UPDATE properties SET name='Self-Managed' WHERE id=$1`, [propertyId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/pm-impact')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].property_name).toBe('Self-Managed')
    expect(res.body.data.rows[0].pm_company_id).toBeNull()
    expect(res.body.data.rows[0].pm_company_name).toBeNull()
    expect(Number(res.body.data.rows[0].owner_net)).toBe(0)
    expect(Number(res.body.data.rows[0].pm_company_cut)).toBe(0)
  })

  it('returns property with PM company + fee plan info attached when assigned', async () => {
    const f = await seedEFixture()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      const co = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name, status) VALUES ('Acme PM', 'active') RETURNING id`)
      const plan = await client.query<{ id: string }>(
        `INSERT INTO pm_fee_plans (pm_company_id, name, fee_type, percent)
         VALUES ($1, '8% standard', 'percent_of_rent', 8) RETURNING id`, [co.rows[0].id])
      await client.query(
        `UPDATE properties SET pm_company_id=$1, pm_fee_plan_id=$2, name='PM-Managed' WHERE id=$3`,
        [co.rows[0].id, plan.rows[0].id, propertyId])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/pm-impact')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.rows.length).toBe(1)
    expect(res.body.data.rows[0].pm_company_name).toBe('Acme PM')
    expect(res.body.data.rows[0].pm_fee_plan_name).toBe('8% standard')
    expect(res.body.data.rows[0].pm_fee_type).toBe('percent_of_rent')
  })

  it('aggregation: rolls up owner_share + pm_company_fee + manager_fee from user_balance_ledger', async () => {
    const f = await seedEFixture()
    const client = await db.connect()
    let propertyId = ''
    try {
      await client.query('BEGIN')
      propertyId = await seedProperty(client, {
        landlordId: f.landlordId, ownerUserId: f.landlordUserId,
        managedByUserId: f.landlordUserId,
      })
      // Seed ledger rows pointing at this property with the three split types
      await client.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, reference_type, reference_id)
         VALUES
         ($1, 'allocation_owner_share',     1000, 1000, $2, 'payment', $3),
         ($1, 'allocation_owner_share',      500, 1500, $2, 'payment', $4),
         ($1, 'allocation_pm_company_fee',   100,  100, $2, 'payment', $3),
         ($1, 'allocation_manager_fee',       50,  150, $2, 'payment', $3)`,
        [f.landlordUserId, propertyId, randomUUID(), randomUUID()])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const res = await request(buildApp())
      .get('/api/landlords/me/pm-impact')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const row = res.body.data.rows[0]
    expect(Number(row.owner_net)).toBe(1500)        // 1000 + 500
    expect(Number(row.pm_company_cut)).toBe(100)
    expect(Number(row.in_house_manager_fee)).toBe(50)
    expect(Number(row.total_split)).toBe(1650)
    // payment_count is COUNT DISTINCT reference_id where type=owner_share
    // (two distinct reference_ids seeded)
    expect(Number(row.payment_count)).toBe(2)
  })

  it('invalid `from` query param (not YYYY-MM-DD) → 400', async () => {
    const f = await seedEFixture()
    const res = await request(buildApp())
      .get('/api/landlords/me/pm-impact?from=last-tuesday')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/from must be YYYY-MM-DD/)
  })
})
