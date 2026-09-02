/**
 * S626 — "who's outstanding" is three different answers, not one.
 *
 * Nic: "The $8 ACH was not stuck. It was paid. Money was already out of my bank
 * account, and the agent still told the landlord that person hadn't paid yet...
 * when they ask who's outstanding, it needs to just tell them who hasn't
 * attempted a payment yet. Or if a payment was returned — hey, this person
 * tried an ACH, it was returned."
 *
 * The tool returned one flat list of names and amounts, so a landlord could not
 * tell "never tried" from "tried and the bank sent it back", and money already
 * moving was invisible unless somebody thought to ask a second question. Nobody
 * asks a second question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../../db'
import { getDelinquentTenants } from './tools/getDelinquentTenants'
import { getMoneyInFlight } from './tools/getMoneyInFlight'
import { routePlan } from './toolRouting'

const ACTOR = { userId: 'u1', role: 'landlord', profileId: '', landlordIds: ['ll1'] } as any

const row = (over: Partial<any> = {}) => ({
  first_name: 'Frank', last_name: 'Williams', email: 'f@x.dev',
  overdue: '4840', items: '8', oldest_due: '2026-05-01',
  kind: 'never_attempted', return_reasons: null, last_attempt: null, ...over,
})

beforeEach(() => { vi.restoreAllMocks() })

describe('the two groups are reported separately', () => {
  it('splits a returned payment from a tenant who never tried', async () => {
    vi.spyOn(db, 'query')
      .mockResolvedValueOnce([
        row({ kind: 'never_attempted', first_name: 'Alice', overdue: '2330' }),
        row({ kind: 'returned', first_name: 'Frank', overdue: '4840',
              return_reasons: 'insufficient_funds', last_attempt: '2026-08-03' }),
      ] as any)
      .mockResolvedValueOnce([{ in_flight: null, payers: '0' }] as any)

    const r: any = await getDelinquentTenants.execute({}, ACTOR)
    expect(r.noPaymentAttempted).toHaveLength(1)
    expect(r.noPaymentAttempted[0].name).toBe('Alice Williams')
    expect(r.paymentReturned).toHaveLength(1)
    expect(r.paymentReturned[0]).toMatchObject({
      name: 'Frank Williams', theyDidTryToPay: true, bankReason: 'insufficient_funds',
    })
    // The two must never be handed back as one undifferentiated list.
    expect(r.delinquentTenants).toBeUndefined()
  })
})

describe('money already moving is never called overdue', () => {
  it('reports in-flight alongside the overdue figure, unprompted', async () => {
    vi.spyOn(db, 'query')
      .mockResolvedValueOnce([row()] as any)
      .mockResolvedValueOnce([{ in_flight: '8.00', payers: '1' }] as any)

    const r: any = await getDelinquentTenants.execute({}, ACTOR)
    expect(r.moneyInFlight).toEqual({ amount: 8, tenants: 1 })
    expect(r.note).toMatch(/\$8\.00/)
    expect(r.note).toMatch(/NOT overdue/i)
  })

  it('says so even when nobody is behind at all', async () => {
    vi.spyOn(db, 'query')
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([{ in_flight: '8.00', payers: '1' }] as any)

    const r: any = await getDelinquentTenants.execute({}, ACTOR)
    expect(r.count).toBe(0)
    expect(r.note).toMatch(/Nobody is past due/i)
    expect(r.note).toMatch(/still clearing/i)
  })

  it('in-flight reads ONLY processing — pending means nobody paid', () => {
    // The inverse error, and the more dangerous one: counting unpaid rent as
    // money on its way would tell a landlord to expect cash that is not coming.
    const sql = String(getMoneyInFlight.execute)
    expect(sql).toContain("'processing'")
  })
})

describe('asking what is coming does not return a list of debtors', () => {
  const LL = ['get_money_in_flight', 'get_delinquent_tenants', 'get_my_payouts']
  const t = (m: string) => routePlan(m, 'landlord' as any, LL).tools

  it.each([
    'has anyone paid that has not landed yet?',
    "what's coming?",
    'is any money still clearing?',
    'anything on the way?',
  ])('routes %j to the in-flight lookup', (m) => {
    expect(t(m)).toContain('get_money_in_flight')
  })

  it('still routes the debtor question to the debtor lookup', () => {
    expect(t('who is behind on rent?')).toContain('get_delinquent_tenants')
    expect(t('who owes me money?')).toContain('get_delinquent_tenants')
  })
})

/**
 * S626 — the same collapse, two more places. Found by asking "where else does a
 * tool read payments.status?" rather than by waiting for it to be reported.
 */
describe('the single-tenant lookup — "what is Chen\'s balance?"', () => {
  it('does NOT count money already clearing as owed', async () => {
    const { lookupTenantPaymentStatus } = await import('./tools/lookupTenantPaymentStatus')
    const src = String(lookupTenantPaymentStatus.execute)
    // S620 removed 'processing' from the LIST tool and left it here — the
    // quieter path, and the one a landlord uses to ask about one person.
    expect(src).toContain('IN_FLIGHT_STATUSES')
    expect(src).toContain('inFlight')
  })

  it('separates what they never paid from what came back', async () => {
    const { lookupTenantPaymentStatus } = await import('./tools/lookupTenantPaymentStatus')
    const src = String(lookupTenantPaymentStatus.execute)
    expect(src).toMatch(/ofWhichReturned/)
    expect(src).toMatch(/FILTER \(WHERE status IN \('failed','returned'\)\)/)
  })

  it('tells the agent the three figures are not interchangeable', async () => {
    const { lookupTenantPaymentStatus } = await import('./tools/lookupTenantPaymentStatus')
    expect(lookupTenantPaymentStatus.description).toMatch(/NOT owed/i)
    expect(lookupTenantPaymentStatus.description).toMatch(/returned/i)
  })
})

describe("the tenant's own balance", () => {
  it('counts a RETURNED payment as still owed', async () => {
    // paymentReversal.ts sets status='returned' with the bank's code when an
    // ACH comes back. It was missing from the tenant's balance, so a bounced
    // payment dropped out as though it had settled — the tenant is told they
    // owe less than they do and finds out when the late fee lands.
    const { getMyBalanceBreakdown } = await import('./tools/getMyBalanceBreakdown')
    const src = String(getMyBalanceBreakdown.execute)
    expect(src).toContain("'returned'")
  })

  it("still treats money in flight as PAID from the tenant's side", async () => {
    // The other direction, and it must not regress: the money has left their
    // account, so their balance drops immediately (S620).
    const { getMyBalanceBreakdown } = await import('./tools/getMyBalanceBreakdown')
    const src = String(getMyBalanceBreakdown.execute)
    expect(src).not.toMatch(/status IN \('pending', 'failed', 'returned', 'processing'\)/)
  })
})
