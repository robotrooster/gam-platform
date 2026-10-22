/**
 * 10/22 (Nic) — AN RV MONTH-TO-MONTH WHO LEFT MID-MONTH GETS THE WASH.
 *
 * The 10/20 rule was "a lease never washes", and its reason was a TERM still
 * owed: "if it says they're good through 2 more months and they leave early and
 * we keep the money, that's money that we're legally entitled to."
 *
 * 10/22 he explained why that reason does not reach these leases at all:
 *
 *   "The only reason I have the RV people on month-to-month leases is so that
 *    the schedule is blocked out indefinitely while they are here. A lot of
 *    these people come on work contracts. They're either going to be here 6
 *    months or 2 years or something in the middle, and they don't really know."
 *
 * So the lease is a hold on the calendar, not a promise of future months, and
 * somebody who paid for October and left on the 20th kept money with no claim
 * on the nights behind it — a stay's shape.
 *
 * AND IT IS RV-ONLY, which he was specific about:
 *
 *   "Month to month will bill in any other unit type as well... A month to
 *    month lease on an apartment where somebody dips out, if the utilities are
 *    being billed back, that tenant definitely owes them, because those leases
 *    are normally required to give a 30-day notice. And if they just up and
 *    leave in the middle, that's a different story than the RV worker being
 *    sent to a different job location on a moment's notice."
 *
 * The arithmetic itself is covered in earlyDepartureWashProration.test.ts. This
 * is about WHO the wash reaches, end to end through the real verdict.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedUtilityMeter } from '../test/dbHelpers'
import { washVerdict, moneyKeptForDeparture, settleFinalStubForDeparture, washPairing } from './earlyDepartureWash'

/** Their real shape: $589 a month, rent due the 1st, October. */
const RENT = 589
const LEFT_ON = '2026-10-20'      // gone the morning of the 20th
const PAID_THROUGH = '2026-10-31'

beforeEach(async () => { await cleanupAllSchema() })

async function park(opts: { unitType?: string } = {}) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET rent_due_day = 1, timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: (opts.unitType ?? 'rv_spot') as any })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric', billingMethod: 'submeter' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, meterId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/**
 * The rent they actually paid for a month. A wash can only keep money that
 * arrived, so every case that expects one has to have the money on file.
 */
async function rentPaid(p: Awaited<ReturnType<typeof park>>, leaseId: string, due: string, amount = RENT) {
  await db.query(
    `INSERT INTO payments (lease_id, unit_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
     VALUES ($1, $2, $3, 'rent', $4, 'settled', 'RENT', $5::date, $5::timestamptz)`,
    [leaseId, p.unitId, p.landlordId, amount, due])
}

/** A lease that ended on the day they drove out. */
async function leaseThatEnded(p: Awaited<ReturnType<typeof park>>, o: {
  leaseType?: 'month_to_month' | 'fixed_term'; endedOn?: string | null
} = {}) {
  const c = await getClient()
  let leaseId: string
  try {
    await c.query('BEGIN')
    leaseId = await seedLease(c, {
      unitId: p.unitId, landlordId: p.landlordId, rentAmount: RENT,
      leaseType: o.leaseType ?? 'month_to_month', status: 'terminated', startDate: '2026-04-01',
    })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  const endedOn = o.endedOn === undefined ? LEFT_ON : o.endedOn
  await db.query(`UPDATE leases SET end_date = $2, rent_due_day = 1 WHERE id = $1`, [leaseId, endedOn])
  return leaseId
}

describe('an RV month-to-month who left mid-month', () => {
  it('washes, for the nights of the month they paid for and did not use', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    const v = await washVerdict({ leaseId }, p.landlordId)
    expect(v.verdict).toBe('wash')
    // $589 over October's 31 nights is $19.00; gone the morning of the 20th
    // leaves the nights of the 20th through the 31st unused — twelve.
    expect(v.amountKept).toBe(228)
    expect(v.departedOn).toBe(LEFT_ON)
    expect(v.paidThrough).toBe(PAID_THROUGH)
    expect(v.why).toMatch(/12 days before the month they paid for ran out/)
  })

  it('and the figure stamped on the record is the one the verdict was given on', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    const kept = await moneyKeptForDeparture({ leaseId }, p.landlordId)
    expect(kept).toMatchObject({ amountKept: 228, refundGiven: false, refundAmount: 0 })
    // Rent is not a short stay, so re-pricing it owes no lodging tax and the
    // net is the same number.
    expect(kept!.lodgingTaxOwed).toBe(0)
    expect(kept!.amountKeptNet).toBe(228)
    expect(kept!.source).toMatch(/monthly rent ÷ days in that month/)
  })
})

describe('who the wash does NOT reach', () => {
  it('a FIXED-TERM lease still bills — 10/20 stands where a term is still owed', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p, { leaseType: 'fixed_term' })
    await rentPaid(p, leaseId, '2026-10-01')
    const v = await washVerdict({ leaseId }, p.landlordId)
    expect(v.verdict).toBe('bill')
    expect(v.why).toMatch(/agreed amount for an agreed time/)
    expect(v.amountKept).toBe(0)
  })

  it('a month-to-month APARTMENT still bills — those leases carry a notice period', async () => {
    const p = await park({ unitType: 'apartment' })
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    expect((await washVerdict({ leaseId }, p.landlordId)).verdict).toBe('bill')
  })

  it('a month-to-month MOBILE HOME still bills — RV only, in his words', async () => {
    const p = await park({ unitType: 'mobile_home' })
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    expect((await washVerdict({ leaseId }, p.landlordId)).verdict).toBe('bill')
  })

  it('an RV who used every night they paid for bills normally', async () => {
    // "If they leave right at the end of the time they paid for, we still bill."
    // They paid October and drove out the morning of the 1st: no November rent
    // was ever taken, so there is no November to pro-rate.
    const p = await park()
    const leaseId = await leaseThatEnded(p, { endedOn: '2026-11-01' })
    await rentPaid(p, leaseId, '2026-10-01')
    const v = await washVerdict({ leaseId }, p.landlordId)
    expect(v.verdict).toBe('bill')
    expect(v.amountKept).toBe(0)
  })

  it('an RV who never paid the month they left in bills normally', async () => {
    // "The wash is about money KEPT, not money never collected." They owe for
    // the days they used; nothing stayed with the landlord to set against it.
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    const v = await washVerdict({ leaseId }, p.landlordId)
    expect(v.verdict).toBe('bill')
    expect(v.amountKept).toBe(0)
  })

  it('rent still owed for the month does not count — only money that arrived', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    await db.query(
      `INSERT INTO payments (lease_id, unit_id, landlord_id, type, amount, status, entry_description, due_date)
       VALUES ($1, $2, $3, 'rent', $4, 'pending', 'RENT', '2026-10-01')`,
      [leaseId, p.unitId, p.landlordId, RENT])
    expect((await washVerdict({ leaseId }, p.landlordId)).verdict).toBe('bill')
  })

  it('a month they paid for and used none of goes to the desk, not to a wash', async () => {
    // A full month back is a refund question for a person, not a quiet keep.
    const p = await park()
    const leaseId = await leaseThatEnded(p, { endedOn: '2026-11-01' })
    await rentPaid(p, leaseId, '2026-11-01')
    expect((await washVerdict({ leaseId }, p.landlordId)).verdict).toBe('bill')
  })

  it('a part first month is pro-rated over the days that money covered', async () => {
    // Moved in on the 10th, billed $380 for the 22 nights of October left, then
    // gone on the 20th: $380 ÷ 22 nights is $17.27, and the 20th through the
    // 31st — twelve nights — went unused.
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-10', 380)
    const v = await washVerdict({ leaseId }, p.landlordId)
    expect(v.verdict).toBe('wash')
    expect(v.amountKept).toBe(207.27)
  })

  it('a lease still running has nobody who left, so there is nothing to wash', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p, { endedOn: null })
    await rentPaid(p, leaseId, '2026-10-01')
    expect((await washVerdict({ leaseId }, p.landlordId)).verdict).toBe('bill')
  })

  it('cannot be reached across accounts', async () => {
    const p = await park()
    const other = await park()
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    expect((await washVerdict({ leaseId }, other.landlordId)).verdict).toBe('bill')
    expect(await moneyKeptForDeparture({ leaseId }, other.landlordId)).toBeNull()
  })
})

describe('the night of the leaving day', () => {
  it('is never charged — one night later is one night less kept', async () => {
    const p = await park()
    const a = await leaseThatEnded(p, { endedOn: '2026-10-20' })
    await rentPaid(p, a, '2026-10-01')
    const earlier = (await washVerdict({ leaseId: a }, p.landlordId)).amountKept
    await db.query(`UPDATE leases SET end_date = '2026-10-21' WHERE id = $1`, [a])
    const later = (await washVerdict({ leaseId: a }, p.landlordId)).amountKept
    expect(Math.round((earlier - later) * 100) / 100).toBe(19)
  })
})

describe('the register checks one out and the wash lands, both halves', () => {
  it('the power is recorded as billed to nobody, against the rent that stayed', async () => {
    const p = await park()
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')

    const settled = await settleFinalStubForDeparture({
      landlordId: p.landlordId, meterId: p.meterId, unitId: p.unitId,
      utilityType: 'electric', cycleMonth: '2026-10-01',
      chargeAmount: 81.27, baseFeeShare: 0, taxAmount: 0, taxRatePct: 0,
      usageAmount: 387, allocationMethod: 'submeter',
      ratePerUnit: 0.21, readingStart: 1000, readingEnd: 1387,
      readingStartDate: '2026-10-01', readingEndDate: LEFT_ON,
      ref: { leaseId },
    })
    expect(settled.outcome).toBe('absorbed')
    expect(settled.washId).toBeTruthy()

    // The money side, with the reason a person reads on the report.
    const w = (await db.query<any>(
      `SELECT amount_kept::float AS kept, notes, lease_id, booking_id,
              to_char(departed_on, 'YYYY-MM-DD') AS left_on,
              to_char(paid_through, 'YYYY-MM-DD') AS paid_through
         FROM early_departure_washes WHERE landlord_id = $1`, [p.landlordId])).rows
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kept: 228, lease_id: leaseId, booking_id: null,
      left_on: LEFT_ON, paid_through: PAID_THROUGH })
    expect(w[0].notes).toMatch(/12 days before the month they paid for ran out/)

    // The power side.
    const abs = (await db.query<any>(
      `SELECT reason, charge_amount::float AS charge, wash_id, lease_id
         FROM utility_absorbed_charges WHERE landlord_id = $1`, [p.landlordId])).rows
    expect(abs).toHaveLength(1)
    expect(abs[0]).toMatchObject({ reason: 'early_departure_wash', charge: 81.27, wash_id: settled.washId })

    // And nobody was billed for it.
    const bills = (await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_bills WHERE landlord_id = $1`, [p.landlordId])).rows[0]
    expect(Number(bills.n)).toBe(0)

    // One row on the recovery report: what was kept against what was eaten.
    const pairs = await washPairing(p.landlordId, {})
    expect(pairs).toHaveLength(1)
    expect(pairs[0].moneyKept).toBe(228)
    expect(pairs[0].utilityAbsorbed).toBe(81.27)
  })

  it('a month-to-month apartment is billed as usual — the stub reaches somebody', async () => {
    const p = await park({ unitType: 'apartment' })
    const leaseId = await leaseThatEnded(p)
    await rentPaid(p, leaseId, '2026-10-01')
    const settled = await settleFinalStubForDeparture({
      landlordId: p.landlordId, meterId: p.meterId, unitId: p.unitId,
      utilityType: 'electric', cycleMonth: '2026-10-01',
      chargeAmount: 81.27, usageAmount: 387, allocationMethod: 'submeter',
      readingStartDate: '2026-10-01', readingEndDate: LEFT_ON,
      ref: { leaseId },
    })
    expect(settled.outcome).toBe('bill_normally')
    const abs = (await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM utility_absorbed_charges WHERE landlord_id = $1`, [p.landlordId])).rows[0]
    expect(Number(abs.n)).toBe(0)
  })
})
