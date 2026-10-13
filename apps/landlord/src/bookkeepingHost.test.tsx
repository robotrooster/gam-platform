// @vitest-environment jsdom
/**
 * 10/12 (Nic): "Bookkeeping" in the landlord menu shows the GAM Books pages
 * inside the portal. The Books API reads ONE company's books at a time and
 * never picks one for an account that owns several (S654), so the host names
 * the company on every request (X-Client-Id):
 *   - an owner with one company opens it, unasked;
 *   - an owner with several is asked first — no page asks the server anything
 *     before — and can switch; the choice is remembered for that person only,
 *     and a remembered company that is no longer theirs is dropped, not sent;
 *   - a bookkeeper reads the company the portal signed them in to.
 * And the shared pages link to each other at the portal's own addresses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  user: null as any,
  companies: [] as Array<{ landlordId: string; businessName: string | null; propertyNames: string | null }>,
  gets: [] as Array<{ url: string; company: string | null }>,
}))

vi.mock('./lib/api', () => ({
  api: {
    get: async (url: string, config?: any) => {
      server.gets.push({ url, company: config?.headers?.['X-Client-Id'] ?? null })
      if (url === '/books/companies') return { data: { success: true, data: server.companies } }
      if (url.startsWith('/books/')) return { data: { success: true, data: [] } }
      throw new Error(`unexpected GET ${url}`)
    },
    post: async () => { throw new Error('unexpected POST') },
    patch: async () => { throw new Error('unexpected PATCH') },
  },
}))
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: server.user }) }))
vi.mock('./components/dialogs', () => ({ toast: Object.assign(() => {}, { error: () => {} }), appConfirm: async () => false }))

import { BookkeepingHost } from './bookkeepingHost'
import { BooksDashboardPage } from './bookkeeping/BooksDashboardPage'
import { BOOKS_PATHS } from './bookkeeping/adapter'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const KEY = 'gam_landlord_books_company'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function open() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[BOOKS_PATHS.dashboard]}>
          <Routes>
            <Route element={<BookkeepingHost />}>
              <Route path={BOOKS_PATHS.dashboard} element={<BooksDashboardPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await flush()
  return host!
}
const pageGets = () => server.gets.filter(g => g.url !== '/books/companies')
const text = () => host!.textContent || ''

beforeEach(() => {
  server.user = null
  server.companies = []
  server.gets = []
  localStorage.clear()
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

describe('Bookkeeping in the landlord portal: whose books', () => {
  it('an owner with one company opens it, unasked, and every request names it', async () => {
    server.user = { id: 'u1', role: 'landlord' }
    server.companies = [{ landlordId: A, businessName: 'Oak Park LLC', propertyNames: 'Oak Park' }]
    await open()
    expect(text()).toContain('Books Dashboard')
    expect(text()).not.toContain("Which company's books?")
    expect(pageGets().length).toBeGreaterThan(0)
    expect(pageGets().every(g => g.company === A)).toBe(true)
    expect(host!.querySelector('#bk-company')).toBeNull()   // nothing to switch between
  })

  it('an owner with several is asked first — no page asks anything — then reads the one chosen, and can switch', async () => {
    server.user = { id: 'u1', role: 'landlord' }
    server.companies = [
      { landlordId: A, businessName: 'Oak Park LLC', propertyNames: 'Oak Park' },
      { landlordId: B, businessName: 'Mountain View LLC', propertyNames: 'Mountain View RV' },
    ]
    await open()
    expect(text()).toContain("Which company's books?")
    expect(pageGets()).toEqual([])
    const pick = [...host!.querySelectorAll('button')].find(b => b.textContent?.includes('Mountain View LLC'))!
    await act(async () => { pick.click() })
    await flush()
    expect(text()).toContain('Books Dashboard')
    expect(pageGets().length).toBeGreaterThan(0)
    expect(pageGets().every(g => g.company === B)).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ userId: 'u1', companyId: B })

    // Switching: the newly opened company's books are read afresh.
    server.gets = []
    const select = host!.querySelector('#bk-company') as HTMLSelectElement
    expect(select.value).toBe(B)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, A)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(pageGets().length).toBeGreaterThan(0)
    expect(pageGets().every(g => g.company === A)).toBe(true)
  })

  it('a remembered company is reopened for the same person only', async () => {
    server.companies = [
      { landlordId: A, businessName: 'Oak Park LLC', propertyNames: null },
      { landlordId: B, businessName: 'Mountain View LLC', propertyNames: null },
    ]
    localStorage.setItem(KEY, JSON.stringify({ userId: 'u1', companyId: B }))
    server.user = { id: 'u1', role: 'landlord' }
    await open()
    expect(text()).not.toContain("Which company's books?")
    expect(pageGets().every(g => g.company === B)).toBe(true)
    act(() => root?.unmount()); host?.remove(); root = null

    // Someone else on this computer is asked, never handed the first person's choice.
    server.gets = []
    server.user = { id: 'u2', role: 'landlord' }
    await open()
    expect(text()).toContain("Which company's books?")
    expect(pageGets()).toEqual([])
  })

  it('a remembered company that is no longer theirs is dropped, never sent', async () => {
    localStorage.setItem(KEY, JSON.stringify({ userId: 'u1', companyId: B }))
    server.user = { id: 'u1', role: 'landlord' }
    server.companies = [
      { landlordId: A, businessName: 'Oak Park LLC', propertyNames: null },
      { landlordId: '33333333-3333-4333-8333-333333333333', businessName: 'Desert Sun LLC', propertyNames: null },
    ]
    await open()
    expect(text()).toContain("Which company's books?")
    expect(server.gets.some(g => g.company === B)).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('a bookkeeper reads the company the portal signed them in to, with no company list', async () => {
    server.user = { id: 'bk', role: 'bookkeeper', landlordId: A }
    await open()
    expect(server.gets.some(g => g.url === '/books/companies')).toBe(false)
    expect(text()).toContain('Books Dashboard')
    expect(pageGets().every(g => g.company === A)).toBe(true)
  })

  it('anyone else (an admin, a staff member) gets a notice, and no Books page asks anything (10/12 review)', async () => {
    for (const user of [
      { id: 'adm', role: 'admin', landlordId: null },
      { id: 'pm', role: 'property_manager', landlordId: A },
      { id: 'desk', role: 'onsite_manager', landlordId: A },
    ]) {
      server.gets = []
      server.user = user
      await open()
      expect(text()).toContain("Bookkeeping is for the company's owner and its bookkeeper.")
      expect(text()).not.toContain('Books Dashboard')
      expect(server.gets).toEqual([])
      act(() => root?.unmount()); host?.remove(); root = null; host = null
    }
  })

  it("the dashboard's links go to the portal's own Bookkeeping pages", async () => {
    server.user = { id: 'u1', role: 'landlord' }
    server.companies = [{ landlordId: A, businessName: 'Oak Park LLC', propertyNames: null }]
    await open()
    const hrefs = [...host!.querySelectorAll('a')].map(a => a.getAttribute('href'))
    // 10/12 (Nic): contractors are vendors (one list); loans and fixed assets joined.
    expect(hrefs).toEqual([BOOKS_PATHS.employees, BOOKS_PATHS.vendors, BOOKS_PATHS.loans, BOOKS_PATHS.fixedAssets, BOOKS_PATHS.accounts])
    expect(host!.querySelector('.bk-host')).not.toBeNull()
  })
})
