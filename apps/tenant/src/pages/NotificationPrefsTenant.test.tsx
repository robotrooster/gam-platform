// @vitest-environment jsdom
/**
 * THE RESIDENT'S PAGE IS WHOLE TOO.
 *
 * 10/20 (Nic): "I want you to fix the root, not just one off because one
 * landlord wants a setting a certain way."
 *
 * The tenant portal had the same disease, twice over: Profile → Notifications
 * listed six types and /notification-prefs listed fifteen, out of the fifty-odd
 * a resident can actually be sent — and three of those twenty-one rows
 * ('Rent failed', 'Work trade reminder', 'Rent collected' to a resident) had no
 * sender behind them at all. Both surfaces render this one component now, so
 * this file tests the component the resident actually sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import {
  notificationCatalogFor, notificationGroupsFor, CRITICAL_NOTIFICATION_TYPES,
  isCriticalNotificationType, notificationEntry,
} from '@gam/shared'
import { NotificationPreferences } from '../../../../packages/shared-ui/NotificationPreferences'

const server = { prefs: [] as any[], patches: [] as any[] }
const api = {
  get: async (url: string) => {
    if (url === '/notifications/preferences') return server.prefs
    throw new Error(`unexpected GET ${url}`)
  },
  patch: async (url: string, body: any) => {
    if (url !== '/notifications/preferences') throw new Error(`unexpected PATCH ${url}`)
    server.patches.push(body)
    for (const u of (body.updates ?? [body])) {
      server.prefs = [
        ...server.prefs.filter(p => p.type !== u.type),
        { type: u.type, emailEnabled: u.emailEnabled, inAppEnabled: u.inAppEnabled },
      ]
    }
    return { success: true }
  },
}

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.prefs = []; server.patches = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NotificationPreferences audience="tenant" api={api} />
      </QueryClientProvider>)
  })
  await until(() => !!host.querySelector('table'), 'the list')
}
const rowFor = (type: string) => {
  const label = notificationEntry(type)!.label
  return [...host.querySelectorAll('tr')].find(tr => tr.firstElementChild?.firstElementChild?.textContent === label)
}
const boxesIn = (tr: Element) => [...tr.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]

const TENANT = notificationCatalogFor('tenant')

describe('the resident page lists every notification GAM can send them', () => {
  it.each(TENANT.map(e => [e.type, e.label] as const))(
    '%s is on the page as "%s"', async (type) => {
      await open()
      expect(rowFor(type), `${type} has no row — a type with no row means email ON`).toBeTruthy()
    })

  it('says what makes each one fire', async () => {
    await open()
    for (const entry of TENANT) expect(rowFor(entry.type)!.textContent).toContain(entry.when)
  })

  it('is grouped so it can be scanned', async () => {
    await open()
    for (const section of notificationGroupsFor('tenant')) expect(text()).toContain(section.label)
  })

  it('shows no raw type strings', async () => {
    await open()
    expect(text()).not.toMatch(/[a-z]+_[a-z_]+/)
  })

  it('is not a subset — the old six-row Profile list was a fifth of it', async () => {
    await open()
    expect(TENANT.length).toBeGreaterThan(40)
    expect([...host.querySelectorAll('input[type="checkbox"]')].length).toBeGreaterThan(40)
  })
})

describe('the ones GAM always sends a resident are shown as uncheckable', () => {
  const tenantCritical = CRITICAL_NOTIFICATION_TYPES.filter(t => TENANT.some(e => e.type === t))

  it('all five reach a resident, and all five are on their page', async () => {
    await open()
    expect(tenantCritical).toHaveLength(5)
    for (const t of tenantCritical) expect(rowFor(t)).toBeTruthy()
  })

  it.each(tenantCritical)('%s: ticked, disabled, and says why', async (type) => {
    await open()
    const row = rowFor(type)!
    for (const b of boxesIn(row)) {
      expect(b.checked).toBe(true)
      expect(b.disabled).toBe(true)
    }
    expect(row.textContent).toContain('GAM always sends this one')
    expect(row.textContent).toContain(notificationEntry(type)!.whyAlways!)
  })
})

describe('a resident turning every optional email off', () => {
  const button = () => [...host.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes('optional email')) as HTMLButtonElement | undefined

  it('records an answer for every optional type, in one request, criticals untouched', async () => {
    await open()
    await act(async () => { button()!.click() })
    await until(() => server.patches.length > 0, 'the save')
    const sent = server.patches.flatMap((p: any) => p.updates ?? [])
    // An optional email is one that exists. An in-app-only notice prints a dash
    // on the Email side because there is no such email, so the button has
    // nothing to turn off for it and records no answer — a resident can only
    // decline what they were shown.
    const optional = TENANT
      .filter(e => !isCriticalNotificationType(e.type) && !e.inAppOnly)
      .map(e => e.type)
    expect(sent.map((u: any) => u.type).sort()).toEqual([...optional].sort())
    expect(sent.filter((u: any) => u.emailEnabled !== false)).toEqual([])
    expect(sent.filter((u: any) => u.inAppEnabled !== true)).toEqual([])
    expect(sent.filter((u: any) => TENANT.find(e => e.type === u.type)?.inAppOnly)).toEqual([])
  })

  it('a saved answer shows when the page is opened again', async () => {
    server.prefs = [{ type: 'maintenance_updated', emailEnabled: false, inAppEnabled: true }]
    await open()
    await until(() => boxesIn(rowFor('maintenance_updated')!)[1]!.checked === false, 'the saved choice')
    expect(boxesIn(rowFor('maintenance_updated')!)[0]!.checked).toBe(true)
  })
})
