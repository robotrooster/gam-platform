/**
 * 10/20 (Nic) — DELIVERED PROPANE IS NEVER DECIDED BY THE KIND OF SITE.
 *
 *   "It's basically at Mountain View, the distinction line is going to be larger
 *    tanks that the company will come fill are only at mobile home sites. At
 *    another property that's yet to be onboarded, that will also happen at RV
 *    sites. So it needs to not be unit type exclusive."
 *
 * That is the whole test. A rule that read units.unit_type would be right at
 * Mountain View and wrong at the next park on its FIRST DAY, with a truck
 * already gone and gallons nobody could bill. So the same delivery is recorded
 * on a mobile home space and on an RV space and the two have to come out
 * identical — same gallons, same price, same tax, same schedule — and a space
 * with no tank marked has to be refused on both, for the same reason.
 *
 * Run (migrations 20261022090000 / 20261022090100 are not on production yet):
 *   DB_NAME=gam_pl_test TEST_DB_NAME=gam_pl_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/services/propaneDeliveredNeverByUnitType.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { validateFillLine, recordFill, type UnitFillContext } from './propaneFill'
import { spaceTakesDeliveredPropane, propaneModeOfLine, PROPANE_MODES, PROPANE_MODE_LABEL } from './propaneMode'

/** One occupied space of the given kind, with a tank on it. */
async function space(client: PoolClient, unitType: string, opts: { tank?: boolean } = {}) {
  const { userId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId: userId, managedByUserId: userId })
  await client.query(
    `UPDATE properties SET timezone = 'America/Phoenix', propane_allow_installments = TRUE WHERE id = $1`,
    [propertyId])
  await client.query(
    `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct)
     VALUES ($1, 'propane', 6.60)
     ON CONFLICT DO NOTHING`, [propertyId])
  const unitId = await seedUnit(client, { propertyId, landlordId, unitType })
  await client.query(`UPDATE units SET has_propane_tank = $2 WHERE id = $1`,
    [unitId, opts.tank !== false])
  const tenantId = await seedTenant(client, {})
  const leaseId = await seedLease(client, { unitId, landlordId })
  await seedLeaseTenant(client, { leaseId, tenantId })

  const unit = (await client.query<UnitFillContext>(
    `SELECT u.id, u.landlord_id, u.property_id, u.unit_number, u.has_propane_tank,
            p.propane_allow_installments, p.propane_split_min_gallons,
            p.propane_split_four_min_gallons, p.timezone
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [unitId])).rows[0]
  return { userId, landlordId, propertyId, unitId, tenantId, leaseId, unit }
}

/** 48 gallons at $3.30, split two ways — the same delivery every time. */
async function deliver(client: PoolClient, s: { unit: UnitFillContext; userId: string }) {
  const { leaseId, tenantId } = await validateFillLine(client, s.unit, { gallons: 48, installments: 2 })
  return recordFill(client, {
    unit: s.unit, leaseId, tenantId, gallons: 48, pricePerGallon: 3.30,
    installments: 2, createdByUserId: s.userId, deliveryFeeShare: 0,
  })
}

beforeEach(cleanupAllSchema)

describe('the same delivery on a mobile home site and on an RV site', () => {
  it('records identically — nothing in the path can see the unit type', async () => {
    const client = await getClient()
    try {
      const mh = await space(client, 'mobile_home')
      const rv = await space(client, 'rv_spot')
      expect(mh.unit.has_propane_tank).toBe(true)
      expect(rv.unit.has_propane_tank).toBe(true)

      const a = await deliver(client, mh)
      const b = await deliver(client, rv)

      // 48 x 3.30 = 158.40, + 6.60% = 10.45  ->  168.85
      for (const f of [a, b]) {
        expect(Number(f.gallons)).toBe(48)
        expect(Number(f.price_per_gallon)).toBe(3.3)
        expect(Number(f.tax_rate_pct)).toBe(6.6)
        expect(Number(f.tax_amount)).toBe(10.45)
        expect(Number(f.total_amount)).toBe(168.85)
        expect(f.installment_count).toBe(2)
      }
      expect(Number(a.total_amount)).toBe(Number(b.total_amount))

      const sched = async (fillId: string) => (await client.query<{ gallons: string; amount: string }>(
        `SELECT gallons::text, amount::text FROM propane_fill_installments
          WHERE fill_id = $1 ORDER BY installment_number`, [fillId])).rows
          .map(r => [Number(r.gallons), Number(r.amount)])
      expect(await sched(a.id)).toEqual(await sched(b.id))
    } finally { client.release() }
  })

  it('refuses a space with no tank on EITHER kind, with the same reason', async () => {
    const client = await getClient()
    try {
      for (const unitType of ['mobile_home', 'rv_spot']) {
        const s = await space(client, unitType, { tank: false })
        expect(spaceTakesDeliveredPropane(s.unit)).toBe(false)
        await expect(validateFillLine(client, s.unit, { gallons: 48, installments: 1 }))
          .rejects.toThrow(/has no propane tank on record/)
      }
    } finally { client.release() }
  })

  it('the marking is the space\'s own fact, and turning it on makes the RV site deliverable', async () => {
    const client = await getClient()
    try {
      const rv = await space(client, 'rv_spot', { tank: false })
      await expect(validateFillLine(client, rv.unit, { gallons: 48, installments: 1 }))
        .rejects.toThrow(/has no propane tank on record/)
      const on = { ...rv.unit, has_propane_tank: true }
      const { leaseId } = await validateFillLine(client, on, { gallons: 48, installments: 1 })
      expect(leaseId).toBe(rv.leaseId)
    } finally { client.release() }
  })
})

describe('the two modes are named, and nothing renders the raw word', () => {
  it('a delivery is delivered, a counter sale is dispensed', () => {
    expect(PROPANE_MODES).toEqual(['delivered', 'dispensed'])
    expect(propaneModeOfLine({ recoversUtility: null })).toBe('dispensed')
    expect(propaneModeOfLine({ recoversUtility: 'propane' })).toBe('delivered')
    expect(PROPANE_MODE_LABEL.delivered).toBe('Delivered to the space')
    expect(PROPANE_MODE_LABEL.dispensed).toBe('Dispensed at the counter')
    for (const m of PROPANE_MODES) expect(PROPANE_MODE_LABEL[m]).not.toBe(m)
  })
})
