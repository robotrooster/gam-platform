/**
 * S655 money plan, Step 14 (fix round) — the desk window self-heals.
 *
 * Staff screens are foolproof (Nic 10/2): fresh figures at the moment of
 * action; a figure that moved under the desk's answer is asked again IN PLACE
 * (never sent silently, never "reload"); each message once, with the next step;
 * Cancel writes nothing; and the change to hand back stays up until Done
 * (decisions #16's rule for the register, kept at the desk).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, focusManager } from 'react-query'

const server = vi.hoisted(() => ({
  quote: null as any,
  readerQuote: null as any,
  intentStatus: 'requires_payment_method',
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  recordFails: [] as { status: number; error: string; then?: () => void }[],
  recordResult: null as any,
  /** When set, Record waits on it (a POST in flight). */
  recordHold: null as Promise<void> | null,
  /** When set, a reader quote is worked out from its URL (the Use / Save answer, the old-balance amount). */
  readerQuoteFor: null as ((url: string) => any) | null,
  /** When set, reader quotes for a Use / Save answer wait on it. */
  readerGate: null as Promise<void> | null,
  /** When set, GET /payments?type=rent answers page by page (page number → rows). */
  rentPages: null as Record<number, any[]> | null,
  /** When set, runs as the reader's card is captured (the server books the space then). */
  onCapture: null as (() => void) | null,
  /** The property's paired readers. */
  readers: [{ stripeReaderId: 'rdr_1', nickname: 'Front desk reader' }] as { stripeReaderId: string; nickname: string }[],
  /** Charges no longer open: the reader routes refuse them (readerAnchor's 409). */
  closed: new Set<string>(),
  /** When set, putting a breakdown on the reader waits on it. */
  showHold: null as Promise<void> | null,
  /** When set, reading the desk bill waits on it (a slow read). */
  quoteHold: null as Promise<void> | null,
}))

const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url.includes('/record-manual/quote')) {
      if (server.quoteHold) await server.quoteHold
      return JSON.parse(JSON.stringify(server.quote))
    }
    if (url.startsWith('/balances/')) return []
    if (url.startsWith('/payments?type=rent')) {
      if (!server.rentPages) return []
      return server.rentPages[Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1)] ?? []
    }
    const anchor = /^\/payments\/([^/]+)\/reader\/(readers|quote)/.exec(url)
    if (anchor && server.closed.has(anchor[1])) throw httpError(409, 'This charge is not open (status: processing)')
    if (url.includes('/reader/readers')) return JSON.parse(JSON.stringify(server.readers))
    if (url.includes('/reader/quote')) {
      if (server.readerGate && /useCredit=/.test(url)) await server.readerGate
      return JSON.parse(JSON.stringify(server.readerQuoteFor ? server.readerQuoteFor(url) : server.readerQuote))
    }
    if (url.startsWith('/payments/reader/intents/')) return { status: server.intentStatus, lastPaymentError: null }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (url.endsWith('/record-manual')) {
      if (server.recordHold) await server.recordHold
      // services/manualPaymentSettle: cash over what is paid, with no answer to
      // "Give change or Keep it", is refused (the keepsMoney rule).
      const q = server.quote
      const owed = (body.creditToUse ?? 0) > 0 ? q.owedIfUsed : q.owedIfSaved
      if (body.method === 'cash' && body.amountTendered > owed && body.surplusHandling == null
          && (body.towardOldBalance ?? 0) < body.amountTendered - owed) {
        throw httpError(422, `That is $${(body.amountTendered - owed).toFixed(2)} over. Choose "Give change" or "Keep it — no change on hand".`)
      }
      const fail = server.recordFails.shift()
      if (fail) { fail.then?.(); throw httpError(fail.status, fail.error) }
      return { success: true, data: server.recordResult ?? { amountSettled: body.amountTendered, creditUsed: body.creditToUse ?? 0 } }
    }
    if (url.endsWith('/reader/show')) {
      if (server.showHold) await server.showHold
      return { success: true, data: { shown: false } }
    }
    if (url.endsWith('/reader/charge')) {
      const n = server.posts.filter(p => p.url.endsWith('/reader/charge')).length
      return { success: true, data: { paymentIntentId: `pi_${n}` } }
    }
    if (url.endsWith('/capture')) {
      server.onCapture?.()
      return { success: true, data: { total: (server.readerQuote ?? {}).total } }
    }
    if (url.includes('/reader/intents/')) return { success: true, data: {} }
    if (url === '/payments/post-payment') return { success: true, data: { applied: body.amount, paidAhead: 0 } }
    throw new Error(`unexpected POST ${url}`)
  },
}))
vi.mock('../lib/terminal', () => ({ TAP_WINDOW_SECONDS: 10 }))

import { RecordPaymentWindow, PostPaymentForm, CLOSE_READ_WAIT_MS, AWAITING_CARD_REREAD_GRACE_MS } from './RecordPaymentWindow'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** The server's desk quote for a $460 bill with `credit` of usable credit. */
const deskQuote = (credit: number, over: any = {}) => {
  const current = over.currentTotal ?? 460
  return {
    anchorPaymentId: 'r1', anchorOpen: true, paymentsPaused: false,
    rows: [{ id: 'r1', leaseId: 'L1', type: 'rent', entryDescription: 'RENT', amount: current, dueDate: '2026-10-01',
             creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' }],
    currentTotal: current, oldBalance: [], oldBalanceTotal: 0, payOnline: [], payOnlineTotal: 0,
    paused: [], pausedTotal: 0, clearing: 0, creditAlreadyApplied: 0,
    creditAvailable: credit, creditSetAsideElsewhere: 0, creditOnFile: credit,
    owedIfUsed: Math.max(0, current - credit), owedIfSaved: current, fullBalance: current, scheduledRetries: [],
    ...over,
  }
}

let host: HTMLDivElement
let root: Root
let onClose: ReturnType<typeof vi.fn>
let onRecorded: ReturnType<typeof vi.fn>
beforeEach(() => {
  server.gets = []; server.posts = []; server.recordFails = []; server.recordResult = null
  server.recordHold = null; server.readerQuoteFor = null; server.readerGate = null; server.rentPages = null
  server.onCapture = null
  server.readers = [{ stripeReaderId: 'rdr_1', nickname: 'Front desk reader' }]
  server.closed = new Set(); server.showHold = null; server.quoteHold = null
  server.intentStatus = 'requires_payment_method'
  server.readerQuote = null
  onClose = vi.fn(); onRecorded = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function open(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <RecordPaymentWindow anchorPaymentId="r1" tenantId="t1" name="Kim Harland" onClose={onClose} onRecorded={onRecorded} />
      </QueryClientProvider>)
  })
  await until(() => text().includes('Full balance'), 'the bill')
}
const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
const button = (re: RegExp) => buttons().find(b => re.test(b.textContent ?? ''))
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
const amountBox = () => host.querySelector('input.form-input.mono') as HTMLInputElement
const records = () => server.posts.filter(p => p.url.endsWith('/record-manual')).map(p => p.body)
const quoteReads = () => server.gets.filter(u => u.includes('/record-manual/quote')).length
const alerts = () => [...host.querySelectorAll('.cd-msg')].map(e => e.textContent)
const times = (s: string) => text().split(s).length - 1
async function windowFocus() {
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
}

describe('a credit that moves under the desk', () => {
  it('a moved credit after Use is asked again, never sent silently', async () => {
    server.quote = deskQuote(50)
    await open()
    await press(/^Use \$50\.00/)
    expect(text()).toContain('Using $50.00 of credit')
    server.quote = deskQuote(450)          // the credit changed somewhere else
    await windowFocus()                     // the window reads the bill again
    await until(() => !!button(/^Use \$450\.00/), 'the question asked again with the new figure')
    expect(text()).not.toContain('Using $450.00 of credit')
    expect(times('Their credit changed — it is now $450.00. Ask them again: use it or save it.')).toBe(1)
    // Nothing can be recorded until they answer again.
    await press(/^Cash$/)
    await type(amountBox(), '10')
    expect(button(/^Record /)!.disabled).toBe(true)
    expect(records()).toEqual([])
    // Answered again: the figure they agreed to now is the one sent.
    await press(/^Use \$450\.00/)
    await type(amountBox(), '10')
    await press(/^Record \$10\.00/)
    await until(() => records().length === 1, 'the record')
    expect(records()[0].creditToUse).toBe(450)
  })

  it('a moved credit after Save is asked again too', async () => {
    server.quote = deskQuote(50)
    await open()
    await press(/^Save it/)
    server.quote = deskQuote(460)
    await windowFocus()
    await until(() => !!button(/^Use \$460\.00/), 'the question asked again')
    expect(text()).not.toContain('Saving the credit')
  })

  it('a 409 on Record reads the bill again and asks Use / Save again in place, with one message', async () => {
    server.quote = deskQuote(50)
    await open()
    await press(/^Use \$50\.00/)
    await press(/^Cash$/)
    await type(amountBox(), '410')
    const refusal = "The credit available changed — it's now $80.00. Look at the bill again and choose Use or Save."
    server.recordFails = [{ status: 409, error: refusal, then: () => { server.quote = deskQuote(80) } }]
    const before = quoteReads()
    await press(/^Record \$410\.00/)
    await until(() => !!button(/^Use \$80\.00/), 'the question asked again')
    expect(quoteReads()).toBeGreaterThan(before)
    expect(times(refusal)).toBe(1)
    expect(alerts()).toEqual([refusal])
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('a refusal over figures that moved (422)', () => {
  it('credit that appeared since the window opened: the bill is read again and Use / Save is offered, the server’s words said once', async () => {
    server.quote = deskQuote(0)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '460')
    const refusal = 'This account has $50.00 of credit that can pay part of this bill. Choose Use $50.00 or Save before recording.'
    server.recordFails = [{ status: 422, error: refusal, then: () => { server.quote = deskQuote(50) } }]
    const before = quoteReads()
    await press(/^Record \$460\.00/)
    await until(() => !!button(/^Use \$50\.00/), 'Use / Save offered')
    expect(quoteReads()).toBeGreaterThan(before)
    expect(alerts()).toEqual([refusal])
  })

  it('a late fee that posted after the desk answered: every answer is asked again, with the server’s words', async () => {
    server.quote = deskQuote(0)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '500')
    await press(/^Give \$40\.00 change/)
    const refusal = 'That is $25.00 short — $500.00 against $525.00 owed. Rent is paid in full.'
    server.recordFails = [{ status: 422, error: refusal, then: () => { server.quote = deskQuote(0, { currentTotal: 525 }) } }]
    await press(/^Record \$500\.00/)
    await until(() => text().includes('$525.00'), 'the new bill')
    expect(alerts()).toEqual([refusal])
    // The change answer is gone; Record waits for the amount to be fixed.
    expect(host.querySelector('.cd-option.on .cd-option-title')?.textContent ?? '').not.toMatch(/change/)
    expect(button(/^Record /)!.disabled).toBe(true)
  })
})

describe('one message at a time', () => {
  it('a refusal’s words go when the desk changes the amount, and the window’s own words never show beside them', async () => {
    server.quote = deskQuote(0)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '460')
    server.recordFails = [{ status: 422, error: 'Something else is wrong.' }]
    await press(/^Record \$460\.00/)
    await until(() => alerts().length === 1, 'the refusal')
    expect(alerts()).toEqual(['Something else is wrong.'])
    await type(amountBox(), '400')
    expect(alerts()).toEqual(['That is $60.00 short — $400.00 against $460.00 owed. Rent is paid in full.'])
  })
})

describe('backing out and finishing', () => {
  it('Cancel posts nothing', async () => {
    server.quote = deskQuote(50)
    await open()
    await press(/^Use \$50\.00/)
    await press(/^Cash$/)
    await type(amountBox(), '410')
    await press(/^Cancel$/)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(server.posts).toEqual([])
  })

  it('the change to hand back stays up until Done', async () => {
    server.quote = deskQuote(0)
    server.recordResult = { amountSettled: 460, changeGiven: 40, surplus: 40 }
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '500')
    await press(/^Give \$40\.00 change/)
    await press(/^Record \$500\.00/)
    await until(() => text().includes('Give change'), 'the change panel')
    expect(records()[0]).toMatchObject({ method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    await windowFocus()
    expect(host.querySelector('.cd-change-amount')?.textContent).toBe('$40.00')
    expect(onClose).not.toHaveBeenCalled()
    await press(/^Done$/)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('cash taken here is ready for the bank deposit', () => {
  it('recording a cash payment marks "Make a bank deposit"\u2019s lists to be read again', async () => {
    server.quote = deskQuote(0)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await open(qc)
    await press(/^Cash$/)
    await type(amountBox(), '460')
    await press(/^Record \$460\.00/)
    await until(() => records().length === 1, 'the payment recorded')
    await until(() => spy.mock.calls.some(c => c[0] === 'undeposited-cash'), 'the cash list marked stale')
    expect(spy.mock.calls.some(c => c[0] === 'deposit-slips')).toBe(true)
  })

  it('posting a cash payment that arrived before its bill marks "Make a bank deposit"\u2019s lists to be read again', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const onPosted = vi.fn()
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <PostPaymentForm tenantId="t1" name="Kim Harland" onClose={onClose} onPosted={onPosted} />
        </QueryClientProvider>)
    })
    await press(/^Cash$/)
    await type(amountBox(), '460')
    await press(/^Post \$460\.00/)
    // A cash amount may be asked back once ("Yes, post $460.00").
    if (button(/^Yes, post/)) await press(/^Yes, post/)
    await until(() => onPosted.mock.calls.length === 1, 'the payment posted')
    expect(server.posts.filter(p => p.url === '/payments/post-payment')).toHaveLength(1)
    expect(spy.mock.calls.some(c => c[0] === 'undeposited-cash')).toBe(true)
    expect(spy.mock.calls.some(c => c[0] === 'deposit-slips')).toBe(true)
  })
})

describe('the card reader at the desk', () => {
  it('while the reader waits for the card, a window focus neither re-reads the figures nor drops the charge', async () => {
    server.quote = deskQuote(0)
    server.readerQuote = {
      outstanding: 460, usableCredit: 0, needsCreditChoice: false, useCredit: false, creditUsed: 0, creditApplied: 0,
      oldBalance: 0, towardOldBalance: 0, paidAhead: 0, balance: 460, cardFee: 16.65, total: 476.65, lineItems: [],
    }
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Waiting for the card on the reader'), 'the reader waiting')
    const reads = server.gets.filter(u => u.includes('/reader/quote')).length
    const billReads = quoteReads()
    await windowFocus()
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(server.gets.filter(u => u.includes('/reader/quote')).length).toBe(reads)
    // Nor the household's bill (fix pass 2): a read mid-tap could drop the space being charged.
    expect(quoteReads()).toBe(billReads)
    expect(text()).toContain('Waiting for the card on the reader')
    expect(server.posts.filter(p => p.url.includes('/cancel'))).toEqual([])
    // Closing the window mid-wait releases the charge on the reader.
    act(() => root.unmount())
    root = createRoot(host)
    expect(server.posts.filter(p => p.url === '/payments/reader/intents/pi_1/cancel')).toHaveLength(1)
  })
})

// ─── Fix round 2 ─────────────────────────────────────────────────────────────

/** A $460 bill with a $100 old balance (carried forward). */
const withOldBalance = (credit = 0) => deskQuote(credit, {
  oldBalance: [{ id: 'c1', leaseId: 'L1', type: 'carried_balance', entryDescription: null, amount: 100, dueDate: '2026-02-01',
                 creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' }],
  oldBalanceTotal: 100, fullBalance: 560,
})

describe('Keep it — no change on hand, when the extra all goes to the old balance', () => {
  it('Keep it with the extra no more than the old balance records it to the old balance, first time', async () => {
    server.quote = withOldBalance()
    server.recordResult = { amountSettled: 520, towardOldBalance: 60 }
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '520')
    await press(/^Keep it — no change on hand/)
    expect(text()).toContain('$60.00 pays the old balance')
    await press(/^Record \$520\.00/)
    await until(() => text().includes('went to the old balance'), 'recorded')
    // One post, carrying the Keep answer — never refused for "choose Give change or Keep it".
    expect(records()).toEqual([{ method: 'cash', amountTendered: 520, surplusHandling: 'credit' }])
    expect(alerts().some(a => /Choose "Give change"/.test(a ?? ''))).toBe(false)
  })
})

describe('the written amount is asked last', () => {
  it('a check over the bill while using credit is told to choose Save first — never asked "is it really $X?" before that', async () => {
    server.quote = deskQuote(50)
    await open()
    await press(/^Use \$50\.00/)
    await press(/^Check$/)
    await type(amountBox(), '500')
    await until(() => alerts().length === 1, 'the refusal')
    expect(alerts()).toEqual(['Credit is being used on this bill and the check is $90.00 over it. Choose Save instead.'])
    expect(button(/^Yes, it is/)).toBeUndefined()
    expect(button(/^Record /)!.disabled).toBe(true)
  })
})

describe('the card reader asks about credit once', () => {
  it('in Card on the reader the window asks no credit question of its own — each space asks its own', async () => {
    server.quote = deskQuote(50)
    server.readerQuote = {
      outstanding: 460, usableCredit: 50, needsCreditChoice: true, useCredit: false, creditUsed: 0, creditApplied: 0,
      oldBalance: 0, towardOldBalance: 0, paidAhead: 0, balance: 460, cardFee: 16.65, total: 476.65, lineItems: [],
      ifUsed: { balance: 410, cardFee: 14.90, total: 424.90 }, ifSaved: { balance: 460, cardFee: 16.65, total: 476.65 },
    }
    await open()
    expect(times('Ask them: use their credit on this bill, or save it for later?')).toBe(1)
    await press(/^Card on the reader$/)
    await until(() => text().includes('Ask them before sending the amount'), 'the reader’s own question')
    expect(times('Ask them: use their credit on this bill, or save it for later?')).toBe(0)
    expect(times('Ask them before sending the amount: use their credit, or save it?')).toBe(1)
  })

  it('Send waits for the total of the answer just given — the earlier total is never offered or read out', async () => {
    server.quote = deskQuote(50)
    server.readerQuoteFor = (url: string) => {
      const use = /useCredit=true/.test(url)
      return {
        outstanding: 460, usableCredit: 50, needsCreditChoice: true, useCredit: use, creditUsed: use ? 50 : 0, creditApplied: 0,
        oldBalance: 0, towardOldBalance: 0, paidAhead: 0,
        balance: use ? 410 : 460, cardFee: use ? 14.90 : 16.65, total: use ? 424.90 : 476.65, lineItems: [],
        ifUsed: { balance: 410, cardFee: 14.90, total: 424.90 }, ifSaved: { balance: 460, cardFee: 16.65, total: 476.65 },
      }
    }
    let release!: () => void
    server.readerGate = new Promise<void>(r => { release = r })
    await open()
    await press(/^Card on the reader$/)
    await press(/^Use \$50\.00 — card \$424\.90/)
    // The quote for "Use" is on its way: no total, and nothing to send.
    await until(() => text().includes('Working out the total…'), 'the total being worked out')
    expect(text()).not.toContain('on the card')
    const send = button(/^Send .*to the reader/)!
    expect(send.disabled).toBe(true)
    expect(send.textContent).toBe('Send to the reader')
    await act(async () => { release() })
    await until(() => !!button(/^Send \$424\.90 to the reader/) && !button(/^Send \$424\.90 to the reader/)!.disabled, 'Send with the Use total')
    expect(text()).toContain('$424.90 on the card')
  })
})

describe('the window closes only from its own buttons, and not while money is moving', () => {
  it('a click outside the window never closes it, not even with the change to hand back on screen', async () => {
    server.quote = deskQuote(0)
    server.recordResult = { amountSettled: 460, changeGiven: 40, surplus: 40 }
    await open()
    const overlay = () => host.querySelector('.modal-overlay') as HTMLElement
    await act(async () => { overlay().click() })
    expect(onClose).not.toHaveBeenCalled()
    await press(/^Cash$/)
    await type(amountBox(), '500')
    await press(/^Give \$40\.00 change/)
    await press(/^Record \$500\.00/)
    await until(() => text().includes('Give change'), 'the change panel')
    await act(async () => { overlay().click() })
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('.cd-change-amount')?.textContent).toBe('$40.00')
  })

  it('while Record is on its way, Cancel cannot close the window — the result is always said', async () => {
    server.quote = deskQuote(0)
    let release!: () => void
    server.recordHold = new Promise<void>(r => { release = r })
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '460')
    await press(/^Record \$460\.00/)
    await until(() => text().includes('Recording…'), 'the post in flight')
    expect(button(/^Cancel$/)!.disabled).toBe(true)
    await act(async () => { button(/^Cancel$/)!.click() })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { release() })
    await until(() => !!button(/^Done$/), 'the result')
    expect(onRecorded).toHaveBeenCalledWith('Recorded $460.00 from Kim Harland.')
  })

  it('while the reader waits for the card the window cannot be closed; once canceled on the reader it can', async () => {
    server.quote = deskQuote(0)
    server.readerQuote = {
      outstanding: 460, usableCredit: 0, needsCreditChoice: false, useCredit: false, creditUsed: 0, creditApplied: 0,
      oldBalance: 0, towardOldBalance: 0, paidAhead: 0, balance: 460, cardFee: 16.65, total: 476.65, lineItems: [],
    }
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Waiting for the card on the reader'), 'the reader waiting')
    await until(() => button(/^Close$/)!.disabled, 'Close held')
    await act(async () => { (host.querySelector('.modal-overlay') as HTMLElement).click() })
    await act(async () => { button(/^Close$/)!.click() })
    expect(onClose).not.toHaveBeenCalled()
    expect(server.posts.filter(p => p.url.endsWith('/cancel'))).toEqual([])
    await press(/^Cancel on the reader$/)
    await press(/^Close$/)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('nothing left to take: one message', () => {
  it('another desk paid everything: one message in plain words, never the server’s status word beside "Nothing is owed"', async () => {
    server.quote = deskQuote(0)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '460')
    server.recordFails = [{
      status: 409, error: 'This charge is not open (status: settled)',
      then: () => { server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0 }) },
    }]
    await press(/^Record \$460\.00/)
    await until(() => text().includes('Nothing is owed here right now.'), 'the bill read again')
    expect(alerts()).toEqual(['What they owe changed while this window was open. Nothing is owed here right now.'])
    expect(text()).not.toContain('status: settled')
  })

  it('a space put into eviction mode while the window was open says so once', async () => {
    server.quote = deskQuote(0)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '460')
    const paused = 'This space is in eviction mode — recording a payment is paused. Contact the landlord.'
    server.recordFails = [{
      status: 409, error: paused,
      then: () => { server.quote = deskQuote(0, { paymentsPaused: true, rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0 }) },
    }]
    await press(/^Record \$460\.00/)
    await until(() => alerts().length === 1 && times(paused) === 1 && !text().includes('Recording…'), 'one message')
    expect(alerts()).toEqual([`What they owe changed while this window was open. ${paused}`])
  })

  it('opened with nothing owed: just that', async () => {
    server.quote = deskQuote(0, { rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0 })
    await open()
    expect(alerts()).toEqual(['Nothing is owed here right now.'])
  })
})

// ─── Fix round 3 ─────────────────────────────────────────────────────────────

const plainReader = {
  outstanding: 460, usableCredit: 0, needsCreditChoice: false, useCredit: false, creditUsed: 0, creditApplied: 0,
  oldBalance: 0, towardOldBalance: 0, paidAhead: 0, balance: 460, cardFee: 16.65, total: 476.65, lineItems: [],
}

describe('a charge that is no longer open is said in plain words', () => {
  it('another desk paid this charge while more stays open: plain words, no status word, and the bill read again', async () => {
    const twoBills = (paidFirst: boolean) => deskQuote(0, {
      anchorOpen: !paidFirst,
      rows: [
        ...(paidFirst ? [] : [{ id: 'r1', leaseId: 'L1', type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
          creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' }]),
        { id: 'u1', leaseId: 'L1', type: 'utility', entryDescription: 'WATER', amount: 40, dueDate: '2026-10-01',
          creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' },
      ],
      currentTotal: paidFirst ? 40 : 500, owedIfSaved: paidFirst ? 40 : 500, owedIfUsed: paidFirst ? 40 : 500, fullBalance: paidFirst ? 40 : 500,
    })
    server.quote = twoBills(false)
    await open()
    await press(/^Cash$/)
    await type(amountBox(), '500')
    server.recordFails = [{ status: 409, error: 'This charge is not open (status: settled)', then: () => { server.quote = twoBills(true) } }]
    const before = quoteReads()
    await press(/^Record \$500\.00/)
    await until(() => text().includes('This charge is no longer open'), 'the plain words')
    expect(alerts()).toEqual(['This charge is no longer open — it is paid now.'])
    expect(text()).not.toContain('status:')
    expect(quoteReads()).toBeGreaterThan(before)
    await until(() => text().includes('$40.00') && !text().includes('$500.00 '), 'the bill read again')
  })
})

describe('the card reader: nothing moves the window while a card is being taken', () => {
  it('while the reader waits for the card, the payment method cannot be switched (that would cancel the charge)', async () => {
    server.quote = deskQuote(0)
    server.readerQuote = plainReader
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Waiting for the card on the reader'), 'the reader waiting')
    await until(() => button(/^Cash$/)!.disabled, 'the methods held')
    await act(async () => { button(/^Cash$/)!.click() })
    expect(text()).toContain('Waiting for the card on the reader')
    expect(server.posts.filter(p => p.url.endsWith('/cancel'))).toEqual([])
    await press(/^Cancel on the reader$/)
    await until(() => !button(/^Cash$/)!.disabled, 'the methods free again')
  })

  it('two spaces, one taken on the reader and the window closed: what was taken is still said', async () => {
    server.quote = deskQuote(0, {
      rows: [
        { id: 'r1', leaseId: 'L1', type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
          creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 04', propertyName: 'Oak Park' },
        { id: 'r2', leaseId: 'L2', type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
          creditAlreadyApplied: 0, notes: null, unitNumber: 'MH 05', propertyName: 'Oak Park' },
      ],
      currentTotal: 920, owedIfSaved: 920, owedIfUsed: 920, fullBalance: 920,
    })
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    await open()
    await press(/^Card on the reader$/)
    await until(() => text().includes('Space MH 05'), 'a block per space')
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Taken.'), 'the first space taken')
    expect(onRecorded).not.toHaveBeenCalled()
    await press(/^Close$/)
    expect(onRecorded).toHaveBeenCalledWith('Took $476.65 by card on the reader from Kim Harland. The rest of what they owe is still open.')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the onboarding "already collected" button', () => {
  it('is found past the first 1,000 rent charges of a large portfolio, read by the bill’s own months', async () => {
    server.quote = deskQuote(0)
    const fill = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `other${from + i}`, tenantId: 'tX' }))
    server.rentPages = {
      1: fill(1000, 0),
      2: [...fill(10, 1000), { id: 'r1', tenantId: 't1', priorArrangementEligible: true, amount: 460, dueDate: '2026-10-01' }],
    }
    await open()
    await until(() => !!button(/^Already collected through my old system/), 'the button')
    expect(button(/^Already collected through my old system/)!.textContent).toBe('Already collected through my old system — $460.00 due Oct 1')
    expect(server.gets.filter(u => u.startsWith('/payments?type=rent'))).toEqual([
      '/payments?type=rent&from=2026-10-01&to=2026-10-31&limit=1000&page=1',
      '/payments?type=rent&from=2026-10-01&to=2026-10-31&limit=1000&page=2',
    ])
  })
})

// ─── Fix pass 2 ──────────────────────────────────────────────────────────────

const space = (id: string, lease: string, unit: string) => ({
  id, leaseId: lease, type: 'rent', entryDescription: 'RENT', amount: 460, dueDate: '2026-10-01',
  creditAlreadyApplied: 0, notes: null, unitNumber: unit, propertyName: 'Oak Park',
})
/** Two $460 spaces of one household. */
const twoSpaces = () => deskQuote(0, {
  rows: [space('r1', 'L1', 'MH 04'), space('r2', 'L2', 'MH 05')],
  currentTotal: 920, owedIfSaved: 920, owedIfUsed: 920, fullBalance: 920,
})
/** The bill once MH 04 was taken on the reader: its rent is on its way, MH 05's is left. */
const afterFirstSpace = () => deskQuote(0, {
  anchorOpen: false, rows: [space('r2', 'L2', 'MH 05')], clearing: 460,
})
const sends = () => buttons().filter(b => /to the reader$/.test(b.textContent ?? ''))
const charges = () => server.posts.filter(p => p.url.endsWith('/reader/charge')).map(p => p.url)

describe('a space taken on the reader is never asked for again', () => {
  it('two spaces, one taken on the reader, then Cash: the bill is read again and only the other space is asked for and recorded', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.onCapture = () => { server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2, 'a block per space')
    const before = quoteReads()
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken.'), 'the first space taken')
    // Read again the moment the card went through.
    await until(() => quoteReads() > before && !text().includes('$920.00'), 'the bill read again')
    expect(text()).toContain('Taken on the reader: $476.65 by card (card fee included) for Space MH 04. The bill above is what is left.')
    // The space taken stays listed, as taken; the other keeps its name.
    expect(text()).toContain('Space MH 04')
    expect(text()).toContain('Space MH 05')
    await press(/^Cash$/)
    expect([...host.querySelectorAll('.cd-line-total')].map(e => e.textContent)).toEqual(['This bill$460.00', 'Full balance$460.00'])
    expect(amountBox().placeholder).toBe('460.00')
    await type(amountBox(), '460')
    await press(/^Record \$460\.00/)
    await until(() => !!button(/^Done$/), 'recorded')
    expect(server.posts.filter(p => p.url.endsWith('/record-manual'))).toEqual([
      { url: '/payments/r2/record-manual', body: { method: 'cash', amountTendered: 460 } },
    ])
  })

  it('a card on the reader and the rest in cash: the closing notice says both, once', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.onCapture = () => { server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2, 'a block per space')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'the first space taken and the bill read again')
    await press(/^Cash$/)
    await type(amountBox(), '460')
    await press(/^Record \$460\.00/)
    await until(() => !!button(/^Done$/), 'recorded')
    const both = 'Took $476.65 by card on the reader. Recorded $460.00 from Kim Harland.'
    expect(host.querySelector('.alert-success')?.textContent).toBe(both)
    await press(/^Done$/)
    expect(onRecorded.mock.calls).toEqual([[both]])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the reader takes one space at a time', () => {
  it('while space 1 waits for the card, space 2 cannot be sent; once space 1 is canceled it can', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2 && sends().every(b => !b.disabled), 'both spaces ready')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Waiting for the card on the reader'), 'space 1 waiting')
    const second = sends().find(b => /^Send \$476\.65 to the reader$/.test(b.textContent ?? ''))!
    expect(second.disabled).toBe(true)
    expect(text()).toContain('The reader is taking the other space now. Send this one once that is taken or canceled.')
    await act(async () => { second.click() })
    expect(charges()).toEqual(['/payments/r1/reader/charge'])
    await press(/^Cancel on the reader$/)
    await until(() => sends().length === 2 && sends().every(b => !b.disabled), 'both free again')
    expect(text()).not.toContain('The reader is taking the other space now.')
    // Space 2 now goes, and while it waits, space 1 cannot be sent again.
    await act(async () => { sends().find(b => /^Send \$476\.65 to the reader$/.test(b.textContent ?? ''))!.click() })
    await until(() => text().includes('Waiting for the card on the reader'), 'space 2 waiting')
    expect(charges()).toEqual(['/payments/r1/reader/charge', '/payments/r2/reader/charge'])
    expect(button(/^Send again to the reader$/)!.disabled).toBe(true)
  })

  it('once space 1 is taken, space 2 can be sent, and both taken finish the window with one notice', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.onCapture = () => { server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2, 'a block per space')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'space 1 taken')
    server.onCapture = () => { server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0, clearing: 920 }) }
    await until(() => sends().length === 1 && !sends()[0].disabled, 'space 2 free to send')
    await act(async () => { sends()[0].click() })
    await until(() => !!button(/^Done$/), 'both taken')
    expect(charges()).toEqual(['/payments/r1/reader/charge', '/payments/r2/reader/charge'])
    expect(onRecorded.mock.calls).toEqual([['Took $953.30 by card on the reader from Kim Harland.']])
  })
})

// ─── Fix pass 3 ──────────────────────────────────────────────────────────────

/** The bill once both spaces are paid (MH 04 on the reader, MH 05 at the desk). */
const allPaid = () => deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0, clearing: 460 })
const chooseReader = async (id: string) => {
  const sel = host.querySelector('select.form-select') as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(sel, id); sel.dispatchEvent(new Event('change', { bubbles: true })) })
}
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 120)) }) }

describe('the done screen stays as it was', () => {
  it('a card on one space and cash with change on the other: a window focus leaves the change and the notice as they were, said once', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.onCapture = () => { server.closed.add('r1'); server.quote = afterFirstSpace() }
    server.recordResult = { amountSettled: 460, creditUsed: 0, surplus: 40, changeGiven: 40 }
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2, 'a block per space')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'space 1 taken and the bill read again')
    await press(/^Cash$/)
    await type(amountBox(), '500')
    await press(/^Give \$40\.00 change/)
    await press(/^Record \$500\.00/)
    await until(() => !!button(/^Done$/), 'recorded')
    const said = 'Took $476.65 by card on the reader. Recorded $460.00 from Kim Harland — give $40.00 change.'
    // The household is paid in full now: a fresh read would list only the space taken.
    server.quote = allPaid()
    const reads = quoteReads()
    await windowFocus()
    await settle()
    expect(quoteReads()).toBe(reads)
    expect(host.querySelector('.cd-change-amount')?.textContent).toBe('$40.00')
    expect(host.querySelector('.alert-success')?.textContent).toBe(said)
    await press(/^Done$/)
    expect(onRecorded.mock.calls).toEqual([[said]])
  })
})

describe('the readers list after a space is taken', () => {
  it('after one space is taken on the reader, a window focus shows no error and keeps the chosen reader', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.readers = [{ stripeReaderId: 'rdr_1', nickname: 'Front desk reader' }, { stripeReaderId: 'rdr_2', nickname: 'Back reader' }]
    server.onCapture = () => { server.closed.add('r1'); server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => !!host.querySelector('select.form-select'), 'the reader picker')
    await chooseReader('rdr_2')
    await until(() => sends().length === 2 && sends().every(b => !b.disabled), 'both spaces ready')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'space 1 taken')
    await windowFocus()
    await settle()
    expect(text()).not.toContain('no longer open')
    expect(host.querySelectorAll('.alert-danger').length).toBe(0)
    expect((host.querySelector('select.form-select') as HTMLSelectElement).value).toBe('rdr_2')
    // The list is read once per open space at most, never again on the charge already taken.
    expect(server.gets.filter(u => u.includes('/reader/readers'))).toEqual(['/payments/r1/reader/readers', '/payments/r2/reader/readers'])
    await until(() => sends().length === 1 && !sends()[0].disabled, 'space 2 free to send')
    await act(async () => { sends()[0].click() })
    await until(() => server.posts.some(p => p.url.endsWith('/payments/r2/reader/charge')), 'space 2 sent')
    expect(server.posts.find(p => p.url.endsWith('/payments/r2/reader/charge'))!.body.stripeReaderId).toBe('rdr_2')
  })
})

describe('the reader is held from the click on Send', () => {
  it('while one space puts its breakdown on the reader, the other space cannot be sent', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2 && sends().every(b => !b.disabled), 'both spaces ready')
    let release!: () => void
    server.showHold = new Promise<void>(r => { release = r })
    // Space 2's breakdown is not up (space 1 is the live one): Send puts it up first.
    await act(async () => { sends()[1].click() })
    await until(() => text().includes('Sending to the reader…'), 'space 2 holding the reader')
    const first = sends()[0]
    expect(first.disabled).toBe(true)
    await act(async () => { first.click() })
    server.showHold = null
    await act(async () => { release() })
    await until(() => text().includes('Waiting for the card on the reader'), 'space 2 waiting for the card')
    expect(charges()).toEqual(['/payments/r2/reader/charge'])
  })
})

describe('a household credit used on one space at the reader', () => {
  it('the other space reads its figures again and says the credit changed, never sending the old total', async () => {
    let credit = 50
    server.quote = deskQuote(50, { rows: [space('r1', 'L1', 'MH 04'), space('r2', 'L2', 'MH 05')], currentTotal: 920, owedIfSaved: 920, owedIfUsed: 870, fullBalance: 920 })
    server.intentStatus = 'requires_capture'
    server.readerQuoteFor = (url: string) => {
      if (credit === 0 && /useCredit=true&expectedCredit=50/.test(url)) throw httpError(409, 'Your credit changed — it is now $0.00.')
      if (credit === 0) return plainReader
      return /useCredit=true/.test(url)
        ? { ...plainReader, usableCredit: 50, creditUsed: 50, balance: 410, cardFee: 14.90, total: 424.90 }
        : { ...plainReader, usableCredit: 50, ifUsed: { balance: 410, cardFee: 14.9, total: 424.9 }, ifSaved: { balance: 460, cardFee: 16.65, total: 476.65 } }
    }
    server.onCapture = () => { credit = 0; server.closed.add('r1'); server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => buttons().filter(b => /^Use \$50\.00/.test(b.textContent ?? '')).length === 2, 'each space asks')
    await act(async () => { buttons().filter(b => /^Use \$50\.00/.test(b.textContent ?? ''))[1].click() })
    await act(async () => { buttons().filter(b => /^Use \$50\.00/.test(b.textContent ?? ''))[0].click() })
    await until(() => sends().length === 2 && sends().every(b => /424\.90/.test(b.textContent ?? '') && !b.disabled), 'both with credit')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'space 1 taken')
    await until(() => text().includes('Your credit changed — it is now $0.00.'), 'space 2 asked again')
    const second = () => host.querySelectorAll('.cd-reader-block')[1].textContent ?? ''
    expect(second()).not.toContain('Using $50.00 of credit')
    expect(second()).not.toContain('424.90')
    expect(sends().map(b => b.textContent)).toEqual(['Send $476.65 to the reader'])
    expect(times('Your credit changed')).toBe(1)
  })
})

describe('an old balance left after the reader', () => {
  const oldRow = { ...space('o1', 'L1', 'MH 04'), type: 'carried_balance', amount: 200, dueDate: '2026-08-01' }
  it('one space with an old balance: taking the bill on the reader finishes the window and says the old balance is still open', async () => {
    server.quote = deskQuote(0, { oldBalance: [oldRow], oldBalanceTotal: 200, fullBalance: 660 })
    server.readerQuote = { ...plainReader, outstanding: 660, oldBalance: 200 }
    server.intentStatus = 'requires_capture'
    server.onCapture = () => {
      server.closed.add('r1')
      server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, owedIfSaved: 0, owedIfUsed: 0, oldBalance: [oldRow], oldBalanceTotal: 200, fullBalance: 200, clearing: 460 })
    }
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => !!button(/^Done$/), 'finished')
    const said = 'Took $476.65 by card on the reader from Kim Harland. Their $200.00 old balance is still open (it is paid last) — use Record payment again to take it.'
    expect(host.querySelector('.alert-success')?.textContent).toBe(said)
    expect(onRecorded.mock.calls).toEqual([[said]])
  })

  it('a space with only an old balance open says to enter an amount toward it before anything can be sent', async () => {
    server.quote = deskQuote(0, { rows: [], currentTotal: 0, owedIfSaved: 0, owedIfUsed: 0, anchorOpen: false, oldBalance: [oldRow], oldBalanceTotal: 200, fullBalance: 200 })
    server.readerQuoteFor = (url: string) => /towardOldBalance=50/.test(url)
      ? { ...plainReader, outstanding: 200, oldBalance: 200, towardOldBalance: 50, balance: 50, cardFee: 2.30, total: 52.30 }
      : { ...plainReader, outstanding: 200, oldBalance: 200, balance: 0, cardFee: 0, total: 0 }
    await open()
    await press(/^Card on the reader$/)
    await until(() => text().includes('Only an old balance is open on this space. Enter an amount toward the old balance to send it to the reader.'), 'the reason')
    expect(sends()[0].disabled).toBe(true)
    expect(text()).not.toContain('The credit covers')
    const old = [...host.querySelectorAll('input.form-input.mono')].pop() as HTMLInputElement
    await type(old, '50')
    await act(async () => { old.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => sends().length === 1 && /52\.30/.test(sends()[0].textContent ?? '') && !sends()[0].disabled, 'sendable with the old-balance amount')
  })
})

// ─── Fix pass 4 ──────────────────────────────────────────────────────────────

describe('closing the window after the last space is taken on the reader', () => {
  it('the last space taken, the bill still being read again, Close: the take is said exactly once', async () => {
    server.quote = deskQuote(0)
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    let release!: () => void
    server.onCapture = () => {
      server.closed.add('r1')
      server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, owedIfSaved: 0, owedIfUsed: 0, fullBalance: 0, clearing: 460 })
      server.quoteHold = new Promise<void>(r => { release = r })
    }
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Taken.'), 'taken')
    // The read that finishes the window is still on its way.
    expect(button(/^Done$/)).toBeUndefined()
    expect(onRecorded).not.toHaveBeenCalled()
    await press(/^Close$/)
    // Fix pass 5: Close waits a moment for that read — nothing is said yet,
    // nothing can be switched, and the window stays up.
    expect(button(/^Checking what is still open…$/)?.disabled).toBe(true)
    expect(button(/^Cash$/)?.disabled).toBe(true)
    expect(onRecorded).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // The read is too slow: the take alone is said, once, and the window closes.
    await act(async () => { await new Promise(r => setTimeout(r, CLOSE_READ_WAIT_MS + 100)) })
    expect(onRecorded.mock.calls).toEqual([['Took $476.65 by card on the reader from Kim Harland.']])
    expect(onClose).toHaveBeenCalledTimes(1)
    // The slow read lands afterwards: nothing is said a second time.
    await act(async () => { release() })
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(onRecorded).toHaveBeenCalledTimes(1)
  }, 10_000)
})

describe('the onboarding "already collected" button after a card is taken', () => {
  it('after a reader take, while Close is "Checking what is still open…", the prior-arrangement button is disabled', async () => {
    server.quote = deskQuote(0)
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.rentPages = { 1: [{ id: 'r1', tenantId: 't1', priorArrangementEligible: true, amount: 460, dueDate: '2026-10-01' }] }
    let release!: () => void
    server.onCapture = () => {
      server.closed.add('r1')
      server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, owedIfSaved: 0, owedIfUsed: 0, fullBalance: 0, clearing: 460 })
      server.quoteHold = new Promise<void>(r => { release = r })
    }
    await open()
    const prior = () => button(/^Already collected through my old system/)
    await until(() => !!prior() && !prior()!.disabled, 'the enabled button before any card')
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Taken.'), 'taken')
    // The bill is still being read again: the row on screen is the one the card paid.
    expect(prior()?.disabled).toBe(true)
    await press(/^Close$/)
    await until(() => !!button(/^Checking what is still open…$/), 'the window waits for the read')
    expect(prior()?.disabled).toBe(true)
    await act(async () => { prior()?.click() })
    expect(server.posts.filter(p => p.url.endsWith('/record-prior-arrangement'))).toEqual([])
    await act(async () => { release() })
    await until(() => onClose.mock.calls.length === 1, 'closed')
  })
})

// ─── Fix pass 5 ──────────────────────────────────────────────────────────────

describe('Close pressed before the bill is read again after the last card', () => {
  const oldRow = { ...space('o1', 'L1', 'MH 04'), type: 'carried_balance', amount: 200, dueDate: '2026-08-01' }
  const takeWithOldBalanceLeft = () => {
    server.quote = deskQuote(0, { oldBalance: [oldRow], oldBalanceTotal: 200, fullBalance: 660 })
    server.readerQuote = { ...plainReader, outstanding: 660, oldBalance: 200 }
    server.intentStatus = 'requires_capture'
    let release!: () => void
    server.onCapture = () => {
      server.closed.add('r1')
      server.quote = deskQuote(0, { anchorOpen: false, rows: [], currentTotal: 0, owedIfSaved: 0, owedIfUsed: 0, oldBalance: [oldRow], oldBalanceTotal: 200, fullBalance: 200, clearing: 460 })
      server.quoteHold = new Promise<void>(r => { release = r })
    }
    return () => release()
  }
  const oldLeftSaid = 'Took $476.65 by card on the reader from Kim Harland. Their $200.00 old balance is still open (it is paid last) — use Record payment again to take it.'

  it('an old balance the desk left off the card is said in the closing notice, once, when the read comes back', async () => {
    const release = takeWithOldBalanceLeft()
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Taken.'), 'taken')
    expect(onRecorded).not.toHaveBeenCalled()
    await press(/^Close$/)
    await until(() => !!button(/^Checking what is still open…$/), 'the window waits for the read')
    const readsBefore = quoteReads()
    await act(async () => { release() })
    await until(() => onClose.mock.calls.length === 1, 'closed')
    expect(onRecorded.mock.calls).toEqual([[oldLeftSaid]])
    // Close joined the read already on its way — it never started a second one.
    expect(quoteReads()).toBe(readsBefore)
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a read that fails after Close says the take alone, once', async () => {
    const release = takeWithOldBalanceLeft()
    await open()
    await press(/^Card on the reader$/)
    await press(/^Send \$476\.65 to the reader/)
    await until(() => text().includes('Taken.'), 'taken')
    await press(/^Close$/)
    server.quote = undefined   // JSON.parse(undefined) throws: the read fails
    await act(async () => { release() })
    await until(() => onClose.mock.calls.length === 1, 'closed')
    expect(onRecorded.mock.calls).toEqual([['Took $476.65 by card on the reader from Kim Harland.']])
  })
})

describe('a space already taken on the reader shows no error when its block comes back', () => {
  it('two spaces, space 1 taken, Cash and back to Card on the reader: space 1 says only "Taken.", with no error', async () => {
    server.quote = twoSpaces()
    server.readerQuote = plainReader
    server.intentStatus = 'requires_capture'
    server.onCapture = () => { server.closed.add('r1'); server.quote = afterFirstSpace() }
    await open()
    await press(/^Card on the reader$/)
    await until(() => sends().length === 2, 'a block per space')
    await act(async () => { sends()[0].click() })
    await until(() => text().includes('Taken on the reader:'), 'space 1 taken and the bill read again')
    await press(/^Cash$/)
    await press(/^Card on the reader$/)
    await until(() => sends().length === 1 && !sends()[0].disabled, 'space 2 ready again')
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(alerts()).toEqual([])
    expect(text()).not.toMatch(/no longer open|not open/i)
    expect(times('Taken.')).toBe(1)
    // The closed charge is never read again for its reader figures.
    const r1Reads = server.gets.filter(u => u.startsWith('/payments/r1/reader/quote')).length
    await press(/^Cash$/)
    await press(/^Card on the reader$/)
    await until(() => sends().length === 1, 'space 2 back')
    expect(server.gets.filter(u => u.startsWith('/payments/r1/reader/quote')).length).toBe(r1Reads)
  })
})

// ─── 10/4 (decisions #48.4, review LOW): a card waiting on its bank ─────────
//
// The desk quote's awaitingCard says which part of `clearing` is a pay-screen
// card payment still waiting on the card's bank: nothing is charged yet, and
// the bill it holds opens here by itself at confirmBy. It used to sit inside
// "Already on its way — not owed".

const heldCard = (over: any = {}) => ({
  amount: 476.65, heldAmount: 460, payerName: 'Kim Harland',
  confirmBy: new Date(Date.now() + 20 * 60_000).toISOString(), ...over,
})
const allHeld = (awaitingCard: any[], over: any = {}) => deskQuote(0, {
  anchorOpen: false, rows: [], currentTotal: 0, fullBalance: 0, owedIfSaved: 0, owedIfUsed: 0,
  clearing: 460, awaitingCard, ...over,
})

describe('a card waiting on its bank is said on its own line at the desk', () => {
  it('awaitingCard empty: what is clearing is "Already on its way", and nothing says waiting on a card bank', async () => {
    server.quote = allHeld([])
    await open()
    expect(text()).toContain('Already on its way (a card or bank payment clearing) — not owed$460.00')
    expect(text()).not.toContain('card bank')
  })

  it('one held card: "Waiting on <name>’s card bank — nothing charged yet", its time, and it is NOT counted as on its way', async () => {
    const card = heldCard()
    server.quote = allHeld([card])
    await open()
    // No time zone on the quote: this browser's clock, with its zone named.
    const at = new Date(card.confirmBy).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    expect(text()).toContain(`Waiting on Kim Harland’s card bank to confirm — nothing charged yet. If it is not confirmed, this opens here at ${at}.$460.00`)
    expect(text()).not.toContain('Already on its way')
  })

  it('the hour the bill opens is said on the property\'s clock when the quote names its time zone (the same clock as the server\'s refusal)', async () => {
    const card = heldCard({ timezone: 'America/Phoenix' })
    server.quote = allHeld([card])
    await open()
    const at = new Date(card.confirmBy).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' })
    expect(text()).toContain(`If it is not confirmed, this opens here at ${at}.$460.00`)
  })

  it('a held card beside a bank payment clearing: only the bank payment is on its way', async () => {
    server.quote = allHeld([heldCard()], { clearing: 700 })
    await open()
    expect(text()).toContain('Already on its way (a card or bank payment clearing) — not owed$240.00')
    expect(times('Waiting on Kim Harland’s card bank')).toBe(1)
  })

  it('no name on file: "Waiting on a card bank"', async () => {
    server.quote = allHeld([heldCard({ payerName: null })])
    await open()
    expect(text()).toContain('Waiting on a card bank to confirm — nothing charged yet.')
  })

  it('when the hold runs out the bill is read again by itself and shows open — read once, never in a loop', async () => {
    const card = heldCard({ confirmBy: new Date(Date.now() - AWAITING_CARD_REREAD_GRACE_MS + 100).toISOString() })
    server.quote = allHeld([card])
    await open()
    expect(quoteReads()).toBe(1)
    // The server released the hold before answering: the bill is open again.
    server.quote = deskQuote(0)
    await until(() => quoteReads() === 2 && text().includes('This bill'), 'the bill read again at the hold time')
    expect(text()).not.toContain('card bank')
    expect(text()).not.toContain('Already on its way')

    // A read that still shows the same hold (its release did not land) is not read again and again.
    server.quote = allHeld([card])
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(quoteReads()).toBe(2)
  })
})
