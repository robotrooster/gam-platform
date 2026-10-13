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
      return { monthlyRentVolume: 12345, activeUnits: 30, payableRentUnits: 30, unitsOwing: 2, unitsPastGrace: 1, outstanding: 980, trend: [] }
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
