/**
 * 10/25 (Nic, DIRECTIVE) — A TEAM MEMBER GETS NO EMAIL FROM GAM.
 *
 *   "Why is she getting emails? She is a front desk employee... She is operating
 *    as a team member, not as a landlord. She doesn't need the wake-up calls at
 *    3 in the morning... Lisa does not need any emails from GAM except for two-
 *    factor authentication to log in or like changing a password."
 *
 *   "Any extra information is overloading these people. It needs to hold their
 *    hand the whole way, only tell them what to do, not show them anything
 *    extra."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn(async () => 'msg_staff_test') }))
vi.mock('./email', async (orig) => ({
  ...(await orig() as any),
  sendNotificationEmail: sendMock,
}))

import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { createNotification } from './notifications'

beforeEach(async () => { await cleanupAllSchema(); sendMock.mockClear() })

async function personWithRole(role: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1, 'x', 'Test', 'Person', $2, TRUE) RETURNING id`,
    [`${role}-${randomUUID()}@test.dev`, role])
  return r.rows[0].id
}

const notify = (userId: string, landlordId: string) => createNotification({
  userId, landlordId,
  // A CRITICAL type on purpose: the staff rule has to beat even the ones the
  // preferences page cannot switch off, because "critical" means the LANDLORD
  // must not miss it — not that an employee's phone should ring at 3am.
  type: 'payment_failed',
  title: 'A rent payment failed',
  body: 'It did not go through.',
  sendEmail: true, emailTo: 'person@test.dev',
})

const inAppCount = (userId: string) =>
  query(`SELECT 1 FROM notifications WHERE user_id = $1`, [userId]).then(r => r.length)

describe('who GAM emails', () => {
  it('does not email a front-desk employee, and still puts it on their screen', async () => {
    const c = await db.connect()
    let landlordId: string
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    const lisa = await personWithRole('onsite_manager')

    await notify(lisa, landlordId!)
    expect(sendMock).not.toHaveBeenCalled()      // nothing in her inbox
    expect(await inAppCount(lisa)).toBe(1)       // but it is there when she looks
  })

  it('does not email maintenance or the bookkeeper either — they log in to look', async () => {
    const c = await db.connect()
    let landlordId: string
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    for (const role of ['maintenance', 'bookkeeper']) {
      sendMock.mockClear()
      const who = await personWithRole(role)
      await notify(who, landlordId!)
      expect(sendMock, role).not.toHaveBeenCalled()
      expect(await inAppCount(who)).toBe(1)
    }
  })

  // 10/25 (Nic), the line: "The owner or property manager gets emailed about
  // leases, about refunds, about anything that needs to be emailed." A property
  // manager can be a third party running the place from somewhere else, so
  // their inbox IS their desk.
  // ── 10/27 (Nic): THE METER-READ NOTICE, END TO END ───────────────────────
  //
  //   "Lisa's still apparently getting emails about Val Sutherland and Patrick
  //    Newman needing a meter read to be done. I thought we fixed her to not
  //    get any more emails."
  //
  // She was fixed — on 10/25 at 14:18, six hours AFTER that morning's 07:00
  // send, which is the last one she got. But the rule lived in
  // createNotification and the only tests were on createNotification, so
  // nothing proved the notice that actually reached her routes through it with
  // the right recipients. Between 10/25 and 10/27 no departure was outstanding,
  // so the live system never exercised it either — the quiet was the reads
  // being settled, not the fix being proven.
  //
  // This drives the real job, with her real shape: an on-site manager who can
  // read meters, and the owner, on one property with one departed site.
  it('the closing-read notice reaches the desk on screen and the owner by email', async () => {
    const { promptMoveOutMeterReads } = await import('./utilityReadingRuns')
    const {
      seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedUtilityMeter,
    } = await import('../test/dbHelpers')
    const c = await db.connect()
    let landlordId: string, ownerUserId: string, propertyId: string, unitId: string
    try {
      const l = await seedLandlord(c)
      landlordId = l.landlordId; ownerUserId = l.userId
      propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
      unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 500, status: 'active' })
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      // They left two days ago and nobody has read the meter.
      await c.query(`UPDATE leases SET end_date = CURRENT_DATE - 2 WHERE id = $1`, [leaseId])
      const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    } finally { c.release() }

    // Lisa: on-site manager, this property, allowed to read meters.
    const lisa = await personWithRole('onsite_manager')
    await query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids, permissions)
       VALUES ($1, $2, FALSE, ARRAY[$3::uuid], '{"utility.read_meters": true}'::jsonb)`,
      [lisa, landlordId!, propertyId!])

    expect((await promptMoveOutMeterReads()).prompted).toBe(1)

    // Both of them have it on screen.
    expect(await inAppCount(lisa)).toBe(1)
    expect(await inAppCount(ownerUserId!)).toBe(1)

    // Only the owner's inbox. Hers stays empty — that is the whole complaint.
    const emailed = sendMock.mock.calls.map((a: any[]) => a[0]?.userId)
    expect(emailed).toContain(ownerUserId!)
    expect(emailed).not.toContain(lisa)
  })

  it('still emails a property manager', async () => {
    const c = await db.connect()
    let landlordId: string
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    const pm = await personWithRole('property_manager')
    await notify(pm, landlordId!)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('still emails the landlord — they are the one who must not miss it', async () => {
    const c = await db.connect()
    let landlordId: string, userId: string
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
    await notify(userId!, landlordId!)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(await inAppCount(userId!)).toBe(1)
  })

  it('still emails a tenant — they are not staff reading a screen on shift', async () => {
    const c = await db.connect()
    let landlordId: string
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    const tenant = await personWithRole('tenant')
    await notify(tenant, landlordId!)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
