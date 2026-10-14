// @vitest-environment jsdom
/**
 * 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
 * birthday from GAM." The tenant's switch for that email is on Profile →
 * Notifications: a Birthday Email row whose Email box is on by default, shows
 * a saved "off", and saves email-off for type 'birthday' when unticked (the
 * job skips anyone with that off). Nothing is posted in the app for it, so the
 * In-App cell says "—" instead of the always-on check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const http = vi.hoisted(() => ({
  prefs: [] as any[],
  patches: [] as { url: string; body: any }[],
}))
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: async (url: string) => {
        if (url === '/tenants/me') return { data: { data: { firstName: 'Rosa', lastName: 'Lee', email: 'rosa@test.dev' } } }
        if (url === '/notifications/preferences') return { data: { data: http.prefs } }
        if (url === '/auth/email-otp/status') return { data: { data: { email: 'rosa@test.dev' } } }
        throw new Error(`unexpected GET ${url}`)
      },
      patch: async (url: string, body: any) => { http.patches.push({ url, body }); return { data: { success: true } } },
      put: async () => ({ data: {} }),
      interceptors: { request: { use: () => 0 } },
    }),
  },
}))

import { ProfilePage } from './ProfilePage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  http.prefs = []; http.patches = []
  window.history.replaceState(null, '', '/profile?tab=notifications')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${host.textContent}`)
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><ProfilePage /></QueryClientProvider>)
  })
  await until(() => !!labelCell(), 'the Birthday Email row')
}
/** The grid's label cell for the birthday row; its next two siblings are In-App and Email. */
const labelCell = () => [...host.querySelectorAll('div')]
  .find(d => d.firstElementChild?.textContent === 'Birthday Email') as HTMLDivElement | undefined
const inAppCell = () => labelCell()!.nextElementSibling as HTMLDivElement
const emailBox = () => (labelCell()!.nextElementSibling!.nextElementSibling as HTMLDivElement)
  .querySelector('input[type="checkbox"]') as HTMLInputElement | null

describe('the Birthday Email row on the tenant Profile → Notifications tab', () => {
  it('is there, says what it is, and its Email box is on by default', async () => {
    await open()
    expect(labelCell()!.textContent).toContain('A happy-birthday note from GAM on your birthday')
    expect(emailBox()).not.toBeNull()
    expect(emailBox()!.checked).toBe(true)
  })

  it('the In-App cell reads "—" (email only), not the always-on check', async () => {
    await open()
    expect(inAppCell().textContent).toBe('—')
    expect(inAppCell().querySelector('input')).toBeNull()
  })

  it('shows a saved "off"', async () => {
    http.prefs = [{ type: 'birthday', emailEnabled: false, inAppEnabled: true }]
    await open()
    await until(() => emailBox()?.checked === false, 'the saved choice')
  })

  it('unticking it saves email off for the birthday type', async () => {
    await open()
    await act(async () => { emailBox()!.click() })
    await until(() => http.patches.length === 1, 'the save')
    expect(http.patches[0]).toEqual({
      url: '/notifications/preferences',
      body: { type: 'birthday', emailEnabled: false, inAppEnabled: true },
    })
  })
})
