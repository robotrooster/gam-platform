/**
 * 10/19 (Nic) — "SHOW IT WHILE PAUSED", AS THE ASSISTANTS SEE IT.
 *
 * Asked whether a tenant should be able to see their work trade while it is
 * paused, Nic chose to show it while paused: the tab stays and says plainly
 * which situation they are in — hours still counting, or nothing being counted.
 *
 * Both assistants used to ask for the ACTIVE agreement, so Ava told a snowbird
 * whose trade was paused for the season that they had no work-trade agreement
 * at all, while their hours may have been counting the whole time. The tenant
 * portal's four surfaces had the same hole (routes/tenants /work-trade), and
 * the two sides must never read different stories about the same space.
 *
 * What the month close does under each answer to the space question is pinned
 * in jobs/workTradeSettlement.test.ts; this file is about who can SEE it, and
 * about never handing somebody a target nobody is counting.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../../../db'
import { getWorkTradeStanding } from './getWorkTradeStanding'
import { getWorkTradeStatus } from './getWorkTradeStatus'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../../../test/dbHelpers'

beforeEach(cleanupAllSchema)

async function seed(status: string, opts: { tracksHours?: boolean } = {}) {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
    // 10/19 (review): a REAL TENANCY under the agreement. A work trade cannot be
    // created without an active lease in production (routes/workTrade POST), and
    // whether a paused one is still anybody's to read is a question about the
    // TENANCY, not the status word (liveTenancySql) — a lease ending with no
    // successor pauses the trade and nothing ever ends it.
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 460 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    const { rows: [ag] } = await client.query<{ id: string }>(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, tracks_hours, duties)
       VALUES ($1,$2,$3,CURRENT_DATE - interval '3 months',$4,80,$5,'groundskeeping') RETURNING id`,
      [unitId, tenantId, landlordId, status, opts.tracksHours ?? true])
    return {
      landlordId, tenantId, unitId, leaseId, agreementId: ag.id,
      tenant: { userId, role: 'tenant' as const, profileId: tenantId, landlordIds: [] },
      landlord: { userId, role: 'landlord' as const, profileId: landlordId, landlordIds: [landlordId] },
    }
  } finally { client.release() }
}

/** What the lease-end processor leaves behind on a real move-out. */
async function moveOut(s: { leaseId: string }) {
  await db.query(`UPDATE leases SET status='expired', terminated_at=NOW() WHERE id=$1`, [s.leaseId])
  await db.query(
    `UPDATE lease_tenants SET status='removed', removed_reason='lease_ended' WHERE lease_id=$1`,
    [s.leaseId])
}

describe('the tenant assistant and a paused work trade', () => {
  it('finds the paused agreement instead of saying they have none', async () => {
    const s = await seed('paused')
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.hasAgreement).toBe(true)
    expect(out.paused).toBe(true)
    expect(out.hoursBeingCounted).toBe(true)
  })

  // The sentence a snowbird most needs. An unanswered pause is the normal state
  // of a freshly paused agreement (lease hibernation pauses one with nobody in
  // front of a screen), and it keeps counting hours.
  it('says the hours are still counting, and hands the agent the rule in words', async () => {
    const s = await seed('paused')
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.summary).toContain('your hours keep counting')
    expect(out.pausedNote).toContain('STILL counting')
    expect(out.pausedNote).toContain('stays owed')
    // There IS a target while hours are counting; pausing did not waive it.
    expect(out.monthlyHoursTarget).toBe(80)
  })

  // Requirement the other way round: no target presented as something they are
  // failing at a job nobody asked them to do.
  it('quotes no target at all when nobody is counting hours', async () => {
    const s = await seed('paused', { tracksHours: false })
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.hasAgreement).toBe(true)
    expect(out.paused).toBe(true)
    expect(out.hoursBeingCounted).toBe(false)
    expect(out.monthlyHoursTarget).toBe(0)
    expect(out.hoursThisMonth).toBe(0)
    expect(out.hoursToBeStraight).toBe(0)
    expect(out.summary).toContain('no hours are counted on it either way')
    expect(out.pausedNote).toContain('Never quote an hours target')
  })

  it('an ended agreement stays gone — a dead trade does not reappear', async () => {
    const s = await seed('ended')
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.hasAgreement).toBe(false)
  })

  it('prefers a running agreement over a paused one', async () => {
    const s = await seed('paused')
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target)
       VALUES ($1,$2,$3,CURRENT_DATE,'active',40)`,
      [s.unitId, s.tenantId, s.landlordId])
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.paused).toBe(false)
    expect(out.monthlyHoursTarget).toBe(40)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10/19 (review) — AND A MOVE-OUT LEAVES IT 'PAUSED', NOT 'ENDED'.
  //
  // Leaving 'ended' out of the widening was not the whole gate. The lease-end
  // processor PAUSES every active work trade on a unit when its lease reaches
  // end_date with no signed successor (jobs/scheduler — "work trade is
  // rent-for-labor — it can't outlive the tenancy"), and nothing ever moves
  // that row on to 'ended'. So the widening alone had Ava telling somebody who
  // moved out last month that their hours keep counting.
  it('says nothing of a trade paused by a move-out', async () => {
    const s = await seed('paused')
    await moveOut(s)
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.hasAgreement).toBe(false)
  })

  // The pause this gate exists to KEEP showing: a spot asleep for the season.
  it('still reads a trade paused by lease hibernation', async () => {
    const s = await seed('paused')
    await db.query(`UPDATE leases SET is_hibernating=TRUE WHERE id=$1`, [s.leaseId])
    const out: any = await getWorkTradeStanding.execute({}, s.tenant as any)
    expect(out.hasAgreement).toBe(true)
    expect(out.paused).toBe(true)
  })

  it('never reads another tenant’s paused agreement', async () => {
    await seed('paused')
    const client = await getClient()
    let strangerId: string
    try { strangerId = await seedTenant(client) } finally { client.release() }
    const out: any = await getWorkTradeStanding.execute(
      {}, { userId: 'x', role: 'tenant', profileId: strangerId, landlordIds: [] } as any)
    expect(out.hasAgreement).toBe(false)
  })
})

// Nic's rule for the whole subsystem: the two sides never read different
// stories about the same space. The tenant sees a paused trade now, so the
// landlord's assistant has to see it too.
describe('the landlord assistant reads the same paused agreement', () => {
  it('lists a paused agreement and says whether its hours are counting', async () => {
    const s = await seed('paused')
    const out: any = await getWorkTradeStatus.execute({}, s.landlord as any)
    expect(out.count).toBe(1)
    expect(out.agreements[0]).toMatchObject({ paused: true, hoursBeingCounted: true, monthlyHoursTarget: 80 })
  })

  it('quotes no target on a paused trade nobody clocks', async () => {
    const s = await seed('paused', { tracksHours: false })
    const out: any = await getWorkTradeStatus.execute({}, s.landlord as any)
    expect(out.agreements[0]).toMatchObject({ paused: true, hoursBeingCounted: false, monthlyHoursTarget: 0 })
    expect(out.behindCount).toBe(0)
  })

  it('leaves ended agreements out', async () => {
    const s = await seed('ended')
    const out: any = await getWorkTradeStatus.execute({}, s.landlord as any)
    expect(out.count).toBe(0)
  })

  // 10/19 (review): and a former resident's space is not a live agreement. The
  // landlord asking "how is everyone doing on hours?" was read out a unit
  // nobody lives on, labeled paused with hours counting.
  it('leaves out a trade paused by a move-out', async () => {
    const s = await seed('paused')
    await moveOut(s)
    const out: any = await getWorkTradeStatus.execute({}, s.landlord as any)
    expect(out.count).toBe(0)
    expect(out.note).toContain('No live work-trade agreements')
  })

  // Both sides read the same roster: what one can see, the other can.
  it('still lists a hibernating tenancy, exactly as the tenant reads it', async () => {
    const s = await seed('paused')
    await db.query(`UPDATE leases SET is_hibernating=TRUE WHERE id=$1`, [s.leaseId])
    const out: any = await getWorkTradeStatus.execute({}, s.landlord as any)
    expect(out.count).toBe(1)
    expect(out.agreements[0]).toMatchObject({ paused: true })
  })
})
