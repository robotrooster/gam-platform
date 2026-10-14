/**
 * 10/13 (Nic) — "Tenants list + tenant profile: split health BY LEASE."
 *
 * The Tenants list is one row per occupied space. Each row's Payment health is
 * the health of the LEASE on that space (GET /tenants/health-by-unit — the
 * Rent Roll's figure for that household), so a person renting two spots on two
 * leases reads each lease's own number on each row, never one number for both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  units: [] as any[],
  /** GET /tenants/health-by-unit: the rows, null (GAM admin), or a refusal. */
  byUnit: [] as any[] | null,
  byUnitFails: false,
  /** When set, GET /tenants/health-by-unit waits on it. */
  hold: null as Promise<void> | null,
  gets: [] as string[],
}))
vi.mock('../lib/api', () => ({
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/units') return JSON.parse(JSON.stringify(server.units))
    if (url === '/tenants/health-by-unit') {
      if (server.hold) await server.hold
      if (server.byUnitFails) throw Object.assign(new Error('nope'), { response: { status: 500, data: { error: 'nope' } } })
      return JSON.parse(JSON.stringify(server.byUnit))
    }
    if (url === '/landlords/me/undelivered-email') return []
    throw new Error(`unexpected GET ${url}`)
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'landlord', permissions: {} } }) }))
vi.mock('./InviteTenantModal', () => ({ InviteTenantModal: () => null }))

import { TenantsPage, HEALTH_NOT_LOADED } from './TenantsPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** A row of GET /units as the portal reads it (camelized). */
const unit = (id: string, unitNumber: string, first: string, paymentHealth: number | null) => ({
  id, unitNumber, propertyId: 'p-mv', propertyName: 'Mountain View', tenantId: `t-${first}`, tenantFirst: first, tenantLast: 'Twice',
  tenantEmail: `${first.toLowerCase()}@example.test`, paymentHealth, rentAmount: 495, leaseRentAmount: 495, achVerified: true, workTradeRent: false,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  // Hal rents two spaces on two leases: RV 30 paid on time, RV 31 late. The
  // household figure (/units, 50%) is the one the list must no longer show.
  server.units = [unit('u30', 'RV 30', 'Hal', 50), unit('u31', 'RV 31', 'Hal', 50), unit('u40', 'RV 40', 'Sol', 100)]
  server.byUnit = [
    { unitId: 'u30', leaseId: 'L30', percent: 100, label: '100%, 1 of 1 month' },
    { unitId: 'u31', leaseId: 'L31', percent: 0, label: '0%, 0 of 1 month' },
    { unitId: 'u40', leaseId: 'L40', percent: null, label: 'Onboarding month — not counted' },
  ]
  server.byUnitFails = false
  server.hold = null
  server.gets = []
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
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/tenants']}><TenantsPage /></MemoryRouter>
      </QueryClientProvider>)
  })
  await until(() => text().includes('RV 40'), 'the list')
}
/** Unit → its Payment health cell. */
const healthCells = () => Object.fromEntries([...host.querySelectorAll('tbody tr')].map(tr => {
  const td = [...tr.querySelectorAll('td')]
  return [td[1].textContent, td[3].textContent]
}))

describe('the Tenants list: payment health by lease', () => {
  it('each space shows the health of its own lease — two leases, two numbers', async () => {
    await render()
    await until(() => healthCells()['RV 30'] === '100%', 'the lease figures')
    // 10/13 (Nic), the onboarding month paid late: "Keep it out, but say so" — words, never a bare dash.
    expect(healthCells()).toEqual({ 'RV 30': '100%', 'RV 31': '0%', 'RV 40': 'Onboarding month — not counted' })
    const cell = [...host.querySelectorAll('tbody tr')][1].querySelectorAll('td')[3]
    expect(cell.getAttribute('title')).toBe('0%, 0 of 1 month')
  })

  it('until the lease figures arrive, a dash — never the household\'s number in between', async () => {
    let release!: () => void
    server.hold = new Promise(r => { release = r })
    await render()
    expect(healthCells()).toEqual({ 'RV 30': '—', 'RV 31': '—', 'RV 40': '—' })
    await act(async () => { release() })
    await until(() => healthCells()['RV 31'] === '0%', 'the lease figures')
  })

  it('nothing counted yet on a lease says the server\'s words; with no words to give (GAM admin), "Nothing counted yet"', async () => {
    server.byUnit = [
      { unitId: 'u30', leaseId: 'L30', percent: null, label: 'No months to judge yet' },
      { unitId: 'u31', leaseId: 'L31', percent: 0, label: '0%, 0 of 1 month' },
      { unitId: 'u40', leaseId: 'L40', percent: null, label: 'Onboarding month — not counted' },
    ]
    await render()
    await until(() => healthCells()['RV 31'] === '0%', 'the lease figures')
    expect(healthCells()).toEqual({ 'RV 30': 'No months to judge yet', 'RV 31': '0%', 'RV 40': 'Onboarding month — not counted' })
    act(() => root.unmount())
    root = createRoot(host)
    server.byUnit = null
    server.units = [unit('u30', 'RV 30', 'Hal', null), unit('u40', 'RV 40', 'Sol', 100)]
    await render()
    await until(() => healthCells()['RV 40'] === '100%', 'the list column')
    expect(healthCells()).toEqual({ 'RV 30': 'Nothing counted yet', 'RV 40': '100%' })
  })

  it('GAM admin (no lease figures sent) reads the list\'s own column', async () => {
    server.byUnit = null
    await render()
    await until(() => healthCells()['RV 30'] === '50%', 'the list column')
    expect(healthCells()).toEqual({ 'RV 30': '50%', 'RV 31': '50%', 'RV 40': '100%' })
  })

  // 10/13 review: falling back to the household figure on a failed read put
  // the same number on both of Hal's leases — the split undone, silently.
  it('a failed read shows a dash and says why on hover — never the household\'s number on both leases', async () => {
    server.byUnitFails = true
    await render()
    const firstCell = () => [...host.querySelectorAll('tbody tr')][0]?.querySelectorAll('td')[3]
    await until(() => firstCell()?.getAttribute('title') === HEALTH_NOT_LOADED, 'the failed read')
    expect(healthCells()).toEqual({ 'RV 30': '—', 'RV 31': '—', 'RV 40': '—' })
    expect(text()).not.toContain('50%')
  })
})
