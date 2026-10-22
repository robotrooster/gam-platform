/**
 * 10/20 (review) — THE CONFIRMATION'S CARD PAGE AND THE BACKGROUND CHECK ON IT.
 *
 * A 25-night reservation with nothing on file owes GAM a background check
 * before the guest can check in, and its fee rides on whatever payment the stay
 * is handed to (R8/A2). The confirmation mints a deposit card page, so it is
 * one of those payments — and it was minting one with no check line on it.
 *
 * That is not a short quote, it is money nobody ever asks for again: a deposit
 * link CLAIMS the reservation's deposit_amount, so the schedule's "Ask for the
 * deposit" afterwards is handed the fee-less page back for ever, no prepaid
 * check is recorded for the guest, and check-in sits waiting on a check nobody
 * paid for. The two doors quoted different money for the same reservation.
 *
 * So what is pinned here is that both doors ask ONE question
 * (services/stayTerms screeningFeeToCarry) and get one answer — and that when
 * that question cannot be answered, NO page is minted, because a page minted
 * without the fee can never have it added.
 *
 * Run (the 10/22 migrations are not on production yet):
 *   DB_NAME=gam_sc_test TEST_DB_NAME=gam_sc_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/bookingConfirmationScreeningFee.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// The guest's confirmation is read as the guest reads it, caught at the Resend
// boundary. The client is a mock, so nothing can leave this machine.
const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_conf_fee' }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

// The one question both doors ask — real, except in the one test that needs it
// to fail, which is the fail-safe this file exists to pin.
const { feeAnswerBoom } = vi.hoisted(() => ({ feeAnswerBoom: { on: false } }))
vi.mock('../services/stayTerms', async (orig) => {
  const actual = await orig<any>()
  return {
    ...actual,
    screeningFeeToCarry: async (...args: any[]) => {
      if (feeAnswerBoom.on) throw new Error('the database said no')
      return actual.screeningFeeToCarry(...args)
    },
  }
})

// The counter's own tax run is not what this is about.
vi.mock('../services/posTax', async (orig) => ({
  ...(await orig<any>()),
  calculateCartTax: async (_l: string, cart: any[]) => ({
    subtotal: cart.reduce((s: number, l: any) => s + l.qty * l.unitPrice, 0),
    taxAmount: 0,
    lines: cart.map((l: any) => ({ ...l, taxRate: 0, tax: 0 })),
  }),
}))

let bookingsRouter: any, unitsRouter: any, errorHandler: any, screeningIntakeFee: any
beforeEach(async () => {
  feeAnswerBoom.on = false
  resendSendMock.mockClear()
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_confirmation_screening'
  ;({ bookingsRouter } = await import('./bookings'))
  ;({ unitsRouter } = await import('./units'))
  ;({ screeningIntakeFee } = await import('./background'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

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

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * What the check costs this applicant, asked of the one function that sells
 * them (routes/background screeningIntakeFee) rather than written down here —
 * this test is about WHERE the fee lands, not what it is.
 *
 * 10/21 (Nic): that is the whole intake price now, processing included, and a
 * screening line never takes a card fee on top of it. One price for a check
 * however it is paid for.
 */
const checkFee = async (state = 'AZ') => (await screeningIntakeFee(state)).total

/** Nic's own rates: $49 a night, $269 a week, $589 a month, 6.60% lodging tax. */
async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park', booking_deposit_pct = 10, short_term_tax_rate = 6.6,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589,
              booking_card_fee_payer = 'customer'
        WHERE id = $1`, [propertyId])
    // A deposit link refuses to go out with nowhere to pay the landlord.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_sf_' || replace($1::text,'-','') WHERE id = $1`,
      [landlordId])
    const unit = await c.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, weekly_rate, monthly_rate, is_bookable)
       VALUES ($1,$2,'RV 11','vacant',500,'rv_spot',49,269,589,TRUE) RETURNING id`,
      [propertyId, landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId: unit.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * A reservation written straight onto the board, the way the import and a text
 * thread land one: 25 nights — past the three weeks that need a check, short of
 * the 30 that ask lease-or-stay — at a price the counter typed by hand.
 */
async function reservation(over: Record<string, any> = {}, f?: any): Promise<string> {
  const row = {
    check_in: '2027-03-06', check_out: '2027-03-31', nights: 25, total_amount: 1000,
    status: 'confirmed', lease_type: 'nightly', guest_name: 'Dale Carter',
    guest_email: 'dale@mailer-test.co', stay_terms: null, ...over,
  }
  const r = await query<{ id: string }>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, nights,
        total_amount, status, lease_type, stay_terms, source, booked_check_out)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'direct',$6) RETURNING id`,
    [f!.unitId, f!.landlordId, row.guest_name, row.guest_email, row.check_in, row.check_out,
     row.nights, row.total_amount, row.status, row.lease_type, row.stay_terms])
  return r[0].id
}

const sendConfirmation = (f: any, bookingId: string) =>
  request(buildApp()).post(`/api/bookings/${bookingId}/confirmation`)
    .set('Authorization', `Bearer ${f.token}`).send({})

const askForDeposit = (f: any, bookingId: string) =>
  request(buildApp()).post(`/api/units/${f.unitId}/bookings/${bookingId}/deposit-link`)
    .set('Authorization', `Bearer ${f.token}`).send({})

const linkRows = () => query<any>(
  `SELECT id, label, total::float AS total, items FROM pos_pay_links ORDER BY created_at`)
const checkLinesIn = (links: any[]) => links.flatMap(l =>
  (Array.isArray(l.items) ? l.items : []).filter((i: any) => i?.screening === true))
const confirmationLogs = () => query<any>(
  `SELECT status FROM email_send_log WHERE category = 'booking_confirmation'`)

describe('the check\'s fee rides on the page the confirmation offers', () => {
  it('bills the check with the deposit, and the schedule hands back that very page', async () => {
    const f = await seed()
    const id = await reservation({}, f)
    const fee = await checkFee()
    expect(fee).toBeGreaterThan(0)

    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    const { figures, deposit } = res.body.data
    expect(figures.deposit).toBe(100)            // 10% of the $1,000 it was sold at
    // THE DEFECT: this was 0. The fee was on no page, so nobody was ever billed
    // for a check the guest's check-in waits on.
    expect(deposit.screening).toBe(fee)
    expect(deposit.deposit).toBe(100)
    expect(deposit.cardFee).toBeGreaterThan(0)
    expect(deposit.total).toBe(round2(100 + fee + deposit.cardFee))
    expect(deposit.url).toMatch(/\/api\/public\/pay\//)

    // The card page itself: one deposit line, one check line, and a label that
    // says what it is.
    const links = await linkRows()
    expect(links).toHaveLength(1)
    expect(links[0].total).toBe(round2(100 + fee))
    expect(links[0].label).toMatch(/background check/i)
    const checks = checkLinesIn(links)
    expect(checks).toHaveLength(1)
    expect(Number(checks[0].price)).toBe(fee)

    // ── AND THE OTHER DOOR QUOTES THE SAME MONEY ──────────────────────────
    // The schedule's "Ask for the deposit" used to be handed the fee-less page
    // back here, for ever, because the confirmation's link had claimed the
    // deposit and a second one can never be made.
    const ask = await askForDeposit(f, id)
    expect(ask.status).toBe(200)
    expect(ask.body.data.link.id).toBe(links[0].id)
    expect(ask.body.data.link.amount).toBe(round2(100 + fee))
    expect(ask.body.data.link.label).toMatch(/background check/i)

    // One fee per stay, never two.
    const after = await linkRows()
    expect(after).toHaveLength(1)
    expect(checkLinesIn(after)).toHaveLength(1)
  })

  it('tells the guest which part of that total is not a choice', async () => {
    const f = await seed()
    const id = await reservation({}, f)
    const fee = await checkFee()
    process.env.EMAIL_SEND_LIVE = '1'
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)

    const html = (resendSendMock.mock.calls.map(c => (c as any[])[0])
      .find((m: any) => /reservation at Mountain View RV Park/i.test(m.subject)) as any).html
    // The figure is on the page before they pay, under its own name.
    expect(html).toMatch(/Background check:/)
    expect(html).toContain(fee.toFixed(2))
    // And it is not offered as optional, the way the deposit beside it is.
    expect(html).toMatch(/background check is required before check-in/i)
    expect(html).toMatch(/you are not charged for it again/i)
    expect(html).toMatch(/Paying the deposit is your choice\./)
  })

  it('mints no page at all when it cannot tell whether the fee belongs on one', async () => {
    // A page minted while that question is unanswered is the defect again and
    // cannot be put right afterwards: minting it takes the claim. So the
    // deposit is quoted, the office takes it, and the reservation is left
    // askable.
    const f = await seed()
    const id = await reservation({}, f)
    feeAnswerBoom.on = true

    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit).toMatchObject({ deposit: 100, screening: 0, url: null })
    expect(await linkRows()).toHaveLength(0)
    const [b] = await query<any>(`SELECT deposit_amount, deposit_pay_link_id FROM unit_bookings WHERE id = $1`, [id])
    expect(b.deposit_amount).toBeNull()
    expect(b.deposit_pay_link_id).toBeNull()
    // The dates and the price were still worth sending.
    expect(await confirmationLogs()).toHaveLength(1)
  })

  it('leaves a week-long stay alone — no check, no line, no extra money', async () => {
    const f = await seed()
    const id = await reservation({ check_out: '2027-03-13', nights: 7, total_amount: 286.75 }, f)
    const res = await sendConfirmation(f, id)
    expect(res.status).toBe(200)
    expect(res.body.data.deposit.screening).toBe(0)
    const links = await linkRows()
    expect(links).toHaveLength(1)
    expect(links[0].total).toBe(28.68)
    expect(checkLinesIn(links)).toHaveLength(0)
  })
})
