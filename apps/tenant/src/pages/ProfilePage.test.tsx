// @vitest-environment jsdom
/**
 * S655 final sweep — the tenant's Change Password box.
 *
 * The server takes a new password only when it is at least PASSWORD_MIN_LEN
 * (12) long, the one minimum every password door uses. The page showed no
 * minimum at all, so a tenant typed something shorter, pressed Update and only
 * then learned the rule. The minimum now sits under the New Password box, says
 * how many more characters to add, and Update waits until it is met.
 *
 * A change ends every session minted before it, including this one, so the
 * page keeps the fresh pass the server hands back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { PASSWORD_MIN_LEN } from '@gam/shared'

const http = vi.hoisted(() => ({
  get: async (url: string) => {
    if (url === '/tenants/me') return { data: { data: { firstName: 'Pat', lastName: 'Lee', email: 'pat@test.dev' } } }
    if (url === '/notifications/preferences') return { data: { data: [] } }
    if (url === '/auth/email-otp/status') return { data: { data: { email: 'pat@test.dev' } } }
    throw new Error(`unexpected GET ${url}`)
  },
  patch: null as any,
}))
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: (url: string) => http.get(url),
      patch: (url: string, body: any) => http.patch(url, body),
      put: async () => ({ data: {} }),
      interceptors: { request: { use: () => 0 } },
    }),
  },
}))

import { ProfilePage } from './ProfilePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  http.patch = vi.fn()
  localStorage.setItem('gam_tenant_token', 'old-pass')
  window.history.replaceState(null, '', '/profile?tab=security')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><ProfilePage /></QueryClientProvider>)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
})

const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type=password]')]
const update = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Update Password')!
async function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Change Password on the tenant Profile page', () => {
  it('shows the minimum under the New Password box before anything is typed', () => {
    expect(PASSWORD_MIN_LEN).toBe(12)
    expect(boxes()).toHaveLength(3)
    expect(host.textContent).toContain('At least 12 characters.')
  })

  it('a new password that is too short says how many more to add, and Update waits', async () => {
    const [current, next, confirm] = boxes()
    await type(current, 'oldPassword123')
    await type(next, 'short')
    await type(confirm, 'short')
    expect(host.textContent).toContain('At least 12 characters. Add 7 more.')
    expect(update().disabled).toBe(true)

    await type(next, 'twelveChars!')
    await type(confirm, 'twelveChars!')
    expect(host.textContent).not.toContain('more.')
    expect(update().disabled).toBe(false)
  })

  it('two different new passwords say so in plain words, and Update waits', async () => {
    const [current, next, confirm] = boxes()
    await type(current, 'oldPassword123')
    await type(next, 'brandNewPass456')
    await type(confirm, 'brandNewPass457')
    expect(host.textContent).toContain('The two new passwords do not match. Type the same new password in both boxes.')
    expect(update().disabled).toBe(true)
  })

  it('a change keeps the fresh pass the server hands back', async () => {
    http.patch.mockResolvedValue({ data: { success: true, data: { token: 'fresh-pass' } } })
    const [current, next, confirm] = boxes()
    await type(current, 'oldPassword123')
    await type(next, 'brandNewPass456')
    await type(confirm, 'brandNewPass456')
    await act(async () => { update().click() })
    expect(http.patch).toHaveBeenCalledWith('/tenants/password',
      { currentPassword: 'oldPassword123', newPassword: 'brandNewPass456' })
    expect(localStorage.getItem('gam_tenant_token')).toBe('fresh-pass')
    expect(host.textContent).toContain('Password changed. You stay signed in here; other devices will need to sign in again.')
  })

  it("the server's own sentence shows when it refuses (a wrong current password)", async () => {
    http.patch.mockRejectedValue({ response: { status: 400, data: { error: 'Your current password is incorrect. Check it and try again.' } } })
    const [current, next, confirm] = boxes()
    await type(current, 'wrongPassword1')
    await type(next, 'brandNewPass456')
    await type(confirm, 'brandNewPass456')
    await act(async () => { update().click() })
    expect(host.textContent).toContain('Your current password is incorrect. Check it and try again.')
    expect(localStorage.getItem('gam_tenant_token')).toBe('old-pass')
  })

  // A 401 means two different things here. A locked account (too many sign-in
  // attempts, maybe by someone else) is refused, but the pass still works, so
  // the tenant stays in and is told why. Only a session that has itself ended
  // signs the tenant out.
  describe('a 401 from the server', () => {
    const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!
    let nav: { href: string }
    beforeEach(() => {
      nav = { href: 'http://localhost/profile?tab=security' }
      Object.defineProperty(window, 'location', { configurable: true, value: nav })
    })
    afterEach(() => { Object.defineProperty(window, 'location', realLocation) })

    async function tryChange() {
      const [current, next, confirm] = boxes()
      await type(current, 'oldPassword123')
      await type(next, 'brandNewPass456')
      await type(confirm, 'brandNewPass456')
      await act(async () => { update().click() })
    }

    it('a locked account shows the sentence and keeps the pass', async () => {
      const locked = 'Your account is temporarily locked after too many sign-in attempts. ' +
        'Try again in 12 minutes, or reset your password from the sign-in page.'
      http.patch.mockRejectedValue({ response: { status: 401, data: { success: false, error: locked } } })
      await tryChange()
      expect(host.textContent).toContain(locked)
      expect(localStorage.getItem('gam_tenant_token')).toBe('old-pass')
      expect(nav.href).toBe('http://localhost/profile?tab=security')
    })

    it('a pass older than a password change signs out and goes to the sign-in page', async () => {
      http.patch.mockRejectedValue({ response: { status: 401, data: { success: false, error: 'Your password was changed. Please sign in again.' } } })
      await tryChange()
      expect(localStorage.getItem('gam_tenant_token')).toBeNull()
      expect(nav.href).toBe('/login')
    })

    it('an expired pass signs out and goes to the sign-in page', async () => {
      http.patch.mockRejectedValue({ response: { status: 401, data: { success: false, error: 'Invalid or expired token' } } })
      await tryChange()
      expect(localStorage.getItem('gam_tenant_token')).toBeNull()
      expect(nav.href).toBe('/login')
    })
  })
})
