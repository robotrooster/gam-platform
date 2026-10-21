// @vitest-environment jsdom
/**
 * 10/20 (review) — A CLOSING READ ON THE TICKET MUST NOT SHUT THE WAY OUT.
 *
 * Nic, on a meter read taken with the payer standing there: "I don't want it to
 * generate a bill." So the counter raises the bill and stops — the ticket IS
 * the bill. D2 is the other half of that: "if it is not paid — they walk off,
 * or the desk clears the cart — the bill stays owed" and falls back to the
 * ordinary route, their invoice or an emailed link, because the power was
 * genuinely used and nothing in GAM is written off by not being collected at a
 * counter.
 *
 * It did not fall back. The bill's cart line carries the register's own key for
 * it ('bill-<uuid>'), and the three doors that are not the sale each wrote
 * their own copy of the cart→wire mapping: Clear sent that key to the ticket
 * door, which takes register items by their real ids, and was refused. The
 * refusal meant resetRegister never ran, so the release never ran either — and
 * because one open ask per bill is all the database allows, that bill was then
 * off the Pay Links list AND on nobody's invoice. Uncollectable by either route
 * until the twelve-hour sweep let it go.
 *
 * This drives the real register: the real closing-read modal, the real cart,
 * the real Clear. The only stand-in is the network, and the ticket door's reply
 * is the real one — ticketSchema takes items[].id as a uuid
 * (apps/api/src/routes/pos.ts, ticketSchema) and answers 400 in those words for
 * anything else, which is exactly what the register used to send it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const PROP = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ITEM = '33333333-3333-4333-8333-333333333333'
const BILL = '44444444-4444-4444-8444-444444444444'
const METER = '55555555-5555-4555-8555-555555555555'
const STAY = '66666666-6666-4666-8666-666666666666'
const TICKET = '77777777-7777-4777-8777-777777777777'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const server = vi.hoisted(() => ({
  posts: [] as { url: string; body: any }[],
  toasts: [] as string[],
}))

vi.mock('./lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.startsWith('/properties')) return [{ id: PROP, name: 'Mountain View RV' }]
    if (url.startsWith('/pos/items')) {
      return [{ id: ITEM, name: 'Propane · 20 lb', sellPrice: 24.5, taxRate: 0, category: 'Propane',
                icon: '🔥', chargeEligible: true, stockQty: 40, isActive: true, propertyId: PROP, stayUnit: null }]
    }
    if (url.startsWith('/pos/settings')) return { defaultMarginPct: null }
    if (url.startsWith('/pos/categories')) return [{ id: 'cat-1', name: 'Propane', isActive: true, propertyId: PROP }]
    // D3: GAM finds the site from their own reservation — the desk confirms which.
    if (url.startsWith('/pos/final-utility/customer')) {
      return {
        matchedBy: 'email',
        closings: [{ id: STAY, kind: 'stay', what: 'RV 27 · Oct 12 – Oct 20',
                     meters: [{ meterId: METER, label: 'Electric · RV 27', digits: 5, noBaseline: false,
                                usageUnit: 'kWh', usageNoun: 'power' }] }],
      }
    }
    return []
  },
  apiPost: async (url: string, body?: any) => {
    server.posts.push({ url, body })
    if (url === '/pos/final-utility/quote') {
      // The one window in blind entry: the usage and the dollar amount, for the
      // desk to read out to the person about to pay it.
      return { success: true, data: { reads: [{ meterId: METER, usage: 311, amount: 87.77,
                                                note: '311 kWh · $87.77', block: false }] } }
    }
    if (url === '/pos/final-utility/confirm') {
      return { success: true, data: { lines: [{ utilityBillId: BILL, name: 'Electric · Oct · RV 27',
                                                price: 81.27, tax: 0.08 }], notes: [] } }
    }
    if (url === '/pos/tickets') {
      // The ticket door's own answer. A ticket holds register items by their
      // real ids; anything else is refused before it can be written up.
      for (const it of (body?.items ?? [])) {
        if (!UUID.test(String(it?.id))) {
          const e: any = new Error('400')
          e.response = { status: 400, data: { error: 'One of those items is not on your register any more — take it out of the cart, then press the button again.' } }
          throw e
        }
      }
      return { success: true, data: { id: TICKET } }
    }
    if (url === '/pos/final-utility/release') return { success: true, data: { released: (body?.billIds ?? []).length } }
    return { success: true, data: {} }
  },
  apiPatch: async () => ({ success: true, data: {} }),
  apiPut: async () => ({ success: true, data: {} }),
  apiDel: async () => ({ success: true, data: {} }),
}))

vi.mock('./context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'landlord', allProperties: true, permissions: {} } }),
}))
vi.mock('./components/dialogs', () => ({ appConfirm: async () => true, appPrompt: async () => null }))
vi.mock('./lib/syncQueue', () => ({
  enqueue: async () => {}, preloadMapping: () => {}, mintClientId: () => 'csid-1',
}))
vi.mock('./lib/terminal', () => ({
  discoverReaders: async () => [], connectReader: async () => ({}), collectCardPayment: async () => ({}),
  cancelCurrentPayment: async () => {}, clearReaderPrompt: async () => {}, createTerminalIntent: async () => ({}),
  processIntentOnReader: async () => ({}), pollPiUntilTerminal: async () => ({}), cancelTerminalIntent: async () => {},
  showCartOnReader: async () => {}, TAP_WINDOW_SECONDS: 20,
  listRegisteredReaders: async () => [], registerNewReader: async () => ({}), archiveRegisteredReader: async () => ({}),
}))
vi.mock('./pages/POSPayLinks', () => ({ SendPayLinkModal: () => null, PayLinksTab: () => null }))
// The picker is driven by one button so the test picks the person the way the
// desk does — everything after that is the real register.
vi.mock('./components/POSCustomerPicker', () => ({
  POSCustomerPicker: ({ onChange }: any) => (
    <button data-pick="1" onClick={() => onChange({ kind: 'resident', tenantId: TENANT, customerId: null, name: 'Curtis Blu', hint: 'resident' })}>
      pick
    </button>
  ),
  toastOnce: (t: string) => { server.toasts.push(t) },
  errorMessage: (e: any, fallback: string) => {
    const raw = e?.response?.data?.error
    return (typeof raw === 'string' ? raw : raw?.message) || fallback
  },
}))

import { POSPage } from './pages/POSPage'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) =>
  [...host!.querySelectorAll('button')].find(b => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined
const press = async (el: Element | undefined) => {
  expect(el, 'the button the desk presses is on screen').toBeTruthy()
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
const ticketPosts = () => server.posts.filter(p => p.url === '/pos/tickets')
const releasePosts = () => server.posts.filter(p => p.url === '/pos/final-utility/release')

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter><POSPage /></MemoryRouter></QueryClientProvider>)
  })
  await flush()
}

/** The desk picks the customer, takes the read, and puts it on the ticket. */
async function raiseClosingRead() {
  await press(host!.querySelector('[data-pick]') ?? undefined)
  await press(button('Closing read · final utility'))
  await press([...host!.querySelectorAll('button')].find(b => (b.textContent || '').includes('RV 27 · Oct 12')))
  const meter = host!.querySelector('input[placeholder^="Read off the face of"]') as HTMLInputElement
  expect(meter, 'a box for the submeter the site has (D4)').toBeTruthy()
  await type(meter, '48311')
  // D5: typing the number writes nothing — checking it shows the amount.
  await press(button('Check the read'))
  expect(text()).toContain('$87.77')
  expect(server.posts.some(p => p.url === '/pos/final-utility/confirm')).toBe(false)
  await press(button('Put it on the ticket'))
  expect(text()).toContain('Electric · Oct · RV 27')
  expect(text()).toContain('their bill · collected in full')
}

beforeEach(() => { server.posts = []; server.toasts = []; window.history.replaceState({}, '', '/') })
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('a closing read raised at the register, and the three ways out that are not the sale', () => {
  it('Clear with nothing else in the cart lets the bill go — it is owed as usual', async () => {
    await render()
    await raiseClosingRead()

    await press(button('Clear'))

    // D2: the ask is let go, so the ordinary route can have it back. This is
    // the assertion the wedge failed — the release never ran at all.
    expect(releasePosts().map(p => p.body)).toEqual([{ propertyId: PROP, billIds: [BILL] }])
    // And nothing is written up: a ticket holds register items, and the bill is
    // not one. Before the fix this POSTed the bill's own line and was refused,
    // which is why the release above never ran.
    expect(ticketPosts()).toEqual([])
    expect(text()).toContain('No items added')
    expect(server.toasts.join(' | ')).toContain('its bill is owed as usual')
  })

  it('Clear with a sale beside it holds the sale and still lets the bill go', async () => {
    await render()
    await press([...host!.querySelectorAll('button')].find(b => (b.textContent || '').includes('Propane · 20 lb')))
    await raiseClosingRead()

    await press(button('Clear'))

    // The propane is held under their name, by its own id — and the bill's
    // line is not on it.
    expect(ticketPosts()).toHaveLength(1)
    expect(ticketPosts()[0].body.items).toEqual([{ id: ITEM, name: 'Propane · 20 lb', qty: 1, price: 24.5, tax: 0 }])
    expect(JSON.stringify(ticketPosts()[0].body)).not.toContain('bill-')
    expect(releasePosts().map(p => p.body)).toEqual([{ propertyId: PROP, billIds: [BILL] }])
    expect(text()).toContain('No items added')
  })

  it('the emailed link is not offered while the read is on the ticket, and is offered again once it is off', async () => {
    await render()
    await press([...host!.querySelectorAll('button')].find(b => (b.textContent || '').includes('Propane · 20 lb')))
    await raiseClosingRead()

    // A link's line cannot name a bill, so sending this cart would be a second
    // place to pay it. The door that cannot do the thing is not offered — and
    // it says where the door is.
    expect(button('Email a pay link')!.disabled).toBe(true)
    expect(text()).toContain('send that bill from Pay Links')

    await press([...host!.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'take it off'))
    expect(releasePosts().map(p => p.body)).toEqual([{ propertyId: PROP, billIds: [BILL] }])
    expect(button('Email a pay link')!.disabled).toBe(false)
  })
})
