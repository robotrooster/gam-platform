// @vitest-environment jsdom
/**
 * THE PAGE SHOWS EVERYTHING, AND SAYS WHICH FIVE IT CANNOT TURN OFF.
 *
 * 10/20 (Nic): "I want you to build every notification category in the settings
 * page and turn off the ones that are non-critical for blue, leave the critical
 * ones on... I would add everything to the list, but the five critical ones make
 * it not checkable so that they can see that they will still get those emails.
 * That way it's not like, I thought I turned it off, blah, blah, blah. Like, I'm
 * still getting these emails. Make it known that that's the ones that they're
 * still going to get on those rare instances where it happens."
 *
 * Blu Haws unchecked every box this page showed him on 10/19 and kept getting
 * email, because the page was sixteen hand-typed rows out of a hundred-odd
 * types. So the test that matters is not "a checkbox saves" — it is "every type
 * GAM can send has a row here", which is what the first case asserts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import {
  notificationCatalogFor, notificationGroupsFor, NOTIFICATION_GROUP_LABEL,
  CRITICAL_NOTIFICATION_TYPES, isCriticalNotificationType, notificationEntry,
} from '@gam/shared'

const server = vi.hoisted(() => ({
  role: 'landlord',
  prefs: [] as any[],
  patches: [] as any[],
  /** Set to hold a save in flight, so the in-flight state can be looked at. */
  hold: null as null | { release: () => void; waiting: Promise<void> },
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
      if (server.hold) await server.hold.waiting
      for (const u of (body.updates ?? [body])) {
        server.prefs = [
          ...server.prefs.filter((p: any) => p.type !== u.type),
          { type: u.type, emailEnabled: u.emailEnabled, inAppEnabled: u.inAppEnabled },
        ]
      }
      return { data: { success: true, data: { saved: (body.updates ?? [body]).length } } }
    },
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: server.role } }) }))
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
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}`)
}
async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><NotificationPrefsSection /></QueryClientProvider>)
  })
  await until(() => !!host.querySelector('table'), 'the list')
}
/** The row whose first cell names this type's label. */
const rowFor = (type: string) => {
  const label = notificationEntry(type)!.label
  return [...host.querySelectorAll('tr')].find(tr => tr.firstElementChild?.firstElementChild?.textContent === label)
}
const boxesIn = (tr: Element) => [...tr.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]

const LANDLORD = notificationCatalogFor('landlord', { isAccountHolder: true })

describe('the landlord page lists every notification GAM can send them', () => {
  it.each(LANDLORD.map(e => [e.type, e.label] as const))(
    '%s is on the page as "%s"', async (type) => {
      await open()
      expect(rowFor(type), `${type} has no row — a type with no row means email ON`).toBeTruthy()
    })

  it('says, in one line each, what makes them fire', async () => {
    await open()
    for (const entry of LANDLORD) {
      expect(rowFor(entry.type)!.textContent).toContain(entry.when)
    }
  })

  it('is grouped so it can be scanned, not one flat wall', async () => {
    await open()
    for (const section of notificationGroupsFor('landlord')) {
      expect(text(), `missing the "${section.label}" heading`).toContain(section.label)
    }
    expect(Object.values(NOTIFICATION_GROUP_LABEL).filter(l => text().includes(l)).length)
      .toBeGreaterThan(5)
  })

  // memory: gam-no-raw-enums-in-ui. The tell is an underscore — a stored type
  // never reaches the screen. ('birthday' is a word as well as a type, so a
  // bare substring check would flag the sentence that reads correctly.)
  it('shows no raw type strings anywhere on it', async () => {
    await open()
    for (const entry of LANDLORD) {
      if (entry.type.includes('_')) expect(text()).not.toContain(entry.type)
    }
    expect(text()).not.toMatch(/[a-z]+_[a-z_]+/)
  })
})

describe('the five GAM always sends are shown, and shown as uncheckable', () => {
  const landlordCritical = CRITICAL_NOTIFICATION_TYPES
    .filter(t => LANDLORD.some(e => e.type === t))

  it('all five that reach a landlord are visible on the page', async () => {
    await open()
    for (const t of landlordCritical) expect(rowFor(t)).toBeTruthy()
  })

  it.each(landlordCritical)('%s: the box is ticked and disabled', async (type) => {
    await open()
    const boxes = boxesIn(rowFor(type)!)
    expect(boxes.length).toBeGreaterThan(0)
    for (const b of boxes) {
      expect(b.checked).toBe(true)
      expect(b.disabled).toBe(true)
    }
  })

  it.each(landlordCritical)('%s: says GAM always sends it, and why', async (type) => {
    await open()
    const row = rowFor(type)!.textContent ?? ''
    expect(row).toContain('GAM always sends this one')
    expect(row).toContain(notificationEntry(type)!.whyAlways!)
  })

  it('clicking a locked box saves nothing', async () => {
    await open()
    const box = boxesIn(rowFor(landlordCritical[0]!)!)[0]!
    await act(async () => { box.click() })
    expect(server.patches).toEqual([])
  })
})

describe('"turn off every optional email" records an answer for all of them', () => {
  const button = () => [...host.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes('optional email')) as HTMLButtonElement | undefined

  /**
   * AN OPTIONAL EMAIL IS ONE THAT EXISTS. Of the landlord's non-critical
   * entries, 35 are in-app only — there is no such email, and the page prints a
   * dash on the Email side saying so. The button says "turn off every optional
   * email", and for those there is nothing to turn off.
   *
   * It would be easy to write all 92 rows anyway and call it tidy. It is the
   * wrong answer twice over: a person can only decline what they were shown,
   * and a stored "no" against a notice that gains an email later would silence
   * it on a say-so nobody ever gave. When one of these does gain an email it
   * gains a box on this page (emailCategories declares the gate), and they can
   * answer it then.
   */
  const optionalEmails = LANDLORD
    .filter(e => !isCriticalNotificationType(e.type) && !e.inAppOnly)
    .map(e => e.type)

  it('is one request, covering every optional type and nothing else', async () => {
    await open()
    expect(button()).toBeTruthy()
    await act(async () => { button()!.click() })
    await until(() => server.patches.length > 0, 'the save')

    const sent = server.patches.flatMap((p: any) => p.updates ?? [])
    expect(sent.map((u: any) => u.type).sort()).toEqual([...optionalEmails].sort())
    // And nothing for a notice that has no email to begin with.
    expect(sent.filter((u: any) => LANDLORD.find(e => e.type === u.type)?.inAppOnly)).toEqual([])
    // Email off, in-app left on — Nic, on Blu: he would rather log in and see
    // what needs attention.
    expect(sent.filter((u: any) => u.emailEnabled !== false)).toEqual([])
    expect(sent.filter((u: any) => u.inAppEnabled !== true)).toEqual([])
    // Not one of the locked five.
    expect(sent.filter((u: any) => isCriticalNotificationType(u.type))).toEqual([])
  })

  it('counts what is still on, so there is no guessing', async () => {
    await open()
    const n = optionalEmails.length
    expect(text()).toContain(`${n} of ${n} optional emails are on`)
    await act(async () => { button()!.click() })
    await until(() => text().includes(`0 of ${n} optional emails are on`), 'the count')
  })

  it('then offers to turn them back on, rather than looking like it did nothing', async () => {
    await open()
    await act(async () => { button()!.click() })
    await until(() => (button()?.textContent ?? '').includes('back on'), 'the flipped button')
  })
})

describe('a double click cannot turn an email back on by accident', () => {
  /**
   * 10/19, from the data: three of Blu's fifteen rows read email-ON with an
   * updated_at a minute after they were created. The old page gave no sign a
   * save was in flight, so a second click on a box that still looked ticked
   * wrote TRUE back. The box is disabled while its own save is running.
   */
  it('the box is disabled while its save is in flight, and a second click does nothing', async () => {
    await open()
    let release = () => {}
    server.hold = { waiting: new Promise<void>(r => { release = () => r() }), release }

    const emailBox = boxesIn(rowFor('rent_collected')!)[1]!
    await act(async () => { emailBox.click() })
    await until(() => server.patches.length === 1, 'the save going out')

    // Mid-save: the box is disabled and the row says so, so there is nothing to
    // click a second time — and clicking anyway writes nothing.
    const midSave = boxesIn(rowFor('rent_collected')!)[1]!
    expect(midSave.disabled).toBe(true)
    expect(rowFor('rent_collected')!.textContent).toContain('Saving…')
    await act(async () => { midSave.click() })
    expect(server.patches).toHaveLength(1)

    await act(async () => { release(); await new Promise(r => setTimeout(r, 20)) })
    server.hold = null
    expect(server.patches[0].emailEnabled).toBe(false)
    await until(() => boxesIn(rowFor('rent_collected')!)[1]!.checked === false, 'the box staying off')
  })

  it('shows the answer it took, so nobody clicks again to be sure', async () => {
    await open()
    const emailBox = boxesIn(rowFor('rent_collected')!)[1]!
    await act(async () => { emailBox.click() })
    await until(() => (rowFor('rent_collected')?.textContent ?? '').match(/Saving…|Saved/) != null,
      'the saved marker')
  })
})

describe('a team member sees the landlord page without the account holder’s own notices', () => {
  it('no birthday switch, and the rest of the page is intact', async () => {
    server.role = 'property_manager'
    await open()
    expect(rowFor('birthday')).toBeUndefined()
    expect(rowFor('rent_collected')).toBeTruthy()
    expect(rowFor('maintenance_submitted')).toBeTruthy()
  })
})
