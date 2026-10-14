// @vitest-environment jsdom
/**
 * 10/13 (Nic) — GAM Books ledger follow-ups, the screens.
 *
 *   10/13 evening (Nic): "each expense is chosen on the split or specific unit
 *   or property at the time of logging. there should never be a default
 *   setting to apply expenses." Books Settings no longer asks where
 *   company-level costs go; each asset asks where it and its depreciation go.
 *   Fixed assets: "the form ASKS where the money came from (cash on hand /
 *   owner put money in / loan / already an expense) and posts to that", and
 *   "Funding: ALLOW A MIX (several funding lines adding up to the cost; a loan
 *   may spread over several assets)" — one line per place the money came
 *   from; "already an expense" LINKS the expense, whole.
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
  writeOffBy: 'owner', repairBills: null,
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
    '/books/cost-places': { asked: true, properties: [{ id: 'p1', name: 'Oak Park', units: [{ id: 'u1', unitNumber: '7' }] }] },
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

const RAW = ['company_bucket', 'split_by_units', 'funded_by', 'owner_paid', 'cash_on_hand']

describe('Books Settings: where a cost goes is no setting (10/13, Nic)', () => {
  it('asks nothing about company-level costs, and shows no stored value', async () => {
    await render(<BooksSettingsPage />)
    const t = text()
    expect(t).not.toContain('Costs that are no one property\'s')
    expect(t).not.toContain('Company column')
    for (const raw of RAW) expect(t).not.toContain(raw)
    expect(host!.querySelector('input[name="companyCostsMethod"]')).toBeNull()
  })
})

describe('Fixed assets: where it goes, and where the money came from', () => {
  async function openAdd() {
    await render(<FixedAssetsPage />)
    await act(async () => { button('+ Add Asset')!.click() })
    await flush()
  }
  const lineKind = (i: number) => [...host!.querySelectorAll('select')].filter(s => s.textContent?.includes('Choose where it came from'))[i] as HTMLSelectElement
  const amounts = () => [...host!.querySelectorAll('input[type="number"]')].filter(x => x.closest('.card')) as HTMLInputElement[]
  const submit = async () => {
    await act(async () => { button('Add Asset')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
  }
  async function basics(name: string, cost: string, what = 'equipment') {
    const inputs = (sel: string) => host!.querySelector(sel) as HTMLInputElement
    await act(async () => { type(inputs('input[placeholder="e.g. Clubhouse, Riding mower"]'), name) })
    const kind = [...host!.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'improvement')) as HTMLSelectElement
    await act(async () => { choose(kind, what) })
    const costBox = [...host!.querySelectorAll('input[type="number"][min="0.01"]')].find(x => !x.closest('.card')) as HTMLInputElement
    await act(async () => { type(costBox, cost) })
    await act(async () => { type(inputs('input[type="date"]'), '2026-09-01') })
    await act(async () => { type(inputs('input[placeholder="e.g. 27.5"]'), '5') })
    await flush()
  }

  it('asks where it goes (nothing chosen) and where each part of the money came from, in plain words', async () => {
    await openAdd()
    const t = text()
    expect(t).toContain('Where this asset (and its depreciation) goes')
    for (const label of ['Split across your properties by units', 'One property', 'One unit']) expect(t).toContain(label)
    expect([...host!.querySelectorAll('input[name="assetPlace"]')].some(r => (r as HTMLInputElement).checked)).toBe(false)
    expect(t).toContain('Where the money came from')
    for (const label of ['Cash on hand', 'The owner put money in', 'A loan', 'Already an expense']) {
      expect([...lineKind(0).options].map(o => o.textContent)).toContain(label)
    }
    for (const raw of RAW) expect(t).not.toContain(raw)
    // Nothing saves until where it goes is answered.
    await basics('Golf cart', '5000')
    await act(async () => { choose(lineKind(0), 'cash') })
    await act(async () => { type(amounts()[0], '5000') })
    await flush()
    expect(text()).toContain('this part comes out of your office cash')
    expect(button('Add Asset')!.disabled).toBe(true)
    await act(async () => { radio('assetPlace', 'split_by_units').click() })
    await flush()
    expect(button('Add Asset')!.disabled).toBe(false)
    await submit()
    expect(server.posts[0].url).toBe('/books/fixed-assets')
    expect(server.posts[0].body).toMatchObject({ name: 'Golf cart', cost: '5000', acquiredOn: '2026-09-01', costPlace: 'split_by_units',
      propertyId: null, unitId: null, funding: [{ kind: 'cash', amount: 5000, loanId: null, expenseId: null }] })
    expect(server.posts[0].body).not.toHaveProperty('fundedBy')
  })

  it('a loan: only loans that paid the seller of what this asset is', async () => {
    await openAdd()
    await act(async () => { choose(lineKind(0), 'loan') })
    await flush()
    const select = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the loan that paid the seller')) as HTMLSelectElement
    expect(select.options[0].textContent).toBe('Choose the loan that paid the seller')
    // The form starts on a building: only the loan that paid the seller of a property.
    expect([...select.options].slice(1).map(o => o.textContent?.split(' · ')[0])).toEqual(['Oak Street mortgage (First Bank)'])
    const what = [...host!.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'equipment')) as HTMLSelectElement
    await act(async () => { choose(what, 'equipment') })
    await flush()
    expect([...select.options].slice(1).map(o => o.textContent?.split(' · ')[0])).toEqual(['Mower loan (Deere Financial)'])
    expect(text()).not.toContain('Line of credit')
  })

  it('a mix: an $8,000 mower = $6,000 from a loan + $2,000 cash on hand, sent as two lines that add up to the cost', async () => {
    await openAdd()
    await basics('Riding mower', '8000')
    await act(async () => { radio('assetPlace', 'property').click() })
    await flush()
    const property = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the property')) as HTMLSelectElement
    await act(async () => { choose(property, 'p1') })
    await act(async () => { choose(lineKind(0), 'loan') })
    await flush()
    const loanPick = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the loan that paid the seller')) as HTMLSelectElement
    await act(async () => { choose(loanPick, 'l1') })
    await act(async () => { type(amounts()[0], '6000') })
    await flush()
    expect(text()).toContain('Adds up to $6,000.00 of $8,000.00')
    expect(button('Add Asset')!.disabled).toBe(true)
    await act(async () => { button('+ Another place the money came from')!.click() })
    await flush()
    await act(async () => { choose(lineKind(1), 'cash') })
    await flush()
    await act(async () => { type(amounts()[1], '2000') })
    await flush()
    expect(text()).toContain('Adds up to $8,000.00 of $8,000.00')
    expect(button('Add Asset')!.disabled).toBe(false)
    await submit()
    expect(server.posts[0].body).toMatchObject({ costPlace: 'property', propertyId: 'p1', unitId: null, funding: [
      { kind: 'loan', amount: 6000, loanId: 'l1', expenseId: null },
      { kind: 'cash', amount: 2000, loanId: null, expenseId: null },
    ] })
  })

  it('already an expense: its whole amount is the line, and its description and day fill in what is blank', async () => {
    await openAdd()
    await act(async () => { choose(lineKind(0), 'expense') })
    await flush()
    expect(text()).toContain('that expense moves to this asset, whole, so it counts once')
    const pick = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the expense')) as HTMLSelectElement
    await act(async () => { choose(pick, 'e1') })
    await flush()
    expect(amounts()[0].value).toBe('12000')
    expect(amounts()[0].disabled).toBe(true)
    expect((host!.querySelector('input[placeholder="e.g. Clubhouse, Riding mower"]') as HTMLInputElement).value).toBe('New roof')
  })

  // 10/13 review: an expense pays for part of an asset only where the asset is
  // (it posts that part of the cost to the asset's account on its own property).
  it('"already an expense" lists only the expenses filed where the asset goes', async () => {
    server.gets['/books/fixed-assets/linkable-expenses'] = [
      { id: 'e1', description: 'New roof', categoryName: 'Repairs', propertyId: 'p1', propertyName: 'Oak Park', expenseDate: '2026-02-10', amount: 12000 },
      { id: 'e2', description: 'Shared mower deposit', categoryName: 'Equipment', propertyId: null, propertyName: null, expenseDate: '2026-02-11', amount: 2000 },
    ]
    await openAdd()
    await act(async () => { choose(lineKind(0), 'expense') })
    await flush()
    const listed = () => [...([...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the expense')) as HTMLSelectElement).options]
      .slice(1).map(o => o.value)
    // Before it is said where the asset goes: every expense that can be linked.
    expect(listed()).toEqual(['e1', 'e2'])
    await act(async () => { radio('assetPlace', 'property').click() })
    await flush()
    const property = [...host!.querySelectorAll('select')].find(s => s.textContent?.includes('Choose the property')) as HTMLSelectElement
    await act(async () => { choose(property, 'p1') })
    await flush()
    expect(listed()).toEqual(['e1'])
    await act(async () => { radio('assetPlace', 'split_by_units').click() })
    await flush()
    expect(listed()).toEqual(['e2'])
  })

  it('an asset already on the list that never said where its money came from, or where it goes, gets asked', async () => {
    server.gets['/books/fixed-assets'] = [{
      id: 'a1', name: 'Old mower', assetClass: 'equipment', propertyName: null, propertyId: null, inServiceDate: '2026-03-01', acquiredOn: '2026-02-15',
      cost: '6000.00', salvageValue: '600.00', lifeYears: '5.00', depreciates: true, monthly: 90, monthsLeft: 53, depreciatedToDate: 630,
      bookValue: 5370, opensAtBooksStart: false, problem: null, voidedAt: null, sourceExpenseId: null, fundedBy: null, funding: [],
      costPlace: null, booksStart: '2026-01-01',
    }]
    await render(<FixedAssetsPage />)
    expect(text()).toContain('Say where the money came from (Edit) so its cost is on your books')
    expect(text()).toContain('Say where it goes (Edit)')
  })
})
