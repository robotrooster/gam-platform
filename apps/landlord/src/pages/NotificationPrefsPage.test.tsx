// @vitest-environment jsdom
/**
 * 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
 * birthday from GAM" — tenants AND landlords. The landlord's switch for that
 * email lives in Settings → Notification Preferences. A landlord account sees
 * it, its saved choice shows, and unticking it saves email-off for type
 * 'birthday' (the job skips anyone with that off). A team member gets no
 * birthday email at all, so they are not shown a switch that would do nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { LANDLORD_ASSIGNABLE_ROLES } from '@gam/shared'

const server = vi.hoisted(() => ({
  role: 'landlord',
  prefs: [] as any[],
  patches: [] as any[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/notifications/preferences') return server.prefs
    throw new Error(`unexpected GET ${url}`)
  },
  api: {
    patch: async (url: string, body: any) => {
      if (url !== '/notifications/preferences') throw new Error(`unexpected PATCH ${url}`)
      server.patches.push(body)
      return { data: { success: true } }
    },
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: server.role } }) }))
// The delivery-failures card below the list is its own feature; keep it out.
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ can: () => false, isOwner: server.role === 'landlord' }) }))

import { NotificationPrefsSection } from './NotificationPrefsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.role = 'landlord'; server.prefs = []; server.patches = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><NotificationPrefsSection /></QueryClientProvider>)
  })
  await until(() => !!host.querySelector('table'), 'the list')
}
const birthdayRow = () =>
  [...host.querySelectorAll('tr')].find(tr => (tr.textContent ?? '').includes('Happy birthday email from GAM'))
const birthdayBox = () => birthdayRow()?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined

describe('the birthday email switch on the landlord Notification Preferences', () => {
  it('a landlord account sees it, on by default', async () => {
    await open()
    expect(birthdayRow()).toBeTruthy()
    expect(birthdayBox()!.checked).toBe(true)
  })

  it('shows a saved "off"', async () => {
    server.prefs = [{ type: 'birthday', emailEnabled: false, inAppEnabled: true }]
    await open()
    await until(() => birthdayBox()?.checked === false, 'the saved choice')
  })

  it('unticking it saves email off for the birthday type', async () => {
    await open()
    await act(async () => { birthdayBox()!.click() })
    await until(() => server.patches.length === 1, 'the save')
    expect(server.patches[0]).toEqual({ type: 'birthday', emailEnabled: false, inAppEnabled: true })
  })

  it.each([...LANDLORD_ASSIGNABLE_ROLES])(
    'a team member (%s) gets no birthday email, so sees no switch for it', async (role) => {
      server.role = role
      await open()
      expect(birthdayRow()).toBeUndefined()
      // The rest of the list is unchanged.
      expect(text()).toContain('Rent collected')
    })
})
