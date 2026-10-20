// @vitest-environment jsdom
/**
 * 10/13 (Nic): "emailing tenants on their birthday and saying, Hey, happy
 * birthday from GAM" — tenants AND landlords. The landlord's switch for that
 * email lives in Settings → Notification Preferences. A landlord account sees
 * it, its saved choice shows, and unticking it saves email-off for type
 * 'birthday' (the job skips anyone with that off). A team member gets no
 * birthday email at all, so they are not shown a switch that would do nothing.
 *
 * 10/20: the list is rendered from the one notification catalog in @gam/shared
 * now, so the wording here is the catalog's wording. The behaviour under test is
 * unchanged — the switch is there, it shows a saved answer, and it saves.
 * notificationPrefsPage.complete.test.tsx covers the whole page.
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
  /** 10/20: make the next PATCH fail, the way a 500 or a dropped connection does. */
  patchFails: null as null | string,
  /** Whether this landlord may see the Email Delivery Issues card. */
  canFailures: false,
  failures: [] as any[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/notifications/preferences') return server.prefs
    if (url.startsWith('/landlords/me/email-failures')) {
      return { rows: server.failures, sinceDays: 30, limit: 50 }
    }
    throw new Error(`unexpected GET ${url}`)
  },
  api: {
    patch: async (url: string, body: any) => {
      if (url !== '/notifications/preferences') throw new Error(`unexpected PATCH ${url}`)
      if (server.patchFails) {
        const err: any = new Error('Request failed with status code 500')
        err.response = { data: { error: server.patchFails }, statusText: 'Internal Server Error' }
        throw err
      }
      server.patches.push(body)
      return { data: { success: true } }
    },
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: server.role } }) }))
vi.mock('../lib/permissions', () => ({
  usePerms: () => ({ can: () => server.canFailures, isOwner: server.role === 'landlord' }),
}))

import { NotificationPrefsSection } from './NotificationPrefsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.role = 'landlord'; server.prefs = []; server.patches = []
  server.patchFails = null; server.canFailures = false; server.failures = []
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
  [...host.querySelectorAll('tr')].find(tr => (tr.textContent ?? '').includes('Happy birthday from GAM'))
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

/**
 * ── 10/20: A SAVE THAT FAILS PUTS THE BOX BACK, AND SAYS SO ─────────────────
 *
 * There was no catch on the save at all. A PATCH that returned 500, or a
 * connection that dropped, left the optimistic value in place: the box rendered
 * unchecked, the counter dropped by one, nothing said a word, and the server
 * still had email ON. He keeps getting the email while the page says it is off
 * — the same end state as the double-click race this page was built to fix,
 * reached from the other direction. With the bulk button it was worse: the
 * button flipped to "Turn every optional email back on" and the counter read
 * "0 of N" over nothing saved.
 */
describe('a save that does not land', () => {
  const counter = () => [...host.querySelectorAll('span')]
    .map(s => s.textContent ?? '').find(t => t.includes('optional emails are on')) ?? ''
  const bulkButton = () => [...host.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes('optional email')) as HTMLButtonElement

  it('puts one box back where it was and names the reason', async () => {
    await open()
    const before = counter()
    expect(birthdayBox()!.checked).toBe(true)
    server.patchFails = 'Database is unavailable'

    await act(async () => { birthdayBox()!.click() })
    await until(() => text().includes('Not saved'), 'the failure message')

    // Back on, because the server still has it on.
    expect(birthdayBox()!.checked).toBe(true)
    expect(birthdayRow()!.textContent).toContain('Database is unavailable')
    expect(counter()).toBe(before)
    expect(server.patches).toEqual([])
  })

  it('puts every box back when the bulk save fails, and does not flip the button', async () => {
    await open()
    const before = counter()
    const label = bulkButton().textContent
    server.patchFails = 'Database is unavailable'

    await act(async () => { bulkButton().click() })
    await until(() => text().includes('Not saved'), 'the failure message')

    expect(counter()).toBe(before)
    expect(bulkButton().textContent).toBe(label)
    expect(server.patches).toEqual([])
  })

  it('a save that lands is still reported as saved', async () => {
    await open()
    await act(async () => { birthdayBox()!.click() })
    await until(() => server.patches.length === 1, 'the save')
    expect(text()).not.toContain('Not saved')
    expect(birthdayRow()!.textContent).toContain('Saved')
  })
})

/**
 * ── 10/20: THE DELIVERY-ISSUES TABLE SPEAKS ENGLISH TOO ─────────────────────
 *
 * It printed the stored email category — "late_payment_notice",
 * "esign_signing_reminder", "tenant_invite_reminder" — in the Category column,
 * directly under eighty rows that were carefully written in plain words
 * (memory: gam-no-raw-enums-in-ui). notificationLabel could not cover them
 * because an email's category and a notification's type are two different
 * namespaces; both now come from one declaration in @gam/shared.
 */
describe('Email Delivery Issues names the kind of email in words', () => {
  it('prints a label, never the stored category', async () => {
    server.canFailures = true
    server.failures = [
      { id: 'f1', toEmail: 'a@b.com', subject: 'x', category: 'late_payment_notice',
        errorMessage: 'bounced', relatedEntityType: null, relatedEntityId: null, metadata: null,
        createdAt: '2026-10-19T12:00:00Z' },
      { id: 'f2', toEmail: 'c@d.com', subject: 'y', category: 'esign_signing_reminder',
        errorMessage: 'bounced', relatedEntityType: null, relatedEntityId: null, metadata: null,
        createdAt: '2026-10-19T12:00:00Z' },
      { id: 'f3', toEmail: 'e@f.com', subject: 'z', category: 'notif_rent_collected',
        errorMessage: 'bounced', relatedEntityType: null, relatedEntityId: null, metadata: null,
        createdAt: '2026-10-19T12:00:00Z' },
    ]
    await open()
    await until(() => text().includes('Email Delivery Issues'), 'the failures card')
    await until(() => text().includes('Overdue balances each morning'), 'the labeled category')
    expect(text()).toContain('Reminder: something is waiting for your signature')
    expect(text()).toContain('Rent collected')
    for (const raw of ['late_payment_notice', 'esign_signing_reminder', 'notif_rent_collected']) {
      expect(text(), `${raw} is printed raw`).not.toContain(raw)
    }
  })

  it('an undeclared category still never prints as an enum', async () => {
    server.canFailures = true
    server.failures = [
      { id: 'f1', toEmail: 'a@b.com', subject: 'x', category: 'something_nobody_declared',
        errorMessage: 'bounced', relatedEntityType: null, relatedEntityId: null, metadata: null,
        createdAt: '2026-10-19T12:00:00Z' },
    ]
    await open()
    await until(() => text().includes('Email Delivery Issues'), 'the failures card')
    expect(text()).toContain('Something nobody declared')
    expect(text()).not.toContain('something_nobody_declared')
  })
})
