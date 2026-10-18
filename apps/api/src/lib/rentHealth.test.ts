/**
 * 10/17 (Nic) — THE DASHBOARD'S PAYMENT-HEALTH PERCENTAGE TELLS THE TRUTH.
 *
 *   "I've got $2,000 in outstanding rent, but my payment health is only showing
 *    sixty-five percent... When I pick Mountain View, it goes up to 67%. That is
 *    crazy wrong for how few people have left to pay."
 *
 * And the rule: "the property health matches what was invoiced and what was
 * paid. work trade isnt billed until a shortfall so it shouldnt apply here
 * unless an invoice generates."
 *
 * The card divided the Money billed figures, and both halves were wrong for
 * this question once a company's books went live (Mountain View, 10/14):
 *
 *   (a) rent ON HOLD FOR WORK TRADE counted as billed and unpaid — the books
 *       charge it on its due day, the money records leave it out until the
 *       work-trade month settles (services/ledgerParity names that difference);
 *   (b) rent SETTLED BY AN ACCOUNT CREDIT (or by money paid ahead) counted as
 *       unpaid — the bill is settled, but no money arrived this month.
 *
 * One test per defect, on the books, plus the two together as a percentage. The
 * money cards keep their own meaning throughout — that is asserted here too,
 * because it is the reason health needed a figure of its own.
 *
 * The world is Mountain View's October in miniature, one bill of each kind:
 *   $1,000 paid in cash · $589 settled by an account credit · $460 still owed
 *   · $460 on hold for work trade
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db, query } from '../db'
import { tenantCo, bill, receipt, issuedCredit, spend, addLease, drain, cleanupTenantLedger, type TenantCo } from '../test/ledgerTenantFixtures'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from '../services/ledgerProjectors'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { collectedRentMtd, rentHealthMtd } from './rentCollected'
import { todayIn, monthStartOf } from './timezone'
import express, { type Router } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { camelCaseKeys } from './caseConversion'
import { landlordsRouter } from '../routes/landlords'
import { reportsRouter } from '../routes/reports'
import { errorHandler } from '../middleware/errorHandler'

const MONTH = '2026-10-15'
const DUE = '2026-10-01'
/**
 * The day the ENDPOINTS read: /dashboard and /reports/summary take the month
 * off the Phoenix clock, with no month to pass them, so their fixtures are
 * dated off the same clock. Pinned to October, those tests would have gone red
 * on 11/01 — and they are the only cover on the handler path.
 */
const THIS_MONTH_FIRST = monthStartOf(todayIn(null))
/** The first of the month before `first` (a bill still owed from last month). */
function monthBefore(first: string): string {
  const [y, m] = first.split('-').map(Number)
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
}

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

/** Rent on hold for work trade: billed gross, settled in HOURS at month close (S624). */
async function hold(paymentId: string, at = '2026-10-01T08:00:00-07:00'): Promise<void> {
  await db.query(`UPDATE payments SET work_trade_suspended_at = $2 WHERE id = $1`, [paymentId, at])
}

interface World extends TenantCo { paid: string; byCredit: string; owed: string; held: string; due: string }

/**
 * @param o.live the company's books are live (Mountain View since 10/14)
 * @param o.due  the day the bills are due, default the fixed October above.
 *               The endpoint tests pass THIS_MONTH_FIRST.
 */
async function world(o: { live?: boolean; due?: string } = {}): Promise<World> {
  const due = o.due ?? DUE
  const ym = due.slice(0, 7)
  const co = await tenantCo()
  const paid = await bill(co, { amount: 1000, due })
  await receipt(co, { method: 'cash', settledAt: `${ym}-03T17:00:00Z`, apps: [{ paymentId: paid, amount: 1000 }] })
  // The resident whose off-platform money was given back to her as an account
  // credit: the credit settles the bill in full, and no money arrives.
  const second = await addLease(co, co.propertyId)
  const byCredit = await bill(co, { amount: 589, due, unitId: second.unitId, leaseId: second.leaseId })
  const credit = await issuedCredit(co, { amount: 589, category: 'goodwill', leaseId: second.leaseId })
  await spend(co, { paymentId: byCredit, amount: 589, appliedAt: `${ym}-14T12:00:00-07:00`, tenantCreditId: credit, leaseId: second.leaseId })
  const third = await addLease(co, co.propertyId)
  const owed = await bill(co, { amount: 460, due, unitId: third.unitId, leaseId: third.leaseId })
  const fourth = await addLease(co, co.propertyId)
  const held = await bill(co, { amount: 460, due, unitId: fourth.unitId, leaseId: fourth.leaseId })
  await hold(held, `${ym}-01T08:00:00-07:00`)
  await drain()
  if (o.live ?? true) await markLedgerLive(co.landlordId)
  return { ...co, paid, byCredit, owed, held, due }
}

/**
 * One invoice per bill, the shape the invoice writers leave behind: the bill
 * carries its invoice_id and the invoice's total_amount is the bill. A line on
 * hold for work trade sits OUTSIDE total_amount (S654), so a held bill is given
 * none. The dashboard's Outstanding card reads these and nothing else.
 */
async function invoiceEach(paymentIds: readonly string[]): Promise<void> {
  for (const id of paymentIds) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount)
       SELECT landlord_id, tenant_id, lease_id, unit_id, 'INV-' || left($2, 8), due_date, amount
         FROM payments WHERE id = $1 RETURNING id`, [id, id])
    await db.query(`UPDATE payments SET invoice_id = $2 WHERE id = $1`, [id, r.rows[0].id])
  }
}

describe('the payment-health percentage reads invoiced against paid', () => {
  it('rent on hold for work trade is in NEITHER figure — it is named on its own', async () => {
    const w = await world()
    const h = await rentHealthMtd([w.landlordId], null, { month: MONTH })
    // $460 of the $2,509 billed is on hold: out of invoiced, out of paid, and
    // out of owed. Nobody owes it — it settles in hours, and only a shortfall
    // ever becomes a bill.
    expect(h.invoiced).toBe(2049)
    expect(h.workTradeHeld).toBe(460)
    expect(h.owed).toBe(460)          // the one resident who really owes rent
    expect(h.invoiced + h.workTradeHeld).toBe(2509)

    // Why health needed its own figure: the books charge the held bill on its
    // due day like any other, so Money billed counts it — correctly, for the
    // question IT answers. That card is unchanged.
    const card = await collectedRentMtd([w.landlordId], null, { month: MONTH })
    expect(card.billed.amount).toBe(2509)
  })

  it('a bill settled by an account credit is PAID, though no money arrived', async () => {
    const w = await world()
    const h = await rentHealthMtd([w.landlordId], null, { month: MONTH })
    // $1,000 in cash and the $589 the credit settled.
    expect(h.paid).toBe(1589)

    // Money received is $1,000: that is what arrived, and it stays $1,000 —
    // the books' "received against bills" never sees a credit, which is exactly
    // what used to drag the percentage down.
    const card = await collectedRentMtd([w.landlordId], null, { month: MONTH })
    expect(card.billed.collected).toBe(1000)
  })

  it('the two together: 78%, not the 40% the money card gave', async () => {
    const w = await world()
    const h = await rentHealthMtd([w.landlordId], null, { month: MONTH })
    expect(Math.round((h.paid / h.invoiced) * 100)).toBe(78)
    const card = await collectedRentMtd([w.landlordId], null, { month: MONTH })
    expect(Math.round((card.billed.collected / card.billed.amount) * 100)).toBe(40)
  })

  it("owed is THIS MONTH'S RENT left to collect, and stays that when other money is open", async () => {
    const w = await world()
    const h = await rentHealthMtd([w.landlordId], null, { month: MONTH })
    expect(h.owed).toBe(Math.round((h.invoiced - h.paid) * 100) / 100)
    // The month's own open rent, work trade netted out.
    const [open] = await query<{ owed: string }>(
      `SELECT COALESCE(SUM(p.amount), 0)::text AS owed FROM payments p
        WHERE p.landlord_id = $1 AND p.type = 'rent' AND p.status IN ('pending', 'failed')
          AND p.work_trade_suspended_at IS NULL AND p.due_date >= $2::date`, [w.landlordId, DUE])
    expect(Number(open.owed)).toBe(h.owed)

    // September's rent and this month's water are real debts, and the
    // Outstanding card beside this one counts them. This figure must NOT: Nic
    // asked for "what was invoiced and what was paid" on the month's rent, and
    // folding a cumulative receivables balance into it would be the same kind
    // of wrong the percentage already had. The two cards answer different
    // questions, which the endpoint test below proves out of one reply.
    const fifth = await addLease(w, w.propertyId)
    await bill(w, { amount: 500, due: '2026-09-01', unitId: fifth.unitId, leaseId: fifth.leaseId })
    await bill(w, { amount: 120, due: DUE, type: 'utility', unitId: fifth.unitId, leaseId: fifth.leaseId })
    expect(await rentHealthMtd([w.landlordId], null, { month: MONTH })).toEqual(h)
  })

  it('reads the same for a company whose books are not live yet — it is the bills either way', async () => {
    const w = await world({ live: false })
    const h = await rentHealthMtd([w.landlordId], null, { month: MONTH })
    expect(h).toEqual({ invoiced: 2049, paid: 1589, owed: 460, workTradeHeld: 460 })
  })

  it('scopes to the chosen property, and an empty list sees nothing', async () => {
    const w = await world()
    const other = await addLease(w, w.propertyId2)
    await bill(w, { amount: 300, due: DUE, unitId: other.unitId, leaseId: other.leaseId })
    expect((await rentHealthMtd([w.landlordId], w.propertyId, { month: MONTH })).invoiced).toBe(2049)
    expect((await rentHealthMtd([w.landlordId], w.propertyId2, { month: MONTH })).invoiced).toBe(300)
    expect((await rentHealthMtd([w.landlordId], [w.propertyId, w.propertyId2], { month: MONTH })).invoiced).toBe(2349)
    expect((await rentHealthMtd([w.landlordId], [], { month: MONTH })).invoiced).toBe(0)
  })

  it('a voided charge is in no figure, and a month of its own is read', async () => {
    const w = await world()
    const fifth = await addLease(w, w.propertyId)
    const void_ = await bill(w, { amount: 777, due: DUE, unitId: fifth.unitId, leaseId: fifth.leaseId })
    await db.query(
      `UPDATE payments SET status = 'voided', voided_at = now(), void_reason = 'billed twice' WHERE id = $1`, [void_])
    expect((await rentHealthMtd([w.landlordId], null, { month: MONTH })).invoiced).toBe(2049)
    // November has no rent bills of its own.
    expect(await rentHealthMtd([w.landlordId], null, { month: '2026-11-15' }))
      .toEqual({ invoiced: 0, paid: 0, owed: 0, workTradeHeld: 0 })
  })
})

/**
 * The wire contract: the API answers in snake_case and the camelCase
 * middleware in index.ts (not on the router) is what the dashboard reads. A
 * figure that never reaches the screen under the name the screen asks for is
 * no fix at all, so the percentage is read here the way the card reads it.
 *
 * These drive the real endpoints, which read the month off the Phoenix clock —
 * so their bills are dated off the same clock (THIS_MONTH_FIRST), never pinned
 * to the October the figures above use.
 */
function buildApp(...routers: Array<[string, Router]>) {
  const app = express()
  app.use(express.json())
  // The same middleware index.ts wraps every response in.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  for (const [path, router] of routers) app.use(path, router)
  app.use(errorHandler)
  return app
}

function pass(w: World, o: { role?: string; permissions?: Record<string, boolean> } = {}): string {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_rent_health'
  // A landlord's scope is the account's entities (landlordIds); a team role's
  // is the one company on the landlordId claim (lib/landlordScope).
  return jwt.sign(
    { userId: w.ownerUserId, role: o.role ?? 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [w.landlordId], landlordId: w.landlordId, permissions: o.permissions ?? {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

describe('the dashboard hands the card its own figure', () => {
  it('sends rentHealth beside the rent card, and the card reads 78% off it', async () => {
    const w = await world({ due: THIS_MONTH_FIRST })
    const r = await request(buildApp(['/api/landlords', landlordsRouter]))
      .get(`/api/landlords/me/dashboard?propertyId=${w.propertyId}`).set('Authorization', `Bearer ${pass(w)}`)
    expect(r.status).toBe(200)
    expect(r.body.data.rentHealth).toEqual({ invoiced: 2049, paid: 1589, owed: 460, workTradeHeld: 460 })
    const h = r.body.data.rentHealth
    // What the card draws: paid over invoiced, rounded (the landlord portal's
    // rentBillsPaidRate, covered by its own test).
    expect(Math.round((h.paid / h.invoiced) * 100)).toBe(78)
    // The money card is beside it, with its own meaning untouched.
    expect(r.body.data.rentCard.billed.amount).toBe(2509)
  })

  /**
   * 10/17 (review): the health card's "left to collect" and the Outstanding
   * card sit side by side on one screen and are NOT the same money — a fact
   * worth a test, because the tempting "fix" is to make one of them match the
   * other. Outstanding is every open invoice balance of every month and every
   * charge; this is the month's rent. Oak Park reads $3,300 against $8,354.43
   * on 10/17 for exactly the reason this fixture does.
   */
  it('the Outstanding card counts other months and other charges; this figure does not', async () => {
    const w = await world({ due: THIS_MONTH_FIRST })
    const fifth = await addLease(w, w.propertyId)
    const lastMonthRent = await bill(
      w, { amount: 500, due: monthBefore(w.due), unitId: fifth.unitId, leaseId: fifth.leaseId })
    const water = await bill(w, { amount: 120, due: w.due, type: 'utility', unitId: fifth.unitId, leaseId: fifth.leaseId })
    // Every bill that carries an invoiced balance (the held one carries none).
    await invoiceEach([w.paid, w.byCredit, w.owed, lastMonthRent, water])

    const r = await request(buildApp(['/api/landlords', landlordsRouter]))
      .get(`/api/landlords/me/dashboard?propertyId=${w.propertyId}`).set('Authorization', `Bearer ${pass(w)}`)
    expect(r.status).toBe(200)
    // The month's rent left to collect: the one resident who really owes it.
    expect(r.body.data.rentHealth.owed).toBe(460)
    // Outstanding: that $460 plus last month's rent and this month's water.
    expect(r.body.data.outstanding).toBe(1080)
  })
})

/**
 * Reports draws its cards from the same helper by design, so the two surfaces
 * cannot drift. Nothing on the Reports page draws the percentage today — this
 * holds the figure and its gate in place until something does.
 */
describe('Reports sends the same figure, gated like its Outstanding card', () => {
  it('carries the dashboard\'s rentHealth, to the cent', async () => {
    const w = await world({ due: THIS_MONTH_FIRST })
    const app = buildApp(['/api/landlords', landlordsRouter], ['/api/reports', reportsRouter])
    const tok = pass(w)
    const dash = await request(app).get('/api/landlords/me/dashboard').set('Authorization', `Bearer ${tok}`)
    const rep = await request(app).get('/api/reports/summary').set('Authorization', `Bearer ${tok}`)
    expect(rep.status).toBe(200)
    expect(rep.body.data.rentHealth).toEqual({ invoiced: 2049, paid: 1589, owed: 460, workTradeHeld: 460 })
    expect(rep.body.data.rentHealth).toEqual(dash.body.data.rentHealth)
  })

  // decisions #25: `owed` is a grand total of what everyone owes, so it goes
  // out with the Outstanding card or not at all.
  it('leaves it out for a viewer who sees no grand totals', async () => {
    const w = await world({ due: THIS_MONTH_FIRST })
    const tok = pass(w, { role: 'onsite_manager', permissions: { 'payments.view_all': true } })
    const r = await request(buildApp(['/api/reports', reportsRouter]))
      .get('/api/reports/summary').set('Authorization', `Bearer ${tok}`)
    expect(r.status).toBe(200)
    expect(r.body.data.rentHealth).toBeUndefined()
    expect(r.body.data.outstanding).toBeUndefined()
  })
})
