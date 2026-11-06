// 10/26-27 (Nic) — the comparison a resident is shown AFTER they answer the
// survey, never before: "I want it to say learn more and kind of probe them
// for information before revealing the price."
//
// The tests that matter most here are the ones about honesty: a waived late fee
// counted back in, a month FlexPay cannot price excluded from the totals and
// SAID so, and the case where FlexPay would have cost them more shown plainly
// rather than hidden.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { flexPaySavings, flexPaySurveyDoor } from './flexpaySavings'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

interface Bill {
  /** Months back from this month. 1 = last month. */
  ago:        number
  amount:     number
  type?:      'rent' | 'utility' | 'late_fee' | 'fee'
  voided?:    boolean
  workTrade?: boolean
}

async function history(bills: Bill[], opts: { lateFees?: boolean } = {}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await client.query(`UPDATE properties SET late_fee_enabled = $2 WHERE id = $1`,
      [propertyId, opts.lateFees ?? true])
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 900, status: 'active' })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    for (const b of bills) {
      await client.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, voided_at, void_reason,
            work_trade_suspended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $11, 'RENT',
                 (date_trunc('month', CURRENT_DATE) - ($7::int || ' months')::interval)::date,
                 $8, $9, $10)`,
        [unitId, leaseId, tenantId, landlordId, b.type ?? 'rent', b.amount.toFixed(2),
         b.ago,
         b.voided ? new Date().toISOString() : null,
         b.voided ? 'test waiver' : null,
         b.workTrade ? new Date().toISOString() : null,
         // payments_voided_is_stamped: status='voided', voided_at and a reason
         // travel together. A waived late fee IS a voided row, which is also
         // why the service reads voided rows to add waivers back.
         b.voided ? 'voided' : 'settled'])
    }
    await client.query('COMMIT')
    return tenantId
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

beforeEach(cleanupAllSchema)

describe('nothing is priced before they answer the survey', () => {
  it('returns no price at all without a pull day', async () => {
    const tenantId = await history([{ ago: 1, amount: 900 }])
    const s = await flexPaySavings({ tenantId, pullDay: null })
    expect(s.pull_day).toBeNull()
    expect(s.benefit_wednesday).toBeNull()
    expect(s.months).toHaveLength(1)
    // The month is there; its price is not.
    expect(s.months[0].would_have_paid).toBeNull()
    expect(s.months_compared).toBe(0)
  })

  it('prices off the Wednesday their pull day falls in, not a day they picked', async () => {
    const tenantId = await history([{ ago: 1, amount: 900 }])
    // The 10th sits in the 2nd-Wednesday window (8th-14th): the cheapest column.
    const second = await flexPaySavings({ tenantId, pullDay: 10 })
    // The 25th sits in the 4th (22nd-28th): GAM's money is out longest.
    const fourth = await flexPaySavings({ tenantId, pullDay: 25 })
    expect(second.benefit_wednesday).toBe(2)
    expect(fourth.benefit_wednesday).toBe(4)
    expect(second.months[0].would_have_paid).toBe(23)
    expect(fourth.months[0].would_have_paid).toBe(43)
  })
})

describe('a waived late fee still counts', () => {
  it('adds a voided late fee back at its full amount', async () => {
    // Nic: "even if the landlord waived the late fee, we need to track, boom,
    // this person was late." A waiver is one landlord's decision on one day.
    const tenantId = await history([
      { ago: 1, amount: 900 },
      { ago: 1, amount: 50, type: 'late_fee' },
      { ago: 1, amount: 75, type: 'late_fee', voided: true },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months[0].late_fee_charged).toBe(50)
    expect(s.months[0].late_fee_waived).toBe(75)
    expect(s.months[0].could_have_been_charged).toBe(125)
    expect(s.could_have_been_charged).toBe(125)
  })

  it('never lets a late fee inflate the bill FlexPay would have fronted', async () => {
    // GAM charges no late fee of its own and never fronts one, so the price
    // must be set by the rent and utilities only.
    const bare = await flexPaySavings({ tenantId: await history([{ ago: 1, amount: 900 }]), pullDay: 10 })
    const withFee = await flexPaySavings({
      tenantId: await history([
        { ago: 1, amount: 900 },
        { ago: 1, amount: 400, type: 'late_fee' },
      ]), pullDay: 10 })
    expect(withFee.months[0].bill).toBe(900)
    expect(withFee.months[0].would_have_paid).toBe(bare.months[0].would_have_paid)
  })
})

describe('what rides the bill, and what does not', () => {
  it('counts utilities billed back, because that money is out too', async () => {
    const tenantId = await history([
      { ago: 1, amount: 900 },
      { ago: 1, amount: 150, type: 'utility' },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    // $1,050 crosses into the second bracket: $28 on the 2nd Wednesday.
    expect(s.months[0].bill).toBe(1050)
    expect(s.months[0].would_have_paid).toBe(28)
  })

  it('drops a work-trade month entirely — it settles in hours, not cash', async () => {
    // A month has exactly one rent bill (ux_payments_rent_idempotent), so a
    // work-trade month has no cash bill at all. FlexPay would have fronted
    // nothing, and pricing it would invent an advance that never existed.
    const tenantId = await history([
      { ago: 2, amount: 900 },
      { ago: 1, amount: 900, type: 'rent', workTrade: true },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months).toHaveLength(1)
    expect(s.months[0].bill).toBe(900)
  })

  it('leaves a voided charge out of the bill', async () => {
    const tenantId = await history([
      { ago: 1, amount: 900 },
      { ago: 1, amount: 300, type: 'utility', voided: true },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months[0].bill).toBe(900)
  })
})

describe('a month FlexPay cannot price is named, not dropped', () => {
  it('excludes it from the totals and counts it', async () => {
    // At or above $3,000 there is no bracket and the product is not offered.
    // Silently skipping the month would make the total look like a comparison
    // of the whole history when it was not.
    const tenantId = await history([
      { ago: 2, amount: 900 },
      { ago: 1, amount: 3200 },
      { ago: 1, amount: 100, type: 'late_fee' },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months).toHaveLength(2)
    expect(s.months_unpriced).toBe(1)
    expect(s.months_compared).toBe(1)
    // The $100 late fee sits in the unpriced month, so it is out of the total.
    expect(s.could_have_been_charged).toBe(0)
    expect(s.would_have_paid).toBe(23)
  })

  it('never reads a missing bracket as a free month', async () => {
    const tenantId = await history([{ ago: 1, amount: 5000 }])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months[0].would_have_paid).toBeNull()
    expect(s.would_have_paid).toBe(0)
    expect(s.months_compared).toBe(0)
  })
})

describe('the case where FlexPay costs them more', () => {
  it('shows a negative difference plainly', async () => {
    // Nic is explicit that this is shown and the enroll path stays open:
    // "they can do it out of spite for the landlord so the landlord doesn't
    // get any late fees if they wanted to."
    const tenantId = await history([
      { ago: 2, amount: 900 },
      { ago: 1, amount: 900 },
    ], { lateFees: false })
    const s = await flexPaySavings({ tenantId, pullDay: 25 })
    expect(s.could_have_been_charged).toBe(0)
    expect(s.would_have_paid).toBe(86)      // two months at $43
    expect(s.difference).toBe(-86)
    // And the screen is told WHY it is zero, so it does not read as missing data.
    expect(s.no_late_fee_policy).toBe(true)
  })

  it('reports a real saving when their own history had fees', async () => {
    const tenantId = await history([
      { ago: 2, amount: 900 },
      { ago: 2, amount: 135, type: 'late_fee' },
      { ago: 1, amount: 900 },
      { ago: 1, amount: 135, type: 'late_fee' },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 25 })
    expect(s.could_have_been_charged).toBe(270)
    expect(s.would_have_paid).toBe(86)
    expect(s.difference).toBe(184)
    expect(s.no_late_fee_policy).toBe(false)
  })
})

describe('the window', () => {
  it('ignores history older than the window asked for', async () => {
    const tenantId = await history([
      { ago: 20, amount: 900 },
      { ago: 1, amount: 900 },
    ])
    const s = await flexPaySavings({ tenantId, pullDay: 10, sinceMonths: 12 })
    expect(s.months).toHaveLength(1)
  })

  it('returns nothing at all for a resident with no history', async () => {
    const tenantId = await history([])
    const s = await flexPaySavings({ tenantId, pullDay: 10 })
    expect(s.months).toEqual([])
    expect(s.difference).toBe(0)
    expect(s.months_compared).toBe(0)
  })
})

// ── 10/26 (Nic): NOBODY OPTS IN COLD ────────────────────────────────────────
//
// Two doors to the survey — two late months, OR three clean ones. Being late
// gets them there sooner, because the product is for the person struggling
// with the date: "they can get on it sooner if they're late, if they verify
// their income."
//
// The subtle one is the last test in this block: a month counts late on the
// FACTS of the bill, even where the landlord charges no late fees at all.
describe('the two doors to the survey', () => {
  /** Bills with explicit settle timing, which is what decides lateness. */
  async function paying(months: Array<{ ago: number; late: boolean }>, opts: { lateFees?: boolean } = {}) {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      // Five days of grace, so "late" has to mean genuinely past it.
      await client.query(
        `UPDATE properties SET late_fee_enabled = $2, late_fee_grace_days = 5 WHERE id = $1`,
        [propertyId, opts.lateFees ?? true])
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 900 })
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 900, status: 'active' })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      for (const m of months) {
        await client.query(
          `INSERT INTO payments
             (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
              entry_description, due_date, settled_at)
           VALUES ($1, $2, $3, $4, 'rent', 900, 'settled', 'RENT',
                   (date_trunc('month', CURRENT_DATE) - ($5::int || ' months')::interval)::date,
                   (date_trunc('month', CURRENT_DATE) - ($5::int || ' months')::interval)::date
                     + ($6::int || ' days')::interval)`,
          [unitId, leaseId, tenantId, landlordId, m.ago, m.late ? 20 : 2])
      }
      await client.query('COMMIT')
      return tenantId
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  }

  it('stays shut on one late month and two clean ones', async () => {
    const tenantId = await paying([
      { ago: 3, late: true }, { ago: 2, late: false }, { ago: 1, late: false },
    ])
    const d = await flexPaySurveyDoor(tenantId)
    expect(d.open).toBe(false)
    expect(d.late_months).toBe(1)
    expect(d.clean_months).toBe(2)
    // One more of either kind opens it.
    expect(d.needs).toEqual({ late_months: 1, clean_months: 1 })
  })

  it('opens on two late months — being late gets them there sooner', async () => {
    const tenantId = await paying([{ ago: 2, late: true }, { ago: 1, late: true }])
    const d = await flexPaySurveyDoor(tenantId)
    expect(d.open).toBe(true)
    expect(d.via).toBe('late_months')
  })

  it('opens on three clean months', async () => {
    const tenantId = await paying([
      { ago: 3, late: false }, { ago: 2, late: false }, { ago: 1, late: false },
    ])
    const d = await flexPaySurveyDoor(tenantId)
    expect(d.open).toBe(true)
    expect(d.via).toBe('clean_months')
  })

  it('does not count paying inside the grace their lease grants them', async () => {
    // Settled two days after the due date against five days of grace. Not late.
    const tenantId = await paying([{ ago: 2, late: false }, { ago: 1, late: false }])
    const d = await flexPaySurveyDoor(tenantId)
    expect(d.late_months).toBe(0)
    expect(d.clean_months).toBe(2)
  })

  it('counts a late month even where the landlord charges no late fees', async () => {
    // This is the whole point of tracking lateness separately from the fee:
    // "even if the landlord waived the late fee, we need to track, boom, this
    // person was late." Here no fee could ever have been charged, and the
    // resident is still late twice.
    const tenantId = await paying(
      [{ ago: 2, late: true }, { ago: 1, late: true }], { lateFees: false })
    const d = await flexPaySurveyDoor(tenantId)
    expect(d.late_months).toBe(2)
    expect(d.open).toBe(true)
  })

  it('is shut for somebody with no history at all', async () => {
    const d = await flexPaySurveyDoor(await paying([]))
    expect(d.open).toBe(false)
    expect(d.late_months).toBe(0)
    expect(d.clean_months).toBe(0)
  })
})
