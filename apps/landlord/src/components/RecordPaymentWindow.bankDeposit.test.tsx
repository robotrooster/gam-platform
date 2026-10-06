/**
 * 10/5 (Nic) — "Bank deposit" at the desk, and part payments.
 *
 * "in Mattoon, they go into the bank and deposit cash into the bank ... a
 * reference number to the bank deposit in case somebody else happens to deposit
 * the same amount. And then also maybe ... add a picture of the receipt ... he
 * would also like it to be able to take a partial payment. Maybe that's
 * something we set at the property level settings".
 *
 *   - Bank deposit is its own button in BOTH record flows (the desk window and
 *     "Post a payment"), asking for the amount deposited, the deposit reference
 *     number (required) and an optional photo of the bank's receipt.
 *   - Where the property takes part payments, the window says plainly what
 *     stays owed after a short payment; where it does not, it is refused.
 *   - The property setting is a checkbox with the one generic line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  quote: null as any,
  /** 10/5: the bill as of a bank deposit's date (?depositedOn=); null: the same as `quote`. */
  datedQuote: null as any,
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  uploads: [] as { url: string; body: any }[],
  patches: [] as { url: string; body: any }[],
  recordResult: null as any,
  postResult: null as any,
}))

vi.mock('../lib/api', () => ({
  api: {
    post: async (url: string, body: any) => { server.uploads.push({ url, body }); return { data: { success: true, data: {} } } },
    get: async () => ({ data: new Blob() }),
  },
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url.includes('/record-manual/quote')) {
      return JSON.parse(JSON.stringify(url.includes('depositedOn=') && server.datedQuote ? server.datedQuote : server.quote))
    }
    if (url.startsWith('/balances/')) return [{ lines: [{ id: 'r1', label: 'Rent', detail: null }, { id: 'r0', label: 'Rent', detail: null }] }]
    if (url.startsWith('/payments?type=rent')) return []
    if (url.includes('/reader/readers')) return []
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url.endsWith('/record-manual')) {
      return { success: true, data: server.recordResult ?? { amountSettled: body.amountTendered, creditUsed: 0, receiptId: 'rem_1' } }
    }
    if (url === '/payments/post-payment') {
      return { success: true, data: server.postResult ?? { applied: body.amount, paidAhead: 0, remittanceId: 'rem_post' } }
    }
    throw new Error(`unexpected POST ${url}`)
  },
  apiPatch: async (url: string, body: any) => { server.patches.push({ url, body }); return {} },
}))
vi.mock('../lib/terminal', () => ({ TAP_WINDOW_SECONDS: 10 }))

import { RecordPaymentWindow, PostPaymentForm } from './RecordPaymentWindow'
import { PartialPaymentsCard } from '../pages/PropertyDetailPage'
import { BankReceiptPhoto } from '../pages/PaymentsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** A $600 October rent bill (a $600 September one first when `withSeptember`). */
const quote = (over: any = {}, withSeptember = false) => {
  const oct = { id: 'r1', leaseId: 'L1', type: 'rent', entryDescription: 'RENT', amount: 600, dueDate: '2026-10-01',
                creditAlreadyApplied: 0, creditIfUsed: 0, notes: null, unitNumber: 'Lot 7', propertyName: 'Country Acres' }
  const sep = { ...oct, id: 'r0', dueDate: '2026-09-01' }
  const rows = withSeptember ? [sep, oct] : [oct]
  const total = rows.length * 600
  return {
    anchorPaymentId: 'r1', anchorOpen: true, paymentsPaused: false, rows,
    currentTotal: total, oldBalance: [], oldBalanceTotal: 0, payOnline: [], payOnlineTotal: 0,
    paused: [], pausedTotal: 0, clearing: 0, creditAlreadyApplied: 0,
    creditAvailable: 0, creditSetAsideElsewhere: 0, creditOnFile: 0,
    owedIfUsed: total, owedIfSaved: total, fullBalance: total, scheduledRetries: [],
    partialPaymentsAllowed: false,
    ...over,
  }
}

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn>
let onRecorded: ReturnType<typeof vi.fn>
beforeEach(() => {
  server.posts = []; server.uploads = []; server.patches = []; server.recordResult = null; server.postResult = null
  server.gets = []; server.datedQuote = null
  onClose = vi.fn(); onRecorded = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
async function openDesk() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc()}>
        <RecordPaymentWindow anchorPaymentId="r1" tenantId="t1" name="Rae Tull" onClose={onClose} onRecorded={onRecorded} />
      </QueryClientProvider>)
  })
  await until(() => text().includes('Full balance'), 'the bill')
}
const text = () => host.textContent ?? ''
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
async function press(re: RegExp) {
  await until(() => !!button(re) && !button(re)!.disabled, `an enabled ${re} button`)
  await act(async () => { button(re)!.click() })
}
async function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** The text box under a field label. */
const field = (label: RegExp) => {
  const l = [...host.querySelectorAll('label.cd-field')].find(x => label.test(x.querySelector('.cd-field-label')?.textContent ?? ''))
  return (l?.querySelector('input') ?? null) as HTMLInputElement | null
}
async function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}
const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'bank-receipt.jpg', { type: 'image/jpeg' })

describe('Bank deposit in the desk window', () => {
  it('is its own button beside Cash, Check and Money order, asking for the amount deposited, the reference (required) and an optional photo', async () => {
    server.quote = quote()
    await openDesk()
    const methods = [...host.querySelectorAll('.cd-methods .cd-option-title')].map(e => e.textContent)
    expect(methods).toEqual(['Cash', 'Check', 'Money order', 'Bank deposit', 'Card on the reader'])
    await press(/^Bank deposit$/)
    const amount = field(/^Amount deposited$/)
    const ref = field(/^Deposit reference number — from the bank's receipt$/)
    const pic = field(/^Photo of the bank's deposit receipt \(optional\)$/)
    expect(amount && ref && pic).toBeTruthy()
    expect(pic!.type).toBe('file')
    await type(amount!, '600')
    // No reference yet: Record cannot be pressed.
    expect(button(/^Record \$600\.00/)!.disabled).toBe(true)
    await type(ref!, 'DEP-7781')
    await pickFile(pic!, photo())
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.posts.filter(p => p.url.endsWith('/record-manual')).map(p => p.body)).toEqual([
      { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-7781' },
    ])
    // The photo goes on the payment just recorded.
    expect(server.uploads).toHaveLength(1)
    expect(server.uploads[0].url).toBe('/payments/remittances/rem_1/deposit-photo')
    expect((server.uploads[0].body as FormData).get('photo')).toBeInstanceOf(File)
  })

  it('records without a photo, and sends no upload', async () => {
    server.quote = quote()
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Amount deposited$/)!, '600')
    await type(field(/^Deposit reference number/)!, 'DEP-1')
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.uploads).toEqual([])
  })

  it('refuses a photo that is not an image, in plain words', async () => {
    server.quote = quote()
    await openDesk()
    await press(/^Bank deposit$/)
    await pickFile(field(/^Photo of the bank's deposit receipt/)!, new File(['%PDF'], 'r.pdf', { type: 'application/pdf' }))
    expect(text()).toContain('Choose a photo (JPEG, PNG, WebP or HEIC) of the bank\'s receipt.')
  })

  it('asks the date deposited (today by default) and sends an earlier one, so the payment counts from that day', async () => {
    server.quote = quote()
    await openDesk()
    await press(/^Bank deposit$/)
    const date = field(/^Date deposited$/)!
    expect(date.type).toBe('date')
    expect(date.value).toBe(date.max)          // today
    await type(field(/^Amount deposited$/)!, '600')
    await type(field(/^Deposit reference number/)!, 'DEP-DATE')
    await type(date, '2026-09-28')
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.posts.filter(p => p.url.endsWith('/record-manual')).map(p => p.body)).toEqual([
      { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-DATE', depositedOn: '2026-09-28' },
    ])
  })

  it('10/5: an earlier date reads the bill as of that day — late fees charged after it are left off — and the result says so', async () => {
    // $600 rent and a $25 late fee charged after the deposit was made.
    const fee = { id: 'f1', leaseId: 'L1', type: 'late_fee', entryDescription: 'LATEFEE', amount: 25, dueDate: '2026-10-06',
                  creditAlreadyApplied: 0, creditIfUsed: 0, notes: null, unitNumber: 'Lot 7', propertyName: 'Country Acres' }
    server.quote = quote({ rows: [quote().rows[0], fee], currentTotal: 625, owedIfUsed: 625, owedIfSaved: 625, fullBalance: 625 })
    server.datedQuote = quote({ lateFeesOffIfPaidInFull: 25 })
    server.recordResult = { amountSettled: 600, creditUsed: 0, receiptId: 'rem_1', lateFeesUnbilled: 25, lateFeesRefunded: 0 }
    await openDesk()
    await press(/^Bank deposit$/)
    expect(text()).toContain('625')
    await type(field(/^Date deposited$/)!, '2026-10-01')
    await until(() => server.gets.some(u => u === '/payments/r1/record-manual/quote?depositedOn=2026-10-01'), 'the bill as of the deposit')
    await until(() => text().includes('Deposited before $25.00 in late fees were charged'), 'the note')
    expect(text()).toContain('they are left off this bill, and come off each bill this deposit pays in full. A bill it pays only in part keeps its late fees.')
    await type(field(/^Amount deposited$/)!, '600')
    await type(field(/^Deposit reference number/)!, 'DEP-OCT1')
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.posts.filter(p => p.url.endsWith('/record-manual')).map(p => p.body)).toEqual([
      { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-OCT1', depositedOn: '2026-10-01' },
    ])
    expect(onRecorded.mock.calls[0][0]).toContain('$25.00 in late fees charged after Oct 1 came off — the money was in the bank that day.')
  })

  // 10/6 (Nic): "the late fee is only deleted during onboarding at landlord's discretion."
  const lateFeeRow = { id: 'f1', leaseId: 'L1', type: 'late_fee', entryDescription: 'LATEFEE', amount: 25, dueDate: '2026-10-06',
                       creditAlreadyApplied: 0, creditIfUsed: 0, notes: null, unitNumber: 'Lot 7', propertyName: 'Country Acres' }
  const withFee = () => quote({ rows: [quote().rows[0], lateFeeRow], currentTotal: 625, owedIfUsed: 625, owedIfSaved: 625, fullBalance: 625 })
  const box = () => [...host.querySelectorAll('label.cd-check')].find(l => /Delete the late fee completely/.test(l.textContent ?? ''))

  it('10/6: on the onboarding bill the box is offered, OFF by default, with its one line — ticked, it is sent', async () => {
    server.quote = withFee()
    server.datedQuote = quote({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: true })
    server.recordResult = { amountSettled: 600, creditUsed: 0, receiptId: 'rem_1', lateFeesUnbilled: 25, lateFeesDeleted: 1 }
    await openDesk()
    await press(/^Bank deposit$/)
    expect(box()).toBeUndefined()                      // dated today: nothing comes off, no box
    await type(field(/^Date deposited$/)!, '2026-10-01')
    await until(() => !!box(), 'the onboarding box')
    expect(box()!.textContent).toBe('Delete the late fee completely (onboarding month)Leaves no late fee on their record. Only for the onboarding month.')
    const input = box()!.querySelector('input') as HTMLInputElement
    expect(input.checked).toBe(false)
    await act(async () => { input.click() })
    await type(field(/^Amount deposited$/)!, '600')
    await type(field(/^Deposit reference number/)!, 'DEP-ONB')
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.posts.filter(p => p.url.endsWith('/record-manual')).map(p => p.body)).toEqual([
      { method: 'bank_deposit', amountTendered: 600, reference: 'DEP-ONB', depositedOn: '2026-10-01', deleteOnboardingLateFees: true },
    ])
    expect(onRecorded.mock.calls[0][0]).toContain('came off')
    expect(onRecorded.mock.calls[0][0]).not.toMatch(/still counts as late/)
  })

  it('10/6: no box after onboarding, or for someone who may not delete a late fee — and nothing extra is sent', async () => {
    server.quote = withFee()
    server.datedQuote = quote({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 25, canDeleteLateFees: false })
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Date deposited$/)!, '2026-10-01')
    await until(() => text().includes('Deposited before $25.00 in late fees were charged'), 'the note')
    expect(box()).toBeUndefined()
  })

  it('10/6: a deposit the tenant never reported — the result says, in one line, that it still counts late', async () => {
    server.quote = withFee()
    server.datedQuote = quote({ lateFeesOffIfPaidInFull: 25, onboardingLateFeesOff: 0, canDeleteLateFees: true })
    server.recordResult = { amountSettled: 600, creditUsed: 0, receiptId: 'rem_1', lateFeesUnbilled: 25, unreportedDepositCountsLate: true }
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Date deposited$/)!, '2026-10-01')
    await until(() => text().includes('Deposited before $25.00 in late fees were charged'), 'the note')
    expect(box()).toBeUndefined()
    await type(field(/^Amount deposited$/)!, '600')
    await type(field(/^Deposit reference number/)!, 'DEP-LATE')
    await press(/^Record \$600\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(onRecorded.mock.calls[0][0]).toBe(
      'Recorded $600.00 from Rae Tull. The late fee came off. They didn\'t report this deposit, so it still counts as late on their payment history.')
  })

  it('cash, a check and a money order have no photo field and no deposit date', async () => {
    server.quote = quote()
    await openDesk()
    for (const m of [/^Cash$/, /^Check$/, /^Money order$/]) {
      await press(m)
      expect(field(/^Photo of the bank's deposit receipt/)).toBeNull()
      expect(field(/^Date deposited$/)).toBeNull()
    }
  })
})

describe('Bank deposit in "Post a payment"', () => {
  it('has the button and the same fields, and posts the reference with it', async () => {
    const onPosted = vi.fn()
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc()}>
          <PostPaymentForm tenantId="t1" name="Rae Tull" onClose={onClose} onPosted={onPosted} />
        </QueryClientProvider>)
    })
    const methods = [...host.querySelectorAll('.cd-methods .cd-option-title')].map(e => e.textContent)
    expect(methods).toEqual(['Cash', 'Check', 'Money order', 'Bank deposit'])
    await press(/^Bank deposit$/)
    expect(field(/^Amount deposited$/)).toBeTruthy()
    expect(field(/^Photo of the bank's deposit receipt \(optional\)$/)).toBeTruthy()
    await type(field(/^Amount deposited$/)!, '300')
    expect(button(/^Post \$300\.00/)!.disabled).toBe(true)   // the reference is required
    await type(field(/^Deposit reference number — from the bank's receipt$/)!, 'DEP-AHEAD')
    await pickFile(field(/^Photo of the bank's deposit receipt/)!, photo())
    await press(/^Post \$300\.00/)
    expect(text()).toContain("Is the bank deposit really $300.00? Check the amount on the bank's receipt.")
    await press(/^Yes, post \$300\.00/)
    await until(() => onPosted.mock.calls.length === 1, 'the payment posted')
    expect(server.posts.find(p => p.url === '/payments/post-payment')!.body).toMatchObject({
      tenantId: 't1', method: 'bank_deposit', amount: 300, reference: 'DEP-AHEAD',
    })
    expect(server.uploads.map(u => u.url)).toEqual(['/payments/remittances/rem_post/deposit-photo'])
  })
})

describe('part payments at the desk', () => {
  it('where the property does not take them, a short payment is refused as before', async () => {
    server.quote = quote({ partialPaymentsAllowed: false })
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Amount deposited$/)!, '500')
    await type(field(/^Deposit reference number/)!, 'DEP-2')
    expect(text()).toContain('That is $100.00 short — $500.00 against $600.00 owed. Rent is paid in full.')
    expect(button(/^Record \$500\.00/)!.disabled).toBe(true)
  })

  it('where it does, the window says plainly what stays owed — and records it', async () => {
    server.quote = quote({ partialPaymentsAllowed: true })
    server.recordResult = {
      amountSettled: 500, creditUsed: 0, receiptId: 'rem_1', partial: true, stillOwed: 100,
      stillOwedRows: [{ id: 'rest_1', restOf: 'r1', type: 'rent', dueDate: '2026-10-01', amount: 100 }],
    }
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Amount deposited$/)!, '500')
    await type(field(/^Deposit reference number/)!, 'DEP-3')
    await until(() => text().includes('Part payment. $100.00 stays owed on October rent — late fees still apply.'), 'the part-payment line')
    expect(text()).not.toContain('Rent is paid in full')
    await press(/^Record \$500\.00/)
    await until(() => onRecorded.mock.calls.length === 1, 'the payment recorded')
    expect(server.posts.find(p => p.url.endsWith('/record-manual'))!.body).toEqual({ method: 'bank_deposit', amountTendered: 500, reference: 'DEP-3' })
    expect(onRecorded.mock.calls[0][0]).toBe('Recorded $500.00 from Rae Tull — $100.00 stays owed on October rent — late fees still apply.')
  })

  it('10/5: a dated-back deposit paid only in part — the late fees left off the bill it pays in part are added back to what stays owed', async () => {
    const withInv = (q: any) => ({ ...q, rows: q.rows.map((r: any) => ({ ...r, invoiceId: r.id === 'r0' ? 'INV-SEP' : 'INV-OCT' })) })
    server.quote = withInv(quote({ partialPaymentsAllowed: true }, true))
    // As of the deposit's day: each bill's $25 late fee left off.
    server.datedQuote = withInv(quote({
      partialPaymentsAllowed: true, lateFeesOffIfPaidInFull: 50,
      lateFeesOffByBill: [{ invoiceId: 'INV-SEP', amount: 25 }, { invoiceId: 'INV-OCT', amount: 25 }],
    }, true))
    await openDesk()
    await press(/^Bank deposit$/)
    await type(field(/^Date deposited$/)!, '2026-10-01')
    await until(() => text().includes('Deposited before $50.00 in late fees were charged'), 'the note')
    await type(field(/^Amount deposited$/)!, '900')
    await type(field(/^Deposit reference number/)!, 'DEP-2B')
    // September is paid in full (its fee stays off); October is paid in part and keeps its own $25.
    await until(() => text().includes('Part payment. $325.00 stays owed on October rent — late fees still apply. That includes $25.00 in late fees, which stay on a bill paid only in part.'),
      'the part-payment line with October\'s fee back on it')
  })

  it('pays the oldest bill first: with September and October open, $800 leaves $400 owed on October rent', async () => {
    server.quote = quote({ partialPaymentsAllowed: true }, true)
    await openDesk()
    await press(/^Cash$/)
    await type(field(/^Cash handed over$/)!, '800')
    await until(() => text().includes('$400.00 stays owed on October rent — late fees still apply.'), 'the part-payment line')
    expect(text()).not.toContain('September rent — late')
  })
})

describe('the property setting', () => {
  it('is a checkbox, off by default, with the one generic line — and turning it on saves it', async () => {
    const onSaved = vi.fn()
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc()}>
          <PartialPaymentsCard property={{ id: 'p1', acceptPartialPayments: false }} onSaved={onSaved} />
        </QueryClientProvider>)
    })
    expect(text()).toContain('Accept partial payments')
    expect(text()).toContain('Some places limit what happens after you accept part of the rent — check your local laws.')
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    await act(async () => { box.click() })
    await until(() => server.patches.length === 1, 'the setting saved')
    expect(server.patches[0]).toEqual({ url: '/properties/p1/partial-payments', body: { accept: true } })
    await until(() => onSaved.mock.calls.length === 1, 'the page told')
  })

  it('says what it does when it is on', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc()}>
          <PartialPaymentsCard property={{ id: 'p1', acceptPartialPayments: true }} onSaved={() => {}} />
        </QueryClientProvider>)
    })
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    expect(text()).toContain('It pays the oldest bills first; what is left stays owed, and late fees still apply to it. Tenants paying online still pay in full.')
  })
})

describe('the bank receipt photo on the Payments ledger', () => {
  it('opens in a window inside the app (never a new tab Safari would block), and closes', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    await act(async () => {
      root.render(<BankReceiptPhoto receiptId="rem_1" url="/api/payments/deposit-photos/abc.jpg" canAdd onAdded={() => {}} />)
    })
    await press(/^Bank receipt photo$/)
    expect(host.querySelector('.modal-overlay')).toBeTruthy()
    expect(host.querySelector('.modal-title')?.textContent).toBe('Bank receipt photo')
    expect(opened).not.toHaveBeenCalled()
    await press(/^Close$/)
    expect(host.querySelector('.modal-overlay')).toBeNull()
    opened.mockRestore()
  })

  it('"Add a photo of the bank\'s receipt" is a gold action button', async () => {
    await act(async () => {
      root.render(<BankReceiptPhoto receiptId="rem_1" url={null} canAdd onAdded={() => {}} />)
    })
    const add = [...host.querySelectorAll('label')].find(l => /Add a photo of the bank's receipt/.test(l.textContent ?? ''))!
    expect(add.className).toMatch(/\bbtn btn-primary btn-sm\b/)
  })
})
