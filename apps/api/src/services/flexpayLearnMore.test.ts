/**
 * 10/26 (Nic) — WHAT A RESIDENT IS ASKED, AND WHAT THEY ARE SHOWN.
 *
 *   "We don't ask them when they want to pay. If they get paid on the second
 *    Wednesday, they cannot choose the third Wednesday just for the heck of
 *    it."
 *
 *   "We don't want to show tenants the table."
 *
 * So the tests here are mostly about absence: the price grid never reaches
 * them, nobody else's late fee does, and a price exists only once they have
 * said when their own money lands.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { flexPayLearnMore, recordMoneyArrivesDay, lateFeeInWords, FLEXPAY_PAST_PERFORMANCE } from './flexpaySavings'
import { expectNoFigures } from '../test/noLeaks'

beforeEach(cleanupAllSchema)

async function resident(o: { lateFee?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const l = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
    await c.query(
      `UPDATE properties
          SET late_fee_enabled = $2, late_fee_initial_amount = 50, late_fee_initial_type = 'flat',
              late_fee_grace_days = 5
        WHERE id = $1`, [propertyId, o.lateFee !== false])
    const unitId = await seedUnit(c, { propertyId, landlordId: l.landlordId })
    // S535: the per-(property, unit_type) row is the ONLY source of a late-fee
    // policy — there is no property-wide default, deliberately. So a resident
    // whose landlord has not decided for their unit type has no policy to
    // show, which the screen has to handle.
    if (o.lateFee !== false) {
      const ut = (await c.query<{ unit_type: string }>(
        `SELECT unit_type FROM units WHERE id = $1`, [unitId])).rows[0].unit_type
      await c.query(
        `INSERT INTO property_unit_type_late_fees
           (property_id, unit_type, late_fee_grace_days, late_fee_initial_amount, late_fee_initial_type)
         VALUES ($1, $2, 5, 50, 'flat')`, [propertyId, ut])
    }
    const leaseId = await seedLease(c, { unitId, landlordId: l.landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query('COMMIT')
    return { tenantId, unitId, leaseId, propertyId, landlordId: l.landlordId }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const feature = (on: boolean) => db.query(
  `INSERT INTO system_features (key, enabled, description)
   VALUES ('flexpay_rollout_visible', $1, 'test')
   ON CONFLICT (key) DO UPDATE SET enabled = $1`, [on])

describe('before they say when their money arrives', () => {
  it('has no price and no figures at all', async () => {
    const w = await resident()
    await feature(true)
    const m = await flexPayLearnMore(w.tenantId)
    expect(m.money_arrives_day).toBeNull()
    expect(m.pull_day).toBeNull()
    // No savings object at all rather than one full of zeros: a zero reads as
    // "FlexPay would save you nothing", which is not what we know.
    expect(m.savings).toBeNull()
  })

  it('still tells them what their own lease says, and whose call it has been', async () => {
    const w = await resident()
    await feature(true)
    const m = await flexPayLearnMore(w.tenantId)
    expect(m.late_fee_words).toContain('$50.00')
    expect(m.late_fee_words).toContain('5-day grace period')
    expect(m.late_fee_words).toContain("your landlord's call")
    expect(m.disclaimer).toBe(FLEXPAY_PAST_PERFORMANCE)
  })

  it('says nothing about a late fee the landlord has never decided', async () => {
    // S535: no property-wide default, on purpose. Silence is the honest
    // answer; a figure here would be one nobody agreed to.
    const w = await resident({ lateFee: false })
    await feature(true)
    expect((await flexPayLearnMore(w.tenantId)).late_fee_words).toBeNull()
  })

  it('says nothing when the product is not being offered', async () => {
    const w = await resident()
    await feature(false)
    expect((await flexPayLearnMore(w.tenantId)).offered).toBe(false)
  })
})

describe('the one question, and the day it derives', () => {
  it('draws on the day their money lands, which they never choose', async () => {
    const w = await resident()
    await feature(true)
    const { pullDay } = await recordMoneyArrivesDay(w.tenantId, 17)
    expect(pullDay).toBe(17)
    const m = await flexPayLearnMore(w.tenantId)
    expect(m.money_arrives_day).toBe(17)
    expect(m.pull_day).toBe(17)
    // The 15th-21st IS the third Wednesday, so the column follows from the day
    // with nothing to guess.
    expect(m.savings?.benefit_wednesday).toBe(3)
  })

  it('money that lands before rent is late derives no draw day at all', async () => {
    // The 1st-5th: they are paid before rent is late anywhere, so there is no
    // gap to cover, and those days cannot be drawn on in any case.
    const w = await resident()
    await feature(true)
    const { pullDay } = await recordMoneyArrivesDay(w.tenantId, 3)
    expect(pullDay).toBeNull()
    const m = await flexPayLearnMore(w.tenantId)
    expect(m.money_arrives_day).toBe(3)
    expect(m.arrives_before_rent_is_late).toBe(true)
    expect(m.savings).toBeNull()
  })

  it('refuses a day that is not a day of the month', async () => {
    const w = await resident()
    await expect(recordMoneyArrivesDay(w.tenantId, 31)).rejects.toThrow(/1st to the 28th/)
    await expect(recordMoneyArrivesDay(w.tenantId, 0)).rejects.toThrow(/1st to the 28th/)
  })

  it('does not move the draw day of somebody already enrolled', async () => {
    // Answering a survey is not a change to a live bill.
    const w = await resident()
    await feature(true)
    await db.query(
      `UPDATE tenants SET flexpay_enrolled = true, flexpay_pull_day = 10 WHERE id = $1`, [w.tenantId])
    await recordMoneyArrivesDay(w.tenantId, 25)
    const t = await db.query<{ pull: number }>(
      `SELECT flexpay_pull_day AS pull FROM tenants WHERE id = $1`, [w.tenantId])
    expect(t.rows[0].pull).toBe(10)
  })
})

describe('what never reaches the resident', () => {
  it('carries no price grid — only their own price', async () => {
    const w = await resident()
    await feature(true)
    await recordMoneyArrivesDay(w.tenantId, 17)
    const m = await flexPayLearnMore(w.tenantId)
    const shown = JSON.stringify(m)
    // Every other cell of the grid. If a bracket table were ever attached to
    // this payload, these would turn up.
    for (const other of ['23', '28', '33', '38', '43', '47', '52', '61', '70', '79']) {
      expect(shown.includes(`"${other}"`)).toBe(false)
    }
    // And no sign of the bracket edges that define the table.
    expectNoFigures(m, [1499, 1500, 1999, 2000, 2499, 2500, 2999, 3000])
  })

  it('names no other landlord, property or resident', async () => {
    const w = await resident()
    await feature(true)
    await recordMoneyArrivesDay(w.tenantId, 17)
    const m = await flexPayLearnMore(w.tenantId)
    const shown = JSON.stringify(m)
    expect(shown).not.toContain('landlord_id')
    expect(shown).not.toContain('property_id')
    expect(shown).not.toContain('tenant_id')
  })
})

describe('the lease in plain words', () => {
  it('says a flat fee, a grace period, an accrual and a cap the way a person would', () => {
    expect(lateFeeInWords({
      source: 'unit_type_override', unit_type: null, property_name: 'x',
      late_fee_grace_days: 5,
      late_fee_initial_amount: '50', late_fee_initial_type: 'flat',
      late_fee_accrual_amount: '5', late_fee_accrual_type: 'flat', late_fee_accrual_period: 'daily',
      late_fee_accrual_from: 'grace_end',
      late_fee_cap_amount: '200', late_fee_cap_type: 'flat',
    })).toBe('Your lease allows a late fee of $50.00 after a 5-day grace period, then $5.00 per day, '
           + "up to $200.00. Whether it is actually charged has been your landlord's call each time.")
  })

  it('says a percentage as a percentage of their rent, never a dollar figure', () => {
    const s = lateFeeInWords({
      source: 'unit_type_override', unit_type: null, property_name: 'x',
      late_fee_grace_days: 0,
      late_fee_initial_amount: '10', late_fee_initial_type: 'percent_of_rent',
      late_fee_accrual_amount: null, late_fee_accrual_type: null, late_fee_accrual_period: null,
      late_fee_accrual_from: 'due_date',
      late_fee_cap_amount: null, late_fee_cap_type: null,
    })
    expect(s).toContain('10% of your rent')
    expect(s).toContain('the day rent is late')
  })

  it('says nothing at all when no policy resolves', () => {
    expect(lateFeeInWords(null)).toBeNull()
  })
})
