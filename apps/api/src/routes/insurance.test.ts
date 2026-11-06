/**
 * 11/01 — ONE HOME FOR INSURANCE.
 *
 * What is tested is the subsystem AND the two things that would rot first:
 *
 *   PER-ROW AUTHORIZATION, on the row and on the FILE. Reading another
 *   landlord's record is the recurring bug class in this codebase, and the
 *   uploaded certificate is the half that gets forgotten — the row check gets
 *   written, the file serve streams whatever the id points at. So both are
 *   asserted on every verb: another company's policy answers 404 on the read,
 *   on the certificate, on the edit and on the void, and the same id answers
 *   200 for the company it belongs to in the same test. A 404 rather than a 403
 *   is itself the assertion: "Forbidden" on a guessed id confirms the id is
 *   real.
 *
 *   THE LAPSE WINDOW BOUNDARY. "Expires within N days" is an off-by-one waiting
 *   to happen, and an off-by-one here means an operator is not told about the
 *   policy that lapses on the last day of the window. Four policies are seeded
 *   relative to the calendar — expired yesterday, expiring today, expiring on
 *   day N, expiring on day N+1 — and the list has to draw the line in exactly
 *   one place. Dates are computed with the same addDaysTo the route uses, never
 *   hardcoded, so the test says the same thing on any day and in any timezone
 *   ([[gam-date-dependent-test-landmine]], [[gam-evening-utc-today-flakes]]).
 *
 * Run:
 *   cd apps/api && DB_NAME=gam_test npx vitest run src/routes/insurance.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { addDaysTo, todayIn } from '../lib/timezone'

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'insurance')

let insuranceRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_insurance'
  ;({ insuranceRouter } = await import('./insurance'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

afterAll(() => {
  // Best-effort: the certificates these tests upload are real bytes on disk.
  if (fs.existsSync(UPLOAD_ROOT)) fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true })
})

function buildApp() {
  const app = express()
  app.use(express.json())
  // The API camelizes every response; a frontend reads camelCase off these, so
  // the test asserts the shape production actually serves
  // ([[gam-camelize-wire-contract-test-gap]]).
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/insurance', insuranceRouter)
  app.use(errorHandler)
  return app
}

const app = () => request(buildApp())

const landlordToken = (userId: string, landlordId: string) =>
  jwt.sign({ userId, role: 'landlord', email: `ll-${userId}@t.dev`,
             profileId: landlordId, landlordIds: [landlordId], permissions: {} },
           process.env.JWT_SECRET!, { expiresIn: '1h' })

/** One company: a park with a space, a live lease on it, and a vendor. */
async function seedCompany(name = 'Mountain View RV Park') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, name])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId })
    const vendor = await c.query<{ id: string }>(
      `INSERT INTO books_vendors (landlord_id, name, vendor_type)
       VALUES ($1, 'Pruitt Plumbing', 'contractor') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, leaseId,
             vendorId: vendor.rows[0].id, token: landlordToken(userId, landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A second property on the same company, for the narrowed-staff case. */
async function addProperty(landlordId: string, ownerUserId: string, name: string) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, name])
    await c.query('COMMIT')
    return propertyId
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The front desk, scoped the way the owner scopes them: these properties only. */
async function seedDesk(
  landlordId: string,
  opts: { propertyIds?: string[]; allProperties?: boolean; permissions?: Record<string, boolean> } = {},
) {
  const userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
     VALUES ($1, $2, 'x', 'Front', 'Desk', 'onsite_manager')`,
    [userId, `desk-${userId}@t.dev`])
  const perms = opts.permissions ?? { 'insurance.view': true, 'insurance.manage': true }
  await db.query(
    `INSERT INTO onsite_manager_scopes
       (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
     VALUES ($1, $2, $3, '{}', $4, $5::jsonb)`,
    [userId, landlordId, opts.propertyIds ?? [], opts.allProperties === true, JSON.stringify(perms)])
  return {
    userId,
    token: jwt.sign({ userId, role: 'onsite_manager', email: `desk-${userId}@t.dev`,
                      profileId: userId, landlordId, landlordIds: [landlordId], permissions: perms },
                    process.env.JWT_SECRET!, { expiresIn: '1h' }),
  }
}

async function seedTenantToken() {
  const userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
     VALUES ($1, $2, 'x', 'Reni', 'Dent', 'tenant')`, [userId, `t-${userId}@t.dev`])
  const t = await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
  return jwt.sign({ userId, role: 'tenant', email: `t-${userId}@t.dev`,
                    profileId: t.rows[0].id, permissions: {} },
                  process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const post = (token: string, body: any) =>
  app().post('/api/insurance').set('Authorization', `Bearer ${token}`).send(body)
const get = (token: string, url = '/api/insurance') =>
  app().get(url).set('Authorization', `Bearer ${token}`)

/** A PDF's first bytes — enough for multer's mime check and for a real stream. */
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer<<>>\n%%EOF\n')

async function recordBuilding(token: string, propertyId: string, over: Record<string, unknown> = {}) {
  const res = await post(token, {
    propertyId, coverageType: 'building', carrierName: 'Anchor Mutual',
    policyNumber: 'BLD-4471', coverageAmount: 2_500_000,
    effectiveDate: '2026-01-01', expiryDate: '2026-12-31', ...over,
  })
  expect(res.status).toBe(201)
  return res.body.data
}

async function attachProof(token: string, policyId: string) {
  const res = await app()
    .post(`/api/insurance/${policyId}/proof`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', TINY_PDF, { filename: 'coi.pdf', contentType: 'application/pdf' })
  expect(res.status).toBe(201)
  return res.body.data
}

// ═══════════════════════════════════════════════════════════════
//  All three kinds have a home
// ═══════════════════════════════════════════════════════════════

describe('one home, three kinds of certificate', () => {
  it("records the landlord's own building policy against the PROPERTY", async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    expect(p.subject).toBe('property')
    expect(p.propertyId).toBe(a.propertyId)
    expect(p.subjectName).toBe('Mountain View RV Park')
    expect(p.carrierName).toBe('Anchor Mutual')
    expect(p.coverageType).toBe('building')
    expect(Number(p.coverageAmount)).toBe(2_500_000)
    expect(p.expiryDate).toBe('2026-12-31')
    // Who recorded it, and that nobody has checked it yet.
    expect(p.recordedByUserId).toBe(a.userId)
    expect(p.verified).toBe(false)
    expect(p.verifiedAt).toBeNull()
    expect(p.hasProof).toBe(false)
    // The path on GAM's disk is never on the wire — the file has its own route.
    expect(p.proofUrl).toBeUndefined()
  })

  it("records the resident's renters liability against the LEASE", async () => {
    const a = await seedCompany()
    const res = await post(a.token, {
      leaseId: a.leaseId, coverageType: 'renters_liability',
      carrierName: 'Lemonade', policyNumber: 'RL-9', coverageAmount: 100_000,
      expiryDate: addDaysTo(todayIn(null), 200),
    })
    expect(res.status).toBe(201)
    expect(res.body.data.subject).toBe('resident')
    expect(res.body.data.leaseId).toBe(a.leaseId)
    expect(res.body.data.ownerPropertyId).toBe(a.propertyId)
  })

  it("records a vendor's general liability AND its bond as two policies", async () => {
    const a = await seedCompany()
    const gl = await post(a.token, {
      vendorId: a.vendorId, coverageType: 'general_liability',
      carrierName: 'Hartford', coverageAmount: 1_000_000, expiryDate: '2027-06-30',
    })
    const bond = await post(a.token, {
      vendorId: a.vendorId, coverageType: 'surety_bond',
      carrierName: 'Travelers', coverageAmount: 25_000, expiryDate: '2027-06-30',
    })
    expect(gl.status).toBe(201)
    expect(bond.status).toBe(201)
    expect(gl.body.data.subject).toBe('vendor')
    // A vendor belongs to a company, not to a property.
    expect(gl.body.data.ownerPropertyId).toBeNull()

    const list = await get(a.token, `/api/insurance?vendorId=${a.vendorId}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((r: any) => r.coverageType).sort())
      .toEqual(['general_liability', 'surety_bond'])
  })

  it('refuses a kind of cover that subject cannot carry, in a sentence', async () => {
    const a = await seedCompany()
    const res = await post(a.token, {
      leaseId: a.leaseId, coverageType: 'building', carrierName: 'Anchor Mutual',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Renters liability')
    expect(res.body.error).not.toContain('coverage_type')
  })

  it('refuses a policy about nothing, and a policy about two things', async () => {
    const a = await seedCompany()
    const none = await post(a.token, { coverageType: 'building', carrierName: 'Anchor Mutual' })
    expect(none.status).toBe(400)
    expect(none.body.error).toMatch(/a property, a resident's lease, or a vendor/)

    const two = await post(a.token, {
      propertyId: a.propertyId, vendorId: a.vendorId,
      coverageType: 'general_liability', carrierName: 'Hartford',
    })
    expect(two.status).toBe(400)
    expect(two.body.error).toMatch(/belongs to one thing/)
  })

  it('refuses an expiry date before the day the policy starts', async () => {
    const a = await seedCompany()
    const res = await post(a.token, {
      propertyId: a.propertyId, coverageType: 'building', carrierName: 'Anchor Mutual',
      effectiveDate: '2026-06-01', expiryDate: '2026-05-01',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/check the dates on the certificate/)
  })

  it('states no coverage requirement and no state rule anywhere in its refusals', async () => {
    // GAM never gates on legality. A policy with no amount at all is recorded.
    const a = await seedCompany()
    const res = await post(a.token, {
      propertyId: a.propertyId, coverageType: 'general_liability', carrierName: 'Anchor Mutual',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.coverageAmount).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
//  Per-row authorization — the row AND the file
// ═══════════════════════════════════════════════════════════════

describe('a landlord never reaches another landlord\'s policy', () => {
  it('404s the ROW for the other company, and serves it to its own', async () => {
    const a = await seedCompany('Mountain View RV Park')
    const b = await seedCompany('Oak Park')
    const p = await recordBuilding(a.token, a.propertyId)

    const mine = await get(a.token, `/api/insurance/${p.id}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data.id).toBe(p.id)

    const theirs = await get(b.token, `/api/insurance/${p.id}`)
    // 404, not 403: "Forbidden" on a guessed id confirms the id is real.
    expect(theirs.status).toBe(404)
    expect(theirs.body.error).toBe('Policy not found')
  })

  it('404s the UPLOADED CERTIFICATE for the other company, and streams it to its own', async () => {
    const a = await seedCompany()
    const b = await seedCompany('Oak Park')
    const p = await recordBuilding(a.token, a.propertyId)
    const withProof = await attachProof(a.token, p.id)
    expect(withProof.hasProof).toBe(true)
    expect(withProof.proofFileName).toBe('coi.pdf')
    expect(withProof.proofMimeType).toBe('application/pdf')

    const mine = await get(a.token, `/api/insurance/${p.id}/proof`)
    expect(mine.status).toBe(200)
    expect(mine.headers['content-type']).toContain('application/pdf')
    expect(mine.body.length).toBeGreaterThan(0)

    const theirs = await get(b.token, `/api/insurance/${p.id}/proof`)
    expect(theirs.status).toBe(404)
    expect(theirs.body.error).toBe('Policy not found')
  })

  it('404s an EDIT, a VERIFY, a VOID and a PROOF UPLOAD from the other company', async () => {
    const a = await seedCompany()
    const b = await seedCompany('Oak Park')
    const p = await recordBuilding(a.token, a.propertyId)

    const edit = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${b.token}`).send({ carrierName: 'Nope Mutual' })
    expect(edit.status).toBe(404)

    const verify = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${b.token}`).send({ verified: true })
    expect(verify.status).toBe(404)

    const voided = await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${b.token}`).send({ reason: 'not mine' })
    expect(voided.status).toBe(404)

    const upload = await app().post(`/api/insurance/${p.id}/proof`)
      .set('Authorization', `Bearer ${b.token}`)
      .attach('file', TINY_PDF, { filename: 'coi.pdf', contentType: 'application/pdf' })
    expect(upload.status).toBe(404)

    // And nothing moved on the row.
    const rows = await query<{ carrier_name: string; verified_at: string | null; voided_at: string | null; proof_url: string | null }>(
      `SELECT carrier_name, verified_at, voided_at, proof_url FROM insurance_policies WHERE id = $1`, [p.id])
    expect(rows[0].carrier_name).toBe('Anchor Mutual')
    expect(rows[0].verified_at).toBeNull()
    expect(rows[0].voided_at).toBeNull()
    expect(rows[0].proof_url).toBeNull()
  })

  it('never lists another company\'s policies', async () => {
    const a = await seedCompany()
    const b = await seedCompany('Oak Park')
    await recordBuilding(a.token, a.propertyId)
    await recordBuilding(b.token, b.propertyId, { carrierName: 'Other Mutual' })

    const mine = await get(a.token)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toHaveLength(1)
    expect(mine.body.data[0].carrierName).toBe('Anchor Mutual')
    expect(mine.body.data.map((r: any) => r.ownerLandlordId)).toEqual([a.landlordId])
  })

  it('cannot FILE a policy against another company\'s property, lease or vendor', async () => {
    const a = await seedCompany()
    const b = await seedCompany('Oak Park')

    const prop = await post(b.token, {
      propertyId: a.propertyId, coverageType: 'building', carrierName: 'Anchor Mutual' })
    expect(prop.status).toBe(404)
    expect(prop.body.error).toBe('Property not found')

    const lease = await post(b.token, {
      leaseId: a.leaseId, coverageType: 'renters_liability', carrierName: 'Lemonade' })
    expect(lease.status).toBe(404)
    expect(lease.body.error).toBe('Lease not found')

    const vendor = await post(b.token, {
      vendorId: a.vendorId, coverageType: 'general_liability', carrierName: 'Hartford' })
    expect(vendor.status).toBe(404)
    expect(vendor.body.error).toBe('Vendor not found')

    expect(await query(`SELECT 1 FROM insurance_policies`, [])).toHaveLength(0)
  })

  it('a resident reaches nothing here at all', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const tenant = await seedTenantToken()

    for (const url of ['/api/insurance', '/api/insurance/lapses',
                       `/api/insurance/${p.id}`, `/api/insurance/${p.id}/proof`]) {
      expect((await get(tenant, url)).status, url).toBe(403)
    }
    expect((await post(tenant, {
      propertyId: a.propertyId, coverageType: 'building', carrierName: 'X' })).status).toBe(403)
  })

  it('a desk narrowed to one park sees that park\'s policy and the company\'s vendor paper, not the other park', async () => {
    const a = await seedCompany('Mountain View RV Park')
    const other = await addProperty(a.landlordId, a.userId, 'Oak Park')
    const mine = await recordBuilding(a.token, a.propertyId)
    const notMine = await recordBuilding(a.token, other, { carrierName: 'Other Mutual' })
    const vendorPolicy = await post(a.token, {
      vendorId: a.vendorId, coverageType: 'general_liability',
      carrierName: 'Hartford', expiryDate: '2027-06-30' })
    expect(vendorPolicy.status).toBe(201)

    const desk = await seedDesk(a.landlordId, { propertyIds: [a.propertyId] })
    const list = await get(desk.token)
    expect(list.status).toBe(200)
    const ids = list.body.data.map((r: any) => r.id).sort()
    expect(ids).toEqual([mine.id, vendorPolicy.body.data.id].sort())
    expect(ids).not.toContain(notMine.id)

    // And the other park's row is not reachable by its id either, row or file.
    expect((await get(desk.token, `/api/insurance/${notMine.id}`)).status).toBe(404)
    expect((await get(desk.token, `/api/insurance/${notMine.id}/proof`)).status).toBe(404)
    expect((await get(desk.token, `/api/insurance/${mine.id}`)).status).toBe(200)
  })

  it('a desk with view only cannot record, edit or void', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const desk = await seedDesk(a.landlordId, {
      propertyIds: [a.propertyId], permissions: { 'insurance.view': true } })

    expect((await get(desk.token, `/api/insurance/${p.id}`)).status).toBe(200)
    expect((await post(desk.token, {
      propertyId: a.propertyId, coverageType: 'building', carrierName: 'X' })).status).toBe(403)
    expect((await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${desk.token}`).send({ verified: true })).status).toBe(403)
    expect((await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${desk.token}`).send({ reason: 'no' })).status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  The lapse list
// ═══════════════════════════════════════════════════════════════

describe('the lapse list', () => {
  const DAYS = 30

  /** Four certificates, placed on either side of both edges of the window. */
  async function seedWindow(token: string, propertyId: string) {
    const today = todayIn(null)
    const at = async (expiry: string, carrier: string) =>
      (await recordBuilding(token, propertyId, {
        carrierName: carrier, effectiveDate: null, expiryDate: expiry, policyNumber: null,
      })).id
    return {
      today,
      lapsedYesterday: await at(addDaysTo(today, -1), 'Lapsed Yesterday Mutual'),
      expiresToday:    await at(today,                'Expires Today Mutual'),
      lastDayIn:       await at(addDaysTo(today, DAYS), 'Day Thirty Mutual'),
      firstDayOut:     await at(addDaysTo(today, DAYS + 1), 'Day Thirty One Mutual'),
      noEndDate:       await at(null as unknown as string, 'Open Ended Mutual'),
    }
  }

  it('draws the window line in exactly one place: day N is in, day N+1 is out', async () => {
    const a = await seedCompany()
    const w = await seedWindow(a.token, a.propertyId)

    const res = await get(a.token, `/api/insurance/lapses?days=${DAYS}`)
    expect(res.status).toBe(200)
    expect(res.body.data.asOf).toBe(w.today)
    expect(res.body.data.days).toBe(DAYS)

    const expired = res.body.data.expired.map((r: any) => r.id)
    const soon = res.body.data.expiringSoon.map((r: any) => r.id)

    // Already gone is always on the list — that is what the list is for.
    expect(expired).toEqual([w.lapsedYesterday])
    // Expiring TODAY has not expired yet; it is the first thing expiring soon.
    expect(soon).toEqual([w.expiresToday, w.lastDayIn])
    // The far side of the edge, and a policy with nothing to lapse, are absent.
    expect([...expired, ...soon]).not.toContain(w.firstDayOut)
    expect([...expired, ...soon]).not.toContain(w.noEndDate)
  })

  it('a one-day-wider window takes in exactly the next policy', async () => {
    const a = await seedCompany()
    const w = await seedWindow(a.token, a.propertyId)
    const res = await get(a.token, `/api/insurance/lapses?days=${DAYS + 1}`)
    expect(res.status).toBe(200)
    expect(res.body.data.expiringSoon.map((r: any) => r.id))
      .toEqual([w.expiresToday, w.lastDayIn, w.firstDayOut])
  })

  it('days=0 is only what has gone plus what goes today', async () => {
    const a = await seedCompany()
    const w = await seedWindow(a.token, a.propertyId)
    const res = await get(a.token, '/api/insurance/lapses?days=0')
    expect(res.status).toBe(200)
    expect(res.body.data.expired.map((r: any) => r.id)).toEqual([w.lapsedYesterday])
    expect(res.body.data.expiringSoon.map((r: any) => r.id)).toEqual([w.expiresToday])
  })

  it('counts the days to expiry from the calendar, each way', async () => {
    const a = await seedCompany()
    const w = await seedWindow(a.token, a.propertyId)
    const res = await get(a.token, `/api/insurance/lapses?days=${DAYS}`)
    const byId = Object.fromEntries(
      [...res.body.data.expired, ...res.body.data.expiringSoon].map((r: any) => [r.id, r]))
    expect(byId[w.lapsedYesterday].daysUntilExpiry).toBe(-1)
    expect(byId[w.lapsedYesterday].expired).toBe(true)
    expect(byId[w.expiresToday].daysUntilExpiry).toBe(0)
    expect(byId[w.expiresToday].expired).toBe(false)
    expect(byId[w.lastDayIn].daysUntilExpiry).toBe(DAYS)
  })

  it('is scoped to the asking company — never another landlord\'s lapse', async () => {
    const a = await seedCompany()
    const b = await seedCompany('Oak Park')
    const today = todayIn(null)
    await recordBuilding(a.token, a.propertyId, {
      carrierName: 'Mine Mutual', effectiveDate: null, expiryDate: addDaysTo(today, -5) })
    await recordBuilding(b.token, b.propertyId, {
      carrierName: 'Theirs Mutual', effectiveDate: null, expiryDate: addDaysTo(today, -5) })

    const mine = await get(a.token, '/api/insurance/lapses')
    expect(mine.status).toBe(200)
    expect(mine.body.data.expired.map((r: any) => r.carrierName)).toEqual(['Mine Mutual'])
    expect(mine.body.data.days).toBe(30)   // the default window

    const theirs = await get(b.token, '/api/insurance/lapses')
    expect(theirs.body.data.expired.map((r: any) => r.carrierName)).toEqual(['Theirs Mutual'])
  })

  it('covers all three kinds in one list', async () => {
    const a = await seedCompany()
    const today = todayIn(null)
    await recordBuilding(a.token, a.propertyId, {
      carrierName: 'Building Mutual', effectiveDate: null, expiryDate: addDaysTo(today, 5) })
    await post(a.token, { leaseId: a.leaseId, coverageType: 'renters_liability',
                          carrierName: 'Resident Mutual', expiryDate: addDaysTo(today, 6) })
    await post(a.token, { vendorId: a.vendorId, coverageType: 'surety_bond',
                          carrierName: 'Bond Mutual', expiryDate: addDaysTo(today, 7) })

    const res = await get(a.token, '/api/insurance/lapses')
    expect(res.body.data.expiringSoon.map((r: any) => r.subject))
      .toEqual(['property', 'resident', 'vendor'])
  })

  it('refuses a window that is not a window, in a sentence', async () => {
    const a = await seedCompany()
    for (const bad of ['-1', '366', 'soon', '7.5']) {
      const res = await get(a.token, `/api/insurance/lapses?days=${bad}`)
      expect(res.status, bad).toBe(400)
      expect(res.body.error).toBe('Ask for a window between 0 and 365 days.')
    }
  })

  it('a policy taken off the record is not a lapse', async () => {
    const a = await seedCompany()
    const today = todayIn(null)
    const p = await recordBuilding(a.token, a.propertyId, {
      effectiveDate: null, expiryDate: addDaysTo(today, -2) })
    expect((await get(a.token, '/api/insurance/lapses')).body.data.expired).toHaveLength(1)

    const voided = await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${a.token}`).send({ reason: 'Wrong park — filed under Oak Park by mistake' })
    expect(voided.status).toBe(200)
    expect((await get(a.token, '/api/insurance/lapses')).body.data.expired).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Editing, verifying, and keeping everything
// ═══════════════════════════════════════════════════════════════

describe('editing a policy', () => {
  it('verifying stamps who and when; unverifying clears both together', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)

    const on = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ verified: true })
    expect(on.status).toBe(200)
    expect(on.body.data.verified).toBe(true)
    expect(on.body.data.verifiedByUserId).toBe(a.userId)
    expect(on.body.data.verifiedAt).toBeTruthy()
    expect(on.body.data.verifiedByName).toBe('Test Landlord')

    const off = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ verified: false })
    expect(off.status).toBe(200)
    expect(off.body.data.verified).toBe(false)
    expect(off.body.data.verifiedAt).toBeNull()
    expect(off.body.data.verifiedByUserId).toBeNull()
  })

  it('checks a new expiry date against the start date already on the row', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)   // starts 2026-01-01
    const res = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ expiryDate: '2025-06-01' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/check the dates on the certificate/)
  })

  it('renews a policy in place: new number, new dates, verification cleared', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ verified: true })
    const res = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ policyNumber: 'BLD-5588', effectiveDate: '2027-01-01', expiryDate: '2027-12-31', verified: false })
    expect(res.status).toBe(200)
    expect(res.body.data.policyNumber).toBe('BLD-5588')
    expect(res.body.data.expiryDate).toBe('2027-12-31')
    expect(res.body.data.verified).toBe(false)
  })

  it('a voided policy is kept, off the list, and closed to further edits', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const voided = await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${a.token}`).send({ reason: 'Carrier cancelled mid-term' })
    expect(voided.status).toBe(200)
    expect(voided.body.data.voidedAt).toBeTruthy()
    expect(voided.body.data.voidReason).toBe('Carrier cancelled mid-term')

    // Off the default list, still there when asked for, and still on disk.
    expect((await get(a.token)).body.data).toHaveLength(0)
    expect((await get(a.token, '/api/insurance?includeVoided=true')).body.data).toHaveLength(1)
    expect(await query(`SELECT 1 FROM insurance_policies WHERE id = $1`, [p.id])).toHaveLength(1)

    const again = await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ carrierName: 'Anchor Mutual II' })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/Record the new certificate instead/)

    const twice = await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${a.token}`).send({ reason: 'again' })
    expect(twice.status).toBe(409)
  })

  it('will not take a void with no reason', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const res = await app().post(`/api/insurance/${p.id}/void`)
      .set('Authorization', `Bearer ${a.token}`).send({ reason: '  ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Say why this policy is coming off the record/)
  })

  it('refuses a certificate that is not a PDF or a photo', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const res = await app().post(`/api/insurance/${p.id}/proof`)
      .set('Authorization', `Bearer ${a.token}`)
      .attach('file', Buffer.from('MZ'), { filename: 'coi.exe', contentType: 'application/x-msdownload' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/PDF or a photo/)
  })

  it('says so plainly when a policy has no certificate uploaded yet', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    const res = await get(a.token, `/api/insurance/${p.id}/proof`)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('No certificate has been uploaded for this policy yet')
  })

  it('keeps what the row said before it was changed — the change journal is the record', async () => {
    const a = await seedCompany()
    const p = await recordBuilding(a.token, a.propertyId)
    await app().patch(`/api/insurance/${p.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({ coverageAmount: 3_000_000 })
    const journal = await query<{ old_row: any }>(
      `SELECT old_row FROM audit_row_changes
        WHERE table_name = 'insurance_policies' AND row_id = $1`, [p.id])
    expect(journal.length).toBeGreaterThan(0)
    expect(Number(journal[0].old_row.coverage_amount)).toBe(2_500_000)
  })
})
