// @vitest-environment jsdom
/**
 * 10/12 (Nic, ledger P9): GAM Books' Bank Reconciliation and Close Month pages,
 * shown in the landlord portal's Bookkeeping menu (the same bytes as GAM Books).
 *
 *   Bank Reconciliation: lines the bank feed matched arrive ticked and cannot be
 *   unticked here; a hand tick goes to the server; Finish opens only at a
 *   $0.00 difference.
 *   Close Month: what blocks stops the close (the button stays off); warnings
 *   show and never block; a close asks first, then names the month's last day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  gets: {} as Record<string, unknown>,
  posts: [] as Array<{ url: string; body: any }>,
  postReply: {} as Record<string, unknown>,
  confirm: true,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string) => {
      if (!(url in server.gets)) throw new Error(`unexpected GET ${url}`)
      return { data: { success: true, data: server.gets[url] } }
    },
    post: async (url: string, body: any) => {
      server.posts.push({ url, body })
      if (!(url in server.postReply)) throw new Error(`unexpected POST ${url}`)
      return { data: { success: true, data: server.postReply[url] } }
    },
    patch: async () => { throw new Error('unexpected PATCH') },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({
  toast: Object.assign(() => {}, { error: () => {} }),
  appConfirm: async () => server.confirm,
}))

import { BankReconcilePage } from './bookkeeping/BankReconcilePage'
import { CloseMonthPage } from './bookkeeping/CloseMonthPage'

const ACCT = '11111111-1111-4111-8111-111111111111'
const REC = '22222222-2222-4222-8222-222222222222'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render(el: JSX.Element) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>)
  })
  await flush()
  return host!
}
const text = () => host!.textContent || ''
const button = (label: RegExp) => [...host!.querySelectorAll('button')].find(b => label.test(b.textContent || '')) as HTMLButtonElement | undefined

beforeEach(() => {
  server.gets = {}
  server.posts = []
  server.postReply = {}
  server.confirm = true
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const account = { accountId: ACCT, code: '1010', name: 'Checking: Operating', linked: true, active: true, ledgerBalance: 377.5,
  reconciledThrough: null, reconciledBalance: null, inProgress: { id: REC, statementDate: '2026-09-30', statementBalance: 377.5 } }
const line = (o: object) => ({ bookedOn: null, journalEntry: false, takesBack: false, bankLine: null, clearing: null, automatic: false, ...o })
const worksheet = (o: { ticked: boolean }) => ({
  account, startsAfter: null, beginningBalance: 0, ledgerBalance: 377.5, canceledPairs: 0, history: [],
  reconciliation: { id: REC, status: 'open', statementDate: '2026-09-30', statementBalance: 377.5, beginningBalance: 0, clearedBalance: null,
    completedAt: null, undoneAt: null, undoReason: null, by: null },
  clearedThisStatement: o.ticked ? 377.5 : 417.5, clearedBalance: o.ticked ? 377.5 : 417.5, difference: o.ticked ? 0 : -40,
  notCleared: o.ticked ? 0 : -40, canFinish: o.ticked,
  lines: [
    line({ lineId: 'l-in', day: '2026-09-04', amount: 500, description: 'Money in: laundry', clearing: 'bank_line', automatic: true,
      bankLine: { id: 'b1', day: '2026-09-04', description: 'LAUNDRY CO' } }),
    line({ lineId: 'l-out', day: '2026-09-05', amount: -82.5, description: 'Expense paid: water', clearing: 'bank_line', automatic: true,
      bankLine: { id: 'b2', day: '2026-09-05', description: 'CITY WATER' } }),
    line({ lineId: 'l-hand', day: '2026-09-06', amount: -40, description: 'Expense paid: repair', clearing: o.ticked ? 'ticked' : null }),
  ],
})

describe('Bank Reconciliation on the ledger', () => {
  it('opens the one linked bank\'s statement; matched lines are ticked and locked; a tick goes to the server; Finish opens at $0.00', async () => {
    server.gets['/books/reconcile/accounts'] = [account]
    server.gets[`/books/reconcile/accounts/${ACCT}`] = worksheet({ ticked: false })
    server.postReply[`/books/reconcile/${REC}/tick`] = worksheet({ ticked: true })
    await render(<BankReconcilePage />)
    expect(text()).toContain('Statement ending')
    expect(text()).toContain('Matched to the bank line of')
    const boxes = [...host!.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    expect(boxes.map(b => [b.checked, b.disabled])).toEqual([[true, true], [true, true], [false, false]])
    expect(button(/^Finish$/)?.disabled).toBe(true)
    await act(async () => { boxes[2].click() })
    await flush()
    expect(server.posts).toEqual([{ url: `/books/reconcile/${REC}/tick`, body: { lineIds: ['l-hand'], cleared: true } }])
    expect(button(/^Finish$/)?.disabled).toBe(false)
  })

  it('a company with no bank on its books is told to link one', async () => {
    server.gets['/books/reconcile/accounts'] = []
    await render(<BankReconcilePage />)
    expect(text()).toContain('No bank account is on the books yet')
  })
})

const status = (o: object) => ({
  closedThrough: '2026-08-31', booksStartDate: '2026-01-01', today: '2026-10-13', closeBy: 'owner_or_bookkeeper', reopenBy: 'owner',
  canClose: true, closeRefusal: null, canReopen: true, reopenRefusal: null, nextThrough: '2026-09-30', through: '2026-09-30',
  ready: true, blockers: [], warnings: [], history: [], ...o,
})

describe('Close Month', () => {
  it('what blocks keeps the close off; warnings show but never block', async () => {
    const blocked = status({
      ready: false,
      blockers: [{ key: 'bank:x', text: '1010 Checking: Operating is not reconciled yet — reconcile its statement through 2026-09-30' }],
      warnings: [{ kind: 'unfiled_bank_lines', count: 2, amount: 50, text: '2 bank lines dated on or before 2026-09-30 are not filed yet ($50.00).' }],
    })
    server.gets['/books/close'] = blocked
    server.gets['/books/close?through=2026-09-30'] = blocked
    await render(<CloseMonthPage />)
    expect(text()).toContain('September 2026 cannot close yet')
    expect(text()).toContain('reconcile its statement through 2026-09-30')
    expect(text()).toContain('Bank lines not filed yet')
    expect(button(/^Close September 2026$/)?.disabled).toBe(true)
  })

  it('a ready month closes after the person confirms, through its last day, with the note', async () => {
    const ready = status({ warnings: [{ kind: 'overdue_bills', count: 1, amount: 60, text: '1 unpaid bill was due on or before 2026-09-30.' }] })
    server.gets['/books/close'] = ready
    server.gets['/books/close?through=2026-09-30'] = ready
    server.postReply['/books/close'] = { closeId: '9', closedThrough: '2026-09-30', snapshotRows: 3, status: status({ closedThrough: '2026-09-30', nextThrough: null, through: null }) }
    await render(<CloseMonthPage />)
    expect(text()).toContain('Ready: September 2026 can close.')
    expect(text()).toContain('Unpaid bills past their due date')
    const close = button(/^Close September 2026$/)!
    expect(close.disabled).toBe(false)
    await act(async () => { close.click() })
    await flush()
    expect(server.posts).toEqual([{ url: '/books/close', body: { through: '2026-09-30', note: null } }])
  })

  it('nothing happens when the person does not confirm', async () => {
    server.gets['/books/close'] = status({})
    server.gets['/books/close?through=2026-09-30'] = status({})
    server.confirm = false
    await render(<CloseMonthPage />)
    await act(async () => { button(/^Close September 2026$/)!.click() })
    await flush()
    expect(server.posts).toEqual([])
  })
})
