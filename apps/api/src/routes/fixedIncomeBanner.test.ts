/**
 * 10/26 (Nic) — THE FIXED-INCOME BANNER.
 *
 *   "Maybe the survey could just literally be in the banner... Are you on
 *    fixed income? Yes or no? If yes, it takes them to the descriptor of
 *    FlexPay. If they click no, then boom, they're just flagged no, and it's
 *    done and over with right there without leaving the page."
 *
 * The thing these guard hardest is the line between SAYING you are on fixed
 * income and BEING VERIFIED as such: tenants.ssi_ssdi gates FlexPay
 * enrollment, and a tap on a banner must never touch it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_fixed_income'
  await query(
    `INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_rollout_visible', TRUE, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
})

async function resident() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    const userId = (await queryOne<any>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).user_id
    return {
      tenantId,
      token: jwt.sign({ userId, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const prompt = (token: string) => request(buildApp())
  .get('/api/tenants/me/fixed-income-prompt').set('Authorization', `Bearer ${token}`)
const answer = (token: string, onFixedIncome: unknown) => request(buildApp())
  .post('/api/tenants/me/fixed-income').set('Authorization', `Bearer ${token}`).send({ onFixedIncome })
const row = (tenantId: string) => queryOne<any>(
  `SELECT fixed_income_self_reported, fixed_income_answered_at, ssi_ssdi FROM tenants WHERE id = $1`,
  [tenantId])

describe('when the banner shows', () => {
  it('shows to a resident who has never been asked', async () => {
    const r = await resident()
    const res = await prompt(r.token)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ show: true, answered: null })
  })

  it('stops showing once answered, either way', async () => {
    for (const said of [true, false]) {
      await cleanupAllSchema()
      await query(`INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_rollout_visible', TRUE, 'test')
                   ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
      const r = await resident()
      expect((await answer(r.token, said)).status).toBe(200)
      const res = await prompt(r.token)
      expect(res.body.data, `said ${said}`).toEqual({ show: false, answered: said })
    }
  })

  it('never asks about a product that is not being offered', async () => {
    const r = await resident()
    await query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexpay_rollout_visible'`)
    expect((await prompt(r.token)).body.data.show).toBe(false)
  })

  it('never asks someone already verified, or already enrolled', async () => {
    const r = await resident()
    await query(`UPDATE tenants SET ssi_ssdi = TRUE WHERE id = $1`, [r.tenantId])
    expect((await prompt(r.token)).body.data.show).toBe(false)
    await query(`UPDATE tenants SET ssi_ssdi = FALSE, flexpay_enrolled = TRUE WHERE id = $1`, [r.tenantId])
    expect((await prompt(r.token)).body.data.show).toBe(false)
  })
})

describe('answering it', () => {
  it('records a yes and a no, and stamps when', async () => {
    for (const said of [true, false]) {
      await cleanupAllSchema()
      await query(`INSERT INTO system_features (key, enabled, description) VALUES ('flexpay_rollout_visible', TRUE, 'test')
                   ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
      const r = await resident()
      const res = await answer(r.token, said)
      expect(res.body.data).toEqual({ recorded: true, onFixedIncome: said })
      const t = await row(r.tenantId)
      expect(t.fixed_income_self_reported, `said ${said}`).toBe(said)
      expect(t.fixed_income_answered_at).not.toBeNull()
    }
  })

  // THE ONE THAT MATTERS: saying yes is not being verified. ssi_ssdi gates
  // FlexPay enrollment, so a tap here qualifying somebody would hand the
  // product to anyone who taps a button.
  it('does NOT set the verified flag that gates enrollment', async () => {
    const r = await resident()
    await answer(r.token, true)
    const t = await row(r.tenantId)
    expect(t.fixed_income_self_reported).toBe(true)
    expect(t.ssi_ssdi).toBe(false)
  })

  it('keeps the first answer — a second does not reopen what they closed', async () => {
    const r = await resident()
    await answer(r.token, false)
    const second = await answer(r.token, true)
    expect(second.status).toBe(200)
    expect(second.body.data.recorded).toBe(false)
    expect((await row(r.tenantId)).fixed_income_self_reported).toBe(false)
  })

  it('refuses anything that is not a yes or a no', async () => {
    const r = await resident()
    for (const bad of ['yes', 1, null, undefined, {}]) {
      expect((await answer(r.token, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await row(r.tenantId)).fixed_income_answered_at).toBeNull()
  })

  it('refuses a caller with no session, and a landlord', async () => {
    const r = await resident()
    expect((await request(buildApp()).post('/api/tenants/me/fixed-income').send({ onFixedIncome: true })).status).toBe(401)
    const ll = jwt.sign({ userId: r.tenantId, role: 'landlord', email: 'l@t.dev', profileId: null, landlordIds: [], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    expect((await answer(ll, true)).status).toBe(403)
  })
})
