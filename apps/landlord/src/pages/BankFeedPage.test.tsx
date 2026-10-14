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

describe('a check the bank returned', () => {
  it('“What did this pay?” lists the checks of its amount; the owner picks the one that bounced', async () => {
    server.txns = [line({ id: 't3', amount: -460, status: 'needs_review', description: 'RETURNED DEPOSIT ITEM' })]
    server.matches.t3 = {
      expenses: [], checks: [], records: [], returnedLine: true,
      returnedChecks: [
        { remittanceId: 'r1', method: 'check', amount: 460, depositedOn: '2026-10-01', tenantName: 'Rosa Tenant', spaces: 'Unit 5', tenantDeposit: false },
        { remittanceId: 'r2', method: 'bank_deposit', amount: 460, depositedOn: '2026-10-02', tenantName: 'Sam Tenant', spaces: 'Unit 6', tenantDeposit: true },
      ],
    }
    await render()
    await click(buttons('What did this pay?')[0])
    expect(host.textContent).toContain('If this is a check your bank returned, pick the one that bounced:')
    expect(host.textContent).toContain('Rosa Tenant (Unit 5) · Check · $460.00 · deposited 2026-10-01')
    expect(host.textContent).toContain('Use Undo this match on that deposit')
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
    await click(buttons('Was this a check your bank returned?')[0])
    expect(buttons('This one bounced')).toHaveLength(1)
    expect(server.posts).toEqual([])
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
