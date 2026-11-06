// @vitest-environment jsdom
/**
 * 11/4 (Nic): WHY A ROW'S THREE FIGURES DO NOT SUBTRACT.
 *
 *   "Rent is showing $15,000 received, almost $16,000, but over $18,500
 *    charged, and owed is only $955... every line is actually wrong. Nothing
 *    maths out exactly right except for the home and trailer payments, $333
 *    received, $333 charged, $0 owed."
 *
 * The last sentence is the spec: he checks Charged − Received against Owed on
 * every row, and the row that passed is the one with nothing in the fourth
 * bucket. So the explanation shows on the rows that fail that check and stays
 * off the rows that pass it. The figures below are Mountain View's real
 * October, which is the report he was reading.
 *
 * The same file ships in GAM Books (financials parity).
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

/** Mountain View, October 2026, as the books report it. */
const view = (): any => ({
  received: 21816.17, charged: 22710.71, owed: 1265, collected: 21445.71, clearing: 0, source: 'ledger',
  categories: [
    { category: 'space_rent', label: 'Space rent', received: 15755.64, charged: 18502, owed: 955,
      parts: { collected: 16958, clearing: 0, owed: 955, other: 589 } },
    // The one row he said was right: 333 − 333 = 0, nothing to explain.
    { category: 'home_payments', label: 'Home/trailer payments', received: 333.33, charged: 333.33, owed: 0,
      parts: { collected: 333.33, clearing: 0, owed: 0, other: 0 } },
  ],
  uncategorized: [
    { line: 'lateFees', label: 'Late fees', received: 265, charged: 590, owed: 310,
      parts: { collected: 265, clearing: 0, owed: 310, other: 15 } },
  ],
  lines: [], tieText: [], beside: [],
  tie: { charged: { collected: 21445.71, clearing: 0, owed: 1265, other: 0 }, received: { forPeriodBills: 17832.16, forEarlierBills: 0, paidAhead: 961.82, noBill: 3022.19 } },
})

async function show(v: any) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<CategoryBreakdownCard title="Income" view={v} />) })
}
const whys = () => [...host!.querySelectorAll('tbody tr.rb-why td')].map(td => td.textContent!.replace(/\s+/g, ' ').trim())

describe('why a row does not add up (11/4, Nic)', () => {
  it('spells out the rent row he could not reconcile, to the cent', async () => {
    await show(view())
    const rent = whys().find(t => t.startsWith('of $18,502.00'))
    expect(rent).toBe(
      'of $18,502.00 charged: $16,958.00 collected · $955.00 of these charges still owed at the end of the period'
      + ' · $589.00 settled without money (a credit you gave, or work trade)')
  })

  it('says nothing on the row that already subtracts — his home and trailer payments', async () => {
    await show(view())
    expect(whys().some(t => t.includes('$333.33'))).toBe(false)
    // Only the two rows whose columns do not subtract carry an explanation.
    expect(whys()).toHaveLength(2)
  })

  it('explains an uncategorized line the same way', async () => {
    await show(view())
    expect(whys().some(t => t === 'of $590.00 charged: $265.00 collected · $310.00 of these charges still owed at the end of the period · $15.00 settled without money (a credit you gave, or work trade)')).toBe(true)
  })

  it('stays silent with no buckets — the money records, or a viewer who may not see Owed', async () => {
    const v = view()
    for (const c of v.categories) delete c.parts
    for (const l of v.uncategorized) delete l.parts
    await show(v)
    expect(whys()).toHaveLength(0)
  })
})

describe('a breakdown that does not add up says so (11/4)', () => {
  it('never prints a sum that does not sum — the proof strip\'s own rule', async () => {
    const v = view()
    // $100 unaccounted for: the four buckets no longer split this row's Charged.
    v.categories[0].parts = { collected: 16858, clearing: 0, owed: 955, other: 589 }
    await show(v)
    // fmt() prints a real minus sign (U+2212), not a hyphen.
    expect(whys()).toContain(
      'of $18,502.00 charged, what became of it adds to $18,402.00 \u2014 these do not add up,'
      + ' and they are off by \u2212$100.00.')
  })
})
