// @vitest-environment jsdom
/**
 * 10/14 (Nic, answer 16): "if gam 100 percent knows who that money came from it
 * can file it but no guessing." On the Bank page:
 *   - money coming in starts with no place picked; where the payer's last
 *     deposit went is a button the person presses ("Same place as last time");
 *   - a deposit of a GAM payout's amount whose memo does not name GAM is offered
 *     as that payout, for the person to match.
 * 10/14 (Nic, answer 15): a line going out that may be a check the bank
 * returned lists the checks of its amount under "What did this pay?" for the
 * owner to pick; a returned check GAM took back says so and can be undone.
 * 10/14 afternoon (Nic): a money order, and a tenant's own bank deposit, that
 * come back are taken back the same way and say so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'
import { MemoryRouter } from 'react-router-dom'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  txns: [] as any[],
  matches: {} as Record<string, any>,
  posts: [] as Array<{ url: string; body: any }>,
}))

vi.mock('../lib/api', () => ({
  api: {},
  apiGet: async (url: string) => {
    if (url.startsWith('/bank-feed/connections')) return [{ id: 'c1', displayName: 'Test Bank ••1111', status: 'active' }]
    if (url === '/properties') return [{ id: 'p1', name: 'Oak Park' }]
    if (url === '/units') return [{ id: 'u5', unitNumber: 'Unit 5', propertyId: 'p1' }]
    if (url === '/expenses/options') return { categories: [] }
    const m = /^\/bank-feed\/transactions\/([^/]+)\/matches$/.exec(url)
    if (m) return server.matches[m[1]] ?? { expenses: [], checks: [], records: [], returnedChecks: [] }
    if (url.startsWith('/bank-feed/transactions')) return server.txns
    return []
  },
  apiPost: async (url: string, body: any) => { server.posts.push({ url, body }); return { success: true, data: {} } },
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDel: async () => ({}),
}))
vi.mock('../components/EntityPicker', () => ({ EntityPicker: () => null }))
vi.mock('../components/dialogs', () => {
  const toast = () => {}
  ;(toast as any).error = () => {}
  return { toast, appConfirm: async () => true }
})

import { BankFeedPage } from './BankFeedPage'

let host: HTMLDivElement
let root: Root

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host)
    root.render(<MemoryRouter><QueryClientProvider client={qc}><BankFeedPage /></QueryClientProvider></MemoryRouter>)
  })
  await flush()
}

const buttons = (text: string | RegExp) => [...host.querySelectorAll('button')]
  .filter(b => (typeof text === 'string' ? b.textContent?.includes(text) : text.test(b.textContent ?? '')))
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
  await flush()
}

const line = (o: Record<string, unknown>) => ({
  connectionName: 'Test Bank ••1111', postedDate: '2026-10-06', currency: 'usd', landlordId: 'L1', suggestedCategory: null,
  normalizedMerchant: null, description: null, ...o,
})

beforeEach(() => {
  server.txns = []
  server.matches = {}
  server.posts = []
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('money coming in: nothing is filled in by a guess', () => {
  it('starts with no place; the place the payer’s last deposit went is a button that fills it only when pressed', async () => {
    server.txns = [line({
      id: 't1', amount: 120, status: 'needs_review', normalizedMerchant: 'CITY LAUNDRY', description: 'CITY LAUNDRY',
      suggestedCategory: 'laundry', suggestedScopeKind: 'unit', suggestedPropertyId: 'p1', suggestedUnitId: 'u5',
    })]
    await render()
    const where = host.querySelector('select[aria-label="Where it goes"]') as HTMLSelectElement
    expect(where.value).toBe('')
    const same = buttons('Same place as last time')
    expect(same.map(b => b.textContent)).toEqual(['Same place as last time: Unit 5, Oak Park'])
    expect(same[0].className).toContain('btn-primary')
    await click(same[0])
    expect((host.querySelector('select[aria-label="Where it goes"]') as HTMLSelectElement).value).toBe('unit')
    expect(buttons('Same place as last time')).toEqual([])
  })

  it('a deposit of a GAM payout’s amount whose memo does not name GAM is offered as that payout; the person matches it', async () => {
    server.txns = [line({
      id: 't2', amount: 400.26, status: 'needs_review', description: 'ST-G5D4S5T9R5P7 TRANSFER OAK PARK MOTEL A CORPORATE ACH',
      payoutSuggestion: { id: 'd1', amount: 400.26, sentOn: '2026-10-05' },
    })]
    await render()
    expect(host.textContent).toContain('GAM’s payout of $400.26 sent 2026-10-05 fits this deposit.')
    await click(buttons('Match it to that payout')[0])
    expect(server.posts).toEqual([{ url: '/bank-feed/transactions/t2/match-payout', body: { disbursementId: 'd1', entityId: '' } }])
  })
})

/** 10/14 follow-up: what the server says beside a payment GAM cannot take back (returnedCheck whatInstead). */
const OFFICE_LOGGED = 'GAM cannot take back a payment the office logged by hand yet, so the bills it paid stay paid and no fee is billed (Undo this match on that deposit would not change that). Contact GAM support to have it taken back.'

describe('a check the bank returned', () => {
  it('“What did this pay?” lists the checks of its amount; the owner picks the one that bounced', async () => {
    server.txns = [line({ id: 't3', amount: -460, status: 'needs_review', description: 'RETURNED DEPOSIT ITEM' })]
    server.matches.t3 = {
      expenses: [], checks: [], records: [], returnedLine: true,
      returnedChecks: [
        { remittanceId: 'r1', method: 'check', amount: 460, depositedOn: '2026-10-01', tenantName: 'Rosa Tenant', spaces: 'Unit 5', tenantDeposit: false },
        { remittanceId: 'r2', method: 'bank_deposit', amount: 460, depositedOn: '2026-10-02', tenantName: 'Sam Tenant', spaces: 'Unit 6', tenantDeposit: true,
          takeBackHere: false, whyNot: OFFICE_LOGGED },
      ],
    }
    await render()
    await click(buttons('What did this pay?')[0])
    expect(host.textContent).toContain('If this is a check or money order your bank returned, pick the one that came back:')
    expect(host.textContent).toContain('Rosa Tenant (Unit 5) · Check · $460.00 · deposited 2026-10-01')
    // 10/14 follow-up: one GAM cannot take back says what the owner can do instead (the server's words).
    expect(host.textContent).toContain(OFFICE_LOGGED)
    expect(host.textContent).not.toContain('Use Undo this match on that deposit')
    expect(buttons('This one bounced')).toHaveLength(1)
    await click(buttons('This one bounced')[0])
    expect(server.posts).toEqual([{ url: '/bank-feed/transactions/t3/returned-check', body: { remittanceId: 'r1', entityId: '' } }])
  })

  it('on a line that does not speak of a return, the checks are one press away, never open by themselves', async () => {
    server.txns = [line({ id: 't5', amount: -460, status: 'needs_review', description: 'HOME DEPOT #9 AZ' })]
    server.matches.t5 = {
      expenses: [], checks: [], records: [], returnedLine: false,
      returnedChecks: [{ remittanceId: 'r1', method: 'check', amount: 460, depositedOn: '2026-10-01', tenantName: 'Rosa Tenant', spaces: 'Unit 5', tenantDeposit: false }],
    }
    await render()
    await click(buttons('What did this pay?')[0])
    expect(buttons('This one bounced')).toEqual([])
    await click(buttons('Was this a check or money order your bank returned?')[0])
    expect(buttons('This one bounced')).toHaveLength(1)
    expect(server.posts).toEqual([])
  })

  it('a tenant’s own bank deposit GAM matched is picked like a check; one the office logged by hand says GAM cannot take it back', async () => {
    server.txns = [line({ id: 't6', amount: -460, status: 'needs_review', description: 'RETURNED DEPOSIT ITEM' })]
    server.matches.t6 = {
      expenses: [], checks: [], records: [], returnedLine: true,
      returnedChecks: [
        { remittanceId: 'r3', method: 'check', amount: 460, depositedOn: '2026-10-03', tenantName: 'Dee Tenant', spaces: 'Unit 7', tenantDeposit: true, takeBackHere: true },
        { remittanceId: 'r4', method: 'bank_deposit', amount: 460, depositedOn: '2026-10-04', tenantName: 'Sam Tenant', spaces: 'Unit 6', tenantDeposit: true, takeBackHere: false,
          whyNot: OFFICE_LOGGED },
      ],
    }
    await render()
    await click(buttons('What did this pay?')[0])
    expect(host.textContent).toContain('Dee Tenant (Unit 7) · Their own bank deposit (a check) · $460.00 · deposited 2026-10-03')
    expect(host.textContent).toContain('Sam Tenant (Unit 6) · Their own bank deposit · $460.00')
    expect(host.textContent).toContain(OFFICE_LOGGED)
    expect(buttons('This one bounced')).toHaveLength(1)
    await click(buttons('This one bounced')[0])
    expect(server.posts).toEqual([{ url: '/bank-feed/transactions/t6/returned-check', body: { remittanceId: 'r3', entityId: '' } }])
  })

  it('a money order, and a tenant’s own deposit, GAM took back say what they were; the deposit line says it came back and is not undone there', async () => {
    server.txns = [
      line({
        id: 't7', amount: -300, status: 'matched', description: 'RETURNED MONEY ORDER', matchKind: 'returned_check',
        returnedCheckMethod: 'money_order', returnedCheckFee: 15, returnedCheckFeeFrom: 'bank', returnedCheckTenantName: 'Mo Tenant', canUndo: true,
      }),
      line({
        id: 't8', amount: -460, status: 'matched', description: 'DEPOSITED ITEM RETURNED', matchKind: 'returned_check',
        returnedCheckMethod: 'check', returnedCheckFromDeposit: true, returnedCheckFeeFrom: 'later', returnedCheckTenantName: 'Dee Tenant', canUndo: true,
      }),
      line({
        id: 't9', amount: 460, status: 'matched', description: 'MOBILE DEPOSIT', matchKind: 'tenant_deposit',
        matchedTenantName: 'Dee Tenant', matchedUnitNumber: 'Unit 7', cameBackOn: '2026-10-12', canUndo: false,
      }),
    ]
    await render()
    // 10/14 follow-up: a money order is not headed "Returned check".
    expect(host.textContent).toContain('Returned money order — GAM took back Mo Tenant’s money order; the bills it paid are owed again, and a $15.00 returned-payment fee was billed to them.')
    expect(host.textContent).toContain('Returned check — GAM took back Dee Tenant’s own bank deposit (a check); the bills it paid are owed again, and the returned-check fee is billed to them when your bank’s fee for it shows.')
    expect(host.textContent).toContain('Tenant’s bank deposit — it came back: your bank returned it on 2026-10-12, and GAM took it back off Unit 7 · Dee Tenant’s bills.')
    // Undo on the two returned lines only.
    expect(buttons('Undo this match')).toHaveLength(2)
  })

  // 10/14 follow-up (Nic 10/12: "every bank filing (hand-filed too) can be undone").
  it('a Stripe ACH payout GAM matched by its trace code offers Undo', async () => {
    server.txns = [line({
      id: 't10', amount: 400.26, status: 'matched', description: 'ST-G5D4S5T9R5P7 TRANSFER OAK PARK MOTEL A CORPORATE ACH',
      matchKind: 'gam_payout', matchedDisbursementId: 'd1', canUndo: true,
    })]
    await render()
    await click(buttons('Undo this match')[0])
    expect(server.posts).toEqual([{ url: '/bank-feed/deposits/t10/undo', body: { entityId: '' } }])
  })

  it('a returned check GAM took back says so, and can be undone', async () => {
    server.txns = [line({
      id: 't4', amount: -460, status: 'matched', description: 'RETURNED DEPOSIT ITEM', matchKind: 'returned_check',
      returnedCheckFee: 25, returnedCheckFeeFrom: 'bank', returnedCheckTenantName: 'Rosa Tenant', canUndo: true,
    })]
    await render()
    expect(host.textContent).toContain('Returned check — GAM took back Rosa Tenant’s check; the bills it paid are owed again, and a $25.00 returned-check fee was billed to them.')
    await click(buttons('Undo this match')[0])
    expect(server.posts).toEqual([{ url: '/bank-feed/deposits/t4/undo', body: { entityId: '' } }])
  })
})
