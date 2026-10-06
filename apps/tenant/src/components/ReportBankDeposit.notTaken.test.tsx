// @vitest-environment jsdom
/**
 * 10/6 (Nic): "Do you allow tenants to go into the bank and deposit their rent
 * for this unit or for this property? We don't do that here at Mountain View."
 * Where the property does not take rent deposited at the bank, the report
 * window says so in plain words and offers no form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { BANK_DEPOSIT_REPORT_NOT_TAKEN } from '@gam/shared'

const feed = vi.hoisted(() => ({ depositsTaken: false as boolean }))
vi.mock('../lib/api', () => ({
  apiGet: async () => (feed.depositsTaken
    ? { leaseId: 'l1', bankFeedLinked: true, expiresInDays: 7, depositsTaken: true }
    : { leaseId: 'l1', bankFeedLinked: true, expiresInDays: 7, depositsTaken: false, notTakenMessage: 'Your landlord doesn\'t take rent deposited at their bank for this space. Pay online, or pay at the office.' }),
  apiPost: vi.fn(), apiDelete: vi.fn(), apiUpload: vi.fn(),
}))

import { ReportBankDepositModal } from './ReportBankDeposit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
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
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>
      <ReportBankDepositModal leaseId="l1" outstanding={600} onReported={() => {}} onClose={() => {}} />
    </QueryClientProvider>)
  })
}

describe('the report window where the property does not take bank deposits', () => {
  it('says so plainly, with no form', async () => {
    feed.depositsTaken = false
    await show()
    await until(() => text().includes(BANK_DEPOSIT_REPORT_NOT_TAKEN), 'the refusal')
    expect(host.querySelector('input')).toBeNull()
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Done'])
  })

  it('where it does, the form is there', async () => {
    feed.depositsTaken = true
    await show()
    await until(() => !!host.querySelector('#report-deposit-reference'), 'the form')
    expect(text()).not.toContain(BANK_DEPOSIT_REPORT_NOT_TAKEN)
  })
})
