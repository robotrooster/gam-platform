/**
 * 10/13 (Nic): "Dashboard 'Expected Monthly Rent' card opens PAYMENTS." And
 * "REMOVE the Outstanding Balances tab" — the cards that opened it (the
 * outstanding banner and the Outstanding card) open Payments, where who owes
 * is now (owing rows at the top, "Delinquent" beside the name).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

/**
 * 10/18: PRODUCTION'S OWN FIGURES, measured read-only on the morning Nic
 * reported this — the account's two properties blended, and Mountain View
 * alone. Every number below is what /landlords/me/dashboard answered:
 *
 *                       blended        Mountain View
 *   rent invoiced       $28,922.00     $18,502.00
 *   rent paid           $24,207.00     $17,087.00
 *   still owed           $4,715.00      $1,415.00   (92%)
 *   money table total   $27,859.16     $19,483.98   Received
 *                       $39,633.52     $26,211.02   Charged
 *                       $19,866.18      $9,683.87   Owed
 *   Outstanding card    $10,619.43      $1,685.00
 *
 * The money table's three columns are the ones Nic subtracted and could not
 * make come out: "$26,211.02 minus the received calculation of 19,483.98 in no
 * way close equals 9,683.87." They never will — the card says so now.
 *
 * THE OUTSTANDING CARD IS THE 10/18 FIGURE, NOT THE ONE NIC WAS LOOKING AT.
 * He read $9,769.43 blended and $1,415.00 at Mountain View; those came off the
 * old rule, which summed invoice totals and so dropped every accrued late fee
 * (routes/landlords → lib/rentCollected outstandingBalanceOf). Re-measured
 * read-only after the fix, the endpoint answers $10,619.43 and $1,685.00 —
 * Mountain View $1,415.00 + $270 of open late fees, Oak Park $8,354.43 +
 * $580. Mountain View's "still owed" line above stays $1,415.00: that is this
 * month's RENT left to collect (rentHealth), a different question, and it no
 * longer coincides with the Outstanding card the way it did before the fix.
 */
const MV = 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01'
const OAK = 'f63a3b3c-f673-480d-bc90-6d9bd3b0b818'

const cat = (category: string, received: number, charged: number, owed: number) =>
  ({ category, received, charged, owed, billed: charged, collected: received, clearing: 0, stillOwed: owed, amount: received })

const DASH: Record<string, any> = {
  '': {
    monthlyRentVolume: 12345, activeUnits: 30, payableRentUnits: 30, unitsOwing: 2, unitsPastGrace: 1,
    outstanding: 10619.43,
    rentHealth: { invoiced: 28922, paid: 24207, owed: 4715, workTradeHeld: 3918 },
    propertyHealth: {
      period: '2026-10', source: 'ledger', total: 27859.16,
      // Every category the reply carries, because the Total row's Charged and
      // Owed are the ROWS added up (the Received total is the reply's own
      // figure) — a fixture that drops a row would make the table not add up
      // and prove nothing.
      categories: [
        cat('space_rent', 22390.72, 32840, 16129),
        cat('electric', 2138.43, 2933.7, 1408.26),
        cat('water', 113.95, 185.49, 1103.92),
        cat('trash', 225, 450, 375),
        cat('late_fees', 450, 1315, 850),
        cat('register_sales', 250.77, 250.77, 0),
        cat('stays_and_pay_links', 2199.17, 1610.17, 0),
        cat('other_income', 48.39, 48.39, 0),
      ],
      lines: [{ line: 'paidAhead', label: 'Paid ahead for later bills', amount: 42.73 }],
    },
    trend: [],
  },
  [MV]: {
    monthlyRentVolume: 8900, activeUnits: 25, payableRentUnits: 25, unitsOwing: 2, unitsPastGrace: 1,
    outstanding: 1685,
    rentHealth: { invoiced: 18502, paid: 17087, owed: 1415, workTradeHeld: 3478 },
    propertyHealth: {
      period: '2026-10', source: 'ledger', total: 19483.98,
      categories: [
        cat('space_rent', 15295.64, 21980, 9089),
        cat('electric', 1478.19, 1866.69, 324.87),
        cat('late_fees', 170, 455, 270),
        cat('register_sales', 250.77, 250.77, 0),
        cat('stays_and_pay_links', 2199.17, 1610.17, 0),
        cat('other_income', 48.39, 48.39, 0),
      ],
      lines: [{ line: 'paidAhead', label: 'Paid ahead for later bills', amount: 41.82 }],
    },
    trend: [],
  },
}

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/properties') {
      return [{ id: MV, name: 'Mountain View RV Ranch' }, { id: OAK, name: 'Oak Park Motel and RV' }]
    }
    if (url.startsWith('/landlords/me/dashboard')) {
      const chosen = new URL(url, 'http://x').searchParams.get('propertyId') ?? ''
      return DASH[chosen] ?? DASH['']
    }
    if (url === '/disbursements') return []
    if (url === '/landlords/me/todos') return { items: [] }
    if (url.startsWith('/landlords/me/pm-impact')) return { rows: [] }
    return null
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'landlord', permissions: {} } }) }))

import { DashboardPage } from './DashboardPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
  throw new Error(`timed out waiting for ${what}\n${text()}`)
}
function Where() {
  const loc = useLocation()
  return <div className="where">AT {loc.pathname}</div>
}
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('Expected Monthly Rent'), 'the dashboard')
}
const card = (label: string) => [...host.querySelectorAll('.kpi-card')]
  .find(c => c.querySelector('.kpi-label')?.textContent === label) as HTMLElement
const goes = async (el: HTMLElement) => {
  await act(async () => { el.click() })
  await until(() => !!host.querySelector('.where'), 'the page it opens')
  return host.querySelector('.where')!.textContent
}

/** The money figures in the health block, in the order the card prints them. */
const healthFigures = () => [...host.querySelectorAll('.phm-health-figs > div')]
  .map(d => ({
    label: d.querySelector('.phm-health-fig-label')?.textContent ?? '',
    amount: d.querySelector('.phm-health-fig-value')?.textContent ?? '',
  }))
const healthText = () => host.querySelector('.phm-health')?.textContent ?? ''
const moneyTable = () => host.querySelector('.phm-cats') as HTMLElement
/** The money table's Total row, as [Received, Charged, Owed]. */
const moneyTotals = () => [...(moneyTable().querySelector('.phm-cat-row.total')?.querySelectorAll('span') ?? [])]
  .slice(1).map(x => x.textContent ?? '')
/** Narrow the whole dashboard to one property, the way the picker does. */
async function filterTo(propertyId: string) {
  const sel = host.querySelector('select.form-input') as HTMLSelectElement
  if (!sel) throw new Error(`no property picker\n${text()}`)
  await act(async () => {
    sel.value = propertyId
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await until(() => !!host.querySelector('.phm-health-figs'), 'the health block to settle')
}
/** The dashboard narrowed to Mountain View — the view Nic was reading. */
async function renderMountainView() {
  await render()
  await filterTo(MV)
  await until(() => healthFigures()[0]?.amount === '$18,502.00', "Mountain View's figures")
}

/**
 * 10/18 (Nic): "$26,211.02 minus the received calculation of 19,483.98 in no
 * way close equals 9,683.87. You're pulling numbers from different spots here.
 * So that is a huge problem for a landlord to see incorrect numbers."
 *
 * The block makes ONE claim, and it is a subtraction: this month's rent
 * invoiced, less what was paid, is what is still owed — and the percentage
 * divides the first two. All four off one reply figure (rentHealth), printed as
 * the subtraction rather than left for the reader to attempt against a table
 * that answers something else entirely.
 */
describe('the health block\'s three figures tie to each other and to the percentage', () => {
  it('invoiced less paid is still owed, and paid over invoiced is the percentage', async () => {
    await renderMountainView()
    expect(healthFigures()).toEqual([
      { label: 'Rent invoiced this month', amount: '$18,502.00' },
      { label: 'Rent paid', amount: '$17,087.00' },
      { label: 'Still owed', amount: '$1,415.00' },
    ])
    // The subtraction and the percentage, printed, so neither has to be trusted.
    expect(healthText()).toContain('$18,502.00 invoiced − $17,087.00 paid = $1,415.00 still owed')
    expect(healthText()).toContain("92% of this month's rent bills paid")
    // And the meter above reads the same percentage off the same two figures.
    expect(host.querySelector('.phm-readout-value')?.textContent).toBe('92%')
  })

  it('says it counts this month\'s rent only, and names work trade without a figure', async () => {
    await renderMountainView()
    expect(healthText()).toContain("This counts this month's rent bills only")
    expect(healthText()).toContain('The Outstanding card above counts every open charge of every month')
    expect(healthText()).toContain('Rent covered by work trade is not counted here')
    // S650: no work-trade balance on this card, only the fact that it is out.
    expect(healthText()).not.toContain('3,478')
  })

  /**
   * The three figures beside it are the ones Nic subtracted. They are right and
   * they are a different question, so the card has to say which — the window in
   * the heading, each column's own plain words, and one line saying outright
   * that they do not subtract.
   */
  it('the money table beside it says what it answers, and that it is not a subtraction', async () => {
    await renderMountainView()
    expect(moneyTotals()).toEqual(['$19,483.98', '$26,211.02', '$9,683.87'])
    const t = moneyTable().textContent ?? ''
    expect(t).toContain('All money in October — every kind, not just rent')
    expect(t).toContain('Different questions, so these three do not subtract to each other')
    // On the books, Owed is the balance at the end of the period — which is the
    // whole reason $9,683.87 is not $26,211.02 less $19,483.98.
    expect(t).toContain('What tenants still owed at the end of the period, every bill included')
    expect(t).toContain('Bills in the month they were due, paid or not, less credits you gave')
    expect(t).toContain('Money on the day it arrived')
    // And the trace above says what its beats are: 19,483 against 20,298 is
    // money that arrived, not rent health.
    expect(host.querySelector('.phm-trace-note')?.textContent)
      .toBe('Each beat is all the money received that month, every kind.')
  })

  /**
   * 10/18 (Nic): "it's still showing that 9,683 is owed when I filter to
   * Mountain View". He could not tell whether the table under the meter moved
   * with the picker, because a receivables balance barely moves month to month.
   * It does move — every figure in the block does — and this holds it there.
   */
  /**
   * The two KPI cards above the block whose figures Nic put beside its own —
   * each says which money and which months it counts, so none of the three
   * reads as another's total.
   */
  it('the cards above it name their own window', async () => {
    await renderMountainView()
    expect(card('This month — every kind of money')).toBeTruthy()
    const thisMonth = card('This month — every kind of money').textContent ?? ''
    // The Charged tie is printed on the card, as it always was.
    expect(thisMonth).toContain('charged')
    // 10/18: it said "unpaid invoice balances" and that is what was wrong with
    // it — invoice totals never carry a late fee. It counts open charges now.
    expect(card('Outstanding').textContent).toContain('every open charge, every month')
  })

  it('the property filter changes every figure in the block', async () => {
    await render()
    // Blended: both properties.
    expect(healthFigures().map(f => f.amount)).toEqual(['$28,922.00', '$24,207.00', '$4,715.00'])
    expect(host.querySelector('.phm-readout-value')?.textContent).toBe('84%')
    expect(moneyTotals()).toEqual(['$27,859.16', '$39,633.52', '$19,866.18'])
    expect(card('Outstanding').textContent).toContain('$10,619')

    await filterTo(MV)

    expect(healthFigures().map(f => f.amount)).toEqual(['$18,502.00', '$17,087.00', '$1,415.00'])
    expect(host.querySelector('.phm-readout-value')?.textContent).toBe('92%')
    expect(moneyTotals()).toEqual(['$19,483.98', '$26,211.02', '$9,683.87'])
    expect(card('Outstanding').textContent).toContain('$1,685')
    // The categories under the total moved with it too.
    expect(moneyTable().textContent).toContain('$21,980.00')
    expect(moneyTable().textContent).not.toContain('$32,840.00')
  })
})

describe('the dashboard\'s rent and who-owes cards open Payments', () => {
  it('Expected Monthly Rent opens Payments (this month\'s rent roll)', async () => {
    await render()
    expect(await goes(card('Expected Monthly Rent'))).toBe('AT /payments')
  })
  it('the Outstanding card opens Payments — the Outstanding Balances tab is gone', async () => {
    await render()
    expect(await goes(card('Outstanding'))).toBe('AT /payments')
  })
  it('the outstanding-balance banner opens Payments', async () => {
    await render()
    const banner = [...host.querySelectorAll('.alert.alert-warn')].find(a => a.textContent?.includes('with an outstanding balance')) as HTMLElement
    expect(await goes(banner)).toBe('AT /payments')
  })
})
