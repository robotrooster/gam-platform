/**
 * PASSKEY ENDPOINTS.
 *
 * 10/30 (Nic): "a passkey replaces the emailed code; password + code stays the
 * fallback." The verification lives in services/passkeys.ts and the session is
 * built by routes/auth.ts sessionFromPasskey — this file is the doors.
 *
 *   POST /api/auth/passkey/sign-in/options   no auth. A challenge, and nothing
 *                                            about who is arriving: a
 *                                            discoverable key means the person
 *                                            types nothing at all.
 *   POST /api/auth/passkey/sign-in           no auth. The signed response, in
 *                                            exchange for a full session.
 *   POST /api/auth/passkey/options           signed in. A challenge to add this
 *                                            device.
 *   POST /api/auth/passkey                   signed in. Saves the new device.
 *   GET  /api/auth/passkey                   signed in. The list, for settings.
 *   DELETE /api/auth/passkey/:id             signed in. Removes one device.
 *
 * The sign-in pair is unauthenticated BY DESIGN and is the one surface here
 * that hands out a session, so it carries the whole weight of the checks in
 * services/passkeys.ts: a one-use challenge spent server-side, GAM's own
 * origins, the relying-party id, the signature against the stored public key,
 * and a sign count that has to advance.
 */
import { Router } from 'express'
import { z } from 'zod'
import { SIGN_IN_PORTAL_VALUES } from '@gam/shared'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { queryOne } from '../db'
import {
  passkeyRegistrationOptions, savePasskeyRegistration,
  passkeySignInOptions, verifyPasskeySignIn,
  listPasskeys, removePasskey, type StoredPasskey,
} from '../services/passkeys'
import { sessionFromPasskey } from './auth'

export const passkeysRouter = Router()

// The browser's own response object, passed through to the verifier. Shape-
// checked only as far as this file needs to read it (the clientDataJSON, and
// the credential id that says who is signing in); everything inside is the
// verifier's business and is checked cryptographically there, so a deep schema
// here would be a second, weaker copy of that.
const webauthnResponse = z.object({
  id: z.string().min(1).max(1000),
  rawId: z.string().min(1).max(1000),
  type: z.string().max(64),
  response: z.object({ clientDataJSON: z.string().min(1).max(8000) }).passthrough(),
}).passthrough()

/**
 * A name for a device nobody has named yet. The settings list has to be
 * removable by a human who recognises the row, and "credential
 * AYg3K..." is not that — so a blank name becomes the kind of device this is,
 * which the person can rename later.
 */
function deviceNameFromUserAgent(ua: string | undefined): string {
  const s = String(ua ?? '')
  if (/iPhone/i.test(s)) return 'iPhone'
  if (/iPad/i.test(s)) return 'iPad'
  if (/Android/i.test(s)) return 'Android phone'
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac'
  if (/Windows/i.test(s)) return 'Windows PC'
  return 'This device'
}

/** What settings shows for one device. The public key never leaves the server. */
function publicShape(p: StoredPasskey) {
  return {
    id: p.id,
    deviceName: p.device_name,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    // Synced to a keychain or bound to this one device — the answer to "can I
    // still get in if I lose the phone".
    backedUp: p.backed_up,
    transports: p.transports,
  }
}

// ── Sign in with a passkey ───────────────────────────────────────────────────

passkeysRouter.post('/sign-in/options', async (req, res, next) => {
  try {
    res.json({ success: true, data: await passkeySignInOptions(req.get('origin')) })
  } catch (e) { next(e) }
})

const signInSchema = z.object({
  response: webauthnResponse,
  // S650: which console this sign-in came from, so a passkey obeys the same
  // "this sign-in is for staff accounts" gate a password does.
  portal: z.enum(SIGN_IN_PORTAL_VALUES).optional(),
  // S655: the same fixed-length-or-renewing choice the password form offers.
  keepSignedIn: z.boolean().optional(),
})

passkeysRouter.post('/sign-in', async (req, res, next) => {
  try {
    const body = signInSchema.parse(req.body)
    const { userId } = await verifyPasskeySignIn({
      response: body.response as any,
      requestOrigin: req.get('origin'),
    })
    const session = await sessionFromPasskey(userId, {
      portal: body.portal ?? null,
      keepSignedIn: body.keepSignedIn,
    })
    res.json({ success: true, data: session })
  } catch (e) { next(e) }
})

// ── Add / list / remove a device (signed in) ─────────────────────────────────

passkeysRouter.post('/options', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId as string
    const user = await queryOne<{ id: string; email: string; first_name: string | null; last_name: string | null }>(
      `SELECT id, email, first_name, last_name FROM users WHERE id = $1`, [userId])
    if (!user) throw new AppError(404, 'Account not found')
    res.json({ success: true, data: await passkeyRegistrationOptions({
      id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name,
    }, req.get('origin')) })
  } catch (e) { next(e) }
})

const addSchema = z.object({
  response: webauthnResponse,
  deviceName: z.string().trim().max(60).optional(),
})

passkeysRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = addSchema.parse(req.body)
    const saved = await savePasskeyRegistration({
      userId: (req as any).user.userId,
      response: body.response as any,
      deviceName: body.deviceName || deviceNameFromUserAgent(req.get('user-agent')),
      requestOrigin: req.get('origin'),
    })
    res.json({ success: true, data: publicShape(saved) })
  } catch (e) { next(e) }
})

passkeysRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await listPasskeys((req as any).user.userId)
    res.json({ success: true, data: rows.map(publicShape) })
  } catch (e) { next(e) }
})

passkeysRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id)
    await removePasskey((req as any).user.userId, id)
    res.json({ success: true })
  } catch (e) { next(e) }
})
