/**
 * S654 — two landlord routes on a pending invite could hand one landlord
 * another person's GAM login.
 *
 *   POST  /me/pending-tenants/:intentId/resolve
 *     returned the activation link it made. The tenant's address comes from the
 *     landlord's own overrides, so landlord B could resolve a throwaway intent
 *     with anyone's address and get a password link for their account.
 *
 *   PATCH /me/pending-intents/:id/contact
 *     let landlord B move landlord A's invitee onto B's own mailbox (B gets an
 *     intent on anyone through /tenants/invite) and mailed a fresh link there.
 *     Its re-send of a signed lease then went to the signer row's email, which
 *     B wrote on B's own document, carrying A's live setup link. And a
 *     corrected address left the old setup link live (lease still waiting on
 *     the landlord) and the old address on the packet's other documents.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailTenantOnboardedMock, emailTenantInviteMock, emailSigningRequestMock } = vi.hoisted(() => ({
  emailTenantOnboardedMock: vi.fn(async (..._a: any[]) => undefined),
  emailTenantInviteMock: vi.fn(async (..._a: any[]) => undefined),
  emailSigningRequestMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailTenantOnboarded: emailTenantOnboardedMock,
  emailTenantInvite: emailTenantInviteMock,
  emailSigningRequest: emailSigningRequestMock,
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import crypto from 'crypto'
import { landlordsRouter } from './landlords'
import { esignRouter } from './esign'
import { companyTieSources } from './tenants'
import { errorHandler } from '../middleware/errorHandler'

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'

beforeEach(async () => {
  await cleanupAllSchema()
  emailTenantOnboardedMock.mockClear()
  emailTenantInviteMock.mockClear()
  emailSigningRequestMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pending_intents'
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/landlords', landlordsRouter)
  // S654: mounted so a test can try an old signing link the way its holder would.
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

async function company() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, withLateFeeDecision: true })
    await c.query('COMMIT')
    const unitNumber = (await db.query(`SELECT unit_number FROM units WHERE id=$1`, [unitId])).rows[0].unit_number
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, unitNumber, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Company = Awaited<ReturnType<typeof company>>

/** A resident account and its tenants row. */
async function resident(opts: { password?: string; token?: string | null } = {}) {
  const email = `x-${randomUUID().slice(0, 8)}@test.dev`
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, tenant_invite_token, tenant_invite_expires_at)
     VALUES ($1, $2, 'tenant', 'Ex', 'Ample', $3::text, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() + INTERVAL '7 days' END)
     RETURNING id`, [email, opts.password ?? PLACEHOLDER, opts.token ?? null])).rows[0]
  const t = (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.id])).rows[0]
  return { userId: u.id, tenantId: t.id, email }
}

async function intentFor(co: Company, tenantId: string, parserStatus = 'not_uploaded') {
  return (await db.query<{ id: string }>(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [co.landlordId, tenantId, parserStatus, parserStatus === 'error' ? null : co.unitId, co.propertyId])).rows[0].id
}

const usersRow = async (id: string) => (await db.query(
  `SELECT email, email_verified, first_name, last_name, password_hash, tenant_invite_token, tenant_invite_expires_at
     FROM users WHERE id=$1`, [id])).rows[0]

const noEmail = () => {
  expect(emailTenantOnboardedMock).not.toHaveBeenCalled()
  expect(emailTenantInviteMock).not.toHaveBeenCalled()
  expect(emailSigningRequestMock).not.toHaveBeenCalled()
}

describe('S654: POST /me/pending-tenants/:intentId/resolve never returns a password link', () => {
  const resolve = (co: Company, intentId: string, email: string) =>
    request(buildApp()).post(`/api/landlords/me/pending-tenants/${intentId}/resolve`)
      .set('Authorization', `Bearer ${co.token}`)
      .send({ landlordOverrides: {
        tenants: [{ firstName: { value: 'Vic' }, lastName: { value: 'Tim' }, email: { value: email } }],
        unit: { propertyName: { value: 'Test Property' }, unitNumber: { value: co.unitNumber } },
        lease: { leaseStart: { value: '2026-02-01' }, monthlyRent: { value: 900 } },
      } })

  it("someone else's account: no link, and their password and token are untouched", async () => {
    const b = await company()
    const victim = await resident({ password: '$2b$10$their.own.real.password.hash' })
    const throwaway = await resident()
    const before = await usersRow(victim.userId)

    const res = await resolve(b, await intentFor(b, throwaway.tenantId, 'error'), victim.email.toUpperCase())
    expect(res.status).toBe(200)
    expect(res.body.data.userId).toBe(victim.userId)
    expect(res.body.data).not.toHaveProperty('activationUrl')
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite/)
    expect(await usersRow(victim.userId)).toEqual(before)
    noEmail()
  })

  it('a brand-new address: the link goes only to that inbox', async () => {
    const b = await company()
    const throwaway = await resident()
    const email = `new-${randomUUID().slice(0, 8)}@test.dev`
    const res = await resolve(b, await intentFor(b, throwaway.tenantId, 'error'), email)
    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('activationUrl')
    expect(res.body.data.inviteSent).toBe(true)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite/)
    expect(emailTenantOnboardedMock).toHaveBeenCalledTimes(1)
    expect(emailTenantOnboardedMock.mock.calls[0]![0]).toBe(email)
    expect(emailTenantOnboardedMock.mock.calls[0]![5]).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/)
  })
})

describe("S654: PATCH /me/pending-intents/:id/contact can't redirect another landlord's invitee", () => {
  const edit = (co: Company, intentId: string, body: any) =>
    request(buildApp()).patch(`/api/landlords/me/pending-intents/${intentId}/contact`)
      .set('Authorization', `Bearer ${co.token}`).send(body)

  /** A invited X; B then got an intent on X (what /tenants/invite writes). */
  async function shared() {
    const a = await company()
    const b = await company()
    const x = await resident({ token: 'a-live-link' })
    const aIntent = await intentFor(a, x.tenantId)
    const bIntent = await intentFor(b, x.tenantId)
    return { a, b, x, aIntent, bIntent }
  }

  it("B can't move A's invitee onto another address: no change, A's link intact, no email", async () => {
    const s = await shared()
    const before = await usersRow(s.x.userId)
    const res = await edit(s.b, s.bIntent, { email: 'attacker@evil.test', resend: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/another company/)
    expect(await usersRow(s.x.userId)).toEqual(before)
    expect((await usersRow(s.x.userId)).tenant_invite_token).toBe('a-live-link')
    noEmail()
  })

  it("B can't rename A's invitee either", async () => {
    const s = await shared()
    const before = await usersRow(s.x.userId)
    const res = await edit(s.b, s.bIntent, { firstName: 'Mallory' })
    expect(res.status).toBe(409)
    expect(await usersRow(s.x.userId)).toEqual(before)
    noEmail()
  })

  it("B may re-send to the same address; A's live link keeps working and A's lease is not touched", async () => {
    const s = await shared()
    // A has drafted and signed X's lease: the one email for it is A's to send.
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'A lease', 'original_lease', 'in_progress') RETURNING id`, [s.a.landlordId, s.a.unitId])).rows[0]
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'landlord', 'A A', 'a@test.dev', 1, $3, 'signed'),
              ($1, $4, 'primary', 'Ex Ample', $5, 2, $6, 'sent')`,
      [d.id, s.a.userId, randomUUID(), s.x.userId, s.x.email, randomUUID()])

    const res = await edit(s.b, s.bIntent, { email: s.x.email.toUpperCase(), resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    expect(emailSigningRequestMock).not.toHaveBeenCalled()
    expect(emailTenantInviteMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url] = emailTenantInviteMock.mock.calls[0]!
    expect(to).toBe(s.x.email)
    expect(url).toMatch(/\/accept-invite\?token=a-live-link$/)
    expect((await usersRow(s.x.userId)).tenant_invite_token).toBe('a-live-link')
  })

  it("the landlord's own invitee can still be moved to a corrected address", async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)
    const res = await edit(a, intent, { email: 'Fixed.Address@Example.test', resend: true })
    expect(res.status).toBe(200)
    const row = await usersRow(x.userId)
    expect(row.email).toBe('fixed.address@example.test')
    expect(row.tenant_invite_token).not.toBe('old-link')
    expect(emailTenantInviteMock).toHaveBeenCalledTimes(1)
    expect(emailTenantInviteMock.mock.calls[0]![0]).toBe('fixed.address@example.test')
  })

  it('an account with its own password keeps its address; a re-send gives no setup link, only a notice in their account', async () => {
    const a = await company()
    const x = await resident({ password: '$2b$10$their.own.real.password.hash' })
    const intent = await intentFor(a, x.tenantId)
    const before = await usersRow(x.userId)
    const res = await edit(a, intent, { email: 'someone.else@example.test' })
    expect(res.status).toBe(409)
    expect(await usersRow(x.userId)).toEqual(before)
    noEmail()

    // S654: an invite link would let whoever opens it replace their password.
    const again = await edit(a, intent, { resend: true })
    expect(again.status).toBe(200)
    expect(again.body.data.resent).toBe(false)
    expect(again.body.data.alreadyOnPlatform).toBe(true)
    expect(JSON.stringify(again.body)).not.toMatch(/accept-invite/)
    expect(await usersRow(x.userId)).toEqual(before)
    noEmail()
    const notes = (await db.query(
      `SELECT landlord_id, type FROM notifications WHERE user_id=$1`, [x.userId])).rows
    expect(notes).toEqual([{ landlord_id: a.landlordId, type: 'lease_drafted' }])
  })
})

// ── S654: the re-send goes to the address on the account, never the signer row's ──
//
// Reproduced in round 6: B has an intent on A's invitee X, and B's own
// landlord-signed lease lists X's signer email as attacker@evil.test. B's
// same-address re-send passed the tie check (rightly), and the setup-and-sign
// email went to attacker@evil.test carrying A's live link.
describe('S654: PATCH /me/pending-intents/:id/contact re-sends a signed lease only to the account\'s address', () => {
  const edit = (co: Company, intentId: string, body: any) =>
    request(buildApp()).patch(`/api/landlords/me/pending-intents/${intentId}/contact`)
      .set('Authorization', `Bearer ${co.token}`).send(body)

  /** co's own lease for x, signed by co, with x's signer row on `signerEmail`. */
  async function signedLease(co: Company, x: { userId: string }, signerEmail: string) {
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'Lease', 'original_lease', 'in_progress') RETURNING id`, [co.landlordId, co.unitId])).rows[0]
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'landlord', 'L L', 'l@test.dev', 1, $3, 'signed'),
              ($1, $4, 'primary', 'Ex Ample', $5, 2, $6, 'sent')`,
      [d.id, co.userId, randomUUID(), x.userId, signerEmail, randomUUID()])
    return d.id
  }

  it("B's re-send of B's own signed lease for A's invitee: to X's address with A's live link, never the signer row's", async () => {
    const a = await company()
    const b = await company()
    const x = await resident({ token: 'a-live-link' })
    await intentFor(a, x.tenantId)
    const bIntent = await intentFor(b, x.tenantId)
    await signedLease(b, x, 'attacker@evil.test')

    const res = await edit(b, bIntent, { resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite|a-live-link/)
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url] = emailSigningRequestMock.mock.calls[0]!
    expect(to).toBe(x.email)
    expect(url).toMatch(/\/accept-invite\?token=a-live-link&next=/)
    expect(JSON.stringify(emailSigningRequestMock.mock.calls)).not.toContain('attacker@evil.test')
    // A's emailed link is the same link, still working.
    expect((await usersRow(x.userId)).tenant_invite_token).toBe('a-live-link')
    expect(emailTenantInviteMock).not.toHaveBeenCalled()
  })

  it("the landlord's own invitee: the address on the account, even when the signer row says otherwise", async () => {
    const a = await company()
    const x = await resident({ token: 'own-link' })
    const intent = await intentFor(a, x.tenantId)
    await signedLease(a, x, 'stale.address@example.test')

    const res = await edit(a, intent, { resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    expect(emailSigningRequestMock.mock.calls[0]![0]).toBe(x.email)
    expect(JSON.stringify(emailSigningRequestMock.mock.calls)).not.toContain('stale.address@example.test')
  })

  // S654: the signed-lease re-send is safe for another company's invitee
  // whatever their link's state: tenantLeaseLink mints nothing for them, and
  // with no live link sends the plain signing link (signs without a password,
  // S629). Round 7 refused it with a 409; that is now kept only where there is
  // no lease and the portal invite is all there is to send.
  it("another company's invitee whose link has run out: the signed lease goes as the plain signing link, nothing minted", async () => {
    const a = await company()
    const b = await company()
    const x = await resident({ token: 'a-dead-link' })
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [x.userId])
    await intentFor(a, x.tenantId)
    const bIntent = await intentFor(b, x.tenantId)
    const docId = await signedLease(b, x, 'attacker@evil.test')
    const before = await usersRow(x.userId)
    const seat = (await db.query<{ token: string }>(
      `SELECT token FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [docId, x.userId])).rows[0]

    const res = await edit(b, bIntent, { resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    expect(JSON.stringify(res.body)).not.toMatch(/accept-invite|a-dead-link/)
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url, opts] = emailSigningRequestMock.mock.calls[0]!
    expect(to).toBe(x.email)
    expect(url).toMatch(new RegExp(`/sign/${seat.token}$`))
    expect(url).not.toMatch(/accept-invite/)
    expect(opts).toMatchObject({ needsSetup: false })
    expect(JSON.stringify(emailSigningRequestMock.mock.calls)).not.toContain('attacker@evil.test')
    // Their account is exactly as company A left it: no token minted or revived.
    expect(await usersRow(x.userId)).toEqual(before)
    expect(emailTenantInviteMock).not.toHaveBeenCalled()
  })

  it("another company's invitee whose link has run out, no lease drafted: nothing is minted or sent, and the landlord is told why", async () => {
    const a = await company()
    const b = await company()
    const x = await resident({ token: 'a-dead-link' })
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [x.userId])
    await intentFor(a, x.tenantId)
    const bIntent = await intentFor(b, x.tenantId)
    const before = await usersRow(x.userId)

    const res = await edit(b, bIntent, { resend: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/another company/)
    expect(res.body.error).toMatch(/Forgot password/)
    expect(await usersRow(x.userId)).toEqual(before)
    noEmail()
  })
})

// ── S654: a corrected address takes the old setup link and the old seats with it ──
//
// Round 7, reproduced: the landlord fixed a mistyped address while the lease
// still waited on their own signature. users.email changed, but the setup link
// already mailed to the typo address stayed live, and signing later sent that
// same token on to the new address. And only the lease's seat moved: the
// packet's other document kept the typo address, which the reminders mail with
// a signing link that needs no password (S629).
describe('S654: PATCH /me/pending-intents/:id/contact, a changed address', () => {
  const edit = (co: Company, intentId: string, body: any) =>
    request(buildApp()).patch(`/api/landlords/me/pending-intents/${intentId}/contact`)
      .set('Authorization', `Bearer ${co.token}`).send(body)

  /** A document of `type` from co with x seated at `email`; landlord row signed or not. */
  async function doc(co: Company, x: { userId: string }, email: string, o: {
    type?: string; status?: string; landlordSigned?: boolean; seatStatus?: string
  } = {}) {
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'Doc', $3, $4) RETURNING id`,
      [co.landlordId, co.unitId, o.type ?? 'original_lease', o.status ?? 'in_progress'])).rows[0]
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'landlord', 'L L', 'l@test.dev', 1, $3, $4),
              ($1, $5, 'primary', 'Ex Ample', $6, 2, $7, $8)`,
      [d.id, co.userId, randomUUID(), o.landlordSigned === false ? 'pending' : 'signed',
       x.userId, email, randomUUID(), o.seatStatus ?? 'sent'])
    return d.id
  }
  const seatEmail = async (docId: string, userId: string) => (await db.query(
    `SELECT email FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [docId, userId])).rows[0].email

  it('lease still waiting on the landlord: the address is saved, the old setup link dies, nothing is sent', async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)
    const lease = await doc(a, x, x.email, { landlordSigned: false, status: 'pending', seatStatus: 'pending' })

    const res = await edit(a, intent, { email: 'right.address@example.test', resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.heldUntilLandlordSigns).toBe(true)
    expect(res.body.data.resent).toBe(false)
    const row = await usersRow(x.userId)
    expect(row.email).toBe('right.address@example.test')
    expect(row.tenant_invite_token).toBeNull()
    expect(row.tenant_invite_expires_at).toBeNull()
    expect(await seatEmail(lease, x.userId)).toBe('right.address@example.test')
    noEmail()
  })

  it('resend:false: the address is saved and the old setup link dies all the same', async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)

    const res = await edit(a, intent, { email: 'right.address@example.test', resend: false })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(false)
    const row = await usersRow(x.userId)
    expect(row.email).toBe('right.address@example.test')
    expect(row.tenant_invite_token).toBeNull()
    expect(row.tenant_invite_expires_at).toBeNull()
    noEmail()
  })

  it("every unsigned seat on this company's open documents moves; signed and voided ones do not", async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)
    const typo = x.email
    const lease = await doc(a, x, typo)                                          // the packet's lease
    const addendum = await doc(a, x, typo, { type: 'work_trade_addendum' })     // and its second document
    const draft = await doc(a, x, typo, { type: 'general_contract', status: 'pending', landlordSigned: false, seatStatus: 'pending' })
    const signedSeat = await doc(a, x, typo, { type: 'general_contract', seatStatus: 'signed' })
    const voided = await doc(a, x, typo, { type: 'general_contract', status: 'voided' })

    const res = await edit(a, intent, { email: 'Fixed.Address@Example.test', resend: true })
    expect(res.status).toBe(200)
    expect(res.body.data.resent).toBe(true)
    for (const d of [lease, addendum, draft]) {
      expect(await seatEmail(d, x.userId)).toBe('fixed.address@example.test')
    }
    // What was signed was signed at that address; a voided document is closed.
    expect(await seatEmail(signedSeat, x.userId)).toBe(typo)
    expect(await seatEmail(voided, x.userId)).toBe(typo)
    // The landlord's own seat is never re-addressed.
    const landlordSeats = (await db.query(
      `SELECT DISTINCT email FROM lease_document_signers WHERE user_id=$1`, [a.userId])).rows
    expect(landlordSeats).toEqual([{ email: 'l@test.dev' }])

    // The signed lease's email goes to the new address with a freshly minted
    // setup link; the old link is gone.
    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    const [to, , , , , url] = emailSigningRequestMock.mock.calls[0]!
    expect(to).toBe('fixed.address@example.test')
    const row = await usersRow(x.userId)
    expect(row.tenant_invite_token).toMatch(/^[0-9a-f]{64}$/)
    expect(url).toContain(`/accept-invite?token=${row.tenant_invite_token}&next=`)
    expect(JSON.stringify(emailSigningRequestMock.mock.calls)).not.toContain('old-link')
  })

  it('a name-only correction leaves the setup link and the seats\' addresses alone', async () => {
    const a = await company()
    const x = await resident({ token: 'own-link' })
    const intent = await intentFor(a, x.tenantId)
    const lease = await doc(a, x, x.email, { landlordSigned: false, status: 'pending', seatStatus: 'pending' })

    const res = await edit(a, intent, { firstName: 'Exa' })
    expect(res.status).toBe(200)
    const row = await usersRow(x.userId)
    expect(row.first_name).toBe('Exa')
    expect(row.tenant_invite_token).toBe('own-link')
    expect(row.tenant_invite_expires_at).not.toBeNull()
    expect(await seatEmail(lease, x.userId)).toBe(x.email)
  })
})

// ── S654 (round 8): every tie to another company counts ──────────────────────
//
// Reproduced in round 8: X never set up their account, and X's only ties to
// company A were a cancelled invite, A's background check on X (denied) and a
// $250 one-off charge. The tie check counted none of those. B got an intent on
// X, moved the login onto attacker@evil.test, and the setup link mailed there
// set the password; signed in as X, it read A's screening decision.
describe('S654: PATCH /me/pending-intents/:id/contact counts every tie to another company', () => {
  const edit = (co: Company, intentId: string, body: any) =>
    request(buildApp()).patch(`/api/landlords/me/pending-intents/${intentId}/contact`)
      .set('Authorization', `Bearer ${co.token}`).send(body)
  type Resident = Awaited<ReturnType<typeof resident>>

  const ties: Array<{ name: string; seed: (co: Company, x: Resident) => Promise<unknown> }> = [
    { name: 'a cancelled invite', seed: (co, x) => db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id, cancelled_at)
       VALUES ($1, $2, 'not_uploaded', $3, $4, NOW())`, [co.landlordId, x.tenantId, co.unitId, co.propertyId]) },
    { name: 'a background check', seed: (co, x) => db.query(
      `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, unit_id)
       VALUES ($1, $2, $3, 'denied', $4)`, [co.landlordId, x.userId, x.tenantId, co.unitId]) },
    { name: 'a one-off charge', seed: (co, x) => db.query(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, unit_id, charge_type, amount, reason, incident_date)
       VALUES ($1, $2, $3, 'damage', 250, 'Broken gate', CURRENT_DATE)`, [co.landlordId, x.tenantId, co.unitId]) },
    { name: 'a filed document', seed: (co, x) => db.query(
      `INSERT INTO documents (landlord_id, tenant_id, type, name, url)
       VALUES ($1, $2, 'notice', 'Notice', '/uploads/notice.pdf')`, [co.landlordId, x.tenantId]) },
    { name: 'a maintenance request', seed: (co, x) => db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, tenant_id, title, description)
       VALUES ($1, $2, $3, 'Leak', 'Under the sink')`, [co.unitId, co.landlordId, x.tenantId]) },
    { name: 'a work-trade agreement', seed: (co, x) => db.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 'ended')`, [co.unitId, x.tenantId, co.landlordId]) },
    { name: 'a credit', seed: (co, x) => db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 25, 25)`, [co.landlordId, x.tenantId]) },
    { name: 'a notice in their account', seed: (co, x) => db.query(
      `INSERT INTO notifications (user_id, landlord_id, type, title, body)
       VALUES ($1, $2, 'general', 'Hello', 'From the office')`, [x.userId, co.landlordId]) },
    { name: "a seat on a voided document", seed: async (co, x) => {
      const d = (await db.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
         VALUES ($1, $2, 'Old lease', 'original_lease', 'voided') RETURNING id`, [co.landlordId, co.unitId])).rows[0]
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
         VALUES ($1, $2, 'primary', 'Ex Ample', $3, 1, $4, 'sent')`,
        [d.id, x.userId, x.email, crypto.randomBytes(32).toString('hex')])
    } },
  ]

  for (const t of ties) {
    it(`B can't re-address or rename A's person when their only tie to A is ${t.name}`, async () => {
      const a = await company()
      const b = await company()
      const x = await resident()
      await t.seed(a, x)
      const bIntent = await intentFor(b, x.tenantId)
      const before = await usersRow(x.userId)

      const res = await edit(b, bIntent, { email: 'attacker@evil.test', resend: true })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/another company/)
      const renamed = await edit(b, bIntent, { lastName: 'Mallory' })
      expect(renamed.status).toBe(409)
      expect(await usersRow(x.userId)).toEqual(before)
      noEmail()
    })
  }

  it("the same ties to the landlord's own company don't stop a correction", async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    for (const t of ties) await t.seed(a, x)
    const intent = await intentFor(a, x.tenantId)

    const res = await edit(a, intent, { email: 'Right.Address@Example.test', resend: false })
    expect(res.status).toBe(200)
    expect((await usersRow(x.userId)).email).toBe('right.address@example.test')
  })

  it('reads every table the round-8 finding named, from the schema itself', async () => {
    const sources = await companyTieSources()
    for (const s of [
      'background_checks.user_id', 'background_checks.tenant_id', 'tenant_one_off_charges.tenant_id',
      'invoices.tenant_id', 'documents.tenant_id', 'work_trade_agreements.tenant_id',
      'tenant_credits.tenant_id', 'unit_bookings.tenant_id', 'pos_pay_links.tenant_id',
      'pos_open_tickets.tenant_id', 'home_sale_contracts.tenant_id', 'maintenance_requests.tenant_id',
      'deposit_returns.tenant_id', 'pending_tenant_intents.tenant_id', 'pending_lease_drafts.tenant_user_id',
      'utility_service_agreements.tenant_id', 'payments.tenant_id', 'notifications.user_id',
      'lease_tenants.tenant_id > leases', 'lease_document_signers.user_id > lease_documents',
      'work_trade_logs.tenant_id > work_trade_agreements',
    ]) expect(sources).toContain(s)
  })
})

// ── S654 (round 8): a changed address takes the old signing links with it ────
//
// Reproduced in round 8: the landlord corrected a mistyped address. The seats
// moved to the new address, but their signing tokens did not change, so the
// link already mailed to the typo still signed as the resident (S629: a
// signing link needs no password). A voided packet document's old link was
// forwarded to its replacement, so voiding and redrafting did not help either.
describe('S654: PATCH /me/pending-intents/:id/contact, a changed address gives every unsigned seat a new link', () => {
  const edit = (co: Company, intentId: string, body: any) =>
    request(buildApp()).patch(`/api/landlords/me/pending-intents/${intentId}/contact`)
      .set('Authorization', `Bearer ${co.token}`).send(body)
  const hex = () => crypto.randomBytes(32).toString('hex')

  /** co's document with x's seat; returns the document and x's seat token. */
  async function seat(co: Company, x: { userId: string; email: string }, o: {
    type?: string; status?: string; seatStatus?: string; landlordSigned?: boolean
    group?: string; order?: number
  } = {}) {
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, package_group_id, package_sort_order)
       VALUES ($1, $2, 'Doc', $3, $4, $5, $6) RETURNING id`,
      [co.landlordId, co.unitId, o.type ?? 'original_lease', o.status ?? 'in_progress',
       o.group ?? null, o.order ?? null])).rows[0]
    const token = hex()
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1, $2, 'landlord', 'L L', 'l@test.dev', 1, $3, $4),
              ($1, $5, 'primary', 'Ex Ample', $6, 2, $7, $8)`,
      [d.id, co.userId, hex(), o.landlordSigned === false ? 'pending' : 'signed',
       x.userId, x.email, token, o.seatStatus ?? 'sent'])
    return { docId: d.id, token }
  }
  const tokenOf = async (docId: string, userId: string) => (await db.query<{ token: string }>(
    `SELECT token FROM lease_document_signers WHERE document_id=$1 AND user_id=$2`, [docId, userId])).rows[0].token

  it('the links mailed to the old address stop working, voided packet documents and signed seats included', async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)
    const group = randomUUID()
    const lease = await seat(a, x, { status: 'pending', seatStatus: 'pending', landlordSigned: false, group, order: 0 })
    const addendum = await seat(a, x, { type: 'work_trade_addendum', status: 'pending', seatStatus: 'pending', landlordSigned: false, group, order: 1 })
    // Re-drafted: the old copy is voided and its link forwards to the new one.
    const voided = await seat(a, x, { type: 'general_contract', status: 'voided', group, order: 2 })
    const redraft = await seat(a, x, { type: 'general_contract', status: 'pending', seatStatus: 'pending', landlordSigned: false, group, order: 2 })
    const signed = await seat(a, x, { type: 'general_contract', seatStatus: 'signed' })
    const landlordTokens = (await db.query(
      `SELECT token FROM lease_document_signers WHERE user_id=$1 ORDER BY token`, [a.userId])).rows

    const res = await edit(a, intent, { email: 'right.address@example.test', resend: false })
    expect(res.status).toBe(200)

    const app = buildApp()
    for (const d of [lease, addendum, voided, redraft]) {
      const now = await tokenOf(d.docId, x.userId)
      expect(now).toMatch(/^[0-9a-f]{64}$/)
      expect(now).not.toBe(d.token)
      expect((await request(app).get(`/api/esign/sign/${d.token}`)).status).toBe(404)
      expect((await request(app).post(`/api/esign/sign/${d.token}`).send({ fieldValues: [] })).status).toBe(404)
    }
    // S654 (review): a signed seat's old link is retired too — a voided packet
    // forwards it to the redraft, and a signed page hands out sibling links.
    // The signed document stays signed and readable from the portal.
    expect(await tokenOf(signed.docId, x.userId)).not.toBe(signed.token)
    expect((await request(app).get(`/api/esign/sign/${signed.token}`)).status).toBe(404)
    // The landlord's own seats are not theirs to change.
    expect((await db.query(
      `SELECT token FROM lease_document_signers WHERE user_id=$1 ORDER BY token`, [a.userId])).rows).toEqual(landlordTokens)
  })

  it('a correction also kills the password and verify keys mailed to the old address', async () => {
    const a = await company()
    const x = await resident({ token: 'old-link' })
    const intent = await intentFor(a, x.tenantId)
    await db.query(
      `UPDATE users SET reset_token = 'reset-to-typo-inbox', reset_token_expires = NOW() + INTERVAL '1 hour',
                        email_verify_token = 'verify-typo', pending_email = 'other@example.test',
                        pending_email_token = 'pending-typo', pending_email_expires_at = NOW() + INTERVAL '1 day'
        WHERE id = $1`, [x.userId])

    const res = await edit(a, intent, { email: 'right.address@example.test', resend: false })
    expect(res.status).toBe(200)
    const row = (await db.query(
      `SELECT reset_token, reset_token_expires, email_verify_token, email_verify_token_expires_at,
              pending_email, pending_email_token, pending_email_expires_at, tenant_invite_token
         FROM users WHERE id=$1`, [x.userId])).rows[0]
    expect(Object.values(row).every(v => v === null)).toBe(true)
  })

  it('a re-send to the same address leaves every link as it was', async () => {
    const a = await company()
    const x = await resident({ token: 'own-link' })
    const intent = await intentFor(a, x.tenantId)
    const lease = await seat(a, x, { status: 'pending', seatStatus: 'pending', landlordSigned: false })

    const res = await edit(a, intent, { email: x.email.toUpperCase(), resend: true })
    expect(res.status).toBe(200)
    expect(await tokenOf(lease.docId, x.userId)).toBe(lease.token)
    expect((await usersRow(x.userId)).tenant_invite_token).toBe('own-link')
  })
})
