/**
 * S626 — a tool that looked unreachable, one layer above the tool.
 *
 * The eval's t-amenities case ("what amenities can I reserve at my property?")
 * called nothing. Adding a phrase route for get_my_amenities did not fix it,
 * because demandsAToolCall had already answered NO: the procedural exemption
 * /\b(can|could) (i|we) (pay|...|reserve|...)\b/ matched "can I reserve" in the
 * middle of the sentence and classified a request for their own amenity list as
 * a platform mechanic. Routing never got a turn.
 */
import { describe, it, expect } from 'vitest'
import { demandsAToolCall } from './agentRunner'

describe('a procedure question is still answerable from memory', () => {
  it.each([
    'can I pay with a card?',
    'Can I set up autopay?',
    'could we add another tenant?',
    'so can I file a maintenance request myself?',
    'ok, can I book the clubhouse?',
  ])('%j needs no lookup', (m) => expect(demandsAToolCall(m, 'tenant')).toBe(false))
})

describe('asking WHAT is at their own property is data', () => {
  it('the t-amenities case, verbatim', () => {
    expect(demandsAToolCall('what amenities can I reserve at my property?', 'tenant')).toBe(true)
  })
  it.each([
    'which amenities can I book here?',
    'what can I reserve at my property?',
  ])('%j needs a lookup', (m) => expect(demandsAToolCall(m, 'tenant')).toBe(true))
})

describe('the other memory exemptions are untouched', () => {
  it.each([
    // S618 — GAM's own rate, platform-wide. Must NOT become a lookup.
    'what am I paying for this?',
    'what does GAM cost?',
    // Standing directive, platform-wide: rent is pay-in-full only.
    'can I split my rent?',
    'what is FlexVault?',
    'how do I e-sign my lease?',
  ])('%j stays answerable from memory', (m) => expect(demandsAToolCall(m, 'tenant')).toBe(false))

  it('their own numbers still demand a lookup', () => {
    expect(demandsAToolCall('how much do I owe?', 'tenant')).toBe(true)
    expect(demandsAToolCall('when does my lease end?', 'tenant')).toBe(true)
  })
})
