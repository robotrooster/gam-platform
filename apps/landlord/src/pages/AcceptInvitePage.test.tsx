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
 * through the router): Create account → her pages; the link opened again →
 * "already set up", Sign in; an existing account → sign in → back to the
 * invitation. The server's side is apps/api routes/teamInviteSignIn1013.test.ts.
 *
 * 10/13 evening (Nic): "SKIP the code step once (the invite link counts as
 * proof of email) — sign straight in." Create account now keeps the session
 * the accept hands back and opens the portal at its own address: no code box.
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

// 10/13 evening: window.location stands in for the full load to the portal.
const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!
let nav: { href: string; assign: ReturnType<typeof vi.fn> }

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
  localStorage.clear()
  // 10/13 evening: signing in from the link is a full load of the portal.
  nav = { href: 'http://localhost/invite/tok', assign: vi.fn() }
  Object.defineProperty(window, 'location', { configurable: true, value: nav })
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'location', realLocation)
})


describe("10/13: the bookkeeper's invitation, from the email to her pages", () => {
  it('Create account signs her straight in: the session is kept and the portal opens — no code box, no GAM Books, no second sign-in', async () => {
    await open('/invite/tok')
    expect(text()).toContain('Create your account')
    // What she was told before: sign in at GAM Books (whose /login was a 404).
    expect(el.innerHTML).not.toMatch(/GAM Books|books\.goldassetmanagement/)

    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', signedIn: true, token: 'full-pass' } })
    await createAccount()
    expect(server.posts).toEqual([{ url: '/invitations/tok/accept', body: { password: 'her_own_pw_1013', firstName: 'Kay', lastName: 'Keeper', phone: undefined } }])

    // 10/13 evening (Nic): "the invite link counts as proof of email" — her
    // session, kept where the portal keeps it, and a full load of the portal
    // (her landing is decided there: a bookkeeper lands on Money in).
    expect(localStorage.getItem('gam_token')).toBe('full-pass')
    expect(nav.assign).toHaveBeenCalledWith('/')
    expect(nav.assign).toHaveBeenCalledTimes(1)
    // Never the code box, never the sign-in form.
    expect(where()).toBe('/invite/tok')
    expect(text()).not.toContain('Check Your Email')
    expect(sessionStorage.getItem(CODE_KEY)).toBeNull()
    expect(auth.loginWithEmailOtp).not.toHaveBeenCalled()
    expect(auth.login).not.toHaveBeenCalled()
  })

  it('the session from the link replaces whoever was signed in on this device', async () => {
    localStorage.setItem('gam_token', 'the-owners-pass')
    auth.user = { email: 'owner@example.com', role: 'landlord' }
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', signedIn: true, token: 'her-pass' } })
    await createAccount()
    expect(localStorage.getItem('gam_token')).toBe('her-pass')
    expect(nav.assign).toHaveBeenCalledWith('/')
  })

  it('a browser that will not keep the session sends her to sign in, saying the account is set up', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', signedIn: true, token: 'full-pass' } })
    await createAccount()
    expect(nav.assign).not.toHaveBeenCalled()
    expect(where()).toBe('/login')
    expect(text()).toContain(`Your account is set up. Sign in with ${EMAIL}`)
    expect(input('input[type="email"]')!.value).toBe(EMAIL)
  })

  it('if the account could not be signed in from the link, the sign-in form says it is set up, with her email filled in', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', signedIn: false } })
    await createAccount()
    expect(nav.assign).not.toHaveBeenCalled()
    expect(localStorage.getItem('gam_token')).toBeNull()
    expect(where()).toBe('/login')
    expect(text()).toContain(`Your account is set up. Sign in with ${EMAIL}`)
    expect(input('input[type="email"]')!.value).toBe(EMAIL)
  })

  it('…and signing in from there is the ordinary password + emailed code, landing on her pages', async () => {
    auth.login = vi.fn(async () => ({ kind: 'email_otp_required', emailOtpSession: 'later-pass' }))
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', signedIn: false } })
    await createAccount()
    fill(input('input[type="password"]'), 'her_own_pw_1013')
    await click('Sign in')
    expect(auth.login).toHaveBeenCalledWith(EMAIL, 'her_own_pw_1013')
    expect(text()).toContain('Check Your Email')
    expect(text()).toContain('We sent a 6-digit code to your email.')
    fill(input('input[autocomplete="one-time-code"]'), '777888')
    await click('Verify')
    expect(auth.loginWithEmailOtp).toHaveBeenCalledWith('later-pass', '777888')
    expect(where()).toBe('/')
    expect(sessionStorage.getItem(CODE_KEY)).toBeNull()
  })

  // Deploy order: a server from before 10/13 evening still answers with a
  // code step (its pending pass). The page does not use that pass; the
  // person signs in as usual, which mails a fresh code.
  it('an older server that answers with a code step: the sign-in form, not a code box fed by that pass', async () => {
    await open('/invite/tok')
    server.postAnswers.push({ ok: { userId: 'u1', role: 'bookkeeper', requiresEmailOtp: true, emailOtpSession: 'old-pending-pass', otpSent: true } })
    await createAccount()
    expect(nav.assign).not.toHaveBeenCalled()
    expect(localStorage.getItem('gam_token')).toBeNull()
    expect(sessionStorage.getItem(CODE_KEY)).toBeNull()
    expect(where()).toBe('/login')
    expect(text()).toContain(`Your account is set up. Sign in with ${EMAIL}`)
  })

  it('a password shorter than 12 characters is refused on the page, before anything is sent', async () => {
    await open('/invite/tok')
    expect(input('#invite-password')!.placeholder).toBe('Min 12 characters')
    fill(input('#invite-first'), 'Kay')
    fill(input('#invite-last'), 'Keeper')
    fill(input('#invite-password'), 'elevenchars')
    fill(input('#invite-confirm'), 'elevenchars')
    await click('Create account')
    expect(text()).toContain('Password must be at least 12 characters.')
    expect(server.posts).toEqual([])
  })

  for (const role of ['onsite_manager', 'property_manager', 'maintenance']) {
    it(`the same path for ${role} (the page is shared)`, async () => {
      server.invite = pendingInvite({ role, bookkeeperAccess: undefined })
      await open('/invite/tok')
      expect(text()).toContain('join their team')
      server.postAnswers.push({ ok: { userId: 'u2', role, signedIn: true, token: `pass-${role}` } })
      await createAccount()
      expect(localStorage.getItem('gam_token')).toBe(`pass-${role}`)
      expect(nav.assign).toHaveBeenCalledWith('/')
      expect(text()).not.toContain('Check Your Email')
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
    // 10/13: Resend replaces the link, so the likeliest reason is a newer email.
    expect(text()).toContain('If you got a newer invitation email, use the link in that one.')
    await click('Go to sign in')
    expect(where()).toBe('/login')
  })

  // 10/13 review: the owner pressed Resend after she opened the link, so the
  // link in front of her was replaced. Create account used to show the bare
  // "Invitation not found" under a form that could never work.
  it('a link replaced while the form is open (Resend): Create account says to use the newer email, not "Invitation not found"', async () => {
    await open('/invite/tok')
    expect(text()).toContain('Create your account')
    server.postAnswers.push({ fail: { status: 404, error: 'Invitation not found' } })
    await createAccount()
    expect(server.posts).toHaveLength(1)
    expect(text()).toContain('Invitation unavailable')
    expect(text()).toContain('This invite link no longer works. If you got a newer invitation email, use the link in that one.')
    expect(text()).not.toContain('Invitation not found')
    expect(el.querySelector('#invite-password')).toBeNull()
    expect(localStorage.getItem('gam_token')).toBeNull()
    expect(nav.assign).not.toHaveBeenCalled()
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
