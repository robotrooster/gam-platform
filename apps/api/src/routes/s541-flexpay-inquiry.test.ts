/**
 * S541: FlexPay demand-test gate (Nic).
 *
 * FlexPay fronts rent each cycle → every enrollment is GAM float, so
 * initial rollout is approval-gated:
 *   tenant inquiry (tenant portal only) → admin reviews lease +
 *   verifies SSI/SSDI income → approve → enrollment unlocks.
 *
 * Rules under test — REAL service + routes (email suppressed in dev):
 *   - POST /tenants/flexpay/inquiry creates a pending row; dup → 409.
 *   - enrollFlexPay REFUSES without an approved inquiry (server gate,
 *     not UI) — pending and declined both block.
 *   - Admin approve REQUIRES incomeVerified=true (422 otherwise) and
 *     marks tenants.ssi_ssdi (the income-verification attestation).
 *   - After approval the same tenant enrolls successfully.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

// S546: pdfjs-dist's legacy build won't load under vite-node (ESM
// interop throws InvalidPDFException at import), though it works fine
// under real Node (verified directly). Mock ONLY the extraction seam:
// pdf-lib writes uncompressed content streams, so the drawn text is
// present verbatim in the raw bytes — latin1-decode is a faithful
// stand-in. All flexpayAutoVerify logic (matching, holds, self-heal)
// stays under real test.
vi.mock('../lib/pdfText', () => ({
  extractPositionedText: async (buf: Buffer) => ({
    pages: [{ items: [{ text: buf.toString('latin1') }] }],
  }),
}))

import { tenantsRouter } from './tenants'
import { adminRouter } from './admin'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/admin', adminRouter)
  app.use(errorHandler)
  return app
}

const tok = (userId: string, role: string, profileId: string) =>
  jwt.sign({ userId, role, profileId }, process.env.JWT_SECRET!, { expiresIn: '1h' })

// S545/S546: approval requires proof on file AND the automated check
// must find a lease holder's name in it. The pdfText extraction seam
// is MOCKED in this suite (see vi.mock above — vite-node can't load
// pdfjs; the real pipeline is verified by hand under plain Node and
// untouched here per Nic), so the uploaded bytes just need to carry
// the text the mock will surface — a plain buffer, no real PDF.
function makeProofDoc(name: string): Buffer {
  return Buffer.from(
    `Social Security Administration\nBenefit Verification Letter\n${name}\nSupplemental Security Income (SSI) / SSDI`)
}
const uploadProof = (app: any, t: string, name: string) =>
  request(app).post('/api/tenants/flexpay/inquiry/proof')
    .set('Authorization', `Bearer ${t}`)
    .attach('file', makeProofDoc(name), { filename: 'award.pdf', contentType: 'application/pdf' })

async function fixture() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string; first_name: string; last_name: string }>(
      `SELECT t.user_id, u.first_name, u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id=$1`, [tenantId])
    // ACH verified (enrollment gate) but income NOT verified — approval flips it.
    await client.query(`UPDATE tenants SET ach_verified=TRUE, ssi_ssdi=FALSE WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 440 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    // Admin user for the review endpoints.
    const adm = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'admin', 'S541', 'Admin') RETURNING id`,
      [`s541admin-${Math.random().toString(36).slice(2, 8)}@gam.dev`])
    // Feature flags ON (survive via upsert; cleanup doesn't manage them).
    // S544: enrollment_open defaults TRUE here so launched-mode tests
    // exercise the full flow; the survey-mode test flips it off.
    await client.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_rollout_visible', TRUE, 'S541 test flag'),
              ('flexpay_enrollment_open', TRUE, 'S544 test flag')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    await client.query('COMMIT')
    return { tenantId, tenantUserId: tu.rows[0].user_id,
             tenantName: `${tu.rows[0].first_name} ${tu.rows[0].last_name}`,
             adminUserId: adm.rows[0].id }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM flexpay_inquiries`)
  // Leak insurance: a test that aborts mid-body (failed assert) never
  // reaches its own cleanup lines — a leftover AZ block once cascaded
  // 422s through every later approval in the file.
  await db.query(`DELETE FROM flexpay_blocked_states`)
  await db.query(`DELETE FROM tenant_questionnaires`)
  await db.query(`DELETE FROM users WHERE email LIKE 's541admin-%@gam.dev'`)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s541'
})

describe('S541 FlexPay demand-test gate', () => {
  it('inquiry creates pending; duplicate 409; GET /flexpay carries it', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)

    const res = await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`).send({ incomeSource: 'ssdi', note: 'deposit lands the 3rd Wed' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('pending')

    const dup = await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`).send({ incomeSource: 'ssdi' })
    expect(dup.status).toBe(409)

    const get = await request(app).get('/api/tenants/flexpay')
      .set('Authorization', `Bearer ${t}`)
    expect(get.status).toBe(200)
    expect(get.body.data.inquiry.status).toBe('pending')
  })

  it('enroll blocked while pending and after decline; approve is automated (proof + machine name-match, no attestations); sets ssi_ssdi', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)

    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`).send({ incomeSource: 'ssi' })

    // Pending → enroll refused by the SERVICE gate.
    const enroll1 = await request(app).post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${t}`).send({ pullDay: 3, acceptedTerms: true })
    expect(enroll1.status).toBe(400)
    expect(enroll1.body.error).toMatch(/under review/i)

    const list = await request(app).get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${a}`)
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBe(1)
    const inqId = list.body.data[0].id
    expect(list.body.data[0].lease_rent).toBeTruthy()   // lease context joined (snake: no camelize middleware in the test app)

    // S545: attestation alone isn't enough — no proof document on
    // file, no approval.
    const noProof = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(noProof.status).toBe(422)
    expect(noProof.body.error).toMatch(/proof of benefits/i)

    // Proof uploads only while PENDING (post-review 409s); the stored
    // document survives decline→re-review below.
    await uploadProof(app, t, f.tenantName)

    // Decline → still blocked.
    const decline = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'decline', notes: 'no award letter' })
    expect(decline.status).toBe(200)
    const enroll2 = await request(app).post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${t}`).send({ pullDay: 3, acceptedTerms: true })
    expect(enroll2.status).toBe(400)

    // S546: NO attestations needed — the machine read the document.
    // A bare approve succeeds once the auto check has matched.
    const approve = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', notes: 'auto-verified' })
    expect(approve.status).toBe(200)
    const trow = await db.query<any>(`SELECT ssi_ssdi FROM tenants WHERE id=$1`, [f.tenantId])
    expect(trow.rows[0].ssi_ssdi).toBe(true)

    const enroll3 = await request(app).post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${t}`).send({ pullDay: 3, acceptedTerms: true })
    expect(enroll3.status).toBe(200)
    expect(enroll3.body.data.fee).toBe(25)  // S562: flat $25/mo (pull day is scheduling only)

    const enrolled = await db.query<any>(`SELECT flexpay_enrolled, flexpay_pull_day FROM tenants WHERE id=$1`, [f.tenantId])
    expect(enrolled.rows[0].flexpay_enrolled).toBe(true)
    expect(enrolled.rows[0].flexpay_pull_day).toBe(3)
  })

  it('S542b: FCFS queue positions + state hold blocks approval until cleared + proof upload round-trip', async () => {
    const f1 = await fixture()
    const f2 = await fixture()
    const app = buildApp()
    const t1 = tok(f1.tenantUserId, 'tenant', f1.tenantId)
    const t2 = tok(f2.tenantUserId, 'tenant', f2.tenantId)
    const a  = tok(f1.adminUserId, 'super_admin', f1.adminUserId)
    const sa = jwt.sign({ userId: f1.adminUserId, role: 'super_admin', profileId: f1.adminUserId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    // S542c: t1 inquires FIRST but needs a LONG float (benefit day 25
    // → ~20d past the default day-5 grace front); t2 inquires second
    // with a SHORT float (day 6 → ~1d). Float need beats FIFO.
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t1}`).send({ incomeSource: 'ssi', benefitDay: 25 })
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t2}`).send({ incomeSource: 'ssdi', benefitDay: 6 })

    // Tenants NEVER see a queue number — no promises.
    const g1 = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t1}`)
    expect(g1.body.data.queuePosition).toBeUndefined()
    expect(g1.body.data.stateHold).toBe(false)

    // Admin-side ordering: shortest float first, FIFO tiebreak.
    const ordered = await request(app).get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${a}`)
    const r1 = ordered.body.data.find((r: any) => r.tenant_id === f1.tenantId)
    const r2 = ordered.body.data.find((r: any) => r.tenant_id === f2.tenantId)
    expect(r2.queue_position).toBe(1)
    expect(r2.est_float_days).toBe(1)    // day 6 − grace 5
    expect(r1.queue_position).toBe(2)
    expect(r1.est_float_days).toBe(20)   // day 25 − grace 5
    expect(ordered.body.data.map((r: any) => r.tenant_id)).toEqual([f2.tenantId, f1.tenantId])

    // Proof upload → auto-verified (name matches) → tenant GET carries
    // it → admin can stream it.
    const up = await uploadProof(app, t1, f1.tenantName)
    expect(up.status).toBe(200)
    const g1b = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t1}`)
    expect(g1b.body.data.inquiry.proof_original_name).toBe('award.pdf')

    const list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    const row1 = list.body.data.find((r: any) => r.tenant_id === f1.tenantId)
    expect(row1.proof_original_name).toBe('award.pdf')
    expect(row1.auto_verification?.nameMatch).toBe('matched')
    const proof = await request(app).get(`/api/admin/flexpay/inquiries/${row1.id}/proof-file`)
      .set('Authorization', `Bearer ${a}`)
    expect(proof.status).toBe(200)
    expect(proof.headers['content-type']).toMatch(/application\/pdf/)

    // State hold: block AZ (the fixture state) → tenant sees hold,
    // approval 422s and the tenant KEEPS their place; unblock → passes.
    const block = await request(app).put('/api/admin/flexpay/blocked-states/az')
      .set('Authorization', `Bearer ${sa}`).send({ reason: 'test statute' })
    expect(block.status).toBe(200)
    const held = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t1}`)
    expect(held.body.data.stateHold).toBe(true)

    const blockedApprove = await request(app).post(`/api/admin/flexpay/inquiries/${row1.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(blockedApprove.status).toBe(422)
    expect(blockedApprove.body.error).toMatch(/state hold/i)
    const still = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t1}`)
    expect(still.body.data.inquiry.status).toBe('pending')
    // Place preserved admin-side (still #2 behind the short-float tenant).
    const heldList = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    expect(heldList.body.data.find((r: any) => r.tenant_id === f1.tenantId).queue_position).toBe(2)

    await request(app).delete('/api/admin/flexpay/blocked-states/AZ')
      .set('Authorization', `Bearer ${sa}`)
    const ok = await request(app).post(`/api/admin/flexpay/inquiries/${row1.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(ok.status).toBe(200)
  })

  it('S578: a prior default demotes a returner behind first-timers, overriding float-need', async () => {
    // f1 = RETURNER (has a defaulted advance) with a SHORT float; f2 =
    // FIRST-TIMER with a LONG float. Under pure S542c float-need ordering
    // f1 sorts #1 — the returner demotion must flip it so every first-timer
    // ranks ahead of any returner. Both SSI so that tier can't confound.
    const f1 = await fixture()
    const f2 = await fixture()
    const app = buildApp()
    const t1 = tok(f1.tenantUserId, 'tenant', f1.tenantId)
    const t2 = tok(f2.tenantUserId, 'tenant', f2.tenantId)
    const a  = tok(f1.adminUserId, 'super_admin', f1.adminUserId)

    // Mark f1 a returner: a defaulted FlexPay advance on their record.
    const ctx = await db.query<any>(
      `SELECT l.id AS lease_id, l.unit_id, p.landlord_id
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE lt.tenant_id = $1 LIMIT 1`, [f1.tenantId])
    const c = ctx.rows[0]
    await db.query(
      `INSERT INTO flexpay_advances
         (cycle_month, tenant_id, landlord_id, unit_id, lease_id,
          rent_amount, tenant_fee_amount, pull_day, status, defaulted_at)
       VALUES ('2026-06-01', $1, $2, $3, $4, 440, 25, 10, 'defaulted', NOW())`,
      [f1.tenantId, c.landlord_id, c.unit_id, c.lease_id])

    // f1 SHORT float (day 6 → ~1d), f2 LONG float (day 25 → ~20d).
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t1}`).send({ incomeSource: 'ssi', benefitDay: 6 })
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t2}`).send({ incomeSource: 'ssi', benefitDay: 25 })

    const list = await request(app).get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${a}`)
    const r1 = list.body.data.find((r: any) => r.tenant_id === f1.tenantId)
    const r2 = list.body.data.find((r: any) => r.tenant_id === f2.tenantId)

    // Returner flag exposed to admin; first-timer wins despite shorter-float returner.
    expect(r1.is_flexpay_returner).toBe(true)
    expect(r2.is_flexpay_returner).toBe(false)
    expect(r2.queue_position).toBe(1)
    expect(r1.queue_position).toBe(2)
    expect(list.body.data.map((r: any) => r.tenant_id)).toEqual([f2.tenantId, f1.tenantId])
  })

  it('S543: admin captures benefit day during reach-out; locked after review', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)

    // Inquiry WITHOUT a day (questionnaire-style) → float unknown.
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`).send({ incomeSource: 'ssi' })
    let list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    const inqId = list.body.data[0].id
    expect(list.body.data[0].est_float_days).toBeNull()

    // Reach-out captures day 7 → float = 7 − grace 5 = 2.
    const set = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/benefit-day`)
      .set('Authorization', `Bearer ${a}`).send({ benefitDay: 7 })
    expect(set.status).toBe(200)
    await uploadProof(app, t, f.tenantName)   // S545: approval below needs proof on file
    list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    expect(list.body.data[0].desired_pull_day).toBe(7)
    expect(list.body.data[0].est_float_days).toBe(2)

    // Out-of-range rejected; reviewed rows locked.
    const bad = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/benefit-day`)
      .set('Authorization', `Bearer ${a}`).send({ benefitDay: 31 })
    expect(bad.status).toBe(400)
    await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    const locked = await request(app).post(`/api/admin/flexpay/inquiries/${inqId}/benefit-day`)
      .set('Authorization', `Bearer ${a}`).send({ benefitDay: 9 })
    expect(locked.status).toBe(404)
  })

  it('S544 survey mode: enrollment closed pre-launch even for APPROVED tenants; GET carries enrollmentOpen', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)

    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexpay_enrollment_open'`)

    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`).send({ incomeSource: 'ssi', benefitDay: 6 })
    await uploadProof(app, t, f.tenantName)   // S545: approval below needs proof on file
    const g = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t}`)
    expect(g.body.data.enrollmentOpen).toBe(false)

    // Even a fully approved tenant cannot enroll pre-launch.
    const list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    await request(app).post(`/api/admin/flexpay/inquiries/${list.body.data[0].id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    const enroll = await request(app).post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${t}`).send({ pullDay: 6, acceptedTerms: true })
    expect(enroll.status).toBe(400)
    expect(enroll.body.error).toMatch(/hasn.t launched/i)

    // Launch flip → same tenant enrolls.
    await db.query(`UPDATE system_features SET enabled = TRUE WHERE key = 'flexpay_enrollment_open'`)
    const open = await request(app).post('/api/tenants/flexpay/enroll')
      .set('Authorization', `Bearer ${t}`).send({ pullDay: 6, acceptedTerms: true })
    expect(open.status).toBe(200)
  })

  it('S545 income tiers: non-SSI/SSDI files tier-2 — sorts behind tier 1, approval income-held until expansion opens, never sets ssi_ssdi', async () => {
    const f1 = await fixture()   // tier-2: other_fixed, SHORT float
    const f2 = await fixture()   // tier-1: ssi, LONG float
    const app = buildApp()
    const t1 = tok(f1.tenantUserId, 'tenant', f1.tenantId)
    const t2 = tok(f2.tenantUserId, 'tenant', f2.tenantId)
    const a  = tok(f1.adminUserId, 'super_admin', f1.adminUserId)
    // Upsert, not UPDATE — gam_test's schema snapshot carries no seed
    // rows, so the flag row may not exist yet.
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_other_income_open', FALSE, 'S545 test flag')
       ON CONFLICT (key) DO UPDATE SET enabled = FALSE`)

    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t1}`).send({ incomeSource: 'other_fixed', benefitDay: 6 })
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t2}`).send({ incomeSource: 'ssi', benefitDay: 25 })

    // Tier beats float: SSI with a 20-day float still outranks
    // other_fixed with a 1-day float.
    const list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    const r1 = list.body.data.find((r: any) => r.tenant_id === f1.tenantId)
    const r2 = list.body.data.find((r: any) => r.tenant_id === f2.tenantId)
    expect(r2.queue_position).toBe(1)
    expect(r1.queue_position).toBe(2)
    expect(r1.income_hold).toBe(true)
    expect(r2.income_hold).toBe(false)

    // Tier-2 approval blocked while expansion is closed (even with
    // proof + attestation); place preserved.
    await uploadProof(app, t1, f1.tenantName)
    const held = await request(app).post(`/api/admin/flexpay/inquiries/${r1.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(held.status).toBe(422)
    expect(held.body.error).toMatch(/income-type hold/i)

    // Expansion opens → approval passes and does NOT set ssi_ssdi.
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexpay_other_income_open', TRUE, 'S545 test flag')
       ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
    const ok = await request(app).post(`/api/admin/flexpay/inquiries/${r1.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(ok.status).toBe(200)
    const trow = await db.query<any>(`SELECT ssi_ssdi FROM tenants WHERE id=$1`, [f1.tenantId])
    expect(trow.rows[0].ssi_ssdi).toBe(false)
    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexpay_other_income_open'`)
  })

  it('S545b: benefit schedules derive the conservative day (SSDI 4th Wed → 28)', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)

    const res = await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`)
      .send({ incomeSource: 'ssdi', benefitSchedule: 'ssdi_wed_4' })
    expect(res.status).toBe(200)

    const list = await request(app).get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${a}`)
    const row = list.body.data[0]
    expect(row.benefit_schedule).toBe('ssdi_wed_4')
    expect(row.desired_pull_day).toBe(28)     // latest a 4th Wednesday can land
    expect(row.est_float_days).toBe(23)       // 28 − default grace 5
  })

  it('S545c: birthdate mismatch silently holds — out of queue, tenant sees nothing, release restores the spot', async () => {
    const f = await fixture()
    const app = buildApp()
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)
    // Lease holder born on the 5th → SSDI pays the 2nd Wednesday.
    await db.query(`UPDATE tenants SET date_of_birth='1960-03-05' WHERE id=$1`, [f.tenantId])

    // Claims 4th Wednesday → inconsistent → SILENT auto-hold.
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t}`)
      .send({ incomeSource: 'ssdi', benefitSchedule: 'ssdi_wed_4' })

    // Tenant-facing: absolutely normal pending copy, no hold exposure.
    const g = await request(app).get('/api/tenants/flexpay').set('Authorization', `Bearer ${t}`)
    expect(g.body.data.inquiry.status).toBe('pending')
    // Verification-hold fields must never reach the tenant. (stateHold
    // is a DIFFERENT, intentionally-visible feature — state blocks.)
    expect(g.body.data.inquiry.held_at).toBeUndefined()
    expect(g.body.data.inquiry.hold_reason).toBeUndefined()

    // Admin-facing: held, out of the numbered queue, reason recorded.
    const list = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    const row = list.body.data[0]
    expect(row.held_at).toBeTruthy()
    expect(row.hold_reason).toMatch(/2nd Wednesday/)
    expect(row.queue_position).toBeNull()

    // Held rows can't be decided.
    await uploadProof(app, t, f.tenantName)
    const blocked = await request(app).post(`/api/admin/flexpay/inquiries/${row.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error).toMatch(/verification hold/i)

    // Release → back in line at the original spot; then approvable.
    const rel = await request(app).post(`/api/admin/flexpay/inquiries/${row.id}/release-hold`)
      .set('Authorization', `Bearer ${a}`).send({})
    expect(rel.status).toBe(200)
    const after = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    expect(after.body.data[0].queue_position).toBe(1)
    const ok = await request(app).post(`/api/admin/flexpay/inquiries/${row.id}/review`)
      .set('Authorization', `Bearer ${a}`).send({ action: 'approve', incomeVerified: true, nameMatchConfirmed: true })
    expect(ok.status).toBe(200)

    // Consistent claims never hold: lease holder born the 25th → 4th Wed.
    const f2 = await fixture()
    const t2 = tok(f2.tenantUserId, 'tenant', f2.tenantId)
    await db.query(`UPDATE tenants SET date_of_birth='1955-07-25' WHERE id=$1`, [f2.tenantId])
    await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${t2}`)
      .send({ incomeSource: 'ssdi', benefitSchedule: 'ssdi_wed_4' })
    const list2 = await request(app).get('/api/admin/flexpay/inquiries').set('Authorization', `Bearer ${a}`)
    const row2 = list2.body.data.find((r: any) => r.tenant_id === f2.tenantId)
    expect(row2.held_at).toBeNull()
    expect(row2.queue_position).toBe(1)
  })

  it('non-tenant cannot inquire; non-admin cannot review', async () => {
    const f = await fixture()
    const app = buildApp()
    const a = tok(f.adminUserId, 'super_admin', f.adminUserId)
    const t = tok(f.tenantUserId, 'tenant', f.tenantId)

    const asAdmin = await request(app).post('/api/tenants/flexpay/inquiry')
      .set('Authorization', `Bearer ${a}`).send({ incomeSource: 'ssi' })
    expect(asAdmin.status).toBe(403)

    const asTenant = await request(app).get('/api/admin/flexpay/inquiries')
      .set('Authorization', `Bearer ${t}`)
    expect(asTenant.status).toBe(403)
  })
})
