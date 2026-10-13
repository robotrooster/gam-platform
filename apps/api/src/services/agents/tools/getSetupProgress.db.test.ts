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

async function seedCompany(opts: { name: string; paid: boolean; withProperty: boolean }) {
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
    return { userId, landlordId }
  } finally { client.release() }
}

const actorFor = (userId: string, landlordIds: string[]): AgentActor =>
  ({ userId, role: 'landlord', profileId: '', landlordIds })

describe('get_setup_progress (database)', () => {
  it('runs for an account with several companies — no uuid = uuid[] error', async () => {
    const a = await seedCompany({ name: 'Oak Park Motel and RV LLC', paid: true, withProperty: true })
    const b = await seedCompany({ name: 'Empty Co', paid: false, withProperty: false })
    const res: any = await getSetupProgress.execute({}, actorFor(a.userId, [a.landlordId, b.landlordId]))
    expect(res.ok).toBe(true)
    expect(res.canGetPaid).toBe(true)
    expect(res.companiesThatCannotBePaid).toEqual([])
    expect(res.steps.map((s: any) => s.done)).toEqual([true, true, true, false])
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
})
