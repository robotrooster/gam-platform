// @vitest-environment jsdom
/**
 * 10/14 (Nic I1): the books' P&L income has a Summary / Detailed switch.
 * Summary is today's groups; Detailed itemizes them — mobile home lot rent,
 * park-owned trailer rent, RV long-term rent, RV short-term stays — with each
 * space subtype under its line. The switch shows only when the books
 * itemized the period. The same file ships in GAM Books (bookkeeping parity).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./lib/api', () => ({ api: { get: async () => { throw new Error('no request expected') } } }))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'landlord' } }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { LedgerProfitLossView } from './bookkeeping/LedgerStatements'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

const three = (r: number, c: number, o: number) => ({ received: r, charged: c, owed: o })
const data = (details?: any[]) => ({
  source: 'ledger',
  view: {
    ...three(1000, 2000, 0), owed: undefined, tieText: [], beside: [], uncategorized: [],
    categories: [{ category: 'space_rent', label: 'Space rent', ...three(1000, 2000, 1000) }],
    ...(details ? { details } : {}),
  },
  expenses: { rows: [], paid: 0, incurred: 0 }, nets: { received: 1000, charged: 2000 }, chargedBeside: [], corrections: [], incomeAccounts: [],
})

async function show(d: any) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<QueryClientProvider client={new QueryClient()}>
      <LedgerProfitLossView data={d} startDate="2026-09-01" endDate="2026-10-31" setStartDate={() => {}} setEndDate={() => {}} />
    </QueryClientProvider>)
  })
}
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent === label)

describe('the P&L income: Summary / Detailed (10/14, Nic I1)', () => {
  it('Summary first; Detailed lists each line and the subtype beneath it', async () => {
    await show(data([
      { key: 'rent_line:mobile_home_lot', label: 'Mobile home lot rent', category: 'space_rent', ...three(300, 600, 300),
        subtypes: [{ name: 'Double wide', ...three(300, 600, 300) }] },
      { key: 'rent_line:mobile_home_trailer', label: 'Park-owned trailer rent', category: 'space_rent', ...three(700, 1400, 700), subtypes: [] },
    ]))
    expect(host!.textContent).toContain('Space rent')
    expect(host!.textContent).not.toContain('Mobile home lot rent')
    expect(button('Summary')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { button('Detailed')!.click() })
    const t = host!.textContent || ''
    expect(t).toContain('Mobile home lot rent')
    expect(t).toContain('Park-owned trailer rent')
    expect(t).toContain('Double wide')
    expect(t).not.toContain('Space rent')
    expect(button('Detailed')?.className).toBe('btn bp bsm')
  })

  it('no switch when the books did not itemize the period', async () => {
    await show(data())
    expect(button('Detailed')).toBeUndefined()
    expect(host!.textContent).toContain('Space rent')
  })
})
