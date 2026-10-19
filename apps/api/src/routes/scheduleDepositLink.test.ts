/**
 * 10/18 (Nic) — COLLECTING A DEPOSIT FROM SOMEBODY WHO NEVER GOT ASKED.
 *
 *   "yeah, let's add a button so that we can collect deposits from people that
 *    haven't done it for their stays."
 *
 * A deposit link could only go out at the one moment a reservation was made, so
 * every stay taken without one — the phone calls, the soft holds — sat on the
 * board unpaid with no way to ask. And an unpaid reservation is exactly the one
 * a paying guest can take (S652): the deposit is what locks it in.
 *
 * What is tested here: the ask itself, what it refuses with nothing sent, who
 * may press it, and — the rule this does NOT rebuild — that a deposit paid
 * against the link locks the reservation so nobody can take the site.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// The link row and the booking row are what these assert; the message itself is
// counted, not sent (pressing twice must not email the guest twice).
const { emailPayLinkMock } = vi.hoisted(() => ({ emailPayLinkMock: vi.fn(async (_o: any) => undefined) }))
vi.mock('../services/email', async (orig) => ({ ...(await orig<any>()), emailPayLink: emailPayLinkMock }))

// The counter's own tax run is not what this is about.
vi.mock('../services/posTax', async (orig) => ({
  ...(await orig<any>()),
  calculateCartTax: async (_l: string, cart: any[]) => ({
    subtotal: cart.reduce((s, l) => s + l.qty * l.unitPrice, 0),
    taxAmount: 0,
    lines: cart.map((l) => ({ ...l, taxRate: 0, tax: 0 })),
  }),
}))

let unitsRouter: any, posRouter: any, errorHandler: any
beforeEach(async () => {
  emailPayLinkMock.mockClear()
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_deposit_link'
  ;({ unitsRouter } = await import('./units'))
  ;({ posRouter } = await import('./pos'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/units', unitsRouter)
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

/** $40 a night, a 20% deposit: seven nights is $280 and the deposit is $56. */
const DEPOSIT = 56

async function seed(opts: { rates?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET booking_deposit_pct = 20 WHERE id = $1`, [propertyId])
    // A link refuses to go out with nowhere to pay the landlord, and that check
    // fires before anything these tests are about.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_dl_' || replace($1::text,'-','') WHERE id = $1`,
      [landlordId])
    const unitIds: string[] = []
    for (const n of ['01', '02']) {
      const u = await c.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, is_bookable)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',$4,TRUE) RETURNING id`,
        [propertyId, landlordId, `RV ${n}`, opts.rates === false ? null : 40])
      unitIds.push(u.rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitIds, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A worker with exactly these boxes ticked, at this one property. */
async function worker(f: any, perms: Record<string, boolean>): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
    [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
  await query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,FALSE,$4)`,
    [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
  return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

/** A reservation taken the way the counter takes one — no deposit link asked for. */
const takeReservation = (f: any, unitId: string, body: any = {}) =>
  request(buildApp()).post(`/api/units/${unitId}/bookings`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      guestName: 'Dale Carter', guestEmail: 'dale@t.dev', guestPhone: '520-555-0110',
      leaseType: 'nightly', checkIn: '2027-03-06', checkOut: '2027-03-13',
      source: 'direct', ...body,
    })

const ask = (f: any, unitId: string, bookingId: string, token = f.token) =>
  request(buildApp()).post(`/api/units/${unitId}/bookings/${bookingId}/deposit-link`)
    .set('Authorization', `Bearer ${token}`).send({})

const bookingRow = async (id: string) => (await query<any>(
  `SELECT status, deposit_amount::float AS deposit_amount, deposit_paid_at, deposit_link_sent_at,
          deposit_link_sent_by, deposit_pay_link_id, unit_id
     FROM unit_bookings WHERE id = $1`, [id]))[0]
const links = async (f: any) => query<any>(
  `SELECT id, token, status, total::float AS total, customer_email, booking_id, label
     FROM pos_pay_links WHERE landlord_id = $1 ORDER BY created_at`, [f.landlordId])

describe('asking a reservation already on the schedule for its deposit', () => {
  it('asks the guest for the deposit the booking site would have quoted, and records that it asked', async () => {
    const f = await seed()
    const made = await takeReservation(f, f.unitIds[0])
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data.id
    // Taken without a link: nothing was ever asked for.
    expect(await bookingRow(id)).toMatchObject({ deposit_amount: null, deposit_link_sent_at: null })
    expect(emailPayLinkMock).not.toHaveBeenCalled()

    const sent = await ask(f, f.unitIds[0], id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data).toMatchObject({
      sentTo: 'dale@t.dev', guestName: 'Dale Carter', emailedNow: true, emailFailed: false, amount: DEPOSIT,
    })
    expect(sent.body.data.link.url).toMatch(/\/api\/public\/pay\/[0-9a-f]{48}/)
    // What the link asks for, in the words and the figure the desk reads out.
    expect(sent.body.data.link).toMatchObject({
      isDeposit: true, label: 'Reservation deposit', amount: DEPOSIT, neverExpires: true,
    })

    // The same link the "+ Book" form would have made — one, for this stay.
    const [link] = await links(f)
    expect(link).toMatchObject({ status: 'open', total: DEPOSIT, customer_email: 'dale@t.dev', booking_id: id, label: 'Reservation deposit' })
    expect(sent.body.data.link.id).toBe(link.id)
    // One email, to the guest.
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'dale@t.dev', amount: DEPOSIT })

    // And the schedule can say the guest was asked, and by whom.
    const after = await bookingRow(id)
    expect(after.deposit_amount).toBe(DEPOSIT)
    expect(after.deposit_link_sent_at).not.toBeNull()
    expect(after.deposit_link_sent_by).toBe(f.userId)
    // And WHICH link is this reservation's deposit is on the reservation, so
    // another link against the same stay is never handed back as the deposit.
    expect(after.deposit_pay_link_id).toBe(link.id)
  })

  it('pressed twice it hands back the same link and does not email the guest again', async () => {
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    const first = await ask(f, f.unitIds[0], id)
    expect(first.status).toBe(201)

    const again = await ask(f, f.unitIds[0], id)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data.emailedNow).toBe(false)
    expect(again.body.data.link.url).toBe(first.body.data.link.url)
    expect(again.body.data.link.id).toBe(first.body.data.link.id)
    // And it is still named as the deposit, with its figure.
    expect(again.body.data.link).toMatchObject({ isDeposit: true, label: 'Reservation deposit', amount: DEPOSIT })

    // Not a second link, and not a second email.
    expect(await links(f)).toHaveLength(1)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
  })

  it('holds the hour when a link went out and there is none left to hand back, then asks again after it', async () => {
    // The guest's card declined and the clerk closed the link. Inside the hour
    // a second email is noise — the same hour the lease signing Remind button
    // keeps (routes/esign) — but AFTER it the guest must be askable again:
    // "people that haven't done it for their stays" is exactly this person, one
    // card failure later. (Before the 10/18 review the closed link kept its
    // claim on the reservation forever and the ask was refused for good.)
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    expect((await ask(f, f.unitIds[0], id)).status).toBe(201)
    await query(`UPDATE pos_pay_links SET status = 'cancelled' WHERE landlord_id = $1`, [f.landlordId])

    const tooSoon = await ask(f, f.unitIds[0], id)
    expect(tooSoon.status).toBe(429)
    expect(tooSoon.body.error).toMatch(/Dale Carter was emailed a deposit link within the last hour.*Nothing was sent\./s)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    expect(await links(f)).toHaveLength(1)

    // An hour on: a fresh link, at the same deposit, emailed once more.
    await query(`UPDATE unit_bookings SET deposit_link_sent_at = NOW() - INTERVAL '70 minutes' WHERE id = $1`, [id])
    const afresh = await ask(f, f.unitIds[0], id)
    expect(afresh.status, JSON.stringify(afresh.body)).toBe(201)
    expect(afresh.body.data).toMatchObject({ emailedNow: true, amount: DEPOSIT })
    const all = await links(f)
    expect(all).toHaveLength(2)
    expect(all.filter((l: any) => l.status === 'open')).toHaveLength(1)
    expect(afresh.body.data.link.id).not.toBe(all[0].id)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(2)
    // The reservation points at the live one, and is asked for the same money.
    expect(await bookingRow(id)).toMatchObject({ deposit_amount: DEPOSIT, deposit_pay_link_id: afresh.body.data.link.id })
  })

  it('never hands back a link that asks for other money, and never emails a second one beside it', async () => {
    // 10/18 (review): a week held by an unpaid pay link for the WHOLE stay
    // ($280) carries that reservation on the link. Taking "an open link that is
    // not the balance link" for the deposit link read that URL out as the
    // guest's $56 deposit — five times the figure — and the deposit was never
    // asked for at all. The link is handed back for what it IS, and nothing
    // new is emailed beside it: two open ways to pay one reservation is how a
    // guest pays twice.
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    const held = (await query<any>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, tax_amount, discount_amount, total, customer_name, customer_email,
                                  booking_id, expires_at)
       VALUES (repeat('a', 48), $1, $2, $3, 'one_time', 'RV site — nightly — 7 nights',
               '[]'::jsonb, 280, 0, 0, 280, 'Dale Carter', 'dale@t.dev', $4, NOW() + INTERVAL '14 days')
       RETURNING id`, [f.landlordId, f.propertyId, f.userId, id]))[0]

    const pressed = await ask(f, f.unitIds[0], id)
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200)
    expect(pressed.body.data.emailedNow).toBe(false)
    expect(pressed.body.data.link).toMatchObject({
      id: held.id, isDeposit: false, label: 'RV site — nightly — 7 nights', amount: 280, neverExpires: false,
    })
    // No second link, no email, and nothing recorded as an ask.
    expect(await links(f)).toHaveLength(1)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
    expect(await bookingRow(id)).toMatchObject({ deposit_amount: null, deposit_link_sent_at: null, deposit_pay_link_id: null })

    // Closed, the reservation can be asked for its deposit — its own figure.
    await query(`UPDATE pos_pay_links SET status = 'cancelled' WHERE id = $1`, [held.id])
    const sent = await ask(f, f.unitIds[0], id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data).toMatchObject({ emailedNow: true, amount: DEPOSIT })
    expect(sent.body.data.link).toMatchObject({ isDeposit: true, amount: DEPOSIT })
  })

  it('a lapsed link is not something a guest can pay, so it is not handed back', async () => {
    // The public card page refuses an expired link with a closed page, so
    // handing one back would be a dead URL read down the phone.
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    await query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, tax_amount, discount_amount, total, customer_name, customer_email,
                                  booking_id, expires_at)
       VALUES (repeat('b', 48), $1, $2, $3, 'one_time', 'RV site — nightly — 7 nights',
               '[]'::jsonb, 280, 0, 0, 280, 'Dale Carter', 'dale@t.dev', $4, NOW() - INTERVAL '1 day')`,
      [f.landlordId, f.propertyId, f.userId, id])

    const sent = await ask(f, f.unitIds[0], id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data.link).toMatchObject({ isDeposit: true, amount: DEPOSIT })
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
  })

  it('a send that fails is not an ask: nothing says the guest was emailed', async () => {
    // 10/18 (review): the email is best-effort — the link is made and payable
    // either way — but recording an ask that never reached anybody is how a
    // guest is left waiting for an email nobody will send again, and the stamp
    // exists so "nobody asks the same person four times".
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    emailPayLinkMock.mockRejectedValueOnce(new Error('resend is down'))

    const sent = await ask(f, f.unitIds[0], id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data).toMatchObject({ emailedNow: false, emailFailed: true, amount: DEPOSIT })
    const after = await bookingRow(id)
    expect(after.deposit_link_sent_at).toBeNull()
    expect(after.deposit_link_sent_by).toBeNull()
    // The link is real and is this reservation's deposit, so a second press
    // hands it back instead of making another.
    expect(after.deposit_pay_link_id).toBe(sent.body.data.link.id)
    const again = await ask(f, f.unitIds[0], id)
    expect(again.status).toBe(200)
    expect(again.body.data.link.id).toBe(sent.body.data.link.id)
    // And that press does not claim the guest was emailed either.
    expect(again.body.data).toMatchObject({ emailedNow: false, emailFailed: true })
    expect(await links(f)).toHaveLength(1)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
  })

  it('asks a stay priced by hand at a park that does take deposits', async () => {
    // 10/18 (review): a site with no rate anywhere is booked at a typed total,
    // and quoting the rate card alone made the deposit $0 — so the desk was
    // told, as a fact about the park, that the guest "owes no deposit on this
    // stay" while the park takes 20%.
    const f = await seed({ rates: false })
    const id = (await takeReservation(f, f.unitIds[0], { totalAmount: 400 })).body.data.id
    const sent = await ask(f, f.unitIds[0], id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data.amount).toBe(80)
    expect(sent.body.data.link).toMatchObject({ isDeposit: true, amount: 80 })
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'dale@t.dev', amount: 80 })
  })

  it('leaves a guest paying on the booking site alone', async () => {
    // A booking-site checkout hold is the website asking for this same deposit
    // on its own card page (the counter never sets a timer on a reservation).
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    await query(`UPDATE unit_bookings SET hold_expires_at = NOW() + INTERVAL '10 minutes' WHERE id = $1`, [id])
    const busy = await ask(f, f.unitIds[0], id)
    expect(busy.status).toBe(409)
    expect(busy.body.error).toMatch(/paying for this reservation on the booking site right now.*Nothing was sent\./s)

    await query(`UPDATE unit_bookings SET hold_expires_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [id])
    const lapsed = await ask(f, f.unitIds[0], id)
    expect(lapsed.status).toBe(409)
    expect(lapsed.body.error).toMatch(/never finished paying on the booking site.*Nothing was sent\./s)
    expect(await links(f)).toHaveLength(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('refuses in plain words, with nothing sent, when there is nobody to ask or nothing to ask for', async () => {
    // No email on the reservation — there is nowhere to send a link.
    const f = await seed()
    const noEmail = (await takeReservation(f, f.unitIds[0], { guestEmail: null })).body.data.id
    const noneSent = await ask(f, f.unitIds[0], noEmail)
    expect(noneSent.status).toBe(409)
    expect(noneSent.body.error).toMatch(/no email address on this reservation.*Nothing was sent\./s)

    // Already paid for.
    const paid = (await takeReservation(f, f.unitIds[1], { checkIn: '2027-04-01', checkOut: '2027-04-08' })).body.data.id
    await query(`UPDATE unit_bookings SET deposit_amount = 56, deposit_paid_at = NOW() WHERE id = $1`, [paid])
    const alreadyPaid = await ask(f, f.unitIds[1], paid)
    expect(alreadyPaid.status).toBe(409)
    expect(alreadyPaid.body.error).toMatch(/already paid for.*Nothing was sent\./s)

    // Checked in: the deposit question is over.
    await query(`UPDATE unit_bookings SET deposit_amount = NULL, deposit_paid_at = NULL, status = 'checked_in' WHERE id = $1`, [paid])
    const checkedIn = await ask(f, f.unitIds[1], paid)
    expect(checkedIn.status).toBe(409)
    expect(checkedIn.body.error).toMatch(/not holding its site any more.*Nothing was sent\./s)

    // Nothing was written by any of them, and nothing went out.
    expect(await links(f)).toHaveLength(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
    expect((await bookingRow(noEmail)).deposit_link_sent_at).toBeNull()
  })

  it('says a park that takes no deposit on this stay has nothing to ask for, rather than reporting a failure', async () => {
    // 10/17 (Nic): no link went out because nothing is owed — not because
    // sending one broke. A site with no rate anywhere prices at nothing.
    const f = await seed({ rates: false })
    const id = (await takeReservation(f, f.unitIds[0], { totalAmount: 0 })).body.data.id
    const nothing = await ask(f, f.unitIds[0], id)
    expect(nothing.status).toBe(409)
    expect(nothing.body.error).toMatch(/owes no deposit on this stay.*still held.*Nothing was sent\./s)
    expect(await links(f)).toHaveLength(0)
    expect(await bookingRow(id)).toMatchObject({ deposit_amount: null, deposit_link_sent_at: null })
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('will not put a link beside a ticket already waiting at the register', async () => {
    // Two open ways to pay one reservation is how a guest pays twice.
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0])).body.data.id
    await query(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,$3,'[]'::jsonb,'Walk-in',$4)`,
      [f.landlordId, f.propertyId, f.userId, id])
    const refused = await ask(f, f.unitIds[0], id)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/written up at the register for site RV 01.*Nothing was sent\./s)
    expect(await links(f)).toHaveLength(0)
  })

  // 10/14 (Nic): "anyone who can schedule reservations and take payments" —
  // the same pair a shortened stay's charges ask for (lib/stayShortenedVoid).
  it('takes a reservation permission AND a way to take payments', async () => {
    const f = await seed()
    const ids = [
      (await takeReservation(f, f.unitIds[0])).body.data.id,
      (await takeReservation(f, f.unitIds[1], { checkIn: '2027-05-01', checkOut: '2027-05-08' })).body.data.id,
    ]

    // Reservations but no way to take money: refused, in the words of the boxes.
    const scheduleOnly = await worker(f, { 'schedule.create_reservation': true })
    const halfA = await ask(f, f.unitIds[0], ids[0], scheduleOnly)
    expect(halfA.status).toBe(403)
    expect(halfA.body.error).toMatch(/needs "Create reservations" or "Edit \/ move \/ cancel reservations", together with/)
    expect(halfA.body.error).toMatch(/Nothing was sent\./)

    // Money but nothing to do with reservations: refused in the SAME words.
    // 10/18 (review): this half used to get "Insufficient permissions" from the
    // door, so half the people the sentence was written for never read it.
    const moneyOnly = await worker(f, { take_payment: true })
    const halfB = await ask(f, f.unitIds[0], ids[0], moneyOnly)
    expect(halfB.status).toBe(403)
    expect(halfB.body.error).toBe(halfA.body.error)

    // And somebody with neither box hears it too, rather than a code.
    const neither = await worker(f, { 'guests.check_in': true })
    const none = await ask(f, f.unitIds[0], ids[0], neither)
    expect(none.status).toBe(403)
    expect(none.body.error).toBe(halfA.body.error)
    expect(await links(f)).toHaveLength(0)

    // Both — either way round — and it goes out.
    const deskA = await worker(f, { 'schedule.create_reservation': true, take_payment: true })
    expect((await ask(f, f.unitIds[0], ids[0], deskA)).status, 'create + record a payment').toBe(201)
    const deskB = await worker(f, { 'schedule.edit_reservation': true, 'pos.ring_sale': true })
    expect((await ask(f, f.unitIds[1], ids[1], deskB)).status, 'edit + ring sales').toBe(201)
    expect(await links(f)).toHaveLength(2)
  })

  /**
   * The rule this route does not rebuild: S652 / 10/17 (Nic) — "reservations
   * are only locked in with deposits. still reserved without deposits but can
   * be booted when space is limited by other paying people."
   */
  it('a deposit paid against the link locks the reservation in, so nobody can take the site', async () => {
    const f = await seed()
    const id = (await takeReservation(f, f.unitIds[0], { sendDepositLink: true })).body.data.id
    // Unpaid, it holds the site and yields to money.
    expect(await bookingRow(id)).toMatchObject({ status: 'tentative', deposit_paid_at: null })

    const [link] = await links(f)
    const settled = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link.id,
              items: [{ id: null, name: 'Reservation deposit', qty: 1, price: DEPOSIT, tax: 0 }] })
    expect(settled.status, JSON.stringify(settled.body)).toBe(201)

    const locked = await bookingRow(id)
    expect(locked.status).toBe('confirmed')
    expect(locked.deposit_paid_at).not.toBeNull()

    // Now somebody else tries to pay for the same site for the same nights.
    // Before the deposit landed this would have moved Dale to RV 02; with money
    // on his reservation it is refused and he does not budge.
    const other = await takeReservation(f, f.unitIds[0], { guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev' })
    expect(other.status, JSON.stringify(other.body)).toBe(409)
    expect(other.body.error).toMatch(/already booked for those dates/)
    expect((await bookingRow(id)).unit_id).toBe(f.unitIds[0])
    expect(await query<any>(`SELECT id FROM unit_bookings WHERE guest_name = 'Pat Ruiz'`)).toHaveLength(0)
  })
})
