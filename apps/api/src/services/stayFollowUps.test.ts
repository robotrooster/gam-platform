/**
 * 10/24 (Nic) — THE FOLLOW-UP PROMPT'S GATE.
 *
 *   "I would like the note to prompt us to ask them, but only do that when we're
 *    nearing capacity. Don't waste time when we have plenty of other open space."
 *
 * Every number here is one Nic set: ask at 3-or-fewer usable sites, inside a
 * 30-day window however close, short-stay sites only, out-of-order excluded.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { stayFollowUps, followUpSentence } from './stayFollowUps'

beforeEach(async () => { await cleanupAllSchema() })

/** A park with `sites` bookable RV sites, and one resident who stated a term. */
async function park(opts: {
  sites: number
  statedMonths?: number | null
  movedInDaysAgo?: number
  unitType?: string
  monthToMonth?: boolean
}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitIds: string[] = []
    for (let i = 0; i < opts.sites; i++) {
      const id = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
      await c.query(
        `UPDATE units SET unit_type = $2, is_bookable = TRUE,
                lease_types_allowed = ARRAY['nightly','weekly'], dwelling_ownership = 'tenant'
          WHERE id = $1`, [id, opts.unitType ?? 'rv_spot'])
      unitIds.push(id)
    }
    // The resident who said how long: on site 0, on a live lease.
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId: unitIds[0], landlordId, leaseType: 'month_to_month' })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const userRow = await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    if (opts.statedMonths != null) {
      await c.query(
        `INSERT INTO background_checks (id, user_id, landlord_id, unit_id, status,
                                        desired_move_in, desired_term_months, desired_month_to_month)
         VALUES ($1,$2,$3,$4,'approved', CURRENT_DATE - ($5 || ' days')::interval, $6, $7)`,
        [randomUUID(), userRow.rows[0].user_id, landlordId, unitIds[0],
         String(opts.movedInDaysAgo ?? 60), opts.statedMonths, opts.monthToMonth === true])
    }
    return { landlordId, propertyId, unitIds, tenantId }
  } finally { c.release() }
}

const run = (f: any) => stayFollowUps({ landlordIds: [f.landlordId], scopedPropertyIds: null })

/** Fill sites 1..n with live leases so they stop counting as usable. */
async function occupy(f: any, from: number, to: number) {
  const c = await db.connect()
  try {
    for (let i = from; i <= to; i++) {
      const t = await seedTenant(c)
      const l = await seedLease(c, { unitId: f.unitIds[i], landlordId: f.landlordId, leaseType: 'month_to_month' })
      await seedLeaseTenant(c, { leaseId: l, tenantId: t })
    }
  } finally { c.release() }
}

describe('the capacity gate', () => {
  it('stays quiet while there is room — "don\'t waste time when we have plenty of open space"', async () => {
    // 10 sites, one taken: 9 usable, far above the 3 Nic set.
    const f = await park({ sites: 10, statedMonths: 2, movedInDaysAgo: 45 })
    expect(await run(f)).toEqual([])
  })

  it('asks once the park is down to three usable sites', async () => {
    const f = await park({ sites: 5, statedMonths: 2, movedInDaysAgo: 45 })
    // Site 0 is the resident's. Fill 1 so 3 remain free (2, 3, 4).
    await occupy(f, 1, 1)
    const out = await run(f)
    expect(out).toHaveLength(1)
    expect(out[0].usableSites).toBe(3)
    expect(out[0].statedMonths).toBe(2)
    expect(out[0].unitNumber).toBeTruthy()
  })

  it('counts an out-of-order site as no capacity at all when it has no return date', async () => {
    // 10 sites would be quiet. Darkening 7 of them puts the park at the gate —
    // the exact state Mountain View is in, where 22 sites are dug up for a
    // 50-amp upgrade with no date to come back on.
    const f = await park({ sites: 10, statedMonths: 2, movedInDaysAgo: 45 })
    expect(await run(f)).toEqual([])
    for (const id of f.unitIds.slice(1, 8)) {
      await query(
        `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
         VALUES ($1, $2, CURRENT_DATE - 5, NULL, 'new electric and water')`, [id, f.landlordId])
    }
    const out = await run(f)
    expect(out).toHaveLength(1)
    expect(out[0].usableSites).toBe(2)   // sites 8 and 9
  })

  it('still counts a site that comes back inside the week', async () => {
    const f = await park({ sites: 5, statedMonths: 2, movedInDaysAgo: 45 })
    await occupy(f, 1, 1)
    // Site 2 is down but back in two days — it is capacity for anybody arriving
    // after that, so it must not push the park over the gate.
    await query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
       VALUES ($1, $2, CURRENT_DATE - 1, CURRENT_DATE + 2, 'quick fix')`, [f.unitIds[2], f.landlordId])
    const out = await run(f)
    expect(out[0]?.usableSites).toBe(3)
  })

  it('ignores mobile homes and apartments — "it shouldn\'t apply to any of those"', async () => {
    // Nic: a general lease is not a space people come and go from, whoever owns
    // the dwelling. A park of mobile homes has no short-stay capacity at all,
    // so there is nothing to be near the limit OF.
    const f = await park({ sites: 2, statedMonths: 2, movedInDaysAgo: 45, unitType: 'mobile_home' })
    expect(await run(f)).toEqual([])
  })
})

describe('the 30-day window', () => {
  it('asks about a stay whose stated end is a week off', async () => {
    // Said 2 months, moved in 53 days ago: 7 days left.
    const f = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 53 })
    await occupy(f, 1, 1)
    const out = await run(f)
    expect(out).toHaveLength(1)
    expect(out[0].daysAway).toBeLessThanOrEqual(10)
  })

  it('asks even when it is only days away — "no matter how close it is"', async () => {
    const f = await park({ sites: 4, statedMonths: 1, movedInDaysAgo: 29 })
    await occupy(f, 1, 1)
    expect(await run(f)).toHaveLength(1)
  })

  it('asks about one that has already gone by, because nobody did', async () => {
    const f = await park({ sites: 4, statedMonths: 1, movedInDaysAgo: 50 })
    await occupy(f, 1, 1)
    const out = await run(f)
    expect(out).toHaveLength(1)
    expect(out[0].daysAway).toBeLessThan(0)
    expect(followUpSentence(out[0])).toMatch(/was up \d+ days? ago/)
  })

  it('says nothing about a stay months from its stated end', async () => {
    const f = await park({ sites: 4, statedMonths: 12, movedInDaysAgo: 30 })
    await occupy(f, 1, 1)
    expect(await run(f)).toEqual([])
  })
})

describe('who it does and does not ask about', () => {
  it('never asks somebody who said month-to-month — they named no end', async () => {
    const f = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 45, monthToMonth: true })
    await occupy(f, 1, 1)
    expect(await run(f)).toEqual([])
  })

  it('never asks somebody who stated nothing at all', async () => {
    const f = await park({ sites: 4, statedMonths: null })
    await occupy(f, 1, 1)
    expect(await run(f)).toEqual([])
  })

  it('never asks somebody already gone — there is nothing to ask', async () => {
    const f = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 45 })
    await occupy(f, 1, 1)
    expect(await run(f)).toHaveLength(1)
    await query(`UPDATE leases SET status = 'terminated' WHERE unit_id = $1`, [f.unitIds[0]])
    expect(await run(f)).toEqual([])
  })

  it('never reaches another company', async () => {
    const mine = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 45 })
    const theirs = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 45 })
    await occupy(mine, 1, 1); await occupy(theirs, 1, 1)
    const out = await run(mine)
    expect(out.every(f => f.propertyId === mine.propertyId)).toBe(true)
    expect(out.some(f => f.tenantId === theirs.tenantId)).toBe(false)
  })

  it('honours a staff member\'s own park and nothing else', async () => {
    const f = await park({ sites: 4, statedMonths: 2, movedInDaysAgo: 45 })
    await occupy(f, 1, 1)
    expect(await stayFollowUps({ landlordIds: [f.landlordId], scopedPropertyIds: [] })).toEqual([])
    expect(await stayFollowUps({ landlordIds: [f.landlordId], scopedPropertyIds: [f.propertyId] })).toHaveLength(1)
  })
})

describe('what the desk is told to say', () => {
  it('names the person, what they said, when it is up, and how tight the park is', async () => {
    const f = await park({ sites: 4, statedMonths: 3, movedInDaysAgo: 70 })
    await occupy(f, 1, 1)
    const [one] = await run(f)
    const say = followUpSentence(one)
    expect(say).toContain('about 3 months')
    expect(say).toMatch(/staying on/i)
    // 4 sites: the resident's own is occupied and one more was filled, so 2 are
    // open — the sentence has to say the park's real figure, not a round one.
    expect(say).toMatch(/down to 2 open sites/)
    expect(one.usableSites).toBe(2)
  })
})
