// @vitest-environment jsdom
/**
 * THE PASSKEY OFFER, AND THE FALLBACK IT SITS ON TOP OF.
 *
 * 10/30 (Nic): "a passkey replaces the emailed code — Face ID alone signs you
 * in; password + code stays the fallback." 10/31 the offer went out to the
 * resident portal, GAM Books, the business portal, the support console and the
 * listings site, so the half that decides whether the password form is
 * disturbed is now the same component on six sign-in pages. This file tests
 * that component, in the one portal of the six that has a test harness.
 *
 * The load-bearing assertion is the NEGATIVE one: on a browser with no Face ID,
 * no Touch ID and no PIN sensor, the offer renders NOTHING — not a disabled
 * button, not an explanation — so the password form below it is byte for byte
 * the page it has always been. That, and the fact that this component never
 * touches /auth/login or the emailed-code endpoints, is what "password + code
 * stays the fallback" means in code.
 *
 * (Each of these portals defines its own LoginPage inside main.tsx rather than
 * exporting it, so the whole sign-in page cannot be mounted here without
 * executing the app's entry module. The component under test is the entire
 * passkey surface those pages add.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PasskeySignIn, PasskeySettings } from '../../../../packages/shared-ui/Passkeys'

// ── A browser, as much of one as WebAuthn needs ──────────────────────────────

/** Bytes in, ArrayBuffer out — what the browser hands back for every field. */
function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

/** The object navigator.credentials.get() resolves with, for a sign-in. */
function fakeAssertion() {
  return {
    id: 'Y3JlZC1pZA',
    rawId: buf(1, 2, 3, 4),
    type: 'public-key',
    response: {
      clientDataJSON: buf(123, 125),
      authenticatorData: buf(9, 8, 7),
      signature: buf(5, 5, 5),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  }
}

type BrowserOpts = {
  /** Is there a Face ID / Touch ID / PIN sensor on this device? */
  sensor?: boolean
  /** Does this browser put passkeys in the email field's autofill list? */
  conditional?: boolean
  /** What navigator.credentials.get() does. */
  onGet?: (opts: any) => Promise<any>
  /** What navigator.credentials.create() does. */
  onCreate?: (opts: any) => Promise<any>
}

function installBrowser(o: BrowserOpts) {
  const PKC: any = function PublicKeyCredential() { /* a constructor is all the component checks for */ }
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => o.sensor ?? true
  PKC.isConditionalMediationAvailable = async () => o.conditional ?? false
  ;(window as any).PublicKeyCredential = PKC
  ;(navigator as any).credentials = {
    get: vi.fn(o.onGet ?? (async () => fakeAssertion())),
    create: vi.fn(o.onCreate ?? (async () => null)),
  }
  return { get: (navigator as any).credentials.get, create: (navigator as any).credentials.create }
}

/** A DOMException as the browser raises it — the name is what the code reads. */
function domError(name: string) {
  const e: any = new Error(name)
  e.name = name
  return e
}

/** A refusal from GAM's own API, in the shape axios gives it. */
function serverError(sentence: string) {
  const e: any = new Error(sentence)
  e.response = { data: { error: sentence } }
  return e
}

// ── The portal's side of it ──────────────────────────────────────────────────

/**
 * Stands in for the portal: records every call the component makes, so a test
 * can assert the emailed-code endpoints were never among them.
 */
function stubApi(over: Partial<Record<string, (body?: any) => any>> = {}) {
  const calls: string[] = []
  const api = {
    get: async (url: string) => {
      calls.push(`GET ${url}`)
      if (over[`GET ${url}`]) return over[`GET ${url}`]!()
      if (url === '/auth/passkey') return []
      throw new Error(`unexpected GET ${url}`)
    },
    post: async (url: string, body?: any) => {
      calls.push(`POST ${url}`)
      if (over[`POST ${url}`]) return over[`POST ${url}`]!(body)
      if (url === '/auth/passkey/sign-in/options') {
        return { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', userVerification: 'required' }
      }
      if (url === '/auth/passkey/sign-in') return { token: 'full.session.jwt', user: { id: 'u1', role: 'tenant' } }
      if (url === '/auth/passkey/options') {
        return {
          challenge: 'Y2hhbGxlbmdl', rp: { id: 'localhost', name: 'GAM' },
          user: { id: 'dXNlci1pZA', name: 'alice@tenant.dev', displayName: 'Alice' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        }
      }
      throw new Error(`unexpected POST ${url}`)
    },
    del: async (url: string) => {
      calls.push(`DELETE ${url}`)
      if (over[`DELETE ${url}`]) return over[`DELETE ${url}`]!()
      return { success: true }
    },
  }
  return { api, calls }
}

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as any).PublicKeyCredential
  delete (navigator as any).credentials
})

const text = () => host.textContent ?? ''
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const button = (label: string) =>
  buttons().find(b => (b.textContent ?? '').includes(label))

async function settle() {
  for (let i = 0; i < 40; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

/**
 * The password form the offer sits on top of. Stands in for whichever sign-in
 * page is hosting it; the tests assert it is never disturbed.
 */
function PasswordForm() {
  return (
    <form>
      <input name="email" autoComplete="username webauthn" />
      <input name="password" type="password" autoComplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
  )
}

// ── Signing in ───────────────────────────────────────────────────────────────

describe('the passkey offer on a sign-in page', () => {
  it('offers Face ID on a device that has it, and says no password or code is needed', async () => {
    installBrowser({ sensor: true })
    const { api } = stubApi()
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={() => {}} /><PasswordForm /></>)
    })
    await settle()

    expect(button('Sign in with Face ID or Touch ID')).toBeTruthy()
    expect(text()).toContain('No password and no emailed code.')
    // The divider that introduces the fallback below it.
    expect(text()).toContain('or')
  })

  it('renders NOTHING on a device with no sensor, so the password form is untouched', async () => {
    installBrowser({ sensor: false })
    const { api, calls } = stubApi()
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={() => {}} /><PasswordForm /></>)
    })
    await settle()

    expect(button('Face ID')).toBeUndefined()
    expect(text()).not.toContain('No password and no emailed code.')
    // The password form is the whole page, exactly as before passkeys existed.
    expect(host.querySelector('input[name="password"]')).toBeTruthy()
    expect(button('Sign in')).toBeTruthy()
    // And nothing was asked of the server on the way to rendering nothing.
    expect(calls).toEqual([])
  })

  it('renders nothing at all in a browser with no WebAuthn', async () => {
    delete (window as any).PublicKeyCredential
    ;(navigator as any).credentials = undefined
    const { api, calls } = stubApi()
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={() => {}} /><PasswordForm /></>)
    })
    await settle()

    expect(button('Face ID')).toBeUndefined()
    expect(host.querySelector('input[name="password"]')).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('signs in on the passkey alone — one challenge, the signed response, a full session', async () => {
    const browser = installBrowser({ sensor: true })
    const { api, calls } = stubApi()
    let handed: any = null
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={s => { handed = s }} /><PasswordForm /></>)
    })
    await settle()

    await act(async () => { button('Sign in with Face ID or Touch ID')!.click() })
    await settle()

    expect(browser.get).toHaveBeenCalledTimes(1)
    // The challenge arrives as bytes, not as the base64url the server sent.
    const asked = (browser.get as any).mock.calls[0][0].publicKey
    expect(asked.challenge).toBeInstanceOf(Uint8Array)

    expect(calls).toEqual(['POST /auth/passkey/sign-in/options', 'POST /auth/passkey/sign-in'])
    // NO password, NO emailed code: the portal is handed a full session.
    expect(handed).toEqual({ token: 'full.session.jwt', user: { id: 'u1', role: 'tenant' } })
  })

  it('sends the console it belongs to, so a passkey obeys the same staff-only gate', async () => {
    installBrowser({ sensor: true })
    let body: any = null
    const { api } = stubApi({
      'POST /auth/passkey/sign-in': (b: any) => { body = b; return { token: 't', user: {} } },
    })
    await act(async () => {
      root.render(<PasskeySignIn api={api} portal="admin_ops" keepSignedIn onSignedIn={() => {}} />)
    })
    await settle()
    await act(async () => { button('Face ID')!.click() })
    await settle()

    expect(body.portal).toBe('admin_ops')
    expect(body.keepSignedIn).toBe(true)
    expect(body.response.id).toBe('Y3JlZC1pZA')
    // base64url, no padding and no + or / — the server parses it as such.
    expect(body.response.rawId).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('backing out of the sensor is not an error — the fallback is right there', async () => {
    installBrowser({ sensor: true, onGet: async () => { throw domError('NotAllowedError') } })
    const { api } = stubApi()
    let handed = false
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={() => { handed = true }} /><PasswordForm /></>)
    })
    await settle()
    await act(async () => { button('Face ID')!.click() })
    await settle()

    expect(handed).toBe(false)
    expect(text()).not.toContain('did not work')
    // Still offered, and the password form is still there to use instead.
    expect(button('Face ID')).toBeTruthy()
    expect(host.querySelector('input[name="password"]')).toBeTruthy()
  })

  it('shows the server its own sentence when a console refuses the account', async () => {
    installBrowser({ sensor: true })
    const refusal = 'This sign-in is for GAM staff accounts. Check the email address — landlords sign in at the landlord portal.'
    const { api } = stubApi({
      'POST /auth/passkey/sign-in': () => { throw serverError(refusal) },
    })
    await act(async () => {
      root.render(<><PasskeySignIn api={api} portal="admin_ops" onSignedIn={() => {}} /><PasswordForm /></>)
    })
    await settle()
    await act(async () => { button('Face ID')!.click() })
    await settle()

    expect(text()).toContain(refusal)
    expect(host.querySelector('input[name="password"]')).toBeTruthy()
  })

  it('a failed silent autofill offer paints nothing — nobody asked for it', async () => {
    // Conditional mediation on, and the options call fails on page load.
    installBrowser({ sensor: true, conditional: true })
    const { api } = stubApi({
      'POST /auth/passkey/sign-in/options': () => { throw new Error('network down') },
    })
    await act(async () => {
      root.render(<><PasskeySignIn api={api} onSignedIn={() => {}} /><PasswordForm /></>)
    })
    await settle()

    expect(text()).not.toContain('did not work')
    expect(text()).not.toContain('network down')
    expect(button('Face ID')).toBeTruthy()
  })

  it('wears whichever class name this portal calls its gold button', async () => {
    installBrowser({ sensor: true })
    const { api } = stubApi()
    await act(async () => {
      // GAM Books and the support console name it `bp`, not `btn-primary`.
      root.render(<PasskeySignIn api={api} classes={{ button: 'bp btn' }} onSignedIn={() => {}} />)
    })
    await settle()

    const b = button('Face ID')!
    expect(b.className).toBe('bp btn')
  })
})

// ── The device list ──────────────────────────────────────────────────────────

describe('the device list on an account page', () => {
  it('lists the devices that can sign this account in, and says the password still works', async () => {
    installBrowser({ sensor: true })
    const { api } = stubApi({
      'GET /auth/passkey': () => ([
        { id: 'p1', deviceName: 'iPhone', createdAt: '2026-10-20T00:00:00Z', lastUsedAt: '2026-10-30T00:00:00Z', backedUp: true, transports: ['internal'] },
      ]),
    })
    await act(async () => { root.render(<PasskeySettings api={api} />) })
    await settle()

    expect(text()).toContain('iPhone')
    expect(text()).toContain('saved to your keychain')
    // "password + code stays the fallback", said on the page itself.
    expect(text()).toContain('Your password and the emailed code keep working on any device without one.')
    expect(button('Add this device')).toBeTruthy()
  })

  it('asks before removing a device, and removes it only on the second tap', async () => {
    installBrowser({ sensor: true })
    let listed = [
      { id: 'p1', deviceName: 'iPhone', createdAt: '2026-10-20T00:00:00Z', lastUsedAt: null, backedUp: false, transports: null },
    ]
    const { api, calls } = stubApi({
      'GET /auth/passkey': () => listed,
      'DELETE /auth/passkey/p1': () => { listed = []; return { success: true } },
    })
    await act(async () => { root.render(<PasskeySettings api={api} />) })
    await settle()

    await act(async () => { button('Remove')!.click() })
    await settle()
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual([])
    expect(button('Keep it')).toBeTruthy()

    await act(async () => { button('Remove iPhone')!.click() })
    await settle()
    expect(calls).toContain('DELETE /auth/passkey/p1')
    expect(text()).toContain('No devices yet.')
  })

  it('says so plainly when the device has no sensor to register', async () => {
    installBrowser({ sensor: false })
    const { api } = stubApi()
    await act(async () => { root.render(<PasskeySettings api={api} />) })
    await settle()

    expect(button('Add this device')).toBeUndefined()
    expect(text()).toContain('This device has no Face ID, Touch ID or PIN sensor GAM can use.')
  })
})
