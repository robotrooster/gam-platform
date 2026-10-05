// @vitest-environment jsdom
/**
 * 10/5 (Nic, an applicant stuck at the Mountain View counter): the screening's
 * account step answered an address that already had an account with "please
 * sign in" — on a page with no way to sign in. Now:
 *   - the API continues an unfinished screening when the same email and
 *     password come back (it answers with a session), so the form moves on;
 *   - any other existing account gets a "Sign in to continue" that returns to
 *     this same screening link, and a "Forgot your password?".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

vi.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve(null) }))
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: any) => children, PaymentElement: () => null,
  useStripe: () => null, useElements: () => null,
}))

import { BackgroundCheckPage } from './BackgroundCheckPage'

let registerReply: { status: number; body: any }
let verifyReply: { status: number; body: any } = { status: 200, body: {} }
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/auth/register-prospect')) {
    return { ok: registerReply.status < 300, status: registerReply.status, json: async () => registerReply.body } as any
  }
  if (url.includes('/auth/email-otp/verify')) {
    return { ok: verifyReply.status < 300, status: verifyReply.status, json: async () => verifyReply.body } as any
  }
  if (url.includes('/auth/email-otp/resend')) return { ok: true, status: 200, json: async () => ({ success: true }) } as any
  return { ok: true, status: 200, json: async () => ({ data: null }) } as any
})

let root: Root | null = null
let host: HTMLDivElement
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  fetchMock.mockClear()
  ;(globalThis as any).fetch = fetchMock
  window.history.replaceState(null, '', '/background-check?landlordId=96ec7df3-362d-4777-b54c-e9604313820f&unitId=&propertyId=p1')
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => { act(() => root?.unmount()); root = null; host.remove() })

const typeInto = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function fillAccountStepAndContinue() {
  await act(async () => {
    root = createRoot(host)
    root.render(<QueryClientProvider client={new QueryClient()}><BackgroundCheckPage /></QueryClientProvider>)
  })
  const email = host.querySelector('input[type="email"]') as HTMLInputElement
  const [pw, confirm] = Array.from(host.querySelectorAll('input[type="password"]')) as HTMLInputElement[]
  const terms = host.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => {
    typeInto(email, 'returning@example.com')
    typeInto(pw, 'correct horse battery')
    typeInto(confirm, 'correct horse battery')
    terms.click()
  })
  const cont = Array.from(host.querySelectorAll('button')).find(b => /Continue/.test(b.textContent || ''))!
  await act(async () => { cont.click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('the screening account step when the email already has an account', () => {
  it('an existing account gets "Sign in to continue" back to this screening, and a password reset — not a dead end', async () => {
    registerReply = { status: 409, body: { success: false, error: 'An account with this email already exists. Sign in to continue.' } }
    await fillAccountStepAndContinue()
    const box = host.querySelector('[data-testid="existing-account"]') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.textContent).toContain('You already have an account with returning@example.com')
    const signIn = Array.from(box.querySelectorAll('a')).find(a => /Sign in to continue/.test(a.textContent || ''))!
    expect(signIn.getAttribute('href')).toBe(
      `/login?to=${encodeURIComponent('/background-check?landlordId=96ec7df3-362d-4777-b54c-e9604313820f&unitId=&propertyId=p1')}`)
    const forgot = Array.from(box.querySelectorAll('a')).find(a => /Forgot your password/.test(a.textContent || ''))!
    expect(forgot.getAttribute('href')).toBe('/forgot-password')
    // Still on the account step; no session was stored.
    expect(localStorage.getItem('gam_tenant_token')).toBeNull()
  })

  it('coming back to an unfinished screening asks for the emailed code on this page, then continues — no session before the code', async () => {
    registerReply = { status: 200, body: { success: true, data: { requiresEmailOtp: true, resumed: true, emailOtpSession: 'pending-pass',
      user: { id: 'u1', email: 'returning@example.com', firstName: '', lastName: '', role: 'tenant', profileId: 't1' } } } }
    verifyReply = { status: 200, body: { success: true, data: { token: 'tok-after-code' } } }
    await fillAccountStepAndContinue()
    const box = host.querySelector('[data-testid="email-code"]') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.textContent).toContain('returning@example.com')
    expect(localStorage.getItem('gam_tenant_token')).toBeNull()
    const codeInput = box.querySelector('input') as HTMLInputElement
    const go = Array.from(box.querySelectorAll('button')).find(b => b.textContent === 'Continue') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await act(async () => { typeInto(codeInput, '123456') })
    expect(go.disabled).toBe(false)
    await act(async () => { go.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const verifyCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/auth/email-otp/verify'))!
    expect(JSON.parse((verifyCall[1] as any).body)).toEqual({ emailOtpSession: 'pending-pass', code: '123456' })
    expect(localStorage.getItem('gam_tenant_token')).toBe('tok-after-code')
    expect(host.querySelector('[data-testid="email-code"]')).toBeNull()
    expect(host.querySelector('input[type="email"]')).toBeNull()
  })

  it('a wrong code says so and stays on the code box', async () => {
    registerReply = { status: 200, body: { success: true, data: { requiresEmailOtp: true, resumed: true, emailOtpSession: 'pending-pass' } } }
    verifyReply = { status: 401, body: { success: false, error: 'Invalid code.' } }
    await fillAccountStepAndContinue()
    const box = host.querySelector('[data-testid="email-code"]') as HTMLElement
    await act(async () => { typeInto(box.querySelector('input') as HTMLInputElement, '000000') })
    const go = Array.from(box.querySelectorAll('button')).find(b => b.textContent === 'Continue') as HTMLButtonElement
    await act(async () => { go.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector('[data-testid="email-code"]')!.textContent).toContain('Invalid code.')
    expect(localStorage.getItem('gam_tenant_token')).toBeNull()
  })

  it('when the code\u2019s 15 minutes run out, the box closes and says to press Continue for a new one — no dead end', async () => {
    registerReply = { status: 200, body: { success: true, data: { requiresEmailOtp: true, resumed: true, emailOtpSession: 'pending-pass' } } }
    verifyReply = { status: 401, body: { success: false, error: 'Sign-in session expired. Please log in again.' } }
    await fillAccountStepAndContinue()
    const box = host.querySelector('[data-testid="email-code"]') as HTMLElement
    await act(async () => { typeInto(box.querySelector('input') as HTMLInputElement, '123456') })
    const go = Array.from(box.querySelectorAll('button')).find(b => b.textContent === 'Continue') as HTMLButtonElement
    await act(async () => { go.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector('[data-testid="email-code"]')).toBeNull()
    expect(host.textContent).toContain('Your code timed out. Press Continue to get a new one.')
    const cont = Array.from(host.querySelectorAll('button')).find(b => /Continue →/.test(b.textContent || '')) as HTMLButtonElement
    expect(cont.disabled).toBe(false)
  })

  it('changing the email clears the "you already have an account" box', async () => {
    registerReply = { status: 409, body: { success: false, error: 'An account with this email already exists. Sign in to continue.' } }
    await fillAccountStepAndContinue()
    expect(host.querySelector('[data-testid="existing-account"]')).not.toBeNull()
    const email = host.querySelector('input[type="email"]') as HTMLInputElement
    await act(async () => { typeInto(email, 'someone-else@example.com') })
    expect(host.querySelector('[data-testid="existing-account"]')).toBeNull()
  })
})
