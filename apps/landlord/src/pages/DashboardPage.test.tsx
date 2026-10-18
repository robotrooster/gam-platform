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

vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    if (url === '/properties') return []
    if (url.startsWith('/landlords/me/dashboard')) {
      // 10/17: rentHealth is Mountain View's October as measured — $18,502
      // invoiced once the bills on hold for work trade are out, $17,087 paid,
      // $1,415 left. `outstanding` is deliberately a DIFFERENT number: that
      // card counts every open charge of every month.
      return { monthlyRentVolume: 12345, activeUnits: 30, payableRentUnits: 30, unitsOwing: 2, unitsPastGrace: 1, outstanding: 980,
               rentHealth: { invoiced: 18502, paid: 17087, owed: 1415, workTradeHeld: 3478 }, trend: [] }
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

/**
 * 10/17 (Nic): "the property health matches what was invoiced and what was
 * paid. work trade isnt billed until a shortfall so it shouldnt apply here
 * unless an invoice generates."
 *
 * The note under the percentage says WHICH money it counts, because the
 * Outstanding card sits beside it counting every open charge of every month —
 * two numbers on one screen that must not read as one claim. Work trade is
 * named without a figure: S650 keeps work-trade balances off these cards.
 */
describe('the payment-health note says which money it is counting', () => {
  it('names this month\'s rent and what is left to collect, and prints no work-trade balance', async () => {
    await render()
    const note = host.querySelector('.phm-health-note')?.textContent ?? ''
    expect(note).toContain('$17,087.00 of $18,502.00 in this month\'s rent bills paid')
    expect(note).toContain('$1,415.00 of it left to collect')
    expect(note).toContain('Rent covered by work trade is not counted here')
    expect(note).not.toContain('3,478')
    // The Outstanding card beside it keeps its own figure, and it is not this one.
    expect(card('Outstanding').textContent).toContain('$980')
    expect(card('Outstanding').textContent).not.toContain('1,415')
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
