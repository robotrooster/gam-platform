/**
 * S628 — tenant-first renewal. The 60-day question and the 32-day report.
 *
 * The behaviour worth pinning is the one that is easy to get backwards: the
 * landlord alert fires whether or not the tenant answered, because "they have
 * not answered" is the case that needs a human. An alert conditional on an
 * answer would be silent in exactly the situation it exists for.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const notes: any[] = []
vi.mock('../services/notifications', () => ({
  createNotification: vi.fn(async (p: any) => { notes.push(p) }),
}))

import { runRenewalPings } from './renewalPing'

beforeEach(async () => {
  await cleanupAllSchema()
  notes.length = 0
})

/** A live lease ending `endsInDays` from today. */
async function seedEndingLease(endsInDays: number, extra: Record<string, any> = {}) {
  const c = await db.connect()
  let leaseId = '', landlordId = '', tenantId = ''
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c); landlordId = ll.landlordId
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    tenantId = await seedTenant(c)
    leaseId = await seedLease(c, { unitId, landlordId, status: 'active' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  await db.query(
    `UPDATE leases SET end_date = CURRENT_DATE + ($1 * INTERVAL '1 day') WHERE id = $2`,
    [endsInDays, leaseId])
  for (const [col, val] of Object.entries(extra)) {
    await db.query(`UPDATE leases SET ${col} = $1 WHERE id = $2`, [val, leaseId])
  }
  return { leaseId, landlordId, tenantId }
}

const ofType = (t: string) => notes.filter((n) => n.type === t)

describe('runRenewalPings — the tenant is asked first', () => {
  it('asks the tenant at 60 days out and stamps the lease', async () => {
    const { leaseId } = await seedEndingLease(58)
    const r = await runRenewalPings()
    expect(r.pinged).toBe(1)

    const ping = ofType('lease_renewal_question')[0]
    expect(ping).toBeTruthy()
    expect(ping.body).toMatch(/plan to stay/i)
    expect(ping.sendEmail).toBe(true)

    const row = (await db.query(
      `SELECT tenant_renewal_pinged_at FROM leases WHERE id = $1`, [leaseId])).rows[0]
    expect(row.tenant_renewal_pinged_at).not.toBeNull()
  })

  it('does not ask twice', async () => {
    await seedEndingLease(58)
    await runRenewalPings()
    notes.length = 0
    expect((await runRenewalPings()).pinged).toBe(0)
    expect(ofType('lease_renewal_question')).toHaveLength(0)
  })

  it('does not ask a lease that ends further out than 60 days', async () => {
    await seedEndingLease(90)
    expect((await runRenewalPings()).pinged).toBe(0)
  })

  it('does not ask somebody who has already answered', async () => {
    await seedEndingLease(58, { tenant_renewal_intent: 'no' })
    expect((await runRenewalPings()).pinged).toBe(0)
  })

  it('asks even when the landlord has already offered — an offer is not an answer', async () => {
    await seedEndingLease(58)
    await db.query(`UPDATE leases SET landlord_renewal_offered_at = NOW()`)
    expect((await runRenewalPings()).pinged).toBe(1)
  })

  it('ignores a lease that is not active', async () => {
    const { leaseId } = await seedEndingLease(58)
    await db.query(`UPDATE leases SET status = 'terminated' WHERE id = $1`, [leaseId])
    const r = await runRenewalPings()
    expect(r.pinged).toBe(0)
    expect(r.alerted).toBe(0)
  })
})

describe('runRenewalPings — the landlord hears at 32 days', () => {
  it('tells the landlord what the tenant said', async () => {
    await seedEndingLease(30, { tenant_renewal_intent: 'yes', tenant_renewal_pinged_at: new Date().toISOString() })
    const r = await runRenewalPings()
    expect(r.alerted).toBe(1)
    const alert = ofType('lease_renewal_status')[0]
    expect(alert.body).toMatch(/want to stay/i)
    expect(alert.data.tenantIntent).toBe('yes')
  })

  it('ALSO tells the landlord when the tenant has said NOTHING — the case that needs them', async () => {
    await seedEndingLease(30, { tenant_renewal_pinged_at: new Date().toISOString() })
    const r = await runRenewalPings()
    expect(r.alerted).toBe(1)
    const alert = ofType('lease_renewal_status')[0]
    expect(alert.body).toMatch(/not answered yet/i)
    expect(alert.data.tenantIntent).toBeNull()
  })

  it('a "no" tells them to list the unit, not to offer renewal', async () => {
    await seedEndingLease(30, { tenant_renewal_intent: 'no', tenant_renewal_pinged_at: new Date().toISOString() })
    await runRenewalPings()
    const alert = ofType('lease_renewal_status')[0]
    expect(alert.body).toMatch(/list the unit/i)
    expect(alert.body).not.toMatch(/offer renewal so/i)
  })

  it('does not alert twice', async () => {
    await seedEndingLease(30)
    await runRenewalPings()
    notes.length = 0
    expect((await runRenewalPings()).alerted).toBe(0)
  })

  it('does not alert at 45 days — that is still the tenant’s window', async () => {
    await seedEndingLease(45)
    expect((await runRenewalPings()).alerted).toBe(0)
  })

  it('a lease inside 32 days that was never pinged gets BOTH in one run', async () => {
    // A lease imported late, or one the job never saw at 60 days. Asking and
    // reporting on the same day beats skipping the tenant entirely — and the
    // landlord's alert then honestly says nobody has answered yet.
    await seedEndingLease(20)
    const r = await runRenewalPings()
    expect(r.pinged).toBe(1)
    expect(r.alerted).toBe(1)
    expect(ofType('lease_renewal_status')[0].body).toMatch(/not answered yet/i)
  })
})
