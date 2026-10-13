// @vitest-environment jsdom
/**
 * 10/12 (Nic): "Remove the old form."
 *
 * The Disbursement Account page and the onboarding "Get Paid" step carried a
 * manual Add Bank Account form (GAM's own pre-Stripe bank catalog), and the
 * property form let a landlord route a property's rent to one of those rows.
 * Payouts run only through Stripe Connect, so none of it ever set up a payout
 * or reached Stripe. Country Acres' owner typed his bank in on 10/5 and waited
 * for microdeposits that could never come.
 *
 * These pin the landlord side: the pages render the Stripe setup and its
 * status, never the form, never the routing pick, and never even ask the API
 * for the old list — so a legacy row cannot reappear as something to pick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

const server = vi.hoisted(() => ({
  gets: [] as string[],
  posts: [] as string[],
  user: { id: 'u1', role: 'landlord', profileId: 'L1', permissions: {} } as any,
  entities: [{ id: 'L1', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 }] as any[],
  status: { connectAccountId: null, exists: false } as any,
  // 10/12: per-company Stripe status, keyed by entityId (falls back to `status`).
  statusByEntity: null as Record<string, any> | null,
  feed: [] as any[],
}))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/landlords/me/entities') return server.entities
    if (url.startsWith('/stripe/connect/status')) {
      const id = new URLSearchParams(url.split('?')[1] ?? '').get('entityId') ?? ''
      return server.statusByEntity?.[id] ?? server.status
    }
    if (url === '/bank-feed/connections') return server.feed
    // If anything still asks for the legacy catalog, hand it a live row so the
    // page WOULD show it — the assertions below catch the request itself.
    if (url === '/bank-accounts') {
      return [{ id: 'ba1', nickname: 'TBM First Mid', accountType: 'checking',
                accountHolderType: 'business', accountHolderName: 'TruBlu',
                accountNumberLast4: '8944', status: 'active' }]
    }
    return []
  },
  apiPost: async (url: string) => { server.posts.push(url); return { success: true, data: {} } },
  apiPatch: async () => ({}),
  apiPut: async () => ({}),
  apiDel: async () => ({}),
  apiDelete: async () => ({}),
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: server.user }) }))
vi.mock('../components/dialogs', () => {
  const toast = () => {}
  ;(toast as any).error = () => {}
  return { toast, appConfirm: async () => true }
})
vi.mock('../components/layout/Layout', () => ({ SUBLEASING_SHELVED: true }))
vi.mock('@stripe/connect-js', () => ({ loadConnectAndInitialize: vi.fn() }))
vi.mock('@stripe/react-connect-js', () => ({
  ConnectAccountOnboarding: () => null,
  ConnectComponentsProvider: ({ children }: any) => children,
}))

import { BankingPage } from './BankingPage'
import { OnboardingPage } from './OnboardingPage'
import { PropertiesPage } from './PropertiesPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  server.gets = []
  server.posts = []
  server.user = { id: 'u1', role: 'landlord', profileId: 'L1', permissions: {} }
  server.entities = [{ id: 'L1', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 }]
  server.status = { connectAccountId: null, exists: false }
  server.statusByEntity = null
  server.feed = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(el: JSX.Element, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}>{el}</MemoryRouter></QueryClientProvider>)
  })
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
}

const text = () => host.textContent ?? ''
const btn = (re: RegExp) =>
  [...host.querySelectorAll('button')].find(b => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined

describe('Disbursement Account page', () => {
  it('shows the Stripe setup and its status — and no Add Account form, list or archive', async () => {
    await render(<BankingPage />)
    expect(text()).toContain('Disbursement Account')
    expect(text()).toContain('Verify your business & get paid')
    expect(text()).toContain('Not started')
    expect(btn(/Connect account for payouts/)).toBeTruthy()

    expect(btn(/Add Account/)).toBeUndefined()
    expect(text()).not.toMatch(/Add Bank Account|Optional — most landlords never need this|TBM First Mid|••••\s*8944/)
    expect(host.querySelector('button[title="Archive"]')).toBeNull()
    // It never asks for the old list at all.
    expect(server.gets).not.toContain('/bank-accounts')
  })

  it('reads the company\'s Stripe status and says when payouts are live', async () => {
    server.status = { connectAccountId: 'acct_1', exists: true, payoutsEnabled: true, detailsSubmitted: true,
                      payoutBank: { bankName: 'First Mid Bank', last4: '8944' } }
    await render(<BankingPage />)
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=L1')
    expect(text()).toContain('Ready')
    expect(text()).toContain("You're all set. Rent deposits to First Mid Bank ••8944.")
    expect(btn(/Connect account for payouts/)).toBeUndefined()
  })

  it('a manager with direct deposit sees the same Stripe setup, no form', async () => {
    server.user = { id: 'u2', role: 'property_manager', permissions: {} }
    await render(<BankingPage />)
    expect(text()).toContain('Your landlord has enabled direct deposit')
    expect(text()).toContain('Verify your business & get paid')
    expect(btn(/Add Account/)).toBeUndefined()
    expect(server.gets).toContain('/stripe/connect/status?entity=user')
    expect(server.gets).not.toContain('/bank-accounts')
  })
})

// 10/12 (Nic): Blu co-owns Oak Park (8/14, payouts live) and owns TruBlu
// Management LLC (8/28, Country Acres, no Stripe account). /auth/me names the
// OLDEST company as profileId, the page opened on Oak Park, and told the
// Country Acres owner "Ready — you're all set" with no button to set TruBlu up.
describe('Disbursement Account page — an account with two companies', () => {
  const OAK_PARK = { id: 'OP', businessName: 'Oak Park Motel and RV LLC', isOwner: false, connectPayoutsEnabled: true, propertyCount: 1 }
  const TRUBLU = { id: 'TB', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 }
  const PAID = { connectAccountId: 'acct_op', exists: true, payoutsEnabled: true, detailsSubmitted: true,
                 payoutBank: { bankName: 'Oak Park Bank', last4: '1111' } }

  beforeEach(() => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.statusByEntity = { OP: PAID, TB: { connectAccountId: null, exists: false } }
  })

  it('opens on the company that can\'t be paid, never on the oldest one', async () => {
    server.entities = [OAK_PARK, TRUBLU]
    await render(<BankingPage />)
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=TB')
    expect(server.gets).not.toContain('/stripe/connect/status?entity=landlord&entityId=OP')
    expect(text()).toContain('Not started')
    expect(text()).not.toContain('Ready')
    expect(text()).not.toContain("You're all set")
    const connect = btn(/Connect account for payouts/)
    expect(connect).toBeTruthy()
    expect(connect!.disabled).toBe(false)
  })

  it('with no single company to land on, chooses none and claims nothing', async () => {
    const SECOND = { id: 'MV', businessName: 'Mountain View LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 2 }
    server.entities = [OAK_PARK, TRUBLU, SECOND]
    await render(<BankingPage />)
    expect(server.gets.filter(u => u.startsWith('/stripe/connect/status'))).toEqual([])
    expect(text()).toContain('Choose the company above')
    expect(text()).not.toContain('Ready')
    expect(text()).not.toContain("You're all set")
    expect(text()).toContain("TruBlu Management LLC, Mountain View LLC can't be paid yet.")
  })

  it('a to-do link opens the company it names', async () => {
    const SECOND = { id: 'MV', businessName: 'Mountain View LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 2 }
    server.entities = [OAK_PARK, TRUBLU, SECOND]
    server.statusByEntity = { ...server.statusByEntity, MV: { connectAccountId: null, exists: false } }
    await render(<BankingPage />, '/banking?entity=MV')
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=MV')
    expect(text()).toContain('Not started')
    // The other unpaid company is still named while this one is on screen.
    expect(text()).toContain("TruBlu Management LLC can't be paid yet.")
  })

  it('choosing the paid company still names the one that can\'t be paid', async () => {
    server.entities = [OAK_PARK, TRUBLU]
    await render(<BankingPage />, '/banking?entity=OP')
    expect(text()).toContain("You're all set. Rent deposits to Oak Park Bank ••1111.")
    expect(text()).toContain("TruBlu Management LLC can't be paid yet.")
  })
})

describe('onboarding', () => {
  it('asks Stripe about the company it owns, never the old bank list', async () => {
    await render(<OnboardingPage />)
    // 10/12: entity=user read the account's own (empty) user-level Connect id,
    // so a landlord who finished Stripe on the Banking page — which verifies
    // the company — stayed "not set up" here.
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=L1')
    expect(server.gets).not.toContain('/stripe/connect/status?entity=user')
    expect(server.gets).not.toContain('/bank-accounts')
    expect(text()).not.toMatch(/Add Bank Account/)
  })

  // 10/12 (Nic): linking the read-only feed marked Get Paid (step 3) done —
  // green check, "Complete" — with no Stripe payouts behind it. Left over from
  // S649 adding Add Your Units ahead of both bank steps.
  it('a linked bank feed does not mark Get Paid done when payouts are not set up', async () => {
    server.feed = [{ id: 'bc1', status: 'active' }]
    await render(<OnboardingPage />)
    const stepItem = (label: string) => {
      const el = [...host.querySelectorAll('div')].find(d => d.textContent === label && d.children.length === 0)
      return el?.parentElement?.parentElement ?? null
    }
    const getPaid = stepItem('Get Paid')
    const feed = stepItem('Connect Your Bank')
    expect(getPaid).toBeTruthy()
    expect(feed).toBeTruthy()
    expect(getPaid!.querySelector('svg.lucide-check'), 'Get Paid shows a check with no payouts').toBeNull()
    expect(feed!.querySelector('svg.lucide-check')).not.toBeNull()
  })
})

// 10/12 (Nic): the "Bank account setup incomplete" banner asked Stripe about
// user.profileId — the account's oldest company — so Oak Park's live payouts
// hid it from the owner of Country Acres, whose company has no Stripe account.
describe('Properties banner', () => {
  it('names the company with a property that can\'t be paid, even when another is paid', async () => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [
      { id: 'OP', businessName: 'Oak Park Motel and RV LLC', isOwner: false, connectPayoutsEnabled: true, propertyCount: 1 },
      { id: 'TB', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 },
    ]
    server.status = { connectAccountId: 'acct_op', exists: true, payoutsEnabled: true, detailsSubmitted: true }
    await render(<PropertiesPage />)
    expect(text()).toContain('Payouts not set up for TruBlu Management LLC')
    expect(text()).not.toContain('Oak Park Motel and RV LLC can')
    // It never asks Stripe about the account's oldest company to decide.
    expect(server.gets).not.toContain('/stripe/connect/status?entity=landlord&entityId=OP')
  })

  it('stays hidden when every company with a property can be paid', async () => {
    server.entities = [{ id: 'L1', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: true, propertyCount: 1 }]
    await render(<PropertiesPage />)
    expect(text()).not.toContain('Payouts not set up')
  })

  it('a manager is not told to set up the landlord\'s payouts', async () => {
    server.user = { id: 'u2', role: 'property_manager', permissions: {} }
    await render(<PropertiesPage />)
    expect(text()).not.toContain('Payouts not set up')
  })
})

describe('property form', () => {
  it('shows the Stripe payout bank only — no per-property pick from the old list', async () => {
    server.status = { connectAccountId: 'acct_1', exists: true, payoutsEnabled: true, detailsSubmitted: true,
                      payoutBank: { bankName: 'First Mid Bank', last4: '8944' } }
    await render(<PropertiesPage />)
    await act(async () => { btn(/Add Property/)!.click() })
    for (let i = 0; i < 5; i++) {
      await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    }
    expect(text()).toContain('Payout Bank Account')
    expect(text()).toContain('First Mid Bank •••• 8944')
    expect(text()).not.toMatch(/send this property.s rent somewhere else|Use the verified account above|TBM First Mid/)
    expect(server.gets).not.toContain('/bank-accounts')
  })
})
