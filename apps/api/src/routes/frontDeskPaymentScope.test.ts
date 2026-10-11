/**
 * S641 (Nic) — what the front desk sees on the Payments tab.
 *
 *   "I don't want her seeing the histories at all… You have payment history,
 *    covered by work trade and outstanding balances [on one tab]. The
 *    outstanding balances section of the payments tab is where you have to
 *    record a payment. My front desk needs to be able to record the damn
 *    payment."
 *
 * The tab was BLANK for her: the page renders three sections from one query and
 * that query returned an empty array to anybody without payments.view_all. So
 * `payments.view` is now the narrow grant it always read like — money still to
 * collect, and nothing else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedAllocationRule } from '../test/dbHelpers'
import { heldOwnerShareForUser } from '../services/landlordPassthrough'
import { paymentsRouter } from './payments'
import { balancesRouter } from './balances'
import { errorHandler } from '../middleware/errorHandler'
import { settleManualRentPayment } from '../services/manualPaymentSettle'
import { lockHousehold } from '../services/moneyPredicates'
import { cashBankingPosition } from '../services/cashBankingControl'

// A bank pull a settle replaced is canceled at Stripe after the commit.
const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentsRouter)
  app.use('/api/balances', balancesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_front_desk'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })

    // One rent row per lease per due date — ux_payments_rent_idempotent is what
    // stops a cycle being billed twice, so each of these is its own month.
    const mk = async (type: string, amount: number, status: string, suspended: boolean, monthsAgo: number) =>
      c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, work_trade_suspended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'RENT',CURRENT_DATE - ($9::int || ' months')::interval,$8)`,
        [ll.landlordId, unitId, leaseId, tenantId, type, amount, status,
         suspended ? new Date() : null, monthsAgo])

    await mk('rent', 460, 'pending', false, 0)   // owed — she must see this
    await mk('rent', 500, 'settled', false, 1)   // history — she must not
    await mk('rent', 300, 'pending', true,  2)   // work trade — she must not

    // the front desk user
    const fd = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
      [`fd-${Math.random().toString(36).slice(2)}@test.dev`])
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [fd.rows[0].id, ll.landlordId, [propertyId],
       JSON.stringify({ 'payments.view': true, 'balances.view': true, take_payment: true })])
    await c.query('COMMIT')

    const sign = (uid: string, role: string, perms: any, lid: string | null) => jwt.sign(
      { userId: uid, role, email: 'x@t.dev', profileId: role === 'landlord' ? lid : null,
        landlordId: ll.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    return {
      ll, tenantId, propertyId,
      ownerToken: sign(ll.userId, 'landlord', {}, ll.landlordId),
      deskToken: sign(fd.rows[0].id, 'onsite_manager',
        { 'payments.view': true, 'balances.view': true, take_payment: true }, null),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('the front desk Payments tab', () => {
  it('is no longer blank — the money still to collect comes back', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
  })

  it('shows ONLY what is owed — no settled history, no work trade', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.deskToken}`)
    const amounts = res.body.data.map((p: any) => Number(p.amount)).sort()
    expect(amounts).toEqual([460])
  })

  it('the owner still sees everything', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${f.ownerToken}`)
    const amounts = res.body.data.map((p: any) => Number(p.amount)).sort((a: number, b: number) => a - b)
    expect(amounts).toEqual([300, 460, 500])
  })

  it('a staff member with neither grant still gets nothing', async () => {
    const f = await seed()
    const bare = jwt.sign(
      { userId: '00000000-0000-0000-0000-000000000001', role: 'onsite_manager',
        email: 'x@t.dev', landlordId: f.ll.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/payments?limit=1000').set('Authorization', `Bearer ${bare}`)
    expect(res.body.data).toEqual([])
  })
})

describe('work trade stays private on the balances screen', () => {
  it('the figure is withheld from the front desk, not merely hidden on screen', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/balances/${f.tenantId}/invoices`).set('Authorization', `Bearer ${f.deskToken}`)
    expect(res.status).toBe(200)
    for (const inv of res.body.data) {
      expect(inv).not.toHaveProperty('work_trade_credit_amount')
      expect(inv).not.toHaveProperty('workTradeCreditAmount')
    }
  })

  it('the owner still gets it', async () => {
    const f = await seed()
    // An invoice belongs to a lease OR a service agreement, never neither.
    const { rows: [inv] } = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, unit_id, lease_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status, work_trade_credit_amount)
       SELECT $1, $2, u.id, l.id, 'INV-WT1', CURRENT_DATE, 460, 460, 'pending', 100
         FROM units u JOIN leases l ON l.unit_id = u.id
        WHERE u.property_id = $3 LIMIT 1
       RETURNING id`,
      [f.ll.landlordId, f.tenantId, f.propertyId])
    // The balances screen lists bills with something still owed on them: the
    // open $460 rent is this bill's line.
    await db.query(
      `UPDATE payments SET invoice_id = $1 WHERE tenant_id = $2 AND status = 'pending' AND work_trade_suspended_at IS NULL`,
      [inv.id, f.tenantId])
    const res = await request(buildApp())
      .get(`/api/balances/${f.tenantId}/invoices`).set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.some((i: any) => i.work_trade_credit_amount !== undefined)).toBe(true)
  })
})

// ── the two kinds of credit ─────────────────────────────────────────────────
//
// Nic: "Lisa should have all access to take payments in whatever form they come,
// including giving change out at the register… or applying credit to the next
// bill if that's what she wants. She cannot just issue random credits that a
// landlord would issue for, you know, waiving a late fee. Two different things
// there."
//
// An overpayment surplus is money ALREADY IN THE DRAWER — recording where it
// went is part of taking the payment. A discretionary credit creates money that
// was never received. I gated the first one as if it were the second, because
// the word "credit" matched, and that blocked a desk from recording the truth
// about cash they were holding.
describe('an overpayment at the counter', () => {
  async function openRentCharge() {
    const f = await seed()
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE status='pending' AND work_trade_suspended_at IS NULL LIMIT 1`)
    return { f, paymentId: rows[0].id }
  }

  it('the front desk can hand the change back', async () => {
    const { f, paymentId } = await openRentCharge()
    const res = await request(buildApp())
      .post(`/api/payments/${paymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.deskToken}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    expect(res.status).toBe(200)
  })

  // S648 (Nic): "They can't write a check for a hundred dollars over the rent
  // and use it like an ATM and just get cash out of the drawer."
  it('can never give change on a check — the extra is credit', async () => {
    const { f, paymentId } = await openRentCharge()
    const refused = await request(buildApp())
      .post(`/api/payments/${paymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.deskToken}`)
      .send({ method: 'check', reference: '170', amountTendered: 920, surplusHandling: 'change' })
    expect(refused.status).toBe(422)
    const { rows } = await db.query(`SELECT status FROM payments WHERE id=$1`, [paymentId])
    expect(rows[0].status).toBe('pending')
    const ok = await request(buildApp())
      .post(`/api/payments/${paymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.deskToken}`)
      .send({ method: 'check', reference: '170', amountTendered: 920, surplusHandling: 'credit', confirmWrittenAmount: true })
    expect(ok.status).toBe(200)
    expect(ok.body.data.creditId).toBeTruthy()
    expect(ok.body.data.surplus).toBeGreaterThan(0)
  })

  it('and can leave the surplus on the account for next month', async () => {
    const { f, paymentId } = await openRentCharge()
    const res = await request(buildApp())
      .post(`/api/payments/${paymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.deskToken}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status).toBe(200)
  })

  it('the owner can too', async () => {
    const { f, paymentId } = await openRentCharge()
    const res = await request(buildApp())
      .post(`/api/payments/${paymentId}/record-manual`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status).toBe(200)
  })
})


// ── S655 (money plan Step 8): the desk row of the payment matrix ────────────
describe('S655 the front desk takes the household balance', () => {
  async function desk() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query('COMMIT')
      const token = jwt.sign({ userId: ll.userId, role: 'landlord', email: 'x@t.dev', profileId: ll.landlordId,
        landlordId: ll.landlordId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
      return { ...ll, propertyId, unitId, leaseId, tenantId, token }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  type Desk = Awaited<ReturnType<typeof desk>>
  let n = 0
  const charge = async (d: Desk, amount: number, o: { type?: string; entry?: string; owner?: string; status?: string; pi?: string | null; monthsAgo?: number } = {}) =>
    (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, revenue_owner, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, DATE '2026-10-01' - ($9::int || ' months')::interval - ($10::int || ' days')::interval, $11, $12)
       RETURNING id`,
      [d.landlordId, d.unitId, d.leaseId, d.tenantId, o.type ?? 'rent', amount, o.status ?? 'pending',
       o.entry ?? (o.type === 'utility' ? 'UTILITY' : o.type === 'carried_balance' ? 'BALANCE' : o.type === 'home_payment' ? 'HOMEPMT' : 'RENT'),
       o.monthsAgo ?? 0, n++, o.owner ?? 'landlord', o.pi ?? null])).rows[0].id
  const paidAhead = (d: Desk, amount: number, fundedBy: 'landlord' | 'gam') => db.query(
    `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
     VALUES ($1,$2,$3,$3,$4, NOW() - INTERVAL '20 days')`, [d.leaseId, d.tenantId, amount, fundedBy])
  const record = (d: Desk, paymentId: string, body: any) => request(buildApp())
    .post(`/api/payments/${paymentId}/record-manual`).set('Authorization', `Bearer ${d.token}`).send(body)
  const statusOf = async (id: string) => (await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status

  it('bug 1: check-funded paid-ahead used at the desk records no GAM payout', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'landlord')                    // a check the landlord already deposited
    const res = await record(d, rent, { method: 'cash', amountTendered: 0, creditToUse: 460 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows: [p] } = await db.query<any>(`SELECT status, platform_held FROM payments WHERE id=$1`, [rent])
    expect(p).toEqual({ status: 'settled', platform_held: false })
    expect((await db.query(`SELECT 1 FROM user_balance_ledger WHERE reference_id=$1`, [rent])).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE landlord_id=$1`, [d.landlordId])).rowCount).toBe(0)
    expect(await heldOwnerShareForUser(d.userId)).toBe(0)
    const { rows: uses } = await db.query<any>(`SELECT status, source FROM credit_uses`)
    expect(uses).toEqual([{ status: 'applied', source: 'desk' }])
  })

  it('GAM-held paid-ahead at the desk books the owner share with no fee, marks the row platform_held, and the weekly batch reserves it', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'gam')                         // came through Stripe: GAM holds it
    const res = await record(d, rent, { method: 'cash', amountTendered: 0, creditToUse: 460 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows: [p] } = await db.query<any>(`SELECT platform_held FROM payments WHERE id=$1`, [rent])
    expect(p.platform_held).toBe(true)
    const share = await db.query<{ amount: string }>(
      `SELECT amount::text FROM user_balance_ledger WHERE reference_id=$1 AND type='allocation_owner_share'`, [rent])
    expect(share.rows.map(r => Number(r.amount))).toEqual([460])
    // No second processing fee: GAM's fee was taken when the money arrived.
    expect((await db.query(
      `SELECT 1 FROM user_balance_ledger WHERE reference_id=$1 AND type <> 'allocation_owner_share' AND amount <> 0`, [rent])).rowCount).toBe(0)
    expect(await heldOwnerShareForUser(d.userId)).toBe(460)
  })

  it('GAM-held credit the payout cannot take yet: the desk is told to Save, and nothing is recorded', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'gam')
    // A property whose payout setup is unfinished (no allocation rule).
    await db.query(`DELETE FROM property_allocation_rules WHERE property_id = $1`, [d.propertyId])
    const res = await record(d, rent, { method: 'cash', amountTendered: 0, creditToUse: 460 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Choose Save to take the payment without the credit/)
    expect(await statusOf(rent)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    // Saved, the cash still pays the bill.
    const saved = await record(d, rent, { method: 'cash', amountTendered: 460, creditToUse: 0 })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  })

  it('the desk leaves GAM-owned and in-flight rows open and shows the GAM line', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    const gamFee = await charge(d, 15, { type: 'fee', entry: 'RETURNFEE', owner: 'gam' })
    const clearing = await charge(d, 40, { type: 'utility', status: 'processing', pi: 'pi_clearing' })
    const q = await request(buildApp()).get(`/api/payments/${rent}/record-manual/quote`).set('Authorization', `Bearer ${d.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({ currentTotal: 460, payOnlineTotal: 15, clearing: 40, fullBalance: 475 })
    const res = await record(d, rent, { method: 'cash', amountTendered: 460 })
    expect(res.status).toBe(200)
    expect(await statusOf(rent)).toBe('settled')
    expect(await statusOf(gamFee)).toBe('pending')
    expect(await statusOf(clearing)).toBe('processing')
  })

  it('the desk settles a home payment', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    const home = await charge(d, 200, { type: 'home_payment' })
    const res = await record(d, rent, { method: 'money_order', reference: 'MO-7', amountTendered: 660 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf(home)).toBe('settled')
  })

  it('carried arrears are paid last from what is over, never required', async () => {
    const d = await desk()
    const old = await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const rent = await charge(d, 460)
    // Exact current bill: accepted, the old balance untouched — it is never required.
    const exact = await record(d, rent, { method: 'cash', amountTendered: 460 })
    expect(exact.status).toBe(200)
    expect(await statusOf(old)).toBe('pending')
    // A check over the next bill pays the old balance down with the extra, in part.
    const rent2 = await charge(d, 460, { monthsAgo: -1 })
    const over = await record(d, rent2, { method: 'check', reference: '88', amountTendered: 700, confirmWrittenAmount: true })
    expect(over.status, JSON.stringify(over.body)).toBe(200)
    expect(over.body.data.towardOldBalance).toBe(240)
    expect(over.body.data.creditId).toBeNull()
    const parts = await db.query<any>(
      `SELECT amount::text AS amount, status, is_remainder FROM payments WHERE type='carried_balance' ORDER BY is_remainder`)
    expect(parts.rows).toEqual([
      { amount: '240.00', status: 'settled', is_remainder: false },
      { amount: '760.00', status: 'pending', is_remainder: true },
    ])
    // Cash only goes to the old balance when the desk says so.
    const rent3 = await charge(d, 460, { monthsAgo: -2 })
    const cash = await record(d, rent3, { method: 'cash', amountTendered: 500, towardOldBalance: 40 })
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    expect(cash.body.data.towardOldBalance).toBe(40)
  })

  it('every desk action writes one receipt with no gross amount; a credit-only settle writes none', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await charge(d, 40, { type: 'utility' })
    const res = await record(d, rent, { method: 'check', reference: '1042', amountTendered: 500 })
    expect(res.status).toBe(200)
    const rem = await db.query<any>(
      `SELECT id, amount::float AS amount, gross_amount, payment_method, reference, received_by, status FROM tenant_remittances`)
    expect(rem.rows).toEqual([{ id: res.body.data.receiptId, amount: 500, gross_amount: null, payment_method: 'check',
      reference: '1042', received_by: d.userId, status: 'settled' }])
    const apps = await db.query<any>(`SELECT amount_applied::float AS a FROM remittance_applications ORDER BY a`)
    expect(apps.rows.map((r: any) => r.a)).toEqual([40, 460])
    // Credit pays a later bill whole: no receipt for money that did not change hands.
    const next = await charge(d, 460, { monthsAgo: -1 })
    await paidAhead(d, 460, 'landlord')
    const credit = await record(d, next, { method: 'cash', amountTendered: 0, creditToUse: 460 })
    expect(credit.status, JSON.stringify(credit.body)).toBe(200)
    expect(credit.body.data.receiptId).toBeNull()
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(1)
    // Its uses stand alone: linked to no receipt.
    const { rows: uses } = await db.query<any>(`SELECT remittance_id, amount::float AS amount FROM credit_uses`)
    expect(uses).toEqual([{ remittance_id: null, amount: 460 }])
  })

  // Fix pass 1: plan §1.1 — a receipt's credit used is the sum of its uses.
  it('the desk receipt carries the credit it used: its uses sum to the credit used, and the tenant\'s receipt list says so', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill')`, [d.landlordId, d.tenantId, d.leaseId])
    const res = await record(d, rent, { method: 'cash', amountTendered: 400, creditToUse: 100, surplusHandling: 'change' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const receiptId = res.body.data.receiptId
    expect(receiptId).toBeTruthy()
    const { rows: uses } = await db.query<any>(
      `SELECT remittance_id, SUM(amount)::float AS amount, array_agg(DISTINCT status) AS statuses FROM credit_uses GROUP BY remittance_id`)
    expect(uses).toEqual([{ remittance_id: receiptId, amount: res.body.data.creditUsed, statuses: ['applied'] }])
    expect(res.body.data.creditUsed).toBe(100)
    // The receipt is the money (handed over less change); the credit is its own figure beside it.
    const { rows: [t] } = await db.query<any>(`SELECT user_id FROM tenants WHERE id=$1`, [d.tenantId])
    const tenantToken = jwt.sign({ userId: t.user_id, role: 'tenant', email: 't@t.dev', profileId: d.tenantId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const list = await request(buildApp()).get('/api/payments/remittances').set('Authorization', `Bearer ${tenantToken}`)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    const shown = JSON.stringify(list.body)
    expect(shown).toContain(receiptId)
    const body = list.body.data ?? list.body
    const rows: any[] = Array.isArray(body) ? body : (body.remittances ?? [])
    const mine = rows.find((r: any) => r.id === receiptId)
    expect(mine).toBeTruthy()
    expect(Number(mine.amount)).toBe(360)
    expect(Number(mine.creditUsed ?? mine.credit_used)).toBe(100)
  })

  // decisions #11 (Step 9 sweep reads the receipt this desk writes): a tenant
  // who reported a bank deposit at a company with no bank linked has the report
  // closed as "recorded by your landlord" once the desk records the payment.
  it('a desk payment closes the tenant\'s reported bank deposit at a company with no bank linked', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    const { rows: [rep] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,460, CURRENT_DATE - 2, 'cash') RETURNING id`, [d.tenantId, d.leaseId, d.landlordId])
    try {
      const res = await record(d, rent, { method: 'cash', amountTendered: 460 })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const { resolveReportsRecordedByLandlord } = await import('../jobs/declaredDepositExpiry')
      const out = await resolveReportsRecordedByLandlord()
      expect(out).toEqual({ recorded: 1, errors: [] })
      const { rows: [after] } = await db.query<any>(
        `SELECT status, recorded_remittance_id FROM tenant_declared_deposits WHERE id=$1`, [rep.id])
      expect(after).toEqual({ status: 'recorded', recorded_remittance_id: res.body.data.receiptId })
    } finally {
      // The report now points at the receipt; the shared cleanup clears receipts first.
      await db.query(`DELETE FROM tenant_declared_deposits WHERE id=$1`, [rep.id])
    }
  })

  it('a check over the bill becomes landlord-funded paid-ahead dated the day it was taken', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    const res = await record(d, rent, { method: 'check', reference: '1043', amountTendered: 920, confirmWrittenAmount: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const { rows: [c] } = await db.query<any>(
      `SELECT amount_original::float AS amount, funded_by, received_at::date = CURRENT_DATE AS today, source_remittance_id
         FROM lease_prepaid_credits WHERE id=$1`, [res.body.data.creditId])
    expect(c).toEqual({ amount: 460, funded_by: 'landlord', today: true, source_remittance_id: res.body.data.receiptId })
  })

  it('the receipt states the desk\'s answer for the extra: change, or kept as credit with no change on hand', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    const kept = await record(d, rent, { method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(kept.status, JSON.stringify(kept.body)).toBe(200)
    const { rows: [r1] } = await db.query<any>(`SELECT amount::float AS amount, notes FROM tenant_remittances WHERE id=$1`, [kept.body.data.receiptId])
    expect(r1.amount).toBe(500)
    expect(r1.notes).toBe('Handed over $500.00; $40.00 kept as credit — no change on hand.')
    const next = await charge(d, 460, { monthsAgo: -1 })
    const change = await record(d, next, { method: 'cash', amountTendered: 500, surplusHandling: 'change', creditToUse: 0 })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    const { rows: [r2] } = await db.query<any>(`SELECT amount::float AS amount, notes FROM tenant_remittances WHERE id=$1`, [change.body.data.receiptId])
    expect(r2.amount).toBe(460)
    expect(r2.notes).toBe('Handed over $500.00; $40.00 given back as change.')
    const after = await charge(d, 460, { monthsAgo: -2 })
    const check = await record(d, after, { method: 'money_order', reference: 'MO-1', amountTendered: 486, confirmWrittenAmount: true, creditToUse: 0 })
    expect(check.status, JSON.stringify(check.body)).toBe(200)
    const { rows: [r3] } = await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id=$1`, [check.body.data.receiptId])
    expect(r3.notes).toBe('Handed over a money order for $486.00 (amount confirmed); $26.00 over the bill kept as credit.')
  })

  it('a check over the bill is refused until the written amount is confirmed, and nothing is recorded', async () => {
    const d = await desk()
    const rent = await charge(d, 485.45)
    const res = await record(d, rent, { method: 'money_order', reference: 'MO-486', amountTendered: 486 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/You typed \$486\.00 against \$485\.45 owed — is the money order really \$486\.00\?/)
    expect(await statusOf(rent)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  // Fix pass 2: a moved-out resident paying a final bill with a check over it
  // has no lease here to hold the extra. The desk is told that once — never
  // first asked "is the check really $X?" and then refused — and nothing is
  // written, not even the split of a part-paid old balance.
  it('a check over the bill with no lease to hold the extra is refused once with the no-lease message, never asked to confirm the amount', async () => {
    const d = await desk()
    const old = await charge(d, 300, { type: 'carried_balance', monthsAgo: 6 })
    const rent = await charge(d, 460)
    await db.query(`UPDATE leases SET status = 'terminated' WHERE id = $1`, [d.leaseId])
    for (const confirmWrittenAmount of [undefined, true]) {
      const res = await record(d, rent, { method: 'check', reference: '2001', amountTendered: 900, confirmWrittenAmount })
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error).toBe('This resident has no lease here to hold a credit on, so a check over the bill cannot be taken.')
      expect(res.body.error).not.toMatch(/really/)
    }
    expect(await statusOf(rent)).toBe('pending')
    expect(await statusOf(old)).toBe('pending')
    const { rows: oldRows } = await db.query<any>(
      `SELECT amount::float AS amount FROM payments WHERE type = 'carried_balance' ORDER BY amount`)
    expect(oldRows).toEqual([{ amount: 300 }])
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits`)).rowCount).toBe(0)
    // The exact amount (nothing over) still records against the final bill.
    const exact = await record(d, rent, { method: 'check', reference: '2001', amountTendered: 460 })
    expect(exact.status, JSON.stringify(exact.body)).toBe(200)
    expect(await statusOf(rent)).toBe('settled')
  })

  it('a row the credit paid in full is noted as paid with account credit, not as cash', async () => {
    const d = await desk()
    // Created second, so dated a day earlier: the rent is the older bill and the credit pays it first.
    const water = await charge(d, 40, { type: 'utility' })
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'landlord')
    const res = await record(d, rent, { method: 'cash', amountTendered: 40, creditToUse: 460 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const notes = async (id: string) => (await db.query<any>(`SELECT notes FROM payments WHERE id=$1`, [id])).rows[0].notes
    expect(await notes(rent)).toBe('Paid with account credit (recorded at the desk)')
    expect(await notes(water)).toBe('Recorded as manual cash payment')
  })

  // Fix round 1: the drawer paid nothing for a row the credit paid in full,
  // so no method is written on it — it is never "collected cash not banked"
  // and never shown "Paid by Cash".
  it('a row the credit paid in full carries no payment method and is never counted as cash to bank', async () => {
    const d = await desk()
    const water = await charge(d, 40, { type: 'utility' })
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'landlord')
    const res = await record(d, rent, { method: 'cash', amountTendered: 40, creditToUse: 460 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const method = async (id: string) => (await db.query<any>(`SELECT manual_method FROM payments WHERE id=$1`, [id])).rows[0].manual_method
    expect(await method(rent)).toBeNull()
    expect(await method(water)).toBe('cash')
    const later = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const pos = await cashBankingPosition(d.landlordId, { asOf: later, graceDays: 0 })
    expect(pos.unbanked.map(u => [u.paymentId, u.amount])).toEqual([[water, 40]])
    expect(pos.unbankedTotal).toBe(40)
    const list = await request(buildApp()).get('/api/payments?limit=1000').set('Authorization', `Bearer ${d.token}`)
    const paidBy = (id: string) => list.body.data.find((p: any) => p.id === id)?.paid_by
    expect(paidBy(rent)).toBeNull()
    expect(paidBy(water)).toBe('cash')
  })

  it('$0 handed over, the bill paid wholly by paid-ahead money: no cash is reported as collected', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'landlord')
    const res = await record(d, rent, { method: 'cash', amountTendered: 0, creditToUse: 460 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await db.query<any>(`SELECT manual_method FROM payments WHERE id=$1`, [rent])).rows[0].manual_method).toBeNull()
    const later = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const pos = await cashBankingPosition(d.landlordId, { asOf: later, graceDays: 0 })
    expect(pos.unbanked).toEqual([])
    expect(pos.unbankedTotal).toBe(0)
  })

  // The bank-deposit match settles one row at a time (settleOneRow), and
  // follows §3 like every other settle.
  const bankMatch = async (d: Desk, paymentId: string) => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await lockHousehold(c, d.tenantId, d.landlordId)
      const r = await settleManualRentPayment(c, {
        payment: { id: paymentId, landlord_id: d.landlordId, tenant_id: d.tenantId, unit_id: d.unitId,
                   lease_id: d.leaseId, due_date: '2026-10-01' },
        method: 'check', settledAt: new Date(), provenance: 'matched to a bank deposit posted 2026-10-02',
      })
      await c.query('COMMIT')
      await r.afterCommit()
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('a bank match over a scheduled retry gives back its held credit, clears the pull and cancels it', async () => {
    stripeCancel.mockClear()
    const d = await desk()
    const rent = await charge(d, 460)
    const water = await charge(d, 40, { type: 'utility' })
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill') RETURNING id`, [d.landlordId, d.tenantId, d.leaseId])
    // A bank pull for both lines bounced and is scheduled to retry, with $100 of credit set aside on the rent.
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,400,400,0,'ach','pi_old_pull','failed') RETURNING id`, [d.tenantId, d.leaseId, d.landlordId])
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_old_pull', next_retry_at = NOW() + INTERVAL '2 days'
        WHERE id = ANY($1::uuid[])`, [[rent, water]])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,'2026-10-01','portal','held')`, [credit.id, rent, rem.id, d.leaseId])
    const left = async () => Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [credit.id])).rows[0].amount_remaining)
    expect(await left()).toBe(0)

    await bankMatch(d, rent)
    const row = async (id: string) => (await db.query<any>(`SELECT status, manual_method, next_retry_at FROM payments WHERE id=$1`, [id])).rows[0]
    expect(await row(rent)).toMatchObject({ status: 'settled', manual_method: 'check', next_retry_at: null })
    // The other line on that pull loses its schedule too: the pull is replaced, never re-run.
    expect(await row(water)).toMatchObject({ status: 'failed', next_retry_at: null })
    const { rows: uses } = await db.query<any>(`SELECT status, release_reason FROM credit_uses`)
    expect(uses).toEqual([{ status: 'released', release_reason: 'superseded' }])
    expect(await left()).toBe(100)                               // the credit is theirs again
    expect(stripeCancel).toHaveBeenCalledWith('pi_old_pull')
  })

  it('a bank match never settles a row whose money is already on its way', async () => {
    const d = await desk()
    const onItsWay = await charge(d, 460, { pi: 'pi_on_its_way' })
    await expect(bankMatch(d, onItsWay)).rejects.toMatchObject({ statusCode: 409 })
    const clearing = await charge(d, 40, { type: 'utility', status: 'processing', pi: 'pi_clearing' })
    await expect(bankMatch(d, clearing)).rejects.toMatchObject({ statusCode: 409 })
    const { rows } = await db.query<any>(`SELECT status, manual_method FROM payments ORDER BY amount`)
    expect(rows).toEqual([{ status: 'processing', manual_method: null }, { status: 'pending', manual_method: null }])
  })

  it('the desk window never counts GAM\'s FlexPay pull as money clearing', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await charge(d, 1025, { type: 'fee', entry: 'FLEXPAY', owner: 'gam', status: 'processing', pi: 'pi_flexpay_pull' })
    await charge(d, 40, { type: 'utility', status: 'processing', pi: 'pi_card_clearing' })
    const q = await request(buildApp()).get(`/api/payments/${rent}/record-manual/quote`).set('Authorization', `Bearer ${d.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data.clearing).toBe(40)
    expect(JSON.stringify(q.body.data)).not.toMatch(/FLEXPAY/i)
  })

  it('using credit allows only cash change for a surplus', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,100,100,'goodwill')`, [d.landlordId, d.tenantId, d.leaseId])
    const asCredit = await record(d, rent, { method: 'cash', amountTendered: 400, creditToUse: 100, surplusHandling: 'credit' })
    expect(asCredit.status).toBe(422)
    expect(asCredit.body.error).toMatch(/only be handed back as change/)
    const check = await record(d, rent, { method: 'check', reference: '9', amountTendered: 400, creditToUse: 100, confirmWrittenAmount: true })
    expect(check.status).toBe(422)
    expect(await statusOf(rent)).toBe('pending')
    const change = await record(d, rent, { method: 'cash', amountTendered: 400, creditToUse: 100, surplusHandling: 'change' })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    expect(change.body.data).toMatchObject({ creditUsed: 100, changeGiven: 40, creditId: null })
  })

  // Fix pass 1: the desk is told once, with the next step — never asked to
  // confirm a check's amount "against $0.00 owed" and then refused anyway.
  it('credit paying the whole bill with a check handed over is refused once as "Save the credit instead", never asked to confirm the amount first', async () => {
    const d = await desk()
    const rent = await charge(d, 460)
    await paidAhead(d, 460, 'landlord')
    for (const confirmWrittenAmount of [undefined, true]) {
      const res = await record(d, rent, { method: 'check', reference: '77', amountTendered: 460, creditToUse: 460, confirmWrittenAmount })
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('Credit is being used on this bill and the check is $460.00 over it. Save the credit instead.')
      expect(res.body.error).not.toMatch(/You typed/)
    }
    expect(await statusOf(rent)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    // Save: the check pays the bill exactly, so there is nothing to confirm.
    const save = await record(d, rent, { method: 'check', reference: '77', amountTendered: 460, creditToUse: 0 })
    expect(save.status, JSON.stringify(save.body)).toBe(200)
    expect(save.body.data).toMatchObject({ creditUsed: 0, amountSettled: 460 })
  })

  // ── Fix round 2 ────────────────────────────────────────────────────────────
  // decisions.md: the desk treats carried arrears like the portal — paid last,
  // from whatever is over the current bill. Cash the desk KEEPS is over the
  // bill, so it pays the old balance before any of it becomes credit.
  it('cash kept as credit with an old balance open pays the old balance first', async () => {
    const d = await desk()
    const old = await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const rent = await charge(d, 460)
    const res = await record(d, rent, { method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ towardOldBalance: 40, surplus: 0, changeGiven: 0, creditId: null, amountSettled: 500 })
    expect(await statusOf(rent)).toBe('settled')
    const parts = await db.query<any>(
      `SELECT amount::text AS amount, status, is_remainder FROM payments WHERE type='carried_balance' ORDER BY is_remainder`)
    expect(parts.rows).toEqual([
      { amount: '40.00', status: 'settled', is_remainder: false },
      { amount: '960.00', status: 'pending', is_remainder: true },
    ])
    expect(old).toBeTruthy()
    // No paid-ahead money sits beside the open old balance.
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits`)).rowCount).toBe(0)
    const { rows: [rem] } = await db.query<any>(
      `SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied, notes
         FROM tenant_remittances WHERE id=$1`, [res.body.data.receiptId])
    expect(rem).toEqual({ amount: 500, applied: 500, unapplied: 0,
      notes: 'Handed over $500.00; $40.00 went to the old balance.' })
  })

  it('cash kept beyond a small old balance: the old balance is paid off, only the rest becomes credit, and the receipt says both', async () => {
    const d = await desk()
    await charge(d, 30, { type: 'carried_balance', monthsAgo: 8 })
    const rent = await charge(d, 460)
    const res = await record(d, rent, { method: 'cash', amountTendered: 500, surplusHandling: 'credit' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ towardOldBalance: 30, surplus: 10, changeGiven: 0 })
    expect(res.body.data.creditId).toBeTruthy()
    expect((await db.query<any>(`SELECT status FROM payments WHERE type='carried_balance'`)).rows).toEqual([{ status: 'settled' }])
    const { rows: [c] } = await db.query<any>(
      `SELECT amount_original::float AS amount, funded_by FROM lease_prepaid_credits WHERE id=$1`, [res.body.data.creditId])
    expect(c).toEqual({ amount: 10, funded_by: 'landlord' })
    const { rows: [rem] } = await db.query<any>(`SELECT notes FROM tenant_remittances WHERE id=$1`, [res.body.data.receiptId])
    expect(rem.notes).toBe('Handed over $500.00; $30.00 went to the old balance; the other $10.00 kept as credit — no change on hand.')
  })

  it('the change-or-keep question says kept cash pays the old balance first; change leaves the old balance alone', async () => {
    const d = await desk()
    const old = await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const rent = await charge(d, 460)
    const ask = await record(d, rent, { method: 'cash', amountTendered: 500 })
    expect(ask.status).toBe(422)
    expect(ask.body.error).toBe(
      'That is $40.00 over the $460.00 being paid. Choose "Give $40.00 change" or "Keep it — no change on hand" ($40.00 pays the old balance first).')
    const change = await record(d, rent, { method: 'cash', amountTendered: 500, surplusHandling: 'change' })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    expect(change.body.data).toMatchObject({ towardOldBalance: 0, changeGiven: 40 })
    expect(await statusOf(old)).toBe('pending')
  })

  it('money kept with a smaller old-balance amount typed is refused and nothing is recorded', async () => {
    const d = await desk()
    await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const rent = await charge(d, 460)
    const res = await record(d, rent, { method: 'cash', amountTendered: 500, towardOldBalance: 10, surplusHandling: 'credit' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/Money kept on the account pays the old balance first: \$40\.00 of the \$40\.00 over the bill goes to the \$1000\.00 old balance/)
    expect(await statusOf(rent)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    // Handed back as change, the desk may still say how much went to the old balance.
    const split = await record(d, rent, { method: 'cash', amountTendered: 500, towardOldBalance: 10, surplusHandling: 'change' })
    expect(split.status, JSON.stringify(split.body)).toBe(200)
    expect(split.body.data).toMatchObject({ towardOldBalance: 10, changeGiven: 30 })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::float AS amount, notes FROM tenant_remittances WHERE id=$1`, [split.body.data.receiptId])
    expect(rem).toEqual({ amount: 470, notes: 'Handed over $500.00; $10.00 went to the old balance; $30.00 given back as change.' })
  })

  it('probe P7: $0 handed over with only an old balance open is refused — never "recorded" for nothing', async () => {
    const d = await desk()
    const old = await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const res = await record(d, old, { method: 'cash', amountTendered: 0 })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('Enter the amount handed over — only the old balance is open here, and it is paid with money.')
    const back = await record(d, old, { method: 'cash', amountTendered: 50, towardOldBalance: 0, surplusHandling: 'change' })
    expect(back.status).toBe(422)
    expect(back.body.error).toMatch(/^Nothing would be paid/)
    expect(await statusOf(old)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    // Money for it records.
    const ok = await record(d, old, { method: 'cash', amountTendered: 50 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ towardOldBalance: 50, settledPaymentIds: [old] })
  })

  // verify r2: with only an old balance open, a check is how it gets paid —
  // the written-amount question names the old balance, never "$0.00 owed".
  it('a check against an old balance only is asked about against the old balance, and names both once a bill is open too', async () => {
    const d = await desk()
    const old = await charge(d, 1000, { type: 'carried_balance', monthsAgo: 8 })
    const ask = await record(d, old, { method: 'check', reference: '501', amountTendered: 500 })
    expect(ask.status).toBe(422)
    expect(ask.body.error).toBe(
      'You typed $500.00 toward the $1000.00 old balance — is the check really $500.00? Check the amount written on it, then confirm.')
    expect(await statusOf(old)).toBe('pending')
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
    const ok = await record(d, old, { method: 'check', reference: '501', amountTendered: 500, confirmWrittenAmount: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ towardOldBalance: 500, creditId: null })
    // A current bill open beside what is left of the old balance: both are named.
    const rent = await charge(d, 460, { monthsAgo: -1 })
    const both = await record(d, rent, { method: 'money_order', reference: 'MO-9', amountTendered: 600 })
    expect(both.status).toBe(422)
    expect(both.body.error).toMatch(
      /^You typed \$600\.00 against the \$460\.00 bill and a \$500\.00 old balance — is the money order really \$600\.00\?/)
    expect(await statusOf(rent)).toBe('pending')
  })

  // A bank retry on a space in eviction hold sets credit aside on a row the
  // desk does not take. The desk never offers that credit (spending it took
  // the credit below zero: a raw database error), and Use spends only what is
  // free at the desk.
  it('credit a bank retry holds on a space in eviction hold is not offered at the desk; Use spends only the free part', async () => {
    const d = await desk()
    const c = await db.connect()
    let unitB = '', leaseB = ''
    try {
      await c.query('BEGIN')
      unitB = await seedUnit(c, { propertyId: d.propertyId, landlordId: d.landlordId })
      leaseB = await seedLease(c, { unitId: unitB, landlordId: d.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: leaseB, tenantId: d.tenantId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const rentA = await charge(d, 400, { monthsAgo: 1 })                  // the older bill, space A
    const { rows: [b] } = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, next_retry_at)
       VALUES ($1,$2,$3,$4,'rent',300,'failed','RENT',DATE '2026-10-01','pi_b_retry', NOW() + INTERVAL '2 days') RETURNING id`,
      [d.landlordId, unitB, leaseB, d.tenantId])
    // A $300 general credit; a bank pull on space B that bounced is retrying with $200 of it set aside.
    const { rows: [credit] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,300,300,'goodwill') RETURNING id`, [d.landlordId, d.tenantId])
    const { rows: [rem] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, stripe_payment_intent_id, status)
       VALUES ($1,$2,$3,100,100,0,'ach','pi_b_retry','failed') RETURNING id`, [d.tenantId, leaseB, d.landlordId])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,200,'2026-10-01','portal','held')`, [credit.id, b.id, rem.id, leaseB])
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [unitB])     // space B: eviction hold
    const left = async () => Number((await db.query<any>(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [credit.id])).rows[0].amount_remaining)
    expect(await left()).toBe(100)

    const q = await request(buildApp()).get(`/api/payments/${rentA}/record-manual/quote`).set('Authorization', `Bearer ${d.token}`)
    expect(q.status).toBe(200)
    expect(q.body.data).toMatchObject({ currentTotal: 400, creditAvailable: 100, creditSetAsideElsewhere: 200, owedIfUsed: 300, pausedTotal: 300 })
    // The figure the old window showed (the whole $300) is refused plainly, nothing recorded.
    const stale = await record(d, rentA, { method: 'cash', amountTendered: 100, creditToUse: 300 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/now \$100\.00/)
    expect(await statusOf(rentA)).toBe('pending')
    const use = await record(d, rentA, { method: 'cash', amountTendered: 300, creditToUse: 100 })
    expect(use.status, JSON.stringify(use.body)).toBe(200)
    expect(use.body.data).toMatchObject({ creditUsed: 100, amountSettled: 300 })
    expect(await statusOf(rentA)).toBe('settled')
    expect(await left()).toBe(0)
    // Space B's retry and the credit it holds are untouched.
    const { rows: [rowB] } = await db.query<any>(`SELECT status, next_retry_at IS NOT NULL AS scheduled FROM payments WHERE id=$1`, [b.id])
    expect(rowB).toEqual({ status: 'failed', scheduled: true })
    const held = await db.query<any>(`SELECT amount::float AS amount FROM credit_uses WHERE status='held'`)
    expect(held.rows).toEqual([{ amount: 200 }])
  })
})
