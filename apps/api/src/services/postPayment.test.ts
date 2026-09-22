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
