// @vitest-environment jsdom
/**
 * BANK SETUP — ONE FLOW, TWO STEPS.
 *
 * 10/19 (Nic, DIRECTIVE): "The bank page only is for linking a bank for bank
 * feed reconciliation. The disbursement account is where money pays out from
 * Stripe to his bank account, right? I don't know why there's two different
 * fucking signups. It should all be in one flow." Then: "Merge it all so it's
 * one flow for any other landlords that onboard."
 *
 * Blu Haws went to the Disbursement Account page on 10/5 — one of two nav
 * entries three letters apart — found the old pre-Stripe "Add Bank Account"
 * form, typed in his First Mid routing and account number, and waited for
 * microdeposits that could never come. His company had no Stripe account at
 * all. These pin the merge that followed:
 *
 *   - ONE destination (/bank, the Bank setup tab) with the two steps in order
 *     and honest state for each.
 *   - It says out loud that setup is not finished until both are done.
 *   - Step 2 names the bank from step 1 instead of asking for it again.
 *   - Step 2 is offered even when step 1 is not done — no gate, nobody stranded.
 *   - The old /banking address still resolves there, with its ?entity= intact.
 *   - A landlord whose property onboarding window expired weeks ago (Blu's
 *     exact state) still reaches both steps, neither hidden nor disabled.
 *
 * 10/12 (Nic): "Remove the old form." Kept from the previous pass: the pages
 * render the Stripe setup and its status, never the form, never the per-property
 * routing pick, and never even ask the API for the old list — so a legacy row
 * cannot reappear as something to pick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const server = vi.hoisted(() => ({
  gets: [] as string[],
  posts: [] as string[],
  user: { id: 'u1', role: 'landlord', profileId: 'L1', permissions: {} } as any,
  entities: [{ id: 'L1', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 }] as any[],
  status: { connectAccountId: null, exists: false } as any,
  // 10/12: per-company Stripe status, keyed by entityId (falls back to `status`).
  statusByEntity: null as Record<string, any> | null,
  feed: [] as any[],
  // 10/19 (review): per-company linked banks, keyed by entityId (falls back to
  // `feed`). The hole this pins needs one company linked and one not.
  feedByEntity: null as Record<string, any[]> | null,
  // Onboarding's units step gates the money steps on a unit existing, and its
  // property step needs a property to attach them to.
  properties: [] as any[],
  units: [] as any[],
}))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    server.gets.push(url)
    if (url === '/landlords/me/entities') return server.entities
    if (url === '/properties') return server.properties
    if (url === '/units') return server.units
    if (url.startsWith('/stripe/connect/status')) {
      const id = new URLSearchParams(url.split('?')[1] ?? '').get('entityId') ?? ''
      return server.statusByEntity?.[id] ?? server.status
    }
    if (url.startsWith('/bank-feed/connections')) {
      const id = new URLSearchParams(url.split('?')[1] ?? '').get('entityId') ?? ''
      return server.feedByEntity?.[id] ?? server.feed
    }
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
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(async () => null) }))
vi.mock('@stripe/react-connect-js', () => ({
  ConnectAccountOnboarding: () => null,
  ConnectComponentsProvider: ({ children }: any) => children,
}))
// The other two tabs of the merged page are whole subsystems of their own (the
// books reconciliation and the deposit matcher) and are tested where they live.
vi.mock('../bookkeeping/BankReconcilePage', () => ({ BankReconcilePage: () => null }))
vi.mock('../bookkeeping/adapter', () => ({ setBooksCompany: () => {} }))
vi.mock('./DepositMatchPanel', () => ({ DepositMatchPanel: () => null, CashPositionPanel: () => null }))

import { BankPage } from './BankPage'
import { BankSetupRedirect } from './BankSetup'
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
  server.feedByEntity = null
  server.properties = []
  server.units = []
  window.history.replaceState({}, '', '/')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(el: JSX.Element, path = '/') {
  // useUrlTab reads the real address (it keeps the chosen tab across a reload),
  // so the window and the router entry are set to the same path.
  window.history.replaceState({}, '', path)
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


// ── the merged destination ──────────────────────────────────────────────────

const OAK_PARK = { id: 'OP', businessName: 'Oak Park Motel and RV LLC', isOwner: true, connectPayoutsEnabled: true, propertyCount: 1 }
const TRUBLU   = { id: 'TB', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 1 }
const LIVE     = { connectAccountId: 'acct_1', exists: true, payoutsEnabled: true, detailsSubmitted: true,
                   payoutBank: { bankName: 'First Mid Bank', last4: '8944' } }
// A hand-linked bank as the API really answers for one: debit_ready is a field
// on every row (bankFeed.listConnections), and for a platform-held link that
// carries payment_method it is true. A fixture without it reads as "GAM cannot
// collect from this bank", which is a different landlord.
const LINKED   = [{ id: 'bc1', status: 'active', displayName: 'First Mid Bank ••8944',
                    source: 'landlord_link', connectHeld: false, debitReady: true, debitProblem: null }]

/** Where each step's heading sits in the page, to prove the order on screen. */
const stepPos = () => {
  const t = text()
  return { one: t.indexOf('step 1 of 2'), two: t.indexOf('step 2 of 2') }
}
/** One step's own card, so "Done" is read off the step it belongs to. */
const stepCard = (n: 1 | 2) =>
  [...host.querySelectorAll('.card')].find(c => (c.textContent ?? '').includes(`step ${n} of 2`)) as HTMLElement | undefined
const stepDone = (n: 1 | 2) => {
  const card = stepCard(n)
  expect(card, `step ${n} is on screen`).toBeTruthy()
  const t = card!.textContent ?? ''
  return t.includes('Not done') ? false : t.includes('Done')
}

describe('Bank setup — one destination, two steps', () => {
  it('a landlord with nothing done opens on step 1, and is told the setup is unfinished', async () => {
    await render(<BankPage />, '/bank')
    // Opens on Bank setup, not on the transaction log of a bank that isn't connected.
    expect(text()).toContain('Bank setup · step 1 of 2')
    expect(text()).toContain("Your bank setup isn't finished.")
    expect(text()).toContain('neither is done')
    // Step 1 is above step 2, and it is the one with the button to press.
    const { one, two } = stepPos()
    expect(one).toBeGreaterThan(-1)
    expect(two).toBeGreaterThan(one)
    expect(stepDone(1)).toBe(false)
    expect(stepDone(2)).toBe(false)
    expect(text()).toContain('Verify your business & get paid')
    const connect = btn(/Connect account for payouts/)
    expect(connect).toBeTruthy()
    expect(connect!.disabled).toBe(false)
  })

  it('verified with no feed linked: step 1 done, step 2 outstanding — and step 2 names that bank', async () => {
    server.status = LIVE
    await render(<BankPage />, '/bank')
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=L1')
    expect(stepDone(1)).toBe(true)
    expect(stepDone(2)).toBe(false)
    // Step 1 reports the bank Stripe pays out to, and asks for nothing more.
    expect(text()).toContain("You're all set. Rent deposits to First Mid Bank ••8944.")
    expect(btn(/Connect account for payouts/)).toBeUndefined()
    // Step 2 is the one outstanding, and it names the SAME account rather than
    // asking the landlord to type a bank in a second time.
    expect(text()).toContain('same bank account')
    expect(text()).toContain('First Mid Bank ••8944')
    expect(text()).toContain("Your bank setup isn't finished.")
    const feed = btn(/Connect feed/)
    expect(feed).toBeTruthy()
    expect(feed!.disabled).toBe(false)
    // One step done, one left — never "both" and never "neither".
    expect(text()).toContain('one is done')
    expect(text()).not.toContain('neither is done')
  })

  it('both done reads as finished', async () => {
    server.status = LIVE
    server.feed = LINKED
    await render(<BankPage />, '/bank?tab=setup')
    expect(text()).toContain('Bank setup is complete.')
    expect(stepDone(1)).toBe(true)
    expect(stepDone(2)).toBe(true)
    expect(text()).toContain('First Mid Bank ••8944 is linked, read-only.')
    expect(text()).not.toContain("isn't finished")
    expect(btn(/Connect feed/)).toBeUndefined()
    expect(btn(/Connect account for payouts/)).toBeUndefined()
  })

  // 10/19: Blu's exact state. TruBlu Management LLC owns Country Acres -
  // Mattoon, whose onboarding window closed 9/11; he also owns Oak Park, which
  // is paid. He came back on 10/5, weeks after the window.
  it("an expired onboarding window hides and disables nothing — Blu's state", async () => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [OAK_PARK, TRUBLU]
    server.statusByEntity = { OP: LIVE, TB: { connectAccountId: null, exists: false } }
    await render(<BankPage />, '/bank')

    // It opens on the company that can't be paid, never on the oldest one.
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=TB')
    expect(server.gets).not.toContain('/stripe/connect/status?entity=landlord&entityId=OP')

    // BOTH steps are on screen, both pressable.
    const { one, two } = stepPos()
    expect(one).toBeGreaterThan(-1)
    expect(two).toBeGreaterThan(one)
    expect(btn(/Connect account for payouts/)!.disabled).toBe(false)
    expect(btn(/Connect feed/)!.disabled).toBe(false)
    expect(text()).toContain("Your bank setup isn't finished.")

    // And the reason it cannot be hidden by an expired window: bank setup never
    // consults one. The window gates tenant screening (services/onboardingWindow),
    // nothing about money leaving or entering a bank.
    expect(server.gets.some(u => /onboarding-window|window/i.test(u))).toBe(false)
  })

  // 10/19 (Nic): step 2 must be OFFERED, never gated on step 1. S637 hid the
  // feed until payouts existed so nobody linked the read-only feed believing
  // they had set up payouts; the order and the labels do that job now, and
  // hiding it would strand somebody who came back weeks later — which is
  // exactly what happened to Blu.
  it('offers step 2 even with step 1 untouched', async () => {
    await render(<BankPage />, '/bank?tab=setup')
    const feed = btn(/Connect feed/)
    expect(feed).toBeTruthy()
    expect(feed!.disabled).toBe(false)
    // It still says which one comes first rather than pretending they are peers.
    expect(text()).toContain("you'll verify in step 1")
  })

  // S654 (Nic, DIRECTIVE): none is the default. An account that owns several
  // companies names one before anything claims a status for it — the bug that
  // told the Country Acres owner "you're all set" about Oak Park.
  it('with no single company to land on, chooses none and claims nothing', async () => {
    const SECOND = { id: 'MV', businessName: 'Mountain View LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 2 }
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [OAK_PARK, TRUBLU, SECOND]
    server.statusByEntity = { OP: LIVE, TB: { connectAccountId: null, exists: false }, MV: { connectAccountId: null, exists: false } }
    await render(<BankPage />, '/bank?tab=setup')
    expect(server.gets.filter(u => u.startsWith('/stripe/connect/status'))).toEqual([])
    expect(text()).toContain('Choose the company above')
    expect(text()).not.toContain("You're all set")
    expect(text()).not.toContain('Bank setup is complete.')
    expect(text()).toContain("TruBlu Management LLC, Mountain View LLC can't be paid yet.")
    // No half-pressable step either: with no company named there is nothing for
    // a button to act on, so neither is offered (S637 — "the adding a bank
    // button does nothing right now").
    expect(btn(/Connect account for payouts/)).toBeUndefined()
    expect(btn(/Connect feed/)).toBeUndefined()
    expect(text()).toContain('Choose the company above to link its bank read-only.')
  })

  it('a to-do link opens the company it names', async () => {
    const SECOND = { id: 'MV', businessName: 'Mountain View LLC', isOwner: true, connectPayoutsEnabled: false, propertyCount: 2 }
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [OAK_PARK, TRUBLU, SECOND]
    server.statusByEntity = { OP: LIVE, TB: { connectAccountId: null, exists: false }, MV: { connectAccountId: null, exists: false } }
    await render(<BankPage />, '/bank?tab=setup&entity=MV')
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=MV')
    expect(stepDone(1)).toBe(false)
    // The other unpaid company is still named while this one is on screen.
    expect(text()).toContain("TruBlu Management LLC can't be paid yet.")
  })

  it('a finished landlord still lands on the bank feed, their daily page', async () => {
    server.status = LIVE
    server.feed = LINKED
    await render(<BankPage />, '/bank')
    expect(text()).toContain('Your spending')
    expect(text()).not.toContain('Bank setup · step 1 of 2')
  })
})

// ── ONE BANK LINK ───────────────────────────────────────────────────────────
//
// 10/20 (Nic): "We need a way to link the bank account once and have it be
// everything. It needs to do the feed. It needs to do the deposits or whatever
// one flow needs to be the whole thing and it boggles my mind that Stripe being
// one of the biggest payment processors in the world has no functionality for
// that."
//
// On the morning of 10/20 he turned on financial-data access for balances,
// account ownership details and transactions under Settings > Connect >
// Payouts > External accounts. So the bank a landlord signs into in step one is
// readable, the API adopts it as their feed (services/connectBankLink), and
// step two has nothing left to ask. The two populations below are the whole
// point: nobody is asked for the same bank twice, and nobody who onboarded
// before this morning is asked for it twice either.

/** A bank adopted from step one: held by the connected account, read-only to GAM. */
const FROM_ONBOARDING = [{
  id: 'bc_ob', status: 'active', source: 'connect_onboarding', connectHeld: true,
  displayName: 'First Mid Bank ••8944', institutionName: 'First Mid Bank',
  fcPermissions: ['payment_method', 'balances', 'transactions', 'ownership'],
  debitReady: false,
  debitProblem: 'Connected during your business verification, so GAM can read it but cannot collect its fees from it.',
}]
/** A bank the landlord signed into on the Bank page: platform-held, debitable. */
const LINKED_BY_HAND = [{
  id: 'bc1', status: 'active', source: 'landlord_link', connectHeld: false,
  displayName: 'First Mid Bank ••8944', fcPermissions: ['transactions', 'balances', 'payment_method'],
  debitReady: true, debitProblem: null,
}]

describe('one bank link — onboarded from today on', () => {
  it('step two reads as done in step 1, and never offers a second sign-in', async () => {
    server.status = LIVE
    server.feed = FROM_ONBOARDING
    await render(<BankPage />, '/bank?tab=setup')

    expect(stepDone(1)).toBe(true)
    expect(stepDone(2)).toBe(true)
    // The badge is not a bare "Done" — it says where it got done, because a
    // step that silently went green is a step nobody trusts.
    expect(stepCard(2)!.textContent).toContain('Done in step 1')
    expect(text()).toContain('First Mid Bank ••8944 is already connected, read-only — you did this in step 1.')
    expect(text()).toContain('Nothing to sign in to again.')
    // And it is specific about what GAM can see, from the permissions Stripe
    // actually granted — never a blanket claim.
    expect(text()).toContain('the transactions on it, its balance and whose name it is in')
    expect(text()).toContain('Bank setup is complete.')
    expect(text()).not.toContain("isn't finished")
    // No "Connect feed" anywhere: that button IS the second bank sign-in.
    expect(btn(/^.*Connect feed/)).toBeUndefined()
  })

  // 10/20 (review): this card used to end "it is optional, and your payouts and
  // your feed both work either way" — the one framing S651 forbids. Nic: "That's
  // not a landlord choice to fucking pay us. What the fuck? It's mandatory."
  // A landlord at a cash park who believed it has no payout to net from and no
  // bank GAM can debit, and the same portal that called it optional eventually
  // suspends them over the balance.
  it('discloses that fee collection still needs this bank, and never calls it optional', async () => {
    server.status = LIVE
    server.feed = FROM_ONBOARDING
    await render(<BankPage />, '/bank?tab=setup')
    expect(text()).toContain('Fee collection needs this bank too.')
    expect(text()).toContain("GAM's fees come out of your rent payouts.")
    // Why it matters to them, in their own terms — not a threat, and not a hedge.
    expect(text()).toContain('a month the rent comes in as cash leaves no payout to take them from')
    expect(text()).toContain('Connect the same account once here')
    expect(btn(/Connect for fee collection/)).toBeTruthy()
    // No choice offered anywhere on the step.
    expect(text()).not.toMatch(/optional/i)
    expect(text()).not.toMatch(/if you would rather/i)
    expect(text()).not.toMatch(/either way/i)
  })

  // 10/20 (review): the notice asked "is EVERY link connect-held", which is a
  // different question. Mountain View's live shape is a PLATFORM-held link with
  // permissions ["balances","transactions"] and no payment_method — not
  // debit-ready, not connect-held — so one row like that made the answer false
  // and the landlord was told nothing at all, on a company GAM has no debitable
  // bank for.
  it('shows it for a platform link that cannot be debited either', async () => {
    server.status = LIVE
    server.feed = [
      { id: 'bc_ob', status: 'active', source: 'connect_onboarding', connectHeld: true,
        displayName: 'First Mid Bank ••8944', fcPermissions: ['payment_method', 'transactions'],
        debitReady: false, debitProblem: 'Connected during your business verification…' },
      { id: 'bc_mv', status: 'active', source: 'landlord_link', connectHeld: false,
        displayName: 'Wells Fargo ••8739', fcPermissions: ['balances', 'transactions'],
        debitReady: false, debitProblem: 'Linked before GAM asked for permission to debit — link this account once more.' },
    ]
    await render(<BankPage />, '/bank?tab=setup')
    expect(stepDone(2)).toBe(true)
    expect(text()).toContain('Fee collection needs this bank too.')
    expect(btn(/Connect for fee collection/)).toBeTruthy()
  })

  it('a bank the landlord linked by hand says nothing about a missing debit', async () => {
    server.status = LIVE
    server.feed = LINKED_BY_HAND
    await render(<BankPage />, '/bank?tab=setup')
    expect(stepDone(2)).toBe(true)
    expect(text()).toContain('First Mid Bank ••8944 is linked, read-only.')
    expect(stepCard(2)!.textContent).not.toContain('Done in step 1')
    expect(text()).not.toContain('Fee collection needs this bank too.')
    expect(btn(/Connect for fee collection/)).toBeUndefined()
  })
})

describe('one bank link — onboarded before the switch', () => {
  // Blu Haws finished step one at 18:24 on 10/19, before the switch. His link
  // carries payment_method only — verified against live Stripe on 10/20
  // (fca_1USLR9…, permissions ["payment_method"]) — and Stripe fixes
  // permissions at link time, so it can never be read for transactions. He
  // still does step two. Nic: "he still only has to do step two either way,
  // right?" Yes, and this pins that it is once, not twice.
  it('still gets step two, offered exactly once', async () => {
    server.status = LIVE
    server.feed = []
    await render(<BankPage />, '/bank?tab=setup')

    expect(stepDone(1)).toBe(true)
    expect(stepDone(2)).toBe(false)
    expect(stepCard(2)!.textContent).not.toContain('Done in step 1')
    // ONE button for it, on ONE screen — not one per Stripe product.
    const asks = [...host.querySelectorAll('button')].filter(b => /Connect feed/.test(b.textContent ?? ''))
    expect(asks).toHaveLength(1)
    expect(asks[0].disabled).toBe(false)
    // And it names the bank from step one rather than asking him to find it again.
    expect(text()).toContain('same bank account')
    expect(text()).toContain('First Mid Bank ••8944')
    expect(text()).toContain("Your bank setup isn't finished.")
  })

  it('once he does it, it is done and nothing asks again', async () => {
    server.status = LIVE
    server.feed = LINKED_BY_HAND
    await render(<BankPage />, '/bank?tab=setup')
    expect(stepDone(2)).toBe(true)
    expect(text()).toContain('Bank setup is complete.')
    expect(btn(/Connect feed/)).toBeUndefined()
  })

  it('a landlord with no Stripe account at all sees step one first, as now', async () => {
    server.status = { connectAccountId: null, exists: false }
    server.feed = []
    await render(<BankPage />, '/bank')
    expect(text()).toContain('Bank setup · step 1 of 2')
    const { one, two } = stepPos()
    expect(one).toBeGreaterThan(-1)
    expect(two).toBeGreaterThan(one)
    expect(stepDone(1)).toBe(false)
    expect(stepDone(2)).toBe(false)
    expect(btn(/Connect account for payouts/)!.disabled).toBe(false)
    expect(text()).toContain('neither is done')
  })
})

// 10/19: /banking was the Disbursement Account page. A landlord may have it
// bookmarked — Blu does — and the owner to-do list links it with ?entity=.
describe('the old /banking address', () => {
  function Probe() {
    const loc = useLocation()
    return <div>landed:{loc.pathname}{loc.search}</div>
  }

  it('resolves to the merged destination, carrying the company it named', async () => {
    await render(
      <Routes>
        <Route path="/banking" element={<BankSetupRedirect />} />
        <Route path="/bank" element={<Probe />} />
      </Routes>,
      '/banking?entity=MV',
    )
    expect(text()).toContain('landed:/bank?')
    expect(text()).toContain('entity=MV')
    expect(text()).toContain('tab=setup')
  })

  it('resolves for a plain bookmark too', async () => {
    await render(
      <Routes>
        <Route path="/banking" element={<BankSetupRedirect />} />
        <Route path="/bank" element={<Probe />} />
      </Routes>,
      '/banking',
    )
    expect(text()).toBe('landed:/bank?tab=setup')
  })
})

// 10/19: a manager their landlord switched direct deposit on reaches the same
// destination for their OWN payout account — and nothing else. The company's
// feed and its reconciliation are not theirs to read, which is all /banking
// ever showed them.
describe('a manager with direct deposit', () => {
  it('sees their own payout account only — no feed, no reconciliation', async () => {
    server.user = { id: 'u2', role: 'property_manager', permissions: {} }
    await render(<BankPage />, '/bank')
    expect(text()).toContain('Your landlord has enabled direct deposit')
    expect(text()).toContain('Verify your details & get paid')
    expect(server.gets).toContain('/stripe/connect/status?entity=user')
    expect(text()).not.toContain('Reconciliation')
    expect(text()).not.toContain('Your spending')
    expect(server.gets).not.toContain('/bank-accounts')
    // And never asks for the company's bank feed on their behalf — it is not theirs.
    expect(server.gets.some(u => u.startsWith('/bank-feed/'))).toBe(false)
  })

  // 10/19 (review): the component's own comment said "one step, so it is shown
  // without the two-step framing" and the code printed "Bank setup · step 1 of
  // 2" with the landlord's sentence about rent. A manager went looking for a
  // step 2 that is not on their page and for rent they do not collect.
  it('is one step, and about their fees — never "step 1 of 2", never rent', async () => {
    server.user = { id: 'u2', role: 'property_manager', permissions: {} }
    await render(<BankPage />, '/bank')
    expect(text()).not.toContain('step 1 of 2')
    expect(text()).not.toContain('step 2 of 2')
    expect(text()).not.toContain('so rent can reach your bank')
    expect(text()).not.toContain('Required before tenants can pay rent')
    expect(text()).toContain('Verify your details so your fees can reach your bank.')
    expect(text()).toContain('Required before your fees can be paid out.')
  })
})

// 10/19 (review): bank setup is the ACCOUNT OWNER's. A GAM admin opens this
// page to look at a landlord's feed; the Bank setup tab was offering them
// "Verify your business & get paid" with a gold button that creates a real
// Stripe Connect account against the GAM staff user, and the page fetched that
// admin's own Connect status on load.
describe('a GAM admin looking in', () => {
  for (const role of ['admin', 'super_admin']) {
    it(`${role}: no Bank setup tab, and nothing asked about their own account`, async () => {
      server.user = { id: 'gam1', role, permissions: {} }
      await render(<BankPage />, '/bank')
      expect(btn(/^Bank setup$/)).toBeUndefined()
      expect(btn(/Connect account for payouts/)).toBeUndefined()
      expect(server.gets).not.toContain('/stripe/connect/status?entity=user')
      // They still get what they came for.
      expect(btn(/^Bank feed$/)).toBeTruthy()
      expect(btn(/^Reconciliation$/)).toBeTruthy()
    })
  }

  it('cannot reach the setup tab by address either', async () => {
    server.user = { id: 'gam1', role: 'super_admin', permissions: {} }
    await render(<BankPage />, '/bank?tab=setup')
    expect(text()).not.toContain('Bank setup · step 1 of 2')
    expect(server.gets).not.toContain('/stripe/connect/status?entity=user')
  })
})

// 10/19 (review): Blu one step from now. He finishes step 1 for TruBlu today;
// tomorrow both his companies are paid, so the payouts rule picks no company,
// so nothing was "known", so no banner rendered on any tab and the page opened
// on the feed — with TruBlu's read-only feed still missing and no screen saying
// so. The exact silence that cost him 10/5, one step later.
describe('two companies, payouts live on both, one feed missing', () => {
  const OP_PAID = { ...OAK_PARK, connectPayoutsEnabled: true }
  const TB_PAID = { ...TRUBLU, connectPayoutsEnabled: true }

  it('lands on Bank setup and names the company that still needs it', async () => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [OP_PAID, TB_PAID]
    server.statusByEntity = { OP: LIVE, TB: { ...LIVE, payoutBank: null } }
    server.feedByEntity = { OP: LINKED, TB: [] }
    await render(<BankPage />, '/bank')
    // The company with setup left is the one on screen — not the oldest one.
    expect(server.gets).toContain('/stripe/connect/status?entity=landlord&entityId=TB')
    expect(text()).toContain('Bank setup · step 2 of 2')
    expect(text()).toContain("Your bank setup isn't finished.")
    expect(stepDone(1)).toBe(true)
    expect(stepDone(2)).toBe(false)
    expect(btn(/Connect feed/)).toBeTruthy()
  })

  it('says so on the other tabs too, and names the company', async () => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    // Three companies, two unfinished: no single company to land on, which is
    // the case that used to render nothing at all.
    server.entities = [OP_PAID, TB_PAID, { id: 'MV', businessName: 'Mountain View LLC', isOwner: true, connectPayoutsEnabled: true, propertyCount: 2 }]
    server.statusByEntity = { OP: LIVE, TB: LIVE, MV: LIVE }
    server.feedByEntity = { OP: LINKED, TB: [], MV: [] }
    await render(<BankPage />, '/bank?tab=feed')
    expect(text()).toContain("Your bank setup isn't finished.")
    expect(text()).toContain('TruBlu Management LLC, Mountain View LLC still need it.')
    expect(btn(/Finish bank setup/)).toBeTruthy()
  })

  it('stays quiet when every company is finished', async () => {
    server.entities = [OP_PAID, TB_PAID]
    server.statusByEntity = { OP: LIVE, TB: LIVE }
    server.feedByEntity = { OP: LINKED, TB: LINKED }
    await render(<BankPage />, '/bank')
    expect(text()).not.toContain("isn't finished")
    // Opens on the feed, their daily page — not on a setup tab with nothing left.
    expect(text()).not.toContain('Bank setup · step 1 of 2')
    expect(text()).toContain('Linked banks')
  })
})

// 10/19 (review): Stripe holds payouts while it checks submitted details. The
// merge replaced the deleted page's three-state chip with Done / Not done, so
// somebody who had already handed over an EIN, a date of birth and an SSN was
// told the step was not done and shown the gather-your-documents list again.
describe('waiting on Stripe', () => {
  it('reads as verifying, and does not ask for the paperwork a second time', async () => {
    server.status = { connectAccountId: 'acct_1', exists: true, detailsSubmitted: true, payoutsEnabled: false }
    await render(<BankPage />, '/bank?tab=setup')
    expect(stepCard(1)!.textContent).toContain('Verifying…')
    expect(stepCard(1)!.textContent).not.toContain('Not done')
    expect(text()).not.toContain('Have these ready')
    expect(text()).toContain('Stripe has your details and is checking them.')
    expect(btn(/Continue connecting account/)).toBeUndefined()
  })

  it('and when Stripe wants one more thing, says what and lets them back in', async () => {
    server.status = { connectAccountId: 'acct_1', exists: true, detailsSubmitted: true, payoutsEnabled: false,
                      requirementsCurrentlyDue: ['individual.verification.document'] }
    await render(<BankPage />, '/bank?tab=setup')
    expect(stepCard(1)!.textContent).toContain('Action needed')
    expect(text()).toContain('Stripe still needs:')
    expect(text()).not.toContain('Have these ready')
    expect(btn(/Continue connecting account/)).toBeTruthy()
  })
})

// 10/19 (review): the feed tab offered its own "Connect feed" with no company
// chosen — it posted an empty company and came back with "You own more than one
// company", about a question that tab never asked. S637's complaint verbatim.
describe('the Bank feed tab with no company chosen', () => {
  it('offers no Connect feed, and says to choose one', async () => {
    server.user = { id: 'blu', role: 'landlord', profileId: 'OP', permissions: {} }
    server.entities = [OAK_PARK, TRUBLU]
    server.statusByEntity = { OP: LIVE, TB: { connectAccountId: null, exists: false } }
    await render(<BankPage />, '/bank?tab=feed')
    expect(text()).toContain('Choose a company above to see its transactions and link its bank.')
    expect(btn(/Connect feed/)).toBeUndefined()
  })
})

// 10/19 (review): the "a tab they asked for by address is theirs" escape hatch
// could not work for the default tab, because useUrlTab deleted the parameter
// for it — so choosing Bank feed erased the evidence that it was chosen and a
// refresh dropped them back on Bank setup.
describe('the chosen tab survives a refresh', () => {
  it('writes ?tab=feed even though feed is the default', async () => {
    await render(<BankPage />, '/bank')
    expect(text()).toContain('Bank setup · step 1 of 2')
    await act(async () => { btn(/^Bank feed$/)!.click() })
    expect(window.location.search).toContain('tab=feed')
    // And on the way back in, the landing rule defers to it.
    await render(<BankPage />, `/bank${window.location.search}`)
    expect(text()).not.toContain('Bank setup · step 1 of 2')
  })
})

// 10/12 (Nic): "Remove the old form." The form Blu typed his First Mid routing
// and account number into on 10/5. It reached nothing, and nothing like it may
// come back anywhere in the portal.
describe('no routing-number entry form, anywhere in the landlord app', () => {
  const SRC = join(__dirname, '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
    }
    return out
  }

  it('no file collects a routing number, and nothing POSTs the old catalog', () => {
    // A ROUTING number is the tell: there is no way to type a bank account in
    // without one, and nothing else in the portal has a use for it. (An
    // "Account #" on its own is a different thing — a vendor record carries the
    // landlord's customer number at that supplier — so it is not the test.)
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      if (/\brouting_?[Nn]umber\b/.test(src)) offenders.push(`${file}: a routing-number field`)
      if (/placeholder=["'][^"']*[Rr]outing/.test(src)) offenders.push(`${file}: asks for a routing number`)
      if (/<label[^>]*>\s*Routing/i.test(src)) offenders.push(`${file}: a Routing label`)
      // The pre-Stripe catalog: GET is history (existing rows still list), a
      // POST from the portal is the form coming back.
      if (/api(Post|Put)\s*(<[^>]*>)?\s*\(\s*[`'"]\/bank-accounts/.test(src)) offenders.push(`${file}: posts the old bank catalog`)
    }
    expect(offenders).toEqual([])
  })

  it('and the merged destination renders no number field of its own', async () => {
    await render(<BankPage />, '/bank?tab=setup')
    const fields = [...host.querySelectorAll('input')]
      .filter(i => !['checkbox', 'radio', 'button'].includes(i.type))
    for (const f of fields) {
      const words = `${f.placeholder} ${f.getAttribute('aria-label') ?? ''} ${f.name}`.toLowerCase()
      expect(words).not.toMatch(/routing|account number/)
    }
    expect(text()).not.toMatch(/Add Bank Account|Add Account|TBM First Mid/)
    expect(server.gets).not.toContain('/bank-accounts')
  })
})
/** React does not see a raw `el.value = x`; the native setter plus an input event. */
const byPlaceholder = (p: string) =>
  [...host.querySelectorAll('input')].find(i => i.placeholder === p) as HTMLInputElement | undefined
const fill = async (pairs: Array<[string, string]>) => {
  await act(async () => {
    for (const [placeholder, v] of pairs) {
      const el = byPlaceholder(placeholder)!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
}
const next = async () => {
  await act(async () => { btn(/Continue|Sign & Activate/)!.click() })
  await settle()
}

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

  // 10/19 (review): THE DEAD END. This read asked for the bank feed without
  // naming a company, and the API cannot answer that for an account that owns
  // two or more — it returns 400. So the list came back empty forever: the
  // landlord pressed Connect feed, signed in at their bank, the link was really
  // created, and the wizard still said Not done with Continue greyed out and
  // Sign Agreement locked. Blu has owned two companies since 8/31.
  it('asks for the bank feed BY COMPANY, never with the company left off', async () => {
    await render(<OnboardingPage />)
    expect(server.gets).toContain('/bank-feed/connections?entityId=L1')
    expect(server.gets).not.toContain('/bank-feed/connections')
  })

  // 10/19 (review): step 4 told a multi-company owner to "choose the company
  // above" and rendered no picker — the control was inside step 3 only. With
  // Continue disabled until a feed is linked and no skip on the step, it was a
  // screen with an instruction that could not be followed and no way off it.
  describe('step 4 with several companies and none chosen', () => {
    const drive = async () => {
      server.user = { id: 'blu', role: 'landlord', profileId: null, permissions: {} }
      // Both paid, so step 3's Continue opens without choosing a company —
      // which is exactly how somebody reached step 4 with no company named.
      server.entities = [
        { id: 'OP', businessName: 'Oak Park Motel and RV LLC', isOwner: true, connectPayoutsEnabled: true, propertyCount: 1 },
        { id: 'TB', businessName: 'TruBlu Management LLC', isOwner: true, connectPayoutsEnabled: true, propertyCount: 1 },
      ]
      server.properties = [{ id: 'p1', name: 'Country Acres - Mattoon' }]
      server.units = [{ id: 'u1', unitNumber: '1' }]
      await render(<OnboardingPage />)
      await fill([['Smith Properties LLC', 'TruBlu Management LLC'], ['(555) 000-0000', '2175551234']])
      await next()                                   // → First Property
      await fill([
        ['Oak Street Apartments', 'Country Acres - Mattoon'],
        ['4821 W Oak St', '1 Country Acres Rd'],
        ['Phoenix', 'Mattoon'],
        ['85031', '61938'],
      ])
      await next()                                   // → Add Your Units
      await next()                                   // → Get Paid
      await next()                                   // → Connect Your Bank
      expect(text()).toContain('Bank setup · step 2 of 2')
    }

    it('renders the company picker it tells them to use', async () => {
      await drive()
      expect(text()).toContain('Choose the company above to link its bank read-only.')
      const picker = [...host.querySelectorAll('select')]
        .find(s => [...s.options].some(o => o.textContent?.includes('TruBlu Management LLC')))
      expect(picker, 'a company picker is on the step').toBeTruthy()
      expect(text()).toContain('Bank setup for')
    })

    it('is not a dead end — the step can be left', async () => {
      await drive()
      // Continue is held until a bank is linked, so the step needs its own way off.
      expect(btn(/Continue/)!.disabled).toBe(true)
      const skip = btn(/Skip for now/)
      expect(skip, 'the step offers the same escape step 3 does').toBeTruthy()
      await act(async () => { skip!.click() })
      await settle()
      expect(text()).toContain('Landlord Platform Participation Agreement')
      expect(btn(/Sign & Activate/)).toBeTruthy()
    })
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
