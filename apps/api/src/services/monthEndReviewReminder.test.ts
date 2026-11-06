/**
 * 11/1 — THE MAIL THAT HAS TO ARRIVE WHEN A REVIEW IS HOLDING THE RENT.
 *
 * Country Acres' October reading round held on ONE flagged read (Lot 21's
 * replaced water meter read 6 against 5901). That landlord reviews utility
 * bills before they go out, and an unapproved round holds every invoice on the
 * property WHOLE — rent included. Twelve households got no November bill. He
 * was told once, in-app, on 10/28, and never again, because he has switched off
 * every utility email there is. The owner found out when tenants rang him.
 *
 * Nic: "we need when a landlord is opted to review things before billing goes
 * out and they haven't done it, they need to get emailed the last business day
 * of the month plus any following days that are still at the end of the month...
 * He should have got an email both Friday and Saturday telling him to check
 * that."
 *
 * What these tests pin, in order of how much each one would cost to get wrong:
 *   1. it reaches a landlord who has switched this very notice off — that is
 *      the whole point, and it works through `critical` in the catalog rather
 *      than any bypass of its own;
 *   2. it fires for a round with flagged reads still on it, which is the branch
 *      finishSettledReadingRuns deliberately says nothing in;
 *   3. it fires for a round still `open` too, because the invoice hold reads
 *      `status <> 'completed' AND approved_at IS NULL` and does not care which;
 *   4. it stays quiet before the last business day, and quiet once approved;
 *   5. it does not send twice in a day.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { DateTime } from 'luxon'
import { isCriticalNotificationType } from '@gam/shared'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedUtilityMeter,
} from '../test/dbHelpers'
import { remindReviewLandlordsBeforeBilling } from './utilityReadingRuns'

/**
 * The job reads through the POOL, so the fixtures have to be COMMITTED — a
 * BEGIN/ROLLBACK harness seeds rows on one connection that the job, on another,
 * cannot see, and every assertion comes back empty for a reason that has
 * nothing to do with the code under test. Same pattern as
 * routes/utilityReadingRuns.test.ts: wipe the schema before each case.
 */

const TYPE = 'utility_review_blocks_billing'
const TZ = 'America/Chicago'

/**
 * A property whose reading round is waiting on a landlord who reviews first.
 * `cycle` is the round's billing month — the month whose end is the deadline,
 * because that round's readings ride the invoices due the 1st of the NEXT
 * month. Tests pass a cycle relative to today so nothing here is pinned to a
 * calendar date (the determinism guard, and the reason RV 37's flake happened).
 */
async function heldRound(c: PoolClient, opts: {
  cycle: string
  status?: 'open' | 'double_check'
  flagged?: boolean
  approved?: boolean
  reviewsFirst?: boolean
  optedOut?: boolean
}) {
  const { userId, landlordId } = await seedLandlord(c)
  await c.query(`UPDATE landlords SET review_utility_bills = $2 WHERE id = $1`,
    [landlordId, opts.reviewsFirst !== false])
  if (opts.optedOut) {
    await c.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       VALUES ($1, $2, FALSE, FALSE)`, [userId, TYPE])
  }
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  await c.query(`UPDATE properties SET timezone = $2, name = 'Country Acres Proof' WHERE id = $1`, [propertyId, TZ])
  const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 450 })
  await seedLease(c, { unitId, landlordId, rentAmount: 450, status: 'active' })
  const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water', billingMethod: 'submeter' })
  await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, unitId])

  const runId = (await c.query<{ id: string }>(
    // opened_on is the day the walk was opened: the cycle month's own read day,
    // which is what openDueReadingRuns writes.
    `INSERT INTO utility_reading_runs
       (property_id, landlord_id, billing_cycle_month, status, approved_at, opened_on)
     VALUES ($1,$2,$3::date,$4, CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
             ($3::date + INTERVAL '27 days')::date) RETURNING id`,
    [propertyId, landlordId, opts.cycle, opts.status ?? 'double_check', opts.approved === true])).rows[0].id

  if (opts.flagged) {
    // The read that held Country Acres: a replaced meter's first number, below
    // the old head's last, flagged by a check that was switched off on 10/31.
    await c.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, reason,
          needs_review, review_note, created_by_user_id)
       VALUES ($1, ($2::date + INTERVAL '27 days')::date, 6, $2::date, 'monthly_cycle',
               TRUE, 'below the previous read', $3)`,
      [meterId, opts.cycle, userId])
  }
  return { userId, landlordId, propertyId, runId }
}

const notices = async (userId: string) =>
  (await db.query(`SELECT type, title, body, email_sent FROM notifications WHERE user_id = $1 AND type = $2`,
    [userId, TYPE])).rows

/** The cycle month that is now over — its deadline has passed. */
const lastMonth = () => DateTime.now().setZone(TZ).minus({ months: 1 }).startOf('month').toISODate()!
/** The cycle month still running — its last business day is not here yet. */
const thisMonth = () => DateTime.now().setZone(TZ).startOf('month').toISODate()!

describe('a landlord whose review is holding the month’s bills is told, even if they said no to email', () => {
  let c: PoolClient
  beforeEach(async () => {
    await cleanupAllSchema()
    if (!c) c = await getClient()
  })

  it('the notice is declared un-switch-off-able, which is the entire override', () => {
    expect(isCriticalNotificationType(TYPE)).toBe(true)
  })

  it('reaches a landlord who has switched this very notice off', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true, optedOut: true })
      const r = await remindReviewLandlordsBeforeBilling()
      expect(r.reminded).toBeGreaterThanOrEqual(1)
      const got = await notices(h.userId)
      // THE ROW EXISTING *IS* THE PROOF. createNotification computes
      // `inAppOk = critical ? true : prefs.in_app_enabled`, so with both
      // preferences off a non-critical notice writes nothing at all. The
      // contrast case below pins that, which is what makes this assertion mean
      // something rather than just "a row appeared".
      expect(got).toHaveLength(1)
      // email_sent is deliberately NOT asserted: no mail provider is configured
      // in the test environment, so nothing is ever stamped sent here. What the
      // suite can prove is that the notice was RAISED past a refusal; that it
      // leaves on the wire is the provider's half and is covered where email
      // delivery itself is tested.
      // It names the stake in plain words, because that is the only reason it
      // is allowed to ignore a preference at all.
      expect(got[0].body).toMatch(/no bill at all|NOBODY/i)
  })

  it('a notice that is NOT critical is correctly silenced for the same landlord', async () => {
      // The contrast that gives the test above its meaning: same user, same
      // "no to both channels", an ordinary utility notice — and nothing is
      // written. So the row in the previous case came from `critical`, not from
      // preferences being ignored everywhere.
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true, optedOut: true })
      await db.query(
        `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
         VALUES ($1, 'utility_bills_ready_to_review', FALSE, FALSE)`, [h.userId])
      const { createNotification } = await import('./notifications')
      await createNotification({
        userId: h.userId, landlordId: h.landlordId,
        type: 'utility_bills_ready_to_review',
        title: 'Utility bills ready to review — contrast case',
        body: 'Should never be written: the landlord declined this one and it is not critical.',
        sendEmail: true, emailTo: 'nobody@example.test',
      })
      expect((await db.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'utility_bills_ready_to_review'`,
        [h.userId])).rows).toHaveLength(0)
  })

  it('fires while reads are still flagged — the branch the settled-run job says nothing in', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), status: 'double_check', flagged: true })
      await remindReviewLandlordsBeforeBilling()
      const got = await notices(h.userId)
      expect(got).toHaveLength(1)
      expect(got[0].body).toMatch(/second look|double-check/i)
  })

  it('fires for a round still open, because the invoice hold does not care about status', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), status: 'open', flagged: false })
      await remindReviewLandlordsBeforeBilling()
      const got = await notices(h.userId)
      expect(got).toHaveLength(1)
      expect(got[0].body).toMatch(/approval/i)
  })

  it('says nothing before the cycle month’s last business day', async () => {
      // A round for the month still running. Its deadline is that month's last
      // business day, which (except on that day) has not arrived.
      const today = DateTime.now().setZone(TZ)
      const h = await heldRound(c, { cycle: thisMonth(), flagged: true })
      await remindReviewLandlordsBeforeBilling()
      const got = await notices(h.userId)
      // On the last business day itself, or after it, it is correct to send.
      const { lastBusinessDay } = await import('@gam/shared')
      const due = lastBusinessDay(today.year, today.month, TZ)
      if (today.startOf('day') < due.startOf('day')) expect(got).toHaveLength(0)
      else expect(got).toHaveLength(1)
  })

  it('says nothing once the round is approved', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true, approved: true })
      await remindReviewLandlordsBeforeBilling()
      expect(await notices(h.userId)).toHaveLength(0)
  })

  it('says nothing to a landlord who does not review first — their bills were never held', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true, reviewsFirst: false })
      await remindReviewLandlordsBeforeBilling()
      expect(await notices(h.userId)).toHaveLength(0)
  })

  it('does not send twice in one day', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true })
      await remindReviewLandlordsBeforeBilling()
      await remindReviewLandlordsBeforeBilling()
      expect(await notices(h.userId)).toHaveLength(1)
  })

  it('counts the households actually sitting unbilled once the month has turned', async () => {
      const h = await heldRound(c, { cycle: lastMonth(), flagged: true })
      await remindReviewLandlordsBeforeBilling()
      const got = await notices(h.userId)
      expect(got).toHaveLength(1)
      // One active lease on the property, no invoice for the month after the
      // cycle — so the mail states the damage, not just the risk.
      expect(got[0].title).toMatch(/1 household/)
  })
})
