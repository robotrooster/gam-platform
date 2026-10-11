/**
 * S628 — CHARACTERIZATION TESTS FOR THE TENANT INVITE.
 *
 * POST /api/tenants/invite is 120 lines that create a user account, mint a
 * seven-day activation token, and decide between two different downstream
 * shapes — and it had NO tests at all. The S627 handoff flagged it: do not
 * wrap it in an agent action blind. So this pins what it does first.
 *
 * Writing them found the reason it needed pinning. The landlord's screen says
 * "Invite Sent" and "they will receive an email to set up their account", and
 * the route sent NOTHING — it logged the accept URL and returned it for the
 * landlord to copy by hand. The sibling route that onboards a tenant onto a
 * lease (POST /landlords/me/onboard-new-lease-tenant) does send one, via
 * emailTenantOnboarded, so this was an omission rather than a decision. Every
 * tenant invited from that modal was waiting on an email nobody sent.
 *
 * The last test in this file is the one that would have caught it.
 *
 * S655 (Nic, 10/2): invites are EMAIL-ONLY — no setup link comes back in any
 * response. A UNIT invite goes through the one invite function every door
 * uses: the household's lease drafts at once and nobody is emailed until the
 * landlord signs. Only when the lease can't draft (no default lease here, as
 * in most fixtures below) does the old invite email still go out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

const sentInvites: any[] = []
vi.mock('../services/email', async (orig) => ({
  ...(await orig<any>()),
  emailTenantInvite: vi.fn(async (...args: any[]) => { sentInvites.push(args) }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/tenants', tenantsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  sentInvites.length = 0
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_invite'
  process.env.TENANT_APP_URL = 'https://tenants.example.test'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, { firstName: 'Dana', lastName: 'Okafor' })
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 900 })
    await c.query('COMMIT')
    return {
      userId, landlordId, propertyId, unitId,
      token: jwt.sign({ userId, role: 'landlord', profileId: landlordId, landlordId },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'

const post = (app: any, token: string, body: any) =>
  request(app).post('/api/tenants/invite').set('Authorization', `Bearer ${token}`).send(body)

describe('POST /api/tenants/invite — what it actually does', () => {
  it('rejects an invite with no unit and no property', async () => {
    const { token } = await seed()
    const res = await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unit or property/i)
  })

  it('rejects a disposable email address', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: 'throwaway@mailinator.com', firstName: 'Al', unitId,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/disposable/i)
  })

  it('404s on a unit that does not exist', async () => {
    const { token } = await seed()
    const res = await post(buildApp(), token, {
      email: 'a@b.test', firstName: 'Al',
      unitId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(404)
  })

  it('refuses to invite into another landlord’s unit', async () => {
    const mine = await seed()
    const theirs = await seed()
    const res = await post(buildApp(), mine.token, {
      email: 'a@b.test', firstName: 'Al', unitId: theirs.unitId,
    })
    expect(res.status).toBe(403)
  })

  it('creates the user, the tenant, and a seven-day activation token', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: ' Nadia@example.test ', firstName: 'Nadia', lastName: 'Reyes', unitId,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.tenantId).toBeTruthy()
    // S655: email-only — the link is never in the response.
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(res.body.data).not.toHaveProperty('inviteToken')
    expect(sentInvites[0][5]).toContain('https://tenants.example.test/accept-invite?token=')
    expect(res.body.data.alreadyOnPlatform).toBe(false)
    expect(res.body.data.inviteSent).toBe(true)
    // S654: stored the way every lookup reads it.
    expect(res.body.data.email).toBe('nadia@example.test')

    const u = (await db.query(
      `SELECT role, first_name, last_name, tenant_invite_token,
              tenant_invite_expires_at > NOW() + INTERVAL '6 days' AS long_dated
         FROM users WHERE email = $1`, ['nadia@example.test'])).rows[0]
    expect(u.role).toBe('tenant')
    expect(u.first_name).toBe('Nadia')
    expect(u.tenant_invite_token).toBeTruthy()
    expect(u.long_dated).toBe(true)
  })

  // S652 (Nic): "he's not showing up in the front desk page as having a task to
  // complete." The unit-bound intent IS the desk's work item; without it a
  // resident invited from the Tenants page was invisible there.
  it('a unit-bound invite records a pending lease draft AND the unit-bound intent the Front Desk lists', async () => {
    const { token, unitId } = await seed()
    await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al', unitId })

    const drafts = (await db.query(
      `SELECT unit_id, household_order FROM pending_lease_drafts WHERE unit_id = $1`, [unitId])).rows
    expect(drafts).toHaveLength(1)
    expect(Number(drafts[0].household_order)).toBe(0)

    const intents = (await db.query(`SELECT unit_id, resolved_at, cancelled_at FROM pending_tenant_intents`)).rows
    expect(intents).toHaveLength(1)
    expect(intents[0].unit_id).toBe(unitId)
    expect(intents[0].resolved_at).toBeNull()
  })

  it('household order follows who was invited first', async () => {
    const { token, unitId } = await seed()
    const app = buildApp()
    await post(app, token, { email: 'first@b.test',  firstName: 'First',  unitId })
    await post(app, token, { email: 'second@b.test', firstName: 'Second', unitId })

    const rows = (await db.query(
      `SELECT u.email, d.household_order
         FROM pending_lease_drafts d JOIN users u ON u.id = d.tenant_user_id
        WHERE d.unit_id = $1 ORDER BY d.household_order`, [unitId])).rows
    expect(rows.map((r: any) => [r.email, Number(r.household_order)]))
      .toEqual([['first@b.test', 0], ['second@b.test', 1]])
  })

  it('a property-level invite records an intent with no unit, and NO lease draft', async () => {
    const { token, propertyId } = await seed()
    await post(buildApp(), token, { email: 'a@b.test', firstName: 'Al', propertyId })

    const intents = (await db.query(
      `SELECT property_id, unit_id, parser_status FROM pending_tenant_intents`)).rows
    expect(intents).toHaveLength(1)
    expect(intents[0].property_id).toBe(propertyId)
    expect(intents[0].unit_id).toBeNull()

    expect((await db.query(`SELECT id FROM pending_lease_drafts`)).rows).toHaveLength(0)
  })

  it('re-inviting the same address reuses the account and re-mints the token', async () => {
    const { token, unitId } = await seed()
    const app = buildApp()
    const first  = await post(app, token, { email: 'a@b.test', firstName: 'Al', unitId })
    const firstToken = (await db.query(`SELECT tenant_invite_token FROM users WHERE email = $1`, ['a@b.test'])).rows[0].tenant_invite_token
    const second = await post(app, token, { email: 'A@B.test', firstName: 'Al', unitId })

    expect(second.body.data.userId).toBe(first.body.data.userId)
    expect(second.body.data.tenantId).toBe(first.body.data.tenantId)
    // S655: a fresh link goes to their inbox and never back to the screen.
    expect(second.body.data).not.toHaveProperty('inviteToken')
    expect(second.body.data).not.toHaveProperty('acceptUrl')
    expect(second.body.data.inviteSent).toBe(true)
    const dbToken = (await db.query(`SELECT tenant_invite_token FROM users WHERE email = $1`, ['a@b.test'])).rows[0].tenant_invite_token
    expect(dbToken).toBeTruthy()
    expect(dbToken).not.toBe(firstToken)
    expect(sentInvites).toHaveLength(2)
    expect(sentInvites[1][0]).toBe('a@b.test')
    expect(sentInvites[1][5]).toContain(dbToken)
    expect((await db.query(`SELECT id FROM users WHERE lower(email) = $1`, ['a@b.test'])).rows)
      .toHaveLength(1)
    // And the second invite does not double up the household.
    expect((await db.query(`SELECT id FROM pending_lease_drafts`)).rows).toHaveLength(1)
  })

  it('SENDS THE INVITE EMAIL — the landlord is told one went out', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, {
      email: 'nadia@example.test', firstName: 'Nadia', unitId,
    })
    expect(res.status).toBe(200)
    expect(sentInvites).toHaveLength(1)
    const [to, tenantName, landlordName, , , activationUrl] = sentInvites[0]
    expect(to).toBe('nadia@example.test')
    expect(tenantName).toBe('Nadia')
    expect(landlordName).toBe('Dana Okafor')
    const dbToken = (await db.query(`SELECT tenant_invite_token FROM users WHERE email = $1`, ['nadia@example.test'])).rows[0].tenant_invite_token
    expect(activationUrl).toBe(`https://tenants.example.test/accept-invite?token=${dbToken}`)
    expect(res.body.data.inviteSent).toBe(true)
  })

  it('says a screening is coming on a property invite, and not on a unit invite', async () => {
    const { token, unitId, propertyId } = await seed()
    const app = buildApp()
    await post(app, token, { email: 'unit@b.test', firstName: 'U', unitId })
    await post(app, token, { email: 'prop@b.test', firstName: 'P', propertyId })

    const byEmail = Object.fromEntries(sentInvites.map((a) => [a[0], a[6]]))
    expect(byEmail['unit@b.test']).toBe(false)
    expect(byEmail['prop@b.test']).toBe(true)
  })

  it('a failed email does not fail the invite — the account and token still exist', async () => {
    const { token, unitId } = await seed()
    const email = await import('../services/email')
    ;(email.emailTenantInvite as any).mockRejectedValueOnce(new Error('resend down'))

    const res = await post(buildApp(), token, {
      email: 'a@b.test', firstName: 'Al', unitId,
    })
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect((await db.query(
      `SELECT tenant_invite_token FROM users WHERE email = $1`, ['a@b.test'])).rows[0]
      .tenant_invite_token).toBeTruthy()
  })
})

// ── S654: an invite link only ever activates a resident or e-sign contact ──
//
// A landlord's own login was given a tenant invite token through the bulk CSV
// import (since fixed there), and accept-invite never looked at whose account
// the token sat on: whoever held the link could set that landlord's password.
describe('S654: accept-invite refuses any account that is not a resident\'s or a contact\'s', () => {
  async function tokenOn(role: string, hash = 'original-hash') {
    const token = `tok-${Math.random().toString(16).slice(2)}${Date.now()}`
    const email = `${role}-${Math.random().toString(16).slice(2)}@example.test`
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, $4, $2, 'Pat', 'Lee', $3, NOW() + INTERVAL '7 days') RETURNING id`,
      [email, role, token, hash])).rows[0]
    return { userId: u.id, email, token }
  }
  const accept = (token: string) => request(buildApp()).post('/api/tenants/accept-invite')
    .send({ token, password: 'a-long-new-password', acceptedTerms: true })

  for (const role of ['landlord', 'property_manager', 'admin', 'super_admin']) {
    it(`a ${role} account: the link reads as invalid and the password is untouched`, async () => {
      const v = await tokenOn(role)
      const before = (await db.query(
        `SELECT password_hash, sessions_valid_from, tenant_invite_token, tenant_invite_accepted_at
           FROM users WHERE id=$1`, [v.userId])).rows[0]
      const res = await accept(v.token)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Invalid or expired invite link')
      const after = (await db.query(
        `SELECT password_hash, sessions_valid_from, tenant_invite_token, tenant_invite_accepted_at
           FROM users WHERE id=$1`, [v.userId])).rows[0]
      expect(after).toEqual(before)
      expect(after.password_hash).toBe('original-hash')

      const info = await request(buildApp()).get(`/api/tenants/invite-info?token=${v.token}`)
      expect(info.status).toBe(404)
    })
  }

  it('a resident account still activates', async () => {
    const v = await tokenOn('tenant', PLACEHOLDER)
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [v.userId])
    const res = await accept(v.token)
    expect(res.status).toBe(200)
    const u = (await db.query(`SELECT password_hash, tenant_invite_accepted_at FROM users WHERE id=$1`, [v.userId])).rows[0]
    expect(u.password_hash).not.toBe(PLACEHOLDER)
    expect(u.tenant_invite_accepted_at).not.toBeNull()
  })

  it('an e-sign contact account still activates (S568 signs in through this link)', async () => {
    const v = await tokenOn('contact')
    const res = await accept(v.token)
    expect(res.status).toBe(200)
    expect(res.body.data.user.role).toBe('contact')
  })

  it('the invite route refuses a landlord\'s email instead of minting a link it hands back', async () => {
    const { token, unitId } = await seed()
    const other = await seed()
    const otherEmail = (await db.query(`SELECT email FROM users WHERE id=$1`, [other.userId])).rows[0].email
    const res = await post(buildApp(), token, { email: otherEmail, firstName: 'Al', unitId })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/isn't a resident's/)
    expect(res.body.data).toBeUndefined()
    const u = (await db.query(`SELECT tenant_invite_token FROM users WHERE id=$1`, [other.userId])).rows[0]
    expect(u.tenant_invite_token).toBeNull()
    expect((await db.query(`SELECT id FROM tenants WHERE user_id=$1`, [other.userId])).rows).toEqual([])
    expect(sentInvites).toHaveLength(0)
  })
})

// ── S654: accept-invite is first-time setup only ─────────────────────────
//
// A token that reaches an account which already has its own password must not
// set a new one. Landlord B's utility-service agreement minted a token on X, a
// resident who signed up through screening with a password of their own and so
// never "accepted" an invite; accept-invite took that token and replaced X's
// working password. The link now works only on an account still waiting for
// its first password.
describe('S654: accept-invite refuses an account that already has its own password', () => {
  const accept = (token: string, password = 'a-long-new-password') =>
    request(buildApp()).post('/api/tenants/accept-invite').send({ token, password, acceptedTerms: true })
  const state = async (id: string) => (await db.query(
    `SELECT password_hash, sessions_valid_from, tenant_invite_token, tenant_invite_expires_at,
            tenant_invite_accepted_at, accepted_tos_at, email_verified, email_2fa_enabled
       FROM users WHERE id=$1`, [id])).rows[0]
  async function resident(hash: string, token: string) {
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, $2, 'tenant', 'Pat', 'Lee', $3, NOW() + INTERVAL '7 days') RETURNING id`,
      [`r-${Math.random().toString(16).slice(2)}@example.test`, hash, token])).rows[0]
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u.id])
    return u.id
  }

  it('a resident with their own password who never accepted: the link reads as invalid, nothing changes', async () => {
    const id = await resident('$2b$10$their.own.real.password.hash', 'minted-by-another-door')
    const before = await state(id)
    const res = await accept('minted-by-another-door')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Invalid or expired invite link')
    expect(res.body.data).toBeUndefined()
    expect(await state(id)).toEqual(before)

    const info = await request(buildApp()).get('/api/tenants/invite-info?token=minted-by-another-door')
    expect(info.status).toBe(404)
  })

  it('a contact who has set a password since (Forgot password) is refused the same way', async () => {
    const token = `c-${Date.now()}`
    const id = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name,
                          tenant_invite_token, tenant_invite_expires_at, sessions_valid_from)
       VALUES ($1, '$2b$12$a.password.they.set', 'contact', 'Pat', 'Lee', $2, NOW() + INTERVAL '7 days', NOW())
       RETURNING id`, [`c-${Date.now()}@example.test`, token])).rows[0].id
    const before = await state(id)
    const res = await accept(token)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Invalid or expired invite link')
    expect(await state(id)).toEqual(before)
  })

  it('an account that already finished setup still hears it is set up, not that the link is bad', async () => {
    const id = await resident(PLACEHOLDER, 'their-own-link')
    expect((await accept('their-own-link')).status).toBe(200)
    const before = await state(id)
    const again = await accept('their-own-link', 'a-different-password')
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('ALREADY_ACCEPTED')
    expect(await state(id)).toEqual(before)
  })

  it('a resident still waiting on their first password activates', async () => {
    const id = await resident(PLACEHOLDER, 'first-time')
    const info = await request(buildApp()).get('/api/tenants/invite-info?token=first-time')
    expect(info.status).toBe(200)
    const res = await accept('first-time')
    expect(res.status).toBe(200)
    const after = await state(id)
    expect(after.password_hash).not.toBe(PLACEHOLDER)
    expect(after.tenant_invite_accepted_at).not.toBeNull()
  })

  it('an e-sign contact minted with an unguessable stand-in password (S568) still activates', async () => {
    // services/signerAccounts stores a random hash, never the placeholder, and
    // nobody has ever set a password on it.
    const token = `contact-${Date.now()}`
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified,
                          tenant_invite_token, tenant_invite_expires_at)
       VALUES ($1, '$2b$10$random.unguessable.stand.in.hash', 'contact', 'Ann', 'Activator', FALSE, $2,
               NOW() + INTERVAL '14 days')`, [`ann-${Date.now()}@ext.test`, token])
    const res = await accept(token)
    expect(res.status).toBe(200)
    expect(res.body.data.user.role).toBe('contact')
  })
})

// ── S654: an invite never hands anyone a key to an account they didn't make ──
//
// The route looked accounts up by exact email, so 'LANDLORD@X.DEV' missed a
// landlord stored lowercase and made a second login on their address. And it
// minted a password link on ANY existing resident's account and returned it to
// whoever sent the invite: an existing resident with their own password, or
// another landlord's invitee, could have their password set by a stranger.
describe('S654: the invite route and existing accounts', () => {
  async function account(email: string, hash: string, extra: { phone?: string } = {}) {
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, 'tenant', 'Pat', 'Lee', $3) RETURNING id`,
      [email, hash, extra.phone ?? null])).rows[0]
    const t = (await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    return { userId: u.id, tenantId: t.id }
  }
  const stateOf = async (userId: string) => (await db.query(
    `SELECT email, password_hash, phone, tenant_invite_token, tenant_invite_expires_at,
            tenant_invite_accepted_at, sessions_valid_from, accepted_tos_at
       FROM users WHERE id = $1`, [userId])).rows[0]

  it('a landlord\'s address in another letter case: 409, no second login, no link', async () => {
    const { token, unitId } = await seed()
    const other = await seed()
    const otherEmail = (await db.query(`SELECT email FROM users WHERE id=$1`, [other.userId])).rows[0].email
    const res = await post(buildApp(), token, { email: otherEmail.toUpperCase(), firstName: 'Al', unitId })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/isn't a resident's/)
    expect(res.body.data).toBeUndefined()
    expect((await db.query(`SELECT id, role FROM users WHERE lower(email) = lower($1)`, [otherEmail])).rows)
      .toEqual([{ id: other.userId, role: 'landlord' }])
    expect((await db.query(`SELECT tenant_invite_token FROM users WHERE id=$1`, [other.userId])).rows[0].tenant_invite_token)
      .toBeNull()
    expect(sentInvites).toHaveLength(0)
  })

  it('an existing resident with their own password: no link, nothing about their login changes', async () => {
    const { token, unitId } = await seed()
    const email = 'screened@example.test'
    const r = await account(email, '$2b$10$their.own.real.password.hash', { phone: '555-0101' })
    const before = await stateOf(r.userId)

    const res = await post(buildApp(), token, { email, firstName: 'Pat', unitId, phone: '999-999-9999' })
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(r.userId)
    expect(res.body.data).not.toHaveProperty('inviteToken')
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(res.body.data.alreadyOnPlatform).toBe(true)
    expect(res.body.data.inviteSent).toBe(false)
    expect(await stateOf(r.userId)).toEqual(before)
    expect(sentInvites).toHaveLength(0)
    // The invite still lands: the unit is waiting on them.
    expect((await db.query(`SELECT unit_id FROM pending_tenant_intents WHERE tenant_id=$1`, [r.tenantId])).rows)
      .toEqual([{ unit_id: unitId }])
  })

  it('another landlord\'s invitee: no link to the inviter, and the first landlord\'s link keeps working', async () => {
    const first = await seed()
    const second = await seed()
    const email = 'theirs@example.test'
    const r = await account(email, '$2b$10$placeholder_invite_pending')
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [first.landlordId, r.tenantId, first.unitId])
    await db.query(
      `UPDATE users SET tenant_invite_token = 'first-landlords-live-link',
                        tenant_invite_expires_at = NOW() + INTERVAL '7 days' WHERE id = $1`, [r.userId])
    const before = await stateOf(r.userId)

    const res = await post(buildApp(), second.token, { email: email.toUpperCase(), firstName: 'Pat', unitId: second.unitId })
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('inviteToken')
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(res.body.data.alreadyOnPlatform).toBe(true)
    expect(await stateOf(r.userId)).toEqual(before)
    expect(sentInvites).toHaveLength(0)
    expect((await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows).toHaveLength(1)

    const info = await request(buildApp()).get('/api/tenants/invite-info?token=first-landlords-live-link')
    expect(info.status).toBe(200)
  })

  it('a resident stored in mixed case is found, not duplicated, and the link goes to their own address', async () => {
    const { token, unitId } = await seed()
    const stored = 'Kim.Harland@Example.test'
    const r = await account(stored, '$2b$10$placeholder_invite_pending')

    const res = await post(buildApp(), token, { email: 'kim.harland@example.test', firstName: 'Kim', unitId })
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(r.userId)
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(res.body.data.inviteSent).toBe(true)
    expect((await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [stored])).rows).toHaveLength(1)
    expect(sentInvites).toHaveLength(1)
    expect(sentInvites[0][0]).toBe(stored)
  })

  // S655 (Nic, 10/2): email-only. The one exception S654 kept — an account
  // this invite just made — is gone: the link goes to their inbox, nowhere else.
  it('a brand-new address gets its link by email only, never handed back', async () => {
    const { token, unitId } = await seed()
    const res = await post(buildApp(), token, { email: 'fresh@example.test', firstName: 'Fresh', unitId })
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('inviteToken')
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite|[0-9a-f]{64}/)
    const dbToken = (await db.query(`SELECT tenant_invite_token FROM users WHERE email = $1`, ['fresh@example.test'])).rows[0].tenant_invite_token
    expect(dbToken).toMatch(/^[0-9a-f]{64}$/)
    expect(sentInvites).toHaveLength(1)
    expect(sentInvites[0][5]).toBe(`https://tenants.example.test/accept-invite?token=${dbToken}`)
  })

  it('a property-level invite hands back no link either', async () => {
    const { token, propertyId } = await seed()
    const res = await post(buildApp(), token, { email: 'applicant@example.test', firstName: 'App', propertyId })
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('acceptUrl')
    expect(res.body.data).not.toHaveProperty('inviteToken')
    expect(res.body.data.inviteSent).toBe(true)
    expect(sentInvites).toHaveLength(1)
  })
})

// ── S655: a unit invite is the one invite every door uses ────────────────
async function seedDefaultLease(landlordId: string, propertyId: string): Promise<void> {
  await db.query(
    `INSERT INTO property_unit_type_late_fees (property_id, unit_type, no_late_fee) VALUES ($1, 'apartment', true)
     ON CONFLICT DO NOTHING`, [propertyId])
  const tid = (await db.query<{ id: string }>(
    `INSERT INTO lease_templates (landlord_id, name, page_count, unit_type, deposit_months, default_term_months, is_unit_type_default)
     VALUES ($1, 'Primary Apartment', 1, 'apartment', 1, 12, true) RETURNING id`, [landlordId])).rows[0].id
  for (const c of ['rent_amount', 'security_deposit', 'start_date', 'end_date', 'lease_type']) {
    await db.query(
      `INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y, width, height)
       VALUES ($1, 'text', 'landlord', $2, 1, 10, 10, 100, 20)`, [tid, c])
  }
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','primary','tenant_signature',1,10,100)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','co_tenant_1','tenant_signature',1,10,140)`, [tid])
  await db.query(`INSERT INTO lease_template_fields (template_id, field_type, signer_role, lease_column, page, x, y) VALUES ($1,'signature','landlord','landlord_signature',1,10,180)`, [tid])
}
const liveLeaseDocs = async (unitId: string) => (await db.query<{ id: string }>(
  `SELECT id FROM lease_documents WHERE unit_id = $1 AND document_type = 'original_lease' AND status <> 'voided'`,
  [unitId])).rows
const tenantSignerEmails = async (documentId: string) => (await db.query<{ email: string }>(
  `SELECT email FROM lease_document_signers WHERE document_id = $1 AND role NOT IN ('landlord','witness') ORDER BY order_index`,
  [documentId])).rows.map(r => r.email)

describe('S655: a unit invite drafts the lease and emails nobody until the landlord signs', () => {
  it('with a default lease set, the lease drafts at once and the tenant gets NO email and no link', async () => {
    const f = await seed()
    await seedDefaultLease(f.landlordId, f.propertyId)
    const res = await post(buildApp(), f.token, { email: 'quiet@example.test', firstName: 'Quinn', lastName: 'Et', unitId: f.unitId })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseDrafted).toBe(true)
    expect(res.body.data.inviteSent).toBe(false)
    expect(sentInvites).toHaveLength(0)
    expect((await db.query(`SELECT tenant_invite_token FROM users WHERE email = $1`, ['quiet@example.test'])).rows[0].tenant_invite_token)
      .toBeNull()
    expect(await liveLeaseDocs(f.unitId)).toHaveLength(1)
  })

  it('a household sent together lands on ONE lease with everyone on it', async () => {
    const f = await seed()
    await seedDefaultLease(f.landlordId, f.propertyId)
    const res = await post(buildApp(), f.token, {
      unitId: f.unitId, email: 'one@example.test', firstName: 'One',
      residents: [
        { email: 'one@example.test', firstName: 'One', lastName: 'A' },
        { email: 'two@example.test', firstName: 'Two', lastName: 'B' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.data.people.map((p: any) => p.email)).toEqual(['one@example.test', 'two@example.test'])
    const docs = await liveLeaseDocs(f.unitId)
    expect(docs).toHaveLength(1)
    expect(await tenantSignerEmails(docs[0].id)).toEqual(['one@example.test', 'two@example.test'])
  })

  it('a second person invited to the same home is added to the lease, not left off it', async () => {
    const f = await seed()
    await seedDefaultLease(f.landlordId, f.propertyId)
    const app = buildApp()
    await post(app, f.token, { email: 'first@example.test', firstName: 'First', lastName: 'A', unitId: f.unitId })
    await post(app, f.token, { email: 'second@example.test', firstName: 'Second', lastName: 'B', unitId: f.unitId })
    const docs = await liveLeaseDocs(f.unitId)
    expect(docs).toHaveLength(1)
    expect(await tenantSignerEmails(docs[0].id)).toEqual(['first@example.test', 'second@example.test'])
  })
})

// ── S655 review: the result says what actually reached each person ─────────
// The Invite Tenant screen read everyone who was not emailed as "already has a
// GAM account — they were told there", including a new person whose email
// failed. Each person now carries `notified`: 'email', 'notice' or null.
describe('S655: the invite result says who was actually contacted', () => {
  const failNextEmail = async () => {
    const { emailTenantInvite } = await import('../services/email')
    vi.mocked(emailTenantInvite).mockImplementationOnce(async () => { throw new Error('mail provider down') })
  }

  it('a lease that cannot draft: a new person whose email went is marked emailed', async () => {
    const f = await seed()   // no default lease, so the usual invite goes instead
    const res = await post(buildApp(), f.token, { email: 'went@example.test', firstName: 'Went', lastName: 'Out', unitId: f.unitId })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseDrafted).toBe(false)
    expect(res.body.data.people[0]).toMatchObject({ notified: 'email', inviteSent: true, alreadyOnPlatform: false })
  })

  it('a lease that cannot draft: a new person whose email failed is marked not contacted, not "told there"', async () => {
    const f = await seed()
    await failNextEmail()
    const res = await post(buildApp(), f.token, { email: 'failed@example.test', firstName: 'Fay', lastName: 'Led', unitId: f.unitId })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseDrafted).toBe(false)
    expect(res.body.data.people[0]).toMatchObject({ notified: null, inviteSent: false, alreadyOnPlatform: false })
  })

  it('a lease that drafts contacts nobody yet', async () => {
    const f = await seed()
    await seedDefaultLease(f.landlordId, f.propertyId)
    const res = await post(buildApp(), f.token, { email: 'later@example.test', firstName: 'Lay', lastName: 'Ter', unitId: f.unitId })
    expect(res.body.data.leaseDrafted).toBe(true)
    expect(res.body.data.people[0].notified).toBeNull()
  })

  it('a property invite whose email failed does not claim the email went', async () => {
    const f = await seed()
    await failNextEmail()
    const res = await post(buildApp(), f.token, { email: 'applicant-x@example.test', firstName: 'App', propertyId: f.propertyId })
    expect(res.status).toBe(200)
    expect(res.body.data.inviteSent).toBe(false)
    expect(res.body.data.notified).toBeNull()
    expect(res.body.data.alreadyOnPlatform).toBe(false)
  })

  it('a property invite whose email went says so', async () => {
    const f = await seed()
    const res = await post(buildApp(), f.token, { email: 'applicant-y@example.test', firstName: 'App', propertyId: f.propertyId })
    expect(res.body.data.inviteSent).toBe(true)
    expect(res.body.data.notified).toBe('email')
  })
})

// ── S655: security item 4 — a property invite never rewrites another company's row ──
describe('S655: a property-level invite keeps to its own company', () => {
  async function waiverAt(companyLandlordId: string, propertyId: string, tenantId: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, property_id, unit_id, screening_waived, screening_attested)
       VALUES ($1, $2, 'not_uploaded', $3, NULL, true, true) RETURNING id`, [companyLandlordId, tenantId, propertyId])).rows[0].id
  }

  it("company X's property invite leaves company Y's waiver row exactly as it was", async () => {
    const y = await seed()
    const x = await seed()
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('shared@example.test', '$2b$10$placeholder_invite_pending', 'tenant', 'Sha', 'Red') RETURNING id`)).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    const yRow = await waiverAt(y.landlordId, y.propertyId, t.id)
    const before = (await db.query(`SELECT * FROM pending_tenant_intents WHERE id = $1`, [yRow])).rows[0]

    const res = await post(buildApp(), x.token, { email: 'shared@example.test', firstName: 'Sha', propertyId: x.propertyId })
    expect(res.status).toBe(200)
    expect((await db.query(`SELECT * FROM pending_tenant_intents WHERE id = $1`, [yRow])).rows[0]).toEqual(before)
  })

  it('once the old person-wide index is gone (the post-deploy step), X gets a row of its own', async () => {
    const y = await seed()
    const x = await seed()
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('both@example.test', '$2b$10$placeholder_invite_pending', 'tenant', 'Bo', 'Th') RETURNING id`)).rows[0]
    const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
    const yRow = await waiverAt(y.landlordId, y.propertyId, t.id)
    await db.query(`DROP INDEX IF EXISTS pending_tenant_intents_tenant_nounit_live_key`)
    try {
      const res = await post(buildApp(), x.token, { email: 'both@example.test', firstName: 'Bo', propertyId: x.propertyId })
      expect(res.status).toBe(200)
      const rows = (await db.query(
        `SELECT id, landlord_id, property_id FROM pending_tenant_intents
          WHERE tenant_id = $1 AND unit_id IS NULL AND cancelled_at IS NULL ORDER BY created_at`, [t.id])).rows
      expect(rows).toHaveLength(2)
      expect(rows.find((r: any) => r.id === yRow)).toMatchObject({ landlord_id: y.landlordId, property_id: y.propertyId })
      expect(rows.find((r: any) => r.id !== yRow)).toMatchObject({ landlord_id: x.landlordId, property_id: x.propertyId })
    } finally {
      await db.query(`DELETE FROM pending_tenant_intents WHERE tenant_id = $1`, [t.id])
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant_intents_tenant_nounit_live_key
           ON pending_tenant_intents (tenant_id) WHERE cancelled_at IS NULL AND unit_id IS NULL`)
    }
  })
})
