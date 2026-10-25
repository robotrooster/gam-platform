/**
 * 10/20 (Nic) — PRESSING SEND ON A GUEST'S CONFIRMATION.
 *
 *   "the confirmation actually says that they have a reservation on these
 *    dates ... Have it display that as available to pay now. But I also want it
 *    to not be required"
 *
 * and, about everything arriving from the old system and out of his text
 * threads:
 *
 *   "So I don't want the import to do anything. I just want it to import
 *    straight across."
 *
 * The first test in this file is the one that matters most: TAKING a
 * reservation emails the guest NOTHING. Nic is mid-migration with real
 * customers on the board — people already told they are confirmed, people who
 * may already have paid a deposit off-platform — so a confirmation that sent
 * itself on creation, or a job that swept for unsent ones, would blast every
 * one of them. The only thing that sends is a person pressing send.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// The deposit link's OWN email (createBookingDepositLink) is existing
// machinery and not what this file is about — counted, never sent.
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

let bookingsRouter: any, unitsRouter: any, errorHandler: any
beforeEach(async () => {
  emailPayLinkMock.mockClear()
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_booking_confirmation'
  ;({ bookingsRouter } = await import('./bookings'))
  ;({ unitsRouter } = await import('./units'))
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
  app.use('/api/bookings', bookingsRouter)
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

/** Nic's own rates: $49 a night, $269 a week, $589 a month, 6.60% lodging tax. */
async function seed(opts: { depositPct?: number; taxPct?: number; monthlyDeposit?: number | null } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park',
              booking_deposit_pct = $2, short_term_tax_rate = $3, booking_monthly_deposit = $4,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589,
              booking_card_fee_payer = 'customer'
        WHERE id = $1`,
      [propertyId, opts.depositPct ?? 10, opts.taxPct ?? 6.6, opts.monthlyDeposit ?? null])
    // A deposit link refuses to go out with nowhere to pay the landlord.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_bc_' || replace($1::text,'-','') WHERE id = $1`,
      [landlordId])
    const unit = await c.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, weekly_rate, monthly_rate, is_bookable)
       VALUES ($1,$2,'RV 07','vacant',500,'rv_spot',49,269,589,TRUE) RETURNING id`,
      [propertyId, landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId: unit.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A reservation written straight onto the board, the way an import or a text thread lands one. */
async function reservation(f: any, over: Record<string, any> = {}): Promise<string> {
  const row = {
    check_in: '2027-03-06', check_out: '2027-03-13', nights: 7, total_amount: 286.75,
    status: 'confirmed', lease_type: 'nightly', guest_name: 'Dale Carter',
    guest_email: 'dale@mailer-test.co', stay_terms: null, ...over,
  }
  const r = await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, nights,
        total_amount, status, lease_type, stay_terms, source, booked_check_out)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'direct',$6) RETURNING id`,
    [f.unitId, f.landlordId, row.guest_name, row.guest_email, row.check_in, row.check_out,
     row.nights, row.total_amount, row.status, row.lease_type, row.stay_terms])
  return r[0].id
}

const sendConfirmation = (f: any, bookingId: string, token = f.token) =>
  request(buildApp()).post(`/api/bookings/${bookingId}/confirmation`).set('Authorization', `Bearer ${token}`).send({})

const confirmationLogs = (to = 'dale@mailer-test.co') =>
  query<any>(`SELECT category, status, to_email FROM email_send_log WHERE category = 'booking_confirmation' AND to_email = $1`, [to])

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

describe('NOTHING sends itself', () => {
  it('taking a reservation emails the guest no confirmation', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        guestName: 'Dale Carter', guestEmail: 'dale@mailer-test.co', guestPhone: '520-555-0110',
        leaseType: 'nightly', checkIn: '2027-03-06', checkOut: '2027-03-13', source: 'direct',
      })
    expect(res.status).toBe(201)
    expect(await confirmationLogs()).toHaveLength(0)
    const [b] = await query<any>(`SELECT confirmation_sent_at, confirmation_sent_by FROM unit_bookings WHERE id = $1`, [res.body.data.id])
    expect(b.confirmation_sent_at).toBeNull()
    expect(b.confirmation_sent_by).toBeNull()
  })

  it('has exactly one caller in the whole API — the endpoint a person presses', () => {
    // The guard against the thing Nic is most afraid of, written where it
    // cannot rot: a hook on booking creation or a job sweeping for unsent
    // confirmations would show up here as a third caller.
    const root = path.join(__dirname, '..')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
        const src = fs.readFileSync(full, 'utf8')
        if (/\bsendBookingConfirmation\b/.test(src)) callers.push(path.relative(root, full))
      }
    }
    walk(root)
    expect(callers.sort()).toEqual(['routes/bookings.ts', 'services/bookingConfirmation.ts'])
  })
})

describe('sending a confirmation', () => {
  it('quotes the stay, offers the deposit with the card fee, and records the send', async () => {
    const f = await seed()
    const id = await reservation(f)
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    const { figures, deposit, sentTo } = res.body.data
    expect(sentTo).toBe('dale@mailer-test.co')
    expect(figures).toMatchObject({ nights: 7, firstMonthOnly: false, amount: 286.75, tax: 17.75, deposit: 28.68 })
    // The card page's own lines — the email can never quote a figure the page
    // will not charge.
    expect(deposit.deposit).toBe(28.68)
    expect(deposit.cardFee).toBe(1.55)
    expect(deposit.total).toBe(30.23)
    expect(deposit.url).toMatch(/\/api\/public\/pay\//)
    expect(await confirmationLogs()).toHaveLength(1)
    const [b] = await query<any>(`SELECT confirmation_sent_at, confirmation_sent_by, deposit_amount, deposit_pay_link_id
                                    FROM unit_bookings WHERE id = $1`, [id])
    expect(b.confirmation_sent_at).not.toBeNull()
    expect(b.confirmation_sent_by).toBe(f.userId)
    expect(Number(b.deposit_amount)).toBe(28.68)
    expect(b.deposit_pay_link_id).not.toBeNull()
  })

  it('reads the deposit rate off the property — 5% and 20%, not just 10', async () => {
    for (const [pct, expected, fee] of [[5, 14.34, 1.05], [20, 57.35, 2.56]] as const) {
      await cleanupAllSchema()
      const f = await seed({ depositPct: pct })
      const res = await sendConfirmation(f, await reservation(f))
      expect(res.status, `${pct}%`).toBe(200)
      expect(res.body.data.figures.deposit, `${pct}%`).toBe(expected)
      expect(res.body.data.deposit.deposit, `${pct}%`).toBe(expected)
      expect(res.body.data.deposit.cardFee, `${pct}%`).toBe(fee)
    }
  })

  it('is Nic\'s own example on a park with no lodging tax', async () => {
    // "stay a week at the 269 rate, we send them a deposit of 10%. They pay
    // their $26, $27, plus the card fee, and boom, they're confirmed."
    const f = await seed({ taxPct: 0 })
    const res = await sendConfirmation(f, await reservation(f, { total_amount: 269 }))
    expect(res.body.data.figures.amount).toBe(269)
    expect(res.body.data.figures.tax).toBeNull()
    expect(res.body.data.deposit.deposit).toBe(26.9)
    expect(res.body.data.deposit.cardFee).toBe(1.49)
    expect(res.body.data.deposit.total).toBe(28.39)
  })

  it('tells a seasonal guest their FIRST MONTH and asks the flat deposit', async () => {
    const f = await seed({ monthlyDeposit: 300 })
    const id = await reservation(f, {
      check_out: '2027-06-06', nights: 92, total_amount: 1767, stay_terms: 'stay',
    })
    const res = await sendConfirmation(f, id)
    expect(res.body.data.figures).toMatchObject({
      nights: 92, firstMonthOnly: true, amount: 589, firstMonthThrough: '2027-04-06', tax: null, deposit: 300,
    })
    expect(res.body.data.figures.heldThrough).toMatch(/held through June 6, 2027/)
    expect(res.body.data.deposit.deposit).toBe(300)
  })

  it('hands back the deposit link the reservation already has instead of a second one', async () => {
    const f = await seed()
    const id = await reservation(f)
    const first = await sendConfirmation(f, id)
    const url = first.body.data.deposit.url
    // An hour on, the guest says it never arrived.
    await query(`UPDATE unit_bookings SET confirmation_sent_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [id])
    const again = await sendConfirmation(f, id)
    expect(again.status).toBe(200)
    expect(again.body.data.deposit.url).toBe(url)
    // 10/24 (Nic): the email now carries TWO buttons — the deposit and the whole
    // stay — so one ask mints two links on purpose ("it's the deposit or the full
    // amount, no type box"). Asking again must still mint NEITHER a second time,
    // which a bare count would no longer tell us apart from a duplicate.
    const links = await query<any>(`SELECT label FROM pos_pay_links WHERE booking_id = $1`, [id])
    const deposits = links.filter((l: any) => /deposit/i.test(l.label))
    const wholes = links.filter((l: any) => /whole stay/i.test(l.label))
    expect(deposits).toHaveLength(1)
    expect(wholes.length).toBeLessThanOrEqual(1)
    expect(links).toHaveLength(deposits.length + wholes.length)
    expect(await confirmationLogs()).toHaveLength(2)
  })

  // ── 10/24 (Nic) — TWO BUTTONS: THE DEPOSIT OR THE WHOLE THING ─────────────
  //
  //   "I don't want them to have a type in amount that they pay. There's two
  //    buttons. They toggle the deposit amount or the full amount, and that's
  //    it... It's two buttons. It's the deposit or the full amount. No type box."
  //
  // A guest who wanted to settle up front had no way to: the deposit link
  // charges the deposit and no route anywhere lets a payer name a figure.
  it('mints a whole-stay link beside the deposit, for more money, and offers both', async () => {
    const f = await seed()
    const id = await reservation(f)
    const res = await sendConfirmation(f, id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const links = await query<any>(
      `SELECT label, total::float AS total, token FROM pos_pay_links WHERE booking_id = $1`, [id])
    const dep = links.find((l: any) => /deposit/i.test(l.label))
    const whole = links.find((l: any) => /whole stay/i.test(l.label))
    expect(dep).toBeTruthy()
    expect(whole).toBeTruthy()
    // The whole stay is the stay's own total, and it is MORE than the deposit —
    // two buttons for the same figure would be worse than one.
    const stay = await queryOne<any>(
      `SELECT total_amount::float AS total FROM unit_bookings WHERE id = $1`, [id])
    expect(whole.total).toBeCloseTo(stay.total, 2)
    expect(whole.total).toBeGreaterThan(dep.total)
    // Both are real, payable links of their own.
    expect(whole.token).not.toBe(dep.token)
  })

  it('offers no second button when the deposit already IS the whole stay', async () => {
    const f = await seed()
    // A monthly-tier stay owes the property's FLAT deposit, capped at one
    // month's rent (S547) — the percentage can only be 5/10/15/20, so this is
    // the path that can actually make the deposit equal the whole stay. A 30+
    // night stay totalling exactly the flat deposit leaves nothing more to ask
    // for, and a second button would be the same number twice.
    const id = await reservation(f, {
      check_in: '2027-03-01', check_out: '2027-04-01', nights: 31,
      total_amount: 150, lease_type: 'month_to_month',
    })
    expect((await sendConfirmation(f, id)).status).toBe(200)
    const links = await query<any>(`SELECT label, total::float AS total FROM pos_pay_links WHERE booking_id = $1`, [id])
    const whole = links.filter((l: any) => /whole stay/i.test(l.label))
    const dep = links.filter((l: any) => /deposit/i.test(l.label))
    // Either there is no second button, or the deposit genuinely asks for less
    // than the stay — never two buttons for one figure.
    if (whole.length) expect(whole[0].total).toBeGreaterThan(dep[0].total)
    else expect(dep.length).toBeGreaterThan(0)
  })

  it('quotes the deposit without a card page when there is nowhere to pay the landlord', async () => {
    const f = await seed()
    await query(`UPDATE landlords SET stripe_connect_account_id = NULL WHERE id = $1`, [f.landlordId])
    const res = await sendConfirmation(f, await reservation(f))
    // The dates and the price are still worth sending.
    expect(res.status).toBe(200)
    expect(res.body.data.deposit).toMatchObject({ deposit: 28.68, cardFee: 1.55, total: 30.23, url: null })
    expect(await confirmationLogs()).toHaveLength(1)
  })

  it('says nothing about a deposit where the property asks for none', async () => {
    // The percentage column only holds 5 / 10 / 15 / 20, so the park that asks
    // nothing is one whose flat long-stay deposit is zero. No deposit, no link,
    // and no deposit paragraph in the email.
    const f = await seed({ monthlyDeposit: 0 })
    const id = await reservation(f, { check_out: '2027-06-06', nights: 92, total_amount: 1767 })
    const res = await sendConfirmation(f, id)
    expect(res.body.data.figures.deposit).toBe(0)
    expect(res.body.data.deposit).toBeNull()
    expect(await query<any>(`SELECT id FROM pos_pay_links`)).toHaveLength(0)
  })
})

describe('a guest who has already paid', () => {
  // Most of Nic's board is about to be in this state: guests who paid him in
  // the old system, imported straight across. An email asking them for a
  // deposit, under a line about the site being given away, is the single worst
  // thing this build could send.
  it('is told their deposit is in, and is never asked for it again', async () => {
    const f = await seed()
    const id = await reservation(f)
    await query(`UPDATE unit_bookings SET deposit_amount = 28.68, deposit_paid_at = NOW() WHERE id = $1`, [id])
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit).toBeNull()
    expect(res.body.data.paid).toEqual({ kind: 'deposit', amount: 28.68 })
    // And no card page was made to ask them with.
    expect(await query<any>(`SELECT id FROM pos_pay_links`)).toHaveLength(0)
    expect(await confirmationLogs()).toHaveLength(1)
  })

  // ── 10/20 (defect) — THE GUEST WHO HAD ALREADY PAID FOR EVERYTHING ──────
  //
  // Dale pays his whole $286.75 on the card page, or hands it over at the
  // register. Both doors stamp the balance paid and leave no separate deposit
  // amount on the row. The confirmation then told him two things that were
  // both false: that a deposit of $28.68 — the property's 10%, a figure
  // nobody had ever charged him — was what he had paid, and that "the balance
  // is due when you arrive". A man who had paid in full read that he owed it
  // all again on the day. That is the worst thing this email can say to
  // somebody who has already paid, so it is pinned here first.
  it('a guest who paid the WHOLE stay is told so, and is never quoted a deposit they never paid', async () => {
    const f = await seed()
    const id = await reservation(f)
    await query(`UPDATE unit_bookings SET balance_paid_at = NOW() WHERE id = $1`, [id])
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit).toBeNull()
    expect(res.body.data.paid).toEqual({ kind: 'stay', amount: 286.75 })
    // The property's 10% is not a figure anybody paid, so it is nowhere near
    // what the guest is told.
    expect(JSON.stringify(res.body.data.paid)).not.toContain('28.68')
    expect(await confirmationLogs()).toHaveLength(1)
  })

  it('counts money that came any other way too, and says WHICH money it was', async () => {
    // deposit_amount is everything paid toward the reservation so far (the
    // pay link and the register both keep it that way), so a row with a
    // payment stamped on it and no amount beside it was paid WHOLE — GAM's
    // one definition of that (services/bookingLeaseDraft PAID_TOWARD_SQL),
    // never a fresh opinion invented in the confirmation.
    for (const col of ['balance_paid_at', 'deposit_paid_at']) {
      await cleanupAllSchema()
      const f = await seed()
      const id = await reservation(f)
      await query(`UPDATE unit_bookings SET ${col} = NOW() WHERE id = $1`, [id])
      const res = await sendConfirmation(f, id)
      expect(res.body.data.deposit, col).toBeNull()
      expect(res.body.data.paid, col).toEqual({ kind: 'stay', amount: 286.75 })
    }
  })

  it('a part payment is still a deposit, and the rest is still owed', async () => {
    const f = await seed()
    const id = await reservation(f)
    await query(`UPDATE unit_bookings SET deposit_amount = 100, deposit_paid_at = NOW() WHERE id = $1`, [id])
    const res = await sendConfirmation(f, id)
    expect(res.body.data.paid).toEqual({ kind: 'deposit', amount: 100 })
  })

  it('does not open a second card page while the booking site is taking the money', async () => {
    // The guest is on the website's own checkout right now, being asked for
    // this same deposit. Two card pages is how somebody pays twice.
    const f = await seed()
    const id = await reservation(f, { status: 'tentative' })
    await query(`UPDATE unit_bookings SET hold_expires_at = NOW() + INTERVAL '20 minutes' WHERE id = $1`, [id])
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit).toMatchObject({ deposit: 28.68, url: null })
    expect(await query<any>(`SELECT id FROM pos_pay_links`)).toHaveLength(0)
  })
})

describe('what it refuses, with nothing sent', () => {
  it('a second press inside the hour', async () => {
    const f = await seed()
    const id = await reservation(f)
    expect((await sendConfirmation(f, id)).status).toBe(200)
    const twice = await sendConfirmation(f, id)
    expect(twice.status).toBe(429)
    expect(twice.body.error).toMatch(/Dale Carter was emailed their confirmation a few minutes ago/)
    expect(twice.body.error).toMatch(/Nothing was sent\.$/)
    expect(await confirmationLogs()).toHaveLength(1)
  })

  it('a reservation with no email on it', async () => {
    const f = await seed()
    const res = await sendConfirmation(f, await reservation(f, { guest_email: null }))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/no email address on this reservation/)
    expect(res.body.error).toMatch(/Nothing was sent\.$/)
  })

  it('a reservation that is not holding its dates any more', async () => {
    const f = await seed()
    for (const status of ['cancelled', 'no_show', 'checked_out', 'checked_in']) {
      const res = await sendConfirmation(f, await reservation(f, { status }))
      expect(res.status, status).toBe(409)
      expect(res.body.error, status).toMatch(/Nothing was sent\.$/)
      expect(res.body.error, status).not.toMatch(/_/)      // no raw enum ever reaches a screen
    }
    expect(await confirmationLogs()).toHaveLength(0)
  })

  it('somebody who may schedule but may not take money, naming the boxes', async () => {
    const f = await seed()
    const id = await reservation(f)
    const token = await worker(f, { 'schedule.create_reservation': true })
    const res = await sendConfirmation(f, id, token)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Record a cash \/ check payment/)
    expect(res.body.error).toMatch(/Ring sales/)
    expect(res.body.error).toMatch(/Nothing was sent\.$/)
    expect(await confirmationLogs()).toHaveLength(0)
  })

  it('a desk at another landlord\'s property', async () => {
    const f = await seed()
    const other = await seed()
    const res = await sendConfirmation(f, await reservation(f), other.token)
    expect(res.status).toBe(403)
    expect(await confirmationLogs()).toHaveLength(0)
  })

  it('and it lets the pair through', async () => {
    const f = await seed()
    const id = await reservation(f)
    const token = await worker(f, { 'schedule.create_reservation': true, 'take_payment': true })
    expect((await sendConfirmation(f, id, token)).status).toBe(200)
  })
})
