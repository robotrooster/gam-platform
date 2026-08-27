/**
 * S626 — Lucy offered a meeting time she had never looked up.
 *
 * "How about tomorrow at 1:00 PM MST? I can send over a calendar invite once we
 * confirm." No tool call behind it. Told "Tuesday afternoon would work for me",
 * she answered "I'll send over the calendar invite for tomorrow at 1:00 PM" —
 * ignoring the day they chose and promising an invite nothing would send.
 *
 * S620 caught the version that CLAIMED a booking; claimsAnActionItNeverTook is
 * past-tense only, so the promise went straight through.
 */
import { describe, it, expect } from 'vitest'
import { __salesInternals } from './agentRunner'

const { OFFERS_A_MEETING_TIME: RE } = __salesInternals

describe('an invented meeting time is caught', () => {
  it.each([
    'How about tomorrow at 1:00 PM MST?',
    "I'll send over the calendar invite for tomorrow at 1:00 PM MST.",
    'I can send over a calendar invite once we confirm.',
    'Does Tuesday at 2pm work for you?',
    "Let's say Thursday — I'll get the invite over to you.",
    "I've got a slot at 3:30pm.",
  ])('flags %j', (t) => expect(RE.test(t)).toBe(true))
})

describe('ordinary sales conversation is left alone', () => {
  it.each([
    'RV parks are right in our wheelhouse. Want me to grab you a time?',
    'It starts at $2 per occupied unit a month, and you never pay for vacant ones.',
    'What kind of properties are you working with?',
    'Happy to walk you through it — how many units are you running?',
    // No time, no invite: asking for what booking actually requires.
    "I'll need your name and email to get that booked.",
  ])('leaves %j alone', (t) => expect(RE.test(t)).toBe(false))
})
