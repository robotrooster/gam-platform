/**
 * S605: post-signup onboarding outreach — eligibility, delay, idempotency,
 * send window. Email is mocked; this asserts WHO gets picked and WHEN.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

vi.mock('../services/email', () => ({
  emailLandlordWelcomeOutreach: vi.fn(async () => 'msg-id'),
}))

import { sendLandlordWelcomeOutreach, withinSendWindow } from './landlordWelcomeOutreach'
import { emailLandlordWelcomeOutreach } from '../services/email'

// Signups are seeded relative to IN_WINDOW, so the night/morning runs must come
// AFTER it on the clock — otherwise the signup is in the future relative to the
// run and the delay filter excludes it for the wrong reason.
// 2026-08-17 10:00 Phoenix (= 17:00 UTC) — a Monday, inside the send window.
const IN_WINDOW = new Date('2026-08-17T17:00:00Z')
// 2026-08-18 03:00 Phoenix (= 10:00 UTC Tue) — outside the send window.
const NIGHT = new Date('2026-08-18T10:00:00Z')
// 2026-08-18 10:00 Phoenix — the first in-window run after NIGHT.
const NEXT_MORNING = new Date('2026-08-18T17:00:00Z')

beforeEach(async () => {
  await cleanupAllSchema()
  ;(emailLandlordWelcomeOutreach as any).mockClear()
})

/** A landlord that signed up `minutesAgo` before IN_WINDOW, organic by default. */
async function seedSignup(opts: {
  minutesAgo: number
  firstName?: string
  verified?: boolean
  closerId?: string | null
  referredBy?: string | null
  isDemo?: boolean
  withProperty?: boolean
} ) {
  const client = await db.connect()
  let landlordId = '', userId = ''
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client, { firstName: opts.firstName || 'Charlie' })
    landlordId = ll.landlordId; userId = ll.userId
    if (opts.withProperty) {
      await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    }
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

  await db.query(
    `UPDATE landlords
        SET created_at = $2::timestamptz - ($3 * INTERVAL '1 minute'),
            welcome_outreach_sent_at = NULL,
            portfolio_manager_id = $4,
            referred_by_user_id  = $5,
            is_demo = $6
      WHERE id = $1`,
    [landlordId, IN_WINDOW.toISOString(), opts.minutesAgo,
     opts.closerId ?? null, opts.referredBy ?? null, opts.isDemo ?? false])
  if (opts.verified === false) {
    await db.query(`UPDATE users SET email_verified = FALSE WHERE id = $1`, [userId])
  }
  return { landlordId, userId }
}

describe('sendLandlordWelcomeOutreach', () => {
  it('organic signup past the delay → sent once, stamped, addressed by first name', async () => {
    const s = await seedSignup({ minutesAgo: 120, firstName: 'Charlie' })
    const res = await sendLandlordWelcomeOutreach(IN_WINDOW)

    expect(res.sent).toBe(1)
    expect(emailLandlordWelcomeOutreach).toHaveBeenCalledTimes(1)
    expect((emailLandlordWelcomeOutreach as any).mock.calls[0][0]).toMatchObject({
      firstName: 'Charlie',
      stalledInSetup: true,
    })
    const stamp = await db.query<{ s: Date | null }>(
      `SELECT welcome_outreach_sent_at AS s FROM landlords WHERE id = $1`, [s.landlordId])
    expect(stamp.rows[0].s).not.toBeNull()
  })

  it('is idempotent — a second run does not re-send', async () => {
    await seedSignup({ minutesAgo: 120 })
    await sendLandlordWelcomeOutreach(IN_WINDOW)
    ;(emailLandlordWelcomeOutreach as any).mockClear()

    const res = await sendLandlordWelcomeOutreach(IN_WINDOW)
    expect(res.sent).toBe(0)
    expect(emailLandlordWelcomeOutreach).not.toHaveBeenCalled()
  })

  it('still inside the delay window → not yet sent', async () => {
    await seedSignup({ minutesAgo: 30 })
    expect((await sendLandlordWelcomeOutreach(IN_WINDOW)).sent).toBe(0)
    expect(emailLandlordWelcomeOutreach).not.toHaveBeenCalled()
  })

  it('rep-closed signup → skipped (the rep owns that relationship)', async () => {
    const rep = await seedSignup({ minutesAgo: 500 })
    await db.query(`UPDATE landlords SET welcome_outreach_sent_at = now() WHERE id = $1`, [rep.landlordId])
    ;(emailLandlordWelcomeOutreach as any).mockClear()

    await seedSignup({ minutesAgo: 120, closerId: rep.userId })
    expect((await sendLandlordWelcomeOutreach(IN_WINDOW)).sent).toBe(0)
    expect(emailLandlordWelcomeOutreach).not.toHaveBeenCalled()
  })

  it('landlord-referred signup → skipped', async () => {
    const upline = await seedSignup({ minutesAgo: 500 })
    await db.query(`UPDATE landlords SET welcome_outreach_sent_at = now() WHERE id = $1`, [upline.landlordId])
    ;(emailLandlordWelcomeOutreach as any).mockClear()

    await seedSignup({ minutesAgo: 120, referredBy: upline.userId })
    expect((await sendLandlordWelcomeOutreach(IN_WINDOW)).sent).toBe(0)
  })

  it('unverified email → skipped (bouncing first contact hurts the sending domain)', async () => {
    await seedSignup({ minutesAgo: 120, verified: false })
    expect((await sendLandlordWelcomeOutreach(IN_WINDOW)).sent).toBe(0)
  })

  it('demo landlord → skipped', async () => {
    await seedSignup({ minutesAgo: 120, isDemo: true })
    expect((await sendLandlordWelcomeOutreach(IN_WINDOW)).sent).toBe(0)
  })

  it('already added a property → sent, but without the stalled-in-setup copy', async () => {
    await seedSignup({ minutesAgo: 120, withProperty: true })
    const res = await sendLandlordWelcomeOutreach(IN_WINDOW)

    expect(res.sent).toBe(1)
    expect((emailLandlordWelcomeOutreach as any).mock.calls[0][0]).toMatchObject({ stalledInSetup: false })
  })

  it('outside the send window → held, not sent and not stamped, so the next window picks it up', async () => {
    const s = await seedSignup({ minutesAgo: 120 })
    const res = await sendLandlordWelcomeOutreach(NIGHT)

    expect(res.sent).toBe(0)
    expect(res.heldOutsideSendWindow).toBe(1)
    expect(emailLandlordWelcomeOutreach).not.toHaveBeenCalled()
    const stamp = await db.query<{ s: Date | null }>(
      `SELECT welcome_outreach_sent_at AS s FROM landlords WHERE id = $1`, [s.landlordId])
    expect(stamp.rows[0].s).toBeNull()

    // ...and the next in-window run delivers it.
    expect((await sendLandlordWelcomeOutreach(NEXT_MORNING)).sent).toBe(1)
  })

  it('older than the max age → marked without sending (no stale blast after an outage)', async () => {
    await seedSignup({ minutesAgo: 80 * 60 }) // ~80h, past the 72h default
    const res = await sendLandlordWelcomeOutreach(IN_WINDOW)

    expect(res.sent).toBe(0)
    expect(res.expired).toBe(1)
    expect(emailLandlordWelcomeOutreach).not.toHaveBeenCalled()
  })

  it('a failed send is not stamped, so it retries next run', async () => {
    await seedSignup({ minutesAgo: 120 })
    ;(emailLandlordWelcomeOutreach as any).mockRejectedValueOnce(new Error('resend down'))

    const first = await sendLandlordWelcomeOutreach(IN_WINDOW)
    expect(first.sent).toBe(0)
    expect(first.errors).toBe(1)

    const second = await sendLandlordWelcomeOutreach(IN_WINDOW)
    expect(second.sent).toBe(1)
  })
})

describe('withinSendWindow', () => {
  it('10am Phoenix is inside the send window, 3am is not', () => {
    expect(withinSendWindow(IN_WINDOW)).toBe(true)
    expect(withinSendWindow(NIGHT)).toBe(false)
  })
})
