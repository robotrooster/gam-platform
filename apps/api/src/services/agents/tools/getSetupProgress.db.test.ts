/**
 * get_setup_progress against a real database (gam_test).
 *
 * 10/12 (Nic): the tool's counts query bound the company list as uuid[] and
 * compared `id = $1`, so every call threw "operator does not exist: uuid =
 * uuid[]". tools.test.ts mocks the database and never ran the SQL, which is
 * how that shipped. These run it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../../../test/dbHelpers'
import { getSetupProgress } from './getSetupProgress'
import type { AgentActor } from './types'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function seedCompany(opts: { name: string; paid: boolean; withProperty: boolean; feed?: boolean }) {
  const client = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    await client.query(
      `UPDATE landlords SET business_name = $2, connect_payouts_enabled = $3,
              connect_details_submitted = TRUE
        WHERE id = $1`, [landlordId, opts.name, opts.paid])
    if (opts.withProperty) {
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await seedUnit(client, { propertyId, landlordId })
    }
    // 10/19 (review): step 2 of bank setup — the read-only feed on the same
    // bank account. The tool had no step for it at all, so a landlord with
    // step 1 done was told their setup was complete.
    if (opts.feed) {
      await client.query(
        `INSERT INTO bank_connections (landlord_id, provider, status, institution_name)
         VALUES ($1, 'stripe_fc', 'active', 'First Mid Bank')`, [landlordId])
    }
    return { userId, landlordId }
  } finally { client.release() }
}

const actorFor = (userId: string, landlordIds: string[]): AgentActor =>
  ({ userId, role: 'landlord', profileId: '', landlordIds })

describe('get_setup_progress (database)', () => {
  it('runs for an account with several companies — no uuid = uuid[] error', async () => {
    const a = await seedCompany({ name: 'Oak Park Motel and RV LLC', paid: true, withProperty: true, feed: true })
    const b = await seedCompany({ name: 'Empty Co', paid: false, withProperty: false })
    const res: any = await getSetupProgress.execute({}, actorFor(a.userId, [a.landlordId, b.landlordId]))
    expect(res.ok).toBe(true)
    expect(res.canGetPaid).toBe(true)
    expect(res.companiesThatCannotBePaid).toEqual([])
    expect(res.bankFeedLinked).toBe(true)
    // payouts, bank feed, property, units, tenant
    expect(res.steps.map((s: any) => s.done)).toEqual([true, true, true, true, false])
  })

  // 10/19 (review): the agent told a landlord with only step 1 done that their
  // setup was complete, because the second half of bank setup — the read-only
  // feed, without which a P&L is income-only — had no step at all.
  it('a company with payouts live and no read-only feed is not finished', async () => {
    const solo = await seedCompany({ name: 'Solo LLC', paid: true, withProperty: true })
    const res: any = await getSetupProgress.execute({}, actorFor(solo.userId, [solo.landlordId]))
    expect(res.canGetPaid).toBe(true)
    expect(res.bankFeedLinked).toBe(false)
    expect(res.companiesWithNoBankFeed).toEqual(['Solo LLC'])
    expect(res.complete).toBe(false)
    expect(res.nextStep).toMatch(/read-only/i)
  })

  // The same per-company rule as payouts: one company's linked bank must never
  // answer for another's missing one (payoutReadiness's own header).
  it('one company\u2019s linked bank does not answer for another\u2019s missing one', async () => {
    const oakPark = await seedCompany({ name: 'Oak Park Motel and RV LLC', paid: true, withProperty: true, feed: true })
    const truBlu = await seedCompany({ name: 'TruBlu Management LLC', paid: true, withProperty: true })
    const res: any = await getSetupProgress.execute({}, actorFor(truBlu.userId, [oakPark.landlordId, truBlu.landlordId]))
    expect(res.bankFeedLinked).toBe(false)
    expect(res.companiesWithNoBankFeed).toEqual(['TruBlu Management LLC'])
  })

  it('a paid co-owned company does not answer for the account’s own company with a property', async () => {
    const oakPark = await seedCompany({ name: 'Oak Park Motel and RV LLC', paid: true, withProperty: true })
    const truBlu = await seedCompany({ name: 'TruBlu Management LLC', paid: false, withProperty: true })
    const res: any = await getSetupProgress.execute({}, actorFor(truBlu.userId, [oakPark.landlordId, truBlu.landlordId]))
    expect(res.canGetPaid).toBe(false)
    expect(res.companiesThatCannotBePaid).toEqual(['TruBlu Management LLC'])
    expect(res.nextStep).toMatch(/payouts/i)
  })

  it('details submitted is not payouts: a company still waiting on Stripe cannot get paid', async () => {
    const solo = await seedCompany({ name: 'Solo LLC', paid: false, withProperty: false })
    const res: any = await getSetupProgress.execute({}, actorFor(solo.userId, [solo.landlordId]))
    expect(res.canGetPaid).toBe(false)
    expect(res.steps[0].done).toBe(false)
  })

  // 10/19 (review): the step named a page that no longer exists, so a confused
  // landlord who asked for help was sent hunting for it.
  it('names the page that exists, never the retired Disbursement Account', async () => {
    const solo = await seedCompany({ name: 'Solo LLC', paid: false, withProperty: false })
    const res: any = await getSetupProgress.execute({}, actorFor(solo.userId, [solo.landlordId]))
    const all = res.steps.map((s: any) => s.step).join(' | ')
    expect(all).not.toMatch(/Disbursement Account/i)
    expect(all).toContain('Bank setup tab')
  })
})
