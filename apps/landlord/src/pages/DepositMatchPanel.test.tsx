// @vitest-environment jsdom
/**
 * The owner's bank review (DepositMatchPanel): who could have made a deposit.
 * decisions #48.1 + #52 — an amount-only match on a TRANSFER memo is never
 * picked for the owner, and confirming it needs a deliberate pick. Only a
 * match the server marks `preselect` opens already picked. A refused confirm
 * says the server's sentence once and reads the list again in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

const server = vi.hoisted(() => ({
  deposits: [] as any[],
  gets: [] as string[],
  posts: [] as { url: string; body: any }[],
  fail: null as null | { status: number; error: string },
  /** GET url prefix → refused with this status and sentence. */
  getFail: {} as Record<string, { status: number; error: string }>,
  /** The owner's companies (null: a team login's 403, read as none). */
  entities: null as null | { id: string; businessName: string }[],
  /** When set, a POST waits for it (a request still in flight). */
  postGate: null as null | Promise<void>,
  /** After a not-rent POST, the server no longer lists that deposit. */
  dropOnNotRent: true,
  aside: [] as any[],
}))
const httpError = (status: number, error: string) =>
  Object.assign(new Error(error), { response: { status, data: { success: false, error } } })

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    const no = Object.entries(server.getFail).find(([k]) => url.startsWith(k))
    if (no) throw httpError(no[1].status, no[1].error)
    if (url === '/landlords/me/entities') {
      if (!server.entities) throw httpError(403, 'Forbidden')
      return server.entities
    }
    if (url.startsWith('/bank-feed/cash-position')) {
      return { onSlip: { items: [], total: 0 }, notOnSlip: { items: [], total: 0 }, unbankedTotal: 0, oldestDays: 0 }
    }
    if (url.startsWith('/bank-feed/deposits/unmatched')) {
      // Passed through the API's own response converter, the way it reaches the browser.
      const { camelCaseKeys } = await import('../../../api/src/lib/caseConversion')
      // The set-aside deposits still waiting on the Bank feed, as the server lists them.
      const setAside = server.aside.filter(Boolean).map(d => ({
        transaction_id: d.transactionId, amount: d.amount, posted_date: d.postedDate,
        description: d.description, set_at: '2026-10-04T12:00:00Z',
      }))
      return camelCaseKeys({ deposits: server.deposits, remaining: 0, set_aside: setAside, set_aside_remaining: 0 })
    }
    throw new Error(`unexpected GET ${url}`)
  },
  apiPost: async (url: string, body: any) => {
    server.posts.push({ url, body })
    if (server.postGate) await server.postGate
    if (server.fail) { const f = server.fail; server.fail = null; throw httpError(f.status, f.error) }
    const m = /^\/bank-feed\/deposits\/([^/]+)\/not-rent$/.exec(url)
    if (m && server.dropOnNotRent) {
      const d = server.deposits.find(x => x.transactionId === m[1])
      server.aside.push(d)
      server.deposits = server.deposits.filter(x => x.transactionId !== m[1])
    }
    const u = /^\/bank-feed\/deposits\/([^/]+)\/not-rent\/undo$/.exec(url)
    if (u) {
      const d = server.aside.find(x => x?.transactionId === u[1])
      if (d) server.deposits = [...server.deposits, d]
      server.aside = server.aside.filter(x => x?.transactionId !== u[1])
    }
    return { success: true, data: {} }
  },
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u_owner', role: 'landlord', permissions: {} } }),
}))
vi.mock('../components/dialogs', () => ({ appConfirm: async () => true, toast: () => {} }))
vi.mock('./MakeDepositPanel', () => ({
  MakeDepositPanel: () => <div>Make a bank deposit panel</div>,
}))

import { DepositMatchPanel, CashPositionPanel } from './DepositMatchPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** One candidate as services/bankDepositCandidates sends it. */
const cand = (o: { leaseId: string; tenantName: string; unit: string; confidence: string; preselect: boolean; chargeIds: string[] }) => ({
  chargeIds: o.chargeIds, leaseId: o.leaseId, tenantId: `t_${o.leaseId}`, tenantName: o.tenantName,
  unitNumber: o.unit, total: 450, owed: 450, exact: true, confidence: o.confidence, rivals: 0,
  reason: 'Rent $450.00', preselect: o.preselect,
})
const deposit = (o: { id: string; description: string; transferMemo: boolean; candidates: any[] }) => ({
  transactionId: o.id, amount: 450, postedDate: '2026-10-03', description: o.description,
  transferMemo: o.transferMemo, candidates: o.candidates,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  server.deposits = []; server.gets = []; server.posts = []; server.fail = null
  server.getFail = {}; server.entities = null; server.postGate = null; server.dropOnNotRent = true; server.aside = []
  try { window.sessionStorage.clear() } catch { /* none */ }
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
const radios = () => [...host.querySelectorAll('input[type="radio"]')] as HTMLInputElement[]
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}; screen: ${text()}`)
}
async function open() {
  await mount(<DepositMatchPanel />)
  await until(() => text().includes('Posted'), 'the deposits')
}
async function mount(el: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>)
  })
}
async function click(el: Element | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => { (el as HTMLElement).click() })
}

describe('the owner’s bank review', () => {
  it('a TRANSFER memo with an amount-only match opens with nothing picked: Record stays off until the owner picks, then confirms that tenant’s charges', async () => {
    server.deposits = [deposit({
      id: 'txn1', description: 'ONLINE TRANSFER FROM CHK 1234', transferMemo: true,
      candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'amount_unique', preselect: false, chargeIds: ['c1'] })],
    })]
    await open()
    expect(text()).toContain('The bank says this was a transfer between accounts — most often your own money.')
    expect(radios().some(r => r.checked)).toBe(false)
    const record = button(/Pick who paid this deposit/)
    expect(record).toBeTruthy()
    expect(record!.disabled).toBe(true)
    await click(record)
    expect(server.posts).toHaveLength(0)

    await click(radios()[0])
    await until(() => !!button(/Record as paid by Kim Harland/), 'the deliberate pick')
    expect(button(/Record as paid by Kim Harland/)!.disabled).toBe(false)
    await click(button(/Record as paid by Kim Harland/))
    await until(() => server.posts.length === 1, 'the confirm')
    expect(server.posts[0]).toEqual({
      url: '/bank-feed/deposits/txn1/confirm', body: { chargeIds: ['c1'], method: 'cash', declarationId: null },
    })
  })

  it('a match the server is sure of opens picked; one it is not sure of does not', async () => {
    server.deposits = [
      deposit({ id: 'txn1', description: 'DEPOSIT', transferMemo: false,
        candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'amount_unique', preselect: true, chargeIds: ['c1'] })] }),
      deposit({ id: 'txn2', description: 'DEPOSIT', transferMemo: false,
        candidates: [
          cand({ leaseId: 'l2', tenantName: 'Russ Fuller', unit: 'RV 02', confidence: 'amount_ambiguous', preselect: false, chargeIds: ['c2'] }),
          cand({ leaseId: 'l3', tenantName: 'Shane Rueff', unit: 'MH 11', confidence: 'amount_ambiguous', preselect: false, chargeIds: ['c3'] }),
        ] }),
    ]
    await open()
    expect(radios().map(r => r.checked)).toEqual([true, false, false])
    expect(button(/Record as paid by Kim Harland/)!.disabled).toBe(false)
    expect(button(/Pick who paid this deposit/)!.disabled).toBe(true)
    // The transfer note is only for a transfer.
    expect(text()).not.toContain('transfer between accounts')
  })

  it('every button on a card is a real button (base btn class), so “Pick who paid this deposit” shows as off while nobody is picked', async () => {
    server.deposits = [deposit({ id: 'txn1', description: 'ONLINE TRANSFER FROM CHK 1234', transferMemo: true,
      candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'amount_unique', preselect: false, chargeIds: ['c1'] })] })]
    await open()
    const all = [...host.querySelectorAll('button')]
    expect(all.length).toBeGreaterThan(0)
    for (const b of all) expect(b.classList.contains('btn')).toBe(true)
    const record = button(/Pick who paid this deposit/)!
    expect(record.disabled).toBe(true)
    expect(record.classList.contains('btn-primary')).toBe(true)
  })

  it('a refused confirm says the server’s sentence once and the list is read again in place', async () => {
    server.deposits = [deposit({ id: 'txn1', description: 'DEPOSIT', transferMemo: false,
      candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'named_exact', preselect: true, chargeIds: ['c1'] })] })]
    await open()
    const before = server.gets.length
    server.fail = { status: 409, error: 'That deposit was already matched' }
    await click(button(/Record as paid by Kim Harland/))
    await until(() => text().includes('That deposit was already matched. The list has been read again.'), 'the sentence')
    await until(() => server.gets.length > before, 'the list read again')
    expect(text().split('That deposit was already matched').length - 1).toBe(1)
  })
})


describe('“Not a rent payment”', () => {
  const transfer = () => deposit({ id: 'txn1', description: 'ONLINE TRANSFER FROM CHK 1234', transferMemo: true,
    candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'amount_unique', preselect: false, chargeIds: ['c1'] })] })

  it('takes the deposit off the list, says where it went, and offers Undo, which puts it back', async () => {
    server.deposits = [transfer()]
    await open()
    await click(button(/^Not a rent payment$/))
    await until(() => text().includes('is set aside as not a rent payment'), 'the set-aside note')
    expect(server.posts).toEqual([{ url: '/bank-feed/deposits/txn1/not-rent', body: {} }])
    await until(() => !text().includes('Posted 2026-10-03'), 'the deposit to leave the list')
    expect(text()).toContain('The $450.00 deposit posted 2026-10-03 is set aside as not a rent payment: it is no longer offered against tenants, and GAM will not record it as a tenant\'s payment. It waits on the Bank feed tab under Needs review, where you file it or ignore it.')
    expect(text()).not.toContain('Kim Harland')
    // Undo is the back-out: gray, never gold — and a real button (the base
    // `btn` class carries the padding and the disabled look).
    expect(button(/^Undo$/)!.classList.contains('btn')).toBe(true)
    expect(button(/^Undo$/)!.classList.contains('btn-ghost')).toBe(true)
    expect(button(/^Undo$/)!.classList.contains('btn-primary')).toBe(false)

    await click(button(/^Undo$/))
    await until(() => text().includes('Posted 2026-10-03'), 'the deposit back on the list')
    expect(server.posts[1]).toEqual({ url: '/bank-feed/deposits/txn1/not-rent/undo', body: {} })
    expect(text()).not.toContain('is set aside')
  })

  it('“Not a rent payment” is an action, so it is gold', async () => {
    server.deposits = [transfer()]
    await open()
    expect(button(/^Not a rent payment$/)!.classList.contains('btn')).toBe(true)
    expect(button(/^Not a rent payment$/)!.classList.contains('btn-primary')).toBe(true)
  })

  it('the set-aside note links straight to the Bank feed tab, filtered to Needs review', async () => {
    server.deposits = [transfer()]
    await open()
    await click(button(/^Not a rent payment$/))
    await until(() => text().includes('is set aside'), 'the set-aside note')
    const link = [...host.querySelectorAll('a')].find(a => a.textContent === 'Bank feed tab under Needs review') as HTMLAnchorElement
    expect(link).toBeTruthy()
    const u = new URL(link.href)
    expect(u.searchParams.get('tab')).toBe('feed')
    expect(u.searchParams.get('view')).toBe('needs_review')
    expect(u.pathname).toBe(window.location.pathname)
  })

  it('the link to Needs review carries the company picked here, so an owner of several companies lands on that company’s feed', async () => {
    server.entities = [{ id: 'ent_a', businessName: 'Alpha LLC' }, { id: 'ent_b', businessName: 'Beta LLC' }]
    server.deposits = [transfer()]
    await mount(<DepositMatchPanel entityId="ent_b" />)
    await until(() => text().includes('Posted'), 'the deposits')
    await click(button(/^Not a rent payment$/))
    await until(() => text().includes('is set aside'), 'the set-aside note')
    const link = [...host.querySelectorAll('a')].find(a => a.textContent === 'Bank feed tab under Needs review') as HTMLAnchorElement
    const u = new URL(link.href)
    expect(u.searchParams.get('view')).toBe('needs_review')
    expect(u.searchParams.get('entityId')).toBe('ent_b')
  })

  it('the set-aside note can be put away with its ×, without undoing anything', async () => {
    server.deposits = [transfer()]
    await open()
    await click(button(/^Not a rent payment$/))
    await until(() => text().includes('is set aside'), 'the set-aside note')
    const x = [...host.querySelectorAll('button')].find(b => /Put away the note/.test(b.getAttribute('aria-label') ?? ''))
    expect(x!.classList.contains('btn')).toBe(true)
    expect(x!.classList.contains('btn-ghost')).toBe(true)
    await click(x)
    expect(text()).not.toContain('is set aside')
    expect(server.posts).toEqual([{ url: '/bank-feed/deposits/txn1/not-rent', body: {} }])
  })

  it('the note and its Undo come from the server: after a reload the note is still there, and Undo still puts the deposit back', async () => {
    server.deposits = [transfer()]
    await open()
    await click(button(/^Not a rent payment$/))
    await until(() => text().includes('is set aside'), 'the set-aside note')
    // A reload: a new page, nothing remembered in memory.
    act(() => root.unmount())
    root = createRoot(host)
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('is set aside as not a rent payment'), 'the note after the reload')
    await click(button(/^Undo$/))
    await until(() => text().includes('Posted 2026-10-03'), 'the deposit back on the list')
    expect(server.posts.at(-1)).toEqual({ url: '/bank-feed/deposits/txn1/not-rent/undo', body: {} })
    expect(text()).not.toContain('is set aside')
  })

  it('a deposit set aside somewhere else (the landlord assistant) is shown with its Undo too', async () => {
    server.aside = [transfer()]
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('The $450.00 deposit posted 2026-10-03 is set aside as not a rent payment'), 'the note')
    expect(button(/^Undo$/)).toBeTruthy()
  })

  it('the × puts a note away for this session only: it stays away after a reload, and the deposit stays set aside', async () => {
    server.aside = [transfer()]
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('is set aside'), 'the note')
    const x = [...host.querySelectorAll('button')].find(b => /Put away the note/.test(b.getAttribute('aria-label') ?? ''))
    await click(x)
    expect(text()).not.toContain('is set aside')
    act(() => root.unmount())
    root = createRoot(host)
    await mount(<DepositMatchPanel />)
    await until(() => server.gets.filter(u => u.startsWith('/bank-feed/deposits/unmatched')).length >= 2, 'the list read again')
    await until(() => text().includes('No deposits are waiting'), 'the page')
    expect(text()).not.toContain('is set aside')
    expect(server.posts).toEqual([])
  })

  it('an Undo the server refuses because the deposit was matched on the Bank feed meanwhile: the note goes, the reason is said once above the list by the deposit’s name, and its × puts it away', async () => {
    server.aside = [transfer()]
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('is set aside'), 'the note')
    server.fail = { status: 409, error: 'That deposit was matched on the Bank feed meanwhile, so it cannot come back to this list.' }
    server.aside = []   // matched on the Bank feed: no longer waiting there
    await click(button(/^Undo$/))
    const said = 'The $450.00 deposit posted 2026-10-03: That deposit was matched on the Bank feed meanwhile, so it cannot come back to this list. The list has been read again.'
    await until(() => text().includes(said), 'the reason above the list')
    await until(() => !text().includes('is set aside'), 'the note gone')
    expect(text().split('matched on the Bank feed meanwhile').length - 1).toBe(1)
    expect(text()).not.toContain('Try again')
    const x = [...host.querySelectorAll('button')].find(b => /Put away the message about The \$450\.00 deposit/.test(b.getAttribute('aria-label') ?? ''))
    expect(x).toBeTruthy()
    await click(x)
    expect(text()).not.toContain('matched on the Bank feed meanwhile')
  })

  it('an Undo that fails and may pass (500) keeps the note and its Undo, and says to try again once, on the note', async () => {
    server.aside = [transfer()]
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('is set aside'), 'the note')
    server.fail = { status: 500, error: 'The bank page did not answer' }
    await click(button(/^Undo$/))
    const said = 'The bank page did not answer. Try again; if it keeps happening, tell GAM support.'
    await until(() => text().includes(said), 'the reason')
    expect(text().split('Try again').length - 1).toBe(1)
    expect(text()).toContain('is set aside as not a rent payment')
    const note = button(/^Undo$/)!.closest('.card') as HTMLElement
    expect(note.textContent).toContain(said)
    expect(button(/^Undo$/)!.disabled).toBe(false)
  })

  it('a double press sends one request: the button is off while it is in flight', async () => {
    server.deposits = [transfer()]
    let release!: () => void
    server.postGate = new Promise<void>(r => { release = r })
    await open()
    await click(button(/^Not a rent payment$/))
    await until(() => !!button(/^Setting aside…$/), 'the in-flight label')
    expect(button(/^Setting aside…$/)!.disabled).toBe(true)
    await click(button(/^Setting aside…$/))
    expect(server.posts).toHaveLength(1)
    await act(async () => { release() })
    await until(() => text().includes('is set aside'), 'the set-aside note')
    expect(server.posts).toHaveLength(1)
  })
})

describe('a failed action is said once, by the deposit it belongs to', () => {
  const two = () => [
    deposit({ id: 'txn1', description: 'DEPOSIT', transferMemo: false,
      candidates: [cand({ leaseId: 'l1', tenantName: 'Kim Harland', unit: 'APT 04', confidence: 'named_exact', preselect: true, chargeIds: ['c1'] })] }),
    { ...deposit({ id: 'txn2', description: 'DEPOSIT', transferMemo: false,
      candidates: [cand({ leaseId: 'l2', tenantName: 'Russ Fuller', unit: 'RV 02', confidence: 'named_exact', preselect: true, chargeIds: ['c2'] })] }),
      amount: 275, postedDate: '2026-10-02' },
  ]
  const card = (who: RegExp) => button(who)!.closest('.card') as HTMLElement

  it('a server fault (5xx) says to try again, on that deposit’s card only, never “read again”', async () => {
    server.deposits = two()
    await open()
    server.fail = { status: 502, error: 'The bank page did not answer' }
    await click(button(/Record as paid by Russ Fuller/))
    const said = 'The bank page did not answer. Try again; if it keeps happening, tell GAM support.'
    await until(() => text().includes(said), 'the sentence')
    expect(card(/Record as paid by Russ Fuller/).textContent).toContain(said)
    expect(card(/Record as paid by Kim Harland/).textContent).not.toContain(said)
    expect(text().split('The bank page did not answer').length - 1).toBe(1)
    expect(text()).not.toContain('The list has been read again')
  })

  it('“too many requests” (429) is said in plain words with try again', async () => {
    server.deposits = two()
    await open()
    server.fail = { status: 429, error: '' }
    await click(button(/Record as paid by Kim Harland/))
    await until(() => text().includes('GAM was too busy to do that just now. Try again; if it keeps happening, tell GAM support.'), 'the sentence')
  })

  it('a refusal for a deposit that left the list meanwhile is said once above the list, naming the deposit', async () => {
    server.deposits = two()
    await open()
    server.fail = { status: 409, error: 'That deposit was already matched' }
    server.deposits = server.deposits.filter(d => d.transactionId !== 'txn2')   // someone else matched it
    await click(button(/Record as paid by Russ Fuller/))
    const said = 'The $275.00 deposit posted 2026-10-02: That deposit was already matched. The list has been read again.'
    await until(() => text().includes(said), 'the sentence above the list')
    await until(() => !button(/Record as paid by Russ Fuller/), 'the deposit gone')
    expect(text().split('That deposit was already matched').length - 1).toBe(1)
    expect(text()).not.toContain('Try again')
    // It can be put away: a gray × beside it.
    const x = [...host.querySelectorAll('button')].find(b => /Put away the message about The \$275\.00 deposit/.test(b.getAttribute('aria-label') ?? ''))
    expect(x!.classList.contains('btn')).toBe(true)
    expect(x!.classList.contains('btn-ghost')).toBe(true)
    await click(x)
    expect(text()).not.toContain('That deposit was already matched')
  })

  it('“Recording…” shows only on the card being recorded; the others wait', async () => {
    server.deposits = two()
    let release!: () => void
    server.postGate = new Promise<void>(r => { release = r })
    await open()
    await click(button(/Record as paid by Kim Harland/))
    await until(() => !!button(/^Recording…$/), 'the in-flight label')
    expect([...host.querySelectorAll('button')].filter(b => b.textContent === 'Recording…')).toHaveLength(1)
    expect(button(/Record as paid by Russ Fuller/)!.disabled).toBe(true)
    await act(async () => { release() })
    await until(() => !button(/^Recording…$/), 'the record to finish')
  })
})

describe('a list that did not load never reads as “nothing here”', () => {
  it('the deposits list refused (400) says so with the next step, never “No deposits are waiting”', async () => {
    server.getFail = { '/bank-feed/deposits/unmatched': { status: 400, error: 'The deposits could not be read' } }
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('could not be loaded'), 'the sentence')
    expect(text()).toBe('The deposits waiting to be matched could not be loaded: The deposits could not be read. Refresh the page; if it keeps happening, tell GAM support.')
    expect(text()).not.toContain('No deposits are waiting')
  })

  it('an owner of several companies with none chosen is asked to choose, and nothing is asked of the server', async () => {
    server.entities = [{ id: 'co1', businessName: 'Oak Park' }, { id: 'co2', businessName: 'Mountain View' }]
    await mount(<DepositMatchPanel />)
    await until(() => text().includes('Choose a company above to see its deposits.'), 'the choose prompt')
    expect(server.gets.some(u => u.startsWith('/bank-feed/deposits/unmatched'))).toBe(false)
    expect(text()).not.toContain('No deposits are waiting')
  })

  it('the cash not yet banked refused (400) says so, never “every payment has been accounted for”', async () => {
    server.getFail = { '/bank-feed/cash-position': { status: 400, error: 'The cash could not be read' } }
    await mount(<CashPositionPanel />)
    await until(() => text().includes('could not be loaded'), 'the sentence')
    expect(text()).toContain('The cash not yet banked could not be loaded: The cash could not be read. Refresh the page; if it keeps happening, tell GAM support.')
    expect(text()).not.toContain('has been accounted for')
  })

  it('the cash panel asks an owner of several companies to choose one first, and asks the server nothing', async () => {
    server.entities = [{ id: 'co1', businessName: 'Oak Park' }, { id: 'co2', businessName: 'Mountain View' }]
    await mount(<CashPositionPanel />)
    await until(() => text().includes('Choose a company above'), 'the choose prompt')
    expect(server.gets.some(u => u.startsWith('/bank-feed/cash-position'))).toBe(false)
    expect(text()).not.toContain('has been accounted for')
    expect(text()).not.toContain('Make a bank deposit panel')
  })

  it('with a company chosen, the cash panel loads it', async () => {
    server.entities = [{ id: 'co1', businessName: 'Oak Park' }, { id: 'co2', businessName: 'Mountain View' }]
    await mount(<CashPositionPanel entityId="co2" />)
    await until(() => text().includes('has been accounted for'), 'the cash panel')
    expect(server.gets).toContain('/bank-feed/cash-position?entityId=co2')
  })
})

// 10/5 (Nic): the tenant's report on the match screen — its reference, their
// photo of the bank's receipt, and a plain flag when the bank shows a later day.
describe('a deposit a tenant reported', () => {
  const reported = (declaration: any) => deposit({
    id: 'txn9', description: 'BRANCH DEPOSIT', transferMemo: false,
    candidates: [{
      ...cand({ leaseId: 'l1', tenantName: 'Rae Tull', unit: 'Lot 7', confidence: 'declared', preselect: true, chargeIds: ['c1'] }),
      declaration,
    }],
  })

  it('posted later than the next business day: says so in plain words, with the reference and the tenant’s photo', async () => {
    server.deposits = [{ ...reported({
      id: 'dd1', declaredDate: '2026-09-28', reference: 'DEP-1001',
      receiptPhotoUrl: '/api/declared-deposits/receipt-photos/r.jpg', dateHolds: false,
    }), postedDate: '2026-10-03' }]
    await open()
    expect(text()).toContain('Tenant reported this deposit')
    expect(text()).toContain('Deposit reference DEP-1001')
    expect(text()).toContain('Said they deposited Sep 28 — the bank shows Oct 3. The bank\'s date counts, so late fees up to it stay.')
    expect(button(/^Tenant's photo of the bank receipt$/)).toBeTruthy()
    // The photo opens in the app, not by picking the tenant.
    expect(radios()[0].checked).toBe(true)
  })

  it('the flag is said once, and recording it ties the deposit to that very report', async () => {
    server.deposits = [{ ...reported({
      id: 'dd1', declaredDate: '2026-09-28', reference: 'DEP-1001', receiptPhotoUrl: null, dateHolds: false,
    }), postedDate: '2026-10-03' }]
    // The reason as the server writes it (bankDepositMatch.matchDeposit): the flag is not in it.
    server.deposits[0].candidates[0].reason = 'Rae Tull reported paying $450.00 at the bank on 2026-09-28, and this deposit matches 1 charge exactly.'
    await open()
    expect(text().split('Said they deposited Sep 28').length - 1).toBe(1)
    await click(button(/Record as paid by Rae Tull/))
    await until(() => server.posts.length === 1, 'the confirm')
    expect(server.posts[0]).toEqual({
      url: '/bank-feed/deposits/txn9/confirm', body: { chargeIds: ['c1'], method: 'cash', declarationId: 'dd1' },
    })
  })

  it('posted when they said (or the next business day): no flag', async () => {
    server.deposits = [reported({ id: 'dd1', declaredDate: '2026-10-02', reference: 'DEP-1002', receiptPhotoUrl: null, dateHolds: true })]
    await open()
    expect(text()).toContain('Deposit reference DEP-1002')
    expect(text()).not.toContain('Said they deposited')
    expect(button(/^Tenant's photo of the bank receipt$/)).toBeUndefined()
  })
})
