/**
 * The phrase table — does a wording land on the lookup that answers it?
 *
 * S618. These are the cases the table exists for, so they are asserted rather
 * than assumed. Two classes matter most:
 *
 *   ORDERING. "pet deposit" must reach the lease-fee rows, not the security
 *   deposit. The general route would swallow it if it sat first.
 *
 *   ONE vs ALL. A landlord asking about one tenant and a landlord asking who is
 *   behind are different lookups sharing the same vocabulary. Getting it
 *   backwards hands someone the whole delinquency list when they asked about
 *   one person.
 */

import { describe, it, expect } from 'vitest'
import { routeToTool, routeToTools, routePlan, ROUTES_FOR_TEST } from './toolRouting'

/** Every tool the tenant/landlord profiles actually hold in these tests. */
const TENANT_TOOLS = [
  'get_my_lease', 'get_my_deposit', 'get_my_lease_fees', 'get_my_balance_breakdown',
  'get_my_payment_methods', 'get_my_payments', 'get_my_maintenance_requests', 'get_my_invoices',
  'get_my_landlord_renewal_tendency', 'get_my_full_lease', 'log_complaint',
]
const LANDLORD_TOOLS = [
  'lookup_tenant_payment_status', 'get_delinquent_tenants', 'get_unit_lease',
  'get_late_payment_history', 'get_vacant_units', 'get_landlord_portfolio',
  'get_portfolio_stats', 'query_portfolio', 'get_open_complaints',
  'get_profit_and_loss',
  'get_lease_expirations', 'get_pending_maintenance', 'get_property_rent_roll',
]

const tenant = (m: string) => routeToTool(m, 'tenant', TENANT_TOOLS)
const landlord = (m: string) => routeToTool(m, 'landlord', LANDLORD_TOOLS)

describe('tenant phrasings', () => {
  // Nic's example: the word "pet" means go read the fee rows on THIS lease.
  it('sends anything pet-shaped to the lease fees, not the security deposit', () => {
    for (const m of [
      'how much is my pet deposit?',
      "what's the pet deposit",
      'do I pay pet rent',
      'is there a fee for my dog',
      'how much is the deposit for my cat',
      'whats my pet fee',
    ]) expect(tenant(m), m).toBe('get_my_lease_fees')
  })

  it('still sends the security deposit to the deposit lookup', () => {
    for (const m of [
      'how much was my security deposit?',
      "what's my deposit",
      'how much did I put down',
      'when do I get my deposit back',
    ]) expect(tenant(m), m).toBe('get_my_deposit')
  })

  it('routes the other named fees to the lease fees', () => {
    for (const m of [
      'how much is the cleaning fee',
      'what am I paying for parking',
      'is there a storage fee',
      'what other fees do I have',
    ]) expect(tenant(m), m).toBe('get_my_lease_fees')
  })

  it('routes money-owed questions to the balance', () => {
    for (const m of [
      'how much do I owe?',
      'what do I owe right now',
      "what's my balance",
      'do I owe anything?',
      'am I behind on anything',
      'how much do i need to pay',
    ]) expect(tenant(m), m).toBe('get_my_balance_breakdown')
  })

  // Nic: late fees vary "per property and per state and landlord" — so even the
  // general-sounding wording is a lookup on THIS lease, never an article.
  it('routes rent terms and late fees to the lease', () => {
    for (const m of [
      'how much is my rent?',
      'when is my rent due?',
      'when does my lease end?',
      'what is the late fee',
      "what's my grace period",
      'what happens if I pay rent late',
    ]) expect(tenant(m), m).toBe('get_my_lease')
  })

  it('separates "did my payment land" from "what do I owe"', () => {
    expect(tenant('did my last payment go through?')).toBe('get_my_payments')
    expect(tenant('did you get my payment')).toBe('get_my_payments')
    expect(tenant('how much do I owe?')).toBe('get_my_balance_breakdown')
  })

  it('routes saved-payment-method questions', () => {
    for (const m of [
      'what card do I have on file?',
      'is my bank account connected',
      'how am I set up to pay',
    ]) expect(tenant(m), m).toBe('get_my_payment_methods')
  })

  it('routes repair status', () => {
    for (const m of [
      'do I have any open maintenance requests?',
      "what's the status of my repair request",
      'any updates on the maintenance I reported',
    ]) expect(tenant(m), m).toBe('get_my_maintenance_requests')
  })
})

// Nic: "just because I say when is my lease over, or say something less
// specific, like — is my landlord gonna renew? that's gonna say okay, they
// should infer renewing the lease on expiration, pull up the lease."
describe('inferring what a vague question actually needs', () => {
  const both = (m: string) => routeToTools(m, 'tenant', TENANT_TOOLS)

  it('answers a renewal question with the lease AND the landlord\'s tendency', () => {
    for (const m of [
      'is my landlord gonna renew?',
      'will my lease be renewed?',
      'can I stay another year',
      'do they usually renew',
      'will my rent go up',
      'what happens when my lease ends',
    ]) {
      expect(both(m), m).toContain('get_my_lease')
      expect(both(m), m).toContain('get_my_landlord_renewal_tendency')
    }
  })

  it('answers "am I getting my deposit back" with the deposit AND the deductions', () => {
    for (const m of [
      'am I getting my deposit back',
      'how much of my deposit will I get back',
      'will they keep my deposit',
    ]) {
      expect(both(m), m).toContain('get_my_deposit')
      expect(both(m), m).toContain('get_my_lease_fees')
    }
  })

  it('drops a lookup the profile does not hold rather than the whole route', () => {
    // The lease still answers a renewal question where the tendency tool is
    // not granted.
    const only = routeToTools('is my landlord gonna renew?', 'tenant', ['get_my_lease'])
    expect(only).toEqual(['get_my_lease'])
  })
})

// Nic: "the agent should be able to pull up the full lease, read it, and answer
// any questions about the lease."
describe('reading the lease itself', () => {
  it('routes document questions to the full lease', () => {
    for (const m of [
      'according to my lease, am I getting my deposit back?',
      'what does my lease say about pets',
      'can you read my lease',
      'help me understand my lease',
      'am I allowed to sublet',
      'what am I actually paying each month',
    ]) expect(tenant(m), m).toBe('get_my_full_lease')
  })

  // A single named fee still takes the narrow route — a full-lease payload on
  // every fee question bloats a prompt this model already struggles with.
  it('leaves single-fact fee questions on the narrow route', () => {
    expect(tenant('how much is my pet deposit?')).toBe('get_my_lease_fees')
    expect(tenant('how much is my rent?')).toBe('get_my_lease')
  })
})

describe('landlord phrasings', () => {
  // The exact wording that flaked in the battery, plus its neighbours.
  it('routes ONE named tenant or unit to the single-tenant lookup', () => {
    for (const m of [
      "what's bob chen's balance",
      'is bob behind on rent?',
      'how much does bob owe',
      'how much does apt 101 owe',
      'is apt 101 current',
    ]) expect(landlord(m), m).toBe('lookup_tenant_payment_status')
  })

  it('routes the PLURAL version to the delinquency list', () => {
    for (const m of [
      'is anyone behind on rent?',
      "who hasn't paid",
      'show me delinquent tenants',
      'who is late this month',
      'which tenants owe me money',
    ]) expect(landlord(m), m).toBe('get_delinquent_tenants')
  })

  // Scored 1/4 in the battery with NO tool called on three of four wordings —
  // the tool was built in S617 and was effectively unreachable through the model.
  it('reaches the late-payment history, which the model would not pick on its own', () => {
    for (const m of [
      'how often do my tenants pay late',
      'do my tenants usually pay on time',
      'what does my late payment history look like',
      'how many late payments have I had',
    ]) expect(landlord(m), m).toBe('get_late_payment_history')
  })

  it('separates ONE unit\'s lease from what is expiring soon', () => {
    expect(landlord('when does the lease end for rv 8')).toBe('get_unit_lease')
    expect(landlord("what's the lease end date on rv 08")).toBe('get_unit_lease')
    expect(landlord('any leases expiring soon?')).toBe('get_lease_expirations')
    expect(landlord('which leases are ending')).toBe('get_lease_expirations')
  })

  it('routes vacancy and occupancy to their own lookups', () => {
    for (const m of ['how many units do I have vacant?', "what's vacant right now", 'which units are sitting empty'])
      expect(landlord(m), m).toBe('get_vacant_units')
    for (const m of ["what's my occupancy?", 'how many units are occupied', 'how full am I'])
      expect(landlord(m), m).toBe('get_landlord_portfolio')
  })

  it('routes maintenance waiting on the landlord', () => {
    for (const m of ['any maintenance waiting on me?', 'do I have repairs to approve', 'show me open work orders'])
      expect(landlord(m), m).toBe('get_pending_maintenance')
  })
})

// S618 (Nic): "I want the agent to be able to come up with answers to questions
// where any data is captured on the property."
describe('portfolio analytics', () => {
  // The landlord's task list vs a ranking — both use the word "complaint".
  it('separates the complaint LIST from the complaint RANKING', () => {
    for (const m of ['any open complaints?', 'what do I need to deal with', 'show me my complaints', 'is anyone unhappy'])
      expect(landlord(m), m).toBe('get_open_complaints')
    expect(landlord('who complains the most')).toBe('query_portfolio')
  })

  it('routes P&L questions to the shared income statement', () => {
    for (const m of [
      'show me my P&L',
      'what did I make last year',
      'am I profitable',
      'what were my expenses',
      'how much did I bring in',
    ]) expect(landlord(m), m).toBe('get_profit_and_loss')
  })

  it('routes RANKING questions to query_portfolio', () => {
    for (const m of [
      'who is my worst tenant',
      'who files the most maintenance requests',
      'which unit breaks the most',
      "who's the longest running tenancy",
      'who complains the most',
      'rank my properties by occupancy',
      'who owes the most',
      'who owes me the most',
      'who owes me the most money',
      'which of my tenants owes me the most',
      'my most problematic tenants',
    ]) expect(landlord(m), m).toBe('query_portfolio')
  })

  it('routes RATE and AVERAGE questions to get_portfolio_stats', () => {
    for (const m of [
      'what percentage of my tenants pay late',
      "what's my average rent",
      'how many of my tenants are on fixed income',
      'what percent of people break their lease early',
      'how old are my tenants',
      'how am I doing',
    ]) expect(landlord(m), m).toBe('get_portfolio_stats')
  })

  // The distinction that matters: a rate is one number, a ranking is names.
  it('keeps one-tenant questions on the single-tenant lookup', () => {
    expect(landlord('is bob behind on rent?')).toBe('lookup_tenant_payment_status')
    expect(landlord('is anyone behind on rent?')).toBe('get_delinquent_tenants')
  })
})

describe('the safety properties', () => {
  it('returns nothing when the table does not recognise the wording', () => {
    // Falls back to the runner's previous behaviour; must not guess.
    expect(tenant('what is FlexVault?')).toBeUndefined()
    expect(landlord('what is my property worth?')).toBeUndefined()
    expect(tenant('')).toBeUndefined()
  })

  it('never crosses the audience line', () => {
    // A tenant phrasing must not reach a landlord tool even when it matches
    // landlord-ish words, and vice versa — this is the product siloing.
    for (const r of ROUTES_FOR_TEST) {
      const pool = r.audience === 'tenant' ? TENANT_TOOLS : LANDLORD_TOOLS
      for (const t of r.tools) expect(pool, `${t} missing from its own audience pool`).toContain(t)
    }
    expect(routeToTool('how many units do I have vacant?', 'tenant', TENANT_TOOLS)).toBeUndefined()
    expect(routeToTool('how much do I owe?', 'landlord', LANDLORD_TOOLS)).toBeUndefined()
  })

  it('never names a tool the profile does not hold', () => {
    // S617 hit this the other way round: a landlord agent was told to call
    // tenant tools and could not comply.
    expect(routeToTool('how much do I owe?', 'tenant', ['get_my_lease'])).toBeUndefined()
    expect(routeToTool("what's bob chen's balance", 'landlord', ['get_vacant_units'])).toBeUndefined()
  })

  it('every route names a tool that is spelled like a real tool', () => {
    for (const r of ROUTES_FOR_TEST) {
      for (const t of r.tools) expect(t, t).toMatch(/^[a-z][a-z0-9_]+$/)
      expect(r.tools.length, 'route has no tools').toBeGreaterThan(0)
      expect(r.patterns.length, `${r.tools[0]} has no patterns`).toBeGreaterThan(0)
    }
  })
})

// ── S618: the wording says WHO, so read it ───────────────────────────────
//
// Measured in both orderings, consistently: the model calls the tenant lookup
// for "is bob behind on rent?" and refuses for "how much does apt 101 owe" and
// "what's bob chen's balance". The tool accepts "Apt 101" fine — nothing was
// calling it. The message already names the unit or the person.
describe('pulling the lookup argument out of the wording', () => {
  const plan = (m: string) => routePlan(m, 'landlord', LANDLORD_TOOLS)

  it('reads the unit out of a unit question', () => {
    expect(plan('how much does apt 101 owe').args).toEqual({ tenant: 'apt 101' })
    expect(plan('is apt 101 current').args).toEqual({ tenant: 'apt 101' })
    expect(plan('does rv 04 owe anything').args).toEqual({ tenant: 'rv 04' })
  })

  it('reads the person out of a name question', () => {
    expect(plan('is bob behind on rent?').args).toEqual({ tenant: 'bob' })
    expect(plan('how much does bob owe').args).toEqual({ tenant: 'bob' })
    expect(plan("what's bob chen's balance").args).toEqual({ tenant: 'bob chen' })
  })

  it('reads the unit for a one-unit lease question', () => {
    expect(plan('when does the lease end for rv 8').args).toEqual({ unit: 'rv 8' })
  })

  // "number" is filler. Reading it AS the unit turned "spot number one" into
  // unit "spot number" and force-ran the lookup on nonsense — breaking the
  // disambiguation Nic asked for, with his own example phrasing.
  it('treats number/no./# as filler, not as the unit', () => {
    expect(plan('when does the lease end for spot number one').args).toEqual({ unit: 'spot one' })
    expect(plan('the lease on unit number 12b').args).toEqual({ unit: 'unit 12b' })
  })

  // "is anyone behind" is the delinquency list, and must not be mistaken for a
  // person called "anyone".
  it('does not turn an indefinite word into a person', () => {
    const p = plan('is anyone behind on rent?')
    expect(p.tools).toEqual(['get_delinquent_tenants'])
    expect(p.args).toBeUndefined()
  })

  it('leaves args undefined when the wording names nobody', () => {
    expect(plan('how many units do I have vacant?').args).toBeUndefined()
  })
})

// S618 (Nic): "that's the point of contact where tenants are gonna complain
// about the neighbor — hey, tell my neighbor to turn their shit down."
describe('recording a complaint from chat', () => {
  const plan = (m: string) => routePlan(m, 'tenant', TENANT_TOOLS)

  it('routes a complaint to log_complaint', () => {
    for (const m of [
      'tell my neighbor to turn their music down',
      'the people next door are so loud every night',
      'my neighbor keeps parking in my spot',
      'someone is smoking and it comes into my apartment',
      "I can't sleep because of the noise upstairs",
      'the dog next door barks all day',
    ]) expect(tenant(m), m).toBe('log_complaint')
  })

  // The record must quote the tenant — a route decides THAT a complaint was
  // made, never what it says.
  it('records the tenant\'s own words verbatim', () => {
    const m = 'tell my neighbor to turn their music down'
    expect(plan(m).args).toEqual({ category: 'noise', body: m })
  })

  it('labels the obvious kinds', () => {
    expect(plan('my neighbor keeps parking in my spot').args?.category).toBe('parking')
    expect(plan('someone is smoking and it comes into my apartment').args?.category).toBe('smell')
    expect(plan('the dog next door barks all day').args?.category).toBe('pets')
  })

  // A repair is not a complaint — it has its own path and its own costs.
  it('does not swallow repair or lease questions', () => {
    expect(tenant('how much is my pet deposit?')).toBe('get_my_lease_fees')
    expect(tenant('what am I paying for parking')).toBe('get_my_lease_fees')
    expect(tenant('how much do I owe?')).toBe('get_my_balance_breakdown')
  })
})

// S618 (Nic): "the word me shouldn't matter... the agent is only scoped to that
// landlord's portfolio anyway."
describe('pronouns that name the person we are already scoped to', () => {
  it('routes the same with or without "me"', () => {
    for (const [a, b] of [
      ['who owes the most', 'who owes me the most'],
      ['who pays late the most', 'who pays me late the most'],
      ['what percentage of tenants pay late', 'what percentage of my tenants pay late'],
    ]) expect(landlord(b), `${b} vs ${a}`).toBe(landlord(a))
  })

  // "my" is load-bearing on the tenant side and must NOT be stripped.
  it('leaves tenant possessives intact', () => {
    expect(tenant('what is my balance')).toBe('get_my_balance_breakdown')
    expect(tenant('when does my lease end?')).toBe('get_my_lease')
    expect(tenant('how much is my pet deposit?')).toBe('get_my_lease_fees')
  })
})
