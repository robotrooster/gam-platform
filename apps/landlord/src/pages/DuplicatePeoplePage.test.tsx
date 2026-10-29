// @vitest-environment jsdom
/**
 * 10/20 (Nic) — WHAT THE LANDLORD HAS TO BE ABLE TO READ OFF THIS SCREEN.
 *
 *   "Say, hey, this looks like the same person. They have the same name. Same
 *    email, or maybe the email's different, but the phone number's the same...
 *    But have it be always have the landlord check that the customer is the
 *    same."
 *
 * Both people side by side, the reasons in sentences rather than stored values,
 * which of the two stays, and — because the pairs on this screen are
 * mid-migration guests who have already been told they have a reservation —
 * that answering emails nobody.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  payload: null as any,
  posted: [] as { url: string; body: any }[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (_url: string) => server.payload,
  apiPost: async (url: string, body: any) => {
    server.posted.push({ url, body })
    return { message: 'Done.' }
  },
}))

const toasted: string[] = []
const confirmed: string[] = []
let confirmAnswer = true
vi.mock('../components/dialogs', () => ({
  toast: Object.assign((m: string) => { toasted.push(m) }, { error: (m: string) => { toasted.push(`ERR ${m}`) } }),
  appConfirm: async (m: string) => { confirmed.push(m); return confirmAnswer },
}))

let DuplicatePeoplePage: any, suggestedKeeper: any, holdsTenancy: any
let container: HTMLDivElement, root: Root

const guest = (over: any = {}) => ({
  key: 'g:1', kind: 'guest', name: 'Robert Jenkins', email: 'rj@cox.net', phone: '(928) 555-1234',
  reservations: 2, leases: 0, signedDocuments: 0, firstSeenAt: '2026-10-01T00:00:00.000Z', ...over,
})
const acct = (over: any = {}) => ({
  key: 'u:1', kind: 'account', name: 'Robert Jenkins', email: 'bobj@gmail.com', phone: '(928) 555-1234',
  reservations: 0, leases: 1, signedDocuments: 1, firstSeenAt: '2026-02-01T00:00:00.000Z', ...over,
})

beforeEach(async () => {
  server.posted = []; toasted.length = 0; confirmed.length = 0; confirmAnswer = true
  server.payload = { proposals: [], decided: [], openCount: 0, scanned: { open: 0, raised: 0 } }
  ;({ default: DuplicatePeoplePage, suggestedKeeper, holdsTenancy } = await import('./DuplicatePeoplePage'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const render = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><DuplicatePeoplePage /></QueryClientProvider>)
  })
}
const text = () => container.textContent ?? ''
const buttonSaying = (needle: string) =>
  Array.from(container.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(needle))
const click = async (el: Element | undefined) => {
  expect(el, 'the button is on the page').toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}

describe('suggestedKeeper', () => {
  it('keeps the side holding the lease — the address moves, the lease never does', () => {
    expect(suggestedKeeper(guest(), acct())).toBe('b')
    expect(suggestedKeeper(acct(), guest())).toBe('a')
  })
  it('keeps the account when neither holds a lease', () => {
    expect(suggestedKeeper(guest(), acct({ leases: 0, signedDocuments: 0 }))).toBe('b')
  })
  it('keeps the side with an address when both are reservations — the only thing they can be joined on', () => {
    expect(suggestedKeeper(guest({ key: 'g:1', email: null }), guest({ key: 'g:2' }))).toBe('b')
  })
  it('knows a reservation never holds a tenancy', () => {
    expect(holdsTenancy(guest({ leases: 3 }))).toBe(false)
    expect(holdsTenancy(acct())).toBe(true)
  })
})

describe('the screen', () => {
  it('says plainly that nobody is emailed', async () => {
    await render()
    expect(text()).toMatch(/Nobody is emailed either way/i)
  })

  it('says nothing is doubled up when nothing is', async () => {
    await render()
    expect(text()).toMatch(/Nobody looks doubled up/i)
  })

  it('shows both people, the reasons as sentences, and never a stored value', async () => {
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'strong', score: 85,
        reasons: ['Same name', 'Same phone number'],
        a: guest(), b: acct(),
      }],
      decided: [], openCount: 1, scanned: { open: 1, raised: 1 },
    }
    await render()
    const t = text()
    expect(t).toMatch(/Almost certainly the same person/)
    expect(t).toMatch(/Same name/)
    expect(t).toMatch(/Same phone number/)
    // The two kinds of record, in words.
    expect(t).toMatch(/Reservation only — no GAM account/)
    expect(t).toMatch(/Has a GAM account/)
    // What each side actually has, so the choice is made on facts.
    expect(t).toMatch(/1 lease/)
    expect(t).toMatch(/2 reservations/)
    // No raw stored value anywhere on the page.
    expect(t).not.toMatch(/name_exact|phone_exact|\bstrong\b/)
  })

  it('offers the side holding the lease as the one that stays', async () => {
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'strong', score: 85, reasons: ['Same name', 'Same phone number'],
        a: guest(), b: acct({ name: 'Bob Jenkins' }),
      }],
      decided: [], openCount: 1, scanned: null,
    }
    await render()
    expect(buttonSaying('Same person — keep Bob Jenkins')).toBeTruthy()
  })

  it('asks before joining two people, and says what will happen', async () => {
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'strong', score: 85, reasons: ['Same name', 'Same phone number'],
        a: guest(), b: acct(),
      }],
      decided: [], openCount: 1, scanned: null,
    }
    await render()
    await click(buttonSaying('Same person'))
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toMatch(/is folded into them/)
    expect(confirmed[0]).toMatch(/Nothing is deleted and nobody is emailed/)
    expect(server.posted[0].url).toBe('/duplicate-people/p1/same-person')
    expect(server.posted[0].body.keeperSide).toBe('b')
  })

  it('does nothing at all when the question is answered no', async () => {
    confirmAnswer = false
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'likely', score: 65, reasons: ['Same name', 'Phone number off by one digit — looks like a typo'],
        a: guest(), b: guest({ key: 'g:2', email: null }),
      }],
      decided: [], openCount: 1, scanned: null,
    }
    await render()
    await click(buttonSaying('Same person'))
    expect(server.posted).toHaveLength(0)
  })

  it('takes "different people" without a question — it is the safe answer', async () => {
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'possible', score: 45, reasons: ['Same phone number'],
        a: guest(), b: guest({ key: 'g:2', email: null }),
      }],
      decided: [], openCount: 1, scanned: null,
    }
    await render()
    await click(buttonSaying('Different people'))
    expect(confirmed).toHaveLength(0)
    expect(server.posted[0].url).toBe('/duplicate-people/p1/not-duplicate')
  })

  it('offers the folded sign-in address only when both sides have one', async () => {
    server.payload = {
      proposals: [{
        id: 'p1', confidence: 'strong', score: 90, reasons: ['Same name', 'Same email address'],
        a: acct({ key: 'u:1', leases: 1, signedDocuments: 1, email: 'calvin@home.net' }),
        b: acct({ key: 'u:2', leases: 0, signedDocuments: 0, email: 'calvin.curtis@usda.gov' }),
      }],
      decided: [], openCount: 1, scanned: null,
    }
    await render()
    // 10/20: the checkbox ASKS for the address to move. Whether it does is the
    // merge's answer, not the card's promise — GAM only moves a sign-in it can
    // see the whole of (services/duplicatePeople), and says what it did.
    expect(text()).toMatch(/Move the sign-in address/)
    expect(text()).toMatch(/calvin\.curtis@usda\.gov/)
  })

  it('reads back what was answered before, so a decision can be looked up', async () => {
    server.payload = {
      proposals: [],
      decided: [{
        id: 'p0', status: 'merged', signals: ['name_exact', 'phone_exact'], confidence: 'strong',
        snapshot: { a: guest(), b: acct() },
        mergeOutcome: { summary: ['The reservation that had no email address now carries rj@cox.net.'] },
      }],
      openCount: 0, scanned: null,
    }
    await render()
    expect(text()).toMatch(/Already answered/)
    expect(text()).toMatch(/You said: same person/)
    expect(text()).toMatch(/now carries rj@cox\.net/)
  })
})
