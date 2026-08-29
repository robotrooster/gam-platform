import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query, queryOne, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { computeAmortization } from '@gam/shared'
import { billDueHomeSaleInstallments, reconcileHomeSaleContract, createHomeSaleContract, activateHomeSaleContract } from '../services/homeSale'
import { homeSaleRouter } from './homeSale'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/home-sales', homeSaleRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_homesale'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    // S613 (Nic, DIRECTIVE): a financed sale converts a park-owned HOME to
    // tenant-owned, so it is offered on mobile homes only — never an RV, which
    // is towed away rather than converted. The fixture is a park-owned home.
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'mobile_home' })
    await c.query(`UPDATE units SET dwelling_ownership = 'landlord' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 400 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })   // the buyer occupies the space
    await c.query('COMMIT')
    const token = jwt.sign({ userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, tenantId, unitId, leaseId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('computeAmortization', () => {
  it('level payment amortizes to a zero ending balance (interest case)', () => {
    const { monthlyPayment, schedule } = computeAmortization(10000, 12, 12)  // 12% annual, 12 mo
    expect(monthlyPayment).toBeCloseTo(888.49, 1)
    expect(schedule).toHaveLength(12)
    expect(schedule[11].remainingBalance).toBe(0)
    // total principal repaid == financed amount
    const principal = schedule.reduce((s, r) => s + r.principalPortion, 0)
    expect(Math.round(principal * 100) / 100).toBe(10000)
  })
  it('zero interest splits principal evenly', () => {
    const { monthlyPayment, schedule } = computeAmortization(6000, 0, 60)
    expect(monthlyPayment).toBe(100)
    expect(schedule[59].remainingBalance).toBe(0)
    expect(schedule.reduce((s, r) => s + r.interestPortion, 0)).toBe(0)
  })
})

describe('POST /api/home-sales', () => {
  it('creates a contract + full amortization schedule', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 30000, downPayment: 5000, annualInterestRate: 6, termMonths: 60, startMonth: '2026-08-01' })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.contract.financed_amount)).toBe(25000)
    expect(res.body.data.schedule).toHaveLength(60)
    expect(Number(res.body.data.schedule[59].remaining_balance)).toBe(0)
  })

  it('flat plan: monthly × N, zero interest, ends after N payments', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              planType: 'flat', monthlyAmount: 500, numberOfPayments: 12, startMonth: '2026-08-01' })
    expect(res.status).toBe(200)
    expect(res.body.data.contract.plan_type).toBe('flat')
    expect(Number(res.body.data.contract.sale_price)).toBe(6000)          // 500 × 12
    expect(Number(res.body.data.contract.annual_interest_rate)).toBe(0)
    expect(res.body.data.schedule).toHaveLength(12)
    expect(Number(res.body.data.schedule[0].amount)).toBe(500)
    expect(Number(res.body.data.schedule[11].amount)).toBe(500)
    expect(Number(res.body.data.schedule[11].interest_portion)).toBe(0)
    expect(Number(res.body.data.schedule[11].remaining_balance)).toBe(0)
  })

  it('flat plan rejects missing monthlyAmount/numberOfPayments → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).post('/api/home-sales')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              planType: 'flat', startMonth: '2026-08-01' })
    expect(res.status).toBe(400)
  })

  it('rejects a second active contract on the same unit → 409', async () => {
    const f = await seed()
    const mk = () => request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 30000, downPayment: 0, annualInterestRate: 5, termMonths: 48, startMonth: '2026-08-01' })
    await mk().expect(200)
    const res = await mk()
    expect(res.status).toBe(409)
  })

  it('rejects a tenant-owned unit (nothing to finance) → 409', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET dwelling_ownership='tenant' WHERE id=$1`, [f.unitId])
    const res = await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 30000, downPayment: 0, annualInterestRate: 5, termMonths: 48, startMonth: '2026-08-01' })
    expect(res.status).toBe(409)
  })

  it('rejects a buyer who is not a tenant on the lease → 400 (write-scope)', async () => {
    const f = await seed()
    const c = await db.connect()
    let strangerTenantId: string
    try { strangerTenantId = await seedTenant(c) } finally { c.release() }
    const res = await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: strangerTenantId,
              salePrice: 30000, downPayment: 0, annualInterestRate: 5, termMonths: 48, startMonth: '2026-08-01' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/home-sales/unit/:unitId — tenant scoping', () => {
  it('never leaks another buyer\'s cancelled contract to an unrelated tenant', async () => {
    const f = await seed()
    // Landlord creates then cancels a contract for the real buyer (f.tenantId).
    const create = await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 30000, downPayment: 0, annualInterestRate: 5, termMonths: 48, startMonth: '2026-08-01' })
      .expect(200)
    const contractId = create.body.data.contract.id
    await request(buildApp()).post(`/api/home-sales/${contractId}/cancel`).set('Authorization', `Bearer ${f.token}`).expect(200)

    // A stranger tenant queries the same unit → must get null, NOT the contract.
    const c = await db.connect()
    let strangerTenantId: string
    try { strangerTenantId = await seedTenant(c) } finally { c.release() }
    const strangerToken = jwt.sign({ userId: strangerTenantId, role: 'tenant', email: 's@t.dev', profileId: strangerTenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const strangerRes = await request(buildApp()).get(`/api/home-sales/unit/${f.unitId}`).set('Authorization', `Bearer ${strangerToken}`)
    expect(strangerRes.status).toBe(200)
    expect(strangerRes.body.data).toBeNull()

    // The real buyer still sees their own (cancelled) contract.
    const buyerToken = jwt.sign({ userId: f.tenantId, role: 'tenant', email: 'b@t.dev', profileId: f.tenantId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const buyerRes = await request(buildApp()).get(`/api/home-sales/unit/${f.unitId}`).set('Authorization', `Bearer ${buyerToken}`)
    expect(buyerRes.body.data?.contract?.id).toBe(contractId)
  })
})

describe('home-sale billing + payoff', () => {
  it('bills due installments as home_payment rows (idempotent) and stops at term', async () => {
    const f = await seed()
    // 3-month contract starting this month.
    await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 3000, downPayment: 0, annualInterestRate: 0, termMonths: 3, startMonth: '2000-01-01' })
      .expect(200)

    // Everything is due (start in the past) — bill it all.
    const billed = await billDueHomeSaleInstallments('2000-04-01')
    expect(billed).toBe(3)
    const rows = await db.query<any>(`SELECT type, amount::float AS amount, entry_description FROM payments WHERE type='home_payment' AND landlord_id=$1`, [f.landlordId])
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows[0].entry_description).toBe('HOMEPMT')
    expect(rows.rows[0].amount).toBe(1000)   // 3000 / 3, no interest

    // Re-run → no double billing.
    const again = await billDueHomeSaleInstallments('2000-04-01')
    expect(again).toBe(0)
  })

  it('the unique index blocks a duplicate home_payment for the same installment (idempotency backstop)', async () => {
    const f = await seed()
    await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 3000, downPayment: 0, annualInterestRate: 0, termMonths: 3, startMonth: '2000-01-01' })
      .expect(200)
    await billDueHomeSaleInstallments('2000-04-01')

    // Exactly one payment carries each billed installment id.
    const inst = await db.query<any>(`SELECT id FROM home_sale_installments WHERE payment_id IS NOT NULL LIMIT 1`)
    const instId = inst.rows[0].id
    const n = await db.query<any>(`SELECT count(*)::int n FROM payments WHERE home_sale_installment_id=$1`, [instId])
    expect(n.rows[0].n).toBe(1)

    // A second charge for the same installment (what a concurrent second cron
    // instance would attempt) is rejected by the partial-unique index.
    await expect(db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, home_sale_installment_id)
       SELECT unit_id, lease_id, tenant_id, landlord_id, 'home_payment', 100, 'pending',
              due_date, 'HOMEPMT', $1
         FROM payments WHERE home_sale_installment_id=$1`, [instId]
    )).rejects.toThrow()
  })

  it('marks paid_off and flips the unit to tenant-owned once all installments settle', async () => {
    const f = await seed()
    const create = await request(buildApp()).post('/api/home-sales').set('Authorization', `Bearer ${f.token}`)
      .send({ unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId,
              salePrice: 2000, downPayment: 0, annualInterestRate: 0, termMonths: 2, startMonth: '2000-01-01' })
    const contractId = create.body.data.contract.id
    await billDueHomeSaleInstallments('2000-03-01')

    // Settle every home_payment row.
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE type='home_payment' AND landlord_id=$1`, [f.landlordId])
    await reconcileHomeSaleContract(contractId)

    const contract = await db.query<any>(`SELECT status FROM home_sale_contracts WHERE id=$1`, [contractId])
    expect(contract.rows[0].status).toBe('paid_off')
    const unit = await db.query<any>(`SELECT dwelling_ownership FROM units WHERE id=$1`, [f.unitId])
    expect(unit.rows[0].dwelling_ownership).toBe('tenant')   // buyer now owns the home
  })
})

/**
 * S629 — the signed purchase agreement is what starts the billing.
 *
 * Nic: "we need to be able to have a separate purchase contract sent through
 * the esignature flow that's separate from the lease, but still read for the
 * monthly billing."
 *
 * Before this, a home-sale contract was hand-created and billed from the
 * moment it existed. Any purchase agreement was an unrelated document, so the
 * terms a tenant signed and the terms GAM billed were two independent facts
 * nothing reconciled — over a multi-year financed sale, that is the gap that
 * matters.
 */
describe('purchase agreement gates the billing', () => {
  it('a contract awaiting signature has NO installments', async () => {
    const { unitId, leaseId, tenantId, landlordId } = await seed()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const c = await createHomeSaleContract(client, {
        unitId, leaseId, tenantId, landlordId,
        salePrice: 24000, downPayment: 0, annualInterestRate: 0,
        termMonths: 24, startMonth: '2026-09-01', planType: 'flat',
        pendingSignature: true,
      })
      await client.query('COMMIT')
      expect(c.status).toBe('pending_signature')
      const rows = await query<any>(
        `SELECT 1 FROM home_sale_installments WHERE contract_id=$1`, [c.id])
      expect(rows).toHaveLength(0)
    } finally { client.release() }
  })

  it('activating on signature writes the schedule exactly once', async () => {
    const { unitId, leaseId, tenantId, landlordId } = await seed()
    const docId = (await db.query(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Purchase agreement','purchase_agreement','sent') RETURNING id`,
      [landlordId, unitId])).rows[0].id
    const client = await getClient()
    let contractId = ''
    try {
      await client.query('BEGIN')
      const c = await createHomeSaleContract(client, {
        unitId, leaseId, tenantId, landlordId,
        salePrice: 24000, downPayment: 0, annualInterestRate: 0,
        termMonths: 24, startMonth: '2026-09-01', planType: 'flat',
        pendingSignature: true,
      })
      contractId = c.id
      await client.query(
        `UPDATE home_sale_contracts SET purchase_document_id=$2 WHERE id=$1`, [c.id, docId])
      await client.query('COMMIT')
    } finally { client.release() }

    expect((await activateHomeSaleContract(docId)).activated).toBe(true)
    const after = await queryOne<any>(`SELECT status FROM home_sale_contracts WHERE id=$1`, [contractId])
    expect(after.status).toBe('active')
    const rows = await query<any>(
      `SELECT 1 FROM home_sale_installments WHERE contract_id=$1`, [contractId])
    expect(rows).toHaveLength(24)

    // Idempotent: the e-sign completion path is best-effort and retryable, so a
    // second call must not write a second schedule under an active contract.
    expect((await activateHomeSaleContract(docId)).activated).toBe(false)
    const again = await query<any>(
      `SELECT 1 FROM home_sale_installments WHERE contract_id=$1`, [contractId])
    expect(again).toHaveLength(24)
  })
})
