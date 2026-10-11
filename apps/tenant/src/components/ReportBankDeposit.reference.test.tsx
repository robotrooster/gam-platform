// @vitest-environment jsdom
/**
 * 10/5 (Nic) — "When they record the payment themselves in their portal, it
 * needs to have the date of the deposit as well..."
 *
 *   - The deposit reference number from the bank's receipt is REQUIRED: the
 *     report cannot be sent without it, and it is sent trimmed.
 *   - A photo of the bank's receipt is optional (images only): it goes up on
 *     the report just made; a file that is not a photo is refused in words.
 *   - A report the bank showed on a later day says, on the tenant's own
 *     report, that the bank's date was used and why — without accusing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const api = vi.hoisted(() => ({
  posts: [] as { url: string; body: any }[],
  uploads: [] as { url: string; form: FormData }[],
}))
vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url.startsWith('/declared-deposits/feed/')) return { leaseId: 'L1', bankFeedLinked: true, expiresInDays: 7 }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    api.posts.push({ url, body })
    return { success: true, data: { id: 'rep_1', message: 'Reported. We will apply it automatically.' } }
  },
  apiUpload: async (url: string, form: FormData) => { api.uploads.push({ url, form }); return { id: 'rep_1' } },
  apiDelete: vi.fn(),
}))

import { ReportBankDepositModal, ReportedDeposits } from './ReportBankDeposit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  api.posts = []; api.uploads = []
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
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}
const byLabel = (label: string) => {
  const l = [...host.querySelectorAll('label')].find(x => (x.textContent ?? '').trim().startsWith(label))
  return (l?.htmlFor ? host.querySelector(`#${l.htmlFor}`) : null) as HTMLInputElement | null
}

async function openForm() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReportBankDepositModal leaseId="L1" outstanding={450} onReported={() => {}} onClose={() => {}} />
      </QueryClientProvider>)
  })
  await until(() => !!button(/^Report this deposit$/) && text().includes('watch'), 'the form')
  await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click() })
  // 10/6 (Nic): about what time — required (ReportBankDeposit.hour.test.tsx).
  await pickHour('15')
}
async function pickHour(v: string) {
  const sel = host.querySelector('#report-deposit-hour') as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('reporting a bank deposit — the reference number', () => {
  it('cannot be sent without the deposit reference number from the bank’s receipt', async () => {
    await openForm()
    const ref = byLabel('Deposit reference number — from the bank\'s receipt')
    expect(ref).toBeTruthy()
    expect(button(/^Report this deposit$/)!.disabled).toBe(true)
    await type(ref!, '   ')
    expect(button(/^Report this deposit$/)!.disabled).toBe(true)
    await type(ref!, '  004417 ')
    expect(button(/^Report this deposit$/)!.disabled).toBe(false)
    await act(async () => { button(/^Report this deposit$/)!.click() })
    await until(() => api.posts.length === 1, 'the report')
    expect(api.posts[0]).toMatchObject({ url: '/declared-deposits', body: { leaseId: 'L1', amount: 450, method: 'cash', reference: '004417' } })
    expect(api.uploads).toEqual([])
  })
})

describe('reporting a bank deposit — the photo of the bank’s receipt', () => {
  it('is optional; a photo picked goes up on the report just made', async () => {
    await openForm()
    await type(byLabel('Deposit reference number — from the bank\'s receipt')!, 'DEP-5')
    const pic = byLabel('Photo of the bank’s receipt')!
    expect(pic.type).toBe('file')
    expect(pic.accept).toBe('image/*')
    await pickFile(pic, new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'receipt.jpg', { type: 'image/jpeg' }))
    await act(async () => { button(/^Report this deposit$/)!.click() })
    await until(() => api.uploads.length === 1, 'the photo')
    expect(api.uploads[0].url).toBe('/declared-deposits/rep_1/receipt-photo')
    expect((api.uploads[0].form.get('photo') as File).name).toBe('receipt.jpg')
    await until(() => text().includes('Reported.'), 'the confirmation')
  })

  it('a file that is not a photo is refused in words, and nothing is picked', async () => {
    await openForm()
    await pickFile(byLabel('Photo of the bank’s receipt')!, new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' }))
    expect(text()).toContain('Choose a photo (JPEG, PNG, WebP or HEIC) of the bank\'s receipt.')
  })
})

describe('a report the bank showed on a later day', () => {
  const flagged = {
    id: 'r9', leaseId: 'L1', amount: 450, declaredDate: '2026-10-01', method: 'cash', reference: 'DEP-1',
    status: 'confirmed', bankDateUsed: true, bankPostedDate: '2026-10-06', confirmedOn: '2026-10-06',
  }

  it('says the bank’s date was used, and why, without accusing — and cannot be taken back', async () => {
    await act(async () => { root.render(<ReportedDeposits reports={[flagged]} onWithdrawn={() => {}} />) })
    expect(text()).toContain(
      'The bank shows this deposit on Oct 6, not Oct 1. A deposit counts from the day you made it only when the bank shows it '
      + 'that day or the next business day, so your payment counts from Oct 6, and any late fees up to then stay.')
    expect(text()).toContain('Ref DEP-1')
    expect(text()).not.toMatch(/false|lie|fraud|flag/i)
    expect(button(/I hadn’t paid/)).toBeUndefined()
  })

  it('a confirmed report whose date held is not listed', async () => {
    await act(async () => {
      root.render(<ReportedDeposits reports={[{ ...flagged, bankDateUsed: false }]} onWithdrawn={() => {}} />)
    })
    expect(text()).toBe('')
  })
})
