/**
 * PASSKEYS — THE BROWSER HALF, ONE COPY FOR EVERY PORTAL.
 *
 * 10/30 (Nic): "a passkey replaces the emailed code; password + code stays the
 * fallback." He could not sign in on his phone — the password lives in Safari's
 * keychain, Chrome on iOS keeps its own vault, and the emailed code then sends
 * him out of the browser to the mail app. Face ID is already two factors, so
 * this signs in on its own.
 *
 * Two pieces, and both of them belong in every portal rather than in one:
 *   <PasskeySignIn>   on a sign-in page. Offers the passkey when the browser
 *                     can do one, and gets out of the way when it cannot.
 *   <PasskeySettings> on an account page. Add this device, see when each one
 *                     was last used, remove one.
 *
 * WHY NOT NATIVE JSON HELPERS: Safari and Chrome now ship
 * PublicKeyCredential.parseCreationOptionsFromJSON and credential.toJSON(),
 * which would delete most of the conversion below — but a phone one version
 * behind has neither, and a phone one version behind is the entire reason this
 * feature exists. The by-hand conversion works everywhere that does WebAuthn
 * at all, and both ends of it are GAM's own code.
 *
 * Styling sticks to what every portal defines: the `card` class and the shared
 * colour variables. The gold button is the one thing that is NOT universal —
 * see PasskeyClasses.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type PasskeyApi = {
  /** GET, returning the response's `data` payload. */
  get: (url: string) => Promise<any>
  /** POST, returning the response's `data` payload. */
  post: (url: string, body?: any) => Promise<any>
  /** DELETE. */
  del: (url: string) => Promise<any>
}

/**
 * WHAT THIS PORTAL CALLS ITS GOLD BUTTON.
 *
 * 10/31: the offer went out to the rest of the portals, and two of them paint
 * nothing for `btn btn-primary`. GAM Books and the support console were cloned
 * from an older stylesheet that names the gold button `bp` and never grew the
 * long alias, so a hardcoded class there is a button with the right padding,
 * the right corners and no background at all — invisible, on the one control
 * that is the whole feature. The landlord portal, the register, the business
 * portal and the listings site all do define `btn-primary`, so they pass
 * nothing and keep exactly what they render today.
 *
 * Colours stay in CSS variables with fallbacks baked in below, because the
 * alert tints (`--red-bg` and friends) are missing in four portals and an
 * undefined variable is simply no background — the difference between a red
 * box and an unframed red sentence.
 */
export type PasskeyClasses = {
  /** Full-width primary button. Default `btn btn-primary`. */
  button?: string
  /** Small primary button — add a device, confirm a removal. */
  buttonSmall?: string
  /** Small secondary button — keep it. */
  buttonGhost?: string
}

// The landlord portal's own values, so a portal that never defined these reads
// the same as the one that did instead of losing the box altogether.
const RED_BG = 'var(--red-bg, rgba(239,68,68,.08))'
const RED_DIM = 'var(--red-dim, #7f1d1d)'
const GREEN_BG = 'var(--green-bg, rgba(34,197,94,.08))'
const GREEN_DIM = 'var(--green-dim, #166534)'

export interface PasskeyRow {
  id: string
  deviceName: string
  createdAt: string
  lastUsedAt: string | null
  backedUp: boolean
  transports: string[] | null
}

// ── base64url, both directions ───────────────────────────────────────────────

function fromB64u(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── What this browser can do ─────────────────────────────────────────────────

/** Does this browser do passkeys at all? */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as any).PublicKeyCredential === 'function'
    && !!navigator.credentials
    && typeof navigator.credentials.get === 'function'
}

/**
 * Is there a Face ID / Touch ID / Windows Hello sensor on THIS device? The
 * browser will not say whether a key actually exists (that would let any site
 * fingerprint the person), so this is the most that can be known before asking.
 * A wrong answer here costs a tap on a button that then says nothing is
 * registered, which is why the password form stays on the page either way.
 */
async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false
  const PKC = (window as any).PublicKeyCredential
  if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false
  try { return !!(await PKC.isUserVerifyingPlatformAuthenticatorAvailable()) } catch { return false }
}

async function conditionalMediationAvailable(): Promise<boolean> {
  const PKC = typeof window !== 'undefined' ? (window as any).PublicKeyCredential : null
  if (!PKC || typeof PKC.isConditionalMediationAvailable !== 'function') return false
  try { return !!(await PKC.isConditionalMediationAvailable()) } catch { return false }
}

// ── The WebAuthn calls ───────────────────────────────────────────────────────

function serializeAssertion(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  }
}

/**
 * The person cancelled, or the sensor timed out. Not an error worth a red box —
 * they chose to back out, and the password form is right there.
 */
function wasCancelled(e: unknown): boolean {
  const name = (e as any)?.name
  return name === 'NotAllowedError' || name === 'AbortError'
}

/** What went wrong, in a sentence somebody can act on. Never the raw object. */
function failureText(e: unknown, fallback: string): string {
  const fromServer = (e as any)?.response?.data?.error
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer.trim()
  if ((e as any)?.name === 'InvalidStateError') {
    return 'This device already has a passkey on this account.'
  }
  if ((e as any)?.name === 'SecurityError') {
    return 'This address cannot hold a passkey. Open the portal on its proper web address and try again.'
  }
  return fallback
}

// ── Signing in ───────────────────────────────────────────────────────────────

/**
 * The passkey offer on a sign-in page.
 *
 * `onSignedIn` is handed the session the server minted — the portal's own auth
 * context stores it, exactly as it stores the one from the emailed-code step.
 * This component never writes a token anywhere itself.
 *
 * It renders NOTHING when the browser cannot do passkeys, so an old phone and a
 * desktop with no sensor simply see the password form they have always seen.
 */
export function PasskeySignIn({
  api, onSignedIn, portal, keepSignedIn, label = 'Sign in with Face ID or Touch ID', classes,
}: {
  api: PasskeyApi
  onSignedIn: (session: { token: string; user: any }) => void | Promise<void>
  /** S650: which console this is, so a passkey obeys the same staff-only gate. */
  portal?: string
  keepSignedIn?: boolean
  label?: string
  classes?: PasskeyClasses
}) {
  const [offer, setOffer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Aborts the silent autofill attempt when this page goes away, and when the
  // person taps the button instead (two live WebAuthn requests cancel each
  // other, and the browser's complaint lands on whichever started first).
  const quiet = useRef<AbortController | null>(null)

  const finish = useCallback(async (cred: PublicKeyCredential) => {
    const session = await api.post('/auth/passkey/sign-in', {
      response: serializeAssertion(cred),
      ...(portal ? { portal } : {}),
      ...(keepSignedIn === undefined ? {} : { keepSignedIn }),
    })
    await onSignedIn(session)
  }, [api, onSignedIn, portal, keepSignedIn])

  const requestOptions = useCallback(async () => {
    const options = await api.post('/auth/passkey/sign-in/options')
    return {
      ...options,
      challenge: fromB64u(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: fromB64u(c.id) })),
    } as PublicKeyCredentialRequestOptions
  }, [api])

  useEffect(() => {
    let live = true
    platformAuthenticatorAvailable().then(ok => { if (live) setOffer(ok) })
    return () => { live = false }
  }, [])

  // ── THE AUTOFILL OFFER ─────────────────────────────────────────────────────
  //
  // Conditional mediation puts the passkey in the email field's own autofill
  // list, and ONLY when the browser actually holds one for this site — which is
  // the closest thing there is to "offer it when they have one". It shows
  // nothing and asks nothing when they do not, so it cannot interrupt somebody
  // typing a password. The explicit button below stays for the browsers that
  // have no conditional mediation (and for anybody who just wants to tap it).
  //
  // The sign-in page's email input needs autoComplete="username webauthn" for
  // the key to appear in its list.
  //
  // ONCE, ON MOUNT — never on re-render. The callbacks below are rebuilt every
  // render (a sign-in page passes onSignedIn as an inline arrow), so listing
  // them as dependencies restarted this on every keystroke: four challenges
  // issued for one visit to the sign-in page in the first build of this, each
  // one aborting the offer the browser was in the middle of showing. The refs
  // are what let the effect hold still while still calling the current
  // callbacks.
  const latest = useRef({ requestOptions, finish })
  latest.current = { requestOptions, finish }
  useEffect(() => {
    let live = true
    const controller = new AbortController()
    quiet.current = controller
    ;(async () => {
      if (!(await conditionalMediationAvailable())) return
      try {
        const publicKey = await latest.current.requestOptions()
        if (!live) return
        const cred = await navigator.credentials.get({
          publicKey, mediation: 'conditional', signal: controller.signal,
        } as CredentialRequestOptions) as PublicKeyCredential | null
        if (!live || !cred) return
        setBusy(true)
        await latest.current.finish(cred)
      } catch {
        // SILENT MEANS SILENT. Nothing here was asked for — this runs on page
        // load — so nothing here gets a red box. A first build of this painted
        // "That passkey did not work" on an untouched sign-in page the moment
        // the options call failed (it was a CORS error in a test build, but any
        // dropped connection on load would do it), telling somebody who had
        // only come to type their password that something they had never heard
        // of was broken. The explicit button below is where a failure is worth
        // reporting, because there somebody asked.
      } finally {
        if (live) setBusy(false)
      }
    })()
    return () => { live = false; controller.abort() }
  }, [])

  const onClick = async () => {
    setError('')
    // Stand the silent offer down first — see above.
    quiet.current?.abort()
    setBusy(true)
    try {
      const publicKey = await requestOptions()
      const cred = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null
      if (!cred) return
      await finish(cred)
    } catch (e) {
      if (!wasCancelled(e)) setError(failureText(e, 'That passkey did not work. Sign in with your password instead.'))
    } finally {
      setBusy(false)
    }
  }

  if (!offer) return null
  return (
    <div style={{ marginBottom: 20 }}>
      {error && (
        <div style={{
          background: RED_BG, border: `1px solid ${RED_DIM}`, borderRadius: 8,
          padding: '10px 14px', fontSize: '.82rem', color: 'var(--red)', marginBottom: 12,
        }}>{error}</div>
      )}
      <button className={classes?.button ?? 'btn btn-primary'} type="button" onClick={onClick} disabled={busy}
        style={{ width: '100%', padding: '12px 0', fontSize: '1rem', justifyContent: 'center' }}>
        {busy ? 'Waiting for your device…' : label}
      </button>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', textAlign: 'center', marginTop: 8, lineHeight: 1.5 }}>
        No password and no emailed code.
      </div>
      {/* The fallback is right here, always, for anybody who has not set one up
          on this device — "password + code stays the fallback". */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 2px' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>or</div>
        <div style={{ flex: 1, height: 1, background: 'var(--border-0)' }} />
      </div>
    </div>
  )
}

// ── Managing devices ─────────────────────────────────────────────────────────

/**
 * Add, see and remove the devices that can sign this account in.
 *
 * ONE LIST FOR THE WHOLE PLATFORM, on purpose: in production every portal is a
 * subdomain of one apex, so a passkey added here opens the landlord portal, the
 * register, GAM Books and the tenant portal. Per-portal keys would mean
 * registering Face ID separately on each one.
 */
export function PasskeySettings({
  api, title = 'Face ID & Passkeys', classes,
}: { api: PasskeyApi; title?: string; classes?: PasskeyClasses }) {
  const primary = classes?.button ?? 'btn btn-primary'
  const primarySm = classes?.buttonSmall ?? 'btn btn-primary btn-sm'
  const ghostSm = classes?.buttonGhost ?? 'btn btn-ghost btn-sm'
  const [rows, setRows] = useState<PasskeyRow[] | null>(null)
  const [supported, setSupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [added, setAdded] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setRows(await api.get('/auth/passkey')) }
    catch (e) { setError(failureText(e, 'GAM could not read your devices. Reload the page and try again.')) }
  }, [api])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    let live = true
    platformAuthenticatorAvailable().then(ok => { if (live) setSupported(ok) })
    return () => { live = false }
  }, [])

  const add = async () => {
    setError(''); setAdded(''); setBusy(true)
    try {
      const options = await api.post('/auth/passkey/options')
      const publicKey = {
        ...options,
        challenge: fromB64u(options.challenge),
        user: { ...options.user, id: fromB64u(options.user.id) },
        excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: fromB64u(c.id) })),
      } as PublicKeyCredentialCreationOptions
      const cred = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null
      if (!cred) return
      const r = cred.response as AuthenticatorAttestationResponse
      const saved: PasskeyRow = await api.post('/auth/passkey', {
        response: {
          id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
          response: {
            clientDataJSON: toB64u(r.clientDataJSON),
            attestationObject: toB64u(r.attestationObject),
            // How the key can be reached, so a later sign-in prompts the right
            // way instead of offering a USB key to somebody holding a phone.
            transports: typeof (r as any).getTransports === 'function' ? (r as any).getTransports() : undefined,
          },
          clientExtensionResults: cred.getClientExtensionResults(),
        },
      })
      setAdded(`${saved.deviceName} can now sign you in.`)
      await load()
    } catch (e) {
      if (!wasCancelled(e)) setError(failureText(e, 'That device could not be added. Try again.'))
    } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    setError(''); setAdded(''); setBusy(true)
    try { await api.del(`/auth/passkey/${id}`); setConfirming(null); await load() }
    catch (e) { setError(failureText(e, 'That device could not be removed. Try again.')) }
    finally { setBusy(false) }
  }

  const when = (iso: string | null) => {
    if (!iso) return 'not used yet'
    const d = new Date(iso)
    return isNaN(d.getTime()) ? 'not used yet'
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">{title}</span></div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.6, marginTop: 10 }}>
        A passkey signs you in with Face ID, Touch ID or your device PIN — no password and no
        emailed code. Your password and the emailed code keep working on any device without one.
      </div>

      {error && (
        <div style={{
          background: RED_BG, border: `1px solid ${RED_DIM}`, borderRadius: 8,
          padding: '10px 14px', fontSize: '.82rem', color: 'var(--red)', margin: '14px 0 0',
        }}>{error}</div>
      )}
      {added && !error && (
        <div style={{
          background: GREEN_BG, border: `1px solid ${GREEN_DIM}`, borderRadius: 8,
          padding: '10px 14px', fontSize: '.82rem', color: 'var(--green)', margin: '14px 0 0',
        }}>{added}</div>
      )}

      <div style={{ marginTop: 16 }}>
        {rows === null && <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>Loading…</div>}
        {rows !== null && rows.length === 0 && (
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
            No devices yet.
          </div>
        )}
        {(rows ?? []).map(p => (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            flexWrap: 'wrap', padding: '12px 0', borderTop: '1px solid var(--border-0)',
          }}>
            <div style={{ minWidth: 0, flex: '1 1 180px' }}>
              <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.92rem' }}>{p.deviceName}</div>
              <div style={{ fontSize: '.76rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
                Last used {when(p.lastUsedAt)} · added {when(p.createdAt)}
                {/* Whether losing the device loses the key — the only part of
                    this a person actually has to decide anything about. */}
                {p.backedUp ? ' · saved to your keychain' : ' · only on this device'}
              </div>
            </div>
            {confirming === p.id ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className={primarySm} type="button" disabled={busy}
                  onClick={() => remove(p.id)}>Remove {p.deviceName}</button>
                <button className={ghostSm} type="button" disabled={busy}
                  onClick={() => setConfirming(null)}>Keep it</button>
              </div>
            ) : (
              <button className={primarySm} type="button" disabled={busy}
                onClick={() => { setError(''); setAdded(''); setConfirming(p.id) }}>Remove</button>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {supported ? (
          <button className={primary} type="button" onClick={add} disabled={busy}>
            {busy ? 'Waiting for your device…' : 'Add this device'}
          </button>
        ) : (
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            This device has no Face ID, Touch ID or PIN sensor GAM can use. Open the portal on a
            phone or a laptop with one to add a passkey.
          </div>
        )}
      </div>
    </div>
  )
}
