/**
 * S626 — "what's chen's balance?" searched for a tenant named "what's Chen".
 *
 * Nic's verdict on the narrow-then-answer conversation: "The landlord should
 * never have had to narrow this. The question word gives away that no human is
 * reading it." The name patterns allow an apostrophe (for O'Brien) and allow
 * two words (for "Frank Chen"), and together they swallowed the interrogative.
 */
import { describe, it, expect } from 'vitest'
import { routePlan } from './toolRouting'

const LL = ['lookup_tenant_payment_status', 'get_delinquent_tenants', 'get_vacant_units']
const args = (m: string) => routePlan(m, 'landlord' as any, LL).args

describe('the question word is not part of the name', () => {
  it("what's chen's balance? -> Chen", () => {
    expect(args("what's chen's balance?")).toMatchObject({ tenant: 'chen' })
  })
  it.each([
    ["whats chen's balance", 'chen'],
    ['what is chen\'s balance', 'chen'],
    ["how much does chen owe", 'chen'],
    ["who's chen's balance", 'chen'],
    ['look up chen', 'chen'],
  ])('%j -> %j', (msg, want) => {
    expect(String((args(msg) as any)?.tenant ?? '').toLowerCase()).toBe(want)
  })
})

describe('real names still survive intact', () => {
  it('keeps a two-word name', () => {
    expect(String((args("frank chen's balance") as any)?.tenant ?? '').toLowerCase()).toBe('frank chen')
  })
  it('keeps an apostrophe name — the reason the class allows one', () => {
    expect(String((args("o'brien's balance") as any)?.tenant ?? '').toLowerCase()).toBe("o'brien")
  })
  it('keeps a hyphenated name', () => {
    expect(String((args("smith-jones's balance") as any)?.tenant ?? '').toLowerCase()).toBe('smith-jones')
  })
})

describe('a phrasing that routes nowhere is a separate gap', () => {
  // S626: "tell me about chen" names a person cleanly but matches no landlord
  // route, so nothing looks them up. That is a routing hole, not a parsing one,
  // and it is recorded here rather than fixed inside a name-parsing change.
  it('is recorded, not silently passing', () => {
    expect(routePlan('tell me about chen', 'landlord' as any, LL).tools).toEqual([])
  })
})

describe('indefinite words are still not people', () => {
  it.each(['is anyone behind on rent', 'is everyone current', 'has somebody paid'])(
    '%j names nobody', (msg) => {
      const t = (args(msg) as any)?.tenant
      expect(t == null || t === '').toBe(true)
    })
})
