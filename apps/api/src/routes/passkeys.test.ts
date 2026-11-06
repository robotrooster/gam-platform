/**
 * PASSKEYS — THE SERVER HALF.
 *
 * Run (the passkey migrations are not on production yet):
 *   cd apps/api && DB_NAME=gam_test TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *     npx vitest run src/routes/passkeys.test.ts
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ──────────────────────────────────────────
 *
 * There is no authenticator on a build machine: no Face ID, no security key,
 * nothing that will produce a WebAuthn signature. So what signs these
 * responses is a REAL P-256 key pair from node:crypto, over REAL CBOR, and the
 * production code path verifies it with the real @simplewebauthn verifier —
 * nothing in services/passkeys.ts or routes/passkeys.ts is mocked or bypassed.
 * That is the only way to assert on a good signature at all, and it is what
 * makes the refusals below meaningful: each one is a single deliberate change
 * to an otherwise valid response.
 *
 * It proves the VERIFICATION. It does not prove that a phone's Face ID prompt
 * reaches it correctly — that needs Nic with a real phone, and is stated as
 * unproven in the handoff rather than implied by a green suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

// Capture the emailed 2FA code instead of sending it (the fallback-path test).
const sentCodes: string[] = []
vi.mock('../services/email', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, emailLoginCode: vi.fn(async (_to: string, code: string) => { sentCodes.push(code); return 'msg_mock' }) }
})

import { passkeysRouter } from './passkeys'
import { relyingParty } from '../services/passkeys'
import { authRouter } from './auth'
import { emailOtpRouter } from './emailOtp'

const RP_ID  = 'localhost'
const ORIGIN = 'http://localhost:3001'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/auth/email-otp', emailOtpRouter)
  app.use('/api/auth/passkey', passkeysRouter)
  app.use(errorHandler)
  return app
}

// ── A SOFT AUTHENTICATOR ─────────────────────────────────────────────────────
//
// Just enough CBOR to build what a real authenticator sends: definite lengths,
// and map keys written in the order COSE and the WebAuthn attestation object
// use. Not a general encoder — a general one is a dependency, and this needs
// four types.

/** Join byte arrays. node:crypto hands back a differently-typed Buffer from
 *  Buffer.alloc, and Buffer.concat insists the two are the same; one helper
 *  taking plain byte arrays keeps the builders below readable. */
function bytes(...parts: Uint8Array[]): Buffer {
  const out = Buffer.alloc(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b
}
/** CBOR integer: unsigned (major 0) or negative (major 1, stored as -1-n). */
const cborInt   = (n: number) => n >= 0 ? cborHead(0, n) : cborHead(1, -n - 1)
const cborBytes = (b: Uint8Array) => bytes(cborHead(2, b.length), b)
const cborText  = (t: string) => { const b = Buffer.from(t, 'utf8'); return bytes(cborHead(3, b.length), b) }
const cborMap   = (entries: Array<[Uint8Array, Uint8Array]>) =>
  bytes(cborHead(5, entries.length), ...entries.flatMap(e => e))

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | string) => Buffer.from(crypto.createHash('sha256').update(b).digest())

/** One registered device: a real P-256 key pair and its own credential id. */
function makeAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  // COSE_Key for ES256: kty EC2, alg -7, crv P-256, then the point.
  const cose = cborMap([
    [cborInt(1),  cborInt(2)],
    [cborInt(3),  cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
    [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
  ])
  return { privateKey, cose, credentialId: Buffer.from(crypto.randomBytes(32)) }
}
type Authenticator = ReturnType<typeof makeAuthenticator>

/** rpIdHash || flags || signCount [|| attested credential data]. */
function authenticatorData(opts: {
  signCount: number
  rpId?: string
  attested?: { credentialId: Uint8Array; cose: Uint8Array }
}): Buffer {
  // UP (present) | UV (verified) | BE (backup eligible) | BS (backed up), plus
  // AT when attested credential data follows.
  const flags = 0x01 | 0x04 | 0x08 | 0x10 | (opts.attested ? 0x40 : 0)
  const counter = Buffer.alloc(4); counter.writeUInt32BE(opts.signCount)
  const parts: Uint8Array[] = [sha256(opts.rpId ?? RP_ID), Buffer.from([flags]), counter]
  if (opts.attested) {
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(opts.attested.credentialId.length)
    // aaguid is all zeros for 'none' attestation, as a platform key sends it.
    parts.push(Buffer.alloc(16), idLen, opts.attested.credentialId, opts.attested.cose)
  }
  return bytes(...parts)
}

function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = ORIGIN) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')
}

function registrationResponse(a: Authenticator, challenge: string, origin = ORIGIN) {
  const cd = clientDataJSON('webauthn.create', challenge, origin)
  const attestationObject = cborMap([
    [cborText('fmt'),      cborText('none')],
    [cborText('attStmt'),  cborMap([])],
    [cborText('authData'), cborBytes(authenticatorData({ signCount: 0, attested: a }))],
  ])
  return {
    id: b64u(a.credentialId), rawId: b64u(a.credentialId), type: 'public-key',
    response: {
      clientDataJSON: b64u(cd),
      attestationObject: b64u(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  }
}

function assertionResponse(a: Authenticator, challenge: string, opts?: {
  signCount?: number; origin?: string; rpId?: string
}) {
  const cd = clientDataJSON('webauthn.get', challenge, opts?.origin)
  const ad = authenticatorData({ signCount: opts?.signCount ?? 1, rpId: opts?.rpId })
  // ES256 over authenticatorData || SHA-256(clientDataJSON), ASN.1 DER — what
  // WebAuthn specifies and what the verifier checks.
  const signature = crypto.sign('sha256', bytes(ad, sha256(cd)), a.privateKey)
  return {
    id: b64u(a.credentialId), rawId: b64u(a.credentialId), type: 'public-key',
    response: {
      clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(signature),
    },
    clientExtensionResults: {},
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function seedPerson() {
  const email = `pk-${randomUUID()}@test.dev`
  const pw = 'PasskeyPass1234!'
  const id = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name,
                        email_verified, totp_enabled, email_2fa_enabled)
     VALUES ($1,$2,'super_admin','Pass','Key',TRUE,FALSE,TRUE) RETURNING id`,
    [email, await bcrypt.hash(pw, 10)]
  )).rows[0].id
  return { id, email, pw }
}

const sessionToken = (userId: string, email: string) => jwt.sign(
  { userId, role: 'super_admin', email, profileId: null, landlordId: null, permissions: null },
  process.env.JWT_SECRET!, { expiresIn: '10m' })

/** Register a device the way the portal does: options, then the response. */
async function registerPasskey(app: express.Express, person: { id: string; email: string }, deviceName?: string) {
  const a = makeAuthenticator()
  const opts = await request(app).post('/api/auth/passkey/options')
    .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
  expect(opts.status).toBe(200)
  const saved = await request(app).post('/api/auth/passkey')
    .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    .send({ response: registrationResponse(a, opts.body.data.challenge), deviceName })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  return { authenticator: a, passkeyId: saved.body.data.id as string }
}

/** Wait (briefly) for something written fire-and-forget to land. */
async function waitFor(ok: () => Promise<boolean>, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await ok()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return false
}

/** A fresh sign-in challenge. */
async function signInChallenge(app: express.Express): Promise<string> {
  const r = await request(app).post('/api/auth/passkey/sign-in/options')
  expect(r.status).toBe(200)
  return r.body.data.challenge as string
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query('DELETE FROM login_email_otps')
  sentCodes.length = 0
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_passkeys'
  // The rp id a passkey belongs to, stated rather than inferred from whichever
  // portal URLs this machine's env happens to carry.
  process.env.PASSKEY_RP_ID = RP_ID
})

// ── Registration ─────────────────────────────────────────────────────────────

describe('adding a device', () => {
  it('offers a discoverable, user-verifying key and stores it under a name', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const opts = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    expect(opts.status).toBe(200)
    // residentKey required is what makes "Face ID alone signs you in" possible;
    // userVerification required is the factor that makes it a sign-in and not
    // just a device.
    expect(opts.body.data.authenticatorSelection.residentKey).toBe('required')
    expect(opts.body.data.authenticatorSelection.userVerification).toBe('required')
    expect(opts.body.data.rp.id).toBe(RP_ID)

    const a = makeAuthenticator()
    const saved = await request(app).post('/api/auth/passkey')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
      .send({ response: registrationResponse(a, opts.body.data.challenge), deviceName: "Nic's iPhone" })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.data.deviceName).toBe("Nic's iPhone")
    // Synced to a keychain — the answer to "can I still get in if I lose it".
    expect(saved.body.data.backedUp).toBe(true)

    const list = await request(app).get('/api/auth/passkey')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].lastUsedAt).toBeNull()
    // The public key never leaves the server.
    expect(JSON.stringify(list.body.data)).not.toContain('publicKey')
  })

  it('names the device itself when nobody named it, so the list is removable by a human', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const a = makeAuthenticator()
    const opts = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    const saved = await request(app).post('/api/auth/passkey')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
      .send({ response: registrationResponse(a, opts.body.data.challenge) })
    expect(saved.status).toBe(200)
    expect(saved.body.data.deviceName).toBe('iPhone')
  })

  it('tells the browser which keys are already registered, so a second one cannot shadow the first', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    const again = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    expect(again.body.data.excludeCredentials.map((c: any) => c.id))
      .toContain(b64u(authenticator.credentialId))
  })

  it("will not register a key against the account that did not ask for the challenge", async () => {
    const app = buildApp()
    const asked = await seedPerson()
    const other = await seedPerson()
    const opts = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${sessionToken(asked.id, asked.email)}`)
    const stolen = await request(app).post('/api/auth/passkey')
      .set('Authorization', `Bearer ${sessionToken(other.id, other.email)}`)
      .send({ response: registrationResponse(makeAuthenticator(), opts.body.data.challenge) })
    expect(stolen.status).toBe(401)
    expect((await db.query(`SELECT id FROM user_passkeys`)).rows).toHaveLength(0)
  })

  it('removes a device, and then will not sign in with it', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator, passkeyId } = await registerPasskey(app, person)
    const gone = await request(app).delete(`/api/auth/passkey/${passkeyId}`)
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    expect(gone.status).toBe(200)

    const after = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app)) })
    expect(after.status).toBe(401)
    expect(after.body.error).toMatch(/does not recognise/i)
  })

  it("will not let one account remove another's device", async () => {
    const app = buildApp()
    const owner = await seedPerson()
    const stranger = await seedPerson()
    const { passkeyId } = await registerPasskey(app, owner)
    const tried = await request(app).delete(`/api/auth/passkey/${passkeyId}`)
      .set('Authorization', `Bearer ${sessionToken(stranger.id, stranger.email)}`)
    expect(tried.status).toBe(404)
    expect((await db.query(`SELECT id FROM user_passkeys`)).rows).toHaveLength(1)
  })
})

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe('signing in with a passkey', () => {
  it('a good assertion signs in on its own — no password, no emailed code', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)

    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), { signCount: 7 }) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // A FULL session, not a pending one: this is the whole decision.
    expect(res.body.data.token).toBeTruthy()
    const decoded: any = jwt.verify(res.body.data.token, process.env.JWT_SECRET!)
    expect(decoded.purpose).toBeUndefined()
    expect(decoded.userId).toBe(person.id)
    expect(res.body.data.user.email).toBe(person.email)
    // The passkey IS the second factor; nothing is left to enrol.
    expect(res.body.data.user.mustEnrollTotp).toBe(false)
    // No code was emailed.
    expect(sentCodes).toHaveLength(0)

    const row = (await db.query<{ sign_count: string; last_used_at: Date | null }>(
      `SELECT sign_count, last_used_at FROM user_passkeys WHERE user_id = $1`, [person.id])).rows[0]
    expect(Number(row.sign_count)).toBe(7)
    expect(row.last_used_at).not.toBeNull()
    // And the sign-in is on the record, as a password sign-in is. Written
    // fire-and-forget (routes/auth.ts, same as /login — an analytics row must
    // never hold up or fail a sign-in), so wait for it rather than assume the
    // response beat it.
    const seen = await waitFor(async () => (await db.query<{ meta: any }>(
      `SELECT meta FROM product_events WHERE user_id = $1 AND event = 'login'`, [person.id])
    ).rows.map(e => e.meta?.via).includes('passkey'))
    expect(seen, 'no product_events login row with via=passkey').toBe(true)
  })

  it('refuses a REPLAYED response: the same challenge cannot be answered twice', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    const response = assertionResponse(authenticator, await signInChallenge(app), { signCount: 3 })

    const first = await request(app).post('/api/auth/passkey/sign-in').send({ response })
    expect(first.status).toBe(200)
    const replay = await request(app).post('/api/auth/passkey/sign-in').send({ response })
    expect(replay.status).toBe(401)
    // A replay and a challenge nobody issued are different facts, said differently.
    expect(replay.body.error).toMatch(/already been used/i)
  })

  it('refuses a challenge GAM never issued, and a registration challenge used to sign in', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)

    const invented = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, b64u(Buffer.from(crypto.randomBytes(32)))) })
    expect(invented.status).toBe(401)
    expect(invented.body.error).toMatch(/not one GAM issued/i)

    // A challenge issued for ADDING a device is not a sign-in challenge.
    const reg = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${sessionToken(person.id, person.email)}`)
    const crossed = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, reg.body.data.challenge) })
    expect(crossed.status).toBe(401)
    expect(crossed.body.error).toMatch(/not one GAM issued/i)
  })

  it('refuses a response signed for somebody else\'s site', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)

    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), {
        origin: 'https://gold-asset-managment.example.com',
      }) })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/could not be verified/i)
  })

  it('refuses a response signed for a different relying party', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)

    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), {
        rpId: 'evil.example.com',
      }) })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/could not be verified/i)
  })

  it('refuses a sign count that goes BACKWARDS — a cloned or replayed key', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    // The device has been used ten times.
    await db.query(`UPDATE user_passkeys SET sign_count = 10 WHERE user_id = $1`, [person.id])

    const back = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), { signCount: 5 }) })
    expect(back.status).toBe(401)
    expect(back.body.error).toMatch(/could not be verified/i)
    // Not walked back by the attempt either.
    expect(Number((await db.query<{ sign_count: string }>(
      `SELECT sign_count FROM user_passkeys WHERE user_id = $1`, [person.id])).rows[0].sign_count)).toBe(10)

    // Standing still is the same failure: a counter that does not advance.
    const still = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), { signCount: 10 }) })
    expect(still.status).toBe(401)

    // Moving forward is fine.
    const on = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app), { signCount: 11 }) })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
  })

  it('refuses a credential GAM has never seen, and says to use the password', async () => {
    const app = buildApp()
    await seedPerson()
    const stranger = makeAuthenticator()
    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(stranger, await signInChallenge(app)) })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/does not recognise/i)
    expect(res.body.error).toMatch(/password/i)
  })

  it('a signature from the wrong key is refused even with everything else right', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    // Somebody else's key pair, presented under the registered credential id.
    const imposter = makeAuthenticator()
    const forged = assertionResponse(imposter, await signInChallenge(app))
    forged.id = b64u(authenticator.credentialId)
    forged.rawId = forged.id

    const res = await request(app).post('/api/auth/passkey/sign-in').send({ response: forged })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/could not be verified/i)
  })

  it('the password lockout does not shut a passkey out — five bad passwords cannot lock the owner out of Face ID', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    await db.query(
      `UPDATE users SET failed_login_count = 5, locked_until = NOW() + interval '30 minutes' WHERE id = $1`,
      [person.id])

    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app)) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // The owner is here, so the lockout their password attempts left is cleared.
    const u = (await db.query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM users WHERE id = $1`, [person.id])).rows[0]
    expect(u.failed_login_count).toBe(0)
    expect(u.locked_until).toBeNull()
  })

  it('still demands a proven email address, as the password sign-in does', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    await db.query(`UPDATE users SET email_verified = FALSE WHERE id = $1`, [person.id])

    const res = await request(app).post('/api/auth/passkey/sign-in')
      .send({ response: assertionResponse(authenticator, await signInChallenge(app)) })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/verify your email/i)
  })
})

// ── Which domain a passkey belongs to ────────────────────────────────────────

describe('the relying party', () => {
  const PROD = 'https://landlord.goldassetmanagement.com'
  let savedRpId: string | undefined
  let savedLandlord: string | undefined

  beforeEach(() => {
    savedRpId = process.env.PASSKEY_RP_ID
    savedLandlord = process.env.LANDLORD_APP_URL
    delete process.env.PASSKEY_RP_ID
    // A dev machine's API env holds the PRODUCTION portal addresses, which is
    // exactly the situation that broke local registration.
    process.env.LANDLORD_APP_URL = PROD
  })
  afterEach(() => {
    if (savedRpId === undefined) delete process.env.PASSKEY_RP_ID; else process.env.PASSKEY_RP_ID = savedRpId
    if (savedLandlord === undefined) delete process.env.LANDLORD_APP_URL; else process.env.LANDLORD_APP_URL = savedLandlord
  })

  it('is localhost for a dev page, even when the env names production', () => {
    // A key can only be made for the domain the page is actually on, so taking
    // this from the env gave development an rp id no browser would accept.
    expect(relyingParty('http://localhost:3001').rpId).toBe('localhost')
  })

  it('is the apex for a production portal, so ONE key opens every portal', () => {
    expect(relyingParty('https://pos.goldassetmanagement.com').rpId).toBe('goldassetmanagement.com')
    expect(relyingParty(PROD).rpId).toBe('goldassetmanagement.com')
  })

  it('never trusts an origin that is not GAM\'s, for the domain or for the list', () => {
    const r = relyingParty('https://gold-asset-managment.example.com')
    expect(r.rpId).toBe('goldassetmanagement.com')
    expect(r.origins).not.toContain('https://gold-asset-managment.example.com')
  })

  it('is whatever PASSKEY_RP_ID says, for a staging domain that is neither', () => {
    process.env.PASSKEY_RP_ID = 'staging.gam.example'
    expect(relyingParty('http://localhost:3001').rpId).toBe('staging.gam.example')
  })

  it('registers and signs in end to end on the rp id derived from the page', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const a = makeAuthenticator()
    const tok = sessionToken(person.id, person.email)

    const opts = await request(app).post('/api/auth/passkey/options')
      .set('Authorization', `Bearer ${tok}`).set('Origin', ORIGIN)
    expect(opts.body.data.rp.id).toBe('localhost')
    const saved = await request(app).post('/api/auth/passkey')
      .set('Authorization', `Bearer ${tok}`).set('Origin', ORIGIN)
      .send({ response: registrationResponse(a, opts.body.data.challenge) })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect((await db.query<{ rp_id: string }>(
      `SELECT rp_id FROM user_passkeys WHERE user_id = $1`, [person.id])).rows[0].rp_id).toBe('localhost')

    const ch = await request(app).post('/api/auth/passkey/sign-in/options').set('Origin', ORIGIN)
    const res = await request(app).post('/api/auth/passkey/sign-in').set('Origin', ORIGIN)
      .send({ response: assertionResponse(a, ch.body.data.challenge) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.user.email).toBe(person.email)
  })
})

// ── The challenge log does not grow forever ──────────────────────────────────

describe('old challenges', () => {
  it('are tidied up when a new one is issued, and recent ones are left alone', async () => {
    const app = buildApp()
    // One visit's worth of challenge, aged past a week.
    await signInChallenge(app)
    await db.query(`UPDATE webauthn_challenges SET expires_at = NOW() - interval '8 days'`)
    const stale = (await db.query<{ challenge: string }>(
      `SELECT challenge FROM webauthn_challenges`)).rows[0].challenge
    // A second visit: still live, and the one a replay would be measured against.
    const recent = await signInChallenge(app)

    // The tidy-up is fire-and-forget, so wait for it rather than for a tick.
    await waitFor(async () => !(await db.query(
      `SELECT 1 FROM webauthn_challenges WHERE challenge = $1`, [stale])).rows.length)
    const rows = (await db.query<{ challenge: string }>(`SELECT challenge FROM webauthn_challenges`)).rows
    expect(rows.map(r => r.challenge)).toEqual([recent])
  })

  it('a replay is still a replay days later, not an unknown challenge', async () => {
    const app = buildApp()
    const person = await seedPerson()
    const { authenticator } = await registerPasskey(app, person)
    const response = assertionResponse(authenticator, await signInChallenge(app), { signCount: 2 })
    expect((await request(app).post('/api/auth/passkey/sign-in').send({ response })).status).toBe(200)

    // Three days on: the spent row is still there, so GAM can still say WHICH
    // refusal this is.
    await db.query(`UPDATE webauthn_challenges SET expires_at = NOW() - interval '3 days'`)
    const replay = await request(app).post('/api/auth/passkey/sign-in').send({ response })
    expect(replay.status).toBe(401)
    expect(replay.body.error).toMatch(/already been used/i)
  })
})

// ── The fallback is untouched ────────────────────────────────────────────────

describe('password + emailed code, for everybody without a passkey', () => {
  it('is exactly what it was: a pending session, a code, then a full session', async () => {
    const app = buildApp()
    const person = await seedPerson()
    expect((await db.query(`SELECT id FROM user_passkeys WHERE user_id = $1`, [person.id])).rows).toHaveLength(0)

    const login = await request(app).post('/api/auth/login')
      .send({ email: person.email, password: person.pw })
    expect(login.status).toBe(200)
    expect(login.body.data.requiresEmailOtp).toBe(true)
    expect(login.body.data.token).toBeUndefined()
    expect(sentCodes).toHaveLength(1)

    const verified = await request(app).post('/api/auth/email-otp/verify')
      .send({ emailOtpSession: login.body.data.emailOtpSession, code: sentCodes[0] })
    expect(verified.status).toBe(200)
    expect(verified.body.data.token).toBeTruthy()
  })

  it('a registered passkey does not turn the emailed code off for the password path', async () => {
    // "Password + code stays the fallback" — having a passkey makes the code
    // unnecessary when you use the passkey, not optional when you do not.
    const app = buildApp()
    const person = await seedPerson()
    await registerPasskey(app, person)

    const login = await request(app).post('/api/auth/login')
      .send({ email: person.email, password: person.pw })
    expect(login.status).toBe(200)
    expect(login.body.data.requiresEmailOtp).toBe(true)
    expect(login.body.data.token).toBeUndefined()
  })
})
