/**
 * PASSKEYS — THE SERVER HALF.
 *
 * 10/30 (Nic): "a passkey replaces the emailed code; password + code stays the
 * fallback." Face ID or Touch ID alone completes a sign-in. The emailed-code
 * path (routes/emailOtp.ts) is untouched and remains the way in for everybody
 * without a registered device.
 *
 * Two directions, six endpoints, in routes/passkeys.ts:
 *   register   — the person is already signed in and adds this device.
 *   sign in    — nobody has said who they are. The response carries a
 *                credential id, and THAT says who is arriving.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, and what it refuses:
 *
 *   the challenge   issued here, stored in webauthn_challenges, and SPENT in a
 *                   single UPDATE. A WebAuthn signature only proves anything
 *                   because the number signed was picked by the server a
 *                   moment ago; if the same number answers twice, a captured
 *                   response is a working sign-in. A replay and a challenge
 *                   nobody ever issued are told apart, because they are
 *                   different facts.
 *   the origin      the page the response came from, checked against GAM's own
 *                   portals. A signature made for somebody else's site is not
 *                   a sign-in here.
 *   the rp id       the domain the key was made against. One apex in
 *                   production, so a passkey registered in the landlord portal
 *                   also opens the register and the tenant portal.
 *   the signature   verified against the stored public key. GAM holds no
 *                   private key; there is nothing in user_passkeys to steal and
 *                   sign with.
 *   the sign count  a response that does not advance the authenticator's own
 *                   counter is a replay or a clone, and the verifier refuses
 *                   it. Apple's passkeys always report 0 and the spec answers
 *                   that by skipping the comparison when both sides are 0 — a
 *                   key is not locked out by its own honesty.
 *
 * ⚠️ THE ON-DEVICE HALF IS UNPROVEN. There is no authenticator on the build
 * machine, so what is tested here is the verification: real P-256 signatures
 * over real CBOR, checked by the real verifier (routes/passkeys.test.ts). That
 * a phone's Face ID prompt reaches this code correctly needs Nic with a real
 * phone.
 */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

/** How long a person has to touch the sensor before the challenge is stale. */
const CHALLENGE_TTL_MINUTES = 5

export interface StoredPasskey {
  id: string
  user_id: string
  credential_id: string
  public_key: Buffer
  sign_count: string          // bigint arrives as a string from pg
  transports: string[] | null
  device_name: string
  backed_up: boolean
  rp_id: string
  created_at: Date
  last_used_at: Date | null
}

/**
 * THE RELYING PARTY: which domain a passkey belongs to, and which pages may
 * answer for it.
 *
 * ONE rp id per environment, not one per portal. In production every portal is
 * a subdomain of the apex (index.ts CORS), so the apex is the rp id and a key
 * registered in the landlord portal also opens the register, GAM Books and the
 * tenant portal. Per-portal rp ids would mean registering Face ID separately
 * on each one, which is the friction this feature removes.
 *
 * It is taken from THE PAGE THAT ASKED, once that page is known to be one of
 * GAM's, and not from the portal URLs in the API's env. Those env vars hold
 * the PRODUCTION addresses even on a dev machine, so deriving the rp id from
 * them gave 'goldassetmanagement.com' to a browser sitting on
 * http://localhost:3001 — and a key can only be made for the domain the page
 * is actually on, so no passkey could ever be registered in development. The
 * browser itself refuses an rp id that is not a suffix of the page's own
 * origin, and the origin is checked against GAM's list before it is trusted
 * for anything, so reading it from the request is both safe and the only way
 * this works in more than one environment.
 *
 * user_passkeys.rp_id records which domain each key was made for, so a
 * database copied between environments cannot offer keys that could never
 * answer. PASSKEY_RP_ID overrides the lot for a staging domain that is
 * neither localhost nor the apex.
 */
export function relyingParty(requestOrigin?: string | null): { rpId: string; origins: string[] } {
  const origins = new Set(knownPortalOrigins())
  const fromRequest = requestOrigin && isGamOrigin(requestOrigin) ? requestOrigin : null
  // Added only after the check above — echoing back whatever the caller claimed
  // would make the origin check approve itself.
  if (fromRequest) origins.add(fromRequest)

  const explicit = process.env.PASSKEY_RP_ID?.trim()
  if (explicit) return { rpId: explicit, origins: [...origins] }

  const host = fromRequest ? hostnameOf(fromRequest) : null
  return { rpId: host ? rpIdForHost(host) : (prodApex() ?? 'localhost'), origins: [...origins] }
}

/** The portals this API serves, as index.ts allowlists them for CORS. */
function knownPortalOrigins(): string[] {
  const fromEnv = [
    process.env.LANDLORD_APP_URL, process.env.TENANT_APP_URL, process.env.ADMIN_APP_URL,
    process.env.POS_APP_URL, process.env.BOOKS_APP_URL, process.env.ADMIN_OPS_APP_URL,
    process.env.BUSINESS_APP_URL, process.env.PM_COMPANY_APP_URL, process.env.CUSTOMER_PORTAL_URL,
  ].filter((u): u is string => !!u)
  // The local dev portals, as index.ts allowlists them unconditionally: a
  // localhost origin cannot be forged by a remote site. The 31xx ports are the
  // preview duplicates (S536).
  const dev = [3001, 3002, 3003, 3005, 3006, 3009, 3011, 3012, 3014,
               3101, 3102, 3103, 3105, 3106].map(p => `http://localhost:${p}`)
  return [...fromEnv, ...dev]
}

function hostnameOf(origin: string): string | null {
  try { return new URL(origin).hostname } catch { return null }
}

/** The apex GAM's production portals sit under, or null on a machine with none configured. */
function prodApex(): string | null {
  for (const raw of [process.env.LANDLORD_APP_URL, process.env.TENANT_APP_URL, process.env.ADMIN_APP_URL]) {
    const host = raw ? hostnameOf(raw) : null
    if (host && !isLocalHostname(host)) return registrableApex(host)
  }
  return null
}

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
}

/** goldassetmanagement.com from landlord.goldassetmanagement.com. */
function registrableApex(host: string): string {
  const parts = host.split('.')
  return parts.length > 2 ? parts.slice(-2).join('.') : host
}

function rpIdForHost(host: string): string {
  // A dev page on 127.0.0.1 is still 'localhost' as far as a key is concerned:
  // an rp id must be a domain, never an address.
  return isLocalHostname(host) ? 'localhost' : registrableApex(host)
}

/**
 * One of GAM's own pages: a configured portal, a local dev portal, or any
 * subdomain of the production apex (a new portal subdomain needs no env var,
 * exactly as in the CORS check).
 */
function isGamOrigin(origin: string): boolean {
  if (knownPortalOrigins().includes(origin)) return true
  const host = hostnameOf(origin)
  if (!host) return false
  if (isLocalHostname(host)) return origin.startsWith('http://')
  const apex = prodApex()
  if (!apex) return false
  return origin.startsWith('https://') && (host === apex || host.endsWith('.' + apex))
}

// ── Challenges ───────────────────────────────────────────────────────────────

async function storeChallenge(
  challenge: string, purpose: 'register' | 'authenticate', userId: string | null, rpId: string,
): Promise<void> {
  await query(
    `INSERT INTO webauthn_challenges (challenge, purpose, user_id, rp_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
    [challenge, purpose, userId, rpId, String(CHALLENGE_TTL_MINUTES)],
  )
  // A SIGN-IN PAGE ISSUES ONE OF THESE PER VISIT. The browser's autofill offer
  // (conditional mediation) has to ask for options before it can show the key
  // in the email field's list, so every load of a public sign-in page writes a
  // row here whether or not anybody uses it — bots included. Nothing else
  // would ever delete them.
  //
  // A week, not five minutes: a challenge can only be SPENT while it is live,
  // but a consumed row is what makes a replay read as a replay instead of as a
  // challenge nobody issued, and that distinction is worth keeping long enough
  // to be useful when somebody asks. Fire-and-forget, on the expires_at index;
  // a failed tidy-up must never cost somebody their sign-in.
  query(`DELETE FROM webauthn_challenges WHERE expires_at < NOW() - interval '7 days'`)
    .catch(err => logger.warn({ err }, '[passkeys] old challenges not tidied up'))
}

/**
 * The challenge a browser response says it answered. Read out of the signed
 * clientDataJSON rather than taken as a separate field from the caller: the
 * nonce IS the lookup, so letting the client name which row to spend would put
 * the choice back in its hands.
 */
export function challengeFromClientData(clientDataJSON: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'))
  } catch {
    throw new AppError(400, 'That sign-in response could not be read. Please try again.')
  }
  const challenge = typeof parsed?.challenge === 'string' ? parsed.challenge : ''
  if (!challenge) throw new AppError(400, 'That sign-in response carried no challenge. Please try again.')
  return challenge
}

/**
 * Spend a challenge, or say why it cannot be spent. One UPDATE does the
 * claiming, so two responses racing with the same challenge cannot both win.
 *
 * The three refusals are deliberately different sentences. A replay is an
 * attack or a double-tap; an expired challenge is somebody who left the phone
 * on the table; an unknown one is a response for a challenge this server never
 * issued. Collapsing them into "invalid" would have cost real time the first
 * time one happened.
 */
export async function consumeChallenge(
  challenge: string, purpose: 'register' | 'authenticate',
): Promise<{ id: string; user_id: string | null }> {
  const claimed = await queryOne<{ id: string; user_id: string | null }>(
    `UPDATE webauthn_challenges SET consumed_at = NOW()
      WHERE challenge = $1 AND purpose = $2
        AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id, user_id`,
    [challenge, purpose],
  )
  if (claimed) return claimed

  const existing = await queryOne<{ consumed_at: Date | null }>(
    `SELECT consumed_at FROM webauthn_challenges WHERE challenge = $1 AND purpose = $2`,
    [challenge, purpose],
  )
  if (existing?.consumed_at) {
    throw new AppError(401, 'That sign-in has already been used. Please try again.')
  }
  if (existing) {
    throw new AppError(401, 'That took too long and the sign-in expired. Please try again.')
  }
  throw new AppError(401, 'This sign-in session is not one GAM issued. Please try again.')
}

// ── Registration (the person is signed in and is adding this device) ─────────

export async function passkeyRegistrationOptions(user: {
  id: string; email: string; firstName?: string | null; lastName?: string | null
}, requestOrigin?: string | null) {
  const { rpId } = relyingParty(requestOrigin)
  const existing = await listPasskeys(user.id)
  const options = await generateRegistrationOptions({
    rpName: 'Gold Asset Management',
    rpID: rpId,
    userName: user.email,
    userDisplayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    // The id the authenticator stores alongside the key. The account's own id,
    // so a key found on the device resolves to one account and not to whichever
    // row an email happens to point at today.
    userID: Buffer.from(user.id, 'utf8'),
    attestationType: 'none',
    // Already registered on this device? Then the browser says so instead of
    // quietly making a second key that shadows the first.
    excludeCredentials: existing.map(p => ({
      id: p.credential_id,
      transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      // residentKey required is what makes "Face ID alone signs you in"
      // possible: the key is discoverable, so the sign-in needs no email typed
      // first. userVerification required is the second factor — the device
      // alone must not be enough.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
  })
  await storeChallenge(options.challenge, 'register', user.id, rpId)
  return options
}

export async function savePasskeyRegistration(opts: {
  userId: string
  response: RegistrationResponseJSON
  deviceName: string
  requestOrigin?: string | null
}): Promise<StoredPasskey> {
  const challenge = challengeFromClientData(opts.response.response.clientDataJSON)
  const claimed = await consumeChallenge(challenge, 'register')
  // The challenge was issued to ONE account. A response from a different
  // session must not register a key against the account that asked.
  if (claimed.user_id !== opts.userId) {
    throw new AppError(401, 'This sign-in session is not one GAM issued. Please try again.')
  }

  const { rpId, origins } = relyingParty(opts.requestOrigin)
  let verified
  try {
    verified = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
    })
  } catch (err) {
    logger.warn({ err, userId: opts.userId }, '[passkeys] registration response rejected')
    throw new AppError(400, 'That device could not be added. Please try again.')
  }
  if (!verified.verified || !verified.registrationInfo) {
    throw new AppError(400, 'That device could not be added. Please try again.')
  }

  const { credential, credentialBackedUp } = verified.registrationInfo
  const row = await queryOne<StoredPasskey>(
    `INSERT INTO user_passkeys
       (user_id, credential_id, public_key, sign_count, transports, device_name, backed_up, rp_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      opts.userId, credential.id, Buffer.from(credential.publicKey), credential.counter,
      credential.transports ?? opts.response.response.transports ?? null,
      opts.deviceName.trim(), credentialBackedUp, rpId,
    ],
  )
  if (!row) throw new AppError(500, 'That device could not be added. Please try again.')
  return row
}

// ── Sign-in (nobody has said who they are) ───────────────────────────────────

export async function passkeySignInOptions(requestOrigin?: string | null) {
  const { rpId } = relyingParty(requestOrigin)
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    // No allowCredentials: the whole point is that the browser offers whatever
    // key it holds for this domain, so a phone can sign in with nothing typed.
    userVerification: 'required',
  })
  await storeChallenge(options.challenge, 'authenticate', null, rpId)
  return options
}

/**
 * Verify a sign-in response and say which account it belongs to. Mints no
 * session — that is routes/auth.ts sessionFromPasskey's job, because a session
 * is built from the account's scopes and must be built the same way whichever
 * factor opened the door.
 */
export async function verifyPasskeySignIn(opts: {
  response: AuthenticationResponseJSON
  requestOrigin?: string | null
}): Promise<{ userId: string; passkeyId: string }> {
  const { rpId, origins } = relyingParty(opts.requestOrigin)
  const challenge = challengeFromClientData(opts.response.response.clientDataJSON)
  await consumeChallenge(challenge, 'authenticate')

  // The credential id is the identity: it arrived with the response, and until
  // now GAM had not been told who was signing in.
  const stored = await queryOne<StoredPasskey>(
    `SELECT * FROM user_passkeys WHERE credential_id = $1`, [opts.response.id])
  if (!stored) {
    // Said plainly rather than as "invalid": a passkey that GAM does not know
    // is usually a key whose account was removed, or a key made against a
    // different environment — and the person needs to be told to use the
    // password, not left guessing.
    throw new AppError(401, 'GAM does not recognise that passkey. Sign in with your password instead.')
  }
  if (stored.rp_id !== rpId) {
    throw new AppError(401, 'That passkey was set up for a different GAM address. Sign in with your password instead.')
  }

  let verified
  try {
    verified = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.public_key),
        counter: Number(stored.sign_count),
        transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    })
  } catch (err) {
    // The decreasing-sign-count refusal lands here too: the verifier throws
    // rather than returning false, because a counter that went backwards means
    // a cloned or replayed key and not a typo.
    logger.warn({ err, passkeyId: stored.id }, '[passkeys] sign-in response rejected')
    throw new AppError(401, 'That passkey could not be verified. Sign in with your password instead.')
  }
  if (!verified.verified) {
    throw new AppError(401, 'That passkey could not be verified. Sign in with your password instead.')
  }

  // The counter only ever moves forward (the CHECK on the column says the same
  // thing), so a late response that carries an older count cannot walk it back.
  await query(
    `UPDATE user_passkeys
        SET sign_count = GREATEST(sign_count, $2::bigint), last_used_at = NOW()
      WHERE id = $1`,
    [stored.id, verified.authenticationInfo.newCounter],
  )
  return { userId: stored.user_id, passkeyId: stored.id }
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function listPasskeys(userId: string): Promise<StoredPasskey[]> {
  return query<StoredPasskey>(
    `SELECT * FROM user_passkeys WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
}

export async function removePasskey(userId: string, passkeyId: string): Promise<void> {
  const gone = await query(
    `DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2 RETURNING id`,
    [passkeyId, userId])
  if (!gone.length) throw new AppError(404, 'That passkey is not on your account.')
}
