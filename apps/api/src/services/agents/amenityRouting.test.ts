/**
 * S626 — a tool nothing routes to is one prompt edit away from unreachable.
 *
 * The eval's t-amenities case ("what amenities can I reserve at my property?")
 * had only ever passed because the model happened to choose get_my_amenities
 * unaided. There was no phrase route, so there was no deterministic backstop
 * and nothing for the account-data net to force. A prompt change tipped it and
 * the case started calling nothing at all.
 */
import { describe, it, expect } from 'vitest'
import { routePlan } from './toolRouting'

const TOOLS = ['get_my_amenities', 'log_complaint', 'get_my_lease', 'get_my_balance_breakdown']
const t = (m: string) => routePlan(m, 'tenant' as any, TOOLS).tools

describe('tenant amenity questions reach the amenity tool', () => {
  it('the eval case, verbatim', () => {
    expect(t('what amenities can I reserve at my property?')).toContain('get_my_amenities')
  })
  it.each([
    'is there a pool here?',
    'when is the clubhouse free?',
    'do you have a gym?',
    'where is the laundry?',
    'what can I book?',
    'what are my reservations?',
  ])('routes %j', (m) => expect(t(m)).toContain('get_my_amenities'))
})

describe('a complaint about an amenity is still a complaint', () => {
  // The complaint route is first among tenant routes on purpose. An amenity
  // NOUN must not steal a turn where somebody is reporting a problem.
  it.each([
    'someone is smoking by the pool',
    'my neighbour is blasting music by the pool at 2am',
  ])('%j stays a complaint', (m) => {
    expect(t(m)).toContain('log_complaint')
    expect(t(m)).not.toContain('get_my_amenities')
  })
})

describe('unrelated tenant questions are untouched', () => {
  it.each([
    ['how much do I owe?', 'get_my_balance_breakdown'],
    ['when does my lease end?', 'get_my_lease'],
  ])('%j still routes to %s', (m, want) => expect(t(m)).toContain(want))
})

describe('S626 — tools that nothing routed to', () => {
  // Both of these failed the eval by calling NOTHING. Neither had a phrase
  // route, so neither had a deterministic backstop, and both had only ever
  // passed because the model happened to choose correctly unaided.
  const LL = ['get_books_summary', 'get_profit_and_loss', 'get_delinquent_tenants']
  const ll = (m: string) => routePlan(m, 'landlord' as any, LL).tools

  it('the l-books eval case, verbatim', () => {
    expect(ll('how did my properties do financially last month?')).toContain('get_books_summary')
  })

  it.each([
    'how are the books looking?',
    'what are my biggest expenses this year?',
  ])('routes %j to the books', (m) => expect(ll(m)).toContain('get_books_summary'))

  it('does NOT steal the P&L vocabulary — that route sits above it', () => {
    for (const m of ['show me my p&l', 'what is my net income', 'am i profitable']) {
      expect(ll(m), m).toContain('get_profit_and_loss')
      expect(ll(m), m).not.toContain('get_books_summary')
    }
  })
})
