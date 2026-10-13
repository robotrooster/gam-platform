// @vitest-environment jsdom
/**
 * 10/13 (Nic) — GAM Books ledger follow-ups, the screens.
 *
 *   Company-level costs: "post to the COMPANY column by default"; "a later
 *   'split by units' splits only NEW costs". Books Settings says so while not
 *   chosen, and once chosen after the books posted says from when it applies.
 *   Fixed assets: "the form ASKS where the money came from (cash on hand /
 *   owner put money in / loan / already an expense) and posts to that";
 *   "already an expense" LINKS the expense — its cost, day and property are the
 *   asset's, so the form stops asking for them.
 *
 * Every value reads in plain words (never a raw stored value). The same files
 * ship in GAM Books (bookkeeping-parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  gets: {} as Record<string, any>,
  posts: [] as Array<{ url: string; body: any }>,
  patches: [] as Array<{ url: string; body: any }>,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      const key = Object.keys(server.gets).find(k => url === k || url.startsWith(`${k}?`))
      if (!key) throw new Error(`unexpected GET ${url}`)
      return { data: { success: true, data: server.gets[key] } }
    },
    post: async (url: string, body: any) => { server.posts.push({ url, body }); return { data: { success: true, data: { id: 'new1' } } } },
    patch: async (url: string, body: any) => { server.patches.push({ url, body }); return { data: { success: true, data: { ...server.gets['/books/setup/settings'], ...body } } } },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { BooksSettingsPage } from './bookkeeping/BooksSettingsPage'
import { FixedAssetsPage } from './bookkeeping/FixedAssetsPage'

const SETTINGS = {
  companyName: 'Oak Park Motel and RV LLC', canEdit: true, viewer: 'owner',
  booksStartDate: '2026-08-01', historyStart: 'start_date', joinedOn: '2026-08-28', joinMonthStart: '2026-08-01',
  closeBy: 'owner_or_bookkeeper', reopenBy: 'owner', openMonthFixes: 'restate',
  homeSaleMethod: null, workTradeMethod: null, registerStockMethod: 'expense_when_bought', registerStockFrom: null,
  companyCostsMethod: null, companyCostsFrom: null, companyCostsFromDay: null, writeOffBy: 'owner', repairBills: null,
  closedThrough: null, today: '2026-10-13', hasPostings: true, openingItems: 0,
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const radio = (name: string, value: string) => host!.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement
function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function render(el: JSX.Element) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>)
  })
  await flush()
}

beforeEach(() => {
  server.posts = []
  server.patches = []
  server.gets = {
    '/books/setup/settings': { ...SETTINGS },
    '/books/loans/form-options': { booksStartDate: '2026-01-01', today: '2026-10-13', bankAccounts: [] },
    '/books/properties': [{ id: 'p1', name: 'Oak Park' }],
    '/books/fixed-assets': [],
    '/books/fixed-assets/capital-expenses': [],
    '/books/loans': [
      { id: 'l1', name: 'Mower loan', lenderName: 'Deere Financial', fundedTo: 'equipment', voidedAt: null },
      { id: 'l2', name: 'Oak Street mortgage', lenderName: 'First Bank', fundedTo: 'property', voidedAt: null },
      { id: 'l3', name: 'Line of credit', lenderName: 'First Bank', fundedTo: 'bank', voidedAt: null },
    ],
    '/books/fixed-assets/linkable-expenses': [
      { id: 'e1', description: 'New roof', categoryName: 'Repairs', propertyName: 'Oak Park', expenseDate: '2026-02-10', amount: 12000 },
    ],
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

const RAW = ['company_bucket', 'split_by_units', 'funded_by', 'owner_paid', 'cash_on_hand']

describe('Books Settings: costs that are no one property\'s', () => {
  it('not chosen yet: they go to the Company column, and a later split takes only new costs', async () => {
    await render(<BooksSettingsPage />)
    const t = text()
    expect(t).toContain('Until you choose, these costs go to the Company column.')
    expect(t).toContain('splits only costs recorded from then on')
    for (const raw of RAW) expect(t).not.toContain(raw)
    // Not locked: the owner may still pick, even though the books have posted.
    expect(radio('companyCostsMethod', 'split_by_units').disabled).toBe(false)
  })

  it('chosen after the books posted: says from when it applies, and stays as chosen', async () => {
    server.gets['/books/setup/settings'] = { ...SETTINGS, companyCostsMethod: 'split_by_units', companyCostsFromDay: '2026-10-13' }
    await render(<BooksSettingsPage />)
    expect(text()).toContain('Your choice applies to costs recorded from October 13, 2026 on. Costs recorded before then stay in the Company column.')
    expect(radio('companyCostsMethod', 'company_bucket').disabled).toBe(true)
  })
})

describe('Fixed assets: where the money came from', () => {
  async function openAdd() {
    await render(<FixedAssetsPage />)
    await act(async () => { button('+ Add Asset')!.click() })
    await flush()
  }

  it('asks, in plain words, with what each answer does', async () => {
    await openAdd()
    const t = text()
    expect(t).toContain('Where the money came from')
    for (const label of ['Cash on hand', 'The owner put money in', 'A loan', 'Already an expense']) expect(t).toContain(label)
    expect(t).toContain('its cost moves from that expense to this asset, so it counts once')
    for (const raw of RAW) expect(t).not.toContain(raw)
  })

  it('a loan: only loans that paid the seller of what this asset is', async () => {
    await openAdd()
    await act(async () => { radio('fundedBy', 'loan').click() })
    await flush()
    const select = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the loan that paid the seller')) as HTMLSelectElement
    expect(select.options[0].textContent).toBe('Choose the loan that paid the seller')
    // The form starts on a building: only the loan that paid the seller of a property.
    expect([...select.options].slice(1).map(o => o.textContent)).toEqual(['Oak Street mortgage (First Bank)'])
    const what = [...host!.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'equipment')) as HTMLSelectElement
    await act(async () => { choose(what, 'equipment') })
    await flush()
    expect([...select.options].slice(1).map(o => o.textContent)).toEqual(['Mower loan (Deere Financial)'])
    expect(text()).not.toContain('Line of credit')
  })

  it('already an expense: pick it, and its cost, day and property are the asset\'s — the form sends only the link', async () => {
    await openAdd()
    await act(async () => { radio('fundedBy', 'expense').click() })
    await flush()
    expect(text()).not.toContain('What it cost')
    expect(text()).not.toContain('Day you bought it')
    const pick = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the expense')) as HTMLSelectElement
    await act(async () => { choose(pick, 'e1') })
    await flush()
    expect(text()).toContain('$12,000.00 on')
    expect(text()).toContain('filed under Repairs at Oak Park. Its cost, day and property are the asset\'s.')
    const what = [...host!.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'improvement')) as HTMLSelectElement
    await act(async () => { choose(what, 'improvement') })
    const life = host!.querySelector('input[placeholder="e.g. 27.5"]') as HTMLInputElement
    await act(async () => { type(life, '10') })
    await act(async () => { button('Add Asset')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.posts).toHaveLength(1)
    const sent = server.posts[0]
    expect(sent.url).toBe('/books/fixed-assets')
    expect(sent.body).toMatchObject({ name: 'New roof', assetClass: 'improvement', lifeYears: '10', fundedBy: 'expense', expenseId: 'e1' })
    expect(sent.body).not.toHaveProperty('cost')
    expect(sent.body).not.toHaveProperty('acquiredOn')
    expect(sent.body).not.toHaveProperty('propertyId')
    expect(sent.body).not.toHaveProperty('fundedLoanId')
  })

  it('cash on hand: sent with the asset; an asset already on the list that never said gets asked', async () => {
    server.gets['/books/fixed-assets'] = [{
      id: 'a1', name: 'Old mower', assetClass: 'equipment', propertyName: 'Oak Park', inServiceDate: '2026-03-01', acquiredOn: '2026-02-15',
      cost: '6000.00', salvageValue: '600.00', lifeYears: '5.00', depreciates: true, monthly: 90, monthsLeft: 53, depreciatedToDate: 630,
      bookValue: 5370, opensAtBooksStart: false, problem: null, voidedAt: null, sourceExpenseId: null, fundedBy: null, booksStart: '2026-01-01',
    }]
    await openAdd()
    expect(text()).toContain('Say where the money came from (Edit) so its cost is on your books')
    await act(async () => { radio('fundedBy', 'cash').click() })
    const inputs = (sel: string) => host!.querySelector(sel) as HTMLInputElement
    await act(async () => { type(inputs('input[placeholder="e.g. Clubhouse, Riding mower"]'), 'Golf cart') })
    await act(async () => { type(inputs('input[type="number"][min="0.01"]'), '5000') })
    await act(async () => { type(inputs('input[type="date"]'), '2026-09-01') })
    await act(async () => { type(inputs('input[placeholder="e.g. 27.5"]'), '5') })
    await act(async () => { button('Add Asset')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.posts[0].body).toMatchObject({ name: 'Golf cart', cost: '5000', acquiredOn: '2026-09-01', fundedBy: 'cash' })
    expect(server.posts[0].body).not.toHaveProperty('expenseId')
    expect(server.posts[0].body).not.toHaveProperty('fundedLoanId')
  })
})
