/**
 * 10/12 (Nic): "We need people to be billed correctly regardless of signing
 * status."
 *
 * Country Acres MH 18 and MH 24: the landlord signed both installment
 * contracts on 9/22, the buyers had not, and their October bills went out with
 * rent and water and no home payment — a home sale only started billing when
 * the BUYER signed. A lease bills on the landlord's signature (S647); now a
 * home sale does too. These run the real signing route, with the contract
 * written the way the packet writes it: no lease link on it at all.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'
import { activateHomeSaleContract, applySaleTermsFromDocument, createHomeSaleContract, reconcileAllHomeSaleContracts } from '../services/homeSale'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { voidDocument } from '../lib/voidDocument'

const TZ = 'America/Chicago'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_home_sale_landlord_signs'
})

/** 'YYYY-MM-01' for the park's month `offset` months from now. */
async function parkMonth(offset: number): Promise<string> {
  return (await queryOne<{ m: string }>(
    `SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE $1)::date) + ($2::int || ' months')::interval, 'YYYY-MM-DD') AS m`,
    [TZ, offset]))!.m
}
const typedMonth = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/**
 * An installment contract, as the packet drafts it: the landlord signs first
 * (S535), then the buyer. The landlord TYPES the terms (S652).
 */
async function draftAgreement(c: any, o: {
  landlordId: string; landlordUser: string; unitId: string; leaseId: string; tenantUser: string
  firstPayment: string; monthly?: string
}): Promise<string> {
  const docId = (await c.query(
    `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
     VALUES ($1,$2,$3,'Installment contract','purchase_agreement','sent') RETURNING id`,
    [o.landlordId, o.unitId, o.leaseId])).rows[0].id as string
  const llEmail = (await c.query(`SELECT email FROM users WHERE id = $1`, [o.landlordUser])).rows[0].email
  await c.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','Owner',$3,1,$4,'sent'), ($1,$5,'primary','Buyer','buyer@test.dev',2,$6,'sent')`,
    [docId, o.landlordUser, llEmail, randomUUID(), o.tenantUser, randomUUID()])
  for (const [col, value] of [['sale_monthly_payment', o.monthly ?? '$150'], ['sale_term_months', '12'],
                              ['sale_first_payment_month', typedMonth(o.firstPayment)],
                              ['sale_final_payment_amount', ''], ['sale_final_payment_month', '']]) {
    await c.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, value)
       VALUES ($1,'text','landlord',$2,$2,1,10,10,100,20,false,NULLIF($3,''))`, [docId, col, value])
  }
  return docId
}

/**
 * A park-owned home, a buyer renting the lot on an active lease, this month's
 * bill already out ($450 rent + $16.50 water), and an installment contract
 * drafted for $150 × 12 with its first payment `firstPaymentOffset` months
 * from now. The park started billing on GAM this month: anything earlier was
 * paid outside GAM.
 */
async function seed(o: { firstPaymentOffset?: number; billStatus?: 'pending' | 'settled' } = {}) {
  const thisMonth = await parkMonth(0)
  const firstPayment = await parkMonth(o.firstPaymentOffset ?? -2)
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, state: 'IL' })
    await c.query(`UPDATE properties SET timezone = $2, first_billing_cycle = $3 WHERE id = $1`, [propertyId, TZ, thisMonth])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, unitType: 'mobile_home' })
    await c.query(`UPDATE units SET dwelling_ownership = 'landlord' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const tenantUser = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450, leaseType: 'month_to_month' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,450,16.50,466.50,'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-HS-${randomUUID().slice(0, 8)}`, thisMonth])).rows[0].id
    for (const [type, amount, desc] of [['rent', 450, 'RENT'], ['utility', 16.5, 'UTILITY']] as const) {
      await c.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [invoiceId, unitId, leaseId, tenantId, ll.landlordId, type, amount,
         o.billStatus === 'settled' ? 'settled' : 'pending', thisMonth, desc])
    }
    const docId = await draftAgreement(c, {
      landlordId: ll.landlordId, landlordUser: ll.userId, unitId, leaseId, tenantUser, firstPayment })
    await c.query('COMMIT')
    const sign = (userId: string, role: string, profileId: string) =>
      jwt.sign({ userId, role, email: `${userId}@t.dev`, profileId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordId: ll.landlordId, landlordUser: ll.userId, unitId, tenantId, tenantUser, leaseId, invoiceId, docId, thisMonth, firstPayment,
      landlordToken: sign(ll.userId, 'landlord', ll.landlordId),
      buyerToken: sign(tenantUser, 'tenant', tenantId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const homeLines = (invoiceId: string) => query<any>(
  `SELECT amount::float AS amount, status, notes, lease_id, due_date::text AS due_date
     FROM payments WHERE invoice_id = $1 AND type = 'home_payment' ORDER BY notes`, [invoiceId])
const bill = (invoiceId: string) => queryOne<any>(
  `SELECT total_amount::float AS total, subtotal_home_payments::float AS home, status FROM invoices WHERE id = $1`, [invoiceId])
const sale = (unitId: string) => queryOne<any>(
  `SELECT id, status, lease_id, installments_billed, installments_paid,
          (SELECT COUNT(*)::int FROM home_sale_installments i WHERE i.contract_id = c.id) AS installments,
          (SELECT COUNT(*)::int FROM home_sale_installments i WHERE i.contract_id = c.id AND i.settled_off_platform_at IS NOT NULL) AS paid_outside
     FROM home_sale_contracts c WHERE unit_id = $1 AND status <> 'cancelled'`, [unitId])

describe("10/12: the landlord's signature starts a home sale billing", () => {
  it("puts this month's home payment on the buyer's open bill the moment the landlord signs — with no lease on the contract", async () => {
    const s = await seed()
    const res = await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const c = await sale(s.unitId)
    expect(c).toMatchObject({ status: 'active', lease_id: null, installments: 12 })
    // The two months before the park's first billing cycle were paid outside
    // GAM; the third — this month — is on this month's bill.
    expect(c.paid_outside).toBe(2)
    expect(c.installments_billed).toBe(3)
    expect(c.installments_paid).toBe(2)
    expect(await homeLines(s.invoiceId)).toEqual([
      { amount: 150, status: 'pending', notes: 'Home payment 3 of 12', lease_id: s.leaseId, due_date: s.thisMonth },
    ])
    expect(await bill(s.invoiceId)).toMatchObject({ total: 616.5, home: 150, status: 'pending' })
  })

  it('the buyer signing afterwards bills nothing twice', async () => {
    const s = await seed()
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const res = await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.buyerToken}`).send({ fieldValues: [] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.completed).toBe(true)

    const c = await sale(s.unitId)
    expect(c).toMatchObject({ status: 'active', installments: 12, installments_billed: 3 })
    expect(await homeLines(s.invoiceId)).toHaveLength(1)
    expect(await bill(s.invoiceId)).toMatchObject({ total: 616.5, home: 150 })
    const all = await query<any>(`SELECT 1 FROM payments WHERE type = 'home_payment'`)
    expect(all).toHaveLength(1)
  })

  it('a bill already paid never grows a line — the monthly run bills it instead', async () => {
    const s = await seed({ billStatus: 'settled' })
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    expect((await sale(s.unitId)).status).toBe('active')
    expect(await homeLines(s.invoiceId)).toHaveLength(0)
    expect(await bill(s.invoiceId)).toMatchObject({ total: 466.5, status: 'settled' })
    const waiting = await query<any>(
      `SELECT i.installment_number FROM home_sale_installments i JOIN home_sale_contracts c ON c.id = i.contract_id
        WHERE c.unit_id = $1 AND i.payment_id IS NULL AND i.settled_off_platform_at IS NULL AND i.billing_month <= $2::date`,
      [s.unitId, s.thisMonth])
    expect(waiting.map(w => w.installment_number)).toEqual([3])
  })

  it('months still to come never bill early — the same rule a lease follows', async () => {
    const s = await seed({ firstPaymentOffset: 1 })
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const c = await sale(s.unitId)
    expect(c).toMatchObject({ status: 'active', installments: 12, paid_outside: 0, installments_billed: 0 })
    expect(await homeLines(s.invoiceId)).toHaveLength(0)
    expect(await bill(s.invoiceId)).toMatchObject({ total: 466.5, home: 0 })
  })

  it("a buyer who belongs to another company waits for their own signature (S655)", async () => {
    const s = await seed()
    // Not this company's resident (no lease here) and tied to another company.
    await db.query(`UPDATE lease_tenants SET status = 'void' WHERE lease_id = $1`, [s.leaseId])
    const other = await (async () => {
      const c = await db.connect()
      try { await c.query('BEGIN'); const o = await seedLandlord(c); await c.query('COMMIT'); return o }
      finally { c.release() }
    })()
    const otherDoc = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, title, document_type, status)
       VALUES ($1,'Their lease elsewhere','general_contract','sent') RETURNING id`, [other.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'party_1','Buyer','buyer@test.dev',1,$3,'sent')`, [otherDoc, s.tenantUser, randomUUID()])

    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const waiting = await queryOne<any>(`SELECT status FROM home_sale_contracts WHERE unit_id = $1`, [s.unitId])
    expect(waiting.status).toBe('pending_signature')

    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.buyerToken}`).send({ fieldValues: [] }).expect(200)
    expect((await sale(s.unitId)).status).toBe('active')
  })
})

/**
 * "A charge the tenant could not have seen cannot make them late." An
 * installment that joins a bill AFTER the bill went late never keeps it late:
 * the fee already on it stays as it was, and no new fee starts because of it.
 */
describe('a home payment added to a bill that is already late', () => {
  async function lateBill() {
    const s = await seed()
    // The bill came due ten days ago; grace is 3 days; $50 on day 3, then $5 a
    // day. The rent was paid on day 4. The water is still owed when the
    // landlord signs — the bill is still open, so the home payment joins it —
    // and is paid right after (settleTheRest): from then on the home payment
    // is the only thing unpaid on the bill.
    const due = (await queryOne<{ d: string }>(`SELECT ((NOW() AT TIME ZONE $1)::date - 10)::text AS d`, [TZ]))!.d
    const month = due.slice(0, 7) + '-01'
    await db.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = (SELECT property_id FROM units WHERE id = $1)`, [s.unitId, month])
    await db.query(
      `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = 3,
              late_fee_initial_type = 'flat', late_fee_initial_amount = 50,
              late_fee_accrual_type = 'flat', late_fee_accrual_amount = 5, late_fee_accrual_period = 'daily',
              late_fee_accrual_from = 'grace_end'
        WHERE id = $1`, [s.leaseId])
    // Written three days before it came due, the way the monthly run writes it.
    await db.query(`UPDATE invoices SET due_date = $2, created_at = $2::date - 3 WHERE id = $1`, [s.invoiceId, due])
    await db.query(
      `UPDATE payments SET due_date = $2, created_at = $2::date - 3,
              status = CASE WHEN type = 'rent' THEN 'settled' ELSE status END,
              settled_at = CASE WHEN type = 'rent' THEN NOW() - interval '6 days' END
        WHERE invoice_id = $1`, [s.invoiceId, due])
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',50,'pending',($6::date + 3),'LATEFEE')`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId, due])
    // The contract, waiting, written the way the packet writes it (no lease).
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const k = await createHomeSaleContract(c, {
        unitId: s.unitId, leaseId: null, tenantId: s.tenantId, landlordId: s.landlordId,
        salePrice: 1800, downPayment: 0, annualInterestRate: 0, termMonths: 12, startMonth: month,
        planType: 'flat', pendingSignature: true,
      })
      await c.query(`UPDATE home_sale_contracts SET purchase_document_id = $2 WHERE id = $1`, [k.id, s.docId])
      await c.query('COMMIT')
    } finally { c.release() }
    return { ...s, due }
  }
  /** The tenant pays what was on the bill before the home payment joined it. */
  const settleTheRest = (invoiceId: string) => db.query(
    `UPDATE payments SET status = 'settled', settled_at = NOW() - interval '6 days'
      WHERE invoice_id = $1 AND type NOT IN ('late_fee', 'home_payment') AND status <> 'settled'`, [invoiceId])
  const fees = (invoiceId: string) => query<any>(
    `SELECT amount::float AS amount, due_date::text AS due_date FROM payments
      WHERE invoice_id = $1 AND type = 'late_fee' ORDER BY due_date`, [invoiceId])

  it('the late fee already on the bill stays as it is, and no new one starts', async () => {
    const s = await lateBill()
    const before = await fees(s.invoiceId)
    expect(before).toHaveLength(1)

    expect((await activateHomeSaleContract(s.docId)).activated).toBe(true)
    expect(await homeLines(s.invoiceId)).toHaveLength(1)   // it did join the late bill
    await settleTheRest(s.invoiceId)

    await generateLateFeesForInvoice(s.invoiceId)
    expect(await fees(s.invoiceId)).toEqual(before)
  })

  it('without the rule the same line would have restarted the daily fee — a line written with the bill still counts', async () => {
    const s = await lateBill()
    await activateHomeSaleContract(s.docId)
    // As if the monthly run had written it with the bill, before it was late.
    await db.query(
      `UPDATE payments SET created_at = $2::date - 3 WHERE invoice_id = $1 AND type = 'home_payment'`, [s.invoiceId, s.due])
    await settleTheRest(s.invoiceId)
    await generateLateFeesForInvoice(s.invoiceId)
    const after = await fees(s.invoiceId)
    expect(after.length).toBeGreaterThan(1)
    expect(after.slice(1).every(f => f.amount === 5)).toBe(true)
  })

  it('a bill the monthly run wrote late (a catch-up) carries its home payment like any other line', async () => {
    const s = await lateBill()
    await activateHomeSaleContract(s.docId)
    // The run caught up two days after the grace ended and wrote the home
    // payment with the bill, the same day. Nothing on it was added later.
    await db.query(`UPDATE invoices SET created_at = $2::date + 5 WHERE id = $1`, [s.invoiceId, s.due])
    await db.query(
      `UPDATE payments SET created_at = $2::date + 5 WHERE invoice_id = $1 AND type = 'home_payment'`, [s.invoiceId, s.due])
    await settleTheRest(s.invoiceId)
    await generateLateFeesForInvoice(s.invoiceId)
    expect((await fees(s.invoiceId)).length).toBeGreaterThan(1)
  })
})

/**
 * 10/12 review: what counts as the buyer's OPEN bill when the landlord signs.
 */
describe('which bill the home payment joins', () => {
  it('not a bill paid in full by bank transfer that is still clearing — it waits for the monthly run', async () => {
    const s = await seed()
    // The tenant paid the whole bill by ACH: in flight, so the bill still
    // reads 'pending' (only settled lines count toward its status).
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_test_' || left(id::text, 8)
        WHERE invoice_id = $1`, [s.invoiceId])
    expect((await bill(s.invoiceId)).status).toBe('pending')

    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    expect((await sale(s.unitId)).status).toBe('active')
    expect(await homeLines(s.invoiceId)).toHaveLength(0)
    expect(await bill(s.invoiceId)).toMatchObject({ total: 466.5, home: 0 })
    const waiting = await query<any>(
      `SELECT i.installment_number FROM home_sale_installments i JOIN home_sale_contracts c ON c.id = i.contract_id
        WHERE c.unit_id = $1 AND i.payment_id IS NULL AND i.settled_off_platform_at IS NULL AND i.billing_month <= $2::date`,
      [s.unitId, s.thisMonth])
    expect(waiting.map(w => w.installment_number)).toEqual([3])
  })

  it("not the opening-balance bill, when the month's own bill is already paid", async () => {
    const s = await seed({ billStatus: 'settled' })
    const opening = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             total_amount, status, is_opening_balance, late_fee_exempt)
       VALUES ($1,$2,$3,$4,$5,($6::date + 1),300,'pending',TRUE,TRUE) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, `INV-OB-${randomUUID().slice(0, 8)}`, s.thisMonth])).rows[0].id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'carried_balance',300,'pending',($6::date + 1),'BALANCE')`,
      [opening, s.unitId, s.leaseId, s.tenantId, s.landlordId, s.thisMonth])

    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    expect(await homeLines(opening)).toHaveLength(0)
    expect(await homeLines(s.invoiceId)).toHaveLength(0)
    expect(await bill(opening)).toMatchObject({ total: 300, home: 0 })
  })
})

describe('a second installment contract on a home whose sale is already billing', () => {
  it("is refused at the landlord's signature, and the first sale is left exactly as it was", async () => {
    const s = await seed()
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const first = await sale(s.unitId)
    expect(first).toMatchObject({ status: 'active', installments: 12, installments_billed: 3 })

    const c = await db.connect()
    let second: string
    try {
      await c.query('BEGIN')
      second = await draftAgreement(c, {
        landlordId: s.landlordId, landlordUser: s.landlordUser, unitId: s.unitId, leaseId: s.leaseId,
        tenantUser: s.tenantUser, firstPayment: s.thisMonth, monthly: '$175' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp()).post(`/api/esign/sign/${second}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] })
    expect(res.status).toBe(409)
    expect(res.body.error ?? res.body.message).toMatch(/already has an installment contract that is billing/)

    expect(await sale(s.unitId)).toEqual(first)
    expect(await homeLines(s.invoiceId)).toEqual([
      { amount: 150, status: 'pending', notes: 'Home payment 3 of 12', lease_id: s.leaseId, due_date: s.thisMonth },
    ])
    const contracts = await query<any>(`SELECT purchase_document_id FROM home_sale_contracts WHERE unit_id = $1`, [s.unitId])
    expect(contracts.map(k => k.purchase_document_id)).toEqual([s.docId])
    const unsigned = await queryOne<any>(
      `SELECT status FROM lease_document_signers WHERE document_id = $1 AND role = 'landlord'`, [second!])
    expect(unsigned.status).not.toBe('signed')
  })
})

describe('the same signature twice', () => {
  it('a double-clicked landlord signature starts the sale once, with no false alarm', async () => {
    const s = await seed()
    const app = buildApp()
    const both = await Promise.all([1, 2].map(() => request(app).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] })))
    expect(both.map(r => r.status).sort()).toEqual([200, 400])
    expect(await sale(s.unitId)).toMatchObject({ status: 'active', installments: 12, installments_billed: 3 })
    expect(await homeLines(s.invoiceId)).toHaveLength(1)
    const alarms = await query<any>(
      `SELECT 1 FROM admin_notifications WHERE category IN ('home_sale_terms_failed', 'home_sale_activation_failed')`)
    expect(alarms).toHaveLength(0)
  })

  it('recording the terms again after the sale started changes nothing', async () => {
    const s = await seed()
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const before = await sale(s.unitId)
    expect(await applySaleTermsFromDocument(s.docId)).toEqual({ contractId: before.id })
    expect(await sale(s.unitId)).toEqual(before)
    const contracts = await query<any>(`SELECT 1 FROM home_sale_contracts WHERE unit_id = $1`, [s.unitId])
    expect(contracts).toHaveLength(1)
  })
})

/**
 * A sale whose every month falls before the park's first billing cycle is
 * fully "paid outside GAM" on the landlord's signature alone. The home does
 * not pass to the buyer until the buyer has signed — the paper can still be
 * voided until then.
 */
describe('a sale fully paid outside GAM, signed only by the landlord', () => {
  it('is not paid off and the home stays the park\'s until the buyer signs', async () => {
    const s = await seed({ firstPaymentOffset: -14 })
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    expect(await sale(s.unitId)).toMatchObject({ status: 'active', installments: 12, paid_outside: 12, installments_paid: 12 })
    const owner = () => queryOne<any>(`SELECT dwelling_ownership FROM units WHERE id = $1`, [s.unitId])
    expect((await owner()).dwelling_ownership).toBe('landlord')
    await reconcileAllHomeSaleContracts()
    expect((await sale(s.unitId)).status).toBe('active')

    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.buyerToken}`).send({ fieldValues: [] }).expect(200)
    await reconcileAllHomeSaleContracts()
    expect((await sale(s.unitId)).status).toBe('paid_off')
    expect((await owner()).dwelling_ownership).toBe('tenant')
  })

  it('voiding it then takes the sale back, with the home never handed over', async () => {
    const s = await seed({ firstPaymentOffset: -14 })
    await request(buildApp()).post(`/api/esign/sign/${s.docId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`).send({ fieldValues: [] }).expect(200)
    const saleId = (await sale(s.unitId)).id
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const doc = (await c.query(`SELECT * FROM lease_documents WHERE id = $1`, [s.docId])).rows[0]
      await voidDocument(c.query.bind(c) as any, doc, 'wrong terms')
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
    expect((await queryOne<any>(`SELECT status FROM home_sale_contracts WHERE id = $1`, [saleId])).status).toBe('cancelled')
    expect((await queryOne<any>(`SELECT dwelling_ownership FROM units WHERE id = $1`, [s.unitId])).dwelling_ownership).toBe('landlord')
  })
})
