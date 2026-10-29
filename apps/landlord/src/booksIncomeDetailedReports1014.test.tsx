// @vitest-environment jsdom
/**
 * 10/14 (Nic I1): the Reports page's income table has the same Summary /
 * Detailed switch as the books' P&L. Summary is today's groups; Detailed
 * itemizes them — mobile home lot rent, park-owned trailer rent, RV long-term
 * rent, RV short-term stays — each space subtype beneath its line, the totals
 * unchanged. The switch shows only when the books itemized the period. The
 * same file ships in GAM Books (financials parity).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./financials/adapter', () => ({
  finGet: async () => { throw new Error('no request expected') },
  finPost: async () => { throw new Error('no request expected') },
  openProtectedFile: () => {},
  useViewer: () => ({ canSeeTotals: true }),
  toast: Object.assign(() => {}, { error: () => {} }),
  toastError: () => {},
}))
vi.mock('./financials/EntityPicker', () => ({ EntityPicker: () => null, useEntities: () => ({ entities: [], selected: null }) }))

import { CategoryBreakdownCard } from './financials/ReportsPage'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

const three = (r: number, c: number, o: number) => ({ received: r, charged: c, owed: o })
const view = (details?: any[]): any => ({
  ...three(1180, 2180, 1000), collected: 0, clearing: 0, lines: [], tieText: [], beside: [],
  categories: [
    { category: 'space_rent', label: 'Space rent', ...three(1000, 2000, 1000) },
    { category: 'stays_and_pay_links', label: 'Stays and pay links', ...three(180, 180, 0) },
  ],
  uncategorized: [],
  tie: { charged: { collected: 0, clearing: 0, owed: 0, other: 0 }, received: { forPeriodBills: 0, forEarlierBills: 0, paidAhead: 0, noBill: 0 } },
  ...(details ? { details } : {}),
})

async function show(v: any, extra: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<CategoryBreakdownCard title="Income" view={v} {...extra} />) })
}
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent === label)
const rowNames = () => [...host!.querySelectorAll('tbody tr td.rb-cat-name')].map(td => td.textContent)

describe('the Reports page income table: Summary / Detailed (10/14, Nic I1)', () => {
  it('Summary first (today\'s groups); Detailed lists each line with its subtype beneath it', async () => {
    await show(view([
      { key: 'rent_line:mobile_home_lot', label: 'Mobile home lot rent', category: 'space_rent', ...three(300, 600, 300),
        subtypes: [{ name: 'Double wide', ...three(300, 600, 300) }] },
      { key: 'rent_line:mobile_home_trailer', label: 'Park-owned trailer rent', category: 'space_rent', ...three(700, 1400, 700), subtypes: [] },
      { key: 'stay_line:rv_spot', label: 'RV short-term stays (under 30 nights)', category: 'stays_and_pay_links', ...three(180, 180, 0), subtypes: [] },
    ]))
    expect(button('Summary')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowNames()).toEqual(expect.arrayContaining(['Space rent', 'Stays and pay links']))
    expect(host!.textContent).not.toContain('Mobile home lot rent')
    const totals = host!.querySelector('tfoot')?.textContent
    expect(totals).toContain('$1,180.00')

    await act(async () => { button('Detailed')!.click() })
    expect(button('Detailed')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowNames()).toEqual(expect.arrayContaining([
      'Mobile home lot rent', 'Double wide', 'Park-owned trailer rent', 'RV short-term stays (under 30 nights)']))
    expect(rowNames()).not.toContain('Space rent')
    // The subtype is a row beneath its line, marked as such; the totals do not move.
    const sub = [...host!.querySelectorAll('tbody tr')].find(tr => tr.textContent?.startsWith('Double wide'))
    expect(sub?.className).toBe('rb-subtype-row')
    expect(host!.querySelector('tfoot')?.textContent).toBe(totals)

    await act(async () => { button('Summary')!.click() })
    expect(rowNames()).toEqual(expect.arrayContaining(['Space rent', 'Stays and pay links']))
  })

  it('no switch when the period was not itemized (money records, or nothing to itemize)', async () => {
    await show(view())
    expect(button('Detailed')).toBeUndefined()
    expect(rowNames()).toEqual(expect.arrayContaining(['Space rent', 'Stays and pay links']))
  })
})

// 10/14 (Nic): "Monthly property report PDF/email: itemized lines under each
// group." The monthly report's card opens on Detailed and shows every Summary
// row with its own itemized lines indented beneath it, as the PDF prints them —
// a month stay's "RV long-term rent" under Stays and pay links, where its money is.
describe('the monthly report: itemized lines under each group (10/14, Nic)', () => {
  const groups = [
    { key: 'c:space_rent', label: 'Space rent', lines: [
      { key: 'rent_line:mobile_home_lot', label: 'Mobile home lot rent', ...three(300, 600, 300), subtypes: [{ name: 'Double wide', ...three(300, 600, 300) }] },
      { key: 'rent_line:mobile_home_trailer', label: 'Park-owned trailer rent', ...three(700, 1400, 700), subtypes: [] },
    ] },
    { key: 'c:stays_and_pay_links', label: 'Stays and pay links', lines: [
      { key: 'rent_line:rv_spot', label: 'RV long-term rent', ...three(0, 589, 0), subtypes: [] },
      { key: 'stay_line:rv_spot', label: 'RV short-term stays (under 30 nights)', ...three(180, 180, 0), subtypes: [] },
    ] },
  ]
  const details = [{ key: 'rent_line:rv_spot', label: 'RV long-term rent', category: 'space_rent', ...three(0, 589, 0), subtypes: [] }]

  it('opens on Detailed: each group, then its lines set in, a subtype set in further; Summary still one click away', async () => {
    await show(view(details), { groups, initialMode: 'detailed' })
    expect(button('Detailed')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowNames()).toEqual([
      'Space rent', 'Mobile home lot rent', 'Double wide', 'Park-owned trailer rent',
      'Stays and pay links', 'RV long-term rent', 'RV short-term stays (under 30 nights)',
    ])
    const row = (name: string) => [...host!.querySelectorAll('tbody tr')].find(tr => tr.querySelector('td')?.textContent === name)!
    expect(row('Space rent').className).toBe('rb-group-row')
    expect(row('Mobile home lot rent').querySelector('td')!.className).toBe('rb-cat-name rb-item-name')
    expect(row('Double wide').className).toBe('rb-subtype-row')
    expect(row('Double wide').querySelector('td')!.className).toBe('rb-cat-name rb-subtype-name rb-subtype-deep')
    expect(host!.querySelector('tfoot')?.textContent).toContain('$1,180.00')

    await act(async () => { button('Summary')!.click() })
    expect(rowNames()).toEqual(['Space rent', 'Stays and pay links'])
  })
})
