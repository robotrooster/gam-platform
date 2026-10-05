/**
 * S655 money plan, Step 13 — autopay's "Use my account credit first" (Nic,
 * 10/2: the tenant's own setting, off by default), and the methods a monthly
 * schedule may depend on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  autopay: [] as any[],
  methods: [] as any[],
  puts: [] as any[],
}))

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/autopay') return server.autopay
    if (url === '/stripe/tenant/payment-methods') return server.methods
    throw new Error(`unexpected GET ${url}`)
  },
  apiPut: async (url: string, body: any) => { server.puts.push({ url, body }); return {} },
  apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}))

import { AutopaySection } from './AutopayCard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const row = (over: any = {}) => ({
  leaseId: 'L1', propertyName: 'Oak Park', unitNumber: 'MH 09', rentDueDay: 1, lateFeeGraceDays: 5,
  lateFeeEnabled: true, autopayId: null, enabled: null, pullDay: null, paymentMethodId: null,
  useCredit: false, lastSuccessCycle: null, disarmedAt: null, disarmedReason: null, ...over,
})
const methods = [
  { id: 'pm_ok', type: 'ach', bankName: 'Chase', last4: '1111', verified: true, verifying: false, verificationStep: null, chargeable: true, isDefault: true },
  { id: 'pm_wait', type: 'ach', bankName: 'Wells Fargo', last4: '2222', verified: false, verifying: true, verificationStep: 'deposits', chargeable: false },
  { id: 'pm_paused', type: 'ach', bankName: 'Citi', last4: '3333', verified: true, verifying: false, verificationStep: null, chargeable: false },
  { id: 'pm_card', type: 'card', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, country: 'US', verified: true, chargeable: true },
]

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.puts = []
  server.methods = methods
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { root.render(<QueryClientProvider client={qc}><AutopaySection /></QueryClientProvider>) })
}
const text = () => host.textContent ?? ''
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function press(label: string) {
  await until(() => !!button(label), `a "${label}" button`)
  await act(async () => { button(label)!.click() })
}
const creditBox = () => [...host.querySelectorAll('label')]
  .find((l) => l.textContent?.startsWith('Use my account credit first'))?.querySelector('input') as HTMLInputElement | undefined

describe('autopay and account credit', () => {
  it('"Use my account credit first" is off by default, and turning autopay on sends it off', async () => {
    server.autopay = [row()]
    await render()
    await press('Set up autopay')
    expect(creditBox()!.checked).toBe(false)
    expect(text()).toContain('we charge the whole bill and your credit waits until you choose to use it')
    // The bill run skips a bill with a GAM charge, a neighbor's utility or a
    // scheduled retry on it — the copy never promises "always".
    expect(text()).toContain('Credit is applied by itself only when it covers a whole bill.')
    expect(text()).not.toMatch(/always pays it by itself/)
    await press('Turn on autopay')
    expect(server.puts).toEqual([{ url: '/autopay', body: { leaseId: 'L1', enabled: true, pullDay: null, paymentMethodId: null, useCredit: false } }])
  })

  it('turning it on is saved with the schedule', async () => {
    server.autopay = [row()]
    await render()
    await press('Set up autopay')
    await act(async () => { creditBox()!.click() })
    expect(text()).toContain('Any account credit pays its part of the bill and we charge the rest.')
    await press('Turn on autopay')
    expect(server.puts[0].body.useCredit).toBe(true)
  })

  it('an autopay that uses credit says so; one that does not says the credit is kept', async () => {
    server.autopay = [row({ enabled: true, useCredit: true })]
    await render()
    await until(() => text().includes('Your account credit is used first; we charge the rest.'), 'the on state')
  })

  it('says autopay charges the whole bill and never an earlier balance carried onto the account', async () => {
    // services/rentCharge: "Autopay is always exact: it pays the bill, never
    // ahead and never the old balance" (S622).
    server.autopay = [row({ enabled: true })]
    await render()
    await until(() => text().includes('We charge your whole bill on that day, whatever it is then.'), 'the on state')
    expect(text()).toContain('An earlier balance carried onto your account isn\'t included.')
    expect(text()).not.toContain('whole balance')
    await press('Change')
    expect(text()).toContain('We charge your whole bill on that day — rent plus anything else billed to your account at that moment.')
    expect(text()).toContain('An earlier balance carried onto your account isn\'t included — pay it down yourself on the Payments page.')
    expect(text()).not.toContain('whole balance')
    await act(async () => { creditBox()!.click() })
    expect(text()).toContain('at that moment, less the account credit used.')
  })

  it('Cancel puts the setting back as it was', async () => {
    server.autopay = [row({ enabled: true, useCredit: true })]
    await render()
    await press('Change')
    await act(async () => { creditBox()!.click() })
    expect(creditBox()!.checked).toBe(false)
    await press('Cancel')
    await press('Change')
    expect(creditBox()!.checked).toBe(true)
    expect(server.puts).toEqual([])
  })

  it('only a method that can be charged is offered: never a bank still verifying or with bank payments paused', async () => {
    server.autopay = [row()]
    await render()
    await press('Set up autopay')
    const options = [...host.querySelectorAll('option')].map((o) => o.textContent)
    expect(options).toContain('Chase ····1111')
    expect(options).toContain('VISA ····4242')
    expect(options).not.toContain('Wells Fargo ····2222')
    expect(options).not.toContain('Citi ····3333')
  })
})
