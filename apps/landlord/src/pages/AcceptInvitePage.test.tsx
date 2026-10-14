// @vitest-environment jsdom
/**
 * 10/13 (Nic): "there was some kind of issue on the signing up flow through the
 * bookkeeper invite link. She said she figured it out now, but it told her to
 * sign in and then something about it not going anywhere ... whatever the
 * process is, it's not smooth."
 *
 * What she met (live log, 10/13): after Create account the page said "You keep
 * the books in GAM Books — sign in there" with a button to GAM Books' /login (a
 * 404); opening the link again said "This invitation is accepted. Ask your
 * employer to send a new invite link." She got in by finding the portal's
 * sign-in herself.
 *
 * Driven here on the real pages (the invitation page and the sign-in page,
 * through the router): Create account → the code box → her pages; the link
 * opened again → "already set up", Sign in; an existing account → sign in →
 * back to the invitation. The server's side is apps/api
 * routes/teamInviteSignIn1013.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const server = vi.hoisted(() => ({
  invite: null as any,
  getFail: false,
  posts: [] as Array<{ url: string; body: any }>,
  postAnswers: [] as Array<{ ok: any } | { fail: { status: number; error: string; code?: string } }>,
}))
const auth = vi.hoisted(() => ({
  user: null as null | { email: string; role: string },
  loading: false,
  logout: null as any,
  login: null as any,
  loginWithEmailOtp: null as any,
  loginWithTotp: null as any,
  resendEmailOtp: null as any,
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (!url.startsWith('/invitations/')) throw new Error(`unexpected GET ${url}`)
    if (server.getFail) throw Object.assign(new Error('Invitation not found'), { response: { status: 404, data: { success: false, error: 'Invitation not found' } } })
    return server.invite
  },
  apiPost: async (url: string, body?: any) => {
    server.posts.push({ url, body })
    const a = server.postAnswers.shift()
    if (!a) throw new Error(`unexpected POST ${url}`)
    if ('fail' in a) throw Object.assign(new Error(a.fail.error), { response: { status: a.fail.status, data: { success: false, error: a.fail.error, code: a.fail.code } } })
    return { success: true, data: a.ok }
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

import { AcceptInvitePage } from './AcceptInvitePage'
import { LoginPage, safeNextPath } from './LoginPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const EMAIL = 'kay.keeper@example.com'
const CODE_KEY = 'gam.otp.landlord.login'
const pendingInvite = (o: Record<string, unknown> = {}) => ({
  id: 'inv1', email: EMAIL, role: 'bookkeeper', status: 'pending', expired: false,
  expiresAt: '2026-10-14T23:30:00Z', inviterName: 'Mountain View RV', userExists: false,
  firstName: null, lastName: null, phone: null,
  bookkeeperAccess: { companyWide: true, showLeaseDates: false, propertyCount: 1, companyLedger: false, wholeCompanyReports: false, seesMonthlyReport: false },
  ...o,
})

let root: Root
let el: HTMLDivElement

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function open(path: string, state?: unknown) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[state === undefined ? path : { pathname: path.split('?')[0], search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }]}>
        <Routes>
          <Route path="/invite/:token" element={<><AcceptInvitePage /><Where /></>} />
          <Route path="/login" element={<><LoginPage /><Where /></>} />
          <Route path="/" element={<><div>HER PAGES</div><Where /></>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

const where = () => el.querySelector('[data-testid="where"]')?.textContent
const text = () => el.textContent ?? ''
const button = (label: string | RegExp) => {
  const b = [...el.querySelectorAll('button')].find(x => typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? ''))
  if (!b) throw new Error(`no button ${label} in: ${text()}`)
  return b as HTMLButtonElement
}
async function click(label: string | RegExp) {
  await act(async () => { button(label).click() })
  await flush()
}
function fill(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const input = (sel: string) => el.querySelector(sel) as HTMLInputElement | null

async function createAccount() {
  fill(input('#invite-first'), 'Kay')
  fill(input('#invite-last'), 'Keeper')
  fill(input('#invite-password'), 'her_own_pw_1013')
  fill(input('#invite-confirm'), 'her_own_pw_1013')
  await click('Create account')
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  server.invite = pendingInvite()
  server.getFail = false
  server.posts = []
  server.postAnswers = []
  auth.user = null
  auth.loading = false
  auth.logout = vi.fn(() => { auth.user = null })
  auth.login = vi.fn()
  auth.loginWithEmailOtp = vi.fn(async () => undefined)
  auth.loginWithTotp = vi.fn(async () => undefined)
  auth.resendEmailOtp = vi.fn(async () => undefined)
  sessionStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.restoreAllMocks()
})

describe("10/13: the bookkeeper's invitation, from the email to her pages", () => {
  it('Create account goes straight to the code box, and the code lands her on her pages — no GAM Books, no second sign-in', async () => {
    await open('/invite/tok')
    expect(text()).toContain('Create your account')
    // What she was told before: sign in at GAM Books (whose /login was a 404).
    expect(el.innerHTML).not.toMatch(/GAM Books|books\.goldassetmanagement/)

    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'pending-pass', otpSent: true } })
    await createAccount()
    expect(server.posts).toEqual([{ url: '/invitations/tok/accept', body: { password: 'her_own_pw_1013', firstName: 'Kay', lastName: 'Keeper', phone: undefined } }])

    // The code step, with plain words — not a sign-in form asking for the password again.
    expect(where()).toBe('/login')
    expect(text()).toContain('Check Your Email')
    expect(text()).toContain('Your account is set up')
    expect(text()).toContain(EMAIL)
    expect(input('input[type="password"]')).toBeNull()
    expect(sessionStorage.getItem(CODE_KEY)).toBe('pending-pass')

    fill(input('input[autocomplete="one-time-code"]'), '123456')
    await click('Verify')
    expect(auth.loginWithEmailOtp).toHaveBeenCalledWith('pending-pass', '123456')
    expect(where()).toBe('/')
    expect(text()).toContain('HER PAGES')
    expect(sessionStorage.getItem(CODE_KEY)).toBeNull()
  })

  it('the code box survives the phone reloading the page while she reads the code (S639)', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'pending-pass', otpSent: true } })
    await createAccount()
    act(() => root.unmount())
    root = createRoot(el)
    await open('/login')   // a reload: the router state is gone, the tab's storage is not
    expect(text()).toContain('Check Your Email')
  })

  it('a browser that refuses storage still gets the code box (the pass rides in the router state)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'pending-pass', otpSent: true } })
    await createAccount()
    expect(where()).toBe('/login')
    expect(text()).toContain('Check Your Email')
    fill(input('input[autocomplete="one-time-code"]'), '654321')
    await click('Verify')
    expect(auth.loginWithEmailOtp).toHaveBeenCalledWith('pending-pass', '654321')
  })

  // otpSent: false is the server saying no code could be issued at all (none
  // stored, none mailed) — the page must not also claim "We sent a code".
  it('a code that could not be issued says so, does not claim it was sent, and points at Resend', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'pending-pass', otpSent: false } })
    await createAccount()
    expect(text()).toMatch(/couldn't send your sign-in code\. Tap Resend code/)
    expect(text()).toContain(`Tap Resend code to get a 6-digit code at ${EMAIL}`)
    expect(text()).not.toMatch(/We sent a 6-digit code/)
    await click('Resend code')
    expect(auth.resendEmailOtp).toHaveBeenCalledWith('pending-pass')
    expect(text()).toContain('A new code is on its way')
    expect(text()).toContain(`We sent a 6-digit code to ${EMAIL}`)
    expect(text()).not.toMatch(/couldn't send your sign-in code/)
  })

  it('backing out of the code step and signing in again is an ordinary sign-in (no "your account is set up" over a new code)', async () => {
    auth.login = vi.fn(async () => ({ kind: 'email_otp_required', emailOtpSession: 'later-pass' }))
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'pending-pass', otpSent: false } })
    await createAccount()
    await click('← Back to sign in')
    expect(sessionStorage.getItem(CODE_KEY)).toBeNull()
    expect(text()).toContain(`Your account is set up. Sign in with ${EMAIL}`)
    fill(input('input[type="password"]'), 'her_own_pw_1013')
    await click('Sign in')
    expect(text()).toContain('Check Your Email')
    expect(text()).not.toMatch(/couldn't send your sign-in code|One last step/)
    fill(input('input[autocomplete="one-time-code"]'), '777888')
    await click('Verify')
    expect(auth.loginWithEmailOtp).toHaveBeenCalledWith('later-pass', '777888')
    expect(where()).toBe('/')
  })

  it('if the code step could not start, the sign-in form says the account is set up, with her email filled in', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: false } })
    await createAccount()
    expect(where()).toBe('/login')
    expect(text()).toContain(`Your account is set up. Sign in with ${EMAIL}`)
    expect(input('input[type="email"]')!.value).toBe(EMAIL)
  })

  for (const role of ['onsite_manager', 'property_manager', 'maintenance']) {
    it(`the same path for ${role} (the page is shared)`, async () => {
      server.invite = pendingInvite({ role, bookkeeperAccess: undefined })
      await open('/invite/tok')
      expect(text()).toContain('join their team')
      server.postAnswers.push({ ok: { userId: 'u2', role, requiresEmailOtp: true, emailOtpSession: `pass-${role}`, otpSent: true } })
      await createAccount()
      expect(where()).toBe('/login')
      expect(text()).toContain('Check Your Email')
      expect(sessionStorage.getItem(CODE_KEY)).toBe(`pass-${role}`)
    })
  }
})

describe('10/13: the link opened again after the account was set up', () => {
  it('says the account is set up and offers Sign in — never "ask your employer to send a new invite link"', async () => {
    server.invite = pendingInvite({ status: 'accepted', userExists: true })
    await open('/invite/tok')
    expect(text()).toContain('Your account is already set up')
    expect(text()).toContain("you don't need a new invitation")
    expect(text()).not.toMatch(/Ask your employer|send a new invite link|Invitation unavailable/)
    await click('Sign in')
    expect(where()).toBe('/login')
  })

  it('signed in already as that address (any letter case): straight to her pages', async () => {
    auth.user = { email: EMAIL.toUpperCase(), role: 'bookkeeper' }
    server.invite = pendingInvite({ status: 'accepted', userExists: true })
    await open('/invite/tok')
    expect(where()).toBe('/')
  })

  it('signed in as someone else on this device: says so, and signs them out before signing in', async () => {
    auth.user = { email: 'owner@example.com', role: 'landlord' }
    server.invite = pendingInvite({ status: 'accepted', userExists: true })
    await open('/invite/tok')
    expect(text()).toContain('This device is signed in as owner@example.com')
    await click(`Sign out and sign in as ${EMAIL}`)
    expect(auth.logout).toHaveBeenCalled()
    expect(where()).toBe('/login')
  })

  it('a second tap on Create account (the server says ALREADY_ACCEPTED) shows the same "already set up"', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ fail: { status: 409, error: "You've already set up your account with this link.", code: 'ALREADY_ACCEPTED' } })
    await createAccount()
    expect(text()).toContain('Your account is already set up')
    expect(button('Sign in')).toBeTruthy()
  })
})

describe('10/13: expired, withdrawn and unknown links say what to do', () => {
  it('expired: said before the form, with who to ask', async () => {
    server.invite = pendingInvite({ expired: true })
    await open('/invite/tok')
    expect(text()).toContain('This invitation link has expired')
    expect(text()).toContain('Ask Mountain View RV to send you a new one')
    expect(el.querySelector('#invite-password')).toBeNull()
  })

  it('withdrawn', async () => {
    server.invite = pendingInvite({ status: 'revoked' })
    await open('/invite/tok')
    expect(text()).toContain('This invitation was withdrawn')
    expect(text()).not.toMatch(/revoked/)
  })

  it('a link that does not exist offers the sign-in page instead of nothing', async () => {
    server.getFail = true
    await open('/invite/tok')
    expect(text()).toContain('Invitation unavailable')
    await click('Go to sign in')
    expect(where()).toBe('/login')
  })
})

describe('10/13: an existing account signs in and comes right back to accept', () => {
  it('not signed in: Sign in to accept → sign-in (password + code) → back on the invitation', async () => {
    auth.login = vi.fn(async () => ({ kind: 'email_otp_required', emailOtpSession: 'login-pass' }))
    server.invite = pendingInvite({ role: 'property_manager', userExists: true, bookkeeperAccess: undefined })
    await open('/invite/tok')
    expect(text()).toContain("Sign in to accept — you'll come right back here")
    await click('Sign in to accept')
    expect(where()).toBe('/login?next=%2Finvite%2Ftok')

    fill(input('input[type="email"]'), EMAIL)
    fill(input('input[type="password"]'), 'existing_pw_1')
    await click('Sign in')
    expect(auth.login).toHaveBeenCalledWith(EMAIL, 'existing_pw_1')
    fill(input('input[autocomplete="one-time-code"]'), '111222')
    await click('Verify')
    expect(auth.loginWithEmailOtp).toHaveBeenCalledWith('login-pass', '111222')
    expect(where()).toBe('/invite/tok')
  })

  it('signed in as that address: Accept invitation, then a way to their pages', async () => {
    auth.user = { email: EMAIL, role: 'property_manager' }
    server.invite = pendingInvite({ role: 'property_manager', userExists: true, bookkeeperAccess: undefined })
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u3', role: 'property_manager' } })
    await click('Accept invitation')
    expect(server.posts).toEqual([{ url: '/invitations/tok/accept', body: {} }])
    expect(text()).toContain("You're on Mountain View RV's team")
    expect(button('Go to my pages')).toBeTruthy()
  })

  it('signed in as someone else: signs them out, then sign-in comes back here', async () => {
    auth.user = { email: 'owner@example.com', role: 'landlord' }
    server.invite = pendingInvite({ role: 'maintenance', userExists: true, bookkeeperAccess: undefined })
    await open('/invite/tok')
    await click(`Sign out and sign in as ${EMAIL}`)
    expect(auth.logout).toHaveBeenCalled()
    expect(where()).toBe('/login?next=%2Finvite%2Ftok')
  })
})

describe("10/13: the sign-in page's way back goes only somewhere inside the portal", () => {
  it('accepts a path in the portal, refuses anything else', () => {
    expect(safeNextPath('/invite/abc')).toBe('/invite/abc')
    expect(safeNextPath('/income')).toBe('/income')
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'invite/abc', '/login', '/login?next=/x']) {
      expect(safeNextPath(bad as any), String(bad)).toBeNull()
    }
  })

  it('a plain sign-in still lands on the portal itself', async () => {
    auth.login = vi.fn(async () => ({ kind: 'success' }))
    await open('/login')
    fill(input('input[type="email"]'), EMAIL)
    fill(input('input[type="password"]'), 'pw_12345678')
    await click('Sign in')
    expect(where()).toBe('/')
  })
})
