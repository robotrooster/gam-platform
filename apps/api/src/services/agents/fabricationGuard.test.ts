/**
 * S626 — the guard against invented facts was checking for punctuation.
 *
 * assertsStoredFacts decides whether a reply that ran NO tool, to a question
 * that DEMANDED one, is safe to send. Probed with the things agents actually
 * fabricate, it caught two of fourteen: a dollar figure and an ISO date.
 *
 * Everything else went through — the due date, the unit number, a phone number,
 * an email address, "two open maintenance requests". Each is a per-tenant fact
 * with no source behind it, sent to somebody who will act on it.
 *
 * Being strict here is correct. This is only reached when nothing was looked
 * up, and the reply that replaces a suppressed one ASKS which thing they meant.
 * A clarifying question is recoverable; a wrong due date is not.
 */
import { describe, it, expect } from 'vitest'
import { assertsStoredFacts } from './agentRunner'

describe('facts that must never be stated without a lookup', () => {
  it.each([
    // The one that started it — the commonest lease fact there is.
    ['a due date as an ordinal', 'Your rent is due on the 1st.'],
    ['an ordinal in a sentence', 'Rent is due on the 1st of each month.'],
    ['a bare month', 'Your lease ends in January.'],
    ['a weekday as a date', 'Your rent is due every Monday.'],
    ['a payout weekday', 'Your next payout lands Tuesday.'],
    ['a count spelled out', 'You have two open maintenance requests.'],
    ['a count in "there are"', 'There are three tenants behind on rent.'],
    ['a lease duration in words', 'Your grace period is five days.'],
    ['a notice period', 'You need to give thirty days notice.'],
    ['money spelled out', 'Your deposit is seventy-five dollars.'],
    ['a unit designator', 'Your unit is Apt 101 at Oak Street Apartments.'],
    ['a site number', 'You are on lot 14.'],
    ['a phone number', 'You can reach them at (602) 555-0134.'],
    ['an email address', 'Their email is manager@oakstreet.com.'],
    // Already caught before S626 — kept so they cannot regress out.
    ['a dollar figure', 'Rent is $750 a month.'],
    ['an ISO date', 'Your lease ends on 2027-01-04.'],
    ['a percentage', 'That is 15% of the rent.'],
    ['a list of records', '- Apt 101, Jane Doe\n- Apt 204, John Roe'],
  ])('catches %s', (_label, text) => expect(assertsStoredFacts(text)).toBe(true))
})

describe('what must NOT be suppressed — over-firing costs a good answer', () => {
  it.each([
    ['an offer to help', 'I can help with that — want me to pull up your lease?'],
    ['a clarifying question', 'Which part were you after — your balance, your lease dates, or your deposit?'],
    ['pointing at the portal', 'You can file that from the Maintenance tab in your portal.'],
    ['accepting a decline', "No problem — I'll leave it with you. Just let me know if you change your mind."],
    // STANDING DIRECTIVE, platform-wide, and it contains the word "one".
    ['the pay-in-full rule', 'Rent is paid in full — one payment, no splitting it across two. That is platform-wide.'],
    ['an introduction', "I'm Skye, the assistant for your stay."],
    ['an honest refusal', "I can't see that from here, but your landlord can."],
    ['a plain apology', 'Sorry about that — let me take another look.'],
    ['a process explanation', 'Once the request is filed, your landlord reviews it and you get an update.'],
    ['an escalation offer', 'I can get someone from the team to look at this with you.'],
  ])('leaves %s alone', (_label, text) => expect(assertsStoredFacts(text)).toBe(false))

  it('is inert on empty input', () => {
    expect(assertsStoredFacts('')).toBe(false)
  })
})
