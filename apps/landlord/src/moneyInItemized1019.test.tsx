// @vitest-environment jsdom
/**
 * 10/19 (Nic): "i need the books breakdown for september mountain view. it
 * still looks the same for betty she doesnt see any new information... We need
 * to make the books actually display the right way. So that she can see it if
 * she needs to go back to it later."
 *
 * The Money in page, fed September at Mountain View exactly as the API now
 * sends it (measured off production, read-only): rent split into the lines the
 * books keep, the cadence kept beside it instead of in place of it, the four
 * propane sales readable without opening the POS, and the Square lump labelled
 * for the one entry it is rather than split by guesswork.
 *
 * The same file ships in GAM Books (financials parity), asserted at the end.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { BOOKS_OTHER_INCOME_NOT_ITEMIZABLE_NOTE, BOOKS_SOLD_COUNTER_NOT_METERED_NOTE } from '@gam/shared'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({ replies: {} as Record<string, any>, asked: [] as string[] }))

vi.mock('./financials/adapter', () => ({
  finGet: async (url: string) => {
    server.asked.push(url)
    const key = Object.keys(server.replies).find(k => url.startsWith(k))
    if (!key) throw new Error(`unexpected GET ${url}`)
    return server.replies[key]
  },
  finPost: async () => { throw new Error('no post expected') },
  finPatch: async () => { throw new Error('no patch expected') },
  finUpload: async () => { throw new Error('no upload expected') },
  openProtectedFile: async () => {},
  pinnedCompanyId: () => null,
  toast: Object.assign(() => {}, { error: () => {} }),
  toastError: () => {},
  appConfirm: async () => false,
  useIsBookkeeper: () => true,
  useViewer: () => ({ role: 'bookkeeper', isBookkeeper: true, can: () => true, openOwnerPage: null }),
}))

import { IncomePage } from './financials/IncomePage'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''

/** The text of one card, by the title it carries (null when the card is not on the page). */
function card(title: string): string | null {
  for (const el of Array.from(host!.querySelectorAll('.fin-card'))) {
    if (el.querySelector('.fin-card-title')?.textContent === title) return el.textContent || ''
  }
  return null
}

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><IncomePage /></QueryClientProvider>)
  })
  await flush()
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
  server.replies = {}; server.asked = []
})

const SCOPE = { viewer: 'bookkeeper', canRemoveExpenses: true, companyWide: true, companies: [], properties: [] }
const LUMP = 'Square card sales before the GAM card reader (propane, overnight stays)'

/**
 * September 2026 at Mountain View, measured off the books on 10/19 (read-only,
 * through this page's own API): $20,298.23 received, $19,071.17 charged, every
 * figure a posting line. The $1,227.06 difference is money paid ahead for later
 * bills — it counts in Received the day it arrived and is charged when its bill
 * comes due, which is the rule this page has always read.
 */
const SEPTEMBER = {
  period: { start: '2026-09-01', end: '2026-09-30' },
  itemized: true,
  total: 20298.23,
  charged: 19071.17,
  owed: 0,
  depositsHeld: 0,
  besideTotal: [{ key: 'taxCollected', label: 'Tax collected (owed to the government)', amount: 8.95 }],
  pools: [
    { key: 'rent_line:mobile_home_lot', label: 'Mobile home lot rent', amount: 6238, charged: 6238, owed: 0 },
    { key: 'rent_line:rv_spot', label: 'RV long-term rent', amount: 10732.43, charged: 10732.43, owed: 0 },
    { key: 'electric', label: 'Electric', amount: 1554.42, charged: 1554.42, owed: 0 },
    { key: 'register_sales', label: 'Register sales', amount: 124.08, charged: 124.08, owed: 0 },
    { key: 'stays_and_pay_links', label: 'Stays and pay links', amount: 13.2, charged: 13.2, owed: 0 },
    { key: 'other_income', label: 'Other income', amount: 409.04, charged: 409.04, owed: 0 },
    { key: 'paidAhead', label: 'Paid ahead for later bills', amount: 1227.06, charged: 0, owed: 0 },
  ],
  rentSoldAs: [{ key: 'monthly_rent', label: 'Monthly rent', amount: 16970.43, charged: 16970.43, owed: 0 }],
  register: {
    salesCount: 4,
    categories: [{
      category: 'Utilities', label: 'Utilities', sales: 137.28,
      items: [{ name: 'Propane', unit: null, qty: 41.6, sales: 137.28, salesCount: 4 }],
    }],
    tie: {
      itemLines: 137.28, discounts: 0, towardStays: 0, backgroundChecks: 0,
      cashSurcharge: 0, corrections: 0, posted: 137.28, difference: 0, returns: 0,
    },
  },
  otherMoneyIn: {
    rows: [{
      accountCode: '4900', accountName: 'Other income', category: 'Other income', label: 'Other income',
      description: LUMP, payer: 'Square', amount: 409.04, records: 4, lumpSum: true,
    }],
    total: 409.04,
    noTaxSplit: 409.04,
  },
  months: [{
    month: '2026-09', total: 20298.23, depositsHeld: 0, besideTotal: [],
    pools: [
      { key: 'rent_line:mobile_home_lot', amount: 6238 }, { key: 'rent_line:rv_spot', amount: 10732.43 },
      { key: 'electric', amount: 1554.42 }, { key: 'register_sales', amount: 124.08 },
      { key: 'stays_and_pay_links', amount: 13.2 }, { key: 'other_income', amount: 409.04 },
      { key: 'paidAhead', amount: 1227.06 },
    ],
    rentSoldAs: [{ key: 'monthly_rent', amount: 16970.43 }],
  }],
  days: [
    { day: '2026-09-03', total: 589, depositsHeld: 0, besideTotal: [],
      pools: [{ key: 'rent_line:rv_spot', amount: 589 }], rentSoldAs: [{ key: 'monthly_rent', amount: 589 }] },
    { day: '2026-09-24', total: 42.9, depositsHeld: 0, besideTotal: [],
      pools: [{ key: 'register_sales', amount: 42.9 }], rentSoldAs: [] },
  ],
}

/**
 * October 2026 at the same park, measured the same way on 10/19 — the month the
 * 10/19 review found two things wrong on this page:
 *
 *   - three RV sites sold BY THE MONTH ($1,767.00 taken in on 10/06, $1,178.00
 *     of it earned in the month) book to RV LONG-TERM RENT, because a month
 *     stay is long-term rent. That is rent sitting on the rent rows, and the
 *     cadence card — which says on screen it is "the same lot/space rent as
 *     above" — left it out, printing $21,980.00 under rent rows of $23,158.00.
 *   - the Register sales ACCOUNT holds $413.94 over these days: $250.77 rung up
 *     and $163.17 that paid toward a stay, which the table above splits into a
 *     Register sales row and a Stays and pay links row. The bold bottom line of
 *     the register strip was being read as a row of that table and matched none.
 */
const OCTOBER = {
  period: { start: '2026-10-01', end: '2026-10-31' },
  itemized: true,
  total: 20038.98,
  charged: 25385.98,
  owed: 4760.76,
  depositsHeld: 0,
  besideTotal: [{ key: 'taxCollected', label: 'Tax collected (owed to the government)', amount: 29.66 }],
  pools: [
    { key: 'rent_line:mobile_home_lot', label: 'Mobile home lot rent', amount: 5318, charged: 8998, owed: 2760 },
    { key: 'rent_line:rv_spot', label: 'RV long-term rent', amount: 12204.64, charged: 14160, owed: 1673 },
    { key: 'electric', label: 'Electric', amount: 1478.19, charged: 1866.69, owed: 137.76 },
    { key: 'late_fees', label: 'Late fees', amount: 265, charged: 470, owed: 190 },
    { key: 'register_sales', label: 'Register sales', amount: 250.77, charged: 250.77, owed: 0 },
    { key: 'stay_line:rv_spot', label: 'RV short-term stays (under 30 nights)', amount: 269, charged: 269, owed: 0 },
    { key: 'stays_and_pay_links', label: 'Stays and pay links — not itemized', amount: 163.17, charged: 163.17, owed: 0 },
    { key: 'other_income', label: 'Other income', amount: 48.39, charged: 48.39, owed: 0 },
    { key: 'paidAhead', label: 'Paid ahead for later bills', amount: 41.82, charged: 0, owed: 0 },
    { key: 'creditsGiven', label: 'Credits given', amount: 0, charged: -840.04, owed: 0 },
  ],
  rentSoldAs: [
    { key: 'monthly_rent', label: 'Monthly rent', amount: 15755.64, charged: 21980, owed: 4433 },
    { key: 'long_term_stay', label: 'Sold as a long-term stay', amount: 1767, charged: 1178, owed: 0 },
  ],
  register: {
    salesCount: 17,
    categories: [{
      category: 'Stays', label: 'Stays', sales: 2036,
      items: [{ name: 'RV site — monthly', unit: 'month', qty: 3, sales: 1767, salesCount: 3 }],
    }],
    tie: {
      itemLines: 2449.94, discounts: 0, towardStays: 2036, backgroundChecks: 0,
      cashSurcharge: 0, corrections: 0, posted: 413.94, difference: 0, returns: 0,
    },
  },
  otherMoneyIn: undefined,
  months: [{
    month: '2026-10', total: 20038.98, depositsHeld: 0, besideTotal: [],
    pools: [
      { key: 'rent_line:mobile_home_lot', amount: 5318 }, { key: 'rent_line:rv_spot', amount: 12204.64 },
      { key: 'electric', amount: 1478.19 }, { key: 'late_fees', amount: 265 },
      { key: 'register_sales', amount: 250.77 }, { key: 'stay_line:rv_spot', amount: 269 },
      { key: 'stays_and_pay_links', amount: 163.17 }, { key: 'other_income', amount: 48.39 },
      { key: 'paidAhead', amount: 41.82 },
    ],
    rentSoldAs: [{ key: 'monthly_rent', amount: 15755.64 }, { key: 'long_term_stay', amount: 1767 }],
  }],
  days: [{
    day: '2026-10-06', total: 4224.7, depositsHeld: 0, besideTotal: [],
    pools: [
      { key: 'rent_line:rv_spot', amount: 3859 }, { key: 'electric', amount: 90.09 },
      { key: 'late_fees', amount: 90 }, { key: 'register_sales', amount: 22.44 },
      { key: 'stays_and_pay_links', amount: 163.17 },
    ],
    rentSoldAs: [{ key: 'monthly_rent', amount: 2092 }, { key: 'long_term_stay', amount: 1767 }],
  }],
}

const serve = (income: any) => {
  server.replies['/financials/scope'] = SCOPE
  server.replies['/financials/income'] = income
}

describe('Money in shows the breakdown the books already have (10/19)', () => {
  it('rent reads as the lines the books keep, not as one lump', async () => {
    serve(SEPTEMBER)
    await render()
    const byType = card('By type') ?? ''
    expect(byType).toContain('RV long-term rent')
    expect(byType).toContain('$10,732.43')
    expect(byType).toContain('Mobile home lot rent')
    expect(byType).toContain('$6,238.00')
    // The cadence is NOT what the rent rows say any more.
    expect(byType).not.toContain('Monthly rent')
    expect(byType).toContain('$20,298.23')
    // 10/19: the privilege tax that came in with the sales — beside the total,
    // never inside it, where deposits received already sit.
    expect(byType).toContain('Beside the totals, not in them')
    expect(byType).toContain('Tax collected (owed to the government)')
    expect(byType).toContain('$8.95')
  })

  it('the cadence is kept beside it, so nothing the page used to show is gone', async () => {
    serve(SEPTEMBER)
    await render()
    const soldAs = card('Rent by how it was sold')
    expect(soldAs).toContain('Monthly rent')
    expect(soldAs).toContain('$16,970.43')
    // Said plainly, so it is never read as more rent on top of the rows above.
    expect(soldAs).toContain('The same lot/space rent as above')
  })

  it('register sales itemize per item, and say how the items add up to the account', async () => {
    serve(SEPTEMBER)
    await render()
    const sold = card('What was sold at the register') ?? ''
    expect(sold).toContain('Propane')
    expect(sold).toContain('41.6')
    expect(sold).toContain('$137.28')
    // 10/19 (review): the strip's bottom line is the ACCOUNT, and says so. The
    // table above splits that account ($124.08 rung up, $13.20 toward a stay),
    // so a line calling itself "Register sales in the books" sent the reader
    // hunting the page for $137.28 on a row that was never going to be there.
    expect(sold).toContain('The Register sales account over these days')
    expect(sold).not.toContain('Register sales in the books')
    // Counter goods are not the metered utilities above, whatever the register calls them.
    expect(sold).toContain('Utilities')
    expect(sold).toContain(BOOKS_SOLD_COUNTER_NOT_METERED_NOTE)
  })

  it('the lump keeps its own words and is never split', async () => {
    serve(SEPTEMBER)
    await render()
    const other = card('Money filed as other money in') ?? ''
    expect(other).toContain(LUMP)
    expect(other).toContain('Square')
    expect(other).toContain('$409.04')
    expect(other).toContain(BOOKS_OTHER_INCOME_NOT_ITEMIZABLE_NOTE)
    // Nothing anywhere splits it into propane and stays.
    expect(text()).not.toContain('$204.52')
  })

  it('rent that came in as a long-term stay is on the cadence card, so it adds up to the rent rows', async () => {
    serve(OCTOBER)
    await render()
    const soldAs = card('Rent by how it was sold') ?? ''
    expect(soldAs).toContain('Monthly rent')
    expect(soldAs).toContain('$21,980.00')
    // The money the card used to drop: three RV sites sold by the month.
    expect(soldAs).toContain('Sold as a long-term stay')
    expect(soldAs).toContain('$1,178.00')
    // And the bottom line is the rent rows above to the cent: $8,998.00 lot rent
    // + $14,160.00 RV long-term rent charged.
    expect(soldAs).toContain('$23,158.00')
    expect(soldAs).toContain('The same lot/space rent as above')
  })

  it('the cadence answers one month and one day at a time, not only the whole period', async () => {
    serve(OCTOBER)
    await render()
    const soldAs = card('Rent by how it was sold') ?? ''
    expect(soldAs).toContain('Rent received by month')
    expect(soldAs).toContain('Rent received by day')
    // October: $15,755.64 on a lease, $1,767.00 sold as a long-term stay.
    expect(soldAs).toContain('$15,755.64')
    expect(soldAs).toContain('$1,767.00')
    // And the day it arrived: $2,092.00 of lease rent beside it, $3,859.00 of
    // rent that day — the RV long-term rent row of the day table above.
    expect(soldAs).toContain('$2,092.00')
    expect(soldAs).toContain('$3,859.00')
  })

  it('a company whose books are not live reads exactly as it did: cadence rows, no new cards', async () => {
    serve({
      ...SEPTEMBER,
      itemized: false,
      pools: [{ key: 'monthly_rent', label: 'Monthly rent', amount: 16970.43, charged: 16970.43, owed: 0 }],
      rentSoldAs: [], register: undefined, otherMoneyIn: undefined,
      total: 16970.43, charged: 16970.43, besideTotal: [],
      months: [], days: [],
    })
    await render()
    expect(card('By type')).toContain('Monthly rent')
    expect(card('Rent by how it was sold')).toBeNull()
    expect(card('What was sold at the register')).toBeNull()
    expect(card('Money filed as other money in')).toBeNull()
  })

  it('the shared Money in page is byte-identical in the landlord portal and GAM Books', () => {
    const root = join(__dirname, '../../..')
    const of = (app: string) => readFileSync(join(root, 'apps', app, 'src/financials/IncomePage.tsx'), 'utf8')
    expect(of('books'), 'copy the change to both apps').toBe(of('landlord'))
  })
})
