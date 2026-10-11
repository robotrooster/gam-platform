// @vitest-environment jsdom
/**
 * 10/6 (Nic) — "about what time were you at the bank?"
 *
 *   - Required: the report cannot be sent until an hour is picked (8 AM … 6 PM
 *     by the hour, or After hours / ATM).
 *   - The hint says why: it tells their deposit apart from someone else's for
 *     the same amount.
 *   - The hour goes with the report, and the tenant's own list says it back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { DEPOSIT_HOUR_HINT } from '@gam/shared'

const api = vi.hoisted(() => ({ posts: [] as { url: string; body: any }[] }))
vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.startsWith('/declared-deposits/feed/')) return { leaseId: 'L1', bankFeedLinked: true, expiresInDays: 7, depositsTaken: true }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    api.posts.push({ url, body })
    return { success: true, data: { id: 'rep_1', message: 'Reported. We will apply it automatically.' } }
  },
  apiUpload: vi.fn(),
  apiDelete: vi.fn(),
}))

import { ReportBankDepositModal, ReportedDeposits } from './ReportBankDeposit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  api.posts = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function setValue(el: HTMLInputElement | HTMLSelectElement, v: string, event: 'input' | 'change') {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event(event, { bubbles: true })) })
}

async function openFilledForm() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReportBankDepositModal leaseId="L1" outstanding={450} onReported={() => {}} onClose={() => {}} />
      </QueryClientProvider>)
  })
  await until(() => !!button(/^Report this deposit$/) && text().includes('watch'), 'the form')
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
  await setValue(host.querySelector('#report-deposit-reference') as HTMLInputElement, 'DEP-5', 'input')
}

describe('about what time they were at the bank', () => {
  it('asks, says why, and offers 8 AM through 6 PM and After hours / ATM', async () => {
    await openFilledForm()
    const label = host.querySelector('label[for="report-deposit-hour"]')
    expect(label?.textContent).toBe('About what time?')
    expect(text()).toContain(DEPOSIT_HOUR_HINT)
    expect(DEPOSIT_HOUR_HINT).toBe(
      'Pick the hour you were at the bank — it helps us find your deposit when someone else deposits the same amount.')
    const options = [...(host.querySelector('#report-deposit-hour') as HTMLSelectElement).options].map(o => o.textContent)
    expect(options).toEqual(['Pick a time', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM',
      '5 PM', '6 PM', 'After hours / ATM'])
  })

  it('cannot be sent until a time is picked; the hour goes with the report', async () => {
    await openFilledForm()
    expect(button(/^Report this deposit$/)!.disabled).toBe(true)
    await setValue(host.querySelector('#report-deposit-hour') as HTMLSelectElement, '15', 'change')
    expect(button(/^Report this deposit$/)!.disabled).toBe(false)
    await act(async () => { button(/^Report this deposit$/)!.click() })
    await until(() => api.posts.length === 1, 'the report')
    expect(api.posts[0].body).toMatchObject({ reference: 'DEP-5', depositHour: 15 })
  })

  it('after hours / ATM is sent as such', async () => {
    await openFilledForm()
    await setValue(host.querySelector('#report-deposit-hour') as HTMLSelectElement, 'after_hours', 'change')
    await act(async () => { button(/^Report this deposit$/)!.click() })
    await until(() => api.posts.length === 1, 'the report')
    expect(api.posts[0].body.depositHour).toBe('after_hours')
  })

  it('the tenant’s list says the time back', async () => {
    await act(async () => {
      root.render(<ReportedDeposits onWithdrawn={() => {}} reports={[
        { id: 'r1', amount: 450, declaredDate: '2026-10-02', method: 'cash', reference: 'DEP-5', status: 'pending',
          bankFeedLinked: true, depositHour: 15, afterHours: false },
        { id: 'r2', amount: 120, declaredDate: '2026-10-02', method: 'cash', reference: 'DEP-6', status: 'pending',
          bankFeedLinked: true, depositHour: null, afterHours: true },
      ]} />)
    })
    expect(text()).toContain('about 3 PM')
    expect(text()).toContain('after hours or at an ATM')
  })
})
