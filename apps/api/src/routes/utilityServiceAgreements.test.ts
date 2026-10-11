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

async function seed(lateFee: { initial?: number; grace?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    await c.query(
      `UPDATE properties SET late_fee_enabled = true,
                             late_fee_grace_days = $2,
                             late_fee_initial_amount = $3,
                             late_fee_initial_type = 'flat'
        WHERE id = $1`,
      [propertyId, lateFee.grace ?? 5, lateFee.initial ?? 25])
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
  it('stamps the property late-fee policy onto the agreement', async () => {
    const f = await seed({ initial: 40, grace: 3 })
    const res = await request(buildApp())
      .post('/api/utility/service-agreements')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, label: 'Next door B', payer })
    expect(res.status).toBe(201)

    const { rows: [sa] } = await db.query<any>(
      `SELECT late_fee_enabled, late_fee_grace_days,
              late_fee_initial_amount::text AS amt, late_fee_initial_type
         FROM utility_service_agreements WHERE id = $1`, [res.body.data.id])
    expect(sa.late_fee_enabled).toBe(true)
    expect(sa.late_fee_grace_days).toBe(3)
    expect(Number(sa.amt)).toBe(40)

    // Changing property policy afterwards leaves the stamp alone.
    await db.query(
      `UPDATE properties SET late_fee_initial_amount = 99 WHERE id = $1`, [f.propertyId])
    const { rows: [after] } = await db.query<any>(
      `SELECT late_fee_initial_amount::text AS amt FROM utility_service_agreements
        WHERE id = $1`, [res.body.data.id])
    expect(Number(after.amt)).toBe(40)
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
