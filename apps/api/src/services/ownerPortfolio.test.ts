/**
 * S645 — the owner's whole book, and the managers judged side by side.
 *
 * The case this exists for is Nic's: an owner who trusts half their portfolio
 * to one manager and half to another, wanting to know which one is doing
 * better. So the tests are mostly about the split staying honest — that the
 * two halves are separated by manager, that self-managed property is its own
 * column, that a small park cannot outvote a large one in an average, and that
 * a manager with nothing to collect is not scored zero for it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getClient } from '../db'
import { ownerPortfolio } from './ownerPortfolio'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease,
  seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 864e5))

async function park(client: any, o: { landlordId: string; userId: string },
                    pmCompanyId: string | null) {
  const propertyId = await seedProperty(client, {
    landlordId: o.landlordId, ownerUserId: o.userId, managedByUserId: o.userId })
  if (pmCompanyId) {
    await client.query(`UPDATE properties SET pm_company_id=$2 WHERE id=$1`,
      [propertyId, pmCompanyId])
  }
  return propertyId
}

/** A unit with an active lease on it. */
async function leasedUnit(client: any, propertyId: string, landlordId: string) {
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  await seedLease(client, {
    unitId, landlordId, rentAmount: 1000, status: 'active', startDate: daysAgo(200) })
  return unitId
}

/** A rent charge that came due, and either settled on time or late. */
async function rentDue(client: any, unitId: string, landlordId: string, opts: {
  dueDaysAgo: number; lateDays?: number | null
}) {
  const due = daysAgo(opts.dueDaysAgo)
  const settled = opts.lateDays == null
    ? null
    : daysAgo(opts.dueDaysAgo - opts.lateDays)
  await client.query(
    `INSERT INTO payments (unit_id, landlord_id, type, amount, status, due_date,
       entry_description, settled_at)
     VALUES ($1,$2,'rent',1000,$4,$3::date,'RENT',$5::date)`,
    [unitId, landlordId, due, settled ? 'settled' : 'pending', settled])
}

describe('one login, the whole book', () => {
  it('shows both managers and the self-managed half together', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const a = await seedPmCompany(client, { bankAccountId: bankId, name: 'Able Management' })
      const b = await seedPmCompany(client, { bankAccountId: bankId, name: 'Baker Property Co' })
      const o = { userId, landlordId }

      await leasedUnit(client, await park(client, o, a), landlordId)
      await leasedUnit(client, await park(client, o, b), landlordId)
      await leasedUnit(client, await park(client, o, null), landlordId)

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers).toHaveLength(3)
      // The owner's own half reads first — it is the baseline they judge against.
      expect(p.managers[0].pmCompanyName).toBe('Self-managed')
      expect(p.managers[0].pmCompanyId).toBeNull()
      expect(p.managers.map(m => m.pmCompanyName))
        .toEqual(['Self-managed', 'Able Management', 'Baker Property Co'])
      expect(p.totals.unitCount).toBe(3)
    } finally { client.release() }
  })

  it('never reaches into another account\'s portfolio', async () => {
    const client = await getClient()
    try {
      const mine = await seedLandlord(client)
      const theirs = await seedLandlord(client)
      await leasedUnit(client, await park(client,
        { userId: mine.userId, landlordId: mine.landlordId }, null), mine.landlordId)
      await leasedUnit(client, await park(client,
        { userId: theirs.userId, landlordId: theirs.landlordId }, null), theirs.landlordId)

      const p = await ownerPortfolio({ landlordIds: [mine.landlordId] })
      expect(p.totals.unitCount).toBe(1)
    } finally { client.release() }
  })

  it('handles one manager running a whole portfolio for one owner', async () => {
    // Nic: "I could manage a huge portfolio on behalf of one landlord, one
    // owner. I could manage 10 single family houses all for the same owner."
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pm = await seedPmCompany(client, { bankAccountId: bankId, name: 'Solo Manager' })
      for (let i = 0; i < 10; i++) {
        await leasedUnit(client, await park(client, { userId, landlordId }, pm), landlordId)
      }
      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers).toHaveLength(1)
      expect(p.managers[0].propertyCount).toBe(10)
      expect(p.managers[0].unitCount).toBe(10)
      expect(p.managers[0].occupancyPct).toBe(100)
    } finally { client.release() }
  })
})

describe('collecting on time', () => {
  it('scores each manager on the rent they were responsible for', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const good = await seedPmCompany(client, { bankAccountId: bankId, name: 'Good Co' })
      const slow = await seedPmCompany(client, { bankAccountId: bankId, name: 'Slow Co' })
      const o = { userId, landlordId }

      const gUnit = await leasedUnit(client, await park(client, o, good), landlordId)
      await rentDue(client, gUnit, landlordId, { dueDaysAgo: 90, lateDays: 0 })
      await rentDue(client, gUnit, landlordId, { dueDaysAgo: 60, lateDays: 0 })
      await rentDue(client, gUnit, landlordId, { dueDaysAgo: 30, lateDays: 0 })

      const sUnit = await leasedUnit(client, await park(client, o, slow), landlordId)
      await rentDue(client, sUnit, landlordId, { dueDaysAgo: 90, lateDays: 0 })
      await rentDue(client, sUnit, landlordId, { dueDaysAgo: 60, lateDays: 10 })
      await rentDue(client, sUnit, landlordId, { dueDaysAgo: 30, lateDays: 20 })

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      const g = p.managers.find(m => m.pmCompanyName === 'Good Co')!
      const s = p.managers.find(m => m.pmCompanyName === 'Slow Co')!
      expect(g.onTimeRatePct).toBe(100)
      expect(g.avgDaysLate).toBeNull()
      expect(s.onTimeRatePct).toBe(33.33)
      expect(s.avgDaysLate).toBe(15)       // (10 + 20) / 2
      expect(s.rentDueCount).toBe(3)
    } finally { client.release() }
  })

  it('does not score a manager zero for having collected nothing yet', async () => {
    // A brand-new manager with no rent roll has not failed at anything, and a
    // 0% on their card would be a lie an owner might act on.
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pm = await seedPmCompany(client, { bankAccountId: bankId, name: 'New Co' })
      await leasedUnit(client, await park(client, { userId, landlordId }, pm), landlordId)

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers[0].onTimeRatePct).toBeNull()
      expect(p.managers[0].rentDueCount).toBe(0)
    } finally { client.release() }
  })

  it('weights a big park above a small one in the manager\'s average', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pm = await seedPmCompany(client, { bankAccountId: bankId, name: 'Mixed Co' })
      const o = { userId, landlordId }

      // Big park: 4 charges, all on time.
      const big = await park(client, o, pm)
      for (let i = 0; i < 4; i++) {
        const u = await leasedUnit(client, big, landlordId)
        await rentDue(client, u, landlordId, { dueDaysAgo: 30, lateDays: 0 })
      }
      // Small park: 1 charge, late.
      const small = await park(client, o, pm)
      const su = await leasedUnit(client, small, landlordId)
      await rentDue(client, su, landlordId, { dueDaysAgo: 30, lateDays: 5 })

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      // 4 of 5 on time = 80%. Averaging the two PROPERTY rates (100% and 0%)
      // would have said 50% and made the manager look twice as bad.
      expect(p.managers[0].onTimeRatePct).toBe(80)
    } finally { client.release() }
  })
})

describe('filling vacancies', () => {
  it('measures the gap between one lease ending and the next starting', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pm = await seedPmCompany(client, { bankAccountId: bankId, name: 'Turn Co' })
      const propertyId = await park(client, { userId, landlordId }, pm)
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })

      // Ended 60 days ago, refilled 40 days ago → 20 days empty.
      // seedLease takes no end date, so it is set here rather than widening a
      // helper that ~60 other suites depend on.
      const ended = await seedLease(client, {
        unitId, landlordId, rentAmount: 1000, status: 'terminated',
        startDate: daysAgo(400) })
      await client.query(`UPDATE leases SET end_date=$2::date WHERE id=$1`,
        [ended, daysAgo(60)])
      await seedLease(client, {
        unitId, landlordId, rentAmount: 1000, status: 'active',
        startDate: daysAgo(40) })

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers[0].turnovers).toBe(1)
      expect(p.managers[0].avgDaysToFill).toBe(20)
    } finally { client.release() }
  })

  it('does not count a unit\'s first ever lease as an instant fill', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pm = await seedPmCompany(client, { bankAccountId: bankId, name: 'Fresh Co' })
      await leasedUnit(client, await park(client, { userId, landlordId }, pm), landlordId)

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers[0].turnovers).toBe(0)
      expect(p.managers[0].avgDaysToFill).toBeNull()
    } finally { client.release() }
  })

  it('counts an empty unit as vacant', async () => {
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const propertyId = await park(client, { userId, landlordId }, null)
      await leasedUnit(client, propertyId, landlordId)
      await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })  // no lease

      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers[0].unitCount).toBe(2)
      expect(p.managers[0].occupiedUnits).toBe(1)
      expect(p.managers[0].vacantUnits).toBe(1)
      expect(p.managers[0].occupancyPct).toBe(50)
    } finally { client.release() }
  })
})

describe('what it refuses to guess', () => {
  it('reports eviction handling as unmeasured rather than as a number', async () => {
    // termination_reason is free text and lease_notices is a generic title/body.
    // There is no legal action with stages and dates, so any promptness figure
    // would be invented — and an owner might fire a manager over it.
    const client = await getClient()
    try {
      const { userId, landlordId } = await seedLandlord(client)
      await leasedUnit(client, await park(client, { userId, landlordId }, null), landlordId)
      const p = await ownerPortfolio({ landlordIds: [landlordId] })
      expect(p.managers[0].evictionsResolved).toBeNull()
      expect(p.notMeasured.join(' ')).toMatch(/eviction/i)
    } finally { client.release() }
  })

  it('returns an empty book rather than throwing for an account that owns nothing', async () => {
    const p = await ownerPortfolio({ landlordIds: [] })
    expect(p.managers).toEqual([])
    expect(p.totals.unitCount).toBe(0)
  })
})
