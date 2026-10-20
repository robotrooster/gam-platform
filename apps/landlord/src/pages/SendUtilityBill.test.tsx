// @vitest-environment jsdom
/**
 * 10/20 (Nic) — SEND A BILL, on the screen.
 *
 *   "a lot of people that move out are going to get their final electric bill
 *    as a pay link anyway... to send somebody a pay link for their final bill,
 *    you would have to do it through the point of sale, right? There's no way to
 *    just charge somebody for electric when on move out. Like, how would you do
 *    that? ... The point of sale is just an extension of things."
 *
 * The routes shipped with nothing calling them, so this card is the button. What
 * these tests hold down is the part a screen can get wrong after the API got it
 * right:
 *
 *  - ONE LINK IS ONE PERSON'S BILL. One household is one balance (S652), and the
 *    server refuses a link spanning two payers. If the screen lets a clerk tick
 *    two people's bills and press Send, they get an error they did nothing to
 *    deserve — so Send is refused here, in words, before it is pressed.
 *  - IT NEVER SENDS AN AMOUNT. The request carries bill ids. A final bill that
 *    could go out for a figure somebody typed is the whole reason it works this
 *    way.
 *  - A BILL WITH NOBODY ON FILE still has to be sendable, because the person who
 *    has moved out is exactly the one whose email may be missing — it asks for
 *    the address instead of hiding the bill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  bills: [] as any[],
  posted: [] as any[],
  toasts: [] as string[],
}))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    if (url.startsWith('/pos/pay-links/utility-bills')) return server.bills
    return []
  },
  apiPost: async (url: string, body: any) => {
    server.posted.push({ url, body })
    return { success: true }
  },
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDelete: async () => ({}),
}))
vi.mock('../components/dialogs', () => {
  const toast = (t: string) => { server.toasts.push(t) }
  ;(toast as any).error = (t: string) => { server.toasts.push('ERR ' + t) }
  return { toast, appConfirm: async () => true }
})
vi.mock('../lib/permissions', () => ({ usePerms: () => ({ has: () => true, perms: [] }) }))
vi.mock('../../../../packages/shared-ui/MeterWalk', () => ({ ReadingWalkModal: () => null }))

import { SendUtilityBillCard } from './UtilityMetersPage'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  server.bills = []
  server.posted = []
  server.toasts = []
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** One row of GET /pos/pay-links/utility-bills, as the API camelizes it. */
const bill = (over: Partial<Record<string, any>> = {}) => ({
  billId: over.billId ?? 'b1',
  lineName: over.lineName ?? 'Electric — September 2026 (RV 27)',
  amount: over.amount ?? 81.27,
  payerName: over.payerName ?? 'Andres Razo',
  payerEmail: over.payerEmail ?? 'razoandres60@test.dev',
  utilityType: 'electric',
  billingCycleMonth: '2026-09-01',
  spaceLabel: 'RV 27',
  ...over,
})

async function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <SendUtilityBillCard propertyId="p1" canSend={true} />
        </QueryClientProvider>
      </MemoryRouter>
    )
  })
  await act(async () => { await Promise.resolve() })
}

const text = () => host.textContent || ''
const boxes = () => [...host.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
const sendBtn = () => [...host.querySelectorAll('button')]
  .find(b => (b.textContent || '').includes('Send bill')) as HTMLButtonElement | undefined
const emailBox = () => host.querySelector('#sendbill-to') as HTMLInputElement

/** React binds a checkbox's onChange to the click, so click it. */
async function tick(i: number) {
  await act(async () => { boxes()[i].click() })
}

/** React tracks an input's value, so set it through the native setter. */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('sending a utility bill as a pay link', () => {
  it('sends bill IDS and never an amount', async () => {
    server.bills = [bill()]
    await open()
    await tick(0)
    await act(async () => { sendBtn()!.click() })
    await act(async () => { await Promise.resolve() })

    expect(server.posted).toHaveLength(1)
    const { url, body } = server.posted[0]
    expect(url).toBe('/pos/pay-links/utility-bills')
    expect(body.billIds).toEqual(['b1'])
    expect(body.propertyId).toBe('p1')
    // The figure is the bill's, read on the server. Nothing resembling an
    // amount leaves this screen.
    expect(JSON.stringify(body)).not.toMatch(/81\.27|amount|charge|total/i)
  })

  it('refuses two different people on one link, and says why', async () => {
    server.bills = [
      bill({ billId: 'b1', payerName: 'Andres Razo', payerEmail: 'andres@test.dev' }),
      bill({ billId: 'b2', payerName: 'Victor Cardoza', payerEmail: 'victor@test.dev' }),
    ]
    await open()
    await tick(0)
    await tick(1)

    expect(sendBtn()!.disabled).toBe(true)
    expect(text()).toContain('belong to different people')
    expect(server.posted).toHaveLength(0)
  })

  it('two bills for the SAME person go on one link together', async () => {
    // One household is one balance — power and water owed by the same person is
    // one bill to pay, not two emails.
    server.bills = [
      bill({ billId: 'b1', payerEmail: 'same@test.dev', amount: 81.27 }),
      bill({ billId: 'b2', payerEmail: 'same@test.dev', amount: 18.40, lineName: 'Water — September 2026 (RV 27)' }),
    ]
    await open()
    await tick(0)
    await tick(1)

    expect(sendBtn()!.disabled).toBe(false)
    expect(text()).not.toContain('belong to different people')
    await act(async () => { sendBtn()!.click() })
    await act(async () => { await Promise.resolve() })
    expect(server.posted[0].body.billIds.sort()).toEqual(['b1', 'b2'])
  })

  it('a bill with nobody on file is still sendable once an address is typed', async () => {
    server.bills = [bill({ payerName: null, payerEmail: null })]
    await open()
    await tick(0)

    // The person who moved out is exactly the one whose address may be missing.
    expect(text()).toContain('nobody on file')
    expect(sendBtn()!.disabled).toBe(true)
    expect(text()).toContain('type where it should go')

    await type(emailBox(), 'gone@test.dev')
    expect(sendBtn()!.disabled).toBe(false)
    await act(async () => { sendBtn()!.click() })
    await act(async () => { await Promise.resolve() })
    expect(server.posted[0].body.customer.email).toBe('gone@test.dev')
  })

  it('says plainly when there is nothing to send', async () => {
    server.bills = []
    await open()
    expect(text()).toContain('Nothing to send')
    expect(sendBtn()).toBeUndefined()
  })

  it('shows nothing at all to somebody who cannot send bills', async () => {
    server.bills = [bill()]
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={qc}>
            <SendUtilityBillCard propertyId="p1" canSend={false} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    expect(text()).toBe('')
  })
})
