import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { candidatesForDeposit } from './bankDepositCandidates'
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

  it('combines charges that add up — rent plus last month’s late fee', () => {
    const m = matchDeposit({ amount: 260, postedDate: '2026-09-03', description: 'DEPOSIT' }, [
      charge({ id: 'rent', leaseId: 'L', amount: 250, type: 'rent' }),
      charge({ id: 'fee', leaseId: 'L', amount: 10, type: 'fee', dueDate: '2026-09-01' }),
    ])
    expect(m[0].chargeIds.sort()).toEqual(['fee', 'rent'])
    expect(m[0].total).toBe(260)
  })

  // S655 (money plan §3): the combination paying the OLDEST lines wins; the
  // number of lines only breaks a tie. (It used to be fewest lines first,
  // which paid this month's $100 and left July and August open.)
  it('the oldest lines win; fewest lines only breaks ties', () => {
    const m = matchDeposit({ amount: 100, postedDate: '2026-09-03', description: 'DEPOSIT' }, [
      charge({ id: 'one', leaseId: 'L', amount: 100, dueDate: '2026-09-01' }),
      charge({ id: 'half-a', leaseId: 'L', amount: 50, dueDate: '2026-08-01' }),
      charge({ id: 'half-b', leaseId: 'L', amount: 50, dueDate: '2026-07-01' }),
    ])
    expect(m[0].chargeIds).toEqual(['half-b', 'half-a'])
    expect(m[0].exact).toBe(true)

    // Same due date: rent alone, not water + home payment that add up to the same.
    const tie = matchDeposit({ amount: 450, postedDate: '2026-10-03', description: 'DEPOSIT' }, [
      charge({ id: 'rent', leaseId: 'L', amount: 450, dueDate: '2026-10-01', type: 'rent' }),
      charge({ id: 'water', leaseId: 'L', amount: 165, dueDate: '2026-10-01', type: 'utility' }),
      charge({ id: 'home', leaseId: 'L', amount: 285, dueDate: '2026-10-01', type: 'home_payment' }),
    ])
    expect(tie[0].chargeIds).toEqual(['rent'])
  })

  it('the old carried balance comes after every current bill, however old it is', () => {
    const m = matchDeposit({ amount: 100, postedDate: '2026-09-03', description: 'DEPOSIT' }, [
      charge({ id: 'arrears', leaseId: 'L', amount: 100, dueDate: '2025-01-01', type: 'carried_balance' }),
      charge({ id: 'rent', leaseId: 'L', amount: 100, dueDate: '2026-09-01', type: 'rent' }),
    ])
    expect(m[0].chargeIds).toEqual(['rent'])
  })

  // Country Acres, MH 21: rent $450, water $165 and the $200 home payment were
  // open — exactly the $815 deposit.
  it('MH 21: an $815 deposit settles rent, utility and home payment', () => {
    const m = matchDeposit({ amount: 815, postedDate: '2026-09-05', description: 'DEPOSIT' }, [
      charge({ id: 'rent', leaseId: 'L', amount: 450, dueDate: '2026-09-01', type: 'rent' }),
      charge({ id: 'water', leaseId: 'L', amount: 165, dueDate: '2026-09-01', type: 'utility' }),
      charge({ id: 'home', leaseId: 'L', amount: 200, dueDate: '2026-09-01', type: 'home_payment' }),
    ])
    expect(m).toHaveLength(1)
    expect(m[0].chargeIds).toEqual(['rent', 'water', 'home'])
    expect(m[0]).toMatchObject({ total: 815, owed: 815, exact: true, confidence: 'amount_unique' })
    expect(isPreselectable(m[0])).toBe(true)
  })

  it('a short deposit says what it covers of what is owed', () => {
    const m = matchDeposit({ amount: 450, postedDate: '2026-09-05', description: 'DEPOSIT' }, [
      charge({ id: 'rent', leaseId: 'L', amount: 450, dueDate: '2026-09-01', type: 'rent' }),
      charge({ id: 'home', leaseId: 'L', amount: 365, dueDate: '2026-09-15', type: 'home_payment' }),
    ])
    expect(m[0].chargeIds).toEqual(['rent'])
    expect(m[0]).toMatchObject({ total: 450, owed: 815 })
    expect(m[0].reason).toContain('covers $450.00 of $815.00 owed')
  })

  // Standing directive: rent is pay-in-full. Offering a short deposit against
  // rent would teach the landlord to expect something the payment path refuses.
  it('never offers a short deposit against rent', () => {
    const m = matchDeposit({ amount: 200, postedDate: '2026-09-03', description: 'DEPOSIT' },
      [charge({ id: 'a', amount: 250, type: 'rent' })])
    expect(m).toHaveLength(0)
  })

  // S652 (Nic): a deposit that matches nobody's amount, name or report is
  // offered to nobody — "every single transaction is going to be Mobile Home
  // 2's rent" was this guess firing on a carried balance.
  it('offers nothing for a short deposit against a carried balance', () => {
    const m = matchDeposit({ amount: 200, postedDate: '2026-09-03', description: 'DEPOSIT' },
      [charge({ id: 'a', amount: 1000, type: 'carried_balance' })])
    expect(m).toHaveLength(0)
  })

  // S655: what it would pay is the oldest whole lines within the deposit; the
  // rest would be paid-ahead money. Never pre-selected.
  it('surfaces a named tenant even when the amount does not tie out', () => {
    const m = matchDeposit(
      { amount: 300, postedDate: '2026-09-03', description: 'MOBILE DEPOSIT GARCIA' },
      [charge({ id: 'a', amount: 250, tenantName: 'Rosa Garcia' })])
    expect(m[0].confidence).toBe('named_partial')
    expect(m[0].chargeIds).toEqual(['a'])
    expect(m[0]).toMatchObject({ total: 250, owed: 250, exact: false })
    expect(m[0].reason).toContain('$50.00 as paid-ahead money')
    expect(isPreselectable(m[0])).toBe(false)
  })

  it('a named deposit smaller than the oldest line proposes nothing to settle', () => {
    const m = matchDeposit(
      { amount: 100, postedDate: '2026-09-03', description: 'MOBILE DEPOSIT GARCIA' },
      [charge({ id: 'a', amount: 250, tenantName: 'Rosa Garcia' })])
    expect(m[0].chargeIds).toEqual([])
    expect(m[0].reason).toContain('covers $0.00 of $250.00 owed')
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

  // S655 HIGH (decisions #11): a report settled the tenant's WHOLE open
  // balance when no set of charges added up to it — a $300 report paid $750
  // of bills. Now: reviewed with "covers $X of $Y owed", never pre-selected,
  // never settled by itself.
  it('no fallback to all charges: a report that adds up to nothing is only reviewed', () => {
    const lease = [
      charge({ id: 'rent', leaseId: 'L', tenantId: 'T', amount: 250, dueDate: '2026-09-01', type: 'rent' }),
      charge({ id: 'old', leaseId: 'L', tenantId: 'T', amount: 500, dueDate: '2026-01-01', type: 'carried_balance' }),
    ]
    const m = matchDeposit({ amount: 300, postedDate: '2026-09-04', description: 'CASH DEPOSIT' }, lease,
      { declarations: [decl({ leaseId: 'L', tenantId: 'T', amount: 300 })] })
    expect(m).toHaveLength(1)
    expect(m[0].confidence).toBe('declared')
    expect(m[0].exact).toBe(false)
    expect(m[0].chargeIds).toEqual(['rent'])          // oldest whole lines within $300 — never the $500
    expect(m[0].total).toBe(250)
    expect(m[0].reason).toContain('covers $250.00 of $750.00 owed')
    expect(isPreselectable(m[0])).toBe(false)
  })

  it('a report settles only the set of charges that adds up to it, oldest first', () => {
    const lease = [
      charge({ id: 'aug', leaseId: 'L', tenantId: 'T', amount: 450, dueDate: '2026-08-01', type: 'rent' }),
      charge({ id: 'sep', leaseId: 'L', tenantId: 'T', amount: 450, dueDate: '2026-09-01', type: 'rent' }),
      charge({ id: 'water', leaseId: 'L', tenantId: 'T', amount: 30, dueDate: '2026-09-01', type: 'utility' }),
    ]
    const m = matchDeposit({ amount: 480, postedDate: '2026-09-04', description: 'CASH DEPOSIT' }, lease,
      { declarations: [decl({ leaseId: 'L', tenantId: 'T', amount: 480 })] })
    expect(m[0]).toMatchObject({ confidence: 'declared', exact: true, total: 480, owed: 930 })
    expect(m[0].chargeIds).toEqual(['aug', 'water'])
    expect(m[0].reason).toContain('covers $480.00 of $930.00 owed')
    expect(isPreselectable(m[0])).toBe(true)
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

// ── The candidate query (services/bankDepositCandidates) ─────────────────────
// S655 (money plan §3): the BANK-PAYABLE rows only — the set the desk and a
// posted payment may settle. Home payments and the old carried balance are
// in; GAM's own charges, work-trade lines and lines whose money is already on
// its way are never candidates.
describe('which open charges a deposit can be matched to', () => {
  beforeEach(cleanupAllSchema)

  async function stack() {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 450 })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      return { landlordId, tenantId, unitId, leaseId }
    } finally { client.release() }
  }

  async function row(s: Awaited<ReturnType<typeof stack>>, o: {
    type: string; amount: number; entry?: string; owner?: string; status?: string; intent?: string | null; workTrade?: boolean
  }): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, revenue_owner, stripe_payment_intent_id, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-09-01',$8,$9,$10, CASE WHEN $11 THEN NOW() ELSE NULL END) RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId, o.type, o.amount.toFixed(2), o.status ?? 'pending',
       o.entry ?? o.type.toUpperCase(), o.owner ?? 'landlord', o.intent ?? null, o.workTrade === true])).rows[0].id
  }

  it('MH 21: an $815 deposit settles rent, utility and home payment', async () => {
    const s = await stack()
    const ids = [
      await row(s, { type: 'rent', amount: 450, entry: 'RENT' }),
      await row(s, { type: 'utility', amount: 165, entry: 'UTILITY' }),
      await row(s, { type: 'home_payment', amount: 200, entry: 'HOMEPMT' }),
    ]
    const out = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 815, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect(out.candidates).toHaveLength(1)
    expect([...out.candidates[0].chargeIds].sort()).toEqual([...ids].sort())
    expect(out.candidates[0].exact).toBe(true)
  })

  it('work-trade, GAM-owned and in-flight lines are never candidates', async () => {
    const s = await stack()
    await row(s, { type: 'rent', amount: 100, entry: 'RENT', workTrade: true })                  // labor pays it
    await row(s, { type: 'fee', amount: 100, entry: 'RETURNFEE', owner: 'gam' })                 // GAM's own charge
    await row(s, { type: 'fee', amount: 100, entry: 'FLEXPAY', owner: 'gam' })                   // FlexPay's collection
    await row(s, { type: 'utility', amount: 100, entry: 'UTILITY', status: 'processing', intent: 'pi_clearing' })
    await row(s, { type: 'utility', amount: 100, entry: 'UTILITY', status: 'pending', intent: 'pi_in_flight' })
    const out = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 100, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect(out.candidates).toEqual([])

    // A failed line is still owed, so it is one.
    const failed = await row(s, { type: 'utility', amount: 100, entry: 'UTILITY', status: 'failed', intent: 'pi_bounced' })
    const again = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 100, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect(again.candidates[0].chargeIds).toEqual([failed])
  })

  it('a FlexDeposit installment GAM collects online is never a candidate; an ordinary security deposit is', async () => {
    const s = await stack()
    const recordId = (await db.query<{ id: string }>(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status)
       VALUES ($1,$2,$3,300,0,'landlord','pending') RETURNING id`, [s.unitId, s.leaseId, s.tenantId])).rows[0].id
    // A failed installment pull: payable again, a 'deposit' row the landlord's rule would take.
    const installment = await row(s, { type: 'deposit', amount: 100, entry: 'DEPOSIT', status: 'failed', intent: 'pi_installment' })
    const ask = () => candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 100, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect((await ask()).candidates[0].chargeIds).toEqual([installment])   // not FlexDeposit: it is one

    await db.query(`UPDATE security_deposits SET flex_deposit_enabled = TRUE, held_by = 'gam_escrow' WHERE id = $1`, [recordId])
    expect((await ask()).candidates).toEqual([])
  })

  it('a line credit already part-paid is matched at what is still owed in money', async () => {
    const s = await stack()
    const rent = await row(s, { type: 'rent', amount: 450, entry: 'RENT' })
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1,$2,$3,50,50,'goodwill','test') RETURNING id`, [s.landlordId, s.tenantId, s.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,50,'2026-09-01','desk','applied',NOW())`, [credit, rent, s.leaseId])
    const out = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 400, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect(out.candidates[0]).toMatchObject({ chargeIds: [rent], total: 400, exact: true })
  })
  // decisions #48.1 + #52: the owner's bank review never opens with a tenant
  // already picked for a transfer between accounts matched on amount alone.
  it('an amount-only match on a TRANSFER memo is never preselected; the same match on a plain DEPOSIT memo is', async () => {
    const s = await stack()
    await row(s, { type: 'rent', amount: 450, entry: 'RENT' })
    const ask = (description: string, normalized: string | null = null) => candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 450, posted_date: '2026-09-05', description, normalized_merchant: normalized,
    })
    const plain = await ask('DEPOSIT')
    expect(plain.transferMemo).toBe(false)
    expect(plain.candidates[0]).toMatchObject({ confidence: 'amount_unique', preselect: true })

    for (const memo of ['ONLINE TRANSFER FROM CHK 1234', 'XFER FROM SAVINGS 5678']) {
      const t = await ask(memo)
      expect(t.transferMemo).toBe(true)
      expect(t.candidates).toHaveLength(1)                       // still offered, for a deliberate pick
      expect(t.candidates[0]).toMatchObject({ confidence: 'amount_unique', preselect: false })
    }
    // The stored payer key alone saying TRANSFER is enough.
    expect((await ask('DEPOSIT', 'ONLINE TRANSFER')).candidates[0].preselect).toBe(false)
  })

  it('a tenant\'s own report the bank confirms is still preselected on a TRANSFER memo (more than the amount)', async () => {
    const s = await stack()
    await row(s, { type: 'rent', amount: 450, entry: 'RENT' })
    await db.query(
      `INSERT INTO tenant_declared_deposits (landlord_id, lease_id, tenant_id, amount, declared_date, method, status)
       VALUES ($1,$2,$3,450,'2026-09-05','cash','pending')`, [s.landlordId, s.leaseId, s.tenantId])
    const out = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 450, posted_date: '2026-09-05', description: 'ONLINE TRANSFER FROM CHK 1234',
    })
    expect(out.transferMemo).toBe(true)
    expect(out.candidates[0]).toMatchObject({ confidence: 'declared', preselect: true })
  })

  it('a match that is not preselectable (several tenants fit) is never preselected', async () => {
    const s = await stack()
    const t = await stack()
    await row(s, { type: 'rent', amount: 450, entry: 'RENT' })
    await row({ ...t, landlordId: s.landlordId }, { type: 'rent', amount: 450, entry: 'RENT' })
    const out = await candidatesForDeposit({
      id: 'txn', landlord_id: s.landlordId, amount: 450, posted_date: '2026-09-05', description: 'DEPOSIT',
    })
    expect(out.candidates.length).toBeGreaterThan(0)
    expect(out.candidates.every(c => c.preselect === false)).toBe(true)
  })
})
