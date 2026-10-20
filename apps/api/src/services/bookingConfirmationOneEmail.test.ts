/**
 * 10/20 (review) — THE GUEST GETS ONE EMAIL, OR NONE.
 *
 * Sending a confirmation has to make the deposit card page before it can offer
 * it, and the one link maker GAM has emails the guest the moment it makes one.
 * So pressing send put TWO emails in front of the guest and the bare one
 * arrived first:
 *
 *     Mountain View RV Park — Reservation deposit: $28.39
 *
 * No dates, no reason, from a company the guest has never heard of, because Nic
 * took their reservation by text in March and told them they were confirmed
 * himself. And if the confirmation behind it then failed — Resend down, the
 * address on the provider's suppression list — that payment demand was the ONLY
 * thing they ever got. For a migrated guest that is the worst thing this path
 * can put in front of them.
 *
 * Which is why this file reads the EMAIL LOG rather than counting calls to a
 * mocked sender. The two-email bug shipped because the suite that covers this
 * route mocks the pay link's email away ("counted, never sent"), so nothing
 * anywhere answered the only question a guest cares about: how many emails
 * turned up, and what was in the first one.
 *
 * NOTHING HERE SENDS. EMAIL_SEND_LIVE is never set, so every send is logged and
 * suppressed before the network, and the mail client is mocked on top of that
 * and asserted never to have been called.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { resendSendMock, confirmation } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_never_sent' }, error: null }) as any),
  confirmation: { throws: false },
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

// The confirmation email with a fault injector in front of it, and emailPayLink
// left REAL — it is the email this whole file is about.
vi.mock('./email', async (orig) => {
  const real = await orig<typeof import('./email')>()
  return {
    ...real,
    emailBookingConfirmation: async (args: any) => {
      if (confirmation.throws) throw new Error('Resend is down')
      return real.emailBookingConfirmation(args)
    },
  }
})

import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { loadConfirmationBooking, sendBookingConfirmation } from './bookingConfirmation'
import { withholdEmails } from './emailWithheld'

const GUEST = 'dale@mailer-test.co'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  confirmation.throws = false
})

/** Nic's own rates: $49 a night, $269 a week, $589 a month, 6.60% lodging tax. */
async function seed(opts: { monthlyDeposit?: number | null } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park',
              booking_deposit_pct = 10, short_term_tax_rate = 6.6, booking_monthly_deposit = $2,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589,
              booking_card_fee_payer = 'customer'
        WHERE id = $1`, [propertyId, opts.monthlyDeposit ?? null])
    // A deposit link refuses to go out with nowhere to pay the landlord.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_1e_' || replace($1::text,'-','') WHERE id = $1`,
      [landlordId])
    const unit = await c.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, weekly_rate, monthly_rate, is_bookable)
       VALUES ($1,$2,'RV 07','vacant',500,'rv_spot',49,269,589,TRUE) RETURNING id`,
      [propertyId, landlordId])
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId: unit.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A reservation off the old system's file, or out of a text thread. */
async function reservation(f: { unitId: string; landlordId: string }, over: Record<string, any> = {}) {
  const row = {
    check_in: '2027-03-06', check_out: '2027-03-13', nights: 7, total_amount: 286.75,
    status: 'confirmed', ...over,
  }
  const r = await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, nights,
        total_amount, status, lease_type, source, booked_check_out)
     VALUES ($1,$2,'Dale Carter',$3,$4,$5,$6,$7,$8,'nightly','direct',$5) RETURNING id`,
    [f.unitId, f.landlordId, GUEST, row.check_in, row.check_out, row.nights,
     row.total_amount, row.status])
  return r[0].id
}

/** Every email this guest was sent, in the order they went. */
const guestMail = (to = GUEST) => query<{ category: string; subject: string; status: string }>(
  `SELECT category, subject, status FROM email_send_log WHERE to_email = $1 ORDER BY created_at`, [to])

const bookingRow = async (id: string) => (await query<any>(
  `SELECT confirmation_sent_at, confirmation_sent_by, deposit_pay_link_id,
          deposit_link_sent_at, deposit_link_sent_by, deposit_amount::float AS deposit_amount
     FROM unit_bookings WHERE id = $1`, [id]))[0]

const linksOut = () => query<any>(`SELECT id, status, token, label FROM pos_pay_links`)

const send = async (bookingId: string, byUserId: string) => {
  const b = await loadConfirmationBooking(bookingId)
  return sendBookingConfirmation(b!, byUserId)
}

describe('pressing send puts ONE email in front of the guest', () => {
  it('sends the confirmation and never the bare deposit link beside it', async () => {
    const f = await seed()
    const id = await reservation(f)
    const sent = await send(id, f.userId)

    // The confirmation carried the card page itself — the deposit, the card
    // fee and somewhere to pay.
    expect(sent.deposit).toMatchObject({ deposit: 28.68, cardFee: 1.55, total: 30.23 })
    expect(sent.deposit!.url).toMatch(/\/api\/public\/pay\//)

    // And that is the whole of what the guest received.
    const mail = await guestMail()
    expect(mail.map(m => m.category)).toEqual(['booking_confirmation'])
    expect(mail[0].subject).toBe('Your reservation at Mountain View RV Park — March 6, 2027 to March 13, 2027')
    expect(mail.map(m => m.subject).join(' ')).not.toMatch(/Reservation deposit/)
    expect(resendSendMock).not.toHaveBeenCalled()

    // The link is real and payable — withheld means the email was not sent,
    // not that the card page was never made.
    const links = await linksOut()
    expect(links).toHaveLength(1)
    expect(links[0].status).toBe('open')
    expect((await bookingRow(id)).deposit_pay_link_id).toBe(links[0].id)
  })

  it('records the ask on the confirmation, because the confirmation IS the ask', async () => {
    // The schedule reads this stamp to say the guest has been asked, and the
    // "Ask for the deposit" button reads it to hand the same link back instead
    // of emailing them again. It belongs to the email that really went.
    const f = await seed()
    const id = await reservation(f)
    await send(id, f.userId)
    const b = await bookingRow(id)
    expect(b.confirmation_sent_at).not.toBeNull()
    expect(b.confirmation_sent_by).toBe(f.userId)
    expect(b.deposit_link_sent_at).not.toBeNull()
    expect(b.deposit_link_sent_by).toBe(f.userId)
  })

  it('records no ask where the park asks no deposit and no card page went', async () => {
    const f = await seed({ monthlyDeposit: 0 })
    const id = await reservation(f, { check_out: '2027-06-06', nights: 92, total_amount: 1767 })
    const sent = await send(id, f.userId)
    expect(sent.deposit).toBeNull()
    const b = await bookingRow(id)
    expect(b.confirmation_sent_at).not.toBeNull()
    expect(b.deposit_link_sent_at).toBeNull()
    expect(await linksOut()).toHaveLength(0)
    expect(await guestMail()).toHaveLength(1)
  })
})

describe('a confirmation that fails on the way out', () => {
  it('leaves the guest with nothing, and the next press sends one email', async () => {
    const f = await seed()
    const id = await reservation(f)

    confirmation.throws = true
    await expect(send(id, f.userId)).rejects.toThrow(/Resend is down/)

    // THE POINT OF THE WHOLE FILE: no payment demand the guest cannot explain.
    expect(await guestMail()).toHaveLength(0)
    expect(resendSendMock).not.toHaveBeenCalled()

    // Nobody was told and nobody was asked — but the card page that was made
    // is remembered, so the next press does not try to bill a second deposit.
    const failed = await bookingRow(id)
    expect(failed.confirmation_sent_at).toBeNull()
    expect(failed.deposit_link_sent_at).toBeNull()
    expect(failed.deposit_pay_link_id).not.toBeNull()
    expect(failed.deposit_amount).toBe(28.68)
    const [link] = await linksOut()
    expect(link.status).toBe('open')

    // Resend is back. The same link goes out, inside one email.
    confirmation.throws = false
    const sent = await send(id, f.userId)
    expect(sent.deposit).toMatchObject({ deposit: 28.68, cardFee: 1.55, total: 30.23 })
    expect(sent.deposit!.url).toContain(link.token)
    expect(await linksOut()).toHaveLength(1)
    const mail = await guestMail()
    expect(mail.map(m => m.category)).toEqual(['booking_confirmation'])
    const after = await bookingRow(id)
    expect(after.confirmation_sent_at).not.toBeNull()
    expect(after.deposit_link_sent_at).not.toBeNull()
  })
})

describe('withholding an email is not a mute switch', () => {
  const payLink = async () => {
    const { emailPayLink } = await import('./email')
    await emailPayLink({
      to: GUEST, name: 'Dale Carter', propertyName: 'Mountain View RV Park',
      label: 'Reservation deposit', amount: 28.68, cardFee: 1.55,
      url: 'https://pay.gam.test/abc', neverExpires: true,
    })
  }

  it('withholds only inside the action that promised to carry it', async () => {
    await withholdEmails(
      { categories: ['pos_pay_link'], because: 'the confirmation carries it' },
      payLink,
    )
    expect(await guestMail()).toHaveLength(0)

    // Outside it, the schedule's "Ask for the deposit" button still emails the
    // guest a deposit link, which is the whole point of that button.
    await payLink()
    expect((await guestMail()).map(m => m.category)).toEqual(['pos_pay_link'])
  })

  it('refuses a category that is not a declared one', () => {
    // A typo would withhold nothing while reading as though it does, and the
    // guest would quietly get two emails again.
    expect(() => withholdEmails(
      { categories: ['pos_pay_links'], because: 'typo' },
      async () => null,
    )).toThrow(/no such email category/)
  })
})
