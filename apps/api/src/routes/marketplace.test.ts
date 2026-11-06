/**
 * The contractor marketplace, end to end — 10/31.
 *
 * The tests that matter most here are the PRIVACY ones. Nic's whole reason for
 * building this instead of using Angie's List is that bids stay private: "They're
 * all private to the person so that people aren't just publicly underbidding
 * other people. It helps keep it fair." So the suite spends most of its effort
 * trying to make one contractor see another contractor's number, by every route
 * that returns anything, and trying to make one landlord read another landlord's
 * job.
 *
 * The money tests check the two things that are easy to get subtly wrong: the
 * cut is taken at the rate snapshotted when the job was AWARDED (not today's
 * rate), off the amount the job ACTUALLY FINISHED at (not the bid), and a
 * missing price card is an error rather than a free job.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { camelCaseKeys } from '../lib/caseConversion'
import type { PoolClient } from 'pg'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { expectNoFigures } from '../test/noLeaks'
import { marketplaceRouter } from './marketplace'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  // index.ts camelizes every response, so the frontend reads camelCase. The
  // test app installs the same layer, otherwise these tests would assert a
  // shape no browser ever sees.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/marketplace', marketplaceRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_marketplace'
})

interface Fixture {
  landlordAId: string; landlordBId: string
  propertyAId: string; propertyBId: string
  unitAId: string
  tokenA: string; tokenB: string
  contractor1Id: string; contractor2Id: string
  token1: string; token2: string
  tokenNoProfile: string
  adminToken: string
}

async function seedContractor(c: PoolClient, opts: {
  insured?: boolean; bonded?: boolean
  insuranceExpiry?: string | null; bondExpiry?: string | null
  status?: string
  trades?: string[]
} = {}): Promise<{ contractorId: string; userId: string }> {
  const u = await c.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'contractor', 'Con', 'Tractor', TRUE) RETURNING id`,
    [`con-${randomUUID()}@test.dev`])
  const r = await c.query<{ id: string }>(
    `INSERT INTO contractors
       (user_id, name, trades, status, insurance_verified, insurance_expiry,
        bond_verified, bond_expiry)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [u.rows[0].id, 'Test Contractor', opts.trades ?? ['plumbing'],
     opts.status ?? 'active',
     opts.insured ?? false, opts.insuranceExpiry ?? null,
     opts.bonded ?? false, opts.bondExpiry ?? null])
  return { contractorId: r.rows[0].id, userId: u.rows[0].id }
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const c1 = await seedContractor(c, { insured: true, bonded: true, trades: ['plumbing', 'hvac'] })
    const c2 = await seedContractor(c, { insured: false, bonded: false, trades: ['plumbing'] })
    const noProfile = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'contractor', 'No', 'Profile', TRUE) RETURNING id`,
      [`np-${randomUUID()}@test.dev`])
    const admin = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'A', 'U', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await c.query('COMMIT')
    const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAId: aId, landlordBId: bId,
      propertyAId: propA, propertyBId: propB, unitAId: unitA,
      tokenA: sign({ userId: aUid, role: 'landlord', email: 'la@t.dev', profileId: null,
                     landlordIds: [aId], permissions: {} }),
      tokenB: sign({ userId: bUid, role: 'landlord', email: 'lb@t.dev', profileId: null,
                     landlordIds: [bId], permissions: {} }),
      contractor1Id: c1.contractorId, contractor2Id: c2.contractorId,
      token1: sign({ userId: c1.userId, role: 'contractor', email: 'c1@t.dev', profileId: null, permissions: {} }),
      token2: sign({ userId: c2.userId, role: 'contractor', email: 'c2@t.dev', profileId: null, permissions: {} }),
      tokenNoProfile: sign({ userId: noProfile.rows[0].id, role: 'contractor', email: 'np@t.dev',
                             profileId: null, permissions: {} }),
      adminToken: sign({ userId: admin.rows[0].id, role: 'admin', email: 'a@t.dev', profileId: null, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const JOB = {
  title: 'Replace the water heater in space 12',
  description: 'The 40-gallon unit is leaking from the base and needs replacing.',
  trades: ['plumbing'],
  requiresInsured: false,
  requiresBonded: false,
}

async function postJob(app: any, f: Fixture, over: Record<string, unknown> = {}) {
  const r = await request(app).post('/api/marketplace/jobs')
    .set('Authorization', `Bearer ${f.tokenA}`)
    .send({ propertyId: f.propertyAId, ...JOB, ...over })
  return r
}

async function bid(app: any, token: string, jobId: string, amount: number, extra: Record<string, unknown> = {}) {
  return await request(app).post(`/api/marketplace/board/${jobId}/bid`)
    .set('Authorization', `Bearer ${token}`)
    .send({ amount, ...extra })
}

// ── posting a job ─────────────────────────────────────────────

describe('a landlord posts a job out for bids', () => {
  it('posts it, and the job belongs to the property\'s company', async () => {
    const app = buildApp(); const f = await seed()
    const r = await postJob(app, f)
    expect(r.status).toBe(201)
    expect(r.body.data.title).toBe(JOB.title)
    expect(r.body.data.status).toBe('open')
    // The landlord entity is read off the property, not off the caller.
    expect(r.body.data.landlordId).toBe(f.landlordAId)
  })

  it('refuses a property that is not theirs', async () => {
    const app = buildApp(); const f = await seed()
    const r = await request(app).post('/api/marketplace/jobs')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ propertyId: f.propertyBId, ...JOB })
    expect(r.status).toBeGreaterThanOrEqual(403)
    const rows = await query(`SELECT id FROM marketplace_jobs`)
    expect(rows.length).toBe(0)
  })

  it('refuses a space that is at another property', async () => {
    const app = buildApp(); const f = await seed()
    const other = await db.connect()
    let unitB: string
    try {
      await other.query('BEGIN')
      unitB = await seedUnit(other, { propertyId: f.propertyBId, landlordId: f.landlordBId })
      await other.query('COMMIT')
    } finally { other.release() }
    const r = await postJob(app, f, { unitId: unitB! })
    expect(r.status).toBe(404)
  })

  it('carries the insured and bonded requirement exactly as set, per job', async () => {
    const app = buildApp(); const f = await seed()
    const strict = await postJob(app, f, { requiresInsured: true, requiresBonded: true })
    const loose  = await postJob(app, f, { requiresInsured: false, requiresBonded: false })
    expect(strict.body.data.requiresInsured).toBe(true)
    expect(strict.body.data.requiresBonded).toBe(true)
    // Nothing is inherited from the property: two jobs at the SAME park
    // disagree, which is the whole point of per-job.
    expect(loose.body.data.requiresInsured).toBe(false)
    expect(loose.body.data.requiresBonded).toBe(false)
  })
})

// ── the board, and what a contractor can see ──────────────────

describe('the board a contractor browses', () => {
  it('shows open jobs and whether this contractor already bid', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const before = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(before.status).toBe(200)
    expect(before.body.data.jobs.length).toBe(1)
    expect(before.body.data.jobs[0].alreadyBid).toBe(false)

    await bid(app, f.token1, job.id, 900)
    const after = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(after.body.data.jobs[0].alreadyBid).toBe(true)
    // ...and the OTHER contractor still sees it as un-bid by them.
    const other = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(other.body.data.jobs[0].alreadyBid).toBe(false)
  })

  it('NEVER leaks another contractor\'s bid, a count, or a range', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 900)
    await bid(app, f.token2, job.id, 1250)

    for (const path of ['/api/marketplace/board', `/api/marketplace/board/${job.id}`]) {
      const r = await request(app).get(path).set('Authorization', `Bearer ${f.token2}`)
      expect(r.status).toBe(200)
      // The other contractor's number must not appear anywhere in the payload,
      // in any field, under any name. Asked of VALUES: hoisting the stringify
      // into a local does not make a bare-digit substring search deterministic,
      // it only hides it from testsAreDeterministic.
      expectNoFigures(r.body, [900])
      // A field NAME has letters in it, so no uuid can spell it — a plain
      // substring search is the right (and stronger) check for these.
      expect(JSON.stringify(r.body)).not.toMatch(/bidCount|bid_count|lowestBid|bidRange|bids"\s*:/)
    }
  })

  it('still shows a job whose requirement the contractor does not meet, and names the gap', async () => {
    const app = buildApp(); const f = await seed()
    await postJob(app, f, { requiresInsured: true, requiresBonded: true })
    // contractor2 has neither on file.
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(r.body.data.jobs.length).toBe(1)
    expect(r.body.data.jobs[0].requiresInsured).toBe(true)
    expect(r.body.data.me).toEqual({ insured: false, bonded: false })
  })

  it('reads expired insurance as not in force', async () => {
    const app = buildApp(); const f = await seed()
    await query(`UPDATE contractors SET insurance_expiry = CURRENT_DATE - 1 WHERE id = $1`,
      [f.contractor1Id])
    await postJob(app, f)
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.body.data.me.insured).toBe(false)
    // The bond is still live, so the two are judged separately.
    expect(r.body.data.me.bonded).toBe(true)
  })

  it('hides a job whose bidding window has closed', async () => {
    const app = buildApp(); const f = await seed()
    await postJob(app, f, { bidsCloseAt: new Date(Date.now() - 60_000).toISOString() })
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.body.data.jobs.length).toBe(0)
  })

  it('tells a login with no contractor profile what to do, rather than 500ing', async () => {
    const app = buildApp(); const f = await seed()
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.tokenNoProfile}`)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/no contractor profile/i)
  })
})

// ── bidding ───────────────────────────────────────────────────

describe('bidding', () => {
  it('records whether insurance and bond were in force AT BID TIME', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const r = await bid(app, f.token1, job.id, 1000, { daysToComplete: 3, notes: 'Can start Monday' })
    expect(r.status).toBe(201)
    expect(r.body.data.insuredAtBid).toBe(true)
    expect(r.body.data.bondedAtBid).toBe(true)

    // Insurance lapsing AFTERWARDS does not rewrite what the landlord saw.
    await query(`UPDATE contractors SET insurance_verified = false WHERE id = $1`, [f.contractor1Id])
    const bids = await request(app).get(`/api/marketplace/jobs/${job.id}/bids`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(bids.body.data[0].insuredAtBid).toBe(true)
    expect(bids.body.data[0].insuranceVerified).toBe(false)
  })

  it('allows a bid from a contractor who does not meet the requirement — the landlord decides', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f, { requiresInsured: true })).body.data
    const r = await bid(app, f.token2, job.id, 800)
    expect(r.status).toBe(201)
    expect(r.body.data.insuredAtBid).toBe(false)
  })

  it('refuses a second live bid from the same contractor, and says what to do', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    expect((await bid(app, f.token1, job.id, 1000)).status).toBe(201)
    const second = await bid(app, f.token1, job.id, 900)
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/withdraw it first/i)
  })

  it('lets them withdraw and bid again with a new number', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const first = await bid(app, f.token1, job.id, 1000)
    const w = await request(app).post(`/api/marketplace/my-bids/${first.body.data.id}/withdraw`)
      .set('Authorization', `Bearer ${f.token1}`)
    expect(w.status).toBe(200)
    expect((await bid(app, f.token1, job.id, 850)).status).toBe(201)
  })

  it('refuses to withdraw somebody else\'s bid', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const mine = await bid(app, f.token1, job.id, 1000)
    const r = await request(app).post(`/api/marketplace/my-bids/${mine.body.data.id}/withdraw`)
      .set('Authorization', `Bearer ${f.token2}`)
    expect(r.status).toBe(404)
    const still = await query<{ status: string }>(
      `SELECT status FROM marketplace_bids WHERE id = $1`, [mine.body.data.id])
    expect(still[0].status).toBe('submitted')
  })

  it('refuses a bid on a job that has stopped taking them', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b1.body.data.id })
    const late = await bid(app, f.token2, job.id, 500)
    expect(late.status).toBe(409)
    expect(late.body.error).toMatch(/Nothing was sent/)
  })

  it('refuses a bid from a suspended profile', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await query(`UPDATE contractors SET status = 'suspended' WHERE id = $1`, [f.contractor1Id])
    const r = await bid(app, f.token1, job.id, 1000)
    expect(r.status).toBe(403)
  })
})

// ── the landlord reading bids ─────────────────────────────────

describe('a landlord reading the bids on their own job', () => {
  it('sees every bid, cheapest first, with who made it', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 1250)
    await bid(app, f.token2, job.id, 900)
    const r = await request(app).get(`/api/marketplace/jobs/${job.id}/bids`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r.status).toBe(200)
    expect(r.body.data.map((b: any) => Number(b.amount))).toEqual([900, 1250])
    expect(r.body.data[0].contractorName).toBe('Test Contractor')
  })

  it('cannot read the bids on another landlord\'s job', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 1000)
    const r = await request(app).get(`/api/marketplace/jobs/${job.id}/bids`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(r.status).toBe(404)
    // The bid amount must not ride along in the refusal. Asked of VALUES
    // (noLeaks.ts) rather than as a substring of the blob: a uuid is hex, so
    // searching a stringified payload for bare digits answers by luck.
    expectNoFigures(r.body, [1000])
  })

  it('cannot read another landlord\'s job at all, or list it', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    expect((await request(app).get(`/api/marketplace/jobs/${job.id}`)
      .set('Authorization', `Bearer ${f.tokenB}`)).status).toBe(404)
    const list = await request(app).get('/api/marketplace/jobs')
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(list.body.data).toEqual([])
  })
})

// ── awarding ──────────────────────────────────────────────────

describe('awarding a job', () => {
  it('awards one bid, declines the rest, and snapshots the rate', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1250)
    const b2 = await bid(app, f.token2, job.id, 900)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b1.body.data.id })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('awarded')
    expect(Number(r.body.data.awardedAmount)).toBe(1250)
    expect(Number(r.body.data.cutPercentSnapshot)).toBe(3)

    const bids = await query<{ id: string; status: string }>(
      `SELECT id, status FROM marketplace_bids ORDER BY amount`)
    const byId = new Map(bids.map(b => [b.id, b.status]))
    expect(byId.get(b1.body.data.id)).toBe('accepted')
    // Nobody is left waiting on a job that is already gone.
    expect(byId.get(b2.body.data.id)).toBe('declined')
  })

  it('refuses a second award', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1000)
    const b2 = await bid(app, f.token2, job.id, 900)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b1.body.data.id })
    const again = await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b2.body.data.id })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/Nothing was changed/)
  })

  it('refuses to award another landlord\'s job', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1000)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenB}`).send({ bidId: b1.body.data.id })
    expect(r.status).toBe(404)
    const row = await query<{ status: string }>(`SELECT status FROM marketplace_jobs WHERE id=$1`, [job.id])
    expect(row[0].status).toBe('open')
  })

  it('refuses to award a bid that was withdrawn', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1000)
    await request(app).post(`/api/marketplace/my-bids/${b1.body.data.id}/withdraw`)
      .set('Authorization', `Bearer ${f.token1}`)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b1.body.data.id })
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/withdrawn/i)
  })
})

// ── the money ─────────────────────────────────────────────────

describe('GAM\'s cut of a finished job', () => {
  async function awarded(app: any, f: Fixture, amount = 1000) {
    const job = (await postJob(app, f)).body.data
    const b = await bid(app, f.token1, job.id, amount)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })
    return job
  }

  it('earns NOTHING on a job that is only posted, bid on, or awarded', async () => {
    const app = buildApp(); const f = await seed()
    await awarded(app, f, 4000)
    const book = await query(`SELECT * FROM platform_revenue_ledger WHERE type = 'marketplace_job_cut'`)
    expect(book.length).toBe(0)
  })

  it('books 3% when the job finishes, and the contractor nets the rest', async () => {
    const app = buildApp(); const f = await seed()
    const job = await awarded(app, f, 4000)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    expect(r.status).toBe(200)
    expect(r.body.data.cutAmount).toBe(120)
    expect(r.body.data.contractorNet).toBe(3880)
    const book = await query<{ type: string; amount: string; reference_id: string }>(
      `SELECT type, amount::text AS amount, reference_id FROM platform_revenue_ledger
        WHERE type = 'marketplace_job_cut'`)
    expect(book.length).toBe(1)
    expect(Number(book[0].amount)).toBe(120)
    expect(book[0].reference_id).toBe(job.id)
  })

  it('takes the cut off what the job ACTUALLY finished at, not the bid', async () => {
    const app = buildApp(); const f = await seed()
    const job = await awarded(app, f, 4000)
    // Scope moved; it settled higher.
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ finalAmount: 4600 })
    expect(r.body.data.cutAmount).toBe(138)        // 3% of 4,600
    expect(r.body.data.contractorNet).toBe(4462)
  })

  it('uses the rate snapshotted at AWARD, not a later re-price', async () => {
    const app = buildApp(); const f = await seed()
    const job = await awarded(app, f, 1000)        // snapshotted at 3%
    // GAM re-prices tomorrow-onward to 8%. The deal already struck stands.
    await query(
      `INSERT INTO marketplace_cut_rates (percent, effective_from, note)
       VALUES (8.000, CURRENT_DATE - 1, 'test re-price')`)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    expect(r.body.data.cutAmount).toBe(30)         // 3% of 1,000, not 8%
  })

  it('refuses a second completion and cannot double-book the cut', async () => {
    const app = buildApp(); const f = await seed()
    const job = await awarded(app, f, 1000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    const again = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    expect(again.status).toBe(409)
    const book = await query(`SELECT id FROM platform_revenue_ledger WHERE type='marketplace_job_cut'`)
    expect(book.length).toBe(1)
  })

  it('refuses to finish a job nobody was awarded', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ finalAmount: 500 })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/not been awarded/i)
    const book = await query(`SELECT id FROM platform_revenue_ledger WHERE type='marketplace_job_cut'`)
    expect(book.length).toBe(0)
  })

  it('counts the finished job on the contractor\'s record', async () => {
    const app = buildApp(); const f = await seed()
    const job = await awarded(app, f, 1000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    const c = await query<{ completed_jobs: number }>(
      `SELECT completed_jobs FROM contractors WHERE id = $1`, [f.contractor1Id])
    expect(c[0].completed_jobs).toBe(1)
  })

  it('a missing price card is an ERROR, never a free job', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b = await bid(app, f.token1, job.id, 1000)
    await query(`DELETE FROM marketplace_cut_rates`)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/no marketplace rate on file/i)
    // And the award did not half-happen.
    const row = await query<{ status: string; awarded_bid_id: string | null }>(
      `SELECT status, awarded_bid_id FROM marketplace_jobs WHERE id = $1`, [job.id])
    expect(row[0].status).toBe('open')
    expect(row[0].awarded_bid_id).toBeNull()
  })
})

// ── cancelling ────────────────────────────────────────────────

describe('cancelling a job', () => {
  it('cancels an open job and declines the live bids on it', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 1000)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/cancel`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ reason: 'Fixed it myself' })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('cancelled')
    const bids = await query<{ status: string }>(`SELECT status FROM marketplace_bids`)
    expect(bids[0].status).toBe('declined')
  })

  it('refuses to cancel a job that has already finished', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b = await bid(app, f.token1, job.id, 1000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })
    await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/cancel`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    expect(r.status).toBe(409)
  })
})

// ── the contractor's own work ─────────────────────────────────

describe('a contractor\'s own bids and jobs', () => {
  it('lists only their own bids', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 1250)
    await bid(app, f.token2, job.id, 900)
    const mine = await request(app).get('/api/marketplace/my-bids')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(mine.body.data.length).toBe(1)
    expect(Number(mine.body.data[0].amount)).toBe(1250)
    // Contractor 2's number must not appear anywhere in contractor 1's list —
    // asked of values, so a random id can never spell it.
    expectNoFigures(mine.body, [900])
  })

  it('marks work started only on a job awarded to them', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b = await bid(app, f.token1, job.id, 1000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })
    // The contractor who did NOT win cannot start it.
    expect((await request(app).post(`/api/marketplace/my-jobs/${job.id}/start`)
      .set('Authorization', `Bearer ${f.token2}`)).status).toBe(409)
    expect((await request(app).post(`/api/marketplace/my-jobs/${job.id}/start`)
      .set('Authorization', `Bearer ${f.token1}`)).status).toBe(200)
    const row = await query<{ status: string }>(`SELECT status FROM marketplace_jobs WHERE id=$1`, [job.id])
    expect(row[0].status).toBe('in_progress')
  })

  it('a job still completes and books the cut after work was marked started', async () => {
    const app = buildApp(); const f = await seed()
    const job = (await postJob(app, f)).body.data
    const b = await bid(app, f.token1, job.id, 2000)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })
    await request(app).post(`/api/marketplace/my-jobs/${job.id}/start`)
      .set('Authorization', `Bearer ${f.token1}`)
    const r = await request(app).post(`/api/marketplace/jobs/${job.id}/complete`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({})
    expect(r.status).toBe(200)
    expect(r.body.data.cutAmount).toBe(60)
  })
})

// ── the profile, and the free-to-join rule ────────────────────

describe('the contractor profile', () => {
  it('creates a profile with no fee of any kind', async () => {
    const app = buildApp(); const f = await seed()
    const r = await request(app).put('/api/marketplace/me')
      .set('Authorization', `Bearer ${f.tokenNoProfile}`)
      .send({ name: 'Bob the Builder', trades: ['roofing'], city: 'Mesa', state: 'AZ' })
    expect(r.status).toBe(200)
    const row = await query<{ listing_fee: string | null; listing_tier: string | null }>(
      `SELECT listing_fee, listing_tier FROM contractors WHERE name = 'Bob the Builder'`)
    expect(row[0].listing_fee).toBeNull()
    expect(row[0].listing_tier).toBeNull()
    // Joining earns GAM nothing.
    const book = await query(`SELECT id FROM platform_revenue_ledger`)
    expect(book.length).toBe(0)
  })

  it('keeps contractors.active in step with status, so the two cannot disagree', async () => {
    const app = buildApp(); const f = await seed()
    await query(`UPDATE contractors SET status = 'suspended' WHERE id = $1`, [f.contractor1Id])
    let row = await query<{ active: boolean }>(`SELECT active FROM contractors WHERE id=$1`, [f.contractor1Id])
    expect(row[0].active).toBe(false)
    await query(`UPDATE contractors SET status = 'active' WHERE id = $1`, [f.contractor1Id])
    row = await query<{ active: boolean }>(`SELECT active FROM contractors WHERE id=$1`, [f.contractor1Id])
    expect(row[0].active).toBe(true)
  })

  it('being listed costs nothing, and nothing about joining is a lead fee', async () => {
    const app = buildApp(); const f = await seed()
    // 10/31, asked directly: "i meant they didnt have to pay to play but they
    // can. top spot paid but listed free." So the CHECK that used to forbid any
    // listing fee outright is gone (migration 20261101003000) — position is a
    // product. What still holds is that PRESENCE is free: a contractor who pays
    // nothing is on the board and may bid on every open job.
    await postJob(app, f)
    const board = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(board.body.data.jobs.length).toBe(1)
    const job = board.body.data.jobs[0]
    expect((await bid(app, f.token2, job.id, 500)).status).toBe(201)
    // And none of it earned GAM a cent: the only money event is a finished job.
    const book = await query(`SELECT id FROM platform_revenue_ledger`)
    expect(book.length).toBe(0)
  })
})

// ── credentials and who may read them ─────────────────────────

describe('credential files', () => {
  async function credential(f: Fixture, contractorId: string): Promise<string> {
    const r = await query<{ id: string }>(
      `INSERT INTO contractor_credentials
         (contractor_id, kind, number, file_name, stored_filename, mime_type)
       VALUES ($1,'license','PLB-1234','license.pdf','stored.pdf','application/pdf')
       RETURNING id`, [contractorId])
    return r[0].id
  }

  it('is refused to a landlord that contractor has never bid for', async () => {
    const app = buildApp(); const f = await seed()
    const credId = await credential(f, f.contractor1Id)
    const r = await request(app).get(`/api/marketplace/credentials/${credId}/file`)
      .set('Authorization', `Bearer ${f.tokenB}`)
    expect(r.status).toBe(403)
  })

  it('is allowed to a landlord on whose job that contractor bid', async () => {
    const app = buildApp(); const f = await seed()
    const credId = await credential(f, f.contractor1Id)
    const job = (await postJob(app, f)).body.data
    await bid(app, f.token1, job.id, 1000)
    const r = await request(app).get(`/api/marketplace/credentials/${credId}/file`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    // Allowed past authorization; the bytes are not on disk in a test, which is
    // a 404 and specifically NOT the 403 above.
    expect(r.status).toBe(404)
  })

  it('is refused to another contractor', async () => {
    const app = buildApp(); const f = await seed()
    const credId = await credential(f, f.contractor1Id)
    const r = await request(app).get(`/api/marketplace/credentials/${credId}/file`)
      .set('Authorization', `Bearer ${f.token2}`)
    expect(r.status).toBe(403)
  })

  it('lists only the asking contractor\'s own credentials', async () => {
    const app = buildApp(); const f = await seed()
    await credential(f, f.contractor1Id)
    const r = await request(app).get('/api/marketplace/me/credentials')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(r.body.data).toEqual([])
  })
})

// ── the rate endpoint ─────────────────────────────────────────

describe('the rate', () => {
  it('states 3%', async () => {
    const app = buildApp(); const f = await seed()
    const r = await request(app).get('/api/marketplace/rate')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(r.status).toBe(200)
    expect(r.body.data.percent).toBe(3)
  })
})

// ── the insurance projection ──────────────────────────────────

describe('a contractor\'s insurance comes from the one insurance home', () => {
  async function policy(contractorId: string, opts: {
    kind?: 'general_liability' | 'surety_bond'
    verified?: boolean; expiry?: string; voided?: boolean
  } = {}) {
    const r = await query<{ id: string }>(
      `INSERT INTO insurance_policies
         (contractor_id, coverage_type, carrier_name, policy_number,
          effective_date, expiry_date, verified_at, verified_by_user_id,
          voided_at, voided_by_user_id, void_reason)
       VALUES ($1, $2, 'Test Mutual', 'POL-1',
               -- effective BEFORE expiry, whatever the expiry is: an expired
               -- certificate is a real case the gate has to handle.
               ($3::date - 365), $3::date,
               CASE WHEN $4 THEN NOW() ELSE NULL END,
               CASE WHEN $4 THEN (SELECT id FROM users WHERE role='admin' LIMIT 1) ELSE NULL END,
               CASE WHEN $5 THEN NOW() ELSE NULL END,
               CASE WHEN $5 THEN (SELECT id FROM users WHERE role='admin' LIMIT 1) ELSE NULL END,
               CASE WHEN $5 THEN 'test void' ELSE NULL END)
       RETURNING id`,
      [contractorId, opts.kind ?? 'general_liability',
       opts.expiry ?? new Date(Date.now() + 86400_000 * 90).toISOString().slice(0, 10),
       opts.verified ?? true, opts.voided ?? false])
    return r[0].id
  }

  async function standing(contractorId: string) {
    const r = await query<{
      insurance_verified: boolean; insurance_expiry: string | null
      bond_verified: boolean; bond_expiry: string | null
    }>(`SELECT insurance_verified, insurance_expiry, bond_verified, bond_expiry
          FROM contractors WHERE id = $1`, [contractorId])
    return r[0]
  }

  it('a verified general-liability policy turns the insured flag on', async () => {
    const f = await seed()
    await query(`UPDATE contractors SET insurance_verified = false, insurance_expiry = NULL
                  WHERE id = $1`, [f.contractor2Id])
    await policy(f.contractor2Id)
    const s = await standing(f.contractor2Id)
    expect(s.insurance_verified).toBe(true)
    expect(s.insurance_expiry).not.toBeNull()
    // A liability policy is not a bond.
    expect(s.bond_verified).toBe(false)
  })

  it('an UNVERIFIED upload does not turn it on — GAM confirming the paper is the point', async () => {
    const f = await seed()
    await policy(f.contractor2Id, { verified: false })
    expect((await standing(f.contractor2Id)).insurance_verified).toBe(false)
  })

  it('voiding the policy turns it back off', async () => {
    const f = await seed()
    const id = await policy(f.contractor2Id)
    expect((await standing(f.contractor2Id)).insurance_verified).toBe(true)
    await query(`UPDATE insurance_policies
                    SET voided_at = NOW(),
                        voided_by_user_id = (SELECT id FROM users WHERE role='admin' LIMIT 1),
                        void_reason = 'cancelled by carrier'
                  WHERE id = $1`, [id])
    const s = await standing(f.contractor2Id)
    expect(s.insurance_verified).toBe(false)
    expect(s.insurance_expiry).toBeNull()
  })

  it('renewing extends the cover; the old expired certificate cannot drag it back', async () => {
    const f = await seed()
    await policy(f.contractor2Id, { expiry: '2020-01-01' })
    await policy(f.contractor2Id, { expiry: '2030-01-01' })
    const s = await standing(f.contractor2Id)
    expect(s.insurance_verified).toBe(true)
    // pg hands a `date` column back as a Date, so String(...).slice(0,4) is
    // "Tue " — the same trap credentialsInForce had to be fixed for.
    expect(new Date(s.insurance_expiry!).getFullYear()).toBe(2030)
  })

  it('a surety bond drives the bond flag, separately', async () => {
    const f = await seed()
    await query(`UPDATE contractors SET bond_verified = false, bond_expiry = NULL WHERE id = $1`,
      [f.contractor2Id])
    await policy(f.contractor2Id, { kind: 'surety_bond' })
    const s = await standing(f.contractor2Id)
    expect(s.bond_verified).toBe(true)
    expect(s.insurance_verified).toBe(false)
  })

  it('the board\'s insured answer follows the policy, end to end', async () => {
    const app = buildApp(); const f = await seed()
    await query(`UPDATE contractors SET insurance_verified = false, insurance_expiry = NULL,
                        bond_verified = false, bond_expiry = NULL WHERE id = $1`, [f.contractor2Id])
    await postJob(app, f, { requiresInsured: true })

    const before = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(before.body.data.me.insured).toBe(false)

    await policy(f.contractor2Id)

    const after = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(after.body.data.me.insured).toBe(true)
  })

  it('an expired-but-live policy reads as not in force on the board', async () => {
    const app = buildApp(); const f = await seed()
    await query(`UPDATE contractors SET insurance_verified = false, insurance_expiry = NULL
                  WHERE id = $1`, [f.contractor2Id])
    await policy(f.contractor2Id, { expiry: '2020-06-01' })
    // The flag is on (there IS a confirmed policy) but the date has passed, and
    // the gate is about cover in force today, not paperwork on file ever.
    expect((await standing(f.contractor2Id)).insurance_verified).toBe(true)
    await postJob(app, f, { requiresInsured: true })
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(r.body.data.me.insured).toBe(false)
  })
})

// ── anonymity on the open board ───────────────────────────────

describe('the open board names the city and nothing else', () => {
  /**
   * 10/31 (Nic): "I think we should reveal location, like city location of the
   * job... But I don't think it should show the exact property address or say
   * exactly who the landlord is."
   *
   * These tests try to FIND the identity in the payload rather than checking a
   * field is absent, because the leak last time was `property_name` — a field
   * nobody thought of as an address, and which names the park exactly.
   */
  async function seedNamedProperty(f: Fixture) {
    await query(
      `UPDATE properties
          SET name = 'Oak Park Estates', street1 = '1842 Gravel Pit Road',
              city = 'Mesa', state = 'AZ', zip = '85201'
        WHERE id = $1`, [f.propertyAId])
  }

  it('gives the contractor the city and state, so they can price the drive', async () => {
    const app = buildApp(); const f = await seed()
    await seedNamedProperty(f)
    await postJob(app, f)
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(200)
    expect(r.body.data.jobs[0].propertyCity).toBe('Mesa')
    expect(r.body.data.jobs[0].propertyState).toBe('AZ')
  })

  it('does NOT give out the park name, the street, the landlord or the unit', async () => {
    const app = buildApp(); const f = await seed()
    await seedNamedProperty(f)
    await postJob(app, f, { unitId: f.unitAId })
    const r = await request(app).get('/api/marketplace/board')
      .set('Authorization', `Bearer ${f.token1}`)
    const job = r.body.data.jobs[0]
    // The FIELDS, not a substring of the payload: a zip is all digits and a
    // uuid is hex, so searching the blob for '85201' would pass or fail by
    // luck (testsAreDeterministic). Asking whether the field is there is both
    // deterministic and the stronger question.
    for (const leaked of ['propertyName', 'propertyStreet1', 'propertyStreet2',
                          'propertyZip', 'landlordId', 'propertyId', 'unitId',
                          'maintenanceRequestId']) {
      expect(job).not.toHaveProperty(leaked)
    }
    // The names carry letters no uuid can spell, so these stay a text search —
    // it is the check that would catch the park being named in prose.
    const body = JSON.stringify(r.body)
    expect(body).not.toContain('Oak Park Estates')
    expect(body).not.toContain('Gravel Pit')
  })

  it('withholds the same things when one job is opened on its own', async () => {
    const app = buildApp(); const f = await seed()
    await seedNamedProperty(f)
    const job = (await postJob(app, f, { unitId: f.unitAId })).body.data
    const r = await request(app).get(`/api/marketplace/board/${job.id}`)
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(200)
    const body = JSON.stringify(r.body)
    expect(r.body.data.job.propertyCity).toBe('Mesa')
    expect(body).not.toContain('Oak Park Estates')
    expect(body).not.toContain('Gravel Pit')
    expect(body).not.toContain(f.landlordAId)
  })

  it('hands over the full address the moment they WIN it — they have to turn up', async () => {
    const app = buildApp(); const f = await seed()
    await seedNamedProperty(f)
    const job = (await postJob(app, f, { unitId: f.unitAId })).body.data
    const b = await bid(app, f.token1, job.id, 1000)

    // Before the award: still anonymous.
    const before = await request(app).get('/api/marketplace/my-bids')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(JSON.stringify(before.body)).not.toContain('Gravel Pit')

    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b.body.data.id })

    const mine = await request(app).get('/api/marketplace/my-jobs')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data[0].propertyStreet1).toBe('1842 Gravel Pit Road')
    expect(mine.body.data[0].propertyName).toBe('Oak Park Estates')
    expect(mine.body.data[0].propertyZip).toBe('85201')
  })

  it('the contractor who did NOT win gets no address', async () => {
    const app = buildApp(); const f = await seed()
    await seedNamedProperty(f)
    const job = (await postJob(app, f)).body.data
    const b1 = await bid(app, f.token1, job.id, 1000)
    await bid(app, f.token2, job.id, 1200)
    await request(app).post(`/api/marketplace/jobs/${job.id}/award`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ bidId: b1.body.data.id })

    const loser = await request(app).get('/api/marketplace/my-jobs')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(loser.body.data).toEqual([])
    const theirBids = await request(app).get('/api/marketplace/my-bids')
      .set('Authorization', `Bearer ${f.token2}`)
    expect(JSON.stringify(theirBids.body)).not.toContain('Gravel Pit')
    expect(JSON.stringify(theirBids.body)).not.toContain('Oak Park Estates')
  })
})

/**
 * THE PAID TOP SPOT — the read side.
 *
 * 10/31 (Nic): "Paid spot per trade per area code should be based on cost of
 * living in the area. LA/NY prices don't touch Wyoming or Oklahoma."
 *
 * Joining stays free; what is sold is position. Buying one is not built yet, so
 * what these cover is who may see what: a contractor sees THEIR price, and only
 * GAM sees the grid it came from.
 */
describe('the paid top spot', () => {
  /** The published areas live in a migration; gam_test carries schema only. */
  async function areasOnFile() {
    const fs = await import('fs')
    const path = await import('path')
    const dir = path.join(__dirname, '..', 'db', 'migrations')
    for (const f of ['20261101030000_marketplace_areas.sql',
                     '20261101031000_marketplace_placement_rates.sql']) {
      await db.query(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
  }

  it('a contractor in Mesa is quoted the Phoenix price, with the figure it came from', async () => {
    await areasOnFile()
    const f = await seed()
    await query(`UPDATE contractors SET city = 'Mesa', state = 'AZ' WHERE id = $1`, [f.contractor1Id])
    const r = await request(buildApp()).get('/api/marketplace/placement/mine')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(200)
    expect(r.body.data.area.name).toMatch(/Phoenix/)
    expect(r.body.data.monthlyPrice).toBeGreaterThan(0)
    expect(r.body.data.indexSource).toMatch(/Regional Price Parities/)
  })

  it('a contractor who has not said where they are gets no guess', async () => {
    await areasOnFile()
    const f = await seed()
    const r = await request(buildApp()).get('/api/marketplace/placement/mine')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toBeNull()
  })

  it('somebody with no contractor profile is told to make one, not shown a price', async () => {
    await areasOnFile()
    const f = await seed()
    const r = await request(buildApp()).get('/api/marketplace/placement/mine')
      .set('Authorization', `Bearer ${f.tokenNoProfile}`)
    expect(r.status).toBe(403)
    expect(r.body.error ?? r.body.message).toMatch(/contractor profile/i)
  })

  it('the grid is GAM staff only — a contractor sees their price, never the tiers', async () => {
    await areasOnFile()
    const f = await seed()
    const asContractor = await request(buildApp()).get('/api/marketplace/placement/schedule')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(asContractor.status).toBe(403)
    const asLandlord = await request(buildApp()).get('/api/marketplace/placement/schedule')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(asLandlord.status).toBe(403)
    const asAdmin = await request(buildApp()).get('/api/marketplace/placement/schedule')
      .set('Authorization', `Bearer ${f.adminToken}`)
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.body.data.length).toBeGreaterThanOrEqual(5)
  })

  it('LA costs more than double Tulsa, through the route a screen actually calls', async () => {
    await areasOnFile()
    const f = await seed()
    const app = buildApp()
    const priceOf = async (nameLike: string) => {
      const rows = await query<{ id: string }>(
        `SELECT id FROM marketplace_areas WHERE name LIKE '%' || $1 || '%'
          ORDER BY length(name) LIMIT 1`, [nameLike])
      const r = await request(app).get(`/api/marketplace/placement/${rows[0].id}`)
        .set('Authorization', `Bearer ${f.token1}`)
      expect(r.status).toBe(200)
      return r.body.data.monthlyPrice as number
    }
    expect(await priceOf('Los Angeles-Long Beach')).toBeGreaterThan((await priceOf('Tulsa')) * 2)
  })

  it('the picker finds an area by name and never leaks a price with it', async () => {
    await areasOnFile()
    const f = await seed()
    const r = await request(buildApp()).get('/api/marketplace/areas?q=Casper')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(200)
    expect(r.body.data.map((a: any) => a.name).join('|')).toMatch(/Casper/)
    // The picker is a list of places. The price comes from asking about one.
    for (const a of r.body.data) expect(a.monthlyPrice).toBeUndefined()
  })

  it('an area nobody has a cost of living for is a 404, not a default price', async () => {
    await areasOnFile()
    const f = await seed()
    const r = await request(buildApp())
      .get('/api/marketplace/placement/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${f.token1}`)
    expect(r.status).toBe(404)
  })
})
