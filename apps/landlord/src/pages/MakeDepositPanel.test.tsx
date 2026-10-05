// @vitest-environment jsdom
/**
 * S655 money plan, Step 12 — "Make a bank deposit" is a front-desk screen, so
 * it self-heals (decisions.md staff rule): fresh lists at the moment of action,
 * a 409 refetches in place and says the server's sentence once, one button
 * backs out with nothing sent, and every payment in the bag is shown by name
 * with an × to take it out. Other money is accepted only after "Is any of this
 * rent?" is answered no, with a note.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  notOnSlip: [] as any[],
  onSlip: [] as any[],
  slips: [] as any[],
  waiting: [] as any[],
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  fail: null as null | { status: number; error: string; then?: () => void },
  slipsFail: false,
  /** When set, the cash list is refused with this status and sentence. */
  cashFail: null as null | { status: number; error: string },
  /** Who is looking: the owner, or a staffer holding exactly these switches. */
  perms: null as null | Record<string, boolean>,
  /** When set, every POST waits for it — money still moving. */
  hold: null as null | Promise<void>,
  /**
   * When set, the GET answers are passed through the API's own response
   * converter (apps/api lib/caseConversion), the way every response reaches
   * the browser, so the panel is proven against the real wire spelling.
   */
  wire: null as null | ((x: any) => any),
  toasts: [] as string[],
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    const out = server.wire ?? ((x: any) => x)
    if (url.startsWith('/bank-feed/deposits/undeposited')) {
      if (server.cashFail) throw httpError(server.cashFail.status, server.cashFail.error)
      return out({ notOnSlip: server.notOnSlip, onSlip: server.onSlip })
    }
    if (url.startsWith('/bank-feed/deposit-slips')) {
      if (server.slipsFail) throw httpError(500, 'The slip list query timed out')
      return out({ slips: server.slips, waiting: server.waiting })
    }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.hold) await server.hold
    if (server.fail) { const f = server.fail; server.fail = null; f.then?.(); throw httpError(f.status, f.error) }
    return { success: true, data: { id: 'slip1', total: body.expectedTotal } }
  },
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: server.perms
      ? { id: 'u_staff', role: 'onsite_manager', permissions: server.perms }
      : { id: 'u_owner', role: 'landlord', permissions: {} },
  }),
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  toast: (t: string) => { server.toasts.push(t) },
}))

import { MakeDepositPanel } from './MakeDepositPanel'
import { camelCaseKeys } from '../../../api/src/lib/caseConversion'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const item = (id: string, amount: number, payerName: string, unitNumber: string, kind = 'receipt') => ({
  kind, id, amount, collectedOn: '2026-10-02', method: 'cash', payerName, unitNumber,
  propertyName: 'Mountain View RV Ranch', slipId: null, slipDepositDate: null,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.notOnSlip = [item('r1', 460, 'Kim Harland', 'APT 04'), item('r2', 37.6, 'Russ Fuller', 'RV 02'),
    item('s1', 12.5, '', '', 'register_sale')]
  server.onSlip = []; server.slips = []; server.waiting = []; server.gets = []; server.posts = []; server.fail = null
  server.slipsFail = false; server.hold = null; server.wire = null; server.toasts = []
  server.cashFail = null; server.perms = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
async function open(props: { entityId?: string; canMatchBank?: boolean } = { entityId: 'co1' },
                    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MakeDepositPanel {...props} /></QueryClientProvider>)
  })
  await until(() => text().includes('Make a bank deposit'), 'the panel')
}
/** The landlord portal's QueryClient (main.tsx): answers kept 5 minutes, never refetched on mount. */
const portalClient = () => new QueryClient({ defaultOptions: { queries: {
  retry: false, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false } } })
async function shown(qc: QueryClient, props: { entityId?: string; canMatchBank?: boolean }) {
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MakeDepositPanel {...props} /></QueryClientProvider>)
  })
}
async function click(el: Element | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => { (el as HTMLElement).click() })
}
const tick = (name: string) => {
  const label = [...host.querySelectorAll('label')].find(l => (l.textContent ?? '').includes(name))
  return click(label?.querySelector('input') ?? undefined)
}
async function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error('no input')
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Make a bank deposit', () => {
  it('each payment in the bag is shown by name with an × that takes it out; Start over sends nothing', async () => {
    await open()
    await tick('Kim Harland')
    await tick('Russ Fuller')
    await until(() => text().includes('$497.60'), 'the bag total')
    const x = host.querySelector('button[aria-label="Take Russ Fuller · RV 02 out of the bag"]')
    expect(x).toBeTruthy()
    await click(x!)
    await until(() => text().includes('$460.00') && !text().includes('$497.60'), 'Russ out of the bag')
    await click(button(/^Start over$/))
    expect(host.querySelectorAll('.bankrec-bag-row')).toHaveLength(0)
    expect(server.posts).toHaveLength(0)
  })

  it('other money is accepted only after "Is any of this rent?" is answered no, with a note', async () => {
    await open()
    await type(host.querySelector('input[placeholder="$0.00"]'), '40')
    await until(() => text().includes('Is any of this rent?'), 'the rent question')
    expect(button(/Make the deposit slip/)!.disabled).toBe(true)
    await click(button(/Yes, some is rent/))
    // The Bank page and the Front Desk have no Record payment button, so the
    // next step says where it is.
    expect(text()).toContain('Record each rent payment first (Record payment, on the Outstanding Balances page or the resident\u2019s page), then tick it in the list above.')
    expect(button(/Make the deposit slip/)!.disabled).toBe(true)
    await click(button(/No, none of it is rent/))
    expect(button(/Make the deposit slip/)!.disabled).toBe(true)          // no note yet
    await type(host.querySelector('input[placeholder^="What is it?"]'), 'Laundry quarters')
    await click(button(/Make the deposit slip/))
    await until(() => server.posts.length === 1, 'the slip sent')
    expect(server.posts[0].body).toMatchObject({
      otherAmount: 40, otherNote: 'Laundry quarters', otherIsNotRent: true, expectedTotal: 40,
      receiptIds: [], registerSaleIds: [], entityId: 'co1',
    })
  })

  it('the slip is sent with the payments ticked and the total the screen showed', async () => {
    await open()
    await tick('Kim Harland')
    await tick('Register sale')
    await click(button(/Make the deposit slip/))
    await until(() => server.posts.length === 1, 'the slip sent')
    expect(server.posts[0].url).toBe('/bank-feed/deposit-slips?entityId=co1')
    expect(server.posts[0].body).toMatchObject({ receiptIds: ['r1'], registerSaleIds: ['s1'], expectedTotal: 472.5, otherAmount: 0 })
  })

  it('a 409 shows the server’s sentence once and the lists are fetched again in place', async () => {
    await open()
    await tick('Kim Harland')
    const before = server.gets.length
    server.fail = {
      status: 409,
      error: 'Kim Harland’s $460.00 is already on the 2026-10-02 deposit slip. Take it off that slip (void it) or leave it out of this one.',
      then: () => { server.notOnSlip = server.notOnSlip.filter(i => i.id !== 'r1') },
    }
    await click(button(/Make the deposit slip/))
    await until(() => text().includes('already on the 2026-10-02 deposit slip'), 'the server’s sentence')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    const listed = () => [...host.querySelectorAll('label')].some(l => (l.textContent ?? '').includes('Kim Harland'))
    await until(() => server.gets.length > before && !listed(), 'the fresh list')
    expect(server.posts).toHaveLength(1)
    expect(text()).not.toMatch(/reload/i)
  })

  it('a slip whose answer was lost on the way back is seen on the list read again: the form is cleared and pressing again cannot make a second slip', async () => {
    await open()
    await type(host.querySelector('input[placeholder="$0.00"]'), '40')
    await click(button(/No, none of it is rent/))
    await type(host.querySelector('input[placeholder^="What is it?"]'), 'Laundry quarters')
    const day = (host.querySelector('input[type="date"]') as HTMLInputElement).value
    // The server made the slip, then the connection dropped before the answer came back.
    server.fail = {
      status: 504, error: 'The server took too long to answer',
      then: () => {
        server.slips = [{ id: 'slipL', status: 'open', source: 'manual', depositDate: day, total: 40,
          otherAmount: 40, otherNote: 'Laundry quarters', createdByName: 'Lisa', bankPostedDate: null,
          lastBankDay: null, overdue: false, flag: null, items: [] }]
      },
    }
    await click(button(/Make the deposit slip/))
    await until(() => server.toasts.length === 1, 'the slip reported made')
    expect(server.toasts[0]).toBe('Deposit slip made — $40.00. GAM matches it when the bank shows it. (The answer was lost on the way back, but the slip was made.)')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect((host.querySelector('input[placeholder="$0.00"]') as HTMLInputElement).value).toBe('')
    expect(text()).not.toContain('Laundry quarters ·')
    expect(button(/Make the deposit slip/)!.disabled).toBe(true)
    expect(server.posts).toHaveLength(1)
  })

  it('a slip that failed with nothing made keeps the form and says the reason once', async () => {
    await open()
    await tick('Kim Harland')
    server.fail = { status: 504, error: 'The server took too long to answer' }
    await click(button(/Make the deposit slip/))
    await until(() => text().includes('The server took too long to answer.'), 'the reason')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(server.toasts).toHaveLength(0)
    expect(text()).toContain('$460.00')
  })

  // decisions.md #48.2: the Front Desk renders it for staff who take payments,
  // without bank matching (the bank's own deposits stay the owner's).
  describe('on the Front Desk, without bank matching', () => {
    const waitingDeposit = { transactionId: 't1', amount: 497.6, postedDate: '2026-10-03', description: 'BRANCH DEPOSIT',
      fittingSlipIds: [], proposal: { kind: 'one', note: 'Kim and Russ', total: 497.6, items: [] } }

    it('a staffer ticks what went in the bag and makes the slip; no bank deposit is ever shown or matched', async () => {
      server.waiting = [waitingDeposit]
      await open({ canMatchBank: false })
      expect(text()).not.toContain("Bank deposits that may be the office's cash")
      expect(text()).not.toContain('BRANCH DEPOSIT')
      expect(server.gets).toEqual(['/bank-feed/deposits/undeposited', '/bank-feed/deposit-slips'])
      await tick('Kim Harland')
      await click(button(/Make the deposit slip/))
      await until(() => server.posts.length === 1, 'the slip sent')
      expect(server.posts[0].url).toBe('/bank-feed/deposit-slips')
      expect(server.posts[0].body).toMatchObject({ receiptIds: ['r1'], expectedTotal: 460 })
      expect(server.posts.some(p => p.url.includes('/match'))).toBe(false)
    })

    it('the owner on the Bank page (with bank matching) does see the deposits waiting at the bank', async () => {
      server.waiting = [waitingDeposit]
      await open({ entityId: 'co1', canMatchBank: true })
      await until(() => text().includes("Bank deposits that may be the office's cash"), 'the waiting deposit')
      expect(text()).toContain('BRANCH DEPOSIT')
    })
  })

  it('a slip cannot be voided while another is being made, and nothing else starts while a void is in flight', async () => {
    server.slips = [{ id: 'slipA', status: 'open', source: 'manual', depositDate: '2026-10-01', total: 37.6,
      otherAmount: 0, otherNote: null, createdByName: 'Lisa', bankPostedDate: null, lastBankDay: '2026-10-08',
      overdue: false, flag: null, items: [] }]
    await open()
    await until(() => !!button(/^Void this slip$/), 'the open slip')
    expect(button(/^Void this slip$/)!.disabled).toBe(false)
    let release!: () => void
    server.hold = new Promise<void>(r => { release = r })
    await tick('Kim Harland')
    await click(button(/Make the deposit slip/))
    await until(() => text().includes('Making the slip…'), 'the slip in flight')
    expect(button(/^Void this slip$/)!.disabled).toBe(true)
    await act(async () => { release() })
    await until(() => !text().includes('Making the slip…'), 'the slip made')
    expect(button(/^Void this slip$/)!.disabled).toBe(false)

    // Now the void is the thing in flight: it locks itself and the slip maker.
    server.hold = new Promise<void>(r => { release = r })
    await tick('Russ Fuller')
    await click(button(/^Void this slip$/))
    await until(() => server.posts.some(p => p.url.includes('/slipA/void')), 'the void sent')
    expect(button(/^Void this slip$/)!.disabled).toBe(true)
    expect(button(/Make the deposit slip|Making the slip/)!.disabled).toBe(true)
    await act(async () => { release() })
    await until(() => server.toasts.includes('Slip voided.'), 'the void done')
    expect(server.posts.filter(p => p.url.includes('/void'))).toHaveLength(1)
  })

  it('reads the lists in the shape the API actually sends (snake_case rows camelized on the wire)', async () => {
    // What the database rows look like before the API's response converter runs.
    const row = (id: string, amount: number, payer: string, unit: string, kind = 'receipt') => ({
      kind, id, amount, collected_on: '2026-10-02', method: 'money_order', payer_name: payer, unit_number: unit,
      property_name: 'Mountain View RV Ranch', slip_id: null, slip_deposit_date: null,
    })
    server.notOnSlip = [row('r1', 460, 'Kim Harland', 'APT 04')]
    server.onSlip = []
    server.slips = [
      { id: 'slipA', status: 'open', source: 'manual', deposit_date: '2026-10-01', total: 37.6,
        other_amount: 5, other_note: 'laundry quarters', created_by_name: 'Lisa Scheeler',
        bank_posted_date: null, last_bank_day: '2026-10-08', overdue: false, flag: null,
        items: [{ id: 'r2', kind: 'receipt', amount: 32.6, payer_name: 'Russ Fuller', unit_number: 'RV 02',
          method: 'cash', collected_on: '2026-10-01' }] },
      { id: 'slipB', status: 'matched', source: 'inferred', deposit_date: '2026-09-28', total: 100,
        other_amount: 0, other_note: null, created_by_name: null, bank_posted_date: '2026-09-30',
        last_bank_day: null, overdue: false, flag: null, items: [] },
    ]
    server.waiting = [{ transaction_id: 't9', amount: 37.6, posted_date: '2026-10-03', description: 'BRANCH DEPOSIT',
      fitting_slip_ids: ['slipA'], proposal: null }]
    server.wire = (x: any) => camelCaseKeys(x)
    await open({ entityId: 'co1', canMatchBank: true })
    await until(() => text().includes('Kim Harland · APT 04'), 'the cash list')
    expect(text()).toContain('Money order · taken 2026-10-02')
    expect(text()).toContain('made by Lisa Scheeler')
    expect(text()).toContain('the bank should show it by 2026-10-08')
    expect(text()).toContain('Russ Fuller · RV 02 $32.60')
    expect(text()).toContain('Other — laundry quarters $5.00')
    expect(text()).toContain('(bank 2026-09-30)')
    expect(text()).toContain('The 2026-10-01 slip ($37.60) fits this deposit.')
    await click(button(/^Match it to this slip$/))
    await until(() => server.posts.length === 1, 'the match sent')
    expect(server.posts[0]).toMatchObject({ url: '/bank-feed/deposit-slips/slipA/match?entityId=co1', body: { bankTransactionId: 't9' } })
  })

  it('when the slips already made cannot be loaded, it says so once and the cash can still be bagged', async () => {
    server.slipsFail = true
    await open({ canMatchBank: false })
    await until(() => text().includes('The slips already made could not be loaded'), 'the slips error')
    expect(text().split('The slips already made could not be loaded').length - 1).toBe(1)
    // The server's reason, then the next step.
    expect(text()).toContain('The slips already made could not be loaded: The slip list query timed out. Refresh the page; if it keeps happening, tell GAM support.')
    expect(text()).toContain('Kim Harland')
    expect(button(/Make the deposit slip/)).toBeTruthy()
  })

  it('a staffer who only takes payments is told to ask the owner or a manager to record the rent, never a page they cannot open', async () => {
    server.perms = { takePayment: true }
    await open({ canMatchBank: false })
    await type(host.querySelector('input[placeholder="$0.00"]'), '40')
    await until(() => text().includes('Is any of this rent?'), 'the rent question')
    await click(button(/Yes, some is rent/))
    expect(text()).toContain('Ask the owner or a manager to record each rent payment first, then tick it in the list above.')
    expect(text()).not.toContain('Outstanding Balances')
    expect(text()).not.toContain('resident\u2019s page')
  })

  it('a staffer who can open Outstanding Balances but not residents is pointed only there', async () => {
    server.perms = { takePayment: true, 'balances.view': true }
    await open({ canMatchBank: false })
    await type(host.querySelector('input[placeholder="$0.00"]'), '40')
    await until(() => text().includes('Is any of this rent?'), 'the rent question')
    await click(button(/Yes, some is rent/))
    expect(text()).toContain('Record each rent payment first (Record payment, on the Outstanding Balances page), then tick it in the list above.')
  })

  it('a refused cash list (switch just turned on) names the switch and says to sign in again', async () => {
    server.perms = { takePayment: true }
    server.cashFail = { status: 403, error: 'Insufficient permissions' }
    await shown(new QueryClient({ defaultOptions: { queries: { retry: false } } }), { canMatchBank: false })
    await until(() => text().includes('The cash not yet banked is not open to you right now.'), 'the refusal')
    expect(text()).toContain('sign out and back in to pick it up')
    expect(text()).toContain('ask the owner to turn on "Record a cash / check payment" for you')
    expect(text()).not.toContain('Insufficient permissions')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  })

  it('a cash list that fails says the server\u2019s reason, then the next step', async () => {
    server.cashFail = { status: 500, error: 'The cash list query timed out' }
    await shown(new QueryClient({ defaultOptions: { queries: { retry: false } } }), { entityId: 'co1' })
    await until(() => text().includes('The cash list query timed out'), 'the error')
    expect(text()).toContain('The cash list query timed out. Refresh the page; if it keeps happening, tell GAM support.')
  })

  it('a refused slip (403) says to sign in again, once, and the lists are read again', async () => {
    server.perms = { takePayment: true }
    await open({ canMatchBank: false })
    await tick('Kim Harland')
    server.fail = { status: 403, error: 'Insufficient permissions' }
    await click(button(/Make the deposit slip/))
    await until(() => text().includes('Making a bank deposit is not open to you right now.'), 'the refusal')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(text()).not.toContain('Insufficient permissions')
  })

  it('a slip refused for its own reason (403, a payment taken at a property they are not assigned to) says that reason, not the switch', async () => {
    server.perms = { takePayment: true }
    await open({ canMatchBank: false })
    await tick('Kim Harland')
    const said = 'Kim Harland\u2019s $460.00 was taken at a property you are not assigned to.'
    server.fail = { status: 403, error: said }
    await click(button(/Make the deposit slip/))
    await until(() => text().includes(said), 'the server\u2019s reason')
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(text().split(said).length - 1).toBe(1)
    expect(text()).not.toContain('sign out and back in')
    expect(text()).not.toContain('ask the owner to turn on')
  })

  it('a cash list refused for its own reason (403) says that reason with a full stop, not the switch', async () => {
    server.cashFail = { status: 403, error: 'You are not a member of that entity' }
    await shown(new QueryClient({ defaultOptions: { queries: { retry: false } } }), { entityId: 'co9' })
    await until(() => text().includes('You are not a member of that entity.'), 'the server\u2019s reason')
    expect(text()).not.toContain('sign out and back in')
    expect(text()).not.toContain('Record a cash / check payment')
    expect(text()).not.toContain('Refresh the page')
  })

  it('the cash list is read again when the panel is opened again: a payment recorded meanwhile is there to tick', async () => {
    const qc = portalClient()
    await open({ entityId: 'co1' }, qc)
    await until(() => text().includes('Kim Harland'), 'the cash list')
    // Off to a resident's page to record a cash payment, then back.
    await act(async () => { root.render(<QueryClientProvider client={qc}><div>Resident</div></QueryClientProvider>) })
    server.notOnSlip = [...server.notOnSlip, item('r9', 120, 'Dana Ortiz', 'RV 11')]
    const before = server.gets.filter(u => u.startsWith('/bank-feed/deposits/undeposited')).length
    await shown(qc, { entityId: 'co1' })
    await until(() => text().includes('Dana Ortiz · RV 11'), 'the new payment')
    expect(server.gets.filter(u => u.startsWith('/bank-feed/deposits/undeposited')).length).toBeGreaterThan(before)
  })

  it('the deposit day can be today or tomorrow, the same days the server accepts', async () => {
    await open({ canMatchBank: false })
    const day = (n: number) => {
      const d = new Date(); d.setDate(d.getDate() + n)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const input = host.querySelector('input[type="date"]') as HTMLInputElement
    expect(input.value).toBe(day(0))
    expect(input.max).toBe(day(1))
  })
})
