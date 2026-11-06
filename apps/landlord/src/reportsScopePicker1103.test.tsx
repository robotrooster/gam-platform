// @vitest-environment jsdom
/**
 * 11/3 (Nic): the Reports overview filters by company or by property.
 *
 *   "there's no filter to sort that monthly itemized monthly breakdown by
 *    property. Or by company. So you can't choose TruBlu Management or Oak
 *    Park Motel and RV until after you click into a specific month."
 *
 * What these pin is the SHAPE OF THE CHOICE, which is the part a reader of the
 * screen can get wrong: every company he operates holds one property, so a
 * Company dropdown beside a Property dropdown would have listed "Oak Park
 * Motel and RV LLC" next to "Oak Park Motel and RV" — one answer asked twice.
 * So companies are the rows, and a company's properties appear beneath it only
 * where it holds more than one.
 *
 * The same file ships in GAM Books (financials parity).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** Every URL the page asks for, in order — the proof that a pick re-asks. */
const asked: string[] = []
let reply: (url: string) => any = () => ({})
vi.mock('./financials/adapter', () => ({
  finGet: async (url: string) => { asked.push(url); return reply(url) },
  finPost: async () => { throw new Error('no request expected') },
  openProtectedFile: () => {},
  useViewer: () => ({ can: () => true, openOwnerPage: null }),
  toast: Object.assign(() => {}, { error: () => {} }),
  toastError: () => {},
}))
vi.mock('./financials/EntityPicker', () => ({ EntityPicker: () => null, useEntities: () => ({ entities: [], selected: null }) }))

import { QueryClient, QueryClientProvider } from 'react-query'
import { ReportsPage, ScopePicker, scopeOptions, scopeQuery, scopeCompanyId, scopeName } from './financials/ReportsPage'

const co = (id: string, name: string, props: Array<[string, string]>) =>
  ({ id, name, properties: props.map(([pid, pname]) => ({ id: pid, name: pname })) })

// Nic's own account: two companies, one park each.
const TWO_PARKS = { companies: [
  co('co-mv', 'Mountain View RV Park Ranch LLC', [['p-mv', 'Mountain View RV Ranch']]),
  co('co-op', 'Oak Park Motel and RV LLC', [['p-op', 'Oak Park Motel and RV']]),
] }
// One company holding two parks: there "the company" and "the park" differ.
const ONE_CO_TWO_PARKS = { companies: [
  co('co-rn', 'R&N property', [['p-sf', 'Spanishfork'], ['p-sv', 'Springville']]),
] }
const ONE_OF_EACH = { companies: [co('co-solo', 'Solo LLC', [['p-solo', 'Solo Park']])] }

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function show(scope: any, value = '', onChange: (v: string) => void = () => {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<ScopePicker scope={scope} value={value} onChange={onChange} />) })
}
const options = () => [...host!.querySelectorAll('option')].map(o => o.textContent)

describe('the Reports overview: which company, or which property (11/3)', () => {
  it('lists the companies, and does not list a lone property as a second row for its own company', () => {
    expect(scopeOptions(TWO_PARKS).map(o => o.label))
      .toEqual(['Mountain View RV Park Ranch LLC', 'Oak Park Motel and RV LLC'])
    expect(scopeOptions(TWO_PARKS).every(o => o.value.startsWith('c:'))).toBe(true)
  })

  it('lists the properties beneath a company that holds more than one', () => {
    const only = { companies: [...TWO_PARKS.companies, ...ONE_CO_TWO_PARKS.companies] }
    expect(scopeOptions(only).map(o => [o.label, o.under])).toEqual([
      ['Mountain View RV Park Ranch LLC', false],
      ['Oak Park Motel and RV LLC', false],
      ['R&N property', false],
      ['Spanishfork', true],
      ['Springville', true],
    ])
  })

  it('a single company holding several parks is a plain property list — no company row to repeat it', () => {
    expect(scopeOptions(ONE_CO_TWO_PARKS).map(o => [o.label, o.under]))
      .toEqual([['Spanishfork', false], ['Springville', false]])
  })

  it('asks the server for exactly the slice chosen, and nothing when nothing is chosen', () => {
    expect(scopeQuery('')).toBe('')
    expect(scopeQuery('c:co-op')).toBe('?landlordId=co-op')
    expect(scopeQuery('p:p-sf')).toBe('?propertyId=p-sf')
  })

  it('names the company behind the slice, so a month opens on that company’s P&L', () => {
    expect(scopeCompanyId(TWO_PARKS, 'c:co-op')).toBe('co-op')
    expect(scopeCompanyId(ONE_CO_TWO_PARKS, 'p:p-sv')).toBe('co-rn')
    expect(scopeCompanyId(TWO_PARKS, '')).toBe('')
  })

  it('says in words what the figures cover, for the heading and the printout', () => {
    expect(scopeName(TWO_PARKS, 'c:co-mv')).toBe('Mountain View RV Park Ranch LLC')
    expect(scopeName(ONE_CO_TWO_PARKS, 'p:p-sf')).toBe('Spanishfork')
    expect(scopeName(TWO_PARKS, '')).toBeNull()
  })

  it('renders every company plus a way back to all of them', async () => {
    await show(TWO_PARKS)
    expect(options()).toEqual([
      'Every company you own',
      'Mountain View RV Park Ranch LLC',
      'Oak Park Motel and RV LLC',
    ])
  })

  it('shows nothing at all when there is nothing to choose', async () => {
    await show(ONE_OF_EACH)
    expect(host!.querySelector('select')).toBeNull()
    await show(undefined)
    expect(host!.querySelector('select')).toBeNull()
  })

  it('hands the chosen slice straight back', async () => {
    const picked: string[] = []
    await show(TWO_PARKS, '', v => picked.push(v))
    const select = host!.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'c:co-op'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(picked).toEqual(['c:co-op'])
    expect(scopeQuery(picked[0])).toBe('?landlordId=co-op')
  })
})

// ── the whole tab, end to end on the frontend ────────────────────────────────
/**
 * The seam the helpers above cannot cover: that the report's own `scope` reaches
 * the control, that a pick re-asks the server for that slice, and that the
 * figures then say which slice they are.
 */
const summaryFor = (companies: any[]) => ({
  scope: { companies, landlordId: null, propertyId: null, payoutsBelongHere: true },
  incomeCard: null,
  thisMonth: { month: '2026-11', charged: 1000, received: 800, owed: 200, tieText: [] },
  ytd: { charged: 1000, received: 800, owed: 200 },
  ytdMonthly: [],
  monthly: [{ month: '2026-11', charged: 1000, received: 800, owed: 200, expenses: 0,
              netReceived: 800, netCharged: 1000, disbursed: null, fees: null }],
  outstanding: 200,
  occupancyRate: 50,
})

describe('the Reports overview asks the server for the slice that was picked', () => {
  it('offers the report’s own companies, re-asks on a pick, and labels the figures', async () => {
    asked.length = 0
    reply = url => url.startsWith('/reports/ledger-status') ? { live: false } : summaryFor(TWO_PARKS.companies)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root!.render(<QueryClientProvider client={client}><ReportsPage /></QueryClientProvider>)
    })

    // It started on everything, with no slice named.
    expect(asked).toContain('/reports/summary')
    expect(host!.textContent).not.toContain('These figures cover')

    const select = host!.querySelector('select') as HTMLSelectElement
    expect([...select.options].map(o => o.textContent)).toEqual([
      'Every company you own',
      'Mountain View RV Park Ranch LLC',
      'Oak Park Motel and RV LLC',
    ])

    await act(async () => {
      select.value = 'c:co-op'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // It asked again, for that company alone.
    expect(asked).toContain('/reports/summary?landlordId=co-op')
    // And the page says so — in the heading and above the figures.
    expect(host!.textContent).toContain('These figures cover')
    expect(host!.textContent).toContain('Monthly Breakdown — Oak Park Motel and RV LLC')
    // The control still offers the way back and the other company.
    expect([...(host!.querySelector('select') as HTMLSelectElement).options].map(o => o.textContent))
      .toContain('Every company you own')
  })
})
