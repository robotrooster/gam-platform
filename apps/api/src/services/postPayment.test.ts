/**
 * S652 (Nic): a check that arrived before its bill. Settles what is open,
 * banks the rest as paid ahead, and writes one receipt for the books.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant, seedRentPayment } from '../test/dbHelpers'
import { postTenantPayment } from './postPayment'

async function household() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId, status: 'active', rentAmount: 450 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
    return { userId, landlordId, tenantId, unitId, leaseId }
  } finally { c.release() }
}

beforeEach(async () => { await cleanupAllSchema() })

describe('postTenantPayment', () => {
  it('with nothing open, the whole check is paid ahead and one receipt is written', async () => {
    const h = await household()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await postTenantPayment(c, { tenantId: h.tenantId, landlordIds: [h.landlordId], method: 'check', amount: 450, reference: '1042', postedBy: h.userId })
      await c.query('COMMIT')
      expect(r).toMatchObject({ applied: 0, paidAhead: 450, leaseId: h.leaseId })
    } finally { c.release() }
    const credit = (await db.query(`SELECT amount_remaining::float AS a, source_remittance_id FROM lease_prepaid_credits WHERE lease_id=$1`, [h.leaseId])).rows
    expect(credit).toHaveLength(1)
    expect(credit[0].a).toBe(450)
    const rem = (await db.query(`SELECT payment_method, reference, applied_amount::float AS ap, unapplied_amount::float AS un, status FROM tenant_remittances WHERE id=$1`, [credit[0].source_remittance_id])).rows[0]
    expect(rem).toMatchObject({ payment_method: 'check', reference: '1042', ap: 0, un: 450, status: 'settled' })
  })

  it('settles an open charge first, then banks the rest', async () => {
    const h = await household()
    const c = await db.connect()
    let paymentId = ''
    try {
      await c.query('BEGIN')
      paymentId = await seedRentPayment(c, { unitId: h.unitId, tenantId: h.tenantId, landlordId: h.landlordId, amount: 450, status: 'pending' })
      await c.query(`UPDATE payments SET lease_id=$2 WHERE id=$1`, [paymentId, h.leaseId])
      await c.query('COMMIT')
      await c.query('BEGIN')
      const r = await postTenantPayment(c, { tenantId: h.tenantId, landlordIds: [h.landlordId], method: 'cash', amount: 900, postedBy: h.userId })
      await c.query('COMMIT')
      expect(r.applied).toBe(450)
      expect(r.paidAhead).toBe(450)
      expect(r.settledPaymentIds).toEqual([paymentId])
    } finally { c.release() }
    expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [paymentId])).rows[0].status).toBe('settled')
    expect((await db.query(`SELECT COALESCE(SUM(amount_remaining),0)::float AS a FROM lease_prepaid_credits WHERE lease_id=$1`, [h.leaseId])).rows[0].a).toBe(450)
  })

  it('refuses when the tenant has no active lease with this account', async () => {
    const h = await household()
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(postTenantPayment(c, { tenantId: h.tenantId, landlordIds: ['00000000-0000-0000-0000-000000000000'], method: 'cash', amount: 10, postedBy: h.userId }))
        .rejects.toThrow(/no active lease/)
      await c.query('ROLLBACK')
    } finally { c.release() }
  })
})

// S655 (money plan Step 8): a posted payment is the desk's rules on money that
// has already arrived — the household's bill oldest first and whole (home
// payments included, the old balance last), the rest paid ahead on the newest
// lease as the landlord's money, and never a spend of credit.
describe('postTenantPayment — the household', () => {
  async function secondLease(h: Awaited<ReturnType<typeof household>>, startDate: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const unitId = await seedUnit(c, { propertyId: (await c.query<{ property_id: string }>(
        `SELECT property_id FROM units WHERE id=$1`, [h.unitId])).rows[0].property_id, landlordId: h.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: h.landlordId, status: 'active', rentAmount: 300, startDate })
      await seedLeaseTenant(c, { leaseId, tenantId: h.tenantId, role: 'primary' })
      await c.query('COMMIT')
      return { unitId, leaseId }
    } finally { c.release() }
  }
  const row = (h: any, unitId: string, leaseId: string, type: string, amount: number, due: string, entry = 'RENT') =>
    db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id`,
      [unitId, leaseId, h.tenantId, h.landlordId, type, amount, due, entry]).then(r => r.rows[0].id)
  const post = async (h: any, amount: number, method: 'cash' | 'check' = 'check') => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await postTenantPayment(c, { tenantId: h.tenantId, landlordIds: [h.landlordId], method, amount, reference: '77', postedBy: h.userId, receivedAt: new Date('2026-09-09T12:00:00Z') })
      await c.query('COMMIT')
      await r.afterCommit()
      return r
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('settles the household oldest first, home payments included, and banks the rest on the newest lease', async () => {
    const h = await household()
    const b = await secondLease(h, '2026-06-01')            // the newer lease
    const rentA = await row(h, h.unitId, h.leaseId, 'rent', 450, '2026-09-01')
    const home = await row(h, h.unitId, h.leaseId, 'home_payment', 200, '2026-09-01', 'HOMEPMT')
    const rentB = await row(h, b.unitId, b.leaseId, 'rent', 300, '2026-09-01')
    const old = await row(h, h.unitId, h.leaseId, 'carried_balance', 100, '2026-01-01', 'BALANCE')
    const r = await post(h, 1150)                           // 950 of bills + 100 old balance + 100 ahead
    expect(r.applied).toBe(1050)
    expect(r.paidAhead).toBe(100)
    expect([...r.settledPaymentIds].sort()).toEqual([rentA, home, rentB, old].sort())
    const credit = (await db.query<any>(
      `SELECT lease_id, amount_original::float AS a, funded_by, received_at::date::text AS day, source_remittance_id
         FROM lease_prepaid_credits`)).rows
    expect(credit).toEqual([{ lease_id: b.leaseId, a: 100, funded_by: 'landlord', day: '2026-09-09', source_remittance_id: r.remittanceId }])
    const rem = (await db.query<any>(`SELECT gross_amount, amount::float AS a FROM tenant_remittances WHERE id=$1`, [r.remittanceId])).rows[0]
    expect(rem).toEqual({ gross_amount: null, a: 1150 })
  })

  it('never spends credit', async () => {
    const h = await household()
    const rent = await row(h, h.unitId, h.leaseId, 'rent', 450, '2026-09-01')
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,200,200,'goodwill')`, [h.landlordId, h.tenantId, h.leaseId])
    // $250 is short of the $450 bill: the credit is not counted, so it is refused.
    await expect(post(h, 250)).rejects.toMatchObject({ statusCode: 422 })
    const r = await post(h, 450)
    expect(r.settledPaymentIds).toEqual([rent])
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect((await db.query<any>(`SELECT amount_remaining::float AS a FROM tenant_credits`)).rows[0].a).toBe(200)
  })

  it('is refused while the space is in eviction mode', async () => {
    const h = await household()
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [h.unitId])
    await expect(post(h, 450)).rejects.toMatchObject({ statusCode: 409 })
  })
})
