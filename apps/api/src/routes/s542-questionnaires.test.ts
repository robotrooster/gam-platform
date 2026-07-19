/**
 * S542: platform-originated tenant questionnaires (landlord-invisible).
 *
 * Rules under test:
 *   - Creation guards: one-shot per (tenant, trigger); skipped when the
 *     tenant already has a FlexPay inquiry, is enrolled, or the flag is off.
 *   - ssi_ssdi_signal daily sweep: only ssi_ssdi tenants with an active
 *     lease and no FlexPay engagement; idempotent.
 *   - Answer funnel: SSI/SSDI + interested → flexpay_inquiries row filed
 *     (note carries the trigger); negative answers file nothing.
 *   - Routes are tenant-only; dismiss closes; re-answer 409s.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import {
  maybeCreateQuestionnaire, sweepSsiSsdiQuestionnaires,
} from '../services/tenantQuestionnaires'
import { tenantsRouter } from './tenants'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}
const tok = (userId: string, role: string, profileId: string) =>
  jwt.sign({ userId, role, profileId }, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function fixture(opts: { ssiSsdi?: boolean } = {}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    if (opts.ssiSsdi) await client.query(`UPDATE tenants SET ssi_ssdi=TRUE WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 440 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'S542 test flag')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    await client.query('COMMIT')
    return { ...ll, tenantId, tenantUserId: tu.rows[0].user_id, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM tenant_questionnaires`)
  await db.query(`DELETE FROM flexpay_inquiries`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s542'
})

describe('S542 questionnaire creation guards', () => {
  it('creates once per trigger; second call no-ops', async () => {
    const f = await fixture()
    expect(await maybeCreateQuestionnaire(f.tenantId, 'late_fee_fixed_income')).toBe(true)
    expect(await maybeCreateQuestionnaire(f.tenantId, 'late_fee_fixed_income')).toBe(false)
    const rows = await db.query(`SELECT id FROM tenant_questionnaires WHERE tenant_id=$1`, [f.tenantId])
    expect(rows.rows.length).toBe(1)
  })

  it('skips tenants who already engaged with FlexPay (inquiry exists)', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO flexpay_inquiries (tenant_id, claimed_income_source) VALUES ($1, 'ssi')`,
      [f.tenantId])
    expect(await maybeCreateQuestionnaire(f.tenantId, 'late_fee_fixed_income')).toBe(false)
  })

  it('ssi_ssdi sweep: flagged+leased tenants only, idempotent', async () => {
    const flagged = await fixture({ ssiSsdi: true })
    await fixture({ ssiSsdi: false })   // second tenant, not flagged
    const first = await sweepSsiSsdiQuestionnaires()
    expect(first).toBe(1)
    expect(await sweepSsiSsdiQuestionnaires()).toBe(0)
    const rows = await db.query(
      `SELECT tenant_id, trigger_type FROM tenant_questionnaires`)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0].tenant_id).toBe(flagged.tenantId)
    expect(rows.rows[0].trigger_type).toBe('ssi_ssdi_signal')
  })
})

describe('S542 answer funnel + routes', () => {
  it('positive answer files a FlexPay inquiry with trigger note; negative files nothing; re-answer 409s', async () => {
    const f = await fixture()
    await maybeCreateQuestionnaire(f.tenantId, 'late_fee_fixed_income')
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)

    const list = await request(app).get('/api/tenants/questionnaires')
      .set('Authorization', `Bearer ${t}`)
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBe(1)
    const qid = list.body.data[0].id

    const ans = await request(app).post(`/api/tenants/questionnaires/${qid}/answer`)
      .set('Authorization', `Bearer ${t}`)
      .send({ incomeSource: 'ssdi', interested: true })
    expect(ans.status).toBe(200)
    expect(ans.body.data.inquiryFiled).toBe(true)

    const inq = await db.query<any>(
      `SELECT status, claimed_income_source, tenant_note FROM flexpay_inquiries WHERE tenant_id=$1`,
      [f.tenantId])
    expect(inq.rows.length).toBe(1)
    expect(inq.rows[0].status).toBe('pending')
    expect(inq.rows[0].claimed_income_source).toBe('ssdi')
    expect(inq.rows[0].tenant_note).toMatch(/late_fee_fixed_income/)

    const again = await request(app).post(`/api/tenants/questionnaires/${qid}/answer`)
      .set('Authorization', `Bearer ${t}`)
      .send({ incomeSource: 'ssdi', interested: true })
    expect(again.status).toBe(409)

    // Negative path on a second tenant.
    const g = await fixture()
    await maybeCreateQuestionnaire(g.tenantId, 'late_fee_fixed_income')
    const t2 = tok(g.tenantUserId, 'tenant', g.tenantId)
    const list2 = await request(app).get('/api/tenants/questionnaires')
      .set('Authorization', `Bearer ${t2}`)
    const ans2 = await request(app).post(`/api/tenants/questionnaires/${list2.body.data[0].id}/answer`)
      .set('Authorization', `Bearer ${t2}`)
      .send({ incomeSource: 'none', interested: false })
    expect(ans2.status).toBe(200)
    expect(ans2.body.data.inquiryFiled).toBe(false)
    const noInq = await db.query(`SELECT id FROM flexpay_inquiries WHERE tenant_id=$1`, [g.tenantId])
    expect(noInq.rows.length).toBe(0)
  })

  it('dismiss closes the pending row; landlord role 403s everywhere', async () => {
    const f = await fixture()
    await maybeCreateQuestionnaire(f.tenantId, 'ssi_ssdi_signal')
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const ll = tok(f.userId, 'landlord', f.landlordId)

    const list = await request(app).get('/api/tenants/questionnaires')
      .set('Authorization', `Bearer ${t}`)
    const qid = list.body.data[0].id
    const dis = await request(app).post(`/api/tenants/questionnaires/${qid}/dismiss`)
      .set('Authorization', `Bearer ${t}`)
    expect(dis.status).toBe(200)
    const after = await request(app).get('/api/tenants/questionnaires')
      .set('Authorization', `Bearer ${t}`)
    expect(after.body.data.length).toBe(0)

    for (const path of ['/api/tenants/questionnaires']) {
      const r = await request(app).get(path).set('Authorization', `Bearer ${ll}`)
      expect(r.status).toBe(403)
    }
  })
})
