/**
 * 10/20 (Nic) — WHAT THE GUEST ACTUALLY READS.
 *
 * The figures are pinned next door (bookingConfirmation.test.ts). This is the
 * email itself, caught at the Resend boundary, because the whole point of this
 * one is its WORDING: Nic asked for the deposit to be offered rather than
 * demanded ("I don't know the best way to word that") and he reads this copy
 * himself. A test that only checked the numbers would let the sentence that
 * does the real work drift.
 *
 * What it has to carry, every time:
 *   - the dates, in words a person reads;
 *   - the price — the whole stay, or the FIRST MONTH said as the first month;
 *   - the deposit, with GAM's card fee on the page BEFORE they pay;
 *   - the honest trade: pay and the site is held, don't and somebody who paid
 *     can be given it, and a deposit is not refundable;
 *   - and a subject line that does not call anything "confirmed" while the
 *     deposit is unpaid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_conf' }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { cleanupAllSchema } from '../test/dbHelpers'
import { emailBookingConfirmation, DEPOSIT_CHOICE_WORDS } from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockReset()
  resendSendMock.mockResolvedValue({ data: { id: 'msg_conf' }, error: null } as any)
  // The suite never sends for real; this file asserts on the mocked client.
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

const sent = () => (resendSendMock.mock.calls[0] as any[])[0]

const SHORT = {
  to: 'dale@mailer-test.co',
  guestName: 'Dale Carter',
  propertyName: 'Mountain View RV Park',
  checkIn: '2027-03-06',
  checkOut: '2027-03-13',
  nights: 7,
  firstMonthOnly: false,
  amount: 286.75,
  firstMonthThrough: null,
  tax: 17.75,
  heldThrough: null,
  depositPct: 10,
  deposit: { deposit: 28.68, screening: 0, cardFee: 1.55, total: 30.23, url: 'https://pay.gam.test/abc' },
}

describe('a short stay\'s confirmation', () => {
  it('names the dates and the grand total, tax in', async () => {
    await emailBookingConfirmation(SHORT)
    const { subject, html } = sent()
    expect(subject).toBe('Your reservation at Mountain View RV Park — March 6, 2027 to March 13, 2027')
    // The deposit is not paid, so nothing is "confirmed" yet.
    expect(subject.toLowerCase()).not.toContain('confirmed')
    expect(html).toContain('March 6, 2027')
    expect(html).toContain('March 13, 2027')
    expect(html).toContain('7 nights')
    expect(html).toContain('Your stay comes to $286.75')
    expect(html).toContain('$17.75 of lodging tax')
    expect(html).toContain('The balance is due when you arrive.')
  })

  it('shows the deposit, the card fee and the all-in total before they pay', async () => {
    await emailBookingConfirmation(SHORT)
    const { html } = sent()
    expect(html).toContain('A deposit of $28.68')
    expect(html).toContain('10% of your stay')
    expect(html).toContain('Card processing fee:')
    expect(html).toContain('$1.55')
    expect(html).toContain('Total to pay by card:')
    expect(html).toContain('$30.23')
    // GAM never reads a processor's rate card out to a customer.
    expect(html).not.toContain('3.5%')
    expect(html).not.toContain('55¢')
  })

  it('offers the deposit — it never demands it', async () => {
    await emailBookingConfirmation(SHORT)
    const { html } = sent()
    for (const line of DEPOSIT_CHOICE_WORDS) expect(html).toContain(line.replace(/'/g, '&#39;'))
    expect(html).toContain('Pay the deposit')
    expect(html).toContain('https://pay.gam.test/abc')     // S636: the URL rides as text too
    // Nothing anywhere tells them they have to.
    expect(html).not.toMatch(/required|must pay|due now|pay immediately/i)
  })

  it('leaves the card fee line out where the property covers it', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: { ...SHORT.deposit, cardFee: 0, total: 28.68 } })
    const { html } = sent()
    expect(html).not.toContain('Card processing fee')
    expect(html).toContain('Total to pay by card:')
  })

  it('says nothing about a deposit where the park asks for none', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: null })
    const { html } = sent()
    expect(html).not.toContain('deposit')
    expect(html).toContain('Your stay comes to $286.75')
  })

  it('tells them to call the office when there is no card page to send', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: { ...SHORT.deposit, url: null } })
    const { html } = sent()
    expect(html).toContain('Call the office and we can take the deposit by card.')
    expect(html).not.toContain('Pay the deposit')
  })

  it('leaves the tax line out on a park with no lodging tax', async () => {
    await emailBookingConfirmation({ ...SHORT, amount: 269, tax: null })
    const { html } = sent()
    expect(html).toContain('Your stay comes to $269.00')
    expect(html).not.toContain('lodging tax')
  })
})

describe('a seasonal guest\'s confirmation', () => {
  const LONG = {
    ...SHORT,
    checkOut: '2027-06-06',
    nights: 92,
    firstMonthOnly: true,
    amount: 589,
    firstMonthThrough: '2027-04-06',
    tax: null,
    heldThrough: 'Your site is held through June 6, 2027. Without a lease it can be booked by someone else after that '
      + '— sign a lease to keep it for as long as you\'re here.',
    deposit: { deposit: 300, screening: 0, cardFee: 11.05, total: 311.05, url: 'https://pay.gam.test/xyz' },
  }

  it('says the figure is the FIRST MONTH, not the whole stay', async () => {
    await emailBookingConfirmation(LONG)
    const { html } = sent()
    expect(html).toContain('Your first month is $589.00')
    expect(html).toContain('March 6, 2027 through April 6, 2027')
    expect(html).toContain('That is the first month only, not the whole stay.')
    expect(html).toContain('We bill each month as it comes.')
    // A 30+ night stay carries no lodging tax, so the line is absent.
    expect(html).not.toContain('lodging tax')
  })

  it('does not call the flat deposit a percentage of anything', async () => {
    // The percentage is for short stays; a 30+ stay owes a flat amount, so
    // "10% of your stay" would be a figure the guest could not reproduce.
    await emailBookingConfirmation(LONG)
    const { html } = sent()
    expect(html).toContain('A deposit of $300.00')
    expect(html).not.toContain('% of your stay')
  })

  it('carries the held-through sentence for a guest with no lease', async () => {
    await emailBookingConfirmation(LONG)
    expect(sent().html).toContain('Your site is held through June 6, 2027')
  })

  it('stops promising to bill each month to a guest who has paid the lot', async () => {
    // A seasonal guest who paid the whole season up front is not going to be
    // billed each month as it comes, so the email does not say he will be.
    await emailBookingConfirmation({ ...LONG, deposit: null, paid: { kind: 'stay', amount: 1767 } })
    const { html } = sent()
    expect(html).toContain('That is the first month only, not the whole stay.')
    expect(html).not.toContain('We bill each month as it comes.')
    expect(html).toContain('Your stay is paid in full')
  })
})

describe('a guest who has already paid', () => {
  it('is told their deposit is in, with no ask and no gamble to weigh up', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: null, paid: { kind: 'deposit', amount: 28.68 } })
    const { html } = sent()
    expect(html).toContain('Your deposit of $28.68 is paid')
    expect(html).toContain('your site is held for you')
    for (const line of DEPOSIT_CHOICE_WORDS) expect(html).not.toContain(line.replace(/'/g, '&#39;'))
    expect(html).not.toContain('Pay the deposit')
    expect(html).not.toContain('can be given the site')
  })

  it('beats an offer, so the two can never both appear', async () => {
    await emailBookingConfirmation({ ...SHORT, paid: { kind: 'deposit', amount: 28.68 } })
    const { html } = sent()
    expect(html).toContain('is paid')
    expect(html).not.toContain('Pay the deposit')
  })

  it('a deposit leaves the REST due on arrival, not the whole balance again', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: null, paid: { kind: 'deposit', amount: 28.68 } })
    const { html } = sent()
    expect(html).toContain('The rest is due when you arrive.')
    expect(html).not.toContain('The balance is due when you arrive.')
  })
})

describe('a guest who has already paid for the WHOLE stay', () => {
  // 10/20 (defect): $286.75 paid on the card page or at the register stamps
  // the balance and leaves no separate deposit amount, and this email told him
  // his "deposit of $28.68" was paid and that the balance was due on arrival.
  // Both sentences were false and the second one asks a man who owes nothing
  // to pay $286.75 again at the gate.
  it('is told it is paid in full, with nothing owed on arrival and no deposit anywhere', async () => {
    await emailBookingConfirmation({ ...SHORT, deposit: null, paid: { kind: 'stay', amount: 286.75 } })
    const { html } = sent()
    expect(html).toContain('Your stay is paid in full')
    expect(html).toContain('we have your $286.75')
    expect(html).toContain('There is nothing to pay when you arrive')
    expect(html).toContain('your site is held for you')
    expect(html).not.toContain('The balance is due when you arrive.')
    expect(html).not.toContain('The rest is due when you arrive.')
    // The word itself is gone: there is no deposit in this guest's story.
    expect(html).not.toContain('deposit')
    expect(html).not.toContain('28.68')
  })

  it('beats a deposit offer outright, card page and all', async () => {
    await emailBookingConfirmation({ ...SHORT, paid: { kind: 'stay', amount: 286.75 } })
    const { html } = sent()
    expect(html).toContain('Your stay is paid in full')
    expect(html).not.toContain('Pay the deposit')
    for (const line of DEPOSIT_CHOICE_WORDS) expect(html).not.toContain(line.replace(/'/g, '&#39;'))
  })

  it('says it without a figure rather than invent one', async () => {
    // A register sale against the reservation with no amount recorded on the
    // row: money is certainly in and nobody can say how much, so the email
    // says the true half and stays quiet about the rest.
    await emailBookingConfirmation({ ...SHORT, deposit: null, paid: { kind: 'stay', amount: null } })
    const { html } = sent()
    expect(html).toContain('Your stay is paid in full')
    expect(html).toContain('There is nothing to pay when you arrive')
    expect(html).not.toMatch(/we have your \$/)
  })
})

describe('what a person typed cannot break the email', () => {
  it('escapes the guest name and the property name', async () => {
    await emailBookingConfirmation({
      ...SHORT,
      guestName: 'Dale <b>"Tiny"</b> Carter',
      propertyName: 'Smith & Sons <RV> Park',
    })
    const { html } = sent()
    expect(html).toContain('Dale &lt;b&gt;&quot;Tiny&quot;&lt;/b&gt; Carter')
    expect(html).toContain('Smith &amp; Sons &lt;RV&gt; Park')
    expect(html).not.toContain('<b>"Tiny"</b>')
  })
})

describe('the audit trail', () => {
  it('is logged under its own declared category, against the reservation', async () => {
    const { db } = await import('../db')
    await emailBookingConfirmation({
      ...SHORT,
      ctx: { bookingId: '00000000-0000-0000-0000-0000000000c1' },
    })
    const { rows } = await db.query<any>(
      `SELECT category, status, related_entity_type, related_entity_id
         FROM email_send_log WHERE to_email = $1`, [SHORT.to])
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('booking_confirmation')
    expect(rows[0].status).toBe('sent')
    expect(rows[0].related_entity_type).toBe('unit_booking')
    expect(rows[0].related_entity_id).toBe('00000000-0000-0000-0000-0000000000c1')
  })
})
