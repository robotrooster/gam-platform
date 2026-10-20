/**
 * S615 — creating a utility service agreement.
 *
 * S614 built the table and could not create a row in it; S615 built the invoice
 * and still could not. This is the door. One call mints the space, the payer's
 * portal account and the agreement, because a landlord adding the apartment
 * next door is doing one thing — and the middle step does not otherwise exist
 * (tenant onboarding demands a lease start and a monthly rent, neither of which
 * is true here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { utilityServiceAgreementsRouter } from './utilityServiceAgreements'
import { generateLateFeesForTimezone } from '../jobs/lateFees'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

const { emailUtilityServiceInviteMock } = vi.hoisted(() => ({
  emailUtilityServiceInviteMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailUtilityServiceInvite: emailUtilityServiceInviteMock,
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  // The real app camelizes every response on the way out (index.ts), so a test
  // app without it asserts a contract production does not serve — snake_case
  // keys that the frontend would read as undefined. Mounted here so these
  // expectations are the ones the landlord page actually receives.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/utility/service-agreements', utilityServiceAgreementsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailUtilityServiceInviteMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_svcagr'
})

const TZ = 'America/Phoenix'

/**
 * A park with a REAL late-fee policy: per (property, unit type), the row a
 * lease is drafted from. 10/20 (Nic): that is the only place a late fee lives.
 * The property's own late_fee_* figure columns are set to junk on purpose —
 * nothing may read them, and $99 showing up on an agreement is the regression.
 *
 * `policy: null` records no policy for the class at all, which is the state
 * every one of Nic's parks is in for a class nobody has been asked about.
 */
type Policy = {
  unitType?: string
  graceDays?: number
  initialAmount?: number
  initialType?: 'flat' | 'percent_of_rent'
  accrualAmount?: number | null
  accrualType?: 'flat' | 'percent_of_rent'
  accrualPeriod?: 'daily' | 'weekly' | 'monthly'
  accrualFrom?: 'grace_end' | 'due_date' | 'due_date_inclusive'
  capAmount?: number | null
  capType?: 'flat' | 'percent_of_rent'
}

async function seed(opts: { policy?: Policy | null; policies?: Policy[] } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    // The master switch (the one property-level late-fee column the resolver
    // still reads) plus the park's clock, which the nightly engine fires on.
    // The figures are deliberate junk: a dead column nothing may read.
    await c.query(
      `UPDATE properties SET late_fee_enabled = true, timezone = $2,
                             late_fee_grace_days = 11,
                             late_fee_initial_amount = 99,
                             late_fee_initial_type = 'flat'
        WHERE id = $1`, [propertyId, TZ])
    const list = opts.policies
      ?? (opts.policy === null ? [] : [opts.policy ?? {}])
    for (const p of list) {
      await c.query(
        `INSERT INTO property_unit_type_late_fees
           (property_id, unit_type, late_fee_grace_days,
            late_fee_initial_amount, late_fee_initial_type,
            late_fee_accrual_amount, late_fee_accrual_type,
            late_fee_accrual_period, late_fee_accrual_from,
            late_fee_cap_amount, late_fee_cap_type)
         VALUES ($1,$2,$3,$4,$5,$6,
                 CASE WHEN $6::numeric IS NULL THEN NULL ELSE $10::text END,
                 CASE WHEN $6::numeric IS NULL THEN NULL ELSE $7::text END,
                 $8,$9,
                 CASE WHEN $9::numeric IS NULL THEN NULL ELSE $11::text END)`,
        [propertyId, p.unitType ?? 'apartment', p.graceDays ?? 5,
         p.initialAmount ?? 25, p.initialType ?? 'flat',
         p.accrualAmount ?? null, p.accrualPeriod ?? 'daily',
         p.accrualFrom ?? 'due_date_inclusive', p.capAmount ?? null,
         p.accrualType ?? 'flat', p.capType ?? 'flat'])
    }
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const payer = {
  firstName: 'Dale', lastName: 'Ruiz',
  email: 'dale@nextdoor.example', phone: '+16025550143',
}

describe('POST /api/utility/service-agreements (S615)', () => {
  it('creates the space, the payer account and the agreement in one call', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        propertyId: f.propertyId,
        label: 'Next door A',
        serviceAddress: '2 Next Door Ln',
        billingDueDay: 1,
        householdSize: 3,
        payer,
      })
    expect(res.status).toBe(201)
    const { id, unitId, tenantId } = res.body.data

    // The space is a REAL unit, marked so nothing treats it as rentable.
    const { rows: [unit] } = await db.query<any>(
      `SELECT status, rent_amount::text, is_bookable, owner_household_size, unit_number
         FROM units WHERE id = $1`, [unitId])
    expect(unit.status).toBe('utility_service')
    expect(Number(unit.rent_amount)).toBe(0)
    expect(unit.is_bookable).toBe(false)
    expect(unit.owner_household_size).toBe(3)
    expect(unit.unit_number).toBe('Next door A')

    // The payer gets a real portal account with a live invite.
    const { rows: [u] } = await db.query<any>(
      `SELECT usr.email, usr.role, usr.tenant_invite_token IS NOT NULL AS invited
         FROM tenants t JOIN users usr ON usr.id = t.user_id WHERE t.id = $1`,
      [tenantId])
    expect(u.email).toBe(payer.email)
    expect(u.role).toBe('tenant')
    expect(u.invited).toBe(true)

    const { rows: [sa] } = await db.query<any>(
      `SELECT status, billing_due_day, service_address FROM utility_service_agreements
        WHERE id = $1`, [id])
    expect(sa.status).toBe('active')
    expect(sa.billing_due_day).toBe(1)
    expect(sa.service_address).toBe('2 Next Door Ln')
  })

  // S558's rule: the instrument is the charge. A policy change next March must
  // not silently reprice a bill this person already agreed to.
  it("inherits exactly the property's policy for that class of space", async () => {
    // Nic's parks, verified in production on 10/20: $0 to start, $5 a day from
    // the due date itself, no cap. The property's own columns say $99 / 11
    // days; if either shows up on the agreement, it read the dead columns.
    const f = await seed({ policy: {
      graceDays: 5, initialAmount: 0, accrualAmount: 5,
      accrualPeriod: 'daily', accrualFrom: 'due_date_inclusive',
    } })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door B', payer })
    expect(res.status).toBe(201)

    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_enabled, late_fee_grace_days,
              late_fee_initial_amount::text AS initial, late_fee_initial_type,
              late_fee_accrual_amount::text AS accrual, late_fee_accrual_type,
              late_fee_accrual_period, late_fee_accrual_from,
              late_fee_cap_amount, late_fee_cap_type
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa).toMatchObject({
      late_fee_enabled: true,
      late_fee_grace_days: 5,
      late_fee_initial_type: 'flat',
      late_fee_accrual_type: 'flat',
      late_fee_accrual_period: 'daily',
      // The agreement column defaults to 'grace_end'. Taking that default
      // would start Nic's $5/day five days late, so the policy's own answer is
      // stamped explicitly.
      late_fee_accrual_from: 'due_date_inclusive',
      late_fee_cap_amount: null,
      late_fee_cap_type: null,
    })
    expect(Number(sa.initial)).toBe(0)
    expect(Number(sa.accrual)).toBe(5)

    // And the answer tells the landlord what this space's overdue bill costs.
    expect(res.body.data.lateFee).toMatchObject({
      source: 'unit_type_policy', unitType: 'apartment', enabled: true,
      graceDays: 5, accrualPeriod: 'daily', accrualFrom: 'due_date_inclusive',
    })
  })

  // Nic, on the two live agreements made on 10/6 (RV 10 and RV 11 at Mountain
  // View, both holding the invented $15 flat with a 5-day grace): their stored
  // values ARE the agreement. S558's rule — the instrument is the charge.
  it('a policy changed afterwards does not reprice an agreement already made', async () => {
    const f = await seed({ policy: { graceDays: 3, initialAmount: 40 } })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door B', payer })
    expect(res.status).toBe(201)

    await db.query(
      `UPDATE property_unit_type_late_fees
          SET late_fee_initial_amount = 250, late_fee_grace_days = 0
        WHERE property_id = $1`, [f.propertyId])

    const { rows: [after] } = await db.query<any>(
      `SELECT late_fee_grace_days, late_fee_initial_amount::text AS initial
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(after.late_fee_grace_days).toBe(3)
    expect(Number(after.initial)).toBe(40)
  })

  // The decision, named: with no policy recorded for the class, the agreement
  // is CREATED WITH NO LATE FEE and says so. It does not refuse (a lease is
  // drafted in this state too — S577 retired the forced-decision gate) and it
  // does not invent a figure, which is the whole point of the 10/19 removal.
  it('creates it with no late fee when the class has no policy, and says so', async () => {
    const f = await seed({ policy: null })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door C', payer })
    expect(res.status).toBe(201)
    expect(res.body.data.lateFee).toMatchObject({
      source: 'none', enabled: false,
      graceDays: null, initialAmount: null, accrualAmount: null, capAmount: null,
    })

    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_enabled, late_fee_grace_days, late_fee_initial_amount,
              late_fee_accrual_amount, late_fee_cap_amount
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa).toEqual({
      late_fee_enabled: false,
      late_fee_grace_days: null,
      late_fee_initial_amount: null,
      late_fee_accrual_amount: null,
      late_fee_cap_amount: null,
    })
  })

  // 10/20: EVERY AMOUNT SHIPS WITH THE TYPE THAT GIVES IT MEANING. The answer
  // used to carry accrualAmount and capAmount with no accrualType or capType,
  // so $5 a day and 5% of rent a day were the same number on the wire and the
  // screen this is for would have printed "$5 a day" for a percentage. Every
  // policy recorded in production today is flat, so nothing was wrong on
  // screen yet — the contract was.
  it('the answer names the TYPE of every figure, so a percent is not read as dollars', async () => {
    const f = await seed({ policy: {
      graceDays: 5, initialAmount: 0,
      accrualAmount: 5, accrualType: 'percent_of_rent', accrualPeriod: 'daily',
      capAmount: 20, capType: 'percent_of_rent',
    } })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door E', payer })
    expect(res.status).toBe(201)
    expect(res.body.data.lateFee).toMatchObject({
      source: 'unit_type_policy', enabled: true,
      initialType: 'flat',
      accrualAmount: '5.00', accrualType: 'percent_of_rent', accrualPeriod: 'daily',
      capAmount: '20.00', capType: 'percent_of_rent',
    })
    // And the agreement itself holds the same two types, which is what the
    // engine reads when the bill goes unpaid.
    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_accrual_type, late_fee_cap_type
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa).toEqual({ late_fee_accrual_type: 'percent_of_rent', late_fee_cap_type: 'percent_of_rent' })
  })

  // A space next door is not always an apartment. The type classifies; the
  // figures still come from that class's policy row.
  it("takes the stated space type's policy, not another class's", async () => {
    const f = await seed({ policies: [
      { unitType: 'apartment', initialAmount: 25, graceDays: 5 },
      { unitType: 'rv_spot', initialAmount: 0, accrualAmount: 5, graceDays: 2 },
    ] })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door D', unitType: 'rv_spot', payer })
    expect(res.status).toBe(201)

    const { rows: [u] } = await db.query<any>(
      `SELECT unit_type FROM units WHERE id = $1`, [res.body.data.unitId])
    expect(u.unit_type).toBe('rv_spot')
    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_grace_days, late_fee_initial_amount::text AS initial,
              late_fee_accrual_amount::text AS accrual
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa.late_fee_grace_days).toBe(2)
    expect(Number(sa.initial)).toBe(0)
    expect(Number(sa.accrual)).toBe(5)
  })

  // S614: same person, same login, no duplicate account.
  it('reuses an existing account rather than colliding on the email', async () => {
    const f = await seed()
    const app = buildApp()
    const first = await request(app)
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Space one', payer })
    expect(first.status).toBe(201)

    const second = await request(app)
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Space two', payer })
    expect(second.status).toBe(201)

    expect(second.body.data.tenantId).toBe(first.body.data.tenantId)
    const { rows } = await db.query(
      `SELECT id FROM users WHERE email = $1`, [payer.email])
    expect(rows).toHaveLength(1)
  })

  it('refuses a property belonging to another landlord', async () => {
    const mine = await seed()
    const theirs = await seed()
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ propertyId: theirs.propertyId, label: 'Not mine', payer })
    expect(res.status).toBe(403)
  })
})

describe('GET + PATCH /api/utility/service-agreements (S615)', () => {
  async function create(f: any, label: string) {
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label, payer })
    return res.body.data
  }

  it('lists the landlord’s agreements with the payer and what they owe', async () => {
    const f = await seed()
    const made = await create(f, 'Next door A')
    // An unpaid utility charge on an invoice for this agreement.
    const { rows: [inv] } = await db.query<any>(
      `INSERT INTO invoices (landlord_id, tenant_id, unit_id, service_agreement_id,
                             invoice_number, due_date, subtotal_utilities, total_amount)
       VALUES ($1,$2,$3,$4,'INV-1','2026-03-01',75,75) RETURNING id`,
      [f.landlordId, made.tenantId, made.unitId, made.id])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount,
                             status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',75,'pending','2026-03-01','UTILITY')`,
      [inv.id, made.unitId, made.tenantId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    const row = res.body.data[0]
    expect(row.email).toBe(payer.email)
    expect(Number(row.balanceDue)).toBe(75)
    expect(row.invitePending).toBe(true)
  })

  it('ending an agreement dates it, and leaves what is already owed alone', async () => {
    const f = await seed()
    const made = await create(f, 'Next door A')
    const res = await request(buildApp())
      .patch(`/api/utility/service-agreements/${made.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ status: 'ended' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ended')
    expect(res.body.data.endDate).not.toBeNull()
  })

  it('another landlord cannot edit it', async () => {
    const mine = await seed()
    const theirs = await seed()
    const made = await create(mine, 'Next door A')
    const res = await request(buildApp())
      .patch(`/api/utility/service-agreements/${made.id}`)
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ billingDueDay: 15 })
    expect(res.status).toBe(403)
  })
})

// S616 (Nic): "maybe that tenant portal profile that only has the utilities
// gets a big button that says 'hey, I need my final bill because I'm moving
// out'." Nobody is watching the neighbor's front door — the one person who
// reliably knows is the person leaving.
describe('the payer gives notice (S616)', () => {
  async function payerToken(f: any, tenantId: string) {
    const { rows: [t] } = await db.query<any>(
      `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    return jwt.sign({ userId: t.user_id, role: 'tenant', profileId: tenantId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }

  it('records the notice and the date they expect to be gone', async () => {
    const f = await seed()
    const made = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Neighbor A', payer })
    const token = await payerToken(f, made.body.data.tenantId)

    const res = await request(buildApp())
      .post('/api/utility/service-agreements/mine/moveout-notice')
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedOn: '2026-09-30', note: 'My brother is taking over' })
    expect(res.status).toBe(200)
    expect(res.body.data.moveoutExpectedOn).toBe('2026-09-30')

    const { rows } = await db.query<any>(
      `SELECT moveout_notice_at, moveout_note, status
         FROM utility_service_agreements WHERE id = $1`, [made.body.data.id])
    expect(rows[0].moveout_notice_at).not.toBeNull()
    expect(rows[0].moveout_note).toBe('My brother is taking over')
    // A NOTICE, not a termination — letting a payer close their own account
    // would let somebody walk away from a balance by pressing a button.
    expect(rows[0].status).toBe('active')
  })

  it('a landlord cannot give notice on the payer’s behalf', async () => {
    const f = await seed()
    await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Neighbor A', payer })

    const res = await request(buildApp())
      .post('/api/utility/service-agreements/mine/moveout-notice')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ expectedOn: '2026-09-30' })
    expect(res.status).toBe(403)
  })

  it('refuses when the payer has no live service', async () => {
    const f = await seed()
    const made = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Neighbor A', payer })
    await db.query(
      `UPDATE utility_service_agreements SET status='ended' WHERE id=$1`,
      [made.body.data.id])
    const token = await payerToken(f, made.body.data.tenantId)

    const res = await request(buildApp())
      .post('/api/utility/service-agreements/mine/moveout-notice')
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedOn: '2026-09-30' })
    expect(res.status).toBe(404)
  })
})

// ── S654: the one rule for every door that can hand out a password link ──
//
// Round 7, reproduced: this route reused any resident account found by the
// payer's email and ALWAYS minted a fresh setup token and mailed "activate your
// account". Landlord B adding a utility payer killed the live link landlord A
// had emailed their own invitee, and mailed a set-a-password link to residents
// who already have a password (accept-invite would let it replace theirs). The
// lookup was exact-case, so an address stored in mixed case hit the unique
// index and came back as a raw 500.
//
// Round 8, reproduced: any landlord could attach any GAM resident by typing
// their email (201, alreadyOnPlatform), then read that person's real name and
// phone off the list and start billing them with payerAlreadyAgreed.
//
// THE RULE: a setup link only for an account this call created, or one that
// still needs setup (placeholder password, invite never accepted) and is tied
// to no other company; only to the address on the account. Nobody else is
// attached from here: an account with its own password, or tied to another
// company, gets one fixed 409 that names nobody. A landlord or staff login is
// never a payer.
describe('S654: POST /api/utility/service-agreements and password links', () => {
  const PLACEHOLDER = '$2b$10$placeholder_invite_pending'
  const create = (f: any, email: string, label = 'Next door') =>
    request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label, payer: { ...payer, email } })

  /** A resident login with its tenants row. */
  async function resident(email: string, o: { password?: string; token?: string | null } = {}) {
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, $2, 'tenant', 'Ex', 'Ample', $3::text,
               CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() + INTERVAL '7 days' END)
       RETURNING id`, [email, o.password ?? PLACEHOLDER, o.token ?? null])).rows[0]
    const t = (await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    return { userId: u.id, tenantId: t.id }
  }
  const userRow = async (id: string) => (await db.query(
    `SELECT email, password_hash, tenant_invite_token, tenant_invite_expires_at FROM users WHERE id=$1`,
    [id])).rows[0]
  const notesFor = async (userId: string) => (await db.query(
    `SELECT landlord_id, type, action_url FROM notifications WHERE user_id=$1`, [userId])).rows

  // S654 round 8: attaching an account that already exists is refused unless it
  // still needs setup and belongs to no other company. The 409 names nobody.
  const ALREADY_ON_GAM = /This person already has a GAM account\. Ask them to add the service from their own portal\./
  const counts = async () => ({
    units: Number((await db.query(`SELECT COUNT(*) FROM units`)).rows[0].count),
    agreements: Number((await db.query(`SELECT COUNT(*) FROM utility_service_agreements`)).rows[0].count),
  })

  it("another company's invitee: refused, nothing created, their live link and their onboarding untouched", async () => {
    const a = await seed()
    const b = await seed()
    const x = await resident('x.invitee@test.dev', { token: 'a-live-link' })
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [a.landlordId, x.tenantId, a.propertyId])
    const before = await userRow(x.userId)
    const was = await counts()

    const res = await create(b, 'X.INVITEE@TEST.DEV')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(ALREADY_ON_GAM)
    expect(JSON.stringify(res.body)).not.toMatch(/Ex|Ample|accept-invite|a-live-link|tenantId/)
    expect(await counts()).toEqual(was)
    expect(await userRow(x.userId)).toEqual(before)
    expect(emailUtilityServiceInviteMock).not.toHaveBeenCalled()
    expect(await notesFor(x.userId)).toEqual([])
    // B's attempt leaves no tie on X, so A can still correct and re-send its
    // own invite (round 8: B's agreement made A's PATCH /contact a 409).
    const { accountTiedElsewhere } = await import('../jobs/leaseParser/resolveIntent')
    expect(await accountTiedElsewhere(x.userId, [a.landlordId])).toBe(false)
  })

  it("another company's activated resident: refused, and their name and phone never come back", async () => {
    const a = await seed()
    const b = await seed()
    const z = await resident('z.elsewhere@test.dev', { password: '$2b$10$their.own.real.password.hash' })
    await db.query(`UPDATE users SET first_name='Zelda', last_name='Secretname', phone='+16025559999',
                            tenant_invite_accepted_at=NOW() WHERE id=$1`, [z.userId])
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [a.landlordId, z.tenantId, a.propertyId])
    const was = await counts()

    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ propertyId: b.propertyId, label: 'Next door', payerAlreadyAgreed: true,
              payer: { firstName: 'Made', lastName: 'Up', email: 'z.elsewhere@test.dev', phone: '+10000000000' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(ALREADY_ON_GAM)
    expect(JSON.stringify(res.body)).not.toMatch(/Zelda|Secretname|6025559999|alreadyOnPlatform/)
    expect(await counts()).toEqual(was)
    expect(await notesFor(z.userId)).toEqual([])

    const list = await request(buildApp())
      .get('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${b.token}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toEqual([])
    expect(JSON.stringify(list.body)).not.toMatch(/Zelda|Secretname|6025559999/)
  })

  it('a resident with their own password, even one tied to no company: refused, nothing created', async () => {
    const f = await seed()
    const z = await resident('z.active@test.dev', { password: '$2b$10$their.own.real.password.hash' })
    const before = await userRow(z.userId)
    const was = await counts()

    const res = await create(f, 'z.active@test.dev')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(ALREADY_ON_GAM)
    expect(await userRow(z.userId)).toEqual(before)
    expect((await userRow(z.userId)).tenant_invite_token).toBeNull()
    expect(await counts()).toEqual(was)
    expect(emailUtilityServiceInviteMock).not.toHaveBeenCalled()
    expect(await notesFor(z.userId)).toEqual([])
  })

  it("this company's own invitee holding a live link: attached, and the link they already have keeps working", async () => {
    const f = await seed()
    const w = await resident('w.own@test.dev', { token: 'lease-setup-link' })
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [f.landlordId, w.tenantId, f.propertyId])
    const before = await userRow(w.userId)

    const res = await create(f, 'W.Own@test.dev')
    expect(res.status).toBe(201)
    expect(res.body.data.tenantId).toBe(w.tenantId)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite|lease-setup-link/)
    const after = await userRow(w.userId)
    expect(after.tenant_invite_token).toBe('lease-setup-link')
    expect(after.tenant_invite_expires_at).toEqual(before.tenant_invite_expires_at)
    expect(emailUtilityServiceInviteMock).toHaveBeenCalledTimes(1)
    const [to, , , , url] = emailUtilityServiceInviteMock.mock.calls[0]!
    expect(to).toBe('w.own@test.dev')
    expect(url).toMatch(/\/accept-invite\?token=lease-setup-link$/)
  })

  it("an account still to be set up, tied to no other company, its old link run out: a fresh link, to the address on the account", async () => {
    const f = await seed()
    const y = await resident('Pending.Y@Test.dev', { token: 'stale-link' })
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [y.userId])

    const res = await create(f, 'pending.y@test.dev')
    expect(res.status).toBe(201)
    expect(res.body.data.tenantId).toBe(y.tenantId)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite/)
    const row = await userRow(y.userId)
    expect(row.tenant_invite_token).toMatch(/^[0-9a-f]{64}$/)
    expect(emailUtilityServiceInviteMock).toHaveBeenCalledTimes(1)
    const [to, , , , url] = emailUtilityServiceInviteMock.mock.calls[0]!
    expect(to).toBe('Pending.Y@Test.dev')
    expect(url).toMatch(new RegExp(`^https?://[^/]+/accept-invite\\?token=${row.tenant_invite_token}$`))
    expect(url).not.toMatch(/localhost/)
    // One login per address in any letter case: reused, never duplicated.
    expect((await db.query(`SELECT id FROM users WHERE lower(email)='pending.y@test.dev'`)).rows).toHaveLength(1)
  })

  it('a new payer: the account is created and the link goes to that address only', async () => {
    const f = await seed()
    const res = await create(f, 'New.Payer@Example.test')
    expect(res.status).toBe(201)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite/)
    const u = (await db.query(
      `SELECT u.email, u.tenant_invite_token FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id=$1`,
      [res.body.data.tenantId])).rows[0]
    expect(u.email).toBe('new.payer@example.test')
    expect(emailUtilityServiceInviteMock).toHaveBeenCalledTimes(1)
    expect(emailUtilityServiceInviteMock.mock.calls[0]![0]).toBe('new.payer@example.test')
    expect(emailUtilityServiceInviteMock.mock.calls[0]![4]).toContain(`/accept-invite?token=${u.tenant_invite_token}`)
  })

  it('a landlord login, stored in mixed case and typed in lowercase: refused, nothing created', async () => {
    const f = await seed()
    const other = await seed()
    await db.query(`UPDATE users SET email='LL.Other@Test.dev' WHERE id=$1`, [other.userId])
    const before = (await db.query(`SELECT * FROM users WHERE id=$1`, [other.userId])).rows[0]
    const units = Number((await db.query(`SELECT COUNT(*) FROM units`)).rows[0].count)

    const res = await create(f, 'll.other@test.dev')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/isn't a resident's/)
    expect((await db.query(`SELECT * FROM users WHERE id=$1`, [other.userId])).rows[0]).toEqual(before)
    expect(Number((await db.query(`SELECT COUNT(*) FROM units`)).rows[0].count)).toBe(units)
    expect((await db.query(`SELECT 1 FROM utility_service_agreements`)).rows).toHaveLength(0)
    expect(emailUtilityServiceInviteMock).not.toHaveBeenCalled()
  })

  it('the list says "invite not accepted" only for an account still to be set up', async () => {
    const f = await seed()
    const made = await create(f, 'set.up.later@example.test', 'Theirs')
    await create(f, 'brand.new@example.test', 'New')
    // The first payer then sets their own password from the emailed link.
    await db.query(
      `UPDATE users SET password_hash='$2b$10$their.own.real.password.hash', tenant_invite_accepted_at=NOW()
        WHERE id = (SELECT user_id FROM tenants WHERE id=$1)`, [made.body.data.tenantId])
    const res = await request(buildApp())
      .get('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const by = (email: string) => res.body.data.find((r: any) => r.email === email)
    expect(by('set.up.later@example.test').invitePending).toBe(false)
    expect(by('brand.new@example.test').invitePending).toBe(true)
  })

  // A landlord session names no company in profileId (S633); the list read it
  // and came back empty for every landlord in production.
  it("the list works for a real landlord session, and shows only the account's own companies", async () => {
    const f = await seed()
    const other = await seed()
    await create(f, 'mine@example.test', 'Mine')
    await create(other, 'theirs@example.test', 'Theirs')
    const session = jwt.sign({ userId: f.userId, role: 'landlord', profileId: null },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${session}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: any) => r.email)).toEqual(['mine@example.test'])
  })
})

/**
 * 10/20 — THE STAMPED TERMS ARE REAL MONEY.
 *
 * The point of taking the late fee from the per-unit-type policy is what the
 * utility customer is actually charged when their bill goes unpaid, so the
 * nightly engine runs here against an agreement this door created and the
 * fees are counted.
 *
 * Nic's parks: nothing to start, $5 a day counted from the due date itself, no
 * cap. Eight days' worth by the eighth day — the due date and the seven days
 * after it. On the old property-column stamp this bill charged nothing at all
 * (the figures are empty now), and had the agreement taken its accrual_from
 * from its own column default of 'grace_end' it would charge $10 instead of
 * $40: the five grace days and the due date would go uncharged.
 */
describe('the late-fee engine charges what the policy says (10/20)', () => {
  async function overdueBill(f: any, agreement: any, daysAgo: number) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { rows: [d] } = await c.query<{ due: string }>(
        `SELECT ((NOW() AT TIME ZONE $1)::date - $2::int)::text AS due`, [TZ, daysAgo])
      const { rows: [inv] } = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, unit_id, service_agreement_id,
                               invoice_number, due_date, subtotal_utilities, total_amount,
                               status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::date,60,60,'pending',
                 ($6::date - 3 + TIME '12:00') AT TIME ZONE $7)
         RETURNING id`,
        [f.landlordId, agreement.tenantId, agreement.unitId, agreement.id,
         `INV-${Math.random().toString(36).slice(2, 10)}`, d.due, TZ])
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, tenant_id, landlord_id, type, amount,
                               status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'utility',60,'pending',$5::date,'UTILITY')`,
        [inv.id, agreement.unitId, agreement.tenantId, f.landlordId, d.due])
      await c.query('COMMIT')
      return { invoiceId: inv.id, due: d.due }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  const fees = async (invoiceId: string) => (await db.query<{ amount: string; due_date: string }>(
    `SELECT amount::text AS amount, due_date::text AS due_date FROM payments
      WHERE invoice_id = $1 AND type = 'late_fee' ORDER BY due_date`, [invoiceId])).rows

  async function createAgreement(f: any, label: string, unitType?: string) {
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label, unitType, payer })
    expect(res.status).toBe(201)
    return res.body.data
  }

  it("charges the park's $5 a day from the due date — eight days, $40", async () => {
    const f = await seed({ policy: {
      graceDays: 5, initialAmount: 0, accrualAmount: 5,
      accrualPeriod: 'daily', accrualFrom: 'due_date_inclusive',
    } })
    const agreement = await createAgreement(f, 'Next door A')
    const bill = await overdueBill(f, agreement, 7)

    await generateLateFeesForTimezone(TZ)

    const rows = await fees(bill.invoiceId)
    expect(rows).toHaveLength(8)
    expect(rows[0].due_date).toBe(bill.due)
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(40)
  })

  it("charges Blu's $50 flat, capped at $50, once", async () => {
    const f = await seed({ policy: {
      graceDays: 5, initialAmount: 50, accrualAmount: null, capAmount: 50,
    } })
    const agreement = await createAgreement(f, 'Next door B')
    const bill = await overdueBill(f, agreement, 20)

    await generateLateFeesForTimezone(TZ)
    await generateLateFeesForTimezone(TZ)

    const rows = await fees(bill.invoiceId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(50)
  })

  // The item-2 decision, stated in money: no policy for the class means no
  // late fee — not a figure nobody chose, and not a refusal to bill the
  // neighbor's electric at all.
  it('charges nothing when the class has no policy recorded', async () => {
    const f = await seed({ policy: null })
    const agreement = await createAgreement(f, 'Next door C')
    expect(agreement.lateFee.source).toBe('none')
    const bill = await overdueBill(f, agreement, 30)

    await generateLateFeesForTimezone(TZ)

    expect(await fees(bill.invoiceId)).toEqual([])
  })
})
