// @vitest-environment jsdom
/**
 * 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
 * birthday from GAM." The tenant's switch for that email is on Profile →
 * Notifications: its Email box is on by default, shows a saved "off", and saves
 * email-off for type 'birthday' when unticked (the job skips anyone with that
 * off). Nothing is posted in the app for it, so the In-app cell says "—"
 * instead of a switch that would do nothing.
 *
 * 10/20: the tab renders the one shared component off the one catalog, so the
 * row's words are the catalog's and the cells are table cells.
 *
 * 10/14 afternoon (Nic): "Tenant profile shows the birthday read-only, 'ask
 * your landlord to fix it'." Profile → Profile shows the birthday on file as
 * words, with no box to change it and nothing of it sent on Save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const http = vi.hoisted(() => ({
  prefs: [] as any[],
  patches: [] as { url: string; body: any }[],
  me: { firstName: 'Rosa', lastName: 'Lee', email: 'rosa@test.dev' } as Record<string, any>,
}))
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: async (url: string) => {
        if (url === '/tenants/me') return { data: { data: http.me } }
        if (url === '/emergency-contacts/mine') return { data: { data: null } }
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
  http.me = { firstName: 'Rosa', lastName: 'Lee', email: 'rosa@test.dev' }
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
/** The birthday row's label cell; its next two siblings are In-app and Email. */
const labelCell = () => [...host.querySelectorAll('td')]
  .find(d => d.firstElementChild?.textContent === 'Happy birthday from GAM') as HTMLTableCellElement | undefined
const inAppCell = () => labelCell()!.nextElementSibling as HTMLTableCellElement
const emailBox = () => (labelCell()!.nextElementSibling!.nextElementSibling as HTMLTableCellElement)
  .querySelector('input[type="checkbox"]') as HTMLInputElement | null

describe('the happy-birthday row on the tenant Profile → Notifications tab', () => {
  it('is there, says what it is, and its Email box is on by default', async () => {
    await open()
    expect(labelCell()!.textContent).toContain('a note from GAM')
    expect(emailBox()).not.toBeNull()
    expect(emailBox()!.checked).toBe(true)
  })

  it('the In-app cell reads "—" (email only), not a switch that would do nothing', async () => {
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

describe('the birthday on the tenant Profile → Profile tab (10/14 afternoon, Nic)', () => {
  /** The Birthday block: its label, the date shown, and the note under it. */
  const birthdayBlock = () => [...host.querySelectorAll('label')]
    .find(l => l.textContent === 'Birthday')?.parentElement as HTMLDivElement | undefined
  async function openProfile() {
    window.history.replaceState(null, '', '/profile?tab=profile')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(<QueryClientProvider client={qc}><ProfilePage /></QueryClientProvider>)
    })
    await until(() => !!birthdayBlock(), 'the Birthday block')
  }

  it('shows the birthday on file as words, read-only, and says to ask the landlord to fix it', async () => {
    // The server sends the date column as a timestamp at its own midnight.
    http.me = { ...http.me, dateOfBirth: '1980-04-23T07:00:00.000Z' }
    await openProfile()
    await until(() => birthdayBlock()!.textContent!.includes('April 23, 1980'), 'the birthday')
    expect(birthdayBlock()!.textContent).toContain('ask your landlord to fix it')
    expect(birthdayBlock()!.querySelector('input, select, textarea')).toBeNull()
    // Save Changes sends nothing of it.
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Save Changes')!.click() })
    await until(() => http.patches.length === 1, 'the save')
    expect(http.patches[0].url).toBe('/tenants/profile')
    expect(Object.keys(http.patches[0].body)).not.toContain('dateOfBirth')
  })

  it('a plain date reads the same, and none on file shows a dash with the same note', async () => {
    http.me = { ...http.me, dateOfBirth: '1962-01-02' }
    await openProfile()
    await until(() => birthdayBlock()!.textContent!.includes('January 2, 1962'), 'the birthday')
    act(() => root.unmount())
    root = createRoot(host)
    http.me = { ...http.me, dateOfBirth: null }
    await openProfile()
    // Read once the profile has loaded (its email box is filled), not before.
    await until(() => (host.querySelector('input[type="email"]') as HTMLInputElement | null)?.value === 'rosa@test.dev', 'the profile')
    expect(birthdayBlock()!.textContent).toContain('—')
    expect(birthdayBlock()!.textContent).toContain('ask your landlord to fix it')
  })
})
