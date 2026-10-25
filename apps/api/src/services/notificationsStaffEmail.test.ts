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

  // 10/25: the rule is onsite_manager ONLY. These roles still get email until
  // Nic says otherwise — a third-party property manager or an outside
  // accountant may work entirely by email, which is his call and not mine.
  it('still emails a property manager, maintenance and business staff', async () => {
    const c = await db.connect()
    let landlordId: string
    try { ({ landlordId } = await seedLandlord(c)) } finally { c.release() }
    for (const role of ['maintenance', 'property_manager', 'business_staff']) {
      sendMock.mockClear()
      const who = await personWithRole(role)
      await notify(who, landlordId!)
      expect(sendMock, role).toHaveBeenCalledTimes(1)
    }
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
