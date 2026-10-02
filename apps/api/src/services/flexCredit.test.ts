/**
 * FlexCredit monthly reporting fee — which month a run bills (S654).
 *
 * The cycle month is GAM's (Phoenix) month, the same as the FlexDeposit
 * custody fee. It used to be the UTC month, which turns over at 5 pm Phoenix
 * on the last day of the month.
 *
 * Stripe is mocked out; the enrolled tenant has no Stripe customer, so the
 * run records the month's charge row and stops before any Stripe call.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../lib/stripe', () => ({ getStripe: () => ({}) }))

import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { processFlexCreditFee } from './flexCredit'

// 6:30 pm Sept 30 in Phoenix; UTC already reads Oct 1.
const SEPT_30_EVENING = new Date('2026-10-01T01:30:00Z')

beforeEach(async () => {
  await cleanupAllSchema()
})

describe('processFlexCreditFee — cycle month (S654)', () => {
  it('a run on the evening of Sept 30 (Phoenix) bills September, not October', async () => {
    const r = await processFlexCreditFee(SEPT_30_EVENING)
    expect(r.cycle_month).toBe('2026-09-01')
  })

  it('the charge row is stamped with the Phoenix month', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description)
       VALUES ('flexcredit_rollout_visible', TRUE, 'test')`)
    const c = await db.connect()
    let tenantId = ''
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId })
      await c.query(`UPDATE tenants SET credit_reporting_enrolled = TRUE WHERE id = $1`, [tenantId])
    } finally { c.release() }

    const r = await processFlexCreditFee(SEPT_30_EVENING)
    expect(r.candidates_scanned).toBe(1)

    const { rows } = await db.query<{ cycle_month: string }>(
      `SELECT cycle_month::text AS cycle_month FROM flexcredit_charges WHERE tenant_id = $1`, [tenantId])
    expect(rows).toEqual([{ cycle_month: '2026-09-01' }])
  })
})
