/**
 * 11/1 — IMPORTING INCOME THAT HAPPENED BEFORE GAM, WITH NO LEASE.
 *
 * Nic: "it needs to be this unit brought this much money, attributed to this
 * person's contact information. To their customer, their GAM customer profile
 * that we're making."
 *
 * The claims these hold, in the order they would hurt if broken:
 *   1. NOBODY IS BILLED. No charge, no invoice, nothing on any balance. This is
 *      money already received; the whole feature is wrong if it can ask anyone
 *      for anything.
 *   2. It is attributed to the SPACE, always, and to a GAM customer profile
 *      where the paper identifies one.
 *   3. A line that names nobody still records — the income is the space's, and
 *      losing it over a missing surname would be worse than no person on it.
 *   4. GAM never invents an identity from one scrap (the three-point rule), and
 *      never guesses between two people who both match.
 *   5. The same line twice in one file is not counted twice.
 *   6. A space belonging to another company cannot be posted as this one's.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { recordPreGamIncome, voidPreGamIncomeBatch, preGamIncomeSummary } from './preGamIncome'

async function company(c: PoolClient, unitNumber = 'RV 14') {
  const { userId, landlordId } = await seedLandlord(c)
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
  await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unitNumber])
  return { userId, landlordId, propertyId, unitId }
}

/** The pull-back and the profile resolver both need a transaction. */
async function inTx<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  try { const out = await fn(); await c.query('COMMIT'); return out }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
}

const SEPT = '2026-09-15'

describe('income from before GAM records against the space, and bills nobody', () => {
  let c: PoolClient
  beforeEach(async () => {
    await cleanupAllSchema()
    if (!c) c = await getClient()
  })

  it('NOBODY IS BILLED: no charge, no invoice, nothing owed anywhere', async () => {
    const f = await company(c)
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [{ unitId: f.unitId, occurredOn: SEPT, amount: 589, incomeType: 'stay',
               payerName: 'Dale Okafor', payerPhone: '928-555-0142' }],
    }))
    expect(out.recorded).toBe(1)

    // The three things that could ask somebody for money.
    expect((await db.query(`SELECT 1 FROM payments`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM utility_bills`)).rows).toHaveLength(0)
    // And it is not a reservation either, so no night is written and GAM's own
    // per-unit fee cannot reach it.
    expect((await db.query(`SELECT 1 FROM unit_bookings`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM unit_occupancy_nights`)).rows).toHaveLength(0)

    const row = (await db.query(
      `SELECT unit_id, amount::text AS amount, income_type, occurred_on::text AS on_day
         FROM pre_gam_income_history`)).rows[0]
    expect(row).toMatchObject({ unit_id: f.unitId, amount: '589.00', income_type: 'stay', on_day: SEPT })
  })

  it('attributes the money to one GAM customer profile when the paper identifies somebody', async () => {
    const f = await company(c)
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [{ unitId: f.unitId, occurredOn: SEPT, amount: 589, incomeType: 'stay',
               payerName: 'Dale Okafor', payerPhone: '9285550142', payerEmail: 'dale@example.test' }],
    }))
    expect(out).toMatchObject({ recorded: 1, withPerson: 1, withoutPerson: 0, profilesCreated: 1 })

    const row = (await db.query(
      `SELECT h.customer_profile_id, p.first_name, p.last_name, p.phone
         FROM pre_gam_income_history h
         JOIN customer_profiles p ON p.id = h.customer_profile_id`)).rows[0]
    expect(row.customer_profile_id).toBeTruthy()
    // The profile store normalizes names (services/customerProfiles), so the
    // assertion is on the person, not on the casing it keeps them in.
    expect(row.first_name.toLowerCase()).toBe('dale')
    expect(row.last_name.toLowerCase()).toBe('okafor')
  })

  it('two payments from the same person land on ONE profile, not two', async () => {
    const f = await company(c)
    await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [
        { unitId: f.unitId, occurredOn: '2026-08-15', amount: 589, incomeType: 'stay',
          payerName: 'Dale Okafor', payerPhone: '9285550142', payerEmail: 'dale@example.test' },
        { unitId: f.unitId, occurredOn: '2026-09-15', amount: 589, incomeType: 'stay',
          payerName: 'Dale Okafor', payerPhone: '9285550142', payerEmail: 'dale@example.test' },
      ],
    }))
    const profiles = await db.query(`SELECT DISTINCT customer_profile_id FROM pre_gam_income_history`)
    expect(profiles.rows).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM customer_profiles`)).rows).toHaveLength(1)
  })

  it('a line naming nobody still records — the income is the space\'s', async () => {
    const f = await company(c)
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [{ unitId: f.unitId, occurredOn: SEPT, amount: 450, incomeType: 'rent' }],
    }))
    expect(out).toMatchObject({ recorded: 1, withPerson: 0, withoutPerson: 1 })
    const row = (await db.query(
      `SELECT customer_profile_id, unit_id, amount::text AS amount FROM pre_gam_income_history`)).rows[0]
    expect(row.customer_profile_id).toBeNull()
    expect(row).toMatchObject({ unit_id: f.unitId, amount: '450.00' })
  })

  it('never invents a person from one scrap — "Mike" alone names nobody', async () => {
    const f = await company(c)
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [{ unitId: f.unitId, occurredOn: SEPT, amount: 300, incomeType: 'stay', payerName: 'Mike' }],
    }))
    // Recorded, but GAM does not claim to know who Mike is.
    expect(out).toMatchObject({ recorded: 1, withPerson: 0, profilesCreated: 0 })
    expect((await db.query(`SELECT 1 FROM customer_profiles`)).rows).toHaveLength(0)
    // What the operator wrote is kept regardless, so the paper is not lost.
    expect((await db.query(`SELECT payer_name FROM pre_gam_income_history`)).rows[0].payer_name).toBe('Mike')
  })

  it('does not count the same line twice in one file', async () => {
    const f = await company(c)
    const line = { unitId: f.unitId, occurredOn: SEPT, amount: 589, incomeType: 'stay' as const }
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [line, { ...line }],
    }))
    expect(out.recorded).toBe(1)
    expect(out.refused).toHaveLength(1)
    expect(out.refused[0].why).toMatch(/not counted twice/i)
    const total = (await db.query(`SELECT SUM(amount)::text AS t FROM pre_gam_income_history`)).rows[0].t
    expect(Number(total)).toBe(589)
  })

  it('refuses a space that belongs to another company', async () => {
    const mine = await company(c, 'RV 14')
    const theirs = await company(c, 'RV 99')
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: mine.landlordId, byUserId: mine.userId, importSource: 'generic',
      rows: [{ unitId: theirs.unitId, occurredOn: SEPT, amount: 589, incomeType: 'stay' }],
    }))
    expect(out.recorded).toBe(0)
    expect(out.refused[0].why).toMatch(/does not belong to this company/i)
  })

  it('a whole file can be taken back out together, and voided rows stop counting', async () => {
    const f = await company(c)
    const out = await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [
        { unitId: f.unitId, occurredOn: '2026-09-01', amount: 589, incomeType: 'stay' },
        { unitId: f.unitId, occurredOn: '2026-09-20', amount: 200, incomeType: 'fee' },
      ],
    }))
    expect(out.recorded).toBe(2)
    expect(await preGamIncomeSummary(db, { landlordId: f.landlordId })).toHaveLength(2)

    const undone = await inTx(c, () => voidPreGamIncomeBatch(c, {
      landlordId: f.landlordId, batchId: out.batchId, why: 'the amounts were off by a column',
    }))
    expect(undone).toMatchObject({ voided: 2, amount: 789 })
    // Kept, never deleted — and out of every total.
    expect((await db.query(`SELECT 1 FROM pre_gam_income_history`)).rows).toHaveLength(2)
    expect(await preGamIncomeSummary(db, { landlordId: f.landlordId })).toHaveLength(0)
  })

  it('sums by month and space, which is what the books need', async () => {
    const f = await company(c, 'RV 14')
    await inTx(c, () => recordPreGamIncome(c, {
      landlordId: f.landlordId, byUserId: f.userId, importSource: 'generic',
      rows: [
        { unitId: f.unitId, occurredOn: '2026-09-02', amount: 589, incomeType: 'stay' },
        { unitId: f.unitId, occurredOn: '2026-09-27', amount: 411, incomeType: 'stay' },
        { unitId: f.unitId, occurredOn: '2026-08-10', amount: 500, incomeType: 'stay' },
      ],
    }))
    const rows = await preGamIncomeSummary(db, { landlordId: f.landlordId })
    const sept = rows.find(r => r.month === '2026-09')!
    expect(sept).toMatchObject({ unitNumber: 'RV 14', incomeType: 'stay', total: 1000, rows: 2 })
    expect(rows.find(r => r.month === '2026-08')!.total).toBe(500)
    // Narrowing to one month is what a monthly report asks for.
    const justSept = await preGamIncomeSummary(db, {
      landlordId: f.landlordId, from: '2026-09-01', to: '2026-09-30',
    })
    expect(justSept).toHaveLength(1)
    expect(justSept[0].total).toBe(1000)
  })
})
