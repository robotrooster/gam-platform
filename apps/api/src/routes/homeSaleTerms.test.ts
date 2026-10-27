/**
 * 10/25 (Nic): AN INSTALLMENT CONTRACT CARRIES ITS OWN TERMS.
 *
 *   "A trailer bill could possibly have late fees. It's an installment contract
 *    that may carry its own late terms. I don't have any specific to these
 *    contracts, but we need to have the capability for landlords. We provide
 *    the tools to do the job, whatever their job is."
 *
 *   "We need the ability to have the contract flagged as, you know, prevent
 *    credit card payments on that bill. That's an exposure where we would have
 *    to backtrack bookkeeping and stuff."
 *
 *   "Leave current properties set up as is. Let landlords choose how it gets
 *    bundled."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { createHomeSaleContract, billDueHomeSaleInstallments } from '../services/homeSale'
import { generateLateFeesForInvoice } from '../jobs/lateFees'
import { homeSaleRouter } from './homeSale'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/home-sales', homeSaleRouter)
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_homesale_terms'
})

const MONTH = '2026-03-01'

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = $1`, [propertyId, MONTH])
    const k = await createHomeSaleContract(c, {
      unitId, leaseId, tenantId, landlordId: ll.landlordId,
      salePrice: 2400, downPayment: 0, annualInterestRate: 0,
      termMonths: 12, startMonth: MONTH, planType: 'flat',
    })
    await c.query('COMMIT')
    return {
      ...ll, propertyId, unitId, tenantId, leaseId, contractId: k.id as string,
      landlordToken: jwt.sign(
        { userId: ll.userId, role: 'landlord', email: `${ll.userId}@t.dev`, profileId: ll.landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const contract = (id: string) => queryOne<any>(
  `SELECT late_fee_enabled, late_fee_grace_days, late_fee_initial_type,
          late_fee_initial_amount::float AS late_fee_initial_amount, card_payments_blocked
     FROM home_sale_contracts WHERE id = $1`, [id])
const ownBill = (contractId: string) => queryOne<any>(
  `SELECT id, late_fee_exempt, total_amount::float AS total
     FROM invoices WHERE home_sale_contract_id = $1`, [contractId])

describe('the contract carries its own late-fee terms', () => {
  it('charges no late fee until a landlord turns one on', async () => {
    const s = await seed()
    expect(await contract(s.contractId)).toMatchObject({ late_fee_enabled: false, card_payments_blocked: false })
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    // Default OFF: a fee nobody signed for is never charged, so the bill is
    // written exempt and the engine never fines it.
    const bill = await ownBill(s.contractId)
    expect(bill).toMatchObject({ late_fee_exempt: true, total: 200 })
    await query(`UPDATE invoices SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE id = $1`, [bill.id])
    await query(`UPDATE payments SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE invoice_id = $1`, [bill.id])
    await generateLateFeesForInvoice(bill.id)
    expect(await query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [bill.id])).toHaveLength(0)
  })

  it('fines the bill on the contract\'s own terms once the landlord sets them', async () => {
    const s = await seed()
    const res = await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ lateFeeEnabled: true, lateFeeGraceDays: 3, lateFeeInitialType: 'flat', lateFeeInitialAmount: 25 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await contract(s.contractId)).toMatchObject({
      late_fee_enabled: true, late_fee_grace_days: 3, late_fee_initial_type: 'flat', late_fee_initial_amount: 25,
    })

    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const bill = await ownBill(s.contractId)
    expect(bill.late_fee_exempt).toBe(false)
    await query(`UPDATE invoices SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE id = $1`, [bill.id])
    await query(`UPDATE payments SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE invoice_id = $1`, [bill.id])
    await generateLateFeesForInvoice(bill.id)
    const fees = await query<any>(
      `SELECT amount::float AS amount FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [bill.id])
    expect(fees).toEqual([{ amount: 25 }])
  })

  it('turning fees on never fines a bill that was already open', async () => {
    // THE CASE THAT ACTUALLY HAPPENS, and the one an earlier version of this
    // test missed: every trailer bill is written exempt because fees default
    // off, so NONE has ever been fined. A back-fill guarded on "has never been
    // fined" excludes nothing, and clearing the exemption would fine every open
    // past-due bill at once with accrual counted back to a due date the buyer
    // was told carried no fee. So turning fees on must leave existing bills
    // exactly as written (S558: the document is the charge).
    const s = await seed()
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const bill = await ownBill(s.contractId)
    expect(bill.late_fee_exempt).toBe(true)
    // Long past due, and never fined — exactly the bill at risk.
    await query(`UPDATE invoices SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE id = $1`, [bill.id])
    await query(`UPDATE payments SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE invoice_id = $1`, [bill.id])

    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ lateFeeEnabled: true, lateFeeGraceDays: 3, lateFeeInitialType: 'flat', lateFeeInitialAmount: 25 }).expect(200)

    // Still exempt, and the engine fines nothing on it.
    expect((await ownBill(s.contractId)).late_fee_exempt).toBe(true)
    await generateLateFeesForInvoice(bill.id)
    expect(await query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [bill.id])).toHaveLength(0)
  })

  it('turning fees back off stops them without touching any bill', async () => {
    // The engine reads the contract's terms live, so switching off is enough.
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ lateFeeEnabled: true, lateFeeGraceDays: 3, lateFeeInitialType: 'flat', lateFeeInitialAmount: 25 }).expect(200)
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const bill = await ownBill(s.contractId)
    expect(bill.late_fee_exempt).toBe(false)
    await query(`UPDATE invoices SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE id = $1`, [bill.id])
    await query(`UPDATE payments SET due_date = CURRENT_DATE - 40, created_at = CURRENT_DATE - 43 WHERE invoice_id = $1`, [bill.id])

    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ lateFeeEnabled: false }).expect(200)
    await generateLateFeesForInvoice(bill.id)
    expect(await query(`SELECT 1 FROM payments WHERE invoice_id = $1 AND type = 'late_fee'`, [bill.id])).toHaveLength(0)
  })

  it('refuses another landlord, and a contract that is finished', async () => {
    const s = await seed()
    const other = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${other.landlordToken}`)
      .send({ cardPaymentsBlocked: true }).expect(403)
    await query(`UPDATE home_sale_contracts SET status = 'paid_off' WHERE id = $1`, [s.contractId])
    const res = await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ cardPaymentsBlocked: true })
    expect(res.status).toBe(409)
    expect(await contract(s.contractId)).toMatchObject({ card_payments_blocked: false })
  })
})

describe('a contract that takes no card', () => {
  it('is recorded, and the bill never offers or accepts one', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ cardPaymentsBlocked: true }).expect(200)
    expect(await contract(s.contractId)).toMatchObject({ card_payments_blocked: true })

    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const { planLeaseCharge, billMethodCosts } = await import('../services/rentCharge')
    const client = await getClient()
    try {
      const plan = await planLeaseCharge(client, {
        tenantId: s.tenantId, scope: { kind: 'home_sale', homeSaleContractId: s.contractId },
      })
      expect(plan.ctx.cardsBlocked).toBe(true)
      // Bank and cash remain; card is not among the ways to pay.
      const methods = billMethodCosts(plan.ctx, plan.requiredTotal, 0).map(m => m.method)
      expect(methods).toContain('ach')
      expect(methods).not.toContain('card')
    } finally { client.release() }
  })

  it('leaves every other bill\'s card payments alone', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ cardPaymentsBlocked: true }).expect(200)
    const { planLeaseCharge, billMethodCosts } = await import('../services/rentCharge')
    const client = await getClient()
    try {
      const plan = await planLeaseCharge(client, { tenantId: s.tenantId, scope: { kind: 'lease', leaseId: s.leaseId } })
      expect(plan.ctx.cardsBlocked).toBe(false)
      expect(billMethodCosts(plan.ctx, 450, 0).map(m => m.method)).toContain('card')
    } finally { client.release() }
  })
})

describe('the property chooses how a trailer payment is billed', () => {
  it('defaults to its own bill, and the setting saves without disturbing the address', async () => {
    const s = await seed()
    const before = await queryOne<any>(
      `SELECT home_payments_own_bill, street1, street2 FROM properties WHERE id = $1`, [s.propertyId])
    expect(before.home_payments_own_bill).toBe(true)

    // The suite line shares the same statement, and its "was it sent" flag sits
    // next to this setting in the parameter list — so saving one must not move
    // the other (a real bug this test exists to catch).
    const res = await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ homePaymentsOwnBill: false })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const after = await queryOne<any>(
      `SELECT home_payments_own_bill, street1, street2 FROM properties WHERE id = $1`, [s.propertyId])
    expect(after.home_payments_own_bill).toBe(false)
    expect(after.street1).toBe(before.street1)
    expect(after.street2).toBe(before.street2)
  })

  it('and sending a suite line does not flip the billing choice', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ homePaymentsOwnBill: false }).expect(200)
    await request(buildApp()).patch(`/api/properties/${s.propertyId}`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ street2: 'Suite 7' }).expect(200)
    const after = await queryOne<any>(
      `SELECT home_payments_own_bill, street2 FROM properties WHERE id = $1`, [s.propertyId])
    expect(after).toMatchObject({ home_payments_own_bill: false, street2: 'Suite 7' })
  })
})

/**
 * 10/25 — THE CHARGE KEEPS ITS LEASE. Only which BILL it sits on changed, so
 * every money read that keys off payments.lease_id must still find it. Three do
 * so as a hard requirement: bankDepositCandidates (`p.lease_id IS NOT NULL`),
 * depositReturn's move-out sweep (`p.lease_id IN <lease chain>`) and
 * openBalances' grouping. home_sale_contracts.lease_id cannot answer it — it is
 * context only, and 8 of the 11 live contracts have none while all 8 of those
 * buyers rent the space.
 */
describe('a trailer charge still carries the buyer\'s lease', () => {
  async function saleWithNoLeaseOnTheContract() {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450 })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      await c.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = $1`, [propertyId, MONTH])
      // The signing packet writes the contract with NO lease (S651).
      const k = await createHomeSaleContract(c, {
        unitId, leaseId: null, tenantId, landlordId: ll.landlordId,
        salePrice: 2400, downPayment: 0, annualInterestRate: 0,
        termMonths: 12, startMonth: MONTH, planType: 'flat',
      })
      await c.query('COMMIT')
      return { ...ll, propertyId, unitId, tenantId, leaseId, contractId: k.id as string }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  }

  it('resolves the buyer\'s active lease when the contract names none', async () => {
    const s = await saleWithNoLeaseOnTheContract()
    expect(await queryOne<any>(`SELECT lease_id FROM home_sale_contracts WHERE id=$1`, [s.contractId]))
      .toMatchObject({ lease_id: null })

    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const charge = await queryOne<any>(
      `SELECT p.lease_id, p.unit_id, p.amount::float AS amount,
              i.home_sale_contract_id IS NOT NULL AS own_bill
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.type = 'home_payment'`)
    // Its own bill, and the buyer's real lease on the row.
    expect(charge).toMatchObject({ lease_id: s.leaseId, unit_id: s.unitId, amount: 200, own_bill: true })
  })

  it('stays visible to the bank-deposit match and the move-out sweep', async () => {
    const s = await saleWithNoLeaseOnTheContract()
    await query(`UPDATE properties SET tenants_deposit_at_bank = TRUE WHERE id = $1`, [s.propertyId])
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)

    // bankDepositCandidates' own charge set is `p.lease_id IS NOT NULL AND
    // bankPayableRowSql` — asserted here through the same predicate it uses, so
    // this test tracks that function rather than a copy of its words. Without
    // the lease on the row, an $815 deposit of rent + water + trailer would tie
    // to nothing, which is the case its comment names.
    const { bankPayableRowSql } = await import('../services/moneyPredicates')
    const matchable = await query<any>(
      `SELECT p.type FROM payments p
         JOIN v_payment_money vm ON vm.payment_id = p.id
        WHERE p.landlord_id = $1
          AND p.lease_id IS NOT NULL
          AND ${bankPayableRowSql('p')}
          AND vm.money_part > 0
          AND p.type = 'home_payment'`, [s.landlordId])
    expect(matchable).toHaveLength(1)

    // depositReturn sweeps unpaid charges by p.lease_id IN <lease chain>; a
    // charge with no lease is never deducted, and the landlord refunds money
    // the buyer still owes.
    const swept = await query<any>(
      `SELECT p.id FROM payments p
        WHERE p.type = 'home_payment' AND p.lease_id = $1 AND p.status = 'pending'`, [s.leaseId])
    expect(swept).toHaveLength(1)
  })

  it('leaves it null only when the buyer rents nothing here', async () => {
    // The operator who owns homes in parks he does not own: no lease to carry.
    const c = await db.connect()
    let made: { unitId: string; tenantId: string; landlordId: string; contractId: string }
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const tenantId = await seedTenant(c)
      await c.query(`UPDATE properties SET first_billing_cycle = $2 WHERE id = $1`, [propertyId, MONTH])
      const k = await createHomeSaleContract(c, {
        unitId, leaseId: null, tenantId, landlordId: ll.landlordId,
        salePrice: 1200, downPayment: 0, annualInterestRate: 0,
        termMonths: 12, startMonth: MONTH, planType: 'flat',
      })
      await c.query('COMMIT')
      made = { unitId, tenantId, landlordId: ll.landlordId, contractId: k.id as string }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }

    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const charge = await queryOne<any>(
      `SELECT lease_id, tenant_id FROM payments WHERE type = 'home_payment' AND tenant_id = $1`, [made!.tenantId])
    expect(charge).toMatchObject({ lease_id: null, tenant_id: made!.tenantId })
  })
})

/**
 * 10/25 — THE COUNTER READER. Dominic Gonzalez pays at the counter but never by
 * card ("Dominic can pay at the counter. He cannot pay by card"), because his
 * installment is the trust's money and a chargeback would have to be unwound
 * across two sets of books. The reader must therefore scope to the CONTRACT,
 * not to the lease the charge also carries — otherwise it takes the resident's
 * rent money for a trailer payment nobody paid.
 */
describe('taking a card at the counter for a trailer payment', () => {
  const trailerCharge = (contractId: string) => queryOne<any>(
    `SELECT p.id, p.lease_id FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.home_sale_contract_id = $1 AND p.type = 'home_payment'`, [contractId])

  it('is refused outright when the contract takes no card', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ cardPaymentsBlocked: true }).expect(200)
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const charge = await trailerCharge(s.contractId)
    // The charge carries the lease too, which is exactly the trap.
    expect(charge.lease_id).toBe(s.leaseId)

    const { chargeLeaseBalance } = await import('../services/rentCharge')
    await expect(chargeLeaseBalance({
      tenantId: s.tenantId, homeSaleContractId: s.contractId,
      chargeEverything: true, dryRun: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
    } as any)).rejects.toThrow(/cannot be paid by card/)
  })

  it('charges the trailer bill, never the rent, when cards are allowed', async () => {
    const s = await seed()
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(1)
    const charge = await trailerCharge(s.contractId)

    const { chargeLeaseBalance } = await import('../services/rentCharge')
    const q = await chargeLeaseBalance({
      tenantId: s.tenantId, homeSaleContractId: s.contractId,
      chargeEverything: true, dryRun: true,
      paymentMethodType: 'card_present', source: 'front_desk_reader',
    } as any)
    // The $200 installment, and only it — not the $450 rent.
    expect(q.lines.map((l: any) => l.payment_id)).toEqual([charge.id])
  })
})

/**
 * 10/25 — TURNING BILLING ON MUST NOT BILL THE PAST.
 *
 * While a contract is tracked, its months pass unbilled by design and the buyer
 * may well have paid them off the books. Flipping it to billed would otherwise
 * make the next run invoice every one of those months at once — billing a
 * second time for money already handed over. GAM bills from when it starts
 * billing, the same rule as a property's first billing cycle.
 */
describe('a tracked contract that the landlord later starts billing', () => {
  const sched = (contractId: string) => query<any>(
    `SELECT installment_number AS n, settled_off_platform_at IS NOT NULL AS settled, payment_id
       FROM home_sale_installments WHERE contract_id = $1 ORDER BY installment_number`, [contractId])

  it('stamps the months it was not billing and bills from the current one', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ trackedNotBilled: true }).expect(200)
    // Months have passed untouched: MONTH is 2026-03 and today is well past it.
    expect(await billDueHomeSaleInstallments(MONTH)).toBe(0)
    expect((await sched(s.contractId)).every((r: any) => !r.settled && !r.payment_id)).toBe(true)

    // The landlord decides to bill it through GAM after all.
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ trackedNotBilled: false }).expect(200)

    const rows = await sched(s.contractId)
    const past = rows.filter((r: any) => r.n <= 2)   // 2026-03 and 2026-04, long gone
    expect(past.every((r: any) => r.settled)).toBe(true)
    expect(past.every((r: any) => r.payment_id === null)).toBe(true)

    // And a run now bills only what is current — never the stamped months.
    const billedNow = await billDueHomeSaleInstallments(
      (await queryOne<{ d: string }>(`SELECT CURRENT_DATE::text AS d`))!.d)
    const charged = await query<any>(
      `SELECT i.installment_number AS n FROM home_sale_installments i
        WHERE i.contract_id = $1 AND i.payment_id IS NOT NULL`, [s.contractId])
    expect(charged.every((r: any) => r.n > 2)).toBe(true)
    expect(billedNow).toBe(charged.length)
  })
})

/**
 * 10/25 (Nic): "Lisa is not going to get permission to edit leases. That is a
 * non-starter right there. Marking that somebody logged a payment for a
 * contract that's being kept off the books has nothing to do with leases. You
 * need to take a different route."
 *
 * So the mark is gated on 'take_payment' — the counter's own key, "Record a
 * cash / check payment" — and on nothing lease-shaped. Pinned with the real
 * permission shape the live front desk carries, so a future change that
 * reaches for leases.edit here fails instead of quietly locking the desk out.
 */
describe('who may mark an off-the-books payment', () => {
  const deskToken = async (landlordId: string, perms: Record<string, boolean>) => {
    const u = await queryOne<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('desk-' || gen_random_uuid() || '@t.dev', 'x', 'onsite_manager', 'Front', 'Desk')
       RETURNING id`, [])
    await query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, permissions)
       VALUES ($1, $2, TRUE, $3::jsonb)`, [u!.id, landlordId, JSON.stringify(perms)])
    // A real desk token names the ONE company it works for (landlordId), which
    // is what canManageLandlordResource reads.
    return jwt.sign(
      { userId: u!.id, role: 'onsite_manager', email: 'desk@t.dev', profileId: null,
        landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  // Lisa Scheeler's live keys, trimmed to what matters here: take_payment yes,
  // leases.edit no.
  const LISA = { 'take_payment': true, 'balances.view': true, 'front_desk.view': true,
                 'guests.check_in': true, 'guests.check_out': true, 'pos.ring_sale': true }

  it('the front desk can, holding take_payment and no lease permission', async () => {
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ trackedNotBilled: true }).expect(200)
    const token = await deskToken(s.landlordId, LISA)

    const res = await request(buildApp()).patch(`/api/home-sales/${s.contractId}/installments/mark`)
      .set('Authorization', `Bearer ${token}`)
      .send({ installmentNumber: 1, paid: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await queryOne<any>(
      `SELECT settled_off_platform_at IS NOT NULL AS settled FROM home_sale_installments
        WHERE contract_id = $1 AND installment_number = 1`, [s.contractId]))
      .toMatchObject({ settled: true })
  })

  it('somebody with lease rights but no take_payment cannot', async () => {
    // Proves the gate is the counter's key and not a lease one.
    const s = await seed()
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/terms`)
      .set('Authorization', `Bearer ${s.landlordToken}`)
      .send({ trackedNotBilled: true }).expect(200)
    const token = await deskToken(s.landlordId, { 'leases.edit': true })
    await request(buildApp()).patch(`/api/home-sales/${s.contractId}/installments/mark`)
      .set('Authorization', `Bearer ${token}`)
      .send({ installmentNumber: 1, paid: true })
      .expect(403)
  })
})
