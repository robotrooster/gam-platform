import { describe, it, expect } from 'vitest'
import {
  matchDeposit, memoNamesTenant, memoNameTokens, isPreselectable,
  memoMethodHint, methodContradicts,
  type OpenCharge, type TenantDeclaredDeposit,
} from './bankDepositMatch'

const charge = (o: Partial<OpenCharge> & { id: string }): OpenCharge => ({
  leaseId: `lease-${o.id}`, tenantId: `tenant-${o.id}`, tenantName: 'Pat Rivera',
  unitNumber: 'Lot 1', amount: 250, dueDate: '2026-09-01', type: 'rent', ...o,
})

/** The park that prompted the feature: N lots, identical rent, all cash. */
const identicalPark = (n: number) =>
  Array.from({ length: n }, (_, i) => charge({
    id: `c${i}`, leaseId: `lease-${i}`, tenantId: `t${i}`,
    tenantName: `${['Rosa Garcia','Dale Whitcomb','Ana Perkins','Ivan Kozlov','Mae Okonkwo'][i % 5]} ${i}`,
    unitNumber: `Lot ${i + 1}`, amount: 250,
  }))

describe('memo name extraction', () => {
  it('strips deposit boilerplate and keeps the name', () => {
    expect(memoNameTokens('MOBILE DEPOSIT R GARCIA')).toEqual(['GARCIA'])
    expect(memoNameTokens('ATM CASH DEPOSIT 07/12')).toEqual([])
    expect(memoNameTokens('REMOTE DEP CHK THOMPSON')).toEqual(['THOMPSON'])
  })

  it('matches on a surname alone — a check memo rarely keeps the full name', () => {
    expect(memoNamesTenant('MOBILE DEPOSIT R GARCIA', 'Rosa Garcia')).toBe(true)
    expect(memoNamesTenant('MOBILE DEPOSIT GARCIA', 'Rosa Garcia')).toBe(true)
    expect(memoNamesTenant('MOBILE DEPOSIT', 'Rosa Garcia')).toBe(false)
  })

  it('does not let boilerplate become a name', () => {
    // "CASH" must never match a tenant surnamed Cash-adjacent by accident, and
    // more importantly a bare cash deposit must name nobody.
    expect(memoNamesTenant('CASH DEPOSIT', 'Cash Register')).toBe(false)
  })
})

describe('matching a deposit', () => {
  it('ties a lone exact charge and marks it unambiguous', () => {
    const m = matchDeposit({ amount: 250, postedDate: '2026-09-03', description: 'DEPOSIT' },
      [charge({ id: 'a' })])
    expect(m).toHaveLength(1)
    expect(m[0].confidence).toBe('amount_unique')
    expect(m[0].rivals).toBe(0)
    expect(isPreselectable(m[0])).toBe(true)
  })

  // THE CASE THE FEATURE EXISTS FOR. A cash deposit carries no payer, and in
  // this park every tenant owes the identical amount. Confidently picking one
  // would book a stranger's money onto someone's rent record.
  it('refuses to pick a winner when every lot owes the same rent', () => {
    const m = matchDeposit({ amount: 250, postedDate: '2026-09-03', description: 'CASH DEPOSIT' },
      identicalPark(25))
    expect(m.length).toBeGreaterThan(1)
    for (const row of m) {
      expect(row.confidence).toBe('amount_ambiguous')
      expect(row.rivals).toBe(24)
      expect(isPreselectable(row)).toBe(false)
      expect(row.reason).toContain('Confirm who paid')
    }
  })

  it('a named check cuts straight through that ambiguity', () => {
    // Only ONE lot's tenant is a Kozlov, so the name is an identification.
    const park = identicalPark(5)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-03', description: 'REMOTE DEP CHK KOZLOV' },
      park)
    expect(m[0].confidence).toBe('named_exact')
    expect(m[0].tenantName).toContain('Kozlov')
    expect(isPreselectable(m[0])).toBe(true)
  })

  // REGRESSION (S624): a name that fits SEVERAL tenants is not an
  // identification. Before the fix, "GARCIA" against two Garcias produced a
  // confident, pre-selected match on whichever sorted first — booking one
  // tenant's cash onto the other's rent record, and then onto their credit file.
  it('will not pre-select when the memo name fits more than one tenant', () => {
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-03', description: 'MOBILE DEPOSIT GARCIA' },
      [
        charge({ id: 'a', leaseId: 'L1', tenantId: 'T1', tenantName: 'Rosa Garcia',  unitNumber: 'Lot 3' }),
        charge({ id: 'b', leaseId: 'L2', tenantId: 'T2', tenantName: 'Hector Garcia', unitNumber: 'Lot 9' }),
      ])
    expect(m).toHaveLength(2)
    for (const row of m) {
      expect(isPreselectable(row)).toBe(false)
      expect(row.rivals).toBe(1)
      expect(row.reason).toContain('Confirm who paid')
    }
  })

  it('combines charges that add up — rent plus last month’s manual fee', () => {
    const m = matchDeposit({ amount: 260, postedDate: '2026-09-03', description: 'DEPOSIT' }, [
      charge({ id: 'rent', leaseId: 'L', amount: 250, type: 'rent' }),
      charge({ id: 'fee', leaseId: 'L', amount: 10, type: 'fee', dueDate: '2026-09-01' }),
    ])
    expect(m[0].chargeIds.sort()).toEqual(['fee', 'rent'])
    expect(m[0].total).toBe(260)
  })

  it('prefers the fewest charges when two combinations tie', () => {
    const m = matchDeposit({ amount: 100, postedDate: '2026-09-03', description: 'DEPOSIT' }, [
      charge({ id: 'one', leaseId: 'L', amount: 100, dueDate: '2026-09-01' }),
      charge({ id: 'half-a', leaseId: 'L', amount: 50, dueDate: '2026-08-01' }),
      charge({ id: 'half-b', leaseId: 'L', amount: 50, dueDate: '2026-07-01' }),
    ])
    expect(m[0].chargeIds).toEqual(['one'])
  })

  // Standing directive: rent is pay-in-full. Offering a short deposit against
  // rent would teach the landlord to expect something the payment path refuses.
  it('never offers a short deposit against rent', () => {
    const m = matchDeposit({ amount: 200, postedDate: '2026-09-03', description: 'DEPOSIT' },
      [charge({ id: 'a', amount: 250, type: 'rent' })])
    expect(m).toHaveLength(0)
  })

  it('does offer a short deposit against a carried balance, which is partially payable', () => {
    const m = matchDeposit({ amount: 200, postedDate: '2026-09-03', description: 'DEPOSIT' },
      [charge({ id: 'a', amount: 1000, type: 'carried_balance' })])
    expect(m).toHaveLength(1)
    expect(m[0].confidence).toBe('carried_paydown')
    expect(isPreselectable(m[0])).toBe(false)
  })

  it('surfaces a named tenant even when the amount does not tie out', () => {
    const m = matchDeposit(
      { amount: 300, postedDate: '2026-09-03', description: 'MOBILE DEPOSIT GARCIA' },
      [charge({ id: 'a', amount: 250, tenantName: 'Rosa Garcia' })])
    expect(m[0].confidence).toBe('named_partial')
    expect(m[0].chargeIds).toEqual([])
    expect(isPreselectable(m[0])).toBe(false)
  })

  it('never proposes a combination spanning two tenants', () => {
    // $500 could be Lot 1 + Lot 2 together. That is a SPLIT the landlord
    // allocates, not a match — guessing it would put one tenant's money on
    // another's ledger.
    const m = matchDeposit({ amount: 500, postedDate: '2026-09-03', description: 'CASH DEPOSIT' },
      identicalPark(2))
    expect(m).toHaveLength(0)
  })

  it('returns nothing for an outflow or an empty ledger', () => {
    expect(matchDeposit({ amount: -50, postedDate: '2026-09-03', description: 'X' },
      [charge({ id: 'a' })])).toEqual([])
    expect(matchDeposit({ amount: 250, postedDate: '2026-09-03', description: 'X' }, []))
      .toEqual([])
  })

  it('falls back to a whole-balance check rather than searching a broken ledger', () => {
    // 20 open charges on one lease is a broken ledger, not a matching problem.
    // The guard must not hang, and must still catch "they paid everything".
    const many = Array.from({ length: 20 }, (_, i) =>
      charge({ id: `x${i}`, leaseId: 'L', tenantId: 'T', amount: 10, dueDate: `2026-0${(i % 9) + 1}-01` }))
    const t0 = Date.now()
    const m = matchDeposit({ amount: 200, postedDate: '2026-09-03', description: 'DEPOSIT' }, many)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(m[0].chargeIds).toHaveLength(20)
  })
})

// S624 (Nic): "let's build an option that gives the landlord minimal work to
// do" for properties where utilities are included and every rent is identical.
// A tenant declaration is that option — and the work it leaves the landlord is
// none.
describe('a tenant declaring their own deposit', () => {
  const decl = (o: Partial<TenantDeclaredDeposit> & { leaseId: string }): TenantDeclaredDeposit => ({
    id: `d-${o.leaseId}`, tenantId: `t-${o.leaseId}`, amount: 250,
    declaredDate: '2026-09-03', method: 'cash', ...o,
  })

  it('cuts through a 25-way tie with no landlord input at all', () => {
    const park = identicalPark(25)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-04', description: 'CASH DEPOSIT' },
      park,
      { declarations: [decl({ leaseId: 'lease-7', tenantId: 't7' })] })
    expect(m[0].confidence).toBe('declared')
    expect(m[0].leaseId).toBe('lease-7')
    expect(isPreselectable(m[0])).toBe(true)
    // The other 24 are still offered as a fallback, but none outranks the claim.
    expect(m.slice(1).every(r => r.confidence !== 'declared')).toBe(true)
  })

  it('accepts a posting lag but not an unrelated month', () => {
    const park = identicalPark(3)
    const near = matchDeposit(
      { amount: 250, postedDate: '2026-09-07', description: 'CASH DEPOSIT' },
      park, { declarations: [decl({ leaseId: 'lease-1', tenantId: 't1', declaredDate: '2026-09-03' })] })
    expect(near[0].confidence).toBe('declared')

    const far = matchDeposit(
      { amount: 250, postedDate: '2026-10-03', description: 'CASH DEPOSIT' },
      park, { declarations: [decl({ leaseId: 'lease-1', tenantId: 't1', declaredDate: '2026-09-03' })] })
    expect(far.every(r => r.confidence !== 'declared')).toBe(true)
  })

  it('a wrong amount is not a confirmation', () => {
    const park = identicalPark(3)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-04', description: 'CASH DEPOSIT' },
      park, { declarations: [decl({ leaseId: 'lease-1', tenantId: 't1', amount: 300 })] })
    expect(m.every(r => r.confidence !== 'declared')).toBe(true)
  })

  it('two tenants claiming the same figure is a 2-way choice, not a 25-way one', () => {
    const park = identicalPark(25)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-04', description: 'CASH DEPOSIT' },
      park, {
        declarations: [
          decl({ leaseId: 'lease-2', tenantId: 't2' }),
          decl({ leaseId: 'lease-9', tenantId: 't9' }),
        ],
      })
    const top = m.filter(r => r.rivals === 1)
    expect(top).toHaveLength(2)
    for (const row of top) {
      expect(isPreselectable(row)).toBe(false)
      expect(row.reason).toContain('Confirm who paid')
    }
  })
})

describe('the instrument the tenant states, against the one the bank describes', () => {
  it('reads a mobile deposit as a check — you cannot photograph cash', () => {
    expect(memoMethodHint('MOBILE DEPOSIT')).toBe('check')
    expect(memoMethodHint('REMOTE DEP CHK 4471')).toBe('check')
    expect(memoMethodHint('ATM CASH DEPOSIT')).toBe('cash')
    expect(memoMethodHint('DEPOSIT')).toBeNull()
  })

  it('treats a money order like a check, not like cash', () => {
    expect(methodContradicts('money_order', 'MOBILE DEPOSIT')).toBe(false)
    expect(methodContradicts('money_order', 'ATM CASH DEPOSIT')).toBe(true)
  })

  it('a silent memo never contradicts anybody', () => {
    expect(methodContradicts('cash', 'DEPOSIT')).toBe(false)
    expect(methodContradicts('check', 'DEPOSIT')).toBe(false)
  })

  // Nic: "just in case two dollar amounts happen to be exactly matching."
  it('separates two identical claims when only one instrument fits', () => {
    const park = identicalPark(25)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-04', description: 'MOBILE DEPOSIT' },
      park, {
        declarations: [
          { id: 'd1', leaseId: 'lease-2', tenantId: 't2', amount: 250, declaredDate: '2026-09-03', method: 'cash' },
          { id: 'd2', leaseId: 'lease-9', tenantId: 't9', amount: 250, declaredDate: '2026-09-03', method: 'check' },
        ],
      })
    // The cash claim cannot be a mobile deposit; the check claim can.
    expect(m[0].confidence).toBe('declared')
    expect(m[0].leaseId).toBe('lease-9')
    expect(isPreselectable(m[0])).toBe(true)
  })

  it('falls back to both when the memo rules out everyone', () => {
    const park = identicalPark(25)
    const m = matchDeposit(
      { amount: 250, postedDate: '2026-09-04', description: 'ATM CASH DEPOSIT' },
      park, {
        declarations: [
          { id: 'd1', leaseId: 'lease-2', tenantId: 't2', amount: 250, declaredDate: '2026-09-03', method: 'check' },
          { id: 'd2', leaseId: 'lease-9', tenantId: 't9', amount: 250, declaredDate: '2026-09-03', method: 'money_order' },
        ],
      })
    // Both contradict the memo, so neither is silently dropped — the landlord
    // still gets the two claims to choose between.
    expect(m.filter(r => r.rivals === 1)).toHaveLength(2)
  })
})
