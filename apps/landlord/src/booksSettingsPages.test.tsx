// @vitest-environment jsdom
/**
 * 10/12 (Nic): Books Settings and Opening Balances, the screens. Each choice
 * reads in plain words (never a raw value), a choice not made yet says so, the
 * owner's Save sends only what changed, a bookkeeper reads and changes nothing,
 * and the Opening Balances page sends nobody anywhere before the books have a
 * start date. The same files ship in GAM Books (bookkeeping-parity.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  settings: null as any,
  opening: null as any,
  patches: [] as Array<{ url: string; body: any }>,
  posts: [] as Array<{ url: string; body: any }>,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      if (url === '/books/setup/settings') return { data: { success: true, data: server.settings } }
      if (url === '/books/setup/opening-balances') return { data: { success: true, data: server.opening } }
      throw new Error(`unexpected GET ${url}`)
    },
    patch: async (url: string, body: any) => {
      server.patches.push({ url, body })
      return { data: { success: true, data: { ...server.settings, ...body } } }
    },
    post: async (url: string, body: any) => {
      server.posts.push({ url, body })
      return { data: { success: true, data: server.opening } }
    },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { BooksSettingsPage } from './bookkeeping/BooksSettingsPage'
import { OpeningBalancesPage } from './bookkeeping/OpeningBalancesPage'

const SETTINGS = {
  companyName: 'TruBlu Management LLC', canEdit: true, viewer: 'owner',
  booksStartDate: null, historyStart: null, joinedOn: '2026-08-28', joinMonthStart: '2026-08-01',
  closeBy: 'owner_or_bookkeeper', reopenBy: 'owner', openMonthFixes: 'restate',
  homeSaleMethod: null, workTradeMethod: null, registerStockMethod: 'expense_when_bought', registerStockFrom: null,
  writeOffBy: 'owner', closedThrough: null, today: '2026-10-12', hasPostings: false, openingItems: 0,
}
const OPENING = {
  canEdit: true, seesBank: true, booksStartDate: '2026-10-01', closedThrough: null, homeSaleMethod: 'whole_sale_at_signing',
  chartReady: false,
  items: [
    { id: 'i1', kind: 'bank', amount: '1500.00', asOf: '2026-10-01', paidOn: null, memo: null, enteredAt: '2026-10-12', voidedAt: null,
      voidReason: null, stale: false, bankConnectionId: 'b1', bankName: 'Desert Bank ••4321', leaseId: null, tenantId: null,
      tenantName: null, propertyId: null, propertyName: null, unitLabel: null, accountId: null, accountCode: null, accountName: null, accountType: null },
  ],
  bankAccounts: [{ id: 'b1', name: 'Desert Bank ••4321', status: 'active', suggested: '1480.25', balanceAsOf: null, feedFrom: '2026-09-01' }],
  homeSales: [{ contractId: 'c1', buyerName: 'Rosa Diaz', propertyName: 'Blu Meadows', unitLabel: 'Lot 7', status: 'active',
    financed: '10000.00', principalBeforeStart: '900.00', stillOwed: '9100.00', billedUnpaid: '0.00' }],
  leases: [{ leaseId: 'l1', tenantName: 'Rosa Diaz', propertyName: 'Blu Meadows', unitLabel: 'Lot 7', startDate: '2024-01-01', endDate: null, gamDeposit: null }],
  accounts: [],
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined

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
  server.settings = { ...SETTINGS }
  server.opening = JSON.parse(JSON.stringify(OPENING))
  server.patches = []
  server.posts = []
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('Books Settings', () => {
  it('reads every choice in plain words, says what is not chosen, and saves only what changed', async () => {
    await render(<BooksSettingsPage />)
    const t = text()
    expect(t).toContain('Books Settings')
    expect(t).toContain('Since joining GAM')
    expect(t).toContain('Your books start August 1, 2026, the first day of the month this company joined GAM.')
    expect(t).toContain('The whole sale when it is signed')
    // 10/13 (Nic): "there should never be a default setting to apply expenses" —
    // where a cost goes is asked on each record, never here.
    expect(t).not.toContain('Costs that are no one property\'s')
    expect(t).not.toContain('A Company column of their own')
    expect(t).toContain('Not chosen yet')
    // No raw stored value anywhere on the page.
    for (const raw of ['whole_sale_at_signing', 'income_as_paid', 'rent_and_labor', 'company_bucket', 'owner_or_bookkeeper', 'since_joining', 'expense_when_bought']) {
      expect(t).not.toContain(raw)
    }
    expect(button('Save settings')!.disabled).toBe(true)

    const pick = (name: string, value: string) => host!.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement
    await act(async () => { pick('historyStart', 'since_joining').click() })
    await act(async () => { pick('homeSaleMethod', 'income_as_paid').click() })
    expect(button('Save settings')!.disabled).toBe(false)
    await act(async () => { button('Save settings')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.patches).toEqual([{ url: '/books/setup/settings', body: { historyStart: 'since_joining', homeSaleMethod: 'income_as_paid' } }])
  })

  it('a date the owner picks is required before it saves', async () => {
    await render(<BooksSettingsPage />)
    await act(async () => { (host!.querySelector('input[name="historyStart"][value="start_date"]') as HTMLInputElement).click() })
    expect(host!.querySelector('input[type="date"]')).not.toBeNull()
    await act(async () => { button('Save settings')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(text()).toContain('Enter the date your books start.')
    expect(server.patches).toEqual([])
  })

  it('a bookkeeper reads and changes nothing; a method the books posted under stays', async () => {
    server.settings = { ...SETTINGS, canEdit: false, viewer: 'bookkeeper', homeSaleMethod: 'whole_sale_at_signing', hasPostings: true, booksStartDate: '2026-10-01', historyStart: 'start_date' }
    await render(<BooksSettingsPage />)
    expect(text()).toContain('Only the owner changes these settings.')
    expect(button('Save settings')).toBeUndefined()
    const inputs = [...host!.querySelectorAll('input, select')] as HTMLInputElement[]
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every(i => i.disabled)).toBe(true)
    expect(text()).toContain('Your books have posted under this choice, so it stays as chosen.')
  })
})

describe('Opening Balances', () => {
  it('before the books have a start date, it points to Books Settings and asks for nothing else', async () => {
    server.opening = { ...OPENING, booksStartDate: null, items: [], bankAccounts: [], homeSales: [] }
    await render(<OpeningBalancesPage />)
    expect(text()).toContain('Your books do not have a start date yet.')
    expect(text()).toContain('Books Settings')
    expect(button('+ Add a deposit')).toBeUndefined()
  })

  it('shows the bank suggestion, what was entered, the home sales still owed, and sets up the chart on request', async () => {
    await render(<OpeningBalancesPage />)
    const t = text()
    expect(t).toContain('What your books start with on October 1, 2026.')
    expect(t).toContain('Desert Bank ••4321')
    expect(t).toContain('$1,480.25')
    expect(t).toContain('$1,500.00')
    expect(t).toContain('Rosa Diaz')
    expect(t).toContain('$9,100.00')
    expect(t).toContain('These open as notes owed to you.')
    await act(async () => { button('Set up the chart of accounts')!.click() })
    await flush()
    expect(server.posts.map(p => p.url)).toEqual(['/books/setup/opening-balances/chart'])
  })

  it('a deposit is entered with its tenant, amount and day; a void needs a reason', async () => {
    await render(<OpeningBalancesPage />)
    await act(async () => { button('+ Add a deposit')!.click() })
    const setValue = (sel: string, v: string) => {
      const el = host!.querySelector(sel) as HTMLInputElement | HTMLSelectElement
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    }
    await act(async () => {
      setValue('#ob-lease', 'l1')
      setValue('#ob-dep-amt', '450')
      setValue('#ob-dep-paid', '2024-01-01')
    })
    await act(async () => { button('Save deposit')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(server.posts).toEqual([{ url: '/books/setup/opening-balances', body: { kind: 'deposit_held', leaseId: 'l1', amount: '450', paidOn: '2024-01-01' } }])

    server.posts = []
    await act(async () => { button('Void')!.click() })
    expect(text()).toContain('Void this opening balance?')
    await act(async () => { host!.querySelector('.modal form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(text()).toContain('Say why it is being voided.')
    expect(server.posts).toEqual([])
  })
})
